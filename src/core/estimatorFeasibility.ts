import { hashCanonical } from "./canonicalHash.js";

export const ESTIMATOR_FEASIBILITY_SCHEMA_VERSION = 1 as const;

export const ESTIMATOR_FEASIBILITY_REASON_CODES = [
  "contract_hash_mismatch",
  "run_binding_mismatch",
  "probe_binding_mismatch",
  "experiment_binding_mismatch",
  "cell_n_mismatch",
  "arm_isolation_violation",
  "incomplete_pair",
  "pair_count_mismatch",
  "unexpected_pair_id",
  "contrast_arm_missing",
  "denominator_mismatch",
  "resolution_mismatch",
  "resolution_exceeds_mde",
  "rank_deficient",
  "outcome_estimand_mismatch",
  "estimator_estimand_mismatch",
  "covariance_pairing_mismatch",
  "cluster_key_mismatch",
  "cluster_count_mismatch",
  "cluster_pseudoreplication_unsupported",
  "too_few_clusters",
  "too_few_resamples",
  "pair_unit_mismatch",
  "unpaired_unit_overlap",
  "unsupported_estimand_power_model",
  "multiplicity_power_unsupported",
  "primary_contrast_not_estimable",
  "unsafe_separation_policy",
  "event_counts_missing",
  "separation_detected",
  "multiplicity_primary_mismatch",
  "multiplicity_family_mismatch",
  "multiplicity_method_mismatch",
  "multiplicity_alpha_mismatch",
  "power_assumption_invalid",
  "power_target_unattainable"
] as const;

export type EstimatorFeasibilityReasonCode =
  (typeof ESTIMATOR_FEASIBILITY_REASON_CODES)[number];

export type EstimatorFeasibilityValidationReason =
  | "schema_invalid"
  | "report_schema_invalid"
  | "report_hash_mismatch"
  | "report_recomputed_mismatch"
  | EstimatorFeasibilityReasonCode;

export interface EstimatorFeasibilityBindings {
  run_id: string;
  active_probe_sha256: string;
  experiment_contract_sha256: string;
}

export interface EstimatorPairing {
  mode: "paired" | "unpaired";
  pair_key: string | null;
  required_arms: string[];
  expected_complete_pairs: number | null;
}

export interface EstimatorFeasibilityUnits {
  execution_unit: string;
  exposure_unit: string;
  outcome_unit: string;
  analysis_unit: string;
  independent_cluster_key: string;
  arm_isolation: "one_arm_per_execution_unit";
  pairing: EstimatorPairing;
}

export interface EstimatorFeasibilityOutcome {
  type: "binary" | "continuous" | "count";
  planned_denominator: number;
  attainable_resolution: number;
}

export interface EstimatorFeasibilityEstimand {
  id: string;
  type:
    | "paired_risk_difference"
    | "risk_difference"
    | "paired_mean_difference"
    | "mean_difference"
    | "odds_ratio"
    | "rate_ratio";
  contrast: [string, string];
  scale: "proportion" | "mean" | "odds_ratio" | "rate_ratio";
}

export interface EstimatorFeasibilityEstimator {
  family:
    | "paired_risk_difference"
    | "risk_difference"
    | "paired_mean_difference"
    | "linear_model"
    | "logistic_regression"
    | "penalized_logistic_regression"
    | "poisson_regression";
  covariance:
    | "cluster_bootstrap"
    | "cluster_robust"
    | "heteroskedasticity_robust"
    | "exact_paired";
  separation_policy:
    | "not_applicable"
    | "block_on_separation"
    | "penalized";
}

export interface EstimatorDesignCell {
  cell_id: string;
  arm_id: string;
  n: number;
  x: number[];
  events: number | null;
  non_events: number | null;
}

export interface EstimatorDesignAssignment {
  assignment_id: string;
  execution_unit_id: string;
  exposure_unit_id: string;
  outcome_unit_id: string;
  analysis_unit_id: string;
  independent_cluster_id: string;
  arm_id: string;
  cell_id: string;
  pair_id: string | null;
}

export interface EstimatorDesignMatrix {
  columns: string[];
  cells: EstimatorDesignCell[];
  assignments: EstimatorDesignAssignment[];
}

export interface EstimatorFeasibilityPower {
  alpha: number;
  target_power: number;
  minimum_detectable_effect: number;
  assumed_standard_deviation: number;
  sidedness: "one_sided" | "two_sided";
}

export interface EstimatorFeasibilityResampling {
  cluster_key: string;
  planned_clusters: number;
  minimum_clusters: number;
  replicates: number;
}

export interface EstimatorFeasibilityMultiplicity {
  primary_comparison_id: string;
  family: string[];
  method: "none" | "holm" | "bonferroni" | "benjamini_hochberg";
  family_alpha: number;
}

export interface EstimatorFeasibilityContract {
  schema_version: typeof ESTIMATOR_FEASIBILITY_SCHEMA_VERSION;
  artifact_kind: "estimator_feasibility_contract";
  bindings: EstimatorFeasibilityBindings;
  units: EstimatorFeasibilityUnits;
  outcome: EstimatorFeasibilityOutcome;
  estimand: EstimatorFeasibilityEstimand;
  estimator: EstimatorFeasibilityEstimator;
  design_matrix: EstimatorDesignMatrix;
  power: EstimatorFeasibilityPower;
  resampling: EstimatorFeasibilityResampling;
  multiplicity: EstimatorFeasibilityMultiplicity;
  content_sha256: string;
}

export type EstimatorFeasibilityContractInput = Omit<
  EstimatorFeasibilityContract,
  "schema_version" | "artifact_kind" | "content_sha256"
>;

export interface EstimatorFeasibilityMetrics {
  assignment_count: number;
  execution_unit_count: number;
  analysis_unit_count: number;
  independent_cluster_count: number;
  complete_pair_count: number;
  design_matrix_rank: number;
  design_matrix_column_count: number;
  primary_denominator: number;
  computed_resolution: number | null;
  computed_minimum_detectable_effect: number | null;
  event_count: number | null;
  non_event_count: number | null;
}

export interface EstimatorFeasibilityReport {
  schema_version: typeof ESTIMATOR_FEASIBILITY_SCHEMA_VERSION;
  artifact_kind: "estimator_feasibility_report";
  bindings: EstimatorFeasibilityBindings;
  contract_declared_sha256: string;
  contract_recomputed_sha256: string;
  status: "pass" | "blocked";
  reason_codes: EstimatorFeasibilityReasonCode[];
  metrics: EstimatorFeasibilityMetrics;
  content_sha256: string;
}

export interface EstimatorFeasibilityBindingContext {
  expectedRunId?: string;
  expectedActiveProbeSha256?: string;
  expectedExperimentContractSha256?: string;
}

export interface EstimatorFeasibilityContractValidation {
  valid: boolean;
  reasons: EstimatorFeasibilityValidationReason[];
  contract?: EstimatorFeasibilityContract;
}

export interface EstimatorFeasibilityReportValidation {
  valid: boolean;
  reasons: EstimatorFeasibilityValidationReason[];
  report?: EstimatorFeasibilityReport;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_ARMS = 16;
const MAX_COLUMNS = 64;
const MAX_CELLS = 512;
const MAX_ASSIGNMENTS = 100_000;
const MAX_COMPARISONS = 128;
const MIN_INDEPENDENT_CLUSTERS = 30;
const MIN_RESAMPLING_REPLICATES = 1_000;
const MATRIX_TOLERANCE = 1e-10;
const NUMERIC_TOLERANCE = 1e-9;

const CONTRACT_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "bindings",
  "units",
  "outcome",
  "estimand",
  "estimator",
  "design_matrix",
  "power",
  "resampling",
  "multiplicity",
  "content_sha256"
]);
const CONTRACT_INPUT_FIELDS = new Set([
  "bindings",
  "units",
  "outcome",
  "estimand",
  "estimator",
  "design_matrix",
  "power",
  "resampling",
  "multiplicity"
]);
const BINDING_FIELDS = new Set([
  "run_id",
  "active_probe_sha256",
  "experiment_contract_sha256"
]);
const UNIT_FIELDS = new Set([
  "execution_unit",
  "exposure_unit",
  "outcome_unit",
  "analysis_unit",
  "independent_cluster_key",
  "arm_isolation",
  "pairing"
]);
const PAIRING_FIELDS = new Set([
  "mode",
  "pair_key",
  "required_arms",
  "expected_complete_pairs"
]);
const OUTCOME_FIELDS = new Set([
  "type",
  "planned_denominator",
  "attainable_resolution"
]);
const ESTIMAND_FIELDS = new Set(["id", "type", "contrast", "scale"]);
const ESTIMATOR_FIELDS = new Set([
  "family",
  "covariance",
  "separation_policy"
]);
const DESIGN_MATRIX_FIELDS = new Set(["columns", "cells", "assignments"]);
const CELL_FIELDS = new Set([
  "cell_id",
  "arm_id",
  "n",
  "x",
  "events",
  "non_events"
]);
const ASSIGNMENT_FIELDS = new Set([
  "assignment_id",
  "execution_unit_id",
  "exposure_unit_id",
  "outcome_unit_id",
  "analysis_unit_id",
  "independent_cluster_id",
  "arm_id",
  "cell_id",
  "pair_id"
]);
const POWER_FIELDS = new Set([
  "alpha",
  "target_power",
  "minimum_detectable_effect",
  "assumed_standard_deviation",
  "sidedness"
]);
const RESAMPLING_FIELDS = new Set([
  "cluster_key",
  "planned_clusters",
  "minimum_clusters",
  "replicates"
]);
const MULTIPLICITY_FIELDS = new Set([
  "primary_comparison_id",
  "family",
  "method",
  "family_alpha"
]);
const REPORT_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "bindings",
  "contract_declared_sha256",
  "contract_recomputed_sha256",
  "status",
  "reason_codes",
  "metrics",
  "content_sha256"
]);
const METRIC_FIELDS = new Set([
  "assignment_count",
  "execution_unit_count",
  "analysis_unit_count",
  "independent_cluster_count",
  "complete_pair_count",
  "design_matrix_rank",
  "design_matrix_column_count",
  "primary_denominator",
  "computed_resolution",
  "computed_minimum_detectable_effect",
  "event_count",
  "non_event_count"
]);

const ESTIMAND_TYPES = new Set<EstimatorFeasibilityEstimand["type"]>([
  "paired_risk_difference",
  "risk_difference",
  "paired_mean_difference",
  "mean_difference",
  "odds_ratio",
  "rate_ratio"
]);
const ESTIMAND_SCALES = new Set<EstimatorFeasibilityEstimand["scale"]>([
  "proportion",
  "mean",
  "odds_ratio",
  "rate_ratio"
]);
const ESTIMATOR_FAMILIES = new Set<EstimatorFeasibilityEstimator["family"]>([
  "paired_risk_difference",
  "risk_difference",
  "paired_mean_difference",
  "linear_model",
  "logistic_regression",
  "penalized_logistic_regression",
  "poisson_regression"
]);
const COVARIANCE_TYPES = new Set<EstimatorFeasibilityEstimator["covariance"]>([
  "cluster_bootstrap",
  "cluster_robust",
  "heteroskedasticity_robust",
  "exact_paired"
]);
const SEPARATION_POLICIES = new Set<
  EstimatorFeasibilityEstimator["separation_policy"]
>([
  "not_applicable",
  "block_on_separation",
  "penalized"
]);
const MULTIPLICITY_METHODS = new Set<
  EstimatorFeasibilityMultiplicity["method"]
>([
  "none",
  "holm",
  "bonferroni",
  "benjamini_hochberg"
]);
const REASON_CODE_SET = new Set<string>(ESTIMATOR_FEASIBILITY_REASON_CODES);

export function buildEstimatorFeasibilityContract(
  input: EstimatorFeasibilityContractInput
): EstimatorFeasibilityContract {
  const normalized = normalizeContractInput(input);
  const payload: Omit<EstimatorFeasibilityContract, "content_sha256"> = {
    schema_version: ESTIMATOR_FEASIBILITY_SCHEMA_VERSION,
    artifact_kind: "estimator_feasibility_contract",
    ...normalized
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function validateEstimatorFeasibilityContract(
  value: unknown,
  context: EstimatorFeasibilityBindingContext = {}
): EstimatorFeasibilityContractValidation {
  if (!isEstimatorFeasibilityContract(value)) {
    return { valid: false, reasons: ["schema_invalid"] };
  }

  const reasons = validateContractIntegrity(value, context);
  return {
    valid: reasons.length === 0,
    reasons,
    contract: value
  };
}

export function evaluateEstimatorFeasibility(
  value: unknown,
  context: EstimatorFeasibilityBindingContext = {}
): EstimatorFeasibilityReport {
  if (!isEstimatorFeasibilityContract(value)) {
    throw new Error("estimator_feasibility_contract_schema_invalid");
  }

  const contractPayload = withoutContentHash(value);
  const analysis = analyzeFeasibility(value);
  const reasonCodes = uniqueSorted([
    ...validateContractIntegrity(value, context),
    ...analysis.reasonCodes
  ]);
  const payload: Omit<EstimatorFeasibilityReport, "content_sha256"> = {
    schema_version: ESTIMATOR_FEASIBILITY_SCHEMA_VERSION,
    artifact_kind: "estimator_feasibility_report",
    bindings: { ...value.bindings },
    contract_declared_sha256: value.content_sha256,
    contract_recomputed_sha256: hashCanonical(contractPayload),
    status: reasonCodes.length === 0 ? "pass" : "blocked",
    reason_codes: reasonCodes,
    metrics: analysis.metrics
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function validateEstimatorFeasibilityReport(
  value: unknown,
  contract: unknown,
  context: EstimatorFeasibilityBindingContext = {}
): EstimatorFeasibilityReportValidation {
  if (!isEstimatorFeasibilityReport(value)) {
    return { valid: false, reasons: ["report_schema_invalid"] };
  }

  const reasons: EstimatorFeasibilityValidationReason[] = [];
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("report_hash_mismatch");
  }
  try {
    const expected = evaluateEstimatorFeasibility(contract, context);
    if (hashCanonical(value) !== hashCanonical(expected)) {
      reasons.push("report_recomputed_mismatch");
    }
  } catch {
    reasons.push("schema_invalid");
  }
  return {
    valid: reasons.length === 0,
    reasons: uniqueSorted(reasons),
    report: value
  };
}

export function matrixRank(
  rows: ReadonlyArray<ReadonlyArray<number>>,
  tolerance = MATRIX_TOLERANCE
): number {
  if (
    !Array.isArray(rows)
    || rows.length === 0
    || !Number.isFinite(tolerance)
    || tolerance <= 0
  ) {
    return 0;
  }
  const width = rows[0]?.length ?? 0;
  if (
    width === 0
    || rows.some(
      (row) =>
        row.length !== width
        || row.some((value: number) => !Number.isFinite(value))
    )
  ) {
    return 0;
  }

  const scale = Math.max(
    ...rows.flatMap((row) => row.map((value: number) => Math.abs(value)))
  );
  if (!Number.isFinite(scale) || scale === 0) return 0;
  const effectiveTolerance = tolerance * scale;

  const matrix = rows.map((row) => [...row]);
  let rank = 0;
  for (let column = 0; column < width && rank < matrix.length; column += 1) {
    let pivot = rank;
    for (let row = rank + 1; row < matrix.length; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(matrix[pivot][column]) <= effectiveTolerance) {
      continue;
    }
    [matrix[rank], matrix[pivot]] = [matrix[pivot], matrix[rank]];
    const pivotValue = matrix[rank][column];
    for (let currentColumn = column; currentColumn < width; currentColumn += 1) {
      matrix[rank][currentColumn] /= pivotValue;
    }
    for (let row = 0; row < matrix.length; row += 1) {
      if (row === rank) continue;
      const factor = matrix[row][column];
      if (Math.abs(factor) <= effectiveTolerance) continue;
      for (
        let currentColumn = column;
        currentColumn < width;
        currentColumn += 1
      ) {
        matrix[row][currentColumn] -= factor * matrix[rank][currentColumn];
      }
    }
    rank += 1;
  }
  return rank;
}

function analyzeFeasibility(contract: EstimatorFeasibilityContract): {
  reasonCodes: EstimatorFeasibilityReasonCode[];
  metrics: EstimatorFeasibilityMetrics;
} {
  const reasons: EstimatorFeasibilityReasonCode[] = [];
  const assignments = contract.design_matrix.assignments;
  const pairing = contract.units.pairing;
  const cellById = new Map(
    contract.design_matrix.cells.map((cell) => [cell.cell_id, cell])
  );
  const countsByCell = countBy(assignments, (assignment) => assignment.cell_id);
  const countsByArm = countBy(assignments, (assignment) => assignment.arm_id);

  for (const cell of contract.design_matrix.cells) {
    if ((countsByCell.get(cell.cell_id) || 0) !== cell.n) {
      reasons.push("cell_n_mismatch");
    }
  }

  const armsByExecutionUnit = groupSet(
    assignments,
    (assignment) => assignment.execution_unit_id,
    (assignment) => assignment.arm_id
  );
  if ([...armsByExecutionUnit.values()].some((arms) => arms.size > 1)) {
    reasons.push("arm_isolation_violation");
  }

  const assignmentsByCluster = groupItems(
    assignments,
    (assignment) => assignment.independent_cluster_id
  );
  if (
    [...assignmentsByCluster.values()].some((clusterAssignments) => {
      const counts = countBy(clusterAssignments, (assignment) => assignment.arm_id);
      return [...counts.values()].some((count) => count > 1);
    })
  ) {
    reasons.push("cluster_pseudoreplication_unsupported");
  }

  for (const assignment of assignments) {
    const cell = cellById.get(assignment.cell_id);
    if (!cell || cell.arm_id !== assignment.arm_id) {
      reasons.push("cell_n_mismatch");
      break;
    }
  }

  const requiredArmSet = new Set(pairing.required_arms);
  const contrastArms = contract.estimand.contrast;
  if (
    contrastArms[0] === contrastArms[1]
    || contrastArms.some(
      (arm) => !requiredArmSet.has(arm) || !countsByArm.has(arm)
    )
  ) {
    reasons.push("contrast_arm_missing");
  }

  let completePairCount = 0;
  if (pairing.mode === "paired") {
    const pairGroups = new Map<string, Map<string, number>>();
    let missingPair = false;
    for (const assignment of assignments) {
      if (!assignment.pair_id) {
        missingPair = true;
        continue;
      }
      const armCounts = pairGroups.get(assignment.pair_id) || new Map<string, number>();
      armCounts.set(
        assignment.arm_id,
        (armCounts.get(assignment.arm_id) || 0) + 1
      );
      pairGroups.set(assignment.pair_id, armCounts);
    }
    for (const armCounts of pairGroups.values()) {
      const complete =
        armCounts.size === requiredArmSet.size
        && pairing.required_arms.every((arm) => armCounts.get(arm) === 1);
      if (complete) completePairCount += 1;
      else missingPair = true;
    }
    if (missingPair) reasons.push("incomplete_pair");
    if (completePairCount !== pairing.expected_complete_pairs) {
      reasons.push("pair_count_mismatch");
    }
    const pairAssignments = groupItems(
      assignments.filter((assignment) => assignment.pair_id !== null),
      (assignment) => assignment.pair_id!
    );
    if (
      [...pairAssignments.values()].some((items) =>
        new Set(items.map((item) => item.analysis_unit_id)).size !== 1
        || new Set(items.map((item) => item.independent_cluster_id)).size !== 1
        || new Set(items.map((item) => item.outcome_unit_id)).size !== items.length
      )
    ) {
      reasons.push("pair_unit_mismatch");
    }
  } else if (assignments.some((assignment) => assignment.pair_id !== null)) {
    reasons.push("unexpected_pair_id");
  } else {
    const outcomeArms = groupSet(
      assignments,
      (assignment) => assignment.outcome_unit_id,
      (assignment) => assignment.arm_id
    );
    const analysisArms = groupSet(
      assignments,
      (assignment) => assignment.analysis_unit_id,
      (assignment) => assignment.arm_id
    );
    const clusterArms = groupSet(
      assignments,
      (assignment) => assignment.independent_cluster_id,
      (assignment) => assignment.arm_id
    );
    if (
      [...outcomeArms.values(), ...analysisArms.values(), ...clusterArms.values()]
        .some((arms) => arms.size > 1)
    ) {
      reasons.push("unpaired_unit_overlap");
    }
  }

  const primaryDenominator = pairing.mode === "paired"
    ? completePairCount
    : Math.min(
      countsByArm.get(contrastArms[0]) || 0,
      countsByArm.get(contrastArms[1]) || 0
    );
  if (primaryDenominator !== contract.outcome.planned_denominator) {
    reasons.push("denominator_mismatch");
  }

  const computedResolution =
    contract.outcome.type === "binary" && primaryDenominator > 0
      ? roundMetric(1 / primaryDenominator)
      : null;
  if (
    computedResolution !== null
    && !nearlyEqual(
      computedResolution,
      contract.outcome.attainable_resolution
    )
  ) {
    reasons.push("resolution_mismatch");
  }
  if (
    contract.outcome.attainable_resolution
      > contract.power.minimum_detectable_effect + NUMERIC_TOLERANCE
  ) {
    reasons.push("resolution_exceeds_mde");
  }

  const rank = matrixRank(
    contract.design_matrix.cells.map((cell) => cell.x)
  );
  if (rank < contract.design_matrix.columns.length) {
    reasons.push("rank_deficient");
  }
  const contrastCells = contract.estimand.contrast.map((arm) =>
    contract.design_matrix.cells.find((cell) => cell.arm_id === arm)
  );
  if (
    contrastCells.some((cell) => !cell)
    || contrastCells[0]?.x.every((value, index) =>
      nearlyEqual(value, contrastCells[1]?.x[index] ?? Number.NaN)
    )
  ) {
    reasons.push("primary_contrast_not_estimable");
  }

  validateEstimatorCompatibility(contract, reasons);

  const clusterCount = new Set(
    assignments.map((assignment) => assignment.independent_cluster_id)
  ).size;
  if (
    contract.resampling.cluster_key
      !== contract.units.independent_cluster_key
  ) {
    reasons.push("cluster_key_mismatch");
  }
  if (clusterCount !== contract.resampling.planned_clusters) {
    reasons.push("cluster_count_mismatch");
  }
  if (
    clusterCount < contract.resampling.minimum_clusters
    || clusterCount < MIN_INDEPENDENT_CLUSTERS
  ) {
    reasons.push("too_few_clusters");
  }
  if (
    contract.estimator.covariance === "cluster_bootstrap"
    && contract.resampling.replicates < MIN_RESAMPLING_REPLICATES
  ) {
    reasons.push("too_few_resamples");
  }

  validateMultiplicity(contract, reasons);
  validateSeparation(contract, reasons);

  const computedMde = computeMinimumDetectableEffect(
    contract,
    completePairCount,
    countsByArm
  );
  if (
    contract.estimand.type === "risk_difference"
    && contract.power.assumed_standard_deviation > 0.5 + NUMERIC_TOLERANCE
  ) {
    reasons.push("power_assumption_invalid");
  }
  if (
    computedMde === null
    || computedMde
      > contract.power.minimum_detectable_effect + NUMERIC_TOLERANCE
  ) {
    reasons.push("power_target_unattainable");
  }

  const eventTotals = aggregateEventCounts(
    contract.design_matrix.cells,
    contrastArms
  );
  return {
    reasonCodes: uniqueSorted(reasons),
    metrics: {
      assignment_count: assignments.length,
      execution_unit_count: new Set(
        assignments.map((assignment) => assignment.execution_unit_id)
      ).size,
      analysis_unit_count: new Set(
        assignments.map((assignment) => assignment.analysis_unit_id)
      ).size,
      independent_cluster_count: clusterCount,
      complete_pair_count: completePairCount,
      design_matrix_rank: rank,
      design_matrix_column_count: contract.design_matrix.columns.length,
      primary_denominator: primaryDenominator,
      computed_resolution: computedResolution,
      computed_minimum_detectable_effect: computedMde,
      event_count: eventTotals?.events ?? null,
      non_event_count: eventTotals?.nonEvents ?? null
    }
  };
}

function validateEstimatorCompatibility(
  contract: EstimatorFeasibilityContract,
  reasons: EstimatorFeasibilityReasonCode[]
): void {
  const expectedOutcomeByEstimand: Record<
    EstimatorFeasibilityEstimand["type"],
    EstimatorFeasibilityOutcome["type"]
  > = {
    paired_risk_difference: "binary",
    risk_difference: "binary",
    paired_mean_difference: "continuous",
    mean_difference: "continuous",
    odds_ratio: "binary",
    rate_ratio: "count"
  };
  const expectedScaleByEstimand: Record<
    EstimatorFeasibilityEstimand["type"],
    EstimatorFeasibilityEstimand["scale"]
  > = {
    paired_risk_difference: "proportion",
    risk_difference: "proportion",
    paired_mean_difference: "mean",
    mean_difference: "mean",
    odds_ratio: "odds_ratio",
    rate_ratio: "rate_ratio"
  };
  const allowedEstimatorByEstimand: Record<
    EstimatorFeasibilityEstimand["type"],
    ReadonlySet<EstimatorFeasibilityEstimator["family"]>
  > = {
    paired_risk_difference: new Set(["paired_risk_difference"]),
    risk_difference: new Set(["risk_difference"]),
    paired_mean_difference: new Set(["paired_mean_difference"]),
    mean_difference: new Set(["linear_model"]),
    odds_ratio: new Set([
      "logistic_regression",
      "penalized_logistic_regression"
    ]),
    rate_ratio: new Set(["poisson_regression"])
  };
  const requiresPaired = new Set<EstimatorFeasibilityEstimand["type"]>([
    "paired_risk_difference",
    "paired_mean_difference"
  ]);
  const supportedPowerEstimands = new Set<EstimatorFeasibilityEstimand["type"]>([
    "paired_risk_difference",
    "risk_difference",
    "paired_mean_difference",
    "mean_difference"
  ]);

  if (
    expectedOutcomeByEstimand[contract.estimand.type] !== contract.outcome.type
    || expectedScaleByEstimand[contract.estimand.type]
      !== contract.estimand.scale
    || requiresPaired.has(contract.estimand.type)
      !== (contract.units.pairing.mode === "paired")
  ) {
    reasons.push("outcome_estimand_mismatch");
  }
  if (
    !allowedEstimatorByEstimand[contract.estimand.type].has(
      contract.estimator.family
    )
  ) {
    reasons.push("estimator_estimand_mismatch");
  }
  if (
    contract.units.pairing.mode === "paired"
      ? !["cluster_bootstrap", "exact_paired"].includes(
        contract.estimator.covariance
      )
      : contract.estimator.covariance === "exact_paired"
  ) {
    reasons.push("covariance_pairing_mismatch");
  }
  if (!supportedPowerEstimands.has(contract.estimand.type)) {
    reasons.push("unsupported_estimand_power_model");
  }
}

function validateMultiplicity(
  contract: EstimatorFeasibilityContract,
  reasons: EstimatorFeasibilityReasonCode[]
): void {
  const multiplicity = contract.multiplicity;
  if (multiplicity.primary_comparison_id !== contract.estimand.id) {
    reasons.push("multiplicity_primary_mismatch");
  }
  if (!multiplicity.family.includes(multiplicity.primary_comparison_id)) {
    reasons.push("multiplicity_family_mismatch");
  }
  if (
    (multiplicity.family.length === 1 && multiplicity.method !== "none")
    || (multiplicity.family.length > 1 && multiplicity.method === "none")
  ) {
    reasons.push("multiplicity_method_mismatch");
  }
  if (!nearlyEqual(multiplicity.family_alpha, contract.power.alpha)) {
    reasons.push("multiplicity_alpha_mismatch");
  }
  if (multiplicity.method === "benjamini_hochberg") {
    reasons.push("multiplicity_power_unsupported");
  }
}

function validateSeparation(
  contract: EstimatorFeasibilityContract,
  reasons: EstimatorFeasibilityReasonCode[]
): void {
  if (contract.estimator.family === "logistic_regression") {
    if (contract.estimator.separation_policy !== "block_on_separation") {
      reasons.push("unsafe_separation_policy");
      return;
    }
    const counts = contract.estimand.contrast.map((arm) =>
      aggregateEventCounts(contract.design_matrix.cells, [arm])
    );
    if (counts.some((count) => count === null)) {
      reasons.push("event_counts_missing");
      return;
    }
    if (
      counts.some(
        (count) =>
          count !== null
          && (count.events === 0 || count.nonEvents === 0)
      )
    ) {
      reasons.push("separation_detected");
    }
    return;
  }
  if (contract.estimator.family === "penalized_logistic_regression") {
    if (contract.estimator.separation_policy !== "penalized") {
      reasons.push("unsafe_separation_policy");
    }
    return;
  }
  if (contract.estimator.separation_policy !== "not_applicable") {
    reasons.push("unsafe_separation_policy");
  }
}

function computeMinimumDetectableEffect(
  contract: EstimatorFeasibilityContract,
  completePairCount: number,
  countsByArm: Map<string, number>
): number | null {
  if (
    contract.estimand.type === "odds_ratio"
    || contract.estimand.type === "rate_ratio"
    || contract.multiplicity.method === "benjamini_hochberg"
  ) {
    return null;
  }
  const effectiveAlpha =
    contract.multiplicity.method === "bonferroni"
    || contract.multiplicity.method === "holm"
      ? contract.multiplicity.family_alpha
        / contract.multiplicity.family.length
      : contract.power.alpha;
  const alphaQuantile = contract.power.sidedness === "two_sided"
    ? 1 - effectiveAlpha / 2
    : 1 - effectiveAlpha;
  const criticalValue =
    inverseNormalCdf(alphaQuantile)
    + inverseNormalCdf(contract.power.target_power);
  if (!Number.isFinite(criticalValue) || criticalValue <= 0) return null;

  let standardError: number;
  if (contract.units.pairing.mode === "paired") {
    if (completePairCount <= 0) return null;
    standardError =
      contract.power.assumed_standard_deviation / Math.sqrt(completePairCount);
  } else {
    const [leftArm, rightArm] = contract.estimand.contrast;
    const leftCount = countsByArm.get(leftArm) || 0;
    const rightCount = countsByArm.get(rightArm) || 0;
    if (leftCount <= 0 || rightCount <= 0) return null;
    standardError = contract.power.assumed_standard_deviation
      * Math.sqrt(1 / leftCount + 1 / rightCount);
  }
  return roundMetric(criticalValue * standardError);
}

function inverseNormalCdf(probability: number): number {
  if (probability <= 0 || probability >= 1) return Number.NaN;

  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239
  ];
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416
  ];
  const lower = 0.02425;
  const upper = 1 - lower;
  if (probability < lower) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q
        + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (probability > upper) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q
        + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = probability - 0.5;
  const r = q * q;
  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r
      + a[5])
    * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4])
      * r + 1)
  );
}

function aggregateEventCounts(
  cells: EstimatorDesignCell[],
  arms: readonly string[]
): { events: number; nonEvents: number } | null {
  const selected = cells.filter((cell) => arms.includes(cell.arm_id));
  if (
    selected.length === 0
    || selected.some(
      (cell) => cell.events === null || cell.non_events === null
    )
  ) {
    return null;
  }
  return selected.reduce(
    (totals, cell) => ({
      events: totals.events + (cell.events || 0),
      nonEvents: totals.nonEvents + (cell.non_events || 0)
    }),
    { events: 0, nonEvents: 0 }
  );
}

function validateContractIntegrity(
  contract: EstimatorFeasibilityContract,
  context: EstimatorFeasibilityBindingContext
): EstimatorFeasibilityReasonCode[] {
  const reasons: EstimatorFeasibilityReasonCode[] = [];
  if (hashCanonical(withoutContentHash(contract)) !== contract.content_sha256) {
    reasons.push("contract_hash_mismatch");
  }
  if (
    context.expectedRunId !== undefined
    && contract.bindings.run_id !== context.expectedRunId
  ) {
    reasons.push("run_binding_mismatch");
  }
  if (
    context.expectedActiveProbeSha256 !== undefined
    && contract.bindings.active_probe_sha256
      !== context.expectedActiveProbeSha256
  ) {
    reasons.push("probe_binding_mismatch");
  }
  if (
    context.expectedExperimentContractSha256 !== undefined
    && contract.bindings.experiment_contract_sha256
      !== context.expectedExperimentContractSha256
  ) {
    reasons.push("experiment_binding_mismatch");
  }
  return reasons;
}

function normalizeContractInput(
  input: EstimatorFeasibilityContractInput
): EstimatorFeasibilityContractInput {
  if (!isRecord(input) || !hasOnlyFields(input, CONTRACT_INPUT_FIELDS)) {
    throw new Error("estimator_feasibility_contract_input_invalid");
  }
  return {
    bindings: normalizeBindings(input.bindings),
    units: normalizeUnits(input.units),
    outcome: normalizeOutcome(input.outcome),
    estimand: normalizeEstimand(input.estimand),
    estimator: normalizeEstimator(input.estimator),
    design_matrix: normalizeDesignMatrix(input.design_matrix),
    power: normalizePower(input.power),
    resampling: normalizeResampling(input.resampling),
    multiplicity: normalizeMultiplicity(input.multiplicity)
  };
}

function normalizeBindings(value: unknown): EstimatorFeasibilityBindings {
  if (!isRecord(value) || !hasOnlyFields(value, BINDING_FIELDS)) {
    throw new Error("estimator_feasibility_bindings_invalid");
  }
  return {
    run_id: requireIdentifier(value.run_id, "run_id"),
    active_probe_sha256: requireSha256(
      value.active_probe_sha256,
      "active_probe_sha256"
    ),
    experiment_contract_sha256: requireSha256(
      value.experiment_contract_sha256,
      "experiment_contract_sha256"
    )
  };
}

function normalizeUnits(value: unknown): EstimatorFeasibilityUnits {
  if (!isRecord(value) || !hasOnlyFields(value, UNIT_FIELDS)) {
    throw new Error("estimator_feasibility_units_invalid");
  }
  if (value.arm_isolation !== "one_arm_per_execution_unit") {
    throw new Error("estimator_feasibility_arm_isolation_invalid");
  }
  return {
    execution_unit: requireIdentifier(value.execution_unit, "execution_unit"),
    exposure_unit: requireIdentifier(value.exposure_unit, "exposure_unit"),
    outcome_unit: requireIdentifier(value.outcome_unit, "outcome_unit"),
    analysis_unit: requireIdentifier(value.analysis_unit, "analysis_unit"),
    independent_cluster_key: requireIdentifier(
      value.independent_cluster_key,
      "independent_cluster_key"
    ),
    arm_isolation: value.arm_isolation,
    pairing: normalizePairing(value.pairing)
  };
}

function normalizePairing(value: unknown): EstimatorPairing {
  if (!isRecord(value) || !hasOnlyFields(value, PAIRING_FIELDS)) {
    throw new Error("estimator_feasibility_pairing_invalid");
  }
  if (value.mode !== "paired" && value.mode !== "unpaired") {
    throw new Error("estimator_feasibility_pairing_mode_invalid");
  }
  const requiredArms = normalizeIdentifierArray(
    value.required_arms,
    "required_arms",
    2,
    MAX_ARMS
  );
  if (value.mode === "paired") {
    return {
      mode: value.mode,
      pair_key: requireIdentifier(value.pair_key, "pair_key"),
      required_arms: requiredArms,
      expected_complete_pairs: requirePositiveInteger(
        value.expected_complete_pairs,
        "expected_complete_pairs"
      )
    };
  }
  if (
    value.pair_key !== null
    || value.expected_complete_pairs !== null
  ) {
    throw new Error("estimator_feasibility_unpaired_contract_invalid");
  }
  return {
    mode: value.mode,
    pair_key: null,
    required_arms: requiredArms,
    expected_complete_pairs: null
  };
}

function normalizeOutcome(value: unknown): EstimatorFeasibilityOutcome {
  if (!isRecord(value) || !hasOnlyFields(value, OUTCOME_FIELDS)) {
    throw new Error("estimator_feasibility_outcome_invalid");
  }
  if (
    value.type !== "binary"
    && value.type !== "continuous"
    && value.type !== "count"
  ) {
    throw new Error("estimator_feasibility_outcome_type_invalid");
  }
  return {
    type: value.type,
    planned_denominator: requirePositiveInteger(
      value.planned_denominator,
      "planned_denominator"
    ),
    attainable_resolution: requirePositiveNumber(
      value.attainable_resolution,
      "attainable_resolution"
    )
  };
}

function normalizeEstimand(value: unknown): EstimatorFeasibilityEstimand {
  if (!isRecord(value) || !hasOnlyFields(value, ESTIMAND_FIELDS)) {
    throw new Error("estimator_feasibility_estimand_invalid");
  }
  if (
    !ESTIMAND_TYPES.has(value.type as EstimatorFeasibilityEstimand["type"])
    || !ESTIMAND_SCALES.has(value.scale as EstimatorFeasibilityEstimand["scale"])
    || !Array.isArray(value.contrast)
    || value.contrast.length !== 2
  ) {
    throw new Error("estimator_feasibility_estimand_schema_invalid");
  }
  return {
    id: requireIdentifier(value.id, "estimand_id"),
    type: value.type as EstimatorFeasibilityEstimand["type"],
    contrast: [
      requireIdentifier(value.contrast[0], "contrast_left"),
      requireIdentifier(value.contrast[1], "contrast_right")
    ],
    scale: value.scale as EstimatorFeasibilityEstimand["scale"]
  };
}

function normalizeEstimator(value: unknown): EstimatorFeasibilityEstimator {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, ESTIMATOR_FIELDS)
    || !ESTIMATOR_FAMILIES.has(
      value.family as EstimatorFeasibilityEstimator["family"]
    )
    || !COVARIANCE_TYPES.has(
      value.covariance as EstimatorFeasibilityEstimator["covariance"]
    )
    || !SEPARATION_POLICIES.has(
      value.separation_policy as EstimatorFeasibilityEstimator["separation_policy"]
    )
  ) {
    throw new Error("estimator_feasibility_estimator_invalid");
  }
  return {
    family: value.family as EstimatorFeasibilityEstimator["family"],
    covariance: value.covariance as EstimatorFeasibilityEstimator["covariance"],
    separation_policy:
      value.separation_policy as EstimatorFeasibilityEstimator["separation_policy"]
  };
}

function normalizeDesignMatrix(value: unknown): EstimatorDesignMatrix {
  if (!isRecord(value) || !hasOnlyFields(value, DESIGN_MATRIX_FIELDS)) {
    throw new Error("estimator_feasibility_design_matrix_invalid");
  }
  const columns = normalizeIdentifierArray(
    value.columns,
    "design_columns",
    1,
    MAX_COLUMNS,
    false
  );
  if (
    !Array.isArray(value.cells)
    || value.cells.length < 2
    || value.cells.length > MAX_CELLS
    || !Array.isArray(value.assignments)
    || value.assignments.length === 0
    || value.assignments.length > MAX_ASSIGNMENTS
  ) {
    throw new Error("estimator_feasibility_design_manifest_invalid");
  }
  const cells = value.cells
    .map((cell) => normalizeCell(cell, columns.length))
    .sort((left, right) => compareText(left.cell_id, right.cell_id));
  const assignments = value.assignments
    .map(normalizeAssignment)
    .sort((left, right) => compareText(left.assignment_id, right.assignment_id));
  requireUnique(cells.map((cell) => cell.cell_id), "design_cell");
  requireUnique(
    assignments.map((assignment) => assignment.assignment_id),
    "design_assignment"
  );
  return { columns, cells, assignments };
}

function normalizeCell(value: unknown, width: number): EstimatorDesignCell {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, CELL_FIELDS)
    || !Array.isArray(value.x)
    || value.x.length !== width
    || value.x.some((item) => !isFiniteNumber(item))
  ) {
    throw new Error("estimator_feasibility_design_cell_invalid");
  }
  const n = requirePositiveInteger(value.n, "cell_n");
  const events = requireNullableCount(value.events, n, "events");
  const nonEvents = requireNullableCount(value.non_events, n, "non_events");
  if (
    (events === null) !== (nonEvents === null)
    || (events !== null && nonEvents !== null && events + nonEvents !== n)
  ) {
    throw new Error("estimator_feasibility_event_counts_invalid");
  }
  return {
    cell_id: requireIdentifier(value.cell_id, "cell_id"),
    arm_id: requireIdentifier(value.arm_id, "cell_arm_id"),
    n,
    x: value.x.map(Number),
    events,
    non_events: nonEvents
  };
}

function normalizeAssignment(value: unknown): EstimatorDesignAssignment {
  if (!isRecord(value) || !hasOnlyFields(value, ASSIGNMENT_FIELDS)) {
    throw new Error("estimator_feasibility_assignment_invalid");
  }
  return {
    assignment_id: requireIdentifier(value.assignment_id, "assignment_id"),
    execution_unit_id: requireIdentifier(
      value.execution_unit_id,
      "execution_unit_id"
    ),
    exposure_unit_id: requireIdentifier(
      value.exposure_unit_id,
      "exposure_unit_id"
    ),
    outcome_unit_id: requireIdentifier(value.outcome_unit_id, "outcome_unit_id"),
    analysis_unit_id: requireIdentifier(
      value.analysis_unit_id,
      "analysis_unit_id"
    ),
    independent_cluster_id: requireIdentifier(
      value.independent_cluster_id,
      "independent_cluster_id"
    ),
    arm_id: requireIdentifier(value.arm_id, "assignment_arm_id"),
    cell_id: requireIdentifier(value.cell_id, "assignment_cell_id"),
    pair_id: value.pair_id === null
      ? null
      : requireIdentifier(value.pair_id, "assignment_pair_id")
  };
}

function normalizePower(value: unknown): EstimatorFeasibilityPower {
  if (!isRecord(value) || !hasOnlyFields(value, POWER_FIELDS)) {
    throw new Error("estimator_feasibility_power_invalid");
  }
  if (value.sidedness !== "one_sided" && value.sidedness !== "two_sided") {
    throw new Error("estimator_feasibility_sidedness_invalid");
  }
  const alpha = requireUnitInterval(value.alpha, "alpha");
  const targetPower = requireUnitInterval(value.target_power, "target_power");
  if (targetPower <= 0.5) {
    throw new Error("estimator_feasibility_target_power_invalid");
  }
  return {
    alpha,
    target_power: targetPower,
    minimum_detectable_effect: requirePositiveNumber(
      value.minimum_detectable_effect,
      "minimum_detectable_effect"
    ),
    assumed_standard_deviation: requirePositiveNumber(
      value.assumed_standard_deviation,
      "assumed_standard_deviation"
    ),
    sidedness: value.sidedness
  };
}

function normalizeResampling(value: unknown): EstimatorFeasibilityResampling {
  if (!isRecord(value) || !hasOnlyFields(value, RESAMPLING_FIELDS)) {
    throw new Error("estimator_feasibility_resampling_invalid");
  }
  return {
    cluster_key: requireIdentifier(value.cluster_key, "resampling_cluster_key"),
    planned_clusters: requirePositiveInteger(
      value.planned_clusters,
      "planned_clusters"
    ),
    minimum_clusters: requirePositiveInteger(
      value.minimum_clusters,
      "minimum_clusters"
    ),
    replicates: requirePositiveInteger(value.replicates, "replicates")
  };
}

function normalizeMultiplicity(
  value: unknown
): EstimatorFeasibilityMultiplicity {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, MULTIPLICITY_FIELDS)
    || !MULTIPLICITY_METHODS.has(
      value.method as EstimatorFeasibilityMultiplicity["method"]
    )
  ) {
    throw new Error("estimator_feasibility_multiplicity_invalid");
  }
  return {
    primary_comparison_id: requireIdentifier(
      value.primary_comparison_id,
      "primary_comparison_id"
    ),
    family: normalizeIdentifierArray(
      value.family,
      "multiplicity_family",
      1,
      MAX_COMPARISONS
    ),
    method: value.method as EstimatorFeasibilityMultiplicity["method"],
    family_alpha: requireUnitInterval(value.family_alpha, "family_alpha")
  };
}

function isEstimatorFeasibilityContract(
  value: unknown
): value is EstimatorFeasibilityContract {
  return (
    isRecord(value)
    && hasOnlyFields(value, CONTRACT_FIELDS)
    && value.schema_version === ESTIMATOR_FEASIBILITY_SCHEMA_VERSION
    && value.artifact_kind === "estimator_feasibility_contract"
    && isBindings(value.bindings)
    && isUnits(value.units)
    && isOutcome(value.outcome)
    && isEstimand(value.estimand)
    && isEstimator(value.estimator)
    && isDesignMatrix(value.design_matrix)
    && isPower(value.power)
    && isResampling(value.resampling)
    && isMultiplicity(value.multiplicity)
    && isSha256(value.content_sha256)
  );
}

function isEstimatorFeasibilityReport(
  value: unknown
): value is EstimatorFeasibilityReport {
  return (
    isRecord(value)
    && hasOnlyFields(value, REPORT_FIELDS)
    && value.schema_version === ESTIMATOR_FEASIBILITY_SCHEMA_VERSION
    && value.artifact_kind === "estimator_feasibility_report"
    && isBindings(value.bindings)
    && isSha256(value.contract_declared_sha256)
    && isSha256(value.contract_recomputed_sha256)
    && (value.status === "pass" || value.status === "blocked")
    && Array.isArray(value.reason_codes)
    && value.reason_codes.every(
      (reason) => typeof reason === "string" && REASON_CODE_SET.has(reason)
    )
    && new Set(value.reason_codes).size === value.reason_codes.length
    && isSorted(value.reason_codes)
    && isMetrics(value.metrics)
    && isSha256(value.content_sha256)
  );
}

function isBindings(value: unknown): value is EstimatorFeasibilityBindings {
  return (
    isRecord(value)
    && hasOnlyFields(value, BINDING_FIELDS)
    && isIdentifier(value.run_id)
    && isSha256(value.active_probe_sha256)
    && isSha256(value.experiment_contract_sha256)
  );
}

function isUnits(value: unknown): value is EstimatorFeasibilityUnits {
  return (
    isRecord(value)
    && hasOnlyFields(value, UNIT_FIELDS)
    && isIdentifier(value.execution_unit)
    && isIdentifier(value.exposure_unit)
    && isIdentifier(value.outcome_unit)
    && isIdentifier(value.analysis_unit)
    && isIdentifier(value.independent_cluster_key)
    && value.arm_isolation === "one_arm_per_execution_unit"
    && isPairing(value.pairing)
  );
}

function isPairing(value: unknown): value is EstimatorPairing {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, PAIRING_FIELDS)
    || (value.mode !== "paired" && value.mode !== "unpaired")
    || !isIdentifierArray(value.required_arms, 2, MAX_ARMS)
  ) {
    return false;
  }
  return value.mode === "paired"
    ? isIdentifier(value.pair_key)
      && isPositiveInteger(value.expected_complete_pairs)
    : value.pair_key === null && value.expected_complete_pairs === null;
}

function isOutcome(value: unknown): value is EstimatorFeasibilityOutcome {
  return (
    isRecord(value)
    && hasOnlyFields(value, OUTCOME_FIELDS)
    && (
      value.type === "binary"
      || value.type === "continuous"
      || value.type === "count"
    )
    && isPositiveInteger(value.planned_denominator)
    && isPositiveNumber(value.attainable_resolution)
  );
}

function isEstimand(value: unknown): value is EstimatorFeasibilityEstimand {
  return (
    isRecord(value)
    && hasOnlyFields(value, ESTIMAND_FIELDS)
    && isIdentifier(value.id)
    && ESTIMAND_TYPES.has(value.type as EstimatorFeasibilityEstimand["type"])
    && Array.isArray(value.contrast)
    && value.contrast.length === 2
    && value.contrast.every(isIdentifier)
    && ESTIMAND_SCALES.has(value.scale as EstimatorFeasibilityEstimand["scale"])
  );
}

function isEstimator(value: unknown): value is EstimatorFeasibilityEstimator {
  return (
    isRecord(value)
    && hasOnlyFields(value, ESTIMATOR_FIELDS)
    && ESTIMATOR_FAMILIES.has(
      value.family as EstimatorFeasibilityEstimator["family"]
    )
    && COVARIANCE_TYPES.has(
      value.covariance as EstimatorFeasibilityEstimator["covariance"]
    )
    && SEPARATION_POLICIES.has(
      value.separation_policy as EstimatorFeasibilityEstimator["separation_policy"]
    )
  );
}

function isDesignMatrix(value: unknown): value is EstimatorDesignMatrix {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, DESIGN_MATRIX_FIELDS)
    || !isIdentifierArray(value.columns, 1, MAX_COLUMNS, false)
  ) {
    return false;
  }
  const columnCount = value.columns.length;
  if (
    !Array.isArray(value.cells)
    || value.cells.length < 2
    || value.cells.length > MAX_CELLS
    || !value.cells.every(
      (cell) => isDesignCell(cell, columnCount)
    )
    || !isSortedBy(value.cells, (cell) => cell.cell_id)
    || !Array.isArray(value.assignments)
    || value.assignments.length === 0
    || value.assignments.length > MAX_ASSIGNMENTS
    || !value.assignments.every(isDesignAssignment)
    || !isSortedBy(value.assignments, (assignment) => assignment.assignment_id)
  ) {
    return false;
  }
  return (
    new Set(value.cells.map((cell) => cell.cell_id)).size === value.cells.length
    && new Set(
      value.assignments.map((assignment) => assignment.assignment_id)
    ).size === value.assignments.length
  );
}

function isDesignCell(value: unknown, width: number): value is EstimatorDesignCell {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, CELL_FIELDS)
    || !isIdentifier(value.cell_id)
    || !isIdentifier(value.arm_id)
    || !isPositiveInteger(value.n)
    || !Array.isArray(value.x)
    || value.x.length !== width
    || !value.x.every(isFiniteNumber)
    || !isNullableCount(value.events, value.n)
    || !isNullableCount(value.non_events, value.n)
  ) {
    return false;
  }
  return (
    (value.events === null) === (value.non_events === null)
    && (
      value.events === null
      || value.non_events === null
      || value.events + value.non_events === value.n
    )
  );
}

function isDesignAssignment(
  value: unknown
): value is EstimatorDesignAssignment {
  return (
    isRecord(value)
    && hasOnlyFields(value, ASSIGNMENT_FIELDS)
    && isIdentifier(value.assignment_id)
    && isIdentifier(value.execution_unit_id)
    && isIdentifier(value.exposure_unit_id)
    && isIdentifier(value.outcome_unit_id)
    && isIdentifier(value.analysis_unit_id)
    && isIdentifier(value.independent_cluster_id)
    && isIdentifier(value.arm_id)
    && isIdentifier(value.cell_id)
    && (value.pair_id === null || isIdentifier(value.pair_id))
  );
}

function isPower(value: unknown): value is EstimatorFeasibilityPower {
  return (
    isRecord(value)
    && hasOnlyFields(value, POWER_FIELDS)
    && isUnitInterval(value.alpha)
    && isUnitInterval(value.target_power)
    && value.target_power > 0.5
    && isPositiveNumber(value.minimum_detectable_effect)
    && isPositiveNumber(value.assumed_standard_deviation)
    && (value.sidedness === "one_sided" || value.sidedness === "two_sided")
  );
}

function isResampling(value: unknown): value is EstimatorFeasibilityResampling {
  return (
    isRecord(value)
    && hasOnlyFields(value, RESAMPLING_FIELDS)
    && isIdentifier(value.cluster_key)
    && isPositiveInteger(value.planned_clusters)
    && isPositiveInteger(value.minimum_clusters)
    && isPositiveInteger(value.replicates)
  );
}

function isMultiplicity(
  value: unknown
): value is EstimatorFeasibilityMultiplicity {
  return (
    isRecord(value)
    && hasOnlyFields(value, MULTIPLICITY_FIELDS)
    && isIdentifier(value.primary_comparison_id)
    && isIdentifierArray(value.family, 1, MAX_COMPARISONS)
    && MULTIPLICITY_METHODS.has(
      value.method as EstimatorFeasibilityMultiplicity["method"]
    )
    && isUnitInterval(value.family_alpha)
  );
}

function isMetrics(value: unknown): value is EstimatorFeasibilityMetrics {
  if (!isRecord(value) || !hasOnlyFields(value, METRIC_FIELDS)) return false;
  for (const field of [
    "assignment_count",
    "execution_unit_count",
    "analysis_unit_count",
    "independent_cluster_count",
    "complete_pair_count",
    "design_matrix_rank",
    "design_matrix_column_count",
    "primary_denominator"
  ] as const) {
    if (!isNonNegativeInteger(value[field])) return false;
  }
  for (const field of [
    "computed_resolution",
    "computed_minimum_detectable_effect"
  ] as const) {
    if (value[field] !== null && !isPositiveNumber(value[field])) return false;
  }
  for (const field of ["event_count", "non_event_count"] as const) {
    if (value[field] !== null && !isNonNegativeInteger(value[field])) return false;
  }
  return true;
}

function normalizeIdentifierArray(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  sort = true
): string[] {
  if (
    !Array.isArray(value)
    || value.length < minimum
    || value.length > maximum
  ) {
    throw new Error(`estimator_feasibility_${field}_invalid`);
  }
  const normalized = value.map((item) => requireIdentifier(item, field));
  requireUnique(normalized, field);
  return sort ? normalized.sort(compareText) : normalized;
}

function isIdentifierArray(
  value: unknown,
  minimum: number,
  maximum: number,
  sorted = true
): value is string[] {
  return (
    Array.isArray(value)
    && value.length >= minimum
    && value.length <= maximum
    && value.every(isIdentifier)
    && new Set(value).size === value.length
    && (!sorted || isSorted(value))
  );
}

function requireUnique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`estimator_feasibility_${field}_duplicate`);
  }
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`estimator_feasibility_${field}_invalid`);
  }
  const normalized = normalizeIdentifier(value);
  if (!normalized || normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(`estimator_feasibility_${field}_invalid`);
  }
  return normalized;
}

function normalizeIdentifier(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value === normalizeIdentifier(value)
  );
}

function requireSha256(value: unknown, field: string): string {
  if (!isSha256(value)) {
    throw new Error(`estimator_feasibility_${field}_invalid`);
  }
  return value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!isPositiveInteger(value)) {
    throw new Error(`estimator_feasibility_${field}_invalid`);
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
  );
}

function requireNullableCount(
  value: unknown,
  maximum: number,
  field: string
): number | null {
  if (!isNullableCount(value, maximum)) {
    throw new Error(`estimator_feasibility_${field}_invalid`);
  }
  return value;
}

function isNullableCount(value: unknown, maximum: number): value is number | null {
  return (
    value === null
    || (
      isNonNegativeInteger(value)
      && value <= maximum
    )
  );
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (!isPositiveNumber(value)) {
    throw new Error(`estimator_feasibility_${field}_invalid`);
  }
  return value;
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function requireUnitInterval(value: unknown, field: string): number {
  if (!isUnitInterval(value)) {
    throw new Error(`estimator_feasibility_${field}_invalid`);
  }
  return value;
}

function isUnitInterval(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0 && value < 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function countBy<T>(
  values: readonly T[],
  key: (value: T) => string
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const itemKey = key(value);
    counts.set(itemKey, (counts.get(itemKey) || 0) + 1);
  }
  return counts;
}

function groupItems<T>(
  values: readonly T[],
  key: (value: T) => string
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const itemKey = key(value);
    const items = groups.get(itemKey) || [];
    items.push(value);
    groups.set(itemKey, items);
  }
  return groups;
}

function groupSet<T>(
  values: readonly T[],
  groupKey: (value: T) => string,
  member: (value: T) => string
): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>();
  for (const value of values) {
    const key = groupKey(value);
    const members = groups.get(key) || new Set<string>();
    members.add(member(value));
    groups.set(key, members);
  }
  return groups;
}

function withoutContentHash(
  contract: EstimatorFeasibilityContract
): Omit<EstimatorFeasibilityContract, "content_sha256"> {
  const { content_sha256: _contentSha256, ...payload } = contract;
  return payload;
}

function hasOnlyFields(
  value: Record<string, unknown>,
  allowed: Set<string>
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSorted(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || compareText(values[index - 1], value) < 0
  );
}

function isSortedBy<T>(
  values: readonly T[],
  key: (value: T) => string
): boolean {
  return values.every(
    (value, index) =>
      index === 0
      || compareText(key(values[index - 1]), key(value)) < 0
  );
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nearlyEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= NUMERIC_TOLERANCE * scale;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(12));
}
