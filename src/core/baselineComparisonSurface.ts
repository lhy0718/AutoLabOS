import { AnalysisConditionComparison, AnalysisReport } from "./resultAnalysis.js";
import type { BaselineLock } from "./exploration/types.js";
import { INTERVENTION_DIMENSION_COUNT_LIMIT } from "./exploration/singleChangeEnforcer.js";

export interface BaselineComparisonMetricSurface {
  metric: string;
  baseline_value: number;
  comparator_value: number;
  delta: number;
  direction: "higher_better" | "lower_better";
}

export interface BaselineComparisonEntrySurface {
  id: string;
  label: string;
  source: AnalysisConditionComparison["source"];
  summary: string;
  hypothesis_supported: boolean | null;
  metrics: BaselineComparisonMetricSurface[];
}

export interface BaselineComparisonSurface {
  version: 1;
  generated_at: string;
  run_id: string;
  status: "available" | "missing";
  source_artifacts: string[];
  enforcement: {
    baseline_lock_present: boolean;
    single_change_dimension_limit: number;
    allowed_intervention_dimensions: string[];
    forbidden_concurrent_changes: string[][];
    lock_fingerprints?: {
      baseline_hash: string;
      dataset_slice_hash: string;
      evaluator_hash: string;
      seed_policy: string;
    };
  };
  primary_comparison: BaselineComparisonEntrySurface | null;
  comparisons: BaselineComparisonEntrySurface[];
  warnings: string[];
}

export function buildBaselineComparisonSurface(input: {
  runId: string;
  report: AnalysisReport;
  baselineLock?: BaselineLock | null;
  generatedAt?: string;
}): BaselineComparisonSurface {
  const comparisons = (input.report.condition_comparisons ?? [])
    .map((comparison) => buildComparisonEntry(comparison, input.report))
    .filter((comparison) => comparison.metrics.length > 0);
  const warnings: string[] = [];
  if (comparisons.length === 0) {
    warnings.push("No baseline/comparator comparison with paired numeric values was found in result_analysis.json.");
  }
  if (!input.baselineLock) {
    warnings.push("No BaselineLock artifact was found; single-change enforcement may still be unavailable for exploration branches.");
  }

  return {
    version: 1,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    run_id: input.runId,
    status: comparisons.length > 0 ? "available" : "missing",
    source_artifacts: ["result_analysis.json", "result_table.json", "experiment_tree/baseline_lock.json"],
    enforcement: {
      baseline_lock_present: Boolean(input.baselineLock),
      single_change_dimension_limit: INTERVENTION_DIMENSION_COUNT_LIMIT,
      allowed_intervention_dimensions: input.baselineLock?.allowed_intervention_dimensions ?? [],
      forbidden_concurrent_changes: input.baselineLock?.forbidden_concurrent_changes ?? [],
      lock_fingerprints: input.baselineLock
        ? {
            baseline_hash: input.baselineLock.baseline_hash,
            dataset_slice_hash: input.baselineLock.dataset_slice_hash,
            evaluator_hash: input.baselineLock.evaluator_hash,
            seed_policy: input.baselineLock.seed_policy
          }
        : undefined
    },
    primary_comparison: comparisons[0] ?? null,
    comparisons,
    warnings
  };
}

function buildComparisonEntry(
  comparison: AnalysisConditionComparison,
  report: AnalysisReport
): BaselineComparisonEntrySurface {
  return {
    id: comparison.id,
    label: comparison.label,
    source: comparison.source,
    summary: comparison.summary,
    hypothesis_supported: comparison.hypothesis_supported ?? null,
    metrics: (comparison.metrics ?? [])
      .filter((metric) => metric.primary_value != null && metric.baseline_value != null)
      .map((metric) => ({
        metric: metric.key,
        baseline_value: metric.baseline_value as number,
        comparator_value: metric.primary_value as number,
        delta: Number(((metric.primary_value as number) - (metric.baseline_value as number)).toFixed(4)),
        direction: resolveDirection(metric.key, report)
      }))
  };
}

function resolveDirection(
  metricKey: string,
  report: AnalysisReport
): "higher_better" | "lower_better" {
  const primaryMetric = report.objective_metric.profile.primary_metric || "";
  const target = `${metricKey} ${primaryMetric}`;
  return /loss|latency|error|time|memory|ram/iu.test(target) ? "lower_better" : "higher_better";
}
