/**
 * Deterministic minimum gate for paper-quality evaluation (Layer 1).
 *
 * This is a compact, strict, artifact-presence-based gate that answers:
 *   "Is this branch categorically below the minimum evidence bar?"
 *
 * It checks structural prerequisites only — task/dataset grounding,
 * objective metric, baseline/comparator, executed comparison, minimum
 * robustness depth, key artifact parseability, claim→evidence linkage,
 * and smoke/system-only guard.
 *
 * It does NOT assess quality, significance, writing, or venue fit.
 * Those judgments belong to the LLM-based evaluator (Layer 2).
 */

import type { ReviewArtifactPresence } from "../reviewSystem.js";
import type { AnalysisReport } from "../resultAnalysis.js";
import type { FigureAuditSummary } from "../exploration/types.js";
import type { BriefEvidenceAssessment, BriefEvidenceCeiling } from "./briefEvidenceValidator.js";
import { GATE_THRESHOLDS } from "./paperGateThresholds.js";
import {
  evaluatePaperEvidenceAdequacy,
  evaluatePaperScaleDiagnostics,
  type PaperScaleDiagnostic
} from "./paperScaleDiagnostics.js";
import {
  type ResultsArtifactV2,
  validateResultsArtifactV2,
  validateResultsPrimaryComparisonSelectionV2
} from "./resultsTableSchema.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MinimumGateCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  measured_value?: number | string | boolean;
  threshold_value?: number | string | boolean;
  threshold_source?: string;
}

export interface MinimumGateResult {
  passed: boolean;
  /** ISO timestamp */
  evaluated_at: string;
  checks: MinimumGateCheck[];
  blockers: string[];
  /** Machine-readable failed check ids */
  failed_checks: string[];
  /** Ceiling manuscript type implied by gate failures */
  ceiling_type: MinimumGateCeiling;
  /** Warning-only signal from figure_audit; review decides whether to block. */
  figure_audit_severe_mismatch?: boolean;
  /** Reviewer-grade paper-scale diagnostics used by review and meta-harness. */
  paper_scale_diagnostics?: PaperScaleDiagnostic[];
  /** Short human-readable summary */
  summary: string;
}

export type MinimumGateCeiling =
  | "unrestricted"           // gate passed — no ceiling imposed
  | "research_memo"          // some evidence but not paper-scale
  | "system_validation_note" // barely above smoke test
  | "blocked_for_paper_scale"; // categorically blocked

export interface MinimumGateInput {
  presence: ReviewArtifactPresence;
  report: AnalysisReport;
  /** Run topic / title for context */
  topic: string;
  objectiveMetric: string;
  briefEvidenceAssessment?: BriefEvidenceAssessment;
  evidenceLinksArtifact?: unknown;
  claimEvidenceTableArtifact?: unknown;
  figureAuditSummaryArtifact?: FigureAuditSummary | unknown;
  bibliographyText?: string;
}

// ---------------------------------------------------------------------------
// Gate implementation
// ---------------------------------------------------------------------------

export function evaluateMinimumGate(input: MinimumGateInput): MinimumGateResult {
  const checks: MinimumGateCheck[] = [];

  // 1. Objective metric is identified
  const hasObjective = Boolean(input.objectiveMetric?.trim());
  checks.push({
    id: "objective_metric",
      label: "Objective metric identified",
      passed: hasObjective,
      detail: hasObjective
      ? `Objective: ${input.objectiveMetric.slice(0, GATE_THRESHOLDS.objectiveMetricPreviewLength)}`
      : "No objective metric specified",
    measured_value: hasObjective,
    threshold_value: true,
    threshold_source: "docs/paper-quality-bar.md#paper-ready-minimum-gate"
  });

  // 2. Experiment plan exists (task/dataset grounding)
  checks.push({
    id: "experiment_plan",
    label: "Experiment plan exists (task/dataset grounding)",
    passed: input.presence.experimentPlanPresent,
    detail: input.presence.experimentPlanPresent
      ? "experiment_plan.yaml present"
      : "No experiment_plan.yaml — no task/dataset grounding",
    measured_value: input.presence.experimentPlanPresent,
    threshold_value: true,
    threshold_source: "docs/experiment-quality-bar.md#paper-scale-experiment-minimum-gate"
  });

  const explicitComparison = evaluateExplicitResultsArtifactComparison(input.report);

  // 3. At least one baseline or comparator is explicit
  const hasBaselineOrComparator = explicitComparison.passed;
  checks.push({
    id: "baseline_or_comparator",
    label: "Baseline or comparator is explicit",
    passed: hasBaselineOrComparator,
    detail: explicitComparison.detail,
    measured_value: explicitComparison.measuredValue,
    threshold_value: "valid_explicit_results_artifact_comparison>=1",
    threshold_source: "docs/experiment-quality-bar.md#paper-scale-experiment-minimum-gate"
  });

  // 4. At least one executed comparison result exists
  const hasExecutedResult = input.presence.metricsPresent && explicitComparison.passed;
  checks.push({
    id: "executed_result",
    label: "Executed comparison result exists",
    passed: hasExecutedResult,
    detail: hasExecutedResult
      ? `metrics.json present; ${explicitComparison.detail}`
      : !input.presence.metricsPresent
        ? "No metrics.json — no executed result evidence"
        : explicitComparison.detail,
    measured_value: `metrics_present=${input.presence.metricsPresent};${explicitComparison.measuredValue}`,
    threshold_value: "metrics_present=true;valid_explicit_results_artifact_comparison>=1",
    threshold_source: "docs/experiment-quality-bar.md#run_experiments-success-expectations"
  });

  const paperScaleDiagnostics = evaluatePaperScaleDiagnostics({
    report: input.report,
    topic: input.topic,
    bibliographyText: input.bibliographyText
  });

  // 5. Governed evidence adequacy is verified
  const evidenceDepth = evaluatePaperEvidenceAdequacy(input.report);
  checks.push({
    id: "evidence_depth",
    label: "Governed evidence adequacy assessment passes",
    passed: evidenceDepth.passed,
    detail: evidenceDepth.detail,
    measured_value: evidenceDepth.measuredValue,
    threshold_value: evidenceDepth.thresholdValue,
    threshold_source: "docs/experiment-quality-bar.md#paper-scale-experiment-minimum-gate"
  });

  // 6. Key result artifacts exist and are parseable
  const hasResultTable = input.presence.resultTablePresent;
  checks.push({
    id: "result_artifacts",
    label: "Key result artifacts present",
    passed: hasResultTable,
    detail: hasResultTable
      ? "result_table.json present"
      : "No result_table.json",
    measured_value: hasResultTable,
    threshold_value: true,
    threshold_source: "docs/experiment-quality-bar.md#result-table-expectation"
  });

  // 7. Claim→evidence linkage support
  const hasClaimEvidence =
    input.presence.evidenceStorePresent &&
    (input.report.paper_claims?.length ?? 0) >= GATE_THRESHOLDS.minEvidenceLinksClaimCount;
  const claimsWithEvidence = input.report.paper_claims?.filter(
    c => (c.evidence?.length ?? 0) >= GATE_THRESHOLDS.minClaimEvidenceRefsPerClaim
  ).length ?? 0;
  checks.push({
    id: "claim_evidence_linkage",
    label: "Claim→evidence linkage present",
    passed: hasClaimEvidence,
    detail: hasClaimEvidence
      ? `evidence_store.jsonl present, ${claimsWithEvidence}/${input.report.paper_claims?.length ?? 0} claim(s) with evidence`
      : !input.presence.evidenceStorePresent
        ? "No evidence_store.jsonl"
        : "No paper claims generated",
    measured_value: claimsWithEvidence,
    threshold_value: GATE_THRESHOLDS.minEvidenceLinksClaimCount,
    threshold_source: "docs/paper-quality-bar.md#claim-evidence-table-expectation"
  });

  // 8. Paper claim-evidence artifacts are structurally grounded when emitted
  const artifactClaimEvidence = evaluateClaimEvidenceArtifacts(input);
  checks.push({
    id: "claim_evidence_missing",
    label: "Paper claim-evidence artifacts are grounded",
    passed: artifactClaimEvidence.passed,
    detail: artifactClaimEvidence.detail,
    measured_value: artifactClaimEvidence.measuredValue,
    threshold_value: artifactClaimEvidence.thresholdValue,
    threshold_source: "docs/paper-quality-bar.md#evidence-linkage-sanity"
  });

  // 9. Results artifact includes a validated explicit observation comparison
  checks.push({
    id: "results_artifact_comparison",
    label: "Results artifact includes a valid explicit comparison",
    passed: explicitComparison.passed,
    detail: explicitComparison.detail,
    measured_value: explicitComparison.measuredValue,
    threshold_value: "valid_explicit_results_artifact_comparison>=1",
    threshold_source: "docs/experiment-quality-bar.md#result-table-expectation"
  });

  // 10. Not merely system/smoke validation
  const hasHypotheses = input.presence.hypothesesPresent;
  const hasEnoughFindings = (input.report.primary_findings?.length ?? 0) >= GATE_THRESHOLDS.minPrimaryFindingCount;
  const isSubstantive = hasHypotheses && hasEnoughFindings && hasObjective;
  checks.push({
    id: "not_smoke_only",
    label: "Not merely system/smoke validation",
      passed: hasHypotheses && hasEnoughFindings && hasObjective,
      detail: isSubstantive
      ? "Hypotheses present, findings generated, objective metric specified"
      : !hasHypotheses
        ? "No hypotheses — may be system-only validation"
        : !hasEnoughFindings
          ? "No primary findings — may be smoke test only"
          : "Missing objective metric",
    measured_value: input.report.primary_findings?.length ?? 0,
    threshold_value: GATE_THRESHOLDS.minPrimaryFindingCount,
    threshold_source: "docs/experiment-quality-bar.md#toy-smoke-exclusion-rule"
  });

  if (
    input.briefEvidenceAssessment &&
    input.briefEvidenceAssessment.enabled &&
    input.briefEvidenceAssessment.status !== "not_applicable"
  ) {
    checks.push({
      id: "brief_minimum_evidence",
      label: "Brief minimum evidence requirements satisfied",
      passed: input.briefEvidenceAssessment.status !== "fail",
      detail: input.briefEvidenceAssessment.summary,
      measured_value: input.briefEvidenceAssessment.status,
      threshold_value: "pass_or_not_applicable",
      threshold_source: "docs/research-brief-template.md"
    });
  }

  // Compute blockers and ceiling
  const blockers = checks.filter(c => !c.passed).map(c => c.label);
  const failedChecks = checks.filter(c => !c.passed).map(c => c.id);
  const failCount = blockers.length;

  let ceiling: MinimumGateCeiling;
  if (failCount === 0) {
    ceiling = "unrestricted";
  } else if (!hasObjective || !input.presence.experimentPlanPresent || !isSubstantive) {
    // Missing fundamentals → system validation
    ceiling = failCount >= GATE_THRESHOLDS.minFundamentalFailuresForBlocked ? "blocked_for_paper_scale" : "system_validation_note";
  } else if (failCount >= GATE_THRESHOLDS.minGeneralFailuresForBlocked) {
    ceiling = "blocked_for_paper_scale";
  } else {
    ceiling = "research_memo";
  }

  if (input.briefEvidenceAssessment?.enabled) {
    ceiling = moreRestrictiveCeiling(ceiling, input.briefEvidenceAssessment.ceiling_type);
  }

  const passed = failCount === 0;
  const figureAuditSevereMismatch =
    isFigureAuditSummary(input.figureAuditSummaryArtifact)
    && input.figureAuditSummaryArtifact.severe_mismatch_count > 0;
  const summary = passed
    ? "Minimum evidence gate passed — all structural prerequisites met."
    : `Minimum gate: ${failCount} check(s) failed — ceiling: ${ceiling}. ${blockers.join("; ")}.`;

  return {
    passed,
    evaluated_at: new Date().toISOString(),
    checks,
    blockers,
    failed_checks: failedChecks,
    ceiling_type: ceiling,
    ...(figureAuditSevereMismatch ? { figure_audit_severe_mismatch: true } : {}),
    paper_scale_diagnostics: paperScaleDiagnostics.diagnostics,
    summary
  };
}

function moreRestrictiveCeiling(
  left: MinimumGateCeiling,
  right: MinimumGateCeiling | BriefEvidenceCeiling
): MinimumGateCeiling {
  const ranking: Record<MinimumGateCeiling, number> = {
    unrestricted: 0,
    research_memo: 1,
    system_validation_note: 2,
    blocked_for_paper_scale: 3
  };
  return ranking[left] >= ranking[right as MinimumGateCeiling] ? left : (right as MinimumGateCeiling);
}

interface ExplicitResultsArtifactComparisonAssessment {
  passed: boolean;
  detail: string;
  measuredValue: string;
}

function evaluateExplicitResultsArtifactComparison(
  report: AnalysisReport
): ExplicitResultsArtifactComparisonAssessment {
  const artifactValue = (report as { results_artifact?: unknown }).results_artifact;
  const validation = validateResultsArtifactV2(artifactValue);
  if (!validation.valid) {
    const issuePreview = validation.issues.slice(0, 3).join(" ");
    return {
      passed: false,
      detail: `result_analysis.results_artifact is invalid. ${issuePreview}`.trim(),
      measuredValue: `invalid_results_artifact;issues=${validation.issues.length}`
    };
  }

  const artifact = artifactValue as ResultsArtifactV2;
  if (artifact.comparisons.length === 0) {
    return {
      passed: false,
      detail: "ResultsArtifactV2 must include at least one explicit comparison.",
      measuredValue: "valid_explicit_comparisons=0;declared_comparisons=0"
    };
  }

  const reportPrimaryComparisonId = (report as { primary_comparison_id?: unknown })
    .primary_comparison_id;
  const primarySelectionValidation = validateResultsPrimaryComparisonSelectionV2({
    comparisonIds: artifact.comparisons.map((comparison) => comparison.id),
    comparisonCount: artifact.comparisons.length,
    primaryComparisonId: reportPrimaryComparisonId,
    primaryPath: "result_analysis.primary_comparison_id",
    comparisonsPath: "result_analysis.results_artifact.comparisons"
  });
  if (!primarySelectionValidation.valid) {
    return {
      passed: false,
      detail: primarySelectionValidation.issues.join(" "),
      measuredValue: `invalid_primary_comparison_selection;declared_comparisons=${artifact.comparisons.length}`
    };
  }

  const primaryComparisonId = reportPrimaryComparisonId as string;
  const explicitComparison = artifact.comparisons.find(
    (comparison) => comparison.id === primaryComparisonId
  )!;
  const observationsById = new Map(
    artifact.observations.map((observation) => [observation.id, observation] as const)
  );
  const metricsById = new Map(
    artifact.metrics.map((metric) => [metric.id, metric] as const)
  );
  const subject = observationsById.get(explicitComparison.subject_observation_id)!;
  const reference = observationsById.get(explicitComparison.reference_observation_id)!;
  const metric = metricsById.get(subject.metric_id)!;
  return {
    passed: true,
    detail: `ResultsArtifactV2 comparison "${explicitComparison.id}" explicitly links subject observation "${subject.id}" to reference observation "${reference.id}" for metric "${metric.id}" (${metric.direction}); delta=${explicitComparison.delta} matches subject minus reference.`,
    measuredValue: `valid_explicit_comparisons>=1;comparison_id=${explicitComparison.id}`
  };
}

function evaluateClaimEvidenceArtifacts(input: MinimumGateInput): {
  passed: boolean;
  detail: string;
  measuredValue: string | number;
  thresholdValue: string | number;
} {
  const evidenceLinks = normalizeArtifactClaims(input.evidenceLinksArtifact);
  const claimEvidenceTable = normalizeArtifactClaims(input.claimEvidenceTableArtifact);

  if (!evidenceLinks.present && !claimEvidenceTable.present) {
    return {
      passed: true,
      detail: "paper/evidence_links.json and paper/claim_evidence_table.json not emitted yet; relying on pre-draft claim linkage.",
      measuredValue: "not_emitted",
      thresholdValue: "grounded_when_emitted"
    };
  }

  if (!evidenceLinks.present) {
    return {
      passed: false,
      detail: "paper/evidence_links.json missing or malformed.",
      measuredValue: "evidence_links_missing",
      thresholdValue: "evidence_links_present"
    };
  }

  if (evidenceLinks.claims.length < GATE_THRESHOLDS.minEvidenceLinksClaimCount) {
    return {
      passed: false,
      detail: "paper/evidence_links.json must include at least one claim entry.",
      measuredValue: evidenceLinks.claims.length,
      thresholdValue: GATE_THRESHOLDS.minEvidenceLinksClaimCount
    };
  }

  if (!claimEvidenceTable.present) {
    return {
      passed: false,
      detail: "paper/claim_evidence_table.json missing or malformed.",
      measuredValue: "claim_evidence_table_missing",
      thresholdValue: "claim_evidence_table_present"
    };
  }

  if (claimEvidenceTable.claims.length < GATE_THRESHOLDS.minClaimEvidenceRows) {
    return {
      passed: false,
      detail: "paper/claim_evidence_table.json must include at least one claim entry.",
      measuredValue: claimEvidenceTable.claims.length,
      thresholdValue: GATE_THRESHOLDS.minClaimEvidenceRows
    };
  }

  const emptyEvidenceClaim = claimEvidenceTable.claims.find(
    (claim) => extractClaimEvidenceRefs(claim).length < GATE_THRESHOLDS.minClaimEvidenceRefsPerClaim
  );
  if (emptyEvidenceClaim) {
    return {
      passed: false,
      detail: `Claim ${String((emptyEvidenceClaim as Record<string, unknown>).claim_id || "unknown")} has no evidence/artifact/citation references in paper/claim_evidence_table.json.`,
      measuredValue: 0,
      thresholdValue: GATE_THRESHOLDS.minClaimEvidenceRefsPerClaim
    };
  }

  return {
    passed: true,
    detail: `${evidenceLinks.claims.length} evidence link claim(s) and ${claimEvidenceTable.claims.length} claim-evidence row(s) grounded.`,
    measuredValue: claimEvidenceTable.claims.length,
    thresholdValue: GATE_THRESHOLDS.minClaimEvidenceRows
  };
}

function normalizeArtifactClaims(raw: unknown): { present: boolean; claims: Record<string, unknown>[] } {
  if (!raw || typeof raw !== "object") {
    return { present: false, claims: [] };
  }
  const claims = (raw as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) {
    return { present: false, claims: [] };
  }
  return {
    present: true,
    claims: claims.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
  };
}

function extractClaimEvidenceRefs(claim: Record<string, unknown>): string[] {
  const explicitEvidence = normalizeStringArray(claim.evidence);
  if (explicitEvidence.length > 0) {
    return explicitEvidence;
  }
  return [
    ...normalizeStringArray(claim.artifact_refs),
    ...normalizeStringArray(claim.citation_refs),
    ...normalizeStringArray(claim.evidence_ids)
  ];
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isFigureAuditSummary(value: unknown): value is FigureAuditSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<FigureAuditSummary>;
  return (
    typeof candidate.audited_at === "string"
    && Array.isArray(candidate.issues)
    && typeof candidate.severe_mismatch_count === "number"
    && typeof candidate.review_block_required === "boolean"
  );
}
