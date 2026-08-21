import path from "node:path";
import { promises as fs } from "node:fs";

import { EventStream } from "../events.js";
import { saveReflexion } from "../agents/runtime/reflexion.js";
import { EpisodeMemory } from "../memory/episodeMemory.js";
import { FailureMemory, buildErrorFingerprint } from "../experiments/failureMemory.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import { RunStore } from "../runs/runStore.js";
import { assertRunHasNoDelegatedSuccessor } from "../runs/runPromotionStore.js";
import {
  ApprovalSignal,
  GRAPH_NODE_ORDER,
  GraphNodeId,
  RunGraphState,
  RunRecord,
  TransitionRecommendation,
  WorkflowApprovalMode
} from "../../types.js";
import { CheckpointStore } from "./checkpointStore.js";
import { applyRunUsageDelta, RunUsageDelta } from "../runs/runUsage.js";
import { CheckpointPhase, CheckpointRecord, GraphNodeRegistry, GraphNodeResult, JumpMode } from "./types.js";
import { defaultRunStatusForGraph } from "./defaults.js";
import { loadGovernancePolicy } from "../../governance/policyLoader.js";
import { GovernancePolicy } from "../../governance/policyTypes.js";
import { ClassifiableAction } from "../../governance/actionRiskClassifier.js";
import { evaluateActionDetailed, PolicyEvaluationResult } from "../../governance/policyEngine.js";
import {
  GovernanceBenchmarkCondition,
  GovernanceBenchmarkConditionName,
  resolveGovernanceBenchmarkCondition
} from "../benchmark/governanceCondition.js";
import { buildWorkspaceRunRoot } from "../runs/runPaths.js";
import { writeJsonFile } from "../../utils/fs.js";
import {
  buildStageRoutingArtifact,
  classifyStageRoutingFailure,
  StageRoutingDisposition,
  StageRoutingEvent,
  writeStageRoutingArtifactBestEffort
} from "../runtime/stageRoutingArtifact.js";
import { parseCodexOAuthCompletionErrorCode } from "../../integrations/codex/oauthCompletionError.js";
import type { CodexOAuthCompletionErrorCode } from "../../integrations/codex/oauthCompletionError.js";

export class StateGraphRuntime {
  private governancePolicy?: GovernancePolicy;

  constructor(
    private readonly runStore: RunStore,
    private readonly nodeRegistry: GraphNodeRegistry,
    private readonly checkpointStore: CheckpointStore,
    private readonly eventStream: EventStream,
    private readonly options: {
      approvalMode?: WorkflowApprovalMode;
      budgetGuardUsd?: number;
      governancePolicy?: GovernancePolicy;
      benchmarkCondition?: GovernanceBenchmarkConditionName | GovernanceBenchmarkCondition;
      evaluateGovernanceAction?: (
        action: ClassifiableAction,
        policy: GovernancePolicy,
        runId: string | null,
        node: string | null
      ) => PolicyEvaluationResult;
    } = {}
  ) {}

  setApprovalMode(mode: WorkflowApprovalMode): void {
    this.options.approvalMode = mode;
  }

  async start(runId: string): Promise<RunRecord> {
    const run = await this.getRunOrThrow(runId);
    assertRunHasNoDelegatedSuccessor(run, "start");
    if (!run.currentNode) {
      run.currentNode = GRAPH_NODE_ORDER[0];
      run.graph.currentNode = run.currentNode;
    }
    run.status = "running";
    await this.recordGovernanceBenchmarkCondition(run);
    this.syncLatestSummary(run);
    const budgetPaused = await this.pauseForBudgetGuardIfNeeded(run);
    if (budgetPaused) {
      return budgetPaused;
    }
    await this.runStore.updateRun(run);
    return run;
  }

  async resume(runId: string, checkpointSeq?: number): Promise<RunRecord> {
    const current = await this.getRunOrThrow(runId);
    assertRunHasNoDelegatedSuccessor(current, "resume");
    const checkpoint = await this.checkpointStore.load(runId, checkpointSeq);
    if (checkpoint) {
      const restored = structuredClone(checkpoint.runSnapshot);
      if (checkpointSeq == null && this.isCheckpointSnapshotStale(current, restored)) {
        await this.recordStageRoutingArtifact(current, {
          event: "stale_resume_state",
          reason: `Latest checkpoint snapshot seq ${restored.graph.checkpointSeq ?? 0} is older than current run seq ${current.graph.checkpointSeq ?? 0}.`,
          disposition: "resume_current_state",
          retrySafe: true,
          evidence: [
            `current_updated_at=${current.updatedAt}`,
            `checkpoint_updated_at=${restored.updatedAt}`,
            `checkpoint_seq=${checkpoint.seq}`
          ],
          suggestedCommands: [`/agent run ${current.id}`]
        });
        current.status = current.status === "completed" ? "completed" : defaultRunStatusForGraph(current.graph);
        this.syncLatestSummary(current);
        await this.runStore.updateRun(current);
        return this.getRunOrThrow(runId);
      }

      if (checkpointSeq != null) {
        const isHistoricalRewind = checkpoint.seq < (current.graph.checkpointSeq ?? 0)
          || this.isCheckpointSnapshotStale(current, restored);
        if (isHistoricalRewind) {
          const nextCycle = Math.max(
            current.graph.researchCycle ?? 0,
            restored.graph.researchCycle ?? 0
          ) + 1;
          this.resetNodeAndDownstream(
            restored,
            restored.currentNode,
            nextCycle,
            `checkpoint rewind to seq ${checkpoint.seq}`
          );
          restored.graph.pendingTransition = undefined;
          restored.status = "paused";
        }
        restored.graph.checkpointSeq = Math.max(
          restored.graph.checkpointSeq ?? 0,
          current.graph.checkpointSeq ?? 0
        );
        this.syncLatestSummary(restored);
        await this.saveCheckpointAndPersist(restored, "jump", `resume to checkpoint ${checkpoint.seq}`);
        return this.getRunOrThrow(runId);
      }

      this.syncLatestSummary(restored);
      await this.runStore.updateRun(restored);
      return this.getRunOrThrow(runId);
    }

    current.status = current.status === "completed" ? "completed" : defaultRunStatusForGraph(current.graph);
    this.syncLatestSummary(current);
    await this.runStore.updateRun(current);
    return this.getRunOrThrow(runId);
  }

  async step(runId: string, abortSignal?: AbortSignal): Promise<RunRecord> {
    this.throwIfAborted(abortSignal);
    let run = await this.getRunOrThrow(runId);
    assertRunHasNoDelegatedSuccessor(run, "step");
    run.graph.currentNode = run.currentNode;
    const budgetPaused = await this.pauseForBudgetGuardIfNeeded(run);
    if (budgetPaused) {
      return budgetPaused;
    }

    const node = run.currentNode;
    const governanceCondition = await this.recordGovernanceBenchmarkCondition(run);
    const governanceDecision = await this.evaluateNodeGovernance(run, node);
    if (governanceDecision?.decision === "require_review") {
      return this.pauseForGovernanceReview(run, node, governanceDecision.detail);
    }
    if (governanceDecision?.decision === "hard_stop") {
      return this.stopForGovernance(run, node, governanceDecision.detail);
    }

    run.graph.nodeStates[node] = {
      ...run.graph.nodeStates[node],
      status: "running",
      updatedAt: new Date().toISOString(),
      note: undefined,
      lastError: undefined
    };
    run.status = "running";
    await this.runStore.updateRun(run);

    this.eventStream.emit({
      type: "NODE_STARTED",
      runId: run.id,
      node,
      payload: { node, ...(governanceCondition ? { governance_condition: governanceCondition } : {}) }
    });

    const before = await this.saveCheckpointAndPersist(run, "before");
    if (this.isCheckpointWritePause(run, node)) {
      this.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node,
        payload: { text: run.graph.nodeStates[node]?.note || "Paused after checkpoint write failure." }
      });
      return this.getRunOrThrow(run.id);
    }
    this.eventStream.emit({
      type: "CHECKPOINT_SAVED",
      runId: run.id,
      node,
      payload: { checkpoint: before.seq, phase: before.phase }
    });

    const started = Date.now();
    let invokedNode = false;
    try {
      this.throwIfAborted(abortSignal);
      invokedNode = true;
      const result = await this.nodeRegistry.get(node).execute({
        run,
        graph: run.graph,
        governanceCondition,
        abortSignal
      });
      // Once a node returns, its result becomes the source of truth even if a
      // late Ctrl-C arrives before runtime persistence finishes.
      run = await this.getRunOrThrow(run.id);
      const usageDelta = this.buildUsageDeltaFromResult(result, started);

      if (result.status === "failure") {
        return this.handleFailure(
          run,
          node,
          result.error || "Node execution failed",
          usageDelta,
          result.failureKind
        );
      }

      this.applyUsageDelta(run, node, usageDelta);
      run.latestSummary = result.summary || run.latestSummary;
      run.graph.pendingTransition = result.transitionRecommendation;
      run.graph.nodeStates[node] = {
        ...run.graph.nodeStates[node],
        status: result.status === "skipped" ? "skipped" : result.needsApproval ? "needs_approval" : "completed",
        updatedAt: new Date().toISOString(),
        note: result.summary || result.reason,
        lastError: undefined,
        approvalSignal: result.approvalSignal
      };
      run.status = result.needsApproval ? "paused" : "running";

      if (!result.needsApproval) {
        const next = this.nextNode(node);
        if (!next) {
          run.status = "completed";
        } else {
          run.currentNode = next;
          run.graph.currentNode = next;
        }
      }

      const budgetPauseMessage = this.applyBudgetGuard(run);
      this.syncLatestSummary(
        run,
        budgetPauseMessage && run.currentNode !== node ? run.currentNode : node
      );
      const after = await this.saveCheckpointAndPersist(run, "after", undefined, node);
      this.eventStream.emit({
        type: "CHECKPOINT_SAVED",
        runId: run.id,
        node,
        payload: { checkpoint: after.seq, phase: after.phase }
      });
      this.eventStream.emit({
        type: result.needsApproval ? "NODE_AWAITING_APPROVAL" : "NODE_COMPLETED",
        runId: run.id,
        node,
        payload: { summary: result.summary || (result.needsApproval ? "awaiting approval" : "completed") }
      });
      if (result.transitionRecommendation) {
        this.eventStream.emit({
          type: "TRANSITION_RECOMMENDED",
          runId: run.id,
          node,
          payload: {
            action: result.transitionRecommendation.action,
            targetNode: result.transitionRecommendation.targetNode,
            reason: result.transitionRecommendation.reason,
            confidence: result.transitionRecommendation.confidence
          }
        });
      }
      if (budgetPauseMessage) {
        this.emitBudgetGuardObservation(run, budgetPauseMessage);
      }

      return this.getRunOrThrow(run.id);
    } catch (error) {
      if (isAbortError(error)) {
        run = await this.getRunOrThrow(run.id);
        if (invokedNode) {
          this.applyUsageDelta(run, node, this.buildUsageDeltaForException(started));
        }
        run.status = "paused";
        run.graph.nodeStates[node] = {
          ...run.graph.nodeStates[node],
          status: "pending",
          updatedAt: new Date().toISOString(),
          note: "Canceled by user"
        };
        this.syncLatestSummary(run);
        await this.runStore.updateRun(run);
        return this.getRunOrThrow(run.id);
      }
      const message = error instanceof Error ? error.message : String(error);
      run = await this.getRunOrThrow(run.id);
      return this.handleFailure(
        run,
        node,
        message,
        invokedNode ? this.buildUsageDeltaForException(started) : undefined
      );
    }
  }

  async runUntilPause(
    runId: string,
    opts?: {
      abortSignal?: AbortSignal;
      stopAfterApprovalBoundary?: boolean;
      floorNode?: GraphNodeId;
    }
  ): Promise<RunRecord> {
    let run = await this.getRunOrThrow(runId);
    assertRunHasNoDelegatedSuccessor(run, "run_until_pause");
    const budgetPaused = await this.pauseForBudgetGuardIfNeeded(run);
    if (budgetPaused) {
      return budgetPaused;
    }
    const continuePastCollectRecovery =
      Boolean(opts?.stopAfterApprovalBoundary) &&
      opts?.floorNode === "collect_papers" &&
      this.hasVisitedLaterNodes(run, opts.floorNode);
    let continuedPastCollectRecovery = false;
    try {
      this.throwIfAborted(opts?.abortSignal);
      if (run.status === "failed") {
        return run;
      }
      run.status = "running";
      this.syncLatestSummary(run);
      await this.runStore.updateRun(run);

      while (true) {
        this.throwIfAborted(opts?.abortSignal);
        run = await this.step(run.id, opts?.abortSignal);
        run = await this.pauseIfRegressedBelowFloor(run, opts?.floorNode);
        if (["completed", "failed"].includes(run.status)) {
          return run;
        }
        this.throwIfAborted(opts?.abortSignal);

        if (run.status === "paused" && run.graph.nodeStates[run.currentNode].status === "needs_approval") {
          const approvalNode = run.currentNode;
          run = await this.resolveApprovalGate(run, opts?.abortSignal);
          run = await this.pauseIfRegressedBelowFloor(run, opts?.floorNode);
          if (["completed", "failed"].includes(run.status)) {
            return run;
          }
          if (run.status === "paused") {
            return run;
          }
          if (opts?.stopAfterApprovalBoundary) {
            const shouldContinuePastCollectRecovery =
              continuePastCollectRecovery &&
              !continuedPastCollectRecovery &&
              approvalNode === opts.floorNode &&
              run.status === "running" &&
              run.currentNode !== approvalNode;
            if (shouldContinuePastCollectRecovery) {
              continuedPastCollectRecovery = true;
              continue;
            }
            return run;
          }
          continue;
        }

        if (run.status === "paused") {
          return run;
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        run = await this.getRunOrThrow(runId);
        run.status = "paused";
        this.syncLatestSummary(run);
        await this.runStore.updateRun(run);
        return this.getRunOrThrow(runId);
      }
      throw error;
    }
  }

  private async resolveApprovalGate(run: RunRecord, abortSignal?: AbortSignal): Promise<RunRecord> {
    while (run.status === "paused" && run.graph.nodeStates[run.currentNode].status === "needs_approval") {
      this.throwIfAborted(abortSignal);
      const budgetPaused = await this.pauseForBudgetGuardIfNeeded(run);
      if (budgetPaused) {
        return budgetPaused;
      }
      const action = this.selectApprovalResolution(run);
      if (action === "pause") {
        return run;
      }

      if (action === "apply_transition") {
        const recommendation = run.graph.pendingTransition;
        this.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: run.currentNode,
          payload: {
            text: `${labelApprovalMode(this.options.approvalMode)} approval mode auto-applied ${recommendation?.action || "transition"}${recommendation?.targetNode ? ` -> ${recommendation.targetNode}` : ""}.`
          }
        });
        run = await this.applyPendingTransition(run.id);
        continue;
      }

      this.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: run.currentNode,
        payload: {
          text: `${labelApprovalMode(this.options.approvalMode)} approval mode auto-approved ${run.currentNode}.`
        }
      });
      run = await this.approveCurrent(run.id, { continueAfterApprove: false, abortSignal });
    }

    return run;
  }

  private selectApprovalResolution(run: RunRecord): "pause" | "approve" | "apply_transition" {
    const recommendation = run.graph.pendingTransition;
    if (isSuccessorDelegation(recommendation)) {
      return "pause";
    }

    if (this.options.approvalMode === "manual") {
      return "pause";
    }

    if (this.options.approvalMode === "hybrid") {
      return this.selectHybridApprovalResolution(run, recommendation);
    }

    if (!recommendation) {
      return "approve";
    }

    if (recommendation.action === "pause_for_human" || !recommendation.autoExecutable) {
      return "pause";
    }

    // Enforce backward-jump limit: if the transition is a backward jump
    // and we have exceeded the configured limit, pause for human review.
    const limit = run.graph.retryPolicy.maxAutoBackwardJumps;
    if (limit != null && recommendation.targetNode) {
      const targetIdx = GRAPH_NODE_ORDER.indexOf(recommendation.targetNode);
      const currentIdx = GRAPH_NODE_ORDER.indexOf(run.currentNode);
      if (targetIdx >= 0 && currentIdx >= 0 && targetIdx < currentIdx) {
        const pastBackwardJumps = (run.graph.transitionHistory || []).filter((t) => {
          if (!t.toNode || !t.fromNode) return false;
          const tIdx = GRAPH_NODE_ORDER.indexOf(t.toNode);
          const fIdx = GRAPH_NODE_ORDER.indexOf(t.fromNode);
          return tIdx >= 0 && fIdx >= 0 && tIdx < fIdx;
        }).length;
        if (pastBackwardJumps >= limit) {
          return "pause";
        }
      }
    }

    return "apply_transition";
  }

  private selectHybridApprovalResolution(
    run: RunRecord,
    recommendation: TransitionRecommendation | undefined
  ): "pause" | "approve" | "apply_transition" {
    if (!recommendation) {
      return "pause";
    }

    if (recommendation.action !== "advance" || !recommendation.autoExecutable) {
      return "pause";
    }

    const signal = run.graph.nodeStates[run.currentNode]?.approvalSignal;
    if (!isHybridAutoApproved(signal)) {
      return "pause";
    }

    return "apply_transition";
  }

  async approveCurrent(
    runId: string,
    opts?: { continueAfterApprove?: boolean; abortSignal?: AbortSignal; allowPauseForHuman?: boolean }
  ): Promise<RunRecord> {
    const run = await this.getRunOrThrow(runId);
    assertRunHasNoDelegatedSuccessor(run, "approve");
    const node = run.currentNode;
    const state = run.graph.nodeStates[node];

    if (state.status !== "needs_approval") {
      return run;
    }

    const recommendation = run.graph.pendingTransition;
    if (isSuccessorDelegation(recommendation)) {
      return run;
    }

    if (this.isGovernancePreExecutionPause(run, node)) {
      run.graph.pendingTransition = undefined;
      run.graph.nodeStates[node] = {
        ...state,
        status: "pending",
        updatedAt: new Date().toISOString(),
        note: "Governance approval granted."
      };
      run.status = "running";
      this.syncLatestSummary(run, node);
      await this.saveCheckpointAndPersist(run, "after", "governance approved", node);
      if (!opts?.continueAfterApprove) {
        return this.getRunOrThrow(runId);
      }
      return this.runUntilPause(runId, {
        abortSignal: opts?.abortSignal,
        floorNode: node
      });
    }

    if (recommendation) {
      if (recommendation.action === "pause_for_human" && !opts?.allowPauseForHuman) {
        return run;
      }
      if (recommendation.action !== "advance" && recommendation.action !== "pause_for_human") {
        return this.applyPendingTransition(run.id);
      }
    }

    run.graph.pendingTransition = undefined;
    run.graph.nodeStates[node] = {
      ...state,
      status: "completed",
      updatedAt: new Date().toISOString()
    };

    const next = this.nextNode(node);
    if (!next) {
      run.status = "completed";
    } else {
      run.currentNode = next;
      run.graph.currentNode = next;
      run.status = "running";
    }

    const budgetPauseMessage = this.applyBudgetGuard(run);
    this.syncLatestSummary(
      run,
      budgetPauseMessage && run.currentNode !== node ? run.currentNode : node
    );
    await this.saveCheckpointAndPersist(run, "after", "approved", node);
    this.eventStream.emit({
      type: "NODE_COMPLETED",
      runId: run.id,
      node,
      payload: { summary: state.note || "approved" }
    });
    if (budgetPauseMessage) {
      this.emitBudgetGuardObservation(run, budgetPauseMessage);
    }
    if (!next || !opts?.continueAfterApprove) {
      return this.getRunOrThrow(runId);
    }
    if (budgetPauseMessage) {
      return this.getRunOrThrow(runId);
    }

    return this.runUntilPause(runId, {
      abortSignal: opts.abortSignal,
      floorNode: next
    });
  }

  async applyPendingTransition(runId: string): Promise<RunRecord> {
    const run = await this.getRunOrThrow(runId);
    assertRunHasNoDelegatedSuccessor(run, "apply_transition");
    const recommendation = run.graph.pendingTransition;
    if (!recommendation) {
      return run;
    }
    if (isSuccessorDelegation(recommendation)) {
      return run;
    }

    const fromNode = run.currentNode;
    run.graph.pendingTransition = undefined;
    run.graph.transitionHistory = [
      ...(run.graph.transitionHistory || []),
      {
        action: recommendation.action,
        sourceNode: recommendation.sourceNode,
        fromNode,
        toNode: recommendation.targetNode,
        reason: recommendation.reason,
        confidence: recommendation.confidence,
        autoExecutable: recommendation.autoExecutable,
        appliedAt: new Date().toISOString()
      }
    ];

    const targetNode = recommendation.targetNode;
    let appliedJump: { targetNode: GraphNodeId; checkpoint: CheckpointRecord } | undefined;
    if (
      recommendation.action !== "advance" &&
      recommendation.action !== "pause_for_human" &&
      targetNode &&
      targetNode !== fromNode
    ) {
      this.applyJumpState(run, targetNode, "safe", recommendation.reason);
      this.syncLatestSummary(run, targetNode);
      const checkpoint = await this.saveCheckpointAndPersist(
        run,
        "jump",
        recommendation.reason
      );
      appliedJump = { targetNode, checkpoint };
    } else {
      this.syncLatestSummary(run);
      await this.runStore.updateRun(run);
    }

    this.eventStream.emit({
      type: "TRANSITION_APPLIED",
      runId: run.id,
      node: targetNode || run.currentNode,
      payload: {
        action: recommendation.action,
        fromNode,
        targetNode,
        reason: recommendation.reason,
        confidence: recommendation.confidence
      }
    });

    if (appliedJump) {
      this.eventStream.emit({
        type: "NODE_JUMP",
        runId: run.id,
        node: appliedJump.targetNode,
        payload: {
          mode: "safe",
          reason: recommendation.reason,
          checkpoint: appliedJump.checkpoint.seq
        }
      });
      return this.getRunOrThrow(run.id);
    }

    if (recommendation.action === "advance") {
      return this.approveCurrent(run.id, { continueAfterApprove: false });
    }

    if (recommendation.action === "pause_for_human" || !recommendation.targetNode) {
      return run;
    }

    if (recommendation.targetNode === run.currentNode) {
      return this.retryNode(run.id, recommendation.targetNode);
    }

    return this.jumpToNode(run.id, recommendation.targetNode, "safe", recommendation.reason);
  }

  async retryNode(runId: string, node?: GraphNodeId): Promise<RunRecord> {
    const run = await this.getRunOrThrow(runId);
    assertRunHasNoDelegatedSuccessor(run, "retry");
    const target = node || run.currentNode;
    const maxAttempts = Math.max(1, run.graph.retryPolicy.maxAttemptsPerNode);
    const nextAttempt = Math.min((run.graph.retryCounters[target] ?? 0) + 1, maxAttempts);
    run.graph.retryCounters[target] = nextAttempt;
    const supersededActiveNodes: GraphNodeId[] = [];
    const updatedAt = new Date().toISOString();
    for (const graphNode of GRAPH_NODE_ORDER) {
      if (graphNode === target) {
        continue;
      }
      const state = run.graph.nodeStates[graphNode];
      if (state.status !== "running" && state.status !== "needs_approval") {
        continue;
      }
      supersededActiveNodes.push(graphNode);
      run.graph.nodeStates[graphNode] = {
        ...state,
        status: "pending",
        updatedAt,
        note: `Manual retry of ${target} superseded this ${state.status} pointer; the node remains unresolved.`
      };
    }
    run.graph.pendingTransition = undefined;
    run.currentNode = target;
    run.graph.currentNode = target;
    run.graph.nodeStates[target] = {
      ...run.graph.nodeStates[target],
      status: "running",
      updatedAt,
      note: "manual retry",
      lastError: undefined
    };
    run.status = "running";

    const budgetPauseMessage = this.applyBudgetGuard(run, target);
    this.syncLatestSummary(run, target);
    const checkpoint = await this.saveCheckpointAndPersist(run, "retry", "manual retry");
    if (budgetPauseMessage) {
      this.emitBudgetGuardObservation(run, budgetPauseMessage);
    }
    this.eventStream.emit({
      type: "NODE_RETRY",
      runId: run.id,
      node: target,
      payload: { attempts: nextAttempt, checkpoint: checkpoint.seq }
    });
    if (supersededActiveNodes.length > 0) {
      this.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: target,
        payload: {
          text: `Manual retry of ${target} deactivated stale active node pointer(s): ${supersededActiveNodes.join(", ")}.`
        }
      });
    }

    return this.getRunOrThrow(runId);
  }

  async jumpToNode(
    runId: string,
    targetNode: GraphNodeId,
    mode: JumpMode,
    reason: string,
    options: { resetCurrent?: boolean } = {}
  ): Promise<RunRecord> {
    const run = await this.getRunOrThrow(runId);
    assertRunHasNoDelegatedSuccessor(run, "jump");
    this.applyJumpState(run, targetNode, mode, reason, options);

    this.syncLatestSummary(run, targetNode);
    const checkpoint = await this.saveCheckpointAndPersist(run, "jump", reason);
    this.eventStream.emit({
      type: "NODE_JUMP",
      runId: run.id,
      node: targetNode,
      payload: {
        mode,
        reason,
        resetCurrent: options.resetCurrent === true,
        checkpoint: checkpoint.seq
      }
    });

    return this.getRunOrThrow(runId);
  }

  private applyJumpState(
    run: RunRecord,
    targetNode: GraphNodeId,
    mode: JumpMode,
    reason: string,
    options: { resetCurrent?: boolean } = {}
  ): void {
    const currentIdx = GRAPH_NODE_ORDER.indexOf(run.currentNode);
    const targetIdx = GRAPH_NODE_ORDER.indexOf(targetNode);

    if (targetIdx < 0) {
      throw new Error(`Unknown target node: ${targetNode}`);
    }

    if (mode === "safe" && targetIdx > currentIdx) {
      throw new Error("Safe jump only allows current/previous nodes.");
    }

    if (targetIdx > currentIdx) {
      for (let idx = currentIdx; idx < targetIdx; idx += 1) {
        const node = GRAPH_NODE_ORDER[idx];
        run.graph.nodeStates[node] = {
          ...run.graph.nodeStates[node],
          status: "skipped",
          updatedAt: new Date().toISOString(),
          note: `Skipped by jump: ${reason}`
        };
      }
    }

    if (targetIdx < currentIdx) {
      const nextCycle = (run.graph.researchCycle || 0) + 1;
      this.resetNodeAndDownstream(run, targetNode, nextCycle, "backward jump");
    } else if (targetIdx === currentIdx && options.resetCurrent) {
      this.resetNodeAndDownstream(
        run,
        targetNode,
        run.graph.researchCycle || 0,
        "new node request"
      );
    }

    run.graph.pendingTransition = undefined;
    run.currentNode = targetNode;
    run.graph.currentNode = targetNode;
    run.status = "paused";
  }

  private resetNodeAndDownstream(
    run: RunRecord,
    targetNode: GraphNodeId,
    researchCycle: number,
    reason: string
  ): void {
    const targetIdx = GRAPH_NODE_ORDER.indexOf(targetNode);
    run.graph.researchCycle = researchCycle;
    for (let idx = targetIdx; idx < GRAPH_NODE_ORDER.length; idx += 1) {
      const node = GRAPH_NODE_ORDER[idx];
      delete run.graph.retryCounters[node];
      delete run.graph.rollbackCounters[node];
      run.graph.nodeStates[node] = {
        ...run.graph.nodeStates[node],
        status: "pending",
        updatedAt: new Date().toISOString(),
        note: `Reset by ${reason} (cycle ${researchCycle})`,
        lastError: undefined,
        approvalSignal: undefined
      };
    }
  }

  async getGraph(runId: string): Promise<RunGraphState> {
    const run = await this.getRunOrThrow(runId);
    return run.graph;
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error("Operation aborted by user");
    }
  }

  private async handleFailure(
    run: RunRecord,
    node: GraphNodeId,
    errorMessage: string,
    usageDelta?: RunUsageDelta,
    failureKind?: GraphNodeResult["failureKind"]
  ): Promise<RunRecord> {
    const latest = await this.getRunOrThrow(run.id);
    if (
      latest.currentNode !== node &&
      latest.graph.currentNode !== node &&
      latest.graph.nodeStates[node]?.status !== "running"
    ) {
      return latest;
    }
    run = latest;
    if (usageDelta) {
      this.applyUsageDelta(run, node, usageDelta);
    }
    run.graph.pendingTransition = undefined;
    const maxAttempts = Math.max(1, run.graph.retryPolicy.maxAttemptsPerNode);
    let nextRetry = Math.min((run.graph.retryCounters[node] ?? 0) + 1, maxAttempts);
    run.graph.retryCounters[node] = nextRetry;

    run.graph.nodeStates[node] = {
      ...run.graph.nodeStates[node],
      status: "failed",
      updatedAt: new Date().toISOString(),
      lastError: errorMessage,
      note: errorMessage
    };

    await saveReflexion({
      runId: run.id,
      nodeId: node,
      attempt: nextRetry,
      errorMessage,
      planExcerpt: `Node ${node}`,
      observations: [errorMessage],
      episodeMemory: new EpisodeMemory(this.runStore.resolveWorkspacePath(run.memoryRefs.episodePath)),
      eventStream: this.eventStream
    });

    // --- Equivalent-failure stopping rule (Target 5) ---
    // If the same error fingerprint has been seen 3+ times for this node,
    // skip remaining retries and proceed directly to rollback/failure.
    const failMem = FailureMemory.forRun(run.id);
    const fingerprint = buildErrorFingerprint(errorMessage);
    const hasDoNotRetryMarker = await failMem.hasDoNotRetry(node);
    if (hasDoNotRetryMarker && nextRetry < maxAttempts) {
      nextRetry = maxAttempts;
      run.graph.retryCounters[node] = nextRetry;
      this.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node,
        payload: {
          text: `Skipping retries for ${node}: failure memory marks this node as do-not-retry until upstream repair.`
        }
      });
    }

    const equivalentCount = await failMem.countEquivalentFailures(node, fingerprint);
    if (equivalentCount >= 3 && nextRetry < maxAttempts) {
      nextRetry = maxAttempts;
      run.graph.retryCounters[node] = nextRetry; // exhaust retries
      this.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node,
        payload: {
          text: `Stopping retries for ${node}: same failure pattern repeated ${equivalentCount} times. Escalating to rollback.`
        }
      });
    }

    const typedRetrySkipObservation = failureKind === "gate_blocked"
      ? `Skipping auto retries for ${node}: the node returned a typed gate block that requires upstream evidence strengthening.`
      : failureKind === "environment"
        ? `Skipping auto retries for ${node}: the node returned a typed environment block that requires configuration or dependency repair.`
        : undefined;
    const autoRetrySkipObservation =
      typedRetrySkipObservation || getAutoRetrySkipObservation(node, errorMessage);
    if (autoRetrySkipObservation && nextRetry < maxAttempts) {
      nextRetry = maxAttempts;
      run.graph.retryCounters[node] = nextRetry;
      this.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node,
        payload: {
          text: autoRetrySkipObservation
        }
      });
    }

    this.syncLatestSummary(run, node);
    await this.recordFailureStageRoutingArtifactIfNeeded(run, node, errorMessage, nextRetry, maxAttempts);
    const failCheckpoint = await this.saveCheckpointAndPersist(run, "fail", errorMessage);
    this.eventStream.emit({
      type: "CHECKPOINT_SAVED",
      runId: run.id,
      node,
      payload: { checkpoint: failCheckpoint.seq, phase: failCheckpoint.phase }
    });
    this.eventStream.emit({
      type: "NODE_FAILED",
      runId: run.id,
      node,
      payload: { error: errorMessage, retryAttempt: nextRetry }
    });

    const verifierRepairTransition = await this.resolveRunVerifierFailureTransition(run, node, errorMessage);
    if (verifierRepairTransition) {
      run.graph.pendingTransition = verifierRepairTransition;
      run.graph.nodeStates[node] = {
        ...run.graph.nodeStates[node],
        status: "needs_approval",
        updatedAt: new Date().toISOString(),
        lastError: errorMessage,
        note: verifierRepairTransition.reason
      };
      run.status = "paused";
      this.syncLatestSummary(run, node);
      const checkpoint = await this.saveCheckpointAndPersist(
        run,
        "after",
        "run verifier requested upstream repair",
        node
      );
      this.eventStream.emit({
        type: "CHECKPOINT_SAVED",
        runId: run.id,
        node,
        payload: { checkpoint: checkpoint.seq, phase: checkpoint.phase }
      });
      this.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node,
        payload: {
          text: "Run verifier routed " + node + " failure to " + (verifierRepairTransition.targetNode || "human review") + ": " + verifierRepairTransition.reason
        }
      });
      return this.getRunOrThrow(run.id);
    }

    if (nextRetry < maxAttempts) {
      run.status = "running";
      run.graph.nodeStates[node] = {
        ...run.graph.nodeStates[node],
        status: "running",
        updatedAt: new Date().toISOString(),
        note: `Auto retry scheduled after failed attempt ${nextRetry}/${maxAttempts}.`,
        lastError: undefined
      };
      const budgetPauseMessage = this.applyBudgetGuard(run, node);
      this.syncLatestSummary(run, node);
      const retryCheckpoint = await this.saveCheckpointAndPersist(run, "retry", "auto retry");
      if (budgetPauseMessage) {
        this.emitBudgetGuardObservation(run, budgetPauseMessage);
      }
      this.eventStream.emit({
        type: "NODE_RETRY",
        runId: run.id,
        node,
        payload: { attempt: nextRetry, checkpoint: retryCheckpoint.seq }
      });
      return this.getRunOrThrow(run.id);
    }

    if (failureKind === "environment" || shouldFailWithoutAutoRollback(node, errorMessage)) {
      run.status = "failed";
      this.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node,
        payload: {
          text: `Skipping auto rollback for ${node}: the failure requires environment or configuration changes rather than rerunning earlier workflow nodes.`
        }
      });
      this.syncLatestSummary(run, node);
      await this.saveCheckpointAndPersist(run, "fail", errorMessage);
      return this.getRunOrThrow(run.id);
    }

    const maxRollbacks = Math.max(0, run.graph.retryPolicy.maxAutoRollbacksPerNode);
    const currentRollbackCount = run.graph.rollbackCounters[node] ?? 0;

    if (currentRollbackCount >= maxRollbacks) {
      run.status = "failed";
      this.syncLatestSummary(run, node);
      await this.saveCheckpointAndPersist(run, "fail", errorMessage);
      return this.getRunOrThrow(run.id);
    }

    const prev = this.previousNode(node);
    if (!prev) {
      run.status = "failed";
      this.syncLatestSummary(run, node);
      await this.saveCheckpointAndPersist(run, "fail", errorMessage);
      return this.getRunOrThrow(run.id);
    }

    const restoredCollectQuery = await this.restoreRollbackCollectRequest(run, prev);
    const rollbackCount = currentRollbackCount + 1;
    run.graph.rollbackCounters[node] = rollbackCount;
    run.graph.retryCounters[node] = 0;
    const rollbackNote = restoredCollectQuery
      ? `Auto rollback from ${node} after ${nextRetry}/${maxAttempts} failed attempts (rollback ${rollbackCount}/${maxRollbacks}); reusing collect query "${restoredCollectQuery}".`
      : `Auto rollback from ${node} after ${nextRetry}/${maxAttempts} failed attempts (rollback ${rollbackCount}/${maxRollbacks}).`;

    run.currentNode = prev;
    run.graph.currentNode = prev;
    run.status = "running";

    run.graph.nodeStates[prev] = {
      ...run.graph.nodeStates[prev],
      status: "running",
      updatedAt: new Date().toISOString(),
      note: rollbackNote,
      lastError: undefined
    };

    const budgetPauseMessage = this.applyBudgetGuard(run, prev);
    this.syncLatestSummary(run, prev);
    const rollbackCheckpoint = await this.saveCheckpointAndPersist(run, "jump", `rollback to ${prev}`);
    if (budgetPauseMessage) {
      this.emitBudgetGuardObservation(run, budgetPauseMessage);
    }
    this.eventStream.emit({
      type: "NODE_ROLLBACK",
      runId: run.id,
      node: prev,
      payload: {
        from: node,
        rollbackCount,
        checkpoint: rollbackCheckpoint.seq
      }
    });

    return this.getRunOrThrow(run.id);
  }

  private nextNode(node: GraphNodeId): GraphNodeId | undefined {
    const idx = GRAPH_NODE_ORDER.indexOf(node);
    if (idx < 0 || idx === GRAPH_NODE_ORDER.length - 1) {
      return undefined;
    }
    return GRAPH_NODE_ORDER[idx + 1];
  }

  private previousNode(node: GraphNodeId): GraphNodeId | undefined {
    const idx = GRAPH_NODE_ORDER.indexOf(node);
    if (idx <= 0) {
      return undefined;
    }
    return GRAPH_NODE_ORDER[idx - 1];
  }

  private async getRunOrThrow(runId: string): Promise<RunRecord> {
    const run = await this.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    run.graph.currentNode = run.currentNode;
    run.graph.transitionHistory = run.graph.transitionHistory || [];
    run.graph.researchCycle = run.graph.researchCycle || 0;
    return run;
  }

  private async pauseIfRegressedBelowFloor(run: RunRecord, floorNode?: GraphNodeId): Promise<RunRecord> {
    if (!floorNode || ["completed", "failed"].includes(run.status)) {
      return run;
    }

    const currentIdx = GRAPH_NODE_ORDER.indexOf(run.currentNode);
    const floorIdx = GRAPH_NODE_ORDER.indexOf(floorNode);
    if (currentIdx < 0 || floorIdx < 0 || currentIdx >= floorIdx) {
      return run;
    }

    const currentState = run.graph.nodeStates[run.currentNode];
    run.status = "paused";
    run.graph.nodeStates[run.currentNode] = {
      ...currentState,
      status: currentState.status === "running" ? "pending" : currentState.status,
      updatedAt: new Date().toISOString(),
      note: appendPauseSuffix(
        currentState.note,
        `Paused before rerunning ${run.currentNode} because execution started from ${floorNode}.`
      )
    };

    this.syncLatestSummary(run);
    await this.runStore.updateRun(run);
    return this.getRunOrThrow(run.id);
  }

  private async pauseForBudgetGuardIfNeeded(
    run: RunRecord,
    noteNode?: GraphNodeId
  ): Promise<RunRecord | undefined> {
    const message = this.applyBudgetGuard(run, noteNode);
    if (!message) {
      return undefined;
    }

    this.emitBudgetGuardObservation(run, message, noteNode);
    await this.runStore.updateRun(run);
    return this.getRunOrThrow(run.id);
  }

  private applyUsageDelta(run: RunRecord, node: GraphNodeId, delta: RunUsageDelta): void {
    run.usage = applyRunUsageDelta(run.usage, node, delta);
  }

  private buildUsageDeltaFromResult(result: GraphNodeResult, startedAtMs: number): RunUsageDelta {
    const elapsedMs = Math.max(0, Date.now() - startedAtMs);
    const reportedWallTimeMs =
      typeof result.usage?.wallTimeMs === "number" && Number.isFinite(result.usage.wallTimeMs)
        ? result.usage.wallTimeMs
        : undefined;

    return {
      toolCalls:
        typeof result.usage?.toolCalls === "number" && Number.isFinite(result.usage.toolCalls)
          ? Math.max(0, result.usage.toolCalls)
          : typeof result.toolCallsUsed === "number" && Number.isFinite(result.toolCallsUsed)
            ? Math.max(0, result.toolCallsUsed)
            : 0,
      costUsd:
        typeof result.usage?.costUsd === "number" && Number.isFinite(result.usage.costUsd)
          ? Math.max(0, result.usage.costUsd)
          : typeof result.costUsd === "number" && Number.isFinite(result.costUsd)
            ? Math.max(0, result.costUsd)
            : 0,
      inputTokens:
        typeof result.usage?.inputTokens === "number" && Number.isFinite(result.usage.inputTokens)
          ? Math.max(0, result.usage.inputTokens)
          : 0,
      outputTokens:
        typeof result.usage?.outputTokens === "number" && Number.isFinite(result.usage.outputTokens)
          ? Math.max(0, result.usage.outputTokens)
          : 0,
      wallTimeMs: Math.max(elapsedMs, reportedWallTimeMs ?? 0),
      executions: 1,
      lastUpdatedAt: new Date().toISOString()
    };
  }

  private buildUsageDeltaForException(startedAtMs: number): RunUsageDelta {
    return {
      toolCalls: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      wallTimeMs: Math.max(0, Date.now() - startedAtMs),
      executions: 1,
      lastUpdatedAt: new Date().toISOString()
    };
  }

  private applyBudgetGuard(run: RunRecord, noteNode?: GraphNodeId): string | undefined {
    const threshold = this.getBudgetGuardUsd();
    const cumulativeCost = run.usage?.totals.costUsd;
    if (
      threshold === undefined ||
      typeof cumulativeCost !== "number" ||
      !Number.isFinite(cumulativeCost) ||
      cumulativeCost <= threshold ||
      run.status === "completed" ||
      run.status === "failed"
    ) {
      return undefined;
    }

    const node = noteNode ?? run.currentNode;
    const timestamp = new Date().toISOString();
    const currentState = run.graph.nodeStates[node] ?? {
      status: "pending",
      updatedAt: timestamp
    };
    const message = `Budget guard paused further execution at ${node} because cumulative run spend is $${formatBudgetUsd(
      cumulativeCost
    )}, above the configured limit of $${formatBudgetUsd(threshold)}.`;
    const note =
      currentState.note && currentState.status !== "pending"
        ? appendPauseSuffix(currentState.note, message)
        : message;

    run.status = "paused";
    run.graph.nodeStates[node] = {
      ...currentState,
      status: currentState.status === "running" ? "pending" : currentState.status,
      updatedAt: timestamp,
      note
    };
    this.syncLatestSummary(run, node);
    return message;
  }

  private emitBudgetGuardObservation(
    run: RunRecord,
    message: string,
    noteNode?: GraphNodeId
  ): void {
    this.eventStream.emit({
      type: "OBS_RECEIVED",
      runId: run.id,
      node: noteNode ?? run.currentNode,
      payload: {
        text: message
      }
    });
  }

  private getBudgetGuardUsd(): number | undefined {
    const value = this.options.budgetGuardUsd;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  }

  private hasVisitedLaterNodes(run: RunRecord, floorNode: GraphNodeId): boolean {
    const floorIdx = GRAPH_NODE_ORDER.indexOf(floorNode);
    if (floorIdx < 0) {
      return false;
    }

    return GRAPH_NODE_ORDER.slice(floorIdx + 1).some((node) => {
      const state = run.graph.nodeStates[node];
      return state.status !== "pending" || Boolean(state.note) || Boolean(state.lastError);
    });
  }

  private async saveCheckpointAndPersist(
    run: RunRecord,
    phase: CheckpointPhase,
    reason?: string,
    checkpointNode?: GraphNodeId
  ): Promise<CheckpointRecord> {
    const records = await this.checkpointStore.list(run.id);
    const highestSeq = records.reduce((max, record) => Math.max(max, record.seq), 0);
    run.graph.checkpointSeq = Math.max(run.graph.checkpointSeq ?? 0, highestSeq);
    run.updatedAt = new Date().toISOString();
    this.syncLatestSummary(run);
    let checkpoint: CheckpointRecord;
    try {
      checkpoint = await this.checkpointStore.save(run, phase, reason, checkpointNode);
    } catch (error) {
      const node = checkpointNode || run.currentNode;
      const message = error instanceof Error ? error.message : String(error);
      const state = run.graph.nodeStates[node];
      run.status = "paused";
      run.graph.nodeStates[node] = {
        ...state,
        status: state.status === "running" ? "pending" : state.status,
        updatedAt: new Date().toISOString(),
        note: appendPauseSuffix(
          state.note,
          `Paused after checkpoint write failure during ${phase}: ${message}`
        )
      };
      this.syncLatestSummary(run, node);
      await this.recordStageRoutingArtifact(run, {
        node,
        event: "checkpoint_write_failure",
        phase,
        reason: message,
        disposition: "safe_pause",
        retrySafe: true,
        evidence: [
          `checkpoint_phase=${phase}`,
          `checkpoint_reason=${reason ?? ""}`,
          `checkpoint_seq=${run.graph.checkpointSeq ?? 0}`
        ],
        suggestedCommands: [`/agent run ${run.id}`]
      });
      await this.runStore.updateRun(run);
      return {
        seq: run.graph.checkpointSeq ?? highestSeq,
        runId: run.id,
        node,
        phase,
        reason: `checkpoint write failed: ${message}`,
        createdAt: new Date().toISOString(),
        runSnapshot: structuredClone(run)
      };
    }
    await this.runStore.updateRun(run);
    return checkpoint;
  }

  private async resolveRunVerifierFailureTransition(
    run: RunRecord,
    node: GraphNodeId,
    errorMessage: string
  ): Promise<TransitionRecommendation | undefined> {
    if (node !== "run_experiments") {
      return undefined;
    }

    const report = await readRunVerifierRoutingReport(run.id);
    if (!isRunVerifierUpstreamRepairReport(report)) {
      return undefined;
    }

    const targetNode = normalizeGraphNodeId(report.recommended_backtrack_node);
    const action = targetNode ? backtrackActionForTarget(targetNode) : undefined;
    if (!targetNode || !action || targetNode === node) {
      return undefined;
    }

    const hint = stringValue(report.upstream_repair_hint);
    const suggestedNextAction = stringValue(report.suggested_next_action);
    const summary = stringValue(report.summary) || errorMessage;
    const reason = truncateTransitionText(hint || suggestedNextAction || summary, 600);
    const operatorActionRequired = report.operator_action_required === true;
    const suggestedCommands = operatorActionRequired
      ? ["/approve " + run.id, "/agent jump " + targetNode]
      : ["/approve " + run.id];

    return {
      action,
      sourceNode: node,
      targetNode,
      reason,
      confidence: operatorActionRequired ? 0.8 : 0.9,
      autoExecutable: !operatorActionRequired,
      evidence: [
        "failure_code=" + (stringValue(report.failure_code) || "unknown"),
        "repair_target=" + (stringValue(report.repair_target) || "unknown"),
        "operator_action_required=" + String(operatorActionRequired),
        "verifier_stage=" + (stringValue(report.stage) || "unknown")
      ],
      suggestedCommands,
      generatedAt: new Date().toISOString()
    };
  }

  private async recordFailureStageRoutingArtifactIfNeeded(
    run: RunRecord,
    node: GraphNodeId,
    errorMessage: string,
    nextRetry: number,
    maxAttempts: number
  ): Promise<void> {
    const event = classifyStageRoutingFailure(errorMessage);
    if (!event) {
      return;
    }
    const retrySafe = nextRetry < maxAttempts;
    await this.recordStageRoutingArtifact(run, {
      node,
      event,
      phase: "fail",
      reason: errorMessage,
      disposition: retrySafe ? "safe_retry" : "safe_pause",
      retrySafe,
      evidence: [
        `retry_attempt=${nextRetry}/${maxAttempts}`,
        `node_status=${run.graph.nodeStates[node]?.status ?? "unknown"}`
      ],
      suggestedCommands: retrySafe ? [`/agent run ${run.id}`] : [`/retry ${run.id} ${node}`]
    });
  }

  private isCheckpointWritePause(run: RunRecord, node: GraphNodeId): boolean {
    return (
      run.status === "paused" &&
      Boolean(run.graph.nodeStates[node]?.note?.includes("Paused after checkpoint write failure"))
    );
  }

  private async recordStageRoutingArtifact(
    run: RunRecord,
    input: {
      node?: GraphNodeId;
      event: StageRoutingEvent;
      phase?: CheckpointPhase;
      reason: string;
      disposition: StageRoutingDisposition;
      retrySafe: boolean;
      evidence?: string[];
      suggestedCommands?: string[];
    }
  ): Promise<void> {
    const node = input.node ?? run.currentNode;
    await writeStageRoutingArtifactBestEffort(
      process.cwd(),
      buildStageRoutingArtifact({
        runId: run.id,
        nodeId: node,
        event: input.event,
        phase: input.phase,
        reason: input.reason,
        disposition: input.disposition,
        retrySafe: input.retrySafe,
        checkpointSeq: run.graph.checkpointSeq ?? 0,
        evidence: input.evidence,
        suggestedCommands: input.suggestedCommands
      })
    );
  }

  private syncLatestSummary(run: RunRecord, preferredNode?: GraphNodeId): void {
    const primaryNode = preferredNode ?? run.currentNode;
    const primaryNote = run.graph.nodeStates[primaryNode]?.note?.trim();
    if (primaryNote) {
      run.latestSummary = primaryNote;
      return;
    }

    const currentNote = run.graph.nodeStates[run.currentNode]?.note?.trim();
    if (currentNote) {
      run.latestSummary = currentNote;
    }
  }

  private isCheckpointSnapshotStale(current: RunRecord, snapshot: RunRecord): boolean {
    const currentSeq = current.graph.checkpointSeq ?? 0;
    const snapshotSeq = snapshot.graph.checkpointSeq ?? 0;
    if (currentSeq > snapshotSeq) {
      return true;
    }

    const currentUpdated = Date.parse(current.updatedAt || "");
    const snapshotUpdated = Date.parse(snapshot.updatedAt || "");
    return Number.isFinite(currentUpdated) && Number.isFinite(snapshotUpdated) && currentUpdated > snapshotUpdated;
  }

  private async restoreRollbackCollectRequest(
    run: RunRecord,
    targetNode: GraphNodeId
  ): Promise<string | undefined> {
    if (targetNode !== "collect_papers") {
      return undefined;
    }

    const runContext = new RunContextMemory(this.runStore.resolveWorkspacePath(run.memoryRefs.runContextPath));
    const pendingRequest = await runContext.get<Record<string, unknown> | null>("collect_papers.request");
    if (pendingRequest) {
      if (isInternalTopicDiscoveryLaneRequest(pendingRequest)) {
        await runContext.put("collect_papers.request", null);
        await runContext.put("collect_papers.requested_limit", null);
        return undefined;
      }
      const pendingQuery = pendingRequest.query;
      return typeof pendingQuery === "string" && pendingQuery.trim() ? pendingQuery.trim() : undefined;
    }

    const lastRequest = await runContext.get<Record<string, unknown> | null>("collect_papers.last_request");
    const lastResult = await runContext.get<{ stored?: number; completed?: boolean } | null>("collect_papers.last_result");
    if (!lastRequest || !lastResult || lastResult.completed === false || Number(lastResult.stored ?? 0) <= 0) {
      return undefined;
    }

    if (isInternalTopicDiscoveryLaneRequest(lastRequest)) {
      await runContext.put("collect_papers.request", null);
      await runContext.put("collect_papers.requested_limit", null);
      return undefined;
    }

    const query = typeof lastRequest.query === "string" ? lastRequest.query.trim() : "";
    if (!query) {
      return undefined;
    }

    const nextRequest = structuredClone(lastRequest);
    await runContext.put("collect_papers.request", nextRequest);
    const limit = typeof nextRequest.limit === "number" && Number.isFinite(nextRequest.limit) ? nextRequest.limit : null;
    await runContext.put("collect_papers.requested_limit", limit);
    return query;
  }

  private getGovernancePolicy(): GovernancePolicy {
    if (!this.governancePolicy) {
      this.governancePolicy = this.options.governancePolicy || loadGovernancePolicy();
    }
    return this.governancePolicy;
  }

  private async recordGovernanceBenchmarkCondition(
    run: RunRecord
  ): Promise<GovernanceBenchmarkCondition | undefined> {
    if (!this.options.benchmarkCondition) {
      return undefined;
    }
    const condition =
      typeof this.options.benchmarkCondition === "string"
        ? resolveGovernanceBenchmarkCondition(this.options.benchmarkCondition)
        : this.options.benchmarkCondition;
    const runRoot = buildWorkspaceRunRoot(process.cwd(), run.id);
    await writeJsonFile(path.join(runRoot, "governance_condition.json"), {
      ...condition,
      recorded_at: new Date().toISOString(),
      run_id: run.id
    });
    return condition;
  }

  private buildNodeGovernanceAction(runId: string, node: GraphNodeId): ClassifiableAction {
    const targetByNode: Record<GraphNodeId, string> = {
      collect_papers: `.autolabos/runs/${runId}/corpus.jsonl`,
      analyze_papers: `.autolabos/runs/${runId}/paper_summaries.jsonl`,
      generate_hypotheses: `.autolabos/runs/${runId}/hypotheses.json`,
      design_experiments: `.autolabos/runs/${runId}/experiment_contract.json`,
      implement_experiments: `.autolabos/runs/${runId}/implement_experiments_session.json`,
      run_experiments: `.autolabos/runs/${runId}/metrics.json`,
      analyze_results: `.autolabos/runs/${runId}/result_analysis.json`,
      figure_audit: `.autolabos/runs/${runId}/figure_audit/figure_audit_summary.json`,
      review: `.autolabos/runs/${runId}/review/review_packet.json`,
      write_paper: `.autolabos/runs/${runId}/paper/main.tex`
    };

    return {
      type: "file_write",
      target: targetByNode[node],
      context: node
    };
  }

  private async evaluateNodeGovernance(
    run: RunRecord,
    node: GraphNodeId
  ): Promise<PolicyEvaluationResult | null> {
    const action = this.buildNodeGovernanceAction(run.id, node);
    const evaluator = this.options.evaluateGovernanceAction || evaluateActionDetailed;
    return evaluator(action, this.getGovernancePolicy(), run.id, node);
  }

  private async pauseForGovernanceReview(
    run: RunRecord,
    node: GraphNodeId,
    detail: string
  ): Promise<RunRecord> {
    run.graph.pendingTransition = {
      action: "pause_for_human",
      sourceNode: node,
      targetNode: node,
      reason: `governance: ${detail}`,
      confidence: 1,
      autoExecutable: false,
      evidence: [detail],
      suggestedCommands: [`/approve ${run.id}`],
      generatedAt: new Date().toISOString()
    };
    run.graph.nodeStates[node] = {
      ...run.graph.nodeStates[node],
      status: "needs_approval",
      updatedAt: new Date().toISOString(),
      note: detail
    };
    run.status = "paused";
    this.syncLatestSummary(run, node);
    const checkpoint = await this.saveCheckpointAndPersist(run, "after", "governance review required", node);
    this.eventStream.emit({
      type: "CHECKPOINT_SAVED",
      runId: run.id,
      node,
      payload: { checkpoint: checkpoint.seq, phase: checkpoint.phase }
    });
    this.eventStream.emit({
      type: "OBS_RECEIVED",
      runId: run.id,
      node,
      payload: { text: detail }
    });
    return this.getRunOrThrow(run.id);
  }

  private async stopForGovernance(run: RunRecord, node: GraphNodeId, detail: string): Promise<RunRecord> {
    run.graph.pendingTransition = undefined;
    run.graph.nodeStates[node] = {
      ...run.graph.nodeStates[node],
      status: "failed",
      updatedAt: new Date().toISOString(),
      lastError: detail,
      note: detail
    };
    run.status = "failed";
    this.syncLatestSummary(run, node);
    const checkpoint = await this.saveCheckpointAndPersist(run, "fail", detail, node);
    this.eventStream.emit({
      type: "CHECKPOINT_SAVED",
      runId: run.id,
      node,
      payload: { checkpoint: checkpoint.seq, phase: checkpoint.phase }
    });
    this.eventStream.emit({
      type: "NODE_FAILED",
      runId: run.id,
      node,
      payload: { error: detail, retryAttempt: 0 }
    });
    return this.getRunOrThrow(run.id);
  }

  private isGovernancePreExecutionPause(run: RunRecord, node: GraphNodeId): boolean {
    const recommendation = run.graph.pendingTransition;
    return Boolean(
      recommendation &&
        recommendation.action === "pause_for_human" &&
        recommendation.targetNode === node &&
        recommendation.reason?.startsWith("governance:")
    );
  }
}

function isInternalTopicDiscoveryLaneRequest(
  request: Record<string, unknown>
): boolean {
  const candidatePriorPlan = request.candidatePriorSearchPlan;
  return request.retrievalIntent === "topic_discovery"
    && (!candidatePriorPlan
      || typeof candidatePriorPlan !== "object"
      || Array.isArray(candidatePriorPlan));
}

interface RunVerifierRoutingReport {
  status?: unknown;
  stage?: unknown;
  summary?: unknown;
  suggested_next_action?: unknown;
  failure_code?: unknown;
  repair_target?: unknown;
  recommended_backtrack_node?: unknown;
  upstream_repair_hint?: unknown;
  operator_action_required?: unknown;
}

async function readRunVerifierRoutingReport(runId: string): Promise<RunVerifierRoutingReport | undefined> {
  const reportPath = path.join(
    process.cwd(),
    ".autolabos",
    "runs",
    runId,
    "run_experiments_verify_report.json"
  );
  try {
    const parsed = JSON.parse(await fs.readFile(reportPath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as RunVerifierRoutingReport
      : undefined;
  } catch {
    return undefined;
  }
}

function isRunVerifierUpstreamRepairReport(report: RunVerifierRoutingReport | undefined): report is RunVerifierRoutingReport {
  if (!report || stringValue(report.status) !== "fail") {
    return false;
  }
  const failureCode = stringValue(report.failure_code);
  const repairTarget = stringValue(report.repair_target);
  return (
    failureCode === "model_dependency_unavailable" ||
    failureCode === "data_dependency_unavailable" ||
    repairTarget === "environment_dependency"
  );
}

function normalizeGraphNodeId(value: unknown): GraphNodeId | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return (GRAPH_NODE_ORDER as readonly string[]).includes(value) ? value as GraphNodeId : undefined;
}

function backtrackActionForTarget(targetNode: GraphNodeId): TransitionRecommendation["action"] | undefined {
  if (targetNode === "collect_papers") {
    return "backtrack_to_collection";
  }
  if (targetNode === "implement_experiments") {
    return "backtrack_to_implement";
  }
  if (targetNode === "design_experiments") {
    return "backtrack_to_design";
  }
  if (targetNode === "generate_hypotheses") {
    return "backtrack_to_hypotheses";
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function truncateTransitionText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " " ).trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
}

function shouldSkipAutoRetryForFailure(node: GraphNodeId, errorMessage: string): boolean {
  const normalized = normalizeFailureMessage(errorMessage);
  if (isCodexOAuthCompletionFailure(normalized)) {
    return true;
  }
  if (node === "design_experiments") {
    return normalized.includes("brief contract blocked design progression:");
  }

  if (node === "generate_hypotheses") {
    return normalized.includes("hypothesis generation blocked:");
  }

  if (node === "implement_experiments") {
    return normalized.includes("implementation execution failed before any runnable implementation was produced:");
  }

  if (node === "analyze_papers") {
    return isAnalyzePapersResponsesApiPdfConfigFailure(normalized);
  }

  if (node === "collect_papers") {
    return isTopicDiscoverySemanticReviewRecoveryExhausted(normalized);
  }

  if (node === "write_paper") {
    return isWritePaperUpstreamEvidenceFailure(normalized);
  }

  return false;
}

function getAutoRetrySkipObservation(node: GraphNodeId, errorMessage: string): string | undefined {
  if (!shouldSkipAutoRetryForFailure(node, errorMessage)) {
    return undefined;
  }

  const codexOAuthCode = parseCodexOAuthCompletionErrorCode(errorMessage);
  if (codexOAuthCode) {
    return getCodexOAuthRetrySkipObservation(node, codexOAuthCode);
  }

  if (node === "analyze_papers") {
    return `Skipping auto retries for ${node}: the failure requires environment or configuration changes rather than another identical attempt.`;
  }

  if (node === "collect_papers") {
    return `Skipping auto retries for ${node}: the frozen semantic-review recovery budget is exhausted and retrieval must remain unchanged.`;
  }

  return `Skipping auto retries for ${node}: the failure requires upstream evidence strengthening rather than another identical attempt.`;
}

function shouldFailWithoutAutoRollback(node: GraphNodeId, errorMessage: string): boolean {
  const normalized = normalizeFailureMessage(errorMessage);
  if (isCodexOAuthCompletionFailure(normalized)) {
    return true;
  }
  if (node === "design_experiments") {
    return normalized.includes("brief contract blocked design progression:");
  }

  if (node === "analyze_papers") {
    return isAnalyzePapersResponsesApiPdfConfigFailure(normalized);
  }

  if (node === "implement_experiments") {
    return isImplementProviderEnvironmentFailure(normalized);
  }
  if (node === "collect_papers") {
    return isTopicDiscoverySemanticReviewRecoveryExhausted(normalized);
  }
  return false;
}

function isTopicDiscoverySemanticReviewRecoveryExhausted(
  normalizedErrorMessage: string
): boolean {
  return normalizedErrorMessage.includes(
    "topic_discovery_semantic_review_recovery_exhausted:"
  );
}

function isWritePaperUpstreamEvidenceFailure(normalizedErrorMessage: string): boolean {
  return (
    normalizedErrorMessage.includes("scientific quality gate failed in strict-paper mode:") &&
    (
      normalizedErrorMessage.includes("missing categories: resource measurement") ||
      normalizedErrorMessage.includes("evidence insufficiency remains in method")
    )
  );
}

function isAnalyzePapersResponsesApiPdfConfigFailure(normalizedErrorMessage: string): boolean {
  return (
    normalizedErrorMessage.includes("responses api pdf analysis is selected, but openai_api_key is not configured") ||
    normalizedErrorMessage.includes("openai_api_key is required when pdf analysis mode is set to responses api")
  );
}

function isImplementProviderEnvironmentFailure(normalizedErrorMessage: string): boolean {
  return (
    normalizedErrorMessage.includes("codex oauth authentication required") ||
    isCodexOAuthCompletionFailure(normalizedErrorMessage) ||
    normalizedErrorMessage.includes("usage_limit_reached") ||
    normalizedErrorMessage.includes("usage limit has been reached") ||
    normalizedErrorMessage.includes("model is not supported when using codex") ||
    normalizedErrorMessage.includes("openai_api_key is required")
  );
}

function isCodexOAuthCompletionFailure(normalizedErrorMessage: string): boolean {
  return parseCodexOAuthCompletionErrorCode(normalizedErrorMessage) !== undefined;
}

function getCodexOAuthRetrySkipObservation(
  node: GraphNodeId,
  code: CodexOAuthCompletionErrorCode
): string {
  switch (code) {
    case "auth_unavailable":
      return `Skipping graph-level retries for ${node}: operator action is required to restore Codex OAuth authentication before retrying this node.`;
    case "quota_exhausted":
      return `Skipping graph-level retries for ${node}: the Codex OAuth usage quota is exhausted. Wait for the quota to reset or repair the provider account before retrying this node.`;
    case "request_rejected":
      return `Skipping graph-level retries for ${node}: the Codex OAuth request was rejected. Check the configured model and request settings before retrying this node.`;
    case "input_unavailable":
      return `Skipping graph-level retries for ${node}: a local Codex OAuth completion input could not be prepared. Check the referenced input before retrying this node.`;
    case "rate_limited":
    case "transport_error":
    case "provider_unavailable":
      return `Skipping immediate graph-level retries for ${node}: this transient Codex OAuth failure requires backoff. Wait for provider or network recovery before retrying this node.`;
    case "stream_terminated":
    case "incomplete_response":
      return `Skipping identical graph-level retries for ${node}: the Codex OAuth response ended before completion and requires caller-level recovery or request repair.`;
    case "observer_error":
      return `Skipping graph-level retries for ${node}: the local completion progress observer failed. Repair local progress or event handling before retrying this node.`;
    case "provider_error":
    case "empty_response":
      return `Skipping graph-level retries for ${node}: Codex OAuth returned no usable completion. Inspect provider availability and adapter diagnostics before retrying this node.`;
  }
}

function normalizeFailureMessage(errorMessage: string): string {
  return errorMessage.trim().toLowerCase();
}


function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const lower = error.message.toLowerCase();
  return lower.includes("aborted") || lower.includes("abort");
}

function isHybridAutoApproved(signal: ApprovalSignal | undefined): boolean {
  if (!signal || typeof signal.overall_score !== "number" || !Array.isArray(signal.specialist_scores)) {
    return false;
  }
  if (!Number.isFinite(signal.overall_score) || signal.overall_score < 7) {
    return false;
  }
  return signal.specialist_scores.every((score) => Number.isFinite(score) && score >= 4);
}

function isSuccessorDelegation(
  recommendation: TransitionRecommendation | undefined
): boolean {
  return recommendation?.action === "delegate_successor";
}

function labelApprovalMode(mode: WorkflowApprovalMode | undefined): string {
  switch (mode) {
    case "manual":
      return "Manual";
    case "hybrid":
      return "Hybrid";
    default:
      return "Minimal";
  }
}

function appendPauseSuffix(note: string | undefined, suffix: string): string {
  const base = (note || "").trim();
  if (!base) {
    return suffix;
  }
  if (base.includes(suffix)) {
    return base;
  }
  return `${base} ${suffix}`;
}

function formatBudgetUsd(value: number): string {
  const rounded =
    value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value >= 1 ? value.toFixed(2) : value.toFixed(4);
  return rounded.replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1");
}
