import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { inspectPromotionExecutionEvidence } from "../src/core/benchmark/promotionBenchmarkExecutionEvidence.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion execution evidence", () => {
  it("accepts a completed real execution with distinct trials and hash-bound artifacts", async () => {
    const root = await createBundle();

    const inspected = await inspectPromotionExecutionEvidence(root);

    expect(inspected).toMatchObject({
      passed: true,
      artifact_count: 6,
      issues: []
    });
    expect(inspected.run_id_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(inspected.evidence_manifest_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(inspected.execution_fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects mock-like execution modes, incomplete trials, and missing evidence roles", async () => {
    const root = await createBundle();
    const manifestPath = path.join(root, "execution-evidence.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.execution_mode = "codex_mock";
    manifest.trial_ids = ["trial-a"];
    manifest.artifacts = (manifest.artifacts as Array<Record<string, unknown>>)
      .filter((artifact) => artifact.role !== "execution_log");
    await writeJson(manifestPath, manifest);

    const inspected = await inspectPromotionExecutionEvidence(root);

    expect(inspected.passed).toBe(false);
    expect(inspected.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "execution_evidence_mode_invalid",
      "execution_evidence_trials_invalid",
      "execution_evidence_roles_incomplete"
    ]));
  });

  it("rejects changed artifacts and a path reused for multiple evidence roles", async () => {
    const root = await createBundle();
    const manifestPath = path.join(root, "execution-evidence.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      artifacts: Array<{ role: string; path: string; sha256: string }>;
    };
    manifest.artifacts.find((artifact) => artifact.role === "execution_log")!.path = "command.txt";
    await writeJson(manifestPath, manifest);
    await writeFile(path.join(root, "metrics.json"), '{"changed":true}\n', "utf8");

    const inspected = await inspectPromotionExecutionEvidence(root);

    expect(inspected.passed).toBe(false);
    expect(inspected.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "execution_evidence_artifact_hash_mismatch",
      "execution_evidence_artifact_path_reused"
    ]));
  });
});

async function createBundle(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "promotion-execution-evidence-"));
  tempDirs.push(root);
  const artifacts = [
    { role: "run_config", path: "run-config.json", content: '{"trials":3}\n' },
    { role: "event_log", path: "events.jsonl", content: '{"event":"completed"}\n' },
    { role: "metrics", path: "metrics.json", content: '{"primary_score":0.5}\n' },
    { role: "review_decision", path: "review/decision.json", content: '{"outcome":"accept"}\n' },
    { role: "command", path: "command.txt", content: "runner --config run-config.json\n" },
    { role: "execution_log", path: "execution.log", content: "completed\n" }
  ];
  for (const artifact of artifacts) {
    await mkdir(path.dirname(path.join(root, artifact.path)), { recursive: true });
    await writeFile(path.join(root, artifact.path), artifact.content, "utf8");
  }
  await writeJson(path.join(root, "execution-evidence.json"), {
    schema_version: "1.0",
    evidence_class: "external_real_run",
    run_id: "run-neutral-a",
    execution_mode: "real_execution",
    execution_status: "completed",
    execution_backend: "local_runtime",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:01:00.000Z",
    exit_code: 0,
    trial_ids: ["trial-a", "trial-b", "trial-c"],
    artifacts: artifacts.map((artifact) => ({
      role: artifact.role,
      path: artifact.path,
      sha256: createHash("sha256").update(artifact.content).digest("hex")
    }))
  });
  return root;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
