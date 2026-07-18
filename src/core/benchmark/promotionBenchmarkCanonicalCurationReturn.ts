import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonFile } from "../../utils/fs.js";
import { hashPromotionArtifactTree } from "./promotionBenchmark.js";
import {
  PROMOTION_CANONICAL_CURATION_RECORD,
  inspectPromotionCanonicalCuration,
  type PromotionCanonicalCurationCandidateBinding,
  type PromotionCanonicalCurationRecord
} from "./promotionBenchmarkCanonicalCuration.js";
import {
  PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST,
  inspectPromotionCanonicalCurationHandoff,
  type PromotionCanonicalCurationHandoffInspection,
  type PromotionCanonicalCurationTask
} from "./promotionBenchmarkCanonicalCurationHandoff.js";
import { isSha256 } from "./promotionBenchmarkSourceDiversity.js";

export const PROMOTION_CANONICAL_CURATION_RETURN_RECEIPT =
  "canonical-curation-return-receipt.json";
export const PROMOTION_CANONICAL_CURATION_RETURN_HANDOFF_ROOT =
  "upstream/canonical-curation-handoff";
export const PROMOTION_CANONICAL_CURATION_RETURN_SOURCES_ROOT = "sources";

export interface CollectPromotionCanonicalCurationReturnInput {
  cwd: string;
  curationHandoffRoot: string;
  sourceRoots: string[];
  outDir: string;
}

export interface PromotionCanonicalCurationReturnIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionCanonicalCurationReturnBinding {
  candidate_id: string | null;
  source_path: string;
  source_tree_sha256: string;
  curation_record_sha256: string | null;
  curator_id: string | null;
  verifier_id: string | null;
  assignment_match: boolean;
  validation_passed: boolean;
  issue_codes: string[];
}

export interface PromotionCanonicalCurationReturnReceipt {
  schema_version: "1.0";
  kind: "promotion_canonical_curation_return";
  handoff_id: string;
  source_revision: string;
  status: "verified" | "curation_return_blocked";
  passed: boolean;
  assigned_curator_id: string;
  assigned_verifier_id: string;
  curator_protocol_version: string;
  verifier_protocol_version: string;
  received_return_count: number;
  assigned_return_count: number;
  verified_return_count: number;
  required_return_count: number;
  returns: PromotionCanonicalCurationReturnBinding[];
  input_sha256: {
    curation_handoff_manifest: string;
  };
  validation_issues: PromotionCanonicalCurationReturnIssue[];
  confirmatory_admitted: false;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  evidence_boundary: string;
}

export interface CollectPromotionCanonicalCurationReturnResult {
  receipt: PromotionCanonicalCurationReturnReceipt;
  output_dir: string;
  receipt_path: string;
}

export interface PromotionCanonicalCurationReturnInspection {
  passed: boolean;
  receipt: PromotionCanonicalCurationReturnReceipt | null;
  issues: PromotionCanonicalCurationReturnIssue[];
}

interface ReturnEvaluation {
  bindings: PromotionCanonicalCurationReturnBinding[];
  issues: PromotionCanonicalCurationReturnIssue[];
  receivedReturnCount: number;
  assignedReturnCount: number;
  verifiedReturnCount: number;
}

export async function collectPromotionCanonicalCurationReturn(
  input: CollectPromotionCanonicalCurationReturnInput
): Promise<CollectPromotionCanonicalCurationReturnResult> {
  const cwd = await fs.realpath(path.resolve(input.cwd));
  const handoffRoot = await resolveDirectoryInside(
    cwd,
    input.curationHandoffRoot,
    "Canonical curation handoff"
  );
  const sourceRoots = await Promise.all(input.sourceRoots.map((sourceRoot, index) =>
    resolveDirectoryInside(cwd, sourceRoot, `Canonical source return ${index + 1}`)));
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Canonical curation return output");
  if (isSameOrContainedPath(handoffRoot, outDir)
      || sourceRoots.some((sourceRoot) => isSameOrContainedPath(sourceRoot, outDir))) {
    throw new Error("Canonical curation return output must stay outside its handoff and source inputs.");
  }
  if (new Set(sourceRoots).size !== sourceRoots.length) {
    throw new Error("Canonical curation return source roots must be distinct.");
  }
  for (const [index, sourceRoot] of sourceRoots.entries()) {
    if (sourceRoots.some((otherRoot, otherIndex) => otherIndex !== index
        && isSameOrContainedPath(sourceRoot, otherRoot))) {
      throw new Error("Canonical curation return source roots must not overlap.");
    }
  }
  await assertFreshOutput(outDir);

  const handoff = await inspectPromotionCanonicalCurationHandoff(handoffRoot);
  if (!handoff.passed || !handoff.manifest) {
    throw new Error(`Canonical curation return collection requires an integrity-valid handoff: ${handoff.issues.map((issue) => issue.code).join(", ") || "unreadable"}.`);
  }

  const stagingRoot = path.join(
    path.dirname(outDir),
    `.${path.basename(outDir)}.staging-${randomUUID()}`
  );
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  await fs.mkdir(stagingRoot, { recursive: false });
  try {
    await copyRegularTree(
      handoffRoot,
      path.join(stagingRoot, PROMOTION_CANONICAL_CURATION_RETURN_HANDOFF_ROOT)
    );
    for (const [index, sourceRoot] of sourceRoots.entries()) {
      await copyRegularTree(
        sourceRoot,
        path.join(stagingRoot, sourcePathForIndex(index))
      );
    }

    const containedHandoff = await inspectPromotionCanonicalCurationHandoff(path.join(
      stagingRoot,
      PROMOTION_CANONICAL_CURATION_RETURN_HANDOFF_ROOT
    ));
    if (!containedHandoff.passed || !containedHandoff.manifest) {
      throw new Error("Copied canonical curation handoff failed independent inspection.");
    }
    const evaluation = await evaluateReturns(stagingRoot, containedHandoff);
    const handoffManifestBytes = await readContainedRegularFile(
      stagingRoot,
      path.join(
        stagingRoot,
        PROMOTION_CANONICAL_CURATION_RETURN_HANDOFF_ROOT,
        PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST
      )
    );
    const files = await inventoryRegularFiles(
      stagingRoot,
      PROMOTION_CANONICAL_CURATION_RETURN_RECEIPT
    );
    const passed = evaluation.issues.length === 0
      && evaluation.receivedReturnCount === containedHandoff.manifest.task_count
      && evaluation.assignedReturnCount === containedHandoff.manifest.task_count
      && evaluation.verifiedReturnCount === containedHandoff.manifest.task_count;
    const receipt: PromotionCanonicalCurationReturnReceipt = {
      schema_version: "1.0",
      kind: "promotion_canonical_curation_return",
      handoff_id: containedHandoff.manifest.handoff_id,
      source_revision: containedHandoff.manifest.source_revision,
      status: passed ? "verified" : "curation_return_blocked",
      passed,
      assigned_curator_id: containedHandoff.manifest.curator_id,
      assigned_verifier_id: containedHandoff.manifest.verifier_id,
      curator_protocol_version: containedHandoff.manifest.curator_protocol_version,
      verifier_protocol_version: containedHandoff.manifest.verifier_protocol_version,
      received_return_count: evaluation.receivedReturnCount,
      assigned_return_count: evaluation.assignedReturnCount,
      verified_return_count: evaluation.verifiedReturnCount,
      required_return_count: containedHandoff.manifest.task_count,
      returns: evaluation.bindings,
      input_sha256: {
        curation_handoff_manifest: sha256(handoffManifestBytes)
      },
      validation_issues: evaluation.issues,
      confirmatory_admitted: false,
      files,
      evidence_boundary: "This controller-side receipt binds the complete canonical-curation handoff, every returned source tree, assigned curator and verifier roles, protocol versions, six-trial provenance, and canonical artifact validation. A passing receipt confirms assignment-bound structural and semantic validation but does not prove real-world identity, expertise, authorship, legal authority, confirmatory results, or paper readiness."
    };
    await writeJsonFile(
      path.join(stagingRoot, PROMOTION_CANONICAL_CURATION_RETURN_RECEIPT),
      receipt
    );
    const inspection = await inspectPromotionCanonicalCurationReturn(stagingRoot);
    if (!inspection.passed) {
      throw new Error(`Canonical curation return receipt failed self-inspection: ${inspection.issues.map((issue) => issue.code).join(", ")}.`);
    }
    await fs.rename(stagingRoot, outDir);
    return {
      receipt,
      output_dir: portableRef(cwd, outDir),
      receipt_path: portableRef(
        cwd,
        path.join(outDir, PROMOTION_CANONICAL_CURATION_RETURN_RECEIPT)
      )
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectPromotionCanonicalCurationReturn(
  rootPath: string
): Promise<PromotionCanonicalCurationReturnInspection> {
  const root = path.resolve(rootPath);
  const issues: PromotionCanonicalCurationReturnIssue[] = [];
  let receipt: PromotionCanonicalCurationReturnReceipt;
  try {
    receipt = parseReceipt(JSON.parse(await fs.readFile(
      path.join(root, PROMOTION_CANONICAL_CURATION_RETURN_RECEIPT),
      "utf8"
    )) as unknown);
  } catch {
    return {
      passed: false,
      receipt: null,
      issues: [{
        code: "canonical_curation_return_receipt_unreadable",
        message: "The canonical curation return receipt is missing or invalid."
      }]
    };
  }

  const observedFiles = await inventoryRegularFiles(
    root,
    PROMOTION_CANONICAL_CURATION_RETURN_RECEIPT
  ).catch(() => null);
  if (!observedFiles || JSON.stringify(observedFiles) !== JSON.stringify(receipt.files)) {
    issues.push({
      code: "canonical_curation_return_inventory_invalid",
      message: "Canonical curation return files are missing, changed, symlinked, or untracked."
    });
  }
  if (!await returnLayoutIsClosed(root)) {
    issues.push({
      code: "canonical_curation_return_layout_invalid",
      message: "The return packet may contain only one upstream handoff, returned source directories, and its receipt."
    });
  }

  const handoffRoot = path.join(root, PROMOTION_CANONICAL_CURATION_RETURN_HANDOFF_ROOT);
  const handoff = await inspectPromotionCanonicalCurationHandoff(handoffRoot);
  const handoffManifestHash = await hashRegularFile(path.join(
    handoffRoot,
    PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST
  )).catch(() => null);
  if (!handoff.passed || !handoff.manifest
      || handoff.manifest.handoff_id !== receipt.handoff_id
      || handoff.manifest.source_revision !== receipt.source_revision
      || handoff.manifest.curator_id !== receipt.assigned_curator_id
      || handoff.manifest.verifier_id !== receipt.assigned_verifier_id
      || handoff.manifest.curator_protocol_version !== receipt.curator_protocol_version
      || handoff.manifest.verifier_protocol_version !== receipt.verifier_protocol_version
      || handoffManifestHash !== receipt.input_sha256.curation_handoff_manifest) {
    issues.push({
      code: "canonical_curation_return_handoff_invalid",
      message: "The contained handoff must independently recover the exact assigned tasks and authority."
    });
  }

  if (handoff.manifest) {
    let evaluation: ReturnEvaluation | null = null;
    try {
      evaluation = await evaluateReturns(root, handoff);
    } catch {
      issues.push({
        code: "canonical_curation_return_sources_invalid",
        message: "Returned sources must be numbered regular directories with inspectable regular-file evidence."
      });
    }
    if (evaluation) {
      if (JSON.stringify(evaluation.bindings) !== JSON.stringify(receipt.returns)
          || JSON.stringify(evaluation.issues) !== JSON.stringify(receipt.validation_issues)) {
        issues.push({
          code: "canonical_curation_return_recomputation_mismatch",
          message: "Receipt bindings or validation issues do not match independent recomputation."
        });
      }
      const expectedPassed = evaluation.issues.length === 0
        && evaluation.receivedReturnCount === handoff.manifest.task_count
        && evaluation.assignedReturnCount === handoff.manifest.task_count
        && evaluation.verifiedReturnCount === handoff.manifest.task_count;
      if (receipt.received_return_count !== evaluation.receivedReturnCount
          || receipt.assigned_return_count !== evaluation.assignedReturnCount
          || receipt.verified_return_count !== evaluation.verifiedReturnCount
          || receipt.required_return_count !== handoff.manifest.task_count
          || receipt.passed !== expectedPassed
          || receipt.status !== (expectedPassed ? "verified" : "curation_return_blocked")) {
        issues.push({
          code: "canonical_curation_return_verdict_invalid",
          message: "Receipt counts, status, and validation verdict disagree."
        });
      }
    }
  }
  return { passed: issues.length === 0, receipt, issues };
}

async function evaluateReturns(
  root: string,
  handoff: PromotionCanonicalCurationHandoffInspection
): Promise<ReturnEvaluation> {
  const manifest = handoff.manifest;
  if (!manifest) {
    return {
      bindings: [],
      issues: [{
        code: "canonical_curation_return_handoff_unavailable",
        message: "Return evaluation requires a parseable canonical curation handoff."
      }],
      receivedReturnCount: 0,
      assignedReturnCount: 0,
      verifiedReturnCount: 0
    };
  }
  const tasks = new Map(handoff.tasks.map((task) => [task.candidate_id, task]));
  const sourcePaths = await listReturnedSourcePaths(root);
  const issues: PromotionCanonicalCurationReturnIssue[] = [];
  const bindings: PromotionCanonicalCurationReturnBinding[] = [];
  const seenCandidateIds = new Set<string>();

  for (const sourcePath of sourcePaths) {
    const sourceRoot = path.join(root, sourcePath);
    const sourceTreeSha256 = await hashPromotionArtifactTree(sourceRoot);
    const identity = await readCurationIdentity(sourceRoot);
    const task = identity?.candidate_id ? tasks.get(identity.candidate_id) : undefined;
    const issueCodes: string[] = [];
    let curationRecordSha256: string | null = null;
    let semanticPassed = false;

    if (!identity || !task) {
      issueCodes.push("canonical_curation_return_candidate_assignment_mismatch");
    } else {
      const curation = await inspectPromotionCanonicalCuration({
        sourceRoot,
        handoffId: manifest.handoff_id,
        sourceRevision: manifest.source_revision,
        candidate: candidateBindingFromTask(task)
      });
      curationRecordSha256 = curation.record_sha256;
      issueCodes.push(...curation.issues.map((issue) => issue.code));
      semanticPassed = curation.passed;
      if (identity.curator_id !== task.curator_id
          || identity.verifier_id !== task.verifier_id
          || identity.curator_protocol_version !== task.curator_protocol_version
          || identity.verifier_protocol_version !== task.verifier_protocol_version) {
        issueCodes.push("canonical_curation_return_role_assignment_mismatch");
      }
      if (seenCandidateIds.has(identity.candidate_id)) {
        issueCodes.push("canonical_curation_return_candidate_duplicate");
      }
      seenCandidateIds.add(identity.candidate_id);
    }
    const uniqueIssueCodes = [...new Set(issueCodes)].sort();
    for (const code of uniqueIssueCodes) {
      issues.push({
        code,
        message: issueMessage(code),
        ref: sourcePath
      });
    }
    const assignmentMatch = Boolean(identity && task)
      && !uniqueIssueCodes.includes("canonical_curation_return_role_assignment_mismatch")
      && !uniqueIssueCodes.includes("canonical_curation_return_candidate_duplicate");
    bindings.push({
      candidate_id: identity?.candidate_id || null,
      source_path: sourcePath,
      source_tree_sha256: sourceTreeSha256,
      curation_record_sha256: curationRecordSha256,
      curator_id: identity?.curator_id || null,
      verifier_id: identity?.verifier_id || null,
      assignment_match: assignmentMatch,
      validation_passed: assignmentMatch && semanticPassed && uniqueIssueCodes.length === 0,
      issue_codes: uniqueIssueCodes
    });
  }

  const observedCandidateIds = bindings.flatMap((binding) =>
    binding.candidate_id ? [binding.candidate_id] : []).sort();
  const expectedCandidateIds = [...tasks.keys()].sort();
  if (sourcePaths.length !== manifest.task_count) {
    issues.push({
      code: "canonical_curation_return_count_mismatch",
      message: `Expected ${manifest.task_count} returned canonical sources; observed ${sourcePaths.length}.`
    });
  }
  if (JSON.stringify(observedCandidateIds) !== JSON.stringify(expectedCandidateIds)) {
    issues.push({
      code: "canonical_curation_return_candidate_coverage_mismatch",
      message: "Returned canonical sources must cover every assigned candidate exactly once."
    });
  }
  bindings.sort((left, right) => left.source_path.localeCompare(right.source_path));
  issues.sort((left, right) =>
    `${left.ref || ""}:${left.code}`.localeCompare(`${right.ref || ""}:${right.code}`));
  return {
    bindings,
    issues,
    receivedReturnCount: sourcePaths.length,
    assignedReturnCount: bindings.filter((binding) => binding.assignment_match).length,
    verifiedReturnCount: bindings.filter((binding) => binding.validation_passed).length
  };
}

function candidateBindingFromTask(
  task: PromotionCanonicalCurationTask
): PromotionCanonicalCurationCandidateBinding {
  const trial = (groupId: "group-a" | "group-b") => task.source_trials
    .filter((item) => item.group_id === groupId)
    .map((item) => ({
      trial_id: item.trial_id,
      source_ref_sha256: item.source_ref_sha256,
      source_blob_sha256: item.source_blob_sha256,
      reviewer_blob_sha256: item.reviewer_blob_sha256
    }));
  return {
    candidate_id: task.candidate_id,
    base_candidate_sha256: task.base_candidate_sha256,
    trials: trial("group-a"),
    comparator_trials: trial("group-b")
  };
}

async function readCurationIdentity(sourceRoot: string): Promise<Pick<
  PromotionCanonicalCurationRecord,
  "candidate_id" | "curator_id" | "verifier_id" | "curator_protocol_version" | "verifier_protocol_version"
> | null> {
  try {
    const value = JSON.parse(await fs.readFile(
      path.join(sourceRoot, PROMOTION_CANONICAL_CURATION_RECORD),
      "utf8"
    )) as Record<string, unknown>;
    if (!validId(value.candidate_id)
        || !validId(value.curator_id)
        || !validId(value.verifier_id)
        || !nonEmptyString(value.curator_protocol_version)
        || !nonEmptyString(value.verifier_protocol_version)) return null;
    return value as unknown as Pick<
      PromotionCanonicalCurationRecord,
      "candidate_id" | "curator_id" | "verifier_id" | "curator_protocol_version" | "verifier_protocol_version"
    >;
  } catch {
    return null;
  }
}

function parseReceipt(value: unknown): PromotionCanonicalCurationReturnReceipt {
  if (!isRecord(value)
      || value.schema_version !== "1.0"
      || value.kind !== "promotion_canonical_curation_return"
      || !validId(value.handoff_id)
      || !nonEmptyString(value.source_revision)
      || (value.status !== "verified" && value.status !== "curation_return_blocked")
      || typeof value.passed !== "boolean"
      || !validId(value.assigned_curator_id)
      || !validId(value.assigned_verifier_id)
      || value.assigned_curator_id === value.assigned_verifier_id
      || !nonEmptyString(value.curator_protocol_version)
      || !nonEmptyString(value.verifier_protocol_version)
      || !nonNegativeInteger(value.received_return_count)
      || !nonNegativeInteger(value.assigned_return_count)
      || !nonNegativeInteger(value.verified_return_count)
      || !positiveInteger(value.required_return_count)
      || !Array.isArray(value.returns)
      || !isRecord(value.input_sha256)
      || !isSha256(value.input_sha256.curation_handoff_manifest)
      || !Array.isArray(value.validation_issues)
      || value.confirmatory_admitted !== false
      || !Array.isArray(value.files)
      || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Invalid canonical curation return receipt.");
  }
  const returns = value.returns.map(parseReturnBinding);
  const validationIssues = value.validation_issues.map(parseIssue);
  const files = value.files.map(parseFileBinding);
  if (new Set(returns.map((item) => item.source_path)).size !== returns.length
      || new Set(files.map((item) => item.path)).size !== files.length) {
    throw new Error("Duplicate canonical curation return bindings.");
  }
  return {
    ...(value as unknown as PromotionCanonicalCurationReturnReceipt),
    returns,
    validation_issues: validationIssues,
    files
  };
}

function parseReturnBinding(value: unknown): PromotionCanonicalCurationReturnBinding {
  if (!isRecord(value)
      || (value.candidate_id !== null && !validId(value.candidate_id))
      || !/^sources\/return-\d{4}$/u.test(String(value.source_path))
      || !isSha256(value.source_tree_sha256)
      || (value.curation_record_sha256 !== null && !isSha256(value.curation_record_sha256))
      || (value.curator_id !== null && !validId(value.curator_id))
      || (value.verifier_id !== null && !validId(value.verifier_id))
      || typeof value.assignment_match !== "boolean"
      || typeof value.validation_passed !== "boolean"
      || !Array.isArray(value.issue_codes)
      || value.issue_codes.some((item) => !nonEmptyString(item))) {
    throw new Error("Invalid canonical curation return binding.");
  }
  return value as unknown as PromotionCanonicalCurationReturnBinding;
}

function parseIssue(value: unknown): PromotionCanonicalCurationReturnIssue {
  if (!isRecord(value) || !nonEmptyString(value.code) || !nonEmptyString(value.message)
      || (value.ref !== undefined && !nonEmptyString(value.ref))) {
    throw new Error("Invalid canonical curation return issue.");
  }
  return value as unknown as PromotionCanonicalCurationReturnIssue;
}

function parseFileBinding(value: unknown): { path: string; bytes: number; sha256: string } {
  if (!isRecord(value) || !safeRelativePath(value.path)
      || !nonNegativeInteger(value.bytes) || !isSha256(value.sha256)) {
    throw new Error("Invalid canonical curation return file binding.");
  }
  return value as { path: string; bytes: number; sha256: string };
}

async function listReturnedSourcePaths(root: string): Promise<string[]> {
  const sourcesRoot = path.join(root, PROMOTION_CANONICAL_CURATION_RETURN_SOURCES_ROOT);
  const entries = await fs.readdir(sourcesRoot, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || !/^return-\d{4}$/u.test(entry.name)) {
      throw new Error("Canonical curation sources must be numbered regular directories.");
    }
    paths.push(`${PROMOTION_CANONICAL_CURATION_RETURN_SOURCES_ROOT}/${entry.name}`);
  }
  return paths;
}

async function returnLayoutIsClosed(root: string): Promise<boolean> {
  try {
    const top = await fs.readdir(root, { withFileTypes: true });
    const names = top.map((entry) => entry.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([
      PROMOTION_CANONICAL_CURATION_RETURN_RECEIPT,
      PROMOTION_CANONICAL_CURATION_RETURN_SOURCES_ROOT,
      "upstream"
    ].sort())) return false;
    const receipt = top.find((entry) =>
      entry.name === PROMOTION_CANONICAL_CURATION_RETURN_RECEIPT);
    const sources = top.find((entry) =>
      entry.name === PROMOTION_CANONICAL_CURATION_RETURN_SOURCES_ROOT);
    const upstreamRoot = top.find((entry) => entry.name === "upstream");
    if (!receipt?.isFile() || receipt.isSymbolicLink()
        || !sources?.isDirectory() || sources.isSymbolicLink()
        || !upstreamRoot?.isDirectory() || upstreamRoot.isSymbolicLink()) return false;
    const upstream = await fs.readdir(path.join(root, "upstream"), { withFileTypes: true });
    return upstream.length === 1
      && upstream[0].name === "canonical-curation-handoff"
      && upstream[0].isDirectory()
      && !upstream[0].isSymbolicLink();
  } catch {
    return false;
  }
}

async function copyRegularTree(sourceRoot: string, targetRoot: string): Promise<void> {
  await fs.mkdir(targetRoot, { recursive: true });
  const visit = async (source: string, target: string): Promise<void> => {
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const sourcePath = path.join(source, entry.name);
      const targetPath = path.join(target, entry.name);
      const stat = await fs.lstat(sourcePath);
      if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in canonical curation returns.");
      if (stat.isDirectory()) {
        await fs.mkdir(targetPath, { recursive: false });
        await visit(sourcePath, targetPath);
      } else if (stat.isFile()) {
        await fs.writeFile(targetPath, await fs.readFile(sourcePath));
      } else {
        throw new Error("Only regular files and directories are allowed in canonical curation returns.");
      }
    }
  };
  await visit(sourceRoot, targetRoot);
}

async function inventoryRegularFiles(
  root: string,
  excludedRelativePath: string
): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/gu, "/");
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in canonical curation returns.");
      if (stat.isDirectory()) {
        await visit(absolute);
      } else if (stat.isFile()) {
        if (relative === excludedRelativePath) continue;
        files.push({ path: relative, bytes: stat.size, sha256: await hashRegularFile(absolute) });
      } else {
        throw new Error("Unsupported entry in canonical curation return.");
      }
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function resolveDirectoryInside(root: string, value: string, label: string): Promise<string> {
  const candidate = await fs.realpath(path.resolve(root, value));
  if (!isSameOrContainedPath(root, candidate) || candidate === root) {
    throw new Error(`${label} must be a directory inside the workspace.`);
  }
  if (!(await fs.stat(candidate)).isDirectory()) throw new Error(`${label} must be a directory.`);
  return candidate;
}

async function readContainedRegularFile(root: string, target: string): Promise<Buffer> {
  const canonicalRoot = await fs.realpath(root);
  const canonicalTarget = await fs.realpath(target);
  if (!isSameOrContainedPath(canonicalRoot, canonicalTarget)) {
    throw new Error("Artifact path escaped its return packet root.");
  }
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error("Artifact is not a non-empty regular file.");
  }
  return fs.readFile(target);
}

async function hashRegularFile(filePath: string): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error("Expected a non-empty regular file.");
  }
  return sha256(await fs.readFile(filePath));
}

async function assertFreshOutput(outDir: string): Promise<void> {
  try {
    await fs.lstat(outDir);
    throw new Error("Canonical curation return output already exists.");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function sourcePathForIndex(index: number): string {
  return `${PROMOTION_CANONICAL_CURATION_RETURN_SOURCES_ROOT}/return-${String(index + 1).padStart(4, "0")}`;
}

function issueMessage(code: string): string {
  if (code === "canonical_curation_return_candidate_assignment_mismatch") {
    return "A returned source does not identify one assigned curation task.";
  }
  if (code === "canonical_curation_return_role_assignment_mismatch") {
    return "A returned source does not match the assigned curator, verifier, or protocol versions.";
  }
  if (code === "canonical_curation_return_candidate_duplicate") {
    return "Each assigned candidate may have only one returned canonical source.";
  }
  return "A returned canonical source failed structural or semantic curation validation.";
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a new directory inside the workspace.`);
  }
}

function isSameOrContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portableRef(root: string, target: string): string {
  return path.relative(root, target).replace(/\\/gu, "/");
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096
    && !path.isAbsolute(value) && !value.split(/[\\/]+/u).includes("..");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
