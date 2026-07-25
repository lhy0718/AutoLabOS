import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  hashPromotionArtifactTree,
  loadPromotionBenchmarkPredictions,
  loadPromotionBenchmarkSuite,
  type PromotionBenchmarkCaseManifest,
  type PromotionBenchmarkPrediction,
  type PromotionBenchmarkSuiteManifest
} from "./promotionBenchmark.js";
import {
  runPromotionBenchmarkSystems,
  verifyPromotionBenchmarkSystemRun,
  type PromotionBenchmarkSystemName
} from "./promotionBenchmarkSystems.js";
import {
  evaluatePromotionBenchmarkRecovery,
  type PromotionRecoveryManifest,
  type PromotionRecoveryReport
} from "./promotionBenchmarkRecovery.js";
import {
  PROMOTION_REPAIR_EXECUTION_PROTOCOL,
  parsePromotionRepairExecutionManifest,
  type PromotionRepairExecutionAttempt,
  type PromotionRepairExecutionManifest
} from "./promotionBenchmarkRepairExecution.js";
import {
  repairPromotionArtifacts,
  type PromotionArtifactRepairOwner
} from "../nodes/promotionArtifactRepairAdapters.js";

export interface RunPromotionControlledRecoveryInput {
  cwd: string;
  suitePath: string;
  originalPredictionsPath: string;
  originalSystemRunManifestPath: string;
  repairedSuiteId: string;
  repairedTrialId: string;
  outDir: string;
}

export interface RunPromotionControlledRecoveryResult {
  recovery: PromotionRecoveryReport;
  output_dir: string;
  repaired_suite_path: string;
  repaired_predictions_path: string;
  repaired_system_run_manifest_path: string;
  repair_execution_manifest_path: string;
  recovery_manifest_path: string;
  recovery_report_path: string;
}

export async function runPromotionControlledRecovery(
  input: RunPromotionControlledRecoveryInput
): Promise<RunPromotionControlledRecoveryResult> {
  const cwd = path.resolve(input.cwd);
  const suitePath = await resolveExistingInside(cwd, input.suitePath, "Controlled recovery suite");
  const originalPredictionsPath = await resolveExistingInside(
    cwd,
    input.originalPredictionsPath,
    "Controlled recovery predictions"
  );
  const originalSystemRunManifestPath = await resolveExistingInside(
    cwd,
    input.originalSystemRunManifestPath,
    "Controlled recovery system run manifest"
  );
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Controlled recovery output");
  await assertFreshOutput(outDir);
  assertPortableIdentifier(input.repairedSuiteId, "Repaired suite ID");
  assertPortableIdentifier(input.repairedTrialId, "Repaired trial ID");

  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(`Controlled recovery requires a valid suite: ${loaded.issues.map((issue) => issue.code).join(", ")}`);
  }
  const sourceManifest = loaded.suite.manifest;
  if (sourceManifest.evidence_class !== "deterministic_fault_injection_test"
      || sourceManifest.evaluation_regime !== "controlled_deterministic_fault_injection"
      || sourceManifest.claim_ceiling !== "registered_fault_families_only"
      || sourceManifest.paper_claim_eligible !== true
      || sourceManifest.mutation_isolation_status !== "oracle_verified"
      || !sourceManifest.deterministic_oracle_provenance
      || loaded.suite.cases.some((benchmarkCase) => benchmarkCase.split !== "test")) {
    throw new Error("Controlled recovery requires an oracle-certified paper-eligible test suite.");
  }
  if (sourceManifest.suite_id === input.repairedSuiteId) {
    throw new Error("Repaired suite ID must differ from the source suite ID.");
  }

  const originalSystemRun = await verifyPromotionBenchmarkSystemRun({
    cwd,
    manifestPath: originalSystemRunManifestPath,
    suitePath,
    predictionsPath: originalPredictionsPath
  });
  const fullSystems = originalSystemRun.systems.filter((system) => system.protocol === "full_artifact_policy");
  if (fullSystems.length !== 1) {
    throw new Error("Controlled recovery requires exactly one full artifact-policy system.");
  }
  const fullSystem = fullSystems[0]!.system_id;
  const predictionLoad = await loadPromotionBenchmarkPredictions(originalPredictionsPath);
  if (predictionLoad.issues.length > 0) {
    throw new Error(`Controlled recovery predictions are invalid: ${predictionLoad.issues.map((issue) => issue.code).join(", ")}`);
  }
  const predictions = predictionLoad.predictions.filter((prediction) =>
    prediction.system_id === fullSystem && prediction.trial_id === originalSystemRun.trial_id);
  const predictionByCase = new Map(predictions.map((prediction) => [prediction.case_id, prediction] as const));
  if (predictions.length !== loaded.suite.cases.length || predictionByCase.size !== loaded.suite.cases.length) {
    throw new Error("Controlled recovery requires complete full-policy prediction coverage.");
  }

  await fs.mkdir(outDir, { recursive: true });
  const repairedSuiteRoot = path.join(outDir, "repaired-suite");
  await fs.mkdir(path.join(repairedSuiteRoot, "cases"), { recursive: true });
  const repairedCaseRefs: string[] = [];
  const pairs: PromotionRecoveryManifest["pairs"] = [];
  const attempts: PromotionRepairExecutionAttempt[] = [];

  for (const sourceCase of loaded.suite.cases) {
    const sourcePrediction = predictionByCase.get(sourceCase.case_id);
    if (!sourcePrediction) throw new Error(`Missing source prediction: ${sourceCase.case_id}`);
    const sourceArtifactRoot = loaded.suite.case_artifact_roots[sourceCase.case_id];
    if (!sourceArtifactRoot || !sourceCase.source_sha256 || !sourceCase.artifact_sha256) {
      throw new Error(`Controlled recovery case lacks source bindings: ${sourceCase.case_id}`);
    }
    const repairedCaseId = makeRepairedCaseId(sourceCase.case_id);
    const repairedArtifactRoot = path.join(repairedSuiteRoot, "artifacts", repairedCaseId);
    await fs.mkdir(path.dirname(repairedArtifactRoot), { recursive: true });
    await fs.cp(sourceArtifactRoot, repairedArtifactRoot, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    const startedAt = new Date().toISOString();
    const inputArtifactSha256 = await hashPromotionArtifactTree(repairedArtifactRoot);
    if (inputArtifactSha256 !== sourceCase.artifact_sha256) {
      throw new Error(`Controlled recovery source copy hash mismatch: ${sourceCase.case_id}`);
    }

    let owner: PromotionArtifactRepairOwner | null = null;
    let adapterRevision: string | null = null;
    let changedPaths: string[] = [];
    const repairRequested = sourcePrediction.decision !== "promote";
    if (repairRequested) {
      owner = requireRepairOwner(sourcePrediction);
      const repaired = await repairPromotionArtifacts({ artifactRoot: repairedArtifactRoot, owner });
      adapterRevision = repaired.adapter_revision;
      changedPaths = repaired.changed_paths;
      if (changedPaths.length === 0) {
        throw new Error(`Node-owned repair made no artifact change: ${sourceCase.case_id}`);
      }
    } else if (sourcePrediction.repair_owners.length > 0) {
      throw new Error(`Promoted source prediction declared repair owners: ${sourceCase.case_id}`);
    }
    const outputArtifactSha256 = await hashPromotionArtifactTree(repairedArtifactRoot);
    if (repairRequested && outputArtifactSha256 === inputArtifactSha256) {
      throw new Error(`Node-owned repair did not change the artifact tree: ${sourceCase.case_id}`);
    }
    if (!repairRequested && outputArtifactSha256 !== inputArtifactSha256) {
      throw new Error(`Clean-control rerun changed the artifact tree: ${sourceCase.case_id}`);
    }
    const posthocFaultLabel = Boolean(sourceCase.mutation_family);
    if (repairRequested !== posthocFaultLabel) {
      throw new Error(`Source-prediction repair routing disagrees with post-hoc case labels: ${sourceCase.case_id}`);
    }
    const completedAt = new Date().toISOString();
    const repairedCase: PromotionBenchmarkCaseManifest = {
      schema_version: "1.0",
      case_id: repairedCaseId,
      base_bundle_id: sourceCase.base_bundle_id,
      split: "test",
      artifact_root: `../artifacts/${repairedCaseId}`,
      source_sha256: sourceCase.source_sha256,
      ...(sourceCase.source_family_id_sha256
        ? { source_family_id_sha256: sourceCase.source_family_id_sha256 }
        : {}),
      ...(sourceCase.operator_group_id_sha256
        ? { operator_group_id_sha256: sourceCase.operator_group_id_sha256 }
        : {}),
      artifact_sha256: outputArtifactSha256,
      gold: { decision: "promote", blocking_concerns: [], repair_owners: [] }
    };
    const caseRef = `cases/${repairedCaseId}.json`;
    await writeJsonFile(path.join(repairedSuiteRoot, caseRef), repairedCase);
    repairedCaseRefs.push(caseRef);
    const pairKind = posthocFaultLabel ? "fault_repair" as const : "clean_control" as const;
    attempts.push({
      pair_kind: pairKind,
      source_case_id: sourceCase.case_id,
      repaired_case_id: repairedCaseId,
      source_prediction_sha256: sha256(JSON.stringify(sourcePrediction)),
      declared_repair_owner: owner,
      adapter_revision: adapterRevision,
      status: repairRequested ? "repaired" : "unchanged",
      started_at: startedAt,
      completed_at: completedAt,
      input_artifact_sha256: inputArtifactSha256,
      output_artifact_sha256: outputArtifactSha256,
      changed_paths: changedPaths
    });
    pairs.push(posthocFaultLabel
      ? {
          pair_kind: "fault_repair",
          source_case_id: sourceCase.case_id,
          source_trial_id: originalSystemRun.trial_id,
          repaired_case_id: repairedCaseId,
          repaired_trial_id: input.repairedTrialId,
          mutation_family: sourceCase.mutation_family,
          declared_repair_owner: owner!
        }
      : {
          pair_kind: "clean_control",
          source_case_id: sourceCase.case_id,
          source_trial_id: originalSystemRun.trial_id,
          repaired_case_id: repairedCaseId,
          repaired_trial_id: input.repairedTrialId
        });
  }

  const repairedSuiteManifest: PromotionBenchmarkSuiteManifest = {
    schema_version: "1.0",
    suite_id: input.repairedSuiteId,
    evidence_class: "deterministic_fault_injection_test",
    paper_claim_eligible: false,
    adjudication_status: "unreviewed",
    mutation_isolation_status: "unreviewed",
    execution_provenance_status: "artifact_verified",
    ...(sourceManifest.source_diversity_status
      ? { source_diversity_status: sourceManifest.source_diversity_status }
      : {}),
    evaluation_regime: "controlled_deterministic_fault_injection",
    claim_ceiling: "registered_fault_families_only",
    external_validation_status: "not_run",
    cases: repairedCaseRefs
  };
  const repairedSuitePath = path.join(repairedSuiteRoot, "suite.json");
  await writeJsonFile(repairedSuitePath, repairedSuiteManifest);
  const repairedLoad = await loadPromotionBenchmarkSuite(repairedSuitePath);
  if (!repairedLoad.suite || repairedLoad.issues.length > 0) {
    throw new Error(`Materialized controlled repair suite is invalid: ${repairedLoad.issues.map((issue) => issue.code).join(", ")}`);
  }

  const repairedRun = await runPromotionBenchmarkSystems({
    cwd,
    suitePath: repairedSuitePath,
    outDir: path.join(outDir, "repaired-run"),
    systems: [fullSystem as PromotionBenchmarkSystemName],
    trialId: input.repairedTrialId
  });
  const repairedPredictionsPath = path.resolve(cwd, repairedRun.predictions_path);
  const repairedSystemRunManifestPath = path.resolve(cwd, repairedRun.manifest_path);
  const repairExecutionManifest: PromotionRepairExecutionManifest = {
    schema_version: "1.0",
    protocol: PROMOTION_REPAIR_EXECUTION_PROTOCOL,
    study_id: sourceManifest.suite_id,
    backend: "builtin_node_adapter",
    allowed_input_boundary: ["case_artifact", "source_prediction"],
    prohibited_input_boundary: ["source_gold", "sibling_clean_artifact", "oracle_manifests"],
    source_suite_sha256: await sha256File(suitePath),
    source_predictions_sha256: await sha256File(originalPredictionsPath),
    source_system_run_manifest_sha256: await sha256File(originalSystemRunManifestPath),
    repaired_suite_sha256: await sha256File(repairedSuitePath),
    repaired_predictions_sha256: await sha256File(repairedPredictionsPath),
    repaired_system_run_manifest_sha256: await sha256File(repairedSystemRunManifestPath),
    generated_at: new Date().toISOString(),
    repair_attempt_count: attempts.length,
    successful_repair_count: attempts.filter((attempt) => attempt.status === "repaired").length,
    clean_control_count: attempts.filter((attempt) => attempt.pair_kind === "clean_control").length,
    attempts
  };
  parsePromotionRepairExecutionManifest(repairExecutionManifest);
  const repairExecutionManifestPath = path.join(outDir, "repair-execution-manifest.json");
  await writeJsonFile(repairExecutionManifestPath, repairExecutionManifest);

  const recoveryManifest: PromotionRecoveryManifest = {
    schema_version: "1.0",
    study_id: sourceManifest.suite_id,
    original_suite_path: relativeRef(outDir, suitePath),
    repaired_suite_path: relativeRef(outDir, repairedSuitePath),
    original_predictions_path: relativeRef(outDir, originalPredictionsPath),
    repaired_predictions_path: relativeRef(outDir, repairedPredictionsPath),
    original_system_run_manifest_path: relativeRef(outDir, originalSystemRunManifestPath),
    repaired_system_run_manifest_path: relativeRef(outDir, repairedSystemRunManifestPath),
    repair_execution_manifest_path: relativeRef(outDir, repairExecutionManifestPath),
    system_id: fullSystem,
    pairs
  };
  const recoveryManifestPath = path.join(outDir, "recovery-manifest.json");
  await writeJsonFile(recoveryManifestPath, recoveryManifest);
  const evaluated = await evaluatePromotionBenchmarkRecovery({
    cwd,
    manifestPath: recoveryManifestPath,
    outDir: path.join(outDir, "evaluation")
  });
  if (!evaluated.report.passed) {
    throw new Error(`Controlled node-owned recovery failed evaluation: ${evaluated.report.issues.map((issue) => issue.code).join(", ")}`);
  }
  return {
    recovery: evaluated.report,
    output_dir: portableRef(cwd, outDir),
    repaired_suite_path: portableRef(cwd, repairedSuitePath),
    repaired_predictions_path: portableRef(cwd, repairedPredictionsPath),
    repaired_system_run_manifest_path: portableRef(cwd, repairedSystemRunManifestPath),
    repair_execution_manifest_path: portableRef(cwd, repairExecutionManifestPath),
    recovery_manifest_path: portableRef(cwd, recoveryManifestPath),
    recovery_report_path: evaluated.report_path
  };
}

function requireRepairOwner(prediction: PromotionBenchmarkPrediction): PromotionArtifactRepairOwner {
  if (prediction.repair_owners.length !== 1) {
    throw new Error(`Controlled repair requires one prediction-declared owner: ${prediction.case_id}`);
  }
  const owner = prediction.repair_owners[0];
  if (owner !== "run_experiments" && owner !== "analyze_results" && owner !== "figure_audit") {
    throw new Error(`Controlled repair owner has no node adapter: ${String(owner)}`);
  }
  return owner;
}

function makeRepairedCaseId(sourceCaseId: string): string {
  assertPortableIdentifier(sourceCaseId, "Source case ID");
  const digest = sha256(sourceCaseId).slice(0, 12);
  return `${sourceCaseId.slice(0, 100)}-repaired-${digest}`;
}

async function resolveExistingInside(cwd: string, candidate: string, label: string): Promise<string> {
  const absolutePath = path.resolve(cwd, candidate);
  assertStrictlyInside(cwd, absolutePath, label);
  const realPath = await fs.realpath(absolutePath);
  assertStrictlyInside(cwd, realPath, label);
  if (!(await fs.stat(realPath)).isFile()) throw new Error(`${label} must be a file.`);
  return realPath;
}

async function assertFreshOutput(outDir: string): Promise<void> {
  try {
    await fs.lstat(outDir);
    throw new Error(`Controlled recovery output already exists: ${outDir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the workspace.`);
  }
}

function assertPortableIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new Error(`${label} must be a portable identifier.`);
  }
}

function relativeRef(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath).replace(/\\/gu, "/");
  if (!relative || path.isAbsolute(relative)) throw new Error("Recovery artifact reference is invalid.");
  return relative;
}

function portableRef(cwd: string, absolutePath: string): string {
  return path.relative(cwd, absolutePath).replace(/\\/gu, "/");
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
