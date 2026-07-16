import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { scorePromotionBenchmarkFromFiles } from "../src/core/benchmark/promotionBenchmark.js";
import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";
import { runPromotionBenchmarkSystems } from "../src/core/benchmark/promotionBenchmarkSystems.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion benchmark systems", () => {
  it("isolates advisory detection from fail-closed decision binding without reading gold labels", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-systems-"));
    tempDirs.push(workspace);
    await writeCleanBundle(path.join(workspace, "base-bundle"));
    await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "system-comparison-suite",
      cases: [
        {
          case_id: "case-clean",
          base_bundle_id: "base-alpha",
          split: "test",
          source_root: "base-bundle",
          operations: [],
          gold: { decision: "promote", blocking_concerns: [], repair_owners: [] }
        },
        {
          case_id: "case-comparator-removed",
          base_bundle_id: "base-alpha",
          split: "test",
          source_root: "base-bundle",
          mutation_family: "comparison_evidence_gap",
          operations: [
            { op: "remove_json_pointer", path: "result_table.json", pointer: "/0/comparator" }
          ],
          gold: {
            decision: "block",
            blocking_concerns: [
              "result_table_incomplete",
              "baseline_or_comparator_missing"
            ],
            repair_owners: ["design_experiments"]
          }
        }
      ]
    }, null, 2));
    const built = await buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "suite"
    });

    const evaluated = await runPromotionBenchmarkSystems({
      cwd: workspace,
      suitePath: built.suite_path,
      outDir: "predictions"
    });
    const predictions = (await readFile(path.join(workspace, evaluated.predictions_path), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { case_id: string; system_id: string; decision: string; repair_owners: string[] });
    expect(predictions).toHaveLength(8);
    expect(predictions.filter((row) => row.system_id === "always-promote").map((row) => row.decision)).toEqual([
      "promote",
      "promote"
    ]);
    expect(predictions.filter((row) => row.system_id === "presence-checklist").map((row) => row.decision)).toEqual([
      "promote",
      "promote"
    ]);
    expect(predictions.filter((row) => row.system_id === "artifact-audit").map((row) => row.decision)).toEqual([
      "promote",
      "block"
    ]);
    expect(predictions.filter((row) => row.system_id === "advisory-artifact-audit").map((row) => row.decision)).toEqual([
      "promote",
      "promote"
    ]);
    expect(predictions.find((row) => row.system_id === "artifact-audit" && row.case_id === "case-comparator-removed")?.repair_owners)
      .toEqual(["design_experiments"]);

    const scored = await scorePromotionBenchmarkFromFiles({
      cwd: workspace,
      suitePath: built.suite_path,
      predictionsPath: evaluated.predictions_path,
      outDir: "score"
    });
    expect(scored.report.passed).toBe(true);
    expect(scored.report.systems.find((system) => system.system_id === "always-promote")?.false_paper_ready_rate).toBe(1);
    expect(scored.report.systems.find((system) => system.system_id === "presence-checklist")?.false_paper_ready_rate).toBe(1);
    expect(scored.report.systems.find((system) => system.system_id === "advisory-artifact-audit")).toMatchObject({
      false_paper_ready_rate: 1,
      concern_acceptance_conflict_rate: 1,
      blocker_precision: 1,
      blocker_recall: 1,
      repair_owner_exact_match_accuracy: 1
    });
    expect(scored.report.systems.find((system) => system.system_id === "artifact-audit")).toMatchObject({
      exact_decision_accuracy: 1,
      false_paper_ready_rate: 0,
      clean_case_promotion_accuracy: 1,
      blocker_precision: 1,
      blocker_recall: 1,
      repair_owner_exact_match_accuracy: 1
    });
  });
});

async function writeCleanBundle(root: string): Promise<void> {
  await mkdir(path.join(root, "figure_audit"), { recursive: true });
  await mkdir(path.join(root, "review"), { recursive: true });
  await mkdir(path.join(root, "paper"), { recursive: true });
  await writeJson(path.join(root, "result_table.json"), [
    { metric: "primary_score", baseline: 0.6, comparator: 0.7, delta: 0.1, direction: "higher_better" }
  ]);
  await writeFile(
    path.join(root, "evidence_store.jsonl"),
    `${JSON.stringify({ id: "evidence-primary", metric: "primary_score", metric_evidence_present: true })}\n`,
    "utf8"
  );
  await writeJson(path.join(root, "figure_audit", "figure_audit_summary.json"), {
    audited_at: "2026-07-16T00:00:00.000Z",
    figure_count: 1,
    issues: [],
    severe_mismatch_count: 0,
    review_block_required: false
  });
  await writeJson(path.join(root, "review", "paper_critique.json"), {
    paper_readiness_state: "paper_ready",
    claim_ceiling_applied: true
  });
  await writeJson(path.join(root, "review", "decision.json"), { outcome: "accept" });
  await writeFile(path.join(root, "paper", "main.tex"), "\\section{Results}\n", "utf8");
  await writeJson(path.join(root, "paper", "paper_readiness.json"), {
    paper_ready: true,
    readiness_state: "paper_ready"
  });
  await writeJson(path.join(root, "paper", "claim_evidence_table.json"), { claims: [] });
  await writeJson(path.join(root, "paper", "claim_status_table.json"), { claims: [] });
  await writeJson(path.join(root, "paper", "evidence_links.json"), { claims: [] });
  await writeJson(path.join(root, "run_record.json"), { id: "base-alpha", status: "completed" });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
