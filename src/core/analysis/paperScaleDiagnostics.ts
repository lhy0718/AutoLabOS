import type {
  AnalysisReport,
  AnalysisStatisticalSummary
} from "../resultAnalysis.js";
import {
  RESULTS_COMPARISON_DELTA_TOLERANCE,
  validateResultsArtifactV2,
  type ResultsArtifactV2,
  type ResultsComparisonV2,
  type ResultsMetricDefinitionV2,
  type ResultsObservationV2,
  type ResultsSeriesV2
} from "./resultsTableSchema.js";
import { GATE_THRESHOLDS } from "./paperGateThresholds.js";

export type PaperScaleDiagnosticSeverity = "blocking" | "warning";

export type PaperScaleDiagnosticCategory =
  | "evaluation_sample_size"
  | "statistical_adequacy"
  | "training_budget"
  | "execution_coverage"
  | "related_work_depth"
  | "resource_claim";

export interface PaperScaleDiagnostic {
  id: string;
  severity: PaperScaleDiagnosticSeverity;
  category: PaperScaleDiagnosticCategory;
  source_node: string;
  target_node: string;
  summary: string;
  evidence: string;
  recommended_action: string;
  recheck_condition: string;
}

export interface PaperScaleDiagnosticSummary {
  generated_at: string;
  diagnostics: PaperScaleDiagnostic[];
  blocking_count: number;
  warning_count: number;
}

interface ResolvedComparison {
  comparison: ResultsComparisonV2;
  subjectObservation: ResultsObservationV2;
  referenceObservation: ResultsObservationV2;
  metric: ResultsMetricDefinitionV2;
  subjectSeries: ResultsSeriesV2;
  referenceSeries: ResultsSeriesV2;
}

type PrimaryComparisonSelection =
  | { status: "none" }
  | { status: "selected"; value: ResolvedComparison }
  | {
    status: "ambiguous";
    comparisonCount: number;
    primaryComparisonId?: string;
  };

export function evaluatePaperScaleDiagnostics(input: {
  report: AnalysisReport;
  topic: string;
  bibliographyText?: string;
}): PaperScaleDiagnosticSummary {
  const diagnostics: PaperScaleDiagnostic[] = [];
  const statisticalSummary = input.report.statistical_summary;
  const artifactValue: unknown = input.report.results_artifact;
  const artifactValidation = validateResultsArtifactV2(artifactValue);

  let artifact: ResultsArtifactV2 | undefined;
  let primarySelection: PrimaryComparisonSelection = { status: "none" };

  if (!artifactValidation.valid) {
    diagnostics.push({
      id: "invalid_results_artifact",
      severity: "blocking",
      category: "statistical_adequacy",
      source_node: "analyze_results",
      target_node: "analyze_results",
      summary: "The explicit results artifact is invalid, so comparative claims are blocked.",
      evidence: `ResultsArtifactV2 validation failed: ${artifactValidation.issues.slice(0, 4).join(" ")}`,
      recommended_action: "Repair the explicit metric, series, observation, and subject/reference links, then regenerate the statistical summary.",
      recheck_condition: "ResultsArtifactV2 validation passes with finite observations and deltas that equal subject value minus reference value."
    });
  } else {
    artifact = artifactValue as ResultsArtifactV2;
    primarySelection = selectPrimaryComparison(
      resolveComparisons(artifact),
      input.report.primary_comparison_id
    );
    if (primarySelection.status === "ambiguous") {
      const primaryIdEvidence = primarySelection.primaryComparisonId
        ? `AnalysisReport.primary_comparison_id="${primarySelection.primaryComparisonId}" does not match a validated comparison.`
        : "AnalysisReport.primary_comparison_id is missing.";
      diagnostics.push({
        id: "ambiguous_primary_comparison",
        severity: "blocking",
        category: "statistical_adequacy",
        source_node: "analyze_results",
        target_node: "analyze_results",
        summary: "The validated results do not declare one exact primary comparison.",
        evidence: `The validated artifact contains ${primarySelection.comparisonCount} comparison(s). ${primaryIdEvidence}`,
        recommended_action: "Set AnalysisReport.primary_comparison_id to the exact ID of the declared primary comparison.",
        recheck_condition: "AnalysisReport.primary_comparison_id exactly matches one validated ResultsArtifactV2 comparison."
      });
    }
  }

  const sampleSummary = extractSampleSummary(statisticalSummary, artifact);
  if (
    sampleSummary.minimumCount !== undefined
    && sampleSummary.minimumCount < GATE_THRESHOLDS.minEvaluationExamplesPerTaskForPaperScale
  ) {
    diagnostics.push({
      id: "tiny_eval_sample",
      severity: "blocking",
      category: "evaluation_sample_size",
      source_node: "run_experiments",
      target_node: "run_experiments",
      summary: "An explicitly reported evaluation sample is too small for paper-scale claims.",
      evidence: `Minimum structured confidence-interval sample size is n=${sampleSummary.minimumCount} across ${sampleSummary.reportedCount} matched metric interval(s).`,
      recommended_action: "Increase the evaluated sample or restrict the claim ceiling to a small-sample screening result.",
      recheck_condition: `Every explicitly linked interval reports at least ${GATE_THRESHOLDS.minEvaluationExamplesPerTaskForPaperScale} evaluated observations, or the claim ceiling is downgraded.`
    });
  }

  const selectedComparison =
    primarySelection.status === "selected" ? primarySelection.value : undefined;
  const improvementSignal =
    selectedComparison && comparisonImproves(selectedComparison)
      ? formatImprovementSignal(selectedComparison)
      : undefined;
  const seedSummary = extractSeedSummary(input.report);
  if (
    improvementSignal
    && seedSummary.minimumCount < GATE_THRESHOLDS.minDistinctSeedsForPaperScale
  ) {
    diagnostics.push({
      id: "missing_seed_replication",
      severity: "blocking",
      category: "statistical_adequacy",
      source_node: "run_experiments",
      target_node: "run_experiments",
      summary: "The primary comparative improvement lacks explicit repeated-seed support.",
      evidence: `${improvementSignal} ${
        seedSummary.evidencePresent
          ? `Minimum structured seed count is ${seedSummary.minimumCount} across ${seedSummary.reportedCount} seed-coverage entr${seedSummary.reportedCount === 1 ? "y" : "ies"}.`
          : "No structured seed count is present in statistical_summary.stability_metrics or metrics.condition_results."
      }`,
      recommended_action: "Repeat the explicit subject/reference comparison across seeds and report the structured seed count and uncertainty.",
      recheck_condition: `Structured seed coverage reaches at least ${GATE_THRESHOLDS.minDistinctSeedsForPaperScale}, or the comparative improvement claim is downgraded.`
    });
  }

  const executionCoverage = extractExecutionCoverage(input.report);
  if (
    executionCoverage.totalTrials !== undefined
    && executionCoverage.executedTrials !== undefined
    && executionCoverage.executedTrials < executionCoverage.totalTrials
  ) {
    diagnostics.push({
      id: "incomplete_planned_runs",
      severity: "blocking",
      category: "execution_coverage",
      source_node: "run_experiments",
      target_node: "run_experiments",
      summary: "Executed trials do not cover the structured trial total.",
      evidence: `Executed ${executionCoverage.executedTrials} of ${executionCoverage.totalTrials} declared trial(s) (${formatRatio(executionCoverage.executedTrials, executionCoverage.totalTrials)} coverage).`,
      recommended_action: "Execute the missing trials or explicitly lower the governed evidence scope.",
      recheck_condition: "statistical_summary.executed_trials reaches statistical_summary.total_trials, or both the scope and claim ceiling are revised."
    });
  }

  const oneItemGain = selectedComparison
    ? detectOneItemGain(selectedComparison, statisticalSummary)
    : undefined;
  if (oneItemGain) {
    diagnostics.push({
      id: "single_item_gain",
      severity: "blocking",
      category: "statistical_adequacy",
      source_node: "analyze_results",
      target_node: "analyze_results",
      summary: "The primary improvement is consistent with a one-observation change.",
      evidence: oneItemGain,
      recommended_action: "Treat the result as a screening signal until a larger paired evaluation or robust repeated-trial analysis supports it.",
      recheck_condition: "The explicit subject/reference effect exceeds one-observation granularity or is supported by robust paired statistics."
    });
  }

  const stepSummary = extractOptimizerStepSummary(input.report);
  if (
    improvementSignal
    && stepSummary.maximumSteps !== undefined
    && stepSummary.maximumSteps < GATE_THRESHOLDS.minOptimizerStepsForTuningClaim
  ) {
    diagnostics.push({
      id: "thin_training_budget",
      severity: "warning",
      category: "training_budget",
      source_node: "implement_experiments",
      target_node: "implement_experiments",
      summary: "The explicit comparative improvement was produced with a smoke-scale optimizer budget.",
      evidence: `Maximum structured optimizer step count is ${stepSummary.maximumSteps}; reported step counts: ${stepSummary.stepValues.join(", ")}.`,
      recommended_action: "Increase the training budget or restrict the comparative result to pipeline/preflight evidence.",
      recheck_condition: `Optimizer steps reach at least ${GATE_THRESHOLDS.minOptimizerStepsForTuningClaim}, or the tuning-effect claim is downgraded.`
    });
  }

  const trainingSampleBudget = extractTrainingSampleBudget(input.report);
  if (
    improvementSignal
    && trainingSampleBudget.plannedSamples !== undefined
    && trainingSampleBudget.actualSamples !== undefined
    && trainingSampleBudget.actualSamples < trainingSampleBudget.plannedSamples
  ) {
    diagnostics.push({
      id: "training_budget_mismatch",
      severity: "blocking",
      category: "training_budget",
      source_node: "implement_experiments",
      target_node: "implement_experiments",
      summary: "The executed training sample budget is below the explicitly recorded plan.",
      evidence: `Run configuration used at most ${trainingSampleBudget.actualSamples} training sample(s), while its structured planned budget is ${trainingSampleBudget.plannedSamples} (${formatRatio(trainingSampleBudget.actualSamples, trainingSampleBudget.plannedSamples)} coverage).`,
      recommended_action: "Rerun with the recorded training budget, or govern the experiment and claim ceiling down to the executed budget.",
      recheck_condition: "The actual training sample budget reaches the explicit planned budget, or both the plan and claim ceiling adopt the smaller budget."
    });
  }

  const smokeRisk = detectSmokeOnlyEvidence(statisticalSummary);
  if (smokeRisk) {
    diagnostics.push({
      id: "smoke_only_evidence",
      severity: "blocking",
      category: "statistical_adequacy",
      source_node: "run_experiments",
      target_node: "run_experiments",
      summary: "The structured evidence supports only a smoke-level execution claim.",
      evidence: smokeRisk,
      recommended_action: "Run repeated trials and emit structured uncertainty or stability evidence before making paper-scale claims.",
      recheck_condition: `At least ${GATE_THRESHOLDS.minRobustnessTotalTrials} trials are executed, or structured repeated-measure uncertainty or stability evidence is present.`
    });
  }

  const resourceRisk = artifact
    ? detectResourceClaimRisk(artifact, statisticalSummary)
    : undefined;
  if (resourceRisk) {
    diagnostics.push({
      id: "resource_claim_unsupported",
      severity: "warning",
      category: "resource_claim",
      source_node: "analyze_results",
      target_node: "analyze_results",
      summary: "Explicit resource measurements are not backed by repeated-measure evidence.",
      evidence: resourceRisk,
      recommended_action: "Keep resource values descriptive until matching intervals or stability estimates are reported across repeated trials.",
      recheck_condition: "Resource-unit metrics have matching structured uncertainty or stability evidence from repeated trials, or claim-level efficiency language is removed."
    });
  }

  return {
    generated_at: new Date().toISOString(),
    diagnostics,
    blocking_count: diagnostics.filter((diagnostic) => diagnostic.severity === "blocking").length,
    warning_count: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length
  };
}

function resolveComparisons(artifact: ResultsArtifactV2): ResolvedComparison[] {
  const observationsById = new Map(
    artifact.observations.map((observation) => [observation.id, observation] as const)
  );
  const metricsById = new Map(
    artifact.metrics.map((metric) => [metric.id, metric] as const)
  );
  const seriesById = new Map(
    artifact.series.map((series) => [series.id, series] as const)
  );

  return artifact.comparisons.flatMap((comparison) => {
    const subjectObservation = observationsById.get(comparison.subject_observation_id);
    const referenceObservation = observationsById.get(comparison.reference_observation_id);
    if (!subjectObservation || !referenceObservation) {
      return [];
    }
    const metric = metricsById.get(subjectObservation.metric_id);
    const subjectSeries = seriesById.get(subjectObservation.series_id);
    const referenceSeries = seriesById.get(referenceObservation.series_id);
    if (
      !metric
      || !subjectSeries
      || !referenceSeries
      || subjectObservation.metric_id !== referenceObservation.metric_id
    ) {
      return [];
    }
    return [{
      comparison,
      subjectObservation,
      referenceObservation,
      metric,
      subjectSeries,
      referenceSeries
    }];
  });
}

function selectPrimaryComparison(
  comparisons: ResolvedComparison[],
  primaryComparisonId: unknown
): PrimaryComparisonSelection {
  if (comparisons.length === 0) {
    return { status: "none" };
  }
  const normalizedPrimaryId = typeof primaryComparisonId === "string"
    ? primaryComparisonId.trim()
    : "";
  if (normalizedPrimaryId) {
    const selected = comparisons.find(
      (comparison) => comparison.comparison.id === normalizedPrimaryId
    );
    if (selected) {
      return { status: "selected", value: selected };
    }
  }
  return {
    status: "ambiguous",
    comparisonCount: comparisons.length,
    ...(normalizedPrimaryId ? { primaryComparisonId: normalizedPrimaryId } : {})
  };
}

function comparisonImproves(comparison: ResolvedComparison): boolean {
  const delta = comparison.comparison.delta;
  if (Math.abs(delta) <= RESULTS_COMPARISON_DELTA_TOLERANCE) {
    return false;
  }
  return comparison.metric.direction === "lower_better" ? delta < 0 : delta > 0;
}

function formatImprovementSignal(comparison: ResolvedComparison): string {
  const unit = comparison.metric.unit ? `, unit=${comparison.metric.unit}` : "";
  return `The selected explicit subject/reference comparison improves according to direction=${comparison.metric.direction}${unit}: subject=${formatNumber(comparison.subjectObservation.value)}, reference=${formatNumber(comparison.referenceObservation.value)}, delta=${formatNumber(comparison.comparison.delta)}.`;
}

function extractSampleSummary(
  summary: AnalysisStatisticalSummary | undefined,
  artifact: ResultsArtifactV2 | undefined
): { minimumCount?: number; reportedCount: number } {
  if (!artifact) {
    return { reportedCount: 0 };
  }
  const metricIds = new Set(artifact.metrics.map((metric) => metric.id));
  const sampleCounts = safeArray(summary?.confidence_intervals)
    .filter((interval) => metricIds.has(interval.metric_key))
    .map((interval) => asPositiveInteger(interval.sample_size))
    .filter((value): value is number => value !== undefined);
  return {
    minimumCount: minimumDefined(sampleCounts),
    reportedCount: sampleCounts.length
  };
}

function extractSeedSummary(
  report: AnalysisReport
): { minimumCount: number; reportedCount: number; evidencePresent: boolean } {
  const summarySeedCounts = safeArray(report.statistical_summary?.stability_metrics)
    .filter((entry) => isSeedCoverageKey(entry.key))
    .map((entry) => asNonNegativeInteger(entry.value))
    .filter((value): value is number => value !== undefined);
  const metrics = asRecord(report.metrics);
  const reportedConditionSeedCounts = asRecordArray(metrics.condition_results)
    .map(readConditionSeedCount);
  const conditionSeedCounts = reportedConditionSeedCounts.some((value) => value !== undefined)
    ? reportedConditionSeedCounts.map((value) => value ?? 0)
    : [];
  const seedCounts = [
    ...summarySeedCounts,
    ...conditionSeedCounts
  ];
  return {
    minimumCount: minimumDefined(seedCounts) ?? 0,
    reportedCount: seedCounts.length,
    evidencePresent: seedCounts.length > 0
  };
}

function isSeedCoverageKey(value: string): boolean {
  const normalized = normalizeEvidenceKey(value);
  return /(?:^|_)(?:distinct_seed_count|distinct_seeds|completed_seed_count|completed_seeds|executed_seed_count|executed_seeds|seed_count|seeds|num_seeds|number_of_seeds|n_seeds|seed_repetitions|seed_replication_count)$/u.test(
    normalized
  );
}

function extractExecutionCoverage(
  report: AnalysisReport
): { totalTrials?: number; executedTrials?: number } {
  const summary = report.statistical_summary;
  const portfolio = report.experiment_portfolio;
  const groupExpectedTrials = safeArray(portfolio?.trial_groups)
    .map((group) => asNonNegativeInteger(group.expected_trials))
    .filter((value): value is number => value !== undefined);
  const groupExecutedTrials = safeArray(portfolio?.trial_groups)
    .map((group) => asNonNegativeInteger(group.executed_trials))
    .filter((value): value is number => value !== undefined);
  const expectedCandidates = [
    asNonNegativeInteger(summary?.total_trials),
    asNonNegativeInteger(portfolio?.total_expected_trials),
    sumDefined(groupExpectedTrials)
  ].filter((value): value is number => value !== undefined);
  const executedCandidates = [
    asNonNegativeInteger(summary?.executed_trials),
    asNonNegativeInteger(portfolio?.executed_trials),
    sumDefined(groupExecutedTrials)
  ].filter((value): value is number => value !== undefined);

  return {
    totalTrials: maximumDefined(expectedCandidates),
    executedTrials:
      minimumDefined(executedCandidates)
      ?? asNonNegativeInteger(report.overview?.execution_runs)
  };
}

function readConditionSeedCount(condition: Record<string, unknown>): number | undefined {
  const declaredCount = asNonNegativeInteger(condition.seed_count);
  if (!Array.isArray(condition.seeds)) {
    return declaredCount;
  }

  const distinctSeeds = new Set(
    condition.seeds
      .map(normalizeSeedValue)
      .filter((value): value is string => value !== undefined)
  ).size;
  return declaredCount === undefined
    ? distinctSeeds
    : Math.min(distinctSeeds, declaredCount);
}

function normalizeSeedValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function extractOptimizerStepSummary(
  report: AnalysisReport
): { stepValues: number[]; maximumSteps?: number } {
  const metrics = asRecord(report.metrics);
  const runConfig = asRecord(metrics.run_config);
  const stepValues = [
    runConfig.max_steps,
    runConfig.optimizer_steps,
    runConfig.steps_completed,
    ...asRecordArray(metrics.condition_results).map((condition) => condition.steps_completed)
  ]
    .map(asNonNegativeInteger)
    .filter((value): value is number => value !== undefined);
  return {
    stepValues,
    maximumSteps: maximumDefined(stepValues)
  };
}

function extractTrainingSampleBudget(
  report: AnalysisReport
): { plannedSamples?: number; actualSamples?: number } {
  const runConfig = asRecord(asRecord(report.metrics).run_config);
  const actualSamples = maximumDefined([
    runConfig.max_train_samples,
    runConfig.train_samples,
    runConfig.training_examples,
    runConfig.max_training_examples
  ]
    .map(asNonNegativeInteger)
    .filter((value): value is number => value !== undefined));
  const plannedSamples = maximumDefined([
    runConfig.planned_max_train_samples,
    runConfig.planned_train_samples,
    runConfig.planned_training_examples,
    runConfig.expected_train_samples,
    runConfig.expected_training_examples
  ]
    .map(asNonNegativeInteger)
    .filter((value): value is number => value !== undefined));
  return { plannedSamples, actualSamples };
}

function detectOneItemGain(
  comparison: ResolvedComparison,
  summary: AnalysisStatisticalSummary | undefined
): string | undefined {
  if (!comparisonImproves(comparison)) {
    return undefined;
  }
  const unitScale = oneItemUnitScale(comparison.metric.unit);
  if (unitScale === undefined) {
    return undefined;
  }
  const sampleSizes = new Set(
    safeArray(summary?.confidence_intervals)
      .filter((interval) => interval.metric_key === comparison.metric.id)
      .map((interval) => asPositiveInteger(interval.sample_size))
      .filter((value): value is number => value !== undefined)
  );
  if (sampleSizes.size !== 1) {
    return undefined;
  }
  const sampleSize = [...sampleSizes][0];
  const itemEquivalent = Math.abs(comparison.comparison.delta) * sampleSize * unitScale;
  if (Math.abs(itemEquivalent - 1) > 0.05) {
    return undefined;
  }
  return `The explicit ${comparison.metric.direction} delta ${formatNumber(comparison.comparison.delta)} at unit=${comparison.metric.unit} and n=${sampleSize} corresponds to approximately ${formatNumber(itemEquivalent)} observation.`;
}

function oneItemUnitScale(unit: string | undefined): number | undefined {
  const normalized = normalizeUnit(unit);
  if (["ratio", "proportion", "fraction", "rate"].includes(normalized)) {
    return 1;
  }
  if (["%", "percent", "percentage", "percentagepoint", "percentagepoints", "pp"].includes(normalized)) {
    return 0.01;
  }
  return undefined;
}

function detectSmokeOnlyEvidence(
  summary: AnalysisStatisticalSummary | undefined
): string | undefined {
  const executedTrials = asNonNegativeInteger(summary?.executed_trials);
  const totalTrials = asNonNegativeInteger(summary?.total_trials);
  const observedTrials = executedTrials ?? totalTrials;
  if (
    observedTrials === undefined
    || observedTrials <= 0
    || observedTrials >= GATE_THRESHOLDS.minRobustnessTotalTrials
  ) {
    return undefined;
  }

  const confidenceIntervalCount = safeArray(summary?.confidence_intervals).length;
  const stabilityMetricCount = safeArray(summary?.stability_metrics).length;
  if (confidenceIntervalCount > 0 || stabilityMetricCount > 0) {
    return undefined;
  }
  const effectEstimateCount = safeArray(summary?.effect_estimates).length;
  return `Structured evidence reports total_trials=${totalTrials ?? "unknown"}, executed_trials=${executedTrials ?? "unknown"}, confidence_intervals=${confidenceIntervalCount}, stability_metrics=${stabilityMetricCount}, and effect_estimates=${effectEstimateCount}.`;
}

function detectResourceClaimRisk(
  artifact: ResultsArtifactV2,
  summary: AnalysisStatisticalSummary | undefined
): string | undefined {
  const resourceMetricIds = new Set(
    artifact.metrics
      .filter((metric) => isResourceUnit(metric.unit))
      .map((metric) => metric.id)
  );
  const observedResourceMetricIds = new Set(
    artifact.observations
      .filter((observation) => resourceMetricIds.has(observation.metric_id))
      .map((observation) => observation.metric_id)
  );
  if (observedResourceMetricIds.size === 0) {
    return undefined;
  }

  const matchingIntervalCount = safeArray(summary?.confidence_intervals)
    .filter((interval) => observedResourceMetricIds.has(interval.metric_key))
    .length;
  const matchingStabilityCount = safeArray(summary?.stability_metrics)
    .filter((entry) => observedResourceMetricIds.has(entry.key))
    .length;
  const executedTrials = asNonNegativeInteger(summary?.executed_trials);
  if (
    executedTrials !== undefined
    && executedTrials >= 3
    && (matchingIntervalCount > 0 || matchingStabilityCount > 0)
  ) {
    return undefined;
  }
  return `${observedResourceMetricIds.size} explicit resource-unit metric(s) have observations; executed_trials=${executedTrials ?? "unknown"}, matching_confidence_intervals=${matchingIntervalCount}, matching_stability_metrics=${matchingStabilityCount}.`;
}

function isResourceUnit(unit: string | undefined): boolean {
  const normalized = normalizeUnit(unit);
  return [
    "s",
    "sec",
    "secs",
    "second",
    "seconds",
    "ms",
    "millisecond",
    "milliseconds",
    "minute",
    "minutes",
    "hour",
    "hours",
    "byte",
    "bytes",
    "kb",
    "kib",
    "mb",
    "mib",
    "gb",
    "gib",
    "tb",
    "tib",
    "joule",
    "joules",
    "wh",
    "kwh"
  ].includes(normalized);
}

function normalizeUnit(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s_-]+/gu, "");
}

function normalizeEvidenceKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function safeArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
    )
    : [];
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function minimumDefined(values: number[]): number | undefined {
  return values.length > 0
    ? values.reduce((minimum, value) => value < minimum ? value : minimum)
    : undefined;
}

function maximumDefined(values: number[]): number | undefined {
  return values.length > 0
    ? values.reduce((maximum, value) => value > maximum ? value : maximum)
    : undefined;
}

function sumDefined(values: number[]): number | undefined {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

function formatRatio(numerator: number, denominator: number): string {
  return denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : "unknown";
}

function formatNumber(value: number): string {
  return Number(value.toPrecision(6)).toString();
}
