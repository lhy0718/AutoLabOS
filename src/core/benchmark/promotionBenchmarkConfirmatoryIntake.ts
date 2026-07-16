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

interface PreparedSource {
  source_root: string;
  source_sha256: string;
  base_bundle_id: string;
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

  const variants = promotionVariantDefinitions();
  const mutationVariants = variants
    .filter((variant) => variant.mutation_family)
    .map((variant) => variant.operations);
  const prepared: PreparedSource[] = [];
  const seenHashes = new Map<string, string>();
  const seenBaseIds = new Set<string>();
  for (const source of manifest.sources) {
    const sourceRoot = path.resolve(manifestRoot, source.source_root);
    if (isSameOrContainedPath(sourceRoot, outDir)) {
      throw new Error(`Promotion confirmatory output must stay outside source bundles: ${source.source_id}`);
    }
    const sourceSha256 = await hashPromotionArtifactTree(sourceRoot);
    const priorSourceId = seenHashes.get(sourceSha256);
    if (priorSourceId) {
      throw new Error(`Confirmatory sources must be independent; ${source.source_id} duplicates ${priorSourceId}.`);
    }
    const baseBundleId = `base-${sourceSha256.slice(0, 20)}`;
    if (seenBaseIds.has(baseBundleId)) throw new Error(`Confirmatory base bundle id collision: ${baseBundleId}`);
    await validatePromotionMutationCompatibility(sourceRoot, mutationVariants);
    seenHashes.set(sourceSha256, source.source_id);
    seenBaseIds.add(baseBundleId);
    prepared.push({ source_root: sourceRoot, source_sha256: sourceSha256, base_bundle_id: baseBundleId });
  }
  prepared.sort((left, right) => left.source_sha256.localeCompare(right.source_sha256));

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
      intake_manifest_sha256: intakeManifestSha256,
      recipe_sha256: recipeSha256,
      base_bundle_count: prepared.length,
      case_count: cases.length,
      required_fault_families: variants.flatMap((variant) => variant.mutation_family ? [variant.mutation_family] : []),
      source_bundles: prepared.map((source) => ({
        base_bundle_id: source.base_bundle_id,
        source_sha256: source.source_sha256,
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

function parseIntakeManifest(value: unknown): PromotionConfirmatoryIntakeManifest {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.study_id) || !Array.isArray(value.sources)) {
    throw new Error("Promotion confirmatory intake requires schema_version=1.0, a study_id, and sources.");
  }
  if (value.sources.length < MINIMUM_CONFIRMATORY_BASE_BUNDLES) {
    throw new Error(`Promotion confirmatory intake requires at least ${MINIMUM_CONFIRMATORY_BASE_BUNDLES} source bundles.`);
  }
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
