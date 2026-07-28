import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryEventStream } from "../src/core/events.js";
import { MockLLMClient } from "../src/core/llm/client.js";
import {
  createAnalyzeResultsNode,
  hydrateDetailedExperimentMetrics
} from "../src/core/nodes/analyzeResults.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import type { ResultsArtifactV2 } from "../src/core/analysis/resultsTableSchema.js";
import type { ExperimentContract } from "../src/core/experiments/experimentContract.js";
import type { RunRecord } from "../src/types.js";

const temporaryDirectories: string[] = [];
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeDetailedResults(value: Record<string, unknown>): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "autolabos-result-hydration-"));
  temporaryDirectories.push(directory);
  const resultsPath = path.join(directory, "detailed_results.json");
  writeFileSync(resultsPath, JSON.stringify(value), "utf8");
  return resultsPath;
}

describe("hydrateDetailedExperimentMetrics", () => {
  it("adds only the metric named by a compact metric/value pair", async () => {
    const hydrated = await hydrateDetailedExperimentMetrics(
      {
        status: "completed",
        metric: "quality_gain",
        value: 0.125,
        auxiliary_measure: 0.8
      },
      undefined
    );

    expect(hydrated).toEqual({
      status: "completed",
      metric: "quality_gain",
      value: 0.125,
      auxiliary_measure: 0.8,
      quality_gain: 0.125
    });
  });

  it("preserves detailed global scalars, protocol, seeds, repeats, and confidence intervals", async () => {
    const detailedResults = {
      global_metrics: {
        aggregate_quality: 0.64,
        assessment: "measured",
        validated: true,
        note: null,
        distribution: { median: 0.62 }
      },
      protocol: {
        repeats: 3,
        seed_schedule: [101, 202, 303],
        comparison: "paired"
      },
      seeds: [101, 202, 303],
      sampling_profile: {
        total_trials: 3,
        executed_trials: 3
      },
      repeat_records: [
        { repeat_id: "repeat_a", metrics: { aggregate_quality: 0.61 } },
        { repeat_id: "repeat_b", metrics: { aggregate_quality: 0.64 } },
        { repeat_id: "repeat_c", metrics: { aggregate_quality: 0.67 } }
      ],
      confidence_intervals: {
        aggregate_quality: { lower: 0.6, upper: 0.68, level: 0.95 }
      },
      condition_metrics: {
        selected_condition: {
          role: "primary",
          quality_measure: 0.2,
          repeat_values: [0.18, 0.2, 0.22],
          confidence_interval: { lower: 0.17, upper: 0.23, level: 0.95 }
        },
        reference_condition: {
          role: "baseline",
          quality_measure: 0.9,
          repeat_values: [0.88, 0.9, 0.92]
        }
      },
      primary_condition: "selected_condition",
      baseline_condition: "reference_condition"
    };
    const resultsPath = writeDetailedResults(detailedResults);

    const hydrated = await hydrateDetailedExperimentMetrics(
      {
        status: "completed",
        results_path: resultsPath,
        aggregate_quality: 0.7
      },
      undefined
    );

    expect(hydrated.aggregate_quality).toBe(0.7);
    expect(hydrated.assessment).toBe("measured");
    expect(hydrated.validated).toBe(true);
    expect(hydrated.note).toBeNull();
    expect(hydrated).not.toHaveProperty("distribution");
    expect(hydrated.global_metrics).toEqual(detailedResults.global_metrics);
    expect(hydrated.protocol).toEqual(detailedResults.protocol);
    expect(hydrated.seeds).toEqual(detailedResults.seeds);
    expect(hydrated.sampling_profile).toEqual(detailedResults.sampling_profile);
    expect(hydrated.repeat_records).toEqual(detailedResults.repeat_records);
    expect(hydrated.confidence_intervals).toEqual(detailedResults.confidence_intervals);
    expect(hydrated.condition_metrics).toEqual(detailedResults.condition_metrics);
    expect(hydrated.primary_condition).toBe("selected_condition");
    expect(hydrated.baseline_condition).toBe("reference_condition");
  });

  it("normalizes every generic condition row shape without leaking row metadata", async () => {
    const hydrated = await hydrateDetailedExperimentMetrics(
      {
        conditions: [
          {
            condition_id: "candidate_condition_a",
            role: "primary",
            metrics: {
              quality_measure: 0.2,
              repeat_values: [0.18, 0.2, 0.22]
            },
            sample_count: 3,
            display_label: "Candidate A",
            invalid_measurement: Number.POSITIVE_INFINITY
          }
        ],
        condition_results: [
          {
            condition: "baseline_condition",
            role: "baseline",
            metrics: {
              quality_measure: 0.9,
              confidence_interval: { lower: 0.86, upper: 0.94, level: 0.95 }
            },
            duration_seconds: 2.5
          }
        ],
        condition_summaries: [
          {
            name: "candidate_condition_b",
            metrics: { quality_measure: 0.4 },
            observed_count: 5
          }
        ],
        per_condition: [
          {
            id: "candidate_condition_c",
            metrics: { quality_measure: 0.5 },
            repeat_count: 2
          }
        ]
      },
      undefined
    );

    expect(hydrated.condition_metrics).toEqual({
      candidate_condition_a: {
        quality_measure: 0.2,
        repeat_values: [0.18, 0.2, 0.22],
        sample_count: 3
      },
      baseline_condition: {
        quality_measure: 0.9,
        confidence_interval: { lower: 0.86, upper: 0.94, level: 0.95 },
        duration_seconds: 2.5
      },
      candidate_condition_b: {
        quality_measure: 0.4,
        observed_count: 5
      },
      candidate_condition_c: {
        quality_measure: 0.5,
        repeat_count: 2
      }
    });
    expect(hydrated.primary_condition).toBe("candidate_condition_a");
    expect(hydrated.baseline_condition).toBe("baseline_condition");
    expect(hydrated).not.toHaveProperty("quality_measure");
  });

  it("does not infer condition roles or surface a condition metric from performance order", async () => {
    const hydrated = await hydrateDetailedExperimentMetrics(
      {
        global_metrics: {
          best_condition: "candidate_condition_b",
          worst_condition: "candidate_condition_a"
        },
        condition_metrics: {
          candidate_condition_a: { quality_measure: 0.1 },
          candidate_condition_b: { quality_measure: 0.9 }
        }
      },
      undefined
    );

    expect(hydrated.primary_condition).toBeUndefined();
    expect(hydrated.baseline_condition).toBeUndefined();
    expect(hydrated.quality_measure).toBeUndefined();
    expect(hydrated.condition_metrics).toEqual({
      candidate_condition_a: { quality_measure: 0.1 },
      candidate_condition_b: { quality_measure: 0.9 }
    });
  });

  it("keeps explicit condition declarations ahead of conflicting roles", async () => {
    const hydrated = await hydrateDetailedExperimentMetrics(
      {
        primary_condition: "declared_primary_condition",
        baseline_condition: "declared_baseline_condition",
        condition_metrics: {
          declared_primary_condition: { quality_measure: 0.2 },
          declared_baseline_condition: { quality_measure: 0.8 },
          role_primary_condition: { role: "primary", quality_measure: 0.95 },
          role_baseline_condition: { role: "baseline", quality_measure: 0.05 }
        }
      },
      undefined
    );

    expect(hydrated.primary_condition).toBe("declared_primary_condition");
    expect(hydrated.baseline_condition).toBe("declared_baseline_condition");
  });
});

describe("analyze_results canonical ResultsArtifactV2 runtime", () => {
  it("writes the same authoritative V2 object to result_analysis and result_table", async () => {
    const explicitArtifact = buildRuntimeArtifact();
    const fixture = prepareAnalyzeRuntime({
      outcome_measure: 0.6,
      results_artifact: explicitArtifact,
      conditions: [
        {
          condition_id: "ignored_reference",
          role: "baseline",
          metrics: { outcome_measure: -10 }
        },
        {
          condition_id: "ignored_candidate",
          role: "primary",
          metrics: { outcome_measure: 10 }
        }
      ]
    });

    const result = await fixture.node.execute({ run: fixture.run, graph: fixture.run.graph });
    const analysis = readJson(path.join(fixture.runDir, "result_analysis.json"));
    const standalone = readJson(path.join(fixture.runDir, "result_table.json"));

    expect(result.status).toBe("success");
    expect(analysis.results_artifact).toEqual(explicitArtifact);
    expect(standalone).toEqual(analysis.results_artifact);
    expect(analysis).not.toHaveProperty("results_table");
    expect(analysis.metrics).not.toHaveProperty("results_artifact");
  });

  it("rewrites objective_evaluation.json after hydrated metrics change the decision", async () => {
    const explicitArtifact = buildRuntimeArtifact();
    const fixture = prepareAnalyzeRuntime({
      outcome_measure: 0.6,
      results_artifact: explicitArtifact
    });
    writeFileSync(
      path.join(fixture.runDir, "objective_evaluation.json"),
      JSON.stringify({
        rawObjectiveMetric: fixture.run.objectiveMetric,
        profileSource: "heuristic_fallback",
        primaryMetric: "outcome_measure",
        preferredMetricKeys: ["outcome_measure"],
        matchedMetricKey: "outcome_measure",
        direction: "maximize",
        comparator: ">=",
        targetValue: 0.5,
        observedValue: 0.1,
        status: "not_met",
        summary: "Stale pre-hydration decision."
      }, null, 2),
      "utf8"
    );

    const result = await fixture.node.execute({ run: fixture.run, graph: fixture.run.graph });
    const evaluation = readJson(path.join(fixture.runDir, "objective_evaluation.json"));

    expect(result.status).toBe("success");
    expect(evaluation).toMatchObject({
      rawObjectiveMetric: "outcome_measure >= 0.5",
      matchedMetricKey: "outcome_measure",
      observedValue: 0.6,
      status: "met"
    });
  });

  it("keeps invalid explicit V2 fail-closed and pauses instead of projecting fallback rows", async () => {
    const fixture = prepareAnalyzeRuntime({
      outcome_measure: 0.8,
      results_artifact: {
        schema_version: "1.0",
        metrics: [],
        series: [],
        observations: [],
        comparisons: []
      },
      baseline_condition: "fallback_reference",
      primary_condition: "fallback_candidate",
      conditions: [
        {
          condition_id: "fallback_reference",
          metrics: { outcome_measure: 0.2 }
        },
        {
          condition_id: "fallback_candidate",
          metrics: { outcome_measure: 0.8 }
        }
      ]
    });

    const result = await fixture.node.execute({ run: fixture.run, graph: fixture.run.graph });
    const analysis = readJson(path.join(fixture.runDir, "result_analysis.json"));
    const standalone = readJson(path.join(fixture.runDir, "result_table.json"));
    const eventText = fixture.eventStream.history()
      .map((event) => String(event.payload.text ?? ""))
      .join("\n");

    expect(result.transitionRecommendation).toMatchObject({
      action: "pause_for_human",
      reason: "incomplete_results_table",
      autoExecutable: false
    });
    expect(analysis.results_artifact).toEqual({
      schema_version: "2.0",
      metrics: [],
      series: [],
      observations: [],
      comparisons: []
    });
    expect(standalone).toEqual(analysis.results_artifact);
    expect(analysis.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("present but invalid"),
        expect.stringContaining("cannot fall back")
      ])
    );
    expect(eventText).toContain("Results artifact projection (explicit_results_artifact)");
    expect(eventText).toContain("Results artifact validation");
  });

  it.each([
    {
      name: "missing explicit comparison roles",
      metrics: {
        outcome_measure: 0.7,
        conditions: [
          {
            condition_id: "series_alpha",
            label: "Higher observed value",
            metrics: { outcome_measure: 0.7 }
          },
          {
            condition_id: "series_beta",
            label: "Lower observed value",
            metrics: { outcome_measure: 0.3 }
          }
        ]
      },
      warning: "requires at least one explicit comparison"
    },
    {
      name: "ambiguous duplicate series",
      metrics: {
        outcome_measure: 0.7,
        baseline_condition: "reference_series",
        primary_condition: "duplicate_series",
        conditions: [
          {
            condition_id: "reference_series",
            metrics: { outcome_measure: 0.3 }
          },
          {
            condition_id: "duplicate_series",
            metrics: { outcome_measure: 0.6 }
          },
          {
            condition_id: "duplicate_series",
            metrics: { outcome_measure: 0.7 }
          }
        ]
      },
      warning: "duplicated or ambiguous"
    }
  ])("pauses an incomplete comparison: $name", async ({ metrics, warning }) => {
    const fixture = prepareAnalyzeRuntime(metrics);

    const result = await fixture.node.execute({ run: fixture.run, graph: fixture.run.graph });
    const analysis = readJson(path.join(fixture.runDir, "result_analysis.json"));

    expect(result.transitionRecommendation).toMatchObject({
      action: "pause_for_human",
      reason: "incomplete_results_table",
      autoExecutable: false
    });
    expect(analysis.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining(warning)])
    );
  });

  it("routes a topic-discovery probe with a missing artifact chain to structural review without marking it keep", async () => {
    const fixture = prepareAnalyzeRuntime({
      outcome_measure: 0.6,
      sampling_profile: { total_trials: 2, executed_trials: 2, cached_trials: 0 },
      results_artifact: buildRuntimeArtifact()
    });
    writeFileSync(
      path.join(fixture.runDir, "memory", "run_context.json"),
      JSON.stringify({
        version: 1,
        items: [{
          key: "run_brief.raw",
          value: "# Research Brief\n\n## Research Mode\n\ntopic_discovery\n",
          updatedAt: new Date().toISOString()
        }]
      }),
      "utf8"
    );

    const result = await fixture.node.execute({ run: fixture.run, graph: fixture.run.graph });
    const gate = readJson(path.join(fixture.runDir, "analysis", "topic_probe_outcome_gate.json"));
    const attempt = JSON.parse(
      readFileSync(path.join(fixture.runDir, "attempt_decisions.jsonl"), "utf8").trim()
    ) as { verdict?: string };

    expect(result.status).toBe("success");
    expect(result.transitionRecommendation).toMatchObject({
      action: "advance",
      targetNode: "figure_audit",
      autoExecutable: true
    });
    expect(result.transitionRecommendation?.reason).toContain("Paper drafting is forbidden");
    expect(gate).toMatchObject({
      artifact_kind: "topic_probe_outcome_gate",
      status: "blocked_invalid_artifact_chain",
      disposition: null
    });
    expect(gate.reason_codes).toContain("research_gap_map_missing");
    expect(attempt.verdict).toBe("needs_design_revision");
  });
});

function prepareAnalyzeRuntime(metrics: Record<string, unknown>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "autolabos-results-v2-runtime-"));
  temporaryDirectories.push(root);
  process.chdir(root);
  const runId = `neutral-runtime-${temporaryDirectories.length}`;
  const runDir = path.join(root, ".autolabos", "runs", runId);
  mkdirSync(path.join(runDir, "memory"), { recursive: true });
  writeFileSync(path.join(runDir, "metrics.json"), JSON.stringify(metrics, null, 2), "utf8");
  writeFileSync(
    path.join(runDir, "experiment_contract.json"),
    JSON.stringify(buildRuntimeContract(runId), null, 2),
    "utf8"
  );

  const graph = createDefaultGraphState();
  graph.currentNode = "analyze_results";
  const run: RunRecord = {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Neutral comparative run",
    topic: "Generic intervention evaluation",
    constraints: [],
    objectiveMetric: "outcome_measure >= 0.5",
    status: "running",
    currentNode: "analyze_results",
    nodeThreads: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    graph,
    memoryRefs: {
      runContextPath: `.autolabos/runs/${runId}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${runId}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${runId}/memory/episodes.jsonl`
    }
  };
  const eventStream = new InMemoryEventStream();
  const node = createAnalyzeResultsNode({
    config: {} as never,
    runStore: {} as never,
    eventStream,
    llm: new MockLLMClient(),
    codex: {} as never,
    aci: {} as never,
    semanticScholar: {} as never
  });

  return { run, runDir, eventStream, node };
}

function buildRuntimeContract(runId: string): ExperimentContract {
  return {
    version: 1,
    run_id: runId,
    created_at: "2026-01-01T00:00:00.000Z",
    hypothesis: "A declared intervention changes the outcome measure.",
    causal_mechanism: "The intervention changes the measured process.",
    single_change: "Apply the declared intervention.",
    confounded: false,
    expected_metric_effect: "Increase outcome_measure.",
    abort_condition: "Stop on invalid measurements.",
    keep_or_discard_rule: "Keep only with explicit comparative evidence.",
    baselines: ["declared_reference"],
    metrics: ["outcome_measure"],
    results_table_schema: [
      {
        metric: "outcome_measure",
        baseline: null,
        comparator: null,
        delta: null,
        direction: "higher_better"
      }
    ]
  };
}

function buildRuntimeArtifact(): ResultsArtifactV2 {
  return {
    schema_version: "2.0",
    metrics: [
      {
        id: "outcome_measure",
        label: "Outcome measure",
        direction: "higher_better",
        unit: "unitless"
      }
    ],
    series: [
      {
        id: "reference_series",
        label: "Reference series",
        role: "baseline",
        dimensions: { protocol: "reference" }
      },
      {
        id: "candidate_series",
        label: "Candidate series",
        role: "primary",
        dimensions: { protocol: "candidate" }
      }
    ],
    observations: [
      {
        id: "reference-observation",
        series_id: "reference_series",
        metric_id: "outcome_measure",
        scope: { partition: "validation" },
        value: 0.4
      },
      {
        id: "candidate-observation",
        series_id: "candidate_series",
        metric_id: "outcome_measure",
        scope: { partition: "validation" },
        value: 0.6
      }
    ],
    comparisons: [
      {
        id: "candidate-vs-reference",
        subject_observation_id: "candidate-observation",
        reference_observation_id: "reference-observation",
        delta: 0.2
      }
    ]
  };
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, any>;
}
