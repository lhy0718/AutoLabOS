import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import { hashPromotionArtifactTree } from "./promotionBenchmark.js";
import {
  validatePromotionMutationCompatibility,
  type PromotionBenchmarkRecipe,
  type PromotionBenchmarkRecipeCase
} from "./promotionBenchmarkBuilder.js";
import { promotionVariantDefinitions } from "./promotionBenchmarkVariants.js";
import {
  inspectPromotionExecutionEvidence,
  type PromotionExecutionEvidenceIssue,
  type PromotionExecutionEvidenceRole
} from "./promotionBenchmarkExecutionEvidence.js";
import {
  inspectPromotionSourceProjection,
  PROMOTION_SOURCE_LICENSE_FILE,
  type PromotionSourceDistributionScope,
  type PromotionSourceLicenseReviewStatus
} from "./promotionBenchmarkSourceProjection.js";
import { inspectPromotionSourceNormalization } from "./promotionBenchmarkSourceNormalization.js";
import {
  MAXIMUM_PROMOTION_GROUP_SHARE,
  MINIMUM_PROMOTION_OPERATOR_GROUPS,
  MINIMUM_PROMOTION_SOURCE_FAMILIES
} from "./promotionBenchmarkSourceDiversity.js";
import {
  PROMOTION_CANONICAL_ARTIFACT_PATHS,
  inspectPromotionCanonicalCuration
} from "./promotionBenchmarkCanonicalCuration.js";
import {
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES
} from "./promotionBenchmarkConfirmatoryContract.js";
import {
  PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST,
  inspectPromotionTrialCandidateHandoff,
  type PromotionTrialCandidateRecord
} from "./promotionBenchmarkTrialCandidateHandoff.js";
import {
  loadPromotionTrialCandidateReviewAdmissionEvidence
} from "./promotionBenchmarkTrialCandidateReview.js";

export const MINIMUM_PROVISIONAL_CONFIRMATORY_SOURCE_BUNDLES = 20;
export const MINIMUM_PAPER_SCALE_CONFIRMATORY_SOURCE_BUNDLES =
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES;
export const MINIMUM_CONFIRMATORY_SOURCE_FAMILIES = MINIMUM_PROMOTION_SOURCE_FAMILIES;
export const MINIMUM_CONFIRMATORY_OPERATOR_GROUPS = MINIMUM_PROMOTION_OPERATOR_GROUPS;
export const MAXIMUM_CONFIRMATORY_GROUP_SHARE = MAXIMUM_PROMOTION_GROUP_SHARE;

export type PromotionConfirmatorySourceOriginKind = "native" | "projected" | "normalized";

export interface PromotionConfirmatoryIntakeSource {
  source_id: string;
  source_root: string;
  evidence_class: "external_real_run";
  source_family_id: string;
  operator_group_id: string;
  source_revision: string;
  origin_kind: PromotionConfirmatorySourceOriginKind;
  distribution_scope: PromotionSourceDistributionScope;
  license_review_status: PromotionSourceLicenseReviewStatus;
  candidate_id?: string;
}

export interface PromotionConfirmatoryIntakeManifest {
  schema_version: "1.0" | "1.1";
  intake_tier: "provisional" | "paper_scale";
  study_id: string;
  candidate_handoff_root?: string;
  candidate_review_root?: string;
  sources: PromotionConfirmatoryIntakeSource[];
}

export interface FreezePromotionConfirmatoryInput {
  cwd: string;
  manifestPath: string;
  outDir: string;
}

export interface FreezePromotionConfirmatoryResult {
  study_id: string;
  intake_tier: "provisional" | "paper_scale";
  base_bundle_count: number;
  case_count: number;
  output_dir: string;
  recipe_path: string;
  freeze_manifest_path: string;
}

export interface AuditPromotionConfirmatoryIntakeInput {
  cwd: string;
  manifestPath: string;
  outDir: string;
}

export interface PromotionConfirmatorySourceAudit {
  source_id: string;
  source_family_id_sha256: string;
  operator_group_id_sha256: string;
  source_revision: string;
  origin_kind: PromotionConfirmatorySourceOriginKind;
  candidate_id: string | null;
  passed: boolean;
  source_sha256: string | null;
  base_bundle_id: string | null;
  run_id_sha256: string | null;
  execution_fingerprint: string | null;
  evidence_manifest_sha256: string | null;
  license_sha256: string | null;
  evidence_artifact_count: number;
  evidence_roles: PromotionExecutionEvidenceRole[];
  canonical_curation_record_sha256: string | null;
  canonical_curation_verified_artifact_count: number;
  issues: PromotionExecutionEvidenceIssue[];
}

export interface PromotionConfirmatoryIntakeAuditReport {
  schema_version: "1.0";
  generated_at: string;
  study_id: string;
  intake_tier: "provisional" | "paper_scale";
  passed: boolean;
  source_count: number;
  minimum_source_count: number;
  declared_source_family_count: number;
  minimum_source_family_count: number;
  largest_source_family_count: number;
  declared_operator_group_count: number;
  minimum_operator_group_count: number;
  largest_operator_group_count: number;
  maximum_group_share: number;
  artifact_verified_source_count: number;
  candidate_handoff_verified: boolean;
  candidate_review_verified: boolean;
  source_eligible_candidate_count: number;
  canonical_curation_verified_source_count: number;
  global_issues: PromotionExecutionEvidenceIssue[];
  sources: PromotionConfirmatorySourceAudit[];
}

export interface AuditPromotionConfirmatoryIntakeResult {
  report: PromotionConfirmatoryIntakeAuditReport;
  output_dir: string;
  report_path: string;
}

interface PreparedSource {
  source_root: string;
  source_sha256: string;
  base_bundle_id: string;
  run_id: string;
  run_id_sha256: string;
  execution_fingerprint: string;
  evidence_manifest_sha256: string;
  license_sha256: string;
  evidence_artifact_count: number;
  evidence_roles: PromotionExecutionEvidenceRole[];
  source_family_id_sha256: string;
  operator_group_id_sha256: string;
  source_revision: string;
  origin_kind: PromotionConfirmatorySourceOriginKind;
  candidate_id: string | null;
  canonical_curation_record_sha256: string | null;
}

interface ConfirmatorySourceInspection {
  report: PromotionConfirmatoryIntakeAuditReport;
  prepared: PreparedSource[];
  paper_scale_evidence: PaperScaleEvidence | null;
}

interface PaperScaleEvidence {
  handoff_id: string;
  handoff_manifest_sha256: string;
  source_revision: string;
  candidate_by_id: Map<string, PromotionTrialCandidateRecord>;
  source_eligible_candidate_ids: Set<string>;
  review_labels_sha256: string;
  review_evidence_sha256: string;
}

interface PaperScaleEvidenceInspection {
  evidence: PaperScaleEvidence | null;
  handoff_verified: boolean;
  review_verified: boolean;
  source_eligible_candidate_count: number;
}

export async function freezePromotionConfirmatoryCorpus(
  input: FreezePromotionConfirmatoryInput
): Promise<FreezePromotionConfirmatoryResult> {
  const cwd = path.resolve(input.cwd);
  const manifestPath = path.resolve(cwd, input.manifestPath);
  const manifestRoot = path.dirname(manifestPath);
  const outDir = path.resolve(cwd, input.outDir);
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = parseIntakeManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  const intakeManifestSha256 = sha256(manifestBytes);
  if (await pathExists(outDir)) throw new Error(`Promotion confirmatory output already exists: ${portableRef(cwd, outDir)}`);
  const minimumSourceCount = minimumConfirmatorySourceCount(manifest);
  if (manifest.sources.length < minimumSourceCount) {
    throw new Error(`Promotion confirmatory ${manifest.intake_tier} intake requires at least ${minimumSourceCount} source bundles.`);
  }
  for (const source of manifest.sources) {
    const sourceRoot = path.resolve(manifestRoot, source.source_root);
    if (isSameOrContainedPath(sourceRoot, outDir)) {
      throw new Error(`Promotion confirmatory output must stay outside source bundles: ${source.source_id}`);
    }
  }
  for (const evidenceRoot of [manifest.candidate_handoff_root, manifest.candidate_review_root].filter(nonEmptyString)) {
    const resolved = path.resolve(manifestRoot, evidenceRoot);
    if (isSameOrContainedPath(resolved, outDir)) {
      throw new Error("Promotion confirmatory output must stay outside candidate evidence roots.");
    }
  }

  const variants = promotionVariantDefinitions();
  const inspected = await inspectConfirmatorySources(manifest, manifestRoot);
  if (!inspected.report.passed) {
    const issueCodes = [
      ...inspected.report.global_issues.map((issue) => issue.code),
      ...inspected.report.sources.flatMap((source) => source.issues.map((issue) => issue.code))
    ];
    if (issueCodes.includes("confirmatory_source_hash_duplicate")) {
      throw new Error("Confirmatory sources must have distinct content hashes; duplicate source content was detected.");
    }
    throw new Error(`Promotion confirmatory execution evidence audit failed: ${[...new Set(issueCodes)].join(", ")}.`);
  }
  const prepared = inspected.prepared;

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    const cases: PromotionBenchmarkRecipeCase[] = [];
    for (const source of prepared) {
      const copiedRoot = path.join(stagingRoot, "base-bundles", source.base_bundle_id);
      await fs.mkdir(path.dirname(copiedRoot), { recursive: true });
      await fs.cp(source.source_root, copiedRoot, { recursive: true, errorOnExist: true, force: false });
      if (await hashPromotionArtifactTree(copiedRoot) !== source.source_sha256) {
        throw new Error(`Confirmatory source changed while it was being frozen: ${source.base_bundle_id}`);
      }
      for (const variant of variants) {
        const suffix = variant.mutation_family || "clean";
        cases.push({
          case_id: `${source.base_bundle_id}-${suffix}`,
          base_bundle_id: source.base_bundle_id,
          split: "test",
          source_root: `base-bundles/${source.base_bundle_id}`,
          source_family_id_sha256: source.source_family_id_sha256,
          operator_group_id_sha256: source.operator_group_id_sha256,
          ...(variant.mutation_family ? { mutation_family: variant.mutation_family } : {}),
          operations: variant.operations,
          gold: provisionalLabel()
        });
      }
    }
    const recipe: PromotionBenchmarkRecipe = {
      schema_version: "1.0",
      suite_id: manifest.study_id,
      evidence_class: "external_real_run",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed",
      mutation_isolation_status: "unreviewed",
      execution_provenance_status: "artifact_verified",
      source_diversity_status: "declared_stratified",
      cases
    };
    const recipePath = path.join(stagingRoot, "recipe.json");
    await writeJsonFile(recipePath, recipe);
    const recipeSha256 = sha256(await fs.readFile(recipePath));
    await writeJsonFile(path.join(stagingRoot, "frozen-intake-manifest.json"), {
      schema_version: "1.1",
      study_id: manifest.study_id,
      intake_tier: manifest.intake_tier,
      generated_at: new Date().toISOString(),
      evidence_class: "external_real_run",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed",
      mutation_isolation_status: "unreviewed",
      execution_provenance_status: "artifact_verified",
      source_diversity_status: "declared_stratified",
      intake_manifest_sha256: intakeManifestSha256,
      recipe_sha256: recipeSha256,
      base_bundle_count: prepared.length,
      case_count: cases.length,
      ...(inspected.paper_scale_evidence
        ? {
            candidate_review: {
              handoff_id: inspected.paper_scale_evidence.handoff_id,
              source_revision: inspected.paper_scale_evidence.source_revision,
              handoff_manifest_sha256: inspected.paper_scale_evidence.handoff_manifest_sha256,
              adjudicated_labels_sha256: inspected.paper_scale_evidence.review_labels_sha256,
              review_evidence_sha256: inspected.paper_scale_evidence.review_evidence_sha256,
              source_eligible_candidate_count:
                inspected.paper_scale_evidence.source_eligible_candidate_ids.size
            }
          }
        : {}),
      required_fault_families: variants.flatMap((variant) => variant.mutation_family ? [variant.mutation_family] : []),
      source_bundles: prepared.map((source) => ({
        base_bundle_id: source.base_bundle_id,
        source_sha256: source.source_sha256,
        source_family_id_sha256: source.source_family_id_sha256,
        operator_group_id_sha256: source.operator_group_id_sha256,
        source_revision: source.source_revision,
        origin_kind: source.origin_kind,
        candidate_id: source.candidate_id,
        canonical_curation_record_sha256: source.canonical_curation_record_sha256,
        run_id_sha256: source.run_id_sha256,
        execution_fingerprint: source.execution_fingerprint,
        evidence_manifest_sha256: source.evidence_manifest_sha256,
        license_sha256: source.license_sha256,
        evidence_artifact_count: source.evidence_artifact_count,
        evidence_roles: source.evidence_roles,
        copied_root: `base-bundles/${source.base_bundle_id}`
      })),
      label_boundary: "All recipe labels are provisional needs_review values. Only blind independent adjudication may replace them."
    });
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    study_id: manifest.study_id,
    intake_tier: manifest.intake_tier,
    base_bundle_count: prepared.length,
    case_count: prepared.length * variants.length,
    output_dir: portableRef(cwd, outDir),
    recipe_path: portableRef(cwd, path.join(outDir, "recipe.json")),
    freeze_manifest_path: portableRef(cwd, path.join(outDir, "frozen-intake-manifest.json"))
  };
}

export async function auditPromotionConfirmatoryIntake(
  input: AuditPromotionConfirmatoryIntakeInput
): Promise<AuditPromotionConfirmatoryIntakeResult> {
  const cwd = path.resolve(input.cwd);
  const manifestPath = path.resolve(cwd, input.manifestPath);
  const manifestRoot = path.dirname(manifestPath);
  const outDir = path.resolve(cwd, input.outDir);
  if (await pathExists(outDir)) throw new Error(`Promotion confirmatory audit output already exists: ${portableRef(cwd, outDir)}`);
  const manifest = parseIntakeManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown);
  for (const source of manifest.sources) {
    const sourceRoot = path.resolve(manifestRoot, source.source_root);
    if (isSameOrContainedPath(sourceRoot, outDir)) {
      throw new Error(`Promotion confirmatory audit output must stay outside source bundles: ${source.source_id}`);
    }
  }
  for (const evidenceRoot of [manifest.candidate_handoff_root, manifest.candidate_review_root].filter(nonEmptyString)) {
    if (isSameOrContainedPath(path.resolve(manifestRoot, evidenceRoot), outDir)) {
      throw new Error("Promotion confirmatory audit output must stay outside candidate evidence roots.");
    }
  }
  const inspected = await inspectConfirmatorySources(manifest, manifestRoot);
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    await writeJsonFile(path.join(stagingRoot, "confirmatory-intake-audit.json"), inspected.report);
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    report: inspected.report,
    output_dir: portableRef(cwd, outDir),
    report_path: portableRef(cwd, path.join(outDir, "confirmatory-intake-audit.json"))
  };
}

async function inspectConfirmatorySources(
  manifest: PromotionConfirmatoryIntakeManifest,
  manifestRoot: string
): Promise<ConfirmatorySourceInspection> {
  const mutationVariants = promotionVariantDefinitions()
    .filter((variant) => variant.mutation_family)
    .map((variant) => variant.operations);
  const sourceAudits: PromotionConfirmatorySourceAudit[] = [];
  const candidates: Array<{ audit: PromotionConfirmatorySourceAudit; prepared?: PreparedSource }> = [];
  const globalIssues: PromotionExecutionEvidenceIssue[] = [];
  const paperScale = await inspectPaperScaleEvidence(manifest, manifestRoot, globalIssues);

  for (const source of manifest.sources) {
    const sourceRoot = path.resolve(manifestRoot, source.source_root);
    const issues: PromotionExecutionEvidenceIssue[] = [];
    let sourceSha256: string | null = null;
    try {
      sourceSha256 = await hashPromotionArtifactTree(sourceRoot);
    } catch (error) {
      issues.push({
        code: "confirmatory_source_unreadable",
        message: errorMessage(error)
      });
    }
    const evidence = await inspectPromotionExecutionEvidence(sourceRoot);
    issues.push(...evidence.issues);
    const licenseSha256 = await inspectRequiredLicenseFile(sourceRoot, issues);
    if (source.distribution_scope !== "redistributable" || source.license_review_status !== "human_verified") {
      issues.push({
        code: "confirmatory_source_redistribution_unverified",
        message: "Confirmatory sources require declared public redistribution scope and completed human license review."
      });
    }
    if (source.origin_kind === "projected") {
      const projection = await inspectPromotionSourceProjection(sourceRoot);
      issues.push(...projection.issues);
      if (projection.manifest
          && (projection.manifest.source_family_id_sha256 !== sha256Text(source.source_family_id)
            || projection.manifest.operator_group_id_sha256 !== sha256Text(source.operator_group_id)
            || projection.manifest.source_revision !== source.source_revision)) {
        issues.push({
          code: "confirmatory_source_projection_identity_mismatch",
          message: "Projected source identity declarations do not match the projection manifest."
        });
      }
    }
    if (source.origin_kind === "normalized") {
      const normalization = await inspectPromotionSourceNormalization(sourceRoot);
      issues.push(...normalization.issues);
      if (normalization.manifest
          && (normalization.manifest.source_family_id_sha256 !== sha256Text(source.source_family_id)
            || normalization.manifest.operator_group_id_sha256 !== sha256Text(source.operator_group_id)
            || normalization.manifest.source_revision !== source.source_revision)) {
        issues.push({
          code: "confirmatory_source_normalization_identity_mismatch",
          message: "Normalized source identity declarations do not match the normalization manifest."
        });
      }
      if (normalization.manifest
          && (normalization.manifest.distribution_scope !== source.distribution_scope
            || normalization.manifest.license_review_status !== source.license_review_status)) {
        issues.push({
          code: "confirmatory_source_normalization_license_scope_mismatch",
          message: "Normalized source distribution or license-review declarations do not match its manifest."
        });
      }
    }
    if (sourceSha256) {
      try {
        await validatePromotionMutationCompatibility(sourceRoot, mutationVariants);
      } catch (error) {
        issues.push({
          code: "confirmatory_mutation_compatibility_failed",
          message: errorMessage(error)
        });
      }
    }
    let canonicalCurationRecordSha256: string | null = null;
    let canonicalCurationVerifiedArtifactCount = 0;
    if (manifest.intake_tier === "paper_scale") {
      const paperScaleEvidence = paperScale.evidence;
      const candidate = source.candidate_id && paperScaleEvidence
        ? paperScaleEvidence.candidate_by_id.get(source.candidate_id)
        : undefined;
      if (!source.candidate_id) {
        issues.push({
          code: "confirmatory_candidate_id_missing",
          message: "Paper-scale sources require a reviewed candidate ID."
        });
      } else if (!paperScaleEvidence) {
        issues.push({
          code: "confirmatory_candidate_evidence_unavailable",
          message: "Paper-scale candidate binding requires valid handoff and review evidence.",
          ref: source.candidate_id
        });
      } else if (!candidate) {
        issues.push({
          code: "confirmatory_candidate_not_in_handoff",
          message: "Paper-scale source candidate IDs must exist in the integrity-valid handoff.",
          ref: source.candidate_id
        });
      } else {
        if (!paperScaleEvidence.source_eligible_candidate_ids.has(source.candidate_id)) {
          issues.push({
            code: "confirmatory_candidate_not_source_eligible",
            message: "Paper-scale sources require a positive double-human source-eligibility decision.",
            ref: source.candidate_id
          });
        }
        if (source.source_revision !== paperScaleEvidence.source_revision
            || sha256Text(source.source_family_id) !== candidate.source_family_id_sha256
            || sha256Text(source.operator_group_id) !== candidate.operator_group_id_sha256) {
          issues.push({
            code: "confirmatory_candidate_source_identity_mismatch",
            message: "Paper-scale source declarations must match the reviewed handoff candidate.",
            ref: source.candidate_id
          });
        }
        const curation = await inspectPromotionCanonicalCuration({
          sourceRoot,
          handoffId: paperScaleEvidence.handoff_id,
          sourceRevision: paperScaleEvidence.source_revision,
          candidate
        });
        canonicalCurationRecordSha256 = curation.record_sha256;
        canonicalCurationVerifiedArtifactCount = curation.verified_artifact_count;
        issues.push(...curation.issues);
      }
    }

    const baseBundleId = sourceSha256 ? `base-${sourceSha256.slice(0, 20)}` : null;
    const audit: PromotionConfirmatorySourceAudit = {
      source_id: source.source_id,
      source_family_id_sha256: sha256Text(source.source_family_id),
      operator_group_id_sha256: sha256Text(source.operator_group_id),
      source_revision: source.source_revision,
      origin_kind: source.origin_kind,
      candidate_id: source.candidate_id || null,
      passed: false,
      source_sha256: sourceSha256,
      base_bundle_id: baseBundleId,
      run_id_sha256: evidence.run_id_sha256,
      execution_fingerprint: evidence.execution_fingerprint,
      evidence_manifest_sha256: evidence.evidence_manifest_sha256,
      license_sha256: licenseSha256,
      evidence_artifact_count: evidence.artifact_count,
      evidence_roles: evidence.roles,
      canonical_curation_record_sha256: canonicalCurationRecordSha256,
      canonical_curation_verified_artifact_count: canonicalCurationVerifiedArtifactCount,
      issues
    };
    sourceAudits.push(audit);
    candidates.push({
      audit,
      ...(sourceSha256 && baseBundleId && evidence.run_id && evidence.run_id_sha256
        && evidence.execution_fingerprint && evidence.evidence_manifest_sha256 && licenseSha256
        ? {
            prepared: {
              source_root: sourceRoot,
              source_sha256: sourceSha256,
              base_bundle_id: baseBundleId,
              run_id: evidence.run_id,
              run_id_sha256: evidence.run_id_sha256,
              execution_fingerprint: evidence.execution_fingerprint,
              evidence_manifest_sha256: evidence.evidence_manifest_sha256,
              license_sha256: licenseSha256,
              evidence_artifact_count: evidence.artifact_count,
              evidence_roles: evidence.roles,
              source_family_id_sha256: sha256Text(source.source_family_id),
              operator_group_id_sha256: sha256Text(source.operator_group_id),
              source_revision: source.source_revision,
              origin_kind: source.origin_kind,
              candidate_id: source.candidate_id || null,
              canonical_curation_record_sha256: canonicalCurationRecordSha256
            }
          }
        : {})
    });
  }

  markDuplicateCandidates(candidates, (candidate) => candidate.prepared?.source_sha256, "confirmatory_source_hash_duplicate");
  markDuplicateCandidates(candidates, (candidate) => candidate.prepared?.base_bundle_id, "confirmatory_base_bundle_id_collision");
  markDuplicateCandidates(candidates, (candidate) => candidate.prepared?.run_id, "confirmatory_run_id_duplicate");
  markDuplicateCandidates(candidates, (candidate) => candidate.prepared?.execution_fingerprint, "confirmatory_execution_fingerprint_duplicate");
  markDuplicateCandidates(
    candidates,
    (candidate) => candidate.prepared?.candidate_id || undefined,
    "confirmatory_candidate_id_duplicate"
  );
  for (const candidate of candidates) candidate.audit.passed = candidate.audit.issues.length === 0;

  const minimumSourceCount = minimumConfirmatorySourceCount(manifest);
  if (manifest.sources.length < minimumSourceCount) {
    globalIssues.push({
      code: "confirmatory_source_count_minimum_not_met",
      message: `Expected at least ${minimumSourceCount} source bundles; observed ${manifest.sources.length}.`
    });
  }
  const sourceFamilyCounts = countBy(manifest.sources, (source) => source.source_family_id);
  const operatorGroupCounts = countBy(manifest.sources, (source) => source.operator_group_id);
  const largestSourceFamilyCount = largestCount(sourceFamilyCounts);
  const largestOperatorGroupCount = largestCount(operatorGroupCounts);
  if (sourceFamilyCounts.size < MINIMUM_CONFIRMATORY_SOURCE_FAMILIES) {
    globalIssues.push({
      code: "confirmatory_source_family_minimum_not_met",
      message: `Expected at least ${MINIMUM_CONFIRMATORY_SOURCE_FAMILIES} declared source families; observed ${sourceFamilyCounts.size}.`
    });
  }
  if (operatorGroupCounts.size < MINIMUM_CONFIRMATORY_OPERATOR_GROUPS) {
    globalIssues.push({
      code: "confirmatory_operator_group_minimum_not_met",
      message: `Expected at least ${MINIMUM_CONFIRMATORY_OPERATOR_GROUPS} declared operator groups; observed ${operatorGroupCounts.size}.`
    });
  }
  if (largestSourceFamilyCount / manifest.sources.length > MAXIMUM_CONFIRMATORY_GROUP_SHARE) {
    globalIssues.push({
      code: "confirmatory_source_family_share_exceeded",
      message: `No declared source family may exceed ${MAXIMUM_CONFIRMATORY_GROUP_SHARE} of confirmatory sources.`
    });
  }
  if (largestOperatorGroupCount / manifest.sources.length > MAXIMUM_CONFIRMATORY_GROUP_SHARE) {
    globalIssues.push({
      code: "confirmatory_operator_group_share_exceeded",
      message: `No declared operator group may exceed ${MAXIMUM_CONFIRMATORY_GROUP_SHARE} of confirmatory sources.`
    });
  }
  const prepared = candidates.flatMap((candidate) =>
    candidate.audit.passed && candidate.prepared ? [candidate.prepared] : []);
  prepared.sort((left, right) => left.source_sha256.localeCompare(right.source_sha256));
  const report: PromotionConfirmatoryIntakeAuditReport = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    study_id: manifest.study_id,
    intake_tier: manifest.intake_tier,
    passed: globalIssues.length === 0 && prepared.length === manifest.sources.length,
    source_count: manifest.sources.length,
    minimum_source_count: minimumSourceCount,
    declared_source_family_count: sourceFamilyCounts.size,
    minimum_source_family_count: MINIMUM_CONFIRMATORY_SOURCE_FAMILIES,
    largest_source_family_count: largestSourceFamilyCount,
    declared_operator_group_count: operatorGroupCounts.size,
    minimum_operator_group_count: MINIMUM_CONFIRMATORY_OPERATOR_GROUPS,
    largest_operator_group_count: largestOperatorGroupCount,
    maximum_group_share: MAXIMUM_CONFIRMATORY_GROUP_SHARE,
    artifact_verified_source_count: prepared.length,
    candidate_handoff_verified: paperScale.handoff_verified,
    candidate_review_verified: paperScale.review_verified,
    source_eligible_candidate_count: paperScale.source_eligible_candidate_count,
    canonical_curation_verified_source_count: sourceAudits.filter(
      (source) => Boolean(source.canonical_curation_record_sha256)
        && source.canonical_curation_verified_artifact_count
          === Object.keys(PROMOTION_CANONICAL_ARTIFACT_PATHS).length
        && !source.issues.some((issue) => issue.code.startsWith("canonical_curation_"))
    ).length,
    global_issues: globalIssues,
    sources: sourceAudits
  };
  return { report, prepared, paper_scale_evidence: paperScale.evidence };
}

async function inspectPaperScaleEvidence(
  manifest: PromotionConfirmatoryIntakeManifest,
  manifestRoot: string,
  issues: PromotionExecutionEvidenceIssue[]
): Promise<PaperScaleEvidenceInspection> {
  if (manifest.intake_tier === "provisional") {
    return {
      evidence: null,
      handoff_verified: false,
      review_verified: false,
      source_eligible_candidate_count: 0
    };
  }
  const handoffRoot = path.resolve(manifestRoot, manifest.candidate_handoff_root || "");
  const reviewRoot = path.resolve(manifestRoot, manifest.candidate_review_root || "");
  const handoff = await inspectPromotionTrialCandidateHandoff(handoffRoot);
  const handoffManifest = handoff.manifest;
  const handoffFloorVerified = Boolean(
    handoff.passed
      && handoffManifest
      && handoffManifest.comparison_mode === "paired_operator"
      && handoffManifest.paired_comparison_floor_met === true
      && handoffManifest.paper_scale_trace_floor_met
      && handoffManifest.required_base_candidate_count
        >= MINIMUM_PAPER_SCALE_CONFIRMATORY_SOURCE_BUNDLES
      && handoffManifest.base_candidate_count
        >= MINIMUM_PAPER_SCALE_CONFIRMATORY_SOURCE_BUNDLES
      && handoffManifest.candidates.length === handoffManifest.base_candidate_count
  );
  if (!handoffFloorVerified) {
    issues.push({
      code: "confirmatory_paper_scale_handoff_invalid",
      message: "Paper-scale intake requires an integrity-valid paired handoff at the 72-base trace floor."
    });
  }

  let review: Awaited<ReturnType<typeof loadPromotionTrialCandidateReviewAdmissionEvidence>> | null = null;
  try {
    review = await loadPromotionTrialCandidateReviewAdmissionEvidence(reviewRoot);
  } catch (error) {
    issues.push({
      code: "confirmatory_paper_scale_review_invalid",
      message: errorMessage(error)
    });
  }
  const reviewVerified = Boolean(
    review
      && handoffManifest
      && review.handoff_id === handoffManifest.handoff_id
      && review.source_revision === handoffManifest.source_revision
      && review.candidate_count === handoffManifest.base_candidate_count
      && review.source_license_status === "redistribution_permitted"
      && review.candidate_review_progression_floor_met
      && review.source_eligible_candidate_ids.length
        >= MINIMUM_PAPER_SCALE_CONFIRMATORY_SOURCE_BUNDLES
  );
  if (review && !reviewVerified) {
    issues.push({
      code: "confirmatory_paper_scale_review_floor_not_met",
      message: "Paper-scale intake requires revision-matched double-human review, redistribution permission, and 72 source-eligible candidates."
    });
  }
  if (!handoffManifest || !review) {
    return {
      evidence: null,
      handoff_verified: handoffFloorVerified,
      review_verified: false,
      source_eligible_candidate_count: review?.source_eligible_candidate_ids.length || 0
    };
  }
  const candidateById = new Map(handoffManifest.candidates.map((candidate) => [
    candidate.candidate_id,
    candidate
  ]));
  if (review.source_eligible_candidate_ids.some((candidateId) => !candidateById.has(candidateId))) {
    issues.push({
      code: "confirmatory_review_candidate_inventory_mismatch",
      message: "Review evidence contains a source-eligible candidate outside the inspected handoff."
    });
  }
  return {
    evidence: {
      handoff_id: handoffManifest.handoff_id,
      handoff_manifest_sha256: sha256(await fs.readFile(path.join(
        handoffRoot,
        PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST
      ))),
      source_revision: handoffManifest.source_revision,
      candidate_by_id: candidateById,
      source_eligible_candidate_ids: new Set(review.source_eligible_candidate_ids),
      review_labels_sha256: review.labels_sha256,
      review_evidence_sha256: review.evidence_sha256
    },
    handoff_verified: handoffFloorVerified,
    review_verified: reviewVerified,
    source_eligible_candidate_count: review.source_eligible_candidate_ids.length
  };
}

function markDuplicateCandidates(
  candidates: Array<{ audit: PromotionConfirmatorySourceAudit; prepared?: PreparedSource }>,
  keyFor: (candidate: { audit: PromotionConfirmatorySourceAudit; prepared?: PreparedSource }) => string | undefined,
  code: string
): void {
  const firstByKey = new Map<string, number>();
  for (const [index, candidate] of candidates.entries()) {
    const key = keyFor(candidate);
    if (!key) continue;
    const firstIndex = firstByKey.get(key);
    if (firstIndex == null) {
      firstByKey.set(key, index);
      continue;
    }
    const message = "Confirmatory sources must have distinct source content, run identities, and execution fingerprints.";
    candidates[firstIndex].audit.issues.push({ code, message });
    candidate.audit.issues.push({ code, message });
  }
}

function minimumConfirmatorySourceCount(
  manifest: Pick<PromotionConfirmatoryIntakeManifest, "intake_tier">
): number {
  return manifest.intake_tier === "paper_scale"
    ? MINIMUM_PAPER_SCALE_CONFIRMATORY_SOURCE_BUNDLES
    : MINIMUM_PROVISIONAL_CONFIRMATORY_SOURCE_BUNDLES;
}

function parseIntakeManifest(value: unknown): PromotionConfirmatoryIntakeManifest {
  if (!isRecord(value)
      || (value.schema_version !== "1.0" && value.schema_version !== "1.1")
      || !validId(value.study_id)
      || !Array.isArray(value.sources)) {
    throw new Error("Promotion confirmatory intake requires schema_version=1.0 or 1.1, a study_id, and sources.");
  }
  if (value.sources.length === 0) throw new Error("Promotion confirmatory intake requires at least one source bundle.");
  const paperScale = value.schema_version === "1.1";
  if ((paperScale && (value.intake_tier !== "paper_scale"
        || !nonEmptyString(value.candidate_handoff_root)
        || !nonEmptyString(value.candidate_review_root)))
      || (!paperScale && value.intake_tier !== undefined && value.intake_tier !== "provisional")) {
    throw new Error("Schema 1.1 requires paper_scale candidate handoff and review roots; schema 1.0 is provisional.");
  }
  const sourceIds = new Set<string>();
  const candidateIds = new Set<string>();
  const sources: PromotionConfirmatoryIntakeSource[] = value.sources.map((source, index) => {
    if (!isRecord(source) || !validId(source.source_id) || !nonEmptyString(source.source_root)
        || source.evidence_class !== "external_real_run" || !validId(source.source_family_id)
        || !validId(source.operator_group_id) || !nonEmptyString(source.source_revision)
        || (source.origin_kind !== "native" && source.origin_kind !== "projected" && source.origin_kind !== "normalized")
        || (source.distribution_scope !== "local_evaluation_only" && source.distribution_scope !== "redistributable")
        || (source.license_review_status !== "unreviewed" && source.license_review_status !== "human_verified")
        || (paperScale && !validId(source.candidate_id))) {
      throw new Error(`Invalid promotion confirmatory source at index ${index + 1}.`);
    }
    if (sourceIds.has(source.source_id)) throw new Error(`Duplicate confirmatory source id: ${source.source_id}`);
    sourceIds.add(source.source_id);
    if (paperScale) {
      const candidateId = source.candidate_id as string;
      if (candidateIds.has(candidateId)) throw new Error(`Duplicate confirmatory candidate id: ${candidateId}`);
      candidateIds.add(candidateId);
    }
    return {
      source_id: source.source_id,
      source_root: source.source_root,
      evidence_class: "external_real_run" as const,
      source_family_id: source.source_family_id,
      operator_group_id: source.operator_group_id,
      source_revision: source.source_revision,
      origin_kind: source.origin_kind,
      distribution_scope: source.distribution_scope,
      license_review_status: source.license_review_status,
      ...(paperScale ? { candidate_id: source.candidate_id as string } : {})
    };
  });
  return {
    schema_version: paperScale ? "1.1" : "1.0",
    intake_tier: paperScale ? "paper_scale" : "provisional",
    study_id: value.study_id,
    ...(paperScale
      ? {
          candidate_handoff_root: value.candidate_handoff_root as string,
          candidate_review_root: value.candidate_review_root as string
        }
      : {}),
    sources
  };
}

function provisionalLabel(): PromotionBenchmarkRecipeCase["gold"] {
  return { decision: "needs_review", blocking_concerns: [], repair_owners: [] };
}

async function inspectRequiredLicenseFile(
  sourceRoot: string,
  issues: PromotionExecutionEvidenceIssue[]
): Promise<string | null> {
  const licensePath = path.join(sourceRoot, PROMOTION_SOURCE_LICENSE_FILE);
  try {
    const stat = await fs.lstat(licensePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error("not a non-empty regular file");
    return sha256(await fs.readFile(licensePath));
  } catch {
    issues.push({
      code: "confirmatory_source_license_evidence_missing",
      message: `Confirmatory sources require a non-empty regular ${PROMOTION_SOURCE_LICENSE_FILE} file.`
    });
    return null;
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function countBy<T>(values: T[], keyFor: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyFor(value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function largestCount(counts: Map<string, number>): number {
  return Math.max(0, ...counts.values());
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSameOrContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : path.basename(absolutePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
