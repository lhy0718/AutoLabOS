import { describe, expect, it } from "vitest";

import {
  projectResultsArtifactV2,
  type ResultsArtifactProjectionResult
} from "../src/core/analysis/resultsArtifactProjection.js";
import type { ResultsArtifactV2 } from "../src/core/analysis/resultsTableSchema.js";
import type { ExperimentContract } from "../src/core/experiments/experimentContract.js";
import {
  buildResultsArtifactValidation
} from "../src/core/nodes/analyzeResults.js";
import {
  buildAnalysisReport,
  parseAnalysisReport,
  type AnalysisReport
} from "../src/core/resultAnalysis.js";
import type {
  ObjectiveMetricEvaluation,
  ObjectiveMetricProfile
} from "../src/core/objectiveMetric.js";

describe("canonical ResultsArtifactV2 analysis contract", () => {
  it("keeps an explicit V2 artifact authoritative without serializing results_table", () => {
    const explicit = buildExplicitArtifact();
    const report = buildReport(
      {
        results_artifact: explicit,
        primary_condition: "candidate_b",
        baseline_condition: "reference_b",
        conditions: [
          {
            condition_id: "reference_b",
            metrics: { primary_score: -100 }
          },
          {
            condition_id: "candidate_b",
            metrics: { primary_score: 100 }
          }
        ]
      }
    );

    expect(report.results_artifact).toEqual(explicit);
    expect(report.results_artifact.series).toHaveLength(3);
    expect(report.results_artifact.observations.map((item) => item.scope)).toEqual([
      { partition: "validation", repeat: 1 },
      { partition: "validation", repeat: 1 },
      { partition: "validation", repeat: 1 }
    ]);
    expect(report.metric_table).toHaveLength(3);
    expect(report.metric_table).toEqual(expect.arrayContaining([
      { key: "primary_score", value: 0.6 },
      { key: "primary_score", value: 0.5 },
      { key: "primary_score", value: 0.4 }
    ]));
    expect(
      (JSON.parse(JSON.stringify(report)) as AnalysisReport).results_artifact
    ).toEqual(JSON.parse(JSON.stringify(report.results_artifact)));
    expect(report).not.toHaveProperty("results_table");
  });

  it("does not synthesize V2 observations from numeric-key fallbacks and blocks the empty contract", () => {
    const metrics = {
      baseline_primary_score: 0.2,
      comparator_primary_score: 0.8,
      primary_primary_score: 0.9
    };
    const projection = projectResultsArtifactV2({
      metrics,
      primaryMetricId: "primary_score"
    });
    const report = buildReport(metrics, projection);
    const validation = buildResultsArtifactValidation({ report, projection });

    expect(report.results_artifact).toEqual({
      schema_version: "2.0",
      metrics: [],
      series: [],
      observations: [],
      comparisons: []
    });
    expect(report.metric_table).toHaveLength(3);
    expect(validation).toMatchObject({
      valid: false,
      requiresObservationEvidence: true
    });
    expect(validation.issues).toEqual([
      expect.stringContaining("requires numeric observations")
    ]);
  });

  it("adapts a historical results_table only at the AnalysisReport reader boundary", () => {
    const report = parseAnalysisReport(JSON.stringify({
      results_table: [
        {
          metric: "primary_score",
          baseline: 0.25,
          comparator: 0.5,
          delta: 0.25,
          direction: "higher_better"
        }
      ]
    }));

    expect(report?.results_table).toHaveLength(1);
    expect(report?.results_artifact.schema_version).toBe("2.0");
    expect(report?.results_artifact.observations).toHaveLength(2);
    expect(report?.results_artifact.comparisons).toHaveLength(1);
  });

  it("blocks an invalid explicit V2 artifact instead of using generic fallback rows", () => {
    const projection = projectResultsArtifactV2({
      metrics: {
        results_artifact: {
          schema_version: "1.0",
          metrics: [],
          series: [],
          observations: [],
          comparisons: []
        },
        baseline_condition: "reference",
        primary_condition: "candidate_a",
        conditions: [
          { condition_id: "reference", metrics: { primary_score: 0.1 } },
          { condition_id: "candidate_a", metrics: { primary_score: 0.9 } }
        ]
      }
    });
    const report = buildReport({}, projection);
    const validation = buildResultsArtifactValidation({
      report,
      projection,
      experimentContract: buildComparisonContract()
    });

    expect(projection.blocked).toBe(true);
    expect(projection.artifact.observations).toEqual([]);
    expect(report.metric_table).toEqual([]);
    expect(validation.valid).toBe(false);
    expect(validation.blocked).toBe(true);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("cannot fall back"),
        expect.stringContaining("requires numeric observations"),
        expect.stringContaining("requires at least one explicit comparison")
      ])
    );
  });

  it("keeps generic metric projection read-only when a V2 experiment contract exists", () => {
    const projection = projectResultsArtifactV2({
      metrics: {
        primary_condition: "candidate_a",
        baseline_condition: "reference",
        metric_definitions: {
          primary_score: {
            label: "Primary score",
            direction: "higher_better",
            unit: "ratio"
          }
        },
        condition_results: [
          {
            condition_id: "reference",
            role: "baseline",
            scope: { partition: "validation", repeat: 1 },
            metrics: { primary_score: 0.4 }
          },
          {
            condition_id: "candidate_a",
            role: "primary",
            scope: { partition: "validation", repeat: 1 },
            metrics: { primary_score: 0.6 }
          }
        ]
      },
      primaryMetricId: "primary_score"
    });
    const report = buildReport({}, projection);
    const validation = buildResultsArtifactValidation({
      report,
      projection,
      experimentContract: buildComparisonContract()
    });

    expect(projection.source).toBe("generic_metrics");
    expect(projection.artifact.observations).toHaveLength(2);
    expect(projection.artifact.comparisons).toHaveLength(1);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toContain(
      "ExperimentContract V2 requires metrics.results_artifact; generic metric projection is read-only compatibility and cannot satisfy a new governed run."
    );
  });

  it("treats declared comparison requirements as gates, not numeric templates", () => {
    const projection = projectResultsArtifactV2({
      metrics: {
        metric_definitions: {
          primary_score: {
            label: "Primary score",
            direction: "higher_better",
            unit: "ratio"
          }
        },
        conditions: [
          { condition_id: "candidate_a", label: "High score", metrics: { primary_score: 0.9 } },
          { condition_id: "reference", label: "Low score", metrics: { primary_score: 0.1 } }
        ]
      },
      primaryMetricId: "primary_score"
    });
    const report = buildReport({}, projection);
    const validation = buildResultsArtifactValidation({
      report,
      projection,
      experimentContract: buildComparisonContract()
    });

    expect(projection.valid).toBe(true);
    expect(projection.artifact.observations).toHaveLength(2);
    expect(projection.artifact.series.every((series) => series.role === undefined)).toBe(true);
    expect(projection.artifact.comparisons).toEqual([]);
    expect(validation).toMatchObject({
      valid: false,
      blocked: false,
      requiresObservationEvidence: true,
      requiresComparisonEvidence: true
    });
    expect(validation.issues).toEqual(
      expect.arrayContaining([expect.stringContaining("incomplete or ambiguous")])
    );
  });

  it("rejects an artifact that changes the frozen metric direction", () => {
    const explicit = buildExplicitArtifact();
    explicit.metrics[0].direction = "lower_better";
    const projection = projectResultsArtifactV2({ metrics: { results_artifact: explicit } });
    const report = buildReport({}, projection);

    const validation = buildResultsArtifactValidation({
      report,
      projection,
      experimentContract: buildComparisonContract()
    });

    expect(validation.valid).toBe(false);
    expect(validation.issues).toContain(
      `results_plan.required_metrics[0] requires direction "higher_better" for metric "primary_score", received "lower_better".`
    );
  });
});

function buildReport(
  metrics: Record<string, unknown>,
  resultsArtifactProjection?: ResultsArtifactProjectionResult
): AnalysisReport {
  const objectiveProfile: ObjectiveMetricProfile = {
    source: "heuristic_fallback",
    raw: "primary_score >= 0",
    primaryMetric: "primary_score",
    preferredMetricKeys: ["primary_score"],
    direction: "maximize",
    comparator: ">=",
    targetValue: 0,
    analysisFocus: [],
    paperEmphasis: [],
    assumptions: []
  };
  const objectiveEvaluation: ObjectiveMetricEvaluation = {
    rawObjectiveMetric: objectiveProfile.raw,
    profileSource: objectiveProfile.source,
    primaryMetric: objectiveProfile.primaryMetric,
    preferredMetricKeys: objectiveProfile.preferredMetricKeys,
    matchedMetricKey: objectiveProfile.primaryMetric,
    direction: objectiveProfile.direction,
    comparator: objectiveProfile.comparator,
    targetValue: objectiveProfile.targetValue,
    observedValue: 0.5,
    status: "met",
    summary: "The declared primary score was observed."
  };
  return buildAnalysisReport({
    run: { objectiveMetric: objectiveProfile.raw },
    metrics,
    objectiveProfile,
    objectiveEvaluation,
    resultsArtifactProjection
  });
}

function buildComparisonContract(): ExperimentContract {
  return {
    version: 2,
    run_id: "neutral-run",
    created_at: "2026-01-01T00:00:00.000Z",
    hypothesis: "A declared intervention changes the primary score.",
    causal_mechanism: "The intervention changes the measured process.",
    single_change: "Apply the declared intervention.",
    confounded: false,
    expected_metric_effect: "Increase primary_score.",
    abort_condition: "Stop on invalid measurements.",
    keep_or_discard_rule: "Keep only with explicit comparative evidence.",
    baselines: ["reference"],
    results_plan: {
      schema_version: "2.0",
      required_metrics: [
        {
          id: "primary_score",
          label: "Primary score",
          direction: "higher_better",
          unit: "ratio"
        }
      ],
      minimum_series_count: 2,
      minimum_comparison_count: 1,
      required_series: [
        { id: "reference", role: "baseline" },
        { id: "candidate_a", role: "primary" }
      ],
      required_comparisons: [
        {
          id: "candidate_a_vs_reference",
          subject_series_id: "candidate_a",
          reference_series_id: "reference",
          metric_id: "primary_score",
          scope: { partition: "validation", repeat: 1 }
        }
      ],
      primary_comparison_id: "candidate_a_vs_reference"
    }
  };
}

function buildExplicitArtifact(): ResultsArtifactV2 {
  return {
    schema_version: "2.0",
    metrics: [
      {
        id: "primary_score",
        label: "Primary score",
        direction: "higher_better",
        unit: "ratio"
      }
    ],
    series: [
      {
        id: "reference",
        label: "Reference",
        role: "baseline",
        dimensions: { protocol: "reference" }
      },
      {
        id: "candidate_a",
        label: "Candidate A",
        role: "primary",
        dimensions: { protocol: "candidate" }
      },
      {
        id: "candidate_b",
        label: "Candidate B",
        role: "comparator",
        dimensions: { protocol: "replication" }
      }
    ],
    observations: [
      {
        id: "reference_observation",
        series_id: "reference",
        metric_id: "primary_score",
        scope: { partition: "validation", repeat: 1 },
        value: 0.4
      },
      {
        id: "candidate_a_observation",
        series_id: "candidate_a",
        metric_id: "primary_score",
        scope: { partition: "validation", repeat: 1 },
        value: 0.6
      },
      {
        id: "candidate_b_observation",
        series_id: "candidate_b",
        metric_id: "primary_score",
        scope: { partition: "validation", repeat: 1 },
        value: 0.5
      }
    ],
    comparisons: [
      {
        id: "candidate_a_vs_reference",
        subject_observation_id: "candidate_a_observation",
        reference_observation_id: "reference_observation",
        delta: 0.2
      },
      {
        id: "candidate_b_vs_reference",
        subject_observation_id: "candidate_b_observation",
        reference_observation_id: "reference_observation",
        delta: 0.1
      }
    ]
  };
}
