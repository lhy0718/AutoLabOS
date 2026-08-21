import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  RunPromotionLineage,
  RunRecord,
  RunSuccessorRelation
} from "../types.js";
import { RunContextMemory } from "./memory/runContextMemory.js";
import { writeRunArtifact } from "./nodes/helpers.js";
import { hashCanonical } from "./researchFunnel.js";
import { parseAnalysisReport } from "./resultAnalysis.js";
import {
  extractRunBrief,
  parseMarkdownRunBriefSections,
  parseResearchRunMode
} from "./runs/runBriefParser.js";
import {
  buildBriefCompletenessArtifact,
  validateResearchBriefMarkdown
} from "./runs/researchBriefFiles.js";
import { buildWorkspaceRunRoot } from "./runs/runPaths.js";
import {
  type CreateRunInput,
  RunStore
} from "./runs/runStore.js";
import {
  buildPromotionParentStateSha256,
  type RunPromotionExecutionLease,
  type RunPromotionExecutionState,
  type RunPromotionReservation,
  type RunPromotionTerminalStatus,
  RunPromotionStore
} from "./runs/runPromotionStore.js";
import {
  buildTopicProbeSuccessorLineageManifest,
  hashArtifactBytes,
  serializeTopicProbeSuccessorLineageManifest,
  TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS,
  TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT,
  TOPIC_PROBE_SUCCESSOR_LINEAGE_MANIFEST_RELATIVE_PATH,
  validateTopicProbeSuccessorLineageManifest,
  type TopicProbeSuccessorLineageManifest
} from "./runs/topicProbeSuccessorLineage.js";
import {
  TOPIC_PROBE_FOLLOWUP_HANDOFF_RELATIVE_PATH,
  resolveTopicProbeFollowupEvidenceStage,
  resolveTopicProbeFollowupMode,
  resolveTopicProbeSuccessorRelation,
  validateTopicProbeFollowupHandoff,
  type TopicProbeFollowupEvidenceStage,
  type TopicProbeFollowupHandoff,
  type TopicProbeFollowupMode
} from "./topicProbeFollowup.js";
import type {
  TopicProbeOutcomeDisposition,
  TopicProbeOutcomeNextAction
} from "./topicProbeOutcome.js";
import {
  loadTopicProbeOutcomeArtifacts,
  TOPIC_PROBE_OUTCOME_RELATIVE_PATH
} from "./topicProbeOutcomeArtifacts.js";
import {
  TOPIC_PROBE_REVIEW_GATE_RELATIVE_PATH,
  validateTopicProbeReviewGate,
  type TopicProbeReviewGateArtifact
} from "./topicProbeReviewGate.js";

export const TOPIC_PROBE_FOLLOWUP_RECEIPT_RELATIVE_PATH =
  "review/topic_probe_followup_receipt.json";
export const CHILD_TOPIC_PROBE_GOVERNANCE_ROOT =
  TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT;

export interface TopicProbeFollowupRunReceipt {
  schema_version: 5;
  artifact_kind: "topic_probe_followup_run_receipt";
  relation: RunSuccessorRelation;
  disposition: TopicProbeOutcomeDisposition;
  next_action: TopicProbeOutcomeNextAction;
  parent_run_id: string;
  parent_research_cycle: number;
  child_run_id: string;
  candidate_id: string;
  topic_id: string;
  contract_content_sha256: string;
  source_candidate_content_sha256: string;
  source_portfolio_content_sha256: string;
  route_target_content_sha256: string;
  outcome_content_sha256: string;
  handoff_content_sha256: string;
  review_gate_content_sha256: string;
  research_brief_sha256: string;
  lineage_manifest_content_sha256: string;
  lineage_manifest_file_sha256: string;
  recommended_followup_mode: TopicProbeFollowupMode;
  evidence_stage: TopicProbeFollowupEvidenceStage;
  execution_role: "delegated_once";
  bounded_probe_paper_evidence_allowed: false;
  content_sha256: string;
}

export type TopicProbeFollowupRunStatus =
  | "created"
  | "reused"
  | "not_applicable"
  | "blocked";

export interface TopicProbeFollowupRunResult {
  status: TopicProbeFollowupRunStatus;
  reasons: string[];
  childRun?: RunRecord;
  receipt?: TopicProbeFollowupRunReceipt;
  executionLease?: TopicProbeFollowupExecutionLease;
  terminalState?: RunPromotionExecutionState;
}

export interface TopicProbeFollowupExecutionLease {
  childRunId: string;
  ownerId: string;
  fenceToken: number;
  leaseDurationMs: number;
  leaseExpiresAtMs: number;
}

export type TopicProbeFollowupFaultPoint =
  | "after_reserve"
  | "after_parent_receipt"
  | "after_child_create"
  | "after_child_initialize"
  | "after_claim";

export interface TopicProbeFollowupRunManagerOptions {
  workspaceRoot?: string;
  promotionStore?: RunPromotionStore;
  leaseDurationMs?: number;
  ownerId?: string;
  faultInjector?: (point: TopicProbeFollowupFaultPoint) => void;
}

interface BuildReceiptInput {
  parentRun: RunRecord;
  childRunId: string;
  handoff: TopicProbeFollowupHandoff;
  gate: TopicProbeReviewGateArtifact;
  lineageManifest: TopicProbeSuccessorLineageManifest;
  lineageManifestRaw: string;
}

interface TopicProbeFollowupPromotionPayload {
  schema_version: 3;
  artifact_kind: "topic_probe_followup_promotion_payload";
  receipt: TopicProbeFollowupRunReceipt;
  child_input: CreateRunInput;
  handoff: TopicProbeFollowupHandoff;
  gate: TopicProbeReviewGateArtifact;
  lineage_manifest: TopicProbeSuccessorLineageManifest;
  contract: NonNullable<Awaited<ReturnType<typeof loadTopicProbeOutcomeArtifacts>>["contract"]>;
  outcome: NonNullable<Awaited<ReturnType<typeof loadTopicProbeOutcomeArtifacts>>["decision"]>;
  candidate: NonNullable<Awaited<ReturnType<typeof loadTopicProbeOutcomeArtifacts>>["portfolio"]>["candidates"][number];
  portfolio: NonNullable<Awaited<ReturnType<typeof loadTopicProbeOutcomeArtifacts>>["portfolio"]>;
  extracted_brief: Awaited<ReturnType<typeof extractRunBrief>>;
  brief_completeness: ReturnType<typeof buildBriefCompletenessArtifact>;
  content_sha256: string;
}

const RECEIPT_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "relation",
  "disposition",
  "next_action",
  "parent_run_id",
  "parent_research_cycle",
  "child_run_id",
  "candidate_id",
  "topic_id",
  "contract_content_sha256",
  "source_candidate_content_sha256",
  "source_portfolio_content_sha256",
  "route_target_content_sha256",
  "outcome_content_sha256",
  "handoff_content_sha256",
  "review_gate_content_sha256",
  "research_brief_sha256",
  "lineage_manifest_content_sha256",
  "lineage_manifest_file_sha256",
  "recommended_followup_mode",
  "evidence_stage",
  "execution_role",
  "bounded_probe_paper_evidence_allowed",
  "content_sha256"
]);

export class TopicProbeFollowupRunManager {
  private readonly workspaceRoot: string;
  private readonly promotionStore: RunPromotionStore;
  private readonly leaseDurationMs: number;
  private readonly ownerId: string;
  private readonly faultInjector?: TopicProbeFollowupRunManagerOptions["faultInjector"];

  constructor(
    private readonly runStore: RunStore,
    workspaceRootOrOptions: string | TopicProbeFollowupRunManagerOptions = {}
  ) {
    const options = typeof workspaceRootOrOptions === "string"
      ? { workspaceRoot: workspaceRootOrOptions }
      : workspaceRootOrOptions;
    this.workspaceRoot = options.workspaceRoot ?? runStore.getWorkspaceRoot();
    this.promotionStore = options.promotionStore ?? runStore.getPromotionStore();
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    this.ownerId = options.ownerId ?? randomUUID();
    this.faultInjector = options.faultInjector;
  }

  async consumePromotedFollowup(
    parentReference: RunRecord
  ): Promise<TopicProbeFollowupRunResult> {
    try {
      return await this.consumePromotedFollowupUnchecked(parentReference);
    } catch (error) {
      return {
        status: "blocked",
        reasons: [normalizeErrorCode(error)]
      };
    }
  }

  private async consumePromotedFollowupUnchecked(
    parentReference: RunRecord
  ): Promise<TopicProbeFollowupRunResult> {
    if (path.resolve(this.workspaceRoot) !== path.resolve(process.cwd())) {
      throw new Error("topic_probe_followup_workspace_cwd_mismatch");
    }
    const parentRun = await this.runStore.getRun(parentReference.id);
    if (!parentRun) {
      throw new Error("topic_probe_followup_parent_missing");
    }
    if (parentRun.currentNode !== "review" || parentRun.status !== "paused") {
      return {
        status: "not_applicable",
        reasons: ["topic_probe_followup_parent_not_paused_at_review"]
      };
    }
    if (
      parentRun.graph.currentNode !== "review"
      || parentRun.graph.nodeStates.review.status !== "needs_approval"
      || parentRun.graph.pendingTransition?.action !== "delegate_successor"
      || parentRun.graph.pendingTransition.sourceNode !== "review"
      || parentRun.graph.pendingTransition.autoExecutable !== true
    ) {
      return {
        status: "blocked",
        reasons: ["topic_probe_followup_parent_delegation_not_authorized"]
      };
    }

    const parentRoot = buildWorkspaceRunRoot(this.workspaceRoot, parentRun.id);
    const reportRaw = await readRequiredArtifact(
      path.join(parentRoot, "result_analysis.json"),
      "topic_probe_followup_analysis_report"
    );
    const report = parseAnalysisReport(reportRaw);
    if (!report) {
      throw new Error("topic_probe_followup_analysis_report_invalid");
    }
    const source = await loadTopicProbeOutcomeArtifacts({
      workspaceRoot: this.workspaceRoot,
      runId: parentRun.id,
      expectedResearchCycle: parentRun.graph.researchCycle,
      requireOutcome: true,
      report
    });
    if (
      !source.valid
      || !source.portfolio
      || !source.contract
      || !source.decision
    ) {
      return {
        status: "blocked",
        reasons: source.reasons.length > 0
          ? source.reasons
          : ["topic_probe_followup_source_chain_invalid"]
      };
    }

    const candidates = source.portfolio.candidates.filter(
      (candidate) =>
        candidate.source_candidate_id === source.contract?.candidate_id
        && candidate.topic_id === source.contract?.topic_id
    );
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length === 0
          ? "topic_probe_followup_active_candidate_missing"
          : "topic_probe_followup_active_candidate_ambiguous"
      );
    }
    const candidate = candidates[0];

    const handoffRaw = await readRequiredArtifact(
      path.join(parentRoot, TOPIC_PROBE_FOLLOWUP_HANDOFF_RELATIVE_PATH),
      "topic_probe_followup_handoff"
    );
    const handoffValidation = validateTopicProbeFollowupHandoff(handoffRaw, {
      portfolio: source.portfolio,
      contract: source.contract,
      outcome: source.decision,
      candidate,
      expectedRunId: parentRun.id,
      expectedResearchCycle: parentRun.graph.researchCycle
    });
    if (!handoffValidation.valid || !handoffValidation.handoff) {
      return {
        status: "blocked",
        reasons: handoffValidation.reasons.length > 0
          ? handoffValidation.reasons
          : ["topic_probe_followup_handoff_invalid"]
      };
    }
    const handoff = handoffValidation.handoff;

    const gateRaw = await readRequiredArtifact(
      path.join(parentRoot, TOPIC_PROBE_REVIEW_GATE_RELATIVE_PATH),
      "topic_probe_followup_review_gate"
    );
    const gateValidation = validateTopicProbeReviewGate(gateRaw, {
      runId: parentRun.id,
      researchCycle: parentRun.graph.researchCycle,
      outcome: source.decision,
      handoff,
      validationReasons: []
    });
    if (!gateValidation.valid || !gateValidation.gate) {
      return {
        status: "blocked",
        reasons: gateValidation.reasons.length > 0
          ? gateValidation.reasons
          : ["topic_probe_followup_review_gate_invalid"]
      };
    }
    const gate = gateValidation.gate;
    if (
      gate.status !== "followup_required"
      || gate.paper_drafting_allowed !== false
    ) {
      throw new Error("topic_probe_followup_review_gate_not_authorized");
    }

    const relation = resolveTopicProbeSuccessorRelation(
      source.decision.next_action
    );
    const expectedMode = resolveTopicProbeFollowupMode(
      source.decision.next_action
    );
    const expectedEvidenceStage = resolveTopicProbeFollowupEvidenceStage(
      source.decision.disposition,
      source.decision.next_action
    );
    if (
      handoff.recommended_followup_mode !== expectedMode
      || handoff.evidence_stage !== expectedEvidenceStage
    ) {
      throw new Error("topic_probe_followup_route_handoff_mismatch");
    }

    const briefValidation = validateResearchBriefMarkdown(
      handoff.research_brief_markdown
    );
    const completeness = {
      ...buildBriefCompletenessArtifact(handoff.research_brief_markdown),
      generated_at: parentRun.createdAt
    };
    if (briefValidation.errors.length > 0 || completeness.grade !== "complete") {
      throw new Error("topic_probe_followup_research_brief_incomplete");
    }
    if (
      parseResearchRunMode(handoff.research_brief_markdown)
      !== handoff.recommended_followup_mode
    ) {
      throw new Error("topic_probe_followup_research_mode_invalid");
    }
    const extracted = await extractRunBrief({
      brief: handoff.research_brief_markdown,
      defaults: {
        topic: source.contract.statement,
        constraints: [source.contract.local_budget],
        objectiveMetric: source.contract.objective_raw
      }
    });
    const objectiveSection = parseMarkdownRunBriefSections(
      handoff.research_brief_markdown
    )?.objectiveMetric;
    const contractBoundExperimentRoute =
      source.decision.next_action === "start_confirmatory_run"
      || source.decision.next_action === "repeat_bounded_probe"
      || source.decision.next_action === "repair_probe_evidence";
    if (
      (source.decision.next_action === "start_confirmatory_run"
        && extracted.topic !== source.contract.statement)
      || (contractBoundExperimentRoute
        && !objectiveSection?.includes(source.contract.objective_raw))
    ) {
      throw new Error("topic_probe_followup_brief_contract_projection_mismatch");
    }
    const governedExtracted = extracted;

    const childRunId = buildTopicProbeFollowupRunId(
      parentRun.id,
      parentRun.graph.researchCycle,
      relation,
      source.decision.content_sha256
    );
    const childInput: CreateRunInput = {
      title: buildFollowupRunTitle(
        source.contract.statement,
        source.decision.next_action
      ),
      topic: governedExtracted.topic,
      constraints: governedExtracted.constraints,
      objectiveMetric: governedExtracted.objectiveMetric
    };
    const lineageManifest = buildTopicProbeSuccessorLineageManifest({
      relation,
      disposition: source.decision.disposition,
      nextAction: source.decision.next_action,
      recommendedFollowupMode: handoff.recommended_followup_mode,
      evidenceStage: handoff.evidence_stage,
      parentRunId: parentRun.id,
      parentResearchCycle: parentRun.graph.researchCycle,
      childRunId,
      sourceBrief: {
        raw: handoff.research_brief_markdown,
        contentSha256: hashCanonical(handoff.research_brief_markdown)
      },
      activeContract: toLineageArtifactSource(source.contract),
      sourceCandidate: toLineageArtifactSource(candidate),
      sourcePortfolio: toLineageArtifactSource(source.portfolio),
      handoff: toLineageArtifactSource(handoff),
      boundedOutcome: toLineageArtifactSource(source.decision),
      reviewGate: toLineageArtifactSource(gate)
    });
    const lineageManifestRaw =
      serializeTopicProbeSuccessorLineageManifest(lineageManifest);
    const receipt = buildTopicProbeFollowupRunReceipt({
      parentRun,
      childRunId,
      handoff,
      gate,
      lineageManifest,
      lineageManifestRaw
    });
    const proposedPayload = buildTopicProbeFollowupPromotionPayload({
      receipt,
      childInput,
      handoff,
      gate,
      lineageManifest,
      contract: source.contract,
      outcome: source.decision,
      candidate,
      portfolio: source.portfolio,
      extracted: governedExtracted,
      completeness
    });
    const reserveResult = this.promotionStore.reserveOrLoad({
      parentRunId: parentRun.id,
      parentResearchCycle: parentRun.graph.researchCycle,
      relation,
      outcomeContentSha256: source.decision.content_sha256,
      childRunId,
      receiptContentSha256: receipt.content_sha256,
      receiptJson: `${JSON.stringify(receipt, null, 2)}\n`,
      immutablePayloadJson: `${JSON.stringify(proposedPayload, null, 2)}\n`,
      expectedParentStateSha256: buildPromotionParentStateSha256(parentRun),
      expectedCheckpointSeq: parentRun.graph.checkpointSeq
    });
    this.faultInjector?.("after_reserve");

    const immutable = parseTopicProbeFollowupPromotionPayload(
      reserveResult.reservation.immutablePayloadJson,
      reserveResult.reservation
    );
    const persistedParent = await this.runStore.getRun(parentRun.id);
    if (!persistedParent) {
      throw new Error("topic_probe_followup_parent_missing_after_reserve");
    }
    if (
      buildPromotionParentStateSha256(persistedParent)
      !== reserveResult.reservation.parentStateSha256
    ) {
      throw new Error("topic_probe_followup_parent_state_changed_after_reserve");
    }

    await writeOrValidateArtifact({
      workspaceRoot: this.workspaceRoot,
      run: persistedParent,
      relativePath: TOPIC_PROBE_FOLLOWUP_RECEIPT_RELATIVE_PATH,
      expectedContent: reserveResult.reservation.receiptJson,
      allowWrite: true,
      mismatchCode: "topic_probe_followup_parent_receipt_mismatch"
    });
    this.faultInjector?.("after_parent_receipt");

    const existingChild = await this.runStore.getRun(childRunId);
    const lineage = buildPromotionLineage(immutable.receipt);
    const childRun = await this.runStore.createRun(immutable.child_input, {
      deterministicId: childRunId,
      executionRole: "delegated_once",
      promotionLineage: lineage
    });
    this.faultInjector?.("after_child_create");

    await initializeOrValidateChildRun({
      workspaceRoot: this.workspaceRoot,
      childRun,
      parentRun: persistedParent,
      source: {
        contract: immutable.contract,
        outcome: immutable.outcome,
        candidate: immutable.candidate,
        portfolio: immutable.portfolio,
        gate: immutable.gate,
        handoff: immutable.handoff,
        receipt: immutable.receipt,
        lineageManifest: immutable.lineage_manifest
      },
      extracted: immutable.extracted_brief,
      completeness: immutable.brief_completeness
    });
    this.faultInjector?.("after_child_initialize");

    const preClaimParent = await this.runStore.getRun(parentRun.id);
    if (
      !preClaimParent
      || buildPromotionParentStateSha256(preClaimParent)
        !== reserveResult.reservation.parentStateSha256
    ) {
      throw new Error("topic_probe_followup_parent_state_changed_before_claim");
    }
    await revalidatePromotionSourceBeforeClaim({
      workspaceRoot: this.workspaceRoot,
      parentRun: preClaimParent,
      expectedOutcomeContentSha256:
        reserveResult.reservation.outcomeContentSha256
    });
    const claim = this.promotionStore.claimExecution({
      childRunId,
      ownerId: this.ownerId,
      leaseDurationMs: this.leaseDurationMs
    });
    if (claim.status === "busy") {
      return {
        status: "blocked",
        reasons: ["topic_probe_followup_execution_lease_busy"],
        childRun,
        receipt: immutable.receipt
      };
    }
    if (claim.status === "terminal") {
      const childExecutionComplete = childRun.status === "completed"
        || childRun.delegatedSuccessor?.state === "delegated";
      if (claim.state.status !== "completed" || !childExecutionComplete) {
        return {
          status: "blocked",
          reasons: [
            `topic_probe_followup_execution_already_terminal:${claim.state.status}`
          ],
          childRun,
          receipt: immutable.receipt,
          terminalState: claim.state
        };
      }
      return {
        status: "reused",
        reasons: [],
        childRun,
        receipt: immutable.receipt,
        terminalState: claim.state
      };
    }

    const executionLease = toFollowupLease(
      claim.lease,
      this.leaseDurationMs
    );
    if (
      childRun.status === "completed"
      || childRun.delegatedSuccessor?.state === "delegated"
    ) {
      const terminalState = this.promotionStore.markTerminal({
        childRunId,
        ownerId: executionLease.ownerId,
        fenceToken: executionLease.fenceToken,
        status: "completed",
        detail: childRun.status === "completed"
          ? "delegated_once child was already completed at claim"
          : "delegated_once child had already delegated its successor at claim"
      });
      return {
        status: "reused",
        reasons: [],
        childRun,
        receipt: immutable.receipt,
        terminalState
      };
    }
    this.faultInjector?.("after_claim");

    return {
      status: existingChild ? "reused" : "created",
      reasons: [],
      childRun,
      receipt: immutable.receipt,
      executionLease
    };
  }

  async heartbeatExecution(
    lease: TopicProbeFollowupExecutionLease
  ): Promise<TopicProbeFollowupExecutionLease> {
    return toFollowupLease(
      this.promotionStore.heartbeat({
        childRunId: lease.childRunId,
        ownerId: lease.ownerId,
        fenceToken: lease.fenceToken,
        leaseDurationMs: lease.leaseDurationMs
      }),
      lease.leaseDurationMs
    );
  }

  async markExecutionTerminal(
    lease: TopicProbeFollowupExecutionLease,
    status: RunPromotionTerminalStatus,
    detail?: string
  ): Promise<RunPromotionExecutionState> {
    return this.promotionStore.markTerminal({
      childRunId: lease.childRunId,
      ownerId: lease.ownerId,
      fenceToken: lease.fenceToken,
      status,
      detail
    });
  }
}

export function buildTopicProbeFollowupRunId(
  parentRunId: string,
  parentResearchCycle: number,
  relation: RunSuccessorRelation,
  outcomeContentSha256: string
): string {
  const digest = createHash("sha256")
    .update("autolabos-topic-probe-followup-v3\0")
    .update(parentRunId)
    .update("\0")
    .update(String(parentResearchCycle))
    .update("\0")
    .update(relation)
    .update("\0")
    .update(outcomeContentSha256)
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join("-");
}

export function buildTopicProbeFollowupRunReceipt(
  input: BuildReceiptInput
): TopicProbeFollowupRunReceipt {
  assertReceiptManifestBindings(input);
  const payload: Omit<TopicProbeFollowupRunReceipt, "content_sha256"> = {
    schema_version: 5,
    artifact_kind: "topic_probe_followup_run_receipt",
    relation: input.lineageManifest.relation,
    disposition: input.handoff.disposition,
    next_action: input.handoff.next_action,
    parent_run_id: input.parentRun.id,
    parent_research_cycle: input.parentRun.graph.researchCycle,
    child_run_id: input.childRunId,
    candidate_id: input.handoff.candidate_id,
    topic_id: input.handoff.topic_id,
    contract_content_sha256: input.handoff.contract_content_sha256,
    source_candidate_content_sha256:
      input.handoff.candidate_content_sha256,
    source_portfolio_content_sha256:
      input.handoff.source_portfolio_content_sha256,
    route_target_content_sha256: input.handoff.route_target.content_sha256,
    outcome_content_sha256: input.handoff.outcome_content_sha256,
    handoff_content_sha256: input.handoff.content_sha256,
    review_gate_content_sha256: input.gate.content_sha256,
    research_brief_sha256: hashCanonical(input.handoff.research_brief_markdown),
    lineage_manifest_content_sha256: input.lineageManifest.content_sha256,
    lineage_manifest_file_sha256: hashArtifactBytes(input.lineageManifestRaw),
    recommended_followup_mode: input.handoff.recommended_followup_mode,
    evidence_stage: input.handoff.evidence_stage,
    execution_role: "delegated_once",
    bounded_probe_paper_evidence_allowed: false
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function assertReceiptManifestBindings(input: BuildReceiptInput): void {
  const manifestValidation = validateTopicProbeSuccessorLineageManifest(
    input.lineageManifestRaw
  );
  if (
    !manifestValidation.valid
    || !manifestValidation.manifest
    || !valuesEqual(manifestValidation.manifest, input.lineageManifest)
  ) {
    throw new Error("topic_probe_followup_lineage_manifest_invalid");
  }
  const manifest = input.lineageManifest;
  if (
    manifest.parent_run_id !== input.parentRun.id
    || manifest.parent_research_cycle
      !== input.parentRun.graph.researchCycle
    || manifest.child_run_id !== input.childRunId
    || manifest.disposition !== input.handoff.disposition
    || manifest.next_action !== input.handoff.next_action
    || manifest.recommended_followup_mode
      !== input.handoff.recommended_followup_mode
    || manifest.evidence_stage !== input.handoff.evidence_stage
    || manifest.relation
      !== resolveTopicProbeSuccessorRelation(input.handoff.next_action)
    || manifest.active_contract.content_sha256
      !== input.handoff.contract_content_sha256
    || manifest.source_candidate.content_sha256
      !== input.handoff.candidate_content_sha256
    || manifest.source_portfolio.content_sha256
      !== input.handoff.source_portfolio_content_sha256
    || manifest.handoff.content_sha256 !== input.handoff.content_sha256
    || manifest.bounded_outcome.content_sha256
      !== input.handoff.outcome_content_sha256
    || manifest.review_gate.content_sha256 !== input.gate.content_sha256
    || manifest.source_brief.content_sha256
      !== hashCanonical(input.handoff.research_brief_markdown)
  ) {
    throw new Error("topic_probe_followup_lineage_manifest_binding_mismatch");
  }
}

export function validateTopicProbeFollowupRunReceipt(
  raw: string,
  expected?: TopicProbeFollowupRunReceipt
): { measured: boolean; valid: boolean; reasons: string[]; receipt?: TopicProbeFollowupRunReceipt } {
  if (!raw.trim()) {
    return { measured: false, valid: false, reasons: ["topic_probe_followup_receipt_missing"] };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { measured: true, valid: false, reasons: ["topic_probe_followup_receipt_invalid_json"] };
  }
  if (!isTopicProbeFollowupRunReceipt(value)) {
    return { measured: true, valid: false, reasons: ["topic_probe_followup_receipt_schema_invalid"] };
  }
  const reasons: string[] = [];
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("topic_probe_followup_receipt_content_hash_mismatch");
  }
  if (expected) {
    for (const field of Object.keys(expected) as Array<keyof TopicProbeFollowupRunReceipt>) {
      if (!valuesEqual(value[field], expected[field])) {
        reasons.push(`topic_probe_followup_receipt_expected_field_mismatch:${String(field)}`);
      }
    }
  }
  return {
    measured: true,
    valid: reasons.length === 0,
    reasons,
    receipt: value
  };
}

function buildTopicProbeFollowupPromotionPayload(input: {
  receipt: TopicProbeFollowupRunReceipt;
  childInput: CreateRunInput;
  handoff: TopicProbeFollowupHandoff;
  gate: TopicProbeReviewGateArtifact;
  lineageManifest: TopicProbeSuccessorLineageManifest;
  contract: TopicProbeFollowupPromotionPayload["contract"];
  outcome: TopicProbeFollowupPromotionPayload["outcome"];
  candidate: TopicProbeFollowupPromotionPayload["candidate"];
  portfolio: TopicProbeFollowupPromotionPayload["portfolio"];
  extracted: TopicProbeFollowupPromotionPayload["extracted_brief"];
  completeness: TopicProbeFollowupPromotionPayload["brief_completeness"];
}): TopicProbeFollowupPromotionPayload {
  const payload: Omit<TopicProbeFollowupPromotionPayload, "content_sha256"> = {
    schema_version: 3,
    artifact_kind: "topic_probe_followup_promotion_payload",
    receipt: input.receipt,
    child_input: input.childInput,
    handoff: input.handoff,
    gate: input.gate,
    lineage_manifest: input.lineageManifest,
    contract: input.contract,
    outcome: input.outcome,
    candidate: input.candidate,
    portfolio: input.portfolio,
    extracted_brief: input.extracted,
    brief_completeness: input.completeness
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function parseTopicProbeFollowupPromotionPayload(
  raw: string,
  reservation: RunPromotionReservation
): TopicProbeFollowupPromotionPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("topic_probe_followup_promotion_payload_invalid_json");
  }
  if (
    !isRecord(value)
    || value.schema_version !== 3
    || value.artifact_kind !== "topic_probe_followup_promotion_payload"
    || !isTopicProbeFollowupRunReceipt(value.receipt)
    || !isRecord(value.child_input)
    || !isRecord(value.handoff)
    || !isRecord(value.handoff.route_target)
    || !isRecord(value.gate)
    || !isRecord(value.lineage_manifest)
    || !isRecord(value.contract)
    || !isRecord(value.outcome)
    || !isRecord(value.candidate)
    || !isRecord(value.portfolio)
    || !isRecord(value.extracted_brief)
    || !isRecord(value.brief_completeness)
    || !isSha256(value.content_sha256)
  ) {
    throw new Error("topic_probe_followup_promotion_payload_schema_invalid");
  }
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    throw new Error("topic_probe_followup_promotion_payload_hash_mismatch");
  }
  if (
    value.receipt.parent_run_id !== reservation.parentRunId
    || value.receipt.parent_research_cycle
      !== reservation.parentResearchCycle
    || value.receipt.child_run_id !== reservation.childRunId
    || value.receipt.outcome_content_sha256
      !== reservation.outcomeContentSha256
    || value.receipt.content_sha256
      !== reservation.receiptContentSha256
    || value.receipt.relation !== reservation.relation
  ) {
    throw new Error("topic_probe_followup_promotion_payload_identity_mismatch");
  }
  const receiptValidation = validateTopicProbeFollowupRunReceipt(
    reservation.receiptJson,
    value.receipt
  );
  if (!receiptValidation.valid) {
    throw new Error(
      `topic_probe_followup_promotion_receipt_invalid:${receiptValidation.reasons[0] || "unknown"}`
    );
  }
  const lineageManifestRaw = serializeTopicProbeSuccessorLineageManifest(
    value.lineage_manifest as unknown as TopicProbeSuccessorLineageManifest
  );
  const lineageManifestValidation =
    validateTopicProbeSuccessorLineageManifest(lineageManifestRaw);
  if (
    !lineageManifestValidation.valid
    || !lineageManifestValidation.manifest
  ) {
    throw new Error(
      `topic_probe_followup_promotion_lineage_manifest_invalid:${lineageManifestValidation.reasons[0] || "unknown"}`
    );
  }
  const lineageManifest = lineageManifestValidation.manifest;
  if (
    lineageManifest.parent_run_id !== value.receipt.parent_run_id
    || lineageManifest.parent_research_cycle
      !== value.receipt.parent_research_cycle
    || lineageManifest.child_run_id !== value.receipt.child_run_id
    || lineageManifest.relation !== value.receipt.relation
    || lineageManifest.disposition !== value.receipt.disposition
    || lineageManifest.next_action !== value.receipt.next_action
    || lineageManifest.recommended_followup_mode
      !== value.receipt.recommended_followup_mode
    || lineageManifest.evidence_stage !== value.receipt.evidence_stage
    || value.handoff.disposition !== value.receipt.disposition
    || value.handoff.next_action !== value.receipt.next_action
    || value.handoff.recommended_followup_mode
      !== value.receipt.recommended_followup_mode
    || value.handoff.evidence_stage !== value.receipt.evidence_stage
    || value.handoff.content_sha256
      !== value.receipt.handoff_content_sha256
    || value.gate.content_sha256
      !== value.receipt.review_gate_content_sha256
    || value.contract.content_sha256
      !== value.receipt.contract_content_sha256
    || value.outcome.content_sha256
      !== value.receipt.outcome_content_sha256
    || value.candidate.content_sha256
      !== value.handoff.candidate_content_sha256
    || value.portfolio.content_sha256
      !== value.receipt.source_portfolio_content_sha256
    || value.handoff.source_portfolio_content_sha256
      !== value.receipt.source_portfolio_content_sha256
    || value.handoff.route_target.content_sha256
      !== value.receipt.route_target_content_sha256
    || hashCanonical(value.handoff.research_brief_markdown)
      !== value.receipt.research_brief_sha256
    || lineageManifest.content_sha256
      !== value.receipt.lineage_manifest_content_sha256
    || hashArtifactBytes(lineageManifestRaw)
      !== value.receipt.lineage_manifest_file_sha256
    || lineageManifest.active_contract.content_sha256
      !== value.receipt.contract_content_sha256
    || lineageManifest.source_candidate.content_sha256
      !== value.receipt.source_candidate_content_sha256
    || lineageManifest.source_portfolio.content_sha256
      !== value.receipt.source_portfolio_content_sha256
    || lineageManifest.handoff.content_sha256
      !== value.receipt.handoff_content_sha256
    || lineageManifest.bounded_outcome.content_sha256
      !== value.receipt.outcome_content_sha256
    || lineageManifest.review_gate.content_sha256
      !== value.receipt.review_gate_content_sha256
    || lineageManifest.source_brief.content_sha256
      !== value.receipt.research_brief_sha256
  ) {
    throw new Error("topic_probe_followup_promotion_payload_binding_mismatch");
  }
  if (
    !hasText(value.child_input.title)
    || !hasText(value.child_input.topic)
    || !Array.isArray(value.child_input.constraints)
    || !value.child_input.constraints.every(hasText)
    || !hasText(value.child_input.objectiveMetric)
  ) {
    throw new Error("topic_probe_followup_promotion_child_input_invalid");
  }
  return value as unknown as TopicProbeFollowupPromotionPayload;
}

function buildPromotionLineage(
  receipt: TopicProbeFollowupRunReceipt
): RunPromotionLineage {
  return {
    schemaVersion: 1,
    relation: receipt.relation,
    parentRunId: receipt.parent_run_id,
    parentResearchCycle: receipt.parent_research_cycle,
    outcomeContentSha256: receipt.outcome_content_sha256,
    receiptContentSha256: receipt.content_sha256
  };
}

function toFollowupLease(
  lease: RunPromotionExecutionLease,
  leaseDurationMs: number
): TopicProbeFollowupExecutionLease {
  return {
    childRunId: lease.childRunId,
    ownerId: lease.ownerId,
    fenceToken: lease.fenceToken,
    leaseDurationMs,
    leaseExpiresAtMs: lease.leaseExpiresAtMs
  };
}

async function revalidatePromotionSourceBeforeClaim(input: {
  workspaceRoot: string;
  parentRun: RunRecord;
  expectedOutcomeContentSha256: string;
}): Promise<void> {
  const parentRoot = buildWorkspaceRunRoot(
    input.workspaceRoot,
    input.parentRun.id
  );
  const reportRaw = await readRequiredArtifact(
    path.join(parentRoot, "result_analysis.json"),
    "topic_probe_followup_preclaim_analysis_report"
  );
  const report = parseAnalysisReport(reportRaw);
  if (!report) {
    throw new Error("topic_probe_followup_preclaim_analysis_report_invalid");
  }
  const source = await loadTopicProbeOutcomeArtifacts({
    workspaceRoot: input.workspaceRoot,
    runId: input.parentRun.id,
    expectedResearchCycle: input.parentRun.graph.researchCycle,
    requireOutcome: true,
    report
  });
  if (
    !source.valid
    || !source.portfolio
    || !source.contract
    || !source.decision
  ) {
    throw new Error(
      `topic_probe_followup_preclaim_source_chain_invalid:${source.reasons[0] || "unknown"}`
    );
  }
  if (source.decision.content_sha256 !== input.expectedOutcomeContentSha256) {
    throw new Error("topic_probe_followup_preclaim_outcome_identity_changed");
  }
  const candidates = source.portfolio.candidates.filter(
    (candidate) =>
      candidate.source_candidate_id === source.contract?.candidate_id
      && candidate.topic_id === source.contract?.topic_id
  );
  if (candidates.length !== 1) {
    throw new Error("topic_probe_followup_preclaim_candidate_ambiguous");
  }
  const handoffRaw = await readRequiredArtifact(
    path.join(parentRoot, TOPIC_PROBE_FOLLOWUP_HANDOFF_RELATIVE_PATH),
    "topic_probe_followup_preclaim_handoff"
  );
  const handoffValidation = validateTopicProbeFollowupHandoff(handoffRaw, {
    portfolio: source.portfolio,
    contract: source.contract,
    outcome: source.decision,
    candidate: candidates[0],
    expectedRunId: input.parentRun.id,
    expectedResearchCycle: input.parentRun.graph.researchCycle
  });
  if (!handoffValidation.valid || !handoffValidation.handoff) {
    throw new Error(
      `topic_probe_followup_preclaim_handoff_invalid:${handoffValidation.reasons[0] || "unknown"}`
    );
  }
  const gateRaw = await readRequiredArtifact(
    path.join(parentRoot, TOPIC_PROBE_REVIEW_GATE_RELATIVE_PATH),
    "topic_probe_followup_preclaim_review_gate"
  );
  const gateValidation = validateTopicProbeReviewGate(gateRaw, {
    runId: input.parentRun.id,
    researchCycle: input.parentRun.graph.researchCycle,
    outcome: source.decision,
    handoff: handoffValidation.handoff,
    validationReasons: []
  });
  if (
    !gateValidation.valid
    || gateValidation.gate?.status !== "followup_required"
    || gateValidation.gate.paper_drafting_allowed !== false
  ) {
    throw new Error(
      `topic_probe_followup_preclaim_review_gate_invalid:${gateValidation.reasons[0] || "unauthorized"}`
    );
  }
}

async function initializeOrValidateChildRun(input: {
  workspaceRoot: string;
  childRun: RunRecord;
  parentRun: RunRecord;
  source: {
    contract: NonNullable<Awaited<ReturnType<typeof loadTopicProbeOutcomeArtifacts>>["contract"]>;
    outcome: NonNullable<Awaited<ReturnType<typeof loadTopicProbeOutcomeArtifacts>>["decision"]>;
    candidate: NonNullable<Awaited<ReturnType<typeof loadTopicProbeOutcomeArtifacts>>["portfolio"]>["candidates"][number];
    portfolio: NonNullable<Awaited<ReturnType<typeof loadTopicProbeOutcomeArtifacts>>["portfolio"]>;
    gate: TopicProbeReviewGateArtifact;
    handoff: TopicProbeFollowupHandoff;
    receipt: TopicProbeFollowupRunReceipt;
    lineageManifest: TopicProbeSuccessorLineageManifest;
  };
  extracted: Awaited<ReturnType<typeof extractRunBrief>>;
  completeness: ReturnType<typeof buildBriefCompletenessArtifact>;
}): Promise<void> {
  const pristine = isPristineRun(input.childRun);
  const governanceRoot = CHILD_TOPIC_PROBE_GOVERNANCE_ROOT;
  const expectedFiles: Array<[string, string, string]> = [
    [
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourceBrief,
      input.source.handoff.research_brief_markdown,
      "topic_probe_followup_child_brief_mismatch"
    ],
    [
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.handoff,
      `${JSON.stringify(input.source.handoff, null, 2)}\n`,
      "topic_probe_followup_child_handoff_mismatch"
    ],
    [
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.reviewGate,
      `${JSON.stringify(input.source.gate, null, 2)}\n`,
      "topic_probe_followup_child_gate_mismatch"
    ],
    [
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.receipt,
      `${JSON.stringify(input.source.receipt, null, 2)}\n`,
      "topic_probe_followup_child_receipt_mismatch"
    ],
    [
      TOPIC_PROBE_SUCCESSOR_LINEAGE_MANIFEST_RELATIVE_PATH,
      serializeTopicProbeSuccessorLineageManifest(
        input.source.lineageManifest
      ),
      "topic_probe_followup_child_lineage_manifest_mismatch"
    ],
    [
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.activeContract,
      `${JSON.stringify(input.source.contract, null, 2)}\n`,
      "topic_probe_followup_child_contract_mismatch"
    ],
    [
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.boundedOutcome,
      `${JSON.stringify(input.source.outcome, null, 2)}\n`,
      "topic_probe_followup_child_outcome_mismatch"
    ],
    [
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourceCandidate,
      `${JSON.stringify(input.source.candidate, null, 2)}\n`,
      "topic_probe_followup_child_candidate_mismatch"
    ],
    [
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourcePortfolio,
      `${JSON.stringify(input.source.portfolio, null, 2)}\n`,
      "topic_probe_followup_child_portfolio_mismatch"
    ]
  ];
  for (const [relativePath, expectedContent, mismatchCode] of expectedFiles) {
    await writeOrValidateArtifact({
      workspaceRoot: input.workspaceRoot,
      run: input.childRun,
      relativePath,
      expectedContent,
      allowWrite: pristine,
      mismatchCode
    });
  }

  const memory = new RunContextMemory(
    path.join(input.workspaceRoot, input.childRun.memoryRefs.runContextPath)
  );
  const memoryItems: Array<[string, unknown]> = [
    ["run_brief.raw", input.source.handoff.research_brief_markdown],
    ["run_brief.extracted", input.extracted],
    ["run_brief.plan_summary", input.extracted.planSummary || null],
    ["run_brief.completeness", input.completeness],
    ["run_brief.source_path", `${governanceRoot}/handoff.json`],
    ["run_brief.snapshot_path", "brief/source_brief.md"],
    ["topic_probe_followup.receipt", input.source.receipt],
    [
      "topic_probe_followup.lineage",
      {
        parent_run_id: input.parentRun.id,
        parent_research_cycle: input.parentRun.graph.researchCycle,
        relation: input.source.receipt.relation,
        disposition: input.source.receipt.disposition,
        next_action: input.source.receipt.next_action,
        recommended_followup_mode:
          input.source.receipt.recommended_followup_mode,
        evidence_stage: input.source.receipt.evidence_stage,
        execution_role: "delegated_once",
        contract_content_sha256: input.source.receipt.contract_content_sha256,
        source_candidate_content_sha256:
          input.source.receipt.source_candidate_content_sha256,
        source_portfolio_content_sha256:
          input.source.receipt.source_portfolio_content_sha256,
        route_target_content_sha256:
          input.source.receipt.route_target_content_sha256,
        outcome_content_sha256: input.source.receipt.outcome_content_sha256,
        receipt_content_sha256: input.source.receipt.content_sha256,
        lineage_manifest_content_sha256:
          input.source.receipt.lineage_manifest_content_sha256,
        lineage_manifest_file_sha256:
          input.source.receipt.lineage_manifest_file_sha256,
        bounded_probe_paper_evidence_allowed: false
      }
    ]
  ];
  for (const [key, expectedValue] of memoryItems) {
    const existingValue = await memory.get<unknown>(key);
    if (existingValue === undefined) {
      if (!pristine) {
        throw new Error(`topic_probe_followup_child_memory_missing:${key}`);
      }
      await memory.put(key, expectedValue);
      continue;
    }
    if (!valuesEqual(existingValue, expectedValue)) {
      throw new Error(`topic_probe_followup_child_memory_mismatch:${key}`);
    }
  }
}

async function writeOrValidateArtifact(input: {
  workspaceRoot: string;
  run: RunRecord;
  relativePath: string;
  expectedContent: string;
  allowWrite: boolean;
  mismatchCode: string;
}): Promise<void> {
  const fullPath = path.join(
    buildWorkspaceRunRoot(input.workspaceRoot, input.run.id),
    input.relativePath
  );
  const existing = await readOptionalArtifact(fullPath, input.relativePath);
  if (existing === undefined) {
    if (!input.allowWrite) {
      throw new Error(`${input.mismatchCode}:missing`);
    }
    await writeRunArtifact(input.run, input.relativePath, input.expectedContent);
    return;
  }
  if (existing !== input.expectedContent) {
    throw new Error(input.mismatchCode);
  }
}

function toLineageArtifactSource(
  artifact: { content_sha256: string }
): { raw: string; contentSha256: string } {
  return {
    raw: `${JSON.stringify(artifact, null, 2)}\n`,
    contentSha256: artifact.content_sha256
  };
}

function isPristineRun(run: RunRecord): boolean {
  return run.status === "pending"
    && run.currentNode === "collect_papers"
    && run.graph.currentNode === "collect_papers"
    && run.graph.checkpointSeq === 0
    && Object.values(run.graph.nodeStates).every((state) => state.status === "pending");
}

async function readRequiredArtifact(
  filePath: string,
  code: string
): Promise<string> {
  const raw = await readOptionalArtifact(filePath, code);
  if (raw === undefined) {
    throw new Error(`${code}_missing`);
  }
  return raw;
}

async function readOptionalArtifact(
  filePath: string,
  label: string
): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw new Error(
      `topic_probe_followup_artifact_read_error:${label}:${readErrorCode(error)?.toLowerCase() || "unknown"}`
    );
  }
}

function buildFollowupRunTitle(
  statement: string,
  nextAction: TopicProbeOutcomeNextAction
): string {
  const normalized = statement.replace(/\s+/gu, " ").trim();
  const prefix: Record<TopicProbeOutcomeNextAction, string> = {
    start_confirmatory_run: "Confirmatory follow-up",
    repeat_bounded_probe: "Bounded-probe repeat",
    try_deferred_candidate: "Deferred-candidate follow-up",
    refresh_topic_portfolio: "Topic-portfolio refresh",
    repair_probe_evidence: "Probe-evidence repair"
  };
  return `${prefix[nextAction]}: ${normalized}`.slice(0, 180);
}

function isTopicProbeFollowupRunReceipt(
  value: unknown
): value is TopicProbeFollowupRunReceipt {
  if (!isRecord(value) || !Object.keys(value).every((field) => RECEIPT_FIELDS.has(field))) {
    return false;
  }
  return value.schema_version === 5
    && value.artifact_kind === "topic_probe_followup_run_receipt"
    && isRunSuccessorRelation(value.relation)
    && isDisposition(value.disposition)
    && isNextAction(value.next_action)
    && hasText(value.parent_run_id)
    && Number.isInteger(value.parent_research_cycle)
    && Number(value.parent_research_cycle) >= 0
    && isUuid(value.child_run_id)
    && hasText(value.candidate_id)
    && hasText(value.topic_id)
    && isSha256(value.contract_content_sha256)
    && isSha256(value.source_candidate_content_sha256)
    && isSha256(value.source_portfolio_content_sha256)
    && isSha256(value.route_target_content_sha256)
    && isSha256(value.outcome_content_sha256)
    && isSha256(value.handoff_content_sha256)
    && isSha256(value.review_gate_content_sha256)
    && isSha256(value.research_brief_sha256)
    && isSha256(value.lineage_manifest_content_sha256)
    && isSha256(value.lineage_manifest_file_sha256)
    && isFollowupMode(value.recommended_followup_mode)
    && isEvidenceStage(value.evidence_stage)
    && value.relation === resolveTopicProbeSuccessorRelation(value.next_action)
    && value.recommended_followup_mode
      === resolveTopicProbeFollowupMode(value.next_action)
    && value.evidence_stage === resolveTopicProbeFollowupEvidenceStage(
      value.disposition,
      value.next_action
    )
    && value.execution_role === "delegated_once"
    && value.bounded_probe_paper_evidence_allowed === false
    && isSha256(value.content_sha256);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRunSuccessorRelation(value: unknown): value is RunSuccessorRelation {
  return value === "topic_probe_confirmatory"
    || value === "topic_probe_repeat"
    || value === "topic_probe_deferred_candidate"
    || value === "topic_probe_portfolio_refresh"
    || value === "topic_probe_evidence_repair";
}

function isDisposition(value: unknown): value is TopicProbeOutcomeDisposition {
  return value === "promote_to_confirmatory"
    || value === "reject_candidate"
    || value === "repeat_probe"
    || value === "blocked_invalid_evidence";
}

function isNextAction(value: unknown): value is TopicProbeOutcomeNextAction {
  return value === "start_confirmatory_run"
    || value === "try_deferred_candidate"
    || value === "refresh_topic_portfolio"
    || value === "repeat_bounded_probe"
    || value === "repair_probe_evidence";
}

function isFollowupMode(value: unknown): value is TopicProbeFollowupMode {
  return value === "hypothesis_test" || value === "topic_discovery";
}

function isEvidenceStage(value: unknown): value is TopicProbeFollowupEvidenceStage {
  return value === "confirmatory"
    || value === "bounded_probe"
    || value === "topic_refresh";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function normalizeErrorCode(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) {
    return "topic_probe_followup_run_manager_error";
  }
  return error.message
    .replace(/[^a-z0-9_:.\/-]+/giu, "_")
    .slice(0, 240);
}
