import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureScaffold, resolveAppPaths } from "../src/config.js";
import {
  buildPromotionParentStateSha256,
  RunPromotionStore,
  TOPIC_PROBE_CONFIRMATORY_RELATION,
  type RunPromotionReservationInput
} from "../src/core/runs/runPromotionStore.js";
import { RunStore } from "../src/core/runs/runStore.js";
import type { RunRecord } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("RunPromotionStore", () => {
  it("reserves once across separate connections and binds the parent-cycle to one outcome", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "autolabos-promotion-"));
    tempDirs.push(cwd);
    const paths = resolveAppPaths(cwd);
    await ensureScaffold(paths);
    const runStore = new RunStore(paths);
    const parent = await createEligibleParent(runStore, "Parent run");
    const childRunId = randomUUID();
    const outcomeContentSha256 = sha256("validated outcome");
    const input = buildReservationInput(
      parent,
      childRunId,
      outcomeContentSha256,
      "first payload"
    );
    const competingInput = buildReservationInput(
      parent,
      childRunId,
      outcomeContentSha256,
      "competing payload"
    );
    const firstConnection = new RunPromotionStore(paths.runsDbFile);
    const secondConnection = new RunPromotionStore(paths.runsDbFile);

    try {
      const [first, second] = await Promise.all([
        Promise.resolve().then(() => firstConnection.reserveOrLoad(input)),
        Promise.resolve().then(() =>
          secondConnection.reserveOrLoad(competingInput)
        )
      ]);

      expect([first.status, second.status].sort()).toEqual([
        "loaded",
        "reserved"
      ]);
      expect(first.reservation).toEqual(second.reservation);
      expect(first.reservation.childRunId).toBe(childRunId);
      expect(
        JSON.parse(first.reservation.immutablePayloadJson)
      ).toMatchObject({ label: expect.stringMatching(/payload/) });

      const reloadedParent = await new RunStore(paths).getRun(parent.id);
      expect(reloadedParent?.delegatedSuccessor).toMatchObject({
        state: "delegated",
        relation: TOPIC_PROBE_CONFIRMATORY_RELATION,
        childRunId,
        outcomeContentSha256
      });

      const changedOutcome = buildReservationInput(
        parent,
        randomUUID(),
        sha256("different validated outcome"),
        "changed outcome"
      );
      expect(() => firstConnection.reserveOrLoad(changedOutcome)).toThrow(
        "run_promotion_outcome_identity_conflict"
      );

      const otherParent = await createEligibleParent(runStore, "Other parent");
      const reusedOutcome = buildReservationInput(
        otherParent,
        randomUUID(),
        outcomeContentSha256,
        "reused outcome"
      );
      expect(() => secondConnection.reserveOrLoad(reusedOutcome)).toThrow(
        "run_promotion_outcome_identity_conflict"
      );
    } finally {
      firstConnection.close();
      secondConnection.close();
    }
  });

  it("fences an expired execution owner and preserves one terminal result", async () => {
    const cwd = mkdtempSync(
      path.join(os.tmpdir(), "autolabos-promotion-lease-")
    );
    tempDirs.push(cwd);
    const paths = resolveAppPaths(cwd);
    await ensureScaffold(paths);
    const runStore = new RunStore(paths);
    const parent = await createEligibleParent(runStore, "Lease parent");
    const childRunId = randomUUID();
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const firstConnection = new RunPromotionStore(paths.runsDbFile, () => now);
    const secondConnection = new RunPromotionStore(paths.runsDbFile, () => now);

    try {
      firstConnection.reserveOrLoad(
        buildReservationInput(
          parent,
          childRunId,
          sha256("lease outcome"),
          "lease payload"
        )
      );
      const firstClaim = firstConnection.claimExecution({
        childRunId,
        ownerId: "worker-a",
        leaseDurationMs: 1_000
      });
      expect(firstClaim.status).toBe("claimed");
      if (firstClaim.status !== "claimed") {
        throw new Error("expected first execution claim");
      }

      expect(secondConnection.claimExecution({
        childRunId,
        ownerId: "worker-b",
        leaseDurationMs: 1_000
      })).toMatchObject({ status: "busy" });

      now += 1_001;
      const reclaimed = secondConnection.claimExecution({
        childRunId,
        ownerId: "worker-b",
        leaseDurationMs: 1_000
      });
      expect(reclaimed).toMatchObject({
        status: "claimed",
        reclaimed: true
      });
      if (reclaimed.status !== "claimed") {
        throw new Error("expected reclaimed execution lease");
      }
      expect(reclaimed.lease.fenceToken).toBeGreaterThan(
        firstClaim.lease.fenceToken
      );

      expect(() => firstConnection.heartbeat({
        childRunId,
        ownerId: "worker-a",
        fenceToken: firstClaim.lease.fenceToken,
        leaseDurationMs: 1_000
      })).toThrow("run_promotion_execution_fence_stale");
      expect(() => firstConnection.markTerminal({
        childRunId,
        ownerId: "worker-a",
        fenceToken: firstClaim.lease.fenceToken,
        status: "completed"
      })).toThrow("run_promotion_execution_fence_stale");

      secondConnection.heartbeat({
        childRunId,
        ownerId: "worker-b",
        fenceToken: reclaimed.lease.fenceToken,
        leaseDurationMs: 1_000
      });
      const terminal = secondConnection.markTerminal({
        childRunId,
        ownerId: "worker-b",
        fenceToken: reclaimed.lease.fenceToken,
        status: "completed",
        detail: "confirmatory run completed"
      });
      expect(terminal).toMatchObject({
        status: "completed",
        fenceToken: reclaimed.lease.fenceToken
      });
      expect(secondConnection.markTerminal({
        childRunId,
        ownerId: "worker-b",
        fenceToken: reclaimed.lease.fenceToken,
        status: "completed"
      })).toEqual(terminal);
      expect(firstConnection.claimExecution({
        childRunId,
        ownerId: "worker-a",
        leaseDurationMs: 1_000
      })).toMatchObject({ status: "terminal" });
    } finally {
      firstConnection.close();
      secondConnection.close();
    }
  });
});

async function createEligibleParent(
  store: RunStore,
  title: string
): Promise<RunRecord> {
  const run = await store.createRun({
    title,
    topic: "Verify a selected research claim",
    constraints: ["bounded execution"],
    objectiveMetric: "declared primary measure"
  });
  run.graph.researchCycle = 2;
  run.currentNode = "review";
  run.graph.currentNode = "review";
  run.status = "paused";
  run.graph.nodeStates.review.status = "needs_approval";
  run.graph.pendingTransition = {
    action: "delegate_successor",
    sourceNode: "review",
    reason: "A separately governed successor is required.",
    confidence: 0.99,
    autoExecutable: true,
    evidence: ["The bounded outcome passed its delegation gate."],
    suggestedCommands: [],
    generatedAt: "2026-01-01T00:00:00.000Z"
  };
  await store.updateRun(run);
  const persisted = await store.getRun(run.id);
  if (!persisted) {
    throw new Error("eligible parent was not persisted");
  }
  return persisted;
}

function buildReservationInput(
  parent: RunRecord,
  childRunId: string,
  outcomeContentSha256: string,
  label: string
): RunPromotionReservationInput {
  const receiptJson = JSON.stringify({
    schema_version: 2,
    parent_run_id: parent.id,
    child_run_id: childRunId,
    outcome_content_sha256: outcomeContentSha256
  });
  return {
    parentRunId: parent.id,
    parentResearchCycle: parent.graph.researchCycle,
    relation: TOPIC_PROBE_CONFIRMATORY_RELATION,
    outcomeContentSha256,
    childRunId,
    receiptContentSha256: sha256(receiptJson),
    receiptJson,
    immutablePayloadJson: JSON.stringify({ label }),
    expectedParentStateSha256: buildPromotionParentStateSha256(parent),
    expectedCheckpointSeq: parent.graph.checkpointSeq
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
