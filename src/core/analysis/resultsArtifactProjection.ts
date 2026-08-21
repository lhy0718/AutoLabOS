import {
  RESULTS_ARTIFACT_SCHEMA_VERSION,
  validateResultsArtifactV2,
  type ResultsArtifactV2,
  type ResultsComparisonV2,
  type ResultsMetricDefinitionV2,
  type ResultsObservationV2,
  type ResultsScalar,
  type ResultsSeriesRole,
  type ResultsSeriesV2,
  type ResultsTableDirection
} from "./resultsTableSchema.js";

export interface ResultsArtifactProjectionInput {
  metrics: Record<string, unknown>;
  primaryMetricId?: string;
  preferredMetricIds?: string[];
  fallbackDirection?: ResultsTableDirection;
  evidenceRef?: string;
}

export type ResultsArtifactProjectionSource =
  | "explicit_results_artifact"
  | "generic_metrics";

export interface ResultsArtifactProjectionResult {
  artifact: ResultsArtifactV2;
  source: ResultsArtifactProjectionSource;
  valid: boolean;
  blocked: boolean;
  issues: string[];
  warnings: string[];
}

interface ConditionSource {
  path: string;
  record: Record<string, unknown>;
}

interface RoleClaim {
  role: ResultsSeriesRole;
  path: string;
}

interface ConditionDraft {
  id: string;
  label: string;
  dimensions: Record<string, ResultsScalar>;
  scope: Record<string, ResultsScalar>;
  scopeValid: boolean;
  roleClaims: RoleClaim[];
  role?: ResultsSeriesRole;
  sources: ConditionSource[];
}

interface RawObservation {
  conditionId: string;
  metricKey: string;
  scope: Record<string, ResultsScalar>;
  value: number;
  path: string;
}

interface MetricDefinitionCandidate {
  sourceKey: string;
  definition: ResultsMetricDefinitionV2;
  path: string;
}

interface MetricRegistry {
  definitions: ResultsMetricDefinitionV2[];
  byRawKey: Map<string, ResultsMetricDefinitionV2>;
}

interface ConditionPair {
  subjectId: string;
  referenceId: string;
}

interface ScalarRecordRead {
  value: Record<string, ResultsScalar>;
  valid: boolean;
}

const CONDITION_ROW_KEYS = [
  "conditions",
  "condition_results",
  "condition_summaries",
  "per_condition"
] as const;

const CONDITION_IDENTIFIER_KEYS = [
  "condition_id",
  "condition",
  "name",
  "id"
] as const;

const COMPARISON_ROW_KEYS = [
  "comparisons",
  "comparison_rows",
  "condition_comparisons"
] as const;

const COMPARISON_SUBJECT_KEYS = [
  "subject_condition_id",
  "subject_condition",
  "subject_series_id",
  "subject_id",
  "subject",
  "primary_condition_id",
  "primary_condition",
  "primary_id",
  "primary",
  "comparator_condition_id",
  "comparator_condition",
  "comparator_id",
  "comparator"
] as const;

const COMPARISON_REFERENCE_KEYS = [
  "reference_condition_id",
  "reference_condition",
  "reference_series_id",
  "reference_id",
  "reference",
  "baseline_condition_id",
  "baseline_condition",
  "baseline_id",
  "baseline",
  "control_condition_id",
  "control_condition",
  "control_id",
  "control"
] as const;

const CONDITION_FLAT_RESERVED_KEYS = new Set([
  ...CONDITION_IDENTIFIER_KEYS,
  "label",
  "role",
  "dimensions",
  "scope",
  "metrics"
]);

const RESULTS_SERIES_ROLES = new Set<ResultsSeriesRole>([
  "baseline",
  "comparator",
  "primary",
  "control",
  "other"
]);

export function projectResultsArtifactV2(
  input: ResultsArtifactProjectionInput
): ResultsArtifactProjectionResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const metrics = isRecord(input.metrics) ? input.metrics : {};

  if (!isRecord(input.metrics)) {
    issues.push("metrics must be an object.");
  }

  if (hasOwn(metrics, "results_artifact")) {
    const validation = validateResultsArtifactV2(metrics.results_artifact);
    if (!validation.valid) {
      issues.push(
        "metrics.results_artifact is present but invalid; generic metric projection was not attempted."
      );
      issues.push(...validation.issues);
      return finalizeProjection({
        artifact: createEmptyArtifact(),
        source: "explicit_results_artifact",
        blocked: true,
        issues,
        warnings
      });
    }

    return finalizeProjection({
      artifact: cloneResultsArtifactV2(metrics.results_artifact as ResultsArtifactV2),
      source: "explicit_results_artifact",
      blocked: false,
      issues,
      warnings
    });
  }

  const fallbackDirection = resolveFallbackDirection(input.fallbackDirection, warnings);
  const evidenceRefs = resolveEvidenceRefs(input.evidenceRef, warnings);
  const flatMetricKeys = collectFlatMetricKeys(input, metrics, warnings);
  const conditions = collectConditionDrafts(metrics, issues, warnings);
  applyTopLevelRoleDeclarations(metrics, conditions, issues);
  resolveConditionRoles(conditions, issues);

  const rawObservations = conditions.flatMap((condition) =>
    collectConditionObservations(condition, flatMetricKeys, issues, warnings)
  );
  const metricRegistry = buildMetricRegistry(
    metrics.metric_definitions,
    rawObservations,
    fallbackDirection,
    issues,
    warnings
  );
  const observations = buildObservations(
    rawObservations,
    metricRegistry,
    evidenceRefs,
    issues
  );
  const series = buildSeries(conditions);
  const comparisonPairs = collectComparisonPairs(metrics, series, issues, warnings);
  const comparisons = buildComparisons(
    comparisonPairs,
    observations,
    evidenceRefs,
    issues,
    warnings
  );

  const artifact: ResultsArtifactV2 = {
    schema_version: RESULTS_ARTIFACT_SCHEMA_VERSION,
    metrics: metricRegistry.definitions,
    series,
    observations,
    comparisons
  };

  if (series.length === 0) {
    warnings.push("No unambiguous condition rows were available for projection.");
  } else if (observations.length === 0) {
    warnings.push("No finite metric observations were available for projection.");
  }

  return finalizeProjection({
    artifact,
    source: "generic_metrics",
    blocked: false,
    issues,
    warnings
  });
}

function collectConditionDrafts(
  metrics: Record<string, unknown>,
  issues: string[],
  warnings: string[]
): ConditionDraft[] {
  const rowGroups = new Map<string, ConditionSource[]>();
  const mapGroups = new Map<string, ConditionSource[]>();

  for (const key of CONDITION_ROW_KEYS) {
    const value = metrics[key];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      issues.push(`metrics.${key} must be an array when present.`);
      continue;
    }

    for (const [index, candidate] of value.entries()) {
      const path = `metrics.${key}[${index}]`;
      if (!isRecord(candidate)) {
        issues.push(`${path} must be an object.`);
        continue;
      }
      const conditionId = resolveConditionIdentifier(candidate);
      if (!conditionId) {
        issues.push(
          `${path} must include a non-empty condition_id, condition, name, or id.`
        );
        continue;
      }
      appendMapValue(rowGroups, conditionId, { path, record: candidate });
    }
  }

  if (metrics.condition_metrics !== undefined) {
    if (!isRecord(metrics.condition_metrics)) {
      issues.push("metrics.condition_metrics must be an object when present.");
    } else {
      for (const rawConditionId of Object.keys(metrics.condition_metrics).sort(compareText)) {
        const path = `metrics.condition_metrics[${JSON.stringify(rawConditionId)}]`;
        const conditionId = normalizeIdentifier(rawConditionId);
        const candidate = metrics.condition_metrics[rawConditionId];
        if (!conditionId) {
          issues.push(`${path} must use a non-empty condition id key.`);
          continue;
        }
        if (!isRecord(candidate)) {
          issues.push(`${path} must be an object.`);
          continue;
        }
        const declaredId = resolveConditionIdentifier(candidate);
        if (declaredId && declaredId !== conditionId) {
          issues.push(
            `${path} declares condition id "${declaredId}", which conflicts with map key "${conditionId}".`
          );
          continue;
        }
        appendMapValue(mapGroups, conditionId, { path, record: candidate });
      }
    }
  }

  const conditionIds = [...new Set([...rowGroups.keys(), ...mapGroups.keys()])]
    .sort(compareText);
  const drafts: ConditionDraft[] = [];

  for (const conditionId of conditionIds) {
    const rows = rowGroups.get(conditionId) ?? [];
    const mapEntries = mapGroups.get(conditionId) ?? [];
    if (rows.length > 1 || mapEntries.length > 1) {
      const paths = [...rows, ...mapEntries]
        .map((source) => source.path)
        .sort(compareText);
      issues.push(
        `Condition id "${conditionId}" is duplicated or ambiguous across ${paths.join(", ")}; the condition was omitted.`
      );
      continue;
    }

    const sources = [...rows, ...mapEntries].sort((left, right) =>
      compareText(left.path, right.path)
    );
    const label = resolveConditionLabel(conditionId, sources, issues, warnings);
    const dimensions = mergeScalarRecordField(
      conditionId,
      sources,
      "dimensions",
      false,
      issues
    );
    const scope = mergeScalarRecordField(
      conditionId,
      sources,
      "scope",
      true,
      issues
    );
    const roleClaims: RoleClaim[] = [];

    for (const source of sources) {
      if (!hasOwn(source.record, "role")) {
        continue;
      }
      const role = normalizeRole(source.record.role);
      if (role) {
        roleClaims.push({ role, path: `${source.path}.role` });
      } else {
        warnings.push(
          `${source.path}.role was ignored because it is not baseline, comparator, primary, control, or other.`
        );
      }
    }

    drafts.push({
      id: conditionId,
      label,
      dimensions: dimensions.value,
      scope: scope.value,
      scopeValid: scope.valid,
      roleClaims,
      sources
    });
  }

  return drafts;
}

function resolveConditionLabel(
  conditionId: string,
  sources: ConditionSource[],
  issues: string[],
  warnings: string[]
): string {
  const labels: Array<{ value: string; path: string }> = [];
  for (const source of sources) {
    if (!hasOwn(source.record, "label")) {
      continue;
    }
    const label = normalizeNonEmptyString(source.record.label);
    if (label) {
      labels.push({ value: label, path: `${source.path}.label` });
    } else {
      warnings.push(`${source.path}.label was ignored because it is not a non-empty string.`);
    }
  }

  const distinctLabels = [...new Set(labels.map((item) => item.value))];
  if (distinctLabels.length > 1) {
    issues.push(
      `Condition id "${conditionId}" has conflicting labels at ${labels
        .map((item) => item.path)
        .sort(compareText)
        .join(", ")}; its id was used as the label.`
    );
    return conditionId;
  }
  return distinctLabels[0] ?? conditionId;
}

function mergeScalarRecordField(
  conditionId: string,
  sources: ConditionSource[],
  field: "dimensions" | "scope",
  invalidateOnConflict: boolean,
  issues: string[]
): ScalarRecordRead {
  const valuesByKey = new Map<
    string,
    Array<{ value: ResultsScalar; path: string }>
  >();
  let valid = true;

  for (const source of sources) {
    if (!hasOwn(source.record, field)) {
      continue;
    }
    const path = `${source.path}.${field}`;
    const parsed = readScalarRecord(source.record[field], path, issues);
    if (!parsed.valid && invalidateOnConflict) {
      valid = false;
    }
    for (const [key, value] of Object.entries(parsed.value)) {
      appendMapValue(valuesByKey, key, {
        value,
        path: `${path}[${JSON.stringify(key)}]`
      });
    }
  }

  const merged: Record<string, ResultsScalar> = {};
  for (const key of [...valuesByKey.keys()].sort(compareText)) {
    const candidates = valuesByKey.get(key) ?? [];
    const first = candidates[0];
    if (!first) {
      continue;
    }
    if (candidates.some((candidate) => !sameScalar(candidate.value, first.value))) {
      issues.push(
        `Condition id "${conditionId}" has conflicting ${field}.${key} values at ${candidates
          .map((candidate) => candidate.path)
          .sort(compareText)
          .join(", ")}.`
      );
      if (invalidateOnConflict) {
        valid = false;
      }
      continue;
    }
    setOwnScalar(merged, key, first.value);
  }

  return { value: merged, valid };
}

function applyTopLevelRoleDeclarations(
  metrics: Record<string, unknown>,
  conditions: ConditionDraft[],
  issues: string[]
): void {
  const byId = new Map(conditions.map((condition) => [condition.id, condition]));
  const declarations: Array<{
    key: "baseline_condition" | "primary_condition" | "comparator_condition";
    role: ResultsSeriesRole;
  }> = [
    { key: "baseline_condition", role: "baseline" },
    { key: "primary_condition", role: "primary" },
    { key: "comparator_condition", role: "comparator" }
  ];

  for (const declaration of declarations) {
    if (!hasOwn(metrics, declaration.key) || metrics[declaration.key] === undefined) {
      continue;
    }
    const ids = readIdentifierDeclaration(
      metrics[declaration.key],
      `metrics.${declaration.key}`,
      issues
    );
    for (const id of ids) {
      const condition = byId.get(id);
      if (!condition) {
        issues.push(
          `metrics.${declaration.key} references unknown or ambiguous condition id "${id}".`
        );
        continue;
      }
      condition.roleClaims.push({
        role: declaration.role,
        path: `metrics.${declaration.key}`
      });
    }
  }
}

function resolveConditionRoles(
  conditions: ConditionDraft[],
  issues: string[]
): void {
  for (const condition of conditions) {
    const roles = [...new Set(condition.roleClaims.map((claim) => claim.role))]
      .sort(compareText);
    if (roles.length > 1) {
      issues.push(
        `Condition id "${condition.id}" has conflicting explicit roles ${roles.join(", ")}; no role was assigned.`
      );
      continue;
    }
    condition.role = roles[0];
  }
}

function collectFlatMetricKeys(
  input: ResultsArtifactProjectionInput,
  metrics: Record<string, unknown>,
  warnings: string[]
): Set<string> {
  const keys = new Set<string>();
  appendMetricId(keys, input.primaryMetricId, "primaryMetricId", warnings);

  if (input.preferredMetricIds !== undefined) {
    if (!Array.isArray(input.preferredMetricIds)) {
      warnings.push("preferredMetricIds was ignored because it is not an array.");
    } else {
      for (const [index, value] of input.preferredMetricIds.entries()) {
        appendMetricId(keys, value, `preferredMetricIds[${index}]`, warnings);
      }
    }
  }

  if (metrics.reporting_metrics !== undefined) {
    if (!Array.isArray(metrics.reporting_metrics)) {
      warnings.push(
        "metrics.reporting_metrics was ignored because it is not an array of strings."
      );
    } else {
      for (const [index, value] of metrics.reporting_metrics.entries()) {
        appendMetricId(
          keys,
          value,
          `metrics.reporting_metrics[${index}]`,
          warnings
        );
      }
    }
  }

  return keys;
}

function appendMetricId(
  keys: Set<string>,
  value: unknown,
  path: string,
  warnings: string[]
): void {
  if (value === undefined) {
    return;
  }
  const metricId = normalizeNonEmptyString(value);
  if (!metricId) {
    warnings.push(`${path} was ignored because it is not a non-empty string.`);
    return;
  }
  keys.add(metricId);
}

function collectConditionObservations(
  condition: ConditionDraft,
  flatMetricKeys: Set<string>,
  issues: string[],
  warnings: string[]
): RawObservation[] {
  if (!condition.scopeValid) {
    warnings.push(
      `Condition id "${condition.id}" has an ambiguous scope, so its metric observations were not projected.`
    );
    return [];
  }

  const observations: RawObservation[] = [];
  const nestedMetricKeys = new Set<string>();

  for (const source of condition.sources) {
    if (!hasOwn(source.record, "metrics")) {
      continue;
    }
    const nestedMetrics = source.record.metrics;
    if (!isRecord(nestedMetrics)) {
      issues.push(`${source.path}.metrics must be an object when present.`);
      continue;
    }

    for (const rawMetricKey of Object.keys(nestedMetrics).sort(compareText)) {
      const metricKey = normalizeMetricKey(rawMetricKey);
      const path = `${source.path}.metrics[${JSON.stringify(rawMetricKey)}]`;
      if (!metricKey) {
        issues.push(`${path} must use a non-empty metric key.`);
        continue;
      }
      nestedMetricKeys.add(metricKey);
      collectNestedMetricPayload({
        value: nestedMetrics[rawMetricKey],
        conditionId: condition.id,
        metricKey,
        baseScope: condition.scope,
        path,
        observations,
        issues,
        warnings
      });
    }
  }

  for (const source of condition.sources) {
    for (const rawMetricKey of Object.keys(source.record).sort(compareText)) {
      const metricKey = normalizeMetricKey(rawMetricKey);
      if (
        !metricKey
        || CONDITION_FLAT_RESERVED_KEYS.has(metricKey)
        || nestedMetricKeys.has(metricKey)
        || !flatMetricKeys.has(metricKey)
      ) {
        continue;
      }

      const value = source.record[rawMetricKey];
      const path = `${source.path}[${JSON.stringify(rawMetricKey)}]`;
      if (typeof value === "number" && Number.isFinite(value)) {
        observations.push({
          conditionId: condition.id,
          metricKey,
          scope: cloneScalarRecord(condition.scope),
          value,
          path
        });
      } else {
        warnings.push(`${path} was declared as a metric but is not a finite number.`);
      }
    }
  }

  return observations;
}

function collectNestedMetricPayload(input: {
  value: unknown;
  conditionId: string;
  metricKey: string;
  baseScope: Record<string, ResultsScalar>;
  path: string;
  observations: RawObservation[];
  issues: string[];
  warnings: string[];
}): void {
  if (typeof input.value === "number" && Number.isFinite(input.value)) {
    input.observations.push({
      conditionId: input.conditionId,
      metricKey: input.metricKey,
      scope: cloneScalarRecord(input.baseScope),
      value: input.value,
      path: input.path
    });
    return;
  }

  if (Array.isArray(input.value)) {
    for (const [index, item] of input.value.entries()) {
      collectNestedMetricPayload({
        ...input,
        value: item,
        path: `${input.path}[${index}]`
      });
    }
    return;
  }

  if (!isRecord(input.value)) {
    input.warnings.push(
      `${input.path} was ignored because nested metric values must be finite numbers or scoped value records.`
    );
    return;
  }

  if (hasOwn(input.value, "observations")) {
    if (!Array.isArray(input.value.observations)) {
      input.issues.push(`${input.path}.observations must be an array.`);
      return;
    }
    for (const [index, item] of input.value.observations.entries()) {
      collectNestedMetricPayload({
        ...input,
        value: item,
        path: `${input.path}.observations[${index}]`
      });
    }
    return;
  }

  if (!hasOwn(input.value, "value")) {
    input.warnings.push(
      `${input.path} was ignored because a scoped metric record must include value.`
    );
    return;
  }
  if (typeof input.value.value !== "number" || !Number.isFinite(input.value.value)) {
    input.warnings.push(`${input.path}.value must be a finite number.`);
    return;
  }

  const scope = mergeObservationScope(
    input.baseScope,
    input.value.scope,
    `${input.path}.scope`,
    input.issues
  );
  if (!scope) {
    return;
  }
  input.observations.push({
    conditionId: input.conditionId,
    metricKey: input.metricKey,
    scope,
    value: input.value.value,
    path: input.path
  });
}

function mergeObservationScope(
  baseScope: Record<string, ResultsScalar>,
  rawScope: unknown,
  path: string,
  issues: string[]
): Record<string, ResultsScalar> | undefined {
  if (rawScope === undefined) {
    return cloneScalarRecord(baseScope);
  }
  const parsed = readScalarRecord(rawScope, path, issues);
  if (!parsed.valid) {
    return undefined;
  }

  const merged = cloneScalarRecord(baseScope);
  for (const [key, value] of Object.entries(parsed.value)) {
    if (hasOwn(merged, key) && !sameScalar(merged[key], value)) {
      issues.push(
        `${path}[${JSON.stringify(key)}] conflicts with the condition-level scope value.`
      );
      return undefined;
    }
    setOwnScalar(merged, key, value);
  }
  return sortScalarRecord(merged);
}

function buildMetricRegistry(
  rawDefinitions: unknown,
  observations: RawObservation[],
  fallbackDirection: ResultsTableDirection,
  issues: string[],
  warnings: string[]
): MetricRegistry {
  const hasExplicitDefinitions = rawDefinitions !== undefined;
  const candidates = parseMetricDefinitionCandidates(
    rawDefinitions,
    fallbackDirection,
    issues,
    warnings
  );
  const bySourceGroups = groupBy(candidates, (candidate) => candidate.sourceKey);
  const byIdGroups = groupBy(candidates, (candidate) => candidate.definition.id);
  const ambiguousSourceKeys = new Set<string>();
  const ambiguousIds = new Set<string>();

  for (const [sourceKey, group] of bySourceGroups) {
    if (group.length > 1) {
      ambiguousSourceKeys.add(sourceKey);
      issues.push(
        `metric_definitions contains duplicate source key "${sourceKey}" at ${group
          .map((candidate) => candidate.path)
          .sort(compareText)
          .join(", ")}.`
      );
    }
  }
  for (const [id, group] of byIdGroups) {
    if (group.length > 1) {
      ambiguousIds.add(id);
      issues.push(
        `metric_definitions contains duplicate metric id "${id}" at ${group
          .map((candidate) => candidate.path)
          .sort(compareText)
          .join(", ")}.`
      );
    }
  }

  const accepted = candidates
    .filter(
      (candidate) =>
        !ambiguousSourceKeys.has(candidate.sourceKey)
        && !ambiguousIds.has(candidate.definition.id)
    )
    .sort((left, right) => {
      const idOrder = compareText(left.definition.id, right.definition.id);
      return idOrder || compareText(left.sourceKey, right.sourceKey);
    });
  const definitionsById = new Map<string, ResultsMetricDefinitionV2>();
  const definitionsBySource = new Map<string, ResultsMetricDefinitionV2>();
  for (const candidate of accepted) {
    definitionsById.set(candidate.definition.id, candidate.definition);
    definitionsBySource.set(candidate.sourceKey, candidate.definition);
  }

  const byRawKey = new Map<string, ResultsMetricDefinitionV2>();
  const observedMetricKeys = [...new Set(observations.map((item) => item.metricKey))]
    .sort(compareText);
  for (const metricKey of observedMetricKeys) {
    if (ambiguousSourceKeys.has(metricKey) || ambiguousIds.has(metricKey)) {
      issues.push(
        `Metric key "${metricKey}" was omitted because its explicit definition is ambiguous.`
      );
      continue;
    }

    const explicit = definitionsBySource.get(metricKey) ?? definitionsById.get(metricKey);
    if (explicit) {
      byRawKey.set(metricKey, explicit);
      continue;
    }
    if (hasExplicitDefinitions) {
      issues.push(
        `Metric key "${metricKey}" has no explicit metric definition and was omitted.`
      );
      continue;
    }

    warnings.push(
      `Metric key "${metricKey}" has no explicit direction; fallbackDirection was used.`
    );
    const fallbackDefinition: ResultsMetricDefinitionV2 = {
      id: metricKey,
      label: metricKey,
      direction: fallbackDirection
    };
    definitionsById.set(fallbackDefinition.id, fallbackDefinition);
    definitionsBySource.set(metricKey, fallbackDefinition);
    byRawKey.set(metricKey, fallbackDefinition);
  }

  return {
    definitions: [...definitionsById.values()]
      .map(cloneMetricDefinition)
      .sort((left, right) => compareText(left.id, right.id)),
    byRawKey
  };
}

function parseMetricDefinitionCandidates(
  rawDefinitions: unknown,
  fallbackDirection: ResultsTableDirection,
  issues: string[],
  warnings: string[]
): MetricDefinitionCandidate[] {
  if (rawDefinitions === undefined) {
    return [];
  }

  const candidates: MetricDefinitionCandidate[] = [];
  if (Array.isArray(rawDefinitions)) {
    for (const [index, rawDefinition] of rawDefinitions.entries()) {
      const candidate = parseMetricDefinition({
        rawDefinition,
        path: `metrics.metric_definitions[${index}]`,
        fallbackDirection,
        issues,
        warnings
      });
      if (candidate) {
        candidates.push(candidate);
      }
    }
    return candidates;
  }

  if (!isRecord(rawDefinitions)) {
    issues.push("metrics.metric_definitions must be an array or object when present.");
    return candidates;
  }

  for (const sourceKey of Object.keys(rawDefinitions).sort(compareText)) {
    const candidate = parseMetricDefinition({
      rawDefinition: rawDefinitions[sourceKey],
      mapSourceKey: sourceKey,
      path: `metrics.metric_definitions[${JSON.stringify(sourceKey)}]`,
      fallbackDirection,
      issues,
      warnings
    });
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function parseMetricDefinition(input: {
  rawDefinition: unknown;
  mapSourceKey?: string;
  path: string;
  fallbackDirection: ResultsTableDirection;
  issues: string[];
  warnings: string[];
}): MetricDefinitionCandidate | undefined {
  const mapSourceKey = normalizeMetricKey(input.mapSourceKey);
  if (input.mapSourceKey !== undefined && !mapSourceKey) {
    input.issues.push(`${input.path} must use a non-empty metric definition key.`);
    return undefined;
  }

  if (typeof input.rawDefinition === "string") {
    const value = normalizeNonEmptyString(input.rawDefinition);
    if (!value) {
      input.issues.push(`${input.path} must be a non-empty string or object.`);
      return undefined;
    }
    const sourceKey = mapSourceKey ?? value;
    const id = mapSourceKey ?? value;
    const explicitDirection = mapSourceKey && isResultsTableDirection(value)
      ? value
      : undefined;
    if (!explicitDirection) {
      input.warnings.push(`${input.path} has no explicit direction; fallbackDirection was used.`);
    }
    return {
      sourceKey,
      definition: {
        id,
        label: explicitDirection ? id : mapSourceKey ? value : id,
        direction: explicitDirection ?? input.fallbackDirection
      },
      path: input.path
    };
  }

  if (!isRecord(input.rawDefinition)) {
    input.issues.push(`${input.path} must be a string or object.`);
    return undefined;
  }

  const explicitId = normalizeNonEmptyString(input.rawDefinition.id);
  const sourceKey = mapSourceKey
    ?? normalizeNonEmptyString(input.rawDefinition.metric_key)
    ?? normalizeNonEmptyString(input.rawDefinition.key)
    ?? explicitId;
  const id = explicitId ?? mapSourceKey ?? sourceKey;
  if (!sourceKey || !id) {
    input.issues.push(
      `${input.path} must define a non-empty id, metric_key, or key.`
    );
    return undefined;
  }

  const label = normalizeNonEmptyString(input.rawDefinition.label) ?? id;
  if (
    hasOwn(input.rawDefinition, "label")
    && !normalizeNonEmptyString(input.rawDefinition.label)
  ) {
    input.warnings.push(`${input.path}.label was replaced with metric id "${id}".`);
  }

  let direction: ResultsTableDirection;
  if (isResultsTableDirection(input.rawDefinition.direction)) {
    direction = input.rawDefinition.direction;
  } else {
    if (input.rawDefinition.direction === undefined) {
      input.warnings.push(`${input.path}.direction is absent; fallbackDirection was used.`);
    } else {
      input.issues.push(
        `${input.path}.direction must be higher_better or lower_better.`
      );
    }
    direction = input.fallbackDirection;
  }

  const unit = normalizeNonEmptyString(input.rawDefinition.unit);
  if (input.rawDefinition.unit !== undefined && !unit) {
    input.warnings.push(`${input.path}.unit was ignored because it is not a non-empty string.`);
  }

  return {
    sourceKey,
    definition: {
      id,
      label,
      direction,
      ...(unit ? { unit } : {})
    },
    path: input.path
  };
}

function buildObservations(
  rawObservations: RawObservation[],
  registry: MetricRegistry,
  evidenceRefs: string[],
  issues: string[]
): ResultsObservationV2[] {
  const groups = new Map<
    string,
    Array<RawObservation & { metric: ResultsMetricDefinitionV2 }>
  >();

  for (const observation of rawObservations) {
    const metric = registry.byRawKey.get(observation.metricKey);
    if (!metric) {
      continue;
    }
    const key = stableTuple([
      observation.conditionId,
      metric.id,
      canonicalScalarRecord(observation.scope)
    ]);
    appendMapValue(groups, key, { ...observation, metric });
  }

  const projected: ResultsObservationV2[] = [];
  for (const key of [...groups.keys()].sort(compareText)) {
    const candidates = groups.get(key) ?? [];
    const candidate = candidates[0];
    if (!candidate) {
      continue;
    }
    if (candidates.length > 1) {
      issues.push(
        `Condition id "${candidate.conditionId}" has duplicate or ambiguous observations for metric "${candidate.metric.id}" and scope ${canonicalScalarRecord(candidate.scope)} at ${candidates
          .map((item) => item.path)
          .sort(compareText)
          .join(", ")}; the observation was omitted.`
      );
      continue;
    }

    projected.push({
      id: buildObservationId(
        candidate.conditionId,
        candidate.metric.id,
        candidate.scope
      ),
      series_id: candidate.conditionId,
      metric_id: candidate.metric.id,
      scope: sortScalarRecord(candidate.scope),
      value: candidate.value,
      ...(evidenceRefs.length > 0 ? { evidence_refs: [...evidenceRefs] } : {})
    });
  }

  return projected.sort((left, right) => compareText(left.id, right.id));
}

function buildSeries(conditions: ConditionDraft[]): ResultsSeriesV2[] {
  return conditions
    .map((condition) => ({
      id: condition.id,
      label: condition.label,
      ...(condition.role ? { role: condition.role } : {}),
      dimensions: sortScalarRecord(condition.dimensions)
    }))
    .sort((left, right) => compareText(left.id, right.id));
}

function collectComparisonPairs(
  metrics: Record<string, unknown>,
  series: ResultsSeriesV2[],
  issues: string[],
  warnings: string[]
): ConditionPair[] {
  const seriesById = new Map(series.map((item) => [item.id, item]));
  const pairs = new Map<string, ConditionPair>();

  for (const key of COMPARISON_ROW_KEYS) {
    const value = metrics[key];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      issues.push(`metrics.${key} must be an array when present.`);
      continue;
    }
    for (const [index, candidate] of value.entries()) {
      const path = `metrics.${key}[${index}]`;
      if (!isRecord(candidate)) {
        issues.push(`${path} must be an object.`);
        continue;
      }
      const subjectId = resolveComparisonEndpoint(
        candidate,
        COMPARISON_SUBJECT_KEYS,
        `${path} subject`,
        issues
      );
      const referenceId = resolveComparisonEndpoint(
        candidate,
        COMPARISON_REFERENCE_KEYS,
        `${path} reference`,
        issues
      );
      if (!subjectId || !referenceId) {
        if (!subjectId) {
          issues.push(`${path} must declare an explicit subject condition id.`);
        }
        if (!referenceId) {
          issues.push(`${path} must declare an explicit reference condition id.`);
        }
        continue;
      }
      if (subjectId === referenceId) {
        issues.push(`${path} cannot compare condition id "${subjectId}" with itself.`);
        continue;
      }
      if (!seriesById.has(subjectId)) {
        issues.push(`${path} references unknown subject condition id "${subjectId}".`);
        continue;
      }
      if (!seriesById.has(referenceId)) {
        issues.push(`${path} references unknown reference condition id "${referenceId}".`);
        continue;
      }
      addConditionPair(pairs, { subjectId, referenceId }, path, warnings);
    }
  }

  const baselines = series
    .filter((item) => item.role === "baseline")
    .map((item) => item.id)
    .sort(compareText);
  const subjects = series
    .filter((item) => item.role === "primary" || item.role === "comparator")
    .map((item) => item.id)
    .sort(compareText);
  for (const subjectId of subjects) {
    for (const referenceId of baselines) {
      if (subjectId !== referenceId) {
        addConditionPair(pairs, { subjectId, referenceId });
      }
    }
  }

  return [...pairs.values()].sort((left, right) => {
    const subjectOrder = compareText(left.subjectId, right.subjectId);
    return subjectOrder || compareText(left.referenceId, right.referenceId);
  });
}

function resolveComparisonEndpoint(
  row: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  issues: string[]
): string | undefined {
  const values: Array<{ value: string; key: string }> = [];
  for (const key of keys) {
    if (!hasOwn(row, key)) {
      continue;
    }
    const value = normalizeIdentifier(row[key]);
    if (!value) {
      issues.push(`${label} field "${key}" must be a non-empty condition id.`);
      continue;
    }
    values.push({ value, key });
  }

  const distinct = [...new Set(values.map((item) => item.value))];
  if (distinct.length > 1) {
    issues.push(
      `${label} fields ${values.map((item) => item.key).join(", ")} conflict.`
    );
    return undefined;
  }
  return distinct[0];
}

function addConditionPair(
  pairs: Map<string, ConditionPair>,
  pair: ConditionPair,
  path?: string,
  warnings?: string[]
): void {
  const key = stableTuple([pair.subjectId, pair.referenceId]);
  if (pairs.has(key)) {
    if (path && warnings) {
      warnings.push(`${path} duplicates an already explicit comparison pair and was deduplicated.`);
    }
    return;
  }
  pairs.set(key, pair);
}

function buildComparisons(
  pairs: ConditionPair[],
  observations: ResultsObservationV2[],
  evidenceRefs: string[],
  issues: string[],
  warnings: string[]
): ResultsComparisonV2[] {
  const observationsBySeries = new Map<
    string,
    Map<string, ResultsObservationV2>
  >();
  for (const observation of observations) {
    let seriesObservations = observationsBySeries.get(observation.series_id);
    if (!seriesObservations) {
      seriesObservations = new Map();
      observationsBySeries.set(observation.series_id, seriesObservations);
    }
    seriesObservations.set(
      stableTuple([
        observation.metric_id,
        canonicalScalarRecord(observation.scope)
      ]),
      observation
    );
  }

  const comparisons: ResultsComparisonV2[] = [];
  for (const pair of pairs) {
    const subjectObservations = observationsBySeries.get(pair.subjectId);
    const referenceObservations = observationsBySeries.get(pair.referenceId);
    if (!subjectObservations || !referenceObservations) {
      warnings.push(
        `Comparison pair "${pair.subjectId}" versus "${pair.referenceId}" has no shared observations.`
      );
      continue;
    }

    const sharedKeys = [...subjectObservations.keys()]
      .filter((key) => referenceObservations.has(key))
      .sort(compareText);
    if (sharedKeys.length === 0) {
      warnings.push(
        `Comparison pair "${pair.subjectId}" versus "${pair.referenceId}" has no shared metric and scope pairs.`
      );
      continue;
    }

    for (const key of sharedKeys) {
      const subject = subjectObservations.get(key);
      const reference = referenceObservations.get(key);
      if (!subject || !reference) {
        continue;
      }
      const delta = subject.value - reference.value;
      if (!Number.isFinite(delta)) {
        issues.push(
          `Comparison of observations "${subject.id}" and "${reference.id}" produced a non-finite delta.`
        );
        continue;
      }
      comparisons.push({
        id: buildComparisonId(subject.id, reference.id),
        subject_observation_id: subject.id,
        reference_observation_id: reference.id,
        delta,
        ...(evidenceRefs.length > 0 ? { evidence_refs: [...evidenceRefs] } : {})
      });
    }
  }

  return comparisons.sort((left, right) => compareText(left.id, right.id));
}

function parseResultsSeriesRole(value: unknown): ResultsSeriesRole | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase() as ResultsSeriesRole;
  return RESULTS_SERIES_ROLES.has(normalized) ? normalized : undefined;
}

function normalizeRole(value: unknown): ResultsSeriesRole | undefined {
  return parseResultsSeriesRole(value);
}

function readIdentifierDeclaration(
  value: unknown,
  path: string,
  issues: string[]
): string[] {
  const values = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const [index, item] of values.entries()) {
    const id = normalizeIdentifier(item);
    if (!id) {
      const itemPath = Array.isArray(value) ? `${path}[${index}]` : path;
      issues.push(`${itemPath} must be a non-empty condition id.`);
      continue;
    }
    ids.push(id);
  }
  return [...new Set(ids)].sort(compareText);
}

function readScalarRecord(
  value: unknown,
  path: string,
  issues: string[]
): ScalarRecordRead {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object whose values are scalar.`);
    return { value: {}, valid: false };
  }

  const result: Record<string, ResultsScalar> = {};
  let valid = true;
  for (const key of Object.keys(value).sort(compareText)) {
    const candidate = value[key];
    if (!isResultsScalar(candidate)) {
      issues.push(
        `${path}[${JSON.stringify(key)}] must be a string, finite number, boolean, or null.`
      );
      valid = false;
      continue;
    }
    setOwnScalar(result, key, candidate);
  }
  return { value: result, valid };
}

function resolveFallbackDirection(
  value: unknown,
  warnings: string[]
): ResultsTableDirection {
  if (value === undefined) {
    warnings.push(
      "fallbackDirection was not supplied; higher_better was used as an explicit compatibility default."
    );
    return "higher_better";
  }
  if (isResultsTableDirection(value)) {
    return value;
  }
  warnings.push(
    "fallbackDirection was ignored because it is not higher_better or lower_better."
  );
  return "higher_better";
}

function resolveEvidenceRefs(value: unknown, warnings: string[]): string[] {
  if (value === undefined) {
    return [];
  }
  const evidenceRef = normalizeNonEmptyString(value);
  if (!evidenceRef) {
    warnings.push("evidenceRef was ignored because it is not a non-empty string.");
    return [];
  }
  return [evidenceRef];
}

function resolveConditionIdentifier(
  row: Record<string, unknown>
): string | undefined {
  for (const key of CONDITION_IDENTIFIER_KEYS) {
    const value = normalizeIdentifier(row[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeIdentifier(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function normalizeMetricKey(value: unknown): string | undefined {
  return normalizeNonEmptyString(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function isResultsTableDirection(value: unknown): value is ResultsTableDirection {
  return value === "higher_better" || value === "lower_better";
}

function isResultsScalar(value: unknown): value is ResultsScalar {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function sameScalar(left: ResultsScalar, right: ResultsScalar): boolean {
  return Object.is(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function appendMapValue<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

function groupBy<T>(
  values: T[],
  keyForValue: (value: T) => string
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    appendMapValue(groups, keyForValue(value), value);
  }
  return groups;
}

function cloneScalarRecord(
  value: Record<string, ResultsScalar>
): Record<string, ResultsScalar> {
  return sortScalarRecord(value);
}

function sortScalarRecord(
  value: Record<string, ResultsScalar>
): Record<string, ResultsScalar> {
  const sorted: Record<string, ResultsScalar> = {};
  for (const key of Object.keys(value).sort(compareText)) {
    setOwnScalar(sorted, key, value[key]);
  }
  return sorted;
}

function canonicalScalarRecord(value: Record<string, ResultsScalar>): string {
  return JSON.stringify(sortScalarRecord(value));
}

function stableTuple(values: string[]): string {
  return JSON.stringify(values);
}

function buildObservationId(
  seriesId: string,
  metricId: string,
  scope: Record<string, ResultsScalar>
): string {
  return `observation:${encodeIdParts([
    seriesId,
    metricId,
    canonicalScalarRecord(scope)
  ])}`;
}

function buildComparisonId(
  subjectObservationId: string,
  referenceObservationId: string
): string {
  return `comparison:${encodeIdParts([
    subjectObservationId,
    referenceObservationId
  ])}`;
}

function encodeIdParts(values: string[]): string {
  return values.map((value) => `${value.length}:${value}`).join("|");
}

function setOwnScalar(
  record: Record<string, ResultsScalar>,
  key: string,
  value: ResultsScalar
): void {
  Object.defineProperty(record, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function cloneMetricDefinition(
  metric: ResultsMetricDefinitionV2
): ResultsMetricDefinitionV2 {
  return {
    id: metric.id,
    label: metric.label,
    direction: metric.direction,
    ...(metric.unit !== undefined ? { unit: metric.unit } : {})
  };
}

function cloneResultsArtifactV2(artifact: ResultsArtifactV2): ResultsArtifactV2 {
  return {
    schema_version: RESULTS_ARTIFACT_SCHEMA_VERSION,
    metrics: artifact.metrics.map(cloneMetricDefinition),
    series: artifact.series.map((series) => ({
      id: series.id,
      label: series.label,
      ...(series.role !== undefined ? { role: series.role } : {}),
      dimensions: cloneScalarRecord(series.dimensions)
    })),
    observations: artifact.observations.map((observation) => ({
      id: observation.id,
      series_id: observation.series_id,
      metric_id: observation.metric_id,
      scope: cloneScalarRecord(observation.scope),
      value: observation.value,
      ...(observation.evidence_refs !== undefined
        ? { evidence_refs: [...observation.evidence_refs] }
        : {})
    })),
    comparisons: artifact.comparisons.map((comparison) => ({
      id: comparison.id,
      subject_observation_id: comparison.subject_observation_id,
      reference_observation_id: comparison.reference_observation_id,
      delta: comparison.delta,
      ...(comparison.judgement !== undefined
        ? { judgement: comparison.judgement }
        : {}),
      ...(comparison.evidence_refs !== undefined
        ? { evidence_refs: [...comparison.evidence_refs] }
        : {})
    }))
  };
}

function createEmptyArtifact(): ResultsArtifactV2 {
  return {
    schema_version: RESULTS_ARTIFACT_SCHEMA_VERSION,
    metrics: [],
    series: [],
    observations: [],
    comparisons: []
  };
}

function finalizeProjection(input: {
  artifact: ResultsArtifactV2;
  source: ResultsArtifactProjectionSource;
  blocked: boolean;
  issues: string[];
  warnings: string[];
}): ResultsArtifactProjectionResult {
  const issues = uniqueMessages(input.issues);
  const warnings = uniqueMessages(input.warnings);
  const validation = validateResultsArtifactV2(input.artifact);
  if (!validation.valid) {
    const validationIssues = validation.issues.map(
      (issue) => `Projected artifact validation failed: ${issue}`
    );
    return {
      artifact: createEmptyArtifact(),
      source: input.source,
      valid: false,
      blocked: true,
      issues: uniqueMessages([...issues, ...validationIssues]),
      warnings
    };
  }

  return {
    artifact: input.artifact,
    source: input.source,
    valid: !input.blocked && issues.length === 0,
    blocked: input.blocked,
    issues,
    warnings
  };
}

function uniqueMessages(messages: string[]): string[] {
  return [...new Set(messages)];
}
