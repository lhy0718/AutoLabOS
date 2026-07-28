import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assessEvidenceAdequacy,
  buildEvidenceAdequacyContract,
  buildEvidenceAdequacyExecutionReceipt,
  EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH
} from "../src/core/analysis/evidenceAdequacy.js";
import {
  isEvidenceAdequacyAuthorization,
  reassessEvidenceAdequacyArtifacts,
  resolveVerifiedEvidenceRefs
} from "../src/core/analysis/evidenceAdequacyArtifacts.js";
import { hashCanonical } from "../src/core/canonicalHash.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

describe("evidenceAdequacyArtifacts", () => {
  it("verifies a JSON fragment rather than accepting file existence alone", async () => {
    const root = await makeTemporaryRoot();
    await fs.writeFile(
      path.join(root, "metrics.json"),
      JSON.stringify({ comparisons: [{ delta: 0.2 }] }),
      "utf8"
    );

    const verified = await resolveVerifiedEvidenceRefs({
      roots: [root],
      references: [
        "metrics.json#/comparisons/0/delta",
        "metrics.json#/comparisons/1/delta",
        "metrics.json#/missing",
        "../metrics.json#/comparisons/0/delta"
      ]
    });

    expect(verified).toEqual(["metrics.json#/comparisons/0/delta"]);
  });

  it("issues an in-process authorization only for a passing file-backed reassessment", async () => {
    const root = await makeTemporaryRoot();
    const primaryComparisonId = "comparison_primary";
    const evidenceRef = "metrics.json#/primary/delta";
    const contract = buildEvidenceAdequacyContract({
      primaryComparisonId,
      designSource: {
        kind: "estimator_protocol",
        contentSha256: hashCanonical({ protocol: "paired_estimator" })
      },
      independentUnit: {
        key: "evaluation_unit_id",
        analysisUnit: "paired evaluation unit"
      },
      plannedIndependentCoverage: {
        mode: "sampled",
        targetUniqueUnits: 1,
        targetDenominatorPerArm: 1
      },
      requiredContrast: {
        arms: ["reference", "candidate"],
        paired: true,
        requiredCompletePairs: 1
      },
      uncertaintyRequirement: {
        mode: "required",
        allowedMethods: ["exact_interval"],
        confidenceLevel: 0.95,
        decisionRule: "directed_interval_bound_meets_effect_criterion"
      },
      effectResolution: {
        scale: "raw",
        minimumResolvableEffect: 0.01
      },
      executionBudget: {
        applicable: false,
        notApplicableRationale: "No additional numeric budget floor is required."
      }
    });
    const receipt = buildEvidenceAdequacyExecutionReceipt({
      contractSha256: contract.content_sha256,
      primaryComparisonId,
      uniqueExecutionIds: ["execution_primary"],
      observedIndependentUnitIds: ["unit_primary"],
      observedDenominatorByArm: { reference: 1, candidate: 1 },
      observedPairCoverage: {
        completePairIds: ["unit_primary"],
        incompletePairIds: []
      },
      observedUncertaintyMethods: ["exact_interval"],
      primaryEvidenceRefs: [evidenceRef]
    });
    const assessment = assessEvidenceAdequacy({
      contract,
      receipt,
      verifiedEvidenceRefs: [evidenceRef]
    });
    await Promise.all([
      writeJson(root, EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH, contract),
      writeJson(root, EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH, receipt),
      writeJson(root, EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH, assessment),
      writeJson(root, "metrics.json", { primary: { delta: 0.2 } })
    ]);

    const passing = await reassessEvidenceAdequacyArtifacts({
      runDir: root,
      evidenceRoots: [root],
      expectedPrimaryComparisonId: primaryComparisonId,
      requireStoredAssessment: true
    });
    expect(passing.integrityValid).toBe(true);
    expect(passing.assessment?.passed).toBe(true);
    expect(isEvidenceAdequacyAuthorization(passing.authorization)).toBe(true);

    await writeJson(root, "metrics.json", { primary: {} });
    const missingFragment = await reassessEvidenceAdequacyArtifacts({
      runDir: root,
      evidenceRoots: [root],
      expectedPrimaryComparisonId: primaryComparisonId,
      requireStoredAssessment: true
    });
    expect(missingFragment.assessment?.passed).toBe(false);
    expect(missingFragment.authorization).toBeUndefined();
  });
});

async function makeTemporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-evidence-"));
  temporaryRoots.push(root);
  return root;
}

async function writeJson(
  root: string,
  relativePath: string,
  value: unknown
): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
