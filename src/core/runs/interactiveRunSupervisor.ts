import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { AgentOrchestrator } from "../agents/agentOrchestrator.js";
import { withHumanInterventionRunLock } from "../humanInterventionLock.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import {
  appendHumanInterventionFollowup,
  appendHumanInterventionHistory,
  clearPendingHumanInterventionRequest,
  HumanInterventionHistoryEntry,
  HumanInterventionRequest,
  HumanInterventionResumeAction,
  isActiveHumanInterventionRequest,
  isHumanInterventionRequest,
  readPendingHumanInterventionRequest,
  writeHumanInterventionRequest
} from "../humanIntervention.js";
import {
  HumanInterventionTextClient,
  resolveAdaptiveHumanInterventionAnswer
} from "../humanInterventionResolver.js";
import {
  GRAPH_NODE_ORDER,
  GraphNodeId,
  RunRecord,
  TransitionRecommendation
} from "../../types.js";
import {
  readJsonFile,
  writeJsonFile
} from "../../utils/fs.js";
import { RunStore } from "./runStore.js";

interface HumanInterventionCommitRecord {
  version: 1;
  runId: string;
  requestId: string;
  request: HumanInterventionRequest;
  status: "prepared" | "dispatching" | "action_failed" | "action_applied" | "committed";
  resumeAction: HumanInterventionResumeAction;
  targetNode?: GraphNodeId;
  beforeAction: HumanInterventionActionSnapshot;
  historyEntry: HumanInterventionHistoryEntry;
  successMessage: string;
  preparedAt: string;
  actionAppliedAt?: string;
  committedAt?: string;
}

interface HumanInterventionActionSnapshot {
  currentNode: GraphNodeId;
  status: RunRecord["status"];
  checkpointSeq: number;
  sourceRetryCount: number;
  maxAttemptsPerNode: number;
  sourceNodeStatus: string;
  sourceNodeUpdatedAt?: string;
  pendingTransition: string;
  transitionHistoryLength: number;
}

export type InteractiveSupervisorOutcome =
  | {
      status: "awaiting_human";
      run: RunRecord;
      request: HumanInterventionRequest;
    }
  | {
      status: "paused";
      run: RunRecord;
      reason: string;
    }
  | {
      status: "completed" | "failed";
      run: RunRecord;
      summary: string;
    };

export type AnswerHumanInterventionResult =
  | {
      status: "resumed";
      run: RunRecord;
      message: string;
    }
  | {
      status: "followup_required";
      request: HumanInterventionRequest;
      message: string;
    }
  | {
      status: "invalid_answer";
      request: HumanInterventionRequest;
      message: string;
    };

export class InteractiveRunSupervisor {
  private static readonly MAX_AUTO_CONTINUATIONS = 16;

  constructor(
    private readonly workspaceRoot: string,
    private readonly runStore: RunStore,
    private readonly orchestrator: AgentOrchestrator
  ) {}

  async runUntilStop(
    runId: string,
    opts?: { abortSignal?: AbortSignal }
  ): Promise<InteractiveSupervisorOutcome> {
    const seenPendingFingerprints = new Set<string>();
    let lastOutcome: InteractiveSupervisorOutcome | undefined;

    for (let step = 0; step < InteractiveRunSupervisor.MAX_AUTO_CONTINUATIONS; step += 1) {
      const response = await this.orchestrator.runCurrentAgentWithOptions(runId, {
        abortSignal: opts?.abortSignal
      });
      const run = response.run;
      if (run.status === "completed") {
        return {
          status: "completed",
          run,
          summary: response.result.summary
        };
      }
      if (run.status === "failed") {
        return {
          status: "failed",
          run,
          summary: response.result.error || response.result.summary
        };
      }
      const pendingRequest = await this.getActiveRequest(run);
      if (pendingRequest) {
        return {
          status: "awaiting_human",
          run,
          request: pendingRequest
        };
      }

      lastOutcome = {
        status: "paused",
        run,
        reason: run.graph.pendingTransition?.reason || response.result.summary || "Run paused."
      };

      if (!this.shouldAutoContinue(run)) {
        return lastOutcome;
      }

      const fingerprint = this.buildPendingExecutionFingerprint(run);
      if (!fingerprint || seenPendingFingerprints.has(fingerprint)) {
        return {
          status: "paused",
          run,
          reason:
            "Run remained on the same pending node without additional progress; pausing to avoid a supervisor loop."
        };
      }
      seenPendingFingerprints.add(fingerprint);
    }

    if (lastOutcome) {
      return lastOutcome;
    }

    const run = await this.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return {
      status: "paused",
      run,
      reason: "Run paused."
    };
  }

  async answerHumanIntervention(
    runId: string,
    request: HumanInterventionRequest,
    answer: string,
    opts?: {
      llm?: HumanInterventionTextClient;
      abortSignal?: AbortSignal;
    }
  ): Promise<AnswerHumanInterventionResult> {
    return withHumanInterventionRunLock(
      {
        workspaceRoot: this.workspaceRoot,
        runId,
        abortSignal: opts?.abortSignal
      },
      () => this.answerHumanInterventionLocked(runId, request, answer, opts)
    );
  }

  private async answerHumanInterventionLocked(
    runId: string,
    request: HumanInterventionRequest,
    answer: string,
    opts?: {
      llm?: HumanInterventionTextClient;
      abortSignal?: AbortSignal;
    }
  ): Promise<AnswerHumanInterventionResult> {
    await this.reconcileFinalizableHumanInterventionCommits(runId, request.id);
    const outstandingDispatch = await this.findOutstandingDispatchingCommit(runId, request.id);
    if (outstandingDispatch) {
      const runContext = new RunContextMemory(this.resolveRunContextPath(runId));
      const pending = await readPendingHumanInterventionRequest(runContext);
      return humanInterventionRecoveryRequired(pending ?? outstandingDispatch.request);
    }
    const recoveredCommit = await this.recoverHumanInterventionCommit(runId, request);
    if (recoveredCommit) {
      return recoveredCommit;
    }

    const resolution = await resolveAdaptiveHumanInterventionAnswer({
      request,
      answer,
      llm: opts?.llm,
      abortSignal: opts?.abortSignal
    });
    if (resolution.status === "followup_required") {
      const run = await this.runStore.getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      throwIfAborted(opts?.abortSignal);
      const runContext = new RunContextMemory(this.resolveRunContextPath(runId));
      const persistedRequest = await readPendingHumanInterventionRequest(runContext);
      if (
        !persistedRequest
        || persistedRequest.id !== request.id
        || !isActiveHumanInterventionRequest(run, persistedRequest)
        || !sameHumanInterventionRequestVersion(persistedRequest, request)
      ) {
        return staleHumanInterventionAnswer(request);
      }
      const updatedRequest = appendHumanInterventionFollowup({
        request: persistedRequest,
        answer: answer.trim(),
        followupQuestion: resolution.question,
        rationale: resolution.rationale,
        resolutionSource: resolution.source
      });
      throwIfAborted(opts?.abortSignal);
      await writeHumanInterventionRequest({
        workspaceRoot: this.workspaceRoot,
        run,
        runContext,
        request: updatedRequest
      });
      return {
        status: "followup_required",
        request: updatedRequest,
        message: resolution.question
      };
    }

    const resolved = resolution.resolved;
    if (resolved.resumeAction === "jump" && !resolved.targetNode) {
      return {
        status: "invalid_answer",
        request,
        message: "The selected answer does not define a jump target. The question remains pending."
      };
    }

    throwIfAborted(opts?.abortSignal);

    const beforeActionRun = await this.runStore.getRun(runId);
    if (!beforeActionRun) {
      throw new Error(`Run not found: ${runId}`);
    }
    throwIfAborted(opts?.abortSignal);
    const runContext = new RunContextMemory(this.resolveRunContextPath(runId));
    const persistedRequest = await readPendingHumanInterventionRequest(runContext);
    if (
      !persistedRequest
      || persistedRequest.id !== request.id
      || !isActiveHumanInterventionRequest(beforeActionRun, persistedRequest)
      || !sameHumanInterventionRequestVersion(persistedRequest, request)
    ) {
      return staleHumanInterventionAnswer(request);
    }
    if (
      resolved.resumeAction === "apply_transition"
      && !beforeActionRun.graph.pendingTransition
    ) {
      return {
        status: "invalid_answer",
        request,
        message: "There is no pending transition to apply. The question remains pending."
      };
    }

    const historyEntry: HumanInterventionHistoryEntry = {
      requestId: request.id,
      sourceNode: request.sourceNode,
      kind: request.kind,
      title: request.title,
      answer: resolved.answer,
      selectedChoiceId: resolved.selectedChoice?.id,
      resumeAction: resolved.resumeAction,
      targetNode: resolved.targetNode,
      resolutionSource: resolution.source,
      rationale: resolution.rationale,
      conversation: request.conversation,
      answeredAt: new Date().toISOString()
    };
    const successMessage = resolved.selectedChoice
      ? `Applied "${resolved.selectedChoice.label}" from the operator answer and resumed the run.`
      : `Recorded the answer and resumed the run (${resolution.source}).`;
    const preparedCommit: HumanInterventionCommitRecord = {
      version: 1,
      runId,
      requestId: request.id,
      request: persistedRequest,
      status: "prepared",
      resumeAction: resolved.resumeAction,
      targetNode: resolved.targetNode,
      beforeAction: snapshotHumanInterventionAction(beforeActionRun, request.sourceNode),
      historyEntry,
      successMessage,
      preparedAt: new Date().toISOString()
    };
    await this.writeHumanInterventionCommit(preparedCommit);
    try {
      throwIfAborted(opts?.abortSignal);
    } catch (error) {
      await this.writeHumanInterventionCommit({ ...preparedCommit, status: "action_failed" });
      throw error;
    }

    const dispatchingCommit: HumanInterventionCommitRecord = {
      ...preparedCommit,
      status: "dispatching"
    };
    await this.writeHumanInterventionCommit(dispatchingCommit);

    // Keep the persisted question pending until the workflow mutation itself has
    // succeeded. Otherwise an orchestrator failure would leave a completed audit
    // entry for an answer that was never applied and no question to retry.
    let updatedRun: RunRecord;
    try {
      switch (resolved.resumeAction) {
        case "retry_current":
          updatedRun = await this.orchestrator.retryCurrent(runId, request.sourceNode);
          break;
        case "approve_current":
          updatedRun = await this.orchestrator.approveCurrent(runId);
          break;
        case "apply_transition":
          updatedRun = await this.orchestrator.applyPendingTransition(runId);
          break;
        case "jump":
          updatedRun = await this.orchestrator.jumpToNode(
            runId,
            resolved.targetNode!,
            "safe",
            `human intervention: ${request.kind}`
          );
          break;
        default:
          return {
            status: "invalid_answer",
            request,
            message: "Unsupported resume action."
          };
      }
    } catch (error) {
      const currentRun = await this.runStore.getRun(runId).catch(() => undefined);
      if (
        currentRun
        && sameHumanInterventionActionSnapshot(
          dispatchingCommit.beforeAction,
          snapshotHumanInterventionAction(currentRun, request.sourceNode)
        )
      ) {
        await this.writeHumanInterventionCommit({
          ...dispatchingCommit,
          status: "action_failed"
        });
      }
      throw error;
    }

    if (!hasHumanInterventionActionPostcondition(preparedCommit, updatedRun)) {
      const persistedRun = await this.runStore.getRun(runId).catch(() => undefined);
      const actionStrictlyUnchanged = [updatedRun, persistedRun].every((candidate) => (
        candidate
        && sameHumanInterventionActionSnapshot(
          dispatchingCommit.beforeAction,
          snapshotHumanInterventionAction(candidate, request.sourceNode)
        )
      ));
      if (actionStrictlyUnchanged) {
        await this.writeHumanInterventionCommit({
          ...dispatchingCommit,
          status: "action_failed"
        });
        return {
          status: "invalid_answer",
          request,
          message: "The workflow action was not applied. The question remains pending for a fresh answer."
        };
      }
      return humanInterventionRecoveryRequired(request);
    }

    const appliedCommit: HumanInterventionCommitRecord = {
      ...dispatchingCommit,
      status: "action_applied",
      actionAppliedAt: new Date().toISOString()
    };
    await this.writeHumanInterventionCommit(appliedCommit);
    await this.finalizeHumanInterventionCommit(runId, appliedCommit, request);

    return {
      status: "resumed",
      run: updatedRun,
      message: successMessage
    };
  }

  async getActiveRequest(run: RunRecord): Promise<HumanInterventionRequest | undefined> {
    return withHumanInterventionRunLock(
      {
        workspaceRoot: this.workspaceRoot,
        runId: run.id
      },
      () => this.getActiveRequestLocked(run)
    );
  }

  private async getActiveRequestLocked(
    run: RunRecord
  ): Promise<HumanInterventionRequest | undefined> {
    await this.reconcileFinalizableHumanInterventionCommits(run.id);
    const runContext = new RunContextMemory(this.resolveRunContextPath(run.id));
    let request = await readPendingHumanInterventionRequest(runContext);
    const outstandingDispatch = await this.findOutstandingDispatchingCommit(run.id);
    if (outstandingDispatch) {
      return humanInterventionRecoveryRequired(request ?? outstandingDispatch.request).request;
    }
    if (request) {
      const recovered = await this.recoverHumanInterventionCommit(run.id, request);
      if (recovered) {
        if (recovered.status === "invalid_answer") {
          return recovered.request;
        }
        request = await readPendingHumanInterventionRequest(runContext);
      }
    }
    return isActiveHumanInterventionRequest(run, request) ? request : undefined;
  }

  private resolveRunContextPath(runId: string): string {
    return path.join(this.workspaceRoot, ".autolabos", "runs", runId, "memory", "run_context.json");
  }

  private resolveHumanInterventionCommitDir(runId: string): string {
    return path.join(
      this.workspaceRoot,
      ".autolabos",
      "runs",
      runId,
      "human_intervention",
      "answer_commits"
    );
  }

  private resolveHumanInterventionCommitPath(runId: string, requestId: string): string {
    const requestKey = createHash("sha256").update(requestId).digest("hex");
    return path.join(this.resolveHumanInterventionCommitDir(runId), `${requestKey}.json`);
  }

  private async reconcileFinalizableHumanInterventionCommits(
    runId: string,
    excludedRequestId?: string
  ): Promise<void> {
    const commits = await this.readHumanInterventionCommits(runId);
    for (const commit of commits) {
      if (
        commit.requestId === excludedRequestId
        || (commit.status !== "action_applied" && commit.status !== "committed")
      ) {
        continue;
      }
      await this.finalizeHumanInterventionCommit(runId, commit, commit.request);
    }
  }

  private async findOutstandingDispatchingCommit(
    runId: string,
    excludedRequestId?: string
  ): Promise<HumanInterventionCommitRecord | undefined> {
    const commits = await this.readHumanInterventionCommits(runId);
    return commits.find((commit) => (
      commit.requestId !== excludedRequestId && commit.status === "dispatching"
    ));
  }

  private async recoverHumanInterventionCommit(
    runId: string,
    request: HumanInterventionRequest
  ): Promise<AnswerHumanInterventionResult | undefined> {
    const commit = await this.readHumanInterventionCommit(runId, request);
    if (!commit) {
      return undefined;
    }

    if (commit.status === "action_failed" || commit.status === "prepared") {
      return undefined;
    }
    if (commit.status === "dispatching") {
      return humanInterventionRecoveryRequired(request);
    }

    const run = await this.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const runContext = new RunContextMemory(this.resolveRunContextPath(runId));
    const pending = await readPendingHumanInterventionRequest(runContext);
    if (
      !pending
      || pending.id !== request.id
      || !sameHumanInterventionRequestVersion(pending, request)
    ) {
      return staleHumanInterventionAnswer(request);
    }
    const appliedCommit = commit;
    await this.finalizeHumanInterventionCommit(runId, appliedCommit, request);
    return {
      status: "resumed",
      run,
      message: appliedCommit.successMessage
    };
  }

  private async finalizeHumanInterventionCommit(
    runId: string,
    commit: HumanInterventionCommitRecord,
    request: HumanInterventionRequest
  ): Promise<void> {
    assertHumanInterventionCommitBinding(commit, runId, request);
    const runContext = new RunContextMemory(this.resolveRunContextPath(runId));
    const history = await runContext.get<HumanInterventionHistoryEntry[]>(
      "human_intervention.history"
    );
    const historyAlreadyRecorded = Array.isArray(history)
      && history.some((entry) => entry.requestId === commit.requestId);
    if (!historyAlreadyRecorded) {
      await appendHumanInterventionHistory(runContext, commit.historyEntry);
    }
    if (
      commit.status !== "committed"
      && shouldPersistObjectiveClarification(request, commit.historyEntry)
    ) {
      await runContext.put("analyze_results.objective_clarification", commit.historyEntry.answer);
      await runContext.put("objective_metric.last_evaluation", null);
    }

    const pending = await readPendingHumanInterventionRequest(runContext);
    if (pending && sameHumanInterventionRequestVersion(pending, request)) {
      await clearPendingHumanInterventionRequest(runContext);
    }

    if (commit.status !== "committed") {
      await this.writeHumanInterventionCommit({
        ...commit,
        status: "committed",
        committedAt: new Date().toISOString()
      });
    }
  }

  private async readHumanInterventionCommit(
    runId: string,
    request: HumanInterventionRequest
  ): Promise<HumanInterventionCommitRecord | undefined> {
    try {
      const value = await this.readHumanInterventionCommitPath(
        runId,
        this.resolveHumanInterventionCommitPath(runId, request.id)
      );
      assertHumanInterventionCommitBinding(value, runId, request);
      return value;
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }
      if (error instanceof Error && error.message === "human_intervention_commit_invalid") {
        throw error;
      }
      throw new Error("human_intervention_commit_invalid", { cause: error });
    }
  }

  private async readHumanInterventionCommits(
    runId: string
  ): Promise<HumanInterventionCommitRecord[]> {
    const commitDir = this.resolveHumanInterventionCommitDir(runId);
    let names: string[];
    try {
      names = await fs.readdir(commitDir);
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw error;
    }
    const commits: HumanInterventionCommitRecord[] = [];
    for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
      const commit = await this.readHumanInterventionCommitPath(runId, path.join(commitDir, name));
      const expectedName = path.basename(
        this.resolveHumanInterventionCommitPath(runId, commit.requestId)
      );
      if (name !== expectedName) {
        throw new Error("human_intervention_commit_invalid");
      }
      commits.push(commit);
    }
    return commits.sort((left, right) => left.preparedAt.localeCompare(right.preparedAt));
  }

  private async readHumanInterventionCommitPath(
    runId: string,
    commitPath: string
  ): Promise<HumanInterventionCommitRecord> {
    const value = await readJsonFile<unknown>(commitPath);
    if (!isHumanInterventionCommitRecordShape(value) || value.runId !== runId) {
      throw new Error("human_intervention_commit_invalid");
    }
    assertHumanInterventionCommitBinding(value, runId, value.request);
    return value;
  }

  private async writeHumanInterventionCommit(commit: HumanInterventionCommitRecord): Promise<void> {
    await writeJsonFile(
      this.resolveHumanInterventionCommitPath(commit.runId, commit.requestId),
      commit
    );
  }

  private shouldAutoContinue(run: RunRecord): boolean {
    const nodeState = run.graph.nodeStates[run.currentNode];
    return run.status === "running" && nodeState?.status === "pending";
  }

  private buildPendingExecutionFingerprint(run: RunRecord): string | undefined {
    const nodeState = run.graph.nodeStates[run.currentNode];
    if (!nodeState) {
      return undefined;
    }
    return [run.currentNode, nodeState.status, run.graph.checkpointSeq, run.updatedAt].join(":");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  const error = new Error("Human intervention answer aborted by the operator.");
  error.name = "AbortError";
  throw error;
}

function snapshotHumanInterventionAction(
  run: RunRecord,
  sourceNode: GraphNodeId
): HumanInterventionActionSnapshot {
  const sourceState = run.graph.nodeStates[sourceNode];
  return {
    currentNode: run.currentNode,
    status: run.status,
    checkpointSeq: run.graph.checkpointSeq ?? 0,
    sourceRetryCount: run.graph.retryCounters[sourceNode] ?? 0,
    maxAttemptsPerNode: Math.max(1, run.graph.retryPolicy.maxAttemptsPerNode),
    sourceNodeStatus: sourceState?.status || "missing",
    sourceNodeUpdatedAt: sourceState?.updatedAt,
    pendingTransition: JSON.stringify(run.graph.pendingTransition ?? null),
    transitionHistoryLength: run.graph.transitionHistory?.length ?? 0
  };
}

function sameHumanInterventionActionSnapshot(
  left: HumanInterventionActionSnapshot,
  right: HumanInterventionActionSnapshot
): boolean {
  return (
    left.currentNode === right.currentNode
    && left.status === right.status
    && left.checkpointSeq === right.checkpointSeq
    && left.sourceRetryCount === right.sourceRetryCount
    && left.maxAttemptsPerNode === right.maxAttemptsPerNode
    && left.sourceNodeStatus === right.sourceNodeStatus
    && left.sourceNodeUpdatedAt === right.sourceNodeUpdatedAt
    && left.pendingTransition === right.pendingTransition
    && left.transitionHistoryLength === right.transitionHistoryLength
  );
}

function hasHumanInterventionActionPostcondition(
  commit: HumanInterventionCommitRecord,
  run: RunRecord
): boolean {
  const before = commit.beforeAction;
  const after = snapshotHumanInterventionAction(run, commit.historyEntry.sourceNode);
  switch (commit.resumeAction) {
    case "retry_current":
      return hasRetriedCurrentPostcondition(commit, run, after);
    case "approve_current":
      return hasApprovedCurrentPostcondition(commit, run, after);
    case "apply_transition":
      return hasAppliedTransitionPostcondition(commit, run);
    case "jump":
      return Boolean(
        commit.targetNode
        && before.currentNode !== commit.targetNode
        && run.currentNode === commit.targetNode
        && run.graph.checkpointSeq > before.checkpointSeq
        && run.status === "paused"
        && run.graph.nodeStates[commit.targetNode]?.status === "pending"
      );
  }
}

function hasRetriedCurrentPostcondition(
  commit: HumanInterventionCommitRecord,
  run: RunRecord,
  after: HumanInterventionActionSnapshot
): boolean {
  const sourceNode = commit.historyEntry.sourceNode;
  const activeRetry = run.status === "running" && after.sourceNodeStatus === "running";
  const budgetPausedRetry = run.status === "paused" && after.sourceNodeStatus === "pending";
  return (
    run.currentNode === sourceNode
    && after.checkpointSeq > commit.beforeAction.checkpointSeq
    && hasExpectedRetryCounter(commit.beforeAction, run, sourceNode)
    && after.pendingTransition === "null"
    && after.sourceNodeUpdatedAt !== commit.beforeAction.sourceNodeUpdatedAt
    && (activeRetry || budgetPausedRetry)
  );
}

function hasApprovedCurrentPostcondition(
  commit: HumanInterventionCommitRecord,
  run: RunRecord,
  after: HumanInterventionActionSnapshot
): boolean {
  const recommendation = parsePreparedTransition(commit.beforeAction);
  if (
    recommendation
    && recommendation.action !== "advance"
    && recommendation.action !== "pause_for_human"
  ) {
    return hasAppliedTransitionPostcondition(commit, run);
  }
  const preparedTransitionConsumed = (
    commit.beforeAction.pendingTransition === "null"
    || after.pendingTransition !== commit.beforeAction.pendingTransition
  );
  const checkpointRecorded = after.checkpointSeq > commit.beforeAction.checkpointSeq;
  if (recommendation && isGovernancePreExecutionRecommendation(
    commit.beforeAction,
    recommendation
  )) {
    return preparedTransitionConsumed
      && checkpointRecorded
      && after.sourceNodeStatus !== "needs_approval";
  }
  return (
    commit.beforeAction.sourceNodeStatus === "needs_approval"
    && preparedTransitionConsumed
    && checkpointRecorded
    && after.sourceNodeStatus === "completed"
  );
}

function hasAppliedTransitionPostcondition(
  commit: HumanInterventionCommitRecord,
  run: RunRecord
): boolean {
  const recommendation = parsePreparedTransition(commit.beforeAction);
  return Boolean(
    recommendation
    && hasBoundTransitionReceipt(commit.beforeAction, run, recommendation)
    && snapshotHumanInterventionAction(
      run,
      commit.historyEntry.sourceNode
    ).pendingTransition === "null"
    && hasAppliedTransitionStateEffect(commit.beforeAction, run, recommendation)
  );
}

function hasAppliedTransitionStateEffect(
  before: HumanInterventionActionSnapshot,
  run: RunRecord,
  recommendation: TransitionRecommendation
): boolean {
  if (recommendation.action === "pause_for_human") {
    return false;
  }
  if (recommendation.action === "advance") {
    const sourceIndex = GRAPH_NODE_ORDER.indexOf(before.currentNode);
    const expectedNode = recommendation.targetNode
      ?? (sourceIndex >= 0 ? GRAPH_NODE_ORDER[sourceIndex + 1] : undefined);
    return (
      run.graph.checkpointSeq > before.checkpointSeq
      && run.graph.nodeStates[before.currentNode]?.status === "completed"
      && (
        expectedNode
          ? run.currentNode === expectedNode
          : run.currentNode === before.currentNode && run.status === "completed"
      )
    );
  }
  if (recommendation.action === "retry_same") {
    const sourceState = run.graph.nodeStates[before.currentNode];
    const activeRetry = run.status === "running" && sourceState?.status === "running";
    const budgetPausedRetry = run.status === "paused" && sourceState?.status === "pending";
    return (
      run.currentNode === (recommendation.targetNode ?? before.currentNode)
      && run.graph.checkpointSeq > before.checkpointSeq
      && hasExpectedRetryCounter(before, run, before.currentNode)
      && sourceState?.updatedAt !== before.sourceNodeUpdatedAt
      && (activeRetry || budgetPausedRetry)
    );
  }
  const targetState = recommendation.targetNode
    ? run.graph.nodeStates[recommendation.targetNode]
    : undefined;
  return Boolean(
    recommendation.targetNode
    && run.currentNode === recommendation.targetNode
    && run.graph.checkpointSeq > before.checkpointSeq
    && run.status === "paused"
    && targetState?.status === "pending"
  );
}

function isGovernancePreExecutionRecommendation(
  before: HumanInterventionActionSnapshot,
  recommendation: TransitionRecommendation
): boolean {
  return (
    recommendation.action === "pause_for_human"
    && recommendation.targetNode === before.currentNode
    && recommendation.reason.startsWith("governance:")
  );
}

function parsePreparedTransition(
  before: HumanInterventionActionSnapshot
): TransitionRecommendation | undefined {
  try {
    const value = JSON.parse(before.pendingTransition) as Partial<TransitionRecommendation> | null;
    if (
      !value
      || typeof value.action !== "string"
      || typeof value.sourceNode !== "string"
      || typeof value.reason !== "string"
      || typeof value.confidence !== "number"
      || typeof value.autoExecutable !== "boolean"
    ) {
      return undefined;
    }
    return value as TransitionRecommendation;
  } catch {
    return undefined;
  }
}

function hasBoundTransitionReceipt(
  before: HumanInterventionActionSnapshot,
  run: RunRecord,
  recommendation: TransitionRecommendation
): boolean {
  return (run.graph.transitionHistory ?? [])
    .slice(before.transitionHistoryLength)
    .some((receipt) => (
      receipt.action === recommendation.action
      && receipt.sourceNode === recommendation.sourceNode
      && receipt.fromNode === before.currentNode
      && receipt.toNode === recommendation.targetNode
      && receipt.reason === recommendation.reason
      && receipt.confidence === recommendation.confidence
      && receipt.autoExecutable === recommendation.autoExecutable
    ));
}

function hasExpectedRetryCounter(
  before: HumanInterventionActionSnapshot,
  run: RunRecord,
  sourceNode: GraphNodeId
): boolean {
  const expectedRetryCount = Math.min(
    before.sourceRetryCount + 1,
    before.maxAttemptsPerNode
  );
  return (run.graph.retryCounters[sourceNode] ?? 0) === expectedRetryCount;
}

function shouldPersistObjectiveClarification(
  request: HumanInterventionRequest,
  historyEntry: HumanInterventionHistoryEntry
): boolean {
  if (request.kind !== "objective_metric_clarification" || historyEntry.selectedChoiceId) {
    return false;
  }
  return historyEntry.resolutionSource === "guarded_fallback"
    || historyEntry.resolutionSource === "model";
}

function isHumanInterventionCommitRecordShape(value: unknown): value is HumanInterventionCommitRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<HumanInterventionCommitRecord>;
  const historyEntry = record.historyEntry as Partial<HumanInterventionHistoryEntry> | undefined;
  const beforeAction = record.beforeAction as Partial<HumanInterventionActionSnapshot> | undefined;
  return (
    record.version === 1
    && typeof record.runId === "string"
    && typeof record.requestId === "string"
    && isHumanInterventionRequest(record.request)
    && record.request.id === record.requestId
    && ["prepared", "dispatching", "action_failed", "action_applied", "committed"].includes(
      record.status || ""
    )
    && ["retry_current", "approve_current", "apply_transition", "jump"].includes(
      record.resumeAction || ""
    )
    && typeof beforeAction?.currentNode === "string"
    && GRAPH_NODE_ORDER.includes(beforeAction.currentNode as GraphNodeId)
    && ["pending", "running", "paused", "completed", "failed"].includes(
      beforeAction.status || ""
    )
    && Number.isInteger(beforeAction.checkpointSeq)
    && (beforeAction.checkpointSeq ?? -1) >= 0
    && Number.isInteger(beforeAction.sourceRetryCount)
    && (beforeAction.sourceRetryCount ?? -1) >= 0
    && Number.isInteger(beforeAction.maxAttemptsPerNode)
    && (beforeAction.maxAttemptsPerNode ?? 0) >= 1
    && typeof beforeAction.sourceNodeStatus === "string"
    && (
      beforeAction.sourceNodeUpdatedAt === undefined
      || typeof beforeAction.sourceNodeUpdatedAt === "string"
    )
    && typeof beforeAction.pendingTransition === "string"
    && Number.isInteger(beforeAction.transitionHistoryLength)
    && (beforeAction.transitionHistoryLength ?? -1) >= 0
    && typeof record.successMessage === "string"
    && typeof record.preparedAt === "string"
    && typeof historyEntry?.requestId === "string"
    && typeof historyEntry?.sourceNode === "string"
    && GRAPH_NODE_ORDER.includes(historyEntry.sourceNode as GraphNodeId)
    && typeof historyEntry?.kind === "string"
    && typeof historyEntry?.title === "string"
    && typeof historyEntry?.answer === "string"
    && typeof historyEntry?.resumeAction === "string"
    && (
      historyEntry.targetNode === undefined
      || (
        typeof historyEntry.targetNode === "string"
        && GRAPH_NODE_ORDER.includes(historyEntry.targetNode as GraphNodeId)
      )
    )
  );
}

function assertHumanInterventionCommitBinding(
  commit: HumanInterventionCommitRecord,
  runId: string,
  request: HumanInterventionRequest
): void {
  if (
    commit.runId !== runId
    || commit.requestId !== request.id
    || !sameHumanInterventionRequestVersion(commit.request, request)
    || commit.historyEntry.requestId !== request.id
    || commit.historyEntry.sourceNode !== request.sourceNode
    || commit.historyEntry.kind !== request.kind
    || commit.historyEntry.title !== request.title
    || commit.historyEntry.resumeAction !== commit.resumeAction
    || commit.historyEntry.targetNode !== commit.targetNode
    || commit.beforeAction.currentNode !== request.sourceNode
    || commit.beforeAction.status !== "paused"
    || commit.beforeAction.sourceNodeStatus !== "needs_approval"
    || !isCommitActionDeclaredByRequest(commit, request)
  ) {
    throw new Error("human_intervention_commit_invalid");
  }
}

function isCommitActionDeclaredByRequest(
  commit: HumanInterventionCommitRecord,
  request: HumanInterventionRequest
): boolean {
  const selectedChoiceId = commit.historyEntry.selectedChoiceId;
  if (!selectedChoiceId) {
    return commit.resumeAction === request.resumeAction && commit.targetNode === undefined;
  }
  const choice = (request.choices ?? []).find((item) => item.id === selectedChoiceId);
  return Boolean(
    choice
    && (choice.resumeAction ?? request.resumeAction) === commit.resumeAction
    && choice.targetNode === commit.targetNode
  );
}

function staleHumanInterventionAnswer(
  request: HumanInterventionRequest
): AnswerHumanInterventionResult {
  return {
    status: "invalid_answer",
    request,
    message: "This question is stale or no longer active. No workflow action was applied."
  };
}

function humanInterventionRecoveryRequired(
  request: HumanInterventionRequest
): Extract<AnswerHumanInterventionResult, { status: "invalid_answer" }> {
  const message =
    "The previous workflow action has no durable completion receipt. Recovery is required before this question can be answered again.";
  return {
    status: "invalid_answer",
    request: {
      ...request,
      title: `Recovery required: ${request.title}`,
      question: message
    },
    message
  };
}

function sameHumanInterventionRequestVersion(
  persisted: HumanInterventionRequest,
  supplied: HumanInterventionRequest
): boolean {
  return (
    persisted.id === supplied.id
    && persisted.sourceNode === supplied.sourceNode
    && persisted.kind === supplied.kind
    && persisted.title === supplied.title
    && persisted.question === supplied.question
    && persisted.inputMode === supplied.inputMode
    && persisted.resumeAction === supplied.resumeAction
    && persisted.createdAt === supplied.createdAt
    && JSON.stringify(persisted.context) === JSON.stringify(supplied.context)
    && JSON.stringify(persisted.choices ?? []) === JSON.stringify(supplied.choices ?? [])
    && JSON.stringify(persisted.conversation ?? []) === JSON.stringify(supplied.conversation ?? [])
  );
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT"
  );
}
