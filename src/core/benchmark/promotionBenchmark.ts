import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

import { writeJsonFile } from "../../utils/fs.js";
import {
  inspectPromotionSourceDiversity,
  isPromotionSourceDiversityStatus,
  isSha256,
  type PromotionBenchmarkSourceDiversityStatus
} from "./promotionBenchmarkSourceDiversity.js";
import { PROMOTION_CONFIRMATORY_INTERVAL_TAIL_PROBABILITY } from "./promotionBenchmarkConfirmatoryContract.js";

export const PROMOTION_DECISIONS = ["promote", "needs_review", "downgrade", "block"] as const;

export type PromotionDecision = typeof PROMOTION_DECISIONS[number];
export type PromotionBenchmarkSplit = "development" | "test";
export type PromotionBenchmarkEvidenceClass = "synthetic_development" | "human_adjudicated_test" | "external_real_run";
export type PromotionBenchmarkAdjudicationStatus = "unreviewed" | "single_annotator" | "double_adjudicated";
export type PromotionBenchmarkMutationIsolationStatus = "unreviewed" | "double_verified";
export type PromotionBenchmarkExecutionProvenanceStatus = "unverified" | "artifact_verified";

export interface PromotionBenchmarkAdjudicationProvenance {
  schema_version: "1.0";
  method: "independent_double_adjudication";
  source_suite_snapshot_sha256: string;
  private_annotation_map_ref: string;
  private_annotation_map_sha256: string;
  initial_annotation_refs: [string, string];
  initial_annotation_sha256: [string, string];
  resolution_ref: string | null;
  resolution_sha256: string | null;
  mutation_audit_report_ref: string | null;
  mutation_audit_report_sha256: string | null;
  adjudicated_labels_ref: string;
  adjudicated_labels_sha256: string;
  case_count: number;
}

export interface PromotionBenchmarkSuiteManifest {
  schema_version: "1.0";
  suite_id: string;
  evidence_class?: PromotionBenchmarkEvidenceClass;
  paper_claim_eligible?: boolean;
  adjudication_status?: PromotionBenchmarkAdjudicationStatus;
  mutation_isolation_status?: PromotionBenchmarkMutationIsolationStatus;
  execution_provenance_status?: PromotionBenchmarkExecutionProvenanceStatus;
  source_diversity_status?: PromotionBenchmarkSourceDiversityStatus;
  adjudication_provenance?: PromotionBenchmarkAdjudicationProvenance;
  cases: string[];
}

export interface PromotionBenchmarkCaseManifest {
  schema_version: "1.0";
  case_id: string;
  base_bundle_id: string;
  split: PromotionBenchmarkSplit;
  artifact_root: string;
  source_sha256?: string;
  source_family_id_sha256?: string;
  operator_group_id_sha256?: string;
  artifact_sha256?: string;
  mutation_manifest?: string;
  mutation_family?: string;
  gold: {
    decision: PromotionDecision;
    blocking_concerns: string[];
    repair_owners: string[];
  };
}

export interface PromotionBenchmarkConcernPrediction {
  code: string;
  severity: "blocking" | "warning";
  evidence_refs?: string[];
}

export interface PromotionBenchmarkPrediction {
  case_id: string;
  system_id: string;
  trial_id: string;
  decision: PromotionDecision;
  concerns: PromotionBenchmarkConcernPrediction[];
  repair_owners: string[];
  latency_ms?: number;
  cost_usd?: number;
}

export interface PromotionBenchmarkValidationIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface LoadedPromotionBenchmarkSuite {
  suite_path: string;
  suite_root: string;
  manifest: PromotionBenchmarkSuiteManifest;
  cases: PromotionBenchmarkCaseManifest[];
  case_artifact_roots: Record<string, string>;
}

export interface PromotionBenchmarkSystemMetrics {
  system_id: string;
  trial_count: number;
  prediction_count: number;
  covered_case_count: number;
  expected_case_count: number;
  coverage_rate: number;
  exact_decision_accuracy: number;
  macro_decision_f1: number;
  false_paper_ready_count: number;
  false_paper_ready_rate: number | null;
  false_paper_ready_cluster_bootstrap_95_ci: [number, number] | null;
  concern_acceptance_conflict_count: number;
  concern_acceptance_conflict_rate: number | null;
  concern_acceptance_conflict_cluster_bootstrap_95_ci: [number, number] | null;
  clean_case_count: number;
  clean_case_promotion_accuracy: number | null;
  clean_case_promotion_accuracy_cluster_bootstrap_95_ci: [number, number] | null;
  blocker_precision: number | null;
  blocker_recall: number | null;
  blocker_f1: number | null;
  repair_owner_exact_match_accuracy: number | null;
  repair_owner_exact_match_accuracy_cluster_bootstrap_95_ci: [number, number] | null;
  trace_coverage: number | null;
  mean_latency_ms: number | null;
  total_cost_usd: number | null;
  decision_confusion: Record<PromotionDecision, Record<PromotionDecision, number>>;
  by_mutation_family: PromotionBenchmarkMutationFamilyMetrics[];
}

export interface PromotionBenchmarkPairedComparison {
  system_a: string;
  system_b: string;
  common_case_count: number;
  common_base_bundle_count: number;
  decision_accuracy_delta: number;
  decision_accuracy_cluster_bootstrap_95_ci: [number, number] | null;
  decision_accuracy_exact_paired_sign_test_p: number | null;
  false_paper_ready_common_case_count: number;
  false_paper_ready_rate_delta: number | null;
  false_paper_ready_cluster_bootstrap_95_ci: [number, number] | null;
  false_paper_ready_exact_paired_sign_test_p: number | null;
  repair_owner_common_case_count: number;
  repair_owner_exact_match_accuracy_delta: number | null;
  repair_owner_cluster_bootstrap_95_ci: [number, number] | null;
  repair_owner_exact_paired_sign_test_p: number | null;
}

export interface PromotionBenchmarkMutationFamilyMetrics {
  mutation_family: string;
  case_count: number;
  prediction_count: number;
  exact_decision_accuracy: number;
  false_paper_ready_rate: number | null;
  blocker_recall: number | null;
  repair_owner_exact_match_accuracy: number | null;
}

export interface PromotionBenchmarkSourceFamilyMetrics {
  source_family_id_sha256: string;
  base_bundle_count: number;
  case_count: number;
  systems: PromotionBenchmarkSystemMetrics[];
}

export interface PromotionBenchmarkLeaveOneFamilyOutAnalysis {
  omitted_source_family_id_sha256: string;
  remaining_base_bundle_count: number;
  remaining_case_count: number;
  comparisons: PromotionBenchmarkPairedComparison[];
}

export interface PromotionBenchmarkSourceFamilyAnalysis {
  availability: "complete" | "unavailable";
  unavailable_reason: "source_family_assignment_incomplete" | null;
  family_count: number;
  families: PromotionBenchmarkSourceFamilyMetrics[];
  leave_one_family_out: PromotionBenchmarkLeaveOneFamilyOutAnalysis[];
}

export interface PromotionBenchmarkScoreReport {
  schema_version: "1.0";
  generated_at: string;
  suite_id: string;
  evidence_class: PromotionBenchmarkEvidenceClass | "unspecified";
  paper_claim_eligible: boolean;
  adjudication_status: PromotionBenchmarkAdjudicationStatus | "unspecified";
  mutation_isolation_status: PromotionBenchmarkMutationIsolationStatus | "unspecified";
  execution_provenance_status: PromotionBenchmarkExecutionProvenanceStatus | "unspecified";
  source_diversity_status: PromotionBenchmarkSourceDiversityStatus | "unspecified";
  suite_ref: string;
  prediction_ref: string;
  passed: boolean;
  validation_issues: PromotionBenchmarkValidationIssue[];
  case_count: number;
  prediction_count: number;
  systems: PromotionBenchmarkSystemMetrics[];
  source_family_analysis: PromotionBenchmarkSourceFamilyAnalysis;
  paired_analysis: {
    inference_unit: "base_bundle_id";
    bootstrap_replicates: number;
    exploratory_only: boolean;
    comparisons: PromotionBenchmarkPairedComparison[];
  };
}

export interface ScorePromotionBenchmarkInput {
  cwd: string;
  suitePath: string;
  predictionsPath: string;
  outDir?: string;
}

export interface LoadedPromotionBenchmarkPredictions {
  predictions: PromotionBenchmarkPrediction[];
  issues: PromotionBenchmarkValidationIssue[];
}

const CLUSTER_BOOTSTRAP_REPLICATES = 5_000;

export async function loadPromotionBenchmarkSuite(
  suitePath: string
): Promise<{ suite?: LoadedPromotionBenchmarkSuite; issues: PromotionBenchmarkValidationIssue[] }> {
  const absoluteSuitePath = path.resolve(suitePath);
  const suiteRoot = path.dirname(absoluteSuitePath);
  const issues: PromotionBenchmarkValidationIssue[] = [];
  const manifest = parseSuiteManifest(await readJson(absoluteSuitePath, issues, "suite_manifest_unreadable"), issues);
  if (!manifest) return { issues };

  const cases: PromotionBenchmarkCaseManifest[] = [];
  const caseArtifactRoots: Record<string, string> = {};
  const seenCaseIds = new Set<string>();
  for (const caseRef of manifest.cases) {
    const casePath = resolveContainedPath(suiteRoot, caseRef);
    if (!casePath) {
      issues.push({ code: "case_path_outside_suite", message: "Case manifest must stay inside the suite root.", ref: caseRef });
      continue;
    }
    const benchmarkCase = parseCaseManifest(
      await readJson(casePath, issues, "case_manifest_unreadable", caseRef),
      caseRef,
      issues
    );
    if (!benchmarkCase) continue;
    if (seenCaseIds.has(benchmarkCase.case_id)) {
      issues.push({ code: "duplicate_case_id", message: `Duplicate case id: ${benchmarkCase.case_id}.`, ref: caseRef });
      continue;
    }
    seenCaseIds.add(benchmarkCase.case_id);
    const artifactRoot = path.resolve(path.dirname(casePath), benchmarkCase.artifact_root);
    if (!isContainedPath(suiteRoot, artifactRoot) || !(await directoryExists(artifactRoot))) {
      issues.push({
        code: "artifact_root_missing_or_outside_suite",
        message: "Case artifact_root must resolve to an existing directory inside the suite root.",
        ref: caseRef
      });
      continue;
    }
    if (benchmarkCase.mutation_manifest) {
      const mutationManifestPath = path.resolve(path.dirname(casePath), benchmarkCase.mutation_manifest);
      if (!isContainedPath(suiteRoot, mutationManifestPath) || !(await fileExists(mutationManifestPath))) {
        issues.push({
          code: "mutation_manifest_missing_or_outside_suite",
          message: "Case mutation_manifest must resolve to an existing file inside the suite root.",
          ref: caseRef
        });
        continue;
      }
    }
    if (benchmarkCase.artifact_sha256) {
      const actualHash = await hashPromotionArtifactTree(artifactRoot);
      if (actualHash !== benchmarkCase.artifact_sha256) {
        issues.push({
          code: "artifact_hash_mismatch",
          message: `Artifact hash mismatch for case ${benchmarkCase.case_id}.`,
          ref: caseRef
        });
        continue;
      }
    }
    caseArtifactRoots[benchmarkCase.case_id] = artifactRoot;
    cases.push(benchmarkCase);
  }

  const splitByBase = new Map<string, PromotionBenchmarkSplit>();
  const splitBySourceHash = new Map<string, PromotionBenchmarkSplit>();
  for (const benchmarkCase of cases) {
    const prior = splitByBase.get(benchmarkCase.base_bundle_id);
    if (prior && prior !== benchmarkCase.split) {
      issues.push({
        code: "base_bundle_split_leakage",
        message: `Base bundle ${benchmarkCase.base_bundle_id} appears in both development and test splits.`,
        ref: benchmarkCase.case_id
      });
    } else {
      splitByBase.set(benchmarkCase.base_bundle_id, benchmarkCase.split);
    }
    if (benchmarkCase.source_sha256) {
      const priorHashSplit = splitBySourceHash.get(benchmarkCase.source_sha256);
      if (priorHashSplit && priorHashSplit !== benchmarkCase.split) {
        issues.push({
          code: "source_bundle_split_leakage",
          message: "Identical source bundle content appears in both development and test splits.",
          ref: benchmarkCase.case_id
        });
      } else {
        splitBySourceHash.set(benchmarkCase.source_sha256, benchmarkCase.split);
      }
    }
  }
  if (manifest.adjudication_provenance) {
    await validateAdjudicationEvidence(suiteRoot, manifest.adjudication_provenance, cases, issues);
  }
  if (manifest.source_diversity_status === "declared_stratified") {
    issues.push(...inspectPromotionSourceDiversity(cases).issues);
  }
  return {
    suite: {
      suite_path: absoluteSuitePath,
      suite_root: suiteRoot,
      manifest,
      cases,
      case_artifact_roots: caseArtifactRoots
    },
    issues
  };
}

export async function scorePromotionBenchmarkFromFiles(
  input: ScorePromotionBenchmarkInput
): Promise<{ report: PromotionBenchmarkScoreReport; output_path: string; report_path: string }> {
  const cwd = path.resolve(input.cwd);
  const suitePath = path.resolve(cwd, input.suitePath);
  const predictionsPath = path.resolve(cwd, input.predictionsPath);
  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  const loadedPredictions = await loadPromotionBenchmarkPredictions(predictionsPath);
  const predictions = loadedPredictions.predictions;
  const issues = [...loaded.issues, ...loadedPredictions.issues];
  const cases = loaded.suite?.cases || [];
  const caseById = new Map(cases.map((benchmarkCase) => [benchmarkCase.case_id, benchmarkCase] as const));
  const seen = new Set<string>();
  const validPredictions: PromotionBenchmarkPrediction[] = [];

  for (const prediction of predictions) {
    if (!caseById.has(prediction.case_id)) {
      issues.push({ code: "prediction_case_unknown", message: `Unknown case: ${prediction.case_id}.`, ref: prediction.case_id });
      continue;
    }
    const key = `${prediction.system_id}\u0000${prediction.trial_id}\u0000${prediction.case_id}`;
    if (seen.has(key)) {
      issues.push({ code: "duplicate_prediction", message: "System, trial, and case tuples must be unique.", ref: prediction.case_id });
      continue;
    }
    seen.add(key);
    validPredictions.push(prediction);
  }

  const systems = [...groupBy(validPredictions, (prediction) => prediction.system_id).entries()]
    .map(([systemId, rows]) => scoreSystem(systemId, rows, cases))
    .sort((left, right) => left.system_id.localeCompare(right.system_id));
  for (const system of systems) {
    if (system.coverage_rate < 1) {
      issues.push({
        code: "system_case_coverage_incomplete",
        message: `System ${system.system_id} covers ${system.covered_case_count}/${system.expected_case_count} cases.`,
        ref: system.system_id
      });
    }
  }
  for (const [systemId, systemRows] of groupBy(validPredictions, (prediction) => prediction.system_id)) {
    for (const [trialId, trialRows] of groupBy(systemRows, (prediction) => prediction.trial_id)) {
      const coveredCases = new Set(trialRows.map((prediction) => prediction.case_id)).size;
      if (coveredCases !== cases.length) {
        issues.push({
          code: "system_trial_case_coverage_incomplete",
          message: `System ${systemId}, trial ${trialId} covers ${coveredCases}/${cases.length} cases.`,
          ref: `${systemId}:${trialId}`
        });
      }
    }
  }
  if (systems.length === 0) issues.push({ code: "no_scored_systems", message: "No valid predictions were available." });

  const pairedComparisons = scorePairedComparisons(validPredictions, cases, loaded.suite?.manifest.suite_id || "invalid-suite");
  const sourceFamilyAnalysis = scoreSourceFamilyAnalysis(
    validPredictions,
    cases,
    loaded.suite?.manifest.suite_id || "invalid-suite"
  );

  const report: PromotionBenchmarkScoreReport = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    suite_id: loaded.suite?.manifest.suite_id || "<invalid-suite>",
    evidence_class: loaded.suite?.manifest.evidence_class || "unspecified",
    paper_claim_eligible: loaded.suite?.manifest.paper_claim_eligible === true,
    adjudication_status: loaded.suite?.manifest.adjudication_status || "unspecified",
    mutation_isolation_status: loaded.suite?.manifest.mutation_isolation_status || "unspecified",
    execution_provenance_status: loaded.suite?.manifest.execution_provenance_status || "unspecified",
    source_diversity_status: loaded.suite?.manifest.source_diversity_status || "unspecified",
    suite_ref: portableRef(cwd, suitePath, "<external-suite>"),
    prediction_ref: portableRef(cwd, predictionsPath, "<external-predictions>"),
    passed: issues.length === 0,
    validation_issues: issues,
    case_count: cases.length,
    prediction_count: validPredictions.length,
    systems,
    source_family_analysis: sourceFamilyAnalysis,
    paired_analysis: {
      inference_unit: "base_bundle_id",
      bootstrap_replicates: CLUSTER_BOOTSTRAP_REPLICATES,
      exploratory_only: loaded.suite?.manifest.paper_claim_eligible !== true,
      comparisons: pairedComparisons
    }
  };
  const outDir = path.resolve(cwd, input.outDir || path.join("outputs", "governance-benchmark", "promotion-score"));
  await fs.mkdir(outDir, { recursive: true });
  const outputPath = path.join(outDir, "promotion-score.json");
  const reportPath = path.join(outDir, "promotion-score.md");
  await writeJsonFile(outputPath, report);
  await fs.writeFile(reportPath, renderPromotionScoreMarkdown(report), "utf8");
  return {
    report,
    output_path: portableRef(cwd, outputPath, "<output>/promotion-score.json"),
    report_path: portableRef(cwd, reportPath, "<output>/promotion-score.md")
  };
}

export async function loadPromotionBenchmarkPredictions(
  predictionsPath: string
): Promise<LoadedPromotionBenchmarkPredictions> {
  const issues: PromotionBenchmarkValidationIssue[] = [];
  const predictions = await readPredictions(path.resolve(predictionsPath), issues);
  return { predictions, issues };
}

function scoreSystem(
  systemId: string,
  predictions: PromotionBenchmarkPrediction[],
  cases: PromotionBenchmarkCaseManifest[]
): PromotionBenchmarkSystemMetrics {
  const caseById = new Map(cases.map((benchmarkCase) => [benchmarkCase.case_id, benchmarkCase] as const));
  const confusion = emptyConfusion();
  let exact = 0;
  let falsePromotions = 0;
  let nonPromotable = 0;
  let conflicts = 0;
  let withBlockingConcern = 0;
  let clean = 0;
  let cleanPromotions = 0;
  let blockerTp = 0;
  let blockerFp = 0;
  let blockerFn = 0;
  let repairCases = 0;
  let repairExact = 0;
  let concernCount = 0;
  let tracedConcernCount = 0;
  const latencies: number[] = [];
  const costs: number[] = [];

  for (const prediction of predictions) {
    const benchmarkCase = caseById.get(prediction.case_id);
    if (!benchmarkCase) continue;
    confusion[benchmarkCase.gold.decision][prediction.decision] += 1;
    if (prediction.decision === benchmarkCase.gold.decision) exact += 1;
    if (benchmarkCase.gold.decision === "promote") {
      clean += 1;
      if (prediction.decision === "promote") cleanPromotions += 1;
    } else {
      nonPromotable += 1;
      if (prediction.decision === "promote") falsePromotions += 1;
    }

    const blocking = prediction.concerns.filter((concern) => concern.severity === "blocking");
    if (blocking.length > 0) {
      withBlockingConcern += 1;
      if (prediction.decision === "promote") conflicts += 1;
    }
    const expectedBlockers = new Set(benchmarkCase.gold.blocking_concerns);
    const predictedBlockers = new Set(blocking.map((concern) => concern.code));
    for (const code of predictedBlockers) expectedBlockers.has(code) ? blockerTp += 1 : blockerFp += 1;
    for (const code of expectedBlockers) if (!predictedBlockers.has(code)) blockerFn += 1;

    if (benchmarkCase.gold.repair_owners.length > 0) {
      repairCases += 1;
      if (setsEqual(new Set(benchmarkCase.gold.repair_owners), new Set(prediction.repair_owners))) repairExact += 1;
    }
    concernCount += prediction.concerns.length;
    tracedConcernCount += prediction.concerns.filter((concern) => (concern.evidence_refs?.length || 0) > 0).length;
    if (isNonNegativeFinite(prediction.latency_ms)) latencies.push(prediction.latency_ms);
    if (isNonNegativeFinite(prediction.cost_usd)) costs.push(prediction.cost_usd);
  }

  const precision = ratioOrNull(blockerTp, blockerTp + blockerFp);
  const recall = ratioOrNull(blockerTp, blockerTp + blockerFn);
  const coveredCases = new Set(predictions.map((prediction) => prediction.case_id)).size;
  const intervalFor = (metric: PromotionBenchmarkBinaryMetric): [number, number] | null =>
    clusteredMeanInterval(
      metricObservationRows(predictions, cases, metric),
      systemId + "\u0000" + metric + "\u0000" + cases.map((item) => item.case_id).join("\u0000")
    );
  return {
    system_id: systemId,
    trial_count: new Set(predictions.map((prediction) => prediction.trial_id)).size,
    prediction_count: predictions.length,
    covered_case_count: coveredCases,
    expected_case_count: cases.length,
    coverage_rate: cases.length > 0 ? coveredCases / cases.length : 0,
    exact_decision_accuracy: predictions.length > 0 ? exact / predictions.length : 0,
    macro_decision_f1: macroF1(confusion),
    false_paper_ready_count: falsePromotions,
    false_paper_ready_rate: ratioOrNull(falsePromotions, nonPromotable),
    false_paper_ready_cluster_bootstrap_95_ci: intervalFor("false_paper_ready"),
    concern_acceptance_conflict_count: conflicts,
    concern_acceptance_conflict_rate: ratioOrNull(conflicts, withBlockingConcern),
    concern_acceptance_conflict_cluster_bootstrap_95_ci: intervalFor("concern_acceptance_conflict"),
    clean_case_count: clean,
    clean_case_promotion_accuracy: ratioOrNull(cleanPromotions, clean),
    clean_case_promotion_accuracy_cluster_bootstrap_95_ci: intervalFor("clean_case_promotion"),
    blocker_precision: precision,
    blocker_recall: recall,
    blocker_f1: harmonicMean(precision, recall),
    repair_owner_exact_match_accuracy: ratioOrNull(repairExact, repairCases),
    repair_owner_exact_match_accuracy_cluster_bootstrap_95_ci: intervalFor("repair_owner_exact_match"),
    trace_coverage: ratioOrNull(tracedConcernCount, concernCount),
    mean_latency_ms: meanOrNull(latencies),
    total_cost_usd: costs.length > 0 ? costs.reduce((sum, value) => sum + value, 0) : null,
    decision_confusion: confusion,
    by_mutation_family: scoreMutationFamilies(predictions, cases)
  };
}

function scoreMutationFamilies(
  predictions: PromotionBenchmarkPrediction[],
  cases: PromotionBenchmarkCaseManifest[]
): PromotionBenchmarkMutationFamilyMetrics[] {
  const caseById = new Map(cases.map((benchmarkCase) => [benchmarkCase.case_id, benchmarkCase] as const));
  const grouped = groupBy(predictions, (prediction) => caseById.get(prediction.case_id)?.mutation_family || "clean_control");
  return [...grouped.entries()].map(([mutationFamily, rows]) => {
    let exact = 0;
    let falsePromotions = 0;
    let nonPromotable = 0;
    let blockerTp = 0;
    let blockerFn = 0;
    let repairCases = 0;
    let repairExact = 0;
    for (const prediction of rows) {
      const benchmarkCase = caseById.get(prediction.case_id);
      if (!benchmarkCase) continue;
      if (prediction.decision === benchmarkCase.gold.decision) exact += 1;
      if (benchmarkCase.gold.decision !== "promote") {
        nonPromotable += 1;
        if (prediction.decision === "promote") falsePromotions += 1;
      }
      const expected = new Set(benchmarkCase.gold.blocking_concerns);
      const predicted = new Set(
        prediction.concerns.filter((concern) => concern.severity === "blocking").map((concern) => concern.code)
      );
      for (const code of expected) predicted.has(code) ? blockerTp += 1 : blockerFn += 1;
      if (benchmarkCase.gold.repair_owners.length > 0) {
        repairCases += 1;
        if (setsEqual(new Set(benchmarkCase.gold.repair_owners), new Set(prediction.repair_owners))) repairExact += 1;
      }
    }
    return {
      mutation_family: mutationFamily,
      case_count: new Set(rows.map((row) => row.case_id)).size,
      prediction_count: rows.length,
      exact_decision_accuracy: rows.length > 0 ? exact / rows.length : 0,
      false_paper_ready_rate: ratioOrNull(falsePromotions, nonPromotable),
      blocker_recall: ratioOrNull(blockerTp, blockerTp + blockerFn),
      repair_owner_exact_match_accuracy: ratioOrNull(repairExact, repairCases)
    };
  }).sort((left, right) => left.mutation_family.localeCompare(right.mutation_family));
}

function scorePairedComparisons(
  predictions: PromotionBenchmarkPrediction[],
  cases: PromotionBenchmarkCaseManifest[],
  suiteId: string
): PromotionBenchmarkPairedComparison[] {
  const rowsBySystem = groupBy(predictions, (prediction) => prediction.system_id);
  const systemIds = [...rowsBySystem.keys()].sort();
  const comparisons: PromotionBenchmarkPairedComparison[] = [];
  for (let leftIndex = 0; leftIndex < systemIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < systemIds.length; rightIndex += 1) {
      const systemA = systemIds[leftIndex];
      const systemB = systemIds[rightIndex];
      const decisionA = aggregateCaseMetric(rowsBySystem.get(systemA) || [], cases, "decision_accuracy");
      const decisionB = aggregateCaseMetric(rowsBySystem.get(systemB) || [], cases, "decision_accuracy");
      const decisionDiffs = pairedCaseDifferences(decisionA, decisionB, cases);
      const falsePromotionA = aggregateCaseMetric(rowsBySystem.get(systemA) || [], cases, "false_paper_ready");
      const falsePromotionB = aggregateCaseMetric(rowsBySystem.get(systemB) || [], cases, "false_paper_ready");
      const falsePromotionDiffs = pairedCaseDifferences(falsePromotionA, falsePromotionB, cases);
      const repairOwnerA = aggregateCaseMetric(rowsBySystem.get(systemA) || [], cases, "repair_owner_exact_match");
      const repairOwnerB = aggregateCaseMetric(rowsBySystem.get(systemB) || [], cases, "repair_owner_exact_match");
      const repairOwnerDiffs = pairedCaseDifferences(repairOwnerA, repairOwnerB, cases);
      const decisionStats = clusteredDifferenceStats(decisionDiffs, `${suiteId}\u0000${systemA}\u0000${systemB}\u0000decision`);
      const falsePromotionStats = clusteredDifferenceStats(
        falsePromotionDiffs,
        `${suiteId}\u0000${systemA}\u0000${systemB}\u0000false-promotion`
      );
      const repairOwnerStats = clusteredDifferenceStats(
        repairOwnerDiffs,
        suiteId + "\u0000" + systemA + "\u0000" + systemB + "\u0000repair-owner"
      );
      comparisons.push({
        system_a: systemA,
        system_b: systemB,
        common_case_count: decisionDiffs.length,
        common_base_bundle_count: new Set(decisionDiffs.map((row) => row.base_bundle_id)).size,
        decision_accuracy_delta: decisionStats.delta ?? 0,
        decision_accuracy_cluster_bootstrap_95_ci: decisionStats.ci,
        decision_accuracy_exact_paired_sign_test_p: decisionStats.p,
        false_paper_ready_common_case_count: falsePromotionDiffs.length,
        false_paper_ready_rate_delta: falsePromotionStats.delta,
        false_paper_ready_cluster_bootstrap_95_ci: falsePromotionStats.ci,
        false_paper_ready_exact_paired_sign_test_p: falsePromotionStats.p,
        repair_owner_common_case_count: repairOwnerDiffs.length,
        repair_owner_exact_match_accuracy_delta: repairOwnerStats.delta,
        repair_owner_cluster_bootstrap_95_ci: repairOwnerStats.ci,
        repair_owner_exact_paired_sign_test_p: repairOwnerStats.p
      });
    }
  }
  return comparisons;
}

function scoreSourceFamilyAnalysis(
  predictions: PromotionBenchmarkPrediction[],
  cases: PromotionBenchmarkCaseManifest[],
  suiteId: string
): PromotionBenchmarkSourceFamilyAnalysis {
  if (cases.length === 0) {
    return unavailableSourceFamilyAnalysis();
  }
  const familyByBase = new Map<string, string>();
  for (const benchmarkCase of cases) {
    if (!benchmarkCase.source_family_id_sha256) {
      return unavailableSourceFamilyAnalysis();
    }
    const observed = familyByBase.get(benchmarkCase.base_bundle_id);
    if (observed && observed !== benchmarkCase.source_family_id_sha256) {
      return unavailableSourceFamilyAnalysis();
    }
    familyByBase.set(benchmarkCase.base_bundle_id, benchmarkCase.source_family_id_sha256);
  }

  const casesByFamily = groupBy(cases, (benchmarkCase) =>
    benchmarkCase.source_family_id_sha256 as string);
  const systemIds = [...new Set(predictions.map((prediction) => prediction.system_id))].sort();
  const families = [...casesByFamily.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([familyId, familyCases]) => {
      const caseIds = new Set(familyCases.map((benchmarkCase) => benchmarkCase.case_id));
      const familyPredictions = predictions.filter((prediction) => caseIds.has(prediction.case_id));
      return {
        source_family_id_sha256: familyId,
        base_bundle_count: new Set(familyCases.map((benchmarkCase) => benchmarkCase.base_bundle_id)).size,
        case_count: familyCases.length,
        systems: systemIds.map((systemId) => scoreSystem(
          systemId,
          familyPredictions.filter((prediction) => prediction.system_id === systemId),
          familyCases
        ))
      };
    });
  const leaveOneFamilyOut = families.map((family) => {
    const remainingCases = cases.filter((benchmarkCase) =>
      benchmarkCase.source_family_id_sha256 !== family.source_family_id_sha256);
    const remainingCaseIds = new Set(remainingCases.map((benchmarkCase) => benchmarkCase.case_id));
    const remainingPredictions = predictions.filter((prediction) => remainingCaseIds.has(prediction.case_id));
    return {
      omitted_source_family_id_sha256: family.source_family_id_sha256,
      remaining_base_bundle_count: new Set(remainingCases.map((benchmarkCase) => benchmarkCase.base_bundle_id)).size,
      remaining_case_count: remainingCases.length,
      comparisons: scorePairedComparisons(
        remainingPredictions,
        remainingCases,
        `${suiteId}\u0000leave-one-family-out\u0000${family.source_family_id_sha256}`
      )
    };
  });
  return {
    availability: "complete",
    unavailable_reason: null,
    family_count: families.length,
    families,
    leave_one_family_out: leaveOneFamilyOut
  };
}

function unavailableSourceFamilyAnalysis(): PromotionBenchmarkSourceFamilyAnalysis {
  return {
    availability: "unavailable",
    unavailable_reason: "source_family_assignment_incomplete",
    family_count: 0,
    families: [],
    leave_one_family_out: []
  };
}

type PromotionBenchmarkBinaryMetric =
  | "decision_accuracy"
  | "false_paper_ready"
  | "concern_acceptance_conflict"
  | "clean_case_promotion"
  | "repair_owner_exact_match";

function aggregateCaseMetric(
  predictions: PromotionBenchmarkPrediction[],
  cases: PromotionBenchmarkCaseManifest[],
  metric: PromotionBenchmarkBinaryMetric
): Map<string, number> {
  const caseById = new Map(cases.map((benchmarkCase) => [benchmarkCase.case_id, benchmarkCase] as const));
  const values = new Map<string, number[]>();
  for (const prediction of predictions) {
    const benchmarkCase = caseById.get(prediction.case_id);
    if (!benchmarkCase) continue;
    const value = metricObservation(prediction, benchmarkCase, metric);
    if (value === null) continue;
    values.set(prediction.case_id, [...(values.get(prediction.case_id) || []), value]);
  }
  return new Map([...values.entries()].map(([caseId, rows]) => [caseId, rows.reduce((sum, value) => sum + value, 0) / rows.length]));
}

function metricObservationRows(
  predictions: PromotionBenchmarkPrediction[],
  cases: PromotionBenchmarkCaseManifest[],
  metric: PromotionBenchmarkBinaryMetric
): Array<{ base_bundle_id: string; value: number }> {
  const caseById = new Map(cases.map((benchmarkCase) => [benchmarkCase.case_id, benchmarkCase] as const));
  return predictions.flatMap((prediction) => {
    const benchmarkCase = caseById.get(prediction.case_id);
    if (!benchmarkCase) return [];
    const value = metricObservation(prediction, benchmarkCase, metric);
    return value === null ? [] : [{ base_bundle_id: benchmarkCase.base_bundle_id, value }];
  });
}

function metricObservation(
  prediction: PromotionBenchmarkPrediction,
  benchmarkCase: PromotionBenchmarkCaseManifest,
  metric: PromotionBenchmarkBinaryMetric
): number | null {
  if (metric === "decision_accuracy") {
    return Number(prediction.decision === benchmarkCase.gold.decision);
  }
  if (metric === "false_paper_ready") {
    return benchmarkCase.gold.decision === "promote" ? null : Number(prediction.decision === "promote");
  }
  if (metric === "concern_acceptance_conflict") {
    const hasBlockingConcern = prediction.concerns.some((concern) => concern.severity === "blocking");
    return hasBlockingConcern ? Number(prediction.decision === "promote") : null;
  }
  if (metric === "clean_case_promotion") {
    return benchmarkCase.gold.decision === "promote" ? Number(prediction.decision === "promote") : null;
  }
  return benchmarkCase.gold.repair_owners.length === 0
    ? null
    : Number(setsEqual(new Set(benchmarkCase.gold.repair_owners), new Set(prediction.repair_owners)));
}

function pairedCaseDifferences(
  left: Map<string, number>,
  right: Map<string, number>,
  cases: PromotionBenchmarkCaseManifest[]
): Array<{ base_bundle_id: string; difference: number }> {
  const caseById = new Map(cases.map((benchmarkCase) => [benchmarkCase.case_id, benchmarkCase] as const));
  return [...left.entries()].flatMap(([caseId, leftValue]) => {
    const rightValue = right.get(caseId);
    const benchmarkCase = caseById.get(caseId);
    return rightValue == null || !benchmarkCase
      ? []
      : [{ base_bundle_id: benchmarkCase.base_bundle_id, difference: leftValue - rightValue }];
  });
}

function clusteredDifferenceStats(
  rows: Array<{ base_bundle_id: string; difference: number }>,
  seedMaterial: string
): { delta: number | null; ci: [number, number] | null; p: number | null } {
  if (rows.length === 0) return { delta: null, ci: null, p: null };
  const delta = rows.reduce((sum, row) => sum + row.difference, 0) / rows.length;
  const clusters = [...groupBy(rows, (row) => row.base_bundle_id).values()];
  const clusterMeans = clusters.map((cluster) => cluster.reduce((sum, row) => sum + row.difference, 0) / cluster.length);
  const p = exactPairedSignTest(clusterMeans);
  if (clusters.length < 2) return { delta, ci: null, p };

  const random = deterministicRandom(seedMaterial);
  const bootstrap: number[] = [];
  for (let replicate = 0; replicate < CLUSTER_BOOTSTRAP_REPLICATES; replicate += 1) {
    let sum = 0;
    let count = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      for (const row of cluster) {
        sum += row.difference;
        count += 1;
      }
    }
    bootstrap.push(sum / count);
  }
  bootstrap.sort((left, right) => left - right);
  return {
    delta,
    ci: [
      quantile(bootstrap, PROMOTION_CONFIRMATORY_INTERVAL_TAIL_PROBABILITY),
      quantile(bootstrap, 1 - PROMOTION_CONFIRMATORY_INTERVAL_TAIL_PROBABILITY)
    ],
    p
  };
}

function clusteredMeanInterval(
  rows: Array<{ base_bundle_id: string; value: number }>,
  seedMaterial: string
): [number, number] | null {
  if (rows.length === 0) return null;
  const clusters = [...groupBy(rows, (row) => row.base_bundle_id).values()];
  if (clusters.length < 2) return null;
  const random = deterministicRandom(seedMaterial);
  const bootstrap: number[] = [];
  for (let replicate = 0; replicate < CLUSTER_BOOTSTRAP_REPLICATES; replicate += 1) {
    let sum = 0;
    let count = 0;
    for (let draw = 0; draw < clusters.length; draw += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)];
      for (const row of cluster) {
        sum += row.value;
        count += 1;
      }
    }
    bootstrap.push(sum / count);
  }
  bootstrap.sort((left, right) => left - right);
  const percentileInterval: [number, number] = [
    quantile(bootstrap, PROMOTION_CONFIRMATORY_INTERVAL_TAIL_PROBABILITY),
    quantile(bootstrap, 1 - PROMOTION_CONFIRMATORY_INTERVAL_TAIL_PROBABILITY)
  ];
  // Binary percentile intervals otherwise collapse to zero width at the boundary.
  if (rows.every((row) => row.value === 0)) {
    return [
      0,
      1 - Math.pow(PROMOTION_CONFIRMATORY_INTERVAL_TAIL_PROBABILITY, 1 / clusters.length)
    ];
  }
  if (rows.every((row) => row.value === 1)) {
    return [
      Math.pow(PROMOTION_CONFIRMATORY_INTERVAL_TAIL_PROBABILITY, 1 / clusters.length),
      1
    ];
  }
  return percentileInterval;
}

function exactPairedSignTest(values: number[]): number | null {
  const nonTies = values.filter((value) => Math.abs(value) > Number.EPSILON);
  if (nonTies.length === 0) return null;
  const positives = nonTies.filter((value) => value > 0).length;
  const tail = Math.min(positives, nonTies.length - positives);
  let cumulative = 0;
  for (let successes = 0; successes <= tail; successes += 1) {
    cumulative += binomialCoefficient(nonTies.length, successes) * (0.5 ** nonTies.length);
  }
  return Math.min(1, 2 * cumulative);
}

function binomialCoefficient(n: number, k: number): number {
  const limit = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= limit; index += 1) result = (result * (n - limit + index)) / index;
  return result;
}

function deterministicRandom(seedMaterial: string): () => number {
  let state = Number.parseInt(createHash("sha256").update(seedMaterial).digest("hex").slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function quantile(sortedValues: number[], probability: number): number {
  return sortedValues[Math.floor((sortedValues.length - 1) * probability)];
}

function renderPromotionScoreMarkdown(report: PromotionBenchmarkScoreReport): string {
  const lines = [
    "# Promotion Benchmark Score",
    "",
    `- Suite: ${report.suite_id}`,
    `- Cases: ${report.case_count}`,
    `- Predictions: ${report.prediction_count}`,
    `- Validation: ${report.passed ? "passed" : "failed"}`,
    `- Evidence class: ${report.evidence_class}`,
    `- Paper-claim eligible: ${report.paper_claim_eligible}`,
    `- Adjudication: ${report.adjudication_status}`,
    `- Mutation isolation: ${report.mutation_isolation_status}`,
    `- Execution provenance: ${report.execution_provenance_status}`,
    `- Source diversity: ${report.source_diversity_status}`,
    "",
    "## System Summary",
    "",
    "| System | Decision accuracy | Macro-F1 | False promotion | Concern-acceptance conflict | Clean promotion | Blocker F1 | Repair owner | Trace coverage |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.systems.map((system) => [
      system.system_id,
      formatMetric(system.exact_decision_accuracy),
      formatMetric(system.macro_decision_f1),
      formatMetric(system.false_paper_ready_rate),
      formatMetric(system.concern_acceptance_conflict_rate),
      formatMetric(system.clean_case_promotion_accuracy),
      formatMetric(system.blocker_f1),
      formatMetric(system.repair_owner_exact_match_accuracy),
      formatMetric(system.trace_coverage)
    ].join(" | ").replace(/^/u, "| ").replace(/$/u, " |")),
    "",
    "## Clustered Metric Uncertainty",
    "",
    "Intervals use base_bundle_id as the resampling cluster; all-zero and all-one binary outcomes use a two-sided exact boundary guard.",
    "",
    "| System | False promotion 95% CI | Concern-conflict 95% CI | Clean promotion 95% CI | Repair owner 95% CI |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...report.systems.map((system) => [
      system.system_id,
      formatInterval(system.false_paper_ready_cluster_bootstrap_95_ci),
      formatInterval(system.concern_acceptance_conflict_cluster_bootstrap_95_ci),
      formatInterval(system.clean_case_promotion_accuracy_cluster_bootstrap_95_ci),
      formatInterval(system.repair_owner_exact_match_accuracy_cluster_bootstrap_95_ci)
    ].join(" | ").replace(/^/u, "| ").replace(/$/u, " |")),
    "",
    "## Mutation Families",
    ""
  ];
  for (const system of report.systems) {
    lines.push(
      `### ${system.system_id}`,
      "",
      "| Family | Cases | Decision accuracy | False promotion | Blocker recall | Repair owner |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      ...system.by_mutation_family.map((family) =>
        `| ${family.mutation_family} | ${family.case_count} | ${formatMetric(family.exact_decision_accuracy)} | ${formatMetric(family.false_paper_ready_rate)} | ${formatMetric(family.blocker_recall)} | ${formatMetric(family.repair_owner_exact_match_accuracy)} |`
      ),
      ""
    );
  }
  lines.push(
    "## Source Family Stratification",
    "",
    `Availability: ${report.source_family_analysis.availability}. Families: ${report.source_family_analysis.family_count}.`,
    ""
  );
  if (report.source_family_analysis.availability === "unavailable") {
    lines.push(`Reason: ${report.source_family_analysis.unavailable_reason}.`, "");
  } else {
    for (const family of report.source_family_analysis.families) {
      lines.push(
        `### Family ${family.source_family_id_sha256.slice(0, 12)}`,
        "",
        `Bases: ${family.base_bundle_count}. Cases: ${family.case_count}.`,
        "",
        "| System | Decision accuracy | False promotion | Clean promotion | Blocker F1 | Repair owner |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
        ...family.systems.map((system) =>
          `| ${system.system_id} | ${formatMetric(system.exact_decision_accuracy)} | ${formatMetric(system.false_paper_ready_rate)} | ${formatMetric(system.clean_case_promotion_accuracy)} | ${formatMetric(system.blocker_f1)} | ${formatMetric(system.repair_owner_exact_match_accuracy)} |`
        ),
        ""
      );
    }
    lines.push(
      "## Leave-One-Family-Out Sensitivity",
      "",
      "| Omitted family | Remaining bases | Remaining cases | Comparisons |",
      "| --- | ---: | ---: | ---: |",
      ...report.source_family_analysis.leave_one_family_out.map((analysis) =>
        `| ${analysis.omitted_source_family_id_sha256.slice(0, 12)} | ${analysis.remaining_base_bundle_count} | ${analysis.remaining_case_count} | ${analysis.comparisons.length} |`
      ),
      ""
    );
    for (const analysis of report.source_family_analysis.leave_one_family_out) {
      lines.push(
        `### Omit Family ${analysis.omitted_source_family_id_sha256.slice(0, 12)}`,
        "",
        "| System A | System B | Decision delta | Decision 95% CI | Sign-test p | False-promotion delta | False-promotion 95% CI | Sign-test p |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        ...analysis.comparisons.map((comparison) =>
          `| ${comparison.system_a} | ${comparison.system_b} | ${formatMetric(comparison.decision_accuracy_delta)} | ${formatInterval(comparison.decision_accuracy_cluster_bootstrap_95_ci)} | ${formatMetric(comparison.decision_accuracy_exact_paired_sign_test_p)} | ${formatMetric(comparison.false_paper_ready_rate_delta)} | ${formatInterval(comparison.false_paper_ready_cluster_bootstrap_95_ci)} | ${formatMetric(comparison.false_paper_ready_exact_paired_sign_test_p)} |`
        ),
        ""
      );
    }
  }
  lines.push(
    "## Paired Repair-Owner Analysis",
    "",
    "| System A | System B | Common cases | Repair-owner delta | Repair-owner 95% CI | Sign-test p |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...report.paired_analysis.comparisons.map((comparison) => [
      comparison.system_a,
      comparison.system_b,
      String(comparison.repair_owner_common_case_count),
      formatMetric(comparison.repair_owner_exact_match_accuracy_delta),
      formatInterval(comparison.repair_owner_cluster_bootstrap_95_ci),
      formatMetric(comparison.repair_owner_exact_paired_sign_test_p)
    ].join(" | ").replace(/^/u, "| ").replace(/$/u, " |")),
    "",
    "## Paired Analysis",
    "",
    `Inference unit: ${report.paired_analysis.inference_unit}. Bootstrap replicates: ${report.paired_analysis.bootstrap_replicates}. Exploratory only: ${report.paired_analysis.exploratory_only}.`,
    "",
    "| System A | System B | Decision delta | Decision 95% CI | Sign-test p | False-promotion delta | False-promotion 95% CI | Sign-test p |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.paired_analysis.comparisons.map((comparison) =>
      `| ${comparison.system_a} | ${comparison.system_b} | ${formatMetric(comparison.decision_accuracy_delta)} | ${formatInterval(comparison.decision_accuracy_cluster_bootstrap_95_ci)} | ${formatMetric(comparison.decision_accuracy_exact_paired_sign_test_p)} | ${formatMetric(comparison.false_paper_ready_rate_delta)} | ${formatInterval(comparison.false_paper_ready_cluster_bootstrap_95_ci)} | ${formatMetric(comparison.false_paper_ready_exact_paired_sign_test_p)} |`
    ),
    ""
  );
  if (report.validation_issues.length > 0) {
    lines.push("## Validation Issues", "", ...report.validation_issues.map((issue) => `- ${issue.code}: ${issue.message}`), "");
  }
  return `${lines.join("\n")}\n`;
}

function formatInterval(value: [number, number] | null): string {
  return value == null ? "n/a" : `[${value[0].toFixed(3)}, ${value[1].toFixed(3)}]`;
}

function formatMetric(value: number | null): string {
  return value == null ? "n/a" : value.toFixed(3);
}

function parseSuiteManifest(value: unknown, issues: PromotionBenchmarkValidationIssue[]): PromotionBenchmarkSuiteManifest | undefined {
  if (!isRecord(value) || value.schema_version !== "1.0" || !nonEmptyString(value.suite_id) || !stringArray(value.cases)?.length) {
    issues.push({ code: "suite_manifest_invalid", message: "Suite manifest requires schema_version=1.0, suite_id, and cases." });
    return undefined;
  }
  if (value.evidence_class !== undefined && !isPromotionEvidenceClass(value.evidence_class)) {
    issues.push({ code: "suite_evidence_class_invalid", message: "Suite evidence_class is invalid." });
    return undefined;
  }
  if (value.paper_claim_eligible !== undefined && typeof value.paper_claim_eligible !== "boolean") {
    issues.push({ code: "suite_paper_claim_eligibility_invalid", message: "Suite paper_claim_eligible must be boolean." });
    return undefined;
  }
  if (value.adjudication_status !== undefined && !isPromotionAdjudicationStatus(value.adjudication_status)) {
    issues.push({ code: "suite_adjudication_status_invalid", message: "Suite adjudication_status is invalid." });
    return undefined;
  }
  if (value.mutation_isolation_status !== undefined && !isPromotionMutationIsolationStatus(value.mutation_isolation_status)) {
    issues.push({ code: "suite_mutation_isolation_status_invalid", message: "Suite mutation_isolation_status is invalid." });
    return undefined;
  }
  if (value.execution_provenance_status !== undefined && !isPromotionExecutionProvenanceStatus(value.execution_provenance_status)) {
    issues.push({ code: "suite_execution_provenance_status_invalid", message: "Suite execution_provenance_status is invalid." });
    return undefined;
  }
  if (value.source_diversity_status !== undefined && !isPromotionSourceDiversityStatus(value.source_diversity_status)) {
    issues.push({ code: "suite_source_diversity_status_invalid", message: "Suite source_diversity_status is invalid." });
    return undefined;
  }
  const adjudicationProvenance = value.adjudication_provenance === undefined
    ? undefined
    : parseAdjudicationProvenance(value.adjudication_provenance);
  if (value.adjudication_provenance !== undefined && !adjudicationProvenance) {
    issues.push({
      code: "suite_adjudication_provenance_invalid",
      message: "Suite adjudication_provenance must bind the source suite, two independent annotations, labels, and mutation audit inputs."
    });
    return undefined;
  }
  if (value.paper_claim_eligible === true
      && (value.adjudication_status !== "double_adjudicated"
        || value.mutation_isolation_status !== "double_verified"
        || value.execution_provenance_status !== "artifact_verified"
        || value.source_diversity_status !== "declared_stratified")) {
    issues.push({
      code: "suite_paper_claim_eligibility_unverified",
      message: "Paper-claim-eligible suites require artifact-verified execution provenance, declared source stratification, double adjudication, and double-verified mutation isolation."
    });
    return undefined;
  }
  if (value.paper_claim_eligible === true
      && (!adjudicationProvenance || adjudicationProvenance.mutation_audit_report_sha256 === null)) {
    issues.push({
      code: "suite_paper_claim_provenance_missing",
      message: "Paper-claim-eligible suites require hash-bound independent adjudication and mutation-audit provenance."
    });
    return undefined;
  }
  return {
    schema_version: "1.0",
    suite_id: value.suite_id,
    ...(value.evidence_class ? { evidence_class: value.evidence_class } : {}),
    ...(typeof value.paper_claim_eligible === "boolean" ? { paper_claim_eligible: value.paper_claim_eligible } : {}),
    ...(value.adjudication_status ? { adjudication_status: value.adjudication_status } : {}),
    ...(value.mutation_isolation_status ? { mutation_isolation_status: value.mutation_isolation_status } : {}),
    ...(value.execution_provenance_status ? { execution_provenance_status: value.execution_provenance_status } : {}),
    ...(value.source_diversity_status ? { source_diversity_status: value.source_diversity_status } : {}),
    ...(adjudicationProvenance ? { adjudication_provenance: adjudicationProvenance } : {}),
    cases: stringArray(value.cases) || []
  };
}

function parseAdjudicationProvenance(value: unknown): PromotionBenchmarkAdjudicationProvenance | undefined {
  if (!isRecord(value)
      || value.schema_version !== "1.0"
      || value.method !== "independent_double_adjudication"
      || !isSha256(value.source_suite_snapshot_sha256)
      || !adjudicationEvidenceRef(value.private_annotation_map_ref)
      || !isSha256(value.private_annotation_map_sha256)
      || !twoDistinctAdjudicationRefs(value.initial_annotation_refs)
      || !Array.isArray(value.initial_annotation_sha256)
      || value.initial_annotation_sha256.length !== 2
      || !value.initial_annotation_sha256.every(isSha256)
      || new Set(value.initial_annotation_sha256).size !== 2
      || !nullableRefHashPair(value.resolution_ref, value.resolution_sha256)
      || !nullableRefHashPair(value.mutation_audit_report_ref, value.mutation_audit_report_sha256)
      || !adjudicationEvidenceRef(value.adjudicated_labels_ref)
      || !isSha256(value.adjudicated_labels_sha256)
      || !adjudicationEvidenceRefsDistinct(value)
      || !Number.isInteger(value.case_count)
      || (value.case_count as number) <= 0) {
    return undefined;
  }
  return {
    schema_version: "1.0",
    method: "independent_double_adjudication",
    source_suite_snapshot_sha256: value.source_suite_snapshot_sha256,
    private_annotation_map_ref: value.private_annotation_map_ref,
    private_annotation_map_sha256: value.private_annotation_map_sha256,
    initial_annotation_refs: [
      value.initial_annotation_refs[0] as string,
      value.initial_annotation_refs[1] as string
    ],
    initial_annotation_sha256: [
      value.initial_annotation_sha256[0] as string,
      value.initial_annotation_sha256[1] as string
    ],
    resolution_ref: value.resolution_ref as string | null,
    resolution_sha256: value.resolution_sha256 as string | null,
    mutation_audit_report_ref: value.mutation_audit_report_ref as string | null,
    mutation_audit_report_sha256: value.mutation_audit_report_sha256 as string | null,
    adjudicated_labels_ref: value.adjudicated_labels_ref,
    adjudicated_labels_sha256: value.adjudicated_labels_sha256,
    case_count: value.case_count as number
  };
}

function twoDistinctAdjudicationRefs(value: unknown): value is [string, string] {
  return Array.isArray(value)
    && value.length === 2
    && value.every(adjudicationEvidenceRef)
    && new Set(value).size === 2;
}

function nullableRefHashPair(ref: unknown, hash: unknown): boolean {
  return (ref === null && hash === null) || (adjudicationEvidenceRef(ref) && isSha256(hash));
}

function adjudicationEvidenceRef(value: unknown): value is string {
  return nonEmptyString(value)
    && !path.isAbsolute(value)
    && value.startsWith("adjudication/")
    && !value.split(/[\\/]/u).some((part) => part === ".." || part === "");
}

function adjudicationEvidenceRefsDistinct(value: Record<string, unknown>): boolean {
  const refs = [
    value.private_annotation_map_ref,
    ...(Array.isArray(value.initial_annotation_refs) ? value.initial_annotation_refs : []),
    ...(value.resolution_ref === null ? [] : [value.resolution_ref]),
    ...(value.mutation_audit_report_ref === null ? [] : [value.mutation_audit_report_ref]),
    value.adjudicated_labels_ref
  ];
  return refs.every(adjudicationEvidenceRef) && new Set(refs).size === refs.length;
}

async function validateAdjudicationEvidence(
  suiteRoot: string,
  provenance: PromotionBenchmarkAdjudicationProvenance,
  cases: PromotionBenchmarkCaseManifest[],
  issues: PromotionBenchmarkValidationIssue[]
): Promise<void> {
  const evidence = [
    [provenance.private_annotation_map_ref, provenance.private_annotation_map_sha256],
    ...provenance.initial_annotation_refs.map((ref, index) => [ref, provenance.initial_annotation_sha256[index]]),
    ...(provenance.resolution_ref && provenance.resolution_sha256
      ? [[provenance.resolution_ref, provenance.resolution_sha256]]
      : []),
    ...(provenance.mutation_audit_report_ref && provenance.mutation_audit_report_sha256
      ? [[provenance.mutation_audit_report_ref, provenance.mutation_audit_report_sha256]]
      : []),
    [provenance.adjudicated_labels_ref, provenance.adjudicated_labels_sha256]
  ] as Array<[string, string]>;
  const expectedRefs = new Set(evidence.map(([ref]) => ref));
  const actualRefs = await listAdjudicationEvidenceRefs(suiteRoot);
  if (!actualRefs || !setsEqual(expectedRefs, new Set(actualRefs))) {
    issues.push({
      code: "adjudication_evidence_set_not_closed",
      message: "The suite adjudication directory must contain exactly the manifest-bound evidence files and no symlinks.",
      ref: "adjudication"
    });
  }
  const bytesByRef = new Map<string, Buffer>();
  for (const [ref, expectedSha256] of evidence) {
    const bytes = await readContainedRegularFile(suiteRoot, ref);
    if (!bytes) {
      issues.push({
        code: "adjudication_evidence_missing_or_unsafe",
        message: "Adjudication evidence must be a non-symlink regular file inside the suite.",
        ref
      });
      continue;
    }
    bytesByRef.set(ref, bytes);
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
      issues.push({
        code: "adjudication_evidence_hash_mismatch",
        message: "Adjudication evidence SHA-256 does not match the suite provenance.",
        ref
      });
    }
  }
  const labelsBytes = bytesByRef.get(provenance.adjudicated_labels_ref);
  if (!labelsBytes) return;
  let rows: unknown[];
  try {
    const text = labelsBytes.toString("utf8");
    const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
    rows = lines.map((line) => JSON.parse(line) as unknown);
  } catch {
    issues.push({
      code: "adjudicated_labels_invalid",
      message: "Adjudicated labels must be valid JSON Lines records.",
      ref: provenance.adjudicated_labels_ref
    });
    return;
  }
  const caseById = new Map(cases.map((benchmarkCase) => [benchmarkCase.case_id, benchmarkCase]));
  const seen = new Set<string>();
  let labelsValid = rows.length === provenance.case_count && rows.length === cases.length;
  for (const row of rows) {
    const blockingConcerns = isRecord(row) ? stringArray(row.blocking_concerns) : undefined;
    const repairOwners = isRecord(row) ? stringArray(row.repair_owners) : undefined;
    if (!isRecord(row)
        || !nonEmptyString(row.case_id)
        || seen.has(row.case_id)
        || !isPromotionDecision(row.decision)
        || !blockingConcerns
        || !repairOwners) {
      labelsValid = false;
      continue;
    }
    seen.add(row.case_id);
    const benchmarkCase = caseById.get(row.case_id);
    if (!benchmarkCase
        || benchmarkCase.gold.decision !== row.decision
        || !sameStringArray(benchmarkCase.gold.blocking_concerns, blockingConcerns)
        || !sameStringArray(benchmarkCase.gold.repair_owners, repairOwners)) {
      labelsValid = false;
    }
  }
  if (!labelsValid || seen.size !== cases.length) {
    issues.push({
      code: "adjudicated_labels_case_mismatch",
      message: "Hash-bound adjudicated labels must cover every suite case exactly once and match each case gold label.",
      ref: provenance.adjudicated_labels_ref
    });
  }
}

async function readContainedRegularFile(root: string, ref: string): Promise<Buffer | null> {
  let current = path.resolve(root);
  const rootStat = await fs.lstat(current).catch(() => null);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
  for (const part of ref.split(/[\\/]/u)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) return null;
    if (stat.isSymbolicLink()) return null;
  }
  try {
    return (await fs.lstat(current)).isFile() ? await fs.readFile(current) : null;
  } catch {
    return null;
  }
}

async function listAdjudicationEvidenceRefs(suiteRoot: string): Promise<string[] | null> {
  const evidenceRoot = path.join(suiteRoot, "adjudication");
  const rootStat = await fs.lstat(evidenceRoot).catch(() => null);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
  const refs: string[] = [];
  const visit = async (current: string): Promise<boolean> => {
    for (const entry of await fs.readdir(current)) {
      const child = path.join(current, entry);
      const stat = await fs.lstat(child).catch(() => null);
      if (!stat || stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!await visit(child)) return false;
      } else if (stat.isFile()) {
        refs.push(path.relative(suiteRoot, child).replace(/\\/gu, "/"));
      } else {
        return false;
      }
    }
    return true;
  };
  return await visit(evidenceRoot) ? refs.sort() : null;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseCaseManifest(
  value: unknown,
  ref: string,
  issues: PromotionBenchmarkValidationIssue[]
): PromotionBenchmarkCaseManifest | undefined {
  if (!isRecord(value) || value.schema_version !== "1.0" || !nonEmptyString(value.case_id)
      || !nonEmptyString(value.base_bundle_id) || (value.split !== "development" && value.split !== "test")
      || !nonEmptyString(value.artifact_root) || !isRecord(value.gold)
      || !isPromotionDecision(value.gold.decision) || !stringArray(value.gold.blocking_concerns)
      || !stringArray(value.gold.repair_owners)) {
    issues.push({ code: "case_manifest_invalid", message: "Case manifest has invalid identity, split, artifact, or gold fields.", ref });
    return undefined;
  }
  if (value.source_family_id_sha256 !== undefined && !isSha256(value.source_family_id_sha256)) {
    issues.push({ code: "case_source_family_hash_invalid", message: "Case source_family_id_sha256 must be a lowercase SHA-256 digest.", ref });
    return undefined;
  }
  if (value.operator_group_id_sha256 !== undefined && !isSha256(value.operator_group_id_sha256)) {
    issues.push({ code: "case_operator_group_hash_invalid", message: "Case operator_group_id_sha256 must be a lowercase SHA-256 digest.", ref });
    return undefined;
  }
  return {
    schema_version: "1.0",
    case_id: value.case_id,
    base_bundle_id: value.base_bundle_id,
    split: value.split,
    artifact_root: value.artifact_root,
    ...(nonEmptyString(value.source_sha256) ? { source_sha256: value.source_sha256 } : {}),
    ...(isSha256(value.source_family_id_sha256) ? { source_family_id_sha256: value.source_family_id_sha256 } : {}),
    ...(isSha256(value.operator_group_id_sha256) ? { operator_group_id_sha256: value.operator_group_id_sha256 } : {}),
    ...(nonEmptyString(value.artifact_sha256) ? { artifact_sha256: value.artifact_sha256 } : {}),
    ...(nonEmptyString(value.mutation_manifest) ? { mutation_manifest: value.mutation_manifest } : {}),
    ...(nonEmptyString(value.mutation_family) ? { mutation_family: value.mutation_family } : {}),
    gold: {
      decision: value.gold.decision,
      blocking_concerns: stringArray(value.gold.blocking_concerns) || [],
      repair_owners: stringArray(value.gold.repair_owners) || []
    }
  };
}

async function readPredictions(filePath: string, issues: PromotionBenchmarkValidationIssue[]): Promise<PromotionBenchmarkPrediction[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    issues.push({ code: "prediction_file_unreadable", message: error instanceof Error ? error.message : String(error) });
    return [];
  }
  const predictions: PromotionBenchmarkPrediction[] = [];
  for (const [index, line] of raw.split(/\r?\n/gu).entries()) {
    if (!line.trim()) continue;
    try {
      const prediction = parsePrediction(JSON.parse(line), index + 1, issues);
      if (prediction) predictions.push(prediction);
    } catch {
      issues.push({ code: "prediction_json_invalid", message: `Prediction line ${index + 1} is not valid JSON.` });
    }
  }
  return predictions;
}

function parsePrediction(
  value: unknown,
  line: number,
  issues: PromotionBenchmarkValidationIssue[]
): PromotionBenchmarkPrediction | undefined {
  if (!isRecord(value) || !nonEmptyString(value.case_id) || !nonEmptyString(value.system_id)
      || !nonEmptyString(value.trial_id) || !isPromotionDecision(value.decision)
      || !Array.isArray(value.concerns) || !stringArray(value.repair_owners)) {
    issues.push({ code: "prediction_schema_invalid", message: `Prediction line ${line} has an invalid schema.` });
    return undefined;
  }
  const concerns: PromotionBenchmarkConcernPrediction[] = [];
  for (const concern of value.concerns) {
    if (!isRecord(concern) || !nonEmptyString(concern.code)
        || (concern.severity !== "blocking" && concern.severity !== "warning")
        || (concern.evidence_refs !== undefined && !stringArray(concern.evidence_refs))) {
      issues.push({ code: "prediction_concern_invalid", message: `Prediction line ${line} has an invalid concern.` });
      return undefined;
    }
    concerns.push({
      code: concern.code,
      severity: concern.severity,
      ...(concern.evidence_refs ? { evidence_refs: stringArray(concern.evidence_refs) || [] } : {})
    });
  }
  return {
    case_id: value.case_id,
    system_id: value.system_id,
    trial_id: value.trial_id,
    decision: value.decision,
    concerns,
    repair_owners: stringArray(value.repair_owners) || [],
    ...(isNonNegativeFinite(value.latency_ms) ? { latency_ms: value.latency_ms } : {}),
    ...(isNonNegativeFinite(value.cost_usd) ? { cost_usd: value.cost_usd } : {})
  };
}

async function readJson(filePath: string, issues: PromotionBenchmarkValidationIssue[], code: string, ref?: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    issues.push({ code, message: error instanceof Error ? error.message : String(error), ...(ref ? { ref } : {}) });
    return undefined;
  }
}

function emptyConfusion(): Record<PromotionDecision, Record<PromotionDecision, number>> {
  return Object.fromEntries(PROMOTION_DECISIONS.map((gold) => [
    gold,
    Object.fromEntries(PROMOTION_DECISIONS.map((predicted) => [predicted, 0]))
  ])) as Record<PromotionDecision, Record<PromotionDecision, number>>;
}

function macroF1(confusion: Record<PromotionDecision, Record<PromotionDecision, number>>): number {
  const scores = PROMOTION_DECISIONS.map((decision) => {
    const tp = confusion[decision][decision];
    const fp = PROMOTION_DECISIONS.filter((gold) => gold !== decision).reduce((sum, gold) => sum + confusion[gold][decision], 0);
    const fn = PROMOTION_DECISIONS.filter((predicted) => predicted !== decision).reduce((sum, predicted) => sum + confusion[decision][predicted], 0);
    return harmonicMean(ratioOrNull(tp, tp + fp), ratioOrNull(tp, tp + fn)) || 0;
  });
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function resolveContainedPath(root: string, value: string): string | undefined {
  const resolved = path.resolve(root, value);
  return isContainedPath(root, resolved) ? resolved : undefined;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    return (await fs.stat(directoryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

export async function hashPromotionArtifactTree(root: string): Promise<string> {
  const absoluteRoot = path.resolve(root);
  const hash = createHash("sha256");
  const visit = async (current: string): Promise<void> => {
    const stat = await fs.lstat(current);
    const relative = path.relative(absoluteRoot, current).replace(/\\/gu, "/") || ".";
    if (stat.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in promotion benchmark artifacts: ${relative}`);
    }
    if (stat.isDirectory()) {
      hash.update(`directory\0${relative}\0`);
      const entries = await fs.readdir(current);
      for (const entry of entries.sort()) await visit(path.join(current, entry));
      return;
    }
    if (!stat.isFile()) throw new Error(`Unsupported artifact type: ${relative}`);
    hash.update(`file\0${relative}\0`);
    hash.update(await fs.readFile(current));
    hash.update("\0");
  };
  await visit(absoluteRoot);
  return hash.digest("hex");
}

export async function hashPromotionBenchmarkSuiteSnapshot(suitePath: string): Promise<string> {
  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(
      "Cannot hash an invalid promotion benchmark suite: "
      + loaded.issues.map((issue) => issue.code).join(", ")
    );
  }
  const hash = createHash("sha256");
  hash.update("suite_manifest\0");
  hash.update(await fs.readFile(loaded.suite.suite_path));
  hash.update("\0");
  const caseRefs = [...loaded.suite.manifest.cases].sort();
  for (const caseRef of caseRefs) {
    const casePath = resolveContainedPath(loaded.suite.suite_root, caseRef);
    if (!casePath) throw new Error("Suite snapshot case path escaped the suite root.");
    hash.update("case_manifest\0" + caseRef.replace(/\\/gu, "/") + "\0");
    hash.update(await fs.readFile(casePath));
    hash.update("\0");
  }
  const cases = [...loaded.suite.cases].sort((left, right) => left.case_id.localeCompare(right.case_id));
  for (const benchmarkCase of cases) {
    const artifactRoot = loaded.suite.case_artifact_roots[benchmarkCase.case_id];
    hash.update("artifact_tree\0" + benchmarkCase.case_id + "\0");
    hash.update(await hashPromotionArtifactTree(artifactRoot));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function harmonicMean(left: number | null, right: number | null): number | null {
  return left == null || right == null || left + right === 0 ? null : (2 * left * right) / (left + right);
}

function ratioOrNull(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function meanOrNull(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPromotionDecision(value: unknown): value is PromotionDecision {
  return typeof value === "string" && (PROMOTION_DECISIONS as readonly string[]).includes(value);
}

function isPromotionEvidenceClass(value: unknown): value is PromotionBenchmarkEvidenceClass {
  return value === "synthetic_development" || value === "human_adjudicated_test" || value === "external_real_run";
}

function isPromotionAdjudicationStatus(value: unknown): value is PromotionBenchmarkAdjudicationStatus {
  return value === "unreviewed" || value === "single_annotator" || value === "double_adjudicated";
}

function isPromotionMutationIsolationStatus(value: unknown): value is PromotionBenchmarkMutationIsolationStatus {
  return value === "unreviewed" || value === "double_verified";
}

function isPromotionExecutionProvenanceStatus(value: unknown): value is PromotionBenchmarkExecutionProvenanceStatus {
  return value === "unverified" || value === "artifact_verified";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(nonEmptyString) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    groups.set(key, [...(groups.get(key) || []), value]);
  }
  return groups;
}

function portableRef(cwd: string, absolutePath: string, fallback: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : fallback;
}
