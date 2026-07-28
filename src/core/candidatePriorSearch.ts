import { createHash } from "node:crypto";

import type { HypothesisCandidate } from "./analysis/researchPlanning.js";
import { hashCanonical } from "./canonicalHash.js";
import type { PriorAbsorptionCandidateContract } from "./priorAbsorption.js";
import { normalizeTopicDiscoveryScientificTerms } from "./topicDiscoveryScientificTerms.js";

export const CANDIDATE_PRIOR_SEARCH_PLAN_SCHEMA_VERSION = 1 as const;

export const CANDIDATE_PRIOR_SEARCH_QUERY_INTENTS = [
  "mechanism_object",
  "object_free_core_question_evaluation_protocol",
  "comparator_outcome"
] as const;

export const CANDIDATE_PRIOR_SEARCH_RETRIEVAL_LANES = [
  "broad_relevance",
  "recent_direct_prior"
] as const;

export type CandidatePriorSearchQueryIntent =
  (typeof CANDIDATE_PRIOR_SEARCH_QUERY_INTENTS)[number];
export type CandidatePriorSearchRetrievalLane =
  (typeof CANDIDATE_PRIOR_SEARCH_RETRIEVAL_LANES)[number];

export interface CandidatePriorSearchSort {
  field: "relevance" | "publicationDate";
  order: "desc";
}

export interface CandidatePriorSearchDateRange {
  start_date: string;
  end_date: string;
}

export interface CandidatePriorSearchLane {
  retrieval_lane: CandidatePriorSearchRetrievalLane;
  sort: CandidatePriorSearchSort;
  publication_date_range: CandidatePriorSearchDateRange | null;
}

export interface CandidatePriorSearchQueryFamily {
  family_id: string;
  query_intent: CandidatePriorSearchQueryIntent;
  query: string;
  anchor_terms: string[];
  axis_terms: string[];
  lanes: CandidatePriorSearchLane[];
  content_sha256: string;
}

export interface CandidatePriorSearchCandidatePlan {
  candidate_id: string;
  candidate_content_sha256: string;
  prior_absorption_contract_sha256: string;
  families: CandidatePriorSearchQueryFamily[];
  content_sha256: string;
}

export interface CandidatePriorSearchPlan {
  schema_version: typeof CANDIDATE_PRIOR_SEARCH_PLAN_SCHEMA_VERSION;
  artifact_kind: "candidate_prior_search_plan";
  run_id: string;
  research_cycle: number;
  generated_at: string;
  as_of_date: string;
  source_corpus: CandidatePriorSearchSourceCorpusBinding;
  recent_window: CandidatePriorSearchDateRange & {
    policy: "previous_calendar_year_start";
  };
  candidates: CandidatePriorSearchCandidatePlan[];
  content_sha256: string;
}

export interface CandidatePriorSearchSourceCorpusBinding {
  collect_attempt_id: string;
  sha256: string;
  byte_length: number;
}

export interface CandidatePriorSearchCandidateInput {
  candidate: HypothesisCandidate;
  candidateContract: PriorAbsorptionCandidateContract;
}

export interface CandidatePriorSearchPlanInput {
  runId: string;
  researchCycle: number;
  generatedAt: string;
  asOfDate: string;
  sourceCorpus: CandidatePriorSearchSourceCorpusBinding;
  candidates: CandidatePriorSearchCandidateInput[];
}

export interface CandidatePriorSearchPlanValidation {
  valid: boolean;
  reasons: string[];
  plan?: CandidatePriorSearchPlan;
  expectedPlan?: CandidatePriorSearchPlan;
}

export interface CandidatePriorSearchAttemptReceipt {
  family_id: string;
  retrieval_lane: CandidatePriorSearchRetrievalLane;
  query: string;
  fetched: number;
  selected: number;
  selected_paper_ids: string[];
  content_sha256: string;
}

export interface CandidatePriorSearchCandidateReceipt {
  candidate_id: string;
  candidate_content_sha256: string;
  prior_absorption_contract_sha256: string;
  attempts: CandidatePriorSearchAttemptReceipt[];
  content_sha256: string;
}

export interface CandidatePriorSearchReceipt {
  schema_version: 1;
  artifact_kind: "candidate_prior_search_receipt";
  run_id: string;
  research_cycle: number;
  collect_attempt_id: string;
  generated_at: string;
  plan_content_sha256: string;
  source_corpus: CandidatePriorSearchSourceCorpusBinding;
  result_corpus: {
    sha256: string;
    byte_length: number;
  };
  completed: true;
  candidates: CandidatePriorSearchCandidateReceipt[];
  content_sha256: string;
}

export interface CandidatePriorSearchAttemptResult {
  familyId: string;
  retrievalLane: CandidatePriorSearchRetrievalLane;
  query: string;
  fetched: number;
  selected: number;
  selectedPaperIds: string[];
}

export interface CandidatePriorSearchReceiptInput {
  plan: CandidatePriorSearchPlan;
  collectAttemptId: string;
  generatedAt: string;
  resultCorpusSha256: string;
  resultCorpusByteLength: number;
  attempts: CandidatePriorSearchAttemptResult[];
}

export interface CandidatePriorSearchReceiptValidation {
  valid: boolean;
  reasons: string[];
  receipt?: CandidatePriorSearchReceipt;
}

export interface CandidatePriorSearchReviewBinding {
  schema_version: 1;
  artifact_kind: "candidate_prior_search_review_binding";
  candidate_id: string;
  candidate_content_sha256: string;
  prior_absorption_contract_sha256: string;
  plan_content_sha256: string;
  receipt_content_sha256: string;
  candidate_receipt_content_sha256: string;
  selected_direct_prior_ids: string[];
  content_sha256: string;
}

export function candidatePriorSearchCandidateReceiptHasObservedRetrieval(
  receipt: CandidatePriorSearchCandidateReceipt
): boolean {
  return receipt.attempts.some((attempt) => attempt.selected > 0);
}

export function buildCandidatePriorSearchReviewBindings(
  receipt: CandidatePriorSearchReceipt
): Map<string, CandidatePriorSearchReviewBinding> {
  const bindings = new Map<string, CandidatePriorSearchReviewBinding>();
  for (const candidate of receipt.candidates) {
    const selectedDirectPriorIds = uniqueSorted(
      candidate.attempts.flatMap((attempt) => attempt.selected_paper_ids)
    );
    if (selectedDirectPriorIds.length === 0) {
      throw new Error(
        `candidate_prior_search_review_binding_selected_papers_empty:${candidate.candidate_id}`
      );
    }
    const payload: Omit<CandidatePriorSearchReviewBinding, "content_sha256"> = {
      schema_version: 1,
      artifact_kind: "candidate_prior_search_review_binding",
      candidate_id: candidate.candidate_id,
      candidate_content_sha256: candidate.candidate_content_sha256,
      prior_absorption_contract_sha256:
        candidate.prior_absorption_contract_sha256,
      plan_content_sha256: receipt.plan_content_sha256,
      receipt_content_sha256: receipt.content_sha256,
      candidate_receipt_content_sha256: candidate.content_sha256,
      selected_direct_prior_ids: selectedDirectPriorIds
    };
    bindings.set(candidate.candidate_id, {
      ...payload,
      content_sha256: hashCanonical(payload)
    });
  }
  return bindings;
}

export function isCandidatePriorSearchReviewBinding(
  value: unknown
): value is CandidatePriorSearchReviewBinding {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, new Set([
      "schema_version",
      "artifact_kind",
      "candidate_id",
      "candidate_content_sha256",
      "prior_absorption_contract_sha256",
      "plan_content_sha256",
      "receipt_content_sha256",
      "candidate_receipt_content_sha256",
      "selected_direct_prior_ids",
      "content_sha256"
    ]))
    || value.schema_version !== 1
    || value.artifact_kind !== "candidate_prior_search_review_binding"
    || !hasText(value.candidate_id)
    || !isSha256(value.candidate_content_sha256)
    || !isSha256(value.prior_absorption_contract_sha256)
    || !isSha256(value.plan_content_sha256)
    || !isSha256(value.receipt_content_sha256)
    || !isSha256(value.candidate_receipt_content_sha256)
    || !Array.isArray(value.selected_direct_prior_ids)
    || value.selected_direct_prior_ids.length === 0
    || !value.selected_direct_prior_ids.every(hasText)
    || !stringArraysEqual(
      value.selected_direct_prior_ids,
      uniqueSorted(value.selected_direct_prior_ids)
    )
    || !isSha256(value.content_sha256)
  ) {
    return false;
  }
  const { content_sha256: contentSha256, ...payload } = value;
  return hashCanonical(payload) === contentSha256;
}

const MAX_CANDIDATES = 16;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_TEXT_LENGTH = 1_200;
const MAX_TERM_LENGTH = 36;
const MAX_TERMS_PER_ROLE = 3;
const MAX_QUERY_LENGTH = 240;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const PLAN_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "run_id",
  "research_cycle",
  "generated_at",
  "as_of_date",
  "source_corpus",
  "recent_window",
  "candidates",
  "content_sha256"
]);
const SOURCE_CORPUS_FIELDS = new Set([
  "collect_attempt_id",
  "sha256",
  "byte_length"
]);
const RECENT_WINDOW_FIELDS = new Set([
  "policy",
  "start_date",
  "end_date"
]);
const CANDIDATE_PLAN_FIELDS = new Set([
  "candidate_id",
  "candidate_content_sha256",
  "prior_absorption_contract_sha256",
  "families",
  "content_sha256"
]);
const FAMILY_FIELDS = new Set([
  "family_id",
  "query_intent",
  "query",
  "anchor_terms",
  "axis_terms",
  "lanes",
  "content_sha256"
]);
const LANE_FIELDS = new Set([
  "retrieval_lane",
  "sort",
  "publication_date_range"
]);
const SORT_FIELDS = new Set(["field", "order"]);
const DATE_RANGE_FIELDS = new Set(["start_date", "end_date"]);
const CONTRACT_FIELDS = new Set([
  "contribution_object",
  "method_mechanism",
  "data_task_scope",
  "evaluation_protocol",
  "claim_ceiling",
  "falsifier",
  "comparator",
  "content_sha256"
]);

export function buildCandidatePriorSearchPlan(
  input: CandidatePriorSearchPlanInput
): CandidatePriorSearchPlan {
  const runId = requireText(input.runId, "run_id", MAX_IDENTIFIER_LENGTH);
  const researchCycle = requireResearchCycle(input.researchCycle);
  const generatedAt = requireTimestamp(input.generatedAt, "generated_at");
  const asOfDate = requireDate(input.asOfDate, "as_of_date");
  const sourceCorpus = requireSourceCorpusBinding(input.sourceCorpus);
  const recentWindow = buildRecentWindow(asOfDate);
  const candidates = buildCandidatePlans(input.candidates, recentWindow);

  const payload: Omit<CandidatePriorSearchPlan, "content_sha256"> = {
    schema_version: CANDIDATE_PRIOR_SEARCH_PLAN_SCHEMA_VERSION,
    artifact_kind: "candidate_prior_search_plan",
    run_id: runId,
    research_cycle: researchCycle,
    generated_at: generatedAt,
    as_of_date: asOfDate,
    source_corpus: sourceCorpus,
    recent_window: recentWindow,
    candidates
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function validateCandidatePriorSearchPlanIntegrity(
  value: unknown
): CandidatePriorSearchPlanValidation {
  if (!isCandidatePriorSearchPlan(value)) {
    return {
      valid: false,
      reasons: ["candidate_prior_search_plan_schema_invalid"]
    };
  }
  const reasons = validatePlanIntegrity(value);
  for (const candidate of value.candidates) {
    for (const family of candidate.families) {
      const recentLane = family.lanes.find(
        (lane) => lane.retrieval_lane === "recent_direct_prior"
      );
      if (
        !recentLane?.publication_date_range
        || recentLane.publication_date_range.start_date !== value.recent_window.start_date
        || recentLane.publication_date_range.end_date !== value.recent_window.end_date
      ) {
        reasons.push(
          `candidate_prior_search_recent_window_mismatch:${candidate.candidate_id}:${family.family_id}`
        );
      }
    }
  }
  return {
    valid: reasons.length === 0,
    reasons: uniqueSorted(reasons),
    plan: value
  };
}

export function buildCandidatePriorSearchReceipt(
  input: CandidatePriorSearchReceiptInput
): CandidatePriorSearchReceipt {
  const planValidation = validateCandidatePriorSearchPlanIntegrity(input.plan);
  if (!planValidation.valid) {
    throw new Error(
      `candidate_prior_search_receipt_plan_invalid:${planValidation.reasons.join(",")}`
    );
  }
  const collectAttemptId = requireText(
    input.collectAttemptId,
    "collect_attempt_id",
    MAX_IDENTIFIER_LENGTH
  );
  const generatedAt = requireTimestamp(input.generatedAt, "generated_at");
  const resultCorpusSha256 = requireSha256(
    input.resultCorpusSha256,
    "result_corpus_sha256"
  );
  const resultCorpusByteLength = requireNonNegativeInteger(
    input.resultCorpusByteLength,
    "result_corpus_byte_length"
  );
  const attemptsByKey = new Map<string, CandidatePriorSearchAttemptResult>();
  for (const attempt of input.attempts) {
    const key = `${attempt.familyId}::${attempt.retrievalLane}`;
    if (attemptsByKey.has(key)) {
      throw new Error("candidate_prior_search_receipt_attempt_duplicate");
    }
    attemptsByKey.set(key, attempt);
  }

  const candidates = input.plan.candidates.map((candidate) => {
    const attempts = candidate.families.flatMap((family) =>
      family.lanes.map((lane) => {
        const result = attemptsByKey.get(
          `${family.family_id}::${lane.retrieval_lane}`
        );
        if (!result || result.query !== family.query) {
          throw new Error(
            `candidate_prior_search_receipt_attempt_missing:${candidate.candidate_id}:${family.family_id}:${lane.retrieval_lane}`
          );
        }
        const selectedPaperIds = uniqueSorted(
          result.selectedPaperIds.map((paperId) =>
            requireText(paperId, "selected_paper_id", MAX_IDENTIFIER_LENGTH)
          )
        );
        const fetched = requireNonNegativeInteger(
          result.fetched,
          "attempt_fetched"
        );
        const selected = requireNonNegativeInteger(
          result.selected,
          "attempt_selected"
        );
        if (selected > fetched) {
          throw new Error("candidate_prior_search_receipt_selected_exceeds_fetched");
        }
        if (selected !== selectedPaperIds.length) {
          throw new Error("candidate_prior_search_receipt_selected_count_mismatch");
        }
        const payload: Omit<CandidatePriorSearchAttemptReceipt, "content_sha256"> = {
          family_id: family.family_id,
          retrieval_lane: lane.retrieval_lane,
          query: family.query,
          fetched,
          selected,
          selected_paper_ids: selectedPaperIds
        };
        return { ...payload, content_sha256: hashCanonical(payload) };
      })
    );
    const payload: Omit<CandidatePriorSearchCandidateReceipt, "content_sha256"> = {
      candidate_id: candidate.candidate_id,
      candidate_content_sha256: candidate.candidate_content_sha256,
      prior_absorption_contract_sha256:
        candidate.prior_absorption_contract_sha256,
      attempts
    };
    return { ...payload, content_sha256: hashCanonical(payload) };
  });
  if (attemptsByKey.size !== candidates.reduce((sum, item) => sum + item.attempts.length, 0)) {
    throw new Error("candidate_prior_search_receipt_attempt_unplanned");
  }
  const payload: Omit<CandidatePriorSearchReceipt, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "candidate_prior_search_receipt",
    run_id: input.plan.run_id,
    research_cycle: input.plan.research_cycle,
    collect_attempt_id: collectAttemptId,
    generated_at: generatedAt,
    plan_content_sha256: input.plan.content_sha256,
    source_corpus: input.plan.source_corpus,
    result_corpus: {
      sha256: resultCorpusSha256,
      byte_length: resultCorpusByteLength
    },
    completed: true,
    candidates
  };
  return { ...payload, content_sha256: hashCanonical(payload) };
}

export function validateCandidatePriorSearchReceipt(
  value: unknown,
  context: {
    plan: CandidatePriorSearchPlan;
    expectedCollectAttemptId: string;
    sourceCorpusRaw: string;
    resultCorpusRaw: string;
  }
): CandidatePriorSearchReceiptValidation {
  const reasons: string[] = [];
  const planValidation = validateCandidatePriorSearchPlanIntegrity(context.plan);
  if (!planValidation.valid) {
    reasons.push(...planValidation.reasons);
  }
  if (!isCandidatePriorSearchReceipt(value)) {
    return {
      valid: false,
      reasons: uniqueSorted([
        ...reasons,
        "candidate_prior_search_receipt_schema_invalid"
      ])
    };
  }
  const { content_sha256: receiptHash, ...receiptPayload } = value;
  if (hashCanonical(receiptPayload) !== receiptHash) {
    reasons.push("candidate_prior_search_receipt_content_hash_mismatch");
  }
  if (value.run_id !== context.plan.run_id) {
    reasons.push("candidate_prior_search_receipt_run_mismatch");
  }
  if (value.research_cycle !== context.plan.research_cycle) {
    reasons.push("candidate_prior_search_receipt_cycle_mismatch");
  }
  if (value.collect_attempt_id !== context.expectedCollectAttemptId) {
    reasons.push("candidate_prior_search_receipt_attempt_mismatch");
  }
  if (value.plan_content_sha256 !== context.plan.content_sha256) {
    reasons.push("candidate_prior_search_receipt_plan_hash_mismatch");
  }
  if (hashCanonical(value.source_corpus) !== hashCanonical(context.plan.source_corpus)) {
    reasons.push("candidate_prior_search_receipt_source_corpus_mismatch");
  }
  if (
    context.plan.source_corpus.sha256 !== sha256Text(context.sourceCorpusRaw)
    || context.plan.source_corpus.byte_length
      !== Buffer.byteLength(context.sourceCorpusRaw, "utf8")
  ) {
    reasons.push("candidate_prior_search_source_corpus_bytes_mismatch");
  }
  const resultBytes = Buffer.byteLength(context.resultCorpusRaw, "utf8");
  const resultSha256 = sha256Text(context.resultCorpusRaw);
  if (
    value.result_corpus.sha256 !== resultSha256
    || value.result_corpus.byte_length !== resultBytes
  ) {
    reasons.push("candidate_prior_search_receipt_result_corpus_mismatch");
  }
  const expectedCandidates = new Map(
    context.plan.candidates.map((candidate) => [candidate.candidate_id, candidate])
  );
  const corpusFamilies = parseCorpusQueryFamilies(context.resultCorpusRaw, reasons);
  for (const candidateReceipt of value.candidates) {
    const candidatePlan = expectedCandidates.get(candidateReceipt.candidate_id);
    if (
      !candidatePlan
      || candidateReceipt.candidate_content_sha256
        !== candidatePlan.candidate_content_sha256
      || candidateReceipt.prior_absorption_contract_sha256
        !== candidatePlan.prior_absorption_contract_sha256
    ) {
      reasons.push(
        `candidate_prior_search_receipt_candidate_mismatch:${candidateReceipt.candidate_id}`
      );
      continue;
    }
    const expectedAttempts = new Map(
      candidatePlan.families.flatMap((family) =>
        family.lanes.map((lane) => [
          `${family.family_id}::${lane.retrieval_lane}`,
          { family, lane }
        ] as const)
      )
    );
    for (const attempt of candidateReceipt.attempts) {
      const { content_sha256: attemptHash, ...attemptPayload } = attempt;
      if (hashCanonical(attemptPayload) !== attemptHash) {
        reasons.push(
          `candidate_prior_search_receipt_attempt_hash_mismatch:${attempt.family_id}:${attempt.retrieval_lane}`
        );
      }
      const expected = expectedAttempts.get(
        `${attempt.family_id}::${attempt.retrieval_lane}`
      );
      if (!expected || attempt.query !== expected.family.query) {
        reasons.push(
          `candidate_prior_search_receipt_attempt_contract_mismatch:${attempt.family_id}:${attempt.retrieval_lane}`
        );
      }
      if (attempt.selected > attempt.fetched) {
        reasons.push(
          `candidate_prior_search_receipt_selected_exceeds_fetched:${attempt.family_id}:${attempt.retrieval_lane}`
        );
      }
      if (attempt.selected !== attempt.selected_paper_ids.length) {
        reasons.push(
          `candidate_prior_search_receipt_selected_count_mismatch:${attempt.family_id}:${attempt.retrieval_lane}`
        );
      }
      for (const paperId of attempt.selected_paper_ids) {
        if (!corpusFamilies.get(paperId)?.has(attempt.family_id)) {
          reasons.push(
            `candidate_prior_search_receipt_paper_provenance_mismatch:${paperId}:${attempt.family_id}`
          );
        }
      }
      expectedAttempts.delete(
        `${attempt.family_id}::${attempt.retrieval_lane}`
      );
    }
    if (expectedAttempts.size > 0) {
      reasons.push(
        `candidate_prior_search_receipt_attempt_coverage_incomplete:${candidateReceipt.candidate_id}`
      );
    }
    if (!candidatePriorSearchCandidateReceiptHasObservedRetrieval(candidateReceipt)) {
      reasons.push(
        `candidate_prior_search_receipt_selected_papers_empty:${candidateReceipt.candidate_id}`
      );
    }
    const { content_sha256: candidateHash, ...candidatePayload } = candidateReceipt;
    if (hashCanonical(candidatePayload) !== candidateHash) {
      reasons.push(
        `candidate_prior_search_receipt_candidate_hash_mismatch:${candidateReceipt.candidate_id}`
      );
    }
    expectedCandidates.delete(candidateReceipt.candidate_id);
  }
  if (expectedCandidates.size > 0) {
    reasons.push("candidate_prior_search_receipt_candidate_coverage_incomplete");
  }
  const plannedFamilies = new Set(
    context.plan.candidates.flatMap((candidate) =>
      candidate.families.map((family) => family.family_id)
    )
  );
  validateSourceCorpusExtension({
    sourceRaw: context.sourceCorpusRaw,
    resultRaw: context.resultCorpusRaw,
    plannedFamilies,
    reasons
  });
  const listedFamilyPapers = new Map<string, Set<string>>();
  for (const candidate of value.candidates) {
    for (const attempt of candidate.attempts) {
      const papers = listedFamilyPapers.get(attempt.family_id) ?? new Set<string>();
      for (const paperId of attempt.selected_paper_ids) {
        papers.add(paperId);
      }
      listedFamilyPapers.set(attempt.family_id, papers);
    }
  }
  for (const [paperId, families] of corpusFamilies) {
    for (const familyId of families) {
      if (plannedFamilies.has(familyId) && !listedFamilyPapers.get(familyId)?.has(paperId)) {
        reasons.push(
          `candidate_prior_search_receipt_paper_unlisted:${paperId}:${familyId}`
        );
      }
    }
  }
  return {
    valid: reasons.length === 0,
    reasons: uniqueSorted(reasons),
    receipt: value
  };
}

function validateSourceCorpusExtension(input: {
  sourceRaw: string;
  resultRaw: string;
  plannedFamilies: ReadonlySet<string>;
  reasons: string[];
}): void {
  const sourceRows = parseCorpusRows(input.sourceRaw, input.reasons, "source");
  const resultRows = parseCorpusRows(input.resultRaw, input.reasons, "result");
  for (const [paperId, sourceRow] of sourceRows) {
    const resultRow = resultRows.get(paperId);
    if (!resultRow) {
      input.reasons.push(
        `candidate_prior_search_source_paper_missing:${paperId}`
      );
      continue;
    }
    const sourceFamilies = normalizeFamilyList(sourceRow.query_families);
    const resultFamilies = normalizeFamilyList(resultRow.query_families);
    const sourceFamilySet = new Set(sourceFamilies);
    const resultFamilySet = new Set(resultFamilies);
    const familyProvenanceChanged = sourceFamilies.some(
      (familyId) => !resultFamilySet.has(familyId)
    ) || resultFamilies.some(
      (familyId) =>
        !sourceFamilySet.has(familyId) && !input.plannedFamilies.has(familyId)
    );
    const sourceComparable = {
      ...sourceRow,
      ...(sourceFamilies.length > 0
        ? { query_families: sourceFamilies }
        : {})
    };
    if (sourceFamilies.length === 0) {
      delete sourceComparable.query_families;
    }
    const resultComparable = {
      ...resultRow,
      ...(sourceFamilies.length > 0
        ? { query_families: sourceFamilies }
        : {})
    };
    if (sourceFamilies.length === 0) {
      delete resultComparable.query_families;
    }
    if (
      familyProvenanceChanged
      || hashCanonical(sourceComparable) !== hashCanonical(resultComparable)
    ) {
      input.reasons.push(
        `candidate_prior_search_source_paper_modified:${paperId}`
      );
    }
  }
}

function parseCorpusRows(
  raw: string,
  reasons: string[],
  scope: "source" | "result"
): Map<string, Record<string, unknown>> {
  const rows = new Map<string, Record<string, unknown>>();
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed) || !hasText(parsed.paper_id) || rows.has(parsed.paper_id)) {
        reasons.push(`candidate_prior_search_${scope}_corpus_row_invalid`);
        continue;
      }
      rows.set(parsed.paper_id, parsed);
    } catch {
      reasons.push(`candidate_prior_search_${scope}_corpus_parse_failed`);
    }
  }
  return rows;
}

function normalizeFamilyList(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueSorted(value.filter(hasText))
    : [];
}

export function validateCandidatePriorSearchPlan(
  value: unknown,
  context: CandidatePriorSearchPlanInput
): CandidatePriorSearchPlanValidation {
  if (!isCandidatePriorSearchPlan(value)) {
    return {
      valid: false,
      reasons: ["candidate_prior_search_plan_schema_invalid"]
    };
  }

  const reasons = validatePlanIntegrity(value);
  let expectedPlan: CandidatePriorSearchPlan | undefined;
  try {
    expectedPlan = buildCandidatePriorSearchPlan(context);
    if (hashCanonical(value) !== hashCanonical(expectedPlan)) {
      reasons.push("candidate_prior_search_plan_recomputed_mismatch");
    }
  } catch (error) {
    reasons.push(normalizeValidationError(error));
  }

  return {
    valid: reasons.length === 0,
    reasons: uniqueSorted(reasons),
    plan: value,
    ...(expectedPlan ? { expectedPlan } : {})
  };
}

function buildCandidatePlans(
  inputs: CandidatePriorSearchCandidateInput[],
  recentWindow: CandidatePriorSearchPlan["recent_window"]
): CandidatePriorSearchCandidatePlan[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("candidate_prior_search_candidates_empty");
  }
  if (inputs.length > MAX_CANDIDATES) {
    throw new Error("candidate_prior_search_candidates_limit_exceeded");
  }

  const normalized = inputs.map((input, index) =>
    normalizeCandidateInput(input, index)
  );
  const candidateIds = new Set<string>();
  const contractHashes = new Set<string>();
  for (const item of normalized) {
    const candidateKey = item.candidateId.toLocaleLowerCase();
    if (candidateIds.has(candidateKey)) {
      throw new Error("candidate_prior_search_candidate_duplicate");
    }
    if (contractHashes.has(item.contract.content_sha256)) {
      throw new Error("candidate_prior_search_contract_duplicate");
    }
    candidateIds.add(candidateKey);
    contractHashes.add(item.contract.content_sha256);
  }

  return normalized
    .sort((left, right) => compareText(left.candidateId, right.candidateId))
    .map((item) => buildCandidatePlan(item, recentWindow));
}

function normalizeCandidateInput(
  input: CandidatePriorSearchCandidateInput,
  index: number
): {
  candidate: HypothesisCandidate;
  candidateId: string;
  candidateContentSha256: string;
  contract: PriorAbsorptionCandidateContract;
} {
  if (!isRecord(input) || !isRecord(input.candidate)) {
    throw new Error(`candidate_prior_search_candidate_invalid:${index}`);
  }
  validateHypothesisCandidate(input.candidate, index);
  validateCandidateContract(input.candidateContract, index);

  const candidateId = requireText(
    input.candidate.id,
    `candidate_id:${index}`,
    MAX_IDENTIFIER_LENGTH
  );
  const candidateSnapshot = normalizeJsonValue(input.candidate, 0);
  return {
    candidate: input.candidate,
    candidateId,
    candidateContentSha256: hashCanonical(candidateSnapshot),
    contract: input.candidateContract
  };
}

function buildCandidatePlan(
  input: {
    candidate: HypothesisCandidate;
    candidateId: string;
    candidateContentSha256: string;
    contract: PriorAbsorptionCandidateContract;
  },
  recentWindow: CandidatePriorSearchPlan["recent_window"]
): CandidatePriorSearchCandidatePlan {
  const families = buildQueryFamilies(input.candidate, input.contract, recentWindow);
  const payload: Omit<CandidatePriorSearchCandidatePlan, "content_sha256"> = {
    candidate_id: input.candidateId,
    candidate_content_sha256: input.candidateContentSha256,
    prior_absorption_contract_sha256: input.contract.content_sha256,
    families
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function buildQueryFamilies(
  candidate: HypothesisCandidate,
  contract: PriorAbsorptionCandidateContract,
  recentWindow: CandidatePriorSearchPlan["recent_window"]
): CandidatePriorSearchQueryFamily[] {
  const contributionObjectTerms = extractTerms(contract.contribution_object);
  const dataScopeTerms = extractTerms(contract.data_task_scope);
  const objectTerms = uniqueTerms([
    ...contributionObjectTerms,
    ...dataScopeTerms
  ]);
  const mechanismTerms = extractTerms(contract.method_mechanism);
  const evaluationTerms = extractTerms(contract.evaluation_protocol);
  const comparatorTerms = extractTerms(contract.comparator);
  const outcomeTerms = extractTerms([
    contract.claim_ceiling,
    contract.falsifier,
    candidate.primary_metric,
    candidate.meaningful_effect,
    candidate.contribution_claim
  ].filter((value): value is string => typeof value === "string").join(" "));

  const families = [
    buildQueryFamily({
      intent: "mechanism_object",
      anchorTerms: takeTerms(objectTerms, []),
      axisTerms: takeTerms(mechanismTerms, objectTerms),
      contractSha256: contract.content_sha256,
      recentWindow
    }),
    buildQueryFamily({
      intent: "object_free_core_question_evaluation_protocol",
      anchorTerms: takeTerms(mechanismTerms, objectTerms),
      axisTerms: takeTerms(evaluationTerms, [
        ...objectTerms,
        ...mechanismTerms
      ]),
      contractSha256: contract.content_sha256,
      recentWindow
    }),
    buildQueryFamily({
      intent: "comparator_outcome",
      anchorTerms: takeTerms(comparatorTerms, []),
      axisTerms: takeTerms(outcomeTerms, comparatorTerms),
      contractSha256: contract.content_sha256,
      recentWindow
    })
  ];

  if (new Set(families.map((family) => family.query)).size !== families.length) {
    throw new Error("candidate_prior_search_query_family_duplicate");
  }
  return families;
}

function buildQueryFamily(input: {
  intent: CandidatePriorSearchQueryIntent;
  anchorTerms: string[];
  axisTerms: string[];
  contractSha256: string;
  recentWindow: CandidatePriorSearchPlan["recent_window"];
}): CandidatePriorSearchQueryFamily {
  if (input.anchorTerms.length === 0 || input.axisTerms.length === 0) {
    throw new Error(`candidate_prior_search_query_terms_empty:${input.intent}`);
  }
  const query = [...input.anchorTerms, ...input.axisTerms].join(" ");
  if (!query || query.length > MAX_QUERY_LENGTH) {
    throw new Error(`candidate_prior_search_query_invalid:${input.intent}`);
  }
  const familyIdentity = {
    query_intent: input.intent,
    query,
    anchor_terms: input.anchorTerms,
    axis_terms: input.axisTerms
  };
  const payload: Omit<CandidatePriorSearchQueryFamily, "content_sha256"> = {
    family_id: `family_${CANDIDATE_PRIOR_SEARCH_QUERY_INTENTS.indexOf(input.intent) + 1}_${hashCanonical({
      prior_absorption_contract_sha256: input.contractSha256,
      ...familyIdentity
    }).slice(0, 16)}`,
    ...familyIdentity,
    lanes: buildRetrievalLanes(input.recentWindow)
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function buildRetrievalLanes(
  recentWindow: CandidatePriorSearchPlan["recent_window"]
): CandidatePriorSearchLane[] {
  return [
    {
      retrieval_lane: "broad_relevance",
      sort: { field: "relevance", order: "desc" },
      publication_date_range: null
    },
    {
      retrieval_lane: "recent_direct_prior",
      sort: { field: "publicationDate", order: "desc" },
      publication_date_range: {
        start_date: recentWindow.start_date,
        end_date: recentWindow.end_date
      }
    }
  ];
}

function buildRecentWindow(
  asOfDate: string
): CandidatePriorSearchPlan["recent_window"] {
  const asOfYear = Number(asOfDate.slice(0, 4));
  return {
    policy: "previous_calendar_year_start",
    start_date: `${String(asOfYear - 1).padStart(4, "0")}-01-01`,
    end_date: asOfDate
  };
}

function extractTerms(value: string): string[] {
  return uniqueTerms(
    normalizeTopicDiscoveryScientificTerms(
      normalizeAndCapText(value, MAX_TEXT_LENGTH)
    ).map((term) => normalizeAndCapText(term, MAX_TERM_LENGTH))
  );
}

function takeTerms(values: string[], excluded: string[]): string[] {
  const excludedSet = new Set(excluded);
  return values
    .filter((term) => !excludedSet.has(term))
    .slice(0, MAX_TERMS_PER_ROLE);
}

function validateHypothesisCandidate(
  candidate: HypothesisCandidate,
  index: number
): void {
  requireText(candidate.id, `candidate_id:${index}`, MAX_IDENTIFIER_LENGTH);
  requireText(candidate.text, `candidate_text:${index}`, MAX_TEXT_LENGTH);
  for (const [field, value] of [
    ["novelty", candidate.novelty],
    ["feasibility", candidate.feasibility],
    ["testability", candidate.testability],
    ["cost", candidate.cost],
    ["expected_gain", candidate.expected_gain]
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`candidate_prior_search_candidate_number_invalid:${index}:${field}`);
    }
  }
  if (
    !Array.isArray(candidate.evidence_links)
    || candidate.evidence_links.length > 128
    || candidate.evidence_links.some((value) => typeof value !== "string")
  ) {
    throw new Error(`candidate_prior_search_candidate_evidence_invalid:${index}`);
  }
}

function validateCandidateContract(
  value: unknown,
  index: number
): asserts value is PriorAbsorptionCandidateContract {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, CONTRACT_FIELDS)
    || !isSha256(value.content_sha256)
  ) {
    throw new Error(`candidate_prior_search_contract_invalid:${index}`);
  }
  for (const field of [
    "contribution_object",
    "method_mechanism",
    "data_task_scope",
    "evaluation_protocol",
    "claim_ceiling",
    "falsifier",
    "comparator"
  ] as const) {
    requireText(value[field], `candidate_contract:${index}:${field}`, MAX_TEXT_LENGTH);
  }
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    throw new Error(`candidate_prior_search_contract_hash_mismatch:${index}`);
  }
}

function validatePlanIntegrity(plan: CandidatePriorSearchPlan): string[] {
  const reasons: string[] = [];
  const { content_sha256: planHash, ...planPayload } = plan;
  if (hashCanonical(planPayload) !== planHash) {
    reasons.push("candidate_prior_search_plan_content_hash_mismatch");
  }
  for (const candidate of plan.candidates) {
    const { content_sha256: candidateHash, ...candidatePayload } = candidate;
    if (hashCanonical(candidatePayload) !== candidateHash) {
      reasons.push(
        `candidate_prior_search_candidate_content_hash_mismatch:${candidate.candidate_id}`
      );
    }
    for (const family of candidate.families) {
      const { content_sha256: familyHash, ...familyPayload } = family;
      if (hashCanonical(familyPayload) !== familyHash) {
        reasons.push(
          `candidate_prior_search_family_content_hash_mismatch:${candidate.candidate_id}:${family.family_id}`
        );
      }
    }
  }
  return reasons;
}

function isCandidatePriorSearchPlan(value: unknown): value is CandidatePriorSearchPlan {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, PLAN_FIELDS)
    || value.schema_version !== CANDIDATE_PRIOR_SEARCH_PLAN_SCHEMA_VERSION
    || value.artifact_kind !== "candidate_prior_search_plan"
    || !hasText(value.run_id)
    || value.run_id.length > MAX_IDENTIFIER_LENGTH
    || !isResearchCycle(value.research_cycle)
    || !isCanonicalTimestamp(value.generated_at)
    || !isDate(value.as_of_date)
    || !isSourceCorpusBinding(value.source_corpus)
    || !isRecentWindow(value.recent_window, value.as_of_date)
    || !Array.isArray(value.candidates)
    || value.candidates.length === 0
    || value.candidates.length > MAX_CANDIDATES
    || !value.candidates.every(isCandidatePlan)
    || !isSha256(value.content_sha256)
  ) {
    return false;
  }
  const candidateIds = value.candidates.map((candidate) =>
    candidate.candidate_id.toLocaleLowerCase()
  );
  const contractHashes = value.candidates.map(
    (candidate) => candidate.prior_absorption_contract_sha256
  );
  return (
    new Set(candidateIds).size === candidateIds.length
    && new Set(contractHashes).size === contractHashes.length
    && value.candidates.every((candidate, index, candidates) =>
      index === 0
      || compareText(candidates[index - 1].candidate_id, candidate.candidate_id) < 0
    )
  );
}

function isCandidatePriorSearchReceipt(
  value: unknown
): value is CandidatePriorSearchReceipt {
  if (
    !isRecord(value)
    || value.schema_version !== 1
    || value.artifact_kind !== "candidate_prior_search_receipt"
    || !hasText(value.run_id)
    || !isResearchCycle(value.research_cycle)
    || !hasText(value.collect_attempt_id)
    || !isCanonicalTimestamp(value.generated_at)
    || !isSha256(value.plan_content_sha256)
    || !isSourceCorpusBinding(value.source_corpus)
    || !isRecord(value.result_corpus)
    || !isSha256(value.result_corpus.sha256)
    || !isNonNegativeInteger(value.result_corpus.byte_length)
    || value.completed !== true
    || !Array.isArray(value.candidates)
    || value.candidates.length === 0
    || !value.candidates.every(isCandidateReceipt)
    || !isSha256(value.content_sha256)
  ) {
    return false;
  }
  const allowed = new Set([
    "schema_version",
    "artifact_kind",
    "run_id",
    "research_cycle",
    "collect_attempt_id",
    "generated_at",
    "plan_content_sha256",
    "source_corpus",
    "result_corpus",
    "completed",
    "candidates",
    "content_sha256"
  ]);
  return hasOnlyFields(value, allowed)
    && hasOnlyFields(value.result_corpus, new Set(["sha256", "byte_length"]));
}

function isCandidateReceipt(
  value: unknown
): value is CandidatePriorSearchCandidateReceipt {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, new Set([
      "candidate_id",
      "candidate_content_sha256",
      "prior_absorption_contract_sha256",
      "attempts",
      "content_sha256"
    ]))
    || !hasText(value.candidate_id)
    || !isSha256(value.candidate_content_sha256)
    || !isSha256(value.prior_absorption_contract_sha256)
    || !Array.isArray(value.attempts)
    || value.attempts.length === 0
    || !value.attempts.every(isAttemptReceipt)
    || !isSha256(value.content_sha256)
  ) {
    return false;
  }
  const keys = value.attempts.map(
    (attempt) => `${attempt.family_id}::${attempt.retrieval_lane}`
  );
  return new Set(keys).size === keys.length;
}

function isAttemptReceipt(
  value: unknown
): value is CandidatePriorSearchAttemptReceipt {
  return isRecord(value)
    && hasOnlyFields(value, new Set([
      "family_id",
      "retrieval_lane",
      "query",
      "fetched",
      "selected",
      "selected_paper_ids",
      "content_sha256"
    ]))
    && hasText(value.family_id)
    && CANDIDATE_PRIOR_SEARCH_RETRIEVAL_LANES.includes(
      value.retrieval_lane as CandidatePriorSearchRetrievalLane
    )
    && hasText(value.query)
    && isNonNegativeInteger(value.fetched)
    && isNonNegativeInteger(value.selected)
    && Array.isArray(value.selected_paper_ids)
    && value.selected_paper_ids.every(hasText)
    && new Set(value.selected_paper_ids).size === value.selected_paper_ids.length
    && isSha256(value.content_sha256);
}

function requireSourceCorpusBinding(
  value: unknown
): CandidatePriorSearchSourceCorpusBinding {
  if (!isSourceCorpusBinding(value)) {
    throw new Error("candidate_prior_search_source_corpus_invalid");
  }
  return {
    collect_attempt_id: value.collect_attempt_id.trim(),
    sha256: value.sha256,
    byte_length: value.byte_length
  };
}

function isSourceCorpusBinding(
  value: unknown
): value is CandidatePriorSearchSourceCorpusBinding {
  return isRecord(value)
    && hasOnlyFields(value, SOURCE_CORPUS_FIELDS)
    && hasText(value.collect_attempt_id)
    && value.collect_attempt_id.length <= MAX_IDENTIFIER_LENGTH
    && isSha256(value.sha256)
    && isNonNegativeInteger(value.byte_length);
}

function requireSha256(value: unknown, field: string): string {
  if (!isSha256(value)) {
    throw new Error(`candidate_prior_search_sha256_invalid:${field}`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!isNonNegativeInteger(value)) {
    throw new Error(`candidate_prior_search_integer_invalid:${field}`);
  }
  return value;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseCorpusQueryFamilies(
  raw: string,
  reasons: string[]
): Map<string, Set<string>> {
  const rows = new Map<string, Set<string>>();
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed) || !hasText(parsed.paper_id)) {
        reasons.push("candidate_prior_search_receipt_corpus_row_invalid");
        continue;
      }
      const families = Array.isArray(parsed.query_families)
        ? parsed.query_families.filter(hasText)
        : [];
      rows.set(parsed.paper_id, new Set(families));
    } catch {
      reasons.push("candidate_prior_search_receipt_corpus_parse_failed");
    }
  }
  return rows;
}

function isCandidatePlan(value: unknown): value is CandidatePriorSearchCandidatePlan {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, CANDIDATE_PLAN_FIELDS)
    || !hasText(value.candidate_id)
    || value.candidate_id.length > MAX_IDENTIFIER_LENGTH
    || !isSha256(value.candidate_content_sha256)
    || !isSha256(value.prior_absorption_contract_sha256)
    || !Array.isArray(value.families)
    || value.families.length !== CANDIDATE_PRIOR_SEARCH_QUERY_INTENTS.length
    || !value.families.every(isQueryFamily)
    || !isSha256(value.content_sha256)
  ) {
    return false;
  }
  return value.families.every(
    (family, index) =>
      family.query_intent === CANDIDATE_PRIOR_SEARCH_QUERY_INTENTS[index]
  ) && new Set(value.families.map((family) => family.family_id)).size
    === value.families.length;
}

function isQueryFamily(value: unknown): value is CandidatePriorSearchQueryFamily {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, FAMILY_FIELDS)
    || !hasText(value.family_id)
    || !isQueryIntent(value.query_intent)
    || !hasText(value.query)
    || value.query.length > MAX_QUERY_LENGTH
    || !isTermArray(value.anchor_terms)
    || !isTermArray(value.axis_terms)
    || value.anchor_terms.length === 0
    || value.axis_terms.length === 0
    || value.anchor_terms.length > MAX_TERMS_PER_ROLE
    || value.axis_terms.length > MAX_TERMS_PER_ROLE
    || !Array.isArray(value.lanes)
    || value.lanes.length !== CANDIDATE_PRIOR_SEARCH_RETRIEVAL_LANES.length
    || !value.lanes.every(isRetrievalLane)
    || !isSha256(value.content_sha256)
  ) {
    return false;
  }
  const terms = [...value.anchor_terms, ...value.axis_terms];
  return (
    new Set(terms).size === terms.length
    && value.query === terms.join(" ")
    && value.lanes.every(
      (lane, index) =>
        lane.retrieval_lane === CANDIDATE_PRIOR_SEARCH_RETRIEVAL_LANES[index]
    )
  );
}

function isRetrievalLane(value: unknown): value is CandidatePriorSearchLane {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, LANE_FIELDS)
    || !isRecord(value.sort)
    || !hasOnlyFields(value.sort, SORT_FIELDS)
    || value.sort.order !== "desc"
  ) {
    return false;
  }
  if (value.retrieval_lane === "broad_relevance") {
    return value.sort.field === "relevance" && value.publication_date_range === null;
  }
  return (
    value.retrieval_lane === "recent_direct_prior"
    && value.sort.field === "publicationDate"
    && isDateRange(value.publication_date_range)
  );
}

function isRecentWindow(value: unknown, asOfDate: string): boolean {
  return (
    isRecord(value)
    && hasOnlyFields(value, RECENT_WINDOW_FIELDS)
    && value.policy === "previous_calendar_year_start"
    && isDate(value.start_date)
    && value.end_date === asOfDate
    && value.start_date ===
      `${String(Number(asOfDate.slice(0, 4)) - 1).padStart(4, "0")}-01-01`
  );
}

function isDateRange(value: unknown): value is CandidatePriorSearchDateRange {
  return (
    isRecord(value)
    && hasOnlyFields(value, DATE_RANGE_FIELDS)
    && isDate(value.start_date)
    && isDate(value.end_date)
    && value.start_date <= value.end_date
  );
}

function isTermArray(value: unknown): value is string[] {
  return (
    Array.isArray(value)
    && value.every(
      (term) =>
        hasText(term)
        && term.length <= MAX_TERM_LENGTH
        && term === normalizeAndCapText(term, MAX_TERM_LENGTH)
    )
  );
}

function isQueryIntent(value: unknown): value is CandidatePriorSearchQueryIntent {
  return (
    typeof value === "string"
    && CANDIDATE_PRIOR_SEARCH_QUERY_INTENTS.includes(
      value as CandidatePriorSearchQueryIntent
    )
  );
}

function requireText(
  value: unknown,
  field: string,
  maxLength: number
): string {
  if (typeof value !== "string") {
    throw new Error(`candidate_prior_search_text_invalid:${field}`);
  }
  const normalized = normalizeAndCapText(value, maxLength);
  if (!normalized) {
    throw new Error(`candidate_prior_search_text_empty:${field}`);
  }
  return normalized;
}

function requireResearchCycle(value: unknown): number {
  if (!isResearchCycle(value)) {
    throw new Error("candidate_prior_search_research_cycle_invalid");
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`candidate_prior_search_timestamp_invalid:${field}`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`candidate_prior_search_timestamp_invalid:${field}`);
  }
  return timestamp.toISOString();
}

function requireDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`candidate_prior_search_date_invalid:${field}`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`candidate_prior_search_date_invalid:${field}`);
  }
  return date.toISOString().slice(0, 10);
}

function normalizeJsonValue(value: unknown, depth: number): unknown {
  if (depth > 8) {
    throw new Error("candidate_prior_search_candidate_depth_exceeded");
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("candidate_prior_search_candidate_number_invalid");
    }
    return value;
  }
  if (typeof value === "string") {
    return normalizeAndCapText(value, MAX_TEXT_LENGTH);
  }
  if (Array.isArray(value)) {
    if (value.length > 128) {
      throw new Error("candidate_prior_search_candidate_array_limit_exceeded");
    }
    return value.map((item) => normalizeJsonValue(item, depth + 1));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [
        normalizeAndCapText(key, MAX_IDENTIFIER_LENGTH),
        normalizeJsonValue(item, depth + 1)
      ]);
    return Object.fromEntries(entries);
  }
  throw new Error("candidate_prior_search_candidate_value_invalid");
}

function normalizeAndCapText(value: string, maxLength: number): string {
  return Array.from(value.normalize("NFKC").replace(/\s+/gu, " ").trim())
    .slice(0, maxLength)
    .join("");
}

function normalizeValidationError(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) {
    return "candidate_prior_search_plan_context_invalid";
  }
  return error.message
    .replace(/[^a-z0-9_:.\/-]+/giu, "_")
    .slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyFields(
  value: Record<string, unknown>,
  allowed: Set<string>
): boolean {
  return Object.keys(value).every((field) => allowed.has(field));
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isResearchCycle(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  const timestamp = new Date(value);
  return (
    Number.isFinite(timestamp.getTime())
    && timestamp.toISOString() === value
  );
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime())
    && date.toISOString().slice(0, 10) === value
  );
}

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
