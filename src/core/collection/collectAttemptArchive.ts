import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import type { RunRecord } from "../../types.js";
import {
  runArtifactsDir,
  writeRunArtifact
} from "../nodes/helpers.js";

export type CollectAttemptStatus =
  | "planned"
  | "planning_failed"
  | "collection_failed"
  | "quality_gate_failed"
  | "quality_gate_passed";

export type CollectAttemptArchivePhase =
  | "planning"
  | "collection"
  | "enrichment"
  | "recovery";

export interface CollectAttemptArchiveManifest {
  version: 2;
  kind: "collect_attempt_archive";
  collect_attempt_id: string;
  run_id: string;
  status: CollectAttemptStatus;
  phase: CollectAttemptArchivePhase;
  revision_id: string;
  archived_at: string;
  files: Array<{
    source_path: string;
    archived_path: string;
    sha256: string;
    byte_size: number;
  }>;
}

export interface CollectAttemptArchiveIntegrityInput {
  runDir: string;
  expectedRunId: string;
  expectedAttemptId: string;
  manifestValue?: unknown;
  requiredArtifacts?: ReadonlyMap<string, string>;
}

export function createCollectAttemptId(
  now: Date = new Date(),
  nonce: string = randomUUID()
): string {
  const timestamp = now.toISOString().replace(/[-:.TZ]/gu, "");
  const normalizedNonce = nonce.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (!normalizedNonce) {
    throw new Error("collect_attempt_nonce_invalid");
  }
  return `${timestamp}-${normalizedNonce.slice(0, 12)}`;
}

export async function persistCollectAttemptArchive(input: {
  run: RunRecord;
  attemptId: string;
  status: CollectAttemptStatus;
  artifactPaths: string[];
  phase?: CollectAttemptArchivePhase;
  artifactContents?: Readonly<Record<string, string>>;
  publishTopLevelLatest?: boolean;
  archivedAt?: string;
}): Promise<CollectAttemptArchiveManifest> {
  const attemptId = normalizeAttemptId(input.attemptId);
  const artifactPaths = uniqueArtifactPaths(input.artifactPaths);
  const phase = input.phase ?? defaultArchivePhase(input.status);
  const snapshots: Array<{
    sourcePath: string;
    content: string;
    sha256: string;
    byteSize: number;
  }> = [];

  for (const sourcePath of artifactPaths) {
    let content: string;
    if (Object.prototype.hasOwnProperty.call(input.artifactContents ?? {}, sourcePath)) {
      content = input.artifactContents?.[sourcePath] ?? "";
    } else {
      const attemptSourcePath = path.join(
        runArtifactsDir(input.run),
        "collect_attempts",
        attemptId,
        sourcePath
      );
      const absoluteSourcePath = path.join(runArtifactsDir(input.run), sourcePath);
      try {
        content = await fs.readFile(attemptSourcePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        try {
          content = await fs.readFile(absoluteSourcePath, "utf8");
        } catch (sourceError) {
          if ((sourceError as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          throw sourceError;
        }
      }
    }
    snapshots.push({
      sourcePath,
      content,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      byteSize: Buffer.byteLength(content, "utf8")
    });
  }

  const revisionHash = createHash("sha256")
    .update(JSON.stringify({
      collect_attempt_id: attemptId,
      run_id: input.run.id,
      status: input.status,
      phase,
      files: snapshots.map((snapshot) => ({
        source_path: snapshot.sourcePath,
        sha256: snapshot.sha256,
        byte_size: snapshot.byteSize
      }))
    }))
    .digest("hex");
  const revisionId = `${phase}-${revisionHash.slice(0, 20)}`;
  const revisionRoot = path.posix.join(
    "collect_attempts",
    attemptId,
    "revisions",
    revisionId
  );
  const files: CollectAttemptArchiveManifest["files"] = snapshots.map((snapshot) => ({
    source_path: snapshot.sourcePath,
    archived_path: path.posix.join(
      revisionRoot,
      "artifacts",
      snapshot.sourcePath
    ),
    sha256: snapshot.sha256,
    byte_size: snapshot.byteSize
  }));
  const candidateManifest: CollectAttemptArchiveManifest = {
    version: 2,
    kind: "collect_attempt_archive",
    collect_attempt_id: attemptId,
    run_id: input.run.id,
    status: input.status,
    phase,
    revision_id: revisionId,
    archived_at: input.archivedAt ?? new Date().toISOString(),
    files
  };
  const revisionManifestPath = path.posix.join(revisionRoot, "manifest.json");
  const existingManifest = await readExistingManifest(input.run, revisionManifestPath);
  const manifest = existingManifest ?? candidateManifest;

  if (existingManifest) {
    assertSameRevision(existingManifest, candidateManifest);
  } else {
    for (const [index, snapshot] of snapshots.entries()) {
      await writeImmutableArtifact(
        input.run,
        files[index]!.archived_path,
        snapshot.content
      );
    }
    await writeImmutableArtifact(
      input.run,
      revisionManifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`
    );
  }

  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeRunArtifact(
    input.run,
    path.posix.join("collect_attempts", attemptId, "latest.json"),
    `${JSON.stringify({
      version: 1,
      kind: "collect_attempt_archive_latest",
      collect_attempt_id: attemptId,
      revision_id: manifest.revision_id,
      manifest_path: revisionManifestPath,
      updated_at: new Date().toISOString()
    }, null, 2)}\n`
  );
  await writeRunArtifact(
    input.run,
    path.posix.join("collect_attempts", attemptId, "manifest.json"),
    serialized
  );
  for (const [index, snapshot] of snapshots.entries()) {
    await writeRunArtifact(
      input.run,
      path.posix.join("collect_attempts", attemptId, snapshot.sourcePath),
      snapshot.content
    );
    if (files[index]?.sha256 !== snapshot.sha256) {
      throw new Error("collect_attempt_archive_internal_mismatch");
    }
  }
  if (input.publishTopLevelLatest !== false) {
    await writeRunArtifact(input.run, "collect_attempt_manifest.json", serialized);
  }
  return manifest;
}

export async function auditCollectAttemptArchiveIntegrity(
  input: CollectAttemptArchiveIntegrityInput
): Promise<string[]> {
  const manifestValue = input.manifestValue ?? await readJsonValue(
    path.join(
      input.runDir,
      "collect_attempts",
      input.expectedAttemptId,
      "manifest.json"
    )
  );
  const manifest = parseCollectAttemptArchiveManifest(
    manifestValue,
    input.expectedRunId,
    input.expectedAttemptId
  );
  if (!manifest) {
    return ["collect_lineage_manifest_contract_invalid"];
  }

  const reasons: string[] = [];
  if (manifest.revision_id !== expectedCollectAttemptRevisionId(manifest)) {
    reasons.push("collect_lineage_manifest_revision_mismatch");
  }
  const requiredPaths = new Set(input.requiredArtifacts?.keys() ?? []);
  const fileBySourcePath = new Map(
    manifest.files.map((file) => [file.source_path, file] as const)
  );
  if ([...requiredPaths].some((sourcePath) => !fileBySourcePath.has(sourcePath))) {
    reasons.push("collect_lineage_topic_archive_file_missing");
  }

  const revisionManifest = parseCollectAttemptArchiveManifest(
    await readJsonValue(path.join(
      input.runDir,
      "collect_attempts",
      manifest.collect_attempt_id,
      "revisions",
      manifest.revision_id,
      "manifest.json"
    )),
    input.expectedRunId,
    input.expectedAttemptId
  );
  if (
    !revisionManifest
    || JSON.stringify(comparableManifest(revisionManifest))
      !== JSON.stringify(comparableManifest(manifest))
  ) {
    reasons.push("collect_lineage_manifest_immutable_revision_mismatch");
  }

  let immutableArtifactMismatch = false;
  let liveArtifactMismatch = false;
  for (const file of manifest.files) {
    const immutablePath = path.join(input.runDir, file.archived_path);
    try {
      const content = await fs.readFile(immutablePath);
      if (
        content.byteLength !== file.byte_size
        || createHash("sha256").update(content).digest("hex") !== file.sha256
      ) {
        immutableArtifactMismatch = true;
      }
    } catch {
      immutableArtifactMismatch = true;
    }
    if (requiredPaths.has(file.source_path)) {
      const liveRaw = input.requiredArtifacts?.get(file.source_path);
      if (
        liveRaw === undefined
        || Buffer.byteLength(liveRaw, "utf8") !== file.byte_size
        || createHash("sha256").update(liveRaw, "utf8").digest("hex")
          !== file.sha256
      ) {
        liveArtifactMismatch = true;
      }
    }
  }
  if (immutableArtifactMismatch) {
    reasons.push("collect_lineage_manifest_immutable_artifact_mismatch");
  }
  if (liveArtifactMismatch) {
    reasons.push("collect_lineage_topic_live_archive_mismatch");
  }
  return [...new Set(reasons)].sort((left, right) => left.localeCompare(right));
}

function parseCollectAttemptArchiveManifest(
  value: unknown,
  expectedRunId: string,
  expectedAttemptId: string
): CollectAttemptArchiveManifest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    value.version !== 2
    || value.kind !== "collect_attempt_archive"
    || value.collect_attempt_id !== expectedAttemptId
    || !/^[a-z0-9][a-z0-9-]{7,80}$/iu.test(expectedAttemptId)
    || value.run_id !== expectedRunId
    || !isCollectAttemptStatus(value.status)
    || !isCollectAttemptPhase(value.phase)
    || typeof value.revision_id !== "string"
    || !new RegExp(`^${value.phase}-[a-f0-9]{20}$`, "u").test(value.revision_id)
    || typeof value.archived_at !== "string"
    || !value.archived_at.trim()
    || !Array.isArray(value.files)
    || value.files.length === 0
  ) {
    return undefined;
  }
  const sourcePaths = new Set<string>();
  const archivedPaths = new Set<string>();
  const files: CollectAttemptArchiveManifest["files"] = [];
  for (const item of value.files) {
    if (!isRecord(item)) {
      return undefined;
    }
    const sourcePath = item.source_path;
    const archivedPath = item.archived_path;
    const expectedArchivedPath = typeof sourcePath === "string"
      ? path.posix.join(
          "collect_attempts",
          expectedAttemptId,
          "revisions",
          value.revision_id,
          "artifacts",
          sourcePath
        )
      : undefined;
    if (
      typeof sourcePath !== "string"
      || sourcePath !== path.posix.normalize(sourcePath)
      || path.posix.isAbsolute(sourcePath)
      || sourcePath.includes("\\")
      || sourcePath.split("/").includes("..")
      || sourcePath.startsWith("collect_attempts/")
      || typeof archivedPath !== "string"
      || archivedPath !== expectedArchivedPath
      || typeof item.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(item.sha256)
      || typeof item.byte_size !== "number"
      || !Number.isInteger(item.byte_size)
      || item.byte_size < 0
      || sourcePaths.has(sourcePath)
      || archivedPaths.has(archivedPath)
    ) {
      return undefined;
    }
    sourcePaths.add(sourcePath);
    archivedPaths.add(archivedPath);
    files.push({
      source_path: sourcePath,
      archived_path: archivedPath,
      sha256: item.sha256,
      byte_size: item.byte_size
    });
  }
  return {
    version: 2,
    kind: "collect_attempt_archive",
    collect_attempt_id: expectedAttemptId,
    run_id: expectedRunId,
    status: value.status,
    phase: value.phase,
    revision_id: value.revision_id,
    archived_at: value.archived_at,
    files
  };
}

function expectedCollectAttemptRevisionId(
  manifest: CollectAttemptArchiveManifest
): string {
  const revisionHash = createHash("sha256")
    .update(JSON.stringify({
      collect_attempt_id: manifest.collect_attempt_id,
      run_id: manifest.run_id,
      status: manifest.status,
      phase: manifest.phase,
      files: manifest.files.map((file) => ({
        source_path: file.source_path,
        sha256: file.sha256,
        byte_size: file.byte_size
      }))
    }))
    .digest("hex");
  return `${manifest.phase}-${revisionHash.slice(0, 20)}`;
}

function comparableManifest(manifest: CollectAttemptArchiveManifest): unknown {
  return {
    version: manifest.version,
    kind: manifest.kind,
    collect_attempt_id: manifest.collect_attempt_id,
    run_id: manifest.run_id,
    status: manifest.status,
    phase: manifest.phase,
    revision_id: manifest.revision_id,
    archived_at: manifest.archived_at,
    files: manifest.files
  };
}

async function readJsonValue(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isCollectAttemptStatus(value: unknown): value is CollectAttemptStatus {
  return value === "planned"
    || value === "planning_failed"
    || value === "collection_failed"
    || value === "quality_gate_failed"
    || value === "quality_gate_passed";
}

function isCollectAttemptPhase(value: unknown): value is CollectAttemptArchivePhase {
  return value === "planning"
    || value === "collection"
    || value === "enrichment"
    || value === "recovery";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultArchivePhase(status: CollectAttemptStatus): CollectAttemptArchivePhase {
  return status === "planned" || status === "planning_failed" ? "planning" : "collection";
}

async function readExistingManifest(
  run: RunRecord,
  artifactPath: string
): Promise<CollectAttemptArchiveManifest | null> {
  try {
    const raw = await fs.readFile(path.join(runArtifactsDir(run), artifactPath), "utf8");
    return JSON.parse(raw) as CollectAttemptArchiveManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function assertSameRevision(
  existing: CollectAttemptArchiveManifest,
  candidate: CollectAttemptArchiveManifest
): void {
  const comparable = (manifest: CollectAttemptArchiveManifest) => ({
    version: manifest.version,
    kind: manifest.kind,
    collect_attempt_id: manifest.collect_attempt_id,
    run_id: manifest.run_id,
    status: manifest.status,
    phase: manifest.phase,
    revision_id: manifest.revision_id,
    files: manifest.files
  });
  if (JSON.stringify(comparable(existing)) !== JSON.stringify(comparable(candidate))) {
    throw new Error("collect_attempt_archive_revision_conflict");
  }
}

async function writeImmutableArtifact(
  run: RunRecord,
  artifactPath: string,
  content: string
): Promise<void> {
  const absolutePath = path.join(runArtifactsDir(run), artifactPath);
  try {
    const existing = await fs.readFile(absolutePath, "utf8");
    if (existing !== content) {
      throw new Error("collect_attempt_archive_immutable_conflict");
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  await writeRunArtifact(run, artifactPath, content);
}

function normalizeAttemptId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{7,80}$/iu.test(normalized)) {
    throw new Error("collect_attempt_id_invalid");
  }
  return normalized;
}

function uniqueArtifactPaths(values: string[]): string[] {
  return Array.from(new Set(values.map(normalizeArtifactPath)));
}

function normalizeArtifactPath(value: string): string {
  const normalized = value.trim().replace(/\\/gu, "/");
  if (
    !normalized
    || path.posix.isAbsolute(normalized)
    || normalized.split("/").includes("..")
    || normalized.startsWith("collect_attempts/")
  ) {
    throw new Error("collect_attempt_artifact_path_invalid");
  }
  return normalized;
}
