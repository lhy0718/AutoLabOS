import path from "node:path";
import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import { hashPromotionArtifactTree } from "./promotionBenchmark.js";
import { validatePromotionMutationCompatibility } from "./promotionBenchmarkBuilder.js";
import { inspectPromotionExecutionEvidence } from "./promotionBenchmarkExecutionEvidence.js";
import { promotionVariantDefinitions } from "./promotionBenchmarkVariants.js";

export const PROMOTION_SOURCE_PROJECTION_MANIFEST = "source-projection.json";
export const PROMOTION_SOURCE_LICENSE_FILE = "SOURCE_LICENSE.txt";

export type PromotionSourceDistributionScope = "local_evaluation_only" | "redistributable";
export type PromotionSourceLicenseReviewStatus = "unreviewed" | "human_verified";

export type PromotionSourceProjectionEntry =
  | { mode: "copy_file"; source_path: string; target_path: string }
  | {
      mode: "json_pointer";
      source_path: string;
      source_pointer: string;
      target_path: string;
      target_pointer: string;
    };

export interface PromotionSourceProjectionRecipe {
  schema_version: "1.0";
  projection_id: string;
  source_family_id: string;
  operator_group_id: string;
  source_revision: string;
  distribution_scope: PromotionSourceDistributionScope;
  license_review_status: PromotionSourceLicenseReviewStatus;
  license_path: string;
  entries: PromotionSourceProjectionEntry[];
}

export interface PromotionSourceProjectionIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionSourceProjectionOutputRecord {
  mode: PromotionSourceProjectionEntry["mode"];
  target_path: string;
  source_ref_sha256: string;
  source_sha256: string;
  output_sha256: string;
  source_pointer_sha256?: string;
  target_pointer?: string;
}

export interface PromotionSourceProjectionManifest {
  schema_version: "1.0";
  projection_id_sha256: string;
  source_family_id_sha256: string;
  operator_group_id_sha256: string;
  source_revision: string;
  distribution_scope: PromotionSourceDistributionScope;
  license_review_status: PromotionSourceLicenseReviewStatus;
  raw_source_sha256: string;
  recipe_sha256: string;
  license_sha256: string;
  artifact_set_sha256: string;
  promotion_compatible: boolean;
  execution_evidence_verified: boolean;
  ready_for_confirmatory_intake: boolean;
  outputs: PromotionSourceProjectionOutputRecord[];
  issues: PromotionSourceProjectionIssue[];
  evidence_boundary: string;
}

export interface ProjectPromotionSourceInput {
  cwd: string;
  sourceRoot: string;
  recipePath: string;
  outDir: string;
}

export interface ProjectPromotionSourceResult {
  output_dir: string;
  manifest_path: string;
  manifest: PromotionSourceProjectionManifest;
}

export interface PromotionSourceProjectionInspection {
  integrity_passed: boolean;
  confirmatory_ready: boolean;
  passed: boolean;
  manifest: PromotionSourceProjectionManifest | null;
  issues: PromotionSourceProjectionIssue[];
}

const MAX_SCANNABLE_TEXT_BYTES = 64 * 1024 * 1024;
const SENSITIVE_PATH_PATTERN = /(?:^|\/)(?:\.env(?:\..*)?|.*api[-_]?keys?.*|.*credentials?.*|.*private[-_]?keys?.*|.*secrets?.*|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/iu;
const SECRET_TEXT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\b(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_+\/=.-]{16,}/iu
] as const;

export async function projectPromotionSource(
  input: ProjectPromotionSourceInput
): Promise<ProjectPromotionSourceResult> {
  const cwd = path.resolve(input.cwd);
  const sourceRoot = path.resolve(cwd, input.sourceRoot);
  const recipePath = path.resolve(cwd, input.recipePath);
  const outDir = path.resolve(cwd, input.outDir);
  const recipeBytes = await fs.readFile(recipePath);
  const recipe = parseProjectionRecipe(JSON.parse(recipeBytes.toString("utf8")) as unknown);
  if (!(await directoryExists(sourceRoot))) throw new Error("Promotion projection source must be an existing directory.");
  if (isSameOrContainedPath(sourceRoot, outDir)) {
    throw new Error("Promotion projection output must stay outside the raw source tree.");
  }
  if (await pathExists(outDir)) throw new Error(`Promotion projection output already exists: ${portableRef(cwd, outDir)}`);

  const rawSourceSha256 = await hashPromotionArtifactTree(sourceRoot);
  const license = await loadSelectedSourceFile(sourceRoot, recipe.license_path);
  const planned = await planProjection(sourceRoot, recipe.entries);
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    const outputs: PromotionSourceProjectionOutputRecord[] = [];
    for (const item of planned) {
      const target = path.join(stagingRoot, item.targetPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (item.mode === "copy_file") {
        await fs.copyFile(item.sourceFile.absolutePath, target, fsConstants.COPYFILE_EXCL);
        outputs.push({
          mode: item.mode,
          target_path: item.targetPath,
          source_ref_sha256: sha256Text(item.sourceFile.relativePath),
          source_sha256: item.sourceFile.sha256,
          output_sha256: await hashFile(target)
        });
      } else {
        await writeJsonFile(target, item.value);
        outputs.push(...item.bindings.map((binding) => ({
          mode: "json_pointer" as const,
          target_path: item.targetPath,
          source_ref_sha256: sha256Text(binding.sourceFile.relativePath),
          source_sha256: binding.sourceFile.sha256,
          output_sha256: "",
          source_pointer_sha256: sha256Text(binding.sourcePointer),
          target_pointer: binding.targetPointer
        })));
        const outputSha256 = await hashFile(target);
        for (const output of outputs) {
          if (output.target_path === item.targetPath && output.mode === "json_pointer" && !output.output_sha256) {
            output.output_sha256 = outputSha256;
          }
        }
      }
    }
    await fs.copyFile(license.absolutePath, path.join(stagingRoot, PROMOTION_SOURCE_LICENSE_FILE), fsConstants.COPYFILE_EXCL);

    const issues: PromotionSourceProjectionIssue[] = [];
    let promotionCompatible = true;
    try {
      await validatePromotionMutationCompatibility(
        stagingRoot,
        promotionVariantDefinitions().filter((variant) => variant.mutation_family).map((variant) => variant.operations)
      );
    } catch {
      promotionCompatible = false;
      issues.push({
        code: "source_projection_mutation_contract_incomplete",
        message: "Projected artifacts do not yet satisfy every canonical promotion mutation target."
      });
    }
    const executionEvidence = await inspectPromotionExecutionEvidence(stagingRoot);
    if (!executionEvidence.passed) {
      issues.push({
        code: "source_projection_execution_evidence_unverified",
        message: "Projected artifacts do not contain a passing hash-bound real-execution evidence manifest."
      });
    }
    if (recipe.distribution_scope !== "redistributable") {
      issues.push({
        code: "source_projection_distribution_local_only",
        message: "The source projection is restricted to local evaluation and cannot enter a public confirmatory corpus."
      });
    }
    if (recipe.license_review_status !== "human_verified") {
      issues.push({
        code: "source_projection_license_review_required",
        message: "A human license review is required before public confirmatory use."
      });
    }

    outputs.sort(compareProjectionOutputs);
    const licenseSha256 = await hashFile(path.join(stagingRoot, PROMOTION_SOURCE_LICENSE_FILE));
    const artifactSetSha256 = hashArtifactSet(outputs, licenseSha256);
    const manifest: PromotionSourceProjectionManifest = {
      schema_version: "1.0",
      projection_id_sha256: sha256Text(recipe.projection_id),
      source_family_id_sha256: sha256Text(recipe.source_family_id),
      operator_group_id_sha256: sha256Text(recipe.operator_group_id),
      source_revision: recipe.source_revision,
      distribution_scope: recipe.distribution_scope,
      license_review_status: recipe.license_review_status,
      raw_source_sha256: rawSourceSha256,
      recipe_sha256: sha256(recipeBytes),
      license_sha256: licenseSha256,
      artifact_set_sha256: artifactSetSha256,
      promotion_compatible: promotionCompatible,
      execution_evidence_verified: executionEvidence.passed,
      ready_for_confirmatory_intake: issues.length === 0,
      outputs,
      issues,
      evidence_boundary: "Projection verifies selected source bytes and deterministic JSON-pointer extraction. It does not prove execution occurrence, operator identity, license ownership, or scientific validity."
    };
    await writeJsonFile(path.join(stagingRoot, PROMOTION_SOURCE_PROJECTION_MANIFEST), manifest);
    await fs.rename(stagingRoot, outDir);
    return {
      output_dir: portableRef(cwd, outDir),
      manifest_path: portableRef(cwd, path.join(outDir, PROMOTION_SOURCE_PROJECTION_MANIFEST)),
      manifest
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectPromotionSourceProjection(
  bundleRoot: string
): Promise<PromotionSourceProjectionInspection> {
  const root = path.resolve(bundleRoot);
  const manifestPath = path.join(root, PROMOTION_SOURCE_PROJECTION_MANIFEST);
  const issues: PromotionSourceProjectionIssue[] = [];
  let manifest: PromotionSourceProjectionManifest;
  try {
    manifest = parseProjectionManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown);
  } catch {
    return {
      integrity_passed: false,
      confirmatory_ready: false,
      passed: false,
      manifest: null,
      issues: [{ code: "source_projection_manifest_unreadable", message: "The source projection manifest is missing or invalid." }]
    };
  }

  const outputPaths = new Map<string, string>();
  for (const output of manifest.outputs) {
    const absolute = resolveContainedPath(root, output.target_path);
    if (!absolute || output.target_path === PROMOTION_SOURCE_PROJECTION_MANIFEST) {
      issues.push({ code: "source_projection_output_path_invalid", message: "A projected output path is invalid." });
      continue;
    }
    const actual = await hashRegularFileWithoutSymlinks(root, output.target_path).catch(() => null);
    if (!actual || actual !== output.output_sha256) {
      issues.push({ code: "source_projection_output_hash_mismatch", message: "A projected output is missing or no longer matches its recorded hash.", ref: output.target_path });
    }
    const prior = outputPaths.get(output.target_path);
    if (prior && prior !== output.output_sha256) {
      issues.push({ code: "source_projection_output_record_conflict", message: "Projected output records disagree on the output hash.", ref: output.target_path });
    }
    outputPaths.set(output.target_path, output.output_sha256);
  }
  const expectedFiles = new Set([
    ...manifest.outputs.map((output) => output.target_path),
    PROMOTION_SOURCE_LICENSE_FILE,
    PROMOTION_SOURCE_PROJECTION_MANIFEST
  ]);
  try {
    for (const relativePath of await listRegularFiles(root)) {
      if (!expectedFiles.has(relativePath)) {
        issues.push({
          code: "source_projection_untracked_artifact",
          message: "Projected bundles may contain only manifest-bound output and license files.",
          ref: relativePath
        });
      }
    }
  } catch {
    issues.push({
      code: "source_projection_file_inventory_invalid",
      message: "The projected bundle contains an unreadable or non-regular filesystem entry."
    });
  }
  const licenseSha256 = await hashRegularFileWithoutSymlinks(root, PROMOTION_SOURCE_LICENSE_FILE).catch(() => null);
  if (!licenseSha256 || licenseSha256 !== manifest.license_sha256) {
    issues.push({ code: "source_projection_license_hash_mismatch", message: "The projected source license is missing or no longer matches its recorded hash." });
  }
  if (licenseSha256 && hashArtifactSet(manifest.outputs, licenseSha256) !== manifest.artifact_set_sha256) {
    issues.push({ code: "source_projection_artifact_set_hash_mismatch", message: "The projected artifact set no longer matches its manifest." });
  }
  const integrityPassed = issues.length === 0;
  if (!manifest.ready_for_confirmatory_intake || !manifest.promotion_compatible || !manifest.execution_evidence_verified) {
    issues.push({ code: "source_projection_not_confirmatory_ready", message: "The projection was not prepared as a confirmatory-ready source bundle." });
  }
  if (manifest.distribution_scope !== "redistributable" || manifest.license_review_status !== "human_verified") {
    issues.push({ code: "source_projection_redistribution_unverified", message: "Public redistribution and human license review are required for confirmatory intake." });
  }
  const confirmatoryReady = integrityPassed && issues.length === 0;
  return {
    integrity_passed: integrityPassed,
    confirmatory_ready: confirmatoryReady,
    passed: confirmatoryReady,
    manifest,
    issues
  };
}

type SelectedSourceFile = {
  absolutePath: string;
  relativePath: string;
  bytes: Uint8Array;
  sha256: string;
};

type PlannedProjection =
  | { mode: "copy_file"; targetPath: string; sourceFile: SelectedSourceFile }
  | {
      mode: "json_pointer";
      targetPath: string;
      value: unknown;
      bindings: ProjectionBinding[];
    };

type ProjectionBinding = {
  sourceFile: SelectedSourceFile;
  sourcePointer: string;
  targetPointer: string;
};

async function planProjection(
  sourceRoot: string,
  entries: PromotionSourceProjectionEntry[]
): Promise<PlannedProjection[]> {
  const copiedTargets = new Set<string>();
  const jsonTargets = new Map<string, { value: unknown; bindings: ProjectionBinding[]; pointers: Set<string> }>();
  const selectedFiles = new Map<string, SelectedSourceFile>();
  const load = async (relativePath: string): Promise<SelectedSourceFile> => {
    const cached = selectedFiles.get(relativePath);
    if (cached) return cached;
    const file = await loadSelectedSourceFile(sourceRoot, relativePath);
    selectedFiles.set(relativePath, file);
    return file;
  };

  for (const entry of entries) {
    if (entry.target_path === PROMOTION_SOURCE_PROJECTION_MANIFEST || entry.target_path === PROMOTION_SOURCE_LICENSE_FILE) {
      throw new Error(`Projection target is reserved: ${entry.target_path}`);
    }
    const sourceFile = await load(entry.source_path);
    if (entry.mode === "copy_file") {
      if (copiedTargets.has(entry.target_path) || jsonTargets.has(entry.target_path)) {
        throw new Error(`Projection target is assigned more than once: ${entry.target_path}`);
      }
      copiedTargets.add(entry.target_path);
      continue;
    }
    if (copiedTargets.has(entry.target_path)) throw new Error(`Projection target mixes copy and JSON modes: ${entry.target_path}`);
    const group = jsonTargets.get(entry.target_path) || {
      value: containerForPointer(entry.target_pointer),
      bindings: [],
      pointers: new Set<string>()
    };
    if (group.pointers.has(entry.target_pointer)) {
      throw new Error(`Projection target pointer is assigned more than once: ${entry.target_path}${entry.target_pointer}`);
    }
    const sourceValue = resolveJsonPointer(JSON.parse(Buffer.from(sourceFile.bytes).toString("utf8")) as unknown, entry.source_pointer);
    setJsonPointerCreating(group.value, entry.target_pointer, structuredClone(sourceValue));
    group.bindings.push({ sourceFile, sourcePointer: entry.source_pointer, targetPointer: entry.target_pointer });
    group.pointers.add(entry.target_pointer);
    jsonTargets.set(entry.target_path, group);
  }

  const planned: PlannedProjection[] = [];
  for (const entry of entries) {
    if (entry.mode !== "copy_file") continue;
    planned.push({ mode: "copy_file", targetPath: entry.target_path, sourceFile: await load(entry.source_path) });
  }
  for (const [targetPath, group] of jsonTargets) {
    planned.push({ mode: "json_pointer", targetPath, value: group.value, bindings: group.bindings });
  }
  planned.sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  return planned;
}

async function loadSelectedSourceFile(sourceRoot: string, relativePath: string): Promise<SelectedSourceFile> {
  if (!safeRelativePath(relativePath)) throw new Error("Projection source paths must be portable and relative.");
  if (SENSITIVE_PATH_PATTERN.test(relativePath.replace(/\\/gu, "/"))) {
    throw new Error(`Projection source path is sensitive and cannot be selected: ${relativePath}`);
  }
  const absolutePath = resolveContainedPath(sourceRoot, relativePath);
  if (!absolutePath) throw new Error("Projection source path escapes the raw source tree.");
  await assertNoSymlinkPath(sourceRoot, relativePath);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Projection source must be a non-empty regular file: ${relativePath}`);
  const bytes = await fs.readFile(absolutePath);
  scanSelectedBytes(relativePath, bytes);
  return { absolutePath, relativePath, bytes, sha256: sha256(bytes) };
}

async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("symbolic link");
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolutePath).replace(/\\/gu, "/"));
      } else {
        throw new Error("non-regular entry");
      }
    }
  };
  await visit(root);
  return files;
}

function scanSelectedBytes(relativePath: string, bytes: Uint8Array): void {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return;
  if (bytes.length > MAX_SCANNABLE_TEXT_BYTES) {
    throw new Error(`Selected text file is too large for a complete secret scan: ${relativePath}`);
  }
  const text = Buffer.from(bytes).toString("utf8");
  if (SECRET_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`Selected source file contains a credential-like value and cannot be projected: ${relativePath}`);
  }
}

function parseProjectionRecipe(value: unknown): PromotionSourceProjectionRecipe {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.projection_id)
      || !validId(value.source_family_id) || !validId(value.operator_group_id)
      || !nonEmptyString(value.source_revision) || !isDistributionScope(value.distribution_scope)
      || !isLicenseReviewStatus(value.license_review_status) || !safeRelativePath(value.license_path)
      || !Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error("Promotion source projection recipe is invalid or incomplete.");
  }
  return {
    schema_version: "1.0",
    projection_id: value.projection_id,
    source_family_id: value.source_family_id,
    operator_group_id: value.operator_group_id,
    source_revision: value.source_revision,
    distribution_scope: value.distribution_scope,
    license_review_status: value.license_review_status,
    license_path: value.license_path,
    entries: value.entries.map(parseProjectionEntry)
  };
}

function parseProjectionEntry(value: unknown, index: number): PromotionSourceProjectionEntry {
  if (!isRecord(value) || !safeRelativePath(value.source_path) || !safeRelativePath(value.target_path)) {
    throw new Error(`Invalid source projection entry at index ${index + 1}.`);
  }
  if (value.mode === "copy_file") {
    return { mode: value.mode, source_path: value.source_path, target_path: value.target_path };
  }
  if (value.mode === "json_pointer" && validJsonPointer(value.source_pointer) && validJsonPointer(value.target_pointer)) {
    return {
      mode: value.mode,
      source_path: value.source_path,
      source_pointer: value.source_pointer,
      target_path: value.target_path,
      target_pointer: value.target_pointer
    };
  }
  throw new Error(`Invalid source projection mode or pointer at index ${index + 1}.`);
}

function parseProjectionManifest(value: unknown): PromotionSourceProjectionManifest {
  if (!isRecord(value) || value.schema_version !== "1.0" || !sha256String(value.projection_id_sha256)
      || !sha256String(value.source_family_id_sha256) || !sha256String(value.operator_group_id_sha256)
      || !nonEmptyString(value.source_revision) || !isDistributionScope(value.distribution_scope)
      || !isLicenseReviewStatus(value.license_review_status) || !sha256String(value.raw_source_sha256)
      || !sha256String(value.recipe_sha256) || !sha256String(value.license_sha256)
      || !sha256String(value.artifact_set_sha256) || typeof value.promotion_compatible !== "boolean"
      || typeof value.execution_evidence_verified !== "boolean" || typeof value.ready_for_confirmatory_intake !== "boolean"
      || !Array.isArray(value.outputs) || !Array.isArray(value.issues) || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Promotion source projection manifest is invalid.");
  }
  const outputs: PromotionSourceProjectionOutputRecord[] = value.outputs.map((output, index) => {
    if (!isRecord(output) || (output.mode !== "copy_file" && output.mode !== "json_pointer")
        || !safeRelativePath(output.target_path) || !sha256String(output.source_ref_sha256)
        || !sha256String(output.source_sha256) || !sha256String(output.output_sha256)) {
      throw new Error(`Invalid source projection output at index ${index + 1}.`);
    }
    if (output.mode === "json_pointer" && (!sha256String(output.source_pointer_sha256) || !validJsonPointer(output.target_pointer))) {
      throw new Error(`Invalid JSON source projection output at index ${index + 1}.`);
    }
    return {
      mode: output.mode,
      target_path: output.target_path,
      source_ref_sha256: output.source_ref_sha256,
      source_sha256: output.source_sha256,
      output_sha256: output.output_sha256,
      ...(output.mode === "json_pointer"
        ? { source_pointer_sha256: output.source_pointer_sha256 as string, target_pointer: output.target_pointer as string }
        : {})
    };
  });
  const issues = value.issues.map((issue, index) => {
    if (!isRecord(issue) || !nonEmptyString(issue.code) || !nonEmptyString(issue.message)
        || (issue.ref !== undefined && !nonEmptyString(issue.ref))) {
      throw new Error(`Invalid source projection issue at index ${index + 1}.`);
    }
    return { code: issue.code, message: issue.message, ...(issue.ref ? { ref: issue.ref } : {}) };
  });
  return {
    schema_version: "1.0",
    projection_id_sha256: value.projection_id_sha256,
    source_family_id_sha256: value.source_family_id_sha256,
    operator_group_id_sha256: value.operator_group_id_sha256,
    source_revision: value.source_revision,
    distribution_scope: value.distribution_scope,
    license_review_status: value.license_review_status,
    raw_source_sha256: value.raw_source_sha256,
    recipe_sha256: value.recipe_sha256,
    license_sha256: value.license_sha256,
    artifact_set_sha256: value.artifact_set_sha256,
    promotion_compatible: value.promotion_compatible,
    execution_evidence_verified: value.execution_evidence_verified,
    ready_for_confirmatory_intake: value.ready_for_confirmatory_intake,
    outputs,
    issues,
    evidence_boundary: value.evidence_boundary
  };
}

function resolveJsonPointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const part of decodePointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(part)) throw new Error(`JSON pointer array index is invalid: ${pointer}`);
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) throw new Error(`JSON pointer does not exist: ${pointer}`);
      current = current[index];
    } else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
    } else {
      throw new Error(`JSON pointer does not exist: ${pointer}`);
    }
  }
  return current;
}

function setJsonPointerCreating(root: unknown, pointer: string, value: unknown): void {
  const parts = decodePointer(pointer);
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const nextIsArray = /^\d+$/u.test(parts[index + 1]);
    if (Array.isArray(current)) {
      const arrayIndex = parseProjectionArrayIndex(part, current.length, true);
      if (current[arrayIndex] === undefined) current[arrayIndex] = nextIsArray ? [] : {};
      current = current[arrayIndex];
    } else if (isRecord(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, part)) current[part] = nextIsArray ? [] : {};
      current = current[part];
    } else {
      throw new Error(`Projection target pointer conflicts with an existing value: ${pointer}`);
    }
  }
  const key = parts[parts.length - 1];
  if (Array.isArray(current)) {
    const arrayIndex = parseProjectionArrayIndex(key, current.length, true);
    if (current[arrayIndex] !== undefined) throw new Error(`Projection target pointer already exists: ${pointer}`);
    current[arrayIndex] = value;
  } else if (isRecord(current)) {
    if (Object.prototype.hasOwnProperty.call(current, key)) throw new Error(`Projection target pointer already exists: ${pointer}`);
    current[key] = value;
  } else {
    throw new Error(`Projection target pointer conflicts with an existing value: ${pointer}`);
  }
}

function containerForPointer(pointer: string): unknown {
  return /^\/\d+(?:\/|$)/u.test(pointer) ? [] : {};
}

function decodePointer(pointer: string): string[] {
  return pointer.slice(1).split("/").map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function parseProjectionArrayIndex(value: string, length: number, allowAppend: boolean): number {
  if (!/^\d+$/u.test(value)) throw new Error(`Invalid projection array index: ${value}`);
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index > length || (!allowAppend && index === length)) {
    throw new Error(`Projection array index is out of range: ${value}`);
  }
  return index;
}

async function assertNoSymlinkPath(root: string, relativePath: string): Promise<void> {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in projection source paths: ${relativePath}`);
  }
}

async function hashRegularFileWithoutSymlinks(root: string, relativePath: string): Promise<string> {
  await assertNoSymlinkPath(root, relativePath);
  const absolute = path.join(root, relativePath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error("Projected output is not a regular file.");
  return hashFile(absolute);
}

function hashArtifactSet(outputs: PromotionSourceProjectionOutputRecord[], licenseSha256: string): string {
  const records = outputs.map((output) => ({
    mode: output.mode,
    target_path: output.target_path,
    output_sha256: output.output_sha256,
    source_ref_sha256: output.source_ref_sha256,
    source_sha256: output.source_sha256,
    ...(output.source_pointer_sha256 ? { source_pointer_sha256: output.source_pointer_sha256 } : {}),
    ...(output.target_pointer ? { target_pointer: output.target_pointer } : {})
  }));
  return sha256Text(JSON.stringify({ license_sha256: licenseSha256, outputs: records }));
}

function compareProjectionOutputs(left: PromotionSourceProjectionOutputRecord, right: PromotionSourceProjectionOutputRecord): number {
  return left.target_path.localeCompare(right.target_path)
    || (left.target_pointer || "").localeCompare(right.target_pointer || "")
    || left.source_ref_sha256.localeCompare(right.source_ref_sha256);
}

function resolveContainedPath(root: string, relativePath: string): string | undefined {
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? resolved : undefined;
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.includes("\\")
    && !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function validJsonPointer(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length > 1
    && !/(?:^|[^~])~(?:[^01]|$)/u.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isDistributionScope(value: unknown): value is PromotionSourceDistributionScope {
  return value === "local_evaluation_only" || value === "redistributable";
}

function isLicenseReviewStatus(value: unknown): value is PromotionSourceLicenseReviewStatus {
  return value === "unreviewed" || value === "human_verified";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function hashFile(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
}

function isSameOrContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function directoryExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : path.basename(absolutePath);
}
