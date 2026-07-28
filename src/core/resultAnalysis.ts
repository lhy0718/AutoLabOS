import YAML from "yaml";

import { evaluateObjectiveMetric, ObjectiveMetricEvaluation, ObjectiveMetricProfile } from "./objectiveMetric.js";
import { ExperimentPortfolio, ExperimentRunManifest } from "./experiments/experimentPortfolio.js";
import { RunVerifierReport } from "./experiments/runVerifierFeedback.js";
import { RunRecord, TransitionRecommendation } from "../types.js";
import {
  adaptResultsTableSchemaV1ToV2,
  validateResultsArtifactV2,
  validateResultsTableSchema,
  type ResultsArtifactV2,
  type ResultsPlanV2,
  type ResultsTableDirection,
  type ResultsTableSchema
} from "./analysis/resultsTableSchema.js";
import type { ResultsArtifactProjectionResult } from "./analysis/resultsArtifactProjection.js";
import type { CandidateMetricScale } from "./effectCriterion.js";
import {
  normalizeEstimatorProtocolDeclaration,
  type EstimatorProtocolDeclaration
} from "./estimatorProtocol.js";
import type { EvidenceAdequacyAssessmentV2 } from "./analysis/evidenceAdequacy.js";

export interface AnalysisMetricEntry {
  key: string;
  value: number;
}

export interface AnalysisComparisonMetric {
  key: string;
  value: number;
  direction?: ResultsTableDirection;
  subject_value?: number;
  reference_value?: number;
  /** @deprecated Compatibility alias for subject_value. */
  primary_value?: number;
  /** @deprecated Compatibility alias for reference_value. */
  baseline_value?: number;
}

export interface AnalysisConditionComparison {
  id: string;
  label: string;
  source: "results_artifact";
  subject_series_id?: string;
  reference_series_id?: string;
  subject_label?: string;
  reference_label?: string;
  metric_id?: string;
  metric_direction?: ResultsTableDirection;
  judgement?: string;
  metrics: AnalysisComparisonMetric[];
  hypothesis_supported?: boolean;
  summary: string;
}

export interface AnalysisResultsArtifactEntityLink {
  id: string;
  link: string;
}

export interface AnalysisResultsArtifactComparison {
  comparison: AnalysisResultsArtifactEntityLink & {
    judgement?: string;
    evidence_refs: string[];
  };
  subject_observation: AnalysisResultsArtifactEntityLink & {
    value: number;
  };
  reference_observation: AnalysisResultsArtifactEntityLink & {
    value: number;
  };
  metric: AnalysisResultsArtifactEntityLink & {
    label: string;
    direction: ResultsTableDirection;
  };
  subject_series: AnalysisResultsArtifactEntityLink & {
    label: string;
  };
  reference_series: AnalysisResultsArtifactEntityLink & {
    label: string;
  };
  delta: number;
  hypothesis_supported?: boolean;
  evidence_links: string[];
  summary: string;
}

export interface AnalysisShortlistedDesign {
  id?: string;
  title?: string;
  summary?: string;
}

export interface AnalysisSelectedDesign {
  id?: string;
  title?: string;
  summary?: string;
  selected_hypothesis_ids: string[];
  metrics: string[];
  baselines: string[];
  implementation_notes: string[];
  evaluation_steps: string[];
  risks: string[];
  resource_notes: string[];
  runtime_guardrail_pct?: number;
  estimator_protocol?: EstimatorProtocolDeclaration;
}

export interface AnalysisPlanContext {
  selected_design?: AnalysisSelectedDesign;
  shortlisted_designs: AnalysisShortlistedDesign[];
  design_notes: string[];
  implementation_notes: string[];
  evaluation_notes: string[];
  assumptions: string[];
}

export interface AnalysisExecutionSummary {
  observation_count: number;
  commands: string[];
  sources: string[];
  latest_log_file?: string;
  stderr_excerpts: string[];
}

export interface AnalysisPaperClaim {
  claim: string;
  evidence: string[];
}

export interface AnalysisFigureSpec {
  id: string;
  title: string;
  path: string;
  metric_keys: string[];
  summary: string;
}

export interface AnalysisSupplementalRun {
  profile: string;
  path?: string;
  mean_score: number;
  objective_evaluation: ObjectiveMetricEvaluation;
  metric_table: AnalysisMetricEntry[];
  sampling_profile?: {
    name?: string;
    total_trials?: number;
    executed_trials?: number;
    cached_trials?: number;
  };
  portfolio?: {
    trial_group_id: string;
    trial_group_label: string;
    execution_model: string;
  };
  summary: string;
}

export interface AnalysisExperimentPortfolioTrialGroup {
  id: string;
  label: string;
  role: "primary" | "supplemental";
  profile?: string;
  group_kind?: "aggregate" | "matrix_slice";
  source_trial_group_id?: string;
  matrix_axes?: Record<string, string>;
  status?: "pass" | "fail" | "skipped";
  expected_trials?: number;
  executed_trials?: number;
  cached_trials?: number;
  metrics_path?: string;
  objective_status?: ObjectiveMetricEvaluation["status"];
  dataset_scope: string[];
  metrics: string[];
  baselines: string[];
  notes: string[];
  summary?: string;
}

export interface AnalysisExperimentPortfolio {
  execution_model: string;
  comparison_axes: string[];
  primary_trial_group_id: string;
  total_expected_trials?: number;
  executed_trials?: number;
  cached_trials?: number;
  trial_groups: AnalysisExperimentPortfolioTrialGroup[];
}

export interface AnalysisExternalComparison {
  id: string;
  label: string;
  summary: string;
  path?: string;
  metrics: AnalysisComparisonMetric[];
}

export interface AnalysisVerifierFeedback {
  status: RunVerifierReport["status"];
  trigger: RunVerifierReport["trigger"];
  stage: RunVerifierReport["stage"];
  summary: string;
  suggested_next_action?: string;
  command?: string;
  metrics_path?: string;
  log_file?: string;
}

export interface AnalysisConfidenceInterval {
  metric_key: string;
  comparison_id?: string;
  estimand?: "metric_value" | "effect_delta";
  metric_scale?: CandidateMetricScale;
  trial_source?: "fresh_executed" | "mixed" | "cached";
  method?: string;
  label: string;
  lower: number;
  upper: number;
  level: number;
  sample_size?: number;
  source: "metrics" | "condition_metrics" | "supplemental_runs";
  profile?: string;
  summary: string;
}

export interface AnalysisStatisticalEffect {
  comparison_id: string;
  metric_key: string;
  delta: number;
  direction: "positive" | "negative" | "neutral";
  summary: string;
}

export interface AnalysisStatisticalSummary {
  total_trials?: number;
  executed_trials?: number;
  cached_trials?: number;
  confidence_intervals: AnalysisConfidenceInterval[];
  stability_metrics: AnalysisMetricEntry[];
  effect_estimates: AnalysisStatisticalEffect[];
  notes: string[];
}

export interface AnalysisFailureCategory {
  id: string;
  category: "runtime_failure" | "objective_gap" | "missing_artifact" | "evidence_gap" | "scope_limit";
  severity: "high" | "medium" | "low";
  status: "observed" | "risk";
  summary: string;
  evidence: string[];
  recommended_action?: string;
}

export interface AnalysisSynthesis {
  source: "llm" | "fallback";
  discussion_points: string[];
  failure_analysis: string[];
  follow_up_actions: string[];
  confidence_statement: string;
  fallback_reason?: string;
}

export interface AnalysisReport {
  analysis_version: 1;
  generated_at: string;
  mean_score: number;
  metrics: Record<string, unknown>;
  objective_metric: {
    raw: string;
    evaluation: ObjectiveMetricEvaluation;
    profile: {
      source: ObjectiveMetricProfile["source"];
      primary_metric?: string;
      preferred_metric_keys: string[];
      direction?: ObjectiveMetricProfile["direction"];
      comparator?: ObjectiveMetricProfile["comparator"];
      target_value?: number;
      target_description?: string;
      unit?: string;
      scale?: ObjectiveMetricProfile["scale"];
      target_unit?: string;
      target_scale?: ObjectiveMetricProfile["targetScale"];
      comparison?: ObjectiveMetricProfile["comparison"];
      candidate_contract?: ObjectiveMetricProfile["candidate_contract"];
      delta_contract?: ObjectiveMetricProfile["delta_contract"];
      analysis_focus: string[];
      paper_emphasis: string[];
      assumptions: string[];
    };
  };
  overview: {
    objective_status: ObjectiveMetricEvaluation["status"];
    objective_summary: string;
    matched_metric_key?: string;
    observed_value?: number;
    target_description?: string;
    selected_design_title?: string;
    execution_runs: number;
    top_metric?: AnalysisMetricEntry;
  };
  plan_context: AnalysisPlanContext;
  experiment_portfolio?: AnalysisExperimentPortfolio;
  metric_table: AnalysisMetricEntry[];
  results_artifact: ResultsArtifactV2;
  results_plan?: ResultsPlanV2;
  primary_comparison_id?: string;
  /** @deprecated Historical read compatibility only. New runtime reports do not write this field. */
  results_table?: ResultsTableSchema;
  condition_comparisons: AnalysisConditionComparison[];
  execution_summary: AnalysisExecutionSummary;
  primary_findings: string[];
  limitations: string[];
  warnings: string[];
  paper_claims: AnalysisPaperClaim[];
  figure_specs: AnalysisFigureSpec[];
  verifier_feedback?: AnalysisVerifierFeedback;
  supplemental_runs: AnalysisSupplementalRun[];
  supplemental_expectation?: {
    applicable: boolean;
    profiles: string[];
    reason?: string;
  };
  external_comparisons: AnalysisExternalComparison[];
  statistical_summary: AnalysisStatisticalSummary;
  evidence_adequacy_assessment?: EvidenceAdequacyAssessmentV2;
  failure_taxonomy: AnalysisFailureCategory[];
  synthesis?: AnalysisSynthesis;
  transition_recommendation?: TransitionRecommendation;
}

const PERSISTED_METRICS_MAX_DEPTH = 6;
const PERSISTED_METRICS_MAX_ARRAY_ITEMS = 24;
const PERSISTED_METRICS_MAX_OBJECT_ENTRIES = 64;
const PERSISTED_METRICS_MAX_STRING_LENGTH = 2_000;
const OMIT_PROJECTED_VALUE = Symbol("omit_projected_value");

interface BoundedMetricsProjectionState {
  active: WeakSet<object>;
  omittedPaths: Set<string>;
}

export function buildPersistedAnalysisMetricsProjection(
  metrics: Record<string, unknown>,
  sourceMetricsRef: string
): Record<string, unknown> {
  const state: BoundedMetricsProjectionState = {
    active: new WeakSet<object>(),
    omittedPaths: new Set<string>()
  };
  const bounded = projectBoundedMetricsValue(metrics, "", 0, state);
  const projected =
    bounded && bounded !== OMIT_PROJECTED_VALUE && typeof bounded === "object" && !Array.isArray(bounded)
      ? bounded as Record<string, unknown>
      : {};

  projected.analysis_artifact_projection = {
    schema_version: "1.0",
    source_metrics_ref: sourceMetricsRef,
    omitted_fields: [...state.omittedPaths].sort(),
    limits: {
      max_depth: PERSISTED_METRICS_MAX_DEPTH,
      max_array_items: PERSISTED_METRICS_MAX_ARRAY_ITEMS,
      max_object_entries: PERSISTED_METRICS_MAX_OBJECT_ENTRIES,
      max_string_length: PERSISTED_METRICS_MAX_STRING_LENGTH
    }
  };
  return projected;
}

function projectBoundedMetricsValue(
  value: unknown,
  path: string,
  depth: number,
  state: BoundedMetricsProjectionState
): unknown | typeof OMIT_PROJECTED_VALUE {
  if (isResultsArtifactProjectionValue(value)) {
    state.omittedPaths.add(path || "<root>");
    return OMIT_PROJECTED_VALUE;
  }
  if (typeof value === "string") {
    if (value.length <= PERSISTED_METRICS_MAX_STRING_LENGTH) {
      return value;
    }
    state.omittedPaths.add(path || "<root>");
    return `${value.slice(0, PERSISTED_METRICS_MAX_STRING_LENGTH)}...`;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (state.active.has(value)) {
    state.omittedPaths.add(path || "<root>");
    return "[circular]";
  }
  if (depth >= PERSISTED_METRICS_MAX_DEPTH) {
    state.omittedPaths.add(path || "<root>");
    return Array.isArray(value) ? [] : {};
  }

  state.active.add(value);
  if (Array.isArray(value)) {
    if (value.length > PERSISTED_METRICS_MAX_ARRAY_ITEMS) {
      state.omittedPaths.add(`${path || "<root>"}[${PERSISTED_METRICS_MAX_ARRAY_ITEMS}:]`);
    }
    const projected = value
      .slice(0, PERSISTED_METRICS_MAX_ARRAY_ITEMS)
      .map((item, index) => projectBoundedMetricsValue(item, `${path}[${index}]`, depth + 1, state))
      .filter((item) => item !== OMIT_PROJECTED_VALUE);
    state.active.delete(value);
    return projected;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > PERSISTED_METRICS_MAX_OBJECT_ENTRIES) {
    state.omittedPaths.add(`${path || "<root>"}.{remaining}`);
  }
  const projected: Record<string, unknown> = {};
  for (const [key, child] of entries.slice(0, PERSISTED_METRICS_MAX_OBJECT_ENTRIES)) {
    const childPath = path ? `${path}.${key}` : key;
    const childProjection = projectBoundedMetricsValue(child, childPath, depth + 1, state);
    if (childProjection !== OMIT_PROJECTED_VALUE) {
      projected[key] = childProjection;
    }
  }
  state.active.delete(value);
  return projected;
}

function isResultsArtifactProjectionValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.schema_version === "2.0"
    && Array.isArray(record.metrics)
    && Array.isArray(record.series)
    && Array.isArray(record.observations)
    && Array.isArray(record.comparisons)
    && validateResultsArtifactV2(value).valid;
}

interface ExecutionObservation {
  command?: string;
  source?: string;
  status?: string;
  stderr?: string;
  log_file?: string;
}

interface BuildAnalysisReportArgs {
  run: Pick<RunRecord, "objectiveMetric">;
  metrics: Record<string, unknown>;
  objectiveProfile: ObjectiveMetricProfile;
  objectiveEvaluation: ObjectiveMetricEvaluation;
  experimentPlanRaw?: string;
  observationsRaw?: string;
  performanceFigurePath?: string;
  inputWarnings?: string[];
  runVerifierReport?: RunVerifierReport;
  experimentPortfolio?: ExperimentPortfolio;
  runManifest?: ExperimentRunManifest;
  supplementalMetrics?: Array<{
    profile: string;
    path?: string;
    metrics: Record<string, unknown>;
  }>;
  supplementalExpectation?: {
    applicable: boolean;
    profiles: string[];
    reason?: string;
  };
  recentPaperComparison?: Record<string, unknown>;
  recentPaperComparisonPath?: string;
  resultsPlan?: ResultsPlanV2;
  primaryComparisonId?: string;
  resultsArtifactProjection?: ResultsArtifactProjectionResult;
}

const DEFAULT_FIGURE_PATH = "figures/performance.svg";

function resolveCanonicalResultsArtifactProjection(
  metrics: Record<string, unknown>,
  candidate?: ResultsArtifactProjectionResult
): ResultsArtifactProjectionResult {
  if (candidate?.source === "explicit_results_artifact") {
    const validation = validateResultsArtifactV2(candidate.artifact);
    if (validation.valid) {
      return candidate;
    }
    return {
      artifact: createEmptyResultsArtifact(),
      source: "explicit_results_artifact",
      valid: false,
      blocked: true,
      issues: uniqueStrings([...candidate.issues, ...validation.issues]),
      warnings: [...candidate.warnings]
    };
  }

  if (Object.hasOwn(metrics, "results_artifact")) {
    const validation = validateResultsArtifactV2(metrics.results_artifact);
    if (validation.valid) {
      return {
        artifact: metrics.results_artifact as ResultsArtifactV2,
        source: "explicit_results_artifact",
        valid: true,
        blocked: false,
        issues: [],
        warnings: []
      };
    }
    return {
      artifact: createEmptyResultsArtifact(),
      source: "explicit_results_artifact",
      valid: false,
      blocked: true,
      issues: validation.issues,
      warnings: []
    };
  }

  return {
    artifact: createEmptyResultsArtifact(),
    source: "generic_metrics",
    valid: true,
    blocked: false,
    issues: [],
    warnings: [
      "No explicit ResultsArtifactV2 was available; generic metrics were retained without synthesizing canonical observations or comparisons."
    ]
  };
}

function createEmptyResultsArtifact(): ResultsArtifactV2 {
  return {
    schema_version: "2.0",
    metrics: [],
    series: [],
    observations: [],
    comparisons: []
  };
}

export function buildAnalysisReport(args: BuildAnalysisReportArgs): AnalysisReport {
  const resultsArtifactProjection = resolveCanonicalResultsArtifactProjection(
    args.metrics,
    args.resultsArtifactProjection
  );
  const objectiveMetricIds = buildExactObjectiveMetricIds(
    args.objectiveEvaluation,
    args.objectiveProfile
  );
  const metricTable = sortMetricTable(
    buildAnalysisMetricTable(args.metrics, resultsArtifactProjection),
    objectiveMetricIds
  );
  const topMetric = summarizeExactObjectiveMetric(metricTable, objectiveMetricIds);
  const meanScore = topMetric?.value ?? 0;
  const rawPlanContext = parseExperimentPlan(args.experimentPlanRaw || "");
  const executionSummary = summarizeObservations(args.observationsRaw || "");
  const conditionComparisons = buildConditionComparisons(resultsArtifactProjection.artifact);
  const primaryResultsComparison = resolvePrimaryResultsArtifactComparison(
    resultsArtifactProjection.artifact,
    args.primaryComparisonId
  );
  const explicitPrimaryComparisonId = args.primaryComparisonId === primaryResultsComparison?.comparison.id
    ? args.primaryComparisonId
    : undefined;
  const warnings = buildWarnings({
    objectiveEvaluation: args.objectiveEvaluation,
    metricTable,
    executionSummary,
    planContext: rawPlanContext,
    inputWarnings: [
      ...(args.inputWarnings || []),
      ...resultsArtifactProjection.issues,
      ...resultsArtifactProjection.warnings
    ],
    verifierFeedback: args.runVerifierReport,
    supplementalRuns: args.supplementalMetrics || [],
    supplementalExpectation: args.supplementalExpectation
  });
  const verifierFeedback = normalizeVerifierFeedback(args.runVerifierReport);
  const rawExperimentPortfolio = buildExperimentPortfolioSummary(
    args.experimentPortfolio || args.runManifest?.portfolio,
    args.runManifest
  );
  const supplementalRuns = buildSupplementalRuns({
    runs: args.supplementalMetrics || [],
    runManifest: args.runManifest,
    objectiveProfile: args.objectiveProfile,
    rawObjectiveMetric: args.objectiveProfile.raw
  });
  const externalComparisons = buildExternalComparisons({
    metrics: args.metrics,
    recentPaperComparison: args.recentPaperComparison,
    recentPaperComparisonPath: args.recentPaperComparisonPath,
    objectiveEvaluation: args.objectiveEvaluation
  });
  const statisticalSummary = buildStatisticalSummary({
    metrics: args.metrics,
    resultsArtifact: resultsArtifactProjection.artifact,
    objectiveMetricIds,
    primaryResultsComparison,
    supplementalMetrics: args.supplementalMetrics || [],
    supplementalExpectation: args.supplementalExpectation
  });
  const planContext = rawPlanContext;
  const experimentPortfolio = rawExperimentPortfolio;
  const limitations = buildLimitations(planContext, warnings);
  const executionRuns =
    typeof experimentPortfolio?.executed_trials === "number"
      ? experimentPortfolio.executed_trials
      : typeof statisticalSummary.executed_trials === "number"
      ? statisticalSummary.executed_trials
      : executionSummary.observation_count;
  const failureTaxonomy = buildFailureTaxonomy({
    objectiveEvaluation: args.objectiveEvaluation,
    metricTable,
    planContext,
    warnings,
    verifierFeedback,
    supplementalRuns,
    statisticalSummary,
    supplementalExpectation: args.supplementalExpectation
  });
  const figureSpecs = buildFigureSpecs(
    metricTable,
    objectiveMetricIds,
    args.performanceFigurePath || DEFAULT_FIGURE_PATH
  );
  const primaryFindings = buildPrimaryFindings({
    objectiveEvaluation: args.objectiveEvaluation,
    planContext,
    executionSummary,
    topMetric,
    primaryResultsComparison,
    warnings,
    verifierFeedback,
    supplementalRuns,
    externalComparisons,
    statisticalSummary,
    failureTaxonomy,
    experimentPortfolio
  });
  const paperClaims = buildPaperClaims({
    objectiveSummary: args.objectiveEvaluation.summary,
    planContext,
    primaryResultsComparison,
    externalComparisons
  });

  return {
    analysis_version: 1,
    generated_at: new Date().toISOString(),
    mean_score: meanScore,
    metrics: args.metrics,
    objective_metric: {
      raw: args.objectiveProfile.raw,
      evaluation: args.objectiveEvaluation,
      profile: {
        source: args.objectiveProfile.source,
        primary_metric: args.objectiveProfile.primaryMetric,
        preferred_metric_keys: args.objectiveProfile.preferredMetricKeys,
        direction: args.objectiveProfile.direction,
        comparator: args.objectiveProfile.comparator,
        target_value: args.objectiveProfile.targetValue,
        target_description: args.objectiveProfile.targetDescription,
        unit: args.objectiveProfile.unit,
        scale: args.objectiveProfile.scale,
        target_unit: args.objectiveProfile.targetUnit,
        target_scale: args.objectiveProfile.targetScale,
        comparison: args.objectiveProfile.comparison
          ? { ...args.objectiveProfile.comparison }
          : undefined,
        candidate_contract: args.objectiveProfile.candidate_contract
          ? {
              ...args.objectiveProfile.candidate_contract,
              effect_criterion: { ...args.objectiveProfile.candidate_contract.effect_criterion }
            }
          : undefined,
        delta_contract: args.objectiveProfile.delta_contract
          ? { ...args.objectiveProfile.delta_contract }
          : undefined,
        analysis_focus: args.objectiveProfile.analysisFocus,
        paper_emphasis: args.objectiveProfile.paperEmphasis,
        assumptions: args.objectiveProfile.assumptions
      }
    },
    overview: {
      objective_status: args.objectiveEvaluation.status,
      objective_summary: args.objectiveEvaluation.summary,
      matched_metric_key: args.objectiveEvaluation.matchedMetricKey,
      observed_value: args.objectiveEvaluation.observedValue,
      target_description: args.objectiveProfile.targetDescription,
      selected_design_title: planContext.selected_design?.title,
      execution_runs: executionRuns,
      top_metric: topMetric
    },
    plan_context: planContext,
    experiment_portfolio: experimentPortfolio,
    metric_table: metricTable,
    results_artifact: resultsArtifactProjection.artifact,
    ...(args.resultsPlan ? { results_plan: args.resultsPlan } : {}),
    ...(explicitPrimaryComparisonId ? { primary_comparison_id: explicitPrimaryComparisonId } : {}),
    condition_comparisons: conditionComparisons,
    execution_summary: executionSummary,
    primary_findings: primaryFindings,
    limitations,
    warnings,
    paper_claims: paperClaims,
    figure_specs: figureSpecs,
    verifier_feedback: verifierFeedback,
    supplemental_runs: supplementalRuns,
    supplemental_expectation: args.supplementalExpectation,
    external_comparisons: externalComparisons,
    statistical_summary: statisticalSummary,
    failure_taxonomy: failureTaxonomy
  };
}

export function renderPerformanceFigureSvg(report: AnalysisReport): string | undefined {
  const selectedMetrics = pickFigureMetrics(
    report.metric_table,
    uniqueStrings([
      report.objective_metric.evaluation.matchedMetricKey,
      report.objective_metric.profile.primary_metric,
      ...report.objective_metric.profile.preferred_metric_keys
    ])
  );
  if (selectedMetrics.length === 0) {
    return undefined;
  }

  const width = 720;
  const height = 160 + selectedMetrics.length * 56;
  const maxValue = Math.max(...selectedMetrics.map((entry) => Math.abs(entry.value)), 1);
  const left = 220;
  const right = 650;
  const barArea = right - left;

  const bars = selectedMetrics
    .map((entry, index) => {
      const y = 88 + index * 56;
      const normalized = Math.max(0, Math.min(1, Math.abs(entry.value) / maxValue));
      const barWidth = Math.max(8, Math.round(barArea * normalized));
      const fill =
        entry.key === report.objective_metric.evaluation.matchedMetricKey ? "#0F766E" : "#2563EB";
      const label = escapeXml(shortenKey(entry.key));
      return [
        `<text x="28" y="${y + 22}" font-size="16" fill="#0F172A">${label}</text>`,
        `<rect x="${left}" y="${y}" width="${barArea}" height="22" rx="8" fill="#E2E8F0" />`,
        `<rect x="${left}" y="${y}" width="${barWidth}" height="22" rx="8" fill="${fill}" />`,
        `<text x="${left + barWidth + 12}" y="${y + 17}" font-size="15" fill="#334155">${formatMetricValue(entry.value)}</text>`
      ].join("");
    })
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#F8FAFC" />',
    '<text x="28" y="40" font-size="26" font-weight="700" fill="#0F172A">Experiment Metric Overview</text>',
    `<text x="28" y="66" font-size="15" fill="#475569">${escapeXml(report.overview.objective_summary)}</text>`,
    bars,
    "</svg>"
  ].join("");
}

export function parseAnalysisReport(raw: string): AnalysisReport | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const report = parsed as Record<string, unknown>;
    if (report.analysis_version !== 1) {
      return undefined;
    }
    if (Object.hasOwn(report, "results_artifact")) {
      if (!validateResultsArtifactV2(report.results_artifact).valid) {
        return undefined;
      }
      return useResultsArtifactAsCanonicalSource(
        report,
        report.results_artifact as ResultsArtifactV2
      );
    }

    const historicalValidation = validateResultsTableSchema(report.results_table);
    if (!historicalValidation.valid) {
      return undefined;
    }
    return useResultsArtifactAsCanonicalSource(
      report,
      adaptResultsTableSchemaV1ToV2(historicalValidation.rows)
    );
  } catch {
    return undefined;
  }
}

function useResultsArtifactAsCanonicalSource(
  report: Record<string, unknown>,
  artifact: ResultsArtifactV2
): AnalysisReport {
  const explicitPrimaryComparisonId = typeof report.primary_comparison_id === "string"
    ? report.primary_comparison_id
    : undefined;
  const primaryResultsComparison = resolvePrimaryResultsArtifactComparison(
    artifact,
    explicitPrimaryComparisonId
  );
  const canonicalPrimaryComparisonId = explicitPrimaryComparisonId === primaryResultsComparison?.comparison.id
    ? explicitPrimaryComparisonId
    : undefined;
  const statisticalSummary = asRecord(report.statistical_summary);
  const objectiveMetricIds = readExactObjectiveMetricIdsFromReport(report);
  const effectEstimates = buildStatisticalEffects(artifact, objectiveMetricIds);
  const primaryEffect = primaryResultsComparison
    ? effectEstimates.find((item) => item.comparison_id === primaryResultsComparison.comparison.id)
    : undefined;
  const confidenceIntervals = Array.isArray(statisticalSummary.confidence_intervals)
    ? statisticalSummary.confidence_intervals as AnalysisConfidenceInterval[]
    : [];
  const stabilityMetrics = Array.isArray(statisticalSummary.stability_metrics)
    ? statisticalSummary.stability_metrics as AnalysisMetricEntry[]
    : [];
  const reportWithoutPrimaryComparison = { ...report };
  delete reportWithoutPrimaryComparison.primary_comparison_id;
  const objectiveMetric = asRecord(report.objective_metric);
  const objectiveEvaluation = asRecord(objectiveMetric.evaluation);
  const overview = asRecord(report.overview);
  const planContext = asRecord(report.plan_context) as unknown as AnalysisPlanContext;
  const externalComparisons = Array.isArray(report.external_comparisons)
    ? report.external_comparisons as AnalysisExternalComparison[]
    : [];
  const paperClaims = buildPaperClaims({
    objectiveSummary: asString(objectiveEvaluation.summary) || asString(overview.objective_summary),
    planContext,
    primaryResultsComparison,
    externalComparisons
  });

  return {
    ...reportWithoutPrimaryComparison,
    results_artifact: artifact,
    ...(canonicalPrimaryComparisonId ? { primary_comparison_id: canonicalPrimaryComparisonId } : {}),
    condition_comparisons: buildConditionComparisons(artifact),
    paper_claims: paperClaims,
    ...(Object.keys(statisticalSummary).length > 0
      ? {
        statistical_summary: {
          ...statisticalSummary,
          effect_estimates: effectEstimates,
          notes: buildStatisticalNotes({
            totalTrials: asNumber(statisticalSummary.total_trials),
            executedTrials: asNumber(statisticalSummary.executed_trials),
            cachedTrials: asNumber(statisticalSummary.cached_trials),
            confidenceIntervals,
            stabilityMetrics,
            primaryEffect
          })
        }
      }
      : {})
  } as unknown as AnalysisReport;
}

function readExactObjectiveMetricIdsFromReport(
  report: Record<string, unknown>
): string[] {
  const objectiveMetric = asRecord(report.objective_metric);
  const evaluation = asRecord(objectiveMetric.evaluation);
  const profile = asRecord(objectiveMetric.profile);
  return uniqueStrings([
    asString(evaluation.matchedMetricKey),
    asString(evaluation.primaryMetric),
    ...asStringList(evaluation.preferredMetricKeys),
    asString(profile.primary_metric),
    ...asStringList(profile.preferred_metric_keys)
  ]);
}

function parseExperimentPlan(raw: string): AnalysisPlanContext {
  if (!raw.trim()) {
    return {
      shortlisted_designs: [],
      design_notes: [],
      implementation_notes: [],
      evaluation_notes: [],
      assumptions: []
    };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    return {
      shortlisted_designs: [],
      design_notes: [],
      implementation_notes: [],
      evaluation_notes: [],
      assumptions: []
    };
  }

  const root = asRecord(parsed);
  const selectedDesignRaw = asRecord(root.selected_design);
  const confirmatory = asRecord(selectedDesignRaw.confirmatory_extension);
  const estimatorProtocol = normalizeEstimatorProtocolDeclaration(
    selectedDesignRaw.estimator_protocol
  );
  const selectedDesign =
    Object.keys(selectedDesignRaw).length > 0
      ? {
          id: asString(selectedDesignRaw.id),
          title: asString(selectedDesignRaw.title),
          summary: asString(selectedDesignRaw.summary),
          selected_hypothesis_ids: asStringList(root.selected_hypothesis_ids),
          metrics: uniqueStrings([
            ...asStringList(selectedDesignRaw.metrics),
            ...asStringList(confirmatory.additional_metrics_and_protocol)
          ]),
          baselines: uniqueStrings([
            ...asStringList(selectedDesignRaw.baselines),
            ...asStringList(confirmatory.additional_baselines)
          ]),
          implementation_notes: asStringList(selectedDesignRaw.implementation_notes),
          evaluation_steps: uniqueStrings([
            ...asStringList(selectedDesignRaw.evaluation_steps),
            ...asStringList(confirmatory.evaluation_steps)
          ]),
          risks: filterResolvedRuntimeThresholdRisks(
            uniqueStrings([
            ...asStringList(selectedDesignRaw.risks),
            ...asStringList(confirmatory.risks)
            ]),
            extractRuntimeGuardrailPct(selectedDesignRaw, confirmatory)
          ),
          resource_notes: uniqueStrings([
            ...asStringList(selectedDesignRaw.resource_notes),
            ...asStringList(confirmatory.resource_notes)
          ]),
          runtime_guardrail_pct: extractRuntimeGuardrailPct(selectedDesignRaw, confirmatory),
          ...(estimatorProtocol.valid && estimatorProtocol.protocol
            ? { estimator_protocol: estimatorProtocol.protocol }
            : {})
        }
      : undefined;

  return {
    selected_design: selectedDesign,
    shortlisted_designs: asArray(root.shortlisted_designs)
      .map((item) => asRecord(item))
      .map((item) => ({
        id: asString(item.id),
        title: asString(item.title),
        summary: asString(item.summary)
      }))
      .filter((item) => item.id || item.title || item.summary),
    design_notes: asStringList(asRecord(root.constraints).design_notes),
    implementation_notes: asStringList(asRecord(root.constraints).implementation_notes),
    evaluation_notes: asStringList(asRecord(root.constraints).evaluation_notes),
    assumptions: asStringList(asRecord(root.constraints).assumptions)
  };
}

function summarizeObservations(raw: string): AnalysisExecutionSummary {
  const observations = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as ExecutionObservation;
      } catch {
        return undefined;
      }
    })
    .filter((item): item is ExecutionObservation => item !== undefined);

  return {
    observation_count: observations.length,
    commands: uniqueStrings(observations.map((item) => item.command).filter((item): item is string => Boolean(item))),
    sources: uniqueStrings(observations.map((item) => item.source).filter((item): item is string => Boolean(item))),
    latest_log_file: observations.map((item) => item.log_file).filter((item): item is string => Boolean(item)).at(-1),
    stderr_excerpts: uniqueStrings(
      observations
        .map((item) => truncateOneLine(item.stderr || "", 160))
        .filter((item) => Boolean(item))
    )
  };
}

function buildConditionComparisons(
  artifact: ResultsArtifactV2
): AnalysisConditionComparison[] {
  return resolveResultsArtifactComparisons(artifact).map((resolved) => {
    return {
      id: resolved.comparison.id,
      label: `${resolved.subject_series.label} vs ${resolved.reference_series.label}`,
      source: "results_artifact",
      subject_series_id: resolved.subject_series.id,
      reference_series_id: resolved.reference_series.id,
      subject_label: resolved.subject_series.label,
      reference_label: resolved.reference_series.label,
      metric_id: resolved.metric.id,
      metric_direction: resolved.metric.direction,
      judgement: resolved.comparison.judgement,
      metrics: [
        {
          key: resolved.metric.id,
          value: resolved.delta,
          direction: resolved.metric.direction,
          subject_value: resolved.subject_observation.value,
          reference_value: resolved.reference_observation.value,
          primary_value: resolved.subject_observation.value,
          baseline_value: resolved.reference_observation.value
        }
      ],
      hypothesis_supported: resolved.hypothesis_supported,
      summary: resolved.summary
    };
  });
}

export function resolveResultsArtifactComparisons(
  artifact: unknown
): AnalysisResultsArtifactComparison[] {
  if (!validateResultsArtifactV2(artifact).valid) {
    return [];
  }

  const canonicalArtifact = artifact as ResultsArtifactV2;
  const observationsById = new Map(
    canonicalArtifact.observations.map((observation, index) => [
      observation.id,
      { observation, index }
    ] as const)
  );
  const metricsById = new Map(
    canonicalArtifact.metrics.map((metric, index) => [metric.id, { metric, index }] as const)
  );
  const seriesById = new Map(
    canonicalArtifact.series.map((series, index) => [series.id, { series, index }] as const)
  );

  return canonicalArtifact.comparisons
    .map((comparison, comparisonIndex): AnalysisResultsArtifactComparison | undefined => {
      const subjectEntry = observationsById.get(comparison.subject_observation_id);
      const referenceEntry = observationsById.get(comparison.reference_observation_id);
      if (!subjectEntry || !referenceEntry) {
        return undefined;
      }
      if (subjectEntry.observation.metric_id !== referenceEntry.observation.metric_id) {
        return undefined;
      }
      const metricEntry = metricsById.get(subjectEntry.observation.metric_id);
      const subjectSeriesEntry = seriesById.get(subjectEntry.observation.series_id);
      const referenceSeriesEntry = seriesById.get(referenceEntry.observation.series_id);
      if (!metricEntry || !subjectSeriesEntry || !referenceSeriesEntry) {
        return undefined;
      }

      const comparisonLink = resultsArtifactEntityLink("comparisons", comparisonIndex);
      const subjectObservationLink = resultsArtifactEntityLink("observations", subjectEntry.index);
      const referenceObservationLink = resultsArtifactEntityLink("observations", referenceEntry.index);
      const metricLink = resultsArtifactEntityLink("metrics", metricEntry.index);
      const subjectSeriesLink = resultsArtifactEntityLink("series", subjectSeriesEntry.index);
      const referenceSeriesLink = resultsArtifactEntityLink("series", referenceSeriesEntry.index);
      const hypothesisSupported = hypothesisSupportFromJudgement(comparison.judgement);
      const judgementSummary = comparison.judgement ? ` Judgement: ${comparison.judgement}.` : "";
      const summary = `${subjectSeriesEntry.series.label} vs ${referenceSeriesEntry.series.label} on ${metricEntry.metric.label}: ${formatMetricValue(subjectEntry.observation.value)} vs ${formatMetricValue(referenceEntry.observation.value)} (delta ${formatMetricValue(comparison.delta)}).${judgementSummary}`;

      return {
        comparison: {
          id: comparison.id,
          link: comparisonLink,
          judgement: comparison.judgement,
          evidence_refs: [...(comparison.evidence_refs || [])]
        },
        subject_observation: {
          id: subjectEntry.observation.id,
          link: subjectObservationLink,
          value: subjectEntry.observation.value
        },
        reference_observation: {
          id: referenceEntry.observation.id,
          link: referenceObservationLink,
          value: referenceEntry.observation.value
        },
        metric: {
          id: metricEntry.metric.id,
          link: metricLink,
          label: metricEntry.metric.label,
          direction: metricEntry.metric.direction
        },
        subject_series: {
          id: subjectSeriesEntry.series.id,
          link: subjectSeriesLink,
          label: subjectSeriesEntry.series.label
        },
        reference_series: {
          id: referenceSeriesEntry.series.id,
          link: referenceSeriesLink,
          label: referenceSeriesEntry.series.label
        },
        delta: comparison.delta,
        hypothesis_supported: hypothesisSupported,
        evidence_links: uniqueStrings([
          comparisonLink,
          subjectObservationLink,
          referenceObservationLink,
          metricLink,
          subjectSeriesLink,
          referenceSeriesLink,
          ...(comparison.evidence_refs || []),
          ...(subjectEntry.observation.evidence_refs || []),
          ...(referenceEntry.observation.evidence_refs || [])
        ]),
        summary
      };
    })
    .filter((item): item is AnalysisResultsArtifactComparison => item !== undefined)
    .sort((left, right) => left.comparison.id.localeCompare(right.comparison.id));
}

export function resolvePrimaryResultsArtifactComparison(
  artifact: unknown,
  explicitPrimaryComparisonId?: unknown
): AnalysisResultsArtifactComparison | undefined {
  const comparisons = resolveResultsArtifactComparisons(artifact);
  if (typeof explicitPrimaryComparisonId === "string" && explicitPrimaryComparisonId.length > 0) {
    return comparisons.find((item) => item.comparison.id === explicitPrimaryComparisonId);
  }
  return comparisons.length === 1 ? comparisons[0] : undefined;
}

function resultsArtifactEntityLink(collection: string, index: number): string {
  return `result_analysis.json#/results_artifact/${collection}/${index}`;
}

function hypothesisSupportFromJudgement(
  judgement: string | undefined
): boolean | undefined {
  if (judgement === "supported") {
    return true;
  }
  if (judgement === "not_supported") {
    return false;
  }
  return undefined;
}

function buildWarnings(args: {
  objectiveEvaluation: ObjectiveMetricEvaluation;
  metricTable: AnalysisMetricEntry[];
  executionSummary: AnalysisExecutionSummary;
  planContext: AnalysisPlanContext;
  inputWarnings: string[];
  verifierFeedback?: RunVerifierReport;
  supplementalRuns: Array<{ profile: string; metrics: Record<string, unknown> }>;
  supplementalExpectation?: {
    applicable: boolean;
    profiles: string[];
    reason?: string;
  };
}): string[] {
  const warnings: string[] = [...args.inputWarnings];
  if (args.metricTable.length === 0) {
    warnings.push("No numeric metrics were available for structured result analysis.");
  }
  if (args.executionSummary.observation_count === 0) {
    warnings.push("No execution observations were available; analysis is based on metrics.json alone.");
  }
  if (!args.planContext.selected_design) {
    warnings.push("Experiment plan context was missing, so design-aware comparisons are limited.");
  }
  if (args.executionSummary.stderr_excerpts.some((item) => !isBenignExecutionStderr(item))) {
    warnings.push(`Execution stderr was recorded: ${args.executionSummary.stderr_excerpts[0]}`);
  }
  if (args.objectiveEvaluation.status === "missing" || args.objectiveEvaluation.status === "unknown") {
    warnings.push(args.objectiveEvaluation.summary);
  }
  if (args.verifierFeedback?.status === "fail") {
    warnings.push(`Run verifier reported failure at ${args.verifierFeedback.stage}: ${args.verifierFeedback.summary}`);
  }
  if (args.supplementalRuns.length === 0 && args.supplementalExpectation?.applicable !== false) {
    warnings.push("No supplemental quick_check or confirmatory metrics were available for deeper comparison.");
  }
  return warnings;
}

function isBenignExecutionStderr(excerpt: string): boolean {
  const normalized = excerpt.toLowerCase();
  if (!normalized.trim()) {
    return true;
  }
  const benignSignals = [
    "deprecated",
    "loading weights",
    "it/s",
    "accelerate hooks",
    "you shouldn't move a model that is dispatched"
  ];
  return benignSignals.some((signal) => normalized.includes(signal));
}

function buildLimitations(
  planContext: AnalysisPlanContext,
  warnings: string[]
): string[] {
  const designRisks = planContext.selected_design?.risks || [];
  const resourceNotes = planContext.selected_design?.resource_notes || [];
  return uniqueStrings([
    ...designRisks,
    ...resourceNotes,
    ...planContext.assumptions,
    ...warnings
  ])
    .slice(0, 6);
}

function buildPrimaryFindings(args: {
  objectiveEvaluation: ObjectiveMetricEvaluation;
  planContext: AnalysisPlanContext;
  executionSummary: AnalysisExecutionSummary;
  topMetric?: AnalysisMetricEntry;
  primaryResultsComparison?: AnalysisResultsArtifactComparison;
  warnings: string[];
  verifierFeedback?: AnalysisVerifierFeedback;
  supplementalRuns: AnalysisSupplementalRun[];
  externalComparisons: AnalysisExternalComparison[];
  statisticalSummary: AnalysisStatisticalSummary;
  failureTaxonomy: AnalysisFailureCategory[];
  experimentPortfolio?: AnalysisExperimentPortfolio;
}): string[] {
  const findings: string[] = [args.objectiveEvaluation.summary];
  const executedTrials = args.statisticalSummary.executed_trials;

  if (args.planContext.selected_design?.title) {
    findings.push(
      `Selected design "${args.planContext.selected_design.title}" was analyzed${
        typeof executedTrials === "number"
          ? executedTrials > 0
            ? ` with ${executedTrials} executed trial(s).`
            : args.executionSummary.observation_count > 0
              ? ` with ${args.executionSummary.observation_count} recorded runner observation(s) and 0 executed trial(s).`
              : "."
          : args.executionSummary.observation_count > 0
            ? ` with ${args.executionSummary.observation_count} recorded runner observation(s).`
            : "."
      }`
    );
  }

  if (typeof args.planContext.selected_design?.runtime_guardrail_pct === "number") {
    findings.push(
      `The selected design preset a practical runtime-increase guardrail of ${formatMetricValue(
        args.planContext.selected_design.runtime_guardrail_pct
      )}% before analysis.`
    );
  }

  if ((args.experimentPortfolio?.trial_groups.length || 0) > 1) {
    findings.push(
      `Execution portfolio (${args.experimentPortfolio?.execution_model}) tracked ${
        args.experimentPortfolio?.trial_groups.length || 0
      } trial group(s): ${args.experimentPortfolio?.trial_groups
        .map((group) => `${group.profile || group.label} ${group.status || "planned"}`)
        .join(", ")}.`
    );
  }

  if (args.primaryResultsComparison) {
    findings.push(args.primaryResultsComparison.summary);
  }

  if (args.supplementalRuns.length > 0) {
    findings.push(args.supplementalRuns[0].summary);
  }

  if (args.externalComparisons.length > 0) {
    findings.push(args.externalComparisons[0].summary);
  }

  if (args.statisticalSummary.notes[0]) {
    findings.push(args.statisticalSummary.notes[0]);
  }

  if (args.failureTaxonomy[0]) {
    findings.push(args.failureTaxonomy[0].summary);
  }

  if (args.topMetric && args.topMetric.key !== args.objectiveEvaluation.matchedMetricKey) {
    findings.push(
      `Additional metric highlight: ${args.topMetric.key}=${formatMetricValue(args.topMetric.value)}.`
    );
  }

  if (findings.length < 3 && args.executionSummary.commands[0]) {
    findings.push(`Primary execution command: ${args.executionSummary.commands[0]}.`);
  }

  if (findings.length < 3 && args.warnings[0]) {
    findings.push(`Analysis warning: ${args.warnings[0]}`);
  }

  if (findings.length < 4 && args.verifierFeedback?.summary) {
    findings.push(`Run verifier: ${args.verifierFeedback.summary}`);
  }

  return uniqueStrings(findings);
}

function buildPaperClaims(args: {
  objectiveSummary?: string;
  planContext: AnalysisPlanContext;
  primaryResultsComparison?: AnalysisResultsArtifactComparison;
  externalComparisons: AnalysisExternalComparison[];
}): AnalysisPaperClaim[] {
  const claims: AnalysisPaperClaim[] = [];

  if (args.objectiveSummary) {
    claims.push({
      claim: args.objectiveSummary,
      evidence: ["objective_metric.evaluation.summary"]
    });
  }

  if (args.planContext.selected_design?.summary) {
    claims.push({
      claim: `Experiment design summary: ${args.planContext.selected_design.summary}`,
      evidence: ["plan_context.selected_design.summary"]
    });
  }

  if (args.primaryResultsComparison) {
    claims.push({
      claim: args.primaryResultsComparison.summary,
      evidence: [...args.primaryResultsComparison.evidence_links]
    });
  }

  if (args.externalComparisons[0]) {
    claims.push({
      claim: args.externalComparisons[0].summary,
      evidence: ["external_comparisons[0].summary"]
    });
  }

  return claims.slice(0, 4);
}

function buildFigureSpecs(
  metricTable: AnalysisMetricEntry[],
  objectiveMetricIds: string[],
  performanceFigurePath: string
): AnalysisFigureSpec[] {
  const selectedMetrics = pickFigureMetrics(metricTable, objectiveMetricIds);
  if (selectedMetrics.length === 0) {
    return [];
  }

  return [
    {
      id: "performance_overview",
      title: "Performance overview",
      path: performanceFigurePath,
      metric_keys: selectedMetrics.map((item) => item.key),
      summary: `Visualizes ${selectedMetrics.map((item) => item.key).join(", ")}.`
    }
  ];
}

function pickFigureMetrics(
  metricTable: AnalysisMetricEntry[],
  objectiveMetricIds: string[]
): AnalysisMetricEntry[] {
  return objectiveMetricIds
    .map((metricId) => summarizeMetricById(metricTable, metricId))
    .filter((item): item is AnalysisMetricEntry => item !== undefined)
    .slice(0, 5);
}

function sortMetricTable(
  metricTable: AnalysisMetricEntry[],
  objectiveMetricIds: string[]
): AnalysisMetricEntry[] {
  return [...metricTable].sort((left, right) => {
    const leftRank = exactMetricRank(left.key, objectiveMetricIds);
    const rightRank = exactMetricRank(right.key, objectiveMetricIds);
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    const keyOrder = left.key.localeCompare(right.key);
    if (keyOrder !== 0) {
      return keyOrder;
    }
    return left.value - right.value;
  });
}

function normalizeVerifierFeedback(report: RunVerifierReport | undefined): AnalysisVerifierFeedback | undefined {
  if (!report) {
    return undefined;
  }
  return {
    status: report.status,
    trigger: report.trigger,
    stage: report.stage,
    summary: report.summary,
    suggested_next_action: report.suggested_next_action,
    command: report.command,
    metrics_path: report.metrics_path,
    log_file: report.log_file
  };
}

function buildSupplementalRuns(args: {
  runs: Array<{ profile: string; path?: string; metrics: Record<string, unknown> }>;
  runManifest?: ExperimentRunManifest;
  objectiveProfile: ObjectiveMetricProfile;
  rawObjectiveMetric: string;
}): AnalysisSupplementalRun[] {
  const portfolioGroupsByProfile = new Map(
    (args.runManifest?.trial_groups || [])
      .filter(
        (group) =>
          group.role === "supplemental"
          && group.group_kind !== "matrix_slice"
          && typeof group.profile === "string"
      )
      .map((group) => [group.profile as string, group])
  );
  return args.runs
    .map((item) => {
      const objectiveEvaluation = evaluateObjectiveMetric(
        item.metrics,
        args.objectiveProfile,
        args.rawObjectiveMetric
      );
      const objectiveMetricIds = buildExactObjectiveMetricIds(
        objectiveEvaluation,
        args.objectiveProfile
      );
      const metricTable = sortMetricTable(
        flattenNumericMetrics(item.metrics),
        objectiveMetricIds
      );
      const objectiveMetric = summarizeExactObjectiveMetric(
        metricTable,
        objectiveMetricIds
      );
      const sampling = asRecord(item.metrics.sampling_profile);
      const portfolioGroup = portfolioGroupsByProfile.get(item.profile);
      return {
        profile: item.profile,
        path: portfolioGroup?.metrics_path || item.path,
        mean_score: objectiveMetric?.value ?? 0,
        objective_evaluation: objectiveEvaluation,
        metric_table: metricTable.slice(0, 6),
        sampling_profile: {
          name: asString(sampling.name),
          total_trials: asNumber(sampling.total_trials),
          executed_trials: asNumber(sampling.executed_trials),
          cached_trials: asNumber(sampling.cached_trials)
        },
        portfolio: portfolioGroup && args.runManifest
          ? {
              trial_group_id: portfolioGroup.id,
              trial_group_label: portfolioGroup.label,
              execution_model: args.runManifest.execution_model
            }
          : undefined,
        summary: buildSupplementalRunSummary(
          item.profile,
          objectiveEvaluation,
          sampling,
          portfolioGroup?.metrics_path || item.path
        )
      };
    })
    .sort((left, right) => left.profile.localeCompare(right.profile));
}

function buildExperimentPortfolioSummary(
  portfolio: ExperimentPortfolio | undefined,
  runManifest: ExperimentRunManifest | undefined
): AnalysisExperimentPortfolio | undefined {
  if (!portfolio) {
    return undefined;
  }

  const manifestGroups = new Map(
    (runManifest?.trial_groups || []).map((group) => [group.id, group])
  );

  return {
    execution_model: runManifest?.execution_model || portfolio.execution_model,
    comparison_axes: portfolio.comparison_axes,
    primary_trial_group_id: portfolio.primary_trial_group_id,
    total_expected_trials: runManifest?.total_expected_trials ?? portfolio.total_expected_trials,
    executed_trials: runManifest?.executed_trials,
    cached_trials: runManifest?.cached_trials,
    trial_groups: portfolio.trial_groups.map((group) => {
      const execution = manifestGroups.get(group.id);
      return {
        id: group.id,
        label: group.label,
        role: group.role,
        profile: group.profile,
        group_kind: group.group_kind,
        source_trial_group_id: group.source_trial_group_id,
        matrix_axes: group.matrix_axes,
        status: execution?.status,
        expected_trials: execution?.expected_trials ?? group.expected_trials,
        executed_trials: execution?.sampling_profile?.executed_trials,
        cached_trials: execution?.sampling_profile?.cached_trials,
        metrics_path: execution?.metrics_path,
        objective_status: execution?.objective_evaluation?.status,
        dataset_scope: group.dataset_scope,
        metrics: group.metrics,
        baselines: group.baselines,
        notes: group.notes,
        summary: execution?.summary
      };
    })
  };
}

function buildExternalComparisons(args: {
  metrics: Record<string, unknown>;
  recentPaperComparison?: Record<string, unknown>;
  recentPaperComparisonPath?: string;
  objectiveEvaluation: ObjectiveMetricEvaluation;
}): AnalysisExternalComparison[] {
  const comparisons: AnalysisExternalComparison[] = [];
  const recentComparison = args.recentPaperComparison || asRecord(args.metrics.recent_paper_reproducibility);
  if (Object.keys(recentComparison).length === 0) {
    return comparisons;
  }

  const bestRecentScore = asNumber(recentComparison.best_recent_score);
  const comparisonCount = asNumber(recentComparison.comparison_count);
  const paperWindow = asRecord(recentComparison.paper_year_window);
  const windowFrom = asNumber(paperWindow.from);
  const windowTo = asNumber(paperWindow.to);
  const observed = args.objectiveEvaluation.observedValue;
  const gap =
    typeof observed === "number" && typeof bestRecentScore === "number"
      ? Number((observed - bestRecentScore).toFixed(4))
      : undefined;

  const metrics: AnalysisComparisonMetric[] = [];
  if (typeof bestRecentScore === "number") {
    metrics.push({ key: "best_recent_score", value: bestRecentScore });
  }
  if (typeof gap === "number") {
    metrics.push({ key: "current_gap", value: gap });
  }
  if (typeof comparisonCount === "number") {
    metrics.push({ key: "comparison_count", value: comparisonCount });
  }

  const windowLabel =
    typeof windowFrom === "number" && typeof windowTo === "number" ? `${windowFrom}-${windowTo}` : "recent years";
  const summaryParts = [
    typeof bestRecentScore === "number"
      ? `Best recent paper score=${formatMetricValue(bestRecentScore)}`
      : undefined,
    typeof gap === "number" ? `current gap=${formatMetricValue(gap)}` : undefined,
    typeof comparisonCount === "number" ? `comparison_count=${comparisonCount}` : undefined
  ].filter((item): item is string => Boolean(item));

  comparisons.push({
    id: "recent_paper_reproducibility",
    label: `Recent paper comparison (${windowLabel})`,
    summary: `Recent paper comparison (${windowLabel}): ${summaryParts.join(", ")}.`,
    path: args.recentPaperComparisonPath,
    metrics
  });

  return comparisons;
}

function buildStatisticalSummary(args: {
  metrics: Record<string, unknown>;
  resultsArtifact: ResultsArtifactV2;
  objectiveMetricIds: string[];
  primaryResultsComparison?: AnalysisResultsArtifactComparison;
  supplementalMetrics: Array<{ profile: string; path?: string; metrics: Record<string, unknown> }>;
  supplementalExpectation?: {
    applicable: boolean;
    profiles: string[];
    reason?: string;
  };
}): AnalysisStatisticalSummary {
  const sampling = asRecord(args.metrics.sampling_profile);
  const totalTrials =
    asNumber(sampling.total_trials) ??
    firstNumber(args.metrics, [
      "total_trials",
      "required_run_count",
      "required_trial_count",
      "planned_run_count",
      "planned_trial_count",
      "expected_run_count",
      "expected_trial_count"
    ]);
  const primaryExecutedTrials =
    asNumber(sampling.executed_trials) ??
    firstNumber(args.metrics, [
      "executed_trials",
      "completed_run_count",
      "completed_trial_count",
      "successful_run_count",
      "successful_trial_count"
    ]);
  const supplementalExecutedTrials = args.supplementalMetrics.reduce((total, item) => {
    const supplementalSampling = asRecord(item.metrics.sampling_profile);
    const explicitExecuted = asNumber(supplementalSampling.executed_trials);
    if (typeof explicitExecuted === "number") {
      return total + explicitExecuted;
    }
    const status = asString(item.metrics.status)?.toLowerCase();
    const objectiveStatus = asString(asRecord(item.metrics.objective_evaluation).status)?.toLowerCase();
    const completed =
      !status ||
      /^(ok|success|completed|complete|pass|passed)$/u.test(status) ||
      /^(met|observed|pass|passed)$/u.test(objectiveStatus || "");
    return completed ? total + 1 : total;
  }, 0);
  const executedTrials =
    typeof primaryExecutedTrials === "number"
      ? primaryExecutedTrials + supplementalExecutedTrials
      : supplementalExecutedTrials > 0
        ? 1 + supplementalExecutedTrials
        : undefined;
  const cachedTrials =
    asNumber(sampling.cached_trials) ??
    firstNumber(args.metrics, ["cached_trials", "cached_run_count", "cached_trial_count"]);
  const preferredKeys = args.objectiveMetricIds;

  const confidenceIntervals = sortConfidenceIntervals([
    ...extractConfidenceIntervals({
      value: args.metrics,
      sampleSize: totalTrials
    }),
    ...args.supplementalMetrics.flatMap((item) =>
      extractConfidenceIntervals({
        value: item.metrics,
        sampleSize: asNumber(asRecord(item.metrics.sampling_profile).total_trials),
        source: "supplemental_runs",
        profile: item.profile
      })
    )
  ], preferredKeys).slice(0, 8);

  const stabilityMetrics = pickStabilityMetrics(args.metrics);
  const effectEstimates = buildStatisticalEffects(
    args.resultsArtifact,
    args.objectiveMetricIds
  );
  const primaryEffect = args.primaryResultsComparison
    ? effectEstimates.find((item) => item.comparison_id === args.primaryResultsComparison?.comparison.id)
    : undefined;
  const notes = buildStatisticalNotes({
    totalTrials,
    executedTrials,
    cachedTrials,
    confidenceIntervals,
    stabilityMetrics,
    primaryEffect,
    supplementalExpectation: args.supplementalExpectation
  });

  return {
    total_trials: totalTrials,
    executed_trials: executedTrials,
    cached_trials: cachedTrials,
    confidence_intervals: confidenceIntervals,
    stability_metrics: stabilityMetrics,
    effect_estimates: effectEstimates,
    notes
  };
}

function buildFailureTaxonomy(args: {
  objectiveEvaluation: ObjectiveMetricEvaluation;
  metricTable: AnalysisMetricEntry[];
  planContext: AnalysisPlanContext;
  warnings: string[];
  verifierFeedback?: AnalysisVerifierFeedback;
  supplementalRuns: AnalysisSupplementalRun[];
  statisticalSummary: AnalysisStatisticalSummary;
  supplementalExpectation?: {
    applicable: boolean;
    profiles: string[];
    reason?: string;
  };
}): AnalysisFailureCategory[] {
  const categories: AnalysisFailureCategory[] = [];

  if (args.verifierFeedback?.status === "fail") {
    categories.push({
      id: "runtime_failure",
      category: "runtime_failure",
      severity: "high",
      status: "observed",
      summary: `Runtime verification failed at ${args.verifierFeedback.stage}: ${args.verifierFeedback.summary}`,
      evidence: ["verifier_feedback.summary"],
      recommended_action: args.verifierFeedback.suggested_next_action
    });
  }

  if (args.metricTable.length === 0) {
    categories.push({
      id: "missing_numeric_metrics",
      category: "missing_artifact",
      severity: "high",
      status: "observed",
      summary: "Structured analysis could not find usable numeric metrics in the run artifacts.",
      evidence: ["warnings"],
      recommended_action: "Ensure metrics.json contains numeric metrics before running analyze_results."
    });
  }

  if (args.objectiveEvaluation.status === "not_met") {
    categories.push({
      id: "objective_not_met",
      category: "objective_gap",
      severity: "high",
      status: "observed",
      summary: args.objectiveEvaluation.summary,
      evidence: ["objective_metric.evaluation.summary"],
      recommended_action: "Revise the primary condition or experiment setup and rerun until the target metric is satisfied."
    });
  }

  if (args.supplementalRuns.length === 0 && args.supplementalExpectation?.applicable !== false) {
    const hasStructuredRobustness =
      args.statisticalSummary.confidence_intervals.length > 0 ||
      args.statisticalSummary.stability_metrics.length > 0;
    categories.push({
      id: "supplemental_coverage_gap",
      category: "evidence_gap",
      severity: hasStructuredRobustness ? "low" : "medium",
      status: "risk",
      summary: hasStructuredRobustness
        ? "Supplemental confirmatory and quick-check runs are missing, but structured uncertainty or stability evidence is available for bounded claims."
        : "Supplemental confirmatory and quick-check runs are missing, so robustness across sampling profiles is still unverified.",
      evidence: ["warnings"],
      recommended_action: "Run confirmatory and quick-check profiles to validate stability."
    });
  }

  if (args.statisticalSummary.confidence_intervals.length === 0) {
    categories.push({
      id: "missing_confidence_intervals",
      category: "evidence_gap",
      severity: "medium",
      status: "risk",
      summary: "Confidence intervals are missing for the primary metrics, which limits statistical confidence.",
      evidence: ["statistical_summary.notes"],
      recommended_action: "Record repeated-trial confidence intervals for the matched metric."
    });
  }

  const scopeRisk = [
    ...(args.planContext.selected_design?.risks || []),
    ...(args.planContext.selected_design?.resource_notes || []),
    ...args.planContext.assumptions
  ][0];
  if (scopeRisk) {
    categories.push({
      id: "scope_limit",
      category: "scope_limit",
      severity: "low",
      status: "risk",
      summary: `Scope limitation: ${scopeRisk}`,
      evidence: [
        "plan_context.selected_design.risks",
        "plan_context.selected_design.resource_notes",
        "plan_context.assumptions"
      ],
      recommended_action: "Expand the evaluation scope or document the limitation explicitly in the discussion."
    });
  }

  return categories.slice(0, 6);
}

function extractRuntimeGuardrailPct(
  selectedDesignRaw: Record<string, unknown>,
  confirmatory: Record<string, unknown>
): number | undefined {
  const searchSpace = [
    ...asStringList(selectedDesignRaw.evaluation_steps),
    ...asStringList(selectedDesignRaw.risks),
    ...asStringList(confirmatory.evaluation_steps),
    ...asStringList(confirmatory.risks)
  ];
  for (const line of searchSpace) {
    const match = /(?:threshold|guardrail)[^0-9]{0,40}(\d{1,3})\s*percent/iu.exec(line);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
  }
  return undefined;
}

function filterResolvedRuntimeThresholdRisks(risks: string[], runtimeGuardrailPct?: number): string[] {
  if (typeof runtimeGuardrailPct !== "number") {
    return risks;
  }
  return risks.filter((risk) => !/threshold .*specified before analysis|runtime increase .*specified before analysis/iu.test(risk));
}

function extractConfidenceIntervals(args: {
  value: Record<string, unknown>;
  prefix?: string;
  sampleSize?: number;
  source?: "metrics" | "supplemental_runs";
  profile?: string;
}): AnalysisConfidenceInterval[] {
  const intervals: AnalysisConfidenceInterval[] = [];
  const directInterval = readDirectConfidenceInterval({
    value: args.value,
    prefix: args.prefix,
    sampleSize: args.sampleSize,
    source: args.source,
    profile: args.profile
  });
  if (directInterval) {
    intervals.push(directInterval);
  }

  for (const [key, raw] of Object.entries(args.value)) {
    const nextPrefix = args.prefix ? `${args.prefix}.${key}` : key;
    const match = key.match(/^ci(\d+)_([\w.-]+)$/iu);
    if (match && Array.isArray(raw) && raw.length === 2) {
      const lower = asNumber(raw[0]);
      const upper = asNumber(raw[1]);
      const level = normalizeConfidenceLevel(asNumber(match[1]));
      if (typeof lower === "number" && typeof upper === "number" && typeof level === "number") {
        const metricKey = args.prefix ? `${args.prefix}.${match[2]}` : match[2];
        const source = args.source || "metrics";
        const label = humanizeMetricLabel(metricKey);
        intervals.push({
          metric_key: metricKey,
          label,
          lower,
          upper,
          level,
          sample_size: args.sampleSize,
          source,
          profile: args.profile,
          summary: `${label} ${formatConfidenceIntervalPercent(level)}% CI [${formatMetricValue(lower)}, ${formatMetricValue(upper)}]${
            typeof args.sampleSize === "number" ? ` over n=${args.sampleSize}` : ""
          }.`
        });
      }
      continue;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      intervals.push(
        ...extractConfidenceIntervals({
          value: raw as Record<string, unknown>,
          prefix: nextPrefix,
          sampleSize: args.sampleSize,
          source: args.source,
          profile: args.profile
        })
      );
    }
  }

  return intervals;
}

function readDirectConfidenceInterval(args: {
  value: Record<string, unknown>;
  prefix?: string;
  sampleSize?: number;
  source?: "metrics" | "supplemental_runs";
  profile?: string;
}): AnalysisConfidenceInterval | undefined {
  const lower = firstNumber(args.value, [
    "ci_low",
    "ci95_low",
    "ci_lower",
    "lower",
    "low",
    "bootstrap_ci95_low",
    "lower_bound"
  ]);
  const upper = firstNumber(args.value, [
    "ci_high",
    "ci95_high",
    "ci_upper",
    "upper",
    "high",
    "bootstrap_ci95_high",
    "upper_bound"
  ]);
  if (typeof lower !== "number" || typeof upper !== "number") {
    return undefined;
  }

  const rawLevel =
    firstNumber(args.value, ["confidence_level", "ci_level", "level"]) ??
    inferConfidenceLevel(args.prefix);
  const level = normalizeConfidenceLevel(rawLevel) ?? 0.95;
  const metricKey =
    asString(args.value.metric_key) ||
    asString(args.value.metric) ||
    inferConfidenceIntervalMetricKey(args.prefix);
  const comparisonId = asString(args.value.comparison_id);
  const estimand = args.value.estimand === "effect_delta" || args.value.estimand === "metric_value"
    ? args.value.estimand
    : undefined;
  const metricScale = isCandidateMetricScale(args.value.metric_scale)
    ? args.value.metric_scale
    : undefined;
  const trialSource = isConfidenceIntervalTrialSource(args.value.trial_source)
    ? args.value.trial_source
    : undefined;
  const method =
    asString(args.value.uncertainty_method)
    || asString(args.value.ci_method)
    || asString(args.value.method);
  const sampleSize = asNumber(args.value.sample_size) ?? args.sampleSize;
  const source = args.source || "metrics";
  const label = humanizeMetricLabel(metricKey);

  return {
    metric_key: metricKey,
    ...(comparisonId ? { comparison_id: comparisonId } : {}),
    ...(estimand ? { estimand } : {}),
    ...(metricScale ? { metric_scale: metricScale } : {}),
    ...(trialSource ? { trial_source: trialSource } : {}),
    ...(method ? { method } : {}),
    label,
    lower,
    upper,
    level,
    sample_size: sampleSize,
    source,
    profile: args.profile,
    summary: `${label} ${formatConfidenceIntervalPercent(level)}% CI [${formatMetricValue(lower)}, ${formatMetricValue(upper)}]${
      typeof sampleSize === "number" ? ` over n=${sampleSize}` : ""
    }.`
  };
}

function isCandidateMetricScale(value: unknown): value is CandidateMetricScale {
  return value === "raw"
    || value === "proportion"
    || value === "percent"
    || value === "percentage_point";
}

function isConfidenceIntervalTrialSource(
  value: unknown
): value is "fresh_executed" | "mixed" | "cached" {
  return value === "fresh_executed" || value === "mixed" || value === "cached";
}

function normalizeConfidenceLevel(level: number | undefined): number | undefined {
  if (typeof level !== "number" || !Number.isFinite(level)) {
    return undefined;
  }
  return level > 1 ? Number((level / 100).toFixed(4)) : level;
}

function formatConfidenceIntervalPercent(level: number): string {
  const percent = level <= 1 ? level * 100 : level;
  return Number(percent.toFixed(2)).toString();
}

function firstNumber(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const numberValue = asNumber(value[key]);
    if (typeof numberValue === "number") {
      return numberValue;
    }
  }
  return undefined;
}

function inferConfidenceLevel(prefix: string | undefined): number | undefined {
  const match = prefix?.match(/(?:^|[._-])ci(\d{2,3})(?:[._-]|$)/iu);
  if (!match) {
    return undefined;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferConfidenceIntervalMetricKey(prefix: string | undefined): string {
  if (!prefix) {
    return "metric";
  }
  const parts = prefix.split(".");
  const lastPart = parts.at(-1)?.toLowerCase() ?? "";
  if (
    /bootstrap.*mean.*ci|mean.*confidence.*interval|pooled.*bootstrap|bootstrap.*pooled|bootstrap.*ci|confidence.*interval|^ci\d*$/u.test(
      lastPart
    )
  ) {
    parts.pop();
    return parts.join(".") || "metric";
  }
  return prefix;
}

function sortConfidenceIntervals(
  intervals: AnalysisConfidenceInterval[],
  preferredKeys: string[]
): AnalysisConfidenceInterval[] {
  return [...intervals].sort((left, right) => {
    const leftPreferred = isPreferredMetricKey(left.metric_key, preferredKeys) ? 1 : 0;
    const rightPreferred = isPreferredMetricKey(right.metric_key, preferredKeys) ? 1 : 0;
    if (leftPreferred !== rightPreferred) {
      return rightPreferred - leftPreferred;
    }
    const leftSource = left.source === "metrics" ? 2 : left.source === "condition_metrics" ? 1 : 0;
    const rightSource = right.source === "metrics" ? 2 : right.source === "condition_metrics" ? 1 : 0;
    if (leftSource !== rightSource) {
      return rightSource - leftSource;
    }
    return left.metric_key.localeCompare(right.metric_key);
  });
}

function pickStabilityMetrics(metrics: Record<string, unknown>): AnalysisMetricEntry[] {
  return flattenNumericMetrics(asRecord(metrics.stability_metrics))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function buildStatisticalEffects(
  artifact: ResultsArtifactV2,
  objectiveMetricIds: string[]
): AnalysisStatisticalEffect[] {
  return resolveResultsArtifactComparisons(artifact)
    .map((resolved) => {
      const direction = classifyEffectDirection(
        resolved.metric.direction,
        resolved.delta
      );
      const comparisonLabel = `${resolved.subject_series.label} vs ${resolved.reference_series.label}`;
      const summary =
        direction === "neutral"
          ? `${comparisonLabel} is neutral on ${resolved.metric.label} (delta ${formatMetricValue(resolved.delta)}).`
          : direction === "positive"
            ? `${comparisonLabel} improves ${resolved.metric.label} by ${formatMetricValue(Math.abs(resolved.delta))}.`
            : `${comparisonLabel} trails on ${resolved.metric.label} by ${formatMetricValue(Math.abs(resolved.delta))}.`;
      return {
        comparison_id: resolved.comparison.id,
        metric_key: resolved.metric.id,
        delta: resolved.delta,
        direction,
        summary
      };
    })
    .sort((left, right) => {
      const leftRank = exactMetricRank(left.metric_key, objectiveMetricIds);
      const rightRank = exactMetricRank(right.metric_key, objectiveMetricIds);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.comparison_id.localeCompare(right.comparison_id);
    });
}

function classifyEffectDirection(
  metricDirection: ResultsTableDirection,
  delta: number
): "positive" | "negative" | "neutral" {
  if (delta === 0) {
    return "neutral";
  }
  if (metricDirection === "lower_better") {
    return delta < 0 ? "positive" : "negative";
  }
  return delta > 0 ? "positive" : "negative";
}

function buildStatisticalNotes(args: {
  totalTrials?: number;
  executedTrials?: number;
  cachedTrials?: number;
  confidenceIntervals: AnalysisConfidenceInterval[];
  stabilityMetrics: AnalysisMetricEntry[];
  primaryEffect?: AnalysisStatisticalEffect;
  supplementalExpectation?: {
    applicable: boolean;
    profiles: string[];
    reason?: string;
  };
}): string[] {
  const notes: string[] = [];

  if (typeof args.totalTrials === "number") {
    notes.push(
      `Sampling profile: total_trials=${args.totalTrials}, executed_trials=${args.executedTrials ?? 0}, cached_trials=${args.cachedTrials ?? 0}.`
    );
  }

  if (args.confidenceIntervals[0]) {
    notes.push(args.confidenceIntervals[0].summary);
  }

  if (args.stabilityMetrics.length > 0) {
    notes.push(
      `Stability signals: ${args.stabilityMetrics
        .slice(0, 3)
        .map((item) => `${item.key}=${formatMetricValue(item.value)}`)
        .join(", ")}.`
    );
  }

  if (args.primaryEffect) {
    notes.push(args.primaryEffect.summary);
  }

  if (args.supplementalExpectation?.applicable === false && args.supplementalExpectation.reason) {
    notes.push(args.supplementalExpectation.reason);
  }

  if (args.confidenceIntervals.length === 0 && args.stabilityMetrics.length === 0) {
    notes.push("No variance or confidence-interval statistics were available in the structured metrics.");
  }

  return uniqueStrings(notes).slice(0, 6);
}

function isPreferredMetricKey(metricKey: string, preferredKeys: string[]): boolean {
  return preferredKeys.includes(metricKey);
}

function humanizeMetricLabel(metricKey: string): string {
  return metricKey
    .split(".")
    .map((segment) => humanizeComparisonLabel(segment))
    .join(" / ");
}

function buildSupplementalRunSummary(
  profile: string,
  objectiveEvaluation: ObjectiveMetricEvaluation,
  sampling: Record<string, unknown>,
  path: string | undefined
): string {
  const details = [
    objectiveEvaluation.summary,
    typeof asNumber(sampling.total_trials) === "number" ? `total_trials=${asNumber(sampling.total_trials)}` : undefined,
    typeof asNumber(sampling.executed_trials) === "number"
      ? `executed_trials=${asNumber(sampling.executed_trials)}`
      : undefined,
    path ? `path=${path}` : undefined
  ].filter((item): item is string => Boolean(item));
  return `${humanizeConditionLabel(profile)} supplemental run: ${details.join(", ")}.`;
}

function buildExactObjectiveMetricIds(
  objectiveEvaluation: ObjectiveMetricEvaluation,
  objectiveProfile: ObjectiveMetricProfile
): string[] {
  return uniqueStrings([
    objectiveEvaluation.matchedMetricKey,
    objectiveEvaluation.primaryMetric,
    ...objectiveEvaluation.preferredMetricKeys,
    objectiveProfile.primaryMetric,
    ...objectiveProfile.preferredMetricKeys
  ]);
}

function summarizeExactObjectiveMetric(
  metricTable: AnalysisMetricEntry[],
  objectiveMetricIds: string[]
): AnalysisMetricEntry | undefined {
  for (const metricId of objectiveMetricIds) {
    const summary = summarizeMetricById(metricTable, metricId);
    if (summary) {
      return summary;
    }
  }
  return undefined;
}

function summarizeMetricById(
  metricTable: AnalysisMetricEntry[],
  metricId: string
): AnalysisMetricEntry | undefined {
  const values = metricTable
    .filter((entry) => entry.key === metricId && Number.isFinite(entry.value))
    .map((entry) => entry.value);
  if (values.length === 0) {
    return undefined;
  }
  return {
    key: metricId,
    value: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6))
  };
}

function exactMetricRank(metricId: string, objectiveMetricIds: string[]): number {
  const rank = objectiveMetricIds.indexOf(metricId);
  return rank >= 0 ? rank : Number.MAX_SAFE_INTEGER;
}

function buildAnalysisMetricTable(
  metrics: Record<string, unknown>,
  projection: ResultsArtifactProjectionResult
): AnalysisMetricEntry[] {
  if (projection.artifact.observations.length > 0) {
    return projection.artifact.observations.map((observation) => ({
      key: observation.metric_id,
      value: Number(observation.value.toFixed(6))
    }));
  }
  if (projection.source === "explicit_results_artifact") {
    return [];
  }
  return flattenNumericMetrics(metrics);
}

function flattenNumericMetrics(
  value: Record<string, unknown>,
  prefix = ""
): AnalysisMetricEntry[] {
  const items: AnalysisMetricEntry[] = [];
  for (const [key, raw] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      items.push({ key: nextKey, value: Number(raw.toFixed(6)) });
      continue;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      items.push(...flattenNumericMetrics(raw as Record<string, unknown>, nextKey));
    }
  }
  return items;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number(value.toFixed(4));
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Number(parsed.toFixed(4));
    }
  }
  return undefined;
}

function uniqueStrings(items: Array<string | undefined>): string[] {
  return [...new Set(items.filter((item): item is string => Boolean(item && item.trim())).map((item) => item.trim()))];
}

function humanizeComparisonLabel(id: string): string {
  return id
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeConditionLabel(id: string): string {
  return humanizeComparisonLabel(id);
}

function formatMetricValue(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function shortenKey(key: string): string {
  if (key.length <= 28) {
    return key;
  }
  return `${key.slice(0, 25)}...`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateOneLine(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}
