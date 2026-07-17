import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import { hashPromotionArtifactTree } from "./promotionBenchmark.js";
import {
  PROMOTION_SOURCE_NORMALIZATION_ANNOTATION_SCHEMA,
  PROMOTION_SOURCE_NORMALIZATION_REVIEWER_GUIDE,
  promotionSourceNormalizationAnnotationSchema,
  promotionSourceNormalizationOutputFields,
  promotionSourceNormalizationReviewerGuide,
  promotionSourceNormalizationRubric
} from "./promotionBenchmarkSourceNormalization.js";
import {
  inspectPromotionSourceProjection,
  PROMOTION_SOURCE_PROJECTION_MANIFEST
} from "./promotionBenchmarkSourceProjection.js";

export const PROMOTION_SOURCE_NORMALIZATION_BATCH_MANIFEST = "source-normalization-batch.json";
export const PROMOTION_SOURCE_NORMALIZATION_BATCH_MAP = "controller/source-normalization-batch-map.json";

export interface ExportPromotionSourceNormalizationBatchInput {
  cwd: string;
  recipePath: string;
  outDir: string;
}

export interface ExportPromotionSourceNormalizationBatchResult {
  batch_id: string;
  item_count: number;
  output_dir: string;
  reviewer_dir: string;
  tasks_path: string;
  controller_map_path: string;
  manifest_path: string;
}

export interface PromotionSourceNormalizationBatchItem {
  item_id: string;
  normalization_id: string;
  source_artifact_sha256: string;
  source_projection_manifest_sha256: string;
  source_family_id_sha256: string;
  operator_group_id_sha256: string;
  source_revision: string;
  reviewer_artifact_sha256: string;
}

export interface PromotionSourceNormalizationBatchOutput {
  path: string;
  sha256: string;
}

export interface PromotionSourceNormalizationBatchManifest {
  schema_version: "1.0";
  batch_id: string;
  item_count: number;
  rubric_sha256: string;
  reviewer_tasks_path: string;
  controller_map_path: string;
  items: PromotionSourceNormalizationBatchItem[];
  outputs: PromotionSourceNormalizationBatchOutput[];
  evidence_boundary: string;
}

export interface PromotionSourceNormalizationBatchIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionSourceNormalizationBatchInspection {
  passed: boolean;
  manifest: PromotionSourceNormalizationBatchManifest | null;
  issues: PromotionSourceNormalizationBatchIssue[];
}

interface BatchRecipeItem {
  item_id: string;
  source_root: string;
  pack_root: string;
}

interface BatchRecipe {
  schema_version: "1.0";
  batch_id: string;
  items: BatchRecipeItem[];
}

interface PrivateNormalizationMap {
  schema_version: "1.0";
  normalization_id: string;
  source_artifact_sha256: string;
  source_projection_manifest_sha256: string;
  source_family_id_sha256: string;
  operator_group_id_sha256: string;
  source_revision: string;
}

interface NormalizationTask {
  schema_version: "1.0";
  item_id?: string;
  normalization_id: string;
  artifact_root: string;
  required_output_fields: string[];
}

interface ControllerBatchMap {
  schema_version: "1.0";
  batch_id: string;
  reviewer_tasks_sha256: string;
  items: Array<{
    item_id: string;
    normalization_id: string;
    source_root: string;
    private_map_path: string;
    source_artifact_sha256: string;
    source_projection_manifest_sha256: string;
  }>;
  evidence_boundary: string;
}

export async function exportPromotionSourceNormalizationBatch(
  input: ExportPromotionSourceNormalizationBatchInput
): Promise<ExportPromotionSourceNormalizationBatchResult> {
  const cwd = path.resolve(input.cwd);
  const recipePath = path.resolve(cwd, input.recipePath);
  const outDir = path.resolve(cwd, input.outDir);
  const recipe = parseBatchRecipe(JSON.parse(await fs.readFile(recipePath, "utf8")) as unknown);
  if (await pathExists(outDir)) {
    throw new Error(`Source-normalization review batch already exists: ${portableRef(cwd, outDir)}`);
  }

  const prepared: Array<{
    recipe: BatchRecipeItem;
    privateMap: PrivateNormalizationMap;
    task: NormalizationTask;
    sourceRoot: string;
    artifactRoot: string;
  }> = [];
  for (const item of recipe.items) {
    const sourceRoot = path.resolve(cwd, item.source_root);
    const packRoot = path.resolve(cwd, item.pack_root);
    if (isSameOrContainedPath(sourceRoot, outDir) || isSameOrContainedPath(packRoot, outDir)) {
      throw new Error("Review-batch output must stay outside every source and normalization pack.");
    }
    const privateMapPath = path.join(packRoot, "private-normalization-map.json");
    const privateMap = parsePrivateMap(JSON.parse(await fs.readFile(privateMapPath, "utf8")) as unknown);
    const task = await readSingleTask(path.join(packRoot, "annotator", "normalization-tasks.jsonl"));
    if (task.normalization_id !== privateMap.normalization_id
        || task.artifact_root !== `artifacts/${privateMap.normalization_id}`) {
      throw new Error(`Normalization pack task/map mismatch for ${item.item_id}.`);
    }
    const projection = await inspectPromotionSourceProjection(sourceRoot);
    if (!projection.integrity_passed || !projection.manifest) {
      throw new Error(`Review batch requires an integrity-valid projection for ${item.item_id}.`);
    }
    const sourceHash = await hashPromotionArtifactTree(sourceRoot);
    const projectionManifestHash = await hashFile(path.join(sourceRoot, PROMOTION_SOURCE_PROJECTION_MANIFEST));
    if (sourceHash !== privateMap.source_artifact_sha256
        || projectionManifestHash !== privateMap.source_projection_manifest_sha256
        || projection.manifest.source_family_id_sha256 !== privateMap.source_family_id_sha256
        || projection.manifest.operator_group_id_sha256 !== privateMap.operator_group_id_sha256
        || projection.manifest.source_revision !== privateMap.source_revision) {
      throw new Error(`Normalization pack no longer matches its projected source for ${item.item_id}.`);
    }
    const artifactRoot = path.join(packRoot, "annotator", task.artifact_root);
    const artifactProjection = await inspectPromotionSourceProjection(artifactRoot);
    const artifactHash = await hashPromotionArtifactTree(artifactRoot);
    if (!artifactProjection.integrity_passed || artifactHash !== sourceHash) {
      throw new Error(`Reviewer artifact copy no longer matches its projected source for ${item.item_id}.`);
    }
    prepared.push({
      recipe: item,
      privateMap,
      task,
      sourceRoot,
      artifactRoot
    });
  }

  assertUnique(prepared.map((item) => item.privateMap.normalization_id), "normalization IDs");
  assertUnique(prepared.map((item) => item.privateMap.source_artifact_sha256), "source artifact hashes");
  assertUnique(prepared.map((item) => item.privateMap.source_projection_manifest_sha256), "source projection manifest hashes");
  const rubric = promotionSourceNormalizationRubric();
  const rubricSha256 = sha256(Buffer.from(rubric, "utf8"));

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    const reviewerRoot = path.join(stagingRoot, "reviewer");
    const reviewerArtifactsRoot = path.join(reviewerRoot, "artifacts");
    await fs.mkdir(reviewerArtifactsRoot, { recursive: true });
    await fs.writeFile(path.join(reviewerRoot, "RUBRIC.md"), rubric, "utf8");
    await writeJsonFile(
      path.join(reviewerRoot, PROMOTION_SOURCE_NORMALIZATION_ANNOTATION_SCHEMA),
      promotionSourceNormalizationAnnotationSchema()
    );
    await fs.writeFile(
      path.join(reviewerRoot, PROMOTION_SOURCE_NORMALIZATION_REVIEWER_GUIDE),
      promotionSourceNormalizationReviewerGuide(),
      "utf8"
    );

    const reviewerTasks = prepared
      .map((item) => JSON.stringify({
        schema_version: "1.0",
        item_id: item.recipe.item_id,
        normalization_id: item.privateMap.normalization_id,
        artifact_root: `artifacts/${item.privateMap.normalization_id}`,
        required_output_fields: promotionSourceNormalizationOutputFields()
      }))
      .join("\n") + "\n";
    const reviewerTasksPath = path.join(reviewerRoot, "normalization-tasks.jsonl");
    await fs.writeFile(reviewerTasksPath, reviewerTasks, "utf8");

    for (const item of prepared) {
      await fs.cp(
        item.artifactRoot,
        path.join(reviewerArtifactsRoot, item.privateMap.normalization_id),
        { recursive: true, errorOnExist: true, force: false }
      );
    }

    const controllerMap: ControllerBatchMap = {
      schema_version: "1.0",
      batch_id: recipe.batch_id,
      reviewer_tasks_sha256: sha256(Buffer.from(reviewerTasks, "utf8")),
      items: prepared.map((item) => ({
        item_id: item.recipe.item_id,
        normalization_id: item.privateMap.normalization_id,
        source_root: item.recipe.source_root,
        private_map_path: `${item.recipe.pack_root}/private-normalization-map.json`,
        source_artifact_sha256: item.privateMap.source_artifact_sha256,
        source_projection_manifest_sha256: item.privateMap.source_projection_manifest_sha256
      })),
      evidence_boundary: "This controller-only map reconnects opaque reviewer tasks to projected sources. It must not be distributed with the reviewer directory."
    };
    await writeJsonFile(path.join(stagingRoot, PROMOTION_SOURCE_NORMALIZATION_BATCH_MAP), controllerMap);

    const outputs = await inventoryOutputs(stagingRoot);
    const manifest: PromotionSourceNormalizationBatchManifest = {
      schema_version: "1.0",
      batch_id: recipe.batch_id,
      item_count: prepared.length,
      rubric_sha256: rubricSha256,
      reviewer_tasks_path: "reviewer/normalization-tasks.jsonl",
      controller_map_path: PROMOTION_SOURCE_NORMALIZATION_BATCH_MAP,
      items: prepared.map((item) => ({
        item_id: item.recipe.item_id,
        normalization_id: item.privateMap.normalization_id,
        source_artifact_sha256: item.privateMap.source_artifact_sha256,
        source_projection_manifest_sha256: item.privateMap.source_projection_manifest_sha256,
        source_family_id_sha256: item.privateMap.source_family_id_sha256,
        operator_group_id_sha256: item.privateMap.operator_group_id_sha256,
        source_revision: item.privateMap.source_revision,
        reviewer_artifact_sha256: item.privateMap.source_artifact_sha256
      })),
      outputs,
      evidence_boundary: "The reviewer directory contains opaque tasks, a common rubric, and hash-bound projected artifacts only. Packaging does not establish reviewer independence, human completion, source validity, or confirmatory eligibility."
    };
    await writeJsonFile(path.join(stagingRoot, PROMOTION_SOURCE_NORMALIZATION_BATCH_MANIFEST), manifest);
    const inspection = await inspectPromotionSourceNormalizationBatch(stagingRoot);
    if (!inspection.passed) {
      throw new Error(`Source-normalization review batch failed self-inspection: ${inspection.issues.map((issue) => issue.code).join(", ")}.`);
    }
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    batch_id: recipe.batch_id,
    item_count: prepared.length,
    output_dir: portableRef(cwd, outDir),
    reviewer_dir: portableRef(cwd, path.join(outDir, "reviewer")),
    tasks_path: portableRef(cwd, path.join(outDir, "reviewer", "normalization-tasks.jsonl")),
    controller_map_path: portableRef(cwd, path.join(outDir, PROMOTION_SOURCE_NORMALIZATION_BATCH_MAP)),
    manifest_path: portableRef(cwd, path.join(outDir, PROMOTION_SOURCE_NORMALIZATION_BATCH_MANIFEST))
  };
}

export async function inspectPromotionSourceNormalizationBatch(
  batchRoot: string
): Promise<PromotionSourceNormalizationBatchInspection> {
  const root = path.resolve(batchRoot);
  const issues: PromotionSourceNormalizationBatchIssue[] = [];
  let manifest: PromotionSourceNormalizationBatchManifest;
  try {
    manifest = parseBatchManifest(JSON.parse(
      await fs.readFile(path.join(root, PROMOTION_SOURCE_NORMALIZATION_BATCH_MANIFEST), "utf8")
    ) as unknown);
  } catch {
    return {
      passed: false,
      manifest: null,
      issues: [{
        code: "source_normalization_batch_manifest_unreadable",
        message: "The source-normalization batch manifest is missing or invalid."
      }]
    };
  }

  const expectedFiles = new Set([
    PROMOTION_SOURCE_NORMALIZATION_BATCH_MANIFEST,
    ...manifest.outputs.map((output) => output.path)
  ]);
  try {
    const observed = await listRegularFiles(root);
    for (const relativePath of observed) {
      if (!expectedFiles.has(relativePath)) {
        issues.push({
          code: "source_normalization_batch_untracked_artifact",
          message: "Review batches may contain only manifest-bound files.",
          ref: relativePath
        });
      }
    }
    for (const relativePath of expectedFiles) {
      if (!observed.includes(relativePath)) {
        issues.push({
          code: "source_normalization_batch_artifact_missing",
          message: "A manifest-bound review-batch artifact is missing.",
          ref: relativePath
        });
      }
    }
  } catch {
    issues.push({
      code: "source_normalization_batch_inventory_invalid",
      message: "The review batch contains an unreadable or non-regular filesystem entry."
    });
  }
  for (const output of manifest.outputs) {
    const actual = await hashContainedRegularFile(root, output.path).catch(() => null);
    if (!actual || actual !== output.sha256) {
      issues.push({
        code: "source_normalization_batch_output_hash_mismatch",
        message: "A review-batch output is missing or no longer matches its recorded hash.",
        ref: output.path
      });
    }
  }
  for (const reviewerFile of [
    `reviewer/${PROMOTION_SOURCE_NORMALIZATION_ANNOTATION_SCHEMA}`,
    `reviewer/${PROMOTION_SOURCE_NORMALIZATION_REVIEWER_GUIDE}`
  ]) {
    if (!manifest.outputs.some((output) => output.path === reviewerFile)) {
      issues.push({
        code: "source_normalization_batch_reviewer_contract_missing",
        message: "The reviewer JSON Schema and guide must be hash-bound batch outputs.",
        ref: reviewerFile
      });
    }
  }

  let controllerMap: ControllerBatchMap | null = null;
  try {
    controllerMap = parseControllerMap(JSON.parse(
      await fs.readFile(path.join(root, manifest.controller_map_path), "utf8")
    ) as unknown);
    if (controllerMap.batch_id !== manifest.batch_id
        || controllerMap.items.length !== manifest.item_count
        || controllerMap.reviewer_tasks_sha256 !== await hashFile(path.join(root, manifest.reviewer_tasks_path))) {
      throw new Error("mismatch");
    }
  } catch {
    issues.push({
      code: "source_normalization_batch_controller_map_invalid",
      message: "The controller-only item map is missing, changed, or inconsistent."
    });
  }

  const actualRubricSha256 = await hashContainedRegularFile(root, "reviewer/RUBRIC.md").catch(() => null);
  if (!actualRubricSha256 || actualRubricSha256 !== manifest.rubric_sha256) {
    issues.push({
      code: "source_normalization_batch_rubric_mismatch",
      message: "The reviewer rubric is missing or does not match the batch rubric hash.",
      ref: "reviewer/RUBRIC.md"
    });
  }

  try {
    const tasks = await readTasks(path.join(root, manifest.reviewer_tasks_path));
    const taskIds = tasks.map((task) => task.normalization_id).sort();
    const manifestIds = manifest.items.map((item) => item.normalization_id).sort();
    if (tasks.length !== manifest.item_count || taskIds.join("\u0000") !== manifestIds.join("\u0000")) {
      throw new Error("mismatch");
    }
    for (const task of tasks) {
      const item = manifest.items.find((candidate) => candidate.normalization_id === task.normalization_id);
      if (!item || task.item_id !== item.item_id
          || task.artifact_root !== `artifacts/${task.normalization_id}`
          || task.required_output_fields.join("\0") !== promotionSourceNormalizationOutputFields().join("\0")) {
        throw new Error("mismatch");
      }
      const artifactRoot = path.join(root, "reviewer", task.artifact_root);
      const artifactHash = await hashPromotionArtifactTree(artifactRoot);
      if (artifactHash !== item.reviewer_artifact_sha256) throw new Error("mismatch");
    }
  } catch {
    issues.push({
      code: "source_normalization_batch_reviewer_payload_invalid",
      message: "Reviewer tasks or artifact copies are missing, changed, duplicated, or inconsistent."
    });
  }

  if (manifest.controller_map_path.startsWith("reviewer/")
      || manifest.outputs.some((output) => output.path.startsWith("reviewer/controller/")
        || /^reviewer\/(?:.*\/)?private-normalization-map\.json$/u.test(output.path))) {
    issues.push({
      code: "source_normalization_batch_blinding_boundary_invalid",
      message: "Controller-private normalization maps must stay outside the reviewer directory."
    });
  }
  if (controllerMap) {
    const controllerIds = controllerMap.items
      .map((item) => `${item.item_id}:${item.normalization_id}`).sort();
    const manifestIds = manifest.items
      .map((item) => `${item.item_id}:${item.normalization_id}`).sort();
    if (controllerIds.join("\u0000") !== manifestIds.join("\u0000")) {
      issues.push({
        code: "source_normalization_batch_controller_identity_mismatch",
        message: "Controller and reviewer identities do not describe the same batch."
      });
    }
  }

  return { passed: issues.length === 0, manifest, issues };
}

function parseBatchRecipe(value: unknown): BatchRecipe {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.batch_id)
      || !Array.isArray(value.items) || value.items.length === 0) {
    throw new Error("Source-normalization batch recipe is invalid.");
  }
  const items = value.items.map((item, index) => {
    if (!isRecord(item) || !validId(item.item_id)
        || !safeRelativePath(item.source_root) || !safeRelativePath(item.pack_root)) {
      throw new Error(`Invalid source-normalization batch recipe item at index ${index + 1}.`);
    }
    return { item_id: item.item_id, source_root: item.source_root, pack_root: item.pack_root };
  });
  assertUnique(items.map((item) => item.item_id), "item IDs");
  assertUnique(items.map((item) => item.source_root), "source roots");
  assertUnique(items.map((item) => item.pack_root), "normalization pack roots");
  return { schema_version: "1.0", batch_id: value.batch_id, items };
}

function parsePrivateMap(value: unknown): PrivateNormalizationMap {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.normalization_id)
      || !sha256String(value.source_artifact_sha256) || !sha256String(value.source_projection_manifest_sha256)
      || !sha256String(value.source_family_id_sha256) || !sha256String(value.operator_group_id_sha256)
      || !nonEmptyString(value.source_revision)) {
    throw new Error("Private source-normalization map is invalid.");
  }
  return {
    schema_version: "1.0",
    normalization_id: value.normalization_id,
    source_artifact_sha256: value.source_artifact_sha256,
    source_projection_manifest_sha256: value.source_projection_manifest_sha256,
    source_family_id_sha256: value.source_family_id_sha256,
    operator_group_id_sha256: value.operator_group_id_sha256,
    source_revision: value.source_revision
  };
}

async function readSingleTask(taskPath: string): Promise<NormalizationTask> {
  const tasks = await readTasks(taskPath);
  if (tasks.length !== 1) throw new Error("Each source-normalization pack must contain exactly one task.");
  return tasks[0];
}

async function readTasks(taskPath: string): Promise<NormalizationTask[]> {
  const lines = (await fs.readFile(taskPath, "utf8")).split(/\r?\n/u).filter((line) => line.trim());
  return lines.map((line, index) => {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.normalization_id)
        || !safeRelativePath(value.artifact_root) || !nonEmptyStringArray(value.required_output_fields)) {
      throw new Error(`Invalid source-normalization task at line ${index + 1}.`);
    }
    return {
      schema_version: "1.0",
      ...(validId(value.item_id) ? { item_id: value.item_id } : {}),
      normalization_id: value.normalization_id,
      artifact_root: value.artifact_root,
      required_output_fields: [...value.required_output_fields]
    };
  });
}

function parseControllerMap(value: unknown): ControllerBatchMap {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.batch_id)
      || !sha256String(value.reviewer_tasks_sha256) || !Array.isArray(value.items)
      || value.items.length === 0 || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Source-normalization controller map is invalid.");
  }
  const items = value.items.map((item) => {
    if (!isRecord(item) || !validId(item.item_id) || !validId(item.normalization_id)
        || !safeRelativePath(item.source_root) || !safeRelativePath(item.private_map_path)
        || !sha256String(item.source_artifact_sha256)
        || !sha256String(item.source_projection_manifest_sha256)) {
      throw new Error("Source-normalization controller map item is invalid.");
    }
    return {
      item_id: item.item_id,
      normalization_id: item.normalization_id,
      source_root: item.source_root,
      private_map_path: item.private_map_path,
      source_artifact_sha256: item.source_artifact_sha256,
      source_projection_manifest_sha256: item.source_projection_manifest_sha256
    };
  });
  assertUnique(items.map((item) => item.item_id), "controller item IDs");
  assertUnique(items.map((item) => item.normalization_id), "controller normalization IDs");
  return {
    schema_version: "1.0",
    batch_id: value.batch_id,
    reviewer_tasks_sha256: value.reviewer_tasks_sha256,
    items,
    evidence_boundary: value.evidence_boundary
  };
}

function parseBatchManifest(value: unknown): PromotionSourceNormalizationBatchManifest {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.batch_id)
      || !positiveInteger(value.item_count) || !sha256String(value.rubric_sha256)
      || !safeRelativePath(value.reviewer_tasks_path) || !safeRelativePath(value.controller_map_path)
      || !Array.isArray(value.items) || value.items.length !== value.item_count
      || !Array.isArray(value.outputs) || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Source-normalization batch manifest is invalid.");
  }
  const items = value.items.map((item) => {
    if (!isRecord(item) || !validId(item.item_id) || !validId(item.normalization_id)
        || !sha256String(item.source_artifact_sha256)
        || !sha256String(item.source_projection_manifest_sha256)
        || !sha256String(item.source_family_id_sha256)
        || !sha256String(item.operator_group_id_sha256)
        || !nonEmptyString(item.source_revision)
        || !sha256String(item.reviewer_artifact_sha256)) {
      throw new Error("Source-normalization batch manifest item is invalid.");
    }
    return {
      item_id: item.item_id,
      normalization_id: item.normalization_id,
      source_artifact_sha256: item.source_artifact_sha256,
      source_projection_manifest_sha256: item.source_projection_manifest_sha256,
      source_family_id_sha256: item.source_family_id_sha256,
      operator_group_id_sha256: item.operator_group_id_sha256,
      source_revision: item.source_revision,
      reviewer_artifact_sha256: item.reviewer_artifact_sha256
    };
  });
  const outputs = value.outputs.map((output) => {
    if (!isRecord(output) || !safeRelativePath(output.path) || !sha256String(output.sha256)
        || output.path === PROMOTION_SOURCE_NORMALIZATION_BATCH_MANIFEST) {
      throw new Error("Source-normalization batch output is invalid.");
    }
    return { path: output.path, sha256: output.sha256 };
  });
  assertUnique(items.map((item) => item.item_id), "manifest item IDs");
  assertUnique(items.map((item) => item.normalization_id), "manifest normalization IDs");
  assertUnique(items.map((item) => item.source_artifact_sha256), "manifest source artifact hashes");
  assertUnique(outputs.map((output) => output.path), "manifest output paths");
  return {
    schema_version: "1.0",
    batch_id: value.batch_id,
    item_count: value.item_count,
    rubric_sha256: value.rubric_sha256,
    reviewer_tasks_path: value.reviewer_tasks_path,
    controller_map_path: value.controller_map_path,
    items,
    outputs,
    evidence_boundary: value.evidence_boundary
  };
}

async function inventoryOutputs(root: string): Promise<PromotionSourceNormalizationBatchOutput[]> {
  const files = (await listRegularFiles(root))
    .filter((relativePath) => relativePath !== PROMOTION_SOURCE_NORMALIZATION_BATCH_MANIFEST);
  const outputs = await Promise.all(files.map(async (relativePath) => ({
    path: relativePath,
    sha256: await hashFile(path.join(root, relativePath))
  })));
  return outputs.sort((left, right) => left.path.localeCompare(right.path));
}

async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("symbolic link");
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) files.push(path.relative(root, absolutePath).replace(/\\/gu, "/"));
      else throw new Error("non-regular entry");
    }
  };
  await visit(root);
  return files;
}

async function hashContainedRegularFile(root: string, relativePath: string): Promise<string> {
  if (!safeRelativePath(relativePath)) throw new Error("invalid path");
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("symbolic link");
  }
  const stat = await fs.stat(current);
  if (!stat.isFile()) throw new Error("not a regular file");
  return hashFile(current);
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Source-normalization batch ${label} must be unique.`);
  }
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.includes("\\")
    && !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString)
    && new Set(value).size === value.length;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
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
