import os from "node:os";
import path from "node:path";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loadPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmark.js";
import { evaluatePromotionAdjudicationEligibility } from "../src/core/benchmark/promotionBenchmarkAdjudication.js";
import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";
import {
  freezePromotionConfirmatoryCorpus,
  MINIMUM_CONFIRMATORY_BASE_BUNDLES
} from "../src/core/benchmark/promotionBenchmarkConfirmatoryIntake.js";
import { promotionVariantDefinitions } from "../src/core/benchmark/promotionBenchmarkVariants.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion confirmatory intake", () => {
  it("freezes independent external bundles into a provisional held-out corpus", async () => {
    const workspace = await createWorkspace();
    const manifestPath = await writeIntake(workspace, MINIMUM_CONFIRMATORY_BASE_BUNDLES);

    const frozen = await freezePromotionConfirmatoryCorpus({
      cwd: workspace,
      manifestPath,
      outDir: "frozen"
    });

    expect(frozen).toMatchObject({
      base_bundle_count: 20,
      case_count: 200,
      output_dir: "frozen",
      recipe_path: "frozen/recipe.json"
    });
    const recipeText = await readFile(path.join(workspace, frozen.recipe_path), "utf8");
    const recipe = JSON.parse(recipeText) as {
      evidence_class: string;
      paper_claim_eligible: boolean;
      adjudication_status: string;
      cases: Array<{
        base_bundle_id: string;
        split: string;
        mutation_family?: string;
        gold: { decision: string; blocking_concerns: string[]; repair_owners: string[] };
      }>;
    };
    expect(recipe).toMatchObject({
      evidence_class: "external_real_run",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed"
    });
    expect(recipe.cases).toHaveLength(200);
    expect(new Set(recipe.cases.map((item) => item.base_bundle_id))).toHaveProperty("size", 20);
    expect(recipe.cases.every((item) => item.split === "test")).toBe(true);
    expect(recipe.cases.every((item) => item.gold.decision === "needs_review")).toBe(true);
    expect(recipe.cases.every((item) => item.gold.blocking_concerns.length === 0)).toBe(true);
    expect(recipe.cases.every((item) => item.gold.repair_owners.length === 0)).toBe(true);

    const expectedFamilies = promotionVariantDefinitions()
      .flatMap((variant) => variant.mutation_family ? [variant.mutation_family] : [])
      .sort();
    for (const baseBundleId of new Set(recipe.cases.map((item) => item.base_bundle_id))) {
      const baseCases = recipe.cases.filter((item) => item.base_bundle_id === baseBundleId);
      expect(baseCases.filter((item) => !item.mutation_family)).toHaveLength(1);
      expect(baseCases.flatMap((item) => item.mutation_family ? [item.mutation_family] : []).sort()).toEqual(expectedFamilies);
    }

    const freezeManifestText = await readFile(path.join(workspace, frozen.freeze_manifest_path), "utf8");
    const freezeManifest = JSON.parse(freezeManifestText) as {
      intake_manifest_sha256: string;
      recipe_sha256: string;
      source_bundles: Array<{ base_bundle_id: string; source_sha256: string; copied_root: string }>;
    };
    expect(freezeManifest.source_bundles).toHaveLength(20);
    expect(freezeManifest.intake_manifest_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(freezeManifest.recipe_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(new Set(freezeManifest.source_bundles.map((item) => item.source_sha256))).toHaveProperty("size", 20);
    expect(freezeManifestText).not.toContain(path.join(workspace, "sources"));
    expect(freezeManifestText).not.toContain("local-source-");
    expect(recipeText).not.toContain(path.join(workspace, "sources"));
    expect(recipeText).not.toContain("local-source-");

    const built = await buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: frozen.recipe_path,
      outDir: "suite"
    });
    const loaded = await loadPromotionBenchmarkSuite(path.join(workspace, built.suite_path));
    expect(loaded.issues).toEqual([]);
    expect(loaded.suite?.cases).toHaveLength(200);
    const eligibility = evaluatePromotionAdjudicationEligibility({
      evidence_class: loaded.suite?.manifest.evidence_class,
      cases: loaded.suite?.cases || [],
      adjudication_complete: false
    });
    expect(eligibility.paper_claim_eligible).toBe(false);
    expect(eligibility.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "double_adjudication_incomplete",
      "clean_control_outcome_coverage_incomplete"
    ]));
  }, 30_000);

  it("rejects an intake below the independent bundle minimum without creating output", async () => {
    const workspace = await createWorkspace();
    const manifestPath = await writeIntake(workspace, MINIMUM_CONFIRMATORY_BASE_BUNDLES - 1);

    await expect(freezePromotionConfirmatoryCorpus({
      cwd: workspace,
      manifestPath,
      outDir: "frozen"
    })).rejects.toThrow("requires at least 20 source bundles");
    await expect(readFile(path.join(workspace, "frozen", "recipe.json"), "utf8")).rejects.toThrow();
  });

  it("rejects duplicate source content even when source ids and paths differ", async () => {
    const workspace = await createWorkspace();
    const manifestPath = await writeIntake(workspace, MINIMUM_CONFIRMATORY_BASE_BUNDLES);
    const duplicateRoot = path.join(workspace, "sources", "bundle-duplicate");
    await copyDirectory(path.join(workspace, "sources", "bundle-01"), duplicateRoot);
    const manifest = JSON.parse(await readFile(path.join(workspace, manifestPath), "utf8")) as {
      sources: Array<{ source_id: string; source_root: string; evidence_class: string }>;
    };
    manifest.sources[1] = {
      source_id: "local-source-duplicate",
      source_root: "sources/bundle-duplicate",
      evidence_class: "external_real_run"
    };
    await writeJson(path.join(workspace, manifestPath), manifest);

    await expect(freezePromotionConfirmatoryCorpus({
      cwd: workspace,
      manifestPath,
      outDir: "frozen"
    })).rejects.toThrow("must be independent");
    await expect(readFile(path.join(workspace, "frozen", "recipe.json"), "utf8")).rejects.toThrow();
  });

  it("rejects bundles that cannot support every required fault mutation", async () => {
    const workspace = await createWorkspace();
    const manifestPath = await writeIntake(workspace, MINIMUM_CONFIRMATORY_BASE_BUNDLES);
    await rm(path.join(workspace, "sources", "bundle-20", "checkpoint", "state.json"));

    await expect(freezePromotionConfirmatoryCorpus({
      cwd: workspace,
      manifestPath,
      outDir: "frozen"
    })).rejects.toThrow("Mutation target does not exist");
    await expect(readFile(path.join(workspace, "frozen", "recipe.json"), "utf8")).rejects.toThrow();
  });

  it("does not overwrite an existing frozen corpus", async () => {
    const workspace = await createWorkspace();
    const manifestPath = await writeIntake(workspace, MINIMUM_CONFIRMATORY_BASE_BUNDLES);
    await mkdir(path.join(workspace, "frozen"));
    await writeFile(path.join(workspace, "frozen", "sentinel.txt"), "keep\n", "utf8");

    await expect(freezePromotionConfirmatoryCorpus({
      cwd: workspace,
      manifestPath,
      outDir: "frozen"
    })).rejects.toThrow("output already exists");
    expect(await readFile(path.join(workspace, "frozen", "sentinel.txt"), "utf8")).toBe("keep\n");
  });

  it("rejects output paths inside a source bundle before staging begins", async () => {
    const workspace = await createWorkspace();
    const manifestPath = await writeIntake(workspace, MINIMUM_CONFIRMATORY_BASE_BUNDLES);

    await expect(freezePromotionConfirmatoryCorpus({
      cwd: workspace,
      manifestPath,
      outDir: "sources/bundle-01/frozen"
    })).rejects.toThrow("output must stay outside source bundles");
    await expect(readFile(path.join(workspace, "sources", "bundle-01", "frozen", "recipe.json"), "utf8")).rejects.toThrow();
  });
});

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-confirmatory-intake-"));
  tempDirs.push(workspace);
  return workspace;
}

async function writeIntake(workspace: string, sourceCount: number): Promise<string> {
  const sources = [];
  for (let index = 0; index < sourceCount; index += 1) {
    const directoryName = `bundle-${String(index + 1).padStart(2, "0")}`;
    await writeBaseBundle(path.join(workspace, "sources", directoryName), index + 1);
    sources.push({
      source_id: `local-source-${String(index + 1).padStart(2, "0")}`,
      source_root: `sources/${directoryName}`,
      evidence_class: "external_real_run"
    });
  }
  const manifestPath = "intake.json";
  await writeJson(path.join(workspace, manifestPath), {
    schema_version: "1.0",
    study_id: "promotion-confirmatory-test",
    sources
  });
  return manifestPath;
}

async function writeBaseBundle(root: string, ordinal: number): Promise<void> {
  await mkdir(path.join(root, "figure_audit"), { recursive: true });
  await mkdir(path.join(root, "paper"), { recursive: true });
  await mkdir(path.join(root, "checkpoint"), { recursive: true });
  await writeJson(path.join(root, "result_table.json"), [{ baseline: 0.5, comparator: 0.6 }]);
  await writeJson(path.join(root, "experiment_evidence.json"), {
    trials: [{ seed: 101 }, { seed: 211 }, { seed: 307 }]
  });
  await writeJson(path.join(root, "run_config.json"), { planned_budget: { trials: 3 } });
  await writeJson(path.join(root, "run_record.json"), {
    fixture_ordinal: ordinal,
    status: "completed",
    executed_budget: { trials: 3 }
  });
  await writeJson(path.join(root, "figure_audit", "figure_audit_summary.json"), {
    severe_mismatch_count: 0,
    review_block_required: false
  });
  const claim = {
    claim_id: "claim-primary",
    section_heading: "Results",
    status: "verified",
    artifact_refs: ["result_table.json"],
    citation_refs: ["source-primary"]
  };
  await writeJson(path.join(root, "paper", "claim_status_table.json"), { claims: [claim] });
  await writeJson(path.join(root, "paper", "claim_evidence_table.json"), { claims: [claim] });
  await writeJson(path.join(root, "paper", "evidence_links.json"), {
    claims: [{ claim_id: claim.claim_id, evidence_ids: ["evidence-primary"], citation_paper_ids: ["source-primary"] }]
  });
  await writeJson(path.join(root, "checkpoint", "state.json"), { paper_ready: true });
  await writeJson(path.join(root, "design_contracts.json"), {
    sota_ranking_claimed: false,
    sota_evidence_present: false
  });
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
