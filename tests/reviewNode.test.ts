import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryEventStream } from "../src/core/events.js";
import { MockLLMClient } from "../src/core/llm/client.js";
import type { ResultsArtifactV2 } from "../src/core/analysis/resultsTableSchema.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { createReviewNode } from "../src/core/nodes/review.js";
import { buildPublicReviewDir, buildPublicRunManifestPath, buildPublicRunOutputDir } from "../src/core/publicArtifacts.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { LocalAciAdapter } from "../src/tools/aciLocalAdapter.js";
import { RunRecord } from "../src/types.js";

const topicProbeReviewMocks = vi.hoisted(() => ({
  source: undefined as any,
  handoff: undefined as any,
  gate: undefined as any
}));

vi.mock("../src/core/topicProbeOutcomeArtifacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/topicProbeOutcomeArtifacts.js")>();
  return {
    ...actual,
    loadTopicProbeOutcomeArtifacts: (
      ...args: Parameters<typeof actual.loadTopicProbeOutcomeArtifacts>
    ) =>
      topicProbeReviewMocks.source === undefined
        ? actual.loadTopicProbeOutcomeArtifacts(...args)
        : Promise.resolve(topicProbeReviewMocks.source)
  };
});

vi.mock("../src/core/topicProbeFollowup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/topicProbeFollowup.js")>();
  return {
    ...actual,
    buildTopicProbeFollowupHandoff: (
      ...args: Parameters<typeof actual.buildTopicProbeFollowupHandoff>
    ) =>
      topicProbeReviewMocks.handoff === undefined
        ? actual.buildTopicProbeFollowupHandoff(...args)
        : topicProbeReviewMocks.handoff,
    validateTopicProbeFollowupHandoff: (
      ...args: Parameters<typeof actual.validateTopicProbeFollowupHandoff>
    ) =>
      topicProbeReviewMocks.handoff === undefined
        ? actual.validateTopicProbeFollowupHandoff(...args)
        : { measured: true, valid: true, reasons: [] }
  };
});

vi.mock("../src/core/topicProbeReviewGate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/topicProbeReviewGate.js")>();
  return {
    ...actual,
    buildTopicProbeReviewGate: (
      ...args: Parameters<typeof actual.buildTopicProbeReviewGate>
    ) =>
      topicProbeReviewMocks.gate === undefined
        ? actual.buildTopicProbeReviewGate(...args)
        : topicProbeReviewMocks.gate,
    validateTopicProbeReviewGate: (
      ...args: Parameters<typeof actual.validateTopicProbeReviewGate>
    ) =>
      topicProbeReviewMocks.gate === undefined
        ? actual.validateTopicProbeReviewGate(...args)
        : { measured: true, valid: true, reasons: [] }
  };
});

const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  delete process.env.AUTOLABOS_REVIEW_REFINEMENT_TIMEOUT_MS;
  topicProbeReviewMocks.source = undefined;
  topicProbeReviewMocks.handoff = undefined;
  topicProbeReviewMocks.gate = undefined;
  process.chdir(ORIGINAL_CWD);
});

class HangingReviewLlm extends MockLLMClient {
  override async complete(
    _prompt: string,
    opts?: { abortSignal?: AbortSignal }
  ): Promise<{ text: string }> {
    return new Promise((resolve, reject) => {
      const signal = opts?.abortSignal;
      const abort = () => reject(new Error("aborted"));
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      void resolve;
    });
  }
}

class TruncatedReviewJsonLlm extends MockLLMClient {
  override async complete(): Promise<{ text: string }> {
    return {
      text: `{
  "summary": "LLM repaired review summary",
  "score_1_to_5": 4,
  "confidence": 0.81,
  "recommendation": "advance",
  "findings": []
`
    };
  }
}

class PromptCaptureReviewLlm extends MockLLMClient {
  prompts: string[] = [];

  override async complete(prompt: string): Promise<{ text: string }> {
    this.prompts.push(prompt);
    return { text: "not-json" };
  }
}

function makeRun(runId: string): RunRecord {
  return {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Reviewable run",
    topic: "AI agent automation",
    constraints: [],
    objectiveMetric: "primary_measure at least 0.9",
    status: "running",
    currentNode: "review",
    latestSummary: undefined,
    nodeThreads: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    graph: createDefaultGraphState(),
    memoryRefs: {
      runContextPath: `.autolabos/runs/${runId}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${runId}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${runId}/memory/episodes.jsonl`
    }
  };
}

interface CanonicalResultsFixtureOptions {
  metricId?: string;
  metricLabel?: string;
  subjectSeriesId?: string;
  subjectLabel?: string;
  referenceSeriesId?: string;
  referenceLabel?: string;
  referenceRole?: ResultsArtifactV2["series"][number]["role"];
  subjectValue?: number;
  referenceValue?: number;
  comparisonId?: string;
  judgement?: string;
  includeComparison?: boolean;
  includePrimaryComparisonId?: boolean;
  additionalSeries?: ResultsArtifactV2["series"];
}

function canonicalResultsFixture(
  options: CanonicalResultsFixtureOptions = {}
): { results_artifact: ResultsArtifactV2; primary_comparison_id?: string } {
  const metricId = options.metricId ?? "primary_measure";
  const subjectSeriesId = options.subjectSeriesId ?? "candidate_series";
  const referenceSeriesId = options.referenceSeriesId ?? "reference_series";
  const subjectValue = options.subjectValue ?? 0.91;
  const referenceValue = options.referenceValue ?? 0.87;
  const comparisonId = options.comparisonId ?? "declared_primary_comparison";
  const includeComparison = options.includeComparison ?? true;
  const artifact: ResultsArtifactV2 = {
    schema_version: "2.0",
    metrics: [
      { id: metricId, label: options.metricLabel ?? "Primary measure", direction: "higher_better", unit: "points" }
    ],
    series: [
      {
        id: subjectSeriesId,
        label: options.subjectLabel ?? "Candidate series",
        role: "primary",
        dimensions: { arm: "candidate" }
      },
      {
        id: referenceSeriesId,
        label: options.referenceLabel ?? "Reference series",
        role: options.referenceRole ?? "baseline",
        dimensions: { arm: "reference" }
      },
      ...(options.additionalSeries ?? [])
    ],
    observations: [
      {
        id: "candidate_observation",
        series_id: subjectSeriesId,
        metric_id: metricId,
        scope: { partition: "evaluation" },
        value: subjectValue,
        evidence_refs: ["metrics.json#/candidate"]
      },
      {
        id: "reference_observation",
        series_id: referenceSeriesId,
        metric_id: metricId,
        scope: { partition: "evaluation" },
        value: referenceValue,
        evidence_refs: ["metrics.json#/reference"]
      }
    ],
    comparisons: includeComparison
      ? [
          {
            id: comparisonId,
            subject_observation_id: "candidate_observation",
            reference_observation_id: "reference_observation",
            delta: subjectValue - referenceValue,
            ...(options.judgement ? { judgement: options.judgement } : {}),
            evidence_refs: ["metrics.json#/declared_comparison"]
          }
        ]
      : []
  };

  return {
    results_artifact: artifact,
    ...(includeComparison && (options.includePrimaryComparisonId ?? true)
      ? { primary_comparison_id: comparisonId }
      : {})
  };
}

function reviewAnalysisReportFixture() {
  return {
    analysis_version: 1,
    generated_at: new Date().toISOString(),
    mean_score: 0.91,
    metrics: { primary_measure: 0.91 },
    objective_metric: {
      raw: "primary_measure at least 0.9",
      evaluation: { status: "met", summary: "Objective metric met: primary_measure=0.91." },
      profile: {
        source: "default",
        preferred_metric_keys: ["primary_measure"],
        analysis_focus: [],
        paper_emphasis: [],
        assumptions: []
      }
    },
    overview: {
      objective_status: "met",
      objective_summary: "Objective metric met: primary_measure=0.91.",
      execution_runs: 3
    },
    plan_context: {
      selected_design: {
        id: "declared_design",
        title: "Declared comparison design",
        summary: "Evaluate one declared primary comparison.",
        selected_hypothesis_ids: ["hypothesis_1"],
        metrics: ["primary_measure"],
        baselines: ["Reference series"],
        implementation_notes: [],
        evaluation_steps: ["run repeated evaluations"],
        risks: [],
        resource_notes: []
      },
      shortlisted_designs: [],
      design_notes: [],
      implementation_notes: [],
      evaluation_notes: [],
      assumptions: []
    },
    metric_table: [{ key: "primary_measure", value: 0.91 }],
    ...canonicalResultsFixture({
      subjectValue: 0.91,
      referenceValue: 0.87,
      judgement: "supported"
    }),
    execution_summary: { observation_count: 3, commands: [], sources: [], stderr_excerpts: [] },
    primary_findings: ["The declared primary comparison was executed."],
    limitations: [],
    warnings: [],
    paper_claims: [],
    figure_specs: [],
    supplemental_runs: [],
    external_comparisons: [],
    statistical_summary: {
      total_trials: 3,
      executed_trials: 3,
      cached_trials: 0,
      confidence_intervals: [],
      stability_metrics: [],
      effect_estimates: [],
      notes: []
    },
    failure_taxonomy: []
  };
}

describe("review node", () => {
  it.each([
    { caseName: "missing", report: { analysis_version: 1 } },
    {
      caseName: "malformed",
      report: {
        analysis_version: 1,
        results_artifact: { schema_version: "2.0", metrics: [], series: [] }
      }
    }
  ])("fails cleanly when canonical results are $caseName", async ({ caseName, report }) => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-invalid-results-"));
    process.chdir(root);

    const run = makeRun(`run-review-${caseName}-results`);
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(
      path.join(runDir, "memory", "run_context.json"),
      JSON.stringify({ version: 1, items: [] }),
      "utf8"
    );
    await writeFile(path.join(runDir, "result_analysis.json"), JSON.stringify(report), "utf8");

    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("canonical ResultsArtifactV2");
  });

  it.each([
    { caseName: "missing", primaryComparisonId: undefined },
    { caseName: "unknown", primaryComparisonId: "unknown_comparison" }
  ])("rejects a $caseName explicit primary comparison binding", async ({ caseName, primaryComparisonId }) => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-primary-binding-"));
    process.chdir(root);

    const run = makeRun(`run-review-${caseName}-primary-binding`);
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(
      path.join(runDir, "memory", "run_context.json"),
      JSON.stringify({ version: 1, items: [] }),
      "utf8"
    );
    const report = reviewAnalysisReportFixture();
    if (primaryComparisonId === undefined) {
      delete report.primary_comparison_id;
    } else {
      report.primary_comparison_id = primaryComparisonId;
    }
    await writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify(report, null, 2),
      "utf8"
    );

    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("primary_comparison_id");
    expect(result.error).toContain(
      primaryComparisonId === undefined ? "is required" : "references unknown comparison id"
    );
  });

  it("falls back from a malformed cached report to the parsed disk artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-cache-fallback-"));
    process.chdir(root);

    const run = makeRun("run-review-cache-fallback");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put("analyze_results.last_summary", {
      results_artifact: { schema_version: "2.0", metrics: [], series: [] }
    });
    await writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify(reviewAnalysisReportFixture(), null, 2),
      "utf8"
    );

    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(result.transitionRecommendation?.targetNode).not.toBe("write_paper");
  });

  it("fails closed when a topic-discovery run reaches review without its bound probe chain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-topic-probe-chain-"));
    process.chdir(root);

    const run = makeRun("run-review-topic-probe-chain");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put(
      "run_brief.raw",
      ["# Research Brief", "", "## Research Mode", "topic_discovery"].join("\n")
    );
    await writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify(reviewAnalysisReportFixture(), null, 2),
      "utf8"
    );

    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(result.transitionRecommendation).toMatchObject({
      action: "backtrack_to_hypotheses",
      targetNode: "generate_hypotheses",
      autoExecutable: true
    });
    expect(result.transitionRecommendation?.action).not.toBe("delegate_successor");
    const gate = JSON.parse(
      await readFile(path.join(runDir, "review", "topic_probe_gate.json"), "utf8")
    ) as {
      status: string;
      paper_drafting_allowed: boolean;
      reason_codes: string[];
    };
    expect(gate.status).toBe("blocked_invalid_artifact_chain");
    expect(gate.paper_drafting_allowed).toBe(false);
    expect(gate.reason_codes.length).toBeGreaterThan(0);

    const decision = JSON.parse(
      await readFile(path.join(runDir, "review", "decision.json"), "utf8")
    ) as { outcome: string; recommended_transition?: string };
    expect(decision).toMatchObject({
      outcome: "backtrack_to_hypotheses",
      recommended_transition: "backtrack_to_hypotheses"
    });
    const findings = await readFile(
      path.join(runDir, "review", "findings.jsonl"),
      "utf8"
    );
    expect(findings).toContain('"id":"topic_probe:artifact_chain_invalid"');
    expect(findings).not.toContain('"recommended_transition":"advance"');
  });

  it("delegates a hash-bound topic-probe successor without a graph target or human pause", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-topic-probe-delegation-"));
    process.chdir(root);

    const run = makeRun("run-review-topic-probe-delegation");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put(
      "run_brief.raw",
      ["# Research Brief", "", "## Research Mode", "topic_discovery"].join("\n")
    );
    await writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify(reviewAnalysisReportFixture(), null, 2),
      "utf8"
    );

    const outcomeHash = "1".repeat(64);
    const handoffHash = "2".repeat(64);
    const gateHash = "3".repeat(64);
    const candidateId = "candidate_controlled_comparison";
    const topicId = "topic_controlled_comparison";
    topicProbeReviewMocks.source = {
      valid: true,
      reasons: [],
      portfolio: {
        candidates: [{
          source_candidate_id: candidateId,
          topic_id: topicId
        }]
      },
      contract: {
        candidate_id: candidateId,
        topic_id: topicId
      },
      decision: {
        disposition: "promote_to_confirmatory",
        next_action: "start_confirmatory_run",
        content_sha256: outcomeHash
      }
    };
    topicProbeReviewMocks.handoff = {
      evidence_stage: "confirmatory",
      content_sha256: handoffHash
    };
    topicProbeReviewMocks.gate = {
      status: "followup_required",
      paper_drafting_allowed: false,
      reason_codes: [],
      content_sha256: gateHash
    };

    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(result.transitionRecommendation).toMatchObject({
      action: "delegate_successor",
      sourceNode: "review",
      autoExecutable: true,
      evidence: [
        `Outcome SHA-256: ${outcomeHash}`,
        `Handoff SHA-256: ${handoffHash}`,
        `Gate SHA-256: ${gateHash}`,
        "Paper drafting allowed: false"
      ]
    });
    expect(result.transitionRecommendation).not.toHaveProperty("targetNode");
    expect(result.transitionRecommendation?.action).not.toBe("pause_for_human");
    expect(result.transitionRecommendation?.suggestedCommands).toEqual([]);

    const decision = await readFile(
      path.join(runDir, "review", "decision.json"),
      "utf8"
    );
    const findings = await readFile(
      path.join(runDir, "review", "findings.jsonl"),
      "utf8"
    );
    expect(decision).toContain("machine-governed successor");
    expect(findings).toContain("machine-governed successor");
    expect(decision).toContain("parent run remains blocked from paper drafting");
  });

  it("builds a manual review packet from analyze_results artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-node-"));
    process.chdir(root);

    const run = makeRun("run-review-node");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(path.join(runDir, "figures"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_measure: 0.91 }, null, 2), "utf8");
    await writeFile(path.join(runDir, "figures", "performance.svg"), "<svg></svg>\n", "utf8");
    await writeFile(
      path.join(runDir, "corpus.jsonl"),
      `${JSON.stringify({
        paper_id: "paper_1",
        title: "Reviewable Benchmark",
        abstract: "A benchmark for manual review packet testing."
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(runDir, "paper_summaries.jsonl"),
      `${JSON.stringify({
        paper_id: "paper_1",
        title: "Reviewable Benchmark",
        source_type: "full_text",
        summary: "Structured review packets benefit from explicit artifacts."
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(runDir, "evidence_store.jsonl"),
      `${JSON.stringify({
        evidence_id: "ev_1",
        paper_id: "paper_1",
        claim: "Structured review packets benefit from explicit artifacts."
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(runDir, "hypotheses.jsonl"),
      `${JSON.stringify({
        hypothesis_id: "h_1",
        text: "Manual review packets improve approval quality.",
        evidence_links: ["ev_1"]
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(runDir, "experiment_plan.yaml"),
      ['selected_design:', '  title: "Reviewable plan"', '  summary: "Validate the manual review packet flow."'].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "baseline_summary.json"),
      JSON.stringify({ baseline: "reference_series", primary_measure: 0.87 }),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "result_table.json"),
      JSON.stringify({ artifact_ref: "result_analysis.json#/results_artifact" }),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "analyze_papers_richness_summary.json"),
      JSON.stringify({ readiness: "adequate", paper_count: 5 }),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "result_analysis.json"),
      `${JSON.stringify(
        {
          analysis_version: 1,
          generated_at: new Date().toISOString(),
          mean_score: 0.91,
          metrics: { primary_measure: 0.91, seeds: [101, 102, 103] },
          objective_metric: {
            raw: "primary_measure at least 0.9",
            evaluation: {
              status: "met",
              summary: "Objective metric met: primary_measure=0.91 >= 0.9."
            },
            profile: {
              source: "default",
              preferred_metric_keys: ["primary_measure"],
              analysis_focus: [],
              paper_emphasis: [],
              assumptions: []
            }
          },
          overview: {
            objective_status: "met",
            objective_summary: "Objective metric met: primary_measure=0.91 >= 0.9.",
            execution_runs: 1
          },
          plan_context: {
            selected_design: {
              id: "design_1",
              title: "Reviewable plan",
              summary: "Validate the manual review packet flow.",
              selected_hypothesis_ids: ["h_1"],
              metrics: ["primary_measure"],
              baselines: ["reference_series"],
              evaluation_steps: ["run three confirmatory trials", "compare against the baseline"],
              risks: ["limited scope"],
              resource_notes: ["single-machine execution"]
            },
            shortlisted_designs: [],
            design_notes: [],
            implementation_notes: [],
            evaluation_notes: [],
            assumptions: []
          },
          metric_table: [],
          ...canonicalResultsFixture({
            subjectValue: 0.91,
            referenceValue: 0.87,
            judgement: "supported"
          }),
          execution_summary: {
            observation_count: 3,
            commands: [],
            sources: [],
            stderr_excerpts: []
          },
          primary_findings: ["Primary measure cleared the target threshold."],
          limitations: [],
          warnings: [],
          paper_claims: [
            {
              claim: "The candidate improved the primary metric.",
              evidence: ["primary_measure=0.91"]
            }
          ],
          figure_specs: [
            {
              id: "perf",
              title: "Performance overview",
              path: "figures/performance.svg",
              metric_keys: ["primary_measure"],
              summary: "Primary measure stayed above target."
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
                metric_key: "primary_measure",
                label: "Primary measure 95% CI",
                lower: 0.89,
                upper: 0.93,
                level: 0.95,
                sample_size: 100,
                source: "metrics",
                summary: "Primary measure stayed above target across the observed trials."
              }
            ],
            stability_metrics: [{ key: "evidence.distinct_seed_count", value: 3 }],
            effect_estimates: [
              {
                comparison_id: "declared_primary_comparison",
                metric_key: "primary_measure",
                delta: 0.04,
                direction: "positive",
                summary: "The candidate outperformed the baseline by +0.04 primary_measure."
              }
            ],
            notes: []
          },
          failure_taxonomy: [],
          synthesis: {
            source: "fallback",
            discussion_points: ["The candidate cleared the target threshold."],
            failure_analysis: ["No blocking runtime issue remained."],
            follow_up_actions: ["Proceed to paper drafting after review."],
            confidence_statement: "Confidence is high because the objective was met with a grounded result bundle."
          },
          transition_recommendation: {
            action: "advance",
            sourceNode: "analyze_results",
            targetNode: "review",
            reason: "Ready for review before paper writing.",
            confidence: 0.88,
            autoExecutable: true,
            evidence: ["primary_measure reached the configured target."],
            suggestedCommands: ["/approve"],
            generatedAt: new Date().toISOString()
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const node = createReviewNode({
      config: {
        workflow: { execution_approval_mode: "risk_ack" },
        experiments: {
          allow_network: true,
          network_policy: "declared",
          network_purpose: "logging"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: new LocalAciAdapter({ allowNetwork: false }),
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.transitionRecommendation).toMatchObject({
      action: "advance",
      targetNode: "write_paper"
    });

    const packetRaw = await readFile(path.join(runDir, "review", "review_packet.json"), "utf8");
    const packet = JSON.parse(packetRaw) as {
      objective_status: string;
      readiness: { status: string; blocking_checks: number };
      suggested_actions: string[];
    };
    expect(packet.objective_status).toBe("met");
    expect(packet.readiness.status).toBe("ready");
    expect(packet.readiness.blocking_checks).toBe(0);
    expect(packet.suggested_actions).toContain("/agent run write_paper");
    const readinessRiskArtifact = JSON.parse(
      await readFile(path.join(runDir, "review", "readiness_risks.json"), "utf8")
    ) as {
      readiness_state: string;
      risks: Array<{ category: string; status: string; risk_code: string }>;
    };
    expect(readinessRiskArtifact.readiness_state).toBe("paper_ready");
    expect(readinessRiskArtifact.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "network_dependency",
          status: "unverified",
          risk_code: "review_network_dependency_declared_logging"
        })
      ])
    );

    const checklist = await readFile(path.join(runDir, "review", "checklist.md"), "utf8");
    expect(checklist).toContain("# Review checklist");
    expect(checklist).toContain("Decision: advance -> advance");
    expect(checklist).toContain("Consensus: high");

    const decisionRaw = await readFile(path.join(runDir, "review", "decision.json"), "utf8");
    const decision = JSON.parse(decisionRaw) as { outcome: string; recommended_transition?: string };
    expect(decision.outcome).toBe("advance");
    expect(decision.recommended_transition).toBe("advance");
    const publicReviewDir = buildPublicReviewDir(root, run);
    expect(await readFile(path.join(publicReviewDir, "review_packet.json"), "utf8")).toContain(
      '"objective_status": "met"'
    );
    expect(await readFile(path.join(publicReviewDir, "checklist.md"), "utf8")).toContain("Consensus: high");
    expect(await readFile(path.join(publicReviewDir, "decision.json"), "utf8")).toContain('"outcome": "advance"');
    expect(await readFile(path.join(publicReviewDir, "readiness_risks.json"), "utf8")).toContain(
      '"review_network_dependency_declared_logging"'
    );
    expect(typeof (await readFile(path.join(publicReviewDir, "findings.jsonl"), "utf8"))).toBe("string");
    const publicRunDir = buildPublicRunOutputDir(root, run);
    expect(await readFile(path.join(publicRunDir, "results", "operator_summary.md"), "utf8")).toContain(
      "Canonical JSON artifacts remain the source of truth"
    );
    expect(await readFile(path.join(publicRunDir, "results", "operator_summary.md"), "utf8")).toContain(
      "Panel scorecard:"
    );
    expect(await readFile(path.join(runDir, "run_status.json"), "utf8")).toContain('"current_node": "review"');
    expect(await readFile(path.join(runDir, "run_completeness_checklist.json"), "utf8")).toContain('"validation_scope": "full_run"');
    expect(await readFile(path.join(publicRunDir, "results", "run_status.json"), "utf8")).toContain(
      '"recommended_next_action": "resume_review"'
    );
    expect(await readFile(path.join(publicRunDir, "results", "run_completeness_checklist.json"), "utf8")).toContain(
      `"run_id": "${run.id}"`
    );
    expect(await readFile(path.join(publicRunDir, "results", "operator_history", "0002-review.md"), "utf8")).toContain(
      "# Operator Stage Note"
    );

    const manifest = JSON.parse(await readFile(buildPublicRunManifestPath(root, run), "utf8")) as {
      generated_files: string[];
      sections?: {
        review?: {
          generated_files: string[];
        };
        results?: {
          generated_files: string[];
        };
      };
    };
    expect(manifest.generated_files).toEqual(
      expect.arrayContaining([
        "review/review_packet.json",
        "review/scorecard.json",
        "review/checklist.md",
        "review/decision.json",
        "review/findings.jsonl",
        "review/readiness_risks.json",
        "results/operator_summary.md",
        "results/run_status.json",
        "results/run_completeness_checklist.json",
        "results/operator_history/0002-review.md"
      ])
    );
    expect(manifest.sections?.review?.generated_files).toEqual(
      expect.arrayContaining([
        "review/review_packet.json",
        "review/scorecard.json",
        "review/checklist.md",
        "review/decision.json",
        "review/findings.jsonl",
        "review/readiness_risks.json"
      ])
    );
    expect(manifest.sections?.results?.generated_files).toEqual(
      expect.arrayContaining([
        "results/operator_summary.md",
        "results/run_status.json",
        "results/run_completeness_checklist.json",
        "results/operator_history/0002-review.md"
      ])
    );

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await memory.get("review.last_summary")).toContain("primary_measure=0.91");
    expect(await memory.get("review.last_decision")).toMatchObject({ outcome: "advance" });
    expect(await memory.get("review.readiness_risks")).toMatchObject({ readiness_state: "paper_ready" });
  });

  it("includes analysis risk signals and current ACL surface issues in the review panel prompt context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-risk-signals-"));
    process.chdir(root);

    const run = makeRun("run-review-risk-signals");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(path.join(runDir, "analysis"), { recursive: true });
    await mkdir(path.join(runDir, "paper"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_measure: 0.91 }, null, 2), "utf8");
    await writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify(
        {
          analysis_version: 1,
          generated_at: new Date().toISOString(),
          mean_score: 0.91,
          metrics: { primary_measure: 0.91 },
          objective_metric: {
            raw: "primary_measure at least 0.9",
            evaluation: { status: "met", summary: "Objective metric met." },
            profile: { source: "default", preferred_metric_keys: ["primary_measure"], analysis_focus: [], paper_emphasis: [], assumptions: [] }
          },
          overview: { objective_status: "met", objective_summary: "Objective metric met.", execution_runs: 1 },
          plan_context: { shortlisted_designs: [], design_notes: [], implementation_notes: [], evaluation_notes: [], assumptions: [] },
          metric_table: [{ key: "primary_measure", value: 0.91 }],
          ...canonicalResultsFixture({
            subjectValue: 0.91,
            referenceValue: 0.87,
            judgement: "supported"
          }),
          execution_summary: { observation_count: 1, commands: [], sources: [], stderr_excerpts: [] },
          primary_findings: ["Primary measure improved."],
          limitations: [],
          warnings: [],
          paper_claims: [{ claim: "Primary measure improved.", evidence: ["primary_measure=0.91"] }],
          figure_specs: [],
          supplemental_runs: [],
          external_comparisons: [],
          statistical_summary: { confidence_intervals: [], effect_estimates: [], stability_metrics: [], notes: [], total_trials: 1, executed_trials: 1, cached_trials: 0 },
          failure_taxonomy: []
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "analysis", "risk_signals.json"),
      JSON.stringify(
        [
          {
            type: "statistical_anomaly",
            severity: "critical",
            detail: "Detected statistically inconsistent metrics: significance.p_value=1.4 is outside [0,1]."
          }
        ],
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "paper", "main.tex"),
      [
        "\\documentclass[11pt]{article}",
        "\\usepackage[review]{acl}",
        "\\begin{document}",
        "\\noindent\\textbf{Keywords:} method, regularization",
        "\\section{Related Work}",
        "Prior work motivates the setting. \\cite{paperA,paperB}",
        "Prior work motivates the setting again. \\cite{paperB,paperA}",
        "\\bibliography{references}",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "paper", "citation_consistency.json"),
      JSON.stringify({ orphan_citations: [], missing_rendered_citations: ["paperC"] }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "paper", "render_validation.json"),
      JSON.stringify({ status: "fail", issues: [{ code: "template_not_preserved" }] }, null, 2),
      "utf8"
    );

    const llm = new PromptCaptureReviewLlm();
    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(llm.prompts.some((prompt) => prompt.includes("\"risk_signals\""))).toBe(true);
    expect(
      llm.prompts.some((prompt) => prompt.includes("statistically inconsistent metrics"))
    ).toBe(true);
    expect(llm.prompts.some((prompt) => prompt.includes("\"paper_surface_issues\""))).toBe(true);
    expect(llm.prompts.some((prompt) => prompt.includes("paper_acl_bibliography_style_mismatch"))).toBe(false);
    expect(llm.prompts.some((prompt) => prompt.includes("paper_acl_template_absent_keywords"))).toBe(true);
    expect(llm.prompts.some((prompt) => prompt.includes("paper_repeated_citation_bundle"))).toBe(true);
    const currentAclFindings = await readFile(path.join(runDir, "review", "findings.jsonl"), "utf8");
    expect(currentAclFindings).not.toContain("ACL bibliography style mismatch");
    expect(currentAclFindings).toContain("Template-absent keywords rendered");

    await writeFile(
      path.join(runDir, "paper", "main.tex"),
      [
        "\\documentclass[11pt]{article}",
        "\\usepackage[review]{acl}",
        "\\begin{document}",
        "\\noindent\\textbf{Keywords:} method, regularization",
        "\\section{Related Work}",
        "Prior work motivates the setting. \\cite{paperA,paperB}",
        "Prior work motivates the setting again. \\cite{paperB,paperA}",
        "\\bibliographystyle{plain}",
        "\\bibliography{references}",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    llm.prompts = [];

    const explicitStyleResult = await node.execute({ run, graph: run.graph });

    expect(explicitStyleResult.status).toBe("success");
    expect(llm.prompts.some((prompt) => prompt.includes("paper_acl_bibliography_style_mismatch"))).toBe(true);
    expect(llm.prompts.some((prompt) => prompt.includes("paper_acl_template_absent_keywords"))).toBe(true);
    const explicitStyleFindings = await readFile(path.join(runDir, "review", "findings.jsonl"), "utf8");
    expect(explicitStyleFindings).toContain("ACL bibliography style mismatch");
    expect(explicitStyleFindings).toContain("Repeated citation bundle");
  });

  it("marks missing evidence inputs as blocking", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-node-blocking-"));
    process.chdir(root);

    const run = makeRun("run-review-blocking");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_measure: 0.91 }, null, 2), "utf8");
    await writeFile(
      path.join(runDir, "result_analysis.json"),
      `${JSON.stringify(
        {
          analysis_version: 1,
          generated_at: new Date().toISOString(),
          mean_score: 0.91,
          metrics: { primary_measure: 0.91 },
          objective_metric: {
            raw: "primary_measure at least 0.9",
            evaluation: {
              status: "met",
              summary: "Objective metric met: primary_measure=0.91 >= 0.9."
            },
            profile: {
              source: "default",
              preferred_metric_keys: ["primary_measure"],
              analysis_focus: [],
              paper_emphasis: [],
              assumptions: []
            }
          },
          overview: {
            objective_status: "met",
            objective_summary: "Objective metric met: primary_measure=0.91 >= 0.9.",
            execution_runs: 1
          },
          plan_context: {
            shortlisted_designs: [],
            design_notes: [],
            implementation_notes: [],
            evaluation_notes: [],
            assumptions: []
          },
          metric_table: [],
          ...canonicalResultsFixture(),
          execution_summary: {
            observation_count: 1,
            commands: ["node run_declared_comparison.js"],
            sources: ["local_python"],
            stderr_excerpts: []
          },
          primary_findings: ["Primary measure cleared the target threshold."],
          limitations: [],
          warnings: [],
          paper_claims: [],
          figure_specs: [],
          supplemental_runs: [],
          external_comparisons: [],
          statistical_summary: {
            total_trials: 1,
            executed_trials: 1,
            cached_trials: 0,
            confidence_intervals: [],
            stability_metrics: [],
            effect_estimates: [],
            notes: []
          },
          failure_taxonomy: [],
          transition_recommendation: {
            action: "advance",
            sourceNode: "analyze_results",
            targetNode: "review",
            reason: "Ready for review before paper writing.",
            confidence: 0.88,
            autoExecutable: true,
            evidence: ["primary_measure reached the configured target."],
            suggestedCommands: ["/approve"],
            generatedAt: new Date().toISOString()
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: new LocalAciAdapter({ allowNetwork: false }),
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    const packetRaw = await readFile(path.join(runDir, "review", "review_packet.json"), "utf8");
    const packet = JSON.parse(packetRaw) as {
      readiness: { status: string; blocking_checks: number };
      checks: Array<{ label: string; status: string; detail: string }>;
      suggested_actions: string[];
    };

    expect(packet.readiness.status).toBe("blocking");
    expect(packet.readiness.blocking_checks).toBeGreaterThan(0);
    expect(packet.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Evidence bundle",
          status: "blocking",
          detail: expect.stringContaining("evidence_store.jsonl")
        })
      ])
    );
    expect(result.transitionRecommendation).toMatchObject({
      action: "backtrack_to_design",
      targetNode: "design_experiments"
    });
    expect(packet.suggested_actions).toContain("/agent review");
    expect(packet.suggested_actions).toContain("/agent jump design_experiments --force");
    const readinessRiskArtifact = JSON.parse(
      await readFile(path.join(runDir, "review", "readiness_risks.json"), "utf8")
    ) as {
      risk_count: number;
      blocked_count: number;
      risks: Array<{ category: string; status: string }>;
    };
    expect(readinessRiskArtifact.risk_count).toBeGreaterThan(0);
    expect(readinessRiskArtifact.blocked_count).toBeGreaterThan(0);
    expect(readinessRiskArtifact.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "paper_scale",
          status: "blocked"
        })
      ])
    );
  });

  it("backtracks when prior paper scientific validation reports upstream evidence gaps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-node-scientific-gate-"));
    process.chdir(root);

    const run = makeRun("run-review-scientific-gate");
    run.graph.nodeStates.write_paper.lastError =
      "write_paper generated manuscript artifacts but stopped before PDF build because the scientific quality gate failed in strict-paper mode: Abstract, Results, and Conclusion report conflicting aggregate primary outcome values. Evidence insufficiency remains in core sections; missing categories: resource measurement.";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(path.join(runDir, "figures"), { recursive: true });
    await mkdir(path.join(runDir, "paper"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_measure: 0.91 }, null, 2), "utf8");
    await writeFile(path.join(runDir, "figures", "performance.svg"), "<svg></svg>\n", "utf8");
    await writeFile(path.join(runDir, "corpus.jsonl"), `${JSON.stringify({ paper_id: "paper_1", title: "Reviewable Benchmark" })}\n`, "utf8");
    await writeFile(path.join(runDir, "paper_summaries.jsonl"), `${JSON.stringify({ paper_id: "paper_1", summary: "Evidence summary." })}\n`, "utf8");
    await writeFile(path.join(runDir, "evidence_store.jsonl"), `${JSON.stringify({ evidence_id: "ev_1", claim: "Evidence claim." })}\n`, "utf8");
    await writeFile(path.join(runDir, "hypotheses.jsonl"), `${JSON.stringify({ hypothesis_id: "h_1", text: "Hypothesis.", evidence_links: ["ev_1"] })}\n`, "utf8");
    await writeFile(path.join(runDir, "experiment_plan.yaml"), "selected_design:\n  title: Reviewable plan\n", "utf8");
    await writeFile(path.join(runDir, "baseline_summary.json"), JSON.stringify({ baseline: "reference_series", primary_measure: 0.87 }), "utf8");
    await writeFile(
      path.join(runDir, "result_table.json"),
      JSON.stringify({ artifact_ref: "result_analysis.json#/results_artifact" }),
      "utf8"
    );
    await writeFile(path.join(runDir, "analyze_papers_richness_summary.json"), JSON.stringify({ readiness: "adequate", paper_count: 5 }), "utf8");
    await writeFile(
      path.join(runDir, "paper", "scientific_validation.json"),
      JSON.stringify({
        evidence_diagnostics: {
          blocked_by_evidence_insufficiency: true,
          missing_evidence_categories: ["resource measurement"]
        }
      }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "result_analysis.json"),
      `${JSON.stringify({
        analysis_version: 1,
        generated_at: new Date().toISOString(),
        mean_score: 0.91,
        metrics: { primary_measure: 0.91 },
        objective_metric: {
          raw: "primary_measure at least 0.9",
          evaluation: { status: "met", summary: "Objective metric met: primary_measure=0.91 >= 0.9." },
          profile: { source: "default", preferred_metric_keys: ["primary_measure"], analysis_focus: [], paper_emphasis: [], assumptions: [] }
        },
        overview: { objective_status: "met", objective_summary: "Objective metric met.", execution_runs: 3 },
        plan_context: { shortlisted_designs: [], design_notes: [], implementation_notes: [], evaluation_notes: [], assumptions: [] },
        metric_table: [],
        ...canonicalResultsFixture({
          subjectValue: 0.91,
          referenceValue: 0.87,
          judgement: "supported"
        }),
        execution_summary: { observation_count: 3, commands: ["node run_declared_comparison.js"], sources: ["local_node"], stderr_excerpts: [] },
        primary_findings: ["Candidate condition exceeded baseline."],
        limitations: ["Resource measurements were not persisted."],
        warnings: [],
        paper_claims: [],
        figure_specs: [],
        supplemental_runs: [],
        external_comparisons: [],
        statistical_summary: { total_trials: 3, executed_trials: 3, cached_trials: 0, confidence_intervals: [], stability_metrics: [], effect_estimates: [], notes: [] },
        failure_taxonomy: [],
        transition_recommendation: {
          action: "advance",
          sourceNode: "analyze_results",
          targetNode: "review",
          reason: "Ready for review before paper writing.",
          confidence: 0.88,
          autoExecutable: true,
          evidence: ["primary_measure reached the configured target."],
          suggestedCommands: ["/approve"],
          generatedAt: new Date().toISOString()
        }
      }, null, 2)}\n`,
      "utf8"
    );

    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: new LocalAciAdapter({ allowNetwork: false }),
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(result.transitionRecommendation).toMatchObject({
      action: "backtrack_to_implement",
      targetNode: "implement_experiments"
    });
    const decision = JSON.parse(await readFile(path.join(runDir, "review", "decision.json"), "utf8")) as {
      outcome: string;
      recommended_transition?: string;
      blocking_finding_ids?: string[];
      required_actions?: string[];
    };
    expect(decision.outcome).toBe("backtrack_to_implement");
    expect(decision.recommended_transition).toBe("backtrack_to_implement");
    expect(decision.blocking_finding_ids).toEqual(
      expect.arrayContaining([
        "scientific_validation:blocked_by_evidence_insufficiency",
        "scientific_validation:aggregate_metric_conflict"
      ])
    );
    expect((decision.required_actions ?? []).join(" ")).toContain("resource measurement");

    const strengthening = JSON.parse(
      await readFile(path.join(runDir, "review", "node_strengthening_recommendations.json"), "utf8")
    ) as { recommendations: Array<{ node: string; priority: string; diagnostic_ids: string[] }> };
    expect(strengthening.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node: "run_experiments",
          priority: "high",
          diagnostic_ids: expect.arrayContaining(["scientific_validation:missing_resource_measurement"])
        }),
        expect.objectContaining({
          node: "write_paper",
          priority: "high",
          diagnostic_ids: expect.arrayContaining(["scientific_validation:aggregate_metric_conflict"])
        })
      ])
    );
  });

  it("collects baseline labels only from explicit V2 roles, the primary reference, and selected design", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-node-pre-summary-"));
    process.chdir(root);

    const run = makeRun("run-review-pre-summary");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(path.join(runDir, "figures"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_measure: 0.08 }, null, 2), "utf8");
    await writeFile(path.join(runDir, "figures", "performance.svg"), "<svg></svg>\n", "utf8");
    await writeFile(path.join(runDir, "corpus.jsonl"), `${JSON.stringify({ paper_id: "paper_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "paper_summaries.jsonl"), `${JSON.stringify({ paper_id: "paper_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "evidence_store.jsonl"), `${JSON.stringify({ evidence_id: "ev_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "hypotheses.jsonl"), `${JSON.stringify({ hypothesis_id: "h_1" })}\n`, "utf8");
    await writeFile(
      path.join(runDir, "experiment_plan.yaml"),
      ['selected_design:', '  title: "Baseline-aware retry"', '  summary: "Retry with the locked baseline comparison."', '  baselines:', '    - "Design reference"'].join("\n"),
      "utf8"
    );
    await writeFile(path.join(runDir, "baseline_summary.json"), JSON.stringify({ reference_series_id: "primary_reference_series" }, null, 2), "utf8");
    await writeFile(path.join(runDir, "result_table.json"), JSON.stringify({ artifact_ref: "result_analysis.json#/results_artifact" }, null, 2), "utf8");
    await mkdir(path.join(runDir, "paper"), { recursive: true });
    await writeFile(
      path.join(runDir, "paper", "compiled_page_validation.json"),
      JSON.stringify({
        status: "warn",
        outcome: "under_limit",
        compiled_pdf_page_count: 3,
        minimum_main_pages: 8,
        target_main_pages: 8,
        main_page_limit: 8,
        message: "Compiled PDF is only 3 pages, below the configured minimum_main_pages of 8."
      }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "result_analysis.json"),
      `${JSON.stringify(
        {
          analysis_version: 1,
          generated_at: new Date().toISOString(),
          mean_score: 3.1,
          metrics: {
            primary_measure: -0.25,
            comparison_contract: {
              baseline_binding: {
                source_arm_name: "ad_hoc_metric_reference"
              }
            },
            declared_metric_decoy: {
              arm_name: "ad_hoc_metric_reference",
              primary_measure: 0.333333
            }
          },
          objective_metric: {
            raw: "primary_measure",
            evaluation: {
              status: "not_met",
              summary: "Objective metric not met: primary_measure=-0.25 does not satisfy > 0."
            },
            profile: {
              source: "llm",
              primary_metric: "primary_measure",
              preferred_metric_keys: ["primary_measure"],
              analysis_focus: [],
              paper_emphasis: [],
              assumptions: []
            }
          },
          overview: {
            objective_status: "not_met",
            objective_summary: "Objective metric not met: primary_measure=-0.25 does not satisfy > 0.",
            execution_runs: 1
          },
          plan_context: {
            selected_design: {
              id: "design_1",
              title: "Baseline-aware retry",
              summary: "Retry with the locked baseline comparison.",
              selected_hypothesis_ids: ["h_1"],
              metrics: ["primary_measure"],
              baselines: ["Design reference"],
              evaluation_steps: ["rerun against the locked baseline"],
              risks: ["still only one repeat"],
              resource_notes: ["bounded local run"]
            },
            shortlisted_designs: [],
            design_notes: [],
            implementation_notes: [],
            evaluation_notes: [],
            assumptions: []
          },
          metric_table: [],
          ...canonicalResultsFixture({
            subjectValue: 0.08,
            referenceValue: 0.333333,
            judgement: "not_supported",
            referenceSeriesId: "primary_reference_series",
            referenceLabel: "Primary reference",
            referenceRole: "baseline",
            additionalSeries: [
              {
                id: "declared_baseline_series",
                label: "Declared baseline series",
                role: "baseline",
                dimensions: { source: "declared_role" }
              }
            ]
          }),
          execution_summary: {
            observation_count: 1,
            commands: ["node run_declared_comparison.js"],
            sources: ["local_python"],
            stderr_excerpts: []
          },
          primary_findings: ["The candidate underperformed the baseline."],
          limitations: [],
          warnings: [],
          paper_claims: [],
          figure_specs: [
            {
              id: "perf",
              title: "Performance overview",
              path: "figures/performance.svg",
              metric_keys: ["primary_measure"],
              summary: "The candidate underperformed the baseline."
            }
          ],
          supplemental_runs: [],
          external_comparisons: [],
          statistical_summary: {
            total_trials: 1,
            executed_trials: 1,
            cached_trials: 0,
            confidence_intervals: [],
            stability_metrics: [],
            effect_estimates: [],
            notes: []
          },
          failure_taxonomy: [],
          synthesis: {
            source: "fallback",
            discussion_points: ["The candidate underperformed the baseline."],
            failure_analysis: ["Revise the design before another run."],
            follow_up_actions: ["Backtrack to design."],
            confidence_statement: "Confidence is limited because only one bounded run exists."
          },
          transition_recommendation: {
            action: "backtrack_to_design",
            sourceNode: "analyze_results",
            targetNode: "review",
            reason: "Review the bounded negative result before the next retry.",
            confidence: 0.8,
            autoExecutable: true,
            evidence: ["primary_measure=-0.25"],
            suggestedCommands: ["/approve"],
            generatedAt: new Date().toISOString()
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: new LocalAciAdapter({ allowNetwork: false }),
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");

    const preReviewRaw = await readFile(path.join(runDir, "review", "pre_review_summary.json"), "utf8");
    const preReview = JSON.parse(preReviewRaw) as {
      baseline: string;
      prior_compiled_page_validation?: {
        status: string;
        compiled_pdf_page_count: number;
        minimum_main_pages: number;
        target_main_pages: number;
        main_page_limit: number;
      };
    };
    expect(preReview.baseline).toContain("Design reference");
    expect(preReview.baseline).toContain("Primary reference");
    expect(preReview.baseline).toContain("primary_reference_series");
    expect(preReview.baseline).toContain("Declared baseline series");
    expect(preReview.baseline).toContain("declared_baseline_series");
    expect(preReview.baseline).not.toContain("ad_hoc_metric_reference");
    expect(preReview.prior_compiled_page_validation).toMatchObject({
      status: "warn",
      compiled_pdf_page_count: 3,
      minimum_main_pages: 8,
      target_main_pages: 8,
      main_page_limit: 8
    });
    expect(await readFile(path.join(buildPublicReviewDir(root, run), "pre_review_summary.json"), "utf8")).toContain(
      "\"prior_compiled_page_validation\""
    );
  });

  it("recommends a hypothesis reset when review finds unsupported claims", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-node-hypothesis-"));
    process.chdir(root);

    const run = makeRun("run-review-hypothesis");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(path.join(runDir, "figures"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_measure: 0.62 }, null, 2), "utf8");
    await writeFile(path.join(runDir, "figures", "performance.svg"), "<svg></svg>\n", "utf8");
    await writeFile(path.join(runDir, "corpus.jsonl"), `${JSON.stringify({ paper_id: "paper_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "paper_summaries.jsonl"), `${JSON.stringify({ paper_id: "paper_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "evidence_store.jsonl"), `${JSON.stringify({ evidence_id: "ev_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "hypotheses.jsonl"), `${JSON.stringify({ hypothesis_id: "h_1" })}\n`, "utf8");
    await writeFile(
      path.join(runDir, "experiment_plan.yaml"),
      ['selected_design:', '  title: "Unsupported hypothesis plan"', '  summary: "Validate a brittle claim."'].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "result_analysis.json"),
      `${JSON.stringify(
        {
          analysis_version: 1,
          generated_at: new Date().toISOString(),
          mean_score: 0.62,
          metrics: { primary_measure: 0.62 },
          objective_metric: {
            raw: "primary_measure at least 0.9",
            evaluation: {
              status: "not_met",
              summary: "Objective metric not met: primary_measure=0.62 < 0.9."
            },
            profile: {
              source: "default",
              preferred_metric_keys: ["primary_measure"],
              analysis_focus: [],
              paper_emphasis: [],
              assumptions: []
            }
          },
          overview: {
            objective_status: "not_met",
            objective_summary: "Objective metric not met: primary_measure=0.62 < 0.9.",
            execution_runs: 1
          },
          plan_context: {
            selected_design: {
              id: "design_unsupported",
              title: "Unsupported hypothesis plan",
              summary: "Validate a brittle claim.",
              selected_hypothesis_ids: ["h_1"],
              metrics: ["primary_measure"],
              baselines: ["reference_series"],
              evaluation_steps: ["run three confirmatory trials", "compare against the baseline"],
              risks: [],
              resource_notes: []
            },
            shortlisted_designs: [],
            design_notes: [],
            implementation_notes: [],
            evaluation_notes: [],
            assumptions: []
          },
          metric_table: [],
          ...canonicalResultsFixture({
            subjectValue: 0.62,
            referenceValue: 0.71,
            judgement: "not_supported"
          }),
          execution_summary: {
            observation_count: 3,
            commands: ["node run_declared_comparison.js"],
            sources: ["local_python"],
            stderr_excerpts: []
          },
          primary_findings: ["The hypothesis is not supported by the observed comparison."],
          limitations: [],
          warnings: [],
          paper_claims: [
            {
              claim: "The candidate improved the primary metric.",
              evidence: ["primary_measure=0.62"]
            }
          ],
          figure_specs: [
            {
              id: "perf",
              title: "Performance overview",
              path: "figures/performance.svg",
              metric_keys: ["primary_measure"],
              summary: "Primary measure fell below the target."
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
                metric_key: "primary_measure",
                label: "Primary measure 95% CI",
                lower: 0.58,
                upper: 0.66,
                level: 0.95,
                sample_size: 3,
                source: "metrics",
                summary: "Primary measure remained below the objective range across confirmatory trials."
              }
            ],
            stability_metrics: [],
            effect_estimates: [
              {
                comparison_id: "declared_primary_comparison",
                metric_key: "primary_measure",
                delta: -0.09,
                direction: "negative",
                summary: "The candidate underperformed the baseline by -0.09 primary_measure."
              }
            ],
            notes: []
          },
          failure_taxonomy: [],
          synthesis: {
            source: "fallback",
            discussion_points: ["The current hypothesis is not supported."],
            failure_analysis: ["The candidate underperformed the baseline."],
            follow_up_actions: ["Revisit the hypothesis set before drafting any paper claims."],
            confidence_statement: "Confidence is moderate because the unsupported comparison is consistent across confirmatory trials."
          },
          transition_recommendation: {
            action: "backtrack_to_hypotheses",
            sourceNode: "analyze_results",
            targetNode: "generate_hypotheses",
            reason: "Current experiment outcomes do not support the shortlisted hypothesis, so the idea set should be revisited.",
            confidence: 0.93,
            autoExecutable: true,
            evidence: ["The candidate did not support the shortlisted hypothesis."],
            suggestedCommands: ["/agent jump generate_hypotheses", "/agent run generate_hypotheses"],
            generatedAt: new Date().toISOString()
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: new LocalAciAdapter({ allowNetwork: false }),
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.transitionRecommendation).toMatchObject({
      action: "backtrack_to_hypotheses",
      targetNode: "generate_hypotheses"
    });

    const packetRaw = await readFile(path.join(runDir, "review", "review_packet.json"), "utf8");
    const packet = JSON.parse(packetRaw) as { suggested_actions: string[] };
    expect(packet.suggested_actions).not.toContain("/approve");
    expect(packet.suggested_actions).toContain("/agent jump generate_hypotheses --force");
  });

  it("falls back heuristically when a reviewer refinement hangs past the timeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-node-timeout-"));
    process.chdir(root);
    process.env.AUTOLABOS_REVIEW_REFINEMENT_TIMEOUT_MS = "10";

    const run = makeRun("run-review-timeout");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_measure: 0.91 }, null, 2), "utf8");
    await writeFile(path.join(runDir, "result_analysis.json"), JSON.stringify({
      analysis_version: 1,
      generated_at: new Date().toISOString(),
      mean_score: 0.91,
      metrics: { primary_measure: 0.91 },
      objective_metric: {
        raw: "primary_measure at least 0.9",
        evaluation: { status: "met", summary: "Objective metric met." },
        profile: { source: "default", preferred_metric_keys: ["primary_measure"], analysis_focus: [], paper_emphasis: [], assumptions: [] }
      },
      overview: { objective_status: "met", objective_summary: "Objective metric met.", execution_runs: 1 },
      plan_context: { shortlisted_designs: [], design_notes: [], implementation_notes: [], evaluation_notes: [], assumptions: [] },
      metric_table: [],
      ...canonicalResultsFixture({
        subjectValue: 0.91,
        referenceValue: 0.87,
        judgement: "supported"
      }),
      execution_summary: { observation_count: 1, commands: [], sources: [], stderr_excerpts: [] },
      primary_findings: [],
      limitations: [],
      warnings: [],
      paper_claims: [],
      figure_specs: [],
      supplemental_runs: [],
      external_comparisons: [],
      statistical_summary: { total_trials: 1, executed_trials: 1, cached_trials: 0, confidence_intervals: [], stability_metrics: [], effect_estimates: [], notes: [] },
      failure_taxonomy: [],
      transition_recommendation: {
        action: "advance",
        sourceNode: "analyze_results",
        targetNode: "review",
        reason: "Ready for review.",
        confidence: 0.8,
        autoExecutable: true,
        evidence: ["primary_measure reached the configured target."],
        suggestedCommands: ["/approve"],
        generatedAt: new Date().toISOString()
      }
    }, null, 2), "utf8");

    const eventStream = new InMemoryEventStream();
    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream,
      llm: new HangingReviewLlm(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: new LocalAciAdapter({ allowNetwork: false }),
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.transitionRecommendation).toMatchObject({
      action: "backtrack_to_design",
      targetNode: "design_experiments"
    });
    expect(eventStream.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            text: expect.stringContaining("reviewer exceeded the 10ms timeout")
          })
        })
      ])
    );
    expect(await readFile(path.join(runDir, "review", "decision.json"), "utf8")).toContain("\"outcome\"");
  });

  it("repairs truncated reviewer JSON before merging the review result", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-node-repair-"));
    process.chdir(root);

    const run = makeRun("run-review-repair");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(path.join(runDir, "figures"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_measure: 0.91 }, null, 2), "utf8");
    await writeFile(path.join(runDir, "figures", "performance.svg"), "<svg></svg>\n", "utf8");
    await writeFile(path.join(runDir, "corpus.jsonl"), `${JSON.stringify({ paper_id: "paper_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "paper_summaries.jsonl"), `${JSON.stringify({ paper_id: "paper_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "evidence_store.jsonl"), `${JSON.stringify({ evidence_id: "ev_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "hypotheses.jsonl"), `${JSON.stringify({ hypothesis_id: "h_1" })}\n`, "utf8");
    await writeFile(
      path.join(runDir, "experiment_plan.yaml"),
      ['selected_design:', '  title: "Review repair plan"', '  summary: "Validate truncated review JSON repair."'].join("\n"),
      "utf8"
    );
    await writeFile(path.join(runDir, "result_analysis.json"), JSON.stringify({
      analysis_version: 1,
      generated_at: new Date().toISOString(),
      mean_score: 0.91,
      metrics: { primary_measure: 0.91 },
      objective_metric: {
        raw: "primary_measure at least 0.9",
        evaluation: { status: "met", summary: "Objective metric met." },
        profile: { source: "default", preferred_metric_keys: ["primary_measure"], analysis_focus: [], paper_emphasis: [], assumptions: [] }
      },
      overview: { objective_status: "met", objective_summary: "Objective metric met.", execution_runs: 3 },
      plan_context: {
        selected_design: {
          id: "design_1",
          title: "Review repair plan",
          summary: "Validate truncated review JSON repair.",
          selected_hypothesis_ids: ["h_1"],
          metrics: ["primary_measure"],
          baselines: ["reference_series"],
          evaluation_steps: ["run and verify"],
          risks: [],
          resource_notes: []
        },
        shortlisted_designs: [],
        design_notes: [],
        implementation_notes: [],
        evaluation_notes: [],
        assumptions: []
      },
      metric_table: [],
      ...canonicalResultsFixture({
        subjectValue: 0.91,
        referenceValue: 0.87,
        judgement: "supported"
      }),
      execution_summary: { observation_count: 3, commands: [], sources: [], stderr_excerpts: [] },
      primary_findings: ["Primary measure cleared the target threshold."],
      limitations: [],
      warnings: [],
      paper_claims: [{ claim: "The candidate improved the primary metric.", evidence: ["primary_measure=0.91"] }],
      figure_specs: [{ id: "perf", title: "Performance overview", path: "figures/performance.svg", metric_keys: ["primary_measure"], summary: "Primary measure stayed above target." }],
      supplemental_runs: [],
      external_comparisons: [],
      statistical_summary: {
        total_trials: 3,
        executed_trials: 3,
        cached_trials: 0,
        confidence_intervals: [],
        stability_metrics: [],
        effect_estimates: [],
        notes: []
      },
      failure_taxonomy: [],
      transition_recommendation: {
        action: "advance",
        sourceNode: "analyze_results",
        targetNode: "review",
        reason: "Ready for review.",
        confidence: 0.8,
        autoExecutable: true,
        evidence: ["primary_measure reached the configured target."],
        suggestedCommands: ["/approve"],
        generatedAt: new Date().toISOString()
      }
    }, null, 2), "utf8");

    const eventStream = new InMemoryEventStream();
    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream,
      llm: new TruncatedReviewJsonLlm(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: new LocalAciAdapter({ allowNetwork: false }),
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    const scorecard = await readFile(path.join(runDir, "review", "scorecard.json"), "utf8");
    expect(scorecard).toContain("LLM repaired review summary");
    expect(eventStream.history()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            text: expect.stringContaining("repaired truncated JSON")
          })
        })
      ])
    );
  });

  it("keeps repeated-seed review downgrades consistent with the write_paper transition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-node-full-grid-"));
    process.chdir(root);

    const run = makeRun("run-review-full-grid");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(path.join(runDir, "figures"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_measure: 0.0448 }, null, 2), "utf8");
    await writeFile(path.join(runDir, "figures", "performance.svg"), "<svg></svg>\n", "utf8");
    await writeFile(path.join(runDir, "corpus.jsonl"), `${JSON.stringify({ paper_id: "paper_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "paper_summaries.jsonl"), `${JSON.stringify({ paper_id: "paper_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "evidence_store.jsonl"), `${JSON.stringify({ evidence_id: "ev_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "hypotheses.jsonl"), `${JSON.stringify({ hypothesis_id: "h_1" })}\n`, "utf8");
    await writeFile(
      path.join(runDir, "experiment_plan.yaml"),
      [
        "selected_design:",
        "  title: Full-grid repeated-seed condition validation",
        "  baselines:",
        "    - reference_series",
        "  evaluation_steps:",
        "    - run five seeds per condition"
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(runDir, "baseline_summary.json"), JSON.stringify({ baseline: "reference_series" }, null, 2), "utf8");
    await writeFile(path.join(runDir, "result_table.json"), JSON.stringify({ artifact_ref: "result_analysis.json#/results_artifact" }, null, 2), "utf8");
    await writeFile(path.join(runDir, "result_analysis.json"), JSON.stringify({
      analysis_version: 1,
      generated_at: new Date().toISOString(),
      mean_score: 25,
      metrics: { primary_measure: 0.0448, seeds: [101, 102, 103, 104, 105] },
      objective_metric: {
        raw: "primary_measure >= 0.01",
        evaluation: { status: "met", summary: "Objective metric met." },
        profile: { source: "default", preferred_metric_keys: ["primary_measure"], analysis_focus: [], paper_emphasis: [], assumptions: [] }
      },
      overview: { objective_status: "met", objective_summary: "Objective metric met.", execution_runs: 25 },
      plan_context: {
        selected_design: {
          id: "full_grid",
          title: "Full-grid repeated-seed condition validation",
          summary: "Validate repeated-seed configuration comparison.",
          selected_hypothesis_ids: ["h_1"],
          metrics: ["primary_measure"],
          baselines: ["reference_series"],
          evaluation_steps: ["run five seeds per condition"],
          risks: ["The small backbone may make the effect unstable."],
          resource_notes: []
        },
        shortlisted_designs: [],
        design_notes: [],
        implementation_notes: [],
        evaluation_notes: [],
        assumptions: []
      },
      metric_table: [{ key: "primary_measure", value: 0.0448 }],
      ...canonicalResultsFixture({
        subjectValue: 0.0667,
        referenceValue: 0,
        judgement: "supported"
      }),
      execution_summary: { observation_count: 1, commands: [], sources: [], stderr_excerpts: [] },
      primary_findings: ["Selected design was analyzed with 25 executed trial(s)."],
      limitations: ["The small backbone may make the effect unstable."],
      warnings: [],
      paper_claims: [{ claim: "The strongest condition improved mean primary_measure over baseline.", evidence: ["result_analysis.json#/results_artifact/comparisons/0"] }],
      figure_specs: [{ id: "perf", title: "Performance overview", path: "figures/performance.svg", metric_keys: ["primary_measure"], summary: "Mean delta." }],
      supplemental_runs: [],
      external_comparisons: [],
      statistical_summary: {
        total_trials: 25,
        executed_trials: 25,
        cached_trials: 0,
        confidence_intervals: [{ metric_key: "primary_measure", label: "delta", lower: 0.002, upper: 0.13, level: 0.95, sample_size: 100, source: "metrics", summary: "95% CI." }],
        stability_metrics: [{ key: "evidence.distinct_seed_count", value: 5 }],
        effect_estimates: [{ comparison_id: "declared_primary_comparison", metric_key: "primary_measure", delta: 0.0667, direction: "positive", summary: "mean delta 0.0667." }],
        notes: []
      },
      failure_taxonomy: [{
        id: "scope_limit",
        category: "scope_limit",
        severity: "low",
        status: "risk",
        summary: "Scope limitation: The small backbone may make the effect unstable.",
        evidence: ["plan_context"],
        recommended_action: "Document the limitation."
      }],
      transition_recommendation: {
        action: "advance",
        sourceNode: "analyze_results",
        targetNode: "review",
        reason: "Ready for review.",
        confidence: 0.8,
        autoExecutable: true,
        evidence: ["25 repeated trials"],
        suggestedCommands: ["/approve"],
        generatedAt: new Date().toISOString()
      }
    }, null, 2), "utf8");

    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new PromptCaptureReviewLlm(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: new LocalAciAdapter({ allowNetwork: false }),
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.transitionRecommendation).toMatchObject({
      action: "advance",
      targetNode: "write_paper"
    });
    expect(result.transitionRecommendation?.reason).toContain("downgraded claim ceiling");
    expect(result.transitionRecommendation?.reason).not.toContain("no blocking review issues");

    const critique = JSON.parse(await readFile(path.join(runDir, "review", "paper_critique.json"), "utf8")) as {
      blocking_issues: Array<{ summary: string }>;
    };
    expect(critique.blocking_issues.map((issue) => issue.summary)).not.toContain("Single-run methodology coverage");
  });

  it("does not recommend write_paper when cycle cap meets a blocked_for_paper_scale critique", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-node-blocked-cycle-cap-"));
    process.chdir(root);

    const run = makeRun("run-review-blocked-cycle-cap");
    run.graph.researchCycle = 37;
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(path.join(runDir, "figures"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ primary_measure: 0.0625 }, null, 2), "utf8");
    await writeFile(path.join(runDir, "figures", "performance.svg"), "<svg></svg>\n", "utf8");
    await writeFile(path.join(runDir, "corpus.jsonl"), `${JSON.stringify({ paper_id: "paper_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "paper_summaries.jsonl"), `${JSON.stringify({ paper_id: "paper_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "evidence_store.jsonl"), `${JSON.stringify({ evidence_id: "ev_1" })}\n`, "utf8");
    await writeFile(path.join(runDir, "hypotheses.jsonl"), `${JSON.stringify({ hypothesis_id: "h_1" })}\n`, "utf8");
    await writeFile(
      path.join(runDir, "experiment_plan.yaml"),
      [
        "selected_design:",
        "  title: Single-run configuration validation",
        "  baselines:",
        "    - reference_series",
        "  evaluation_steps:",
        "    - run one bounded local trial"
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(runDir, "baseline_summary.json"), JSON.stringify({ baseline: "reference_series" }, null, 2), "utf8");
    await writeFile(path.join(runDir, "result_table.json"), JSON.stringify({ artifact_ref: "result_analysis.json#/results_artifact" }, null, 2), "utf8");
    await writeFile(path.join(runDir, "result_analysis.json"), JSON.stringify({
      analysis_version: 1,
      generated_at: new Date().toISOString(),
      mean_score: 25,
      metrics: { primary_measure: 0.0625, completed_condition_count: 8 },
      objective_metric: {
        raw: "primary_measure >= 0.01",
        evaluation: { status: "met", summary: "Objective metric met." },
        profile: { source: "default", preferred_metric_keys: ["primary_measure"], analysis_focus: [], paper_emphasis: [], assumptions: [] }
      },
      overview: { objective_status: "met", objective_summary: "Objective metric met.", execution_runs: 1 },
      plan_context: {
        selected_design: {
          id: "single_run",
          title: "Single-run configuration validation",
          summary: "Validate a bounded local configuration comparison.",
          selected_hypothesis_ids: ["h_1"],
          metrics: ["primary_measure"],
          baselines: ["reference_series"],
          evaluation_steps: ["run one bounded local trial"],
          risks: ["Specification may be underspecified and require narrower scope."],
          resource_notes: []
        },
        shortlisted_designs: [],
        design_notes: [],
        implementation_notes: [],
        evaluation_notes: [],
        assumptions: []
      },
      metric_table: [{ key: "primary_measure", value: 0.0625 }],
      ...canonicalResultsFixture({
        subjectValue: 0.0625,
        referenceValue: 0,
        judgement: "supported"
      }),
      execution_summary: { observation_count: 1, commands: [], sources: [], stderr_excerpts: [] },
      primary_findings: ["Selected design was analyzed with 1 executed trial."],
      limitations: ["Only one observed execution was recorded."],
      warnings: [],
      paper_claims: [{ claim: "The strongest condition improved mean primary_measure over baseline.", evidence: ["result_analysis.json#/results_artifact/comparisons/0"] }],
      figure_specs: [{ id: "perf", title: "Performance overview", path: "figures/performance.svg", metric_keys: ["primary_measure"], summary: "Delta." }],
      supplemental_runs: [],
      external_comparisons: [],
      statistical_summary: {
        total_trials: 1,
        executed_trials: 1,
        cached_trials: 0,
        confidence_intervals: [{ metric_key: "condition_results.candidate_series.average_primary_measure", label: "delta", lower: 0.28, upper: 0.72, level: 0.95, sample_size: 16, source: "condition_metrics", summary: "95% CI." }],
        stability_metrics: [],
        effect_estimates: [{ comparison_id: "declared_primary_comparison", metric_key: "primary_measure", delta: 0.0625, direction: "positive", summary: "delta 0.0625." }],
        notes: []
      },
      failure_taxonomy: [{
        id: "supplemental_coverage_gap",
        category: "evidence_gap",
        severity: "low",
        status: "risk",
        summary: "Supplemental confirmatory runs are missing.",
        evidence: ["warnings"],
        recommended_action: "Run confirmatory variants."
      }],
      transition_recommendation: {
        action: "advance",
        sourceNode: "analyze_results",
        targetNode: "review",
        reason: "Ready for review.",
        confidence: 0.8,
        autoExecutable: true,
        evidence: ["objective met"],
        suggestedCommands: ["/approve"],
        generatedAt: new Date().toISOString()
      }
    }, null, 2), "utf8");

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put("analyze_results.brief_evidence_assessment", {
      enabled: true,
      status: "pass",
      summary: "Brief evidence gate passed.",
      ceiling_type: "unrestricted",
      failures: [],
      warnings: [],
      actual: { executed_trials: 1, baseline_count: 1, executed_condition_count: 8, confidence_interval_count: 1, evidence_gap_count: 0, scope_limit_count: 0 },
      requirements: { minimum_baseline_count: 1, requires_confidence_intervals: true },
      checks: []
    });

    const node = createReviewNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new PromptCaptureReviewLlm(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: new LocalAciAdapter({ allowNetwork: false }),
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.transitionRecommendation?.targetNode).not.toBe("write_paper");
    expect(result.transitionRecommendation?.action).toBe("backtrack_to_implement");

    const decision = JSON.parse(await readFile(path.join(runDir, "review", "decision.json"), "utf8")) as {
      outcome: string;
      recommended_transition?: string;
      blocking_finding_ids?: string[];
      required_actions?: string[];
    };
    expect(decision.outcome).toBe("backtrack_to_implement");
    expect(decision.recommended_transition).toBe("backtrack_to_implement");
    expect((decision.blocking_finding_ids ?? []).length).toBeGreaterThan(0);
    expect((decision.required_actions ?? []).join(" ").toLowerCase()).toContain("seed");

    const reviewPacket = JSON.parse(await readFile(path.join(runDir, "review", "review_packet.json"), "utf8")) as {
      decision?: { outcome?: string; recommended_transition?: string };
    };
    expect(reviewPacket.decision?.outcome).toBe("backtrack_to_implement");
    expect(reviewPacket.decision?.recommended_transition).toBe("backtrack_to_implement");

    const critique = JSON.parse(await readFile(path.join(runDir, "review", "paper_critique.json"), "utf8")) as {
      manuscript_type: string;
      claim_ceiling_applied: boolean;
      needs_additional_experiments: boolean;
      needs_additional_statistics: boolean;
    };
    expect(critique.manuscript_type).toBe("blocked_for_paper_scale");
    expect(critique.claim_ceiling_applied).toBe(true);
    expect(critique.needs_additional_experiments).toBe(true);
    expect(critique.needs_additional_statistics).toBe(true);
  });
});
