import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import {
  assessEvidenceAdequacy,
  buildEvidenceAdequacyContract,
  buildEvidenceAdequacyExecutionReceipt,
  EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH,
  type EvidenceAdequacyAssessmentV2,
  type EvidenceAdequacyContractV2,
  type EvidenceAdequacyExecutionReceiptV2
} from "../../src/core/analysis/evidenceAdequacy.js";
import { hashCanonical } from "../../src/core/canonicalHash.js";

export interface PassingEvidenceAdequacyFixture {
  contract: EvidenceAdequacyContractV2;
  receipt: EvidenceAdequacyExecutionReceiptV2;
  assessment: EvidenceAdequacyAssessmentV2;
}

export function buildPassingEvidenceAdequacyFixture(input: {
  primaryComparisonId: string;
  evidenceRefs?: string[];
  independentUnitCount?: number;
  uncertaintyMethod?: string;
}): PassingEvidenceAdequacyFixture {
  const independentUnitCount = input.independentUnitCount ?? 3;
  const uncertaintyMethod = input.uncertaintyMethod ?? "paired_bootstrap";
  const evidenceRefs = input.evidenceRefs ?? ["metrics.json#/primary_score"];
  const contract = buildEvidenceAdequacyContract({
    primaryComparisonId: input.primaryComparisonId,
    designSource: {
      kind: "estimator_protocol",
      contentSha256: hashCanonical({
        fixture_kind: "declared_comparison_evidence_design",
        primary_comparison_id: input.primaryComparisonId,
        independent_unit_count: independentUnitCount,
        uncertainty_method: uncertaintyMethod
      })
    },
    independentUnit: {
      key: "matched_item_id",
      analysisUnit: "matched candidate-reference outcome"
    },
    plannedIndependentCoverage: {
      mode: "sampled",
      targetUniqueUnits: independentUnitCount,
      targetDenominatorPerArm: independentUnitCount
    },
    requiredContrast: {
      arms: ["candidate", "reference"],
      paired: true,
      requiredCompletePairs: independentUnitCount
    },
    uncertaintyRequirement: {
      mode: "required",
      allowedMethods: [uncertaintyMethod],
      confidenceLevel: 0.95,
      decisionRule: "directed_interval_bound_meets_effect_criterion"
    },
    effectResolution: {
      scale: "raw",
      minimumResolvableEffect: 0.01
    },
    executionBudget: {
      applicable: false,
      notApplicableRationale:
        "The fixture validates evidence lineage rather than an execution-cost threshold."
    }
  });
  const receipt = buildEvidenceAdequacyExecutionReceipt({
    contractSha256: contract.content_sha256,
    primaryComparisonId: contract.primary_comparison_id,
    uniqueExecutionIds: Array.from(
      { length: independentUnitCount * 2 },
      (_, index) => `execution_${index + 1}`
    ),
    observedIndependentUnitIds: Array.from(
      { length: independentUnitCount },
      (_, index) => `matched_item_${index + 1}`
    ),
    observedDenominatorByArm: {
      candidate: independentUnitCount,
      reference: independentUnitCount
    },
    observedPairCoverage: {
      completePairIds: Array.from(
        { length: independentUnitCount },
        (_, index) => `matched_pair_${index + 1}`
      ),
      incompletePairIds: []
    },
    observedUncertaintyMethods: [uncertaintyMethod],
    primaryEvidenceRefs: evidenceRefs
  });
  const assessment = assessEvidenceAdequacy({
    contract,
    receipt,
    verifiedEvidenceRefs: evidenceRefs
  });
  return { contract, receipt, assessment };
}

export async function writePassingEvidenceAdequacyFixture(input: {
  runDir: string;
  primaryComparisonId: string;
  evidenceRefs?: string[];
  independentUnitCount?: number;
  uncertaintyMethod?: string;
}): Promise<PassingEvidenceAdequacyFixture> {
  const fixture = buildPassingEvidenceAdequacyFixture(input);
  const artifacts = [
    [EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH, fixture.contract],
    [EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH, fixture.receipt],
    [EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH, fixture.assessment]
  ] as const;
  await Promise.all(artifacts.map(async ([relativePath, value]) => {
    const artifactPath = path.join(input.runDir, relativePath);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }));
  return fixture;
}
