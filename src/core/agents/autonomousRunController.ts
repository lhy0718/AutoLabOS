import path from "node:path";

import { EventStream } from "../events.js";
import { RunStore } from "../runs/runStore.js";
import { GRAPH_NODE_ORDER, GraphNodeId, RunRecord, TransitionRecommendation } from "../../types.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import { AutonomousProgressReporter, AutonomousCycleSnapshot, BestBranchInfo } from "./autonomousProgressReporter.js";
import { writeRunArtifact, safeRead } from "../nodes/helpers.js";
import {
  type TopicProbeFollowupExecutionLease,
  TopicProbeFollowupRunManager,
  type TopicProbeFollowupRunResult
} from "../topicProbeFollowupRun.js";
import type {
  RunPromotionExecutionState,
  RunPromotionTerminalStatus
} from "../runs/runPromotionStore.js";

// ---------------------------------------------------------------------------
// Policy types
// ---------------------------------------------------------------------------

export type AutonomousRunMode = "overnight" | "autonomous";

export interface OvernightRunPolicy {
  mode: "overnight";
  maxMinutes: number;
  minTransitionConfidence: number;
  minDeepBacktrackConfidence: number;
  autoApproveNodes: GraphNodeId[];
  allowedBacktracks: GraphNodeId[];
  maxBackwardJumps: number;
  maxDeepBacktracks: number;
  stopOnRepeatedRecommendation: number;
  stopBeforeWritePaper: boolean;
}

export interface AutonomousNoveltyConfig {
  /** How many recent cycles to inspect for novelty signals */
  windowSize: number;
  /** Minimum novel signals required per window to avoid stagnation */
  minNovelSignalsPerWindow: number;
  /** Maximum consecutive stagnant windows before stopping */
  maxStagnantWindows: number;
}

export interface AutonomousPaperPressureConfig {
  /** Run paper-quality improvement every N cycles */
  checkIntervalCycles: number;
  /** Force write_paper pass if the best branch has not been upgraded in N cycles */
  forceUpgradeAfterCycles: number;
}

export interface AutonomousFuseConfig {
  /** Max total iterations before emergency stop */
  maxTotalIterations: number;
  /** Max consecutive failures before emergency stop */
  maxConsecutiveFailures: number;
  /** Max identical recommendation repeats before emergency stop */
  maxRepeatedRecommendation: number;
}

export interface WritePaperGateConfig {
  /** Require baseline or comparator before drafting */
  requireBaselineOrComparator: boolean;
  /** Require quantitative results before drafting */
  requireQuantitativeResults: boolean;
  /** Minimum branch score to allow write_paper entry */
  minBranchScore: number;
  /** Manuscript types that block write_paper (evidence too weak) */
  blockedManuscriptTypes: string[];
}

export interface AutonomousModePolicy {
  mode: "autonomous";
  /** Runtime limit in minutes. Use Infinity for unbounded runtime. */
  maxMinutes: number;
  minTransitionConfidence: number;
  minDeepBacktrackConfidence: number;
  autoApproveNodes: GraphNodeId[];
  allowedBacktracks: GraphNodeId[];
  maxBackwardJumps: number;
  maxDeepBacktracks: number;
  stopBeforeWritePaper: boolean;
  novelty: AutonomousNoveltyConfig;
  paperPressure: AutonomousPaperPressureConfig;
  fuse: AutonomousFuseConfig;
  /** Conditional gate for write_paper entry — review remains a structural gate */
  writePaperGate: WritePaperGateConfig;
}

export type AutonomousRunPolicy = OvernightRunPolicy | AutonomousModePolicy;

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

export type AutonomousStopReason =
  | "user_stop"
  | "time_limit"
  | "resource_limit"
  | "run_completed"
  | "run_failed"
  | "write_paper_gate"
  | "manual_review_required"
  | "repeated_recommendation"
  | "stagnation"
  | "followup_handoff_blocked"
  | "catastrophic_fuse"
  | "consecutive_failures";

export interface TopicProbeFollowupRunConsumer {
  consumePromotedFollowup(parentRun: RunRecord): Promise<TopicProbeFollowupRunResult>;
  heartbeatExecution?(
    lease: TopicProbeFollowupExecutionLease
  ): Promise<TopicProbeFollowupExecutionLease>;
  markExecutionTerminal?(
    lease: TopicProbeFollowupExecutionLease,
    status: RunPromotionTerminalStatus,
    detail?: string
  ): Promise<RunPromotionExecutionState>;
}

// ---------------------------------------------------------------------------
// Novelty signals
// ---------------------------------------------------------------------------

export interface NoveltySignal {
  cycle: number;
  type:
    | "new_hypothesis"
    | "new_comparator"
    | "new_experiment_artifact"
    | "different_analysis_outcome"
    | "new_research_risk_resolved"
    | "paper_quality_upgrade"
    | "new_backtrack_target";
  detail: string;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AutonomousRunResult {
  run: RunRecord;
  status: "completed" | "stopped" | "failed" | "canceled";
  reason: string;
  stopReason?: AutonomousStopReason;
  approvalsApplied: number;
  transitionsApplied: number;
  iterations: number;
  researchCycles?: number;
  noveltySignals?: NoveltySignal[];
  paperStatus?: string;
  bestBranch?: BestBranchInfo;
}

// ---------------------------------------------------------------------------
// Policy builders
// ---------------------------------------------------------------------------

export function buildDefaultOvernightPolicy(): OvernightRunPolicy {
  return {
    mode: "overnight",
    maxMinutes: 24 * 60,
    minTransitionConfidence: 0.75,
    minDeepBacktrackConfidence: 0.88,
    autoApproveNodes: [
      "design_experiments",
      "implement_experiments",
      "run_experiments",
      "analyze_results"
    ],
    allowedBacktracks: ["implement_experiments", "design_experiments", "generate_hypotheses"],
    maxBackwardJumps: 4,
    maxDeepBacktracks: 1,
    stopOnRepeatedRecommendation: 2,
    stopBeforeWritePaper: true
  };
}

export function buildDefaultAutonomousPolicy(): AutonomousModePolicy {
  return {
    mode: "autonomous",
    maxMinutes: Infinity,
    minTransitionConfidence: 0.60,
    minDeepBacktrackConfidence: 0.70,
    autoApproveNodes: [
      "generate_hypotheses",
      "design_experiments",
      "implement_experiments",
      "run_experiments",
      "analyze_results"
    ],
    allowedBacktracks: [
      "generate_hypotheses",
      "design_experiments",
      "implement_experiments"
    ],
    maxBackwardJumps: 50,
    maxDeepBacktracks: 20,
    stopBeforeWritePaper: false,
    novelty: {
      windowSize: 5,
      minNovelSignalsPerWindow: 1,
      maxStagnantWindows: 3
    },
    paperPressure: {
      checkIntervalCycles: 3,
      forceUpgradeAfterCycles: 6
    },
    fuse: {
      maxTotalIterations: 500,
      maxConsecutiveFailures: 10,
      maxRepeatedRecommendation: 5
    },
    writePaperGate: {
      requireBaselineOrComparator: true,
      requireQuantitativeResults: true,
      minBranchScore: 5,
      blockedManuscriptTypes: ["not_analyzed", "system_validation_note"]
    }
  };
}

export class AutonomousRunController {
  constructor(
    private readonly runStore: RunStore,
    private readonly orchestrator: AgentOrchestrator,
    private readonly eventStream: EventStream,
    private readonly topicProbeFollowupRuns: TopicProbeFollowupRunConsumer =
      buildDefaultTopicProbeFollowupConsumer(runStore)
  ) {}

  // -------------------------------------------------------------------------
  // Overnight mode (unchanged behavior, refactored to use shared helpers)
  // -------------------------------------------------------------------------

  async runOvernight(
    runId: string,
    policy: AutonomousRunPolicy = buildDefaultOvernightPolicy(),
    opts?: { abortSignal?: AbortSignal }
  ): Promise<AutonomousRunResult> {
    const startedAt = Date.now();
    let approvalsApplied = 0;
    let transitionsApplied = 0;
    let iterations = 0;
    let repeatedRecommendationCount = 0;
    let lastRecommendationKey: string | undefined;

    let run = await this.getRunOrThrow(runId);
    this.emit(run, `Overnight autonomy started. Max ${policy.maxMinutes} minutes, stop_before_write_paper=${policy.stopBeforeWritePaper}.`);

    while (true) {
      this.throwIfAborted(opts?.abortSignal);
      run = await this.getRunOrThrow(runId);

      if (Date.now() - startedAt > policy.maxMinutes * 60 * 1000) {
        this.emit(run, "Overnight autonomy stopped: time limit reached.");
        return {
          run,
          status: "stopped",
          reason: "Overnight time limit reached.",
          stopReason: "time_limit",
          approvalsApplied,
          transitionsApplied,
          iterations
        };
      }

      if (policy.stopBeforeWritePaper && run.currentNode === "write_paper") {
        this.emit(run, "Overnight autonomy stopped before write_paper for manual review.");
        return {
          run,
          status: "stopped",
          reason: "Reached write_paper gate.",
          stopReason: "write_paper_gate",
          approvalsApplied,
          transitionsApplied,
          iterations
        };
      }

      if (run.status === "completed") {
        this.emit(run, "Overnight autonomy completed the run.");
        return {
          run,
          status: "completed",
          reason: "Run completed.",
          stopReason: "run_completed",
          approvalsApplied,
          transitionsApplied,
          iterations
        };
      }

      if (run.status === "failed") {
        this.emit(run, `Overnight autonomy stopped because the run ${run.status}.`);
        return {
          run,
          status: "failed",
          reason: `Run ${run.status}.`,
          stopReason: "run_failed",
          approvalsApplied,
          transitionsApplied,
          iterations
        };
      }

      const state = run.graph.nodeStates[run.currentNode];
      if (run.status === "paused" && state.status === "needs_approval") {
        const recommendation = run.graph.pendingTransition;
        if (recommendation) {
          const key = recommendationKey(recommendation);
          if (recommendation.action === "pause_for_human") {
            this.emit(run, `Overnight autonomy paused for required human review at ${run.currentNode}: ${key}.`);
            return {
              run,
              status: "stopped",
              reason: `Manual review required for recommendation ${key} at ${run.currentNode}.`,
              stopReason: "manual_review_required",
              approvalsApplied,
              transitionsApplied,
              iterations
            };
          }


          repeatedRecommendationCount = key === lastRecommendationKey ? repeatedRecommendationCount + 1 : 1;
          lastRecommendationKey = key;
          const stopThreshold = policy.mode === "overnight"
            ? (policy as OvernightRunPolicy).stopOnRepeatedRecommendation
            : 5;
          if (repeatedRecommendationCount > stopThreshold) {
            this.emit(run, `Overnight autonomy stopped after repeated recommendation: ${key}.`);
            return {
              run,
              status: "stopped",
              reason: `Repeated recommendation: ${key}.`,
              stopReason: "repeated_recommendation",
              approvalsApplied,
              transitionsApplied,
              iterations
            };
          }

          if (this.canApplyRecommendation(run, recommendation, policy)) {
            this.emit(
              run,
              `Applying recommended transition ${recommendation.action} -> ${recommendation.targetNode || "stay"}.`
            );
            run = await this.orchestrator.applyPendingTransition(run.id);
            transitionsApplied += 1;
            continue;
          }

          this.emit(
            run,
            `Overnight autonomy paused for manual review at ${run.currentNode}: pending recommendation ${key}.`
          );
          return {
            run,
            status: "stopped",
            reason: `Manual review required for recommendation ${key} at ${run.currentNode}.`,
            stopReason: "manual_review_required",
            approvalsApplied,
            transitionsApplied,
            iterations
          };
        }

        if (policy.autoApproveNodes.includes(run.currentNode)) {
          this.emit(run, `Auto-approving ${run.currentNode}.`);
          run = await this.orchestrator.approveCurrent(run.id);
          approvalsApplied += 1;
          continue;
        }

        this.emit(run, `Overnight autonomy paused for manual review at ${run.currentNode}.`);
        return {
          run,
          status: "stopped",
          reason: `Manual review required at ${run.currentNode}.`,
          stopReason: "manual_review_required",
          approvalsApplied,
          transitionsApplied,
          iterations
        };
      }

      const response = await this.orchestrator.runCurrentAgentWithOptions(run.id, {
        abortSignal: opts?.abortSignal
      });
      run = response.run;
      iterations += 1;
    }
  }

  // -------------------------------------------------------------------------
  // Autonomous mode — long-running dual-loop research exploration
  // -------------------------------------------------------------------------

  async runAutonomous(
    runId: string,
    policy: AutonomousModePolicy = buildDefaultAutonomousPolicy(),
    opts?: { abortSignal?: AbortSignal }
  ): Promise<AutonomousRunResult> {
    const startedAt = Date.now();
    let activeRunId = runId;
    let approvalsApplied = 0;
    let transitionsApplied = 0;
    let iterations = 0;
    let consecutiveFailures = 0;
    let repeatedRecommendationCount = 0;
    let lastRecommendationKey: string | undefined;
    let researchCycles = 0;
    let lastCompletionCycle = -1;
    let stagnantWindows = 0;
    let lastPaperPressureCycle = 0;
    const noveltySignals: NoveltySignal[] = [];
    let previousHypothesisNode = "";
    let previousAnalysisNote = "";
    let previousDesignNote = "";
    let previousMetricsHash = "";
    let loopDirection: "exploring" | "consolidating" = "exploring";
    let bestBranch: BestBranchInfo | undefined;
    let activePromotionLease: TopicProbeFollowupExecutionLease | undefined;
    let activePromotionTerminalState: RunPromotionExecutionState | undefined;

    const reporter = new AutonomousProgressReporter();

    let run = await this.getRunOrThrow(activeRunId);
    const runtimePolicy = Number.isFinite(policy.maxMinutes)
      ? `${Math.round(policy.maxMinutes / 60)}h`
      : "unbounded";
    const timeStr = Number.isFinite(policy.maxMinutes)
      ? `max ${policy.maxMinutes} min`
      : "no runtime time limit";
    this.emit(
      run,
      `Autonomous mode started. ${timeStr}, ` +
      `max ${policy.fuse.maxTotalIterations} iterations, ` +
      `novelty window=${policy.novelty.windowSize} cycles.`
    );

    await reporter.writeSnapshot(run, {
      mode: "autonomous",
      cycle: researchCycles,
      iteration: iterations,
      currentNode: run.currentNode,
      status: "running",
      noveltySignals: [],
      paperStatus: "not_started",
      stopRisk: "none",
      message: "Autonomous mode started.",
      loopDirection: "exploring",
      runtimePolicy
    });

    const buildStopResult = async (
      status: "completed" | "stopped" | "failed" | "canceled",
      reason: string,
      stopReason: AutonomousStopReason,
      message?: string
    ): Promise<AutonomousRunResult> => {
      run = await this.getRunOrThrow(activeRunId);
      const paperStatus = await this.readPaperStatus(run);
      const gateResult = this.meetsWritePaperBar(bestBranch, policy.writePaperGate);
      const snap: AutonomousCycleSnapshot = {
        mode: "autonomous", cycle: researchCycles, iteration: iterations,
        currentNode: run.currentNode, status,
        noveltySignals, paperStatus,
        stopRisk: stopReason,
        message: message || reason,
        bestBranch: bestBranch?.hypothesis,
        paperCandidateStatus: bestBranch?.manuscriptType,
        evidenceGaps: bestBranch?.evidenceGaps,
        loopDirection,
        runtimePolicy,
        writePaperGateBlocked: !gateResult.passes,
        writePaperGateBlockers: gateResult.blockers,
        minimumGatePassed: bestBranch?.minimumGatePassed,
        minimumGateCeiling: bestBranch?.minimumGateCeiling,
        llmPaperScore: bestBranch?.llmScore,
        llmPaperWorthiness: bestBranch?.llmWorthiness,
        llmRecommendedAction: bestBranch?.llmRecommendedAction
      };
      await reporter.writeFinalSummary(run, snap, stopReason);
      return {
        run, status, reason, stopReason,
        approvalsApplied, transitionsApplied, iterations,
        researchCycles, noveltySignals,
        paperStatus, bestBranch
      };
    };

    while (true) {
      if (opts?.abortSignal?.aborted) {
        this.emit(run, "Autonomous mode: user abort.");
        return buildStopResult("canceled", "User abort.", "user_stop");
      }
      run = await this.getRunOrThrow(activeRunId);

      const pendingAtBoundary = run.graph.pendingTransition;
      const stateAtBoundary = run.graph.nodeStates[run.currentNode];
      if (
        run.status === "paused"
        && stateAtBoundary.status === "needs_approval"
        && pendingAtBoundary?.action === "pause_for_human"
      ) {
        const key = recommendationKey(pendingAtBoundary);
        this.emit(run, `[autonomous] Paused for required human review at ${run.currentNode}: ${key}.`);
        return buildStopResult(
          "stopped",
          `Manual review required: ${key} at ${run.currentNode}.`,
          "manual_review_required"
        );
      }

      if (run.executionRole === "delegated_once") {
        const routeMetadata = describeDelegatedRunRoute(run);
        if (
          activePromotionLease
          && activePromotionLease.childRunId !== run.id
        ) {
          return buildStopResult(
            "stopped",
            `Delegated execution lease/run mismatch (${routeMetadata}).`,
            "followup_handoff_blocked"
          );
        }
        if (
          activePromotionTerminalState
          && activePromotionTerminalState.childRunId !== run.id
        ) {
          return buildStopResult(
            "stopped",
            `Delegated execution terminal/run mismatch (${routeMetadata}).`,
            "followup_handoff_blocked"
          );
        }

        if (!activePromotionLease && !activePromotionTerminalState) {
          const recovered = await this.recoverDelegatedExecution(run);
          if (
            (recovered.status !== "created" && recovered.status !== "reused")
            || recovered.childRun?.id !== run.id
          ) {
            return buildStopResult(
              "stopped",
              `Delegated execution recovery blocked (${routeMetadata}): ${
                recovered.reasons.join(", ") || "reservation unavailable"
              }.`,
              "followup_handoff_blocked"
            );
          }
          activePromotionLease = recovered.executionLease;
          activePromotionTerminalState = recovered.terminalState;
        }

        if (run.delegatedSuccessor?.state === "delegated" && activePromotionLease) {
          try {
            activePromotionTerminalState = await this.markDelegatedExecutionCompleted(
              activePromotionLease,
              "delegated successor reserved"
            );
            activePromotionLease = undefined;
          } catch (error) {
            return buildStopResult(
              "stopped",
              `Delegated execution terminal fencing failed (${routeMetadata}): ${normalizeControllerError(error)}.`,
              "followup_handoff_blocked"
            );
          }
        }

        if (run.status === "completed") {
          if (activePromotionLease) {
            try {
              activePromotionTerminalState = await this.markDelegatedExecutionCompleted(
                activePromotionLease,
                "delegated run completed"
              );
              activePromotionLease = undefined;
            } catch (error) {
              return buildStopResult(
                "stopped",
                `Delegated execution terminal fencing failed (${routeMetadata}): ${normalizeControllerError(error)}.`,
                "followup_handoff_blocked"
              );
            }
          }
          if (activePromotionTerminalState?.status !== "completed") {
            return buildStopResult(
              "stopped",
              `Delegated execution terminal state is unavailable (${routeMetadata}).`,
              "followup_handoff_blocked"
            );
          }
          this.emit(run, `[autonomous] Delegated run completed (${routeMetadata}); one-shot stop applied.`);
          return buildStopResult(
            "completed",
            `Delegated one-shot run completed (${routeMetadata}).`,
            "run_completed",
            `Delegated one-shot run completed without autonomous re-cycling (${routeMetadata}).`
          );
        }

        if (run.delegatedSuccessor?.state === "delegated") {
          if (activePromotionTerminalState?.status !== "completed") {
            return buildStopResult(
              "stopped",
              `Delegated successor recovery requires a completed inbound lease (${routeMetadata}).`,
              "followup_handoff_blocked"
            );
          }
        } else {
          if (!activePromotionLease) {
            return buildStopResult(
              "stopped",
              `Delegated execution claim is unavailable (${routeMetadata}).`,
              "followup_handoff_blocked"
            );
          }
          if (!this.topicProbeFollowupRuns.heartbeatExecution) {
            return buildStopResult(
              "stopped",
              `Delegated execution heartbeat support is unavailable (${routeMetadata}).`,
              "followup_handoff_blocked"
            );
          }
          try {
            activePromotionLease = await this.topicProbeFollowupRuns.heartbeatExecution(
              activePromotionLease
            );
            activePromotionTerminalState = undefined;
          } catch (error) {
            return buildStopResult(
              "stopped",
              `Delegated execution lease lost (${routeMetadata}): ${normalizeControllerError(error)}.`,
              "followup_handoff_blocked"
            );
          }
        }
      }

      // --- Emergency fuse: total iterations ---
      if (iterations >= policy.fuse.maxTotalIterations) {
        this.emit(run, `Autonomous mode emergency stop: ${iterations} iterations reached.`);
        return buildStopResult("stopped", "Catastrophic fuse: max iterations.", "catastrophic_fuse",
          `Emergency stop: ${iterations} total iterations reached.`);
      }

      // --- Time limit (skipped when unbounded) ---
      if (Number.isFinite(policy.maxMinutes) && Date.now() - startedAt > policy.maxMinutes * 60 * 1000) {
        this.emit(run, "Autonomous mode stopped: time limit reached.");
        return buildStopResult("stopped", "Time limit reached.", "time_limit");
      }

      // --- Emergency fuse: consecutive failures ---
      if (consecutiveFailures >= policy.fuse.maxConsecutiveFailures) {
        this.emit(run, `Autonomous mode emergency stop: ${consecutiveFailures} consecutive failures.`);
        return buildStopResult("stopped", "Catastrophic fuse: consecutive failures.", "consecutive_failures");
      }

      // --- Write-paper gate (top-of-loop): catches runtime auto-advancing past review ---
      if (run.currentNode === "write_paper" && run.status === "running") {
        const currentBranch = await this.evaluateCurrentBranch(run, researchCycles, bestBranch);
        bestBranch = this.selectStrongerBranch(bestBranch, currentBranch);
        const gate = this.meetsWritePaperBar(currentBranch, policy.writePaperGate);
        if (!gate.passes) {
          this.emit(run, `[autonomous] Write-paper gate (pre-execution): blocked. ${gate.blockers.join(", ")}`);
          await reporter.writeSnapshot(run, {
            mode: "autonomous", cycle: researchCycles, iteration: iterations,
            currentNode: run.currentNode, status: "running",
            noveltySignals: noveltySignals.slice(-10),
            paperStatus: await this.readPaperStatus(run),
            stopRisk: "write_paper_gate_blocked",
            message: `Write-paper gate blocked (pre-execution): ${gate.blockers.join(", ")}`,
            bestBranch: currentBranch.hypothesis,
            paperCandidateStatus: currentBranch.manuscriptType,
            evidenceGaps: currentBranch.evidenceGaps,
            writePaperGateBlocked: true,
            writePaperGateBlockers: gate.blockers,
            loopDirection: "consolidating",
            runtimePolicy,
            ...this.bestBranchQualityFields(currentBranch)
          });
          try {
            await this.orchestrator.jumpToNode(run.id, "design_experiments", "safe",
              `Write-paper evidence bar not met (pre-execution): ${gate.blockers.join(", ")}`);
            this.emit(run, "[autonomous] Backtracked to design_experiments to strengthen evidence.");
          } catch {
            return buildStopResult("stopped", `Write-paper gate blocked: ${gate.blockers.join(", ")}`, "write_paper_gate");
          }
          continue;
        }
      }

      // --- Run completed: in autonomous mode, this triggers re-cycle ---
      if (run.status === "completed") {
        researchCycles += 1;
        this.emit(run, `Autonomous mode: run completed (cycle ${researchCycles}). Evaluating continuation.`);

        // Detect novelty from this completed cycle
        const cycleNovelty = await this.detectCycleNovelty(run, researchCycles, previousHypothesisNode, previousAnalysisNote, previousDesignNote, previousMetricsHash);
        noveltySignals.push(...cycleNovelty);
        previousHypothesisNode = run.graph.nodeStates.generate_hypotheses?.note || "";
        previousAnalysisNote = run.graph.nodeStates.analyze_results?.note || "";
        previousDesignNote = run.graph.nodeStates.design_experiments?.note || "";
        previousMetricsHash = await this.readMetricsHash(run);

        // Update best-branch tracking
        const currentBranch = await this.evaluateCurrentBranch(run, researchCycles, bestBranch);
        bestBranch = this.selectStrongerBranch(bestBranch, currentBranch);

        // Check stagnation
        const windowSignals = noveltySignals.filter(
          (s) => s.cycle > researchCycles - policy.novelty.windowSize
        );
        if (windowSignals.length < policy.novelty.minNovelSignalsPerWindow) {
          stagnantWindows += 1;
          this.emit(run, `Stagnation detected: ${stagnantWindows}/${policy.novelty.maxStagnantWindows} windows.`);
        } else {
          stagnantWindows = 0;
        }

        if (stagnantWindows >= policy.novelty.maxStagnantWindows) {
          this.emit(run, "Autonomous mode stopped: sustained stagnation.");
          return buildStopResult("stopped", "Sustained stagnation: no novelty.", "stagnation",
            `Stopped after ${policy.novelty.maxStagnantWindows} stagnant windows with no meaningful novelty.`);
        }

        // Determine loop direction: explore vs consolidate
        const shouldConsolidate = this.shouldConsolidate(currentBranch, researchCycles, lastPaperPressureCycle, policy);
        loopDirection = shouldConsolidate ? "consolidating" : "exploring";

        // Periodically re-enter the node that owns the current cycle's gap.
        if (shouldConsolidate) {
          lastPaperPressureCycle = researchCycles;
          loopDirection = "consolidating";
          this.emit(run, `Paper pressure: consolidating best branch at cycle ${researchCycles}.`);

          const upgradeAction = this.determineUpgradeAction(currentBranch);
          currentBranch.upgradeActions.push(upgradeAction);
          const currentGate = this.meetsWritePaperBar(currentBranch, policy.writePaperGate);
          const upgradeTarget: GraphNodeId = currentGate.passes ? "review" : "design_experiments";

          // Record paper quality upgrade as novelty
          noveltySignals.push({
            cycle: researchCycles,
            type: "paper_quality_upgrade",
            detail: upgradeAction
          });

          await reporter.writeSnapshot(run, {
            mode: "autonomous", cycle: researchCycles, iteration: iterations,
            currentNode: run.currentNode, status: "running",
            noveltySignals: noveltySignals.slice(-10),
            paperStatus: await this.readPaperStatus(run),
            stopRisk: stagnantWindows > 0 ? "stagnation_risk" : "none",
            message: `Cycle ${researchCycles}: consolidating best branch for paper quality.`,
            bestBranch: currentBranch.hypothesis,
            latestUpgradeAction: upgradeAction,
            paperCandidateStatus: currentBranch.manuscriptType,
            evidenceGaps: currentBranch.evidenceGaps,
            nextUpgradeAction: upgradeAction,
            loopDirection: "consolidating",
            whyContinued: `Best branch has upgrade potential: ${upgradeAction}`,
            writePaperGateBlocked: !currentGate.passes,
            writePaperGateBlockers: currentGate.blockers,
            ...this.bestBranchQualityFields(currentBranch)
          });

          // Re-enter the node that owns the missing evidence. Review is only
          // eligible once the current cycle itself clears the write-paper bar.
          try {
            await this.orchestrator.jumpToNode(
              run.id,
              upgradeTarget,
              "safe",
              `Evidence-owned consolidation at cycle ${researchCycles}: ${upgradeAction}`
            );
            this.emit(run, `Re-entered ${upgradeTarget} for evidence-owned consolidation (cycle ${researchCycles}).`);
            currentBranch.lastUpgradeCycle = researchCycles;
            bestBranch.lastUpgradeCycle = researchCycles;
          } catch {
            this.emit(run, `Evidence-owned consolidation: failed to jump to ${upgradeTarget}. Continuing exploration.`);
          }
          continue;
        }

        // Standard exploration: report and re-cycle
        const whyContinued = this.buildContinuationReason(windowSignals, bestBranch, stagnantWindows);
        await reporter.writeSnapshot(run, {
          mode: "autonomous", cycle: researchCycles, iteration: iterations,
          currentNode: run.currentNode, status: "running",
          noveltySignals: noveltySignals.slice(-10),
          paperStatus: await this.readPaperStatus(run),
          stopRisk: stagnantWindows > 0 ? "stagnation_risk" : "none",
          message: `Cycle ${researchCycles} completed. Continuing exploration.`,
          bestBranch: bestBranch?.hypothesis,
          paperCandidateStatus: bestBranch?.manuscriptType,
          evidenceGaps: bestBranch?.evidenceGaps,
          loopDirection: "exploring",
          whyContinued,
          hypothesis: run.graph.nodeStates.generate_hypotheses?.note?.slice(0, 100),
          ...this.bestBranchQualityFields(bestBranch)
        });

        // Re-cycle: backtrack to generate_hypotheses for next research cycle
        lastCompletionCycle = researchCycles;
        consecutiveFailures = 0;

        try {
          await this.orchestrator.jumpToNode(run.id, "generate_hypotheses", "safe", `Re-cycle for exploration cycle ${researchCycles + 1}`);
          this.emit(run, `Re-cycling to generate_hypotheses for cycle ${researchCycles + 1}.`);
        } catch {
          this.emit(run, "Autonomous mode: failed to re-cycle. Stopping.");
          return buildStopResult("stopped", "Failed to re-cycle.", "catastrophic_fuse");
        }
        continue;
      }

      // --- Run failed ---
      if (run.status === "failed") {
        consecutiveFailures += 1;
        this.emit(run, `Autonomous mode: run failed (failure ${consecutiveFailures}).`);
        if (consecutiveFailures >= policy.fuse.maxConsecutiveFailures) {
          return buildStopResult("failed", "Too many consecutive failures.", "consecutive_failures");
        }
        // Attempt recovery by retrying current node
        try {
          await this.orchestrator.retryCurrent(run.id);
          this.emit(run, "Autonomous mode: retrying after failure.");
        } catch {
          return buildStopResult("failed",
            `Run failed: ${run.graph.nodeStates[run.currentNode]?.lastError || "unknown"}.`,
            "run_failed");
        }
        continue;
      }

      // --- Needs approval ---
      const state = run.graph.nodeStates[run.currentNode];
      if (run.status === "paused" && state.status === "needs_approval") {
        const recommendation = run.graph.pendingTransition;
        if (recommendation) {
          const key = recommendationKey(recommendation);
          if (recommendation.action === "pause_for_human") {
            this.emit(run, `[autonomous] Paused for required human review at ${run.currentNode}: ${key}.`);
            return buildStopResult(
              "stopped",
              `Manual review required: ${key} at ${run.currentNode}.`,
              "manual_review_required"
            );
          }

          if (recommendation.action === "delegate_successor") {
            if (!this.isAuthorizedSuccessorDelegation(run, recommendation)) {
              this.emit(
                run,
                `[autonomous] Delegated successor request requires human review: ${key}.`
              );
              return buildStopResult(
                "stopped",
                `Manual review required for invalid delegated successor request: ${key} at ${run.currentNode}.`,
                "manual_review_required"
              );
            }

            if (run.executionRole === "delegated_once") {
              if (activePromotionLease) {
                try {
                  activePromotionTerminalState = await this.markDelegatedExecutionCompleted(
                    activePromotionLease,
                    "delegated child requested a successor"
                  );
                  activePromotionLease = undefined;
                } catch (error) {
                  return buildStopResult(
                    "stopped",
                    `Delegated execution terminal fencing failed (${describeDelegatedRunRoute(run)}): ${normalizeControllerError(error)}.`,
                    "followup_handoff_blocked"
                  );
                }
              } else if (activePromotionTerminalState?.status !== "completed") {
                return buildStopResult(
                  "stopped",
                  `Delegated successor handoff requires a completed inbound lease (${describeDelegatedRunRoute(run)}).`,
                  "followup_handoff_blocked"
                );
              }
            }

            const followup = await this.topicProbeFollowupRuns.consumePromotedFollowup(run);
            if (
              (followup.status === "created" || followup.status === "reused")
              && followup.childRun
            ) {
              if (
                followup.childRun.executionRole !== "delegated_once"
                || !followup.childRun.promotionLineage
              ) {
                return buildStopResult(
                  "stopped",
                  "Delegated successor manager returned a non-delegated child.",
                  "followup_handoff_blocked"
                );
              }
              const routeMetadata = describeFollowupRoute(followup, followup.childRun);
              this.emit(
                run,
                `[autonomous] Delegated successor ${followup.status}: ${followup.childRun.id} (${routeMetadata}).`
              );
              activeRunId = followup.childRun.id;
              run = followup.childRun;
              activePromotionLease = followup.executionLease;
              activePromotionTerminalState = followup.terminalState;
              bestBranch = undefined;
              previousHypothesisNode = "";
              previousAnalysisNote = "";
              previousDesignNote = "";
              previousMetricsHash = "";
              stagnantWindows = 0;
              repeatedRecommendationCount = 0;
              lastRecommendationKey = undefined;
              consecutiveFailures = 0;
              loopDirection = "exploring";
              noveltySignals.push({
                cycle: researchCycles,
                type: "new_experiment_artifact",
                detail: `Activated a delegated successor (${routeMetadata}).`
              });
              await reporter.writeSnapshot(run, {
                mode: "autonomous",
                cycle: researchCycles,
                iteration: iterations,
                currentNode: run.currentNode,
                status: "running",
                noveltySignals: noveltySignals.slice(-10),
                paperStatus: await this.readPaperStatus(run),
                stopRisk: "none",
                message: `Switched active run to delegated successor (${routeMetadata}).`,
                loopDirection,
                runtimePolicy
              });
              continue;
            }

            const reasons = followup.reasons.join(", ") || followup.status;
            this.emit(run, `[autonomous] Delegated successor handoff blocked: ${reasons}.`);
            return buildStopResult(
              "stopped",
              `Delegated successor handoff blocked: ${reasons}.`,
              "followup_handoff_blocked"
            );
          }


          repeatedRecommendationCount = key === lastRecommendationKey ? repeatedRecommendationCount + 1 : 1;
          lastRecommendationKey = key;

          if (repeatedRecommendationCount > policy.fuse.maxRepeatedRecommendation) {
            this.emit(run, `Autonomous mode: emergency stop after ${repeatedRecommendationCount} repeated recommendations: ${key}.`);
            return buildStopResult("stopped", `Catastrophic fuse: repeated recommendation ${key}.`, "catastrophic_fuse");
          }

          if (this.canApplyRecommendation(run, recommendation, policy)) {
            // Write-paper gate: block advancing from review unless evidence bar is met
            if (run.currentNode === "review" && recommendation.action === "advance") {
              const currentBranch = await this.evaluateCurrentBranch(run, researchCycles, bestBranch);
              bestBranch = this.selectStrongerBranch(bestBranch, currentBranch);
              const gate = this.meetsWritePaperBar(currentBranch, policy.writePaperGate);
              if (!gate.passes) {
                this.emit(run, `[autonomous] Review→write_paper blocked: ${gate.blockers.join(", ")}. Backtracking.`);
                await reporter.writeSnapshot(run, {
                  mode: "autonomous", cycle: researchCycles, iteration: iterations,
                  currentNode: run.currentNode, status: "running",
                  noveltySignals: noveltySignals.slice(-10),
                  paperStatus: await this.readPaperStatus(run),
                  stopRisk: "write_paper_gate_blocked",
                  message: `Write-paper gate blocked: ${gate.blockers.join(", ")}`,
                  bestBranch: currentBranch.hypothesis,
                  paperCandidateStatus: currentBranch.manuscriptType,
                  evidenceGaps: currentBranch.evidenceGaps,
                  writePaperGateBlocked: true,
                  writePaperGateBlockers: gate.blockers,
                  loopDirection: "consolidating",
                  ...this.bestBranchQualityFields(currentBranch)
                });
                try {
                  await this.orchestrator.jumpToNode(run.id, "design_experiments", "safe",
                    `Write-paper evidence bar not met: ${gate.blockers.join(", ")}`);
                  this.emit(run, "[autonomous] Backtracked to design_experiments to strengthen evidence.");
                } catch {
                  return buildStopResult("stopped", `Write-paper gate blocked: ${gate.blockers.join(", ")}`, "write_paper_gate");
                }
                continue;
              }
            }

            this.emit(
              run,
              `[autonomous] Applying ${recommendation.action} -> ${recommendation.targetNode || "stay"}.`
            );

            // Track novelty from backtracks
            if (recommendation.targetNode && GRAPH_NODE_ORDER.indexOf(recommendation.targetNode) < GRAPH_NODE_ORDER.indexOf(run.currentNode)) {
              noveltySignals.push({
                cycle: researchCycles,
                type: "new_backtrack_target",
                detail: `Backtrack from ${run.currentNode} to ${recommendation.targetNode}: ${recommendation.reason.slice(0, 80)}`
              });
            }

            run = await this.orchestrator.applyPendingTransition(run.id);
            transitionsApplied += 1;
            continue;
          }

          this.emit(
            run,
            `[autonomous] Paused: recommendation ${key} is not explicitly auto-executable under the active policy.`
          );
          return buildStopResult("stopped", `Manual review required: ${key} at ${run.currentNode}.`, "manual_review_required");
        }

        // No recommendation, but needs approval — gate check for review and write_paper
        if (run.currentNode === "review" || run.currentNode === "write_paper") {
          const currentBranch = await this.evaluateCurrentBranch(run, researchCycles, bestBranch);
          bestBranch = this.selectStrongerBranch(bestBranch, currentBranch);
          const gate = this.meetsWritePaperBar(currentBranch, policy.writePaperGate);
          if (run.currentNode === "review" && !gate.passes) {
            // Review completed but evidence insufficient for write_paper — backtrack
            this.emit(run, `[autonomous] Review gate: write_paper blocked. ${gate.blockers.join(", ")}. Backtracking.`);
            await reporter.writeSnapshot(run, {
              mode: "autonomous", cycle: researchCycles, iteration: iterations,
              currentNode: run.currentNode, status: "running",
              noveltySignals: noveltySignals.slice(-10),
              paperStatus: await this.readPaperStatus(run),
              stopRisk: "write_paper_gate_blocked",
              message: `Review gate: write_paper blocked. ${gate.blockers.join(", ")}`,
              bestBranch: currentBranch.hypothesis,
              paperCandidateStatus: currentBranch.manuscriptType,
              evidenceGaps: currentBranch.evidenceGaps,
              writePaperGateBlocked: true,
              writePaperGateBlockers: gate.blockers,
              loopDirection: "consolidating",
              ...this.bestBranchQualityFields(currentBranch)
            });
            try {
              await this.orchestrator.jumpToNode(run.id, "design_experiments", "safe",
                `Write-paper evidence bar not met at review: ${gate.blockers.join(", ")}`);
              this.emit(run, "[autonomous] Backtracked to design_experiments to strengthen evidence.");
            } catch {
              return buildStopResult("stopped", `Write-paper gate blocked at review: ${gate.blockers.join(", ")}`, "write_paper_gate");
            }
            continue;
          }
          if (run.currentNode === "review" && gate.passes) {
            this.emit(run, "[autonomous] Review gate passed — evidence sufficient for write_paper. Approving review.");
            run = await this.orchestrator.approveCurrent(run.id);
            approvalsApplied += 1;
            continue;
          }
          if (run.currentNode === "write_paper" && gate.passes) {
            this.emit(run, "[autonomous] Write-paper evidence bar met. Approving write_paper.");
            run = await this.orchestrator.approveCurrent(run.id);
            approvalsApplied += 1;
            continue;
          }
          if (run.currentNode === "write_paper" && !gate.passes) {
            this.emit(run, `[autonomous] Write-paper evidence bar not met: ${gate.blockers.join(", ")}. Backtracking.`);
            try {
              await this.orchestrator.jumpToNode(run.id, "design_experiments", "safe",
                `Write-paper evidence bar not met: ${gate.blockers.join(", ")}`);
            } catch {
              return buildStopResult("stopped", `Write-paper gate blocked: ${gate.blockers.join(", ")}`, "write_paper_gate");
            }
            continue;
          }
        }

        if (policy.autoApproveNodes.includes(run.currentNode)) {
          this.emit(run, `[autonomous] Auto-approving ${run.currentNode}.`);
          run = await this.orchestrator.approveCurrent(run.id);
          approvalsApplied += 1;
          continue;
        }

        this.emit(run, `[autonomous] Paused for manual review at ${run.currentNode}.`);
        return buildStopResult("stopped", `Manual review required at ${run.currentNode}.`, "manual_review_required");
      }

      // --- Execute current node ---
      try {
        const response = await this.runWithPromotionHeartbeat(
          activePromotionLease,
          opts?.abortSignal,
          (abortSignal) => this.orchestrator.runCurrentAgentWithOptions(run.id, {
            abortSignal,
            stopAfterApprovalBoundary: true
          })
        );
        run = response.run;
        iterations += 1;

        if (run.status === "failed") {
          consecutiveFailures += 1;
        } else {
          consecutiveFailures = 0;
        }

        // Periodic progress report
        if (iterations % 5 === 0) {
          await reporter.writeSnapshot(run, {
            mode: "autonomous", cycle: researchCycles, iteration: iterations,
            currentNode: run.currentNode, status: "running",
            noveltySignals: noveltySignals.slice(-10),
            paperStatus: await this.readPaperStatus(run),
            stopRisk: stagnantWindows > 0 ? "stagnation_risk" : "none",
            message: `Iteration ${iterations}, cycle ${researchCycles}, node ${run.currentNode}.`,
            bestBranch: bestBranch?.hypothesis,
            paperCandidateStatus: bestBranch?.manuscriptType,
            evidenceGaps: bestBranch?.evidenceGaps,
            loopDirection,
            hypothesis: run.graph.nodeStates.generate_hypotheses?.note?.slice(0, 100),
            experimentTarget: run.graph.nodeStates.design_experiments?.note?.slice(0, 100),
            ...this.bestBranchQualityFields(bestBranch)
          });
        }
      } catch (err) {
        iterations += 1;
        consecutiveFailures += 1;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Operation aborted")) {
          this.emit(run, "Autonomous mode: user abort.");
          return buildStopResult("canceled", "User abort.", "user_stop");
        }
        this.emit(run, `[autonomous] Node execution error (failure ${consecutiveFailures}): ${msg.slice(0, 120)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Best-branch evaluation
  // -------------------------------------------------------------------------

  /** Extract two-layer quality fields from a BestBranchInfo for snapshot inclusion */
  private bestBranchQualityFields(b: BestBranchInfo | undefined): Pick<
    AutonomousCycleSnapshot,
    "minimumGatePassed" | "minimumGateCeiling" | "llmPaperScore" | "llmPaperWorthiness" | "llmRecommendedAction"
  > {
    return {
      minimumGatePassed: b?.minimumGatePassed,
      minimumGateCeiling: b?.minimumGateCeiling,
      llmPaperScore: b?.llmScore,
      llmPaperWorthiness: b?.llmWorthiness,
      llmRecommendedAction: b?.llmRecommendedAction
    };
  }

  async evaluateBestBranch(
    run: RunRecord,
    current: BestBranchInfo | undefined,
    cycle: number
  ): Promise<BestBranchInfo> {
    const candidate = await this.evaluateCurrentBranch(run, cycle, current);
    return this.selectStrongerBranch(current, candidate);
  }

  async evaluateCurrentBranch(
    run: RunRecord,
    cycle: number,
    prior?: BestBranchInfo
  ): Promise<BestBranchInfo> {
    const runDir = path.join(".autolabos", "runs", run.id);

    const hypothesis = run.graph.nodeStates.generate_hypotheses?.note || run.topic;

    // Read key artifacts to assess evidence quality (including two-layer evaluation)
    const [metricsRaw, baselineRaw, resultTableRaw, analysisRaw, critiqueRaw, gateRaw, llmEvalRaw] = await Promise.all([
      safeRead(path.join(runDir, "metrics.json")),
      safeRead(path.join(runDir, "baseline_summary.json")),
      safeRead(path.join(runDir, "result_table.json")),
      safeRead(path.join(runDir, "result_analysis.json")),
      safeRead(path.join(runDir, "review", "paper_critique.json")),
      safeRead(path.join(runDir, "review", "minimum_gate.json")),
      safeRead(path.join(runDir, "review", "paper_quality_evaluation.json"))
    ]);

    const hasBaseline = baselineRaw.trim().length > 10;
    const hasQuantitativeResults = metricsRaw.trim().length > 10;
    const hasResultTable = resultTableRaw.trim().length > 10;

    let manuscriptType = "not_analyzed";
    let hasComparator = hasBaseline;
    try {
      if (critiqueRaw.trim()) {
        const critique = JSON.parse(critiqueRaw);
        manuscriptType = critique.manuscript_type || manuscriptType;
      } else if (analysisRaw.trim()) {
        const analysis = JSON.parse(analysisRaw);
        manuscriptType = analysis.manuscript_type || analysis.paper_status || manuscriptType;
        if (analysis.compared_systems && analysis.compared_systems.length > 1) {
          hasComparator = true;
        }
      }
    } catch { /* ignore parse errors */ }

    // Read Layer 1: Minimum gate result
    let minimumGatePassed: boolean | undefined;
    let minimumGateCeiling: string | undefined;
    try {
      if (gateRaw.trim()) {
        const gate = JSON.parse(gateRaw);
        minimumGatePassed = gate.passed;
        minimumGateCeiling = gate.ceiling_type;
      }
    } catch { /* ignore */ }

    // Read Layer 2: LLM paper-quality evaluation
    let llmScore: number | undefined;
    let llmWorthiness: string | undefined;
    let llmRecommendedAction: string | undefined;
    let llmEvidenceGaps: string[] | undefined;
    let llmUpgradeActions: string[] | undefined;
    try {
      if (llmEvalRaw.trim()) {
        const llmEval = JSON.parse(llmEvalRaw);
        llmScore = llmEval.overall_score_1_to_10;
        llmWorthiness = llmEval.paper_worthiness;
        llmRecommendedAction = llmEval.recommended_action;
        llmEvidenceGaps = llmEval.evidence_gaps;
        llmUpgradeActions = llmEval.upgrade_priorities;
      }
    } catch { /* ignore */ }

    // Determine evidence gaps: prefer LLM gaps, augment with structural checks
    const evidenceGaps: string[] = llmEvidenceGaps && llmEvidenceGaps.length > 0
      ? [...llmEvidenceGaps]
      : [];
    if (!hasBaseline && !evidenceGaps.some(g => g.toLowerCase().includes("baseline"))) {
      evidenceGaps.push("Missing explicit baseline or comparator");
    }
    if (!hasQuantitativeResults && !evidenceGaps.some(g => g.toLowerCase().includes("quantitative"))) {
      evidenceGaps.push("No quantitative results (metrics.json)");
    }
    if (!hasResultTable && !evidenceGaps.some(g => g.toLowerCase().includes("result table"))) {
      evidenceGaps.push("No result table artifact");
    }
    if (!hasComparator && !evidenceGaps.some(g => g.toLowerCase().includes("comparator"))) {
      evidenceGaps.push("No comparator identified");
    }
    if (manuscriptType === "not_analyzed" || manuscriptType === "system_validation_note") {
      evidenceGaps.push("Manuscript not at paper-scale level");
    }

    const upgradeActions = llmUpgradeActions && llmUpgradeActions.length > 0
      ? [...llmUpgradeActions]
      : [...(prior?.upgradeActions || [])];

    const branch: BestBranchInfo = {
      branchId: `cycle-${cycle}`,
      hypothesis: hypothesis.slice(0, 120),
      hasBaseline,
      hasComparator,
      hasQuantitativeResults,
      hasResultTable,
      manuscriptType,
      lastUpgradeCycle: prior?.lastUpgradeCycle || 0,
      evidenceGaps,
      upgradeActions,
      llmScore,
      llmWorthiness,
      llmRecommendedAction,
      minimumGatePassed,
      minimumGateCeiling
    };
    return branch;
  }

  private selectStrongerBranch(
    current: BestBranchInfo | undefined,
    candidate: BestBranchInfo
  ): BestBranchInfo {
    if (!current) {
      return candidate;
    }
    const currentScore = current.llmScore ?? this.branchScore(current);
    const candidateScore = candidate.llmScore ?? this.branchScore(candidate);
    return currentScore > candidateScore ? current : candidate;
  }

  /** Simple numeric score for comparing branch quality */
  private branchScore(b: BestBranchInfo): number {
    let score = 0;
    if (b.hasBaseline) score += 2;
    if (b.hasComparator) score += 2;
    if (b.hasQuantitativeResults) score += 3;
    if (b.hasResultTable) score += 2;
    const typeScores: Record<string, number> = {
      paper_ready: 10,
      paper_scale_candidate: 7,
      research_memo: 3,
      system_validation_note: 1,
      not_analyzed: 0,
      blocked_for_paper_scale: 2
    };
    score += typeScores[b.manuscriptType] || 0;
    return score;
  }

  /**
   * Check if the current best branch meets the minimum evidence bar for
   * entering write_paper. This is the structural gate that prevents the
   * system from drafting a paper before sufficient evidence exists.
   */
  meetsWritePaperBar(
    bestBranch: BestBranchInfo | undefined,
    gate: WritePaperGateConfig
  ): { passes: boolean; blockers: string[] } {
    const blockers: string[] = [];

    if (!bestBranch) {
      return { passes: false, blockers: ["No evaluated branch available"] };
    }

    // Layer 1: If minimum gate result is available and blocked, use it directly
    if (bestBranch.minimumGatePassed === false) {
      blockers.push(`Minimum evidence gate blocked (${bestBranch.minimumGateCeiling || "unknown ceiling"})`);
    }

    // Layer 2: If LLM evaluation recommends against drafting, add as blocker
    if (bestBranch.llmWorthiness === "not_ready") {
      blockers.push(`LLM evaluation: not ready for drafting (score: ${bestBranch.llmScore ?? "?"}/10)`);
    }

    // Structural checks (still enforced even without Layer 1/2 artifacts)
    if (gate.requireBaselineOrComparator && !bestBranch.hasBaseline && !bestBranch.hasComparator) {
      blockers.push("Missing baseline or comparator");
    }
    if (gate.requireQuantitativeResults && !bestBranch.hasQuantitativeResults) {
      blockers.push("No quantitative results");
    }
    if (gate.blockedManuscriptTypes.includes(bestBranch.manuscriptType)) {
      blockers.push(`Manuscript type '${bestBranch.manuscriptType}' is below draft threshold`);
    }
    if (this.branchScore(bestBranch) < gate.minBranchScore) {
      blockers.push(`Branch score ${this.branchScore(bestBranch)} < required ${gate.minBranchScore}`);
    }

    return { passes: blockers.length === 0, blockers };
  }

  // -------------------------------------------------------------------------
  // Paper pressure decision
  // -------------------------------------------------------------------------

  private shouldConsolidate(
    bestBranch: BestBranchInfo | undefined,
    currentCycle: number,
    lastPaperPressureCycle: number,
    policy: AutonomousModePolicy
  ): boolean {
    if (!bestBranch) return false;

    // Regular interval check
    const cyclesSinceLastPressure = currentCycle - lastPaperPressureCycle;
    if (cyclesSinceLastPressure >= policy.paperPressure.checkIntervalCycles) {
      // Only consolidate if there's something worth consolidating
      if (bestBranch.hasQuantitativeResults || bestBranch.hasBaseline) {
        return true;
      }
    }

    // Force upgrade if best branch has not been upgraded in too long
    const cyclesSinceUpgrade = currentCycle - bestBranch.lastUpgradeCycle;
    if (cyclesSinceUpgrade >= policy.paperPressure.forceUpgradeAfterCycles) {
      if (bestBranch.hasQuantitativeResults) {
        return true;
      }
    }

    return false;
  }

  private determineUpgradeAction(bestBranch: BestBranchInfo): string {
    if (!bestBranch.hasBaseline && !bestBranch.hasComparator) {
      return "Add baseline or comparator to strengthen evidence";
    }
    if (!bestBranch.hasResultTable) {
      return "Generate structured result table with quantitative comparison";
    }
    if (!bestBranch.hasQuantitativeResults) {
      return "Execute experiment to produce quantitative metrics";
    }
    if (bestBranch.manuscriptType === "system_validation_note" || bestBranch.manuscriptType === "research_memo") {
      return "Upgrade manuscript from memo/note toward paper-scale candidate";
    }
    if (bestBranch.manuscriptType === "paper_scale_candidate") {
      return "Strengthen claim-evidence linkage and review readiness";
    }
    return "Revise manuscript structure and improve analysis quality";
  }

  private buildContinuationReason(
    windowSignals: NoveltySignal[],
    bestBranch: BestBranchInfo | undefined,
    stagnantWindows: number
  ): string {
    const parts: string[] = [];
    if (windowSignals.length > 0) {
      const types = [...new Set(windowSignals.map(s => s.type))];
      parts.push(`${windowSignals.length} novelty signals (${types.join(", ")})`);
    }
    if (bestBranch) {
      parts.push(`best branch: ${bestBranch.manuscriptType}`);
      if (bestBranch.evidenceGaps.length > 0) {
        parts.push(`${bestBranch.evidenceGaps.length} evidence gaps remain`);
      }
    }
    if (stagnantWindows > 0) {
      parts.push(`stagnation risk: ${stagnantWindows} windows`);
    }
    return parts.length > 0 ? parts.join("; ") : "Continuing exploration.";
  }

  // -------------------------------------------------------------------------
  // Novelty detection (enhanced)
  // -------------------------------------------------------------------------

  async detectCycleNovelty(
    run: RunRecord,
    cycle: number,
    previousHypothesisNote: string,
    previousAnalysisNote: string,
    previousDesignNote: string,
    previousMetricsHash: string
  ): Promise<NoveltySignal[]> {
    const signals: NoveltySignal[] = [];

    const hypothesisNote = run.graph.nodeStates.generate_hypotheses?.note || "";
    if (hypothesisNote && hypothesisNote !== previousHypothesisNote) {
      signals.push({ cycle, type: "new_hypothesis", detail: hypothesisNote.slice(0, 100) });
    }

    const analysisNote = run.graph.nodeStates.analyze_results?.note || "";
    if (analysisNote && analysisNote !== previousAnalysisNote) {
      signals.push({ cycle, type: "different_analysis_outcome", detail: analysisNote.slice(0, 100) });
    }

    const designNote = run.graph.nodeStates.design_experiments?.note || "";
    if (designNote && designNote !== previousDesignNote) {
      // Check for new comparators or ablations
      const lower = designNote.toLowerCase();
      if (lower.includes("comparator") || lower.includes("ablation") || lower.includes("baseline")) {
        signals.push({ cycle, type: "new_comparator", detail: designNote.slice(0, 100) });
      }
    }

    // Check for new experiment artifacts via metrics hash change
    const currentMetricsHash = await this.readMetricsHash(run);
    if (currentMetricsHash && currentMetricsHash !== previousMetricsHash) {
      signals.push({ cycle, type: "new_experiment_artifact", detail: "New metrics.json content detected" });
    }

    // Check transition history for backtracks
    const history = run.graph.transitionHistory || [];
    const recentBt = history.filter((h) => h.toNode === "generate_hypotheses" || h.toNode === "design_experiments");
    if (recentBt.length > 0) {
      signals.push({
        cycle, type: "new_backtrack_target",
        detail: `${recentBt.length} backtracks in transition history`
      });
    }

    return signals;
  }

  // -------------------------------------------------------------------------
  // Artifact readers
  // -------------------------------------------------------------------------

  private async readPaperStatus(run: RunRecord): Promise<string> {
    try {
      const raw = await safeRead(path.join(".autolabos", "runs", run.id, "result_analysis.json"));
      if (raw.trim()) {
        const data = JSON.parse(raw);
        return data.manuscript_type || data.paper_status || "unknown";
      }
    } catch { /* ignore */ }
    return "not_analyzed";
  }

  async readMetricsHash(run: RunRecord): Promise<string> {
    try {
      const raw = await safeRead(path.join(".autolabos", "runs", run.id, "metrics.json"));
      if (raw.trim()) {
        // Simple hash: length + first 50 chars
        return `${raw.length}:${raw.trim().slice(0, 50)}`;
      }
    } catch { /* ignore */ }
    return "";
  }

  private isAuthorizedSuccessorDelegation(
    run: RunRecord,
    recommendation: TransitionRecommendation
  ): boolean {
    return run.currentNode === "review"
      && run.graph.currentNode === "review"
      && recommendation.sourceNode === "review"
      && recommendation.autoExecutable === true
      && recommendation.targetNode === undefined;
  }

  private async recoverDelegatedExecution(
    run: RunRecord
  ): Promise<TopicProbeFollowupRunResult> {
    const parentRunId = run.promotionLineage?.parentRunId;
    if (!parentRunId) {
      return {
        status: "blocked",
        reasons: ["delegated_execution_lineage_missing"]
      };
    }
    const parent = await this.runStore.getRun(parentRunId);
    if (!parent) {
      return {
        status: "blocked",
        reasons: ["delegated_execution_parent_missing"]
      };
    }
    const recovered = await this.topicProbeFollowupRuns.consumePromotedFollowup(parent);
    if (
      (recovered.status === "created" || recovered.status === "reused")
      && recovered.childRun?.id !== run.id
    ) {
      return {
        status: "blocked",
        reasons: ["delegated_execution_recovery_child_mismatch"]
      };
    }
    return recovered;
  }

  private async markDelegatedExecutionCompleted(
    lease: TopicProbeFollowupExecutionLease,
    detail: string
  ): Promise<RunPromotionExecutionState> {
    const markTerminal = this.topicProbeFollowupRuns.markExecutionTerminal;
    if (!markTerminal) {
      throw new Error("delegated_execution_terminal_persistence_unavailable");
    }
    const terminalState = await markTerminal.call(
      this.topicProbeFollowupRuns,
      lease,
      "completed",
      detail
    );
    if (
      terminalState.childRunId !== lease.childRunId
      || terminalState.status !== "completed"
    ) {
      throw new Error("delegated_execution_terminal_state_invalid");
    }
    return terminalState;
  }

  private canApplyRecommendation(
    run: RunRecord,
    recommendation: TransitionRecommendation,
    policy: AutonomousRunPolicy
  ): boolean {
    if (!recommendation.autoExecutable) {
      return false;
    }
    if (recommendation.confidence < policy.minTransitionConfidence) {
      return false;
    }
    if (
      recommendation.action === "pause_for_human"
      || recommendation.action === "delegate_successor"
    ) {
      return false;
    }
    if (recommendation.action === "advance") {
      return true;
    }
    if (!recommendation.targetNode) {
      return false;
    }
    if (!policy.allowedBacktracks.includes(recommendation.targetNode)) {
      return false;
    }

    const backwardJumps = (run.graph.transitionHistory || []).filter((item) => {
      if (!item.toNode) {
        return false;
      }
      return GRAPH_NODE_ORDER.indexOf(item.toNode) < GRAPH_NODE_ORDER.indexOf(item.fromNode);
    }).length;
    const deepBacktracks = (run.graph.transitionHistory || []).filter((item) => {
      return item.toNode === "generate_hypotheses";
    }).length;
    const isDeepBacktrack = recommendation.targetNode === "generate_hypotheses";

    if (backwardJumps >= policy.maxBackwardJumps) {
      return false;
    }
    if (isDeepBacktrack && recommendation.confidence < policy.minDeepBacktrackConfidence) {
      return false;
    }
    if (isDeepBacktrack && deepBacktracks >= policy.maxDeepBacktracks) {
      return false;
    }
    if (isDeepBacktrack && !supportsHypothesisBacktrack(recommendation)) {
      return false;
    }
    return true;
  }

  private async runWithPromotionHeartbeat<T>(
    lease: TopicProbeFollowupExecutionLease | undefined,
    externalSignal: AbortSignal | undefined,
    operation: (abortSignal?: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (!lease) {
      return operation(externalSignal);
    }
    const heartbeat = this.topicProbeFollowupRuns.heartbeatExecution;
    if (!heartbeat) {
      throw new Error("topic_probe_followup_heartbeat_unavailable");
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (externalSignal?.aborted) {
      controller.abort();
    } else {
      externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    }
    let heartbeatError: unknown;
    let heartbeatChain: Promise<void> = Promise.resolve();
    const tick = () => {
      heartbeatChain = heartbeatChain.then(async () => {
        if (heartbeatError) {
          return;
        }
        try {
          await heartbeat.call(this.topicProbeFollowupRuns, lease);
        } catch (error) {
          heartbeatError = error;
          controller.abort();
        }
      });
    };
    const interval = setInterval(
      tick,
      Math.max(25, Math.floor(lease.leaseDurationMs / 3))
    );
    try {
      const result = await operation(controller.signal);
      await heartbeatChain;
      if (heartbeatError) {
        throw heartbeatError;
      }
      return result;
    } finally {
      clearInterval(interval);
      externalSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  private async getRunOrThrow(runId: string): Promise<RunRecord> {
    const run = await this.runStore.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return run;
  }

  private emit(run: RunRecord, text: string): void {
    this.eventStream.emit({
      type: "OBS_RECEIVED",
      runId: run.id,
      node: run.currentNode,
      payload: { text }
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error("Operation aborted by user");
    }
  }
}

function buildDefaultTopicProbeFollowupConsumer(
  runStore: RunStore
): TopicProbeFollowupRunConsumer {
  const candidate = runStore as Partial<RunStore>;
  if (
    typeof candidate.getWorkspaceRoot !== "function"
    || typeof candidate.getPromotionStore !== "function"
  ) {
    return {
      async consumePromotedFollowup() {
        return {
          status: "blocked",
          reasons: ["topic_probe_followup_store_unavailable"]
        };
      }
    };
  }
  return new TopicProbeFollowupRunManager(runStore);
}

function recommendationKey(recommendation: TransitionRecommendation): string {
  return `${recommendation.action}:${recommendation.targetNode || "stay"}`;
}

function describeFollowupRoute(
  result: TopicProbeFollowupRunResult,
  childRun: RunRecord
): string {
  const relation = result.receipt?.relation
    ?? childRun.promotionLineage?.relation
    ?? "unknown";
  const receipt = result.receipt?.content_sha256
    ?? childRun.promotionLineage?.receiptContentSha256
    ?? "unavailable";
  return `route=${relation}, receipt=${receipt}`;
}

function describeDelegatedRunRoute(run: RunRecord): string {
  const relation = run.promotionLineage?.relation ?? "unknown";
  const receipt = run.promotionLineage?.receiptContentSha256 ?? "unavailable";
  return `route=${relation}, receipt=${receipt}`;
}

function supportsHypothesisBacktrack(recommendation: TransitionRecommendation): boolean {
  const text = [recommendation.reason, ...recommendation.evidence].join(" ").toLowerCase();
  const hasHypothesisSignal =
    text.includes("hypothesis") ||
    text.includes("idea set") ||
    text.includes("shortlisted") ||
    text.includes("not support");
  const hasExecutionSignal =
    text.includes("runtime") ||
    text.includes("verifier") ||
    text.includes("metrics file") ||
    text.includes("missing metrics");
  return hasHypothesisSignal && !hasExecutionSignal;
}

function normalizeControllerError(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) {
    return "unknown";
  }
  return error.message.replace(/[^a-z0-9_:.\/-]+/giu, "_").slice(0, 180);
}
