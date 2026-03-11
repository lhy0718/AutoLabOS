import { TransitionRecommendation } from "../types.js";
import { AnalysisReport } from "./resultAnalysis.js";

export type AnalyzeResultsPanelReviewerId =
  | "metric_auditor"
  | "robustness_reviewer"
  | "confounder_detector"
  | "decision_calibrator";

export interface AnalyzeResultsPanelInput {
  objective_status: AnalysisReport["overview"]["objective_status"];
  objective_summary: string;
  matched_metric_key?: string;
  baseline_recommendation: TransitionRecommendation;
  warning_count: number;
  limitation_count: number;
  supplemental_run_count: number;
}

export interface AnalyzeResultsPanelReview {
  reviewer_id: AnalyzeResultsPanelReviewerId;
  reviewer_label: string;
  score_1_to_5: number;
  confidence: number;
  summary: string;
  findings: string[];
}

export interface AnalyzeResultsPanelScorecard {
  overall_score_1_to_5: number;
  grounding_status: "resolved" | "unresolved";
  robustness_score_1_to_5: number;
  confounder_risk: "low" | "medium" | "high";
  baseline_confidence: number;
  calibrated_confidence: number;
}

export interface AnalyzeResultsPanelDecision {
  action: TransitionRecommendation["action"];
  targetNode?: TransitionRecommendation["targetNode"];
  confidence: number;
  autoExecutable: boolean;
  rationale: string[];
  evidence: string[];
  panel_calibrated: true;
}

export interface AnalyzeResultsPanelResult {
  inputs: AnalyzeResultsPanelInput;
  reviews: AnalyzeResultsPanelReview[];
  scorecard: AnalyzeResultsPanelScorecard;
  decision: AnalyzeResultsPanelDecision;
  recommendation: TransitionRecommendation;
}

interface MetricAuditResult {
  review: AnalyzeResultsPanelReview;
  unresolvedGrounding: boolean;
  confidenceAdjustment: number;
}

interface RobustnessReviewResult {
  review: AnalyzeResultsPanelReview;
  confidenceAdjustment: number;
}

interface ConfounderReviewResult {
  review: AnalyzeResultsPanelReview;
  risk: AnalyzeResultsPanelScorecard["confounder_risk"];
  confidenceAdjustment: number;
}

export function runAnalyzeResultsPanel(input: {
  report: AnalysisReport;
  baselineRecommendation: TransitionRecommendation;
}): AnalyzeResultsPanelResult {
  const inputs: AnalyzeResultsPanelInput = {
    objective_status: input.report.overview.objective_status,
    objective_summary: input.report.overview.objective_summary,
    matched_metric_key: input.report.overview.matched_metric_key,
    baseline_recommendation: input.baselineRecommendation,
    warning_count: input.report.warnings.length,
    limitation_count: input.report.limitations.length,
    supplemental_run_count: input.report.supplemental_runs.length
  };
  const metricAudit = buildMetricAuditorReview(input.report);
  const robustness = buildRobustnessReview(input.report);
  const confounders = buildConfounderReview(input.report);
  const calibratedConfidence = calibrateConfidence({
    baselineConfidence: input.baselineRecommendation.confidence,
    baselineAction: input.baselineRecommendation.action,
    report: input.report,
    metricAudit,
    robustness,
    confounders
  });
  const decision = buildPanelDecision({
    report: input.report,
    baselineRecommendation: input.baselineRecommendation,
    calibratedConfidence,
    metricAudit,
    robustness,
    confounders
  });
  const decisionReview = buildDecisionCalibratorReview(
    input.report,
    input.baselineRecommendation,
    decision,
    metricAudit,
    robustness,
    confounders
  );
  const reviews = [
    metricAudit.review,
    robustness.review,
    confounders.review,
    decisionReview
  ];
  const scorecard: AnalyzeResultsPanelScorecard = {
    overall_score_1_to_5: averageScore(reviews),
    grounding_status: metricAudit.unresolvedGrounding ? "unresolved" : "resolved",
    robustness_score_1_to_5: robustness.review.score_1_to_5,
    confounder_risk: confounders.risk,
    baseline_confidence: input.baselineRecommendation.confidence,
    calibrated_confidence: decision.confidence
  };

  return {
    inputs,
    reviews,
    scorecard,
    decision,
    recommendation: {
      ...input.baselineRecommendation,
      confidence: decision.confidence,
      autoExecutable: decision.autoExecutable,
      reason: mergeReason(input.baselineRecommendation.reason, decision.rationale),
      evidence: uniqueStrings([
        ...input.baselineRecommendation.evidence,
        ...decision.evidence
      ]).slice(0, 6)
    }
  };
}

function buildMetricAuditorReview(report: AnalysisReport): MetricAuditResult {
  const unresolvedGrounding = report.overview.objective_status === "unknown";
  const missingObjective = report.overview.objective_status === "missing";
  const matchedMetricText = report.overview.matched_metric_key
    ? `Matched metric key: ${report.overview.matched_metric_key}.`
    : "No concrete metric key was matched.";
  const findings = uniqueStrings([
    report.overview.objective_summary,
    matchedMetricText,
    report.warnings.find((item) => /objective|metric/iu.test(item)) || ""
  ]).filter(Boolean);
  return {
    review: {
      reviewer_id: "metric_auditor",
      reviewer_label: "Metric auditor",
      score_1_to_5: unresolvedGrounding ? 1 : missingObjective ? 2 : report.overview.objective_status === "met" ? 5 : 4,
      confidence: unresolvedGrounding ? 0.95 : 0.93,
      summary: unresolvedGrounding
        ? "Objective grounding remains unresolved after the best-effort rematch."
        : missingObjective
          ? "The objective is defined, but the run did not emit the expected metric."
          : `Objective grounding is usable for transition decisions via ${report.overview.matched_metric_key || "the resolved metric"}.`,
      findings: findings.slice(0, 3)
    },
    unresolvedGrounding,
    confidenceAdjustment: unresolvedGrounding ? -0.04 : report.overview.matched_metric_key ? 0.02 : 0
  };
}

function buildRobustnessReview(report: AnalysisReport): RobustnessReviewResult {
  const totalTrials = report.statistical_summary.total_trials || report.overview.execution_runs || 0;
  const confidenceIntervals = report.statistical_summary.confidence_intervals.length;
  const supplementalPasses = report.supplemental_runs.filter((item) => item.summary && item.objective_evaluation.status !== "missing").length;
  const supplementalFailures = report.supplemental_runs.filter((item) =>
    /failed|invalid|did not produce/iu.test(item.summary)
  ).length;
  const rawScore =
    1 +
    (totalTrials >= 2 ? 1 : 0) +
    (confidenceIntervals > 0 ? 1 : 0) +
    (supplementalPasses > 0 ? 1 : 0) +
    (supplementalFailures === 0 && totalTrials >= 6 ? 1 : 0);
  const score = clampScore(rawScore);
  const findings = uniqueStrings([
    totalTrials > 0 ? `Total recorded trials: ${totalTrials}.` : "No total trial count was reported.",
    confidenceIntervals > 0
      ? `${confidenceIntervals} confidence interval(s) were reported.`
      : "No confidence intervals were reported.",
    report.supplemental_runs[0]?.summary || ""
  ]).filter(Boolean);
  return {
    review: {
      reviewer_id: "robustness_reviewer",
      reviewer_label: "Robustness reviewer",
      score_1_to_5: score,
      confidence: 0.9,
      summary:
        score >= 4
          ? "Robustness evidence is reasonably strong for automated transition handling."
          : score === 3
            ? "Robustness evidence is mixed and should temper confidence without blocking progress."
            : "Robustness evidence is thin, so transitions should stay conservative.",
      findings: findings.slice(0, 3)
    },
    confidenceAdjustment:
      score >= 5 ? 0.05 : score === 4 ? 0.03 : score === 3 ? 0 : score === 2 ? -0.04 : -0.08
  };
}

function buildConfounderReview(report: AnalysisReport): ConfounderReviewResult {
  const highObserved = report.failure_taxonomy.find(
    (item) => item.status === "observed" && item.severity === "high"
  );
  const observedFailures = report.failure_taxonomy.filter((item) => item.status === "observed").length;
  const risk =
    highObserved || report.warnings.length >= 4 || report.limitations.length >= 4
      ? "high"
      : observedFailures > 0 || report.warnings.length >= 2 || report.limitations.length >= 3
        ? "medium"
        : "low";
  const findings = uniqueStrings([
    highObserved?.summary || report.failure_taxonomy[0]?.summary || "",
    report.limitations[0] || "",
    report.warnings[0] || ""
  ]).filter(Boolean);
  return {
    review: {
      reviewer_id: "confounder_detector",
      reviewer_label: "Confounder detector",
      score_1_to_5: risk === "high" ? 1 : risk === "medium" ? 3 : report.warnings.length === 0 ? 5 : 4,
      confidence: 0.9,
      summary:
        risk === "high"
          ? "Observed failures or unresolved caveats materially limit how strongly the outcome should drive automation."
          : risk === "medium"
            ? "There are meaningful caveats, but they do not fully overturn the baseline recommendation."
            : "No major confounder dominates the current transition choice.",
      findings: findings.slice(0, 3)
    },
    risk,
    confidenceAdjustment: risk === "high" ? -0.1 : risk === "medium" ? -0.05 : 0.01
  };
}

function calibrateConfidence(input: {
  baselineConfidence: number;
  baselineAction: TransitionRecommendation["action"];
  report: AnalysisReport;
  metricAudit: MetricAuditResult;
  robustness: RobustnessReviewResult;
  confounders: ConfounderReviewResult;
}): number {
  let next =
    input.baselineConfidence +
    input.metricAudit.confidenceAdjustment +
    input.robustness.confidenceAdjustment +
    input.confounders.confidenceAdjustment;

  if (
    input.baselineAction === "backtrack_to_implement" &&
    input.report.failure_taxonomy.some(
      (item) => item.category === "runtime_failure" && item.status === "observed"
    )
  ) {
    next = Math.max(next, 0.9);
  }

  if (input.baselineAction === "advance" && input.report.overview.objective_status === "observed") {
    next = Math.min(next, 0.88);
  }

  return clampConfidence(next);
}

function buildPanelDecision(input: {
  report: AnalysisReport;
  baselineRecommendation: TransitionRecommendation;
  calibratedConfidence: number;
  metricAudit: MetricAuditResult;
  robustness: RobustnessReviewResult;
  confounders: ConfounderReviewResult;
}): AnalyzeResultsPanelDecision {
  const rationale = uniqueStrings([
    input.metricAudit.review.summary,
    input.robustness.review.summary,
    input.confounders.review.summary
  ]).slice(0, 4);
  const evidence = uniqueStrings([
    input.metricAudit.review.findings[0] || "",
    input.robustness.review.findings[0] || "",
    input.confounders.review.findings[0] || ""
  ]).filter(Boolean);
  const autoExecutable =
    input.baselineRecommendation.action === "pause_for_human"
      ? false
      : input.baselineRecommendation.action === "backtrack_to_hypotheses"
        ? input.calibratedConfidence >= 0.82 &&
          !input.metricAudit.unresolvedGrounding &&
          input.confounders.risk !== "high"
        : input.baselineRecommendation.autoExecutable;

  return {
    action: input.baselineRecommendation.action,
    targetNode: input.baselineRecommendation.targetNode,
    confidence: input.calibratedConfidence,
    autoExecutable,
    rationale,
    evidence,
    panel_calibrated: true
  };
}

function buildDecisionCalibratorReview(
  report: AnalysisReport,
  baselineRecommendation: TransitionRecommendation,
  decision: AnalyzeResultsPanelDecision,
  metricAudit: MetricAuditResult,
  robustness: RobustnessReviewResult,
  confounders: ConfounderReviewResult
): AnalyzeResultsPanelReview {
  const findings = uniqueStrings([
    `Baseline confidence: ${baselineRecommendation.confidence.toFixed(2)}.`,
    `Calibrated confidence: ${decision.confidence.toFixed(2)}.`,
    metricAudit.unresolvedGrounding
      ? "Decision remains manual because the objective metric is still ambiguous."
      : decision.autoExecutable
        ? "Decision remains safe for automation under the current policy."
        : "Decision stays manual because panel confidence is not high enough for safe auto-application."
  ]);
  const delta = decision.confidence - baselineRecommendation.confidence;
  const score =
    decision.autoExecutable && decision.confidence >= baselineRecommendation.confidence
      ? 5
      : decision.autoExecutable
        ? 4
        : baselineRecommendation.action === "pause_for_human"
          ? 3
          : 2;
  const reason =
    report.overview.objective_status === "unknown"
      ? "Panel calibration confirms that the recommendation should remain manual until metric grounding is clarified."
      : delta >= 0
        ? "Panel calibration preserved the baseline action while strengthening confidence with specialist signals."
        : "Panel calibration preserved the baseline action while lowering confidence because caveats remain material.";
  return {
    reviewer_id: "decision_calibrator",
    reviewer_label: "Decision calibrator",
    score_1_to_5: score,
    confidence: 0.92,
    summary: reason,
    findings: findings.slice(0, 3)
  };
}

function averageScore(reviews: AnalyzeResultsPanelReview[]): number {
  if (reviews.length === 0) {
    return 0;
  }
  const total = reviews.reduce((sum, review) => sum + review.score_1_to_5, 0);
  return Number((total / reviews.length).toFixed(2));
}

function mergeReason(base: string, rationale: string[]): string {
  const compact = uniqueStrings(rationale).slice(0, 2).join(" ");
  if (!compact) {
    return base;
  }
  return `${base} Panel calibration: ${compact}`;
}

function clampScore(value: number): number {
  return Math.max(1, Math.min(5, Math.round(value)));
}

function clampConfidence(value: number): number {
  return Number(Math.max(0.55, Math.min(0.97, value)).toFixed(2));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
