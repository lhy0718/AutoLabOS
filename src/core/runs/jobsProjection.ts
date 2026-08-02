import path from "node:path";
import { promises as fs } from "node:fs";

import {
  ExperimentNetworkPolicy,
  ExperimentNetworkPurpose,
  GraphNodeId,
  RunLifecycleStatus,
  RunOperatorStatusArtifact,
  RunJobFailureAggregate,
  RunJobProjection,
  RunJobsSnapshot,
  RunRecord,
  RunRecommendedNextAction,
  RunEvidenceReadinessProjection,
  RunResearchFunnelProjection,
  WorkflowApprovalMode
} from "../../types.js";
import { fileExists } from "../../utils/fs.js";
import { parseAnalysisReport } from "../resultAnalysis.js";
import { formatReadinessRiskSection, parseReadinessRiskArtifact, type ReadinessRiskArtifact } from "../readinessRisks.js";
import { loadResearchFunnelProjection, type ResearchFunnelProjection } from "./researchFunnelProjection.js";
import { buildRunOperatorStatus } from "./runStatus.js";

interface ReviewPacketProjection {
  readiness?: {
    status?: "ready" | "warning" | "blocking";
  };
  decision?: {
    outcome?: string;
    recommended_transition?: string;
  };
}

interface ReviewScorecardProjection {
  overall_score_1_to_5?: number;
}

interface FailureSeed {
  key: string;
  summary: string;
  remediation: string;
}

interface RunJobProjectionInternal extends RunJobProjection {
  dominantFailure?: FailureSeed;
}

export interface AnalyzeResultsOperatorSummary {
  run_id: string;
  title: string;
  current_node: GraphNodeId;
  lifecycle_status: RunLifecycleStatus;
  analysis_ready: boolean;
  review_ready: boolean;
  paper_ready: boolean;
  recommended_next_action: RunRecommendedNextAction;
  blocker_summary?: string;
  lines: string[];
  artifact_refs: Array<{
    label: string;
    path: string;
  }>;
}

export interface JobsCommandArgs {
  query?: string;
  template?: "3d" | "7d";
}

export async function buildRunJobsSnapshot(input: {
  workspaceRoot: string;
  runs: RunRecord[];
  approvalMode: WorkflowApprovalMode;
  networkPolicy?: ExperimentNetworkPolicy;
  networkPurpose?: ExperimentNetworkPurpose;
}): Promise<RunJobsSnapshot> {
  const projected = await Promise.all(
    input.runs.map((run) =>
      buildRunJobProjectionInternal({
        workspaceRoot: input.workspaceRoot,
        run,
        approvalMode: input.approvalMode,
        networkPolicy: input.networkPolicy,
        networkPurpose: input.networkPurpose
      })
    )
  );

  return {
    generated_at: new Date().toISOString(),
    runs: projected
      .sort((left, right) => Date.parse(right.last_event_at) - Date.parse(left.last_event_at))
      .map(stripInternalProjection),
    top_failures: summarizeFailures(projected)
  };
}

export async function buildAnalyzeResultsOperatorSummary(input: {
  workspaceRoot: string;
  run: RunRecord;
  approvalMode: WorkflowApprovalMode;
  networkPolicy?: ExperimentNetworkPolicy;
  networkPurpose?: ExperimentNetworkPurpose;
}): Promise<AnalyzeResultsOperatorSummary> {
  const projected = await buildRunJobProjectionInternal(input);
  const runDir = buildRunDir(input.workspaceRoot, input.run.id);
  const analysisReport = await readAnalysisReport(path.join(runDir, "result_analysis.json"));
  const transitionRecommendation = await readJsonArtifact<Record<string, unknown>>(
    path.join(runDir, "transition_recommendation.json")
  );
  const reviewPacket = await readJsonArtifact<ReviewPacketProjection>(
    path.join(runDir, "review", "review_packet.json")
  );
  const reviewScorecard = await readJsonArtifact<ReviewScorecardProjection>(
    path.join(runDir, "review", "scorecard.json")
  );

  const artifactRefs = [
    maybeArtifactRef(projected.analysis_ready, "Analysis report", "result_analysis.json"),
    maybeArtifactRef(projected.analysis_ready, "Transition recommendation", "transition_recommendation.json"),
    maybeArtifactRef(Boolean(reviewPacket), "Review packet", "review/review_packet.json"),
    maybeArtifactRef(Boolean(reviewScorecard), "Review scorecard", "review/scorecard.json"),
    maybeArtifactRef(projected.review_ready, "Paper critique", "review/paper_critique.json"),
    maybeArtifactRef(projected.review_ready, "Review minimum gate", "review/minimum_gate.json"),
    maybeArtifactRef(projected.review_ready, "Review readiness risks", "review/readiness_risks.json"),
    maybeArtifactRef(projected.paper_ready || Boolean(projected.paper_readiness_state), "Paper readiness", "paper/paper_readiness.json"),
    maybeArtifactRef(await fileExists(path.join(runDir, "run_status.json")), "Run status", "run_status.json"),
    ...(projected.evidence_adequacy?.artifact_refs.map(({ label, path: artifactPath }) => ({
      label,
      path: artifactPath
    })) || [])
  ].filter((item): item is { label: string; path: string } => Boolean(item));

  const lines = [
    `Analyze-results operator view for ${input.run.id}.`,
    `Lifecycle: ${projected.lifecycle_status} at ${projected.current_node}.`,
    `Readiness: analysis=${yesNo(projected.analysis_ready)}, review=${yesNo(projected.review_ready)}, paper=${yesNo(projected.paper_ready)}.`
  ];

  if (analysisReport?.overview?.objective_summary) {
    lines.push(`Objective: ${compactOneLine(analysisReport.overview.objective_summary, 180)}`);
  }

  if (transitionRecommendation?.action && typeof transitionRecommendation.action === "string") {
    const target =
      typeof transitionRecommendation.targetNode === "string" && transitionRecommendation.targetNode.length > 0
        ? ` -> ${transitionRecommendation.targetNode}`
        : "";
    lines.push(`Transition: ${transitionRecommendation.action}${target}.`);
  }

  if (!projected.review_ready) {
    lines.push("Review gate: not started yet or still missing one of the required review artifacts.");
  } else if (projected.review_gate_label || projected.review_decision_outcome || projected.review_gate_status) {
    lines.push(`Review gate: ${projected.review_gate_label || projected.review_gate_status}.`);
  }

  if (typeof projected.review_score_overall === "number") {
    lines.push(`Review scorecard: ${projected.review_score_overall}/5 overall.`);
  }

  if (projected.paper_gate_label || projected.paper_readiness_state) {
    lines.push(`Paper readiness state: ${projected.paper_gate_label || projected.paper_readiness_state}.`);
  }

  if (projected.blocker_summary) {
    lines.push(`Blocker: ${projected.blocker_summary}`);
  }

  if (projected.network_dependency?.enabled || projected.network_dependency?.severity === "blocking") {
    lines.push(`Network dependency: ${projected.network_dependency.operator_label}.`);
  }

  lines.push(`Next: ${projected.recommended_next_action}.`);

  return {
    run_id: projected.run_id,
    title: projected.title,
    current_node: projected.current_node,
    lifecycle_status: projected.lifecycle_status,
    analysis_ready: projected.analysis_ready,
    review_ready: projected.review_ready,
    paper_ready: projected.paper_ready,
    recommended_next_action: projected.recommended_next_action,
    blocker_summary: projected.blocker_summary,
    lines,
    artifact_refs: artifactRefs
  };
}

export function buildJobsTemplateLines(input: {
  snapshot: RunJobsSnapshot;
  window: "3d" | "7d";
}): string[] {
  const activeCount = input.snapshot.runs.filter((run) => run.lifecycle_status !== "completed").length;
  const blockedCount = input.snapshot.runs.filter((run) => run.recommended_next_action === "inspect_blocker").length;
  const reviewPendingCount = input.snapshot.runs.filter(
    (run) => run.recommended_next_action === "resume_review" || run.current_node === "review"
  ).length;
  const paperBlockedCount = input.snapshot.runs.filter(
    (run) => Boolean(run.paper_readiness_state) && !run.paper_ready
  ).length;
  return [
    `${input.window === "3d" ? "3-day" : "7-day"} operator check-in template`,
    `Runs in view: ${input.snapshot.runs.length}. Active: ${activeCount}. Blocked for inspection: ${blockedCount}.`,
    `Review-adjacent runs: ${reviewPendingCount}. Paper-blocked runs: ${paperBlockedCount}.`,
    "1. Confirm the current_node and recommended_next_action for the top active runs.",
    "2. Inspect one blocker artifact before retrying any failed or paused run.",
    "3. Verify whether review is the next governed gate before treating a run as paper-ready.",
    `4. Review the top recurring failure: ${input.snapshot.top_failures[0]?.reason || "No recurring blocker is currently dominant."}`
  ];
}

export function parseJobsCommandArgs(args: string[]): JobsCommandArgs {
  const templateIndex = args.findIndex((arg) => arg === "--template");
  if (templateIndex >= 0) {
    const value = args[templateIndex + 1];
    if (value === "3d" || value === "7d") {
      return {
        template: value,
        query: args
          .filter((_, index) => index !== templateIndex && index !== templateIndex + 1)
          .join(" ")
          .trim() || undefined
      };
    }
  }

  return {
    query: args.join(" ").trim() || undefined
  };
}

async function buildRunJobProjectionInternal(input: {
  workspaceRoot: string;
  run: RunRecord;
  approvalMode: WorkflowApprovalMode;
  networkPolicy?: ExperimentNetworkPolicy;
  networkPurpose?: ExperimentNetworkPurpose;
}): Promise<RunJobProjectionInternal> {
  const runDir = buildRunDir(input.workspaceRoot, input.run.id);
  const [status, researchFunnel, evidenceDiagnostic] = await Promise.all([
    loadOrBuildRunStatus(input),
    loadResearchFunnelProjection(runDir, {
      runId: input.run.id,
      researchCycle: input.run.graph.researchCycle ?? 0
    }),
    loadEvidenceReadinessDiagnostic(runDir, input.run.id)
  ]);
  return projectRunStatus(
    status,
    researchFunnel,
    authorizeEvidenceReadiness(evidenceDiagnostic, status.analysis_ready)
  );
}

function stripInternalProjection(input: RunJobProjectionInternal): RunJobProjection {
  return {
    run_id: input.run_id,
    title: input.title,
    current_node: input.current_node,
    lifecycle_status: input.lifecycle_status,
    approval_mode: input.approval_mode,
    last_event_at: input.last_event_at,
    recommended_next_action: input.recommended_next_action,
    analysis_ready: input.analysis_ready,
    review_ready: input.review_ready,
    paper_ready: input.paper_ready,
    review_gate_status: input.review_gate_status,
    review_decision_outcome: input.review_decision_outcome,
    review_recommended_transition: input.review_recommended_transition,
    review_score_overall: input.review_score_overall,
    paper_readiness_state: input.paper_readiness_state,
    paper_readiness_reason: input.paper_readiness_reason,
    blocker_summary: input.blocker_summary,
    review_gate_label: input.review_gate_label,
    paper_gate_label: input.paper_gate_label,
    blocking_reasons: input.blocking_reasons,
    warning_reasons: input.warning_reasons,
    network_dependency: input.network_dependency,
    validation_scope: input.validation_scope,
    research_funnel: input.research_funnel,
    evidence_readiness: input.evidence_readiness,
    evidence_adequacy: input.evidence_adequacy,
    review_assurance: input.review_assurance
  };
}

function summarizeFailures(input: RunJobProjectionInternal[]): RunJobFailureAggregate[] {
  const grouped = new Map<
    string,
    { summary: string; remediation: string; count: number }
  >();
  const failingRuns = input.filter((run) => Boolean(run.dominantFailure));
  for (const run of failingRuns) {
    if (!run.dominantFailure) {
      continue;
    }
    const current = grouped.get(run.dominantFailure.key) || {
      summary: run.dominantFailure.summary,
      remediation: run.dominantFailure.remediation,
      count: 0
    };
    current.count += 1;
    grouped.set(run.dominantFailure.key, current);
  }

  const denominator = Math.max(1, failingRuns.length);
  return [...grouped.entries()]
    .map(([key, value]) => ({
      key,
      reason: value.summary,
      occurrence_count: value.count,
      recurrence_probability: Number((value.count / denominator).toFixed(2)),
      remediation: value.remediation
    }))
    .sort((left, right) => right.occurrence_count - left.occurrence_count || left.reason.localeCompare(right.reason))
    .slice(0, 3);
}

async function readAnalysisReport(filePath: string) {
  const raw = await readTextArtifact(filePath);
  return raw ? parseAnalysisReport(raw) : undefined;
}

async function readJsonArtifact<T>(filePath: string): Promise<T | undefined> {
  const raw = await readTextArtifact(filePath);
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function readTextArtifact(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function maybeArtifactRef(
  enabled: boolean,
  label: string,
  artifactPath: string
): { label: string; path: string } | undefined {
  if (!enabled) {
    return undefined;
  }
  return { label, path: artifactPath };
}

function buildRunDir(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, ".autolabos", "runs", runId);
}

function compactOneLine(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function formatRecommendedNextAction(action: RunRecommendedNextAction): string {
  switch (action) {
    case "inspect_blocker":
      return "Inspect blocker";
    case "resume_review":
      return "Resume review";
    case "rerun_after_fix":
      return "Rerun after fix";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Completed";
  }
  return action;
}

export function formatRunJobLifecycleStatus(status: RunLifecycleStatus): string {
  switch (status) {
    case "needs_approval":
      return "Needs approval";
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
  }
  return status;
}

export function formatRunJobProjectionLines(input: {
  projection: RunJobProjection;
}): string[] {
  const lines = [
    `${input.projection.run_id} | ${input.projection.title} | ${input.projection.current_node} | ${input.projection.lifecycle_status} | ${input.projection.approval_mode}`,
    `  readiness: analysis=${yesNo(input.projection.analysis_ready)} review=${yesNo(input.projection.review_ready)} paper=${yesNo(input.projection.paper_ready)} | next=${input.projection.recommended_next_action}`,
    `  last event: ${input.projection.last_event_at}`
  ];
  if (input.projection.review_gate_status || input.projection.review_decision_outcome || typeof input.projection.review_score_overall === "number") {
    const gateLabel =
      input.projection.review_gate_label
      || (input.projection.review_decision_outcome
        ? `${input.projection.review_decision_outcome}${input.projection.review_recommended_transition ? ` -> ${input.projection.review_recommended_transition}` : ""}`
        : input.projection.review_gate_status || "missing");
    const scoreLabel = typeof input.projection.review_score_overall === "number"
      ? ` | score=${input.projection.review_score_overall}/5`
      : "";
    lines.push(`  review gate: ${gateLabel}${scoreLabel}`);
  }
  if (input.projection.review_assurance) {
    const assurance = input.projection.review_assurance;
    if (assurance.status === "not_started") {
      lines.push("  review assurance: not started");
    } else if (assurance.status === "missing") {
      lines.push(
        `  review assurance: status=missing paper_ready_eligible=${yesNo(assurance.paper_ready_eligible)}`
      );
    } else {
      lines.push(
        `  review assurance: status=${assurance.status} trusted=${yesNo(assurance.trusted)} paper_ready_eligible=${yesNo(assurance.paper_ready_eligible)} input_manifest_valid=${yesNo(assurance.input_manifest_valid)} gate_report_valid=${yesNo(assurance.gate_report_valid)} handoff_valid=${yesNo(assurance.handoff_valid)} model_bundle_valid=${yesNo(assurance.model_review_bundle_valid)}`
      );
    }
    if (assurance.reason_codes.length > 0) {
      lines.push(`  review assurance reasons: ${assurance.reason_codes.join(", ")}`);
    }
    if (assurance.artifact_refs.length > 0) {
      lines.push(
        `  review assurance artifacts: ${assurance.artifact_refs
          .map((artifact) => `${artifact.kind}=${artifact.path}`)
          .join(" | ")}`
      );
    }
  }
  if (input.projection.paper_readiness_state) {
    const paperDetail = input.projection.paper_readiness_reason
      ? ` | ${compactOneLine(input.projection.paper_readiness_reason, 120)}`
      : "";
    lines.push(`  paper state: ${input.projection.paper_gate_label || input.projection.paper_readiness_state}${paperDetail}`);
  }
  if (input.projection.evidence_readiness) {
    const evidence = input.projection.evidence_readiness;
    const primary = evidence.primary_comparison_id
      ? ` primary=${evidence.primary_comparison_id}`
      : " primary=unmeasured";
    lines.push(
      `  evidence readiness: status=${evidence.status} ready=${yesNo(evidence.evidence_ready)} trusted=${yesNo(evidence.trusted)} comparisons=${evidence.comparison_count}${primary}`
    );
  }
  if (input.projection.evidence_adequacy) {
    const adequacy = input.projection.evidence_adequacy;
    const primary = adequacy.primary_comparison_id || "unmeasured";
    const overall = adequacy.overall_status || "unmeasured";
    lines.push(
      `  evidence adequacy: status=${adequacy.status} trusted=${yesNo(adequacy.trusted)} integrity_valid=${yesNo(adequacy.integrity_valid)} paper_evidence_allowed=${yesNo(adequacy.paper_evidence_allowed)} overall=${overall} primary=${primary}`
    );
    if (adequacy.reason_codes.length > 0) {
      lines.push(`  evidence adequacy reasons: ${adequacy.reason_codes.join(", ")}`);
    }
    if (adequacy.artifact_refs.length > 0) {
      lines.push(
        `  evidence adequacy artifacts: ${adequacy.artifact_refs
          .map((artifact) => `${artifact.kind}=${artifact.path}`)
          .join(" | ")}`
      );
    }
  }
  if (input.projection.research_funnel) {
    const funnel = input.projection.research_funnel;
    lines.push(
      `  research funnel: mode=${funnel.research_mode} lifecycle=${funnel.lifecycle_stage} integrity=${funnel.integrity_status} authorization_disposition=${funnel.authorization_disposition} candidates=${funnel.candidate_count} clusters=${funnel.cluster_count} diagnostics_trusted=${yesNo(funnel.diagnostics_trusted)} authorization_trusted=${yesNo(funnel.authorization_trusted)} probe_candidates=${funnel.probe_candidate_count} authorization_probe=${yesNo(funnel.authorization_probe_allowed)} execution_authorized=${yesNo(funnel.effective_execution_authorized)}`
    );
    lines.push(
      `  bounded probe evidence: paper_evidence_allowed=${String(funnel.bounded_probe_paper_evidence_allowed)} | bounded probe only; not paper evidence`
    );
    if (funnel.outcome_disposition || funnel.outcome_next_action) {
      lines.push(
        `  post-probe outcome: disposition=${funnel.outcome_disposition || "unmeasured"} next_action=${funnel.outcome_next_action || "unmeasured"}`
      );
    }
    lines.push(
      `  outcome gate: status=${funnel.outcome_gate.status} trusted=${yesNo(funnel.outcome_gate.trusted)}`
    );
    lines.push(
      `  follow-up handoff: status=${funnel.followup_handoff.status} trusted=${yesNo(funnel.followup_handoff.trusted)}`
      + `${funnel.followup_handoff.recommended_followup_mode ? ` mode=${funnel.followup_handoff.recommended_followup_mode}` : ""}`
      + `${funnel.followup_handoff.evidence_stage ? ` evidence_stage=${funnel.followup_handoff.evidence_stage}` : ""}`
    );
    lines.push(
      `  topic-probe review gate: status=${funnel.review_gate.status} trusted=${yesNo(funnel.review_gate.trusted)} paper_drafting_allowed=${String(funnel.review_gate.paper_drafting_allowed)}`
    );
    if (funnel.invalid_chain_blockers.length > 0) {
      lines.push(`  invalid-chain blockers: ${funnel.invalid_chain_blockers.join(", ")}`);
    }
    const activeProbe = readVerifiedActiveProbeProjection(funnel);
    if (activeProbe) {
      lines.push(
        `  bounded probe contract: candidate=${activeProbe.candidateId} stage=${activeProbe.evidenceStage}`
      );
      lines.push(
        `  metric boundary: ${activeProbe.primaryMetric} [unit=${activeProbe.metricUnit}; scale=${activeProbe.metricScale}] (${activeProbe.metricDirection}) | effect=${formatEffectCriterion(activeProbe.effectCriterion, activeProbe.metricDirection)}`
      );
      lines.push(`  candidate binding: sha256=${activeProbe.candidateHash} | deferred=${activeProbe.deferredCandidateIds.join(",") || "none"}`);
      lines.push(`  objective binding: ${compactOneLine(activeProbe.objectiveRaw, 180)}`);
      if (activeProbe.meaningfulEffect) {
        lines.push(`  effect note: ${compactOneLine(activeProbe.meaningfulEffect, 180)}`);
      }
      lines.push(
        `  probe contract: ${activeProbe.contractArtifactPath} | sha256=${activeProbe.contractHash}`
      );
    }
    const probeStatement = funnel.probe_candidate_statements[0];
    if (probeStatement) {
      lines.push(`  bounded probe candidate: ${compactOneLine(probeStatement, 180)}`);
    }
    const shouldSurfaceReasons =
      funnel.integrity_status === "partial"
      || funnel.integrity_status === "mismatch"
      || funnel.authorization_disposition === "backtrack_to_hypotheses";
    if (shouldSurfaceReasons && funnel.reason_codes.length > 0) {
      lines.push(
        `  research funnel reasons: ${funnel.reason_codes.join(", ")}`
      );
    }
    for (const gate of funnel.gates.filter((item) => item.status === "block")) {
      lines.push(
        `  blocked gate: ${gate.code} scope=${gate.scope} trusted=${yesNo(gate.trusted)} | ${compactOneLine(gate.message, 180)}`
      );
    }
    for (const dissent of funnel.dissent.filter((item) => item.hard_block)) {
      lines.push(
        `  reviewer hard block: ${dissent.reviewer_label || dissent.reviewer_id || dissent.source} candidate=${dissent.candidate_id} trusted=${yesNo(dissent.trusted)} | ${compactOneLine(dissent.summary, 180)}`
      );
    }
    for (const query of funnel.literature_queries) {
      lines.push(
        `  literature query: source=${query.source} fallback=${yesNo(query.fallback)} reason=${query.source_reason} retrieved=${query.fetched ?? "unmeasured"} relevant=${query.relevant_fetched ?? "unmeasured"} selected=${query.selected ?? "unmeasured"} | ${compactOneLine(query.query, 180)}`
      );
    }
  }
  if (input.projection.network_dependency) {
    lines.push(`  network: ${input.projection.network_dependency.operator_label}`);
  }
  if (input.projection.validation_scope && input.projection.validation_scope !== "full_run") {
    lines.push(`  validation scope: ${input.projection.validation_scope}`);
  }
  if (input.projection.blocker_summary) {
    lines.push(`  blocker: ${compactOneLine(input.projection.blocker_summary, 180)}`);
  }
  return lines;
}

export function formatFailureAggregateLines(topFailures: RunJobFailureAggregate[]): string[] {
  if (topFailures.length === 0) {
    return ["Top failures: none recorded in the current jobs view."];
  }
  return [
    "Top failures:",
    ...topFailures.map(
      (failure, index) =>
        `  ${index + 1}. ${failure.reason} | recurrence=${Math.round(failure.recurrence_probability * 100)}% | remediation=${failure.remediation}`
    )
  ];
}

export function formatReadinessSummaryLine(risks: ReadinessRiskArtifact | undefined): string | undefined {
  if (!risks || risks.risk_count === 0) {
    return undefined;
  }
  const dominant = risks.risks[0];
  if (!dominant) {
    return undefined;
  }
  return `${formatReadinessRiskSection(dominant.category)}: ${compactOneLine(dominant.message, 160)}`;
}

async function loadOrBuildRunStatus(input: {
  workspaceRoot: string;
  run: RunRecord;
  approvalMode: WorkflowApprovalMode;
  networkPolicy?: ExperimentNetworkPolicy;
  networkPurpose?: ExperimentNetworkPurpose;
}): Promise<RunOperatorStatusArtifact> {
  return buildRunOperatorStatus({
    workspaceRoot: input.workspaceRoot,
    run: input.run,
    approvalMode: input.approvalMode,
    networkPolicy: input.networkPolicy,
    networkPurpose: input.networkPurpose
  });
}

function projectRunStatus(
  status: RunOperatorStatusArtifact,
  researchFunnel: ResearchFunnelProjection | undefined,
  evidenceReadiness: RunEvidenceReadinessProjection
): RunJobProjectionInternal {
  return {
    run_id: status.run_id,
    title: status.title,
    current_node: status.current_node,
    lifecycle_status: status.lifecycle_status,
    approval_mode: status.approval_mode,
    last_event_at: status.last_event_at,
    recommended_next_action: status.recommended_next_action,
    analysis_ready: status.analysis_ready,
    review_ready: status.review_ready,
    paper_ready: status.paper_ready,
    review_gate_status: status.review_gate.status,
    review_decision_outcome: status.review_gate.decision_outcome,
    review_recommended_transition: status.review_gate.recommended_transition,
    review_score_overall: status.review_gate.score_overall,
    paper_readiness_state: status.paper_gate.readiness_state,
    paper_readiness_reason: status.paper_gate.reason,
    blocker_summary: status.blocker_summary,
    review_gate_label: status.review_gate.operator_label,
    paper_gate_label: status.paper_gate.operator_label,
    blocking_reasons: [...status.blocking_reasons],
    warning_reasons: [...status.warning_reasons],
    network_dependency: status.network_dependency,
    validation_scope: status.validation_scope,
    research_funnel: researchFunnel ? projectResearchFunnel(researchFunnel) : undefined,
    evidence_readiness: evidenceReadiness,
    evidence_adequacy: status.evidence_adequacy,
    review_assurance: status.review_assurance,
    dominantFailure: status.dominant_failure
      ? {
          key: status.dominant_failure.key,
          summary: status.dominant_failure.summary,
          remediation: status.dominant_failure.remediation
        }
      : undefined
  };
}

export function projectResearchFunnel(input: ResearchFunnelProjection): RunResearchFunnelProjection {
  const candidatePriorSearch = input.candidatePriorSearch ?? {
    status: "unmeasured" as const,
    trusted: false,
    completedRounds: 0,
    maxRounds: 0,
    currentReceiptStatus: "unmeasured" as const,
    candidateCount: 0,
    selectedCandidateCount: 0,
    broadLaneAttemptCount: 0,
    recentLaneAttemptCount: 0,
    fetchedCount: 0,
    selectedPaperCount: 0,
    coveredCandidateIds: [],
    reasonCodes: [],
    artifactRefs: []
  };
  const estimatorFeasibility = input.estimatorFeasibility ?? {
    status: "unmeasured" as const,
    trusted: false,
    executionAuthorized: false,
    reasonCodes: [],
    artifactRefs: []
  };
  const portfolioCandidates = input.portfolioCandidates ?? [];
  const executionAuthorization = input.executionAuthorization ?? {
    status: "unmeasured" as const,
    trusted: false,
    authorized: false,
    base_funnel_authorized: false,
    candidate_prior_search_authorized: false,
    estimator_authorized: false,
    required_candidate_ids: [],
    covered_candidate_ids: [],
    reason_codes: []
  };
  const activeProbe = readVerifiedActiveProbeSource(input);
  return {
    research_mode: input.researchMode,
    lifecycle_stage: input.lifecycleStage,
    bounded_probe_paper_evidence_allowed: input.boundedProbePaperEvidenceAllowed,
    collection_state: input.collectionState,
    ...(input.collectionNodeAttempt !== undefined
      ? { collection_node_attempt: input.collectionNodeAttempt }
      : {}),
    ...(input.collectionNodeMaxAttempts !== undefined
      ? { collection_node_max_attempts: input.collectionNodeMaxAttempts }
      : {}),
    ...(input.queryPlanAttempt !== undefined
      ? { query_plan_attempt: input.queryPlanAttempt }
      : {}),
    collection_quality_failure_reasons: [...input.collectionQualityFailureReasons],
    ...(input.collectionReformulationHint
      ? {
          collection_reformulation_hint: {
            evidence_status: input.collectionReformulationHint.evidenceStatus,
            paper_evidence_allowed: input.collectionReformulationHint.paperEvidenceAllowed,
            shared_anchor_terms: [...input.collectionReformulationHint.sharedAnchorTerms],
            candidate_titles: [...input.collectionReformulationHint.candidateTitles],
            axes: input.collectionReformulationHint.axes.map((axis) => ({
              ...(axis.queryFamily ? { query_family: axis.queryFamily } : {}),
              ...(axis.query ? { query: axis.query } : {}),
              axis_terms: [...axis.axisTerms],
              ...(axis.relevantPaperCount !== undefined
                ? { relevant_paper_count: axis.relevantPaperCount }
                : {})
            })),
            ...(input.collectionReformulationHint.artifactRef
              ? { artifact_ref: { ...input.collectionReformulationHint.artifactRef } }
              : {})
          }
        }
      : {}),
    gap_evidence_audit: {
      status: input.gapEvidenceAudit.status,
      ...(input.gapEvidenceAudit.constructionMode
        ? { construction_mode: input.gapEvidenceAudit.constructionMode }
        : {}),
      ...(input.gapEvidenceAudit.synthesisStatus
        ? { synthesis_status: input.gapEvidenceAudit.synthesisStatus }
        : {}),
      ...(input.gapEvidenceAudit.analysisCoverage
        ? {
            analysis_coverage: {
              ...input.gapEvidenceAudit.analysisCoverage,
              failed_paper_ids: [...input.gapEvidenceAudit.analysisCoverage.failed_paper_ids]
            }
          }
        : {}),
      total_evidence_count: input.gapEvidenceAudit.total_evidence_count,
      scientific_evidence_count: input.gapEvidenceAudit.scientific_evidence_count,
      grounded_scientific_evidence_count: input.gapEvidenceAudit.grounded_scientific_evidence_count,
      synthesis_eligible_evidence_count: input.gapEvidenceAudit.synthesis_eligible_evidence_count,
      synthesis_excluded_evidence_count: input.gapEvidenceAudit.synthesis_excluded_evidence_count,
      accepted_cluster_count: input.gapEvidenceAudit.accepted_cluster_count,
      malformed_evidence_row_count: input.gapEvidenceAudit.malformed_evidence_row_count,
      source_scope_counts: { ...input.gapEvidenceAudit.source_scope_counts },
      grounding_status_counts: { ...input.gapEvidenceAudit.grounding_status_counts }
    },
    candidate_count: input.candidateCount,
    cluster_count: input.clusterCount,
    candidate_prior_search: {
      status: candidatePriorSearch.status,
      trusted: candidatePriorSearch.trusted,
      ...(candidatePriorSearch.action
        ? { action: candidatePriorSearch.action }
        : {}),
      completed_rounds: candidatePriorSearch.completedRounds,
      max_rounds: candidatePriorSearch.maxRounds,
      current_receipt_status: candidatePriorSearch.currentReceiptStatus,
      candidate_count: candidatePriorSearch.candidateCount,
      selected_candidate_count: candidatePriorSearch.selectedCandidateCount,
      broad_lane_attempt_count: candidatePriorSearch.broadLaneAttemptCount,
      recent_lane_attempt_count: candidatePriorSearch.recentLaneAttemptCount,
      fetched_count: candidatePriorSearch.fetchedCount,
      selected_paper_count: candidatePriorSearch.selectedPaperCount,
      covered_candidate_ids: [...candidatePriorSearch.coveredCandidateIds],
      ...(candidatePriorSearch.planHash
        ? { plan_sha256: candidatePriorSearch.planHash }
        : {}),
      ...(candidatePriorSearch.receiptHash
        ? { receipt_sha256: candidatePriorSearch.receiptHash }
        : {}),
      reason_codes: [...candidatePriorSearch.reasonCodes],
      artifact_refs: candidatePriorSearch.artifactRefs.map((ref) => ({ ...ref }))
    },
    estimator_feasibility: {
      status: estimatorFeasibility.status,
      trusted: estimatorFeasibility.trusted,
      execution_authorized: estimatorFeasibility.executionAuthorized,
      ...(estimatorFeasibility.estimandType
        ? { estimand_type: estimatorFeasibility.estimandType }
        : {}),
      ...(estimatorFeasibility.estimatorFamily
        ? { estimator_family: estimatorFeasibility.estimatorFamily }
        : {}),
      ...(estimatorFeasibility.independentClusterCount !== undefined
        ? { independent_cluster_count: estimatorFeasibility.independentClusterCount }
        : {}),
      ...(estimatorFeasibility.primaryDenominator !== undefined
        ? { primary_denominator: estimatorFeasibility.primaryDenominator }
        : {}),
      ...(estimatorFeasibility.attainableResolution !== undefined
        ? { attainable_resolution: estimatorFeasibility.attainableResolution }
        : {}),
      ...(estimatorFeasibility.plannedMinimumDetectableEffect !== undefined
        ? {
            planned_minimum_detectable_effect:
              estimatorFeasibility.plannedMinimumDetectableEffect
          }
        : {}),
      ...(estimatorFeasibility.computedMinimumDetectableEffect !== undefined
        ? {
            computed_minimum_detectable_effect:
              estimatorFeasibility.computedMinimumDetectableEffect
          }
        : {}),
      reason_codes: [...estimatorFeasibility.reasonCodes],
      artifact_refs: estimatorFeasibility.artifactRefs.map((ref) => ({ ...ref }))
    },
    topic_memory: {
      status: input.topicMemory.status,
      trusted: input.topicMemory.trusted,
      ...(input.topicMemory.ledgerHash
        ? { ledger_sha256: input.topicMemory.ledgerHash }
        : {}),
      record_count: input.topicMemory.recordCount,
      blocked_candidate_count: input.topicMemory.blockedCandidateCount,
      reentry_required_count: input.topicMemory.reentryRequiredCount,
      reentry_allowed_count: input.topicMemory.reentryAllowedCount,
      ...(input.topicMemory.auditArtifactRef
        ? { audit_artifact_ref: { ...input.topicMemory.auditArtifactRef } }
        : {}),
      ...(input.topicMemory.updateArtifactRef
        ? { update_artifact_ref: { ...input.topicMemory.updateArtifactRef } }
        : {})
    },
    diagnostics_trusted: input.diagnosticsTrusted,
    authorization_trusted: input.authorizationTrusted,
    portfolio_candidates: portfolioCandidates.map((candidate) => ({
      rank: candidate.rank,
      candidate_id: candidate.candidateId,
      topic_id: candidate.topicId,
      statement: candidate.statement,
      trusted: candidate.trusted,
      review_status: candidate.reviewStatus,
      probe_status: candidate.probeStatus,
      probe_eligible: candidate.probeEligible,
      scores: { ...candidate.scores },
      closest_prior_paper_ids: [...candidate.closestPriorPaperIds],
      closest_prior_full_text_paper_ids: [
        ...candidate.closestPriorFullTextPaperIds
      ],
      prior_absorption_comparisons: candidate.priorAbsorptionComparisons.map(
        (comparison) => ({
          prior_paper_id: comparison.priorPaperId,
          disposition: comparison.disposition
        })
      ),
      prior_absorption_reason_codes: [
        ...candidate.priorAbsorptionReasonCodes
      ],
      ...(candidate.closestPriorNonOverlap
        ? { closest_prior_non_overlap: candidate.closestPriorNonOverlap }
        : {}),
      ...(candidate.reviewerAbsorptionObjection
        ? { reviewer_absorption_objection: candidate.reviewerAbsorptionObjection }
        : {}),
      ...(candidate.comparator ? { comparator: candidate.comparator } : {}),
      ...(candidate.datasetTaskBench
        ? { dataset_task_bench: candidate.datasetTaskBench }
        : {}),
      ...(candidate.primaryMetric
        ? { primary_metric: candidate.primaryMetric }
        : {}),
      ...(candidate.localBudget ? { local_budget: candidate.localBudget } : {}),
      ...(candidate.killSignal ? { kill_signal: candidate.killSignal } : {}),
      ...(candidate.contributionClaim
        ? { contribution_claim: candidate.contributionClaim }
        : {}),
      ...(candidate.minimumPublishableEvidence
        ? { minimum_publishable_evidence: candidate.minimumPublishableEvidence }
        : {}),
      ...(candidate.reviewSummary
        ? { review_summary: candidate.reviewSummary }
        : {}),
      ...(candidate.topicMemoryDisposition
        ? { topic_memory_disposition: candidate.topicMemoryDisposition }
        : {}),
      ...(candidate.topicMemoryMaximumLineageSimilarity !== undefined
        ? {
            topic_memory_maximum_lineage_similarity:
              candidate.topicMemoryMaximumLineageSimilarity
          }
        : {}),
      blocked_gate_codes: [...candidate.blockedGateCodes]
    })),
    probe_candidate_count: input.probeCandidateCount,
    probe_candidate_ids: [...input.probeCandidateIds],
    probe_candidate_statements: [...input.probeCandidateStatements],
    ...(activeProbe
      ? {
          active_candidate_id: activeProbe.candidateId,
          active_topic_id: activeProbe.topicId,
          active_candidate_hash: activeProbe.candidateHash,
          active_primary_metric: activeProbe.primaryMetric,
          active_metric_unit: activeProbe.metricUnit,
          active_metric_scale: activeProbe.metricScale,
          active_metric_direction: activeProbe.metricDirection,
          active_effect_criterion: { ...activeProbe.effectCriterion },
          active_objective_raw: activeProbe.objectiveRaw,
          ...(activeProbe.meaningfulEffect
            ? { active_meaningful_effect: activeProbe.meaningfulEffect }
            : {}),
          active_evidence_stage: activeProbe.evidenceStage,
          active_deferred_candidate_ids: [...activeProbe.deferredCandidateIds]
        }
      : {}),
    authorization_disposition: input.authorizationDisposition,
    authorization_probe_allowed:
      input.authorizationTrusted
      && input.integrityStatus !== "mismatch"
      && input.authorizationProbeAllowed,
    effective_execution_authorized:
      input.effectiveExecutionAuthorized === true && executionAuthorization.authorized,
    execution_authorization: {
      ...executionAuthorization,
      required_candidate_ids: [...executionAuthorization.required_candidate_ids],
      covered_candidate_ids: [...executionAuthorization.covered_candidate_ids],
      reason_codes: [...executionAuthorization.reason_codes]
    },
    ...(input.outcomeDisposition
      ? { outcome_disposition: input.outcomeDisposition }
      : {}),
    ...(input.outcomeNextAction
      ? { outcome_next_action: input.outcomeNextAction }
      : {}),
    outcome_gate: {
      status: input.outcomeGate.status,
      trusted: input.outcomeGate.trusted,
      reason_codes: [...input.outcomeGate.reasonCodes],
      ...(input.outcomeGate.contentHash
        ? { content_sha256: input.outcomeGate.contentHash }
        : {}),
      ...(input.outcomeGate.artifactRef
        ? { artifact_ref: { ...input.outcomeGate.artifactRef } }
        : {})
    },
    followup_handoff: {
      status: input.followupHandoff.status,
      trusted: input.followupHandoff.trusted,
      ...(input.followupHandoff.recommendedFollowupMode
        ? { recommended_followup_mode: input.followupHandoff.recommendedFollowupMode }
        : {}),
      ...(input.followupHandoff.evidenceStage
        ? { evidence_stage: input.followupHandoff.evidenceStage }
        : {}),
      ...(input.followupHandoff.contentHash
        ? { content_sha256: input.followupHandoff.contentHash }
        : {}),
      ...(input.followupHandoff.artifactRef
        ? { artifact_ref: { ...input.followupHandoff.artifactRef } }
        : {})
    },
    review_gate: {
      status: input.reviewGate.status,
      trusted: input.reviewGate.trusted,
      paper_drafting_allowed: input.reviewGate.paperDraftingAllowed,
      reason_codes: [...input.reviewGate.reasonCodes],
      ...(input.reviewGate.contentHash
        ? { content_sha256: input.reviewGate.contentHash }
        : {}),
      ...(input.reviewGate.artifactRef
        ? { artifact_ref: { ...input.reviewGate.artifactRef } }
        : {})
    },
    invalid_chain_blockers: [...input.invalidChainBlockers],
    reason_codes: [...input.reasonCodes],
    gates: input.gates.map((gate) => ({
      scope: gate.scope,
      code: gate.code,
      status: gate.status,
      message: gate.message,
      trusted: gate.trusted,
      ...(gate.candidateId ? { candidate_id: gate.candidateId } : {})
    })),
    dissent: input.dissent.map((finding) => ({
      source: finding.source,
      candidate_id: finding.candidateId,
      hard_block: finding.hardBlock,
      summary: finding.summary,
      findings: [...finding.findings],
      trusted: finding.trusted,
      ...(finding.reviewerId ? { reviewer_id: finding.reviewerId } : {}),
      ...(finding.reviewerLabel ? { reviewer_label: finding.reviewerLabel } : {})
    })),
    literature_queries: input.literatureQueries.map((query) => ({
      query: query.query,
      source: query.source,
      source_reason: query.sourceReason,
      reason: query.reason,
      fallback: query.fallback,
      filters_relaxed: query.filtersRelaxed,
      ...(query.allocatedLimit !== undefined ? { allocated_limit: query.allocatedLimit } : {}),
      ...(query.retrievalLimit !== undefined ? { retrieval_limit: query.retrievalLimit } : {}),
      ...(query.fetched !== undefined ? { fetched: query.fetched } : {}),
      ...(query.relevantFetched !== undefined ? { relevant_fetched: query.relevantFetched } : {}),
      ...(query.selected !== undefined ? { selected: query.selected } : {})
    })),
    query_fallback_used: input.queryFallbackUsed,
    query_fallback_reasons: [...input.queryFallbackReasons],
    hashes: {
      gap_map: input.hashes.gapMap,
      topic_portfolio: input.hashes.topicPortfolio,
      topic_decision: input.hashes.topicDecision,
      ...(activeProbe
        ? { active_topic_probe_contract: activeProbe.contractHash }
        : {}),
      ...(input.hashes.topicProbeOutcome
        ? { topic_probe_outcome: input.hashes.topicProbeOutcome }
        : {}),
      ...(input.hashes.topicProbeOutcomeGate
        ? { topic_probe_outcome_gate: input.hashes.topicProbeOutcomeGate }
        : {}),
      ...(input.hashes.topicProbeFollowupHandoff
        ? { topic_probe_followup_handoff: input.hashes.topicProbeFollowupHandoff }
        : {}),
      ...(input.hashes.topicProbeReviewGate
        ? { topic_probe_review_gate: input.hashes.topicProbeReviewGate }
        : {})
    },
    artifact_refs: input.artifactRefs.map((ref) => ({
      label: ref.label,
      path: ref.path
    })),
    integrity_status: input.integrityStatus
  };
}

interface VerifiedActiveProbeProjection {
  candidateId: string;
  topicId: string;
  candidateHash: string;
  primaryMetric: string;
  metricUnit: string;
  metricScale: "raw" | "proportion" | "percent" | "percentage_point";
  metricDirection: "maximize" | "minimize";
  effectCriterion: NonNullable<RunResearchFunnelProjection["active_effect_criterion"]>;
  objectiveRaw: string;
  meaningfulEffect?: string;
  evidenceStage: "bounded_probe";
  deferredCandidateIds: string[];
  contractArtifactPath: string;
  contractHash: string;
}

function readVerifiedActiveProbeSource(
  input: ResearchFunnelProjection
): VerifiedActiveProbeProjection | undefined {
  const contractArtifact = input.artifactRefs.find(isActiveTopicProbeContractRef);
  const contractHash = input.hashes.activeTopicProbeContract;
  if (
    input.integrityStatus !== "complete"
    || !input.authorizationTrusted
    || input.authorizationDisposition !== "probe_authorized"
    || !input.authorizationProbeAllowed
    || !contractArtifact
    || !isSha256(contractHash)
    || !hasText(input.activeCandidateId)
    || !hasText(input.activeTopicId)
    || !isSha256(input.activeCandidateHash)
    || !hasText(input.activePrimaryMetric)
    || !hasText(input.activeMetricUnit)
    || !isMetricScale(input.activeMetricScale)
    || !isEffectCriterionProjection(input.activeEffectCriterion)
    || !hasText(input.activeObjectiveRaw)
    || (input.activeMetricDirection !== "maximize" && input.activeMetricDirection !== "minimize")
    || input.activeEvidenceStage !== "bounded_probe"
    || !Array.isArray(input.activeDeferredCandidateIds)
  ) {
    return undefined;
  }
  return {
    candidateId: input.activeCandidateId,
    topicId: input.activeTopicId,
    candidateHash: input.activeCandidateHash,
    primaryMetric: input.activePrimaryMetric,
    metricUnit: input.activeMetricUnit,
    metricScale: input.activeMetricScale,
    metricDirection: input.activeMetricDirection,
    effectCriterion: { ...input.activeEffectCriterion },
    objectiveRaw: input.activeObjectiveRaw,
    meaningfulEffect: input.activeMeaningfulEffect,
    evidenceStage: input.activeEvidenceStage,
    deferredCandidateIds: [...input.activeDeferredCandidateIds],
    contractArtifactPath: contractArtifact.path,
    contractHash
  };
}

function readVerifiedActiveProbeProjection(
  input: RunResearchFunnelProjection
): VerifiedActiveProbeProjection | undefined {
  const contractArtifact = input.artifact_refs.find(isActiveTopicProbeContractRef);
  const contractHash = input.hashes.active_topic_probe_contract;
  if (
    input.integrity_status !== "complete"
    || !input.authorization_trusted
    || input.authorization_disposition !== "probe_authorized"
    || !input.authorization_probe_allowed
    || !contractArtifact
    || !isSha256(contractHash)
    || !hasText(input.active_candidate_id)
    || !hasText(input.active_topic_id)
    || !isSha256(input.active_candidate_hash)
    || !hasText(input.active_primary_metric)
    || !hasText(input.active_metric_unit)
    || !isMetricScale(input.active_metric_scale)
    || !isEffectCriterionProjection(input.active_effect_criterion)
    || !hasText(input.active_objective_raw)
    || (input.active_metric_direction !== "maximize" && input.active_metric_direction !== "minimize")
    || input.active_evidence_stage !== "bounded_probe"
    || !Array.isArray(input.active_deferred_candidate_ids)
  ) {
    return undefined;
  }
  return {
    candidateId: input.active_candidate_id,
    topicId: input.active_topic_id,
    candidateHash: input.active_candidate_hash,
    primaryMetric: input.active_primary_metric,
    metricUnit: input.active_metric_unit,
    metricScale: input.active_metric_scale,
    metricDirection: input.active_metric_direction,
    effectCriterion: { ...input.active_effect_criterion },
    objectiveRaw: input.active_objective_raw,
    meaningfulEffect: input.active_meaningful_effect,
    evidenceStage: input.active_evidence_stage,
    deferredCandidateIds: [...input.active_deferred_candidate_ids],
    contractArtifactPath: contractArtifact.path,
    contractHash
  };
}

interface EvidenceReadinessDiagnostic {
  artifactPresent: boolean;
  valid: boolean;
  status: "unmeasured" | "missing" | "available" | "invalid";
  runMatches: boolean;
  comparisonCount: number;
  primaryComparisonId?: string;
  warnings: string[];
}

async function loadEvidenceReadinessDiagnostic(
  runDir: string,
  expectedRunId: string
): Promise<EvidenceReadinessDiagnostic> {
  const artifactPath = path.join(runDir, "baseline_comparison.json");
  let raw: string;
  try {
    raw = await fs.readFile(artifactPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        artifactPresent: false,
        valid: true,
        status: "unmeasured",
        runMatches: true,
        comparisonCount: 0,
        warnings: []
      };
    }
    return invalidEvidenceDiagnostic("baseline_comparison_read_error");
  }

  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) {
      return invalidEvidenceDiagnostic("baseline_comparison_not_object");
    }
    const status = value.status;
    const comparisons = Array.isArray(value.comparisons) ? value.comparisons : undefined;
    const primary = value.primary_comparison;
    if (
      value.version !== 1
      || typeof value.run_id !== "string"
      || (status !== "available" && status !== "missing")
      || !comparisons
      || !(primary === null || isRecord(primary))
      || !Array.isArray(value.warnings)
    ) {
      return invalidEvidenceDiagnostic("baseline_comparison_schema_invalid");
    }
    const primaryComparisonId = isRecord(primary) ? readText(primary.id) : undefined;
    const comparisonIds = comparisons.flatMap((comparison) => {
      const id = isRecord(comparison) ? readText(comparison.id) : undefined;
      return id ? [id] : [];
    });
    const warnings = value.warnings.flatMap((warning) => {
      const text = readText(warning);
      return text ? [text] : [];
    });
    const schemaValid = comparisonIds.length === comparisons.length
      && (!primaryComparisonId || comparisonIds.includes(primaryComparisonId));
    if (!schemaValid) {
      return invalidEvidenceDiagnostic("baseline_comparison_binding_invalid");
    }
    return {
      artifactPresent: true,
      valid: true,
      status,
      runMatches: value.run_id === expectedRunId,
      comparisonCount: comparisons.length,
      primaryComparisonId,
      warnings
    };
  } catch {
    return invalidEvidenceDiagnostic("baseline_comparison_invalid_json");
  }
}

function invalidEvidenceDiagnostic(reason: string): EvidenceReadinessDiagnostic {
  return {
    artifactPresent: true,
    valid: false,
    status: "invalid",
    runMatches: false,
    comparisonCount: 0,
    warnings: [reason]
  };
}

function authorizeEvidenceReadiness(
  diagnostic: EvidenceReadinessDiagnostic,
  analysisReady: boolean
): RunEvidenceReadinessProjection {
  if (!diagnostic.artifactPresent) {
    return {
      status: analysisReady ? "missing" : "unmeasured",
      evidence_ready: false,
      trusted: false,
      comparison_count: 0,
      warnings: analysisReady ? ["baseline_comparison_missing"] : []
    };
  }
  const trusted = diagnostic.valid && diagnostic.runMatches && analysisReady;
  return {
    status: diagnostic.status,
    evidence_ready:
      trusted
      && diagnostic.status === "available"
      && Boolean(diagnostic.primaryComparisonId),
    trusted,
    comparison_count: diagnostic.comparisonCount,
    primary_comparison_id: diagnostic.primaryComparisonId,
    warnings: [
      ...diagnostic.warnings,
      ...(!diagnostic.runMatches ? ["baseline_comparison_run_id_mismatch"] : []),
      ...(diagnostic.valid && !analysisReady ? ["baseline_comparison_not_currently_authoritative"] : [])
    ],
    artifact_ref: {
      label: "Baseline comparison",
      path: "baseline_comparison.json"
    }
  };
}

function isEffectCriterionProjection(
  value: unknown
): value is NonNullable<RunResearchFunnelProjection["active_effect_criterion"]> {
  if (!isRecord(value)) {
    return false;
  }
  return value.basis === "delta_vs_reference"
    && typeof value.magnitude === "number"
    && Number.isFinite(value.magnitude)
    && value.magnitude >= 0
    && (
      value.scale === "raw"
      || value.scale === "proportion"
      || value.scale === "percent"
      || value.scale === "percentage_point"
    )
    && typeof value.inclusive === "boolean";
}

function formatEffectCriterion(
  criterion: NonNullable<RunResearchFunnelProjection["active_effect_criterion"]>,
  direction: "maximize" | "minimize"
): string {
  const comparator = direction === "minimize"
    ? criterion.inclusive ? "<=" : "<"
    : criterion.inclusive ? ">=" : ">";
  const target = direction === "minimize" ? -criterion.magnitude : criterion.magnitude;
  return `${comparator}${target} ${criterion.scale} ${criterion.basis}`;
}

function isMetricScale(
  value: unknown
): value is "raw" | "proportion" | "percent" | "percentage_point" {
  return value === "raw"
    || value === "proportion"
    || value === "percent"
    || value === "percentage_point";
}

function isActiveTopicProbeContractRef(ref: { label: string; path: string }): boolean {
  return ref.path.endsWith("/active_topic_probe_contract.json")
    || ref.path === "active_topic_probe_contract.json";
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
