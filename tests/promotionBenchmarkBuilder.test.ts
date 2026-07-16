import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

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
      mutation_isolation_status: "unreviewed",
      execution_provenance_status: "unverified",
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
      adjudication_status: "unreviewed",
      mutation_isolation_status: "unreviewed",
      execution_provenance_status: "unverified"
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

  it("rejects paper-claim eligibility without double adjudication and double-verified mutation isolation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-builder-adjudication-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, "bundle"), { recursive: true });
    await writeFile(path.join(workspace, "bundle", "artifact.json"), "{}\n", "utf8");
    await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "claim-suite",
      evidence_class: "external_real_run",
      paper_claim_eligible: true,
      adjudication_status: "single_annotator",
      cases: [recipeCase("case-a", "base-a", "test", "bundle")]
    }));

    await expect(buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "generated-suite"
    })).rejects.toThrow("artifact-verified execution provenance");

    await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "claim-suite",
      evidence_class: "external_real_run",
      paper_claim_eligible: true,
      adjudication_status: "double_adjudicated",
      mutation_isolation_status: "unreviewed",
      execution_provenance_status: "artifact_verified",
      cases: [recipeCase("case-a", "base-a", "test", "bundle")]
    }));
    await expect(buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "generated-suite"
    })).rejects.toThrow("double-verified mutation isolation");

    await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "claim-suite",
      evidence_class: "external_real_run",
      paper_claim_eligible: true,
      adjudication_status: "double_adjudicated",
      mutation_isolation_status: "double_verified",
      execution_provenance_status: "artifact_verified",
      cases: [recipeCase("case-a", "base-a", "test", "bundle")]
    }));
    await expect(buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "generated-suite"
    })).rejects.toThrow("declared source stratification");
  });

  it("rejects a hand-authored artifact-verified status without execution evidence", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-builder-provenance-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, "bundle"), { recursive: true });
    await writeFile(path.join(workspace, "bundle", "artifact.json"), "{}\n", "utf8");
    await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "provenance-suite",
      evidence_class: "external_real_run",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed",
      mutation_isolation_status: "unreviewed",
      execution_provenance_status: "artifact_verified",
      cases: [recipeCase("case-a", "base-a", "test", "bundle")]
    }));

    await expect(buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "generated-suite"
    })).rejects.toThrow("execution_evidence_manifest_unreadable");
  });

  it("rejects duplicated execution identities hidden behind source-tree differences", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-builder-duplicate-provenance-"));
    tempDirs.push(workspace);
    await writeExecutionEvidenceFixture(path.join(workspace, "bundle-a"));
    await cp(path.join(workspace, "bundle-a"), path.join(workspace, "bundle-b"), { recursive: true });
    await writeFile(path.join(workspace, "bundle-b", "unrelated.txt"), "different source tree\n", "utf8");
    await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "duplicate-provenance-suite",
      evidence_class: "external_real_run",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed",
      mutation_isolation_status: "unreviewed",
      execution_provenance_status: "artifact_verified",
      cases: [
        recipeCase("case-a", "base-a", "test", "bundle-a"),
        recipeCase("case-b", "base-b", "test", "bundle-b")
      ]
    }));

    await expect(buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "generated-suite"
    })).rejects.toThrow("distinct run ID values");
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

async function writeExecutionEvidenceFixture(root: string): Promise<void> {
  const artifacts = [
    { role: "run_config", path: "run-config.json", content: '{"trials":3}\n' },
    { role: "event_log", path: "events.jsonl", content: '{"event":"completed"}\n' },
    { role: "metrics", path: "metrics.json", content: '{"score":0.5}\n' },
    { role: "review_decision", path: "review/decision.json", content: '{"outcome":"accept"}\n' },
    { role: "command", path: "command.txt", content: "runner --config run-config.json\n" },
    { role: "execution_log", path: "execution.log", content: "completed\n" }
  ];
  for (const artifact of artifacts) {
    await mkdir(path.dirname(path.join(root, artifact.path)), { recursive: true });
    await writeFile(path.join(root, artifact.path), artifact.content, "utf8");
  }
  await writeFile(path.join(root, "execution-evidence.json"), `${JSON.stringify({
    schema_version: "1.0",
    evidence_class: "external_real_run",
    run_id: "run-shared",
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
  }, null, 2)}\n`, "utf8");
}
