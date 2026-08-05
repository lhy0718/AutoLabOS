import { createHash } from "node:crypto";

import { parseStructuredModelJsonObject } from "../analysis/modelJson.js";
import type { LLMClient } from "../llm/client.js";
import {
  normalizeTopicDiscoveryCandidateObjectTerms,
  normalizeTopicDiscoveryCandidateTerms,
  normalizeTopicDiscoveryScientificObjectTerms,
  TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
  TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
} from "../topicDiscoveryScientificTerms.js";
import type { StoredCorpusRow } from "./types.js";

export const TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION = 6 as const;
export const DEFAULT_TOPIC_DISCOVERY_SEMANTIC_AUDIT_MAX_PAIRS = 64;
export const MAX_TOPIC_DISCOVERY_SEMANTIC_AUDIT_PAIRS = 128;
export const DEFAULT_TOPIC_DISCOVERY_SEMANTIC_AUDIT_MAX_INPUT_BYTES = 128 * 1024;
export const MAX_TOPIC_DISCOVERY_SEMANTIC_AUDIT_INPUT_BYTES = 512 * 1024;
export const DEFAULT_TOPIC_DISCOVERY_SEMANTIC_AUDIT_ABSTRACT_CHARS = 2_000;
export const MAX_TOPIC_DISCOVERY_SEMANTIC_AUDIT_ABSTRACT_CHARS = 4_000;
export const DEFAULT_TOPIC_DISCOVERY_SEMANTIC_AUDIT_TIMEOUT_MS = 120_000;
export const MAX_TOPIC_DISCOVERY_SEMANTIC_AUDIT_TIMEOUT_MS = 120_000;
export const MAX_TOPIC_DISCOVERY_SEMANTIC_AUDIT_REASON_CHARS = 240;
export const MAX_TOPIC_DISCOVERY_SEMANTIC_EVIDENCE_SPAN_CHARS = 240;
export const TOPIC_DISCOVERY_PROVIDER_RECALL_FLOOR_PER_FAMILY = 8;
export const TOPIC_DISCOVERY_SEMANTIC_TIMEOUT_PARTITION_POLICY =
  "single_then_timeout_partition_v1" as const;
export const TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CALLS = 4;
export const TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_FALLBACK_PARTITIONS = 3;
export const TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CUMULATIVE_INPUT_BYTES = 512 * 1024;
const MIN_TOPIC_DISCOVERY_SEMANTIC_EVIDENCE_SPAN_CHARS = 12;
const MIN_TOPIC_DISCOVERY_SEMANTIC_EVIDENCE_SPAN_TERMS = 2;

export type TopicDiscoverySemanticVerdict =
  | "direct_support"
  | "application_only"
  | "uncertain";

export interface TopicDiscoverySemanticSearchFamilyContract {
  queryFamily: string;
  query: string;
  sharedAnchorTerms?: string[];
  axisTerms: string[];
  lens: string;
  contributionIntent: string;
}

export interface TopicDiscoverySemanticJudgment {
  paper_id: string;
  family_id: string;
  verdict: TopicDiscoverySemanticVerdict;
  reason: string;
  evidence_span?: string;
}

export interface TopicDiscoverySemanticReviewerInputPayload {
  version: typeof TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION;
  term_normalization_version: typeof TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION;
  candidate_recall_semantics_version: typeof TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION;
  papers: Array<{ paper_id: string; title: string; abstract: string }>;
  family_contracts: Array<{
    family_id: string;
    query: string;
    axis_terms: string[];
    lens: string;
    contribution_intent: string;
  }>;
  requested_pairs: Array<{
    paper_id: string;
    family_id: string;
    selection_source: TopicDiscoverySemanticPairSelectionSource;
  }>;
}

export type TopicDiscoverySemanticPairSelectionSource =
  | "lexical_match"
  | "provider_provenance_floor";

export interface TopicDiscoverySemanticProtocolViolation {
  code:
    | "unknown_requested_pair"
    | "unknown_response_pair"
    | "malformed_response_judgment"
    | "invalid_direct_support_evidence_span"
    | "duplicate_response_pair"
    | "conflicting_response_pair";
  judgment_index?: number;
  paper_id?: string;
  family_id?: string;
}

export interface TopicDiscoverySemanticAuditCounts {
  requested_pairs: number;
  reviewed_pairs: number;
  budget_excluded_pairs: number;
  returned_judgments: number;
  direct_support: number;
  application_only: number;
  uncertain: number;
  omitted_judgments: number;
  duplicate_judgments: number;
  conflicting_judgments: number;
  invented_judgments: number;
  malformed_judgments: number;
  protocol_violations: number;
}

export interface TopicDiscoverySemanticAuditTrace {
  version: typeof TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION;
  status: "complete" | "partial" | "operational_failure";
  prompt_sha256: string;
  response_sha256: string;
  limits: {
    max_pairs: number;
    max_input_bytes: number;
    abstract_chars: number;
    timeout_ms: number;
  };
  reviewer_input_bytes: number;
  reviewer_input_payload: TopicDiscoverySemanticReviewerInputPayload;
  counts: TopicDiscoverySemanticAuditCounts;
  recall: {
    provider_recall_floor_per_family: number;
    lexical_requested_pairs: number;
    provider_provenance_requested_pairs: number;
  };
  execution: {
    policy: typeof TOPIC_DISCOVERY_SEMANTIC_TIMEOUT_PARTITION_POLICY;
    maximum_calls: number;
    maximum_fallback_partitions: number;
    total_deadline_ms: number;
    fallback_partition_size: number;
    calls_started: number;
    calls_completed: number;
    cumulative_reviewer_input_bytes: number;
    calls: Array<{
      call_index: number;
      mode: "primary" | "timeout_partition";
      pair_start_index: number;
      pair_end_index_exclusive: number;
      requested_pair_count: number;
      reviewer_input_sha256: string;
      reviewer_input_bytes: number;
      prompt_sha256: string;
      response_sha256: string;
      outcome: "complete" | "partial" | "timeout" | "operational_failure";
      reason?: string;
    }>;
  };
  reasons: string[];
  protocol_violations: TopicDiscoverySemanticProtocolViolation[];
  judgments: TopicDiscoverySemanticJudgment[];
}

export interface RunTopicDiscoverySemanticAuditInput {
  llm: LLMClient;
  rows: StoredCorpusRow[];
  searchFamilies: TopicDiscoverySemanticSearchFamilyContract[];
  lexicalMatchedFamilyIdsByPaper: ReadonlyMap<string, ReadonlySet<string>>;
  providerCandidatePaperIdsByFamily?: ReadonlyMap<string, readonly string[]>;
  maxPairs?: number;
  maxInputBytes?: number;
  abstractChars?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

type AuditStatus = TopicDiscoverySemanticAuditTrace["status"];
type AuditLimits = TopicDiscoverySemanticAuditTrace["limits"];
interface RequestedPair {
  paperId: string;
  familyId: string;
  selectionSource: TopicDiscoverySemanticPairSelectionSource;
}
interface Indexed<T> { values: Map<string, T>; duplicateIds: Set<string> }
interface RawResponse { judgments?: unknown }
interface PreparedInput {
  requestedPairs: RequestedPair[];
  reviewedPairs: RequestedPair[];
  excluded: Map<string, TopicDiscoverySemanticJudgment>;
  payload: TopicDiscoverySemanticReviewerInputPayload;
  violations: TopicDiscoverySemanticProtocolViolation[];
}
interface NormalizedResponse {
  byPair: Map<string, TopicDiscoverySemanticJudgment>;
  returned: number;
  omitted: number;
  duplicate: number;
  conflicting: number;
  invented: number;
  malformed: number;
  violations: TopicDiscoverySemanticProtocolViolation[];
}

type SemanticExecutionTrace = TopicDiscoverySemanticAuditTrace["execution"];
type SemanticExecutionCall = SemanticExecutionTrace["calls"][number];

interface CompletedReviewerCall {
  status: "completed";
  prompt: string;
  response: string;
  normalized: NormalizedResponse;
  trace: SemanticExecutionCall;
}

interface FailedReviewerCall {
  status: "failed";
  prompt: string;
  response: string;
  reason: string;
  trace: SemanticExecutionCall;
}

type ReviewerCall = CompletedReviewerCall | FailedReviewerCall;

export async function runTopicDiscoverySemanticAudit(
  input: RunTopicDiscoverySemanticAuditInput
): Promise<TopicDiscoverySemanticAuditTrace> {
  const limits = resolveLimits(input);
  const prepared = prepareInput(input, limits);
  const inputBytes = payloadBytes(prepared.payload);
  const fallbackPartitionSize = Math.max(
    1,
    Math.ceil(
      prepared.reviewedPairs.length
      / TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_FALLBACK_PARTITIONS
    )
  );
  const totalDeadlineMs = Math.min(480_000, limits.timeout_ms * 4);
  const executionBase = {
    policy: TOPIC_DISCOVERY_SEMANTIC_TIMEOUT_PARTITION_POLICY,
    maximum_calls: TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CALLS,
    maximum_fallback_partitions:
      TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_FALLBACK_PARTITIONS,
    total_deadline_ms: totalDeadlineMs,
    fallback_partition_size: fallbackPartitionSize
  } as const;

  if (prepared.reviewedPairs.length === 0) {
    const judgments = mergeJudgments(prepared.requestedPairs, new Map(), prepared.excluded);
    return trace({
      status: judgments.length === 0 ? "complete" : "partial",
      prompt: "",
      response: "",
      limits,
      inputBytes,
      payload: prepared.payload,
      judgments,
      requestedPairs: prepared.requestedPairs,
      reviewed: 0,
      returned: 0,
      omitted: 0,
      duplicate: 0,
      conflicting: 0,
      invented: 0,
      malformed: 0,
      violations: prepared.violations,
      execution: {
        ...executionBase,
        calls_started: 0,
        calls_completed: 0,
        cumulative_reviewer_input_bytes: 0,
        calls: []
      }
    });
  }

  const deadlineAt = Date.now() + totalDeadlineMs;
  const calls: SemanticExecutionCall[] = [];
  const prompts: string[] = [];
  const responses: string[] = [];
  let cumulativeReviewerInputBytes = 0;
  const primary = await runReviewerCall({
    llm: input.llm,
    payload: prepared.payload,
    pairs: prepared.reviewedPairs,
    timeoutMs: limits.timeout_ms,
    abortSignal: input.abortSignal,
    callIndex: 1,
    mode: "primary",
    pairStartIndex: 0,
    pairEndIndexExclusive: prepared.reviewedPairs.length
  });
  calls.push(primary.trace);
  prompts.push(primary.prompt);
  responses.push(primary.response);
  cumulativeReviewerInputBytes += primary.trace.reviewer_input_bytes;
  if (primary.status === "completed") {
    return traceFromNormalized({
      prepared,
      limits,
      inputBytes,
      prompts,
      responses,
      normalized: primary.normalized,
      execution: buildExecutionTrace(
        executionBase,
        calls,
        cumulativeReviewerInputBytes
      )
    });
  }
  if (primary.reason !== "semantic_audit_timeout") {
    return operationalFailureTrace({
      prepared,
      limits,
      inputBytes,
      prompts,
      responses,
      operationalReason: primary.reason,
      execution: buildExecutionTrace(
        executionBase,
        calls,
        cumulativeReviewerInputBytes
      )
    });
  }

  const aggregate = emptyNormalizedResponse();
  for (
    let start = 0;
    start < prepared.reviewedPairs.length;
    start += fallbackPartitionSize
  ) {
    const callIndex = calls.length + 1;
    const end = Math.min(
      prepared.reviewedPairs.length,
      start + fallbackPartitionSize
    );
    if (callIndex > TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CALLS) {
      return operationalFailureTrace({
        prepared,
        limits,
        inputBytes,
        prompts,
        responses,
        operationalReason: "semantic_audit_timeout_partitions_exhausted",
        execution: buildExecutionTrace(
          executionBase,
          calls,
          cumulativeReviewerInputBytes
        )
      });
    }
    const partitionPayload = projectFrozenReviewerPayload(
      prepared.payload,
      start,
      end
    );
    const partitionBytes = payloadBytes(partitionPayload);
    const remainingMs = deadlineAt - Date.now();
    if (
      remainingMs <= 0
      || cumulativeReviewerInputBytes + partitionBytes
        > TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CUMULATIVE_INPUT_BYTES
    ) {
      const reason = remainingMs <= 0
        ? "semantic_audit_timeout_partitions_exhausted"
        : "semantic_audit_partition_cumulative_input_budget_exceeded";
      return operationalFailureTrace({
        prepared,
        limits,
        inputBytes,
        prompts,
        responses,
        operationalReason: reason,
        execution: buildExecutionTrace(
          executionBase,
          calls,
          cumulativeReviewerInputBytes
        )
      });
    }
    const partition = await runReviewerCall({
      llm: input.llm,
      payload: partitionPayload,
      pairs: prepared.reviewedPairs.slice(start, end),
      timeoutMs: Math.min(limits.timeout_ms, remainingMs),
      abortSignal: input.abortSignal,
      callIndex,
      mode: "timeout_partition",
      pairStartIndex: start,
      pairEndIndexExclusive: end
    });
    calls.push(partition.trace);
    prompts.push(partition.prompt);
    responses.push(partition.response);
    cumulativeReviewerInputBytes += partition.trace.reviewer_input_bytes;
    if (partition.status === "failed") {
      return operationalFailureTrace({
        prepared,
        limits,
        inputBytes,
        prompts,
        responses,
        operationalReason: partition.reason === "semantic_audit_timeout"
          ? "semantic_audit_timeout_partitions_exhausted"
          : partition.reason,
        execution: buildExecutionTrace(
          executionBase,
          calls,
          cumulativeReviewerInputBytes
        )
      });
    }
    mergeNormalizedResponse(aggregate, partition.normalized);
  }
  return traceFromNormalized({
    prepared,
    limits,
    inputBytes,
    prompts,
    responses,
    normalized: aggregate,
    execution: buildExecutionTrace(
      executionBase,
      calls,
      cumulativeReviewerInputBytes
    )
  });
}

async function runReviewerCall(input: {
  llm: LLMClient;
  payload: TopicDiscoverySemanticReviewerInputPayload;
  pairs: RequestedPair[];
  timeoutMs: number;
  abortSignal?: AbortSignal;
  callIndex: number;
  mode: SemanticExecutionCall["mode"];
  pairStartIndex: number;
  pairEndIndexExclusive: number;
}): Promise<ReviewerCall> {
  const prompt = buildTopicDiscoverySemanticAuditPrompt(input.payload);
  let response = "";
  const base = {
    call_index: input.callIndex,
    mode: input.mode,
    pair_start_index: input.pairStartIndex,
    pair_end_index_exclusive: input.pairEndIndexExclusive,
    requested_pair_count: input.pairs.length,
    reviewer_input_sha256: sha256(JSON.stringify(input.payload)),
    reviewer_input_bytes: payloadBytes(input.payload),
    prompt_sha256: sha256(prompt)
  } as const;
  try {
    response = (await completeWithBoundary(
      input.llm,
      prompt,
      input.timeoutMs,
      input.abortSignal
    )).text;
    const normalized = normalizeResponse(
      parseResponse(response),
      input.pairs,
      input.payload
    );
    const partial = normalized.omitted > 0
      || normalized.duplicate > 0
      || normalized.conflicting > 0
      || normalized.invented > 0
      || normalized.malformed > 0
      || normalized.violations.length > 0;
    return {
      status: "completed",
      prompt,
      response,
      normalized,
      trace: {
        ...base,
        response_sha256: sha256(response),
        outcome: partial ? "partial" : "complete"
      }
    };
  } catch (error) {
    const reason = classifyFailure(error);
    if (reason === "semantic_audit_parent_aborted") {
      throw error;
    }
    return {
      status: "failed",
      prompt,
      response,
      reason,
      trace: {
        ...base,
        response_sha256: sha256(response),
        outcome: reason === "semantic_audit_timeout"
          ? "timeout"
          : "operational_failure",
        reason
      }
    };
  }
}

function projectFrozenReviewerPayload(
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

function emptyNormalizedResponse(): NormalizedResponse {
  return {
    byPair: new Map(),
    returned: 0,
    omitted: 0,
    duplicate: 0,
    conflicting: 0,
    invented: 0,
    malformed: 0,
    violations: []
  };
}

function mergeNormalizedResponse(
  target: NormalizedResponse,
  source: NormalizedResponse
): void {
  for (const [key, judgment] of source.byPair) {
    if (target.byPair.has(key)) {
      target.conflicting += 1;
      continue;
    }
    target.byPair.set(key, judgment);
  }
  target.returned += source.returned;
  target.omitted += source.omitted;
  target.duplicate += source.duplicate;
  target.conflicting += source.conflicting;
  target.invented += source.invented;
  target.malformed += source.malformed;
  target.violations.push(...source.violations);
}

function buildExecutionTrace(
  base: Pick<
    SemanticExecutionTrace,
    | "policy"
    | "maximum_calls"
    | "maximum_fallback_partitions"
    | "total_deadline_ms"
    | "fallback_partition_size"
  >,
  calls: SemanticExecutionCall[],
  cumulativeReviewerInputBytes: number
): SemanticExecutionTrace {
  return {
    ...base,
    calls_started: calls.length,
    calls_completed: calls.filter(
      (call) => call.outcome === "complete" || call.outcome === "partial"
    ).length,
    cumulative_reviewer_input_bytes: cumulativeReviewerInputBytes,
    calls: [...calls]
  };
}

function traceFromNormalized(input: {
  prepared: PreparedInput;
  limits: AuditLimits;
  inputBytes: number;
  prompts: string[];
  responses: string[];
  normalized: NormalizedResponse;
  execution: SemanticExecutionTrace;
}): TopicDiscoverySemanticAuditTrace {
  const violations = [
    ...input.prepared.violations,
    ...input.normalized.violations
  ];
  const judgments = mergeJudgments(
    input.prepared.requestedPairs,
    input.normalized.byPair,
    input.prepared.excluded
  );
  const isPartial = input.prepared.excluded.size > 0
    || input.normalized.omitted > 0
    || input.normalized.duplicate > 0
    || input.normalized.conflicting > 0
    || input.normalized.invented > 0
    || input.normalized.malformed > 0
    || violations.length > 0;
  return trace({
    status: isPartial ? "partial" : "complete",
    prompt: input.prompts.join("\n--- semantic-review-call ---\n"),
    response: executionResponseHashMaterial(input.execution.calls, input.responses),
    limits: input.limits,
    inputBytes: input.inputBytes,
    payload: input.prepared.payload,
    judgments,
    requestedPairs: input.prepared.requestedPairs,
    reviewed: input.prepared.reviewedPairs.length,
    returned: input.normalized.returned,
    omitted: input.normalized.omitted,
    duplicate: input.normalized.duplicate,
    conflicting: input.normalized.conflicting,
    invented: input.normalized.invented,
    malformed: input.normalized.malformed,
    violations,
    execution: input.execution
  });
}

function operationalFailureTrace(input: {
  prepared: PreparedInput;
  limits: AuditLimits;
  inputBytes: number;
  prompts: string[];
  responses: string[];
  operationalReason: string;
  execution: SemanticExecutionTrace;
}): TopicDiscoverySemanticAuditTrace {
  return trace({
    status: "operational_failure",
    prompt: input.prompts.join("\n--- semantic-review-call ---\n"),
    response: executionResponseHashMaterial(input.execution.calls, input.responses),
    limits: input.limits,
    inputBytes: input.inputBytes,
    payload: input.prepared.payload,
    judgments: input.prepared.requestedPairs.map((pair) =>
      uncertainJudgment(pair, input.operationalReason)
    ),
    requestedPairs: input.prepared.requestedPairs,
    reviewed: input.prepared.reviewedPairs.length,
    returned: 0,
    omitted: 0,
    duplicate: 0,
    conflicting: 0,
    invented: 0,
    malformed: 0,
    violations: input.prepared.violations,
    operationalReason: input.operationalReason,
    execution: input.execution
  });
}

function executionResponseHashMaterial(
  calls: SemanticExecutionCall[],
  responses: string[]
): string {
  return calls.length === 1
    ? responses[0] ?? ""
    : JSON.stringify(calls.map((call) => call.response_sha256));
}

export const auditTopicDiscoveryLexicalCandidates = runTopicDiscoverySemanticAudit;

export function buildTopicDiscoverySemanticAuditPrompt(
  payload: TopicDiscoverySemanticReviewerInputPayload
): string {
  return [
    "Conservatively triage every requested paper-family pair.",
    "Use direct_support only when the paper centrally and directly studies the family lens and its main contribution addresses the contribution intent.",
    `For direct_support, evidence_span is required and must be one contiguous, exact, case-sensitive span copied from that paper's supplied title or abstract; it must be ${MIN_TOPIC_DISCOVERY_SEMANTIC_EVIDENCE_SPAN_CHARS}-${MAX_TOPIC_DISCOVERY_SEMANTIC_EVIDENCE_SPAN_CHARS} characters long and contain at least ${MIN_TOPIC_DISCOVERY_SEMANTIC_EVIDENCE_SPAN_TERMS} normalized content terms.`,
    "For lexical_match pairs, direct_support evidence_span must contain a literal supplied axis term.",
    "For provider_provenance_floor pairs, a scholarly synonym or acronym may support the verdict, but a span containing only non-axis terms from the family query is insufficient.",
    "If every direct_support evidence_span requirement cannot be met exactly, do not use direct_support; choose application_only or uncertain and omit evidence_span.",
    "Use application_only when the family lens is only an application, task, tool, example, or context for a different central contribution.",
    "Use uncertain when the title and abstract are insufficient, ambiguous, or support neither classification.",
    "Lexical overlap alone is never enough for direct_support.",
    "Use only supplied IDs. Return exactly one judgment for every requested pair and invent none.",
    "Each judgment must contain paper_id, family_id, verdict, and a concise reason. verdict must be direct_support, application_only, or uncertain. Add evidence_span only for direct_support.",
    "Return JSON only as an object with a judgments array.",
    "Output shape; angle-bracketed values are instructions and must not be returned literally:",
    JSON.stringify({
      judgments: [{
        paper_id: "<copy a requested paper_id exactly>",
        family_id: "<copy its requested family_id exactly>",
        verdict: "<direct_support|application_only|uncertain>",
        reason: "<concise evidence-based reason>",
        evidence_span: "<required only for direct_support; exact source span>"
      }]
    }),
    "Input:",
    JSON.stringify(payload)
  ].join("\n");
}

function prepareInput(
  input: RunTopicDiscoverySemanticAuditInput,
  limits: AuditLimits
): PreparedInput {
  const requestedPairs = collectPairs(input);
  const rows = indexUnique(input.rows, (row) => row.paper_id);
  const families = indexUnique(input.searchFamilies, (family) => family.queryFamily);
  const reviewedPairs: RequestedPair[] = [];
  const excluded = new Map<string, TopicDiscoverySemanticJudgment>();
  const violations: TopicDiscoverySemanticProtocolViolation[] = [];
  const basePayload = reviewerPayload(
    [],
    rows.values,
    families.values,
    limits.abstract_chars
  );
  const baseEnvelopeOverBudget = payloadBytes(basePayload) > limits.max_input_bytes;

  for (const pair of requestedPairs) {
    const row = rows.values.get(pair.paperId);
    const family = families.values.get(pair.familyId);
    if (!validPair(pair, row, family, rows, families)) {
      excluded.set(
        pairKey(pair),
        uncertainJudgment(pair, "unknown_or_ambiguous_requested_pair")
      );
      violations.push(violation("unknown_requested_pair", pair));
      continue;
    }
    if (baseEnvelopeOverBudget) {
      excluded.set(
        pairKey(pair),
        uncertainJudgment(pair, "max_input_bytes_base_envelope_budget_excluded")
      );
      continue;
    }
    if (reviewedPairs.length >= limits.max_pairs) {
      excluded.set(pairKey(pair), uncertainJudgment(pair, "max_pairs_budget_excluded"));
      continue;
    }
    const candidate = [...reviewedPairs, pair];
    const payload = reviewerPayload(
      candidate,
      rows.values,
      families.values,
      limits.abstract_chars
    );
    if (payloadBytes(payload) > limits.max_input_bytes) {
      excluded.set(
        pairKey(pair),
        uncertainJudgment(pair, "max_input_bytes_budget_excluded")
      );
      continue;
    }
    reviewedPairs.push(pair);
  }

  const payload = baseEnvelopeOverBudget
    ? minimalReviewerPayload()
    : reviewerPayload(
        reviewedPairs,
        rows.values,
        families.values,
        limits.abstract_chars
      );
  if (payloadBytes(payload) > limits.max_input_bytes) {
    throw new Error("topic_discovery_semantic_audit_input_budget_invariant_failed");
  }

  return {
    requestedPairs,
    reviewedPairs,
    excluded,
    payload,
    violations
  };
}

function minimalReviewerPayload(): TopicDiscoverySemanticReviewerInputPayload {
  return {
    version: TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
    term_normalization_version: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
    candidate_recall_semantics_version:
      TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
    papers: [],
    family_contracts: [],
    requested_pairs: []
  };
}

function reviewerPayload(
  pairs: RequestedPair[],
  rows: ReadonlyMap<string, StoredCorpusRow>,
  families: ReadonlyMap<string, TopicDiscoverySemanticSearchFamilyContract>,
  abstractChars: number
): TopicDiscoverySemanticReviewerInputPayload {
  const paperIds = uniqueSorted(pairs.map((pair) => pair.paperId));
  const familyIds = uniqueSorted([...families.keys()]);
  return {
    version: TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
    term_normalization_version: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
    candidate_recall_semantics_version: TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
    papers: paperIds.map((paperId) => {
      const row = rows.get(paperId)!;
      return {
        paper_id: paperId,
        title: row.title,
        abstract: truncate(row.abstract, abstractChars)
      };
    }),
    family_contracts: familyIds.map((familyId) => {
      const family = families.get(familyId)!;
      return {
        family_id: familyId,
        query: family.query,
        axis_terms: [...family.axisTerms],
        lens: family.lens,
        contribution_intent: family.contributionIntent
      };
    }),
    requested_pairs: pairs.map((pair) => ({
      paper_id: pair.paperId,
      family_id: pair.familyId,
      selection_source: pair.selectionSource
    }))
  };
}

function normalizeResponse(
  raw: unknown[],
  expectedPairs: RequestedPair[],
  payload: TopicDiscoverySemanticReviewerInputPayload
): NormalizedResponse {
  const expectedKeys = new Set(expectedPairs.map(pairKey));
  const grouped = new Map<string, Array<{ value: unknown; index: number }>>();
  const violations: TopicDiscoverySemanticProtocolViolation[] = [];
  let invented = 0;
  let malformed = 0;

  raw.forEach((value, index) => {
    if (!isRecord(value)) {
      malformed += 1;
      violations.push({ code: "malformed_response_judgment", judgment_index: index });
      return;
    }
    const paperId = exactString(value.paper_id);
    const familyId = exactString(value.family_id);
    if (paperId === undefined || familyId === undefined) {
      malformed += 1;
      violations.push({ code: "malformed_response_judgment", judgment_index: index });
      return;
    }
    const pair = { paperId, familyId };
    const key = pairKey(pair);
    if (!expectedKeys.has(key)) {
      invented += 1;
      violations.push({
        code: "unknown_response_pair",
        judgment_index: index,
        paper_id: truncate(paperId, 160),
        family_id: truncate(familyId, 160)
      });
      return;
    }
    const entries = grouped.get(key) ?? [];
    entries.push({ value, index });
    grouped.set(key, entries);
  });

  const papers = new Map(payload.papers.map((paper) => [paper.paper_id, paper] as const));
  const families = new Map(
    payload.family_contracts.map((family) => [family.family_id, family] as const)
  );
  const byPair = new Map<string, TopicDiscoverySemanticJudgment>();
  let omitted = 0;
  let duplicate = 0;
  let conflicting = 0;

  for (const pair of expectedPairs) {
    const key = pairKey(pair);
    const entries = grouped.get(key) ?? [];
    if (entries.length === 0) {
      omitted += 1;
      byPair.set(key, uncertainJudgment(pair, "model_judgment_omitted"));
      continue;
    }
    if (entries.length > 1) {
      const verdicts = new Set(entries.flatMap(({ value }) => {
        if (!isRecord(value)) return [];
        const verdict = normalizeVerdict(value.verdict);
        return verdict ? [verdict] : [];
      }));
      const conflict = verdicts.size > 1;
      conflict ? conflicting += 1 : duplicate += 1;
      violations.push(violation(
        conflict ? "conflicting_response_pair" : "duplicate_response_pair",
        pair
      ));
      byPair.set(
        key,
        uncertainJudgment(pair, conflict ? "conflicting_model_judgments" : "duplicate_model_judgment")
      );
      continue;
    }
    const parsed = parseJudgment(
      entries[0]!.value,
      pair,
      papers.get(pair.paperId)!,
      families.get(pair.familyId)!
    );
    if (!parsed.judgment) {
      malformed += 1;
      violations.push({
        ...violation(parsed.violationCode, pair),
        judgment_index: entries[0]!.index
      });
      byPair.set(key, uncertainJudgment(pair, parsed.reason));
      continue;
    }
    byPair.set(key, parsed.judgment);
  }

  return {
    byPair,
    returned: raw.length,
    omitted,
    duplicate,
    conflicting,
    invented,
    malformed,
    violations
  };
}

function parseJudgment(
  value: unknown,
  pair: RequestedPair,
  paper: { title: string; abstract: string },
  family: { query: string; axis_terms: string[] }
): {
  judgment?: TopicDiscoverySemanticJudgment;
  violationCode:
    | "malformed_response_judgment"
    | "invalid_direct_support_evidence_span";
  reason: "malformed_model_judgment" | "invalid_direct_support_evidence_span";
} {
  const malformed = {
    violationCode: "malformed_response_judgment" as const,
    reason: "malformed_model_judgment" as const
  };
  if (!isRecord(value)) return malformed;
  const verdict = normalizeVerdict(value.verdict);
  const reason = boundedReason(value.reason);
  if (
    value.paper_id !== pair.paperId
    || value.family_id !== pair.familyId
    || !verdict
    || !reason
  ) {
    return malformed;
  }
  const span = exactString(value.evidence_span);
  const hasValidEvidenceSpan = validEvidenceSpan(
    span,
    paper,
    family,
    pair.selectionSource
  );
  if (verdict === "direct_support" && !hasValidEvidenceSpan) {
    return {
      violationCode: "invalid_direct_support_evidence_span",
      reason: "invalid_direct_support_evidence_span"
    };
  }
  return {
    violationCode: "malformed_response_judgment",
    reason: "malformed_model_judgment",
    judgment: {
      paper_id: pair.paperId,
      family_id: pair.familyId,
      verdict,
      reason,
      ...(hasValidEvidenceSpan ? { evidence_span: span } : {})
    }
  };
}

function parseResponse(text: string): unknown[] {
  const parsed = parseStructuredModelJsonObject<RawResponse>(text, {
    emptyError: "topic_discovery_semantic_audit_response_empty",
    notFoundError: "topic_discovery_semantic_audit_response_json_not_found",
    incompleteError: "topic_discovery_semantic_audit_response_json_incomplete",
    invalidError: "topic_discovery_semantic_audit_response_json_invalid"
  }).value;
  if (!Array.isArray(parsed.judgments)) {
    throw new Error("topic_discovery_semantic_audit_judgments_missing");
  }
  return parsed.judgments;
}

function mergeJudgments(
  requested: RequestedPair[],
  reviewed: ReadonlyMap<string, TopicDiscoverySemanticJudgment>,
  excluded: ReadonlyMap<string, TopicDiscoverySemanticJudgment>
): TopicDiscoverySemanticJudgment[] {
  return requested.map((pair) =>
    reviewed.get(pairKey(pair))
    ?? excluded.get(pairKey(pair))
    ?? uncertainJudgment(pair, "semantic_audit_unresolved")
  );
}

function trace(input: {
  status: AuditStatus;
  prompt: string;
  response: string;
  limits: AuditLimits;
  inputBytes: number;
  payload: TopicDiscoverySemanticReviewerInputPayload;
  judgments: TopicDiscoverySemanticJudgment[];
  requestedPairs: RequestedPair[];
  reviewed: number;
  returned: number;
  omitted: number;
  duplicate: number;
  conflicting: number;
  invented: number;
  malformed: number;
  violations: TopicDiscoverySemanticProtocolViolation[];
  operationalReason?: string;
  execution: SemanticExecutionTrace;
}): TopicDiscoverySemanticAuditTrace {
  const counts: TopicDiscoverySemanticAuditCounts = {
    requested_pairs: input.judgments.length,
    reviewed_pairs: input.reviewed,
    budget_excluded_pairs: input.judgments.filter((item) =>
      item.reason.endsWith("_budget_excluded")
    ).length,
    returned_judgments: input.returned,
    direct_support: countVerdict(input.judgments, "direct_support"),
    application_only: countVerdict(input.judgments, "application_only"),
    uncertain: countVerdict(input.judgments, "uncertain"),
    omitted_judgments: input.omitted,
    duplicate_judgments: input.duplicate,
    conflicting_judgments: input.conflicting,
    invented_judgments: input.invented,
    malformed_judgments: input.malformed,
    protocol_violations: input.violations.length
  };
  return {
    version: TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
    status: input.status,
    prompt_sha256: sha256(input.prompt),
    response_sha256: sha256(input.response),
    limits: input.limits,
    reviewer_input_bytes: input.inputBytes,
    reviewer_input_payload: input.payload,
    counts,
    recall: {
      provider_recall_floor_per_family:
        TOPIC_DISCOVERY_PROVIDER_RECALL_FLOOR_PER_FAMILY,
      lexical_requested_pairs: input.requestedPairs.filter(
        (pair) => pair.selectionSource === "lexical_match"
      ).length,
      provider_provenance_requested_pairs: input.requestedPairs.filter(
        (pair) => pair.selectionSource === "provider_provenance_floor"
      ).length
    },
    execution: input.execution,
    reasons: reasons(counts, input.operationalReason),
    protocol_violations: input.violations.slice(0, MAX_TOPIC_DISCOVERY_SEMANTIC_AUDIT_PAIRS),
    judgments: input.judgments
  };
}

function reasons(counts: TopicDiscoverySemanticAuditCounts, operational?: string): string[] {
  return [
    operational,
    counts.budget_excluded_pairs ? `budget_excluded_pairs:${counts.budget_excluded_pairs}` : undefined,
    counts.omitted_judgments ? `omitted_model_judgments:${counts.omitted_judgments}` : undefined,
    counts.duplicate_judgments ? `duplicate_model_judgments:${counts.duplicate_judgments}` : undefined,
    counts.conflicting_judgments ? `conflicting_model_judgments:${counts.conflicting_judgments}` : undefined,
    counts.invented_judgments ? `invented_model_judgments:${counts.invented_judgments}` : undefined,
    counts.malformed_judgments ? `malformed_model_judgments:${counts.malformed_judgments}` : undefined,
    counts.protocol_violations ? `protocol_violations:${counts.protocol_violations}` : undefined
  ].flatMap((reason) => reason ? [reason] : []).slice(0, 10);
}

async function completeWithBoundary(
  llm: LLMClient,
  prompt: string,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<{ text: string }> {
  if (parentSignal?.aborted) throw new Error("semantic_audit_parent_aborted");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectBoundary: ((reason: Error) => void) | undefined;
  const onAbort = () => {
    const error = new Error("semantic_audit_parent_aborted");
    rejectBoundary?.(error);
    controller.abort(parentSignal?.reason ?? error);
  };
  parentSignal?.addEventListener("abort", onAbort, { once: true });
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
    timer = setTimeout(() => {
      const error = new Error("semantic_audit_timeout");
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      llm.complete(prompt, { abortSignal: controller.signal }),
      boundary
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onAbort);
  }
}

function collectPairs(input: RunTopicDiscoverySemanticAuditInput): RequestedPair[] {
  const rows = indexUnique(input.rows, (row) => row.paper_id);
  const families = indexUnique(
    input.searchFamilies,
    (family) => family.queryFamily
  );
  const pairsByFamily = new Map<
    string,
    Map<string, TopicDiscoverySemanticPairSelectionSource>
  >();
  for (const [paperId, familyIds] of input.lexicalMatchedFamilyIdsByPaper) {
    if (
      typeof paperId !== "string"
      || !exactId(paperId)
      || !rows.values.has(paperId)
      || rows.duplicateIds.has(paperId)
    ) {
      continue;
    }
    for (const familyId of familyIds) {
      if (
        typeof familyId !== "string"
        || !exactId(familyId)
        || !families.values.has(familyId)
        || families.duplicateIds.has(familyId)
      ) {
        continue;
      }
      const familyPairs = pairsByFamily.get(familyId) ?? new Map();
      familyPairs.set(paperId, "lexical_match");
      pairsByFamily.set(familyId, familyPairs);
    }
  }
  const knownFamilyIds = uniqueSorted([...families.values.keys()]);
  for (const familyId of knownFamilyIds) {
    if (families.duplicateIds.has(familyId)) {
      continue;
    }
    const familyPairs = pairsByFamily.get(familyId) ?? new Map();
    if (familyPairs.size < TOPIC_DISCOVERY_PROVIDER_RECALL_FLOOR_PER_FAMILY) {
      const family = families.values.get(familyId)!;
      const providerCandidates = rankTopicDiscoveryProviderRecallCandidates({
        paperIds: input.providerCandidatePaperIdsByFamily?.get(familyId) ?? [],
        rows: rows.values,
        family
      });
      for (const paperId of providerCandidates) {
        if (familyPairs.size >= TOPIC_DISCOVERY_PROVIDER_RECALL_FLOOR_PER_FAMILY) {
          break;
        }
        if (
          typeof paperId === "string"
          && exactId(paperId)
          && !familyPairs.has(paperId)
          && rows.values.has(paperId)
          && !rows.duplicateIds.has(paperId)
        ) {
          familyPairs.set(paperId, "provider_provenance_floor");
        }
      }
    }
    if (familyPairs.size > 0) {
      pairsByFamily.set(familyId, familyPairs);
    }
  }

  const orderedFamilies = [...pairsByFamily.entries()]
    .map(([familyId, familyPairs]) => ({
      familyId,
      pairs: [
        ...[...familyPairs.entries()]
          .filter(([, selectionSource]) => selectionSource === "lexical_match")
          .sort(([leftPaperId], [rightPaperId]) =>
            compare(leftPaperId, rightPaperId)
          ),
        ...[...familyPairs.entries()]
          .filter(([, selectionSource]) =>
            selectionSource === "provider_provenance_floor"
          )
      ].map(([paperId, selectionSource]) => ({ paperId, selectionSource }))
    }))
    .sort((left, right) => compare(left.familyId, right.familyId));
  const pairs: RequestedPair[] = [];
  const maximumFamilySize = Math.max(
    0,
    ...orderedFamilies.map((family) => family.pairs.length)
  );
  for (let index = 0; index < maximumFamilySize; index += 1) {
    for (const family of orderedFamilies) {
      const pair = family.pairs[index];
      if (pair) {
        pairs.push({
          paperId: pair.paperId,
          familyId: family.familyId,
          selectionSource: pair.selectionSource
        });
      }
    }
  }
  return pairs;
}

export function rankTopicDiscoveryProviderRecallCandidates(input: {
  paperIds: readonly string[];
  rows: ReadonlyMap<string, StoredCorpusRow>;
  family: TopicDiscoverySemanticSearchFamilyContract;
}): string[] {
  const axisTerms = uniqueNormalizedTerms(
    normalizeTopicDiscoveryCandidateTerms(input.family.axisTerms.join(" "))
  );
  const axisSet = new Set(axisTerms);
  const declaredAnchorTerms = input.family.sharedAnchorTerms?.length
    ? normalizeTopicDiscoveryScientificObjectTerms(
        input.family.sharedAnchorTerms.join(" ")
      )
    : normalizeTopicDiscoveryScientificObjectTerms(input.family.query)
        .filter((term) => !axisSet.has(term));
  const anchorTerms = uniqueNormalizedTerms(declaredAnchorTerms);
  const seen = new Set<string>();

  return input.paperIds
    .flatMap((paperId, providerRank) => {
      if (seen.has(paperId)) return [];
      seen.add(paperId);
      const row = input.rows.get(paperId);
      if (!row) return [];
      const bodyTerms = new Set(normalizeTopicDiscoveryCandidateObjectTerms(
        `${row.title}\n${row.abstract}`
      ));
      const titleTermSequence = normalizeTopicDiscoveryCandidateObjectTerms(row.title);
      const titleTerms = new Set(titleTermSequence);
      const anchorMatches = countContainedTerms(anchorTerms, bodyTerms);
      const axisMatches = countContainedTerms(axisTerms, bodyTerms);
      const titleAnchorMatches = countContainedTerms(anchorTerms, titleTerms);
      const titleAxisMatches = countContainedTerms(axisTerms, titleTerms);
      return [{
        paperId,
        providerRank,
        titleAnchorSequence: containsTermSequence(titleTermSequence, anchorTerms) ? 1 : 0,
        fullAnchor: anchorTerms.length > 0 && anchorMatches === anchorTerms.length ? 1 : 0,
        anchorMatches,
        axisMatches,
        titleFullAnchor:
          anchorTerms.length > 0 && titleAnchorMatches === anchorTerms.length ? 1 : 0,
        titleAnchorMatches,
        titleAxisMatches,
        hasAbstract: row.abstract.trim().length > 0 ? 1 : 0
      }];
    })
    .sort((left, right) =>
      right.titleAnchorSequence - left.titleAnchorSequence
      || right.fullAnchor - left.fullAnchor
      || right.axisMatches - left.axisMatches
      || right.anchorMatches - left.anchorMatches
      || right.titleFullAnchor - left.titleFullAnchor
      || right.titleAxisMatches - left.titleAxisMatches
      || right.titleAnchorMatches - left.titleAnchorMatches
      || right.hasAbstract - left.hasAbstract
      || left.providerRank - right.providerRank
      || compare(left.paperId, right.paperId)
    )
    .map((candidate) => candidate.paperId);
}

function uniqueNormalizedTerms(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function countContainedTerms(terms: string[], candidateTerms: ReadonlySet<string>): number {
  return terms.filter((term) => candidateTerms.has(term)).length;
}

function containsTermSequence(candidateTerms: string[], requiredTerms: string[]): boolean {
  if (requiredTerms.length === 0 || candidateTerms.length < requiredTerms.length) {
    return false;
  }
  return candidateTerms.some((_, start) =>
    requiredTerms.every((required, offset) => candidateTerms[start + offset] === required)
  );
}

function indexUnique<T>(items: T[], id: (item: T) => string): Indexed<T> {
  const values = new Map<string, T>();
  const duplicateIds = new Set<string>();
  for (const item of items) {
    const key = id(item);
    values.has(key) ? duplicateIds.add(key) : values.set(key, item);
  }
  return { values, duplicateIds };
}

function validPair(
  pair: RequestedPair,
  row: StoredCorpusRow | undefined,
  family: TopicDiscoverySemanticSearchFamilyContract | undefined,
  rows: Indexed<StoredCorpusRow>,
  families: Indexed<TopicDiscoverySemanticSearchFamilyContract>
): row is StoredCorpusRow {
  return Boolean(
    exactId(pair.paperId)
    && exactId(pair.familyId)
    && row
    && family
    && !rows.duplicateIds.has(pair.paperId)
    && !families.duplicateIds.has(pair.familyId)
    && typeof row.title === "string"
    && typeof row.abstract === "string"
    && typeof family.query === "string"
    && Array.isArray(family.axisTerms)
    && family.axisTerms.every((term) => typeof term === "string")
    && typeof family.lens === "string"
    && typeof family.contributionIntent === "string"
  );
}

function resolveLimits(input: RunTopicDiscoverySemanticAuditInput): AuditLimits {
  return {
    max_pairs: boundedInt(input.maxPairs, DEFAULT_TOPIC_DISCOVERY_SEMANTIC_AUDIT_MAX_PAIRS, 1, MAX_TOPIC_DISCOVERY_SEMANTIC_AUDIT_PAIRS),
    max_input_bytes: boundedInt(input.maxInputBytes, DEFAULT_TOPIC_DISCOVERY_SEMANTIC_AUDIT_MAX_INPUT_BYTES, 256, MAX_TOPIC_DISCOVERY_SEMANTIC_AUDIT_INPUT_BYTES),
    abstract_chars: boundedInt(input.abstractChars, DEFAULT_TOPIC_DISCOVERY_SEMANTIC_AUDIT_ABSTRACT_CHARS, 1, MAX_TOPIC_DISCOVERY_SEMANTIC_AUDIT_ABSTRACT_CHARS),
    timeout_ms: boundedInt(input.timeoutMs, DEFAULT_TOPIC_DISCOVERY_SEMANTIC_AUDIT_TIMEOUT_MS, 1, MAX_TOPIC_DISCOVERY_SEMANTIC_AUDIT_TIMEOUT_MS)
  };
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(min, Math.min(max, Math.floor(value)));
}

function validEvidenceSpan(
  span: string | undefined,
  paper: { title: string; abstract: string },
  family: { query: string; axis_terms: string[] },
  selectionSource: TopicDiscoverySemanticPairSelectionSource
): span is string {
  if (!span || span !== span.trim()) {
    return false;
  }
  const spanTerms = normalizeTopicDiscoveryCandidateTerms(span);
  const axisTerms = new Set(
    normalizeTopicDiscoveryCandidateTerms(family.axis_terms.join(" "))
  );
  const withinEvidenceBoundary = Boolean(
    Array.from(span).length >= MIN_TOPIC_DISCOVERY_SEMANTIC_EVIDENCE_SPAN_CHARS
    && Array.from(span).length <= MAX_TOPIC_DISCOVERY_SEMANTIC_EVIDENCE_SPAN_CHARS
    && spanTerms.length >= MIN_TOPIC_DISCOVERY_SEMANTIC_EVIDENCE_SPAN_TERMS
    && (paper.title.includes(span) || paper.abstract.includes(span))
  );
  if (!withinEvidenceBoundary) {
    return false;
  }
  if (selectionSource === "lexical_match") {
    return spanTerms.some((term) => axisTerms.has(term));
  }
  const anchorCandidateTerms = new Set(
    normalizeTopicDiscoveryCandidateTerms(family.query)
      .filter((term) => !axisTerms.has(term))
  );
  return !spanTerms.every((term) => anchorCandidateTerms.has(term));
}

function normalizeVerdict(value: unknown): TopicDiscoverySemanticVerdict | undefined {
  return value === "direct_support" || value === "application_only" || value === "uncertain"
    ? value
    : undefined;
}

function uncertainJudgment(pair: RequestedPair, reason: string): TopicDiscoverySemanticJudgment {
  return {
    paper_id: pair.paperId,
    family_id: pair.familyId,
    verdict: "uncertain",
    reason: boundedReason(reason) ?? "semantic_audit_uncertain"
  };
}

function violation(
  code: TopicDiscoverySemanticProtocolViolation["code"],
  pair: RequestedPair
): TopicDiscoverySemanticProtocolViolation {
  return {
    code,
    paper_id: truncate(pair.paperId, 160),
    family_id: truncate(pair.familyId, 160)
  };
}

function boundedReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized ? truncate(normalized, MAX_TOPIC_DISCOVERY_SEMANTIC_AUDIT_REASON_CHARS) : undefined;
}

function classifyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "semantic_audit_timeout") return "semantic_audit_timeout";
  if (message === "semantic_audit_parent_aborted") return "semantic_audit_parent_aborted";
  if (message.startsWith("topic_discovery_semantic_audit_")) return "semantic_audit_parse_failure";
  return "semantic_audit_llm_failure";
}

function countVerdict(
  judgments: TopicDiscoverySemanticJudgment[],
  verdict: TopicDiscoverySemanticVerdict
): number {
  return judgments.filter((judgment) => judgment.verdict === verdict).length;
}

function payloadBytes(payload: TopicDiscoverySemanticReviewerInputPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function exactString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function exactId(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

function truncate(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

function pairKey(pair: Pick<RequestedPair, "paperId" | "familyId">): string {
  return JSON.stringify([pair.paperId, pair.familyId]);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
