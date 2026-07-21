import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmark.js";
import { generateControlledPromotionBenchmark } from "../src/core/benchmark/promotionBenchmarkControlledCorpus.js";
import { certifyPromotionDeterministicOracle } from "../src/core/benchmark/promotionBenchmarkDeterministicOracleCertification.js";
import { registeredFaultFamilies } from "../src/core/benchmark/promotionBenchmarkDeterministicOracleContract.js";
import { exportPromotionBenchmarkPromptPack } from "../src/core/benchmark/promotionBenchmarkPromptPack.js";

describe("deterministic promotion oracle", () => {
  it("builds a human-free controlled suite with disjoint held-out fault families", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "promotion-oracle-controlled-"));
    const result = await generateControlledPromotionBenchmark({
      cwd: workspace,
      outDir: "nested/controlled",
      seed: "stable-split",
      developmentBaseBundleCount: 2,
      testBaseBundleCount: 2
    });

    expect(result.paper_claim_eligible).toBe(false);
    expect(result.development_case_count).toBeGreaterThan(2);
    expect(result.test_case_count).toBeGreaterThan(2);
    expect(new Set([
      ...result.development_mutation_families,
      ...result.test_mutation_families
    ])).toEqual(new Set(registeredFaultFamilies()));
    expect(result.development_mutation_families.every(
      (family) => !result.test_mutation_families.includes(family)
    )).toBe(true);

    const loaded = await loadPromotionBenchmarkSuite(path.join(workspace, result.certified_suite_path));
    expect(loaded.issues).toEqual([]);
    expect(loaded.suite?.manifest).toMatchObject({
      evidence_class: "deterministic_fault_injection_test",
      evaluation_regime: "controlled_deterministic_fault_injection",
      claim_ceiling: "registered_fault_families_only",
      external_validation_status: "not_run",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed",
      mutation_isolation_status: "oracle_verified"
    });
    expect(loaded.suite?.manifest.adjudication_provenance).toBeUndefined();
    expect(loaded.suite?.manifest.confirmatory_freeze_provenance).toBeUndefined();
    expect(loaded.suite?.manifest.deterministic_oracle_provenance).toBeDefined();

    const promptPack = await exportPromotionBenchmarkPromptPack({
      cwd: workspace,
      suitePath: result.certified_suite_path,
      outDir: "prompt-pack"
    });
    const requestText = await fs.readFile(path.join(workspace, promptPack.requests_path), "utf8");
    for (const family of result.test_mutation_families) {
      expect(requestText).not.toContain(family);
    }
    expect(requestText).not.toContain("controlled_deterministic_fault_injection");
    expect(requestText).not.toContain("registry_bound_independent_oracle");
    expect(requestText).not.toContain("gold-manifest.json");
    expect(requestText).not.toContain("test-case-");

    const certifiedSuitePath = path.join(workspace, result.certified_suite_path);
    const certifiedManifest = JSON.parse(await fs.readFile(certifiedSuitePath, "utf8")) as {
      adjudication_status: string;
    };
    certifiedManifest.adjudication_status = "single_annotator";
    await fs.writeFile(certifiedSuitePath, JSON.stringify(certifiedManifest, null, 2) + "\n", "utf8");
    const statusDrift = await loadPromotionBenchmarkSuite(certifiedSuitePath);
    expect(statusDrift.issues.map((issue) => issue.code))
      .toContain("suite_deterministic_oracle_scope_invalid");
  });

  it("produces byte-stable oracle manifests for the same seed and inputs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "promotion-oracle-stable-"));
    const first = await generateControlledPromotionBenchmark({
      cwd: workspace,
      outDir: "first",
      seed: "repeatable",
      developmentBaseBundleCount: 1,
      testBaseBundleCount: 1
    });
    const second = await generateControlledPromotionBenchmark({
      cwd: workspace,
      outDir: "second",
      seed: "repeatable",
      developmentBaseBundleCount: 1,
      testBaseBundleCount: 1
    });
    for (const ref of [
      "oracle/registry-manifest.json",
      "oracle/gold-manifest.json",
      "oracle/split-manifest.json",
      "oracle/oracle-report.json"
    ]) {
      const firstBytes = await fs.readFile(path.join(workspace, path.dirname(first.certified_suite_path), ref));
      const secondBytes = await fs.readFile(path.join(workspace, path.dirname(second.certified_suite_path), ref));
      expect(secondBytes.equals(firstBytes), ref).toBe(true);
    }
  });

  it("rejects gold drift and persists a fail-closed quarantine report", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "promotion-oracle-quarantine-"));
    const generated = await generateControlledPromotionBenchmark({
      cwd: workspace,
      outDir: "source",
      seed: "quarantine",
      developmentBaseBundleCount: 1,
      testBaseBundleCount: 1
    });
    const testSuitePath = path.join(workspace, generated.test_suite_path);
    const testManifest = JSON.parse(await fs.readFile(testSuitePath, "utf8")) as { cases: string[] };
    const casePath = path.resolve(path.dirname(testSuitePath), testManifest.cases[0]!);
    const benchmarkCase = JSON.parse(await fs.readFile(casePath, "utf8")) as {
      gold: { decision: string };
    };
    benchmarkCase.gold.decision = "block";
    await fs.writeFile(casePath, JSON.stringify(benchmarkCase, null, 2) + "\n", "utf8");

    await expect(certifyPromotionDeterministicOracle({
      cwd: workspace,
      developmentSuitePath: generated.development_suite_path,
      testSuitePath: generated.test_suite_path,
      outDir: "quarantined"
    })).rejects.toThrow(/quarantined/iu);
    const report = JSON.parse(
      await fs.readFile(path.join(workspace, "quarantined", "oracle-quarantine-report.json"), "utf8")
    ) as { status: string; paper_claim_eligible: boolean; issues: Array<{ code: string }> };
    expect(report).toMatchObject({
      status: "quarantined",
      paper_claim_eligible: false
    });
    expect(report.issues.map((issue) => issue.code)).toContain("case_registry_mismatch");
    await expect(fs.access(path.join(workspace, "quarantined", "suite.json"))).rejects.toThrow();
  });

  it("invalidates a certified suite when bound oracle evidence changes", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "promotion-oracle-tamper-"));
    const result = await generateControlledPromotionBenchmark({
      cwd: workspace,
      outDir: "controlled",
      seed: "tamper",
      developmentBaseBundleCount: 1,
      testBaseBundleCount: 1
    });
    const suiteRoot = path.dirname(path.join(workspace, result.certified_suite_path));
    const goldPath = path.join(suiteRoot, "oracle", "gold-manifest.json");
    await fs.appendFile(goldPath, " ");
    const loaded = await loadPromotionBenchmarkSuite(path.join(suiteRoot, "suite.json"));
    expect(loaded.issues.map((issue) => issue.code))
      .toContain("deterministic_oracle_evidence_hash_mismatch");
  });
});
