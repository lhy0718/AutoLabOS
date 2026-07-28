import { RunInsightCard } from "../types.js";
import {
  resolvePrimaryResultsArtifactComparison,
  resolveResultsArtifactComparisons,
  type AnalysisReport,
  type AnalysisResultsArtifactComparison
} from "./resultAnalysis.js";

type InsightReference = NonNullable<RunInsightCard["references"]>[number];
type InsightFacts = NonNullable<InsightReference["facts"]>;
type InsightDetails = NonNullable<InsightReference["details"]>;

export function buildAnalyzeResultsCompletionSummary(report: AnalysisReport): string {
  const { objectiveSummary } = resolveOverview(report);
  const topIssue = report.failure_taxonomy?.[0];
  const parts = [
    `Result analysis complete. mean_score=${report.mean_score}.`,
    objectiveSummary
  ];

  if (topIssue?.summary) {
    parts.push(`Top issue: ${truncateOneLine(topIssue.summary, 140)}`);
  }

  const confidenceLabel = summarizeConfidenceLabel(report.synthesis?.confidence_statement);
  if (confidenceLabel) {
    parts.push(`Confidence: ${confidenceLabel}.`);
  }

  return parts.join(" ");
}

export function formatAnalyzeResultsArtifactLines(input: {
  figureCount: number;
  metricsPresent: boolean;
  report?: AnalysisReport;
}): string[] {
  const lines: string[] = [];
  const base = [
    `Count(analyze_results): ${input.figureCount} figure files`,
    `metrics ${input.metricsPresent ? "present" : "missing"}`
  ];

  if (input.report) {
    const { objectiveStatus } = resolveOverview(input.report);
    const failureCount = input.report.failure_taxonomy?.length || 0;
    base.push(`objective ${objectiveStatus}`);
    base.push(
      failureCount > 0
        ? `${failureCount} issue categories`
        : "no issue categories"
    );
  }

  lines.push(base.join(", "));

  if (input.report?.failure_taxonomy[0]) {
    const topIssue = input.report.failure_taxonomy[0];
    lines.push(
      `- Top issue [${topIssue.severity}/${topIssue.status}]: ${truncateOneLine(topIssue.summary, 180)}`
    );
  }

  const discussion = input.report?.synthesis?.discussion_points?.[0] || input.report?.overview?.objective_summary;
  if (discussion) {
    lines.push(`- Discussion: ${truncateOneLine(discussion, 180)}`);
  }

  if (input.report?.synthesis?.confidence_statement) {
    lines.push(`- Confidence: ${truncateOneLine(input.report.synthesis.confidence_statement, 180)}`);
  }

  return lines;
}

export function buildAnalyzeResultsInsightCard(report: AnalysisReport): RunInsightCard {
  const { objectiveStatus, objectiveSummary } = resolveOverview(report);
  const topIssue = report.failure_taxonomy?.[0];
  const transitionRecommendation = report.transition_recommendation;
  const lines = [
    `Objective: ${objectiveStatus} - ${truncateOneLine(objectiveSummary, 180)}`
  ];

  if (transitionRecommendation) {
    lines.push(`Recommendation: ${formatRecommendationLabel(transitionRecommendation)}`);
    lines.push(`Why: ${truncateOneLine(transitionRecommendation.reason, 180)}`);
    if (transitionRecommendation.evidence?.[0]) {
      lines.push(`Evidence: ${truncateOneLine(transitionRecommendation.evidence[0], 180)}`);
    }
    lines.push(
      transitionRecommendation.autoExecutable
        ? "Automation: safe for overnight auto-apply under policy."
        : "Automation: manual review recommended before applying."
    );
  } else if (topIssue?.summary) {
    lines.push(`Top issue: ${truncateOneLine(topIssue.summary, 180)}`);
  }

  const nextAction =
    report.synthesis?.follow_up_actions?.[0] ||
    report.failure_taxonomy?.find((item) => item.recommended_action)?.recommended_action;
  if (nextAction) {
    lines.push(`Next: ${truncateOneLine(nextAction, 180)}`);
  }

  if (report.synthesis?.confidence_statement) {
    lines.push(`Confidence: ${truncateOneLine(report.synthesis.confidence_statement, 180)}`);
  }

  return {
    title: "Result analysis",
    lines: lines.slice(0, 6),
    actions: buildInsightActions(report),
    references: buildInsightReferences(report)
  };
}

function summarizeConfidenceLabel(statement: string | undefined): string | undefined {
  if (!statement) {
    return undefined;
  }
  const match = statement.match(/confidence is ([a-z-]+)/iu);
  if (match?.[1]) {
    return match[1].toLowerCase();
  }
  return truncateOneLine(statement, 40);
}

function truncateOneLine(text: string | undefined, maxLength: number): string {
  if (!text) {
    return "";
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function formatRecommendationLabel(reportTransition: NonNullable<AnalysisReport["transition_recommendation"]>): string {
  const target = reportTransition.targetNode ? ` -> ${reportTransition.targetNode}` : "";
  return `${reportTransition.action}${target} (${Math.round(reportTransition.confidence * 100)}%)`;
}

function buildInsightActions(report: AnalysisReport): RunInsightCard["actions"] {
  if (!report.transition_recommendation) {
    return undefined;
  }

  const actions: NonNullable<RunInsightCard["actions"]> = [
    {
      label: "Apply recommendation",
      command: "/agent apply"
    }
  ];

  if (report.transition_recommendation.autoExecutable) {
    actions.push({
      label: "Start overnight",
      command: "/agent overnight"
    });
  } else if (report.transition_recommendation.suggestedCommands?.[0]) {
    actions.push({
      label: "Suggested command",
      command: report.transition_recommendation.suggestedCommands[0]
    });
  }

  return actions.slice(0, 2);
}

function buildInsightReferences(report: AnalysisReport): RunInsightCard["references"] {
  const references: NonNullable<RunInsightCard["references"]> = [];
  const primaryFigure = report.figure_specs?.[0];
  const { objectiveSummary } = resolveOverview(report);
  const resolvedComparisons = resolveResultsArtifactComparisons(report.results_artifact);
  const primaryComparison = resolvePrimaryResultsArtifactComparison(
    report.results_artifact,
    report.primary_comparison_id
  );
  const statisticalSummary = resolveStatisticalEvidence(report, primaryComparison, resolvedComparisons.length);

  if (primaryComparison) {
    references.push({
      kind: "comparison",
      label: `Comparison: ${primaryComparison.subject_series.label} vs ${primaryComparison.reference_series.label}`,
      path: primaryComparison.comparison.link,
      summary: truncateOneLine(primaryComparison.summary, 180),
      facts: buildComparisonFacts(primaryComparison),
      details: buildComparisonDetails(primaryComparison)
    });
  }

  if (statisticalSummary) {
    references.push({
      kind: "statistics",
      label: statisticalSummary.label,
      path: primaryComparison?.comparison.link || "result_analysis.json",
      summary: truncateOneLine(statisticalSummary.summary, 180),
      facts: statisticalSummary.facts,
      details: statisticalSummary.details
    });
  }

  if (primaryFigure?.path) {
    references.push({
      kind: "figure",
      label: `Figure: ${primaryFigure.title || primaryFigure.id}`,
      path: primaryFigure.path,
      summary: truncateOneLine(
        primaryFigure.summary ||
          primaryComparison?.summary ||
          objectiveSummary,
        180
      ),
      facts: buildFigureFacts(report, primaryFigure),
      details: buildFigureDetails(report, primaryFigure)
    });
  }

  if (report.transition_recommendation) {
    references.push({
      kind: "transition",
      label: "Transition rationale",
      path: "transition_recommendation.json",
      summary: truncateOneLine(
        report.transition_recommendation.evidence?.[0] || report.transition_recommendation.reason,
        180
      ),
      facts: buildTransitionFacts(report),
      details: buildTransitionDetails(report)
    });
  }

  references.push({
    kind: "report",
    label: "Analysis report",
    path: "result_analysis.json",
    summary: truncateOneLine(
      report.synthesis?.confidence_statement ||
        objectiveSummary,
      180
    ),
    facts: buildReportFacts(report),
    details: buildReportDetails(report)
  });

  if (!primaryFigure?.path) {
    references.push({
      kind: "metrics",
      label: "Metrics snapshot",
      path: "metrics.json",
      summary: truncateOneLine(
        objectiveSummary || "Raw metrics snapshot used to compute the result analysis.",
        180
      ),
      facts: buildMetricsFacts(report),
      details: buildMetricsDetails(report)
    });
  }

  const deduped: NonNullable<RunInsightCard["references"]> = [];
  const seen = new Set<string>();
  for (const item of references) {
    const key = `${item.label}::${item.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped.slice(0, 5);
}

function resolveStatisticalEvidence(
  report: AnalysisReport,
  primaryComparison: AnalysisResultsArtifactComparison | undefined,
  comparisonCount: number
): {
  label: string;
  summary: string;
  facts?: InsightFacts;
  details?: InsightDetails;
} | undefined {
  const confidenceIntervals = report.statistical_summary?.confidence_intervals || [];
  if (primaryComparison) {
    const matchingIntervals = confidenceIntervals.filter(
      (item) => item.metric_key === primaryComparison.metric.id
    );
    const matchingInterval = matchingIntervals.length === 1 ? matchingIntervals.at(0) : undefined;
    const effectDirection = classifyComparisonEffectDirection(primaryComparison);
    return {
      label: `Statistics: ${primaryComparison.metric.id}`,
      summary: primaryComparison.summary,
      facts: compactFacts([
        fact("Comparison ID", primaryComparison.comparison.id),
        fact("Metric", primaryComparison.metric.id),
        fact("Delta", formatSignedNumber(primaryComparison.delta))
      ]),
      details: compactDetails([
        `Comparison link: ${primaryComparison.comparison.link}.`,
        `Effect direction: ${effectDirection} for ${primaryComparison.metric.id}.`,
        matchingInterval?.summary || buildTrialSummary(report)
      ])
    };
  }

  if (comparisonCount > 1) {
    return undefined;
  }

  const soleInterval = confidenceIntervals.length === 1 ? confidenceIntervals.at(0) : undefined;
  if (soleInterval?.summary) {
    return {
      label: `Statistics: ${soleInterval.metric_key || soleInterval.label || "confidence interval"}`,
      summary: soleInterval.summary,
      facts: compactFacts([
        fact("Metric", soleInterval.metric_key || soleInterval.label),
        fact("Confidence", formatConfidenceLevel(soleInterval.level)),
        fact("Sample", soleInterval.sample_size ? String(soleInterval.sample_size) : undefined)
      ]),
      details: compactDetails([
        `Interval bounds: ${formatMaybeNumber(soleInterval.lower) || "unknown"} to ${formatMaybeNumber(soleInterval.upper) || "unknown"}.`,
        buildTrialSummary(report)
      ])
    };
  }

  const notes = report.statistical_summary?.notes || [];
  const soleNote = notes.length === 1 ? notes.at(0) : undefined;
  if (soleNote) {
    return {
      label: "Statistics: summary",
      summary: soleNote,
      facts: compactFacts([
        fact("Trials", report.statistical_summary?.total_trials ? String(report.statistical_summary.total_trials) : undefined),
        fact(
          "Matched metric",
          report.overview?.matched_metric_key || report.objective_metric?.evaluation?.matchedMetricKey
        ),
        fact("Mean", formatMaybeNumber(report.mean_score))
      ]),
      details: compactDetails([
        buildTrialSummary(report),
        report.limitations?.[0]
      ])
    };
  }

  return undefined;
}

function buildComparisonFacts(
  comparison: AnalysisResultsArtifactComparison
): InsightFacts | undefined {
  return compactFacts([
    fact("Comparison ID", comparison.comparison.id),
    fact("Metric", comparison.metric.id),
    fact("Delta", formatSignedNumber(comparison.delta))
  ]);
}

function buildComparisonDetails(
  comparison: AnalysisResultsArtifactComparison
): InsightDetails | undefined {
  return compactDetails([
    `Comparison link: ${comparison.comparison.link}.`,
    `${comparison.metric.id}: ${comparison.subject_series.label} ${formatMaybeNumber(comparison.subject_observation.value)} (${comparison.subject_observation.link}) vs ${comparison.reference_series.label} ${formatMaybeNumber(comparison.reference_observation.value)} (${comparison.reference_observation.link}); delta ${formatSignedNumber(comparison.delta)}.`,
    comparison.comparison.judgement
      ? `Judgement: ${comparison.comparison.judgement}${
        typeof comparison.hypothesis_supported === "boolean"
          ? ` (hypothesis support: ${comparison.hypothesis_supported ? "yes" : "no"})`
          : ""
      }.`
      : typeof comparison.hypothesis_supported === "boolean"
        ? `Hypothesis support: ${comparison.hypothesis_supported ? "yes" : "no"}.`
        : undefined
  ]);
}

function classifyComparisonEffectDirection(
  comparison: AnalysisResultsArtifactComparison
): "positive" | "negative" | "neutral" {
  if (comparison.delta === 0) {
    return "neutral";
  }
  if (comparison.metric.direction === "lower_better") {
    return comparison.delta < 0 ? "positive" : "negative";
  }
  return comparison.delta > 0 ? "positive" : "negative";
}

function buildFigureFacts(
  report: AnalysisReport,
  figure: NonNullable<AnalysisReport["figure_specs"]>[number]
): InsightFacts | undefined {
  const matchedMetric = report.overview?.matched_metric_key || figure.metric_keys?.[0];
  return compactFacts([
    fact("Matched metric", matchedMetric),
    fact("Runs", report.overview?.execution_runs ? String(report.overview.execution_runs) : undefined),
    fact(
      "Top value",
      report.overview?.top_metric ? formatMetricFact(report.overview.top_metric.key, report.overview.top_metric.value) : undefined
    )
  ]);
}

function buildFigureDetails(
  report: AnalysisReport,
  figure: NonNullable<AnalysisReport["figure_specs"]>[number]
): InsightDetails | undefined {
  return compactDetails([
    figure.metric_keys?.length ? `Metrics charted: ${figure.metric_keys.join(", ")}.` : undefined,
    report.overview?.top_metric
      ? `Top observed metric: ${formatMetricFact(report.overview.top_metric.key, report.overview.top_metric.value)}.`
      : undefined,
    report.overview?.objective_summary
  ]);
}

function buildTransitionFacts(
  report: AnalysisReport
): InsightFacts | undefined {
  const transition = report.transition_recommendation;
  if (!transition) {
    return undefined;
  }
  return compactFacts([
    fact("Confidence", `${Math.round(transition.confidence * 100)}%`),
    fact("Target", transition.targetNode || "stay"),
    fact("Auto", transition.autoExecutable ? "yes" : "review")
  ]);
}

function buildTransitionDetails(report: AnalysisReport): InsightDetails | undefined {
  const transition = report.transition_recommendation;
  if (!transition) {
    return undefined;
  }
  return compactDetails([
    transition.reason,
    transition.evidence?.[0],
    transition.suggestedCommands?.[0] ? `Suggested command: ${transition.suggestedCommands[0]}` : undefined
  ]);
}

function buildReportFacts(
  report: AnalysisReport
): InsightFacts | undefined {
  return compactFacts([
    fact("Mean", formatMaybeNumber(report.mean_score)),
    fact(
      "Matched metric",
      report.overview?.matched_metric_key || report.objective_metric?.evaluation?.matchedMetricKey
    ),
    fact("Objective", report.overview?.objective_status || report.objective_metric?.evaluation?.status)
  ]);
}

function buildReportDetails(report: AnalysisReport): InsightDetails | undefined {
  return compactDetails([
    report.overview?.objective_summary,
    report.limitations?.[0] ? `Limitation: ${report.limitations[0]}` : undefined,
    report.synthesis?.confidence_statement
  ]);
}

function buildMetricsFacts(
  report: AnalysisReport
): InsightFacts | undefined {
  return compactFacts([
    fact(
      "Matched metric",
      report.overview?.matched_metric_key || report.objective_metric?.evaluation?.matchedMetricKey
    ),
    fact("Observed", formatMaybeNumber(report.overview?.observed_value)),
    fact("Objective", report.overview?.objective_status || report.objective_metric?.evaluation?.status)
  ]);
}

function buildMetricsDetails(report: AnalysisReport): InsightDetails | undefined {
  return compactDetails([
    report.overview?.objective_summary,
    report.overview?.top_metric
      ? `Top metric: ${formatMetricFact(report.overview.top_metric.key, report.overview.top_metric.value)}.`
      : undefined,
    report.warnings?.[0]
  ]);
}

function fact(label: string, value: string | undefined): { label: string; value: string } | undefined {
  if (!value) {
    return undefined;
  }
  return { label, value };
}

function compactFacts(
  facts: Array<{ label: string; value: string } | undefined>
): InsightFacts | undefined {
  const filtered = facts.filter((item): item is { label: string; value: string } => Boolean(item));
  return filtered.length > 0 ? filtered.slice(0, 3) : undefined;
}

function compactDetails(details: Array<string | undefined>): InsightDetails | undefined {
  const filtered = details
    .map((detail) => truncateOneLine(detail, 220))
    .filter((detail): detail is string => Boolean(detail));
  return filtered.length > 0 ? filtered.slice(0, 3) : undefined;
}

function buildTrialSummary(report: AnalysisReport): string | undefined {
  const totalTrials = report.statistical_summary?.total_trials;
  const executedTrials = report.statistical_summary?.executed_trials;
  const cachedTrials = report.statistical_summary?.cached_trials;
  if (!totalTrials && !executedTrials && !cachedTrials) {
    return undefined;
  }
  const segments = [
    totalTrials ? `${totalTrials} total` : undefined,
    executedTrials ? `${executedTrials} executed` : undefined,
    cachedTrials ? `${cachedTrials} cached` : undefined
  ].filter((segment): segment is string => Boolean(segment));
  if (segments.length === 0) {
    return undefined;
  }
  return `Sampling profile: ${segments.join(", ")}.`;
}

function formatSignedNumber(value: number): string {
  const formatted = formatMaybeNumber(value);
  if (formatted === undefined) {
    return "";
  }
  return value > 0 ? `+${formatted}` : formatted;
}

function formatMaybeNumber(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (Math.abs(value) >= 100 || Number.isInteger(value)) {
    return String(Number(value.toFixed(0)));
  }
  if (Math.abs(value) >= 1) {
    return value.toFixed(2);
  }
  return value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

function formatConfidenceLevel(level: number | undefined): string | undefined {
  if (typeof level !== "number" || !Number.isFinite(level)) {
    return undefined;
  }
  return `${Math.round(level * 100)}%`;
}

function formatMetricFact(key: string | undefined, value: number | undefined): string | undefined {
  const formattedValue = formatMaybeNumber(value);
  if (!formattedValue) {
    return undefined;
  }
  return key ? `${key}=${formattedValue}` : formattedValue;
}

function resolveOverview(report: AnalysisReport): {
  objectiveStatus: string;
  objectiveSummary: string;
} {
  const objectiveStatus =
    report.overview?.objective_status ||
    report.objective_metric?.evaluation?.status ||
    "unknown";
  const objectiveSummary =
    report.overview?.objective_summary ||
    report.objective_metric?.evaluation?.summary ||
    report.warnings?.[0] ||
    "Objective evaluation unavailable.";
  return {
    objectiveStatus,
    objectiveSummary
  };
}
