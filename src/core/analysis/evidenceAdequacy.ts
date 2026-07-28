import { hashCanonical } from "../canonicalHash.js";
import {
  normalizeEstimatorProtocolDeclaration,
  type EstimatorProtocolDeclaration
} from "../estimatorProtocol.js";

export const EVIDENCE_ADEQUACY_SCHEMA =
  "autolabos.evidence_adequacy" as const;
export const EVIDENCE_ADEQUACY_VERSION = 2 as const;
export const EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH =
  "evidence_adequacy_contract.json" as const;
export const EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH =
  "evidence_adequacy_execution_receipt.json" as const;
export const EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH =
  "evidence_adequacy_assessment.json" as const;
export const EVIDENCE_ADEQUACY_METRICS_FIELD =
  "evidence_adequacy_execution_evidence" as const;

export type EvidenceAdequacyCheckStatus = "pass" | "fail" | "unknown";
export type EvidenceAdequacyCoverageMode =
  | "sampled"
  | "deterministic_exhaustive";
export type EvidenceAdequacyDesignSourceKind =
  | "estimator_protocol"
  | "deterministic_exhaustive_manifest";

export interface EvidenceAdequacyContractV2 {
  schema: typeof EVIDENCE_ADEQUACY_SCHEMA;
  version: typeof EVIDENCE_ADEQUACY_VERSION;
  kind: "evidence_adequacy_contract";
  primary_comparison_id: string;
  design_source: {
    kind: EvidenceAdequacyDesignSourceKind;
    content_sha256: string;
  };
  independent_unit: {
    key: string;
    analysis_unit: string;
  };
  planned_independent_coverage: {
    mode: EvidenceAdequacyCoverageMode;
    target_unique_units: number;
    target_denominator_per_arm: number;
    population_manifest_sha256: string | null;
  };
  required_contrast: {
    arms: string[];
    paired: boolean;
    required_complete_pairs: number | null;
  };
  uncertainty_requirement: {
    mode: "required" | "none";
    allowed_methods: string[];
    confidence_level: number | null;
    decision_rule:
      | "directed_interval_bound_meets_effect_criterion"
      | null;
    deterministic_exhaustive_rationale: string | null;
  };
  effect_resolution: {
    scale: string;
    minimum_resolvable_effect: number;
  };
  execution_budget: {
    applicable: boolean;
    numeric_floors: Record<string, number>;
    not_applicable_rationale: string | null;
  };
  content_sha256: string;
}

export interface EvidenceAdequacyExecutionReceiptV2 {
  schema: typeof EVIDENCE_ADEQUACY_SCHEMA;
  version: typeof EVIDENCE_ADEQUACY_VERSION;
  kind: "evidence_adequacy_execution_receipt";
  contract_sha256: string;
  primary_comparison_id: string;
  observed_population_manifest_sha256: string | null;
  unique_execution_ids: string[];
  observed_independent_unit_ids: string[];
  observed_denominator_by_arm: Record<string, number>;
  observed_pair_coverage: {
    complete_pair_ids: string[];
    incomplete_pair_ids: string[];
  };
  observed_uncertainty_methods: string[];
  execution_budget_measurements: Record<string, number>;
  primary_evidence_refs: string[];
  auxiliary_evidence_refs: string[];
  deterministic_oracle_evidence_refs: string[];
  content_sha256: string;
}

export interface EvidenceAdequacyExecutionEvidenceV2 {
  schema: typeof EVIDENCE_ADEQUACY_SCHEMA;
  version: typeof EVIDENCE_ADEQUACY_VERSION;
  kind: "evidence_adequacy_execution_evidence";
  contract_sha256: string;
  primary_comparison_id: string;
  observed_population_manifest_sha256: string | null;
  unique_execution_ids: string[];
  observed_independent_unit_ids: string[];
  observed_denominator_by_arm: Record<string, number>;
  observed_pair_coverage: {
    complete_pair_ids: string[];
    incomplete_pair_ids: string[];
  };
  observed_uncertainty_methods: string[];
  execution_budget_measurements: Record<string, number>;
  primary_evidence_refs: string[];
  auxiliary_evidence_refs: string[];
  deterministic_oracle_evidence_refs: string[];
}

export type EvidenceAdequacyCheckId =
  | "contract_integrity"
  | "receipt_integrity"
  | "binding_integrity"
  | "execution_identity_uniqueness"
  | "independent_coverage"
  | "contrast_coverage"
  | "denominator_coverage"
  | "pair_coverage"
  | "uncertainty"
  | "execution_budget"
  | "evidence_linkage";

export interface EvidenceAdequacyCheckV2 {
  check_id: EvidenceAdequacyCheckId;
  status: EvidenceAdequacyCheckStatus;
  evidence_refs: string[];
  reasons: string[];
}

export interface EvidenceAdequacyAssessmentV2 {
  schema: typeof EVIDENCE_ADEQUACY_SCHEMA;
  version: typeof EVIDENCE_ADEQUACY_VERSION;
  kind: "evidence_adequacy_assessment";
  contract_sha256: string;
  receipt_sha256: string;
  primary_comparison_id: string;
  checks: EvidenceAdequacyCheckV2[];
  overall_status: EvidenceAdequacyCheckStatus;
  passed: boolean;
  content_sha256: string;
}

export interface EvidenceAdequacyValidation<T> {
  valid: boolean;
  reasons: string[];
  artifact?: T;
}

export interface EvidenceAdequacyContractInput {
  primaryComparisonId: string;
  designSource: {
    kind: EvidenceAdequacyDesignSourceKind;
    contentSha256: string;
  };
  independentUnit: {
    key: string;
    analysisUnit: string;
  };
  plannedIndependentCoverage: {
    mode: EvidenceAdequacyCoverageMode;
    targetUniqueUnits: number;
    targetDenominatorPerArm: number;
    populationManifestSha256?: string;
  };
  requiredContrast: {
    arms: string[];
    paired: boolean;
    requiredCompletePairs: number | null;
  };
  uncertaintyRequirement:
    | {
      mode: "required";
      allowedMethods: string[];
      confidenceLevel: number;
      decisionRule: "directed_interval_bound_meets_effect_criterion";
    }
    | {
      mode: "none";
      deterministicExhaustiveRationale: string;
    };
  effectResolution: {
    scale: string;
    minimumResolvableEffect: number;
  };
  executionBudget:
    | {
      applicable: true;
      numericFloors: Record<string, number>;
    }
    | {
      applicable: false;
      notApplicableRationale: string;
    };
}

export interface EvidenceAdequacyExecutionReceiptInput {
  contractSha256: string;
  primaryComparisonId: string;
  observedPopulationManifestSha256?: string;
  uniqueExecutionIds: string[];
  observedIndependentUnitIds: string[];
  observedDenominatorByArm: Record<string, number>;
  observedPairCoverage?: {
    completePairIds: string[];
    incompletePairIds: string[];
  };
  observedUncertaintyMethods?: string[];
  executionBudgetMeasurements?: Record<string, number>;
  primaryEvidenceRefs: string[];
  auxiliaryEvidenceRefs?: string[];
  deterministicOracleEvidenceRefs?: string[];
}

export interface EvidenceAdequacyEstimatorAdapterInput {
  protocol: unknown;
  effectResolutionScale?: string;
  executionBudget?:
    | {
      applicable: true;
      numericFloors: Record<string, number>;
    }
    | {
      applicable: false;
      notApplicableRationale: string;
    };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const NUMERIC_KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,79}$/u;
const CONTRACT_FIELDS = new Set([
  "schema",
  "version",
  "kind",
  "primary_comparison_id",
  "design_source",
  "independent_unit",
  "planned_independent_coverage",
  "required_contrast",
  "uncertainty_requirement",
  "effect_resolution",
  "execution_budget",
  "content_sha256"
]);
const DESIGN_SOURCE_FIELDS = new Set(["kind", "content_sha256"]);
const INDEPENDENT_UNIT_FIELDS = new Set(["key", "analysis_unit"]);
const COVERAGE_FIELDS = new Set([
  "mode",
  "target_unique_units",
  "target_denominator_per_arm",
  "population_manifest_sha256"
]);
const CONTRAST_FIELDS = new Set([
  "arms",
  "paired",
  "required_complete_pairs"
]);
const UNCERTAINTY_FIELDS = new Set([
  "mode",
  "allowed_methods",
  "confidence_level",
  "decision_rule",
  "deterministic_exhaustive_rationale"
]);
const EFFECT_RESOLUTION_FIELDS = new Set([
  "scale",
  "minimum_resolvable_effect"
]);
const EXECUTION_BUDGET_FIELDS = new Set([
  "applicable",
  "numeric_floors",
  "not_applicable_rationale"
]);
const RECEIPT_FIELDS = new Set([
  "schema",
  "version",
  "kind",
  "contract_sha256",
  "primary_comparison_id",
  "observed_population_manifest_sha256",
  "unique_execution_ids",
  "observed_independent_unit_ids",
  "observed_denominator_by_arm",
  "observed_pair_coverage",
  "observed_uncertainty_methods",
  "execution_budget_measurements",
  "primary_evidence_refs",
  "auxiliary_evidence_refs",
  "deterministic_oracle_evidence_refs",
  "content_sha256"
]);
const EXECUTION_EVIDENCE_FIELDS = new Set(
  [...RECEIPT_FIELDS].filter((field) => field !== "content_sha256")
);
const PAIR_COVERAGE_FIELDS = new Set([
  "complete_pair_ids",
  "incomplete_pair_ids"
]);
const ASSESSMENT_FIELDS = new Set([
  "schema",
  "version",
  "kind",
  "contract_sha256",
  "receipt_sha256",
  "primary_comparison_id",
  "checks",
  "overall_status",
  "passed",
  "content_sha256"
]);
const CHECK_FIELDS = new Set([
  "check_id",
  "status",
  "evidence_refs",
  "reasons"
]);
const CHECK_IDS: EvidenceAdequacyCheckId[] = [
  "contract_integrity",
  "receipt_integrity",
  "binding_integrity",
  "execution_identity_uniqueness",
  "independent_coverage",
  "contrast_coverage",
  "denominator_coverage",
  "pair_coverage",
  "uncertainty",
  "execution_budget",
  "evidence_linkage"
];
const CHECK_STATUSES = new Set<EvidenceAdequacyCheckStatus>([
  "pass",
  "fail",
  "unknown"
]);

export function buildEvidenceAdequacyContract(
  input: EvidenceAdequacyContractInput
): EvidenceAdequacyContractV2 {
  const uncertaintyRequirement =
    input.uncertaintyRequirement.mode === "required"
      ? {
        mode: "required" as const,
        allowed_methods: sortedCopy(
          input.uncertaintyRequirement.allowedMethods
        ),
        confidence_level: input.uncertaintyRequirement.confidenceLevel,
        decision_rule: input.uncertaintyRequirement.decisionRule,
        deterministic_exhaustive_rationale: null
      }
      : {
        mode: "none" as const,
        allowed_methods: [],
        confidence_level: null,
        decision_rule: null,
        deterministic_exhaustive_rationale:
          normalizeText(
            input.uncertaintyRequirement
              .deterministicExhaustiveRationale
          )
      };
  const executionBudget = input.executionBudget.applicable
    ? {
      applicable: true,
      numeric_floors: sortedNumericRecord(
        input.executionBudget.numericFloors
      ),
      not_applicable_rationale: null
    }
    : {
      applicable: false,
      numeric_floors: {},
      not_applicable_rationale: normalizeText(
        input.executionBudget.notApplicableRationale
      )
    };
  const payload: Omit<EvidenceAdequacyContractV2, "content_sha256"> = {
    schema: EVIDENCE_ADEQUACY_SCHEMA,
    version: EVIDENCE_ADEQUACY_VERSION,
    kind: "evidence_adequacy_contract",
    primary_comparison_id: normalizeText(input.primaryComparisonId),
    design_source: {
      kind: input.designSource.kind,
      content_sha256: input.designSource.contentSha256
    },
    independent_unit: {
      key: normalizeText(input.independentUnit.key),
      analysis_unit: normalizeText(input.independentUnit.analysisUnit)
    },
    planned_independent_coverage: {
      mode: input.plannedIndependentCoverage.mode,
      target_unique_units:
        input.plannedIndependentCoverage.targetUniqueUnits,
      target_denominator_per_arm:
        input.plannedIndependentCoverage.targetDenominatorPerArm,
      population_manifest_sha256:
        input.plannedIndependentCoverage.populationManifestSha256 || null
    },
    required_contrast: {
      arms: [...input.requiredContrast.arms].map(normalizeText),
      paired: input.requiredContrast.paired,
      required_complete_pairs:
        input.requiredContrast.requiredCompletePairs
    },
    uncertainty_requirement: uncertaintyRequirement,
    effect_resolution: {
      scale: normalizeText(input.effectResolution.scale),
      minimum_resolvable_effect:
        input.effectResolution.minimumResolvableEffect
    },
    execution_budget: executionBudget
  };
  const contract = withContentHash(payload);
  assertValid(
    validateEvidenceAdequacyContract(contract),
    "evidence_adequacy_contract_invalid"
  );
  return contract;
}

export function buildEvidenceAdequacyContractFromEstimatorProtocol(
  input: EvidenceAdequacyEstimatorAdapterInput
): EvidenceAdequacyContractV2 {
  const validation = normalizeEstimatorProtocolDeclaration(input.protocol);
  if (!validation.valid || !validation.protocol) {
    throw new Error(
      `evidence_adequacy_estimator_protocol_invalid:${validation.reasons.join(",")}`
    );
  }
  const protocol = validation.protocol;
  const denominator =
    protocol.pairing.independent_clusters
    * protocol.pairing.observations_per_arm_per_cluster;
  return buildEvidenceAdequacyContract({
    primaryComparisonId: protocol.multiplicity.primary_comparison_id,
    designSource: {
      kind: "estimator_protocol",
      contentSha256: hashCanonical(
        protocol satisfies EstimatorProtocolDeclaration
      )
    },
    independentUnit: {
      key: protocol.units.independent_cluster_key,
      analysisUnit: protocol.units.analysis_unit
    },
    plannedIndependentCoverage: {
      mode: "sampled",
      targetUniqueUnits: protocol.pairing.independent_clusters,
      targetDenominatorPerArm: denominator
    },
    requiredContrast: {
      arms: [...protocol.primary_contrast],
      paired: protocol.pairing.mode === "paired",
      requiredCompletePairs:
        protocol.pairing.mode === "paired" ? denominator : null
    },
    uncertaintyRequirement: {
      mode: "required",
      allowedMethods: [protocol.estimator.covariance],
      confidenceLevel: 1 - protocol.power.alpha,
      decisionRule: "directed_interval_bound_meets_effect_criterion"
    },
    effectResolution: {
      scale: input.effectResolutionScale || protocol.estimand.scale,
      minimumResolvableEffect: protocol.outcome.attainable_resolution
    },
    executionBudget: input.executionBudget || {
      applicable: false,
      notApplicableRationale:
        "The source estimator protocol declares no generic execution budget floor."
    }
  });
}

export function buildEvidenceAdequacyExecutionReceipt(
  input: EvidenceAdequacyExecutionReceiptInput
): EvidenceAdequacyExecutionReceiptV2 {
  const pairCoverage = input.observedPairCoverage || {
    completePairIds: [],
    incompletePairIds: []
  };
  const payload: Omit<
    EvidenceAdequacyExecutionReceiptV2,
    "content_sha256"
  > = {
    schema: EVIDENCE_ADEQUACY_SCHEMA,
    version: EVIDENCE_ADEQUACY_VERSION,
    kind: "evidence_adequacy_execution_receipt",
    contract_sha256: input.contractSha256,
    primary_comparison_id: normalizeText(input.primaryComparisonId),
    observed_population_manifest_sha256:
      input.observedPopulationManifestSha256 || null,
    unique_execution_ids: sortedCopy(input.uniqueExecutionIds),
    observed_independent_unit_ids: sortedCopy(
      input.observedIndependentUnitIds
    ),
    observed_denominator_by_arm: sortedNumericRecord(
      input.observedDenominatorByArm
    ),
    observed_pair_coverage: {
      complete_pair_ids: sortedCopy(pairCoverage.completePairIds),
      incomplete_pair_ids: sortedCopy(pairCoverage.incompletePairIds)
    },
    observed_uncertainty_methods: sortedCopy(
      input.observedUncertaintyMethods || []
    ),
    execution_budget_measurements: sortedNumericRecord(
      input.executionBudgetMeasurements || {}
    ),
    primary_evidence_refs: sortedCopy(input.primaryEvidenceRefs),
    auxiliary_evidence_refs: sortedCopy(input.auxiliaryEvidenceRefs || []),
    deterministic_oracle_evidence_refs: sortedCopy(
      input.deterministicOracleEvidenceRefs || []
    )
  };
  const receipt = withContentHash(payload);
  assertValid(
    validateEvidenceAdequacyExecutionReceipt(receipt),
    "evidence_adequacy_execution_receipt_invalid"
  );
  return receipt;
}

export function buildEvidenceAdequacyExecutionReceiptFromEvidence(
  value: unknown
): EvidenceAdequacyValidation<EvidenceAdequacyExecutionReceiptV2> {
  const root = recordValue(value);
  if (
    !root
    || !hasExactFields(root, EXECUTION_EVIDENCE_FIELDS)
    || root.schema !== EVIDENCE_ADEQUACY_SCHEMA
    || root.version !== EVIDENCE_ADEQUACY_VERSION
    || root.kind !== "evidence_adequacy_execution_evidence"
  ) {
    return invalid("evidence_adequacy_execution_evidence_schema_invalid");
  }
  const payload = {
    ...root,
    kind: "evidence_adequacy_execution_receipt" as const
  } as Omit<EvidenceAdequacyExecutionReceiptV2, "content_sha256">;
  const receipt = withContentHash(payload);
  const validation = validateEvidenceAdequacyExecutionReceipt(receipt);
  return validation.valid
    ? { valid: true, reasons: [], artifact: receipt }
    : {
        valid: false,
        reasons: validation.reasons.map((reason) =>
          `evidence_adequacy_execution_evidence_invalid:${reason}`
        )
      };
}

export function validateEvidenceAdequacyContract(
  value: unknown
): EvidenceAdequacyValidation<EvidenceAdequacyContractV2> {
  const reasons: string[] = [];
  const root = recordValue(value);
  if (!root || !hasExactFields(root, CONTRACT_FIELDS)) {
    return invalid("evidence_adequacy_contract_schema_invalid");
  }
  const designSource = recordValue(root.design_source);
  const independentUnit = recordValue(root.independent_unit);
  const coverage = recordValue(root.planned_independent_coverage);
  const contrast = recordValue(root.required_contrast);
  const uncertainty = recordValue(root.uncertainty_requirement);
  const effectResolution = recordValue(root.effect_resolution);
  const executionBudget = recordValue(root.execution_budget);
  if (
    root.schema !== EVIDENCE_ADEQUACY_SCHEMA
    || root.version !== EVIDENCE_ADEQUACY_VERSION
    || root.kind !== "evidence_adequacy_contract"
    || !designSource
    || !hasExactFields(designSource, DESIGN_SOURCE_FIELDS)
    || !independentUnit
    || !hasExactFields(independentUnit, INDEPENDENT_UNIT_FIELDS)
    || !coverage
    || !hasExactFields(coverage, COVERAGE_FIELDS)
    || !contrast
    || !hasExactFields(contrast, CONTRAST_FIELDS)
    || !uncertainty
    || !hasExactFields(uncertainty, UNCERTAINTY_FIELDS)
    || !effectResolution
    || !hasExactFields(effectResolution, EFFECT_RESOLUTION_FIELDS)
    || !executionBudget
    || !hasExactFields(executionBudget, EXECUTION_BUDGET_FIELDS)
  ) {
    reasons.push("evidence_adequacy_contract_schema_invalid");
  }
  if (
    !textValue(root.primary_comparison_id)
    || !textValue(independentUnit?.key)
    || !textValue(independentUnit?.analysis_unit)
  ) {
    reasons.push("evidence_adequacy_contract_identity_invalid");
  }
  const designSourceKind = designSource?.kind;
  if (
    (designSourceKind !== "estimator_protocol"
      && designSourceKind !== "deterministic_exhaustive_manifest")
    || !sha256Value(designSource?.content_sha256)
  ) {
    reasons.push("evidence_adequacy_contract_design_source_invalid");
  }
  const coverageMode = coverage?.mode;
  const populationManifestSha256 = coverage?.population_manifest_sha256;
  if (
    (coverageMode !== "sampled"
      && coverageMode !== "deterministic_exhaustive")
    || !positiveInteger(coverage?.target_unique_units)
    || !positiveInteger(coverage?.target_denominator_per_arm)
    || (
      coverageMode === "sampled"
        ? populationManifestSha256 !== null
          || designSourceKind !== "estimator_protocol"
        : !sha256Value(populationManifestSha256)
          || designSourceKind !== "deterministic_exhaustive_manifest"
    )
  ) {
    reasons.push("evidence_adequacy_contract_coverage_invalid");
  }
  const arms = uniqueTextArray(contrast?.arms);
  const paired = contrast?.paired;
  const requiredCompletePairs = contrast?.required_complete_pairs;
  if (
    !arms
    || arms.length < 2
    || typeof paired !== "boolean"
    || (
      paired
        ? (
          !positiveInteger(requiredCompletePairs)
          || requiredCompletePairs
            !== coverage?.target_denominator_per_arm
        )
        : requiredCompletePairs !== null
    )
  ) {
    reasons.push("evidence_adequacy_contract_contrast_invalid");
  }
  const uncertaintyMode = uncertainty?.mode;
  const allowedMethods = uniqueTextArray(
    uncertainty?.allowed_methods,
    true
  );
  const confidenceLevel = probabilityValue(
    uncertainty?.confidence_level
  );
  const decisionRule = uncertainty?.decision_rule;
  const deterministicRationale =
    uncertainty?.deterministic_exhaustive_rationale;
  if (
    !allowedMethods
    || (
      uncertaintyMode === "required"
        ? allowedMethods.length === 0
          || confidenceLevel === undefined
          || decisionRule
            !== "directed_interval_bound_meets_effect_criterion"
          || deterministicRationale !== null
        : uncertaintyMode === "none"
          ? (
            allowedMethods.length !== 0
            || uncertainty?.confidence_level !== null
            || decisionRule !== null
            || !textValue(deterministicRationale)
            || coverageMode !== "deterministic_exhaustive"
          )
          : true
    )
  ) {
    reasons.push("evidence_adequacy_contract_uncertainty_invalid");
  }
  if (
    !textValue(effectResolution?.scale)
    || !positiveNumber(effectResolution?.minimum_resolvable_effect)
  ) {
    reasons.push("evidence_adequacy_contract_effect_resolution_invalid");
  }
  const floors = numericRecord(executionBudget?.numeric_floors, {
    allowEmpty: true,
    allowZero: false
  });
  const budgetApplicable = executionBudget?.applicable;
  const notApplicableRationale =
    executionBudget?.not_applicable_rationale;
  if (
    !floors
    || (
      budgetApplicable === true
        ? Object.keys(floors).length === 0
          || notApplicableRationale !== null
        : budgetApplicable === false
          ? Object.keys(floors).length !== 0
            || !textValue(notApplicableRationale)
          : true
    )
  ) {
    reasons.push("evidence_adequacy_contract_execution_budget_invalid");
  }
  checkContentHash(
    root,
    reasons,
    "evidence_adequacy_contract_content_hash_mismatch"
  );
  return validationResult<EvidenceAdequacyContractV2>(
    value,
    reasons
  );
}

export function validateEvidenceAdequacyExecutionReceipt(
  value: unknown
): EvidenceAdequacyValidation<EvidenceAdequacyExecutionReceiptV2> {
  const reasons: string[] = [];
  const root = recordValue(value);
  if (!root || !hasExactFields(root, RECEIPT_FIELDS)) {
    return invalid("evidence_adequacy_execution_receipt_schema_invalid");
  }
  const pairCoverage = recordValue(root.observed_pair_coverage);
  if (
    root.schema !== EVIDENCE_ADEQUACY_SCHEMA
    || root.version !== EVIDENCE_ADEQUACY_VERSION
    || root.kind !== "evidence_adequacy_execution_receipt"
    || !pairCoverage
    || !hasExactFields(pairCoverage, PAIR_COVERAGE_FIELDS)
  ) {
    reasons.push(
      "evidence_adequacy_execution_receipt_schema_invalid"
    );
  }
  if (
    !sha256Value(root.contract_sha256)
    || !textValue(root.primary_comparison_id)
    || (
      root.observed_population_manifest_sha256 !== null
      && !sha256Value(root.observed_population_manifest_sha256)
    )
  ) {
    reasons.push(
      "evidence_adequacy_execution_receipt_binding_invalid"
    );
  }
  const executionIds = textArray(root.unique_execution_ids);
  if (!executionIds || executionIds.length === 0) {
    reasons.push(
      "evidence_adequacy_execution_receipt_execution_ids_invalid"
    );
  } else if (new Set(executionIds).size !== executionIds.length) {
    reasons.push(
      "evidence_adequacy_execution_receipt_execution_ids_duplicate"
    );
  }
  const independentUnitIds = textArray(
    root.observed_independent_unit_ids
  );
  if (!independentUnitIds) {
    reasons.push(
      "evidence_adequacy_execution_receipt_independent_units_invalid"
    );
  } else if (
    new Set(independentUnitIds).size !== independentUnitIds.length
  ) {
    reasons.push(
      "evidence_adequacy_execution_receipt_independent_units_duplicate"
    );
  }
  if (!numericRecord(root.observed_denominator_by_arm, {
    allowEmpty: true,
    allowZero: true,
    integersOnly: true
  })) {
    reasons.push(
      "evidence_adequacy_execution_receipt_denominator_invalid"
    );
  }
  const completePairIds = textArray(
    pairCoverage?.complete_pair_ids
  );
  const incompletePairIds = textArray(
    pairCoverage?.incomplete_pair_ids
  );
  if (
    !completePairIds
    || !incompletePairIds
    || new Set(completePairIds).size !== completePairIds.length
    || new Set(incompletePairIds).size !== incompletePairIds.length
    || completePairIds.some((item) => incompletePairIds.includes(item))
  ) {
    reasons.push(
      "evidence_adequacy_execution_receipt_pair_coverage_invalid"
    );
  }
  const uncertaintyMethods = textArray(
    root.observed_uncertainty_methods
  );
  if (
    !uncertaintyMethods
    || new Set(uncertaintyMethods).size !== uncertaintyMethods.length
  ) {
    reasons.push(
      "evidence_adequacy_execution_receipt_uncertainty_invalid"
    );
  }
  if (!numericRecord(root.execution_budget_measurements, {
    allowEmpty: true,
    allowZero: true
  })) {
    reasons.push(
      "evidence_adequacy_execution_receipt_budget_invalid"
    );
  }
  const primaryEvidenceRefs = textArray(root.primary_evidence_refs);
  const auxiliaryEvidenceRefs = textArray(root.auxiliary_evidence_refs);
  const oracleRefs = textArray(
    root.deterministic_oracle_evidence_refs
  );
  if (
    !primaryEvidenceRefs
    || !auxiliaryEvidenceRefs
    || !oracleRefs
    || new Set(primaryEvidenceRefs).size !== primaryEvidenceRefs.length
    || new Set(auxiliaryEvidenceRefs).size !== auxiliaryEvidenceRefs.length
    || new Set(oracleRefs).size !== oracleRefs.length
    || primaryEvidenceRefs.some((item) => auxiliaryEvidenceRefs.includes(item))
    || oracleRefs.some((item) => !primaryEvidenceRefs.includes(item))
  ) {
    reasons.push(
      "evidence_adequacy_execution_receipt_evidence_refs_invalid"
    );
  }
  checkContentHash(
    root,
    reasons,
    "evidence_adequacy_execution_receipt_content_hash_mismatch"
  );
  return validationResult<EvidenceAdequacyExecutionReceiptV2>(
    value,
    reasons
  );
}

export function assessEvidenceAdequacy(input: {
  contract: EvidenceAdequacyContractV2;
  receipt: EvidenceAdequacyExecutionReceiptV2;
  verifiedEvidenceRefs?: string[];
}): EvidenceAdequacyAssessmentV2 {
  const contractValidation = validateEvidenceAdequacyContract(
    input.contract
  );
  const receiptValidation = validateEvidenceAdequacyExecutionReceipt(
    input.receipt
  );
  const evidenceRefs = validTextArrayOrEmpty(
    input.receipt.primary_evidence_refs
  );
  const checks: EvidenceAdequacyCheckV2[] = [
    check(
      "contract_integrity",
      contractValidation.valid ? "pass" : "fail",
      [],
      contractValidation.reasons
    ),
    check(
      "receipt_integrity",
      receiptValidation.valid ? "pass" : "fail",
      evidenceRefs,
      receiptValidation.reasons
    ),
    assessBinding(input.contract, input.receipt),
    assessExecutionIdentity(input.receipt),
    assessIndependentCoverage(input.contract, input.receipt),
    assessContrastCoverage(input.contract, input.receipt),
    assessDenominatorCoverage(input.contract, input.receipt),
    assessPairCoverage(input.contract, input.receipt),
    assessUncertainty(input.contract, input.receipt),
    assessExecutionBudget(input.contract, input.receipt),
    assessEvidenceLinkage(
      input.contract,
      input.receipt,
      input.verifiedEvidenceRefs
    )
  ];
  const overallStatus = deriveOverallStatus(checks);
  const payload: Omit<EvidenceAdequacyAssessmentV2, "content_sha256"> = {
    schema: EVIDENCE_ADEQUACY_SCHEMA,
    version: EVIDENCE_ADEQUACY_VERSION,
    kind: "evidence_adequacy_assessment",
    contract_sha256: input.contract.content_sha256,
    receipt_sha256: input.receipt.content_sha256,
    primary_comparison_id: input.contract.primary_comparison_id,
    checks,
    overall_status: overallStatus,
    passed: overallStatus === "pass"
  };
  return withContentHash(payload);
}

export function validateEvidenceAdequacyAssessment(
  value: unknown,
  expected?: {
    contract: EvidenceAdequacyContractV2;
    receipt: EvidenceAdequacyExecutionReceiptV2;
    verifiedEvidenceRefs?: string[];
  }
): EvidenceAdequacyValidation<EvidenceAdequacyAssessmentV2> {
  const reasons: string[] = [];
  const root = recordValue(value);
  if (!root || !hasExactFields(root, ASSESSMENT_FIELDS)) {
    return invalid("evidence_adequacy_assessment_schema_invalid");
  }
  if (
    root.schema !== EVIDENCE_ADEQUACY_SCHEMA
    || root.version !== EVIDENCE_ADEQUACY_VERSION
    || root.kind !== "evidence_adequacy_assessment"
    || !sha256Value(root.contract_sha256)
    || !sha256Value(root.receipt_sha256)
    || !textValue(root.primary_comparison_id)
    || typeof root.passed !== "boolean"
    || !CHECK_STATUSES.has(
      root.overall_status as EvidenceAdequacyCheckStatus
    )
  ) {
    reasons.push("evidence_adequacy_assessment_schema_invalid");
  }
  const checks = Array.isArray(root.checks) ? root.checks : [];
  const normalizedChecks: EvidenceAdequacyCheckV2[] = [];
  for (const rawCheck of checks) {
    const item = recordValue(rawCheck);
    if (!item || !hasExactFields(item, CHECK_FIELDS)) {
      reasons.push("evidence_adequacy_assessment_check_invalid");
      continue;
    }
    const checkId = item.check_id as EvidenceAdequacyCheckId;
    const status = item.status as EvidenceAdequacyCheckStatus;
    const evidenceRefs = uniqueTextArray(item.evidence_refs, true);
    const checkReasons = uniqueTextArray(item.reasons, true);
    if (
      !CHECK_IDS.includes(checkId)
      || !CHECK_STATUSES.has(status)
      || !evidenceRefs
      || !checkReasons
    ) {
      reasons.push("evidence_adequacy_assessment_check_invalid");
      continue;
    }
    normalizedChecks.push({
      check_id: checkId,
      status,
      evidence_refs: evidenceRefs,
      reasons: checkReasons
    });
  }
  if (
    normalizedChecks.length !== CHECK_IDS.length
    || new Set(normalizedChecks.map((item) => item.check_id)).size
      !== CHECK_IDS.length
    || CHECK_IDS.some(
      (checkId, index) => normalizedChecks[index]?.check_id !== checkId
    )
  ) {
    reasons.push("evidence_adequacy_assessment_checks_incomplete");
  }
  const derived = deriveOverallStatus(normalizedChecks);
  if (
    root.overall_status !== derived
    || root.passed !== (derived === "pass")
  ) {
    reasons.push("evidence_adequacy_assessment_outcome_invalid");
  }
  checkContentHash(
    root,
    reasons,
    "evidence_adequacy_assessment_content_hash_mismatch"
  );
  if (expected) {
    const rebuilt = assessEvidenceAdequacy(expected);
    if (hashCanonical(value) !== hashCanonical(rebuilt)) {
      reasons.push("evidence_adequacy_assessment_binding_mismatch");
    }
  }
  return validationResult<EvidenceAdequacyAssessmentV2>(
    value,
    reasons
  );
}

function assessBinding(
  contract: EvidenceAdequacyContractV2,
  receipt: EvidenceAdequacyExecutionReceiptV2
): EvidenceAdequacyCheckV2 {
  const reasons: string[] = [];
  if (receipt.contract_sha256 !== contract.content_sha256) {
    reasons.push("evidence_adequacy_contract_hash_mismatch");
  }
  if (
    receipt.primary_comparison_id !== contract.primary_comparison_id
  ) {
    reasons.push("evidence_adequacy_primary_comparison_mismatch");
  }
  return check(
    "binding_integrity",
    reasons.length === 0 ? "pass" : "fail",
    [],
    reasons
  );
}

function assessExecutionIdentity(
  receipt: EvidenceAdequacyExecutionReceiptV2
): EvidenceAdequacyCheckV2 {
  const executionIds = Array.isArray(receipt.unique_execution_ids)
    ? receipt.unique_execution_ids
    : [];
  if (executionIds.length === 0) {
    return check(
      "execution_identity_uniqueness",
      "unknown",
      [],
      ["evidence_adequacy_execution_ids_missing"]
    );
  }
  const duplicate = new Set(executionIds).size !== executionIds.length;
  return check(
    "execution_identity_uniqueness",
    duplicate ? "fail" : "pass",
    [],
    duplicate ? ["evidence_adequacy_execution_ids_duplicate"] : []
  );
}

function assessIndependentCoverage(
  contract: EvidenceAdequacyContractV2,
  receipt: EvidenceAdequacyExecutionReceiptV2
): EvidenceAdequacyCheckV2 {
  const observed = Array.isArray(receipt.observed_independent_unit_ids)
    ? receipt.observed_independent_unit_ids
    : [];
  if (observed.length === 0) {
    return check(
      "independent_coverage",
      "unknown",
      receipt.primary_evidence_refs,
      ["evidence_adequacy_independent_coverage_missing"]
    );
  }
  const target =
    contract.planned_independent_coverage.target_unique_units;
  const exhaustive = contract.planned_independent_coverage.mode
    === "deterministic_exhaustive";
  const expectedPopulationHash =
    contract.planned_independent_coverage.population_manifest_sha256;
  const observedPopulationHash =
    receipt.observed_population_manifest_sha256;
  if (exhaustive && !observedPopulationHash) {
    return check(
      "independent_coverage",
      "unknown",
      receipt.primary_evidence_refs,
      ["evidence_adequacy_population_manifest_missing"]
    );
  }
  if (exhaustive && observedPopulationHash !== expectedPopulationHash) {
    return check(
      "independent_coverage",
      "fail",
      receipt.primary_evidence_refs,
      ["evidence_adequacy_population_manifest_mismatch"]
    );
  }
  const complete = exhaustive
    ? observed.length === target
    : observed.length >= target;
  return check(
    "independent_coverage",
    complete ? "pass" : "fail",
    receipt.primary_evidence_refs,
    complete ? [] : ["evidence_adequacy_independent_coverage_incomplete"]
  );
}

function assessContrastCoverage(
  contract: EvidenceAdequacyContractV2,
  receipt: EvidenceAdequacyExecutionReceiptV2
): EvidenceAdequacyCheckV2 {
  const denominator = recordValue(receipt.observed_denominator_by_arm);
  if (!denominator) {
    return check(
      "contrast_coverage",
      "unknown",
      receipt.primary_evidence_refs,
      ["evidence_adequacy_contrast_coverage_missing"]
    );
  }
  const missing = contract.required_contrast.arms.filter((arm) =>
    !nonNegativeInteger(denominator[arm])
    || Number(denominator[arm]) === 0
  );
  return check(
    "contrast_coverage",
    missing.length === 0 ? "pass" : "fail",
    receipt.primary_evidence_refs,
    missing.map((arm) => `evidence_adequacy_contrast_arm_missing:${arm}`)
  );
}

function assessDenominatorCoverage(
  contract: EvidenceAdequacyContractV2,
  receipt: EvidenceAdequacyExecutionReceiptV2
): EvidenceAdequacyCheckV2 {
  const denominator = recordValue(receipt.observed_denominator_by_arm);
  if (!denominator || Object.keys(denominator).length === 0) {
    return check(
      "denominator_coverage",
      "unknown",
      receipt.primary_evidence_refs,
      ["evidence_adequacy_denominator_missing"]
    );
  }
  const target =
    contract.planned_independent_coverage.target_denominator_per_arm;
  const insufficient = contract.required_contrast.arms.filter((arm) => {
    const observed = nonNegativeInteger(denominator[arm]);
    if (observed === undefined) return true;
    return contract.planned_independent_coverage.mode
      === "deterministic_exhaustive"
      ? observed !== target
      : observed < target;
  });
  return check(
    "denominator_coverage",
    insufficient.length === 0 ? "pass" : "fail",
    receipt.primary_evidence_refs,
    insufficient.map(
      (arm) => `evidence_adequacy_denominator_incomplete:${arm}`
    )
  );
}

function assessPairCoverage(
  contract: EvidenceAdequacyContractV2,
  receipt: EvidenceAdequacyExecutionReceiptV2
): EvidenceAdequacyCheckV2 {
  if (!contract.required_contrast.paired) {
    return check("pair_coverage", "pass", receipt.primary_evidence_refs, []);
  }
  const complete = receipt.observed_pair_coverage?.complete_pair_ids;
  const incomplete = receipt.observed_pair_coverage?.incomplete_pair_ids;
  if (!Array.isArray(complete) || !Array.isArray(incomplete)) {
    return check(
      "pair_coverage",
      "unknown",
      receipt.primary_evidence_refs,
      ["evidence_adequacy_pair_coverage_missing"]
    );
  }
  const required = contract.required_contrast.required_complete_pairs;
  const countComplete = required !== null && (
    contract.planned_independent_coverage.mode
      === "deterministic_exhaustive"
      ? complete.length === required
      : complete.length >= required
  );
  const passed = incomplete.length === 0 && countComplete;
  return check(
    "pair_coverage",
    passed ? "pass" : "fail",
    receipt.primary_evidence_refs,
    passed ? [] : ["evidence_adequacy_pair_coverage_incomplete"]
  );
}

function assessUncertainty(
  contract: EvidenceAdequacyContractV2,
  receipt: EvidenceAdequacyExecutionReceiptV2
): EvidenceAdequacyCheckV2 {
  const requirement = contract.uncertainty_requirement;
  if (requirement.mode === "none") {
    const oracleRefs = receipt.deterministic_oracle_evidence_refs || [];
    return check(
      "uncertainty",
      oracleRefs.length > 0 ? "pass" : "unknown",
      oracleRefs,
      oracleRefs.length > 0
        ? []
        : ["evidence_adequacy_deterministic_oracle_evidence_missing"]
    );
  }
  const observed = receipt.observed_uncertainty_methods || [];
  if (observed.length === 0) {
    return check(
      "uncertainty",
      "unknown",
      receipt.primary_evidence_refs,
      ["evidence_adequacy_uncertainty_evidence_missing"]
    );
  }
  const accepted = observed.some((method) =>
    requirement.allowed_methods.includes(method)
  );
  return check(
    "uncertainty",
    accepted ? "pass" : "fail",
    receipt.primary_evidence_refs,
    accepted ? [] : ["evidence_adequacy_uncertainty_method_not_allowed"]
  );
}

function assessExecutionBudget(
  contract: EvidenceAdequacyContractV2,
  receipt: EvidenceAdequacyExecutionReceiptV2
): EvidenceAdequacyCheckV2 {
  if (!contract.execution_budget.applicable) {
    return check("execution_budget", "pass", receipt.primary_evidence_refs, []);
  }
  const measurements = receipt.execution_budget_measurements || {};
  const unknown: string[] = [];
  const failed: string[] = [];
  Object.entries(contract.execution_budget.numeric_floors).forEach(
    ([key, floor]) => {
      const observed = measurements[key];
      if (observed === undefined) {
        unknown.push(`evidence_adequacy_budget_measurement_missing:${key}`);
      } else if (observed < floor) {
        failed.push(`evidence_adequacy_budget_floor_not_met:${key}`);
      }
    }
  );
  return check(
    "execution_budget",
    failed.length > 0 ? "fail" : unknown.length > 0 ? "unknown" : "pass",
    receipt.primary_evidence_refs,
    [...failed, ...unknown]
  );
}

function assessEvidenceLinkage(
  contract: EvidenceAdequacyContractV2,
  receipt: EvidenceAdequacyExecutionReceiptV2,
  verifiedEvidenceRefs?: string[]
): EvidenceAdequacyCheckV2 {
  const evidenceRefs = receipt.primary_evidence_refs || [];
  if (evidenceRefs.length === 0) {
    return check(
      "evidence_linkage",
      "unknown",
      [],
      ["evidence_adequacy_evidence_refs_missing"]
    );
  }
  const verified = new Set(verifiedEvidenceRefs || evidenceRefs);
  const unverified = evidenceRefs.filter((reference) =>
    !verified.has(reference)
  );
  if (unverified.length > 0) {
    return check(
      "evidence_linkage",
      "fail",
      evidenceRefs,
      unverified.map((reference) =>
        `evidence_adequacy_evidence_ref_unverified:${reference}`
      )
    );
  }
  if (
    contract.planned_independent_coverage.mode
      === "deterministic_exhaustive"
    && receipt.deterministic_oracle_evidence_refs.length === 0
  ) {
    return check(
      "evidence_linkage",
      "unknown",
      evidenceRefs,
      ["evidence_adequacy_deterministic_oracle_evidence_missing"]
    );
  }
  return check("evidence_linkage", "pass", evidenceRefs, []);
}

function check(
  checkId: EvidenceAdequacyCheckId,
  status: EvidenceAdequacyCheckStatus,
  evidenceRefs: string[],
  reasons: string[]
): EvidenceAdequacyCheckV2 {
  return {
    check_id: checkId,
    status,
    evidence_refs: uniqueSorted(evidenceRefs),
    reasons: uniqueSorted(reasons)
  };
}

function deriveOverallStatus(
  checks: EvidenceAdequacyCheckV2[]
): EvidenceAdequacyCheckStatus {
  if (checks.some((item) => item.status === "fail")) return "fail";
  if (
    checks.length !== CHECK_IDS.length
    || checks.some((item) => item.status === "unknown")
  ) {
    return "unknown";
  }
  return "pass";
}

function withContentHash<T extends object>(
  payload: T
): T & { content_sha256: string } {
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function checkContentHash(
  root: Record<string, unknown>,
  reasons: string[],
  reason: string
): void {
  const contentSha256 = sha256Value(root.content_sha256);
  const { content_sha256: _contentSha256, ...payload } = root;
  if (!contentSha256 || hashCanonical(payload) !== contentSha256) {
    reasons.push(reason);
  }
}

function validationResult<T>(
  value: unknown,
  reasons: string[]
): EvidenceAdequacyValidation<T> {
  const uniqueReasons = uniqueSorted(reasons);
  return uniqueReasons.length === 0
    ? { valid: true, reasons: [], artifact: value as T }
    : { valid: false, reasons: uniqueReasons };
}

function invalid<T>(reason: string): EvidenceAdequacyValidation<T> {
  return { valid: false, reasons: [reason] };
}

function assertValid<T>(
  validation: EvidenceAdequacyValidation<T>,
  prefix: string
): void {
  if (!validation.valid) {
    throw new Error(`${prefix}:${validation.reasons.join(",")}`);
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>
): boolean {
  return Object.keys(value).length === fields.size
    && Object.keys(value).every((field) => fields.has(field));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeText(value);
  return normalized.length > 0 && normalized.length <= 512
    ? normalized
    : undefined;
}

function textArray(
  value: unknown,
  allowEmpty = true
): string[] | undefined {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    return undefined;
  }
  const normalized = value.map(textValue);
  return normalized.some((item) => !item)
    ? undefined
    : normalized as string[];
}

function uniqueTextArray(
  value: unknown,
  allowEmpty = false
): string[] | undefined {
  const normalized = textArray(value, allowEmpty);
  return normalized
    && new Set(normalized).size === normalized.length
    ? normalized
    : undefined;
}

function validTextArrayOrEmpty(value: unknown): string[] {
  return uniqueTextArray(value, true) || [];
}

function sortedCopy(values: string[]): string[] {
  return [...values].map(normalizeText).sort((left, right) =>
    left.localeCompare(right)
  );
}

function sortedNumericRecord(
  values: Record<string, number>
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
}

function numericRecord(
  value: unknown,
  options: {
    allowEmpty: boolean;
    allowZero: boolean;
    integersOnly?: boolean;
  }
): Record<string, number> | undefined {
  const record = recordValue(value);
  if (!record || (!options.allowEmpty && Object.keys(record).length === 0)) {
    return undefined;
  }
  for (const [key, item] of Object.entries(record)) {
    if (
      !NUMERIC_KEY_PATTERN.test(key)
      || typeof item !== "number"
      || !Number.isFinite(item)
      || (options.allowZero ? item < 0 : item <= 0)
      || (options.integersOnly && !Number.isInteger(item))
    ) {
      return undefined;
    }
  }
  return record as Record<string, number>;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isInteger(value)
    && value > 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isFinite(value)
    && value > 0
    ? value
    : undefined;
}

function probabilityValue(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isFinite(value)
    && value > 0
    && value < 1
    ? value
    : undefined;
}

function sha256Value(value: unknown): string | undefined {
  return typeof value === "string" && SHA256_PATTERN.test(value)
    ? value
    : undefined;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) =>
    left.localeCompare(right)
  );
}
