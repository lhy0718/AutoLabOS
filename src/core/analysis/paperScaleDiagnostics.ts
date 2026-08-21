import type {
  AnalysisReport,
  AnalysisStatisticalSummary
} from "../resultAnalysis.js";
import {
  validateEvidenceAdequacyAssessment,
  type EvidenceAdequacyAssessmentV2
} from "./evidenceAdequacy.js";
import {
  validateResultsArtifactV2,
  type ResultsArtifactV2,
  type ResultsComparisonV2,
  type ResultsMetricDefinitionV2,
  type ResultsObservationV2,
  type ResultsSeriesV2
} from "./resultsTableSchema.js";

export type PaperScaleDiagnosticSeverity = "blocking" | "warning";

export type PaperScaleDiagnosticCategory =
  | "statistical_adequacy"
  | "related_work_depth"
  | "resource_claim";

export interface PaperScaleDiagnostic {
  id: string;
  severity: PaperScaleDiagnosticSeverity;
  category: PaperScaleDiagnosticCategory;
  source_node: string;
  target_node: string;
  summary: string;
  evidence: string;
  recommended_action: string;
  recheck_condition: string;
}

export interface PaperScaleDiagnosticSummary {
  generated_at: string;
  diagnostics: PaperScaleDiagnostic[];
  blocking_count: number;
  warning_count: number;
}

interface ResolvedComparison {
  comparison: ResultsComparisonV2;
  subjectObservation: ResultsObservationV2;
  referenceObservation: ResultsObservationV2;
  metric: ResultsMetricDefinitionV2;
  subjectSeries: ResultsSeriesV2;
  referenceSeries: ResultsSeriesV2;
}

type PrimaryComparisonSelection =
  | { status: "none" }
  | { status: "selected"; value: ResolvedComparison }
  | {
    status: "ambiguous";
    comparisonCount: number;
    primaryComparisonId?: string;
  };

export type PaperEvidenceAdequacyState =
  | "pass"
  | "fail"
  | "unknown"
  | "unverified_missing_assessment"
  | "invalid"
  | "primary_mismatch";

export interface PaperEvidenceAdequacyGate {
  passed: boolean;
  state: PaperEvidenceAdequacyState;
  detail: string;
  measuredValue: string;
  thresholdValue: string;
}

export function evaluatePaperEvidenceAdequacy(
  report: AnalysisReport
): PaperEvidenceAdequacyGate {
  const rawAssessment: unknown = report.evidence_adequacy_assessment;
  const thresholdValue =
    "valid_assessment;overall_status=pass;all_checks=pass;primary_comparison_binding=match";

  if (rawAssessment === undefined) {
    return {
      passed: false,
      state: "unverified_missing_assessment",
      detail: "No governed evidence adequacy assessment is attached. Ungoverned evidence summaries are not sufficient for paper-scale promotion.",
      measuredValue: "assessment=missing;state=unverified_missing_assessment",
      thresholdValue
    };
  }

  const validation = validateEvidenceAdequacyAssessment(rawAssessment);
  if (!validation.valid || !validation.artifact) {
    return {
      passed: false,
      state: "invalid",
      detail: `The governed evidence adequacy assessment is invalid: ${validation.reasons.join(", ") || "validation_failed"}.`,
      measuredValue: `assessment=invalid;issues=${validation.reasons.length}`,
      thresholdValue
    };
  }

  const assessment = validation.artifact;
  const reportPrimaryComparisonId = typeof report.primary_comparison_id === "string"
    ? report.primary_comparison_id.trim()
    : "";
  if (
    reportPrimaryComparisonId
    && assessment.primary_comparison_id !== reportPrimaryComparisonId
  ) {
    return {
      passed: false,
      state: "primary_mismatch",
      detail: `The assessment is bound to primary comparison "${assessment.primary_comparison_id}", but the report declares "${reportPrimaryComparisonId}".`,
      measuredValue: `assessment_primary=${assessment.primary_comparison_id};report_primary=${reportPrimaryComparisonId}`,
      thresholdValue
    };
  }

  const unresolvedChecks = assessment.checks.filter(
    (check) => check.status !== "pass"
  );
  if (assessment.overall_status !== "pass") {
    const checkDetail = unresolvedChecks.length > 0
      ? unresolvedChecks.map(formatAssessmentCheck).join("; ")
      : "no non-pass check details were recorded";
    return {
      passed: false,
      state: assessment.overall_status,
      detail: `Evidence adequacy overall_status=${assessment.overall_status}. Non-pass checks: ${checkDetail}.`,
      measuredValue: `overall_status=${assessment.overall_status};non_pass_checks=${unresolvedChecks.length}`,
      thresholdValue
    };
  }

  return {
    passed: true,
    state: "pass",
    detail: `Evidence adequacy overall_status=pass with ${assessment.checks.length} verified checks for primary comparison "${assessment.primary_comparison_id}".`,
    measuredValue: `overall_status=pass;checks=${assessment.checks.length}`,
    thresholdValue
  };
}

export function evaluatePaperScaleDiagnostics(input: {
  report: AnalysisReport;
  topic: string;
  bibliographyText?: string;
}): PaperScaleDiagnosticSummary {
  const diagnostics: PaperScaleDiagnostic[] = [];
  const statisticalSummary = input.report.statistical_summary;
  const artifactValue: unknown = input.report.results_artifact;
  const artifactValidation = validateResultsArtifactV2(artifactValue);

  let artifact: ResultsArtifactV2 | undefined;
  let primarySelection: PrimaryComparisonSelection = { status: "none" };

  if (!artifactValidation.valid) {
    diagnostics.push({
      id: "invalid_results_artifact",
      severity: "blocking",
      category: "statistical_adequacy",
      source_node: "analyze_results",
      target_node: "analyze_results",
      summary: "The explicit results artifact is invalid, so comparative claims are blocked.",
      evidence: `ResultsArtifactV2 validation failed: ${artifactValidation.issues.slice(0, 4).join(" ")}`,
      recommended_action: "Repair the explicit metric, series, observation, and subject/reference links, then regenerate the statistical summary.",
      recheck_condition: "ResultsArtifactV2 validation passes with finite observations and deltas that equal subject value minus reference value."
    });
  } else {
    artifact = artifactValue as ResultsArtifactV2;
    primarySelection = selectPrimaryComparison(
      resolveComparisons(artifact),
      input.report.primary_comparison_id
    );
    if (primarySelection.status === "ambiguous") {
      const primaryIdEvidence = primarySelection.primaryComparisonId
        ? `AnalysisReport.primary_comparison_id="${primarySelection.primaryComparisonId}" does not match a validated comparison.`
        : "AnalysisReport.primary_comparison_id is missing.";
      diagnostics.push({
        id: "ambiguous_primary_comparison",
        severity: "blocking",
        category: "statistical_adequacy",
        source_node: "analyze_results",
        target_node: "analyze_results",
        summary: "The validated results do not declare one exact primary comparison.",
        evidence: `The validated artifact contains ${primarySelection.comparisonCount} comparison(s). ${primaryIdEvidence}`,
        recommended_action: "Set AnalysisReport.primary_comparison_id to the exact ID of the declared primary comparison.",
        recheck_condition: "AnalysisReport.primary_comparison_id exactly matches one validated ResultsArtifactV2 comparison."
      });
    }
  }

  const evidenceAdequacy = evaluatePaperEvidenceAdequacy(input.report);
  if (!evidenceAdequacy.passed) {
    diagnostics.push(buildEvidenceAdequacyDiagnostic(evidenceAdequacy));
  }

  const resourceRisk = artifact
    ? detectResourceClaimRisk(artifact, statisticalSummary)
    : undefined;
  if (resourceRisk) {
    diagnostics.push({
      id: "resource_claim_unsupported",
      severity: "warning",
      category: "resource_claim",
      source_node: "analyze_results",
      target_node: "analyze_results",
      summary: "Explicit resource measurements are not backed by repeated-measure evidence.",
      evidence: resourceRisk,
      recommended_action: "Keep resource values descriptive until matching intervals or stability estimates are reported across repeated trials.",
      recheck_condition: "Resource-unit metrics have matching structured uncertainty or stability evidence from repeated trials, or claim-level efficiency language is removed."
    });
  }

  return {
    generated_at: new Date().toISOString(),
    diagnostics,
    blocking_count: diagnostics.filter((diagnostic) => diagnostic.severity === "blocking").length,
    warning_count: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length
  };
}

function resolveComparisons(artifact: ResultsArtifactV2): ResolvedComparison[] {
  const observationsById = new Map(
    artifact.observations.map((observation) => [observation.id, observation] as const)
  );
  const metricsById = new Map(
    artifact.metrics.map((metric) => [metric.id, metric] as const)
  );
  const seriesById = new Map(
    artifact.series.map((series) => [series.id, series] as const)
  );

  return artifact.comparisons.flatMap((comparison) => {
    const subjectObservation = observationsById.get(comparison.subject_observation_id);
    const referenceObservation = observationsById.get(comparison.reference_observation_id);
    if (!subjectObservation || !referenceObservation) {
      return [];
    }
    const metric = metricsById.get(subjectObservation.metric_id);
    const subjectSeries = seriesById.get(subjectObservation.series_id);
    const referenceSeries = seriesById.get(referenceObservation.series_id);
    if (
      !metric
      || !subjectSeries
      || !referenceSeries
      || subjectObservation.metric_id !== referenceObservation.metric_id
    ) {
      return [];
    }
    return [{
      comparison,
      subjectObservation,
      referenceObservation,
      metric,
      subjectSeries,
      referenceSeries
    }];
  });
}

function selectPrimaryComparison(
  comparisons: ResolvedComparison[],
  primaryComparisonId: unknown
): PrimaryComparisonSelection {
  if (comparisons.length === 0) {
    return { status: "none" };
  }
  const normalizedPrimaryId = typeof primaryComparisonId === "string"
    ? primaryComparisonId.trim()
    : "";
  if (normalizedPrimaryId) {
    const selected = comparisons.find(
      (comparison) => comparison.comparison.id === normalizedPrimaryId
    );
    if (selected) {
      return { status: "selected", value: selected };
    }
  }
  return {
    status: "ambiguous",
    comparisonCount: comparisons.length,
    ...(normalizedPrimaryId ? { primaryComparisonId: normalizedPrimaryId } : {})
  };
}

function formatAssessmentCheck(
  check: EvidenceAdequacyAssessmentV2["checks"][number]
): string {
  const reasons = check.reasons.length > 0
    ? check.reasons.join(",")
    : "no_reason_recorded";
  return `${check.check_id}=${check.status}(${reasons})`;
}

function buildEvidenceAdequacyDiagnostic(
  gate: PaperEvidenceAdequacyGate
): PaperScaleDiagnostic {
  const id = gate.state === "unverified_missing_assessment"
    ? "evidence_adequacy_unverified"
    : gate.state === "invalid"
      ? "evidence_adequacy_invalid"
      : gate.state === "primary_mismatch"
        ? "evidence_adequacy_primary_mismatch"
        : "evidence_adequacy_not_passed";
  const summary = gate.state === "unverified_missing_assessment"
    ? "The run has no verified evidence adequacy assessment."
    : gate.state === "invalid"
      ? "The evidence adequacy assessment failed integrity validation."
      : gate.state === "primary_mismatch"
        ? "The evidence adequacy assessment is bound to a different primary comparison."
        : `The evidence adequacy assessment is ${gate.state}.`;
  const redesignRequired =
    gate.state === "unverified_missing_assessment"
    || gate.state === "invalid"
    || gate.state === "primary_mismatch";

  return {
    id,
    severity: "blocking",
    category: "statistical_adequacy",
    source_node: redesignRequired ? "design_experiments" : "run_experiments",
    target_node: redesignRequired ? "design_experiments" : "run_experiments",
    summary,
    evidence: gate.detail,
    recommended_action: "Regenerate the contract-bound execution receipt and assessment, then resolve every non-pass check before paper-scale promotion.",
    recheck_condition: gate.thresholdValue
  };
}

function detectResourceClaimRisk(
  artifact: ResultsArtifactV2,
  summary: AnalysisStatisticalSummary | undefined
): string | undefined {
  const resourceMetricIds = new Set(
    artifact.metrics
      .filter((metric) => isResourceUnit(metric.unit))
      .map((metric) => metric.id)
  );
  const observedResourceMetricIds = new Set(
    artifact.observations
      .filter((observation) => resourceMetricIds.has(observation.metric_id))
      .map((observation) => observation.metric_id)
  );
  if (observedResourceMetricIds.size === 0) {
    return undefined;
  }

  const matchingIntervalCount = safeArray(summary?.confidence_intervals)
    .filter((interval) => observedResourceMetricIds.has(interval.metric_key))
    .length;
  const matchingStabilityCount = safeArray(summary?.stability_metrics)
    .filter((entry) => observedResourceMetricIds.has(entry.key))
    .length;
  const executedTrials = asNonNegativeInteger(summary?.executed_trials);
  if (
    executedTrials !== undefined
    && executedTrials >= 3
    && (matchingIntervalCount > 0 || matchingStabilityCount > 0)
  ) {
    return undefined;
  }
  return `${observedResourceMetricIds.size} explicit resource-unit metric(s) have observations; executed_trials=${executedTrials ?? "unknown"}, matching_confidence_intervals=${matchingIntervalCount}, matching_stability_metrics=${matchingStabilityCount}.`;
}

function isResourceUnit(unit: string | undefined): boolean {
  const normalized = normalizeUnit(unit);
  return [
    "s",
    "sec",
    "secs",
    "second",
    "seconds",
    "ms",
    "millisecond",
    "milliseconds",
    "minute",
    "minutes",
    "hour",
    "hours",
    "byte",
    "bytes",
    "kb",
    "kib",
    "mb",
    "mib",
    "gb",
    "gib",
    "tb",
    "tib",
    "joule",
    "joules",
    "wh",
    "kwh"
  ].includes(normalized);
}

function normalizeUnit(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[\s_-]+/gu, "");
}

function safeArray<T>(value: T[] | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
