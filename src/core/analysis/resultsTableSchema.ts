import {
  isExplicitMetricScale,
  validateEffectCriterion,
  type CandidateMetricScale,
  type EffectCriterion
} from "../effectCriterion.js";

export type ResultsTableDirection = "higher_better" | "lower_better";

export interface ResultsTableRow {
  metric: string;
  baseline: number | null;
  comparator: number | null;
  delta: number | null;
  direction: ResultsTableDirection;
}

export type ResultsTableSchema = ResultsTableRow[];

export interface ResultsTableSchemaValidation {
  valid: boolean;
  issues: string[];
  rows: ResultsTableSchema;
}

export const RESULTS_ARTIFACT_SCHEMA_VERSION = "2.0" as const;
export const RESULTS_COMPARISON_DELTA_TOLERANCE = 1e-9;

export type ResultsScalar = string | number | boolean | null;
export type ResultsSeriesRole = "baseline" | "comparator" | "primary" | "control" | "other";

export interface ResultsMetricDefinitionV2 {
  id: string;
  label: string;
  direction: ResultsTableDirection;
  unit?: string;
}

export interface ResultsSeriesV2 {
  id: string;
  label: string;
  role?: ResultsSeriesRole;
  dimensions: Record<string, ResultsScalar>;
}

export interface ResultsObservationV2 {
  id: string;
  series_id: string;
  metric_id: string;
  scope: Record<string, ResultsScalar>;
  value: number;
  evidence_refs?: string[];
}

export interface ResultsComparisonV2 {
  id: string;
  subject_observation_id: string;
  reference_observation_id: string;
  delta: number;
  judgement?: string;
  evidence_refs?: string[];
}

export interface ResultsArtifactV2 {
  schema_version: typeof RESULTS_ARTIFACT_SCHEMA_VERSION;
  metrics: ResultsMetricDefinitionV2[];
  series: ResultsSeriesV2[];
  observations: ResultsObservationV2[];
  comparisons: ResultsComparisonV2[];
}

export interface ResultsRequiredSeriesV2 {
  id: string;
  role: ResultsSeriesRole;
}

export interface ResultsRequiredComparisonV2 {
  id: string;
  subject_series_id: string;
  reference_series_id: string;
  metric_id: string;
  scope?: Record<string, ResultsScalar>;
}

export interface ResultsPrimaryEffectCriterionV2 {
  comparison_id: string;
  metric_id: string;
  metric_scale: CandidateMetricScale;
  direction: "maximize" | "minimize";
  effect_criterion: EffectCriterion;
}

export interface ResultsPlanV2 {
  schema_version: typeof RESULTS_ARTIFACT_SCHEMA_VERSION;
  required_metrics: ResultsMetricDefinitionV2[];
  minimum_series_count: number;
  minimum_comparison_count: number;
  required_series?: ResultsRequiredSeriesV2[];
  required_comparisons?: ResultsRequiredComparisonV2[];
  primary_comparison_id?: string;
  primary_effect_criterion?: ResultsPrimaryEffectCriterionV2;
}

export interface ResultsContractValidation {
  valid: boolean;
  issues: string[];
}

export interface ResultsContractCompleteness {
  complete: boolean;
  issues: string[];
}

export function buildResultsTableSchema(
  metrics: string[],
  direction: ResultsTableDirection
): ResultsTableSchema {
  return uniqueStrings(metrics)
    .map((metric) => metric.trim())
    .filter(Boolean)
    .filter(isReportableMetricKey)
    .map((metric) => ({
      metric,
      baseline: null,
      comparator: null,
      delta: null,
      direction: inferMetricDirection(metric, direction)
    }));
}

function isReportableMetricKey(metric: string): boolean {
  const wordCount = metric.split(/\s+/u).filter(Boolean).length;
  return !metric.includes(":") && wordCount <= 6;
}

export function validateResultsTableSchema(value: unknown): ResultsTableSchemaValidation {
  if (!Array.isArray(value)) {
    return {
      valid: false,
      issues: ["results_table must be an array."],
      rows: []
    };
  }

  const rows: ResultsTableSchema = [];
  const issues: string[] = [];

  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      issues.push(`results_table[${index}] must be an object.`);
      continue;
    }
    const row = candidate as Record<string, unknown>;
    const metric = typeof row.metric === "string" ? row.metric.trim() : "";
    const direction = row.direction;

    if (!metric) {
      issues.push(`results_table[${index}] must include a non-empty metric.`);
    }
    if (direction !== "higher_better" && direction !== "lower_better") {
      issues.push(`results_table[${index}] must include direction higher_better or lower_better.`);
    }

    const baseline = normalizeNullableNumber(row.baseline, `results_table[${index}].baseline`, issues);
    const comparator = normalizeNullableNumber(row.comparator, `results_table[${index}].comparator`, issues);
    const delta = normalizeNullableNumber(row.delta, `results_table[${index}].delta`, issues);

    rows.push({
      metric,
      baseline,
      comparator,
      delta,
      direction: direction === "lower_better" ? "lower_better" : "higher_better"
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    rows
  };
}

export function hasAtLeastOneCompleteResultsTableRow(rows: ResultsTableSchema | undefined): boolean {
  return (rows ?? []).some((row) => row.baseline !== null && row.comparator !== null);
}

export function hasAnyIncompleteResultsTableRow(rows: ResultsTableSchema | undefined): boolean {
  return (rows ?? []).some((row) => row.baseline === null || row.comparator === null);
}

function normalizeNullableNumber(
  value: unknown,
  label: string,
  issues: string[]
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  issues.push(`${label} must be a finite number or null.`);
  return null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function inferMetricDirection(
  metric: string,
  fallback: ResultsTableDirection
): ResultsTableDirection {
  const normalized = metric.toLowerCase().replace(/[_-]+/g, " ");
  if (
    /\b(loss|latency|error|errors|runtime|wall clock|elapsed time|memory|vram|ram)\b/u.test(normalized) ||
    /\b(mismatch|mislabel|incorrect|unsupported|overclaim|false positive|hidden failed|hidden incomplete)\b/u.test(normalized) ||
    /\b(failure|fail|violation|defect|risk|regression)\s+(count|rate|ratio)\b/u.test(normalized)
  ) {
    return "lower_better";
  }
  return fallback;
}

interface ObservationValidationData {
  index: number;
  id?: string;
  seriesId?: string;
  metricId?: string;
  value?: number;
}

interface SeriesValidationData {
  index: number;
  id?: string;
  role?: unknown;
}

interface ComparisonValidationData {
  index: number;
  subjectObservationId?: string;
  referenceObservationId?: string;
  delta?: number;
}

export function validateResultsArtifactV2(value: unknown): ResultsContractValidation {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: ["results_artifact must be an object."]
    };
  }

  if (value.schema_version !== RESULTS_ARTIFACT_SCHEMA_VERSION) {
    issues.push(`results_artifact.schema_version must be "${RESULTS_ARTIFACT_SCHEMA_VERSION}".`);
  }

  const metrics = readRequiredArray(value.metrics, "results_artifact.metrics", issues);
  const series = readRequiredArray(value.series, "results_artifact.series", issues);
  const observations = readRequiredArray(value.observations, "results_artifact.observations", issues);
  const comparisons = readRequiredArray(value.comparisons, "results_artifact.comparisons", issues);

  const metricIds = new Map<string, number>();
  for (const [index, candidate] of (metrics ?? []).entries()) {
    const path = `results_artifact.metrics[${index}]`;
    const metric = readRecord(candidate, path, issues);
    if (!metric) {
      continue;
    }
    const id = readNonEmptyString(metric.id, `${path}.id`, issues);
    registerUniqueId(id, index, "results_artifact.metrics", metricIds, issues);
    readNonEmptyString(metric.label, `${path}.label`, issues);
    if (!isResultsTableDirection(metric.direction)) {
      issues.push(`${path}.direction must be higher_better or lower_better.`);
    }
    readNonEmptyString(metric.unit, `${path}.unit`, issues);
  }

  const seriesIds = new Map<string, number>();
  const seriesById = new Map<string, SeriesValidationData>();
  for (const [index, candidate] of (series ?? []).entries()) {
    const path = `results_artifact.series[${index}]`;
    const item = readRecord(candidate, path, issues);
    if (!item) {
      continue;
    }
    const id = readNonEmptyString(item.id, `${path}.id`, issues);
    registerUniqueId(id, index, "results_artifact.series", seriesIds, issues);
    readNonEmptyString(item.label, `${path}.label`, issues);
    if (item.role !== undefined && !isResultsSeriesRole(item.role)) {
      issues.push(`${path}.role must be baseline, comparator, primary, control, or other.`);
    }
    validateScalarRecord(item.dimensions, `${path}.dimensions`, issues);
    if (id && !seriesById.has(id)) {
      seriesById.set(id, { index, id, role: item.role });
    }
  }

  const observationIds = new Map<string, number>();
  const observationById = new Map<string, ObservationValidationData>();
  const observationSignatures = new Map<string, number>();
  const observationData: ObservationValidationData[] = [];
  for (const [index, candidate] of (observations ?? []).entries()) {
    const path = `results_artifact.observations[${index}]`;
    const observation = readRecord(candidate, path, issues);
    if (!observation) {
      continue;
    }
    const id = readNonEmptyString(observation.id, `${path}.id`, issues);
    registerUniqueId(id, index, "results_artifact.observations", observationIds, issues);
    const seriesId = readNonEmptyString(observation.series_id, `${path}.series_id`, issues);
    const metricId = readNonEmptyString(observation.metric_id, `${path}.metric_id`, issues);
    validateScalarRecord(observation.scope, `${path}.scope`, issues);
    const observationValue = readFiniteNumber(observation.value, `${path}.value`, issues);
    if (observation.evidence_refs !== undefined) {
      validateStringArray(observation.evidence_refs, `${path}.evidence_refs`, issues);
    }
    const data = { index, id, seriesId, metricId, value: observationValue };
    observationData.push(data);
    if (id && !observationById.has(id)) {
      observationById.set(id, data);
    }
    if (seriesId && metricId && isRecord(observation.scope)) {
      const signature = buildObservationSignature(seriesId, metricId, observation.scope);
      const priorIndex = observationSignatures.get(signature);
      if (priorIndex !== undefined) {
        issues.push(
          `${path} duplicates the series, metric, and scope of results_artifact.observations[${priorIndex}].`
        );
      } else {
        observationSignatures.set(signature, index);
      }
    }
  }

  const comparisonIds = new Map<string, number>();
  const comparisonSignatures = new Map<string, number>();
  const comparisonData: ComparisonValidationData[] = [];
  for (const [index, candidate] of (comparisons ?? []).entries()) {
    const path = `results_artifact.comparisons[${index}]`;
    const comparison = readRecord(candidate, path, issues);
    if (!comparison) {
      continue;
    }
    const id = readNonEmptyString(comparison.id, `${path}.id`, issues);
    registerUniqueId(id, index, "results_artifact.comparisons", comparisonIds, issues);
    const subjectObservationId = readNonEmptyString(
      comparison.subject_observation_id,
      `${path}.subject_observation_id`,
      issues
    );
    const referenceObservationId = readNonEmptyString(
      comparison.reference_observation_id,
      `${path}.reference_observation_id`,
      issues
    );
    const delta = readFiniteNumber(comparison.delta, `${path}.delta`, issues);
    if (comparison.judgement !== undefined) {
      readNonEmptyString(comparison.judgement, `${path}.judgement`, issues);
    }
    if (comparison.evidence_refs !== undefined) {
      validateStringArray(comparison.evidence_refs, `${path}.evidence_refs`, issues);
    }
    comparisonData.push({ index, subjectObservationId, referenceObservationId, delta });
    if (subjectObservationId && referenceObservationId) {
      const signature = `${subjectObservationId}\u0000${referenceObservationId}`;
      const priorIndex = comparisonSignatures.get(signature);
      if (priorIndex !== undefined) {
        issues.push(
          `${path} duplicates the subject/reference pair of results_artifact.comparisons[${priorIndex}].`
        );
      } else {
        comparisonSignatures.set(signature, index);
      }
    }
  }

  if (series) {
    for (const observation of observationData) {
      if (observation.seriesId && !seriesIds.has(observation.seriesId)) {
        issues.push(
          `results_artifact.observations[${observation.index}].series_id references unknown series id "${observation.seriesId}".`
        );
      }
    }
  }
  if (metrics) {
    for (const observation of observationData) {
      if (observation.metricId && !metricIds.has(observation.metricId)) {
        issues.push(
          `results_artifact.observations[${observation.index}].metric_id references unknown metric id "${observation.metricId}".`
        );
      }
    }
  }
  if (observations) {
    for (const comparison of comparisonData) {
      const path = `results_artifact.comparisons[${comparison.index}]`;
      const subject = comparison.subjectObservationId
        ? observationById.get(comparison.subjectObservationId)
        : undefined;
      const reference = comparison.referenceObservationId
        ? observationById.get(comparison.referenceObservationId)
        : undefined;
      if (comparison.subjectObservationId && !subject) {
        issues.push(
          `${path}.subject_observation_id references unknown observation id "${comparison.subjectObservationId}".`
        );
      }
      if (comparison.referenceObservationId && !reference) {
        issues.push(
          `${path}.reference_observation_id references unknown observation id "${comparison.referenceObservationId}".`
        );
      }
      if (subject?.metricId && reference?.metricId && subject.metricId !== reference.metricId) {
        issues.push(
          `${path} must compare observations for the same metric; received "${subject.metricId}" and "${reference.metricId}".`
        );
      }
      const subjectSeries = subject?.seriesId
        ? seriesById.get(subject.seriesId)
        : undefined;
      const referenceSeries = reference?.seriesId
        ? seriesById.get(reference.seriesId)
        : undefined;
      if (subjectSeries && referenceSeries) {
        appendResultsComparisonRoleIssues(
          path,
          subjectSeries.role,
          referenceSeries.role,
          issues
        );
      }
      if (
        comparison.delta !== undefined
        && subject?.value !== undefined
        && reference?.value !== undefined
      ) {
        const expectedDelta = subject.value - reference.value;
        if (!matchesComparisonDelta(comparison.delta, expectedDelta)) {
          issues.push(
            `${path}.delta must equal subject value minus reference value within tolerance ${RESULTS_COMPARISON_DELTA_TOLERANCE}; expected ${expectedDelta}, received ${comparison.delta}.`
          );
        }
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues
  };
}

export function validateResultsPlanV2(value: unknown): ResultsContractValidation {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: ["results_plan must be an object."]
    };
  }

  if (value.schema_version !== RESULTS_ARTIFACT_SCHEMA_VERSION) {
    issues.push(`results_plan.schema_version must be "${RESULTS_ARTIFACT_SCHEMA_VERSION}".`);
  }
  const requiredMetrics = readRequiredArray(
    value.required_metrics,
    "results_plan.required_metrics",
    issues
  );
  const seenRequiredMetricIds = new Map<string, number>();
  for (const [index, candidate] of (requiredMetrics ?? []).entries()) {
    const path = `results_plan.required_metrics[${index}]`;
    const metric = readRecord(candidate, path, issues);
    if (!metric) {
      continue;
    }
    const id = readNonEmptyString(metric.id, `${path}.id`, issues);
    readNonEmptyString(metric.label, `${path}.label`, issues);
    if (!isResultsTableDirection(metric.direction)) {
      issues.push(`${path}.direction must be higher_better or lower_better.`);
    }
    readNonEmptyString(metric.unit, `${path}.unit`, issues);
    if (!id) {
      continue;
    }
    const priorIndex = seenRequiredMetricIds.get(id);
    if (priorIndex !== undefined) {
      issues.push(
        `${path}.id duplicates results_plan.required_metrics[${priorIndex}].id value "${id}".`
      );
    } else {
      seenRequiredMetricIds.set(id, index);
    }
  }
  if (requiredMetrics && requiredMetrics.length === 0) {
    issues.push("results_plan.required_metrics must include at least one explicit metric definition.");
  }
  readNonNegativeInteger(
    value.minimum_series_count,
    "results_plan.minimum_series_count",
    issues
  );
  readNonNegativeInteger(
    value.minimum_comparison_count,
    "results_plan.minimum_comparison_count",
    issues
  );
  const requiredSeriesById = new Map<string, SeriesValidationData>();
  if (value.required_series !== undefined) {
    const requiredSeries = readRequiredArray(
      value.required_series,
      "results_plan.required_series",
      issues
    );
    const requiredSeriesIds = new Map<string, number>();
    for (const [index, candidate] of (requiredSeries ?? []).entries()) {
      const path = `results_plan.required_series[${index}]`;
      const series = readRecord(candidate, path, issues);
      if (!series) {
        continue;
      }
      const id = readNonEmptyString(series.id, `${path}.id`, issues);
      registerUniqueId(id, index, "results_plan.required_series", requiredSeriesIds, issues);
      if (!isResultsSeriesRole(series.role)) {
        issues.push(`${path}.role must be baseline, comparator, primary, control, or other.`);
      }
      if (id && !requiredSeriesById.has(id)) {
        requiredSeriesById.set(id, { index, id, role: series.role });
      }
    }
  }
  let requiredComparisonCount = 0;
  const requiredComparisonIds = new Map<string, number>();
  const requiredComparisonsById = new Map<
    string,
    { index: number; metricId?: string }
  >();
  if (value.required_comparisons !== undefined) {
    const requiredComparisons = readRequiredArray(
      value.required_comparisons,
      "results_plan.required_comparisons",
      issues
    );
    requiredComparisonCount = requiredComparisons?.length ?? 0;
    for (const [index, candidate] of (requiredComparisons ?? []).entries()) {
      const path = `results_plan.required_comparisons[${index}]`;
      const comparison = readRecord(candidate, path, issues);
      if (!comparison) {
        continue;
      }
      const id = readNonEmptyString(comparison.id, `${path}.id`, issues);
      registerUniqueId(id, index, "results_plan.required_comparisons", requiredComparisonIds, issues);
      const subjectSeriesId = readNonEmptyString(
        comparison.subject_series_id,
        `${path}.subject_series_id`,
        issues
      );
      const referenceSeriesId = readNonEmptyString(
        comparison.reference_series_id,
        `${path}.reference_series_id`,
        issues
      );
      const metricId = readNonEmptyString(comparison.metric_id, `${path}.metric_id`, issues);
      if (id && !requiredComparisonsById.has(id)) {
        requiredComparisonsById.set(id, { index, metricId });
      }
      if (comparison.scope !== undefined) {
        validateScalarRecord(comparison.scope, `${path}.scope`, issues);
      }
      const subjectSeries = subjectSeriesId
        ? requiredSeriesById.get(subjectSeriesId)
        : undefined;
      const referenceSeries = referenceSeriesId
        ? requiredSeriesById.get(referenceSeriesId)
        : undefined;
      if (subjectSeriesId && !subjectSeries) {
        issues.push(
          `${path}.subject_series_id references undefined results_plan.required_series id "${subjectSeriesId}".`
        );
      }
      if (referenceSeriesId && !referenceSeries) {
        issues.push(
          `${path}.reference_series_id references undefined results_plan.required_series id "${referenceSeriesId}".`
        );
      }
      if (subjectSeries && referenceSeries) {
        appendResultsComparisonRoleIssues(
          path,
          subjectSeries.role,
          referenceSeries.role,
          issues
        );
      }
    }
  }
  const primarySelectionValidation = validateResultsPrimaryComparisonSelectionV2({
    comparisonIds: [...requiredComparisonIds.keys()],
    comparisonCount: requiredComparisonCount,
    primaryComparisonId: value.primary_comparison_id,
    primaryPath: "results_plan.primary_comparison_id",
    comparisonsPath: "results_plan.required_comparisons"
  });
  issues.push(...primarySelectionValidation.issues);
  if (value.primary_effect_criterion !== undefined) {
    const path = "results_plan.primary_effect_criterion";
    const criterion = readRecord(value.primary_effect_criterion, path, issues);
    if (criterion) {
      const knownFields = new Set([
        "comparison_id",
        "metric_id",
        "metric_scale",
        "direction",
        "effect_criterion"
      ]);
      for (const field of Object.keys(criterion)) {
        if (!knownFields.has(field)) {
          issues.push(`${path}.${field} is not allowed.`);
        }
      }
      const comparisonId = readNonEmptyString(
        criterion.comparison_id,
        `${path}.comparison_id`,
        issues
      );
      const metricId = readNonEmptyString(
        criterion.metric_id,
        `${path}.metric_id`,
        issues
      );
      if (!isExplicitMetricScale(criterion.metric_scale)) {
        issues.push(`${path}.metric_scale must be raw, proportion, percent, or percentage_point.`);
      }
      if (criterion.direction !== "maximize" && criterion.direction !== "minimize") {
        issues.push(`${path}.direction must be maximize or minimize.`);
      }
      const effectValidation = validateEffectCriterion(criterion.effect_criterion);
      for (const reason of effectValidation.reasons) {
        issues.push(`${path}.effect_criterion is invalid: ${reason}.`);
      }
      if (comparisonId && comparisonId !== value.primary_comparison_id) {
        issues.push(`${path}.comparison_id must equal results_plan.primary_comparison_id.`);
      }
      const requiredComparison = comparisonId
        ? requiredComparisonsById.get(comparisonId)
        : undefined;
      if (comparisonId && !requiredComparison) {
        issues.push(
          `${path}.comparison_id references undefined results_plan.required_comparisons id "${comparisonId}".`
        );
      }
      if (metricId && !seenRequiredMetricIds.has(metricId)) {
        issues.push(
          `${path}.metric_id references undefined results_plan.required_metrics id "${metricId}".`
        );
      }
      if (metricId && requiredComparison?.metricId && metricId !== requiredComparison.metricId) {
        issues.push(
          `${path}.metric_id must equal the primary required comparison metric_id "${requiredComparison.metricId}".`
        );
      }
      const requiredMetricIndex = metricId ? seenRequiredMetricIds.get(metricId) : undefined;
      const requiredMetric = requiredMetricIndex === undefined
        ? undefined
        : readRecord(requiredMetrics?.[requiredMetricIndex], "", []);
      const expectedDirection = criterion.direction === "minimize"
        ? "lower_better"
        : criterion.direction === "maximize"
          ? "higher_better"
          : undefined;
      if (requiredMetric && expectedDirection && requiredMetric.direction !== expectedDirection) {
        issues.push(
          `${path}.direction conflicts with results_plan.required_metrics[${requiredMetricIndex}].direction.`
        );
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "observations")) {
    issues.push("results_plan.observations is not allowed; plans declare requirements only.");
  }

  return {
    valid: issues.length === 0,
    issues
  };
}

export function validateResultsPrimaryComparisonSelectionV2(input: {
  comparisonIds: readonly string[];
  comparisonCount: number;
  primaryComparisonId: unknown;
  primaryPath: string;
  comparisonsPath: string;
}): ResultsContractValidation {
  const issues: string[] = [];
  if (input.comparisonCount === 0) {
    if (input.primaryComparisonId !== undefined) {
      issues.push(
        `${input.primaryPath} must be omitted when ${input.comparisonsPath} is empty.`
      );
    }
    return { valid: issues.length === 0, issues };
  }

  if (
    typeof input.primaryComparisonId !== "string"
    || input.primaryComparisonId.trim().length === 0
  ) {
    issues.push(
      `${input.primaryPath} is required when ${input.comparisonsPath} includes one or more comparisons.`
    );
    return { valid: false, issues };
  }

  if (!input.comparisonIds.includes(input.primaryComparisonId)) {
    issues.push(
      `${input.primaryPath} references unknown comparison id "${input.primaryComparisonId}" in ${input.comparisonsPath}.`
    );
  }
  return {
    valid: issues.length === 0,
    issues
  };
}

export function checkResultsContractCompleteness(
  artifactValue: unknown,
  planValue: unknown
): ResultsContractCompleteness {
  const artifactValidation = validateResultsArtifactV2(artifactValue);
  const planValidation = validateResultsPlanV2(planValue);
  const issues = [...artifactValidation.issues, ...planValidation.issues];
  if (!artifactValidation.valid || !planValidation.valid) {
    return { complete: false, issues };
  }

  const artifact = artifactValue as ResultsArtifactV2;
  const plan = planValue as ResultsPlanV2;
  const metricsById = new Map(artifact.metrics.map((metric) => [metric.id, metric]));
  const seriesById = new Map(artifact.series.map((series) => [series.id, series]));
  const observedMetricIds = new Set(artifact.observations.map((observation) => observation.metric_id));

  for (const [index, requiredMetric] of plan.required_metrics.entries()) {
    const observedMetric = metricsById.get(requiredMetric.id);
    if (!observedMetric) {
      issues.push(
        `results_plan.required_metrics[${index}] references undefined metric id "${requiredMetric.id}".`
      );
      continue;
    }
    if (observedMetric.direction !== requiredMetric.direction) {
      issues.push(
        `results_plan.required_metrics[${index}] requires direction "${requiredMetric.direction}" for metric "${requiredMetric.id}", received "${observedMetric.direction}".`
      );
    }
    if ((observedMetric.unit?.trim() || undefined) !== (requiredMetric.unit?.trim() || undefined)) {
      issues.push(
        `results_plan.required_metrics[${index}] requires unit "${requiredMetric.unit?.trim() || "unspecified"}" for metric "${requiredMetric.id}", received "${observedMetric.unit?.trim() || "unspecified"}".`
      );
    }
    if (!observedMetricIds.has(requiredMetric.id)) {
      issues.push(`required metric id "${requiredMetric.id}" has no observation.`);
    }
  }
  if (artifact.series.length < plan.minimum_series_count) {
    issues.push(
      `results_artifact.series has ${artifact.series.length} item(s), below minimum_series_count ${plan.minimum_series_count}.`
    );
  }
  if (artifact.comparisons.length < plan.minimum_comparison_count) {
    issues.push(
      `results_artifact.comparisons has ${artifact.comparisons.length} item(s), below minimum_comparison_count ${plan.minimum_comparison_count}.`
    );
  }
  for (const [index, requiredSeries] of (plan.required_series ?? []).entries()) {
    const observedSeries = seriesById.get(requiredSeries.id);
    if (!observedSeries) {
      issues.push(
        `results_plan.required_series[${index}] references missing series id "${requiredSeries.id}".`
      );
      continue;
    }
    if (requiredSeries.role !== undefined && observedSeries.role !== requiredSeries.role) {
      issues.push(
        `results_plan.required_series[${index}] requires role "${requiredSeries.role}" for series "${requiredSeries.id}", received "${observedSeries.role ?? "unspecified"}".`
      );
    }
  }
  for (const [index, requiredComparison] of (plan.required_comparisons ?? []).entries()) {
    const issue = findRequiredComparisonIssue(artifact, requiredComparison, index);
    if (issue) {
      issues.push(issue);
    }
  }

  return {
    complete: issues.length === 0,
    issues
  };
}

function findRequiredComparisonIssue(
  artifact: ResultsArtifactV2,
  required: ResultsRequiredComparisonV2,
  index: number
): string | undefined {
  const path = `results_plan.required_comparisons[${index}]`;
  if (!artifact.metrics.some((metric) => metric.id === required.metric_id)) {
    return `${path} references undefined metric id "${required.metric_id}".`;
  }
  if (!artifact.series.some((series) => series.id === required.subject_series_id)) {
    return `${path} references missing subject series id "${required.subject_series_id}".`;
  }
  if (!artifact.series.some((series) => series.id === required.reference_series_id)) {
    return `${path} references missing reference series id "${required.reference_series_id}".`;
  }
  const scope = required.scope ?? {};
  const subject = artifact.observations.find(
    (observation) =>
      observation.series_id === required.subject_series_id
      && observation.metric_id === required.metric_id
      && equalScalarRecords(observation.scope, scope)
  );
  const reference = artifact.observations.find(
    (observation) =>
      observation.series_id === required.reference_series_id
      && observation.metric_id === required.metric_id
      && equalScalarRecords(observation.scope, scope)
  );
  if (!subject || !reference) {
    return `${path} has no complete subject/reference observation pair for metric "${required.metric_id}" at the required scope.`;
  }
  const comparison = artifact.comparisons.find(
    (item) =>
      item.id === required.id
      && item.subject_observation_id === subject.id
      && item.reference_observation_id === reference.id
  );
  if (!comparison) {
    return `${path} is missing comparison id "${required.id}" with the required subject/reference observations.`;
  }
  return undefined;
}

export function adaptResultsTableSchemaV1ToV2(rows: ResultsTableSchema): ResultsArtifactV2 {
  const artifact: ResultsArtifactV2 = {
    schema_version: RESULTS_ARTIFACT_SCHEMA_VERSION,
    metrics: [],
    series: [
      {
        id: "results-v1-series-baseline",
        label: "Results V1 baseline series",
        role: "baseline",
        dimensions: { source_schema: "results_table_v1" }
      },
      {
        id: "results-v1-series-comparator",
        label: "Results V1 comparator series",
        role: "comparator",
        dimensions: { source_schema: "results_table_v1" }
      }
    ],
    observations: [],
    comparisons: []
  };
  const metricOccurrences = new Map<string, number>();

  for (const row of rows) {
    const metricKey = `${row.metric}\u0000${row.direction}`;
    const occurrence = (metricOccurrences.get(metricKey) ?? 0) + 1;
    metricOccurrences.set(metricKey, occurrence);
    const metricId = buildResultsTableV1MetricId(row, occurrence);
    artifact.metrics.push({
      id: metricId,
      label: row.metric,
      direction: row.direction
    });

    const baselineObservationId = `${metricId}:baseline-observation`;
    const comparatorObservationId = `${metricId}:comparator-observation`;
    const hasBaseline = typeof row.baseline === "number" && Number.isFinite(row.baseline);
    const hasComparator = typeof row.comparator === "number" && Number.isFinite(row.comparator);
    if (hasBaseline) {
      artifact.observations.push({
        id: baselineObservationId,
        series_id: "results-v1-series-baseline",
        metric_id: metricId,
        scope: {},
        value: row.baseline as number
      });
    }
    if (hasComparator) {
      artifact.observations.push({
        id: comparatorObservationId,
        series_id: "results-v1-series-comparator",
        metric_id: metricId,
        scope: {},
        value: row.comparator as number
      });
    }
    if (hasBaseline && hasComparator) {
      const computedDelta = (row.comparator as number) - (row.baseline as number);
      artifact.comparisons.push({
        id: `${metricId}:comparison`,
        subject_observation_id: comparatorObservationId,
        reference_observation_id: baselineObservationId,
        delta: computedDelta
      });
    }
  }

  return artifact;
}

function readRequiredArray(
  value: unknown,
  path: string,
  issues: string[]
): unknown[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array.`);
    return undefined;
  }
  return value;
}

function readRecord(
  value: unknown,
  path: string,
  issues: string[]
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object.`);
    return undefined;
  }
  return value;
}

function readNonEmptyString(
  value: unknown,
  path: string,
  issues: string[]
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty string.`);
    return undefined;
  }
  return value;
}

function readFiniteNumber(
  value: unknown,
  path: string,
  issues: string[]
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${path} must be a finite number.`);
    return undefined;
  }
  return value;
}

function readNonNegativeInteger(
  value: unknown,
  path: string,
  issues: string[]
): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    issues.push(`${path} must be a non-negative integer.`);
    return undefined;
  }
  return value;
}

function validateStringArray(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array of non-empty strings.`);
    return;
  }
  for (const [index, item] of value.entries()) {
    readNonEmptyString(item, `${path}[${index}]`, issues);
  }
}

function validateScalarRecord(value: unknown, path: string, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object whose values are scalar.`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!isResultsScalar(item)) {
      issues.push(
        `${path}[${JSON.stringify(key)}] must be a string, finite number, boolean, or null.`
      );
    }
  }
}

function registerUniqueId(
  id: string | undefined,
  index: number,
  collectionPath: string,
  ids: Map<string, number>,
  issues: string[]
): void {
  if (!id) {
    return;
  }
  const priorIndex = ids.get(id);
  if (priorIndex !== undefined) {
    issues.push(
      `${collectionPath}[${index}].id duplicates ${collectionPath}[${priorIndex}].id "${id}".`
    );
    return;
  }
  ids.set(id, index);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isResultsScalar(value: unknown): value is ResultsScalar {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function isResultsTableDirection(value: unknown): value is ResultsTableDirection {
  return value === "higher_better" || value === "lower_better";
}

function isResultsSeriesRole(value: unknown): value is ResultsSeriesRole {
  return value === "baseline"
    || value === "comparator"
    || value === "primary"
    || value === "control"
    || value === "other";
}

function appendResultsComparisonRoleIssues(
  comparisonPath: string,
  subjectRole: unknown,
  referenceRole: unknown,
  issues: string[]
): void {
  if (subjectRole !== "primary" && subjectRole !== "comparator") {
    issues.push(
      `${comparisonPath} requires subject series role primary or comparator; received ${formatSeriesRole(subjectRole)}.`
    );
  }
  if (referenceRole !== "baseline") {
    issues.push(
      `${comparisonPath} requires reference series role baseline; received ${formatSeriesRole(referenceRole)}.`
    );
  }
}

function formatSeriesRole(role: unknown): string {
  if (typeof role !== "string" || role.trim().length === 0) {
    return "unspecified";
  }
  return `"${role}"`;
}

function matchesComparisonDelta(actual: number, expected: number): boolean {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return Math.abs(actual - expected) <= RESULTS_COMPARISON_DELTA_TOLERANCE * scale;
}

function buildObservationSignature(
  seriesId: string,
  metricId: string,
  scope: Record<string, unknown>
): string {
  return `${seriesId}\u0000${metricId}\u0000${canonicalScalarRecord(scope)}`;
}

function equalScalarRecords(
  left: Record<string, ResultsScalar>,
  right: Record<string, ResultsScalar>
): boolean {
  return canonicalScalarRecord(left) === canonicalScalarRecord(right);
}

function canonicalScalarRecord(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, value[key]])
  );
}

function buildResultsTableV1MetricId(row: ResultsTableRow, occurrence: number): string {
  return `results-v1-metric:${encodeURIComponent(row.metric)}:${row.direction}:${occurrence}`;
}
