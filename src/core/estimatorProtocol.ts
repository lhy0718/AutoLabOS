import {
  buildEstimatorFeasibilityContract,
  type EstimatorDesignAssignment,
  type EstimatorDesignCell,
  type EstimatorFeasibilityBindings,
  type EstimatorFeasibilityContract,
  type EstimatorFeasibilityEstimator,
  type EstimatorFeasibilityEstimand,
  type EstimatorFeasibilityMultiplicity,
  type EstimatorFeasibilityOutcome,
  type EstimatorFeasibilityPower
} from "./estimatorFeasibility.js";

export const ESTIMATOR_PROTOCOL_SCHEMA_VERSION = 1 as const;

export interface EstimatorProtocolDeclaration {
  schema_version: typeof ESTIMATOR_PROTOCOL_SCHEMA_VERSION;
  units: {
    execution_unit: string;
    exposure_unit: string;
    outcome_unit: string;
    analysis_unit: string;
    independent_cluster_key: string;
  };
  arms: string[];
  primary_contrast: [string, string];
  pairing: {
    mode: "paired" | "unpaired";
    independent_clusters: number;
    observations_per_arm_per_cluster: number;
  };
  outcome: {
    type: EstimatorFeasibilityOutcome["type"];
    attainable_resolution: number;
  };
  estimand: Omit<EstimatorFeasibilityEstimand, "contrast">;
  estimator: EstimatorFeasibilityEstimator;
  power: EstimatorFeasibilityPower;
  resampling: {
    minimum_clusters: number;
    replicates: number;
  };
  multiplicity: EstimatorFeasibilityMultiplicity;
  event_counts?: Array<{
    arm_id: string;
    events: number;
    non_events: number;
  }>;
}

export interface EstimatorProtocolValidation {
  valid: boolean;
  reasons: string[];
  protocol?: EstimatorProtocolDeclaration;
}

const ROOT_FIELDS = new Set([
  "schema_version",
  "units",
  "arms",
  "primary_contrast",
  "pairing",
  "outcome",
  "estimand",
  "estimator",
  "power",
  "resampling",
  "multiplicity",
  "event_counts"
]);
const UNIT_FIELDS = new Set([
  "execution_unit",
  "exposure_unit",
  "outcome_unit",
  "analysis_unit",
  "independent_cluster_key"
]);
const PAIRING_FIELDS = new Set([
  "mode",
  "independent_clusters",
  "observations_per_arm_per_cluster"
]);
const OUTCOME_FIELDS = new Set(["type", "attainable_resolution"]);
const ESTIMAND_FIELDS = new Set(["id", "type", "scale"]);
const ESTIMATOR_FIELDS = new Set([
  "family",
  "covariance",
  "separation_policy"
]);
const POWER_FIELDS = new Set([
  "alpha",
  "target_power",
  "minimum_detectable_effect",
  "assumed_standard_deviation",
  "sidedness"
]);
const RESAMPLING_FIELDS = new Set(["minimum_clusters", "replicates"]);
const MULTIPLICITY_FIELDS = new Set([
  "primary_comparison_id",
  "family",
  "method",
  "family_alpha"
]);
const EVENT_COUNT_FIELDS = new Set(["arm_id", "events", "non_events"]);
const OUTCOME_TYPES = new Set(["binary", "continuous", "count"]);
const ESTIMAND_TYPES = new Set([
  "paired_risk_difference",
  "risk_difference",
  "paired_mean_difference",
  "mean_difference",
  "odds_ratio",
  "rate_ratio"
]);
const ESTIMAND_SCALES = new Set(["proportion", "mean", "odds_ratio", "rate_ratio"]);
const ESTIMATOR_FAMILIES = new Set([
  "paired_risk_difference",
  "risk_difference",
  "paired_mean_difference",
  "linear_model",
  "logistic_regression",
  "penalized_logistic_regression",
  "poisson_regression"
]);
const COVARIANCE_TYPES = new Set([
  "cluster_bootstrap",
  "cluster_robust",
  "heteroskedasticity_robust",
  "exact_paired"
]);
const SEPARATION_POLICIES = new Set([
  "not_applicable",
  "block_on_separation",
  "penalized"
]);
const MULTIPLICITY_METHODS = new Set([
  "none",
  "holm",
  "bonferroni",
  "benjamini_hochberg"
]);
const MAX_ARMS = 16;
const MAX_ASSIGNMENTS = 100_000;

export function normalizeEstimatorProtocolDeclaration(
  value: unknown
): EstimatorProtocolValidation {
  const reasons: string[] = [];
  const root = recordValue(value);
  if (!root || !hasExactFields(root, ROOT_FIELDS)) {
    return { valid: false, reasons: ["estimator_protocol_schema_invalid"] };
  }
  const units = recordValue(root.units);
  const pairing = recordValue(root.pairing);
  const outcome = recordValue(root.outcome);
  const estimand = recordValue(root.estimand);
  const estimator = recordValue(root.estimator);
  const power = recordValue(root.power);
  const resampling = recordValue(root.resampling);
  const multiplicity = recordValue(root.multiplicity);
  if (
    root.schema_version !== ESTIMATOR_PROTOCOL_SCHEMA_VERSION
    || !units || !hasExactFields(units, UNIT_FIELDS)
    || !pairing || !hasExactFields(pairing, PAIRING_FIELDS)
    || !outcome || !hasExactFields(outcome, OUTCOME_FIELDS)
    || !estimand || !hasExactFields(estimand, ESTIMAND_FIELDS)
    || !estimator || !hasExactFields(estimator, ESTIMATOR_FIELDS)
    || !power || !hasExactFields(power, POWER_FIELDS)
    || !resampling || !hasExactFields(resampling, RESAMPLING_FIELDS)
    || !multiplicity || !hasExactFields(multiplicity, MULTIPLICITY_FIELDS)
  ) {
    return { valid: false, reasons: ["estimator_protocol_schema_invalid"] };
  }
  const arms = stringArray(root.arms);
  const contrast = stringArray(root.primary_contrast);
  const unitValues = {
    execution_unit: textValue(units.execution_unit),
    exposure_unit: textValue(units.exposure_unit),
    outcome_unit: textValue(units.outcome_unit),
    analysis_unit: textValue(units.analysis_unit),
    independent_cluster_key: textValue(units.independent_cluster_key)
  };
  if (Object.values(unitValues).some((item) => !item)) {
    reasons.push("estimator_protocol_units_invalid");
  }
  if (
    !arms || arms.length < 2 || arms.length > MAX_ARMS
    || new Set(arms).size !== arms.length
  ) {
    reasons.push("estimator_protocol_arms_invalid");
  }
  if (
    !contrast || contrast.length !== 2 || contrast[0] === contrast[1]
    || !arms || contrast.some((arm) => !arms.includes(arm))
  ) {
    reasons.push("estimator_protocol_contrast_invalid");
  }
  const pairingMode = pairing.mode;
  const independentClusters = positiveInteger(pairing.independent_clusters);
  const observationsPerArm = positiveInteger(
    pairing.observations_per_arm_per_cluster
  );
  if (
    (pairingMode !== "paired" && pairingMode !== "unpaired")
    || !independentClusters || !observationsPerArm
    || !arms
    || independentClusters * observationsPerArm * arms.length > MAX_ASSIGNMENTS
  ) {
    reasons.push("estimator_protocol_pairing_invalid");
  }
  if (observationsPerArm !== undefined && observationsPerArm !== 1) {
    reasons.push(
      "estimator_protocol_clustered_repetition_requires_design_effect"
    );
  }
  const outcomeType = textValue(outcome.type);
  const attainableResolution = positiveNumber(outcome.attainable_resolution);
  if (!outcomeType || !OUTCOME_TYPES.has(outcomeType) || !attainableResolution) {
    reasons.push("estimator_protocol_outcome_invalid");
  }
  const estimandId = textValue(estimand.id);
  const estimandType = textValue(estimand.type);
  const estimandScale = textValue(estimand.scale);
  if (
    !estimandId || !estimandType || !ESTIMAND_TYPES.has(estimandType)
    || !estimandScale || !ESTIMAND_SCALES.has(estimandScale)
  ) {
    reasons.push("estimator_protocol_estimand_invalid");
  }
  const estimatorFamily = textValue(estimator.family);
  const covariance = textValue(estimator.covariance);
  const separationPolicy = textValue(estimator.separation_policy);
  if (
    !estimatorFamily || !ESTIMATOR_FAMILIES.has(estimatorFamily)
    || !covariance || !COVARIANCE_TYPES.has(covariance)
    || !separationPolicy || !SEPARATION_POLICIES.has(separationPolicy)
  ) {
    reasons.push("estimator_protocol_estimator_invalid");
  }
  const normalizedPower = {
    alpha: probability(power.alpha),
    target_power: probability(power.target_power),
    minimum_detectable_effect: positiveNumber(power.minimum_detectable_effect),
    assumed_standard_deviation: positiveNumber(power.assumed_standard_deviation),
    sidedness: power.sidedness
  };
  if (
    Object.values(normalizedPower).some((item) => item === undefined)
    || (normalizedPower.target_power !== undefined
      && normalizedPower.target_power <= 0.5)
    || (normalizedPower.sidedness !== "one_sided"
      && normalizedPower.sidedness !== "two_sided")
  ) {
    reasons.push("estimator_protocol_power_invalid");
  }
  const minimumClusters = positiveInteger(resampling.minimum_clusters);
  const replicates = positiveInteger(resampling.replicates);
  if (!minimumClusters || !replicates) {
    reasons.push("estimator_protocol_resampling_invalid");
  }
  const primaryComparisonId = textValue(multiplicity.primary_comparison_id);
  const family = stringArray(multiplicity.family);
  const multiplicityMethod = textValue(multiplicity.method);
  const familyAlpha = probability(multiplicity.family_alpha);
  if (
    !primaryComparisonId || !family || !family.includes(primaryComparisonId)
    || !multiplicityMethod || !MULTIPLICITY_METHODS.has(multiplicityMethod)
    || !familyAlpha
  ) {
    reasons.push("estimator_protocol_multiplicity_invalid");
  }
  const eventCounts = normalizeEventCounts(root.event_counts, arms, reasons);
  const plannedPerArm = independentClusters && observationsPerArm
    ? independentClusters * observationsPerArm
    : undefined;
  if (
    eventCounts
    && plannedPerArm
    && eventCounts.some(
      (item) => item.events + item.non_events !== plannedPerArm
    )
  ) {
    reasons.push("estimator_protocol_event_count_total_mismatch");
  }
  if (reasons.length > 0) {
    return { valid: false, reasons: uniqueSorted(reasons) };
  }
  const protocol: EstimatorProtocolDeclaration = {
    schema_version: ESTIMATOR_PROTOCOL_SCHEMA_VERSION,
    units: unitValues as EstimatorProtocolDeclaration["units"],
    arms: arms!,
    primary_contrast: contrast as [string, string],
    pairing: {
      mode: pairingMode as "paired" | "unpaired",
      independent_clusters: independentClusters!,
      observations_per_arm_per_cluster: observationsPerArm!
    },
    outcome: {
      type: outcomeType as EstimatorFeasibilityOutcome["type"],
      attainable_resolution: attainableResolution!
    },
    estimand: {
      id: estimandId!,
      type: estimandType as EstimatorFeasibilityEstimand["type"],
      scale: estimandScale as EstimatorFeasibilityEstimand["scale"]
    },
    estimator: {
      family: estimatorFamily as EstimatorFeasibilityEstimator["family"],
      covariance: covariance as EstimatorFeasibilityEstimator["covariance"],
      separation_policy:
        separationPolicy as EstimatorFeasibilityEstimator["separation_policy"]
    },
    power: normalizedPower as EstimatorFeasibilityPower,
    resampling: {
      minimum_clusters: minimumClusters!,
      replicates: replicates!
    },
    multiplicity: {
      primary_comparison_id: primaryComparisonId!,
      family: family!,
      method: multiplicityMethod as EstimatorFeasibilityMultiplicity["method"],
      family_alpha: familyAlpha!
    },
    ...(eventCounts ? { event_counts: eventCounts } : {})
  };
  return { valid: true, reasons: [], protocol };
}

export function buildEstimatorFeasibilityContractFromProtocol(input: {
  protocol: unknown;
  bindings: EstimatorFeasibilityBindings;
}): EstimatorFeasibilityContract {
  const validation = normalizeEstimatorProtocolDeclaration(input.protocol);
  if (!validation.valid || !validation.protocol) {
    throw new Error(
      `estimator_protocol_invalid:${validation.reasons.join(",")}`
    );
  }
  const protocol = validation.protocol;
  const denominator =
    protocol.pairing.independent_clusters
    * protocol.pairing.observations_per_arm_per_cluster;
  const assignments = buildAssignments(protocol);
  const eventCounts = new Map(
    (protocol.event_counts || []).map((item) => [item.arm_id, item] as const)
  );
  const cells: EstimatorDesignCell[] = protocol.arms.map((arm, index) => ({
    cell_id: `cell_${String(index + 1).padStart(2, "0")}`,
    arm_id: arm,
    n: denominator,
    x: [1, ...protocol.arms.slice(1).map((_, dummyIndex) =>
      index === dummyIndex + 1 ? 1 : 0
    )],
    events: eventCounts.get(arm)?.events ?? null,
    non_events: eventCounts.get(arm)?.non_events ?? null
  }));
  return buildEstimatorFeasibilityContract({
    bindings: input.bindings,
    units: {
      ...protocol.units,
      arm_isolation: "one_arm_per_execution_unit",
      pairing: {
        mode: protocol.pairing.mode,
        pair_key: protocol.pairing.mode === "paired"
          ? protocol.units.independent_cluster_key
          : null,
        required_arms: [...protocol.arms],
        expected_complete_pairs:
          protocol.pairing.mode === "paired" ? denominator : null
      }
    },
    outcome: {
      type: protocol.outcome.type,
      planned_denominator: denominator,
      attainable_resolution: protocol.outcome.attainable_resolution
    },
    estimand: {
      ...protocol.estimand,
      contrast: [...protocol.primary_contrast]
    },
    estimator: protocol.estimator,
    design_matrix: {
      columns: [
        "intercept",
        ...protocol.arms.slice(1).map((_, index) => `arm_${index + 2}`)
      ],
      cells,
      assignments
    },
    power: protocol.power,
    resampling: {
      cluster_key: protocol.units.independent_cluster_key,
      planned_clusters: protocol.pairing.independent_clusters,
      minimum_clusters: protocol.resampling.minimum_clusters,
      replicates: protocol.resampling.replicates
    },
    multiplicity: protocol.multiplicity
  });
}

function buildAssignments(
  protocol: EstimatorProtocolDeclaration
): EstimatorDesignAssignment[] {
  const assignments: EstimatorDesignAssignment[] = [];
  for (
    let clusterIndex = 0;
    clusterIndex < protocol.pairing.independent_clusters;
    clusterIndex += 1
  ) {
    const clusterId = `cluster_${String(clusterIndex + 1).padStart(5, "0")}`;
    for (
      let observationIndex = 0;
      observationIndex < protocol.pairing.observations_per_arm_per_cluster;
      observationIndex += 1
    ) {
      const observationId =
        `${clusterId}_observation_${String(observationIndex + 1).padStart(4, "0")}`;
      protocol.arms.forEach((arm, armIndex) => {
        const assignmentId = `${observationId}_arm_${String(armIndex + 1).padStart(2, "0")}`;
        assignments.push({
          assignment_id: assignmentId,
          execution_unit_id: assignmentId,
          exposure_unit_id: arm,
          outcome_unit_id: assignmentId,
          analysis_unit_id:
            protocol.pairing.mode === "paired" ? observationId : assignmentId,
          independent_cluster_id: clusterId,
          arm_id: arm,
          cell_id: `cell_${String(armIndex + 1).padStart(2, "0")}`,
          pair_id: protocol.pairing.mode === "paired" ? observationId : null
        });
      });
    }
  }
  return assignments;
}

function normalizeEventCounts(
  value: unknown,
  arms: string[] | undefined,
  reasons: string[]
): EstimatorProtocolDeclaration["event_counts"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !arms) {
    reasons.push("estimator_protocol_event_counts_invalid");
    return undefined;
  }
  const normalized = value.flatMap((item) => {
    const record = recordValue(item);
    if (!record || !hasExactFields(record, EVENT_COUNT_FIELDS)) return [];
    const armId = textValue(record.arm_id);
    const events = nonNegativeInteger(record.events);
    const nonEvents = nonNegativeInteger(record.non_events);
    return armId && events !== undefined && nonEvents !== undefined
      ? [{ arm_id: armId, events, non_events: nonEvents }]
      : [];
  });
  if (
    normalized.length !== value.length
    || normalized.length !== arms.length
    || new Set(normalized.map((item) => item.arm_id)).size !== arms.length
    || normalized.some((item) => !arms.includes(item.arm_id))
  ) {
    reasons.push("estimator_protocol_event_counts_invalid");
    return undefined;
  }
  return normalized.sort((left, right) =>
    arms.indexOf(left.arm_id) - arms.indexOf(right.arm_id)
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>
): boolean {
  return Object.keys(value).every((field) => fields.has(field))
    && [...fields].every((field) =>
      field === "event_counts" || Object.prototype.hasOwnProperty.call(value, field)
    );
}

function textValue(value: unknown): string | undefined {
  const normalized = typeof value === "string"
    ? value.replace(/\s+/gu, " ").trim()
    : "";
  return normalized && normalized.length <= 160 ? normalized : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const normalized = value.map(textValue);
  if (
    normalized.some((item) => !item)
    || new Set(normalized).size !== normalized.length
  ) return undefined;
  return normalized as string[];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function probability(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    && value > 0 && value < 1
    ? value
    : undefined;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}
