import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  hashPromotionBenchmarkSuiteSnapshot,
  loadPromotionBenchmarkPredictions,
  loadPromotionBenchmarkSuite,
  scorePromotionBenchmarkFromFiles,
  type LoadedPromotionBenchmarkSuite,
  type PromotionBenchmarkPairedComparison,
  type PromotionBenchmarkPrediction,
  type PromotionBenchmarkScoreReport,
  type PromotionBenchmarkSystemMetrics
} from "./promotionBenchmark.js";
import {
  aggregatePromotionBenchmarkProviderRuns,
  type PromotionProviderAggregateManifest
} from "./promotionBenchmarkProviderAggregate.js";
import {
  evaluatePromotionBenchmarkRecovery,
  type PromotionRecoveryReport
} from "./promotionBenchmarkRecovery.js";
import {
  PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION,
  verifyPromotionBenchmarkSystemRun,
  type PromotionBenchmarkSystemRunManifest
} from "./promotionBenchmarkSystems.js";
import { promotionVariantDefinitions } from "./promotionBenchmarkVariants.js";
import { buildPromotionNodeStrengtheningRecommendations } from "./promotionBenchmarkMetaHarness.js";
import {
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES,
  PROMOTION_CONFIRMATORY_MAXIMUM_CONFLICT_RATE,
  PROMOTION_CONFIRMATORY_MINIMUM_CLEAN_PROMOTION_ACCURACY
} from "./promotionBenchmarkConfirmatoryContract.js";

export interface PromotionConfirmatorySystemRoles {
  ungated: string;
  checklist: string;
  manuscript: string;
  full: string;
  ablations: string[];
}

export interface EvaluatePromotionConfirmatoryGateInput {
  cwd: string;
  suitePath: string;
  predictionsPath: string;
  systemRunManifestPath?: string;
  providerRunManifestPaths: string[];
  recoveryManifestPath?: string;
  systemRoles: PromotionConfirmatorySystemRoles;
  outDir: string;
}

export type PromotionConfirmatoryReadiness = "paper_scale_candidate" | "blocked_for_paper_scale";
export type PromotionHypothesisStatus = "supported" | "not_supported" | "not_evaluable";

export interface PromotionConfirmatoryHypothesisResult {
  hypothesis_id: "H1" | "H2" | "H3" | "H4";
  status: PromotionHypothesisStatus;
  observed_value: number | null;
  confidence_interval_95: [number, number] | null;
  threshold: number;
  decision_rule: "lower_bound_at_least_threshold" | "upper_bound_at_most_threshold";
  point_threshold_met: boolean | null;
  inference_unit: "base_bundle_id";
  comparison: string;
  interpretation: string;
}

export interface PromotionConfirmatoryGateIssue {
  code: string;
  message: string;
  target_node: string;
  evidence_ref?: string;
}

export interface PromotionConfirmatoryGateReport {
  schema_version: "1.0";
  generated_at: string;
  suite_id: string;
  readiness: PromotionConfirmatoryReadiness;
  paper_ready: false;
  claim_class: "confirmatory_signal" | "mixed_or_weak_signal" | "null_or_counterevidence" | "not_evaluable";
  score_validation_passed: boolean;
  evidence_gate_passed: boolean;
  system_roles: PromotionConfirmatorySystemRoles;
  case_count: number;
  base_bundle_count: number;
  source_family_count: number;
  provider_repetition: {
    status: "verified_receipt_distinct" | "missing_or_invalid";
    trial_count: number;
    provider_identity_independently_verified: false;
    caveat: string;
  };
  recovery: {
    status: "verified" | "missing_or_invalid";
    successful_recovery_rate: number | null;
    clean_control_regression_rate: number | null;
  };
  hypotheses: PromotionConfirmatoryHypothesisResult[];
  blockers: PromotionConfirmatoryGateIssue[];
  artifacts: {
    suite_sha256: string;
    suite_snapshot_sha256: string;
    input_predictions_sha256: string;
    scored_predictions_sha256: string;
    score_report_ref: string;
    score_report_sha256: string;
    system_run_manifest_ref: string | null;
    system_run_manifest_sha256: string | null;
    provider_aggregate_ref: string | null;
    provider_aggregate_sha256: string | null;
    recovery_report_ref: string | null;
    recovery_report_sha256: string | null;
  };
}

export interface EvaluatePromotionConfirmatoryGateResult {
  report: PromotionConfirmatoryGateReport;
  output_dir: string;
  gate_report_path: string;
  gate_markdown_path: string;
  diagnostics_path: string;
  recommendations_path: string;
  decision_path: string;
}

export interface AssessPromotionConfirmatoryEvidenceInput {
  loaded: LoadedPromotionBenchmarkSuite | undefined;
  score: PromotionBenchmarkScoreReport;
  systemRunManifest: PromotionBenchmarkSystemRunManifest | null;
  providerAggregate: PromotionProviderAggregateManifest | null;
  recovery: PromotionRecoveryReport | null;
  roles: PromotionConfirmatorySystemRoles;
  suiteSha256: string;
  suiteSnapshotSha256: string;
  inputPredictionsSha256: string;
  systemRunManifestSha256: string | null;
  initialBlockers?: PromotionConfirmatoryGateIssue[];
}

export interface PromotionConfirmatoryAssessment {
  blockers: PromotionConfirmatoryGateIssue[];
  hypotheses: PromotionConfirmatoryHypothesisResult[];
  readiness: PromotionConfirmatoryReadiness;
  claim_class: PromotionConfirmatoryGateReport["claim_class"];
}

const MINIMUM_SOURCE_FAMILY_COUNT = 3;
const H1_MINIMUM_FALSE_PROMOTION_REDUCTION = 0.20;
const H4_MINIMUM_REPAIR_OWNER_ADVANTAGE = 0.15;

export async function evaluatePromotionConfirmatoryGate(
  input: EvaluatePromotionConfirmatoryGateInput
): Promise<EvaluatePromotionConfirmatoryGateResult> {
  const cwd = path.resolve(input.cwd);
  const suitePath = await resolveExistingInside(cwd, path.resolve(cwd, input.suitePath), "Confirmatory suite");
  const predictionsPath = await resolveExistingInside(
    cwd,
    path.resolve(cwd, input.predictionsPath),
    "Confirmatory predictions"
  );
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Confirmatory gate output");
  await assertFreshOutput(outDir);
  await fs.mkdir(outDir, { recursive: true });

  let issues: PromotionConfirmatoryGateIssue[] = [];
  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  for (const issue of loaded.issues) {
    addIssue(issues, "suite_" + issue.code, issue.message, targetForSuiteIssue(issue.code), issue.ref);
  }
  const loadedPredictions = await loadPromotionBenchmarkPredictions(predictionsPath);
  for (const issue of loadedPredictions.issues) {
    addIssue(issues, "predictions_" + issue.code, issue.message, "run_experiments", issue.ref);
  }
  const basePredictions = loadedPredictions.predictions.filter((prediction) => {
    if (prediction.system_id !== input.systemRoles.manuscript) return true;
    addIssue(
      issues,
      "manuscript_predictions_not_provider_bound",
      "Manuscript-only predictions must come from the validated provider aggregate, not the base prediction file.",
      "run_experiments",
      prediction.system_id
    );
    return false;
  });
  let systemRunManifest: PromotionBenchmarkSystemRunManifest | null = null;
  let systemRunManifestRef: string | null = null;
  let systemRunManifestSha256: string | null = null;
  if (!input.systemRunManifestPath) {
    addIssue(
      issues,
      "system_run_manifest_missing",
      "A hash-bound deterministic system run manifest is required for non-provider predictions.",
      "run_experiments"
    );
  } else {
    try {
      systemRunManifest = await verifyPromotionBenchmarkSystemRun({
        cwd,
        manifestPath: input.systemRunManifestPath,
        suitePath,
        predictionsPath
      });
      const verifiedPath = await resolveExistingInside(
        cwd,
        path.resolve(cwd, input.systemRunManifestPath),
        "System run manifest"
      );
      systemRunManifestRef = portableRef(cwd, verifiedPath);
      systemRunManifestSha256 = await sha256File(verifiedPath);
    } catch (error) {
      addIssue(
        issues,
        "system_run_manifest_invalid",
        error instanceof Error ? error.message : String(error),
        "run_experiments"
      );
    }
  }

  let providerAggregate: PromotionProviderAggregateManifest | null = null;
  let providerAggregateRef: string | null = null;
  let providerPredictions: PromotionBenchmarkPrediction[] = [];
  if (input.providerRunManifestPaths.length !== 3) {
    addIssue(
      issues,
      "provider_three_trial_evidence_missing",
      "Exactly three completed provider run manifests are required for the manuscript-only condition.",
      "run_experiments"
    );
  } else {
    try {
      const aggregated = await aggregatePromotionBenchmarkProviderRuns({
        cwd,
        suitePath,
        runManifestPaths: input.providerRunManifestPaths,
        outDir: path.join(outDir, "provider-aggregate")
      });
      providerAggregate = aggregated.manifest;
      providerAggregateRef = aggregated.manifest_path;
      if (providerAggregate.system_id !== input.systemRoles.manuscript) {
        addIssue(
          issues,
          "provider_system_role_mismatch",
          "Provider aggregate system_id does not match the declared manuscript role.",
          "run_experiments",
          providerAggregate.system_id
        );
      }
      const providerLoad = await loadPromotionBenchmarkPredictions(
        path.resolve(cwd, aggregated.predictions_path)
      );
      providerPredictions = providerLoad.predictions;
      for (const issue of providerLoad.issues) {
        addIssue(issues, "provider_" + issue.code, issue.message, "run_experiments", issue.ref);
      }
    } catch (error) {
      addIssue(
        issues,
        "provider_aggregate_invalid",
        error instanceof Error ? error.message : String(error),
        "run_experiments"
      );
    }
  }

  const mergedPredictions = [...basePredictions, ...providerPredictions];
  const mergedPredictionsPath = path.join(outDir, "scored-predictions.jsonl");
  await fs.writeFile(
    mergedPredictionsPath,
    mergedPredictions.length > 0
      ? mergedPredictions.map((prediction) => JSON.stringify(prediction)).join("\n") + "\n"
      : "",
    "utf8"
  );
  const score = await scorePromotionBenchmarkFromFiles({
    cwd,
    suitePath,
    predictionsPath: mergedPredictionsPath,
    outDir: path.join(outDir, "score")
  });

  let recovery: PromotionRecoveryReport | null = null;
  let recoveryReportRef: string | null = null;
  if (!input.recoveryManifestPath) {
    addIssue(
      issues,
      "post_repair_evidence_missing",
      "A hash-bound post-repair recovery manifest is required.",
      "run_experiments"
    );
  } else {
    try {
      const recoveryResult = await evaluatePromotionBenchmarkRecovery({
        cwd,
        manifestPath: input.recoveryManifestPath,
        outDir: path.join(outDir, "recovery")
      });
      recovery = recoveryResult.report;
      recoveryReportRef = recoveryResult.report_path;
    } catch (error) {
      addIssue(
        issues,
        "post_repair_evidence_invalid",
        error instanceof Error ? error.message : String(error),
        "run_experiments"
      );
    }
  }

  const suiteSha256 = await sha256File(suitePath);
  const suiteSnapshotSha256 = loaded.suite && loaded.issues.length === 0
    ? await hashPromotionBenchmarkSuiteSnapshot(suitePath)
    : "<invalid-suite-snapshot>";
  const inputPredictionsSha256 = await sha256File(predictionsPath);
  const scoredPredictionsSha256 = await sha256File(mergedPredictionsPath);
  const scoreReportSha256 = await sha256File(
    await resolveExistingInside(cwd, path.resolve(cwd, score.output_path), "Score report")
  );
  const providerAggregateSha256 = providerAggregateRef
    ? await sha256File(
      await resolveExistingInside(cwd, path.resolve(cwd, providerAggregateRef), "Provider aggregate")
    )
    : null;
  const recoveryReportSha256 = recoveryReportRef
    ? await sha256File(
      await resolveExistingInside(cwd, path.resolve(cwd, recoveryReportRef), "Recovery report")
    )
    : null;
  const assessment = assessPromotionConfirmatoryEvidence({
    loaded: loaded.suite,
    score: score.report,
    systemRunManifest,
    providerAggregate,
    recovery,
    roles: input.systemRoles,
    suiteSha256,
    suiteSnapshotSha256,
    inputPredictionsSha256,
    systemRunManifestSha256,
    initialBlockers: issues
  });
  issues = assessment.blockers;
  const hypotheses = assessment.hypotheses;
  const readiness = assessment.readiness;
  const report: PromotionConfirmatoryGateReport = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    suite_id: score.report.suite_id,
    readiness,
    paper_ready: false,
    claim_class: assessment.claim_class,
    score_validation_passed: score.report.passed,
    evidence_gate_passed: issues.length === 0,
    system_roles: input.systemRoles,
    case_count: score.report.case_count,
    base_bundle_count: countBaseBundles(loaded.suite),
    source_family_count: score.report.source_family_analysis.family_count,
    provider_repetition: {
      status: providerAggregate ? "verified_receipt_distinct" : "missing_or_invalid",
      trial_count: providerAggregate?.trial_count || 0,
      provider_identity_independently_verified: false,
      caveat: providerAggregate?.independence_basis.caveat
        || "No valid three-trial provider aggregate was available."
    },
    recovery: {
      status: recovery?.passed ? "verified" : "missing_or_invalid",
      successful_recovery_rate: recovery?.successful_recovery_rate ?? null,
      clean_control_regression_rate: recovery?.clean_control_regression_rate ?? null
    },
    hypotheses,
    blockers: issues,
    artifacts: {
      suite_sha256: suiteSha256,
      suite_snapshot_sha256: suiteSnapshotSha256,
      input_predictions_sha256: inputPredictionsSha256,
      scored_predictions_sha256: scoredPredictionsSha256,
      score_report_ref: score.output_path,
      score_report_sha256: scoreReportSha256,
      system_run_manifest_ref: systemRunManifestRef,
      system_run_manifest_sha256: systemRunManifestSha256,
      provider_aggregate_ref: providerAggregateRef,
      provider_aggregate_sha256: providerAggregateSha256,
      recovery_report_ref: recoveryReportRef,
      recovery_report_sha256: recoveryReportSha256
    }
  };
  const reviewDir = path.join(outDir, "review");
  await fs.mkdir(reviewDir, { recursive: true });
  const diagnostics = issues.map((issue) => ({
    id: "promotion_confirmatory:" + issue.code,
    severity: "blocking",
    target_node: issue.target_node,
    source_node: "review",
    summary: issue.message,
    evidence_ref: issue.evidence_ref || null,
    recheck_condition: "Re-run the confirmatory gate and require blocker " + issue.code + " to be absent."
  }));
  const recommendations = buildPromotionNodeStrengtheningRecommendations(diagnostics);
  const gateReportPath = path.join(outDir, "promotion-confirmatory-gate.json");
  const gateMarkdownPath = path.join(outDir, "promotion-confirmatory-gate.md");
  const diagnosticsPath = path.join(reviewDir, "paper_scale_diagnostics.json");
  const recommendationsPath = path.join(reviewDir, "node_strengthening_recommendations.json");
  const decisionPath = path.join(reviewDir, "decision.json");
  await writeJsonFile(gateReportPath, report);
  await fs.writeFile(gateMarkdownPath, renderGateMarkdown(report), "utf8");
  await writeJsonFile(diagnosticsPath, { diagnostics });
  await writeJsonFile(recommendationsPath, { recommendations });
  await writeJsonFile(decisionPath, {
    outcome: readiness === "paper_scale_candidate" ? "accept" : "revise",
    manuscript_type: readiness,
    paper_ready: false,
    claim_class: report.claim_class,
    blocker_count: issues.length
  });
  return {
    report,
    output_dir: portableRef(cwd, outDir),
    gate_report_path: portableRef(cwd, gateReportPath),
    gate_markdown_path: portableRef(cwd, gateMarkdownPath),
    diagnostics_path: portableRef(cwd, diagnosticsPath),
    recommendations_path: portableRef(cwd, recommendationsPath),
    decision_path: portableRef(cwd, decisionPath)
  };
}

export function assessPromotionConfirmatoryEvidence(
  input: AssessPromotionConfirmatoryEvidenceInput
): PromotionConfirmatoryAssessment {
  const blockers = [...(input.initialBlockers || [])];
  inspectConfirmatoryEvidence({
    loaded: input.loaded,
    score: input.score,
    systemRunManifest: input.systemRunManifest,
    providerAggregate: input.providerAggregate,
    recovery: input.recovery,
    roles: input.roles,
    suiteSha256: input.suiteSha256,
    suiteSnapshotSha256: input.suiteSnapshotSha256,
    inputPredictionsSha256: input.inputPredictionsSha256,
    systemRunManifestSha256: input.systemRunManifestSha256,
    issues: blockers
  });
  const hypotheses = evaluateHypotheses(input.score, input.roles, blockers);
  return {
    blockers,
    hypotheses,
    readiness: blockers.length === 0 ? "paper_scale_candidate" : "blocked_for_paper_scale",
    claim_class: claimClass(hypotheses)
  };
}

function inspectConfirmatoryEvidence(input: {
  loaded: LoadedPromotionBenchmarkSuite | undefined;
  score: PromotionBenchmarkScoreReport;
  systemRunManifest: PromotionBenchmarkSystemRunManifest | null;
  providerAggregate: PromotionProviderAggregateManifest | null;
  recovery: PromotionRecoveryReport | null;
  roles: PromotionConfirmatorySystemRoles;
  suiteSha256: string;
  suiteSnapshotSha256: string;
  inputPredictionsSha256: string;
  systemRunManifestSha256: string | null;
  issues: PromotionConfirmatoryGateIssue[];
}): void {
  const allRoleIds = [
    input.roles.ungated,
    input.roles.checklist,
    input.roles.manuscript,
    input.roles.full,
    ...input.roles.ablations
  ];
  if (input.roles.ablations.length === 0) {
    addIssue(input.issues, "ablation_role_missing", "At least one ablation system is required.", "design_experiments");
  }
  if (allRoleIds.some((role) => !portableIdentifier(role)) || new Set(allRoleIds).size !== allRoleIds.length) {
    addIssue(
      input.issues,
      "system_roles_invalid_or_overlapping",
      "System role identifiers must be portable and mutually distinct.",
      "design_experiments"
    );
  }
  const expectedBaseSystemIds = [
    input.roles.ungated,
    input.roles.checklist,
    input.roles.full,
    ...input.roles.ablations
  ];
  if (!input.systemRunManifest) {
    addIssue(
      input.issues,
      "system_run_manifest_not_verified",
      "Non-provider system predictions require a verified deterministic run manifest.",
      "run_experiments"
    );
  } else {
    if (input.systemRunManifest.protocol_revision !== PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION) {
      addIssue(
        input.issues,
        "system_run_protocol_revision_mismatch",
        "Paper-scale deterministic predictions require the current hash-verified system protocol revision.",
        "run_experiments"
      );
    }
    const manifestSystemIds = input.systemRunManifest.systems.map((system) => system.system_id);
    if (!sameStringSet(manifestSystemIds, expectedBaseSystemIds)) {
      addIssue(
        input.issues,
        "system_run_roles_mismatch",
        "The deterministic run manifest must contain exactly the declared ungated, checklist, full, and ablation roles.",
        "run_experiments"
      );
    }
    const protocolById = new Map<string, PromotionBenchmarkSystemRunManifest["systems"][number]>(
      input.systemRunManifest.systems.map((system) => [system.system_id, system])
    );
    if (protocolById.get(input.roles.ungated)?.protocol !== "ungated"
        || protocolById.get(input.roles.checklist)?.protocol !== "artifact_presence_checklist"
        || protocolById.get(input.roles.full)?.protocol !== "full_artifact_policy"
        || input.roles.ablations.some((systemId) => {
          const system = protocolById.get(systemId);
          return system?.protocol !== "gate_ablation" || system.ablated_components.length === 0;
        })) {
      addIssue(
        input.issues,
        "system_run_protocol_mismatch",
        "Declared system roles must match verified ungated, checklist, full-policy, and non-empty ablation protocols.",
        "design_experiments"
      );
    }
  }
  if (!input.score.passed) {
    addIssue(input.issues, "score_validation_failed", "Promotion benchmark score validation failed.", "run_experiments");
  }
  const adjudicationProvenance = input.loaded?.manifest.adjudication_provenance;
  if (!adjudicationProvenance
      || adjudicationProvenance.case_count !== input.score.case_count
      || adjudicationProvenance.mutation_audit_report_sha256 === null) {
    addIssue(
      input.issues,
      "confirmatory_adjudication_provenance_missing",
      "Confirmatory evidence requires hash-bound source-suite, double-annotation, adjudicated-label, and mutation-audit provenance.",
      "review"
    );
  }
  if (input.score.evidence_class !== "external_real_run"
      || !input.score.paper_claim_eligible
      || input.score.adjudication_status !== "double_adjudicated"
      || input.score.mutation_isolation_status !== "double_verified"
      || input.score.execution_provenance_status !== "artifact_verified"
      || input.score.source_diversity_status !== "declared_stratified") {
    addIssue(
      input.issues,
      "confirmatory_evidence_status_ineligible",
      "The suite must be external-real, paper-claim-eligible, double-adjudicated, double-mutation-verified, artifact-verified, and declared-stratified.",
      "review"
    );
  }
  if (input.score.case_count < MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES) {
    addIssue(
      input.issues,
      "minimum_case_count_not_met",
      "Confirmatory evaluation requires at least "
        + MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES + " cases.",
      "design_experiments"
    );
  }
  const baseCount = countBaseBundles(input.loaded);
  if (baseCount < MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES) {
    addIssue(
      input.issues,
      "minimum_base_bundle_count_not_met",
      "Confirmatory evaluation requires at least "
        + MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES + " base bundles.",
      "design_experiments"
    );
  }
  inspectCaseMatrix(input.loaded, input.issues);
  if (input.score.source_family_analysis.availability !== "complete"
      || input.score.source_family_analysis.family_count < MINIMUM_SOURCE_FAMILY_COUNT) {
    addIssue(
      input.issues,
      "source_family_analysis_incomplete",
      "At least three source families with complete family-stratified analysis are required.",
      "design_experiments"
    );
  }
  inspectLeaveOneFamilyOut(input.score, input.roles, input.issues);

  const systemById = new Map(input.score.systems.map((system) => [system.system_id, system]));
  if (!sameStringSet([...systemById.keys()], allRoleIds)) {
    addIssue(
      input.issues,
      "scored_system_set_mismatch",
      "The scored system set must exactly match the declared comparison and ablation roles.",
      "run_experiments"
    );
  }
  for (const role of allRoleIds) {
    if (!systemById.has(role)) {
      addIssue(input.issues, "required_system_missing", "A required comparison system is missing.", "run_experiments", role);
    }
  }
  const manuscript = systemById.get(input.roles.manuscript);
  if (!input.providerAggregate
      || input.providerAggregate.suite_id !== input.score.suite_id
      || input.providerAggregate.system_id !== input.roles.manuscript
      || input.providerAggregate.trial_count !== 3
      || input.providerAggregate.independent_trial_requirement_met !== true
      || input.providerAggregate.external_empirical_evidence_eligible !== true
      || manuscript?.trial_count !== 3
      || manuscript.coverage_rate !== 1) {
    addIssue(
      input.issues,
      "provider_repetition_not_verified",
      "The manuscript-only role requires a validated three-trial provider aggregate with complete coverage.",
      "run_experiments"
    );
  }
  if (!input.recovery?.passed
      || input.recovery.study_id !== input.score.suite_id
      || input.recovery.system_id !== input.roles.full
      || input.recovery.original_suite_sha256 !== input.suiteSha256
      || input.recovery.original_suite_snapshot_sha256 !== input.suiteSnapshotSha256
      || input.recovery.original_predictions_sha256 !== input.inputPredictionsSha256
      || input.recovery.original_system_run_manifest_sha256 !== input.systemRunManifestSha256
      || input.recovery.missing_fault_families.length > 0
      || input.recovery.successful_recovery_rate === null
      || input.recovery.clean_control_regression_rate === null) {
    addIssue(
      input.issues,
      "post_repair_evidence_not_verified",
      "Recovery evidence must be valid, hash-bound to the selected suite and predictions, cover every fault family, and report clean-control regressions.",
      "run_experiments"
    );
  }
}

function inspectCaseMatrix(
  suite: LoadedPromotionBenchmarkSuite | undefined,
  issues: PromotionConfirmatoryGateIssue[]
): void {
  if (!suite) return;
  const requiredFamilies = promotionVariantDefinitions()
    .flatMap((variant) => variant.mutation_family ? [variant.mutation_family] : []);
  const byBase = new Map<string, typeof suite.cases>();
  for (const benchmarkCase of suite.cases) {
    byBase.set(benchmarkCase.base_bundle_id, [...(byBase.get(benchmarkCase.base_bundle_id) || []), benchmarkCase]);
    if (benchmarkCase.split !== "test") {
      addIssue(issues, "confirmatory_case_not_held_out", "Every confirmatory case must use the test split.", "design_experiments", benchmarkCase.case_id);
    }
  }
  for (const [baseId, cases] of byBase) {
    const cleanCount = cases.filter((item) => !item.mutation_family).length;
    const familyCounts = new Map<string, number>();
    for (const item of cases) {
      if (item.mutation_family) {
        familyCounts.set(item.mutation_family, (familyCounts.get(item.mutation_family) || 0) + 1);
      }
    }
    if (cleanCount !== 1
        || cases.length !== requiredFamilies.length + 1
        || requiredFamilies.some((family) => familyCounts.get(family) !== 1)
        || [...familyCounts].some(([family]) => !requiredFamilies.includes(family))) {
      addIssue(
        issues,
        "confirmatory_case_matrix_incomplete",
        "Each base bundle requires one clean control and exactly one case from every required fault family.",
        "design_experiments",
        baseId
      );
    }
  }
}

function inspectLeaveOneFamilyOut(
  report: PromotionBenchmarkScoreReport,
  roles: PromotionConfirmatorySystemRoles,
  issues: PromotionConfirmatoryGateIssue[]
): void {
  const familyAnalysis = report.source_family_analysis;
  if (familyAnalysis.availability !== "complete") return;
  if (familyAnalysis.leave_one_family_out.length !== familyAnalysis.family_count) {
    addIssue(
      issues,
      "leave_one_family_out_incomplete",
      "Leave-one-family-out analysis must cover every declared source family.",
      "analyze_results"
    );
    return;
  }
  for (const omitted of familyAnalysis.leave_one_family_out) {
    const comparison = findComparison(omitted.comparisons, roles.checklist, roles.full);
    if (!comparison || comparison.false_paper_ready_cluster_bootstrap_95_ci === null) {
      addIssue(
        issues,
        "leave_one_family_out_comparison_missing",
        "Each family omission requires a checklist-versus-full clustered comparison.",
        "analyze_results",
        omitted.omitted_source_family_id_sha256
      );
    }
  }
}

function evaluateHypotheses(
  report: PromotionBenchmarkScoreReport,
  roles: PromotionConfirmatorySystemRoles,
  issues: PromotionConfirmatoryGateIssue[]
): PromotionConfirmatoryHypothesisResult[] {
  const systems = new Map(report.systems.map((system) => [system.system_id, system]));
  const full = systems.get(roles.full);
  const h1Comparison = findComparison(report.paired_analysis.comparisons, roles.checklist, roles.full);
  const h1 = orientPairedMetric(
    h1Comparison,
    roles.checklist,
    roles.full,
    "false_paper_ready_rate_delta",
    "false_paper_ready_cluster_bootstrap_95_ci"
  );
  const strongestBaseline = [roles.ungated, roles.checklist, roles.manuscript]
    .map((systemId) => systems.get(systemId))
    .filter((system): system is PromotionBenchmarkSystemMetrics =>
      system?.repair_owner_exact_match_accuracy !== null
      && system?.repair_owner_exact_match_accuracy !== undefined)
    .sort((left, right) =>
      (right.repair_owner_exact_match_accuracy as number) - (left.repair_owner_exact_match_accuracy as number)
      || left.system_id.localeCompare(right.system_id))[0];
  const h4Comparison = strongestBaseline
    ? findComparison(report.paired_analysis.comparisons, roles.full, strongestBaseline.system_id)
    : undefined;
  const h4 = orientPairedMetric(
    h4Comparison,
    roles.full,
    strongestBaseline?.system_id,
    "repair_owner_exact_match_accuracy_delta",
    "repair_owner_cluster_bootstrap_95_ci"
  );
  const inputs = [
    {
      id: "H1" as const,
      value: h1.value,
      ci: h1.ci,
      threshold: H1_MINIMUM_FALSE_PROMOTION_REDUCTION,
      direction: "at_least" as const,
      comparison: roles.checklist + " minus " + roles.full
    },
    {
      id: "H2" as const,
      value: full?.concern_acceptance_conflict_rate ?? null,
      ci: full?.concern_acceptance_conflict_cluster_bootstrap_95_ci ?? null,
      threshold: PROMOTION_CONFIRMATORY_MAXIMUM_CONFLICT_RATE,
      direction: "at_most" as const,
      comparison: roles.full
    },
    {
      id: "H3" as const,
      value: full?.clean_case_promotion_accuracy ?? null,
      ci: full?.clean_case_promotion_accuracy_cluster_bootstrap_95_ci ?? null,
      threshold: PROMOTION_CONFIRMATORY_MINIMUM_CLEAN_PROMOTION_ACCURACY,
      direction: "at_least" as const,
      comparison: roles.full
    },
    {
      id: "H4" as const,
      value: h4.value,
      ci: h4.ci,
      threshold: H4_MINIMUM_REPAIR_OWNER_ADVANTAGE,
      direction: "at_least" as const,
      comparison: roles.full + " minus " + (strongestBaseline?.system_id || "strongest non-governed baseline")
    }
  ];
  for (const input of inputs) {
    if (input.value === null || input.ci === null) {
      addIssue(
        issues,
        "hypothesis_clustered_interval_not_evaluable",
        input.id + " requires a base-bundle clustered 95% confidence interval for its preregistered metric.",
        "analyze_results",
        input.id
      );
    }
  }
  if (inputs.some((input) => input.value === null)) {
    addIssue(
      issues,
      "hypothesis_metric_not_evaluable",
      "All preregistered hypotheses require non-null metrics from the declared systems.",
      "analyze_results"
    );
  }
  return inputs.map((input) => hypothesis(
    input.id,
    input.value,
    input.ci,
    input.threshold,
    input.direction,
    input.comparison
  ));
}

function hypothesis(
  id: "H1" | "H2" | "H3" | "H4",
  value: number | null,
  ci: [number, number] | null,
  threshold: number,
  direction: "at_least" | "at_most",
  comparison: string
): PromotionConfirmatoryHypothesisResult {
  const pointThresholdMet = value === null
    ? null
    : direction === "at_least" ? value >= threshold : value <= threshold;
  const status: PromotionHypothesisStatus = value === null || ci === null
    ? "not_evaluable"
    : direction === "at_least"
      ? ci[0] >= threshold ? "supported" : "not_supported"
      : ci[1] <= threshold ? "supported" : "not_supported";
  const decisionRule = direction === "at_least"
    ? "lower_bound_at_least_threshold"
    : "upper_bound_at_most_threshold";
  return {
    hypothesis_id: id,
    status,
    observed_value: value,
    confidence_interval_95: ci,
    threshold,
    decision_rule: decisionRule,
    point_threshold_met: pointThresholdMet,
    inference_unit: "base_bundle_id",
    comparison,
    interpretation: value === null || ci === null
      ? "The required point estimate or clustered confidence interval was unavailable."
      : "Observed " + value.toFixed(4)
        + " with clustered 95% CI [" + ci[0].toFixed(4) + ", " + ci[1].toFixed(4) + "]; "
        + "support requires the " + (direction === "at_least" ? "lower" : "upper")
        + " bound to be " + direction.replace("_", " ") + " " + threshold.toFixed(4) + "."
  };
}

function orientPairedMetric(
  comparison: PromotionBenchmarkPairedComparison | undefined,
  left: string,
  right: string | undefined,
  valueKey: "false_paper_ready_rate_delta" | "repair_owner_exact_match_accuracy_delta",
  ciKey: "false_paper_ready_cluster_bootstrap_95_ci" | "repair_owner_cluster_bootstrap_95_ci"
): { value: number | null; ci: [number, number] | null } {
  if (!comparison || !right) return { value: null, ci: null };
  const value = comparison[valueKey];
  const ci = comparison[ciKey];
  if (value === null || ci === null) return { value: null, ci: null };
  if (comparison.system_a === left && comparison.system_b === right) {
    return { value, ci };
  }
  if (comparison.system_a === right && comparison.system_b === left) {
    return { value: -value, ci: [-ci[1], -ci[0]] };
  }
  return { value: null, ci: null };
}

function claimClass(
  hypotheses: PromotionConfirmatoryHypothesisResult[]
): PromotionConfirmatoryGateReport["claim_class"] {
  if (hypotheses.some((item) => item.status === "not_evaluable")) return "not_evaluable";
  if (hypotheses.every((item) => item.status === "supported")) return "confirmatory_signal";
  if (hypotheses.some((item) => item.status === "supported")) return "mixed_or_weak_signal";
  return "null_or_counterevidence";
}

function findComparison(
  comparisons: PromotionBenchmarkPairedComparison[],
  left: string,
  right: string
): PromotionBenchmarkPairedComparison | undefined {
  return comparisons.find((comparison) =>
    (comparison.system_a === left && comparison.system_b === right)
      || (comparison.system_a === right && comparison.system_b === left));
}

function countBaseBundles(suite: LoadedPromotionBenchmarkSuite | undefined): number {
  return new Set((suite?.cases || []).map((item) => item.base_bundle_id)).size;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function addIssue(
  issues: PromotionConfirmatoryGateIssue[],
  code: string,
  message: string,
  targetNode: string,
  evidenceRef?: string
): void {
  if (issues.some((issue) => issue.code === code && issue.evidence_ref === evidenceRef)) return;
  issues.push({
    code,
    message,
    target_node: targetNode,
    ...(evidenceRef ? { evidence_ref: evidenceRef } : {})
  });
}

function targetForSuiteIssue(code: string): string {
  if (/adjudicat|mutation|paper_claim|evidence_class/u.test(code)) return "review";
  if (/source|family|operator|split|case/u.test(code)) return "design_experiments";
  return "run_experiments";
}

function renderGateMarkdown(report: PromotionConfirmatoryGateReport): string {
  const lines = [
    "# Promotion Confirmatory Gate",
    "",
    "- Readiness: " + report.readiness,
    "- Paper ready: false",
    "- Claim class: " + report.claim_class,
    "- Cases: " + report.case_count,
    "- Base bundles: " + report.base_bundle_count,
    "- Source families: " + report.source_family_count,
    "- Provider repetition: " + report.provider_repetition.status,
    "- Recovery evidence: " + report.recovery.status,
    "",
    "## Hypotheses",
    ""
  ];
  lines.push(...report.hypotheses.map((item) =>
    "- " + item.hypothesis_id + ": " + item.status + " - " + item.interpretation));
  lines.push("", "## Blocking Evidence Gaps", "");
  if (report.blockers.length === 0) lines.push("- None.");
  else {
    lines.push(...report.blockers.map((blocker) =>
      "- " + blocker.code + " -> " + blocker.target_node + ": " + blocker.message));
  }
  return lines.concat("").join("\n");
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
    throw new Error("Promotion confirmatory gate output already exists: " + outDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : "<external-output>";
}

function sha256File(filePath: string): Promise<string> {
  return fs.readFile(filePath).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
}

function portableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
