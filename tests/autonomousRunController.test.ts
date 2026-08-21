import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureScaffold, resolveAppPaths } from "../src/config.js";
import { AgentOrchestrator } from "../src/core/agents/agentOrchestrator.js";
import {
  AutonomousRunController,
  buildDefaultOvernightPolicy,
  buildDefaultAutonomousPolicy,
  TopicProbeFollowupRunConsumer,
  WritePaperGateConfig
} from "../src/core/agents/autonomousRunController.js";
import { InMemoryEventStream } from "../src/core/events.js";
import { RunStore } from "../src/core/runs/runStore.js";
import { CheckpointStore } from "../src/core/stateGraph/checkpointStore.js";
import { StateGraphRuntime } from "../src/core/stateGraph/runtime.js";
import { GraphNodeHandler, GraphNodeRegistry } from "../src/core/stateGraph/types.js";
import type {
  TopicProbeFollowupExecutionLease,
  TopicProbeFollowupRunResult
} from "../src/core/topicProbeFollowupRun.js";
import { GRAPH_NODE_ORDER, GraphNodeId, RunRecord, RunSuccessorRelation } from "../src/types.js";

const ORIGINAL_CWD = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

class DeterministicRegistry implements GraphNodeRegistry {
  constructor(private readonly handlers: Partial<Record<GraphNodeId, GraphNodeHandler>>) {}

  get(nodeId: GraphNodeId): GraphNodeHandler {
    const explicit = this.handlers[nodeId];
    if (explicit) {
      return explicit;
    }
    return {
      id: nodeId,
      execute: async () => ({
        status: "success",
        summary: `${nodeId} ok`,
        needsApproval: true,
        toolCallsUsed: 1
      })
    };
  }

  list(): GraphNodeHandler[] {
    return GRAPH_NODE_ORDER.map((node) => this.get(node));
  }
}

async function setup(
  registry: GraphNodeRegistry,
  followupConsumer?: TopicProbeFollowupRunConsumer
): Promise<{
  store: RunStore;
  controller: AutonomousRunController;
  events: InMemoryEventStream;
}> {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "autolabos-autonomy-"));
  tempDirs.push(cwd);
  process.chdir(cwd);

  const paths = resolveAppPaths(cwd);
  await ensureScaffold(paths);

  const store = new RunStore(paths);
  const checkpointStore = new CheckpointStore(paths);
  const eventStream = new InMemoryEventStream();
  const runtime = new StateGraphRuntime(store, registry, checkpointStore, eventStream);
  const orchestrator = new AgentOrchestrator(store, runtime, checkpointStore);
  const controller = new AutonomousRunController(
    store,
    orchestrator,
    eventStream,
    followupConsumer
  );
  return { store, controller, events: eventStream };
}

const OUTCOME_HASH = "a".repeat(64);
const DEFAULT_RECEIPT_HASH = "b".repeat(64);

async function createDelegatedRun(input: {
  store: RunStore;
  parent: RunRecord;
  relation: RunSuccessorRelation;
  title?: string;
  receiptHash?: string;
}): Promise<RunRecord> {
  return input.store.createRun(
    {
      title: input.title ?? "Delegated successor",
      topic: "evaluate the declared candidate",
      constraints: ["one governed pass"],
      objectiveMetric: "declared primary measure"
    },
    {
      executionRole: "delegated_once",
      promotionLineage: {
        schemaVersion: 1,
        relation: input.relation,
        parentRunId: input.parent.id,
        parentResearchCycle: input.parent.graph.researchCycle,
        outcomeContentSha256: OUTCOME_HASH,
        receiptContentSha256: input.receiptHash ?? DEFAULT_RECEIPT_HASH
      }
    }
  );
}

function pauseAtReview(
  run: RunRecord,
  action: "pause_for_human" | "delegate_successor",
  options: {
    autoExecutable?: boolean;
    targetNode?: GraphNodeId;
  } = {}
): void {
  run.currentNode = "review";
  run.graph.currentNode = "review";
  run.status = "paused";
  run.graph.nodeStates.review.status = "needs_approval";
  run.graph.pendingTransition = {
    action,
    sourceNode: "review",
    ...(options.targetNode ? { targetNode: options.targetNode } : {}),
    reason: action === "pause_for_human"
      ? "Human judgment is required before continuing."
      : "Continue through a separately governed successor.",
    confidence: 0.99,
    autoExecutable: options.autoExecutable ?? true,
    evidence: ["The review route is explicitly recorded."],
    suggestedCommands: ["/agent status"],
    generatedAt: new Date().toISOString()
  };
}

function buildLease(
  childRunId: string,
  fenceToken = 1
): TopicProbeFollowupExecutionLease {
  return {
    childRunId,
    ownerId: "controller-owner",
    fenceToken,
    leaseDurationMs: 60,
    leaseExpiresAtMs: Date.now() + 60
  };
}

function buildReceiptMetadata(
  relation: RunSuccessorRelation,
  contentSha256 = DEFAULT_RECEIPT_HASH
): NonNullable<TopicProbeFollowupRunResult["receipt"]> {
  return {
    relation,
    content_sha256: contentSha256
  } as NonNullable<TopicProbeFollowupRunResult["receipt"]>;
}

function completedExecutionState(lease: TopicProbeFollowupExecutionLease) {
  return {
    childRunId: lease.childRunId,
    status: "completed" as const,
    fenceToken: lease.fenceToken,
    ownerId: lease.ownerId,
    terminalAt: "2026-01-01T00:00:00.000Z"
  };
}


describe("AutonomousRunController", () => {
  it("applies a pending design backtrack before stopping for manual review", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    run.currentNode = "analyze_results";
    run.graph.currentNode = "analyze_results";
    run.status = "paused";
    run.graph.nodeStates.analyze_results.status = "needs_approval";
    run.graph.pendingTransition = {
      action: "backtrack_to_design",
      sourceNode: "analyze_results",
      targetNode: "design_experiments",
      reason: "Revise the design before rerunning.",
      confidence: 0.84,
      autoExecutable: true,
      evidence: ["Objective not met."],
      suggestedCommands: ["/agent jump design_experiments", "/agent run design_experiments"],
      generatedAt: new Date().toISOString()
    };
    await store.updateRun(run);

    const policy = {
      ...buildDefaultOvernightPolicy(),
      autoApproveNodes: [] as GraphNodeId[]
    };
    const result = await controller.runOvernight(run.id, policy);

    expect(result.status).toBe("stopped");
    expect(result.reason).toBe("Reached write_paper gate.");
    expect(result.transitionsApplied).toBe(1);

    const latest = await store.getRun(run.id);
    expect(latest?.currentNode).toBe("write_paper");
    expect(latest?.graph.transitionHistory.at(-1)?.action).toBe("backtrack_to_design");
  });

  it("allows one high-confidence hypothesis backtrack under the default overnight policy", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    run.currentNode = "analyze_results";
    run.graph.currentNode = "analyze_results";
    run.status = "paused";
    run.graph.nodeStates.analyze_results.status = "needs_approval";
    run.graph.pendingTransition = {
      action: "backtrack_to_hypotheses",
      sourceNode: "analyze_results",
      targetNode: "generate_hypotheses",
      reason: "The shortlisted hypothesis is not supported, so the idea set should be revisited.",
      confidence: 0.93,
      autoExecutable: true,
      evidence: ["Current experiment outcomes do not support the shortlisted hypothesis."],
      suggestedCommands: ["/agent jump generate_hypotheses", "/agent run generate_hypotheses"],
      generatedAt: new Date().toISOString()
    };
    await store.updateRun(run);

    const policy = {
      ...buildDefaultOvernightPolicy(),
      autoApproveNodes: [] as GraphNodeId[]
    };
    const result = await controller.runOvernight(run.id, policy);

    expect(result.status).toBe("stopped");
    expect(result.transitionsApplied).toBe(1);

    const latest = await store.getRun(run.id);
    expect(latest?.currentNode).toBe("write_paper");
    expect(latest?.graph.transitionHistory.some((item) => item.toNode === "generate_hypotheses")).toBe(true);
  });

  it("routes an advance recommendation into the review node", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    run.currentNode = "analyze_results";
    run.graph.currentNode = "analyze_results";
    run.status = "paused";
    run.graph.nodeStates.analyze_results.status = "needs_approval";
    run.graph.pendingTransition = {
      action: "advance",
      sourceNode: "analyze_results",
      targetNode: "review",
      reason: "Ready for manual review before drafting the paper.",
      confidence: 0.9,
      autoExecutable: true,
      evidence: ["Objective met."],
      suggestedCommands: ["/approve"],
      generatedAt: new Date().toISOString()
    };
    await store.updateRun(run);

    const policy = {
      ...buildDefaultOvernightPolicy(),
      autoApproveNodes: [] as GraphNodeId[]
    };
    const result = await controller.runOvernight(run.id, policy);

    expect(result.status).toBe("stopped");
    expect(result.transitionsApplied).toBe(1);

    const latest = await store.getRun(run.id);
    expect(latest?.currentNode).toBe("write_paper");
    expect(latest?.graph.transitionHistory.at(-1)?.toNode).toBe("review");
  });

  it("stops instead of auto-approving when a recommendation needs human judgment", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    run.currentNode = "analyze_results";
    run.graph.currentNode = "analyze_results";
    run.status = "paused";
    run.graph.nodeStates.analyze_results.status = "needs_approval";
    run.graph.pendingTransition = {
      action: "backtrack_to_hypotheses",
      sourceNode: "analyze_results",
      targetNode: "generate_hypotheses",
      reason: "Evidence is mixed enough that a human should decide whether to reset the hypothesis set.",
      confidence: 0.72,
      autoExecutable: false,
      evidence: ["The objective was missed but supporting evidence remains ambiguous."],
      suggestedCommands: ["/agent transition"],
      generatedAt: new Date().toISOString()
    };
    await store.updateRun(run);

    const result = await controller.runOvernight(run.id, buildDefaultOvernightPolicy());

    expect(result.status).toBe("stopped");
    expect(result.reason).toContain("Manual review required for recommendation");
    expect(result.approvalsApplied).toBe(0);
    expect(result.transitionsApplied).toBe(0);

    const latest = await store.getRun(run.id);
    expect(latest?.currentNode).toBe("analyze_results");
    expect(latest?.graph.pendingTransition?.action).toBe("backtrack_to_hypotheses");
  });

  it("fails closed on pause_for_human even when overnight auto-approval conditions are maximal", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    run.currentNode = "analyze_results";
    run.graph.currentNode = "analyze_results";
    run.status = "paused";
    run.graph.nodeStates.analyze_results.status = "needs_approval";
    run.graph.pendingTransition = {
      action: "pause_for_human",
      sourceNode: "analyze_results",
      targetNode: "analyze_results",
      reason: "Governance requires pre-execution human approval.",
      confidence: 1.0,
      autoExecutable: true,
      evidence: ["The next action requires explicit human judgment."],
      suggestedCommands: ["/approve"],
      generatedAt: new Date().toISOString()
    };
    await store.updateRun(run);

    const policy = {
      ...buildDefaultOvernightPolicy(),
      autoApproveNodes: ["analyze_results"] as GraphNodeId[]
    };
    const result = await controller.runOvernight(run.id, policy);

    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("manual_review_required");
    expect(result.approvalsApplied).toBe(0);
    expect(result.transitionsApplied).toBe(0);

    const latest = await store.getRun(run.id);
    expect(latest?.status).toBe("paused");
    expect(latest?.currentNode).toBe("analyze_results");
    expect(latest?.graph.pendingTransition?.action).toBe("pause_for_human");
    expect(latest?.graph.transitionHistory).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Autonomous mode tests
// ---------------------------------------------------------------------------

describe("AutonomousRunController — autonomous mode", () => {

  it("consumes an authorized review delegation without applying a graph transition", async () => {
    let storeRef: RunStore | undefined;
    let childRun: RunRecord | undefined;
    const consumedParentIds: string[] = [];
    const heartbeatChildIds: string[] = [];
    const receiptHash = "c".repeat(64);
    const relation: RunSuccessorRelation = "topic_probe_portfolio_refresh";
    const followupConsumer: TopicProbeFollowupRunConsumer = {
      async consumePromotedFollowup(parentRun) {
        consumedParentIds.push(parentRun.id);
        const child = childRun
          ? (await storeRef?.getRun(childRun.id)) ?? childRun
          : undefined;
        if (!child) {
          return { status: "blocked", reasons: ["delegated_child_missing"] };
        }
        return {
          status: "created",
          reasons: [],
          childRun: child,
          receipt: buildReceiptMetadata(relation, receiptHash),
          executionLease: buildLease(child.id)
        };
      },
      async heartbeatExecution(lease) {
        heartbeatChildIds.push(lease.childRunId);
        return {
          ...lease,
          leaseExpiresAtMs: Date.now() + lease.leaseDurationMs
        };
      }
    };
    const { store, controller, events } = await setup(
      new DeterministicRegistry({}),
      followupConsumer
    );
    storeRef = store;
    const parent = await store.createRun({
      title: "Parent run",
      topic: "select a governed next route",
      constraints: [],
      objectiveMetric: "declared primary measure"
    });
    childRun = await createDelegatedRun({
      store,
      parent,
      relation,
      title: "Portfolio refresh successor",
      receiptHash
    });
    pauseAtReview(parent, "delegate_successor");
    await store.updateRun(parent);

    const policy = {
      ...buildDefaultAutonomousPolicy(),
      fuse: {
        ...buildDefaultAutonomousPolicy().fuse,
        maxTotalIterations: 1
      }
    };
    const result = await controller.runAutonomous(parent.id, policy);

    expect(consumedParentIds).toEqual([parent.id]);
    expect(result.run.id).toBe(childRun.id);
    expect(result.iterations).toBe(1);
    expect(result.transitionsApplied).toBe(0);
    expect(result.stopReason).toBe("catastrophic_fuse");
    expect(heartbeatChildIds.length).toBeGreaterThanOrEqual(1);
    expect((await store.getRun(parent.id))?.graph.transitionHistory).toHaveLength(0);

    const messages = events.history(100).map((event) => String(event.payload.text ?? ""));
    expect(messages.some((message) => message.includes(`route=${relation}`))).toBe(true);
    expect(messages.some((message) => message.includes(`receipt=${receiptHash}`))).toBe(true);
  });

  it("treats a review pause_for_human as a terminal human boundary without calling the manager", async () => {
    const consumedParentIds: string[] = [];
    const followupConsumer: TopicProbeFollowupRunConsumer = {
      async consumePromotedFollowup(parentRun) {
        consumedParentIds.push(parentRun.id);
        return { status: "blocked", reasons: ["unexpected_consume"] };
      }
    };
    const { store, controller } = await setup(
      new DeterministicRegistry({}),
      followupConsumer
    );
    const run = await store.createRun({
      title: "Human boundary run",
      topic: "review a governed decision",
      constraints: [],
      objectiveMetric: "declared primary measure"
    });
    pauseAtReview(run, "pause_for_human");
    await store.updateRun(run);

    const result = await controller.runAutonomous(
      run.id,
      buildDefaultAutonomousPolicy()
    );

    expect(result).toMatchObject({
      status: "stopped",
      stopReason: "manual_review_required",
      transitionsApplied: 0,
      approvalsApplied: 0
    });
    expect(consumedParentIds).toEqual([]);
    expect((await store.getRun(run.id))?.graph.pendingTransition?.action).toBe("pause_for_human");
  });

  it.each([
    {
      label: "non-auto-executable",
      autoExecutable: false,
      targetNode: undefined
    },
    {
      label: "target-bearing",
      autoExecutable: true,
      targetNode: "write_paper" as GraphNodeId
    }
  ])("does not consume an invalid review delegation ($label)", async ({ autoExecutable, targetNode }) => {
    const consumedParentIds: string[] = [];
    const followupConsumer: TopicProbeFollowupRunConsumer = {
      async consumePromotedFollowup(parentRun) {
        consumedParentIds.push(parentRun.id);
        return { status: "blocked", reasons: ["unexpected_consume"] };
      }
    };
    const { store, controller } = await setup(
      new DeterministicRegistry({}),
      followupConsumer
    );
    const run = await store.createRun({
      title: "Invalid delegation run",
      topic: "validate a successor request",
      constraints: [],
      objectiveMetric: "declared primary measure"
    });
    pauseAtReview(run, "delegate_successor", { autoExecutable, targetNode });
    await store.updateRun(run);

    const result = await controller.runAutonomous(
      run.id,
      buildDefaultAutonomousPolicy()
    );

    expect(result.stopReason).toBe("manual_review_required");
    expect(result.transitionsApplied).toBe(0);
    expect(consumedParentIds).toEqual([]);
    expect((await store.getRun(run.id))?.graph.transitionHistory).toHaveLength(0);
  });

  it("recovers a terminal delegated child and stops without autonomous re-cycling", async () => {
    let childRun: RunRecord | undefined;
    const recoveredParentIds: string[] = [];
    const relation: RunSuccessorRelation = "topic_probe_deferred_candidate";
    const followupConsumer: TopicProbeFollowupRunConsumer = {
      async consumePromotedFollowup(parentRun) {
        recoveredParentIds.push(parentRun.id);
        if (!childRun) {
          return { status: "blocked", reasons: ["delegated_child_missing"] };
        }
        const recoveredLease = buildLease(childRun.id, 2);
        return {
          status: "reused",
          reasons: [],
          childRun,
          receipt: buildReceiptMetadata(relation),
          terminalState: completedExecutionState(recoveredLease)
        };
      }
    };
    const { store, controller } = await setup(
      new DeterministicRegistry({}),
      followupConsumer
    );
    const parent = await store.createRun({
      title: "Completed child parent",
      topic: "choose a deferred candidate",
      constraints: [],
      objectiveMetric: "declared primary measure"
    });
    childRun = await createDelegatedRun({ store, parent, relation });
    childRun.currentNode = "write_paper";
    childRun.graph.currentNode = "write_paper";
    childRun.graph.nodeStates.write_paper.status = "completed";
    childRun.status = "completed";
    await store.updateRun(childRun);

    const result = await controller.runAutonomous(
      childRun.id,
      buildDefaultAutonomousPolicy()
    );

    expect(recoveredParentIds).toEqual([parent.id]);
    expect(result).toMatchObject({
      status: "completed",
      stopReason: "run_completed",
      iterations: 0,
      researchCycles: 0
    });
    expect(result.run.id).toBe(childRun.id);
    expect(result.reason).toContain(`route=${relation}`);
  });

  it("stops a delegated child when heartbeat fencing is lost before node execution", async () => {
    let storeRef: RunStore | undefined;
    let childRun: RunRecord | undefined;
    let executeCalls = 0;
    let heartbeatCalls = 0;
    const relation: RunSuccessorRelation = "topic_probe_evidence_repair";
    const followupConsumer: TopicProbeFollowupRunConsumer = {
      async consumePromotedFollowup() {
        const child = childRun
          ? (await storeRef?.getRun(childRun.id)) ?? childRun
          : undefined;
        if (!child) {
          return { status: "blocked", reasons: ["delegated_child_missing"] };
        }
        return {
          status: "reused",
          reasons: [],
          childRun: child,
          executionLease: buildLease(child.id, 7)
        };
      },
      async heartbeatExecution() {
        heartbeatCalls += 1;
        throw new Error("stale fence token");
      }
    };
    const registry = new DeterministicRegistry({
      collect_papers: {
        id: "collect_papers",
        execute: async () => {
          executeCalls += 1;
          return {
            status: "success",
            summary: "collect_papers ok",
            needsApproval: true,
            toolCallsUsed: 1
          };
        }
      }
    });
    const { store, controller } = await setup(registry, followupConsumer);
    storeRef = store;
    const parent = await store.createRun({
      title: "Lease parent",
      topic: "repair declared evidence",
      constraints: [],
      objectiveMetric: "declared primary measure"
    });
    childRun = await createDelegatedRun({ store, parent, relation });

    const result = await controller.runAutonomous(
      childRun.id,
      buildDefaultAutonomousPolicy()
    );

    expect(result.stopReason).toBe("followup_handoff_blocked");
    expect(result.reason).toContain("lease lost");
    expect(heartbeatCalls).toBe(1);
    expect(executeCalls).toBe(0);
  });

  it("terminalizes a child lease before following a child-to-successor delegation chain", async () => {
    let rootRun: RunRecord | undefined;
    let firstChild: RunRecord | undefined;
    let secondChild: RunRecord | undefined;
    const operations: string[] = [];
    const firstRelation: RunSuccessorRelation = "topic_probe_repeat";
    const secondRelation: RunSuccessorRelation = "topic_probe_evidence_repair";
    const followupConsumer: TopicProbeFollowupRunConsumer = {
      async consumePromotedFollowup(parentRun) {
        if (parentRun.id === rootRun?.id && firstChild) {
          operations.push("consume:root");
          return {
            status: "created",
            reasons: [],
            childRun: firstChild,
            receipt: buildReceiptMetadata(firstRelation, firstChild.promotionLineage?.receiptContentSha256),
            executionLease: buildLease(firstChild.id, 3)
          };
        }
        if (parentRun.id === firstChild?.id && secondChild) {
          operations.push("consume:first-child");
          return {
            status: "created",
            reasons: [],
            childRun: secondChild,
            receipt: buildReceiptMetadata(secondRelation, secondChild.promotionLineage?.receiptContentSha256),
            executionLease: buildLease(secondChild.id, 4)
          };
        }
        return { status: "blocked", reasons: ["unexpected_parent"] };
      },
      async heartbeatExecution(lease) {
        operations.push(
          lease.childRunId === firstChild?.id
            ? "heartbeat:first-child"
            : "heartbeat:second-child"
        );
        return {
          ...lease,
          leaseExpiresAtMs: Date.now() + lease.leaseDurationMs
        };
      },
      async markExecutionTerminal(lease, status) {
        operations.push(
          lease.childRunId === firstChild?.id
            ? "terminal:first-child"
            : "terminal:second-child"
        );
        return {
          ...completedExecutionState(lease),
          status
        };
      }
    };
    const { store, controller } = await setup(
      new DeterministicRegistry({}),
      followupConsumer
    );
    rootRun = await store.createRun({
      title: "Root delegation run",
      topic: "select a bounded follow-up route",
      constraints: [],
      objectiveMetric: "declared primary measure"
    });
    firstChild = await createDelegatedRun({
      store,
      parent: rootRun,
      relation: firstRelation,
      receiptHash: "d".repeat(64)
    });
    secondChild = await createDelegatedRun({
      store,
      parent: firstChild,
      relation: secondRelation,
      receiptHash: "e".repeat(64)
    });
    pauseAtReview(rootRun, "delegate_successor");
    pauseAtReview(firstChild, "delegate_successor");
    secondChild.currentNode = "write_paper";
    secondChild.graph.currentNode = "write_paper";
    secondChild.graph.nodeStates.write_paper.status = "completed";
    secondChild.status = "completed";
    await store.updateRun(rootRun);
    await store.updateRun(firstChild);
    await store.updateRun(secondChild);

    const result = await controller.runAutonomous(
      rootRun.id,
      buildDefaultAutonomousPolicy()
    );

    expect(result).toMatchObject({
      status: "completed",
      stopReason: "run_completed",
      iterations: 0,
      researchCycles: 0,
      transitionsApplied: 0
    });
    expect(result.run.id).toBe(secondChild.id);
    expect(operations.indexOf("terminal:first-child")).toBeLessThan(
      operations.indexOf("consume:first-child")
    );
    expect(operations.filter((operation) => operation === "terminal:first-child")).toHaveLength(1);
    expect(operations.filter((operation) => operation === "terminal:second-child")).toHaveLength(1);
  });

  it("recovers a marker-backed terminal chain by reusing the existing successor", async () => {
    let rootRun: RunRecord | undefined;
    let firstChild: RunRecord | undefined;
    let secondChild: RunRecord | undefined;
    const consumedParentIds: string[] = [];
    const firstRelation: RunSuccessorRelation = "topic_probe_portfolio_refresh";
    const secondRelation: RunSuccessorRelation = "topic_probe_deferred_candidate";
    const followupConsumer: TopicProbeFollowupRunConsumer = {
      async consumePromotedFollowup(parentRun) {
        consumedParentIds.push(parentRun.id);
        if (parentRun.id === rootRun?.id && firstChild) {
          const inboundLease = buildLease(firstChild.id, 5);
          return {
            status: "reused",
            reasons: [],
            childRun: firstChild,
            receipt: buildReceiptMetadata(firstRelation, firstChild.promotionLineage?.receiptContentSha256),
            terminalState: completedExecutionState(inboundLease)
          };
        }
        if (parentRun.id === firstChild?.id && secondChild) {
          const outboundLease = buildLease(secondChild.id, 6);
          return {
            status: "reused",
            reasons: [],
            childRun: secondChild,
            receipt: buildReceiptMetadata(secondRelation, secondChild.promotionLineage?.receiptContentSha256),
            terminalState: completedExecutionState(outboundLease)
          };
        }
        return { status: "blocked", reasons: ["unexpected_parent"] };
      }
    };
    const { store, controller } = await setup(
      new DeterministicRegistry({}),
      followupConsumer
    );
    rootRun = await store.createRun({
      title: "Restart root",
      topic: "resume a governed route",
      constraints: [],
      objectiveMetric: "declared primary measure"
    });
    firstChild = await createDelegatedRun({
      store,
      parent: rootRun,
      relation: firstRelation,
      receiptHash: "f".repeat(64)
    });
    secondChild = await createDelegatedRun({
      store,
      parent: firstChild,
      relation: secondRelation,
      receiptHash: "1".repeat(64)
    });
    pauseAtReview(rootRun, "delegate_successor");
    pauseAtReview(firstChild, "delegate_successor");
    firstChild.delegatedSuccessor = {
      schemaVersion: 1,
      state: "delegated",
      relation: secondRelation,
      parentResearchCycle: firstChild.graph.researchCycle,
      childRunId: secondChild.id,
      outcomeContentSha256: OUTCOME_HASH,
      receiptContentSha256: secondChild.promotionLineage?.receiptContentSha256 ?? DEFAULT_RECEIPT_HASH,
      reservedAt: "2026-01-01T00:00:00.000Z"
    };
    secondChild.currentNode = "write_paper";
    secondChild.graph.currentNode = "write_paper";
    secondChild.graph.nodeStates.write_paper.status = "completed";
    secondChild.status = "completed";
    await store.updateRun(rootRun);
    await store.updateRun(firstChild);
    await store.updateRun(secondChild);

    const result = await controller.runAutonomous(
      firstChild.id,
      buildDefaultAutonomousPolicy()
    );

    expect(consumedParentIds).toEqual([rootRun.id, firstChild.id]);
    expect(result.status).toBe("completed");
    expect(result.run.id).toBe(secondChild.id);
    expect(result.iterations).toBe(0);
    expect(await store.listRuns()).toHaveLength(3);
  });

  it("buildDefaultAutonomousPolicy returns relaxed limits vs overnight", () => {
    const overnight = buildDefaultOvernightPolicy();
    const autonomous = buildDefaultAutonomousPolicy();

    expect(autonomous.mode).toBe("autonomous");
    // Autonomous has no time limit (Infinity)
    expect(autonomous.maxMinutes).toBe(Infinity);
    expect(Number.isFinite(autonomous.maxMinutes)).toBe(false);
    // Overnight now has 24-hour limit
    expect(overnight.maxMinutes).toBe(24 * 60);
    expect(autonomous.maxBackwardJumps).toBeGreaterThan(overnight.maxBackwardJumps);
    expect(autonomous.maxDeepBacktracks).toBeGreaterThan(overnight.maxDeepBacktracks);
    expect(autonomous.minTransitionConfidence).toBeLessThan(overnight.minTransitionConfidence);
    expect(autonomous.minDeepBacktrackConfidence).toBeLessThan(overnight.minDeepBacktrackConfidence);
    expect(autonomous.stopBeforeWritePaper).toBe(false);

    // Autonomous auto-approves more nodes than overnight, but NOT review or write_paper
    expect(autonomous.autoApproveNodes.length).toBeGreaterThan(overnight.autoApproveNodes.length);
    expect(autonomous.autoApproveNodes).toContain("generate_hypotheses");
    expect(autonomous.autoApproveNodes).not.toContain("review");
    expect(autonomous.autoApproveNodes).not.toContain("write_paper");
  });

  it("policy has required novelty, paper pressure, and fuse configs", () => {
    const policy = buildDefaultAutonomousPolicy();

    // Novelty config
    expect(policy.novelty.windowSize).toBeGreaterThan(0);
    expect(policy.novelty.minNovelSignalsPerWindow).toBeGreaterThan(0);
    expect(policy.novelty.maxStagnantWindows).toBeGreaterThan(0);

    // Paper pressure config
    expect(policy.paperPressure.checkIntervalCycles).toBeGreaterThan(0);
    expect(policy.paperPressure.forceUpgradeAfterCycles).toBeGreaterThan(policy.paperPressure.checkIntervalCycles);

    // Fuse config (catastrophic runaway protection)
    expect(policy.fuse.maxTotalIterations).toBeGreaterThan(100);
    expect(policy.fuse.maxConsecutiveFailures).toBeGreaterThan(3);
    expect(policy.fuse.maxRepeatedRecommendation).toBeGreaterThan(2);
  });

  it("stops on catastrophic fuse when max iterations reached", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    const policy = {
      ...buildDefaultAutonomousPolicy(),
      fuse: { maxTotalIterations: 2, maxConsecutiveFailures: 10, maxRepeatedRecommendation: 5 }
    };

    const result = await controller.runAutonomous(run.id, policy);
    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("catastrophic_fuse");
    expect(result.reason).toContain("max iterations");
  });

  it("stops on consecutive failures", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    // Pre-set the run to failed state to test failure-counting logic
    run.status = "failed";
    run.graph.nodeStates.collect_papers.status = "failed";
    run.graph.nodeStates.collect_papers.lastError = "Simulated failure";
    await store.updateRun(run);

    const policy = {
      ...buildDefaultAutonomousPolicy(),
      fuse: { maxTotalIterations: 100, maxConsecutiveFailures: 1, maxRepeatedRecommendation: 5 }
    };

    const result = await controller.runAutonomous(run.id, policy);
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("consecutive_failures");
  });

  it("stops on time limit", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    const policy = {
      ...buildDefaultAutonomousPolicy(),
      maxMinutes: 0 // immediate timeout
    };

    const result = await controller.runAutonomous(run.id, policy);
    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("time_limit");
  });

  it("stops on user abort signal", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    const abortController = new AbortController();
    abortController.abort();

    const result = await controller.runAutonomous(run.id, buildDefaultAutonomousPolicy(), {
      abortSignal: abortController.signal
    });
    expect(result.status).toBe("canceled");
    expect(result.stopReason).toBe("user_stop");
  });

  it("stops on repeated recommendation catastrophic fuse", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    // Set up a repeated recommendation scenario
    run.currentNode = "analyze_results";
    run.graph.currentNode = "analyze_results";
    run.status = "paused";
    run.graph.nodeStates.analyze_results.status = "needs_approval";
    run.graph.pendingTransition = {
      action: "pause_for_human",
      sourceNode: "analyze_results",
      reason: "Need manual help",
      confidence: 0.3,
      autoExecutable: false,
      evidence: [],
      suggestedCommands: [],
      generatedAt: new Date().toISOString()
    };
    await store.updateRun(run);

    const policy = {
      ...buildDefaultAutonomousPolicy(),
      autoApproveNodes: [] as GraphNodeId[],
      fuse: { maxTotalIterations: 500, maxConsecutiveFailures: 10, maxRepeatedRecommendation: 1 }
    };

    const result = await controller.runAutonomous(run.id, policy);
    expect(result.status).toBe("stopped");
    // Should stop due to manual_review_required since it's a pause_for_human with no auto-approve
    expect(["manual_review_required", "catastrophic_fuse"]).toContain(result.stopReason);
  });

  it("fails closed on pause_for_human before autonomous force-apply or auto-approval", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    run.currentNode = "analyze_results";
    run.graph.currentNode = "analyze_results";
    run.status = "paused";
    run.graph.nodeStates.analyze_results.status = "needs_approval";
    run.graph.pendingTransition = {
      action: "pause_for_human",
      sourceNode: "analyze_results",
      targetNode: "analyze_results",
      reason: "Governance requires pre-execution human approval.",
      confidence: 1.0,
      autoExecutable: true,
      evidence: ["The next action requires explicit human judgment."],
      suggestedCommands: ["/approve"],
      generatedAt: new Date().toISOString()
    };
    await store.updateRun(run);

    const policy = {
      ...buildDefaultAutonomousPolicy(),
      autoApproveNodes: ["analyze_results"] as GraphNodeId[],
      fuse: {
        maxTotalIterations: 1,
        maxConsecutiveFailures: 10,
        maxRepeatedRecommendation: 5
      }
    };
    const result = await controller.runAutonomous(run.id, policy);

    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("manual_review_required");
    expect(result.approvalsApplied).toBe(0);
    expect(result.transitionsApplied).toBe(0);

    const latest = await store.getRun(run.id);
    expect(latest?.status).toBe("paused");
    expect(latest?.currentNode).toBe("analyze_results");
    expect(latest?.graph.pendingTransition?.action).toBe("pause_for_human");
    expect(latest?.graph.transitionHistory).toHaveLength(0);
  });

  it("does not force-apply a high-confidence recommendation marked non-auto-executable", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    run.currentNode = "analyze_results";
    run.graph.currentNode = "analyze_results";
    run.status = "paused";
    run.graph.nodeStates.analyze_results.status = "needs_approval";
    run.graph.pendingTransition = {
      action: "backtrack_to_design",
      sourceNode: "analyze_results",
      targetNode: "design_experiments",
      reason: "The evidence is ambiguous and requires an operator decision.",
      confidence: 1,
      autoExecutable: false,
      evidence: ["Ambiguous evidence."],
      suggestedCommands: ["/agent transition"],
      generatedAt: new Date().toISOString()
    };
    await store.updateRun(run);

    const policy = {
      ...buildDefaultAutonomousPolicy(),
      autoApproveNodes: ["analyze_results"] as GraphNodeId[]
    };
    const result = await controller.runAutonomous(run.id, policy);

    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("manual_review_required");
    expect(result.approvalsApplied).toBe(0);
    expect(result.transitionsApplied).toBe(0);
    const latest = await store.getRun(run.id);
    expect(latest?.currentNode).toBe("analyze_results");
    expect(latest?.graph.pendingTransition?.autoExecutable).toBe(false);
  });

  it("result includes bestBranch, paperStatus, and noveltySignals", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    const policy = {
      ...buildDefaultAutonomousPolicy(),
      maxMinutes: 0 // immediate stop
    };

    const result = await controller.runAutonomous(run.id, policy);
    // All result fields should be present
    expect(result.iterations).toBeDefined();
    expect(result.researchCycles).toBeDefined();
    expect(result.noveltySignals).toBeDefined();
    expect(result.stopReason).toBeDefined();
  });

  it("detectCycleNovelty detects new hypothesis", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    run.graph.nodeStates.generate_hypotheses.note = "Test new hypothesis about X";
    await store.updateRun(run);

    const signals = await controller.detectCycleNovelty(run, 1, "", "", "", "");
    const hypothesisSignals = signals.filter(s => s.type === "new_hypothesis");
    expect(hypothesisSignals.length).toBe(1);
    expect(hypothesisSignals[0].detail).toContain("Test new hypothesis");
  });

  it("detectCycleNovelty detects different analysis outcome", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    run.graph.nodeStates.analyze_results.note = "Significant improvement over baseline";
    await store.updateRun(run);

    const signals = await controller.detectCycleNovelty(run, 1, "", "", "", "");
    const analysisSignals = signals.filter(s => s.type === "different_analysis_outcome");
    expect(analysisSignals.length).toBe(1);
  });

  it("detectCycleNovelty detects new comparator from design note", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    run.graph.nodeStates.design_experiments.note = "Added ablation comparator for module X";
    await store.updateRun(run);

    const signals = await controller.detectCycleNovelty(run, 1, "", "", "", "");
    const comparatorSignals = signals.filter(s => s.type === "new_comparator");
    expect(comparatorSignals.length).toBe(1);
  });

  it("detectCycleNovelty skips when notes unchanged", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    run.graph.nodeStates.generate_hypotheses.note = "Same hypothesis";
    run.graph.nodeStates.analyze_results.note = "Same analysis";
    await store.updateRun(run);

    const signals = await controller.detectCycleNovelty(run, 2, "Same hypothesis", "Same analysis", "", "");
    const newSignals = signals.filter(s => s.type === "new_hypothesis" || s.type === "different_analysis_outcome");
    expect(newSignals.length).toBe(0);
  });

  it("evaluateBestBranch returns branch with evidence gaps", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "some research topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    const branch = await controller.evaluateBestBranch(run, undefined, 1);
    expect(branch.branchId).toBe("cycle-1");
    expect(branch.evidenceGaps.length).toBeGreaterThan(0);
    // Without artifacts, all gaps should be present
    expect(branch.evidenceGaps.some(g => g.includes("baseline"))).toBe(true);
    expect(branch.evidenceGaps.some(g => g.includes("quantitative"))).toBe(true);
    expect(branch.manuscriptType).toBe("not_analyzed");
  });

  it("keeps archived best-branch scoring separate from the current-cycle write gate", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });
    const runDir = path.join(process.cwd(), ".autolabos", "runs", run.id);
    const reviewDir = path.join(runDir, "review");
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(path.join(runDir, "metrics.json"), JSON.stringify({ primary_outcome: 0.7 }));
    writeFileSync(path.join(runDir, "baseline_summary.json"), JSON.stringify({ comparator: "reference" }));
    writeFileSync(path.join(runDir, "result_table.json"), JSON.stringify({ rows: [{ value: 0.7 }] }));
    writeFileSync(path.join(runDir, "result_analysis.json"), JSON.stringify({ manuscript_type: "paper_scale_candidate" }));
    writeFileSync(path.join(reviewDir, "minimum_gate.json"), JSON.stringify({ passed: true, ceiling_type: "paper_scale_candidate" }));
    writeFileSync(path.join(reviewDir, "paper_quality_evaluation.json"), JSON.stringify({
      overall_score_1_to_10: 8,
      paper_worthiness: "paper_scale_candidate",
      evidence_gaps: [],
      upgrade_priorities: []
    }));

    const archivedBest = await controller.evaluateBestBranch(run, undefined, 1);
    expect(controller.meetsWritePaperBar(archivedBest, buildDefaultAutonomousPolicy().writePaperGate).passes).toBe(true);

    for (const relativePath of [
      "metrics.json",
      "baseline_summary.json",
      "result_table.json",
      "result_analysis.json",
      path.join("review", "minimum_gate.json"),
      path.join("review", "paper_quality_evaluation.json")
    ]) {
      writeFileSync(path.join(runDir, relativePath), "{}\n");
    }

    const currentCycle = await controller.evaluateCurrentBranch(run, 2, archivedBest);
    const stillArchivedBest = await controller.evaluateBestBranch(run, archivedBest, 2);

    expect(stillArchivedBest.branchId).toBe("cycle-1");
    expect(currentCycle.branchId).toBe("cycle-2");
    expect(controller.meetsWritePaperBar(currentCycle, buildDefaultAutonomousPolicy().writePaperGate).passes).toBe(false);
  });

  it("readMetricsHash returns empty for missing artifacts", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    const hash = await controller.readMetricsHash(run);
    expect(hash).toBe("");
  });

  it("overnight mode behavior is unchanged — stops before write_paper", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    const policy = buildDefaultOvernightPolicy();
    const result = await controller.runOvernight(run.id, policy);

    expect(result.status).toBe("stopped");
    expect(result.stopReason).toBe("write_paper_gate");
  });

  it("distinct stop reasons are clearly distinguished", () => {
    // Verify all expected stop reasons are defined as valid types
    const validReasons: string[] = [
      "user_stop", "time_limit", "resource_limit", "run_completed",
      "run_failed", "write_paper_gate", "manual_review_required",
      "repeated_recommendation", "stagnation", "catastrophic_fuse",
      "consecutive_failures"
    ];
    // This is a compile-time check reflected here for documentation
    expect(validReasons.length).toBe(11);
  });

  it("autonomous mode default policy has no time limit (Infinity)", () => {
    const policy = buildDefaultAutonomousPolicy();
    expect(policy.maxMinutes).toBe(Infinity);
    expect(Number.isFinite(policy.maxMinutes)).toBe(false);
  });

  it("overnight mode default policy has 24-hour limit", () => {
    const policy = buildDefaultOvernightPolicy();
    expect(policy.maxMinutes).toBe(24 * 60);
  });

  it("autonomous policy has writePaperGate config", () => {
    const policy = buildDefaultAutonomousPolicy();
    expect(policy.writePaperGate).toBeDefined();
    expect(policy.writePaperGate.requireBaselineOrComparator).toBe(true);
    expect(policy.writePaperGate.requireQuantitativeResults).toBe(true);
    expect(policy.writePaperGate.minBranchScore).toBeGreaterThan(0);
    expect(policy.writePaperGate.blockedManuscriptTypes).toContain("not_analyzed");
    expect(policy.writePaperGate.blockedManuscriptTypes).toContain("system_validation_note");
  });

  it("review and write_paper are NOT in autonomous autoApproveNodes", () => {
    const policy = buildDefaultAutonomousPolicy();
    expect(policy.autoApproveNodes).not.toContain("review");
    expect(policy.autoApproveNodes).not.toContain("write_paper");
    // But exploration nodes are still auto-approved
    expect(policy.autoApproveNodes).toContain("generate_hypotheses");
    expect(policy.autoApproveNodes).toContain("design_experiments");
    expect(policy.autoApproveNodes).toContain("implement_experiments");
    expect(policy.autoApproveNodes).toContain("run_experiments");
    expect(policy.autoApproveNodes).toContain("analyze_results");
  });

  it("meetsWritePaperBar blocks when evidence is insufficient", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    const branch = await controller.evaluateBestBranch(run, undefined, 1);
    const gate: WritePaperGateConfig = {
      requireBaselineOrComparator: true,
      requireQuantitativeResults: true,
      minBranchScore: 5,
      blockedManuscriptTypes: ["not_analyzed", "system_validation_note"]
    };

    const result = controller.meetsWritePaperBar(branch, gate);
    expect(result.passes).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers.some(b => b.includes("baseline") || b.includes("comparator"))).toBe(true);
    expect(result.blockers.some(b => b.includes("quantitative"))).toBe(true);
  });

  it("meetsWritePaperBar passes when evidence is sufficient", () => {
    const { controller } = { controller: new AutonomousRunController(
      {} as any, {} as any, new InMemoryEventStream()
    )};

    const strongBranch = {
      branchId: "cycle-5",
      hypothesis: "Test hypothesis",
      hasBaseline: true,
      hasComparator: true,
      hasQuantitativeResults: true,
      hasResultTable: true,
      manuscriptType: "paper_scale_candidate",
      lastUpgradeCycle: 4,
      evidenceGaps: [],
      upgradeActions: []
    };

    const gate: WritePaperGateConfig = {
      requireBaselineOrComparator: true,
      requireQuantitativeResults: true,
      minBranchScore: 5,
      blockedManuscriptTypes: ["not_analyzed", "system_validation_note"]
    };

    const result = controller.meetsWritePaperBar(strongBranch, gate);
    expect(result.passes).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("meetsWritePaperBar returns blockers when no branch available", () => {
    const controller = new AutonomousRunController(
      {} as any, {} as any, new InMemoryEventStream()
    );

    const gate: WritePaperGateConfig = {
      requireBaselineOrComparator: true,
      requireQuantitativeResults: true,
      minBranchScore: 5,
      blockedManuscriptTypes: ["not_analyzed"]
    };

    const result = controller.meetsWritePaperBar(undefined, gate);
    expect(result.passes).toBe(false);
    expect(result.blockers).toContain("No evaluated branch available");
  });

  it("write_paper gate blocks at review node in autonomous mode", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    // Set up run at review node needing approval (no recommendation, no artifacts)
    run.currentNode = "review";
    run.graph.currentNode = "review";
    run.status = "paused";
    run.graph.nodeStates.review.status = "needs_approval";
    await store.updateRun(run);

    // Use maxTotalIterations=8: with stopAfterApprovalBoundary each node takes
    // one iteration. 5 iterations to reach write_paper from design, then gate
    // blocks and backtracks, then fuse fires at a non-write_paper node.
    const policy = {
      ...buildDefaultAutonomousPolicy(),
      fuse: { maxTotalIterations: 8, maxConsecutiveFailures: 10, maxRepeatedRecommendation: 5 }
    };

    const result = await controller.runAutonomous(run.id, policy);
    // Without evidence artifacts, the gate should block write_paper entry.
    // The system should backtrack or stop — it should NOT proceed to write_paper.
    const latest = await store.getRun(run.id);
    expect(latest?.currentNode).not.toBe("write_paper");
  });

  it("write_paper gate blocks advance recommendation from review", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    // Set up review with advance recommendation but no evidence artifacts
    run.currentNode = "review";
    run.graph.currentNode = "review";
    run.status = "paused";
    run.graph.nodeStates.review.status = "needs_approval";
    run.graph.pendingTransition = {
      action: "advance",
      sourceNode: "review",
      targetNode: "write_paper",
      reason: "Ready for paper drafting",
      confidence: 0.95,
      autoExecutable: true,
      evidence: ["Review passed"],
      suggestedCommands: ["/approve"],
      generatedAt: new Date().toISOString()
    };
    await store.updateRun(run);

    // Same iteration budget: 8 iterations allows gate to fire before fuse
    const policy = {
      ...buildDefaultAutonomousPolicy(),
      fuse: { maxTotalIterations: 8, maxConsecutiveFailures: 10, maxRepeatedRecommendation: 5 }
    };

    const result = await controller.runAutonomous(run.id, policy);
    // Without evidence artifacts, the advance should be blocked by the gate
    const latest = await store.getRun(run.id);
    expect(latest?.currentNode).not.toBe("write_paper");
  });

  it("does not stop on time_limit when maxMinutes is Infinity", async () => {
    const { store, controller } = await setup(new DeterministicRegistry({}));
    const run = await store.createRun({
      title: "Run",
      topic: "topic",
      constraints: [],
      objectiveMetric: "metric"
    });

    const policy = {
      ...buildDefaultAutonomousPolicy(),
      // maxMinutes is already Infinity by default
      fuse: { maxTotalIterations: 2, maxConsecutiveFailures: 10, maxRepeatedRecommendation: 5 }
    };

    const result = await controller.runAutonomous(run.id, policy);
    // Should stop on fuse (iterations), NOT time_limit
    expect(result.stopReason).toBe("catastrophic_fuse");
    expect(result.stopReason).not.toBe("time_limit");
  });

  // -----------------------------------------------------------------------
  // Two-layer paper quality evaluation integration
  // -----------------------------------------------------------------------

  it("meetsWritePaperBar blocks when minimumGatePassed is false", () => {
    const controller = Object.create(AutonomousRunController.prototype);
    const gate: WritePaperGateConfig = {
      requireBaselineOrComparator: true,
      requireQuantitativeResults: true,
      minBranchScore: 5,
      blockedManuscriptTypes: ["system_validation_note", "blocked_for_paper_scale"]
    };
    const branch = {
      branchId: "cycle-1",
      hypothesis: "test",
      hasBaseline: true,
      hasComparator: true,
      hasQuantitativeResults: true,
      hasResultTable: true,
      manuscriptType: "paper_scale_candidate",
      lastUpgradeCycle: 1,
      evidenceGaps: [],
      upgradeActions: [],
      minimumGatePassed: false,
      minimumGateCeiling: "blocked_for_paper_scale"
    };

    const result = controller.meetsWritePaperBar(branch, gate);

    expect(result.passes).toBe(false);
    expect(result.blockers.some((b: string) => b.includes("Minimum evidence gate blocked"))).toBe(true);
  });

  it("meetsWritePaperBar blocks when LLM worthiness is not_ready", () => {
    const controller = Object.create(AutonomousRunController.prototype);
    const gate: WritePaperGateConfig = {
      requireBaselineOrComparator: true,
      requireQuantitativeResults: true,
      minBranchScore: 5,
      blockedManuscriptTypes: ["system_validation_note", "blocked_for_paper_scale"]
    };
    const branch = {
      branchId: "cycle-1",
      hypothesis: "test",
      hasBaseline: true,
      hasComparator: true,
      hasQuantitativeResults: true,
      hasResultTable: true,
      manuscriptType: "paper_scale_candidate",
      lastUpgradeCycle: 1,
      evidenceGaps: [],
      upgradeActions: [],
      minimumGatePassed: true,
      minimumGateCeiling: "unrestricted",
      llmWorthiness: "not_ready",
      llmScore: 3
    };

    const result = controller.meetsWritePaperBar(branch, gate);

    expect(result.passes).toBe(false);
    expect(result.blockers.some((b: string) => b.includes("LLM evaluation: not ready"))).toBe(true);
  });

  it("meetsWritePaperBar passes when both layers are satisfied", () => {
    const controller = Object.create(AutonomousRunController.prototype);
    const gate: WritePaperGateConfig = {
      requireBaselineOrComparator: true,
      requireQuantitativeResults: true,
      minBranchScore: 5,
      blockedManuscriptTypes: ["system_validation_note", "blocked_for_paper_scale"]
    };
    const branch = {
      branchId: "cycle-1",
      hypothesis: "test",
      hasBaseline: true,
      hasComparator: true,
      hasQuantitativeResults: true,
      hasResultTable: true,
      manuscriptType: "paper_scale_candidate",
      lastUpgradeCycle: 1,
      evidenceGaps: [],
      upgradeActions: [],
      minimumGatePassed: true,
      minimumGateCeiling: "unrestricted",
      llmWorthiness: "paper_scale_candidate",
      llmScore: 7
    };

    const result = controller.meetsWritePaperBar(branch, gate);

    expect(result.passes).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it("BestBranchInfo includes two-layer quality fields", () => {
    const branch = {
      branchId: "cycle-5",
      hypothesis: "Testing hypothesis",
      hasBaseline: true,
      hasComparator: true,
      hasQuantitativeResults: true,
      hasResultTable: true,
      manuscriptType: "paper_scale_candidate",
      lastUpgradeCycle: 3,
      evidenceGaps: [],
      upgradeActions: ["Improve result table"],
      llmScore: 7,
      llmWorthiness: "paper_scale_candidate",
      llmRecommendedAction: "consolidate_evidence",
      minimumGatePassed: true,
      minimumGateCeiling: "unrestricted"
    };

    expect(branch.llmScore).toBe(7);
    expect(branch.llmWorthiness).toBe("paper_scale_candidate");
    expect(branch.minimumGatePassed).toBe(true);
  });
});
