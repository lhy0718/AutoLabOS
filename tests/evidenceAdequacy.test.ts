import { describe, expect, it } from "vitest";

import { hashCanonical } from "../src/core/canonicalHash.js";
import {
  assessEvidenceAdequacy,
  buildEvidenceAdequacyContract,
  buildEvidenceAdequacyContractFromEstimatorProtocol,
  buildEvidenceAdequacyExecutionReceipt,
  buildEvidenceAdequacyExecutionReceiptFromEvidence,
  validateEvidenceAdequacyAssessment,
  validateEvidenceAdequacyContract,
  validateEvidenceAdequacyExecutionReceipt,
  type EvidenceAdequacyAssessmentV2,
  type EvidenceAdequacyContractV2,
  type EvidenceAdequacyExecutionReceiptV2
} from "../src/core/analysis/evidenceAdequacy.js";
import type {
  EstimatorProtocolDeclaration
} from "../src/core/estimatorProtocol.js";

function estimatorProtocol(): EstimatorProtocolDeclaration {
  return {
    schema_version: 1,
    units: {
      execution_unit: "isolated execution",
      exposure_unit: "assigned arm",
      outcome_unit: "recorded response",
      analysis_unit: "matched observation",
      independent_cluster_key: "source item"
    },
    arms: ["reference", "intervention"],
    primary_contrast: ["reference", "intervention"],
    pairing: {
      mode: "paired",
      independent_clusters: 4,
      observations_per_arm_per_cluster: 1
    },
    outcome: {
      type: "continuous",
      attainable_resolution: 0.25
    },
    estimand: {
      id: "primary_location_shift",
      type: "paired_mean_difference",
      scale: "mean"
    },
    estimator: {
      family: "paired_mean_difference",
      covariance: "cluster_bootstrap",
      separation_policy: "not_applicable"
    },
    power: {
      alpha: 0.05,
      target_power: 0.8,
      minimum_detectable_effect: 0.5,
      assumed_standard_deviation: 1,
      sidedness: "two_sided"
    },
    resampling: {
      minimum_clusters: 4,
      replicates: 1_000
    },
    multiplicity: {
      primary_comparison_id: "primary_location_shift",
      family: ["primary_location_shift"],
      method: "none",
      family_alpha: 0.05
    }
  };
}

function sampledContract(): EvidenceAdequacyContractV2 {
  return buildEvidenceAdequacyContractFromEstimatorProtocol({
    protocol: estimatorProtocol(),
    executionBudget: {
      applicable: true,
      numericFloors: {
        completed_executions: 8
      }
    }
  });
}

function sampledReceipt(
  contract = sampledContract()
): EvidenceAdequacyExecutionReceiptV2 {
  return buildEvidenceAdequacyExecutionReceipt({
    contractSha256: contract.content_sha256,
    primaryComparisonId: contract.primary_comparison_id,
    uniqueExecutionIds: Array.from(
      { length: 8 },
      (_, index) => `execution_${index + 1}`
    ),
    observedIndependentUnitIds: Array.from(
      { length: 4 },
      (_, index) => `source_${index + 1}`
    ),
    observedDenominatorByArm: {
      reference: 4,
      intervention: 4
    },
    observedPairCoverage: {
      completePairIds: Array.from(
        { length: 4 },
        (_, index) => `pair_${index + 1}`
      ),
      incompletePairIds: []
    },
    observedUncertaintyMethods: ["cluster_bootstrap"],
    executionBudgetMeasurements: {
      completed_executions: 8
    },
    primaryEvidenceRefs: [
      "artifact://execution-ledger",
      "artifact://uncertainty-report"
    ]
  });
}

function deterministicContract(): EvidenceAdequacyContractV2 {
  const populationManifestSha256 = deterministicPopulationManifestSha256();
  return buildEvidenceAdequacyContract({
    primaryComparisonId: "primary_exact_difference",
    designSource: {
      kind: "deterministic_exhaustive_manifest",
      contentSha256: populationManifestSha256
    },
    independentUnit: {
      key: "fixture identity",
      analysisUnit: "fixture outcome"
    },
    plannedIndependentCoverage: {
      mode: "deterministic_exhaustive",
      targetUniqueUnits: 3,
      targetDenominatorPerArm: 3,
      populationManifestSha256
    },
    requiredContrast: {
      arms: ["reference", "intervention"],
      paired: false,
      requiredCompletePairs: null
    },
    uncertaintyRequirement: {
      mode: "none",
      deterministicExhaustiveRationale:
        "Every declared fixture is evaluated by a deterministic oracle."
    },
    effectResolution: {
      scale: "proportion",
      minimumResolvableEffect: 1 / 3
    },
    executionBudget: {
      applicable: false,
      notApplicableRationale:
        "The controlled exhaustive evaluation has no iterative execution floor."
    }
  });
}

function deterministicReceipt(
  contract = deterministicContract(),
  oracleRefs = ["artifact://deterministic-oracle"]
): EvidenceAdequacyExecutionReceiptV2 {
  return buildEvidenceAdequacyExecutionReceipt({
    contractSha256: contract.content_sha256,
    primaryComparisonId: contract.primary_comparison_id,
    observedPopulationManifestSha256:
      deterministicPopulationManifestSha256(),
    uniqueExecutionIds: [
      "execution_1",
      "execution_2",
      "execution_3"
    ],
    observedIndependentUnitIds: [
      "fixture_1",
      "fixture_2",
      "fixture_3"
    ],
    observedDenominatorByArm: {
      reference: 3,
      intervention: 3
    },
    primaryEvidenceRefs: [
      "artifact://execution-ledger",
      ...oracleRefs
    ],
    deterministicOracleEvidenceRefs: oracleRefs
  });
}

function deterministicPopulationManifestSha256(): string {
  return hashCanonical({
    independent_unit_ids: ["fixture_1", "fixture_2", "fixture_3"]
  });
}

function rehash<T extends { content_sha256: string }>(
  value: T
): T {
  const { content_sha256: _contentSha256, ...payload } = value;
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  } as T;
}

function checkStatus(
  assessment: EvidenceAdequacyAssessmentV2,
  checkId: EvidenceAdequacyAssessmentV2["checks"][number]["check_id"]
): string | undefined {
  return assessment.checks.find(
    (item) => item.check_id === checkId
  )?.status;
}

describe("evidenceAdequacy", () => {
  it("adapts an estimator protocol into a hash-bound generic contract", () => {
    const protocol = estimatorProtocol();
    const contract = buildEvidenceAdequacyContractFromEstimatorProtocol({
      protocol
    });
    const {
      content_sha256: _contentSha256,
      ...payload
    } = contract;

    expect(contract).toMatchObject({
      schema: "autolabos.evidence_adequacy",
      version: 2,
      kind: "evidence_adequacy_contract",
      primary_comparison_id: "primary_location_shift",
      independent_unit: {
        key: "source item",
        analysis_unit: "matched observation"
      },
      planned_independent_coverage: {
        mode: "sampled",
        target_unique_units: 4,
        target_denominator_per_arm: 4
      },
      required_contrast: {
        arms: ["reference", "intervention"],
        paired: true,
        required_complete_pairs: 4
      },
      uncertainty_requirement: {
        mode: "required",
        allowed_methods: ["cluster_bootstrap"],
        confidence_level: 0.95,
        decision_rule:
          "directed_interval_bound_meets_effect_criterion"
      },
      design_source: {
        kind: "estimator_protocol",
        content_sha256: hashCanonical(protocol)
      }
    });
    expect(contract.content_sha256).toBe(hashCanonical(payload));
    expect(validateEvidenceAdequacyContract(contract)).toMatchObject({
      valid: true,
      reasons: []
    });
  });

  it("rejects a rehashed version-one contract instead of silently adapting it", () => {
    const current = sampledContract();
    const { content_sha256: _contentSha256, ...payload } = current;
    const versionOnePayload = { ...payload, version: 1 };
    const versionOneArtifact = {
      ...versionOnePayload,
      content_sha256: hashCanonical(versionOnePayload)
    };

    expect(validateEvidenceAdequacyContract(versionOneArtifact)).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "evidence_adequacy_contract_schema_invalid"
      ])
    });
  });

  it("binds effect resolution to the governed metric scale when supplied", () => {
    const contract = buildEvidenceAdequacyContractFromEstimatorProtocol({
      protocol: estimatorProtocol(),
      effectResolutionScale: "raw"
    });

    expect(contract.effect_resolution).toEqual({
      scale: "raw",
      minimum_resolvable_effect: 0.25
    });
  });

  it("passes a complete sampled receipt and validates the assessment", () => {
    const contract = sampledContract();
    const receipt = sampledReceipt(contract);
    const assessment = assessEvidenceAdequacy({ contract, receipt });

    expect(validateEvidenceAdequacyExecutionReceipt(receipt).valid)
      .toBe(true);
    expect(assessment.overall_status).toBe("pass");
    expect(assessment.passed).toBe(true);
    expect(assessment.checks.every((item) => item.status === "pass"))
      .toBe(true);
    expect(
      validateEvidenceAdequacyAssessment(
        assessment,
        { contract, receipt }
      )
    ).toMatchObject({ valid: true, reasons: [] });
  });

  it("issues a canonical receipt from raw execution evidence without trusting a runner verdict", () => {
    const contract = sampledContract();
    const expected = sampledReceipt(contract);
    const {
      content_sha256: _contentSha256,
      kind: _kind,
      ...evidenceFields
    } = expected;
    const issued = buildEvidenceAdequacyExecutionReceiptFromEvidence({
      ...evidenceFields,
      kind: "evidence_adequacy_execution_evidence"
    });
    const forgedVerdict = buildEvidenceAdequacyExecutionReceiptFromEvidence({
      ...evidenceFields,
      kind: "evidence_adequacy_execution_evidence",
      passed: true
    });

    expect(issued).toMatchObject({
      valid: true,
      artifact: expected
    });
    expect(forgedVerdict).toMatchObject({
      valid: false,
      reasons: ["evidence_adequacy_execution_evidence_schema_invalid"]
    });
  });

  it("blocks duplicate execution IDs even when the receipt is rehashed", () => {
    const contract = sampledContract();
    const receipt = rehash({
      ...sampledReceipt(contract),
      unique_execution_ids: [
        "execution_1",
        "execution_1",
        "execution_2"
      ]
    });
    const assessment = assessEvidenceAdequacy({ contract, receipt });

    expect(
      validateEvidenceAdequacyExecutionReceipt(receipt).reasons
    ).toContain(
      "evidence_adequacy_execution_receipt_execution_ids_duplicate"
    );
    expect(checkStatus(
      assessment,
      "execution_identity_uniqueness"
    )).toBe("fail");
    expect(assessment.overall_status).toBe("fail");
  });

  it("blocks contract hash and primary comparison mismatches", () => {
    const contract = sampledContract();
    const receipt = rehash({
      ...sampledReceipt(contract),
      contract_sha256: "b".repeat(64),
      primary_comparison_id: "different_primary_comparison"
    });
    const assessment = assessEvidenceAdequacy({ contract, receipt });
    const binding = assessment.checks.find(
      (item) => item.check_id === "binding_integrity"
    );

    expect(validateEvidenceAdequacyExecutionReceipt(receipt).valid)
      .toBe(true);
    expect(binding).toMatchObject({
      status: "fail",
      reasons: expect.arrayContaining([
        "evidence_adequacy_contract_hash_mismatch",
        "evidence_adequacy_primary_comparison_mismatch"
      ])
    });
    expect(assessment.passed).toBe(false);
  });

  it("blocks missing contrast arms and incomplete pairs", () => {
    const contract = sampledContract();
    const receipt = buildEvidenceAdequacyExecutionReceipt({
      contractSha256: contract.content_sha256,
      primaryComparisonId: contract.primary_comparison_id,
      uniqueExecutionIds: ["execution_1", "execution_2"],
      observedIndependentUnitIds: [
        "source_1",
        "source_2",
        "source_3",
        "source_4"
      ],
      observedDenominatorByArm: {
        reference: 4
      },
      observedPairCoverage: {
        completePairIds: ["pair_1", "pair_2", "pair_3"],
        incompletePairIds: ["pair_4"]
      },
      observedUncertaintyMethods: ["cluster_bootstrap"],
      executionBudgetMeasurements: {
        completed_executions: 8
      },
      primaryEvidenceRefs: ["artifact://execution-ledger"]
    });
    const assessment = assessEvidenceAdequacy({ contract, receipt });

    expect(checkStatus(assessment, "contrast_coverage")).toBe("fail");
    expect(checkStatus(assessment, "denominator_coverage")).toBe("fail");
    expect(checkStatus(assessment, "pair_coverage")).toBe("fail");
    expect(assessment.overall_status).toBe("fail");
  });

  it("treats missing applicable budget measurements as unknown, not pass", () => {
    const contract = sampledContract();
    const receipt = buildEvidenceAdequacyExecutionReceipt({
      ...{
        contractSha256: contract.content_sha256,
        primaryComparisonId: contract.primary_comparison_id,
        uniqueExecutionIds: Array.from(
          { length: 8 },
          (_, index) => `execution_${index + 1}`
        ),
        observedIndependentUnitIds: Array.from(
          { length: 4 },
          (_, index) => `source_${index + 1}`
        ),
        observedDenominatorByArm: {
          reference: 4,
          intervention: 4
        },
        observedPairCoverage: {
          completePairIds: ["pair_1", "pair_2", "pair_3", "pair_4"],
          incompletePairIds: []
        },
        observedUncertaintyMethods: ["cluster_bootstrap"],
        primaryEvidenceRefs: ["artifact://execution-ledger"]
      }
    });
    const assessment = assessEvidenceAdequacy({ contract, receipt });

    expect(checkStatus(assessment, "execution_budget")).toBe("unknown");
    expect(assessment.overall_status).toBe("unknown");
    expect(assessment.passed).toBe(false);
  });

  it("allows deterministic exhaustive evidence without seed or optimizer fields", () => {
    const contract = deterministicContract();
    const receipt = deterministicReceipt(contract);
    const assessment = assessEvidenceAdequacy({ contract, receipt });

    expect(Object.keys(contract.execution_budget.numeric_floors))
      .not.toContain("optimizer_steps");
    expect(Object.keys(receipt.execution_budget_measurements))
      .not.toContain("seed_count");
    expect(checkStatus(assessment, "uncertainty")).toBe("pass");
    expect(checkStatus(assessment, "independent_coverage")).toBe("pass");
    expect(assessment.overall_status).toBe("pass");
  });

  it("requires exact exhaustive coverage and deterministic oracle evidence", () => {
    const contract = deterministicContract();
    const withoutOracle = deterministicReceipt(contract, []);
    const partial = buildEvidenceAdequacyExecutionReceipt({
      contractSha256: contract.content_sha256,
      primaryComparisonId: contract.primary_comparison_id,
      observedPopulationManifestSha256:
        deterministicPopulationManifestSha256(),
      uniqueExecutionIds: ["execution_1", "execution_2"],
      observedIndependentUnitIds: ["fixture_1", "fixture_2"],
      observedDenominatorByArm: {
        reference: 2,
        intervention: 2
      },
      primaryEvidenceRefs: ["artifact://execution-ledger"]
    });
    const unknownAssessment = assessEvidenceAdequacy({
      contract,
      receipt: withoutOracle
    });
    const failedAssessment = assessEvidenceAdequacy({
      contract,
      receipt: partial
    });

    expect(checkStatus(unknownAssessment, "uncertainty"))
      .toBe("unknown");
    expect(unknownAssessment.passed).toBe(false);
    expect(checkStatus(failedAssessment, "independent_coverage"))
      .toBe("fail");
    expect(checkStatus(failedAssessment, "denominator_coverage"))
      .toBe("fail");
    expect(failedAssessment.overall_status).toBe("fail");
  });

  it("blocks exhaustive population substitution even when counts match", () => {
    const contract = deterministicContract();
    const receipt = buildEvidenceAdequacyExecutionReceipt({
      contractSha256: contract.content_sha256,
      primaryComparisonId: contract.primary_comparison_id,
      observedPopulationManifestSha256: hashCanonical({
        independent_unit_ids: ["substitute_1", "substitute_2", "substitute_3"]
      }),
      uniqueExecutionIds: ["execution_1", "execution_2", "execution_3"],
      observedIndependentUnitIds: ["substitute_1", "substitute_2", "substitute_3"],
      observedDenominatorByArm: {
        reference: 3,
        intervention: 3
      },
      primaryEvidenceRefs: [
        "artifact://execution-ledger",
        "artifact://deterministic-oracle"
      ],
      deterministicOracleEvidenceRefs: ["artifact://deterministic-oracle"]
    });
    const assessment = assessEvidenceAdequacy({ contract, receipt });

    expect(checkStatus(assessment, "independent_coverage")).toBe("fail");
    expect(
      assessment.checks.find(
        (item) => item.check_id === "independent_coverage"
      )?.reasons
    ).toContain("evidence_adequacy_population_manifest_mismatch");
  });

  it("does not let auxiliary artifacts substitute for primary evidence", () => {
    const contract = sampledContract();
    const complete = sampledReceipt(contract);
    const receipt = buildEvidenceAdequacyExecutionReceipt({
      contractSha256: complete.contract_sha256,
      primaryComparisonId: complete.primary_comparison_id,
      uniqueExecutionIds: complete.unique_execution_ids,
      observedIndependentUnitIds: complete.observed_independent_unit_ids,
      observedDenominatorByArm: complete.observed_denominator_by_arm,
      observedPairCoverage: {
        completePairIds: complete.observed_pair_coverage.complete_pair_ids,
        incompletePairIds: complete.observed_pair_coverage.incomplete_pair_ids
      },
      observedUncertaintyMethods: complete.observed_uncertainty_methods,
      executionBudgetMeasurements: complete.execution_budget_measurements,
      primaryEvidenceRefs: [],
      auxiliaryEvidenceRefs: ["artifact://diagnostic-log"]
    });
    const assessment = assessEvidenceAdequacy({ contract, receipt });

    expect(checkStatus(assessment, "evidence_linkage")).toBe("unknown");
    expect(assessment.passed).toBe(false);
  });

  it("rejects content tampering and outcome-direction fields", () => {
    const contract = sampledContract();
    const receipt = sampledReceipt(contract);
    const tamperedContract = {
      ...contract,
      planned_independent_coverage: {
        ...contract.planned_independent_coverage,
        target_unique_units: 1
      }
    };
    const {
      content_sha256: _contentSha256,
      ...receiptPayload
    } = receipt;
    const receiptWithOutcome = {
      ...receiptPayload,
      outcome_direction: "positive",
      content_sha256: hashCanonical({
        ...receiptPayload,
        outcome_direction: "positive"
      })
    };

    expect(validateEvidenceAdequacyContract(tamperedContract).reasons)
      .toContain(
        "evidence_adequacy_contract_content_hash_mismatch"
      );
    expect(
      validateEvidenceAdequacyExecutionReceipt(receiptWithOutcome)
        .reasons
    ).toContain(
      "evidence_adequacy_execution_receipt_schema_invalid"
    );
  });

  it("detects a rehashed assessment rewrite when bound artifacts are supplied", () => {
    const contract = sampledContract();
    const receipt = sampledReceipt(contract);
    const assessment = assessEvidenceAdequacy({ contract, receipt });
    const rewritten = rehash({
      ...assessment,
      checks: assessment.checks.map((item) =>
        item.check_id === "independent_coverage"
          ? {
            ...item,
            status: "fail" as const,
            reasons: ["manually_rewritten"]
          }
          : item
      ),
      overall_status: "fail",
      passed: false
    });

    expect(validateEvidenceAdequacyAssessment(rewritten).valid)
      .toBe(true);
    expect(
      validateEvidenceAdequacyAssessment(
        rewritten,
        { contract, receipt }
      ).reasons
    ).toContain("evidence_adequacy_assessment_binding_mismatch");
  });
});
