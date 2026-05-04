import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { runGovernanceBenchmarkBatch } from "../src/core/benchmark/governanceRunner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("governance benchmark batch runner", () => {
  it("replays fixed result-table seeds and queues seeds that need live or task-specific replay", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-governance-batch-"));
    tempDirs.push(workspace);
    const seedsRoot = path.join(workspace, "seeds");
    await writeSeed({
      seedsRoot,
      taskId: "AGB-001",
      title: "Missing baseline overclaim",
      seedMaterialPath: "seed_materials/result_table.csv",
      seedMaterial:
        [
          "condition,metric,value,unit,notes",
          "proposed_condition,macro_f1,0.811,ratio,Proposed row only.",
          ""
        ].join("\n")
    });
    await writeSeed({
      seedsRoot,
      taskId: "AGB-002",
      title: "Toy result generalization",
      seedMaterialPath: "seed_materials/toy_metrics.csv",
      seedMaterial:
        [
          "metric,value,notes",
          "accuracy,0.95,Toy subset only.",
          ""
        ].join("\n")
    });

    const report = await runGovernanceBenchmarkBatch({
      cwd: workspace,
      seedsRoot,
      taskIds: ["AGB-001", "AGB-002"],
      conditions: ["gated", "ungated"]
    });

    expect(report.passed).toBe(true);
    expect(report.total_tasks).toBe(2);
    expect(report.replayed_tasks).toBe(1);
    expect(report.queued_tasks).toBe(1);
    expect(report.failed_tasks).toBe(0);
    expect(report.coverage.missing_task_ids).toEqual([]);
    expect(report.tasks.map((task) => [task.task_id, task.status])).toEqual([
      ["AGB-001", "replayed"],
      ["AGB-002", "queued"]
    ]);
    expect(report.tasks[0].seed_ref).toBe("seeds/AGB-001");

    const queued = report.tasks.find((task) => task.task_id === "AGB-002");
    const queueManifest = JSON.parse(
      await readFile(path.join(workspace, queued?.queue_manifest_path || ""), "utf8")
    ) as { replay_status: string; reason: string };
    expect(queueManifest.replay_status).toBe("queued");
    expect(queueManifest.reason).toContain("No fixed result_table.csv replay artifact");

    const readme = await readFile(path.join(workspace, report.readme_path), "utf8");
    expect(readme).toContain("AGB-001: replayed");
    expect(readme).toContain("AGB-002: queued");
  });

  it("does not write absolute external seed roots into batch reports", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-governance-batch-workspace-"));
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "autolabos-governance-batch-external-"));
    tempDirs.push(workspace, externalRoot);
    await writeSeed({
      seedsRoot: externalRoot,
      taskId: "AGB-001",
      title: "Missing baseline overclaim",
      seedMaterialPath: "seed_materials/result_table.csv",
      seedMaterial:
        [
          "condition,metric,value,unit,notes",
          "proposed_condition,macro_f1,0.811,ratio,Proposed row only.",
          ""
        ].join("\n")
    });

    const report = await runGovernanceBenchmarkBatch({
      cwd: workspace,
      seedsRoot: externalRoot,
      taskIds: ["AGB-001"]
    });

    expect(report.seeds_root_ref).toBe("<external-seed-root>");
    expect(report.tasks[0].seed_ref).toBe("<external-seed-root>/AGB-001");
    const summary = await readFile(path.join(workspace, report.summary_path), "utf8");
    expect(summary).not.toContain(externalRoot);
  });
});

async function writeSeed(input: {
  seedsRoot: string;
  taskId: string;
  title: string;
  seedMaterialPath: string;
  seedMaterial: string;
}): Promise<void> {
  const seedDir = path.join(input.seedsRoot, input.taskId);
  await mkdir(path.join(seedDir, path.dirname(input.seedMaterialPath)), { recursive: true });
  await writeFile(
    path.join(seedDir, "condition.yaml"),
    [
      `task_id: ${input.taskId}`,
      `title: ${input.title}`,
      "conditions:",
      "  - gated",
      "  - ungated",
      "intended_failure:",
      "  - fixture_failure",
      "expected_gate:",
      "  - review",
      "seed_materials:",
      `  - ${input.seedMaterialPath}`,
      "required_repo_artifacts:",
      "  - result_table.json",
      "  - evidence_store.jsonl",
      "  - review/minimum_gate.json",
      "  - review/paper_quality_evaluation.json",
      "  - review/review_packet.json",
      "  - review/decision.json",
      "  - paper/claim_evidence_table.json",
      "  - paper/evidence_gate_decision.json",
      "  - paper/paper_readiness.json",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(path.join(seedDir, input.seedMaterialPath), input.seedMaterial, "utf8");
}
