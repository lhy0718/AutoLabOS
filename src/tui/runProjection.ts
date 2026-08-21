import { AutoLabOSEvent } from "../core/events.js";
import { formatRunUsageSummary } from "../core/runs/runUsage.js";
import {
  GRAPH_NODE_ORDER,
  GraphNodeId,
  NodeStatus,
  RunRecord,
  RunResearchFunnelCollectionFailureClass,
  RunResearchFunnelProjection,
  RunStatus
} from "../types.js";

const ACTIVE_NODE_STATUSES = new Set<NodeStatus>(["running", "needs_approval"]);
const COLLECT_SUMMARY_PREFIXES = ["Semantic Scholar stored", "Artifacts cleared for collect_papers"];

export interface CollectProjectionHints {
  storedCount?: number;
  enrichmentStatus?: string;
  enrichmentTargetCount?: number;
  enrichmentProcessedCount?: number;
}

export interface AnalyzeProjectionHints {
  selectionMode?: string;
  requestedTopN?: number | null;
  selectedCount?: number;
  totalCandidates?: number;
  candidatePoolSize?: number;
  summaryCount?: number;
  evidenceCount?: number;
  fullTextCount?: number;
  abstractFallbackCount?: number;
  rerankApplied?: boolean;
  rerankFallbackReason?: string;
  selectedPaperTitle?: string;
  selectedPaperLastError?: string;
  selectedPaperSourceType?: string;
  selectedPaperFallbackReason?: string;
  selectedFailedCount?: number;
}

export interface CheckpointProjectionHints {
  seq?: number;
  phase?: "before" | "after" | "fail" | "jump" | "retry";
  createdAt?: string;
  snapshot?: RunRecord;
}

export interface ImplementProjectionHints {
  status?: string;
  stage?: string;
  message?: string;
  updatedAt?: string;
  attempt?: number;
  maxAttempts?: number;
  progressCount?: number;
  scriptPath?: string;
  publicDir?: string;
  runCommand?: string;
  testCommand?: string;
  verificationCommand?: string;
  verifyStatus?: string;
}

export interface PaperCritiqueProjectionHints {
  manuscriptType?: string;
  overallDecision?: string;
  blockingIssuesCount?: number;
  critiqueStage?: string;
  paperReadinessState?: string;
}

export interface RunProjectionHints {
  collect?: CollectProjectionHints;
  analyze?: AnalyzeProjectionHints;
  implement?: ImplementProjectionHints;
  checkpoint?: CheckpointProjectionHints;
  paperCritique?: PaperCritiqueProjectionHints;
  researchFunnel?: RunResearchFunnelProjection;
}

export interface ActiveTopicProbeDisplayProjection {
  candidateId: string;
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

export interface TopicMemoryDisplayProjection {
  status: RunResearchFunnelProjection["topic_memory"]["status"];
  trusted: boolean;
  ledgerHash?: string;
  recordCount: number;
  blockedCandidateCount: number;
  reentryRequiredCount: number;
  reentryAllowedCount: number;
  auditArtifactRef?: { label: string; path: string };
  updateArtifactRef?: { label: string; path: string };
}

export interface ResearchFunnelDisplayProjection {
  researchMode: "topic_discovery";
  lifecycleStage: RunResearchFunnelProjection["lifecycle_stage"];
  boundedProbePaperEvidenceAllowed: false;
  collectionState: RunResearchFunnelProjection["collection_state"];
  collectionNodeAttempt?: number;
  collectionNodeMaxAttempts?: number;
  queryPlanAttempt?: number;
  collectionQualityFailureReasons: string[];
  collectionReformulationHint?: NonNullable<
    RunResearchFunnelProjection["collection_reformulation_hint"]
  >;
  gapEvidenceAudit: NonNullable<RunResearchFunnelProjection["gap_evidence_audit"]>;
  integrityStatus: RunResearchFunnelProjection["integrity_status"];
  authorizationDisposition: RunResearchFunnelProjection["authorization_disposition"];
  authorizationProbeAllowed: boolean;
  effectiveExecutionAuthorized: boolean;
  executionAuthorization: RunResearchFunnelProjection["execution_authorization"];
  outcomeDisposition?: RunResearchFunnelProjection["outcome_disposition"];
  outcomeNextAction?: RunResearchFunnelProjection["outcome_next_action"];
  outcomeGate: RunResearchFunnelProjection["outcome_gate"];
  followupHandoff: RunResearchFunnelProjection["followup_handoff"];
  reviewGate: RunResearchFunnelProjection["review_gate"];
  invalidChainBlockers: string[];
  candidateCount: number;
  clusterCount: number;
  candidatePriorSearch: RunResearchFunnelProjection["candidate_prior_search"];
  estimatorFeasibility: RunResearchFunnelProjection["estimator_feasibility"];
  topicMemory: TopicMemoryDisplayProjection;
  diagnosticsTrusted: boolean;
  authorizationTrusted: boolean;
  portfolioCandidates: RunResearchFunnelProjection["portfolio_candidates"];
  reasonCodes: string[];
  gates: RunResearchFunnelProjection["gates"];
  dissent: RunResearchFunnelProjection["dissent"];
  literatureQueries: RunResearchFunnelProjection["literature_queries"];
  queryFallbackUsed: boolean;
  queryFallbackReasons: string[];
  activeProbe?: ActiveTopicProbeDisplayProjection;
}

export interface RunDisplayProjection {
  run: RunRecord;
  actionableNode: GraphNodeId;
  actionableNodeStatus: NodeStatus | undefined;
  blockedByUpstream: boolean;
  pausedRetry: boolean;
  staleLatestSummary: boolean;
  usageLimitBlocked: boolean;
  rerankFallback: boolean;
  noArtifactProgress: boolean;
  headline?: string;
  detail?: string;
  lastError?: string;
  paperCritique?: PaperCritiqueProjectionHints;
  researchFunnel?: ResearchFunnelDisplayProjection;
}

export function applyEventToRunProjection(run: RunRecord, event: AutoLabOSEvent): RunRecord {
  if (run.id !== event.runId || !event.node) {
    return run;
  }

  switch (event.type) {
    case "NODE_STARTED":
      return updateProjectedRun(run, event.node, event.timestamp, {
        runStatus: "running",
        nodeStatus: "running",
        clearNote: true,
        clearLastError: true
      });
    case "NODE_JUMP":
      return updateProjectedRun(run, event.node, event.timestamp, {
        runStatus: "paused",
        nodeStatus: "pending",
        note: buildJumpNote(event),
        clearLastError: true,
        clearPendingTransition: true
      });
    case "NODE_RETRY":
      return updateRetryCounter(
        updateProjectedRun(run, event.node, event.timestamp, {
          runStatus: "running",
          nodeStatus: "running",
          note: buildRetryNote(event),
          clearLastError: true,
          clearPendingTransition: true
        }),
        event.node,
        readNumberPayload(event.payload.attempt) ?? readNumberPayload(event.payload.attempts)
      );
    case "NODE_ROLLBACK":
      return updateRollbackCounter(
        updateProjectedRun(run, event.node, event.timestamp, {
          runStatus: "running",
          nodeStatus: "running",
          note: buildRollbackNote(event),
          clearLastError: true,
          clearPendingTransition: true
        }),
        readStringPayload(event.payload.from) as GraphNodeId | undefined,
        readNumberPayload(event.payload.rollbackCount)
      );
    case "NODE_FAILED":
      return updateRetryCounter(
        updateProjectedRun(run, event.node, event.timestamp, {
          runStatus: "failed",
          nodeStatus: "failed",
          note: readStringPayload(event.payload.error),
          lastError: readStringPayload(event.payload.error),
          clearPendingTransition: true
        }),
        event.node,
        readNumberPayload(event.payload.retryAttempt)
      );
    case "NODE_AWAITING_APPROVAL":
      return updateProjectedRun(run, event.node, event.timestamp, {
        runStatus: "paused",
        nodeStatus: "needs_approval",
        note: readStringPayload(event.payload.summary),
        clearLastError: true
      });
    case "NODE_COMPLETED":
      return updateProjectedRun(run, event.node, event.timestamp, {
        runStatus: event.node === GRAPH_NODE_ORDER[GRAPH_NODE_ORDER.length - 1] ? "completed" : undefined,
        nodeStatus: "completed",
        note: readStringPayload(event.payload.summary),
        clearLastError: true
      });
    default:
      return run;
  }
}

export function normalizeRunForDisplay(run: RunRecord, hints?: RunProjectionHints): RunRecord {
  const projected = mergeProjectedRunState(run, hints?.checkpoint?.snapshot);
  const currentNode = resolveDisplayNode(projected, hints);
  const nodeStatus = projected.graph.nodeStates[currentNode]?.status;
  const runStatus = resolveDisplayRunStatus(projected.status, nodeStatus, currentNode !== projected.currentNode);
  if (currentNode === projected.currentNode && runStatus === projected.status) {
    return projected;
  }

  return {
    ...projected,
    currentNode,
    status: runStatus,
    graph: {
      ...projected.graph,
      currentNode
    }
  };
}

export function resolveFailedNode(run: RunRecord): GraphNodeId {
  if (run.graph.nodeStates[run.currentNode]?.status === "failed") {
    return run.currentNode;
  }

  if (run.graph.currentNode !== run.currentNode && run.graph.nodeStates[run.graph.currentNode]?.status === "failed") {
    return run.graph.currentNode;
  }

  const failed = GRAPH_NODE_ORDER.filter((node) => run.graph.nodeStates[node]?.status === "failed");
  if (failed.length === 0) {
    return run.currentNode;
  }

  return failed.sort((left, right) => {
    return updatedAtMs(run.graph.nodeStates[left]?.updatedAt) - updatedAtMs(run.graph.nodeStates[right]?.updatedAt);
  })[failed.length - 1];
}

export function projectRunForDisplay(run: RunRecord, hints?: RunProjectionHints): RunDisplayProjection {
  const normalized = normalizeRunForDisplay(run, hints);
  const effectiveHints = sanitizeProjectionHints(normalized, hints);
  const actionableNode = resolveActionableNode(normalized);
  const actionableState = normalized.graph.nodeStates[actionableNode];
  const currentState = normalized.graph.nodeStates[normalized.currentNode];
  const retryCount = normalized.graph.retryCounters[actionableNode] ?? 0;
  const retryLimit = normalized.graph.retryPolicy.maxAttemptsPerNode;
  const blockedByUpstream = actionableNode !== normalized.currentNode;
  const analyzeProjectionActive = actionableNode === "analyze_papers" || normalized.currentNode === "analyze_papers";
  const pausedRetry = (normalized.status === "paused" || normalized.status === "failed") && retryCount > 0;
  const staleLatestSummary = isLatestSummaryStale(normalized, effectiveHints);
  const suppressStaleLatestSummaryDetail = shouldSuppressStaleLatestSummaryDetail(normalized, effectiveHints);
  const usageLimitDetail = resolveUsageLimitDetail([
    analyzeProjectionActive ? effectiveHints?.analyze?.selectedPaperLastError : undefined,
    analyzeProjectionActive ? effectiveHints?.analyze?.rerankFallbackReason : undefined,
    actionableState?.lastError,
    normalized.graph.nodeStates[normalized.currentNode]?.lastError
  ]);
  const usageLimitBlocked = Boolean(usageLimitDetail);
  const researchFunnel = projectResearchFunnelForDisplay(effectiveHints?.researchFunnel);
  const rerankFallback =
    analyzeProjectionActive &&
    effectiveHints?.analyze?.rerankApplied === false && Boolean(effectiveHints?.analyze?.rerankFallbackReason);
  const noArtifactProgress =
    actionableNode === "analyze_papers" &&
    (effectiveHints?.analyze?.selectedCount ?? 0) > 0 &&
    (effectiveHints?.analyze?.summaryCount ?? 0) === 0 &&
    (effectiveHints?.analyze?.evidenceCount ?? 0) === 0;
  const lastError = usageLimitDetail || actionableState?.lastError || normalized.graph.nodeStates[normalized.currentNode]?.lastError;

  let headline: string | undefined;
  if (blockedByUpstream) {
    headline = buildBlockedByUpstreamHeadline(normalized.currentNode, actionableNode, effectiveHints);
  } else if (usageLimitBlocked && pausedRetry) {
    headline = `${actionableNode} is paused after retry ${retryCount}/${retryLimit} because a model usage limit blocked progress.`;
  } else if (usageLimitBlocked) {
    headline = `${actionableNode} is blocked by a model usage-limit error.`;
  } else if (pausedRetry && noArtifactProgress) {
    headline = `${actionableNode} is paused after retry ${retryCount}/${retryLimit} with no persisted summaries or evidence.`;
  } else if (pausedRetry) {
    headline = `${actionableNode} is paused after retry ${retryCount}/${retryLimit}.`;
  } else if (noArtifactProgress) {
    headline = `${actionableNode} has started but no summaries or evidence are persisted yet.`;
  } else if (
    researchFunnel?.estimatorFeasibility.status === "blocked"
    || researchFunnel?.estimatorFeasibility.status === "invalid"
  ) {
    headline = `Experiment execution is blocked by the estimator feasibility gate (${researchFunnel.estimatorFeasibility.status}).`;
  } else if (researchFunnel?.candidatePriorSearch.status === "search_required") {
    headline = "Candidate-conditioned direct-prior search is required before probe authorization.";
  } else if (actionableNode === "implement_experiments" && effectiveHints?.implement?.message) {
    headline = toOneLine(effectiveHints.implement.message);
  } else if (actionableState?.lastError) {
    headline = `${actionableNode} error: ${toOneLine(actionableState.lastError)}`;
  } else if (actionableState?.note && !staleLatestSummary) {
    headline = toOneLine(actionableState.note);
  } else if (!staleLatestSummary && normalized.latestSummary) {
    headline = toOneLine(normalized.latestSummary);
  } else if (actionableState?.note) {
    headline = toOneLine(actionableState.note);
  }

  const detailParts: string[] = [];
  if (researchFunnel) {
    const gapAudit = researchFunnel.gapEvidenceAudit;
    if (researchFunnel.collectionState !== "unmeasured") {
      detailParts.push(formatCollectionStateDetail(researchFunnel));
    }
    if (
      researchFunnel.collectionReformulationHint
      && isActiveQueryReformulationHint(researchFunnel)
    ) {
      detailParts.push(
        formatCollectionReformulationHintDetail(
          researchFunnel.collectionReformulationHint
        )
      );
    }
    if (researchFunnel.candidatePriorSearch.status !== "unmeasured") {
      const prior = researchFunnel.candidatePriorSearch;
      detailParts.push(
        `Candidate direct-prior search: status=${prior.status}; trusted=${prior.trusted}; action=${prior.action || "unmeasured"}; rounds=${prior.completed_rounds}/${prior.max_rounds}; receipt=${prior.current_receipt_status}; lanes=broad:${prior.broad_lane_attempt_count},recent:${prior.recent_lane_attempt_count}; selected=${prior.selected_paper_count}.`
      );
    }
    if (researchFunnel.estimatorFeasibility.status !== "unmeasured") {
      const estimator = researchFunnel.estimatorFeasibility;
      detailParts.push(
        `Estimator feasibility: status=${estimator.status}; trusted=${estimator.trusted}; execution_authorized=${estimator.execution_authorized}; estimand=${estimator.estimand_type || "unmeasured"}; clusters=${estimator.independent_cluster_count ?? "unmeasured"}; reasons=${estimator.reason_codes.slice(0, 3).join(",") || "none"}.`
      );
    }
    detailParts.push(
      `Bounded topic probe evidence boundary: paper_evidence_allowed=${String(researchFunnel.boundedProbePaperEvidenceAllowed)}; bounded probe results are not paper evidence.`
    );
    detailParts.push(
      `Topic discovery lifecycle: stage=${researchFunnel.lifecycleStage}; pre_probe_authorization=${researchFunnel.authorizationDisposition}; authorization_allowed=${researchFunnel.authorizationProbeAllowed}; effective_execution_authorized=${researchFunnel.effectiveExecutionAuthorized}; execution_status=${researchFunnel.executionAuthorization.status}`
      + `${researchFunnel.outcomeDisposition ? `; outcome=${researchFunnel.outcomeDisposition}` : ""}`
      + `${researchFunnel.outcomeNextAction ? `; next_action=${researchFunnel.outcomeNextAction}` : ""}. `
      + `Gap evidence audit: status=${gapAudit.status}; total=${gapAudit.total_evidence_count}; `
      + `scientific=${gapAudit.scientific_evidence_count}; grounded_scientific=${gapAudit.grounded_scientific_evidence_count}; `
      + `eligible=${gapAudit.synthesis_eligible_evidence_count}; accepted_clusters=${gapAudit.accepted_cluster_count}. `
      + `Topic discovery portfolio: candidates=${researchFunnel.candidateCount}; clusters=${researchFunnel.clusterCount}; `
      + `diagnostics_trusted=${researchFunnel.diagnosticsTrusted}; authorization_trusted=${researchFunnel.authorizationTrusted}.`
      + formatPortfolioCandidatesDetail(researchFunnel.portfolioCandidates)
    );
    detailParts.push(
      `Topic probe gates: outcome=${researchFunnel.outcomeGate.status}; handoff=${researchFunnel.followupHandoff.status}; review=${researchFunnel.reviewGate.status}. `
      + formatTopicMemoryDetail(researchFunnel.topicMemory)
    );
  }
  if (researchFunnel?.lifecycleStage === "invalid_chain") {
    detailParts.push(
      `Topic discovery invalid chain: ${researchFunnel.invalidChainBlockers.slice(0, 5).join(",") || "unmeasured blocker"}.`
    );
  } else if (researchFunnel?.activeProbe) {
    detailParts.push(formatActiveTopicProbeDetail(researchFunnel.activeProbe));
  } else if (
    researchFunnel
    && researchFunnel.integrityStatus !== "unmeasured"
    && !researchFunnel.authorizationProbeAllowed
  ) {
    const reasons = researchFunnel.reasonCodes.slice(0, 3);
    detailParts.push(
      `Research funnel pre-probe authorization blocked: integrity=${researchFunnel.integrityStatus}`
      + `${reasons.length > 0 ? `; reasons=${reasons.join(",")}` : ""}.`
    );
  }
  if (researchFunnel) {
    const querySources = uniqueStrings(
      researchFunnel.literatureQueries.map((query) => `${query.source}:${query.source_reason}`)
    );
    if (querySources.length > 0) {
      detailParts.push(
        `Persisted literature query provenance: ${querySources.join(", ")}; fallback=${researchFunnel.queryFallbackUsed}.`
      );
    }
  }
  const lastAppliedBacktrack = [...(normalized.graph.transitionHistory || [])]
    .reverse()
    .find((entry) => entry.action.startsWith("backtrack_to_"))
    ?? (normalized.graph.lastAppliedTransition?.action.startsWith("backtrack_to_")
      ? normalized.graph.lastAppliedTransition
      : undefined);
  if (lastAppliedBacktrack && !normalized.graph.pendingTransition) {
    detailParts.push(
      `Last applied backtrack ${lastAppliedBacktrack.fromNode}->${lastAppliedBacktrack.toNode || "unmeasured"}: ${trimTrailingPunctuation(toOneLine(lastAppliedBacktrack.reason))}.`
    );
  }
  if (blockedByUpstream) {
    detailParts.push(`Retry or rerun ${actionableNode} before retrying ${normalized.currentNode}.`);
    const upstreamIssue = currentState?.lastError || actionableState?.lastError || actionableState?.note || currentState?.note;
    if (upstreamIssue) {
      detailParts.push(`Latest ${actionableNode} issue: ${toOneLine(upstreamIssue)}.`);
    }
  }
  if (staleLatestSummary && normalized.latestSummary && !suppressStaleLatestSummaryDetail) {
    detailParts.push(`Ignoring stale top-level summary: ${toOneLine(normalized.latestSummary)}.`);
  }
  const analyzeSelectionDetail =
    actionableNode === "analyze_papers" || normalized.currentNode === "analyze_papers"
      ? buildAnalyzeSelectionDetail(effectiveHints?.analyze)
      : undefined;
  if (analyzeSelectionDetail) {
    detailParts.push(analyzeSelectionDetail);
  }
  const implementProgressDetail =
    actionableNode === "implement_experiments" || normalized.currentNode === "implement_experiments"
      ? buildImplementProgressDetail(effectiveHints?.implement)
      : undefined;
  if (implementProgressDetail) {
    detailParts.push(implementProgressDetail);
  }
  if (rerankFallback) {
    detailParts.push("LLM rerank failed before a top-N shortlist was accepted.");
  }
  if (usageLimitDetail) {
    detailParts.push(`${usageLimitDetail}; switch models or wait for quota reset before retrying.`);
  } else if (actionableNode === "analyze_papers" && effectiveHints?.analyze?.selectedPaperFallbackReason) {
    const sourceType = effectiveHints.analyze.selectedPaperSourceType === "abstract" ? "abstract fallback" : "fallback";
    detailParts.push(`${sourceType} was used for the selected paper (${toOneLine(effectiveHints.analyze.selectedPaperFallbackReason)}).`);
  }
  if (!staleLatestSummary && !headline && normalized.latestSummary) {
    detailParts.push(toOneLine(normalized.latestSummary));
  }
  const usageSummary = formatRunUsageSummary(normalized.usage);
  if (usageSummary) {
    detailParts.push(usageSummary);
  }
  // Surface paper critique state when available
  const critiqueHints = effectiveHints?.paperCritique;
  if (critiqueHints?.manuscriptType && critiqueHints.manuscriptType !== "paper_ready") {
    detailParts.push(`Manuscript: ${critiqueHints.manuscriptType}.`);
  }
  if (critiqueHints?.blockingIssuesCount && critiqueHints.blockingIssuesCount > 0) {
    detailParts.push(`${critiqueHints.blockingIssuesCount} blocking critique issue(s).`);
  }
  const detail = detailParts.filter(Boolean).slice(0, 5).join(" ");

  return {
    run: normalized,
    actionableNode,
    actionableNodeStatus: actionableState?.status,
    blockedByUpstream,
    pausedRetry,
    staleLatestSummary,
    usageLimitBlocked,
    rerankFallback,
    noArtifactProgress,
    headline,
    detail: detail || undefined,
    lastError,
    paperCritique: critiqueHints,
    researchFunnel
  };
}

function sanitizeProjectionHints(run: RunRecord, hints?: RunProjectionHints): RunProjectionHints | undefined {
  if (!hints?.implement) {
    return hints;
  }

  if (!isFreshImplementHint(run, hints.implement)) {
    return {
      ...hints,
      implement: undefined
    };
  }

  return hints;
}

export function mergeProjectedRunState(run: RunRecord, projected?: RunRecord): RunRecord {
  if (!projected || projected.id !== run.id || !isRunStateFresher(projected, run)) {
    return run;
  }

  return {
    ...run,
    currentNode: projected.currentNode,
    status: projected.status,
    latestSummary: projected.latestSummary,
    nodeThreads: projected.nodeThreads,
    updatedAt: projected.updatedAt,
    graph: projected.graph
  };
}

function resolveDisplayNode(run: RunRecord, hints?: RunProjectionHints): GraphNodeId {
  const activeNodes = GRAPH_NODE_ORDER.filter((node) => ACTIVE_NODE_STATUSES.has(run.graph.nodeStates[node]?.status));
  if (activeNodes.length > 0) {
    return activeNodes.sort((left, right) => {
      return updatedAtMs(run.graph.nodeStates[left]?.updatedAt) - updatedAtMs(run.graph.nodeStates[right]?.updatedAt);
    })[activeNodes.length - 1];
  }

  if (run.graph.currentNode !== run.currentNode) {
    const graphNode = run.graph.currentNode;
    const graphNodeStatus = run.graph.nodeStates[graphNode]?.status;
    if (graphNodeStatus && graphNodeStatus !== "failed") {
      return graphNode;
    }
  }

  if (
    run.status === "failed" &&
    run.graph.nodeStates[run.currentNode]?.status !== "failed"
  ) {
    return resolveFailedNode(run);
  }

  if (hints?.analyze && run.currentNode === "analyze_papers" && run.status === "paused") {
    return "analyze_papers";
  }

  return run.currentNode;
}

function resolveActionableNode(run: RunRecord): GraphNodeId {
  const currentState = run.graph.nodeStates[run.currentNode];
  const upstreamNode =
    extractUpstreamDependencyNode(currentState?.lastError) || extractUpstreamDependencyNode(currentState?.note);
  if (upstreamNode) {
    return upstreamNode;
  }
  return run.currentNode;
}

function resolveDisplayRunStatus(runStatus: RunStatus, nodeStatus: NodeStatus | undefined, nodeChanged: boolean): RunStatus {
  if (nodeStatus === "running") {
    return "running";
  }
  if (nodeStatus === "needs_approval") {
    return "paused";
  }
  if (nodeChanged && nodeStatus === "pending" && (runStatus === "failed" || runStatus === "running")) {
    return "paused";
  }
  return runStatus;
}

function isFreshImplementHint(run: RunRecord, hints: ImplementProjectionHints): boolean {
  const implementState = run.graph.nodeStates.implement_experiments;
  const implementActive =
    run.currentNode === "implement_experiments" || ACTIVE_NODE_STATUSES.has(implementState?.status);
  if (!implementActive) {
    return true;
  }

  const hintUpdatedAt = updatedAtMs(hints.updatedAt);
  const stateUpdatedAt = updatedAtMs(implementState?.updatedAt);
  if (hintUpdatedAt === Number.NEGATIVE_INFINITY || stateUpdatedAt === Number.NEGATIVE_INFINITY) {
    return true;
  }

  return hintUpdatedAt >= stateUpdatedAt;
}

function updateProjectedRun(
  run: RunRecord,
  node: GraphNodeId,
  updatedAt: string,
  options: {
    runStatus?: RunStatus;
    nodeStatus?: NodeStatus;
    note?: string;
    lastError?: string;
    clearNote?: boolean;
    clearLastError?: boolean;
    clearPendingTransition?: boolean;
  }
): RunRecord {
  const currentState = run.graph.nodeStates[node];
  const nextState = {
    ...currentState,
    updatedAt,
    status: options.nodeStatus ?? currentState.status,
    note: options.clearNote ? undefined : (options.note ?? currentState.note),
    lastError: options.clearLastError ? undefined : (options.lastError ?? currentState.lastError)
  };

  return {
    ...run,
    currentNode: node,
    status: options.runStatus ?? run.status,
    updatedAt,
    graph: {
      ...run.graph,
      currentNode: node,
      pendingTransition: options.clearPendingTransition ? undefined : run.graph.pendingTransition,
      nodeStates: {
        ...run.graph.nodeStates,
        [node]: nextState
      }
    }
  };
}

function updateRetryCounter(run: RunRecord, node: GraphNodeId, attempt?: number): RunRecord {
  if (typeof attempt !== "number" || !Number.isFinite(attempt) || attempt <= 0) {
    return run;
  }

  return {
    ...run,
    graph: {
      ...run.graph,
      retryCounters: {
        ...run.graph.retryCounters,
        [node]: attempt
      }
    }
  };
}

function updateRollbackCounter(run: RunRecord, node: GraphNodeId | undefined, count?: number): RunRecord {
  if (!node || !GRAPH_NODE_ORDER.includes(node) || typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
    return run;
  }

  return {
    ...run,
    graph: {
      ...run.graph,
      rollbackCounters: {
        ...run.graph.rollbackCounters,
        [node]: count
      }
    }
  };
}

function buildJumpNote(event: AutoLabOSEvent): string {
  const mode = readStringPayload(event.payload.mode);
  const reason = readStringPayload(event.payload.reason);
  if (mode && reason) {
    return `Jumped (${mode}): ${reason}`;
  }
  if (mode) {
    return `Jumped (${mode})`;
  }
  return reason ? `Jumped: ${reason}` : "Jumped";
}

function buildRetryNote(event: AutoLabOSEvent): string {
  const attempt = readNumberPayload(event.payload.attempt) ?? readNumberPayload(event.payload.attempts);
  return typeof attempt === "number" ? `Retry scheduled (${attempt})` : "Retry scheduled";
}

function buildRollbackNote(event: AutoLabOSEvent): string {
  const from = readStringPayload(event.payload.from);
  return from ? `Auto rollback from ${from}` : "Auto rollback";
}

function readStringPayload(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumberPayload(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isLatestSummaryStale(run: RunRecord, hints?: RunProjectionHints): boolean {
  const summary = run.latestSummary?.trim();
  if (!summary) {
    return false;
  }

  if (run.currentNode !== "collect_papers" && COLLECT_SUMMARY_PREFIXES.some((prefix) => summary.startsWith(prefix))) {
    return true;
  }

  if (summary.includes("Deferred enrichment continues") && hints?.collect?.enrichmentStatus === "completed") {
    return true;
  }

  if (run.currentNode === "analyze_papers" && (hints?.analyze?.selectedCount ?? 0) > 0) {
    return COLLECT_SUMMARY_PREFIXES.some((prefix) => summary.startsWith(prefix));
  }

  return false;
}

function shouldSuppressStaleLatestSummaryDetail(run: RunRecord, hints?: RunProjectionHints): boolean {
  const summary = run.latestSummary?.trim();
  if (!summary || run.currentNode !== "analyze_papers") {
    return false;
  }
  if (!COLLECT_SUMMARY_PREFIXES.some((prefix) => summary.startsWith(prefix))) {
    return false;
  }

  const analyzeState = run.graph.nodeStates.analyze_papers;
  const collectState = run.graph.nodeStates.collect_papers;
  if (analyzeState?.status !== "running" || analyzeState.lastError) {
    return false;
  }

  return updatedAtMs(analyzeState.updatedAt) > updatedAtMs(collectState?.updatedAt);
}

function buildAnalyzeSelectionDetail(hints?: AnalyzeProjectionHints): string | undefined {
  if (!hints) {
    return undefined;
  }

  const parts: string[] = [];
  if (typeof hints.selectedCount === "number" && typeof hints.totalCandidates === "number") {
    parts.push(`Selected ${hints.selectedCount}/${hints.totalCandidates} paper(s) for analysis.`);
  }
  if (typeof hints.summaryCount === "number" && typeof hints.evidenceCount === "number") {
    parts.push(`Persisted ${hints.summaryCount} summary row(s) and ${hints.evidenceCount} evidence row(s).`);
  }
  return parts.join(" ");
}

function buildImplementProgressDetail(hints?: ImplementProjectionHints): string | undefined {
  if (!hints) {
    return undefined;
  }

  const parts: string[] = [];
  if (typeof hints.attempt === "number" && typeof hints.maxAttempts === "number") {
    parts.push(`Attempt ${hints.attempt}/${hints.maxAttempts}.`);
  }
  if (typeof hints.progressCount === "number" && hints.progressCount > 0) {
    parts.push(`${hints.progressCount} persisted progress update(s).`);
  }
  if (hints.verificationCommand) {
    parts.push(`Verification: ${toOneLine(hints.verificationCommand)}.`);
  } else if (hints.scriptPath) {
    parts.push(`Current script: ${displayPathTail(hints.scriptPath)}.`);
  }
  return parts.join(" ");
}

function formatCollectionStateDetail(
  funnel: ResearchFunnelDisplayProjection
): string {
  const attempt = funnel.collectionNodeAttempt !== undefined
    ? `${funnel.collectionNodeAttempt}`
      + `${funnel.collectionNodeMaxAttempts !== undefined
        ? `/${funnel.collectionNodeMaxAttempts}`
        : ""}`
    : "unmeasured";
  const qualityReasons = funnel.collectionQualityFailureReasons
    .slice(0, 2)
    .map(toOneLine);
  const failureClass = readCollectionFailureClassForDisplay(funnel);
  const semanticReviewStatus =
    funnel.collectionReformulationHint?.semantic_review_status
    ?? semanticReviewStatusForFailureClass(failureClass);
  return (
    `Topic discovery collection: state=${funnel.collectionState}; `
    + `node_attempt=${attempt}; `
    + `query_plan_attempt=${funnel.queryPlanAttempt ?? "unmeasured"}`
    + `${failureClass ? `; failure_class=${failureClass}` : ""}`
    + `${semanticReviewStatus ? `; semantic_review_status=${semanticReviewStatus}` : ""}`
    + `${qualityReasons.length > 0 ? `; quality_reasons=${qualityReasons.join(" | ")}` : ""}.`
  );
}

function formatCollectionReformulationHintDetail(
  hint: NonNullable<RunResearchFunnelProjection["collection_reformulation_hint"]>
): string {
  const titles = hint.candidate_titles.slice(0, 3).map(toOneLine);
  const axes = hint.axes
    .slice(0, 3)
    .map((axis) => axis.axis_terms.join(" "))
    .filter(Boolean);
  return (
    `Query reformulation hint: evidence_status=${hint.evidence_status}; `
    + `paper_evidence_allowed=${String(hint.paper_evidence_allowed)}; `
    + `failure_class=${hint.failure_class ?? "query_quality_failure"}; `
    + `feedback_applied=${String(hint.feedback_applied ?? true)}; `
    + `candidate_titles=${titles.length > 0 ? titles.join(" | ") : "none"}; `
    + `axes=${axes.length > 0 ? axes.join(" | ") : "none"}.`
  );
}

function boundedCollectionNodeAttempt(
  funnel: RunResearchFunnelProjection
): number | undefined {
  const attempt = funnel.collection_node_attempt;
  if (attempt === undefined) {
    return undefined;
  }
  const maxAttempts = funnel.collection_node_max_attempts;
  return maxAttempts === undefined
    ? attempt
    : Math.min(attempt, maxAttempts);
}

function isActiveQueryReformulationHint(
  funnel: ResearchFunnelDisplayProjection
): boolean {
  const hint = funnel.collectionReformulationHint;
  if (!hint || hint.active === false) {
    return false;
  }
  return readCollectionFailureClassForDisplay(funnel) === "query_quality_failure";
}

function readCollectionFailureClassForDisplay(
  funnel: ResearchFunnelDisplayProjection
): RunResearchFunnelCollectionFailureClass | undefined {
  const explicit = funnel.collectionReformulationHint?.failure_class;
  if (isCollectionFailureClass(explicit)) {
    return explicit;
  }
  const reasonCode = funnel.reasonCodes.find(isCollectionFailureClass);
  if (reasonCode) {
    return reasonCode;
  }
  const qualityReason = funnel.collectionQualityFailureReasons.join(" ");
  if (/semantic review failed operationally/iu.test(qualityReason)) {
    return "semantic_review_operational_failure";
  }
  if (/semantic review (?:was incomplete|is incomplete)/iu.test(qualityReason)) {
    return "semantic_review_incomplete";
  }
  return funnel.collectionReformulationHint
    ? "query_quality_failure"
    : undefined;
}

function isCollectionFailureClass(
  value: unknown
): value is RunResearchFunnelCollectionFailureClass {
  return value === "query_quality_failure"
    || value === "semantic_review_operational_failure"
    || value === "semantic_review_incomplete";
}

function semanticReviewStatusForFailureClass(
  failureClass: RunResearchFunnelCollectionFailureClass | undefined
): "complete" | "partial" | "operational_failure" | undefined {
  if (failureClass === "semantic_review_operational_failure") {
    return "operational_failure";
  }
  if (failureClass === "semantic_review_incomplete") {
    return "partial";
  }
  return failureClass === "query_quality_failure" ? "complete" : undefined;
}

function projectResearchFunnelForDisplay(
  funnel?: RunResearchFunnelProjection
): ResearchFunnelDisplayProjection | undefined {
  if (!funnel) {
    return undefined;
  }
  const collectionGatePassed = funnel.collection_state === "quality_gate_passed";
  const authorizationTrusted =
    funnel.authorization_trusted && collectionGatePassed;
  const probeAllowed =
    authorizationTrusted
    && funnel.integrity_status !== "mismatch"
    && funnel.authorization_probe_allowed;
  const lifecycleStage =
    funnel.lifecycle_stage === "probe_authorized" && !probeAllowed
      ? "discovery"
      : funnel.lifecycle_stage;
  const activeProbe = readVerifiedActiveTopicProbe(funnel);
  const gapEvidenceAudit = normalizeResearchGapEvidenceAudit(
    funnel.gap_evidence_audit
  );
  const candidatePriorSearch = normalizeCandidatePriorSearchProjection(
    funnel.candidate_prior_search
  );
  const estimatorFeasibility = normalizeEstimatorFeasibilityProjection(
    funnel.estimator_feasibility
  );
  const executionAuthorization = normalizeExecutionAuthorizationProjection(
    funnel.execution_authorization
  );
  return {
    researchMode: funnel.research_mode,
    lifecycleStage,
    boundedProbePaperEvidenceAllowed: funnel.bounded_probe_paper_evidence_allowed,
    collectionState: funnel.collection_state,
    collectionNodeAttempt: boundedCollectionNodeAttempt(funnel),
    collectionNodeMaxAttempts: funnel.collection_node_max_attempts,
    queryPlanAttempt: funnel.query_plan_attempt,
    collectionQualityFailureReasons: [...funnel.collection_quality_failure_reasons],
    ...(funnel.collection_reformulation_hint
      ? {
          collectionReformulationHint: {
            ...funnel.collection_reformulation_hint,
            shared_anchor_terms: [
              ...funnel.collection_reformulation_hint.shared_anchor_terms
            ],
            candidate_titles: [
              ...funnel.collection_reformulation_hint.candidate_titles
            ],
            axes: funnel.collection_reformulation_hint.axes.map((axis) => ({
              ...axis,
              axis_terms: [...axis.axis_terms]
            })),
            ...(funnel.collection_reformulation_hint.artifact_ref
              ? {
                  artifact_ref: {
                    ...funnel.collection_reformulation_hint.artifact_ref
                  }
                }
              : {})
          }
        }
      : {}),
    integrityStatus: funnel.integrity_status,
    gapEvidenceAudit: {
      ...gapEvidenceAudit,
      source_scope_counts: { ...gapEvidenceAudit.source_scope_counts },
      grounding_status_counts: { ...gapEvidenceAudit.grounding_status_counts },
      ...(gapEvidenceAudit.analysis_coverage
        ? {
            analysis_coverage: {
              ...gapEvidenceAudit.analysis_coverage,
              failed_paper_ids: [...gapEvidenceAudit.analysis_coverage.failed_paper_ids]
            }
          }
        : {})
    },
    authorizationDisposition: funnel.authorization_disposition,
    authorizationProbeAllowed: probeAllowed,
    effectiveExecutionAuthorized:
      funnel.effective_execution_authorized === true
      && executionAuthorization.authorized,
    executionAuthorization,
    outcomeDisposition: funnel.outcome_disposition,
    outcomeNextAction: funnel.outcome_next_action,
    outcomeGate: {
      ...funnel.outcome_gate,
      reason_codes: [...funnel.outcome_gate.reason_codes],
      ...(funnel.outcome_gate.artifact_ref
        ? { artifact_ref: { ...funnel.outcome_gate.artifact_ref } }
        : {})
    },
    followupHandoff: {
      ...funnel.followup_handoff,
      ...(funnel.followup_handoff.artifact_ref
        ? { artifact_ref: { ...funnel.followup_handoff.artifact_ref } }
        : {})
    },
    reviewGate: {
      ...funnel.review_gate,
      reason_codes: [...funnel.review_gate.reason_codes],
      ...(funnel.review_gate.artifact_ref
        ? { artifact_ref: { ...funnel.review_gate.artifact_ref } }
        : {})
    },
    invalidChainBlockers: [...funnel.invalid_chain_blockers],
    candidateCount: funnel.candidate_count,
    clusterCount: funnel.cluster_count,
    candidatePriorSearch: {
      ...candidatePriorSearch,
      covered_candidate_ids: [...candidatePriorSearch.covered_candidate_ids],
      reason_codes: [...candidatePriorSearch.reason_codes],
      artifact_refs: candidatePriorSearch.artifact_refs.map((ref) => ({ ...ref }))
    },
    estimatorFeasibility: {
      ...estimatorFeasibility,
      reason_codes: [...estimatorFeasibility.reason_codes],
      artifact_refs: estimatorFeasibility.artifact_refs.map((ref) => ({ ...ref }))
    },
    topicMemory: {
      status: funnel.topic_memory.status,
      trusted: funnel.topic_memory.trusted,
      ledgerHash: funnel.topic_memory.ledger_sha256,
      recordCount: funnel.topic_memory.record_count,
      blockedCandidateCount: funnel.topic_memory.blocked_candidate_count,
      reentryRequiredCount: funnel.topic_memory.reentry_required_count,
      reentryAllowedCount: funnel.topic_memory.reentry_allowed_count,
      ...(funnel.topic_memory.audit_artifact_ref
        ? { auditArtifactRef: { ...funnel.topic_memory.audit_artifact_ref } }
        : {}),
      ...(funnel.topic_memory.update_artifact_ref
        ? { updateArtifactRef: { ...funnel.topic_memory.update_artifact_ref } }
        : {})
    },
    diagnosticsTrusted: funnel.diagnostics_trusted,
    authorizationTrusted,
    portfolioCandidates: Array.isArray(funnel.portfolio_candidates)
      ? funnel.portfolio_candidates.map((candidate) => ({
          ...candidate,
          scores: { ...candidate.scores },
          closest_prior_paper_ids: [...candidate.closest_prior_paper_ids],
          closest_prior_full_text_paper_ids: [
            ...candidate.closest_prior_full_text_paper_ids
          ],
          prior_absorption_comparisons:
            candidate.prior_absorption_comparisons.map((comparison) => ({
              ...comparison
            })),
          prior_absorption_reason_codes: [
            ...candidate.prior_absorption_reason_codes
          ],
          blocked_gate_codes: [...candidate.blocked_gate_codes]
        }))
      : [],
    reasonCodes: [...funnel.reason_codes],
    gates: funnel.gates.map((gate) => ({ ...gate })),
    dissent: funnel.dissent.map((finding) => ({
      ...finding,
      findings: [...finding.findings]
    })),
    literatureQueries: funnel.literature_queries.map((query) => ({ ...query })),
    queryFallbackUsed: funnel.query_fallback_used,
    queryFallbackReasons: [...funnel.query_fallback_reasons],
    ...(activeProbe ? { activeProbe } : {})
  };
}

function normalizeCandidatePriorSearchProjection(
  value: RunResearchFunnelProjection["candidate_prior_search"] | undefined
): RunResearchFunnelProjection["candidate_prior_search"] {
  const defaults: RunResearchFunnelProjection["candidate_prior_search"] = {
    status: "unmeasured",
    trusted: false,
    completed_rounds: 0,
    max_rounds: 0,
    current_receipt_status: "unmeasured",
    candidate_count: 0,
    selected_candidate_count: 0,
    broad_lane_attempt_count: 0,
    recent_lane_attempt_count: 0,
    fetched_count: 0,
    selected_paper_count: 0,
    covered_candidate_ids: [],
    reason_codes: [],
    artifact_refs: []
  };
  return value
    ? {
        ...defaults,
        ...value,
        covered_candidate_ids: Array.isArray(value.covered_candidate_ids)
          ? [...value.covered_candidate_ids]
          : [],
        reason_codes: Array.isArray(value.reason_codes) ? [...value.reason_codes] : [],
        artifact_refs: Array.isArray(value.artifact_refs)
          ? value.artifact_refs.map((ref) => ({ ...ref }))
          : []
      }
    : defaults;
}

function normalizeExecutionAuthorizationProjection(
  value: RunResearchFunnelProjection["execution_authorization"] | undefined
): RunResearchFunnelProjection["execution_authorization"] {
  return value ?? {
    status: "unmeasured",
    trusted: false,
    authorized: false,
    base_funnel_authorized: false,
    candidate_prior_search_authorized: false,
    estimator_authorized: false,
    required_candidate_ids: [],
    covered_candidate_ids: [],
    reason_codes: []
  };
}

function normalizeEstimatorFeasibilityProjection(
  value: RunResearchFunnelProjection["estimator_feasibility"] | undefined
): RunResearchFunnelProjection["estimator_feasibility"] {
  return value ?? {
    status: "unmeasured",
    trusted: false,
    execution_authorized: false,
    reason_codes: [],
    artifact_refs: []
  };
}

function normalizeResearchGapEvidenceAudit(
  audit: RunResearchFunnelProjection["gap_evidence_audit"]
): NonNullable<RunResearchFunnelProjection["gap_evidence_audit"]> {
  return audit ?? {
    status: "unmeasured",
    total_evidence_count: 0,
    scientific_evidence_count: 0,
    grounded_scientific_evidence_count: 0,
    synthesis_eligible_evidence_count: 0,
    synthesis_excluded_evidence_count: 0,
    accepted_cluster_count: 0,
    malformed_evidence_row_count: 0,
    source_scope_counts: {
      abstract: 0,
      full_text_excerpt: 0,
      full_document: 0,
      unknown: 0
    },
    grounding_status_counts: {
      grounded_span: 0,
      ungrounded_span: 0,
      fallback: 0,
      unknown: 0
    }
  };
}

function readVerifiedActiveTopicProbe(
  funnel: RunResearchFunnelProjection
): ActiveTopicProbeDisplayProjection | undefined {
  const contractArtifact = funnel.artifact_refs.find(
    (ref) =>
      ref.path.endsWith("/active_topic_probe_contract.json")
      || ref.path === "active_topic_probe_contract.json"
  );
  const contractHash = funnel.hashes.active_topic_probe_contract;
  if (
    funnel.collection_state !== "quality_gate_passed"
    || funnel.integrity_status !== "complete"
    || !funnel.authorization_trusted
    || funnel.authorization_disposition !== "probe_authorized"
    || !funnel.authorization_probe_allowed
    || !contractArtifact
    || !isSha256(contractHash)
    || !hasText(funnel.active_candidate_id)
    || !hasText(funnel.active_topic_id)
    || !isSha256(funnel.active_candidate_hash)
    || !hasText(funnel.active_primary_metric)
    || !hasText(funnel.active_metric_unit)
    || !isMetricScale(funnel.active_metric_scale)
    || !isEffectCriterionProjection(funnel.active_effect_criterion)
    || !hasText(funnel.active_objective_raw)
    || (funnel.active_metric_direction !== "maximize" && funnel.active_metric_direction !== "minimize")
    || funnel.active_evidence_stage !== "bounded_probe"
    || !Array.isArray(funnel.active_deferred_candidate_ids)
  ) {
    return undefined;
  }
  return {
    candidateId: funnel.active_candidate_id,
    candidateHash: funnel.active_candidate_hash,
    primaryMetric: funnel.active_primary_metric,
    metricUnit: funnel.active_metric_unit,
    metricScale: funnel.active_metric_scale,
    metricDirection: funnel.active_metric_direction,
    effectCriterion: { ...funnel.active_effect_criterion },
    objectiveRaw: funnel.active_objective_raw,
    meaningfulEffect: funnel.active_meaningful_effect,
    evidenceStage: funnel.active_evidence_stage,
    deferredCandidateIds: [...funnel.active_deferred_candidate_ids],
    contractArtifactPath: contractArtifact.path,
    contractHash
  };
}

function formatActiveTopicProbeDetail(probe: ActiveTopicProbeDisplayProjection): string {
  return (
    `Bounded probe contract: candidate=${probe.candidateId}; `
    + `candidate_sha256=${probe.candidateHash}; metric=${probe.primaryMetric}; unit=${probe.metricUnit}; scale=${probe.metricScale}; `
    + `direction=${probe.metricDirection}; effect=${formatEffectCriterion(probe.effectCriterion, probe.metricDirection)}; `
    + `${probe.meaningfulEffect ? `meaningful_effect=${toOneLine(probe.meaningfulEffect)}; ` : ""}`
    + `deferred=${probe.deferredCandidateIds.join(",") || "none"}; stage=${probe.evidenceStage}; `
    + `contract=${probe.contractArtifactPath}; sha256=${probe.contractHash}.`
  );
}

function formatTopicMemoryDetail(memory: TopicMemoryDisplayProjection): string {
  const artifacts = [
    memory.auditArtifactRef?.path,
    memory.updateArtifactRef?.path
  ].filter((value): value is string => Boolean(value));
  return (
    `Topic memory: status=${memory.status}; trusted=${memory.trusted}; records=${memory.recordCount}; `
    + `blocked_candidates=${memory.blockedCandidateCount}; reentry_required=${memory.reentryRequiredCount}; `
    + `reentry_allowed=${memory.reentryAllowedCount}; ledger_sha256=${memory.ledgerHash || "unmeasured"}; `
    + `artifacts=${artifacts.join(",") || "none"}.`
  );
}

function formatPortfolioCandidateDetail(
  candidate: RunResearchFunnelProjection["portfolio_candidates"][number]
): string {
  const scores = candidate.scores;
  const prior = candidate.prior_absorption_comparisons
    .map((comparison) => `${comparison.prior_paper_id}:${comparison.disposition}`)
    .join(",") || "unmeasured";
  return (
    `Topic candidate #${candidate.rank} ${candidate.candidate_id}: trusted=${candidate.trusted}; `
    + `review=${candidate.review_status}; probe=${candidate.probe_status}; eligible=${candidate.probe_eligible}; `
    + `scores=novelty:${scores.novelty},feasibility:${scores.feasibility},testability:${scores.testability},cost:${scores.cost},expected_gain:${scores.expected_gain}; `
    + `prior=${prior}; memory=${candidate.topic_memory_disposition || "unmeasured"}; `
    + `blocked_gates=${candidate.blocked_gate_codes.join(",") || "none"}; `
    + `statement=${toOneLine(candidate.statement)}`
    + `${candidate.reviewer_absorption_objection ? `; objection=${toOneLine(candidate.reviewer_absorption_objection)}` : ""}`
    + `${candidate.closest_prior_non_overlap ? `; non_overlap=${toOneLine(candidate.closest_prior_non_overlap)}` : ""}`
    + `${candidate.kill_signal ? `; kill=${toOneLine(candidate.kill_signal)}` : ""}.`
  );
}

function formatPortfolioCandidatesDetail(
  candidates: RunResearchFunnelProjection["portfolio_candidates"]
): string {
  return candidates.length > 0
    ? ` Candidate audit portfolio: ${candidates.map(formatPortfolioCandidateDetail).join(" | ")}`
    : "";
}

function isEffectCriterionProjection(
  value: unknown
): value is NonNullable<RunResearchFunnelProjection["active_effect_criterion"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const criterion = value as Record<string, unknown>;
  return criterion.basis === "delta_vs_reference"
    && typeof criterion.magnitude === "number"
    && Number.isFinite(criterion.magnitude)
    && criterion.magnitude >= 0
    && (
      criterion.scale === "raw"
      || criterion.scale === "proportion"
      || criterion.scale === "percent"
      || criterion.scale === "percentage_point"
    )
    && typeof criterion.inclusive === "boolean";
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

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function buildBlockedByUpstreamHeadline(
  currentNode: GraphNodeId,
  actionableNode: GraphNodeId,
  hints?: RunProjectionHints
): string {
  if (actionableNode === "analyze_papers" && typeof hints?.analyze?.evidenceCount === "number") {
    return `${currentNode} is blocked because ${actionableNode} has ${hints.analyze.evidenceCount} evidence item(s).`;
  }
  if (actionableNode === "collect_papers" && typeof hints?.collect?.storedCount === "number") {
    return `${currentNode} is blocked because ${actionableNode} stored ${hints.collect.storedCount} paper(s).`;
  }
  return `${currentNode} is blocked until ${actionableNode} is recovered.`;
}

function resolveUsageLimitDetail(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const match = extractUsageLimitDetail(value);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function displayPathTail(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] || normalized;
}

function extractUsageLimitDetail(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }
  const modelMatch = text.match(/usage limit for ([A-Za-z0-9._-]+)/iu);
  if (modelMatch?.[1]) {
    return `${trimTrailingPunctuation(modelMatch[1])} usage limit`;
  }
  if (/usage limit/iu.test(text)) {
    return "model usage limit";
  }
  return undefined;
}

function extractUpstreamDependencyNode(value: string | undefined): GraphNodeId | undefined {
  const text = value?.trim();
  if (!text) {
    return undefined;
  }
  const match = text.match(/\b(?:require(?:s|d)?|need(?:s|ed)?|missing|await(?:s|ed)?|depend(?:s|ed) on)\b[\s\S]*?\bfrom ([a-z_]+)/iu);
  if (!match?.[1]) {
    return undefined;
  }
  const candidate = match[1] as GraphNodeId;
  return GRAPH_NODE_ORDER.includes(candidate) ? candidate : undefined;
}

function toOneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/u, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function updatedAtMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRunStateFresher(candidate: RunRecord, reference: RunRecord): boolean {
  const candidateCheckpointSeq = candidate.graph.checkpointSeq ?? 0;
  const referenceCheckpointSeq = reference.graph.checkpointSeq ?? 0;
  if (candidateCheckpointSeq !== referenceCheckpointSeq) {
    return candidateCheckpointSeq > referenceCheckpointSeq;
  }

  const candidateUpdatedAt = updatedAtMs(candidate.updatedAt);
  const referenceUpdatedAt = updatedAtMs(reference.updatedAt);
  if (candidateUpdatedAt !== referenceUpdatedAt) {
    return candidateUpdatedAt > referenceUpdatedAt;
  }

  const candidateNodeUpdatedAt = updatedAtMs(candidate.graph.nodeStates[candidate.currentNode]?.updatedAt);
  const referenceNodeUpdatedAt = updatedAtMs(reference.graph.nodeStates[reference.currentNode]?.updatedAt);
  return candidateNodeUpdatedAt > referenceNodeUpdatedAt;
}
