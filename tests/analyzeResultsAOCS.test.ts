import { describe, it, expect } from "vitest";
import { deriveConditionMetricsFromAOCS } from "../src/core/nodes/analyzeResults.js";
import { evaluateObjectiveMetric } from "../src/core/objectiveMetric.js";

describe("deriveConditionMetricsFromAOCS", () => {
  it("converts aggregate_overall_condition_summary to condition_metrics", () => {
    const aocs = [
      {
        model_family: "xgboost",
        calibration: "raw",
        macro_f1_mean: 0.72,
        brier_score_mean: 0.08,
        ece_adaptive_mean: 0.06,
        outer_fold_count: 24
      },
      {
        model_family: "logistic_regression",
        calibration: "raw",
        macro_f1_mean: 0.65,
        brier_score_mean: 0.12,
        ece_adaptive_mean: 0.14,
        outer_fold_count: 24
      },
      {
        model_family: "rbf_svm",
        calibration: "isotonic",
        macro_f1_mean: 0.66,
        brier_score_mean: 0.08,
        ece_adaptive_mean: 0.03,
        outer_fold_count: 24
      }
    ];

    const result = deriveConditionMetricsFromAOCS(aocs);

    // Should produce 3 condition entries
    expect(Object.keys(result.conditionMetrics)).toHaveLength(3);
    expect(result.conditionMetrics).toHaveProperty("xgboost_raw");
    expect(result.conditionMetrics).toHaveProperty("logistic_regression_raw");
    expect(result.conditionMetrics).toHaveProperty("rbf_svm_isotonic");

    // _mean suffix should be stripped
    expect(result.conditionMetrics["xgboost_raw"]).toHaveProperty("macro_f1", 0.72);
    expect(result.conditionMetrics["xgboost_raw"]).toHaveProperty("brier_score", 0.08);

    // outer_fold_count should be excluded
    expect(result.conditionMetrics["xgboost_raw"]).not.toHaveProperty("outer_fold_count");

    // Primary should be best macro_f1, baseline should be worst
    expect(result.primaryCondition).toBe("xgboost_raw");
    expect(result.baselineCondition).toBe("logistic_regression_raw");
  });

  it("returns empty when aocs is empty", () => {
    const result = deriveConditionMetricsFromAOCS([]);
    expect(Object.keys(result.conditionMetrics)).toHaveLength(0);
    expect(result.primaryCondition).toBeUndefined();
  });

  it("handles entries without calibration field", () => {
    const aocs = [
      { model_family: "xgboost", macro_f1_mean: 0.8 },
      { model_family: "logreg", macro_f1_mean: 0.6 }
    ];
    const result = deriveConditionMetricsFromAOCS(aocs);
    expect(Object.keys(result.conditionMetrics)).toHaveLength(2);
    expect(result.conditionMetrics).toHaveProperty("xgboost");
    expect(result.conditionMetrics).toHaveProperty("logreg");
  });
});

describe("AOCS top-level metric surfacing for objective evaluation", () => {
  it("evaluateObjectiveMetric finds macro_f1 when AOCS-derived top-level exists", () => {
    // Simulate metrics AFTER deriveConditionMetricsFromAOCSIfNeeded:
    // - rank_reversal_count exists as top-level
    // - macro_f1 is surfaced from primary condition
    const metrics: Record<string, unknown> = {
      rank_reversal_count: 2,
      beneficial_count: 4,
      macro_f1: 0.7179,  // surfaced from AOCS primary condition
      brier_score: 0.0817,
      condition_metrics: {
        xgboost_raw: { macro_f1: 0.7179, brier_score: 0.0817 },
        logistic_regression_raw: { macro_f1: 0.65, brier_score: 0.12 }
      }
    };

    const profile = {
      source: "llm" as const,
      raw: "macro-F1",
      primaryMetric: "macro-F1",
      preferredMetricKeys: ["macro_f1", "brier_score", "rank_reversal_count"],
      direction: "maximize" as const,
      assumptions: []
    };

    const result = evaluateObjectiveMetric(metrics, profile, "macro-F1");

    // Should match macro_f1 (index 0 in preferredKeys), NOT rank_reversal_count (index 2)
    expect(result.matchedMetricKey).toBe("macro_f1");
    expect(result.observedValue).toBe(0.7179);
    expect(result.status).toBe("observed");
  });

  it("falls back to rank_reversal_count when no macro_f1 top-level exists", () => {
    const metrics: Record<string, unknown> = {
      rank_reversal_count: 2,
      beneficial_count: 4
    };

    const profile = {
      source: "llm" as const,
      raw: "macro-F1",
      primaryMetric: "macro-F1",
      preferredMetricKeys: ["macro_f1", "rank_reversal_count"],
      direction: "maximize" as const,
      assumptions: []
    };

    const result = evaluateObjectiveMetric(metrics, profile, "macro-F1");

    // Without top-level macro_f1, should fall back to rank_reversal_count
    expect(result.matchedMetricKey).toBe("rank_reversal_count");
  });
});
