import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadPromotionBenchmarkSuite,
  scorePromotionBenchmarkFromFiles
} from "../src/core/benchmark/promotionBenchmark.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion benchmark", () => {
  it("scores promotion conflicts, clean controls, blockers, and repair owners", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-benchmark-"));
    tempDirs.push(workspace);
    await writeSuite(workspace, [
      caseManifest("case-clean", "base-clean", "development", "promote", [], []),
      caseManifest("case-blocked", "base-blocked", "test", "block", ["missing_comparator"], ["design_experiments"]),
      caseManifest("case-downgraded", "base-downgraded", "test", "downgrade", ["claim_overreach"], ["analyze_results"])
    ]);
    const predictions = [
      prediction("governed", "case-clean", "promote"),
      prediction("governed", "case-blocked", "block", [blocking("missing_comparator")], ["design_experiments"]),
      prediction("governed", "case-downgraded", "downgrade", [blocking("claim_overreach")], ["analyze_results"]),
      prediction("checklist", "case-clean", "promote"),
      prediction("checklist", "case-blocked", "promote", [blocking("missing_comparator")]),
      prediction("checklist", "case-downgraded", "needs_review")
    ];
    await writeFile(path.join(workspace, "predictions.jsonl"), predictions.map((row) => JSON.stringify(row)).join("\n") + "\n");

    const result = await scorePromotionBenchmarkFromFiles({
      cwd: workspace,
      suitePath: "suite.json",
      predictionsPath: "predictions.jsonl",
      outDir: "score"
    });

    expect(result.report.passed).toBe(true);
    expect(result.report.paper_claim_eligible).toBe(false);
    expect(result.report.mutation_isolation_status).toBe("unspecified");
    expect(result.report.execution_provenance_status).toBe("unspecified");
    expect(result.report.source_diversity_status).toBe("unspecified");
    expect(result.report.source_family_analysis).toEqual({
      availability: "unavailable",
      unavailable_reason: "source_family_assignment_incomplete",
      family_count: 0,
      families: [],
      leave_one_family_out: []
    });
    expect(result.report.paired_analysis).toMatchObject({
      inference_unit: "base_bundle_id",
      bootstrap_replicates: 5000,
      exploratory_only: true
    });
    expect(result.report.systems.find((system) => system.system_id === "governed")).toMatchObject({
      coverage_rate: 1,
      exact_decision_accuracy: 1,
      false_paper_ready_rate: 0,
      false_paper_ready_cluster_bootstrap_95_ci: [0, 0],
      concern_acceptance_conflict_rate: 0,
      concern_acceptance_conflict_cluster_bootstrap_95_ci: [0, 0],
      clean_case_promotion_accuracy: 1,
      clean_case_promotion_accuracy_cluster_bootstrap_95_ci: null,
      blocker_precision: 1,
      blocker_recall: 1,
      repair_owner_exact_match_accuracy: 1,
      repair_owner_exact_match_accuracy_cluster_bootstrap_95_ci: [1, 1],
      trace_coverage: 1
    });
    const checklist = result.report.systems.find((system) => system.system_id === "checklist");
    expect(checklist?.false_paper_ready_rate).toBe(0.5);
    expect(checklist?.concern_acceptance_conflict_rate).toBe(1);
    expect(result.report.paired_analysis.comparisons).toContainEqual(expect.objectContaining({
      system_a: "checklist",
      system_b: "governed",
      common_case_count: 3,
      decision_accuracy_delta: -2 / 3,
      false_paper_ready_rate_delta: 0.5,
      repair_owner_common_case_count: 2,
      repair_owner_exact_match_accuracy_delta: -1,
      repair_owner_cluster_bootstrap_95_ci: [-1, -1]
    }));
    expect(JSON.parse(await readFile(path.join(workspace, "score", "promotion-score.json"), "utf8"))).toMatchObject({
      suite_id: "portable-suite",
      passed: true
    });
    const markdown = await readFile(path.join(workspace, "score", "promotion-score.md"), "utf8");
    expect(markdown).toContain("Concern-acceptance conflict");
    expect(markdown).toContain("Mutation isolation: unspecified");
    expect(markdown).toContain("Source diversity: unspecified");
    expect(markdown).toContain("## Source Family Stratification");
    expect(markdown).toContain("Availability: unavailable");
    expect(markdown).toContain("## Mutation Families");
    expect(markdown).toContain("clean_control");
    expect(markdown).toContain("## Clustered Metric Uncertainty");
    expect(markdown).toContain("## Paired Repair-Owner Analysis");
  });

  it("reports source-family strata and leave-one-family-out comparisons", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-benchmark-families-"));
    tempDirs.push(workspace);
    const cases = ["alpha", "beta", "gamma"].flatMap((suffix) => {
      const sourceFamily = hashId(`source-family-${suffix}`);
      const operatorGroup = hashId(`operator-group-${suffix}`);
      return [
        {
          ...caseManifest(`case-${suffix}-clean`, `base-${suffix}`, "test", "promote", [], []),
          source_family_id_sha256: sourceFamily,
          operator_group_id_sha256: operatorGroup
        },
        {
          ...caseManifest(
            `case-${suffix}-blocked`,
            `base-${suffix}`,
            "test",
            "block",
            ["execution_gap"],
            ["run_experiments"]
          ),
          source_family_id_sha256: sourceFamily,
          operator_group_id_sha256: operatorGroup
        }
      ];
    });
    await writeSuite(workspace, cases);
    const predictions = cases.flatMap((benchmarkCase) => {
      const caseId = String(benchmarkCase.case_id);
      const isBlocked = caseId.endsWith("-blocked");
      return [
        prediction(
          "governed",
          caseId,
          isBlocked ? "block" : "promote",
          isBlocked ? [blocking("execution_gap")] : [],
          isBlocked ? ["run_experiments"] : []
        ),
        prediction("checklist", caseId, "promote")
      ];
    });
    await writeFile(
      path.join(workspace, "predictions.jsonl"),
      `${predictions.map((row) => JSON.stringify(row)).join("\n")}\n`
    );

    const result = await scorePromotionBenchmarkFromFiles({
      cwd: workspace,
      suitePath: "suite.json",
      predictionsPath: "predictions.jsonl",
      outDir: "score"
    });

    expect(result.report.passed).toBe(true);
    expect(result.report.source_family_analysis).toMatchObject({
      availability: "complete",
      unavailable_reason: null,
      family_count: 3
    });
    expect(result.report.source_family_analysis.families).toHaveLength(3);
    for (const family of result.report.source_family_analysis.families) {
      expect(family).toMatchObject({ base_bundle_count: 1, case_count: 2 });
      expect(family.systems).toHaveLength(2);
      expect(family.systems.find((system) => system.system_id === "governed")).toMatchObject({
        exact_decision_accuracy: 1,
        false_paper_ready_rate: 0
      });
      expect(family.systems.find((system) => system.system_id === "checklist")).toMatchObject({
        exact_decision_accuracy: 0.5,
        false_paper_ready_rate: 1
      });
    }
    expect(result.report.source_family_analysis.leave_one_family_out).toHaveLength(3);
    for (const analysis of result.report.source_family_analysis.leave_one_family_out) {
      expect(analysis).toMatchObject({
        remaining_base_bundle_count: 2,
        remaining_case_count: 4
      });
      expect(analysis.comparisons).toContainEqual(expect.objectContaining({
        system_a: "checklist",
        system_b: "governed",
        common_case_count: 4,
        decision_accuracy_delta: -0.5,
        false_paper_ready_rate_delta: 1
      }));
    }
    const markdown = await readFile(path.join(workspace, "score", "promotion-score.md"), "utf8");
    expect(markdown).toContain("Availability: complete. Families: 3.");
    expect(markdown).toContain("## Leave-One-Family-Out Sensitivity");
    expect(markdown).toContain("| checklist | governed | -0.500 |");
  });

  it("requires every system trial to cover every suite case", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-benchmark-trials-"));
    tempDirs.push(workspace);
    await writeSuite(workspace, [
      caseManifest("case-a", "base-a", "test", "promote", [], []),
      caseManifest("case-b", "base-b", "test", "block", ["execution_gap"], ["run_experiments"])
    ]);
    const predictions = [
      prediction("candidate", "case-a", "promote"),
      prediction("candidate", "case-b", "block", [blocking("execution_gap")], ["run_experiments"]),
      { ...prediction("candidate", "case-a", "promote"), trial_id: "trial-beta" }
    ];
    await writeFile(path.join(workspace, "predictions.jsonl"), predictions.map((row) => JSON.stringify(row)).join("\n") + "\n");

    const result = await scorePromotionBenchmarkFromFiles({
      cwd: workspace,
      suitePath: "suite.json",
      predictionsPath: "predictions.jsonl",
      outDir: "score"
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.validation_issues).toContainEqual(expect.objectContaining({
      code: "system_trial_case_coverage_incomplete",
      ref: "candidate:trial-beta"
    }));
  });

  it("rejects base-bundle split leakage and paths outside the suite", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-benchmark-invalid-"));
    tempDirs.push(workspace);
    await writeSuite(workspace, [
      caseManifest("case-dev", "shared-base", "development", "promote", [], []),
      caseManifest("case-test", "shared-base", "test", "block", ["execution_gap"], ["run_experiments"])
    ]);
    const suite = JSON.parse(await readFile(path.join(workspace, "suite.json"), "utf8")) as { cases: string[] };
    suite.cases.push("../outside.json");
    await writeFile(path.join(workspace, "suite.json"), JSON.stringify(suite));

    const loaded = await loadPromotionBenchmarkSuite(path.join(workspace, "suite.json"));

    expect(loaded.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "base_bundle_split_leakage",
      "case_path_outside_suite"
    ]));
  });

  it("rejects a hand-authored stratification claim with concentrated source groups", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-benchmark-diversity-"));
    tempDirs.push(workspace);
    const sharedFamily = hashId("shared-source-family");
    const sharedOperator = hashId("shared-operator-group");
    await writeSuite(workspace, ["alpha", "beta", "gamma"].map((suffix) => ({
      ...caseManifest(`case-${suffix}`, `base-${suffix}`, "test", "promote", [], []),
      source_family_id_sha256: sharedFamily,
      operator_group_id_sha256: sharedOperator
    })));
    const suitePath = path.join(workspace, "suite.json");
    const suite = JSON.parse(await readFile(suitePath, "utf8")) as Record<string, unknown>;
    suite.source_diversity_status = "declared_stratified";
    await writeFile(suitePath, JSON.stringify(suite));

    const loaded = await loadPromotionBenchmarkSuite(suitePath);

    expect(loaded.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "source_family_minimum_not_met",
      "operator_group_minimum_not_met",
      "source_family_share_exceeded",
      "operator_group_share_exceeded"
    ]));
  });
});

function caseManifest(
  caseId: string,
  baseBundleId: string,
  split: "development" | "test",
  decision: "promote" | "needs_review" | "downgrade" | "block",
  blockingConcerns: string[],
  repairOwners: string[]
) {
  return {
    schema_version: "1.0",
    case_id: caseId,
    base_bundle_id: baseBundleId,
    split,
    artifact_root: "../artifacts",
    gold: { decision, blocking_concerns: blockingConcerns, repair_owners: repairOwners }
  };
}

function prediction(
  systemId: string,
  caseId: string,
  decision: "promote" | "needs_review" | "downgrade" | "block",
  concerns: Array<{ code: string; severity: "blocking"; evidence_refs: string[] }> = [],
  repairOwners: string[] = []
) {
  return {
    case_id: caseId,
    system_id: systemId,
    trial_id: "trial-alpha",
    decision,
    concerns,
    repair_owners: repairOwners,
    latency_ms: 10,
    cost_usd: 0
  };
}

function blocking(code: string) {
  return { code, severity: "blocking" as const, evidence_refs: ["artifact.json"] };
}

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeSuite(workspace: string, cases: Array<Record<string, unknown>>): Promise<void> {
  await mkdir(path.join(workspace, "artifacts"), { recursive: true });
  await mkdir(path.join(workspace, "cases"), { recursive: true });
  const caseRefs: string[] = [];
  for (const benchmarkCase of cases) {
    const caseId = String(benchmarkCase.case_id);
    const relativePath = path.join("cases", `${caseId}.json`);
    await writeFile(path.join(workspace, relativePath), JSON.stringify(benchmarkCase));
    caseRefs.push(relativePath);
  }
  await writeFile(path.join(workspace, "suite.json"), JSON.stringify({
    schema_version: "1.0",
    suite_id: "portable-suite",
    cases: caseRefs
  }));
}
