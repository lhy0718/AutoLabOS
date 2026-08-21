import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "node:path";

import Database from "better-sqlite3";

import { ensureDir, normalizeFsPath } from "../utils/fs.js";

const HUMAN_INTERVENTION_LOCK_WAIT_MS = 25;
const HUMAN_INTERVENTION_LOCK_TIMEOUT_MS = 15_000;

interface HumanInterventionLockLease {
  active: boolean;
}

const heldHumanInterventionLocks = new AsyncLocalStorage<
  ReadonlyMap<string, HumanInterventionLockLease>
>();

export async function withHumanInterventionRunLock<T>(
  input: {
    workspaceRoot: string;
    runId: string;
    abortSignal?: AbortSignal;
  },
  action: () => Promise<T>
): Promise<T> {
  const lockPath = resolveHumanInterventionRunLockPath(input.workspaceRoot, input.runId);
  const inheritedLocks = heldHumanInterventionLocks.getStore();
  if (inheritedLocks?.get(lockPath)?.active) {
    return action();
  }

  await ensureDir(path.dirname(lockPath));
  const startedAt = Date.now();
  let database: Database.Database | undefined;
  while (!database) {
    throwIfHumanInterventionRunLockAborted(input.abortSignal);
    database = tryAcquireHumanInterventionRunLock(lockPath);
    if (database) {
      break;
    }
    if (Date.now() - startedAt >= HUMAN_INTERVENTION_LOCK_TIMEOUT_MS) {
      throw new Error(
        "Another human-intervention update is already being processed. Please retry after it finishes."
      );
    }
    await waitForHumanInterventionRunLock(input.abortSignal);
  }

  const heldLocks = new Map(inheritedLocks);
  const lease: HumanInterventionLockLease = { active: true };
  heldLocks.set(lockPath, lease);
  try {
    return await heldHumanInterventionLocks.run(heldLocks, action);
  } finally {
    lease.active = false;
    releaseHumanInterventionRunLock(database);
  }
}

export function resolveHumanInterventionRunLockPath(
  workspaceRoot: string,
  runId: string
): string {
  const runKey = createHash("sha256").update(runId).digest("hex");
  return normalizeFsPath(path.join(
    workspaceRoot,
    ".autolabos",
    "locks",
    "human-intervention",
    `${runKey}.sqlite`
  ));
}

function tryAcquireHumanInterventionRunLock(
  lockPath: string
): Database.Database | undefined {
  const database = new Database(lockPath);
  try {
    database.pragma("busy_timeout = 0");
    database.exec("BEGIN IMMEDIATE");
    return database;
  } catch (error) {
    database.close();
    if (isSqliteBusyError(error)) {
      return undefined;
    }
    throw error;
  }
}

function releaseHumanInterventionRunLock(database: Database.Database): void {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}

async function waitForHumanInterventionRunLock(abortSignal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, HUMAN_INTERVENTION_LOCK_WAIT_MS));
  throwIfHumanInterventionRunLockAborted(abortSignal);
}

function throwIfHumanInterventionRunLockAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

function isSqliteBusyError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(String((error as { code?: unknown }).code))
  );
}
