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

export const MINIMUM_CONFIRMATORY_BASE_BUNDLES = 20;

export interface PromotionConfirmatoryIntakeSource {
  source_id: string;
  source_root: string;
  evidence_class: "external_real_run";
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
  passed: boolean;
  source_sha256: string | null;
  base_bundle_id: string | null;
  run_id_sha256: string | null;
  execution_fingerprint: string | null;
  evidence_manifest_sha256: string | null;
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
  evidence_artifact_count: number;
  evidence_roles: PromotionExecutionEvidenceRole[];
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
  if (manifest.sources.length < MINIMUM_CONFIRMATORY_BASE_BUNDLES) {
    throw new Error(`Promotion confirmatory intake requires at least ${MINIMUM_CONFIRMATORY_BASE_BUNDLES} source bundles.`);
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
      throw new Error("Confirmatory sources must be independent; duplicate source content was detected.");
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
      intake_manifest_sha256: intakeManifestSha256,
      recipe_sha256: recipeSha256,
      base_bundle_count: prepared.length,
      case_count: cases.length,
      required_fault_families: variants.flatMap((variant) => variant.mutation_family ? [variant.mutation_family] : []),
      source_bundles: prepared.map((source) => ({
        base_bundle_id: source.base_bundle_id,
        source_sha256: source.source_sha256,
        run_id_sha256: source.run_id_sha256,
        execution_fingerprint: source.execution_fingerprint,
        evidence_manifest_sha256: source.evidence_manifest_sha256,
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
      passed: false,
      source_sha256: sourceSha256,
      base_bundle_id: baseBundleId,
      run_id_sha256: evidence.run_id_sha256,
      execution_fingerprint: evidence.execution_fingerprint,
      evidence_manifest_sha256: evidence.evidence_manifest_sha256,
      evidence_artifact_count: evidence.artifact_count,
      evidence_roles: evidence.roles,
      issues
    };
    sourceAudits.push(audit);
    candidates.push({
      audit,
      ...(sourceSha256 && baseBundleId && evidence.run_id && evidence.run_id_sha256
        && evidence.execution_fingerprint && evidence.evidence_manifest_sha256
        ? {
            prepared: {
              source_root: sourceRoot,
              source_sha256: sourceSha256,
              base_bundle_id: baseBundleId,
              run_id: evidence.run_id,
              run_id_sha256: evidence.run_id_sha256,
              execution_fingerprint: evidence.execution_fingerprint,
              evidence_manifest_sha256: evidence.evidence_manifest_sha256,
              evidence_artifact_count: evidence.artifact_count,
              evidence_roles: evidence.roles
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
  if (manifest.sources.length < MINIMUM_CONFIRMATORY_BASE_BUNDLES) {
    globalIssues.push({
      code: "confirmatory_source_count_minimum_not_met",
      message: `Expected at least ${MINIMUM_CONFIRMATORY_BASE_BUNDLES} source bundles; observed ${manifest.sources.length}.`
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
    minimum_source_count: MINIMUM_CONFIRMATORY_BASE_BUNDLES,
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
  const sources = value.sources.map((source, index) => {
    if (!isRecord(source) || !validId(source.source_id) || !nonEmptyString(source.source_root)
        || source.evidence_class !== "external_real_run") {
      throw new Error(`Invalid promotion confirmatory source at index ${index + 1}.`);
    }
    if (sourceIds.has(source.source_id)) throw new Error(`Duplicate confirmatory source id: ${source.source_id}`);
    sourceIds.add(source.source_id);
    return {
      source_id: source.source_id,
      source_root: source.source_root,
      evidence_class: "external_real_run" as const
    };
  });
  return { schema_version: "1.0", study_id: value.study_id, sources };
}

function provisionalLabel(): PromotionBenchmarkRecipeCase["gold"] {
  return { decision: "needs_review", blocking_concerns: [], repair_owners: [] };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
