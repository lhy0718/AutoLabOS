import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";
import { runPromotionDevelopmentRecovery } from "../src/core/benchmark/promotionBenchmarkDevelopmentRecovery.js";
import { runPromotionBenchmarkSystems } from "../src/core/benchmark/promotionBenchmarkSystems.js";
import { generateSyntheticPromotionCorpus } from "../src/core/benchmark/promotionBenchmarkSyntheticCorpus.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion development recovery runner", () => {
  it("materializes every repair, reruns the full policy, and verifies development-only recovery", async () => {
    const fixture = await createFixture();
    const result = await runPromotionDevelopmentRecovery({
      cwd: fixture.workspace,
      suitePath: fixture.suitePath,
      originalPredictionsPath: fixture.predictionsPath,
      originalSystemRunManifestPath: fixture.systemRunManifestPath,
      repairedSuiteId: "synthetic-repaired-suite",
      repairedTrialId: "post-repair-trial",
      outDir: "recovery"
    });

    expect(result.summary).toMatchObject({
      schema_version: "1.0",
      evidence_class: "synthetic_development",
      paper_claim_eligible: false,
      development_evidence_verified: true,
      original_fault_case_count: 36,
      covered_fault_case_count: 36,
      missing_fault_case_count: 0,
      successful_recovery_rate: 1,
      clean_control_regression_rate: 0
    });
    expect(result.recovery).toMatchObject({
      passed: false,
      fault_repair_pair_count: 36,
      clean_control_pair_count: 4,
      missing_fault_families: [],
      missing_fault_case_ids: []
    });
    expect(result.recovery.pairs.every((pair) => pair.valid)).toBe(true);
    expect(result.summary.paper_scale_eligibility_issue_codes).toEqual([
      "original_artifact_execution_required",
      "original_double_adjudication_required",
      "original_external_real_run_required",
      "original_paper_claim_eligibility_required",
      "repaired_artifact_execution_required",
      "repaired_double_adjudication_required",
      "repaired_external_real_run_required"
    ]);
    const repairedSuite = JSON.parse(
      await readFile(path.join(fixture.workspace, result.repaired_suite_path), "utf8")
    ) as { evidence_class: string; paper_claim_eligible: boolean; cases: string[] };
    expect(repairedSuite).toMatchObject({
      evidence_class: "synthetic_development",
      paper_claim_eligible: false
    });
    expect(repairedSuite.cases).toHaveLength(40);
  });

  it("refuses to materialize paper-facing recovery evidence", async () => {
    const fixture = await createFixture();
    const suiteAbsolutePath = path.join(fixture.workspace, fixture.suitePath);
    const suite = JSON.parse(await readFile(suiteAbsolutePath, "utf8")) as Record<string, unknown>;
    suite.evidence_class = "human_adjudicated_test";
    await writeFile(suiteAbsolutePath, JSON.stringify(suite, null, 2) + "\n", "utf8");

    await expect(runPromotionDevelopmentRecovery({
      cwd: fixture.workspace,
      suitePath: fixture.suitePath,
      originalPredictionsPath: fixture.predictionsPath,
      originalSystemRunManifestPath: fixture.systemRunManifestPath,
      repairedSuiteId: "forbidden-repaired-suite",
      repairedTrialId: "forbidden-trial",
      outDir: "recovery"
    })).rejects.toThrow("restricted to non-paper synthetic development suites");
  });
});

async function createFixture(): Promise<{
  workspace: string;
  suitePath: string;
  predictionsPath: string;
  systemRunManifestPath: string;
}> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-development-recovery-"));
  tempDirs.push(workspace);
  const corpus = await generateSyntheticPromotionCorpus({ cwd: workspace, outDir: "corpus" });
  const suite = await buildPromotionBenchmarkSuite({
    cwd: workspace,
    recipePath: corpus.recipe_path,
    outDir: "suite"
  });
  const systems = await runPromotionBenchmarkSystems({
    cwd: workspace,
    suitePath: suite.suite_path,
    trialId: "original-trial",
    outDir: "predictions"
  });
  return {
    workspace,
    suitePath: suite.suite_path,
    predictionsPath: systems.predictions_path,
    systemRunManifestPath: systems.manifest_path
  };
}
