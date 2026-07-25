import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { ensureDir, fileExists, writeJsonFile } from "../../utils/fs.js";

export interface ExternalArtifactIntakeInput {
  cwd: string;
  outDir: string;
  externalRoot: string;
  draftPath?: string;
  logPath?: string;
  supportRoot?: string;
  supportManifestPath?: string;
}

export interface ExternalArtifactIntakeManifest {
  version: 1;
  generated_at: string;
  source_ref: string;
  run_root: string;
  copied_files: string[];
  copied_file_bindings: Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
  copied_file_mappings: Array<{
    source_ref: string;
    copied_path: string;
    sha256: string;
    bytes: number;
  }>;
  explicit_inputs: {
    draft: boolean;
    log: boolean;
    support_manifest: boolean;
    support_file_count: number;
  };
  policy_note: string;
}

export interface ExternalArtifactBinding {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ExternalArtifactIntakeBindings {
  manifest: ExternalArtifactBinding;
  canonical_projection_manifest?: ExternalArtifactBinding;
}

export interface ExternalArtifactIntakeResult {
  runRoot: string;
  manifest: ExternalArtifactIntakeManifest;
  bindings: ExternalArtifactIntakeBindings;
}

const ALLOWLISTED_RELATIVE_FILES = [
  "governance_condition.json",
  "result_table.json",
  "evidence_store.jsonl",
  "run_config.json",
  "run_record.json",
  "experiment_evidence.json",
  "events.jsonl",
  "design_contracts.json",
  path.join("audit", "design_contracts.json"),
  path.join("review", "design_contract_findings.json"),
  path.join("review", "decision.json"),
  path.join("review", "paper_critique.json"),
  path.join("figure_audit", "figure_audit_summary.json"),
  path.join("checkpoint", "state.json"),
  path.join("paper", "claim_evidence_table.json"),
  path.join("paper", "claim_status_table.json"),
  path.join("paper", "evidence_links.json"),
  path.join("paper", "evidence_gate_decision.json"),
  path.join("paper", "paper_readiness.json"),
  path.join("paper", "main.tex"),
  path.join("paper", "main.pdf"),
  path.join("paper", "build.log"),
  path.join("paper", "layout_validation.json"),
  path.join("paper", "acl.sty"),
  path.join("paper", "acl_natbib.bst"),
  path.join("paper", "references.bib"),
  path.join("paper", "academic_claim_evidence_map.json"),
  path.join("paper", "reference_evidence_status.json"),
  path.join("paper", "submission_status.json"),
  path.join("paper", "refgate_claims.tsv"),
  path.join("paper", "refgate.lock.json"),
  path.join("paper", "refgate-audit.md"),
  path.join("paper", "draft.md"),
  path.join("paper", "main.md"),
  path.join("logs", "run.log"),
  path.join("logs", "stderr.log"),
  path.join("logs", "stdout.log")
];

const ACADEMIC_PACKAGE_ALIASES = [
  { source: "manuscript.tex", destination: path.join("paper", "main.tex") },
  { source: "layout-validation.json", destination: path.join("paper", "layout_validation.json") },
  { source: "references.bib", destination: path.join("paper", "references.bib") },
  { source: "claim-evidence-map.json", destination: path.join("paper", "academic_claim_evidence_map.json") },
  { source: "reference-evidence-status.json", destination: path.join("paper", "reference_evidence_status.json") },
  { source: "submission-status.json", destination: path.join("paper", "submission_status.json") },
  { source: "refgate_claims.tsv", destination: path.join("paper", "refgate_claims.tsv") },
  { source: "refgate.lock.json", destination: path.join("paper", "refgate.lock.json") },
  { source: "refgate-audit.md", destination: path.join("paper", "refgate-audit.md") }
] as const;

interface ExternalAuditSupportManifest {
  schema_version: "1.0";
  files: Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
}

interface PreparedExternalAuditSupport {
  manifestBytes: Buffer;
  files: Array<{
    relativeFile: string;
    bytes: Buffer;
  }>;
}

const EXPLICIT_DRAFT_DESTINATION = "paper/draft.md";
const EXPLICIT_LOG_DESTINATION = "logs/external.log";
const FROZEN_SUPPORT_MANIFEST_DESTINATION = "intake/support-manifest.json";
const CANONICAL_PROJECTION_MANIFEST = "projection-manifest.json";

export function resolvePortableExternalAuditOutputDir(cwdValue: string, outDirValue: string): string {
  const cwd = path.resolve(cwdValue);
  const outputDir = path.resolve(cwd, outDirValue);
  if (!isInsideRoot(cwd, outputDir)) {
    throw new Error("External audit output directory must be within cwd so run_root remains portable.");
  }
  return outputDir;
}

export async function materializeExternalAuditArtifacts(
  input: ExternalArtifactIntakeInput
): Promise<ExternalArtifactIntakeResult> {
  const cwd = path.resolve(input.cwd);
  const outputDir = resolvePortableExternalAuditOutputDir(cwd, input.outDir);
  if (Boolean(input.supportRoot) !== Boolean(input.supportManifestPath)) {
    throw new Error("External audit support intake requires both supportRoot and supportManifestPath.");
  }
  const configuredSourceRoot = path.resolve(cwd, input.externalRoot);
  const sourceRootStat = await fs.lstat(configuredSourceRoot);
  if (!sourceRootStat.isDirectory() || sourceRootStat.isSymbolicLink()) {
    throw new Error("External artifact root must be a real directory, not a symlink.");
  }
  const sourceRoot = await fs.realpath(configuredSourceRoot);
  const runRoot = path.join(outputDir, "_external-intake", "run-artifacts");
  const reservedSupportDestinations = new Set([FROZEN_SUPPORT_MANIFEST_DESTINATION]);
  if (input.draftPath) {
    reservedSupportDestinations.add(EXPLICIT_DRAFT_DESTINATION);
  }
  if (input.logPath) {
    reservedSupportDestinations.add(EXPLICIT_LOG_DESTINATION);
  }
  const preparedSupport = input.supportRoot && input.supportManifestPath
    ? await prepareSupportManifestFiles({
        cwd,
        supportRoot: input.supportRoot,
        supportManifestPath: input.supportManifestPath,
        reservedDestinations: reservedSupportDestinations
      })
    : undefined;

  await fs.rm(runRoot, { recursive: true, force: true });
  await ensureDir(runRoot);

  const copiedFiles: string[] = [];
  const copiedFileMappings: Array<{ source_ref: string; copied_path: string }> = [];
  for (const relativeFile of ALLOWLISTED_RELATIVE_FILES) {
    const normalizedRelativeFile = normalizeRelativeFile(relativeFile);
    const sourcePath = path.join(sourceRoot, normalizedRelativeFile);
    if (!(await fileExists(sourcePath))) {
      continue;
    }
    await copyFile(sourcePath, path.join(runRoot, normalizedRelativeFile), sourceRoot);
    copiedFiles.push(normalizedRelativeFile);
    copiedFileMappings.push({
      source_ref: normalizedRelativeFile,
      copied_path: normalizedRelativeFile
    });
  }

  for (const alias of ACADEMIC_PACKAGE_ALIASES) {
    const sourcePath = path.join(sourceRoot, alias.source);
    const destinationPath = path.join(runRoot, alias.destination);
    if (!(await fileExists(sourcePath)) || await fileExists(destinationPath)) {
      continue;
    }
    await copyFile(sourcePath, destinationPath, sourceRoot);
    const copiedPath = normalizeRelativeFile(alias.destination);
    copiedFiles.push(copiedPath);
    copiedFileMappings.push({ source_ref: alias.source, copied_path: copiedPath });
  }

  let supportFileCount = 0;
  if (preparedSupport) {
    const support = await copyPreparedSupportManifestFiles({
      runRoot,
      prepared: preparedSupport
    });
    copiedFiles.push(...support.copiedFiles);
    copiedFileMappings.push(...support.mappings);
    supportFileCount = support.fileCount;
  }

  if (input.draftPath) {
    await copyFile(path.resolve(cwd, input.draftPath), path.join(runRoot, EXPLICIT_DRAFT_DESTINATION));
    copiedFiles.push(EXPLICIT_DRAFT_DESTINATION);
    copiedFileMappings.push({ source_ref: "<explicit-draft>", copied_path: EXPLICIT_DRAFT_DESTINATION });
  }
  if (input.logPath) {
    await copyFile(path.resolve(cwd, input.logPath), path.join(runRoot, EXPLICIT_LOG_DESTINATION));
    copiedFiles.push(EXPLICIT_LOG_DESTINATION);
    copiedFileMappings.push({ source_ref: "<explicit-log>", copied_path: EXPLICIT_LOG_DESTINATION });
  }

  const uniqueCopiedFiles = [...new Set(copiedFiles)].sort();
  const copiedFileBindings = await Promise.all(uniqueCopiedFiles.map(async (relativeFile) => {
    const bytes = await fs.readFile(path.join(runRoot, relativeFile));
    return {
      path: relativeFile,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength
    };
  }));
  const bindingsByPath = new Map(copiedFileBindings.map((binding) => [binding.path, binding] as const));
  const normalizedMappings = copiedFileMappings
    .map((mapping) => {
      const binding = bindingsByPath.get(mapping.copied_path);
      return binding ? { ...mapping, sha256: binding.sha256, bytes: binding.bytes } : undefined;
    })
    .filter((mapping): mapping is NonNullable<typeof mapping> => Boolean(mapping))
    .sort((left, right) =>
      left.copied_path.localeCompare(right.copied_path)
      || left.source_ref.localeCompare(right.source_ref)
    );
  const manifest: ExternalArtifactIntakeManifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    source_ref: "<external-artifact-root>",
    run_root: normalizePath(path.relative(cwd, runRoot)),
    copied_files: uniqueCopiedFiles,
    copied_file_bindings: copiedFileBindings,
    copied_file_mappings: normalizedMappings,
    explicit_inputs: {
      draft: Boolean(input.draftPath),
      log: Boolean(input.logPath),
      support_manifest: Boolean(input.supportManifestPath),
      support_file_count: supportFileCount
    },
    policy_note: "External intake copies allowlisted artifacts plus explicitly hash-bound support-manifest files, records portable source-to-copy mappings, rejects path escape and symlinks, binds every copied file by SHA-256 and byte length, and omits machine-local source paths."
  };
  const manifestPath = path.join(outputDir, "external-intake-manifest.json");
  await writeJsonFile(manifestPath, manifest);
  const canonicalProjectionManifest = copiedFileBindings.find(
    (binding) => binding.path === CANONICAL_PROJECTION_MANIFEST
  );
  const bindings: ExternalArtifactIntakeBindings = {
    manifest: await bindPortableFile(cwd, manifestPath),
    ...(canonicalProjectionManifest
      ? {
          canonical_projection_manifest: await bindPortableFile(
            cwd,
            path.join(runRoot, canonicalProjectionManifest.path)
          )
        }
      : {})
  };
  return { runRoot, manifest, bindings };
}

async function prepareSupportManifestFiles(input: {
  cwd: string;
  supportRoot: string;
  supportManifestPath: string;
  reservedDestinations: ReadonlySet<string>;
}): Promise<PreparedExternalAuditSupport> {
  const supportRoot = path.resolve(input.cwd, input.supportRoot);
  const supportRootStat = await fs.lstat(supportRoot);
  if (!supportRootStat.isDirectory() || supportRootStat.isSymbolicLink()) {
    throw new Error("External audit supportRoot must be a real directory, not a symlink.");
  }
  const realSupportRoot = await fs.realpath(supportRoot);
  const manifestPath = path.resolve(input.cwd, input.supportManifestPath);
  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("External audit support manifest must be a regular file, not a symlink.");
  }
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = parseSupportManifest(manifestBytes);
  const files: PreparedExternalAuditSupport["files"] = [];
  const seen = new Set<string>();
  for (const file of manifest.files) {
    const relativeFile = normalizeSupportPath(file.path);
    if (seen.has(relativeFile)) {
      throw new Error(`External audit support manifest contains duplicate path: ${relativeFile}`);
    }
    seen.add(relativeFile);
    if (input.reservedDestinations.has(relativeFile)) {
      throw new Error(`External audit support path collides with a reserved intake destination: ${relativeFile}`);
    }
    await assertNoSymlinkSegments(realSupportRoot, relativeFile);
    const sourcePath = path.join(realSupportRoot, relativeFile);
    const realSourcePath = await fs.realpath(sourcePath);
    if (!isInsideRoot(realSupportRoot, realSourcePath)) {
      throw new Error(`External audit support path escapes supportRoot: ${relativeFile}`);
    }
    const sourceStat = await fs.stat(realSourcePath);
    if (!sourceStat.isFile()) {
      throw new Error(`External audit support path is not a regular file: ${relativeFile}`);
    }
    const bytes = await fs.readFile(realSourcePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== file.bytes || sha256 !== file.sha256) {
      throw new Error(`External audit support binding mismatch: ${relativeFile}`);
    }
    files.push({ relativeFile, bytes });
  }
  return { manifestBytes, files };
}

async function copyPreparedSupportManifestFiles(input: {
  runRoot: string;
  prepared: PreparedExternalAuditSupport;
}): Promise<{
  copiedFiles: string[];
  mappings: Array<{ source_ref: string; copied_path: string }>;
  fileCount: number;
}> {
  const copiedFiles: string[] = [];
  const mappings: Array<{ source_ref: string; copied_path: string }> = [];
  for (const file of input.prepared.files) {
    const destination = path.join(input.runRoot, file.relativeFile);
    if (await fileExists(destination)) {
      throw new Error(`External audit support path collides with an allowlisted artifact: ${file.relativeFile}`);
    }
  }
  for (const file of input.prepared.files) {
    const destination = path.join(input.runRoot, file.relativeFile);
    await ensureDir(path.dirname(destination));
    await fs.writeFile(destination, file.bytes);
    copiedFiles.push(file.relativeFile);
    mappings.push({ source_ref: `support:${file.relativeFile}`, copied_path: file.relativeFile });
  }

  const frozenManifestPath = path.join(input.runRoot, FROZEN_SUPPORT_MANIFEST_DESTINATION);
  await ensureDir(path.dirname(frozenManifestPath));
  await fs.writeFile(frozenManifestPath, input.prepared.manifestBytes);
  copiedFiles.push(FROZEN_SUPPORT_MANIFEST_DESTINATION);
  mappings.push({ source_ref: "<support-manifest>", copied_path: FROZEN_SUPPORT_MANIFEST_DESTINATION });
  return { copiedFiles, mappings, fileCount: input.prepared.files.length };
}

function parseSupportManifest(bytes: Buffer): ExternalAuditSupportManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("External audit support manifest must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("External audit support manifest must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== "1.0" || !Array.isArray(record.files) || record.files.length === 0) {
    throw new Error("External audit support manifest requires schema_version 1.0 and a non-empty files array.");
  }
  const files = record.files.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`External audit support manifest file ${index} must be an object.`);
    }
    const file = entry as Record<string, unknown>;
    if (typeof file.path !== "string"
        || typeof file.sha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(file.sha256)
        || typeof file.bytes !== "number"
        || !Number.isSafeInteger(file.bytes)
        || file.bytes < 0) {
      throw new Error(`External audit support manifest file ${index} has an invalid path, sha256, or bytes field.`);
    }
    return { path: normalizeSupportPath(file.path), sha256: file.sha256, bytes: file.bytes };
  });
  return { schema_version: "1.0", files };
}

function normalizeSupportPath(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  if (!normalized
      || normalized !== path.posix.normalize(normalized)
      || path.posix.isAbsolute(normalized)
      || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`External audit support path must be portable and relative: ${value}`);
  }
  return normalized;
}

async function assertNoSymlinkSegments(root: string, relativeFile: string): Promise<void> {
  let current = root;
  for (const segment of relativeFile.split("/")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`External audit support path contains a symlink: ${relativeFile}`);
    }
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function normalizeRelativeFile(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/u, "");
}

async function copyFile(
  sourcePath: string,
  destinationPath: string,
  allowedRoot?: string
): Promise<void> {
  const sourceLstat = await fs.lstat(sourcePath);
  if (!sourceLstat.isFile() || sourceLstat.isSymbolicLink()) {
    throw new Error("External intake accepts regular files only; symlinks are not allowed.");
  }
  const realSourcePath = await fs.realpath(sourcePath);
  if (allowedRoot && !isInsideRoot(allowedRoot, realSourcePath)) {
    throw new Error("External intake source escapes the declared artifact root.");
  }
  await ensureDir(path.dirname(destinationPath));
  await fs.copyFile(realSourcePath, destinationPath);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

async function bindPortableFile(cwd: string, absolutePath: string): Promise<ExternalArtifactBinding> {
  const bytes = await fs.readFile(absolutePath);
  return {
    path: normalizePath(path.relative(cwd, absolutePath)),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.byteLength
  };
}
