import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  hashPromotionBenchmarkSuiteSnapshot,
  loadPromotionBenchmarkPredictions,
  loadPromotionBenchmarkSuite,
  type LoadedPromotionBenchmarkSuite,
  type PromotionBenchmarkCaseManifest,
  type PromotionBenchmarkPrediction
} from "./promotionBenchmark.js";
import { promotionVariantDefinitions } from "./promotionBenchmarkVariants.js";
import {
  PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION,
  verifyPromotionBenchmarkSystemRun,
  type PromotionBenchmarkSystemRunManifest
} from "./promotionBenchmarkSystems.js";

export type PromotionRecoveryPairKind = "fault_repair" | "clean_control";

export interface PromotionRecoveryPair {
  pair_kind: PromotionRecoveryPairKind;
  source_case_id: string;
  source_trial_id: string;
  repaired_case_id: string;
  repaired_trial_id: string;
  mutation_family?: string;
  declared_repair_owner?: string;
}

export interface PromotionRecoveryManifest {
  schema_version: "1.0";
  study_id: string;
  original_suite_path: string;
  repaired_suite_path: string;
  original_predictions_path: string;
  repaired_predictions_path: string;
  original_system_run_manifest_path: string;
  repaired_system_run_manifest_path: string;
  system_id: string;
  pairs: PromotionRecoveryPair[];
}

export interface PromotionRecoveryIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionRecoveryPairResult {
  pair_kind: PromotionRecoveryPairKind;
  source_case_id: string;
  repaired_case_id: string;
  base_bundle_id: string | null;
  mutation_family: string | null;
  source_decision: string | null;
  repaired_decision: string | null;
  source_artifact_sha256: string | null;
  repaired_artifact_sha256: string | null;
  recovered: boolean | null;
  regressed: boolean | null;
  valid: boolean;
}

export interface PromotionRecoveryReport {
  schema_version: "1.1";
  generated_at: string;
  study_id: string;
  system_id: string;
  passed: boolean;
  recovery_manifest_sha256: string;
  original_suite_id: string;
  repaired_suite_id: string;
  original_suite_sha256: string;
  repaired_suite_sha256: string;
  original_suite_snapshot_sha256: string;
  repaired_suite_snapshot_sha256: string;
  original_predictions_sha256: string;
  repaired_predictions_sha256: string;
  original_system_run_manifest_sha256: string;
  repaired_system_run_manifest_sha256: string;
  required_fault_families: string[];
  covered_fault_families: string[];
  missing_fault_families: string[];
  original_base_bundle_count: number;
  clean_control_base_bundle_count: number;
  original_fault_case_count: number;
  covered_fault_case_count: number;
  missing_fault_case_count: number;
  missing_fault_case_ids: string[];
  fault_repair_pair_count: number;
  successful_recovery_count: number;
  successful_recovery_rate: number | null;
  clean_control_pair_count: number;
  clean_control_regression_count: number;
  clean_control_regression_rate: number | null;
  issues: PromotionRecoveryIssue[];
  pairs: PromotionRecoveryPairResult[];
}

export interface EvaluatePromotionRecoveryInput {
  cwd: string;
  manifestPath: string;
  outDir: string;
}

export interface EvaluatePromotionRecoveryResult {
  report: PromotionRecoveryReport;
  output_dir: string;
  report_path: string;
  markdown_path: string;
}

export async function evaluatePromotionBenchmarkRecovery(
  input: EvaluatePromotionRecoveryInput
): Promise<EvaluatePromotionRecoveryResult> {
  const cwd = path.resolve(input.cwd);
  const manifestPath = await resolveExistingInside(
    cwd,
    path.resolve(cwd, input.manifestPath),
    "Recovery manifest"
  );
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Recovery output directory");
  await assertFreshOutput(outDir);

  const manifest = parseRecoveryManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  const manifestRoot = path.dirname(manifestPath);
  const originalSuitePath = await resolveArtifact(cwd, manifestRoot, manifest.original_suite_path, "Original suite");
  const repairedSuitePath = await resolveArtifact(cwd, manifestRoot, manifest.repaired_suite_path, "Repaired suite");
  const originalPredictionsPath = await resolveArtifact(
    cwd,
    manifestRoot,
    manifest.original_predictions_path,
    "Original predictions"
  );
  const repairedPredictionsPath = await resolveArtifact(
    cwd,
    manifestRoot,
    manifest.repaired_predictions_path,
    "Repaired predictions"
  );
  const originalSystemRunManifestPath = await resolveArtifact(
    cwd,
    manifestRoot,
    manifest.original_system_run_manifest_path,
    "Original system run manifest"
  );
  const repairedSystemRunManifestPath = await resolveArtifact(
    cwd,
    manifestRoot,
    manifest.repaired_system_run_manifest_path,
    "Repaired system run manifest"
  );
  const [originalSystemRun, repairedSystemRun] = await Promise.all([
    verifyPromotionBenchmarkSystemRun({
      cwd,
      manifestPath: originalSystemRunManifestPath,
      suitePath: originalSuitePath,
      predictionsPath: originalPredictionsPath
    }),
    verifyPromotionBenchmarkSystemRun({
      cwd,
      manifestPath: repairedSystemRunManifestPath,
      suitePath: repairedSuitePath,
      predictionsPath: repairedPredictionsPath
    })
  ]);

  const [originalLoaded, repairedLoaded, originalPredictionLoad, repairedPredictionLoad] = await Promise.all([
    loadPromotionBenchmarkSuite(originalSuitePath),
    loadPromotionBenchmarkSuite(repairedSuitePath),
    loadPromotionBenchmarkPredictions(originalPredictionsPath),
    loadPromotionBenchmarkPredictions(repairedPredictionsPath)
  ]);
  const issues: PromotionRecoveryIssue[] = [];
  appendLoadIssues(issues, originalLoaded.issues, "original");
  appendLoadIssues(issues, repairedLoaded.issues, "repaired");
  appendLoadIssues(issues, originalPredictionLoad.issues, "original");
  appendLoadIssues(issues, repairedPredictionLoad.issues, "repaired");
  inspectSuiteEligibility(originalLoaded.suite, "original", issues, true);
  inspectSuiteEligibility(repairedLoaded.suite, "repaired", issues, false);
  inspectSystemRunProtocol(originalSystemRun, manifest.system_id, "original", issues);
  inspectSystemRunProtocol(repairedSystemRun, manifest.system_id, "repaired", issues);
  if (originalLoaded.suite?.manifest.suite_id !== manifest.study_id) {
    issues.push({ code: "study_id_mismatch", message: "study_id must match the original suite_id." });
  }

  const originalCases = new Map(
    (originalLoaded.suite?.cases || []).map((item) => [item.case_id, item])
  );
  const repairedCases = new Map(
    (repairedLoaded.suite?.cases || []).map((item) => [item.case_id, item])
  );
  const originalPredictions = indexPredictions(
    originalPredictionLoad.predictions,
    manifest.system_id,
    "original",
    issues
  );
  const repairedPredictions = indexPredictions(
    repairedPredictionLoad.predictions,
    manifest.system_id,
    "repaired",
    issues
  );
  const seenSources = new Set<string>();
  const seenRepairs = new Set<string>();
  const pairs: PromotionRecoveryPairResult[] = [];

  for (const pair of manifest.pairs) {
    const sourceKey = predictionKey(pair.source_case_id, pair.source_trial_id);
    const repairedKey = predictionKey(pair.repaired_case_id, pair.repaired_trial_id);
    const issueCount = issues.length;
    if (seenSources.has(sourceKey)) {
      issues.push({ code: "duplicate_source_pair", message: "A source case/trial may appear once.", ref: sourceKey });
    }
    if (seenRepairs.has(repairedKey)) {
      issues.push({ code: "duplicate_repaired_pair", message: "A repaired case/trial may appear once.", ref: repairedKey });
    }
    seenSources.add(sourceKey);
    seenRepairs.add(repairedKey);
    const sourceCase = originalCases.get(pair.source_case_id);
    const repairedCase = repairedCases.get(pair.repaired_case_id);
    const sourcePrediction = originalPredictions.get(sourceKey);
    const repairedPrediction = repairedPredictions.get(repairedKey);
    if (!sourceCase) {
      issues.push({ code: "source_case_missing", message: "Source case is missing.", ref: pair.source_case_id });
    }
    if (!repairedCase) {
      issues.push({ code: "repaired_case_missing", message: "Repaired case is missing.", ref: pair.repaired_case_id });
    }
    if (!sourcePrediction) {
      issues.push({ code: "source_prediction_missing", message: "Source prediction is missing.", ref: sourceKey });
    }
    if (!repairedPrediction) {
      issues.push({ code: "repaired_prediction_missing", message: "Repaired prediction is missing.", ref: repairedKey });
    }
    inspectPair(pair, sourceCase, repairedCase, issues);
    pairs.push({
      pair_kind: pair.pair_kind,
      source_case_id: pair.source_case_id,
      repaired_case_id: pair.repaired_case_id,
      base_bundle_id: sourceCase?.base_bundle_id || null,
      mutation_family: pair.mutation_family || null,
      source_decision: sourcePrediction?.decision || null,
      repaired_decision: repairedPrediction?.decision || null,
      source_artifact_sha256: sourceCase?.artifact_sha256 || null,
      repaired_artifact_sha256: repairedCase?.artifact_sha256 || null,
      recovered: pair.pair_kind === "fault_repair" && sourcePrediction && repairedPrediction
        ? sourcePrediction.decision !== "promote" && repairedPrediction.decision === "promote"
        : null,
      regressed: pair.pair_kind === "clean_control" && sourcePrediction && repairedPrediction
        ? sourcePrediction.decision === "promote" && repairedPrediction.decision !== "promote"
        : null,
      valid: issues.length === issueCount
    });
  }

  const requiredFamilies = promotionVariantDefinitions()
    .flatMap((variant) => variant.mutation_family ? [variant.mutation_family] : []);
  const coveredFamilies = [...new Set(
    pairs
      .filter((pair) => pair.valid && pair.pair_kind === "fault_repair" && pair.mutation_family)
      .map((pair) => pair.mutation_family as string)
  )].sort();
  const missingFamilies = requiredFamilies.filter((family) => !coveredFamilies.includes(family));
  for (const family of missingFamilies) {
    issues.push({
      code: "fault_family_recovery_missing",
      message: "Every fault family requires at least one valid post-repair rerun.",
      ref: family
    });
  }

  const validFaultPairs = pairs.filter((pair) => pair.valid && pair.pair_kind === "fault_repair");
  const originalFaultCaseIds = new Set(
    (originalLoaded.suite?.cases || [])
      .filter((item) => item.mutation_family && item.gold.decision !== "promote")
      .map((item) => item.case_id)
  );
  const coveredFaultCaseIds = new Set(validFaultPairs.map((pair) => pair.source_case_id));
  const missingFaultCaseIds = [...originalFaultCaseIds]
    .filter((caseId) => !coveredFaultCaseIds.has(caseId))
    .sort();
  if (missingFaultCaseIds.length > 0) {
    issues.push({
      code: "fault_repair_rerun_coverage_incomplete",
      message: "Every original fault case requires one valid post-repair rerun.",
      ref: String(missingFaultCaseIds.length) + " missing"
    });
  }

  const originalBaseIds = new Set(
    (originalLoaded.suite?.cases || []).map((item) => item.base_bundle_id)
  );
  const controlBaseIds = new Set(
    pairs
      .filter((pair) => pair.valid && pair.pair_kind === "clean_control" && pair.base_bundle_id)
      .map((pair) => pair.base_bundle_id as string)
  );
  if (controlBaseIds.size !== originalBaseIds.size
      || [...originalBaseIds].some((baseId) => !controlBaseIds.has(baseId))) {
    issues.push({
      code: "clean_control_rerun_coverage_incomplete",
      message: "Regression measurement requires one clean-control rerun per original base bundle."
    });
  }

  const validControlPairs = pairs.filter((pair) => pair.valid && pair.pair_kind === "clean_control");
  const recoveredCount = validFaultPairs.filter((pair) => pair.recovered === true).length;
  const regressionCount = validControlPairs.filter((pair) => pair.regressed === true).length;
  const report: PromotionRecoveryReport = {
    schema_version: "1.1",
    generated_at: new Date().toISOString(),
    study_id: manifest.study_id,
    system_id: manifest.system_id,
    passed: issues.length === 0,
    recovery_manifest_sha256: await sha256File(manifestPath),
    original_suite_id: originalLoaded.suite?.manifest.suite_id || "<invalid-suite>",
    repaired_suite_id: repairedLoaded.suite?.manifest.suite_id || "<invalid-suite>",
    original_suite_sha256: await sha256File(originalSuitePath),
    repaired_suite_sha256: await sha256File(repairedSuitePath),
    original_suite_snapshot_sha256: await hashPromotionBenchmarkSuiteSnapshot(originalSuitePath),
    repaired_suite_snapshot_sha256: await hashPromotionBenchmarkSuiteSnapshot(repairedSuitePath),
    original_predictions_sha256: await sha256File(originalPredictionsPath),
    repaired_predictions_sha256: await sha256File(repairedPredictionsPath),
    original_system_run_manifest_sha256: await sha256File(originalSystemRunManifestPath),
    repaired_system_run_manifest_sha256: await sha256File(repairedSystemRunManifestPath),
    required_fault_families: requiredFamilies,
    covered_fault_families: coveredFamilies,
    missing_fault_families: missingFamilies,
    original_base_bundle_count: originalBaseIds.size,
    clean_control_base_bundle_count: controlBaseIds.size,
    original_fault_case_count: originalFaultCaseIds.size,
    covered_fault_case_count: coveredFaultCaseIds.size,
    missing_fault_case_count: missingFaultCaseIds.length,
    missing_fault_case_ids: missingFaultCaseIds,
    fault_repair_pair_count: validFaultPairs.length,
    successful_recovery_count: recoveredCount,
    successful_recovery_rate: ratioOrNull(recoveredCount, originalFaultCaseIds.size),
    clean_control_pair_count: validControlPairs.length,
    clean_control_regression_count: regressionCount,
    clean_control_regression_rate: ratioOrNull(regressionCount, validControlPairs.length),
    issues,
    pairs
  };

  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, "promotion-recovery-report.json");
  const markdownPath = path.join(outDir, "promotion-recovery-report.md");
  await writeJsonFile(reportPath, report);
  await fs.writeFile(markdownPath, renderMarkdown(report), "utf8");
  return {
    report,
    output_dir: portableRef(cwd, outDir),
    report_path: portableRef(cwd, reportPath),
    markdown_path: portableRef(cwd, markdownPath)
  };
}

function appendLoadIssues(
  target: PromotionRecoveryIssue[],
  source: Array<{ code: string; message: string; ref?: string }>,
  prefix: string
): void {
  target.push(...source.map((issue) => ({
    code: prefix + "_" + issue.code,
    message: issue.message,
    ...(issue.ref ? { ref: issue.ref } : {})
  })));
}

function inspectSuiteEligibility(
  suite: LoadedPromotionBenchmarkSuite | undefined,
  prefix: string,
  issues: PromotionRecoveryIssue[],
  requirePaperClaimEligibility: boolean
): void {
  if (!suite) return;
  if (suite.manifest.evidence_class !== "external_real_run") {
    issues.push({ code: prefix + "_external_real_run_required", message: "Recovery requires external real-run suites." });
  }
  if (requirePaperClaimEligibility && suite.manifest.paper_claim_eligible !== true) {
    issues.push({ code: prefix + "_paper_claim_eligibility_required", message: "Recovery requires paper-claim-eligible suites." });
  }
  if (suite.manifest.adjudication_status !== "double_adjudicated") {
    issues.push({ code: prefix + "_double_adjudication_required", message: "Recovery requires double-adjudicated suites." });
  }
  if (suite.manifest.execution_provenance_status !== "artifact_verified") {
    issues.push({ code: prefix + "_artifact_execution_required", message: "Recovery requires artifact-verified execution." });
  }
}

function inspectSystemRunProtocol(
  manifest: PromotionBenchmarkSystemRunManifest,
  systemId: string,
  prefix: string,
  issues: PromotionRecoveryIssue[]
): void {
  if (manifest.protocol_revision !== PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION) {
    issues.push({
      code: prefix + "_system_protocol_revision_mismatch",
      message: "Recovery predictions require the current deterministic system protocol revision."
    });
  }
  const system = manifest.systems.find((item) => item.system_id === systemId);
  if (!system || system.protocol !== "full_artifact_policy") {
    issues.push({
      code: prefix + "_full_policy_run_required",
      message: "Recovery predictions must come from a verified full artifact-policy run.",
      ref: systemId
    });
  }
}

function indexPredictions(
  predictions: PromotionBenchmarkPrediction[],
  systemId: string,
  prefix: string,
  issues: PromotionRecoveryIssue[]
): Map<string, PromotionBenchmarkPrediction> {
  const result = new Map<string, PromotionBenchmarkPrediction>();
  for (const prediction of predictions.filter((item) => item.system_id === systemId)) {
    const key = predictionKey(prediction.case_id, prediction.trial_id);
    if (result.has(key)) {
      issues.push({ code: prefix + "_prediction_duplicate", message: "Prediction case/trial tuples must be unique.", ref: key });
      continue;
    }
    result.set(key, prediction);
  }
  if (result.size === 0) {
    issues.push({ code: prefix + "_system_predictions_missing", message: "Recovery system has no predictions.", ref: systemId });
  }
  return result;
}

function inspectPair(
  pair: PromotionRecoveryPair,
  source: PromotionBenchmarkCaseManifest | undefined,
  repaired: PromotionBenchmarkCaseManifest | undefined,
  issues: PromotionRecoveryIssue[]
): void {
  if (!source || !repaired) return;
  const ref = pair.source_case_id + "->" + pair.repaired_case_id;
  if (source.base_bundle_id !== repaired.base_bundle_id) {
    issues.push({ code: "repair_base_bundle_mismatch", message: "Recovery pairs must preserve base_bundle_id.", ref });
  }
  if (!isSha256(source.artifact_sha256) || !isSha256(repaired.artifact_sha256)) {
    issues.push({ code: "repair_artifact_hash_missing", message: "Both cases require artifact_sha256.", ref });
  }
  if (!isSha256(source.source_sha256) || !isSha256(repaired.source_sha256)
      || source.source_sha256 !== repaired.source_sha256) {
    issues.push({ code: "repair_source_hash_mismatch", message: "Recovery pairs must preserve source_sha256.", ref });
  }
  if (repaired.mutation_family
      || repaired.gold.decision !== "promote"
      || repaired.gold.blocking_concerns.length > 0
      || repaired.gold.repair_owners.length > 0) {
    issues.push({ code: "repaired_case_not_clean", message: "Repaired cases require clean promotable gold.", ref });
  }
  if (pair.pair_kind === "fault_repair") {
    if (!pair.mutation_family || pair.mutation_family !== source.mutation_family) {
      issues.push({ code: "repair_mutation_family_mismatch", message: "Mapping must match source mutation_family.", ref });
    }
    if (!pair.declared_repair_owner || !source.gold.repair_owners.includes(pair.declared_repair_owner)) {
      issues.push({ code: "declared_repair_owner_mismatch", message: "Declared owner must match source gold.", ref });
    }
    if (source.gold.decision === "promote" || source.artifact_sha256 === repaired.artifact_sha256) {
      issues.push({ code: "fault_repair_not_materialized", message: "Fault repair must change a non-promotable artifact.", ref });
    }
  } else {
    if (pair.mutation_family || pair.declared_repair_owner || source.mutation_family
        || source.gold.decision !== "promote") {
      issues.push({ code: "clean_control_mapping_invalid", message: "Control mappings must remain clean and promotable.", ref });
    }
    if (source.artifact_sha256 !== repaired.artifact_sha256) {
      issues.push({ code: "clean_control_artifact_changed", message: "Control reruns must preserve the artifact hash.", ref });
    }
  }
}

function parseRecoveryManifest(value: unknown): PromotionRecoveryManifest {
  if (!isRecord(value)) throw new Error("Promotion recovery manifest must be an object.");
  const fields = [
    "schema_version",
    "study_id",
    "original_suite_path",
    "repaired_suite_path",
    "original_predictions_path",
    "repaired_predictions_path",
    "original_system_run_manifest_path",
    "repaired_system_run_manifest_path",
    "system_id",
    "pairs"
  ];
  assertExactKeys(value, fields, "recovery manifest");
  if (value.schema_version !== "1.0" || !portableIdentifier(value.study_id)
      || !nonEmptyString(value.original_suite_path) || !nonEmptyString(value.repaired_suite_path)
      || !nonEmptyString(value.original_predictions_path) || !nonEmptyString(value.repaired_predictions_path)
      || !nonEmptyString(value.original_system_run_manifest_path)
      || !nonEmptyString(value.repaired_system_run_manifest_path)
      || !portableIdentifier(value.system_id) || !Array.isArray(value.pairs) || value.pairs.length === 0) {
    throw new Error("Promotion recovery manifest has an invalid schema.");
  }
  return {
    schema_version: "1.0",
    study_id: value.study_id,
    original_suite_path: value.original_suite_path,
    repaired_suite_path: value.repaired_suite_path,
    original_predictions_path: value.original_predictions_path,
    repaired_predictions_path: value.repaired_predictions_path,
    original_system_run_manifest_path: value.original_system_run_manifest_path,
    repaired_system_run_manifest_path: value.repaired_system_run_manifest_path,
    system_id: value.system_id,
    pairs: value.pairs.map(parseRecoveryPair)
  };
}

function parseRecoveryPair(value: unknown, index: number): PromotionRecoveryPair {
  if (!isRecord(value)) throw new Error("Recovery pair " + (index + 1) + " must be an object.");
  const common = ["pair_kind", "source_case_id", "source_trial_id", "repaired_case_id", "repaired_trial_id"];
  const fields = value.pair_kind === "fault_repair"
    ? [...common, "mutation_family", "declared_repair_owner"]
    : common;
  assertExactKeys(value, fields, "recovery pair " + (index + 1));
  if ((value.pair_kind !== "fault_repair" && value.pair_kind !== "clean_control")
      || !portableIdentifier(value.source_case_id) || !portableIdentifier(value.source_trial_id)
      || !portableIdentifier(value.repaired_case_id) || !portableIdentifier(value.repaired_trial_id)) {
    throw new Error("Recovery pair " + (index + 1) + " has an invalid schema.");
  }
  if (value.pair_kind === "fault_repair"
      && (!portableIdentifier(value.mutation_family) || !portableIdentifier(value.declared_repair_owner))) {
    throw new Error("Fault-repair pair " + (index + 1) + " requires family and owner.");
  }
  return {
    pair_kind: value.pair_kind,
    source_case_id: value.source_case_id,
    source_trial_id: value.source_trial_id,
    repaired_case_id: value.repaired_case_id,
    repaired_trial_id: value.repaired_trial_id,
    ...(value.pair_kind === "fault_repair"
      ? { mutation_family: value.mutation_family as string, declared_repair_owner: value.declared_repair_owner as string }
      : {})
  };
}

function renderMarkdown(report: PromotionRecoveryReport): string {
  const lines = [
    "# Promotion Recovery Evaluation",
    "",
    "- Study: " + report.study_id,
    "- System: " + report.system_id,
    "- Validation: " + (report.passed ? "passed" : "failed"),
    "- Fault-family coverage: " + report.covered_fault_families.length + "/" + report.required_fault_families.length,
    "- Fault-case coverage: " + report.covered_fault_case_count + "/" + report.original_fault_case_count,
    "- Successful recovery: " + formatRate(report.successful_recovery_rate),
    "- Clean-control regression: " + formatRate(report.clean_control_regression_rate),
    "",
    "## Validation Issues",
    ""
  ];
  if (report.issues.length === 0) lines.push("- None.");
  else {
    lines.push(...report.issues.map((issue) =>
      "- " + issue.code + (issue.ref ? " [" + issue.ref + "]" : "") + ": " + issue.message));
  }
  return lines.concat("").join("\n");
}

function assertExactKeys(value: Record<string, unknown>, fields: string[], context: string): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !fields.includes(key)) || fields.some((key) => !keys.includes(key))) {
    throw new Error("Unexpected or missing fields in " + context + ".");
  }
}

async function resolveArtifact(cwd: string, root: string, ref: string, label: string): Promise<string> {
  return resolveExistingInside(cwd, path.resolve(root, ref), label);
}

async function resolveExistingInside(root: string, candidate: string, label: string): Promise<string> {
  assertStrictlyInside(root, candidate, label);
  const realPath = await fs.realpath(candidate);
  assertStrictlyInside(root, realPath, label);
  return realPath;
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(label + " must be inside the workspace.");
  }
}

async function assertFreshOutput(outDir: string): Promise<void> {
  try {
    await fs.lstat(outDir);
    throw new Error("Promotion recovery output already exists: " + outDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function predictionKey(caseId: string, trialId: string): string {
  return caseId + "\u0000" + trialId;
}

function ratioOrNull(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function formatRate(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : "<external-output>";
}

function sha256File(filePath: string): Promise<string> {
  return fs.readFile(filePath).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function portableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
