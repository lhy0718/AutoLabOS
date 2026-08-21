import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureScaffold, resolveAppPaths } from "../src/config.js";
import { createHumanInterventionRequest } from "../src/core/humanIntervention.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { InteractiveRunSupervisor as BaseInteractiveRunSupervisor } from "../src/core/runs/interactiveRunSupervisor.js";
import { RunStore } from "../src/core/runs/runStore.js";

class InteractiveRunSupervisor extends BaseInteractiveRunSupervisor {
  constructor(
    private readonly testWorkspaceRoot: string,
    runStore: RunStore,
    orchestrator: ConstructorParameters<typeof BaseInteractiveRunSupervisor>[2]
  ) {
    super(testWorkspaceRoot, runStore, orchestrator);
  }

  override async answerHumanIntervention(
    ...args: Parameters<BaseInteractiveRunSupervisor["answerHumanIntervention"]>
  ) {
    const [runId, request] = args;
    const memory = new RunContextMemory(
      path.join(this.testWorkspaceRoot, ".autolabos", "runs", runId, "memory", "run_context.json")
    );
    if (await memory.get("human_intervention.pending") === undefined) {
      await memory.put("human_intervention.pending", request);
    }
    return super.answerHumanIntervention(...args);
  }
}

describe("adaptive human intervention resolution", () => {
  let workspaceRoot: string;
  let runStore: RunStore;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-adaptive-intervention-"));
    const paths = resolveAppPaths(workspaceRoot);
    await ensureScaffold(paths);
    runStore = new RunStore(paths);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("routes a semantic free-text answer only to a model-selected declared recovery choice", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const jumpToNode = makeJumpAction(runStore, run, "design_experiments");
    const orchestrator = {
      jumpToNode,
      retryCurrent: vi.fn(),
      approveCurrent: vi.fn(),
      applyPendingTransition: vi.fn()
    };
    const llm = {
      runForText: vi.fn().mockResolvedValue(JSON.stringify({
        decision: "select_choice",
        choice_id: "revise_design",
        normalized_answer: "Revise the design first.",
        followup_question: "",
        rationale: "The operator explicitly requested a design revision."
      }))
    };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    await persistPendingRequest(workspaceRoot, run.id, request);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "The comparison contract is wrong, so revise the design before analysis.",
      { llm }
    );

    expect(result.status).toBe("resumed");
    expect(jumpToNode).toHaveBeenCalledWith(
      run.id,
      "design_experiments",
      "safe",
      "human intervention: objective_metric_clarification"
    );
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();

    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("analyze_results.objective_clarification")).toBeUndefined();
    expect(await memory.get("human_intervention.history")).toEqual([
      expect.objectContaining({
        selectedChoiceId: "revise_design",
        resumeAction: "jump",
        targetNode: "design_experiments",
        resolutionSource: "model"
      })
    ]);
  });

  it("keeps the intervention pending when the model needs a follow-up", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = {
      jumpToNode: vi.fn(),
      retryCurrent: vi.fn(),
      approveCurrent: vi.fn(),
      applyPendingTransition: vi.fn()
    };
    const llm = {
      runForText: vi.fn().mockResolvedValue(JSON.stringify({
        decision: "ask_followup",
        choice_id: "",
        normalized_answer: "",
        followup_question: "Should the run use the declared primary metric, or return to experiment design?",
        rationale: "The operator named neither a metric nor one declared recovery route."
      }))
    };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "Use a safer recovery path after checking the available evidence.",
      { llm }
    );

    expect(result.status).toBe("followup_required");
    if (result.status !== "followup_required") {
      throw new Error("expected a follow-up");
    }
    expect(result.request.question).toContain("declared primary metric");
    expect(result.request.conversation).toEqual([
      expect.objectContaining({
        answer: "Use a safer recovery path after checking the available evidence.",
        resolutionSource: "model"
      })
    ]);
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();

    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({ question: expect.stringContaining("declared primary metric") })
    );
  });

  it("keeps multiple or explicitly uncertain fallback routes pending", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = {
      jumpToNode: vi.fn(),
      retryCurrent: vi.fn(),
      approveCurrent: vi.fn(),
      applyPendingTransition: vi.fn()
    };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "design_experiments와 implement_experiments 중 어느 쪽인지 잘 모르겠어요."
    );

    expect(result.status).toBe("followup_required");
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
  });

  it("does not treat a compound numeric answer as one exact declared choice", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, "1 or 2");

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it.each([
    "either 1 or 2",
    "the first or second option",
    "choice 1 or choice 2",
    "one of those two",
    "revise or inspect",
    "could be the former or the latter"
  ])("does not let a model choose one route for an explicitly ambiguous answer: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const llm = { runForText: vi.fn().mockResolvedValue(JSON.stringify({
      decision: "select_choice",
      choice_id: "revise_design",
      normalized_answer: answer,
      followup_question: "",
      rationale: "One declared route was selected."
    })) };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("followup_required");
    expect(llm.runForText).not.toHaveBeenCalled();
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it.each([
    "design_experiments로는 돌아가지 말아 주세요.",
    "design_experiments로 돌아가면 안 됩니다.",
    "design_experiments는 선택하면 안 돼요.",
    "design_experiments로 돌아갈까요",
    "design_experiments is off the table.",
    "Please refrain from returning to design_experiments.",
    "Probably design_experiments.",
    "design_experiments, I guess.",
    "design_experiments인 것 같아요.",
    "design_experiments일 수도 있어요.",
    "Do not choose option 1.",
    "Not the first option."
  ])("does not let a model select a choice through a negated localized reference: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const llm = { runForText: vi.fn().mockResolvedValue(JSON.stringify({
      decision: "select_choice",
      choice_id: "revise_design",
      normalized_answer: answer,
      followup_question: "",
      rationale: "The first declared choice was selected."
    })) };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("followup_required");
    expect(llm.runForText).not.toHaveBeenCalled();
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it.each([
    "continue",
    "proceed",
    "yes",
    "Use a safer recovery path after checking the available evidence."
  ])("keeps unmatched free text pending without an interpreter: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      answer
    );

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({
        id: request.id,
        conversation: [expect.objectContaining({ answer })]
      })
    );
  });

  it.each([
    "use the declared default",
    "기본 동작으로 진행",
    "retry_current"
  ])("accepts an exact declared-default approval without a model: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const retriedRun = makeRetriedRun(run);
    const orchestrator = {
      ...makeInactiveOrchestrator(),
      retryCurrent: vi.fn().mockResolvedValue(retriedRun)
    };
    const llm = { runForText: vi.fn() };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    await persistPendingRequest(workspaceRoot, run.id, request);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("resumed");
    expect(llm.runForText).not.toHaveBeenCalled();
    expect(orchestrator.retryCurrent).toHaveBeenCalledWith(run.id, "analyze_results");
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it.each([
    "Use the declared default?",
    "design_experiments?",
    "Use the declared default or return to design_experiments.",
    "return to design_experiments or jump to write_paper",
    "go to design_experiments or continue",
    "select revise_design or use the default",
    "design_experiments or write_paper",
    "return to design_experiments or stay here",
    "use the declared default or stay here",
    "option 1 versus option 2",
    "between option 1 and option 2",
    "the first versus the second option",
    "Should I return to design_experiments",
    "Can I use design_experiments",
    "Would design_experiments be better",
    "Should we return to design_experiments",
    "Can we use design_experiments",
    "Is design_experiments better",
    "1 and 2",
    "option 1 / option 2",
    "first, second",
    "both 1 and 2",
    "1, 2",
    "option one / option two",
    "revise and inspect",
    "both revise and inspect",
    "Neither route.",
    "Both of the options.",
    "Neither of the options.",
    "None of the options.",
    "No design_experiments.",
    "design_experiments isn't acceptable.",
    "Do not continue.",
    "Stop.",
    "Cancel.",
    "Abort.",
    "Pause.",
    "Wait.",
    "I refuse.",
    "아니요.",
    "Do not go on.",
    "Use whichever path is safer.",
    "Do whatever you think is best.",
    "Either route works for me.",
    "One of the available routes.",
    "You decide.",
    "둘 중 아무거나 해 주세요.",
    "Skip design_experiments.",
    "I won't return to design_experiments.",
    "I cannot use design_experiments.",
    "design_experiments does not work.",
    "Do not under any circumstances whatsoever despite every contrary recommendation return to design_experiments.",
    "Do not under any circumstances use any recommendation to return to design_experiments.",
    "design_experiments should under no circumstances be selected.",
    "design_experiments should definitely not be selected.",
    "design_experiments must absolutely never be used.",
    "design_experiments는 절대로 선택하면 안 됩니다.",
    "design_experiments은 사용하지 마세요.",
    "Do not, under any circumstances, return to design_experiments.",
    "Never, ever return to design_experiments.",
    "I cannot, in good conscience, choose design_experiments.",
    "Do not continue with this run.",
    "Please do not proceed with any action whatsoever.",
    "I refuse to continue this workflow.",
    "I absolutely refuse to continue.",
    "We categorically decline to proceed.",
    "이 실행을 계속 진행하지 마세요.",
    "절대로 계속 진행하지 마세요.",
    "저는 이 워크플로를 계속 진행하는 것을 거부합니다.",
    "아니요, 괜찮습니다.",
    "이제 그만할게요.",
    "진행하지 말아 주세요.",
    "더 이상 계속 진행하지 마세요.",
    "진행을 중단해 주세요.",
    "Please do not proceed with any action in this run even after checking every possible option carefully.",
    "No thanks.",
    "No, thank you.",
    "Please stop.",
    "Stop now.",
    "Do not retry.",
    "Return to design_experiments later."
  ])("does not let a model turn a tentative, alternative, or refusing answer into an action: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    orchestrator.jumpToNode.mockResolvedValue(makeJumpedRun(run, "design_experiments"));
    const llm = {
      runForText: vi.fn().mockResolvedValue(JSON.stringify({
        decision: "accept_default",
        choice_id: "",
        normalized_answer: answer,
        followup_question: "",
        rationale: "Continue with the default."
      }))
    };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("followup_required");
    expect(llm.runForText).not.toHaveBeenCalled();
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it.each([
    "The metric is not reliable, so return to design_experiments.",
    "No numeric metrics are available, so revise the design.",
    "Return to design_experiments to revise the metric or comparator.",
    "The implementation is a bad idea, so return to design_experiments.",
    "No implementation; return to design_experiments.",
    "Avoid implementation; return to design_experiments.",
    "Do not return to implementation; return to design_experiments.",
    "The metric is not reliable; return to design_experiments.",
    "The current result is not good; please return to design_experiments.",
    "Because the metric is not reliable despite every contrary recommendation in the report, return to design_experiments.",
    "Do not continue with this run; instead return to design_experiments.",
    "Do not continue; return to design_experiments.",
    "Do not proceed. Return to design_experiments.",
    "Do not continue, return to design_experiments.",
    "Do not go on; return to design_experiments.",
    "계속 진행하지 마세요. 대신 design_experiments로 돌아가 주세요.",
    "계속 진행하지 마세요, 대신 design_experiments로 돌아가 주세요.",
    "더 이상 계속 진행하지 마세요. 대신 design_experiments로 돌아가 주세요.",
    "진행을 중단해 주세요. 대신 design_experiments로 돌아가 주세요.",
    "design_experiments should definitely be selected.",
    "design_experiments를 선택해 주세요.",
    "Definitely return to design_experiments.",
    "I choose design_experiments.",
    "Please continue with design_experiments.",
    "design_experiments is the clear choice.",
    "Return to design_experiments to revise the metric or use a different comparator."
  ])("preserves one affirmative route when negation or an or-clause belongs to its rationale: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = {
      ...makeInactiveOrchestrator(),
      jumpToNode: makeJumpAction(runStore, run, "design_experiments")
    };
    const llm = {
      runForText: vi.fn().mockResolvedValue(JSON.stringify({
        decision: "select_choice",
        choice_id: "revise_design",
        normalized_answer: answer,
        followup_question: "",
        rationale: "The operator selected the declared design route."
      }))
    };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("resumed");
    expect(llm.runForText).toHaveBeenCalledTimes(1);
    expect(orchestrator.jumpToNode).toHaveBeenCalledWith(
      run.id,
      "design_experiments",
      "safe",
      "human intervention: objective_metric_clarification"
    );
  });

  it.each([
    {
      answer: "구현 대신 design_experiments로 돌아가 주세요.",
      choiceId: "revise_design",
      targetNode: "design_experiments"
    },
    {
      answer: "design_experiments는 안 됩니다. 대신 implement_experiments로 돌아가 주세요.",
      choiceId: "inspect_implementation",
      targetNode: "implement_experiments"
    }
  ])("selects the affirmative side of a Korean contrastive route: $answer", async ({
    answer,
    choiceId,
    targetNode
  }) => {
    const run = await createPausedAnalyzeRun(runStore);
    const baseRequest = makeAdaptiveRequest();
    const request = {
      ...baseRequest,
      choices: (baseRequest.choices || []).map((choice) => ({
        ...choice,
        answerAliases: [
          ...(choice.answerAliases || []),
          choice.id === "revise_design" ? "설계" : "구현"
        ]
      }))
    };
    const orchestrator = {
      ...makeInactiveOrchestrator(),
      jumpToNode: makeJumpAction(runStore, run, targetNode)
    };
    const llm = { runForText: vi.fn().mockResolvedValue(JSON.stringify({
      decision: "select_choice",
      choice_id: choiceId,
      normalized_answer: answer,
      followup_question: "",
      rationale: "The operator selected the affirmative contrastive route."
    })) };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("resumed");
    expect(llm.runForText).toHaveBeenCalledTimes(1);
    expect(orchestrator.jumpToNode).toHaveBeenCalledWith(
      run.id,
      targetNode,
      "safe",
      "human intervention: objective_metric_clarification"
    );
  });

  it("does not let a model's default decision override a Korean alternative route", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const answer = "계속 진행하지 마세요. 대신 design_experiments로 돌아가 주세요.";
    const llm = { runForText: vi.fn().mockResolvedValue(JSON.stringify({
      decision: "accept_default",
      choice_id: "",
      normalized_answer: answer,
      followup_question: "",
      rationale: "Continue with the default."
    })) };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("followup_required");
    expect(llm.runForText).toHaveBeenCalledTimes(1);
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it.each([
    "Return to design_experiments now; we can revisit implementation later.",
    "Return to design_experiments now and handle the implementation later.",
    "Return to design_experiments first, then inspect implementation later.",
    "Return to design_experiments first, then inspect implementation.",
    "First return to design_experiments; after that inspect implementation.",
    "먼저 design_experiments로 돌아간 다음 나중에 implement_experiments를 확인해 주세요."
  ])("executes the explicitly ordered current route before a later plan: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = {
      ...makeInactiveOrchestrator(),
      jumpToNode: makeJumpAction(runStore, run, "design_experiments")
    };
    const llm = { runForText: vi.fn() };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("resumed");
    expect(llm.runForText).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).toHaveBeenCalledWith(
      run.id,
      "design_experiments",
      "safe",
      "human intervention: objective_metric_clarification"
    );
  });

  it("keeps an unmarked multi-step route sequence pending even when a model picks the first mention", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const answer = "Return to design_experiments, then inspect implementation.";
    const llm = { runForText: vi.fn().mockResolvedValue(JSON.stringify({
      decision: "select_choice",
      choice_id: "revise_design",
      normalized_answer: answer,
      followup_question: "",
      rationale: "The first route was selected."
    })) };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("followup_required");
    expect(llm.runForText).toHaveBeenCalledTimes(1);
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
  });

  it.each([
    "Please continue with this run.",
    "I absolutely want to continue.",
    "Please retry.",
    "Please go on.",
    "계속 진행해 주세요.",
    "진행을 재개해 주세요."
  ])("lets a model accept an affirmative whole-utterance continuation: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const retriedRun = makeRetriedRun(run);
    const orchestrator = {
      ...makeInactiveOrchestrator(),
      retryCurrent: vi.fn().mockResolvedValue(retriedRun)
    };
    const llm = { runForText: vi.fn().mockResolvedValue(JSON.stringify({
      decision: "accept_default",
      choice_id: "",
      normalized_answer: answer,
      followup_question: "",
      rationale: "The operator affirmatively requested continuation."
    })) };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    await persistPendingRequest(workspaceRoot, run.id, request);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      answer,
      { llm }
    );

    expect(result.status).toBe("resumed");
    expect(llm.runForText).toHaveBeenCalledTimes(1);
    expect(orchestrator.retryCurrent).toHaveBeenCalledWith(run.id, "analyze_results");
  });

  it.each([
    "Do not return to design_experiments.",
    "I do not want to redesign this.",
    "Do not use primary_metric >= 0.4.",
    "Do not, under any circumstances, use primary_metric >= 0.4.",
    "Let's not use primary_metric >= 0.4 as our target.",
    "primary_metric은 0.4 이상으로 하지 마세요.",
    "primary_metric = TBD",
    "primary_metric should maybe improve someday",
    "design_experiments 로 돌아가지 마세요.",
    "design 로 돌아가지 마세요.",
    "revise_design을 선택하지 마.",
    "design_experiments is not acceptable.",
    "design_experiments is unacceptable.",
    "design_experiments must be avoided.",
    "Instead of design_experiments, ask me again.",
    "design should not be used.",
    "Anything except design_experiments.",
    "primary_metric >= 0.4 should not be used.",
    "primary_metric >= 0.4 is not acceptable.",
    "Anything except primary_metric >= 0.4."
  ])("keeps negated or deferred fast-path input pending: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = {
      ...makeAdaptiveRequest(),
      context: [
        "The comparison contract may need revision.",
        "Available numeric metrics: primary_metric, secondary_metric."
      ]
    };
    const orchestrator = makeInactiveOrchestrator();
    const llm = { runForText: vi.fn() };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("followup_required");
    expect(llm.runForText).not.toHaveBeenCalled();
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({
        id: request.id,
        conversation: [expect.objectContaining({ answer })]
      })
    );
  });

  it.each([
    "No design_experiments.",
    "Exclude design_experiments.",
    "Avoiding design_experiments is safer.",
    "design_experiments is forbidden.",
    "design_experiments is a bad idea.",
    "No primary_metric >= 0.4.",
    "Exclude primary_metric >= 0.4.",
    "Avoiding primary_metric >= 0.4 is safer.",
    "primary_metric >= 0.4 is forbidden.",
    "primary_metric >= 0.4 is a bad idea."
  ])("does not execute non-affirmative identifier or metric prose: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeMetricAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer);

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it("does not treat a route alias embedded inside another word as a route", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "Improve the redesign quality."
    );

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it("does not execute a natural route-alias substring after model fallback is unavailable", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "Please return to design and repair the comparison contract."
    );

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it.each([
    "Could you return to design_experiments?",
    "Could you please return to design_experiments?",
    "Would you kindly return to design_experiments?",
    "design_experiments로 돌아가 주세요."
  ])("treats a stable declared node in a natural request as explicit: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const jumpToNode = makeJumpAction(runStore, run, "design_experiments");
    const orchestrator = {
      ...makeInactiveOrchestrator(),
      jumpToNode
    };
    const llm = { runForText: vi.fn() };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    await persistPendingRequest(workspaceRoot, run.id, request);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      answer,
      { llm }
    );

    expect(result.status).toBe("resumed");
    expect(llm.runForText).not.toHaveBeenCalled();
    expect(jumpToNode).toHaveBeenCalledWith(
      run.id,
      "design_experiments",
      "safe",
      "human intervention: objective_metric_clarification"
    );
  });

  it.each([
    {
      label: "without an interpreter",
      answer: "Use primary_metric >= 0.4 or return to design.",
      interpreter: "none"
    },
    {
      label: "after invalid interpreter output",
      answer: "Use primary_metric >= 0.4 or return to design_experiments.",
      interpreter: "invalid"
    },
    {
      label: "after an interpreter error",
      answer: "Use primary_metric >= 0.4 or select revise_design.",
      interpreter: "throw"
    }
  ])("keeps mixed metric and route intent pending $label", async ({ answer, interpreter }) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = {
      ...makeAdaptiveRequest(),
      context: [
        "The comparison contract may need revision.",
        "Available numeric metrics: primary_metric, secondary_metric."
      ]
    };
    const orchestrator = makeInactiveOrchestrator();
    const llm = interpreter === "invalid"
      ? { runForText: vi.fn().mockResolvedValue("not a structured decision") }
      : interpreter === "throw"
        ? { runForText: vi.fn().mockRejectedValue(new Error("provider unavailable")) }
        : undefined;
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      answer,
      llm ? { llm } : undefined
    );

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({
        id: request.id,
        conversation: [expect.objectContaining({ answer })]
      })
    );
  });

  it.each([
    "return to design_experiments and repair the comparison or use implement_experiments",
    "return to design_experiments and inspect implement_experiments",
    "return to design_experiments and check implementation"
  ])("keeps multiple declared routes pending without an interpreter: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer);

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it.each([
    {
      answer: "return to design_experiments and repair the comparison or use implement_experiments",
      expectsModelCall: false
    },
    {
      answer: "return to design_experiments and inspect implement_experiments",
      expectsModelCall: true
    },
    {
      answer: "return to design_experiments and check implementation",
      expectsModelCall: true
    }
  ])("keeps multiple declared routes pending after invalid model output: $answer", async ({
    answer,
    expectsModelCall
  }) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const llm = { runForText: vi.fn().mockResolvedValue("not a structured decision") };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("followup_required");
    expect(llm.runForText).toHaveBeenCalledTimes(expectsModelCall ? 1 : 0);
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({ id: request.id, conversation: [expect.objectContaining({ answer })] })
    );
  });

  it("keeps free text pending when the interpreter throws", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const llm = {
      runForText: vi.fn().mockRejectedValue(new Error("provider unavailable"))
    };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "Use a safer recovery path after checking the available evidence.",
      { llm }
    );

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({
        id: request.id,
        conversation: [expect.objectContaining({
          answer: "Use a safer recovery path after checking the available evidence."
        })]
      })
    );
  });

  it("keeps free text pending when the interpreter returns invalid JSON", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const llm = {
      runForText: vi.fn().mockResolvedValue("not a structured decision")
    };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "Use a safer recovery path after checking the available evidence.",
      { llm }
    );

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({
        id: request.id,
        conversation: [expect.objectContaining({
          answer: "Use a safer recovery path after checking the available evidence."
        })]
      })
    );
  });

  it("treats an abort word in a provider error message as an interpreter failure", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const llm = {
      runForText: vi.fn().mockRejectedValue(new Error("provider operation aborted"))
    };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "Use a safer recovery path after checking the available evidence.",
      { llm }
    );

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({
        id: request.id,
        conversation: [expect.objectContaining({
          answer: "Use a safer recovery path after checking the available evidence."
        })]
      })
    );
  });

  it.each([
    { label: "exact choice", answer: "revise_design" },
    { label: "exact default", answer: "use the declared default" },
    { label: "verified metric", answer: "primary_metric >= 0.4" },
    { label: "model interpretation", answer: "Use whichever declared path is safer." }
  ])("rejects a pre-aborted caller before the $label path mutates state", async ({ answer }) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeMetricAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const llm = { runForText: vi.fn().mockResolvedValue(JSON.stringify({
      decision: "accept_default",
      choice_id: "",
      normalized_answer: answer,
      followup_question: "",
      rationale: "The operator supplied an answer."
    })) };
    const abortController = new AbortController();
    abortController.abort();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    await memory.put("human_intervention.pending", request);

    await expect(supervisor.answerHumanIntervention(
      run.id,
      request,
      answer,
      { llm, abortSignal: abortController.signal }
    )).rejects.toMatchObject({
      name: "AbortError",
      message: "The operation was aborted."
    });

    expect(llm.runForText).not.toHaveBeenCalled();
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    expect(await memory.get("human_intervention.pending")).toEqual(request);
    expect(await memory.get("human_intervention.history")).toBeUndefined();
    expect(await memory.get("analyze_results.objective_clarification")).toBeUndefined();
  });

  it("treats a provider AbortError as interpreter failure while the caller signal is active", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const abortController = new AbortController();
    const llm = {
      runForText: vi.fn().mockRejectedValue(new DOMException("Provider stopped.", "AbortError"))
    };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "Use a safer recovery path after checking the available evidence.",
      { llm, abortSignal: abortController.signal }
    );

    expect(result.status).toBe("followup_required");
    expect(abortController.signal.aborted).toBe(false);
    expect(llm.runForText).toHaveBeenCalledTimes(1);
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it("rejects an abort that happens while a model ignores the signal and returns valid JSON", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const abortController = new AbortController();
    const llm = {
      runForText: vi.fn().mockImplementation(async () => {
        abortController.abort();
        return JSON.stringify({
          decision: "accept_default",
          choice_id: "",
          normalized_answer: "Use a safer recovery path after checking the available evidence.",
          followup_question: "",
          rationale: "The operator supplied an answer."
        });
      })
    };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    await memory.put("human_intervention.pending", request);

    await expect(supervisor.answerHumanIntervention(
      run.id,
      request,
      "Use a safer recovery path after checking the available evidence.",
      { llm, abortSignal: abortController.signal }
    )).rejects.toMatchObject({ name: "AbortError" });

    expect(llm.runForText).toHaveBeenCalledTimes(1);
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    expect(await memory.get("human_intervention.pending")).toEqual(request);
    expect(await memory.get("human_intervention.history")).toBeUndefined();
  });

  it.each([
    "primary_metric >= 0.4",
    "primary_metric >= 0.4 without exceeding the budget",
    "primary_metric should be not less than 0.4",
    "Please use primary_metric >= 0.4 as the success threshold.",
    "Lets use primary_metric >= 0.4 as our target.",
    "Use primary_metric >= 0.4 because it is the primary outcome.",
    "primary_metric >= 0.4, since that is the success threshold.",
    "primary_metric은 0.4 이상으로 해주세요.",
    "The current metric is not reliable; use primary_metric >= 0.4.",
    "The current metric is not reliable, so use primary_metric >= 0.4.",
    "Do not use secondary_metric; use primary_metric >= 0.4.",
    "maximize primary_metric and increase primary_metric by 10%",
    "minimize primary_metric and decrease primary_metric by 10%"
  ])("accepts a verified available-metric criterion without a model round-trip: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = {
      ...makeAdaptiveRequest(),
      context: [
        "The comparison contract may need revision.",
        "Available numeric metrics: primary_metric, secondary_metric."
      ]
    };
    const retriedRun = makeRetriedRun(run);
    const orchestrator = {
      ...makeInactiveOrchestrator(),
      retryCurrent: vi.fn().mockResolvedValue(retriedRun)
    };
    const llm = { runForText: vi.fn() };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    await persistPendingRequest(workspaceRoot, run.id, request);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      answer,
      { llm }
    );

    expect(result.status).toBe("resumed");
    expect(llm.runForText).not.toHaveBeenCalled();
    expect(orchestrator.retryCurrent).toHaveBeenCalledWith(run.id, "analyze_results");
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("analyze_results.objective_clarification")).toBe(answer);
  });

  it.each([
    "Mention primary_metric for context; latency >= 10.",
    "primary_metric is available, but unrelated budget = 1.",
    "We measured primary_metric while timeout should decrease by 10%."
  ])("does not bind an available metric to an unrelated criterion: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeMetricAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer);

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({
        id: request.id,
        conversation: [expect.objectContaining({ answer })]
      })
    );
  });

  it.each([
    "latency >= 10",
    "invented_metric >= 1",
    "Set latency threshold to 10.",
    "Use latency as the metric."
  ])("does not let a model accept a criterion for an unavailable metric: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeMetricAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const llm = { runForText: vi.fn().mockResolvedValue(JSON.stringify({
      decision: "accept_default",
      choice_id: "",
      normalized_answer: answer,
      followup_question: "",
      rationale: "The operator supplied a numeric threshold."
    })) };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("followup_required");
    expect(llm.runForText).toHaveBeenCalledTimes(1);
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it.each([
    "Set primary_metric threshold to 10.",
    "Use primary_metric as the metric."
  ])("lets a model accept the same natural criterion for an available metric: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeMetricAdaptiveRequest();
    const orchestrator = {
      ...makeInactiveOrchestrator(),
      retryCurrent: vi.fn().mockResolvedValue(makeRetriedRun(run))
    };
    const llm = { runForText: vi.fn().mockResolvedValue(JSON.stringify({
      decision: "accept_default",
      choice_id: "",
      normalized_answer: answer,
      followup_question: "",
      rationale: "The operator selected an available metric."
    })) };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    await persistPendingRequest(workspaceRoot, run.id, request);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("resumed");
    expect(llm.runForText).toHaveBeenCalledTimes(1);
    expect(orchestrator.retryCurrent).toHaveBeenCalledWith(run.id, "analyze_results");
  });

  it.each([
    { label: "without an interpreter", interpreter: "none" },
    { label: "after invalid interpreter output", interpreter: "invalid" },
    { label: "after an interpreter error", interpreter: "throw" }
  ])("keeps conflicting metric criteria pending $label", async ({ interpreter }) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeMetricAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const llm = interpreter === "invalid"
      ? { runForText: vi.fn().mockResolvedValue("not a structured decision") }
      : interpreter === "throw"
        ? { runForText: vi.fn().mockRejectedValue(new Error("provider unavailable")) }
        : undefined;
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    const answer = "primary_metric >= 0.4 and primary_metric < 0.2";

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      answer,
      llm ? { llm } : undefined
    );

    expect(result.status).toBe("followup_required");
    if (llm) {
      expect(llm.runForText).toHaveBeenCalledTimes(1);
    }
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({
        id: request.id,
        conversation: [expect.objectContaining({ answer })]
      })
    );
  });

  it.each([
    "maximize primary_metric and decrease primary_metric by 10%",
    "minimize primary_metric and increase primary_metric by 10%",
    "primary_metric >= 0.4 and primary_metric <= 0.4 and primary_metric != 0.4",
    "increase primary_metric by 10% and increase primary_metric by 20%",
    "decrease primary_metric by 10% and decrease primary_metric by 20%",
    "primary_metric should improve by 5% and primary_metric should improve by 50%",
    "primary_metric 10% 증가 그리고 primary_metric 20% 증가"
  ])("keeps cross-polarity or empty-feasible-set criteria pending: %s", async (answer) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeMetricAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer);

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it.each([
    { prefix: "", interpreter: "none" },
    { prefix: "+", interpreter: "none" },
    { prefix: "", interpreter: "invalid" },
    { prefix: "+", interpreter: "invalid" }
  ])("keeps overflowing numeric criteria pending: $prefix ($interpreter)", async ({
    prefix,
    interpreter
  }) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeMetricAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const answer = `primary_metric >= ${prefix}${"9".repeat(400)}`;
    const llm = interpreter === "invalid"
      ? { runForText: vi.fn().mockResolvedValue("not a structured decision") }
      : undefined;
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      answer,
      llm ? { llm } : undefined
    );

    expect(result.status).toBe("followup_required");
    if (llm) {
      expect(llm.runForText).toHaveBeenCalledTimes(1);
    }
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
  });

  it.each([
    { answer: "increase primary_metric by -10%", interpreter: "none" },
    { answer: "decrease primary_metric by -10%", interpreter: "none" },
    { answer: "primary_metric should improve by -10%", interpreter: "none" },
    { answer: "primary_metric -10% 증가", interpreter: "none" },
    { answer: "increase primary_metric by -10%", interpreter: "invalid" },
    { answer: "decrease primary_metric by -10%", interpreter: "invalid" },
    { answer: "primary_metric should improve by -10%", interpreter: "invalid" },
    { answer: "primary_metric -10% 증가", interpreter: "invalid" }
  ])("keeps non-positive change magnitudes pending: $answer ($interpreter)", async ({
    answer,
    interpreter
  }) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeMetricAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const llm = interpreter === "invalid"
      ? { runForText: vi.fn().mockResolvedValue("not a structured decision") }
      : undefined;
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      answer,
      llm ? { llm } : undefined
    );

    expect(result.status).toBe("followup_required");
    if (llm) {
      expect(llm.runForText).toHaveBeenCalledTimes(1);
    }
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({ id: request.id, conversation: [expect.objectContaining({ answer })] })
    );
  });

  it.each([
    {
      answer: "primary_metric >= 0.4 or primary_metric < 0.2",
      decision: "accept_default",
      choiceId: "",
      expectsModelCall: true
    },
    {
      answer: "maximize primary_metric and minimize primary_metric",
      decision: "accept_default",
      choiceId: "",
      expectsModelCall: true
    },
    {
      answer: "primary_metric >= 0.4 or design_experiments",
      decision: "select_choice",
      choiceId: "revise_design",
      expectsModelCall: true
    }
  ])("does not let a successful model resolve deterministic ambiguity: $answer", async ({
    answer,
    decision,
    choiceId,
    expectsModelCall
  }) => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeMetricAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const llm = { runForText: vi.fn().mockResolvedValue(JSON.stringify({
      decision,
      choice_id: choiceId,
      normalized_answer: answer,
      followup_question: "",
      rationale: "A declared action was selected."
    })) };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, answer, { llm });

    expect(result.status).toBe("followup_required");
    expect(llm.runForText).toHaveBeenCalledTimes(expectsModelCall ? 1 : 0);
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({ id: request.id, conversation: [expect.objectContaining({ answer })] })
    );
  });

  it("includes prior turns in model interpretation and preserves the raw operator answer", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = {
      ...makeAdaptiveRequest(),
      conversation: [{
        question: "Which metric should govern the run?",
        answer: "Use the primary metric.",
        followupQuestion: "What threshold should it use?",
        resolutionSource: "model" as const,
        recordedAt: new Date().toISOString()
      }]
    };
    const retriedRun = makeRetriedRun(run);
    const orchestrator = {
      jumpToNode: vi.fn(),
      retryCurrent: vi.fn().mockResolvedValue(retriedRun),
      approveCurrent: vi.fn(),
      applyPendingTransition: vi.fn()
    };
    const llm = {
      runForText: vi.fn().mockResolvedValue(JSON.stringify({
        decision: "accept_default",
        choice_id: "",
        normalized_answer: "invented_metric >= 1",
        followup_question: "",
        rationale: "The operator supplied the requested threshold."
      }))
    };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    const rawAnswer = "Use the primary score threshold from the prior turn.";
    await persistPendingRequest(workspaceRoot, run.id, request);

    await supervisor.answerHumanIntervention(run.id, request, rawAnswer, { llm });

    expect(llm.runForText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("What threshold should it use?")
    }));
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("analyze_results.objective_clarification")).toBe(rawAnswer);
    expect(await memory.get("human_intervention.history")).toEqual([
      expect.objectContaining({ answer: rawAnswer, resolutionSource: "model" })
    ]);
  });

  it("keeps the intervention pending when the model selects an undeclared choice", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const orchestrator = makeInactiveOrchestrator();
    const llm = {
      runForText: vi.fn().mockResolvedValue(JSON.stringify({
        decision: "select_choice",
        choice_id: "undeclared_route",
        normalized_answer: "",
        followup_question: "",
        rationale: ""
      }))
    };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "Use the safer option after checking the evidence.",
      { llm }
    );

    expect(result.status).toBe("followup_required");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(orchestrator.approveCurrent).not.toHaveBeenCalled();
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(orchestrator.jumpToNode).not.toHaveBeenCalled();
    const memory = new RunContextMemory(
      path.join(workspaceRoot, ".autolabos", "runs", run.id, "memory", "run_context.json")
    );
    expect(await memory.get("human_intervention.pending")).toEqual(
      expect.objectContaining({
        id: request.id,
        question: expect.stringContaining("metric criterion")
      })
    );
  });

  it("honors an explicit declared node identifier without a model round-trip", async () => {
    const run = await createPausedAnalyzeRun(runStore);
    const request = makeAdaptiveRequest();
    const jumpToNode = makeJumpAction(runStore, run, "design_experiments");
    const orchestrator = {
      jumpToNode,
      retryCurrent: vi.fn(),
      approveCurrent: vi.fn(),
      applyPendingTransition: vi.fn()
    };
    const llm = { runForText: vi.fn() };
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    await persistPendingRequest(workspaceRoot, run.id, request);

    await supervisor.answerHumanIntervention(
      run.id,
      request,
      "Return to design_experiments and repair the comparison contract.",
      { llm }
    );

    expect(llm.runForText).not.toHaveBeenCalled();
    expect(jumpToNode).toHaveBeenCalledWith(
      run.id,
      "design_experiments",
      "safe",
      "human intervention: objective_metric_clarification"
    );
  });
});

async function createPausedAnalyzeRun(runStore: RunStore) {
  const run = await runStore.createRun({
    title: "Adaptive intervention run",
    topic: "Configured evaluation topic",
    constraints: [],
    objectiveMetric: "unresolved objective"
  });
  run.status = "paused";
  run.currentNode = "analyze_results";
  run.graph.currentNode = "analyze_results";
  run.graph.nodeStates.analyze_results = {
    status: "needs_approval",
    updatedAt: new Date().toISOString(),
    note: "Operator clarification required."
  };
  await runStore.updateRun(run);
  return run;
}

function makeAdaptiveRequest() {
  return createHumanInterventionRequest({
    sourceNode: "analyze_results",
    kind: "objective_metric_clarification",
    title: "Clarify the objective metric",
    question: "Which metric or recovery path should govern the next step?",
    context: ["The comparison contract may need revision."],
    inputMode: "free_text",
    resumeAction: "retry_current",
    choices: [
      {
        id: "revise_design",
        label: "Return to experiment design",
        answerAliases: ["design", "design_experiments"],
        resumeAction: "jump",
        targetNode: "design_experiments"
      },
      {
        id: "inspect_implementation",
        label: "Return to implementation",
        answerAliases: ["implementation", "implement_experiments"],
        resumeAction: "jump",
        targetNode: "implement_experiments"
      }
    ]
  });
}

function makeMetricAdaptiveRequest() {
  return {
    ...makeAdaptiveRequest(),
    context: [
      "The comparison contract may need revision.",
      "Available numeric metrics: primary_metric, secondary_metric."
    ]
  };
}

function makeInactiveOrchestrator() {
  return {
    jumpToNode: vi.fn(),
    retryCurrent: vi.fn(),
    approveCurrent: vi.fn(),
    applyPendingTransition: vi.fn()
  };
}

async function persistPendingRequest(
  workspaceRoot: string,
  runId: string,
  request: ReturnType<typeof makeAdaptiveRequest>
): Promise<void> {
  const memory = new RunContextMemory(
    path.join(workspaceRoot, ".autolabos", "runs", runId, "memory", "run_context.json")
  );
  await memory.put("human_intervention.pending", request);
}

function makeRetriedRun(run: Awaited<ReturnType<typeof createPausedAnalyzeRun>>) {
  const retried = structuredClone(run);
  retried.status = "running";
  retried.graph.checkpointSeq += 1;
  retried.graph.retryCounters.analyze_results =
    (retried.graph.retryCounters.analyze_results ?? 0) + 1;
  retried.graph.pendingTransition = undefined;
  retried.graph.nodeStates.analyze_results = {
    ...retried.graph.nodeStates.analyze_results,
    status: "running",
    updatedAt: new Date().toISOString(),
    note: "manual retry"
  };
  return retried;
}

function makeJumpedRun(
  run: Awaited<ReturnType<typeof createPausedAnalyzeRun>>,
  targetNode: "design_experiments" | "implement_experiments"
) {
  const jumped = structuredClone(run);
  jumped.status = "paused";
  jumped.currentNode = targetNode;
  jumped.graph.currentNode = targetNode;
  jumped.graph.checkpointSeq += 1;
  jumped.graph.pendingTransition = undefined;
  jumped.graph.nodeStates[targetNode] = {
    ...jumped.graph.nodeStates[targetNode],
    status: "pending",
    updatedAt: new Date().toISOString(),
    note: "manual safe jump"
  };
  return jumped;
}

function makeJumpAction(
  runStore: RunStore,
  run: Awaited<ReturnType<typeof createPausedAnalyzeRun>>,
  targetNode: "design_experiments" | "implement_experiments"
) {
  return vi.fn().mockImplementation(async () => {
    const jumped = makeJumpedRun(run, targetNode);
    await runStore.updateRun(jumped);
    return jumped;
  });
}
