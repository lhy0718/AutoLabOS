import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureScaffold, resolveAppPaths } from "../src/config.js";
import { AgentOrchestrator } from "../src/core/agents/agentOrchestrator.js";
import { InMemoryEventStream } from "../src/core/events.js";
import {
  createHumanInterventionRequest,
  HUMAN_INTERVENTION_HISTORY_KEY,
  HUMAN_INTERVENTION_PENDING_KEY,
  HumanInterventionRequest,
  HumanInterventionResumeAction,
  writeHumanInterventionRequest
} from "../src/core/humanIntervention.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { resolveHumanInterventionRunLockPath } from "../src/core/humanInterventionLock.js";
import { InteractiveRunSupervisor } from "../src/core/runs/interactiveRunSupervisor.js";
import { RunStore } from "../src/core/runs/runStore.js";
import { CheckpointStore } from "../src/core/stateGraph/checkpointStore.js";
import { StateGraphRuntime } from "../src/core/stateGraph/runtime.js";
import type { GraphNodeRegistry } from "../src/core/stateGraph/types.js";
import type { TransitionRecommendation } from "../src/types.js";
import { listRunArtifacts } from "../src/web/artifacts.js";

describe("human intervention action commit safety", () => {
  let workspaceRoot: string;
  let runStore: RunStore;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-intervention-commit-"));
    const paths = resolveAppPaths(workspaceRoot);
    await ensureScaffold(paths);
    runStore = new RunStore(paths);
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it.each([
    "retry_current",
    "approve_current",
    "apply_transition",
    "jump"
  ] as const)("keeps the answer pending when %s fails", async (resumeAction) => {
    const run = await createRun(runStore);
    if (resumeAction === "apply_transition") {
      run.graph.pendingTransition = makeDesignTransition();
      run.graph.checkpointSeq += 1;
      await runStore.updateRun(run);
    }
    const request = makeRequest(resumeAction);
    const runContext = contextFor(workspaceRoot, run.id);
    const previousHistory = [{ requestId: "previous-request", answeredAt: "earlier" }];
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    await runContext.put(HUMAN_INTERVENTION_HISTORY_KEY, previousHistory);

    const actionError = new Error(`workflow action failed: ${resumeAction}`);
    const orchestrator = makeOrchestrator();
    selectedAction(orchestrator, resumeAction).mockRejectedValue(actionError);
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    await expect(
      supervisor.answerHumanIntervention(run.id, request, answerFor(resumeAction))
    ).rejects.toBe(actionError);

    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toEqual(previousHistory);
    expect(await runContext.get("analyze_results.objective_clarification")).toBeUndefined();
  });

  it("does not start an action for an answer canceled before commit", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    const controller = new AbortController();
    controller.abort();

    await expect(
      supervisor.answerHumanIntervention(run.id, request, "retry_current", {
        abortSignal: controller.signal
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("does not consume the answer when an action rejects after cancellation", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const controller = new AbortController();
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockImplementation(async () => {
      controller.abort();
      const error = new Error("workflow action aborted");
      error.name = "AbortError";
      throw error;
    });
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    await expect(
      supervisor.answerHumanIntervention(run.id, request, "retry_current", {
        abortSignal: controller.signal
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(orchestrator.retryCurrent).toHaveBeenCalledWith(run.id, request.sourceNode);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
    expect(await runContext.get("analyze_results.objective_clarification")).toBeUndefined();
  });

  it("surfaces recovery-required for a prepared intent when the action threw after mutation", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockImplementationOnce(async () => {
      const changedRun = structuredClone(run);
      changedRun.currentNode = request.sourceNode;
      changedRun.graph.currentNode = request.sourceNode;
      changedRun.status = "running";
      changedRun.graph.checkpointSeq += 1;
      changedRun.graph.nodeStates[request.sourceNode] = {
        ...changedRun.graph.nodeStates[request.sourceNode],
        status: "running",
        updatedAt: new Date().toISOString(),
        note: "manual retry"
      };
      await runStore.updateRun(changedRun);
      throw new Error("action response failed after persistence");
    });
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    await expect(
      supervisor.answerHumanIntervention(run.id, request, "retry_current")
    ).rejects.toThrow("action response failed after persistence");
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();

    const reloadedSupervisor = new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    );
    const surfaced = await reloadedSupervisor.getActiveRequest(await runStore.getRun(run.id) ?? run);
    expect(surfaced?.title).toContain("Recovery required");

    const recovered = await reloadedSupervisor.answerHumanIntervention(
      run.id,
      request,
      "retry_current"
    );

    expect(recovered.status).toBe("invalid_answer");
    expect(recovered.message).toContain("Recovery is required");
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("finishes committing an action that succeeds while cancellation arrives", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const controller = new AbortController();
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockImplementation(async () => {
      controller.abort();
      return appliedRunFor(run, "retry_current");
    });
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, "retry_current", {
      abortSignal: controller.signal
    });

    expect(result.status).toBe("resumed");
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toEqual([
      expect.objectContaining({ requestId: request.id, resumeAction: "retry_current" })
    ]);
  });

  it.each([
    "retry_current",
    "use the declared default"
  ])("commits an exact default without storing it as objective evidence: %s", async (answer) => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const previousEvaluation = { metric: "primary_metric", passed: true };
    await runContext.put("objective_metric.last_evaluation", previousEvaluation);
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockResolvedValue(appliedRunFor(run, "retry_current"));
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      answer
    );

    expect(result.status).toBe("resumed");
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toEqual([
      expect.objectContaining({
        requestId: request.id,
        answer,
        resumeAction: "retry_current"
      })
    ]);
    expect(await runContext.get("analyze_results.objective_clarification")).toBeUndefined();
    expect(await runContext.get("objective_metric.last_evaluation")).toEqual(previousEvaluation);
  });

  it("stores a verified metric criterion as objective clarification", async () => {
    const run = await createRun(runStore);
    const request = {
      ...makeRequest("retry_current"),
      context: ["Available numeric metrics: primary_metric."]
    };
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    await runContext.put("objective_metric.last_evaluation", { passed: false });
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockResolvedValue(appliedRunFor(run, "retry_current"));
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "primary_metric >= 0.4"
    );

    expect(result.status).toBe("resumed");
    expect(await runContext.get("analyze_results.objective_clarification")).toBe(
      "primary_metric >= 0.4"
    );
    expect(await runContext.get("objective_metric.last_evaluation")).toBeNull();
  });

  it("recovers objective clarification after its first persistence attempt fails", async () => {
    const run = await createRun(runStore);
    const request = {
      ...makeRequest("retry_current"),
      context: ["Available numeric metrics: primary_metric."]
    };
    const answer = "primary_metric >= 0.4";
    const previousEvaluation = { passed: false };
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    await runContext.put("objective_metric.last_evaluation", previousEvaluation);
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockResolvedValue(appliedRunFor(run, "retry_current"));
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    const originalPut = RunContextMemory.prototype.put;
    let failed = false;
    const putSpy = vi.spyOn(RunContextMemory.prototype, "put").mockImplementation(function (
      key,
      value
    ) {
      if (!failed && key === "analyze_results.objective_clarification") {
        failed = true;
        return Promise.reject(new Error("objective clarification persistence failed"));
      }
      return originalPut.call(this, key, value);
    });

    await expect(
      supervisor.answerHumanIntervention(run.id, request, answer)
    ).rejects.toThrow("objective clarification persistence failed");
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toEqual([
      expect.objectContaining({ requestId: request.id, answer })
    ]);
    expect(await runContext.get("analyze_results.objective_clarification")).toBeUndefined();
    expect(await runContext.get("objective_metric.last_evaluation")).toEqual(previousEvaluation);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(JSON.parse(await fs.readFile(
      answerCommitPath(workspaceRoot, run.id, request.id),
      "utf8"
    ))).toMatchObject({ status: "action_applied" });

    putSpy.mockRestore();
    const reloadedSupervisor = new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    );
    const active = await reloadedSupervisor.getActiveRequest(run);

    expect(active).toBeUndefined();
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toEqual([
      expect.objectContaining({ requestId: request.id, answer })
    ]);
    expect(await runContext.get("analyze_results.objective_clarification")).toBe(answer);
    expect(await runContext.get("objective_metric.last_evaluation")).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(JSON.parse(await fs.readFile(
      answerCommitPath(workspaceRoot, run.id, request.id),
      "utf8"
    ))).toMatchObject({ status: "committed" });
  });

  it("recovers an applied action after history persistence fails without rerunning it", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockResolvedValue(appliedRunFor(run, "retry_current"));
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    const originalPut = RunContextMemory.prototype.put;
    let failed = false;
    const putSpy = vi.spyOn(RunContextMemory.prototype, "put").mockImplementation(function (
      key,
      value
    ) {
      if (!failed && key === HUMAN_INTERVENTION_HISTORY_KEY) {
        failed = true;
        return Promise.reject(new Error("history persistence failed"));
      }
      return originalPut.call(this, key, value);
    });

    await expect(
      supervisor.answerHumanIntervention(run.id, request, "retry_current")
    ).rejects.toThrow("history persistence failed");
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();

    putSpy.mockRestore();
    const recovered = await new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    ).answerHumanIntervention(run.id, request, "retry_current");

    expect(recovered.status).toBe("resumed");
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toEqual([
      expect.objectContaining({ requestId: request.id })
    ]);
  });

  it("recovers a failed pending clear without duplicating action or history", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockResolvedValue(appliedRunFor(run, "retry_current"));
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    const originalPut = RunContextMemory.prototype.put;
    let failed = false;
    const putSpy = vi.spyOn(RunContextMemory.prototype, "put").mockImplementation(function (
      key,
      value
    ) {
      if (!failed && key === HUMAN_INTERVENTION_PENDING_KEY && value === null) {
        failed = true;
        return Promise.reject(new Error("pending clear failed"));
      }
      return originalPut.call(this, key, value);
    });

    await expect(
      supervisor.answerHumanIntervention(run.id, request, "retry_current")
    ).rejects.toThrow("pending clear failed");
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toHaveLength(1);

    putSpy.mockRestore();
    await new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    ).answerHumanIntervention(run.id, request, "retry_current");

    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toHaveLength(1);
  });

  it("does not persist a follow-up turn when cancellation arrives before its write", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    const previousHistory = [{ requestId: "previous-request", answeredAt: "earlier" }];
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    await runContext.put(HUMAN_INTERVENTION_HISTORY_KEY, previousHistory);
    const controller = new AbortController();
    vi.spyOn(runStore, "getRun").mockImplementationOnce(async () => {
      controller.abort();
      return run;
    });
    const orchestrator = makeOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    await expect(
      supervisor.answerHumanIntervention(
        run.id,
        request,
        "Use whichever path is safer.",
        { abortSignal: controller.signal }
      )
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toEqual(previousHistory);
  });

  it("serializes a concurrent workflow request writer behind a follow-up answer", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const newerRequest = makeRequest("approve_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    let releaseResolution!: () => void;
    let reportResolutionStarted!: () => void;
    const resolutionStarted = new Promise<void>((resolve) => {
      reportResolutionStarted = resolve;
    });
    const resolutionBarrier = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    const llm = {
      runForText: vi.fn(async () => {
        reportResolutionStarted();
        await resolutionBarrier;
        return JSON.stringify({
          decision: "ask_followup",
          normalized_answer: "",
          followup_question: "Which exact bounded criterion should be used?",
          rationale: "The answer does not select a safe route."
        });
      })
    };
    const supervisor = new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      makeOrchestrator() as never
    );

    const answerPromise = supervisor.answerHumanIntervention(
      run.id,
      request,
      "Use a bounded criterion for this decision.",
      { llm }
    );
    await resolutionStarted;
    const writerPromise = writeHumanInterventionRequest({
      workspaceRoot,
      run,
      runContext,
      request: newerRequest
    });
    releaseResolution();
    const [result] = await Promise.all([answerPromise, writerPromise]);

    expect(result.status).toBe("followup_required");
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(newerRequest);
  });

  it("reconciles an applied commit during active-request reload without rerunning the action", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockResolvedValue(appliedRunFor(run, "retry_current"));
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);
    const originalPut = RunContextMemory.prototype.put;
    let failed = false;
    const putSpy = vi.spyOn(RunContextMemory.prototype, "put").mockImplementation(function (
      key,
      value
    ) {
      if (!failed && key === HUMAN_INTERVENTION_HISTORY_KEY) {
        failed = true;
        return Promise.reject(new Error("history persistence failed"));
      }
      return originalPut.call(this, key, value);
    });

    await expect(
      supervisor.answerHumanIntervention(run.id, request, "retry_current")
    ).rejects.toThrow("history persistence failed");
    putSpy.mockRestore();

    const active = await new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    ).getActiveRequest(run);

    expect(active).toBeUndefined();
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toEqual([
      expect.objectContaining({ requestId: request.id })
    ]);
  });

  it("rejects a stale request when a different persisted question is active", async () => {
    const run = await createRun(runStore);
    const staleRequest = makeRequest("retry_current");
    const activeRequest = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, activeRequest);
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockResolvedValue(appliedRunFor(run, "retry_current"));
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      staleRequest,
      "retry_current"
    );

    expect(result.status).toBe("invalid_answer");
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(activeRequest);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("does not replace a newer pending request with a stale follow-up answer", async () => {
    const run = await createRun(runStore);
    const staleRequest = makeRequest("retry_current");
    const activeRequest = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, activeRequest);
    const orchestrator = makeOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      staleRequest,
      "Use whichever path is safer."
    );

    expect(result.status).toBe("invalid_answer");
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(activeRequest);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("does not resurrect a cleared pending request from an old follow-up answer", async () => {
    const run = await createRun(runStore);
    const staleRequest = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, null);
    const orchestrator = makeOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      staleRequest,
      "Use whichever path is safer."
    );

    expect(result.status).toBe("invalid_answer");
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
  });

  it("does not overwrite newer same-id follow-up conversation with a stale request copy", async () => {
    const run = await createRun(runStore);
    const staleRequest = makeRequest("retry_current");
    const canonicalRequest = {
      ...staleRequest,
      question: "Which exact criterion should be used?",
      conversation: [{
        question: staleRequest.question,
        answer: "Use the metric.",
        followupQuestion: "Which exact criterion should be used?",
        resolutionSource: "model" as const,
        recordedAt: new Date().toISOString()
      }]
    };
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, canonicalRequest);
    const orchestrator = makeOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      staleRequest,
      "Use whichever path is safer."
    );

    expect(result.status).toBe("invalid_answer");
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(canonicalRequest);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("does not consume an answer when approve_current resolves as an unchanged no-op", async () => {
    const resumeAction = "approve_current" as const;
    const run = await createRun(runStore);
    const request = makeRequest(resumeAction);
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeOrchestrator();
    selectedAction(orchestrator, resumeAction).mockResolvedValue(run);
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      resumeAction
    );

    expect(result.status).toBe("invalid_answer");
    expect(selectedAction(orchestrator, resumeAction)).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("rejects apply_transition before dispatch when no transition is pending", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("apply_transition");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeOrchestrator();
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "apply_transition"
    );

    expect(result.status).toBe("invalid_answer");
    expect(orchestrator.applyPendingTransition).not.toHaveBeenCalled();
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("rejects apply_transition when it only returns an unrelated paused human transition", async () => {
    const run = await createRun(runStore);
    run.graph.pendingTransition = {
      action: "pause_for_human",
      sourceNode: "analyze_results",
      targetNode: "figure_audit",
      reason: "A separate human decision is still required.",
      confidence: 1,
      autoExecutable: false,
      evidence: ["The unrelated gate remains unresolved."],
      suggestedCommands: ["/agent status"],
      generatedAt: new Date().toISOString()
    };
    run.graph.checkpointSeq += 1;
    await runStore.updateRun(run);
    const request = makeRequest("apply_transition");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const pausedRun = structuredClone(run);
    const orchestrator = makeOrchestrator();
    orchestrator.applyPendingTransition.mockResolvedValue(pausedRun);
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "apply_transition"
    );

    expect(result).toMatchObject({
      status: "invalid_answer",
      message: "The workflow action was not applied. The question remains pending for a fresh answer."
    });
    expect(orchestrator.applyPendingTransition).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("rejects apply_transition when a receipt exists but the transition state was not applied", async () => {
    const run = await createRun(runStore);
    run.graph.pendingTransition = makeDesignTransition();
    run.graph.checkpointSeq += 1;
    await runStore.updateRun(run);
    const request = makeRequest("apply_transition");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const receiptOnlyRun = structuredClone(run);
    const recommendation = run.graph.pendingTransition;
    receiptOnlyRun.graph.transitionHistory.push({
      action: recommendation.action,
      sourceNode: recommendation.sourceNode,
      fromNode: run.currentNode,
      toNode: recommendation.targetNode,
      reason: recommendation.reason,
      confidence: recommendation.confidence,
      autoExecutable: recommendation.autoExecutable,
      appliedAt: new Date().toISOString()
    });
    const orchestrator = makeOrchestrator();
    orchestrator.applyPendingTransition.mockResolvedValue(receiptOnlyRun);
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "apply_transition"
    );

    expect(result.status).toBe("invalid_answer");
    expect(orchestrator.applyPendingTransition).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("rejects approve_current when needs_approval is retained and currentNode moves arbitrarily", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("approve_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const wrongTargetRun = structuredClone(run);
    wrongTargetRun.status = "running";
    wrongTargetRun.currentNode = "implement_experiments";
    wrongTargetRun.graph.currentNode = "implement_experiments";
    const orchestrator = makeOrchestrator();
    orchestrator.approveCurrent.mockResolvedValue(wrongTargetRun);
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "approve_current"
    );

    expect(result.status).toBe("invalid_answer");
    expect(orchestrator.approveCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("rejects approve_current when only checkpoint and timestamp change", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("approve_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const timestampOnlyRun = structuredClone(run);
    timestampOnlyRun.graph.checkpointSeq += 1;
    timestampOnlyRun.graph.nodeStates.analyze_results = {
      ...timestampOnlyRun.graph.nodeStates.analyze_results,
      updatedAt: new Date(Date.now() + 1_000).toISOString()
    };
    const orchestrator = makeOrchestrator();
    orchestrator.approveCurrent.mockResolvedValue(timestampOnlyRun);
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "approve_current"
    );

    expect(result.status).toBe("invalid_answer");
    expect(orchestrator.approveCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("rejects apply_transition when its receipt target does not match the prepared transition", async () => {
    const run = await createRun(runStore);
    run.graph.pendingTransition = makeDesignTransition();
    run.graph.checkpointSeq += 1;
    await runStore.updateRun(run);
    const request = makeRequest("apply_transition");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const wrongTargetRun = appliedRunFor(run, "apply_transition");
    wrongTargetRun.graph.transitionHistory.at(-1)!.toNode = "implement_experiments";
    const orchestrator = makeOrchestrator();
    orchestrator.applyPendingTransition.mockResolvedValue(wrongTargetRun);
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "apply_transition"
    );

    expect(result.status).toBe("invalid_answer");
    expect(orchestrator.applyPendingTransition).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("rejects approve_current when the returned run only changes to failed", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("approve_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const failedRun = structuredClone(run);
    failedRun.status = "failed";
    failedRun.graph.checkpointSeq += 1;
    failedRun.graph.nodeStates.analyze_results = {
      ...failedRun.graph.nodeStates.analyze_results,
      status: "failed",
      updatedAt: new Date().toISOString(),
      lastError: "Approval did not complete."
    };
    const orchestrator = makeOrchestrator();
    orchestrator.approveCurrent.mockResolvedValue(failedRun);
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "approve_current"
    );

    expect(result.status).toBe("invalid_answer");
    expect(orchestrator.approveCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it.each([
    "retry_same",
    "advance",
    "pause_for_human"
  ] as const)(
    "does not commit apply_transition when the %s receipt lacks its runtime state effect",
    async (transitionAction) => {
      const run = await createRun(runStore);
      const recommendation: TransitionRecommendation = {
        action: transitionAction,
        sourceNode: "analyze_results",
        targetNode: transitionAction === "advance"
          ? "figure_audit"
          : transitionAction === "retry_same"
            ? "analyze_results"
            : undefined,
        reason: `Apply the declared ${transitionAction} transition.`,
        confidence: 0.95,
        autoExecutable: transitionAction !== "pause_for_human",
        evidence: ["The transition was prepared for this test."],
        suggestedCommands: ["/agent status"],
        generatedAt: new Date().toISOString()
      };
      run.graph.pendingTransition = recommendation;
      run.graph.checkpointSeq += 1;
      await runStore.updateRun(run);
      const request = makeRequest("apply_transition");
      const runContext = contextFor(workspaceRoot, run.id);
      await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
      const semanticallyUnchangedRun = structuredClone(run);
      semanticallyUnchangedRun.graph.pendingTransition = undefined;
      semanticallyUnchangedRun.graph.transitionHistory = [
        ...(semanticallyUnchangedRun.graph.transitionHistory ?? []),
        transitionReceipt(run, recommendation)
      ];
      semanticallyUnchangedRun.graph.checkpointSeq += 1;
      semanticallyUnchangedRun.status = transitionAction === "pause_for_human"
        ? "paused"
        : "running";
      if (transitionAction === "advance") {
        semanticallyUnchangedRun.currentNode = "figure_audit";
        semanticallyUnchangedRun.graph.currentNode = "figure_audit";
      }
      const orchestrator = makeOrchestrator();
      orchestrator.applyPendingTransition.mockImplementationOnce(async () => {
        await runStore.updateRun(semanticallyUnchangedRun);
        return semanticallyUnchangedRun;
      });
      const supervisor = new InteractiveRunSupervisor(
        workspaceRoot,
        runStore,
        orchestrator as never
      );

      const firstResult = await supervisor.answerHumanIntervention(
        run.id,
        request,
        "apply_transition"
      );

      expect(firstResult.status).toBe("invalid_answer");
      expect(firstResult.message).toContain("Recovery is required");
      const secondResult = await new InteractiveRunSupervisor(
        workspaceRoot,
        runStore,
        orchestrator as never
      ).answerHumanIntervention(run.id, request, "apply_transition");
      expect(secondResult.status).toBe("invalid_answer");
      expect(orchestrator.applyPendingTransition).toHaveBeenCalledTimes(1);
      expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
      expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
    }
  );

  it("does not commit approve_current while its prepared advance remains pending", async () => {
    const run = await createRun(runStore);
    run.graph.pendingTransition = makeAdvanceTransition();
    run.graph.checkpointSeq += 1;
    await runStore.updateRun(run);
    const request = makeRequest("approve_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const incompleteApproval = structuredClone(run);
    incompleteApproval.status = "running";
    incompleteApproval.currentNode = "figure_audit";
    incompleteApproval.graph.currentNode = "figure_audit";
    incompleteApproval.graph.checkpointSeq += 1;
    incompleteApproval.graph.nodeStates.analyze_results = {
      ...incompleteApproval.graph.nodeStates.analyze_results,
      status: "completed",
      updatedAt: new Date().toISOString()
    };
    const orchestrator = makeOrchestrator();
    orchestrator.approveCurrent.mockImplementationOnce(async () => {
      await runStore.updateRun(incompleteApproval);
      return incompleteApproval;
    });
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "approve_current"
    );

    expect(result.status).toBe("invalid_answer");
    expect(result.message).toContain("Recovery is required");
    expect(orchestrator.approveCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("commits approval while preserving a newer downstream intervention", async () => {
    const run = await createRun(runStore);
    run.graph.pendingTransition = makeAdvanceTransition();
    run.graph.checkpointSeq += 1;
    await runStore.updateRun(run);
    const request = makeRequest("approve_current");
    const downstreamRequest = createHumanInterventionRequest({
      sourceNode: "figure_audit",
      kind: "transition_choice",
      title: "Review the downstream figure transition",
      question: "Which audited transition should be applied?",
      context: [],
      inputMode: "free_text",
      resumeAction: "apply_transition"
    });
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const downstreamRun = structuredClone(run);
    downstreamRun.status = "paused";
    downstreamRun.currentNode = "figure_audit";
    downstreamRun.graph.currentNode = "figure_audit";
    downstreamRun.graph.checkpointSeq += 1;
    downstreamRun.graph.nodeStates.analyze_results = {
      ...downstreamRun.graph.nodeStates.analyze_results,
      status: "completed",
      updatedAt: new Date().toISOString()
    };
    downstreamRun.graph.nodeStates.figure_audit = {
      ...downstreamRun.graph.nodeStates.figure_audit,
      status: "needs_approval",
      updatedAt: new Date().toISOString()
    };
    downstreamRun.graph.pendingTransition = {
      ...makeDesignTransition(),
      sourceNode: "figure_audit",
      reason: "The figure audit requires a downstream repair decision."
    };
    const orchestrator = makeOrchestrator();
    orchestrator.approveCurrent.mockImplementationOnce(async () => {
      await runStore.updateRun(downstreamRun);
      await writeHumanInterventionRequest({
        workspaceRoot,
        run: downstreamRun,
        runContext,
        request: downstreamRequest
      });
      return downstreamRun;
    });
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "approve_current"
    );

    expect(result.status).toBe("resumed");
    expect(orchestrator.approveCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(downstreamRequest);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toHaveLength(1);
  });

  it("reconciles an applied upstream commit without clearing or overwriting a downstream journal", async () => {
    const run = await createRun(runStore);
    run.graph.pendingTransition = makeAdvanceTransition();
    run.graph.checkpointSeq += 1;
    await runStore.updateRun(run);
    const upstreamRequest = makeRequest("approve_current");
    const downstreamRequest = createHumanInterventionRequest({
      sourceNode: "figure_audit",
      kind: "transition_choice",
      title: "Review the downstream figure transition",
      question: "Should the audited transition advance to review?",
      context: [],
      inputMode: "free_text",
      resumeAction: "approve_current"
    });
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, upstreamRequest);
    const downstreamTransition: TransitionRecommendation = {
      action: "advance",
      sourceNode: "figure_audit",
      targetNode: "review",
      reason: "The audited figures are ready for review.",
      confidence: 0.93,
      autoExecutable: true,
      evidence: ["The figure audit completed its checks."],
      suggestedCommands: ["/agent run review"],
      generatedAt: new Date().toISOString()
    };
    const downstreamRun = structuredClone(run);
    downstreamRun.status = "paused";
    downstreamRun.currentNode = "figure_audit";
    downstreamRun.graph.currentNode = "figure_audit";
    downstreamRun.graph.checkpointSeq += 1;
    downstreamRun.graph.nodeStates.analyze_results = {
      ...downstreamRun.graph.nodeStates.analyze_results,
      status: "completed",
      updatedAt: new Date().toISOString()
    };
    downstreamRun.graph.nodeStates.figure_audit = {
      ...downstreamRun.graph.nodeStates.figure_audit,
      status: "needs_approval",
      updatedAt: new Date().toISOString()
    };
    downstreamRun.graph.pendingTransition = downstreamTransition;
    const completedDownstreamRun = structuredClone(downstreamRun);
    completedDownstreamRun.status = "running";
    completedDownstreamRun.currentNode = "review";
    completedDownstreamRun.graph.currentNode = "review";
    completedDownstreamRun.graph.checkpointSeq += 1;
    completedDownstreamRun.graph.nodeStates.figure_audit = {
      ...completedDownstreamRun.graph.nodeStates.figure_audit,
      status: "completed",
      updatedAt: new Date().toISOString()
    };
    completedDownstreamRun.graph.pendingTransition = undefined;
    const orchestrator = makeOrchestrator();
    orchestrator.approveCurrent
      .mockImplementationOnce(async () => {
        await runStore.updateRun(downstreamRun);
        await writeHumanInterventionRequest({
          workspaceRoot,
          run: downstreamRun,
          runContext,
          request: downstreamRequest
        });
        return downstreamRun;
      })
      .mockImplementationOnce(async () => {
        await runStore.updateRun(completedDownstreamRun);
        return completedDownstreamRun;
      });
    const originalPut = RunContextMemory.prototype.put;
    let failed = false;
    const putSpy = vi.spyOn(RunContextMemory.prototype, "put").mockImplementation(function (
      key,
      value
    ) {
      if (!failed && key === HUMAN_INTERVENTION_HISTORY_KEY) {
        failed = true;
        return Promise.reject(new Error("upstream history persistence failed"));
      }
      return originalPut.call(this, key, value);
    });
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    await expect(
      supervisor.answerHumanIntervention(run.id, upstreamRequest, "approve_current")
    ).rejects.toThrow("upstream history persistence failed");
    expect(orchestrator.approveCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(downstreamRequest);
    expect(JSON.parse(await fs.readFile(
      answerCommitPath(workspaceRoot, run.id, upstreamRequest.id),
      "utf8"
    ))).toMatchObject({ status: "action_applied" });

    putSpy.mockRestore();
    const reloadedSupervisor = new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    );
    const persistedDownstreamRun = await runStore.getRun(run.id);
    expect(persistedDownstreamRun).toBeDefined();
    const active = await reloadedSupervisor.getActiveRequest(persistedDownstreamRun!);

    expect(active).toEqual(downstreamRequest);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(downstreamRequest);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toEqual([
      expect.objectContaining({ requestId: upstreamRequest.id })
    ]);
    expect(JSON.parse(await fs.readFile(
      answerCommitPath(workspaceRoot, run.id, upstreamRequest.id),
      "utf8"
    ))).toMatchObject({ status: "committed" });

    const downstreamResult = await reloadedSupervisor.answerHumanIntervention(
      run.id,
      downstreamRequest,
      "approve_current"
    );

    expect(downstreamResult.status).toBe("resumed");
    expect(orchestrator.approveCurrent).toHaveBeenCalledTimes(2);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toEqual([
      expect.objectContaining({ requestId: upstreamRequest.id }),
      expect.objectContaining({ requestId: downstreamRequest.id })
    ]);
    await expect(fs.readFile(
      answerCommitPath(workspaceRoot, run.id, upstreamRequest.id),
      "utf8"
    )).resolves.toContain('"status": "committed"');
    await expect(fs.readFile(
      answerCommitPath(workspaceRoot, run.id, downstreamRequest.id),
      "utf8"
    )).resolves.toContain('"status": "committed"');
  });

  it("commits a durable retry that is paused by the budget guard", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const budgetPausedRun = structuredClone(run);
    budgetPausedRun.status = "paused";
    budgetPausedRun.graph.checkpointSeq += 1;
    budgetPausedRun.graph.retryCounters.analyze_results =
      (budgetPausedRun.graph.retryCounters.analyze_results ?? 0) + 1;
    budgetPausedRun.graph.pendingTransition = undefined;
    budgetPausedRun.graph.nodeStates.analyze_results = {
      ...budgetPausedRun.graph.nodeStates.analyze_results,
      status: "pending",
      updatedAt: new Date().toISOString(),
      note: "Budget guard paused the durable manual retry."
    };
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockImplementationOnce(async () => {
      await runStore.updateRun(budgetPausedRun);
      return budgetPausedRun;
    });
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(run.id, request, "retry_current");

    expect(result.status).toBe("resumed");
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toHaveLength(1);
  });

  it("commits an actual runtime retry when the retry counter is already saturated", async () => {
    const run = await createRun(runStore);
    run.graph.retryPolicy.maxAttemptsPerNode = 1;
    run.graph.retryCounters.analyze_results = 1;
    await runStore.updateRun(run);
    const checkpointBefore = run.graph.checkpointSeq;
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeActualOrchestrator(workspaceRoot, runStore);
    const retrySpy = vi.spyOn(orchestrator, "retryCurrent");
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "retry_current"
    );
    const persisted = await runStore.getRun(run.id);

    expect(result.status).toBe("resumed");
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(persisted?.graph.retryCounters.analyze_results).toBe(1);
    expect(persisted?.graph.checkpointSeq).toBeGreaterThan(checkpointBefore);
    expect(persisted?.graph.nodeStates.analyze_results.status).toBe("running");
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toHaveLength(1);
  });

  it("commits an actual runtime retry_same transition when the retry counter is saturated", async () => {
    const run = await createRun(runStore);
    const recommendation: TransitionRecommendation = {
      action: "retry_same",
      sourceNode: "analyze_results",
      targetNode: "analyze_results",
      reason: "Retry the current analysis with the declared bounded correction.",
      confidence: 0.94,
      autoExecutable: true,
      evidence: ["The analysis correction remains within the declared contract."],
      suggestedCommands: ["/agent retry"],
      generatedAt: new Date().toISOString()
    };
    run.graph.retryPolicy.maxAttemptsPerNode = 1;
    run.graph.retryCounters.analyze_results = 1;
    run.graph.pendingTransition = recommendation;
    run.graph.checkpointSeq += 1;
    await runStore.updateRun(run);
    const checkpointBefore = run.graph.checkpointSeq;
    const request = makeRequest("apply_transition");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeActualOrchestrator(workspaceRoot, runStore);
    const applySpy = vi.spyOn(orchestrator, "applyPendingTransition");
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "apply_transition"
    );
    const persisted = await runStore.getRun(run.id);

    expect(result.status).toBe("resumed");
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(persisted?.graph.retryCounters.analyze_results).toBe(1);
    expect(persisted?.graph.checkpointSeq).toBeGreaterThan(checkpointBefore);
    expect(persisted?.graph.nodeStates.analyze_results.status).toBe("running");
    expect(persisted?.graph.pendingTransition).toBeUndefined();
    expect(persisted?.graph.transitionHistory.at(-1)).toMatchObject({
      action: recommendation.action,
      sourceNode: recommendation.sourceNode,
      fromNode: "analyze_results",
      toNode: recommendation.targetNode,
      reason: recommendation.reason
    });
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toHaveLength(1);
  });

  it("rejects approve_current when it bypasses a prepared backtrack recommendation", async () => {
    const run = await createRun(runStore);
    run.graph.pendingTransition = makeDesignTransition();
    run.graph.checkpointSeq += 1;
    await runStore.updateRun(run);
    const request = makeRequest("approve_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const bypassedRun = structuredClone(run);
    bypassedRun.status = "running";
    bypassedRun.currentNode = "figure_audit";
    bypassedRun.graph.currentNode = "figure_audit";
    bypassedRun.graph.pendingTransition = undefined;
    bypassedRun.graph.checkpointSeq += 1;
    bypassedRun.graph.nodeStates.analyze_results = {
      ...bypassedRun.graph.nodeStates.analyze_results,
      status: "completed",
      updatedAt: new Date().toISOString()
    };
    const orchestrator = makeOrchestrator();
    orchestrator.approveCurrent.mockResolvedValue(bypassedRun);
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "approve_current"
    );

    expect(result.status).toBe("invalid_answer");
    expect(orchestrator.approveCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it.each([
    {
      label: "the continued run fails downstream",
      mutate: (run: Awaited<ReturnType<typeof createRun>>) => {
        run.status = "failed";
        run.graph.nodeStates.figure_audit = {
          ...run.graph.nodeStates.figure_audit,
          status: "failed",
          updatedAt: new Date().toISOString(),
          lastError: "Downstream execution failed after approval."
        };
      }
    },
    {
      label: "the continued run advances beyond the immediate successor",
      mutate: (run: Awaited<ReturnType<typeof createRun>>) => {
        run.currentNode = "write_paper";
        run.graph.currentNode = "write_paper";
        run.graph.checkpointSeq += 2;
      }
    }
  ])("commits a durable approval when $label", async ({ mutate }) => {
    const run = await createRun(runStore);
    const request = makeRequest("approve_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const approvedRun = appliedRunFor(run, "approve_current");
    mutate(approvedRun);
    const orchestrator = makeOrchestrator();
    orchestrator.approveCurrent.mockResolvedValue(approvedRun);
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const result = await supervisor.answerHumanIntervention(
      run.id,
      request,
      "approve_current"
    );

    expect(result.status).toBe("resumed");
    expect(orchestrator.approveCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toHaveLength(1);
  });

  it.each([
    "retry_current",
    "apply_transition"
  ] as const)(
    "fails closed after a partially changed normal return from %s",
    async (resumeAction) => {
      const run = await createRun(runStore);
      if (resumeAction === "apply_transition") {
        run.graph.pendingTransition = makeDesignTransition();
        run.graph.checkpointSeq += 1;
        await runStore.updateRun(run);
      }
      const request = makeRequest(resumeAction);
      const runContext = contextFor(workspaceRoot, run.id);
      await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
      const orchestrator = makeOrchestrator();
      const action = selectedAction(orchestrator, resumeAction);
      action.mockImplementationOnce(async () => {
        const partiallyChangedRun = structuredClone(run);
        partiallyChangedRun.graph.checkpointSeq += 1;
        if (resumeAction === "apply_transition") {
          partiallyChangedRun.graph.pendingTransition = undefined;
        }
        await runStore.updateRun(partiallyChangedRun);
        return partiallyChangedRun;
      });
      const supervisor = new InteractiveRunSupervisor(
        workspaceRoot,
        runStore,
        orchestrator as never
      );

      const firstResult = await supervisor.answerHumanIntervention(
        run.id,
        request,
        answerFor(resumeAction)
      );

      expect(firstResult.status).toBe("invalid_answer");
      expect(firstResult.message).toContain("Recovery is required");
      expect(action).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await fs.readFile(
        answerCommitPath(workspaceRoot, run.id, request.id),
        "utf8"
      )))
        .toMatchObject({ status: "dispatching" });

      const reloadedSupervisor = new InteractiveRunSupervisor(
        workspaceRoot,
        runStore,
        orchestrator as never
      );
      const persistedRun = await runStore.getRun(run.id);
      expect(persistedRun).toBeDefined();
      const surfaced = await reloadedSupervisor.getActiveRequest(persistedRun!);
      expect(surfaced?.title).toContain("Recovery required");

      const secondResult = await reloadedSupervisor.answerHumanIntervention(
        run.id,
        request,
        answerFor(resumeAction)
      );

      expect(secondResult.status).toBe("invalid_answer");
      expect(secondResult.message).toContain("Recovery is required");
      expect(action).toHaveBeenCalledTimes(1);
      expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
      expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
    }
  );

  it("blocks a newer question while an older dispatch remains uncertain", async () => {
    const run = await createRun(runStore);
    const olderRequest = makeRequest("retry_current");
    const newerRequest = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, olderRequest);
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockImplementationOnce(async () => {
      const partiallyChangedRun = structuredClone(run);
      partiallyChangedRun.graph.checkpointSeq += 1;
      await runStore.updateRun(partiallyChangedRun);
      return partiallyChangedRun;
    });
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    const firstResult = await supervisor.answerHumanIntervention(
      run.id,
      olderRequest,
      "retry_current"
    );
    expect(firstResult.status).toBe("invalid_answer");
    expect(firstResult.message).toContain("Recovery is required");
    const partiallyChangedRun = await runStore.getRun(run.id);
    expect(partiallyChangedRun).toBeDefined();
    await writeHumanInterventionRequest({
      workspaceRoot,
      run: partiallyChangedRun!,
      runContext,
      request: newerRequest
    });

    const reloadedSupervisor = new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    );
    const surfaced = await reloadedSupervisor.getActiveRequest(partiallyChangedRun!);
    expect(surfaced).toEqual(expect.objectContaining({
      id: newerRequest.id,
      title: expect.stringContaining("Recovery required")
    }));

    const secondResult = await reloadedSupervisor.answerHumanIntervention(
      run.id,
      newerRequest,
      "retry_current"
    );
    expect(secondResult.status).toBe("invalid_answer");
    expect(secondResult.message).toContain("Recovery is required");
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(newerRequest);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
    await expect(fs.readFile(
      answerCommitPath(workspaceRoot, run.id, newerRequest.id),
      "utf8"
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "retry_current",
    "approve_current",
    "apply_transition",
    "jump"
  ] as const)("allows an explicit retry after unchanged %s rejection", async (resumeAction) => {
    const run = await createRun(runStore);
    if (resumeAction === "apply_transition") {
      run.graph.pendingTransition = makeDesignTransition();
      run.graph.checkpointSeq += 1;
      await runStore.updateRun(run);
    }
    const request = makeRequest(resumeAction);
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeOrchestrator();
    const action = selectedAction(orchestrator, resumeAction);
    action.mockRejectedValueOnce(new Error(`unchanged ${resumeAction} failure`));
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    await expect(
      supervisor.answerHumanIntervention(run.id, request, answerFor(resumeAction))
    ).rejects.toThrow(`unchanged ${resumeAction} failure`);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();

    action.mockResolvedValueOnce(appliedRunFor(run, resumeAction));
    const result = await new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    ).answerHumanIntervention(run.id, request, answerFor(resumeAction));

    expect(result.status).toBe("resumed");
    expect(action).toHaveBeenCalledTimes(2);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toHaveLength(1);
  });

  it("marks a post-prepare abort as safe to retry because dispatch never started", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeOrchestrator();
    let abortReads = 0;
    const stagedAbortSignal = {
      get aborted() {
        abortReads += 1;
        return abortReads >= 4;
      }
    } as AbortSignal;
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    await expect(
      supervisor.answerHumanIntervention(run.id, request, "retry_current", {
        abortSignal: stagedAbortSignal
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);

    orchestrator.retryCurrent.mockResolvedValueOnce(appliedRunFor(run, "retry_current"));
    const result = await new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    ).answerHumanIntervention(run.id, request, "retry_current");

    expect(result.status).toBe("resumed");
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
  });

  it("does not infer retry success from an unrelated checkpoint increase", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockImplementationOnce(async () => {
      const checkpointOnlyRun = structuredClone(run);
      checkpointOnlyRun.graph.checkpointSeq += 1;
      await runStore.updateRun(checkpointOnlyRun);
      throw new Error("retry failed after unrelated checkpoint");
    });
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    await expect(
      supervisor.answerHumanIntervention(run.id, request, "retry_current")
    ).rejects.toThrow("retry failed after unrelated checkpoint");

    const result = await new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    ).answerHumanIntervention(run.id, request, "retry_current");

    expect(result.status).toBe("invalid_answer");
    expect(result.message).toContain("Recovery is required");
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });

  it("serializes concurrent answers for one request and applies the action exactly once", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    let releaseAction!: () => void;
    let reportStarted!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const actionBarrier = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockImplementation(async () => {
      reportStarted();
      await actionBarrier;
      return appliedRunFor(run, "retry_current");
    });
    const firstSupervisor = new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    );
    const secondSupervisor = new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    );

    const first = firstSupervisor.answerHumanIntervention(run.id, request, "retry_current");
    await actionStarted;
    const second = secondSupervisor.answerHumanIntervention(run.id, request, "retry_current");
    releaseAction();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.status)).toEqual(["resumed", "invalid_answer"]);
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toHaveLength(1);
  });

  it("serializes two contenders after a separate SQLite lock process exits", async () => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const lockPath = resolveHumanInterventionRunLockPath(workspaceRoot, run.id);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const lockOwner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          "import Database from 'better-sqlite3';",
          "const database = new Database(process.argv[1]);",
          "database.exec('BEGIN IMMEDIATE');",
          "process.stdout.write('locked\\n');",
          "process.stdin.once('data', () => { database.close(); process.exit(0); });"
        ].join("\n"),
        lockPath
      ],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    await waitForChildOutput(lockOwner, "locked");
    let releaseAction!: () => void;
    let reportStarted!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const actionBarrier = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockImplementation(async () => {
      reportStarted();
      await actionBarrier;
      return appliedRunFor(run, "retry_current");
    });
    const firstSupervisor = new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    );
    const secondSupervisor = new InteractiveRunSupervisor(
      workspaceRoot,
      runStore,
      orchestrator as never
    );

    let results: Awaited<ReturnType<InteractiveRunSupervisor["answerHumanIntervention"]>>[];
    try {
      const resultsPromise = Promise.all([
        firstSupervisor.answerHumanIntervention(run.id, request, "retry_current"),
        secondSupervisor.answerHumanIntervention(run.id, request, "retry_current")
      ]);
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      expect(orchestrator.retryCurrent).not.toHaveBeenCalled();
      const ownerExited = waitForChildExit(lockOwner);
      lockOwner.stdin.write("release\n");
      await ownerExited;
      await actionStarted;
      releaseAction();
      results = await resultsPromise;
    } finally {
      if (lockOwner.exitCode === null) {
        lockOwner.kill();
        await waitForChildExit(lockOwner);
      }
    }

    expect(results.map((result) => result.status).sort()).toEqual([
      "invalid_answer",
      "resumed"
    ]);
    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toBeNull();
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toHaveLength(1);
    const artifacts = await listRunArtifacts(resolveAppPaths(workspaceRoot), run.id);
    expect(artifacts.some((artifact) => artifact.path.includes("lock"))).toBe(false);
  });

  it.each([
    { label: "cross-run", mutate: (journal: Record<string, unknown>) => ({ ...journal, runId: "other-run" }) },
    {
      label: "malformed snapshot",
      mutate: (journal: Record<string, unknown>) => ({
        ...journal,
        beforeAction: { ...(journal.beforeAction as Record<string, unknown>), checkpointSeq: "bad" }
      })
    },
    {
      label: "mismatched action binding",
      mutate: (journal: Record<string, unknown>) => ({
        ...journal,
        resumeAction: "jump",
        targetNode: "design_experiments"
      })
    }
  ])("fails closed for a $label answer journal", async ({ mutate }) => {
    const run = await createRun(runStore);
    const request = makeRequest("retry_current");
    const runContext = contextFor(workspaceRoot, run.id);
    await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, request);
    const orchestrator = makeOrchestrator();
    orchestrator.retryCurrent.mockRejectedValueOnce(new Error("retry failed"));
    const supervisor = new InteractiveRunSupervisor(workspaceRoot, runStore, orchestrator as never);

    await expect(
      supervisor.answerHumanIntervention(run.id, request, "retry_current")
    ).rejects.toThrow("retry failed");
    const commitPath = answerCommitPath(workspaceRoot, run.id, request.id);
    const journal = JSON.parse(await fs.readFile(commitPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(commitPath, `${JSON.stringify(mutate(journal), null, 2)}\n`, "utf8");

    await expect(
      new InteractiveRunSupervisor(
        workspaceRoot,
        runStore,
        orchestrator as never
      ).answerHumanIntervention(run.id, request, "retry_current")
    ).rejects.toThrow("human_intervention_commit_invalid");

    expect(orchestrator.retryCurrent).toHaveBeenCalledTimes(1);
    expect(await runContext.get(HUMAN_INTERVENTION_PENDING_KEY)).toEqual(request);
    expect(await runContext.get(HUMAN_INTERVENTION_HISTORY_KEY)).toBeUndefined();
  });
});

async function createRun(runStore: RunStore) {
  const run = await runStore.createRun({
    title: "Intervention commit safety",
    topic: "Configured evaluation topic",
    constraints: [],
    objectiveMetric: "unresolved objective"
  });
  run.status = "paused";
  run.currentNode = "analyze_results";
  run.graph.currentNode = "analyze_results";
  run.graph.nodeStates.analyze_results = {
    ...run.graph.nodeStates.analyze_results,
    status: "needs_approval",
    updatedAt: new Date().toISOString(),
    note: "Operator clarification required."
  };
  await runStore.updateRun(run);
  return run;
}

function makeRequest(resumeAction: HumanInterventionResumeAction): HumanInterventionRequest {
  return createHumanInterventionRequest({
    sourceNode: "analyze_results",
    kind: "objective_metric_clarification",
    title: "Clarify the objective metric",
    question: "Which bounded action should be applied?",
    context: [],
    inputMode: resumeAction === "jump" ? "single_choice" : "free_text",
    resumeAction,
    choices: resumeAction === "jump"
      ? [{
          id: "return_to_design",
          label: "Return to design",
          resumeAction: "jump",
          targetNode: "design_experiments"
        }]
      : undefined
  });
}

function answerFor(resumeAction: HumanInterventionResumeAction): string {
  return resumeAction === "jump" ? "return_to_design" : resumeAction;
}

function contextFor(workspaceRoot: string, runId: string): RunContextMemory {
  return new RunContextMemory(
    path.join(workspaceRoot, ".autolabos", "runs", runId, "memory", "run_context.json")
  );
}

function makeActualOrchestrator(
  workspaceRoot: string,
  runStore: RunStore
): AgentOrchestrator {
  const checkpointStore = new CheckpointStore(resolveAppPaths(workspaceRoot));
  const registry: GraphNodeRegistry = {
    get(nodeId) {
      throw new Error(`Unexpected node execution during retry fixture: ${nodeId}`);
    },
    list() {
      return [];
    }
  };
  const runtime = new StateGraphRuntime(
    runStore,
    registry,
    checkpointStore,
    new InMemoryEventStream()
  );
  return new AgentOrchestrator(runStore, runtime, checkpointStore);
}

function answerCommitPath(workspaceRoot: string, runId: string, requestId: string): string {
  const requestKey = createHash("sha256").update(requestId).digest("hex");
  return path.join(
    workspaceRoot,
    ".autolabos",
    "runs",
    runId,
    "human_intervention",
    "answer_commits",
    `${requestKey}.json`
  );
}

function appliedRunFor(
  run: Awaited<ReturnType<typeof createRun>>,
  resumeAction: HumanInterventionResumeAction
) {
  const applied = structuredClone(run);
  applied.status = "running";
  switch (resumeAction) {
    case "retry_current":
      applied.graph.checkpointSeq += 1;
      applied.graph.retryCounters.analyze_results =
        (applied.graph.retryCounters.analyze_results ?? 0) + 1;
      applied.graph.pendingTransition = undefined;
      applied.graph.nodeStates.analyze_results = {
        ...applied.graph.nodeStates.analyze_results,
        status: "running",
        updatedAt: new Date().toISOString(),
        note: "manual retry"
      };
      return applied;
    case "approve_current":
      applied.graph.checkpointSeq += 1;
      applied.graph.nodeStates.analyze_results = {
        ...applied.graph.nodeStates.analyze_results,
        status: "completed",
        updatedAt: new Date().toISOString()
      };
      applied.currentNode = "figure_audit";
      applied.graph.currentNode = "figure_audit";
      return applied;
    case "apply_transition": {
      const recommendation = run.graph.pendingTransition;
      if (!recommendation) {
        throw new Error("apply_transition fixture requires a pending transition");
      }
      applied.graph.transitionHistory = [
        ...(applied.graph.transitionHistory ?? []),
        {
          action: recommendation.action,
          sourceNode: recommendation.sourceNode,
          fromNode: run.currentNode,
          toNode: recommendation.targetNode,
          reason: recommendation.reason,
          confidence: recommendation.confidence,
          autoExecutable: recommendation.autoExecutable,
          appliedAt: new Date().toISOString()
        }
      ];
      applied.graph.pendingTransition = undefined;
      applied.currentNode = recommendation.targetNode ?? run.currentNode;
      applied.graph.currentNode = applied.currentNode;
      applied.graph.checkpointSeq += 1;
      applied.status = "paused";
      applied.graph.nodeStates[applied.currentNode] = {
        ...applied.graph.nodeStates[applied.currentNode],
        status: "pending",
        updatedAt: new Date().toISOString(),
        note: "transition applied"
      };
      return applied;
    }
    case "jump":
      applied.currentNode = "design_experiments";
      applied.graph.currentNode = "design_experiments";
      applied.graph.checkpointSeq += 1;
      applied.status = "paused";
      applied.graph.nodeStates.design_experiments = {
        ...applied.graph.nodeStates.design_experiments,
        status: "pending",
        updatedAt: new Date().toISOString(),
        note: "manual safe jump"
      };
      return applied;
  }
}

function makeDesignTransition() {
  return {
    action: "backtrack_to_design" as const,
    sourceNode: "analyze_results" as const,
    targetNode: "design_experiments" as const,
    reason: "The comparison contract needs revision.",
    confidence: 0.9,
    autoExecutable: true,
    evidence: ["The current analysis cannot support the comparison."],
    suggestedCommands: ["/agent run design_experiments"],
    generatedAt: new Date().toISOString()
  };
}

function makeAdvanceTransition(): TransitionRecommendation {
  return {
    action: "advance",
    sourceNode: "analyze_results",
    targetNode: "figure_audit",
    reason: "The analysis is ready for figure audit.",
    confidence: 0.95,
    autoExecutable: true,
    evidence: ["The analysis contract passed."],
    suggestedCommands: ["/agent run figure_audit"],
    generatedAt: new Date().toISOString()
  };
}

function transitionReceipt(
  run: Awaited<ReturnType<typeof createRun>>,
  recommendation: TransitionRecommendation
) {
  return {
    action: recommendation.action,
    sourceNode: recommendation.sourceNode,
    fromNode: run.currentNode,
    toNode: recommendation.targetNode,
    reason: recommendation.reason,
    confidence: recommendation.confidence,
    autoExecutable: recommendation.autoExecutable,
    appliedAt: new Date().toISOString()
  };
}

function waitForChildOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Lock owner exited before readiness (code ${code ?? "unknown"}).`));
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

function makeOrchestrator() {
  return {
    retryCurrent: vi.fn(),
    approveCurrent: vi.fn(),
    applyPendingTransition: vi.fn(),
    jumpToNode: vi.fn()
  };
}

function selectedAction(
  orchestrator: ReturnType<typeof makeOrchestrator>,
  resumeAction: HumanInterventionResumeAction
) {
  switch (resumeAction) {
    case "retry_current":
      return orchestrator.retryCurrent;
    case "approve_current":
      return orchestrator.approveCurrent;
    case "apply_transition":
      return orchestrator.applyPendingTransition;
    case "jump":
      return orchestrator.jumpToNode;
  }
}
