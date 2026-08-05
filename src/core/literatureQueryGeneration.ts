import { createHash } from "node:crypto";

import { AutoLabOSEvent, EventStream } from "./events.js";
import { LLMClient } from "./llm/client.js";
import { RunContextMemory } from "./memory/runContextMemory.js";
import {
  buildTopicDiscoveryLiteratureQuery,
  extractLiteratureTermSequence,
  extractResearchBriefTopic,
  hasSemanticScholarSpecialSyntax,
  isSubstantiveTopicDiscoveryAxisTerm,
  normalizeTopicDiscoveryLiteratureQuery,
  parseTopicDiscoveryLiteratureQuery,
  sanitizeSemanticScholarQueryList,
  selectIndependentLiteratureQueries
} from "./runConstraints.js";
import { parseMarkdownRunBriefSections, parseResearchRunMode } from "./runs/runBriefParser.js";
import {
  assessTopicDiscoveryScientificScope,
  bindTopicDiscoveryScopeAnchor,
  buildTopicDiscoveryScopeContract,
  haveSameTopicDiscoveryScopeTerms,
  TopicDiscoveryScientificScopeDiagnostic,
  TopicDiscoveryScopeContract
} from "./topicDiscoveryScopeContract.js";
import {
  buildTopicDiscoveryCandidateFamilySignature,
  normalizeTopicDiscoveryCandidateTerms,
  normalizeTopicDiscoveryScientificTerms,
  TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
  TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
} from "./topicDiscoveryScientificTerms.js";
import { RunRecord } from "../types.js";
import type {
  TopicDiscoveryPriorWorkProbePlanningHint
} from "./collection/topicDiscoveryPriorWorkProbes.js";

const QUERY_PLAN_CACHE_KEY = "collect_papers.llm_query_plan";
const QUERY_PLAN_FEEDBACK_KEY = "collect_papers.llm_query_plan_feedback";
const QUERY_SCOPE_CONTRACT_KEY = "collect_papers.topic_discovery_scope_contract";
const TOPIC_DISCOVERY_QUERY_PLAN_SEMANTICS_VERSION = 4;
const TOPIC_DISCOVERY_QUERY_FEEDBACK_VERSION = 5;
const DEFAULT_LITERATURE_QUERY_TIMEOUT_MS = 20_000;
const MAX_LITERATURE_QUERY_TIMEOUT_MS = 180_000;
const MAX_TOPIC_DISCOVERY_FEEDBACK_TITLES = 18;
const MINIMUM_REPEATED_TITLE_SUPPORTED_FAMILIES = 1;
const MINIMUM_TITLES_PER_SUPPORTED_FAMILY = 2;
const MAXIMUM_ZERO_TITLE_EXPLORATORY_FAMILIES = 1;
const TITLE_SUPPORT_REJECTION_PREFIX =
  "literature_query_plan_candidate_title_support_below_floor:";
const SHARED_ANCHOR_DRIFT_REJECTION_PREFIX =
  "literature_query_plan_shared_anchor_drift:";
const SCIENTIFIC_SCOPE_REJECTION_PREFIX =
  "literature_query_plan_scientific_scope_rejected:";
const PLACEHOLDER_QUERY_TOKENS = new Set([
  "array",
  "assumption",
  "assumptions",
  "boolean",
  "null",
  "number",
  "numbers",
  "object",
  "query",
  "queries",
  "string",
  "strings"
]);
const SMALL_QUERY_FILLER_TOKENS = new Set([
  "a",
  "an",
  "and",
  "are",
  "be",
  "been",
  "being",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "if",
  "improve",
  "improves",
  "improved",
  "improving",
  "in",
  "is",
  "of",
  "on",
  "or",
  "should",
  "the",
  "to",
  "under",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "within",
  "would"
]);
interface StoredLiteratureQueryPlan {
  version: 4;
  termNormalizationVersion: typeof TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION;
  candidateRecallSemanticsVersion: typeof TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION;
  plannerIdentity: string;
  fingerprint: string;
  plan: GeneratedLiteratureQueries;
  attemptDiagnostics?: LiteratureQueryPlanAttemptDiagnostic[];
  repairDiagnostic?: LiteratureQueryPlanRepairDiagnostic;
  scientificScopeContract?: TopicDiscoveryScopeContract;
  scientificScopeDiagnostic?: TopicDiscoveryScientificScopeDiagnostic;
  updatedAt: string;
}

interface StoredLiteratureQueryPlanFeedback extends LiteratureQueryPlanFeedback {
  version: 5;
  termNormalizationVersion: typeof TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION;
  candidateRecallSemanticsVersion: typeof TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION;
  updatedAt: string;
}

interface StoredTopicDiscoveryScopeContract extends TopicDiscoveryScopeContract {
  updatedAt: string;
}

export interface GeneratedLiteratureQueries {
  source: "llm" | "llm_bounded_repair";
  queries: string[];
  assumptions: string[];
  topicDiscoveryPlan?: GeneratedTopicDiscoveryPlan;
}

export interface GeneratedTopicDiscoveryPlan {
  version: 4;
  termNormalizationVersion: typeof TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION;
  candidateRecallSemanticsVersion: typeof TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION;
  sharedAnchorTerms: string[];
  families: GeneratedTopicDiscoveryFamily[];
}

export type TopicDiscoveryContributionIntent =
  | "method"
  | "measurement"
  | "dataset_or_benchmark"
  | "empirical_finding"
  | "theory"
  | "reproducibility";

export interface GeneratedTopicDiscoveryFamily {
  id: string;
  query: string;
  axisTerms: string[];
  lens: string;
  contributionIntent: TopicDiscoveryContributionIntent;
  contractSource: "planner_declared" | "bounded_inference";
}

export interface LiteratureQueryFamilyFeedback {
  queryFamily?: string;
  query: string;
  axisTerms: string[];
  lens?: string;
  contributionIntent?: TopicDiscoveryContributionIntent;
  contractSource?: "planner_declared" | "bounded_inference";
  contractFingerprint?: string;
  relevantPaperCount?: number;
}

export interface SupportedLiteratureQueryFamilyFeedback
  extends LiteratureQueryFamilyFeedback {
  relevantPaperCount: number;
}

export type LiteratureQueryPlanAttemptStatus =
  | "accepted"
  | "rejected_structure"
  | "rejected_feedback";

export interface LiteratureQueryPlanAttemptDiagnostic {
  attempt: number;
  status: LiteratureQueryPlanAttemptStatus;
  feedbackFingerprint: string;
  feedback: LiteratureQueryPlanFeedback;
  failureReason?: string;
  usableQueries: string[];
  sharedAnchorTerms: string[];
  scientificScopeDiagnostic?: TopicDiscoveryScientificScopeDiagnostic;
  families: Array<{
    id: string;
    axisTerms: string[];
    query?: string;
    lens?: string;
    contributionIntent?: TopicDiscoveryContributionIntent;
    contractSource?: "planner_declared" | "bounded_inference";
  }>;
}

export type LiteratureQueryPlanRepairDiagnostic =
  | {
      strategy: "remove_non_substantive_then_preserve_axis_boundaries";
      sourceAttempt: number;
      families: Array<{
        id: string;
        originalAxisTerms: string[];
        retainedAxisTerms: string[];
        droppedAxisTerms: string[];
      }>;
    }
  | {
      strategy: "authorize_bounded_unsupported_exploration";
      sourceAttempt: number;
      selectedFamilyIds: string[];
      titleSupport: Array<{ id: string; titles: number }>;
      finalCorpusGateUnchanged: true;
    }
  | {
      strategy: "preserve_executed_family_replace_failed_only";
      sourceAttempt: number;
      preservedQueries: string[];
      replacementFamilyIds: string[];
      finalCorpusGateUnchanged: true;
    }
  | {
      strategy: "explicit_scope_timeout_fallback";
      sourceAttempt: number;
      selectedScopeAxisIds: string[];
      excludedRejectedScopeAxisIds: string[];
      queryabilityTitleSource: "executed_candidates_plus_prior_work_probe_hints";
      finalCorpusGateUnchanged: true;
    }
  | {
      strategy: "explicit_scope_timeout_fallback_rejected";
      sourceAttempt: number;
      selectedScopeAxisIds: string[];
      excludedRejectedScopeAxisIds: string[];
      validationFailureReason: string;
      queryabilityTitleSource: "executed_candidates_plus_prior_work_probe_hints";
      finalCorpusGateUnchanged: true;
    }
  | {
      strategy: "explicit_scope_timeout_fallback_unavailable";
      sourceAttempt: number;
      reason:
        | "scope_contract_not_executable"
        | "insufficient_unused_scope_axes"
        | "no_title_supported_unused_scope_axis"
        | "family_normalization_failed";
      requiredFamilyCount: number;
      eligibleCandidateCount: number;
      titleSupportedCandidateCount: number;
      excludedRejectedScopeAxisIds: string[];
      queryabilityTitleSource: "executed_candidates_plus_prior_work_probe_hints";
      finalCorpusGateUnchanged: true;
    };

interface NormalizedTopicDiscoveryQueryPlan {
  queries: string[];
  plan: GeneratedTopicDiscoveryPlan;
}

export interface LiteratureQueryPlanResolution {
  source: "llm" | "llm_bounded_repair" | "deterministic_fallback";
  queries: string[];
  assumptions: string[];
  topicDiscoveryPlan?: GeneratedTopicDiscoveryPlan;
  failureReason?: string;
  attemptDiagnostics?: LiteratureQueryPlanAttemptDiagnostic[];
  repairDiagnostic?: LiteratureQueryPlanRepairDiagnostic;
  scientificScopeContract?: TopicDiscoveryScopeContract;
  scientificScopeDiagnostic?: TopicDiscoveryScientificScopeDiagnostic;
}

export interface LiteratureQueryPlanFeedback {
  rejectedQueries: string[];
  qualityReasons: string[];
  sharedAnchorTerms: string[];
  candidateTitles: string[];
  queryFamilies: LiteratureQueryFamilyFeedback[];
  supportedQueryFamilies?: SupportedLiteratureQueryFamilyFeedback[];
  scientificScopeFingerprint?: string;
}

export async function recordLiteratureQueryPlanRejection(
  runContextMemory: RunContextMemory,
  feedback: LiteratureQueryPlanFeedback
): Promise<LiteratureQueryPlanFeedback> {
  const incoming = normalizeLiteratureQueryPlanFeedback(feedback);
  const storedExisting = normalizeStoredLiteratureQueryPlanFeedback(
    await runContextMemory.get<StoredLiteratureQueryPlanFeedback>(QUERY_PLAN_FEEDBACK_KEY)
  );
  const existing =
    incoming.scientificScopeFingerprint
    && storedExisting.scientificScopeFingerprint
    && incoming.scientificScopeFingerprint !== storedExisting.scientificScopeFingerprint
      ? normalizeLiteratureQueryPlanFeedback(undefined)
      : storedExisting;
  const incomingContractsByFamilyId = new Map(
    incoming.queryFamilies.flatMap((family) =>
      family.queryFamily && family.contractFingerprint
        ? [[family.queryFamily.toLowerCase(), family.contractFingerprint] as const]
        : []
    )
  );
  const compatibleExistingSupported = (existing.supportedQueryFamilies ?? []).filter(
    (family) => {
      const incomingFingerprint = family.queryFamily
        ? incomingContractsByFamilyId.get(family.queryFamily.toLowerCase())
        : undefined;
      return !incomingFingerprint || incomingFingerprint === family.contractFingerprint;
    }
  );
  const supportedQueryFamilies = mergeLiteratureQueryFamilyFeedback(
    incoming.supportedQueryFamilies ?? [],
    compatibleExistingSupported
  ).filter(
    (family): family is SupportedLiteratureQueryFamilyFeedback =>
      typeof family.relevantPaperCount === "number"
  );
  const supportedQueryKeys = new Set(
    supportedQueryFamilies.map((family) => normalizeQueryForComparison(family.query))
  );
  const next = normalizeLiteratureQueryPlanFeedback({
    rejectedQueries: mergeUniqueStrings(incoming.rejectedQueries, existing.rejectedQueries)
      .filter((query) => !supportedQueryKeys.has(normalizeQueryForComparison(query))),
    qualityReasons: mergeUniqueStrings(incoming.qualityReasons, existing.qualityReasons),
    sharedAnchorTerms: resolveFeedbackAnchorTerms(
      supportedQueryFamilies,
      incoming.sharedAnchorTerms,
      existing.sharedAnchorTerms
    ),
    candidateTitles: mergeCandidateTitleFeedback(
      existing.candidateTitles,
      incoming.candidateTitles
    ),
    queryFamilies: mergeLiteratureQueryFamilyFeedback(
      incoming.queryFamilies,
      existing.queryFamilies
    ),
    supportedQueryFamilies,
    scientificScopeFingerprint:
      incoming.scientificScopeFingerprint
      || existing.scientificScopeFingerprint
  });
  await runContextMemory.put(QUERY_PLAN_CACHE_KEY, null);
  await runContextMemory.put(QUERY_PLAN_FEEDBACK_KEY, {
    version: TOPIC_DISCOVERY_QUERY_FEEDBACK_VERSION,
    termNormalizationVersion: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
    candidateRecallSemanticsVersion: TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
    ...next,
    updatedAt: new Date().toISOString()
  } satisfies StoredLiteratureQueryPlanFeedback);
  return next;
}

export async function clearLiteratureQueryPlanRejection(
  runContextMemory: RunContextMemory
): Promise<void> {
  await runContextMemory.put(QUERY_PLAN_FEEDBACK_KEY, null);
}

interface ResolveGeneratedLiteratureQueriesInput {
  run: RunRecord;
  rawBrief?: string;
  extractedBriefTopic?: string;
  runContextMemory: RunContextMemory;
  llm: LLMClient;
  eventStream?: EventStream;
  node?: AutoLabOSEvent["node"];
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  plannerIdentity?: string;
  priorWorkProbeHints?: TopicDiscoveryPriorWorkProbePlanningHint[];
}

export async function resolveGeneratedLiteratureQueries(
  input: ResolveGeneratedLiteratureQueriesInput
): Promise<LiteratureQueryPlanResolution | undefined> {
  const explicitBriefTopic = extractResearchBriefTopic(input.rawBrief);
  const topicSeed = explicitBriefTopic || input.extractedBriefTopic || input.run.topic;
  if (!topicSeed.trim()) {
    return undefined;
  }

  let feedback = normalizeStoredLiteratureQueryPlanFeedback(
    await input.runContextMemory.get<StoredLiteratureQueryPlanFeedback>(QUERY_PLAN_FEEDBACK_KEY)
  );
  const topicDiscovery = parseResearchRunMode(input.rawBrief || "") === "topic_discovery";
  const freshScientificScopeContract = topicDiscovery
    ? buildTopicDiscoveryScopeContract(input.rawBrief)
    : undefined;
  if (
    freshScientificScopeContract
    && feedback.scientificScopeFingerprint
    && feedback.scientificScopeFingerprint !== freshScientificScopeContract.scopeFingerprint
  ) {
    feedback = normalizeLiteratureQueryPlanFeedback(undefined);
    await input.runContextMemory.put(QUERY_PLAN_FEEDBACK_KEY, null);
  }
  let scientificScopeContract = topicDiscovery
    ? await resolveStoredTopicDiscoveryScopeContract(
        input.runContextMemory,
        freshScientificScopeContract ?? buildTopicDiscoveryScopeContract(input.rawBrief),
        feedback.sharedAnchorTerms
      )
    : undefined;
  if (scientificScopeContract?.queryAnchorTerms.length) {
    feedback = normalizeLiteratureQueryPlanFeedback({
      ...feedback,
      sharedAnchorTerms: scientificScopeContract.queryAnchorTerms
    });
  }
  const plannerIdentity = cleanText(input.plannerIdentity) || "unspecified";
  const priorWorkProbeHints = normalizePriorWorkProbeHints(
    input.priorWorkProbeHints
  );
  const fingerprint = buildLiteratureQueryFingerprint(
    input.run,
    input.rawBrief,
    input.extractedBriefTopic,
    feedback,
    plannerIdentity,
    scientificScopeContract?.contractFingerprint,
    priorWorkProbeHints
  );
  const minimumIndependentQueries = topicDiscovery ? 2 : 1;
  const cached = await input.runContextMemory.get<StoredLiteratureQueryPlan>(QUERY_PLAN_CACHE_KEY);
  if (
    cached?.version === TOPIC_DISCOVERY_QUERY_PLAN_SEMANTICS_VERSION
    && cached.plannerIdentity === plannerIdentity
    && cached.fingerprint === fingerprint
    && cached.plan?.queries?.length
  ) {
    const normalizedCached = normalizeGeneratedLiteratureQueries(
      cached.plan,
      minimumIndependentQueries,
      topicDiscovery
    );
    if (normalizedCached) {
      const cachedScopeDiagnostic = topicDiscovery && scientificScopeContract
        ? assessPlanAgainstScientificScope(
            normalizedCached,
            feedback,
            scientificScopeContract
          )
        : undefined;
      const cachedRejection = topicDiscovery
        ? validateTopicDiscoveryPlanAgainstFeedback(
            normalizedCached,
            feedback,
            cachedScopeDiagnostic
          )
        : undefined;
      if (!cachedRejection) {
        return {
          ...normalizedCached,
          attemptDiagnostics: cached.attemptDiagnostics,
          repairDiagnostic: cached.repairDiagnostic,
          scientificScopeContract,
          scientificScopeDiagnostic:
            cached.scientificScopeDiagnostic ?? cachedScopeDiagnostic
        };
      }
      await input.runContextMemory.put(QUERY_PLAN_CACHE_KEY, null);
    }
  }

  let planningFeedback = feedback;
  const attemptDiagnostics: LiteratureQueryPlanAttemptDiagnostic[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let completionText = "";
    try {
      const completion = await withLiteratureQueryTimeout(
        (signal) =>
          input.llm.complete(
            buildLiteratureQueryPrompt(
              input.run,
              input.rawBrief,
              input.extractedBriefTopic,
              planningFeedback,
              scientificScopeContract,
              priorWorkProbeHints
            ),
            {
              systemPrompt: buildLiteratureQuerySystemPrompt(),
              abortSignal: signal
            }
          ),
        resolveLiteratureQueryTimeoutMs(input.timeoutMs),
        input.abortSignal
      );
      completionText = completion.text;
      const parsedPlan = parseGeneratedLiteratureQueries(
        completion.text,
        minimumIndependentQueries,
        topicDiscovery
      );
      const preserved = topicDiscovery
        ? preserveExecutedSupportedFamilies(
            parsedPlan,
            planningFeedback,
            attempt,
            minimumIndependentQueries
          )
        : undefined;
      const plan = preserved?.plan ?? parsedPlan;
      let scientificScopeDiagnostic = topicDiscovery && scientificScopeContract
        ? assessPlanAgainstScientificScope(
            plan,
            planningFeedback,
            scientificScopeContract
          )
        : undefined;
      const contractRejection = topicDiscovery
        ? validateTopicDiscoveryPlanAgainstFeedback(
            plan,
            planningFeedback,
            scientificScopeDiagnostic
          )
        : undefined;
      if (contractRejection) {
        attemptDiagnostics.push(buildLiteratureQueryPlanAttemptDiagnostic({
          attempt,
          status: "rejected_feedback",
          raw: completion.text,
          plan,
          failureReason: contractRejection,
          feedback: planningFeedback,
          topicDiscovery,
          scientificScopeDiagnostic
        }));
        if (attempt < 2) {
          planningFeedback = buildBoundedReplanFeedback(
            planningFeedback,
            plan,
            contractRejection
          );
          input.eventStream?.emit({
            type: "OBS_RECEIVED",
            runId: input.run.id,
            node: input.node,
            payload: {
              text: `Literature query plan rejected before retrieval; running bounded replan: ${contractRejection}`
            }
          });
          continue;
        }
        if (contractRejection.startsWith(TITLE_SUPPORT_REJECTION_PREFIX)) {
          const repaired = buildBoundedUnsupportedExploratoryPlan(
            plan,
            planningFeedback,
            attempt,
            minimumIndependentQueries
          );
          if (repaired) {
            if (scientificScopeContract) {
              scientificScopeContract = await bindAndPersistTopicDiscoveryScopeContract(
                input.runContextMemory,
                scientificScopeContract,
                repaired.plan.topicDiscoveryPlan?.sharedAnchorTerms ?? []
              );
            }
            const repairedScopeDiagnostic = scientificScopeContract
              ? assessPlanAgainstScientificScope(
                  repaired.plan,
                  planningFeedback,
                  scientificScopeContract
                )
              : undefined;
            await input.runContextMemory.put(QUERY_PLAN_CACHE_KEY, {
              version: TOPIC_DISCOVERY_QUERY_PLAN_SEMANTICS_VERSION,
              termNormalizationVersion: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
              candidateRecallSemanticsVersion: TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
              plannerIdentity,
              fingerprint: buildLiteratureQueryFingerprint(
                input.run,
                input.rawBrief,
                input.extractedBriefTopic,
                feedback,
                plannerIdentity,
                scientificScopeContract?.contractFingerprint,
                priorWorkProbeHints
              ),
              plan: repaired.plan,
              attemptDiagnostics,
              repairDiagnostic: repaired.diagnostic,
              scientificScopeContract,
              scientificScopeDiagnostic: repairedScopeDiagnostic,
              updatedAt: new Date().toISOString()
            } satisfies StoredLiteratureQueryPlan);
            input.eventStream?.emit({
              type: "OBS_RECEIVED",
              runId: input.run.id,
              node: input.node,
              payload: {
                text:
                  "Literature query plan authorized one bounded unsupported exploratory portfolio after two title-support-only rejections; final corpus quality gates remain unchanged."
              }
            });
            return {
              ...repaired.plan,
              attemptDiagnostics,
              repairDiagnostic: repaired.diagnostic,
              scientificScopeContract,
              scientificScopeDiagnostic: repairedScopeDiagnostic
            };
          }
        }
        input.eventStream?.emit({
          type: "OBS_RECEIVED",
          runId: input.run.id,
          node: input.node,
          payload: {
            text: `LLM literature-query fallback: ${contractRejection}`
          }
        });
        return {
          source: "deterministic_fallback",
          queries: [],
          assumptions: [],
          failureReason: contractRejection,
          attemptDiagnostics,
          scientificScopeContract,
          scientificScopeDiagnostic
        };
      }
      attemptDiagnostics.push(buildLiteratureQueryPlanAttemptDiagnostic({
        attempt,
        status: "accepted",
        raw: completion.text,
        plan,
        feedback: planningFeedback,
        topicDiscovery,
        scientificScopeDiagnostic
      }));
      if (scientificScopeContract) {
        scientificScopeContract = await bindAndPersistTopicDiscoveryScopeContract(
          input.runContextMemory,
          scientificScopeContract,
          plan.topicDiscoveryPlan?.sharedAnchorTerms ?? []
        );
        scientificScopeDiagnostic = assessPlanAgainstScientificScope(
          plan,
          planningFeedback,
          scientificScopeContract
        );
      }
      await input.runContextMemory.put(QUERY_PLAN_CACHE_KEY, {
        version: TOPIC_DISCOVERY_QUERY_PLAN_SEMANTICS_VERSION,
        termNormalizationVersion: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
        candidateRecallSemanticsVersion: TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
        plannerIdentity,
        fingerprint: buildLiteratureQueryFingerprint(
          input.run,
          input.rawBrief,
          input.extractedBriefTopic,
          feedback,
          plannerIdentity,
          scientificScopeContract?.contractFingerprint,
          priorWorkProbeHints
        ),
        plan,
        attemptDiagnostics,
        ...(preserved ? { repairDiagnostic: preserved.diagnostic } : {}),
        scientificScopeContract,
        scientificScopeDiagnostic,
        updatedAt: new Date().toISOString()
      });
      return {
        ...plan,
        attemptDiagnostics,
        ...(preserved ? { repairDiagnostic: preserved.diagnostic } : {}),
        scientificScopeContract,
        scientificScopeDiagnostic
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const structuralFailure =
        topicDiscovery && isRetryableTopicDiscoveryPlanningError(message);
      if (structuralFailure) {
        const diagnostic = buildLiteratureQueryPlanAttemptDiagnostic({
          attempt,
          status: "rejected_structure",
          raw: completionText,
          failureReason: message,
          feedback: planningFeedback,
          topicDiscovery
        });
        attemptDiagnostics.push(diagnostic);
        if (attempt < 2) {
          planningFeedback = buildBoundedStructuralReplanFeedback(
            planningFeedback,
            diagnostic,
            message
          );
          input.eventStream?.emit({
            type: "OBS_RECEIVED",
            runId: input.run.id,
            node: input.node,
            payload: {
              text: `Literature query plan failed its structural contract; running bounded replan: ${message}`
            }
          });
          continue;
        }
        const repaired = buildBoundedTopicDiscoveryPlanRepair(
          diagnostic,
          minimumIndependentQueries
        );
        if (repaired) {
          const plan: GeneratedLiteratureQueries = {
            source: "llm_bounded_repair",
            queries: repaired.plan.queries,
            assumptions: [
              "The final LLM query plan was boundedly repaired by removing non-substantive qualifiers and preserving at most three boundary terms per scientific axis."
            ],
            topicDiscoveryPlan: repaired.plan.plan
          };
          let scientificScopeDiagnostic = scientificScopeContract
            ? assessPlanAgainstScientificScope(
                plan,
                planningFeedback,
                scientificScopeContract
              )
            : undefined;
          const repairedContractRejection = validateTopicDiscoveryPlanAgainstFeedback(
            plan,
            planningFeedback,
            scientificScopeDiagnostic
          );
          if (repairedContractRejection) {
            input.eventStream?.emit({
              type: "OBS_RECEIVED",
              runId: input.run.id,
              node: input.node,
              payload: {
                text: `LLM literature-query fallback: ${repairedContractRejection}`
              }
            });
            return {
              source: "deterministic_fallback",
              queries: [],
              assumptions: [],
              failureReason: repairedContractRejection,
              attemptDiagnostics,
              scientificScopeContract,
              scientificScopeDiagnostic
            };
          }
          if (scientificScopeContract) {
            scientificScopeContract = await bindAndPersistTopicDiscoveryScopeContract(
              input.runContextMemory,
              scientificScopeContract,
              plan.topicDiscoveryPlan?.sharedAnchorTerms ?? []
            );
            scientificScopeDiagnostic = assessPlanAgainstScientificScope(
              plan,
              planningFeedback,
              scientificScopeContract
            );
          }
          await input.runContextMemory.put(QUERY_PLAN_CACHE_KEY, {
            version: TOPIC_DISCOVERY_QUERY_PLAN_SEMANTICS_VERSION,
            termNormalizationVersion: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
            candidateRecallSemanticsVersion: TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
            plannerIdentity,
            fingerprint: buildLiteratureQueryFingerprint(
              input.run,
              input.rawBrief,
              input.extractedBriefTopic,
              feedback,
              plannerIdentity,
              scientificScopeContract?.contractFingerprint,
              priorWorkProbeHints
            ),
            plan,
            attemptDiagnostics,
            repairDiagnostic: repaired.diagnostic,
            scientificScopeContract,
            scientificScopeDiagnostic,
            updatedAt: new Date().toISOString()
          } satisfies StoredLiteratureQueryPlan);
          input.eventStream?.emit({
            type: "OBS_RECEIVED",
            runId: input.run.id,
            node: input.node,
            payload: {
              text: "Literature query plan accepted after bounded structural repair; retrieval quality gates remain unchanged."
            }
          });
          return {
            ...plan,
            attemptDiagnostics,
            repairDiagnostic: repaired.diagnostic,
            scientificScopeContract,
            scientificScopeDiagnostic
          };
        }
      }
      const fallbackScopeContract = scientificScopeContract;
      const timeoutFallback =
        topicDiscovery
        && isLiteratureQueryTimeoutFailure(message)
        && fallbackScopeContract
          ? buildDeterministicTopicDiscoveryTimeoutFallback({
              contract: fallbackScopeContract,
              feedback: planningFeedback,
              priorWorkProbeHints,
              minimumIndependentQueries,
              sourceAttempt: attempt
            })
          : undefined;
      if (timeoutFallback?.status === "ready" && fallbackScopeContract) {
        let scientificScopeDiagnostic = assessPlanAgainstScientificScope(
          timeoutFallback.plan,
          timeoutFallback.validationFeedback,
          fallbackScopeContract
        );
        const fallbackRejection = validateTopicDiscoveryPlanAgainstFeedback(
          timeoutFallback.plan,
          timeoutFallback.validationFeedback,
          scientificScopeDiagnostic
        );
        if (!fallbackRejection) {
          scientificScopeContract = await bindAndPersistTopicDiscoveryScopeContract(
            input.runContextMemory,
            fallbackScopeContract,
            timeoutFallback.plan.topicDiscoveryPlan?.sharedAnchorTerms ?? []
          );
          scientificScopeDiagnostic = assessPlanAgainstScientificScope(
            timeoutFallback.plan,
            timeoutFallback.validationFeedback,
            scientificScopeContract
          );
          input.eventStream?.emit({
            type: "OBS_RECEIVED",
            runId: input.run.id,
            node: input.node,
            payload: {
              text:
                "Literature query planner timed out; using a deterministic explicit-scope fallback "
                + "with " + timeoutFallback.plan.queries.length + " unused family/families. "
                + "Prior-work titles affected queryability ranking only; final corpus quality gates remain unchanged."
            }
          });
          return {
            ...timeoutFallback.plan,
            source: "deterministic_fallback",
            repairDiagnostic: timeoutFallback.diagnostic,
            scientificScopeContract,
            scientificScopeDiagnostic
          };
        }
        input.eventStream?.emit({
          type: "OBS_RECEIVED",
          runId: input.run.id,
          node: input.node,
          payload: {
            text:
              "Deterministic explicit-scope timeout fallback was unavailable: "
              + fallbackRejection
          }
        });
        const rejectionDiagnostic: Extract<
          LiteratureQueryPlanRepairDiagnostic,
          { strategy: "explicit_scope_timeout_fallback_rejected" }
        > = {
          strategy: "explicit_scope_timeout_fallback_rejected",
          sourceAttempt: timeoutFallback.diagnostic.sourceAttempt,
          selectedScopeAxisIds:
            timeoutFallback.diagnostic.selectedScopeAxisIds,
          excludedRejectedScopeAxisIds:
            timeoutFallback.diagnostic.excludedRejectedScopeAxisIds,
          validationFailureReason: fallbackRejection,
          queryabilityTitleSource:
            "executed_candidates_plus_prior_work_probe_hints",
          finalCorpusGateUnchanged: true
        };
        return {
          source: "deterministic_fallback",
          queries: [],
          assumptions: [],
          failureReason:
            `${message};explicit_scope_timeout_fallback_rejected:${fallbackRejection}`,
          ...(attemptDiagnostics.length > 0 ? { attemptDiagnostics } : {}),
          repairDiagnostic: rejectionDiagnostic,
          scientificScopeContract,
          scientificScopeDiagnostic
        };
      }
      if (timeoutFallback?.status === "unavailable") {
        const unavailableReason = formatTimeoutFallbackUnavailableReason(
          timeoutFallback.diagnostic
        );
        input.eventStream?.emit({
          type: "OBS_RECEIVED",
          runId: input.run.id,
          node: input.node,
          payload: {
            text:
              `Literature query planner timed out (${message}); deterministic explicit-scope timeout fallback was unavailable: `
              + unavailableReason
          }
        });
        return {
          source: "deterministic_fallback",
          queries: [],
          assumptions: [],
          failureReason: `${message};${unavailableReason}`,
          ...(attemptDiagnostics.length > 0 ? { attemptDiagnostics } : {}),
          repairDiagnostic: timeoutFallback.diagnostic,
          scientificScopeContract
        };
      }
      input.eventStream?.emit({
        type: "OBS_RECEIVED",
        runId: input.run.id,
        node: input.node,
        payload: {
          text: `LLM literature-query fallback: ${message}`
        }
      });
      return {
        source: "deterministic_fallback",
        queries: [],
        assumptions: [],
        failureReason: message,
        ...(attemptDiagnostics.length > 0 ? { attemptDiagnostics } : {}),
        scientificScopeContract
      };
    }
  }
  return {
    source: "deterministic_fallback",
    queries: [],
    assumptions: [],
    failureReason: "literature_query_bounded_replan_exhausted",
    attemptDiagnostics,
    scientificScopeContract
  };
}

function buildLiteratureQuerySystemPrompt(): string {
  return [
    "You are the AutoLabOS literature query planner.",
    "Generate cross-provider scholarly paper-search queries from a research topic.",
    "Keep retrieval concepts separate from execution constraints and publication ambitions.",
    "Return JSON only.",
    "Do not invent a scientific object or problem outside the role-authorized scope contract."
  ].join("\n");
}

function buildLiteratureQueryPrompt(
  run: RunRecord,
  rawBrief: string | undefined,
  extractedBriefTopic: string | undefined,
  feedback: LiteratureQueryPlanFeedback,
  scientificScopeContract?: TopicDiscoveryScopeContract,
  priorWorkProbeHints: TopicDiscoveryPriorWorkProbePlanningHint[] = []
): string {
  const sections = rawBrief ? parseMarkdownRunBriefSections(rawBrief) : undefined;
  const explicitBriefTopic = extractResearchBriefTopic(rawBrief);
  const researchMode = parseResearchRunMode(rawBrief || "");
  const topicDiscovery = researchMode === "topic_discovery";
  const hasPlanningFeedback =
    feedback.rejectedQueries.length > 0
    || feedback.qualityReasons.length > 0
    || feedback.candidateTitles.length > 0
    || feedback.queryFamilies.length > 0
    || (feedback.supportedQueryFamilies?.length ?? 0) > 0;
  return [
    "Return one JSON object with this shape:",
    "{",
    ...(topicDiscovery
      ? [
          '  "shared_anchor": "2 to 3 domain-object terms",',
          '  "families": [{"axis": "2 to 3 substantive terms", "lens": "central relation that qualifies as direct evidence", "contribution_intent": "method|measurement|dataset_or_benchmark|empirical_finding|theory|reproducibility"}],'
        ]
      : ['  "queries": ["string"],']),
    '  "assumptions": ["string"]',
    "}",
    "",
    "Rules:",
    ...(topicDiscovery
      ? [
          "- Return exactly 3 independent families; at least 2 structurally valid families are required.",
          "- shared_anchor must contain only 2 to 3 terms naming one concise domain object likely to occur as a phrase in relevant titles or abstracts.",
          "- Put the target property, gap, validity concern, uncertainty concept, or failure mode in an axis, not in shared_anchor.",
          "- Every axis must contain 2 to 3 terms naming one atomic substantive gap, method, measurement, failure, validity, reliability, or uncertainty concept.",
          "- Every family must declare a concise lens that states what central relationship to the shared anchor would count as direct evidence, plus one contribution_intent enum value.",
          "- The lens must distinguish papers that study the family question directly from papers that merely apply the anchor or mention the axis in an application domain.",
          "- Do not bundle two related concepts, synonyms, or alternatives into one axis; use a compact phrase likely to occur intact in titles or abstracts.",
          "- Build the families from different scientific uncertainties or failure mechanisms named in the brief's source material; do not turn venue, budget, execution, or contribution language into a family.",
          "- Use plain literature vocabulary only. Do not put Boolean operators, quotes, exclusions, full questions, or execution constraints in shared_anchor or axis.",
          "- An axis made only from resource, runtime, hardware, local-execution, reproducibility, publication, or workflow qualifiers is invalid; express the scientific property being measured instead.",
          "- Generic genre or positioning words such as empirical, evaluation, benchmark, comparison, contribution, study, paper, submission, or workshop do not count as a scientific axis by themselves.",
          "- The planner will combine the shared anchor and each axis into provider-specific queries.",
          "- Changing only strictness, word order, exclusions, or near-synonyms does not create an independent family."
        ]
      : [
          "- Return 2 to 4 queries when possible, ordered from most precise to broader fallback.",
          "- Each query should be a concise Semantic Scholar search expression, not a full sentence or research question.",
          "- Prefer 1 to 3 focused concept groups per query instead of a long bag of words.",
          "- Use quoted phrases, parentheses, +, |, and - when they make the query more precise.",
          "- If you naturally think in AND/OR/NOT, convert them into Semantic Scholar bulk-search syntax using +, |, and -.",
          "- Do NOT use field prefixes like title:, abstract:, author:, venue:, or year:.",
          "- Do NOT use wildcard syntax or unsupported advanced search operators beyond quoted phrases, parentheses, +, |, and -."
        ]),
    ...(topicDiscovery && scientificScopeContract
      ? [
          "",
          "Authoritative scientific-scope contract:",
          `- Return this exact brief-declared shared anchor: ${scientificScopeContract.queryAnchorTerms.join(" ") || "unavailable"}.`,
          "- Axis-authority units (each family must retain at least two terms from exactly one unit):",
          ...(scientificScopeContract.axes.length > 0
            ? scientificScopeContract.axes.map((axis) =>
                `  - ${axis.id} [${axis.role}] => ${axis.sourceTerms.join(", ")}`
              )
            : ["  - none; the brief must be strengthened instead of inventing axes"]),
          "- Prior-work probes are a separate closest-prior lane. They may guide later overlap checks but cannot authorize a query-family axis:",
          ...(scientificScopeContract.priorWorkProbes.length > 0
            ? scientificScopeContract.priorWorkProbes.map((probe) =>
                `  - ${probe.id} => ${probe.sourceTerms.join(", ")}`
              )
            : ["  - none"]),
          "- Admissibility constraints, process rules, publication goals, and exclusions are not scientific axis authority.",
          "- Candidate-title matches are queryability hints only; they are not novelty or direct-support evidence."
        ]
      : []),
    ...(topicDiscovery && priorWorkProbeHints.length > 0
      ? [
          "",
          "Separate closest-prior retrieval hints:",
          "- These titles came from brief-declared prior-work probes. Use them only to improve literature vocabulary within the frozen scientific scope.",
          "- They cannot authorize an axis, establish novelty, count as direct support, or enter the evidence corpus.",
          ...priorWorkProbeHints.flatMap((hint) => [
            `  - ${hint.probeId}: ${hint.query}`,
            ...hint.candidateTitles.map((title) => `    - ${title}`)
          ])
        ]
      : []),
    "- Prefer paper-title/abstract terms: method family, task, modality, domain, and benchmark family only when central.",
    "- Avoid generic meta words like research, study, literature review, survey, evaluation, benchmark plan, reproducible, or pipeline unless another axis term names the concrete failure, validity threat, uncertainty source, or method.",
    "- Avoid resource/execution qualifiers such as CPU-only, runtime, memory, local, lightweight, or public datasets unless they are central to the actual paper topic.",
    "- Drop sentence glue such as can, improve, under, and similar question words whenever they are not core search terms.",
    "- If the explicit brief topic is already a good search seed, preserve its core terms but rewrite them into tighter search expressions.",
    ...(hasPlanningFeedback
      ? [
          "",
          "Previous retrieval-plan rejection:",
          `- Rejected queries: ${feedback.rejectedQueries.join(" || ")}`,
          `- Quality failures: ${feedback.qualityReasons.join(" | ") || "unspecified corpus-quality failure"}`,
          `- Previous shared anchor terms: ${feedback.sharedAnchorTerms.join(", ") || "none"}`,
          `- Previous family axes: ${feedback.queryFamilies
            .map((family) =>
              `${family.queryFamily ?? "unidentified"} [${family.contractFingerprint ?? "unbound"}] `
              + `${family.query} => ${family.axisTerms.join(", ") || "none"}; `
              + `lens=${family.lens ?? "missing"}; intent=${family.contributionIntent ?? "missing"}; `
              + `relevant papers=${family.relevantPaperCount ?? "unmeasured"}`
            )
            .join(" || ") || "none"}`,
          `- Executed families that already met the per-family relevance floor: ${(feedback.supportedQueryFamilies ?? [])
            .map((family) =>
              `${family.queryFamily ?? "unidentified"} [${family.contractFingerprint ?? "unbound"}] `
              + `${family.query}; lens=${family.lens ?? "missing"}; `
              + `intent=${family.contributionIntent ?? "missing"} `
              + `(${family.relevantPaperCount} relevant papers)`
            )
            .join(" || ") || "none"}`,
          "- Anchor-proximate candidate titles from the failed retrieval (vocabulary hints only, not accepted evidence):",
          ...(feedback.candidateTitles.length > 0
            ? feedback.candidateTitles.map((title) => `  - ${title}`)
            : ["  - none"]),
          ...(feedback.rejectedQueries.length > 0 && scientificScopeContract?.queryAnchorTerms.length
            ? [
                `- The executed shared anchor is immutable for this recovery generation: return exactly ${scientificScopeContract.queryAnchorTerms.join(" ")}.`
              ]
            : []),
          ...(scientificScopeContract?.enforced
            ? [
                "- Runtime-frozen brief scope axes (id [role] => distinctive source terms):",
                ...scientificScopeContract.axes.map((axis) =>
                  `  - ${axis.id} [${axis.role}] => ${axis.sourceTerms.join(", ")}`
                ),
                "- Every family axis must retain at least two distinctive source terms from exactly one frozen brief axis. Free-form lens wording does not count as scope evidence.",
                "- A one-term technical expansion is eligible only when its complete axis phrase is supported by at least two deduplicated candidate titles; this support establishes queryability only.",
                "- Candidate-title vocabulary may refine a frozen brief axis, but it cannot create a new scientific problem or replace the frozen shared anchor."
              ]
            : feedback.rejectedQueries.length > 0
              ? [
                  "- The brief does not expose enough atomic scientific scope to authorize recovery. Do not invent replacement axes."
                ]
              : []),
          "- Preserve every executed family that already met the relevance floor; revise only failed or missing family slots.",
          "- Produce materially revised replacements. Do not repeat, append meta qualifiers to, or merely loosen the rejected queries.",
          "- Keep the domain anchor concise and give every family at least one distinct literature concept likely to appear in relevant titles or abstracts.",
          "- Replace every structurally invalid or meta-only family with a different scientific uncertainty or failure mechanism; changing one generic word does not repair it.",
          "- Prefer unused concepts from Questions / risks, Dataset / task / bench, Failure conditions, and the observed candidate-title vocabulary when replacing a rejected family.",
          "- Do not cite or summarize the candidate titles; use their recurring technical nouns only to formulate new 2-to-3-term axes.",
          "- When candidate titles are present, at least one family must use an entire axis phrase supported by at least two different titles. At most one additional structurally valid family may be a zero-title exploratory query; the runtime checks this before retrieval."
        ]
      : []),
    ...(topicDiscovery && !scientificScopeContract?.enforced
      ? [
          "",
          "Fallback source material for role classification only; do not turn requirements into scientific axes:",
          formatLiteratureAxisSource("Scientific scope", sections?.scientificScope),
          formatLiteratureAxisSource("Questions / risks", sections?.questionsRisks),
          formatLiteratureAxisSource("Dataset / task / bench", sections?.datasetTaskBench),
          formatLiteratureAxisSource("Failure conditions", sections?.failureConditions),
          formatLiteratureAxisSource("Minimum acceptable evidence", sections?.minimumAcceptableEvidence),
          formatLiteratureAxisSource("Target comparison", sections?.targetComparison),
          formatLiteratureAxisSource("Small-experiment rationale", sections?.whySmallExperiment)
        ]
      : []),
    "",
    `Research mode: ${researchMode}`,
    `Run topic: ${run.topic}`,
    `Explicit brief topic: ${explicitBriefTopic || "none"}`,
    `LLM-extracted brief topic: ${extractedBriefTopic || "none"}`,
    `Objective metric: ${run.objectiveMetric || "none"}`,
    "Constraints:",
    ...(run.constraints.length > 0 ? run.constraints.map((constraint, index) => `${index + 1}. ${constraint}`) : ["none"]),
    sections?.researchQuestion ? `Research question: ${sections.researchQuestion}` : "Research question: none",
    sections?.baselineComparator ? `Baseline / comparator: ${sections.baselineComparator}` : "Baseline / comparator: none"
  ].join("\n");
}

function formatLiteratureAxisSource(label: string, value: string | undefined): string {
  const normalized = cleanText(value);
  if (!normalized) {
    return `- ${label}: none`;
  }
  const maximumLength = 1_600;
  const bounded = normalized.length > maximumLength
    ? `${normalized.slice(0, maximumLength - 3).trimEnd()}...`
    : normalized;
  return `- ${label}: ${bounded}`;
}

function parseGeneratedLiteratureQueries(
  raw: string,
  minimumIndependentQueries: number,
  topicDiscovery: boolean
): GeneratedLiteratureQueries {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    throw new Error("LLM returned no JSON object for literature queries.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `Literature query JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Literature query JSON must decode to an object.");
  }

  const parsedRecord = parsed as Record<string, unknown>;
  const rawQueries = Array.isArray(parsedRecord.queries)
    ? parsedRecord.queries.map((value) => String(value))
    : [];
  const normalizedTopicPlan = topicDiscovery
    ? normalizeTopicDiscoveryQueryPlan(parsedRecord, rawQueries)
    : undefined;
  const candidateQueries = topicDiscovery
    ? normalizedTopicPlan?.queries ?? []
    : selectIndependentLiteratureQueries(
        expandSmallKeywordBundles(sanitizeSemanticScholarQueryList(rawQueries))
          .filter(isUsableSemanticScholarQuery)
          .slice(0, 4),
        4
      );

  if (candidateQueries.length === 0) {
    throw new Error(buildTopicDiscoveryPlanCountError({
      topicDiscovery,
      parsed: parsedRecord,
      count: 0,
      minimum: minimumIndependentQueries
    }));
  }
  if (candidateQueries.length < minimumIndependentQueries) {
    throw new Error(buildTopicDiscoveryPlanCountError({
      topicDiscovery,
      parsed: parsedRecord,
      count: candidateQueries.length,
      minimum: minimumIndependentQueries
    }));
  }
  if (topicDiscovery && !hasValidTopicDiscoveryFamilyStructure(candidateQueries)) {
    throw new Error(
      "LLM topic-discovery queries must share at least two domain-anchor terms and give each family a distinct axis."
    );
  }

  return {
    source: "llm",
    queries: candidateQueries,
    assumptions: normalizeStringArray((parsed as { assumptions?: unknown }).assumptions).slice(0, 4),
    ...(normalizedTopicPlan ? { topicDiscoveryPlan: normalizedTopicPlan.plan } : {})
  };
}

function buildTopicDiscoveryPlanCountError(input: {
  topicDiscovery: boolean;
  parsed: Record<string, unknown>;
  count: number;
  minimum: number;
}): string {
  const base = input.count === 0
    ? "LLM returned no usable Semantic Scholar queries."
    : `LLM returned ${input.count} independent literature query family/families; ${input.minimum} required.`;
  if (!input.topicDiscovery) {
    return base;
  }
  const issues = describeTopicDiscoveryFamilyContractIssues(input.parsed);
  return issues.length > 0
    ? `${base} Family contract issues: ${issues.join("; ")}.`
    : base;
}

function describeTopicDiscoveryFamilyContractIssues(parsed: Record<string, unknown>): string[] {
  const sharedAnchor = cleanText(parsed.shared_anchor ?? parsed.sharedAnchor);
  const sharedAnchorTerms = extractDiagnosticTerms(sharedAnchor, 16);
  const anchorKeys = new Set(sharedAnchorTerms.map((term) => term.toLowerCase()));
  const issues: string[] = [];
  if (sharedAnchorTerms.length < 2 || sharedAnchorTerms.length > 3) {
    issues.push(`shared_anchor has ${sharedAnchorTerms.length} terms (requires 2-3)`);
  }

  const familyValues = Array.isArray(parsed.families)
    ? parsed.families
    : Array.isArray(parsed.query_families)
      ? parsed.query_families
      : [];
  familyValues.forEach((value, index) => {
    if (!value || typeof value !== "object") {
      issues.push(`topic_family_${index + 1} is not an object`);
      return;
    }
    const record = value as Record<string, unknown>;
    const id = normalizeTopicDiscoveryFamilyId(record.id, index);
    const axis = cleanText(record.axis ?? record.gap ?? record.measurement);
    const axisTerms = extractDiagnosticTerms(axis, 16).filter(
      (term) => !anchorKeys.has(term.toLowerCase())
    );
    if (axisTerms.length < 2 || axisTerms.length > 3) {
      issues.push(`${id} has ${axisTerms.length} axis terms (requires 2-3)`);
      return;
    }
    if (!axisTerms.some(isSubstantiveTopicDiscoveryAxisTerm)) {
      issues.push(`${id} has no substantive scientific axis term`);
    }
  });
  return issues.slice(0, 6);
}

function normalizeGeneratedLiteratureQueries(
  value: GeneratedLiteratureQueries,
  minimumIndependentQueries: number,
  topicDiscovery: boolean
): GeneratedLiteratureQueries | undefined {
  const normalizedTopicPlan = topicDiscovery
    ? normalizeStoredTopicDiscoveryPlan(value.topicDiscoveryPlan, value.queries)
    : undefined;
  const queries = topicDiscovery
    ? normalizedTopicPlan?.queries ?? []
    : selectIndependentLiteratureQueries(
        expandSmallKeywordBundles(sanitizeSemanticScholarQueryList(value.queries))
          .filter(isUsableSemanticScholarQuery)
          .slice(0, 4),
        4
      );
  if (
    queries.length < minimumIndependentQueries ||
    (topicDiscovery && !hasValidTopicDiscoveryFamilyStructure(queries))
  ) {
    return undefined;
  }
  return {
    source: value.source === "llm_bounded_repair" ? "llm_bounded_repair" : "llm",
    queries,
    assumptions: normalizeStringArray(value.assumptions).slice(0, 4),
    ...(normalizedTopicPlan ? { topicDiscoveryPlan: normalizedTopicPlan.plan } : {})
  };
}

function preserveExecutedSupportedFamilies(
  plan: GeneratedLiteratureQueries,
  feedback: LiteratureQueryPlanFeedback,
  sourceAttempt: number,
  minimumIndependentQueries: number
): {
  plan: GeneratedLiteratureQueries;
  diagnostic: LiteratureQueryPlanRepairDiagnostic;
} | undefined {
  const supportedFeedback = feedback.supportedQueryFamilies ?? [];
  if (supportedFeedback.length === 0 || !plan.topicDiscoveryPlan) {
    return undefined;
  }
  const parsedSupported = supportedFeedback.flatMap((family) => {
    const parsed = parseTopicDiscoveryLiteratureQuery(family.query);
    const inferredContract = inferTopicDiscoveryFamilyContract(
      parsed?.axisTerms.join(" ") ?? ""
    );
    return parsed
      ? [{
          id: resolveStableFeedbackFamilyId(family),
          query: parsed.query,
          sharedAnchorTerms: parsed.sharedAnchorTerms,
          axisTerms: parsed.axisTerms,
          lens: family.lens ?? inferredContract.lens,
          contributionIntent:
            family.contributionIntent ?? inferredContract.contributionIntent,
          contractSource:
            family.contractSource ?? inferredContract.contractSource
        }]
      : [];
  });
  const sharedAnchorTerms = parsedSupported[0]?.sharedAnchorTerms ?? [];
  const compatibleSupported = parsedSupported.filter((family) =>
    haveSameNormalizedTerms(family.sharedAnchorTerms, sharedAnchorTerms)
  );
  if (compatibleSupported.length === 0) {
    return undefined;
  }
  const supportedQueryKeys = new Set(
    compatibleSupported.map((family) => normalizeQueryForComparison(family.query))
  );
  const replacements = plan.topicDiscoveryPlan.families.flatMap((family) => {
    const query = buildTopicDiscoveryLiteratureQuery(
      sharedAnchorTerms.join(" "),
      family.axisTerms.join(" ")
    );
    const parsed = parseTopicDiscoveryLiteratureQuery(query);
    if (!parsed || supportedQueryKeys.has(normalizeQueryForComparison(parsed.query))) {
      return [];
    }
    return [{
      id: family.id,
      query: parsed.query,
      sharedAnchorTerms: parsed.sharedAnchorTerms,
      axisTerms: parsed.axisTerms,
      lens: family.lens,
      contributionIntent: family.contributionIntent,
      contractSource: family.contractSource
    }];
  });
  const selected: Array<GeneratedTopicDiscoveryFamily & { sharedAnchorTerms: string[] }> = [];
  for (const family of [...compatibleSupported, ...replacements]) {
    if (selected.some((candidate) =>
      areTopicDiscoveryAxesInSameFamily(candidate.axisTerms, family.axisTerms)
    )) {
      continue;
    }
    selected.push(family);
    if (selected.length >= 3) {
      break;
    }
  }
  const normalized = selectNormalizedTopicDiscoveryFamilies(selected);
  if (!normalized || normalized.queries.length < minimumIndependentQueries) {
    return undefined;
  }
  const preservedQueries = normalized.queries.filter((query) =>
    supportedQueryKeys.has(normalizeQueryForComparison(query))
  );
  if (preservedQueries.length !== compatibleSupported.length) {
    return undefined;
  }
  return {
    plan: {
      source: "llm_bounded_repair",
      queries: normalized.queries,
      assumptions: mergeUniqueStrings(plan.assumptions, [
        "Query families that met the executed per-family relevance floor were preserved; only failed family slots were replaced."
      ]).slice(0, 4),
      topicDiscoveryPlan: normalized.plan
    },
    diagnostic: {
      strategy: "preserve_executed_family_replace_failed_only",
      sourceAttempt,
      preservedQueries,
      replacementFamilyIds: normalized.plan.families
        .filter((family) =>
          !supportedQueryKeys.has(normalizeQueryForComparison(family.query))
        )
        .map((family) => family.id),
      finalCorpusGateUnchanged: true
    }
  };
}

function buildBoundedTopicDiscoveryPlanRepair(
  diagnostic: LiteratureQueryPlanAttemptDiagnostic,
  minimumIndependentQueries: number
): {
  plan: NormalizedTopicDiscoveryQueryPlan;
  diagnostic: LiteratureQueryPlanRepairDiagnostic;
} | undefined {
  const sharedAnchorTerms = [...diagnostic.sharedAnchorTerms];
  if (sharedAnchorTerms.length < 2 || sharedAnchorTerms.length > 3) {
    return undefined;
  }
  const anchorKeys = new Set(sharedAnchorTerms.map((term) => term.toLowerCase()));
  const repairFamilies: Extract<
    LiteratureQueryPlanRepairDiagnostic,
    { strategy: "remove_non_substantive_then_preserve_axis_boundaries" }
  >["families"] = [];
  const normalizedFamilies = diagnostic.families.flatMap((family) => {
    const originalAxisTerms = [...new Set(
      family.axisTerms
        .map((term) => cleanText(term).toLowerCase())
        .filter(Boolean)
        .filter((term) => !anchorKeys.has(term))
    )];
    const substantiveTerms = originalAxisTerms.filter(isSubstantiveTopicDiscoveryAxisTerm);
    if (substantiveTerms.length < 2) {
      return [];
    }
    const retainedAxisTerms = substantiveTerms.length <= 3
      ? substantiveTerms
      : [...substantiveTerms.slice(0, 2), substantiveTerms.at(-1) as string];
    const query = buildTopicDiscoveryLiteratureQuery(
      sharedAnchorTerms.join(" "),
      retainedAxisTerms.join(" ")
    );
    const parsedQuery = parseTopicDiscoveryLiteratureQuery(query);
    if (!parsedQuery) {
      return [];
    }
    const retainedKeys = new Set(retainedAxisTerms);
    repairFamilies.push({
      id: family.id,
      originalAxisTerms,
      retainedAxisTerms,
      droppedAxisTerms: originalAxisTerms.filter((term) => !retainedKeys.has(term))
    });
    return [{
      id: family.id,
      query: parsedQuery.query,
      sharedAnchorTerms: parsedQuery.sharedAnchorTerms,
      axisTerms: parsedQuery.axisTerms,
      ...(family.lens && family.contributionIntent && family.contractSource
        ? {
            lens: family.lens,
            contributionIntent: family.contributionIntent,
            contractSource: family.contractSource
          }
        : inferTopicDiscoveryFamilyContract(parsedQuery.axisTerms.join(" ")))
    }];
  });
  const plan = selectNormalizedTopicDiscoveryFamilies(normalizedFamilies);
  if (!plan || plan.queries.length < minimumIndependentQueries) {
    return undefined;
  }
  return {
    plan,
    diagnostic: {
      strategy: "remove_non_substantive_then_preserve_axis_boundaries",
      sourceAttempt: diagnostic.attempt,
      families: repairFamilies.filter((family) =>
        plan.plan.families.some((selected) => selected.id === family.id)
      )
    }
  };
}

function buildDeterministicTopicDiscoveryTimeoutFallback(input: {
  contract: TopicDiscoveryScopeContract;
  feedback: LiteratureQueryPlanFeedback;
  priorWorkProbeHints: TopicDiscoveryPriorWorkProbePlanningHint[];
  minimumIndependentQueries: number;
  sourceAttempt: number;
}):
  | {
      status: "ready";
      plan: GeneratedLiteratureQueries;
      diagnostic: Extract<
        LiteratureQueryPlanRepairDiagnostic,
        { strategy: "explicit_scope_timeout_fallback" }
      >;
      validationFeedback: LiteratureQueryPlanFeedback;
    }
  | {
      status: "unavailable";
      diagnostic: Extract<
        LiteratureQueryPlanRepairDiagnostic,
        { strategy: "explicit_scope_timeout_fallback_unavailable" }
      >;
    } {
  const unavailable = (
    reason: Extract<
      LiteratureQueryPlanRepairDiagnostic,
      { strategy: "explicit_scope_timeout_fallback_unavailable" }
    >["reason"],
    details: {
      eligibleCandidateCount?: number;
      titleSupportedCandidateCount?: number;
      excludedRejectedScopeAxisIds?: string[];
    } = {}
  ) => ({
    status: "unavailable" as const,
    diagnostic: {
      strategy: "explicit_scope_timeout_fallback_unavailable" as const,
      sourceAttempt: input.sourceAttempt,
      reason,
      requiredFamilyCount: input.minimumIndependentQueries,
      eligibleCandidateCount: details.eligibleCandidateCount ?? 0,
      titleSupportedCandidateCount: details.titleSupportedCandidateCount ?? 0,
      excludedRejectedScopeAxisIds:
        details.excludedRejectedScopeAxisIds ?? [],
      queryabilityTitleSource:
        "executed_candidates_plus_prior_work_probe_hints" as const,
      finalCorpusGateUnchanged: true as const
    }
  });
  if (
    !input.contract.enforced
    || input.contract.contractSource !== "explicit_scientific_scope"
    || input.contract.sharedAnchorTerms.length < 2
    || input.contract.sharedAnchorTerms.length > 3
  ) {
    return unavailable("scope_contract_not_executable");
  }
  const queryabilityTitles = mergeCandidateTitleFeedback(
    input.feedback.candidateTitles,
    input.priorWorkProbeHints.flatMap((hint) => hint.candidateTitles)
  );
  const rejectedQueryKeys = new Set(
    input.feedback.rejectedQueries
      .map(normalizeQueryForComparison)
      .filter(Boolean)
  );
  const rejectedAxisTerms = [
    ...input.feedback.rejectedQueries.flatMap((query) => {
      const parsed = parseTopicDiscoveryLiteratureQuery(query);
      return parsed ? [parsed.axisTerms] : [];
    }),
    ...input.feedback.queryFamilies.flatMap((family) =>
      rejectedQueryKeys.has(normalizeQueryForComparison(family.query))
        ? [normalizeTopicDiscoveryScientificTerms(family.axisTerms.join(" "))]
        : []
    )
  ];
  const anchorTerms = new Set(
    normalizeTopicDiscoveryScientificTerms(
      input.contract.sharedAnchorTerms.join(" ")
    )
  );
  const unitsByHash = new Map(
    input.contract.units.map((unit) => [unit.sourceTextSha256, unit] as const)
  );
  const excludedRejectedScopeAxisIds: string[] = [];
  const candidates = input.contract.axes.flatMap((axis, index) => {
    const normalizedSourceTerms = [
      ...new Set(normalizeTopicDiscoveryScientificTerms(axis.sourceTerms.join(" ")))
    ].filter((term) => !anchorTerms.has(term));
    if (
      rejectedAxisTerms.some((rejectedTerms) =>
        rejectedTerms.length >= 2
        && rejectedTerms.every((term) => normalizedSourceTerms.includes(term))
      )
    ) {
      excludedRejectedScopeAxisIds.push(axis.id);
      return [];
    }
    const axisTerms = selectDeterministicScopeAxisTerms(
      normalizedSourceTerms,
      queryabilityTitles
    );
    if (!axisTerms) {
      return [];
    }
    const query = buildTopicDiscoveryLiteratureQuery(
      input.contract.queryAnchorTerms.join(" "),
      axisTerms.join(" ")
    );
    const parsedQuery = parseTopicDiscoveryLiteratureQuery(query);
    if (!parsedQuery) {
      return [];
    }
    const sourceText =
      unitsByHash.get(axis.sourceTextSha256)?.sourceText
      || axisTerms.join(" ");
    return [{
      index,
      scopeAxisId: axis.id,
      titleSupport: countCandidateTitleSupport(
        parsedQuery.axisTerms,
        queryabilityTitles
      ),
      family: {
        id: axis.id,
        query: parsedQuery.query,
        sharedAnchorTerms: parsedQuery.sharedAnchorTerms,
        axisTerms: parsedQuery.axisTerms,
        ...inferTopicDiscoveryFamilyContract(sourceText)
      }
    }];
  });
  const selectedCandidates = candidates
    .sort((left, right) =>
      right.titleSupport - left.titleSupport
      || left.index - right.index
      || left.scopeAxisId.localeCompare(right.scopeAxisId)
    )
    .slice(0, input.minimumIndependentQueries);
  const titleSupportedCandidateCount = candidates.filter(
    (candidate) => candidate.titleSupport > 0
  ).length;
  if (selectedCandidates.length < input.minimumIndependentQueries) {
    return unavailable("insufficient_unused_scope_axes", {
      eligibleCandidateCount: candidates.length,
      titleSupportedCandidateCount,
      excludedRejectedScopeAxisIds
    });
  }
  if (selectedCandidates.every((candidate) => candidate.titleSupport === 0)) {
    return unavailable("no_title_supported_unused_scope_axis", {
      eligibleCandidateCount: candidates.length,
      titleSupportedCandidateCount,
      excludedRejectedScopeAxisIds
    });
  }
  const normalized = selectNormalizedTopicDiscoveryFamilies(
    selectedCandidates.map((candidate) => candidate.family)
  );
  if (
    !normalized
    || normalized.queries.length < input.minimumIndependentQueries
  ) {
    return unavailable("family_normalization_failed", {
      eligibleCandidateCount: candidates.length,
      titleSupportedCandidateCount,
      excludedRejectedScopeAxisIds
    });
  }
  return {
    status: "ready",
    plan: {
      source: "llm_bounded_repair",
      queries: normalized.queries,
      assumptions: [
        "The LLM query planner timed out, so replacement families were compiled only from unused explicit brief axes.",
        "Prior-work probe titles were used only to rank queryability; semantic review and final corpus quality gates remain unchanged."
      ],
      topicDiscoveryPlan: normalized.plan
    },
    diagnostic: {
      strategy: "explicit_scope_timeout_fallback",
      sourceAttempt: input.sourceAttempt,
      selectedScopeAxisIds: selectedCandidates.map(
        (candidate) => candidate.scopeAxisId
      ),
      excludedRejectedScopeAxisIds,
      queryabilityTitleSource:
        "executed_candidates_plus_prior_work_probe_hints",
      finalCorpusGateUnchanged: true
    },
    validationFeedback: normalizeLiteratureQueryPlanFeedback({
      ...input.feedback,
      candidateTitles: queryabilityTitles
    })
  };
}

function formatTimeoutFallbackUnavailableReason(
  diagnostic: Extract<
    LiteratureQueryPlanRepairDiagnostic,
    { strategy: "explicit_scope_timeout_fallback_unavailable" }
  >
): string {
  return [
    `explicit_scope_timeout_fallback_unavailable:${diagnostic.reason}`,
    `required=${diagnostic.requiredFamilyCount}`,
    `eligible=${diagnostic.eligibleCandidateCount}`,
    `title_supported=${diagnostic.titleSupportedCandidateCount}`,
    `excluded=${diagnostic.excludedRejectedScopeAxisIds.length}`
  ].join(";");
}

function selectDeterministicScopeAxisTerms(
  sourceTerms: string[],
  queryabilityTitles: string[]
): string[] | undefined {
  const genericTerms = new Set(["explicit", "tool", "tools", "versu"]);
  const terms = [...new Set(sourceTerms)]
    .filter(isSubstantiveTopicDiscoveryAxisTerm)
    .filter((term) => !genericTerms.has(term));
  if (terms.length < 2) {
    return undefined;
  }
  const candidates: Array<{
    terms: string[];
    support: number;
    span: number;
    order: number;
  }> = [];
  let order = 0;
  for (const size of [3, 2]) {
    for (let first = 0; first < terms.length; first += 1) {
      for (let second = first + 1; second < terms.length; second += 1) {
        if (size === 2) {
          const selected = [terms[first], terms[second]];
          candidates.push({
            terms: selected,
            support: countCandidateTitleSupport(selected, queryabilityTitles),
            span: second - first,
            order: order++
          });
          continue;
        }
        for (let third = second + 1; third < terms.length; third += 1) {
          const selected = [terms[first], terms[second], terms[third]];
          candidates.push({
            terms: selected,
            support: countCandidateTitleSupport(selected, queryabilityTitles),
            span: third - first,
            order: order++
          });
        }
      }
    }
  }
  return candidates
    .sort((left, right) =>
      right.support - left.support
      || right.terms.length - left.terms.length
      || left.span - right.span
      || left.order - right.order
    )[0]?.terms;
}

function isLiteratureQueryTimeoutFailure(message: string): boolean {
  return /^literature_query_timeout_after_\d+ms$/u.test(message);
}

function buildBoundedUnsupportedExploratoryPlan(
  plan: GeneratedLiteratureQueries,
  feedback: LiteratureQueryPlanFeedback,
  sourceAttempt: number,
  minimumIndependentQueries: number
): {
  plan: GeneratedLiteratureQueries;
  diagnostic: LiteratureQueryPlanRepairDiagnostic;
} | undefined {
  const topicPlan = plan.topicDiscoveryPlan;
  if (!topicPlan) {
    return undefined;
  }
  const selectedCount = Math.max(2, minimumIndependentQueries);
  if (topicPlan.families.length < selectedCount) {
    return undefined;
  }
  const titleSupport = topicPlan.families.map((family, index) => ({
    family,
    index,
    executedSupport: (feedback.supportedQueryFamilies ?? []).some(
      (supported) =>
        normalizeQueryForComparison(supported.query) ===
        normalizeQueryForComparison(family.query)
    ),
    titles: countCandidateTitleSupport(
      family.axisTerms,
      feedback.candidateTitles
    )
  }));
  const selected = [...titleSupport]
    .sort((left, right) =>
      Number(right.executedSupport) - Number(left.executedSupport)
      || right.titles - left.titles
      || left.index - right.index
    )
    .slice(0, selectedCount);
  const selectedFamilies = selected.map(({ family }) => family);
  const repairedPlan: GeneratedLiteratureQueries = {
    source: "llm_bounded_repair",
    queries: selectedFamilies.map((family) => family.query),
    assumptions: mergeUniqueStrings(plan.assumptions, [
      "This single bounded exploratory portfolio lacked repeated title support after two structured attempts and remains subject to the unchanged final corpus quality gate."
    ]).slice(0, 4),
    topicDiscoveryPlan: {
      version: TOPIC_DISCOVERY_QUERY_PLAN_SEMANTICS_VERSION,
      termNormalizationVersion: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
      candidateRecallSemanticsVersion: TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
      sharedAnchorTerms: [...topicPlan.sharedAnchorTerms],
      families: selectedFamilies.map((family) => ({
        id: family.id,
        query: family.query,
        axisTerms: [...family.axisTerms],
        lens: family.lens,
        contributionIntent: family.contributionIntent,
        contractSource: family.contractSource
      }))
    }
  };
  return {
    plan: repairedPlan,
    diagnostic: {
      strategy: "authorize_bounded_unsupported_exploration",
      sourceAttempt,
      selectedFamilyIds: selectedFamilies.map((family) => family.id),
      titleSupport: titleSupport.map(({ family, titles }) => ({ id: family.id, titles })),
      finalCorpusGateUnchanged: true
    }
  };
}

function normalizeTopicDiscoveryQueryPlan(
  parsed: Record<string, unknown>,
  legacyQueries: string[]
): NormalizedTopicDiscoveryQueryPlan | undefined {
  const sharedAnchor = cleanText(parsed.shared_anchor ?? parsed.sharedAnchor);
  const familyValues = Array.isArray(parsed.families)
    ? parsed.families
    : Array.isArray(parsed.query_families)
      ? parsed.query_families
      : [];
  const structuredFamilies = familyValues.flatMap((value, index) => {
    if (!value || typeof value !== "object") {
      return [];
    }
    const family = value as Record<string, unknown>;
    const axis = cleanText(family.axis ?? family.gap ?? family.measurement);
    const query = buildTopicDiscoveryLiteratureQuery(sharedAnchor, axis);
    const parsedQuery = parseTopicDiscoveryLiteratureQuery(query);
    if (!parsedQuery) {
      return [];
    }
    const contract = normalizeTopicDiscoveryFamilyContract(family, axis);
    return [{
          id: normalizeTopicDiscoveryFamilyId(family.id, index),
          query: parsedQuery.query,
          sharedAnchorTerms: parsedQuery.sharedAnchorTerms,
          axisTerms: parsedQuery.axisTerms,
          ...contract
        }];
  });
  const sourceFamilies = structuredFamilies.length > 0
    ? structuredFamilies
    : sanitizeSemanticScholarQueryList(legacyQueries).flatMap((query, index) => {
        const parsedQuery = parseTopicDiscoveryLiteratureQuery(query);
        return parsedQuery
          ? [{
              id: normalizeTopicDiscoveryFamilyId(undefined, index),
              ...parsedQuery,
              ...inferTopicDiscoveryFamilyContract(parsedQuery.axisTerms.join(" "))
            }]
          : [];
      });
  return selectNormalizedTopicDiscoveryFamilies(sourceFamilies);
}

function normalizeStoredTopicDiscoveryPlan(
  plan: GeneratedTopicDiscoveryPlan | undefined,
  legacyQueries: string[]
): NormalizedTopicDiscoveryQueryPlan | undefined {
  if (
    plan?.version === TOPIC_DISCOVERY_QUERY_PLAN_SEMANTICS_VERSION
    && plan.sharedAnchorTerms?.length
    && Array.isArray(plan.families)
  ) {
    const sharedAnchor = plan.sharedAnchorTerms.join(" ");
    const families = plan.families.flatMap((family, index) => {
      const query = buildTopicDiscoveryLiteratureQuery(
        sharedAnchor,
        Array.isArray(family.axisTerms) ? family.axisTerms.join(" ") : ""
      );
      const parsedQuery = parseTopicDiscoveryLiteratureQuery(query);
      return parsedQuery
        && cleanText(family.lens)
        && isTopicDiscoveryContributionIntent(family.contributionIntent)
        && (family.contractSource === "planner_declared" || family.contractSource === "bounded_inference")
        ? [{
            id: normalizeTopicDiscoveryFamilyId(family.id, index),
            query: parsedQuery.query,
            sharedAnchorTerms: parsedQuery.sharedAnchorTerms,
            axisTerms: parsedQuery.axisTerms,
            lens: cleanText(family.lens),
            contributionIntent: family.contributionIntent,
            contractSource: family.contractSource
          }]
        : [];
    });
    const normalized = selectNormalizedTopicDiscoveryFamilies(families);
    if (normalized) {
      return normalized;
    }
  }
  return normalizeTopicDiscoveryQueryPlan({}, legacyQueries);
}

function selectNormalizedTopicDiscoveryFamilies(
  families: Array<GeneratedTopicDiscoveryFamily & { sharedAnchorTerms: string[] }>
): NormalizedTopicDiscoveryQueryPlan | undefined {
  const selectedFamilies: Array<GeneratedTopicDiscoveryFamily & { sharedAnchorTerms: string[] }> = [];
  for (const family of families) {
    if (
      selectedFamilies.some((selected) =>
        areTopicDiscoveryAxesInSameFamily(selected.axisTerms, family.axisTerms)
      )
    ) {
      continue;
    }
    selectedFamilies.push(family);
    if (selectedFamilies.length >= 4) {
      break;
    }
  }
  const firstAnchor = selectedFamilies[0]?.sharedAnchorTerms ?? [];
  if (
    selectedFamilies.length === 0 ||
    firstAnchor.length < 2 ||
    !selectedFamilies.every((family) => haveSameNormalizedTerms(family.sharedAnchorTerms, firstAnchor))
  ) {
    return undefined;
  }
  const usedIds = new Set<string>();
  const normalizedFamilies = selectedFamilies.map((family, index) => {
    let id = normalizeTopicDiscoveryFamilyId(family.id, index);
    if (usedIds.has(id)) {
      id = `topic_family_${index + 1}`;
    }
    usedIds.add(id);
    return {
      id,
      query: family.query,
      axisTerms: [...family.axisTerms],
      lens: family.lens,
      contributionIntent: family.contributionIntent,
      contractSource: family.contractSource
    };
  });
  return {
    queries: normalizedFamilies.map((family) => family.query),
    plan: {
      version: TOPIC_DISCOVERY_QUERY_PLAN_SEMANTICS_VERSION,
      termNormalizationVersion: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
      candidateRecallSemanticsVersion: TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
      sharedAnchorTerms: [...firstAnchor],
      families: normalizedFamilies
    }
  };
}

function areTopicDiscoveryAxesInSameFamily(left: string[], right: string[]): boolean {
  return buildTopicDiscoveryCandidateFamilySignature({ axisTerms: left })
    === buildTopicDiscoveryCandidateFamilySignature({ axisTerms: right });
}

function normalizeTopicDiscoveryFamilyId(value: unknown, index: number): string {
  const normalized = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  return normalized || `topic_family_${index + 1}`;
}

function haveSameNormalizedTerms(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((term) => rightSet.has(term));
}

function hasValidTopicDiscoveryFamilyStructure(queries: string[]): boolean {
  if (queries.length < 2) {
    return false;
  }
  const parsed = queries.map((query) => parseTopicDiscoveryLiteratureQuery(query));
  if (parsed.some((family) => !family)) {
    return false;
  }
  const families = parsed.filter((family): family is NonNullable<typeof family> => Boolean(family));
  const firstAnchor = families[0]?.sharedAnchorTerms ?? [];
  return (
    firstAnchor.length >= 2 &&
    firstAnchor.length <= 5 &&
    families.every(
      (family) =>
        haveSameNormalizedTerms(family.sharedAnchorTerms, firstAnchor) &&
        family.axisTerms.length >= 2
    ) &&
    families.every(
      (family, index) =>
        families.findIndex((candidate) =>
          areTopicDiscoveryAxesInSameFamily(candidate.axisTerms, family.axisTerms)
        ) === index
    )
  );
}

function buildLiteratureQueryFingerprint(
  run: RunRecord,
  rawBrief: string | undefined,
  extractedBriefTopic: string | undefined,
  feedback: LiteratureQueryPlanFeedback,
  plannerIdentity: string,
  topicDiscoveryScopeContractFingerprint?: string,
  priorWorkProbeHints: TopicDiscoveryPriorWorkProbePlanningHint[] = []
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        topicDiscoveryQueryPlanSemanticsVersion: TOPIC_DISCOVERY_QUERY_PLAN_SEMANTICS_VERSION,
        topicDiscoveryTermNormalizationVersion: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
        topicDiscoveryCandidateRecallSemanticsVersion:
          TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
        topicDiscoveryScopeContractFingerprint:
          topicDiscoveryScopeContractFingerprint ?? "not_applicable",
        plannerIdentity,
        topic: run.topic,
        objectiveMetric: run.objectiveMetric,
        constraints: run.constraints,
        rawBrief: rawBrief || "",
        extractedBriefTopic: extractedBriefTopic || "",
        feedback,
        priorWorkProbeHints
      })
    )
    .digest("hex");
}

function normalizePriorWorkProbeHints(
  value: TopicDiscoveryPriorWorkProbePlanningHint[] | undefined
): TopicDiscoveryPriorWorkProbePlanningHint[] {
  return (value ?? []).flatMap((hint) => {
    const probeId = cleanText(hint.probeId);
    const query = cleanText(hint.query);
    const candidateTitles = mergeUniqueStrings(
      hint.candidateTitles.map(cleanText),
      []
    ).slice(0, 4);
    return probeId && query && candidateTitles.length > 0
      ? [{ probeId, query, candidateTitles }]
      : [];
  }).slice(0, 4);
}

async function resolveStoredTopicDiscoveryScopeContract(
  runContextMemory: RunContextMemory,
  fresh: TopicDiscoveryScopeContract,
  _feedbackAnchorTerms: string[]
): Promise<TopicDiscoveryScopeContract> {
  const stored = await runContextMemory.get<StoredTopicDiscoveryScopeContract>(
    QUERY_SCOPE_CONTRACT_KEY
  );
  const storedContract = stored
    ? (({ updatedAt: _updatedAt, ...contract }) => contract)(stored)
    : undefined;
  const storedMatchesFreshContract =
    stored?.version === fresh.version
    && stored.briefFingerprint === fresh.briefFingerprint
    && stored.scopeFingerprint === fresh.scopeFingerprint
    && stored.contractFingerprint === fresh.contractFingerprint
    && JSON.stringify(storedContract) === JSON.stringify(fresh);

  // The brief is always rebuilt as the authority. Persisted axes and role
  // assignments are audit history, never executable input on resume.
  const contract = fresh;
  if (!storedMatchesFreshContract) {
    await runContextMemory.put(QUERY_SCOPE_CONTRACT_KEY, {
      ...contract,
      updatedAt: new Date().toISOString()
    } satisfies StoredTopicDiscoveryScopeContract);
  }
  return contract;
}

async function bindAndPersistTopicDiscoveryScopeContract(
  runContextMemory: RunContextMemory,
  contract: TopicDiscoveryScopeContract,
  sharedAnchorTerms: string[]
): Promise<TopicDiscoveryScopeContract> {
  const bound = bindTopicDiscoveryScopeAnchor(contract, sharedAnchorTerms);
  if (bound.contractFingerprint !== contract.contractFingerprint) {
    await runContextMemory.put(QUERY_SCOPE_CONTRACT_KEY, {
      ...bound,
      updatedAt: new Date().toISOString()
    } satisfies StoredTopicDiscoveryScopeContract);
  }
  return bound;
}

function normalizeStoredLiteratureQueryPlanFeedback(
  value: StoredLiteratureQueryPlanFeedback | undefined
): LiteratureQueryPlanFeedback {
  return value?.version === TOPIC_DISCOVERY_QUERY_FEEDBACK_VERSION
    ? normalizeLiteratureQueryPlanFeedback(value)
    : normalizeLiteratureQueryPlanFeedback(undefined);
}

function normalizeLiteratureQueryPlanFeedback(
  value: LiteratureQueryPlanFeedback | undefined
): LiteratureQueryPlanFeedback {
  return {
    rejectedQueries: sanitizeSemanticScholarQueryList(value?.rejectedQueries ?? []).slice(0, 4),
    qualityReasons: normalizeStringArray(value?.qualityReasons).slice(0, 4),
    sharedAnchorTerms: normalizeStringArray(value?.sharedAnchorTerms).slice(0, 16),
    candidateTitles: normalizeStringArray(value?.candidateTitles)
      .map((title) => title.slice(0, 240))
      .slice(0, MAX_TOPIC_DISCOVERY_FEEDBACK_TITLES),
    queryFamilies: Array.isArray(value?.queryFamilies)
      ? normalizeLiteratureQueryFamilyFeedback(value.queryFamilies).slice(0, 6)
      : [],
    supportedQueryFamilies: Array.isArray(value?.supportedQueryFamilies)
      ? normalizeLiteratureQueryFamilyFeedback(value.supportedQueryFamilies)
          .filter(
            (family): family is SupportedLiteratureQueryFamilyFeedback =>
              typeof family.relevantPaperCount === "number"
          )
          .slice(0, 3)
      : [],
    scientificScopeFingerprint: cleanText(value?.scientificScopeFingerprint)
      || undefined
  };
}

function normalizeLiteratureQueryFamilyFeedback(
  values: LiteratureQueryFamilyFeedback[]
): LiteratureQueryFamilyFeedback[] {
  return values
    .map((family) => {
      const relevantPaperCount = Number.isFinite(family?.relevantPaperCount)
        ? Math.max(0, Math.floor(family.relevantPaperCount as number))
        : undefined;
      const queryFamily = cleanText(family?.queryFamily).slice(0, 160);
      const lens = cleanText(family?.lens).slice(0, 240);
      const contributionIntent = isTopicDiscoveryContributionIntent(
        family?.contributionIntent
      )
        ? family.contributionIntent
        : undefined;
      const contractSource =
        family?.contractSource === "planner_declared"
        || family?.contractSource === "bounded_inference"
          ? family.contractSource
          : undefined;
      const normalizedFamily: LiteratureQueryFamilyFeedback = {
        ...(queryFamily ? { queryFamily } : {}),
        query: cleanText(family?.query),
        axisTerms: [...new Set(
          normalizeTopicDiscoveryCandidateTerms(
            normalizeStringArray(family?.axisTerms).join(" ")
          )
        )].slice(0, 12),
        ...(lens ? { lens } : {}),
        ...(contributionIntent ? { contributionIntent } : {}),
        ...(contractSource ? { contractSource } : {}),
        ...(relevantPaperCount !== undefined ? { relevantPaperCount } : {})
      };
      return {
        ...normalizedFamily,
        contractFingerprint: buildLiteratureQueryFamilyContractFingerprint(
          normalizedFamily
        )
      };
    })
    .filter((family) => family.query);
}

function mergeLiteratureQueryFamilyFeedback(
  primary: LiteratureQueryFamilyFeedback[],
  secondary: LiteratureQueryFamilyFeedback[]
): LiteratureQueryFamilyFeedback[] {
  const merged: LiteratureQueryFamilyFeedback[] = [];
  const indexByFamily = new Map<string, number>();
  const normalizedPrimary = normalizeLiteratureQueryFamilyFeedback(primary);
  const normalizedSecondary = normalizeLiteratureQueryFamilyFeedback(secondary);
  const primaryContractsByFamilyId = new Map(
    normalizedPrimary.flatMap((family) =>
      family.queryFamily && family.contractFingerprint
        ? [[family.queryFamily.toLowerCase(), family.contractFingerprint] as const]
        : []
    )
  );
  for (const [index, family] of [...normalizedPrimary, ...normalizedSecondary].entries()) {
    if (index >= normalizedPrimary.length && family.queryFamily) {
      const primaryFingerprint = primaryContractsByFamilyId.get(
        family.queryFamily.toLowerCase()
      );
      if (primaryFingerprint && primaryFingerprint !== family.contractFingerprint) {
        continue;
      }
    }
    const key = family.contractFingerprint
      ? `contract:${family.contractFingerprint}`
      : `query:${normalizeQueryForComparison(family.query)}`;
    const existingIndex = indexByFamily.get(key);
    if (existingIndex === undefined) {
      indexByFamily.set(key, merged.length);
      merged.push(family);
      continue;
    }
    const existing = merged[existingIndex];
    if (!existing) {
      continue;
    }
    const relevantPaperCount = Math.max(
      existing.relevantPaperCount ?? -1,
      family.relevantPaperCount ?? -1
    );
    merged[existingIndex] = {
      ...(existing.queryFamily || family.queryFamily
        ? { queryFamily: existing.queryFamily ?? family.queryFamily }
        : {}),
      query: existing.query,
      axisTerms: existing.axisTerms.length > 0 ? existing.axisTerms : family.axisTerms,
      ...(existing.lens || family.lens
        ? { lens: existing.lens ?? family.lens }
        : {}),
      ...(existing.contributionIntent || family.contributionIntent
        ? {
            contributionIntent:
              existing.contributionIntent ?? family.contributionIntent
          }
        : {}),
      ...(existing.contractSource || family.contractSource
        ? { contractSource: existing.contractSource ?? family.contractSource }
        : {}),
      ...(existing.contractFingerprint || family.contractFingerprint
        ? {
            contractFingerprint:
              existing.contractFingerprint ?? family.contractFingerprint
          }
        : {}),
      ...(relevantPaperCount >= 0 ? { relevantPaperCount } : {})
    };
  }
  return merged;
}

function resolveFeedbackAnchorTerms(
  supportedFamilies: SupportedLiteratureQueryFamilyFeedback[],
  incoming: string[],
  existing: string[]
): string[] {
  for (const family of supportedFamilies) {
    const parsed = parseTopicDiscoveryLiteratureQuery(family.query);
    if (parsed?.sharedAnchorTerms.length) {
      return parsed.sharedAnchorTerms;
    }
  }
  return incoming.length > 0 ? incoming : existing;
}

function resolveStableFeedbackFamilyId(
  family: LiteratureQueryFamilyFeedback
): string {
  const explicit = cleanText(family.queryFamily);
  if (explicit) {
    return explicit;
  }
  const digest = createHash("sha256")
    .update(family.contractFingerprint ?? buildLiteratureQueryFamilyContractFingerprint(family))
    .digest("hex")
    .slice(0, 12);
  return `topic_family_${digest}`;
}

function buildLiteratureQueryFamilyContractFingerprint(
  family: Pick<
    LiteratureQueryFamilyFeedback,
    "query" | "axisTerms" | "lens" | "contributionIntent" | "contractSource"
  >
): string {
  const parsed = parseTopicDiscoveryLiteratureQuery(family.query);
  const sharedAnchorTerms = parsed?.sharedAnchorTerms ?? [];
  const axisTerms = family.axisTerms.length > 0
    ? family.axisTerms
    : parsed?.axisTerms ?? [];
  return createHash("sha256")
    .update(JSON.stringify({
      candidate_family_signature: buildTopicDiscoveryCandidateFamilySignature({
        sharedAnchorTerms,
        axisTerms
      }),
      lens_terms: normalizeTopicDiscoveryCandidateTerms(cleanText(family.lens)).sort(),
      contribution_intent: family.contributionIntent ?? "",
      contract_source: family.contractSource ?? ""
    }))
    .digest("hex");
}

function mergeUniqueStrings(primary: string[], secondary: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const value of [...primary, ...secondary]) {
    const normalized = cleanText(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function mergeCandidateTitleFeedback(existing: string[], incoming: string[]): string[] {
  const historical = mergeUniqueStrings(existing, []);
  const latest = mergeUniqueStrings(incoming, []);
  const fullHistory = mergeUniqueStrings(historical, latest);
  if (fullHistory.length <= MAX_TOPIC_DISCOVERY_FEEDBACK_TITLES) {
    return fullHistory;
  }

  const latestKeys = new Set(latest.map((title) => title.toLowerCase()));
  const priorOnly = historical.filter((title) => !latestKeys.has(title.toLowerCase()));
  const latestQuota = Math.min(
    Math.ceil(MAX_TOPIC_DISCOVERY_FEEDBACK_TITLES / 2),
    latest.length
  );
  return mergeUniqueStrings(
    [
      ...latest.slice(0, latestQuota),
      ...priorOnly.slice(0, MAX_TOPIC_DISCOVERY_FEEDBACK_TITLES - latestQuota),
      ...latest.slice(latestQuota)
    ],
    []
  ).slice(0, MAX_TOPIC_DISCOVERY_FEEDBACK_TITLES);
}

function assessPlanAgainstScientificScope(
  plan: GeneratedLiteratureQueries,
  feedback: LiteratureQueryPlanFeedback,
  contract: TopicDiscoveryScopeContract
): TopicDiscoveryScientificScopeDiagnostic {
  return assessTopicDiscoveryScientificScope({
    contract,
    sharedAnchorTerms: plan.topicDiscoveryPlan?.sharedAnchorTerms ?? [],
    families: (plan.topicDiscoveryPlan?.families ?? []).map((family) => ({
      id: family.id,
      axisTerms: family.axisTerms
    })),
    rejectedQueries: feedback.rejectedQueries,
    candidateTitles: feedback.candidateTitles
  });
}

function validateTopicDiscoveryPlanAgainstFeedback(
  plan: GeneratedLiteratureQueries,
  feedback: LiteratureQueryPlanFeedback,
  scientificScopeDiagnostic?: TopicDiscoveryScientificScopeDiagnostic
): string | undefined {
  const lockedAnchorTerms = scientificScopeDiagnostic?.lockedAnchorTerms.length
    ? scientificScopeDiagnostic.lockedAnchorTerms
    : feedback.sharedAnchorTerms;
  if (
    feedback.rejectedQueries.length > 0
    && lockedAnchorTerms.length >= 2
    && plan.topicDiscoveryPlan
    && !haveSameTopicDiscoveryScopeTerms(
      lockedAnchorTerms,
      plan.topicDiscoveryPlan.sharedAnchorTerms
    )
  ) {
    return (
      SHARED_ANCHOR_DRIFT_REJECTION_PREFIX
      + `expected=${lockedAnchorTerms.join("_")}`
      + `;actual=${plan.topicDiscoveryPlan.sharedAnchorTerms.join("_")}`
    );
  }
  if (
    scientificScopeDiagnostic
    && scientificScopeDiagnostic.status !== "passed"
  ) {
    return (
      SCIENTIFIC_SCOPE_REJECTION_PREFIX
      + `anchor=${scientificScopeDiagnostic.anchor.failureReason ?? "passed"}`
      + `[expected:${scientificScopeDiagnostic.anchor.expectedTerms.join("+") || "none"}`
      + `;actual:${scientificScopeDiagnostic.anchor.actualTerms.join("+") || "none"}],`
      + scientificScopeDiagnostic.families
        .filter((family) => !family.passed)
        .map((family) =>
          `${family.id}=${family.failureReason ?? "unbound"}`
          + `[scope:${family.scopeAxisId ?? "none"}`
          + `;retained:${family.retainedSourceTerms.join("+") || "none"}`
          + `;novel:${family.novelTerms.join("+") || "none"}`
          + `;titles:${family.candidateTitleSupport}]`
        )
        .join(",")
      + `;scope=${scientificScopeDiagnostic.scopeFingerprint}`
    );
  }
  if (feedback.rejectedQueries.length === 0) {
    return undefined;
  }
  const rejected = new Set(
    feedback.rejectedQueries.map(normalizeQueryForComparison).filter(Boolean)
  );
  const repeated = plan.queries.filter((query) =>
    rejected.has(normalizeQueryForComparison(query))
  );
  if (repeated.length > 0) {
    return `literature_query_plan_reuses_rejected_families:${repeated.join(" || ")}`;
  }
  if (feedback.candidateTitles.length === 0 || !plan.topicDiscoveryPlan) {
    return undefined;
  }
  const executedSupported = new Set(
    (feedback.supportedQueryFamilies ?? []).map((family) =>
      family.contractFingerprint ?? buildLiteratureQueryFamilyContractFingerprint(family)
    )
  );
  const support = plan.topicDiscoveryPlan.families.map((family) => ({
    id: family.id,
    executed: executedSupported.has(buildLiteratureQueryFamilyContractFingerprint(family)),
    titles: countCandidateTitleSupport(
      family.axisTerms,
      feedback.candidateTitles
    )
  }));
  const supportedFamilies = support.filter(
    (entry) => entry.executed || entry.titles >= MINIMUM_TITLES_PER_SUPPORTED_FAMILY
  ).length;
  const zeroTitleFamilies = support.filter(
    (entry) => !entry.executed && entry.titles === 0
  ).length;
  if (
    supportedFamilies >= MINIMUM_REPEATED_TITLE_SUPPORTED_FAMILIES
    && zeroTitleFamilies <= MAXIMUM_ZERO_TITLE_EXPLORATORY_FAMILIES
  ) {
    return undefined;
  }
  return (
    "literature_query_plan_candidate_title_support_below_floor:"
    + support.map((entry) => `${entry.id}=${entry.titles}`).join(",")
    + `;requires=${MINIMUM_REPEATED_TITLE_SUPPORTED_FAMILIES}_family_x_`
    + `${MINIMUM_TITLES_PER_SUPPORTED_FAMILY}_titles`
    + `;allows=${MAXIMUM_ZERO_TITLE_EXPLORATORY_FAMILIES}_zero_title_exploratory_family`
  );
}

function countCandidateTitleSupport(
  axisTerms: string[],
  candidateTitles: string[]
): number {
  const normalizedAxisTerms = [
    ...new Set(normalizeTopicDiscoveryScientificTerms(axisTerms.join(" ")))
  ];
  if (normalizedAxisTerms.length === 0) {
    return 0;
  }
  return candidateTitles.filter((title) => {
    const titleTerms = new Set(normalizeTopicDiscoveryScientificTerms(title));
    return normalizedAxisTerms.every((term) => titleTerms.has(term));
  }).length;
}

function buildBoundedReplanFeedback(
  feedback: LiteratureQueryPlanFeedback,
  plan: GeneratedLiteratureQueries,
  reason: string
): LiteratureQueryPlanFeedback {
  const supportedKeys = new Set(
    (feedback.supportedQueryFamilies ?? []).map((family) =>
      normalizeQueryForComparison(family.query)
    )
  );
  return normalizeLiteratureQueryPlanFeedback({
    rejectedQueries: [
      ...feedback.rejectedQueries,
      ...plan.queries.filter((query) =>
        !supportedKeys.has(normalizeQueryForComparison(query))
      )
    ],
    qualityReasons: [...feedback.qualityReasons, reason],
    sharedAnchorTerms:
      feedback.sharedAnchorTerms.length >= 2
        ? feedback.sharedAnchorTerms
        : plan.topicDiscoveryPlan?.sharedAnchorTerms ?? feedback.sharedAnchorTerms,
    candidateTitles: feedback.candidateTitles,
    queryFamilies: [
      ...feedback.queryFamilies,
      ...(plan.topicDiscoveryPlan?.families ?? []).map((family) => ({
        queryFamily: family.id,
        query: family.query,
        axisTerms: family.axisTerms,
        lens: family.lens,
        contributionIntent: family.contributionIntent,
        contractSource: family.contractSource
      }))
    ],
    supportedQueryFamilies: feedback.supportedQueryFamilies,
    scientificScopeFingerprint: feedback.scientificScopeFingerprint
  });
}

function buildBoundedStructuralReplanFeedback(
  feedback: LiteratureQueryPlanFeedback,
  diagnostic: LiteratureQueryPlanAttemptDiagnostic,
  reason: string
): LiteratureQueryPlanFeedback {
  return normalizeLiteratureQueryPlanFeedback({
    rejectedQueries: feedback.rejectedQueries,
    qualityReasons: [...feedback.qualityReasons, reason],
    sharedAnchorTerms:
      feedback.sharedAnchorTerms.length >= 2
        ? feedback.sharedAnchorTerms
        : diagnostic.sharedAnchorTerms.length > 0
        ? diagnostic.sharedAnchorTerms
        : feedback.sharedAnchorTerms,
    candidateTitles: feedback.candidateTitles,
    queryFamilies: [
      ...feedback.queryFamilies,
      ...diagnostic.families.map((family) => ({
        queryFamily: family.id,
        query: family.query ?? family.axisTerms.join(" "),
        axisTerms: family.axisTerms,
        lens: family.lens,
        contributionIntent: family.contributionIntent,
        contractSource: family.contractSource
      }))
    ],
    supportedQueryFamilies: feedback.supportedQueryFamilies,
    scientificScopeFingerprint: feedback.scientificScopeFingerprint
  });
}

function isRetryableTopicDiscoveryPlanningError(message: string): boolean {
  return [
    "LLM returned no JSON object for literature queries.",
    "Literature query JSON parse failed:",
    "Literature query JSON must decode to an object.",
    "LLM returned no usable Semantic Scholar queries.",
    "independent literature query family/families",
    "LLM topic-discovery queries must share"
  ].some((marker) => message.includes(marker));
}

function buildLiteratureQueryPlanAttemptDiagnostic(input: {
  attempt: number;
  status: LiteratureQueryPlanAttemptStatus;
  raw: string;
  plan?: GeneratedLiteratureQueries;
  failureReason?: string;
  feedback: LiteratureQueryPlanFeedback;
  topicDiscovery: boolean;
  scientificScopeDiagnostic?: TopicDiscoveryScientificScopeDiagnostic;
}): LiteratureQueryPlanAttemptDiagnostic {
  const feedback = normalizeLiteratureQueryPlanFeedback(input.feedback);
  const feedbackFields = {
    feedbackFingerprint: createHash("sha256")
      .update(JSON.stringify(feedback))
      .digest("hex"),
    feedback
  };
  if (input.plan?.topicDiscoveryPlan) {
    return {
      attempt: input.attempt,
      status: input.status,
      ...feedbackFields,
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      usableQueries: [...input.plan.queries],
      sharedAnchorTerms: [...input.plan.topicDiscoveryPlan.sharedAnchorTerms],
      ...(input.scientificScopeDiagnostic
        ? { scientificScopeDiagnostic: input.scientificScopeDiagnostic }
        : {}),
      families: input.plan.topicDiscoveryPlan.families.map((family) => ({
        id: family.id,
        axisTerms: [...family.axisTerms],
        query: family.query,
        lens: family.lens,
        contributionIntent: family.contributionIntent,
        contractSource: family.contractSource
      }))
    };
  }

  const parsed = parseLiteratureQueryDiagnosticObject(input.raw);
  if (!input.topicDiscovery) {
    const usableQueries = parsed
      ? sanitizeSemanticScholarQueryList(
          Array.isArray(parsed.queries) ? parsed.queries.map(String) : []
        )
      : [];
    return {
      attempt: input.attempt,
      status: input.status,
      ...feedbackFields,
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      usableQueries,
      sharedAnchorTerms: [],
      families: []
    };
  }

  const sharedAnchor = cleanText(parsed?.shared_anchor ?? parsed?.sharedAnchor);
  const sharedAnchorTerms = extractDiagnosticTerms(sharedAnchor, 8);
  const familyValues = Array.isArray(parsed?.families)
    ? parsed.families
    : Array.isArray(parsed?.query_families)
      ? parsed.query_families
      : [];
  const families = familyValues.flatMap((value, index) => {
    if (!value || typeof value !== "object") {
      return [];
    }
    const record = value as Record<string, unknown>;
    const axis = cleanText(record.axis ?? record.gap ?? record.measurement);
    const query = buildTopicDiscoveryLiteratureQuery(sharedAnchor, axis);
    const parsedQuery = query ? parseTopicDiscoveryLiteratureQuery(query) : undefined;
    return [{
      id: normalizeTopicDiscoveryFamilyId(record.id, index),
      axisTerms: parsedQuery?.axisTerms ?? extractDiagnosticTerms(axis, 8),
      ...normalizeTopicDiscoveryFamilyContract(record, axis),
      ...(parsedQuery?.query ? { query: parsedQuery.query } : {})
    }];
  });
  const legacyQueries = Array.isArray(parsed?.queries)
    ? parsed.queries.map(String)
    : [];
  const legacyFamilies = families.length > 0
    ? []
    : legacyQueries.flatMap((query, index) => {
        const normalized = normalizeTopicDiscoveryLiteratureQuery(query);
        const parsedQuery = normalized
          ? parseTopicDiscoveryLiteratureQuery(normalized)
          : undefined;
        return parsedQuery
          ? [{
              id: normalizeTopicDiscoveryFamilyId(undefined, index),
              axisTerms: parsedQuery.axisTerms,
              query: parsedQuery.query,
              ...inferTopicDiscoveryFamilyContract(parsedQuery.axisTerms.join(" "))
            }]
          : [];
      });
  const allFamilies = families.length > 0 ? families : legacyFamilies;
  return {
    attempt: input.attempt,
    status: input.status,
    ...feedbackFields,
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    usableQueries: allFamilies.flatMap((family) => family.query ? [family.query] : []),
    sharedAnchorTerms,
    families: allFamilies
  };
}

function normalizeTopicDiscoveryFamilyContract(
  family: Record<string, unknown>,
  axis: string
): Pick<GeneratedTopicDiscoveryFamily, "lens" | "contributionIntent" | "contractSource"> {
  const lens = cleanText(family.lens);
  const contributionIntent = normalizeTopicDiscoveryContributionIntent(
    family.contribution_intent ?? family.contributionIntent
  );
  if (lens && contributionIntent) {
    return {
      lens: lens.slice(0, 240),
      contributionIntent,
      contractSource: "planner_declared"
    };
  }
  return inferTopicDiscoveryFamilyContract(axis);
}

function inferTopicDiscoveryFamilyContract(
  axis: string
): Pick<GeneratedTopicDiscoveryFamily, "lens" | "contributionIntent" | "contractSource"> {
  const normalizedAxis = cleanText(axis) || "scientific relationship";
  return {
    lens: `Direct investigation of ${normalizedAxis}`.slice(0, 240),
    contributionIntent: inferTopicDiscoveryContributionIntent(normalizedAxis),
    contractSource: "bounded_inference"
  };
}

function normalizeTopicDiscoveryContributionIntent(
  value: unknown
): TopicDiscoveryContributionIntent | undefined {
  const normalized = cleanText(value).toLowerCase();
  return isTopicDiscoveryContributionIntent(normalized) ? normalized : undefined;
}

function isTopicDiscoveryContributionIntent(
  value: unknown
): value is TopicDiscoveryContributionIntent {
  return [
    "method",
    "measurement",
    "dataset_or_benchmark",
    "empirical_finding",
    "theory",
    "reproducibility"
  ].includes(String(value));
}

function inferTopicDiscoveryContributionIntent(axis: string): TopicDiscoveryContributionIntent {
  const terms = new Set(extractLiteratureTermSequence(axis));
  if (["replication", "reproducibility", "reproduce", "repeatability"].some((term) => terms.has(term))) {
    return "reproducibility";
  }
  if (["dataset", "benchmark", "corpus", "annotation"].some((term) => terms.has(term))) {
    return "dataset_or_benchmark";
  }
  if (["method", "algorithm", "architecture", "intervention"].some((term) => terms.has(term))) {
    return "method";
  }
  if (["theory", "mechanism", "causal", "causality"].some((term) => terms.has(term))) {
    return "theory";
  }
  if ([
    "calibration",
    "reliability",
    "validity",
    "uncertainty",
    "stability",
    "variance",
    "power",
    "metric",
    "measurement",
    "ranking"
  ].some((term) => terms.has(term))) {
    return "measurement";
  }
  return "empirical_finding";
}

function parseLiteratureQueryDiagnosticObject(raw: string): Record<string, unknown> | undefined {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function extractDiagnosticTerms(value: string, limit: number): string[] {
  const tokens = value
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length > 1))].slice(0, limit);
}

function normalizeQueryForComparison(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function extractJsonObject(raw: string): string | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fenced?.[1] || raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  return candidate.slice(start, end + 1);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => cleanText(item)).filter(Boolean))];
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function expandSmallKeywordBundles(queries: string[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    if (hasSemanticScholarSpecialSyntax(query)) {
      const normalizedStructured = query.trim();
      if (!normalizedStructured) {
        continue;
      }
      const structuredKey = normalizedStructured.toLowerCase();
      if (seen.has(structuredKey)) {
        continue;
      }
      seen.add(structuredKey);
      results.push(normalizedStructured);
      continue;
    }
    const variants = toSmallKeywordBundles(query);
    for (const variant of variants.length > 0 ? variants : [query]) {
      const normalized = variant.trim();
      if (!normalized) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(normalized);
    }
  }
  return results;
}

function toSmallKeywordBundles(query: string): string[] {
  const tokens = extractKeywordTokens(query);
  if (tokens.length < 2) {
    return [];
  }
  if (tokens.length <= 5) {
    return [tokens.join(" ")];
  }

  const bundles: string[] = [];
  const size = 4;
  const stride = 2;
  for (let start = 0; start < tokens.length && bundles.length < 3; start += stride) {
    const chunk = tokens.slice(start, start + size);
    if (chunk.length < 2) {
      break;
    }
    bundles.push(chunk.join(" "));
    if (start + size >= tokens.length) {
      break;
    }
  }
  return bundles;
}

function extractKeywordTokens(query: string): string[] {
  const matches = query.match(/[a-z0-9]+(?:-[a-z0-9]+)*/giu) || [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    const token = match.toLowerCase().trim();
    if (!token) {
      continue;
    }
    if (token.length < 2 && !/\d/u.test(token)) {
      continue;
    }
    if (SMALL_QUERY_FILLER_TOKENS.has(token)) {
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function isUsableSemanticScholarQuery(query: string): boolean {
  const tokens = extractKeywordTokens(query);
  if (tokens.length < 2) {
    return false;
  }
  return !tokens.every((token) => PLACEHOLDER_QUERY_TOKENS.has(token));
}

function resolveLiteratureQueryTimeoutMs(callerTimeoutMs?: number): number {
  const configured = Number.parseInt(process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS || "", 10);
  const selected =
    typeof callerTimeoutMs === "number" && Number.isFinite(callerTimeoutMs) && callerTimeoutMs > 0
      ? callerTimeoutMs
      : Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_LITERATURE_QUERY_TIMEOUT_MS;
  return Math.min(MAX_LITERATURE_QUERY_TIMEOUT_MS, Math.max(1, Math.floor(selected)));
}

async function withLiteratureQueryTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outerAbortSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;
  let timedOut = false;
  const abortFromOuterSignal = () => controller.abort();

  if (outerAbortSignal) {
    if (outerAbortSignal.aborted) {
      controller.abort();
    } else {
      outerAbortSignal.addEventListener("abort", abortFromOuterSignal, { once: true });
    }
  }

  const operationPromise = operation(controller.signal);
  void operationPromise.catch(() => undefined);
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`literature_query_timeout_after_${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      throw new Error(`literature_query_timeout_after_${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    outerAbortSignal?.removeEventListener("abort", abortFromOuterSignal);
  }
}
