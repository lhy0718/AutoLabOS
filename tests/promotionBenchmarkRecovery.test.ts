import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  hashPromotionBenchmarkSuiteSnapshot,
  hashPromotionArtifactTree,
  type PromotionBenchmarkCaseManifest,
  type PromotionBenchmarkPrediction
} from "../src/core/benchmark/promotionBenchmark.js";
import { evaluatePromotionBenchmarkRecovery } from "../src/core/benchmark/promotionBenchmarkRecovery.js";
import {
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
  REQUIRED_CONFIRMATORY_MUTATION_FAMILIES
} from "../src/core/benchmark/promotionBenchmarkConfirmatoryContract.js";
import { PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION } from "../src/core/benchmark/promotionBenchmarkSystems.js";
import { promotionVariantDefinitions } from "../src/core/benchmark/promotionBenchmarkVariants.js";
import {
  PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT,
  PROMOTION_CONFIRMATORY_UPSTREAM_HANDOFF_ROOT,
  PROMOTION_CONFIRMATORY_UPSTREAM_INTAKE_REF
} from "../src/core/benchmark/promotionBenchmarkConfirmatoryFreeze.js";
import { PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST } from "../src/core/benchmark/promotionBenchmarkTrialCandidateHandoff.js";
import {
  PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS,
  PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT,
  PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateReview.js";
import {
  PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateReviewCampaignReturn.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion benchmark recovery", () => {
  it("recomputes fault recovery and clean-control regression from hash-bound suites", async () => {
    const fixture = await createRecoveryFixture();
    const result = await evaluatePromotionBenchmarkRecovery({
      cwd: fixture.workspace,
      manifestPath: "recovery-manifest.json",
      outDir: "recovery-output"
    });

    expect(result.report.issues).toEqual([]);
    expect(result.report).toMatchObject({
      passed: true,
      original_base_bundle_count: MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
      clean_control_base_bundle_count: MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
      fault_repair_pair_count: 9,
      successful_recovery_count: 9,
      successful_recovery_rate: 1,
      clean_control_pair_count: MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
      clean_control_regression_count: 0,
      clean_control_regression_rate: 0,
      missing_fault_families: []
    });
  });

  it("fails closed when one fault family has no post-repair rerun", async () => {
    const fixture = await createRecoveryFixture(true);
    const result = await evaluatePromotionBenchmarkRecovery({
      cwd: fixture.workspace,
      manifestPath: "recovery-manifest.json",
      outDir: "recovery-output"
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.missing_fault_families).toHaveLength(1);
    expect(result.report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "fault_family_recovery_missing" })
    ]));
  });
});

async function createRecoveryFixture(omitLastFault = false): Promise<{ workspace: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-recovery-"));
  tempDirs.push(workspace);
  const originalCases: PromotionBenchmarkCaseManifest[] = [];
  const repairedCases: PromotionBenchmarkCaseManifest[] = [];
  const originalPredictions: PromotionBenchmarkPrediction[] = [];
  const repairedPredictions: PromotionBenchmarkPrediction[] = [];
  const pairs: Array<Record<string, unknown>> = [];
  const variants = promotionVariantDefinitions();

  for (let baseIndex = 0; baseIndex < 3; baseIndex += 1) {
    const baseId = "base-" + baseIndex;
    const sourceSha = sha256("source-" + baseIndex);
    const familySha = sha256("family-" + baseIndex);
    const operatorSha = sha256("operator-" + baseIndex);
    const cleanSource = await writeCaseArtifact(
      workspace,
      "original",
      "source-clean-" + baseIndex,
      { base_id: baseId, state: "clean" }
    );
    const cleanRepaired = await writeCaseArtifact(
      workspace,
      "repaired",
      "repaired-clean-" + baseIndex,
      { base_id: baseId, state: "clean" }
    );
    const originalClean = makeCase({
      caseId: "source-clean-" + baseIndex,
      baseId,
      artifactRoot: cleanSource.root,
      artifactSha: cleanSource.sha,
      sourceSha,
      familySha,
      operatorSha,
      gold: variants[0].gold
    });
    const repairedClean = makeCase({
      caseId: "repaired-clean-" + baseIndex,
      baseId,
      artifactRoot: cleanRepaired.root,
      artifactSha: cleanRepaired.sha,
      sourceSha,
      familySha,
      operatorSha,
      gold: variants[0].gold
    });
    originalCases.push(originalClean);
    repairedCases.push(repairedClean);
    originalPredictions.push(predictionFromGold(originalClean, "original-trial"));
    repairedPredictions.push(predictionFromGold(repairedClean, "repaired-trial"));
    pairs.push({
      pair_kind: "clean_control",
      source_case_id: originalClean.case_id,
      source_trial_id: "original-trial",
      repaired_case_id: repairedClean.case_id,
      repaired_trial_id: "repaired-trial"
    });
  }

  for (const [faultIndex, variant] of variants.slice(1).entries()) {
    const baseIndex = faultIndex % 3;
    const baseId = "base-" + baseIndex;
    const sourceSha = sha256("source-" + baseIndex);
    const familySha = sha256("family-" + baseIndex);
    const operatorSha = sha256("operator-" + baseIndex);
    const mutationFamily = variant.mutation_family as string;
    const sourceId = "source-fault-" + faultIndex;
    const repairedId = "repaired-fault-" + faultIndex;
    const sourceArtifact = await writeCaseArtifact(
      workspace,
      "original",
      sourceId,
      { base_id: baseId, state: "fault", mutation_family: mutationFamily }
    );
    const repairedArtifact = await writeCaseArtifact(
      workspace,
      "repaired",
      repairedId,
      { base_id: baseId, state: "repaired", repaired_family: mutationFamily }
    );
    const originalCase = makeCase({
      caseId: sourceId,
      baseId,
      artifactRoot: sourceArtifact.root,
      artifactSha: sourceArtifact.sha,
      sourceSha,
      familySha,
      operatorSha,
      mutationFamily,
      gold: variant.gold
    });
    const repairedCase = makeCase({
      caseId: repairedId,
      baseId,
      artifactRoot: repairedArtifact.root,
      artifactSha: repairedArtifact.sha,
      sourceSha,
      familySha,
      operatorSha,
      gold: variants[0].gold
    });
    originalCases.push(originalCase);
    repairedCases.push(repairedCase);
    originalPredictions.push(predictionFromGold(originalCase, "original-trial"));
    repairedPredictions.push(predictionFromGold(repairedCase, "repaired-trial"));
    if (!omitLastFault || faultIndex < variants.length - 2) {
      pairs.push({
        pair_kind: "fault_repair",
        source_case_id: originalCase.case_id,
        source_trial_id: "original-trial",
        repaired_case_id: repairedCase.case_id,
        repaired_trial_id: "repaired-trial",
        mutation_family: mutationFamily,
        declared_repair_owner: originalCase.gold.repair_owners[0]
      });
    }
  }

  await completePaperScaleOriginalFixture({
    workspace,
    originalCases,
    repairedCases,
    originalPredictions,
    repairedPredictions,
    pairs,
    variants
  });
  await writeSuite(workspace, "original", "confirmatory-study", originalCases, true);
  await writeSuite(workspace, "repaired", "confirmatory-study-repaired", repairedCases, false);
  await writePredictions(path.join(workspace, "original-predictions.jsonl"), originalPredictions);
  await writePredictions(path.join(workspace, "repaired-predictions.jsonl"), repairedPredictions);
  await writeSystemRunManifest({
    workspace,
    fileName: "original-system-run-manifest.json",
    suiteId: "confirmatory-study",
    suitePath: "original/suite.json",
    predictionsPath: "original-predictions.jsonl",
    trialId: "original-trial",
    caseCount: originalCases.length
  });
  await writeSystemRunManifest({
    workspace,
    fileName: "repaired-system-run-manifest.json",
    suiteId: "confirmatory-study-repaired",
    suitePath: "repaired/suite.json",
    predictionsPath: "repaired-predictions.jsonl",
    trialId: "repaired-trial",
    caseCount: repairedCases.length
  });
  await writeFile(path.join(workspace, "recovery-manifest.json"), JSON.stringify({
    schema_version: "1.0",
    study_id: "confirmatory-study",
    original_suite_path: "original/suite.json",
    repaired_suite_path: "repaired/suite.json",
    original_predictions_path: "original-predictions.jsonl",
    repaired_predictions_path: "repaired-predictions.jsonl",
    original_system_run_manifest_path: "original-system-run-manifest.json",
    repaired_system_run_manifest_path: "repaired-system-run-manifest.json",
    system_id: "artifact-audit",
    pairs
  }));
  return { workspace };
}

async function completePaperScaleOriginalFixture(input: {
  workspace: string;
  originalCases: PromotionBenchmarkCaseManifest[];
  repairedCases: PromotionBenchmarkCaseManifest[];
  originalPredictions: PromotionBenchmarkPrediction[];
  repairedPredictions: PromotionBenchmarkPrediction[];
  pairs: Array<Record<string, unknown>>;
  variants: ReturnType<typeof promotionVariantDefinitions>;
}
): Promise<void> {
  for (
    let baseIndex = 0;
    baseIndex < MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES;
    baseIndex += 1
  ) {
    const baseId = "base-" + baseIndex;
    const sourceSha = sha256("source-" + baseIndex);
    const familySha = sha256("family-" + baseIndex);
    const operatorSha = sha256("operator-" + baseIndex);
    const existing = input.originalCases.filter((benchmarkCase) => benchmarkCase.base_bundle_id === baseId);
    const artifact = await writeCaseArtifact(
      input.workspace,
      "original",
      "paper-scale-base-" + baseIndex,
      { base_id: baseId, state: "frozen-source" }
    );
    if (!existing.some((benchmarkCase) => !benchmarkCase.mutation_family)) {
      const clean = makeCase({
        caseId: "paper-scale-clean-" + baseIndex,
        baseId,
        artifactRoot: artifact.root,
        artifactSha: artifact.sha,
        sourceSha,
        familySha,
        operatorSha,
        gold: input.variants[0].gold
      });
      input.originalCases.push(clean);
      input.originalPredictions.push(predictionFromGold(clean, "original-trial"));
    }
    for (const family of REQUIRED_CONFIRMATORY_MUTATION_FAMILIES) {
      if (existing.some((benchmarkCase) => benchmarkCase.mutation_family === family)) continue;
      const variant = input.variants.find((item) => item.mutation_family === family);
      if (!variant) throw new Error("Missing recovery fixture variant: " + family);
      const fault = makeCase({
        caseId: `paper-scale-fault-${baseIndex}-${family}`,
        baseId,
        artifactRoot: artifact.root,
        artifactSha: artifact.sha,
        sourceSha,
        familySha,
        operatorSha,
        mutationFamily: family,
        gold: variant.gold
      });
      input.originalCases.push(fault);
      input.originalPredictions.push(predictionFromGold(fault, "original-trial"));
    }
    if (!input.repairedCases.some((benchmarkCase) => benchmarkCase.base_bundle_id === baseId
      && !benchmarkCase.mutation_family)) {
      const repairedArtifact = await writeCaseArtifact(
        input.workspace,
        "repaired",
        "paper-scale-repaired-clean-" + baseIndex,
        { base_id: baseId, state: "frozen-source" }
      );
      const repairedClean = makeCase({
        caseId: "paper-scale-repaired-clean-" + baseIndex,
        baseId,
        artifactRoot: repairedArtifact.root,
        artifactSha: repairedArtifact.sha,
        sourceSha,
        familySha,
        operatorSha,
        gold: input.variants[0].gold
      });
      input.repairedCases.push(repairedClean);
      input.repairedPredictions.push(predictionFromGold(repairedClean, "repaired-trial"));
      const originalClean = input.originalCases.find((benchmarkCase) =>
        benchmarkCase.base_bundle_id === baseId && !benchmarkCase.mutation_family);
      if (!originalClean) throw new Error("Missing paper-scale original clean control.");
      input.pairs.push({
        pair_kind: "clean_control",
        source_case_id: originalClean.case_id,
        source_trial_id: "original-trial",
        repaired_case_id: repairedClean.case_id,
        repaired_trial_id: "repaired-trial"
      });
    }
  }
}

async function writeCaseArtifact(
  workspace: string,
  suiteRoot: string,
  caseId: string,
  content: Record<string, unknown>
): Promise<{ root: string; sha: string }> {
  const relativeRoot = "artifacts/" + caseId;
  const absoluteRoot = path.join(workspace, suiteRoot, relativeRoot);
  await mkdir(absoluteRoot, { recursive: true });
  await writeFile(path.join(absoluteRoot, "state.json"), JSON.stringify(content));
  return { root: "../" + relativeRoot, sha: await hashPromotionArtifactTree(absoluteRoot) };
}

function makeCase(input: {
  caseId: string;
  baseId: string;
  artifactRoot: string;
  artifactSha: string;
  sourceSha: string;
  familySha: string;
  operatorSha: string;
  mutationFamily?: string;
  gold: PromotionBenchmarkCaseManifest["gold"];
}): PromotionBenchmarkCaseManifest {
  return {
    schema_version: "1.0",
    case_id: input.caseId,
    base_bundle_id: input.baseId,
    split: "test",
    artifact_root: input.artifactRoot,
    source_sha256: input.sourceSha,
    source_family_id_sha256: input.familySha,
    operator_group_id_sha256: input.operatorSha,
    artifact_sha256: input.artifactSha,
    ...(input.mutationFamily ? { mutation_family: input.mutationFamily } : {}),
    gold: input.gold
  };
}

async function writeSuite(
  workspace: string,
  suiteRoot: string,
  suiteId: string,
  cases: PromotionBenchmarkCaseManifest[],
  paperClaimEligible: boolean
): Promise<void> {
  const caseDir = path.join(workspace, suiteRoot, "cases");
  await mkdir(caseDir, { recursive: true });
  const caseRefs: string[] = [];
  const operationByFamily = new Map(promotionVariantDefinitions().flatMap((variant) =>
    variant.mutation_family ? [[variant.mutation_family, variant.operations] as const] : []));
  for (const benchmarkCase of cases) {
    const ref = "cases/" + benchmarkCase.case_id + ".json";
    caseRefs.push(ref);
    const caseForWrite = paperClaimEligible
      ? {
          ...benchmarkCase,
          mutation_manifest: "../provenance/" + benchmarkCase.case_id + ".json"
        }
      : benchmarkCase;
    if (paperClaimEligible) {
      const operations = benchmarkCase.mutation_family
        ? operationByFamily.get(benchmarkCase.mutation_family) || []
        : [];
      const mutationPath = path.join(
        workspace,
        suiteRoot,
        "provenance",
        benchmarkCase.case_id + ".json"
      );
      await mkdir(path.dirname(mutationPath), { recursive: true });
      await writeFile(mutationPath, JSON.stringify({
        schema_version: "1.0",
        case_id: benchmarkCase.case_id,
        base_bundle_id: benchmarkCase.base_bundle_id,
        source_sha256: benchmarkCase.source_sha256,
        source_family_id_sha256: benchmarkCase.source_family_id_sha256,
        operator_group_id_sha256: benchmarkCase.operator_group_id_sha256,
        artifact_sha256: benchmarkCase.artifact_sha256,
        ...(benchmarkCase.mutation_family ? { mutation_family: benchmarkCase.mutation_family } : {}),
        operations: operations.map((operation, index) => ({
          index: index + 1,
          operation,
          before_sha256: null,
          after_sha256: null
        }))
      }));
    }
    await writeFile(path.join(workspace, suiteRoot, ref), JSON.stringify(caseForWrite));
  }
  const adjudicationRoot = path.join(workspace, suiteRoot, "adjudication");
  await mkdir(adjudicationRoot, { recursive: true });
  const privateMapText = '{"schema_version":"1.0","entries":[]}\n';
  const annotationOneText = '{"schema_version":"1.0","adjudicator_id":"reviewer-one"}\n';
  const annotationTwoText = '{"schema_version":"1.0","adjudicator_id":"reviewer-two"}\n';
  const mutationAuditText = '{"schema_version":"1.0","status":"double_verified"}\n';
  const labelsText = cases.map((benchmarkCase) => JSON.stringify({
    schema_version: "1.0",
    case_id: benchmarkCase.case_id,
    ...benchmarkCase.gold
  })).join("\n") + "\n";
  await writeFile(path.join(adjudicationRoot, "private-annotation-map.json"), privateMapText);
  await writeFile(path.join(adjudicationRoot, "initial-annotation-1.jsonl"), annotationOneText);
  await writeFile(path.join(adjudicationRoot, "initial-annotation-2.jsonl"), annotationTwoText);
  await writeFile(path.join(adjudicationRoot, "mutation-audit-report.json"), mutationAuditText);
  await writeFile(path.join(adjudicationRoot, "adjudicated-labels.jsonl"), labelsText);
  const confirmatoryFreezeProvenance = paperClaimEligible
    ? await writeConfirmatoryFreezeEvidence(workspace, suiteRoot, suiteId, cases)
    : null;
  const sourceSuiteSnapshot = paperClaimEligible && confirmatoryFreezeProvenance
    ? await writeSourceSuiteSnapshotEvidence({
        workspace,
        suiteRoot,
        suiteId,
        cases,
        caseRefs,
        confirmatoryFreezeProvenance
      })
    : null;
  await writeFile(path.join(workspace, suiteRoot, "suite.json"), JSON.stringify({
    schema_version: "1.0",
    suite_id: suiteId,
    evidence_class: "external_real_run",
    paper_claim_eligible: paperClaimEligible,
    adjudication_status: "double_adjudicated",
    mutation_isolation_status: "double_verified",
    execution_provenance_status: "artifact_verified",
    source_diversity_status: "declared_stratified",
    ...(confirmatoryFreezeProvenance
      ? { confirmatory_freeze_provenance: confirmatoryFreezeProvenance }
      : {}),
    adjudication_provenance: {
      schema_version: "1.0",
      method: "independent_double_adjudication",
      source_suite_snapshot_sha256: sourceSuiteSnapshot?.snapshotSha256 || "1".repeat(64),
      ...(sourceSuiteSnapshot ? { source_suite_evidence: sourceSuiteSnapshot.evidence } : {}),
      private_annotation_map_ref: "adjudication/private-annotation-map.json",
      private_annotation_map_sha256: hashText(privateMapText),
      initial_annotation_refs: [
        "adjudication/initial-annotation-1.jsonl",
        "adjudication/initial-annotation-2.jsonl"
      ],
      initial_annotation_sha256: [hashText(annotationOneText), hashText(annotationTwoText)],
      resolution_ref: null,
      resolution_sha256: null,
      mutation_audit_report_ref: "adjudication/mutation-audit-report.json",
      mutation_audit_report_sha256: hashText(mutationAuditText),
      adjudicated_labels_ref: "adjudication/adjudicated-labels.jsonl",
      adjudicated_labels_sha256: hashText(labelsText),
      case_count: cases.length
    },
    cases: caseRefs
  }));
}

async function writeSourceSuiteSnapshotEvidence(input: {
  workspace: string;
  suiteRoot: string;
  suiteId: string;
  cases: PromotionBenchmarkCaseManifest[];
  caseRefs: string[];
  confirmatoryFreezeProvenance: Record<string, unknown>;
}): Promise<{ snapshotSha256: string; evidence: Record<string, unknown> }> {
  const sourceRoot = path.join(input.workspace, input.suiteRoot, "adjudication", "source-suite");
  const caseEvidenceRoot = path.join(sourceRoot, "case-manifests");
  await mkdir(caseEvidenceRoot, { recursive: true });
  const caseBytesBySourceRef = new Map<string, Buffer>();
  const caseManifests = [];
  for (const [index, benchmarkCase] of input.cases.entries()) {
    const sourceRef = input.caseRefs[index];
    const evidenceRef = `adjudication/source-suite/case-manifests/${String(index + 1).padStart(6, "0")}.json`;
    const sourceCase = {
      ...benchmarkCase,
      mutation_manifest: "../provenance/" + benchmarkCase.case_id + ".json",
      gold: { decision: "needs_review", blocking_concerns: [], repair_owners: [] }
    };
    const bytes = Buffer.from(JSON.stringify(sourceCase));
    await writeFile(path.join(input.workspace, input.suiteRoot, evidenceRef), bytes);
    caseBytesBySourceRef.set(sourceRef, bytes);
    caseManifests.push({
      case_id: benchmarkCase.case_id,
      source_ref: sourceRef,
      evidence_ref: evidenceRef,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  const sourceManifest = {
    schema_version: "1.0",
    suite_id: input.suiteId,
    evidence_class: "external_real_run",
    paper_claim_eligible: false,
    adjudication_status: "unreviewed",
    mutation_isolation_status: "unreviewed",
    execution_provenance_status: "artifact_verified",
    source_diversity_status: "declared_stratified",
    confirmatory_freeze_provenance: input.confirmatoryFreezeProvenance,
    cases: input.caseRefs
  };
  const suiteBytes = Buffer.from(JSON.stringify(sourceManifest));
  const suiteManifestRef = "adjudication/source-suite/suite.json";
  await writeFile(path.join(input.workspace, input.suiteRoot, suiteManifestRef), suiteBytes);
  const hash = createHash("sha256");
  hash.update("suite_manifest\0");
  hash.update(suiteBytes);
  hash.update("\0");
  for (const sourceRef of [...input.caseRefs].sort()) {
    const bytes = caseBytesBySourceRef.get(sourceRef);
    if (!bytes) throw new Error("Recovery source-suite fixture is missing a case manifest.");
    hash.update("case_manifest\0" + sourceRef + "\0");
    hash.update(bytes);
    hash.update("\0");
  }
  for (const benchmarkCase of [...input.cases].sort((left, right) => left.case_id.localeCompare(right.case_id))) {
    hash.update("artifact_tree\0" + benchmarkCase.case_id + "\0");
    hash.update(benchmarkCase.artifact_sha256 || "");
    hash.update("\0");
  }
  return {
    snapshotSha256: hash.digest("hex"),
    evidence: {
      schema_version: "1.0",
      method: "contained_source_suite_manifests",
      suite_manifest_ref: suiteManifestRef,
      suite_manifest_sha256: createHash("sha256").update(suiteBytes).digest("hex"),
      case_manifests: caseManifests
    }
  };
}

async function writeConfirmatoryFreezeEvidence(
  workspace: string,
  suiteRoot: string,
  suiteId: string,
  cases: PromotionBenchmarkCaseManifest[]
): Promise<Record<string, unknown>> {
  const freezeRoot = path.join(workspace, suiteRoot, "confirmatory-freeze");
  await mkdir(freezeRoot, { recursive: true });
  const sourceByBase = new Map<string, PromotionBenchmarkCaseManifest>();
  const operationByFamily = new Map(promotionVariantDefinitions().flatMap((variant) =>
    variant.mutation_family ? [[variant.mutation_family, variant.operations] as const] : []));
  for (const benchmarkCase of cases) {
    if (!sourceByBase.has(benchmarkCase.base_bundle_id)) {
      sourceByBase.set(benchmarkCase.base_bundle_id, benchmarkCase);
    }
  }
  const recipe = {
    schema_version: "1.0",
    suite_id: suiteId,
    evidence_class: "external_real_run",
    paper_claim_eligible: false,
    adjudication_status: "unreviewed",
    mutation_isolation_status: "unreviewed",
    execution_provenance_status: "artifact_verified",
    source_diversity_status: "declared_stratified",
    cases: cases.map((benchmarkCase) => ({
      case_id: benchmarkCase.case_id,
      base_bundle_id: benchmarkCase.base_bundle_id,
      split: "test",
      source_root: "base-bundles/" + benchmarkCase.base_bundle_id,
      source_family_id_sha256: benchmarkCase.source_family_id_sha256,
      operator_group_id_sha256: benchmarkCase.operator_group_id_sha256,
      ...(benchmarkCase.mutation_family ? { mutation_family: benchmarkCase.mutation_family } : {}),
      operations: benchmarkCase.mutation_family
        ? operationByFamily.get(benchmarkCase.mutation_family) || []
        : [],
      gold: { decision: "needs_review", blocking_concerns: [], repair_owners: [] }
    }))
  };
  const recipeText = JSON.stringify(recipe);
  const recipeSha256 = hashText(recipeText);
  const sourceRevision = "recovery-source-revision";
  const intakeText = JSON.stringify({
    schema_version: "1.2",
    intake_tier: "paper_scale",
    study_id: suiteId,
    candidate_handoff_root: "candidate-handoff",
    candidate_campaign_return_root: "candidate-campaign-return"
  });
  const handoffText = JSON.stringify({
    schema_version: "1.0",
    handoff_id: "recovery-handoff",
    source_revision: sourceRevision
  });
  const reviewLabelsText = '{"schema_version":"1.0","candidate_id":"candidate-placeholder"}\n';
  const reviewEvidenceText = JSON.stringify({ schema_version: "1.0", handoff_id: "recovery-handoff" });
  const reviewReportText = JSON.stringify({ schema_version: "1.0", passed: true });
  const campaignManifestText = JSON.stringify({
    schema_version: "1.0",
    campaign_id: "recovery-review-campaign",
    handoff_id: "recovery-handoff",
    source_revision: sourceRevision
  });
  const returnTexts = {
    "returns/reviewer-a.json": JSON.stringify({
      handoff_id: "recovery-handoff",
      annotator_id: "reviewer-a"
    }),
    "returns/reviewer-b.json": JSON.stringify({
      handoff_id: "recovery-handoff",
      annotator_id: "reviewer-b"
    }),
    "returns/license-reviewer.json": JSON.stringify({
      handoff_id: "recovery-handoff",
      reviewer_id: "license-reviewer"
    })
  };
  const campaignFiles = [
    {
      path: `adjudication/${PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS}`,
      bytes: reviewLabelsText
    },
    {
      path: `adjudication/${PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE}`,
      bytes: reviewEvidenceText
    },
    {
      path: `adjudication/${PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT}`,
      bytes: reviewReportText
    },
    ...Object.entries(returnTexts).map(([filePath, bytes]) => ({ path: filePath, bytes })),
    { path: "upstream/review-campaign.json", bytes: campaignManifestText },
    { path: "upstream/trial-candidate-handoff.json", bytes: handoffText }
  ].sort((left, right) => left.path.localeCompare(right.path));
  const campaignReceiptText = JSON.stringify({
    schema_version: "1.0",
    kind: "promotion_trial_candidate_campaign_return",
    campaign_id: "recovery-review-campaign",
    handoff_id: "recovery-handoff",
    source_revision: sourceRevision,
    status: "adjudicated",
    passed: true,
    assigned_return_count: 3,
    required_return_count: 3,
    returns: [],
    input_sha256: {
      campaign_manifest: hashText(campaignManifestText),
      handoff_manifest: hashText(handoffText)
    },
    adjudication: {
      attempted: true,
      passed: true,
      report_path: `adjudication/${PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT}`,
      report_sha256: hashText(reviewReportText),
      accepted_label_count: sourceByBase.size,
      task_count: sourceByBase.size,
      source_eligible_candidate_count: sourceByBase.size
    },
    validation_issues: [],
    confirmatory_admitted: false,
    files: campaignFiles.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.bytes),
      sha256: hashText(file.bytes)
    })),
    evidence_boundary: "Synthetic frozen-provenance parser fixture only."
  });
  const upstreamFiles = [
    { ref: PROMOTION_CONFIRMATORY_UPSTREAM_INTAKE_REF, bytes: intakeText },
    {
      ref: `${PROMOTION_CONFIRMATORY_UPSTREAM_HANDOFF_ROOT}/${PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST}`,
      bytes: handoffText
    },
    {
      ref: `${PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT}/${PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT}`,
      bytes: campaignReceiptText
    },
    ...campaignFiles.map((file) => ({
      ref: `${PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT}/${file.path}`,
      bytes: file.bytes
    }))
  ].sort((left, right) => left.ref.localeCompare(right.ref));
  for (const item of upstreamFiles) {
    const outputPath = path.join(freezeRoot, item.ref);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, item.bytes);
  }
  const upstreamInventory = upstreamFiles.map((item) => ({ ref: item.ref, sha256: hashText(item.bytes) }));
  const sourceBundles = [...sourceByBase.values()].map((benchmarkCase) => ({
    base_bundle_id: benchmarkCase.base_bundle_id,
    source_sha256: benchmarkCase.source_sha256,
    source_family_id_sha256: benchmarkCase.source_family_id_sha256,
    operator_group_id_sha256: benchmarkCase.operator_group_id_sha256,
    source_revision: sourceRevision,
    origin_kind: "native",
    candidate_id: "candidate-" + benchmarkCase.base_bundle_id,
    canonical_curation_record_sha256: hashText("curation-" + benchmarkCase.base_bundle_id),
    run_id_sha256: hashText("run-" + benchmarkCase.base_bundle_id),
    execution_fingerprint: hashText("execution-" + benchmarkCase.base_bundle_id),
    evidence_manifest_sha256: hashText("evidence-" + benchmarkCase.base_bundle_id),
    license_sha256: hashText("license-" + benchmarkCase.base_bundle_id),
    evidence_artifact_count: 1,
    evidence_roles: ["run_record"],
    copied_root: "base-bundles/" + benchmarkCase.base_bundle_id
  }));
  const freezeManifest = {
    schema_version: "1.2",
    study_id: suiteId,
    intake_tier: "paper_scale",
    evidence_class: "external_real_run",
    paper_claim_eligible: false,
    adjudication_status: "unreviewed",
    mutation_isolation_status: "unreviewed",
    execution_provenance_status: "artifact_verified",
    source_diversity_status: "declared_stratified",
    intake_manifest_sha256: hashText(intakeText),
    upstream_evidence: {
      schema_version: "1.1",
      method: "contained_intake_campaign_return_evidence",
      intake_manifest_ref: PROMOTION_CONFIRMATORY_UPSTREAM_INTAKE_REF,
      candidate_handoff_root_ref: PROMOTION_CONFIRMATORY_UPSTREAM_HANDOFF_ROOT,
      candidate_campaign_return_root_ref: PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT,
      files: upstreamInventory
    },
    recipe_sha256: recipeSha256,
    base_bundle_count: sourceBundles.length,
    case_count: cases.length,
    candidate_review: {
      handoff_id: "recovery-handoff",
      source_revision: sourceRevision,
      handoff_manifest_sha256: hashText(handoffText),
      campaign_return_receipt_sha256: hashText(campaignReceiptText),
      review_report_sha256: hashText(reviewReportText),
      adjudicated_labels_sha256: hashText(reviewLabelsText),
      review_evidence_sha256: hashText(reviewEvidenceText),
      source_eligible_candidate_count: sourceBundles.length
    },
    required_fault_families: REQUIRED_CONFIRMATORY_MUTATION_FAMILIES,
    source_bundles: sourceBundles
  };
  const freezeText = JSON.stringify(freezeManifest);
  await writeFile(path.join(freezeRoot, "recipe.json"), recipeText);
  await writeFile(path.join(freezeRoot, "frozen-intake-manifest.json"), freezeText);
  return {
    schema_version: "1.1",
    method: "verified_confirmatory_freeze",
    study_id: suiteId,
    intake_tier: "paper_scale",
    freeze_manifest_ref: "confirmatory-freeze/frozen-intake-manifest.json",
    freeze_manifest_sha256: hashText(freezeText),
    recipe_ref: "confirmatory-freeze/recipe.json",
    recipe_sha256: recipeSha256,
    intake_manifest_sha256: freezeManifest.intake_manifest_sha256,
    upstream_evidence_inventory_sha256: hashText(JSON.stringify(upstreamInventory)),
    upstream_evidence_file_count: upstreamInventory.length,
    base_bundle_count: sourceBundles.length,
    case_count: cases.length,
    candidate_review: freezeManifest.candidate_review
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function predictionFromGold(
  benchmarkCase: PromotionBenchmarkCaseManifest,
  trialId: string
): PromotionBenchmarkPrediction {
  return {
    case_id: benchmarkCase.case_id,
    system_id: "artifact-audit",
    trial_id: trialId,
    decision: benchmarkCase.gold.decision,
    concerns: benchmarkCase.gold.blocking_concerns.map((code) => ({ code, severity: "blocking" })),
    repair_owners: benchmarkCase.gold.repair_owners
  };
}

async function writePredictions(filePath: string, predictions: PromotionBenchmarkPrediction[]): Promise<void> {
  await writeFile(filePath, predictions.map((prediction) => JSON.stringify(prediction)).join("\n") + "\n");
}

async function writeSystemRunManifest(input: {
  workspace: string;
  fileName: string;
  suiteId: string;
  suitePath: string;
  predictionsPath: string;
  trialId: string;
  caseCount: number;
}): Promise<void> {
  await writeFile(path.join(input.workspace, input.fileName), JSON.stringify({
    schema_version: "1.1",
    protocol_revision: PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION,
    status: "completed",
    evidence_class: "deterministic_artifact_evaluation",
    suite_id: input.suiteId,
    suite_path: input.suitePath,
    suite_sha256: await sha256File(path.join(input.workspace, input.suitePath)),
    suite_snapshot_sha256: await hashPromotionBenchmarkSuiteSnapshot(
      path.join(input.workspace, input.suitePath)
    ),
    trial_id: input.trialId,
    generated_at: "2026-01-01T00:00:00.000Z",
    case_count: input.caseCount,
    prediction_count: input.caseCount,
    systems: [{
      system_id: "artifact-audit",
      protocol: "full_artifact_policy",
      ablated_components: []
    }],
    artifacts: {
      predictions_path: input.predictionsPath,
      predictions_sha256: await sha256File(path.join(input.workspace, input.predictionsPath))
    }
  }));
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
