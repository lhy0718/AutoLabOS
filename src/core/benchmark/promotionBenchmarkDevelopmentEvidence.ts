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
  schema_version: "1.0";
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

export async function exportPromotionDevelopmentEvidence(
  input: ExportPromotionDevelopmentEvidenceInput
): Promise<ExportPromotionDevelopmentEvidenceResult> {
  const cwd = path.resolve(input.cwd);
  const paths = {
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
    suite: loaded.suite,
    hashes
  });

  const report: PromotionDevelopmentEvidenceReport = {
    schema_version: "1.0",
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
      "Deterministic synthetic development evidence for evaluator debugging and node strengthening only. "
      + "The source artifacts are local run products bound here by role and SHA-256, not repository-distributed evidence. "
      + "This record is not human-adjudicated, external-real, provider-repeated, recovery-verified, or eligible for paper claims."
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
  suite: NonNullable<Awaited<ReturnType<typeof loadPromotionBenchmarkSuite>>["suite"]>;
  hashes: Record<string, string>;
}): void {
  const { corpus, score, gate, recommendations, systemRun, suite, hashes } = input;
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
      || score.prediction_count !== systemRun.prediction_count
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
  verifyRecommendationCoverage(gate.blockers, recommendations);
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
    coverage_rate: system.coverage_rate,
    macro_decision_f1: system.macro_decision_f1,
    false_paper_ready_rate: system.false_paper_ready_rate,
    concern_acceptance_conflict_rate: system.concern_acceptance_conflict_rate,
    blocker_f1: system.blocker_f1,
    repair_owner_exact_match_accuracy: system.repair_owner_exact_match_accuracy,
    clean_case_promotion_accuracy: system.clean_case_promotion_accuracy,
    trace_coverage: system.trace_coverage,
    mean_latency_ms: system.mean_latency_ms,
    total_cost_usd: system.total_cost_usd
  };
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
