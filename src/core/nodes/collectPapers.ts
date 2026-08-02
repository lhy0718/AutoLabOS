import { createHash } from "node:crypto";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { appendJsonl, safeRead, writeRunArtifact } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";
import {
  clearLiteratureQueryPlanRejection,
  GeneratedTopicDiscoveryPlan,
  recordLiteratureQueryPlanRejection,
  resolveGeneratedLiteratureQueries
} from "../literatureQueryGeneration.js";
import type {
  SupportedLiteratureQueryFamilyFeedback,
  TopicDiscoveryContributionIntent
} from "../literatureQueryGeneration.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import { LongTermStore } from "../memory/longTermStore.js";
import {
  SemanticScholarAttemptRecord,
  SemanticScholarPaper,
  SemanticScholarSearchFilters,
  SemanticScholarSearchDiagnostics,
  SemanticScholarSearchRequest,
  TopicDiscoverySearchFamilyIntent
} from "../../tools/semanticScholar.js";
import { BibtexMode } from "../commands/collectOptions.js";
import {
  buildLiteratureQueryFamilySignature,
  buildLiteratureQueryCandidates,
  extractResearchBriefTopic,
  extractLiteratureTermSequence,
  hasSemanticScholarSpecialSyntax,
  LiteratureQueryCandidate,
  mergeCollectConstraintDefaults,
  normalizeTopicDiscoveryLiteratureQuery,
  selectIndependentLiteratureQueryCandidates
} from "../runConstraints.js";
import { resolveConstraintProfile } from "../constraintProfile.js";
import { resolveCollectPlanningTimeoutPolicy } from "../collectPlanningPolicy.js";
import { parseResearchRunMode } from "../runs/runBriefParser.js";
import {
  loadResearchBriefSnapshot,
  resolveResearchRunModeGuard
} from "../runs/researchRunModeGuard.js";
export { buildBibtexEntry, buildBibtexFile } from "../collection/bibtex.js";
import { buildBibtexFile, scoreBibtexRichness } from "../collection/bibtex.js";
import { enrichCollectedPaper, mergeStoredCorpusRows } from "../collection/enrichment.js";
import {
  AggregatedSearchPaper,
  CollectEnrichmentLogEntry,
  PaperSearchAggregationReport,
  PaperSearchProvider,
  PaperSearchProviderDiagnostics,
  StoredCorpusRow
} from "../collection/types.js";
import {
  AggregatedSearchRecord,
  createSemanticScholarSearchProvider,
  runAggregatedPaperSearch,
  SearchProviderClient
} from "../collection/searchAggregation.js";
import { loadGovernancePolicy } from "../../governance/policyLoader.js";
import { ScreeningReport, screenEvidence } from "../../governance/evidenceIntakeFilter.js";
import { appendGovernanceTrace } from "../../governance/governanceTrace.js";
import {
  assessTopicDiscoveryPaperRelevance,
  assessTopicDiscoveryCorpusQuality,
  buildTopicDiscoveryCorpusRelevanceProfile,
  TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION,
  TopicDiscoveryCorpusRelevanceProfile,
  TopicDiscoveryCorpusQualityAudit,
  TopicDiscoverySearchFamily
} from "../collection/topicDiscoveryCorpusQuality.js";
import { assessTopicDiscoveryProviderCoverage } from "../collection/topicDiscoveryProviderCoverage.js";
import {
  runTopicDiscoverySemanticAudit,
  TopicDiscoverySemanticAuditTrace,
  type RunTopicDiscoverySemanticAuditInput
} from "../collection/topicDiscoverySemanticAudit.js";
import {
  CollectAttemptArchivePhase,
  CollectAttemptStatus,
  createCollectAttemptId,
  persistCollectAttemptArchive
} from "../collection/collectAttemptArchive.js";
import {
  TOPIC_DISCOVERY_CANDIDATE_SIDECAR_VERSION,
  TOPIC_DISCOVERY_SEMANTIC_REVIEW_INPUT_ARTIFACT_VERSION,
  TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT
} from "../collection/topicDiscoveryArtifactVersions.js";
import {
  buildCandidatePriorSearchReceipt,
  validateCandidatePriorSearchPlanIntegrity,
  type CandidatePriorSearchAttemptResult,
  type CandidatePriorSearchPlan
} from "../candidatePriorSearch.js";
import { buildTopicDiscoveryScopeContract } from "../topicDiscoveryScopeContract.js";
import {
  buildTopicDiscoveryPriorWorkProbePlanningHints,
  runTopicDiscoveryPriorWorkProbes,
  TOPIC_DISCOVERY_PRIOR_WORK_PROBE_RECEIPT_ARTIFACT,
  type TopicDiscoveryPriorWorkProbeReceipt
} from "../collection/topicDiscoveryPriorWorkProbes.js";

const ENRICHMENT_CONCURRENCY = 6;
const ENRICHMENT_PROGRESS_INTERVAL = 10;
const LOW_YIELD_QUERY_MIN_RESULTS = 3;
const TOPIC_DISCOVERY_MIN_QUERY_FAMILIES = 2;
const TOPIC_DISCOVERY_MAX_QUERY_FAMILIES = 4;
const TOPIC_DISCOVERY_SEARCH_LANES_PER_FAMILY = 2;
const TOPIC_DISCOVERY_RETRIEVAL_OVERFETCH_MULTIPLIER = 2;
const MAX_TOPIC_DISCOVERY_FEEDBACK_TITLES = 18;
const TOPIC_DISCOVERY_CANDIDATE_POOL_ARTIFACT =
  "collect_topic_discovery_candidates.jsonl";
const TOPIC_DISCOVERY_SEMANTIC_REVIEW_RECOVERY_POLICY =
  "frozen_input_single_retry_v1" as const;
const CANDIDATE_PRIOR_SEARCH_PLAN_ARTIFACT =
  "collect_candidate_prior_search_plan.json";
const CANDIDATE_PRIOR_SEARCH_RECEIPT_ARTIFACT =
  "collect_candidate_prior_search_receipt.json";

interface CollectPapersNodeRequest {
  query?: string;
  limit?: number;
  additional?: number;
  sort?: {
    field?: "relevance" | "citationCount" | "publicationDate" | "paperId";
    order?: "asc" | "desc";
  };
  filters?: {
    dateRange?: string;
    year?: string;
    lastYears?: number;
    fieldsOfStudy?: string[];
    venues?: string[];
    publicationTypes?: string[];
    minCitationCount?: number;
    openAccessPdf?: boolean;
  };
  bibtexMode?: BibtexMode;
  candidatePriorSearchPlan?: CandidatePriorSearchPlan;
}

interface TopicDiscoverySemanticReviewRecovery {
  policy: typeof TOPIC_DISCOVERY_SEMANTIC_REVIEW_RECOVERY_POLICY;
  maximum_attempts: 2;
  frozen_input_sha256: string;
  input_integrity_verified: boolean;
  recovery_performed: boolean;
  exhausted: boolean;
  exhaustion_reason?: string;
  attempts: Array<{
    attempt: number;
    status: TopicDiscoverySemanticAuditTrace["status"];
    reviewer_input_sha256: string;
    prompt_sha256: string;
    response_sha256: string;
    calls_started: number;
    reasons: string[];
  }>;
  audit: TopicDiscoverySemanticAuditTrace;
}

interface CollectResultMeta {
  collect_attempt_id?: string;
  query: string;
  limit: number;
  fetched: number;
  stored: number;
  added: number;
  baseCount: number;
  completed: boolean;
  mode: "replace" | "additional";
  source: "semantic_scholar" | "aggregated";
  providers?: PaperSearchProvider[];
  rawCandidateCount?: number;
  canonicalCount?: number;
  providerDiagnostics?: PaperSearchProviderDiagnostics[];
  fetchError?: string;
  attemptCount: number;
  lastStatus?: number;
  retryAfterMs?: number;
  attempts: SemanticScholarAttemptRecord[];
  sort: {
    field: "relevance" | "citationCount" | "publicationDate" | "paperId";
    order: "asc" | "desc";
  };
  filters: SemanticScholarSearchFilters;
  bibtexMode: BibtexMode;
  pdfRecovered: number;
  bibtexEnriched: number;
  fallbackAttempts: number;
  fallbackSources: string[];
  requestedQuery?: string;
  queryAttempts: CollectQueryAttemptMeta[];
  corpusQuality?: TopicDiscoveryCorpusQualityAudit;
  enrichment: CollectEnrichmentMeta;
  governance_warnings?: CollectGovernanceWarning[];
  timestamp: string;
}

interface CollectGovernanceWarning {
  paper_id: string;
  source: string;
  triggeredRules: string[];
  excerpt: string | null;
  recommendation: string;
}

interface CollectQueryAttemptMeta {
  query: string;
  queryFamily: string;
  retrievalLane: TopicDiscoveryRetrievalLane;
  reason: LiteratureQueryCandidate["reason"];
  source:
    | "requested_query"
    | "llm_query_planner"
    | "deterministic_query"
    | "candidate_prior_plan";
  sourceReason: string;
  filtersRelaxed: boolean;
  allocatedLimit: number;
  retrievalLimit: number;
  fetched: number;
  relevantFetched: number;
  selected: number;
  attemptCount: number;
  lastStatus?: number;
  retryAfterMs?: number;
  providerDiagnostics?: PaperSearchProviderDiagnostics[];
}

type TopicDiscoveryRetrievalLane =
  | "standard"
  | "broad_relevance"
  | "recent_direct_prior";

interface CollectEnrichmentMeta {
  blocking: false;
  status: "not_needed" | "pending" | "completed" | "failed";
  targetCount: number;
  processedCount: number;
  attemptedCount?: number;
  updatedCount?: number;
  lastError?: string;
}

interface PlannedCollectSearch {
  request: SemanticScholarSearchRequest;
  queryFamily: string;
  retrievalLane: TopicDiscoveryRetrievalLane;
  topicDiscoveryFamily?: TopicDiscoverySearchFamilyIntent;
  reason: LiteratureQueryCandidate["reason"];
  source: CollectQueryAttemptMeta["source"];
  sourceReason: string;
  filtersRelaxed: boolean;
}

interface PreparedCollectRequestPlan {
  primaryRequest?: SemanticScholarSearchRequest;
  searchPlan: PlannedCollectSearch[];
  requestedQuery?: string;
  strategy: "first_yield" | "topic_portfolio" | "candidate_prior_portfolio";
  globalLimit: number;
  suppressedFilters: Array<{
    filter: "fieldsOfStudy";
    values: string[];
    reason: "topic_discovery_cross_provider_taxonomy_mismatch";
  }>;
  candidatePriorSearchPlan?: CandidatePriorSearchPlan;
}

const activeCollectEnrichmentJobs = new Map<string, Promise<void>>();
const collectArtifactMutationQueues = new Map<string, Promise<void>>();

interface CollectRunRef {
  id: string;
  memoryRefs: {
    runContextPath: string;
  };
}

interface CollectBackgroundJobRecord {
  version: 1;
  kind: "collect_deferred_enrichment";
  status: "running" | "completed" | "failed" | "superseded";
  runId: string;
  request: SemanticScholarSearchRequest;
  mode: "replace" | "additional";
  baseCount: number;
  bibtexMode: BibtexMode;
  paperIds: string[];
  fetchedCount: number;
  diagnostics: SemanticScholarSearchDiagnostics;
  newPaperIds: string[];
  pendingSummary: string;
  requestedQuery?: string;
  queryAttempts: CollectQueryAttemptMeta[];
  scheduledAt: string;
  updatedAt: string;
  recoveryCount: number;
  lastRecoveredAt?: string;
  lastError?: string;
  collectAttemptId?: string;
  corpusFingerprint?: string;
}

const COLLECT_BACKGROUND_JOB_FILE = "collect_background_job.json";
const COLLECT_GENERATION_FILE = "collect_generation.json";

interface CollectGenerationRecord {
  version: 1;
  kind: "collect_generation";
  run_id: string;
  collect_attempt_id: string;
  started_at: string;
}

export async function waitForCollectEnrichmentJob(runId: string): Promise<void> {
  await Promise.all(
    Array.from(activeCollectEnrichmentJobs.entries())
      .filter(([key]) => key.startsWith(`${runId}:`))
      .map(([, job]) => job)
  );
}

export async function waitForAllCollectEnrichmentJobs(): Promise<void> {
  await Promise.all(Array.from(activeCollectEnrichmentJobs.values()));
}

function collectEnrichmentJobKey(runId: string, attemptId?: string): string {
  return `${runId}:${attemptId || "unscoped"}`;
}

async function withCollectArtifactMutationLock<T>(
  runId: string,
  action: () => Promise<T>
): Promise<T> {
  const previous = collectArtifactMutationQueues.get(runId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  collectArtifactMutationQueues.set(runId, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (collectArtifactMutationQueues.get(runId) === tail) {
      collectArtifactMutationQueues.delete(runId);
    }
  }
}

async function readCollectGeneration(
  run: { id: string }
): Promise<CollectGenerationRecord | undefined> {
  const raw = await safeRead(`.autolabos/runs/${run.id}/${COLLECT_GENERATION_FILE}`);
  if (!raw.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CollectGenerationRecord>;
    return parsed.version === 1
      && parsed.kind === "collect_generation"
      && parsed.run_id === run.id
      && typeof parsed.collect_attempt_id === "string"
      ? parsed as CollectGenerationRecord
      : undefined;
  } catch {
    return undefined;
  }
}

async function beginCollectGeneration(
  run: CollectRunRef,
  attemptId: string,
  runContextMemory: RunContextMemory,
  isolateTopicDiscoveryCorpus = false
): Promise<void> {
  await withCollectArtifactMutationLock(run.id, async () => {
    const record: CollectGenerationRecord = {
      version: 1,
      kind: "collect_generation",
      run_id: run.id,
      collect_attempt_id: attemptId,
      started_at: new Date().toISOString()
    };
    await writeRunArtifact(run as any, COLLECT_GENERATION_FILE, `${JSON.stringify(record, null, 2)}\n`);
    if (isolateTopicDiscoveryCorpus) {
      await writeRunArtifact(run as any, "corpus.jsonl", "");
      await writeRunArtifact(run as any, "bibtex.bib", "");
      await writeRunArtifact(run as any, "collect_corpus_quality.json", "");
      await writeRunArtifact(run as any, "collect_semantic_review_input.json", "");
      await writeRunArtifact(run as any, "collect_semantic_review.json", "");
      await writeRunArtifact(run as any, "collect_query_reformulation_hints.json", "");
      await writeRunArtifact(run as any, TOPIC_DISCOVERY_CANDIDATE_POOL_ARTIFACT, "");
      await writeRunArtifact(
        run as any,
        TOPIC_DISCOVERY_PRIOR_WORK_PROBE_RECEIPT_ARTIFACT,
        ""
      );
    }
    await runContextMemory.put("collect_papers.current_generation_id", attemptId);
    await runContextMemory.put("collect_papers.active_attempt_id", attemptId);
  });
}

async function publishForCollectGeneration<T>(input: {
  run: { id: string };
  attemptId?: string;
  action: () => Promise<T>;
}): Promise<{ published: boolean; value?: T }> {
  return withCollectArtifactMutationLock(input.run.id, async () => {
    const generation = await readCollectGeneration(input.run);
    const current = input.attemptId
      ? generation?.collect_attempt_id === input.attemptId
      : generation === undefined;
    if (!current) {
      return { published: false };
    }
    return { published: true, value: await input.action() };
  });
}

export function createCollectPapersNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "collect_papers",
    async execute({ run, abortSignal }) {
      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      const memoryRawBrief = await runContextMemory.get<string>("run_brief.raw");
      const snapshotBrief = await loadResearchBriefSnapshot(process.cwd(), run.id);
      const researchModeGuard = await resolveResearchRunModeGuard({
        workspaceRoot: process.cwd(),
        runId: run.id,
        rawBrief: memoryRawBrief,
        run
      });
      const rawBrief = memoryRawBrief || snapshotBrief;
      await runContextMemory.put("research_governance.mode_guard", researchModeGuard);
      await writeRunArtifact(
        run,
        "governance/research_mode_guard.json",
        `${JSON.stringify(researchModeGuard, null, 2)}\n`
      );
      if (!researchModeGuard.valid) {
        const error =
          "collect_papers blocked because the persisted research mode and evidence lineage do not agree: "
          + researchModeGuard.reasons.join(", ");
        return {
          status: "failure",
          error,
          summary: error,
          toolCallsUsed: 0
        };
      }
      const longTermStore = new LongTermStore(run.memoryRefs.longTermPath);
      const planningTimeoutPolicy = resolveCollectPlanningTimeoutPolicy(deps.config);
      deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: "collect_papers",
        payload: {
          text:
            `Collect planning timeout policy: llm_mode=${planningTimeoutPolicy.llm_mode}, `
            + `constraint_profile=${planningTimeoutPolicy.constraint_profile_timeout_ms}ms `
            + `(${planningTimeoutPolicy.constraint_profile_source}), `
            + `literature_query=${planningTimeoutPolicy.literature_query_timeout_ms}ms `
            + `(${planningTimeoutPolicy.literature_query_source}).`
        }
      });
      const constraintProfile = await resolveConstraintProfile({
        run,
        runContextMemory,
        llm: deps.llm,
        eventStream: deps.eventStream,
        node: "collect_papers",
        abortSignal,
        timeoutMs: planningTimeoutPolicy.constraint_profile_timeout_ms
      });
      const requestFromContext = await runContextMemory.get<CollectPapersNodeRequest>("collect_papers.request");
      const researchMode = parseResearchRunMode(rawBrief || "");
      const mode: "replace" | "additional" =
        typeof requestFromContext?.additional === "number" && requestFromContext.additional > 0
          ? "additional"
          : "replace";
      const candidatePriorSearchPlan = requestFromContext?.candidatePriorSearchPlan;
      if (candidatePriorSearchPlan) {
        const planValidation = validateCandidatePriorSearchPlanIntegrity(
          candidatePriorSearchPlan
        );
        const sourceGeneration = await readCollectGeneration(run);
        const sourceCorpusRaw = await safeRead(
          `.autolabos/runs/${run.id}/corpus.jsonl`
        );
        const sourceCorpusSha256 = createHash("sha256")
          .update(sourceCorpusRaw, "utf8")
          .digest("hex");
        const preflightReasons = [
          ...planValidation.reasons,
          ...(researchMode === "topic_discovery"
            ? []
            : ["candidate_prior_search_requires_topic_discovery"]),
          ...(mode === "additional"
            ? []
            : ["candidate_prior_search_requires_additional_mode"]),
          ...(requestFromContext?.query
            || requestFromContext?.sort
            || requestFromContext?.filters
            ? ["candidate_prior_search_request_override_forbidden"]
            : []),
          ...(candidatePriorSearchPlan.run_id === run.id
            ? []
            : ["candidate_prior_search_run_mismatch"]),
          ...(candidatePriorSearchPlan.research_cycle + 1
              === run.graph.researchCycle
            ? []
            : ["candidate_prior_search_cycle_mismatch"]),
          ...(sourceGeneration?.collect_attempt_id
              === candidatePriorSearchPlan.source_corpus.collect_attempt_id
            ? []
            : ["candidate_prior_search_source_attempt_mismatch"]),
          ...(candidatePriorSearchPlan.source_corpus.sha256
              === sourceCorpusSha256
            && candidatePriorSearchPlan.source_corpus.byte_length
              === Buffer.byteLength(sourceCorpusRaw, "utf8")
            ? []
            : ["candidate_prior_search_source_corpus_mismatch"])
        ];
        if (preflightReasons.length > 0) {
          const message =
            "Candidate-conditioned prior collection was blocked before retrieval: "
            + [...new Set(preflightReasons)].join(", ")
            + ".";
          await runContextMemory.put("collect_papers.last_error", message);
          return {
            status: "failure",
            failureKind: "gate_blocked",
            error: message,
            summary: message,
            toolCallsUsed: 0
          };
        }
      }
      const collectAttemptId = createCollectAttemptId();
      await beginCollectGeneration(
        run,
        collectAttemptId,
        runContextMemory,
        researchMode === "topic_discovery" && mode === "replace"
      );
      const searchProviders = buildSearchProviders(deps);
      let priorWorkProbeReceipt: TopicDiscoveryPriorWorkProbeReceipt | undefined;
      if (
        researchMode === "topic_discovery"
        && !requestFromContext?.query
        && !candidatePriorSearchPlan
      ) {
        priorWorkProbeReceipt = await runTopicDiscoveryPriorWorkProbes({
          contract: buildTopicDiscoveryScopeContract(rawBrief),
          providers: searchProviders,
          asOfDate: run.createdAt.slice(0, 10),
          abortSignal
        });
        const receiptContent =
          `${JSON.stringify(priorWorkProbeReceipt, null, 2)}\n`;
        await publishForCollectGeneration({
          run,
          attemptId: collectAttemptId,
          action: async () => writeRunArtifact(
            run,
            TOPIC_DISCOVERY_PRIOR_WORK_PROBE_RECEIPT_ARTIFACT,
            receiptContent
          )
        });
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "collect_papers",
          payload: {
            text:
              `Prior-work probe lane ${priorWorkProbeReceipt.status}: `
              + `${priorWorkProbeReceipt.executed_probe_count}/`
              + `${priorWorkProbeReceipt.planned_probe_count} probes executed; `
              + `${priorWorkProbeReceipt.candidate_titles.length} title hints retained as non-evidence.`
          }
        });
      }
      const extractedBrief = await runContextMemory.get<{ topic?: string }>("run_brief.extracted");
      const generatedQueries =
        requestFromContext?.query || candidatePriorSearchPlan
          ? undefined
          : await resolveGeneratedLiteratureQueries({
              run,
              rawBrief,
              extractedBriefTopic: extractedBrief?.topic,
              runContextMemory,
              llm: deps.llm,
              eventStream: deps.eventStream,
              node: "collect_papers",
              abortSignal,
              timeoutMs: planningTimeoutPolicy.literature_query_timeout_ms,
              plannerIdentity: resolveResearchLlmIdentity(deps.config),
              priorWorkProbeHints: priorWorkProbeReceipt
                ? buildTopicDiscoveryPriorWorkProbePlanningHints(
                    priorWorkProbeReceipt
                  )
                : []
            });
      const normalizedRequest = normalizeCollectRequest({
        request: requestFromContext,
        topic: run.topic,
        rawBrief,
        extractedBriefTopic: extractedBrief?.topic,
        llmGeneratedQueries: generatedQueries?.queries,
        llmTopicDiscoveryPlan: generatedQueries?.topicDiscoveryPlan,
        llmPlanningFailure: generatedQueries?.failureReason,
        constraintProfile,
        configuredLimit: deps.config.papers.max_results,
        asOfDate: run.createdAt
      });
      const collectQueryPlanArtifact = {
            ...TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT,
            collect_attempt_id: collectAttemptId,
            research_mode: researchMode,
            strategy: normalizedRequest.strategy,
            planning_timeout_policy: planningTimeoutPolicy,
            planner: generatedQueries
              ? {
                  source: generatedQueries.source,
                  queries: generatedQueries.queries,
                  assumptions: generatedQueries.assumptions,
                  failure_reason: generatedQueries.failureReason,
                  topic_discovery_plan: generatedQueries.topicDiscoveryPlan,
                  attempt_diagnostics: generatedQueries.attemptDiagnostics,
                  repair_diagnostic: generatedQueries.repairDiagnostic,
                  scientific_scope_contract:
                    generatedQueries.scientificScopeContract,
                  scientific_scope_diagnostic:
                    generatedQueries.scientificScopeDiagnostic
                }
              : candidatePriorSearchPlan
                ? {
                    source: "candidate_prior_plan",
                    queries: candidatePriorSearchPlan.candidates.flatMap(
                      (candidate) => candidate.families.map((family) => family.query)
                    ),
                    assumptions: [],
                    candidate_prior_search_plan_sha256:
                      candidatePriorSearchPlan.content_sha256
                  }
                : {
                  source: requestFromContext?.query ? "requested_query" : "unavailable",
                  queries: requestFromContext?.query ? [requestFromContext.query] : [],
                  assumptions: []
                },
            candidate_prior_search_plan: candidatePriorSearchPlan,
            prior_work_probe_receipt: priorWorkProbeReceipt
              ? {
                  artifact: TOPIC_DISCOVERY_PRIOR_WORK_PROBE_RECEIPT_ARTIFACT,
                  status: priorWorkProbeReceipt.status,
                  scope_fingerprint: priorWorkProbeReceipt.scope_fingerprint,
                  evidence_status: priorWorkProbeReceipt.evidence_status,
                  paper_evidence_allowed:
                    priorWorkProbeReceipt.paper_evidence_allowed,
                  planned_probe_count:
                    priorWorkProbeReceipt.planned_probe_count,
                  executed_probe_count:
                    priorWorkProbeReceipt.executed_probe_count,
                  candidate_titles: priorWorkProbeReceipt.candidate_titles
                }
              : undefined,
            selected_families: normalizedRequest.searchPlan.map((search) => ({
              query: search.request.query,
              query_family: search.queryFamily,
              retrieval_lane: search.retrievalLane,
              source: search.source,
              source_reason: search.sourceReason,
              reason: search.reason,
              retrieval_intent: search.request.retrievalIntent ?? "default",
              sort: search.request.sort,
              filters: search.request.filters,
              topic_discovery_family: search.topicDiscoveryFamily
            })),
            filter_policy: {
              applied: normalizedRequest.primaryRequest?.filters ?? {},
              suppressed: normalizedRequest.suppressedFilters
            }
          };
      const collectQueryPlanContent = `${JSON.stringify(collectQueryPlanArtifact, null, 2)}\n`;
      const collectAttemptArtifactContents: Record<string, string> = {
        "collect_query_plan.json": collectQueryPlanContent,
        ...(priorWorkProbeReceipt
          ? {
              [TOPIC_DISCOVERY_PRIOR_WORK_PROBE_RECEIPT_ARTIFACT]:
                `${JSON.stringify(priorWorkProbeReceipt, null, 2)}\n`
            }
          : {}),
        ...(candidatePriorSearchPlan
          ? {
              [CANDIDATE_PRIOR_SEARCH_PLAN_ARTIFACT]:
                `${JSON.stringify(candidatePriorSearchPlan, null, 2)}\n`
            }
          : {})
      };
      const queryPlanPublication = await publishForCollectGeneration({
        run,
        attemptId: collectAttemptId,
        action: async () => {
          await writeRunArtifact(
            run,
            "collect_query_plan.json",
            collectQueryPlanContent
          );
          if (candidatePriorSearchPlan) {
            await writeRunArtifact(
              run,
              CANDIDATE_PRIOR_SEARCH_PLAN_ARTIFACT,
              `${JSON.stringify(candidatePriorSearchPlan, null, 2)}\n`
            );
          }
        }
      });
      if (!queryPlanPublication.published) {
        const message = `collect_papers attempt ${collectAttemptId} was superseded before its query plan could be published.`;
        return {
          status: "failure",
          error: message,
          summary: message,
          toolCallsUsed: 0
        };
      }
      await archiveCurrentCollectAttempt({
        run,
        attemptId: collectAttemptId,
        status: "planned",
        phase: "planning",
        includeTopicDiscoveryArtifacts: false,
        includeCandidatePriorArtifacts: Boolean(candidatePriorSearchPlan),
        artifactContents: {
          "collect_query_plan.json": collectQueryPlanContent,
          ...(candidatePriorSearchPlan
            ? {
                [CANDIDATE_PRIOR_SEARCH_PLAN_ARTIFACT]:
                  `${JSON.stringify(candidatePriorSearchPlan, null, 2)}\n`
              }
            : {})
        }
      });
      if (!normalizedRequest.primaryRequest || normalizedRequest.searchPlan.length === 0) {
        const queryPlanningFailure = buildCollectQueryPlanningFailureMessage(
          requestFromContext?.query,
          generatedQueries?.failureReason
        );
        if (
          !requestFromContext?.query &&
          researchMode === "topic_discovery" &&
          generatedQueries?.failureReason
        ) {
          const finalAttempt = generatedQueries.attemptDiagnostics?.at(-1);
          const planningFailureReason = generatedQueries.failureReason;
          await publishForCollectGeneration({
            run,
            attemptId: collectAttemptId,
            action: async () => recordLiteratureQueryPlanRejection(runContextMemory, {
              rejectedQueries: finalAttempt?.usableQueries ?? generatedQueries.queries,
              qualityReasons: [planningFailureReason],
              sharedAnchorTerms: finalAttempt?.sharedAnchorTerms ?? [],
              candidateTitles: [],
              scientificScopeFingerprint:
                generatedQueries.scientificScopeContract?.scopeFingerprint,
              queryFamilies: (finalAttempt?.families ?? []).map((family) => ({
                query: family.query ?? family.axisTerms.join(" "),
                axisTerms: family.axisTerms
              }))
            })
          });
        }
        await persistPlanningFailureSnapshot({
          run,
          attemptId: collectAttemptId,
          researchMode,
          error: queryPlanningFailure
        });
        await publishForCollectGeneration({
          run,
          attemptId: collectAttemptId,
          action: async () => {
            await runContextMemory.put("collect_papers.last_request", null);
            await runContextMemory.put("collect_papers.last_result", null);
            await runContextMemory.put("collect_papers.last_attempt_count", 0);
            await runContextMemory.put("collect_papers.count", 0);
            await runContextMemory.put("collect_papers.source", "semantic_scholar");
            await runContextMemory.put("collect_papers.last_error", queryPlanningFailure);
            await runContextMemory.put("collect_papers.enrichment_last_error", null);
            await runContextMemory.put("collect_papers.last_attempt_id", collectAttemptId);
            await runContextMemory.put("collect_papers.active_attempt_id", null);
          }
        });
        return {
          status: "failure",
          error: queryPlanningFailure,
          summary: queryPlanningFailure,
          toolCallsUsed: 0
        };
      }
      if (normalizedRequest.strategy === "topic_portfolio" && mode === "additional") {
        const message =
          "Topic-discovery collection requires a full replace-and-reaudit pass; additional collection cannot preserve family provenance for the combined corpus.";
        await persistPlanningFailureSnapshot({
          run,
          attemptId: collectAttemptId,
          researchMode,
          error: message
        });
        await publishForCollectGeneration({
          run,
          attemptId: collectAttemptId,
          action: async () => {
            await runContextMemory.put("collect_papers.last_request", null);
            await runContextMemory.put("collect_papers.last_result", null);
            await runContextMemory.put("collect_papers.last_attempt_count", 0);
            await runContextMemory.put("collect_papers.count", 0);
            await runContextMemory.put("collect_papers.last_error", message);
            await runContextMemory.put("collect_papers.last_attempt_id", collectAttemptId);
            await runContextMemory.put("collect_papers.active_attempt_id", null);
          }
        });
        return {
          status: "failure",
          error: message,
          summary: message,
          toolCallsUsed: 0
        };
      }
      const additionalLimit =
        mode === "additional" && typeof requestFromContext?.additional === "number" && requestFromContext.additional > 0
          ? Math.floor(requestFromContext.additional)
          : undefined;
      const existingCorpus = mode === "additional" ? await readExistingCorpus(run) : [];
      const existingEnrichmentLogs = mode === "additional" ? await readExistingEnrichmentLogs(run) : [];
      const storedRows = new Map<string, StoredCorpusRow>(
        existingCorpus.map((row) => [row.paper_id, row])
      );
      const fetchedPapers = new Map<string, AggregatedSearchPaper>();
      const newPaperIds = new Set<string>();
      const baseCount = storedRows.size;
      let storedCount = storedRows.size;
      let pdfRecovered = 0;
      let bibtexEnriched = 0;
      const fallbackSources = new Set<string>();
      const currentEnrichmentLogs = new Map<string, CollectEnrichmentLogEntry>();
      const persistedEnrichmentLogs = new Map<string, CollectEnrichmentLogEntry>(
        existingEnrichmentLogs.map((entry) => [entry.paper_id, entry])
      );
      const governancePolicy = loadGovernancePolicy();
      const governanceWarnings: CollectGovernanceWarning[] = [];
      let diagnostics: SemanticScholarSearchDiagnostics = emptyCollectDiagnostics();
      let aggregationReport: PaperSearchAggregationReport | undefined;
      const queryAttempts: CollectQueryAttemptMeta[] = [];
      const paperQueryFamilies = new Map<string, Set<string>>();
      const candidatePriorAttemptPaperIds = new Map<string, Set<string>>();
      const topicDiscoveryCandidatePaperIdsByFamily = new Map<string, string[]>();
      const topicDiscoveryCandidateRows = new Map<string, StoredCorpusRow>();
      const topicDiscoveryCandidatePapers = new Map<string, AggregatedSearchPaper>();
      const topicDiscoveryLexicalRows = new Map<string, StoredCorpusRow>();
      const topicDiscoveryRelevanceProfile = buildTopicDiscoveryRelevanceProfile(
        normalizedRequest
      );
      let effectiveRequest = normalizedRequest.primaryRequest;
      await syncCollectRunContext({
        run,
        runContextMemory,
        request: effectiveRequest,
        resultMeta: buildCollectResultMeta({
          collectAttemptId,
          request: effectiveRequest,
          fetched: 0,
          stored: storedCount,
          added: newPaperIds.size,
          baseCount,
          mode,
          diagnostics,
          filters: effectiveRequest.filters || {},
          bibtexMode: normalizeBibtexMode(requestFromContext?.bibtexMode),
          completed: false,
          pdfRecovered,
          bibtexEnriched,
          aggregationReport,
          enrichmentAttempts: 0,
          fallbackSources: [],
          requestedQuery: normalizedRequest.requestedQuery,
          queryAttempts,
          enrichment: {
            blocking: false,
            status: "not_needed",
            targetCount: 0,
            processedCount: 0,
            attemptedCount: 0,
            updatedCount: 0
          },
          governanceWarnings
        }),
        diagnostics
      });

      let fetchError: string | undefined;
      for (let searchIndex = 0; searchIndex < normalizedRequest.searchPlan.length; searchIndex += 1) {
        const plannedSearch = normalizedRequest.searchPlan[searchIndex];
        effectiveRequest = plannedSearch.request;
        let searchDiagnostics = emptyCollectDiagnostics();
        let searchFetched = 0;
        let currentAggregation: PaperSearchAggregationReport | undefined;
        const remainingPortfolioQueries = normalizedRequest.searchPlan.length - searchIndex;
        const remainingCapacity = Math.max(0, normalizedRequest.globalLimit - newPaperIds.size);
        const newPaperLimitForSearch =
          isMultiQueryPortfolioStrategy(normalizedRequest.strategy)
            ? Math.max(1, Math.ceil(remainingCapacity / Math.max(1, remainingPortfolioQueries)))
            : remainingCapacity;
        const retrievalLimit =
          isMultiQueryPortfolioStrategy(normalizedRequest.strategy)
            ? resolveTopicDiscoveryRetrievalLimit(
                newPaperLimitForSearch,
                normalizedRequest.globalLimit
              )
            : effectiveRequest.limit;
        const providerRequest =
          isMultiQueryPortfolioStrategy(normalizedRequest.strategy)
            ? { ...effectiveRequest, limit: retrievalLimit }
            : effectiveRequest;
        let newPapersStoredThisSearch = 0;
        let relevantFetched = 0;
        const selectedPaperIdsThisSearch = new Set<string>();

        try {
          const providerLabel = formatProviderList(searchProviders.map((provider) => provider.provider));
          const semanticScholarOnly = isSemanticScholarOnlyProviders(searchProviders);
          deps.eventStream.emit({
            type: "OBS_RECEIVED",
            runId: run.id,
            node: "collect_papers",
            payload: {
              text:
                searchIndex === 0
                  ? `Searching ${providerLabel} for "${effectiveRequest.query}" (${plannedSearch.reason}; ${plannedSearch.source}).`
                  : normalizedRequest.strategy === "topic_portfolio"
                    ? `Expanding the topic-discovery portfolio with "${effectiveRequest.query}" across ${providerLabel}.`
                    : normalizedRequest.strategy === "candidate_prior_portfolio"
                      ? `Searching a candidate-bound direct-prior lane for "${effectiveRequest.query}" across ${providerLabel}.`
                    : `No papers found yet; retrying with broader query "${effectiveRequest.query}" across ${providerLabel}${plannedSearch.filtersRelaxed ? " and relaxed filters" : ""}.`
            }
          });
          if (semanticScholarOnly) {
            deps.eventStream.emit({
              type: "OBS_RECEIVED",
              runId: run.id,
              node: "collect_papers",
              payload: {
                text: "Requesting Semantic Scholar batch 1/1."
              }
            });
          }
          const aggregated = await runAggregatedPaperSearch({
            request: providerRequest,
            providers: searchProviders,
            abortSignal
          });
          currentAggregation = aggregated.report;
          aggregationReport = mergePaperSearchAggregationReports(
            aggregationReport,
            aggregated.report
          );
          searchDiagnostics = deps.semanticScholar.getLastSearchDiagnostics?.() ?? searchDiagnostics;
          diagnostics = mergeCollectDiagnostics(diagnostics, searchDiagnostics);
          searchFetched = aggregated.records.length;

          let changed = false;
          for (const record of aggregated.records) {
            const screening = screenCollectedPaper(record, governancePolicy);
            if (screening.result === "blocked") {
              appendGovernanceTrace({
                timestamp: new Date().toISOString(),
                runId: run.id,
                node: "collect_papers",
                inputSummary: screeningInputSummary(record),
                screeningResult: screening.result,
                triggeredRules: screening.triggeredRules,
                decision: "hard_stop",
                matchedSlotId: "evidence_intake",
                detail: screening.recommendation
              });
              deps.eventStream.emit({
                type: "OBS_RECEIVED",
                runId: run.id,
                node: "collect_papers",
                payload: {
                  text: `Governance blocked collected paper "${record.paper.title}" and excluded it from the corpus.`
                }
              });
              continue;
            }
            if (screening.result === "suspicious_but_usable") {
              governanceWarnings.push({
                paper_id: record.paper.paperId,
                source: resolveGovernanceSource(record),
                triggeredRules: screening.triggeredRules,
                excerpt: screening.excerpt,
                recommendation: screening.recommendation
              });
              appendGovernanceTrace({
                timestamp: new Date().toISOString(),
                runId: run.id,
                node: "collect_papers",
                inputSummary: screeningInputSummary(record),
                screeningResult: screening.result,
                triggeredRules: screening.triggeredRules,
                decision: "allow_with_trace",
                matchedSlotId: "evidence_intake",
                detail: screening.recommendation
              });
            }
            let effectiveRecord = record;
            if (topicDiscoveryRelevanceProfile) {
              effectiveRecord = rememberTopicDiscoveryCandidate({
                rows: topicDiscoveryCandidateRows,
                papers: topicDiscoveryCandidatePapers,
                paperQueryFamilies,
                paperIdsByFamily: topicDiscoveryCandidatePaperIdsByFamily,
                row: record.row,
                paper: record.paper,
                queryFamily: plannedSearch.queryFamily
              });
              const relevance = assessTopicDiscoveryPaperRelevance({
                row: effectiveRecord.row,
                profile: topicDiscoveryRelevanceProfile,
                eligibleQueryFamilies: new Set([plannedSearch.queryFamily])
              });
              if (!relevance.relevant) {
                continue;
              }
              relevantFetched += 1;
              topicDiscoveryLexicalRows.set(
                effectiveRecord.row.paper_id,
                effectiveRecord.row
              );
            } else {
              relevantFetched += 1;
            }
            const currentRow = storedRows.get(effectiveRecord.paper.paperId);
            if (!currentRow && additionalLimit !== undefined && newPaperIds.size >= additionalLimit) {
              continue;
            }
            if (
              !currentRow &&
              isMultiQueryPortfolioStrategy(normalizedRequest.strategy) &&
              newPapersStoredThisSearch >= newPaperLimitForSearch
            ) {
              continue;
            }
            if (
              !currentRow &&
              mode === "replace" &&
              newPaperIds.size >= normalizedRequest.globalLimit
            ) {
              continue;
            }
            fetchedPapers.set(effectiveRecord.paper.paperId, effectiveRecord.paper);
            const incomingRow =
              normalizedRequest.strategy === "candidate_prior_portfolio"
                ? {
                    ...effectiveRecord.row,
                    query_families: [
                      ...(effectiveRecord.row.query_families ?? []),
                      plannedSearch.queryFamily
                    ]
                  }
                : effectiveRecord.row;
            const mergedRow =
              normalizedRequest.strategy === "candidate_prior_portfolio"
                && currentRow
                ? {
                    ...currentRow,
                    query_families: Array.from(new Set([
                      ...(currentRow.query_families ?? []),
                      plannedSearch.queryFamily
                    ])).sort()
                  }
                : mergeStoredCorpusRows(currentRow, incomingRow);
            const prevSerialized = currentRow ? JSON.stringify(currentRow) : undefined;
            const nextSerialized = JSON.stringify(mergedRow);
            if (!currentRow) {
              newPaperIds.add(effectiveRecord.paper.paperId);
              newPapersStoredThisSearch += 1;
              changed = true;
            } else if (prevSerialized !== nextSerialized) {
              changed = true;
            }
            storedRows.set(effectiveRecord.paper.paperId, mergedRow);
            selectedPaperIdsThisSearch.add(effectiveRecord.paper.paperId);
          }

          if (normalizedRequest.strategy === "candidate_prior_portfolio") {
            candidatePriorAttemptPaperIds.set(
              `${plannedSearch.queryFamily}::${plannedSearch.retrievalLane}`,
              selectedPaperIdsThisSearch
            );
          }

          for (const providerDiagnostic of aggregated.report.providerDiagnostics) {
            deps.eventStream.emit({
              type: "OBS_RECEIVED",
              runId: run.id,
              node: "collect_papers",
              payload: {
                text: providerDiagnostic.error
                  ? `${formatProviderName(providerDiagnostic.provider)} returned no usable results (${providerDiagnostic.error}).`
                  : `${formatProviderName(providerDiagnostic.provider)} returned ${providerDiagnostic.fetched} candidate(s).`
              }
            });
          }

          if (changed) {
            storedCount = storedRows.size;
            await persistCollectSnapshot({
              run,
              rows: Array.from(storedRows.values()),
              mode,
              request: effectiveRequest,
              resultMeta: buildCollectResultMeta({
                collectAttemptId,
                request: effectiveRequest,
                fetched: fetchedPapers.size,
                stored: storedCount,
                added: newPaperIds.size,
                baseCount,
                mode,
                diagnostics,
                filters: effectiveRequest.filters || {},
                bibtexMode: normalizeBibtexMode(requestFromContext?.bibtexMode),
                completed: false,
                pdfRecovered,
                bibtexEnriched,
                aggregationReport,
                enrichmentAttempts: countEnrichmentAttempts(currentEnrichmentLogs),
                fallbackSources: Array.from(fallbackSources),
                requestedQuery: normalizedRequest.requestedQuery,
                queryAttempts,
                governanceWarnings,
                enrichment: {
                  blocking: false,
                  status: "not_needed",
                  targetCount: 0,
                  processedCount: 0,
                  attemptedCount: 0,
                  updatedCount: 0
                }
              }),
              enrichmentLogs: Array.from(persistedEnrichmentLogs.values()),
              bibtexMode: normalizeBibtexMode(requestFromContext?.bibtexMode),
              aggregationReport,
              writeCorpusArtifacts: normalizedRequest.strategy !== "topic_portfolio"
            });
            deps.eventStream.emit({
              type: "OBS_RECEIVED",
              runId: run.id,
              node: "collect_papers",
              payload: {
                text:
                  currentAggregation?.source === "aggregated"
                    ? `Aggregated search stored ${storedCount} paper(s) so far (${newPaperIds.size} new) from ${currentAggregation.rawCandidateCount} candidate(s).`
                    : `Collected ${storedCount} paper(s) so far (${newPaperIds.size} new) for "${effectiveRequest.query}".`
              }
            });
          }

          deps.eventStream.emit({
            type: "OBS_RECEIVED",
            runId: run.id,
            node: "collect_papers",
            payload: {
              text:
                currentAggregation?.source === "aggregated"
                  ? `Canonicalized ${currentAggregation.canonicalCount} paper(s) from ${currentAggregation.rawCandidateCount} cross-provider candidate(s).`
                  : `Fetched ${searchFetched} paper(s) from Semantic Scholar.`
            }
          });
          if (normalizedRequest.strategy === "topic_portfolio") {
            deps.eventStream.emit({
              type: "OBS_RECEIVED",
              runId: run.id,
              node: "collect_papers",
              payload: {
                text:
                  `Topic-discovery relevance screening accepted ${relevantFetched} of ` +
                  `${searchFetched} canonical candidate(s); selected ${newPapersStoredThisSearch} ` +
                  `new paper(s) for this family.`
              }
            });
          }
          if (semanticScholarOnly) {
            deps.eventStream.emit({
              type: "OBS_RECEIVED",
              runId: run.id,
              node: "collect_papers",
              payload: {
                text: `Fetched Semantic Scholar batch 1/1 (${searchFetched} paper(s)).`
              }
            });
          }

          queryAttempts.push({
            query: effectiveRequest.query,
            queryFamily: plannedSearch.queryFamily,
            retrievalLane: plannedSearch.retrievalLane,
            reason: plannedSearch.reason,
            source: plannedSearch.source,
            sourceReason: plannedSearch.sourceReason,
            filtersRelaxed: plannedSearch.filtersRelaxed,
            allocatedLimit: newPaperLimitForSearch,
            retrievalLimit: providerRequest.limit,
            fetched: searchFetched,
            relevantFetched,
            selected:
              normalizedRequest.strategy === "candidate_prior_portfolio"
                ? selectedPaperIdsThisSearch.size
                : newPapersStoredThisSearch,
            attemptCount: searchDiagnostics.attemptCount,
            lastStatus: searchDiagnostics.lastStatus,
            retryAfterMs: searchDiagnostics.retryAfterMs,
            providerDiagnostics: currentAggregation?.providerDiagnostics
          });

          const providerFailure = buildProviderFailureMessage(effectiveRequest.query, currentAggregation?.providerDiagnostics || []);
          if (providerFailure && semanticScholarOnly) {
            fetchError = providerFailure;
            break;
          }
          if (searchFetched === 0 && providerFailure) {
            fetchError = providerFailure;
            break;
          }

          const hasMorePortfolioQueries =
            isMultiQueryPortfolioStrategy(normalizedRequest.strategy) &&
            searchIndex < normalizedRequest.searchPlan.length - 1;
          if (hasMorePortfolioQueries) {
            deps.eventStream.emit({
              type: "OBS_RECEIVED",
              runId: run.id,
              node: "collect_papers",
              payload: {
                text:
                  `${normalizedRequest.strategy === "candidate_prior_portfolio" ? "Candidate-prior search" : "Topic discovery"} `
                  + `stored ${newPapersStoredThisSearch} new paper(s) from "${effectiveRequest.query}". ` +
                  "Continuing with the next literature retrieval lane."
              }
            });
            continue;
          }

          if (shouldRetryBroaderAfterLowYieldCollect({
            fetched: searchFetched,
            candidate: { query: plannedSearch.request.query, reason: plannedSearch.reason },
            requestedQuery: normalizedRequest.requestedQuery,
            hasMoreCandidates: searchIndex < normalizedRequest.searchPlan.length - 1
          })) {
            deps.eventStream.emit({
              type: "OBS_RECEIVED",
              runId: run.id,
              node: "collect_papers",
              payload: {
                text:
                  `Only ${searchFetched} paper(s) matched the strict query "${effectiveRequest.query}". ` +
                  `Trying the next broader literature query candidate.`
              }
            });
            continue;
          }

          if (searchFetched > 0) {
            break;
          }
        } catch (error) {
          fetchError = error instanceof Error ? error.message : String(error);
          searchDiagnostics = deps.semanticScholar.getLastSearchDiagnostics?.() ?? searchDiagnostics;
          diagnostics = mergeCollectDiagnostics(diagnostics, searchDiagnostics);
          queryAttempts.push({
            query: effectiveRequest.query,
            queryFamily: plannedSearch.queryFamily,
            retrievalLane: plannedSearch.retrievalLane,
            reason: plannedSearch.reason,
            source: plannedSearch.source,
            sourceReason: plannedSearch.sourceReason,
            filtersRelaxed: plannedSearch.filtersRelaxed,
            allocatedLimit: newPaperLimitForSearch,
            retrievalLimit: providerRequest.limit,
            fetched: searchFetched,
            relevantFetched,
            selected: newPapersStoredThisSearch,
            attemptCount: searchDiagnostics.attemptCount,
            lastStatus: searchDiagnostics.lastStatus,
            retryAfterMs: searchDiagnostics.retryAfterMs,
            providerDiagnostics: currentAggregation?.providerDiagnostics
          });
          break;
        }
      }

      if (!fetchError) {
        await publishForCollectGeneration({
          run,
          attemptId: collectAttemptId,
          action: async () => {
            await runContextMemory.put("collect_papers.requested_limit", null);
            await runContextMemory.put("collect_papers.request", null);
          }
        });
      }

      const bibtexMode = normalizeBibtexMode(requestFromContext?.bibtexMode);
      let topicDiscoveryQualityAudit: TopicDiscoveryCorpusQualityAudit | undefined;
      let topicDiscoverySemanticAudit: TopicDiscoverySemanticAuditTrace | undefined;
      let topicDiscoverySemanticReviewRecovery:
        TopicDiscoverySemanticReviewRecovery | undefined;
      let topicDiscoveryQualityFailure: string | undefined;
      let topicDiscoveryProviderCoverageDegraded = false;
      if (normalizedRequest.strategy === "topic_portfolio" && mode === "replace") {
        const topicDiscoveryRows = Array.from(topicDiscoveryLexicalRows.values());
        const topicDiscoveryCandidatePoolRows = Array.from(
          topicDiscoveryCandidateRows.values()
        );
        const plannedSearchFamilies: TopicDiscoverySearchFamily[] = normalizedRequest.searchPlan.map(
          (search) => ({
            queryFamily: search.queryFamily,
            query: search.request.query,
            source: search.source,
            sharedAnchorTerms: search.topicDiscoveryFamily?.sharedAnchorTerms,
            axisTerms: search.topicDiscoveryFamily?.axisTerms,
            lens: search.topicDiscoveryFamily?.lens,
            contributionIntent: search.topicDiscoveryFamily?.contributionIntent,
            contractSource: search.topicDiscoveryFamily?.contractSource
          })
        );
        const semanticRelevanceProfile = buildTopicDiscoveryCorpusRelevanceProfile(
          plannedSearchFamilies
        );
        // Retrieval lanes are execution variants of one scientific family contract.
        // Downstream reviewers must see each family exactly once.
        const searchFamilies = semanticRelevanceProfile.families;
        const candidatePoolAnchorProximatePaperIds = new Set<string>();
        for (const row of topicDiscoveryCandidatePoolRows) {
          const relevance = assessTopicDiscoveryPaperRelevance({
            row,
            profile: semanticRelevanceProfile,
            eligibleQueryFamilies:
              paperQueryFamilies.get(row.paper_id) ?? new Set<string>()
          });
          if (relevance.anchorProximate) {
            candidatePoolAnchorProximatePaperIds.add(row.paper_id);
          }
        }
        const lexicalMatchedFamilyIdsByPaper = new Map<string, Set<string>>();
        for (const row of topicDiscoveryRows) {
          const relevance = assessTopicDiscoveryPaperRelevance({
            row,
            profile: semanticRelevanceProfile,
            eligibleQueryFamilies:
              paperQueryFamilies.get(row.paper_id) ?? new Set<string>()
          });
          if (relevance.relevant) {
            lexicalMatchedFamilyIdsByPaper.set(
              row.paper_id,
              new Set(relevance.matchedQueryFamilies)
            );
          }
        }
        const semanticAuditInput: RunTopicDiscoverySemanticAuditInput = {
          llm: deps.llm,
          rows: topicDiscoveryCandidatePoolRows,
          searchFamilies: searchFamilies.map((family) => ({
            queryFamily: family.queryFamily,
            query: family.query,
            axisTerms: family.axisTerms ?? [],
            lens: family.lens ?? "",
            contributionIntent: family.contributionIntent ?? ""
          })),
          lexicalMatchedFamilyIdsByPaper,
          providerCandidatePaperIdsByFamily:
            topicDiscoveryCandidatePaperIdsByFamily,
          timeoutMs: resolveTopicDiscoverySemanticAuditTimeoutMs(),
          abortSignal
        };
        topicDiscoverySemanticReviewRecovery =
          await runTopicDiscoverySemanticReviewWithRecovery({
            input: semanticAuditInput,
            onRetry: (frozenInputSha256) => {
              deps.eventStream.emit({
                type: "OBS_RECEIVED",
                runId: run.id,
                node: "collect_papers",
                payload: {
                  text:
                    "Retrying topic-discovery semantic review once against "
                    + `frozen input ${frozenInputSha256.slice(0, 12)}; `
                    + "retrieval and query planning remain unchanged."
                }
              });
            }
          });
        topicDiscoverySemanticAudit = topicDiscoverySemanticReviewRecovery.audit;
        const reviewerIdentity = resolveResearchLlmIdentity(deps.config);
        const reviewerInputSha256 = createHash("sha256")
          .update(JSON.stringify(topicDiscoverySemanticAudit.reviewer_input_payload), "utf8")
          .digest("hex");
        const semanticReviewInputContent = `${JSON.stringify({
          version: TOPIC_DISCOVERY_SEMANTIC_REVIEW_INPUT_ARTIFACT_VERSION,
          collect_attempt_id: collectAttemptId,
          evidence_status: "semantic_review_input_only",
          paper_evidence_allowed: false,
          reviewer_identity: reviewerIdentity,
          payload_sha256: reviewerInputSha256,
          payload: topicDiscoverySemanticAudit.reviewer_input_payload
        }, null, 2)}\n`;
        const semanticReviewContent = `${JSON.stringify({
          version: topicDiscoverySemanticAudit.version,
          collect_attempt_id: collectAttemptId,
          evidence_status: "semantic_review_judgment_only",
          paper_evidence_allowed: false,
          reviewer_identity: reviewerIdentity,
          reviewer_input_sha256: reviewerInputSha256,
          status: topicDiscoverySemanticAudit.status,
          prompt_sha256: topicDiscoverySemanticAudit.prompt_sha256,
          response_sha256: topicDiscoverySemanticAudit.response_sha256,
          limits: topicDiscoverySemanticAudit.limits,
          reviewer_input_bytes: topicDiscoverySemanticAudit.reviewer_input_bytes,
          counts: topicDiscoverySemanticAudit.counts,
          recall: topicDiscoverySemanticAudit.recall,
          execution: topicDiscoverySemanticAudit.execution,
          reasons: topicDiscoverySemanticAudit.reasons,
          protocol_violations: topicDiscoverySemanticAudit.protocol_violations,
          judgments: topicDiscoverySemanticAudit.judgments,
          recovery: {
            policy: topicDiscoverySemanticReviewRecovery.policy,
            maximum_attempts:
              topicDiscoverySemanticReviewRecovery.maximum_attempts,
            frozen_input_sha256:
              topicDiscoverySemanticReviewRecovery.frozen_input_sha256,
            input_integrity_verified:
              topicDiscoverySemanticReviewRecovery.input_integrity_verified,
            recovery_performed:
              topicDiscoverySemanticReviewRecovery.recovery_performed,
            exhausted: topicDiscoverySemanticReviewRecovery.exhausted,
            exhaustion_reason:
              topicDiscoverySemanticReviewRecovery.exhaustion_reason,
            attempts: topicDiscoverySemanticReviewRecovery.attempts
          }
        }, null, 2)}\n`;
        collectAttemptArtifactContents["collect_semantic_review_input.json"] =
          semanticReviewInputContent;
        collectAttemptArtifactContents["collect_semantic_review.json"] =
          semanticReviewContent;
        await publishForCollectGeneration({
          run,
          attemptId: collectAttemptId,
          action: async () => {
            await writeRunArtifact(
              run,
              "collect_semantic_review_input.json",
              semanticReviewInputContent
            );
            await writeRunArtifact(
              run,
              "collect_semantic_review.json",
              semanticReviewContent
            );
          }
        });
        const assessment = assessTopicDiscoveryCorpusQuality({
          rows: topicDiscoveryCandidatePoolRows,
          searchFamilies,
          paperQueryFamilies,
          semanticAudit: topicDiscoverySemanticAudit,
          globalLimit: normalizedRequest.globalLimit
        });
        topicDiscoveryQualityAudit = {
          ...assessment.audit,
          collect_attempt_id: collectAttemptId
        };
        storedRows.clear();
        fetchedPapers.clear();
        newPaperIds.clear();
        for (const [paperId, matchedQueryFamilies] of assessment.matchedQueryFamiliesByPaper) {
          if (!assessment.retainedPaperIds.has(paperId)) {
            continue;
          }
          const row = topicDiscoveryCandidateRows.get(paperId);
          const paper = topicDiscoveryCandidatePapers.get(paperId);
          if (!row || !paper) {
            continue;
          }
          const queryFamilies = [...matchedQueryFamilies].sort();
          storedRows.set(paperId, {
            ...row,
            query_families: queryFamilies
          });
          fetchedPapers.set(paperId, paper);
          newPaperIds.add(paperId);
        }
        const corpusQualityContent = `${JSON.stringify(topicDiscoveryQualityAudit, null, 2)}\n`;
        collectAttemptArtifactContents["collect_corpus_quality.json"] = corpusQualityContent;
        await publishForCollectGeneration({
          run,
          attemptId: collectAttemptId,
          action: async () => {
            await writeRunArtifact(run, "collect_corpus_quality.json", corpusQualityContent);
          }
        });

        for (const paperId of [...storedRows.keys()]) {
          if (assessment.retainedPaperIds.has(paperId)) {
            continue;
          }
          storedRows.delete(paperId);
          fetchedPapers.delete(paperId);
          newPaperIds.delete(paperId);
        }
        const retainedGovernanceWarnings = governanceWarnings.filter((warning) =>
          assessment.retainedPaperIds.has(warning.paper_id)
        );
        governanceWarnings.splice(0, governanceWarnings.length, ...retainedGovernanceWarnings);
        const semanticReviewSelectionsByPaper = new Map<
          string,
          Array<{
            family_id: string;
            selection_source:
              | "lexical_match"
              | "provider_provenance_floor";
          }>
        >();
        for (const pair of topicDiscoverySemanticAudit.reviewer_input_payload.requested_pairs) {
          const selections = semanticReviewSelectionsByPaper.get(pair.paper_id) ?? [];
          selections.push({
            family_id: pair.family_id,
            selection_source: pair.selection_source
          });
          semanticReviewSelectionsByPaper.set(pair.paper_id, selections);
        }
        const candidatePoolContent = serializeJsonl(
          topicDiscoveryCandidatePoolRows.map((row) => {
            const paper = topicDiscoveryCandidatePapers.get(row.paper_id);
            if (!paper) {
              throw new Error("topic_discovery_candidate_provenance_missing");
            }
            const queryFamilies = [...(paperQueryFamilies.get(row.paper_id) || [])];
            const familyRetrievalRanks = queryFamilies.map((familyId) => {
              const rank = (
                topicDiscoveryCandidatePaperIdsByFamily.get(familyId)
                  ?.indexOf(row.paper_id) ?? -1
              ) + 1;
              if (rank <= 0) {
                throw new Error("topic_discovery_candidate_family_rank_missing");
              }
              return { family_id: familyId, rank };
            });
            return {
            ...row,
            schema_version: TOPIC_DISCOVERY_CANDIDATE_SIDECAR_VERSION,
            collect_attempt_id: collectAttemptId,
            evidence_status: "semantic_screening_candidate_only",
            paper_evidence_allowed: false,
            retrieval_status: "retrieved_governance_usable",
            query_families: queryFamilies,
            family_retrieval_ranks: familyRetrievalRanks,
            canonical_search_source: paper.canonicalSource,
            search_providers: [...new Set(paper.searchProviders)],
            lexical_matched_query_families: [
              ...(lexicalMatchedFamilyIdsByPaper.get(row.paper_id) || [])
            ],
            semantic_review_selections:
              semanticReviewSelectionsByPaper.get(row.paper_id) ?? [],
            semantic_review_requested_query_families: (
              semanticReviewSelectionsByPaper.get(row.paper_id) ?? []
            ).map((selection) => selection.family_id),
            semantic_review_requested:
              (semanticReviewSelectionsByPaper.get(row.paper_id)?.length ?? 0) > 0,
            selected_by_semantic_quality: assessment.retainedPaperIds.has(row.paper_id),
            published_in_corpus:
              assessment.audit.passed
              && assessment.retainedPaperIds.has(row.paper_id)
          }})
        );

        if (!topicDiscoveryQualityAudit.passed) {
          const failedQualityAudit = topicDiscoveryQualityAudit;
          const perFamilyFloor =
            failedQualityAudit.thresholds.minimum_direct_support_per_family;
          const precisionFloor =
            failedQualityAudit.thresholds.minimum_semantic_precision_per_family;
          const familyMeetsQualityFloor = (
            family: TopicDiscoveryCorpusQualityAudit["query_families"][number]
          ) =>
            family.direct_support_paper_count >= perFamilyFloor
            && family.semantic_precision >= precisionFloor;
          const supportedQueryFamilies: SupportedLiteratureQueryFamilyFeedback[] =
            failedQualityAudit.query_families
            .filter(familyMeetsQualityFloor)
            .map((family) => ({
              queryFamily: family.query_family,
              query: family.query,
              axisTerms: family.axis_terms,
              lens: family.lens,
              contributionIntent: parseTopicDiscoveryContributionIntent(
                family.contribution_intent
              ),
              contractSource: family.contract_source,
              relevantPaperCount: family.direct_support_paper_count
            }));
          const rejectedQueryFamilies = failedQualityAudit.query_families
            .filter((family) => !familyMeetsQualityFloor(family));
          const candidateTitles = buildTopicDiscoveryCandidateTitleFeedback({
            rows: topicDiscoveryCandidatePoolRows,
            anchorProximatePaperIds: candidatePoolAnchorProximatePaperIds,
            paperQueryFamilies,
            audit: topicDiscoveryQualityAudit
          });
          const semanticOperationalFailure =
            topicDiscoverySemanticAudit.status === "operational_failure";
          const semanticRecoveryExhausted =
            topicDiscoverySemanticReviewRecovery.exhausted;
          const semanticReviewComplete = topicDiscoverySemanticAudit.status === "complete";
          const providerCoverage = assessTopicDiscoveryProviderCoverage(
            aggregationReport?.providerDiagnostics ?? []
          );
          const providerCoverageDegraded = providerCoverage.status === "degraded";
          topicDiscoveryProviderCoverageDegraded = providerCoverageDegraded;
          const queryFeedbackAllowed =
            semanticReviewComplete && !providerCoverageDegraded;
          let accumulatedFeedback = {
            candidateTitles: queryFeedbackAllowed ? candidateTitles : [],
            rejectedQueries: queryFeedbackAllowed
              ? rejectedQueryFamilies.map((family) => family.query)
              : [],
            supportedQueryFamilies: queryFeedbackAllowed ? supportedQueryFamilies : []
          };
          if (queryFeedbackAllowed) {
            const feedbackPublication = await publishForCollectGeneration({
              run,
              attemptId: collectAttemptId,
              action: async () => recordLiteratureQueryPlanRejection(runContextMemory, {
                rejectedQueries: rejectedQueryFamilies.map(
                  (family) => family.query
                ),
                qualityReasons: failedQualityAudit.reasons,
                sharedAnchorTerms:
                  failedQualityAudit.observed.shared_anchor_terms,
                candidateTitles,
                scientificScopeFingerprint:
                  generatedQueries?.scientificScopeContract?.scopeFingerprint,
                queryFamilies: failedQualityAudit.query_families.map(
                  (family) => ({
                    queryFamily: family.query_family,
                    query: family.query,
                    axisTerms: family.axis_terms,
                    lens: family.lens,
                    contributionIntent: parseTopicDiscoveryContributionIntent(
                      family.contribution_intent
                    ),
                    contractSource: family.contract_source,
                    relevantPaperCount: family.direct_support_paper_count
                  })
                ),
                supportedQueryFamilies
              })
            });
            if (feedbackPublication.value) {
              accumulatedFeedback = {
                candidateTitles: feedbackPublication.value.candidateTitles,
                rejectedQueries: feedbackPublication.value.rejectedQueries,
                supportedQueryFamilies:
                  feedbackPublication.value.supportedQueryFamilies
                  ?? supportedQueryFamilies
              };
            }
          }
          const reformulationHintsContent = `${JSON.stringify({
              version: 2,
              collect_attempt_id: collectAttemptId,
              strategy: "anchor_proximate_title_pseudo_relevance_feedback",
              evidence_status: "query_hint_only",
              paper_evidence_allowed: false,
              active: queryFeedbackAllowed,
              failure_class: semanticReviewComplete
                ? providerCoverageDegraded
                  ? "retrieval_provider_coverage_degraded"
                  : "query_quality_failure"
                : semanticOperationalFailure
                  ? "semantic_review_operational_failure"
                  : "semantic_review_incomplete",
              feedback_applied: queryFeedbackAllowed,
              semantic_review_status: topicDiscoverySemanticAudit.status,
              feedback_scope: "bounded_retry_history",
              provider_coverage: providerCoverage,
              shared_anchor_terms: topicDiscoveryQualityAudit.observed.shared_anchor_terms,
              candidate_titles: accumulatedFeedback.candidateTitles,
              current_retrieval_candidate_titles: candidateTitles,
              rejected_queries: accumulatedFeedback.rejectedQueries,
              supported_query_families:
                accumulatedFeedback.supportedQueryFamilies ?? supportedQueryFamilies,
              current_retrieval_supported_query_families: supportedQueryFamilies,
              rejected_query_families: rejectedQueryFamilies.map((family) => ({
                query_family: family.query_family,
                query: family.query,
                axis_terms: family.axis_terms,
                direct_support_paper_count: family.direct_support_paper_count,
                semantic_precision: family.semantic_precision
              }))
            }, null, 2)}\n`;
          collectAttemptArtifactContents["collect_query_reformulation_hints.json"] =
            reformulationHintsContent;
          collectAttemptArtifactContents[TOPIC_DISCOVERY_CANDIDATE_POOL_ARTIFACT] =
            candidatePoolContent;
          await publishForCollectGeneration({
            run,
            attemptId: collectAttemptId,
            action: async () => {
              await writeRunArtifact(
                run,
                "collect_query_reformulation_hints.json",
                reformulationHintsContent
              );
              await writeRunArtifact(
                run,
                TOPIC_DISCOVERY_CANDIDATE_POOL_ARTIFACT,
                candidatePoolContent
              );
            }
          });
          storedRows.clear();
          fetchedPapers.clear();
          newPaperIds.clear();
          governanceWarnings.splice(0, governanceWarnings.length);
          topicDiscoveryQualityFailure = semanticRecoveryExhausted
            ? `topic_discovery_semantic_review_recovery_exhausted: ${topicDiscoveryQualityAudit.reasons.join(" ")} `
              + `Recovery reason: ${topicDiscoverySemanticReviewRecovery.exhaustion_reason ?? "semantic_review_retry_incomplete"}. `
              + "The frozen semantic-review recovery budget is exhausted; do not rerun retrieval automatically."
            : !semanticReviewComplete
              ? `Topic-discovery semantic review ${semanticOperationalFailure ? "failed operationally" : "was incomplete"}: ${topicDiscoveryQualityAudit.reasons.join(" ")} `
                + "Retry the semantic review without learning from or revising the query plan."
            : providerCoverageDegraded
              ? "topic_discovery_retrieval_provider_coverage_degraded: "
                + `${providerCoverage.unavailable_providers.map(formatProviderName).join(", ")} `
                + "were unavailable across every retrieval lane. "
                + `${topicDiscoveryQualityAudit.reasons.join(" ")} `
                + "Retry collection without learning from or revising the query plan."
            : `Topic-discovery corpus quality gate failed: ${topicDiscoveryQualityAudit.reasons.join(" ")} `
              + "Revise the independent query families before this corpus can be approved.";
        } else {
          const reformulationHintsContent = `${JSON.stringify({
              version: 2,
              collect_attempt_id: collectAttemptId,
              active: false,
              evidence_status: "none",
              paper_evidence_allowed: false,
              candidate_titles: [],
              rejected_queries: [],
              supported_query_families: [],
              current_retrieval_supported_query_families: [],
              rejected_query_families: []
            }, null, 2)}\n`;
          collectAttemptArtifactContents["collect_query_reformulation_hints.json"] =
            reformulationHintsContent;
          collectAttemptArtifactContents[TOPIC_DISCOVERY_CANDIDATE_POOL_ARTIFACT] =
            candidatePoolContent;
          await publishForCollectGeneration({
            run,
            attemptId: collectAttemptId,
            action: async () => {
              await clearLiteratureQueryPlanRejection(runContextMemory);
              await writeRunArtifact(
                run,
                "collect_query_reformulation_hints.json",
                reformulationHintsContent
              );
              await writeRunArtifact(
                run,
                TOPIC_DISCOVERY_CANDIDATE_POOL_ARTIFACT,
                candidatePoolContent
              );
            }
          });
        }
      }

      const collectToolCallsUsed = topicDiscoverySemanticAudit
        ? 1 + (
            topicDiscoverySemanticReviewRecovery?.attempts.reduce(
              (sum, attempt) => sum + attempt.calls_started,
              0
            ) ?? topicDiscoverySemanticAudit.execution.calls_started
          )
        : 1;

      const zeroResultFailure =
        !fetchError && !topicDiscoveryQualityFailure && mode === "replace" && storedRows.size === 0
          ? buildCollectZeroResultsMessage(
              queryAttempts,
              normalizedRequest.requestedQuery,
              aggregationReport?.source ?? "semantic_scholar"
            )
          : undefined;
      const papersToEnrich = zeroResultFailure
        || topicDiscoveryQualityFailure
        || normalizedRequest.strategy === "candidate_prior_portfolio"
        ? []
        : Array.from(fetchedPapers.values()).filter((paper) =>
            shouldEnrichStoredRow(storedRows.get(paper.paperId), bibtexMode)
          );

      storedCount = storedRows.size;
      const resultMeta = buildCollectResultMeta({
        collectAttemptId,
        request: effectiveRequest,
        fetched: fetchedPapers.size,
        stored: storedCount,
        added: newPaperIds.size,
        baseCount,
        mode,
        diagnostics,
        filters: effectiveRequest.filters || {},
        bibtexMode,
        completed: !fetchError && !zeroResultFailure && !topicDiscoveryQualityFailure,
        fetchError: fetchError || zeroResultFailure || topicDiscoveryQualityFailure,
        pdfRecovered,
        bibtexEnriched,
        aggregationReport,
        enrichmentAttempts: countEnrichmentAttempts(currentEnrichmentLogs),
        fallbackSources: Array.from(fallbackSources),
        requestedQuery: normalizedRequest.requestedQuery,
        queryAttempts,
        corpusQuality: topicDiscoveryQualityAudit,
        governanceWarnings,
        enrichment:
          papersToEnrich.length > 0
            ? {
                blocking: false,
                status: "pending",
                targetCount: papersToEnrich.length,
                processedCount: 0,
                attemptedCount: 0,
                updatedCount: 0
              }
            : {
                blocking: false,
                status: "not_needed",
                targetCount: 0,
                processedCount: 0,
                attemptedCount: 0,
                updatedCount: 0
              }
      });

      const collectionSnapshot = await persistCollectSnapshot({
        run,
        rows: Array.from(storedRows.values()),
        mode,
        request: effectiveRequest,
        resultMeta,
        enrichmentLogs: Array.from(persistedEnrichmentLogs.values()),
        bibtexMode,
        aggregationReport
      });
      if (
        candidatePriorSearchPlan
        && !fetchError
        && !zeroResultFailure
        && !topicDiscoveryQualityFailure
      ) {
        const resultCorpusRaw = collectionSnapshot.artifacts["corpus.jsonl"];
        if (resultCorpusRaw === undefined) {
          throw new Error("candidate_prior_search_result_corpus_missing");
        }
        const receiptAttempts: CandidatePriorSearchAttemptResult[] =
          queryAttempts.map((attempt) => {
            if (attempt.retrievalLane === "standard") {
              throw new Error(
                "candidate_prior_search_standard_lane_forbidden"
              );
            }
            return {
              familyId: attempt.queryFamily,
              retrievalLane: attempt.retrievalLane,
              query: attempt.query,
              fetched: attempt.fetched,
              selected: attempt.selected,
              selectedPaperIds: [
                ...(candidatePriorAttemptPaperIds.get(
                  `${attempt.queryFamily}::${attempt.retrievalLane}`
                ) ?? [])
              ].sort()
            };
          });
        const receipt = buildCandidatePriorSearchReceipt({
          plan: candidatePriorSearchPlan,
          collectAttemptId,
          generatedAt: new Date().toISOString(),
          resultCorpusSha256: createHash("sha256")
            .update(resultCorpusRaw, "utf8")
            .digest("hex"),
          resultCorpusByteLength: Buffer.byteLength(resultCorpusRaw, "utf8"),
          attempts: receiptAttempts
        });
        const receiptContent = `${JSON.stringify(receipt, null, 2)}\n`;
        collectAttemptArtifactContents[CANDIDATE_PRIOR_SEARCH_RECEIPT_ARTIFACT] =
          receiptContent;
        await publishForCollectGeneration({
          run,
          attemptId: collectAttemptId,
          action: async () => {
            await writeRunArtifact(
              run,
              CANDIDATE_PRIOR_SEARCH_RECEIPT_ARTIFACT,
              receiptContent
            );
          }
        });
      }
      await archiveCurrentCollectAttempt({
        run,
        attemptId: collectAttemptId,
        status: resolveCollectAttemptStatus({
          fetchError: fetchError || zeroResultFailure,
          corpusQuality: topicDiscoveryQualityAudit
        }),
        phase: "collection",
        includeTopicDiscoveryArtifacts: Boolean(topicDiscoveryQualityAudit),
        includeCandidatePriorArtifacts: Boolean(candidatePriorSearchPlan),
        artifactContents: {
          ...collectAttemptArtifactContents,
          ...collectionSnapshot.artifacts
        }
      });
      if (!collectionSnapshot.published) {
        const message = `collect_papers attempt ${collectAttemptId} was superseded before its collection snapshot could be published.`;
        return {
          status: "failure",
          error: message,
          summary: message,
          toolCallsUsed: collectToolCallsUsed
        };
      }
      await publishForCollectGeneration({
        run,
        attemptId: collectAttemptId,
        action: async () => {
          await runContextMemory.put("collect_papers.last_attempt_id", collectAttemptId);
          await runContextMemory.put("collect_papers.active_attempt_id", null);
        }
      });

      await syncCollectRunContext({
        run,
        runContextMemory,
        request: effectiveRequest,
        resultMeta,
        diagnostics
      });
      if (diagnostics.attemptCount > 0) {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "collect_papers",
          payload: {
            text: `Semantic Scholar attempts: ${formatAttemptSummary(diagnostics)}`
          }
        });
      }
      if (fetchError || zeroResultFailure || topicDiscoveryQualityFailure) {
        // syncCollectRunContext already persisted the fetch/zero-result error.
      } else {
        await longTermStore.append({
          runId: run.id,
          category: "papers",
          text: `Collected ${storedCount} papers for ${effectiveRequest.query}`,
          tags: ["collect_papers", effectiveRequest.query]
        });
      }

      deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: "collect_papers",
        payload: {
          source: resultMeta.source,
          papers: storedCount,
          query: effectiveRequest.query,
          requested_limit: effectiveRequest.limit,
          fetch_error: fetchError || zeroResultFailure || topicDiscoveryQualityFailure
        }
      });

      if (fetchError) {
        const failureMessage = buildCollectFailureMessage(
          effectiveRequest,
          fetchError,
          aggregationReport?.source ?? "semantic_scholar"
        );
        return {
          status: "failure",
          error: failureMessage,
          summary: failureMessage,
          toolCallsUsed: collectToolCallsUsed
        };
      }

      if (zeroResultFailure) {
        return {
          status: "failure",
          error: zeroResultFailure,
          summary: zeroResultFailure,
          toolCallsUsed: collectToolCallsUsed
        };
      }

      if (topicDiscoveryQualityFailure) {
        return {
          status: "failure",
          ...(topicDiscoveryProviderCoverageDegraded
            ? { failureKind: "environment" as const }
            : {}),
          error: topicDiscoveryQualityFailure,
          summary: topicDiscoveryQualityFailure,
          toolCallsUsed: collectToolCallsUsed
        };
      }

      if (papersToEnrich.length > 0) {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "collect_papers",
          payload: {
            text: `Corpus saved with ${storedCount} paper(s). Deferred enrichment is scheduled in the background for ${papersToEnrich.length} paper(s).`
          }
        });

        await startDetachedEnrichment({
          deps,
          run,
          request: effectiveRequest,
          mode,
          baseCount,
          bibtexMode,
          papers: papersToEnrich,
          fetchedCount: fetchedPapers.size,
          diagnostics,
          storedRows,
          pdfRecovered,
          bibtexEnriched,
          fallbackSources,
          currentEnrichmentLogs,
          persistedEnrichmentLogs,
          storedCount,
          newPaperIds,
          pendingSummary: buildCollectSummary(resultMeta),
          aggregationReport,
          requestedQuery: normalizedRequest.requestedQuery,
          queryAttempts,
          corpusQuality: topicDiscoveryQualityAudit,
          governanceWarnings,
          collectAttemptId
        });
      }

      return {
        status: "success",
        summary: buildCollectSummary(resultMeta),
        needsApproval: true,
        toolCallsUsed: collectToolCallsUsed
      };
    }
  };
}

async function runTopicDiscoverySemanticReviewWithRecovery(input: {
  input: RunTopicDiscoverySemanticAuditInput;
  onRetry?: (frozenInputSha256: string) => void;
}): Promise<TopicDiscoverySemanticReviewRecovery> {
  const first = await runTopicDiscoverySemanticAudit(input.input);
  const frozenInputSha256 = hashTopicDiscoverySemanticReviewerInput(first);
  const attempts = [buildTopicDiscoverySemanticReviewAttempt(1, first)];
  if (first.status === "complete") {
    return {
      policy: TOPIC_DISCOVERY_SEMANTIC_REVIEW_RECOVERY_POLICY,
      maximum_attempts: 2,
      frozen_input_sha256: frozenInputSha256,
      input_integrity_verified: true,
      recovery_performed: false,
      exhausted: false,
      attempts,
      audit: first
    };
  }

  const nonRetryableReason = resolveNonRetryableSemanticReviewReason(first);
  if (nonRetryableReason) {
    return {
      policy: TOPIC_DISCOVERY_SEMANTIC_REVIEW_RECOVERY_POLICY,
      maximum_attempts: 2,
      frozen_input_sha256: frozenInputSha256,
      input_integrity_verified: true,
      recovery_performed: false,
      exhausted: true,
      exhaustion_reason: nonRetryableReason,
      attempts,
      audit: first
    };
  }

  input.onRetry?.(frozenInputSha256);
  const second = await runTopicDiscoverySemanticAudit(input.input);
  const secondInputSha256 = hashTopicDiscoverySemanticReviewerInput(second);
  attempts.push(buildTopicDiscoverySemanticReviewAttempt(2, second));
  const inputIntegrityVerified = secondInputSha256 === frozenInputSha256;
  const recovered = inputIntegrityVerified && second.status === "complete";
  return {
    policy: TOPIC_DISCOVERY_SEMANTIC_REVIEW_RECOVERY_POLICY,
    maximum_attempts: 2,
    frozen_input_sha256: frozenInputSha256,
    input_integrity_verified: inputIntegrityVerified,
    recovery_performed: true,
    exhausted: !recovered,
    ...(!recovered
      ? {
          exhaustion_reason: inputIntegrityVerified
            ? "semantic_review_retry_incomplete"
            : "semantic_review_frozen_input_mismatch"
        }
      : {}),
    attempts,
    audit: inputIntegrityVerified ? second : first
  };
}

function resolveNonRetryableSemanticReviewReason(
  audit: TopicDiscoverySemanticAuditTrace
): string | undefined {
  if (audit.counts.budget_excluded_pairs > 0) {
    return "semantic_review_input_budget_exhausted";
  }
  return audit.reasons.find((reason) =>
    reason === "semantic_audit_timeout_partitions_exhausted"
    || reason === "semantic_audit_partition_cumulative_input_budget_exceeded"
  );
}

function hashTopicDiscoverySemanticReviewerInput(
  audit: TopicDiscoverySemanticAuditTrace
): string {
  return createHash("sha256")
    .update(JSON.stringify(audit.reviewer_input_payload), "utf8")
    .digest("hex");
}

function buildTopicDiscoverySemanticReviewAttempt(
  attempt: number,
  audit: TopicDiscoverySemanticAuditTrace
): TopicDiscoverySemanticReviewRecovery["attempts"][number] {
  return {
    attempt,
    status: audit.status,
    reviewer_input_sha256: hashTopicDiscoverySemanticReviewerInput(audit),
    prompt_sha256: audit.prompt_sha256,
    response_sha256: audit.response_sha256,
    calls_started: audit.execution.calls_started,
    reasons: audit.reasons
  };
}

function buildTopicDiscoveryCandidateTitleFeedback(input: {
  rows: StoredCorpusRow[];
  anchorProximatePaperIds: ReadonlySet<string>;
  paperQueryFamilies: ReadonlyMap<string, ReadonlySet<string>>;
  audit: TopicDiscoveryCorpusQualityAudit;
}): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  const push = (title: string) => {
    const normalized = title.replace(/\s+/gu, " ").trim().slice(0, 240);
    const key = normalized.toLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      selected.push(normalized);
    }
  };

  for (const family of input.audit.query_families) {
    const axisTerms = new Set(family.axis_terms);
    const ranked = input.rows
      .filter((row) =>
        input.anchorProximatePaperIds.has(row.paper_id)
        && input.paperQueryFamilies.get(row.paper_id)?.has(family.query_family)
      )
      .map((row, index) => {
        const terms = new Set(extractLiteratureTermSequence(`${row.title}\n${row.abstract}`));
        const axisMatches = [...axisTerms].filter((term) => terms.has(term)).length;
        return { row, index, axisMatches };
      })
      .sort((left, right) => right.axisMatches - left.axisMatches || left.index - right.index);
    for (const candidate of ranked.slice(0, 6)) {
      push(candidate.row.title);
    }
  }

  for (const row of input.rows) {
    if (selected.length >= MAX_TOPIC_DISCOVERY_FEEDBACK_TITLES) {
      break;
    }
    if (input.anchorProximatePaperIds.has(row.paper_id)) {
      push(row.title);
    }
  }
  return selected.slice(0, MAX_TOPIC_DISCOVERY_FEEDBACK_TITLES);
}

function isMultiQueryPortfolioStrategy(
  strategy: PreparedCollectRequestPlan["strategy"]
): boolean {
  return strategy === "topic_portfolio"
    || strategy === "candidate_prior_portfolio";
}

function normalizeCollectRequest(input: {
  request?: CollectPapersNodeRequest;
  topic: string;
  rawBrief?: string;
  extractedBriefTopic?: string;
  llmGeneratedQueries?: string[];
  llmTopicDiscoveryPlan?: GeneratedTopicDiscoveryPlan;
  llmPlanningFailure?: string;
  constraintProfile: { collect: CollectPapersNodeRequest["filters"] };
  configuredLimit: number;
  asOfDate: string;
}): PreparedCollectRequestPlan {
  const configuredLimit = Math.max(1, input.configuredLimit);
  const request = input.request;
  const requestedLimitFromCommand =
    typeof request?.limit === "number" && Number.isFinite(request.limit) && request.limit > 0
      ? Math.floor(request.limit)
      : undefined;
  const requestedAdditional =
    typeof request?.additional === "number" && Number.isFinite(request.additional) && request.additional > 0
      ? Math.floor(request.additional)
      : undefined;

  const limit = requestedLimitFromCommand ?? requestedAdditional ?? configuredLimit;
  const sortField = request?.sort?.field ?? "relevance";
  const sortOrder = request?.sort?.order ?? (sortField === "paperId" ? "asc" : "desc");
  const requestedQuery = request?.query?.trim() || undefined;
  const candidatePriorSearchPlan = request?.candidatePriorSearchPlan;
  if (candidatePriorSearchPlan) {
    const planValidation = validateCandidatePriorSearchPlanIntegrity(
      candidatePriorSearchPlan
    );
    if (!planValidation.valid) {
      throw new Error(
        `candidate_prior_search_plan_invalid:${planValidation.reasons.join(",")}`
      );
    }
    const searchPlan: PlannedCollectSearch[] =
      candidatePriorSearchPlan.candidates.flatMap((candidate) =>
        candidate.families.flatMap((family) =>
          family.lanes.map((lane) => ({
            request: {
              query: family.query,
              limit,
              retrievalIntent: "topic_discovery" as const,
              sort: lane.sort,
              filters: lane.publication_date_range
                ? {
                    publicationDateOrYear:
                      `${lane.publication_date_range.start_date}:`
                      + lane.publication_date_range.end_date
                  }
                : {}
            },
            queryFamily: family.family_id,
            retrievalLane: lane.retrieval_lane,
            reason: "llm_generated" as const,
            source: "candidate_prior_plan" as const,
            sourceReason:
              `candidate_prior:${candidate.candidate_id}:`
              + `${family.query_intent}:${lane.retrieval_lane}`,
            filtersRelaxed: false
          }))
        )
      );
    return {
      primaryRequest: searchPlan[0]?.request,
      searchPlan,
      strategy: "candidate_prior_portfolio",
      globalLimit: limit,
      suppressedFilters: [],
      candidatePriorSearchPlan
    };
  }
  const queryCandidates = buildLiteratureQueryCandidates({
    requestedQuery,
    runTopic: input.topic,
    llmGeneratedQueries: input.llmGeneratedQueries,
    extractedBriefTopic: input.extractedBriefTopic,
    briefTopic: extractResearchBriefTopic(input.rawBrief)
  });
  const researchMode = parseResearchRunMode(input.rawBrief || "");
  const strategy: PreparedCollectRequestPlan["strategy"] =
    researchMode === "topic_discovery"
      ? "topic_portfolio"
      : "first_yield";
  const topicDiscoveryFamiliesByQuery = new Map(
    (input.llmTopicDiscoveryPlan?.families ?? []).map((family) => [
      family.query.toLowerCase(),
      {
        familyId: family.id,
        sharedAnchorTerms: [...(input.llmTopicDiscoveryPlan?.sharedAnchorTerms ?? [])],
        axisTerms: [...family.axisTerms],
        lens: family.lens,
        contributionIntent: family.contributionIntent,
        contractSource: family.contractSource
      } satisfies TopicDiscoverySearchFamilyIntent
    ])
  );
  const selectedCandidates =
    strategy === "topic_portfolio"
      ? selectTopicDiscoveryQueryFamilies(queryCandidates)
      : queryCandidates;
  const structuredTopicCandidates =
    strategy === "topic_portfolio"
      ? selectedCandidates.filter((candidate) =>
          topicDiscoveryFamiliesByQuery.has(candidate.query.toLowerCase())
        )
      : [];
  const executableCandidates =
    strategy === "topic_portfolio"
      ? structuredTopicCandidates.length >= TOPIC_DISCOVERY_MIN_QUERY_FAMILIES
        ? structuredTopicCandidates
        : []
      : selectedCandidates;
  const mergedFilters = buildSemanticScholarFilters(
    mergeCollectConstraintDefaults(request?.filters, input.constraintProfile.collect)
  );
  const filterPolicy = resolveCollectSearchFilterPolicy(strategy, mergedFilters);
  const sort = {
    field: sortField,
    order: sortOrder
  } as const;
  const searchPlan: PlannedCollectSearch[] = [];
  const seen = new Set<string>();
  const pushSearch = (
    query: string,
    reason: LiteratureQueryCandidate["reason"],
    source: PlannedCollectSearch["source"],
    sourceReason: string,
    filters: SemanticScholarSearchFilters,
    filtersRelaxed: boolean,
    topicDiscoveryFamily: TopicDiscoverySearchFamilyIntent | undefined,
    retrievalLane: TopicDiscoveryRetrievalLane,
    requestSort = sort
  ) => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return;
    }
    const candidateRequest: SemanticScholarSearchRequest = {
      query: normalizedQuery,
      limit,
      ...(strategy === "topic_portfolio"
        ? {
            retrievalIntent: "topic_discovery" as const,
            topicDiscoveryFamily
          }
        : {}),
      sort: requestSort,
      filters
    };
    const key = [
      normalizedQuery.toLowerCase(),
      serializeSearchFilters(filters),
      requestSort.field,
      requestSort.order
    ].join("::");
    if (seen.has(key)) {
      return;
    }
    const queryFamily =
      topicDiscoveryFamily?.familyId ||
      buildLiteratureQueryFamilySignature(normalizedQuery);
    if (!queryFamily) {
      return;
    }
    seen.add(key);
    searchPlan.push({
      request: candidateRequest,
      queryFamily,
      retrievalLane,
      topicDiscoveryFamily,
      reason,
      source,
      sourceReason,
      filtersRelaxed
    });
  };

  for (const candidate of executableCandidates) {
    const source = resolveCollectQuerySource(candidate.reason);
    const sourceReason =
      source === "deterministic_query"
        ? input.llmPlanningFailure ||
          (input.llmGeneratedQueries?.length
            ? strategy === "topic_portfolio"
              ? "topic_discovery_portfolio_fill"
              : "first_yield_low_yield_fallback"
            : candidate.reason)
        : candidate.reason;
    const topicDiscoveryFamily = strategy === "topic_portfolio"
      ? topicDiscoveryFamiliesByQuery.get(candidate.query.toLowerCase())
      : undefined;
    if (strategy === "topic_portfolio") {
      pushSearch(
        candidate.query,
        candidate.reason,
        source,
        `${sourceReason}:recent_direct_prior`,
        buildRecentDirectPriorFilters(filterPolicy.filters, input.asOfDate),
        false,
        topicDiscoveryFamily,
        "recent_direct_prior",
        { field: "publicationDate", order: "desc" }
      );
      pushSearch(
        candidate.query,
        candidate.reason,
        source,
        `${sourceReason}:broad_relevance`,
        filterPolicy.filters,
        false,
        topicDiscoveryFamily,
        "broad_relevance",
        { field: "relevance", order: "desc" }
      );
    } else {
      pushSearch(
        candidate.query,
        candidate.reason,
        source,
        sourceReason,
        filterPolicy.filters,
        false,
        undefined,
        "standard"
      );
    }
  }

  return {
    primaryRequest: searchPlan[0]?.request,
    searchPlan:
      strategy === "topic_portfolio"
        ? searchPlan.slice(
            0,
            TOPIC_DISCOVERY_MAX_QUERY_FAMILIES
              * TOPIC_DISCOVERY_SEARCH_LANES_PER_FAMILY
          )
        : searchPlan.slice(0, 8),
    requestedQuery,
    strategy,
    globalLimit: limit,
    suppressedFilters: filterPolicy.suppressedFilters
  };
}

function buildRecentDirectPriorFilters(
  filters: SemanticScholarSearchFilters,
  asOfDate: string
): SemanticScholarSearchFilters {
  if (filters.publicationDateOrYear || filters.year) {
    return { ...filters };
  }
  const parsed = new Date(asOfDate);
  if (!Number.isFinite(parsed.getTime())) {
    return { ...filters };
  }
  const endDate = parsed.toISOString().slice(0, 10);
  const startYear = parsed.getUTCFullYear() - 1;
  return {
    ...filters,
    publicationDateOrYear: `${startYear}-01-01:${endDate}`
  };
}

function selectTopicDiscoveryQueryFamilies(
  candidates: LiteratureQueryCandidate[]
): LiteratureQueryCandidate[] {
  const normalizedCandidates = candidates.flatMap((candidate) => {
    const query = normalizeTopicDiscoveryLiteratureQuery(candidate.query);
    return query ? [{ ...candidate, query }] : [];
  });
  const llmCandidates = selectIndependentLiteratureQueryCandidates(
    normalizedCandidates.filter((candidate) => candidate.reason === "llm_generated"),
    TOPIC_DISCOVERY_MAX_QUERY_FAMILIES
  );
  if (llmCandidates.length >= TOPIC_DISCOVERY_MIN_QUERY_FAMILIES) {
    return llmCandidates;
  }

  const deterministicCandidates = normalizedCandidates.filter(
    (candidate) => candidate.reason !== "requested_query" && candidate.reason !== "llm_generated"
  );
  return selectIndependentLiteratureQueryCandidates(
    [...llmCandidates, ...deterministicCandidates],
    TOPIC_DISCOVERY_MAX_QUERY_FAMILIES
  );
}

function buildTopicDiscoveryRelevanceProfile(
  plan: PreparedCollectRequestPlan
): TopicDiscoveryCorpusRelevanceProfile | undefined {
  if (plan.strategy !== "topic_portfolio") {
    return undefined;
  }
  return buildTopicDiscoveryCorpusRelevanceProfile(
    plan.searchPlan.map((search) => ({
      queryFamily: search.queryFamily,
      query: search.request.query,
      source: search.source,
      sharedAnchorTerms: search.topicDiscoveryFamily?.sharedAnchorTerms,
      axisTerms: search.topicDiscoveryFamily?.axisTerms,
      lens: search.topicDiscoveryFamily?.lens,
      contributionIntent: search.topicDiscoveryFamily?.contributionIntent,
      contractSource: search.topicDiscoveryFamily?.contractSource
    }))
  );
}

function resolveResearchLlmIdentity(config: NodeExecutionDeps["config"]): string {
  if (!config?.providers) {
    return "unconfigured";
  }
  const mode = config.providers.llm_mode;
  if (mode === "openai_api") {
    return `${mode}:${config.providers.openai.model}:${config.providers.openai.reasoning_effort}`;
  }
  if (mode === "ollama") {
    return `${mode}:${config.providers.ollama?.research_model || "unconfigured"}:${config.providers.ollama?.research_reasoning_effort || "default"}`;
  }
  return `${mode}:${config.providers.codex.model}:${config.providers.codex.reasoning_effort}`;
}

function resolveTopicDiscoverySemanticAuditTimeoutMs(): number | undefined {
  const raw = process.env.AUTOLABOS_CORPUS_SEMANTIC_AUDIT_TIMEOUT_MS;
  if (!raw?.trim()) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function parseTopicDiscoveryContributionIntent(
  value: string
): TopicDiscoveryContributionIntent | undefined {
  return value === "method"
    || value === "measurement"
    || value === "dataset_or_benchmark"
    || value === "empirical_finding"
    || value === "theory"
    || value === "reproducibility"
    ? value
    : undefined;
}

function resolveTopicDiscoveryRetrievalLimit(
  allocatedLimit: number,
  globalLimit: number
): number {
  return Math.max(
    1,
    Math.min(
      Math.max(1, Math.floor(globalLimit)),
      Math.max(1, Math.floor(allocatedLimit)) *
        TOPIC_DISCOVERY_RETRIEVAL_OVERFETCH_MULTIPLIER
    )
  );
}

function rememberTopicDiscoveryCandidate(input: {
  rows: Map<string, StoredCorpusRow>;
  papers: Map<string, AggregatedSearchPaper>;
  paperQueryFamilies: Map<string, Set<string>>;
  paperIdsByFamily: Map<string, string[]>;
  row: StoredCorpusRow;
  paper: AggregatedSearchPaper;
  queryFamily: string;
}): AggregatedSearchRecord {
  const canonicalPaperId = findEquivalentTopicDiscoveryPaperId(
    input.rows,
    input.row
  ) ?? input.row.paper_id;
  const normalizedIncomingRow = {
    ...input.row,
    paper_id: canonicalPaperId
  };
  const mergedRow = {
    ...mergeStoredCorpusRows(
      input.rows.get(canonicalPaperId),
      normalizedIncomingRow
    ),
    paper_id: canonicalPaperId
  };
  input.rows.set(canonicalPaperId, mergedRow);
  const mergedPaper = mergeTopicDiscoveryCandidatePaper(
    input.papers.get(canonicalPaperId),
    input.paper,
    mergedRow
  );
  input.papers.set(canonicalPaperId, mergedPaper);
  const queryFamilies =
    input.paperQueryFamilies.get(canonicalPaperId) ?? new Set<string>();
  queryFamilies.add(input.queryFamily);
  input.paperQueryFamilies.set(canonicalPaperId, queryFamilies);
  const familyPaperIds = input.paperIdsByFamily.get(input.queryFamily) ?? [];
  if (!familyPaperIds.includes(canonicalPaperId)) {
    familyPaperIds.push(canonicalPaperId);
    input.paperIdsByFamily.set(input.queryFamily, familyPaperIds);
  }
  return { row: mergedRow, paper: mergedPaper };
}

function findEquivalentTopicDiscoveryPaperId(
  rows: ReadonlyMap<string, StoredCorpusRow>,
  incoming: StoredCorpusRow
): string | undefined {
  const incomingDoi = normalizeTopicDiscoveryStableId(incoming.doi);
  const incomingArxivId = normalizeTopicDiscoveryStableId(incoming.arxiv_id);
  const incomingWorkFingerprint = buildTopicDiscoveryWorkFingerprint(incoming);
  for (const [paperId, existing] of rows) {
    if (paperId === incoming.paper_id) {
      return paperId;
    }
    if (
      incomingDoi
      && incomingDoi === normalizeTopicDiscoveryStableId(existing.doi)
    ) {
      return paperId;
    }
    if (
      incomingArxivId
      && incomingArxivId === normalizeTopicDiscoveryStableId(existing.arxiv_id)
    ) {
      return paperId;
    }
    if (
      incomingWorkFingerprint
      && incomingWorkFingerprint === buildTopicDiscoveryWorkFingerprint(existing)
    ) {
      return paperId;
    }
  }
  return undefined;
}

function buildTopicDiscoveryWorkFingerprint(
  row: Pick<StoredCorpusRow, "title" | "authors">
): string | undefined {
  const title = normalizeTopicDiscoveryWorkText(row.title);
  const firstAuthor = normalizeTopicDiscoveryWorkText(row.authors[0] ?? "");
  if (title.length < 24 || !firstAuthor) {
    return undefined;
  }
  return `${title}::${firstAuthor}`;
}

function normalizeTopicDiscoveryStableId(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeTopicDiscoveryWorkText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function mergeTopicDiscoveryCandidatePaper(
  existing: AggregatedSearchPaper | undefined,
  incoming: AggregatedSearchPaper,
  row: StoredCorpusRow
): AggregatedSearchPaper {
  const preferred = !existing || (!existing.doi && incoming.doi)
    ? incoming
    : existing;
  const provenance = [...(existing?.provenance ?? []), ...incoming.provenance]
    .filter((candidate, index, values) => {
      const key = JSON.stringify(candidate);
      return values.findIndex((value) => JSON.stringify(value) === key) === index;
    });
  return {
    ...preferred,
    paperId: row.paper_id,
    title: row.title,
    abstract: row.abstract,
    year: row.year,
    venue: row.venue,
    url: row.url,
    landingUrl: row.landing_url,
    openAccessPdfUrl: row.pdf_url,
    authors: row.authors,
    doi: row.doi,
    arxivId: row.arxiv_id,
    citationCount: row.citation_count,
    influentialCitationCount: row.influential_citation_count,
    publicationDate: row.publication_date,
    publicationTypes: row.publication_types,
    fieldsOfStudy: row.fields_of_study,
    searchProviders: [...new Set([
      ...(existing?.searchProviders ?? []),
      ...incoming.searchProviders
    ])],
    provenance
  };
}

function mergePaperSearchAggregationReports(
  previous: PaperSearchAggregationReport | undefined,
  next: PaperSearchAggregationReport
): PaperSearchAggregationReport {
  if (!previous) {
    return {
      ...next,
      providers: [...next.providers],
      providerDiagnostics: [...next.providerDiagnostics],
      clusters: [...next.clusters]
    };
  }
  const providers = [...new Set([...previous.providers, ...next.providers])];
  const clusters = new Map(previous.clusters.map((cluster) => [cluster.paperId, cluster]));
  for (const cluster of next.clusters) {
    if (!clusters.has(cluster.paperId)) {
      clusters.set(cluster.paperId, cluster);
    }
  }
  return {
    source:
      providers.length === 1 && providers[0] === "semantic_scholar"
        ? "semantic_scholar"
        : "aggregated",
    rawCandidateCount: previous.rawCandidateCount + next.rawCandidateCount,
    canonicalCount: previous.canonicalCount + next.canonicalCount,
    providers,
    providerDiagnostics: [
      ...previous.providerDiagnostics,
      ...next.providerDiagnostics
    ],
    clusters: [...clusters.values()]
  };
}

function resolveCollectQuerySource(
  reason: LiteratureQueryCandidate["reason"]
): CollectQueryAttemptMeta["source"] {
  if (reason === "requested_query") {
    return "requested_query";
  }
  if (reason === "llm_generated") {
    return "llm_query_planner";
  }
  return "deterministic_query";
}

function buildSemanticScholarFilters(
  filters: CollectPapersNodeRequest["filters"] | undefined
): SemanticScholarSearchFilters {
  if (!filters) {
    return {};
  }

  const publicationDateOrYear = resolvePublicationDateOrYear(filters);
  return {
    publicationTypes: sanitizePublicationTypes(filters.publicationTypes),
    openAccessPdf: filters.openAccessPdf === true,
    minCitationCount: filters.minCitationCount,
    publicationDateOrYear,
    year: publicationDateOrYear ? undefined : filters.year,
    venue: filters.venues?.filter(Boolean),
    fieldsOfStudy: filters.fieldsOfStudy?.filter(Boolean)
  };
}

function resolveCollectSearchFilterPolicy(
  strategy: PreparedCollectRequestPlan["strategy"],
  filters: SemanticScholarSearchFilters
): {
  filters: SemanticScholarSearchFilters;
  suppressedFilters: PreparedCollectRequestPlan["suppressedFilters"];
} {
  if (strategy !== "topic_portfolio" || !filters.fieldsOfStudy?.length) {
    return {
      filters,
      suppressedFilters: []
    };
  }
  const { fieldsOfStudy, ...portableFilters } = filters;
  return {
    filters: portableFilters,
    suppressedFilters: [
      {
        filter: "fieldsOfStudy",
        values: [...fieldsOfStudy],
        reason: "topic_discovery_cross_provider_taxonomy_mismatch"
      }
    ]
  };
}

function sanitizePublicationTypes(types: string[] | undefined): string[] | undefined {
  const normalized = types
    ?.map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !["paper", "papers", "article", "articles"].includes(value.toLowerCase()));
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolvePublicationDateOrYear(filters: CollectPapersNodeRequest["filters"]): string | undefined {
  if (!filters) {
    return undefined;
  }
  if (filters.dateRange) {
    return filters.dateRange;
  }
  if (filters.year) {
    return undefined;
  }
  if (typeof filters.lastYears === "number" && Number.isFinite(filters.lastYears) && filters.lastYears > 0) {
    const nowYear = new Date().getFullYear();
    const startYear = Math.max(1900, nowYear - Math.floor(filters.lastYears) + 1);
    return `${startYear}:`;
  }
  return undefined;
}

function normalizeBibtexMode(mode: unknown): BibtexMode {
  if (mode === "generated" || mode === "s2" || mode === "hybrid") {
    return mode;
  }
  return "hybrid";
}

function buildCollectFailureMessage(
  request: SemanticScholarSearchRequest,
  fetchError: string,
  source: CollectResultMeta["source"] = "semantic_scholar"
): string {
  if (source === "aggregated") {
    return `Multi-provider literature search failed for "${request.query}" (${fetchError})`;
  }
  if (/\b429\b/.test(fetchError)) {
    const chunkNote = usesConservativeChunking(request)
      ? " AutoLabOS already switched this request to smaller Semantic Scholar chunks."
      : "";
    return `Semantic Scholar rate limited "${request.query}": ${fetchError}.${chunkNote} Wait a bit and retry, or lower --limit to 50-100 / collect in smaller batches.`;
  }
  return `Semantic Scholar fetch failed for "${request.query}" (${fetchError})`;
}

function buildCollectSummary(resultMeta: CollectResultMeta): string {
  const sourceLabel = resultMeta.source === "aggregated" ? "Aggregated search" : "Semantic Scholar";
  const storedSummary =
    resultMeta.mode === "additional"
      ? `${sourceLabel} stored ${resultMeta.stored} total papers for "${resultMeta.query}" (${resultMeta.added} newly added).`
      : `${sourceLabel} stored ${resultMeta.stored} papers for "${resultMeta.query}".`;

  switch (resultMeta.enrichment.status) {
    case "pending":
      return resultMeta.enrichment.processedCount > 0
        ? `${storedSummary} Deferred enrichment continues in background for ${resultMeta.enrichment.targetCount} paper(s) (${Math.min(
            resultMeta.enrichment.processedCount,
            resultMeta.enrichment.targetCount
          )}/${resultMeta.enrichment.targetCount} processed).`
        : `${storedSummary} Deferred enrichment scheduled in background for ${resultMeta.enrichment.targetCount} paper(s).`;
    case "completed":
      return `${storedSummary} Deferred enrichment finished for ${resultMeta.enrichment.targetCount} paper(s). PDF recovered ${resultMeta.pdfRecovered}; BibTeX enriched ${resultMeta.bibtexEnriched}.`;
    case "failed":
      return `${storedSummary} Deferred enrichment failed after ${Math.min(
        resultMeta.enrichment.processedCount,
        resultMeta.enrichment.targetCount
      )}/${resultMeta.enrichment.targetCount} paper(s): ${resultMeta.enrichment.lastError || "unknown error"}. Stored corpus remains available.`;
    case "not_needed":
    default:
      return storedSummary;
  }
}

function usesConservativeChunking(request: SemanticScholarSearchRequest): boolean {
  return (
    request.limit >= 200 ||
    request.filters?.openAccessPdf === true ||
    (request.filters?.publicationTypes?.length ?? 0) > 0 ||
    (request.filters?.fieldsOfStudy?.length ?? 0) > 0 ||
    (request.filters?.venue?.length ?? 0) > 0 ||
    typeof request.filters?.minCitationCount === "number"
  );
}

function buildSearchProviders(deps: NodeExecutionDeps): SearchProviderClient[] {
  const semanticScholarProvider = createSemanticScholarSearchProvider(deps.semanticScholar);
  if (isFakeSemanticScholarFixtureActive()) {
    return [semanticScholarProvider];
  }
  const providers: SearchProviderClient[] = [semanticScholarProvider];
  if (deps.openAlex) {
    providers.push(deps.openAlex);
  }
  if (deps.crossref) {
    providers.push(deps.crossref);
  }
  if (deps.arxiv) {
    providers.push(deps.arxiv);
  }
  return providers;
}

function isFakeSemanticScholarFixtureActive(): boolean {
  const fakeResponse = process.env.AUTOLABOS_FAKE_SEMANTIC_SCHOLAR_RESPONSE;
  return typeof fakeResponse === "string" && fakeResponse.trim().length > 0;
}

function formatProviderName(provider: PaperSearchProvider): string {
  switch (provider) {
    case "semantic_scholar":
      return "Semantic Scholar";
    case "openalex":
      return "OpenAlex";
    case "crossref":
      return "Crossref";
    case "arxiv":
      return "arXiv";
  }
}

function formatProviderList(providers: PaperSearchProvider[]): string {
  return providers.map((provider) => formatProviderName(provider)).join(", ");
}

function isSemanticScholarOnlyProviders(providers: SearchProviderClient[]): boolean {
  return providers.length === 1 && providers[0]?.provider === "semantic_scholar";
}

function buildProviderFailureMessage(
  query: string,
  diagnostics: PaperSearchProviderDiagnostics[]
): string | undefined {
  const failedProviders = diagnostics.filter((diagnostic) => diagnostic.error);
  if (diagnostics.length === 1 && diagnostics[0]?.provider === "semantic_scholar") {
    return diagnostics[0].error;
  }
  if (failedProviders.length === 0 || failedProviders.length !== diagnostics.length) {
    return undefined;
  }
  return failedProviders
    .map((diagnostic) => `${formatProviderName(diagnostic.provider)}: ${diagnostic.error}`)
    .join("; ")
    .replace(/^/, `all providers failed for "${query}" (`)
    .concat(")");
}

function shouldEnrichStoredRow(row: StoredCorpusRow | undefined, bibtexMode: BibtexMode): boolean {
  if (!row) {
    return false;
  }
  if (!row.pdf_url) {
    return true;
  }
  if (bibtexMode !== "hybrid") {
    return false;
  }
  const currentBibtex = row.bibtex || row.semantic_scholar_bibtex;
  if (!currentBibtex) {
    return true;
  }
  return scoreBibtexRichness(currentBibtex) < 10 && Boolean(row.doi || row.arxiv_id || row.landing_url);
}


async function runEnrichmentPass(input: {
  collectAttemptId?: string;
  papers: SemanticScholarPaper[];
  storedRows: Map<string, StoredCorpusRow>;
  run: CollectRunRef;
  request: SemanticScholarSearchRequest;
  fetchedCount: number;
  mode: "replace" | "additional";
  baseCount: number;
  diagnostics: SemanticScholarSearchDiagnostics;
  bibtexMode: BibtexMode;
  requireOpenAccessPdf: boolean;
  abortSignal?: AbortSignal;
  eventStream: NodeExecutionDeps["eventStream"];
  pdfRecovered: number;
  bibtexEnriched: number;
  fallbackSources: Set<string>;
  currentEnrichmentLogs: Map<string, CollectEnrichmentLogEntry>;
  persistedEnrichmentLogs: Map<string, CollectEnrichmentLogEntry>;
  storedCount: number;
  newPaperIds: Set<string>;
  aggregationReport?: PaperSearchAggregationReport;
  requestedQuery?: string;
  queryAttempts: CollectQueryAttemptMeta[];
  corpusQuality?: TopicDiscoveryCorpusQualityAudit;
  governanceWarnings?: CollectGovernanceWarning[];
  writeCorpusArtifactsOnProgress: boolean;
  runContextMemory: RunContextMemory;
  targetCount?: number;
  processedOffset?: number;
  updatedOffset?: number;
}): Promise<{
  pdfRecovered: number;
  bibtexEnriched: number;
  storedCount: number;
  processedCount: number;
  updatedCount: number;
}> {
  let processed = 0;
  let updated = 0;
  let changedSinceLastPersist = false;
  const targetCount = input.targetCount ?? input.papers.length;
  const processedOffset = Math.max(0, input.processedOffset ?? 0);
  const updatedOffset = Math.max(0, input.updatedOffset ?? 0);

  const persistProgress = async () => {
    if (!changedSinceLastPersist) {
      return;
    }
    const progressMeta = buildCollectResultMeta({
      collectAttemptId: input.collectAttemptId,
      request: input.request,
      fetched: input.fetchedCount,
      stored: input.storedCount,
      added: input.newPaperIds.size,
      baseCount: input.baseCount,
      mode: input.mode,
      diagnostics: input.diagnostics,
      filters: input.request.filters || {},
      bibtexMode: input.bibtexMode,
      completed: true,
      pdfRecovered: input.pdfRecovered,
      bibtexEnriched: input.bibtexEnriched,
      aggregationReport: input.aggregationReport,
      enrichmentAttempts: countEnrichmentAttempts(input.currentEnrichmentLogs),
      fallbackSources: Array.from(input.fallbackSources),
      requestedQuery: input.requestedQuery,
      queryAttempts: input.queryAttempts,
      corpusQuality: input.corpusQuality,
      governanceWarnings: input.governanceWarnings,
      enrichment: {
        blocking: false,
        status: "pending",
        targetCount,
        processedCount: Math.min(targetCount, processedOffset + processed),
        attemptedCount: Math.min(targetCount, processedOffset + processed),
        updatedCount: Math.min(targetCount, updatedOffset + updated)
      }
    });
    await persistCollectSnapshot({
      run: input.run,
      rows: Array.from(input.storedRows.values()),
      mode: input.mode,
      request: input.request,
      resultMeta: progressMeta,
      enrichmentLogs: Array.from(input.persistedEnrichmentLogs.values()),
      bibtexMode: input.bibtexMode,
      aggregationReport: input.aggregationReport,
      writeCorpusArtifacts: input.writeCorpusArtifactsOnProgress
    });
    await syncCollectRunContext({
      run: input.run,
      runContextMemory: input.runContextMemory,
      request: input.request,
      resultMeta: progressMeta,
      diagnostics: input.diagnostics
    });
    changedSinceLastPersist = false;
  };

  await runWithConcurrency(input.papers, ENRICHMENT_CONCURRENCY, async (paper) => {
    if (input.abortSignal?.aborted) {
      return;
    }
    const currentRow = input.storedRows.get(paper.paperId);
    if (!currentRow) {
      return;
    }

    let enrichedRow = currentRow;
    try {
      const enriched = await enrichCollectedPaper({
        paper,
        row: currentRow,
        bibtexMode: input.bibtexMode,
        requireOpenAccessPdf: input.requireOpenAccessPdf,
        abortSignal: input.abortSignal,
        onProgress: (message) =>
          input.eventStream.emit({
            type: "OBS_RECEIVED",
            runId: input.run.id,
            node: "collect_papers",
            payload: {
              text: `[${paper.paperId}] ${message}`
            }
          })
      });

      if (enriched.pdfRecovered) {
        input.pdfRecovered += 1;
      }
      if (enriched.bibtexEnriched) {
        input.bibtexEnriched += 1;
      }
      for (const source of enriched.fallbackSources) {
        input.fallbackSources.add(source);
      }
      input.currentEnrichmentLogs.set(paper.paperId, enriched.log);
      input.persistedEnrichmentLogs.set(paper.paperId, enriched.log);
      const mergedRow = mergeStoredCorpusRows(currentRow, enriched.row);
      enrichedRow = input.corpusQuality?.version
        === TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION
        ? {
            ...mergedRow,
            title: currentRow.title,
            abstract: currentRow.abstract,
            query_families: currentRow.query_families
          }
        : mergedRow;
    } catch (error) {
      const failedLog = {
        paper_id: paper.paperId,
        attempts: [],
        errors: [error instanceof Error ? error.message : String(error)]
      };
      input.currentEnrichmentLogs.set(paper.paperId, failedLog);
      input.persistedEnrichmentLogs.set(paper.paperId, failedLog);
    }

    const previous = JSON.stringify(currentRow);
    const next = JSON.stringify(enrichedRow);
    if (previous !== next) {
      input.storedRows.set(paper.paperId, enrichedRow);
      input.storedCount = input.storedRows.size;
      updated += 1;
      changedSinceLastPersist = true;
    }

    processed += 1;
    if (
      processed === 1 ||
      processed === input.papers.length ||
      processed % ENRICHMENT_PROGRESS_INTERVAL === 0
    ) {
      input.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: input.run.id,
        node: "collect_papers",
        payload: {
          text: `Collect enrichment progress: processed ${Math.min(processedOffset + processed, targetCount)}/${targetCount}, stored ${input.storedCount}/${input.request.limit}.`
        }
      });
      await persistProgress();
    }
  });

  await persistProgress();
  return {
    pdfRecovered: input.pdfRecovered,
    bibtexEnriched: input.bibtexEnriched,
    storedCount: input.storedCount,
    processedCount: processed,
    updatedCount: updated
  };
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function readExistingCorpus(run: { id: string }): Promise<StoredCorpusRow[]> {
  const raw = await safeRead(`.autolabos/runs/${run.id}/corpus.jsonl`);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as StoredCorpusRow;
      } catch {
        return undefined;
      }
    })
    .filter((row): row is StoredCorpusRow => Boolean(row?.paper_id));
}

async function readExistingEnrichmentLogs(run: { id: string }): Promise<CollectEnrichmentLogEntry[]> {
  const raw = await safeRead(`.autolabos/runs/${run.id}/collect_enrichment.jsonl`);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as CollectEnrichmentLogEntry;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is CollectEnrichmentLogEntry => Boolean(entry?.paper_id));
}

async function readCollectResultMeta(run: { id: string }): Promise<CollectResultMeta | undefined> {
  const raw = await safeRead(`.autolabos/runs/${run.id}/collect_result.json`);
  if (!raw.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as CollectResultMeta;
    return typeof parsed?.query === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readCollectBackgroundJob(run: { id: string }): Promise<CollectBackgroundJobRecord | undefined> {
  const raw = await safeRead(`.autolabos/runs/${run.id}/${COLLECT_BACKGROUND_JOB_FILE}`);
  if (!raw.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as CollectBackgroundJobRecord;
    return isCollectBackgroundJobRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeCollectBackgroundJob(
  run: CollectRunRef,
  record: CollectBackgroundJobRecord
): Promise<boolean> {
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (record.collectAttemptId) {
    await writeRunArtifact(
      run as any,
      `collect_attempts/${record.collectAttemptId}/background_job.json`,
      serialized
    );
  }
  const publication = await publishForCollectGeneration({
    run,
    attemptId: record.collectAttemptId,
    action: async () => {
      await writeRunArtifact(run as any, COLLECT_BACKGROUND_JOB_FILE, serialized);
    }
  });
  return publication.published;
}

function buildCollectBackgroundJobRecord(input: {
  runId: string;
  request: SemanticScholarSearchRequest;
  mode: "replace" | "additional";
  baseCount: number;
  bibtexMode: BibtexMode;
  paperIds: string[];
  fetchedCount: number;
  diagnostics: SemanticScholarSearchDiagnostics;
  newPaperIds: string[];
  pendingSummary: string;
  requestedQuery?: string;
  queryAttempts: CollectQueryAttemptMeta[];
  status: "running" | "completed" | "failed" | "superseded";
  scheduledAt?: string;
  recoveryCount?: number;
  lastRecoveredAt?: string;
  lastError?: string;
  collectAttemptId?: string;
  corpusFingerprint?: string;
}): CollectBackgroundJobRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    kind: "collect_deferred_enrichment",
    status: input.status,
    runId: input.runId,
    request: input.request,
    mode: input.mode,
    baseCount: input.baseCount,
    bibtexMode: input.bibtexMode,
    paperIds: input.paperIds,
    fetchedCount: input.fetchedCount,
    diagnostics: input.diagnostics,
    newPaperIds: input.newPaperIds,
    pendingSummary: input.pendingSummary,
    requestedQuery: input.requestedQuery,
    queryAttempts: input.queryAttempts,
    scheduledAt: input.scheduledAt ?? now,
    updatedAt: now,
    recoveryCount: input.recoveryCount ?? 0,
    lastRecoveredAt: input.lastRecoveredAt,
    lastError: input.lastError,
    collectAttemptId: input.collectAttemptId,
    corpusFingerprint: input.corpusFingerprint
  };
}

export function buildCollectCorpusFingerprint(rows: Iterable<StoredCorpusRow>): string {
  const papers = Array.from(rows, (row) => ({
    paper_id: row.paper_id,
    title: row.title,
    abstract: row.abstract ?? "",
    query_families: [...(row.query_families ?? [])].sort()
  })).sort((left, right) => left.paper_id.localeCompare(right.paper_id));
  return createHash("sha256")
    .update(JSON.stringify({ version: 2, papers }))
    .digest("hex");
}

async function readCollectAttemptManifest(run: { id: string }): Promise<{
  collect_attempt_id?: string;
  status?: CollectAttemptStatus;
} | undefined> {
  const raw = await safeRead(`.autolabos/runs/${run.id}/collect_attempt_manifest.json`);
  if (!raw.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as {
      collect_attempt_id?: string;
      status?: CollectAttemptStatus;
    };
  } catch {
    return undefined;
  }
}

async function validateCollectRecoveryLineage(input: {
  run: { id: string };
  job: CollectBackgroundJobRecord;
  resultMeta?: CollectResultMeta;
  storedRows: StoredCorpusRow[];
}): Promise<string | undefined> {
  const generation = await readCollectGeneration(input.run);
  const manifest = await readCollectAttemptManifest(input.run);
  const hasModernLineage = Boolean(
    generation
    || input.job.collectAttemptId
    || input.resultMeta?.collect_attempt_id
    || manifest?.collect_attempt_id
  );
  if (!hasModernLineage) {
    return undefined;
  }
  if (!generation) {
    return "collect_recovery_lineage_missing_generation";
  }
  const expectedAttemptId = generation.collect_attempt_id;
  if (input.job.collectAttemptId !== expectedAttemptId) {
    return "collect_recovery_lineage_job_attempt_mismatch";
  }
  if (input.resultMeta?.collect_attempt_id !== expectedAttemptId) {
    return "collect_recovery_lineage_result_attempt_mismatch";
  }
  if (manifest?.collect_attempt_id !== expectedAttemptId) {
    return "collect_recovery_lineage_manifest_attempt_mismatch";
  }
  if (manifest.status !== "quality_gate_passed") {
    return "collect_recovery_lineage_manifest_not_approved";
  }
  if (!input.job.corpusFingerprint) {
    return "collect_recovery_lineage_missing_corpus_fingerprint";
  }
  if (input.job.corpusFingerprint !== buildCollectCorpusFingerprint(input.storedRows)) {
    return "collect_recovery_lineage_corpus_fingerprint_mismatch";
  }
  return undefined;
}

async function quarantineCollectRecoveryJob(input: {
  run: CollectRunRef;
  job: CollectBackgroundJobRecord;
  reason: string;
}): Promise<void> {
  const record = buildCollectBackgroundJobRecord({
    runId: input.job.runId,
    request: input.job.request,
    mode: input.job.mode,
    baseCount: input.job.baseCount,
    bibtexMode: input.job.bibtexMode,
    paperIds: input.job.paperIds,
    fetchedCount: input.job.fetchedCount,
    diagnostics: input.job.diagnostics,
    newPaperIds: input.job.newPaperIds,
    pendingSummary: input.job.pendingSummary,
    requestedQuery: input.job.requestedQuery,
    queryAttempts: input.job.queryAttempts,
    status: "superseded",
    scheduledAt: input.job.scheduledAt,
    recoveryCount: input.job.recoveryCount,
    lastRecoveredAt: input.job.lastRecoveredAt,
    lastError: input.reason,
    collectAttemptId: input.job.collectAttemptId,
    corpusFingerprint: input.job.corpusFingerprint
  });
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (input.job.collectAttemptId) {
    await writeRunArtifact(
      input.run as any,
      `collect_attempts/${input.job.collectAttemptId}/background_job.json`,
      serialized
    );
  }
  const generation = await readCollectGeneration(input.run);
  await publishForCollectGeneration({
    run: input.run,
    attemptId: generation?.collect_attempt_id,
    action: async () => {
      await writeRunArtifact(input.run as any, COLLECT_BACKGROUND_JOB_FILE, serialized);
    }
  });
}

function reconstructPaperFromStoredRow(row: StoredCorpusRow): SemanticScholarPaper {
  return {
    paperId: row.paper_id,
    title: row.title,
    abstract: row.abstract || undefined,
    year: row.year,
    venue: row.venue,
    url: row.url || row.landing_url,
    openAccessPdfUrl: row.pdf_url,
    authors: row.authors,
    doi: row.doi,
    arxivId: row.arxiv_id,
    citationCount: row.citation_count,
    influentialCitationCount: row.influential_citation_count,
    publicationDate: row.publication_date,
    publicationTypes: row.publication_types,
    fieldsOfStudy: row.fields_of_study,
    citationStylesBibtex: row.semantic_scholar_bibtex
  };
}

function isCollectBackgroundJobRecord(value: unknown): value is CollectBackgroundJobRecord {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as CollectBackgroundJobRecord).version === 1 &&
      (value as CollectBackgroundJobRecord).kind === "collect_deferred_enrichment" &&
      typeof (value as CollectBackgroundJobRecord).runId === "string" &&
      typeof (value as CollectBackgroundJobRecord).status === "string" &&
      Array.isArray((value as CollectBackgroundJobRecord).paperIds) &&
      Array.isArray((value as CollectBackgroundJobRecord).newPaperIds)
  );
}

function buildCollectResultMeta(input: {
  collectAttemptId?: string;
  request: SemanticScholarSearchRequest;
  fetched: number;
  stored: number;
  added: number;
  baseCount: number;
  mode: "replace" | "additional";
  diagnostics: SemanticScholarSearchDiagnostics;
  filters: SemanticScholarSearchFilters;
  bibtexMode: BibtexMode;
  completed: boolean;
  fetchError?: string;
  pdfRecovered: number;
  bibtexEnriched: number;
  aggregationReport?: PaperSearchAggregationReport;
  enrichmentAttempts: number;
  fallbackSources: string[];
  requestedQuery?: string;
  queryAttempts: CollectQueryAttemptMeta[];
  corpusQuality?: TopicDiscoveryCorpusQualityAudit;
  enrichment: CollectEnrichmentMeta;
  governanceWarnings?: CollectGovernanceWarning[];
}): CollectResultMeta {
  return {
    collect_attempt_id: input.collectAttemptId,
    query: input.request.query,
    limit: input.request.limit,
    fetched: input.fetched,
    stored: input.stored,
    added: input.added,
    baseCount: input.baseCount,
    completed: input.completed,
    mode: input.mode,
    source: input.aggregationReport?.source ?? "semantic_scholar",
    providers: input.aggregationReport?.providers,
    rawCandidateCount: input.aggregationReport?.rawCandidateCount,
    canonicalCount: input.aggregationReport?.canonicalCount,
    providerDiagnostics: input.aggregationReport?.providerDiagnostics,
    fetchError: input.fetchError,
    attemptCount: input.diagnostics.attemptCount,
    lastStatus: input.diagnostics.lastStatus,
    retryAfterMs: input.diagnostics.retryAfterMs,
    attempts: input.diagnostics.attempts,
    sort: {
      field: input.request.sort?.field ?? "relevance",
      order: input.request.sort?.order ?? "desc"
    },
    filters: input.filters,
    bibtexMode: input.bibtexMode,
    pdfRecovered: input.pdfRecovered,
    bibtexEnriched: input.bibtexEnriched,
    fallbackAttempts: input.enrichmentAttempts,
    fallbackSources: input.fallbackSources,
    requestedQuery: input.requestedQuery,
    queryAttempts: input.queryAttempts,
    corpusQuality: input.corpusQuality,
    enrichment: input.enrichment,
    governance_warnings: input.governanceWarnings ?? [],
    timestamp: new Date().toISOString()
  };
}

function screenCollectedPaper(
  record: AggregatedSearchRecord,
  policy: ReturnType<typeof loadGovernancePolicy>
): ScreeningReport {
  return screenEvidence(
    {
      text: `${record.paper.title}\n${record.paper.abstract ?? ""}`.trim(),
      source: resolveGovernanceSource(record),
      context: "collect_papers"
    },
    policy
  );
}

function resolveGovernanceSource(record: AggregatedSearchRecord): string {
  return (
    record.row.landing_url ||
    record.row.url ||
    record.row.pdf_url ||
    record.paper.landingUrl ||
    record.paper.url ||
    record.paper.openAccessPdfUrl ||
    `provider:${record.paper.canonicalSource}`
  );
}

function screeningInputSummary(record: AggregatedSearchRecord): string {
  return `${record.paper.title} ${record.paper.abstract ?? ""}`
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 100);
}

async function persistCollectSnapshot(input: {
  run: CollectRunRef;
  rows: StoredCorpusRow[];
  mode: "replace" | "additional";
  request: SemanticScholarSearchRequest;
  resultMeta: CollectResultMeta;
  enrichmentLogs: CollectEnrichmentLogEntry[];
  bibtexMode: BibtexMode;
  aggregationReport?: PaperSearchAggregationReport;
  writeCorpusArtifacts?: boolean;
}): Promise<{ published: boolean; artifacts: Record<string, string> }> {
  const artifacts: Record<string, string> = {
    "collect_request.json": JSON.stringify({
      ...input.request,
      ...(input.resultMeta.collect_attempt_id
        ? { collect_attempt_id: input.resultMeta.collect_attempt_id }
        : {})
    }, null, 2),
    "collect_result.json": JSON.stringify(input.resultMeta, null, 2),
    "collect_enrichment.jsonl": serializeJsonl(input.enrichmentLogs)
  };
  if (input.aggregationReport) {
    artifacts["collect_search_aggregation.json"] = JSON.stringify({
      ...input.aggregationReport,
      ...(input.resultMeta.collect_attempt_id
        ? { collect_attempt_id: input.resultMeta.collect_attempt_id }
        : {})
    }, null, 2);
  } else if (input.resultMeta.collect_attempt_id) {
    artifacts["collect_search_aggregation.json"] = "";
  }
  if (input.writeCorpusArtifacts !== false) {
    if (
      input.mode === "replace"
      && input.resultMeta.corpusQuality?.passed === false
    ) {
      artifacts["corpus.jsonl"] = "";
      artifacts["bibtex.bib"] = "";
    } else {
      const shouldWriteArtifacts =
        input.resultMeta.completed || input.mode === "additional" || input.rows.length > 0;
      if (shouldWriteArtifacts) {
        artifacts["corpus.jsonl"] = serializeJsonl(input.rows);
        const bibtex = buildBibtexFile(input.rows, input.bibtexMode).trim();
        artifacts["bibtex.bib"] = bibtex ? `${bibtex}\n` : "";
      }
    }
  }

  const publication = await publishForCollectGeneration({
    run: input.run,
    attemptId: input.resultMeta.collect_attempt_id,
    action: async () => {
      for (const [artifactPath, content] of Object.entries(artifacts)) {
        await writeRunArtifact(input.run as any, artifactPath, content);
      }
    }
  });
  return { published: publication.published, artifacts };
}

function serializeJsonl(items: unknown[]): string {
  const lines = items.map((item) => JSON.stringify(item)).join("\n");
  return lines ? `${lines}\n` : "";
}

async function persistPlanningFailureSnapshot(input: {
  run: CollectRunRef;
  attemptId: string;
  researchMode: ReturnType<typeof parseResearchRunMode>;
  error: string;
}): Promise<void> {
  const artifacts: Record<string, string> = {
    "collect_request.json": JSON.stringify({
      version: 1,
      collect_attempt_id: input.attemptId,
      status: "planning_failed",
      request: null
    }, null, 2),
    "collect_result.json": JSON.stringify({
      version: 1,
      collect_attempt_id: input.attemptId,
      completed: false,
      stored: 0,
      added: 0,
      fetchError: input.error,
      queryAttempts: [],
      timestamp: new Date().toISOString()
    }, null, 2),
    "collect_search_aggregation.json": "",
    "collect_enrichment.jsonl": ""
  };
  if (input.researchMode === "topic_discovery") {
    artifacts["collect_corpus_quality.json"] = "";
    artifacts["collect_semantic_review_input.json"] = "";
    artifacts["collect_semantic_review.json"] = "";
    artifacts["collect_query_reformulation_hints.json"] = "";
    artifacts[TOPIC_DISCOVERY_CANDIDATE_POOL_ARTIFACT] = "";
    artifacts["corpus.jsonl"] = "";
    artifacts["bibtex.bib"] = "";
  }
  await publishForCollectGeneration({
    run: input.run,
    attemptId: input.attemptId,
    action: async () => {
      for (const [artifactPath, content] of Object.entries(artifacts)) {
        await writeRunArtifact(input.run as any, artifactPath, content);
      }
    }
  });
  await archiveCurrentCollectAttempt({
    run: input.run,
    attemptId: input.attemptId,
    status: "planning_failed",
    phase: "planning",
    includeTopicDiscoveryArtifacts: input.researchMode === "topic_discovery",
    artifactContents: artifacts
  });
}

async function archiveCurrentCollectAttempt(input: {
  run: CollectRunRef;
  attemptId: string;
  status: CollectAttemptStatus;
  includeTopicDiscoveryArtifacts: boolean;
  includeCandidatePriorArtifacts?: boolean;
  phase?: CollectAttemptArchivePhase;
  artifactContents?: Readonly<Record<string, string>>;
}): Promise<void> {
  const artifactPaths = [
    "collect_query_plan.json",
    "collect_request.json",
    "collect_result.json",
    "collect_search_aggregation.json",
    "collect_enrichment.jsonl",
    "corpus.jsonl",
    "bibtex.bib"
  ];
  if (input.includeTopicDiscoveryArtifacts) {
    artifactPaths.push(
      "collect_corpus_quality.json",
      "collect_semantic_review_input.json",
      "collect_semantic_review.json",
      "collect_query_reformulation_hints.json",
      TOPIC_DISCOVERY_CANDIDATE_POOL_ARTIFACT,
      TOPIC_DISCOVERY_PRIOR_WORK_PROBE_RECEIPT_ARTIFACT
    );
  }
  if (input.includeCandidatePriorArtifacts) {
    artifactPaths.push(
      CANDIDATE_PRIOR_SEARCH_PLAN_ARTIFACT,
      CANDIDATE_PRIOR_SEARCH_RECEIPT_ARTIFACT
    );
  }
  const publication = await publishForCollectGeneration({
    run: input.run,
    attemptId: input.attemptId,
    action: async () => persistCollectAttemptArchive({
      run: input.run as any,
      attemptId: input.attemptId,
      status: input.status,
      phase: input.phase,
      artifactPaths,
      artifactContents: input.artifactContents,
      publishTopLevelLatest: true
    })
  });
  if (publication.published) {
    return;
  }

  const explicitArtifactPaths = Object.keys(input.artifactContents ?? {});
  if (explicitArtifactPaths.length === 0) {
    return;
  }
  await persistCollectAttemptArchive({
    run: input.run as any,
    attemptId: input.attemptId,
    status: input.status,
    phase: input.phase,
    artifactPaths: explicitArtifactPaths,
    artifactContents: input.artifactContents,
    publishTopLevelLatest: false
  });
}

function resolveCollectAttemptStatus(input: {
  fetchError?: string;
  corpusQuality?: TopicDiscoveryCorpusQualityAudit;
}): CollectAttemptStatus {
  if (input.fetchError) {
    return "collection_failed";
  }
  if (input.corpusQuality?.passed === false) {
    return "quality_gate_failed";
  }
  return "quality_gate_passed";
}

async function syncCollectRunContext(input: {
  run: CollectRunRef;
  runContextMemory: RunContextMemory;
  request: SemanticScholarSearchRequest;
  resultMeta: CollectResultMeta;
  diagnostics: SemanticScholarSearchDiagnostics;
}): Promise<void> {
  await publishForCollectGeneration({
    run: input.run,
    attemptId: input.resultMeta.collect_attempt_id,
    action: async () => {
      await input.runContextMemory.put("collect_papers.last_request", input.request);
      await input.runContextMemory.put("collect_papers.last_result", input.resultMeta);
      await input.runContextMemory.put("collect_papers.last_attempt_count", input.diagnostics.attemptCount);
      await input.runContextMemory.put("collect_papers.count", input.resultMeta.stored);
      await input.runContextMemory.put("collect_papers.source", input.resultMeta.source);
      await input.runContextMemory.put("collect_papers.last_error", deriveCollectRunContextError(input.resultMeta));
      await input.runContextMemory.put(
        "collect_papers.enrichment_last_error",
        input.resultMeta.enrichment.status === "failed" ? input.resultMeta.enrichment.lastError || null : null
      );
    }
  });
}

function deriveCollectRunContextError(resultMeta: CollectResultMeta): string | null {
  return resultMeta.fetchError || null;
}

function emptyCollectDiagnostics(): SemanticScholarSearchDiagnostics {
  return {
    attemptCount: 0,
    attempts: []
  };
}

function formatAttemptSummary(diagnostics: SemanticScholarSearchDiagnostics): string {
  if (diagnostics.attemptCount === 0) {
    return "0";
  }
  const allFirstAttemptSuccess = diagnostics.attempts.every((attempt) => attempt.attempt === 1 && attempt.ok);
  if (allFirstAttemptSuccess) {
    return `${diagnostics.attempts.length} request(s) succeeded on the first attempt.`;
  }

  return diagnostics.attempts
    .map((attempt, index) => {
      const status = attempt.status ? String(attempt.status) : "network";
      const retry = attempt.retryAfterMs ? ` retry-after=${attempt.retryAfterMs}ms` : "";
      const outcome = attempt.ok ? "ok" : "failed";
      return `req${index + 1} attempt${attempt.attempt}=${status} ${outcome}${retry}`;
    })
    .join(", ");
}

function shouldRetryBroaderAfterLowYieldCollect(input: {
  fetched: number;
  candidate: { query: string; reason: LiteratureQueryCandidate["reason"] };
  requestedQuery?: string;
  hasMoreCandidates: boolean;
}): boolean {
  if (input.fetched >= LOW_YIELD_QUERY_MIN_RESULTS || input.fetched <= 0) {
    return false;
  }
  if (input.requestedQuery?.trim()) {
    return false;
  }
  if (!input.hasMoreCandidates) {
    return false;
  }
  return input.candidate.reason === "llm_generated" && hasSemanticScholarSpecialSyntax(input.candidate.query);
}

function countEnrichmentAttempts(entries: Map<string, CollectEnrichmentLogEntry>): number {
  let count = 0;
  for (const entry of entries.values()) {
    count += entry.attempts.length;
  }
  return count;
}

function mergeCollectDiagnostics(
  previous: SemanticScholarSearchDiagnostics,
  next: SemanticScholarSearchDiagnostics
): SemanticScholarSearchDiagnostics {
  return {
    attemptCount: previous.attempts.length + next.attempts.length,
    lastStatus: next.lastStatus ?? previous.lastStatus,
    retryAfterMs: next.retryAfterMs ?? previous.retryAfterMs,
    attempts: [...previous.attempts.map((attempt) => ({ ...attempt })), ...next.attempts.map((attempt) => ({ ...attempt }))]
  };
}

function extractAggregationReport(resultMeta: CollectResultMeta | undefined): PaperSearchAggregationReport | undefined {
  if (!resultMeta) {
    return undefined;
  }
  return {
    source: resultMeta.source,
    rawCandidateCount: resultMeta.rawCandidateCount ?? resultMeta.fetched,
    canonicalCount: resultMeta.canonicalCount ?? resultMeta.stored,
    providers: resultMeta.providers ?? (resultMeta.source === "semantic_scholar" ? ["semantic_scholar"] : []),
    providerDiagnostics: resultMeta.providerDiagnostics ?? [],
    clusters: []
  };
}

function serializeSearchFilters(filters: SemanticScholarSearchFilters | undefined): string {
  return JSON.stringify({
    publicationTypes: [...(filters?.publicationTypes || [])],
    openAccessPdf: filters?.openAccessPdf === true,
    minCitationCount: filters?.minCitationCount,
    publicationDateOrYear: filters?.publicationDateOrYear,
    year: filters?.year,
    venue: [...(filters?.venue || [])],
    fieldsOfStudy: [...(filters?.fieldsOfStudy || [])]
  });
}

function buildCollectZeroResultsMessage(
  queryAttempts: CollectQueryAttemptMeta[],
  requestedQuery?: string,
  source: CollectResultMeta["source"] = "semantic_scholar"
): string {
  const attempted = queryAttempts
    .map((attempt) => `"${attempt.query}"${attempt.filtersRelaxed ? " (relaxed filters)" : ""}`)
    .join(", ");
  const requested = requestedQuery ? ` Requested query was "${requestedQuery}".` : "";
  const queries = attempted ? ` Tried ${queryAttempts.length} query variant(s): ${attempted}.` : "";
  const prefix =
    source === "semantic_scholar"
      ? "Semantic Scholar returned 0 papers for the configured query plan."
      : "Literature search returned 0 papers for the configured query plan.";
  return `${prefix}${requested}${queries}`;
}

function buildCollectQueryPlanningFailureMessage(
  requestedQuery?: string,
  llmPlanningFailure?: string
): string {
  if (requestedQuery?.trim()) {
    return `collect_papers could not build a Semantic Scholar query plan from the explicit query "${requestedQuery}".`;
  }
  const plannerReason = llmPlanningFailure ? ` LLM planner reason: ${llmPlanningFailure}.` : "";
  return `collect_papers could not build a Semantic Scholar query plan. Deterministic topic fallback produced no usable query.${plannerReason}`;
}

async function startDetachedEnrichment(input: {
  deps: Pick<NodeExecutionDeps, "eventStream" | "runStore">;
  run: CollectRunRef;
  request: SemanticScholarSearchRequest;
  mode: "replace" | "additional";
  baseCount: number;
  bibtexMode: BibtexMode;
  papers: SemanticScholarPaper[];
  fetchedCount: number;
  diagnostics: SemanticScholarSearchDiagnostics;
  storedRows: Map<string, StoredCorpusRow>;
  pdfRecovered: number;
  bibtexEnriched: number;
  fallbackSources: Set<string>;
  currentEnrichmentLogs: Map<string, CollectEnrichmentLogEntry>;
  persistedEnrichmentLogs: Map<string, CollectEnrichmentLogEntry>;
  storedCount: number;
  newPaperIds: Set<string>;
  pendingSummary: string;
  aggregationReport?: PaperSearchAggregationReport;
  requestedQuery?: string;
  queryAttempts: CollectQueryAttemptMeta[];
  corpusQuality?: TopicDiscoveryCorpusQualityAudit;
  governanceWarnings?: CollectGovernanceWarning[];
  targetCount?: number;
  processedOffset?: number;
  updatedOffset?: number;
  recoveredFromCrash?: boolean;
  recoveryCount?: number;
  collectAttemptId?: string;
}): Promise<void> {
  if (input.papers.length === 0) {
    return;
  }
  const jobKey = collectEnrichmentJobKey(input.run.id, input.collectAttemptId);
  if (activeCollectEnrichmentJobs.has(jobKey)) {
    input.deps.eventStream.emit({
      type: "OBS_RECEIVED",
      runId: input.run.id,
      node: "collect_papers",
      payload: {
        text: "Deferred enrichment is already running for this run."
      }
    });
    return;
  }

  const runContextMemory = new RunContextMemory(input.run.memoryRefs.runContextPath);
  const targetCount = input.targetCount ?? input.papers.length;
  const processedOffset = Math.max(0, input.processedOffset ?? 0);
  const updatedOffset = Math.max(0, input.updatedOffset ?? 0);
  const paperIds = input.papers.map((paper) => paper.paperId);
  const corpusFingerprint = buildCollectCorpusFingerprint(input.storedRows.values());
  const lastRecoveredAt = input.recoveredFromCrash ? new Date().toISOString() : undefined;
  const scheduledAt = (await readCollectBackgroundJob(input.run))?.scheduledAt ?? new Date().toISOString();
  await writeCollectBackgroundJob(
    input.run,
    buildCollectBackgroundJobRecord({
      runId: input.run.id,
      request: input.request,
      mode: input.mode,
      baseCount: input.baseCount,
      bibtexMode: input.bibtexMode,
      paperIds,
      fetchedCount: input.fetchedCount,
      diagnostics: input.diagnostics,
      newPaperIds: Array.from(input.newPaperIds),
      pendingSummary: input.pendingSummary,
      requestedQuery: input.requestedQuery,
      queryAttempts: input.queryAttempts,
      status: "running",
      scheduledAt,
      recoveryCount: input.recoveryCount,
      lastRecoveredAt,
      collectAttemptId: input.collectAttemptId,
      corpusFingerprint
    })
  );
  if (input.recoveredFromCrash) {
    input.deps.eventStream.emit({
      type: "OBS_RECEIVED",
      runId: input.run.id,
      node: "collect_papers",
      payload: {
        text: `Recovered deferred enrichment background task after restart; resuming ${input.papers.length}/${targetCount} remaining paper(s).`
      }
    });
  }
  input.deps.eventStream.emit({
    type: "OBS_RECEIVED",
    runId: input.run.id,
    node: "collect_papers",
    payload: {
      text: `Starting deferred enrichment for ${input.papers.length} paper(s) with concurrency ${Math.min(
        ENRICHMENT_CONCURRENCY,
        input.papers.length
      )}.`
    }
  });

  const job = (async () => {
    try {
      const enrichmentState = await runEnrichmentPass({
        collectAttemptId: input.collectAttemptId,
        papers: input.papers,
        storedRows: input.storedRows,
        run: input.run,
        request: input.request,
        fetchedCount: input.fetchedCount,
        mode: input.mode,
        baseCount: input.baseCount,
        diagnostics: input.diagnostics,
        bibtexMode: input.bibtexMode,
        requireOpenAccessPdf: input.request.filters?.openAccessPdf === true,
        eventStream: input.deps.eventStream,
        pdfRecovered: input.pdfRecovered,
        bibtexEnriched: input.bibtexEnriched,
        fallbackSources: input.fallbackSources,
        currentEnrichmentLogs: input.currentEnrichmentLogs,
        persistedEnrichmentLogs: input.persistedEnrichmentLogs,
        storedCount: input.storedCount,
        newPaperIds: input.newPaperIds,
        aggregationReport: input.aggregationReport,
        requestedQuery: input.requestedQuery,
        queryAttempts: input.queryAttempts,
        corpusQuality: input.corpusQuality,
        governanceWarnings: input.governanceWarnings,
        writeCorpusArtifactsOnProgress: true,
        runContextMemory,
        targetCount,
        processedOffset,
        updatedOffset
      });

      const completionMeta = buildCollectResultMeta({
        collectAttemptId: input.collectAttemptId,
        request: input.request,
        fetched: input.fetchedCount,
        stored: enrichmentState.storedCount,
        added: input.newPaperIds.size,
        baseCount: input.baseCount,
        mode: input.mode,
        diagnostics: input.diagnostics,
        filters: input.request.filters || {},
        bibtexMode: input.bibtexMode,
        completed: true,
        pdfRecovered: enrichmentState.pdfRecovered,
        bibtexEnriched: enrichmentState.bibtexEnriched,
        aggregationReport: input.aggregationReport,
        enrichmentAttempts: countEnrichmentAttempts(input.currentEnrichmentLogs),
        fallbackSources: Array.from(input.fallbackSources),
        requestedQuery: input.requestedQuery,
        queryAttempts: input.queryAttempts,
        corpusQuality: input.corpusQuality,
        governanceWarnings: input.governanceWarnings,
        enrichment: {
          blocking: false,
          status: "completed",
          targetCount,
          processedCount: Math.min(targetCount, processedOffset + enrichmentState.processedCount),
          attemptedCount: Math.min(targetCount, processedOffset + enrichmentState.processedCount),
          updatedCount: Math.min(targetCount, updatedOffset + enrichmentState.updatedCount)
        }
      });

      const completionSnapshot = await persistCollectSnapshot({
        run: input.run,
        rows: Array.from(input.storedRows.values()),
        mode: input.mode,
        request: input.request,
        resultMeta: completionMeta,
        enrichmentLogs: Array.from(input.persistedEnrichmentLogs.values()),
        bibtexMode: input.bibtexMode,
        aggregationReport: input.aggregationReport
      });
      if (input.collectAttemptId) {
        await archiveCurrentCollectAttempt({
          run: input.run,
          attemptId: input.collectAttemptId,
          status: "quality_gate_passed",
          phase: "enrichment",
          includeTopicDiscoveryArtifacts: Boolean(input.corpusQuality),
          artifactContents: completionSnapshot.artifacts
        });
      }
      await syncCollectRunContext({
        run: input.run,
        runContextMemory,
        request: input.request,
        resultMeta: completionMeta,
        diagnostics: input.diagnostics
      });
      await syncCollectRunRecord({
        runStore: input.deps.runStore,
        runId: input.run.id,
        collectAttemptId: input.collectAttemptId,
        summary: buildCollectSummary(completionMeta),
        replaceLatestSummaryIf: input.pendingSummary
      });
      await writeCollectBackgroundJob(
        input.run,
        buildCollectBackgroundJobRecord({
          runId: input.run.id,
          request: input.request,
          mode: input.mode,
          baseCount: input.baseCount,
          bibtexMode: input.bibtexMode,
          paperIds,
          fetchedCount: input.fetchedCount,
          diagnostics: input.diagnostics,
          newPaperIds: Array.from(input.newPaperIds),
          pendingSummary: input.pendingSummary,
          requestedQuery: input.requestedQuery,
          queryAttempts: input.queryAttempts,
          status: "completed",
          scheduledAt,
          recoveryCount: input.recoveryCount,
          lastRecoveredAt,
          collectAttemptId: input.collectAttemptId,
          corpusFingerprint
        })
      );

      input.deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: input.run.id,
        node: "collect_papers",
        payload: {
          text: `Deferred enrichment finished for ${targetCount} paper(s). PDF recovered ${enrichmentState.pdfRecovered}; BibTeX enriched ${enrichmentState.bibtexEnriched}.`
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureMeta = buildCollectResultMeta({
        collectAttemptId: input.collectAttemptId,
        request: input.request,
        fetched: input.fetchedCount,
        stored: input.storedCount,
        added: input.newPaperIds.size,
        baseCount: input.baseCount,
        mode: input.mode,
        diagnostics: input.diagnostics,
        filters: input.request.filters || {},
        bibtexMode: input.bibtexMode,
        completed: true,
        pdfRecovered: input.pdfRecovered,
        bibtexEnriched: input.bibtexEnriched,
        aggregationReport: input.aggregationReport,
        enrichmentAttempts: countEnrichmentAttempts(input.currentEnrichmentLogs),
        fallbackSources: Array.from(input.fallbackSources),
        requestedQuery: input.requestedQuery,
        queryAttempts: input.queryAttempts,
        corpusQuality: input.corpusQuality,
        governanceWarnings: input.governanceWarnings,
        enrichment: {
          blocking: false,
          status: "failed",
          targetCount,
          processedCount: Math.min(targetCount, processedOffset + input.currentEnrichmentLogs.size),
          attemptedCount: Math.min(targetCount, processedOffset + input.currentEnrichmentLogs.size),
          updatedCount: Math.min(targetCount, updatedOffset),
          lastError: message
        }
      });

      const failureSnapshot = await persistCollectSnapshot({
        run: input.run,
        rows: Array.from(input.storedRows.values()),
        mode: input.mode,
        request: input.request,
        resultMeta: failureMeta,
        enrichmentLogs: Array.from(input.persistedEnrichmentLogs.values()),
        bibtexMode: input.bibtexMode,
        aggregationReport: input.aggregationReport,
        writeCorpusArtifacts: false
      });
      if (input.collectAttemptId) {
        await archiveCurrentCollectAttempt({
          run: input.run,
          attemptId: input.collectAttemptId,
          status: "collection_failed",
          phase: "enrichment",
          includeTopicDiscoveryArtifacts: Boolean(input.corpusQuality),
          artifactContents: failureSnapshot.artifacts
        });
      }
      await syncCollectRunContext({
        run: input.run,
        runContextMemory,
        request: input.request,
        resultMeta: failureMeta,
        diagnostics: input.diagnostics
      });
      await syncCollectRunRecord({
        runStore: input.deps.runStore,
        runId: input.run.id,
        collectAttemptId: input.collectAttemptId,
        summary: buildCollectSummary(failureMeta),
        replaceLatestSummaryIf: input.pendingSummary
      });
      await writeCollectBackgroundJob(
        input.run,
        buildCollectBackgroundJobRecord({
          runId: input.run.id,
          request: input.request,
          mode: input.mode,
          baseCount: input.baseCount,
          bibtexMode: input.bibtexMode,
          paperIds,
          fetchedCount: input.fetchedCount,
          diagnostics: input.diagnostics,
          newPaperIds: Array.from(input.newPaperIds),
          pendingSummary: input.pendingSummary,
          requestedQuery: input.requestedQuery,
          queryAttempts: input.queryAttempts,
          status: "failed",
          scheduledAt,
          recoveryCount: input.recoveryCount,
          lastRecoveredAt,
          lastError: message,
          collectAttemptId: input.collectAttemptId,
          corpusFingerprint
        })
      );

      input.deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: input.run.id,
        node: "collect_papers",
        payload: {
          text: `Deferred enrichment failed: ${message}`
        }
      });
    } finally {
      activeCollectEnrichmentJobs.delete(jobKey);
    }
  })();

  activeCollectEnrichmentJobs.set(jobKey, job);
}

export async function recoverCollectEnrichmentJobs(input: {
  eventStream: Pick<NodeExecutionDeps, "eventStream">["eventStream"];
  runStore: Pick<NodeExecutionDeps, "runStore">["runStore"];
}): Promise<void> {
  const runs = await input.runStore.listRuns();
  for (const run of runs) {
    const job = await readCollectBackgroundJob(run);
    const jobKey = collectEnrichmentJobKey(run.id, job?.collectAttemptId);
    if (!job || job.status !== "running" || activeCollectEnrichmentJobs.has(jobKey)) {
      continue;
    }

    const runRef: CollectRunRef = {
      id: run.id,
      memoryRefs: {
        runContextPath: run.memoryRefs.runContextPath
      }
    };
    const storedCorpus = await readExistingCorpus(run);
    const storedRows = new Map<string, StoredCorpusRow>(
      storedCorpus.map((row) => [row.paper_id, row])
    );
    const persistedEnrichmentLogs = new Map<string, CollectEnrichmentLogEntry>(
      (await readExistingEnrichmentLogs(run)).map((entry) => [entry.paper_id, entry])
    );
    const currentEnrichmentLogs = new Map<string, CollectEnrichmentLogEntry>(persistedEnrichmentLogs);
    const resultMeta = await readCollectResultMeta(run);
    const lineageError = await validateCollectRecoveryLineage({
      run,
      job,
      resultMeta,
      storedRows: storedCorpus
    });
    if (lineageError) {
      await quarantineCollectRecoveryJob({
        run: runRef,
        job,
        reason: lineageError
      });
      input.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: "collect_papers",
        payload: {
          text: `Deferred enrichment recovery was quarantined: ${lineageError}.`
        }
      });
      continue;
    }
    const fallbackSources = new Set(resultMeta?.fallbackSources ?? []);
    const newPaperIds = new Set(job.newPaperIds);
    const processedOffset = Math.max(
      persistedEnrichmentLogs.size,
      Math.min(job.paperIds.length, resultMeta?.enrichment?.processedCount ?? 0)
    );
    const updatedOffset = Math.max(0, resultMeta?.enrichment?.updatedCount ?? 0);
    const pendingPaperIds = job.paperIds.filter((paperId) => !persistedEnrichmentLogs.has(paperId));

    if (resultMeta?.enrichment.status === "completed") {
      await writeCollectBackgroundJob(
        runRef,
        buildCollectBackgroundJobRecord({
          runId: run.id,
          request: job.request,
          mode: job.mode,
          baseCount: job.baseCount,
          bibtexMode: job.bibtexMode,
          paperIds: job.paperIds,
          fetchedCount: job.fetchedCount,
          diagnostics: job.diagnostics,
          newPaperIds: job.newPaperIds,
          pendingSummary: job.pendingSummary,
          requestedQuery: job.requestedQuery,
          queryAttempts: job.queryAttempts,
          status: "completed",
          scheduledAt: job.scheduledAt,
          recoveryCount: job.recoveryCount,
          lastRecoveredAt: job.lastRecoveredAt,
          collectAttemptId: job.collectAttemptId,
          corpusFingerprint: job.corpusFingerprint
        })
      );
      continue;
    }

    if (resultMeta?.enrichment.status === "failed") {
      await writeCollectBackgroundJob(
        runRef,
        buildCollectBackgroundJobRecord({
          runId: run.id,
          request: job.request,
          mode: job.mode,
          baseCount: job.baseCount,
          bibtexMode: job.bibtexMode,
          paperIds: job.paperIds,
          fetchedCount: job.fetchedCount,
          diagnostics: job.diagnostics,
          newPaperIds: job.newPaperIds,
          pendingSummary: job.pendingSummary,
          requestedQuery: job.requestedQuery,
          queryAttempts: job.queryAttempts,
          status: "failed",
          scheduledAt: job.scheduledAt,
          recoveryCount: job.recoveryCount,
          lastRecoveredAt: job.lastRecoveredAt,
          lastError: resultMeta.enrichment.lastError,
          collectAttemptId: job.collectAttemptId,
          corpusFingerprint: job.corpusFingerprint
        })
      );
      continue;
    }

    if (pendingPaperIds.length === 0) {
      const completionMeta = buildCollectResultMeta({
        collectAttemptId: job.collectAttemptId,
        request: job.request,
        fetched: job.fetchedCount,
        stored: storedRows.size,
        added: newPaperIds.size,
        baseCount: job.baseCount,
        mode: job.mode,
        diagnostics: job.diagnostics,
        filters: job.request.filters || {},
        bibtexMode: job.bibtexMode,
        completed: true,
        pdfRecovered: resultMeta?.pdfRecovered ?? 0,
        bibtexEnriched: resultMeta?.bibtexEnriched ?? 0,
        aggregationReport: extractAggregationReport(resultMeta),
        enrichmentAttempts: countEnrichmentAttempts(currentEnrichmentLogs),
        fallbackSources: Array.from(fallbackSources),
        requestedQuery: job.requestedQuery,
        queryAttempts: job.queryAttempts,
        corpusQuality: resultMeta?.corpusQuality,
        governanceWarnings: resultMeta?.governance_warnings,
        enrichment: {
          blocking: false,
          status: "completed",
          targetCount: job.paperIds.length,
          processedCount: processedOffset,
          attemptedCount: processedOffset,
          updatedCount: updatedOffset
        }
      });
      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      const recoveryCompletionSnapshot = await persistCollectSnapshot({
        run: runRef,
        rows: Array.from(storedRows.values()),
        mode: job.mode,
        request: job.request,
        resultMeta: completionMeta,
        enrichmentLogs: Array.from(persistedEnrichmentLogs.values()),
        bibtexMode: job.bibtexMode,
        aggregationReport: extractAggregationReport(resultMeta)
      });
      if (job.collectAttemptId) {
        await archiveCurrentCollectAttempt({
          run: runRef,
          attemptId: job.collectAttemptId,
          status: "quality_gate_passed",
          phase: "recovery",
          includeTopicDiscoveryArtifacts: Boolean(resultMeta?.corpusQuality),
          artifactContents: recoveryCompletionSnapshot.artifacts
        });
      }
      await syncCollectRunContext({
        run: runRef,
        runContextMemory,
        request: job.request,
        resultMeta: completionMeta,
        diagnostics: job.diagnostics
      });
      await syncCollectRunRecord({
        runStore: input.runStore,
        runId: run.id,
        collectAttemptId: job.collectAttemptId,
        summary: buildCollectSummary(completionMeta),
        replaceLatestSummaryIf: job.pendingSummary
      });
      await writeCollectBackgroundJob(
        runRef,
        buildCollectBackgroundJobRecord({
          runId: run.id,
          request: job.request,
          mode: job.mode,
          baseCount: job.baseCount,
          bibtexMode: job.bibtexMode,
          paperIds: job.paperIds,
          fetchedCount: job.fetchedCount,
          diagnostics: job.diagnostics,
          newPaperIds: job.newPaperIds,
          pendingSummary: job.pendingSummary,
          requestedQuery: job.requestedQuery,
          queryAttempts: job.queryAttempts,
          status: "completed",
          scheduledAt: job.scheduledAt,
          recoveryCount: job.recoveryCount,
          lastRecoveredAt: job.lastRecoveredAt,
          collectAttemptId: job.collectAttemptId,
          corpusFingerprint: job.corpusFingerprint
        })
      );
      input.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: "collect_papers",
        payload: {
          text: `Recovered deferred enrichment state after restart; all ${job.paperIds.length} paper(s) were already complete.`
        }
      });
      continue;
    }

    const missingPaperIds = pendingPaperIds.filter((paperId) => !storedRows.has(paperId));
    if (missingPaperIds.length > 0) {
      const message = `Deferred enrichment recovery could not reconstruct ${missingPaperIds.length} queued paper(s): ${missingPaperIds.join(", ")}`;
      const failureMeta = buildCollectResultMeta({
        collectAttemptId: job.collectAttemptId,
        request: job.request,
        fetched: job.fetchedCount,
        stored: storedRows.size,
        added: newPaperIds.size,
        baseCount: job.baseCount,
        mode: job.mode,
        diagnostics: job.diagnostics,
        filters: job.request.filters || {},
        bibtexMode: job.bibtexMode,
        completed: true,
        pdfRecovered: resultMeta?.pdfRecovered ?? 0,
        bibtexEnriched: resultMeta?.bibtexEnriched ?? 0,
        aggregationReport: extractAggregationReport(resultMeta),
        enrichmentAttempts: countEnrichmentAttempts(currentEnrichmentLogs),
        fallbackSources: Array.from(fallbackSources),
        requestedQuery: job.requestedQuery,
        queryAttempts: job.queryAttempts,
        corpusQuality: resultMeta?.corpusQuality,
        governanceWarnings: resultMeta?.governance_warnings,
        enrichment: {
          blocking: false,
          status: "failed",
          targetCount: job.paperIds.length,
          processedCount: processedOffset,
          attemptedCount: processedOffset,
          updatedCount: updatedOffset,
          lastError: message
        }
      });
      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      const recoveryFailureSnapshot = await persistCollectSnapshot({
        run: runRef,
        rows: Array.from(storedRows.values()),
        mode: job.mode,
        request: job.request,
        resultMeta: failureMeta,
        enrichmentLogs: Array.from(persistedEnrichmentLogs.values()),
        bibtexMode: job.bibtexMode,
        aggregationReport: extractAggregationReport(resultMeta),
        writeCorpusArtifacts: false
      });
      if (job.collectAttemptId) {
        await archiveCurrentCollectAttempt({
          run: runRef,
          attemptId: job.collectAttemptId,
          status: "collection_failed",
          phase: "recovery",
          includeTopicDiscoveryArtifacts: Boolean(resultMeta?.corpusQuality),
          artifactContents: recoveryFailureSnapshot.artifacts
        });
      }
      await syncCollectRunContext({
        run: runRef,
        runContextMemory,
        request: job.request,
        resultMeta: failureMeta,
        diagnostics: job.diagnostics
      });
      await syncCollectRunRecord({
        runStore: input.runStore,
        runId: run.id,
        collectAttemptId: job.collectAttemptId,
        summary: buildCollectSummary(failureMeta),
        replaceLatestSummaryIf: job.pendingSummary
      });
      await writeCollectBackgroundJob(
        runRef,
        buildCollectBackgroundJobRecord({
          runId: run.id,
          request: job.request,
          mode: job.mode,
          baseCount: job.baseCount,
          bibtexMode: job.bibtexMode,
          paperIds: job.paperIds,
          fetchedCount: job.fetchedCount,
          diagnostics: job.diagnostics,
          newPaperIds: job.newPaperIds,
          pendingSummary: job.pendingSummary,
          requestedQuery: job.requestedQuery,
          queryAttempts: job.queryAttempts,
          status: "failed",
          scheduledAt: job.scheduledAt,
          recoveryCount: job.recoveryCount,
          lastRecoveredAt: job.lastRecoveredAt,
          lastError: message,
          collectAttemptId: job.collectAttemptId,
          corpusFingerprint: job.corpusFingerprint
        })
      );
      input.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: "collect_papers",
        payload: {
          text: `Deferred enrichment recovery failed: ${message}`
        }
      });
      continue;
    }

    await startDetachedEnrichment({
      deps: input,
      run: runRef,
      request: job.request,
      mode: job.mode,
      baseCount: job.baseCount,
      bibtexMode: job.bibtexMode,
      papers: pendingPaperIds.map((paperId) => reconstructPaperFromStoredRow(storedRows.get(paperId)!)),
      fetchedCount: job.fetchedCount,
      diagnostics: job.diagnostics,
      storedRows,
      pdfRecovered: resultMeta?.pdfRecovered ?? 0,
      bibtexEnriched: resultMeta?.bibtexEnriched ?? 0,
      fallbackSources,
      currentEnrichmentLogs,
      persistedEnrichmentLogs,
      storedCount: storedRows.size,
      newPaperIds,
      pendingSummary: job.pendingSummary,
      aggregationReport: extractAggregationReport(resultMeta),
      requestedQuery: job.requestedQuery,
      queryAttempts: job.queryAttempts,
      corpusQuality: resultMeta?.corpusQuality,
      governanceWarnings: resultMeta?.governance_warnings,
      targetCount: job.paperIds.length,
      processedOffset,
      updatedOffset,
      recoveredFromCrash: true,
      recoveryCount: job.recoveryCount + 1,
      collectAttemptId: job.collectAttemptId
    });
  }
}

async function syncCollectRunRecord(input: {
  runStore: Pick<NodeExecutionDeps["runStore"], "getRun" | "updateRun"> | undefined;
  runId: string;
  collectAttemptId?: string;
  summary: string;
  replaceLatestSummaryIf?: string;
}): Promise<void> {
  await publishForCollectGeneration({
    run: { id: input.runId },
    attemptId: input.collectAttemptId,
    action: async () => syncCollectRunRecordUnsafe(input)
  });
}

async function syncCollectRunRecordUnsafe(input: {
  runStore: Pick<NodeExecutionDeps["runStore"], "getRun" | "updateRun"> | undefined;
  runId: string;
  summary: string;
  replaceLatestSummaryIf?: string;
}): Promise<void> {
  if (
    !input.runStore ||
    typeof input.runStore.getRun !== "function" ||
    typeof input.runStore.updateRun !== "function"
  ) {
    return;
  }

  const run = await input.runStore.getRun(input.runId);
  if (!run) {
    return;
  }

  run.graph.nodeStates.collect_papers = {
    ...run.graph.nodeStates.collect_papers,
    updatedAt: new Date().toISOString(),
    note: input.summary
  };

  if (
    run.currentNode === "collect_papers" ||
    !run.latestSummary ||
    run.latestSummary === input.replaceLatestSummaryIf
  ) {
    run.latestSummary = input.summary;
  }

  await input.runStore.updateRun(run);
}
