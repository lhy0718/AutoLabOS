import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveAppPaths, ensureScaffold } from "../src/config.js";
import { InteractionSession } from "../src/interaction/InteractionSession.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { createHumanInterventionRequest } from "../src/core/humanIntervention.js";
import { RunStore } from "../src/core/runs/runStore.js";
import { InMemoryEventStream, PersistedEventStream } from "../src/core/events.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { RunRecord } from "../src/types.js";
import { AutonomousRunController } from "../src/core/agents/autonomousRunController.js";
import * as delegationContract from "../src/governance/delegationContract.js";

function makeRun(id: string): RunRecord {
  const now = new Date().toISOString();
  const graph = createDefaultGraphState();
  return {
    version: 3,
    workflowVersion: 3,
    id,
    title: `Run ${id}`,
    topic: "topic",
    constraints: ["declared literature scope"],
    objectiveMetric: "metric",
    status: "pending",
    currentNode: graph.currentNode,
    latestSummary: undefined,
    nodeThreads: {},
    createdAt: now,
    updatedAt: now,
    graph,
    memoryRefs: {
      runContextPath: `.autolabos/runs/${id}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${id}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${id}/memory/episodes.jsonl`
    }
  };
}

function makeNeutralResultsArtifact() {
  return {
    schema_version: "2.0",
    metrics: [
      { id: "primary_score", label: "Primary score", direction: "higher_better", unit: "score" }
    ],
    series: [
      {
        id: "reference_condition",
        label: "Reference condition",
        role: "baseline",
        dimensions: { condition: "reference" }
      },
      {
        id: "candidate_condition",
        label: "Candidate condition",
        role: "primary",
        dimensions: { condition: "candidate" }
      }
    ],
    observations: [
      {
        id: "reference_observation",
        series_id: "reference_condition",
        metric_id: "primary_score",
        scope: { partition: "validation_partition" },
        value: 0.76,
        evidence_refs: ["metrics.json"]
      },
      {
        id: "candidate_observation",
        series_id: "candidate_condition",
        metric_id: "primary_score",
        scope: { partition: "validation_partition" },
        value: 0.81,
        evidence_refs: ["metrics.json"]
      }
    ],
    comparisons: [
      {
        id: "candidate_vs_reference",
        subject_observation_id: "candidate_observation",
        reference_observation_id: "reference_observation",
        delta: 0.05,
        judgement: "candidate higher than reference",
        evidence_refs: ["metrics.json"]
      }
    ]
  };
}

function makeDoctorSessionConfig(
  llmMode: "codex" | "codex_chatgpt_only" | "openai_api" | "ollama",
  chatModel: string
): any {
  return {
    version: 1,
    project_name: "doctor-session-fixture",
    providers: {
      llm_mode: llmMode,
      codex: {
        model: "configured-research-slot",
        chat_model: chatModel,
        reasoning_effort: "low",
        fast_mode: false,
        auth_required: true
      },
      openai: {
        model: "configured-api-slot",
        reasoning_effort: "low",
        api_key_required: true
      }
    },
    workflow: {
      mode: "agent_approval",
      wizard_enabled: true,
      approval_mode: "minimal",
      execution_approval_mode: "manual"
    },
    experiments: {
      candidate_isolation: "attempt_snapshot_restore",
      network_policy: "blocked"
    },
    papers: { max_results: 10, per_second_limit: 1 },
    paper: { template: "acl", build_pdf: false, latex_engine: "none", validation_mode: "default" },
    research: { default_topic: "", default_constraints: [], default_objective_metric: "" },
    paths: { runs_dir: ".autolabos/runs", logs_dir: ".autolabos/logs" }
  };
}

describe("InteractionSession", () => {
  let cwd: string;
  let runStore: RunStore;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-session-"));
    const paths = resolveAppPaths(cwd);
    await ensureScaffold(paths);
    runStore = new RunStore(paths);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates runs through the shared session and selects the new run", async () => {
    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {
        generateTitle: vi.fn().mockResolvedValue("Generated title")
      } as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();

    const run = await session.createRun({
      topic: "Candidate evaluation",
      constraints: ["declared literature scope"],
      objectiveMetric: "primary_score"
    });

    expect(run.title).toBe("Generated title");
    expect(session.snapshot().activeRunId).toBe(run.id);
    expect(session.snapshot().logs.some((line) => line.includes(`Created run ${run.id}`))).toBe(true);
  });

  it("keeps default doctor provider-call-free and explicitly probes the configured chat slot", async () => {
    const probeChatCompatibility = vi.fn().mockResolvedValue({
      status: "request_rejected",
      ignoredMarker: "response-body-marker"
    });
    const config = makeDoctorSessionConfig("codex", "configured-chat-slot");
    const originalConfig = structuredClone(config);
    const session = new InteractionSession({
      workspaceRoot: cwd,
      config,
      runStore,
      titleGenerator: {} as any,
      codex: {
        checkEnvironmentReadiness: vi.fn().mockResolvedValue([]),
        probeChatCompatibility
      } as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();

    await session.submitInput("/doctor");
    expect(probeChatCompatibility).not.toHaveBeenCalled();

    const result = await session.submitInput("/doctor --live-provider");
    expect(probeChatCompatibility).toHaveBeenCalledTimes(1);
    expect(probeChatCompatibility).toHaveBeenCalledWith({
      model: "configured-chat-slot",
      timeoutMs: undefined,
      abortSignal: expect.any(AbortSignal)
    });
    expect(config).toEqual(originalConfig);
    expect(result.logs.join("\n")).not.toContain("configured-chat-slot");
    expect(result.logs.join("\n")).not.toContain("response-body-marker");
    expect(result.logs.join("\n")).toContain("provider_request_rejected");
  });

  it("rejects invalid or unsupported web-session doctor probes before the provider call", async () => {
    const probeChatCompatibility = vi.fn();
    const codexSession = new InteractionSession({
      workspaceRoot: cwd,
      config: makeDoctorSessionConfig("codex_chatgpt_only", "configured-chat-slot"),
      runStore,
      titleGenerator: {} as any,
      codex: { probeChatCompatibility } as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await codexSession.start();

    const invalid = await codexSession.submitInput("/doctor --live-provider extra");
    expect(probeChatCompatibility).not.toHaveBeenCalled();
    expect(invalid.logs).toContain("Unknown /doctor option. Usage: /doctor [--live-provider]");
    expect(invalid.logs.join("\n")).not.toContain("extra");

    const unsupportedSession = new InteractionSession({
      workspaceRoot: cwd,
      config: makeDoctorSessionConfig("openai_api", "configured-chat-slot"),
      runStore,
      titleGenerator: {} as any,
      codex: { probeChatCompatibility } as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await unsupportedSession.start();

    const unsupported = await unsupportedSession.submitInput("/doctor --live-provider");
    expect(probeChatCompatibility).not.toHaveBeenCalled();
    expect(unsupported.logs).toContain(
      "Live provider compatibility check requires a configured Codex chat provider."
    );
  });

  it("starts a run in the background without holding the caller open", async () => {
    let finishRun: ((value: {
      run: RunRecord;
      result: { status: "success"; summary: string };
    }) => void) | undefined;
    const run = await runStore.createRun({
      title: "Background start",
      topic: "Candidate evaluation",
      constraints: ["declared literature scope"],
      objectiveMetric: "primary_score"
    });
    const runCurrentAgentWithOptions = vi.fn(
      () =>
        new Promise<{
          run: RunRecord;
          result: { status: "success"; summary: string };
        }>((resolve) => {
          finishRun = resolve;
        })
    );
    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: { runCurrentAgentWithOptions } as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();

    expect(session.startRunInBackground(run.id)).toBe(true);
    expect(session.snapshot()).toMatchObject({
      activeRunId: run.id,
      busy: true,
      canCancel: true
    });
    expect(session.startRunInBackground(run.id)).toBe(false);
    await vi.waitFor(() => {
      expect(runCurrentAgentWithOptions).toHaveBeenCalledTimes(1);
    });

    finishRun?.({
      run,
      result: { status: "success", summary: "Background run finished." }
    });
    await vi.waitFor(() => {
      expect(session.snapshot().busy).toBe(false);
    });
    expect(session.snapshot().logs).toContain("Research start result: Background run finished.");
  });

  it("fails closed before title generation when required research inputs are missing", async () => {
    const generateTitle = vi.fn().mockResolvedValue("unused title");
    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: { research: { default_topic: "", default_constraints: [], default_objective_metric: "" } } as any,
      runStore,
      titleGenerator: { generateTitle } as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();

    await expect(session.createRun({
      topic: " ",
      constraints: [],
      objectiveMetric: ""
    })).rejects.toThrow("Research run input is incomplete: topic, constraints, objectiveMetric");
    expect(generateTitle).not.toHaveBeenCalled();
    await expect(runStore.listRuns()).resolves.toEqual([]);
  });

  it("reads repository knowledge for the active run via /knowledge", async () => {
    const run = await runStore.createRun({
      title: "Knowledge run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "primary_score"
    });
    const runDir = path.join(cwd, ".autolabos", "runs", run.id);
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(path.join(cwd, ".autolabos", "knowledge"), { recursive: true });
    await fs.writeFile(
      path.join(runDir, "corpus.jsonl"),
      [
        JSON.stringify({ paper_id: "p1", title: "Paper one", citation_count: 12, pdf_url: "https://example.com/p1.pdf", bibtex: "@article{p1}", venue: "NeurIPS", year: 2024 }),
        JSON.stringify({ paper_id: "p2", title: "Paper two", citation_count: 4, venue: "ICLR", year: 2025 })
      ].join("\n") + "\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(runDir, "collect_result.json"),
      JSON.stringify({ bibtexMode: "hybrid", pdfRecovered: 1, bibtexEnriched: 1, enrichment: { status: "completed" } }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(runDir, "paper_summaries.jsonl"),
      JSON.stringify({ paper_id: "p1", title: "Paper one", source_type: "full_text", summary: "summary", key_findings: [], limitations: [], datasets: [], metrics: [], novelty: "", reproducibility_notes: [] }) + "\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(runDir, "evidence_store.jsonl"),
      JSON.stringify({ evidence_id: "e1", paper_id: "p1", claim: "claim", method_slot: "", result_slot: "", limitation_slot: "", dataset_slot: "", metric_slot: "", evidence_span: "span", source_type: "full_text", confidence: 0.9 }) + "\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(cwd, ".autolabos", "knowledge", "index.json"),
      JSON.stringify(
        {
          version: 1,
          updated_at: "2026-03-23T00:00:00.000Z",
          entries: [
            {
              run_id: run.id,
              title: run.title,
              topic: run.topic,
              objective_metric: run.objectiveMetric,
              latest_summary: "Review ready.",
              latest_published_section: "review",
              updated_at: "2026-03-23T00:00:00.000Z",
              public_output_root: `outputs/${run.id}`,
              public_manifest: `outputs/${run.id}/manifest.json`,
              knowledge_note: `.autolabos/knowledge/runs/${run.id}.md`,
              research_question: "Does the candidate condition outperform the reference condition?",
              analysis_summary: "The candidate condition improved primary_score over the reference condition.",
              manuscript_type: "paper_scale_candidate",
              sections: [
                {
                  name: "review",
                  generated_files: ["review/review_packet.json"],
                  updated_at: "2026-03-23T00:00:00.000Z"
                }
              ]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const result = await session.submitInput("/knowledge");

    expect(result.logs.some((line) => line.includes(`Knowledge entry: ${run.id}`))).toBe(true);
    expect(result.logs.some((line) => line.includes("Research question: Does the candidate condition outperform the reference condition?"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Analysis summary: The candidate condition improved primary_score over the reference condition."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Literature corpus: 2 paper(s), 1 with PDF, 1 with BibTeX"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Analysis coverage: 1 summaries, 1 evidence rows"))).toBe(true);
  });

  it("previews manuscript-quality artifacts via /artifact", async () => {
    const run = await runStore.createRun({
      title: "Artifact run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    run.currentNode = "write_paper";
    run.graph.currentNode = "write_paper";
    run.status = "paused";
    await runStore.updateRun(run);

    const runDir = path.join(cwd, ".autolabos", "runs", run.id);
    await fs.mkdir(path.join(runDir, "paper"), { recursive: true });
    await fs.writeFile(
      path.join(runDir, "paper", "manuscript_quality_gate.json"),
      JSON.stringify(
        {
          action: "pass",
          pass_index: 0,
          triggered_by: [],
          allowed_max_passes: 2,
          remaining_allowed_repairs: 2,
          improvement_detected: true,
          stop_or_continue_reason: "Clean manuscript quality pass.",
          issues_before: [],
          issues_after: [],
          summary_lines: ["Manuscript quality passed on the initial gate."],
          decision_digest: {
            stage: "initial_gate",
            action: "pass",
            review_reliability: "grounded",
            issue_counts_before: 0,
            issue_counts_after: 0,
            improvement_detected: true,
            allowed_max_passes: 2,
            remaining_allowed_repairs: 2,
            triggered_by: [],
            stop_reason_category: "clean_pass"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const result = await session.submitInput("/artifact paper/manuscript_quality_gate.json");

    expect(result.logs.some((line) => line.includes(`Artifact preview (${run.id}): paper/manuscript_quality_gate.json`))).toBe(true);
    expect(result.logs.some((line) => line.includes('"action": "pass"'))).toBe(true);
  });
  it("keeps the active run stable while inspecting another run", async () => {
    const activeRun = await runStore.createRun({
      title: "Active scope",
      topic: "active scope",
      constraints: [],
      objectiveMetric: "primary metric"
    });
    const inspectedRun = await runStore.createRun({
      title: "Inspected scope",
      topic: "inspected scope",
      constraints: [],
      objectiveMetric: "primary metric"
    });
    inspectedRun.currentNode = "analyze_results";
    inspectedRun.graph.currentNode = "analyze_results";
    inspectedRun.graph.nodeStates.analyze_results.status = "completed";
    inspectedRun.status = "paused";
    await runStore.updateRun(inspectedRun);

    const inspectedRunDir = path.join(cwd, ".autolabos", "runs", inspectedRun.id);
    await fs.mkdir(inspectedRunDir, { recursive: true });
    await fs.writeFile(
      path.join(inspectedRunDir, "inspection.json"),
      JSON.stringify({ source: "inspected run" }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(inspectedRunDir, "result_analysis.json"),
      JSON.stringify({
        overview: {
          objective_status: "met",
          objective_summary: "The inspected run reached its bounded objective."
        },
        failure_taxonomy: [],
        synthesis: { follow_up_actions: [] }
      }, null, 2),
      "utf8"
    );

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "primary metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(activeRun.id);

    const artifactResult = await session.submitInput(
      `/artifact inspection.json --run ${inspectedRun.id}`
    );
    expect(artifactResult.logs.some((line) => line.includes(`Artifact preview (${inspectedRun.id})`))).toBe(true);
    expect(session.getActiveRunId()).toBe(activeRun.id);

    const analysisResult = await session.submitInput(`/analyze-results ${inspectedRun.id}`);
    expect(analysisResult.logs.some((line) => line.includes(`operator view for ${inspectedRun.id}`))).toBe(true);
    expect(session.getActiveRunId()).toBe(activeRun.id);
  });


  it("reports tune-node comparisons through /agent tune-node", async () => {
    const run = await runStore.createRun({
      title: "Tune run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      tuneNodeRunner: {
        run: vi.fn().mockResolvedValue({
          lines: [
            "ORIGINAL score: 0.55",
            "MUTANT score: 0.71",
            "DELTA: +0.16",
            "RECOMMENDATION: keep"
          ]
        })
      },
      semanticScholarApiKeyConfigured: true
    });
    await session.start();

    const result = await session.submitInput(`/agent tune-node generate_hypotheses ${run.id}`);

    expect(result.logs.some((line) => line.includes("ORIGINAL score: 0.55"))).toBe(true);
    expect(result.logs.some((line) => line.includes("MUTANT score: 0.71"))).toBe(true);
    expect(result.logs.some((line) => line.includes("RECOMMENDATION: keep"))).toBe(true);
  });

  it("writes delegation_contract.json before /agent overnight starts", async () => {
    const run = await runStore.createRun({
      title: "Overnight run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    vi.spyOn(AutonomousRunController.prototype, "runOvernight").mockResolvedValue({
      status: "completed",
      reason: "ok",
      iterations: 1,
      approvalsApplied: 0,
      transitionsApplied: 0
    } as any);

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();

    const result = await session.submitInput(`/agent overnight ${run.id}`);

    expect(result.logs.some((line) => line.includes("Overnight autonomy completed"))).toBe(true);
    const contractPath = path.join(cwd, ".autolabos", "runs", run.id, "delegation_contract.json");
    const written = JSON.parse(await fs.readFile(contractPath, "utf8"));
    expect(written.subagentId).toBe("overnight");
  });

  it("blocks overnight delegation when the contract is invalid", async () => {
    const run = await runStore.createRun({
      title: "Invalid overnight run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    vi.spyOn(delegationContract, "prepareDelegationContractForRun").mockResolvedValue({
      valid: false,
      errors: ["Delegation contract invalid."]
    });
    const overnightSpy = vi.spyOn(AutonomousRunController.prototype, "runOvernight").mockResolvedValue({
      status: "completed",
      reason: "ok",
      iterations: 1,
      approvalsApplied: 0,
      transitionsApplied: 0
    } as any);

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();

    const result = await session.submitInput(`/agent overnight ${run.id}`);

    expect(result.logs.some((line) => line.includes("Delegation blocked"))).toBe(true);
    expect(overnightSpy).not.toHaveBeenCalled();
    const contractPath = path.join(cwd, ".autolabos", "runs", run.id, "delegation_contract.json");
    await expect(fs.readFile(contractPath, "utf8")).rejects.toThrow();
  });

  it("projects operator jobs via /jobs without mutating the run record", async () => {
    const run = await runStore.createRun({
      title: "Jobs run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    run.currentNode = "review";
    run.graph.currentNode = "review";
    run.status = "paused";
    run.graph.nodeStates.analyze_results.status = "completed";
    run.graph.nodeStates.figure_audit.status = "completed";
    run.graph.nodeStates.review.status = "needs_approval";
    await runStore.updateRun(run);

    const runDir = path.join(cwd, ".autolabos", "runs", run.id);
    await fs.mkdir(path.join(runDir, "review"), { recursive: true });
    await fs.writeFile(path.join(runDir, "events.jsonl"), `${JSON.stringify({ timestamp: "2026-03-28T12:00:00.000Z" })}\n`, "utf8");
    await fs.writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify({
        results_artifact: makeNeutralResultsArtifact(),
        primary_comparison_id: "candidate_vs_reference",
        overview: { objective_status: "met", objective_summary: "objective met" }
      }, null, 2),
      "utf8"
    );
    await fs.writeFile(path.join(runDir, "transition_recommendation.json"), JSON.stringify({ action: "advance", targetNode: "review", reason: "Ready for review." }, null, 2), "utf8");
    await fs.writeFile(path.join(runDir, "review", "review_packet.json"), JSON.stringify({ generated_at: "", checks: [], readiness: { status: "ready", ready_checks: 1, warning_checks: 0, blocking_checks: 0, manual_checks: 1 }, objective_status: "met", objective_summary: "objective met", suggested_actions: [] }, null, 2), "utf8");
    await fs.writeFile(path.join(runDir, "review", "paper_critique.json"), JSON.stringify({ blocking_issues_count: 0, paper_readiness_state: "paper_scale_candidate" }, null, 2), "utf8");
    await fs.writeFile(path.join(runDir, "review", "minimum_gate.json"), JSON.stringify({ passed: true }, null, 2), "utf8");
    await fs.writeFile(path.join(runDir, "review", "readiness_risks.json"), JSON.stringify({ generated_at: "", paper_ready: false, readiness_state: "blocked_for_paper_scale", risk_count: 1, blocked_count: 1, warning_count: 0, risks: [{ risk_code: "review_blocked", severity: "blocked", category: "paper_scale", status: "blocked", message: "A baseline is still missing.", triggered_by: ["minimum_gate"], affected_claim_ids: [], affected_citation_ids: [], recommended_action: "Add a baseline.", recheck_condition: "A baseline exists." }], summary_lines: [] }, null, 2), "utf8");

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        },
        workflow: {
          approval_mode: "manual"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();

    const result = await session.submitInput("/jobs");

    expect(result.logs.some((line) => line.includes("Jobs view (1 run(s))"))).toBe(true);
    expect(result.logs.some((line) => line.includes(`readiness: analysis=yes review=yes paper=no | next=resume_review`))).toBe(true);
    expect(result.logs.some((line) => line.includes("Top failures:"))).toBe(true);
  });

  it("summarizes analyze_results and review entry readiness via /analyze-results", async () => {
    const run = await runStore.createRun({
      title: "Analyze helper run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "primary_score"
    });
    run.currentNode = "analyze_results";
    run.graph.currentNode = "analyze_results";
    run.status = "paused";
    run.graph.nodeStates.analyze_results.status = "completed";
    await runStore.updateRun(run);

    const runDir = path.join(cwd, ".autolabos", "runs", run.id);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify({
        mean_score: 8.2,
        overview: { objective_status: "met", objective_summary: "The primary score exceeded the reference target." },
        failure_taxonomy: [],
        synthesis: { follow_up_actions: ["Enter review and confirm the claim-evidence mapping."] },
        transition_recommendation: { action: "advance", targetNode: "review", reason: "Ready for the review gate." }
      }, null, 2),
      "utf8"
    );
    await fs.writeFile(path.join(runDir, "transition_recommendation.json"), JSON.stringify({ action: "advance", targetNode: "review", reason: "Ready for the review gate." }, null, 2), "utf8");

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        },
        workflow: {
          approval_mode: "minimal"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();

    const result = await session.submitInput(`/analyze-results ${run.id}`);

    expect(result.logs.some((line) => line.includes(`Analyze-results operator view for ${run.id}.`))).toBe(true);
    expect(result.logs.some((line) => line.includes("Readiness: analysis=yes, review=no, paper=no."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Next: resume_review."))).toBe(true);
    expect(result.logs.some((line) => line.includes(`/artifact result_analysis.json --run ${run.id}`))).toBe(true);
  });

  it("clears downstream artifacts and context when rewinding from an upstream node", async () => {
    const run = await runStore.createRun({
      title: "Reset run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    run.status = "paused";
    run.currentNode = "write_paper";
    run.graph.currentNode = "write_paper";
    run.graph.nodeStates.implement_experiments.status = "completed";
    run.graph.nodeStates.run_experiments.status = "completed";
    run.graph.nodeStates.analyze_results.status = "completed";
    run.graph.nodeStates.review.status = "completed";
    run.graph.nodeStates.write_paper.status = "completed";
    run.nodeThreads.implement_experiments = "thread-impl";
    run.nodeThreads.run_experiments = "thread-run";
    await runStore.updateRun(run);

    const runDir = path.join(cwd, ".autolabos", "runs", run.id);
    await fs.mkdir(path.join(runDir, "review"), { recursive: true });
    await fs.mkdir(path.join(runDir, "paper"), { recursive: true });
    await fs.writeFile(path.join(runDir, "experiment.py"), "print('ok')\n", "utf8");
    await fs.writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_score: 0.1 }, null, 2), "utf8");
    await fs.writeFile(path.join(runDir, "result_analysis.json"), JSON.stringify({ overview: {} }, null, 2), "utf8");
    await fs.writeFile(path.join(runDir, "review", "decision.json"), JSON.stringify({ outcome: "advance" }, null, 2), "utf8");
    await fs.writeFile(path.join(runDir, "paper", "main.tex"), "stale paper\n", "utf8");

    const runContext = new RunContextMemory(path.join(cwd, run.memoryRefs.runContextPath));
    await runContext.put("implement_experiments.script", "print('stale')");
    await runContext.put("run_experiments.feedback_for_implementer", { summary: "The operation was aborted" });
    await runContext.put("write_paper.paper_critique", {
      overall_decision: "backtrack_to_implement",
      needs_additional_experiments: true,
      manuscript_claim_risk_summary: "stale critique"
    });
    await runContext.put("analyze_results.last_summary", "stale analysis");
    await runContext.put("review.last_decision", { outcome: "advance" });

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const result = await session.submitInput(`/agent clear implement_experiments ${run.id}`);
    const persisted = await runStore.getRun(run.id);

    expect(result.logs.some((line) => line.includes("Run reset from implement_experiments (pending)."))).toBe(true);
    expect(await fs.stat(path.join(runDir, "experiment.py")).catch(() => undefined)).toBeUndefined();
    expect(await fs.stat(path.join(runDir, "metrics.json")).catch(() => undefined)).toBeUndefined();
    expect(await fs.stat(path.join(runDir, "result_analysis.json")).catch(() => undefined)).toBeUndefined();
    expect(await fs.stat(path.join(runDir, "review", "decision.json")).catch(() => undefined)).toBeUndefined();
    expect(await fs.stat(path.join(runDir, "paper", "main.tex")).catch(() => undefined)).toBeUndefined();
    expect(await runContext.get("implement_experiments.script")).toBeNull();
    expect(await runContext.get("run_experiments.feedback_for_implementer")).toBeNull();
    expect(await runContext.get("write_paper.paper_critique")).toBeNull();
    expect(await runContext.get("analyze_results.last_summary")).toBeNull();
    expect(await runContext.get("review.last_decision")).toBeNull();
    expect(persisted?.status).toBe("paused");
    expect(persisted?.currentNode).toBe("implement_experiments");
    expect(persisted?.graph.nodeStates.implement_experiments.status).toBe("pending");
    expect(persisted?.graph.nodeStates.write_paper.status).toBe("pending");
    expect(persisted?.nodeThreads.implement_experiments).toBeUndefined();
    expect(persisted?.nodeThreads.run_experiments).toBeUndefined();
  });

  it("preserves run_experiments metrics when clearing analyze_results", async () => {
    const run = await runStore.createRun({
      title: "Analyze reset run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    run.status = "paused";
    run.currentNode = "write_paper";
    run.graph.currentNode = "write_paper";
    run.graph.nodeStates.run_experiments.status = "completed";
    run.graph.nodeStates.analyze_results.status = "completed";
    run.graph.nodeStates.review.status = "completed";
    run.graph.nodeStates.write_paper.status = "completed";
    await runStore.updateRun(run);

    const runDir = path.join(cwd, ".autolabos", "runs", run.id);
    await fs.mkdir(path.join(runDir, "review"), { recursive: true });
    await fs.mkdir(path.join(runDir, "paper"), { recursive: true });
    await fs.writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_score: 0.1 }, null, 2), "utf8");
    await fs.writeFile(path.join(runDir, "objective_evaluation.json"), JSON.stringify({ status: "met" }, null, 2), "utf8");
    await fs.writeFile(path.join(runDir, "result_analysis.json"), JSON.stringify({ overview: {} }, null, 2), "utf8");
    await fs.writeFile(path.join(runDir, "transition_recommendation.json"), JSON.stringify({ action: "advance" }, null, 2), "utf8");
    await fs.writeFile(path.join(runDir, "review", "decision.json"), JSON.stringify({ outcome: "advance" }, null, 2), "utf8");
    await fs.writeFile(path.join(runDir, "paper", "main.tex"), "stale paper\n", "utf8");
    const runContext = new RunContextMemory(path.join(cwd, run.memoryRefs.runContextPath));
    await runContext.put("objective_metric.last_evaluation", { status: "met" });
    await runContext.put("write_paper.paper_critique", {
      overall_decision: "backtrack_to_implement",
      needs_additional_experiments: true
    });

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    await session.submitInput(`/agent clear analyze_results ${run.id}`);
    const persisted = await runStore.getRun(run.id);

    expect(await fs.readFile(path.join(runDir, "metrics.json"), "utf8")).toContain('"primary_score": 0.1');
    expect(await fs.readFile(path.join(runDir, "objective_evaluation.json"), "utf8")).toContain('"status": "met"');
    expect(await fs.stat(path.join(runDir, "result_analysis.json")).catch(() => undefined)).toBeUndefined();
    expect(await fs.stat(path.join(runDir, "transition_recommendation.json")).catch(() => undefined)).toBeUndefined();
    expect(await fs.stat(path.join(runDir, "review", "decision.json")).catch(() => undefined)).toBeUndefined();
    expect(await fs.stat(path.join(runDir, "paper", "main.tex")).catch(() => undefined)).toBeUndefined();
    expect(await runContext.get("objective_metric.last_evaluation")).toMatchObject({ status: "met" });
    expect(await runContext.get("write_paper.paper_critique")).toBeNull();
    expect(persisted?.currentNode).toBe("analyze_results");
    expect(persisted?.graph.nodeStates.run_experiments.status).toBe("completed");
    expect(persisted?.graph.nodeStates.analyze_results.status).toBe("pending");
    expect(persisted?.graph.nodeStates.write_paper.status).toBe("pending");
  });

  it("cancels a pending plan without executing any step", async () => {
    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        },
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: { model: "gpt-5.3-codex", reasoning_effort: "xhigh", fast_mode: false },
          openai: { model: "gpt-5.4", reasoning_effort: "medium" }
        },
        analysis: {
          responses_model: "gpt-5.4"
        },
        papers: { max_results: 100 }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    }) as any;
    await session.start();
    session.pendingNaturalCommand = {
      command: "/help",
      commands: ["/help"],
      sourceInput: "test",
      createdAt: new Date().toISOString(),
      stepIndex: 0,
      totalSteps: 1
    };

    const result = await session.respondToPending("cancel");

    expect(result.pendingPlan).toBeUndefined();
    expect(result.logs.some((line) => line.includes("Canceled pending command"))).toBe(true);
  });

  it("restores a pending human question for WebUI and keeps an ambiguous answer in follow-up state", async () => {
    const run = await runStore.createRun({
      title: "Pending operator question",
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
    const runContext = new RunContextMemory(path.join(cwd, run.memoryRefs.runContextPath));
    const request = createHumanInterventionRequest({
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
          resumeAction: "jump",
          targetNode: "design_experiments"
        }
      ]
    });
    await runContext.put("human_intervention.pending", request);

    const openAiTextClient = {
      runForText: vi.fn().mockResolvedValue(JSON.stringify({
        decision: "ask_followup",
        choice_id: "",
        normalized_answer: "",
        followup_question: "Should the run use the declared metric, or return to experiment design?",
        rationale: "The answer is ambiguous."
      }))
    };
    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          default_topic: "topic",
          default_constraints: ["declared literature scope"],
          default_objective_metric: "metric"
        },
        providers: {
          llm_mode: "openai_api",
          codex: { model: "configured_chat_model", reasoning_effort: "medium", fast_mode: false },
          openai: {
            model: "configured_chat_model",
            chat_model: "configured_chat_model",
            reasoning_effort: "medium",
            chat_reasoning_effort: "medium"
          }
        },
        analysis: { responses_model: "configured_analysis_model" },
        papers: { max_results: 100 }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: openAiTextClient as any,
      eventStream: new InMemoryEventStream(),
      orchestrator: {
        retryCurrent: vi.fn(),
        approveCurrent: vi.fn(),
        applyPendingTransition: vi.fn(),
        jumpToNode: vi.fn()
      } as any,
      semanticScholarApiKeyConfigured: true
    });

    await session.start();
    await session.selectRun(run.id);
    expect(session.snapshot().humanIntervention).toEqual(
      expect.objectContaining({
        runId: run.id,
        title: "Clarify the objective metric",
        choices: [expect.objectContaining({ id: "revise_design" })]
      })
    );

    const result = await session.submitInput("I am not sure yet.");

    expect(result.humanIntervention).toEqual(
      expect.objectContaining({
        question: expect.stringContaining("metric criterion"),
        conversationTurnCount: 1
      })
    );
    expect(result.logs.some((line) => line.includes("Follow-up required"))).toBe(true);
    expect(openAiTextClient.runForText).not.toHaveBeenCalled();
  });

  it("answers direct paper-count questions from stored artifacts", async () => {
    const run = await runStore.createRun({
      title: "Count run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    const runDir = path.join(cwd, ".autolabos", "runs", run.id);
    await fs.writeFile(
      path.join(runDir, "corpus.jsonl"),
      ['{"title":"Paper A"}', '{"title":"Paper B"}', '{"title":"Paper C"}'].join("\n"),
      "utf8"
    );
    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        },
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: { model: "gpt-5.3-codex", reasoning_effort: "xhigh", fast_mode: false },
          openai: { model: "gpt-5.4", reasoning_effort: "medium" }
        },
        analysis: {
          responses_model: "gpt-5.4"
        },
        papers: { max_results: 100 }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const result = await session.submitInput("수집된 논문은 몇건이지?");

    expect(result.logs.some((line) => line.includes("The current run has 3 collected papers."))).toBe(true);
  });

  it("shows structured analyze_results details in /agent count logs", async () => {
    const run = await runStore.createRun({
      title: "Analyze count run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    const current = await runStore.getRun(run.id);
    if (!current) {
      throw new Error("expected run");
    }
    current.status = "paused";
    current.currentNode = "analyze_results";
    current.graph.currentNode = "analyze_results";
    current.graph.nodeStates.analyze_results = {
      status: "completed",
      updatedAt: new Date().toISOString(),
      note: "Analysis completed."
    };
    await runStore.updateRun(current);
    const runDir = path.join(cwd, ".autolabos", "runs", run.id);
    await fs.mkdir(path.join(runDir, "figures"), { recursive: true });
    await fs.writeFile(path.join(runDir, "figures", "performance.svg"), "<svg></svg>", "utf8");
    await fs.writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_score: 0.81 }, null, 2), "utf8");
    await fs.writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify(
        {
          analysis_version: 1,
          generated_at: new Date().toISOString(),
          results_artifact: makeNeutralResultsArtifact(),
          primary_comparison_id: "candidate_vs_reference",
          mean_score: 0.81,
          metrics: { primary_score: 0.81 },
          objective_metric: {
            raw: "primary_score",
            evaluation: {
              status: "met",
              summary: "primary_score reached the configured target.",
              matchedMetricKey: "primary_score",
              observedValue: 0.81,
              targetDescription: "primary_score >= 0.8"
            },
            profile: {
              source: "heuristic",
              primary_metric: "primary_score",
              preferred_metric_keys: ["primary_score"],
              target_description: "primary_score >= 0.8",
              analysis_focus: ["primary_score"],
              paper_emphasis: ["primary_score"],
              assumptions: []
            }
          },
          overview: {
            objective_status: "met",
            objective_summary: "primary_score reached the configured target.",
            matched_metric_key: "primary_score",
            observed_value: 0.81,
            target_description: "primary_score >= 0.8",
            execution_runs: 3,
            top_metric: { key: "primary_score", value: 0.81 }
          },
          plan_context: {
            shortlisted_designs: [],
            design_notes: [],
            implementation_notes: [],
            evaluation_notes: [],
            assumptions: []
          },
          metric_table: [{ key: "primary_score", value: 0.81 }],
          condition_comparisons: [
            {
              id: "candidate_vs_reference",
              label: "Candidate condition vs reference condition",
              source: "metrics.comparison",
              metrics: [
                {
                  key: "primary_score",
                  value: 0.05,
                  primary_value: 0.81,
                  baseline_value: 0.76
                }
              ],
              hypothesis_supported: true,
              summary: "The candidate condition improved primary_score over the reference condition by 0.05."
            }
          ],
          execution_summary: {
            observation_count: 3,
            commands: ["python experiment.py"],
            sources: ["local_python"],
            stderr_excerpts: []
          },
          primary_findings: ["The candidate condition improved primary_score over the reference condition by 0.05."],
          limitations: ["Only one confirmatory configuration was executed."],
          warnings: [],
          paper_claims: [
            {
              claim: "The candidate condition improved the primary metric.",
              evidence: ["primary_score=0.81"]
            }
          ],
          figure_specs: [
            {
              id: "performance",
              title: "Performance overview",
              path: "figures/performance.svg",
              metric_keys: ["primary_score"],
              summary: "The primary score increased in the candidate condition."
            }
          ],
          supplemental_runs: [],
          external_comparisons: [],
          statistical_summary: {
            total_trials: 3,
            executed_trials: 3,
            cached_trials: 0,
            confidence_intervals: [
              {
                metric_key: "primary_score",
                label: "Primary score 95% CI",
                lower: 0.78,
                upper: 0.84,
                level: 0.95,
                sample_size: 3,
                source: "metrics",
                summary: "The primary score remained within a narrow 95% confidence interval across the observed trials."
              }
            ],
            stability_metrics: [{ key: "primary_score_std", value: 0.02 }],
            effect_estimates: [
              {
                comparison_id: "candidate_vs_reference",
                metric_key: "primary_score",
                delta: 0.05,
                direction: "positive",
                summary: "The candidate condition delivered a positive effect estimate of +0.05 primary_score versus the reference condition."
              }
            ],
            notes: ["Variance remained low across the observed trials."]
          },
          failure_taxonomy: [
            {
              id: "scope_limit",
              category: "scope_limit",
              severity: "medium",
              status: "risk",
              summary: "Only one confirmatory configuration was executed.",
              evidence: ["total_trials=3"],
              recommended_action: "Run an additional confirmatory configuration."
            }
          ],
          synthesis: {
            source: "fallback",
            discussion_points: ["The candidate condition cleared the objective threshold with limited run-to-run variance."],
            failure_analysis: ["No concrete execution failure was observed; scope remains the main uncertainty."],
            follow_up_actions: ["Run an additional confirmatory configuration."],
            confidence_statement: "Overall confidence is moderate because the metric cleared the target but only one confirmatory configuration was executed."
          },
          transition_recommendation: {
            action: "advance",
            sourceNode: "analyze_results",
            targetNode: "review",
            reason: "The objective is met and no blocking runtime issue remains, so the run can proceed to review before paper writing.",
            confidence: 0.88,
            autoExecutable: true,
            evidence: ["primary_score reached the configured target."],
            suggestedCommands: ["/approve"],
            generatedAt: new Date().toISOString()
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        },
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: { model: "gpt-5.3-codex", reasoning_effort: "xhigh", fast_mode: false },
          openai: { model: "gpt-5.4", reasoning_effort: "medium" }
        },
        analysis: {
          responses_model: "gpt-5.4"
        },
        papers: { max_results: 100 }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const result = await session.submitInput("/agent count analyze_results");
    const snapshot = session.snapshot();

    expect(result.logs.some((line) => line.includes("Count(analyze_results): 1 figure files"))).toBe(true);
    expect(result.logs.some((line) => line.includes("objective met"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Top issue [medium/risk]"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Discussion: The candidate condition cleared the objective threshold"))).toBe(
      true
    );
    expect(result.logs.some((line) => line.includes("Confidence: Overall confidence is moderate"))).toBe(true);
    expect(snapshot.activeRunInsight?.title).toBe("Result analysis");
    expect(snapshot.activeRunInsight?.lines.some((line) => line.includes("Objective: met"))).toBe(true);
    expect(snapshot.activeRunInsight?.lines.some((line) => line.includes("Recommendation: advance -> review"))).toBe(
      true
    );
    expect(snapshot.activeRunInsight?.lines.some((line) => line.includes("Next: Run an additional confirmatory configuration."))).toBe(
      true
    );
    expect(snapshot.activeRunInsight?.actions?.[0]?.command).toBe("/agent apply");
    expect(snapshot.activeRunInsight?.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "comparison",
          label: "Comparison: Candidate condition vs Reference condition",
          path: "result_analysis.json#/results_artifact/comparisons/0",
          summary: "Candidate condition vs Reference condition on Primary score: 0.81 vs 0.76 (delta 0.05). Judgement: candidate higher than reference.",
          facts: expect.arrayContaining([
            expect.objectContaining({ label: "Metric", value: "primary_score" }),
            expect.objectContaining({ label: "Delta", value: "+0.05" })
          ])
        }),
        expect.objectContaining({
          kind: "statistics",
          label: "Statistics: primary_score",
          path: "result_analysis.json#/results_artifact/comparisons/0",
          summary: "Candidate condition vs Reference condition on Primary score: 0.81 vs 0.76 (delta 0.05). Judgement: candidate higher than reference.",
          facts: expect.arrayContaining([
            expect.objectContaining({ label: "Metric", value: "primary_score" }),
            expect.objectContaining({ label: "Delta", value: "+0.05" })
          ])
        }),
        expect.objectContaining({
          kind: "figure",
          label: "Figure: Performance overview",
          path: "figures/performance.svg",
          summary: "The primary score increased in the candidate condition.",
          facts: expect.arrayContaining([
            expect.objectContaining({ label: "Matched metric", value: "primary_score" }),
            expect.objectContaining({ label: "Runs", value: "3" })
          ])
        }),
        expect.objectContaining({
          kind: "transition",
          label: "Transition rationale",
          path: "transition_recommendation.json",
          summary: "primary_score reached the configured target.",
          facts: expect.arrayContaining([
            expect.objectContaining({ label: "Confidence", value: "88%" }),
            expect.objectContaining({ label: "Target", value: "review" })
          ])
        }),
        expect.objectContaining({
          kind: "report",
          label: "Analysis report",
          path: "result_analysis.json",
          summary: expect.stringContaining("Overall confidence is moderate"),
          facts: expect.arrayContaining([
            expect.objectContaining({ label: "Mean", value: "0.81" }),
            expect.objectContaining({ label: "Matched metric", value: "primary_score" }),
            expect.objectContaining({ label: "Objective", value: "met" })
          ])
        })
      ])
    );
  });

  it("prepares review through analyze_results and figure_audit in 10-node order", async () => {
    const run = await runStore.createRun({
      title: "Review command run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    const runDir = path.join(cwd, ".autolabos", "runs", run.id);
    const current = await runStore.getRun(run.id);
    if (!current) {
      throw new Error("expected run");
    }
    current.status = "paused";
    current.currentNode = "analyze_results";
    current.graph.currentNode = "analyze_results";
    current.graph.nodeStates.analyze_results = {
      status: "needs_approval",
      updatedAt: new Date().toISOString(),
      note: "Analysis ready for review."
    };
    current.graph.nodeStates.figure_audit = {
      status: "pending",
      updatedAt: new Date().toISOString()
    };
    current.graph.nodeStates.review = {
      status: "pending",
      updatedAt: new Date().toISOString()
    };
    current.graph.pendingTransition = {
      action: "advance",
      sourceNode: "analyze_results",
      targetNode: "figure_audit",
      reason: "Proceed to figure audit.",
      confidence: 0.88,
      autoExecutable: true,
      evidence: ["primary_score reached the configured target."],
      suggestedCommands: ["/approve"],
      generatedAt: new Date().toISOString()
    };
    await runStore.updateRun(current);

    const reviewPacket = {
      generated_at: "2026-03-10T10:00:00.000Z",
      readiness: {
        status: "blocking",
        ready_checks: 3,
        warning_checks: 1,
        blocking_checks: 1,
        manual_checks: 1
      },
      objective_status: "met",
      objective_summary: "Objective metric met: primary_score=0.91 >= 0.9.",
      recommendation: {
        action: "advance",
        target: "review",
        confidence_pct: 88,
        reason: "The run can proceed to manual review before paper writing.",
        evidence: ["primary_score reached the configured target."]
      },
      checks: [
        {
          id: "evidence_bundle",
          label: "Evidence bundle",
          status: "blocking",
          detail: "Missing required paper inputs: evidence_store.jsonl."
        },
        {
          id: "human_signoff",
          label: "Human sign-off",
          status: "manual",
          detail: "Confirm the claims, evidence quality, and next action before approving write_paper."
        }
      ],
      suggested_actions: ["/agent apply", "/agent jump analyze_results"]
    };

    const callOrder: string[] = [];
    const approveCurrent = vi.fn(async (runId: string) => {
      const stored = await runStore.getRun(runId);
      if (!stored) {
        throw new Error("expected stored run");
      }
      callOrder.push(`approve:${stored.currentNode}`);
      stored.currentNode = "figure_audit";
      stored.graph.currentNode = "figure_audit";
      stored.status = "running";
      stored.graph.nodeStates.analyze_results.status = "completed";
      stored.graph.nodeStates.figure_audit.status = "pending";
      stored.graph.pendingTransition = undefined;
      await runStore.updateRun(stored);
      return stored;
    });

    const runAgentWithOptions = vi.fn(async (runId: string, nodeId: string) => {
      callOrder.push(`run:${nodeId}`);
      const stored = await runStore.getRun(runId);
      if (!stored) {
        throw new Error("expected stored run");
      }
      if (nodeId === "figure_audit") {
        stored.currentNode = "figure_audit";
        stored.graph.currentNode = "figure_audit";
        stored.status = "paused";
        stored.graph.nodeStates.figure_audit = {
          status: "needs_approval",
          updatedAt: new Date().toISOString(),
          note: "Figure audit completed."
        };
        stored.graph.pendingTransition = {
          action: "advance",
          sourceNode: "figure_audit",
          targetNode: "review",
          reason: "Figure audit completed safely.",
          confidence: 0.95,
          autoExecutable: true,
          evidence: ["Figure audit summary is available."],
          suggestedCommands: ["/approve"],
          generatedAt: new Date().toISOString()
        };
        await runStore.updateRun(stored);
        return {
          run: stored,
          result: { status: "success" as const, summary: "Figure audit completed." }
        };
      }
      if (nodeId !== "review") {
        throw new Error(`unexpected node: ${nodeId}`);
      }
      await fs.mkdir(path.join(runDir, "review"), { recursive: true });
      await fs.writeFile(
        path.join(runDir, "review", "review_packet.json"),
        `${JSON.stringify(reviewPacket, null, 2)}\n`,
        "utf8"
      );
      stored.currentNode = "review";
      stored.graph.currentNode = "review";
      stored.status = "paused";
      stored.graph.nodeStates.review = {
        status: "needs_approval",
        updatedAt: new Date().toISOString(),
        note: "Review packet prepared."
      };
      await runStore.updateRun(stored);
      return {
        run: stored,
        result: { status: "success" as const, summary: "Review packet prepared." }
      };
    });
    const applyPendingTransition = vi.fn(async (runId: string) => {
      const stored = await runStore.getRun(runId);
      if (!stored) {
        throw new Error("expected stored run");
      }
      callOrder.push(`apply:${stored.currentNode}`);
      stored.currentNode = "review";
      stored.graph.currentNode = "review";
      stored.status = "running";
      stored.graph.nodeStates.figure_audit.status = "completed";
      stored.graph.nodeStates.review.status = "pending";
      stored.graph.pendingTransition = undefined;
      await runStore.updateRun(stored);
      return stored;
    });

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        },
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: { model: "gpt-5.3-codex", reasoning_effort: "xhigh", fast_mode: false },
          openai: { model: "gpt-5.4", reasoning_effort: "medium" }
        },
        analysis: {
          responses_model: "gpt-5.4"
        },
        papers: { max_results: 100 }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {
        approveCurrent,
        applyPendingTransition,
        runAgentWithOptions
      } as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const result = await session.submitInput("/agent review");
    const snapshot = session.snapshot();

    expect(result.logs.some((line) => line.includes("Approved analyze_results and moved into figure_audit."))).toBe(true);
    expect(result.logs.some((line) => line.includes("figure_audit finished: Figure audit completed."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Applied figure_audit advance and moved into review."))).toBe(true);
    expect(result.logs.some((line) => line.includes("review finished: Review packet prepared."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Review readiness: blocking"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Blocking: Evidence bundle"))).toBe(true);
    expect(approveCurrent).toHaveBeenCalledWith(run.id);
    expect(applyPendingTransition).toHaveBeenCalledWith(run.id);
    expect(runAgentWithOptions.mock.calls.map(([, nodeId]) => nodeId)).toEqual(["figure_audit", "review"]);
    expect(runAgentWithOptions).toHaveBeenNthCalledWith(
      1,
      run.id,
      "figure_audit",
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
    );
    expect(runAgentWithOptions).toHaveBeenNthCalledWith(
      2,
      run.id,
      "review",
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
    );
    expect(callOrder).toEqual([
      "approve:analyze_results",
      "run:figure_audit",
      "apply:figure_audit",
      "run:review"
    ]);
    expect(snapshot.activeRunInsight?.title).toBe("Review packet");
    expect(snapshot.activeRunInsight?.lines.some((line) => line.includes("Review readiness: blocking"))).toBe(true);
  });

  it.each([
    {
      label: "a non-auto-executable human pause",
      action: "pause_for_human" as const,
      targetNode: "review" as const,
      autoExecutable: false
    },
    {
      label: "a backtrack",
      action: "backtrack_to_design" as const,
      targetNode: "design_experiments" as const,
      autoExecutable: true
    }
  ])("stops /agent review when figure_audit returns $label", async ({ action, targetNode, autoExecutable }) => {
    const run = await runStore.createRun({
      title: "Guarded figure audit run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    const current = await runStore.getRun(run.id);
    if (!current) {
      throw new Error("expected run");
    }
    current.status = "running";
    current.currentNode = "figure_audit";
    current.graph.currentNode = "figure_audit";
    current.graph.nodeStates.analyze_results.status = "completed";
    current.graph.nodeStates.figure_audit.status = "pending";
    await runStore.updateRun(current);

    const runAgentWithOptions = vi.fn(async (runId: string, nodeId: string) => {
      const stored = await runStore.getRun(runId);
      if (!stored) {
        throw new Error("expected stored run");
      }
      stored.status = "paused";
      stored.currentNode = "figure_audit";
      stored.graph.currentNode = "figure_audit";
      stored.graph.nodeStates.figure_audit = {
        status: "needs_approval",
        updatedAt: new Date().toISOString(),
        note: "Figure audit requires another decision."
      };
      stored.graph.pendingTransition = {
        action,
        sourceNode: "figure_audit",
        targetNode,
        reason: "Figure audit cannot safely advance to review.",
        confidence: 0.9,
        autoExecutable,
        evidence: ["A blocking figure issue remains."],
        suggestedCommands: ["/agent transition"],
        generatedAt: new Date().toISOString()
      };
      await runStore.updateRun(stored);
      return {
        run: stored,
        result: { status: "success" as const, summary: `${nodeId} paused.` }
      };
    });
    const applyPendingTransition = vi.fn();
    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {
        applyPendingTransition,
        runAgentWithOptions
      } as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const result = await session.submitInput("/agent review");

    expect(result.logs.some((line) => line.includes(`${action} -> ${targetNode}`))).toBe(true);
    expect(result.logs.some((line) => line.includes("not a safe auto-executable advance to review"))).toBe(true);
    expect(runAgentWithOptions).toHaveBeenCalledWith(
      run.id,
      "figure_audit",
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
    );
    expect(applyPendingTransition).not.toHaveBeenCalled();
  });

  it("surfaces manuscript quality insight during write_paper before falling back to the review packet", async () => {
    const run = await runStore.createRun({
      title: "Manuscript quality run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    const current = await runStore.getRun(run.id);
    if (!current) {
      throw new Error("expected run");
    }
    current.status = "failed";
    current.currentNode = "write_paper";
    current.graph.currentNode = "write_paper";
    current.graph.nodeStates.review.status = "completed";
    current.graph.nodeStates.write_paper.status = "failed";
    await runStore.updateRun(current);

    const runDir = path.join(cwd, ".autolabos", "runs", run.id);
    await fs.mkdir(path.join(runDir, "review"), { recursive: true });
    await fs.mkdir(path.join(runDir, "paper"), { recursive: true });
    await fs.writeFile(
      path.join(runDir, "review", "review_packet.json"),
      JSON.stringify(
        {
          generated_at: "2026-03-26T10:00:00.000Z",
          readiness: {
            status: "warning",
            ready_checks: 4,
            warning_checks: 1,
            blocking_checks: 0,
            manual_checks: 1
          },
          objective_status: "met",
          objective_summary: "The objective was met.",
          checks: [],
          suggested_actions: []
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      path.join(runDir, "paper", "manuscript_quality_gate.json"),
      JSON.stringify(
        {
          action: "stop",
          pass_index: 1,
          triggered_by: ["appendix_hygiene"],
          allowed_max_passes: 2,
          remaining_allowed_repairs: 0,
          issues_before: [
            {
              source: "review",
              code: "appendix_hygiene",
              severity: "fail",
              section: "Appendix",
              repairable: true,
              message: "Appendix still contains internal workflow language."
            }
          ],
          issues_after: [
            {
              source: "review",
              code: "appendix_hygiene",
              severity: "fail",
              section: "Appendix",
              repairable: true,
              message: "Appendix still contains internal workflow language."
            }
          ],
          improvement_detected: false,
          stop_or_continue_reason: "Appendix contamination remained after the first repair.",
          decision_digest: {
            stage: "post_repair_1",
            action: "stop",
            review_reliability: "grounded",
            issue_counts_before: { total: 1, fail: 1, warning: 0 },
            issue_counts_after: { total: 1, fail: 1, warning: 0 },
            improvement_detected: false,
            allowed_max_passes: 2,
            remaining_allowed_repairs: 0,
            triggered_by: ["appendix_hygiene"],
            stop_reason_category: "policy_hard_stop"
          },
          summary_lines: [
            "Action: stop.",
            "Decision reason: Appendix contamination remained after the first repair."
          ]
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      path.join(runDir, "paper", "manuscript_quality_failure.json"),
      JSON.stringify(
        {
          generated_at: "2026-03-26T10:02:00.000Z",
          reason: "Appendix contamination remained after the first repair.",
          decision_digest: {
            stage: "post_repair_1",
            action: "stop",
            review_reliability: "grounded",
            issue_counts_before: { total: 1, fail: 1, warning: 0 },
            issue_counts_after: { total: 1, fail: 1, warning: 0 },
            improvement_detected: false,
            allowed_max_passes: 2,
            remaining_allowed_repairs: 0,
            triggered_by: ["appendix_hygiene"],
            stop_reason_category: "policy_hard_stop"
          },
          summary_lines: [
            "Action: stop.",
            "Decision reason: Appendix contamination remained after the first repair."
          ],
          triggered_by: ["appendix_hygiene"],
          review_reliability: "grounded",
          final_issues: [
            {
              source: "review",
              code: "appendix_hygiene",
              severity: "fail",
              section: "Appendix",
              repairable: true,
              message: "Appendix still contains internal workflow language."
            }
          ],
          lint_findings: [
            {
              code: "appendix_internal_text",
              section: "Appendix",
              severity: "fail",
              gate_role: "hard_stop"
            }
          ],
          reviewer_missed_policy_findings: [
            {
              code: "appendix_internal_text",
              section: "Appendix",
              severity: "fail",
              gate_role: "hard_stop"
            }
          ],
          reviewer_covered_backstop_findings: []
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      path.join(runDir, "paper", "manuscript_style_lint.json"),
      JSON.stringify(
        {
          mode: "hard_policy_only",
          checked_rules: ["appendix_hygiene"],
          ok: false,
          issues: [
            {
              severity: "fail",
              code: "appendix_internal_text",
              section: "Appendix",
              message: "Appendix includes internal workflow text.",
              fix_recommendation: "Remove internal workflow language.",
              gate_role: "hard_stop"
            }
          ],
          summary: ["1 appendix hard-stop finding remains."]
        },
        null,
        2
      ),
      "utf8"
    );

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const snapshot = session.snapshot();

    expect(snapshot.activeRunInsight?.title).toBe("Manuscript quality");
    expect(snapshot.activeRunInsight?.manuscriptQuality?.status).toBe("stopped");
    expect(snapshot.activeRunInsight?.manuscriptQuality?.reasonCategory).toBe("policy_hard_stop");
    expect(snapshot.activeRunInsight?.manuscriptQuality?.artifactRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "paper/manuscript_quality_gate.json" }),
        expect.objectContaining({ path: "paper/manuscript_quality_failure.json" })
      ])
    );
    expect(snapshot.activeRunInsight?.lines.some((line) => line.includes("Status: Stopped."))).toBe(true);
  });

  it("surfaces review-stage readiness risks inside the review insight", async () => {
    const run = await runStore.createRun({
      title: "Review readiness run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    const current = await runStore.getRun(run.id);
    if (!current) {
      throw new Error("expected run");
    }
    current.status = "paused";
    current.currentNode = "review";
    current.graph.currentNode = "review";
    current.graph.nodeStates.review.status = "needs_approval";
    await runStore.updateRun(current);

    const runDir = path.join(cwd, ".autolabos", "runs", run.id);
    await fs.mkdir(path.join(runDir, "review"), { recursive: true });
    await fs.writeFile(
      path.join(runDir, "review", "review_packet.json"),
      JSON.stringify(
        {
          generated_at: "2026-03-27T10:00:00.000Z",
          readiness: {
            status: "blocking",
            ready_checks: 3,
            warning_checks: 1,
            blocking_checks: 1,
            manual_checks: 1
          },
          objective_status: "met",
          objective_summary: "The objective was met.",
          checks: [
            {
              id: "evidence_bundle",
              label: "Evidence bundle",
              status: "blocking",
              detail: "Missing required paper inputs: evidence_store.jsonl."
            }
          ],
          suggested_actions: ["/agent jump design_experiments --force"]
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      path.join(runDir, "review", "readiness_risks.json"),
      JSON.stringify(
        {
          generated_at: "2026-03-27T10:00:00.000Z",
          paper_ready: false,
          readiness_state: "blocked_for_paper_scale",
          risk_count: 1,
          blocked_count: 1,
          warning_count: 0,
          summary_lines: ["Readiness risks: blocked=1, warning=0, readiness_state=blocked_for_paper_scale."],
          risks: [
            {
              risk_code: "review_minimum_gate_blocked_for_paper_scale",
              severity: "blocked",
              category: "paper_scale",
              status: "blocked",
              message: "Minimum gate: 3 check(s) failed — ceiling: blocked_for_paper_scale.",
              triggered_by: ["minimum_gate"],
              affected_claim_ids: [],
              affected_citation_ids: [],
              recommended_action: "Backtrack to recover the missing evidence floor instead of treating the run as paper-scale.",
              recheck_condition: "The review minimum gate passes without any failed checks."
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const snapshot = session.snapshot();

    expect(snapshot.activeRunInsight?.title).toBe("Review packet");
    expect(snapshot.activeRunInsight?.readinessRisks?.readinessState).toBe("blocked_for_paper_scale");
    expect(snapshot.activeRunInsight?.readinessRisks?.riskCounts.blocked).toBe(1);
    expect(snapshot.activeRunInsight?.readinessRisks?.artifactRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "review/readiness_risks.json" })
      ])
    );
    expect(snapshot.activeRunInsight?.lines.some((line) => line.includes("Paper readiness risks: blocked 1"))).toBe(true);
  });

  it("does not consume an analyze_results backtrack when /agent review is requested", async () => {
    const run = await runStore.createRun({
      title: "Backtrack before review",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    const current = await runStore.getRun(run.id);
    if (!current) {
      throw new Error("expected run");
    }
    current.status = "paused";
    current.currentNode = "analyze_results";
    current.graph.currentNode = "analyze_results";
    current.graph.nodeStates.analyze_results = {
      status: "needs_approval",
      updatedAt: new Date().toISOString(),
      note: "Analysis recommends another design revision."
    };
    current.graph.nodeStates.review = {
      status: "pending",
      updatedAt: new Date().toISOString()
    };
    current.graph.pendingTransition = {
      action: "backtrack_to_design",
      sourceNode: "analyze_results",
      targetNode: "design_experiments",
      reason: "Brief evidence gate failed.",
      confidence: 0.76,
      autoExecutable: false,
      evidence: ["The run remains too small for paper progression."],
      suggestedCommands: ["/agent jump design_experiments", "/agent run design_experiments"],
      generatedAt: new Date().toISOString()
    };
    await runStore.updateRun(current);

    const approveCurrent = vi.fn(async (runId: string) => {
      const stored = await runStore.getRun(runId);
      if (!stored) {
        throw new Error("expected stored run");
      }
      stored.currentNode = "design_experiments";
      stored.graph.currentNode = "design_experiments";
      stored.status = "running";
      stored.graph.nodeStates.analyze_results.status = "completed";
      stored.graph.nodeStates.design_experiments = {
        status: "pending",
        updatedAt: new Date().toISOString(),
        note: "Ready for another design pass."
      };
      stored.graph.pendingTransition = undefined;
      await runStore.updateRun(stored);
      return stored;
    });
    const runAgentWithOptions = vi.fn();

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        },
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: { model: "gpt-5.3-codex", reasoning_effort: "xhigh", fast_mode: false },
          openai: { model: "gpt-5.4", reasoning_effort: "medium" }
        },
        analysis: {
          responses_model: "gpt-5.4"
        },
        papers: { max_results: 100 }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {
        approveCurrent,
        runAgentWithOptions
      } as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const result = await session.submitInput("/agent review");
    const unchanged = await runStore.getRun(run.id);

    expect(
      result.logs.some((line) =>
        line.includes(
          "Analysis handoff stopped before figure audit: backtrack_to_design -> design_experiments (autoExecutable=false)"
        )
      )
    ).toBe(true);
    expect(result.logs.some((line) => line.includes("not a safe auto-executable advance to figure_audit"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Reason: Brief evidence gate failed."))).toBe(true);
    expect(approveCurrent).not.toHaveBeenCalled();
    expect(runAgentWithOptions).not.toHaveBeenCalled();
    expect(unchanged?.currentNode).toBe("analyze_results");
    expect(unchanged?.graph.nodeStates.analyze_results.status).toBe("needs_approval");
    expect(unchanged?.graph.pendingTransition).toEqual(current.graph.pendingTransition);
  });

  it("does not surface analyze-results insight when the active run is rewound before analyze_results", async () => {
    const run = await runStore.createRun({
      title: "Stale analysis insight",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    const current = await runStore.getRun(run.id);
    if (!current) {
      throw new Error("expected run");
    }
    current.status = "running";
    current.currentNode = "analyze_papers";
    current.graph.currentNode = "analyze_papers";
    current.graph.nodeStates.analyze_papers = {
      status: "running",
      updatedAt: new Date().toISOString(),
      note: "analysis resumed"
    };
    await runStore.updateRun(current);

    const runDir = path.join(cwd, ".autolabos", "runs", run.id);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify(
        {
          overview: {
            objective_status: "not_met",
            objective_summary: "Previous analysis from an earlier cycle."
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    expect(session.snapshot().activeRunInsight).toBeUndefined();
  });

  it("blocks /approve on analyze_papers when no evidence has been persisted yet", async () => {
    const run = await runStore.createRun({
      title: "Approve guard run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    const current = await runStore.getRun(run.id);
    if (!current) {
      throw new Error("expected run");
    }
    current.status = "paused";
    current.currentNode = "analyze_papers";
    current.graph.currentNode = "analyze_papers";
    current.graph.nodeStates.analyze_papers = {
      status: "needs_approval",
      updatedAt: new Date().toISOString(),
      note: "Paused for manual review."
    };
    await runStore.updateRun(current);

    const approveCurrent = vi.fn();
    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        },
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: { model: "gpt-5.3-codex", reasoning_effort: "xhigh", fast_mode: false },
          openai: { model: "gpt-5.4", reasoning_effort: "medium" }
        },
        analysis: {
          responses_model: "gpt-5.4"
        },
        papers: { max_results: 100 }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {
        approveCurrent
      } as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const result = await session.submitInput("/approve");

    expect(result.logs.some((line) => line.includes("no persisted evidence"))).toBe(true);
    expect(result.logs.some((line) => line.includes("/retry"))).toBe(true);
    expect(approveCurrent).not.toHaveBeenCalled();
  });

  it("preserves an existing analyze_papers request when /agent run analyze_papers omits --top-n", async () => {
    const run = await runStore.createRun({
      title: "Analyze preserve run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    run.status = "paused";
    run.currentNode = "analyze_papers";
    run.graph.currentNode = "analyze_papers";
    run.graph.nodeStates.analyze_papers.status = "pending";
    await runStore.updateRun(run);

    const runContext = new RunContextMemory(path.join(cwd, run.memoryRefs.runContextPath));
    await runContext.put("analyze_papers.request", {
      topN: 30,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    const runAgentWithOptions = vi.fn(async (runId: string) => {
      const stored = await runStore.getRun(runId);
      if (!stored) {
        throw new Error("expected stored run");
      }
      stored.status = "paused";
      stored.currentNode = "analyze_papers";
      stored.graph.currentNode = "analyze_papers";
      stored.graph.nodeStates.analyze_papers = {
        status: "running",
        updatedAt: new Date().toISOString(),
        note: "Analyzing papers."
      };
      await runStore.updateRun(stored);
      return {
        run: stored,
        result: { status: "success" as const, summary: "Analyzing papers." }
      };
    });

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        },
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: { model: "gpt-5.3-codex", reasoning_effort: "xhigh", fast_mode: false },
          openai: { model: "gpt-5.4", reasoning_effort: "medium" }
        },
        analysis: {
          responses_model: "gpt-5.4"
        },
        papers: { max_results: 100 }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {
        runAgentWithOptions
      } as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const result = await session.submitInput(`/agent run analyze_papers ${run.id}`);

    expect(result.logs.some((line) => line.includes("analyze_papers finished: Analyzing papers."))).toBe(true);
    expect(runAgentWithOptions).toHaveBeenCalledWith(
      run.id,
      "analyze_papers",
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
    );
    expect(await runContext.get("analyze_papers.request")).toMatchObject({
      topN: 30,
      selectionMode: "top_n"
    });
  });

  it("continues a manual /agent run when it advances to a later pending node", async () => {
    const run = await runStore.createRun({
      title: "Design continue run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    run.status = "paused";
    run.currentNode = "design_experiments";
    run.graph.currentNode = "design_experiments";
    run.graph.nodeStates.design_experiments.status = "pending";
    await runStore.updateRun(run);

    const runAgentWithOptions = vi.fn(async (runId: string) => {
      const stored = await runStore.getRun(runId);
      if (!stored) {
        throw new Error("expected stored run");
      }
      stored.status = "running";
      stored.currentNode = "implement_experiments";
      stored.graph.currentNode = "implement_experiments";
      stored.graph.nodeStates.design_experiments = {
        status: "completed",
        updatedAt: new Date().toISOString(),
        note: "design approved"
      };
      stored.graph.nodeStates.implement_experiments = {
        status: "pending",
        updatedAt: new Date().toISOString(),
        note: "ready to run"
      };
      await runStore.updateRun(stored);
      return {
        run: stored,
        result: { status: "success" as const, summary: "Design approved." }
      };
    });

    const runCurrentAgentWithOptions = vi.fn(async (runId: string) => {
      const stored = await runStore.getRun(runId);
      if (!stored) {
        throw new Error("expected stored run");
      }
      stored.graph.nodeStates.implement_experiments = {
        status: "running",
        updatedAt: new Date().toISOString(),
        note: "Implementation started."
      };
      await runStore.updateRun(stored);
      return {
        run: stored,
        result: { status: "success" as const, summary: "Implementation started." }
      };
    });

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        },
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: { model: "gpt-5.3-codex", reasoning_effort: "xhigh", fast_mode: false },
          openai: { model: "gpt-5.4", reasoning_effort: "medium" }
        },
        analysis: {
          responses_model: "gpt-5.4"
        },
        papers: { max_results: 100 }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream: new InMemoryEventStream(),
      orchestrator: {
        runAgentWithOptions,
        runCurrentAgentWithOptions
      } as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    const result = await session.submitInput(`/agent run design_experiments ${run.id}`);

    expect(result.logs.some((line) => line.includes("design_experiments finished: Design approved."))).toBe(true);
    expect(runCurrentAgentWithOptions).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
    );
  });

  it("prefixes replayed persisted run events when selecting a run", async () => {
    const run = await runStore.createRun({
      title: "Recovered run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    const eventStream = new PersistedEventStream(path.join(cwd, ".autolabos", "runs"));
    eventStream.emit({
      type: "OBS_RECEIVED",
      runId: run.id,
      node: "collect_papers",
      payload: {
        text: "Recovered deferred enrichment background task after restart."
      }
    });

    const session = new InteractionSession({
      workspaceRoot: cwd,
      config: {
        research: {
          defaultTopic: "topic",
          defaultConstraints: ["declared literature scope"],
          default_objective_metric: "metric"
        }
      } as any,
      runStore,
      titleGenerator: {} as any,
      codex: {} as any,
      openAiTextClient: undefined,
      eventStream,
      orchestrator: {} as any,
      semanticScholarApiKeyConfigured: true
    });
    await session.start();
    await session.selectRun(run.id);

    expect(session.snapshot().logs).toContain("Replay: Recovered deferred enrichment background task after restart.");
  });
});
