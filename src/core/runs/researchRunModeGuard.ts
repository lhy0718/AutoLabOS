import path from "node:path";
import { promises as fs } from "node:fs";

import type { RunRecord } from "../../types.js";
import {
  hashCanonical,
  validateTopicDecisionArtifact,
  validateTopicPortfolioArtifact,
  type TopicPortfolio,
  type TopicPortfolioCandidate
} from "../researchFunnel.js";
import {
  validateActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "../activeTopicProbeContract.js";
import {
  TOPIC_PROBE_FOLLOWUP_RECEIPT_RELATIVE_PATH,
  validateTopicProbeFollowupRunReceipt,
  type TopicProbeFollowupRunReceipt
} from "../topicProbeFollowupRun.js";
import {
  validateTopicProbeFollowupHandoff,
  type TopicProbeFollowupHandoff
} from "../topicProbeFollowup.js";
import {
  validateTopicProbeOutcomeDecision,
  type TopicProbeOutcomeDecision
} from "../topicProbeOutcome.js";
import {
  validateTopicProbeReviewGate,
  type TopicProbeReviewGateArtifact
} from "../topicProbeReviewGate.js";
import {
  hashArtifactBytes,
  TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS,
  TOPIC_PROBE_SUCCESSOR_LINEAGE_MANIFEST_RELATIVE_PATH,
  validateTopicProbeSuccessorLineageManifest,
  type TopicProbeSuccessorArtifactBinding,
  type TopicProbeSuccessorLineageManifest
} from "./topicProbeSuccessorLineage.js";

import {
  parseDeclaredResearchRunMode,
  parseMarkdownRunBriefSections,
  type ResearchRunMode
} from "./runBriefParser.js";
import {
  ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH,
  TOPIC_PROBE_DECISION_RELATIVE_PATH,
  TOPIC_PROBE_OUTCOME_RELATIVE_PATH,
  TOPIC_PROBE_PORTFOLIO_RELATIVE_PATH
} from "../topicProbeOutcomeArtifacts.js";
import { TOPIC_PROBE_FOLLOWUP_HANDOFF_RELATIVE_PATH } from "../topicProbeFollowup.js";
import { TOPIC_PROBE_REVIEW_GATE_RELATIVE_PATH } from "../topicProbeReviewGate.js";
import type {
  TopicProbeSuccessorRouteTarget
} from "../topicProbeSuccessorRouteTarget.js";

export type ResearchEvidenceStage =
  | "standard"
  | "bounded_probe"
  | "bounded_probe_successor"
  | "topic_refresh_successor"
  | "confirmatory_followup";

export interface ResearchRunModeGuard {
  declaredMode?: ResearchRunMode;
  snapshotMode?: ResearchRunMode;
  effectiveMode: ResearchRunMode;
  evidenceStage: ResearchEvidenceStage;
  topicProbeLineageDetected: boolean;
  valid: boolean;
  reasons: string[];
  paperDraftingAllowed: boolean;
  successorRouteTarget?: TopicProbeSuccessorRouteTarget;
}

export interface ResolveResearchRunModeGuardInput {
  workspaceRoot: string;
  runId: string;
  rawBrief?: string | null;
  run?: Pick<RunRecord, "id" | "executionRole" | "promotionLineage">;
  expectedResearchCycle?: number;
  requireActiveBoundedProbeLineage?: boolean;
}

const TOPIC_PROBE_PARENT_LINEAGE_PATHS = [
  TOPIC_PROBE_PORTFOLIO_RELATIVE_PATH,
  TOPIC_PROBE_DECISION_RELATIVE_PATH,
  ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH,
  TOPIC_PROBE_OUTCOME_RELATIVE_PATH,
  TOPIC_PROBE_FOLLOWUP_HANDOFF_RELATIVE_PATH,
  TOPIC_PROBE_REVIEW_GATE_RELATIVE_PATH
] as const;

const SUCCESSOR_LINEAGE_PATH =
  TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.receipt;

export async function resolveResearchRunModeGuard(
  input: ResolveResearchRunModeGuardInput
): Promise<ResearchRunModeGuard> {
  const runDir = path.join(
    input.workspaceRoot,
    ".autolabos",
    "runs",
    input.runId
  );
  const snapshot = await loadResearchBriefSnapshot(input.workspaceRoot, input.runId);
  const rawBrief = input.rawBrief?.trim() ? input.rawBrief : undefined;
  const declaredMode = parseMode(rawBrief);
  const snapshotMode = parseMode(snapshot);
  const reasons: string[] = [];
  let successorRouteTarget: TopicProbeSuccessorRouteTarget | undefined;

  if (hasInvalidModeDeclaration(rawBrief)) {
    reasons.push("research_mode_declaration_invalid");
  }
  if (hasInvalidModeDeclaration(snapshot)) {
    reasons.push("research_mode_snapshot_declaration_invalid");
  }
  if (declaredMode && snapshotMode && declaredMode !== snapshotMode) {
    reasons.push("research_mode_source_mismatch");
  }

  const [parentLineagePaths, successorReceiptRaw] = await Promise.all([
    existingRelativePaths(runDir, TOPIC_PROBE_PARENT_LINEAGE_PATHS),
    readOptionalText(path.join(runDir, SUCCESSOR_LINEAGE_PATH))
  ]);
  const parentLineageDetected = parentLineagePaths.length > 0;
  const activeBoundedProbeLineageDetected = parentLineagePaths.includes(
    ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH
  );
  const successorRunDeclared = Boolean(
    input.run?.executionRole === "delegated_once"
    || input.run?.promotionLineage
  );
  const successorLineageDetected = Boolean(successorReceiptRaw) || successorRunDeclared;
  const successorReceiptValidation = successorReceiptRaw
    ? validateTopicProbeFollowupRunReceipt(successorReceiptRaw)
    : undefined;
  const successorReceipt = successorReceiptValidation?.valid
    ? successorReceiptValidation.receipt
    : undefined;

  if (
    parentLineageDetected
    && successorLineageDetected
    && successorReceipt?.evidence_stage === "confirmatory"
  ) {
    reasons.push("research_evidence_lineage_ambiguous");
  }

  const evidenceStage: ResearchEvidenceStage = successorLineageDetected
    ? successorReceipt?.evidence_stage === "confirmatory"
      ? "confirmatory_followup"
      : successorReceipt?.evidence_stage === "topic_refresh"
        ? "topic_refresh_successor"
        : "bounded_probe_successor"
    : parentLineageDetected
      ? "bounded_probe"
      : "standard";
  if (
    input.requireActiveBoundedProbeLineage === true
    && !successorLineageDetected
    && (declaredMode === "topic_discovery" || snapshotMode === "topic_discovery")
    && !activeBoundedProbeLineageDetected
  ) {
    reasons.push("topic_discovery_active_bounded_probe_lineage_missing");
  }
  if (
    input.requireActiveBoundedProbeLineage === true
    && activeBoundedProbeLineageDetected
    && !successorLineageDetected
  ) {
    reasons.push(...await validateBoundedProbeExecutionLineage({
      runDir,
      runId: input.runId,
      expectedResearchCycle: input.expectedResearchCycle
    }));
  }

  if (
    evidenceStage === "bounded_probe"
    || evidenceStage === "bounded_probe_successor"
    || evidenceStage === "topic_refresh_successor"
  ) {
    if (declaredMode && declaredMode !== "topic_discovery") {
      reasons.push("bounded_probe_memory_mode_mismatch");
    }
    if (snapshotMode && snapshotMode !== "topic_discovery") {
      reasons.push("bounded_probe_snapshot_mode_mismatch");
    }
    if (!declaredMode && !snapshotMode) {
      reasons.push("bounded_probe_research_mode_missing");
    }
  }

  if (successorLineageDetected) {
    const expectedMode = successorReceipt?.recommended_followup_mode;
    if (!expectedMode || declaredMode !== expectedMode) {
      reasons.push("successor_followup_memory_mode_invalid");
    }
    if (!expectedMode || snapshotMode !== expectedMode) {
      reasons.push("successor_followup_snapshot_mode_invalid");
    }
    const successorBinding = await validateSuccessorReceiptBinding({
      workspaceRoot: input.workspaceRoot,
      runDir,
      runId: input.runId,
      run: input.run,
      rawBrief,
      snapshot
    });
    reasons.push(...successorBinding.reasons);
    successorRouteTarget = successorBinding.routeTarget;
  }

  const effectiveMode =
    evidenceStage === "bounded_probe"
      ? "topic_discovery"
      : successorReceipt?.recommended_followup_mode
        ?? declaredMode
        ?? snapshotMode
        ?? "hypothesis_test";
  const topicProbeLineageDetected =
    evidenceStage !== "standard" || effectiveMode === "topic_discovery";
  const valid = reasons.length === 0;

  return {
    declaredMode,
    snapshotMode,
    effectiveMode,
    evidenceStage,
    topicProbeLineageDetected,
    valid,
    reasons,
    ...(successorRouteTarget ? { successorRouteTarget } : {}),
    paperDraftingAllowed:
      valid
      && evidenceStage !== "bounded_probe"
      && evidenceStage !== "bounded_probe_successor"
      && evidenceStage !== "topic_refresh_successor"
      && effectiveMode !== "topic_discovery"
  };
}

async function validateBoundedProbeExecutionLineage(input: {
  runDir: string;
  runId: string;
  expectedResearchCycle?: number;
}): Promise<string[]> {
  const [portfolioRaw, decisionRaw, activeProbeRaw] = await Promise.all([
    readOptionalText(path.join(input.runDir, TOPIC_PROBE_PORTFOLIO_RELATIVE_PATH)),
    readOptionalText(path.join(input.runDir, TOPIC_PROBE_DECISION_RELATIVE_PATH)),
    readOptionalText(path.join(input.runDir, ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH))
  ]);
  const context = {
    expectedRunId: input.runId,
    ...(input.expectedResearchCycle !== undefined
      ? { expectedResearchCycle: input.expectedResearchCycle }
      : {})
  };
  const portfolioValidation = validateTopicPortfolioArtifact(
    portfolioRaw ?? "",
    context
  );
  const decisionValidation = validateTopicDecisionArtifact(
    decisionRaw ?? "",
    portfolioValidation,
    context
  );
  const activeProbeValidation = validateActiveTopicProbeContract(
    activeProbeRaw ?? "",
    {
      ...context,
      ...(portfolioValidation.valid && portfolioValidation.portfolio
        ? { portfolio: portfolioValidation.portfolio }
        : {})
    }
  );
  const reasons = [
    ...prefixReasons(
      "bounded_probe_execution_portfolio_invalid",
      portfolioValidation.reasons
    ),
    ...prefixReasons(
      "bounded_probe_execution_decision_invalid",
      decisionValidation.reasons
    ),
    ...prefixReasons(
      "bounded_probe_execution_active_contract_invalid",
      activeProbeValidation.reasons
    )
  ];
  if (
    decisionValidation.valid
    && (
      decisionValidation.decision?.disposition !== "probe_authorized"
      || decisionValidation.decision.probe_allowed !== true
    )
  ) {
    reasons.push("bounded_probe_execution_not_authorized");
  }
  return [...new Set(reasons)];
}

async function validateSuccessorReceiptBinding(input: {
  workspaceRoot: string;
  runDir: string;
  runId: string;
  run?: Pick<RunRecord, "id" | "executionRole" | "promotionLineage">;
  rawBrief?: string;
  snapshot?: string;
}): Promise<{
  reasons: string[];
  routeTarget?: TopicProbeSuccessorRouteTarget;
}> {
  const reasons: string[] = [];
  const receiptRaw = await readOptionalText(
    path.join(input.runDir, SUCCESSOR_LINEAGE_PATH)
  );
  if (!receiptRaw) {
    return { reasons: ["successor_followup_receipt_missing"] };
  }
  const receiptValidation = validateTopicProbeFollowupRunReceipt(receiptRaw);
  if (!receiptValidation.valid || !receiptValidation.receipt) {
    return {
      reasons: receiptValidation.reasons.map((reason) =>
        `successor_followup_${reason}`
      )
    };
  }
  const receipt = receiptValidation.receipt;
  const run = input.run;
  if (!run) {
    reasons.push("successor_followup_run_record_missing");
  } else {
    if (run.id !== input.runId || receipt.child_run_id !== input.runId) {
      reasons.push("successor_followup_child_run_id_mismatch");
    }
    if (run.executionRole !== "delegated_once") {
      reasons.push("successor_followup_execution_role_invalid");
    }
    reasons.push(...compareReceiptToRunLineage(receipt, run.promotionLineage));
  }
  if (!input.snapshot || hashCanonical(input.snapshot) !== receipt.research_brief_sha256) {
    reasons.push("successor_followup_snapshot_hash_mismatch");
  }
  if (input.rawBrief && hashCanonical(input.rawBrief) !== receipt.research_brief_sha256) {
    reasons.push("successor_followup_memory_brief_hash_mismatch");
  }

  const parentReceiptRaw = await readOptionalText(path.join(
    input.workspaceRoot,
    ".autolabos",
    "runs",
    receipt.parent_run_id,
    TOPIC_PROBE_FOLLOWUP_RECEIPT_RELATIVE_PATH
  ));
  if (!parentReceiptRaw) {
    reasons.push("successor_followup_parent_promotion_receipt_missing");
  } else {
    const parentReceiptValidation = validateTopicProbeFollowupRunReceipt(
      parentReceiptRaw,
      receipt
    );
    if (!parentReceiptValidation.valid) {
      reasons.push(...parentReceiptValidation.reasons.map((reason) =>
        `successor_followup_parent_promotion_${reason}`
      ));
    }
    if (hashArtifactBytes(parentReceiptRaw) !== hashArtifactBytes(receiptRaw)) {
      reasons.push("successor_followup_parent_promotion_receipt_bytes_mismatch");
    }
  }

  const manifestRaw = await readOptionalText(path.join(
    input.runDir,
    TOPIC_PROBE_SUCCESSOR_LINEAGE_MANIFEST_RELATIVE_PATH
  ));
  if (!manifestRaw) {
    reasons.push("successor_followup_lineage_manifest_missing");
    return { reasons };
  }
  const manifestValidation =
    validateTopicProbeSuccessorLineageManifest(manifestRaw);
  if (!manifestValidation.valid || !manifestValidation.manifest) {
    reasons.push(...manifestValidation.reasons.map((reason) =>
      `successor_followup_${reason}`
    ));
    return { reasons };
  }
  const manifest = manifestValidation.manifest;
  reasons.push(...compareReceiptToManifest(receipt, manifest, manifestRaw));
  validateBriefManifestBinding(input.snapshot, manifest, reasons);

  const activeContractArtifact = await readBoundJsonArtifact({
    runDir: input.runDir,
    label: "active_contract",
    binding: manifest.active_contract,
    reasons
  });
  const sourceCandidateArtifact = await readBoundJsonArtifact({
    runDir: input.runDir,
    label: "source_candidate",
    binding: manifest.source_candidate,
    reasons
  });
  const sourcePortfolioArtifact = await readBoundJsonArtifact({
    runDir: input.runDir,
    label: "source_portfolio",
    binding: manifest.source_portfolio,
    reasons
  });
  const handoffArtifact = await readBoundJsonArtifact({
    runDir: input.runDir,
    label: "handoff",
    binding: manifest.handoff,
    reasons
  });
  const boundedOutcomeArtifact = await readBoundJsonArtifact({
    runDir: input.runDir,
    label: "bounded_outcome",
    binding: manifest.bounded_outcome,
    reasons
  });
  const reviewGateArtifact = await readBoundJsonArtifact({
    runDir: input.runDir,
    label: "review_gate",
    binding: manifest.review_gate,
    reasons
  });

  if (
    !activeContractArtifact
    || !sourceCandidateArtifact
    || !sourcePortfolioArtifact
    || !handoffArtifact
    || !boundedOutcomeArtifact
    || !reviewGateArtifact
  ) {
    return { reasons };
  }

  const contract = activeContractArtifact.value as unknown as ActiveTopicProbeContract;
  const candidate = sourceCandidateArtifact.value as unknown as TopicPortfolioCandidate;
  const portfolio = sourcePortfolioArtifact.value as unknown as TopicPortfolio;
  const outcome = boundedOutcomeArtifact.value as unknown as TopicProbeOutcomeDecision;
  const handoff = handoffArtifact.value as unknown as TopicProbeFollowupHandoff;
  const gate = reviewGateArtifact.value as unknown as TopicProbeReviewGateArtifact;

  const receiptIdentityBindings: Array<[string, unknown, unknown]> = [
    ["candidate_id", candidate.source_candidate_id, receipt.candidate_id],
    ["topic_id", candidate.topic_id, receipt.topic_id],
    ["contract_candidate_id", contract.candidate_id, receipt.candidate_id],
    ["contract_topic_id", contract.topic_id, receipt.topic_id],
    ["handoff_candidate_id", handoff.candidate_id, receipt.candidate_id],
    ["handoff_topic_id", handoff.topic_id, receipt.topic_id],
    ["outcome_candidate_id", outcome.candidate_id, receipt.candidate_id],
    ["outcome_topic_id", outcome.topic_id, receipt.topic_id],
    [
      "source_portfolio_content_sha256",
      portfolio.content_sha256,
      receipt.source_portfolio_content_sha256
    ],
    [
      "route_target_content_sha256",
      handoff.route_target.content_sha256,
      receipt.route_target_content_sha256
    ]
  ];
  for (const [field, actual, expected] of receiptIdentityBindings) {
    if (!valuesEqual(actual, expected)) {
      reasons.push(`successor_followup_receipt_identity_mismatch:${field}`);
    }
  }

  const portfolioValidation = validateTopicPortfolioArtifact(
    sourcePortfolioArtifact.raw,
    {
      expectedRunId: receipt.parent_run_id,
      expectedResearchCycle: receipt.parent_research_cycle
    }
  );
  reasons.push(...prefixReasons(
    "successor_followup_source_portfolio_invalid",
    portfolioValidation.reasons
  ));

  const contractValidation = validateActiveTopicProbeContract(
    activeContractArtifact.raw,
    {
      expectedRunId: receipt.parent_run_id,
      expectedResearchCycle: receipt.parent_research_cycle,
      portfolio
    }
  );
  reasons.push(...prefixReasons(
    "successor_followup_active_contract_invalid",
    contractValidation.reasons
  ));

  const outcomeValidation = validateTopicProbeOutcomeDecision(
    boundedOutcomeArtifact.raw,
    {
      expectedRunId: receipt.parent_run_id,
      expectedResearchCycle: receipt.parent_research_cycle,
      contract,
      structuralOnly: true
    }
  );
  reasons.push(...prefixReasons(
    "successor_followup_bounded_outcome_invalid",
    outcomeValidation.reasons
  ));

  const handoffValidation = validateTopicProbeFollowupHandoff(
    handoffArtifact.raw,
    {
      portfolio,
      contract,
      outcome,
      candidate,
      expectedRunId: receipt.parent_run_id,
      expectedResearchCycle: receipt.parent_research_cycle
    }
  );
  reasons.push(...prefixReasons(
    "successor_followup_handoff_invalid",
    handoffValidation.reasons
  ));

  const gateValidation = validateTopicProbeReviewGate(
    reviewGateArtifact.raw,
    {
      runId: receipt.parent_run_id,
      researchCycle: receipt.parent_research_cycle,
      outcome,
      handoff,
      validationReasons: []
    }
  );
  reasons.push(...prefixReasons(
    "successor_followup_review_gate_invalid",
    gateValidation.reasons
  ));

  if (
    outcome.disposition !== receipt.disposition
    || outcome.next_action !== receipt.next_action
    || handoff.disposition !== receipt.disposition
    || handoff.next_action !== receipt.next_action
    || handoff.recommended_followup_mode
      !== receipt.recommended_followup_mode
    || handoff.evidence_stage !== receipt.evidence_stage
    || handoff.source_portfolio_content_sha256
      !== receipt.source_portfolio_content_sha256
    || handoff.route_target.content_sha256
      !== receipt.route_target_content_sha256
    || manifest.relation !== receipt.relation
    || manifest.disposition !== receipt.disposition
    || manifest.next_action !== receipt.next_action
    || manifest.recommended_followup_mode
      !== receipt.recommended_followup_mode
    || manifest.evidence_stage !== receipt.evidence_stage
    || gate.status !== "followup_required"
    || gate.paper_drafting_allowed !== false
  ) {
    reasons.push("successor_followup_promotion_authority_invalid");
  }
  return {
    reasons,
    ...(handoffValidation.valid
      ? { routeTarget: handoff.route_target }
      : {})
  };
}

function compareReceiptToManifest(
  receipt: TopicProbeFollowupRunReceipt,
  manifest: TopicProbeSuccessorLineageManifest,
  manifestRaw: string
): string[] {
  const reasons: string[] = [];
  const identityBindings: Array<[string, unknown, unknown]> = [
    ["relation", manifest.relation, receipt.relation],
    ["disposition", manifest.disposition, receipt.disposition],
    ["next_action", manifest.next_action, receipt.next_action],
    [
      "recommended_followup_mode",
      manifest.recommended_followup_mode,
      receipt.recommended_followup_mode
    ],
    ["evidence_stage", manifest.evidence_stage, receipt.evidence_stage],
    ["parent_run_id", manifest.parent_run_id, receipt.parent_run_id],
    [
      "parent_research_cycle",
      manifest.parent_research_cycle,
      receipt.parent_research_cycle
    ],
    ["child_run_id", manifest.child_run_id, receipt.child_run_id],
    [
      "lineage_manifest_content_sha256",
      manifest.content_sha256,
      receipt.lineage_manifest_content_sha256
    ],
    [
      "lineage_manifest_file_sha256",
      hashArtifactBytes(manifestRaw),
      receipt.lineage_manifest_file_sha256
    ],
    [
      "contract_content_sha256",
      manifest.active_contract.content_sha256,
      receipt.contract_content_sha256
    ],
    [
      "source_candidate_content_sha256",
      manifest.source_candidate.content_sha256,
      receipt.source_candidate_content_sha256
    ],
    [
      "source_portfolio_content_sha256",
      manifest.source_portfolio.content_sha256,
      receipt.source_portfolio_content_sha256
    ],
    [
      "handoff_content_sha256",
      manifest.handoff.content_sha256,
      receipt.handoff_content_sha256
    ],
    [
      "outcome_content_sha256",
      manifest.bounded_outcome.content_sha256,
      receipt.outcome_content_sha256
    ],
    [
      "review_gate_content_sha256",
      manifest.review_gate.content_sha256,
      receipt.review_gate_content_sha256
    ],
    [
      "research_brief_sha256",
      manifest.source_brief.content_sha256,
      receipt.research_brief_sha256
    ]
  ];
  for (const [field, actual, expected] of identityBindings) {
    if (!valuesEqual(actual, expected)) {
      reasons.push(`successor_followup_manifest_receipt_mismatch:${field}`);
    }
  }
  return reasons;
}

function validateBriefManifestBinding(
  snapshot: string | undefined,
  manifest: TopicProbeSuccessorLineageManifest,
  reasons: string[]
): void {
  if (!snapshot) {
    reasons.push("successor_followup_source_brief_missing");
    return;
  }
  if (hashArtifactBytes(snapshot) !== manifest.source_brief.file_sha256) {
    reasons.push("successor_followup_source_brief_file_hash_mismatch");
  }
  if (hashCanonical(snapshot) !== manifest.source_brief.content_sha256) {
    reasons.push("successor_followup_source_brief_content_hash_mismatch");
  }
}

async function readBoundJsonArtifact(input: {
  runDir: string;
  label: string;
  binding: TopicProbeSuccessorArtifactBinding;
  reasons: string[];
}): Promise<{ raw: string; value: Record<string, unknown> } | undefined> {
  const raw = await readOptionalText(path.join(
    input.runDir,
    input.binding.relative_path
  ));
  if (raw === undefined) {
    input.reasons.push(`successor_followup_${input.label}_missing`);
    return undefined;
  }
  if (hashArtifactBytes(raw) !== input.binding.file_sha256) {
    input.reasons.push(
      `successor_followup_${input.label}_file_hash_mismatch`
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    input.reasons.push(`successor_followup_${input.label}_invalid_json`);
    return undefined;
  }
  if (!isRecord(value) || !isSha256(value.content_sha256)) {
    input.reasons.push(`successor_followup_${input.label}_schema_invalid`);
    return undefined;
  }
  if (value.content_sha256 !== input.binding.content_sha256) {
    input.reasons.push(
      `successor_followup_${input.label}_manifest_content_hash_mismatch`
    );
  }
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    input.reasons.push(
      `successor_followup_${input.label}_content_hash_mismatch`
    );
  }
  return { raw, value };
}

function prefixReasons(prefix: string, reasons: string[]): string[] {
  return reasons.map((reason) => `${prefix}:${reason}`);
}

function compareReceiptToRunLineage(
  receipt: TopicProbeFollowupRunReceipt,
  lineage: RunRecord["promotionLineage"]
): string[] {
  if (!lineage) {
    return ["successor_followup_run_lineage_missing"];
  }
  const reasons: string[] = [];
  if (lineage.schemaVersion !== 1 || lineage.relation !== receipt.relation) {
    reasons.push("successor_followup_relation_mismatch");
  }
  if (lineage.parentRunId !== receipt.parent_run_id) {
    reasons.push("successor_followup_parent_run_id_mismatch");
  }
  if (lineage.parentResearchCycle !== receipt.parent_research_cycle) {
    reasons.push("successor_followup_parent_research_cycle_mismatch");
  }
  if (lineage.outcomeContentSha256 !== receipt.outcome_content_sha256) {
    reasons.push("successor_followup_outcome_hash_mismatch");
  }
  if (lineage.receiptContentSha256 !== receipt.content_sha256) {
    reasons.push("successor_followup_receipt_hash_mismatch");
  }
  return reasons;
}

export async function loadResearchBriefSnapshot(
  workspaceRoot: string,
  runId: string
): Promise<string | undefined> {
  return readOptionalText(
    path.join(
      workspaceRoot,
      ".autolabos",
      "runs",
      runId,
      "brief",
      "source_brief.md"
    )
  );
}

function parseMode(markdown: string | undefined): ResearchRunMode | undefined {
  return markdown ? parseDeclaredResearchRunMode(markdown) : undefined;
}

function hasInvalidModeDeclaration(markdown: string | undefined): boolean {
  if (!markdown) {
    return false;
  }
  const value = parseMarkdownRunBriefSections(markdown)?.researchMode?.trim();
  return Boolean(value) && !parseDeclaredResearchRunMode(markdown);
}

async function existingRelativePaths(
  runDir: string,
  relativePaths: readonly string[]
): Promise<string[]> {
  const checks = await Promise.all(
    relativePaths.map(async (relativePath) => ({
      relativePath,
      exists: await fileExists(path.join(runDir, relativePath))
    }))
  );
  return checks
    .filter((entry) => entry.exists)
    .map((entry) => entry.relativePath);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
