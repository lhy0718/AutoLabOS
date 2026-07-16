import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  PROMOTION_DECISIONS,
  hashPromotionArtifactTree,
  type PromotionBenchmarkCaseManifest,
  type PromotionBenchmarkAdjudicationStatus,
  type PromotionBenchmarkEvidenceClass,
  type PromotionBenchmarkMutationIsolationStatus,
  type PromotionBenchmarkSplit,
  type PromotionDecision
} from "./promotionBenchmark.js";

export type PromotionMutationOperation =
  | { op: "delete_path"; path: string }
  | { op: "set_json_pointer"; path: string; pointer: string; value: unknown }
  | { op: "remove_json_pointer"; path: string; pointer: string };

export interface PromotionBenchmarkRecipeCase {
  case_id: string;
  base_bundle_id: string;
  split: PromotionBenchmarkSplit;
  source_root: string;
  mutation_family?: string;
  operations: PromotionMutationOperation[];
  gold: {
    decision: PromotionDecision;
    blocking_concerns: string[];
    repair_owners: string[];
  };
}

export interface PromotionBenchmarkRecipe {
  schema_version: "1.0";
  suite_id: string;
  evidence_class?: PromotionBenchmarkEvidenceClass;
  paper_claim_eligible?: boolean;
  adjudication_status?: PromotionBenchmarkAdjudicationStatus;
  mutation_isolation_status?: PromotionBenchmarkMutationIsolationStatus;
  cases: PromotionBenchmarkRecipeCase[];
}

export interface PromotionMutationRecord {
  index: number;
  operation: PromotionMutationOperation;
  before_sha256: string | null;
  after_sha256: string | null;
}

export interface PromotionMutationManifest {
  schema_version: "1.0";
  case_id: string;
  base_bundle_id: string;
  source_sha256: string;
  artifact_sha256: string;
  mutation_family?: string;
  operations: PromotionMutationRecord[];
}

export interface BuildPromotionBenchmarkInput {
  cwd: string;
  recipePath: string;
  outDir: string;
}

export interface BuildPromotionBenchmarkResult {
  suite_id: string;
  case_count: number;
  case_ids: string[];
  output_dir: string;
  suite_path: string;
}

export async function buildPromotionBenchmarkSuite(
  input: BuildPromotionBenchmarkInput
): Promise<BuildPromotionBenchmarkResult> {
  const cwd = path.resolve(input.cwd);
  const recipePath = path.resolve(cwd, input.recipePath);
  const recipeRoot = path.dirname(recipePath);
  const outDir = path.resolve(cwd, input.outDir);
  const recipe = parseRecipe(JSON.parse(await fs.readFile(recipePath, "utf8")));
  await validateRecipeSources(recipe, recipeRoot);
  if (await pathExists(outDir)) {
    throw new Error(`Promotion benchmark output already exists: ${portableRef(cwd, outDir)}`);
  }

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    const caseRefs: string[] = [];
    for (const recipeCase of recipe.cases) {
      const sourceRoot = resolveContainedPath(recipeRoot, recipeCase.source_root);
      if (!sourceRoot) throw new Error(`Source root escapes recipe directory: ${recipeCase.case_id}`);
      const artifactRoot = path.join(stagingRoot, "artifacts", recipeCase.case_id);
      await fs.mkdir(path.dirname(artifactRoot), { recursive: true });
      const sourceHash = await hashPromotionArtifactTree(sourceRoot);
      await fs.cp(sourceRoot, artifactRoot, { recursive: true, errorOnExist: true, force: false });
      const mutationRecords: PromotionMutationRecord[] = [];
      for (const [index, operation] of recipeCase.operations.entries()) {
        mutationRecords.push(await applyMutation(artifactRoot, operation, index + 1));
      }
      const artifactHash = await hashPromotionArtifactTree(artifactRoot);
      const mutationManifest: PromotionMutationManifest = {
        schema_version: "1.0",
        case_id: recipeCase.case_id,
        base_bundle_id: recipeCase.base_bundle_id,
        source_sha256: sourceHash,
        artifact_sha256: artifactHash,
        ...(recipeCase.mutation_family ? { mutation_family: recipeCase.mutation_family } : {}),
        operations: mutationRecords
      };
      const provenancePath = path.join(stagingRoot, "provenance", `${recipeCase.case_id}.json`);
      await writeJsonFile(provenancePath, mutationManifest);

      const caseManifest: PromotionBenchmarkCaseManifest = {
        schema_version: "1.0",
        case_id: recipeCase.case_id,
        base_bundle_id: recipeCase.base_bundle_id,
        split: recipeCase.split,
        artifact_root: `../artifacts/${recipeCase.case_id}`,
        source_sha256: sourceHash,
        artifact_sha256: artifactHash,
        mutation_manifest: `../provenance/${recipeCase.case_id}.json`,
        ...(recipeCase.mutation_family ? { mutation_family: recipeCase.mutation_family } : {}),
        gold: recipeCase.gold
      };
      const caseRef = `cases/${recipeCase.case_id}.json`;
      await writeJsonFile(path.join(stagingRoot, caseRef), caseManifest);
      caseRefs.push(caseRef);
    }
    await writeJsonFile(path.join(stagingRoot, "suite.json"), {
      schema_version: "1.0",
      suite_id: recipe.suite_id,
      ...(recipe.evidence_class ? { evidence_class: recipe.evidence_class } : {}),
      ...(typeof recipe.paper_claim_eligible === "boolean" ? { paper_claim_eligible: recipe.paper_claim_eligible } : {}),
      ...(recipe.adjudication_status ? { adjudication_status: recipe.adjudication_status } : {}),
      ...(recipe.mutation_isolation_status ? { mutation_isolation_status: recipe.mutation_isolation_status } : {}),
      cases: caseRefs
    });
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    suite_id: recipe.suite_id,
    case_count: recipe.cases.length,
    case_ids: recipe.cases.map((recipeCase) => recipeCase.case_id),
    output_dir: portableRef(cwd, outDir),
    suite_path: portableRef(cwd, path.join(outDir, "suite.json"))
  };
}

export async function validatePromotionMutationCompatibility(
  sourceRoot: string,
  variants: ReadonlyArray<ReadonlyArray<PromotionMutationOperation>>
): Promise<void> {
  const root = path.resolve(sourceRoot);
  if (!(await directoryExists(root))) throw new Error("Promotion mutation source must be an existing directory.");
  await hashPromotionArtifactTree(root);

  for (const [variantIndex, operations] of variants.entries()) {
    const jsonSnapshots = new Map<string, unknown>();
    const deletedPaths = new Set<string>();
    for (const [operationIndex, operation] of operations.entries()) {
      const target = resolveContainedPath(root, operation.path);
      const ref = `variant ${variantIndex + 1}, operation ${operationIndex + 1}`;
      if (!target || target === root) throw new Error(`Mutation target escapes source root at ${ref}: ${operation.path}`);
      if ([...deletedPaths].some((deleted) => target === deleted || target.startsWith(`${deleted}${path.sep}`))) {
        throw new Error(`Mutation target was deleted earlier at ${ref}: ${operation.path}`);
      }
      const stat = await fs.lstat(target).catch((error) => {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!stat) throw new Error(`Mutation target does not exist at ${ref}: ${operation.path}`);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed at ${ref}: ${operation.path}`);

      if (operation.op === "delete_path") {
        deletedPaths.add(target);
        jsonSnapshots.delete(target);
        continue;
      }
      if (!stat.isFile()) throw new Error(`JSON mutation target must be a file at ${ref}: ${operation.path}`);
      let parsed = jsonSnapshots.get(target);
      if (parsed === undefined) {
        try {
          parsed = JSON.parse(await fs.readFile(target, "utf8")) as unknown;
        } catch (error) {
          throw new Error(`JSON mutation target is unreadable at ${ref}: ${operation.path}; ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (operation.op === "set_json_pointer") setJsonPointer(parsed, operation.pointer, operation.value);
      else removeJsonPointer(parsed, operation.pointer);
      jsonSnapshots.set(target, parsed);
    }
  }
}

async function applyMutation(
  artifactRoot: string,
  operation: PromotionMutationOperation,
  index: number
): Promise<PromotionMutationRecord> {
  const target = resolveContainedPath(artifactRoot, operation.path);
  if (!target || target === artifactRoot) {
    throw new Error(`Mutation target must stay below artifact root: ${operation.path}`);
  }
  const beforeHash = await hashOptionalPath(target);
  if (beforeHash == null) throw new Error(`Mutation target does not exist: ${operation.path}`);

  if (operation.op === "delete_path") {
    await fs.rm(target, { recursive: true });
  } else {
    const parsed = JSON.parse(await fs.readFile(target, "utf8")) as unknown;
    if (operation.op === "set_json_pointer") {
      setJsonPointer(parsed, operation.pointer, operation.value);
    } else {
      removeJsonPointer(parsed, operation.pointer);
    }
    await fs.writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
  return {
    index,
    operation,
    before_sha256: beforeHash,
    after_sha256: await hashOptionalPath(target)
  };
}

function parseRecipe(value: unknown): PromotionBenchmarkRecipe {
  if (!isRecord(value) || value.schema_version !== "1.0" || !nonEmptyString(value.suite_id) || !Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error("Promotion benchmark recipe requires schema_version=1.0, suite_id, and non-empty cases.");
  }
  const cases = value.cases.map((item, index) => parseRecipeCase(item, index + 1));
  const caseIds = new Set<string>();
  const splitByBase = new Map<string, PromotionBenchmarkSplit>();
  for (const recipeCase of cases) {
    if (caseIds.has(recipeCase.case_id)) throw new Error(`Duplicate recipe case id: ${recipeCase.case_id}`);
    caseIds.add(recipeCase.case_id);
    const priorSplit = splitByBase.get(recipeCase.base_bundle_id);
    if (priorSplit && priorSplit !== recipeCase.split) {
      throw new Error(`Base bundle split leakage in recipe: ${recipeCase.base_bundle_id}`);
    }
    splitByBase.set(recipeCase.base_bundle_id, recipeCase.split);
  }
  if (value.evidence_class !== undefined && !isEvidenceClass(value.evidence_class)) {
    throw new Error("Promotion benchmark recipe evidence_class is invalid.");
  }
  if (value.paper_claim_eligible !== undefined && typeof value.paper_claim_eligible !== "boolean") {
    throw new Error("Promotion benchmark recipe paper_claim_eligible must be boolean.");
  }
  if (value.adjudication_status !== undefined && !isAdjudicationStatus(value.adjudication_status)) {
    throw new Error("Promotion benchmark recipe adjudication_status is invalid.");
  }
  if (value.mutation_isolation_status !== undefined && !isMutationIsolationStatus(value.mutation_isolation_status)) {
    throw new Error("Promotion benchmark recipe mutation_isolation_status is invalid.");
  }
  if (value.paper_claim_eligible === true
      && (value.adjudication_status !== "double_adjudicated" || value.mutation_isolation_status !== "double_verified")) {
    throw new Error("Paper-claim-eligible promotion suites must be double adjudicated with double-verified mutation isolation.");
  }
  return {
    schema_version: "1.0",
    suite_id: value.suite_id,
    ...(value.evidence_class ? { evidence_class: value.evidence_class } : {}),
    ...(typeof value.paper_claim_eligible === "boolean" ? { paper_claim_eligible: value.paper_claim_eligible } : {}),
    ...(value.adjudication_status ? { adjudication_status: value.adjudication_status } : {}),
    ...(value.mutation_isolation_status ? { mutation_isolation_status: value.mutation_isolation_status } : {}),
    cases
  };
}

function parseRecipeCase(value: unknown, index: number): PromotionBenchmarkRecipeCase {
  if (!isRecord(value) || !validId(value.case_id) || !validId(value.base_bundle_id)
      || (value.split !== "development" && value.split !== "test") || !nonEmptyString(value.source_root)
      || !Array.isArray(value.operations) || !isRecord(value.gold)
      || !isPromotionDecision(value.gold.decision) || !stringArray(value.gold.blocking_concerns)
      || !stringArray(value.gold.repair_owners)) {
    throw new Error(`Invalid promotion benchmark recipe case at index ${index}.`);
  }
  return {
    case_id: value.case_id,
    base_bundle_id: value.base_bundle_id,
    split: value.split,
    source_root: value.source_root,
    ...(nonEmptyString(value.mutation_family) ? { mutation_family: value.mutation_family } : {}),
    operations: value.operations.map((operation, operationIndex) => parseOperation(operation, index, operationIndex + 1)),
    gold: {
      decision: value.gold.decision,
      blocking_concerns: stringArray(value.gold.blocking_concerns) || [],
      repair_owners: stringArray(value.gold.repair_owners) || []
    }
  };
}

function parseOperation(value: unknown, caseIndex: number, operationIndex: number): PromotionMutationOperation {
  if (!isRecord(value) || !nonEmptyString(value.path) || !isSafeRelativePath(value.path)) {
    throw new Error(`Invalid mutation path at case ${caseIndex}, operation ${operationIndex}.`);
  }
  if (value.op === "delete_path") return { op: "delete_path", path: value.path };
  if ((value.op === "set_json_pointer" || value.op === "remove_json_pointer")
      && typeof value.pointer === "string" && value.pointer.startsWith("/") && value.pointer.length > 1) {
    return value.op === "set_json_pointer"
      ? { op: value.op, path: value.path, pointer: value.pointer, value: value.value }
      : { op: value.op, path: value.path, pointer: value.pointer };
  }
  throw new Error(`Invalid mutation operation at case ${caseIndex}, operation ${operationIndex}.`);
}

async function validateRecipeSources(recipe: PromotionBenchmarkRecipe, recipeRoot: string): Promise<void> {
  for (const recipeCase of recipe.cases) {
    const sourceRoot = resolveContainedPath(recipeRoot, recipeCase.source_root);
    if (!sourceRoot || !(await directoryExists(sourceRoot))) {
      throw new Error(`Recipe source_root must be an existing directory inside the recipe root: ${recipeCase.case_id}`);
    }
    await hashPromotionArtifactTree(sourceRoot);
  }
}

function setJsonPointer(root: unknown, pointer: string, value: unknown): void {
  const { parent, key } = resolveJsonPointerParent(root, pointer);
  if (Array.isArray(parent)) {
    const index = parseArrayIndex(key, parent.length, true);
    parent[index] = value;
    return;
  }
  if (!isRecord(parent)) throw new Error(`JSON pointer parent is not an object: ${pointer}`);
  parent[key] = value;
}

function removeJsonPointer(root: unknown, pointer: string): void {
  const { parent, key } = resolveJsonPointerParent(root, pointer);
  if (Array.isArray(parent)) {
    parent.splice(parseArrayIndex(key, parent.length, false), 1);
    return;
  }
  if (!isRecord(parent) || !Object.prototype.hasOwnProperty.call(parent, key)) {
    throw new Error(`JSON pointer does not exist: ${pointer}`);
  }
  delete parent[key];
}

function resolveJsonPointerParent(root: unknown, pointer: string): { parent: unknown; key: string } {
  const parts = pointer.slice(1).split("/").map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
  const key = parts.pop();
  if (!key) throw new Error(`JSON pointer must select a non-root value: ${pointer}`);
  let current = root;
  for (const part of parts) {
    if (Array.isArray(current)) current = current[parseArrayIndex(part, current.length, false)];
    else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, part)) current = current[part];
    else throw new Error(`JSON pointer does not exist: ${pointer}`);
  }
  return { parent: current, key };
}

function parseArrayIndex(value: string, length: number, allowAppend: boolean): number {
  if (allowAppend && value === "-") return length;
  if (!/^\d+$/u.test(value)) throw new Error(`Invalid JSON array index: ${value}`);
  const index = Number(value);
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) throw new Error(`JSON array index out of range: ${value}`);
  return index;
}

async function hashOptionalPath(target: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${target}`);
    if (stat.isDirectory()) return hashPromotionArtifactTree(target);
    if (!stat.isFile()) throw new Error(`Unsupported mutation target: ${target}`);
    return createHash("sha256").update(await fs.readFile(target)).digest("hex");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function resolveContainedPath(root: string, value: string): string | undefined {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  return !relative.startsWith("..") && !path.isAbsolute(relative) ? resolved : undefined;
}

function isSafeRelativePath(value: string): boolean {
  return !path.isAbsolute(value) && Boolean(resolveContainedPath("/suite-root", value)) && value !== ".";
}

async function directoryExists(value: string): Promise<boolean> {
  try {
    return (await fs.stat(value)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : "<external-path>";
}

function isPromotionDecision(value: unknown): value is PromotionDecision {
  return typeof value === "string" && (PROMOTION_DECISIONS as readonly string[]).includes(value);
}

function isEvidenceClass(value: unknown): value is PromotionBenchmarkEvidenceClass {
  return value === "synthetic_development" || value === "human_adjudicated_test" || value === "external_real_run";
}

function isAdjudicationStatus(value: unknown): value is PromotionBenchmarkAdjudicationStatus {
  return value === "unreviewed" || value === "single_annotator" || value === "double_adjudicated";
}

function isMutationIsolationStatus(value: unknown): value is PromotionBenchmarkMutationIsolationStatus {
  return value === "unreviewed" || value === "double_verified";
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(nonEmptyString) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
