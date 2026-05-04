import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildStageRoutingArtifact,
  classifyStageRoutingFailure,
  writeStageRoutingArtifact
} from "../src/core/runtime/stageRoutingArtifact.js";
import { readJsonFile } from "../src/utils/fs.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("stage routing artifacts", () => {
  it("writes an inspectable artifact and latest pointer under the run root", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "autolabos-stage-routing-"));
    tempDirs.push(cwd);

    const artifact = buildStageRoutingArtifact({
      runId: "run-1",
      nodeId: "implement_experiments",
      event: "timeout_partial",
      phase: "fail",
      reason: "staged request timed out",
      disposition: "safe_pause",
      retrySafe: false,
      checkpointSeq: 7,
      evidence: [" retry_attempt=3/3 "],
      suggestedCommands: ["/retry run-1 implement_experiments"],
      createdAt: "2026-04-07T00:00:00.000Z"
    });

    const artifactPath = await writeStageRoutingArtifact(cwd, artifact);

    await expect(readJsonFile(artifactPath)).resolves.toMatchObject({
      run_id: "run-1",
      node_id: "implement_experiments",
      event: "timeout_partial",
      disposition: "safe_pause",
      retry_safe: false,
      checkpoint_seq: 7,
      evidence: ["retry_attempt=3/3"]
    });
    await expect(
      readJsonFile(path.join(cwd, ".autolabos", "runs", "run-1", "stage_routing", "latest.json"))
    ).resolves.toMatchObject({
      event: "timeout_partial",
      file: "2026-04-07T00-00-00-000Z-timeout_partial.json"
    });
  });

  it("classifies timeout-like failures as partial routing events", () => {
    expect(classifyStageRoutingFailure("request timed out after 600000ms")).toBe("timeout_partial");
    expect(classifyStageRoutingFailure("ordinary validation failed")).toBeUndefined();
  });
});
