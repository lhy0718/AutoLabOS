import { RunInsightCard } from "../types.js";
import { AnalysisFailureCategory, AnalysisReport } from "./resultAnalysis.js";

export type ReviewCheckStatus = "ready" | "warning" | "blocking" | "manual";
export type ReviewReadinessStatus = "ready" | "warning" | "blocking";

export interface ReviewPacketCheck {
  id: string;
  label: string;
  status: ReviewCheckStatus;
  detail: string;
}

export interface ReviewPacketRecommendation {
  action: string;
  target?: string;
  confidence_pct: number;
  reason: string;
  evidence: string[];
}

export interface ReviewPacket {
  generated_at: string;
  readiness: {
    status: ReviewReadinessStatus;
    ready_checks: number;
    warning_checks: number;
    blocking_checks: number;
    manual_checks: number;
  };
  objective_status: string;
  objective_summary: string;
  recommendation?: ReviewPacketRecommendation;
  checks: ReviewPacketCheck[];
  suggested_actions: string[];
}

export interface ReviewPacketBuildInput {
  corpusPresent: boolean;
  paperSummariesPresent: boolean;
  evidenceStorePresent: boolean;
  hypothesesPresent: boolean;
  experimentPlanPresent: boolean;
  metricsPresent: boolean;
  figurePresent: boolean;
  synthesisPresent: boolean;
}

export function buildReviewPacket(
  report: AnalysisReport,
  input: ReviewPacketBuildInput
): ReviewPacket {
  const objectiveStatus = report.overview?.objective_status || "unknown";
  const objectiveSummary =
    report.overview?.objective_summary ||
    report.primary_findings?.[0] ||
    "No structured objective summary was available.";
  const transition = report.transition_recommendation;
  const recommendation =
    transition && transition.reason
      ? {
          action: transition.action,
          target: transition.targetNode,
          confidence_pct: Math.round(transition.confidence * 100),
          reason: transition.reason,
          evidence: transition.evidence.slice(0, 3)
        }
      : undefined;
  const checks: ReviewPacketCheck[] = [
    {
      id: "objective_outcome",
      label: "Objective outcome",
      status: objectiveStatus === "met" ? "ready" : "warning",
      detail: objectiveSummary
    },
    buildTransitionCheck(transition),
    buildEvidenceBundleCheck(input),
    buildLiteratureTraceCheck(input),
    buildExecutionRecordCheck(report, input),
    buildFailureReviewCheck(report.failure_taxonomy || []),
    buildNarrativeCheck(report, input),
    {
      id: "primary_figure",
      label: "Primary figure",
      status: input.figurePresent ? "ready" : "warning",
      detail: input.figurePresent
        ? "A primary performance figure is available for human review."
        : "No primary performance figure was generated; inspect result_analysis.json directly."
    },
    {
      id: "human_signoff",
      label: "Human sign-off",
      status: "manual",
      detail: "Confirm the claims, evidence quality, and next action before approving write_paper."
    }
  ];

  return {
    generated_at: new Date().toISOString(),
    readiness: summarizeReviewReadiness(checks),
    objective_status: objectiveStatus,
    objective_summary: objectiveSummary,
    recommendation,
    checks,
    suggested_actions: buildSuggestedActions(transition?.action, checks)
  };
}

export function parseReviewPacket(raw: string): ReviewPacket | undefined {
  if (!raw.trim()) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  return normalizeReviewPacket(parsed);
}

export function normalizeReviewPacket(value: unknown): ReviewPacket | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const checks = Array.isArray(record.checks)
    ? record.checks
        .map((item, index) => normalizeReviewCheck(item, index))
        .filter((item): item is ReviewPacketCheck => Boolean(item))
    : [];
  const readiness = summarizeReviewReadiness(checks);
  const recommendation = normalizeRecommendation(record.recommendation);
  const suggestedActions = Array.isArray(record.suggested_actions)
    ? record.suggested_actions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : buildSuggestedActions(recommendation?.action, checks);

  return {
    generated_at: asString(record.generated_at) || "",
    readiness: normalizeReadiness(record.readiness, readiness),
    objective_status: asString(record.objective_status) || "unknown",
    objective_summary:
      asString(record.objective_summary) || "No structured objective summary was available.",
    recommendation,
    checks,
    suggested_actions: suggestedActions
  };
}

export function summarizeReviewReadiness(
  checks: Pick<ReviewPacketCheck, "status">[]
): ReviewPacket["readiness"] {
  let ready = 0;
  let warning = 0;
  let blocking = 0;
  let manual = 0;

  for (const check of checks) {
    switch (check.status) {
      case "ready":
        ready += 1;
        break;
      case "warning":
        warning += 1;
        break;
      case "blocking":
        blocking += 1;
        break;
      case "manual":
        manual += 1;
        break;
    }
  }

  return {
    status: blocking > 0 ? "blocking" : warning > 0 ? "warning" : "ready",
    ready_checks: ready,
    warning_checks: warning,
    blocking_checks: blocking,
    manual_checks: manual
  };
}

export function formatReviewPacketLines(packet: ReviewPacket): string[] {
  const lines = [
    `Review readiness: ${packet.readiness.status} (${packet.readiness.ready_checks} ready, ${packet.readiness.warning_checks} warning, ${packet.readiness.blocking_checks} blocking, ${packet.readiness.manual_checks} manual)`,
    `Objective: ${packet.objective_status} - ${packet.objective_summary}`
  ];

  if (packet.recommendation) {
    lines.push(
      `Recommendation: ${packet.recommendation.action}${packet.recommendation.target ? ` -> ${packet.recommendation.target}` : ""} (${packet.recommendation.confidence_pct}%)`
    );
  }

  const blocking = packet.checks.find((item) => item.status === "blocking");
  if (blocking) {
    lines.push(`Blocking: ${blocking.label} - ${blocking.detail}`);
  }

  const warning = packet.checks.find((item) => item.status === "warning");
  if (warning) {
    lines.push(`Warning: ${warning.label} - ${warning.detail}`);
  }

  const manual = packet.checks.find((item) => item.status === "manual");
  if (manual) {
    lines.push(`Manual: ${manual.label} - ${manual.detail}`);
  }

  if (packet.suggested_actions.length > 0) {
    lines.push(`Suggested: ${packet.suggested_actions.slice(0, 3).join(" | ")}`);
  }

  return lines;
}

export function buildReviewInsightCard(packet: ReviewPacket): RunInsightCard {
  return {
    title: "Review packet",
    lines: formatReviewPacketLines(packet),
    actions: packet.suggested_actions.slice(0, 3).map((command) => ({
      label: labelReviewAction(command),
      command
    }))
  };
}

function buildTransitionCheck(
  transition: AnalysisReport["transition_recommendation"]
): ReviewPacketCheck {
  if (!transition) {
    return {
      id: "transition_recommendation",
      label: "Transition recommendation",
      status: "manual",
      detail: "No explicit transition recommendation was recorded."
    };
  }

  const ready = transition.action === "advance" && transition.targetNode === "review";
  return {
    id: "transition_recommendation",
    label: "Transition recommendation",
    status: ready ? "ready" : "warning",
    detail: `${transition.action}${transition.targetNode ? ` -> ${transition.targetNode}` : ""}: ${transition.reason}`
  };
}

function buildEvidenceBundleCheck(input: ReviewPacketBuildInput): ReviewPacketCheck {
  const missing: string[] = [];
  if (!input.evidenceStorePresent) {
    missing.push("evidence_store.jsonl");
  }
  if (!input.experimentPlanPresent) {
    missing.push("experiment_plan.yaml");
  }

  return {
    id: "evidence_bundle",
    label: "Evidence bundle",
    status: missing.length > 0 ? "blocking" : "ready",
    detail:
      missing.length > 0
        ? `Missing required paper inputs: ${missing.join(", ")}.`
        : "Evidence store and experiment plan are available for paper drafting."
  };
}

function buildLiteratureTraceCheck(input: ReviewPacketBuildInput): ReviewPacketCheck {
  const missing: string[] = [];
  if (!input.corpusPresent) {
    missing.push("corpus.jsonl");
  }
  if (!input.paperSummariesPresent) {
    missing.push("paper_summaries.jsonl");
  }
  if (!input.hypothesesPresent) {
    missing.push("hypotheses.jsonl");
  }

  return {
    id: "literature_traceability",
    label: "Literature traceability",
    status: missing.length > 0 ? "warning" : "ready",
    detail:
      missing.length > 0
        ? `Missing upstream literature artifacts: ${missing.join(", ")}.`
        : "Corpus, paper summaries, and hypotheses are present for reviewer traceability."
  };
}

function buildExecutionRecordCheck(
  report: AnalysisReport,
  input: ReviewPacketBuildInput
): ReviewPacketCheck {
  const executedTrials =
    report.statistical_summary?.executed_trials ??
    report.execution_summary?.observation_count ??
    0;
  const totalTrials = report.statistical_summary?.total_trials ?? executedTrials;

  if (executedTrials <= 0) {
    return {
      id: "execution_record",
      label: "Execution record",
      status: "blocking",
      detail: "No executed trials were recorded in result_analysis.json."
    };
  }

  if (!input.metricsPresent) {
    return {
      id: "execution_record",
      label: "Execution record",
      status: "warning",
      detail: `Executed ${executedTrials}/${totalTrials} trial(s), but metrics.json is missing.`
    };
  }

  return {
    id: "execution_record",
    label: "Execution record",
    status: "ready",
    detail: `Executed ${executedTrials}/${totalTrials} trial(s) with metrics.json available.`
  };
}

function buildFailureReviewCheck(failures: AnalysisFailureCategory[]): ReviewPacketCheck {
  const observedHigh = failures.filter((item) => item.status === "observed" && item.severity === "high");
  const observedMedium = failures.filter((item) => item.status === "observed" && item.severity === "medium");
  const highRisk = failures.filter((item) => item.status === "risk" && item.severity === "high");
  const topIssue = observedHigh[0] || observedMedium[0] || highRisk[0];

  if (observedHigh.length > 0) {
    return {
      id: "failure_review",
      label: "Observed failures",
      status: "blocking",
      detail: summarizeFailureDetail(topIssue, `${observedHigh.length} high-severity observed issue(s) remain unresolved.`)
    };
  }

  if (observedMedium.length > 0 || highRisk.length > 0) {
    return {
      id: "failure_review",
      label: "Observed failures",
      status: "warning",
      detail: summarizeFailureDetail(
        topIssue,
        `${observedMedium.length} medium observed and ${highRisk.length} high-risk issue(s) need human review.`
      )
    };
  }

  return {
    id: "failure_review",
    label: "Observed failures",
    status: "ready",
    detail: "No high-severity observed failures or high-risk gaps were reported."
  };
}

function buildNarrativeCheck(
  report: AnalysisReport,
  input: ReviewPacketBuildInput
): ReviewPacketCheck {
  const claimCount = report.paper_claims?.length || 0;
  const synthesisReady = input.synthesisPresent && Boolean(report.synthesis?.confidence_statement);
  const ready = synthesisReady && claimCount > 0;

  return {
    id: "paper_narrative",
    label: "Paper narrative inputs",
    status: ready ? "ready" : "warning",
    detail: ready
      ? `Synthesis and ${claimCount} grounded paper claim(s) are ready for drafting.`
      : `Synthesis or grounded paper claims are incomplete (claims=${claimCount}, synthesis=${synthesisReady ? "present" : "missing"}).`
  };
}

function buildSuggestedActions(
  action: string | undefined,
  checks: Pick<ReviewPacketCheck, "status">[]
): string[] {
  const readiness = summarizeReviewReadiness(checks);
  if (readiness.blocking_checks > 0) {
    return ["/agent transition", "/agent apply", "/agent jump analyze_results"];
  }
  if (action === "advance") {
    return ["/approve", "/agent run write_paper"];
  }
  if (action?.startsWith("backtrack_")) {
    return ["/agent apply", "/agent transition", "/agent jump analyze_results"];
  }
  return ["/agent transition", "/approve"];
}

function normalizeReviewCheck(value: unknown, index: number): ReviewPacketCheck | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const status = normalizeCheckStatus(record.status);
  return {
    id: asString(record.id) || `check_${index + 1}`,
    label: asString(record.label) || `Check ${index + 1}`,
    status,
    detail: asString(record.detail) || ""
  };
}

function normalizeRecommendation(value: unknown): ReviewPacketRecommendation | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const action = asString(record.action);
  const reason = asString(record.reason);
  if (!action || !reason) {
    return undefined;
  }

  return {
    action,
    target: asString(record.target),
    confidence_pct: asNumber(record.confidence_pct) ?? 0,
    reason,
    evidence: Array.isArray(record.evidence)
      ? record.evidence.filter((item): item is string => typeof item === "string").slice(0, 3)
      : []
  };
}

function normalizeReadiness(
  value: unknown,
  fallback: ReviewPacket["readiness"]
): ReviewPacket["readiness"] {
  const record = asRecord(value);
  if (!record) {
    return fallback;
  }

  const status = asString(record.status);
  return {
    status: status === "ready" || status === "warning" || status === "blocking" ? status : fallback.status,
    ready_checks: asNumber(record.ready_checks) ?? fallback.ready_checks,
    warning_checks: asNumber(record.warning_checks) ?? fallback.warning_checks,
    blocking_checks: asNumber(record.blocking_checks) ?? fallback.blocking_checks,
    manual_checks: asNumber(record.manual_checks) ?? fallback.manual_checks
  };
}

function labelReviewAction(command: string): string {
  switch (command) {
    case "/approve":
      return "Approve review";
    case "/agent run write_paper":
      return "Run write_paper";
    case "/agent apply":
      return "Apply transition";
    case "/agent transition":
      return "Show transition";
    case "/agent jump analyze_results":
      return "Jump analyze_results";
    default:
      return command.replace(/^\//, "");
  }
}

function summarizeFailureDetail(
  issue: AnalysisFailureCategory | undefined,
  fallback: string
): string {
  if (!issue) {
    return fallback;
  }
  const action = issue.recommended_action ? ` Next: ${issue.recommended_action}` : "";
  return `${issue.summary}${action}`;
}

function normalizeCheckStatus(value: unknown): ReviewCheckStatus {
  switch (value) {
    case "ready":
    case "warning":
    case "blocking":
    case "manual":
      return value;
    default:
      return "manual";
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
