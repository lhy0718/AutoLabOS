import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { access, mkdir, utimes, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectPromotionSourceLocks,
  PROMOTION_SOURCE_LOCK_FILENAME,
  PROMOTION_SOURCE_LOCK_STALE_AFTER_MS
} from "../src/core/runs/topicProbePromotionSourceLock.js";

const tempDirs: string[] = [];
const NOW_MS = Date.parse("2026-08-09T12:00:00.000Z");

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("inspectPromotionSourceLocks", () => {
  it("returns no diagnostics when no source lock is present", async () => {
    const workspace = createTempWorkspace();
    await mkdir(path.join(workspace, ".autolabos", "runs"), { recursive: true });

    await expect(inspectPromotionSourceLocks(workspace, { nowMs: NOW_MS })).resolves.toEqual([]);
  });

  it("reports a fresh lock as active without exposing its token", async () => {
    const workspace = createTempWorkspace();
    const lockPath = await writeLock(workspace, "run-active", {
      token: "private-lock-token",
      pid: 41,
      acquired_at: "2026-08-09T11:59:55.000Z"
    });
    await setLockMtime(lockPath, NOW_MS - 5_000);

    const diagnostics = await inspectPromotionSourceLocks(workspace, {
      nowMs: NOW_MS,
      processAlive: () => true
    });

    expect(diagnostics).toEqual([
      expect.objectContaining({
        runId: "run-active",
        status: "active",
        pid: 41,
        heartbeatAgeMs: 5_000,
        holderAlive: true
      })
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("private-lock-token");
  });

  it("reports dead-holder and stale-heartbeat locks without deleting either file", async () => {
    const workspace = createTempWorkspace();
    const orphanedPath = await writeLock(workspace, "run-orphaned", {
      token: "orphaned-token",
      pid: 42,
      acquired_at: "2026-08-09T11:59:55.000Z"
    });
    const stalePath = await writeLock(workspace, "run-stale", {
      token: "stale-token",
      pid: 43,
      acquired_at: "2026-08-09T11:50:00.000Z"
    });
    await setLockMtime(orphanedPath, NOW_MS - 5_000);
    await setLockMtime(stalePath, NOW_MS - PROMOTION_SOURCE_LOCK_STALE_AFTER_MS - 1);

    const diagnostics = await inspectPromotionSourceLocks(workspace, {
      nowMs: NOW_MS,
      processAlive: (pid) => pid === 43
    });

    expect(diagnostics.map((diagnostic) => [diagnostic.runId, diagnostic.status])).toEqual([
      ["run-orphaned", "orphaned"],
      ["run-stale", "stale"]
    ]);
    await expect(access(orphanedPath)).resolves.toBeUndefined();
    await expect(access(stalePath)).resolves.toBeUndefined();
  });

  it("fails closed on malformed lock content", async () => {
    const workspace = createTempWorkspace();
    const lockPath = path.join(
      workspace,
      ".autolabos",
      "runs",
      "run-malformed",
      PROMOTION_SOURCE_LOCK_FILENAME
    );
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "not-json\n", "utf8");

    const diagnostics = await inspectPromotionSourceLocks(workspace, { nowMs: NOW_MS });

    expect(diagnostics).toEqual([
      expect.objectContaining({ runId: "run-malformed", status: "malformed" })
    ]);
  });
});

function createTempWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "autolabos-promotion-lock-"));
  tempDirs.push(dir);
  return dir;
}

async function writeLock(
  workspace: string,
  runId: string,
  record: { token: string; pid: number; acquired_at: string }
): Promise<string> {
  const lockPath = path.join(
    workspace,
    ".autolabos",
    "runs",
    runId,
    PROMOTION_SOURCE_LOCK_FILENAME
  );
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(record)}\n`, "utf8");
  return lockPath;
}

async function setLockMtime(lockPath: string, mtimeMs: number): Promise<void> {
  const timestamp = new Date(mtimeMs);
  await utimes(lockPath, timestamp, timestamp);
}
