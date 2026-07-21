import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";
import { evaluatePromotionConfirmatoryGate } from "../src/core/benchmark/promotionBenchmarkConfirmatoryGate.js";
import { exportPromotionDevelopmentEvidence } from "../src/core/benchmark/promotionBenchmarkDevelopmentEvidence.js";
import { runPromotionDevelopmentRecovery } from "../src/core/benchmark/promotionBenchmarkDevelopmentRecovery.js";
import { runPromotionBenchmarkProvider } from "../src/core/benchmark/promotionBenchmarkProviderRunner.js";
import { runPromotionBenchmarkSystems } from "../src/core/benchmark/promotionBenchmarkSystems.js";
import { generateSyntheticPromotionCorpus } from "../src/core/benchmark/promotionBenchmarkSyntheticCorpus.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion development evidence export", () => {
  it("cross-verifies the development flow and emits deterministic non-paper evidence", async () => {
    const fixture = await createDevelopmentFlow();
    const first = await exportPromotionDevelopmentEvidence({
      ...fixture.inputs,
      outputPath: "development-evidence-a.json"
    });
    const second = await exportPromotionDevelopmentEvidence({
      ...fixture.inputs,
      outputPath: "development-evidence-b.json"
    });

    expect(first.report).toMatchObject({
      evidence_class: "synthetic_development",
      paper_claim_eligible: false,
      artifact_consistency_verified: true,
      source_artifact_availability: "local_run_only",
      corpus: { base_bundle_count: 4, case_count: 40 },
      evaluation: { score_validation_passed: true, prediction_count: 160 },
      confirmatory_gate: {
        readiness: "blocked_for_paper_scale",
        paper_ready: false,
        evidence_gate_passed: false
      }
    });
    expect(first.report.node_strengthening.map((item) => item.node)).toEqual([
      "design_experiments",
      "review",
      "run_experiments"
    ]);
    expect(first.report.source_artifacts.every((item) => item.ref.startsWith("<development-run>/"))).toBe(true);
    expect(first.report.source_artifacts.every((item) => !item.ref.includes("outputs/"))).toBe(true);
    expect(await readFile(path.join(fixture.workspace, first.output_path), "utf8")).toBe(
      await readFile(path.join(fixture.workspace, second.output_path), "utf8")
    );
  });

  it("rejects a recommendation report that drops a gate diagnostic", async () => {
    const fixture = await createDevelopmentFlow();
    const recommendationsPath = path.join(fixture.workspace, fixture.inputs.recommendationsPath);
    const value = JSON.parse(await readFile(recommendationsPath, "utf8")) as {
      recommendations: Array<{ diagnostic_ids: string[] }>;
    };
    value.recommendations[0].diagnostic_ids.shift();
    await writeFile(recommendationsPath, JSON.stringify(value, null, 2) + "\n", "utf8");

    await expect(exportPromotionDevelopmentEvidence({
      ...fixture.inputs,
      outputPath: "rejected-evidence.json"
    })).rejects.toThrow("do not cover the gate blockers");
  });

  it("cross-verifies hash-bound real-model repetitions as development-only evidence", async () => {
    const fixture = await createDevelopmentFlow({ includeProvider: true });
    const result = await exportPromotionDevelopmentEvidence({
      ...fixture.inputs,
      outputPath: "development-evidence-real-model.json"
    });

    expect(result.report).toMatchObject({
      schema_version: "1.2",
      paper_claim_eligible: false,
      evaluation: { prediction_count: 280 },
      real_model_evaluation: {
        status: "verified_development_only",
        trial_count: 3,
        prediction_count: 120,
        execution_environment: "local_runtime",
        execution_receipt_status: "local_runtime_hash_bound",
        external_empirical_evidence_eligible: false,
        paper_claim_evidence_eligible: false
      },
      confirmatory_gate: {
        provider_repetition: { status: "verified_receipt_distinct", trial_count: 3 }
      }
    });
    expect(result.report.source_artifacts.map((item) => item.role)).toEqual(expect.arrayContaining([
      "provider_aggregate",
      "provider_predictions"
    ]));
    expect(result.report.evidence_boundary).toContain("verified development executions");
  });

  it("cross-verifies complete post-repair reruns without promoting development evidence", async () => {
    const fixture = await createDevelopmentFlow({ includeProvider: true, includeRecovery: true });
    const result = await exportPromotionDevelopmentEvidence({
      ...fixture.inputs,
      outputPath: "development-evidence-with-recovery.json"
    });

    expect(result.report).toMatchObject({
      schema_version: "1.2",
      paper_claim_eligible: false,
      development_recovery_evaluation: {
        status: "verified_development_only",
        original_fault_case_count: 36,
        covered_fault_case_count: 36,
        missing_fault_case_count: 0,
        successful_recovery_rate: 1,
        clean_control_regression_rate: 0,
        paper_claim_evidence_eligible: false
      },
      confirmatory_gate: {
        readiness: "blocked_for_paper_scale",
        paper_ready: false,
        recovery: {
          status: "missing_or_invalid",
          successful_recovery_rate: 1,
          clean_control_regression_rate: 0
        }
      }
    });
    expect(result.report.source_artifacts.map((item) => item.role)).toContain("recovery_report");
    expect(result.report.evidence_boundary).toContain("post-repair rerun");
  });

  it("rejects recovery report drift after the confirmatory gate binds it", async () => {
    const fixture = await createDevelopmentFlow({ includeRecovery: true });
    const gate = JSON.parse(
      await readFile(path.join(fixture.workspace, fixture.inputs.gateReportPath), "utf8")
    ) as { artifacts: { recovery_report_ref: string } };
    const reportPath = path.join(fixture.workspace, gate.artifacts.recovery_report_ref);
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    report.successful_recovery_rate = 0;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");

    await expect(exportPromotionDevelopmentEvidence({
      ...fixture.inputs,
      outputPath: "rejected-recovery-drift.json"
    })).rejects.toThrow("does not match the confirmatory gate bindings");
  });
});

async function createDevelopmentFlow(options: {
  includeProvider?: boolean;
  includeRecovery?: boolean;
} = {}): Promise<{
  workspace: string;
  inputs: Omit<Parameters<typeof exportPromotionDevelopmentEvidence>[0], "outputPath">;
}> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-development-evidence-"));
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
    trialId: "development-trial",
    outDir: "predictions"
  });
  const providerRunManifestPaths: string[] = [];
  if (options.includeProvider) {
    for (const trialId of ["local-trial-a", "local-trial-b", "local-trial-c"]) {
      const run = await runPromotionBenchmarkProvider({
        cwd: workspace,
        suitePath: suite.suite_path,
        outDir: `provider-${trialId}`,
        provider: "ollama_local",
        model: "local-model:latest",
        modelArtifactDigest: "a".repeat(64),
        reasoningEffort: "off",
        systemId: "provider-review",
        trialId,
        evidenceClass: "local_real_model"
      }, {
        complete: async () => ({
          text: JSON.stringify({
            decision: "needs_review",
            concerns: [{
              code: "insufficient_manuscript_evidence",
              severity: "blocking",
              evidence_refs: ["paper/main.tex"]
            }],
            repair_owners: ["review"]
          }),
          model: "local-model:latest",
          totalDurationNs: 100,
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 }
        })
      });
      providerRunManifestPaths.push(run.manifest_path);
    }
  }
  const recovery = options.includeRecovery
    ? await runPromotionDevelopmentRecovery({
      cwd: workspace,
      suitePath: suite.suite_path,
      originalPredictionsPath: systems.predictions_path,
      originalSystemRunManifestPath: systems.manifest_path,
      repairedSuiteId: "development-repaired-suite",
      repairedTrialId: "development-post-repair-trial",
      outDir: "recovery"
    })
    : null;
  const gate = await evaluatePromotionConfirmatoryGate({
    cwd: workspace,
    suitePath: suite.suite_path,
    predictionsPath: systems.predictions_path,
    systemRunManifestPath: systems.manifest_path,
    providerRunManifestPaths,
    recoveryManifestPath: recovery?.recovery_manifest_path,
    systemRoles: {
      ungated: "always-promote",
      checklist: "presence-checklist",
      manuscript: "provider-review",
      full: "artifact-audit",
      ablations: ["advisory-artifact-audit"]
    },
    outDir: "gate"
  });
  return {
    workspace,
    inputs: {
      cwd: workspace,
      corpusManifestPath: corpus.corpus_manifest_path,
      suitePath: suite.suite_path,
      predictionsPath: systems.predictions_path,
      systemRunManifestPath: systems.manifest_path,
      scoreReportPath: gate.report.artifacts.score_report_ref,
      gateReportPath: gate.gate_report_path,
      recommendationsPath: gate.recommendations_path
    }
  };
}
