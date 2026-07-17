import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  hashPromotionBenchmarkSuiteSnapshot,
  hashPromotionArtifactTree,
  type PromotionBenchmarkCaseManifest,
  type PromotionBenchmarkPrediction
} from "../src/core/benchmark/promotionBenchmark.js";
import { evaluatePromotionBenchmarkRecovery } from "../src/core/benchmark/promotionBenchmarkRecovery.js";
import { PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION } from "../src/core/benchmark/promotionBenchmarkSystems.js";
import { promotionVariantDefinitions } from "../src/core/benchmark/promotionBenchmarkVariants.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion benchmark recovery", () => {
  it("recomputes fault recovery and clean-control regression from hash-bound suites", async () => {
    const fixture = await createRecoveryFixture();
    const result = await evaluatePromotionBenchmarkRecovery({
      cwd: fixture.workspace,
      manifestPath: "recovery-manifest.json",
      outDir: "recovery-output"
    });

    expect(result.report).toMatchObject({
      passed: true,
      original_base_bundle_count: 3,
      clean_control_base_bundle_count: 3,
      fault_repair_pair_count: 9,
      successful_recovery_count: 9,
      successful_recovery_rate: 1,
      clean_control_pair_count: 3,
      clean_control_regression_count: 0,
      clean_control_regression_rate: 0,
      missing_fault_families: []
    });
  });

  it("fails closed when one fault family has no post-repair rerun", async () => {
    const fixture = await createRecoveryFixture(true);
    const result = await evaluatePromotionBenchmarkRecovery({
      cwd: fixture.workspace,
      manifestPath: "recovery-manifest.json",
      outDir: "recovery-output"
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.missing_fault_families).toHaveLength(1);
    expect(result.report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "fault_family_recovery_missing" })
    ]));
  });
});

async function createRecoveryFixture(omitLastFault = false): Promise<{ workspace: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-recovery-"));
  tempDirs.push(workspace);
  const originalCases: PromotionBenchmarkCaseManifest[] = [];
  const repairedCases: PromotionBenchmarkCaseManifest[] = [];
  const originalPredictions: PromotionBenchmarkPrediction[] = [];
  const repairedPredictions: PromotionBenchmarkPrediction[] = [];
  const pairs: Array<Record<string, unknown>> = [];
  const variants = promotionVariantDefinitions();

  for (let baseIndex = 0; baseIndex < 3; baseIndex += 1) {
    const baseId = "base-" + baseIndex;
    const sourceSha = sha256("source-" + baseIndex);
    const familySha = sha256("family-" + baseIndex);
    const operatorSha = sha256("operator-" + baseIndex);
    const cleanSource = await writeCaseArtifact(
      workspace,
      "original",
      "source-clean-" + baseIndex,
      { base_id: baseId, state: "clean" }
    );
    const cleanRepaired = await writeCaseArtifact(
      workspace,
      "repaired",
      "repaired-clean-" + baseIndex,
      { base_id: baseId, state: "clean" }
    );
    const originalClean = makeCase({
      caseId: "source-clean-" + baseIndex,
      baseId,
      artifactRoot: cleanSource.root,
      artifactSha: cleanSource.sha,
      sourceSha,
      familySha,
      operatorSha,
      gold: variants[0].gold
    });
    const repairedClean = makeCase({
      caseId: "repaired-clean-" + baseIndex,
      baseId,
      artifactRoot: cleanRepaired.root,
      artifactSha: cleanRepaired.sha,
      sourceSha,
      familySha,
      operatorSha,
      gold: variants[0].gold
    });
    originalCases.push(originalClean);
    repairedCases.push(repairedClean);
    originalPredictions.push(predictionFromGold(originalClean, "original-trial"));
    repairedPredictions.push(predictionFromGold(repairedClean, "repaired-trial"));
    pairs.push({
      pair_kind: "clean_control",
      source_case_id: originalClean.case_id,
      source_trial_id: "original-trial",
      repaired_case_id: repairedClean.case_id,
      repaired_trial_id: "repaired-trial"
    });
  }

  for (const [faultIndex, variant] of variants.slice(1).entries()) {
    const baseIndex = faultIndex % 3;
    const baseId = "base-" + baseIndex;
    const sourceSha = sha256("source-" + baseIndex);
    const familySha = sha256("family-" + baseIndex);
    const operatorSha = sha256("operator-" + baseIndex);
    const mutationFamily = variant.mutation_family as string;
    const sourceId = "source-fault-" + faultIndex;
    const repairedId = "repaired-fault-" + faultIndex;
    const sourceArtifact = await writeCaseArtifact(
      workspace,
      "original",
      sourceId,
      { base_id: baseId, state: "fault", mutation_family: mutationFamily }
    );
    const repairedArtifact = await writeCaseArtifact(
      workspace,
      "repaired",
      repairedId,
      { base_id: baseId, state: "repaired", repaired_family: mutationFamily }
    );
    const originalCase = makeCase({
      caseId: sourceId,
      baseId,
      artifactRoot: sourceArtifact.root,
      artifactSha: sourceArtifact.sha,
      sourceSha,
      familySha,
      operatorSha,
      mutationFamily,
      gold: variant.gold
    });
    const repairedCase = makeCase({
      caseId: repairedId,
      baseId,
      artifactRoot: repairedArtifact.root,
      artifactSha: repairedArtifact.sha,
      sourceSha,
      familySha,
      operatorSha,
      gold: variants[0].gold
    });
    originalCases.push(originalCase);
    repairedCases.push(repairedCase);
    originalPredictions.push(predictionFromGold(originalCase, "original-trial"));
    repairedPredictions.push(predictionFromGold(repairedCase, "repaired-trial"));
    if (!omitLastFault || faultIndex < variants.length - 2) {
      pairs.push({
        pair_kind: "fault_repair",
        source_case_id: originalCase.case_id,
        source_trial_id: "original-trial",
        repaired_case_id: repairedCase.case_id,
        repaired_trial_id: "repaired-trial",
        mutation_family: mutationFamily,
        declared_repair_owner: originalCase.gold.repair_owners[0]
      });
    }
  }

  await writeSuite(workspace, "original", "confirmatory-study", originalCases);
  await writeSuite(workspace, "repaired", "confirmatory-study-repaired", repairedCases);
  await writePredictions(path.join(workspace, "original-predictions.jsonl"), originalPredictions);
  await writePredictions(path.join(workspace, "repaired-predictions.jsonl"), repairedPredictions);
  await writeSystemRunManifest({
    workspace,
    fileName: "original-system-run-manifest.json",
    suiteId: "confirmatory-study",
    suitePath: "original/suite.json",
    predictionsPath: "original-predictions.jsonl",
    trialId: "original-trial",
    caseCount: originalCases.length
  });
  await writeSystemRunManifest({
    workspace,
    fileName: "repaired-system-run-manifest.json",
    suiteId: "confirmatory-study-repaired",
    suitePath: "repaired/suite.json",
    predictionsPath: "repaired-predictions.jsonl",
    trialId: "repaired-trial",
    caseCount: repairedCases.length
  });
  await writeFile(path.join(workspace, "recovery-manifest.json"), JSON.stringify({
    schema_version: "1.0",
    study_id: "confirmatory-study",
    original_suite_path: "original/suite.json",
    repaired_suite_path: "repaired/suite.json",
    original_predictions_path: "original-predictions.jsonl",
    repaired_predictions_path: "repaired-predictions.jsonl",
    original_system_run_manifest_path: "original-system-run-manifest.json",
    repaired_system_run_manifest_path: "repaired-system-run-manifest.json",
    system_id: "artifact-audit",
    pairs
  }));
  return { workspace };
}

async function writeCaseArtifact(
  workspace: string,
  suiteRoot: string,
  caseId: string,
  content: Record<string, unknown>
): Promise<{ root: string; sha: string }> {
  const relativeRoot = "artifacts/" + caseId;
  const absoluteRoot = path.join(workspace, suiteRoot, relativeRoot);
  await mkdir(absoluteRoot, { recursive: true });
  await writeFile(path.join(absoluteRoot, "state.json"), JSON.stringify(content));
  return { root: "../" + relativeRoot, sha: await hashPromotionArtifactTree(absoluteRoot) };
}

function makeCase(input: {
  caseId: string;
  baseId: string;
  artifactRoot: string;
  artifactSha: string;
  sourceSha: string;
  familySha: string;
  operatorSha: string;
  mutationFamily?: string;
  gold: PromotionBenchmarkCaseManifest["gold"];
}): PromotionBenchmarkCaseManifest {
  return {
    schema_version: "1.0",
    case_id: input.caseId,
    base_bundle_id: input.baseId,
    split: "test",
    artifact_root: input.artifactRoot,
    source_sha256: input.sourceSha,
    source_family_id_sha256: input.familySha,
    operator_group_id_sha256: input.operatorSha,
    artifact_sha256: input.artifactSha,
    ...(input.mutationFamily ? { mutation_family: input.mutationFamily } : {}),
    gold: input.gold
  };
}

async function writeSuite(
  workspace: string,
  suiteRoot: string,
  suiteId: string,
  cases: PromotionBenchmarkCaseManifest[]
): Promise<void> {
  const caseDir = path.join(workspace, suiteRoot, "cases");
  await mkdir(caseDir, { recursive: true });
  const caseRefs: string[] = [];
  for (const benchmarkCase of cases) {
    const ref = "cases/" + benchmarkCase.case_id + ".json";
    caseRefs.push(ref);
    await writeFile(path.join(workspace, suiteRoot, ref), JSON.stringify(benchmarkCase));
  }
  await writeFile(path.join(workspace, suiteRoot, "suite.json"), JSON.stringify({
    schema_version: "1.0",
    suite_id: suiteId,
    evidence_class: "external_real_run",
    paper_claim_eligible: true,
    adjudication_status: "double_adjudicated",
    mutation_isolation_status: "double_verified",
    execution_provenance_status: "artifact_verified",
    source_diversity_status: "declared_stratified",
    cases: caseRefs
  }));
}

function predictionFromGold(
  benchmarkCase: PromotionBenchmarkCaseManifest,
  trialId: string
): PromotionBenchmarkPrediction {
  return {
    case_id: benchmarkCase.case_id,
    system_id: "artifact-audit",
    trial_id: trialId,
    decision: benchmarkCase.gold.decision,
    concerns: benchmarkCase.gold.blocking_concerns.map((code) => ({ code, severity: "blocking" })),
    repair_owners: benchmarkCase.gold.repair_owners
  };
}

async function writePredictions(filePath: string, predictions: PromotionBenchmarkPrediction[]): Promise<void> {
  await writeFile(filePath, predictions.map((prediction) => JSON.stringify(prediction)).join("\n") + "\n");
}

async function writeSystemRunManifest(input: {
  workspace: string;
  fileName: string;
  suiteId: string;
  suitePath: string;
  predictionsPath: string;
  trialId: string;
  caseCount: number;
}): Promise<void> {
  await writeFile(path.join(input.workspace, input.fileName), JSON.stringify({
    schema_version: "1.1",
    protocol_revision: PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION,
    status: "completed",
    evidence_class: "deterministic_artifact_evaluation",
    suite_id: input.suiteId,
    suite_path: input.suitePath,
    suite_sha256: await sha256File(path.join(input.workspace, input.suitePath)),
    suite_snapshot_sha256: await hashPromotionBenchmarkSuiteSnapshot(
      path.join(input.workspace, input.suitePath)
    ),
    trial_id: input.trialId,
    generated_at: "2026-01-01T00:00:00.000Z",
    case_count: input.caseCount,
    prediction_count: input.caseCount,
    systems: [{
      system_id: "artifact-audit",
      protocol: "full_artifact_policy",
      ablated_components: []
    }],
    artifacts: {
      predictions_path: input.predictionsPath,
      predictions_sha256: await sha256File(path.join(input.workspace, input.predictionsPath))
    }
  }));
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
