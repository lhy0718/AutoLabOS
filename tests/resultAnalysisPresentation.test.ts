import { describe, expect, it } from "vitest";

import type { ResultsArtifactV2 } from "../src/core/analysis/resultsTableSchema.js";
import { buildAnalyzeResultsInsightCard } from "../src/core/resultAnalysisPresentation.js";

function presentationArtifact(includeAlternate = false): ResultsArtifactV2 {
  const artifact: ResultsArtifactV2 = {
    schema_version: "2.0",
    metrics: [
      {
        id: "primary_score",
        label: "Primary score",
        direction: "higher_better",
        unit: "unitless"
      }
    ],
    series: [
      {
        id: "candidate_a",
        label: "Candidate A",
        role: "primary",
        dimensions: { partition: "validation_partition" }
      },
      {
        id: "reference",
        label: "Reference",
        role: "baseline",
        dimensions: { partition: "validation_partition" }
      }
    ],
    observations: [
      {
        id: "candidate_a_observation",
        series_id: "candidate_a",
        metric_id: "primary_score",
        scope: { partition: "validation_partition" },
        value: 0.74
      },
      {
        id: "reference_observation",
        series_id: "reference",
        metric_id: "primary_score",
        scope: { partition: "validation_partition" },
        value: 0.77
      }
    ],
    comparisons: [
      {
        id: "declared_comparison",
        subject_observation_id: "candidate_a_observation",
        reference_observation_id: "reference_observation",
        delta: -0.03,
        judgement: "not_supported"
      }
    ]
  };

  if (!includeAlternate) {
    return artifact;
  }

  return {
    ...artifact,
    series: [
      ...artifact.series,
      {
        id: "candidate_b",
        label: "Candidate B",
        role: "comparator",
        dimensions: { partition: "validation_partition" }
      }
    ],
    observations: [
      ...artifact.observations,
      {
        id: "candidate_b_observation",
        series_id: "candidate_b",
        metric_id: "primary_score",
        scope: { partition: "validation_partition" },
        value: 0.8
      }
    ],
    comparisons: [
      ...artifact.comparisons,
      {
        id: "candidate_b_comparison",
        subject_observation_id: "candidate_b_observation",
        reference_observation_id: "reference_observation",
        delta: 0.03,
        judgement: "supported"
      }
    ]
  };
}

describe("resultAnalysisPresentation", () => {
  it("surfaces explicit series labels, judgement, and recommendation actions", () => {
    const card = buildAnalyzeResultsInsightCard({
      results_artifact: presentationArtifact(),
      primary_comparison_id: "declared_comparison",
      overview: {
        objective_status: "not_met",
        objective_summary: "The declared objective was not met under the current setup."
      },
      failure_taxonomy: [
        {
          id: "objective_not_met",
          category: "objective_gap",
          severity: "high",
          status: "observed",
          summary: "The declared target was missed.",
          evidence: ["objective_metric.evaluation.summary"]
        }
      ],
      transition_recommendation: {
        action: "backtrack_to_hypotheses",
        sourceNode: "analyze_results",
        targetNode: "generate_hypotheses",
        reason: "The explicit comparison does not support the shortlisted hypothesis.",
        confidence: 0.91,
        autoExecutable: true,
        evidence: ["The declared comparison judgement is not_supported."],
        suggestedCommands: ["/agent jump generate_hypotheses", "/agent run generate_hypotheses"],
        generatedAt: new Date().toISOString()
      },
      synthesis: {
        source: "llm",
        discussion_points: ["The current evidence does not support the intended claim."],
        failure_analysis: ["Objective not met."],
        follow_up_actions: ["Revisit the hypothesis set before the next experiment."],
        confidence_statement: "Confidence is moderate because the explicit comparison contradicts the hypothesis."
      },
      condition_comparisons: [
        {
          id: "stale_projection",
          label: "Stale projection",
          source: "results_artifact",
          subject_series_id: "stale_subject",
          reference_series_id: "stale_reference",
          subject_label: "Stale subject",
          reference_label: "Stale reference",
          metric_id: "stale_measure",
          metric_direction: "higher_better",
          judgement: "supported",
          hypothesis_supported: true,
          summary: "Stale compatibility projection.",
          metrics: [
            {
              key: "stale_measure",
              value: 99,
              direction: "higher_better",
              subject_value: 100,
              reference_value: 1
            }
          ]
        }
      ],
      statistical_summary: {
        total_trials: 3,
        executed_trials: 3,
        cached_trials: 0,
        confidence_intervals: [
          {
            metric_key: "primary_score",
            label: "Primary score interval",
            lower: 0.71,
            upper: 0.76,
            level: 0.95,
            source: "metrics",
            summary: "The declared interval remained below the target threshold."
          }
        ],
        stability_metrics: [],
        effect_estimates: [
          {
            comparison_id: "declared_comparison",
            metric_key: "primary_score",
            delta: -0.03,
            direction: "negative",
            summary: "Candidate A trails Reference on Primary score by 0.03."
          }
        ],
        notes: ["The explicit effect estimate is negative."]
      },
      figure_specs: [
        {
          id: "performance_overview",
          title: "Performance overview",
          path: "figures/performance.svg",
          metric_keys: ["primary_score"],
          summary: "The declared primary_score decreased."
        }
      ],
      primary_findings: ["Candidate A did not meet the declared objective."],
      limitations: ["Only one confirmatory configuration was executed."],
      warnings: [],
      mean_score: 0.74
    } as any);

    expect(card.lines.some((line) => line.includes("Recommendation: backtrack_to_hypotheses"))).toBe(true);
    expect(card.lines.some((line) => line.startsWith("Why:"))).toBe(true);
    expect(card.lines.some((line) => line.startsWith("Evidence:"))).toBe(true);
    expect(card.actions?.map((item) => item.command)).toEqual(["/agent apply", "/agent overnight"]);
    const comparisonReference = card.references?.find((item) => item.kind === "comparison");
    expect(comparisonReference?.path).toBe("result_analysis.json#/results_artifact/comparisons/0");
    expect(comparisonReference?.facts).toEqual(
      expect.arrayContaining([
        { label: "Comparison ID", value: "declared_comparison" },
        { label: "Metric", value: "primary_score" },
        { label: "Delta", value: "-0.03" }
      ])
    );
    expect(comparisonReference?.details).toEqual(
      expect.arrayContaining([
        "Comparison link: result_analysis.json#/results_artifact/comparisons/0.",
        "Judgement: not_supported (hypothesis support: no)."
      ])
    );
    expect(comparisonReference?.details?.some((line) => (
      line.includes("result_analysis.json#/results_artifact/observations/0") &&
      line.includes("result_analysis.json#/results_artifact/observations/1")
    ))).toBe(true);
    const statisticsReference = card.references?.find((item) => item.kind === "statistics");
    expect(statisticsReference?.path).toBe("result_analysis.json#/results_artifact/comparisons/0");
    expect(statisticsReference?.details).toEqual(
      expect.arrayContaining([
        "Comparison link: result_analysis.json#/results_artifact/comparisons/0.",
        "Effect direction: negative for primary_score.",
        "The declared interval remained below the target threshold."
      ])
    );
    expect(JSON.stringify(card.references)).not.toContain("stale_projection");
    expect(JSON.stringify(card.references)).not.toContain("Stale compatibility projection.");
  });

  it("fails closed for ambiguous comparisons and honors an exact primary ID", () => {
    const report = {
      results_artifact: presentationArtifact(true),
      overview: {
        objective_status: "observed",
        objective_summary: "The declared objective was observed."
      },
      failure_taxonomy: [],
      statistical_summary: {
        total_trials: 2,
        executed_trials: 2,
        cached_trials: 0,
        confidence_intervals: [],
        stability_metrics: [],
        effect_estimates: [],
        notes: []
      },
      figure_specs: [],
      primary_findings: [],
      limitations: [],
      warnings: [],
      condition_comparisons: [
        {
          id: "stale_projection",
          label: "Stale projection",
          source: "results_artifact",
          metrics: [{ key: "stale_measure", value: 99 }],
          summary: "Stale compatibility projection."
        }
      ],
      mean_score: 0.77
    } as any;

    const ambiguous = buildAnalyzeResultsInsightCard(report);
    expect(ambiguous.references?.some((item) => item.kind === "comparison")).toBe(false);
    expect(ambiguous.references?.some((item) => item.kind === "statistics")).toBe(false);

    const selected = buildAnalyzeResultsInsightCard({
      ...report,
      primary_comparison_id: "candidate_b_comparison"
    });
    const selectedComparison = selected.references?.find((item) => item.kind === "comparison");
    expect(selectedComparison?.label).toBe("Comparison: Candidate B vs Reference");
    expect(selectedComparison?.path).toBe("result_analysis.json#/results_artifact/comparisons/1");
    expect(selectedComparison?.facts).toEqual(expect.arrayContaining([
      { label: "Comparison ID", value: "candidate_b_comparison" },
      { label: "Delta", value: "+0.03" }
    ]));
    expect(selectedComparison?.details).toEqual(expect.arrayContaining([
      "Comparison link: result_analysis.json#/results_artifact/comparisons/1."
    ]));
  });

  it("fails closed for partial historical analysis reports", () => {
    const card = buildAnalyzeResultsInsightCard({
      primary_findings: ["Previous analysis artifact without overview fields."]
    } as any);

    expect(card.title).toBe("Result analysis");
    expect(card.lines[0]).toContain("Objective: unknown");
    expect(card.lines[0]).toContain("Objective evaluation unavailable.");
    expect(card.references?.some((item) => item.kind === "comparison")).toBe(false);
  });
});
