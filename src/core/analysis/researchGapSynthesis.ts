import { createHash } from "node:crypto";

import { hashCanonical } from "../canonicalHash.js";
import { LLMClient } from "../llm/client.js";
import {
  isResearchOpportunityType,
  RESEARCH_OPPORTUNITY_TYPES,
  type ResearchOpportunityType
} from "../researchOpportunity.js";
import type { HypothesisEvidenceSeed } from "./researchPlanning.js";
import { parseStructuredModelJsonObject } from "./modelJson.js";

export const RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION = 3;
export const RESEARCH_GAP_SYNTHESIS_PROMPT_CONTRACT_VERSION = 2;

const DEFAULT_SYNTHESIS_TIMEOUT_MS = 120_000;
const MAX_SYNTHESIS_EVIDENCE_ITEMS = 160;
const MIN_SYNTHESIS_EVIDENCE_CONFIDENCE = 0.6;

export { RESEARCH_OPPORTUNITY_TYPES } from "../researchOpportunity.js";
export type { ResearchOpportunityType } from "../researchOpportunity.js";

const OPPORTUNITY_REVIEW_CONDITIONS = {
  explicit_limitation: ["same_unresolved_limitation"],
  cross_paper_result_disagreement: [
    "same_research_question",
    "genuine_result_disagreement",
    "not_task_or_metric_mismatch"
  ],
  boundary_or_transfer_mismatch: [
    "boundary_difference_grounded",
    "transfer_gap_unresolved"
  ],
  missing_comparator_or_control: [
    "comparator_absence_grounded",
    "omission_affects_inference"
  ],
  reproducibility_gap: [
    "reproducibility_omission_grounded",
    "omission_affects_reproduction"
  ]
} as const satisfies Record<ResearchOpportunityType, readonly string[]>;

type OpportunityReviewCondition =
  typeof OPPORTUNITY_REVIEW_CONDITIONS[ResearchOpportunityType][number];

export interface ResearchGapSemanticCluster {
  cluster_id: string;
  opportunity_type: ResearchOpportunityType;
  statement: string;
  evidence_ids: string[];
  paper_ids: string[];
}

interface ProposedResearchGapCluster extends ResearchGapSemanticCluster {
  rationale?: string;
}

interface ResearchGapClusterReview {
  cluster_id: string;
  opportunity_type: ResearchOpportunityType;
  decision: "accept" | "reject";
  statement?: string;
  accepted_evidence_ids: string[];
  validated_conditions: OpportunityReviewCondition[];
  reason?: string;
}

export interface ResearchGapSynthesisArtifact {
  schema_version: 2;
  artifact_kind: "research_gap_semantic_synthesis";
  semantics_version: number;
  prompt_contract_version: number;
  status: "completed" | "safe_fallback";
  method: "llm_proposer_reviewer_deterministic_validation" | "deterministic_safe_fallback";
  run_id: string;
  research_cycle: number;
  collect_attempt_id: string;
  corpus_sha256: string;
  evidence_sha256: string;
  generated_at: string;
  excluded_evidence: Array<{
    evidence_id: string;
    reason:
      | "source_visibility"
      | "missing_identity"
      | "insufficient_source_scope"
      | "ungrounded_evidence"
      | "insufficient_confidence"
      | "no_supported_opportunity_signal";
  }>;
  proposed_clusters: ProposedResearchGapCluster[];
  reviews: ResearchGapClusterReview[];
  accepted_clusters: ResearchGapSemanticCluster[];
  unclustered_evidence_ids: string[];
  diagnostics: {
    eligible_evidence_count: number;
    eligible_evidence_count_by_opportunity_type: Record<ResearchOpportunityType, number>;
    accepted_cluster_count_by_opportunity_type: Record<ResearchOpportunityType, number>;
    proposer_output_sha256?: string;
    proposer_json_repaired?: boolean;
    reviewer_output_sha256?: string;
    reviewer_json_repaired?: boolean;
    failure_reason?: string;
  };
  content_sha256: string;
}

export interface ResearchGapSynthesisResult {
  artifact: ResearchGapSynthesisArtifact;
  toolCallsUsed: number;
}

export interface ResearchGapSynthesisContext {
  runId: string;
  researchCycle: number;
  collectAttemptId: string;
  corpusSha256: string;
  evidenceSha256: string;
}

export interface ResearchOpportunityEvidenceSignalInput {
  limitation_kind: NonNullable<HypothesisEvidenceSeed["limitation_kind"]>;
  claim: string;
  limitation: string;
  method: string;
  result: string;
  dataset: string;
  metric: string;
  evidence_span: string;
}

interface EligibleEvidence extends ResearchOpportunityEvidenceSignalInput {
  evidence_id: string;
  paper_id: string;
  canonical_work_id: string;
  source_type: "full_text" | "abstract";
  source_scope: "abstract" | "full_text_excerpt" | "full_document";
  grounding_status: "grounded_span";
  confidence: number;
  confidence_reason: string;
  opportunity_types: ResearchOpportunityType[];
}

interface ProposalResponse {
  clusters?: unknown;
}

interface ReviewResponse {
  reviews?: unknown;
}

export async function synthesizeResearchGapClusters(input: {
  llm: LLMClient;
  evidence: HypothesisEvidenceSeed[];
  context: ResearchGapSynthesisContext;
  runTitle?: string;
  runTopic?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  allowModelCalls?: boolean;
  onProgress?: (message: string) => void;
}): Promise<ResearchGapSynthesisResult> {
  const prepared = prepareEvidence(input.evidence);
  if (input.allowModelCalls === false) {
    return {
      artifact: buildArtifact({
        context: input.context,
        status: "safe_fallback",
        excludedEvidence: prepared.excluded,
        eligibleEvidence: prepared.eligible,
        failureReason: "semantic_synthesis_deferred_due_analysis_failures"
      }),
      toolCallsUsed: 0
    };
  }
  if (prepared.eligible.length < 2) {
    return {
      artifact: buildArtifact({
        context: input.context,
        status: "safe_fallback",
        excludedEvidence: prepared.excluded,
        eligibleEvidence: prepared.eligible,
        failureReason: "insufficient_typed_opportunity_evidence"
      }),
      toolCallsUsed: 0
    };
  }
  if (prepared.eligible.length > MAX_SYNTHESIS_EVIDENCE_ITEMS) {
    return {
      artifact: buildArtifact({
        context: input.context,
        status: "safe_fallback",
        excludedEvidence: prepared.excluded,
        eligibleEvidence: prepared.eligible,
        failureReason: `evidence_count_above_safe_limit:${prepared.eligible.length}`
      }),
      toolCallsUsed: 0
    };
  }

  let toolCallsUsed = 0;
  try {
    input.onProgress?.(
      `Research-opportunity proposer is comparing ${prepared.eligible.length} typed evidence candidate(s).`
    );
    toolCallsUsed += 1;
    const proposalCompletion = await completeWithTimeout({
      llm: input.llm,
      prompt: buildProposalPrompt(prepared.eligible, input.runTitle, input.runTopic),
      systemPrompt: buildProposalSystemPrompt(),
      timeoutMs: normalizeTimeout(input.timeoutMs),
      abortSignal: input.abortSignal
    });
    const parsedProposal = parseStructuredModelJsonObject<ProposalResponse>(proposalCompletion.text, {
      emptyError: "research_gap_proposal_empty",
      notFoundError: "research_gap_proposal_json_not_found",
      incompleteError: "research_gap_proposal_json_incomplete",
      invalidError: "research_gap_proposal_json_invalid"
    });
    const proposedClusters = normalizeProposedClusters(
      parsedProposal.value.clusters,
      prepared.eligible
    );
    if (proposedClusters.length === 0) {
      return {
        artifact: buildArtifact({
          context: input.context,
          status: "completed",
          excludedEvidence: prepared.excluded,
          eligibleEvidence: prepared.eligible,
          proposedClusters,
          diagnostics: {
            proposer_output_sha256: sha256(proposalCompletion.text),
            proposer_json_repaired: parsedProposal.repaired
          }
        }),
        toolCallsUsed
      };
    }

    input.onProgress?.(
      `Research-opportunity reviewer is stress-testing ${proposedClusters.length} typed multi-paper cluster(s).`
    );
    toolCallsUsed += 1;
    const reviewCompletion = await completeWithTimeout({
      llm: input.llm,
      prompt: buildReviewPrompt(proposedClusters, prepared.eligible),
      systemPrompt: buildReviewSystemPrompt(),
      timeoutMs: normalizeTimeout(input.timeoutMs),
      abortSignal: input.abortSignal
    });
    const parsedReview = parseStructuredModelJsonObject<ReviewResponse>(reviewCompletion.text, {
      emptyError: "research_gap_review_empty",
      notFoundError: "research_gap_review_json_not_found",
      incompleteError: "research_gap_review_json_incomplete",
      invalidError: "research_gap_review_json_invalid"
    });
    const reviews = normalizeReviews(
      parsedReview.value.reviews,
      proposedClusters,
      prepared.eligible
    );
    const acceptedClusters = acceptReviewedClusters(
      proposedClusters,
      reviews,
      prepared.eligible
    );
    return {
      artifact: buildArtifact({
        context: input.context,
        status: "completed",
        excludedEvidence: prepared.excluded,
        eligibleEvidence: prepared.eligible,
        proposedClusters,
        reviews,
        acceptedClusters,
        diagnostics: {
          proposer_output_sha256: sha256(proposalCompletion.text),
          proposer_json_repaired: parsedProposal.repaired,
          reviewer_output_sha256: sha256(reviewCompletion.text),
          reviewer_json_repaired: parsedReview.repaired
        }
      }),
      toolCallsUsed
    };
  } catch (error) {
    if (input.abortSignal?.aborted) {
      throw error;
    }
    return {
      artifact: buildArtifact({
        context: input.context,
        status: "safe_fallback",
        excludedEvidence: prepared.excluded,
        eligibleEvidence: prepared.eligible,
        failureReason: cleanError(error)
      }),
      toolCallsUsed
    };
  }
}

export function parseReusableResearchGapSynthesisArtifact(
  raw: string,
  context: ResearchGapSynthesisContext
): ResearchGapSynthesisArtifact | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isResearchGapSynthesisArtifact(parsed)) {
      return undefined;
    }
    const { content_sha256: contentSha256, ...payload } = parsed;
    if (hashCanonical(payload) !== contentSha256) {
      return undefined;
    }
    if (
      parsed.semantics_version !== RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION ||
      parsed.run_id !== context.runId ||
      parsed.research_cycle !== context.researchCycle ||
      parsed.collect_attempt_id !== context.collectAttemptId ||
      parsed.corpus_sha256 !== context.corpusSha256 ||
      parsed.evidence_sha256 !== context.evidenceSha256
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function isSourceVisibilityLimitation(statement: string): boolean {
  const normalized = statement.replace(/\s+/gu, " ").trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return [
    /\b(?:supplied|provided|retrieved|visible) (?:source (?:text|excerpt|document|paper)|excerpt|text|abstract)\b/u,
    /\b(?:supplied|provided|retrieved) source (?:(?:text|document|paper) )?(?:does not|did not|cannot|lacks|omits)\b/u,
    /\b(?:source|excerpt|text) (?:is )?truncat(?:ed|es)\b/u,
    /\bnot (?:shown|visible|included|present|available|reported) in (?:the )?(?:supplied|provided|retrieved|visible) (?:source|excerpt|text|abstract)\b/u,
    /\b(?:abstract|excerpt) does not (?:specify|clarify|report|include|name|define)\b/u,
    /\bnot reported in (?:the )?abstract\b/u,
    /\bnot visible\b/u,
    /\bunavailable in (?:the )?(?:supplied|provided|retrieved|visible)\b/u,
    /\bonly (?:the )?(?:first|last) [\w-]+ (?:pdf )?pages? (?:were )?(?:retrieved|provided|available|included)\b/u
  ].some((pattern) => pattern.test(normalized));
}

export function classifyResearchOpportunityEvidence(
  item: HypothesisEvidenceSeed
): ResearchOpportunityType[] {
  const limitation = normalizeText(item.limitation_slot) ?? "";
  const evidenceSpan = normalizeText(item.evidence_span) ?? "";
  if (
    item.source_type !== "full_text" ||
    (item.source_scope !== "full_document" && item.source_scope !== "full_text_excerpt") ||
    item.grounding_status !== "grounded_span" ||
    typeof item.confidence !== "number" ||
    !Number.isFinite(item.confidence) ||
    item.confidence < MIN_SYNTHESIS_EVIDENCE_CONFIDENCE ||
    !evidenceSpan ||
    item.limitation_kind === "source_visibility" ||
    isSourceVisibilityLimitation(limitation) ||
    isSourceVisibilityLimitation(evidenceSpan)
  ) {
    return [];
  }
  return detectResearchOpportunityTypes({
    limitation_kind: item.limitation_kind ?? "unknown",
    claim: normalizeText(item.claim) ?? "",
    limitation,
    method: normalizeText(item.method_slot) ?? "",
    result: normalizeText(item.result_slot) ?? "",
    dataset: normalizeText(item.dataset_slot) ?? "",
    metric: normalizeText(item.metric_slot) ?? "",
    evidence_span: evidenceSpan
  });
}

function prepareEvidence(evidence: HypothesisEvidenceSeed[]): {
  eligible: EligibleEvidence[];
  excluded: ResearchGapSynthesisArtifact["excluded_evidence"];
} {
  const eligible: EligibleEvidence[] = [];
  const excluded: ResearchGapSynthesisArtifact["excluded_evidence"] = [];
  const seenEvidenceIds = new Set<string>();
  for (const item of evidence) {
    const evidenceId = normalizeText(item.evidence_id);
    const paperId = normalizeText(item.paper_id);
    if (!evidenceId || !paperId || seenEvidenceIds.has(evidenceId)) {
      if (evidenceId && !seenEvidenceIds.has(evidenceId)) {
        excluded.push({ evidence_id: evidenceId, reason: "missing_identity" });
        seenEvidenceIds.add(evidenceId);
      }
      continue;
    }
    seenEvidenceIds.add(evidenceId);
    const limitation = normalizeText(item.limitation_slot) ?? "";
    const evidenceSpan = normalizeText(item.evidence_span);
    if (
      item.limitation_kind === "source_visibility" ||
      isSourceVisibilityLimitation(limitation) ||
      isSourceVisibilityLimitation(evidenceSpan ?? "")
    ) {
      excluded.push({ evidence_id: evidenceId, reason: "source_visibility" });
      continue;
    }
    if (
      item.source_type !== "full_text" ||
      (item.source_scope !== "full_document" && item.source_scope !== "full_text_excerpt")
    ) {
      excluded.push({ evidence_id: evidenceId, reason: "insufficient_source_scope" });
      continue;
    }
    if (item.grounding_status !== "grounded_span" || !evidenceSpan) {
      excluded.push({ evidence_id: evidenceId, reason: "ungrounded_evidence" });
      continue;
    }
    if (
      typeof item.confidence !== "number" ||
      !Number.isFinite(item.confidence) ||
      item.confidence < MIN_SYNTHESIS_EVIDENCE_CONFIDENCE
    ) {
      excluded.push({ evidence_id: evidenceId, reason: "insufficient_confidence" });
      continue;
    }
    const prepared = {
      limitation_kind: item.limitation_kind ?? "unknown",
      claim: normalizeText(item.claim) ?? "",
      limitation,
      method: normalizeText(item.method_slot) ?? "",
      result: normalizeText(item.result_slot) ?? "",
      dataset: normalizeText(item.dataset_slot) ?? "",
      metric: normalizeText(item.metric_slot) ?? "",
      evidence_span: evidenceSpan
    };
    const opportunityTypes = detectResearchOpportunityTypes(prepared);
    if (opportunityTypes.length === 0) {
      excluded.push({ evidence_id: evidenceId, reason: "no_supported_opportunity_signal" });
      continue;
    }
    eligible.push({
      evidence_id: evidenceId,
      paper_id: paperId,
      canonical_work_id: normalizeText(item.canonical_work_id) ?? `paper:${paperId.toLocaleLowerCase()}`,
      source_type: item.source_type === "full_text" ? "full_text" : "abstract",
      source_scope:
        item.source_scope === "full_document" || item.source_scope === "full_text_excerpt"
          ? item.source_scope
          : "abstract",
      grounding_status: "grounded_span",
      confidence: item.confidence,
      confidence_reason: normalizeText(item.confidence_reason) ?? "",
      ...prepared,
      opportunity_types: opportunityTypes
    });
  }
  return {
    eligible: eligible.sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
    excluded: excluded.sort((left, right) => left.evidence_id.localeCompare(right.evidence_id))
  };
}

function normalizeProposedClusters(
  value: unknown,
  evidence: EligibleEvidence[]
): ProposedResearchGapCluster[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const evidenceById = new Map(evidence.map((item) => [item.evidence_id, item] as const));
  const clusters: ProposedResearchGapCluster[] = [];
  const seenClusterIds = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) {
      continue;
    }
    const clusterId = normalizeText(raw.cluster_id);
    const opportunityType = normalizeOpportunityType(raw.opportunity_type);
    const statement = normalizeText(raw.statement);
    const rationale = normalizeText(raw.rationale);
    const evidenceIds = normalizeStringArray(raw.evidence_ids)
      .filter((evidenceId) => evidenceById.has(evidenceId));
    if (
      !clusterId ||
      !opportunityType ||
      seenClusterIds.has(clusterId) ||
      !isSubstantiveGapStatement(statement) ||
      !hasTypedOpportunitySupport(opportunityType, evidenceIds, evidenceById)
    ) {
      continue;
    }
    seenClusterIds.add(clusterId);
    clusters.push({
      cluster_id: clusterId,
      opportunity_type: opportunityType,
      statement: statement as string,
      evidence_ids: evidenceIds,
      paper_ids: uniqueStrings(evidenceIds.map((evidenceId) => evidenceById.get(evidenceId)?.paper_id)),
      ...(rationale ? { rationale } : {})
    });
  }
  return clusters.sort((left, right) => left.cluster_id.localeCompare(right.cluster_id));
}

function normalizeReviews(
  value: unknown,
  proposedClusters: ProposedResearchGapCluster[],
  evidence: EligibleEvidence[]
): ResearchGapClusterReview[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const proposalsById = new Map(proposedClusters.map((cluster) => [cluster.cluster_id, cluster] as const));
  const evidenceById = new Map(evidence.map((item) => [item.evidence_id, item] as const));
  const reviews: ResearchGapClusterReview[] = [];
  const seenClusterIds = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) {
      continue;
    }
    const clusterId = normalizeText(raw.cluster_id);
    const proposal = clusterId ? proposalsById.get(clusterId) : undefined;
    if (!clusterId || !proposal || seenClusterIds.has(clusterId)) {
      continue;
    }
    seenClusterIds.add(clusterId);
    const decision = raw.decision === "accept" ? "accept" : "reject";
    const opportunityType = normalizeOpportunityType(raw.opportunity_type);
    const proposedEvidenceSet = new Set(proposal.evidence_ids);
    const acceptedEvidenceIds = normalizeStringArray(raw.accepted_evidence_ids)
      .filter((evidenceId) => proposedEvidenceSet.has(evidenceId));
    const statement = normalizeText(raw.statement);
    const validatedConditions = normalizeReviewConditions(raw.validated_conditions);
    const accepted =
      decision === "accept" &&
      opportunityType === proposal.opportunity_type &&
      isSubstantiveGapStatement(statement ?? proposal.statement) &&
      hasTypedOpportunitySupport(proposal.opportunity_type, acceptedEvidenceIds, evidenceById) &&
      hasRequiredReviewConditions(proposal.opportunity_type, validatedConditions);
    reviews.push({
      cluster_id: clusterId,
      opportunity_type: proposal.opportunity_type,
      decision: accepted ? "accept" : "reject",
      ...(statement ? { statement } : {}),
      accepted_evidence_ids: accepted ? acceptedEvidenceIds : [],
      validated_conditions: accepted ? validatedConditions : [],
      ...(normalizeText(raw.reason) ? { reason: normalizeText(raw.reason) } : {})
    });
  }
  return reviews.sort((left, right) => left.cluster_id.localeCompare(right.cluster_id));
}

function acceptReviewedClusters(
  proposals: ProposedResearchGapCluster[],
  reviews: ResearchGapClusterReview[],
  evidence: EligibleEvidence[]
): ResearchGapSemanticCluster[] {
  const evidenceById = new Map(evidence.map((item) => [item.evidence_id, item] as const));
  const reviewsById = new Map(reviews.map((review) => [review.cluster_id, review] as const));
  const accepted: ResearchGapSemanticCluster[] = [];
  for (const proposal of proposals) {
    const review = reviewsById.get(proposal.cluster_id);
    if (!review || review.decision !== "accept") {
      continue;
    }
    const evidenceIds = review.accepted_evidence_ids;
    if (!hasTypedOpportunitySupport(proposal.opportunity_type, evidenceIds, evidenceById)) {
      continue;
    }
    accepted.push({
      cluster_id: proposal.cluster_id,
      opportunity_type: proposal.opportunity_type,
      statement: review.statement ?? proposal.statement,
      evidence_ids: evidenceIds,
      paper_ids: uniqueStrings(evidenceIds.map((evidenceId) => evidenceById.get(evidenceId)?.paper_id))
    });
  }
  return accepted;
}

function buildArtifact(input: {
  context: ResearchGapSynthesisContext;
  status: ResearchGapSynthesisArtifact["status"];
  excludedEvidence: ResearchGapSynthesisArtifact["excluded_evidence"];
  eligibleEvidence: EligibleEvidence[];
  proposedClusters?: ProposedResearchGapCluster[];
  reviews?: ResearchGapClusterReview[];
  acceptedClusters?: ResearchGapSemanticCluster[];
  diagnostics?: Partial<ResearchGapSynthesisArtifact["diagnostics"]>;
  failureReason?: string;
}): ResearchGapSynthesisArtifact {
  const proposedClusters = input.proposedClusters ?? [];
  const reviews = input.reviews ?? [];
  const acceptedClusters = input.acceptedClusters ?? [];
  const assignedEvidenceIds = new Set(
    acceptedClusters.flatMap((cluster) => cluster.evidence_ids)
  );
  const eligibleEvidenceCountByType = countEvidenceByOpportunityType(input.eligibleEvidence);
  const acceptedClusterCountByType = countClustersByOpportunityType(acceptedClusters);
  const payload = {
    schema_version: 2 as const,
    artifact_kind: "research_gap_semantic_synthesis" as const,
    semantics_version: RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION,
    prompt_contract_version: RESEARCH_GAP_SYNTHESIS_PROMPT_CONTRACT_VERSION,
    status: input.status,
    method: input.status === "completed"
      ? "llm_proposer_reviewer_deterministic_validation" as const
      : "deterministic_safe_fallback" as const,
    run_id: input.context.runId,
    research_cycle: input.context.researchCycle,
    collect_attempt_id: input.context.collectAttemptId,
    corpus_sha256: input.context.corpusSha256,
    evidence_sha256: input.context.evidenceSha256,
    generated_at: new Date().toISOString(),
    excluded_evidence: input.excludedEvidence,
    proposed_clusters: proposedClusters,
    reviews,
    accepted_clusters: acceptedClusters,
    unclustered_evidence_ids: input.eligibleEvidence
      .map((item) => item.evidence_id)
      .filter((evidenceId) => !assignedEvidenceIds.has(evidenceId)),
    diagnostics: {
      eligible_evidence_count: input.eligibleEvidence.length,
      eligible_evidence_count_by_opportunity_type: eligibleEvidenceCountByType,
      accepted_cluster_count_by_opportunity_type: acceptedClusterCountByType,
      ...input.diagnostics,
      ...(input.failureReason ? { failure_reason: input.failureReason } : {})
    }
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function buildProposalSystemPrompt(): string {
  return [
    "You are the proposing member of a typed research-opportunity synthesis panel.",
    "Use only the supplied evidence records. Never infer missing paper content.",
    "Every record lists deterministic opportunity_types that it may support; never use it for another type.",
    "For explicit_limitation, require the same unresolved scientific limitation.",
    "For cross_paper_result_disagreement, require the same research question and genuinely incompatible results under a shared task or metric; wording differences are insufficient.",
    "For boundary_or_transfer_mismatch, require grounded differences in evaluated boundaries and a specific unresolved transfer question.",
    "For missing_comparator_or_control, require exact grounded statements that a named comparator, control, baseline, or ablation is absent and that the omission limits inference.",
    "For reproducibility_gap, require exact grounded omissions of seeds, code, configuration, versions, or protocol details that obstruct reproduction.",
    "Propose a cluster only when at least two independent full-text works support the selected type.",
    "Shared topic words alone are insufficient. Source-access, excerpt-visibility, and missing-local-text caveats are never research gaps.",
    "Return one JSON object and no prose."
  ].join(" ");
}

function buildProposalPrompt(
  evidence: EligibleEvidence[],
  runTitle?: string,
  runTopic?: string
): string {
  return [
    "Research context:",
    `title=${normalizeText(runTitle) ?? ""}`,
    `topic=${normalizeText(runTopic) ?? ""}`,
    "Evidence records:",
    JSON.stringify(evidence),
    "Return this schema:",
    JSON.stringify({
      clusters: [
        {
          cluster_id: "gap_cluster_1",
          opportunity_type: "one_exact_value_from_the_supplied_opportunity_types",
          statement: "One precise unresolved opportunity supported by the linked papers.",
          evidence_ids: ["existing_evidence_id_from_paper_a", "existing_evidence_id_from_paper_b"],
          rationale: "Why these records express the same limitation rather than merely sharing a topic."
        }
      ]
    }),
    "Use existing evidence IDs exactly. Omit doubtful clusters."
  ].join("\n");
}

function buildReviewSystemPrompt(): string {
  return [
    "You are the adversarial reviewing member of a typed research-opportunity synthesis panel.",
    "Reject broad, topical, source-visibility, or weakly related clusters.",
    "Accept only if the exact linked records from at least two independent full-text works support the proposed opportunity_type.",
    "A result-disagreement cluster must compare the same question and must not explain the difference away as a task or metric mismatch.",
    "A boundary cluster must name the grounded boundary difference and unresolved transfer test.",
    "Comparator and reproducibility clusters must point to exact reported omissions, not infer omissions from empty fields.",
    "You may remove unsupported evidence IDs or tighten the statement, but may not add evidence IDs.",
    "Treat canonical_work_id, grounding_status, source_scope, confidence, confidence_reason, and evidence_span as binding quality evidence.",
    "Return one JSON object and no prose."
  ].join(" ");
}

function buildReviewPrompt(
  clusters: ProposedResearchGapCluster[],
  evidence: EligibleEvidence[]
): string {
  const usedEvidenceIds = new Set(clusters.flatMap((cluster) => cluster.evidence_ids));
  return [
    "Proposed clusters:",
    JSON.stringify(clusters),
    "Linked evidence records:",
    JSON.stringify(evidence.filter((item) => usedEvidenceIds.has(item.evidence_id))),
    "Return this schema:",
    JSON.stringify({
      reviews: [
        {
          cluster_id: "existing_cluster_id",
          opportunity_type: "exact_type_from_the_proposal",
          decision: "accept or reject",
          statement: "Optional tighter statement grounded in the accepted records.",
          accepted_evidence_ids: ["subset_of_proposed_ids"],
          validated_conditions: ["all_exact_required_condition_names_for_this_type"],
          reason: "Short evidence-grounded decision reason."
        }
      ]
    }),
    `Required validation conditions by type: ${JSON.stringify(OPPORTUNITY_REVIEW_CONDITIONS)}`,
    "Review every proposed cluster. Include every required condition only when the evidence establishes it. When uncertain, reject."
  ].join("\n");
}

async function completeWithTimeout(input: {
  llm: LLMClient;
  prompt: string;
  systemPrompt: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<{ text: string }> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.abortSignal?.reason);
  if (input.abortSignal?.aborted) {
    abortFromParent();
  } else {
    input.abortSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`research_gap_synthesis_timeout_after_${input.timeoutMs}ms`)),
    input.timeoutMs
  );
  try {
    return await input.llm.complete(input.prompt, {
      systemPrompt: input.systemPrompt,
      abortSignal: controller.signal
    });
  } finally {
    clearTimeout(timer);
    input.abortSignal?.removeEventListener("abort", abortFromParent);
  }
}

function hasIndependentFullTextSupport(
  evidenceIds: string[],
  evidenceById: ReadonlyMap<string, EligibleEvidence>
): boolean {
  const workIds = uniqueStrings(
    evidenceIds
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((item): item is EligibleEvidence => item?.source_type === "full_text")
      .map((item) => item.canonical_work_id)
  );
  return workIds.length >= 2;
}

export function detectResearchOpportunityTypes(
  input: ResearchOpportunityEvidenceSignalInput
): ResearchOpportunityType[] {
  const types: ResearchOpportunityType[] = [];
  if (
    input.limitation_kind === "scientific" &&
    isSubstantiveEvidenceSlot(input.limitation) &&
    hasSubstantiveTermOverlap(input.limitation, input.evidence_span, 2)
  ) {
    types.push("explicit_limitation");
  }
  if (
    isSubstantiveEvidenceSlot(input.result) &&
    (isSubstantiveEvidenceSlot(input.dataset) || isSubstantiveEvidenceSlot(input.metric)) &&
    hasSubstantiveTermOverlap(input.result, input.evidence_span, 2)
  ) {
    types.push("cross_paper_result_disagreement");
  }
  if (
    isSubstantiveEvidenceSlot(input.method) &&
    isSubstantiveEvidenceSlot(input.result) &&
    isSubstantiveEvidenceSlot(input.dataset) &&
    BOUNDARY_SIGNAL_PATTERN.test(input.evidence_span.toLowerCase())
  ) {
    types.push("boundary_or_transfer_mismatch");
  }
  if (
    isScientificReportingKind(input.limitation_kind) &&
    OMISSION_SIGNAL_PATTERN.test(input.evidence_span.toLowerCase()) &&
    COMPARATOR_SIGNAL_PATTERN.test(input.evidence_span.toLowerCase())
  ) {
    types.push("missing_comparator_or_control");
  }
  if (
    isScientificReportingKind(input.limitation_kind) &&
    OMISSION_SIGNAL_PATTERN.test(input.evidence_span.toLowerCase()) &&
    REPRODUCIBILITY_SIGNAL_PATTERN.test(input.evidence_span.toLowerCase())
  ) {
    types.push("reproducibility_gap");
  }
  return types;
}

function hasTypedOpportunitySupport(
  opportunityType: ResearchOpportunityType,
  evidenceIds: string[],
  evidenceById: ReadonlyMap<string, EligibleEvidence>
): boolean {
  if (!hasIndependentFullTextSupport(evidenceIds, evidenceById)) {
    return false;
  }
  const items = uniqueStrings(evidenceIds)
    .map((evidenceId) => evidenceById.get(evidenceId))
    .filter((item): item is EligibleEvidence => Boolean(item));
  if (
    items.length < 2 ||
    items.some((item) => !item.opportunity_types.includes(opportunityType))
  ) {
    return false;
  }
  if (opportunityType === "cross_paper_result_disagreement") {
    return hasSharedComparisonFrame(items) && uniqueStrings(items.map((item) => normalizeComparisonValue(item.result))).length >= 2;
  }
  if (opportunityType === "boundary_or_transfer_mismatch") {
    const frames = uniqueStrings(items.map((item) => normalizeComparisonValue(`${item.dataset}|${item.method}`)));
    return frames.length >= 2;
  }
  return true;
}

function hasSharedComparisonFrame(items: EligibleEvidence[]): boolean {
  const datasets = countNormalizedValues(items.map((item) => item.dataset));
  const metrics = countNormalizedValues(items.map((item) => item.metric));
  return [...datasets.values(), ...metrics.values()].some((count) => count >= 2);
}

function countNormalizedValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!isSubstantiveEvidenceSlot(value)) {
      continue;
    }
    const normalized = normalizeComparisonValue(value);
    if (normalized) {
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }
  return counts;
}

function normalizeComparisonValue(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function hasRequiredReviewConditions(
  opportunityType: ResearchOpportunityType,
  validatedConditions: OpportunityReviewCondition[]
): boolean {
  const supplied = new Set(validatedConditions);
  return OPPORTUNITY_REVIEW_CONDITIONS[opportunityType].every((condition) => supplied.has(condition));
}

function normalizeOpportunityType(value: unknown): ResearchOpportunityType | undefined {
  return isResearchOpportunityType(value) ? value : undefined;
}

function normalizeReviewConditions(value: unknown): OpportunityReviewCondition[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowed = new Set<string>(Object.values(OPPORTUNITY_REVIEW_CONDITIONS).flat());
  return uniqueStrings(
    value.map((item) => typeof item === "string" && allowed.has(item) ? item : undefined)
  ) as OpportunityReviewCondition[];
}

function countEvidenceByOpportunityType(
  evidence: EligibleEvidence[]
): Record<ResearchOpportunityType, number> {
  const counts = emptyOpportunityTypeCounts();
  for (const item of evidence) {
    for (const opportunityType of item.opportunity_types) {
      counts[opportunityType] += 1;
    }
  }
  return counts;
}

function countClustersByOpportunityType(
  clusters: ResearchGapSemanticCluster[]
): Record<ResearchOpportunityType, number> {
  const counts = emptyOpportunityTypeCounts();
  for (const cluster of clusters) {
    counts[cluster.opportunity_type] += 1;
  }
  return counts;
}

function emptyOpportunityTypeCounts(): Record<ResearchOpportunityType, number> {
  return Object.fromEntries(RESEARCH_OPPORTUNITY_TYPES.map((type) => [type, 0])) as Record<ResearchOpportunityType, number>;
}

function isScientificReportingKind(
  value: EligibleEvidence["limitation_kind"]
): boolean {
  return value === "scientific" || value === "reporting" || value === "claim_caveat";
}

function isSubstantiveEvidenceSlot(value: string): boolean {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length >= 12 && !/^(?:none|n\/?a|unknown|unspecified|not specified|not reported|not applicable)\.?$/iu.test(normalized);
}

function hasSubstantiveTermOverlap(left: string, right: string, minimum: number): boolean {
  const leftTerms = new Set(extractSubstantiveTerms(left));
  let overlap = 0;
  for (const term of extractSubstantiveTerms(right)) {
    if (leftTerms.has(term)) {
      overlap += 1;
      if (overlap >= minimum) {
        return true;
      }
    }
  }
  return false;
}

function extractSubstantiveTerms(value: string): string[] {
  const stopwords = new Set([
    "about", "after", "before", "between", "could", "does", "from", "have", "into",
    "only", "paper", "reported", "study", "than", "that", "their", "there", "these", "this",
    "through", "using", "were", "which", "with", "without"
  ]);
  return uniqueStrings(
    value.toLowerCase().match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length >= 4 && !stopwords.has(term)) ?? []
  );
}

const OMISSION_SIGNAL_PATTERN = /\b(?:absent|exclude[ds]?|lack(?:s|ed)?|missing|no|not (?:include[ds]?|provide[ds]?|report(?:ed|s)?)|omit(?:s|ted)?|unavailable|without)\b/u;
const COMPARATOR_SIGNAL_PATTERN = /\b(?:ablation|baseline|comparator|comparison arm|control(?:led)?|counterfactual|matched comparison)\b/u;
const REPRODUCIBILITY_SIGNAL_PATTERN = /\b(?:code|configuration|dependency|implementation details?|library versions?|protocol details?|random seeds?|reproduc(?:e|ibility|ible)|sampling seeds?|software versions?|training seeds?)\b/u;
const BOUNDARY_SIGNAL_PATTERN = /\b(?:boundary|cross[- ]domain|cross[- ]task|distribution shift|external validity|generaliz(?:e|ation)|out[- ]of[- ]domain|transfer|unseen domain|unseen task)\b/u;

function isSubstantiveGapStatement(value: string | undefined): boolean {
  return Boolean(
    value &&
    value.length >= 20 &&
    !isSourceVisibilityLimitation(value) &&
    !/^(?:none|n\/a|unknown|unspecified|not applicable)$/iu.test(value)
  );
}

function isResearchGapSynthesisArtifact(value: unknown): value is ResearchGapSynthesisArtifact {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schema_version === 2 &&
    value.artifact_kind === "research_gap_semantic_synthesis" &&
    typeof value.semantics_version === "number" &&
    value.prompt_contract_version === RESEARCH_GAP_SYNTHESIS_PROMPT_CONTRACT_VERSION &&
    (value.status === "completed" || value.status === "safe_fallback") &&
    typeof value.run_id === "string" &&
    typeof value.research_cycle === "number" &&
    typeof value.collect_attempt_id === "string" &&
    typeof value.corpus_sha256 === "string" &&
    typeof value.evidence_sha256 === "string" &&
    typeof value.generated_at === "string" &&
    (value.method === "llm_proposer_reviewer_deterministic_validation" ||
      value.method === "deterministic_safe_fallback") &&
    Array.isArray(value.excluded_evidence) &&
    value.excluded_evidence.every(isExcludedEvidence) &&
    Array.isArray(value.proposed_clusters) &&
    value.proposed_clusters.every(isProposedCluster) &&
    Array.isArray(value.reviews) &&
    value.reviews.every(isClusterReview) &&
    Array.isArray(value.accepted_clusters) &&
    value.accepted_clusters.every(isSemanticCluster) &&
    isStringArray(value.unclustered_evidence_ids) &&
    isSynthesisDiagnostics(value.diagnostics) &&
    typeof value.content_sha256 === "string" &&
    hasConsistentSynthesisRelationships(value)
  );
}

function isExcludedEvidence(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.evidence_id === "string" &&
    [
      "source_visibility",
      "missing_identity",
      "insufficient_source_scope",
      "ungrounded_evidence",
      "insufficient_confidence",
      "no_supported_opportunity_signal"
    ].includes(String(value.reason));
}

function isSemanticCluster(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.cluster_id === "string" &&
    normalizeOpportunityType(value.opportunity_type) !== undefined &&
    typeof value.statement === "string" &&
    isStringArray(value.evidence_ids) &&
    uniqueStrings(value.evidence_ids).length >= 2 &&
    uniqueStrings(value.evidence_ids).length === value.evidence_ids.length &&
    isStringArray(value.paper_ids) &&
    uniqueStrings(value.paper_ids).length >= 2 &&
    uniqueStrings(value.paper_ids).length === value.paper_ids.length;
}

function isProposedCluster(value: unknown): boolean {
  return isSemanticCluster(value) &&
    (!isRecord(value) || value.rationale === undefined || typeof value.rationale === "string");
}

function isClusterReview(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const opportunityType = normalizeOpportunityType(value.opportunity_type);
  const validatedConditions = normalizeReviewConditions(value.validated_conditions);
  return typeof value.cluster_id === "string" &&
    opportunityType !== undefined &&
    (value.decision === "accept" || value.decision === "reject") &&
    (value.statement === undefined || typeof value.statement === "string") &&
    isStringArray(value.accepted_evidence_ids) &&
    uniqueStrings(value.accepted_evidence_ids).length === value.accepted_evidence_ids.length &&
    Array.isArray(value.validated_conditions) &&
    validatedConditions.length === value.validated_conditions.length &&
    (value.decision !== "accept" || (
      value.accepted_evidence_ids.length >= 2 &&
      hasRequiredReviewConditions(opportunityType as ResearchOpportunityType, validatedConditions)
    )) &&
    (value.reason === undefined || typeof value.reason === "string");
}

function hasConsistentSynthesisRelationships(value: Record<string, unknown>): boolean {
  const proposals = value.proposed_clusters as ProposedResearchGapCluster[];
  const reviews = value.reviews as ResearchGapClusterReview[];
  const accepted = value.accepted_clusters as ResearchGapSemanticCluster[];
  const diagnostics = value.diagnostics as ResearchGapSynthesisArtifact["diagnostics"];
  if (
    new Set(proposals.map((item) => item.cluster_id)).size !== proposals.length ||
    new Set(reviews.map((item) => item.cluster_id)).size !== reviews.length ||
    new Set(accepted.map((item) => item.cluster_id)).size !== accepted.length
  ) {
    return false;
  }
  const proposalById = new Map(proposals.map((item) => [item.cluster_id, item] as const));
  const reviewById = new Map(reviews.map((item) => [item.cluster_id, item] as const));
  for (const review of reviews) {
    const proposal = proposalById.get(review.cluster_id);
    if (!proposal || proposal.opportunity_type !== review.opportunity_type) {
      return false;
    }
    if (review.accepted_evidence_ids.some((evidenceId) => !proposal.evidence_ids.includes(evidenceId))) {
      return false;
    }
  }
  for (const cluster of accepted) {
    const proposal = proposalById.get(cluster.cluster_id);
    const review = reviewById.get(cluster.cluster_id);
    if (
      !proposal ||
      !review ||
      review.decision !== "accept" ||
      proposal.opportunity_type !== cluster.opportunity_type ||
      review.opportunity_type !== cluster.opportunity_type ||
      !sameStringSet(review.accepted_evidence_ids, cluster.evidence_ids) ||
      cluster.statement !== (review.statement ?? proposal.statement)
    ) {
      return false;
    }
  }
  const expectedAcceptedCounts = countClustersByOpportunityType(accepted);
  return RESEARCH_OPPORTUNITY_TYPES.every(
    (opportunityType) =>
      diagnostics.accepted_cluster_count_by_opportunity_type[opportunityType] ===
      expectedAcceptedCounts[opportunityType]
  );
}

function sameStringSet(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
}

function isSynthesisDiagnostics(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.eligible_evidence_count === "number" &&
    isOpportunityTypeCountRecord(value.eligible_evidence_count_by_opportunity_type) &&
    isOpportunityTypeCountRecord(value.accepted_cluster_count_by_opportunity_type) &&
    (value.proposer_output_sha256 === undefined || typeof value.proposer_output_sha256 === "string") &&
    (value.proposer_json_repaired === undefined || typeof value.proposer_json_repaired === "boolean") &&
    (value.reviewer_output_sha256 === undefined || typeof value.reviewer_output_sha256 === "string") &&
    (value.reviewer_json_repaired === undefined || typeof value.reviewer_json_repaired === "boolean") &&
    (value.failure_reason === undefined || typeof value.failure_reason === "string");
}

function isOpportunityTypeCountRecord(value: unknown): boolean {
  return isRecord(value) && RESEARCH_OPPORTUNITY_TYPES.every(
    (opportunityType) =>
      typeof value[opportunityType] === "number" &&
      Number.isInteger(value[opportunityType]) &&
      Number(value[opportunityType]) >= 0
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.map((item) => normalizeText(item)));
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SYNTHESIS_TIMEOUT_MS;
  }
  return Math.max(1_000, Math.min(Math.floor(value), DEFAULT_SYNTHESIS_TIMEOUT_MS));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim().slice(0, 500) || "research_gap_synthesis_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
