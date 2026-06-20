import { EventStream } from "./events.js";
import { LLMClient } from "./llm/client.js";
import { AnalysisReport, AnalysisSynthesis } from "./resultAnalysis.js";
import { RunRecord } from "../types.js";
import { loadAnalyzeResultsPromptSections } from "./nodePrompts.js";

interface SynthesizeAnalysisArgs {
  run: Pick<RunRecord, "id" | "topic" | "objectiveMetric" | "constraints">;
  report: AnalysisReport;
  llm: LLMClient;
  eventStream?: EventStream;
  node: RunRecord["currentNode"];
  systemPromptOverride?: string;
}

interface RawAnalysisSynthesis {
  discussion_points?: unknown;
  failure_analysis?: unknown;
  follow_up_actions?: unknown;
  confidence_statement?: unknown;
}

interface EvidenceAccountingSummary {
  primary_trials?: number;
  executed_trials?: number;
  supplemental_run_count: number;
  max_seed_count?: number;
  max_ci_sample_size?: number;
  has_condition_correct_totals: boolean;
  has_task_correct_totals: boolean;
  trial_count_difference_accounted_by_supplemental: boolean;
  summary: string;
}

export async function synthesizeAnalysisReport(args: SynthesizeAnalysisArgs): Promise<AnalysisSynthesis> {
  try {
    args.eventStream?.emit({
      type: "OBS_RECEIVED",
      runId: args.run.id,
      node: args.node,
      agentRole: "analyst_statistician",
      payload: {
        text: "Generating grounded discussion synthesis for the structured result analysis."
      }
    });
    const completion = await args.llm.complete(buildAnalysisSynthesisPrompt(args.run, args.report), {
      systemPrompt: buildAnalysisSynthesisSystemPrompt(args.systemPromptOverride),
      onProgress: (event) => {
        const text = event.text.trim();
        if (!text) {
          return;
        }
        args.eventStream?.emit({
          type: "OBS_RECEIVED",
          runId: args.run.id,
          node: args.node,
          agentRole: "analyst_statistician",
          payload: {
            text: `Result analysis synthesis: ${text}`
          }
        });
      }
    });
    const parsed = parseAnalysisSynthesisResponse(completion.text);
    const evidenceAccounting = buildEvidenceAccountingSummary(args.report);
    const grounded = groundAnalysisSynthesisToEvidence(parsed, evidenceAccounting);
    return {
      source: "llm",
      discussion_points: grounded.discussion_points,
      failure_analysis: grounded.failure_analysis,
      follow_up_actions: grounded.follow_up_actions,
      confidence_statement: grounded.confidence_statement
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    args.eventStream?.emit({
      type: "OBS_RECEIVED",
      runId: args.run.id,
      node: args.node,
      agentRole: "analyst_statistician",
      payload: {
        text: `Result analysis synthesis fallback: ${reason}`
      }
    });
    const fallback = buildSafeFallbackAnalysisSynthesis(args.report);
    return {
      ...fallback,
      fallback_reason: reason
    };
  }
}

function buildAnalysisSynthesisSystemPrompt(override?: string): string {
  if (override?.trim()) {
    return override.trim();
  }
  return loadAnalyzeResultsPromptSections().system;
}

function buildAnalysisSynthesisPrompt(
  run: Pick<RunRecord, "topic" | "objectiveMetric" | "constraints">,
  report: AnalysisReport
): string {
  const evidenceAccounting = buildEvidenceAccountingSummary(report);
  const payload = {
    run: {
      topic: run.topic,
      objective_metric: run.objectiveMetric,
      constraints: run.constraints
    },
    overview: {
      objective_status: report.overview.objective_status,
      objective_summary: report.overview.objective_summary,
      selected_design_title: report.overview.selected_design_title,
      observed_value: report.overview.observed_value,
      matched_metric_key: report.overview.matched_metric_key
    },
    primary_findings: report.primary_findings.slice(0, 4),
    condition_comparisons: report.condition_comparisons.slice(0, 3).map((item) => ({
      label: item.label,
      summary: item.summary,
      hypothesis_supported: item.hypothesis_supported
    })),
    supplemental_runs: report.supplemental_runs.slice(0, 3).map((item) => ({
      profile: item.profile,
      summary: item.summary,
      objective_status: item.objective_evaluation.status
    })),
    external_comparisons: report.external_comparisons.slice(0, 2).map((item) => ({
      label: item.label,
      summary: item.summary
    })),
    statistical_summary: {
      total_trials: report.statistical_summary.total_trials,
      executed_trials: report.statistical_summary.executed_trials,
      confidence_intervals: report.statistical_summary.confidence_intervals.slice(0, 4).map((item) => ({
        metric_key: item.metric_key,
        summary: item.summary,
        sample_size: item.sample_size
      })),
      effect_estimates: report.statistical_summary.effect_estimates.slice(0, 3).map((item) => ({
        comparison_id: item.comparison_id,
        summary: item.summary
      })),
      notes: report.statistical_summary.notes.slice(0, 4)
    },
    evidence_accounting: evidenceAccounting,
    verifier_feedback: report.verifier_feedback
      ? {
          status: report.verifier_feedback.status,
          stage: report.verifier_feedback.stage,
          summary: report.verifier_feedback.summary,
          suggested_next_action: report.verifier_feedback.suggested_next_action
        }
      : undefined,
    failure_taxonomy: report.failure_taxonomy.slice(0, 5).map((item) => ({
      category: item.category,
      severity: item.severity,
      status: item.status,
      summary: item.summary,
      recommended_action: item.recommended_action
    })),
    warnings: report.warnings.slice(0, 5),
    limitations: report.limitations.slice(0, 5)
  };

  return [
    "Return one JSON object with this shape:",
    "{",
    '  "discussion_points": string[],',
    '  "failure_analysis": string[],',
    '  "follow_up_actions": string[],',
    '  "confidence_statement": string',
    "}",
    "",
    "Rules:",
    "- discussion_points: 2-4 concise bullets grounded in the payload.",
    "- failure_analysis: 1-3 bullets. If no concrete execution failure occurred, focus on residual risks or remaining uncertainty instead of inventing a failure.",
    "- follow_up_actions: 1-3 concrete next steps grounded in the payload.",
    "- confidence_statement: one sentence explaining confidence level and why.",
    "- Treat evidence_accounting as authoritative when describing seed counts, CI sample sizes, raw correct/total counts, and primary-vs-supplemental trial accounting.",
    "- If evidence_accounting.has_condition_correct_totals is true, do not say condition-level raw correct/total counts or denominators are missing.",
    "- If evidence_accounting.max_seed_count is greater than 1, do not describe the primary evidence as single-seed.",
    "- If evidence_accounting.max_ci_sample_size is greater than 6, do not cite n=6 as the overall CI/sample-size limitation.",
    "- If evidence_accounting.trial_count_difference_accounted_by_supplemental is true, do not call primary-vs-executed trial counts an ambiguity.",
    "- Do not use markdown or add any keys beyond the required JSON shape.",
    "",
    JSON.stringify(payload, null, 2)
  ].join("\n");
}

function parseAnalysisSynthesisResponse(raw: string): Omit<AnalysisSynthesis, "source" | "fallback_reason"> {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    throw new Error("LLM returned no JSON object for result analysis synthesis.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `Result analysis synthesis JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Result analysis synthesis JSON must decode to an object.");
  }

  const record = parsed as RawAnalysisSynthesis;
  const discussionPoints = normalizeStringArray(record.discussion_points, 4);
  const failureAnalysis = normalizeStringArray(record.failure_analysis, 3);
  const followUpActions = normalizeStringArray(record.follow_up_actions, 3);
  const confidenceStatement = cleanString(record.confidence_statement);

  if (discussionPoints.length === 0) {
    throw new Error("Result analysis synthesis returned no discussion points.");
  }
  if (!confidenceStatement) {
    throw new Error("Result analysis synthesis returned no confidence statement.");
  }

  return {
    discussion_points: discussionPoints,
    failure_analysis:
      failureAnalysis.length > 0
        ? failureAnalysis
        : ["No concrete execution failure was identified beyond the structured warnings and limitations."],
    follow_up_actions:
      followUpActions.length > 0
        ? followUpActions
        : ["Expand confirmatory runs or reporting depth before making stronger claims."],
    confidence_statement: confidenceStatement
  };
}

function buildEvidenceAccountingSummary(report: AnalysisReport): EvidenceAccountingSummary {
  const primaryTrials = report.statistical_summary.total_trials;
  const executedTrials = report.statistical_summary.executed_trials;
  const supplementalRunCount = report.supplemental_runs.length;
  const conditionRows = Array.isArray(report.metrics.condition_results)
    ? report.metrics.condition_results
    : [];
  const maxCiSampleSize = maxNumber([
    ...report.statistical_summary.confidence_intervals.map((item) => item.sample_size),
    ...conditionRows.flatMap((item) => collectConditionConfidenceSampleSizes(item))
  ]);
  const maxSeedCount = maxNumber(conditionRows.map((item) => objectNumber(item, "seed_count")));
  const hasConditionCorrectTotals = conditionRows.some(
    (item) => objectNumber(item, "correct_count") !== undefined && objectNumber(item, "total_count") !== undefined
  );
  const hasTaskCorrectTotals = conditionRows.some((item) => hasNestedTaskCorrectTotals(item));
  const trialCountDifferenceAccountedBySupplemental =
    typeof primaryTrials === "number" &&
    typeof executedTrials === "number" &&
    supplementalRunCount > 0 &&
    executedTrials === primaryTrials + supplementalRunCount;

  return {
    primary_trials: primaryTrials,
    executed_trials: executedTrials,
    supplemental_run_count: supplementalRunCount,
    max_seed_count: maxSeedCount,
    max_ci_sample_size: maxCiSampleSize,
    has_condition_correct_totals: hasConditionCorrectTotals,
    has_task_correct_totals: hasTaskCorrectTotals,
    trial_count_difference_accounted_by_supplemental: trialCountDifferenceAccountedBySupplemental,
    summary: renderEvidenceAccountingSummary({
      primaryTrials,
      executedTrials,
      supplementalRunCount,
      maxSeedCount,
      maxCiSampleSize,
      hasConditionCorrectTotals,
      hasTaskCorrectTotals,
      trialCountDifferenceAccountedBySupplemental
    })
  };
}

function renderEvidenceAccountingSummary(input: {
  primaryTrials?: number;
  executedTrials?: number;
  supplementalRunCount: number;
  maxSeedCount?: number;
  maxCiSampleSize?: number;
  hasConditionCorrectTotals: boolean;
  hasTaskCorrectTotals: boolean;
  trialCountDifferenceAccountedBySupplemental: boolean;
}): string {
  const parts: string[] = [];
  if (typeof input.primaryTrials === "number") {
    parts.push(`primary trials=${input.primaryTrials}`);
  }
  if (typeof input.executedTrials === "number") {
    parts.push(`executed trials=${input.executedTrials}`);
  }
  if (input.supplementalRunCount > 0) {
    parts.push(`supplemental run profiles=${input.supplementalRunCount}`);
  }
  if (typeof input.maxSeedCount === "number") {
    parts.push(`max seed count per condition=${input.maxSeedCount}`);
  }
  if (typeof input.maxCiSampleSize === "number") {
    parts.push(`max CI sample size=${input.maxCiSampleSize}`);
  }
  if (input.hasConditionCorrectTotals) {
    parts.push("condition-level correct/total counts are present");
  }
  if (input.hasTaskCorrectTotals) {
    parts.push("task-level correct/total counts are present");
  }
  if (input.trialCountDifferenceAccountedBySupplemental) {
    parts.push("executed-trial count is explained by primary trials plus supplemental profiles");
  }
  return parts.length > 0 ? parts.join("; ") : "No detailed evidence-accounting fields were detected.";
}

function groundAnalysisSynthesisToEvidence(
  synthesis: Omit<AnalysisSynthesis, "source" | "fallback_reason">,
  accounting: EvidenceAccountingSummary
): Omit<AnalysisSynthesis, "source" | "fallback_reason"> {
  const evidencePoint = `Evidence accounting: ${accounting.summary}.`;
  const discussionPoints = uniqueStrings([
    evidencePoint,
    ...synthesis.discussion_points.filter((item) => !contradictsEvidenceAccounting(item, accounting))
  ]).slice(0, 4);
  const failureAnalysis = synthesis.failure_analysis.filter(
    (item) => !contradictsEvidenceAccounting(item, accounting)
  );
  const followUpActions = synthesis.follow_up_actions.filter(
    (item) => !contradictsEvidenceAccounting(item, accounting)
  );
  const confidenceStatement = contradictsEvidenceAccounting(synthesis.confidence_statement, accounting)
    ? buildEvidenceGroundedConfidenceStatement(accounting)
    : synthesis.confidence_statement;

  return {
    discussion_points: discussionPoints.length > 0 ? discussionPoints : [evidencePoint],
    failure_analysis:
      failureAnalysis.length > 0
        ? failureAnalysis.slice(0, 3)
        : ["No concrete execution failure was identified beyond the structured warnings and limitations."],
    follow_up_actions:
      followUpActions.length > 0
        ? followUpActions.slice(0, 3)
        : ["Use the structured evidence-accounting fields when drafting claims and limitations."],
    confidence_statement: confidenceStatement
  };
}

function buildEvidenceGroundedConfidenceStatement(accounting: EvidenceAccountingSummary): string {
  if (
    (accounting.max_seed_count ?? 0) > 1 &&
    (accounting.max_ci_sample_size ?? 0) > 6 &&
    accounting.has_condition_correct_totals
  ) {
    return "Confidence is moderate for a bounded screening interpretation because repeated-condition evidence, confidence intervals, and correct/total counts are present, while broader claims still depend on experiment scope.";
  }
  return "Confidence is bounded by the structured evidence-accounting summary and should not exceed the reported experiment scope.";
}

function contradictsEvidenceAccounting(text: string, accounting: EvidenceAccountingSummary): boolean {
  const normalized = text.toLowerCase();
  if (
    accounting.has_condition_correct_totals &&
    /\b(?:missing|not provided|lack(?:ing)?|unavailable|without)\b[\s\S]{0,120}\b(?:raw|correct|total|denominator|count)s?\b/u.test(
      normalized
    )
  ) {
    return true;
  }
  if (
    accounting.has_condition_correct_totals &&
    /\b(?:export|add|provide|include)\b[\s\S]{0,120}\b(?:raw|correct|total|denominator|count)s?\b[\s\S]{0,80}\bbefore\b/u.test(
      normalized
    )
  ) {
    return true;
  }
  if (
    (accounting.max_seed_count ?? 0) > 1 &&
    /\b(?:single[- ]seed|only\s+(?:one|1)\s+seed|seed\s*=\s*\d+\s+only)\b/u.test(normalized)
  ) {
    return true;
  }
  if ((accounting.max_ci_sample_size ?? 0) > 6 && /\b(?:n\s*=\s*6|6\s+prediction)s?\b/u.test(normalized)) {
    return true;
  }
  if (
    (accounting.max_ci_sample_size ?? 0) >= 30 &&
    /\btiny\b[\s\S]{0,80}\b(?:confidence[- ]interval\s+)?sample\s+sizes?\b/u.test(normalized)
  ) {
    return true;
  }
  if (
    accounting.trial_count_difference_accounted_by_supplemental &&
    /\b(?:trial[- ]accounting ambiguity|trial[- ]count discrepancy|trial counts?\s+(?:are|is)\s+ambiguous)\b/u.test(
      normalized
    )
  ) {
    return true;
  }
  return false;
}

function maxNumber(values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return numbers.length > 0 ? Math.max(...numbers) : undefined;
}

function objectNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function hasNestedTaskCorrectTotals(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const evaluation = (value as Record<string, unknown>).evaluation;
  if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
    return false;
  }
  return Object.values(evaluation as Record<string, unknown>).some(
    (item) => objectNumber(item, "correct_count") !== undefined && objectNumber(item, "total_count") !== undefined
  );
}

function collectConditionConfidenceSampleSizes(value: unknown): number[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  const sizes: number[] = [];
  const ownCi = record.confidence_interval;
  const ownSampleSize = objectNumber(ownCi, "sample_size");
  if (typeof ownSampleSize === "number") {
    sizes.push(ownSampleSize);
  }
  const evaluation = record.evaluation;
  if (evaluation && typeof evaluation === "object" && !Array.isArray(evaluation)) {
    for (const taskValue of Object.values(evaluation as Record<string, unknown>)) {
      if (!taskValue || typeof taskValue !== "object" || Array.isArray(taskValue)) {
        continue;
      }
      const taskCi = (taskValue as Record<string, unknown>).confidence_interval;
      const taskSampleSize = objectNumber(taskCi, "sample_size");
      if (typeof taskSampleSize === "number") {
        sizes.push(taskSampleSize);
      }
    }
  }
  return sizes;
}

function buildFallbackAnalysisSynthesis(report: AnalysisReport): AnalysisSynthesis {
  const discussionPoints = uniqueStrings([
    report.primary_findings[0],
    report.primary_findings[1],
    report.statistical_summary.notes[0],
    report.external_comparisons[0]?.summary
  ]).slice(0, 4);

  if (discussionPoints.length === 0) {
    discussionPoints.push(report.overview.objective_summary);
  }

  const failureAnalysis: string[] = [];
  for (const item of report.failure_taxonomy.slice(0, 3)) {
    failureAnalysis.push(item.summary);
  }
  if (report.verifier_feedback?.status === "fail") {
    failureAnalysis.push(
      `Verifier failure at ${report.verifier_feedback.stage}: ${report.verifier_feedback.summary}`
    );
  }
  if (report.overview.objective_status === "not_met") {
    failureAnalysis.push("The configured objective threshold was not met under the current setup.");
  }
  for (const warning of report.warnings.slice(0, 2)) {
    failureAnalysis.push(`Residual risk: ${warning}`);
  }
  if (failureAnalysis.length === 0) {
    failureAnalysis.push(
      "No concrete execution failure was observed; remaining uncertainty is limited to the reported warnings and design risks."
    );
  }

  const followUpActions: string[] = [];
  for (const item of report.failure_taxonomy.slice(0, 3)) {
    if (item.recommended_action) {
      followUpActions.push(item.recommended_action);
    }
  }
  if (report.verifier_feedback?.status === "fail" && report.verifier_feedback.suggested_next_action) {
    followUpActions.push(report.verifier_feedback.suggested_next_action);
  }
  if (report.overview.objective_status === "not_met") {
    followUpActions.push("Adjust the primary condition and rerun until the target metric is met.");
  }
  if (report.supplemental_runs.length === 0) {
    followUpActions.push("Run confirmatory and quick-check profiles to measure stability across sampling profiles.");
  }
  if (report.statistical_summary.confidence_intervals.length === 0) {
    followUpActions.push("Add repeated-trial confidence intervals for the primary metrics.");
  }
  if (report.external_comparisons.length === 0) {
    followUpActions.push("Refresh the recent-paper comparison to contextualize the current results.");
  }
  if (followUpActions.length === 0 && report.limitations[0]) {
    followUpActions.push(`Address this leading limitation in the next iteration: ${report.limitations[0]}`);
  }
  if (followUpActions.length === 0) {
    followUpActions.push("Increase trial coverage before making broader claims.");
  }

  return {
    source: "fallback",
    discussion_points: discussionPoints,
    failure_analysis: uniqueStrings(failureAnalysis).slice(0, 3),
    follow_up_actions: uniqueStrings(followUpActions).slice(0, 3),
    confidence_statement: buildFallbackConfidenceStatement(report)
  };
}

function buildSafeFallbackAnalysisSynthesis(report: AnalysisReport): AnalysisSynthesis {
  try {
    return buildFallbackAnalysisSynthesis(report);
  } catch {
    return {
      source: "fallback",
      discussion_points: [report.overview.objective_summary],
      failure_analysis: [
        "Structured fallback synthesis was reduced to a minimal summary because some optional report sections were missing."
      ],
      follow_up_actions: [
        "Review the structured analysis report and fill in the missing evidence before making stronger claims."
      ],
      confidence_statement: buildFallbackConfidenceStatement(report)
    };
  }
}

function buildFallbackConfidenceStatement(report: AnalysisReport): string {
  const objectiveStatus = report.overview.objective_status;
  const hasIntervals = report.statistical_summary.confidence_intervals.length > 0;
  const totalTrials = report.statistical_summary.total_trials;
  const warningCount = report.warnings.length;

  if (objectiveStatus === "met" && hasIntervals && typeof totalTrials === "number" && totalTrials >= 10) {
    return "Confidence is moderate because the objective was met with repeated-trial statistics, though the conclusion remains bounded by the current experiment scope.";
  }
  if (objectiveStatus === "met") {
    return "Confidence is preliminary because the objective was met, but statistical coverage or corroborating runs remain limited.";
  }
  if (objectiveStatus === "not_met") {
    return "Confidence is moderate that the current setup misses the target, but additional runs are still needed to separate implementation issues from sampling noise.";
  }
  if (warningCount > 0) {
    return "Confidence is limited because the structured report still carries unresolved warnings and incomplete evidence.";
  }
  return "Confidence is limited because the structured report does not yet include enough corroborating evidence for a stronger discussion claim.";
}

function extractJsonObject(raw: string): string | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fenced?.[1] || raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  return candidate.slice(start, end + 1);
}

function normalizeStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(
    value
      .map((item) => cleanString(item))
      .filter((item): item is string => Boolean(item))
  ).slice(0, limit);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(items: Array<string | undefined | null>): string[] {
  return [
    ...new Set(
      items
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    )
  ];
}
