import { AutoLabOSEvent } from "../core/events.js";
import { GRAPH_NODE_ORDER, GraphNodeId, NodeStatus, RunRecord, RunStatus } from "../types.js";

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

export interface RunProjectionHints {
  collect?: CollectProjectionHints;
  analyze?: AnalyzeProjectionHints;
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
      return updateProjectedRun(run, event.node, event.timestamp, {
        runStatus: "running",
        nodeStatus: "running",
        note: buildRetryNote(event),
        clearLastError: true,
        clearPendingTransition: true
      });
    case "NODE_ROLLBACK":
      return updateProjectedRun(run, event.node, event.timestamp, {
        runStatus: "running",
        nodeStatus: "running",
        note: buildRollbackNote(event),
        clearLastError: true,
        clearPendingTransition: true
      });
    case "NODE_FAILED":
      return updateProjectedRun(run, event.node, event.timestamp, {
        runStatus: "failed",
        nodeStatus: "failed",
        note: readStringPayload(event.payload.error),
        lastError: readStringPayload(event.payload.error),
        clearPendingTransition: true
      });
    case "BUDGET_EXCEEDED":
      return updateProjectedRun(run, event.node, event.timestamp, {
        runStatus: "failed_budget",
        nodeStatus: "failed",
        note: readStringPayload(event.payload.reason),
        lastError: readStringPayload(event.payload.reason),
        clearPendingTransition: true
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
  const currentNode = resolveDisplayNode(run, hints);
  const nodeStatus = run.graph.nodeStates[currentNode]?.status;
  const runStatus = resolveDisplayRunStatus(run.status, nodeStatus, currentNode !== run.currentNode);
  if (currentNode === run.currentNode && runStatus === run.status) {
    return run;
  }

  return {
    ...run,
    currentNode,
    status: runStatus,
    graph: {
      ...run.graph,
      currentNode
    }
  };
}

export function resolveFailedNode(run: RunRecord): GraphNodeId {
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
  const actionableNode = resolveActionableNode(normalized);
  const actionableState = normalized.graph.nodeStates[actionableNode];
  const retryCount = normalized.graph.retryCounters[actionableNode] ?? 0;
  const retryLimit = normalized.graph.retryPolicy.maxAttemptsPerNode;
  const blockedByUpstream = actionableNode !== normalized.currentNode;
  const pausedRetry = (normalized.status === "paused" || normalized.status === "failed") && retryCount > 0;
  const staleLatestSummary = isLatestSummaryStale(normalized, hints);
  const usageLimitDetail = resolveUsageLimitDetail([
    hints?.analyze?.selectedPaperLastError,
    hints?.analyze?.rerankFallbackReason,
    actionableState?.lastError,
    normalized.graph.nodeStates[normalized.currentNode]?.lastError
  ]);
  const usageLimitBlocked = Boolean(usageLimitDetail);
  const rerankFallback = hints?.analyze?.rerankApplied === false && Boolean(hints?.analyze?.rerankFallbackReason);
  const noArtifactProgress =
    actionableNode === "analyze_papers" &&
    (hints?.analyze?.selectedCount ?? 0) > 0 &&
    (hints?.analyze?.summaryCount ?? 0) === 0 &&
    (hints?.analyze?.evidenceCount ?? 0) === 0;
  const lastError = usageLimitDetail || actionableState?.lastError || normalized.graph.nodeStates[normalized.currentNode]?.lastError;

  let headline: string | undefined;
  if (blockedByUpstream) {
    headline = `${normalized.currentNode} is blocked because ${actionableNode} has ${hints?.analyze?.evidenceCount ?? 0} evidence item(s).`;
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
  if (blockedByUpstream) {
    detailParts.push(`Retry or rerun ${actionableNode} before retrying ${normalized.currentNode}.`);
  }
  if (staleLatestSummary && normalized.latestSummary) {
    detailParts.push(`Ignoring stale top-level summary: ${toOneLine(normalized.latestSummary)}.`);
  }
  const analyzeSelectionDetail = buildAnalyzeSelectionDetail(hints?.analyze);
  if (analyzeSelectionDetail) {
    detailParts.push(analyzeSelectionDetail);
  }
  if (rerankFallback) {
    detailParts.push("LLM rerank fell back to deterministic order.");
  }
  if (usageLimitDetail) {
    detailParts.push(`${usageLimitDetail}; switch models or wait for quota reset before retrying.`);
  } else if (actionableNode === "analyze_papers" && hints?.analyze?.selectedPaperFallbackReason) {
    const sourceType = hints.analyze.selectedPaperSourceType === "abstract" ? "abstract fallback" : "fallback";
    detailParts.push(`${sourceType} was used for the selected paper (${toOneLine(hints.analyze.selectedPaperFallbackReason)}).`);
  }
  if (!staleLatestSummary && !headline && normalized.latestSummary) {
    detailParts.push(toOneLine(normalized.latestSummary));
  }
  const detail = detailParts.filter(Boolean).slice(0, 4).join(" ");

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
    lastError
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

function updateProjectedRun(
  run: RunRecord,
  node: GraphNodeId,
  updatedAt: string,
  options: {
    runStatus?: RunStatus;
    nodeStatus?: NodeStatus;
    note?: string;
    lastError?: string;
    clearLastError?: boolean;
    clearPendingTransition?: boolean;
  }
): RunRecord {
  const currentState = run.graph.nodeStates[node];
  const nextState = {
    ...currentState,
    updatedAt,
    status: options.nodeStatus ?? currentState.status,
    note: options.note ?? currentState.note,
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

function resolveUsageLimitDetail(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const match = extractUsageLimitDetail(value);
    if (match) {
      return match;
    }
  }
  return undefined;
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
  const match = text.match(/from ([a-z_]+)/iu);
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

function updatedAtMs(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
