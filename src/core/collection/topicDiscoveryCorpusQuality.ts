import { createHash } from "node:crypto";

import {
  extractLiteratureQueryPositiveTerms,
  extractLiteratureTermSequence,
  isSubstantiveTopicDiscoveryAxisTerm,
  parseTopicDiscoveryLiteratureQuery
} from "../runConstraints.js";
import {
  buildTopicDiscoveryCandidateFamilySignature,
  normalizeTopicDiscoveryCandidateObjectTerms,
  normalizeTopicDiscoveryCandidateTerms,
  normalizeTopicDiscoveryScientificObjectTerms,
  TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
  TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
} from "../topicDiscoveryScientificTerms.js";
import { StoredCorpusRow } from "./types.js";
import type {
  TopicDiscoverySemanticAuditTrace,
  TopicDiscoverySemanticJudgment
} from "./topicDiscoverySemanticAudit.js";
import { TOPIC_DISCOVERY_PROVIDER_RECALL_FLOOR_PER_FAMILY } from "./topicDiscoverySemanticAudit.js";

const MINIMUM_SHARED_ANCHOR_TERMS = 2;
const DEFAULT_MINIMUM_RELEVANT_PAPERS = 8;
const MINIMUM_COVERED_QUERY_FAMILIES = 2;
const MINIMUM_RELEVANT_PAPERS_PER_FAMILY = 2;
const MINIMUM_SEMANTIC_PRECISION_PER_FAMILY = 0.5;
const MAXIMUM_ANCHOR_WINDOW_TOKENS = 12;
const MINIMUM_AXIS_TERM_MATCHES = 2;
const MINIMUM_AXIS_TERM_MATCH_RATIO = 2 / 3;
const MAXIMUM_ANCHOR_AXIS_WINDOW_TOKENS = 24;

export const TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION = 8 as const;
export const TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY =
  "shared_anchor_bounded_provider_recall_plus_semantic_precision" as const;

export const TOPIC_DISCOVERY_CORPUS_QUALITY_FLOORS = Object.freeze({
  minimumRelevantPapers: DEFAULT_MINIMUM_RELEVANT_PAPERS,
  minimumCoveredQueryFamilies: MINIMUM_COVERED_QUERY_FAMILIES,
  minimumDirectSupportPerFamily: MINIMUM_RELEVANT_PAPERS_PER_FAMILY,
  minimumSemanticPrecisionPerFamily: MINIMUM_SEMANTIC_PRECISION_PER_FAMILY
});

export interface TopicDiscoverySearchFamily {
  queryFamily: string;
  query: string;
  source: string;
  sharedAnchorTerms?: string[];
  axisTerms?: string[];
  lens?: string;
  contributionIntent?: string;
  contractSource?: "planner_declared" | "bounded_inference";
}

export interface TopicDiscoveryCorpusQualityAudit {
  version: typeof TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION;
  term_normalization_version: typeof TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION;
  candidate_recall_semantics_version: typeof TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION;
  collect_attempt_id?: string;
  research_mode: "topic_discovery";
  strategy: typeof TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY;
  generated_at: string;
  passed: boolean;
  reasons: string[];
  thresholds: {
    minimum_shared_anchor_terms: number;
    minimum_relevant_papers: number;
    minimum_covered_query_families: number;
    minimum_relevant_papers_per_family: number;
    minimum_direct_support_per_family: number;
    minimum_semantic_precision_per_family: number;
    maximum_anchor_window_tokens: number;
    minimum_axis_term_matches: number;
    minimum_axis_term_match_ratio: number;
    maximum_anchor_axis_window_tokens: number;
  };
  observed: {
    total_papers: number;
    relevant_papers: number;
    relevant_share: number;
    lexical_relevant_papers: number;
    semantic_requested_papers: number;
    direct_support_papers: number;
    application_only_pairs: number;
    uncertain_pairs: number;
    shared_anchor_terms: string[];
    required_anchor_matches_per_paper: number;
    anchor_proximate_papers: number;
    anchor_axis_proximate_papers: number;
    covered_query_families: number;
  };
  query_families: Array<{
    query_family: string;
    query: string;
    source: string;
    positive_terms: string[];
    axis_terms: string[];
    lens: string;
    contribution_intent: string;
    contract_source: "planner_declared" | "bounded_inference";
    canonical_family_signature: string;
    required_axis_matches: number;
    lexical_relevant_paper_count: number;
    semantic_reviewed_paper_count: number;
    provider_recall_paper_count: number;
    direct_support_paper_count: number;
    qualifies_for_coverage: boolean;
    application_only_paper_count: number;
    uncertain_paper_count: number;
    semantic_precision: number;
    retained_paper_count: number;
    relevant_paper_count: number;
  }>;
  semantic_review: {
    version: number;
    status: TopicDiscoverySemanticAuditTrace["status"];
    prompt_sha256: string;
    response_sha256: string;
    reviewer_input_sha256: string;
    reviewer_input_bytes: number;
    limits: TopicDiscoverySemanticAuditTrace["limits"];
    counts: TopicDiscoverySemanticAuditTrace["counts"];
    recall: TopicDiscoverySemanticAuditTrace["recall"];
    execution: TopicDiscoverySemanticAuditTrace["execution"];
    reasons: string[];
    protocol_violations: TopicDiscoverySemanticAuditTrace["protocol_violations"];
  };
  semantic_judgments: TopicDiscoverySemanticJudgment[];
  retained_paper_ids: string[];
  excluded_paper_ids: string[];
}

export interface TopicDiscoveryCorpusQualityAssessment {
  audit: TopicDiscoveryCorpusQualityAudit;
  retainedPaperIds: Set<string>;
  anchorProximatePaperIds: Set<string>;
  matchedQueryFamiliesByPaper: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface TopicDiscoveryCorpusRelevanceProfile {
  sharedAnchorTerms: string[];
  families: Array<
    TopicDiscoverySearchFamily & {
      positiveTerms: string[];
      axisTerms: string[];
      familySignature: string;
    }
  >;
}

export interface TopicDiscoveryPaperRelevance {
  relevant: boolean;
  anchorProximate: boolean;
  anchorAxisProximate: boolean;
  matchedQueryFamilies: string[];
}

export function buildTopicDiscoveryCorpusRelevanceProfile(
  searchFamilies: TopicDiscoverySearchFamily[]
): TopicDiscoveryCorpusRelevanceProfile {
  const familiesWithPositiveTerms = deduplicateSearchFamilies(searchFamilies);
  const firstAnchor = familiesWithPositiveTerms[0]?.sharedAnchorTerms ?? [];
  const sharedAnchorTerms =
    firstAnchor.length >= MINIMUM_SHARED_ANCHOR_TERMS &&
    familiesWithPositiveTerms.every((family) => haveSameTerms(family.sharedAnchorTerms, firstAnchor))
      ? firstAnchor
      : [];
  return {
    sharedAnchorTerms,
    families: familiesWithPositiveTerms.map((family) => ({
      ...family,
      axisTerms: family.axisTerms
    }))
  };
}

export function assessTopicDiscoveryPaperRelevance(input: {
  row: StoredCorpusRow;
  profile: TopicDiscoveryCorpusRelevanceProfile;
  eligibleQueryFamilies?: ReadonlySet<string>;
}): TopicDiscoveryPaperRelevance {
  if (input.profile.sharedAnchorTerms.length < MINIMUM_SHARED_ANCHOR_TERMS) {
    return {
      relevant: false,
      anchorProximate: false,
      anchorAxisProximate: false,
      matchedQueryFamilies: []
    };
  }
  const paperTermSequence = normalizeTopicDiscoveryCandidateObjectTerms(
    `${input.row.title}\n${input.row.abstract}`
  );
  const anchorProximate = containsTermsWithinWindow(
    paperTermSequence,
    input.profile.sharedAnchorTerms,
    MAXIMUM_ANCHOR_WINDOW_TOKENS
  );
  if (!anchorProximate) {
    return {
      relevant: false,
      anchorProximate: false,
      anchorAxisProximate: false,
      matchedQueryFamilies: []
    };
  }

  let anchorAxisProximate = false;
  const matchedQueryFamilies = input.profile.families.flatMap((family) => {
    if (
      input.eligibleQueryFamilies &&
      !input.eligibleQueryFamilies.has(family.queryFamily)
    ) {
      return [];
    }
    const requiredAxisMatches = resolveRequiredAxisMatches(family.axisTerms);
    const axisMatches = family.axisTerms.filter((term) =>
      paperTermSequence.some((paperTerm) => termsMatch(paperTerm, term))
    ).length;
    if (
      family.axisTerms.length < MINIMUM_AXIS_TERM_MATCHES ||
      axisMatches < requiredAxisMatches ||
      !containsAnchorAndAxisWithinWindow(
        paperTermSequence,
        input.profile.sharedAnchorTerms,
        family.axisTerms,
        requiredAxisMatches,
        MAXIMUM_ANCHOR_AXIS_WINDOW_TOKENS
      )
    ) {
      return [];
    }
    anchorAxisProximate = true;
    return [family.queryFamily];
  });
  return {
    relevant: matchedQueryFamilies.length > 0,
    anchorProximate,
    anchorAxisProximate,
    matchedQueryFamilies
  };
}

export function assessTopicDiscoveryCorpusQuality(input: {
  rows: StoredCorpusRow[];
  searchFamilies: TopicDiscoverySearchFamily[];
  paperQueryFamilies: ReadonlyMap<string, ReadonlySet<string>>;
  semanticAudit: TopicDiscoverySemanticAuditTrace;
  globalLimit: number;
  generatedAt?: string;
}): TopicDiscoveryCorpusQualityAssessment {
  const profile = buildTopicDiscoveryCorpusRelevanceProfile(input.searchFamilies);
  const families = profile.families;
  const sharedAnchorTerms = profile.sharedAnchorTerms;
  const requiredAnchorMatches = sharedAnchorTerms.length;
  const directSupportPaperIds = new Set<string>();
  const anchorProximatePaperIds = new Set<string>();
  const lexicalMatchedFamiliesByPaper = new Map<string, Set<string>>();
  const matchedFamiliesByPaper = new Map<string, Set<string>>();
  let anchorProximatePapers = 0;
  let anchorAxisProximatePapers = 0;

  if (sharedAnchorTerms.length >= MINIMUM_SHARED_ANCHOR_TERMS) {
    for (const row of input.rows) {
      const relevance = assessTopicDiscoveryPaperRelevance({
        row,
        profile,
        eligibleQueryFamilies: input.paperQueryFamilies.get(row.paper_id) ?? new Set<string>()
      });
      if (relevance.anchorProximate) {
        anchorProximatePapers += 1;
        anchorProximatePaperIds.add(row.paper_id);
      }
      if (relevance.anchorAxisProximate) {
        anchorAxisProximatePapers += 1;
      }
      if (relevance.relevant) {
        const matchedFamilies = new Set(relevance.matchedQueryFamilies);
        lexicalMatchedFamiliesByPaper.set(row.paper_id, matchedFamilies);
      }
    }
  }

  const judgmentsByPair = new Map<string, TopicDiscoverySemanticJudgment[]>();
  for (const judgment of input.semanticAudit.judgments) {
    const key = semanticPairKey(judgment.paper_id, judgment.family_id);
    const grouped = judgmentsByPair.get(key) ?? [];
    grouped.push(judgment);
    judgmentsByPair.set(key, grouped);
  }
  const resolvedJudgments: TopicDiscoverySemanticJudgment[] = [];
  const lexicalCountsByFamily = new Map<string, number>();
  const semanticCountsByFamily = new Map<string, number>();
  const providerRecallCountsByFamily = new Map<string, number>();
  const directCountsByFamily = new Map<string, number>();
  const applicationCountsByFamily = new Map<string, number>();
  const uncertainCountsByFamily = new Map<string, number>();
  for (const familyIds of lexicalMatchedFamiliesByPaper.values()) {
    for (const familyId of familyIds) {
      incrementCount(lexicalCountsByFamily, familyId);
    }
  }
  const knownPaperIds = new Set(input.rows.map((row) => row.paper_id));
  const knownFamilyIds = new Set(families.map((family) => family.queryFamily));
  const semanticRequestedPaperIds = new Set<string>();
  const requestedPairKeys = new Set<string>();
  let invalidRequestedPairs = 0;
  for (const pair of input.semanticAudit.reviewer_input_payload.requested_pairs) {
    const paperId = pair.paper_id;
    const familyId = pair.family_id;
    const key = semanticPairKey(paperId, familyId);
    const lexicalMatch = lexicalMatchedFamiliesByPaper.get(paperId)?.has(familyId) ?? false;
    const providerMatch = input.paperQueryFamilies.get(paperId)?.has(familyId) ?? false;
    const selectionSourceValid = pair.selection_source === "lexical_match"
      ? lexicalMatch
      : pair.selection_source === "provider_provenance_floor"
        ? !lexicalMatch && providerMatch
        : false;
    const requestedPairValid =
      !requestedPairKeys.has(key)
      && knownPaperIds.has(paperId)
      && knownFamilyIds.has(familyId)
      && providerMatch
      && selectionSourceValid;
    requestedPairKeys.add(key);
    semanticRequestedPaperIds.add(paperId);
    incrementCount(semanticCountsByFamily, familyId);
    if (pair.selection_source === "provider_provenance_floor") {
      incrementCount(providerRecallCountsByFamily, familyId);
    }
    const pairJudgments = judgmentsByPair.get(key) ?? [];
    const judgment = requestedPairValid && pairJudgments.length === 1
      ? pairJudgments[0]!
      : {
          paper_id: paperId,
          family_id: familyId,
          verdict: "uncertain" as const,
          reason: !requestedPairValid
            ? "semantic_requested_pair_provenance_invalid"
            : pairJudgments.length === 0
              ? "semantic_judgment_missing_at_quality_gate"
              : "semantic_judgment_duplicate_at_quality_gate"
        };
    if (!requestedPairValid) {
      invalidRequestedPairs += 1;
    }
    resolvedJudgments.push(judgment);
    if (judgment.verdict === "direct_support") {
      incrementCount(directCountsByFamily, familyId);
      directSupportPaperIds.add(paperId);
      const directFamilies = matchedFamiliesByPaper.get(paperId) ?? new Set<string>();
      directFamilies.add(familyId);
      matchedFamiliesByPaper.set(paperId, directFamilies);
    } else if (judgment.verdict === "application_only") {
      incrementCount(applicationCountsByFamily, familyId);
    } else {
      incrementCount(uncertainCountsByFamily, familyId);
    }
  }

  const minimumRelevantPapers = DEFAULT_MINIMUM_RELEVANT_PAPERS;
  const semanticPrecisionByFamily = new Map(
    families.map((family) => {
      const semanticCount = semanticCountsByFamily.get(family.queryFamily) ?? 0;
      const directCount = directCountsByFamily.get(family.queryFamily) ?? 0;
      return [family.queryFamily, semanticCount > 0 ? directCount / semanticCount : 0] as const;
    })
  );
  const qualifyingFamilies = families.filter(
    (family) =>
      (directCountsByFamily.get(family.queryFamily) ?? 0) >=
      MINIMUM_RELEVANT_PAPERS_PER_FAMILY
      && (semanticPrecisionByFamily.get(family.queryFamily) ?? 0) >=
      MINIMUM_SEMANTIC_PRECISION_PER_FAMILY
  );
  const coveredQueryFamilies = new Set(
    qualifyingFamilies.map((family) => family.familySignature)
  ).size;
  const qualifyingFamilyIds = new Set(
    qualifyingFamilies.map((family) => family.queryFamily)
  );
  const retainedPaperIds = selectBoundedRetainedPaperIds({
    rows: input.rows,
    directSupportPaperIds,
    matchedQueryFamiliesByPaper: matchedFamiliesByPaper,
    qualifyingFamilyIds,
    restrictToQualifyingFamilies:
      coveredQueryFamilies >= MINIMUM_COVERED_QUERY_FAMILIES,
    globalLimit: input.globalLimit
  });
  const retainedCountsByFamily = new Map<string, number>();
  for (const paperId of retainedPaperIds) {
    for (const familyId of matchedFamiliesByPaper.get(paperId) ?? []) {
      incrementCount(retainedCountsByFamily, familyId);
    }
  }
  const relevantShare = input.rows.length > 0
    ? directSupportPaperIds.size / input.rows.length
    : 0;
  const reasons: string[] = [];

  if (sharedAnchorTerms.length < MINIMUM_SHARED_ANCHOR_TERMS) {
    reasons.push(
      `Only ${sharedAnchorTerms.length} shared domain anchor term(s) were found; ` +
      `${MINIMUM_SHARED_ANCHOR_TERMS} required.`
    );
  }
  if (retainedPaperIds.size < minimumRelevantPapers) {
    reasons.push(
      `Only ${retainedPaperIds.size} semantically direct-support paper(s) were retained; ` +
      `${minimumRelevantPapers} required.`
    );
  }
  if (input.semanticAudit.status === "operational_failure") {
    reasons.push(
      `Semantic review failed operationally: ${input.semanticAudit.reasons.join(", ") || "unspecified failure"}.`
    );
  } else if (input.semanticAudit.status === "partial") {
    reasons.push(
      `Semantic review was incomplete: ${input.semanticAudit.reasons.join(", ") || "not every requested pair was reviewed cleanly"}.`
    );
  }
  const expectedPairCount = input.semanticAudit.reviewer_input_payload.requested_pairs.length;
  if (
    input.semanticAudit.counts.requested_pairs !== expectedPairCount
    || resolvedJudgments.length !== expectedPairCount
  ) {
    reasons.push(
      `Semantic review pair coverage mismatch: expected ${expectedPairCount}, ` +
      `reported ${input.semanticAudit.counts.requested_pairs}.`
    );
  }
  if (invalidRequestedPairs > 0) {
    reasons.push(
      `${invalidRequestedPairs} semantic-review pair(s) were not bound to a unique paper, `
      + "declared family, provider provenance, and valid selection source."
    );
  }
  const semanticRequestedPairCount = sumCounts(semanticCountsByFamily);
  const providerRecallPairCount = sumCounts(providerRecallCountsByFamily);
  const lexicalRequestedPairCount = semanticRequestedPairCount - providerRecallPairCount;
  if (
    input.semanticAudit.recall.provider_recall_floor_per_family
      !== TOPIC_DISCOVERY_PROVIDER_RECALL_FLOOR_PER_FAMILY
    || input.semanticAudit.recall.lexical_requested_pairs
      !== lexicalRequestedPairCount
    || input.semanticAudit.recall.provider_provenance_requested_pairs
      !== providerRecallPairCount
  ) {
    reasons.push(
      "Semantic-review recall counts do not match the requested pair selection sources."
    );
  }
  for (const family of families) {
    if (!family.lens?.trim() || !family.contributionIntent?.trim()) {
      reasons.push(`Query family ${family.queryFamily} is missing its semantic lens contract.`);
    }
  }
  if (coveredQueryFamilies < MINIMUM_COVERED_QUERY_FAMILIES) {
    for (const family of families) {
      if (qualifyingFamilyIds.has(family.queryFamily)) {
        continue;
      }
      const direct = directCountsByFamily.get(family.queryFamily) ?? 0;
      const precision = semanticPrecisionByFamily.get(family.queryFamily) ?? 0;
      reasons.push(
        `Query family ${family.queryFamily} produced ${direct} direct-support paper(s) ` +
        `at semantic precision ${precision.toFixed(3)}; requires at least ` +
        `${MINIMUM_RELEVANT_PAPERS_PER_FAMILY} and ${MINIMUM_SEMANTIC_PRECISION_PER_FAMILY.toFixed(2)}.`
      );
    }
    reasons.push(
      `Only ${coveredQueryFamilies} independent query family/families met both direct-support and semantic-precision floors; ` +
      `${MINIMUM_COVERED_QUERY_FAMILIES} families required.`
    );
  }

  return {
    retainedPaperIds,
    anchorProximatePaperIds,
    matchedQueryFamiliesByPaper: matchedFamiliesByPaper,
    audit: {
      version: TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION,
      term_normalization_version: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
      candidate_recall_semantics_version: TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
      research_mode: "topic_discovery",
      strategy: TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY,
      generated_at: input.generatedAt ?? new Date().toISOString(),
      passed: reasons.length === 0,
      reasons,
      thresholds: {
        minimum_shared_anchor_terms: MINIMUM_SHARED_ANCHOR_TERMS,
        minimum_relevant_papers: minimumRelevantPapers,
        minimum_covered_query_families: MINIMUM_COVERED_QUERY_FAMILIES,
        minimum_relevant_papers_per_family: MINIMUM_RELEVANT_PAPERS_PER_FAMILY,
        minimum_direct_support_per_family: MINIMUM_RELEVANT_PAPERS_PER_FAMILY,
        minimum_semantic_precision_per_family: MINIMUM_SEMANTIC_PRECISION_PER_FAMILY,
        maximum_anchor_window_tokens: MAXIMUM_ANCHOR_WINDOW_TOKENS,
        minimum_axis_term_matches: MINIMUM_AXIS_TERM_MATCHES,
        minimum_axis_term_match_ratio: MINIMUM_AXIS_TERM_MATCH_RATIO,
        maximum_anchor_axis_window_tokens: MAXIMUM_ANCHOR_AXIS_WINDOW_TOKENS
      },
      observed: {
        total_papers: input.rows.length,
        relevant_papers: retainedPaperIds.size,
        relevant_share: relevantShare,
        lexical_relevant_papers: lexicalMatchedFamiliesByPaper.size,
        semantic_requested_papers: semanticRequestedPaperIds.size,
        direct_support_papers: directSupportPaperIds.size,
        application_only_pairs: sumCounts(applicationCountsByFamily),
        uncertain_pairs: sumCounts(uncertainCountsByFamily),
        shared_anchor_terms: sharedAnchorTerms,
        required_anchor_matches_per_paper: requiredAnchorMatches,
        anchor_proximate_papers: anchorProximatePapers,
        anchor_axis_proximate_papers: anchorAxisProximatePapers,
        covered_query_families: coveredQueryFamilies
      },
      query_families: families.map((family) => ({
        query_family: family.queryFamily,
        query: family.query,
        source: family.source,
        positive_terms: family.positiveTerms,
        axis_terms: family.axisTerms,
        lens: family.lens?.trim() || "",
        contribution_intent: family.contributionIntent?.trim() || "",
        contract_source: family.contractSource ?? "bounded_inference",
        canonical_family_signature: family.familySignature,
        required_axis_matches: resolveRequiredAxisMatches(family.axisTerms),
        lexical_relevant_paper_count: lexicalCountsByFamily.get(family.queryFamily) ?? 0,
        semantic_reviewed_paper_count: semanticCountsByFamily.get(family.queryFamily) ?? 0,
        provider_recall_paper_count: providerRecallCountsByFamily.get(family.queryFamily) ?? 0,
        direct_support_paper_count: directCountsByFamily.get(family.queryFamily) ?? 0,
        qualifies_for_coverage: qualifyingFamilyIds.has(family.queryFamily),
        application_only_paper_count: applicationCountsByFamily.get(family.queryFamily) ?? 0,
        uncertain_paper_count: uncertainCountsByFamily.get(family.queryFamily) ?? 0,
        semantic_precision: semanticPrecisionByFamily.get(family.queryFamily) ?? 0,
        retained_paper_count: retainedCountsByFamily.get(family.queryFamily) ?? 0,
        relevant_paper_count: retainedCountsByFamily.get(family.queryFamily) ?? 0
      })),
      semantic_review: {
        version: input.semanticAudit.version,
        status: input.semanticAudit.status,
        prompt_sha256: input.semanticAudit.prompt_sha256,
        response_sha256: input.semanticAudit.response_sha256,
        reviewer_input_sha256: hashSemanticReviewerInput(
          input.semanticAudit.reviewer_input_payload
        ),
        reviewer_input_bytes: input.semanticAudit.reviewer_input_bytes,
        limits: input.semanticAudit.limits,
        counts: input.semanticAudit.counts,
        recall: input.semanticAudit.recall,
        execution: input.semanticAudit.execution,
        reasons: [...input.semanticAudit.reasons],
        protocol_violations: [...input.semanticAudit.protocol_violations]
      },
      semantic_judgments: resolvedJudgments,
      retained_paper_ids: input.rows
        .map((row) => row.paper_id)
        .filter((paperId) => retainedPaperIds.has(paperId)),
      excluded_paper_ids: input.rows
        .map((row) => row.paper_id)
        .filter((paperId) => !retainedPaperIds.has(paperId))
    }
  };
}

function selectBoundedRetainedPaperIds(input: {
  rows: StoredCorpusRow[];
  directSupportPaperIds: ReadonlySet<string>;
  matchedQueryFamiliesByPaper: ReadonlyMap<string, ReadonlySet<string>>;
  qualifyingFamilyIds: ReadonlySet<string>;
  restrictToQualifyingFamilies: boolean;
  globalLimit: number;
}): Set<string> {
  const limit = Math.max(1, Math.floor(input.globalLimit));
  const orderedDirectPaperIds = input.rows
    .map((row) => row.paper_id)
    .filter((paperId) =>
      input.directSupportPaperIds.has(paperId)
      && (
        !input.restrictToQualifyingFamilies
        || [...(input.matchedQueryFamiliesByPaper.get(paperId) ?? [])].some(
          (familyId) => input.qualifyingFamilyIds.has(familyId)
        )
      )
    );
  const retained = new Set<string>();

  for (const familyId of input.qualifyingFamilyIds) {
    let familyCount = 0;
    for (const paperId of orderedDirectPaperIds) {
      if (!input.matchedQueryFamiliesByPaper.get(paperId)?.has(familyId)) {
        continue;
      }
      if (!retained.has(paperId) && retained.size >= limit) {
        break;
      }
      retained.add(paperId);
      familyCount += 1;
      if (familyCount >= MINIMUM_RELEVANT_PAPERS_PER_FAMILY) {
        break;
      }
    }
  }

  for (const paperId of orderedDirectPaperIds) {
    if (retained.size >= limit) {
      break;
    }
    retained.add(paperId);
  }
  return retained;
}

function deduplicateSearchFamilies(searchFamilies: TopicDiscoverySearchFamily[]): Array<
  TopicDiscoverySearchFamily & {
    positiveTerms: string[];
    sharedAnchorTerms: string[];
    axisTerms: string[];
    familySignature: string;
  }
> {
  const seen = new Set<string>();
  const families: Array<
    TopicDiscoverySearchFamily & {
      positiveTerms: string[];
      sharedAnchorTerms: string[];
      axisTerms: string[];
      familySignature: string;
    }
  > = [];
  for (const family of searchFamilies) {
    if (!family.queryFamily || seen.has(family.queryFamily)) {
      continue;
    }
    const parsed = parseTopicDiscoveryLiteratureQuery(family.query);
    const sharedAnchorTerms = normalizeExplicitAnchorTerms(
      family.sharedAnchorTerms ?? parsed?.sharedAnchorTerms ?? []
    );
    const anchorSet = new Set(sharedAnchorTerms);
    const declaredAxisTerms = family.axisTerms ?? parsed?.axisTerms ?? [];
    const normalizedAxisTerms = normalizeCandidateTerms(declaredAxisTerms)
      .filter((term) => !anchorSet.has(term));
    const substantiveAxisTerms = normalizedAxisTerms
      .filter(isSubstantiveTopicDiscoveryAxisTerm);
    const axisTerms = substantiveAxisTerms.length >= MINIMUM_AXIS_TERM_MATCHES
      ? substantiveAxisTerms
      : normalizedAxisTerms;
    seen.add(family.queryFamily);
    families.push({
      ...family,
      positiveTerms: extractLiteratureQueryPositiveTerms(family.query),
      sharedAnchorTerms,
      axisTerms,
      familySignature: buildTopicDiscoveryCandidateFamilySignature({
        sharedAnchorTerms,
        axisTerms
      })
    });
  }
  return families;
}

function normalizeExplicitAnchorTerms(terms: string[]): string[] {
  return [...new Set(normalizeTopicDiscoveryScientificObjectTerms(terms.join(" ")))];
}

function normalizeCandidateTerms(terms: string[]): string[] {
  return [...new Set(normalizeTopicDiscoveryCandidateTerms(terms.join(" ")))];
}

function haveSameTerms(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((term) => rightSet.has(term));
}

function containsTermsWithinWindow(
  termSequence: string[],
  requiredTerms: string[],
  maximumWindowTokens: number
): boolean {
  if (requiredTerms.length === 0 || termSequence.length === 0) {
    return false;
  }
  const required = new Set(requiredTerms);
  for (let start = 0; start < termSequence.length; start += 1) {
    const matched = new Set<string>();
    const endExclusive = Math.min(termSequence.length, start + maximumWindowTokens);
    for (let index = start; index < endExclusive; index += 1) {
      const term = termSequence[index];
      for (const requiredTerm of required) {
        if (termsMatch(term, requiredTerm)) {
          matched.add(requiredTerm);
        }
      }
      if (matched.size === required.size) {
        return true;
      }
    }
  }
  return false;
}

function resolveRequiredAxisMatches(axisTerms: string[]): number {
  return Math.max(
    MINIMUM_AXIS_TERM_MATCHES,
    Math.ceil(axisTerms.length * MINIMUM_AXIS_TERM_MATCH_RATIO)
  );
}

function containsAnchorAndAxisWithinWindow(
  termSequence: string[],
  anchorTerms: string[],
  axisTerms: string[],
  requiredAxisMatches: number,
  maximumWindowTokens: number
): boolean {
  if (
    anchorTerms.length === 0 ||
    axisTerms.length < requiredAxisMatches ||
    termSequence.length === 0
  ) {
    return false;
  }
  const anchorSet = new Set(anchorTerms);
  const axisSet = new Set(axisTerms);
  for (let start = 0; start < termSequence.length; start += 1) {
    const matchedAnchors = new Set<string>();
    const matchedAxisTerms = new Set<string>();
    const endExclusive = Math.min(termSequence.length, start + maximumWindowTokens);
    for (let index = start; index < endExclusive; index += 1) {
      const term = termSequence[index];
      for (const anchorTerm of anchorSet) {
        if (termsMatch(term, anchorTerm)) {
          matchedAnchors.add(anchorTerm);
        }
      }
      for (const axisTerm of axisSet) {
        if (termsMatch(term, axisTerm)) {
          matchedAxisTerms.add(axisTerm);
        }
      }
      if (
        matchedAnchors.size === anchorSet.size &&
        matchedAxisTerms.size >= requiredAxisMatches
      ) {
        return true;
      }
    }
  }
  return false;
}

function termsMatch(observed: string, required: string): boolean {
  if (observed === required) {
    return true;
  }
  if (!/^\p{Script=Hangul}{2,}$/u.test(required) || !observed.startsWith(required)) {
    return false;
  }
  return /^(?:의|은|는|이|가|을|를|에|에서|에게|으로|로|와|과|도|만|부터|까지)$/u.test(
    observed.slice(required.length)
  );
}

function semanticPairKey(paperId: string, familyId: string): string {
  return JSON.stringify([paperId, familyId]);
}

function incrementCount(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sumCounts(counts: ReadonlyMap<string, number>): number {
  return Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
}

function hashSemanticReviewerInput(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}
