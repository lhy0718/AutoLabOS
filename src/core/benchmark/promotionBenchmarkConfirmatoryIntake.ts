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

export const MINIMUM_PROVISIONAL_CONFIRMATORY_SOURCE_BUNDLES = 20;
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
}

export interface PromotionConfirmatoryIntakeManifest {
  schema_version: "1.0";
  study_id: string;
  sources: PromotionConfirmatoryIntakeSource[];
}

export interface FreezePromotionConfirmatoryInput {
  cwd: string;
  manifestPath: string;
  outDir: string;
}

export interface FreezePromotionConfirmatoryResult {
  study_id: string;
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
  passed: boolean;
  source_sha256: string | null;
  base_bundle_id: string | null;
  run_id_sha256: string | null;
  execution_fingerprint: string | null;
  evidence_manifest_sha256: string | null;
  license_sha256: string | null;
  evidence_artifact_count: number;
  evidence_roles: PromotionExecutionEvidenceRole[];
  issues: PromotionExecutionEvidenceIssue[];
}

export interface PromotionConfirmatoryIntakeAuditReport {
  schema_version: "1.0";
  generated_at: string;
  study_id: string;
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
}

interface ConfirmatorySourceInspection {
  report: PromotionConfirmatoryIntakeAuditReport;
  prepared: PreparedSource[];
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
  if (manifest.sources.length < MINIMUM_PROVISIONAL_CONFIRMATORY_SOURCE_BUNDLES) {
    throw new Error(`Promotion confirmatory intake requires at least ${MINIMUM_PROVISIONAL_CONFIRMATORY_SOURCE_BUNDLES} source bundles.`);
  }
  for (const source of manifest.sources) {
    const sourceRoot = path.resolve(manifestRoot, source.source_root);
    if (isSameOrContainedPath(sourceRoot, outDir)) {
      throw new Error(`Promotion confirmatory output must stay outside source bundles: ${source.source_id}`);
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
      schema_version: "1.0",
      study_id: manifest.study_id,
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
      required_fault_families: variants.flatMap((variant) => variant.mutation_family ? [variant.mutation_family] : []),
      source_bundles: prepared.map((source) => ({
        base_bundle_id: source.base_bundle_id,
        source_sha256: source.source_sha256,
        source_family_id_sha256: source.source_family_id_sha256,
        operator_group_id_sha256: source.operator_group_id_sha256,
        source_revision: source.source_revision,
        origin_kind: source.origin_kind,
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

    const baseBundleId = sourceSha256 ? `base-${sourceSha256.slice(0, 20)}` : null;
    const audit: PromotionConfirmatorySourceAudit = {
      source_id: source.source_id,
      source_family_id_sha256: sha256Text(source.source_family_id),
      operator_group_id_sha256: sha256Text(source.operator_group_id),
      source_revision: source.source_revision,
      origin_kind: source.origin_kind,
      passed: false,
      source_sha256: sourceSha256,
      base_bundle_id: baseBundleId,
      run_id_sha256: evidence.run_id_sha256,
      execution_fingerprint: evidence.execution_fingerprint,
      evidence_manifest_sha256: evidence.evidence_manifest_sha256,
      license_sha256: licenseSha256,
      evidence_artifact_count: evidence.artifact_count,
      evidence_roles: evidence.roles,
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
              origin_kind: source.origin_kind
            }
          }
        : {})
    });
  }

  markDuplicateCandidates(candidates, (candidate) => candidate.prepared?.source_sha256, "confirmatory_source_hash_duplicate");
  markDuplicateCandidates(candidates, (candidate) => candidate.prepared?.base_bundle_id, "confirmatory_base_bundle_id_collision");
  markDuplicateCandidates(candidates, (candidate) => candidate.prepared?.run_id, "confirmatory_run_id_duplicate");
  markDuplicateCandidates(candidates, (candidate) => candidate.prepared?.execution_fingerprint, "confirmatory_execution_fingerprint_duplicate");
  for (const candidate of candidates) candidate.audit.passed = candidate.audit.issues.length === 0;

  const globalIssues: PromotionExecutionEvidenceIssue[] = [];
  if (manifest.sources.length < MINIMUM_PROVISIONAL_CONFIRMATORY_SOURCE_BUNDLES) {
    globalIssues.push({
      code: "confirmatory_source_count_minimum_not_met",
      message: `Expected at least ${MINIMUM_PROVISIONAL_CONFIRMATORY_SOURCE_BUNDLES} source bundles; observed ${manifest.sources.length}.`
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
    passed: globalIssues.length === 0 && prepared.length === manifest.sources.length,
    source_count: manifest.sources.length,
    minimum_source_count: MINIMUM_PROVISIONAL_CONFIRMATORY_SOURCE_BUNDLES,
    declared_source_family_count: sourceFamilyCounts.size,
    minimum_source_family_count: MINIMUM_CONFIRMATORY_SOURCE_FAMILIES,
    largest_source_family_count: largestSourceFamilyCount,
    declared_operator_group_count: operatorGroupCounts.size,
    minimum_operator_group_count: MINIMUM_CONFIRMATORY_OPERATOR_GROUPS,
    largest_operator_group_count: largestOperatorGroupCount,
    maximum_group_share: MAXIMUM_CONFIRMATORY_GROUP_SHARE,
    artifact_verified_source_count: prepared.length,
    global_issues: globalIssues,
    sources: sourceAudits
  };
  return { report, prepared };
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

function parseIntakeManifest(value: unknown): PromotionConfirmatoryIntakeManifest {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.study_id) || !Array.isArray(value.sources)) {
    throw new Error("Promotion confirmatory intake requires schema_version=1.0, a study_id, and sources.");
  }
  if (value.sources.length === 0) throw new Error("Promotion confirmatory intake requires at least one source bundle.");
  const sourceIds = new Set<string>();
  const sources: PromotionConfirmatoryIntakeSource[] = value.sources.map((source, index) => {
    if (!isRecord(source) || !validId(source.source_id) || !nonEmptyString(source.source_root)
        || source.evidence_class !== "external_real_run" || !validId(source.source_family_id)
        || !validId(source.operator_group_id) || !nonEmptyString(source.source_revision)
        || (source.origin_kind !== "native" && source.origin_kind !== "projected" && source.origin_kind !== "normalized")
        || (source.distribution_scope !== "local_evaluation_only" && source.distribution_scope !== "redistributable")
        || (source.license_review_status !== "unreviewed" && source.license_review_status !== "human_verified")) {
      throw new Error(`Invalid promotion confirmatory source at index ${index + 1}.`);
    }
    if (sourceIds.has(source.source_id)) throw new Error(`Duplicate confirmatory source id: ${source.source_id}`);
    sourceIds.add(source.source_id);
    return {
      source_id: source.source_id,
      source_root: source.source_root,
      evidence_class: "external_real_run" as const,
      source_family_id: source.source_family_id,
      operator_group_id: source.operator_group_id,
      source_revision: source.source_revision,
      origin_kind: source.origin_kind,
      distribution_scope: source.distribution_scope,
      license_review_status: source.license_review_status
    };
  });
  return { schema_version: "1.0", study_id: value.study_id, sources };
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
