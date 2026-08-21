import { describe, expect, it } from "vitest";

import { buildBaselineComparisonSurface } from "../src/core/baselineComparisonSurface.js";
import {
  validateResultsArtifactV2,
  type ResultsArtifactV2
} from "../src/core/analysis/resultsTableSchema.js";
import type { BaselineLock } from "../src/core/exploration/types.js";
import type { AnalysisReport } from "../src/core/resultAnalysis.js";

const GENERATED_AT = "2026-04-07T00:00:00.000Z";

function makeArtifact(): ResultsArtifactV2 {
  return {
    schema_version: "2.0",
    metrics: [
      {
        id: "measure-q7",
        label: "Opaque measure Q",
        direction: "lower_better",
        unit: "points"
      },
      {
        id: "measure-r9",
        label: "Opaque measure R",
        direction: "higher_better",
        unit: "ratio"
      }
    ],
    series: [
      {
        id: "reference-series",
        label: "Reference display",
        role: "baseline",
        dimensions: { partition: "evaluation" }
      },
      {
        id: "subject-series-west",
        label: "Subject display west",
        role: "primary",
        dimensions: { partition: "evaluation" }
      },
      {
        id: "subject-series-east",
        label: "Subject display east",
        role: "comparator",
        dimensions: { partition: "evaluation" }
      }
    ],
    observations: [
      {
        id: "observation-reference-q7",
        series_id: "reference-series",
        metric_id: "measure-q7",
        scope: { partition: "evaluation" },
        value: 10
      },
      {
        id: "observation-subject-q7",
        series_id: "subject-series-west",
        metric_id: "measure-q7",
        scope: { partition: "evaluation" },
        value: 7
      },
      {
        id: "observation-reference-r9",
        series_id: "reference-series",
        metric_id: "measure-r9",
        scope: { partition: "evaluation" },
        value: 0.4
      },
      {
        id: "observation-subject-r9",
        series_id: "subject-series-east",
        metric_id: "measure-r9",
        scope: { partition: "evaluation" },
        value: 0.5
      }
    ],
    comparisons: [
      {
        id: "comparison-q7",
        subject_observation_id: "observation-subject-q7",
        reference_observation_id: "observation-reference-q7",
        delta: -3
      },
      {
        id: "comparison-r9",
        subject_observation_id: "observation-subject-r9",
        reference_observation_id: "observation-reference-r9",
        delta: 0.1
      }
    ]
  };
}

function renameArtifactIds(artifact: ResultsArtifactV2): ResultsArtifactV2 {
  const renamed = structuredClone(artifact);
  const metricIds = new Map([
    ["measure-q7", "token-h4"],
    ["measure-r9", "token-j6"]
  ]);
  const seriesIds = new Map([
    ["reference-series", "series-z8"],
    ["subject-series-west", "series-c2"],
    ["subject-series-east", "series-f5"]
  ]);
  const observationIds = new Map([
    ["observation-reference-q7", "observation-k3"],
    ["observation-subject-q7", "observation-p6"],
    ["observation-reference-r9", "observation-t4"],
    ["observation-subject-r9", "observation-w1"]
  ]);
  const comparisonIds = new Map([
    ["comparison-q7", "link-v2"],
    ["comparison-r9", "link-c8"]
  ]);

  for (const metric of renamed.metrics) {
    metric.id = metricIds.get(metric.id)!;
  }
  for (const series of renamed.series) {
    series.id = seriesIds.get(series.id)!;
  }
  for (const observation of renamed.observations) {
    observation.series_id = seriesIds.get(observation.series_id)!;
    observation.metric_id = metricIds.get(observation.metric_id)!;
    observation.id = observationIds.get(observation.id)!;
  }
  for (const comparison of renamed.comparisons) {
    comparison.id = comparisonIds.get(comparison.id)!;
    comparison.subject_observation_id = observationIds.get(comparison.subject_observation_id)!;
    comparison.reference_observation_id = observationIds.get(comparison.reference_observation_id)!;
  }
  return renamed;
}

function makeReport(resultsArtifact: unknown): AnalysisReport {
  return {
    results_artifact: resultsArtifact,
    metrics: {},
    condition_comparisons: []
  } as unknown as AnalysisReport;
}

function makeLock(): BaselineLock {
  return {
    locked_at: GENERATED_AT,
    run_id: "run-surface",
    baseline_hash: "baseline-hash",
    dataset_slice_hash: "dataset-hash",
    evaluator_hash: "evaluator-hash",
    seed_policy: "fixed-seed",
    environment_fingerprint: "node|linux|timestamp",
    allowed_intervention_dimensions: ["configured_component"],
    forbidden_concurrent_changes: [["configured_component", "evaluation_partition"]]
  };
}

function buildSurface(
  resultsArtifact: unknown,
  options: { comparisonId?: string; baselineLock?: BaselineLock | null } = {}
) {
  return buildBaselineComparisonSurface({
    runId: "run-surface",
    report: makeReport(resultsArtifact),
    baselineLock: options.baselineLock === undefined ? makeLock() : options.baselineLock,
    generatedAt: GENERATED_AT,
    comparisonId: options.comparisonId
  });
}

describe("baselineComparisonSurface", () => {
  it("projects validated role-bound comparisons and preserves explicit lower_better direction", () => {
    const artifact = makeArtifact();
    expect(validateResultsArtifactV2(artifact)).toEqual({ valid: true, issues: [] });

    const surface = buildSurface(artifact, { comparisonId: "comparison-q7" });

    expect(surface.status).toBe("available");
    expect(surface.primary_comparison).toMatchObject({
      id: "comparison-q7",
      label: "comparison-q7",
      source: "results_artifact",
      hypothesis_supported: null
    });
    expect(surface.primary_comparison?.metrics).toEqual([
      {
        metric: "measure-q7",
        baseline_value: 10,
        comparator_value: 7,
        delta: -3,
        direction: "lower_better"
      }
    ]);
    expect(surface.comparisons.map((comparison) => comparison.id)).toEqual([
      "comparison-q7",
      "comparison-r9"
    ]);
    expect(surface.enforcement).toMatchObject({
      baseline_lock_present: true,
      single_change_dimension_limit: 1,
      allowed_intervention_dimensions: ["configured_component"],
      forbidden_concurrent_changes: [["configured_component", "evaluation_partition"]],
      lock_fingerprints: {
        baseline_hash: "baseline-hash",
        dataset_slice_hash: "dataset-hash",
        evaluator_hash: "evaluator-hash",
        seed_policy: "fixed-seed"
      }
    });
    expect(surface.warnings).toEqual([]);
  });

  it("is invariant to metric, series, observation, and comparison array order", () => {
    const artifact = makeArtifact();
    const reordered = structuredClone(artifact);
    reordered.metrics.reverse();
    reordered.series.reverse();
    reordered.observations.reverse();
    reordered.comparisons.reverse();

    expect(buildSurface(reordered, { comparisonId: "comparison-r9" })).toEqual(
      buildSurface(artifact, { comparisonId: "comparison-r9" })
    );
  });

  it("ignores display labels when resolving roles and direction", () => {
    const artifact = makeArtifact();
    const renamed = structuredClone(artifact);
    renamed.metrics[0].label = "Reward display";
    renamed.metrics[1].label = "Error display";
    renamed.series.find((series) => series.role === "baseline")!.label = "Subject display";
    renamed.series.find((series) => series.role === "primary")!.label = "Reference display";
    renamed.series.find((series) => series.role === "comparator")!.label = "Highest score";

    expect(buildSurface(renamed, { comparisonId: "comparison-q7" })).toEqual(
      buildSurface(artifact, { comparisonId: "comparison-q7" })
    );
  });

  it("follows explicit links after an opaque id rename", () => {
    const renamed = renameArtifactIds(makeArtifact());
    expect(validateResultsArtifactV2(renamed)).toEqual({ valid: true, issues: [] });

    const surface = buildSurface(renamed, { comparisonId: "link-v2" });

    expect(surface.primary_comparison).toMatchObject({
      id: "link-v2",
      metrics: [
        {
          metric: "token-h4",
          baseline_value: 10,
          comparator_value: 7,
          delta: -3,
          direction: "lower_better"
        }
      ]
    });
  });

  it("does not infer a primary comparison from a unique measured comparison", () => {
    const artifact = makeArtifact();
    artifact.comparisons = artifact.comparisons.filter(
      (comparison) => comparison.id === "comparison-q7"
    );

    const surface = buildSurface(artifact);

    expect(surface.status).toBe("available");
    expect(surface.primary_comparison).toBeNull();
    expect(surface.warnings).toEqual([
      "Measured baseline comparisons are available, but primary comparison is unmeasured without an explicit comparison id."
    ]);
  });

  it("does not choose an array-first primary comparison when selection is ambiguous", () => {
    const surface = buildSurface(makeArtifact());

    expect(surface.status).toBe("available");
    expect(surface.primary_comparison).toBeNull();
    expect(surface.warnings).toEqual([
      "Measured baseline comparisons are available, but primary comparison is unmeasured without an explicit comparison id."
    ]);
  });

  it("fails closed when required series roles are absent", () => {
    const artifact = makeArtifact();
    delete artifact.series.find((series) => series.id === "reference-series")!.role;
    expect(validateResultsArtifactV2(artifact)).toEqual({
      valid: false,
      issues: [
        "results_artifact.comparisons[0] requires reference series role baseline; received unspecified.",
        "results_artifact.comparisons[1] requires reference series role baseline; received unspecified."
      ]
    });

    const surface = buildSurface(artifact, { comparisonId: "comparison-q7" });

    expect(surface.status).toBe("missing");
    expect(surface.primary_comparison).toBeNull();
    expect(surface.comparisons).toEqual([]);
    expect(surface.warnings).toEqual([
      "ResultsArtifactV2 validation failed; baseline comparison is unmeasured. results_artifact.comparisons[0] requires reference series role baseline; received unspecified. results_artifact.comparisons[1] requires reference series role baseline; received unspecified.",
      'The explicit comparison selector "comparison-q7" does not resolve to a measured baseline comparison.'
    ]);
  });

  it.each([
    {
      caseName: "a dangling reference",
      expectedIssue: "references unknown observation id",
      mutate(artifact: ResultsArtifactV2) {
        artifact.comparisons[0].reference_observation_id = "observation-absent";
      }
    },
    {
      caseName: "a cross-metric pair",
      expectedIssue: "same metric",
      mutate(artifact: ResultsArtifactV2) {
        artifact.comparisons[0].reference_observation_id = "observation-reference-r9";
      }
    },
    {
      caseName: "an inconsistent delta",
      expectedIssue: "must equal subject value minus reference value",
      mutate(artifact: ResultsArtifactV2) {
        artifact.comparisons[0].delta = -2;
      }
    }
  ])("fails closed for $caseName without recovering arbitrary report data", ({ mutate, expectedIssue }) => {
    const artifact = makeArtifact();
    mutate(artifact);
    const report = makeReport(artifact);
    report.condition_comparisons = [
      {
        id: "untrusted-comparison",
        label: "Untrusted comparison",
        source: "metrics.result_rows",
        metrics: [
          {
            key: "untrusted-measure",
            primary_value: 99,
            baseline_value: 0
          }
        ],
        summary: "This data is outside the canonical artifact."
      }
    ];
    report.metrics = {
      result_rows: [
        { condition_id: "reference-condition", untrusted_measure: 0 },
        { condition_id: "subject-condition", untrusted_measure: 99 }
      ]
    };

    const surface = buildBaselineComparisonSurface({
      runId: "run-surface",
      report,
      baselineLock: makeLock(),
      generatedAt: GENERATED_AT,
      comparisonId: "untrusted-comparison"
    });

    expect(surface.status).toBe("missing");
    expect(surface.primary_comparison).toBeNull();
    expect(surface.comparisons).toEqual([]);
    expect(surface.warnings.join(" ")).toContain("ResultsArtifactV2 validation failed");
    expect(surface.warnings.join(" ")).toContain(expectedIssue);
  });

  it("reports a missing surface when the canonical artifact and baseline lock are absent", () => {
    const surface = buildSurface(undefined, { baselineLock: null });

    expect(surface.status).toBe("missing");
    expect(surface.primary_comparison).toBeNull();
    expect(surface.comparisons).toEqual([]);
    expect(surface.enforcement.baseline_lock_present).toBe(false);
    expect(surface.warnings.join(" ")).toContain("ResultsArtifactV2 validation failed");
    expect(surface.warnings.join(" ")).toContain("No BaselineLock artifact");
  });
});
