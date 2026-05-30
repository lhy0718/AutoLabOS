import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { clearExecutionSummaryArtifactsInvalidatedByDesign } from "../src/core/experiments/staleExecutionArtifacts.js";

describe("stale execution artifact cleanup", () => {
  it("clears execution summaries invalidated by a new design while preserving evidence logs and metrics", async () => {
    const runDir = await mkdtemp(path.join(os.tmpdir(), "autolabos-stale-execution-artifacts-"));
    await mkdir(path.join(runDir, "exec_logs"), { recursive: true });

    const staleArtifacts = [
      "run_manifest.json",
      "run_experiments_verify_report.json",
      "objective_evaluation.json",
      "run_experiments_matrix_trial_groups.json",
      "run_experiments_supplemental_expectation.json",
      "run_experiments_supplemental_runs.json"
    ];
    for (const artifact of staleArtifacts) {
      await writeFile(path.join(runDir, artifact), JSON.stringify({ stale: true }), "utf8");
    }
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify({ accuracy: 0.5 }), "utf8");
    await writeFile(path.join(runDir, "exec_logs", "attempt.log"), "failed attempt\n", "utf8");

    const removed = await clearExecutionSummaryArtifactsInvalidatedByDesign(runDir);

    expect(removed.sort()).toEqual(staleArtifacts.sort());
    for (const artifact of staleArtifacts) {
      await expect(readFile(path.join(runDir, artifact), "utf8")).rejects.toThrow();
    }
    await expect(readFile(path.join(runDir, "metrics.json"), "utf8")).resolves.toContain("accuracy");
    await expect(readFile(path.join(runDir, "exec_logs", "attempt.log"), "utf8")).resolves.toContain("failed attempt");
  });
});
