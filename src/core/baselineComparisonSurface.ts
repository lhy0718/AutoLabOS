import type { AnalysisReport } from "./resultAnalysis.js";
import {
  RESULTS_COMPARISON_DELTA_TOLERANCE,
  validateResultsArtifactV2,
  type ResultsArtifactV2,
  type ResultsComparisonV2,
  type ResultsMetricDefinitionV2,
  type ResultsObservationV2,
  type ResultsSeriesV2
} from "./analysis/resultsTableSchema.js";
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
  source: "results_artifact";
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
  comparisonId?: string;
}): BaselineComparisonSurface {
  const warnings: string[] = [];
  const artifactValue = (input.report as { results_artifact?: unknown }).results_artifact;
  const validation = validateResultsArtifactV2(artifactValue);
  let comparisons: BaselineComparisonEntrySurface[] = [];

  if (!validation.valid) {
    const issuePreview = validation.issues.slice(0, 3).join(" ");
    warnings.push(
      `ResultsArtifactV2 validation failed; baseline comparison is unmeasured. ${issuePreview}`.trim()
    );
  } else {
    const projection = buildComparisonEntries(artifactValue as ResultsArtifactV2);
    comparisons = projection.entries;
    for (const rejection of projection.rejections) {
      warnings.push(`Comparison "${rejection.id}" is unmeasured: ${rejection.reason}`);
    }
    if (comparisons.length === 0) {
      warnings.push(
        "No explicitly role-bound ResultsArtifactV2 baseline comparison was found; baseline comparison is unmeasured."
      );
    }
  }

  const primaryComparison = selectPrimaryComparison(
    comparisons,
    input.comparisonId,
    warnings
  );

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
    primary_comparison: primaryComparison,
    comparisons,
    warnings
  };
}

interface ComparisonProjectionRejection {
  id: string;
  reason: string;
}

function buildComparisonEntries(artifact: ResultsArtifactV2): {
  entries: BaselineComparisonEntrySurface[];
  rejections: ComparisonProjectionRejection[];
} {
  const metricsById = new Map(artifact.metrics.map((metric) => [metric.id, metric] as const));
  const seriesById = new Map(artifact.series.map((series) => [series.id, series] as const));
  const observationsById = new Map(
    artifact.observations.map((observation) => [observation.id, observation] as const)
  );
  const entries: BaselineComparisonEntrySurface[] = [];
  const rejections: ComparisonProjectionRejection[] = [];

  for (const comparison of artifact.comparisons) {
    const projection = buildComparisonEntry(
      comparison,
      metricsById,
      seriesById,
      observationsById
    );
    if ("entry" in projection) {
      entries.push(projection.entry);
    } else {
      rejections.push({
        id: comparison.id,
        reason: projection.reason
      });
    }
  }

  entries.sort((left, right) => compareIds(left.id, right.id));
  rejections.sort((left, right) => compareIds(left.id, right.id));
  return { entries, rejections };
}

function buildComparisonEntry(
  comparison: ResultsComparisonV2,
  metricsById: ReadonlyMap<string, ResultsMetricDefinitionV2>,
  seriesById: ReadonlyMap<string, ResultsSeriesV2>,
  observationsById: ReadonlyMap<string, ResultsObservationV2>
): { entry: BaselineComparisonEntrySurface } | { reason: string } {
  const subject = observationsById.get(comparison.subject_observation_id);
  const reference = observationsById.get(comparison.reference_observation_id);
  if (!subject || !reference) {
    return { reason: "its declared subject or reference observation does not resolve." };
  }
  if (subject.id === reference.id || subject.series_id === reference.series_id) {
    return {
      reason: "subject and reference must be distinct observations from distinct series."
    };
  }
  if (subject.metric_id !== reference.metric_id) {
    return { reason: "subject and reference observations declare different metric ids." };
  }

  const metric = metricsById.get(subject.metric_id);
  const subjectSeries = seriesById.get(subject.series_id);
  const referenceSeries = seriesById.get(reference.series_id);
  if (!metric || !subjectSeries || !referenceSeries) {
    return { reason: "its declared metric or series does not resolve." };
  }
  if (referenceSeries.role !== "baseline") {
    return { reason: "the reference series does not explicitly declare the baseline role." };
  }
  if (subjectSeries.role !== "primary" && subjectSeries.role !== "comparator") {
    return {
      reason: "the subject series does not explicitly declare the primary or comparator role."
    };
  }
  if (
    !Number.isFinite(subject.value)
    || !Number.isFinite(reference.value)
    || !Number.isFinite(comparison.delta)
    || !matchesComparisonDelta(comparison.delta, subject.value - reference.value)
  ) {
    return { reason: "its declared delta is not a finite subject-minus-reference value." };
  }

  return {
    entry: {
      id: comparison.id,
      label: comparison.id,
      source: "results_artifact",
      summary: `Subject observation "${subject.id}" compared with reference observation "${reference.id}".`,
      hypothesis_supported: null,
      metrics: [
        {
          metric: metric.id,
          baseline_value: reference.value,
          comparator_value: subject.value,
          delta: comparison.delta,
          direction: metric.direction
        }
      ]
    }
  };
}

function selectPrimaryComparison(
  comparisons: BaselineComparisonEntrySurface[],
  comparisonId: string | undefined,
  warnings: string[]
): BaselineComparisonEntrySurface | null {
  if (comparisonId !== undefined) {
    if (comparisonId.trim().length === 0) {
      warnings.push("The explicit comparison selector is empty; primary comparison is unmeasured.");
      return null;
    }
    const selected = comparisons.find((comparison) => comparison.id === comparisonId);
    if (!selected) {
      warnings.push(
        `The explicit comparison selector "${comparisonId}" does not resolve to a measured baseline comparison.`
      );
      return null;
    }
    return selected;
  }

  if (comparisons.length > 0) {
    warnings.push(
      "Measured baseline comparisons are available, but primary comparison is unmeasured without an explicit comparison id."
    );
  }
  return null;
}

function matchesComparisonDelta(actual: number, expected: number): boolean {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return Math.abs(actual - expected) <= RESULTS_COMPARISON_DELTA_TOLERANCE * scale;
}

function compareIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
