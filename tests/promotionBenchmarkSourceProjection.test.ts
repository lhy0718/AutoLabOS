import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectPromotionSourceProjection,
  projectPromotionSource
} from "../src/core/benchmark/promotionBenchmarkSourceProjection.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion source projection", () => {
  it("builds a confirmatory-ready bundle only from copied bytes and JSON-pointer extraction", async () => {
    const workspace = await createWorkspace();
    const sourceRoot = path.join(workspace, "raw-source");
    await writeCompleteRawSource(sourceRoot);
    await writeJson(path.join(workspace, "projection.json"), projectionRecipe());

    const result = await projectPromotionSource({
      cwd: workspace,
      sourceRoot: "raw-source",
      recipePath: "projection.json",
      outDir: "projected"
    });
    const inspection = await inspectPromotionSourceProjection(path.join(workspace, "projected"));
    const resultTable = JSON.parse(await readFile(path.join(workspace, "projected", "result_table.json"), "utf8"));

    expect(result.manifest).toMatchObject({
      distribution_scope: "redistributable",
      license_review_status: "human_verified",
      promotion_compatible: true,
      execution_evidence_verified: true,
      ready_for_confirmatory_intake: true,
      issues: []
    });
    expect(resultTable).toEqual([{ baseline: 0.5, comparator: 0.6 }]);
    expect(inspection).toMatchObject({
      integrity_passed: true,
      confirmatory_ready: true,
      passed: true,
      issues: []
    });
    expect(result.manifest.outputs.some((output) => output.mode === "json_pointer")).toBe(true);
    expect(JSON.stringify(result.manifest)).not.toContain(path.join(workspace, "raw-source"));
    expect(JSON.stringify(result.manifest)).not.toContain("measurements.json");
  });

  it("preserves an incomplete local projection but marks it ineligible for confirmatory intake", async () => {
    const workspace = await createWorkspace();
    await mkdir(path.join(workspace, "raw-source"), { recursive: true });
    await writeFile(path.join(workspace, "raw-source", "LICENSE"), "Example license terms.\n", "utf8");
    await writeJson(path.join(workspace, "raw-source", "measurement.json"), { score: 0.5 });
    await writeJson(path.join(workspace, "projection.json"), {
      schema_version: "1.0",
      projection_id: "projection-neutral",
      source_family_id: "family-neutral",
      operator_group_id: "operator-neutral",
      source_revision: "revision-neutral",
      distribution_scope: "local_evaluation_only",
      license_review_status: "unreviewed",
      license_path: "LICENSE",
      entries: [{
        mode: "json_pointer",
        source_path: "measurement.json",
        source_pointer: "/score",
        target_path: "result_table.json",
        target_pointer: "/0/baseline"
      }]
    });

    const result = await projectPromotionSource({
      cwd: workspace,
      sourceRoot: "raw-source",
      recipePath: "projection.json",
      outDir: "projected"
    });
    const inspection = await inspectPromotionSourceProjection(path.join(workspace, "projected"));

    expect(result.manifest.ready_for_confirmatory_intake).toBe(false);
    expect(result.manifest.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "source_projection_mutation_contract_incomplete",
      "source_projection_execution_evidence_unverified",
      "source_projection_distribution_local_only",
      "source_projection_license_review_required"
    ]));
    expect(inspection).toMatchObject({
      integrity_passed: true,
      confirmatory_ready: false,
      passed: false
    });
    expect(inspection.issues.map((issue) => issue.code)).toContain("source_projection_not_confirmatory_ready");
  });

  it("rejects sensitive source paths without creating output", async () => {
    const workspace = await createWorkspace();
    await mkdir(path.join(workspace, "raw-source"), { recursive: true });
    await writeFile(path.join(workspace, "raw-source", "LICENSE"), "Example license terms.\n", "utf8");
    await writeFile(path.join(workspace, "raw-source", "api_keys.donotcommit.json"), "{}\n", "utf8");
    await writeJson(path.join(workspace, "projection.json"), {
      ...projectionRecipe(),
      entries: [{ mode: "copy_file", source_path: "api_keys.donotcommit.json", target_path: "evidence.json" }]
    });

    await expect(projectPromotionSource({
      cwd: workspace,
      sourceRoot: "raw-source",
      recipePath: "projection.json",
      outDir: "projected"
    })).rejects.toThrow("sensitive");
    await expect(readFile(path.join(workspace, "projected", "source-projection.json"), "utf8")).rejects.toThrow();
  });

  it("rejects credential-like values and symbolic links in selected files", async () => {
    const workspace = await createWorkspace();
    await mkdir(path.join(workspace, "raw-source", "real"), { recursive: true });
    await writeFile(path.join(workspace, "raw-source", "LICENSE"), "Example license terms.\n", "utf8");
    const credentialLikeText = `${["access", "token"].join("_")}=${"a".repeat(32)}\n`;
    await writeFile(path.join(workspace, "raw-source", "real", "evidence.txt"), credentialLikeText, "utf8");
    await writeJson(path.join(workspace, "projection.json"), {
      ...projectionRecipe(),
      entries: [{ mode: "copy_file", source_path: "real/evidence.txt", target_path: "evidence.txt" }]
    });
    await expect(projectPromotionSource({
      cwd: workspace,
      sourceRoot: "raw-source",
      recipePath: "projection.json",
      outDir: "projected-secret"
    })).rejects.toThrow("credential-like");

    await writeFile(path.join(workspace, "raw-source", "real", "evidence.txt"), "public evidence\n", "utf8");
    await symlink("real", path.join(workspace, "raw-source", "linked"), "dir");
    await writeJson(path.join(workspace, "projection.json"), {
      ...projectionRecipe(),
      entries: [{ mode: "copy_file", source_path: "linked/evidence.txt", target_path: "evidence.txt" }]
    });
    await expect(projectPromotionSource({
      cwd: workspace,
      sourceRoot: "raw-source",
      recipePath: "projection.json",
      outDir: "projected-link"
    })).rejects.toThrow("Symbolic links");
  });

  it("detects projected artifact drift", async () => {
    const workspace = await createWorkspace();
    const sourceRoot = path.join(workspace, "raw-source");
    await writeCompleteRawSource(sourceRoot);
    await writeJson(path.join(workspace, "projection.json"), projectionRecipe());
    await projectPromotionSource({
      cwd: workspace,
      sourceRoot: "raw-source",
      recipePath: "projection.json",
      outDir: "projected"
    });
    await writeJson(path.join(workspace, "projected", "result_table.json"), [{ baseline: 0.5, comparator: 0.9 }]);

    const inspection = await inspectPromotionSourceProjection(path.join(workspace, "projected"));

    expect(inspection).toMatchObject({ integrity_passed: false, confirmatory_ready: false, passed: false });
    expect(inspection.issues.map((issue) => issue.code)).toContain("source_projection_output_hash_mismatch");
  });

  it("rejects files added after projection outside the closed output manifest", async () => {
    const workspace = await createWorkspace();
    const sourceRoot = path.join(workspace, "raw-source");
    await writeCompleteRawSource(sourceRoot);
    await writeJson(path.join(workspace, "projection.json"), projectionRecipe());
    await projectPromotionSource({
      cwd: workspace,
      sourceRoot: "raw-source",
      recipePath: "projection.json",
      outDir: "projected"
    });
    await writeFile(path.join(workspace, "projected", "untracked-evidence.json"), "{}\n", "utf8");

    const inspection = await inspectPromotionSourceProjection(path.join(workspace, "projected"));

    expect(inspection).toMatchObject({ integrity_passed: false, confirmatory_ready: false, passed: false });
    expect(inspection.issues).toContainEqual(expect.objectContaining({
      code: "source_projection_untracked_artifact",
      ref: "untracked-evidence.json"
    }));
  });
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-source-projection-"));
  tempDirs.push(workspace);
  return workspace;
}

function projectionRecipe() {
  return {
    schema_version: "1.0",
    projection_id: "projection-neutral",
    source_family_id: "family-neutral",
    operator_group_id: "operator-neutral",
    source_revision: "revision-neutral",
    distribution_scope: "redistributable",
    license_review_status: "human_verified",
    license_path: "LICENSE",
    entries: [
      { mode: "json_pointer", source_path: "measurements.json", source_pointer: "/baseline", target_path: "result_table.json", target_pointer: "/0/baseline" },
      { mode: "json_pointer", source_path: "measurements.json", source_pointer: "/comparator", target_path: "result_table.json", target_pointer: "/0/comparator" },
      ...canonicalCopyPaths().map((sourcePath) => ({ mode: "copy_file", source_path: sourcePath, target_path: sourcePath }))
    ]
  };
}

async function writeCompleteRawSource(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "LICENSE"), "Example license terms.\n", "utf8");
  await writeJson(path.join(root, "measurements.json"), { baseline: 0.5, comparator: 0.6 });
  await writeJson(path.join(root, "experiment_evidence.json"), {
    trials: [{ trial_id: "trial-a" }, { trial_id: "trial-b" }, { trial_id: "trial-c" }]
  });
  await writeJson(path.join(root, "run_record.json"), { status: "completed", executed_budget: { trials: 3 } });
  await writeJson(path.join(root, "figure_audit", "figure_audit_summary.json"), { severe_mismatch_count: 0, review_block_required: false });
  const claim = { claim_id: "claim-primary", section_heading: "Results", status: "verified", artifact_refs: ["result_table.json"], citation_refs: ["source-primary"] };
  await writeJson(path.join(root, "paper", "claim_status_table.json"), { claims: [claim] });
  await writeJson(path.join(root, "paper", "claim_evidence_table.json"), { claims: [claim] });
  await writeJson(path.join(root, "paper", "evidence_links.json"), { claims: [{ claim_id: "claim-primary", evidence_ids: ["evidence-primary"], citation_paper_ids: ["source-primary"] }] });
  await writeJson(path.join(root, "checkpoint", "state.json"), { paper_ready: true });
  await writeJson(path.join(root, "design_contracts.json"), { sota_ranking_claimed: false, sota_evidence_present: false });
  const evidenceFiles = [
    { role: "run_config", path: "run_config.json", content: '{"planned_budget":{"trials":3}}\n' },
    { role: "event_log", path: "events.jsonl", content: '{"event":"completed"}\n' },
    { role: "metrics", path: "metrics.json", content: '{"completed_trials":3}\n' },
    { role: "review_decision", path: "review/decision.json", content: '{"outcome":"accept"}\n' },
    { role: "command", path: "command.txt", content: "runner --config run_config.json\n" },
    { role: "execution_log", path: "execution.log", content: "completed\n" }
  ];
  for (const file of evidenceFiles) {
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await writeFile(path.join(root, file.path), file.content, "utf8");
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
    artifacts: evidenceFiles.map((file) => ({
      role: file.role,
      path: file.path,
      sha256: createHash("sha256").update(file.content).digest("hex")
    }))
  });
}

function canonicalCopyPaths(): string[] {
  return [
    "experiment_evidence.json",
    "run_record.json",
    "figure_audit/figure_audit_summary.json",
    "paper/claim_status_table.json",
    "paper/claim_evidence_table.json",
    "paper/evidence_links.json",
    "checkpoint/state.json",
    "design_contracts.json",
    "run_config.json",
    "events.jsonl",
    "metrics.json",
    "review/decision.json",
    "command.txt",
    "execution.log",
    "execution-evidence.json"
  ];
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
