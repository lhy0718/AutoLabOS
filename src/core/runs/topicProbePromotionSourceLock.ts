import { promises as fs } from "node:fs";
import path from "node:path";

import { buildWorkspaceRunsDir } from "./runPaths.js";

export const PROMOTION_SOURCE_LOCK_FILENAME = ".topic-probe-followup-source.lock";
export const PROMOTION_SOURCE_LOCK_HEARTBEAT_MS = 30 * 1000;
export const PROMOTION_SOURCE_LOCK_STALE_AFTER_MS = 3 * PROMOTION_SOURCE_LOCK_HEARTBEAT_MS;

export type PromotionSourceLockStatus =
  | "active"
  | "stale"
  | "orphaned"
  | "malformed"
  | "unreadable";

export interface PromotionSourceLockDiagnostic {
  runId: string;
  status: PromotionSourceLockStatus;
  pid?: number;
  acquiredAt?: string;
  heartbeatAt?: string;
  heartbeatAgeMs?: number;
  holderAlive?: boolean;
  detail: string;
}

export interface InspectPromotionSourceLocksOptions {
  nowMs?: number;
  processAlive?: (pid: number) => boolean | undefined;
}

interface PromotionSourceLockRecord {
  token?: unknown;
  pid?: unknown;
  acquired_at?: unknown;
}

export async function inspectPromotionSourceLocks(
  workspaceRoot: string,
  options: InspectPromotionSourceLocksOptions = {}
): Promise<PromotionSourceLockDiagnostic[]> {
  const runsDir = buildWorkspaceRunsDir(workspaceRoot);
  const nowMs = options.nowMs ?? Date.now();
  const processAlive = options.processAlive ?? probeProcessAlive;
  let entries;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return [];
    return [{
      runId: "(run-store)",
      status: "unreadable",
      detail: `Could not inspect the run store: ${formatError(error)}`
    }];
  }

  const diagnostics: PromotionSourceLockDiagnostic[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const lockPath = path.join(runsDir, entry.name, PROMOTION_SOURCE_LOCK_FILENAME);
    const diagnostic = await inspectPromotionSourceLock({
      lockPath,
      runId: entry.name,
      nowMs,
      processAlive
    });
    if (diagnostic) diagnostics.push(diagnostic);
  }
  return diagnostics;
}

async function inspectPromotionSourceLock(input: {
  lockPath: string;
  runId: string;
  nowMs: number;
  processAlive: (pid: number) => boolean | undefined;
}): Promise<PromotionSourceLockDiagnostic | undefined> {
  let stat;
  let raw: string;
  try {
    [stat, raw] = await Promise.all([
      fs.stat(input.lockPath),
      fs.readFile(input.lockPath, "utf8")
    ]);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return undefined;
    return {
      runId: input.runId,
      status: "unreadable",
      detail: `Lock file could not be inspected: ${formatError(error)}`
    };
  }

  let record: PromotionSourceLockRecord;
  try {
    record = JSON.parse(raw) as PromotionSourceLockRecord;
  } catch {
    return {
      runId: input.runId,
      status: "malformed",
      heartbeatAt: stat.mtime.toISOString(),
      heartbeatAgeMs: Math.max(0, input.nowMs - stat.mtimeMs),
      detail: "Lock file is not valid JSON."
    };
  }

  const pid = normalizePid(record.pid);
  const acquiredAt = normalizeTimestamp(record.acquired_at);
  const tokenValid = typeof record.token === "string" && record.token.trim().length > 0;
  const heartbeatAgeMs = Math.max(0, input.nowMs - stat.mtimeMs);
  const heartbeatAt = stat.mtime.toISOString();
  if (!pid || !acquiredAt || !tokenValid) {
    return {
      runId: input.runId,
      status: "malformed",
      pid,
      acquiredAt,
      heartbeatAt,
      heartbeatAgeMs,
      detail: "Lock file is missing a valid token, pid, or acquisition timestamp."
    };
  }

  const holderAlive = input.processAlive(pid);
  if (holderAlive === false) {
    return {
      runId: input.runId,
      status: "orphaned",
      pid,
      acquiredAt,
      heartbeatAt,
      heartbeatAgeMs,
      holderAlive,
      detail: "The recorded holder process is no longer running."
    };
  }
  if (heartbeatAgeMs > PROMOTION_SOURCE_LOCK_STALE_AFTER_MS) {
    return {
      runId: input.runId,
      status: "stale",
      pid,
      acquiredAt,
      heartbeatAt,
      heartbeatAgeMs,
      holderAlive,
      detail: "The lock heartbeat is older than the allowed freshness window."
    };
  }
  return {
    runId: input.runId,
    status: "active",
    pid,
    acquiredAt,
    heartbeatAt,
    heartbeatAgeMs,
    holderAlive,
    detail: holderAlive === true
      ? "The holder process is running and the heartbeat is fresh."
      : "The heartbeat is fresh, but holder-process liveness could not be determined."
  };
}

function probeProcessAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = readErrorCode(error);
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return undefined;
  }
}

function normalizePid(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
