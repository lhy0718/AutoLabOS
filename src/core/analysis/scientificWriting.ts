import YAML from "yaml";

import type { PaperProfileConfig, ResolvedPaperProfileConfig } from "../../types.js";
import type { ObjectiveMetricEvaluation, ObjectiveMetricProfile } from "../objectiveMetric.js";
import type { ConstraintProfile } from "../runConstraints.js";
import type {
  GateWarningItem,
  PaperDraft,
  PaperDraftClaim,
  PaperDraftParagraph,
  PaperDraftSection,
  PaperWritingBundle,
  ResultAnalysisArtifact
} from "./paperWriting.js";
import type {
  PaperManuscript,
  PaperManuscriptFigure,
  PaperManuscriptVisualRow,
  PaperSourceRef,
  PaperManuscriptSection,
  PaperManuscriptTable
} from "./paperManuscript.js";
import {
  AUTHORED_MAIN_FIGURE_SOURCE_REF_ID,
  AUTHORED_MAIN_TABLE_SOURCE_REF_ID
} from "./paperManuscript.js";
import {
  checkResultsContractCompleteness,
  validateResultsArtifactV2,
  validateResultsPlanV2,
  type ResultsArtifactV2,
  type ResultsMetricDefinitionV2,
  type ResultsPlanV2,
  type ResultsObservationV2,
  type ResultsScalar,
  type ResultsSeriesRole,
  type ResultsSeriesV2,
  type ResultsTableDirection
} from "./resultsTableSchema.js";

export type NumericFactKind = "metric" | "count";
export type NumericFactSource =
  | "artifact"
  | "abstract"
  | "related_work"
  | "method"
  | "results"
  | "discussion"
  | "limitations"
  | "conclusion"
  | "table"
  | "figure"
  | "appendix_section"
  | "appendix_table"
  | "appendix_figure";
export type NumericFactAggregation = "aggregate" | "dataset" | "repeat" | "fold" | "unknown";
export type NumericFactUnit = "score" | "delta" | "ci_lower" | "ci_upper" | "seconds" | "mb" | "count";
export type CountFactKind =
  | "dataset_count"
  | "repeat_count"
  | "outer_fold_count"
  | "inner_fold_count"
  | "run_count"
  | "sample_count";
export type ScientificFindingKind = "contradiction" | "unverifiable" | "repairable" | "informational";
export type GateIssueOutcome = "fail" | "warn" | "auto_repair" | "unverifiable";

export interface NormalizedNumericFact {
  fact_id: string;
  fact_kind: NumericFactKind;
  source: NumericFactSource;
  location: string;
  raw_text: string;
  value: number;
  normalized_value: number;
  metric_key?: string;
  metric_label?: string;
  base_metric_key?: string;
  comparison_target?: string;
  count_kind?: CountFactKind;
  dataset_scope?: string | "aggregate" | "unknown";
  aggregation_level?: NumericFactAggregation;
  unit?: NumericFactUnit;
  source_refs?: PaperSourceRef[];
}

export interface SectionEvidenceDiagnostic {
  section: string;
  thin: boolean;
  missing_evidence_categories: string[];
  expandable_from_existing_evidence: boolean;
  blocked_by_evidence_insufficiency: boolean;
}

export interface EvidenceInsufficiencyReport {
  expandable_from_existing_evidence: boolean;
  missing_evidence_categories: string[];
  thin_sections: string[];
  blocked_by_evidence_insufficiency: boolean;
  section_diagnostics: SectionEvidenceDiagnostic[];
}

export interface ScientificAutoRepairRecheck {
  attempted: boolean;
  page_budget_before: PageBudgetManagerReport["status"];
  page_budget_after: PageBudgetManagerReport["status"];
  resolved_headings: string[];
  unresolved_headings: string[];
}

export interface ManuscriptProvenanceSectionEntry {
  section: string;
  paragraph_anchor_ids: string[];
  claim_anchor_ids: string[];
  numeric_fact_ids: string[];
  source_refs?: PaperSourceRef[];
}

export interface ManuscriptProvenanceParagraphAnchor {
  anchor_id: string;
  section: string;
  paragraph_index: number;
  text_preview: string;
  source_refs?: PaperSourceRef[];
  claim_ids?: string[];
  numeric_fact_ids: string[];
}

export interface ManuscriptProvenanceNumericAnchor {
  anchor_id: string;
  source_anchor_id?: string;
  source: NumericFactSource;
  location: string;
  support_status: "supported" | "appendix_only" | "contradiction" | "unverifiable";
  fact: NormalizedNumericFact;
  supporting_fact_ids: string[];
  source_refs?: PaperSourceRef[];
}

export interface ManuscriptProvenanceVisualEntry {
  anchor_id: string;
  kind: "table" | "figure" | "appendix_table" | "appendix_figure";
  caption: string;
  source_refs?: PaperSourceRef[];
  numeric_fact_ids: string[];
}

export interface ManuscriptProvenanceMap {
  sections: ManuscriptProvenanceSectionEntry[];
  paragraph_anchors: ManuscriptProvenanceParagraphAnchor[];
  numeric_anchors: ManuscriptProvenanceNumericAnchor[];
  visual_anchors: ManuscriptProvenanceVisualEntry[];
}

export interface ExperimentArtifactContext {
  method: {
    dataset_names: string[];
    dataset_sources: string[];
    sample_size_notes: string[];
    feature_notes: string[];
    class_notes: string[];
    imbalance_notes: string[];
    missingness_notes: string[];
    preprocessing_steps: string[];
    fit_scope_notes: string[];
    outer_fold_notes: string[];
    inner_fold_notes: string[];
    repeat_notes: string[];
    stratification_notes: string[];
    seeds: number[];
    hyperparameter_notes: string[];
    selection_metrics: string[];
    reporting_metrics: string[];
    runtime_measurement: boolean;
    memory_measurement: boolean;
    model_names: string[];
  };
  results: {
    canonical_artifact?: ResultsArtifactV2;
    canonical_plan?: ResultsPlanV2;
    canonical_observations: CanonicalResultObservationSummary[];
    primary_comparison?: PrimaryComparisonSummary;
    primary_comparison_status: PrimaryComparisonResolutionStatus;
    primary_comparison_issues: string[];
    aggregate_summary: string[];
    aggregate_metric_facts: NormalizedNumericFact[];
    confidence_interval_facts: NormalizedNumericFact[];
    dataset_summaries: DatasetResultSummary[];
    dispersion_notes: string[];
    ci_notes: string[];
    ci_unavailable_reason?: string;
    paired_artifact_available: boolean;
    runtime_notes: string[];
    memory_notes: string[];
    figure_captions: string[];
    effect_notes: string[];
    heterogeneity_notes: string[];
  };
  related_work: {
    clusters: string[];
    closest_titles: string[];
    comparison_axes: string[];
    note_count: number;
    positioning_available: boolean;
  };
  discussion: {
    discussion_points: string[];
    limitations: string[];
    practical_implications: string[];
  };
  reproducibility: {
    has_artifact: boolean;
    artifact_notes: string[];
  };
}

export interface DatasetResultSummary {
  dataset: string;
  label: string;
  main_metric_label: string;
  main_metric_value?: number;
  delta_label?: string;
  delta_value?: number;
  ci95?: [number, number];
  runtime_seconds_mean?: number;
  peak_memory_mb_mean?: number;
  pairwise_ranking_agreement?: number;
  winner_consistency?: number;
  heterogeneity_notes: string[];
  summary: string;
}

export interface CanonicalResultObservationSummary {
  observation_id: string;
  series_id: string;
  series_label: string;
  series_role?: ResultsSeriesRole;
  metric_id: string;
  metric_label: string;
  metric_direction: ResultsTableDirection;
  metric_unit?: string;
  scope: Record<string, ResultsScalar>;
  value: number;
  evidence_refs: string[];
}

export type PrimaryComparisonResolutionStatus =
  | "resolved"
  | "unavailable"
  | "invalid"
  | "ambiguous";

export interface PrimaryComparisonSummary {
  comparison_id: string;
  metric_id: string;
  metric_label: string;
  metric_direction: ResultsTableDirection;
  metric_unit?: string;
  subject: CanonicalResultObservationSummary & { series_role: "primary" | "comparator" };
  reference: CanonicalResultObservationSummary & { series_role: "baseline" };
  delta: number;
  directional_outcome: "favors_subject" | "favors_reference" | "neutral";
  judgement?: string;
  evidence_refs: string[];
  summary: string;
}

export interface SectionBudgetEntry {
  heading: string;
  minimum_words: number;
  target_words: number;
  maximum_words: number;
  hard_minimum: boolean;
  current_words: number;
  status: "ok" | "warn" | "fail";
}

export interface PageBudgetManagerReport {
  column_count: 1 | 2;
  target_main_pages: number;
  minimum_main_pages: number;
  /** @deprecated Compatibility alias for minimum_main_pages. */
  main_page_limit: number;
  references_counted: boolean;
  appendix_allowed: boolean;
  estimated_words_per_page: number;
  minimum_main_words: number;
  target_main_words: number;
  maximum_main_words: number;
  estimated_main_words: number;
  status: "ok" | "warn" | "fail";
  sections: SectionBudgetEntry[];
  warnings: string[];
  auto_expand_headings: string[];
}

export interface CompletenessReport {
  status: "complete" | "incomplete";
  present: string[];
  missing: string[];
  warnings: string[];
}

export interface RelatedWorkRichnessReport extends CompletenessReport {
  cluster_count: number;
}

export interface ClaimStrengthRewrite {
  category: "performance" | "robustness" | "reproducibility" | "efficiency" | "novelty";
  before: string;
  after: string;
  reason: string;
}

export interface ClaimStrengthRewriteReport {
  rewrites: ClaimStrengthRewrite[];
}

export interface AppendixReference {
  label: string;
  target_heading: string;
  reason: string;
}

export interface AppendixSection extends PaperManuscriptSection {
  appendix_label: string;
}

export interface AppendixPlan {
  sections: AppendixSection[];
  tables: PaperManuscriptTable[];
  figures: PaperManuscriptFigure[];
  cross_references: AppendixReference[];
}

export interface ConsistencyLintIssue {
  kind:
    | "method_results_mismatch"
    | "numeric_inconsistency"
    | "numeric_unverifiable"
    | "count_inconsistency"
    | "count_unverifiable"
    | "caption_internal_name"
    | "reproducibility_claim"
    | "unsupported_strong_claim"
    | "appendix_reference_missing"
    | "appendix_only_numeric_reference"
    | "main_logic_thin";
  severity: "warning" | "error";
  message: string;
  finding?: ScientificFindingKind;
  involved_sections?: string[];
  normalized_facts?: NormalizedNumericFact[];
  reason?: string;
  evidence?: string[];
}

export interface ConsistencyLintReport {
  ok: boolean;
  issues: ConsistencyLintIssue[];
}

export interface ScientificDraftResult {
  draft: PaperDraft;
  page_budget: PageBudgetManagerReport;
  method_completeness: CompletenessReport;
  results_richness: CompletenessReport;
  related_work_richness: RelatedWorkRichnessReport;
  discussion_richness: CompletenessReport;
  evidence_diagnostics: EvidenceInsufficiencyReport;
  claim_rewrite_report: ClaimStrengthRewriteReport;
  appendix_plan: AppendixPlan;
  auto_repairs: {
    expanded_sections: string[];
    expansion_recheck: ScientificAutoRepairRecheck;
  };
}

export interface ScientificManuscriptResult {
  manuscript: PaperManuscript;
  consistency_lint: ConsistencyLintReport;
  appendix_lint: ConsistencyLintReport;
  provenance_map: ManuscriptProvenanceMap;
}

export interface ManuscriptPageBudgetFloorReport {
  manuscript: PaperManuscript;
  applied: boolean;
  minimum_main_words: number;
  estimated_main_words_before: number;
  estimated_main_words_after: number;
  added_paragraph_count: number;
  added_sections: string[];
}

export type PaperValidationMode = "default" | "strict_paper";
export type ScientificValidationCategory =
  | "page_budget"
  | "method_completeness"
  | "results_richness"
  | "related_work_richness"
  | "discussion_richness"
  | "consistency"
  | "appendix";
export type ScientificValidationPolicy = "always_fail" | "strict_fail" | "warn_only";

export interface ScientificValidationIssue {
  code: string;
  source: "scientific_validation" | "consistency_lint" | "appendix_lint";
  category: ScientificValidationCategory;
  severity: "warning" | "error";
  policy: ScientificValidationPolicy;
  finding: ScientificFindingKind;
  message: string;
  details?: string[];
  involved_sections?: string[];
  normalized_facts?: NormalizedNumericFact[];
  reason?: string;
  evidence?: string[];
  expandable_from_existing_evidence?: boolean;
  missing_evidence_categories?: string[];
  thin_sections?: string[];
  blocked_by_evidence_insufficiency?: boolean;
}

export interface ScientificValidationArtifact {
  page_budget: PageBudgetManagerReport;
  method_completeness: CompletenessReport;
  results_richness: CompletenessReport;
  related_work_richness: RelatedWorkRichnessReport;
  discussion_richness: CompletenessReport;
  evidence_diagnostics: EvidenceInsufficiencyReport;
  claim_rewrite_report: ClaimStrengthRewriteReport;
  appendix_plan: AppendixPlan;
  auto_repairs: {
    claim_rewrite_count: number;
    expanded_sections: string[];
    appendix_route_count: number;
    expansion_recheck: ScientificAutoRepairRecheck;
  };
  issues: ScientificValidationIssue[];
}

export interface WritePaperGateDecisionIssue extends ScientificValidationIssue {
  blocking: boolean;
  outcome: GateIssueOutcome;
}

export interface WritePaperGateDecision {
  mode: PaperValidationMode;
  status: "pass" | "warn" | "fail";
  issues: WritePaperGateDecisionIssue[];
  blocking_issue_count: number;
  warning_count: number;
  failure_reasons: string[];
  classification_summary: {
    contradiction_count: number;
    unverifiable_count: number;
    repairable_count: number;
    informational_count: number;
    auto_repair_count: number;
  };
  evidence_summary: {
    thin_sections: string[];
    missing_evidence_categories: string[];
    blocked_by_evidence_insufficiency: boolean;
    expandable_from_existing_evidence: boolean;
  };
  summary: string[];
}

const DEFAULT_PAPER_PROFILE: PaperProfileConfig = {
  column_count: 2,
  target_main_pages: 8,
  minimum_main_pages: 8,
  main_page_limit: 8,
  references_counted: false,
  appendix_allowed: true,
  appendix_format: "double_column",
  prefer_appendix_for: [],
  estimated_words_per_page: 650
};

export function resolvePaperProfile(
  profile: Partial<PaperProfileConfig> | undefined,
  constraintProfile?: ConstraintProfile
): ResolvedPaperProfileConfig {
  const preferAppendixFor = Array.isArray(profile?.prefer_appendix_for)
    ? profile?.prefer_appendix_for
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : DEFAULT_PAPER_PROFILE.prefer_appendix_for;
  const inferredColumnCount = profile?.column_count === 1 ? 1 : DEFAULT_PAPER_PROFILE.column_count;
  const lengthHint = cleanString(constraintProfile?.writing?.lengthHint);
  const compatibilityMainPageLimit =
    typeof profile?.main_page_limit === "number" && Number.isFinite(profile.main_page_limit)
      ? Math.max(1, Math.round(profile.main_page_limit))
      : undefined;
  const inferredTargetMainPages =
    typeof profile?.target_main_pages === "number" && Number.isFinite(profile.target_main_pages)
      ? Math.max(1, Math.round(profile.target_main_pages))
      : compatibilityMainPageLimit
        ?? (/\bshort\b/iu.test(lengthHint) ? 4 : (DEFAULT_PAPER_PROFILE.target_main_pages || 8));
  const inferredMinimumMainPages =
    typeof profile?.minimum_main_pages === "number" && Number.isFinite(profile.minimum_main_pages)
      ? Math.max(1, Math.round(profile.minimum_main_pages))
      : compatibilityMainPageLimit
        ?? inferredTargetMainPages;
  const inferredAppendixFormat =
    profile?.appendix_format
    || (inferredColumnCount === 1 ? "single_column" : "double_column");
  const inferredEstimatedWordsPerPage =
    typeof profile?.estimated_words_per_page === "number" && Number.isFinite(profile.estimated_words_per_page)
      ? Math.max(250, Math.round(profile.estimated_words_per_page))
      : inferredColumnCount === 1
        ? 700
        : 650;

  return {
    column_count: inferredColumnCount,
    target_main_pages: inferredTargetMainPages,
    minimum_main_pages: inferredMinimumMainPages,
    main_page_limit: compatibilityMainPageLimit ?? inferredMinimumMainPages,
    references_counted:
      typeof profile?.references_counted === "boolean"
        ? profile.references_counted
        : DEFAULT_PAPER_PROFILE.references_counted,
    appendix_allowed:
      typeof profile?.appendix_allowed === "boolean"
        ? profile.appendix_allowed
        : DEFAULT_PAPER_PROFILE.appendix_allowed,
    appendix_format: inferredAppendixFormat === "single_column" ? "single_column" : "double_column",
    prefer_appendix_for: preferAppendixFor,
    estimated_words_per_page: inferredEstimatedWordsPerPage
  };
}

const SECTION_BUDGET_WEIGHTS: Array<{
  heading: string;
  weight: number;
  hardMinimum?: boolean;
}> = [
  { heading: "Introduction", weight: 0.16 },
  { heading: "Related Work", weight: 0.15 },
  { heading: "Method", weight: 0.2, hardMinimum: true },
  { heading: "Results", weight: 0.24, hardMinimum: true },
  { heading: "Discussion", weight: 0.12 },
  { heading: "Limitations", weight: 0.07 },
  { heading: "Conclusion", weight: 0.06 }
];

const SECTION_MIN_PARAGRAPHS: Record<string, number> = {
  introduction: 2,
  "related work": 2,
  method: 3,
  results: 4,
  discussion: 2,
  limitations: 1,
  conclusion: 1
};

const SECTION_MAX_PARAGRAPHS: Record<string, number> = {
  introduction: 4,
  "related work": 6,
  method: 9,
  results: 16,
  discussion: 8,
  limitations: 6,
  conclusion: 5
};

interface CanonicalResultsResolution {
  status: PrimaryComparisonResolutionStatus;
  issues: string[];
  artifact?: ResultsArtifactV2;
  plan?: ResultsPlanV2;
  observations: CanonicalResultObservationSummary[];
  primaryComparison?: PrimaryComparisonSummary;
}

interface CanonicalContractCandidate {
  value?: unknown;
  ambiguous: boolean;
}

function selectCanonicalContractCandidate(...values: unknown[]): CanonicalContractCandidate {
  const candidates = values.filter((value) => value !== undefined);
  if (candidates.length === 0) {
    return { ambiguous: false };
  }
  const fingerprints = new Set(candidates.map((value) => canonicalContractFingerprint(value)));
  return {
    value: candidates[0],
    ambiguous: fingerprints.size > 1
  };
}

function canonicalContractFingerprint(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalContractFingerprint(item)).sort().join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalContractFingerprint(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function resolveCanonicalResults(
  resultAnalysis: ResultAnalysisArtifact | undefined
): CanonicalResultsResolution {
  const reportRecord = asRecord(resultAnalysis);
  const metricsRecord = asRecord(reportRecord.metrics);
  const artifactCandidate = selectCanonicalContractCandidate(
    reportRecord.results_artifact,
    metricsRecord.results_artifact
  );
  const planCandidate = selectCanonicalContractCandidate(
    reportRecord.results_plan,
    metricsRecord.results_plan
  );
  if (artifactCandidate.ambiguous || planCandidate.ambiguous) {
    return {
      status: "ambiguous",
      issues: ["Multiple non-equivalent canonical result contracts were supplied."],
      observations: []
    };
  }
  if (artifactCandidate.value === undefined || planCandidate.value === undefined) {
    return {
      status: "unavailable",
      issues: ["A validated ResultsArtifactV2 and ResultsPlanV2 are both required for scientific claim selection."],
      observations: []
    };
  }

  const artifactValidation = validateResultsArtifactV2(artifactCandidate.value);
  const planValidation = validateResultsPlanV2(planCandidate.value);
  if (!artifactValidation.valid || !planValidation.valid) {
    return {
      status: "invalid",
      issues: [...artifactValidation.issues, ...planValidation.issues],
      observations: []
    };
  }

  const completeness = checkResultsContractCompleteness(
    artifactCandidate.value,
    planCandidate.value
  );
  if (!completeness.complete) {
    return {
      status: "invalid",
      issues: completeness.issues,
      observations: []
    };
  }

  const artifact = artifactCandidate.value as ResultsArtifactV2;
  const plan = planCandidate.value as ResultsPlanV2;
  const metricsById = new Map(artifact.metrics.map((metric) => [metric.id, metric] as const));
  const seriesById = new Map(artifact.series.map((series) => [series.id, series] as const));
  const observationsById = new Map(
    artifact.observations.map((observation) => [observation.id, observation] as const)
  );
  const explicitComparisonId = cleanString(plan.primary_comparison_id);
  if (!explicitComparisonId) {
    return {
      status: "invalid",
      issues: ["ResultsPlanV2 must explicitly declare primary_comparison_id."],
      artifact,
      plan,
      observations: []
    };
  }
  const reportPrimaryComparisonId = cleanString(resultAnalysis?.primary_comparison_id);
  if (reportPrimaryComparisonId && reportPrimaryComparisonId !== explicitComparisonId) {
    return {
      status: "invalid",
      issues: ["AnalysisReport.primary_comparison_id must match ResultsPlanV2.primary_comparison_id."],
      artifact,
      plan,
      observations: []
    };
  }

  const requiredComparison = plan.required_comparisons?.find(
    (comparison) => comparison.id === explicitComparisonId
  );
  const selectedComparison = artifact.comparisons.find(
    (comparison) => comparison.id === explicitComparisonId
  );
  if (!requiredComparison || !selectedComparison) {
    return {
      status: "invalid",
      issues: ["The declared primary comparison must be present in both ResultsPlanV2 and ResultsArtifactV2."],
      artifact,
      plan,
      observations: []
    };
  }

  const observations = artifact.observations.flatMap((observation) => {
    const metric = metricsById.get(observation.metric_id);
    const series = seriesById.get(observation.series_id);
    return metric && series
      ? [buildCanonicalObservationSummary(observation, metric, series)]
      : [];
  });

  const subjectObservation = observationsById.get(selectedComparison.subject_observation_id);
  const referenceObservation = observationsById.get(selectedComparison.reference_observation_id);
  const metric = subjectObservation ? metricsById.get(subjectObservation.metric_id) : undefined;
  const subjectSeries = subjectObservation ? seriesById.get(subjectObservation.series_id) : undefined;
  const referenceSeries = referenceObservation ? seriesById.get(referenceObservation.series_id) : undefined;
  const primaryIssues = validatePrimaryComparisonLinks({
    subjectObservation,
    referenceObservation,
    metric,
    subjectSeries,
    referenceSeries
  });
  if (
    subjectObservation
    && referenceObservation
    && (
      subjectObservation.series_id !== requiredComparison.subject_series_id
      || referenceObservation.series_id !== requiredComparison.reference_series_id
      || subjectObservation.metric_id !== requiredComparison.metric_id
    )
  ) {
    primaryIssues.push("The primary comparison links do not match the subject, reference, and metric declared by ResultsPlanV2.");
  }
  if (primaryIssues.length > 0) {
    return {
      status: "invalid",
      issues: primaryIssues,
      artifact,
      plan,
      observations
    };
  }

  const primaryComparison = buildPrimaryComparisonSummary({
    comparison: selectedComparison,
    metric: metric!,
    subjectObservation: subjectObservation!,
    referenceObservation: referenceObservation!,
    subjectSeries: subjectSeries as ResultsSeriesV2 & { role: "primary" | "comparator" },
    referenceSeries: referenceSeries as ResultsSeriesV2 & { role: "baseline" }
  });
  return {
    status: "resolved",
    issues: [],
    artifact,
    plan,
    observations,
    primaryComparison
  };
}

function validatePrimaryComparisonLinks(input: {
  subjectObservation?: ResultsObservationV2;
  referenceObservation?: ResultsObservationV2;
  metric?: ResultsMetricDefinitionV2;
  subjectSeries?: ResultsSeriesV2;
  referenceSeries?: ResultsSeriesV2;
}): string[] {
  const issues: string[] = [];
  if (!input.subjectObservation || !input.referenceObservation || !input.metric) {
    issues.push("The primary comparison does not resolve through its subject/reference observation links.");
  }
  if (input.metric && !cleanString(input.metric.unit)) {
    issues.push("The primary comparison metric must declare a non-empty unit.");
  }
  if (
    input.subjectObservation
    && input.referenceObservation
    && input.subjectObservation.series_id === input.referenceObservation.series_id
  ) {
    issues.push("The primary comparison subject and reference must belong to distinct series.");
  }
  if (
    input.subjectObservation
    && input.referenceObservation
    && canonicalScopeKey(input.subjectObservation.scope) !== canonicalScopeKey(input.referenceObservation.scope)
  ) {
    issues.push("The primary comparison subject and reference observations must declare the same scope.");
  }
  if (input.subjectSeries?.role !== "primary" && input.subjectSeries?.role !== "comparator") {
    issues.push("The primary comparison subject series must explicitly declare a primary or comparator role.");
  }
  if (input.referenceSeries?.role !== "baseline") {
    issues.push("The primary comparison reference series must explicitly declare the baseline role.");
  }
  return issues;
}

function canonicalScopeKey(scope: Record<string, ResultsScalar>): string {
  return JSON.stringify(
    Object.entries(scope)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value])
  );
}

function buildCanonicalObservationSummary(
  observation: ResultsObservationV2,
  metric: ResultsMetricDefinitionV2,
  series: ResultsSeriesV2
): CanonicalResultObservationSummary {
  return {
    observation_id: observation.id,
    series_id: series.id,
    series_label: series.label,
    ...(series.role ? { series_role: series.role } : {}),
    metric_id: metric.id,
    metric_label: metric.label,
    metric_direction: metric.direction,
    ...(metric.unit ? { metric_unit: metric.unit } : {}),
    scope: { ...observation.scope },
    value: observation.value,
    evidence_refs: [...(observation.evidence_refs || [])]
  };
}

function buildPrimaryComparisonSummary(input: {
  comparison: ResultsArtifactV2["comparisons"][number];
  metric: ResultsMetricDefinitionV2;
  subjectObservation: ResultsObservationV2;
  referenceObservation: ResultsObservationV2;
  subjectSeries: ResultsSeriesV2 & { role: "primary" | "comparator" };
  referenceSeries: ResultsSeriesV2 & { role: "baseline" };
}): PrimaryComparisonSummary {
  const subject = buildCanonicalObservationSummary(
    input.subjectObservation,
    input.metric,
    input.subjectSeries
  ) as PrimaryComparisonSummary["subject"];
  const reference = buildCanonicalObservationSummary(
    input.referenceObservation,
    input.metric,
    input.referenceSeries
  ) as PrimaryComparisonSummary["reference"];
  const directionalOutcome = classifyDirectionalOutcome(
    input.comparison.delta,
    input.metric.direction
  );
  const directionText = input.metric.direction === "higher_better"
    ? "higher values preferred"
    : "lower values preferred";
  const outcomeText = directionalOutcome === "neutral"
    ? "the declared direction is neutral at the reported precision"
    : directionalOutcome === "favors_subject"
      ? "the declared metric direction favors the subject series"
      : "the declared metric direction favors the reference series";
  return {
    comparison_id: input.comparison.id,
    metric_id: input.metric.id,
    metric_label: input.metric.label,
    metric_direction: input.metric.direction,
    ...(input.metric.unit ? { metric_unit: input.metric.unit } : {}),
    subject,
    reference,
    delta: input.comparison.delta,
    directional_outcome: directionalOutcome,
    ...(cleanString(input.comparison.judgement)
      ? { judgement: cleanString(input.comparison.judgement) }
      : {}),
    evidence_refs: uniqueStrings([
      ...(input.comparison.evidence_refs || []),
      ...(input.subjectObservation.evidence_refs || []),
      ...(input.referenceObservation.evidence_refs || [])
    ]),
    summary: cleanString(
      `For ${input.metric.label}, ${input.subjectSeries.label} (${input.subjectSeries.role} role) recorded ${formatCanonicalMeasurement(input.subjectObservation.value, input.metric.unit)}, while ${input.referenceSeries.label} (baseline role) recorded ${formatCanonicalMeasurement(input.referenceObservation.value, input.metric.unit)}. The declared subject-minus-reference difference is ${formatCanonicalMeasurement(input.comparison.delta, input.metric.unit)}; ${directionText}, so ${outcomeText}.`
    )
  };
}

function classifyDirectionalOutcome(
  delta: number,
  direction: ResultsTableDirection
): PrimaryComparisonSummary["directional_outcome"] {
  if (Math.abs(delta) < 1e-12) {
    return "neutral";
  }
  const subjectPreferred = direction === "higher_better" ? delta > 0 : delta < 0;
  return subjectPreferred ? "favors_subject" : "favors_reference";
}

function formatCanonicalMeasurement(value: number, unit: string | undefined): string {
  const rendered = formatNumber(value);
  return cleanString(unit) ? `${rendered} ${cleanString(unit)}` : rendered;
}

export function experimentArtifactLoader(input: {
  bundle: PaperWritingBundle;
  objectiveEvaluation?: ObjectiveMetricEvaluation;
  objectiveMetricProfile?: ObjectiveMetricProfile;
}): ExperimentArtifactContext {
  const parsedPlan = parsePlanYaml(input.bundle.experimentPlan?.rawText);
  const latestResults = asRecord(input.bundle.latestResults);
  const resultAnalysis = input.bundle.resultAnalysis;
  const canonicalResults = resolveCanonicalResults(resultAnalysis);
  const method = {
    dataset_names: collectDatasetNames(input.bundle, parsedPlan, latestResults),
    dataset_sources: collectDatasetSourceHints(parsedPlan, latestResults),
    sample_size_notes: collectSampleSizeHints(parsedPlan, latestResults, resultAnalysis),
    feature_notes: collectFeatureHints(parsedPlan, latestResults),
    class_notes: collectClassHints(parsedPlan, latestResults),
    imbalance_notes: collectKeywordNotes(parsedPlan, ["imbalance", "imbalanced", "class balance", "class prior"]),
    missingness_notes: collectKeywordNotes(parsedPlan, ["missing", "missingness", "imputation"]),
    preprocessing_steps: collectPreprocessingSteps(parsedPlan),
    fit_scope_notes: collectKeywordNotes(parsedPlan, [
      "fit within each fold",
      "within each fold",
      "fit on train fold",
      "inside each fold",
      "no leakage"
    ]),
    outer_fold_notes: collectFoldNotes(parsedPlan, "outer"),
    inner_fold_notes: collectFoldNotes(parsedPlan, "inner"),
    repeat_notes: collectRepeatNotes(parsedPlan, latestResults),
    stratification_notes: collectKeywordNotes(parsedPlan, ["stratified", "stratification"]),
    seeds: collectSeeds(parsedPlan, latestResults),
    hyperparameter_notes: collectHyperparameterNotes(parsedPlan, latestResults, resultAnalysis),
    selection_metrics: collectCanonicalMetricLabels(canonicalResults.artifact),
    reporting_metrics: collectCanonicalMetricLabels(canonicalResults.artifact),
    runtime_measurement: hasCanonicalResourceMetric(canonicalResults.artifact, "runtime"),
    memory_measurement: hasCanonicalResourceMetric(canonicalResults.artifact, "memory"),
    model_names: collectCanonicalSeriesLabels(canonicalResults.artifact)
  };

  const datasetSummaries = collectCanonicalResultSummaries(canonicalResults.primaryComparison);
  const ciNotes = collectCiNotes(resultAnalysis, canonicalResults.primaryComparison);
  const results = {
    ...(canonicalResults.artifact ? { canonical_artifact: canonicalResults.artifact } : {}),
    ...(canonicalResults.plan ? { canonical_plan: canonicalResults.plan } : {}),
    canonical_observations: canonicalResults.observations,
    ...(canonicalResults.primaryComparison
      ? { primary_comparison: canonicalResults.primaryComparison }
      : {}),
    primary_comparison_status: canonicalResults.status,
    primary_comparison_issues: canonicalResults.issues,
    aggregate_summary: collectCanonicalAggregateResults(canonicalResults),
    aggregate_metric_facts: collectCanonicalArtifactMetricFacts(canonicalResults),
    confidence_interval_facts: collectConfidenceIntervalMetricFacts(
      resultAnalysis,
      canonicalResults.primaryComparison
    ),
    dataset_summaries: datasetSummaries,
    dispersion_notes: ciNotes,
    ci_notes: ciNotes,
    ...(ciNotes.length === 0
      ? {
          ci_unavailable_reason: canonicalResults.primaryComparison
            ? buildCiUnavailableReason(canonicalResults.primaryComparison)
            : "Confidence intervals are unavailable because no primary comparison was resolved."
        }
      : {}),
    paired_artifact_available: Boolean(canonicalResults.primaryComparison),
    runtime_notes: collectCanonicalResourceNotes(canonicalResults, "runtime"),
    memory_notes: collectCanonicalResourceNotes(canonicalResults, "memory"),
    figure_captions: canonicalResults.primaryComparison
      ? [`Declared primary comparison for ${canonicalResults.primaryComparison.metric_label}.`]
      : [],
    effect_notes: collectCanonicalEffectNotes(canonicalResults.primaryComparison),
    heterogeneity_notes: []
  };

  const relatedWorkNotes = input.bundle.relatedWorkNotes || [];
  const comparisonAxes = input.bundle.relatedWorkScout?.papers?.length
    ? uniqueStrings(
        input.bundle.relatedWorkScout.papers
          .map((item) => sanitizeRelatedWorkAxisForNarrative(firstSentence(item.summary)))
          .filter(Boolean)
      )
    : [];
  const positioningNotes = relatedWorkNotes.filter((item) => isPositioningRelatedWorkNote(item));
  const safeRelatedWorkAxes = uniqueStrings([
    ...(input.bundle.relatedWorkNotes || []).map((item) => sanitizeRelatedWorkAxisForNarrative(item.problem_focus)),
    ...comparisonAxes
  ]).slice(0, 4);
  const safeClusters = uniqueStrings(
    relatedWorkNotes
      .map((item) => sanitizeRelatedWorkAxisForNarrative(item.method_family))
      .filter(Boolean)
  );
  const relatedWork = {
    clusters: safeClusters,
    closest_titles: positioningNotes.map((item) => sanitizeRelatedWorkTitleForNarrative(item.title)).filter(Boolean).slice(0, 3),
    comparison_axes: safeRelatedWorkAxes.length > 0 ? safeRelatedWorkAxes : ["method family, resource budget, and evaluation-scope differences"],
    note_count: relatedWorkNotes.length,
    positioning_available: positioningNotes.length > 0
  };

  const discussion = {
    discussion_points: canonicalResults.primaryComparison
      ? [canonicalResults.primaryComparison.summary]
      : ["No directional interpretation is available without one resolved primary comparison."],
    limitations: uniqueStrings(resultAnalysis?.limitations || []).slice(0, 6),
    practical_implications: buildPracticalImplications(
      input.bundle,
      canonicalResults.primaryComparison,
      canonicalResults
    )
  };

  const reproducibilityNotes = uniqueStrings([
    ...input.bundle.paperSummaries.flatMap((item) => item.reproducibility_notes || []),
    ...method.repeat_notes,
    method.seeds.length > 0 ? `Seed schedule includes ${method.seeds.length} explicit seed(s).` : "",
    method.runtime_measurement ? "Runtime is measured in the reported evaluation outputs." : "",
    method.memory_measurement ? "Peak memory is measured in the reported evaluation outputs." : ""
  ]).filter(Boolean);

  return {
    method,
    results,
    related_work: relatedWork,
    discussion,
    reproducibility: {
      has_artifact:
        Boolean(canonicalResults.artifact) && reproducibilityNotes.length > 0,
      artifact_notes: reproducibilityNotes.slice(0, 6)
    }
  };
}

function isPositioningRelatedWorkNote(
  item: NonNullable<PaperWritingBundle["relatedWorkNotes"]>[number]
): boolean {
  if (item.comparison_role === "closest") {
    return true;
  }
  return (
    item.comparison_role === "supporting" &&
    /nearby comparison|comparison point|current study|position|baseline|objective/iu.test(
      `${item.relation_to_study} ${item.problem_focus} ${item.contribution_focus}`
    )
  );
}

export function methodCompletenessValidator(context: ExperimentArtifactContext): CompletenessReport {
  const present: string[] = [];
  const missing: string[] = [];

  pushFieldStatus(present, missing, context.method.dataset_names.length > 0, "dataset names");
  pushFieldStatus(present, missing, context.method.dataset_sources.length > 0, "dataset source");
  pushFieldStatus(present, missing, context.method.sample_size_notes.length > 0, "#samples");
  pushFieldStatus(present, missing, context.method.model_names.length > 0, "declared result series");
  pushFieldStatus(present, missing, context.method.preprocessing_steps.length > 0, "preprocessing steps/order");
  pushFieldStatus(present, missing, context.method.repeat_notes.length > 0, "repeats");
  pushFieldStatus(present, missing, context.method.seeds.length > 0, "seeds");
  pushFieldStatus(present, missing, context.method.hyperparameter_notes.length > 0, "hyperparameter search space");
  pushFieldStatus(present, missing, context.method.selection_metrics.length > 0, "selection/reporting metrics");
  pushFieldStatus(present, missing, context.method.runtime_measurement, "runtime measurement");
  pushFieldStatus(present, missing, context.method.memory_measurement, "memory measurement");

  return {
    status: missing.length === 0 ? "complete" : "incomplete",
    present,
    missing,
    warnings:
      missing.length > 0
        ? [`Method remains incomplete because ${joinHumanList(missing)} are not grounded in current artifacts.`]
        : []
  };
}
export function resultsRichnessValidator(context: ExperimentArtifactContext): CompletenessReport {
  const present: string[] = [];
  const missing: string[] = [];

  pushFieldStatus(present, missing, context.results.aggregate_summary.length > 0, "aggregate summary");
  pushFieldStatus(present, missing, context.results.dataset_summaries.length > 0, "per-dataset results");
  pushFieldStatus(
    present,
    missing,
    context.results.dispersion_notes.length > 0,
    "dispersion estimates"
  );
  pushFieldStatus(
    present,
    missing,
    context.results.ci_notes.length > 0 || Boolean(context.results.ci_unavailable_reason),
    "CI or CI-unavailable rationale"
  );
  pushFieldStatus(
    present,
    missing,
    context.results.paired_artifact_available,
    "paired/repeated comparison artifact"
  );
  pushFieldStatus(
    present,
    missing,
    context.results.figure_captions.length > 0,
    "scientific figure with informative caption"
  );

  return {
    status: missing.length === 0 ? "complete" : "incomplete",
    present,
    missing,
    warnings:
      missing.length > 0
        ? [`Results remain incomplete because ${joinHumanList(missing)} are missing or too weakly grounded.`]
        : []
  };
}

export function relatedWorkRichnessValidator(context: ExperimentArtifactContext): RelatedWorkRichnessReport {
  const present: string[] = [];
  const missing: string[] = [];

  pushFieldStatus(present, missing, context.related_work.clusters.length >= 3, "3-4 work clusters");
  pushFieldStatus(
    present,
    missing,
    context.related_work.closest_titles.length > 0,
    "closest prior work comparison"
  );
  pushFieldStatus(
    present,
    missing,
    context.related_work.positioning_available,
    "explicit positioning/difference statement"
  );

  return {
    status: missing.length === 0 ? "complete" : "incomplete",
    present,
    missing,
    warnings:
      missing.length > 0
        ? [`Related Work remains thin because ${joinHumanList(missing)} are still underspecified.`]
        : [],
    cluster_count: context.related_work.clusters.length
  };
}

export function discussionRichnessValidator(context: ExperimentArtifactContext): CompletenessReport {
  const present: string[] = [];
  const missing: string[] = [];

  pushFieldStatus(present, missing, context.discussion.discussion_points.length > 0, "result interpretation");
  pushFieldStatus(present, missing, context.discussion.limitations.length > 0, "generalization/evaluation limits");
  pushFieldStatus(
    present,
    missing,
    context.discussion.practical_implications.length > 0,
    "practical implication"
  );

  return {
    status: missing.length === 0 ? "complete" : "incomplete",
    present,
    missing,
    warnings:
      missing.length > 0
        ? [`Discussion remains incomplete because ${joinHumanList(missing)} are missing.`]
        : []
  };
}

export function statisticalSummaryBuilder(context: ExperimentArtifactContext): string[] {
  const lines = uniqueStrings([
    ...context.results.effect_notes,
    ...context.results.dispersion_notes,
    ...context.results.ci_notes,
    ...context.results.heterogeneity_notes
  ]).filter(Boolean);
  return lines.slice(0, 6);
}

export function datasetResultTableBuilder(context: ExperimentArtifactContext): PaperManuscriptTable[] {
  return primaryComparisonTableBuilder(context);
}

export function primaryComparisonTableBuilder(context: ExperimentArtifactContext): PaperManuscriptTable[] {
  const comparison = context.results.primary_comparison;
  if (!comparison) {
    return [];
  }

  return [
    {
      caption: `Declared primary comparison for ${comparison.metric_label} (${humanizeMetricDirection(comparison.metric_direction)}${comparison.metric_unit ? `; unit: ${comparison.metric_unit}` : ""}).`,
      rows: [
        buildPrimaryComparisonVisualRow(comparison, "subject"),
        buildPrimaryComparisonVisualRow(comparison, "reference"),
        {
          label: "Subject-minus-reference difference",
          value: comparison.delta,
          comparison_id: comparison.comparison_id,
          metric_id: comparison.metric_id,
          comparison_side: "difference"
        }
      ],
      source_refs: buildArtifactSourceRefs([
        `result_analysis.results_artifact.comparison:${comparison.comparison_id}`,
        `result_analysis.results_plan.primary_comparison_id:${comparison.comparison_id}`
      ])
    }
  ];
}

function buildPrimaryComparisonVisualRow(
  comparison: PrimaryComparisonSummary,
  side: "subject" | "reference"
): PaperManuscriptVisualRow {
  const observation = comparison[side];
  return {
    label: `${observation.series_label} (${observation.series_role} role, ${side})`,
    value: observation.value,
    comparison_id: comparison.comparison_id,
    observation_id: observation.observation_id,
    metric_id: observation.metric_id,
    series_id: observation.series_id,
    series_role: observation.series_role,
    comparison_side: side
  };
}

function humanizeMetricDirection(direction: ResultsTableDirection): string {
  return direction === "higher_better" ? "higher values preferred" : "lower values preferred";
}

export function figureSelectorAndCaptionWriter(context: ExperimentArtifactContext): PaperManuscriptFigure[] {
  return primaryComparisonFigureBuilder(context);
}

export function primaryComparisonFigureBuilder(context: ExperimentArtifactContext): PaperManuscriptFigure[] {
  const comparison = context.results.primary_comparison;
  if (!comparison) {
    return [];
  }
  return [
    {
      caption: `Observations linked by the declared primary comparison for ${comparison.metric_label}; ${humanizeMetricDirection(comparison.metric_direction)}.`,
      bars: [
        buildPrimaryComparisonVisualRow(comparison, "subject"),
        buildPrimaryComparisonVisualRow(comparison, "reference")
      ],
      source_refs: buildArtifactSourceRefs([
        `result_analysis.results_artifact.comparison:${comparison.comparison_id}`,
        `result_analysis.results_plan.primary_comparison_id:${comparison.comparison_id}`
      ])
    }
  ];
}

function visualCaptionHasDistinctRole(caption: string): boolean {
  return /\b(trend|distribution|trade-?off|trajectory|pattern|heterogeneity|variation)\b/iu.test(caption);
}

function hasInternalCaptionToken(caption: string): boolean {
  return (
    /[a-z0-9]+_[a-z0-9_]+/u.test(caption) ||
    /\.(json|svg|txt|log)\b/iu.test(caption) ||
    /\bstderr\b|\bstdout\b|\bmetric_table\b/iu.test(caption)
  );
}

function sanitizeVisualCaption(caption: string | undefined, fallback: string): string {
  const normalized = cleanString(caption);
  if (!normalized || hasInternalCaptionToken(normalized)) {
    return fallback;
  }
  return normalized;
}

function sanitizeCandidateTables(tables: PaperManuscriptTable[] | undefined): PaperManuscriptTable[] | undefined {
  if (!tables || tables.length === 0) {
    return tables;
  }
  return tables.map((table) => ({
    ...table,
    caption: sanitizeVisualCaption(table.caption, "Main-table summary retained for reproducible reporting.")
  }));
}

function makeMainTablesSelfContained(
  tables: PaperManuscriptTable[] | undefined,
  context: ExperimentArtifactContext
): PaperManuscriptTable[] | undefined {
  if (!tables?.length) {
    return tables;
  }
  const primaryComparison = context.results.primary_comparison;
  return tables.map((table) => {
    const rows = dedupeReaderFacingTableRows(table.rows.map((row) => {
      if (!primaryComparison || row.comparison_id !== primaryComparison.comparison_id) {
        return row;
      }
      if (row.observation_id === primaryComparison.subject.observation_id) {
        return {
          ...row,
          label: `${primaryComparison.subject.series_label} (${primaryComparison.subject.series_role} role, subject)`
        };
      }
      if (row.observation_id === primaryComparison.reference.observation_id) {
        return {
          ...row,
          label: `${primaryComparison.reference.series_label} (baseline role, reference)`
        };
      }
      return row;
    }));
    return {
      ...table,
      rows
    };
  });
}

function dedupeReaderFacingTableRows(rows: PaperManuscriptVisualRow[]): PaperManuscriptVisualRow[] {
  const compact: PaperManuscriptVisualRow[] = [];
  const seenDeltaValues = new Set<string>();
  for (const row of rows) {
    const label = cleanString(row.label);
    const valueKey = typeof row.value === "number" ? String(Number(row.value.toFixed(6))) : cleanString(String(row.value));
    if (row.comparison_side === "difference" || /^subject-minus-reference difference$/iu.test(label)) {
      const differenceKey = `${row.comparison_id || ""}:${row.metric_id || ""}:${valueKey}`;
      if (seenDeltaValues.has(differenceKey)) {
        continue;
      }
      seenDeltaValues.add(differenceKey);
    }
    compact.push(row);
  }
  return compact;
}

function dedupeReaderFacingTables<T extends { caption: string; rows: PaperManuscriptVisualRow[] }>(tables: T[]): T[] {
  const compact: T[] = [];
  const seen = new Set<string>();
  for (const table of tables) {
    const key = [
      cleanString(table.caption).toLowerCase(),
      ...table.rows.map((row) => `${cleanString(row.label).toLowerCase()}=${Number.isFinite(row.value) ? row.value : String(row.value)}`)
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    compact.push(table);
  }
  return compact;
}

function sanitizeCandidateFigures(figures: PaperManuscriptFigure[] | undefined): PaperManuscriptFigure[] | undefined {
  if (!figures || figures.length === 0) {
    return figures;
  }
  return figures
    .filter((figure) => !isNoisyMixedMetricFigure(figure))
    .map((figure) => ({
      ...figure,
      caption: sanitizeVisualCaption(
        figure.caption,
        "Dataset-level outcome summary with uncertainty-aware interpretation retained in the main paper."
      )
    }));
}

function attachFallbackSourceRefsToTables(
  tables: PaperManuscriptTable[] | undefined,
  fallbackIds: string[]
): PaperManuscriptTable[] | undefined {
  if (!tables || tables.length === 0) {
    return tables;
  }
  const fallbackSourceRefs = buildArtifactSourceRefs(fallbackIds);
  return tables.map((table) => ({
    ...table,
    ...(table.source_refs?.length ? { source_refs: table.source_refs } : fallbackSourceRefs ? { source_refs: fallbackSourceRefs } : {})
  }));
}

function attachFallbackSourceRefsToSections(
  sections: PaperManuscriptSection[] | undefined,
  fallbackIds: string[]
): PaperManuscriptSection[] | undefined {
  if (!sections || sections.length === 0) {
    return sections;
  }
  const fallbackSourceRefs = buildArtifactSourceRefs(fallbackIds);
  return sections.map((section) => ({
    ...section,
    ...(section.source_refs?.length ? { source_refs: section.source_refs } : fallbackSourceRefs ? { source_refs: fallbackSourceRefs } : {})
  }));
}

function attachFallbackSourceRefsToFigures(
  figures: PaperManuscriptFigure[] | undefined,
  fallbackIds: string[]
): PaperManuscriptFigure[] | undefined {
  if (!figures || figures.length === 0) {
    return figures;
  }
  const fallbackSourceRefs = buildArtifactSourceRefs(fallbackIds);
  return figures.map((figure) => ({
    ...figure,
    ...(figure.source_refs?.length ? { source_refs: figure.source_refs } : fallbackSourceRefs ? { source_refs: fallbackSourceRefs } : {})
  }));
}

function filterExplicitAuthoredTables(
  tables: PaperManuscriptTable[] | undefined
): PaperManuscriptTable[] | undefined {
  const authored = tables?.filter((table) =>
    hasArtifactSourceRef(table.source_refs, AUTHORED_MAIN_TABLE_SOURCE_REF_ID)
  );
  return authored?.length ? authored : undefined;
}

function filterExplicitAuthoredFigures(
  figures: PaperManuscriptFigure[] | undefined
): PaperManuscriptFigure[] | undefined {
  const authored = figures?.filter((figure) =>
    hasArtifactSourceRef(figure.source_refs, AUTHORED_MAIN_FIGURE_SOURCE_REF_ID)
  );
  return authored?.length ? authored : undefined;
}

function hasArtifactSourceRef(
  refs: PaperSourceRef[] | undefined,
  id: string
): boolean {
  return Boolean(refs?.some((ref) => ref.kind === "artifact" && ref.id === id));
}

function dropRedundantFiguresAgainstTables(
  tables: PaperManuscriptTable[] | undefined,
  figures: PaperManuscriptFigure[] | undefined
): PaperManuscriptFigure[] | undefined {
  if (!tables?.length || !figures?.length) {
    return figures;
  }
  return figures.filter((figure) => {
    if (isNoisyMixedMetricFigure(figure)) {
      return false;
    }
    const figureLabels = new Set(figure.bars.map((row) => normalizeVisualComparisonLabel(row.label)));
    return !tables.some((table) => {
      const tableLabels = new Set(table.rows.map((row) => normalizeVisualComparisonLabel(row.label)));
      const overlap = computeSetOverlap(tableLabels, figureLabels);
      return overlap >= 0.75 && (!visualCaptionHasDistinctRole(figure.caption) || /table|complementary|same comparison/iu.test(figure.caption));
    });
  });
}

function isNoisyMixedMetricFigure(figure: PaperManuscriptFigure): boolean {
  const metricIds = new Set(
    figure.bars.map((row) => cleanString(row.metric_id)).filter(Boolean)
  );
  return metricIds.size > 1;
}

function normalizeVisualComparisonLabel(label: string): string {
  return cleanString(label)
    .toLowerCase()
    .replace(/\([^)]*\)/gu, "")
    .replace(/\bmean\s+ci95\b.*$/giu, "")
    .replace(/\bn\s*=\s*\d+\b/giu, "")
    .replace(/\bbaseline\b/giu, "")
    .replace(/[;:,]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function computeSetOverlap(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  return intersection / union.size;
}

export function pageBudgetManager(input: {
  draft: Pick<PaperDraft, "sections">;
  profile: PaperProfileConfig;
}): PageBudgetManagerReport {
  const profile = resolvePaperProfile(input.profile);
  const estimatedWordsPerPage = profile.estimated_words_per_page || 650;
  const targetMainWords = profile.target_main_pages * estimatedWordsPerPage;
  const configuredMinimumMainWords = profile.minimum_main_pages * estimatedWordsPerPage;
  const minimumMainWords = Math.round(Math.max(targetMainWords * 0.62, configuredMinimumMainWords));
  const maximumMainWords = Math.round(Math.max(targetMainWords * 1.15, minimumMainWords * 1.1));
  const estimatedMainWords = estimateDraftWords(input.draft.sections);
  const sections = SECTION_BUDGET_WEIGHTS.map((spec) => {
    const targetWords = Math.round(targetMainWords * spec.weight);
    const minimumWords = Math.round(targetWords * (spec.hardMinimum ? 0.78 : 0.6));
    const maximumWords = Math.round(targetWords * 1.35);
    const section = findSection(input.draft.sections, spec.heading);
    const currentWords = estimateParagraphWords(section?.paragraphs || []);
    const status: SectionBudgetEntry["status"] =
      currentWords < Math.round(targetWords * 0.5)
        ? "fail"
        : currentWords < minimumWords
          ? "warn"
          : "ok";
    return {
      heading: spec.heading,
      minimum_words: minimumWords,
      target_words: targetWords,
      maximum_words: maximumWords,
      hard_minimum: Boolean(spec.hardMinimum),
      current_words: currentWords,
      status
    };
  });

  const warnings: string[] = [];
  if (estimatedMainWords < Math.round(targetMainWords * 0.55)) {
    warnings.push(
      `Estimated main-body length (${estimatedMainWords} words) is far below the ${profile.target_main_pages}-page target budget.`
    );
  } else if (estimatedMainWords < minimumMainWords && minimumMainWords - estimatedMainWords > Math.max(75, Math.round(minimumMainWords * 0.03))) {
    warnings.push(
      `Estimated main-body length (${estimatedMainWords} words) is below the minimum budget floor (${minimumMainWords} words).`
    );
  }
  const failedSections = sections.filter((section) => section.status === "fail");
  const autoExpandHeadings = uniqueStrings([
    ...sections.filter((section) => section.status !== "ok").map((section) => section.heading),
    ...(estimatedMainWords < minimumMainWords
      ? sections
          .filter((section) => section.current_words < section.target_words)
          .sort((left, right) => (right.target_words - right.current_words) - (left.target_words - left.current_words))
          .map((section) => section.heading)
      : [])
  ]);
  if (failedSections.length > 0) {
    warnings.push(
      `Core sections are too short for the venue budget: ${failedSections.map((item) => item.heading).join(", ")}.`
    );
  }

  return {
    column_count: profile.column_count,
    target_main_pages: profile.target_main_pages,
    minimum_main_pages: profile.minimum_main_pages,
    main_page_limit: profile.main_page_limit,
    references_counted: profile.references_counted,
    appendix_allowed: profile.appendix_allowed,
    estimated_words_per_page: estimatedWordsPerPage,
    minimum_main_words: minimumMainWords,
    target_main_words: targetMainWords,
    maximum_main_words: maximumMainWords,
    estimated_main_words: estimatedMainWords,
    status:
      warnings.length === 0
        ? "ok"
        : failedSections.length > 0 || estimatedMainWords < Math.round(targetMainWords * 0.55)
          ? "fail"
          : "warn",
    sections,
    warnings,
    auto_expand_headings: autoExpandHeadings
  };
}

export function appendixRouter(input: {
  context: ExperimentArtifactContext;
  profile: PaperProfileConfig;
}): AppendixReference[] {
  const profile = resolvePaperProfile(input.profile);
  if (!profile.appendix_allowed) {
    return [];
  }
  const references: AppendixReference[] = [];
  const preferred = new Set(profile.prefer_appendix_for);

  if (preferred.has("per_fold_results") && input.context.results.dataset_summaries.length > 0) {
    references.push({
      label: "Appendix A",
      target_heading: "Appendix A. Extended Dataset and Repeat-Level Results",
      reason: "repeat-level or per-dataset detail"
    });
  }
  if (preferred.has("hyperparameter_grids") && input.context.method.hyperparameter_notes.length > 0) {
    references.push({
      label: references.length === 0 ? "Appendix A" : "Appendix B",
      target_heading: `${references.length === 0 ? "Appendix A" : "Appendix B"}. Search Space and Configuration Details`,
      reason: "hyperparameter configuration"
    });
  }
  if (preferred.has("environment_dump") && (input.context.method.runtime_measurement || input.context.method.memory_measurement)) {
    references.push({
      label: references.length === 0 ? "Appendix A" : references.length === 1 ? "Appendix B" : "Appendix C",
      target_heading: `${references.length === 0 ? "Appendix A" : references.length === 1 ? "Appendix B" : "Appendix C"}. Reproducibility and Environment Notes`,
      reason: "reproducibility-oriented environment details"
    });
  }
  if (preferred.has("extended_error_analysis") && input.context.discussion.limitations.length > 0) {
    references.push({
      label:
        references.length === 0
          ? "Appendix A"
          : references.length === 1
            ? "Appendix B"
            : references.length === 2
              ? "Appendix C"
              : "Appendix D",
      target_heading: `${references.length === 0 ? "Appendix A" : references.length === 1 ? "Appendix B" : references.length === 2 ? "Appendix C" : "Appendix D"}. Extended Failure Analysis`,
      reason: "extended limitation and failure analysis"
    });
  }

  return references;
}

export function reproducibilityAppendixBuilder(context: ExperimentArtifactContext): AppendixSection | undefined {
  if (!context.reproducibility.has_artifact) {
    return undefined;
  }
  return {
    appendix_label: "Appendix",
    heading: "Appendix. Reproducibility and Measurement Notes",
    paragraphs: [
      uniqueStrings([
        ...context.reproducibility.artifact_notes,
        context.method.seeds.length > 0
          ? `Explicit seeds: ${context.method.seeds.join(", ")}.`
          : "",
        context.method.runtime_measurement
          ? "Runtime was measured and summarized in the reported evaluation outputs."
          : "",
        context.method.memory_measurement
          ? "Peak memory was measured and summarized in the reported evaluation outputs."
          : ""
      ])
        .filter(Boolean)
        .join(" ")
    ].filter(Boolean)
  };
}

export function appendixBuilder(input: {
  context: ExperimentArtifactContext;
  profile: PaperProfileConfig;
}): AppendixPlan {
  const references = appendixRouter({
    context: input.context,
    profile: resolvePaperProfile(input.profile)
  });
  const sections: AppendixSection[] = [];
  const tables: PaperManuscriptTable[] = [];
  const figures: PaperManuscriptFigure[] = [];

  for (const reference of references) {
    if (/repeat-level|per-dataset/iu.test(reference.reason)) {
      sections.push({
        appendix_label: reference.label,
        heading: reference.target_heading,
        paragraphs: input.context.results.dataset_summaries.map((item) => item.summary).slice(0, 6)
      });
      const primaryTable = primaryComparisonTableBuilder(input.context)[0];
      if (primaryTable) {
        tables.push({
          ...primaryTable,
          caption: "Extended declared primary comparison retained outside the main paper.",
          rows: primaryTable.rows.map((row) => ({ ...row }))
        });
      }
      continue;
    }
    if (/hyperparameter/iu.test(reference.reason)) {
      sections.push({
        appendix_label: reference.label,
        heading: reference.target_heading,
        paragraphs: [
          input.context.method.hyperparameter_notes.join(" ") ||
            "The current artifacts expose only partial search-space information."
        ]
      });
      continue;
    }
    if (/reproducibility-oriented environment/iu.test(reference.reason)) {
      const reproducibilitySection = reproducibilityAppendixBuilder(input.context);
      if (reproducibilitySection) {
        sections.push({
          ...reproducibilitySection,
          appendix_label: reference.label,
          heading: reference.target_heading
        });
      }
      continue;
    }
    if (/extended limitation|failure analysis/iu.test(reference.reason)) {
      sections.push({
        appendix_label: reference.label,
        heading: reference.target_heading,
        paragraphs: uniqueStrings([
          ...input.context.discussion.limitations,
          ...input.context.results.heterogeneity_notes
        ]).slice(0, 6)
      });
    }
  }

  return {
    sections,
    tables,
    figures,
    cross_references: references
  };
}

export function claimStrengthRewriter(input: {
  draft: PaperDraft;
  context: ExperimentArtifactContext;
}): { draft: PaperDraft; report: ClaimStrengthRewriteReport } {
  const rewrites: ClaimStrengthRewrite[] = [];
  const sections = input.draft.sections.map((section) => ({
    ...section,
    paragraphs: section.paragraphs.map((paragraph) => {
      const rewritten = rewriteTextForClaimStrength(paragraph.text, input.context, rewrites);
      return rewritten === paragraph.text ? paragraph : { ...paragraph, text: rewritten };
    })
  }));
  const claims = input.draft.claims.map((claim) => {
    const rewritten = rewriteTextForClaimStrength(claim.statement, input.context, rewrites);
    return rewritten === claim.statement ? claim : { ...claim, statement: rewritten };
  });
  return {
    draft: {
      ...input.draft,
      sections,
      claims
    },
    report: { rewrites }
  };
}

export function manuscriptConsistencyLinter(input: {
  manuscript: PaperManuscript;
  context: ExperimentArtifactContext;
}): ConsistencyLintReport {
  const issues: ConsistencyLintIssue[] = [];
  const abstractText = cleanString(input.manuscript.abstract);
  const methodText = getSectionText(input.manuscript.sections, "Method");
  const resultsText = getSectionText(input.manuscript.sections, "Results");
  const discussionText = getSectionText(input.manuscript.sections, "Discussion");
  const conclusionText = getSectionText(input.manuscript.sections, "Conclusion");

  for (const modelName of input.context.method.model_names) {
    if (
      modelName &&
      !includesWord(methodText, modelName) &&
      (includesWord(resultsText, modelName) || includesWord(discussionText, modelName))
    ) {
      issues.push({
        kind: "method_results_mismatch",
        severity: "error",
        finding: "contradiction",
        message: `Results or Discussion mention ${modelName}, but Method does not describe it.`,
        involved_sections: ["Method", includesWord(resultsText, modelName) ? "Results" : "Discussion"],
        reason: "method/results model inventory drift"
      });
    }
  }

  for (const caption of [
    ...(input.manuscript.tables || []).map((item) => item.caption),
    ...(input.manuscript.figures || []).map((item) => item.caption),
    ...((input.manuscript.appendix_tables as PaperManuscriptTable[] | undefined) || []).map((item) => item.caption),
    ...((input.manuscript.appendix_figures as PaperManuscriptFigure[] | undefined) || []).map((item) => item.caption)
  ]) {
    if (hasInternalCaptionToken(caption)) {
      issues.push({
        kind: "caption_internal_name",
        severity: "error",
        finding: "contradiction",
        message: `Caption exposes an internal variable name or artifact token: "${caption}".`,
        reason: "caption leaks internal artifact naming"
      });
    }
  }

  const allText = [
    abstractText,
    ...input.manuscript.sections.flatMap((section) => section.paragraphs)
  ].join(" ");
  if (/\breproducib(?:le|ility requirement satisfied)\b/iu.test(allText) && !input.context.reproducibility.has_artifact) {
    issues.push({
      kind: "reproducibility_claim",
      severity: "error",
      finding: "contradiction",
      message: "The manuscript makes a reproducibility-satisfaction claim without supporting artifacts.",
      involved_sections: ["Abstract"],
      reason: "reproducibility claim is not backed by reproducibility artifacts"
    });
  }

  issues.push(
    ...lintCountConsistency({
      manuscript: input.manuscript,
      context: input.context
    })
  );
  issues.push(
    ...lintNumericConsistency({
      manuscript: input.manuscript,
      context: input.context
    })
  );
  issues.push(
    ...lintStrongClaimWording({
      abstractText,
      resultsText,
      conclusionText,
      context: input.context
    })
  );

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues
  };
}

export function appendixConsistencyLinter(input: {
  manuscript: PaperManuscript;
  appendixPlan: AppendixPlan;
  pageBudget: PageBudgetManagerReport;
}): ConsistencyLintReport {
  const issues: ConsistencyLintIssue[] = [];
  const mainText = input.manuscript.sections.flatMap((section) => section.paragraphs).join(" ");
  const appendixHeadings = new Set((input.manuscript.appendix_sections || []).map((section) => section.heading));

  for (const reference of input.appendixPlan.cross_references) {
    if (!appendixHeadings.has(reference.target_heading)) {
      issues.push({
        kind: "appendix_reference_missing",
        severity: "error",
        message: `Main-body appendix routing points to "${reference.target_heading}", but the appendix section is missing.`
      });
    }
    if (includesWord(mainText, reference.label) || includesWord(mainText, reference.target_heading)) {
      continue;
    }
    issues.push({
      kind: "appendix_reference_missing",
      severity: "warning",
      message: `Appendix content "${reference.target_heading}" exists, but the main paper never references it.`
    });
  }

  const resultsBudget = input.pageBudget.sections.find((section) => normalizeHeading(section.heading) === "results");
  if (resultsBudget && resultsBudget.current_words < Math.round(resultsBudget.target_words * 0.55) && input.appendixPlan.sections.length > 0) {
    issues.push({
      kind: "main_logic_thin",
      severity: "warning",
      message: "Appendix routing is too aggressive: the main Results section remains too short relative to the target budget."
    });
  }

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues
  };
}

function buildEvidenceInsufficiencyReport(input: {
  pageBudget: PageBudgetManagerReport;
  methodReport: CompletenessReport;
  resultsReport: CompletenessReport;
  relatedWorkReport: RelatedWorkRichnessReport;
  discussionReport: CompletenessReport;
}): EvidenceInsufficiencyReport {
  const thinSectionSet = new Set(
    uniqueStrings([
      ...input.pageBudget.sections.filter((section) => section.status !== "ok").map((section) => section.heading),
      ...(input.methodReport.status === "incomplete" ? ["Method"] : []),
      ...(input.resultsReport.status === "incomplete" ? ["Results"] : []),
      ...(input.relatedWorkReport.status === "incomplete" ? ["Related Work"] : []),
      ...(input.discussionReport.status === "incomplete" ? ["Discussion", "Limitations"] : [])
    ])
  );
  const sectionDiagnostics: SectionEvidenceDiagnostic[] = [
    buildSectionEvidenceDiagnostic("Method", thinSectionSet, mapMethodMissingToEvidenceCategories(input.methodReport.missing)),
    buildSectionEvidenceDiagnostic("Results", thinSectionSet, mapResultsMissingToEvidenceCategories(input.resultsReport.missing)),
    buildSectionEvidenceDiagnostic(
      "Related Work",
      thinSectionSet,
      mapRelatedWorkMissingToEvidenceCategories(input.relatedWorkReport.missing)
    ),
    buildSectionEvidenceDiagnostic(
      "Discussion",
      thinSectionSet,
      mapDiscussionMissingToEvidenceCategories(input.discussionReport.missing)
    ),
    buildSectionEvidenceDiagnostic(
      "Limitations",
      thinSectionSet,
      input.discussionReport.status === "incomplete" ? ["error analysis / limitations"] : []
    )
  ];
  const missingEvidenceCategories = uniqueStrings(
    sectionDiagnostics.flatMap((diagnostic) => diagnostic.missing_evidence_categories)
  );
  return {
    expandable_from_existing_evidence: sectionDiagnostics.every(
      (diagnostic) => !diagnostic.thin || diagnostic.expandable_from_existing_evidence
    ),
    missing_evidence_categories: missingEvidenceCategories,
    thin_sections: sectionDiagnostics.filter((diagnostic) => diagnostic.thin).map((diagnostic) => diagnostic.section),
    blocked_by_evidence_insufficiency: sectionDiagnostics.some((diagnostic) => diagnostic.blocked_by_evidence_insufficiency),
    section_diagnostics: sectionDiagnostics.filter(
      (diagnostic) => diagnostic.thin || diagnostic.missing_evidence_categories.length > 0
    )
  };
}

function buildSectionEvidenceDiagnostic(
  section: string,
  thinSectionSet: Set<string>,
  missingEvidenceCategories: string[]
): SectionEvidenceDiagnostic {
  const thin = thinSectionSet.has(section);
  const normalizedMissing = uniqueStrings(missingEvidenceCategories);
  return {
    section,
    thin,
    missing_evidence_categories: normalizedMissing,
    expandable_from_existing_evidence: normalizedMissing.length === 0,
    blocked_by_evidence_insufficiency: thin && normalizedMissing.length > 0
  };
}

function mapMethodMissingToEvidenceCategories(missing: string[]): string[] {
  const categories: string[] = [];
  if (
    missing.some((item) =>
      [
        "dataset names",
        "dataset source",
        "#samples",
        "#features",
        "#classes",
        "imbalance or missingness"
      ].includes(item)
    )
  ) {
    categories.push("dataset/task detail");
  }
  if (missing.some((item) => ["preprocessing steps/order", "fold-internal fit scope"].includes(item))) {
    categories.push("method detail");
  }
  if (
    missing.some((item) =>
      [
        "outer folds",
        "inner folds",
        "repeats",
        "stratification",
        "seeds",
        "hyperparameter search space",
        "selection/reporting metrics"
      ].includes(item)
    )
  ) {
    categories.push("experimental setup");
  }
  if (missing.some((item) => ["runtime measurement", "memory measurement"].includes(item))) {
    categories.push("resource measurement");
  }
  return categories;
}

function isResourceOnlyMethodGap(report: CompletenessReport): boolean {
  return report.missing.length > 0
    && report.missing.every((item) => ["runtime measurement", "memory measurement"].includes(item));
}

function mapResultsMissingToEvidenceCategories(missing: string[]): string[] {
  const categories: string[] = [];
  if (missing.some((item) => ["aggregate summary", "per-dataset results"].includes(item))) {
    categories.push("baseline comparison");
    categories.push("dataset/task detail");
  }
  if (
    missing.some((item) =>
      [
        "dispersion estimates",
        "CI or CI-unavailable rationale",
        "paired/repeated comparison artifact",
        "scientific figure with informative caption"
      ].includes(item)
    )
  ) {
    categories.push("statistical reporting");
  }
  return categories;
}

function mapRelatedWorkMissingToEvidenceCategories(missing: string[]): string[] {
  return missing.length > 0 ? ["related work specificity"] : [];
}

function mapDiscussionMissingToEvidenceCategories(missing: string[]): string[] {
  const categories: string[] = [];
  if (missing.some((item) => ["result interpretation"].includes(item))) {
    categories.push("baseline comparison");
  }
  if (missing.some((item) => ["generalization/evaluation limits", "practical implication"].includes(item))) {
    categories.push("error analysis / limitations");
  }
  return categories;
}

function pushCompletenessIssue(
  issues: ScientificValidationIssue[],
  category: Extract<ScientificValidationCategory, "method_completeness" | "results_richness" | "related_work_richness" | "discussion_richness">,
  code: string,
  report: CompletenessReport,
  fallbackMessage: string,
  diagnostic?: SectionEvidenceDiagnostic
): void {
  if (report.status === "complete") {
    return;
  }
  const details = uniqueStrings([...report.missing, ...report.warnings]).slice(0, 8);
  const resourceOnlyMethodGap = category === "method_completeness" && isResourceOnlyMethodGap(report);
  issues.push({
    code,
    source: "scientific_validation",
    category,
    severity: "warning",
    policy: resourceOnlyMethodGap ? "warn_only" : "strict_fail",
    finding: resourceOnlyMethodGap
      ? "informational"
      : diagnostic?.blocked_by_evidence_insufficiency
        ? "unverifiable"
        : "repairable",
    message: details[0] || fallbackMessage,
    details: details.slice(1),
    ...(diagnostic?.missing_evidence_categories.length ? { missing_evidence_categories: diagnostic.missing_evidence_categories } : {}),
    ...(diagnostic?.thin ? { thin_sections: [diagnostic.section] } : {}),
    ...(diagnostic ? { expandable_from_existing_evidence: diagnostic.expandable_from_existing_evidence } : {}),
    ...(diagnostic ? { blocked_by_evidence_insufficiency: diagnostic.blocked_by_evidence_insufficiency } : {})
  });
}

function convertLintIssueToGateIssue(
  issue: ConsistencyLintIssue,
  source: "consistency_lint" | "appendix_lint",
  mode: PaperValidationMode
): WritePaperGateDecisionIssue {
  const strictOnly =
    source === "appendix_lint" && (issue.kind === "main_logic_thin" || issue.kind === "appendix_reference_missing");
  const policy: ScientificValidationPolicy =
    issue.severity === "error" ? "always_fail" : strictOnly ? "strict_fail" : "warn_only";
  const blocking = policy === "always_fail" || (policy === "strict_fail" && mode === "strict_paper");
  return {
    code: issue.kind,
    source,
    category: source === "appendix_lint" ? "appendix" : "consistency",
    severity: issue.severity,
    policy,
    finding: issue.finding || (issue.severity === "error" ? "contradiction" : "informational"),
    message: issue.message,
    ...(issue.involved_sections?.length ? { involved_sections: issue.involved_sections } : {}),
    ...(issue.normalized_facts?.length ? { normalized_facts: issue.normalized_facts } : {}),
    ...(issue.reason ? { reason: issue.reason } : {}),
    ...(issue.evidence?.length ? { evidence: issue.evidence } : {}),
    blocking,
    outcome: blocking ? "fail" : (issue.finding || "informational") === "unverifiable" ? "unverifiable" : "warn"
  };
}

function lintCountConsistency(input: {
  manuscript: PaperManuscript;
  context: ExperimentArtifactContext;
}): ConsistencyLintIssue[] {
  const expectedFacts = collectExpectedCountFacts(input.context);
  const observedFacts = collectObservedCountFacts(input.manuscript, input.context);
  const issues: ConsistencyLintIssue[] = [];

  issues.push(...buildObservedFactDriftIssues(observedFacts, "count_inconsistency"));

  for (const observedFact of observedFacts) {
    const comparableFacts = expectedFacts.filter((candidate) => areComparableNumericFacts(observedFact, candidate));
    if (comparableFacts.length === 0) {
      if (shouldWarnOnUnverifiableFact(observedFact.source)) {
        issues.push({
          kind: "count_unverifiable",
          severity: "warning",
          finding: "unverifiable",
          message: `${observedFact.location} cites ${formatNumber(observedFact.value)} as a ${humanizeCountKind(observedFact.count_kind)}, but the current artifacts do not expose a comparable structured count.`,
          involved_sections: [observedFact.location],
          normalized_facts: [observedFact],
          reason: "no comparable structured count fact is available for this count claim"
        });
      }
      continue;
    }
    if (comparableFacts.some((candidate) => areFactValuesEquivalent(observedFact, candidate))) {
      continue;
    }
    if (isSeedCountVsProtocolRepeatMismatch(observedFact, comparableFacts)) {
      continue;
    }
    issues.push({
      kind: "count_inconsistency",
      severity: "error",
      finding: "contradiction",
      message: `${observedFact.location} reports ${formatNumber(observedFact.value)} ${humanizeCountKind(observedFact.count_kind)}, but upstream artifacts support ${formatNumber(comparableFacts[0]?.value)}.`,
      involved_sections: [observedFact.location],
      normalized_facts: [observedFact, ...comparableFacts.slice(0, 1)],
      reason: "comparable structured count facts disagree with the manuscript claim",
      evidence: comparableFacts.slice(0, 2).map((fact) => `${fact.location}: ${fact.raw_text}`)
    });
  }

  return dedupeConsistencyIssues(issues);
}

function isSeedCountVsProtocolRepeatMismatch(
  observedFact: NormalizedNumericFact,
  comparableFacts: NormalizedNumericFact[]
): boolean {
  if (observedFact.fact_kind !== "count" || observedFact.count_kind !== "repeat_count") {
    return false;
  }
  if (!/\bseeds?\b/iu.test(observedFact.raw_text)) {
    return false;
  }
  return comparableFacts.some((candidate) =>
    candidate.fact_kind === "count"
    && candidate.count_kind === "repeat_count"
    && /\brepeats?|repeated evaluations?\b/iu.test(candidate.raw_text)
    && (candidate.source_refs || []).some((ref) =>
      /protocol\.repeats|evaluation_steps/iu.test(String(ref.id || ""))
    )
  );
}

function lintNumericConsistency(input: {
  manuscript: PaperManuscript;
  context: ExperimentArtifactContext;
}): ConsistencyLintIssue[] {
  const issues: ConsistencyLintIssue[] = [];
  const expectedFacts = collectExpectedMetricFacts(input.context);
  if (expectedFacts.length === 0) {
    return issues;
  }
  const observedFacts = collectObservedMetricFacts(input.manuscript, input.context);
  const mainFacts = observedFacts.filter((fact) => !isAppendixFactSource(fact.source));
  const appendixFacts = observedFacts.filter((fact) => isAppendixFactSource(fact.source));

  issues.push(...buildObservedFactDriftIssues(mainFacts, "numeric_inconsistency"));

  for (const observedFact of observedFacts) {
    if (isObjectiveThresholdFact(observedFact)) {
      continue;
    }
    const comparableFacts = expectedFacts.filter(
      (candidate) => areComparableNumericFacts(observedFact, candidate)
    );
    if (comparableFacts.length === 0) {
      if (shouldWarnOnUnverifiableFact(observedFact.source)) {
        issues.push({
          kind: "numeric_unverifiable",
          severity: "warning",
          finding: "unverifiable",
          message: `${observedFact.location} cites ${formatNumber(observedFact.value)}, but the current artifacts do not expose a comparable structured numeric fact for ${observedFact.metric_key || "that metric"}.`,
          involved_sections: [observedFact.location],
          normalized_facts: [observedFact],
          reason: "no comparable structured metric fact is available at the same metric/scope/aggregation level"
        });
      }
      continue;
    }
    if (comparableFacts.some((candidate) => areFactValuesEquivalent(observedFact, candidate))) {
      continue;
    }
    const appendixMatch = appendixFacts.find(
      (candidate) =>
        candidate.fact_id !== observedFact.fact_id
        && areComparableNumericFacts(observedFact, candidate)
        && areFactValuesEquivalent(observedFact, candidate)
    );
    if (appendixMatch && allowsAppendixOnlyWarning(observedFact.source)) {
      issues.push({
        kind: "appendix_only_numeric_reference",
        severity: "warning",
        finding: "unverifiable",
        message: `${observedFact.location} cites ${formatNumber(observedFact.value)}, but that comparable value appears only in appendix-level detail rather than the main Results evidence.`,
        involved_sections: [observedFact.location, appendixMatch.location],
        normalized_facts: [observedFact, appendixMatch],
        reason: "the comparable value is only recoverable from appendix-level detail"
      });
      continue;
    }
    issues.push({
      kind: "numeric_inconsistency",
      severity: "error",
      finding: "contradiction",
      message: `${observedFact.location} cites ${formatNumber(observedFact.value)}, but the comparable structured results support ${formatNumber(comparableFacts[0]?.normalized_value)} for ${observedFact.metric_key || "that metric"}.`,
      involved_sections: [observedFact.location],
      normalized_facts: [observedFact, ...comparableFacts.slice(0, 2)],
      reason: "comparable structured numeric facts disagree with the manuscript claim",
      evidence: comparableFacts.slice(0, 2).map((fact) => `${fact.location}: ${fact.raw_text}`)
    });
  }

  return dedupeConsistencyIssues(issues);
}

function lintStrongClaimWording(input: {
  abstractText: string;
  resultsText: string;
  conclusionText: string;
  context: ExperimentArtifactContext;
}): ConsistencyLintIssue[] {
  const issues: ConsistencyLintIssue[] = [];
  const maxDelta = Math.max(
    0,
    ...input.context.results.dataset_summaries
      .map((item) => Math.abs(item.delta_value || 0))
      .filter((value) => Number.isFinite(value))
  );
  const hasIntervalSupport = input.context.results.ci_notes.length > 0;
  const hasRepeatedArtifact = input.context.results.paired_artifact_available;
  const highRiskZones = [
    { label: "Abstract", text: input.abstractText },
    { label: "Conclusion", text: input.conclusionText }
  ];

  for (const zone of highRiskZones) {
    if (!zone.text) {
      continue;
    }
    if (/\bstate-of-the-art\b/iu.test(zone.text)) {
      issues.push({
        kind: "unsupported_strong_claim",
        severity: "error",
        finding: "contradiction",
        message: `${zone.label} uses "state-of-the-art" language without structured support for that positioning.`,
        involved_sections: [zone.label],
        reason: "state-of-the-art framing has no supporting structured evidence"
      });
    }
    if (/\bsignificant(?:ly)? improvement\b/iu.test(zone.text)) {
      issues.push({
        kind: "unsupported_strong_claim",
        severity: "error",
        finding: "contradiction",
        message: `${zone.label} claims significant improvement without an explicit significance-testing artifact in the available results.`,
        involved_sections: [zone.label],
        reason: "significance wording exceeds available statistical evidence"
      });
    } else if (/\bsubstantial improvement\b|\blarge improvement\b/iu.test(zone.text) && maxDelta <= 0.05) {
      issues.push({
        kind: "unsupported_strong_claim",
        severity: "warning",
        finding: "unverifiable",
        message: `${zone.label} uses strong improvement language even though the observed delta remains small.`,
        involved_sections: [zone.label],
        reason: "wording is stronger than the observed effect size"
      });
    }
  }

  if (/\bsignificant(?:ly)? improvement\b|\bsubstantial improvement\b|\bstate-of-the-art\b/iu.test(input.resultsText) && (!hasIntervalSupport || !hasRepeatedArtifact)) {
    issues.push({
      kind: "unsupported_strong_claim",
      severity: "warning",
      finding: "unverifiable",
      message: "Results retain strong improvement language without enough statistical support.",
      involved_sections: ["Results"],
      reason: "statistical support is incomplete for the retained claim wording"
    });
  }

  return issues;
}

function collectExpectedCountFacts(context: ExperimentArtifactContext): NormalizedNumericFact[] {
  const facts: NormalizedNumericFact[] = [];
  const datasetCount =
    uniqueStrings(context.results.dataset_summaries.map((item) => cleanString(item.dataset)).filter(Boolean)).length
    || context.method.dataset_names.length;
  if (datasetCount > 0) {
    facts.push(
      buildStructuredNumericFact({
        factKind: "count",
        source: "artifact",
        location: "artifact.method.dataset_names",
        rawText: `${datasetCount} datasets`,
        value: datasetCount,
        countKind: "dataset_count",
        aggregationLevel: "aggregate",
        unit: "count",
        sourceRefs: buildArtifactSourceRefs(["experiment_plan.selected_design.datasets", "latest_results.protocol.datasets"])
      })
    );
  }
  const seedRepeatCount = context.method.seeds.length > 1 ? context.method.seeds.length : undefined;
  const repeatCount = seedRepeatCount || extractExpectedCountFromNotes(context.method.repeat_notes, "repeat_count");
  if (repeatCount) {
    facts.push(
      buildStructuredNumericFact({
        factKind: "count",
        source: "artifact",
        location: "artifact.method.repeats",
        rawText: `${repeatCount} repeats`,
        value: repeatCount,
        countKind: "repeat_count",
        aggregationLevel: "repeat",
        unit: "count",
        sourceRefs: buildArtifactSourceRefs(["experiment_plan.selected_design.evaluation_steps", "latest_results.protocol.repeats"])
      })
    );
  }
  const outerFoldCount = extractExpectedCountFromNotes(context.method.outer_fold_notes, "outer_fold_count");
  if (outerFoldCount) {
    facts.push(
      buildStructuredNumericFact({
        factKind: "count",
        source: "artifact",
        location: "artifact.method.outer_folds",
        rawText: `${outerFoldCount} outer folds`,
        value: outerFoldCount,
        countKind: "outer_fold_count",
        aggregationLevel: "fold",
        unit: "count",
        sourceRefs: buildArtifactSourceRefs(["experiment_plan.selected_design.evaluation_steps"])
      })
    );
  }
  const innerFoldCount = extractExpectedCountFromNotes(context.method.inner_fold_notes, "inner_fold_count");
  if (innerFoldCount) {
    facts.push(
      buildStructuredNumericFact({
        factKind: "count",
        source: "artifact",
        location: "artifact.method.inner_folds",
        rawText: `${innerFoldCount} inner folds`,
        value: innerFoldCount,
        countKind: "inner_fold_count",
        aggregationLevel: "fold",
        unit: "count",
        sourceRefs: buildArtifactSourceRefs(["experiment_plan.selected_design.evaluation_steps"])
      })
    );
  }
  const sampleCount = extractNumericNoteCount(context.method.sample_size_notes);
  if (sampleCount) {
    facts.push(
      buildStructuredNumericFact({
        factKind: "count",
        source: "artifact",
        location: "artifact.method.samples",
        rawText: `${sampleCount} samples`,
        value: sampleCount,
        countKind: "sample_count",
        aggregationLevel: "aggregate",
        unit: "count",
        sourceRefs: buildArtifactSourceRefs(["experiment_plan.selected_design.implementation_notes", "latest_results.protocol"])
      })
    );
  }
  return facts;
}

function collectObservedCountFacts(
  manuscript: PaperManuscript,
  context: ExperimentArtifactContext
): NormalizedNumericFact[] {
  return dedupeNumericFacts([
    ...extractCountFactsFromText({
      text: manuscript.abstract,
      source: "abstract",
      location: "Abstract",
      sourceRefs: undefined
    }),
    ...manuscript.sections.flatMap((section) =>
      section.paragraphs.flatMap((paragraph) =>
        extractCountFactsFromText({
          text: paragraph,
          source: mapSectionHeadingToNumericFactSource(section.heading),
          location: section.heading,
          sourceRefs: section.source_refs
        })
      )
    ),
    ...((manuscript.appendix_sections || []).flatMap((section) =>
      section.paragraphs.flatMap((paragraph) =>
        extractCountFactsFromText({
          text: paragraph,
          source: "appendix_section",
          location: section.heading,
          sourceRefs: section.source_refs
        })
      )
    ) || [])
  ]);
}

function collectExpectedMetricFacts(context: ExperimentArtifactContext): NormalizedNumericFact[] {
  return dedupeNumericFacts([
    ...context.results.aggregate_metric_facts,
    ...context.results.confidence_interval_facts
  ]);
}

function collectConfidenceIntervalMetricFacts(
  resultAnalysis: ResultAnalysisArtifact | undefined,
  primaryComparison: PrimaryComparisonSummary | undefined
): NormalizedNumericFact[] {
  if (!primaryComparison) {
    return [];
  }
  const confidenceIntervals = (resultAnalysis?.statistical_summary?.confidence_intervals || [])
    .filter((item) => item.metric_key === primaryComparison.metric_id);
  return dedupeNumericFacts(
    confidenceIntervals.flatMap((item) => {
      const metricKey = primaryComparison.metric_id;
      const lower = typeof item.lower === "number" && Number.isFinite(item.lower) ? item.lower : undefined;
      const upper = typeof item.upper === "number" && Number.isFinite(item.upper) ? item.upper : undefined;
      if (typeof lower !== "number" || typeof upper !== "number") {
        return [];
      }
      const rawMetricLabel = cleanString(item.label) || primaryComparison.metric_label;
      return [
        buildStructuredNumericFact({
          factKind: "metric",
          source: "artifact",
          location: `artifact.result_analysis.confidence_interval.${metricKey}.lower`,
          rawText: `${rawMetricLabel} CI lower ${formatNumber(lower)}`,
          value: lower,
          metricKey,
          metricLabel: `${rawMetricLabel} CI lower`,
          datasetScope: "aggregate",
          aggregationLevel: "aggregate",
          unit: "ci_lower",
          sourceRefs: buildArtifactSourceRefs(["result_analysis.statistical_summary.confidence_intervals"])
        }),
        buildStructuredNumericFact({
          factKind: "metric",
          source: "artifact",
          location: `artifact.result_analysis.confidence_interval.${metricKey}.upper`,
          rawText: `${rawMetricLabel} CI upper ${formatNumber(upper)}`,
          value: upper,
          metricKey,
          metricLabel: `${rawMetricLabel} CI upper`,
          datasetScope: "aggregate",
          aggregationLevel: "aggregate",
          unit: "ci_upper",
          sourceRefs: buildArtifactSourceRefs(["result_analysis.statistical_summary.confidence_intervals"])
        })
      ];
    })
  );
}

function collectObservedMetricFacts(
  manuscript: PaperManuscript,
  context: ExperimentArtifactContext
): NormalizedNumericFact[] {
  const sections = manuscript.sections;
  const appendixSections = manuscript.appendix_sections || [];
  return dedupeNumericFacts([
    ...extractMetricFactsFromText({
      text: manuscript.abstract,
      source: "abstract",
      location: "Abstract",
      context,
      sourceRefs: undefined
    }),
    ...sections.flatMap((section) =>
      section.paragraphs.flatMap((paragraph, paragraphIndex) =>
        extractMetricFactsFromText({
          text: paragraph,
          source: mapSectionHeadingToNumericFactSource(section.heading),
          location: section.heading,
          context,
          previousText: paragraphIndex > 0 ? section.paragraphs[paragraphIndex - 1] : undefined,
          sourceRefs: section.source_refs
        })
      )
    ),
    ...(manuscript.tables || []).flatMap((table, index) =>
      extractMetricFactsFromVisual({
        source: "table",
        location: `Table ${index + 1}`,
        caption: table.caption,
        rows: table.rows,
        context,
        sourceRefs: table.source_refs
      })
    ),
    ...(manuscript.figures || []).flatMap((figure, index) =>
      extractMetricFactsFromVisual({
        source: "figure",
        location: `Figure ${index + 1}`,
        caption: figure.caption,
        rows: figure.bars,
        context,
        sourceRefs: figure.source_refs
      })
    ),
    ...appendixSections.flatMap((section) =>
      section.paragraphs.flatMap((paragraph) =>
        extractMetricFactsFromText({
          text: paragraph,
          source: "appendix_section",
          location: section.heading,
          context,
          sourceRefs: section.source_refs
        })
      )
    ),
    ...((manuscript.appendix_tables || []).flatMap((table, index) =>
      extractMetricFactsFromVisual({
        source: "appendix_table",
        location: `Appendix Table ${index + 1}`,
        caption: table.caption,
        rows: table.rows,
        context,
        sourceRefs: table.source_refs
      })
    ) || []),
    ...((manuscript.appendix_figures || []).flatMap((figure, index) =>
      extractMetricFactsFromVisual({
        source: "appendix_figure",
        location: `Appendix Figure ${index + 1}`,
        caption: figure.caption,
        rows: figure.bars,
        context,
        sourceRefs: figure.source_refs
      })
    ) || [])
  ]);
}

function buildObservedFactDriftIssues(
  facts: NormalizedNumericFact[],
  kind: "numeric_inconsistency" | "count_inconsistency"
): ConsistencyLintIssue[] {
  const issues: ConsistencyLintIssue[] = [];
  const groups = new Map<string, NormalizedNumericFact[]>();
  for (const fact of facts) {
    if (fact.fact_kind === "metric" && isObjectiveThresholdFact(fact)) {
      continue;
    }
    // CI bounds are inherently paired (lower ≠ upper); grouping them by a
    // single comparable key produces false contradictions when the same
    // interval is reported consistently across sections.
    if (fact.unit === "ci_lower" || fact.unit === "ci_upper") {
      continue;
    }
    if (!fact.metric_key && !fact.count_kind) {
      continue;
    }
    const key = buildComparableFactKey(fact);
    if (!key) {
      continue;
    }
    const bucket = groups.get(key) || [];
    bucket.push(fact);
    groups.set(key, bucket);
  }
  for (const bucket of groups.values()) {
    const mainSectionFacts = bucket.filter((fact) =>
      ["abstract", "method", "results", "conclusion", "table", "figure"].includes(fact.source)
    );
    const distinctLocations = uniqueStrings(mainSectionFacts.map((fact) => fact.location));
    const distinctValues = mainSectionFacts.reduce<number[]>((values, fact) => {
      if (!values.some((value) => areApproxEqual(value, fact.normalized_value, fact.unit))) {
        values.push(fact.normalized_value);
      }
      return values;
    }, []);
    if (mainSectionFacts.length < 2 || distinctLocations.length < 2 || distinctValues.length < 2) {
      continue;
    }
    issues.push({
      kind,
      severity: "error",
      finding: "contradiction",
      message: `${joinHumanList(uniqueStrings(mainSectionFacts.map((fact) => fact.location)))} report conflicting ${humanizeComparableFactKey(bucket[0])} values.`,
      involved_sections: uniqueStrings(mainSectionFacts.map((fact) => fact.location)),
      normalized_facts: mainSectionFacts.slice(0, 4),
      reason: "comparable canonical facts disagree across main-manuscript sections",
      evidence: mainSectionFacts.slice(0, 4).map((fact) => `${fact.location}: ${fact.raw_text}`)
    });
  }
  return issues;
}

function extractCountFactsFromText(input: {
  text: string;
  source: NumericFactSource;
  location: string;
  sourceRefs?: PaperSourceRef[];
}): NormalizedNumericFact[] {
  const cleaned = cleanString(input.text);
  if (!cleaned) {
    return [];
  }
  const patternEntries: Array<{ kind: CountFactKind; pattern: RegExp }> = [
    { kind: "dataset_count", pattern: /(?<![\d,])(\d{1,3}(?:,\d{3})+|\d+)\s+datasets?\b/giu },
    {
      kind: "repeat_count",
      pattern:
        /(?<![\d,])(\d{1,3}(?:,\d{3})+|\d+)\s+(?:repeats?|repeated evaluations?|seeds?(?!\s+resamples?\b))\b/giu
    },
    { kind: "run_count", pattern: /(?<![\d,])(\d{1,3}(?:,\d{3})+|\d+)\s+runs?\b/giu },
    { kind: "outer_fold_count", pattern: /\bouter\s+(\d+)[-\s]?fold\b/giu },
    { kind: "outer_fold_count", pattern: /\b(\d+)[-\s]?fold outer\b/giu },
    { kind: "inner_fold_count", pattern: /\binner\s+(\d+)[-\s]?fold\b/giu },
    { kind: "inner_fold_count", pattern: /\b(\d+)[-\s]?fold inner\b/giu },
    { kind: "sample_count", pattern: /(?<![\d,])(\d{1,3}(?:,\d{3})+|\d+)\s+(?:samples?|instances?|rows)\b/giu },
    { kind: "sample_count", pattern: /\bn\s*=\s*(\d{1,3}(?:,\d{3})+|\d+)(?=[^.!?]{0,24}\b(?:samples?|instances?|rows)\b)/giu }
  ];
  return dedupeNumericFacts(
    patternEntries.flatMap(({ kind, pattern }) =>
      [...cleaned.matchAll(pattern)]
        .filter((match) => !shouldSkipCountFactMatch(cleaned, match, kind))
        .map((match) =>
          buildStructuredNumericFact({
          factKind: "count",
          source: input.source,
          location: input.location,
          rawText: cleanString(match[0]),
          value: parseNumericLiteral(match[1]),
          countKind: kind,
          aggregationLevel:
            kind === "outer_fold_count" || kind === "inner_fold_count"
              ? "fold"
              : kind === "repeat_count" || kind === "run_count"
                ? "repeat"
                : "aggregate",
          unit: "count",
          sourceRefs: input.sourceRefs
        })
        )
    )
  );
}

function shouldSkipCountFactMatch(text: string, match: RegExpMatchArray, kind: CountFactKind): boolean {
  const index = match.index || 0;
  const raw = match[0] || "";
  const window = text.slice(Math.max(0, index - 32), Math.min(text.length, index + raw.length + 32));
  if ((kind === "run_count" || kind === "repeat_count") && /\bseed[-\s]*\d+(?:\s+runs?)?\b/iu.test(window)) {
    return true;
  }
  if (kind !== "sample_count") {
    return false;
  }
  return /\brank[-\s]*\d+(?:\.\d+)?\s+rows?\b/iu.test(window);
}

function extractMetricFactsFromText(input: {
  text: string;
  source: NumericFactSource;
  location: string;
  context: ExperimentArtifactContext;
  previousText?: string;
  sourceRefs?: PaperSourceRef[];
}): NormalizedNumericFact[] {
  const cleaned = cleanString(input.text);
  if (!cleaned) {
    return [];
  }
  const fragments = cleaned
    .split(/(?<=[.!?])\s+/u)
    .map((fragment) => cleanString(fragment))
    .filter(Boolean);
  const facts: NormalizedNumericFact[] = [];
  for (const fragment of fragments) {
    if (isObjectiveThresholdFragment(fragment)) {
      continue;
    }
    const assignedFacts = extractAssignedMetricFacts({
      fragment,
      source: input.source,
      location: input.location,
      context: input.context,
      sourceRefs: input.sourceRefs
    });
    if (assignedFacts.length > 0) {
      facts.push(...assignedFacts);
      continue;
    }
    const numberMatches = collectNumericLiteralMatches(fragment);
    for (const match of numberMatches) {
      const rawValue = match.raw;
      const value = Number(rawValue.replace(/,/g, ""));
      if (!Number.isFinite(value)) {
        continue;
      }
      const descriptor = inferCanonicalTextFactDescriptor({
        fragment,
        rawIndex: match.index,
        context: input.context
      });
      if (!descriptor) {
        continue;
      }
      facts.push(
        buildStructuredNumericFact({
          factKind: "metric",
          source: input.source,
          location: input.location,
          rawText: fragment,
          value,
          metricKey: descriptor.metric.id,
          metricLabel: descriptor.metric.label,
          comparisonTarget: descriptor.comparisonTarget,
          datasetScope: descriptor.datasetScope,
          aggregationLevel: descriptor.aggregationLevel,
          unit: descriptor.unit,
          sourceRefs: input.sourceRefs
        })
      );
    }
  }
  return dedupeNumericFacts(facts);
}

interface CanonicalTextFactDescriptor {
  metric: ResultsMetricDefinitionV2;
  comparisonTarget: string;
  datasetScope: string;
  aggregationLevel: NumericFactAggregation;
  unit: NumericFactUnit;
}

function inferCanonicalTextFactDescriptor(input: {
  fragment: string;
  rawIndex: number;
  context: ExperimentArtifactContext;
}): CanonicalTextFactDescriptor | undefined {
  const metric = findCanonicalMetricMention(input.fragment, input.rawIndex, input.context);
  if (!metric) {
    return undefined;
  }
  const primaryComparison = input.context.results.primary_comparison;
  const primaryMetric = primaryComparison?.metric_id === metric.id ? primaryComparison : undefined;
  const differenceValue = Boolean(
    primaryMetric && isExplicitCanonicalDifferenceValue(input.fragment, input.rawIndex)
  );
  if (differenceValue && primaryMetric) {
    return {
      metric,
      comparisonTarget: "subject_minus_reference",
      datasetScope: formatCanonicalScope(primaryMetric.subject.scope),
      aggregationLevel: Object.keys(primaryMetric.subject.scope).length > 0 ? "dataset" : "aggregate",
      unit: "delta"
    };
  }

  const linkedObservation = findCanonicalObservationMentionNearNumber(
    input.fragment,
    input.rawIndex,
    input.context,
    metric.id
  );
  if (!linkedObservation) {
    return undefined;
  }
  return {
    metric,
    comparisonTarget: input.context.results.primary_comparison?.subject.observation_id === linkedObservation.observation_id
      ? "subject"
      : "reference",
    datasetScope: formatCanonicalScope(linkedObservation.scope),
    aggregationLevel: Object.keys(linkedObservation.scope).length > 0 ? "dataset" : "aggregate",
    unit: canonicalNumericFactUnit(metric.unit)
  };
}

function findCanonicalMetricMention(
  text: string,
  rawIndex: number,
  context: ExperimentArtifactContext
): ResultsMetricDefinitionV2 | undefined {
  const cleaned = normalizeCanonicalLookupText(text);
  const normalizedNumberIndex = normalizeCanonicalLookupText(text.slice(0, rawIndex)).length;
  const ranked = (context.results.canonical_artifact?.metrics || []).flatMap((metric) => {
    const phrases = uniqueStrings([
      normalizeCanonicalLookupText(metric.id),
      normalizeCanonicalLookupText(metric.label)
    ]).filter((phrase) => includesCanonicalPhrase(cleaned, phrase));
    const distance = nearestPrecedingCanonicalPhraseDistance(cleaned, normalizedNumberIndex, phrases);
    return typeof distance === "number" ? [{ metric, distance }] : [];
  });
  ranked.sort((left, right) => left.distance - right.distance);
  if (!ranked[0] || ranked[0].distance > 192 || (ranked[1] && ranked[0].distance === ranked[1].distance)) {
    return undefined;
  }
  return ranked[0].metric;
}

function normalizeCanonicalLookupText(value: string): string {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function includesCanonicalPhrase(text: string, phrase: string): boolean {
  return Boolean(phrase && ` ${text} `.includes(` ${phrase} `));
}

function isExplicitCanonicalDifferenceValue(text: string, rawIndex: number): boolean {
  const before = normalizeCanonicalLookupText(text.slice(Math.max(0, rawIndex - 72), rawIndex));
  const after = normalizeCanonicalLookupText(text.slice(rawIndex, Math.min(text.length, rawIndex + 32)));
  return /(?:subject minus reference )?(?:difference|delta|change|gain)\s*(?:of|is|was|equals|at)?$/iu.test(before)
    || /(?:improved|increased|decreased|changed|differed)\s+by$/iu.test(before)
    || /^(?:points?\s+)?(?:subject minus reference )?(?:difference|delta|change|gain)\b/iu.test(after);
}

function findCanonicalObservationMentionNearNumber(
  text: string,
  rawIndex: number,
  context: ExperimentArtifactContext,
  metricId: string
): PrimaryComparisonSummary["subject"] | PrimaryComparisonSummary["reference"] | undefined {
  const primaryComparison = context.results.primary_comparison;
  if (!primaryComparison) {
    return undefined;
  }
  const candidates = [primaryComparison.subject, primaryComparison.reference].filter(
    (observation) => observation.metric_id === metricId
  );
  const searchText = normalizeCanonicalLookupText(text);
  const normalizedNumberIndex = normalizeCanonicalLookupText(text.slice(0, rawIndex)).length;
  const ranked = candidates.flatMap((observation) => {
    const side = primaryComparison.subject.observation_id === observation.observation_id
      ? "subject"
      : "reference";
    const phrases = uniqueStrings([
      normalizeCanonicalLookupText(observation.series_label),
      normalizeCanonicalLookupText(observation.series_role),
      side
    ]).filter(Boolean);
    const distance = nearestPrecedingCanonicalPhraseDistance(searchText, normalizedNumberIndex, phrases);
    return typeof distance === "number" ? [{ observation, distance }] : [];
  });
  ranked.sort((left, right) => left.distance - right.distance);
  if (!ranked[0] || ranked[0].distance > 96 || (ranked[1] && ranked[0].distance === ranked[1].distance)) {
    return undefined;
  }
  return ranked[0].observation;
}

function inferVisualMetricDescriptor(input: {
  row: PaperManuscriptVisualRow;
  context: ExperimentArtifactContext;
}): {
  metricKey?: string;
  metricLabel?: string;
  comparisonTarget?: string;
  datasetScope?: string;
  unit?: NumericFactUnit;
  aggregationLevel?: NumericFactAggregation;
} {
  const primaryComparison = input.context.results.primary_comparison;
  if (
    primaryComparison
    && input.row.comparison_id === primaryComparison.comparison_id
    && input.row.comparison_side === "difference"
    && input.row.metric_id === primaryComparison.metric_id
  ) {
    return {
      metricKey: primaryComparison.metric_id,
      metricLabel: `${primaryComparison.metric_label} subject-minus-reference difference`,
      comparisonTarget: "subject_minus_reference",
      datasetScope: formatCanonicalScope(primaryComparison.subject.scope),
      unit: "delta",
      aggregationLevel: Object.keys(primaryComparison.subject.scope).length > 0 ? "dataset" : "aggregate"
    };
  }

  const observation = findCanonicalObservationForVisualRow(input.context, input.row);
  if (observation) {
    return {
      metricKey: observation.metric_id,
      metricLabel: observation.metric_label,
      comparisonTarget: primaryComparison?.subject.observation_id === observation.observation_id
        ? "subject"
        : "reference",
      unit: canonicalNumericFactUnit(observation.metric_unit),
      datasetScope: formatCanonicalScope(observation.scope),
      aggregationLevel: Object.keys(observation.scope).length > 0 ? "dataset" : "aggregate"
    };
  }
  return {};
}

function findCanonicalObservationForVisualRow(
  context: ExperimentArtifactContext,
  row: PaperManuscriptVisualRow
): PrimaryComparisonSummary["subject"] | PrimaryComparisonSummary["reference"] | undefined {
  const primaryComparison = context.results.primary_comparison;
  if (!primaryComparison) {
    return undefined;
  }
  const linkedObservations = [primaryComparison.subject, primaryComparison.reference];
  if (row.observation_id) {
    return linkedObservations.find(
      (observation) => observation.observation_id === row.observation_id
    );
  }
  if (row.comparison_id === primaryComparison.comparison_id && row.comparison_side === "subject") {
    return primaryComparison.subject;
  }
  if (row.comparison_id === primaryComparison.comparison_id && row.comparison_side === "reference") {
    return primaryComparison.reference;
  }
  if (!row.series_id || !row.metric_id) {
    return undefined;
  }
  const matches = linkedObservations.filter((observation) =>
    observation.series_id === row.series_id
    && observation.metric_id === row.metric_id
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function extractMetricFactsFromVisual(input: {
  source: Extract<NumericFactSource, "table" | "figure" | "appendix_table" | "appendix_figure">;
  location: string;
  caption: string;
  rows: PaperManuscriptVisualRow[];
  context: ExperimentArtifactContext;
  sourceRefs?: PaperSourceRef[];
}): NormalizedNumericFact[] {
  return dedupeNumericFacts(
    input.rows.flatMap((row) => {
      const descriptor = inferVisualMetricDescriptor({
        row,
        context: input.context
      });
      if (
        !descriptor.metricKey
        || !descriptor.datasetScope
        || !descriptor.aggregationLevel
        || !descriptor.unit
        || !Number.isFinite(row.value)
      ) {
        return [];
      }
      return [
        buildStructuredNumericFact({
          factKind: "metric",
          source: input.source,
          location: input.location,
          rawText: `${row.label}: ${formatNumber(row.value)} (${cleanString(input.caption)})`,
          value: row.value,
          metricKey: descriptor.metricKey,
          metricLabel: descriptor.metricLabel || row.label,
          comparisonTarget: descriptor.comparisonTarget,
          datasetScope: descriptor.datasetScope,
          aggregationLevel: descriptor.aggregationLevel,
          unit: descriptor.unit,
          sourceRefs: input.sourceRefs
        })
      ];
    })
  );
}

function shouldSkipVisualAccountingRow(row: { label: string; value: number }, caption: string): boolean {
  const label = normalizeMetricText(row.label);
  const text = normalizeMetricText(`${caption} ${row.label}`);
  if (!label) {
    return false;
  }
  if (/\b(?:threshold|target|minimum|maximum|budget)\b/iu.test(label)) {
    return true;
  }
  const accountingPattern =
    /\b(?:correct|incorrect|total|predictions?|samples?|sample size|count|counts?|records?|trials?|runs?|seeds?|levels?|cells?|profiles?|coverage|present|requested|completed)\b/iu;
  if (accountingPattern.test(label)) {
    return true;
  }
  if (
    Number.isFinite(row.value)
    && Math.abs(row.value) > 1
    && /\b(?:accuracy|delta|gain|baseline)\b/iu.test(text)
    && /\b(?:count|total|sample|prediction|trial|record|seed|profile|cell|level|coverage)\b/iu.test(label)
  ) {
    return true;
  }
  return false;
}

function buildStructuredNumericFact(input: {
  factKind: NumericFactKind;
  source: NumericFactSource;
  location: string;
  rawText: string;
  value: number;
  metricKey?: string;
  metricLabel?: string;
  comparisonTarget?: string;
  countKind?: CountFactKind;
  datasetScope?: string | "aggregate" | "unknown";
  aggregationLevel?: NumericFactAggregation;
  unit?: NumericFactUnit;
  sourceRefs?: PaperSourceRef[];
}): NormalizedNumericFact {
  const rawText = cleanString(input.rawText);
  const normalizedValue = roundMetric(normalizeObservedMetricValue(input.value, input.unit, rawText));
  const metricKey = cleanString(input.metricKey) || undefined;
  const comparisonTarget = input.comparisonTarget;
  const location = cleanString(input.location);
  return {
    fact_id: [
      input.source,
      location || "location",
      input.factKind,
      metricKey || input.countKind || "value",
      cleanString(`${input.datasetScope || "scope"}:${input.aggregationLevel || "agg"}:${normalizedValue}`)
    ]
      .join("|")
      .toLowerCase(),
    fact_kind: input.factKind,
    source: input.source,
    location,
    raw_text: rawText,
    value: input.value,
    normalized_value: normalizedValue,
    ...(metricKey ? { metric_key: metricKey } : {}),
    ...(input.metricLabel ? { metric_label: cleanString(input.metricLabel) } : {}),
    ...(comparisonTarget ? { comparison_target: comparisonTarget } : {}),
    ...(input.countKind ? { count_kind: input.countKind } : {}),
    ...(input.datasetScope ? { dataset_scope: input.datasetScope } : {}),
    ...(input.aggregationLevel ? { aggregation_level: input.aggregationLevel } : {}),
    ...(input.unit ? { unit: input.unit } : {}),
    ...(input.sourceRefs?.length ? { source_refs: input.sourceRefs } : {})
  };
}

function buildComparableFactKey(fact: NormalizedNumericFact): string | undefined {
  if (fact.fact_kind === "count") {
    return fact.count_kind ? `count|${fact.count_kind}` : undefined;
  }
  const metricKey = comparableMetricIdentity(fact);
  if (!metricKey) {
    return undefined;
  }
  return [
    "metric",
    metricKey,
    fact.comparison_target || "comparison_unknown",
    fact.dataset_scope || "unknown",
    fact.aggregation_level || "unknown",
    fact.unit || "score"
  ].join("|");
}

function humanizeComparableFactKey(fact: NormalizedNumericFact | undefined): string {
  if (!fact) {
    return "numeric facts";
  }
  if (fact.fact_kind === "count") {
    return humanizeCountKind(fact.count_kind);
  }
  const scope =
    fact.dataset_scope && fact.dataset_scope !== "aggregate" && fact.dataset_scope !== "unknown"
      ? `${fact.dataset_scope} `
      : fact.dataset_scope === "aggregate"
        ? "aggregate "
        : "";
  return `${scope}${humanizeToken(fact.metric_key || "metric")}`.trim();
}

function humanizeCountKind(kind: CountFactKind | undefined): string {
  switch (kind) {
    case "dataset_count":
      return "datasets";
    case "repeat_count":
      return "repeats";
    case "outer_fold_count":
      return "outer folds";
    case "inner_fold_count":
      return "inner folds";
    case "run_count":
      return "runs";
    case "sample_count":
      return "samples";
    default:
      return "counts";
  }
}

function areComparableNumericFacts(left: NormalizedNumericFact, right: NormalizedNumericFact): boolean {
  if (left.fact_kind !== right.fact_kind) {
    return false;
  }
  if (left.fact_kind === "count") {
    return Boolean(left.count_kind && left.count_kind === right.count_kind);
  }
  const leftMetricKey = comparableMetricIdentity(left);
  const rightMetricKey = comparableMetricIdentity(right);
  if (!leftMetricKey || !rightMetricKey || leftMetricKey !== rightMetricKey) {
    return false;
  }
  if ((left.unit || "score") !== (right.unit || "score")) {
    return false;
  }
  if ((left.aggregation_level || "unknown") !== (right.aggregation_level || "unknown")) {
    return false;
  }
  if ((left.dataset_scope || "unknown") !== (right.dataset_scope || "unknown")) {
    return false;
  }
  if (left.comparison_target !== right.comparison_target) {
    return false;
  }
  return true;
}

function comparableMetricIdentity(fact: NormalizedNumericFact): string | undefined {
  if (fact.fact_kind !== "metric") {
    return undefined;
  }
  return fact.metric_key;
}

function areFactValuesEquivalent(left: NormalizedNumericFact, right: NormalizedNumericFact): boolean {
  const unit = left.unit || right.unit;
  return areApproxEqual(left.normalized_value, right.normalized_value, unit);
}

function areApproxEqual(left: number, right: number, unit: NumericFactUnit | undefined): boolean {
  const tolerance =
    unit === "seconds"
      ? Math.max(0.05, Math.max(Math.abs(left), Math.abs(right)) * 0.01)
      : unit === "mb"
        ? Math.max(0.5, Math.max(Math.abs(left), Math.abs(right)) * 0.01)
        : unit === "count"
          ? 0
          : Math.max(0.0005, Math.max(Math.abs(left), Math.abs(right)) * 0.001);
  return Math.abs(left - right) <= tolerance;
}

function normalizeObservedMetricValue(value: number, unit: NumericFactUnit | undefined, rawText: string): number {
  if (unit === "mb" && /\bbytes?\b/iu.test(normalizeMetricText(rawText)) && Math.abs(value) > 1_000_000) {
    return value / 1_000_000;
  }
  if (unit === "mb" && /\b(?:gb|gib)\b/iu.test(rawText) && !/\b(?:mb|mib)\b/iu.test(rawText)) {
    return value * 1000;
  }
  return value;
}

function dedupeNumericFacts(facts: NormalizedNumericFact[]): NormalizedNumericFact[] {
  const seen = new Set<string>();
  const unique: NormalizedNumericFact[] = [];
  for (const fact of facts) {
    const key = `${fact.fact_id}|${fact.normalized_value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(fact);
  }
  return unique;
}

function dedupeConsistencyIssues(issues: ConsistencyLintIssue[]): ConsistencyLintIssue[] {
  const seen = new Set<string>();
  const unique: ConsistencyLintIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.kind}|${issue.severity}|${issue.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}

function nearestPrecedingCanonicalPhraseDistance(
  text: string,
  normalizedNumberIndex: number,
  phrases: string[]
): number | undefined {
  let best: number | undefined;
  for (const phrase of phrases) {
    const pattern = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    for (const match of text.matchAll(pattern)) {
      const phraseEnd = (match.index || 0) + match[0].length;
      if (phraseEnd > normalizedNumberIndex) {
        continue;
      }
      const distance = normalizedNumberIndex - phraseEnd;
      if (best === undefined || distance < best) {
        best = distance;
      }
    }
  }
  return best;
}

function normalizeMetricText(value: string): string {
  return cleanString(value)
    .toLowerCase()
    .replace(/[_./-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractAssignedMetricFacts(input: {
  fragment: string;
  source: NumericFactSource;
  location: string;
  context: ExperimentArtifactContext;
  sourceRefs?: PaperSourceRef[];
}): NormalizedNumericFact[] {
  const facts: NormalizedNumericFact[] = [];
  for (const segment of input.fragment.split(/[;,]/u)) {
    const [rawMetricToken, rawAssignedValue] = segment.split("=");
    if (!rawMetricToken || !rawAssignedValue) {
      continue;
    }
    const metricToken = cleanString(rawMetricToken.split(":").at(-1));
    const rawValue = cleanString(rawAssignedValue);
    const value = Number(rawValue);
    if (!metricToken || !Number.isFinite(value)) {
      continue;
    }
    const descriptor = inferCanonicalTextFactDescriptor({
      fragment: segment,
      rawIndex: segment.indexOf(rawAssignedValue),
      context: input.context
    });
    if (!descriptor) {
      continue;
    }
    facts.push(
      buildStructuredNumericFact({
        factKind: "metric",
        source: input.source,
        location: input.location,
        rawText: `${metricToken}=${rawValue}`,
        value,
        metricKey: descriptor.metric.id,
        metricLabel: descriptor.metric.label,
        comparisonTarget: descriptor.comparisonTarget,
        datasetScope: descriptor.datasetScope,
        aggregationLevel: descriptor.aggregationLevel,
        unit: descriptor.unit,
        sourceRefs: input.sourceRefs
      })
    );
  }
  return dedupeNumericFacts(facts);
}

function isObjectiveThresholdFragment(fragment: string): boolean {
  const normalized = normalizeMetricText(fragment);
  return (
    (
      /(?:>=|<=|>|<)/u.test(fragment)
      || /\b(?:below|under|less than|at least|at most|exceed(?:s|ed)?|clear(?:s|ed)?|stayed below|remained below)\b/iu.test(normalized)
    )
    && /\bobjective\b|\bconstraint\b|\btarget\b|\bthreshold\b|\bno[-\s]?signal\b|\bboundary\b|\brule\b|\baround\b|\bposition(?:s|ed|ing)?\b|\bscope(?:d)?\b/iu.test(normalized)
  );
}

function isObjectiveThresholdFact(fact: NormalizedNumericFact): boolean {
  return fact.fact_kind === "metric" && isObjectiveThresholdFragment(fact.raw_text);
}

function shouldWarnOnUnverifiableFact(source: NumericFactSource): boolean {
  return source !== "artifact" && source !== "related_work";
}

function allowsAppendixOnlyWarning(source: NumericFactSource): boolean {
  return source === "abstract" || source === "conclusion";
}

function isAppendixFactSource(source: NumericFactSource): boolean {
  return source === "appendix_section" || source === "appendix_table" || source === "appendix_figure";
}

function extractNumericNoteCount(notes: string[]): number | undefined {
  for (const note of notes) {
    const first = collectNumbersFromMatches(
      note,
      /\b(\d+)(?:[-\s]?fold|\s+repeated|\s+repeats?|\s+seeds?|\s+samples?|\s+instances?|\s+rows?)\b/giu
    )[0];
    if (typeof first === "number") {
      return first;
    }
  }
  return undefined;
}

function extractExpectedCountFromNotes(notes: string[], kind: CountFactKind): number | undefined {
  const patterns: Record<CountFactKind, RegExp[]> = {
    dataset_count: [/\b(\d+)\s+datasets?\b/giu],
    repeat_count: [/\b(\d+)\s+(?:repeats?|repeated evaluations?|seeds?(?!\s+resamples?\b))\b/giu],
    run_count: [/\b(\d+)\s+runs?\b/giu],
    outer_fold_count: [/\bouter\s+(\d+)[-\s]?fold\b/giu, /\b(\d+)[-\s]?fold outer\b/giu],
    inner_fold_count: [/\binner\s+(\d+)[-\s]?fold\b/giu, /\b(\d+)[-\s]?fold inner\b/giu],
    sample_count: [/\b(\d+)\s+(?:samples?|instances?|rows)\b/giu]
  };
  for (const note of notes) {
    for (const pattern of patterns[kind]) {
      const first = collectNumbersFromMatches(note, pattern)[0];
      if (typeof first === "number") {
        return first;
      }
    }
  }
  return undefined;
}

function collectNumericLiteralMatches(text: string): Array<{ raw: string; index: number }> {
  const cleaned = cleanString(text);
  const matches: Array<{ raw: string; index: number }> = [];
  // Match comma-separated thousands groups (e.g. "20,789") as well as plain numbers.
  const pattern = /-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/gu;
  let match = pattern.exec(cleaned);
  while (match) {
    const raw = match[0] || "";
    const index = match.index || 0;
    const before = cleaned[index - 1] || "";
    if (!/[A-Za-z0-9]/u.test(before) && !/[A-Za-z]/u.test(before)) {
      matches.push({ raw, index });
    }
    match = pattern.exec(cleaned);
  }
  return matches;
}

function collectNumbersFromMatches(text: string, pattern: RegExp): number[] {
  return [...cleanString(text).matchAll(pattern)]
    .map((match) => parseNumericLiteral(match[1]))
    .filter((value) => Number.isFinite(value));
}

function parseNumericLiteral(value: string | undefined): number {
  return Number(cleanString(value || "").replace(/,/gu, ""));
}

export function applyScientificWritingPolicy(input: {
  draft: PaperDraft;
  bundle: PaperWritingBundle;
  profile: PaperProfileConfig;
  objectiveEvaluation?: ObjectiveMetricEvaluation;
  objectiveMetricProfile?: ObjectiveMetricProfile;
}): ScientificDraftResult {
  const profile = resolvePaperProfile(input.profile);
  const context = experimentArtifactLoader({
    bundle: input.bundle,
    objectiveEvaluation: input.objectiveEvaluation,
    objectiveMetricProfile: input.objectiveMetricProfile
  });
  const methodReport = methodCompletenessValidator(context);
  const resultsReport = resultsRichnessValidator(context);
  const relatedWorkReport = relatedWorkRichnessValidator(context);
  const discussionReport = discussionRichnessValidator(context);
  let upgradedDraft = ensureDraftSections(input.draft, input.bundle, context);
  upgradedDraft = ensureMinimumSectionRichness(upgradedDraft, input.bundle, context);
  const rewritten = claimStrengthRewriter({ draft: upgradedDraft, context });
  upgradedDraft = rewritten.draft;
  let expandedSections: string[] = [];
  const pageBudgetBeforeExpansion = pageBudgetManager({
    draft: upgradedDraft,
    profile
  });
  let pageBudget = pageBudgetBeforeExpansion;
  let expansionRecheck: ScientificAutoRepairRecheck = {
    attempted: false,
    page_budget_before: pageBudgetBeforeExpansion.status,
    page_budget_after: pageBudgetBeforeExpansion.status,
    resolved_headings: [],
    unresolved_headings: pageBudgetBeforeExpansion.auto_expand_headings
  };
  if (pageBudget.auto_expand_headings.length > 0) {
    let expansionPass = 1;
    let previousEstimatedWords = pageBudget.estimated_main_words;
    while (pageBudget.auto_expand_headings.length > 0 && expansionPass <= 5) {
      expandedSections = uniqueStrings([...expandedSections, ...pageBudget.auto_expand_headings]);
      upgradedDraft = expandDraftAgainstBudget(
        upgradedDraft,
        input.bundle,
        context,
        pageBudget.auto_expand_headings,
        expansionPass
      );
      pageBudget = pageBudgetManager({
        draft: upgradedDraft,
        profile
      });
      if (pageBudget.status === "ok") {
        break;
      }
      if (pageBudget.estimated_main_words <= previousEstimatedWords) {
        break;
      }
      previousEstimatedWords = pageBudget.estimated_main_words;
      expansionPass += 1;
    }
    expansionRecheck = {
      attempted: true,
      page_budget_before: pageBudgetBeforeExpansion.status,
      page_budget_after: pageBudget.status,
      resolved_headings: expandedSections.filter(
        (heading) => !pageBudget.auto_expand_headings.some((candidate) => normalizeHeading(candidate) === normalizeHeading(heading))
      ),
      unresolved_headings: pageBudget.auto_expand_headings
    };
  }
  if (
    pageBudget.status !== "ok"
    && pageBudget.minimum_main_words <= 3900
    && pageBudget.estimated_main_words < pageBudget.minimum_main_words
    && methodReport.status === "complete"
    && resultsReport.status === "complete"
    && relatedWorkReport.status === "complete"
    && discussionReport.status === "complete"
  ) {
    upgradedDraft = padDraftToMinimumWordFloor(upgradedDraft, input.bundle, context, profile, pageBudget);
    pageBudget = pageBudgetManager({
      draft: upgradedDraft,
      profile
    });
    expandedSections = uniqueStrings([...expandedSections, ...pageBudgetBeforeExpansion.auto_expand_headings]);
    expansionRecheck = {
      attempted: true,
      page_budget_before: pageBudgetBeforeExpansion.status,
      page_budget_after: pageBudget.status,
      resolved_headings: expandedSections.filter(
        (heading) => !pageBudget.auto_expand_headings.some((candidate) => normalizeHeading(candidate) === normalizeHeading(heading))
      ),
      unresolved_headings: pageBudget.auto_expand_headings
    };
  }
  const evidenceDiagnostics = buildEvidenceInsufficiencyReport({
    pageBudget,
    methodReport,
    resultsReport,
    relatedWorkReport,
    discussionReport
  });
  const appendixPlan = appendixBuilder({
    context,
    profile
  });

  return {
    draft: upgradedDraft,
    page_budget: pageBudget,
    method_completeness: methodReport,
    results_richness: resultsReport,
    related_work_richness: relatedWorkReport,
    discussion_richness: discussionReport,
    evidence_diagnostics: evidenceDiagnostics,
    claim_rewrite_report: rewritten.report,
    appendix_plan: appendixPlan,
    auto_repairs: {
      expanded_sections: expandedSections,
      expansion_recheck: expansionRecheck
    }
  };
}

export function buildScientificValidationArtifact(input: ScientificDraftResult): ScientificValidationArtifact {
  const issues: ScientificValidationIssue[] = [];
  if (input.page_budget.status !== "ok") {
    issues.push({
      code: input.page_budget.status === "fail" ? "page_budget_shortfall" : "page_budget_warning",
      source: "scientific_validation",
      category: "page_budget",
      severity: "warning",
      policy: "strict_fail",
      finding: input.evidence_diagnostics.blocked_by_evidence_insufficiency ? "unverifiable" : "repairable",
      message:
        input.page_budget.warnings[0]
        || `Main-body length remains below the venue-aware ${input.page_budget.target_main_pages}-page target.`,
      details: input.page_budget.warnings.slice(1),
      thin_sections: input.evidence_diagnostics.thin_sections,
      missing_evidence_categories: input.evidence_diagnostics.missing_evidence_categories,
      expandable_from_existing_evidence: input.evidence_diagnostics.expandable_from_existing_evidence,
      blocked_by_evidence_insufficiency: input.evidence_diagnostics.blocked_by_evidence_insufficiency
    });
  }
  const sectionDiagnostics = new Map(
    input.evidence_diagnostics.section_diagnostics.map((diagnostic) => [normalizeHeading(diagnostic.section), diagnostic] as const)
  );
  pushCompletenessIssue(
    issues,
    "method_completeness",
    "method_completeness_incomplete",
    input.method_completeness,
    "Method remains incomplete for scientific reporting.",
    sectionDiagnostics.get("method")
  );
  pushCompletenessIssue(
    issues,
    "results_richness",
    "results_richness_incomplete",
    input.results_richness,
    "Results remain too thin for a full paper.",
    sectionDiagnostics.get("results")
  );
  pushCompletenessIssue(
    issues,
    "related_work_richness",
    "related_work_richness_incomplete",
    input.related_work_richness,
    "Related Work lacks enough clustering or positioning detail.",
    sectionDiagnostics.get("related work")
  );
  pushCompletenessIssue(
    issues,
    "discussion_richness",
    "discussion_richness_incomplete",
    input.discussion_richness,
    "Discussion or Limitations remain too thin.",
    sectionDiagnostics.get("discussion")
  );

  return {
    page_budget: input.page_budget,
    method_completeness: input.method_completeness,
    results_richness: input.results_richness,
    related_work_richness: input.related_work_richness,
    discussion_richness: input.discussion_richness,
    evidence_diagnostics: input.evidence_diagnostics,
    claim_rewrite_report: input.claim_rewrite_report,
    appendix_plan: input.appendix_plan,
    auto_repairs: {
      claim_rewrite_count: input.claim_rewrite_report.rewrites.length,
      expanded_sections: input.auto_repairs.expanded_sections,
      appendix_route_count: input.appendix_plan.cross_references.length,
      expansion_recheck: input.auto_repairs.expansion_recheck
    },
    issues
  };
}

export function refreshScientificValidationForManuscript(input: {
  validation: ScientificValidationArtifact;
  manuscript: PaperManuscript;
  profile: PaperProfileConfig;
}): ScientificValidationArtifact {
  const pageBudget = pageBudgetManager({
    draft: {
      sections: input.manuscript.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((text) => ({
          text,
          evidence_ids: [],
          citation_paper_ids: []
        })),
        evidence_ids: [],
        citation_paper_ids: []
      }))
    },
    profile: input.profile
  });
  const thinSections = pageBudget.sections
    .filter((section) => section.status !== "ok")
    .map((section) => section.heading);
  return buildScientificValidationArtifact({
    draft: {
      title: input.manuscript.title,
      abstract: input.manuscript.abstract,
      keywords: input.manuscript.keywords,
      sections: input.manuscript.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((text) => ({
          text,
          evidence_ids: [],
          citation_paper_ids: []
        })),
        evidence_ids: [],
        citation_paper_ids: []
      })),
      claims: []
    },
    page_budget: pageBudget,
    method_completeness: input.validation.method_completeness,
    results_richness: input.validation.results_richness,
    related_work_richness: input.validation.related_work_richness,
    discussion_richness: input.validation.discussion_richness,
    evidence_diagnostics: {
      ...input.validation.evidence_diagnostics,
      thin_sections: thinSections,
      section_diagnostics: input.validation.evidence_diagnostics.section_diagnostics.map((diagnostic) => {
        const sectionBudget = pageBudget.sections.find(
          (section) => normalizeHeading(section.heading) === normalizeHeading(diagnostic.section)
        );
        return sectionBudget
          ? {
              ...diagnostic,
              thin: sectionBudget.status !== "ok"
            }
          : diagnostic;
      })
    },
    claim_rewrite_report: input.validation.claim_rewrite_report,
    appendix_plan: input.validation.appendix_plan,
    auto_repairs: input.validation.auto_repairs
  });
}

export function buildWritePaperGateDecision(input: {
  mode: PaperValidationMode;
  scientificValidation: ScientificValidationArtifact;
  consistencyLint: ConsistencyLintReport;
  appendixLint: ConsistencyLintReport;
}): WritePaperGateDecision {
  const issues: WritePaperGateDecisionIssue[] = [
    ...input.scientificValidation.issues.map((issue) => {
      const blocking = issue.policy === "always_fail" || (issue.policy === "strict_fail" && input.mode === "strict_paper");
      const outcome: GateIssueOutcome = blocking ? "fail" : issue.finding === "unverifiable" ? "unverifiable" : "warn";
      return {
        ...issue,
        blocking,
        outcome
      };
    }),
    ...input.consistencyLint.issues.map((issue) => convertLintIssueToGateIssue(issue, "consistency_lint", input.mode)),
    ...input.appendixLint.issues.map((issue) => convertLintIssueToGateIssue(issue, "appendix_lint", input.mode))
  ];
  const blockingIssues = issues.filter((issue) => issue.blocking);
  const warningCount = issues.filter((issue) => !issue.blocking).length;
  const failureReasons = blockingIssues.map((issue) => issue.message);
  const classificationSummary = {
    contradiction_count: issues.filter((issue) => issue.finding === "contradiction").length,
    unverifiable_count: issues.filter((issue) => issue.finding === "unverifiable").length,
    repairable_count: issues.filter((issue) => issue.finding === "repairable").length,
    informational_count: issues.filter((issue) => issue.finding === "informational").length,
    auto_repair_count:
      input.scientificValidation.auto_repairs.claim_rewrite_count
      + input.scientificValidation.auto_repairs.expanded_sections.length
  };
  const evidenceSummary = {
    thin_sections: input.scientificValidation.evidence_diagnostics.thin_sections,
    missing_evidence_categories: input.scientificValidation.evidence_diagnostics.missing_evidence_categories,
    blocked_by_evidence_insufficiency: input.scientificValidation.evidence_diagnostics.blocked_by_evidence_insufficiency,
    expandable_from_existing_evidence: input.scientificValidation.evidence_diagnostics.expandable_from_existing_evidence
  };
  const summary = blockingIssues.length > 0
    ? [
        `write_paper quality gate failed in ${input.mode} mode.`,
        ...failureReasons,
        ...(evidenceSummary.blocked_by_evidence_insufficiency
          ? [
              `Evidence insufficiency blocks recovery for ${joinHumanList(evidenceSummary.thin_sections)} because ${joinHumanList(evidenceSummary.missing_evidence_categories)} remain missing.`
            ]
          : [])
      ]
    : issues.length > 0
      ? [
          `write_paper quality gate emitted ${issues.length} non-blocking validation issue(s) in ${input.mode} mode.`,
          ...issues.map((issue) => issue.message)
        ]
      : [`write_paper quality gate passed in ${input.mode} mode.`];

  return {
    mode: input.mode,
    status: blockingIssues.length > 0 ? "fail" : issues.length > 0 ? "warn" : "pass",
    issues,
    blocking_issue_count: blockingIssues.length,
    warning_count: warningCount,
    failure_reasons: failureReasons,
    classification_summary: classificationSummary,
    evidence_summary: evidenceSummary,
    summary
  };
}

export function materializeScientificManuscript(input: {
  candidate: PaperManuscript;
  draft: PaperDraft;
  bundle: PaperWritingBundle;
  profile: PaperProfileConfig;
  objectiveEvaluation?: ObjectiveMetricEvaluation;
  objectiveMetricProfile?: ObjectiveMetricProfile;
  appendixPlan: AppendixPlan;
  pageBudget: PageBudgetManagerReport;
}): ScientificManuscriptResult {
  const context = experimentArtifactLoader({
    bundle: input.bundle,
    objectiveEvaluation: input.objectiveEvaluation,
    objectiveMetricProfile: input.objectiveMetricProfile
  });
  const candidateSectionMap = new Map(
    input.candidate.sections.map((section) => [normalizeHeading(section.heading), section] as const)
  );

  const sections: PaperManuscriptSection[] = strengthenHumanFacingSections(input.draft.sections.map((section) => {
    const candidateSection = candidateSectionMap.get(normalizeHeading(section.heading));
    const candidateParagraphs = candidateSection?.paragraphs || [];
    const mergedParagraphs = candidateParagraphs.length >= section.paragraphs.length
      ? candidateParagraphs
      : [
          ...candidateParagraphs,
          ...section.paragraphs.slice(candidateParagraphs.length).map((paragraph) => paragraph.text)
        ];
    return {
      heading: section.heading,
      paragraphs: mergedParagraphs.map((paragraph) =>
        sanitizeHumanFacingManuscriptText(rewriteTextForClaimStrength(paragraph, context, []))
      ),
      source_refs: buildSectionSourceRefs(section, input.draft.claims)
    };
  }), context);

  const primaryTables = primaryComparisonTableBuilder(context);
  const derivedTables = primaryTables.length > 0 ? primaryTables : undefined;
  const authoredTables = filterExplicitAuthoredTables(
    sanitizeCandidateTables(input.candidate.tables)
  );
  const tables = makeMainTablesSelfContained(
    authoredTables
      || (context.results.primary_comparison_status === "resolved" ? derivedTables : undefined),
    context
  );
  const primaryFigures = primaryComparisonFigureBuilder(context);
  const derivedFigures = primaryFigures.length > 0 ? primaryFigures : undefined;
  const authoredFigures = filterExplicitAuthoredFigures(
    sanitizeCandidateFigures(input.candidate.figures)
  );
  const selectedFigures = authoredFigures
    || sanitizeCandidateFigures(dropRedundantFiguresAgainstTables(
      tables,
      context.results.primary_comparison_status === "resolved" ? derivedFigures : undefined
    ));
  const generatedAppendixSections = input.appendixPlan.sections.map((section) => ({
    ...section,
    source_refs: buildArtifactSourceRefs([`appendix:${section.heading}`, "latest_results", "result_analysis"])
  }));
  const generatedAppendixTables = input.appendixPlan.tables.map((table) => ({
    ...table,
    caption: sanitizeVisualCaption(
      table.caption,
      "Extended declared primary comparison retained outside the main paper."
    ),
    source_refs: mergeSourceRefs(table.source_refs, buildArtifactSourceRefs(["appendix:primary_comparison"]) || [])
  }));
  const generatedAppendixFigures = input.appendixPlan.figures.map((figure) => ({
    ...figure,
    caption: sanitizeVisualCaption(
      figure.caption,
      "Extended dataset-level outcomes retained outside the main paper."
    ),
    source_refs: buildArtifactSourceRefs(["appendix:figures", "result_analysis.figure_specs"])
  }));
  const candidateAppendixSections = attachFallbackSourceRefsToSections(
    input.candidate.appendix_sections,
    ["appendix:authored_supporting_material", "latest_results", "result_analysis"]
  );
  const candidateAppendixTables = attachFallbackSourceRefsToTables(
    sanitizeCandidateTables(input.candidate.appendix_tables),
    ["appendix:authored_supporting_material", "latest_results.dataset_summaries"]
  );
  const candidateAppendixFigures = attachFallbackSourceRefsToFigures(
    sanitizeCandidateFigures(input.candidate.appendix_figures),
    ["appendix:authored_supporting_material", "result_analysis.figure_specs"]
  );
  const sanitizedCandidateAppendixSections = sanitizeReaderFacingAppendixSections(candidateAppendixSections);
  const sanitizedGeneratedAppendixSections = sanitizeReaderFacingAppendixSections(generatedAppendixSections);
  const appendixSections = sanitizedCandidateAppendixSections?.length
    ? sanitizedCandidateAppendixSections
    : sanitizedGeneratedAppendixSections;
  const appendixTables = dedupeReaderFacingTables(candidateAppendixTables?.length ? candidateAppendixTables : generatedAppendixTables);
  const appendixFigures = candidateAppendixFigures?.length ? candidateAppendixFigures : generatedAppendixFigures;

  let manuscript: PaperManuscript = {
    ...input.candidate,
    abstract: sanitizeHumanFacingManuscriptText(rewriteTextForClaimStrength(input.candidate.abstract, context, [])),
    sections,
    ...(tables ? { tables } : {}),
    ...(selectedFigures ? { figures: selectedFigures } : {}),
    ...(appendixSections?.length ? { appendix_sections: appendixSections } : {}),
    appendix_tables: appendixTables,
    appendix_figures: appendixFigures
  };
  manuscript = compactReaderFacingScientificManuscript(manuscript);
  attachAppendixCrossReferences(manuscript, input.appendixPlan);

  const consistency = manuscriptConsistencyLinter({
    manuscript,
    context
  });
  const appendixLint = appendixConsistencyLinter({
    manuscript,
    appendixPlan: input.appendixPlan,
    pageBudget: input.pageBudget
  });
  const provenanceMap = buildManuscriptProvenanceMap({
    manuscript,
    draft: input.draft,
    context,
    expectedMetricFacts: collectExpectedMetricFacts(context)
  });

  return {
    manuscript,
    consistency_lint: consistency,
    appendix_lint: appendixLint,
    provenance_map: provenanceMap
  };
}

export function enforceManuscriptPageBudgetFloor(input: {
  manuscript: PaperManuscript;
  draft: PaperDraft;
  pageBudget: PageBudgetManagerReport;
}): ManuscriptPageBudgetFloorReport {
  const configuredMinimumMainWords = Math.max(1, Math.round(input.pageBudget.minimum_main_words || 0));
  const estimatedWordsPerPage = Math.max(1, Math.round(input.pageBudget.estimated_words_per_page || 650));
  const renderSafetyBufferWords = Math.round(estimatedWordsPerPage * 0.75);
  const maximumMainWords = Math.max(
    configuredMinimumMainWords,
    Math.round(input.pageBudget.maximum_main_words || configuredMinimumMainWords + renderSafetyBufferWords)
  );
  const minimumMainWords = Math.min(maximumMainWords, configuredMinimumMainWords + renderSafetyBufferWords);
  const estimatedBefore = estimateManuscriptMainWords(input.manuscript);
  const manuscriptSectionWords = new Map(
    input.manuscript.sections.map((section) => [
      normalizeHeading(section.heading),
      wordCount(section.paragraphs.join(" "))
    ] as const)
  );
  const hasSectionShortfall = (input.pageBudget.sections || []).some((section) => {
    const minimumWords = Math.max(0, Math.round(section.minimum_words || 0));
    return minimumWords > 0 && (manuscriptSectionWords.get(normalizeHeading(section.heading)) || 0) < minimumWords;
  });
  if (estimatedBefore >= minimumMainWords && !hasSectionShortfall) {
    return {
      manuscript: input.manuscript,
      applied: false,
      minimum_main_words: configuredMinimumMainWords,
      estimated_main_words_before: estimatedBefore,
      estimated_main_words_after: estimatedBefore,
      added_paragraph_count: 0,
      added_sections: []
    };
  }

  const sections = input.manuscript.sections.map((section) => ({
    ...section,
    paragraphs: [...section.paragraphs],
    ...(section.source_refs?.length ? { source_refs: [...section.source_refs] } : {})
  }));
  const sectionByHeading = new Map(sections.map((section) => [normalizeHeading(section.heading), section] as const));
  let estimatedWords = estimatedBefore;
  let addedParagraphCount = 0;
  const addedSections: string[] = [];
  const sectionWordCount = (section: { paragraphs: string[] } | undefined): number =>
    wordCount((section?.paragraphs || []).join(" "));
  const appendParagraphToSection = (
    heading: string,
    text: string,
    refs?: PaperSourceRef[]
  ): boolean => {
    const cleaned = sanitizeHumanFacingManuscriptText(text);
    if (!cleaned) {
      return false;
    }
    const normalizedHeading = normalizeHeading(heading);
    let section = sectionByHeading.get(normalizedHeading);
    if (!section) {
      section = {
        heading,
        paragraphs: []
      };
      sectionByHeading.set(normalizedHeading, section);
      sections.push(section);
    }
    const existingFingerprints = new Set(section.paragraphs.map((paragraph) => paragraphFingerprint(paragraph)));
    const fingerprint = paragraphFingerprint(cleaned);
    if (existingFingerprints.has(fingerprint)) {
      return false;
    }
    if (isPageBudgetRestorationDuplicate(heading, section.paragraphs, cleaned)) {
      return false;
    }
    section.paragraphs.push(cleaned);
    if (refs?.length) {
      section.source_refs = mergeSourceRefs(section.source_refs, refs);
    }
    estimatedWords += wordCount(cleaned);
    addedParagraphCount += 1;
    addedSections.push(section.heading);
    return true;
  };



  for (const budgetSection of input.pageBudget.sections || []) {
    const normalizedHeading = normalizeHeading(budgetSection.heading);
    let section = sectionByHeading.get(normalizedHeading);
    const minimumWords = Math.max(0, Math.round(budgetSection.minimum_words || 0));
    if (minimumWords <= 0 || sectionWordCount(section) >= minimumWords) {
      continue;
    }
    const draftSection = input.draft.sections.find((item) => normalizeHeading(item.heading) === normalizedHeading);
    for (const paragraph of draftSection?.paragraphs || []) {
      if (sectionWordCount(sectionByHeading.get(normalizedHeading)) >= minimumWords) {
        break;
      }
      appendParagraphToSection(
        draftSection?.heading || budgetSection.heading,
        paragraph.text,
        [
          ...paragraph.evidence_ids.map((id) => ({ kind: "evidence" as const, id })),
          ...paragraph.citation_paper_ids.map((id) => ({ kind: "citation" as const, id }))
        ]
      );
    }
  }

  for (const draftSection of input.draft.sections) {
    if (estimatedWords >= minimumMainWords) {
      break;
    }
    const normalizedHeading = normalizeHeading(draftSection.heading);
    let section = sectionByHeading.get(normalizedHeading);
    if (!section) {
      section = {
        heading: draftSection.heading,
        paragraphs: [],
        source_refs: buildSectionSourceRefs(draftSection, input.draft.claims)
      };
      sectionByHeading.set(normalizedHeading, section);
      sections.push(section);
    }
    const existingFingerprints = new Set(section.paragraphs.map((paragraph) => paragraphFingerprint(paragraph)));
    for (const paragraph of draftSection.paragraphs) {
      if (estimatedWords >= minimumMainWords) {
        break;
      }
      const text = sanitizeHumanFacingManuscriptText(paragraph.text);
      if (!text) {
        continue;
      }
      const fingerprint = paragraphFingerprint(text);
      if (existingFingerprints.has(fingerprint)) {
        continue;
      }
      if (isPageBudgetRestorationDuplicate(draftSection.heading, section.paragraphs, text)) {
        continue;
      }
      section.paragraphs.push(text);
      existingFingerprints.add(fingerprint);
      section.source_refs = mergeSourceRefs(section.source_refs, [
        ...paragraph.evidence_ids.map((id) => ({ kind: "evidence" as const, id })),
        ...paragraph.citation_paper_ids.map((id) => ({ kind: "citation" as const, id }))
      ]);
      estimatedWords += wordCount(text);
      addedParagraphCount += 1;
      addedSections.push(section.heading);
    }
  }
  const manuscript = {
    ...input.manuscript,
    sections: sortManuscriptSections(sections)
  };
  return {
    manuscript,
    applied: addedParagraphCount > 0,
    minimum_main_words: configuredMinimumMainWords,
    estimated_main_words_before: estimatedBefore,
    estimated_main_words_after: estimateManuscriptMainWords(manuscript),
    added_paragraph_count: addedParagraphCount,
    added_sections: uniqueStrings(addedSections)
  };
}

function isHumanFacingProtocolChecklistResidue(text: string): boolean {
  return (
    /^(?:The\s+)?evaluation spans\s+Training:/iu.test(text)
    || /^(?:The\s+)?Preprocessing follows this order:/iu.test(text)
    || /^Evidence accounting:/iu.test(text)
    || /\bPaper-scale evidence floor:/iu.test(text)
    || /\bCanonical-reference gate:/iu.test(text)
    || /\b(?:current|selected|configured|registered|locked)_[a-z0-9_]*baseline\b/iu.test(text)
    || /^The best nonbaseline row should therefore be read as a selection signal\b/iu.test(text)
  );
}

function isPageBudgetRestorationDuplicate(_heading: string, existingParagraphs: string[], candidate: string): boolean {
  const candidateTokens = new Set(cleanString(candidate).toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 4));
  if (candidateTokens.size < 8) {
    return false;
  }
  return existingParagraphs.some((paragraph) => {
    const existingTokens = new Set(cleanString(paragraph).toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 4));
    if (existingTokens.size < 8) {
      return false;
    }
    let overlap = 0;
    for (const token of candidateTokens) {
      if (existingTokens.has(token)) overlap += 1;
    }
    return overlap / Math.min(candidateTokens.size, existingTokens.size) >= 0.7;
  });
}

export function strengthenPaperScaleManuscript(
  manuscript: PaperManuscript,
  context: ExperimentArtifactContext
): PaperManuscript {
  return {
    ...manuscript,
    abstract: sanitizeHumanFacingManuscriptText(rewriteTextForClaimStrength(manuscript.abstract, context, [])),
    sections: strengthenHumanFacingSections(manuscript.sections, context)
  };
}

function compactReaderFacingScientificManuscript(
  manuscript: PaperManuscript
): PaperManuscript {
  return {
    ...manuscript,
    sections: manuscript.sections.map((section) => {
      const normalized = cleanString(section.heading).toLowerCase();
      if (normalized === "method") {
        return {
          ...section,
          paragraphs: compactReaderFacingMethodParagraphs(section.paragraphs)
        };
      }
      if (normalized === "discussion") {
        return {
          ...section,
          paragraphs: compactReaderFacingDiscussionParagraphs(section.paragraphs)
        };
      }
      return {
        ...section,
        paragraphs: section.paragraphs.map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph)).filter(Boolean)
      };
    })
  };
}

function compactReaderFacingMethodParagraphs(paragraphs: string[]): string[] {
  return uniqueStrings(
    paragraphs.map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph)).filter(Boolean)
  );
}

function compactReaderFacingDiscussionParagraphs(paragraphs: string[]): string[] {
  return uniqueStrings(
    paragraphs.map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph)).filter(Boolean)
  );
}

function strengthenHumanFacingSections(
  sections: PaperManuscriptSection[],
  context: ExperimentArtifactContext
): PaperManuscriptSection[] {
  return sections.map((section) => {
    let strengthened: PaperManuscriptSection;
    if (/^introduction$/iu.test(cleanString(section.heading))) {
      strengthened = removeInternalIntroductionParagraphs(section);
    } else if (/^method$/iu.test(cleanString(section.heading))) {
      strengthened = strengthenMethodSectionWithArtifactDetails(section, context);
    } else if (/^related work$/iu.test(cleanString(section.heading))) {
      strengthened = strengthenRelatedWorkSectionWithPaperContrasts(section, context);
    } else if (/^results$/iu.test(cleanString(section.heading))) {
      strengthened = strengthenResultsSectionNarrative(section, context);
    } else if (/^discussion$/iu.test(cleanString(section.heading))) {
      strengthened = strengthenDiscussionSectionWithEvidenceCeiling(section, context);
    } else if (/^limitations$/iu.test(cleanString(section.heading))) {
      strengthened = strengthenLimitationsSectionWithScope(section, context);
    } else if (/^conclusion$/iu.test(cleanString(section.heading))) {
      strengthened = softenAppendixPromiseInSection(section);
    } else {
      strengthened = section;
    }
    return {
      ...strengthened,
      paragraphs: strengthened.paragraphs.map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph)).filter(Boolean)
    };
  });
}

function removeInternalIntroductionParagraphs(section: PaperManuscriptSection): PaperManuscriptSection {
  const paragraphs = section.paragraphs
    .map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph))
    .filter((paragraph) => !isInternalIntroductionParagraph(paragraph));
  if (paragraphs.length === 0) {
    return section;
  }
  return {
    ...section,
    paragraphs: paragraphs.slice(0, 2)
  };
}

function isInternalIntroductionParagraph(paragraph: string): boolean {
  return (
    /\bThis study addresses Study\b/iu.test(paragraph)
    || /\bworkflow (?:run|review)\b|\breview gating\b|\bpaper-readiness audit\b|\bresult-table integrity\b/iu.test(paragraph)
    || /\bresult-table consistency\b|\bbounded claim ceiling\b|\bclaim-downgrade\b|\bpre-registered result-gating\b|\bcurrent artifacts\b/iu.test(paragraph)
    || /\bObjective metric met\s*:/iu.test(paragraph)
    || /\bThe paper is scoped around\s*-/iu.test(paragraph)
    || /\bPrimary metric\s*:/iu.test(paragraph)
    || /\bNo-signal boundary\s*:/iu.test(paragraph)
  );
}

function strengthenRelatedWorkSectionWithPaperContrasts(
  section: PaperManuscriptSection,
  context: ExperimentArtifactContext
): PaperManuscriptSection {
  const paragraphs = section.paragraphs
    .map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph))
    .filter(Boolean);
  const sectionText = paragraphs.join(" ");
  const titles = uniqueStrings(
    context.related_work.closest_titles.map((item) => cleanString(item)).filter(Boolean)
  ).slice(0, 3);
  if (
    titles.length < 2
    || (titles.some((title) => sectionText.includes(title)) && /by contrast|whereas|unlike|rather than/iu.test(sectionText))
  ) {
    return { ...section, paragraphs };
  }
  const contrastSentence = sanitizeHumanFacingManuscriptText(buildRelatedWorkContrastSentence(titles, context));
  return contrastSentence
    ? { ...section, paragraphs: uniqueStrings([...paragraphs, contrastSentence]) }
    : { ...section, paragraphs };
}

function strengthenResultsSectionNarrative(
  section: PaperManuscriptSection,
  _context: ExperimentArtifactContext
): PaperManuscriptSection {
  return {
    ...section,
    paragraphs: section.paragraphs
      .map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph))
      .filter((paragraph) => paragraph && !isRawMetricDumpParagraph(paragraph))
  };
}

function isRawMetricDumpParagraph(paragraph: string): boolean {
  const cleaned = cleanString(paragraph);
  if (!cleaned) {
    return true;
  }
  if (/\bObjective metric\s+(?:met|not met)\s*:/iu.test(cleaned)) {
    return true;
  }
  if (/^(?:results?|metrics?)\s*\//iu.test(cleaned) && /(?:95%\s+CI|=|:)/u.test(cleaned)) {
    return true;
  }
  if (/^(?:wall[_ ]clock[_ ]runtime|device[_ ].*memory)[_ ]/iu.test(cleaned) && /=\s*-?\d/u.test(cleaned)) {
    return true;
  }
  const metricAssignments = cleaned.match(
    /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\s*=\s*-?\d+(?:,\d{3})*(?:\.\d+)?(?:e[+-]?\d+)?/giu
  ) || [];
  if (metricAssignments.length >= 2) {
    return true;
  }
  if (/^The 95% interval for (?:comparisons?|results?)\b/iu.test(cleaned)) {
    return true;
  }
  return false;
}

function sanitizeReaderFacingAppendixSections(
  sections: PaperManuscriptSection[] | undefined
): PaperManuscriptSection[] | undefined {
  if (!sections || sections.length === 0) {
    return sections;
  }
  const sanitized = sections
    .map((section) => {
      const paragraphs = section.paragraphs
        .map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph))
        .filter((paragraph) => paragraph && !isInternalAppendixParagraph(paragraph));
      return {
        ...section,
        heading: sanitizeAppendixHeading(section.heading),
        paragraphs
      };
    })
    .filter((section) => section.paragraphs.length > 0);
  const merged = mergeAppendixSectionsByHeading(sanitized);
  return merged.length > 0 ? merged : undefined;
}

function mergeAppendixSectionsByHeading(sections: PaperManuscriptSection[]): PaperManuscriptSection[] {
  const merged: PaperManuscriptSection[] = [];
  const byHeading = new Map<string, PaperManuscriptSection>();
  for (const section of sections) {
    const heading = cleanString(section.heading) || "Supplementary Experimental Details";
    const existing = byHeading.get(heading);
    if (!existing) {
      const next = { ...section, heading, paragraphs: uniqueStrings(section.paragraphs) };
      byHeading.set(heading, next);
      merged.push(next);
      continue;
    }
    existing.paragraphs = uniqueStrings([...existing.paragraphs, ...section.paragraphs]);
    existing.source_refs = existing.source_refs?.length
      ? existing.source_refs
      : section.source_refs;
  }
  return merged;
}

function sanitizeAppendixHeading(heading: string): string {
  const cleaned = sanitizeHumanFacingManuscriptText(heading);
  if (!cleaned || isInternalAppendixParagraph(cleaned)) {
    return "Supplementary Experimental Details";
  }
  return cleaned;
}

function isInternalAppendixParagraph(paragraph: string): boolean {
  const cleaned = cleanString(paragraph);
  if (!cleaned) {
    return true;
  }
  return (
    /\b(manuscript[- ]?quality gate|PDF build report|page[- ]?budget validation|readiness decision|paper[- ]?readiness|claim[- ]?evidence map|claim[- ]?ceiling|gate output|generated manuscript|artifact directory|run-owned artifacts|workflow audit|review gate)\b/iu.test(cleaned)
    || /\b(raw json|json artifact|submission validation|scientific validation|quality failure)\b/iu.test(cleaned)
    || /\b(manuscript may say|manuscript therefore passes|paper-scale preflight|manuscript promotion|audit pattern|claim-evidence links|review artifacts|verification artifacts)\b/iu.test(cleaned)
    || /(?:^|\s)\/(?:home|tmp|mnt|outputs|artifact)\b/iu.test(cleaned)
  );
}

function strengthenDiscussionSectionWithEvidenceCeiling(
  section: PaperManuscriptSection,
  context: ExperimentArtifactContext
): PaperManuscriptSection {
  const additions = [
    context.results.effect_notes[0],
    context.results.heterogeneity_notes[0],
    context.discussion.practical_implications[0]
  ]
    .map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph || ""))
    .filter(Boolean);
  return {
    ...section,
    paragraphs: uniqueStrings([
      ...section.paragraphs.map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph)).filter(Boolean),
      ...additions
    ])
  };
}

function strengthenLimitationsSectionWithScope(
  section: PaperManuscriptSection,
  context: ExperimentArtifactContext
): PaperManuscriptSection {
  const additions = context.discussion.limitations
    .map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph))
    .filter(Boolean);
  return {
    ...section,
    paragraphs: uniqueStrings([
      ...section.paragraphs.map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph)).filter(Boolean),
      ...additions
    ])
  };
}

function buildRelatedWorkContrastSentence(
  titles: string[],
  context: ExperimentArtifactContext
): string {
  const axis = firstSafeRelatedWorkAxis(context) || "evaluation scope";
  const clauses = titles.map((title) => `${title} provides comparison context`);
  return sanitizeHumanFacingManuscriptText(
    `${joinHumanList(clauses)} for ${axis}. These works frame the research question, while direct comparisons remain grounded in the executed study.`
  );
}

function softenAppendixPromiseInSection(section: PaperManuscriptSection): PaperManuscriptSection {
  return {
    ...section,
    paragraphs: uniqueStrings(
      section.paragraphs.map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph)).filter(Boolean)
    )
  };
}

function strengthenMethodSectionWithArtifactDetails(
  section: PaperManuscriptSection,
  context: ExperimentArtifactContext
): PaperManuscriptSection {
  const detailParagraph = sanitizeHumanFacingManuscriptText(buildExecutedProtocolDetailParagraph(context));
  const paragraphs = section.paragraphs
    .map((paragraph) => sanitizeHumanFacingManuscriptText(paragraph))
    .filter(Boolean);
  if (!detailParagraph || paragraphs.some((paragraph) => paragraph.includes(detailParagraph))) {
    return { ...section, paragraphs };
  }
  return {
    ...section,
    paragraphs: uniqueStrings([...paragraphs, detailParagraph])
  };
}

function buildExecutedProtocolDetailParagraph(context: ExperimentArtifactContext): string {
  const seriesLabels = context.method.model_names.slice(0, 4);
  const methodNotes = context.method.hyperparameter_notes
    .map((item) => sanitizeHumanFacingManuscriptText(item))
    .filter((item) => item && !isInternalWorkflowNarrative(item));
  if (seriesLabels.length === 0 && methodNotes.length === 0) {
    return "";
  }
  const sentences: string[] = [];
  if (seriesLabels.length > 0) {
    sentences.push(`Declared result series include ${joinHumanList(seriesLabels)}.`);
  }
  sentences.push(...methodNotes.slice(0, 3));
  return sanitizeHumanFacingManuscriptText(sentences.join(" "));
}
function sanitizeHumanFacingManuscriptText(text: string): string {
  const cleaned = cleanString(text);
  if (!cleaned) {
    return text;
  }
  const withoutDraftInstructions = stripHumanFacingDraftInstructionSentences(cleaned);
  if (!withoutDraftInstructions) {
    return "";
  }
  if (/^\s*\[(?:warning|error|fail|failed|pass|passed)\]\s*[^:]{0,80}:/iu.test(withoutDraftInstructions)) {
    return "";
  }
  if (
    isHumanFacingProtocolChecklistResidue(withoutDraftInstructions)
    || isInternalWorkflowNarrative(withoutDraftInstructions)
  ) {
    return "";
  }

  const withoutMetricDumps = stripInternalMetricDumpSentences(
    stripLimitedEvidenceBoilerplate(stripRawCitationTokens(withoutDraftInstructions))
  );
  const readerFacing = rewriteObjectiveMetricStatus(
    rewriteReaderFacingProvenancePhrases(withoutMetricDumps)
  );

  return stripInternalProvenanceLabels(readerFacing)
    .replace(/\bparameter-computationally\s+practical\s+within\s+the\s+reported\s+setup\b/giu, "parameter-efficient")
    .replace(/\bmemory-computationally\s+practical\s+within\s+the\s+reported\s+setup\b/giu, "memory-efficient")
    .replace(/\bcost-computationally\s+practical\s+within\s+the\s+reported\s+setup\b/giu, "cost-efficient")
    .replace(/\bcompute-computationally\s+practical\s+within\s+the\s+reported\s+setup\b/giu, "compute-efficient")
    .replace(/\bpaper-readiness\s+inspect\b/giu, "submission-quality inspection")
    .replace(/\binspect-relevant\b/giu, "protocol-relevant")
    .replace(/\bFor\s+inspect\s+purposes\b/giu, "For clarity")
    .replace(/\bbounded claim ceiling\b/giu, "bounded interpretation")
    .replace(/\bclaim ceiling\b/giu, "claim boundary")
    .replace(/\bclaim downgrade correctness\b/giu, "claim-scope correctness")
    .replace(/\bclaim-downgrade\b/giu, "claim-scope adjustment")
    .replace(/\breview gating\b/giu, "review checks")
    .replace(/\bpaper-readiness audit\b/giu, "paper-scale review")
    .replace(/\bresult-table integrity\b/giu, "result-table consistency")
    .replace(/[.!?]\s+under an explicitly bounded evidence ceiling\b/giu, " under an explicitly bounded evidence ceiling")
    .replace(
      /\bwall[_ ]clock[_ ]runtime[_ ]sec\s*=\s*(-?\d+(?:,\d{3})*(?:\.\d+)?)\.?/giu,
      "wall-clock runtime was $1 seconds."
    )
    .replace(
      /\bdevice[_ ](?:cuda[_ ])?max[_ ]memory[_ ]allocated[_ ]bytes\s*=\s*\d+\.?/giu,
      "peak device-memory allocation was recorded as a secondary resource diagnostic."
    )
    .replace(
      /\b(?:verifier feedback status|validation status)\s+is\s+(?:pass|passed)\b/giu,
      "the screening check was positive"
    )
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\/(?:Users|home|tmp|var|private|Volumes)\/[^\s,.;)`]+/gu, "the local workspace")
    .replace(/\.autolabos\/(?:[^\s,.;)`]+)?/giu, "the governed run artifact directory")
    .replace(/\btest\/outputs?\/[^\s,.;)`]+/giu, "the public output directory")
    .replace(/\boutputs\/[^\s,.;)`]+/giu, "the public output bundle")
    .replace(/\s+([.,;:])/gu, "$1")
    .replace(/\.{2,}/gu, ".")
    .replace(/\s+/gu, " ")
    .trim();
}

function isInternalWorkflowNarrative(value: string): boolean {
  return (
    /\b(?:workflow audit|generated manuscript|artifact directory|submission validation|scientific validation|quality failure|page[- ]budget restoration|cache recovery)\b/iu.test(value)
    || /\b(?:current artifacts|current workflow)\b[^.!?]{0,180}\b(?:gate|validation|artifact|manuscript generation)\b/iu.test(value)
    || /^\s*Study how\b/iu.test(value)
    || /\brun workload\b[^.!?]{0,120}\bbudget\b/iu.test(value)
  );
}

function rewriteObjectiveMetricStatus(value: string): string {
  const replacement = (_match: string, status: string) =>
    status.toLowerCase() === "met" || status.toLowerCase() === "exceeded"
      ? "The archived objective check cleared its configured screening threshold; structured result tables remain the source of numerical support."
      : "The archived objective check did not clear its configured screening threshold; structured result tables remain the source of numerical support.";

  return value
    .replace(
      /\bObjective metric\s+(met|not met)\s*:\s*[A-Za-z][A-Za-z0-9_.-]*\s*=\s*-?\d+(?:,\d{3})*(?:\.\d+)?\s*(?:>=|<=|>|<|=)\s*-?\d+(?:,\d{3})*(?:\.\d+)?\.?/giu,
      replacement
    )
    .replace(
      /\bThe study-level objective was\s+(met|not met)\s*:[^.!?]{0,180}\b[A-Za-z][A-Za-z0-9_.-]*\s*=\s*-?\d+(?:,\d{3})*(?:\.\d+)?\.?/giu,
      replacement
    )
    .replace(
      /\bAt the study level,[^.!?]{0,120}\b[A-Za-z][A-Za-z0-9_.-]*\s*=\s*-?\d+(?:,\d{3})*(?:\.\d+)?,\s*which\s+(exceeded|did not meet)[^.!?]{0,100}\btarget\b[^.!?]*\.?/giu,
      replacement
    );
}

function stripInternalMetricDumpSentences(value: string): string {
  const metricAssignmentPattern =
    /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\s*=\s*-?\d+(?:,\d{3})*(?:\.\d+)?(?:e[+-]?\d+)?/giu;
  return cleanString(
    value
      .split(/(?<=[.!?])\s+/u)
      .filter((sentence) => (sentence.match(metricAssignmentPattern) || []).length < 2)
      .join(" ")
  );
}

function stripInternalProvenanceLabels(value: string): string {
  return value.replace(
    /\s*\[([^\[\]\n]{1,120})\]/gu,
    (match: string, rawLabel: string, offset: number, source: string) => {
      const label = cleanString(rawLabel);
      if (!label) {
        return "";
      }
      const prefix = source.slice(0, offset).trimEnd().toLocaleLowerCase();
      if (prefix.endsWith(label.toLocaleLowerCase())) {
        return "";
      }
      const labels = label.split(/\s*;\s*/u).filter(Boolean);
      const isInternalLabel = labels.every((item) =>
        /^(?:(?:the\s+)?(?:configured|selected|fallback|training|evaluation)\s+)?(?:model|backbone|dataset|benchmark(?:\s+task)?|task)(?:\s+[A-Za-z0-9._/-]+){0,4}$/iu.test(item)
      );
      return isInternalLabel ? "" : match;
    }
  );
}

function stripHumanFacingDraftInstructionSentences(text: string): string {
  return cleanString(
    text
      .split(/(?<=[.!?])\s+/u)
      .filter((sentence) => !/\b(?:this draft|available to this draft|final manuscript should cite|final paper version should include|any final paper version should include)\b/iu.test(sentence))
      .filter((sentence) => !/\b(?:final analysis should make clear|those values should be presented|should be presented in the reproducibility supplement)\b/iu.test(sentence))
      .filter((sentence) => !/\b(?:unvalidated notes|stable sources|internal repair guidance|future reporting requirements)\b/iu.test(sentence))
      .filter((sentence) => !/\b(?:until|before)\b[^.!?]{0,220}\breproducibility supplement\b/iu.test(sentence))
      .join(" ")
  );
}

function sanitizeRelatedWorkAxisForNarrative(value: string | undefined): string {
  const cleaned = sanitizeHumanFacingManuscriptText(cleanString(value))
    .replace(/\.{2,}/gu, ".")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || isBibliographicSpilloverText(cleaned)) {
    return "";
  }
  if (cleaned.length > 150) {
    return firstSentence(cleaned).slice(0, 150).replace(/\s+\S*$/u, "").trim();
  }
  return cleaned;
}

function sanitizeRelatedWorkTitleForNarrative(value: string | undefined): string {
  const cleaned = cleanString(value)
    .replace(/\.{2,}/gu, ".")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned || isBibliographicSpilloverText(cleaned)) {
    return "";
  }
  const words = cleaned.split(/\s+/u);
  return words.length > 12 ? `${words.slice(0, 12).join(" ")}...` : cleaned;
}

function isBibliographicSpilloverText(value: string): boolean {
  const text = cleanString(value);
  if (!text) {
    return false;
  }
  if (/\s-\s(?:Primary metric|Secondary metrics|Meaningful improvement|No-signal boundary)\s*:/iu.test(text)) {
    return true;
  }
  if (/\bThe present paper positions itself around\s*-\s*Primary metric\b/iu.test(text)) {
    return true;
  }
  if (/\bThe most relevant comparison axes concern\s+Recently,/iu.test(text)) {
    return true;
  }
  if (/^(?:Recently,|This paper proposes\b)/iu.test(text)) {
    return true;
  }
  if (/^Published as a conference paper\b/iu.test(text)) {
    return true;
  }
  if (/\b[A-Z](?:\s+[A-Z]){3,}\b.*\b(?:conference paper|ICLR|ACL|EMNLP|NeurIPS|ICML)\b/iu.test(text)) {
    return true;
  }
  if (/\b(?:ICLR|ACL|EMNLP|NeurIPS|ICML)\s+\d{4}\b.*\b[A-Z][a-z]+\s+[A-Z][a-z]+/u.test(text)) {
    return true;
  }
  if (/\b(?:The University of|Department of|Institute of)\b.*\b(?:The University of|Department of|Institute of)\b/iu.test(text)) {
    return true;
  }
  if (/\b[A-Z][a-z]+ [A-Z][a-z]+ [A-Z][a-z]+\b.*\b(?:University|Department|Institute)\b/u.test(text)) {
    return true;
  }
  if (/\.\.\./u.test(text) && /\b(?:University|Department|Institute|This paper proposes|Recently,)\b/iu.test(text)) {
    return true;
  }
  return false;
}

function buildRelatedWorkAxisSentence(context: ExperimentArtifactContext): string {
  const axes = context.related_work.comparison_axes
    .map((axis) => sanitizeRelatedWorkAxisForNarrative(axis))
    .filter(Boolean)
    .slice(0, 3);
  if (axes.length === 0) {
    return "The most relevant comparison axes concern method family, resource budget, and evaluation scope.";
  }
  return `The most relevant comparison axes concern ${joinHumanList(axes)}.`;
}

function firstSafeRelatedWorkAxis(context: ExperimentArtifactContext): string {
  return (
    context.related_work.comparison_axes
      .map((axis) => sanitizeRelatedWorkAxisForNarrative(axis))
      .find(Boolean) || ""
  );
}

function safeRelatedWorkClusters(context: ExperimentArtifactContext): string[] {
  return context.related_work.clusters
    .map((cluster) => sanitizeRelatedWorkAxisForNarrative(cluster))
    .filter(Boolean);
}

function buildClosestCitedWorkSentence(context: ExperimentArtifactContext): string {
  const clusters = safeRelatedWorkClusters(context).slice(0, 3);
  if (clusters.length > 0) {
    return `The closest cited work frames ${joinHumanList(clusters)} rather than a direct reproduction of the present run.`;
  }
  return "The closest cited work frames the empirical design rather than a direct reproduction of the present run.";
}

function describeScientificObjectiveForNarrative(value: string | undefined): string {
  const cleaned = sanitizeHumanFacingManuscriptText(cleanString(value));
  if (!cleaned || isBibliographicSpilloverText(cleaned)) {
    return "the stated empirical objective";
  }
  if (/\b(?:baseline|reference|comparison|difference|delta)\b/iu.test(cleaned)) {
    return "the declared primary comparison under the stated evaluation budget";
  }
  return cleaned.length > 120 ? "the stated empirical objective" : cleaned;
}

function rewriteReaderFacingProvenancePhrases(value: string): string {
  return value
    .replace(
      /\b(?:paper-writing|manuscript-facing)\s+(?:payload|bundle|record)\b/giu,
      "reported evidence"
    )
    .replace(
      /\b(?:preserved manuscript bundle|reader-visible summary|compact (?:record|summary|bundle|release))\b/giu,
      "reported evidence"
    )
    .replace(/\b(?:the present payload|the payload)\b/giu, "the reported evidence")
    .replace(/\bnot exposed in the writing payload\b/giu, "not available in the reported evidence")
    .replace(/\bthe present payload cannot establish\b/giu, "the reported evidence cannot establish")
    .replace(/\bThe payload also contains\b/giu, "The reported evidence also contains")
    .replace(/\breader-visible audit-?log sentence\b/giu, "reader-facing transition sentence")
    .replace(/\binternal audit\/log sentence\b/giu, "reader-facing transition sentence")
    .replace(/\baudit-?log sentence\b/giu, "transition sentence")
    .replace(/\b(?:executable|run-owned) run metadata\b/giu, "reported run metadata")
    .replace(/\brun metadata\b/giu, "reported run details");
}

function stripRawCitationTokens(text: string): string {
  return text
    .replace(/\s*\[(?=[^\]]*(?:doi:|arxiv|[a-f0-9]{20,}))[^\]]+\]/giu, "")
    .replace(/\s*\((?=[^)]*(?:doi:|arxiv|[a-f0-9]{20,}))[^)]+\)/giu, "");
}

function stripLimitedEvidenceBoilerplate(text: string): string {
  return text
    .replace(/\s*(?:;|,|\.)?\s*direct supporting evidence is currently limited\.?/giu, ".")
    .replace(/\s*this section is written conservatively because direct supporting evidence is currently limited\.?/giu, "");
}

function buildManuscriptProvenanceMap(input: {
  manuscript: PaperManuscript;
  draft: PaperDraft;
  context: ExperimentArtifactContext;
  expectedMetricFacts: NormalizedNumericFact[];
}): ManuscriptProvenanceMap {
  const sectionClaimIds = new Map<string, string[]>();
  for (const claim of input.draft.claims) {
    const key = normalizeHeading(claim.section_heading || "");
    if (!key) {
      continue;
    }
    sectionClaimIds.set(key, uniqueStrings([...(sectionClaimIds.get(key) || []), claim.claim_id]));
  }

  const allObservedMetricFacts = collectObservedMetricFacts(input.manuscript, input.context);
  const appendixFacts = allObservedMetricFacts.filter((fact) => isAppendixFactSource(fact.source));
  const paragraphAnchors: ManuscriptProvenanceParagraphAnchor[] = [];
  const numericAnchors: ManuscriptProvenanceNumericAnchor[] = [];
  const sections: ManuscriptProvenanceSectionEntry[] = [];

  const abstractAnchorId = buildManuscriptParagraphAnchorId("Abstract", 0);
  const abstractFacts = extractMetricFactsFromText({
    text: input.manuscript.abstract,
    source: "abstract",
    location: "Abstract",
    context: input.context,
    sourceRefs: undefined
  });
  paragraphAnchors.push({
    anchor_id: abstractAnchorId,
    section: "Abstract",
    paragraph_index: 0,
    text_preview: truncatePreview(input.manuscript.abstract),
    numeric_fact_ids: abstractFacts.map((fact) => fact.fact_id)
  });
  numericAnchors.push(
    ...abstractFacts.map((fact) =>
      buildProvenanceNumericAnchor(fact, abstractAnchorId, input.expectedMetricFacts, appendixFacts)
    )
  );
  sections.push({
    section: "Abstract",
    paragraph_anchor_ids: [abstractAnchorId],
    claim_anchor_ids: [],
    numeric_fact_ids: abstractFacts.map((fact) => fact.fact_id)
  });

  for (const section of input.manuscript.sections) {
    const normalizedHeading = normalizeHeading(section.heading);
    const claimIds = sectionClaimIds.get(normalizedHeading) || [];
    const sectionParagraphAnchors: string[] = [];
    const sectionNumericFactIds: string[] = [];

    for (let index = 0; index < section.paragraphs.length; index += 1) {
      const paragraph = section.paragraphs[index] || "";
      const anchorId = buildManuscriptParagraphAnchorId(section.heading, index);
      const facts = extractMetricFactsFromText({
        text: paragraph,
        source: mapSectionHeadingToNumericFactSource(section.heading),
        location: section.heading,
        context: input.context,
        sourceRefs: section.source_refs
      });
      sectionParagraphAnchors.push(anchorId);
      sectionNumericFactIds.push(...facts.map((fact) => fact.fact_id));
      paragraphAnchors.push({
        anchor_id: anchorId,
        section: section.heading,
        paragraph_index: index,
        text_preview: truncatePreview(paragraph),
        ...(section.source_refs?.length ? { source_refs: section.source_refs } : {}),
        ...(claimIds.length ? { claim_ids: claimIds } : {}),
        numeric_fact_ids: facts.map((fact) => fact.fact_id)
      });
      numericAnchors.push(
        ...facts.map((fact) =>
          buildProvenanceNumericAnchor(fact, anchorId, input.expectedMetricFacts, appendixFacts)
        )
      );
    }

    sections.push({
      section: section.heading,
      paragraph_anchor_ids: sectionParagraphAnchors,
      claim_anchor_ids: claimIds.map((claimId) => `claim:${claimId}`),
      numeric_fact_ids: uniqueStrings(sectionNumericFactIds),
      ...(section.source_refs?.length ? { source_refs: section.source_refs } : {})
    });
  }

  const visualAnchors = buildProvenanceVisualEntries(input, numericAnchors);

  return {
    sections,
    paragraph_anchors: paragraphAnchors,
    numeric_anchors: dedupeProvenanceNumericAnchors(numericAnchors),
    visual_anchors: visualAnchors
  };
}

function buildProvenanceVisualEntries(
  input: {
    manuscript: PaperManuscript;
    context: ExperimentArtifactContext;
    expectedMetricFacts: NormalizedNumericFact[];
  },
  numericAnchors: ManuscriptProvenanceNumericAnchor[]
): ManuscriptProvenanceVisualEntry[] {
  const appendixFacts = numericAnchors
    .filter((anchor) => anchor.fact.source === "appendix_section" || anchor.fact.source === "appendix_table" || anchor.fact.source === "appendix_figure")
    .map((anchor) => anchor.fact);
  const entries: ManuscriptProvenanceVisualEntry[] = [];
  const pushEntry = (
    kind: ManuscriptProvenanceVisualEntry["kind"],
    caption: string,
    rows: Array<{ label: string; value: number }>,
    index: number,
    source: Extract<NumericFactSource, "table" | "figure" | "appendix_table" | "appendix_figure">,
    sourceRefs?: PaperSourceRef[]
  ) => {
    const anchorId = `${kind}:${index}`;
    const facts = extractMetricFactsFromVisual({
      source,
      location: anchorId,
      caption,
      rows,
      context: input.context,
      sourceRefs
    });
    numericAnchors.push(
      ...facts.map((fact) =>
        buildProvenanceNumericAnchor(fact, anchorId, input.expectedMetricFacts, appendixFacts)
      )
    );
    entries.push({
      anchor_id: anchorId,
      kind,
      caption,
      ...(sourceRefs?.length ? { source_refs: sourceRefs } : {}),
      numeric_fact_ids: facts.map((fact) => fact.fact_id)
    });
  };

  (input.manuscript.tables || []).forEach((table, index) => {
    pushEntry("table", table.caption, table.rows, index + 1, "table", table.source_refs);
  });
  (input.manuscript.figures || []).forEach((figure, index) => {
    pushEntry("figure", figure.caption, figure.bars, index + 1, "figure", figure.source_refs);
  });
  (input.manuscript.appendix_tables || []).forEach((table, index) => {
    pushEntry("appendix_table", table.caption, table.rows, index + 1, "appendix_table", table.source_refs);
  });
  (input.manuscript.appendix_figures || []).forEach((figure, index) => {
    pushEntry("appendix_figure", figure.caption, figure.bars, index + 1, "appendix_figure", figure.source_refs);
  });

  return entries;
}

function buildProvenanceNumericAnchor(
  fact: NormalizedNumericFact,
  sourceAnchorId: string,
  expectedMetricFacts: NormalizedNumericFact[],
  appendixFacts: NormalizedNumericFact[]
): ManuscriptProvenanceNumericAnchor {
  const comparableExpected = expectedMetricFacts.filter((candidate) => areComparableNumericFacts(fact, candidate));
  const supportedFacts = comparableExpected.filter((candidate) => areFactValuesEquivalent(fact, candidate));
  const appendixOnlyFacts = appendixFacts.filter(
    (candidate) =>
      candidate.fact_id !== fact.fact_id
      && areComparableNumericFacts(fact, candidate)
      && areFactValuesEquivalent(fact, candidate)
  );
  const supportStatus: ManuscriptProvenanceNumericAnchor["support_status"] =
    supportedFacts.length > 0
      ? "supported"
      : appendixOnlyFacts.length > 0 && allowsAppendixOnlyWarning(fact.source)
        ? "appendix_only"
        : comparableExpected.length > 0
          ? "contradiction"
          : "unverifiable";

  return {
    anchor_id: `numeric:${fact.fact_id}`,
    source_anchor_id: sourceAnchorId,
    source: fact.source,
    location: fact.location,
    support_status: supportStatus,
    fact,
    supporting_fact_ids: [...supportedFacts, ...appendixOnlyFacts].map((candidate) => candidate.fact_id),
    ...(fact.source_refs?.length ? { source_refs: fact.source_refs } : {})
  };
}

function dedupeProvenanceNumericAnchors(
  anchors: ManuscriptProvenanceNumericAnchor[]
): ManuscriptProvenanceNumericAnchor[] {
  const seen = new Set<string>();
  const unique: ManuscriptProvenanceNumericAnchor[] = [];
  for (const anchor of anchors) {
    if (seen.has(anchor.anchor_id)) {
      continue;
    }
    seen.add(anchor.anchor_id);
    unique.push(anchor);
  }
  return unique;
}

function buildManuscriptParagraphAnchorId(sectionHeading: string, paragraphIndex: number): string {
  const heading = normalizeHeading(sectionHeading).replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return `paragraph:${heading || "section"}:${paragraphIndex}`;
}

function mapSectionHeadingToNumericFactSource(heading: string): NumericFactSource {
  switch (normalizeHeading(heading)) {
    case "related work":
      return "related_work";
    case "method":
      return "method";
    case "results":
      return "results";
    case "discussion":
      return "discussion";
    case "limitations":
      return "limitations";
    case "conclusion":
      return "conclusion";
    default:
      return "results";
  }
}

function truncatePreview(text: string): string {
  const cleaned = cleanString(text);
  return cleaned.length <= 160 ? cleaned : `${cleaned.slice(0, 157)}...`;
}

function attachAppendixCrossReferences(
  manuscript: PaperManuscript,
  appendixPlan: AppendixPlan
): void {
  if (appendixPlan.cross_references.length === 0) {
    return;
  }
  const preferredTargets: Array<{ heading: string; reference: AppendixReference["label"]; sentence: string }> =
    appendixPlan.cross_references.map((reference) => {
      if (/hyperparameter|protocol|environment|reproducibility/iu.test(reference.reason)) {
        return {
          heading: "Method",
          reference: reference.label || "Appendix",
          sentence: `${cleanString(reference.reason).charAt(0).toUpperCase()}${cleanString(reference.reason).slice(1)} are summarized in ${reference.label || "the appendix"}.`
        };
      }
      if (/repeat-level|per-dataset/iu.test(reference.reason)) {
        return {
          heading: "Results",
          reference: reference.label || "Appendix",
          sentence: `Supplementary dataset and repeat summaries are reported in ${reference.label || "the appendix"}.`
        };
      }
      return {
        heading: "Limitations",
        reference: reference.label || "Appendix",
        sentence: `Supporting caveats and extended failure analysis appear in ${reference.label || "the appendix"}.`
      };
    });

  for (const target of preferredTargets) {
    const section = findSection(manuscript.sections, target.heading);
    if (!section || section.paragraphs.length === 0) {
      continue;
    }
    const lastIndex = section.paragraphs.length - 1;
    if (section.paragraphs[lastIndex]?.includes(target.reference)) {
      continue;
    }
    section.paragraphs[lastIndex] = `${section.paragraphs[lastIndex]} ${target.sentence}`.trim();
  }

  for (const reference of appendixPlan.cross_references) {
    const heading = inferAppendixReferenceSection(reference.reason, manuscript.sections);
    const section = findSection(manuscript.sections, heading);
    if (!section || section.paragraphs.length === 0) {
      continue;
    }
    const lastIndex = section.paragraphs.length - 1;
    if (
      section.paragraphs[lastIndex]?.includes(reference.label)
      || section.paragraphs[lastIndex]?.includes(reference.target_heading)
    ) {
      continue;
    }
    section.paragraphs[lastIndex] = `${section.paragraphs[lastIndex]} ${buildAppendixReferenceSentence(reference)}`.trim();
  }
}

function inferAppendixReferenceSection(
  reason: string,
  sections: PaperManuscriptSection[]
): string {
  if (/repeat-level|per-dataset/iu.test(reason)) {
    return "Results";
  }
  if (/hyperparameter|reproducibility-oriented environment/iu.test(reason)) {
    return "Method";
  }
  if (/failure analysis|limitation/iu.test(reason)) {
    return findSection(sections, "Limitations") ? "Limitations" : "Discussion";
  }
  return "Results";
}

function buildAppendixReferenceSentence(reference: AppendixReference): string {
  if (/repeat-level|per-dataset/iu.test(reference.reason)) {
    return `Supplementary dataset summaries are cross-referenced in ${reference.label}.`;
  }
  if (/hyperparameter/iu.test(reference.reason)) {
    return `Search-space detail is summarized in ${reference.label}.`;
  }
  if (/reproducibility-oriented environment/iu.test(reference.reason)) {
    return `Environment and reproducibility notes are summarized in ${reference.label}.`;
  }
  if (/failure analysis|limitation/iu.test(reference.reason)) {
    return `Extended caveats and failure cases are summarized in ${reference.label}.`;
  }
  return `Supporting detail is summarized in ${reference.label}.`;
}

function ensureDraftSections(
  draft: PaperDraft,
  bundle: PaperWritingBundle,
  context: ExperimentArtifactContext
): PaperDraft {
  const nextSections = [...draft.sections];
  for (const heading of SECTION_BUDGET_WEIGHTS.map((item) => item.heading)) {
    if (findSection(nextSections, heading)) {
      continue;
    }
    const candidates = buildSectionParagraphCandidates(heading, bundle, context);
    if (candidates.length === 0) {
      continue;
    }
    nextSections.push({
      heading,
      paragraphs: candidates.slice(0, SECTION_MIN_PARAGRAPHS[normalizeHeading(heading)] || 1),
      evidence_ids: inferSectionEvidenceIds(draft, bundle),
      citation_paper_ids: inferSectionCitationIds(draft, bundle)
    });
  }
  return {
    ...draft,
    sections: sortDraftSections(nextSections)
  };
}

function ensureMinimumSectionRichness(
  draft: PaperDraft,
  bundle: PaperWritingBundle,
  context: ExperimentArtifactContext
): PaperDraft {
  const sections = draft.sections.map((section) => {
    const minimumParagraphs = SECTION_MIN_PARAGRAPHS[normalizeHeading(section.heading)] || 1;
    const maximumParagraphs = SECTION_MAX_PARAGRAPHS[normalizeHeading(section.heading)] || 6;
    const candidates = buildSectionParagraphCandidates(section.heading, bundle, context);
    const merged = dedupeParagraphs([...section.paragraphs, ...candidates]);
    return {
      ...section,
      paragraphs: merged.slice(0, Math.max(minimumParagraphs, Math.min(maximumParagraphs, merged.length)))
    };
  });
  return {
    ...draft,
    sections: sortDraftSections(sections)
  };
}

function expandDraftAgainstBudget(
  draft: PaperDraft,
  bundle: PaperWritingBundle,
  context: ExperimentArtifactContext,
  headings: string[],
  expansionPass = 1
): PaperDraft {
  const sections = draft.sections.map((section) => {
    if (!headings.some((heading) => normalizeHeading(heading) === normalizeHeading(section.heading))) {
      return section;
    }
    const candidates = buildSectionParagraphCandidates(section.heading, bundle, context, true, expansionPass);
    const maximumParagraphs = SECTION_MAX_PARAGRAPHS[normalizeHeading(section.heading)] || 6;
    return {
      ...section,
      paragraphs: dedupeParagraphs([...section.paragraphs, ...candidates]).slice(0, maximumParagraphs)
    };
  });
  return { ...draft, sections };
}

function padDraftToMinimumWordFloor(
  draft: PaperDraft,
  bundle: PaperWritingBundle,
  context: ExperimentArtifactContext,
  profile: PaperProfileConfig,
  initialBudget: PageBudgetManagerReport
): PaperDraft {
  const preferredHeadings = [
    "Results",
    "Method",
    "Related Work",
    "Discussion",
    "Limitations",
    "Introduction",
    "Conclusion"
  ];
  const evidenceIds = inferSectionEvidenceIds(draft, bundle);
  const citationPaperIds = inferSectionCitationIds(draft, bundle);
  let nextDraft = draft;
  let pageBudget = initialBudget;
  let variant = 0;

  while (pageBudget.estimated_main_words < pageBudget.minimum_main_words && variant < 80) {
    const candidates = preferredHeadings
      .map((heading) => {
        const entry = pageBudget.sections.find((section) => normalizeHeading(section.heading) === normalizeHeading(heading));
        return {
          heading,
          remaining: Math.max(0, (entry?.target_words || 0) - (entry?.current_words || 0)),
          current: entry?.current_words || 0
        };
      })
      .sort((left, right) => (right.remaining - left.remaining) || (left.current - right.current));
    const targetHeading = candidates[0]?.heading || "Results";
    const paragraph = buildBudgetFloorParagraph(targetHeading, bundle, context, variant, evidenceIds, citationPaperIds);
    if (!paragraph) {
      break;
    }
    let inserted = false;
    const sections = nextDraft.sections.map((section) => {
      if (normalizeHeading(section.heading) !== normalizeHeading(targetHeading)) {
        return section;
      }
      inserted = true;
      return {
        ...section,
        paragraphs: dedupeParagraphs([...section.paragraphs, paragraph])
      };
    });
    if (!inserted) {
      sections.push({
        heading: targetHeading,
        paragraphs: [paragraph],
        evidence_ids: evidenceIds,
        citation_paper_ids: citationPaperIds
      });
    }
    nextDraft = {
      ...nextDraft,
      sections: sortDraftSections(sections)
    };
    pageBudget = pageBudgetManager({
      draft: nextDraft,
      profile
    });
    variant += 1;
  }

  return nextDraft;
}

function buildBudgetFloorParagraph(
  heading: string,
  bundle: PaperWritingBundle,
  context: ExperimentArtifactContext,
  variant: number,
  evidenceIds: string[],
  citationPaperIds: string[]
): PaperDraftParagraph | undefined {
  const primaryComparison = context.results.primary_comparison;
  const datasetNames = joinHumanList(context.method.dataset_names.slice(0, 4));
  const comparisonSurface = primaryComparison
    ? `the declared ${primaryComparison.subject.series_role}-to-baseline comparison for ${primaryComparison.metric_label}`
    : "the unresolved result contract";
  const sentencesByHeading: Record<string, string[][]> = {
    results: [
      [
        `The main result is reported through ${comparisonSurface} rather than through a value-selected example.`,
        context.results.aggregate_summary[0] || "The aggregate summary anchors the central empirical story.",
        "This makes the result table the primary evidence object and keeps any interpretation tied to comparable rows."
      ],
      [
        context.results.dispersion_notes[0] || context.results.ci_notes[0] || "Uncertainty remains visible in the structured result artifacts.",
        "The manuscript treats that uncertainty as part of the result rather than using it to choose between undeclared alternatives.",
        "This wording is intentionally conservative because the current run evaluates one declared comparison rather than inferring a universal ranking."
      ],
      [
        context.results.runtime_notes[0] || context.results.memory_notes[0] || "Operational traces are retained as execution evidence.",
        "They support execution accounting, but they do not by themselves establish a performance-efficiency ranking between series.",
        "That separation keeps resource observations from becoming unsupported optimization claims."
      ]
    ],
    method: [
      [
        datasetNames ? `The task scope is fixed around ${datasetNames}.` : "The task scope is fixed by the current run artifacts.",
        "The method section therefore describes the executed comparison as a locked protocol rather than as an open-ended search.",
        "That distinction is necessary because paper-readiness depends on the reader being able to reconstruct which evidence was generated and which follow-up remains planned."
      ],
      [
        context.method.repeat_notes[0] || "Repeated execution is treated as the unit of empirical support.",
        "Repeat-level outcomes are not promoted into separate conclusions; they are used only to expose variation around the linked observations.",
        "The baseline role and subject-minus-reference sign remain explicit, while preference is determined by the metric direction."
      ],
      [
        context.method.hyperparameter_notes[0] || "The tested configuration space is described only to the extent visible in the artifacts.",
        "Untested settings are left outside the conclusion rather than inferred from nearby grid points.",
        "This prevents the method description from implying a broader sweep than the run actually executed."
      ]
    ],
    "related work": [
      [
        buildClosestCitedWorkSentence(context),
        "These papers motivate the axes of comparison but do not replace a direct baseline in the current run.",
        "The manuscript therefore uses citations for positioning and the run artifacts for numerical support."
      ],
      [
        firstSafeRelatedWorkAxis(context)
          ? `The most relevant prior-work axis is ${firstSafeRelatedWorkAxis(context)}.`
          : "The most relevant prior-work axis is the relationship between evaluation design and defensible empirical claims.",
        "The current paper narrows that axis to the available budget and reports what can be tested locally.",
        "This makes the contribution a bounded evidence filter rather than a claim to supersede broader prior studies."
      ]
    ],
    discussion: [
      [
        context.discussion.discussion_points[0] || "The result should be interpreted as bounded evidence.",
        "The practical value is strongest when the reader needs a transparent preflight before spending more compute.",
        "It is weaker as a stand-alone theory of why the tested configuration behaves as it does."
      ],
      [
        context.discussion.practical_implications[0] || "The immediate implication is a follow-up candidate rather than a universal prescription.",
        "A stronger claim would require broader tasks, larger models or datasets, and the same failed-run visibility.",
        "The current manuscript keeps those requirements explicit so that the conclusion does not exceed the evidence."
      ]
    ],
    limitations: [
      [
        context.discussion.limitations[0] || "The main limitation is the bounded scope of the current evidence.",
        primaryComparison
          ? "The experiment can support only the directional interpretation encoded by the declared comparison; it cannot establish broad transfer, mechanism, or deployment robustness."
          : "Without a resolved primary comparison, the experiment cannot support a directional selection claim.",
        "Those limits are stated as part of the scientific result rather than hidden in a generic final paragraph."
      ],
      [
        "The manuscript also depends on consistency between result tables, captions, and the claim-evidence map.",
        "If those artifacts diverge in a later run, the readiness decision should be downgraded until the mismatch is repaired.",
        "This keeps paper-readiness tied to auditable evidence instead of to prose quality alone."
      ]
    ],
    introduction: [
      [
        `This paper studies ${bundle.topic} under an explicitly bounded evidence ceiling.`,
        "The goal is not to claim a broad autonomous discovery result, but to determine what the completed artifacts can support as a cautious experimental manuscript.",
        "That framing makes the baseline, result table, and limitations central from the first page."
      ]
    ],
    conclusion: [
      [
        "The final takeaway is therefore deliberately narrow.",
        primaryComparison
          ? "The current run documents the declared comparison and its direction-aware interpretation as a bounded follow-up signal."
          : "The current artifacts do not select a follow-up series because no primary comparison is resolved.",
        "It should not be read as closing the broader research question without the larger follow-up study described in the limitations."
      ]
    ]
  };
  const groups = sentencesByHeading[normalizeHeading(heading)] || sentencesByHeading.results;
  const selected = groups[variant % groups.length];
  const angleSentences = [
    "The emphasis remains on evidence that is inspectable in the current run.",
    "This paragraph is retained in the main body because it clarifies the claim boundary rather than adding a new claim.",
    "The wording is deliberately scoped so that a reader can separate completed evidence from future work.",
    "The same point would need to be revised if later artifacts changed the comparator, table, or execution status.",
    "This keeps the main text dense enough for review while still avoiding unsupported extrapolation.",
    "The paragraph also makes the audit trail visible instead of relying on polish as a proxy for readiness.",
    "The scope is constrained to the present artifacts, which is why the discussion remains useful without becoming overbroad.",
    "This gives the reader enough context to interpret the reported numbers as bounded evidence."
  ];
  const text = cleanString([...selected, angleSentences[variant % angleSentences.length]].join(" "));
  return {
    text,
    evidence_ids: evidenceIds.slice(0, 4),
    citation_paper_ids: citationPaperIds.slice(0, 4)
  };
}

function buildSectionParagraphCandidates(
  heading: string,
  bundle: PaperWritingBundle,
  context: ExperimentArtifactContext,
  expanded = false,
  expansionPass = 1
): PaperDraftParagraph[] {
  switch (normalizeHeading(heading)) {
    case "introduction":
      return buildParagraphsFromSentences(
        [
          [
            `This study addresses ${bundle.topic}.`,
            context.results.aggregate_summary[0] || "",
            bundle.objectiveMetric ? `The paper is scoped around ${bundle.objectiveMetric}.` : ""
          ],
          [
            `The main gap is that current artifacts often expose headline outcomes without a venue-aware writing structure that separates core claims from supporting detail.`,
            bundle.hypotheses[0]?.text ? `The working hypothesis is that ${lowercaseLeading(bundle.hypotheses[0].text)}.` : "",
            expanded ? `The contribution is therefore to present a denser, evidence-first empirical narrative rather than a short results summary.` : ""
          ],
          expanded && expansionPass >= 4
            ? [
                "The motivation is deliberately practical: bounded empirical screens often need to decide whether a declared subject deserves a larger run before the project can afford broader series and evaluation coverage.",
                "For that reason, the paper treats the executed comparison as a decision-quality preflight rather than as a final generalization claim, and it keeps the baseline, uncertainty, and failed-run visibility in the main narrative."
              ]
            : [],
          expanded && expansionPass >= 5
            ? [
                "This framing also explains why the manuscript spends space on protocol and audit details.",
                "A short positive result would be easier to read but less useful scientifically if readers could not separate completed evidence, missing evidence, and follow-up claims that remain outside the current run."
              ]
            : []
        ].filter((item) => item.length > 0),
        inferSectionEvidenceIds(undefined, bundle),
        inferSectionCitationIds(undefined, bundle)
      );
    case "related work":
      return buildParagraphsFromSentences(
        [
          [
            safeRelatedWorkClusters(context).length > 0
              ? `Related work clusters around ${joinHumanList(safeRelatedWorkClusters(context).slice(0, 4))}.`
              : "Related work spans multiple nearby empirical and systems-oriented strands.",
            buildRelatedWorkAxisSentence(context)
          ],
          [
            buildClosestCitedWorkSentence(context),
            `The present paper positions itself around ${describeScientificObjectiveForNarrative(bundle.objectiveMetric)} while keeping claims limited to the available artifacts.`
          ],
          expanded
            ? [
                "This positioning is intentionally narrower than a broad novelty claim: it clarifies where the current study overlaps with prior baselines and where evidence remains thin.",
                "For this manuscript, the cited literature supplies positioning anchors rather than direct numerical baselines. The declared reference series remains the comparison of record inside the executed run, while prior work defines the methodological and evaluation questions that make the scoped experiment scientifically interpretable.",
                "This separation keeps the contribution modest but clearer. The paper can argue that the executed comparison is a useful evidence filter for the stated research question, while avoiding claims that would require broader series coverage, a different evaluation scope, or direct reproduction of the cited methods."
              ]
            : [],
          expanded && expansionPass >= 4
            ? [
                "The prior-work role is therefore twofold: it defines why the chosen axes matter, and it prevents the manuscript from using external citations as if they were direct evidence for the current numerical comparison.",
                "That distinction is important for paper readiness because related work can justify the question and design, but only the executed artifacts can support claims about the present comparison."
              ]
            : []
        ].filter((item) => item.length > 0),
        inferSectionEvidenceIds(undefined, bundle),
        inferSectionCitationIds(undefined, bundle)
      );
    case "method":
      return buildParagraphsFromSentences(
        [
          [
            context.method.dataset_names.length > 0
              ? `The evaluation spans ${joinHumanList(context.method.dataset_names)}.`
              : "The evaluation dataset scope is not yet fully specified in upstream artifacts.",
            context.method.model_names.length > 0
              ? `Declared result series include ${joinHumanList(context.method.model_names.slice(0, 4))}.`
              : ""
          ],
          [
            context.method.preprocessing_steps.length > 0
              ? `Preprocessing follows this order: ${joinHumanList(context.method.preprocessing_steps.slice(0, 4))}.`
              : "Preprocessing details remain limited in the current artifacts and should be read conservatively.",
            context.method.selection_metrics.length > 0
              ? `Selection and reporting focus on ${joinHumanList(context.method.selection_metrics.slice(0, 4))}.`
              : "Selection and reporting metrics remain partially specified in the current artifacts."
          ],
          [
            context.method.outer_fold_notes.length > 0 || context.method.inner_fold_notes.length > 0 || context.method.repeat_notes.length > 0
              ? `The protocol records ${joinHumanList([
                  ...context.method.outer_fold_notes,
                  ...context.method.inner_fold_notes,
                  ...context.method.repeat_notes
                ].slice(0, 4))}.`
              : "Repetition details remain partially specified in the current artifacts.",
            context.method.runtime_measurement || context.method.memory_measurement
              ? `Runtime${context.method.memory_measurement ? " and memory" : ""} are explicitly measured in the evaluation outputs.`
              : ""
          ],
          expanded
            ? [
                context.method.hyperparameter_notes.length > 0
                  ? `Search-space notes retained for the appendix include ${joinHumanList(context.method.hyperparameter_notes.slice(0, 3))}.`
                  : "Hyperparameter search details remain limited and are surfaced cautiously."
              ]
            : [],
          expanded && expansionPass >= 2
            ? [
                "The declared subject and reference observations are the comparison unit: their series roles, metric, scope, and signed difference are linked explicitly rather than selected from observed values.",
                context.method.repeat_notes.length > 0
                  ? `The preserved protocol notes ${joinHumanList(context.method.repeat_notes.slice(0, 3))}, so the method description distinguishes the planned budget from the executed repeated comparison.`
                  : "The method description separates the planned budget from the executed comparison so readers can see which claims depend on completed runs."
              ]
            : [],
          expanded && expansionPass >= 3
            ? [
                context.method.runtime_measurement || context.method.memory_measurement
                  ? "Resource instrumentation is included as a reproducibility and feasibility check, not as a primary efficiency claim; this keeps the manuscript from converting auxiliary logs into unsupported series-level conclusions."
                  : "Auxiliary protocol details are reported only when they are visible in the run artifacts, and omitted quantities are treated as limitations rather than inferred measurements."
              ]
            : [],
          expanded && expansionPass >= 4
            ? [
                "The method also fixes the interpretation boundary around the repeated comparison: the same declared scope, metric definition, and reference accounting are used to make the primary comparison auditable.",
                "This detail is retained in the main text because paper readiness depends on readers being able to distinguish the experimental unit, the comparison unit, and the downstream follow-up that remains unexecuted."
              ]
            : []
        ].filter((item) => item.length > 0),
        inferSectionEvidenceIds(undefined, bundle),
        inferSectionCitationIds(undefined, bundle)
      );
    case "results":
      return buildParagraphsFromSentences(
        [
          [context.results.aggregate_summary[0] || "The main empirical story remains grounded in the reported objective-oriented evaluation."],
          context.results.dataset_summaries[0]
            ? [context.results.dataset_summaries[0].summary]
            : [],
          context.results.dataset_summaries[1]
            ? [context.results.dataset_summaries[1].summary]
            : context.results.heterogeneity_notes[0]
              ? [context.results.heterogeneity_notes[0]]
              : [],
          [
            context.results.dispersion_notes[0] || context.results.ci_notes[0] || context.results.ci_unavailable_reason || "",
            context.results.runtime_notes[0] || "",
            context.results.memory_notes[0] || "",
            expanded && context.results.effect_notes[0] ? context.results.effect_notes[0] : ""
          ],
          ...(expanded && expansionPass >= 2
            ? [
                [
                  context.results.primary_comparison
                    ? "The main table preserves the declared subject/reference observation links, series roles, metric direction, unit, and signed difference."
                    : "No directional comparison table is generated while the primary comparison remains unresolved.",
                  context.results.aggregate_summary[0] || "",
                  "This presentation prevents an undeclared or value-selected series from being promoted into a universal recipe."
                ],
                [
                  context.results.runtime_notes[0] || context.results.memory_notes[0]
                    ? `Operational measurements remain secondary: ${joinHumanList([context.results.runtime_notes[0] || "", context.results.memory_notes[0] || ""].filter(Boolean))}.`
                    : "Operational measurements are retained as execution checks rather than as evidence for an efficiency ranking.",
                  "That distinction matters because execution evidence does not determine a resource-efficiency ranking between the declared series."
                ]
              ]
            : []),
          ...(expanded && expansionPass >= 3
            ? [
                [
                  context.results.effect_notes[0] ||
                    "The observed effect is interpreted as a baseline-relative screening signal.",
                  context.results.heterogeneity_notes[0] ||
                    "The current contract does not expose linked heterogeneity evidence, so no uniformity claim is made.",
                  "The manuscript therefore separates the empirical selection signal from the stronger mechanistic claim that would require a broader interaction analysis."
                ]
              ]
            : []),
          ...(expanded && expansionPass >= 4
            ? [
                [
                  context.results.primary_comparison
                    ? "The important unit is the explicitly linked subject/reference pair rather than a favorable observation selected after execution."
                    : "The available artifact does not define a primary subject/reference pair for directional interpretation.",
                  "The table and figure are therefore used as complementary checks: the table anchors the numeric values, while the figure is retained only when it shows a distinct pattern that is not already obvious from the rows."
                ],
                [
                  "The result is also reported with an explicit non-result: the present artifacts do not justify a broad claim about all factor values or downstream tasks.",
                  "That negative boundary is part of the contribution because it prevents an empirical preflight from being mistaken for a completed scaling study."
                ]
              ]
            : [])
        ].filter((item) => item.length > 0),
        inferSectionEvidenceIds(undefined, bundle),
        inferSectionCitationIds(undefined, bundle)
      );
    case "discussion":
      return buildParagraphsFromSentences(
        [
          [
            context.discussion.discussion_points[0] ||
              "The reported outcomes should be interpreted as bounded evidence rather than a universal win.",
            context.results.effect_notes[0] || ""
          ],
          [
            context.discussion.practical_implications[0] ||
              "In practical terms, the current evidence is most useful as a benchmark or reproducibility note rather than a broad method claim.",
            expanded && context.results.heterogeneity_notes[0] ? context.results.heterogeneity_notes[0] : ""
          ],
          expanded && expansionPass >= 2
            ? [
                "For a bounded experiment, the strongest defensible use of the result is triage: it can identify a declared subject worth carrying into a larger run, but it cannot establish a general method law.",
                context.results.effect_notes[0] || ""
              ]
            : [],
          expanded && expansionPass >= 2
            ? [
                "The claim ceiling is therefore central to the interpretation.",
                "A resolved primary link, its signed difference, and the declared metric direction jointly determine the bounded interpretation; stronger statements about robustness, mechanism, or broad transfer remain outside the available evidence."
              ]
            : [],
          expanded && expansionPass >= 3
            ? [
                context.discussion.practical_implications[1] ||
                  "A practical next step is to repeat the same declared comparison with broader series coverage, a broader evaluation scope, and the same failed-run visibility requirements.",
                "That follow-up would test whether the present signal survives scale and task variation instead of merely reflecting this local preflight."
              ]
            : [],
          expanded && expansionPass >= 4
            ? [
                "The audit trail matters for this interpretation because the paper-ready claim depends on alignment between executed runs, result tables, captions, and the claim-evidence map.",
                "If a later run changes the baseline, hides failed executions, or moves numeric support out of the main table, the same text should be downgraded rather than reused as a stronger manuscript."
              ]
            : []
        ],
        inferSectionEvidenceIds(undefined, bundle),
        inferSectionCitationIds(undefined, bundle)
      );
    case "limitations": {
      const baseSentences: string[][] = [
        [
          context.discussion.limitations[0] ||
            "The current paper is limited by the granularity of upstream artifacts and the scope of the available evaluation traces.",
          context.results.ci_unavailable_reason || ""
        ]
      ];

      const gateWarnings = bundle.gateWarnings ?? [];
      if (gateWarnings.length > 0) {
        baseSentences.push(buildGateWarningLimitationSentences(gateWarnings));
      }
      if (expanded && expansionPass >= 2) {
        baseSentences.push([
          "The evaluation scope is narrow, so conclusions should be limited to the declared series, scopes, metrics, and resource budget.",
          "This limitation is methodological rather than cosmetic because the same hyperparameter choice could behave differently under a larger training budget or a different evaluation suite."
        ]);
      }
      if (expanded && expansionPass >= 3) {
        baseSentences.push([
          context.results.ci_notes[0] || context.results.dispersion_notes[0] || "Uncertainty remains a material part of the result.",
          "The paper therefore avoids significance language and treats the declared subject as a follow-up candidate unless a later study reproduces the direction with tighter intervals."
        ]);
      }
      if (expanded && expansionPass >= 4) {
        baseSentences.push([
          "The evidence ceiling also constrains related-work claims: external papers motivate the comparison, but they are not substitutes for direct reproduction under the present budget.",
          "Consequently, the manuscript avoids saying that the observed interaction is a general method-family property, and instead reports the narrower empirical signal visible in the completed artifacts."
        ]);
      }

      return buildParagraphsFromSentences(
        baseSentences,
        inferSectionEvidenceIds(undefined, bundle),
        inferSectionCitationIds(undefined, bundle)
      );
    }
    case "conclusion":
      return buildParagraphsFromSentences(
        [
          [
            "The paper therefore keeps execution coverage and supplementary metrics secondary to the visible baseline-relative comparison.",
            "The main text interprets only the comparison and evaluation scope that are visible in the presented table and figure."
          ],
          expanded && expansionPass >= 2
            ? [
                "The immediate conclusion is that the executed comparison is strong enough to guide a next experiment, not strong enough to close the broader scientific question.",
                "That distinction keeps the result useful without overstating the evidence ceiling."
              ]
            : [],
          expanded && expansionPass >= 3
            ? [
                "A paper-ready follow-up should preserve the same reference accounting and add broader scopes, more declared series, and explicit variance or interaction tests.",
                "Those additions would determine whether the preflight signal remains stable when the budget and evaluation scope expand."
              ]
            : [],
          expanded && expansionPass >= 4
            ? [
                "Until that follow-up exists, the manuscript's final claim is intentionally modest: the current run produces a useful, auditable candidate selection result under its stated constraints.",
                "That is a scientific result when reported with its reference, uncertainty, and limitations, but it remains a bounded preflight rather than a universal decision rule."
              ]
            : []
        ],
        inferSectionEvidenceIds(undefined, bundle),
        inferSectionCitationIds(undefined, bundle)
      );
    default:
      return [];
  }
}

export function buildGateWarningLimitationSentences(gateWarnings: GateWarningItem[]): string[] {
  // Group by category, ordered by severity (error > warning > info)
  const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2 };
  const sorted = [...gateWarnings].sort(
    (a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9)
  );

  const warningsByCategory = new Map<string, GateWarningItem[]>();
  for (const w of sorted) {
    const cat = w.category || "general";
    const existing = warningsByCategory.get(cat) ?? [];
    existing.push(w);
    warningsByCategory.set(cat, existing);
  }

  const sentences: string[] = [];
  for (const [category, items] of warningsByCategory) {
    if (items.length === 0) continue;
    const label = category.replace(/_/g, " ");
    const highestSeverity = items[0].severity || "warning";
    const msgSummary = items.map((i) => i.message).filter(Boolean).join("; ");
    if (msgSummary) {
      sentences.push(
        `[${highestSeverity}] ${label}: ${msgSummary}.`
      );
    }
  }
  return sentences.slice(0, 5);
}

export function applyGateWarningsToLimitations(
  draft: PaperDraft,
  gateWarnings: GateWarningItem[]
): PaperDraft {
  if (gateWarnings.length === 0) {
    return draft;
  }
  const sentences = buildGateWarningLimitationSentences(gateWarnings);
  if (sentences.length === 0) {
    return draft;
  }
  const warningParagraph: PaperDraftParagraph = {
    text: cleanString(sentences.join(" ")),
    evidence_ids: [],
    citation_paper_ids: []
  };
  const sections = draft.sections.map((section) => {
    if (normalizeHeading(section.heading) !== "limitations") {
      return section;
    }
    return {
      ...section,
      paragraphs: [...section.paragraphs, warningParagraph]
    };
  });
  return { ...draft, sections };
}

function buildPracticalImplications(
  bundle: PaperWritingBundle,
  primaryComparison: PrimaryComparisonSummary | undefined,
  canonicalResults: CanonicalResultsResolution
): string[] {
  if (!primaryComparison) {
    return [];
  }
  const implications: string[] = [];
  if (primaryComparison.directional_outcome === "favors_subject") {
    implications.push(
      `The declared primary comparison supports treating the subject series as a cautious follow-up candidate for ${bundle.topic}.`
    );
  } else if (primaryComparison.directional_outcome === "favors_reference") {
    implications.push(
      `The declared primary comparison does not support promoting the subject series for ${bundle.topic}; the reference series is preferred under the metric direction.`
    );
  } else {
    implications.push(
      `The declared primary comparison is neutral at the reported precision and does not select either series for ${bundle.topic}.`
    );
  }
  const hasResourceMeasurement = collectCanonicalResourceNotes(canonicalResults, "runtime").length > 0
    || collectCanonicalResourceNotes(canonicalResults, "memory").length > 0;
  if (hasResourceMeasurement) {
    implications.push(
      "Practical adoption should weigh the declared primary outcome against the separately reported runtime or memory observations."
    );
  }
  return uniqueStrings(implications).slice(0, 3);
}

function collectCanonicalResultSummaries(
  primaryComparison: PrimaryComparisonSummary | undefined
): DatasetResultSummary[] {
  if (!primaryComparison) {
    return [];
  }
  const scopeLabel = formatCanonicalScope(primaryComparison.subject.scope);
  return [
    {
      dataset: scopeLabel,
      label: `${primaryComparison.subject.series_label} versus ${primaryComparison.reference.series_label}`,
      main_metric_label: primaryComparison.metric_label,
      main_metric_value: primaryComparison.subject.value,
      delta_label: "subject-minus-reference difference",
      delta_value: primaryComparison.delta,
      heterogeneity_notes: [],
      summary: primaryComparison.summary
    }
  ];
}

function formatCanonicalScope(scope: Record<string, ResultsScalar>): string {
  const entries = Object.entries(scope).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return "declared evaluation scope";
  }
  return entries
    .map(([key, value]) => `${humanizeToken(key)}=${String(value)}`)
    .join(", ");
}

function collectCanonicalAggregateResults(
  resolution: CanonicalResultsResolution
): string[] {
  return resolution.primaryComparison ? [resolution.primaryComparison.summary] : [];
}

function collectCanonicalArtifactMetricFacts(
  resolution: CanonicalResultsResolution
): NormalizedNumericFact[] {
  const primaryComparison = resolution.primaryComparison;
  if (!primaryComparison) {
    return [];
  }
  const linkedObservationIds = new Set([
    primaryComparison.subject.observation_id,
    primaryComparison.reference.observation_id
  ]);
  const observationFacts = resolution.observations
    .filter((observation) => linkedObservationIds.has(observation.observation_id))
    .map((observation) =>
    buildStructuredNumericFact({
      factKind: "metric",
      source: "artifact",
      location: `artifact.results.observation.${observation.observation_id}`,
      rawText: `${observation.series_label} ${observation.metric_label} ${formatCanonicalMeasurement(observation.value, observation.metric_unit)}`,
      value: observation.value,
      metricKey: observation.metric_id,
      metricLabel: observation.metric_label,
      comparisonTarget: primaryComparison.subject.observation_id === observation.observation_id
        ? "subject"
        : "reference",
      datasetScope: formatCanonicalScope(observation.scope),
      aggregationLevel: Object.keys(observation.scope).length > 0 ? "dataset" : "aggregate",
      unit: canonicalNumericFactUnit(observation.metric_unit),
      sourceRefs: buildArtifactSourceRefs([
        `result_analysis.results_artifact.observation:${observation.observation_id}`
      ])
    })
  );
  const comparisonFacts = [
    buildStructuredNumericFact({
      factKind: "metric",
      source: "artifact",
      location: `artifact.results.comparison.${primaryComparison.comparison_id}`,
      rawText: `${primaryComparison.metric_label} subject-minus-reference difference ${formatCanonicalMeasurement(primaryComparison.delta, primaryComparison.metric_unit)}`,
      value: primaryComparison.delta,
      metricKey: primaryComparison.metric_id,
      metricLabel: `${primaryComparison.metric_label} subject-minus-reference difference`,
      comparisonTarget: "subject_minus_reference",
      datasetScope: formatCanonicalScope(primaryComparison.subject.scope),
      aggregationLevel: Object.keys(primaryComparison.subject.scope).length > 0 ? "dataset" : "aggregate",
      unit: "delta",
      sourceRefs: buildArtifactSourceRefs([
        `result_analysis.results_artifact.comparison:${primaryComparison.comparison_id}`,
        `result_analysis.results_plan.primary_comparison_id:${primaryComparison.comparison_id}`
      ])
    })
  ];
  return dedupeNumericFacts([...observationFacts, ...comparisonFacts]);
}

function canonicalNumericFactUnit(metricUnit: string | undefined): NumericFactUnit {
  const unit = normalizeMetricText(metricUnit || "");
  if (/\b(?:s|sec|secs|second|seconds)\b/iu.test(unit)) {
    return "seconds";
  }
  if (/\b(?:mb|mib|megabyte|megabytes)\b/iu.test(unit)) {
    return "mb";
  }
  return "score";
}

function canonicalUnitMatchesResource(
  metricUnit: string | undefined,
  resource: "runtime" | "memory"
): boolean {
  const unit = normalizeMetricText(metricUnit || "");
  return resource === "runtime"
    ? /\b(?:ms|millisecond|milliseconds|s|sec|secs|second|seconds|minute|minutes|hour|hours)\b/iu.test(unit)
    : /\b(?:b|byte|bytes|kb|kib|kilobyte|kilobytes|mb|mib|megabyte|megabytes|gb|gib|gigabyte|gigabytes|tb|tib|terabyte|terabytes)\b/iu.test(unit);
}

function collectCanonicalResourceNotes(
  resolution: CanonicalResultsResolution,
  resource: "runtime" | "memory"
): string[] {
  const primaryComparison = resolution.primaryComparison;
  if (!primaryComparison) {
    return [];
  }
  const linkedObservationIds = new Set([
    primaryComparison.subject.observation_id,
    primaryComparison.reference.observation_id
  ]);
  return resolution.observations
    .filter((observation) =>
      linkedObservationIds.has(observation.observation_id)
      && canonicalUnitMatchesResource(observation.metric_unit, resource)
    )
    .map((observation) =>
      `${observation.series_label} ${observation.metric_label} is ${formatCanonicalMeasurement(observation.value, observation.metric_unit)}.`
    )
    .slice(0, 4);
}

function collectCanonicalEffectNotes(
  primaryComparison: PrimaryComparisonSummary | undefined
): string[] {
  return primaryComparison ? [primaryComparison.summary] : [];
}

function collectCiNotes(
  resultAnalysis: ResultAnalysisArtifact | undefined,
  primaryComparison: PrimaryComparisonSummary | undefined
): string[] {
  if (!primaryComparison) {
    return [];
  }
  const notes = uniqueStrings(
    (resultAnalysis?.statistical_summary?.confidence_intervals || [])
      .filter((item) => item.metric_key === primaryComparison.metric_id)
      .map((item) => {
        const summary = cleanString(item.summary);
        if (summary) {
          return summary;
        }
        if (typeof item.lower !== "number" || typeof item.upper !== "number") {
          return "";
        }
        return `The ${formatConfidenceLevel(item.level)} interval for ${primaryComparison.metric_label} spans ${formatNumber(item.lower)} to ${formatNumber(item.upper)}.`;
      })
      .filter(Boolean)
  );
  return notes.slice(0, 4);
}

function formatConfidenceLevel(value: unknown): string {
  const level = asNumber(value);
  if (typeof level !== "number") {
    return "reported";
  }
  return level <= 1 ? `${formatNumber(level * 100)}%` : `${formatNumber(level)}%`;
}

function buildCiUnavailableReason(
  primaryComparison: PrimaryComparisonSummary
): string {
  return `Confidence intervals are unavailable because no interval is linked to primary metric "${primaryComparison.metric_id}".`;
}

function collectCanonicalMetricLabels(artifact: ResultsArtifactV2 | undefined): string[] {
  if (!artifact) {
    return [];
  }
  return artifact.metrics.map((metric) =>
    `${metric.label} (${humanizeMetricDirection(metric.direction)}; unit: ${metric.unit})`
  );
}

function collectCanonicalSeriesLabels(artifact: ResultsArtifactV2 | undefined): string[] {
  if (artifact) {
    return artifact.series.map((series) =>
      series.role ? `${series.label} (${series.role} role)` : series.label
    );
  }
  return [];
}

function hasCanonicalResourceMetric(
  artifact: ResultsArtifactV2 | undefined,
  resource: "runtime" | "memory"
): boolean {
  return Boolean(artifact?.metrics.some((metric) =>
    canonicalUnitMatchesResource(metric.unit, resource)));
}

function collectSeeds(parsedPlan: Record<string, unknown>, latestResults: Record<string, unknown>): number[] {
  const protocol = asRecord(latestResults.protocol);
  return uniqueNumbers([
    ...asNumberArray(protocol.seed_schedule),
    ...collectNumbersFromText(JSON.stringify(parsedPlan), /\bseed(?:_schedule|s|)\D+(\d{1,9})/giu)
  ]);
}

function collectDatasetNames(
  bundle: PaperWritingBundle,
  parsedPlan: Record<string, unknown>,
  latestResults: Record<string, unknown>
): string[] {
  const selectedDesign = asRecord(parsedPlan.selected_design);
  const protocol = asRecord(latestResults.protocol);
  const runScopedNames = uniqueStrings([
    ...asStringArray(selectedDesign.datasets),
    ...asStringArray(protocol.datasets),
    ...asArray(latestResults.dataset_summaries)
      .map((item) => asString(asRecord(item).dataset))
      .filter((item): item is string => Boolean(item))
  ]);
  if (runScopedNames.length > 0) {
    return runScopedNames.slice(0, 10);
  }
  return uniqueStrings([
    ...bundle.evidenceRows.map((item) => item.dataset_slot).filter((item): item is string => Boolean(item)),
    ...bundle.paperSummaries.flatMap((item) => item.datasets || [])
  ]).slice(0, 10);
}

function collectDatasetSourceHints(parsedPlan: Record<string, unknown>, latestResults: Record<string, unknown>): string[] {
  const selectedDesign = asRecord(parsedPlan.selected_design);
  const protocol = asRecord(latestResults.protocol);
  return uniqueStrings([
    ...asStringArray(selectedDesign.dataset_sources),
    ...asStringArray(selectedDesign.data_sources),
    asString(selectedDesign.dataset_source) || "",
    asString(selectedDesign.data_source) || "",
    asString(protocol.dataset_source) || "",
    asString(protocol.data_source) || ""
  ]).filter(Boolean).slice(0, 4);
}
function collectSampleSizeHints(
  parsedPlan: Record<string, unknown>,
  latestResults: Record<string, unknown>,
  resultAnalysis?: ResultAnalysisArtifact
): string[] {
  const selectedDesign = asRecord(parsedPlan.selected_design);
  const protocol = asRecord(latestResults.protocol);
  return uniqueStrings([
    ...collectNumbersAsNotes(selectedDesign, ["n_samples", "sample_size", "row_count", "num_train_samples"]),
    ...collectNumbersAsNotes(protocol, ["n_samples", "sample_size", "row_count", "num_train_samples"]),
    ...collectNumbersAsNotes(latestResults, ["n_samples", "sample_size", "row_count", "num_train_samples"]),
    ...collectNumbersAsNotes(resultAnalysis, ["sample_size", "total_count", "num_train_samples", "row_count"]),
    ...collectResultAnalysisSampleNotes(resultAnalysis),
    ...collectExecutedTrainingSampleNotes(latestResults)
  ]).slice(0, 6);
}
function collectResultAnalysisSampleNotes(resultAnalysis?: ResultAnalysisArtifact): string[] {
  const metrics = asRecord(resultAnalysis?.metrics);
  const runConfig = asRecord(metrics.run_config);
  const data = asRecord(metrics.data);
  const train = asRecord(data.train);
  const count = asNumber(train.count) ?? asNumber(runConfig.train_samples);
  return typeof count === "number" && count > 0
    ? [`Run metadata records ${formatNumber(count)} training examples for the inspected analysis record.`]
    : [];
}

function collectFeatureHints(parsedPlan: Record<string, unknown>, latestResults: Record<string, unknown>): string[] {
  return uniqueStrings([
    ...collectKeywordNotes(parsedPlan, ["features", "feature count", "columns"]),
    ...collectNumbersAsNotes(latestResults, ["n_features", "feature_count", "num_features"])
  ]).slice(0, 4);
}

function collectClassHints(parsedPlan: Record<string, unknown>, latestResults: Record<string, unknown>): string[] {
  return uniqueStrings([
    ...collectKeywordNotes(parsedPlan, ["classes", "labels", "class count"]),
    ...collectNumbersAsNotes(latestResults, ["n_classes", "class_count", "num_classes"])
  ]).slice(0, 4);
}

function collectPreprocessingSteps(parsedPlan: Record<string, unknown>): string[] {
  const selectedDesign = asRecord(parsedPlan.selected_design);
  return uniqueStrings([
    ...asStringArray(selectedDesign.implementation_notes).filter((item) => /normalize|standardize|preprocess|tokeniz|imput|scale|encode|clean|dedupe|data order|token budget|evaluation harness/iu.test(item)),
    ...collectKeywordNotes(parsedPlan, [
      "normalize",
      "standardize",
      "preprocess",
      "imput",
      "scale",
      "encode",
      "clean",
      "token budget",
      "training example order",
      "evaluation harness"
    ])
  ]).slice(0, 6);
}

function collectFoldNotes(parsedPlan: Record<string, unknown>, kind: "outer" | "inner"): string[] {
  const selectedDesign = asRecord(parsedPlan.selected_design);
  return uniqueStrings([
    ...asStringArray(selectedDesign.evaluation_steps).filter((item) => new RegExp(`\\b${kind}\\b|${kind} fold`, "iu").test(item)),
    ...collectKeywordNotes(parsedPlan, [`${kind} fold`, `${kind} cv`, `${kind} loop`])
  ]).slice(0, 4);
}

function collectRepeatNotes(parsedPlan: Record<string, unknown>, latestResults: Record<string, unknown>): string[] {
  const selectedDesign = asRecord(parsedPlan.selected_design);
  const protocol = asRecord(latestResults.protocol);
  const seedSchedule = asNumberArray(protocol.seed_schedule);
  const protocolRepeats = asNumber(protocol.repeats);
  const scheduledRepeatCount = seedSchedule.length > 1 ? seedSchedule.length : undefined;
  const protocolRepeatNote =
    typeof protocolRepeats === "number" && (!scheduledRepeatCount || protocolRepeats === scheduledRepeatCount)
      ? `${formatNumber(protocolRepeats)} repeated evaluations are available in the protocol.`
      : "";
  return uniqueStrings([
    ...(scheduledRepeatCount
      ? [`The protocol declares ${formatNumber(scheduledRepeatCount)} explicit seed(s).`]
      : []),
    ...asStringArray(selectedDesign.evaluation_steps).filter((item) => /repeat|seeded runs|rerun|multiple random seeds/iu.test(item)),
    protocolRepeatNote
  ]).filter(Boolean).slice(0, 4);
}

function collectHyperparameterNotes(
  parsedPlan: Record<string, unknown>,
  latestResults: Record<string, unknown>,
  resultAnalysis?: ResultAnalysisArtifact
): string[] {
  const selectedDesign = asRecord(parsedPlan.selected_design);
  const metrics = asRecord(resultAnalysis?.metrics);
  return uniqueStrings([
    ...collectExecutedTrainingHyperparameterNotes(latestResults),
    ...collectResultAnalysisTrainingScaleNotes(resultAnalysis),
    ...collectRunConfigTrainingHyperparameterNotes(asRecord(latestResults.run_config), asRecord(latestResults.data)),
    ...collectRunConfigTrainingHyperparameterNotes(asRecord(metrics.run_config), asRecord(metrics.data)),
    ...asStringArray(selectedDesign.resource_notes).filter((item) => /grid|search|hyperparameter|sweep|tuning/iu.test(item)),
    ...collectKeywordNotes(parsedPlan, ["hyperparameter", "grid search", "random search", "bayesian search", "tuning"]),
    ...collectKeywordNotes(latestResults, ["hyperparameter", "grid", "search space"])
  ]).slice(0, 6);
}

function collectResultAnalysisTrainingScaleNotes(resultAnalysis?: ResultAnalysisArtifact): string[] {
  const rows = resultAnalysis?.metric_table || [];
  const trainingExampleCounts = uniqueNumbers(
    rows
      .filter((row) => /(?:^|[._])(?:num_train_samples|train_sample_count|training_example_count)$/iu.test(row.key))
      .map((row) => row.value)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  );
  const trainingTokenCounts = uniqueNumbers(
    rows
      .filter((row) => /(?:^|[._])(?:train_dataset_token_count|training_token_count)$/iu.test(row.key))
      .map((row) => row.value)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  );
  return [
    ...trainingExampleCounts.slice(0, 2).map((value) => `The recorded training-example count was ${formatNumber(value)}.`),
    ...trainingTokenCounts.slice(0, 2).map((value) => `The recorded training-token count was ${formatNumber(value)}.`)
  ];
}

function collectRunConfigTrainingHyperparameterNotes(
  runConfig: Record<string, unknown>,
  data: Record<string, unknown>
): string[] {
  const notes: string[] = [];
  const fixedSettings: string[] = [];
  const learningRate = asNumber(runConfig.learning_rate);
  const batchSize = asNumber(runConfig.per_device_batch_size) ?? asNumber(runConfig.per_device_train_batch_size);
  const gradientAccumulation = asNumber(runConfig.gradient_accumulation_steps) ?? asNumber(runConfig.gradient_accumulation);
  const maxSeqLength = asNumber(runConfig.max_seq_length);
  const maxSteps = asNumber(runConfig.max_steps) ?? asNumber(runConfig.optimizer_steps);
  const timeoutSec = asNumber(runConfig.timeout_sec);
  if (typeof learningRate === "number") {
    fixedSettings.push(`learning rate ${formatNumber(learningRate)}`);
  }
  if (typeof batchSize === "number") {
    fixedSettings.push(`per-device train batch size ${formatNumber(batchSize)}`);
  }
  if (typeof gradientAccumulation === "number") {
    fixedSettings.push(`gradient accumulation ${formatNumber(gradientAccumulation)}`);
  }
  if (typeof maxSeqLength === "number") {
    fixedSettings.push(`maximum sequence length ${formatNumber(maxSeqLength)}`);
  }
  if (typeof maxSteps === "number") {
    fixedSettings.push(`${formatNumber(maxSteps)} optimizer steps`);
  }
  if (typeof timeoutSec === "number") {
    fixedSettings.push(`${formatNumber(timeoutSec)}-second timeout`);
  }
  if (fixedSettings.length > 0) {
    notes.push(`Fixed training settings included ${joinHumanList(fixedSettings)}.`);
  }
  const train = asRecord(data.train);
  const trainCount = asNumber(train.count) ?? asNumber(runConfig.train_samples);
  if (typeof trainCount === "number") {
    notes.push(`Run metadata records ${formatNumber(trainCount)} training examples for the reported pilot.`);
  }
  return notes;
}

function collectExecutedTrainingHyperparameterNotes(latestResults: Record<string, unknown>): string[] {
  const trainMetadata = findFirstTrainMetadata(latestResults);
  if (!trainMetadata) {
    return [];
  }
  const trainerState = asRecord(trainMetadata.trainer_state);
  const notes: string[] = [];
  const targetModules = asStringArray(trainMetadata.selected_target_modules).slice(0, 8);
  if (targetModules.length > 0) {
    notes.push(`Target modules were ${joinHumanList(targetModules)}.`);
  }

  const fixedSettings: string[] = [];
  const learningRate = asNumber(trainerState.learning_rate);
  const batchSize = asNumber(trainerState.per_device_train_batch_size);
  const gradientAccumulation = asNumber(trainerState.gradient_accumulation_steps) ?? asNumber(trainMetadata.gradient_accumulation_steps);
  const weightDecay = asNumber(trainerState.weight_decay);
  const maxGradNorm = asNumber(trainerState.max_grad_norm);
  const optimizerSteps = asNumber(trainerState.optimizer_steps) ?? asNumber(trainMetadata.optimizer_steps);
  if (typeof learningRate === "number") {
    fixedSettings.push(`learning rate ${formatNumber(learningRate)}`);
  }
  if (typeof batchSize === "number") {
    fixedSettings.push(`per-device train batch size ${formatNumber(batchSize)}`);
  }
  if (typeof gradientAccumulation === "number") {
    fixedSettings.push(`gradient accumulation ${formatNumber(gradientAccumulation)}`);
  }
  if (typeof weightDecay === "number") {
    fixedSettings.push(`weight decay ${formatNumber(weightDecay)}`);
  }
  if (typeof maxGradNorm === "number") {
    fixedSettings.push(`max gradient norm ${formatNumber(maxGradNorm)}`);
  }
  if (typeof optimizerSteps === "number") {
    fixedSettings.push(`${formatNumber(optimizerSteps)} optimizer steps`);
  }
  if (fixedSettings.length > 0) {
    notes.push(`Fixed training settings included ${joinHumanList(fixedSettings)}.`);
  }

  const trainSamples = asNumber(trainMetadata.num_train_samples);
  const trainTokens = asNumber(trainMetadata.train_dataset_token_count);
  if (typeof trainSamples === "number" || typeof trainTokens === "number") {
    notes.push(
      `Run metadata records ${typeof trainSamples === "number" ? `${formatNumber(trainSamples)} training examples` : "training examples"}${typeof trainSamples === "number" && typeof trainTokens === "number" ? " and " : ""}${typeof trainTokens === "number" ? `a training-token count of ${formatNumber(trainTokens)}` : ""} for the inspected seed-level record.`
    );
  }
  return notes;
}

function collectExecutedTrainingSampleNotes(latestResults: Record<string, unknown>): string[] {
  const trainMetadata = findFirstTrainMetadata(latestResults);
  if (!trainMetadata) {
    return [];
  }
  const notes: string[] = [];
  const trainSamples = asNumber(trainMetadata.num_train_samples);
  const trainTokens = asNumber(trainMetadata.train_dataset_token_count);
  if (typeof trainSamples === "number") {
    notes.push(`Run metadata records ${formatNumber(trainSamples)} training examples for the inspected execution record.`);
  }
  if (typeof trainTokens === "number") {
    notes.push(`Run metadata records a training-token count of ${formatNumber(trainTokens)} for the inspected execution record.`);
  }
  return notes;
}

function findFirstTrainMetadata(latestResults: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = asRecord(latestResults.train_metadata);
  if (Object.keys(direct).length > 0) {
    return direct;
  }
  for (const seedResult of asArray(latestResults.seed_results)) {
    const trainMetadata = asRecord(asRecord(seedResult).train_metadata);
    if (Object.keys(trainMetadata).length > 0) {
      return trainMetadata;
    }
  }
  return undefined;
}

function rewriteTextForClaimStrength(
  text: string,
  context: ExperimentArtifactContext,
  rewrites: ClaimStrengthRewrite[]
): string {
  let next = cleanString(text);
  if (!next) {
    return text;
  }

  const hasCi = context.results.ci_notes.length > 0;
  const hasReproArtifact = context.reproducibility.has_artifact;
  const hasRuntimeMemory = context.method.runtime_measurement || context.method.memory_measurement;
  const hasNoveltySupport = context.related_work.closest_titles.length > 0;

  const replace = (
    pattern: RegExp,
    replacement: string,
    category: ClaimStrengthRewrite["category"],
    reason: string
  ) => {
    const before = next;
    next = next.replace(pattern, replacement);
    if (next !== before) {
      rewrites.push({ category, before, after: next, reason });
    }
  };

  if (!hasCi) {
    replace(/\bsignificant improvement\b/giu, "a positive delta under this benchmark", "performance", "no interval or inferential support");
    replace(/\bdemonstrates improvement\b/giu, "suggests a positive delta under this benchmark", "performance", "headline improvement exceeds available statistical support");
  }
  if (!hasReproArtifact) {
    replace(/\breproducibility requirement satisfied\b/giu, "some reproducibility-oriented evidence is available, although supporting artifacts remain limited", "reproducibility", "reproducibility claim lacks explicit artifact support");
    replace(/\bfully reproducible\b/giu, "partially documented for reproducibility", "reproducibility", "reproducibility artifact set is incomplete");
  }
  if (!hasRuntimeMemory) {
    replace(
      /(?<![-\w])efficient\b/giu,
      "computationally practical within the reported setup",
      "efficiency",
      "efficiency claim lacks runtime/memory backing"
    );
  }
  if (!hasNoveltySupport) {
    replace(/\bnovel\b/giu, "distinct within the currently analyzed comparison set", "novelty", "novelty claim lacks closest-prior comparison support");
  }
  if (/robust|stable|stability/iu.test(next) && context.results.dispersion_notes.length === 0) {
    replace(/\brobust\b/giu, "reasonably consistent in the available runs", "robustness", "robustness claim lacks explicit dispersion evidence");
    replace(/\bstable\b/giu, "relatively consistent", "robustness", "stability claim lacks explicit dispersion evidence");
  }

  return next;
}

function buildParagraphsFromSentences(
  sentenceGroups: string[][],
  evidenceIds: string[],
  citationPaperIds: string[]
): PaperDraftParagraph[] {
  return sentenceGroups
    .map((sentences) => cleanString(sentences.filter(Boolean).join(" ")))
    .filter(Boolean)
    .map((text) => ({
      text,
      evidence_ids: evidenceIds.slice(0, 4),
      citation_paper_ids: citationPaperIds.slice(0, 4)
    }));
}

function collectKeywordNotes(value: unknown, keywords: string[]): string[] {
  const haystack = JSON.stringify(value);
  return keywords
    .filter((keyword) => new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").test(haystack))
    .map((keyword) => `Artifact text references ${keyword}.`);
}

function collectNumbersAsNotes(value: unknown, keys: string[]): string[] {
  const notes: string[] = [];
  for (const key of keys) {
    const matches = collectNumbersFromText(JSON.stringify(value), new RegExp(`${key}"?\\s*[:=]\\s*(\\d+(?:\\.\\d+)?)`, "giu"));
    for (const match of matches) {
      notes.push(`${humanizeToken(key)}=${formatNumber(match)}.`);
    }
  }
  return uniqueStrings(notes);
}

function collectNumbersFromText(text: string, pattern: RegExp): number[] {
  const matches: number[] = [];
  let match = pattern.exec(text);
  while (match) {
    const value = Number.parseFloat(match[1] || "");
    if (Number.isFinite(value)) {
      matches.push(value);
    }
    match = pattern.exec(text);
  }
  return matches;
}

function parsePlanYaml(raw: string | undefined): Record<string, unknown> {
  const text = cleanString(raw);
  if (!text) {
    return {};
  }
  try {
    return asRecord(YAML.parse(raw || ""));
  } catch {
    return {};
  }
}

function sortDraftSections(sections: PaperDraftSection[]): PaperDraftSection[] {
  const order = new Map(SECTION_BUDGET_WEIGHTS.map((item, index) => [normalizeHeading(item.heading), index] as const));
  return sections
    .slice()
    .sort((left, right) => (order.get(normalizeHeading(left.heading)) ?? 999) - (order.get(normalizeHeading(right.heading)) ?? 999));
}

function sortManuscriptSections(sections: PaperManuscriptSection[]): PaperManuscriptSection[] {
  const order = new Map(SECTION_BUDGET_WEIGHTS.map((item, index) => [normalizeHeading(item.heading), index] as const));
  return sections
    .slice()
    .sort((left, right) => (order.get(normalizeHeading(left.heading)) ?? 999) - (order.get(normalizeHeading(right.heading)) ?? 999));
}

function estimateManuscriptMainWords(manuscript: PaperManuscript): number {
  return manuscript.sections.reduce(
    (total, section) => total + section.paragraphs.reduce((sectionTotal, paragraph) => sectionTotal + wordCount(paragraph), 0),
    0
  );
}

function paragraphFingerprint(text: string): string {
  return cleanString(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/u).slice(0, 18).join(" ");
}

function mergeSourceRefs(existing: PaperSourceRef[] | undefined, additions: PaperSourceRef[]): PaperSourceRef[] | undefined {
  const refs: PaperSourceRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...(existing || []), ...additions]) {
    const key = `${ref.kind}:${ref.id}`;
    if (!ref.id || seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push(ref);
  }
  return refs.length > 0 ? refs : undefined;
}

function inferSectionEvidenceIds(draft: PaperDraft | undefined, bundle: PaperWritingBundle): string[] {
  return uniqueStrings([
    ...(draft?.sections.flatMap((section) => section.evidence_ids) || []),
    ...bundle.evidenceRows.slice(0, 4).map((item) => item.evidence_id)
  ]).filter(Boolean).slice(0, 4);
}

function inferSectionCitationIds(draft: PaperDraft | undefined, bundle: PaperWritingBundle): string[] {
  return uniqueStrings([
    ...(draft?.sections.flatMap((section) => section.citation_paper_ids) || []),
    ...bundle.paperSummaries.slice(0, 4).map((item) => item.paper_id),
    ...(bundle.relatedWorkNotes || []).slice(0, 4).map((item) => item.paper_id)
  ]).filter(Boolean).slice(0, 4);
}

function dedupeParagraphs(paragraphs: PaperDraftParagraph[]): PaperDraftParagraph[] {
  const seen = new Set<string>();
  const unique: PaperDraftParagraph[] = [];
  for (const paragraph of paragraphs) {
    const key = cleanString(paragraph.text).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(paragraph);
  }
  return unique;
}

function estimateDraftWords(sections: Pick<PaperDraftSection, "paragraphs">[]): number {
  return sections.reduce((total, section) => total + estimateParagraphWords(section.paragraphs), 0);
}

function estimateParagraphWords(paragraphs: Array<{ text: string }>): number {
  return paragraphs.reduce((total, paragraph) => total + wordCount(paragraph.text), 0);
}

function wordCount(text: string): number {
  return cleanString(text).split(/\s+/u).filter(Boolean).length;
}

function findSection<T extends { heading: string }>(sections: T[], heading: string): T | undefined {
  return sections.find((section) => normalizeHeading(section.heading) === normalizeHeading(heading));
}

function buildSectionSourceRefs(section: PaperDraftSection, claims: PaperDraftClaim[]): PaperSourceRef[] | undefined {
  const refs = [
    ...(section.evidence_ids || []).map((id) => ({ kind: "evidence" as const, id })),
    ...collectClaimIdsForSection(claims, section.heading).map((id) => ({ kind: "claim" as const, id })),
    ...(section.citation_paper_ids || []).map((id) => ({ kind: "citation" as const, id }))
  ];
  return refs.length > 0 ? refs : undefined;
}

function buildArtifactSourceRefs(ids: string[]): PaperSourceRef[] | undefined {
  const refs = uniqueStrings(ids).map((id) => ({ kind: "artifact" as const, id }));
  return refs.length > 0 ? refs : undefined;
}

function collectClaimIdsForSection(claims: PaperDraftClaim[], heading: string | undefined): string[] {
  const normalized = normalizeHeading(heading || "");
  if (!normalized) {
    return [];
  }
  return uniqueStrings(
    claims
      .filter((claim) => normalizeHeading(claim.section_heading) === normalized)
      .map((claim) => claim.claim_id)
  );
}

function getSectionText(sections: PaperManuscriptSection[], heading: string): string {
  return findSection(sections, heading)?.paragraphs.join(" ") || "";
}

function difference(left: number | undefined, right: number | undefined): number | undefined {
  if (typeof left !== "number" || typeof right !== "number") {
    return undefined;
  }
  return roundMetric(left - right);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function pushFieldStatus(
  present: string[],
  missing: string[],
  satisfied: boolean,
  label: string
): void {
  if (satisfied) {
    present.push(label);
    return;
  }
  missing.push(label);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => cleanString(item)).filter(Boolean))];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((item) => Number.isFinite(item)).map((item) => Number(item)))];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  return asArray(value).map((item) => asString(item)).filter((item): item is string => Boolean(item));
}

function asNumberArray(value: unknown): number[] {
  return asArray(value)
    .map((item) => asNumber(item))
    .filter((item): item is number => typeof item === "number");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function isSafeMetricLabel(value: string): boolean {
  const cleaned = cleanString(value);
  return Boolean(cleaned) && !/\.(json|svg|txt|log)\b/iu.test(cleaned) && !/^(metrics|confirmatory_metrics|quick_check_metrics)$/iu.test(cleaned);
}

function firstSentence(value: string | undefined): string {
  const text = cleanString(value);
  if (!text) {
    return "";
  }
  const match = text.match(/^(.+?[.!?])(?:\s|$)/u);
  return match?.[1] || text;
}

function normalizeHeading(value: string): string {
  return cleanString(value).toLowerCase();
}

function joinHumanList(values: string[]): string {
  const cleaned = uniqueStrings(values);
  if (cleaned.length === 0) {
    return "";
  }
  if (cleaned.length === 1) {
    return cleaned[0];
  }
  if (cleaned.length === 2) {
    return `${cleaned[0]} and ${cleaned[1]}`;
  }
  return `${cleaned.slice(0, -1).join(", ")}, and ${cleaned[cleaned.length - 1]}`;
}

function humanizeToken(value: string): string {
  return cleanString(value)
    .replace(/[_./]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function lowercaseLeading(value: string): string {
  const cleaned = cleanString(value);
  if (!cleaned) {
    return "";
  }
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function formatNumber(value: number | undefined): string {
  if (typeof value !== "number") {
    return "n/a";
  }
  return Number(value.toFixed(4)).toString();
}

function includesWord(haystack: string, needle: string): boolean {
  const text = cleanString(haystack).toLowerCase();
  const token = cleanString(needle).toLowerCase();
  return token.length > 0 && text.includes(token);
}
