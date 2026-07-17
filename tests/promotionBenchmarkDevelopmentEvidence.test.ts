import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";
import { evaluatePromotionConfirmatoryGate } from "../src/core/benchmark/promotionBenchmarkConfirmatoryGate.js";
import { exportPromotionDevelopmentEvidence } from "../src/core/benchmark/promotionBenchmarkDevelopmentEvidence.js";
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
});

async function createDevelopmentFlow(): Promise<{
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
  const gate = await evaluatePromotionConfirmatoryGate({
    cwd: workspace,
    suitePath: suite.suite_path,
    predictionsPath: systems.predictions_path,
    systemRunManifestPath: systems.manifest_path,
    providerRunManifestPaths: [],
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
