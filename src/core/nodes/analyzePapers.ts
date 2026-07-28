import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { appendJsonl, appendJsonlItems, runArtifactsDir, safeRead, syncRunLiteratureIndex, writeRunArtifact } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import { recordLiteratureQueryPlanRejection } from "../literatureQueryGeneration.js";
import {
  parseReusableResearchGapSynthesisArtifact,
  synthesizeResearchGapClusters
} from "../analysis/researchGapSynthesis.js";
import { buildResearchGapMap } from "../researchFunnel.js";
import { readJsonFile, writeJsonFile } from "../../utils/fs.js";
import {
  ANALYSIS_SYSTEM_PROMPT,
  PAPER_ANALYSIS_EVIDENCE_SEMANTICS_VERSION,
  analyzePaperWithLlm,
  analyzePaperWithResponsesPdf,
  buildPaperAnalysisPrompt,
  normalizePaperAnalysis,
  PaperAnalysisResult,
  PaperEvidenceRow,
  PaperSummaryRow,
  parsePaperAnalysisJson,
  synthesizeDeterministicAbstractFallbackResult,
  shouldFallbackResponsesPdfToLocalText
} from "../analysis/paperAnalyzer.js";
import { OllamaPdfAnalysisClient } from "../../integrations/ollama/ollamaPdfAnalysisClient.js";
import { getPdfAnalysisModeForConfig } from "../../config.js";
import {
  AnalysisCorpusRow,
  ResolvedPaperSource,
  buildAbstractFallbackText,
  resolvePaperPdfUrl,
  resolvePaperTextSource
} from "../analysis/paperText.js";
import {
  ANALYSIS_SELECTION_SEMANTICS_VERSION,
  AnalysisSelectionRequest,
  applyTopicFamilyCoverageFloor,
  buildSelectionFingerprint,
  buildSelectionRequestFingerprint,
  DeterministicScoreBreakdown,
  normalizeAnalysisSelectionRequest,
  PaperSelectionResult,
  RankedPaperCandidate,
  selectPapersForAnalysis,
  TopicFamilyCoverageAudit
} from "../analysis/paperSelection.js";
import { CollectEnrichmentLogEntry, StoredCorpusRow } from "../collection/types.js";
import {
  assessTopicDiscoveryPaperRelevance,
  buildTopicDiscoveryCorpusRelevanceProfile,
  TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY,
  TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION
} from "../collection/topicDiscoveryCorpusQuality.js";
import {
  TOPIC_DISCOVERY_PROVIDER_RECALL_FLOOR_PER_FAMILY,
  TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION
} from "../collection/topicDiscoverySemanticAudit.js";
import {
  buildTopicDiscoveryCandidateFamilySignature,
  TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
  TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
} from "../topicDiscoveryScientificTerms.js";
import {
  isCurrentTopicDiscoveryCollectQueryPlanArtifact,
  TOPIC_DISCOVERY_CANDIDATE_SIDECAR_VERSION
} from "../collection/topicDiscoveryArtifactVersions.js";
import { DoctorCheck, RunRecord, TransitionRecommendation } from "../../types.js";
import { resolveResearchRunModeGuard } from "../runs/researchRunModeGuard.js";
import { validateTopicDiscoverySemanticLineage } from "../runs/topicDiscoverySemanticLineage.js";
import {
  validateCandidatePriorSearchPlanIntegrity,
  validateCandidatePriorSearchReceipt
} from "../candidatePriorSearch.js";
import { auditCollectAttemptArchiveIntegrity } from "../collection/collectAttemptArchive.js";
import { RECOMMENDED_CODEX_MODEL } from "../../integrations/codex/modelCatalog.js";
import {
  DEFAULT_OPENAI_RESPONSES_MODEL,
  DEFAULT_OPENAI_RESPONSES_REASONING_EFFORT
} from "../../integrations/openai/modelCatalog.js";
import { checkCodexOAuthStatus } from "../../integrations/codex/oauthAuth.js";
import { CodexOAuthResponsesLLMClient } from "../llm/client.js";
import { resolveCodexOAuthCredentials } from "../../integrations/codex/oauthAuth.js";
import { CodexOAuthResponsesTextClient } from "../../integrations/codex/oauthResponsesTextClient.js";

interface AnalysisManifest {
  version: 2 | 3 | 4;
  updatedAt: string;
  request: AnalysisSelectionRequest;
  selectionSemanticsVersion?: number;
  selectionFingerprint: string;
  selectionRequestFingerprint?: string;
  analysisFingerprint?: string;
  corpusFingerprint?: string;
  totalCandidates: number;
  candidatePoolSize: number;
  rerankApplied?: boolean;
  rerankFallbackReason?: string;
  topicFamilyCoverage?: TopicFamilyCoverageAudit;
  selectedPaperIds: string[];
  rerankedPaperIds: string[];
  deterministicRankingPreview: Array<{
    paper_id: string;
    title: string;
    deterministic_score: number;
    score_breakdown: DeterministicScoreBreakdown;
  }>;
  papers: Record<string, AnalysisManifestEntry>;
}

interface AnalysisManifestEntry {
  paper_id: string;
  title: string;
  query_families?: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  selected: boolean;
  rank?: number;
  source_type?: "full_text" | "abstract";
  summary_count: number;
  evidence_count: number;
  analysis_attempts: number;
  analysis_mode?: "codex_text_image_hybrid" | "responses_api_pdf" | "ollama_vision";
  pdf_url?: string;
  pdf_cache_path?: string;
  text_cache_path?: string;
  fallback_reason?: string;
  last_error?: string;
  has_table_references?: boolean;
  table_reference_count?: number;
  has_figure_references?: boolean;
  figure_reference_count?: number;
  deterministic_score?: number;
  selection_score?: number;
  score_breakdown?: DeterministicScoreBreakdown;
  rerank_position?: number;
  updatedAt: string;
  completedAt?: string;
}

async function writeAnalysisManifest(run: RunRecord, manifest: AnalysisManifest): Promise<void> {
  await writeRunArtifact(run, "analysis_manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

const MAX_AUTO_SELECTION_EXPANSIONS = 2;
const DEFAULT_SAFE_ANALYSIS_TOP_N = 30;
const MIN_SELECTION_GUARD_ANCHORS = 2;
const ABSTRACT_ONLY_EXHAUSTION_MIN_SUMMARIES = 4;
const ABSTRACT_ONLY_EXHAUSTION_MAX_SELECTED = 12;
const ZERO_OUTPUT_EARLY_PAUSE_MIN_SELECTED = 12;
const ZERO_OUTPUT_EARLY_PAUSE_SAMPLE = 2;
const ZERO_OUTPUT_TIMEOUT_EARLY_PAUSE_SAMPLE = 3;
const ZERO_OUTPUT_RETRY_PAUSE_SAMPLE = 1;
const ZERO_OUTPUT_TIMEOUT_RETRY_PAUSE_SAMPLE = 2;
const SMALL_SELECTION_SERIAL_WARM_START_MAX = 4;
const COLLECT_ENRICHMENT_SELECTED_WAIT_MS = 5_000;
const COLLECT_ENRICHMENT_EXTENDED_WAIT_MS = 15_000;
const COLLECT_ENRICHMENT_POLL_INTERVAL_MS = 250;
const TOPIC_DISCOVERY_MINIMUM_DIRECT_SUPPORT_PAPERS = 8;
const TOPIC_DISCOVERY_MINIMUM_COVERED_QUERY_FAMILIES = 2;
const TOPIC_DISCOVERY_MINIMUM_DIRECT_SUPPORT_PER_FAMILY = 2;
const TOPIC_DISCOVERY_MINIMUM_SEMANTIC_PRECISION_PER_FAMILY = 0.5;

function countDistinctQueryFamilies(rows: AnalysisCorpusRow[]): number {
  return new Set(
    rows.flatMap((row) =>
      (row.query_families ?? [])
        .map((queryFamily) => queryFamily.trim())
        .filter(Boolean)
    )
  ).size;
}

function createSelectionRerankLlm(deps: NodeExecutionDeps): NodeExecutionDeps["llm"] {
  const providerConfig = deps.config?.providers;
  if (!providerConfig) {
    return deps.llm;
  }

  if (providerConfig.llm_mode !== "codex" && providerConfig.llm_mode !== "codex_chatgpt_only") {
    return deps.llm;
  }

  const codexOAuthText = new CodexOAuthResponsesTextClient(() => resolveCodexOAuthCredentials(), {
    model: providerConfig.codex.chat_model || providerConfig.codex.model,
    reasoningEffort:
      providerConfig.codex.command_reasoning_effort ||
      providerConfig.codex.chat_reasoning_effort ||
      providerConfig.codex.reasoning_effort
  });
  return new CodexOAuthResponsesLLMClient(codexOAuthText, {
    model: providerConfig.codex.chat_model || providerConfig.codex.model,
    reasoningEffort:
      providerConfig.codex.command_reasoning_effort ||
      providerConfig.codex.chat_reasoning_effort ||
      providerConfig.codex.reasoning_effort
  });
}

const SELECTION_QUALITY_STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "analysis",
  "and",
  "approach",
  "broad",
  "benchmark",
  "benchmarks",
  "collect",
  "comparison",
  "comparisons",
  "concrete",
  "dataset",
  "datasets",
  "enough",
  "evaluation",
  "executable",
  "for",
  "from",
  "identify",
  "in",
  "method",
  "methods",
  "most",
  "of",
  "on",
  "paper",
  "public",
  "relevant",
  "research",
  "results",
  "should",
  "single",
  "small",
  "stay",
  "study",
  "task",
  "tasks",
  "the",
  "this",
  "toward",
  "under",
  "using",
  "while",
  "which",
  "with"
]);

const SELECTION_QUALITY_GENERIC_TOKENS = new Set([
  "budget",
  "choice",
  "classification",
  "classifications",
  "classifier",
  "classifiers",
  "data",
  "dataset",
  "datasets",
  "deep",
  "experiment",
  "learning",
  "language",
  "literature",
  "local",
  "matter",
  "machine",
  "model",
  "models",
  "open",
  "prediction",
  "predictions",
  "predictive",
  "system",
  "systems",
  "workstation"
]);

const SELECTION_QUALITY_WEAK_TITLE_ANCHORS = new Set([
  "fine",
  "finetune",
  "finetuning",
  "following",
  "instruction",
  "instructions",
  "prompt",
  "prompts",
  "tuned",
  "tuning"
]);

const SELECTION_QUALITY_DOMAIN_TOKENS = new Set([
  "audio",
  "biomedical",
  "chatbot",
  "chatbots",
  "clinical",
  "emotion",
  "emotions",
  "financial",
  "health",
  "healthcare",
  "image",
  "images",
  "medical",
  "medicine",
  "multimodal",
  "recommendation",
  "recommender",
  "retrieval",
  "speech",
  "vision",
  "visual"
]);

interface LoadedAnalysisSelectionRequest {
  request: AnalysisSelectionRequest;
  autoDefaultReason?: string;
}

interface AnalysisQuarantineRow {
  paper_id: string;
  title: string;
  reason: string;
  source_type: "full_text" | "abstract";
  analysis_mode: "codex_text_image_hybrid" | "responses_api_pdf" | "ollama_vision";
  fallback_reason?: string;
  summary_preview?: string;
  source_excerpt?: string;
  createdAt: string;
}

interface ZeroOutputPauseDecision {
  attemptedCount: number;
  threshold: number;
}

interface SelectedFailureSummary {
  failedEntries: AnalysisManifestEntry[];
  usageLimitEntries: AnalysisManifestEntry[];
  environmentBlockedEntries: AnalysisManifestEntry[];
  sourceMismatchEntries: AnalysisManifestEntry[];
  cleanedMessages: string[];
}

interface SelectionQualityGuardResult {
  selection: PaperSelectionResult;
  applied: boolean;
  droppedPaperIds: string[];
  addedPaperIds: string[];
  eligiblePaperIds?: string[];
  reason?: string;
}

interface SelectionRetargetResult {
  manifest: AnalysisManifest;
  summaryRows: PaperSummaryRow[];
  evidenceRows: PaperEvidenceRow[];
  preservedCompletedPaperIds: string[];
  droppedPaperIds: string[];
  logMessage: string;
}

interface CollectAnalysisLineageAudit {
  modern: boolean;
  valid: boolean;
  expectedAttemptId?: string;
  requiredQueryFamilies?: string[];
  queryFamilies?: Array<{
    queryFamily: string;
    query: string;
    axisTerms: string[];
    lens: string;
    contributionIntent: string;
    canonicalFamilySignature: string;
    lexicalRelevantPaperCount: number;
    semanticReviewedPaperCount: number;
    providerRecallPaperCount: number;
    directSupportPaperCount: number;
    applicationOnlyPaperCount: number;
    uncertainPaperCount: number;
    retainedPaperCount: number;
    relevantPaperCount: number;
    semanticPrecision: number;
  }>;
  sharedAnchorTerms?: string[];
  reasons: string[];
}

interface ParsedTopicDiscoveryPlanFamilies {
  malformed: boolean;
  sharedAnchorTerms?: string[];
  families: Map<string, {
    query: string;
    sharedAnchorTerms: string[];
    axisTerms: string[];
    lens: string;
    contributionIntent: string;
  }>;
}

interface ParsedSemanticFamilyContracts {
  malformed: boolean;
  families: Map<string, {
    query: string;
    sharedAnchorTerms?: string[];
    axisTerms: string[];
    lens: string;
    contributionIntent: string;
  }>;
}

interface ParsedSemanticJudgments {
  malformed: boolean;
  judgments: Map<string, {
    paperId: string;
    familyId: string;
    verdict: "direct_support" | "application_only" | "uncertain";
    reason: string;
    evidenceSpan?: string;
  }>;
}

interface ParsedTopicDiscoveryCandidatePool {
  malformed: boolean;
  candidates: Map<string, {
    paperId: string;
    title: string;
    abstract: string;
    queryFamilies: string[];
    declaredLexicalFamilies: string[];
    familyRanks: Map<string, number>;
    canonicalSearchSource: string;
    searchProviders: string[];
    semanticReviewRequestedFamilies: string[];
    semanticReviewSelections: Array<{
      familyId: string;
      selectionSource: "lexical_match" | "provider_provenance_floor";
    }>;
    semanticReviewRequested: boolean;
  }>;
}

function parseTopicDiscoveryPlanFamilies(value: unknown): ParsedTopicDiscoveryPlanFamilies {
  const families = new Map<string, {
    query: string;
    sharedAnchorTerms: string[];
    axisTerms: string[];
    lens: string;
    contributionIntent: string;
  }>();
  let malformed = !Array.isArray(value) || value.length === 0;
  for (const raw of Array.isArray(value) ? value : []) {
    const selected = objectValue(raw);
    const contract = objectValue(selected?.topic_discovery_family);
    const queryFamily = stringValue(selected?.query_family);
    const familyId = stringValue(contract?.familyId);
    const query = stringValue(selected?.query);
    const sharedAnchorTerms = exactStringArrayValue(contract?.sharedAnchorTerms);
    const axisTerms = exactStringArrayValue(contract?.axisTerms);
    const lens = stringValue(contract?.lens);
    const contributionIntent = stringValue(contract?.contributionIntent);
    if (
      !queryFamily
      || familyId !== queryFamily
      || !query
      || !sharedAnchorTerms
      || !axisTerms
      || !lens
      || !contributionIntent
      || families.has(queryFamily)
    ) {
      malformed = true;
      continue;
    }
    families.set(queryFamily, {
      query,
      sharedAnchorTerms,
      axisTerms,
      lens,
      contributionIntent
    });
  }
  const sharedAnchorTerms = families.values().next().value?.sharedAnchorTerms;
  if (
    !sharedAnchorTerms
    || Array.from(families.values()).some(
      (family) => !sameStringArray(family.sharedAnchorTerms, sharedAnchorTerms)
    )
  ) {
    malformed = true;
  }
  return { malformed, sharedAnchorTerms, families };
}

function parseSemanticFamilyContracts(value: unknown): ParsedSemanticFamilyContracts {
  const families: ParsedSemanticFamilyContracts["families"] = new Map();
  let malformed = !Array.isArray(value) || value.length === 0;
  for (const raw of Array.isArray(value) ? value : []) {
    const contract = objectValue(raw);
    const familyId = stringValue(contract?.family_id);
    const query = stringValue(contract?.query);
    const rawSharedAnchorTerms = contract?.shared_anchor_terms;
    const sharedAnchorTerms = rawSharedAnchorTerms === undefined
      ? undefined
      : exactStringArrayValue(rawSharedAnchorTerms);
    const axisTerms = exactStringArrayValue(contract?.axis_terms);
    const lens = stringValue(contract?.lens);
    const contributionIntent = stringValue(contract?.contribution_intent);
    if (
      !familyId
      || !query
      || (rawSharedAnchorTerms !== undefined && !sharedAnchorTerms)
      || !axisTerms
      || !lens
      || !contributionIntent
      || families.has(familyId)
    ) {
      malformed = true;
      continue;
    }
    families.set(familyId, {
      query,
      ...(sharedAnchorTerms ? { sharedAnchorTerms } : {}),
      axisTerms,
      lens,
      contributionIntent
    });
  }
  return { malformed, families };
}

function parseSemanticJudgments(value: unknown): ParsedSemanticJudgments {
  const judgments = new Map<string, {
    paperId: string;
    familyId: string;
    verdict: "direct_support" | "application_only" | "uncertain";
    reason: string;
    evidenceSpan?: string;
  }>();
  let malformed = !Array.isArray(value);
  for (const raw of Array.isArray(value) ? value : []) {
    const judgment = objectValue(raw);
    const paperId = stringValue(judgment?.paper_id);
    const familyId = stringValue(judgment?.family_id);
    const verdict = judgment?.verdict;
    const reason = stringValue(judgment?.reason);
    if (
      !paperId
      || !familyId
      || !reason
      || (verdict !== "direct_support"
        && verdict !== "application_only"
        && verdict !== "uncertain")
    ) {
      malformed = true;
      continue;
    }
    const key = semanticPairKey(paperId, familyId);
    if (judgments.has(key)) {
      malformed = true;
      continue;
    }
    const evidenceSpan = stringValue(judgment?.evidence_span);
    judgments.set(key, {
      paperId,
      familyId,
      verdict,
      reason,
      ...(evidenceSpan ? { evidenceSpan } : {})
    });
  }
  return { malformed, judgments };
}

function parseSemanticRequestedPairKeys(value: unknown): {
  malformed: boolean;
  keys: Set<string>;
  selectionSources: Map<
    string,
    "lexical_match" | "provider_provenance_floor"
  >;
} {
  const keys = new Set<string>();
  const selectionSources = new Map<
    string,
    "lexical_match" | "provider_provenance_floor"
  >();
  let malformed = !Array.isArray(value);
  for (const raw of Array.isArray(value) ? value : []) {
    const pair = objectValue(raw);
    const paperId = stringValue(pair?.paper_id);
    const familyId = stringValue(pair?.family_id);
    const selectionSource = pair?.selection_source;
    if (
      !paperId
      || !familyId
      || (selectionSource !== "lexical_match"
        && selectionSource !== "provider_provenance_floor")
    ) {
      malformed = true;
      continue;
    }
    const key = semanticPairKey(paperId, familyId);
    if (keys.has(key)) {
      malformed = true;
    }
    keys.add(key);
    selectionSources.set(key, selectionSource);
  }
  return { malformed, keys, selectionSources };
}

function semanticPairKey(paperId: string, familyId: string): string {
  return JSON.stringify([paperId, familyId]);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameKeySet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && Array.from(left).every((key) => right.has(key));
}

function sameSelectionSourceMap(
  left: ReadonlyMap<string, "lexical_match" | "provider_provenance_floor">,
  right: ReadonlyMap<string, "lexical_match" | "provider_provenance_floor">
): boolean {
  return left.size === right.size
    && Array.from(left.entries()).every(([key, source]) => right.get(key) === source);
}

function semanticRecallMatchesSelectionSources(
  value: unknown,
  sources: ReadonlyMap<
    string,
    "lexical_match" | "provider_provenance_floor"
  >
): boolean {
  const recall = objectValue(value);
  const lexicalCount = Array.from(sources.values()).filter(
    (source) => source === "lexical_match"
  ).length;
  const providerCount = sources.size - lexicalCount;
  return numberValue(recall?.provider_recall_floor_per_family)
      === TOPIC_DISCOVERY_PROVIDER_RECALL_FLOOR_PER_FAMILY
    && numberValue(recall?.lexical_requested_pairs) === lexicalCount
    && numberValue(recall?.provider_provenance_requested_pairs) === providerCount;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactStringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const values = value.map(stringValue);
  if (
    values.some((item) => !item)
    || new Set(values).size !== values.length
  ) {
    return undefined;
  }
  return values as string[];
}

function hashJsonValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

interface SemanticJudgmentCounts {
  directSupport: number;
  applicationOnly: number;
  uncertain: number;
}

function countSemanticJudgments(
  judgments: Iterable<{
    verdict: "direct_support" | "application_only" | "uncertain";
  }>
): SemanticJudgmentCounts {
  const counts: SemanticJudgmentCounts = {
    directSupport: 0,
    applicationOnly: 0,
    uncertain: 0
  };
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

function semanticReviewCountsMatch(
  value: unknown,
  expectedPairCount: number,
  verdictCounts: SemanticJudgmentCounts
): boolean {
  const counts = objectValue(value);
  return Boolean(counts)
    && numberValue(counts?.requested_pairs) === expectedPairCount
    && numberValue(counts?.reviewed_pairs) === expectedPairCount
    && numberValue(counts?.budget_excluded_pairs) === 0
    && numberValue(counts?.returned_judgments) === expectedPairCount
    && numberValue(counts?.direct_support) === verdictCounts.directSupport
    && numberValue(counts?.application_only) === verdictCounts.applicationOnly
    && numberValue(counts?.uncertain) === verdictCounts.uncertain
    && numberValue(counts?.omitted_judgments) === 0
    && numberValue(counts?.duplicate_judgments) === 0
    && numberValue(counts?.conflicting_judgments) === 0
    && numberValue(counts?.invented_judgments) === 0
    && numberValue(counts?.malformed_judgments) === 0
    && numberValue(counts?.protocol_violations) === 0;
}

async function auditCollectAttemptArchive(input: {
  run: RunRecord;
  manifestValue: unknown;
  expectedAttemptId?: string;
  requiredLiveArtifacts?: ReadonlyMap<string, string>;
}): Promise<string[]> {
  if (!input.expectedAttemptId) {
    return ["collect_lineage_manifest_contract_invalid"];
  }
  return auditCollectAttemptArchiveIntegrity({
    runDir: runArtifactsDir(input.run),
    expectedRunId: input.run.id,
    expectedAttemptId: input.expectedAttemptId,
    manifestValue: input.manifestValue,
    requiredArtifacts: input.requiredLiveArtifacts
  });
}

function exactPossiblyEmptyStringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.map(stringValue);
  if (values.some((item) => !item) || new Set(values).size !== values.length) {
    return undefined;
  }
  return values as string[];
}

function parseTopicDiscoverySemanticReviewSelections(value: unknown): {
  malformed: boolean;
  values: Array<{
    familyId: string;
    selectionSource: "lexical_match" | "provider_provenance_floor";
  }>;
} {
  const values: Array<{
    familyId: string;
    selectionSource: "lexical_match" | "provider_provenance_floor";
  }> = [];
  const familyIds = new Set<string>();
  let malformed = !Array.isArray(value);
  for (const raw of Array.isArray(value) ? value : []) {
    const selection = objectValue(raw);
    const familyId = stringValue(selection?.family_id);
    const selectionSource = selection?.selection_source;
    if (
      !familyId
      || familyIds.has(familyId)
      || (selectionSource !== "lexical_match"
        && selectionSource !== "provider_provenance_floor")
    ) {
      malformed = true;
      continue;
    }
    familyIds.add(familyId);
    values.push({ familyId, selectionSource });
  }
  return { malformed, values };
}

function parseTopicDiscoveryFamilyRanks(value: unknown): {
  malformed: boolean;
  values: Map<string, number>;
} {
  const values = new Map<string, number>();
  let malformed = !Array.isArray(value);
  for (const raw of Array.isArray(value) ? value : []) {
    const entry = objectValue(raw);
    const familyId = stringValue(entry?.family_id);
    const rank = numberValue(entry?.rank);
    if (!familyId || !rank || !Number.isInteger(rank) || values.has(familyId)) {
      malformed = true;
      continue;
    }
    values.set(familyId, rank);
  }
  return { malformed, values };
}

function topicDiscoveryPaperSearchProvider(value: unknown): string | undefined {
  return value === "semantic_scholar"
    || value === "openalex"
    || value === "crossref"
    || value === "arxiv"
    ? value
    : undefined;
}

function parseTopicDiscoveryCandidatePool(input: {
  raw: string;
  expectedAttemptId?: string;
}): ParsedTopicDiscoveryCandidatePool {
  const candidates: ParsedTopicDiscoveryCandidatePool["candidates"] = new Map();
  let malformed = !input.raw.trim();
  const lines = input.raw.split(/\r?\n/u).filter((line) => line.trim());
  for (const line of lines) {
    let candidate: Record<string, unknown> | undefined;
    try {
      candidate = objectValue(JSON.parse(line) as unknown);
    } catch {
      malformed = true;
      continue;
    }
    const paperId = stringValue(candidate?.paper_id);
    const queryFamilies = exactStringArrayValue(candidate?.query_families);
    const declaredLexicalFamilies = exactPossiblyEmptyStringArrayValue(
      candidate?.lexical_matched_query_families
    );
    const semanticReviewRequestedFamilies = exactPossiblyEmptyStringArrayValue(
      candidate?.semantic_review_requested_query_families
    );
    const familyRanks = parseTopicDiscoveryFamilyRanks(
      candidate?.family_retrieval_ranks
    );
    const canonicalSearchSource = topicDiscoveryPaperSearchProvider(
      candidate?.canonical_search_source
    );
    const searchProviders = exactStringArrayValue(candidate?.search_providers);
    const semanticReviewSelections = parseTopicDiscoverySemanticReviewSelections(
      candidate?.semantic_review_selections
    );
    if (
      !paperId
      || candidate?.schema_version !== TOPIC_DISCOVERY_CANDIDATE_SIDECAR_VERSION
      || typeof candidate?.title !== "string"
      || typeof candidate.abstract !== "string"
      || !queryFamilies
      || !declaredLexicalFamilies
      || !semanticReviewRequestedFamilies
      || familyRanks.malformed
      || !sameKeySet(new Set(familyRanks.values.keys()), new Set(queryFamilies))
      || !canonicalSearchSource
      || !searchProviders
      || searchProviders.some((provider) => !topicDiscoveryPaperSearchProvider(provider))
      || !searchProviders.includes(canonicalSearchSource)
      || semanticReviewSelections.malformed
      || !sameStringArray(
        semanticReviewRequestedFamilies,
        semanticReviewSelections.values.map((selection) => selection.familyId)
      )
      || stringValue(candidate.collect_attempt_id) !== input.expectedAttemptId
      || candidate.evidence_status !== "semantic_screening_candidate_only"
      || candidate.paper_evidence_allowed !== false
      || candidate.retrieval_status !== "retrieved_governance_usable"
      || typeof candidate.semantic_review_requested !== "boolean"
      || typeof candidate.selected_by_semantic_quality !== "boolean"
      || typeof candidate.published_in_corpus !== "boolean"
      || candidates.has(paperId)
    ) {
      malformed = true;
      continue;
    }
    candidates.set(paperId, {
      paperId,
      title: candidate.title,
      abstract: candidate.abstract,
      queryFamilies,
      declaredLexicalFamilies,
      familyRanks: familyRanks.values,
      canonicalSearchSource,
      searchProviders,
      semanticReviewRequestedFamilies,
      semanticReviewSelections: semanticReviewSelections.values,
      semanticReviewRequested: candidate.semantic_review_requested
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
  return { malformed, candidates };
}

function reconstructTopicDiscoverySemanticPairUniverse(input: {
  candidates: ParsedTopicDiscoveryCandidatePool;
  plannedFamilies: ParsedTopicDiscoveryPlanFamilies;
}): {
  malformed: boolean;
  keys: Set<string>;
  paperIds: Set<string>;
  lexicalPaperIds: Set<string>;
  selectionSources: Map<
    string,
    "lexical_match" | "provider_provenance_floor"
  >;
} {
  const profile = buildTopicDiscoveryCorpusRelevanceProfile(
    Array.from(input.plannedFamilies.families.entries()).map(([familyId, family]) => ({
      queryFamily: familyId,
      query: family.query,
      source: "llm_query_planner",
      sharedAnchorTerms: family.sharedAnchorTerms,
      axisTerms: family.axisTerms,
      lens: family.lens,
      contributionIntent: family.contributionIntent,
      contractSource: "planner_declared"
    }))
  );
  const keys = new Set<string>();
  const paperIds = new Set<string>();
  const lexicalPaperIds = new Set<string>();
  const selectionSources = new Map<
    string,
    "lexical_match" | "provider_provenance_floor"
  >();
  let malformed = input.candidates.malformed || input.plannedFamilies.malformed;
  for (const candidate of input.candidates.candidates.values()) {
    if (candidate.queryFamilies.some(
      (familyId) => !input.plannedFamilies.families.has(familyId)
    )) {
      malformed = true;
    }
    const relevance = assessTopicDiscoveryPaperRelevance({
      row: {
        paper_id: candidate.paperId,
        title: candidate.title,
        abstract: candidate.abstract,
        authors: []
      } satisfies StoredCorpusRow,
      profile,
      eligibleQueryFamilies: new Set(candidate.queryFamilies)
    });
    const matchedFamilies = new Set(relevance.matchedQueryFamilies);
    if (matchedFamilies.size > 0) {
      lexicalPaperIds.add(candidate.paperId);
    }
    const selectedLexicalFamilies = new Set(
      candidate.semanticReviewSelections
        .filter((selection) => selection.selectionSource === "lexical_match")
        .map((selection) => selection.familyId)
    );
    if (
      !sameKeySet(matchedFamilies, new Set(candidate.declaredLexicalFamilies))
      || !sameKeySet(matchedFamilies, selectedLexicalFamilies)
      || candidate.semanticReviewRequested
        !== (candidate.semanticReviewSelections.length > 0)
      || !sameStringArray(
        candidate.semanticReviewRequestedFamilies,
        candidate.semanticReviewSelections.map((selection) => selection.familyId)
      )
    ) {
      malformed = true;
    }
    for (const selection of candidate.semanticReviewSelections) {
      const familyId = selection.familyId;
      if (
        !candidate.queryFamilies.includes(familyId)
        || !input.plannedFamilies.families.has(familyId)
        || (selection.selectionSource === "lexical_match") !== matchedFamilies.has(familyId)
      ) {
        malformed = true;
      }
      const key = semanticPairKey(candidate.paperId, familyId);
      if (keys.has(key)) {
        malformed = true;
      }
      keys.add(key);
      selectionSources.set(key, selection.selectionSource);
      paperIds.add(candidate.paperId);
    }
  }
  const expectedSelectionSources = new Map<
    string,
    "lexical_match" | "provider_provenance_floor"
  >();
  for (const familyId of input.plannedFamilies.families.keys()) {
    const rankedCandidates = Array.from(input.candidates.candidates.values())
      .filter((candidate) => candidate.familyRanks.has(familyId))
      .sort((left, right) =>
        left.familyRanks.get(familyId)! - right.familyRanks.get(familyId)!
        || left.paperId.localeCompare(right.paperId)
      );
    const selectedPaperIds = new Set<string>();
    for (const candidate of rankedCandidates) {
      if (!candidate.declaredLexicalFamilies.includes(familyId)) continue;
      expectedSelectionSources.set(
        semanticPairKey(candidate.paperId, familyId),
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
          semanticPairKey(candidate.paperId, familyId),
          "provider_provenance_floor"
        );
        selectedPaperIds.add(candidate.paperId);
      }
    }
  }
  if (
    expectedSelectionSources.size !== selectionSources.size
    || Array.from(expectedSelectionSources).some(
      ([key, source]) => selectionSources.get(key) !== source
    )
  ) {
    malformed = true;
  }
  return { malformed, keys, paperIds, lexicalPaperIds, selectionSources };
}

const MAX_CANDIDATE_PRIOR_PARENT_DEPTH = 3;

async function auditCandidatePriorParentLineage(input: {
  run: RunRecord;
  runRoot: string;
  expectedAttemptId?: string;
  queryPlan: Record<string, unknown> | undefined;
  planArtifact: Record<string, unknown> | undefined;
  receiptArtifact: Record<string, unknown> | undefined;
  currentCorpusRaw: string;
  depth?: number;
  visitedAttemptIds?: Set<string>;
}): Promise<{
  reasons: string[];
  requiredQueryFamilies?: string[];
  queryFamilies?: CollectAnalysisLineageAudit["queryFamilies"];
  sharedAnchorTerms?: string[];
}> {
  const reasons: string[] = [];
  const expectedAttemptId = input.expectedAttemptId;
  const depth = input.depth ?? 0;
  const visitedAttemptIds = new Set(input.visitedAttemptIds ?? []);
  if (depth > MAX_CANDIDATE_PRIOR_PARENT_DEPTH) {
    reasons.push("collect_lineage_candidate_prior_depth_exceeded");
    return { reasons };
  }
  if (expectedAttemptId && visitedAttemptIds.has(expectedAttemptId)) {
    reasons.push("collect_lineage_candidate_prior_cycle_detected");
    return { reasons };
  }
  if (expectedAttemptId) {
    visitedAttemptIds.add(expectedAttemptId);
  }
  if (
    input.queryPlan?.research_mode !== "topic_discovery"
    || input.queryPlan.strategy !== "candidate_prior_portfolio"
    || !expectedAttemptId
    || stringValue(input.queryPlan.collect_attempt_id) !== expectedAttemptId
  ) {
    reasons.push("collect_lineage_candidate_prior_query_plan_invalid");
  }
  const planValidation = validateCandidatePriorSearchPlanIntegrity(
    input.planArtifact
  );
  const embeddedPlanValidation = validateCandidatePriorSearchPlanIntegrity(
    input.queryPlan?.candidate_prior_search_plan
  );
  reasons.push(...planValidation.reasons, ...embeddedPlanValidation.reasons);
  const plan = planValidation.plan;
  if (
    !plan
    || !embeddedPlanValidation.plan
    || plan.content_sha256 !== embeddedPlanValidation.plan.content_sha256
  ) {
    reasons.push("collect_lineage_candidate_prior_plan_projection_mismatch");
  }
  if (!plan || !expectedAttemptId) {
    return { reasons: Array.from(new Set(reasons)) };
  }

  const parentAttemptId = plan.source_corpus.collect_attempt_id;
  const parentRoot = `${input.runRoot}/collect_attempts/${parentAttemptId}`;
  const [
    parentManifestRaw,
    parentQueryPlanRaw,
    parentQualityRaw,
    parentSemanticInputRaw,
    parentSemanticReviewRaw,
    parentCandidatesRaw,
    parentCorpusRaw,
    parentCandidatePlanRaw,
    parentCandidateReceiptRaw
  ] = await Promise.all([
    safeRead(`${parentRoot}/manifest.json`),
    safeRead(`${parentRoot}/collect_query_plan.json`),
    safeRead(`${parentRoot}/collect_corpus_quality.json`),
    safeRead(`${parentRoot}/collect_semantic_review_input.json`),
    safeRead(`${parentRoot}/collect_semantic_review.json`),
    safeRead(`${parentRoot}/collect_topic_discovery_candidates.jsonl`),
    safeRead(`${parentRoot}/corpus.jsonl`),
    safeRead(`${parentRoot}/collect_candidate_prior_search_plan.json`),
    safeRead(`${parentRoot}/collect_candidate_prior_search_receipt.json`)
  ]);
  const parentManifest = parseJsonRecordValue(parentManifestRaw);
  const parentQueryPlan = parseJsonRecordValue(parentQueryPlanRaw);
  const parentCandidatePlan = parseJsonRecordValue(parentCandidatePlanRaw);
  const parentCandidateReceipt = parseJsonRecordValue(
    parentCandidateReceiptRaw
  );
  const receiptValidation = validateCandidatePriorSearchReceipt(
    input.receiptArtifact,
    {
      plan,
      expectedCollectAttemptId: expectedAttemptId,
      sourceCorpusRaw: parentCorpusRaw,
      resultCorpusRaw: input.currentCorpusRaw
    }
  );
  reasons.push(...receiptValidation.reasons);
  if (parentQueryPlan?.strategy === "candidate_prior_portfolio") {
    reasons.push(...await auditCollectAttemptArchive({
      run: input.run,
      manifestValue: parentManifest,
      expectedAttemptId: parentAttemptId,
      requiredLiveArtifacts: new Map<string, string>([
        ["collect_query_plan.json", parentQueryPlanRaw],
        ["collect_candidate_prior_search_plan.json", parentCandidatePlanRaw],
        [
          "collect_candidate_prior_search_receipt.json",
          parentCandidateReceiptRaw
        ],
        ["corpus.jsonl", parentCorpusRaw]
      ])
    }));
    if (depth >= MAX_CANDIDATE_PRIOR_PARENT_DEPTH) {
      reasons.push("collect_lineage_candidate_prior_depth_exceeded");
      return { reasons: Array.from(new Set(reasons)) };
    }
    const parentAudit = await auditCandidatePriorParentLineage({
      run: input.run,
      runRoot: input.runRoot,
      expectedAttemptId: parentAttemptId,
      queryPlan: parentQueryPlan,
      planArtifact: parentCandidatePlan,
      receiptArtifact: parentCandidateReceipt,
      currentCorpusRaw: parentCorpusRaw,
      depth: depth + 1,
      visitedAttemptIds
    });
    return {
      reasons: Array.from(new Set([
        ...reasons,
        ...parentAudit.reasons
      ])),
      requiredQueryFamilies: parentAudit.requiredQueryFamilies,
      queryFamilies: parentAudit.queryFamilies,
      sharedAnchorTerms: parentAudit.sharedAnchorTerms
    };
  }
  const parentSemanticLineage = validateTopicDiscoverySemanticLineage({
    expectedAttemptId: parentAttemptId,
    qualityRaw: parentQualityRaw,
    semanticReviewInputRaw: parentSemanticInputRaw,
    semanticReviewRaw: parentSemanticReviewRaw,
    candidatesRaw: parentCandidatesRaw,
    queryPlanRaw: parentQueryPlanRaw,
    corpusRaw: parentCorpusRaw
  });
  if (!parentSemanticLineage.trusted) {
    reasons.push(...parentSemanticLineage.reasonCodes);
  }
  reasons.push(...await auditCollectAttemptArchive({
    run: input.run,
    manifestValue: parentManifest,
    expectedAttemptId: parentAttemptId,
    requiredLiveArtifacts: new Map<string, string>([
      ["collect_query_plan.json", parentQueryPlanRaw],
      ["collect_corpus_quality.json", parentQualityRaw],
      ["collect_semantic_review_input.json", parentSemanticInputRaw],
      ["collect_semantic_review.json", parentSemanticReviewRaw],
      ["collect_topic_discovery_candidates.jsonl", parentCandidatesRaw],
      ["corpus.jsonl", parentCorpusRaw]
    ])
  }));

  const projection = projectTrustedTopicQuality(parentQualityRaw);
  reasons.push(...projection.reasons);
  return {
    reasons: Array.from(new Set(reasons)),
    requiredQueryFamilies: projection.requiredQueryFamilies,
    queryFamilies: projection.queryFamilies,
    sharedAnchorTerms: projection.sharedAnchorTerms
  };
}

function parseJsonRecordValue(
  raw: string
): Record<string, unknown> | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  try {
    return objectValue(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function projectTrustedTopicQuality(raw: string): {
  reasons: string[];
  requiredQueryFamilies?: string[];
  queryFamilies?: CollectAnalysisLineageAudit["queryFamilies"];
  sharedAnchorTerms?: string[];
} {
  const reasons: string[] = [];
  let quality: Record<string, unknown> | undefined;
  try {
    quality = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : undefined;
  } catch {
    quality = undefined;
  }
  const rawFamilies = Array.isArray(quality?.query_families)
    ? quality.query_families
    : [];
  const queryFamilies: NonNullable<CollectAnalysisLineageAudit["queryFamilies"]> = [];
  for (const rawFamily of rawFamilies) {
    const family = objectValue(rawFamily);
    const queryFamily = stringValue(family?.query_family);
    const query = stringValue(family?.query);
    const axisTerms = exactStringArrayValue(family?.axis_terms);
    const lens = stringValue(family?.lens);
    const contributionIntent = stringValue(family?.contribution_intent);
    const canonicalFamilySignature = stringValue(
      family?.canonical_family_signature
    );
    const counts = {
      lexicalRelevantPaperCount: numberValue(
        family?.lexical_relevant_paper_count
      ),
      semanticReviewedPaperCount: numberValue(
        family?.semantic_reviewed_paper_count
      ),
      providerRecallPaperCount: numberValue(
        family?.provider_recall_paper_count
      ),
      directSupportPaperCount: numberValue(
        family?.direct_support_paper_count
      ),
      applicationOnlyPaperCount: numberValue(
        family?.application_only_paper_count
      ),
      uncertainPaperCount: numberValue(family?.uncertain_paper_count),
      retainedPaperCount: numberValue(family?.retained_paper_count),
      relevantPaperCount: numberValue(family?.relevant_paper_count),
      semanticPrecision: numberValue(family?.semantic_precision)
    };
    if (
      !queryFamily
      || !query
      || !axisTerms
      || !lens
      || !contributionIntent
      || !canonicalFamilySignature
      || Object.values(counts).some((value) => value === undefined)
    ) {
      reasons.push("collect_lineage_candidate_prior_parent_quality_projection_invalid");
      continue;
    }
    queryFamilies.push({
      queryFamily,
      query,
      axisTerms,
      lens,
      contributionIntent,
      canonicalFamilySignature,
      lexicalRelevantPaperCount: counts.lexicalRelevantPaperCount!,
      semanticReviewedPaperCount: counts.semanticReviewedPaperCount!,
      providerRecallPaperCount: counts.providerRecallPaperCount!,
      directSupportPaperCount: counts.directSupportPaperCount!,
      applicationOnlyPaperCount: counts.applicationOnlyPaperCount!,
      uncertainPaperCount: counts.uncertainPaperCount!,
      retainedPaperCount: counts.retainedPaperCount!,
      relevantPaperCount: counts.relevantPaperCount!,
      semanticPrecision: counts.semanticPrecision!
    });
  }
  const sharedAnchorTerms = exactStringArrayValue(
    objectValue(quality?.observed)?.shared_anchor_terms
  );
  if (queryFamilies.length === 0 || !sharedAnchorTerms) {
    reasons.push("collect_lineage_candidate_prior_parent_quality_projection_missing");
  }
  return {
    reasons,
    requiredQueryFamilies: queryFamilies
      .filter((family) => family.retainedPaperCount > 0)
      .map((family) => family.queryFamily)
      .sort(),
    queryFamilies: queryFamilies.sort((left, right) =>
      left.queryFamily.localeCompare(right.queryFamily)
    ),
    sharedAnchorTerms
  };
}

async function auditCollectAnalysisLineage(input: {
  run: RunRecord;
  runContextMemory: RunContextMemory;
  corpusRows: AnalysisCorpusRow[];
  topicDiscoveryRequired: boolean;
}): Promise<CollectAnalysisLineageAudit> {
  const runRoot = `.autolabos/runs/${input.run.id}`;
  const [
    generationRaw,
    resultRaw,
    manifestRaw,
    backgroundJobRaw,
    corpusQualityRaw,
    queryPlanRaw,
    semanticReviewRaw,
    semanticReviewInputRaw,
    topicDiscoveryCandidatesRaw,
    corpusRaw,
    candidatePriorPlanRaw,
    candidatePriorReceiptRaw
  ] = await Promise.all([
    safeRead(`${runRoot}/collect_generation.json`),
    safeRead(`${runRoot}/collect_result.json`),
    safeRead(`${runRoot}/collect_attempt_manifest.json`),
    safeRead(`${runRoot}/collect_background_job.json`),
    safeRead(`${runRoot}/collect_corpus_quality.json`),
    safeRead(`${runRoot}/collect_query_plan.json`),
    safeRead(`${runRoot}/collect_semantic_review.json`),
    safeRead(`${runRoot}/collect_semantic_review_input.json`),
    safeRead(`${runRoot}/collect_topic_discovery_candidates.jsonl`),
    safeRead(`${runRoot}/corpus.jsonl`),
    safeRead(`${runRoot}/collect_candidate_prior_search_plan.json`),
    safeRead(`${runRoot}/collect_candidate_prior_search_receipt.json`)
  ]);
  const parseObject = (raw: string): Record<string, unknown> | undefined => {
    if (!raw.trim()) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object"
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  };
  const generation = parseObject(generationRaw);
  const result = parseObject(resultRaw);
  const manifest = parseObject(manifestRaw);
  const backgroundJob = parseObject(backgroundJobRaw);
  const corpusQualityArtifact = parseObject(corpusQualityRaw);
  const queryPlan = parseObject(queryPlanRaw);
  const semanticReviewArtifact = parseObject(semanticReviewRaw);
  const semanticReviewInputArtifact = parseObject(semanticReviewInputRaw);
  const candidatePriorPlanArtifact = parseObject(candidatePriorPlanRaw);
  const candidatePriorReceiptArtifact = parseObject(candidatePriorReceiptRaw);
  const candidatePriorLineage =
    queryPlan?.strategy === "candidate_prior_portfolio";
  const generationAttemptId = stringValue(generation?.collect_attempt_id);
  const resultAttemptId = stringValue(result?.collect_attempt_id);
  const manifestAttemptId = stringValue(manifest?.collect_attempt_id);
  const modern = Boolean(
    generationAttemptId
    || resultAttemptId
    || manifestAttemptId
    || input.topicDiscoveryRequired
  );
  if (!modern) {
    return { modern: false, valid: true, reasons: [] };
  }

  const reasons: string[] = [];
  if (!generationAttemptId) {
    reasons.push("collect_lineage_missing_generation");
  }
  const expectedAttemptId = generationAttemptId;
  if (!expectedAttemptId || resultAttemptId !== expectedAttemptId) {
    reasons.push("collect_lineage_result_attempt_mismatch");
  }
  if (!expectedAttemptId || manifestAttemptId !== expectedAttemptId) {
    reasons.push("collect_lineage_manifest_attempt_mismatch");
  }
  const activeAttemptId = await input.runContextMemory.get<unknown>(
    "collect_papers.active_attempt_id"
  );
  if (typeof activeAttemptId === "string" && activeAttemptId.trim()) {
    reasons.push("collect_lineage_attempt_still_active");
  }
  const contextGenerationId = await input.runContextMemory.get<unknown>(
    "collect_papers.current_generation_id"
  );
  if (contextGenerationId !== expectedAttemptId) {
    reasons.push("collect_lineage_context_generation_mismatch");
  }
  if (result?.completed !== true) {
    reasons.push("collect_lineage_result_incomplete");
  }
  if (typeof result?.fetchError === "string" && result.fetchError.trim()) {
    reasons.push("collect_lineage_result_failed");
  }
  if (manifest?.status !== "quality_gate_passed") {
    reasons.push("collect_lineage_quality_gate_not_passed");
  }
  if (input.topicDiscoveryRequired && !candidatePriorLineage) {
    const sharedSemanticLineage = validateTopicDiscoverySemanticLineage({
      expectedAttemptId,
      qualityRaw: corpusQualityRaw,
      semanticReviewInputRaw,
      semanticReviewRaw,
      candidatesRaw: topicDiscoveryCandidatesRaw,
      queryPlanRaw,
      corpusRaw: input.corpusRows.length > 0
        ? `${input.corpusRows.map((row) => JSON.stringify(row)).join("\n")}\n`
        : ""
    });
    if (!sharedSemanticLineage.trusted) {
      reasons.push(...sharedSemanticLineage.reasonCodes);
    }
  }
  const corpusQuality = result?.corpusQuality;
  if (
    corpusQuality
    && typeof corpusQuality === "object"
    && (corpusQuality as Record<string, unknown>).passed === false
  ) {
    reasons.push("collect_lineage_corpus_quality_failed");
  }
  const storedCount = numberValue(result?.stored);
  if (storedCount === undefined || storedCount !== input.corpusRows.length) {
    reasons.push("collect_lineage_corpus_count_mismatch");
  }
  const backgroundAttemptId = stringValue(backgroundJob?.collectAttemptId);
  if (backgroundAttemptId && backgroundAttemptId !== expectedAttemptId) {
    reasons.push("collect_lineage_background_attempt_mismatch");
  }
  const embeddedCorpusQuality =
    result?.corpusQuality && typeof result.corpusQuality === "object"
      ? result.corpusQuality as Record<string, unknown>
      : undefined;
  const queryPlanDeclaresTopicDiscovery =
    queryPlan?.research_mode === "topic_discovery";
  const qualityDeclaresTopicDiscovery =
    corpusQualityArtifact?.research_mode === "topic_discovery" ||
    embeddedCorpusQuality?.research_mode === "topic_discovery";
  const topicDiscoveryLineage =
    !candidatePriorLineage
    && (
      input.topicDiscoveryRequired
      || queryPlanDeclaresTopicDiscovery
      || qualityDeclaresTopicDiscovery
    );
  reasons.push(...await auditCollectAttemptArchive({
    run: input.run,
    manifestValue: manifest,
    expectedAttemptId,
    ...(topicDiscoveryLineage
      ? {
          requiredLiveArtifacts: new Map<string, string>([
            ["collect_query_plan.json", queryPlanRaw],
            ["collect_corpus_quality.json", corpusQualityRaw],
            ["collect_semantic_review_input.json", semanticReviewInputRaw],
            ["collect_semantic_review.json", semanticReviewRaw],
            ["collect_topic_discovery_candidates.jsonl", topicDiscoveryCandidatesRaw]
          ])
        }
      : candidatePriorLineage
        ? {
            requiredLiveArtifacts: new Map<string, string>([
              ["collect_query_plan.json", queryPlanRaw],
              ["collect_candidate_prior_search_plan.json", candidatePriorPlanRaw],
              ["collect_candidate_prior_search_receipt.json", candidatePriorReceiptRaw],
              ["corpus.jsonl", corpusRaw]
            ])
          }
        : {})
  }));
  if (candidatePriorLineage) {
    if (!input.topicDiscoveryRequired) {
      reasons.push("collect_lineage_candidate_prior_mode_mismatch");
    }
    const parentAudit = await auditCandidatePriorParentLineage({
      run: input.run,
      runRoot,
      expectedAttemptId,
      queryPlan,
      planArtifact: candidatePriorPlanArtifact,
      receiptArtifact: candidatePriorReceiptArtifact,
      currentCorpusRaw: corpusRaw
    });
    reasons.push(...parentAudit.reasons);
    return {
      modern: true,
      valid: reasons.length === 0,
      expectedAttemptId,
      requiredQueryFamilies: parentAudit.requiredQueryFamilies,
      queryFamilies: parentAudit.queryFamilies,
      sharedAnchorTerms: parentAudit.sharedAnchorTerms,
      reasons: Array.from(new Set(reasons))
    };
  }
  let requiredQueryFamilies: string[] | undefined;
  let queryFamilies: CollectAnalysisLineageAudit["queryFamilies"];
  let sharedAnchorTerms: string[] | undefined;
  if (topicDiscoveryLineage) {
    if (!semanticReviewInputArtifact) {
      reasons.push("collect_lineage_topic_semantic_review_input_invalid");
    }
    if (!semanticReviewArtifact) {
      reasons.push("collect_lineage_topic_semantic_review_not_complete");
    }
    if (!queryPlanDeclaresTopicDiscovery) {
      reasons.push("collect_lineage_topic_query_plan_mode_mismatch");
    }
    if (
      !isCurrentTopicDiscoveryCollectQueryPlanArtifact(queryPlan)
      || queryPlan?.strategy !== "topic_portfolio"
    ) {
      reasons.push("collect_lineage_topic_query_plan_semantics_unsupported");
    }
    if (
      !expectedAttemptId
      || stringValue(queryPlan?.collect_attempt_id) !== expectedAttemptId
    ) {
      reasons.push("collect_lineage_topic_query_plan_attempt_mismatch");
    }
    const plannedFamilies = parseTopicDiscoveryPlanFamilies(
      queryPlan?.selected_families
    );
    if (plannedFamilies.malformed) {
      reasons.push("collect_lineage_topic_query_plan_family_contract_invalid");
    }
    const candidatePool = parseTopicDiscoveryCandidatePool({
      raw: topicDiscoveryCandidatesRaw,
      expectedAttemptId
    });
    const semanticPairUniverse = reconstructTopicDiscoverySemanticPairUniverse({
      candidates: candidatePool,
      plannedFamilies
    });
    if (candidatePool.malformed || semanticPairUniverse.malformed) {
      reasons.push("collect_lineage_topic_candidate_pool_invalid");
    }
    if (!corpusQualityArtifact || corpusQualityArtifact.research_mode !== "topic_discovery") {
      reasons.push("collect_lineage_topic_family_quality_missing");
    } else {
      if (
        corpusQualityArtifact.version !== TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION
        || corpusQualityArtifact.strategy !== TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY
        || corpusQualityArtifact.term_normalization_version
          !== TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
        || corpusQualityArtifact.candidate_recall_semantics_version
          !== TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION
      ) {
        reasons.push("collect_lineage_topic_family_quality_semantics_unsupported");
      }
      const qualityAttemptId = stringValue(corpusQualityArtifact.collect_attempt_id);
      if (!expectedAttemptId || qualityAttemptId !== expectedAttemptId) {
        reasons.push("collect_lineage_topic_family_quality_attempt_mismatch");
      }
      if (corpusQualityArtifact.passed !== true) {
        reasons.push("collect_lineage_topic_family_quality_not_passed");
      }

      const familyCounts = new Map<string, number>();
      const parsedQueryFamilies: NonNullable<CollectAnalysisLineageAudit["queryFamilies"]> = [];
      const rawFamilies = Array.isArray(corpusQualityArtifact.query_families)
        ? corpusQualityArtifact.query_families
        : [];
      let malformedFamily = rawFamilies.length === 0;
      for (const rawFamily of rawFamilies) {
        if (!rawFamily || typeof rawFamily !== "object") {
          malformedFamily = true;
          continue;
        }
        const family = rawFamily as Record<string, unknown>;
        const queryFamily = stringValue(family.query_family);
        const query = stringValue(family.query);
        const axisTerms = exactStringArrayValue(family.axis_terms);
        const lens = stringValue(family.lens);
        const contributionIntent = stringValue(family.contribution_intent);
        const canonicalFamilySignature = stringValue(
          family.canonical_family_signature
        );
        const lexicalRelevantCount = numberValue(family.lexical_relevant_paper_count);
        const semanticReviewedCount = numberValue(family.semantic_reviewed_paper_count);
        const providerRecallCount = numberValue(family.provider_recall_paper_count);
        const directSupportCount = numberValue(family.direct_support_paper_count);
        const applicationOnlyCount = numberValue(family.application_only_paper_count);
        const uncertainCount = numberValue(family.uncertain_paper_count);
        const retainedPaperCount = numberValue(family.retained_paper_count);
        const relevantPaperCount = numberValue(family.relevant_paper_count);
        const semanticPrecision = numberValue(family.semantic_precision);
        const allCounts = [
          lexicalRelevantCount,
          semanticReviewedCount,
          providerRecallCount,
          directSupportCount,
          applicationOnlyCount,
          uncertainCount,
          retainedPaperCount,
          relevantPaperCount
        ];
        const expectedPrecision = semanticReviewedCount && directSupportCount !== undefined
          ? directSupportCount / semanticReviewedCount
          : 0;
        if (
          !queryFamily ||
          !query ||
          !axisTerms ||
          !lens ||
          !contributionIntent ||
          !canonicalFamilySignature ||
          allCounts.some((count) =>
            count === undefined || !Number.isInteger(count) || count < 0
          ) ||
          relevantPaperCount !== retainedPaperCount ||
          retainedPaperCount! > directSupportCount! ||
          semanticReviewedCount !==
            directSupportCount! + applicationOnlyCount! + uncertainCount! ||
          providerRecallCount! > semanticReviewedCount! ||
          lexicalRelevantCount! + providerRecallCount! !== semanticReviewedCount! ||
          semanticPrecision === undefined ||
          semanticPrecision < 0 ||
          semanticPrecision > 1 ||
          semanticPrecision !== expectedPrecision ||
          familyCounts.has(queryFamily)
        ) {
          malformedFamily = true;
          continue;
        }
        familyCounts.set(queryFamily, retainedPaperCount!);
        const plannedFamily = plannedFamilies.families.get(queryFamily);
        const expectedCanonicalFamilySignature = plannedFamily
          ? buildTopicDiscoveryCandidateFamilySignature({
              sharedAnchorTerms: plannedFamily.sharedAnchorTerms,
              axisTerms
            })
          : undefined;
        if (
          !plannedFamily
          || plannedFamily.query !== query
          || !sameStringArray(plannedFamily.axisTerms, axisTerms)
          || plannedFamily.lens !== lens
          || plannedFamily.contributionIntent !== contributionIntent
          || canonicalFamilySignature !== expectedCanonicalFamilySignature
        ) {
          reasons.push("collect_lineage_topic_family_plan_contract_mismatch");
        }
        parsedQueryFamilies.push({
          queryFamily,
          query,
          axisTerms,
          lens,
          contributionIntent,
          canonicalFamilySignature,
          lexicalRelevantPaperCount: lexicalRelevantCount!,
          semanticReviewedPaperCount: semanticReviewedCount!,
          providerRecallPaperCount: providerRecallCount!,
          directSupportPaperCount: directSupportCount!,
          applicationOnlyPaperCount: applicationOnlyCount!,
          uncertainPaperCount: uncertainCount!,
          retainedPaperCount: retainedPaperCount!,
          relevantPaperCount: relevantPaperCount!,
          semanticPrecision
        });
      }
      if (plannedFamilies.families.size !== familyCounts.size) {
        reasons.push("collect_lineage_topic_family_plan_contract_mismatch");
      }
      queryFamilies = parsedQueryFamilies.sort((left, right) =>
        left.queryFamily.localeCompare(right.queryFamily)
      );
      const qualityThresholds = objectValue(corpusQualityArtifact.thresholds);
      if (
        numberValue(qualityThresholds?.minimum_relevant_papers)
          !== TOPIC_DISCOVERY_MINIMUM_DIRECT_SUPPORT_PAPERS
        || numberValue(qualityThresholds?.minimum_covered_query_families)
          !== TOPIC_DISCOVERY_MINIMUM_COVERED_QUERY_FAMILIES
        || numberValue(qualityThresholds?.minimum_relevant_papers_per_family)
          !== TOPIC_DISCOVERY_MINIMUM_DIRECT_SUPPORT_PER_FAMILY
        || numberValue(qualityThresholds?.minimum_direct_support_per_family)
          !== TOPIC_DISCOVERY_MINIMUM_DIRECT_SUPPORT_PER_FAMILY
        || numberValue(qualityThresholds?.minimum_semantic_precision_per_family)
          !== TOPIC_DISCOVERY_MINIMUM_SEMANTIC_PRECISION_PER_FAMILY
      ) {
        reasons.push("collect_lineage_topic_family_quality_thresholds_invalid");
      }
      if (parsedQueryFamilies.some((family) =>
        family.directSupportPaperCount
          < TOPIC_DISCOVERY_MINIMUM_DIRECT_SUPPORT_PER_FAMILY
        || family.semanticPrecision
          < TOPIC_DISCOVERY_MINIMUM_SEMANTIC_PRECISION_PER_FAMILY
      )) {
        reasons.push("collect_lineage_topic_family_quality_floor_not_met");
      }
      const observed =
        corpusQualityArtifact.observed && typeof corpusQualityArtifact.observed === "object"
          ? corpusQualityArtifact.observed as Record<string, unknown>
          : undefined;
      sharedAnchorTerms = exactStringArrayValue(observed?.shared_anchor_terms);
      if (
        !sharedAnchorTerms
        || !plannedFamilies.sharedAnchorTerms
        || !sameStringArray(sharedAnchorTerms, plannedFamilies.sharedAnchorTerms)
      ) {
        reasons.push("collect_lineage_topic_family_quality_observed_mismatch");
      }
      requiredQueryFamilies = Array.from(familyCounts.entries())
        .filter(([, count]) => count > 0)
        .map(([queryFamily]) => queryFamily)
        .sort();
      if (malformedFamily || requiredQueryFamilies.length === 0) {
        reasons.push("collect_lineage_topic_family_required_set_missing");
      }

      const qualitySemanticReview = objectValue(
        corpusQualityArtifact.semantic_review
      );
      const semanticReviewInputPayload = objectValue(
        semanticReviewInputArtifact?.payload
      );
      const semanticReviewInputHash = semanticReviewInputPayload
        ? hashJsonValue(semanticReviewInputPayload)
        : undefined;
      const semanticReviewInputBytes = semanticReviewInputPayload
        ? Buffer.byteLength(JSON.stringify(semanticReviewInputPayload), "utf8")
        : undefined;
      if (
        !semanticReviewInputArtifact
        || semanticReviewInputArtifact.paper_evidence_allowed !== false
        || !expectedAttemptId
        || stringValue(semanticReviewInputArtifact.collect_attempt_id)
          !== expectedAttemptId
        || !semanticReviewInputPayload
        || semanticReviewInputPayload.version !== TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION
        || semanticReviewInputPayload.term_normalization_version
          !== TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
        || semanticReviewInputPayload.candidate_recall_semantics_version
          !== TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION
        || stringValue(semanticReviewInputArtifact.payload_sha256)
          !== semanticReviewInputHash
      ) {
        reasons.push("collect_lineage_topic_semantic_review_input_invalid");
      }
      if (
        !semanticReviewArtifact
        || semanticReviewArtifact.version !== TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION
        || semanticReviewArtifact.paper_evidence_allowed !== false
        || !expectedAttemptId
        || stringValue(semanticReviewArtifact.collect_attempt_id)
          !== expectedAttemptId
        || semanticReviewArtifact.status !== "complete"
      ) {
        reasons.push("collect_lineage_topic_semantic_review_not_complete");
      }
      if (
        !qualitySemanticReview
        || qualitySemanticReview.version !== TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION
        || qualitySemanticReview.status !== "complete"
        || stringValue(qualitySemanticReview.reviewer_input_sha256)
          !== semanticReviewInputHash
        || stringValue(semanticReviewArtifact?.reviewer_input_sha256)
          !== semanticReviewInputHash
        || stringValue(qualitySemanticReview.prompt_sha256)
          !== stringValue(semanticReviewArtifact?.prompt_sha256)
        || stringValue(qualitySemanticReview.response_sha256)
          !== stringValue(semanticReviewArtifact?.response_sha256)
        || numberValue(qualitySemanticReview.reviewer_input_bytes)
          !== semanticReviewInputBytes
        || numberValue(semanticReviewArtifact?.reviewer_input_bytes)
          !== semanticReviewInputBytes
      ) {
        reasons.push("collect_lineage_topic_semantic_review_hash_mismatch");
      }
      const semanticFamilyContracts = parseSemanticFamilyContracts(
        semanticReviewInputPayload?.family_contracts
      );
      if (
        semanticFamilyContracts.malformed
        || semanticFamilyContracts.families.size !== plannedFamilies.families.size
        || Array.from(plannedFamilies.families.entries()).some(
          ([familyId, plannedFamily]) => {
            const semanticFamily = semanticFamilyContracts.families.get(familyId);
            return !semanticFamily
              || semanticFamily.query !== plannedFamily.query
              || (semanticFamily.sharedAnchorTerms !== undefined
                && !sameStringArray(
                  semanticFamily.sharedAnchorTerms,
                  plannedFamily.sharedAnchorTerms
                ))
              || !sameStringArray(semanticFamily.axisTerms, plannedFamily.axisTerms)
              || semanticFamily.lens !== plannedFamily.lens
              || semanticFamily.contributionIntent !== plannedFamily.contributionIntent;
          }
        )
      ) {
        reasons.push("collect_lineage_topic_semantic_family_contract_mismatch");
      }
      const requestedPairs = parseSemanticRequestedPairKeys(
        semanticReviewInputPayload?.requested_pairs
      );
      if (
        !semanticRecallMatchesSelectionSources(
          semanticReviewArtifact?.recall,
          requestedPairs.selectionSources
        )
        || !semanticRecallMatchesSelectionSources(
          qualitySemanticReview?.recall,
          requestedPairs.selectionSources
        )
      ) {
        reasons.push("collect_lineage_topic_semantic_recall_mismatch");
      }
      const reviewJudgments = parseSemanticJudgments(
        semanticReviewArtifact?.judgments
      );
      const qualityJudgments = parseSemanticJudgments(
        corpusQualityArtifact.semantic_judgments
      );
      const reviewPairKeys = new Set(reviewJudgments.judgments.keys());
      const qualityPairKeys = new Set(qualityJudgments.judgments.keys());
      if (
        requestedPairs.malformed
        || reviewJudgments.malformed
        || qualityJudgments.malformed
        || !sameKeySet(semanticPairUniverse.keys, requestedPairs.keys)
        || !sameKeySet(semanticPairUniverse.keys, reviewPairKeys)
        || !sameKeySet(semanticPairUniverse.keys, qualityPairKeys)
        || !sameSelectionSourceMap(
          semanticPairUniverse.selectionSources,
          requestedPairs.selectionSources
        )
        || !sameKeySet(requestedPairs.keys, reviewPairKeys)
        || !sameKeySet(requestedPairs.keys, qualityPairKeys)
        || Array.from(reviewJudgments.judgments.entries()).some(
          ([key, judgment]) => {
            const qualityJudgment = qualityJudgments.judgments.get(key);
            return !qualityJudgment
              || qualityJudgment.verdict !== judgment.verdict
              || qualityJudgment.reason !== judgment.reason
              || qualityJudgment.evidenceSpan !== judgment.evidenceSpan;
          }
        )
      ) {
        reasons.push("collect_lineage_topic_semantic_review_pair_mismatch");
      }
      if (
        semanticPairUniverse.malformed
        || !sameKeySet(semanticPairUniverse.keys, requestedPairs.keys)
        || !sameKeySet(semanticPairUniverse.keys, qualityPairKeys)
      ) {
        reasons.push("collect_lineage_topic_semantic_pair_universe_mismatch");
      }
      const verdictCounts = countSemanticJudgments(reviewJudgments.judgments.values());
      if (
        !semanticReviewCountsMatch(
          semanticReviewArtifact?.counts,
          requestedPairs.keys.size,
          verdictCounts
        )
        || !semanticReviewCountsMatch(
          qualitySemanticReview?.counts,
          requestedPairs.keys.size,
          verdictCounts
        )
      ) {
        reasons.push("collect_lineage_topic_semantic_review_count_mismatch");
      }

      const judgmentCountsByFamily = new Map<string, SemanticJudgmentCounts>(
        Array.from(plannedFamilies.families.keys()).map((familyId) => [
          familyId,
          { directSupport: 0, applicationOnly: 0, uncertain: 0 }
        ])
      );
      let unknownJudgmentFamily = false;
      const directSupportPaperIds = new Set<string>();
      for (const judgment of reviewJudgments.judgments.values()) {
        const familyJudgmentCounts = judgmentCountsByFamily.get(judgment.familyId);
        if (!familyJudgmentCounts) {
          unknownJudgmentFamily = true;
          continue;
        }
        if (judgment.verdict === "direct_support") {
          familyJudgmentCounts.directSupport += 1;
          directSupportPaperIds.add(judgment.paperId);
        } else if (judgment.verdict === "application_only") {
          familyJudgmentCounts.applicationOnly += 1;
        } else {
          familyJudgmentCounts.uncertain += 1;
        }
      }
      const coveredCanonicalFamilySignatures = new Set<string>();
      for (const [familyId, counts] of judgmentCountsByFamily) {
          const reviewedCount = counts.directSupport
            + counts.applicationOnly
            + counts.uncertain;
          const precision = reviewedCount > 0 ? counts.directSupport / reviewedCount : 0;
          if (counts.directSupport
              >= TOPIC_DISCOVERY_MINIMUM_DIRECT_SUPPORT_PER_FAMILY
            && precision >= TOPIC_DISCOVERY_MINIMUM_SEMANTIC_PRECISION_PER_FAMILY) {
            const signature = parsedQueryFamilies.find(
              (family) => family.queryFamily === familyId
            )?.canonicalFamilySignature;
            if (signature) {
              coveredCanonicalFamilySignatures.add(signature);
            }
          }
      }
      const coveredQueryFamilyCount = coveredCanonicalFamilySignatures.size;
      const qualityFamilyJudgmentsMismatch = unknownJudgmentFamily
        || parsedQueryFamilies.some((family) => {
          const counts = judgmentCountsByFamily.get(family.queryFamily);
          if (!counts) {
            return true;
          }
          const reviewedCount = counts.directSupport
            + counts.applicationOnly
            + counts.uncertain;
          const precision = reviewedCount > 0 ? counts.directSupport / reviewedCount : 0;
          return family.semanticReviewedPaperCount !== reviewedCount
            || family.directSupportPaperCount !== counts.directSupport
            || family.applicationOnlyPaperCount !== counts.applicationOnly
            || family.uncertainPaperCount !== counts.uncertain
            || family.semanticPrecision !== precision;
        });
      if (qualityFamilyJudgmentsMismatch) {
        reasons.push("collect_lineage_topic_family_quality_judgment_mismatch");
      }
      if (
        directSupportPaperIds.size < TOPIC_DISCOVERY_MINIMUM_DIRECT_SUPPORT_PAPERS
        || coveredQueryFamilyCount < TOPIC_DISCOVERY_MINIMUM_COVERED_QUERY_FAMILIES
        || Array.from(judgmentCountsByFamily.values()).some((counts) => {
          const reviewedCount = counts.directSupport
            + counts.applicationOnly
            + counts.uncertain;
          const precision = reviewedCount > 0 ? counts.directSupport / reviewedCount : 0;
          return counts.directSupport
              < TOPIC_DISCOVERY_MINIMUM_DIRECT_SUPPORT_PER_FAMILY
            || precision < TOPIC_DISCOVERY_MINIMUM_SEMANTIC_PRECISION_PER_FAMILY;
        })
      ) {
        reasons.push("collect_lineage_topic_family_quality_floor_not_met");
      }

      const retainedPaperIds = Array.isArray(corpusQualityArtifact.retained_paper_ids)
        ? corpusQualityArtifact.retained_paper_ids
            .map((paperId) => stringValue(paperId))
            .filter((paperId): paperId is string => Boolean(paperId))
        : [];
      const excludedPaperIds = Array.isArray(corpusQualityArtifact.excluded_paper_ids)
        ? corpusQualityArtifact.excluded_paper_ids
            .map((paperId) => stringValue(paperId))
            .filter((paperId): paperId is string => Boolean(paperId))
        : [];
      const retainedPaperIdSet = new Set(retainedPaperIds);
      const excludedPaperIdSet = new Set(excludedPaperIds);
      const qualityPaperInventory = new Set([
        ...retainedPaperIdSet,
        ...excludedPaperIdSet
      ]);
      const candidatePaperIdSet = new Set(candidatePool.candidates.keys());
      const corpusPaperIdSet = new Set(input.corpusRows.map((row) => row.paper_id));
      if (
        retainedPaperIds.length !== retainedPaperIdSet.size ||
        excludedPaperIds.length !== excludedPaperIdSet.size ||
        Array.from(retainedPaperIdSet).some((paperId) => excludedPaperIdSet.has(paperId)) ||
        corpusPaperIdSet.size !== input.corpusRows.length ||
        retainedPaperIdSet.size !== corpusPaperIdSet.size ||
        Array.from(retainedPaperIdSet).some((paperId) => !corpusPaperIdSet.has(paperId)) ||
        Array.from(retainedPaperIdSet).some(
          (paperId) => !directSupportPaperIds.has(paperId)
        ) ||
        Array.from(directSupportPaperIds).some(
          (paperId) => !qualityPaperInventory.has(paperId)
        ) ||
        !sameKeySet(qualityPaperInventory, candidatePaperIdSet)
      ) {
        reasons.push("collect_lineage_topic_family_retained_set_mismatch");
      }

      const observedFamilyCounts = new Map<string, number>(
        Array.from(familyCounts.keys()).map((queryFamily) => [queryFamily, 0] as const)
      );
      const corpusDirectPairKeys = new Set<string>();
      let missingFamily = false;
      let unknownFamily = false;
      for (const row of input.corpusRows) {
        const rawQueryFamilies = Array.isArray(row.query_families) ? row.query_families : [];
        const normalizedQueryFamilies = Array.from(
          new Set(
            rawQueryFamilies
              .map((queryFamily) => stringValue(queryFamily))
              .filter((queryFamily): queryFamily is string => Boolean(queryFamily))
          )
        );
        if (
          normalizedQueryFamilies.length === 0 ||
          normalizedQueryFamilies.length !== rawQueryFamilies.length
        ) {
          missingFamily = true;
        }
        for (const queryFamily of normalizedQueryFamilies) {
          if (!familyCounts.has(queryFamily)) {
            unknownFamily = true;
            continue;
          }
          observedFamilyCounts.set(queryFamily, (observedFamilyCounts.get(queryFamily) ?? 0) + 1);
          corpusDirectPairKeys.add(semanticPairKey(row.paper_id, queryFamily));
        }
      }
      if (missingFamily) {
        reasons.push("collect_lineage_topic_family_missing");
      }
      if (unknownFamily) {
        reasons.push("collect_lineage_topic_family_unknown");
      }
      if (
        Array.from(familyCounts.entries()).some(
          ([queryFamily, expectedCount]) => observedFamilyCounts.get(queryFamily) !== expectedCount
        )
      ) {
        reasons.push("collect_lineage_topic_family_count_mismatch");
      }
      const retainedDirectReviewPairKeys = new Set(
        Array.from(reviewJudgments.judgments.entries())
          .filter(([, judgment]) =>
            judgment.verdict === "direct_support"
            && retainedPaperIdSet.has(judgment.paperId)
          )
          .map(([key]) => key)
      );
      const semanticInputPapers = new Map<string, { title: string; abstract: string }>();
      const rawSemanticInputPapers = Array.isArray(semanticReviewInputPayload?.papers)
        ? semanticReviewInputPayload.papers
        : [];
      let malformedSemanticInputPaper = !Array.isArray(
        semanticReviewInputPayload?.papers
      );
      for (const rawPaper of rawSemanticInputPapers) {
        const paper = objectValue(rawPaper);
        const paperId = stringValue(paper?.paper_id);
        if (
          !paperId
          || typeof paper?.title !== "string"
          || typeof paper?.abstract !== "string"
          || semanticInputPapers.has(paperId)
        ) {
          malformedSemanticInputPaper = true;
          continue;
        }
        semanticInputPapers.set(paperId, {
          title: paper.title,
          abstract: paper.abstract
        });
      }
      const reviewedPaperIds = new Set(
        Array.from(reviewJudgments.judgments.values()).map(
          (judgment) => judgment.paperId
        )
      );
      const semanticReviewLimits = objectValue(semanticReviewArtifact?.limits);
      const semanticAbstractChars = numberValue(semanticReviewLimits?.abstract_chars);
      const semanticMaxPairs = numberValue(semanticReviewLimits?.max_pairs);
      const semanticPayloadProjectionMismatch =
        semanticAbstractChars === undefined
        || !Number.isInteger(semanticAbstractChars)
        || semanticAbstractChars <= 0
        || semanticMaxPairs === undefined
        || !Number.isInteger(semanticMaxPairs)
        || semanticMaxPairs < semanticPairUniverse.keys.size
        || semanticInputPapers.size !== semanticPairUniverse.paperIds.size
        || Array.from(semanticPairUniverse.paperIds).some((paperId) => {
          const candidate = candidatePool.candidates.get(paperId);
          const semanticPaper = semanticInputPapers.get(paperId);
          return !candidate
            || !semanticPaper
            || semanticPaper.title !== candidate.title
            || semanticPaper.abstract !== Array.from(candidate.abstract)
              .slice(0, semanticAbstractChars)
              .join("");
        });
      if (
        malformedSemanticInputPaper
        || semanticPayloadProjectionMismatch
        || semanticInputPapers.size !== reviewedPaperIds.size
        || Array.from(reviewedPaperIds).some(
          (paperId) => !semanticInputPapers.has(paperId)
        )
      ) {
        reasons.push("collect_lineage_topic_semantic_review_input_invalid");
      }
      const observedTotalPapers = numberValue(observed?.total_papers);
      const observedRelevantPapers = numberValue(observed?.relevant_papers);
      const observedRelevantShare = numberValue(observed?.relevant_share);
      const observedLexicalRelevantPapers = numberValue(
        observed?.lexical_relevant_papers
      );
      const observedSemanticRequestedPapers = numberValue(
        observed?.semantic_requested_papers
      );
      const observedDirectSupportPapers = numberValue(
        observed?.direct_support_papers
      );
      const observedApplicationOnlyPairs = numberValue(
        observed?.application_only_pairs
      );
      const observedUncertainPairs = numberValue(observed?.uncertain_pairs);
      const observedRequiredAnchorMatches = numberValue(
        observed?.required_anchor_matches_per_paper
      );
      const observedAnchorProximatePapers = numberValue(
        observed?.anchor_proximate_papers
      );
      const observedAnchorAxisProximatePapers = numberValue(
        observed?.anchor_axis_proximate_papers
      );
      const observedCoveredQueryFamilies = numberValue(
        observed?.covered_query_families
      );
      const expectedRelevantShare = observedTotalPapers && observedTotalPapers > 0
        ? directSupportPaperIds.size / observedTotalPapers
        : 0;
      if (
        observedTotalPapers === undefined
        || !Number.isInteger(observedTotalPapers)
        || observedTotalPapers !== qualityPaperInventory.size
        || observedRelevantPapers !== retainedPaperIdSet.size
        || observedRelevantShare !== expectedRelevantShare
        || observedLexicalRelevantPapers !== semanticPairUniverse.lexicalPaperIds.size
        || observedSemanticRequestedPapers !== semanticInputPapers.size
        || observedDirectSupportPapers !== directSupportPaperIds.size
        || observedApplicationOnlyPairs !== verdictCounts.applicationOnly
        || observedUncertainPairs !== verdictCounts.uncertain
        || observedRequiredAnchorMatches !== plannedFamilies.sharedAnchorTerms?.length
        || observedAnchorProximatePapers === undefined
        || !Number.isInteger(observedAnchorProximatePapers)
        || observedAnchorProximatePapers < 0
        || observedAnchorProximatePapers > observedTotalPapers
        || observedAnchorAxisProximatePapers === undefined
        || !Number.isInteger(observedAnchorAxisProximatePapers)
        || observedAnchorAxisProximatePapers < 0
        || observedAnchorAxisProximatePapers > observedAnchorProximatePapers
        || observedCoveredQueryFamilies !== coveredQueryFamilyCount
        || Array.from(semanticInputPapers.keys()).some(
          (paperId) => !qualityPaperInventory.has(paperId)
        )
      ) {
        reasons.push("collect_lineage_topic_family_quality_observed_mismatch");
      }
      const invalidDirectEvidence = Array.from(reviewJudgments.judgments.values())
        .filter((judgment) => judgment.verdict === "direct_support")
        .some((judgment) => {
          const paper = semanticInputPapers.get(judgment.paperId);
          return !paper
            || !judgment.evidenceSpan
            || (!paper.title.includes(judgment.evidenceSpan)
              && !paper.abstract.includes(judgment.evidenceSpan));
        });
      if (
        !sameKeySet(corpusDirectPairKeys, retainedDirectReviewPairKeys)
        || invalidDirectEvidence
      ) {
        reasons.push("collect_lineage_topic_semantic_direct_support_mismatch");
      }
    }
  }
  return {
    modern: true,
    valid: reasons.length === 0,
    expectedAttemptId,
    requiredQueryFamilies,
    queryFamilies,
    sharedAnchorTerms,
    reasons: Array.from(new Set(reasons))
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function createAnalyzePapersNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "analyze_papers",
    async execute({ run, abortSignal }) {
      const emitLog = (text: string) => {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "analyze_papers",
          payload: {
            text
          }
        });
      };
      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      const memoryRawBrief = await runContextMemory.get<string>("run_brief.raw");
      const researchModeGuard = await resolveResearchRunModeGuard({
        workspaceRoot: process.cwd(),
        runId: run.id,
        rawBrief: memoryRawBrief,
        run
      });
      await runContextMemory.put("research_governance.mode_guard", researchModeGuard);
      await writeRunArtifact(
        run,
        "governance/research_mode_guard.json",
        `${JSON.stringify(researchModeGuard, null, 2)}\n`
      );
      if (!researchModeGuard.valid) {
        const error =
          "analyze_papers blocked because the persisted research mode and evidence lineage do not agree: "
          + researchModeGuard.reasons.join(", ");
        emitLog(error);
        return {
          status: "failure",
          error,
          summary: error,
          toolCallsUsed: 0
        };
      }
      const corpusRows = await readCorpusRows(run.id);
      const collectLineageAudit = await auditCollectAnalysisLineage({
        run,
        runContextMemory,
        corpusRows,
        topicDiscoveryRequired: researchModeGuard.effectiveMode === "topic_discovery"
      });
      await writeRunArtifact(
        run,
        "analysis/collect_lineage_gate.json",
        `${JSON.stringify({
          version: 1,
          kind: "analyze_collect_lineage_gate",
          valid: collectLineageAudit.valid,
          collect_attempt_id: collectLineageAudit.expectedAttemptId,
          reasons: collectLineageAudit.reasons,
          checked_at: new Date().toISOString()
        }, null, 2)}\n`
      );
      if (!collectLineageAudit.valid) {
        const error =
          "analyze_papers blocked because the latest collect_papers lineage is not internally consistent: "
          + collectLineageAudit.reasons.join(", ");
        emitLog(error);
        return {
          status: "failure",
          error,
          summary: error,
          toolCallsUsed: 0
        };
      }
      const corpusFingerprint = buildCorpusFingerprint(corpusRows);
      const analysisMode = getPdfAnalysisModeForConfig(deps.config);
      const artifactsRoot = runArtifactsDir(run);
      const manifestPath = path.join(artifactsRoot, "analysis_manifest.json");
      const summaryPath = path.join(artifactsRoot, "paper_summaries.jsonl");
      const evidencePath = path.join(artifactsRoot, "evidence_store.jsonl");

      const initialManifest = await readExistingManifest(manifestPath);
      const loadedRequest = await loadAnalysisSelectionRequest(
        runContextMemory,
        corpusRows.length,
        initialManifest?.request
      );
      let request = loadedRequest.request;
      if (loadedRequest.autoDefaultReason) {
        emitLog(loadedRequest.autoDefaultReason);
      }
      const topicFamilyCount = collectLineageAudit.requiredQueryFamilies?.length
        ?? countDistinctQueryFamilies(corpusRows);
      if (
        request.selectionMode === "top_n" &&
        request.topN &&
        request.topN < topicFamilyCount
      ) {
        const expandedTopN = Math.min(
          corpusRows.length,
          DEFAULT_SAFE_ANALYSIS_TOP_N,
          topicFamilyCount
        );
        if (expandedTopN > request.topN) {
          emitLog(
            `Auto-expanded analysis selection from top ${request.topN} to top ${expandedTopN} ` +
            `so ${topicFamilyCount} nonempty topic-discovery query families can each be represented.`
          );
          request = normalizeAnalysisSelectionRequest(expandedTopN);
        }
      }
      if (corpusRows.length === 0) {
        const suggestedLimit = Math.max(1, deps.config.papers?.max_results ?? 200);
        const existingSummaryRows = await readSummaryRows(summaryPath);
        const existingEvidenceRows = await readEvidenceRows(evidencePath);
        if (initialManifest && existingSummaryRows.length > 0 && existingEvidenceRows.length > 0) {
          const preservedSelectedCount = initialManifest.selectedPaperIds.length;
          const preservedTotalCandidates = initialManifest.totalCandidates;
          const preservationReason =
            `Preserving ${existingSummaryRows.length} summary row(s) and ${existingEvidenceRows.length} evidence row(s) ` +
            `because the collected corpus regressed to 0 candidate(s) without a new analysis request.`;
          await syncAnalysisProgress(runContextMemory, {
            runContextPath: run.memoryRefs.runContextPath,
            summaryRows: existingSummaryRows,
            evidenceRows: existingEvidenceRows,
            selectedCount: preservedSelectedCount,
            totalCandidates: preservedTotalCandidates,
            selectionFingerprint: initialManifest.selectionFingerprint
          });
          emitLog(
            `${preservationReason} Manual review is required before replacing the recovered artifacts because collect_papers data is missing.`
          );
          return {
            status: "success",
            summary:
              `${preservationReason} Approval can continue with the preserved partial analysis, or you can re-run collect_papers after reviewing the corpus regression.`,
            needsApproval: true,
            toolCallsUsed: 0,
            transitionRecommendation: createAnalyzePapersManualReviewRecommendation({
              runId: run.id,
              reason:
                "analyze_papers preserved the previous partial analysis because corpus.jsonl is now empty even though prior evidence already exists.",
              confidence: 0.98,
              evidence: [
                `${existingSummaryRows.length} summary row(s) and ${existingEvidenceRows.length} evidence item(s) already exist on disk.`,
                `The previous selection covered ${preservedSelectedCount}/${preservedTotalCandidates} candidates.`,
                "corpus.jsonl is currently empty, so a fresh analyze_papers run would have no shortlist to execute."
              ],
              suggestedCommands: [
                `/agent collect --limit ${suggestedLimit} --run ${run.id}`
              ]
            })
          };
        }
        emitLog("No corpus rows are available for analyze_papers. Run collect_papers before attempting analysis.");
        return {
          status: "success",
          summary: "analyze_papers paused because no collected corpus rows are currently available.",
          needsApproval: true,
          toolCallsUsed: 0,
          transitionRecommendation: createAnalyzePapersManualReviewRecommendation({
            runId: run.id,
            reason:
              "analyze_papers requires a collected corpus, but corpus.jsonl is currently missing or empty.",
            confidence: 0.99,
            evidence: [
              "corpus.jsonl did not contain any parseable paper rows.",
              "No selection shortlist can be built until collect_papers repopulates the research corpus."
            ],
            suggestedCommands: [
              `/agent collect --limit ${suggestedLimit} --run ${run.id}`,
              `/agent run collect_papers ${run.id}`
            ]
          })
        };
      }
      const corpusChangedFromInitialManifest = Boolean(
        initialManifest?.corpusFingerprint &&
          initialManifest.corpusFingerprint !== corpusFingerprint
      );
      if (corpusChangedFromInitialManifest) {
        await fs.rm(manifestPath, { force: true });
        await resetAnalysisOutputs(run, summaryPath, evidencePath);
        emitLog(
          "Collected corpus fingerprint changed. Discarding the previous analysis manifest, summaries, and evidence before selecting and analyzing the new corpus."
        );
      }
      const includePageImages =
        deps.config.providers?.llm_mode === "codex" ||
        deps.config.providers?.llm_mode === "codex_chatgpt_only" ||
        analysisMode === "ollama_vision";
      const openAiModel = deps.config.providers?.openai?.model || DEFAULT_OPENAI_RESPONSES_MODEL;
      const openAiReasoningEffort =
        deps.config.providers?.openai?.reasoning_effort || DEFAULT_OPENAI_RESPONSES_REASONING_EFFORT;
      const analysisFingerprint = buildAnalysisFingerprint({
        analysisMode,
        responsesModel: openAiModel,
        responsesReasoningEffort: openAiReasoningEffort,
        includePageImages
      });
      const codexPreflightFailures = await runAnalyzeCodexPreflight({
        codex: deps.codex,
        llmMode: deps.config.providers?.llm_mode,
        analysisMode,
        researchModel: deps.config.providers?.codex?.model
      });
      if (codexPreflightFailures.length > 0) {
        for (const check of codexPreflightFailures) {
          emitLog(`Codex preflight failed [${check.name}]: ${check.detail}`);
        }
        const modelBlocked = codexPreflightFailures.some((check) => isCodexModelCheck(check.name));
        return {
          status: "success",
          summary: modelBlocked
            ? "analyze_papers paused before starting because the configured Codex research backend model is not approved for long-running rerank or paper analysis."
            : "analyze_papers paused before starting because the Codex CLI environment is not writable or ready for rerank/paper analysis.",
          needsApproval: true,
          toolCallsUsed: 0,
          transitionRecommendation: createAnalyzePapersManualReviewRecommendation({
            runId: run.id,
            reason: modelBlocked
              ? "analyze_papers requires a non-Spark Codex research backend model for long-running rerank and paper analysis work, so the current model selection must be changed before continuing."
              : "analyze_papers is blocked by the current Codex CLI environment, so rerank and paper analysis should not start until /doctor passes.",
            confidence: 0.98,
            evidence: codexPreflightFailures.map((check) => `${check.name}: ${check.detail}`),
            suggestedCommands: ["/doctor", "/model", `/agent run analyze_papers ${run.id}`]
          })
        };
      }
      await syncAnalyzeRunRecord({
        runStore: deps.runStore,
        runId: run.id,
        summary: buildAnalyzeStartSummary({
          request,
          totalCandidates: corpusRows.length
        })
      });
      let autoExpansionCount = 0;
      let autoExpansionReason: string | undefined;
      const startedWithExistingManifest = Boolean(initialManifest) && !corpusChangedFromInitialManifest;

      while (true) {
        await runContextMemory.put("analyze_papers.request", request);
        const selectionRequestFingerprint = buildSelectionRequestFingerprint(request, run.title, run.topic);
        const existingManifest = await readExistingManifest(manifestPath);
        const reuseCachedSelection = canReuseManifestSelection(
          existingManifest,
          request,
          selectionRequestFingerprint,
          corpusFingerprint,
          corpusRows
        );

        const rawSelection = reuseCachedSelection
          ? restoreSelectionFromManifest(existingManifest as AnalysisManifest, corpusRows)
          : await (async () => {
              emitLog(
                request.selectionMode === "top_n" && request.topN
                  ? `Ranking ${corpusRows.length} papers and selecting the top ${request.topN} for analysis.`
                  : `Analyzing all ${corpusRows.length} collected papers.`
              );
              return selectPapersForAnalysis({
                llm: deps.llm,
                rerankLlm: createSelectionRerankLlm(deps),
                runTitle: run.title,
                runTopic: run.topic,
                corpusRows,
                request,
                onProgress: (text) => emitLog(text),
                abortSignal
              });
            })();
        const selectionGuard = applySelectionQualitySafeguards({
          selection: rawSelection,
          runTitle: run.title,
          runTopic: run.topic
        });
        const selection = applyTopicFamilyCoverageFloor({
          selection: selectionGuard.selection,
          runTitle: run.title,
          runTopic: run.topic,
          requiredQueryFamilies: collectLineageAudit.requiredQueryFamilies,
          eligiblePaperIds: selectionGuard.eligiblePaperIds
            ? new Set(selectionGuard.eligiblePaperIds)
            : undefined
        });

        if (existingManifest && reuseCachedSelection) {
          emitLog(
            request.selectionMode === "top_n" && request.topN
              ? `Reusing cached paper rerank from analysis_manifest.json for top ${request.topN}; skipping a new LLM rerank.`
              : "Reusing cached paper selection from analysis_manifest.json."
          );
        }
        if (selectionGuard.applied && selectionGuard.reason) {
          emitLog(selectionGuard.reason);
        }
        if (selection.topicFamilyCoverage) {
          const coverage = selection.topicFamilyCoverage;
          emitLog(
            `Topic-family coverage selected ${coverage.selectedFamilies.length}/${coverage.availableFamilies.length} ` +
            `nonempty family/families with ${coverage.reservedPaperIds.length} reserved representative(s)` +
            `${coverage.applied ? `; promoted ${coverage.addedPaperIds.length} and dropped ${coverage.droppedPaperIds.length}` : ""}.`
          );
          if (!coverage.coverageComplete) {
            const uncoveredFamilySet = new Set(coverage.uncoveredFamilies);
            const eligiblePaperIdSet = new Set(
              selectionGuard.eligiblePaperIds ??
              rawSelection.rankedCandidates.map((candidate) => candidate.paper.paper_id)
            );
            const queryFamilyFeedback = collectLineageAudit.queryFamilies ?? [];
            const rejectedQueries = queryFamilyFeedback
              .filter((family) => uncoveredFamilySet.has(family.queryFamily))
              .map((family) => family.query);
            const queryPlanFeedback = rejectedQueries.length > 0
              ? await recordLiteratureQueryPlanRejection(runContextMemory, {
                  rejectedQueries,
                  qualityReasons: coverage.uncoveredFamilies.map(
                    (queryFamily) =>
                      `analysis_topic_family_uncovered_after_quality_filter:${queryFamily}`
                  ),
                  sharedAnchorTerms: collectLineageAudit.sharedAnchorTerms ?? [],
                  candidateTitles: rawSelection.rankedCandidates
                    .filter((candidate) => eligiblePaperIdSet.has(candidate.paper.paper_id))
                    .map((candidate) => candidate.paper.title),
                  queryFamilies: queryFamilyFeedback.map((family) => ({
                    queryFamily: family.queryFamily,
                    query: family.query,
                    axisTerms: family.axisTerms,
                    relevantPaperCount: family.relevantPaperCount
                  })),
                  supportedQueryFamilies: queryFamilyFeedback
                    .filter(
                      (family) =>
                        family.relevantPaperCount > 0 &&
                        !uncoveredFamilySet.has(family.queryFamily)
                    )
                    .map((family) => ({
                      queryFamily: family.queryFamily,
                      query: family.query,
                      axisTerms: family.axisTerms,
                      relevantPaperCount: family.relevantPaperCount
                    }))
                })
              : undefined;
            const gateArtifactPath = "analysis/topic_family_coverage_gate.json";
            await writeRunArtifact(
              run,
              gateArtifactPath,
              `${JSON.stringify({
                version: 1,
                kind: "topic_family_analysis_coverage_gate",
                status: "blocked",
                collect_attempt_id: collectLineageAudit.expectedAttemptId,
                corpus_fingerprint: corpusFingerprint,
                selection_semantics_version: ANALYSIS_SELECTION_SEMANTICS_VERSION,
                selection_request: request,
                selection_quality_guard: {
                  applied: selectionGuard.applied,
                  reason: selectionGuard.reason,
                  dropped_paper_ids: selectionGuard.droppedPaperIds,
                  added_paper_ids: selectionGuard.addedPaperIds,
                  eligible_paper_ids: Array.from(eligiblePaperIdSet).sort()
                },
                topic_family_coverage: coverage,
                family_candidates: coverage.availableFamilies.map((family) => ({
                  query_family: family.queryFamily,
                  candidate_count: family.candidateCount,
                  candidates: rawSelection.rankedCandidates
                    .filter((candidate) =>
                      candidate.paper.query_families?.includes(family.queryFamily)
                    )
                    .map((candidate) => ({
                      paper_id: candidate.paper.paper_id,
                      title: candidate.paper.title,
                      eligible_after_quality_guard: eligiblePaperIdSet.has(candidate.paper.paper_id),
                      selected: selection.selectedPaperIds.includes(candidate.paper.paper_id),
                      deterministic_score: candidate.deterministicScore,
                      selection_score: candidate.selectionScore,
                      abstract_available: Boolean(candidate.paper.abstract?.trim()),
                      pdf_locator_available: Boolean(candidate.paper.pdf_url?.trim())
                    }))
                })),
                query_plan_feedback: queryPlanFeedback,
                checked_at: new Date().toISOString()
              }, null, 2)}\n`
            );
            await runContextMemory.put("analyze_papers.topic_family_coverage_status", "blocked");
            await runContextMemory.put(
              "analyze_papers.uncovered_query_families",
              coverage.uncoveredFamilies
            );
            return {
              status: "success",
              summary:
                "analyze_papers paused because the bounded shortlist could not represent every nonempty topic-discovery query family.",
              needsApproval: true,
              toolCallsUsed: 0,
              transitionRecommendation: {
                action: "backtrack_to_collection",
                sourceNode: "analyze_papers",
                targetNode: "collect_papers",
                reason:
                  "One or more nonempty topic-discovery query families had no analysis-eligible representative; replace the failed literature query family before hypothesis generation.",
                confidence: 0.97,
                autoExecutable: true,
                evidence: [
                  `${coverage.selectedFamilies.length}/${coverage.availableFamilies.length} nonempty query families are represented.`,
                  `Uncovered families: ${coverage.uncoveredFamilies.join(", ") || "none"}.`,
                  `Selection target: ${coverage.targetCount} paper(s).`,
                  `Diagnostic: ${gateArtifactPath}`
                ],
                suggestedCommands: [
                  "/agent apply",
                  `/agent run collect_papers ${run.id}`
                ],
                generatedAt: new Date().toISOString()
              }
            };
          }
        }
        if (
          selection.request.selectionMode === "top_n" &&
          selection.request.topN &&
          selection.selectedPaperIds.length === 0 &&
          selection.rerankFallbackReason
        ) {
          const rerankFailure = cleanFailureMessage(selection.rerankFallbackReason);
          emitLog(
            `LLM rerank failed. Top ${selection.request.topN} selection requires a successful model rerank (${rerankFailure}).`
          );
          return {
            status: "success",
            summary: `analyze_papers paused because LLM rerank for top ${selection.request.topN} failed before a shortlist was accepted.`,
            needsApproval: true,
            toolCallsUsed: 0,
            transitionRecommendation: createAnalyzePapersManualReviewRecommendation({
              runId: run.id,
              reason:
                `analyze_papers requires a successful LLM rerank to choose the top ${selection.request.topN} papers, ` +
                `but rerank failed before any shortlist was accepted.`,
              confidence: 0.97,
              evidence: [
                `Rerank failure: ${rerankFailure}.`,
                `Top-N request: ${selection.request.topN} from ${selection.totalCandidates} candidate(s).`,
                "Deterministic pre-rank completed, but no deterministic fallback shortlist was accepted."
              ],
              suggestedCommands: [`/agent retry analyze_papers ${run.id}`, "/model"]
            })
          };
        }
        if (rawSelection.selectedPaperIds.length > 0 && selection.selectedPaperIds.length === 0) {
          emitLog(
            `Selection quality safeguard removed all ${rawSelection.selectedPaperIds.length} initially selected paper(s); pausing for manual review instead of analyzing an off-topic set.`
          );
          return {
            status: "success",
            summary:
              request.selectionMode === "top_n" && request.topN
                ? `analyze_papers paused because the top ${request.topN} selection candidates did not match the research-specific anchors strongly enough after fallback safeguards.`
                : "analyze_papers paused because the selected papers did not match the research-specific anchors strongly enough after fallback safeguards.",
            needsApproval: true,
            toolCallsUsed: 0,
            transitionRecommendation: createAnalyzePapersManualReviewRecommendation({
              runId: run.id,
              reason:
                "analyze_papers rejected the current selected paper set because the fallback/off-topic safeguard found no candidate that matched the research-specific anchors strongly enough.",
              confidence: 0.95,
              evidence: [
                `${rawSelection.selectedPaperIds.length} initially selected paper(s) were filtered by the selection quality guard.`,
                selectionGuard.reason || "No guard reason recorded.",
                `Research title/topic: ${run.title || run.topic}`
              ],
              suggestedCommands: [`/agent run analyze_papers ${run.id}`, "/model"]
            })
          };
        }

        deps.eventStream.emit({
          type: "PLAN_CREATED",
          runId: run.id,
          node: "analyze_papers",
          payload: {
            selectionMode: selection.request.selectionMode,
            selectedCount: selection.selectedPaperIds.length,
            totalCandidates: selection.totalCandidates,
            candidatePoolSize: selection.candidatePoolSize,
            rerankApplied: selection.rerankApplied
          }
        });

        if (selection.rerankApplied) {
          emitLog(`Hybrid rerank selected ${selection.selectedPaperIds.length} paper(s) from ${selection.totalCandidates} candidate(s).`);
        }
        if (selection.deterministicRankingPreview.length > 0) {
          emitLog(
            `Ranking preview: ${selection.deterministicRankingPreview
              .slice(0, 3)
              .map((row) => `${row.paper_id}=${row.deterministic_score}`)
              .join(", ")}`
          );
        }

        let selectedRows = selection.selectedPaperIds
          .map((paperId) => corpusRows.find((row) => row.paper_id === paperId))
          .filter((row): row is AnalysisCorpusRow => Boolean(row));
        if (
          selectedRows.some((row) => !resolvePaperPdfUrl(row)) &&
          (await isCollectEnrichmentPending(run.id))
        ) {
          emitLog(
            "Collect enrichment is still pending for selected papers without PDFs. Waiting briefly for recovered PDF metadata before source resolution."
          );
        }
        const refreshedSelectedRows = await refreshSelectedRowsFromLatestArtifacts(run.id, selectedRows, {
          selectionMode: request.selectionMode,
          selectedCount: selection.selectedPaperIds.length,
          totalCandidates: selection.totalCandidates
        });
        const upgradedPdfRows = refreshedSelectedRows.filter(
          (row, index) => !resolvePaperPdfUrl(selectedRows[index]) && Boolean(resolvePaperPdfUrl(row))
        ).length;
        if (upgradedPdfRows > 0) {
          emitLog(
            `Detected recovered PDF metadata for ${upgradedPdfRows}/${refreshedSelectedRows.length} selected paper(s) after analyze_papers started. Using refreshed corpus rows for source resolution.`
          );
        }
        selectedRows = refreshedSelectedRows;

        if (
          analysisMode === "responses_api_pdf" &&
          selectedRows.some((row) => Boolean(resolvePaperPdfUrl(row))) &&
          !(await deps.responsesPdfAnalysis.hasApiKey())
        ) {
          return {
            status: "failure",
            summary: "Responses API PDF analysis is selected, but OPENAI_API_KEY is not configured.",
            error: "OPENAI_API_KEY is required when PDF analysis mode is set to Responses API.",
            toolCallsUsed: 0
          };
        }

        const canExtendExistingManifest = Boolean(
          existingManifest &&
            canExtendManifestForExpandedSelection(
              existingManifest,
              selection,
              analysisFingerprint,
              corpusFingerprint
            )
        );
        const canRetargetExistingManifest = Boolean(
          existingManifest &&
            canRetargetManifestForSelectionChange(
              existingManifest,
              selection,
              analysisFingerprint,
              selectionRequestFingerprint,
              corpusFingerprint
            )
        );
        let existingSummaryRows = await readSummaryRows(summaryPath);
        let existingEvidenceRows = await readEvidenceRows(evidencePath);
        const resetReason =
          existingManifest &&
          existingManifest.corpusFingerprint &&
          existingManifest.corpusFingerprint !== corpusFingerprint
            ? "corpus_changed"
            : existingManifest && existingManifest.selectionFingerprint !== selection.selectionFingerprint
              ? "selection_changed"
              : existingManifest && (!existingManifest.analysisFingerprint || !existingManifest.corpusFingerprint)
                ? "compatibility_manifest"
                : existingManifest && existingManifest.analysisFingerprint !== analysisFingerprint
                  ? "analysis_config_changed"
                  : undefined;
        const retargetedSelection =
          canRetargetExistingManifest && existingManifest
            ? retargetManifestForSelectionChange(
                existingManifest,
                selection,
                existingSummaryRows,
                existingEvidenceRows,
                analysisFingerprint,
                selectionRequestFingerprint,
                corpusFingerprint
              )
            : undefined;
        if (retargetedSelection) {
          existingSummaryRows = retargetedSelection.summaryRows;
          existingEvidenceRows = retargetedSelection.evidenceRows;
        }
        let manifest: AnalysisManifest | undefined =
          existingManifest &&
          existingManifest.selectionFingerprint === selection.selectionFingerprint &&
          existingManifest.analysisFingerprint === analysisFingerprint &&
          existingManifest.corpusFingerprint === corpusFingerprint
            ? existingManifest
            : canExtendExistingManifest && existingManifest
              ? extendManifestForExpandedSelection(
                  existingManifest,
                  selection,
                  analysisFingerprint,
                  selectionRequestFingerprint,
                  corpusFingerprint
                )
              : retargetedSelection?.manifest;

        if (!manifest && !existingManifest && selection.request.selectionMode === "all") {
          manifest = await bootstrapManifestFromExistingOutputs(
            selection,
            summaryPath,
            evidencePath,
            analysisFingerprint,
            selectionRequestFingerprint,
            corpusFingerprint
          );
          await writeAnalysisManifest(run, manifest);
        }

        if (!manifest) {
          if (resetReason === "corpus_changed") {
            emitLog("Collected corpus changed since the previous analysis. Resetting summaries/evidence and re-analyzing the new paper set.");
          } else if (resetReason === "selection_changed") {
            emitLog("Analysis selection changed since the previous run. Resetting summaries/evidence for the new paper set.");
          } else if (resetReason === "compatibility_manifest") {
            emitLog("Existing analysis manifest lacks configuration fingerprint metadata. Resetting summaries/evidence to rebuild a consistent analysis state.");
          } else if (resetReason === "analysis_config_changed") {
            emitLog("Analysis settings changed since the previous run. Resetting summaries/evidence and re-analyzing the selected papers.");
          }
          await resetAnalysisOutputs(run, summaryPath, evidencePath);
          existingSummaryRows = [];
          existingEvidenceRows = [];
          manifest = createFreshManifest(selection, analysisFingerprint, selectionRequestFingerprint, corpusFingerprint);
          await writeAnalysisManifest(run, manifest);
        } else if (canExtendExistingManifest && existingManifest) {
          emitLog(
            `Expanding analysis selection from top ${existingManifest.selectedPaperIds.length} to top ${selection.selectedPaperIds.length}; preserving completed analyses and queueing only the new papers.`
          );
          await writeAnalysisManifest(run, manifest);
        } else if (retargetedSelection) {
          emitLog(retargetedSelection.logMessage);
          await appendJsonl(run, "paper_summaries.jsonl", existingSummaryRows);
          await appendJsonl(run, "evidence_store.jsonl", existingEvidenceRows);
          await writeAnalysisManifest(run, manifest);
        }

        const refreshedManifest = hydrateSelectedManifestEntriesFromRows(manifest, selectedRows);
        if (refreshedManifest !== manifest) {
          manifest = refreshedManifest;
          await writeAnalysisManifest(run, manifest);
        }

        const reconciledState = reconcileManifestWithOutputs(manifest, existingSummaryRows, existingEvidenceRows);
        let manifestState: AnalysisManifest = reconciledState.manifest;
        if (reconciledState.changed) {
          if (reconciledState.requeuedPaperIds.length > 0 || reconciledState.droppedSummaryRows > 0 || reconciledState.droppedEvidenceRows > 0) {
            emitLog(
              `Detected inconsistent analysis artifacts. Re-queueing ${reconciledState.requeuedPaperIds.length} completed paper(s) and pruning ${reconciledState.droppedSummaryRows} summary row(s) / ${reconciledState.droppedEvidenceRows} evidence row(s).`
            );
          } else {
            emitLog("Reconciled analysis manifest metadata with the persisted summaries/evidence.");
          }
          await appendJsonl(run, "paper_summaries.jsonl", reconciledState.summaryRows);
          await appendJsonl(run, "evidence_store.jsonl", reconciledState.evidenceRows);
          await writeAnalysisManifest(run, manifestState);
        }
        let summaryRowsState = reconciledState.summaryRows;
        let evidenceRowsState = reconciledState.evidenceRows;
        await syncAnalysisProgress(runContextMemory, {
          runContextPath: run.memoryRefs.runContextPath,
          summaryRows: summaryRowsState,
          evidenceRows: evidenceRowsState,
          selectedCount: selection.selectedPaperIds.length,
          totalCandidates: selection.totalCandidates,
          selectionFingerprint: selection.selectionFingerprint
        });
        await syncAnalyzeRunRecord({
          runStore: deps.runStore,
          runId: run.id,
          summary: buildAnalyzeProgressSummary({
            request,
            selectedCount: selection.selectedPaperIds.length,
            totalCandidates: selection.totalCandidates,
            progress: buildAnalysisProgress(summaryRowsState, evidenceRowsState),
            failedCount: 0,
            analysisMode
          })
        });

        const pendingRows = selectedRows.filter((row) => manifestState.papers[row.paper_id]?.status !== "completed");
        const previousFailedPaperIds = getSelectedFailedPaperIds(manifestState);
        const startingProgress = buildAnalysisProgress(summaryRowsState, evidenceRowsState);
        const priorRetryCount = run.graph.retryCounters.analyze_papers ?? 0;
        const warmStartSerial =
          startingProgress.summaryRows.length === 0 &&
          startingProgress.evidenceRows.length === 0 &&
          (selection.selectedPaperIds.length >= ZERO_OUTPUT_EARLY_PAUSE_MIN_SELECTED ||
            ((analysisMode === "codex_text_image_hybrid" || analysisMode === "ollama_vision") &&
              request.selectionMode === "all" &&
              selection.selectedPaperIds.length <= SMALL_SELECTION_SERIAL_WARM_START_MAX));
        const standardAnalysisConcurrency = getAnalysisConcurrency(analysisMode);
        const analysisConcurrency = warmStartSerial ? 1 : standardAnalysisConcurrency;
        if (pendingRows.length > 0) {
          emitLog(`Analyzing ${pendingRows.length} paper(s) with concurrency ${analysisConcurrency}.`);
          if (warmStartSerial) {
            emitLog(`Serial warm-start is enabled until the first persisted outputs arrive.`);
          }
        }
        let failedCount = 0;
        let timeoutFailureCount = 0;
        let attemptedRows = 0;
        let zeroOutputPauseDecision: ZeroOutputPauseDecision | undefined;
        const persistQueue = createAsyncQueue();

        const analyzePendingRow = async (initialRow: AnalysisCorpusRow, index: number) => {
            attemptedRows += 1;
            let row = await refreshCorpusRowForSourceResolution(run.id, initialRow, {
              selectionMode: request.selectionMode,
              selectedCount: selection.selectedPaperIds.length,
              totalCandidates: selection.totalCandidates
            });
            if (!resolvePaperPdfUrl(initialRow) && resolvePaperPdfUrl(row)) {
              emitLog(`[${row.paper_id}] Reusing refreshed corpus metadata with a recovered PDF URL.`);
            }
            emitLog(`Analyzing paper ${index + 1}/${pendingRows.length}: "${row.title}".`);
            emitLog(`Resolving analysis source ${index + 1}/${pendingRows.length} for "${row.title}".`);
            const latestRowBeforeSource = await refreshCorpusRowForSourceResolution(run.id, row, {
              selectionMode: request.selectionMode,
              selectedCount: selection.selectedPaperIds.length,
              totalCandidates: selection.totalCandidates
            });
            if (!resolvePaperPdfUrl(row) && resolvePaperPdfUrl(latestRowBeforeSource)) {
              emitLog(`[${latestRowBeforeSource.paper_id}] Reusing refreshed corpus metadata with a recovered PDF URL.`);
            }
            row = latestRowBeforeSource;

            deps.eventStream.emit({
              type: "TOOL_CALLED",
              runId: run.id,
              node: "analyze_papers",
              payload: {
                tool: "analyze_paper",
                paper_id: row.paper_id
              }
            });

            const pdfUrl = resolvePaperPdfUrl(row);
            const useResponsesPdf = analysisMode === "responses_api_pdf" && Boolean(pdfUrl);
            const resolvedSource = await resolvePaperTextSource({
              runId: run.id,
              paper: row,
              includePageImages: useResponsesPdf ? false : includePageImages,
              abortSignal,
              onProgress: (text) => emitLog(`[${row.paper_id}] ${text}`)
            });
            let source = useResponsesPdf && resolvedSource.sourceType !== "full_text"
              ? {
                  ...resolvedSource,
                  sourceType: "full_text" as const,
                  fullTextAvailable: true,
                  pdfUrl,
                  fallbackReason: "responses_pdf_local_verification_abstract_only"
                }
              : resolvedSource;

            let analysisModeUsed: "responses_api_pdf" | "codex_text_image_hybrid" | "ollama_vision" = useResponsesPdf
              ? "responses_api_pdf"
              : (analysisMode === "responses_api_pdf" ? "codex_text_image_hybrid" : analysisMode);
            if (!useResponsesPdf) {
              const retriedSource = await retryResolvedSourceAfterLatePdfRecovery({
                runId: run.id,
                paper: row,
                source,
                includePageImages,
                selectionMode: request.selectionMode,
                selectedCount: selection.selectedPaperIds.length,
                totalCandidates: selection.totalCandidates,
                abortSignal,
                onProgress: (text) => emitLog(`[${row.paper_id}] ${text}`)
              });
              row = retriedSource.paper;
              source = retriedSource.source;
            }
            let analysisAttempts = 0;
            let quarantineRecord: AnalysisQuarantineRow | undefined;

            emitLog(
              useResponsesPdf
                ? `Using Responses API PDF input for "${row.title}".`
                : source.sourceType === "full_text"
                  ? source.pageImagePaths && source.pageImagePaths.length > 0
                    ? `Using full text plus ${source.pageImagePaths.length} rendered PDF page image(s) for "${row.title}".`
                    : `Using full text for "${row.title}".`
                  : source.pageImagePaths && source.pageImagePaths.length > 0
                    ? `Falling back to abstract plus ${source.pageImagePaths.length} rendered PDF page image(s) for "${row.title}" (${source.fallbackReason || "no full text"}).`
                  : `Falling back to abstract for "${row.title}" (${source.fallbackReason || "no full text"}).`
            );

            try {
              await persistQueue.run(async () => {
                const nextManifest: AnalysisManifest = {
                  ...manifestState,
                  papers: { ...manifestState.papers }
                };
                const manifestEntry = manifestState.papers[row.paper_id];
                nextManifest.papers[row.paper_id] = {
                  ...manifestEntry,
                  paper_id: row.paper_id,
                  title: row.title,
                  status: "running",
                  selected: true,
                  source_type: source.sourceType,
                  analysis_mode: analysisModeUsed,
                  pdf_url: source.pdfUrl ?? resolvePaperPdfUrl(row),
                  pdf_cache_path: source.pdfCachePath,
                  text_cache_path: source.textCachePath,
                  fallback_reason: source.fallbackReason,
                  last_error: undefined,
                  score_breakdown: refreshPdfAvailabilityScoreBreakdown(manifestEntry?.score_breakdown, row),
                  updatedAt: new Date().toISOString()
                };
                nextManifest.updatedAt = new Date().toISOString();
                await writeAnalysisManifest(run, nextManifest);
                manifestState = nextManifest;
              });

              const sourceMismatchError = validateResolvedSourceIdentity(row, source);
              if (sourceMismatchError) {
                quarantineRecord = buildAnalysisQuarantineRow({
                  paper: row,
                  source,
                  analysisMode: analysisModeUsed,
                  reason: sourceMismatchError
                });
                throw new Error(sourceMismatchError);
              }

              let analysis;
              if (useResponsesPdf && pdfUrl) {
                try {
                  analysis = await analyzePaperWithResponsesPdf({
                    client: deps.responsesPdfAnalysis,
                    paper: row,
                    source,
                    pdfUrl,
                    model: deps.config.providers?.openai?.model || DEFAULT_OPENAI_RESPONSES_MODEL,
                    reasoningEffort:
                      deps.config.providers?.openai?.reasoning_effort ||
                      DEFAULT_OPENAI_RESPONSES_REASONING_EFFORT,
                    maxAttempts: 2,
                    abortSignal,
                    onProgress: (text) => emitLog(`[${row.paper_id}] ${text}`)
                  });
                } catch (error) {
                  if (!shouldFallbackResponsesPdfToLocalText(error)) {
                    throw error;
                  }
                  const reason = error instanceof Error ? error.message : String(error);
                  emitLog(
                    `[${row.paper_id}] Responses API could not download the remote PDF (${reason}). Falling back to local PDF download/text-plus-image analysis.`
                  );
                  source = await resolvePaperTextSource({
                    runId: run.id,
                    paper: row,
                    includePageImages,
                    abortSignal,
                    onProgress: (text) => emitLog(`[${row.paper_id}] ${text}`)
                  });
                  analysisModeUsed = "codex_text_image_hybrid";
                  const fallbackSourceMismatchError = validateResolvedSourceIdentity(row, source);
                  if (fallbackSourceMismatchError) {
                    quarantineRecord = buildAnalysisQuarantineRow({
                      paper: row,
                      source,
                      analysisMode: analysisModeUsed,
                      reason: fallbackSourceMismatchError
                    });
                    throw new Error(fallbackSourceMismatchError);
                  }
                  emitLog(
                    source.sourceType === "full_text"
                      ? source.pageImagePaths && source.pageImagePaths.length > 0
                        ? `Using locally extracted full text plus ${source.pageImagePaths.length} rendered PDF page image(s) for "${row.title}" after Responses API fallback.`
                        : `Using locally extracted full text for "${row.title}" after Responses API fallback.`
                      : source.pageImagePaths && source.pageImagePaths.length > 0
                        ? `Falling back to abstract plus ${source.pageImagePaths.length} rendered PDF page image(s) for "${row.title}" after Responses API fallback (${source.fallbackReason || "no full text"}).`
                      : `Falling back to abstract for "${row.title}" after Responses API fallback (${source.fallbackReason || "no full text"}).`
                  );
                  const localFallbackAnalysis = await analyzePaperWithPageImageTimeoutFallback({
                    llm: source.sourceType === "full_text" ? deps.pdfTextLlm : deps.llm,
                    paper: row,
                    source,
                    abortSignal,
                    onProgress: (text) => emitLog(`[${row.paper_id}] ${text}`)
                  });
                  analysis = localFallbackAnalysis.analysis;
                  source = localFallbackAnalysis.source;
                }
              } else if (
                analysisModeUsed === "ollama_vision" &&
                deps.ollamaPdfAnalysis &&
                source.pageImagePaths &&
                source.pageImagePaths.length > 0
              ) {
                emitLog(
                  `[${row.paper_id}] Using Ollama vision batching (${source.pageImagePaths.length} page image(s)).`
                );
                const ollamaVisionResult = await analyzePaperWithOllamaVisionBatch({
                  ollamaPdfAnalysis: deps.ollamaPdfAnalysis,
                  llm: deps.pdfTextLlm,
                  paper: row,
                  source,
                  abortSignal,
                  onProgress: (text) => emitLog(`[${row.paper_id}] ${text}`)
                });
                analysis = ollamaVisionResult.analysis;
                source = ollamaVisionResult.source;
              } else {
                const localFallbackAnalysis = await analyzePaperWithPageImageTimeoutFallback({
                  llm: source.sourceType === "full_text" ? deps.pdfTextLlm : deps.llm,
                  paper: row,
                  source,
                  abortSignal,
                  onProgress: (text) => emitLog(`[${row.paper_id}] ${text}`)
                });
                analysis = localFallbackAnalysis.analysis;
                source = localFallbackAnalysis.source;
              }
              analysisAttempts = analysis.attempts;
              const analysisMismatchError = validateAnalysisBeforePersist(row, source, analysis);
              if (analysisMismatchError) {
                quarantineRecord = buildAnalysisQuarantineRow({
                  paper: row,
                  source,
                  analysis,
                  analysisMode: analysisModeUsed,
                  reason: analysisMismatchError
                });
                throw new Error(analysisMismatchError);
              }

              await persistQueue.run(async () => {
                const structureSignals = analyzeStructureSignals(source.text);
                const nextSummaryRowsState = replaceSummaryRow(summaryRowsState, analysis.summaryRow);
                const nextEvidenceRowsState = replaceEvidenceRowsForPaper(evidenceRowsState, row.paper_id, analysis.evidenceRows);
                const nextManifest: AnalysisManifest = {
                  ...manifestState,
                  papers: { ...manifestState.papers }
                };

                const manifestEntry = manifestState.papers[row.paper_id];
                nextManifest.papers[row.paper_id] = {
                  ...manifestEntry,
                  paper_id: row.paper_id,
                  title: row.title,
                  status: "completed",
                  selected: true,
                  source_type: source.sourceType,
                  summary_count: 1,
                  evidence_count: analysis.evidenceRows.length,
                  analysis_attempts: analysis.attempts,
                  analysis_mode: analysisModeUsed,
                  pdf_url: source.pdfUrl ?? resolvePaperPdfUrl(row),
                  pdf_cache_path: source.pdfCachePath,
                  text_cache_path: source.textCachePath,
                  fallback_reason: source.fallbackReason,
                  last_error: undefined,
                  score_breakdown: refreshPdfAvailabilityScoreBreakdown(manifestEntry?.score_breakdown, row),
                  has_table_references: structureSignals.tableReferenceCount > 0,
                  table_reference_count: structureSignals.tableReferenceCount,
                  has_figure_references: structureSignals.figureReferenceCount > 0,
                  figure_reference_count: structureSignals.figureReferenceCount,
                  updatedAt: new Date().toISOString(),
                  completedAt: new Date().toISOString()
                };
                nextManifest.updatedAt = new Date().toISOString();
                await appendJsonl(run, "paper_summaries.jsonl", nextSummaryRowsState);
                await appendJsonl(run, "evidence_store.jsonl", nextEvidenceRowsState);
                await writeAnalysisManifest(run, nextManifest);
                await syncAnalysisProgress(runContextMemory, {
                  runContextPath: run.memoryRefs.runContextPath,
                  summaryRows: nextSummaryRowsState,
                  evidenceRows: nextEvidenceRowsState,
                  selectedCount: selection.selectedPaperIds.length,
                  totalCandidates: selection.totalCandidates,
                  selectionFingerprint: selection.selectionFingerprint
                });
                manifestState = nextManifest;
                summaryRowsState = nextSummaryRowsState;
                evidenceRowsState = nextEvidenceRowsState;
                try {
                  await syncAnalyzeRunRecord({
                    runStore: deps.runStore,
                    runId: run.id,
                    summary: buildAnalyzeProgressSummary({
                      request,
                      selectedCount: selection.selectedPaperIds.length,
                      totalCandidates: selection.totalCandidates,
                      progress: buildAnalysisProgress(nextSummaryRowsState, nextEvidenceRowsState),
                      failedCount,
                      analysisMode
                    })
                  });
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  emitLog(
                    `Post-persist run summary refresh failed after writing artifacts for "${row.title}": ${message}`
                  );
                }
                emitLog(
                  `Persisted analysis outputs for "${row.title}" (1 summary row, ${analysis.evidenceRows.length} evidence row(s)).`
                );
              });

              emitLog(`Analyzed "${row.title}" (${analysis.evidenceRows.length} evidence item(s), source=${source.sourceType}).`);
            } catch (error) {
              if (isAbortError(error) && abortSignal?.aborted) {
                throw error;
              }
              failedCount += 1;
              const message = error instanceof Error ? error.message : String(error);
              if (isAnalysisTimeoutError(message)) {
                timeoutFailureCount += 1;
              }
              await persistQueue.run(async () => {
                if (quarantineRecord) {
                  await appendJsonlItems(run, "analysis_quarantine.jsonl", [quarantineRecord]);
                }
                const manifestEntry = manifestState.papers[row.paper_id];
                manifestState.papers[row.paper_id] = {
                  ...manifestEntry,
                  paper_id: row.paper_id,
                  title: row.title,
                  status: "failed",
                  selected: true,
                  source_type: source.sourceType,
                  summary_count: 0,
                  evidence_count: 0,
                  analysis_attempts: analysisAttempts,
                  analysis_mode: analysisModeUsed,
                  pdf_url: source.pdfUrl ?? resolvePaperPdfUrl(row),
                  pdf_cache_path: source.pdfCachePath,
                  text_cache_path: source.textCachePath,
                  fallback_reason: source.fallbackReason,
                  last_error: message,
                  score_breakdown: refreshPdfAvailabilityScoreBreakdown(manifestEntry?.score_breakdown, row),
                  has_table_references: false,
                  table_reference_count: 0,
                  has_figure_references: false,
                  figure_reference_count: 0,
                  updatedAt: new Date().toISOString()
                };
                manifestState.updatedAt = new Date().toISOString();
                await writeAnalysisManifest(run, manifestState);
                await syncAnalyzeRunRecord({
                  runStore: deps.runStore,
                  runId: run.id,
                  summary: buildAnalyzeProgressSummary({
                    request,
                    selectedCount: selection.selectedPaperIds.length,
                    totalCandidates: selection.totalCandidates,
                    progress: buildAnalysisProgress(summaryRowsState, evidenceRowsState),
                    failedCount,
                    analysisMode
                  })
                });
                deps.eventStream.emit({
                  type: "TEST_FAILED",
                  runId: run.id,
                  node: "analyze_papers",
                  payload: {
                    text: `Analysis failed for "${row.title}": ${message}`,
                    error: message
                  }
                });
              });
              const progress = buildAnalysisProgress(summaryRowsState, evidenceRowsState);
              const zeroOutputPause = shouldPauseForZeroOutputStall({
                selectedCount: selection.selectedPaperIds.length,
                attemptedCount: attemptedRows,
                failedCount,
                timeoutFailureCount,
                priorRetryCount,
                progress
              });
              if (zeroOutputPause && !zeroOutputPauseDecision) {
                zeroOutputPauseDecision = zeroOutputPause;
                emitLog(
                  `No summaries or evidence were persisted after ${zeroOutputPause.attemptedCount}/${selection.selectedPaperIds.length} attempted paper analyses. Pausing instead of spending the rest of the selection on the same zero-output failure pattern.`
                );
              }
            }
        };

        try {
          if (warmStartSerial && pendingRows.length > 1) {
            const warmStartRows = pendingRows.slice(0, 1);
            const remainingRows = pendingRows.slice(1);
            await runWithConcurrency(
              warmStartRows,
              1,
              async (row, index) => analyzePendingRow(row, index),
              () => Boolean(zeroOutputPauseDecision)
            );
            if (!zeroOutputPauseDecision && remainingRows.length > 0) {
              const progressAfterWarmStart = buildAnalysisProgress(summaryRowsState, evidenceRowsState);
              const warmStartProducedOutputs =
                progressAfterWarmStart.summaryRows.length > 0 || progressAfterWarmStart.evidenceRows.length > 0;
              if (warmStartProducedOutputs) {
                emitLog(
                  `Warm-start persisted outputs; continuing remaining ${remainingRows.length} paper(s) with concurrency ${standardAnalysisConcurrency}.`
                );
              }
              await runWithConcurrency(
                remainingRows,
                warmStartProducedOutputs ? standardAnalysisConcurrency : 1,
                async (row, index) => analyzePendingRow(row, index + warmStartRows.length),
                () => Boolean(zeroOutputPauseDecision)
              );
            }
          } else {
            await runWithConcurrency(
              pendingRows,
              analysisConcurrency,
              async (row, index) => analyzePendingRow(row, index),
              () => Boolean(zeroOutputPauseDecision)
            );
          }
        } catch (error) {
          if (isAbortError(error)) {
            await persistQueue.onIdle();
          }
          throw error;
        }

        await persistQueue.onIdle();

        const progress = buildAnalysisProgress(summaryRowsState, evidenceRowsState);
        let analysisToolCallsUsed = pendingRows.length > 0 ? Math.max(1, attemptedRows) : 0;
        await syncAnalysisProgress(runContextMemory, {
          runContextPath: run.memoryRefs.runContextPath,
          summaryRows: summaryRowsState,
          evidenceRows: evidenceRowsState,
          selectedCount: selection.selectedPaperIds.length,
          totalCandidates: selection.totalCandidates,
          selectionFingerprint: selection.selectionFingerprint
        });
        emitLog(
          `Analysis totals: summaries=${progress.summaryRows.length}, evidence=${progress.evidenceRows.length}, full_text=${progress.fullTextCount}, abstract_fallback=${progress.abstractFallbackCount}.`
        );
        await writeRunArtifact(
          run,
          "analyze_papers_richness_summary.json",
          JSON.stringify(buildRichnessSummary(progress), null, 2)
        );
        const [corpusRaw, evidenceRaw] = await Promise.all([
          safeRead(path.join(artifactsRoot, "corpus.jsonl")),
          safeRead(evidencePath)
        ]);
        const corpusSha256 = createHash("sha256").update(corpusRaw, "utf8").digest("hex");
        const evidenceSha256 = createHash("sha256").update(evidenceRaw, "utf8").digest("hex");
        const selectedPaperIdSet = new Set(selection.selectedPaperIds);
        const completedPaperIds = Object.values(manifestState.papers)
          .filter((entry) =>
            entry.selected &&
            entry.status === "completed" &&
            selectedPaperIdSet.has(entry.paper_id)
          )
          .map((entry) => entry.paper_id)
          .sort();
        const selectedFailedPaperIds = [...getSelectedFailedPaperIds(manifestState)]
          .filter((paperId) => selectedPaperIdSet.has(paperId))
          .sort();
        const analysisCoverage = {
          selected_paper_count: selection.selectedPaperIds.length,
          completed_paper_count: completedPaperIds.length,
          failed_paper_ids: selectedFailedPaperIds,
          complete:
            selectedFailedPaperIds.length === 0 &&
            completedPaperIds.length === selection.selectedPaperIds.length
        };
        const gapSynthesisContext = {
          runId: run.id,
          researchCycle: run.graph.researchCycle,
          collectAttemptId: collectLineageAudit.expectedAttemptId ?? "",
          corpusSha256,
          evidenceSha256
        };
        const gapSynthesisPath = path.join(artifactsRoot, "analysis", "gap_synthesis.json");
        const cachedGapSynthesis = collectLineageAudit.queryFamilies?.length
          ? parseReusableResearchGapSynthesisArtifact(
              await safeRead(gapSynthesisPath),
              gapSynthesisContext
            )
          : undefined;
        const gapSynthesis = collectLineageAudit.queryFamilies?.length
          ? cachedGapSynthesis?.status === "completed"
            ? { artifact: cachedGapSynthesis, toolCallsUsed: 0 }
            : await synthesizeResearchGapClusters({
                llm: deps.llm,
                evidence: progress.evidenceRows,
                context: gapSynthesisContext,
                runTitle: run.title,
                runTopic: run.topic,
                abortSignal,
                allowModelCalls: analysisCoverage.complete,
                onProgress: (message) => emitLog(message)
              })
          : undefined;
        if (gapSynthesis) {
          analysisToolCallsUsed += gapSynthesis.toolCallsUsed;
          if (cachedGapSynthesis?.status === "completed") {
            emitLog("Reusing hash-bound research-gap semantic synthesis for the unchanged evidence set.");
          } else {
            await writeRunArtifact(
              run,
              "analysis/gap_synthesis.json",
              `${JSON.stringify(gapSynthesis.artifact, null, 2)}\n`
            );
          }
        }
        const gapMap = buildResearchGapMap({
          evidence: progress.evidenceRows,
          semanticClusters: gapSynthesis?.artifact.accepted_clusters.map((cluster) => ({
            opportunity_type: cluster.opportunity_type,
            statement: cluster.statement,
            evidence_ids: cluster.evidence_ids
          })),
          excludedEvidenceIds: gapSynthesis?.artifact.excluded_evidence.map(
            (item) => item.evidence_id
          ),
          constructionMode: !analysisCoverage.complete
            ? "deferred_partial_analysis"
            : gapSynthesis?.artifact.status === "completed"
              ? "reviewed_semantic_synthesis"
              : gapSynthesis
                ? "deterministic_safe_fallback"
                : "legacy_exact_grouping",
          synthesisBinding: gapSynthesis
            ? {
                content_sha256: gapSynthesis.artifact.content_sha256,
                semantics_version: gapSynthesis.artifact.semantics_version,
                status: gapSynthesis.artifact.status
              }
            : undefined,
          analysisCoverage,
          runId: run.id,
          researchCycle: run.graph.researchCycle,
          collectAttemptId: collectLineageAudit.expectedAttemptId,
          corpusSha256,
          corpusByteLength: Buffer.byteLength(corpusRaw, "utf8"),
          evidenceSha256,
          evidenceByteLength: Buffer.byteLength(evidenceRaw, "utf8"),
          sourceArtifacts: gapSynthesis
            ? ["paper_summaries.jsonl", "evidence_store.jsonl", "analysis/gap_synthesis.json"]
            : undefined
        });
        await writeRunArtifact(
          run,
          "analysis/gap_map.json",
          `${JSON.stringify(gapMap, null, 2)}\n`
        );
        await runContextMemory.put("analyze_papers.gap_candidate_count", gapMap.gaps.length);
        await runContextMemory.put(
          "analyze_papers.independently_supported_gap_count",
          gapMap.gaps.filter((gap) => gap.epistemic_status === "supported_candidate").length
        );

        if (failedCount > 0) {
          const failedPaperIds = getSelectedFailedPaperIds(manifestState);
          const failureSummary = summarizeSelectedFailures(manifestState, selection.selectedPaperIds);
          const zeroProgress = progress.summaryRows.length === 0 && progress.evidenceRows.length === 0;
          const allSelectedFailed =
            selection.selectedPaperIds.length > 0 && failedPaperIds.size === selection.selectedPaperIds.length;

          if (failureSummary.usageLimitEntries.length > 0) {
            const blockedCount = failureSummary.usageLimitEntries.length;
            const sampleMessage = failureSummary.cleanedMessages[0] || "Model usage limit reached.";
            emitLog(
              `Detected model usage-limit failure for ${blockedCount} selected paper(s). Pausing analyze_papers instead of auto-retrying because the requested model is currently unavailable.`
            );
            return {
              status: "success",
              summary:
                progress.evidenceRows.length > 0
                  ? request.selectionMode === "top_n" && request.topN
                    ? `Preserved partial analysis for top ${selection.selectedPaperIds.length}/${selection.totalCandidates} ranked papers (${progress.summaryRows.length} summaries, ${progress.evidenceRows.length} evidence item(s)) after ${blockedCount} paper(s) hit the current model usage limit.`
                    : `Preserved partial analysis (${progress.summaryRows.length} summaries, ${progress.evidenceRows.length} evidence item(s)) after ${blockedCount} paper(s) hit the current model usage limit.`
                  : request.selectionMode === "top_n" && request.topN
                    ? `analyze_papers paused because ${blockedCount}/${selection.selectedPaperIds.length} selected paper(s) hit the current model usage limit before any summaries or evidence were produced.`
                    : `analyze_papers paused because ${blockedCount} selected paper(s) hit the current model usage limit before any summaries or evidence were produced.`,
              needsApproval: true,
              toolCallsUsed: analysisToolCallsUsed,
              transitionRecommendation: createAnalyzePapersManualReviewRecommendation({
                runId: run.id,
                reason:
                  "analyze_papers is blocked by a model usage limit, so retrying immediately would churn without producing new outputs.",
                confidence: 0.98,
                evidence: [
                  `${blockedCount} selected paper(s) reported a model usage-limit failure.`,
                  progress.evidenceRows.length > 0
                    ? `${progress.summaryRows.length} summary row(s) and ${progress.evidenceRows.length} evidence item(s) are already persisted.`
                    : "No summaries or evidence were persisted before the limit was hit.",
                  sampleMessage
                ],
                suggestedCommands:
                  progress.evidenceRows.length > 0
                    ? ["/model", `/agent run analyze_papers ${run.id}`]
                    : ["/model", `/agent run analyze_papers ${run.id}`]
              })
            };
          }

          if (
            failureSummary.sourceMismatchEntries.length > 0 &&
            failureSummary.sourceMismatchEntries.length === failureSummary.failedEntries.length
          ) {
            const blockedCount = failureSummary.sourceMismatchEntries.length;
            const sampleMessage = failureSummary.cleanedMessages[0] || "Resolved source content did not match the requested paper.";
            emitLog(
              `Detected non-retriable source-identity mismatch for ${blockedCount} selected paper(s). Pausing instead of auto-retrying the same contaminated analysis inputs.`
            );
            return {
              status: "success",
              summary:
                progress.evidenceRows.length > 0
                  ? request.selectionMode === "top_n" && request.topN
                    ? `Preserved partial analysis for top ${selection.selectedPaperIds.length}/${selection.totalCandidates} ranked papers while quarantining ${blockedCount} source-mismatched paper(s).`
                    : `Preserved partial analysis while quarantining ${blockedCount} source-mismatched paper(s).`
                  : request.selectionMode === "top_n" && request.topN
                    ? `analyze_papers paused because ${blockedCount}/${selection.selectedPaperIds.length} selected paper(s) failed source-identity validation before any summaries or evidence were persisted.`
                    : `analyze_papers paused because ${blockedCount} selected paper(s) failed source-identity validation before any summaries or evidence were persisted.`,
              needsApproval: true,
              toolCallsUsed: analysisToolCallsUsed,
              transitionRecommendation: createAnalyzePapersManualReviewRecommendation({
                runId: run.id,
                reason:
                  "analyze_papers quarantined one or more paper analyses because the resolved source content did not match the requested paper identity, so auto-retrying would likely repeat the same contamination.",
                confidence: 0.97,
                evidence: [
                  `${blockedCount} selected paper(s) failed source-identity validation.`,
                  progress.evidenceRows.length > 0
                    ? `${progress.summaryRows.length} summary row(s) and ${progress.evidenceRows.length} evidence item(s) remain safely persisted.`
                    : "No summaries or evidence were persisted for the quarantined papers.",
                  sampleMessage
                ],
                suggestedCommands:
                  progress.evidenceRows.length > 0
                    ? [`/agent run analyze_papers ${run.id}`]
                    : [`/agent run analyze_papers ${run.id}`, "/model"]
              })
            };
          }

          if (failureSummary.environmentBlockedEntries.length > 0) {
            const blockedCount = failureSummary.environmentBlockedEntries.length;
            const sampleMessage = failureSummary.cleanedMessages[0] || "Environment blocked paper analysis.";
            emitLog(
              `Detected environment or permission failure for ${blockedCount} selected paper(s). Pausing analyze_papers instead of auto-retrying while the same Codex environment remains blocked.`
            );
            return {
              status: "success",
              summary:
                progress.evidenceRows.length > 0
                  ? request.selectionMode === "top_n" && request.topN
                    ? `Preserved partial analysis for top ${selection.selectedPaperIds.length}/${selection.totalCandidates} ranked papers after ${blockedCount} paper(s) hit environment or permission errors.`
                    : `Preserved partial analysis (${progress.summaryRows.length} summaries, ${progress.evidenceRows.length} evidence item(s)) after ${blockedCount} paper(s) hit environment or permission errors.`
                  : request.selectionMode === "top_n" && request.topN
                    ? allSelectedFailed
                      ? `analyze_papers paused because all top ${selection.selectedPaperIds.length} selected paper(s) failed with environment or permission errors before any summaries or evidence were produced.`
                      : `analyze_papers paused because ${blockedCount}/${selection.selectedPaperIds.length} selected paper(s) failed with environment or permission errors before any summaries or evidence were produced.`
                    : allSelectedFailed
                      ? "analyze_papers paused because all selected papers failed with environment or permission errors before any summaries or evidence were produced."
                      : `analyze_papers paused because ${blockedCount} selected paper(s) failed with environment or permission errors before any summaries or evidence were produced.`,
              needsApproval: true,
              toolCallsUsed: analysisToolCallsUsed,
              transitionRecommendation: createAnalyzePapersManualReviewRecommendation({
                runId: run.id,
                reason:
                  "analyze_papers is blocked by environment or permission errors, so another automatic retry would likely fail the same way.",
                confidence: 0.96,
                evidence: [
                  `${blockedCount} selected paper(s) failed with environment or permission errors.`,
                  progress.evidenceRows.length > 0
                    ? `${progress.summaryRows.length} summary row(s) and ${progress.evidenceRows.length} evidence item(s) are already persisted.`
                    : "No summaries or evidence were persisted in this pass.",
                  sampleMessage
                ],
                suggestedCommands:
                  progress.evidenceRows.length > 0
                    ? ["/doctor", "/model", `/agent run analyze_papers ${run.id}`]
                    : ["/doctor", "/model", `/agent run analyze_papers ${run.id}`]
              })
            };
          }

          if (zeroProgress && zeroOutputPauseDecision) {
            const retryCount = priorRetryCount;
            const sampleMessage =
              failureSummary.cleanedMessages[0] ||
              `The first ${zeroOutputPauseDecision.attemptedCount} attempted papers all failed before any persisted outputs were produced.`;
            return {
              status: "success",
              summary:
                request.selectionMode === "top_n" && request.topN
                  ? `analyze_papers paused after the first ${zeroOutputPauseDecision.attemptedCount}/${selection.selectedPaperIds.length} ranked paper(s) all failed before any summaries or evidence were persisted.`
                  : `analyze_papers paused after the first ${zeroOutputPauseDecision.attemptedCount} attempted paper(s) all failed before any summaries or evidence were persisted.`,
              needsApproval: true,
              toolCallsUsed: analysisToolCallsUsed,
              transitionRecommendation: createAnalyzePapersManualReviewRecommendation({
                runId: run.id,
                reason:
                  retryCount > 0
                    ? "analyze_papers retried into the same zero-output failure pattern, so the node paused before spending the remaining analysis limit."
                    : "analyze_papers hit a zero-output failure pattern early, so the node paused before spending the remaining analysis limit.",
                confidence: retryCount > 0 ? 0.94 : 0.9,
                evidence: [
                  `0 summaries and 0 evidence items were persisted after ${zeroOutputPauseDecision.attemptedCount} attempted paper analyses.`,
                  retryCount > 0
                    ? `Retry counter before this pass was ${retryCount}; repeated automatic retries would likely churn without new artifacts.`
                    : `The early zero-output guard triggered after ${zeroOutputPauseDecision.threshold} consecutive failed attempts.`,
                  sampleMessage
                ],
                suggestedCommands: ["/doctor", "/model", `/agent run analyze_papers ${run.id}`]
              })
            };
          }

          const stalledFailures = shouldPauseForRepeatedAnalysisFailures({
            previousFailedPaperIds,
            currentFailedPaperIds: failedPaperIds,
            priorRetryCount: run.graph.retryCounters.analyze_papers ?? 0
          });
          if (progress.summaryRows.length > 0 || progress.evidenceRows.length > 0) {
            const summary =
              request.selectionMode === "top_n" && request.topN
                ? `Preserved partial analysis for top ${selection.selectedPaperIds.length}/${selection.totalCandidates} ranked papers (${progress.summaryRows.length} summaries, ${progress.evidenceRows.length} evidence item(s)) after ${failedCount} paper(s) failed.`
                : `Preserved partial analysis (${progress.summaryRows.length} summaries, ${progress.evidenceRows.length} evidence item(s)) after ${failedCount} paper(s) failed.`;
            emitLog(
              stalledFailures
                ? `Repeated analyze_papers retry would not reduce the failed subset (${failedPaperIds.size} paper(s) still failing). Preserving partial artifacts and pausing for manual review instead of triggering another destructive reset path.`
                : `analyze_papers preserved partial artifacts after ${failedCount} paper failure(s). Pausing for manual review instead of spending more automatic retries on an already usable evidence set.`
            );
            return {
              status: "success",
              summary,
              needsApproval: true,
              toolCallsUsed: analysisToolCallsUsed,
              transitionRecommendation: createAnalyzePapersManualReviewRecommendation({
                runId: run.id,
                reason:
                  stalledFailures
                    ? "analyze_papers preserved partial evidence because retrying again did not shrink the failed-paper subset."
                    : "analyze_papers preserved partial evidence after some selected papers failed, so the workflow paused instead of auto-retrying away a usable evidence set.",
                confidence: 0.92,
                evidence: [
                  `${progress.summaryRows.length} summary row(s) and ${progress.evidenceRows.length} evidence item(s) are already persisted.`,
                  stalledFailures
                    ? `${failedPaperIds.size} paper(s) remain failed after repeated retries.`
                    : `${failedCount} selected paper(s) still failed validation or extraction in this pass.`,
                  stalledFailures
                    ? previousFailedPaperIds.size > 0
                      ? `The failed subset stayed at ${previousFailedPaperIds.size} -> ${failedPaperIds.size} paper(s).`
                      : `Retry counter before this pass was ${run.graph.retryCounters.analyze_papers ?? 0}.`
                    : failureSummary.cleanedMessages[0] ||
                      `Retry counter before this pass was ${run.graph.retryCounters.analyze_papers ?? 0}.`
                ]
              })
            };
          }
          if (stalledFailures && zeroProgress && allSelectedFailed) {
            emitLog(
              `Repeated analyze_papers retry still produced zero summaries/evidence and did not shrink the failed subset (${failedPaperIds.size} paper(s)). Pausing for manual review instead of retrying again.`
            );
            return {
              status: "success",
              summary:
                request.selectionMode === "top_n" && request.topN
                  ? `analyze_papers produced no summaries or evidence after repeated retries on top ${selection.selectedPaperIds.length}/${selection.totalCandidates} ranked papers, so the node paused for manual review.`
                  : "analyze_papers produced no summaries or evidence after repeated retries, so the node paused for manual review.",
              needsApproval: true,
              toolCallsUsed: analysisToolCallsUsed,
              transitionRecommendation: createAnalyzePapersManualReviewRecommendation({
                runId: run.id,
                reason:
                  "Repeated analyze_papers retries produced zero persisted outputs and the failed paper subset did not shrink.",
                confidence: 0.94,
                evidence: [
                  `${failedPaperIds.size} selected paper(s) remain failed after repeated retries.`,
                  "No summaries or evidence are currently persisted for the selected set.",
                  failureSummary.cleanedMessages[0] || `Retry counter before this pass was ${run.graph.retryCounters.analyze_papers ?? 0}.`
                ],
                suggestedCommands: ["/doctor", "/model", `/agent run analyze_papers ${run.id}`]
              })
            };
          }
          return {
            status: "failure",
            summary:
              request.selectionMode === "top_n" && request.topN
                ? `Analyzed ${progress.summaryRows.length}/${selection.selectedPaperIds.length} selected papers from ${selection.totalCandidates} candidates; ${failedCount} failed and can be retried.`
                : `Analyzed ${progress.summaryRows.length}/${corpusRows.length} papers, ${failedCount} failed and can be retried.`,
            error: `Analysis incomplete: ${failedCount} paper(s) failed validation or LLM extraction.`,
            toolCallsUsed: analysisToolCallsUsed
          };
        }

        const expansionDecision = decideAutomaticSelectionExpansion({
          request,
          selection,
          summaryRows: progress.summaryRows,
          evidenceRows: progress.evidenceRows,
          fullTextCount: progress.fullTextCount,
          autoExpansionCount,
          startedWithExistingManifest: Boolean(startedWithExistingManifest)
        });
        if (expansionDecision) {
          autoExpansionCount += 1;
          autoExpansionReason = expansionDecision.reason;
          request = expansionDecision.nextRequest;
          await runContextMemory.put("analyze_papers.auto_expand_count", autoExpansionCount);
          await runContextMemory.put("analyze_papers.auto_expand_reason", autoExpansionReason);
          emitLog(expansionDecision.reason);
          continue;
        }
        const abstractOnlyExhaustionPause = shouldPauseForAbstractOnlySelectionExhaustion({
          request,
          selection,
          progress
        });
        if (abstractOnlyExhaustionPause) {
          await runContextMemory.put("analyze_papers.auto_expand_count", autoExpansionCount);
          await runContextMemory.put("analyze_papers.auto_expand_reason", autoExpansionReason || null);
          emitLog(abstractOnlyExhaustionPause.logMessage);
          return {
            status: "success",
            summary: abstractOnlyExhaustionPause.summary,
            needsApproval: true,
            toolCallsUsed: analysisToolCallsUsed,
            transitionRecommendation: createAnalyzePapersManualReviewRecommendation({
              runId: run.id,
              reason:
                "analyze_papers exhausted a small corpus without recovering any full-text support, so downstream hypothesis/experiment generation would be anchored only to abstract-level evidence.",
              confidence: 0.88,
              evidence: abstractOnlyExhaustionPause.evidence,
              suggestedCommands: [
                `/agent collect ${run.topic} --run ${run.id}`,
                `/agent run analyze_papers ${run.id}`,
                "/model"
              ]
            })
          };
        }

        await runContextMemory.put("analyze_papers.auto_expand_count", autoExpansionCount);
        await runContextMemory.put("analyze_papers.auto_expand_reason", autoExpansionReason || null);

        const baseSummary =
          request.selectionMode === "top_n" && request.topN
            ? `Analyzed top ${selection.selectedPaperIds.length}/${selection.totalCandidates} ranked papers into ${progress.evidenceRows.length} evidence item(s); ${progress.fullTextCount} full-text and ${progress.abstractFallbackCount} abstract fallback (mode=${analysisMode}).`
            : `Analyzed ${progress.summaryRows.length} papers into ${progress.evidenceRows.length} evidence item(s); ${progress.fullTextCount} full-text and ${progress.abstractFallbackCount} abstract fallback (mode=${analysisMode}).`;

        return {
          status: "success",
          summary:
            autoExpansionCount > 0 && request.selectionMode === "top_n" && request.topN
              ? `${baseSummary} Auto-expanded the analysis window ${autoExpansionCount} time(s) and finished at top ${request.topN}.`
              : baseSummary,
          needsApproval: true,
          toolCallsUsed: analysisToolCallsUsed
        };
      }
    }
  };
}

function getAnalysisConcurrency(analysisMode: "codex_text_image_hybrid" | "responses_api_pdf" | "ollama_vision"): number {
  if (analysisMode === "ollama_vision") return 2;
  return analysisMode === "responses_api_pdf" ? 2 : 3;
}

function decideAutomaticSelectionExpansion(input: {
  request: AnalysisSelectionRequest;
  selection: PaperSelectionResult;
  summaryRows: PaperSummaryRow[];
  evidenceRows: PaperEvidenceRow[];
  fullTextCount: number;
  autoExpansionCount: number;
  startedWithExistingManifest: boolean;
}): {
  nextRequest: AnalysisSelectionRequest;
  reason: string;
} | undefined {
  if (
    input.request.selectionMode !== "top_n" ||
    !input.request.topN ||
    input.request.topN >= input.selection.totalCandidates ||
    input.autoExpansionCount >= MAX_AUTO_SELECTION_EXPANSIONS ||
    (input.startedWithExistingManifest && input.autoExpansionCount === 0) ||
    input.summaryRows.length === 0
  ) {
    return undefined;
  }

  const evidenceTooThin = input.evidenceRows.length < Math.max(2, input.request.topN);
  const lowRichnessCoverage = input.fullTextCount === 0 || input.evidenceRows.length < input.summaryRows.length;
  if (!evidenceTooThin || !lowRichnessCoverage) {
    return undefined;
  }

  const growth = input.request.topN <= 2 ? 1 : Math.min(2, Math.ceil(input.request.topN * 0.5));
  const nextTopN = Math.min(input.selection.totalCandidates, input.request.topN + growth);
  if (nextTopN <= input.request.topN) {
    return undefined;
  }

  return {
    nextRequest: normalizeAnalysisSelectionRequest(nextTopN),
    reason:
      `Evidence coverage is still thin after top ${input.request.topN} analysis ` +
      `(${input.evidenceRows.length} evidence item(s), ${input.fullTextCount} full-text paper(s)). ` +
      `Auto-expanding to top ${nextTopN} for one more bounded analysis pass.`
  };
}

function shouldPauseForAbstractOnlySelectionExhaustion(input: {
  request: AnalysisSelectionRequest;
  selection: PaperSelectionResult;
  progress: ReturnType<typeof buildAnalysisProgress>;
}):
  | {
      summary: string;
      logMessage: string;
      evidence: string[];
    }
  | undefined {
  if (
    input.progress.summaryRows.length < ABSTRACT_ONLY_EXHAUSTION_MIN_SUMMARIES ||
    input.progress.fullTextCount > 0 ||
    input.progress.abstractFallbackCount !== input.progress.summaryRows.length ||
    input.selection.selectedPaperIds.length !== input.selection.totalCandidates ||
    input.selection.selectedPaperIds.length > ABSTRACT_ONLY_EXHAUSTION_MAX_SELECTED
  ) {
    return undefined;
  }

  const summary =
    input.request.selectionMode === "top_n" && input.request.topN
      ? `analyze_papers paused because the exhausted top ${input.selection.selectedPaperIds.length}/${input.selection.totalCandidates} selection produced only abstract-fallback summaries and no full-text support was recovered.`
      : `analyze_papers paused because all ${input.progress.summaryRows.length} analyzed papers produced only abstract-fallback summaries and no full-text support was recovered.`;
  const evidence = [
    `${input.progress.summaryRows.length} summary row(s) and ${input.progress.evidenceRows.length} evidence item(s) were persisted.`,
    `Full-text coverage remained at 0/${input.progress.summaryRows.length}; abstract fallback covered all analyzed papers.`,
    `The selected set exhausted the available corpus (${input.selection.selectedPaperIds.length}/${input.selection.totalCandidates}), so there is no larger shortlist to auto-expand into.`
  ];
  return {
    summary,
    logMessage:
      `Persisted ${input.progress.summaryRows.length} abstract-only summary row(s) with no full-text support across an exhausted ` +
      `${input.selection.selectedPaperIds.length}/${input.selection.totalCandidates} selection. Pausing for manual review ` +
      `instead of auto-unblocking downstream hypothesis/experiment generation on abstract-only evidence.`,
    evidence
  };
}

function createAsyncQueue() {
  let tail = Promise.resolve();
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation, operation);
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
    async onIdle(): Promise<void> {
      await tail;
    }
  };
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop?: () => boolean
): Promise<void> {
  const normalizedConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;
  let firstError: unknown;
  let stop = false;

  const runners = Array.from({ length: normalizedConcurrency }, async () => {
    while (true) {
      if (stop || shouldStop?.()) {
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      try {
        await worker(items[index], index);
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
        }
        stop = true;
        return;
      }
    }
  });

  await Promise.all(runners);
  if (firstError !== undefined) {
    throw firstError;
  }
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes("aborted") || message.includes("abort");
}

async function loadAnalysisSelectionRequest(
  runContextMemory: RunContextMemory,
  corpusCount: number,
  existingRequest?: AnalysisSelectionRequest
): Promise<LoadedAnalysisSelectionRequest> {
  const stored = await runContextMemory.get<{ topN?: unknown; selectionMode?: unknown; selectionPolicy?: unknown }>(
    "analyze_papers.request"
  );
  const topN =
    typeof stored?.topN === "number" && Number.isFinite(stored.topN) && stored.topN > 0
      ? Math.floor(stored.topN)
      : null;
  if (topN) {
    return {
      request: normalizeAnalysisSelectionRequest(topN)
    };
  }
  if (stored && typeof stored === "object" && stored.selectionMode === "all") {
    return {
      request: normalizeAnalysisSelectionRequest(null)
    };
  }
  if (existingRequest) {
    return {
      request: existingRequest
    };
  }
  if (corpusCount > DEFAULT_SAFE_ANALYSIS_TOP_N) {
    return {
      request: normalizeAnalysisSelectionRequest(DEFAULT_SAFE_ANALYSIS_TOP_N),
      autoDefaultReason:
        `No explicit analyze_papers selection was stored. ` +
        `For a large corpus of ${corpusCount} papers, auto-start is using top ${DEFAULT_SAFE_ANALYSIS_TOP_N} instead of analyzing all candidates.`
    };
  }
  return {
    request: normalizeAnalysisSelectionRequest(null)
  };
}

async function readCorpusRows(runId: string): Promise<AnalysisCorpusRow[]> {
  const corpusPath = path.join(".autolabos", "runs", runId, "corpus.jsonl");
  const corpusText = await safeRead(corpusPath);
  return corpusText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = objectValue(JSON.parse(line) as unknown);
        const paperId = stringValue(parsed?.paper_id);
        if (!parsed || !paperId) {
          return undefined;
        }
        return {
          ...parsed,
          paper_id: paperId,
          title: stringValue(parsed.title) || "",
          abstract: stringValue(parsed.abstract) || "",
          authors: Array.isArray(parsed.authors)
            ? parsed.authors.flatMap((author) => {
                const value = stringValue(author);
                return value ? [value] : [];
              })
            : []
        } as AnalysisCorpusRow;
      } catch {
        return undefined;
      }
    })
    .filter((row): row is AnalysisCorpusRow => Boolean(row?.paper_id));
}

async function readCollectEnrichmentLogs(runId: string): Promise<Map<string, CollectEnrichmentLogEntry>> {
  const enrichmentPath = path.join(".autolabos", "runs", runId, "collect_enrichment.jsonl");
  const enrichmentText = await safeRead(enrichmentPath);
  return new Map(
    enrichmentText
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
      .filter((entry): entry is CollectEnrichmentLogEntry => Boolean(entry?.paper_id))
      .map((entry) => [entry.paper_id, entry] as const)
  );
}

function mergeCorpusRowWithEnrichment(
  row: AnalysisCorpusRow,
  enrichment: CollectEnrichmentLogEntry | undefined
): AnalysisCorpusRow {
  const recoveredPdfUrl = enrichment?.pdf_resolution?.url?.trim();
  if (!recoveredPdfUrl || recoveredPdfUrl === resolvePaperPdfUrl(row)) {
    return row;
  }
  return {
    ...row,
    pdf_url: recoveredPdfUrl
  };
}

function mergeCorpusRow(base: AnalysisCorpusRow, latest: AnalysisCorpusRow): AnalysisCorpusRow {
  const latestAuthors = Array.isArray(latest.authors) ? latest.authors : [];
  const baseAuthors = Array.isArray(base.authors) ? base.authors : [];
  return {
    ...base,
    ...latest,
    abstract: latest.abstract || base.abstract,
    url: latest.url || base.url,
    pdf_url: latest.pdf_url || base.pdf_url,
    authors: latestAuthors.length > 0 ? latestAuthors : baseAuthors,
    venue: latest.venue || base.venue,
    year: latest.year ?? base.year,
    citation_count: latest.citation_count ?? base.citation_count,
    influential_citation_count: latest.influential_citation_count ?? base.influential_citation_count,
    publication_date: latest.publication_date || base.publication_date,
    publication_types: latest.publication_types?.length ? latest.publication_types : base.publication_types,
    fields_of_study: latest.fields_of_study?.length ? latest.fields_of_study : base.fields_of_study
  };
}

async function readLatestArtifactBackedCorpusRows(runId: string): Promise<Map<string, AnalysisCorpusRow>> {
  const latestById = new Map((await readCorpusRows(runId)).map((row) => [row.paper_id, row] as const));
  if (latestById.size === 0) {
    return latestById;
  }
  const enrichmentById = await readCollectEnrichmentLogs(runId);
  for (const [paperId, row] of latestById.entries()) {
    latestById.set(paperId, mergeCorpusRowWithEnrichment(row, enrichmentById.get(paperId)));
  }
  return latestById;
}

function countRowsWithoutPdf(rows: AnalysisCorpusRow[]): number {
  return rows.filter((row) => !resolvePaperPdfUrl(row)).length;
}

async function refreshSelectedRowsFromLatestArtifacts(
  runId: string,
  rows: AnalysisCorpusRow[],
  options?: {
    selectionMode?: AnalysisSelectionRequest["selectionMode"];
    selectedCount?: number;
    totalCandidates?: number;
  }
): Promise<AnalysisCorpusRow[]> {
  if (rows.length === 0) {
    return rows;
  }
  let refreshed = mergeSelectedRows(rows, await readLatestArtifactBackedCorpusRows(runId));
  if (countRowsWithoutPdf(refreshed) === 0 || !(await isCollectEnrichmentPending(runId))) {
    return refreshed;
  }

  const deadline = Date.now() + getCollectEnrichmentWaitMs(options);
  while (Date.now() < deadline) {
    await sleep(COLLECT_ENRICHMENT_POLL_INTERVAL_MS);
    const next = mergeSelectedRows(rows, await readLatestArtifactBackedCorpusRows(runId));
    if (countRowsWithoutPdf(next) < countRowsWithoutPdf(refreshed)) {
      refreshed = next;
    }
    if (countRowsWithoutPdf(refreshed) === 0 || !(await isCollectEnrichmentPending(runId))) {
      break;
    }
  }
  return refreshed;
}

function mergeSelectedRows(rows: AnalysisCorpusRow[], latestById: Map<string, AnalysisCorpusRow>): AnalysisCorpusRow[] {
  return rows.map((row) => {
    const latest = latestById.get(row.paper_id);
    return latest ? mergeCorpusRow(row, latest) : row;
  });
}

async function refreshCorpusRowFromLatestArtifacts(runId: string, row: AnalysisCorpusRow): Promise<AnalysisCorpusRow> {
  const latest = (await readLatestArtifactBackedCorpusRows(runId)).get(row.paper_id);
  return latest ? mergeCorpusRow(row, latest) : row;
}

async function refreshCorpusRowForSourceResolution(
  runId: string,
  row: AnalysisCorpusRow,
  options?: {
    selectionMode?: AnalysisSelectionRequest["selectionMode"];
    selectedCount?: number;
    totalCandidates?: number;
  }
): Promise<AnalysisCorpusRow> {
  let refreshed = await refreshCorpusRowFromLatestArtifacts(runId, row);
  if (resolvePaperPdfUrl(refreshed) || !(await isCollectEnrichmentPending(runId))) {
    return refreshed;
  }

  const deadline = Date.now() + getCollectEnrichmentWaitMs(options);
  while (Date.now() < deadline) {
    await sleep(COLLECT_ENRICHMENT_POLL_INTERVAL_MS);
    const next = await refreshCorpusRowFromLatestArtifacts(runId, row);
    if (resolvePaperPdfUrl(next)) {
      return next;
    }
    refreshed = next;
    if (!(await isCollectEnrichmentPending(runId))) {
      break;
    }
  }
  return refreshed;
}

export async function retryResolvedSourceAfterLatePdfRecovery(args: {
  runId: string;
  paper: AnalysisCorpusRow;
  source: ResolvedPaperSource;
  includePageImages?: boolean;
  selectionMode?: AnalysisSelectionRequest["selectionMode"];
  selectedCount?: number;
  totalCandidates?: number;
  abortSignal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<{ paper: AnalysisCorpusRow; source: ResolvedPaperSource }> {
  if (args.source.sourceType !== "abstract") {
    return {
      paper: args.paper,
      source: args.source
    };
  }

  const refreshedPaper = await refreshCorpusRowForSourceResolution(args.runId, args.paper, {
    selectionMode: args.selectionMode,
    selectedCount: args.selectedCount,
    totalCandidates: args.totalCandidates
  });
  const originalPdfUrl = resolvePaperPdfUrl(args.paper);
  const refreshedPdfUrl = resolvePaperPdfUrl(refreshedPaper);
  if (refreshedPdfUrl && refreshedPdfUrl !== originalPdfUrl) {
    args.onProgress?.("Detected updated PDF metadata after the initial abstract fallback. Retrying source resolution.");
    return {
      paper: refreshedPaper,
      source: await resolvePaperTextSource({
        runId: args.runId,
        paper: refreshedPaper,
        includePageImages: args.includePageImages,
        abortSignal: args.abortSignal,
        onProgress: args.onProgress
      })
    };
  }

  return {
    paper: refreshedPaper,
    source: args.source
  };
}

function getCollectEnrichmentWaitMs(options?: {
  selectionMode?: AnalysisSelectionRequest["selectionMode"];
  selectedCount?: number;
  totalCandidates?: number;
}): number {
  const selectedCount = options?.selectedCount ?? 0;
  const totalCandidates = options?.totalCandidates ?? selectedCount;
  const smallSelectedSet = selectedCount > 0 && selectedCount <= 8;
  const exhaustedSmallCorpus = totalCandidates > 0 && totalCandidates <= 8;
  if (options?.selectionMode === "all" || smallSelectedSet || exhaustedSmallCorpus) {
    return COLLECT_ENRICHMENT_EXTENDED_WAIT_MS;
  }
  return COLLECT_ENRICHMENT_SELECTED_WAIT_MS;
}

async function isCollectEnrichmentPending(runId: string): Promise<boolean> {
  const collectResultPath = path.join(".autolabos", "runs", runId, "collect_result.json");
  try {
    const collectResult = await readJsonFile<{ enrichment?: { status?: string } }>(collectResultPath);
    return collectResult?.enrichment?.status === "pending";
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function refreshPdfAvailabilityScoreBreakdown(
  scoreBreakdown: DeterministicScoreBreakdown | undefined,
  row: AnalysisCorpusRow
): DeterministicScoreBreakdown | undefined {
  if (!scoreBreakdown) {
    return scoreBreakdown;
  }
  return {
    ...scoreBreakdown,
    pdf_availability_score: resolvePaperPdfUrl(row) ? 1 : scoreBreakdown.pdf_availability_score
  };
}

function hydrateSelectedManifestEntriesFromRows(
  manifest: AnalysisManifest,
  selectedRows: AnalysisCorpusRow[]
): AnalysisManifest {
  let changed = false;
  const nextPapers: AnalysisManifest["papers"] = { ...manifest.papers };
  const now = new Date().toISOString();
  for (const row of selectedRows) {
    const existing = nextPapers[row.paper_id];
    if (!existing || !existing.selected) {
      continue;
    }
    const nextPdfUrl = resolvePaperPdfUrl(row);
    const nextScoreBreakdown = refreshPdfAvailabilityScoreBreakdown(existing.score_breakdown, row);
    if (existing.pdf_url === nextPdfUrl && nextScoreBreakdown === existing.score_breakdown) {
      continue;
    }
    nextPapers[row.paper_id] = {
      ...existing,
      pdf_url: nextPdfUrl,
      score_breakdown: nextScoreBreakdown,
      updatedAt: now
    };
    changed = true;
  }
  if (!changed) {
    return manifest;
  }
  return {
    ...manifest,
    updatedAt: now,
    papers: nextPapers
  };
}

async function readExistingManifest(manifestPath: string): Promise<AnalysisManifest | undefined> {
  try {
    const manifest = await readJsonFile<AnalysisManifest>(manifestPath);
    if (
      (manifest?.version === 2 || manifest?.version === 3 || manifest?.version === 4) &&
      manifest.papers &&
      typeof manifest.papers === "object"
    ) {
      return manifest;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function buildCorpusFingerprint(corpusRows: AnalysisCorpusRow[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        corpusRows.map((row) => ({
          paper_id: row.paper_id,
          title: row.title,
          abstract: row.abstract || "",
          year: row.year ?? null,
          venue: row.venue ?? null,
          citation_count: row.citation_count ?? 0,
          pdf_url: resolvePaperPdfUrl(row) ?? null,
          query_families: Array.from(
            new Set((row.query_families ?? []).map((queryFamily) => queryFamily.trim()).filter(Boolean))
          ).sort()
        }))
      )
    )
    .digest("hex");
}

function canReuseManifestSelection(
  manifest: AnalysisManifest | undefined,
  request: AnalysisSelectionRequest,
  selectionRequestFingerprint: string,
  corpusFingerprint: string,
  corpusRows: AnalysisCorpusRow[]
): manifest is AnalysisManifest {
  if (!manifest) {
    return false;
  }
  if (manifest.selectionSemanticsVersion !== ANALYSIS_SELECTION_SEMANTICS_VERSION) {
    return false;
  }
  if (manifest.selectionRequestFingerprint !== selectionRequestFingerprint) {
    return false;
  }
  if (manifest.corpusFingerprint !== corpusFingerprint) {
    return false;
  }
  if (manifest.request.selectionMode !== request.selectionMode || manifest.request.topN !== request.topN) {
    return false;
  }
  // Accept deterministic fallback selections as valid cache entries.
  // When LLM rerank fails, the deterministic fallback still produces a
  // usable selection — forcing an expensive re-rerank on every re-entry
  // wastes time and API budget without meaningful quality improvement.
  if (
    manifest.request.selectionMode === "top_n" &&
    manifest.request.topN &&
    manifest.selectedPaperIds.length === 0
  ) {
    return false;
  }

  const manifestPaperIds = new Set(Object.keys(manifest.papers));
  return corpusRows.length === manifestPaperIds.size && corpusRows.every((row) => manifestPaperIds.has(row.paper_id));
}

function restoreSelectionFromManifest(
  manifest: AnalysisManifest,
  corpusRows: AnalysisCorpusRow[]
): PaperSelectionResult {
  const paperById = new Map(corpusRows.map((row) => [row.paper_id, row] as const));
  const rankedCandidates: RankedPaperCandidate[] = [];
  for (const entry of Object.values(manifest.papers)) {
    const paper = paperById.get(entry.paper_id);
    if (!paper) {
      continue;
    }
    rankedCandidates.push({
      paper,
      deterministicScore: entry.deterministic_score ?? 0,
      selectionScore: entry.selection_score ?? entry.deterministic_score ?? 0,
      rerankPosition: entry.rerank_position,
      selected: entry.selected,
      rank: entry.rank,
      scoreBreakdown: entry.score_breakdown ?? {
        title_similarity_score: 0,
        citation_score: 0,
        recency_score: 0,
        pdf_availability_score: 0
      }
    });
  }

  rankedCandidates.sort((left, right) => {
      const leftRank = left.selected ? left.rank ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      const rightRank = right.selected ? right.rank ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
      return (
        leftRank - rightRank ||
        (right.selectionScore ?? right.deterministicScore) - (left.selectionScore ?? left.deterministicScore) ||
        right.deterministicScore - left.deterministicScore ||
        left.paper.paper_id.localeCompare(right.paper.paper_id)
      );
    });

  return {
    request: manifest.request,
    totalCandidates: manifest.totalCandidates,
    candidatePoolSize: manifest.candidatePoolSize,
    deterministicRankingPreview: manifest.deterministicRankingPreview,
    rerankedPaperIds: manifest.rerankedPaperIds,
    selectedPaperIds: manifest.selectedPaperIds,
    selectionFingerprint: manifest.selectionFingerprint,
    rerankApplied: manifest.rerankApplied ?? manifest.rerankedPaperIds.length > 0,
    rerankFallbackReason: manifest.rerankFallbackReason,
    topicFamilyCoverage: manifest.topicFamilyCoverage,
    rankedCandidates
  };
}

function canExtendManifestForExpandedSelection(
  existingManifest: AnalysisManifest,
  selection: PaperSelectionResult,
  analysisFingerprint: string,
  corpusFingerprint: string
): boolean {
  if (
    existingManifest.analysisFingerprint !== analysisFingerprint ||
    existingManifest.corpusFingerprint !== corpusFingerprint ||
    existingManifest.request.selectionMode !== "top_n" ||
    selection.request.selectionMode !== "top_n"
  ) {
    return false;
  }

  if (selection.selectedPaperIds.length <= existingManifest.selectedPaperIds.length) {
    return false;
  }

  const nextSelection = new Set(selection.selectedPaperIds);
  return existingManifest.selectedPaperIds.every((paperId) => nextSelection.has(paperId));
}

function extendManifestForExpandedSelection(
  existingManifest: AnalysisManifest,
  selection: PaperSelectionResult,
  analysisFingerprint: string,
  selectionRequestFingerprint: string,
  corpusFingerprint: string
): AnalysisManifest {
  const fresh = createFreshManifest(selection, analysisFingerprint, selectionRequestFingerprint, corpusFingerprint);
  for (const [paperId, freshEntry] of Object.entries(fresh.papers)) {
    const previousEntry = existingManifest.papers[paperId];
    if (!previousEntry?.selected || !freshEntry.selected) {
      continue;
    }
    fresh.papers[paperId] = {
      ...freshEntry,
      status: previousEntry.status,
      source_type: previousEntry.source_type,
      summary_count: previousEntry.summary_count,
      evidence_count: previousEntry.evidence_count,
      analysis_attempts: previousEntry.analysis_attempts,
      analysis_mode: previousEntry.analysis_mode,
      pdf_url: previousEntry.pdf_url,
      pdf_cache_path: previousEntry.pdf_cache_path,
      text_cache_path: previousEntry.text_cache_path,
      fallback_reason: previousEntry.fallback_reason,
      last_error: previousEntry.last_error,
      has_table_references: previousEntry.has_table_references,
      table_reference_count: previousEntry.table_reference_count,
      has_figure_references: previousEntry.has_figure_references,
      figure_reference_count: previousEntry.figure_reference_count,
      updatedAt: previousEntry.updatedAt,
      completedAt: previousEntry.completedAt
    };
  }
  return fresh;
}

function canRetargetManifestForSelectionChange(
  existingManifest: AnalysisManifest,
  selection: PaperSelectionResult,
  analysisFingerprint: string,
  selectionRequestFingerprint: string,
  corpusFingerprint: string
): boolean {
  return (
    existingManifest.analysisFingerprint === analysisFingerprint &&
    existingManifest.selectionRequestFingerprint === selectionRequestFingerprint &&
    existingManifest.corpusFingerprint === corpusFingerprint &&
    existingManifest.selectionFingerprint !== selection.selectionFingerprint
  );
}

function retargetManifestForSelectionChange(
  existingManifest: AnalysisManifest,
  selection: PaperSelectionResult,
  summaryRows: PaperSummaryRow[],
  evidenceRows: PaperEvidenceRow[],
  analysisFingerprint: string,
  selectionRequestFingerprint: string,
  corpusFingerprint: string
): SelectionRetargetResult {
  const nextManifest = createFreshManifest(selection, analysisFingerprint, selectionRequestFingerprint, corpusFingerprint);
  const nextSelectedSet = new Set(selection.selectedPaperIds);
  const preservedCompletedPaperIds: string[] = [];

  for (const [paperId, nextEntry] of Object.entries(nextManifest.papers)) {
    const previousEntry = existingManifest.papers[paperId];
    if (!nextEntry.selected || !previousEntry?.selected) {
      continue;
    }
    nextManifest.papers[paperId] = {
      ...nextEntry,
      status: previousEntry.status,
      source_type: previousEntry.source_type,
      summary_count: previousEntry.summary_count,
      evidence_count: previousEntry.evidence_count,
      analysis_attempts: previousEntry.analysis_attempts,
      analysis_mode: previousEntry.analysis_mode,
      pdf_url: previousEntry.pdf_url,
      pdf_cache_path: previousEntry.pdf_cache_path,
      text_cache_path: previousEntry.text_cache_path,
      fallback_reason: previousEntry.fallback_reason,
      last_error: previousEntry.last_error,
      has_table_references: previousEntry.has_table_references,
      table_reference_count: previousEntry.table_reference_count,
      has_figure_references: previousEntry.has_figure_references,
      figure_reference_count: previousEntry.figure_reference_count,
      updatedAt: previousEntry.updatedAt,
      completedAt: previousEntry.completedAt
    };
    if (previousEntry.status === "completed") {
      preservedCompletedPaperIds.push(paperId);
    }
  }

  const nextSummaryRows = summaryRows.filter((row) => nextSelectedSet.has(row.paper_id));
  const nextEvidenceRows = evidenceRows.filter((row) => nextSelectedSet.has(row.paper_id));
  const droppedPaperIds = existingManifest.selectedPaperIds.filter((paperId) => !nextSelectedSet.has(paperId));

  return {
    manifest: nextManifest,
    summaryRows: nextSummaryRows,
    evidenceRows: nextEvidenceRows,
    preservedCompletedPaperIds,
    droppedPaperIds,
    logMessage:
      `Analysis selection changed under the same request/corpus fingerprint. ` +
      `Preserving ${preservedCompletedPaperIds.length} completed paper(s) and pruning ${droppedPaperIds.length} deselected paper(s) instead of resetting all artifacts.`
  };
}

function createFreshManifest(
  selection: PaperSelectionResult,
  analysisFingerprint: string,
  selectionRequestFingerprint: string,
  corpusFingerprint: string
): AnalysisManifest {
  const now = new Date().toISOString();
  return {
    version: 4,
    updatedAt: now,
    request: selection.request,
    selectionSemanticsVersion: ANALYSIS_SELECTION_SEMANTICS_VERSION,
    selectionFingerprint: selection.selectionFingerprint,
    selectionRequestFingerprint,
    analysisFingerprint,
    corpusFingerprint,
    totalCandidates: selection.totalCandidates,
    candidatePoolSize: selection.candidatePoolSize,
    rerankApplied: selection.rerankApplied,
    rerankFallbackReason: selection.rerankFallbackReason,
    topicFamilyCoverage: selection.topicFamilyCoverage,
    selectedPaperIds: selection.selectedPaperIds,
    rerankedPaperIds: selection.rerankedPaperIds,
    deterministicRankingPreview: selection.deterministicRankingPreview,
    papers: Object.fromEntries(
      selection.rankedCandidates.map((candidate) => [
        candidate.paper.paper_id,
        {
          paper_id: candidate.paper.paper_id,
          title: candidate.paper.title,
          query_families: candidate.paper.query_families,
          status: candidate.selected ? "pending" : "skipped",
          selected: candidate.selected,
          rank: candidate.rank,
          pdf_url: resolvePaperPdfUrl(candidate.paper),
          summary_count: 0,
          evidence_count: 0,
          analysis_attempts: 0,
          deterministic_score: candidate.deterministicScore,
          selection_score: candidate.selectionScore,
          score_breakdown: candidate.scoreBreakdown,
          rerank_position: candidate.rerankPosition,
          has_table_references: false,
          table_reference_count: 0,
          has_figure_references: false,
          figure_reference_count: 0,
          updatedAt: now
        } satisfies AnalysisManifestEntry
      ])
    )
  };
}

async function resetAnalysisOutputs(run: { id: string }, summaryPath: string, evidencePath: string): Promise<void> {
  await fs.rm(summaryPath, { force: true });
  await fs.rm(evidencePath, { force: true });
  await syncRunLiteratureIndex(run as RunRecord);
}

async function bootstrapManifestFromExistingOutputs(
  selection: PaperSelectionResult,
  summaryPath: string,
  evidencePath: string,
  analysisFingerprint: string,
  selectionRequestFingerprint: string,
  corpusFingerprint: string
): Promise<AnalysisManifest> {
  const manifest = createFreshManifest(selection, analysisFingerprint, selectionRequestFingerprint, corpusFingerprint);
  const summaries = await readSummaryRows(summaryPath);
  const evidences = await readEvidenceRows(evidencePath);
  const summariesByPaper = new Map<string, PaperSummaryRow[]>();
  const evidenceCountByPaper = new Map<string, number>();

  for (const summary of summaries) {
    const rows = summariesByPaper.get(summary.paper_id) ?? [];
    rows.push(summary);
    summariesByPaper.set(summary.paper_id, rows);
  }
  for (const evidence of evidences) {
    evidenceCountByPaper.set(evidence.paper_id, (evidenceCountByPaper.get(evidence.paper_id) ?? 0) + 1);
  }

  for (const [paperId, summaryRows] of summariesByPaper.entries()) {
    const entry = manifest.papers[paperId];
    if (!entry || !entry.selected) {
      continue;
    }
    const summary = summaryRows[0];
    const evidenceCount = evidenceCountByPaper.get(paperId) ?? 0;
    if (summaryRows.length !== 1 || evidenceCount === 0) {
      continue;
    }
    manifest.papers[paperId] = {
      ...entry,
      status: "completed",
      source_type: summary.source_type,
      summary_count: 1,
      evidence_count: evidenceCount,
      analysis_attempts: 1,
      analysis_mode: "codex_text_image_hybrid",
      has_table_references: false,
      table_reference_count: 0,
      has_figure_references: false,
      figure_reference_count: 0,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
  }

  return manifest;
}

function buildAnalysisFingerprint(args: {
  analysisMode: "codex_text_image_hybrid" | "responses_api_pdf" | "ollama_vision";
  responsesModel?: string;
  responsesReasoningEffort?: string;
  includePageImages: boolean;
}): string {
  const modeSpecificConfig =
    args.analysisMode === "responses_api_pdf"
      ? {
          responsesModel: args.responsesModel ?? null,
          responsesReasoningEffort: args.responsesReasoningEffort ?? null
        }
      : {
          includePageImages: args.includePageImages
        };
  return JSON.stringify({
    evidenceSemanticsVersion: PAPER_ANALYSIS_EVIDENCE_SEMANTICS_VERSION,
    analysisMode: args.analysisMode,
    ...modeSpecificConfig
  });
}

function buildAnalysisProgress(summaryRows: PaperSummaryRow[], evidenceRows: PaperEvidenceRow[]): {
  summaryRows: PaperSummaryRow[];
  evidenceRows: PaperEvidenceRow[];
  fullTextCount: number;
  abstractFallbackCount: number;
} {
  return {
    summaryRows,
    evidenceRows,
    fullTextCount: summaryRows.filter((row) => row.source_type === "full_text").length,
    abstractFallbackCount: summaryRows.filter((row) => row.source_type === "abstract").length
  };
}

export interface RichnessSummary {
  total_papers: number;
  full_text_count: number;
  abstract_fallback_count: number;
  fulltext_coverage_pct: number;
  readiness: "adequate" | "marginal" | "insufficient";
}

export function buildRichnessSummary(progress: {
  fullTextCount: number;
  abstractFallbackCount: number;
}): RichnessSummary {
  const total = progress.fullTextCount + progress.abstractFallbackCount;
  const pct = total > 0 ? progress.fullTextCount / total : 0;

  let readiness: RichnessSummary["readiness"];
  if (progress.fullTextCount >= 5 && pct >= 0.5) {
    readiness = "adequate";
  } else if (progress.fullTextCount >= 3) {
    readiness = "marginal";
  } else {
    readiness = "insufficient";
  }

  return {
    total_papers: total,
    full_text_count: progress.fullTextCount,
    abstract_fallback_count: progress.abstractFallbackCount,
    fulltext_coverage_pct: Math.round(pct * 1000) / 1000,
    readiness
  };
}

function buildAnalyzeProgressSummary(input: {
  request: AnalysisSelectionRequest;
  selectedCount: number;
  totalCandidates: number;
  progress: ReturnType<typeof buildAnalysisProgress>;
  failedCount: number;
  analysisMode: string;
}): string {
  if (input.failedCount > 0 && input.progress.summaryRows.length === 0 && input.progress.evidenceRows.length === 0) {
    if (input.request.selectionMode === "top_n" && input.request.topN && input.selectedCount > 0 && input.totalCandidates > 0) {
      return `Selected top ${input.selectedCount}/${input.totalCandidates} ranked papers for analysis. Persisted 0 summary row(s) and 0 evidence row(s); ${input.failedCount} attempt(s) have failed so far.`;
    }
    return `Selected ${input.selectedCount}/${input.totalCandidates} paper(s) for analysis. Persisted 0 summary row(s) and 0 evidence row(s); ${input.failedCount} attempt(s) have failed so far.`;
  }

  if (input.failedCount > 0) {
    if (input.request.selectionMode === "top_n" && input.request.topN && input.selectedCount > 0 && input.totalCandidates > 0) {
      return `Analyzed ${input.progress.summaryRows.length}/${input.selectedCount} selected papers from ${input.totalCandidates} candidates; ${input.failedCount} failed and can be retried.`;
    }
    return `Analyzed ${input.progress.summaryRows.length} papers, ${input.failedCount} failed and can be retried.`;
  }

  if (input.progress.summaryRows.length === 0 && input.progress.evidenceRows.length === 0) {
    if (input.request.selectionMode === "top_n" && input.request.topN && input.selectedCount > 0 && input.totalCandidates > 0) {
      return `Selected top ${input.selectedCount}/${input.totalCandidates} ranked papers for analysis. Persisted 0 summary row(s) and 0 evidence row(s).`;
    }
    return `Selected ${input.selectedCount}/${input.totalCandidates} paper(s) for analysis. Persisted 0 summary row(s) and 0 evidence row(s).`;
  }

  if (input.request.selectionMode === "top_n" && input.request.topN) {
    return `Analyzed top ${input.selectedCount}/${input.totalCandidates} ranked papers into ${input.progress.evidenceRows.length} evidence item(s); ${input.progress.fullTextCount} full-text and ${input.progress.abstractFallbackCount} abstract fallback (mode=${input.analysisMode}).`;
  }

  return `Analyzed ${input.progress.summaryRows.length} papers into ${input.progress.evidenceRows.length} evidence item(s); ${input.progress.fullTextCount} full-text and ${input.progress.abstractFallbackCount} abstract fallback (mode=${input.analysisMode}).`;
}

function buildAnalyzeStartSummary(input: {
  request: AnalysisSelectionRequest;
  totalCandidates: number;
}): string {
  if (input.request.selectionMode === "top_n" && input.request.topN && input.totalCandidates > 0) {
    return `analyze_papers has started. Ranking ${input.totalCandidates} candidate paper(s) to select top ${input.request.topN}; persisted 0 summary row(s) and 0 evidence row(s).`;
  }
  if (input.totalCandidates > 0) {
    return `analyze_papers has started. Preparing ${input.totalCandidates} candidate paper(s) for analysis; persisted 0 summary row(s) and 0 evidence row(s).`;
  }
  return "analyze_papers has started but no corpus rows are currently available.";
}

async function analyzePaperWithPageImageTimeoutFallback(args: {
  llm: NodeExecutionDeps["llm"];
  paper: AnalysisCorpusRow;
  source: ResolvedPaperSource;
  abortSignal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<{ analysis: PaperAnalysisResult; source: ResolvedPaperSource }> {
  try {
    return {
      analysis: await analyzePaperWithLlm({
        llm: args.llm,
        paper: args.paper,
        source: args.source,
        maxAttempts: 2,
        abortSignal: args.abortSignal,
        onProgress: args.onProgress
      }),
      source: args.source
    };
  } catch (error) {
    if (!shouldRetryAnalysisWithoutPageImages(args.source, error)) {
      throw error;
    }
    const downgradedSource = stripSupplementalPageImages(args.source);
    args.onProgress?.(
      `Extractor timed out with ${args.source.pageImagePaths?.length ?? 0} rendered PDF page image(s). Retrying once with full text only.`
    );
    try {
      return {
        analysis: await analyzePaperWithLlm({
          llm: args.llm,
          paper: args.paper,
          source: downgradedSource,
          maxAttempts: 1,
          abortSignal: args.abortSignal,
          onProgress: args.onProgress
        }),
        source: downgradedSource
      };
    } catch (retryError) {
      if (!shouldRetryAnalysisAsAbstractFallback(downgradedSource, retryError)) {
        throw retryError;
      }
      const abstractSource: ResolvedPaperSource = {
        sourceType: "abstract",
        text: buildAbstractFallbackText(args.paper),
        fullTextAvailable: false,
        pdfUrl: downgradedSource.pdfUrl,
        pdfCachePath: downgradedSource.pdfCachePath,
        textCachePath: downgradedSource.textCachePath,
        fallbackReason: "analysis_timeout_abstract_fallback"
      };
      args.onProgress?.(
        "Full-text extraction timed out again after removing rendered page images. Falling back to abstract-only analysis for this paper."
      );
      args.onProgress?.(
        "Using a deterministic abstract fallback immediately after repeated full-text timeouts so the first persisted analysis row can be materialized without another long LLM roundtrip."
      );
      return {
        analysis: synthesizeDeterministicAbstractFallbackResult({
          paper: args.paper,
          source: abstractSource,
          failureReason: retryError instanceof Error ? retryError.message : String(retryError),
          attempts: 1
        }),
        source: abstractSource
      };
    }
  }
}

async function analyzePaperWithOllamaVisionBatch(args: {
  ollamaPdfAnalysis: OllamaPdfAnalysisClient;
  llm: NodeExecutionDeps["llm"];
  paper: AnalysisCorpusRow;
  source: ResolvedPaperSource;
  abortSignal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<{ analysis: PaperAnalysisResult; source: ResolvedPaperSource }> {
  const pageImagePaths = args.source.pageImagePaths ?? [];
  if (pageImagePaths.length === 0) {
    return analyzePaperWithPageImageTimeoutFallback({
      llm: args.llm,
      paper: args.paper,
      source: args.source,
      abortSignal: args.abortSignal,
      onProgress: args.onProgress
    });
  }

  try {
    const prompt = buildPaperAnalysisPrompt(args.paper, args.source);
    args.onProgress?.(
      `Sending ${pageImagePaths.length} page image(s) to Ollama vision model for batched analysis.`
    );
    const batchResult = await args.ollamaPdfAnalysis.analyzePdfPages({
      imagePaths: pageImagePaths,
      prompt,
      systemPrompt: ANALYSIS_SYSTEM_PROMPT,
      abortSignal: args.abortSignal
    });

    args.onProgress?.(
      `Ollama vision batch complete: ${batchResult.pagesAnalyzed} page(s) analyzed${batchResult.model ? ` via ${batchResult.model}` : ""}.`
    );

    const visionText = batchResult.text.trim();
    if (!visionText) {
      args.onProgress?.("Ollama vision returned empty output. Falling back to text-based LLM analysis.");
      return analyzePaperWithPageImageTimeoutFallback({
        llm: args.llm,
        paper: args.paper,
        source: args.source,
        abortSignal: args.abortSignal,
        onProgress: args.onProgress
      });
    }

    // Combine the vision output with any existing full text for richer context
    const enrichedText = args.source.text
      ? `${args.source.text}\n\n--- Ollama Vision Analysis (${batchResult.pagesAnalyzed} pages) ---\n${visionText}`
      : visionText;
    const enrichedSource: ResolvedPaperSource = {
      ...args.source,
      text: enrichedText,
      pageImagePaths: undefined
    };

    const analysis = await analyzePaperWithLlm({
      llm: args.llm,
      paper: args.paper,
      source: enrichedSource,
      maxAttempts: 2,
      abortSignal: args.abortSignal,
      onProgress: args.onProgress
    });

    return { analysis, source: args.source };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    args.onProgress?.(
      `Ollama vision batch failed (${reason}). Falling back to text-based LLM analysis.`
    );
    return analyzePaperWithPageImageTimeoutFallback({
      llm: args.llm,
      paper: args.paper,
      source: args.source,
      abortSignal: args.abortSignal,
      onProgress: args.onProgress
    });
  }
}

function shouldRetryAnalysisWithoutPageImages(source: ResolvedPaperSource, error: unknown): boolean {
  if (source.sourceType !== "full_text" || (source.pageImagePaths?.length ?? 0) === 0) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /^paper_analysis_extractor_timeout_after_\d+ms$/u.test(message);
}

function shouldRetryAnalysisAsAbstractFallback(source: ResolvedPaperSource, error: unknown): boolean {
  if (source.sourceType !== "full_text" || (source.pageImagePaths?.length ?? 0) > 0) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /^paper_analysis_extractor_timeout_after_\d+ms$/u.test(message);
}

function stripSupplementalPageImages(source: ResolvedPaperSource): ResolvedPaperSource {
  if ((source.pageImagePaths?.length ?? 0) === 0) {
    return source;
  }
  return {
    ...source,
    pageImagePaths: undefined,
    pageImagePages: undefined
  };
}

async function syncAnalysisProgress(
  runContextMemory: RunContextMemory,
  input: {
    runContextPath: string;
    summaryRows: PaperSummaryRow[];
    evidenceRows: PaperEvidenceRow[];
    selectedCount: number;
    totalCandidates: number;
    selectionFingerprint: string;
  }
): Promise<void> {
  const progress = buildAnalysisProgress(input.summaryRows, input.evidenceRows);
  void runContextMemory;
  await upsertRunContextValues(input.runContextPath, {
    "analyze_papers.summary_count": progress.summaryRows.length,
    "analyze_papers.evidence_count": progress.evidenceRows.length,
    "analyze_papers.full_text_count": progress.fullTextCount,
    "analyze_papers.abstract_fallback_count": progress.abstractFallbackCount,
    "analyze_papers.selected_count": input.selectedCount,
    "analyze_papers.total_candidates": input.totalCandidates,
    "analyze_papers.selection_fingerprint": input.selectionFingerprint
  });
}

async function syncAnalyzeRunRecord(input: {
  runStore: Pick<NodeExecutionDeps["runStore"], "getRun" | "updateRun"> | undefined;
  runId: string;
  summary: string;
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

  run.graph.nodeStates.analyze_papers = {
    ...run.graph.nodeStates.analyze_papers,
    updatedAt: new Date().toISOString(),
    note: input.summary
  };

  if (run.currentNode === "analyze_papers" || !run.latestSummary) {
    run.latestSummary = input.summary;
  }

  await input.runStore.updateRun(run);
}

function replaceSummaryRow(rows: PaperSummaryRow[], nextRow: PaperSummaryRow): PaperSummaryRow[] {
  return [...rows.filter((row) => row.paper_id !== nextRow.paper_id), nextRow];
}

function replaceEvidenceRowsForPaper(
  rows: PaperEvidenceRow[],
  paperId: string,
  nextRows: PaperEvidenceRow[]
): PaperEvidenceRow[] {
  return [...rows.filter((row) => row.paper_id !== paperId), ...nextRows];
}

function getSelectedFailedPaperIds(manifest: AnalysisManifest): Set<string> {
  return new Set(
    Object.entries(manifest.papers)
      .filter(([, entry]) => entry.selected && entry.status === "failed")
      .map(([paperId]) => paperId)
  );
}

function shouldPauseForRepeatedAnalysisFailures(input: {
  previousFailedPaperIds: Set<string>;
  currentFailedPaperIds: Set<string>;
  priorRetryCount: number;
}): boolean {
  if (input.priorRetryCount < 1 || input.previousFailedPaperIds.size === 0 || input.currentFailedPaperIds.size === 0) {
    return false;
  }
  if (input.currentFailedPaperIds.size < input.previousFailedPaperIds.size) {
    for (const paperId of input.currentFailedPaperIds) {
      if (!input.previousFailedPaperIds.has(paperId)) {
        return false;
      }
    }
    return false;
  }
  return true;
}

function shouldPauseForZeroOutputStall(input: {
  selectedCount: number;
  attemptedCount: number;
  failedCount: number;
  timeoutFailureCount: number;
  priorRetryCount: number;
  progress: ReturnType<typeof buildAnalysisProgress>;
}): ZeroOutputPauseDecision | undefined {
  if (input.progress.summaryRows.length > 0 || input.progress.evidenceRows.length > 0) {
    return undefined;
  }
  if (input.attemptedCount === 0 || input.failedCount !== input.attemptedCount) {
    return undefined;
  }

  const timeoutOnlyFailures = input.timeoutFailureCount === input.failedCount && input.failedCount > 0;
  const threshold =
    input.priorRetryCount >= 1
      ? timeoutOnlyFailures && input.selectedCount >= ZERO_OUTPUT_TIMEOUT_RETRY_PAUSE_SAMPLE
        ? Math.min(input.selectedCount, ZERO_OUTPUT_TIMEOUT_RETRY_PAUSE_SAMPLE)
        : input.selectedCount >= ZERO_OUTPUT_RETRY_PAUSE_SAMPLE
          ? Math.min(input.selectedCount, ZERO_OUTPUT_RETRY_PAUSE_SAMPLE)
          : 0
      : input.selectedCount >= ZERO_OUTPUT_EARLY_PAUSE_MIN_SELECTED
        ? timeoutOnlyFailures
          ? Math.min(input.selectedCount, ZERO_OUTPUT_TIMEOUT_EARLY_PAUSE_SAMPLE)
          : Math.min(input.selectedCount, ZERO_OUTPUT_EARLY_PAUSE_SAMPLE)
        : 0;

  if (threshold === 0 || input.attemptedCount < threshold) {
    return undefined;
  }

  return {
    attemptedCount: input.attemptedCount,
    threshold
  };
}

function isAnalysisTimeoutError(message: string): boolean {
  return (
    /^paper_analysis_planner_timeout_after_\d+ms$/u.test(message) ||
    /^paper_analysis_extractor_timeout_after_\d+ms$/u.test(message) ||
    /^paper_analysis_reviewer_timeout_after_\d+ms$/u.test(message)
  );
}

function createAnalyzePapersManualReviewRecommendation(input: {
  runId: string;
  reason: string;
  evidence: string[];
  confidence: number;
  targetNode?: TransitionRecommendation["targetNode"];
  suggestedCommands?: string[];
}): TransitionRecommendation {
  return {
    action: "pause_for_human",
    sourceNode: "analyze_papers",
    targetNode: input.targetNode,
    reason: input.reason,
    confidence: Number(input.confidence.toFixed(2)),
    autoExecutable: false,
    evidence: input.evidence.slice(0, 4),
    suggestedCommands:
      input.suggestedCommands && input.suggestedCommands.length > 0
        ? input.suggestedCommands.slice(0, 4)
        : [`/agent run analyze_papers ${input.runId}`],
    generatedAt: new Date().toISOString()
  };
}

function applySelectionQualitySafeguards(input: {
  selection: PaperSelectionResult;
  runTitle: string;
  runTopic: string;
}): SelectionQualityGuardResult {
  if (
    input.selection.request.selectionMode !== "top_n" ||
    !input.selection.request.topN ||
    input.selection.selectedPaperIds.length === 0 ||
    input.selection.selectedPaperIds.length >= input.selection.totalCandidates
  ) {
    return {
      selection: input.selection,
      applied: false,
      droppedPaperIds: [],
      addedPaperIds: []
    };
  }

  const referenceAnchors = extractSelectionReferenceAnchors(`${input.runTitle || ""} ${input.runTopic || ""}`);
  if (referenceAnchors.length < MIN_SELECTION_GUARD_ANCHORS) {
    return {
      selection: input.selection,
      applied: false,
      droppedPaperIds: [],
      addedPaperIds: []
    };
  }

  const strictMode = Boolean(input.selection.rerankFallbackReason);
  const candidateSignalsById = new Map(
    input.selection.rankedCandidates.map((candidate) => [
      candidate.paper.paper_id,
      evaluateSelectionCandidateQuality(candidate, referenceAnchors)
    ] as const)
  );
  const orderedPaperIds =
    input.selection.rerankedPaperIds.length > 0
      ? input.selection.rerankedPaperIds
      : input.selection.rankedCandidates
          .slice()
          .sort(
            (left, right) =>
              (right.selectionScore ?? right.deterministicScore) - (left.selectionScore ?? left.deterministicScore) ||
              right.deterministicScore - left.deterministicScore ||
              left.paper.paper_id.localeCompare(right.paper.paper_id)
          )
          .map((candidate) => candidate.paper.paper_id);
  const targetCount = input.selection.selectedPaperIds.length;
  const eligiblePaperIds = orderedPaperIds.filter((paperId) => {
    const candidate = input.selection.rankedCandidates.find((item) => item.paper.paper_id === paperId);
    const signals = candidateSignalsById.get(paperId);
    if (!candidate || !signals || !passesSelectionQualityGuard(candidate, signals, strictMode)) {
      return false;
    }
    return true;
  });
  const nextSelectedPaperIds = eligiblePaperIds.slice(0, targetCount);

  const previousSelection = input.selection.selectedPaperIds;
  if (!strictMode && nextSelectedPaperIds.length < targetCount) {
    return {
      selection: input.selection,
      applied: false,
      droppedPaperIds: [],
      addedPaperIds: []
    };
  }
  if (arraysEqual(previousSelection, nextSelectedPaperIds)) {
    return {
      selection: input.selection,
      applied: false,
      droppedPaperIds: [],
      addedPaperIds: [],
      eligiblePaperIds
    };
  }

  const nextSelectedSet = new Set(nextSelectedPaperIds);
  const nextRankedCandidates = input.selection.rankedCandidates.map((candidate) => ({
    ...candidate,
    selected: nextSelectedSet.has(candidate.paper.paper_id),
    rank: nextSelectedSet.has(candidate.paper.paper_id)
      ? nextSelectedPaperIds.indexOf(candidate.paper.paper_id) + 1
      : undefined
  }));
  const droppedPaperIds = previousSelection.filter((paperId) => !nextSelectedSet.has(paperId));
  const addedPaperIds = nextSelectedPaperIds.filter((paperId) => !previousSelection.includes(paperId));
  const cleanedFallbackReason = cleanFailureMessage(input.selection.rerankFallbackReason);

  return {
    selection: {
      ...input.selection,
      selectedPaperIds: nextSelectedPaperIds,
      selectionFingerprint: buildSelectionFingerprint(
        input.selection.request,
        input.runTitle,
        input.runTopic,
        nextSelectedPaperIds
      ),
      rankedCandidates: nextRankedCandidates
    },
    applied: true,
    droppedPaperIds,
    addedPaperIds,
    eligiblePaperIds,
    reason:
      `Selection quality safeguard ${strictMode ? "tightened the rerank-fallback shortlist" : "filtered weakly grounded shortlist items"} ` +
      `using research anchors [${referenceAnchors.join(", ")}]. ` +
      `Dropped ${droppedPaperIds.length} off-topic paper(s)` +
      `${addedPaperIds.length > 0 ? ` and promoted ${addedPaperIds.length} replacement(s)` : ""}.` +
      `${cleanedFallbackReason ? ` Fallback context: ${cleanedFallbackReason}` : ""}`
  };
}

function extractSelectionReferenceAnchors(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .match(/[a-z0-9]+/g)
        ?.map((token) => normalizeSelectionToken(token))
        .filter(
          (token): token is string =>
            Boolean(token) &&
            token.length >= 4 &&
            !SELECTION_QUALITY_STOPWORDS.has(token) &&
            !SELECTION_QUALITY_GENERIC_TOKENS.has(token)
        ) ?? []
    )
  );
}

function normalizeSelectionToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (normalized.endsWith("ies") && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (/(ches|shes|xes|zes)$/.test(normalized) && normalized.length > 4) {
    return normalized.slice(0, -2);
  }
  if (normalized.endsWith("s") && normalized.length > 4) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function evaluateSelectionCandidateQuality(
  candidate: RankedPaperCandidate,
  referenceAnchors: string[]
): {
  titleAnchorHits: number;
  strongTitleAnchorHits: number;
  abstractAnchorHits: number;
  totalAnchorHits: number;
  offTopicDomainHits: number;
} {
  const titleTokens = new Set(
    (candidate.paper.title.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((token) => normalizeSelectionToken(token))
  );
  const abstractTokens = new Set(
    (candidate.paper.abstract?.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((token) => normalizeSelectionToken(token))
  );
  const titleAnchorHits = referenceAnchors.filter((token) => titleTokens.has(token)).length;
  const strongTitleAnchorHits = referenceAnchors.filter(
    (token) => titleTokens.has(token) && !SELECTION_QUALITY_WEAK_TITLE_ANCHORS.has(token)
  ).length;
  const abstractAnchorHits = referenceAnchors.filter((token) => !titleTokens.has(token) && abstractTokens.has(token)).length;
  const referenceAnchorSet = new Set(referenceAnchors);
  const offTopicDomainHits = Array.from(SELECTION_QUALITY_DOMAIN_TOKENS).filter(
    (token) => titleTokens.has(token) && !referenceAnchorSet.has(token)
  ).length;
  return {
    titleAnchorHits,
    strongTitleAnchorHits,
    abstractAnchorHits,
    totalAnchorHits: titleAnchorHits + abstractAnchorHits,
    offTopicDomainHits
  };
}

function passesSelectionQualityGuard(
  candidate: RankedPaperCandidate,
  signals: {
    titleAnchorHits: number;
    strongTitleAnchorHits: number;
    abstractAnchorHits: number;
    totalAnchorHits: number;
    offTopicDomainHits: number;
  },
  strictMode: boolean
): boolean {
  if (strictMode && signals.titleAnchorHits === 0) {
    return false;
  }
  if (strictMode && signals.offTopicDomainHits > 0) {
    return false;
  }
  if (signals.strongTitleAnchorHits >= 1) {
    return true;
  }
  if (!strictMode && signals.titleAnchorHits >= 1) {
    return true;
  }
  if (strictMode && signals.titleAnchorHits >= 2) {
    return true;
  }
  if (
    signals.totalAnchorHits >= (strictMode ? 3 : 1) &&
    candidate.scoreBreakdown.title_similarity_score >= (strictMode ? 0.18 : 0.08)
  ) {
    return true;
  }
  return !strictMode && candidate.deterministicScore >= 0.5 && candidate.scoreBreakdown.title_similarity_score >= 0.25;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function upsertRunContextValues(runContextPath: string, updates: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const store = await readJsonFile<{ version?: unknown; items?: Array<{ key?: unknown; value?: unknown; updatedAt?: unknown }> }>(
    runContextPath
  ).catch(() => ({
    version: 1,
    items: []
  }));
  const items = Array.isArray(store.items) ? [...store.items] : [];

  for (const [key, value] of Object.entries(updates)) {
    const nextItem = {
      key,
      value,
      updatedAt: now
    };
    const existingIndex = items.findIndex((item) => item?.key === key);
    if (existingIndex >= 0) {
      items[existingIndex] = nextItem;
    } else {
      items.push(nextItem);
    }
  }

  await writeJsonFile(runContextPath, {
    version: 1,
    items
  });
}

async function runAnalyzeCodexPreflight(input: {
  codex: NodeExecutionDeps["codex"];
  llmMode: NodeExecutionDeps["config"]["providers"]["llm_mode"] | undefined;
  analysisMode: "codex_text_image_hybrid" | "responses_api_pdf" | "ollama_vision";
  researchModel: string | undefined;
}): Promise<DoctorCheck[]> {
  if (input.llmMode !== "codex" && input.llmMode !== "codex_chatgpt_only") {
    return [];
  }

  const checks: DoctorCheck[] = [];
  const oauth = await checkCodexOAuthStatus();
  checks.push({ name: "codex-oauth", ok: oauth.ok, detail: oauth.detail });
  if (typeof input.codex.checkEnvironmentReadiness === "function") {
    checks.push(
      ...(await input.codex.checkEnvironmentReadiness()).map((check) => ({
        name: check.name,
        ok: check.ok,
        detail: check.detail
      }))
    );
  }
  if (input.researchModel) {
    checks.push(
      buildAnalyzeCodexModelCheck("codex-research-backend-model", "research backend", input.researchModel)
    );
  }
  return checks.filter((check) => !check.ok);
}

function isCodexModelCheck(name: string): boolean {
  return name === "codex-research-backend-model";
}

function buildAnalyzeCodexModelCheck(name: string, label: string, model: string): DoctorCheck {
  const normalized = model.trim();
  if (normalized.toLowerCase().includes("spark")) {
    return {
      name,
      ok: false,
      detail:
        `Configured Codex ${label} model ${normalized} is a short-run Spark profile. ` +
        `Switch ${label} work to ${RECOMMENDED_CODEX_MODEL} before rerank or paper analysis.`
    };
  }
  return {
    name,
    ok: true,
    detail: `Configured Codex ${label} model ${normalized} is suitable for rerank and paper analysis.`
  };
}

function summarizeSelectedFailures(
  manifest: AnalysisManifest,
  selectedPaperIds: string[]
): SelectedFailureSummary {
  const selectedSet = new Set(selectedPaperIds);
  const failedEntries = Object.values(manifest.papers).filter(
    (entry) => selectedSet.has(entry.paper_id) && entry.status === "failed"
  );
  return {
    failedEntries,
    usageLimitEntries: failedEntries.filter((entry) => isModelUsageLimitError(entry.last_error)),
    environmentBlockedEntries: failedEntries.filter((entry) => isEnvironmentBlockedError(entry.last_error)),
    sourceMismatchEntries: failedEntries.filter((entry) => isSourceContentMismatchError(entry.last_error)),
    cleanedMessages: Array.from(
      new Set(
        failedEntries
          .map((entry) => cleanFailureMessage(entry.last_error))
          .filter((message): message is string => Boolean(message))
      )
    )
  };
}

function cleanFailureMessage(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  const lines = message
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isBenignCodexCleanupWarning(line));
  const cleaned = (lines.length > 0 ? lines.join(" ") : message.trim()).trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
}

function isBenignCodexCleanupWarning(message: string): boolean {
  return /codex_core::shell_snapshot/i.test(message) || /failed to delete shell snapshot/i.test(message);
}

function isModelUsageLimitError(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  return (
    /usage limit/i.test(message) ||
    /switch to another model/i.test(message) ||
    /try again at \d{1,2}:\d{2}/i.test(message) ||
    /quota exceeded/i.test(message)
  );
}

function isEnvironmentBlockedError(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  return [
    /operation not permitted/i,
    /failed to write models cache/i,
    /readonly database/i,
    /read-only database/i,
    /could not update path/i,
    /attempt to write a readonly database/i
  ].some((pattern) => pattern.test(message));
}

function isSourceContentMismatchError(message: string | undefined): boolean {
  return typeof message === "string" && /source_content_mismatch|analysis_content_mismatch/i.test(message);
}

const SOURCE_IDENTITY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "approach",
  "assessment",
  "based",
  "benchmark",
  "benchmarking",
  "classification",
  "comparative",
  "data",
  "driven",
  "empirical",
  "evaluation",
  "for",
  "framework",
  "from",
  "improved",
  "in",
  "learning",
  "machine",
  "method",
  "methods",
  "model",
  "models",
  "of",
  "on",
  "paper",
  "predicting",
  "review",
  "study",
  "system",
  "systems",
  "tabular",
  "the",
  "toward",
  "using",
  "with"
]);

function validateResolvedSourceIdentity(paper: AnalysisCorpusRow, source: ResolvedPaperSource): string | undefined {
  if (source.sourceType !== "full_text") {
    return undefined;
  }

  const sourceText = (source.groundingText ?? source.text).trim();
  if (!sourceText) {
    return undefined;
  }

  const abstractText = paper.abstract?.trim();
  if (sourceText === paper.title.trim() || (abstractText && sourceText === abstractText)) {
    return undefined;
  }

  const normalizedSource = normalizeIdentityText(sourceText);
  const normalizedTitle = normalizeIdentityText(paper.title);
  if (normalizedTitle && normalizedSource.includes(normalizedTitle)) {
    return undefined;
  }

  const titleTokens = Array.from(
    new Set(
      (paper.title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
        (token) => token.length >= 4 && !SOURCE_IDENTITY_STOPWORDS.has(token)
      )
    )
  );
  if (titleTokens.length === 0) {
    return undefined;
  }

  const matchedTitleTokens = titleTokens.filter((token) => normalizedSource.includes(token));
  if (matchedTitleTokens.length >= Math.min(2, titleTokens.length)) {
    return undefined;
  }

  const authorTokens = Array.from(
    new Set(
      paper.authors
        .flatMap((author) => author.toLowerCase().match(/[a-z0-9]+/g) ?? [])
        .filter((token) => token.length >= 4 && !SOURCE_IDENTITY_STOPWORDS.has(token))
    )
  );
  const hasAuthorMatch = authorTokens.some((token) => normalizedSource.includes(token));
  if (matchedTitleTokens.length >= 1 && hasAuthorMatch) {
    return undefined;
  }

  return (
    `source_content_mismatch: resolved source text for "${paper.title}" did not match the paper identity strongly enough ` +
    `(matched_title_tokens=${matchedTitleTokens.length}/${titleTokens.length}, author_match=${hasAuthorMatch ? "yes" : "no"}).`
  );
}

function validateAnalysisBeforePersist(
  paper: AnalysisCorpusRow,
  source: ResolvedPaperSource,
  analysis: {
    summaryRow: PaperSummaryRow;
    evidenceRows: PaperEvidenceRow[];
  }
): string | undefined {
  const sourceMismatchError = validateResolvedSourceIdentity(paper, source);
  if (sourceMismatchError) {
    return sourceMismatchError;
  }

  const analysisTexts = [
    analysis.summaryRow.summary,
    ...analysis.summaryRow.key_findings,
    ...analysis.summaryRow.limitations,
    ...analysis.summaryRow.reproducibility_notes,
    analysis.summaryRow.novelty,
    ...analysis.evidenceRows.flatMap((row) => [row.claim, row.confidence_reason ?? "", row.evidence_span])
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!analysisTexts) {
    return undefined;
  }

  const mismatchPatterns = [
    /(supplied|provided)\s+source\s+(text|document|paper).*(unrelated|different paper|another paper)/i,
    /(supplied|provided|resolved|input)\s+source\s+(text|document|paper).*(does not match|did not match|mismatch)/i,
    /(supplied|provided|resolved|input)\s+(document|paper).*(appears|seems)\s+to\s+be.*instead of/i
  ];
  if (mismatchPatterns.some((pattern) => pattern.test(analysisTexts))) {
    return (
      `analysis_content_mismatch: structured analysis for "${paper.title}" reported a probable source-identity mismatch ` +
      `inside the extracted summary/evidence, so the outputs were quarantined before persistence.`
    );
  }

  return undefined;
}

function buildAnalysisQuarantineRow(input: {
  paper: AnalysisCorpusRow;
  source: ResolvedPaperSource;
  analysisMode: "codex_text_image_hybrid" | "responses_api_pdf" | "ollama_vision";
  reason: string;
  analysis?: {
    summaryRow: PaperSummaryRow;
  };
}): AnalysisQuarantineRow {
  return {
    paper_id: input.paper.paper_id,
    title: input.paper.title,
    reason: input.reason,
    source_type: input.source.sourceType,
    analysis_mode: input.analysisMode,
    fallback_reason: input.source.fallbackReason,
    summary_preview: input.analysis?.summaryRow.summary.slice(0, 240),
    source_excerpt: input.source.text.slice(0, 240),
    createdAt: new Date().toISOString()
  };
}

function normalizeIdentityText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function reconcileManifestWithOutputs(
  manifest: AnalysisManifest,
  summaryRows: PaperSummaryRow[],
  evidenceRows: PaperEvidenceRow[]
): {
  manifest: AnalysisManifest;
  summaryRows: PaperSummaryRow[];
  evidenceRows: PaperEvidenceRow[];
  changed: boolean;
  requeuedPaperIds: string[];
  droppedSummaryRows: number;
  droppedEvidenceRows: number;
} {
  const now = new Date().toISOString();
  const nextManifest: AnalysisManifest = {
    ...manifest,
    papers: { ...manifest.papers }
  };
  const summariesByPaper = new Map<string, PaperSummaryRow[]>();
  const evidencesByPaper = new Map<string, PaperEvidenceRow[]>();
  let changed = false;
  const requeuedPaperIds: string[] = [];

  for (const row of summaryRows) {
    const rows = summariesByPaper.get(row.paper_id) ?? [];
    rows.push(row);
    summariesByPaper.set(row.paper_id, rows);
  }
  for (const row of evidenceRows) {
    const rows = evidencesByPaper.get(row.paper_id) ?? [];
    rows.push(row);
    evidencesByPaper.set(row.paper_id, rows);
  }

  const retainedPaperIds = new Set<string>();
  for (const [paperId, entry] of Object.entries(manifest.papers)) {
    if (!entry.selected || entry.status !== "completed") {
      continue;
    }
    const paperSummaries = summariesByPaper.get(paperId) ?? [];
    const paperEvidence = evidencesByPaper.get(paperId) ?? [];
    if (paperSummaries.length !== 1 || paperEvidence.length === 0) {
      changed = true;
      requeuedPaperIds.push(paperId);
      nextManifest.papers[paperId] = {
        ...entry,
        status: "pending",
        summary_count: 0,
        evidence_count: 0,
        last_error: "missing_analysis_outputs",
        updatedAt: now,
        completedAt: undefined
      };
      continue;
    }

    retainedPaperIds.add(paperId);
    const summary = paperSummaries[0];
    if (
      entry.summary_count !== 1 ||
      entry.evidence_count !== paperEvidence.length ||
      entry.source_type !== summary.source_type
    ) {
      changed = true;
      nextManifest.papers[paperId] = {
        ...entry,
        source_type: summary.source_type,
        summary_count: 1,
        evidence_count: paperEvidence.length,
        updatedAt: now
      };
    }
  }

  const nextSummaryRows = summaryRows.filter((row) => retainedPaperIds.has(row.paper_id));
  const nextEvidenceRows = evidenceRows.filter((row) => retainedPaperIds.has(row.paper_id));
  if (nextSummaryRows.length !== summaryRows.length || nextEvidenceRows.length !== evidenceRows.length) {
    changed = true;
  }
  if (changed) {
    nextManifest.updatedAt = now;
  }

  const droppedSummaryRows = summaryRows.length - nextSummaryRows.length;
  const droppedEvidenceRows = evidenceRows.length - nextEvidenceRows.length;
  return {
    manifest: nextManifest,
    summaryRows: nextSummaryRows,
    evidenceRows: nextEvidenceRows,
    changed,
    requeuedPaperIds,
    droppedSummaryRows,
    droppedEvidenceRows
  };
}

async function readSummaryRows(filePath: string): Promise<PaperSummaryRow[]> {
  const raw = await safeRead(filePath);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as PaperSummaryRow;
      } catch {
        return undefined;
      }
    })
    .filter((row): row is PaperSummaryRow => Boolean(row?.paper_id));
}

async function readEvidenceRows(filePath: string): Promise<PaperEvidenceRow[]> {
  const raw = await safeRead(filePath);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as PaperEvidenceRow;
      } catch {
        return undefined;
      }
    })
    .filter((row): row is PaperEvidenceRow => Boolean(row?.paper_id));
}

function analyzeStructureSignals(text: string): {
  tableReferenceCount: number;
  figureReferenceCount: number;
} {
  const normalized = text.replace(/\s+/g, " ");
  const tableMatches =
    normalized.match(/\btable(?:s)?\.?\s*(?:\d+|[ivxlcdm]+)\b/giu) ?? [];
  const figureMatches =
    normalized.match(/\b(?:fig(?:ure)?(?:s)?\.?)\s*(?:\d+|[ivxlcdm]+)\b/giu) ?? [];
  return {
    tableReferenceCount: tableMatches.length,
    figureReferenceCount: figureMatches.length
  };
}
