import { createHash } from "node:crypto";

import {
  buildTopicDiscoverySemanticAuditPrompt,
  TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CALLS,
  TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_FALLBACK_PARTITIONS,
  TOPIC_DISCOVERY_SEMANTIC_TIMEOUT_PARTITION_POLICY,
  TOPIC_DISCOVERY_PROVIDER_RECALL_FLOOR_PER_FAMILY,
  TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
  type TopicDiscoverySemanticReviewerInputPayload
} from "../collection/topicDiscoverySemanticAudit.js";
import {
  assessTopicDiscoveryPaperRelevance,
  buildTopicDiscoveryCorpusRelevanceProfile,
  TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS,
  TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY,
  TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION
} from "../collection/topicDiscoveryCorpusQuality.js";
import {
  TOPIC_DISCOVERY_CANDIDATE_SIDECAR_VERSION,
  TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT,
  TOPIC_DISCOVERY_SEMANTIC_REVIEW_INPUT_ARTIFACT_VERSION
} from "../collection/topicDiscoveryArtifactVersions.js";
import {
  buildTopicDiscoveryCandidateFamilySignature,
  normalizeTopicDiscoveryScientificTerms,
  TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
  TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
} from "../topicDiscoveryScientificTerms.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMPLETE_COUNT_FIELDS = [
  "requested_pairs",
  "reviewed_pairs",
  "budget_excluded_pairs",
  "returned_judgments",
  "direct_support",
  "application_only",
  "uncertain",
  "omitted_judgments",
  "duplicate_judgments",
  "conflicting_judgments",
  "invented_judgments",
  "malformed_judgments",
  "protocol_violations"
] as const;

type JsonRecord = Record<string, unknown>;
type SemanticVerdict = "direct_support" | "application_only" | "uncertain";
type PairSelectionSource = "lexical_match" | "provider_provenance_floor";

interface SemanticJudgment {
  paperId: string;
  familyId: string;
  verdict: SemanticVerdict;
  reason: string;
  evidenceSpan?: string;
}

interface ParsedJudgments {
  judgments: Map<string, SemanticJudgment>;
  malformed: boolean;
}

interface ParsedCandidatePool {
  requestedPairKeys: Set<string>;
  requestedPairSources: Map<string, PairSelectionSource>;
  candidates: Map<string, ParsedCandidate>;
  malformed: boolean;
  attemptMismatch: boolean;
}

interface ParsedCandidate {
  paperId: string;
  title: string;
  abstract: string;
  queryFamilies: string[];
  lexicalFamilies: string[];
  familyRanks: Map<string, number>;
  canonicalSearchSource: string;
  searchProviders: string[];
  selections: Array<{ familyId: string; selectionSource: PairSelectionSource }>;
  selected: boolean;
  published: boolean;
}

interface PlannedFamily {
  familyId: string;
  query: string;
  source: string;
  sharedAnchorTerms: string[];
  axisTerms: string[];
  lens: string;
  contributionIntent: string;
  contractSource: string;
  signature: string;
}

interface ParsedQueryPlan {
  families: Map<string, PlannedFamily>;
  sharedAnchorTerms: string[];
  malformed: boolean;
  attemptMismatch: boolean;
}

interface ParsedCorpus {
  rows: Map<string, {
    paperId: string;
    title: string;
    abstract: string;
    queryFamilies: string[];
  }>;
  malformed: boolean;
}

export interface TopicDiscoverySemanticLineageInput {
  expectedAttemptId?: string;
  qualityRaw?: string;
  semanticReviewInputRaw?: string;
  semanticReviewRaw?: string;
  candidatesRaw?: string;
  queryPlanRaw?: string;
  corpusRaw?: string;
}

export interface TopicDiscoverySemanticLineageValidation {
  trusted: boolean;
  reasonCodes: string[];
}

export function validateTopicDiscoverySemanticLineage(
  input: TopicDiscoverySemanticLineageInput
): TopicDiscoverySemanticLineageValidation {
  const reasons: string[] = [];
  const expectedAttemptId = exactText(input.expectedAttemptId);
  if (!expectedAttemptId) {
    reasons.push("collect_semantic_lineage_expected_attempt_missing");
  }

  const quality = parseArtifact(
    input.qualityRaw,
    "collect_semantic_lineage_quality_missing",
    "collect_semantic_lineage_quality_invalid",
    reasons
  );
  const semanticInput = parseArtifact(
    input.semanticReviewInputRaw,
    "collect_semantic_lineage_input_missing",
    "collect_semantic_lineage_input_invalid",
    reasons
  );
  const semanticReview = parseArtifact(
    input.semanticReviewRaw,
    "collect_semantic_lineage_review_missing",
    "collect_semantic_lineage_review_invalid",
    reasons
  );
  const candidatePool = parseCandidatePool(input.candidatesRaw, expectedAttemptId);
  const queryPlan = parseQueryPlan(input.queryPlanRaw, expectedAttemptId);
  const corpus = parseCorpus(input.corpusRaw);
  if (!input.candidatesRaw?.trim()) {
    reasons.push("collect_semantic_lineage_candidates_missing");
  } else if (candidatePool.malformed) {
    reasons.push("collect_semantic_lineage_candidates_invalid");
  }
  if (queryPlan.malformed) {
    reasons.push("collect_semantic_lineage_query_plan_invalid");
  }
  if (corpus.malformed) {
    reasons.push("collect_semantic_lineage_corpus_invalid");
  }

  const payload = recordValue(semanticInput?.payload);
  const qualitySemanticReview = recordValue(quality?.semantic_review);

  if (
    quality
    && (
      quality.version !== TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION
      || quality.strategy !== TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY
      || quality.passed !== true
      || qualitySemanticReview?.version !== TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION
    )
  ) {
    reasons.push("collect_semantic_lineage_artifact_version_mismatch");
  }
  if (
    semanticInput
    && (
      semanticInput.version
        !== TOPIC_DISCOVERY_SEMANTIC_REVIEW_INPUT_ARTIFACT_VERSION
      || semanticInput.evidence_status !== "semantic_review_input_only"
      || semanticInput.paper_evidence_allowed !== false
      || !payload
    )
  ) {
    reasons.push("collect_semantic_lineage_input_invalid");
  }
  if (
    semanticReview
    && (
      semanticReview.version !== TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION
      || semanticReview.evidence_status !== "semantic_review_judgment_only"
      || semanticReview.paper_evidence_allowed !== false
    )
  ) {
    reasons.push("collect_semantic_lineage_artifact_version_mismatch");
  }
  if (payload && payload.version !== TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION) {
    reasons.push("collect_semantic_lineage_payload_version_mismatch");
  }
  if (
    quality
    && payload
    && (
      quality.term_normalization_version !== TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
      || quality.candidate_recall_semantics_version
        !== TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION
      || payload.term_normalization_version !== TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
      || payload.candidate_recall_semantics_version
        !== TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION
    )
  ) {
    reasons.push("collect_semantic_lineage_semantics_version_mismatch");
  }

  if (
    expectedAttemptId
    && (
      exactText(quality?.collect_attempt_id) !== expectedAttemptId
      || exactText(semanticInput?.collect_attempt_id) !== expectedAttemptId
      || exactText(semanticReview?.collect_attempt_id) !== expectedAttemptId
      || candidatePool.attemptMismatch
      || queryPlan.attemptMismatch
    )
  ) {
    reasons.push("collect_semantic_lineage_attempt_mismatch");
  }

  const payloadHash = payload ? hashJsonValue(payload) : undefined;
  const payloadBytes = payload
    ? Buffer.byteLength(JSON.stringify(payload), "utf8")
    : undefined;
  if (
    payloadHash
    && (
      exactSha256(semanticInput?.payload_sha256) !== payloadHash
      || exactSha256(semanticReview?.reviewer_input_sha256) !== payloadHash
      || exactSha256(qualitySemanticReview?.reviewer_input_sha256) !== payloadHash
      || integerValue(semanticReview?.reviewer_input_bytes) !== payloadBytes
      || integerValue(qualitySemanticReview?.reviewer_input_bytes) !== payloadBytes
    )
  ) {
    reasons.push("collect_semantic_lineage_input_hash_mismatch");
  }
  if (
    semanticReview
    && payloadHash
    && !validateSemanticReviewRecoveryTrace(
      semanticReview.recovery,
      payloadHash,
      semanticReview
    )
  ) {
    reasons.push("collect_semantic_lineage_recovery_mismatch");
  }

  if (
    qualitySemanticReview
    && semanticReview
    && (
      qualitySemanticReview.status !== "complete"
      || semanticReview.status !== "complete"
      || exactSha256(qualitySemanticReview.prompt_sha256)
        !== exactSha256(semanticReview.prompt_sha256)
      || exactSha256(qualitySemanticReview.response_sha256)
        !== exactSha256(semanticReview.response_sha256)
    )
  ) {
    reasons.push("collect_semantic_lineage_status_mismatch");
  }
  if (
    !payload
    || !validateSemanticExecutionTrace({
      execution: semanticReview?.execution,
      qualityExecution: qualitySemanticReview?.execution,
      payload,
      limits: semanticReview?.limits,
      status: semanticReview?.status,
      promptSha256: semanticReview?.prompt_sha256,
      responseSha256: semanticReview?.response_sha256
    })
  ) {
    reasons.push("collect_semantic_lineage_execution_mismatch");
  }

  const payloadPairs = parsePairKeys(payload?.requested_pairs);
  const payloadPaperIds = parseDeclaredIds(payload?.papers, "paper_id");
  const payloadFamilyIds = parseDeclaredIds(payload?.family_contracts, "family_id");
  const reviewJudgments = parseJudgments(semanticReview?.judgments);
  const qualityJudgments = parseJudgments(quality?.semantic_judgments);
  const reviewPairKeys = new Set(reviewJudgments.judgments.keys());
  const qualityPairKeys = new Set(qualityJudgments.judgments.keys());
  if (
    !recallMatchesSelectionSources(
      semanticReview?.recall,
      payloadPairs.sources
    )
    || !recallMatchesSelectionSources(
      qualitySemanticReview?.recall,
      payloadPairs.sources
    )
  ) {
    reasons.push("collect_semantic_lineage_recall_mismatch");
  }
  const payloadReferencesValid = Array.from(payloadPairs.keys).every((key) => {
    const [paperId, familyId] = parsePairKey(key);
    return payloadPaperIds.ids.has(paperId) && payloadFamilyIds.ids.has(familyId);
  });
  if (
    payloadPairs.malformed
    || payloadPaperIds.malformed
    || payloadFamilyIds.malformed
    || reviewJudgments.malformed
    || qualityJudgments.malformed
    || payloadPairs.keys.size === 0
    || !payloadReferencesValid
    || !sameKeySet(candidatePool.requestedPairKeys, payloadPairs.keys)
    || !sameSelectionSources(candidatePool.requestedPairSources, payloadPairs.sources)
    || !sameKeySet(payloadPairs.keys, reviewPairKeys)
    || !sameKeySet(payloadPairs.keys, qualityPairKeys)
  ) {
    reasons.push("collect_semantic_lineage_pair_universe_mismatch");
  }
  if (!sameJudgments(reviewJudgments.judgments, qualityJudgments.judgments)) {
    reasons.push("collect_semantic_lineage_judgment_mismatch");
  }

  const verdictCounts = countVerdicts(reviewJudgments.judgments.values());
  if (
    !completeCountsMatch(
      semanticReview?.counts,
      payloadPairs.keys.size,
      verdictCounts
    )
    || !completeCountsMatch(
      qualitySemanticReview?.counts,
      payloadPairs.keys.size,
      verdictCounts
    )
    || !sameCountRecord(semanticReview?.counts, qualitySemanticReview?.counts)
  ) {
    reasons.push("collect_semantic_lineage_count_mismatch");
  }

  reasons.push(...validateIndependentScientificAuthorization({
    quality,
    payload,
    queryPlan,
    candidatePool,
    corpus,
    judgments: reviewJudgments.judgments,
    selectionSources: payloadPairs.sources
  }));

  const reasonCodes = [...new Set(reasons)];
  return {
    trusted: reasonCodes.length === 0,
    reasonCodes
  };
}

function validateSemanticReviewRecoveryTrace(
  value: unknown,
  payloadHash: string,
  semanticReview: JsonRecord
): boolean {
  if (value === undefined) {
    return true;
  }
  const recovery = recordValue(value);
  if (
    !recovery
    || recovery.policy !== "frozen_input_single_retry_v1"
    || integerValue(recovery.maximum_attempts) !== 2
    || exactSha256(recovery.frozen_input_sha256) !== payloadHash
    || recovery.input_integrity_verified !== true
    || recovery.exhausted !== false
    || recovery.exhaustion_reason !== undefined
    || !Array.isArray(recovery.attempts)
  ) {
    return false;
  }
  const attempts = recovery.attempts.map(recordValue);
  const recoveryPerformed = recovery.recovery_performed === true;
  if (
    attempts.some((attempt) => !attempt)
    || attempts.length !== (recoveryPerformed ? 2 : 1)
  ) {
    return false;
  }
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    if (
      integerValue(attempt.attempt) !== index + 1
      || exactSha256(attempt.reviewer_input_sha256) !== payloadHash
      || !["complete", "partial", "operational_failure"].includes(
        exactText(attempt.status) ?? ""
      )
      || !exactSha256(attempt.prompt_sha256)
      || !exactSha256(attempt.response_sha256)
      || !integerValue(attempt.calls_started)
      || !Array.isArray(attempt.reasons)
      || attempt.reasons.some((reason) => typeof reason !== "string")
    ) {
      return false;
    }
  }
  const first = attempts[0]!;
  const finalAttempt = attempts.at(-1)!;
  return (
    recoveryPerformed
      ? first.status !== "complete" && finalAttempt.status === "complete"
      : first.status === "complete"
  )
    && finalAttempt.status === semanticReview.status
    && exactSha256(finalAttempt.prompt_sha256)
      === exactSha256(semanticReview.prompt_sha256)
    && exactSha256(finalAttempt.response_sha256)
      === exactSha256(semanticReview.response_sha256)
    && integerValue(finalAttempt.calls_started)
      === integerValue(recordValue(semanticReview.execution)?.calls_started);
}

function validateSemanticExecutionTrace(input: {
  execution: unknown;
  qualityExecution: unknown;
  payload: JsonRecord;
  limits: unknown;
  status: unknown;
  promptSha256: unknown;
  responseSha256: unknown;
}): boolean {
  const execution = recordValue(input.execution);
  const limits = recordValue(input.limits);
  if (
    !execution
    || JSON.stringify(input.execution) !== JSON.stringify(input.qualityExecution)
    || input.status !== "complete"
    || !Array.isArray(execution.calls)
    || !Array.isArray(input.payload.requested_pairs)
    || !Array.isArray(input.payload.papers)
    || !Array.isArray(input.payload.family_contracts)
  ) {
    return false;
  }
  const payload = input.payload as unknown as TopicDiscoverySemanticReviewerInputPayload;
  const pairCount = payload.requested_pairs.length;
  const timeoutMs = integerValue(limits?.timeout_ms);
  const expectedPartitionSize = Math.max(
    1,
    Math.ceil(pairCount / TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_FALLBACK_PARTITIONS)
  );
  if (
    pairCount === 0
    || !timeoutMs
    || execution.policy !== TOPIC_DISCOVERY_SEMANTIC_TIMEOUT_PARTITION_POLICY
    || integerValue(execution.maximum_calls)
      !== TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CALLS
    || integerValue(execution.maximum_fallback_partitions)
      !== TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_FALLBACK_PARTITIONS
    || integerValue(execution.total_deadline_ms)
      !== Math.min(480_000, timeoutMs * 4)
    || integerValue(execution.fallback_partition_size) !== expectedPartitionSize
    || integerValue(execution.calls_started) !== execution.calls.length
    || execution.calls.length < 1
    || execution.calls.length > TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CALLS
  ) {
    return false;
  }
  const prompts: string[] = [];
  const responseHashes: string[] = [];
  let cumulativeBytes = 0;
  let completedCalls = 0;
  let expectedFallbackStart = 0;
  for (let index = 0; index < execution.calls.length; index += 1) {
    const call = recordValue(execution.calls[index]);
    if (!call || integerValue(call.call_index) !== index + 1) return false;
    const start = integerValue(call.pair_start_index);
    const end = integerValue(call.pair_end_index_exclusive);
    const count = integerValue(call.requested_pair_count);
    const reviewerHash = exactSha256(call.reviewer_input_sha256);
    const reviewerBytes = integerValue(call.reviewer_input_bytes);
    const promptHash = exactSha256(call.prompt_sha256);
    const responseHash = exactSha256(call.response_sha256);
    if (
      start === undefined
      || end === undefined
      || count === undefined
      || !reviewerHash
      || reviewerBytes === undefined
      || !promptHash
      || !responseHash
      || end <= start
      || count !== end - start
    ) {
      return false;
    }
    const callPayload = index === 0
      ? payload
      : projectSemanticExecutionPayload(payload, start, end);
    const prompt = buildTopicDiscoverySemanticAuditPrompt(callPayload);
    if (
      reviewerHash !== hashJsonValue(callPayload)
      || reviewerBytes !== Buffer.byteLength(JSON.stringify(callPayload), "utf8")
      || promptHash !== hashText(prompt)
    ) {
      return false;
    }
    if (index === 0) {
      if (
        call.mode !== "primary"
        || start !== 0
        || end !== pairCount
        || (execution.calls.length === 1
          ? call.outcome !== "complete" || call.reason !== undefined
          : call.outcome !== "timeout" || call.reason !== "semantic_audit_timeout")
      ) {
        return false;
      }
    } else {
      if (
        call.mode !== "timeout_partition"
        || start !== expectedFallbackStart
        || end > pairCount
        || end - start > expectedPartitionSize
        || call.outcome !== "complete"
        || call.reason !== undefined
      ) {
        return false;
      }
      expectedFallbackStart = end;
    }
    if (call.outcome === "complete" || call.outcome === "partial") {
      completedCalls += 1;
    }
    cumulativeBytes += reviewerBytes;
    prompts.push(prompt);
    responseHashes.push(responseHash);
  }
  const multiCall = execution.calls.length > 1;
  return (!multiCall || expectedFallbackStart === pairCount)
    && integerValue(execution.calls_completed) === completedCalls
    && integerValue(execution.cumulative_reviewer_input_bytes) === cumulativeBytes
    && exactSha256(input.promptSha256) === hashText(
      prompts.join("\n--- semantic-review-call ---\n")
    )
    && exactSha256(input.responseSha256) === (multiCall
      ? hashText(JSON.stringify(responseHashes))
      : responseHashes[0]);
}

function projectSemanticExecutionPayload(
  payload: TopicDiscoverySemanticReviewerInputPayload,
  start: number,
  end: number
): TopicDiscoverySemanticReviewerInputPayload {
  const requestedPairs = payload.requested_pairs.slice(start, end);
  const paperIds = new Set(requestedPairs.map((pair) => pair.paper_id));
  const familyIds = new Set(requestedPairs.map((pair) => pair.family_id));
  return {
    version: payload.version,
    term_normalization_version: payload.term_normalization_version,
    candidate_recall_semantics_version:
      payload.candidate_recall_semantics_version,
    papers: payload.papers.filter((paper) => paperIds.has(paper.paper_id)),
    family_contracts: payload.family_contracts.filter(
      (family) => familyIds.has(family.family_id)
    ),
    requested_pairs: requestedPairs
  };
}

function validateIndependentScientificAuthorization(input: {
  quality: JsonRecord | undefined;
  payload: JsonRecord | undefined;
  queryPlan: ParsedQueryPlan;
  candidatePool: ParsedCandidatePool;
  corpus: ParsedCorpus;
  judgments: ReadonlyMap<string, SemanticJudgment>;
  selectionSources: ReadonlyMap<string, PairSelectionSource>;
}): string[] {
  if (
    !input.quality
    || !input.payload
    || input.queryPlan.malformed
    || input.candidatePool.malformed
    || input.corpus.malformed
  ) {
    return ["collect_semantic_lineage_scientific_authorization_unverifiable"];
  }
  const reasons: string[] = [];
  const thresholds = recordValue(input.quality.thresholds);
  const expectedThresholds: Record<string, number> = {
    minimum_shared_anchor_terms: 2,
    minimum_relevant_papers:
      TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS.minimumRelevantPapers,
    minimum_covered_query_families:
      TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS.minimumCoveredQueryFamilies,
    minimum_relevant_papers_per_family:
      TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS.minimumDirectSupportPerFamily,
    minimum_direct_support_per_family:
      TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS.minimumDirectSupportPerFamily,
    minimum_semantic_precision_per_family:
      TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS.minimumSemanticPrecisionPerFamily,
    maximum_anchor_window_tokens: 12,
    minimum_axis_term_matches: 2,
    minimum_axis_term_match_ratio: 2 / 3,
    maximum_anchor_axis_window_tokens: 24
  };
  if (
    !thresholds
    || Object.entries(expectedThresholds).some(
      ([key, expected]) => numberValue(thresholds[key]) !== expected
    )
    || !Array.isArray(input.quality.reasons)
    || input.quality.reasons.length !== 0
  ) {
    reasons.push("collect_semantic_lineage_quality_threshold_mismatch");
  }

  const payloadFamilies = new Map<string, JsonRecord>();
  let payloadFamilyMalformed = !Array.isArray(input.payload.family_contracts);
  for (const value of Array.isArray(input.payload.family_contracts)
    ? input.payload.family_contracts
    : []) {
    const family = recordValue(value);
    const familyId = exactText(family?.family_id);
    if (!familyId || payloadFamilies.has(familyId)) {
      payloadFamilyMalformed = true;
      continue;
    }
    payloadFamilies.set(familyId, family!);
  }
  if (
    payloadFamilyMalformed
    || payloadFamilies.size !== input.queryPlan.families.size
    || Array.from(input.queryPlan.families.values()).some((planned) => {
      const payloadFamily = payloadFamilies.get(planned.familyId);
      const axisTerms = exactStringArray(payloadFamily?.axis_terms, false);
      return !payloadFamily
        || exactText(payloadFamily.query) !== planned.query
        || !axisTerms
        || !sameKeySet(new Set(axisTerms), new Set(planned.axisTerms))
        || exactText(payloadFamily.lens) !== planned.lens
        || exactText(payloadFamily.contribution_intent)
          !== planned.contributionIntent;
    })
  ) {
    reasons.push("collect_semantic_lineage_family_contract_mismatch");
  }

  const payloadPapers = new Map<string, { title: string; abstract: string }>();
  let payloadPaperMalformed = !Array.isArray(input.payload.papers);
  for (const value of Array.isArray(input.payload.papers) ? input.payload.papers : []) {
    const paper = recordValue(value);
    const paperId = exactText(paper?.paper_id);
    if (
      !paperId
      || payloadPapers.has(paperId)
      || typeof paper?.title !== "string"
      || typeof paper.abstract !== "string"
    ) {
      payloadPaperMalformed = true;
      continue;
    }
    payloadPapers.set(paperId, { title: paper.title, abstract: paper.abstract });
  }
  const semanticReview = recordValue(input.quality.semantic_review);
  const semanticLimits = recordValue(semanticReview?.limits);
  const abstractChars = integerValue(semanticLimits?.abstract_chars);
  const requestedPaperIds = new Set(
    Array.from(input.selectionSources.keys()).map((key) => parsePairKey(key)[0])
  );
  if (
    payloadPaperMalformed
    || !abstractChars
    || payloadPapers.size !== requestedPaperIds.size
    || Array.from(requestedPaperIds).some((paperId) => {
      const payloadPaper = payloadPapers.get(paperId);
      const candidate = input.candidatePool.candidates.get(paperId);
      return !payloadPaper
        || !candidate
        || payloadPaper.title !== candidate.title
        || payloadPaper.abstract !== Array.from(candidate.abstract)
          .slice(0, abstractChars)
          .join("");
    })
  ) {
    reasons.push("collect_semantic_lineage_reviewer_input_projection_mismatch");
  }

  const profile = buildTopicDiscoveryCorpusRelevanceProfile(
    Array.from(input.queryPlan.families.values()).map((family) => ({
      queryFamily: family.familyId,
      query: family.query,
      source: family.source,
      sharedAnchorTerms: family.sharedAnchorTerms,
      axisTerms: family.axisTerms,
      lens: family.lens,
      contributionIntent: family.contributionIntent,
      contractSource: family.contractSource === "planner_declared"
        ? "planner_declared"
        : "bounded_inference"
    }))
  );
  const lexicalCounts = new Map<string, number>();
  const lexicalPaperIds = new Set<string>();
  let anchorProximatePapers = 0;
  let anchorAxisProximatePapers = 0;
  let lexicalProjectionMismatch = false;
  for (const candidate of input.candidatePool.candidates.values()) {
    if (candidate.queryFamilies.some(
      (familyId) => !input.queryPlan.families.has(familyId)
    )) {
      lexicalProjectionMismatch = true;
    }
    const relevance = assessTopicDiscoveryPaperRelevance({
      row: {
        paper_id: candidate.paperId,
        title: candidate.title,
        abstract: candidate.abstract,
        authors: []
      },
      profile,
      eligibleQueryFamilies: new Set(candidate.queryFamilies)
    });
    if (relevance.anchorProximate) anchorProximatePapers += 1;
    if (relevance.anchorAxisProximate) anchorAxisProximatePapers += 1;
    const recomputedFamilies = new Set(relevance.matchedQueryFamilies);
    if (!sameKeySet(recomputedFamilies, new Set(candidate.lexicalFamilies))) {
      lexicalProjectionMismatch = true;
    }
    if (recomputedFamilies.size > 0) lexicalPaperIds.add(candidate.paperId);
    for (const familyId of recomputedFamilies) {
      lexicalCounts.set(familyId, (lexicalCounts.get(familyId) ?? 0) + 1);
    }
  }
  if (lexicalProjectionMismatch) {
    reasons.push("collect_semantic_lineage_lexical_projection_mismatch");
  }
  const expectedSelectionSources = new Map<string, PairSelectionSource>();
  for (const familyId of input.queryPlan.families.keys()) {
    const rankedCandidates = Array.from(input.candidatePool.candidates.values())
      .filter((candidate) => candidate.familyRanks.has(familyId))
      .sort((left, right) =>
        left.familyRanks.get(familyId)! - right.familyRanks.get(familyId)!
        || left.paperId.localeCompare(right.paperId)
      );
    const selectedPaperIds = new Set<string>();
    for (const candidate of rankedCandidates) {
      if (!candidate.lexicalFamilies.includes(familyId)) continue;
      expectedSelectionSources.set(
        pairKey(candidate.paperId, familyId),
        "lexical_match"
      );
      selectedPaperIds.add(candidate.paperId);
    }
    if (selectedPaperIds.size < TOPIC_DISCOVERY_PROVIDER_RECALL_FLOOR_PER_FAMILY) {
      for (const candidate of rankedCandidates) {
        if (
          selectedPaperIds.size >= TOPIC_DISCOVERY_PROVIDER_RECALL_FLOOR_PER_FAMILY
        ) {
          break;
        }
        if (selectedPaperIds.has(candidate.paperId)) continue;
        expectedSelectionSources.set(
          pairKey(candidate.paperId, familyId),
          "provider_provenance_floor"
        );
        selectedPaperIds.add(candidate.paperId);
      }
    }
  }
  if (!sameSelectionSources(expectedSelectionSources, input.selectionSources)) {
    reasons.push("collect_semantic_lineage_family_rank_selection_mismatch");
  }

  type FamilyStats = {
    lexical: number;
    reviewed: number;
    provider: number;
    direct: number;
    application: number;
    uncertain: number;
  };
  const familyStats = new Map<string, FamilyStats>(
    Array.from(input.queryPlan.families.keys()).map((familyId) => [familyId, {
      lexical: lexicalCounts.get(familyId) ?? 0,
      reviewed: 0,
      provider: 0,
      direct: 0,
      application: 0,
      uncertain: 0
    }])
  );
  const directFamiliesByPaper = new Map<string, Set<string>>();
  const directPaperIds = new Set<string>();
  let directEvidenceInvalid = false;
  for (const [key, judgment] of input.judgments) {
    const source = input.selectionSources.get(key);
    const stats = familyStats.get(judgment.familyId);
    const candidate = input.candidatePool.candidates.get(judgment.paperId);
    if (!source || !stats || !candidate) {
      directEvidenceInvalid = true;
      continue;
    }
    stats.reviewed += 1;
    if (source === "provider_provenance_floor") stats.provider += 1;
    if (judgment.verdict === "direct_support") {
      stats.direct += 1;
      directPaperIds.add(judgment.paperId);
      const directFamilies = directFamiliesByPaper.get(judgment.paperId)
        ?? new Set<string>();
      directFamilies.add(judgment.familyId);
      directFamiliesByPaper.set(judgment.paperId, directFamilies);
      if (
        !judgment.evidenceSpan
        || (!candidate.title.includes(judgment.evidenceSpan)
          && !candidate.abstract.includes(judgment.evidenceSpan))
      ) {
        directEvidenceInvalid = true;
      }
    } else if (judgment.verdict === "application_only") {
      stats.application += 1;
    } else {
      stats.uncertain += 1;
    }
  }
  if (directEvidenceInvalid) {
    reasons.push("collect_semantic_lineage_direct_evidence_invalid");
  }

  const qualifyingFamilies = new Set(
    Array.from(familyStats.entries()).flatMap(([familyId, stats]) => {
      const precision = stats.reviewed > 0 ? stats.direct / stats.reviewed : 0;
      return stats.direct
          >= TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS.minimumDirectSupportPerFamily
        && precision
          >= TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS.minimumSemanticPrecisionPerFamily
        ? [familyId]
        : [];
    })
  );
  const qualifyingSignatures = new Set(
    Array.from(qualifyingFamilies).flatMap((familyId) => {
      const family = input.queryPlan.families.get(familyId);
      return family ? [family.signature] : [];
    })
  );

  const retainedIds = exactStringArray(input.quality.retained_paper_ids, false);
  const excludedIds = exactStringArray(input.quality.excluded_paper_ids, true);
  const retained = new Set(retainedIds ?? []);
  const excluded = new Set(excludedIds ?? []);
  const candidateIds = new Set(input.candidatePool.candidates.keys());
  const inventory = new Set([...retained, ...excluded]);
  const corpusIds = new Set(input.corpus.rows.keys());
  let inventoryMismatch = !retainedIds
    || !excludedIds
    || Array.from(retained).some((paperId) => excluded.has(paperId))
    || !sameKeySet(inventory, candidateIds)
    || !sameKeySet(retained, corpusIds)
    || retained.size
      < TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS.minimumRelevantPapers
    || directPaperIds.size
      < TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS.minimumRelevantPapers
    || qualifyingSignatures.size
      < TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS.minimumCoveredQueryFamilies;
  const retainedCounts = new Map<string, number>();
  for (const [paperId, row] of input.corpus.rows) {
    const candidate = input.candidatePool.candidates.get(paperId);
    const directFamilies = directFamiliesByPaper.get(paperId) ?? new Set<string>();
    if (
      !candidate
      || row.title !== candidate.title
      || row.abstract !== candidate.abstract
      || !sameKeySet(new Set(row.queryFamilies), directFamilies)
      || !Array.from(directFamilies).some((familyId) => qualifyingFamilies.has(familyId))
    ) {
      inventoryMismatch = true;
    }
    for (const familyId of row.queryFamilies) {
      retainedCounts.set(familyId, (retainedCounts.get(familyId) ?? 0) + 1);
    }
  }
  if (inventoryMismatch) {
    reasons.push("collect_semantic_lineage_quality_inventory_mismatch");
  }
  if (Array.from(input.candidatePool.candidates.values()).some((candidate) =>
    candidate.selected !== retained.has(candidate.paperId)
    || candidate.published !== retained.has(candidate.paperId)
  )) {
    reasons.push("collect_semantic_lineage_publication_mismatch");
  }

  const qualityFamilies = new Map<string, JsonRecord>();
  let qualityFamilyMismatch = !Array.isArray(input.quality.query_families);
  for (const value of Array.isArray(input.quality.query_families)
    ? input.quality.query_families
    : []) {
    const family = recordValue(value);
    const familyId = exactText(family?.query_family);
    if (!familyId || qualityFamilies.has(familyId)) {
      qualityFamilyMismatch = true;
      continue;
    }
    qualityFamilies.set(familyId, family!);
  }
  if (
    qualityFamilies.size !== input.queryPlan.families.size
    || Array.from(input.queryPlan.families.values()).some((planned) => {
      const family = qualityFamilies.get(planned.familyId);
      const stats = familyStats.get(planned.familyId)!;
      const axisTerms = exactStringArray(family?.axis_terms, false);
      const precision = stats.reviewed > 0 ? stats.direct / stats.reviewed : 0;
      return !family
        || exactText(family.query) !== planned.query
        || exactText(family.source) !== planned.source
        || !axisTerms
        || !sameKeySet(new Set(axisTerms), new Set(planned.axisTerms))
        || exactText(family.lens) !== planned.lens
        || exactText(family.contribution_intent) !== planned.contributionIntent
        || exactText(family.contract_source) !== planned.contractSource
        || exactText(family.canonical_family_signature) !== planned.signature
        || numberValue(family.lexical_relevant_paper_count) !== stats.lexical
        || numberValue(family.semantic_reviewed_paper_count) !== stats.reviewed
        || numberValue(family.provider_recall_paper_count) !== stats.provider
        || numberValue(family.direct_support_paper_count) !== stats.direct
        || numberValue(family.application_only_paper_count) !== stats.application
        || numberValue(family.uncertain_paper_count) !== stats.uncertain
        || numberValue(family.semantic_precision) !== precision
        || numberValue(family.retained_paper_count)
          !== (retainedCounts.get(planned.familyId) ?? 0)
        || numberValue(family.relevant_paper_count)
          !== (retainedCounts.get(planned.familyId) ?? 0);
    })
  ) {
    qualityFamilyMismatch = true;
  }
  if (qualityFamilyMismatch) {
    reasons.push("collect_semantic_lineage_quality_family_mismatch");
  }

  const observed = recordValue(input.quality.observed);
  const expectedRelevantShare = input.candidatePool.candidates.size > 0
    ? directPaperIds.size / input.candidatePool.candidates.size
    : 0;
  const applicationPairs = Array.from(familyStats.values())
    .reduce((sum, stats) => sum + stats.application, 0);
  const uncertainPairs = Array.from(familyStats.values())
    .reduce((sum, stats) => sum + stats.uncertain, 0);
  const observedMismatches = !observed
    ? ["missing"]
    : [
        ["total_papers", numberValue(observed.total_papers) === input.candidatePool.candidates.size],
        ["relevant_papers", numberValue(observed.relevant_papers) === retained.size],
        ["relevant_share", numberValue(observed.relevant_share) === expectedRelevantShare],
        ["lexical_relevant_papers", numberValue(observed.lexical_relevant_papers) === lexicalPaperIds.size],
        ["semantic_requested_papers", numberValue(observed.semantic_requested_papers) === requestedPaperIds.size],
        ["direct_support_papers", numberValue(observed.direct_support_papers) === directPaperIds.size],
        ["application_only_pairs", numberValue(observed.application_only_pairs) === applicationPairs],
        ["uncertain_pairs", numberValue(observed.uncertain_pairs) === uncertainPairs],
        ["shared_anchor_terms", sameKeySet(
          new Set(exactStringArray(observed.shared_anchor_terms, false) ?? []),
          new Set(input.queryPlan.sharedAnchorTerms)
        )],
        ["required_anchor_matches_per_paper", numberValue(observed.required_anchor_matches_per_paper) === profile.sharedAnchorTerms.length],
        ["anchor_proximate_papers", numberValue(observed.anchor_proximate_papers) === anchorProximatePapers],
        ["anchor_axis_proximate_papers", numberValue(observed.anchor_axis_proximate_papers) === anchorAxisProximatePapers],
        ["covered_query_families", numberValue(observed.covered_query_families) === qualifyingSignatures.size]
      ].flatMap(([field, matches]) => matches ? [] : [String(field)]);
  if (observedMismatches.length > 0) {
    reasons.push("collect_semantic_lineage_quality_observed_mismatch");
    reasons.push(...observedMismatches.map(
      (field) => `collect_semantic_lineage_quality_observed_${field}_mismatch`
    ));
  }

  return reasons;
}

function parseArtifact(
  raw: string | undefined,
  missingReason: string,
  invalidReason: string,
  reasons: string[]
): JsonRecord | undefined {
  if (!raw?.trim()) {
    reasons.push(missingReason);
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = recordValue(parsed);
    if (!record) {
      reasons.push(invalidReason);
    }
    return record;
  } catch {
    reasons.push(invalidReason);
    return undefined;
  }
}

function parseCandidatePool(
  raw: string | undefined,
  expectedAttemptId: string | undefined
): ParsedCandidatePool {
  const requestedPairKeys = new Set<string>();
  const requestedPairSources = new Map<string, PairSelectionSource>();
  const candidates = new Map<string, ParsedCandidate>();
  const paperIds = new Set<string>();
  let malformed = false;
  let attemptMismatch = false;
  const lines = raw?.split(/\r?\n/u).filter((line) => line.trim()) ?? [];
  if (lines.length === 0) {
    return {
      requestedPairKeys,
      requestedPairSources,
      candidates,
      malformed: true,
      attemptMismatch
    };
  }
  for (const line of lines) {
    let candidate: JsonRecord | undefined;
    try {
      candidate = recordValue(JSON.parse(line) as unknown);
    } catch {
      malformed = true;
      continue;
    }
    const paperId = exactText(candidate?.paper_id);
    const queryFamilies = exactStringArray(candidate?.query_families, false);
    const lexicalFamilies = exactStringArray(
      candidate?.lexical_matched_query_families,
      true
    );
    const requestedFamilies = exactStringArray(
      candidate?.semantic_review_requested_query_families,
      true
    );
    const familyRanks = parseFamilyRetrievalRanks(candidate?.family_retrieval_ranks);
    const canonicalSearchSource = paperSearchProvider(
      candidate?.canonical_search_source
    );
    const searchProviders = exactStringArray(candidate?.search_providers, false);
    const selections = parseCandidateSelections(candidate?.semantic_review_selections);
    const requested = candidate?.semantic_review_requested;
    if (
      !paperId
      || paperIds.has(paperId)
      || candidate?.schema_version !== TOPIC_DISCOVERY_CANDIDATE_SIDECAR_VERSION
      || typeof candidate?.title !== "string"
      || typeof candidate.abstract !== "string"
      || !queryFamilies
      || !lexicalFamilies
      || !requestedFamilies
      || familyRanks.malformed
      || !canonicalSearchSource
      || !searchProviders
      || searchProviders.some((provider) => !paperSearchProvider(provider))
      || !searchProviders.includes(canonicalSearchSource)
      || selections.malformed
      || typeof requested !== "boolean"
      || requested !== (selections.values.length > 0)
      || !sameOrderedValues(
        requestedFamilies,
        selections.values.map((selection) => selection.familyId)
      )
      || lexicalFamilies.some((familyId) => !queryFamilies.includes(familyId))
      || !sameKeySet(new Set(familyRanks.values.keys()), new Set(queryFamilies))
      || selections.values.some((selection) =>
        !queryFamilies.includes(selection.familyId)
        || (selection.selectionSource === "lexical_match")
          !== lexicalFamilies.includes(selection.familyId)
      )
      || lexicalFamilies.some((familyId) =>
        !selections.values.some((selection) =>
          selection.familyId === familyId
          && selection.selectionSource === "lexical_match"
        )
      )
      || candidate.evidence_status !== "semantic_screening_candidate_only"
      || candidate.paper_evidence_allowed !== false
      || candidate.retrieval_status !== "retrieved_governance_usable"
      || typeof candidate.selected_by_semantic_quality !== "boolean"
      || typeof candidate.published_in_corpus !== "boolean"
    ) {
      malformed = true;
      continue;
    }
    paperIds.add(paperId);
    if (
      expectedAttemptId
      && exactText(candidate.collect_attempt_id) !== expectedAttemptId
    ) {
      attemptMismatch = true;
    }
    if (requested) {
      for (const selection of selections.values) {
        const key = pairKey(paperId, selection.familyId);
        if (requestedPairKeys.has(key)) {
          malformed = true;
          continue;
        }
        requestedPairKeys.add(key);
        requestedPairSources.set(key, selection.selectionSource);
      }
    }
    candidates.set(paperId, {
      paperId,
      title: candidate.title,
      abstract: candidate.abstract,
      queryFamilies,
      lexicalFamilies,
      familyRanks: familyRanks.values,
      canonicalSearchSource,
      searchProviders,
      selections: selections.values,
      selected: candidate.selected_by_semantic_quality,
      published: candidate.published_in_corpus
    });
  }
  const ranksByFamily = new Map<string, number[]>();
  for (const candidate of candidates.values()) {
    for (const [familyId, rank] of candidate.familyRanks) {
      const ranks = ranksByFamily.get(familyId) ?? [];
      ranks.push(rank);
      ranksByFamily.set(familyId, ranks);
    }
  }
  if (Array.from(ranksByFamily.values()).some((ranks) => {
    const sorted = [...ranks].sort((left, right) => left - right);
    return new Set(sorted).size !== sorted.length
      || sorted.some((rank, index) => rank !== index + 1);
  })) {
    malformed = true;
  }
  return {
    requestedPairKeys,
    requestedPairSources,
    candidates,
    malformed,
    attemptMismatch
  };
}

function parseQueryPlan(
  raw: string | undefined,
  expectedAttemptId: string | undefined
): ParsedQueryPlan {
  const families = new Map<string, PlannedFamily>();
  let malformed = false;
  let attemptMismatch = false;
  let artifact: JsonRecord | undefined;
  try {
    artifact = recordValue(JSON.parse(raw ?? "") as unknown);
  } catch {
    malformed = true;
  }
  if (
    !artifact
    || artifact.version !== TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.version
    || artifact.term_normalization_version
      !== TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.term_normalization_version
    || artifact.candidate_recall_semantics_version
      !== TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.candidate_recall_semantics_version
    || artifact.research_mode !== "topic_discovery"
    || artifact.strategy !== "topic_portfolio"
    || !Array.isArray(artifact.selected_families)
  ) {
    malformed = true;
  }
  if (
    expectedAttemptId
    && exactText(artifact?.collect_attempt_id) !== expectedAttemptId
  ) {
    attemptMismatch = true;
  }
  for (const rawFamily of Array.isArray(artifact?.selected_families)
    ? artifact.selected_families
    : []) {
    const family = recordValue(rawFamily);
    const contract = recordValue(family?.topic_discovery_family);
    const familyId = exactText(family?.query_family);
    const query = exactText(family?.query);
    const source = exactText(family?.source);
    const contractFamilyId = exactText(contract?.familyId);
    const sharedAnchorTerms = exactStringArray(contract?.sharedAnchorTerms, false);
    const normalizedSharedAnchorTerms = sharedAnchorTerms
      ? Array.from(new Set(
          normalizeTopicDiscoveryScientificTerms(sharedAnchorTerms.join(" "))
        ))
      : [];
    const axisTerms = exactStringArray(contract?.axisTerms, false);
    const lens = exactText(contract?.lens);
    const contributionIntent = exactText(contract?.contributionIntent);
    const contractSource = exactText(contract?.contractSource);
    if (
      !familyId
      || !query
      || !source
      || contractFamilyId !== familyId
      || !sharedAnchorTerms
      || sharedAnchorTerms.length < 2
      || !sameOrderedValues(sharedAnchorTerms, normalizedSharedAnchorTerms)
      || !axisTerms
      || !lens
      || !contributionIntent
      || !contractSource
      || families.has(familyId)
    ) {
      malformed = true;
      continue;
    }
    families.set(familyId, {
      familyId,
      query,
      source,
      sharedAnchorTerms,
      axisTerms,
      lens,
      contributionIntent,
      contractSource,
      signature: buildTopicDiscoveryCandidateFamilySignature({
        sharedAnchorTerms,
        axisTerms
      })
    });
  }
  const sharedAnchorTerms = families.values().next().value?.sharedAnchorTerms ?? [];
  if (
    families.size < TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS.minimumCoveredQueryFamilies
    || Array.from(families.values()).some((family) =>
      !sameKeySet(new Set(family.sharedAnchorTerms), new Set(sharedAnchorTerms))
    )
  ) {
    malformed = true;
  }
  return { families, sharedAnchorTerms, malformed, attemptMismatch };
}

function parseCorpus(raw: string | undefined): ParsedCorpus {
  const rows = new Map<string, ParsedCorpus["rows"] extends Map<string, infer T> ? T : never>();
  let malformed = false;
  const lines = raw?.split(/\r?\n/u).filter((line) => line.trim()) ?? [];
  if (lines.length === 0) {
    return { rows, malformed: true };
  }
  for (const line of lines) {
    let row: JsonRecord | undefined;
    try {
      row = recordValue(JSON.parse(line) as unknown);
    } catch {
      malformed = true;
      continue;
    }
    const paperId = exactText(row?.paper_id);
    const queryFamilies = exactStringArray(row?.query_families, false);
    if (
      !paperId
      || rows.has(paperId)
      || typeof row?.title !== "string"
      || typeof row.abstract !== "string"
      || !queryFamilies
    ) {
      malformed = true;
      continue;
    }
    rows.set(paperId, {
      paperId,
      title: row.title,
      abstract: row.abstract,
      queryFamilies
    });
  }
  return { rows, malformed };
}

function parsePairKeys(value: unknown): {
  keys: Set<string>;
  sources: Map<string, PairSelectionSource>;
  malformed: boolean;
} {
  const keys = new Set<string>();
  const sources = new Map<string, PairSelectionSource>();
  let malformed = !Array.isArray(value);
  if (!Array.isArray(value)) {
    return { keys, sources, malformed };
  }
  for (const item of value) {
    const pair = recordValue(item);
    const paperId = exactText(pair?.paper_id);
    const familyId = exactText(pair?.family_id);
    const selectionSource = pairSelectionSource(pair?.selection_source);
    if (!paperId || !familyId || !selectionSource) {
      malformed = true;
      continue;
    }
    const key = pairKey(paperId, familyId);
    if (keys.has(key)) {
      malformed = true;
    }
    keys.add(key);
    sources.set(key, selectionSource);
  }
  return { keys, sources, malformed };
}

function parseCandidateSelections(value: unknown): {
  values: Array<{ familyId: string; selectionSource: PairSelectionSource }>;
  malformed: boolean;
} {
  const values: Array<{ familyId: string; selectionSource: PairSelectionSource }> = [];
  const familyIds = new Set<string>();
  let malformed = !Array.isArray(value);
  for (const item of Array.isArray(value) ? value : []) {
    const selection = recordValue(item);
    const familyId = exactText(selection?.family_id);
    const selectionSource = pairSelectionSource(selection?.selection_source);
    if (!familyId || !selectionSource || familyIds.has(familyId)) {
      malformed = true;
      continue;
    }
    familyIds.add(familyId);
    values.push({ familyId, selectionSource });
  }
  return { values, malformed };
}

function parseFamilyRetrievalRanks(value: unknown): {
  values: Map<string, number>;
  malformed: boolean;
} {
  const values = new Map<string, number>();
  let malformed = !Array.isArray(value);
  for (const item of Array.isArray(value) ? value : []) {
    const entry = recordValue(item);
    const familyId = exactText(entry?.family_id);
    const rank = integerValue(entry?.rank);
    if (!familyId || !rank || values.has(familyId)) {
      malformed = true;
      continue;
    }
    values.set(familyId, rank);
  }
  return { values, malformed };
}

function parseDeclaredIds(
  value: unknown,
  key: "paper_id" | "family_id"
): { ids: Set<string>; malformed: boolean } {
  const ids = new Set<string>();
  let malformed = !Array.isArray(value);
  if (!Array.isArray(value)) {
    return { ids, malformed };
  }
  for (const item of value) {
    const id = exactText(recordValue(item)?.[key]);
    if (!id || ids.has(id)) {
      malformed = true;
      continue;
    }
    ids.add(id);
  }
  return { ids, malformed };
}

function parseJudgments(value: unknown): ParsedJudgments {
  const judgments = new Map<string, SemanticJudgment>();
  let malformed = !Array.isArray(value);
  if (!Array.isArray(value)) {
    return { judgments, malformed };
  }
  for (const item of value) {
    const judgment = recordValue(item);
    const paperId = exactText(judgment?.paper_id);
    const familyId = exactText(judgment?.family_id);
    const verdict = semanticVerdict(judgment?.verdict);
    const reason = exactText(judgment?.reason);
    const evidenceSpan = judgment?.evidence_span === undefined
      ? undefined
      : exactText(judgment.evidence_span);
    if (
      !paperId
      || !familyId
      || !verdict
      || !reason
      || (judgment?.evidence_span !== undefined && !evidenceSpan)
    ) {
      malformed = true;
      continue;
    }
    const key = pairKey(paperId, familyId);
    if (judgments.has(key)) {
      malformed = true;
      continue;
    }
    judgments.set(key, {
      paperId,
      familyId,
      verdict,
      reason,
      ...(evidenceSpan ? { evidenceSpan } : {})
    });
  }
  return { judgments, malformed };
}

function countVerdicts(judgments: Iterable<SemanticJudgment>): {
  directSupport: number;
  applicationOnly: number;
  uncertain: number;
} {
  const counts = { directSupport: 0, applicationOnly: 0, uncertain: 0 };
  for (const judgment of judgments) {
    if (judgment.verdict === "direct_support") {
      counts.directSupport += 1;
    } else if (judgment.verdict === "application_only") {
      counts.applicationOnly += 1;
    } else {
      counts.uncertain += 1;
    }
  }
  return counts;
}

function completeCountsMatch(
  value: unknown,
  pairCount: number,
  verdictCounts: {
    directSupport: number;
    applicationOnly: number;
    uncertain: number;
  }
): boolean {
  const counts = recordValue(value);
  return Boolean(counts)
    && integerValue(counts?.requested_pairs) === pairCount
    && integerValue(counts?.reviewed_pairs) === pairCount
    && integerValue(counts?.budget_excluded_pairs) === 0
    && integerValue(counts?.returned_judgments) === pairCount
    && integerValue(counts?.direct_support) === verdictCounts.directSupport
    && integerValue(counts?.application_only) === verdictCounts.applicationOnly
    && integerValue(counts?.uncertain) === verdictCounts.uncertain
    && integerValue(counts?.omitted_judgments) === 0
    && integerValue(counts?.duplicate_judgments) === 0
    && integerValue(counts?.conflicting_judgments) === 0
    && integerValue(counts?.invented_judgments) === 0
    && integerValue(counts?.malformed_judgments) === 0
    && integerValue(counts?.protocol_violations) === 0;
}

function sameCountRecord(left: unknown, right: unknown): boolean {
  const leftRecord = recordValue(left);
  const rightRecord = recordValue(right);
  return Boolean(leftRecord && rightRecord)
    && COMPLETE_COUNT_FIELDS.every(
      (field) => integerValue(leftRecord?.[field]) === integerValue(rightRecord?.[field])
    );
}

function sameJudgments(
  left: ReadonlyMap<string, SemanticJudgment>,
  right: ReadonlyMap<string, SemanticJudgment>
): boolean {
  return left.size === right.size
    && Array.from(left.entries()).every(([key, judgment]) => {
      const other = right.get(key);
      return Boolean(other)
        && other?.verdict === judgment.verdict
        && other.reason === judgment.reason
        && other.evidenceSpan === judgment.evidenceSpan;
    });
}

function sameKeySet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && Array.from(left).every((key) => right.has(key));
}

function sameSelectionSources(
  left: ReadonlyMap<string, PairSelectionSource>,
  right: ReadonlyMap<string, PairSelectionSource>
): boolean {
  return left.size === right.size
    && Array.from(left.entries()).every(([key, source]) => right.get(key) === source);
}

function recallMatchesSelectionSources(
  value: unknown,
  sources: ReadonlyMap<string, PairSelectionSource>
): boolean {
  const recall = recordValue(value);
  const lexicalCount = Array.from(sources.values()).filter(
    (source) => source === "lexical_match"
  ).length;
  const providerCount = sources.size - lexicalCount;
  return Boolean(recall)
    && integerValue(recall?.provider_recall_floor_per_family)
      === TOPIC_DISCOVERY_PROVIDER_RECALL_FLOOR_PER_FAMILY
    && integerValue(recall?.lexical_requested_pairs) === lexicalCount
    && integerValue(recall?.provider_provenance_requested_pairs) === providerCount;
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function pairKey(paperId: string, familyId: string): string {
  return JSON.stringify([paperId, familyId]);
}

function parsePairKey(key: string): [string, string] {
  return JSON.parse(key) as [string, string];
}

function hashJsonValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactStringArray(value: unknown, allowEmpty: boolean): string[] | undefined {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    return undefined;
  }
  const strings = value.map(exactText);
  if (strings.some((item) => !item) || new Set(strings).size !== strings.length) {
    return undefined;
  }
  return strings as string[];
}

function exactText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function exactSha256(value: unknown): string | undefined {
  const text = exactText(value);
  return text && SHA256_PATTERN.test(text) ? text : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function semanticVerdict(value: unknown): SemanticVerdict | undefined {
  return value === "direct_support"
    || value === "application_only"
    || value === "uncertain"
    ? value
    : undefined;
}

function pairSelectionSource(value: unknown): PairSelectionSource | undefined {
  return value === "lexical_match" || value === "provider_provenance_floor"
    ? value
    : undefined;
}

function paperSearchProvider(value: unknown): string | undefined {
  return value === "semantic_scholar"
    || value === "openalex"
    || value === "crossref"
    || value === "arxiv"
    ? value
    : undefined;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}
