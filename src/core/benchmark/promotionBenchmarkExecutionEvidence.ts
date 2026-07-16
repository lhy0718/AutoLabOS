import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

export const PROMOTION_EXECUTION_EVIDENCE_MANIFEST = "execution-evidence.json";
export const PROMOTION_EXECUTION_EVIDENCE_ROLES = [
  "run_config",
  "event_log",
  "metrics",
  "review_decision",
  "command",
  "execution_log"
] as const;
export const PROMOTION_EXECUTION_BACKENDS = [
  "api_provider",
  "local_model",
  "local_runtime",
  "remote_runtime"
] as const;

export type PromotionExecutionEvidenceRole = typeof PROMOTION_EXECUTION_EVIDENCE_ROLES[number];
export type PromotionExecutionBackend = typeof PROMOTION_EXECUTION_BACKENDS[number];

export interface PromotionExecutionEvidenceArtifact {
  role: PromotionExecutionEvidenceRole;
  path: string;
  sha256: string;
}

export interface PromotionExecutionEvidenceManifest {
  schema_version: "1.0";
  evidence_class: "external_real_run";
  run_id: string;
  execution_mode: "real_execution";
  execution_status: "completed";
  execution_backend: PromotionExecutionBackend;
  started_at: string;
  completed_at: string;
  exit_code: 0;
  trial_ids: string[];
  artifacts: PromotionExecutionEvidenceArtifact[];
}

export interface PromotionExecutionEvidenceIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionExecutionEvidenceInspection {
  passed: boolean;
  run_id: string | null;
  run_id_sha256: string | null;
  evidence_manifest_sha256: string | null;
  execution_fingerprint: string | null;
  artifact_count: number;
  roles: PromotionExecutionEvidenceRole[];
  issues: PromotionExecutionEvidenceIssue[];
}

export interface PreparePromotionExecutionEvidenceInput {
  cwd: string;
  sourceRoot: string;
  runId: string;
  executionBackend: PromotionExecutionBackend;
  startedAt: string;
  completedAt: string;
  trialIds: string[];
  artifacts: Array<{ role: PromotionExecutionEvidenceRole; path: string }>;
}

export interface PreparePromotionExecutionEvidenceResult {
  manifest_path: string;
  inspection: PromotionExecutionEvidenceInspection;
}

export async function inspectPromotionExecutionEvidence(
  sourceRoot: string
): Promise<PromotionExecutionEvidenceInspection> {
  const root = path.resolve(sourceRoot);
  const manifestPath = path.join(root, PROMOTION_EXECUTION_EVIDENCE_MANIFEST);
  const issues: PromotionExecutionEvidenceIssue[] = [];
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      issues.push({
        code: "execution_evidence_source_root_invalid",
        message: "Execution-evidence source root must be a regular directory, not a symbolic link."
      });
      return emptyInspection(issues);
    }
  } catch {
    issues.push({
      code: "execution_evidence_source_root_unreadable",
      message: "Execution-evidence source root must be readable."
    });
    return emptyInspection(issues);
  }
  let manifestBytes: Buffer;
  try {
    const stat = await fs.lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      issues.push({
        code: "execution_evidence_manifest_not_regular_file",
        message: `${PROMOTION_EXECUTION_EVIDENCE_MANIFEST} must be a regular file.`
      });
      return emptyInspection(issues);
    }
    manifestBytes = await fs.readFile(manifestPath);
  } catch {
    issues.push({
      code: "execution_evidence_manifest_unreadable",
      message: `${PROMOTION_EXECUTION_EVIDENCE_MANIFEST} is required and must be readable.`
    });
    return emptyInspection(issues);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  } catch (error) {
    issues.push({ code: "execution_evidence_manifest_invalid_json", message: errorMessage(error) });
    return emptyInspection(issues, sha256(manifestBytes));
  }
  const manifest = parseManifest(raw, issues);
  if (!manifest) return emptyInspection(issues, sha256(manifestBytes));

  const roles = [...new Set(manifest.artifacts.map((artifact) => artifact.role))].sort() as PromotionExecutionEvidenceRole[];
  const observedHashes: Array<{ role: PromotionExecutionEvidenceRole; sha256: string }> = [];
  const seenPaths = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (seenPaths.has(artifact.path)) {
      issues.push({
        code: "execution_evidence_artifact_path_reused",
        message: "One file cannot satisfy multiple execution-evidence roles.",
        ref: artifact.path
      });
      continue;
    }
    seenPaths.add(artifact.path);
    const target = resolveContainedFile(root, artifact.path);
    if (!target) {
      issues.push({
        code: "execution_evidence_artifact_path_invalid",
        message: "Execution-evidence artifact paths must stay inside the source bundle.",
        ref: artifact.path
      });
      continue;
    }
    try {
      if (await hasSymbolicLinkComponent(root, artifact.path)) {
        issues.push({
          code: "execution_evidence_artifact_symlink",
          message: "Execution-evidence artifact paths must not contain symbolic links.",
          ref: artifact.path
        });
        continue;
      }
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
        issues.push({
          code: "execution_evidence_artifact_not_regular_nonempty_file",
          message: "Execution-evidence artifacts must be non-empty regular files.",
          ref: artifact.path
        });
        continue;
      }
      const observedSha256 = sha256(await fs.readFile(target));
      if (observedSha256 !== artifact.sha256) {
        issues.push({
          code: "execution_evidence_artifact_hash_mismatch",
          message: "Execution-evidence artifact hash does not match the manifest.",
          ref: artifact.path
        });
        continue;
      }
      observedHashes.push({ role: artifact.role, sha256: observedSha256 });
    } catch {
      issues.push({
        code: "execution_evidence_artifact_unreadable",
        message: "Execution-evidence artifact must be readable.",
        ref: artifact.path
      });
    }
  }

  const executionFingerprint = issues.length === 0
    ? sha256(Buffer.from(observedHashes
        .sort((left, right) => `${left.role}:${left.sha256}`.localeCompare(`${right.role}:${right.sha256}`))
        .map((artifact) => `${artifact.role}:${artifact.sha256}`)
        .join("\n"), "utf8"))
    : null;
  return {
    passed: issues.length === 0,
    run_id: manifest.run_id,
    run_id_sha256: sha256(Buffer.from(manifest.run_id, "utf8")),
    evidence_manifest_sha256: sha256(manifestBytes),
    execution_fingerprint: executionFingerprint,
    artifact_count: manifest.artifacts.length,
    roles,
    issues
  };
}

export async function preparePromotionExecutionEvidence(
  input: PreparePromotionExecutionEvidenceInput
): Promise<PreparePromotionExecutionEvidenceResult> {
  const cwd = path.resolve(input.cwd);
  const root = path.resolve(cwd, input.sourceRoot);
  const rootStat = await fs.lstat(root).catch(() => {
    throw new Error("Execution-evidence source root must be readable.");
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Execution-evidence source root must be a regular directory, not a symbolic link.");
  }
  if (!validId(input.runId)) throw new Error("Execution evidence requires a portable run ID.");
  if (!isExecutionBackend(input.executionBackend)) throw new Error("Execution evidence requires an allowed backend.");
  const startedAt = parseTimestamp(input.startedAt);
  const completedAt = parseTimestamp(input.completedAt);
  if (startedAt == null || completedAt == null || completedAt <= startedAt) {
    throw new Error("Execution evidence requires valid ordered start and completion timestamps.");
  }
  if (input.trialIds.length < 3 || new Set(input.trialIds).size !== input.trialIds.length
      || input.trialIds.some((trialId) => !validId(trialId))) {
    throw new Error("Execution evidence requires at least three distinct portable trial IDs.");
  }

  const artifactByRole = new Map<PromotionExecutionEvidenceRole, string>();
  const seenPaths = new Set<string>();
  for (const artifact of input.artifacts) {
    if (!isEvidenceRole(artifact.role)) throw new Error(`Unknown execution-evidence role: ${artifact.role}`);
    if (artifactByRole.has(artifact.role)) throw new Error(`Duplicate execution-evidence role: ${artifact.role}`);
    if (!safeRelativePath(artifact.path)) {
      throw new Error(`Execution-evidence artifact path must be portable and relative: ${artifact.path}`);
    }
    if (seenPaths.has(artifact.path)) throw new Error(`Execution-evidence artifact path is reused: ${artifact.path}`);
    artifactByRole.set(artifact.role, artifact.path);
    seenPaths.add(artifact.path);
  }
  const missingRoles = PROMOTION_EXECUTION_EVIDENCE_ROLES.filter((role) => !artifactByRole.has(role));
  if (missingRoles.length > 0) {
    throw new Error(`Missing execution-evidence roles: ${missingRoles.join(", ")}.`);
  }

  const artifacts: PromotionExecutionEvidenceArtifact[] = [];
  for (const role of PROMOTION_EXECUTION_EVIDENCE_ROLES) {
    const artifactPath = artifactByRole.get(role)!;
    const target = resolveContainedFile(root, artifactPath);
    if (!target) throw new Error(`Execution-evidence artifact must stay inside the source bundle: ${artifactPath}`);
    const containsSymbolicLink = await hasSymbolicLinkComponent(root, artifactPath).catch(() => {
      throw new Error(`Execution-evidence artifact must be readable: ${artifactPath}`);
    });
    if (containsSymbolicLink) {
      throw new Error(`Execution-evidence artifact path must not contain symbolic links: ${artifactPath}`);
    }
    const stat = await fs.lstat(target).catch(() => {
      throw new Error(`Execution-evidence artifact must be readable: ${artifactPath}`);
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      throw new Error(`Execution-evidence artifact must be a non-empty regular file: ${artifactPath}`);
    }
    artifacts.push({ role, path: artifactPath, sha256: sha256(await fs.readFile(target)) });
  }

  const manifest: PromotionExecutionEvidenceManifest = {
    schema_version: "1.0",
    evidence_class: "external_real_run",
    run_id: input.runId,
    execution_mode: "real_execution",
    execution_status: "completed",
    execution_backend: input.executionBackend,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    exit_code: 0,
    trial_ids: input.trialIds,
    artifacts
  };
  const manifestPath = path.join(root, PROMOTION_EXECUTION_EVIDENCE_MANIFEST);
  await writeExclusiveManifest(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const inspection = await inspectPromotionExecutionEvidence(root);
  if (!inspection.passed) {
    await fs.rm(manifestPath, { force: true });
    throw new Error(`Prepared execution evidence failed self-inspection: ${inspection.issues.map((issue) => issue.code).join(", ")}.`);
  }
  return {
    manifest_path: portableRef(cwd, manifestPath),
    inspection
  };
}

function parseManifest(
  value: unknown,
  issues: PromotionExecutionEvidenceIssue[]
): PromotionExecutionEvidenceManifest | undefined {
  if (!isRecord(value) || value.schema_version !== "1.0") {
    issues.push({ code: "execution_evidence_schema_invalid", message: "Execution evidence requires schema_version=1.0." });
    return undefined;
  }
  if (value.evidence_class !== "external_real_run") {
    issues.push({ code: "execution_evidence_class_invalid", message: "Execution evidence must declare external_real_run." });
  }
  if (!validId(value.run_id)) {
    issues.push({ code: "execution_evidence_run_id_invalid", message: "Execution evidence requires a portable run_id." });
  }
  if (value.execution_mode !== "real_execution") {
    issues.push({ code: "execution_evidence_mode_invalid", message: "Only real_execution evidence is accepted." });
  }
  if (value.execution_status !== "completed" || value.exit_code !== 0) {
    issues.push({ code: "execution_evidence_completion_invalid", message: "Execution must be completed with exit_code=0." });
  }
  if (!isExecutionBackend(value.execution_backend)) {
    issues.push({ code: "execution_evidence_backend_invalid", message: "Execution backend is missing or invalid." });
  }
  const startedAt = parseTimestamp(value.started_at);
  const completedAt = parseTimestamp(value.completed_at);
  if (startedAt == null || completedAt == null || completedAt <= startedAt) {
    issues.push({
      code: "execution_evidence_timestamps_invalid",
      message: "Execution evidence requires valid ordered started_at and completed_at timestamps."
    });
  }
  if (!stringArray(value.trial_ids) || value.trial_ids.length < 3
      || new Set(value.trial_ids).size !== value.trial_ids.length
      || value.trial_ids.some((trialId) => !validId(trialId))) {
    issues.push({
      code: "execution_evidence_trials_invalid",
      message: "Execution evidence requires at least three distinct portable trial_ids."
    });
  }
  if (!Array.isArray(value.artifacts)) {
    issues.push({ code: "execution_evidence_artifacts_invalid", message: "Execution evidence requires artifact records." });
    return undefined;
  }
  const artifacts = value.artifacts.flatMap((artifact, index) => {
    if (!isRecord(artifact) || !isEvidenceRole(artifact.role) || !safeRelativePath(artifact.path)
        || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
      issues.push({
        code: "execution_evidence_artifact_record_invalid",
        message: `Invalid execution-evidence artifact at index ${index + 1}.`
      });
      return [];
    }
    return [{ role: artifact.role, path: artifact.path, sha256: artifact.sha256 }];
  });
  const observedRoles = new Set(artifacts.map((artifact) => artifact.role));
  const missingRoles = PROMOTION_EXECUTION_EVIDENCE_ROLES.filter((role) => !observedRoles.has(role));
  if (missingRoles.length > 0) {
    issues.push({
      code: "execution_evidence_roles_incomplete",
      message: `Missing execution-evidence roles: ${missingRoles.join(", ")}.`
    });
  }
  if (issues.length > 0 || !validId(value.run_id) || !isExecutionBackend(value.execution_backend)
      || !stringArray(value.trial_ids)) return undefined;
  return {
    schema_version: "1.0",
    evidence_class: "external_real_run",
    run_id: value.run_id,
    execution_mode: "real_execution",
    execution_status: "completed",
    execution_backend: value.execution_backend,
    started_at: value.started_at as string,
    completed_at: value.completed_at as string,
    exit_code: 0,
    trial_ids: value.trial_ids,
    artifacts
  };
}

function emptyInspection(
  issues: PromotionExecutionEvidenceIssue[],
  evidenceManifestSha256: string | null = null
): PromotionExecutionEvidenceInspection {
  return {
    passed: false,
    run_id: null,
    run_id_sha256: null,
    evidence_manifest_sha256: evidenceManifestSha256,
    execution_fingerprint: null,
    artifact_count: 0,
    roles: [],
    issues
  };
}

function resolveContainedFile(root: string, ref: string): string | undefined {
  if (!safeRelativePath(ref) || ref === PROMOTION_EXECUTION_EVIDENCE_MANIFEST) return undefined;
  const target = path.resolve(root, ref);
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? target : undefined;
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value)
    && !value.includes("\\")
    && !value.split(/[\\/]/u).some((segment) => segment === "" || segment === "." || segment === "..");
}

function isEvidenceRole(value: unknown): value is PromotionExecutionEvidenceRole {
  return typeof value === "string" && (PROMOTION_EXECUTION_EVIDENCE_ROLES as readonly string[]).includes(value);
}

function isExecutionBackend(value: unknown): value is PromotionExecutionBackend {
  return typeof value === "string" && (PROMOTION_EXECUTION_BACKENDS as readonly string[]).includes(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeExclusiveManifest(filePath: string, contents: string): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o644).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`${PROMOTION_EXECUTION_EVIDENCE_MANIFEST} already exists; refusing to overwrite it.`);
    }
    throw new Error(`Unable to create ${PROMOTION_EXECUTION_EVIDENCE_MANIFEST}.`);
  });
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch {
    await handle.close().catch(() => undefined);
    await fs.rm(filePath, { force: true });
    throw new Error(`Unable to write ${PROMOTION_EXECUTION_EVIDENCE_MANIFEST}.`);
  }
  await handle.close();
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : path.basename(absolutePath);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function hasSymbolicLinkComponent(root: string, ref: string): Promise<boolean> {
  let current = root;
  for (const segment of ref.split("/")) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}
