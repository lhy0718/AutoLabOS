import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loadPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmark.js";
import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion benchmark builder", () => {
  it("builds hashed clean and counterfactual cases from a declarative recipe", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-builder-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, "bundles", "base-alpha"), { recursive: true });
    await writeFile(
      path.join(workspace, "bundles", "base-alpha", "result_table.json"),
      `${JSON.stringify({ rows: [{ metric: "primary_score", baseline: 0.6, comparator: 0.7, delta: 0.1 }] }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(path.join(workspace, "bundles", "base-alpha", "paper_readiness.json"), '{"paper_ready":true}\n', "utf8");
    await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "promotion-suite",
      evidence_class: "synthetic_development",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed",
      cases: [
        {
          case_id: "case-clean",
          base_bundle_id: "base-alpha",
          split: "development",
          source_root: "bundles/base-alpha",
          operations: [],
          gold: { decision: "promote", blocking_concerns: [], repair_owners: [] }
        },
        {
          case_id: "case-missing-comparator",
          base_bundle_id: "base-alpha",
          split: "development",
          source_root: "bundles/base-alpha",
          mutation_family: "comparison_evidence_gap",
          operations: [
            { op: "remove_json_pointer", path: "result_table.json", pointer: "/rows/0/comparator" }
          ],
          gold: {
            decision: "block",
            blocking_concerns: ["missing_comparator"],
            repair_owners: ["design_experiments"]
          }
        }
      ]
    }, null, 2));

    const result = await buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "generated-suite"
    });
    const loaded = await loadPromotionBenchmarkSuite(path.join(workspace, result.suite_path));

    expect(result).toMatchObject({ suite_id: "promotion-suite", case_count: 2 });
    expect(loaded.issues).toEqual([]);
    expect(loaded.suite?.manifest).toMatchObject({
      evidence_class: "synthetic_development",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed"
    });
    expect(loaded.suite?.cases.map((benchmarkCase) => benchmarkCase.case_id)).toEqual([
      "case-clean",
      "case-missing-comparator"
    ]);
    const mutation = JSON.parse(
      await readFile(path.join(workspace, "generated-suite", "provenance", "case-missing-comparator.json"), "utf8")
    ) as { source_sha256: string; artifact_sha256: string; operations: Array<{ after_sha256: string }> };
    expect(mutation.source_sha256).not.toBe(mutation.artifact_sha256);
    expect(mutation.operations).toHaveLength(1);

    await writeFile(
      path.join(workspace, "generated-suite", "artifacts", "case-clean", "paper_readiness.json"),
      '{"paper_ready":false}\n',
      "utf8"
    );
    const tampered = await loadPromotionBenchmarkSuite(path.join(workspace, result.suite_path));
    expect(tampered.issues.map((issue) => issue.code)).toContain("artifact_hash_mismatch");
  });

  it("rejects paper-claim eligibility without double adjudication", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-builder-adjudication-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, "bundle"), { recursive: true });
    await writeFile(path.join(workspace, "bundle", "artifact.json"), "{}\n", "utf8");
    await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "claim-suite",
      evidence_class: "human_adjudicated_test",
      paper_claim_eligible: true,
      adjudication_status: "single_annotator",
      cases: [recipeCase("case-a", "base-a", "test", "bundle")]
    }));

    await expect(buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "generated-suite"
    })).rejects.toThrow("double adjudicated");
  });

  it("rejects split leakage and sources outside the recipe directory before writing output", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-builder-invalid-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, "bundle"), { recursive: true });
    await writeFile(path.join(workspace, "bundle", "artifact.json"), "{}\n", "utf8");
    await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "invalid-suite",
      cases: [
        recipeCase("case-dev", "shared-base", "development", "bundle"),
        recipeCase("case-test", "shared-base", "test", "bundle")
      ]
    }));

    await expect(buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "generated-suite"
    })).rejects.toThrow("split leakage");
  });

  it("rejects identical source content hidden behind different base ids across splits", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-builder-source-leakage-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, "bundle"), { recursive: true });
    await writeFile(path.join(workspace, "bundle", "artifact.json"), "{}\n", "utf8");
    await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "source-leakage-suite",
      cases: [
        recipeCase("case-dev", "base-dev", "development", "bundle"),
        recipeCase("case-test", "base-test", "test", "bundle")
      ]
    }));
    const built = await buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "generated-suite"
    });

    const loaded = await loadPromotionBenchmarkSuite(path.join(workspace, built.suite_path));
    expect(loaded.issues.map((issue) => issue.code)).toContain("source_bundle_split_leakage");
  });
});

function recipeCase(caseId: string, baseBundleId: string, split: "development" | "test", sourceRoot: string) {
  return {
    case_id: caseId,
    base_bundle_id: baseBundleId,
    split,
    source_root: sourceRoot,
    operations: [],
    gold: { decision: "promote", blocking_concerns: [], repair_owners: [] }
  };
}
