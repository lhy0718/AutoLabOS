import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { generateControlledPromotionBenchmark } from "../src/core/benchmark/promotionBenchmarkControlledCorpus.js";
import { runPromotionControlledRecovery } from "../src/core/benchmark/promotionBenchmarkControlledRecovery.js";
import { runPromotionBenchmarkSystems } from "../src/core/benchmark/promotionBenchmarkSystems.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("controlled promotion recovery", () => {
  it("executes prediction-owned node repairs without clean-oracle substitution", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-controlled-recovery-"));
    tempDirs.push(workspace);
    const controlled = await generateControlledPromotionBenchmark({
      cwd: workspace,
      outDir: "controlled",
      seed: "autolabos-controlled-fault-split-v1",
      developmentBaseBundleCount: 1,
      testBaseBundleCount: 120
    });
    const original = await runPromotionBenchmarkSystems({
      cwd: workspace,
      suitePath: controlled.certified_suite_path,
      outDir: "original-run",
      systems: ["artifact-audit"],
      trialId: "original-trial"
    });

    const result = await runPromotionControlledRecovery({
      cwd: workspace,
      suitePath: controlled.certified_suite_path,
      originalPredictionsPath: original.predictions_path,
      originalSystemRunManifestPath: original.manifest_path,
      repairedSuiteId: "controlled-repaired-suite",
      repairedTrialId: "repaired-trial",
      outDir: "recovery"
    });

    expect(result.recovery).toMatchObject({
      passed: true,
      evaluation_regime: "controlled_deterministic_fault_injection",
      claim_ceiling: "registered_fault_families_only",
      original_fault_case_count: 600,
      covered_fault_case_count: 600,
      successful_recovery_rate: 1,
      exact_clean_artifact_match_rate: 0.6,
      clean_control_regression_rate: 0,
      repair_execution_manifest_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      issues: []
    });
    const execution = JSON.parse(
      await readFile(path.join(workspace, result.repair_execution_manifest_path), "utf8")
    ) as {
      allowed_input_boundary: string[];
      prohibited_input_boundary: string[];
      repair_attempt_count: number;
      successful_repair_count: number;
      clean_control_count: number;
      attempts: Array<{ declared_repair_owner: string | null; changed_paths: string[] }>;
    };
    expect(execution).toMatchObject({
      allowed_input_boundary: ["case_artifact", "source_prediction"],
      prohibited_input_boundary: ["source_gold", "sibling_clean_artifact", "oracle_manifests"],
      repair_attempt_count: 720,
      successful_repair_count: 600,
      clean_control_count: 120
    });
    expect(execution.attempts.filter((attempt) => attempt.declared_repair_owner === "run_experiments"))
      .toHaveLength(240);
    expect(execution.attempts.filter((attempt) => attempt.declared_repair_owner === "analyze_results"))
      .toHaveLength(240);
    expect(execution.attempts.filter((attempt) => attempt.declared_repair_owner === "figure_audit"))
      .toHaveLength(120);
    expect(execution.attempts.filter((attempt) => attempt.declared_repair_owner !== null)
      .every((attempt) => attempt.changed_paths.length > 0)).toBe(true);
  }, 120_000);
});
