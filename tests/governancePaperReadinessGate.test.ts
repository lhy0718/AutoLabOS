import { describe, expect, it } from "vitest";

import { evaluateMinimumGate, type MinimumGateInput } from "../src/core/analysis/paperMinimumGate.js";
import type { AnalysisReport } from "../src/core/resultAnalysis.js";
import type { ReviewArtifactPresence } from "../src/core/reviewSystem.js";

function completePresence(overrides: Partial<ReviewArtifactPresence> = {}): ReviewArtifactPresence {
  return {
    corpusPresent: true,
    paperSummariesPresent: true,
    evidenceStorePresent: true,
    hypothesesPresent: true,
    experimentPlanPresent: true,
    metricsPresent: true,
    figurePresent: true,
    synthesisPresent: true,
    baselineSummaryPresent: true,
    resultTablePresent: true,
    richnessSummaryPresent: true,
    richnessReadiness: "adequate",
    ...overrides
  };
}

function completeReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  const resultsArtifact = {
    schema_version: "2.0" as const,
    metrics: [
      {
        id: "outcome_measure",
        label: "Outcome measure",
        direction: "higher_better" as const
      }
    ],
    series: [
      {
        id: "series_reference",
        label: "Reference series",
        role: "baseline" as const,
        dimensions: {}
      },
      {
        id: "series_subject",
        label: "Subject series",
        role: "primary" as const,
        dimensions: {}
      }
    ],
    observations: [
      {
        id: "observation_reference",
        series_id: "series_reference",
        metric_id: "outcome_measure",
        scope: {},
        value: 0.7
      },
      {
        id: "observation_subject",
        series_id: "series_subject",
        metric_id: "outcome_measure",
        scope: {},
        value: 0.75
      }
    ],
    comparisons: [
      {
        id: "comparison_primary",
        subject_observation_id: "observation_subject",
        reference_observation_id: "observation_reference",
        delta: 0.05,
        judgement: "supported"
      }
    ]
  };
  return {
    overview: {
      objective_status: "met",
      objective_summary: "The declared outcome target was met.",
      execution_runs: 3
    },
    results_artifact: resultsArtifact,
    primary_comparison_id: "comparison_primary",
    condition_comparisons: [
      {
        id: "comparison_primary",
        label: "Subject series vs reference series",
        source: "results_artifact",
        subject_series_id: "series_subject",
        reference_series_id: "series_reference",
        metric_id: "outcome_measure",
        metric_direction: "higher_better",
        metrics: [
          {
            key: "outcome_measure",
            value: 0.05,
            direction: "higher_better",
            subject_value: 0.75,
            reference_value: 0.7
          }
        ],
        hypothesis_supported: true,
        summary: "The subject series was compared with the declared reference."
      }
    ],
    primary_findings: [
      {
        id: "finding-1",
        title: "Measured comparison",
        finding: "The method has measured task results.",
        confidence: 0.8,
        source: "result_analysis"
      }
    ],
    paper_claims: [
      {
        claim: "The subject series improves the declared outcome measure.",
        evidence: [{ type: "metric", reference: "result_analysis.json#/results_artifact/comparisons/0", detail: "delta reported" }]
      }
    ],
    limitations: [],
    warnings: [],
    statistical_summary: {
      total_trials: 3,
      executed_trials: 3,
      cached_trials: 0,
      confidence_intervals: [],
      stability_metrics: [],
      effect_estimates: [],
      notes: []
    },
    shortlisted_designs: [],
    recommendations: [],
    ...overrides
  } as AnalysisReport;
}

function inputFor(overrides: Partial<MinimumGateInput> = {}): MinimumGateInput {
  return {
    presence: completePresence(),
    report: completeReport(),
    topic: "Governance paper-readiness gate fixture",
    objectiveMetric: "outcome_measure >= 0.05",
    ...overrides
  };
}

describe("governance paper-readiness gate", () => {
  it.each([
    {
      taskId: "case-missing-baseline",
      input: inputFor({
        presence: completePresence({ baselineSummaryPresent: false }),
        report: completeReport({
          primary_comparison_id: undefined,
          condition_comparisons: [],
          results_artifact: {
            ...completeReport().results_artifact,
            series: completeReport().results_artifact.series.filter(
              (series) => series.role !== "baseline"
            ),
            observations: completeReport().results_artifact.observations.filter(
              (observation) => observation.series_id !== "series_reference"
            ),
            comparisons: []
          }
        })
      }),
      failedCheck: "baseline_or_comparator"
    },
    {
      taskId: "case-unsupported-claim",
      input: inputFor({
        presence: completePresence({ evidenceStorePresent: false })
      }),
      failedCheck: "claim_evidence_linkage"
    },
    {
      taskId: "case-incomplete-results",
      input: inputFor({
        report: completeReport({
          results_artifact: {
            ...completeReport().results_artifact,
            comparisons: []
          }
        })
      }),
      failedCheck: "results_artifact_comparison"
    },
    {
      taskId: "case-stale-state",
      input: inputFor({
        presence: completePresence({ metricsPresent: false })
      }),
      failedCheck: "executed_result"
    },
    {
      taskId: "case-fallback-only",
      input: inputFor({
        presence: completePresence({ hypothesesPresent: false }),
        report: completeReport({ primary_findings: [] })
      }),
      failedCheck: "not_smoke_only"
    }
  ])("$taskId cannot pass as paper-ready while its intended evidence gap remains", ({ input, failedCheck }) => {
    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.ceiling_type).not.toBe("unrestricted");
    expect(result.failed_checks).toContain(failedCheck);
  });
});
