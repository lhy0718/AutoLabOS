import type {
  PaperSearchProviderDiagnostics
} from "./types.js";
import {
  runAggregatedPaperSearch,
  type SearchProviderClient
} from "./searchAggregation.js";
import type {
  TopicDiscoveryScopeContract
} from "../topicDiscoveryScopeContract.js";
import { normalizeTopicDiscoveryScientificTerms } from "../topicDiscoveryScopeContract.js";

export const TOPIC_DISCOVERY_PRIOR_WORK_PROBE_RECEIPT_VERSION = 1 as const;
export const TOPIC_DISCOVERY_PRIOR_WORK_PROBE_RECEIPT_ARTIFACT =
  "collect_prior_work_probe_receipt.json";

const MAX_PROBES = 4;
const RESULTS_PER_PROBE = 8;
const TITLES_PER_PROBE = 4;
const MAX_HINT_TITLES = 18;
const GENERIC_PROBE_TERMS = new Set(
  normalizeTopicDiscoveryScientificTerms(
    "already check closest direct declared existing whether literature prior problem "
    + "question recent related subsume work"
  )
);

export interface TopicDiscoveryPriorWorkProbePlanEntry {
  probe_id: string;
  query: string;
  source_text_sha256: string;
  source_terms: string[];
}

export interface TopicDiscoveryPriorWorkProbeCandidate {
  paper_id: string;
  title: string;
  year?: number;
  canonical_source: string;
  search_providers: string[];
}

export interface TopicDiscoveryPriorWorkProbeAttempt {
  probe_id: string;
  query: string;
  fetched: number;
  candidates: TopicDiscoveryPriorWorkProbeCandidate[];
  provider_diagnostics: PaperSearchProviderDiagnostics[];
}

export interface TopicDiscoveryPriorWorkProbeReceipt {
  version: typeof TOPIC_DISCOVERY_PRIOR_WORK_PROBE_RECEIPT_VERSION;
  kind: "topic_discovery_prior_work_probe_receipt";
  status: "not_applicable" | "complete" | "partial" | "failed";
  evidence_status: "query_hint_only";
  paper_evidence_allowed: false;
  scope_fingerprint: string;
  as_of_date: string;
  generated_at: string;
  planned_probe_count: number;
  executed_probe_count: number;
  candidate_titles: string[];
  probes: TopicDiscoveryPriorWorkProbeAttempt[];
}

export interface TopicDiscoveryPriorWorkProbePlanningHint {
  probeId: string;
  query: string;
  candidateTitles: string[];
}

export function buildTopicDiscoveryPriorWorkProbePlan(
  contract: TopicDiscoveryScopeContract
): TopicDiscoveryPriorWorkProbePlanEntry[] {
  const unitsByHash = new Map(
    contract.units.map((unit) => [unit.sourceTextSha256, unit] as const)
  );
  const seenQueries = new Set<string>();
  const plan: TopicDiscoveryPriorWorkProbePlanEntry[] = [];
  for (const probe of contract.priorWorkProbes) {
    const substantiveTerms = probe.sourceTerms.filter(
      (term) => !GENERIC_PROBE_TERMS.has(term)
    );
    if (substantiveTerms.length < 2) {
      continue;
    }
    const sourceText = unitsByHash.get(probe.sourceTextSha256)?.sourceText ?? "";
    const query = compilePriorWorkProbeQuery(
      substantiveTerms,
      sourceText
    );
    const key = query.toLowerCase();
    if (!query || seenQueries.has(key)) {
      continue;
    }
    seenQueries.add(key);
    plan.push({
      probe_id: probe.id,
      query,
      source_text_sha256: probe.sourceTextSha256,
      source_terms: substantiveTerms
    });
    if (plan.length >= MAX_PROBES) {
      break;
    }
  }
  return plan;
}

export async function runTopicDiscoveryPriorWorkProbes(input: {
  contract: TopicDiscoveryScopeContract;
  providers: SearchProviderClient[];
  asOfDate: string;
  abortSignal?: AbortSignal;
  generatedAt?: string;
}): Promise<TopicDiscoveryPriorWorkProbeReceipt> {
  const plan = buildTopicDiscoveryPriorWorkProbePlan(input.contract);
  if (plan.length === 0) {
    return buildReceipt({
      input,
      status: "not_applicable",
      attempts: []
    });
  }

  const attempts: TopicDiscoveryPriorWorkProbeAttempt[] = [];
  for (const probe of plan) {
    if (input.abortSignal?.aborted) {
      break;
    }
    const result = await runAggregatedPaperSearch({
      request: {
        query: probe.query,
        limit: RESULTS_PER_PROBE,
        sort: { field: "relevance", order: "desc" },
        filters: {}
      },
      providers: input.providers,
      abortSignal: input.abortSignal
    });
    const candidates = result.records
      .filter((record) => isAvailableByDate(record.paper.year, input.asOfDate))
      .sort((left, right) =>
        scoreProbeCandidate(right.paper.title, right.paper.abstract, probe.source_terms)
          - scoreProbeCandidate(left.paper.title, left.paper.abstract, probe.source_terms)
        || (right.paper.citationCount ?? 0) - (left.paper.citationCount ?? 0)
        || (right.paper.year ?? 0) - (left.paper.year ?? 0)
        || left.paper.title.localeCompare(right.paper.title)
      )
      .slice(0, TITLES_PER_PROBE)
      .map((record) => ({
        paper_id: record.paper.paperId,
        title: record.paper.title,
        ...(record.paper.year ? { year: record.paper.year } : {}),
        canonical_source: record.paper.canonicalSource,
        search_providers: [...record.paper.searchProviders]
      }));
    attempts.push({
      probe_id: probe.probe_id,
      query: probe.query,
      fetched: result.records.length,
      candidates,
      provider_diagnostics: result.report.providerDiagnostics
    });
  }

  const failedProviders = attempts.flatMap((attempt) =>
    attempt.provider_diagnostics.filter((diagnostic) => Boolean(diagnostic.error))
  ).length;
  const totalProviders = attempts.reduce(
    (sum, attempt) => sum + attempt.provider_diagnostics.length,
    0
  );
  const selectedCount = attempts.reduce(
    (sum, attempt) => sum + attempt.candidates.length,
    0
  );
  const status =
    attempts.length < plan.length
      ? "partial"
      : selectedCount === 0 && totalProviders > 0 && failedProviders === totalProviders
        ? "failed"
        : failedProviders > 0
          ? "partial"
          : "complete";
  return buildReceipt({ input, status, attempts });
}

export function buildTopicDiscoveryPriorWorkProbePlanningHints(
  receipt: TopicDiscoveryPriorWorkProbeReceipt
): TopicDiscoveryPriorWorkProbePlanningHint[] {
  return receipt.probes.flatMap((probe) => {
    const candidateTitles = probe.candidates.map((candidate) => candidate.title);
    return candidateTitles.length > 0
      ? [{ probeId: probe.probe_id, query: probe.query, candidateTitles }]
      : [];
  });
}

function buildReceipt(input: {
  input: {
    contract: TopicDiscoveryScopeContract;
    asOfDate: string;
    generatedAt?: string;
  };
  status: TopicDiscoveryPriorWorkProbeReceipt["status"];
  attempts: TopicDiscoveryPriorWorkProbeAttempt[];
}): TopicDiscoveryPriorWorkProbeReceipt {
  const candidateTitles = uniqueStrings(
    input.attempts.flatMap((attempt) =>
      attempt.candidates.map((candidate) => candidate.title)
    )
  ).slice(0, MAX_HINT_TITLES);
  return {
    version: TOPIC_DISCOVERY_PRIOR_WORK_PROBE_RECEIPT_VERSION,
    kind: "topic_discovery_prior_work_probe_receipt",
    status: input.status,
    evidence_status: "query_hint_only",
    paper_evidence_allowed: false,
    scope_fingerprint: input.input.contract.scopeFingerprint,
    as_of_date: input.input.asOfDate,
    generated_at: input.input.generatedAt ?? new Date().toISOString(),
    planned_probe_count: buildTopicDiscoveryPriorWorkProbePlan(
      input.input.contract
    ).length,
    executed_probe_count: input.attempts.length,
    candidate_titles: candidateTitles,
    probes: input.attempts
  };
}

function compilePriorWorkProbeQuery(
  sourceTerms: string[],
  sourceText: string
): string {
  const sourceTermSet = new Set(sourceTerms);
  const seenNormalized = new Set<string>();
  const surfaceTerms: string[] = [];
  for (const token of sourceText.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []) {
    const normalizedMatches = normalizeTopicDiscoveryScientificTerms(token)
      .filter((term) => sourceTermSet.has(term));
    const normalized = normalizedMatches[0];
    if (!normalized || seenNormalized.has(normalized)) {
      continue;
    }
    seenNormalized.add(normalized);
    surfaceTerms.push(token.toLowerCase());
  }
  const queryTerms = surfaceTerms.length >= 2
    ? surfaceTerms
    : sourceTerms;
  return queryTerms
    .filter(Boolean)
    .slice(0, 7)
    .join(" ")
    .trim();
}

function scoreProbeCandidate(
  title: string,
  abstract: string | undefined,
  sourceTerms: string[]
): number {
  const titleTerms = new Set(normalizeTopicDiscoveryScientificTerms(title));
  const abstractTerms = new Set(
    normalizeTopicDiscoveryScientificTerms(abstract ?? "")
  );
  return sourceTerms.reduce(
    (score, term) =>
      score + (titleTerms.has(term) ? 3 : abstractTerms.has(term) ? 1 : 0),
    0
  );
}

function isAvailableByDate(year: number | undefined, asOfDate: string): boolean {
  if (!year) {
    return true;
  }
  const asOfYear = Number.parseInt(asOfDate.slice(0, 4), 10);
  return !Number.isFinite(asOfYear) || year <= asOfYear;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}
