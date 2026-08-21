import type {
  ObjectiveComparator,
  ObjectiveDirection,
  ObjectiveMetricScale
} from "./objectiveMetric.js";

export const EFFECT_CRITERION_BASIS = "delta_vs_reference" as const;
export const CANDIDATE_METRIC_SCALES = [
  "raw",
  "proportion",
  "percent",
  "percentage_point"
] as const satisfies readonly ObjectiveMetricScale[];
export const EFFECT_CRITERION_SCALES = [
  "raw",
  "proportion",
  "percent",
  "percentage_point"
] as const satisfies readonly ObjectiveMetricScale[];

export type CandidateMetricScale = (typeof CANDIDATE_METRIC_SCALES)[number];
export type EffectCriterionScale = (typeof EFFECT_CRITERION_SCALES)[number];

export interface EffectCriterion {
  basis: typeof EFFECT_CRITERION_BASIS;
  magnitude: number;
  scale: EffectCriterionScale;
  inclusive: boolean;
}

export interface EffectCriterionValidation {
  valid: boolean;
  reasons: string[];
}

export interface CandidateObjectiveContract {
  primary_metric: string;
  metric_unit: string;
  metric_scale: CandidateMetricScale;
  metric_direction: ObjectiveDirection;
  comparator: string;
  effect_criterion: EffectCriterion;
}

export interface CandidateObjectiveProfileBinding extends CandidateObjectiveContract {
  candidate_id: string;
  objective_raw: string;
}

const EFFECT_CRITERION_FIELDS = new Set([
  "basis",
  "magnitude",
  "scale",
  "inclusive"
]);

const CANDIDATE_OBJECTIVE_PROFILE_BINDING_FIELDS = new Set([
  "candidate_id",
  "objective_raw",
  "primary_metric",
  "metric_unit",
  "metric_scale",
  "metric_direction",
  "comparator",
  "effect_criterion"
]);

export function validateEffectCriterion(value: unknown): EffectCriterionValidation {
  if (value === undefined || value === null) {
    return { valid: false, reasons: ["effect_criterion_missing"] };
  }
  if (!isRecord(value)) {
    return { valid: false, reasons: ["effect_criterion_not_object"] };
  }

  const reasons: string[] = [];
  for (const field of Object.keys(value)) {
    if (!EFFECT_CRITERION_FIELDS.has(field)) {
      reasons.push(`effect_criterion_unknown_field:${field}`);
    }
  }
  if (value.basis !== EFFECT_CRITERION_BASIS) {
    reasons.push("effect_criterion_basis_unsupported");
  }
  if (typeof value.magnitude !== "number") {
    reasons.push("effect_criterion_magnitude_not_numeric");
  } else if (!Number.isFinite(value.magnitude)) {
    reasons.push("effect_criterion_magnitude_non_finite");
  } else if (value.magnitude < 0) {
    reasons.push("effect_criterion_magnitude_negative");
  }
  if (!EFFECT_CRITERION_SCALES.includes(value.scale as EffectCriterionScale)) {
    reasons.push("effect_criterion_scale_unsupported");
  }
  if (typeof value.inclusive !== "boolean") {
    reasons.push("effect_criterion_inclusive_not_boolean");
  }

  return {
    valid: reasons.length === 0,
    reasons
  };
}

export function isEffectCriterion(value: unknown): value is EffectCriterion {
  return validateEffectCriterion(value).valid;
}

export function parseEffectCriterion(value: unknown): EffectCriterion | undefined {
  if (!isEffectCriterion(value)) {
    return undefined;
  }
  return {
    basis: value.basis,
    magnitude: value.magnitude,
    scale: value.scale,
    inclusive: value.inclusive
  };
}

export function requireEffectCriterion(
  value: unknown,
  errorCode = "effect_criterion_invalid"
): EffectCriterion {
  const criterion = parseEffectCriterion(value);
  if (!criterion) {
    throw new Error(errorCode);
  }
  return criterion;
}

export function effectCriterionValuesEqual(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) {
    return true;
  }
  const normalizedLeft = parseEffectCriterion(left);
  const normalizedRight = parseEffectCriterion(right);
  return Boolean(
    normalizedLeft
    && normalizedRight
    && normalizedLeft.basis === normalizedRight.basis
    && normalizedLeft.magnitude === normalizedRight.magnitude
    && normalizedLeft.scale === normalizedRight.scale
    && normalizedLeft.inclusive === normalizedRight.inclusive
  );
}

export function objectiveComparatorForEffectCriterion(
  direction: ObjectiveDirection,
  criterion: EffectCriterion
): Exclude<ObjectiveComparator, "=="> {
  if (direction === "maximize") {
    return criterion.inclusive ? ">=" : ">";
  }
  return criterion.inclusive ? "<=" : "<";
}

export function signedRawDeltaTargetForEffectCriterion(
  direction: ObjectiveDirection,
  criterion: EffectCriterion
): number {
  return direction === "maximize" ? criterion.magnitude : -criterion.magnitude;
}

export function candidateRawDeltaMetricKey(primaryMetric: string): string {
  return `${requireText(primaryMetric, "candidate_objective_primary_metric_missing")}_delta_vs_baseline`;
}

export function rawDeltaMeetsEffectCriterion(
  rawDeltaInEffectScale: number,
  direction: ObjectiveDirection,
  criterion: EffectCriterion
): boolean {
  if (!Number.isFinite(rawDeltaInEffectScale)) {
    return false;
  }
  const target = signedRawDeltaTargetForEffectCriterion(direction, criterion);
  const comparator = objectiveComparatorForEffectCriterion(direction, criterion);
  if (comparator === ">=") return rawDeltaInEffectScale >= target;
  if (comparator === ">") return rawDeltaInEffectScale > target;
  if (comparator === "<=") return rawDeltaInEffectScale <= target;
  return rawDeltaInEffectScale < target;
}

export function isExplicitMetricUnit(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function requireExplicitMetricUnit(
  value: unknown,
  errorCode = "candidate_objective_metric_unit_missing"
): string {
  return requireText(value, errorCode);
}

export function isExplicitMetricScale(value: unknown): value is CandidateMetricScale {
  return CANDIDATE_METRIC_SCALES.includes(value as CandidateMetricScale);
}

export function areEffectScalesComparable(
  metricScale: CandidateMetricScale,
  effectScale: EffectCriterionScale
): boolean {
  if (metricScale === effectScale) {
    return true;
  }
  if (metricScale === "raw" || effectScale === "raw") {
    return false;
  }
  return true;
}

export function requireExplicitMetricScale(
  value: unknown,
  errorCode = "candidate_objective_metric_scale_invalid"
): CandidateMetricScale {
  if (!isExplicitMetricScale(value)) {
    throw new Error(errorCode);
  }
  return value;
}

export function buildCandidateObjectiveRaw(contract: CandidateObjectiveContract): string {
  const effectCriterion = requireEffectCriterion(
    contract.effect_criterion,
    "candidate_objective_effect_criterion_invalid"
  );
  const primaryMetric = requireText(contract.primary_metric, "candidate_objective_primary_metric_missing");
  const metricUnit = requireExplicitMetricUnit(contract.metric_unit);
  const metricScale = requireExplicitMetricScale(contract.metric_scale);
  const comparator = requireText(contract.comparator, "candidate_objective_comparator_missing");
  if (contract.metric_direction !== "maximize" && contract.metric_direction !== "minimize") {
    throw new Error("candidate_objective_metric_direction_invalid");
  }
  if (!areEffectScalesComparable(metricScale, effectCriterion.scale)) {
    throw new Error("candidate_objective_effect_scale_incompatible");
  }
  return JSON.stringify({
    primary_metric: primaryMetric,
    metric_unit: metricUnit,
    metric_scale: metricScale,
    metric_direction: contract.metric_direction,
    comparator,
    effect_criterion: effectCriterion
  });
}

export function buildCandidateObjectiveProfileBinding(input: {
  candidateId: string;
  primaryMetric: string;
  metricUnit: string;
  metricScale: CandidateMetricScale;
  metricDirection: ObjectiveDirection;
  comparator: string;
  effectCriterion: EffectCriterion;
  objectiveRaw?: string;
}): CandidateObjectiveProfileBinding {
  const candidateId = requireText(input.candidateId, "candidate_objective_candidate_id_missing");
  const contract: CandidateObjectiveContract = {
    primary_metric: requireText(
      input.primaryMetric,
      "candidate_objective_primary_metric_missing"
    ),
    metric_unit: requireExplicitMetricUnit(input.metricUnit),
    metric_scale: requireExplicitMetricScale(input.metricScale),
    metric_direction: input.metricDirection,
    comparator: requireText(input.comparator, "candidate_objective_comparator_missing"),
    effect_criterion: requireEffectCriterion(
      input.effectCriterion,
      "candidate_objective_effect_criterion_invalid"
    )
  };
  const expectedRaw = buildCandidateObjectiveRaw(contract);
  if (input.objectiveRaw !== undefined && input.objectiveRaw !== expectedRaw) {
    throw new Error("candidate_objective_raw_mismatch");
  }
  return {
    candidate_id: candidateId,
    objective_raw: expectedRaw,
    ...contract
  };
}

export function isCandidateObjectiveProfileBinding(
  value: unknown
): value is CandidateObjectiveProfileBinding {
  if (
    !isRecord(value)
    || !hasOnlyKnownFields(value, CANDIDATE_OBJECTIVE_PROFILE_BINDING_FIELDS)
    || !hasText(value.candidate_id)
    || !hasText(value.objective_raw)
    || !hasText(value.primary_metric)
    || !isExplicitMetricUnit(value.metric_unit)
    || !isExplicitMetricScale(value.metric_scale)
    || !hasText(value.comparator)
    || (value.metric_direction !== "maximize" && value.metric_direction !== "minimize")
    || !isEffectCriterion(value.effect_criterion)
    || !areEffectScalesComparable(value.metric_scale, value.effect_criterion.scale)
  ) {
    return false;
  }
  return value.objective_raw === buildCandidateObjectiveRaw({
    primary_metric: value.primary_metric,
    metric_unit: value.metric_unit,
    metric_scale: value.metric_scale,
    metric_direction: value.metric_direction,
    comparator: value.comparator,
    effect_criterion: value.effect_criterion
  });
}

export function readCandidateObjectiveProfileBinding(
  profile: unknown
): CandidateObjectiveProfileBinding | undefined {
  if (!isRecord(profile)) {
    return undefined;
  }
  const binding = profile.candidate_contract;
  return isCandidateObjectiveProfileBinding(binding) ? binding : undefined;
}

function requireText(value: unknown, errorCode: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(errorCode);
  }
  return normalized;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKnownFields(value: object, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}
