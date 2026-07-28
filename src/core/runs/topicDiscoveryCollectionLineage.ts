import path from "node:path";
import { promises as fs } from "node:fs";

import {
  validateCandidatePriorSearchPlanIntegrity,
  validateCandidatePriorSearchReceipt,
  type CandidatePriorSearchPlan
} from "../candidatePriorSearch.js";
import { auditCollectAttemptArchiveIntegrity } from "../collection/collectAttemptArchive.js";
import { TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT } from "../collection/topicDiscoveryArtifactVersions.js";
import { validateTopicDiscoverySemanticLineage } from "./topicDiscoverySemanticLineage.js";

const MAX_CANDIDATE_PRIOR_DEPTH = 3;
const BROAD_LINEAGE_PATHS = [
  "collect_query_plan.json",
  "collect_corpus_quality.json",
  "collect_semantic_review_input.json",
  "collect_semantic_review.json",
  "collect_topic_discovery_candidates.jsonl",
  "corpus.jsonl"
] as const;
const CANDIDATE_LINEAGE_PATHS = [
  "collect_query_plan.json",
  "collect_candidate_prior_search_plan.json",
  "collect_candidate_prior_search_receipt.json",
  "corpus.jsonl"
] as const;

export interface TopicDiscoveryCollectionAuthorizationLineageInput {
  runDir: string;
  expectedRunId: string;
  expectedResearchCycle: number;
  expectedAttemptId?: string;
  queryPlanRaw?: string;
  qualityRaw?: string;
  semanticReviewInputRaw?: string;
  semanticReviewRaw?: string;
  candidatesRaw?: string;
  corpusRaw?: string;
  candidatePriorPlanRaw?: string;
  candidatePriorReceiptRaw?: string;
}

export interface TopicDiscoveryCollectionAuthorizationLineage {
  trusted: boolean;
  mode: "topic_portfolio" | "candidate_prior_portfolio" | "unknown";
  reasonCodes: string[];
}

interface CandidateLayerInput {
  runDir: string;
  expectedRunId: string;
  expectedResearchCycle: number;
  expectedAttemptId: string;
  queryPlanRaw: string;
  planRaw: string;
  receiptRaw: string;
  corpusRaw: string;
  depth: number;
  visitedAttemptIds: Set<string>;
  liveArtifacts: ReadonlyMap<string, string>;
}

export async function validateTopicDiscoveryCollectionAuthorizationLineage(
  input: TopicDiscoveryCollectionAuthorizationLineageInput
): Promise<TopicDiscoveryCollectionAuthorizationLineage> {
  const queryPlan = parseRecord(input.queryPlanRaw);
  if (queryPlan?.strategy === "topic_portfolio") {
    const validation = validateTopicDiscoverySemanticLineage({
      expectedAttemptId: input.expectedAttemptId,
      qualityRaw: input.qualityRaw,
      semanticReviewInputRaw: input.semanticReviewInputRaw,
      semanticReviewRaw: input.semanticReviewRaw,
      candidatesRaw: input.candidatesRaw,
      queryPlanRaw: input.queryPlanRaw,
      corpusRaw: input.corpusRaw
    });
    return {
      trusted: validation.trusted,
      mode: "topic_portfolio",
      reasonCodes: [...validation.reasonCodes]
    };
  }
  if (queryPlan?.strategy !== "candidate_prior_portfolio") {
    return {
      trusted: false,
      mode: "unknown",
      reasonCodes: ["collect_authorization_lineage_strategy_invalid"]
    };
  }
  const expectedAttemptId = text(input.expectedAttemptId);
  if (!expectedAttemptId) {
    return {
      trusted: false,
      mode: "candidate_prior_portfolio",
      reasonCodes: ["collect_authorization_lineage_expected_attempt_missing"]
    };
  }
  const liveArtifacts = new Map<string, string>([
    ["collect_query_plan.json", input.queryPlanRaw ?? ""],
    [
      "collect_candidate_prior_search_plan.json",
      input.candidatePriorPlanRaw ?? ""
    ],
    [
      "collect_candidate_prior_search_receipt.json",
      input.candidatePriorReceiptRaw ?? ""
    ],
    ["corpus.jsonl", input.corpusRaw ?? ""]
  ]);
  const reasons = await validateCandidateLayer({
    runDir: input.runDir,
    expectedRunId: input.expectedRunId,
    expectedResearchCycle: input.expectedResearchCycle,
    expectedAttemptId,
    queryPlanRaw: input.queryPlanRaw ?? "",
    planRaw: input.candidatePriorPlanRaw ?? "",
    receiptRaw: input.candidatePriorReceiptRaw ?? "",
    corpusRaw: input.corpusRaw ?? "",
    depth: 0,
    visitedAttemptIds: new Set<string>(),
    liveArtifacts
  });
  return {
    trusted: reasons.length === 0,
    mode: "candidate_prior_portfolio",
    reasonCodes: unique(reasons)
  };
}

async function validateCandidateLayer(input: CandidateLayerInput): Promise<string[]> {
  const reasons: string[] = [];
  if (input.depth > MAX_CANDIDATE_PRIOR_DEPTH) {
    return ["collect_authorization_candidate_prior_depth_exceeded"];
  }
  if (input.visitedAttemptIds.has(input.expectedAttemptId)) {
    return ["collect_authorization_candidate_prior_cycle_detected"];
  }
  const visitedAttemptIds = new Set(input.visitedAttemptIds);
  visitedAttemptIds.add(input.expectedAttemptId);

  const queryPlan = parseRecord(input.queryPlanRaw);
  const planValue = parseJson(input.planRaw);
  const planValidation = validateCandidatePriorSearchPlanIntegrity(planValue);
  const embeddedPlanValidation = validateCandidatePriorSearchPlanIntegrity(
    queryPlan?.candidate_prior_search_plan
  );
  reasons.push(
    ...planValidation.reasons.map(
      (reason) => `collect_authorization_candidate_prior_plan_invalid:${reason}`
    ),
    ...embeddedPlanValidation.reasons.map(
      (reason) => `collect_authorization_candidate_prior_embedded_plan_invalid:${reason}`
    )
  );
  const plan = planValidation.plan;
  if (
    !queryPlan
    || queryPlan.version !== TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.version
    || queryPlan.term_normalization_version
      !== TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.term_normalization_version
    || queryPlan.candidate_recall_semantics_version
      !== TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.candidate_recall_semantics_version
    || queryPlan.research_mode !== "topic_discovery"
    || queryPlan.strategy !== "candidate_prior_portfolio"
    || queryPlan.collect_attempt_id !== input.expectedAttemptId
  ) {
    reasons.push("collect_authorization_candidate_prior_query_plan_invalid");
  }
  if (
    !plan
    || !embeddedPlanValidation.plan
    || plan.content_sha256 !== embeddedPlanValidation.plan.content_sha256
  ) {
    reasons.push("collect_authorization_candidate_prior_plan_projection_mismatch");
  }
  if (plan?.run_id !== input.expectedRunId) {
    reasons.push("collect_authorization_candidate_prior_plan_run_mismatch");
  }
  if (
    plan
    && plan.research_cycle + 1 !== input.expectedResearchCycle
  ) {
    reasons.push("collect_authorization_candidate_prior_plan_cycle_mismatch");
  }
  if (plan && !queryPlanMatchesCandidatePlan(queryPlan, plan)) {
    reasons.push("collect_authorization_candidate_prior_query_family_mismatch");
  }
  reasons.push(...await auditCollectAttemptArchiveIntegrity({
    runDir: input.runDir,
    expectedRunId: input.expectedRunId,
    expectedAttemptId: input.expectedAttemptId,
    requiredArtifacts: input.liveArtifacts
  }));
  if (!plan) {
    return unique(reasons);
  }

  const parentAttemptId = plan.source_corpus.collect_attempt_id;
  if (
    parentAttemptId === input.expectedAttemptId
    || visitedAttemptIds.has(parentAttemptId)
  ) {
    reasons.push("collect_authorization_candidate_prior_cycle_detected");
    return unique(reasons);
  }
  const parent = await readAttemptArtifacts(
    input.runDir,
    parentAttemptId,
    [...BROAD_LINEAGE_PATHS, ...CANDIDATE_LINEAGE_PATHS]
  );
  const receiptValidation = validateCandidatePriorSearchReceipt(
    parseJson(input.receiptRaw),
    {
      plan,
      expectedCollectAttemptId: input.expectedAttemptId,
      sourceCorpusRaw: parent.get("corpus.jsonl") ?? "",
      resultCorpusRaw: input.corpusRaw
    }
  );
  reasons.push(
    ...receiptValidation.reasons.map(
      (reason) => `collect_authorization_candidate_prior_receipt_invalid:${reason}`
    )
  );

  const parentQueryPlanRaw = parent.get("collect_query_plan.json") ?? "";
  const parentQueryPlan = parseRecord(parentQueryPlanRaw);
  if (parentQueryPlan?.strategy === "candidate_prior_portfolio") {
    reasons.push(...await validateCandidateLayer({
      runDir: input.runDir,
      expectedRunId: input.expectedRunId,
      expectedResearchCycle: plan.research_cycle,
      expectedAttemptId: parentAttemptId,
      queryPlanRaw: parentQueryPlanRaw,
      planRaw: parent.get("collect_candidate_prior_search_plan.json") ?? "",
      receiptRaw: parent.get("collect_candidate_prior_search_receipt.json") ?? "",
      corpusRaw: parent.get("corpus.jsonl") ?? "",
      depth: input.depth + 1,
      visitedAttemptIds,
      liveArtifacts: pickArtifacts(parent, CANDIDATE_LINEAGE_PATHS)
    }));
    return unique(reasons);
  }
  if (parentQueryPlan?.strategy !== "topic_portfolio") {
    reasons.push("collect_authorization_parent_strategy_invalid");
    return unique(reasons);
  }
  reasons.push(...await auditCollectAttemptArchiveIntegrity({
    runDir: input.runDir,
    expectedRunId: input.expectedRunId,
    expectedAttemptId: parentAttemptId,
    requiredArtifacts: pickArtifacts(parent, BROAD_LINEAGE_PATHS)
  }));
  const semanticLineage = validateTopicDiscoverySemanticLineage({
    expectedAttemptId: parentAttemptId,
    queryPlanRaw: parentQueryPlanRaw,
    qualityRaw: parent.get("collect_corpus_quality.json"),
    semanticReviewInputRaw: parent.get("collect_semantic_review_input.json"),
    semanticReviewRaw: parent.get("collect_semantic_review.json"),
    candidatesRaw: parent.get("collect_topic_discovery_candidates.jsonl"),
    corpusRaw: parent.get("corpus.jsonl")
  });
  reasons.push(...semanticLineage.reasonCodes);
  return unique(reasons);
}

function queryPlanMatchesCandidatePlan(
  queryPlan: Record<string, unknown> | undefined,
  plan: CandidatePriorSearchPlan
): boolean {
  if (!Array.isArray(queryPlan?.selected_families)) {
    return false;
  }
  const expected = new Map(
    plan.candidates.flatMap((candidate) =>
      candidate.families.flatMap((family) =>
        family.lanes.map((lane) => [
          `${family.family_id}::${lane.retrieval_lane}`,
          family.query
        ] as const)
      )
    )
  );
  if (queryPlan.selected_families.length !== expected.size) {
    return false;
  }
  for (const value of queryPlan.selected_families) {
    if (!isRecord(value)) {
      return false;
    }
    const familyId = text(value.query_family);
    const lane = value.retrieval_lane;
    const query = text(value.query);
    if (
      !familyId
      || (lane !== "broad_relevance" && lane !== "recent_direct_prior")
      || value.source !== "candidate_prior_plan"
      || expected.get(`${familyId}::${lane}`) !== query
    ) {
      return false;
    }
    expected.delete(`${familyId}::${lane}`);
  }
  return expected.size === 0;
}

async function readAttemptArtifacts(
  runDir: string,
  attemptId: string,
  paths: readonly string[]
): Promise<Map<string, string>> {
  const uniquePaths = [...new Set(paths)];
  const entries = await Promise.all(uniquePaths.map(async (relativePath) => {
    const filePath = path.join(runDir, "collect_attempts", attemptId, relativePath);
    try {
      return [relativePath, await fs.readFile(filePath, "utf8")] as const;
    } catch {
      return [relativePath, ""] as const;
    }
  }));
  return new Map(entries);
}

function pickArtifacts(
  source: ReadonlyMap<string, string>,
  paths: readonly string[]
): Map<string, string> {
  return new Map(paths.map((relativePath) => [
    relativePath,
    source.get(relativePath) ?? ""
  ]));
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function parseRecord(raw: string | undefined): Record<string, unknown> | undefined {
  const value = raw ? parseJson(raw) : undefined;
  return isRecord(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
