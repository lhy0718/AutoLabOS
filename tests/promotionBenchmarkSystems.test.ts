import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  hashPromotionArtifactTree,
  scorePromotionBenchmarkFromFiles
} from "../src/core/benchmark/promotionBenchmark.js";
import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";
import {
  PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION,
  runPromotionBenchmarkSystems,
  verifyPromotionBenchmarkSystemRun
} from "../src/core/benchmark/promotionBenchmarkSystems.js";
import { inspectReferenceAuthorityGate } from "../src/core/referenceAuthorityGate.js";

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
    const predictionsText = await readFile(path.join(workspace, evaluated.predictions_path), "utf8");
    const predictions = predictionsText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { case_id: string; system_id: string; decision: string; repair_owners: string[] });
    const verifiedRun = await verifyPromotionBenchmarkSystemRun({
      cwd: workspace,
      manifestPath: evaluated.manifest_path,
      suitePath: built.suite_path,
      predictionsPath: evaluated.predictions_path
    });
    expect(verifiedRun).toMatchObject({
      schema_version: "1.3",
      protocol_revision: PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION
    });
    expect(verifiedRun.systems.every(
      (system) => system.input_contract === "case_id_and_artifact_tree_only"
    )).toBe(true);
    expect(verifiedRun.systems.map((system) => system.protocol)).toEqual([
      "ungated",
      "artifact_presence_checklist",
      "gate_ablation",
      "full_artifact_policy"
    ]);
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

    const suiteManifest = JSON.parse(
      await readFile(path.join(workspace, built.suite_path), "utf8")
    ) as { cases: string[] };
    const casePath = path.resolve(path.dirname(path.join(workspace, built.suite_path)), suiteManifest.cases[0]);
    const caseText = await readFile(casePath, "utf8");
    await writeFile(casePath, caseText + "\n", "utf8");
    await expect(verifyPromotionBenchmarkSystemRun({
      cwd: workspace,
      manifestPath: evaluated.manifest_path,
      suitePath: built.suite_path,
      predictionsPath: evaluated.predictions_path
    })).rejects.toThrow("SHA-256 mismatch");
    await writeFile(casePath, caseText, "utf8");

    await writeFile(path.join(workspace, evaluated.predictions_path), predictionsText + "\n", "utf8");
    await expect(verifyPromotionBenchmarkSystemRun({
      cwd: workspace,
      manifestPath: evaluated.manifest_path,
      suitePath: built.suite_path,
      predictionsPath: evaluated.predictions_path
    })).rejects.toThrow("SHA-256 mismatch");
  });

  it("checks required artifact presence and JSON parseability without evaluating semantics", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-systems-parseability-"));
    tempDirs.push(workspace);
    await writeCleanBundle(path.join(workspace, "base-bundle"));
    await writeJson(path.join(workspace, "recipe.json"), {
      schema_version: "1.0",
      suite_id: "presence-baseline-suite",
      cases: [{
        case_id: "case-structural-check",
        base_bundle_id: "base-structural",
        split: "test",
        source_root: "base-bundle",
        operations: [],
        gold: { decision: "block", blocking_concerns: [], repair_owners: ["review"] }
      }]
    });
    const built = await buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "suite"
    });
    const suiteManifest = JSON.parse(
      await readFile(path.join(workspace, built.suite_path), "utf8")
    ) as { cases: string[] };
    const casePath = path.resolve(path.dirname(path.join(workspace, built.suite_path)), suiteManifest.cases[0]);
    const caseManifest = JSON.parse(await readFile(casePath, "utf8")) as {
      artifact_root: string;
      artifact_sha256: string;
    };
    const artifactRoot = path.resolve(path.dirname(casePath), caseManifest.artifact_root);
    await writeFile(path.join(artifactRoot, "review", "decision.json"), "{not-json\n", "utf8");
    await rm(path.join(artifactRoot, "paper", "paper_readiness.json"));
    caseManifest.artifact_sha256 = await hashPromotionArtifactTree(artifactRoot);
    await writeJson(casePath, caseManifest);

    const evaluated = await runPromotionBenchmarkSystems({
      cwd: workspace,
      suitePath: built.suite_path,
      outDir: "predictions",
      systems: ["presence-checklist"]
    });
    const [prediction] = (await readFile(path.join(workspace, evaluated.predictions_path), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        decision: string;
        concerns: Array<{ code: string; evidence_refs: string[] }>;
        repair_owners: string[];
      });

    expect(prediction).toEqual(expect.objectContaining({
      decision: "block",
      repair_owners: ["review"]
    }));
    expect(prediction.concerns).toEqual([
      {
        code: "required_artifact_missing",
        severity: "blocking",
        evidence_refs: []
      },
      {
        code: "required_artifact_unparseable",
        severity: "blocking",
        evidence_refs: ["review/decision.json"]
      }
    ]);
    await expect(verifyPromotionBenchmarkSystemRun({
      cwd: workspace,
      manifestPath: evaluated.manifest_path,
      suitePath: built.suite_path,
      predictionsPath: evaluated.predictions_path
    })).resolves.toMatchObject({ prediction_count: 1 });
  });

  it("binds repeated-run provenance concerns to the mutated evidence artifacts", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-systems-trace-"));
    tempDirs.push(workspace);
    await writeCleanBundle(path.join(workspace, "base-bundle"));
    await writeJson(path.join(workspace, "recipe.json"), {
      schema_version: "1.0",
      suite_id: "trace-relevance-suite",
      cases: [{
        case_id: "case-repeated-run-gap",
        base_bundle_id: "base-trace",
        split: "test",
        source_root: "base-bundle",
        mutation_family: "repeated_run_provenance_gap",
        operations: [0, 1, 2].map((index) => ({
          op: "remove_json_pointer",
          path: "experiment_evidence.json",
          pointer: `/trials/${index}/trial_id`
        })),
        gold: {
          decision: "block",
          blocking_concerns: ["repeated_run_provenance_missing"],
          repair_owners: ["run_experiments"]
        }
      }]
    });
    const built = await buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "suite"
    });

    const evaluated = await runPromotionBenchmarkSystems({
      cwd: workspace,
      suitePath: built.suite_path,
      outDir: "predictions",
      systems: ["artifact-audit"]
    });
    const [prediction] = (await readFile(path.join(workspace, evaluated.predictions_path), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        concerns: Array<{ code: string; evidence_refs: string[] }>;
      });

    expect(prediction.concerns).toContainEqual({
      code: "repeated_run_provenance_missing",
      severity: "blocking",
      evidence_refs: ["run_config.json", "experiment_evidence.json"]
    });
    const scored = await scorePromotionBenchmarkFromFiles({
      cwd: workspace,
      suitePath: built.suite_path,
      predictionsPath: evaluated.predictions_path,
      outDir: "score"
    });
    expect(scored.report.passed).toBe(true);
    expect(scored.report.systems[0].trace_coverage).toBe(1);
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
  await writeFile(
    path.join(root, "research_brief.md"),
    "# Research Brief\n\n## Paper-worthiness Gate\n\nPaper-ready promotion requires the complete governed artifact contract.\n",
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
    claim_ceiling_applied: false
  });
  await writeJson(path.join(root, "review", "decision.json"), { outcome: "accept" });
  const manuscript = "\\section{Results}\n";
  const manuscriptSha256 = createHash("sha256").update(manuscript, "utf8").digest("hex");
  await writeFile(path.join(root, "paper", "main.tex"), manuscript, "utf8");
  await writeJson(path.join(root, "paper", "paper_readiness.json"), {
    paper_ready: true,
    readiness_state: "paper_ready"
  });
  await writeJson(path.join(root, "paper", "reference_evidence_status.json"), {
    schema_version: "1.0",
    manuscript: "paper/main.tex",
    manuscript_projection: {
      source_ref: "paper/main.tex",
      package_ref: "paper/main.tex",
      source_sha256: manuscriptSha256,
      package_content_sha256: manuscriptSha256
    },
    submission_gate_passed: true,
    summary: {
      citation_bearing_claim_count: 0,
      independently_checked_claim_count: 0,
      missing_full_text_claim_count: 0
    },
    blocking_requirements: []
  });
  await writeFile(
    path.join(root, "paper", "refgate_claims.tsv"),
    "claim_id\tmanuscript_location\tclaim_text\tcitation_key\tsource_location\tquote_or_evidence\tevidence_kind\tstatus\tnotes\tclaim_type\timportance\n",
    "utf8"
  );
  await writeJson(
    path.join(root, "paper", "reference_authority_gate.json"),
    await inspectReferenceAuthorityGate(path.join(root, "paper"))
  );
  await writeJson(path.join(root, "paper", "claim_evidence_table.json"), { claims: [] });
  await writeJson(path.join(root, "paper", "claim_status_table.json"), { claims: [] });
  await writeJson(path.join(root, "paper", "evidence_links.json"), { claims: [] });
  await writeJson(path.join(root, "run_config.json"), {
    planned_budget: { trials: 3 },
    executed_budget: { trials: 3 }
  });
  await writeJson(path.join(root, "experiment_evidence.json"), {
    trials: [1, 2, 3].map((index) => ({ trial_id: `trial-${index}` }))
  });
  await writeJson(path.join(root, "run_record.json"), { id: "base-alpha", status: "completed" });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
