import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  loadPromotionBenchmarkSuite,
  type PromotionBenchmarkScoreReport,
  type PromotionBenchmarkSystemMetrics
} from "./promotionBenchmark.js";
import type {
  PromotionConfirmatoryGateIssue,
  PromotionConfirmatoryGateReport,
  PromotionConfirmatoryHypothesisResult
} from "./promotionBenchmarkConfirmatoryGate.js";
import {
  verifyPromotionBenchmarkSystemRun,
  type PromotionBenchmarkSystemRunManifest
} from "./promotionBenchmarkSystems.js";
import type { PromotionProviderAggregateManifest } from "./promotionBenchmarkProviderAggregate.js";
import type { PromotionRecoveryReport } from "./promotionBenchmarkRecovery.js";

export interface ExportPromotionDevelopmentEvidenceInput {
  cwd: string;
  corpusManifestPath: string;
  suitePath: string;
  predictionsPath: string;
  systemRunManifestPath: string;
  scoreReportPath: string;
  gateReportPath: string;
  recommendationsPath: string;
  outputPath: string;
}

export interface PromotionDevelopmentEvidenceReport {
  schema_version: "1.2";
  evidence_id: string;
  generated_at: string;
  evidence_class: "synthetic_development";
  paper_claim_eligible: false;
  artifact_consistency_verified: true;
  source_artifact_availability: "local_run_only";
  corpus: {
    corpus_id: string;
    base_bundle_count: number;
    case_count: number;
    clean_control_count: number;
    mutation_family_count: number;
  };
  evaluation: {
    score_validation_passed: true;
    prediction_count: number;
    trial_id: string;
    systems: Array<{
      system_id: string;
      trial_count: number;
      coverage_rate: number;
      macro_decision_f1: number | null;
      false_paper_ready_rate: number | null;
      concern_acceptance_conflict_rate: number | null;
      blocker_f1: number | null;
      repair_owner_exact_match_accuracy: number | null;
      clean_case_promotion_accuracy: number | null;
      trace_coverage: number | null;
      mean_latency_ms: number | null;
      total_cost_usd: number | null;
    }>;
  };
  real_model_evaluation: {
    status: "not_available" | "verified_development_only";
    trial_count: number;
    prediction_count: number;
    execution_environment: PromotionProviderAggregateManifest["execution_environment"] | null;
    execution_receipt_status: PromotionProviderAggregateManifest["execution_receipt_status"] | null;
    external_empirical_evidence_eligible: boolean;
    paper_claim_evidence_eligible: false;
    model_artifact_digest: string | null;
  };
  development_recovery_evaluation: {
    status: "not_available" | "verified_development_only";
    original_fault_case_count: number;
    covered_fault_case_count: number;
    missing_fault_case_count: number;
    successful_recovery_rate: number | null;
    clean_control_regression_rate: number | null;
    paper_claim_evidence_eligible: false;
    paper_scale_eligibility_issue_codes: string[];
  };
  confirmatory_gate: {
    readiness: "blocked_for_paper_scale";
    paper_ready: false;
    claim_class: PromotionConfirmatoryGateReport["claim_class"];
    evidence_gate_passed: false;
    provider_repetition: PromotionConfirmatoryGateReport["provider_repetition"];
    recovery: PromotionConfirmatoryGateReport["recovery"];
    hypotheses: PromotionConfirmatoryHypothesisResult[];
    blocker_count: number;
    blockers: Array<{
      code: string;
      target_node: string;
      count: number;
    }>;
  };
  node_strengthening: Array<{
    node: string;
    priority: string;
    diagnostic_ids: string[];
    problem_summary: string;
    recheck_condition: string;
  }>;
  source_artifacts: Array<{
    role: string;
    ref: string;
    sha256: string;
  }>;
  evidence_boundary: string;
}

export interface ExportPromotionDevelopmentEvidenceResult {
  report: PromotionDevelopmentEvidenceReport;
  output_path: string;
}

interface DevelopmentCorpusManifest {
  schema_version: "1.0";
  corpus_id: string;
  evidence_class: "synthetic_development";
  paper_claim_eligible: false;
  adjudication_status: "unreviewed";
  mutation_isolation_status: "unreviewed";
  execution_provenance_status: "unverified";
  base_bundle_count: number;
  case_count: number;
  clean_control_count: number;
  mutation_family_count: number;
  use_boundary: string;
}

interface NodeStrengtheningRecommendation {
  node: string;
  priority: string;
  diagnostic_ids: string[];
  problem_summary: string;
  recheck_condition: string;
}

const DEVELOPMENT_RECOVERY_ELIGIBILITY_ISSUES = new Set([
  "original_external_real_run_required",
  "original_paper_claim_eligibility_required",
  "original_double_adjudication_required",
  "original_artifact_execution_required",
  "repaired_external_real_run_required",
  "repaired_double_adjudication_required",
  "repaired_artifact_execution_required"
]);

export async function exportPromotionDevelopmentEvidence(
  input: ExportPromotionDevelopmentEvidenceInput
): Promise<ExportPromotionDevelopmentEvidenceResult> {
  const cwd = path.resolve(input.cwd);
  const paths: Record<string, string> = {
    corpus_manifest: await resolveExistingInside(cwd, input.corpusManifestPath, "Corpus manifest"),
    suite: await resolveExistingInside(cwd, input.suitePath, "Development suite"),
    predictions: await resolveExistingInside(cwd, input.predictionsPath, "Development predictions"),
    system_run_manifest: await resolveExistingInside(cwd, input.systemRunManifestPath, "System run manifest"),
    score_report: await resolveExistingInside(cwd, input.scoreReportPath, "Score report"),
    confirmatory_gate: await resolveExistingInside(cwd, input.gateReportPath, "Confirmatory gate report"),
    node_strengthening_recommendations: await resolveExistingInside(
      cwd,
      input.recommendationsPath,
      "Node-strengthening recommendations"
    )
  };
  const outputPath = await resolveFreshOutputInside(cwd, input.outputPath);

  const [corpusValue, scoreValue, gateValue, recommendationsValue] = await Promise.all([
    readJson(paths.corpus_manifest, "corpus manifest"),
    readJson(paths.score_report, "score report"),
    readJson(paths.confirmatory_gate, "confirmatory gate report"),
    readJson(paths.node_strengthening_recommendations, "node-strengthening recommendations")
  ]);
  const corpus = parseDevelopmentCorpusManifest(corpusValue);
  const score = parseScoreReport(scoreValue);
  const gate = parseGateReport(gateValue);
  const recommendations = parseRecommendations(recommendationsValue);
  const providerAggregate = await resolveProviderAggregate({ cwd, gate, paths });
  const developmentRecovery = await resolveDevelopmentRecovery({ cwd, gate, paths });
  const loaded = await loadPromotionBenchmarkSuite(paths.suite);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(
      "Development suite validation failed: " + loaded.issues.map((issue) => issue.code).join(", ")
    );
  }
  const systemRun = await verifyPromotionBenchmarkSystemRun({
    cwd,
    manifestPath: paths.system_run_manifest,
    suitePath: paths.suite,
    predictionsPath: paths.predictions
  });
  const hashes = await hashArtifacts(paths);

  verifyDevelopmentEvidence({
    cwd,
    paths,
    corpus,
    score,
    gate,
    recommendations,
    systemRun,
    providerAggregate,
    developmentRecovery,
    suite: loaded.suite,
    hashes
  });

  const report: PromotionDevelopmentEvidenceReport = {
    schema_version: "1.2",
    evidence_id: corpus.corpus_id + ":evidence",
    generated_at: gate.generated_at,
    evidence_class: "synthetic_development",
    paper_claim_eligible: false,
    artifact_consistency_verified: true,
    source_artifact_availability: "local_run_only",
    corpus: {
      corpus_id: corpus.corpus_id,
      base_bundle_count: corpus.base_bundle_count,
      case_count: corpus.case_count,
      clean_control_count: corpus.clean_control_count,
      mutation_family_count: corpus.mutation_family_count
    },
    evaluation: {
      score_validation_passed: true,
      prediction_count: score.prediction_count,
      trial_id: systemRun.trial_id,
      systems: [...score.systems]
        .sort((left, right) => left.system_id.localeCompare(right.system_id))
        .map(summarizeSystem)
    },
    real_model_evaluation: providerAggregate ? {
      status: "verified_development_only",
      trial_count: providerAggregate.trial_count,
      prediction_count: providerAggregate.prediction_count,
      execution_environment: providerAggregate.execution_environment,
      execution_receipt_status: providerAggregate.execution_receipt_status,
      external_empirical_evidence_eligible: providerAggregate.external_empirical_evidence_eligible,
      paper_claim_evidence_eligible: false,
      model_artifact_digest: providerAggregate.model_artifact_digest
    } : {
      status: "not_available",
      trial_count: 0,
      prediction_count: 0,
      execution_environment: null,
      execution_receipt_status: null,
      external_empirical_evidence_eligible: false,
      paper_claim_evidence_eligible: false,
      model_artifact_digest: null
    },
    development_recovery_evaluation: developmentRecovery ? {
      status: "verified_development_only",
      original_fault_case_count: developmentRecovery.original_fault_case_count,
      covered_fault_case_count: developmentRecovery.covered_fault_case_count,
      missing_fault_case_count: developmentRecovery.missing_fault_case_count,
      successful_recovery_rate: developmentRecovery.successful_recovery_rate,
      clean_control_regression_rate: developmentRecovery.clean_control_regression_rate,
      paper_claim_evidence_eligible: false,
      paper_scale_eligibility_issue_codes: [...new Set(
        developmentRecovery.issues.map((issue) => issue.code)
      )].sort()
    } : {
      status: "not_available",
      original_fault_case_count: 0,
      covered_fault_case_count: 0,
      missing_fault_case_count: 0,
      successful_recovery_rate: null,
      clean_control_regression_rate: null,
      paper_claim_evidence_eligible: false,
      paper_scale_eligibility_issue_codes: []
    },
    confirmatory_gate: {
      readiness: "blocked_for_paper_scale",
      paper_ready: false,
      claim_class: gate.claim_class,
      evidence_gate_passed: false,
      provider_repetition: gate.provider_repetition,
      recovery: gate.recovery,
      hypotheses: gate.hypotheses,
      blocker_count: gate.blockers.length,
      blockers: countBlockers(gate.blockers)
    },
    node_strengthening: [...recommendations].sort((left, right) => left.node.localeCompare(right.node)),
    source_artifacts: Object.entries(paths)
      .map(([role, artifactPath]) => ({
        role,
        ref: logicalArtifactRef(role),
        sha256: hashes[role]
      }))
      .sort((left, right) => left.role.localeCompare(right.role)),
    evidence_boundary:
      "Synthetic development evidence for evaluator debugging and node strengthening only. "
      + "The source artifacts are local run products bound here by role and SHA-256, not repository-distributed evidence. "
      + (providerAggregate
        ? "The real-model repetitions are verified development executions, but the suite is not human-adjudicated or eligible for paper claims. "
        : "No verified real-model repetition is included. ")
      + (developmentRecovery
        ? "The post-repair rerun is verified only as synthetic development evidence. "
        : "No verified post-repair development rerun is included. ")
      + "This record is not eligible for paper claims."
  };
  await writeJsonFile(outputPath, report);
  return { report, output_path: portableRef(cwd, outputPath) };
}

function verifyDevelopmentEvidence(input: {
  cwd: string;
  paths: Record<string, string>;
  corpus: DevelopmentCorpusManifest;
  score: PromotionBenchmarkScoreReport;
  gate: PromotionConfirmatoryGateReport;
  recommendations: NodeStrengtheningRecommendation[];
  systemRun: PromotionBenchmarkSystemRunManifest;
  providerAggregate: PromotionProviderAggregateManifest | null;
  developmentRecovery: PromotionRecoveryReport | null;
  suite: NonNullable<Awaited<ReturnType<typeof loadPromotionBenchmarkSuite>>["suite"]>;
  hashes: Record<string, string>;
}): void {
  const {
    corpus,
    score,
    gate,
    recommendations,
    systemRun,
    providerAggregate,
    developmentRecovery,
    suite,
    hashes
  } = input;
  const suiteManifest = suite.manifest;
  const baseBundleCount = new Set(suite.cases.map((benchmarkCase) => benchmarkCase.base_bundle_id)).size;
  const cleanControlCount = suite.cases.filter((benchmarkCase) => !benchmarkCase.mutation_family).length;
  const mutationFamilyCount = new Set(
    suite.cases.flatMap((benchmarkCase) => benchmarkCase.mutation_family ? [benchmarkCase.mutation_family] : [])
  ).size;
  const suiteIds = [corpus.corpus_id, suiteManifest.suite_id, systemRun.suite_id, score.suite_id, gate.suite_id];
  if (new Set(suiteIds).size !== 1) throw new Error("Development evidence suite identities do not match.");
  if (suiteManifest.evidence_class !== "synthetic_development"
      || score.evidence_class !== "synthetic_development"
      || suiteManifest.paper_claim_eligible !== false
      || score.paper_claim_eligible !== false) {
    throw new Error("Development evidence must remain synthetic and ineligible for paper claims.");
  }
  if (suiteManifest.adjudication_status !== "unreviewed"
      || suiteManifest.mutation_isolation_status !== "unreviewed"
      || suiteManifest.execution_provenance_status !== "unverified") {
    throw new Error("Development suite must not claim human or execution verification.");
  }
  if (corpus.base_bundle_count !== baseBundleCount
      || corpus.case_count !== suite.cases.length
      || corpus.clean_control_count !== cleanControlCount
      || corpus.mutation_family_count !== mutationFamilyCount
      || score.case_count !== suite.cases.length
      || score.prediction_count !== systemRun.prediction_count + (providerAggregate?.prediction_count || 0)
      || gate.case_count !== suite.cases.length
      || gate.base_bundle_count !== baseBundleCount) {
    throw new Error("Development evidence counts do not match the current artifacts.");
  }
  if (!score.passed || score.validation_issues.length > 0 || !gate.score_validation_passed) {
    throw new Error("Development evidence requires a valid score report.");
  }
  if (gate.readiness !== "blocked_for_paper_scale" || gate.paper_ready || gate.evidence_gate_passed) {
    throw new Error("Development evidence exporter refuses a paper-scale or paper-ready gate decision.");
  }
  const scoredSystems = new Set<string>(score.systems.map((system) => system.system_id));
  const declaredSystems = new Set<string>(systemRun.systems.map((system) => system.system_id));
  if (providerAggregate) declaredSystems.add(providerAggregate.system_id);
  if (scoredSystems.size !== declaredSystems.size
      || [...scoredSystems].some((systemId) => !declaredSystems.has(systemId))) {
    throw new Error("Development score system coverage does not match the system run manifest.");
  }
  if (gate.artifacts.suite_sha256 !== hashes.suite
      || gate.artifacts.input_predictions_sha256 !== hashes.predictions
      || gate.artifacts.score_report_sha256 !== hashes.score_report
      || gate.artifacts.system_run_manifest_sha256 !== hashes.system_run_manifest
      || gate.artifacts.suite_snapshot_sha256 !== systemRun.suite_snapshot_sha256
      || systemRun.suite_sha256 !== hashes.suite
      || systemRun.artifacts.predictions_sha256 !== hashes.predictions) {
    throw new Error("Development evidence hashes do not match the confirmatory gate bindings.");
  }
  assertArtifactRef(input.cwd, gate.artifacts.score_report_ref, input.paths.score_report, "Score report");
  if (!gate.artifacts.system_run_manifest_ref) {
    throw new Error("Confirmatory gate does not bind the deterministic system run manifest.");
  }
  assertArtifactRef(
    input.cwd,
    gate.artifacts.system_run_manifest_ref,
    input.paths.system_run_manifest,
    "System run manifest"
  );
  if (providerAggregate) {
    verifyProviderAggregateBinding({ cwd: input.cwd, paths: input.paths, gate, providerAggregate, suite, hashes });
  } else if (gate.provider_repetition.status === "verified_receipt_distinct") {
    throw new Error("Confirmatory gate reports provider repetition without a verifiable aggregate artifact.");
  }
  if (developmentRecovery) {
    verifyDevelopmentRecoveryBinding({
      cwd: input.cwd,
      paths: input.paths,
      gate,
      recovery: developmentRecovery,
      suite,
      hashes
    });
  } else if (gate.artifacts.recovery_report_ref || gate.artifacts.recovery_report_sha256) {
    throw new Error("Confirmatory gate binds recovery evidence without a verifiable development report.");
  }
  verifyRecommendationCoverage(gate.blockers, recommendations);
}

async function resolveDevelopmentRecovery(input: {
  cwd: string;
  gate: PromotionConfirmatoryGateReport;
  paths: Record<string, string>;
}): Promise<PromotionRecoveryReport | null> {
  const reportRef = input.gate.artifacts.recovery_report_ref;
  const reportSha256 = input.gate.artifacts.recovery_report_sha256;
  if (!reportRef && !reportSha256) return null;
  if (!reportRef || !reportSha256) {
    throw new Error("Development recovery evidence requires a complete gate artifact binding.");
  }
  const reportPath = await resolveExistingInside(input.cwd, reportRef, "Development recovery report");
  input.paths.recovery_report = reportPath;
  return parseDevelopmentRecoveryReport(await readJson(reportPath, "development recovery report"));
}

async function resolveProviderAggregate(input: {
  cwd: string;
  gate: PromotionConfirmatoryGateReport;
  paths: Record<string, string>;
}): Promise<PromotionProviderAggregateManifest | null> {
  if (input.gate.provider_repetition.status !== "verified_receipt_distinct") return null;
  const aggregateRef = input.gate.artifacts.provider_aggregate_ref;
  const aggregateSha256 = input.gate.artifacts.provider_aggregate_sha256;
  if (!aggregateRef || !aggregateSha256) {
    throw new Error("Verified provider repetition requires a bound aggregate artifact.");
  }
  const aggregatePath = await resolveExistingInside(input.cwd, aggregateRef, "Provider aggregate");
  const aggregate = parseProviderAggregate(await readJson(aggregatePath, "provider aggregate"));
  const predictionsPath = await resolveExistingInside(
    input.cwd,
    aggregate.artifacts.predictions_path,
    "Provider aggregate predictions"
  );
  input.paths.provider_aggregate = aggregatePath;
  input.paths.provider_predictions = predictionsPath;
  return aggregate;
}

function verifyProviderAggregateBinding(input: {
  cwd: string;
  paths: Record<string, string>;
  gate: PromotionConfirmatoryGateReport;
  providerAggregate: PromotionProviderAggregateManifest;
  suite: NonNullable<Awaited<ReturnType<typeof loadPromotionBenchmarkSuite>>["suite"]>;
  hashes: Record<string, string>;
}): void {
  const aggregate = input.providerAggregate;
  if (input.gate.artifacts.provider_aggregate_sha256 !== input.hashes.provider_aggregate
      || aggregate.artifacts.predictions_sha256 !== input.hashes.provider_predictions
      || aggregate.suite_id !== input.suite.manifest.suite_id
      || aggregate.suite_sha256 !== input.hashes.suite
      || aggregate.source_suite.manifest_sha256 !== input.hashes.suite
      || aggregate.source_suite.snapshot_sha256 !== input.gate.artifacts.suite_snapshot_sha256
      || aggregate.source_suite.paper_claim_eligible !== false
      || aggregate.paper_claim_evidence_eligible !== false
      || aggregate.real_model_empirical_evidence_eligible !== true
      || aggregate.trial_count !== input.gate.provider_repetition.trial_count
      || aggregate.case_count !== input.suite.cases.length
      || aggregate.prediction_count !== aggregate.case_count * aggregate.trial_count) {
    throw new Error("Development real-model evidence does not match the confirmatory gate bindings.");
  }
  assertArtifactRef(
    input.cwd,
    input.gate.artifacts.provider_aggregate_ref!,
    input.paths.provider_aggregate,
    "Provider aggregate"
  );
  assertArtifactRef(input.cwd, aggregate.source_suite.path, input.paths.suite, "Provider source suite");
  assertArtifactRef(
    input.cwd,
    aggregate.artifacts.predictions_path,
    input.paths.provider_predictions,
    "Provider aggregate predictions"
  );
}

function verifyDevelopmentRecoveryBinding(input: {
  cwd: string;
  paths: Record<string, string>;
  gate: PromotionConfirmatoryGateReport;
  recovery: PromotionRecoveryReport;
  suite: NonNullable<Awaited<ReturnType<typeof loadPromotionBenchmarkSuite>>["suite"]>;
  hashes: Record<string, string>;
}): void {
  const issueCodes = new Set(input.recovery.issues.map((issue) => issue.code));
  const exactEligibilityIssues = issueCodes.size === DEVELOPMENT_RECOVERY_ELIGIBILITY_ISSUES.size
    && [...issueCodes].every((code) => DEVELOPMENT_RECOVERY_ELIGIBILITY_ISSUES.has(code));
  if (input.gate.artifacts.recovery_report_sha256 !== input.hashes.recovery_report
      || input.recovery.passed
      || !exactEligibilityIssues
      || input.recovery.study_id !== input.suite.manifest.suite_id
      || input.recovery.system_id !== input.gate.system_roles.full
      || input.recovery.original_suite_sha256 !== input.hashes.suite
      || input.recovery.original_suite_snapshot_sha256 !== input.gate.artifacts.suite_snapshot_sha256
      || input.recovery.original_predictions_sha256 !== input.hashes.predictions
      || input.recovery.original_system_run_manifest_sha256 !== input.hashes.system_run_manifest
      || input.recovery.missing_fault_families.length > 0
      || input.recovery.missing_fault_case_count !== 0
      || input.recovery.covered_fault_case_count !== input.recovery.original_fault_case_count
      || input.recovery.successful_recovery_rate === null
      || input.recovery.clean_control_regression_rate === null
      || input.recovery.pairs.some((pair) => !pair.valid)
      || input.gate.recovery.status !== "missing_or_invalid"
      || input.gate.recovery.original_fault_case_count !== input.recovery.original_fault_case_count
      || input.gate.recovery.covered_fault_case_count !== input.recovery.covered_fault_case_count
      || input.gate.recovery.missing_fault_case_count !== input.recovery.missing_fault_case_count
      || input.gate.recovery.successful_recovery_rate !== input.recovery.successful_recovery_rate
      || input.gate.recovery.clean_control_regression_rate !== input.recovery.clean_control_regression_rate
      || input.gate.blockers.some((blocker) => blocker.code === "post_repair_evidence_missing")
      || !input.gate.blockers.some((blocker) => blocker.code === "post_repair_evidence_not_verified")) {
    throw new Error("Development recovery evidence does not match the confirmatory gate bindings.");
  }
  assertArtifactRef(
    input.cwd,
    input.gate.artifacts.recovery_report_ref!,
    input.paths.recovery_report,
    "Development recovery report"
  );
}

function verifyRecommendationCoverage(
  blockers: PromotionConfirmatoryGateIssue[],
  recommendations: NodeStrengtheningRecommendation[]
): void {
  const expected = new Map<string, string>();
  for (const blocker of blockers) expected.set("promotion_confirmatory:" + blocker.code, blocker.target_node);
  const observed = new Map<string, string>();
  for (const recommendation of recommendations) {
    for (const diagnosticId of recommendation.diagnostic_ids) {
      if (observed.has(diagnosticId)) throw new Error("Node-strengthening diagnostic is assigned more than once.");
      observed.set(diagnosticId, recommendation.node);
    }
  }
  if (expected.size !== observed.size
      || [...expected].some(([diagnosticId, node]) => observed.get(diagnosticId) !== node)) {
    throw new Error("Node-strengthening recommendations do not cover the gate blockers at their target nodes.");
  }
}

function summarizeSystem(system: PromotionBenchmarkSystemMetrics): PromotionDevelopmentEvidenceReport["evaluation"]["systems"][number] {
  return {
    system_id: system.system_id,
    trial_count: system.trial_count,
    coverage_rate: roundSummaryMetric(system.coverage_rate),
    macro_decision_f1: roundSummaryMetric(system.macro_decision_f1),
    false_paper_ready_rate: roundSummaryMetric(system.false_paper_ready_rate),
    concern_acceptance_conflict_rate: roundSummaryMetric(system.concern_acceptance_conflict_rate),
    blocker_f1: roundSummaryMetric(system.blocker_f1),
    repair_owner_exact_match_accuracy: roundSummaryMetric(system.repair_owner_exact_match_accuracy),
    clean_case_promotion_accuracy: roundSummaryMetric(system.clean_case_promotion_accuracy),
    trace_coverage: roundSummaryMetric(system.trace_coverage),
    mean_latency_ms: roundSummaryMetric(system.mean_latency_ms),
    total_cost_usd: roundSummaryMetric(system.total_cost_usd)
  };
}

function roundSummaryMetric(value: number): number;
function roundSummaryMetric(value: number | null): number | null;
function roundSummaryMetric(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function countBlockers(blockers: PromotionConfirmatoryGateIssue[]): PromotionDevelopmentEvidenceReport["confirmatory_gate"]["blockers"] {
  const counts = new Map<string, { target_node: string; count: number }>();
  for (const blocker of blockers) {
    const current = counts.get(blocker.code);
    if (current && current.target_node !== blocker.target_node) {
      throw new Error("One blocker code cannot target multiple nodes.");
    }
    counts.set(blocker.code, {
      target_node: blocker.target_node,
      count: (current?.count || 0) + 1
    });
  }
  return [...counts.entries()]
    .map(([code, value]) => ({ code, ...value }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

function parseProviderAggregate(value: unknown): PromotionProviderAggregateManifest {
  if (!isRecord(value)
      || value.schema_version !== "1.2"
      || value.status !== "completed"
      || value.protocol !== "manuscript-only-v1"
      || !["openai_responses_api", "ollama_local"].includes(String(value.provider))
      || !["external_real_provider", "local_real_model"].includes(String(value.evidence_class))
      || !["remote_api", "local_runtime"].includes(String(value.execution_environment))
      || !["recorded_not_independently_verified", "local_runtime_hash_bound"]
        .includes(String(value.execution_receipt_status))
      || value.provider_identity_independently_verified !== false
      || typeof value.external_empirical_evidence_eligible !== "boolean"
      || value.real_model_empirical_evidence_eligible !== true
      || value.paper_claim_evidence_eligible !== false
      || value.independent_trial_requirement_met !== true
      || !nonEmptyString(value.suite_id)
      || !sha256Digest(value.suite_sha256)
      || !nonEmptyString(value.system_id)
      || !positiveInteger(value.case_count)
      || value.trial_count !== 3
      || !positiveInteger(value.prediction_count)
      || !isRecord(value.source_suite)
      || !nonEmptyString(value.source_suite.path)
      || !sha256Digest(value.source_suite.manifest_sha256)
      || !sha256Digest(value.source_suite.snapshot_sha256)
      || value.source_suite.paper_claim_eligible !== false
      || !isRecord(value.artifacts)
      || !nonEmptyString(value.artifacts.predictions_path)
      || !sha256Digest(value.artifacts.predictions_sha256)
      || !validDevelopmentProviderContract(value)) {
    throw new Error("Invalid real-model development aggregate manifest.");
  }
  return value as unknown as PromotionProviderAggregateManifest;
}

function parseDevelopmentRecoveryReport(value: unknown): PromotionRecoveryReport {
  if (!isRecord(value)
      || value.schema_version !== "1.1"
      || value.passed !== false
      || !nonEmptyString(value.study_id)
      || !nonEmptyString(value.system_id)
      || !sha256Digest(value.original_suite_sha256)
      || !sha256Digest(value.original_suite_snapshot_sha256)
      || !sha256Digest(value.original_predictions_sha256)
      || !sha256Digest(value.original_system_run_manifest_sha256)
      || !positiveInteger(value.original_fault_case_count)
      || !positiveInteger(value.covered_fault_case_count)
      || !nonNegativeInteger(value.missing_fault_case_count)
      || typeof value.successful_recovery_rate !== "number"
      || typeof value.clean_control_regression_rate !== "number"
      || !Array.isArray(value.missing_fault_families)
      || !Array.isArray(value.issues)
      || value.issues.some((issue) => !isRecord(issue) || !nonEmptyString(issue.code))
      || !Array.isArray(value.pairs)
      || value.pairs.length === 0
      || value.pairs.some((pair) => !isRecord(pair) || typeof pair.valid !== "boolean")) {
    throw new Error("Invalid synthetic development recovery report.");
  }
  return value as unknown as PromotionRecoveryReport;
}

function validDevelopmentProviderContract(value: Record<string, unknown>): boolean {
  if (value.provider === "openai_responses_api") {
    return value.evidence_class === "external_real_provider"
      && value.execution_environment === "remote_api"
      && value.execution_receipt_status === "recorded_not_independently_verified"
      && value.external_empirical_evidence_eligible === true
      && value.model_artifact_digest === null;
  }
  return value.provider === "ollama_local"
    && value.evidence_class === "local_real_model"
    && value.execution_environment === "local_runtime"
    && value.execution_receipt_status === "local_runtime_hash_bound"
    && value.external_empirical_evidence_eligible === false
    && typeof value.model_artifact_digest === "string"
    && /^(?:sha256:)?[a-f0-9]{12,64}$/u.test(value.model_artifact_digest);
}

function parseDevelopmentCorpusManifest(value: unknown): DevelopmentCorpusManifest {
  if (!isRecord(value)
      || value.schema_version !== "1.0"
      || !nonEmptyString(value.corpus_id)
      || value.evidence_class !== "synthetic_development"
      || value.paper_claim_eligible !== false
      || value.adjudication_status !== "unreviewed"
      || value.mutation_isolation_status !== "unreviewed"
      || value.execution_provenance_status !== "unverified"
      || !positiveInteger(value.base_bundle_count)
      || !positiveInteger(value.case_count)
      || !positiveInteger(value.clean_control_count)
      || !positiveInteger(value.mutation_family_count)
      || !nonEmptyString(value.use_boundary)) {
    throw new Error("Invalid synthetic development corpus manifest.");
  }
  return value as unknown as DevelopmentCorpusManifest;
}

function parseScoreReport(value: unknown): PromotionBenchmarkScoreReport {
  if (!isRecord(value)
      || value.schema_version !== "1.0"
      || !nonEmptyString(value.suite_id)
      || value.evidence_class !== "synthetic_development"
      || value.paper_claim_eligible !== false
      || typeof value.passed !== "boolean"
      || !Array.isArray(value.validation_issues)
      || !positiveInteger(value.case_count)
      || !positiveInteger(value.prediction_count)
      || !Array.isArray(value.systems)
      || value.systems.length === 0
      || value.systems.some((system) => !isRecord(system) || !nonEmptyString(system.system_id))) {
    throw new Error("Invalid synthetic development score report.");
  }
  return value as unknown as PromotionBenchmarkScoreReport;
}

function parseGateReport(value: unknown): PromotionConfirmatoryGateReport {
  if (!isRecord(value)
      || value.schema_version !== "1.0"
      || !nonEmptyString(value.generated_at)
      || !nonEmptyString(value.suite_id)
      || value.readiness !== "blocked_for_paper_scale"
      || value.paper_ready !== false
      || value.evidence_gate_passed !== false
      || typeof value.score_validation_passed !== "boolean"
      || !positiveInteger(value.case_count)
      || !positiveInteger(value.base_bundle_count)
      || !Array.isArray(value.hypotheses)
      || !Array.isArray(value.blockers)
      || !isRecord(value.artifacts)) {
    throw new Error("Invalid blocked development confirmatory gate report.");
  }
  return value as unknown as PromotionConfirmatoryGateReport;
}

function parseRecommendations(value: unknown): NodeStrengtheningRecommendation[] {
  if (!isRecord(value) || !Array.isArray(value.recommendations) || value.recommendations.length === 0) {
    throw new Error("Invalid node-strengthening recommendation report.");
  }
  return value.recommendations.map((item, index) => {
    if (!isRecord(item)
        || !nonEmptyString(item.node)
        || !nonEmptyString(item.priority)
        || !Array.isArray(item.diagnostic_ids)
        || item.diagnostic_ids.length === 0
        || item.diagnostic_ids.some((id) => !nonEmptyString(id))
        || !nonEmptyString(item.problem_summary)
        || !nonEmptyString(item.recheck_condition)) {
      throw new Error("Invalid node-strengthening recommendation at index " + index + ".");
    }
    return {
      node: item.node,
      priority: item.priority,
      diagnostic_ids: item.diagnostic_ids as string[],
      problem_summary: item.problem_summary,
      recheck_condition: item.recheck_condition
    };
  });
}

async function hashArtifacts(paths: Record<string, string>): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(
    Object.entries(paths).map(async ([role, artifactPath]) => [role, await sha256File(artifactPath)] as const)
  ));
}

function assertArtifactRef(cwd: string, artifactRef: string, expectedPath: string, label: string): void {
  if (path.resolve(cwd, artifactRef) !== expectedPath) {
    throw new Error(label + " reference does not match the selected artifact.");
  }
}

async function resolveExistingInside(cwd: string, candidate: string, label: string): Promise<string> {
  const absolutePath = path.resolve(cwd, candidate);
  assertInside(cwd, absolutePath, label);
  const realPath = await fs.realpath(absolutePath);
  assertInside(cwd, realPath, label);
  if (!(await fs.stat(realPath)).isFile()) throw new Error(label + " must be a file.");
  return realPath;
}

async function resolveFreshOutputInside(cwd: string, candidate: string): Promise<string> {
  const absolutePath = path.resolve(cwd, candidate);
  assertInside(cwd, absolutePath, "Development evidence output");
  try {
    await fs.lstat(absolutePath);
    throw new Error("Development evidence output already exists: " + portableRef(cwd, absolutePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let ancestor = path.dirname(absolutePath);
  while (ancestor !== path.dirname(ancestor)) {
    try {
      const realAncestor = await fs.realpath(ancestor);
      assertInside(cwd, realAncestor, "Development evidence output parent", true);
      return absolutePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  throw new Error("Development evidence output parent must resolve inside the workspace.");
}

function assertInside(cwd: string, candidate: string, label: string, allowRoot = false): void {
  const relative = path.relative(cwd, candidate);
  if ((!relative && !allowRoot) || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(label + " must be inside the workspace.");
  }
}

async function readJson(filePath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error("Unable to read " + label + ": " + (error instanceof Error ? error.message : String(error)));
  }
}

function sha256File(filePath: string): Promise<string> {
  return fs.readFile(filePath).then((value) => createHash("sha256").update(value).digest("hex"));
}

function portableRef(cwd: string, absolutePath: string): string {
  return path.relative(cwd, absolutePath).replace(/\\/gu, "/");
}

function logicalArtifactRef(role: string): string {
  const names: Record<string, string> = {
    corpus_manifest: "corpus-manifest.json",
    suite: "suite.json",
    predictions: "predictions.jsonl",
    system_run_manifest: "system-run-manifest.json",
    score_report: "promotion-score.json",
    provider_aggregate: "provider-run-aggregate-manifest.json",
    provider_predictions: "provider-predictions.jsonl",
    recovery_report: "promotion-recovery-report.json",
    confirmatory_gate: "promotion-confirmatory-gate.json",
    node_strengthening_recommendations: "node-strengthening-recommendations.json"
  };
  const name = names[role];
  if (!name) throw new Error("Unknown development evidence artifact role: " + role);
  return "<development-run>/" + name;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
