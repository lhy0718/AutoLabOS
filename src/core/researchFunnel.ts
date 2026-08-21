import { createHash } from "node:crypto";

import { hashCanonical } from "./canonicalHash.js";
import type {
  HypothesisCandidate,
  HypothesisEvidenceAxis,
  HypothesisEvidenceSeed,
  HypothesisReview
} from "./analysis/researchPlanning.js";
import { isHypothesisReviewProvenanceAuthorizing } from "./analysis/hypothesisReviewProvenance.js";
import { classifyResearchOpportunityEvidence } from "./analysis/researchGapSynthesis.js";
import {
  isResearchOpportunityType,
  type ResearchOpportunityType
} from "./researchOpportunity.js";
import {
  buildCandidateObjectiveRaw,
  effectCriterionValuesEqual,
  isEffectCriterion,
  isExplicitMetricScale,
  parseEffectCriterion,
  type CandidateMetricScale,
  type EffectCriterion
} from "./effectCriterion.js";
import {
  buildPriorAbsorptionCandidateContract,
  isPriorAbsorptionCandidateProjection,
  projectPriorAbsorptionCandidate,
  validatePriorAbsorptionMatrixArtifact,
  type PriorAbsorptionCandidateProjection,
  type PriorAbsorptionMatrix,
  type PriorAbsorptionMatrixValidation
} from "./priorAbsorption.js";
import {
  isTopicProbeComputeBudgetLimits,
  parseTopicProbeComputeBudgetDeclaration,
  topicProbeComputeBudgetFitsWithin,
  type TopicProbeComputeBudgetLimits
} from "./topicProbeComputeBudget.js";
import {
  buildTopicFormulationDescriptor,
  createTopicMemoryLedger,
  evaluateTopicMemory,
  requireValidTopicMemoryLedger,
  validateTopicMemoryLedger,
  type TopicFormulationDescriptor,
  type TopicMemoryDecision,
  type TopicMemoryLedger,
  type TopicReentryTicket
} from "./topicMemory.js";
import type { TopicMemorySemanticAudit } from "./topicMemorySemanticAudit.js";
import {
  isCandidatePriorSearchReviewBinding,
  type CandidatePriorSearchReviewBinding
} from "./candidatePriorSearch.js";

export { hashCanonical } from "./canonicalHash.js";

export const TOPIC_PORTFOLIO_MIN_CANDIDATES = 5;
export const TOPIC_PORTFOLIO_MAX_CANDIDATES = 7;
export const TOPIC_PORTFOLIO_MIN_DISTINCT_CLUSTERS = 3;
export const RESEARCH_GAP_MAP_SEMANTICS_VERSION = 3;
export const RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS = [
  "analysis/gap_map.json",
  "hypothesis_generation/evidence_axes.json",
  "hypothesis_generation/prior_absorption_matrix.json",
  "hypotheses.jsonl",
  "hypothesis_generation/drafts.jsonl",
  "hypothesis_generation/reviews.jsonl",
  "hypothesis_generation/probe_shortlist.json"
] as const;

export type ResearchFunnelSourceArtifactPath =
  (typeof RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS)[number];

export type ResearchFunnelGateStatus = "pass" | "block";

export interface ResearchFunnelGate {
  code: string;
  status: ResearchFunnelGateStatus;
  message: string;
}

export interface ResearchFunnelArtifactBinding {
  path: ResearchFunnelSourceArtifactPath;
  sha256: string;
  byte_length: number;
}

export interface ResearchGapCandidate {
  gap_id: string;
  construction_origin: "reviewed_cluster" | "exact_grouping";
  opportunity_type?: ResearchOpportunityType;
  statement: string;
  evidence_links: string[];
  paper_ids: string[];
  source_types: Array<"full_text" | "abstract">;
  datasets: string[];
  metrics: string[];
  support: {
    distinct_paper_count: number;
    full_text_paper_count: number;
    abstract_only_paper_count: number;
  };
  epistemic_status: "supported_candidate" | "provisional_candidate";
  gates: ResearchFunnelGate[];
}

export interface ResearchGapClusterSeed {
  statement: string;
  evidence_ids: string[];
  opportunity_type?: ResearchOpportunityType;
}

export interface ResearchGapMap {
  schema_version: 1;
  artifact_kind: "research_gap_evidence_map";
  semantics_version: number;
  epistemic_status: "candidate_evidence_map";
  construction_mode:
    | "legacy_exact_grouping"
    | "reviewed_semantic_synthesis"
    | "deterministic_safe_fallback"
    | "deferred_partial_analysis";
  synthesis_binding?: {
    content_sha256: string;
    semantics_version: number;
    status: "completed" | "safe_fallback";
  };
  analysis_coverage: {
    selected_paper_count: number;
    completed_paper_count: number;
    failed_paper_ids: string[];
    complete: boolean;
  };
  run_id: string;
  research_cycle: number;
  collect_attempt_id: string;
  corpus_sha256: string;
  corpus_byte_length: number;
  evidence_sha256: string;
  evidence_byte_length: number;
  generated_at: string;
  source_artifacts: string[];
  gaps: ResearchGapCandidate[];
  gates: ResearchFunnelGate[];
  content_sha256: string;
}

export interface ResearchGapMapValidation {
  measured: boolean;
  valid: boolean;
  reasons: string[];
  gapMap?: ResearchGapMap;
}

export interface TopicPortfolioCandidate {
  topic_id: string;
  topic_lineage_id?: string;
  formulation_id?: string;
  formulation_version?: number;
  source_candidate_id: string;
  statement: string;
  gap_statement?: string;
  cluster_ids: string[];
  unresolved_cluster_ids: string[];
  supported_gap_ids: string[];
  evidence_links: string[];
  unresolved_evidence_links: string[];
  closest_prior_paper_ids: string[];
  closest_prior_full_text_paper_ids: string[];
  candidate_prior_search?: CandidatePriorSearchReviewBinding;
  prior_absorption?: PriorAbsorptionCandidateProjection;
  closest_prior_non_overlap?: string;
  reviewer_absorption_objection?: string;
  comparator?: string;
  dataset_task_bench?: string;
  primary_metric?: string;
  metric_unit?: string;
  metric_scale?: CandidateMetricScale;
  metric_direction?: "maximize" | "minimize";
  meaningful_effect?: string;
  effect_criterion?: EffectCriterion;
  objective_raw?: string;
  falsifier?: string;
  local_budget?: string;
  brief_compute_budget_ceiling?: TopicProbeComputeBudgetLimits;
  kill_signal?: string;
  contribution_claim?: string;
  minimum_publishable_evidence?: string;
  review_status: "kept" | "rejected" | "not_reviewed";
  probe_status: "shortlisted" | "not_shortlisted";
  review_summary?: string;
  topic_memory?: {
    ledger_sha256: string;
    descriptor?: TopicFormulationDescriptor;
    reentry_ticket?: TopicReentryTicket;
    semantic_audit?: TopicMemorySemanticAudit;
    decision: TopicMemoryDecision;
  };
  scores: {
    novelty: number;
    feasibility: number;
    testability: number;
    cost: number;
    expected_gain: number;
  };
  gates: ResearchFunnelGate[];
  probe_eligible: boolean;
  content_sha256: string;
}

export interface TopicPortfolio {
  schema_version: 1;
  artifact_kind: "research_topic_portfolio";
  generated_at: string;
  run_id: string;
  research_cycle: number;
  source_artifacts: string[];
  source_artifact_bindings: ResearchFunnelArtifactBinding[];
  source_gap_map_sha256?: string;
  source_prior_absorption_matrix_sha256?: string;
  topic_memory_ledger?: TopicMemoryLedger;
  candidate_policy: {
    minimum: number;
    maximum: number;
    observed: number;
  };
  candidates: TopicPortfolioCandidate[];
  cluster_policy: {
    minimum_distinct_nonempty: number;
    observed_distinct_nonempty: number;
  };
  overflow_candidates: Array<{
    source_candidate_id: string;
    reason: "portfolio_maximum_exceeded";
  }>;
  probe_candidate_ids: string[];
  gates: ResearchFunnelGate[];
  probe_allowed: boolean;
  probe_topic_ids: string[];
  content_sha256: string;
}
export interface TopicPortfolioValidation {
  measured: boolean;
  valid: boolean;
  reasons: string[];
  portfolio?: TopicPortfolio;
}

export interface TopicDecision {
  schema_version: 1;
  artifact_kind: "research_topic_probe_authorization";
  run_id: string;
  generated_at: string;
  portfolio_content_sha256?: string;
  research_cycle: number;
  probe_candidate_ids: string[];
  disposition: "probe_authorized" | "backtrack_to_hypotheses";
  probe_allowed: boolean;
  probe_topic_ids: string[];
  reason_codes: string[];
  content_sha256: string;
}

export interface TopicDecisionValidation {
  measured: boolean;
  valid: boolean;
  reasons: string[];
  decision?: TopicDecision;
}

export interface ResearchFunnelValidationContext {
  expectedRunId?: string;
  expectedResearchCycle?: number;
  expectedCollectAttemptId?: string;
  expectedCorpusSha256?: string;
  expectedCorpusByteLength?: number;
  expectedEvidenceSha256?: string;
  expectedEvidenceByteLength?: number;
  evidence?: HypothesisEvidenceSeed[];
  reviewedClusters?: ResearchGapClusterSeed[];
  requireExternalEvidence?: boolean;
  requireReviewedSynthesis?: boolean;
  synthesisArtifactValid?: boolean;
  expectedSynthesisContentSha256?: string;
  expectedSynthesisSemanticsVersion?: number;
  expectedAnalysisComplete?: boolean;
  allowUnbound?: boolean;
}

export interface ResearchGapMapBindingResult {
  changed: boolean;
  raw?: string;
  validation: ResearchGapMapValidation;
}

export interface ResearchFunnelClosedChainInput {
  expectedRunId: string;
  expectedResearchCycle: number;
  gapMapRaw?: string;
  evidenceAxesRaw?: string;
  priorAbsorptionMatrixRaw?: string;
  hypothesesRaw?: string;
  draftsRaw?: string;
  reviewsRaw?: string;
  probeShortlistRaw?: string;
  portfolioRaw?: string;
  decisionRaw?: string;
  requireDecision?: boolean;
  gapValidationContext?: Omit<
    ResearchFunnelValidationContext,
    "expectedRunId" | "expectedResearchCycle" | "allowUnbound"
  >;
  gapValidationReasonCodes?: string[];
}

export interface ResearchFunnelClosedChainValidation {
  measured: boolean;
  complete: boolean;
  valid: boolean;
  probeAllowed: boolean;
  reasons: string[];
  approvedCandidateIds: string[];
  approvedTopicIds: string[];
  gapMapValidation: ResearchGapMapValidation;
  evidenceAxesValidation: HypothesisEvidenceAxesValidation;
  priorAbsorptionMatrixValidation: PriorAbsorptionMatrixValidation;
  portfolioValidation: TopicPortfolioValidation;
  decisionValidation: TopicDecisionValidation;
  gapMap?: ResearchGapMap;
  evidenceAxes?: HypothesisEvidenceAxis[];
  priorAbsorptionMatrix?: PriorAbsorptionMatrix;
  portfolio?: TopicPortfolio;
  decision?: TopicDecision;
}

export interface HypothesisEvidenceAxesValidation {
  measured: boolean;
  valid: boolean;
  reasons: string[];
  axes?: HypothesisEvidenceAxis[];
}

interface ResearchFunnelProbeShortlist {
  run_id: string;
  research_cycle: number;
  probe_candidate_ids: string[];
  probe_topic_ids: string[];
  ranked_candidate_ids: string[];
  scores: Array<{ candidate_id?: unknown }>;
}

export function buildResearchGapMap(input: {
  evidence: HypothesisEvidenceSeed[];
  semanticClusters?: ResearchGapClusterSeed[];
  excludedEvidenceIds?: string[];
  constructionMode?: ResearchGapMap["construction_mode"];
  synthesisBinding?: ResearchGapMap["synthesis_binding"];
  analysisCoverage?: ResearchGapMap["analysis_coverage"];
  runId?: string;
  researchCycle?: number;
  collectAttemptId?: string;
  corpusSha256?: string;
  corpusByteLength?: number;
  evidenceSha256?: string;
  evidenceByteLength?: number;
  generatedAt?: string;
  sourceArtifacts?: string[];
}): ResearchGapMap {
  const constructionMode = input.constructionMode ?? (
    input.synthesisBinding?.status === "completed"
      ? "reviewed_semantic_synthesis"
      : input.synthesisBinding?.status === "safe_fallback"
        ? "deterministic_safe_fallback"
        : input.semanticClusters !== undefined
          ? "reviewed_semantic_synthesis"
          : "legacy_exact_grouping"
  );
  const evidencePaperIds = uniqueStrings(input.evidence.map((item) => item.paper_id));
  const analysisCoverage = input.analysisCoverage ?? {
    selected_paper_count: evidencePaperIds.length,
    completed_paper_count: evidencePaperIds.length,
    failed_paper_ids: [],
    complete: constructionMode === "legacy_exact_grouping"
  };
  const semanticSupportAllowed =
    constructionMode === "reviewed_semantic_synthesis" &&
    input.synthesisBinding?.status === "completed" &&
    analysisCoverage.complete;
  const excludedEvidenceIds = new Set(
    uniqueStrings(input.excludedEvidenceIds ?? [])
  );
  const evidenceById = new Map<string, HypothesisEvidenceSeed>();
  for (const evidence of input.evidence) {
    const evidenceId = normalizeOptionalText(evidence.evidence_id);
    if (evidenceId && !evidenceById.has(evidenceId)) {
      evidenceById.set(evidenceId, evidence);
    }
  }
  const assignedEvidenceIds = new Set<string>();
  const semanticGroups: Array<{
    statement: string;
    items: HypothesisEvidenceSeed[];
    opportunityType?: ResearchOpportunityType;
  }> = [];
  for (const cluster of (input.semanticClusters ?? []).slice().sort((left, right) =>
    (normalizeOptionalText(left.statement) ?? "").localeCompare(
      normalizeOptionalText(right.statement) ?? ""
    )
  )) {
    const statement = normalizeOptionalText(cluster.statement);
    if (!statement || isNonLimitation(statement) || !cluster.opportunity_type) {
      continue;
    }
    const items = uniqueStrings(cluster.evidence_ids)
      .filter(
        (evidenceId) =>
          !excludedEvidenceIds.has(evidenceId)
      )
      .map((evidenceId) => evidenceById.get(evidenceId))
      .filter((evidence): evidence is HypothesisEvidenceSeed => Boolean(evidence));
    const fullTextPaperIds = uniqueStrings(
      items
        .filter((item) => item.source_type === "full_text")
        .map((item) => item.paper_id)
    );
    if (fullTextPaperIds.length < 2) {
      continue;
    }
    for (const item of items) {
      const evidenceId = normalizeOptionalText(item.evidence_id);
      if (evidenceId) {
        assignedEvidenceIds.add(evidenceId);
      }
    }
    semanticGroups.push({
      statement,
      items,
      opportunityType: cluster.opportunity_type
    });
  }

  const groups = new Map<string, HypothesisEvidenceSeed[]>();
  for (const evidence of input.evidence) {
    const evidenceId = normalizeOptionalText(evidence.evidence_id);
    if (
      (evidenceId && excludedEvidenceIds.has(evidenceId)) ||
      (evidenceId && assignedEvidenceIds.has(evidenceId))
    ) {
      continue;
    }
    const statement = normalizeOptionalText(evidence.limitation_slot);
    if (!statement || isNonLimitation(statement)) {
      continue;
    }
    const key = normalizeGroupingKey(statement);
    const current = groups.get(key) || [];
    current.push(evidence);
    groups.set(key, current);
  }

  const gaps = [
    ...semanticGroups.map((group) =>
      buildGapCandidate(
        group.items,
        group.statement,
        semanticSupportAllowed,
        "reviewed_cluster",
        group.opportunityType
      )
    ),
    ...[...groups.values()].map((items) =>
      buildGapCandidate(items, undefined, constructionMode === "legacy_exact_grouping", "exact_grouping")
    )
  ]
    .sort((left, right) => left.gap_id.localeCompare(right.gap_id));
  const gates: ResearchFunnelGate[] = [
    gate(
      "gap_candidate_present",
      gaps.length > 0,
      gaps.length > 0
        ? `${gaps.length} evidence-backed gap candidate(s) recorded.`
        : "No explicit limitation evidence is available for gap synthesis."
    ),
    gate(
      "independent_gap_support_present",
      gaps.some((gap) => gap.epistemic_status === "supported_candidate"),
      gaps.some((gap) => gap.epistemic_status === "supported_candidate")
        ? "At least one gap candidate has independent paper support and full-text evidence."
        : "No gap candidate has support from at least two papers including full-text evidence."
    )
  ];
  const payload = {
    schema_version: 1 as const,
    artifact_kind: "research_gap_evidence_map" as const,
    semantics_version: RESEARCH_GAP_MAP_SEMANTICS_VERSION,
    epistemic_status: "candidate_evidence_map" as const,
    construction_mode: constructionMode,
    ...(input.synthesisBinding ? { synthesis_binding: input.synthesisBinding } : {}),
    analysis_coverage: analysisCoverage,
    run_id: normalizeOptionalText(input.runId) || "",
    research_cycle: normalizeResearchCycle(input.researchCycle),
    collect_attempt_id: normalizeOptionalText(input.collectAttemptId) || "",
    corpus_sha256: normalizeOptionalText(input.corpusSha256) || "",
    corpus_byte_length: normalizeArtifactByteLength(input.corpusByteLength),
    evidence_sha256: normalizeOptionalText(input.evidenceSha256) || "",
    evidence_byte_length: normalizeArtifactByteLength(input.evidenceByteLength),
    generated_at: input.generatedAt || new Date().toISOString(),
    source_artifacts: input.sourceArtifacts || ["paper_summaries.jsonl", "evidence_store.jsonl"],
    gaps,
    gates
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}
export function validateResearchGapMapArtifact(
  raw: string,
  context: ResearchFunnelValidationContext = {}
): ResearchGapMapValidation {
  if (!raw.trim()) {
    return { measured: false, valid: false, reasons: ["research_gap_map_missing"] };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { measured: true, valid: false, reasons: ["research_gap_map_invalid_json"] };
  }
  if (!isResearchGapMap(value)) {
    return { measured: true, valid: false, reasons: ["research_gap_map_schema_invalid"] };
  }

  const reasons: string[] = [];
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("research_gap_map_content_hash_mismatch");
  }
  if (value.semantics_version !== RESEARCH_GAP_MAP_SEMANTICS_VERSION) {
    reasons.push("research_gap_map_semantics_version_mismatch");
  }
  if (
    value.analysis_coverage.complete !==
    (
      value.analysis_coverage.failed_paper_ids.length === 0 &&
      value.analysis_coverage.completed_paper_count === value.analysis_coverage.selected_paper_count
    )
  ) {
    reasons.push("research_gap_map_analysis_coverage_inconsistent");
  }
  if (
    value.construction_mode === "reviewed_semantic_synthesis" &&
    (!value.synthesis_binding || value.synthesis_binding.status !== "completed")
  ) {
    reasons.push("research_gap_map_reviewed_synthesis_binding_missing");
  }
  if (
    value.construction_mode === "deferred_partial_analysis" &&
    value.analysis_coverage.complete
  ) {
    reasons.push("research_gap_map_deferred_mode_coverage_mismatch");
  }
  if (
    context.requireReviewedSynthesis &&
    value.construction_mode !== "reviewed_semantic_synthesis"
  ) {
    reasons.push("research_gap_map_reviewed_synthesis_required");
  }
  if (context.requireReviewedSynthesis && context.synthesisArtifactValid !== true) {
    reasons.push("research_gap_map_synthesis_artifact_missing_or_invalid");
  }
  if (context.requireExternalEvidence && context.evidence === undefined) {
    reasons.push("research_gap_map_external_evidence_missing_or_invalid");
  }
  if (
    context.expectedSynthesisContentSha256 !== undefined &&
    value.synthesis_binding?.content_sha256 !== context.expectedSynthesisContentSha256
  ) {
    reasons.push("research_gap_map_synthesis_hash_mismatch");
  }
  if (
    context.expectedSynthesisSemanticsVersion !== undefined &&
    value.synthesis_binding?.semantics_version !== context.expectedSynthesisSemanticsVersion
  ) {
    reasons.push("research_gap_map_synthesis_semantics_mismatch");
  }
  if (
    context.expectedAnalysisComplete !== undefined &&
    value.analysis_coverage.complete !== context.expectedAnalysisComplete
  ) {
    reasons.push("research_gap_map_analysis_completion_mismatch");
  }
  const runBound = Boolean(normalizeOptionalText(value.run_id));
  const cycleBound = isValidResearchCycle(value.research_cycle);
  const lineageBound = Boolean(normalizeOptionalText(value.collect_attempt_id));
  const corpusBound = isSha256(value.corpus_sha256) && value.corpus_byte_length >= 0;
  const evidenceBound = isSha256(value.evidence_sha256) && value.evidence_byte_length >= 0;
  if (runBound !== cycleBound) {
    reasons.push("research_gap_map_partial_context_binding");
  }
  if (!context.allowUnbound && !runBound) {
    reasons.push("research_gap_map_run_id_unbound");
  }
  if (!context.allowUnbound && !cycleBound) {
    reasons.push("research_gap_map_research_cycle_unbound");
  }
  if (!context.allowUnbound && !lineageBound) {
    reasons.push("research_gap_map_collect_attempt_unbound");
  }
  if (!context.allowUnbound && !corpusBound) {
    reasons.push("research_gap_map_corpus_unbound");
  }
  if (!context.allowUnbound && !evidenceBound) {
    reasons.push("research_gap_map_evidence_unbound");
  }
  const boundCount = [lineageBound, corpusBound, evidenceBound].filter(Boolean).length;
  if (boundCount > 0 && boundCount < 3) {
    reasons.push("research_gap_map_partial_evidence_binding");
  }
  if (context.expectedRunId !== undefined && value.run_id !== context.expectedRunId) {
    reasons.push("research_gap_map_run_id_mismatch");
  }
  if (
    context.expectedResearchCycle !== undefined
    && value.research_cycle !== context.expectedResearchCycle
  ) {
    reasons.push("research_gap_map_research_cycle_mismatch");
  }
  if (
    context.expectedCollectAttemptId !== undefined
    && value.collect_attempt_id !== context.expectedCollectAttemptId
  ) {
    reasons.push("research_gap_map_collect_attempt_mismatch");
  }
  if (
    context.expectedCorpusSha256 !== undefined
    && value.corpus_sha256 !== context.expectedCorpusSha256
  ) {
    reasons.push("research_gap_map_corpus_hash_mismatch");
  }
  if (
    context.expectedCorpusByteLength !== undefined
    && value.corpus_byte_length !== context.expectedCorpusByteLength
  ) {
    reasons.push("research_gap_map_corpus_byte_length_mismatch");
  }
  if (
    context.expectedEvidenceSha256 !== undefined
    && value.evidence_sha256 !== context.expectedEvidenceSha256
  ) {
    reasons.push("research_gap_map_evidence_hash_mismatch");
  }
  if (
    context.expectedEvidenceByteLength !== undefined
    && value.evidence_byte_length !== context.expectedEvidenceByteLength
  ) {
    reasons.push("research_gap_map_evidence_byte_length_mismatch");
  }
  const gapIds = value.gaps.map((gap) => gap.gap_id);
  if (new Set(gapIds).size !== gapIds.length) {
    reasons.push("research_gap_map_duplicate_gap_id");
  }
  for (const gap of value.gaps) {
    const expectedGapId =
      `gap_${hashCanonical({
        statement: gap.statement,
        evidence_links: gap.evidence_links,
        opportunity_type: gap.opportunity_type ?? null
      }).slice(0, 12)}`;
    if (gap.gap_id !== expectedGapId) {
      reasons.push(`research_gap_id_mismatch:${gap.gap_id}`);
    }
    if (
      uniqueStrings(gap.evidence_links).length !== gap.evidence_links.length
      || uniqueStrings(gap.paper_ids).length !== gap.paper_ids.length
    ) {
      reasons.push(`research_gap_duplicate_identifier:${gap.gap_id}`);
    }
    if (gap.support.distinct_paper_count !== gap.paper_ids.length) {
      reasons.push(`research_gap_distinct_paper_count_mismatch:${gap.gap_id}`);
    }
    if (
      gap.support.full_text_paper_count < 0
      || gap.support.abstract_only_paper_count < 0
      || gap.support.full_text_paper_count + gap.support.abstract_only_paper_count > gap.paper_ids.length
    ) {
      reasons.push(`research_gap_support_count_invalid:${gap.gap_id}`);
    }
    const modeAllowsPromotion =
      (value.construction_mode === "legacy_exact_grouping" && gap.construction_origin === "exact_grouping") ||
      (
        value.construction_mode === "reviewed_semantic_synthesis" &&
        value.synthesis_binding?.status === "completed" &&
        value.analysis_coverage.complete &&
        gap.construction_origin === "reviewed_cluster"
      );
    const expectedStatus =
      modeAllowsPromotion && gap.paper_ids.length >= 2 && gap.support.full_text_paper_count >= 2
        ? "supported_candidate"
        : "provisional_candidate";
    if (gap.epistemic_status !== expectedStatus) {
      reasons.push(`research_gap_epistemic_status_mismatch:${gap.gap_id}`);
    }
    if (
      (gap.support.full_text_paper_count > 0) !== gap.source_types.includes("full_text")
      || (gap.support.abstract_only_paper_count > 0) !== gap.source_types.includes("abstract")
    ) {
      reasons.push(`research_gap_source_type_mismatch:${gap.gap_id}`);
    }
    reasons.push(...collectGateIntegrityReasons(
      `research_gap:${gap.gap_id}`,
      gap.gates,
      expectedResearchGapGates(gap)
    ));
  }
  reasons.push(...collectGateIntegrityReasons(
    "research_gap_map",
    value.gates,
    expectedResearchGapMapGates(value)
  ));
  if (context.evidence) {
    reasons.push(...validateGapLinksAgainstEvidence(value, context.evidence, context.reviewedClusters));
  }
  return {
    measured: true,
    valid: reasons.length === 0,
    reasons,
    gapMap: value
  };
}

export function bindResearchGapMapArtifact(
  raw: string,
  input: {
    runId: string;
    researchCycle: number;
    collectAttemptId?: string;
    corpusSha256?: string;
    corpusByteLength?: number;
    evidenceSha256?: string;
    evidenceByteLength?: number;
    evidence?: HypothesisEvidenceSeed[];
    reviewedClusters?: ResearchGapClusterSeed[];
    requireExternalEvidence?: boolean;
    requireReviewedSynthesis?: boolean;
    synthesisArtifactValid?: boolean;
    expectedSynthesisContentSha256?: string;
    expectedSynthesisSemanticsVersion?: number;
    expectedAnalysisComplete?: boolean;
  }
): ResearchGapMapBindingResult {
  return {
    changed: false,
    raw,
    validation: validateResearchGapMapArtifact(raw, {
      expectedRunId: input.runId,
      expectedResearchCycle: input.researchCycle,
      expectedCollectAttemptId: input.collectAttemptId,
      expectedCorpusSha256: input.corpusSha256,
      expectedCorpusByteLength: input.corpusByteLength,
      expectedEvidenceSha256: input.evidenceSha256,
      expectedEvidenceByteLength: input.evidenceByteLength,
      evidence: input.evidence,
      reviewedClusters: input.reviewedClusters,
      requireExternalEvidence: input.requireExternalEvidence,
      requireReviewedSynthesis: input.requireReviewedSynthesis,
      synthesisArtifactValid: input.synthesisArtifactValid,
      expectedSynthesisContentSha256: input.expectedSynthesisContentSha256,
      expectedSynthesisSemanticsVersion: input.expectedSynthesisSemanticsVersion,
      expectedAnalysisComplete: input.expectedAnalysisComplete
    })
  };
}


export function buildTopicPortfolio(input: {
  candidates: HypothesisCandidate[];
  runId?: string;
  researchCycle?: number;
  reviews?: HypothesisReview[];
  probeCandidateIds?: string[];
  evidence: HypothesisEvidenceSeed[];
  evidenceAxes: HypothesisEvidenceAxis[];
  gapMap?: ResearchGapMap;
  generatedAt?: string;
  sourceArtifacts?: string[];
  sourceArtifactBindings?: ResearchFunnelArtifactBinding[];
  sourceGapMapSha256?: string;
  priorAbsorptionMatrix?: PriorAbsorptionMatrix;
  candidatePriorSearchBindingsByCandidateId?: ReadonlyMap<
    string,
    CandidatePriorSearchReviewBinding
  >;
  computeBudgetCeiling?: TopicProbeComputeBudgetLimits;
  topicMemoryLedger?: TopicMemoryLedger;
  topicReentryTicketsByCandidateId?: ReadonlyMap<string, TopicReentryTicket>;
  topicSemanticAuditsByCandidateId?: ReadonlyMap<
    string,
    TopicMemorySemanticAudit
  >;
}): TopicPortfolio {
  const evidenceById = new Map(
    input.evidence.map((item, index) => [item.evidence_id || `ev_${index + 1}`, item] as const)
  );
  const reviewsById = new Map((input.reviews || []).map((item) => [item.candidate_id, item] as const));
  const probeCandidateIds = new Set(input.probeCandidateIds || []);
  const evidenceAxisIds = new Set(
    (input.evidenceAxes || []).map((axis) => axis.id)
  );
  const topicMemoryLedger = requireValidTopicMemoryLedger(
    input.topicMemoryLedger || createTopicMemoryLedger()
  );
  const boundedCandidates = input.candidates.slice(0, TOPIC_PORTFOLIO_MAX_CANDIDATES);
  const candidates = boundedCandidates.map((candidate) =>
    buildTopicPortfolioCandidate(
      candidate,
      reviewsById.get(candidate.id),
      probeCandidateIds,
      evidenceById,
      evidenceAxisIds,
      input.gapMap,
      input.priorAbsorptionMatrix,
      input.candidatePriorSearchBindingsByCandidateId?.get(candidate.id),
      input.computeBudgetCeiling,
      topicMemoryLedger,
      input.topicReentryTicketsByCandidateId?.get(candidate.id),
      input.topicSemanticAuditsByCandidateId?.get(candidate.id)
    )
  );
  const overflowCandidates = input.candidates.slice(TOPIC_PORTFOLIO_MAX_CANDIDATES).map((candidate) => ({
    source_candidate_id: candidate.id,
    reason: "portfolio_maximum_exceeded" as const
  }));
  const countInRange =
    input.candidates.length >= TOPIC_PORTFOLIO_MIN_CANDIDATES &&
    input.candidates.length <= TOPIC_PORTFOLIO_MAX_CANDIDATES;
  const distinctClusterIds = collectDistinctClusterIds(candidates);
  const clusterCoverageComplete = distinctClusterIds.length >= TOPIC_PORTFOLIO_MIN_DISTINCT_CLUSTERS;
  const probeCandidates = candidates.filter((candidate) => candidate.probe_status === "shortlisted");
  const probeCandidatesEligible =
    probeCandidates.length > 0 && probeCandidates.every((candidate) => candidate.probe_eligible);
  const portfolioCandidatesAdmissible =
    candidates.length > 0
    && candidates.every(isTopicPortfolioCandidateDispositionAuditable);
  const sourceArtifactBindings = normalizeArtifactBindings(input.sourceArtifactBindings || []);
  const sourceArtifacts =
    input.sourceArtifacts ||
    [...RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS];
  const sourceGapMapSha256 =
    normalizeOptionalText(input.sourceGapMapSha256) ||
    input.gapMap?.content_sha256;
  const sourcePriorAbsorptionMatrixSha256 =
    normalizeOptionalText(input.priorAbsorptionMatrix?.content_sha256);
  const sourceBindingsComplete =
    hasCompleteArtifactBindingManifest(sourceArtifacts, sourceArtifactBindings);
  const gates: ResearchFunnelGate[] = [
    gate(
      "gap_map_hash_bound",
      isSha256(sourceGapMapSha256),
      isSha256(sourceGapMapSha256)
        ? "The topic portfolio is bound to a verified research gap map."
        : "The topic portfolio is not bound to a verified research gap map."
    ),
    gate(
      "source_artifact_bindings_complete",
      sourceBindingsComplete,
      sourceBindingsComplete
        ? "All required source artifacts have portable SHA-256 and byte-length bindings."
        : "One or more required source artifact bindings are missing or malformed."
    ),
    gate(
      "prior_absorption_matrix_hash_bound",
      isSha256(sourcePriorAbsorptionMatrixSha256),
      isSha256(sourcePriorAbsorptionMatrixSha256)
        ? "The topic portfolio is bound to a content-hashed prior-absorption matrix."
        : "The topic portfolio is not bound to a content-hashed prior-absorption matrix."
    ),
    gate(
      "topic_memory_snapshot_valid",
      validateTopicMemoryLedger(topicMemoryLedger).valid,
      "The topic portfolio contains a validated, content-hashed project topic-memory snapshot."
    ),
    gate(
      "candidate_count_in_range",
      countInRange,
      countInRange
        ? `${input.candidates.length} topic candidates satisfy the 5-7 candidate policy.`
        : `Observed ${input.candidates.length} topic candidates; the required range is 5-7.`
    ),
    gate(
      "evidence_axis_cluster_diversity",
      clusterCoverageComplete,
      clusterCoverageComplete
        ? `${distinctClusterIds.length} distinct nonempty evidence-axis cluster(s) are represented.`
        : `Observed ${distinctClusterIds.length} distinct nonempty evidence-axis cluster(s); at least 3 are required for probe authorization.`
    ),
    gate(
      "portfolio_candidates_admissible",
      portfolioCandidatesAdmissible,
      portfolioCandidatesAdmissible
        ? "Every bounded portfolio candidate has an explicit review disposition, and every kept candidate has a complete evidence-linked contract."
        : "At least one bounded candidate is unreviewed, or a kept candidate is contract-incomplete; regenerate the portfolio instead of using it as filler."
    ),
    gate(
      "probe_candidate_present",
      probeCandidates.length > 0,
      probeCandidates.length > 0
        ? `${probeCandidates.length} bounded execution probe candidate(s) are shortlisted.`
        : "No bounded execution probe candidate is shortlisted."
    ),
    gate(
      "probe_candidate_contract_complete",
      probeCandidatesEligible,
      probeCandidatesEligible
        ? "Every shortlisted probe candidate has a complete, evidence-linked experimental contract."
        : "At least one shortlisted probe candidate is missing a required experimental contract field or was rejected."
    )
  ];
  const payload = {
    schema_version: 1 as const,
    artifact_kind: "research_topic_portfolio" as const,
    run_id: normalizeOptionalText(input.runId) || "",
    research_cycle: normalizeResearchCycle(input.researchCycle),
    generated_at: input.generatedAt || new Date().toISOString(),
    source_artifacts: sourceArtifacts,
    source_artifact_bindings: sourceArtifactBindings,
    source_gap_map_sha256: normalizeOptionalText(sourceGapMapSha256),
    source_prior_absorption_matrix_sha256: sourcePriorAbsorptionMatrixSha256,
    topic_memory_ledger: topicMemoryLedger,
    candidate_policy: {
      minimum: TOPIC_PORTFOLIO_MIN_CANDIDATES,
      maximum: TOPIC_PORTFOLIO_MAX_CANDIDATES,
      observed: input.candidates.length
    },
    candidates,
    overflow_candidates: overflowCandidates,
    cluster_policy: {
      minimum_distinct_nonempty: TOPIC_PORTFOLIO_MIN_DISTINCT_CLUSTERS,
      observed_distinct_nonempty: distinctClusterIds.length
    },
    probe_candidate_ids: probeCandidates.map((candidate) => candidate.source_candidate_id),
    probe_topic_ids: probeCandidates.map((candidate) => candidate.topic_id),
    gates,
    probe_allowed: gates.every((item) => item.status === "pass")
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function isTopicPortfolioCandidateDispositionAuditable(
  candidate: TopicPortfolioCandidate
): boolean {
  return candidate.review_status === "rejected"
    || (
      candidate.review_status === "kept"
      && candidate.probe_eligible
    );
}

export function validateTopicPortfolioArtifact(
  raw: string,
  context: ResearchFunnelValidationContext = {}
): TopicPortfolioValidation {
  if (!raw.trim()) {
    return { measured: false, valid: false, reasons: ["topic_portfolio_missing"] };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { measured: true, valid: false, reasons: ["topic_portfolio_invalid_json"] };
  }
  if (!isTopicPortfolio(value)) {
    return { measured: true, valid: false, reasons: ["topic_portfolio_schema_invalid"] };
  }

  const reasons: string[] = [];
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("topic_portfolio_content_hash_mismatch");
  }
  if (!normalizeOptionalText(value.run_id)) {
    reasons.push("topic_portfolio_run_id_unbound");
  }
  if (!isValidResearchCycle(value.research_cycle)) {
    reasons.push("topic_portfolio_research_cycle_unbound");
  }
  if (context.expectedRunId !== undefined && value.run_id !== context.expectedRunId) {
    reasons.push("topic_portfolio_run_id_mismatch");
  }
  if (
    context.expectedResearchCycle !== undefined
    && value.research_cycle !== context.expectedResearchCycle
  ) {
    reasons.push("topic_portfolio_research_cycle_mismatch");
  }
  reasons.push(...collectArtifactBindingManifestReasons(value));
  if (!isSha256(value.source_gap_map_sha256)) {
    reasons.push("topic_portfolio_gap_map_unbound");
  }
  const topicMemoryValidation = validateTopicMemoryLedger(value.topic_memory_ledger);
  if (!topicMemoryValidation.valid || !topicMemoryValidation.ledger) {
    reasons.push(...topicMemoryValidation.reasons);
  }
  const topicMemoryLedger = topicMemoryValidation.ledger;
  for (const candidate of value.candidates) {
    const { content_sha256: candidateContentSha256, ...candidatePayload } = candidate;
    if (hashCanonical(candidatePayload) !== candidateContentSha256) {
      reasons.push(`topic_candidate_content_hash_mismatch:${candidate.topic_id}`);
    }
    const expectedObjectiveRaw = deriveTopicCandidateObjectiveRaw(candidate);
    if (candidate.objective_raw !== expectedObjectiveRaw) {
      reasons.push(`topic_candidate_objective_raw_mismatch:${candidate.topic_id}`);
    }
    let expectedTopicMemoryDecision: TopicMemoryDecision | undefined;
    let expectedDescriptor: TopicFormulationDescriptor | undefined;
    try {
      expectedDescriptor = buildTopicDescriptorFromPortfolioCandidate(candidate);
      const expectedTopicId = `topic_${expectedDescriptor.lineage_sha256.slice(0, 12)}`;
      const expectedFormulationId =
        `formulation_${expectedDescriptor.formulation_sha256.slice(0, 12)}`;
      if (
        candidate.topic_id !== expectedTopicId
        || candidate.topic_lineage_id !== expectedTopicId
      ) {
        reasons.push(`topic_candidate_id_mismatch:${candidate.topic_id}`);
      }
      if (candidate.formulation_id !== expectedFormulationId) {
        reasons.push(`topic_candidate_formulation_id_mismatch:${candidate.topic_id}`);
      }
      const expectedFormulationVersion = topicMemoryLedger
        ? topicMemoryLedger.records.filter(
            (record) =>
              record.descriptor.lineage_sha256 === expectedDescriptor?.lineage_sha256
          ).length + 1
        : undefined;
      if (candidate.formulation_version !== expectedFormulationVersion) {
        reasons.push(`topic_candidate_formulation_version_mismatch:${candidate.topic_id}`);
      }
      if (
        !candidate.topic_memory?.descriptor
        || hashCanonical(candidate.topic_memory.descriptor)
          !== hashCanonical(expectedDescriptor)
      ) {
        reasons.push(`topic_candidate_memory_descriptor_mismatch:${candidate.topic_id}`);
      }
      if (topicMemoryLedger) {
        expectedTopicMemoryDecision = evaluateTopicMemory(
          topicMemoryLedger,
          expectedDescriptor,
          candidate.topic_memory?.reentry_ticket,
          candidate.topic_memory?.semantic_audit
        );
      }
    } catch {
      reasons.push(`topic_candidate_memory_descriptor_invalid:${candidate.topic_id}`);
    }
    if (!candidate.topic_memory) {
      reasons.push(`topic_candidate_memory_projection_missing:${candidate.topic_id}`);
    } else {
      if (
        !topicMemoryLedger
        || candidate.topic_memory.ledger_sha256 !== topicMemoryLedger.ledger_sha256
      ) {
        reasons.push(`topic_candidate_memory_ledger_mismatch:${candidate.topic_id}`);
      }
      if (
        !expectedTopicMemoryDecision
        || hashCanonical(candidate.topic_memory.decision)
          !== hashCanonical(expectedTopicMemoryDecision)
      ) {
        reasons.push(`topic_candidate_memory_decision_mismatch:${candidate.topic_id}`);
      }
    }
    const expectedCandidateGates = expectedTopicCandidateGates(
      candidate,
      expectedTopicMemoryDecision
    );
    reasons.push(...collectGateIntegrityReasons(
      `topic_candidate:${candidate.topic_id}`,
      candidate.gates,
      expectedCandidateGates
    ));
    const expectedEligibility = expectedCandidateGates.every((item) => item.status === "pass");
    if (candidate.probe_eligible !== expectedEligibility) {
      reasons.push(`topic_candidate_probe_eligibility_mismatch:${candidate.topic_id}`);
    }
    if (!Object.values(candidate.scores).every(isValidTopicScore)) {
      reasons.push(`topic_candidate_score_out_of_range:${candidate.topic_id}`);
    }
    const identifierLists = [
      candidate.supported_gap_ids,
      candidate.cluster_ids,
      candidate.unresolved_cluster_ids,
      candidate.evidence_links,
      candidate.unresolved_evidence_links,
      candidate.closest_prior_paper_ids,
      candidate.closest_prior_full_text_paper_ids,
      candidate.candidate_prior_search?.selected_direct_prior_ids || []
    ];
    if (identifierLists.some((items) => uniqueStrings(items).length !== items.length)) {
      reasons.push(`topic_candidate_duplicate_identifier:${candidate.topic_id}`);
    }
    if (!stringArraysEqual(candidate.cluster_ids, normalizeClusterIds(candidate.cluster_ids))) {
      reasons.push(`topic_candidate_cluster_ids_not_canonical:${candidate.topic_id}`);
    }
    if (!candidate.unresolved_cluster_ids.every((item) => candidate.cluster_ids.includes(item))) {
      reasons.push(`topic_candidate_unresolved_cluster_not_linked:${candidate.topic_id}`);
    }
    if (!stringArraysEqual(candidate.supported_gap_ids, normalizeGapIds(candidate.supported_gap_ids))) {
      reasons.push(
        `topic_candidate_supported_gap_ids_not_canonical:${candidate.topic_id}`
      );
    }
    if (!candidate.unresolved_evidence_links.every((item) => candidate.evidence_links.includes(item))) {
      reasons.push(`topic_candidate_unresolved_evidence_not_linked:${candidate.topic_id}`);
    }
    if (!candidate.closest_prior_full_text_paper_ids.every((item) => candidate.closest_prior_paper_ids.includes(item))) {
      reasons.push(`topic_candidate_full_text_prior_not_linked:${candidate.topic_id}`);
    }
    reasons.push(...collectPriorAbsorptionProjectionReasons(
      candidate,
      value.source_prior_absorption_matrix_sha256
    ));
  }
  const topicIds = value.candidates.map((candidate) => candidate.topic_id);
  if (new Set(topicIds).size !== topicIds.length) {
    reasons.push("topic_portfolio_duplicate_topic_id");
  }
  const sourceCandidateIds = value.candidates.map((candidate) => candidate.source_candidate_id);
  if (new Set(sourceCandidateIds).size !== sourceCandidateIds.length) {
    reasons.push("topic_portfolio_duplicate_source_candidate_id");
  }
  if (value.candidates.length > TOPIC_PORTFOLIO_MAX_CANDIDATES) {
    reasons.push("topic_portfolio_bounded_candidate_count_exceeded");
  }
  const shortlistedCandidates = value.candidates
    .filter((candidate) => candidate.probe_status === "shortlisted");
  const expectedProbeCandidateIds = shortlistedCandidates
    .map((candidate) => candidate.source_candidate_id);
  const expectedProbeTopicIds = shortlistedCandidates.map((candidate) => candidate.topic_id);
  if (!stringArraysEqual(value.probe_candidate_ids, expectedProbeCandidateIds)) {
    reasons.push("topic_portfolio_probe_candidate_state_mismatch");
  }
  if (!stringArraysEqual(value.probe_topic_ids, expectedProbeTopicIds)) {
    reasons.push("topic_portfolio_probe_topic_state_mismatch");
  }
  if (new Set(value.probe_candidate_ids).size !== value.probe_candidate_ids.length) {
    reasons.push("topic_portfolio_duplicate_probe_candidate_id");
  }
  if (new Set(value.probe_topic_ids).size !== value.probe_topic_ids.length) {
    reasons.push("topic_portfolio_duplicate_probe_topic_id");
  }
  if (value.probe_candidate_ids.some((candidateId) => !sourceCandidateIds.includes(candidateId))) {
    reasons.push("topic_portfolio_probe_candidate_missing");
  }
  if (value.probe_topic_ids.some((topicId) => !topicIds.includes(topicId))) {
    reasons.push("topic_portfolio_probe_topic_missing");
  }
  const observedCandidateCount = value.candidates.length + value.overflow_candidates.length;
  if (value.candidate_policy.observed !== observedCandidateCount) {
    reasons.push("topic_portfolio_observed_count_mismatch");
  }
  if (
    value.candidate_policy.minimum !== TOPIC_PORTFOLIO_MIN_CANDIDATES
    || value.candidate_policy.maximum !== TOPIC_PORTFOLIO_MAX_CANDIDATES
  ) {
    reasons.push("topic_portfolio_candidate_policy_mismatch");
  }
  const expectedStoredCandidateCount = Math.min(
    observedCandidateCount,
    TOPIC_PORTFOLIO_MAX_CANDIDATES
  );
  const expectedDistinctClusterCount = collectDistinctClusterIds(value.candidates).length;
  if (
    value.cluster_policy.minimum_distinct_nonempty !== TOPIC_PORTFOLIO_MIN_DISTINCT_CLUSTERS
    || value.cluster_policy.observed_distinct_nonempty !== expectedDistinctClusterCount
  ) {
    reasons.push("topic_portfolio_cluster_policy_mismatch");
  }

  if (value.candidates.length !== expectedStoredCandidateCount) {
    reasons.push("topic_portfolio_candidate_partition_mismatch");
  }
  const overflowSourceIds = value.overflow_candidates.map((candidate) => candidate.source_candidate_id);
  if (
    new Set(overflowSourceIds).size !== overflowSourceIds.length
    || overflowSourceIds.some((candidateId) => sourceCandidateIds.includes(candidateId))
  ) {
    reasons.push("topic_portfolio_overflow_identity_mismatch");
  }
  const expectedPortfolioGates = expectedTopicPortfolioGates(value);
  reasons.push(...collectGateIntegrityReasons(
    "topic_portfolio",
    value.gates,
    expectedPortfolioGates
  ));
  const expectedProbeAllowed = expectedPortfolioGates.every((item) => item.status === "pass");
  if (value.probe_allowed !== expectedProbeAllowed) {
    reasons.push("topic_portfolio_probe_allowed_state_mismatch");
  }

  return {
    measured: true,
    valid: reasons.length === 0,
    reasons,
    portfolio: value
  };
}

export function buildTopicDecision(input: {
  runId: string;
  researchCycle: number;
  validation: TopicPortfolioValidation | ResearchFunnelClosedChainValidation;
  generatedAt?: string;
}): TopicDecision {
  const portfolioValidation =
    "portfolioValidation" in input.validation
      ? input.validation.portfolioValidation
      : input.validation;
  const portfolio = portfolioValidation.portfolio;
  const probeCandidates = portfolio
    ? portfolio.candidates.filter((candidate) =>
        portfolio.probe_candidate_ids.includes(candidate.source_candidate_id)
      )
    : [];
  const reasonCodes = uniqueStrings([
    ...input.validation.reasons,
    ...(portfolio?.gates.filter((item) => item.status === "block").map((item) => item.code) || []),
    ...probeCandidates.flatMap((candidate) =>
      candidate.gates.filter((item) => item.status === "block").map((item) => item.code)
    )
  ]);
  const probeAllowed =
    input.validation.valid === true &&
    portfolio?.probe_allowed === true &&
    probeCandidates.length > 0;
  const payload = {
    schema_version: 1 as const,
    artifact_kind: "research_topic_probe_authorization" as const,
    run_id: input.runId,
    research_cycle: input.researchCycle,
    generated_at: input.generatedAt || new Date().toISOString(),
    portfolio_content_sha256: portfolio?.content_sha256,
    probe_candidate_ids: portfolio?.probe_candidate_ids || [],
    probe_topic_ids: portfolio?.probe_topic_ids || [],
    disposition: probeAllowed ? ("probe_authorized" as const) : ("backtrack_to_hypotheses" as const),
    probe_allowed: probeAllowed,
    reason_codes: reasonCodes.length > 0 || probeAllowed ? reasonCodes : ["topic_probe_not_authorized"]
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}
export function validateTopicDecisionArtifact(
  raw: string,
  portfolioValidation?: TopicPortfolioValidation,
  context: ResearchFunnelValidationContext = {}
): TopicDecisionValidation {
  if (!raw.trim()) {
    return { measured: false, valid: false, reasons: ["topic_decision_missing"] };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { measured: true, valid: false, reasons: ["topic_decision_invalid_json"] };
  }
  if (!isTopicDecision(value)) {
    return { measured: true, valid: false, reasons: ["topic_decision_schema_invalid"] };
  }

  const reasons: string[] = [];
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("topic_decision_content_hash_mismatch");
  }
  if (!normalizeOptionalText(value.run_id)) {
    reasons.push("topic_decision_run_id_unbound");
  }
  if (!isValidResearchCycle(value.research_cycle)) {
    reasons.push("topic_decision_research_cycle_unbound");
  }
  if (context.expectedRunId !== undefined && value.run_id !== context.expectedRunId) {
    reasons.push("topic_decision_run_id_mismatch");
  }
  if (
    context.expectedResearchCycle !== undefined
    && value.research_cycle !== context.expectedResearchCycle
  ) {
    reasons.push("topic_decision_research_cycle_mismatch");
  }
  if (value.probe_allowed !== (value.disposition === "probe_authorized")) {
    reasons.push("topic_decision_disposition_mismatch");
  }
  if (new Set(value.probe_candidate_ids).size !== value.probe_candidate_ids.length) {
    reasons.push("topic_decision_duplicate_probe_candidate_id");
  }
  if (new Set(value.probe_topic_ids).size !== value.probe_topic_ids.length) {
    reasons.push("topic_decision_duplicate_probe_topic_id");
  }
  if (value.probe_allowed && value.probe_candidate_ids.length === 0) {
    reasons.push("topic_decision_probe_candidate_missing");
  }
  if (value.probe_allowed && value.probe_topic_ids.length === 0) {
    reasons.push("topic_decision_probe_topic_missing");
  }
  if (!value.probe_allowed && value.reason_codes.length === 0) {
    reasons.push("topic_decision_block_reason_missing");
  }
  if (portfolioValidation) {
    const expected = buildTopicDecision({
      runId: value.run_id,
      researchCycle: value.research_cycle,
      validation: portfolioValidation,
      generatedAt: value.generated_at
    });
    if (value.portfolio_content_sha256 !== expected.portfolio_content_sha256) {
      reasons.push("topic_decision_portfolio_hash_mismatch");
    }
    if (!stringArraysEqual(value.probe_candidate_ids, expected.probe_candidate_ids)) {
      reasons.push("topic_decision_probe_candidate_state_mismatch");
    }
    if (!stringArraysEqual(value.probe_topic_ids, expected.probe_topic_ids)) {
      reasons.push("topic_decision_probe_topic_state_mismatch");
    }
    if (
      value.probe_allowed !== expected.probe_allowed
      || value.disposition !== expected.disposition
    ) {
      reasons.push("topic_decision_portfolio_disposition_mismatch");
    }
    const actualReasonCodes = uniqueStrings(value.reason_codes).sort();
    const expectedReasonCodes = uniqueStrings(expected.reason_codes).sort();
    if (!stringArraysEqual(actualReasonCodes, expectedReasonCodes)) {
      reasons.push("topic_decision_reason_code_mismatch");

    }
  }
  return {
    measured: true,
    valid: reasons.length === 0,
    reasons,
    decision: value
  };
}


export function buildResearchFunnelArtifactBinding(
  path: ResearchFunnelSourceArtifactPath,
  content: string
): ResearchFunnelArtifactBinding {
  return {
    path,
    sha256: hashArtifactBytes(content),
    byte_length: Buffer.byteLength(content, "utf8")
  };
}

export function validateHypothesisEvidenceAxesArtifact(
  raw: string,
  allowedEvidenceIds: Iterable<string> = []
): HypothesisEvidenceAxesValidation {
  if (!raw.trim()) {
    return {
      measured: false,
      valid: false,
      reasons: ["hypothesis_evidence_axes_missing"]
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      measured: true,
      valid: false,
      reasons: ["hypothesis_evidence_axes_invalid_json"]
    };
  }
  if (!Array.isArray(value)) {
    return {
      measured: true,
      valid: false,
      reasons: ["hypothesis_evidence_axes_schema_invalid"]
    };
  }
  const reasons: string[] = [];
  const axes: HypothesisEvidenceAxis[] = [];
  const knownEvidenceIds = new Set(allowedEvidenceIds);
  const axisIds = new Set<string>();
  value.forEach((item, index) => {
    if (!isHypothesisEvidenceAxis(item)) {
      reasons.push(`hypothesis_evidence_axis_schema_invalid:${index + 1}`);
      return;
    }
    if (axisIds.has(item.id)) {
      reasons.push(`hypothesis_evidence_axis_duplicate_id:${item.id}`);
    }
    axisIds.add(item.id);
    if (uniqueStrings(item.evidence_links).length !== item.evidence_links.length) {
      reasons.push(`hypothesis_evidence_axis_duplicate_evidence:${item.id}`);
    }
    if (knownEvidenceIds.size > 0) {
      for (const evidenceId of item.evidence_links) {
        if (!knownEvidenceIds.has(evidenceId)) {
          reasons.push(
            `hypothesis_evidence_axis_evidence_unknown:${item.id}:${evidenceId}`
          );
        }
      }
    }
    axes.push(item);
  });
  return {
    measured: true,
    valid: reasons.length === 0,
    reasons: uniqueStrings(reasons),
    axes
  };
}

export function resolveSupportedGapIds(
  evidenceLinks: string[],
  gapMap: ResearchGapMap | undefined
): string[] {
  if (!gapMap) {
    return [];
  }
  const linkedEvidence = new Set(evidenceLinks);
  return gapMap.gaps
    .filter((gap) =>
      gap.epistemic_status === "supported_candidate"
      && gap.evidence_links.length > 0
      && gap.evidence_links.every((id) => linkedEvidence.has(id)))
    .map((gap) => gap.gap_id)
    .sort((left, right) => left.localeCompare(right));
}
export function validateResearchFunnelClosedChain(
  input: ResearchFunnelClosedChainInput
): ResearchFunnelClosedChainValidation {
  const requireDecision = input.requireDecision !== false;
  const context: ResearchFunnelValidationContext = {
    ...input.gapValidationContext,
    expectedRunId: input.expectedRunId,
    expectedResearchCycle: input.expectedResearchCycle
  };
  const gapMapValidation = validateResearchGapMapArtifact(input.gapMapRaw || "", context);
  const knownEvidenceIds = uniqueStrings([
    ...(context.evidence || []).flatMap((evidence, index) => [
      evidence.evidence_id || `ev_${index + 1}`
    ]),
    ...(gapMapValidation.gapMap?.gaps.flatMap((gap) => gap.evidence_links) || [])
  ]);
  const evidenceAxesValidation = validateHypothesisEvidenceAxesArtifact(
    input.evidenceAxesRaw || "",
    knownEvidenceIds
  );
  const priorAbsorptionMatrixValidation = validatePriorAbsorptionMatrixArtifact(
    input.priorAbsorptionMatrixRaw || "",
    {
      expectedRunId: input.expectedRunId,
      expectedResearchCycle: input.expectedResearchCycle
    }
  );
  const portfolioValidation = validateTopicPortfolioArtifact(input.portfolioRaw || "", context);
  const decisionValidation: TopicDecisionValidation = requireDecision
    ? validateTopicDecisionArtifact(input.decisionRaw || "", undefined, context)
    : input.decisionRaw !== undefined
      ? validateTopicDecisionArtifact(input.decisionRaw, undefined, context)
      : { measured: false, valid: true, reasons: [] };

  const upstreamReasons = [
    ...gapMapValidation.reasons,
    ...evidenceAxesValidation.reasons,
    ...priorAbsorptionMatrixValidation.reasons,
    ...portfolioValidation.reasons,
    ...(input.gapValidationReasonCodes ?? [])
  ];
  const gapMap = gapMapValidation.gapMap;
  const evidenceAxes = evidenceAxesValidation.axes;
  const priorAbsorptionMatrix = priorAbsorptionMatrixValidation.matrix;
  const portfolio = portfolioValidation.portfolio;
  if (gapMap && portfolio && portfolio.source_gap_map_sha256 !== gapMap.content_sha256) {
    upstreamReasons.push("topic_portfolio_gap_map_hash_mismatch");
  }
  if (
    priorAbsorptionMatrix
    && portfolio
    && portfolio.source_prior_absorption_matrix_sha256
      !== priorAbsorptionMatrix.content_sha256
  ) {
    upstreamReasons.push("topic_portfolio_prior_absorption_matrix_hash_mismatch");
  }
  if (portfolio) {
    upstreamReasons.push(
      ...validateClosedChainSourceArtifacts(
        input,
        gapMap,
        evidenceAxes,
        priorAbsorptionMatrix,
        context.evidence || [],
        portfolio
      )
    );
  }

  const normalizedUpstreamReasons = uniqueStrings(upstreamReasons);
  const decisionReasons = requireDecision ? [...decisionValidation.reasons] : [];
  const decision = decisionValidation.decision;
  if (requireDecision && decision) {
    const expectedDecision = buildTopicDecision({
      runId: input.expectedRunId,
      researchCycle: input.expectedResearchCycle,
      validation: {
        measured: portfolioValidation.measured,
        valid: normalizedUpstreamReasons.length === 0,
        reasons: normalizedUpstreamReasons,
        portfolio
      },
      generatedAt: decision.generated_at
    });
    decisionReasons.push(...collectTopicDecisionBindingReasons(decision, expectedDecision));
  }

  const reasons = uniqueStrings([...normalizedUpstreamReasons, ...decisionReasons]);
  const complete = hasRequiredClosedChainArtifacts(input, requireDecision);
  const valid = reasons.length === 0 && complete;
  const probeAllowed =
    valid
    && requireDecision
    && portfolio?.probe_allowed === true
    && decision?.probe_allowed === true;

  return {
    measured: closedChainArtifacts(input).some((raw) => raw !== undefined),
    complete,
    valid,
    probeAllowed,
    reasons,
    approvedCandidateIds: probeAllowed ? [...(decision?.probe_candidate_ids || [])] : [],
    approvedTopicIds: probeAllowed ? [...(decision?.probe_topic_ids || [])] : [],
    gapMapValidation,
    evidenceAxesValidation,
    priorAbsorptionMatrixValidation,
    portfolioValidation,
    decisionValidation,
    gapMap,
    evidenceAxes,
    priorAbsorptionMatrix,
    portfolio,
    decision
  };
}
function closedChainArtifacts(input: ResearchFunnelClosedChainInput): Array<string | undefined> {
  return [
    input.gapMapRaw,
    input.evidenceAxesRaw,
    input.priorAbsorptionMatrixRaw,
    input.hypothesesRaw,
    input.draftsRaw,
    input.reviewsRaw,
    input.probeShortlistRaw,
    input.portfolioRaw,
    input.decisionRaw
  ];
}

function hasRequiredClosedChainArtifacts(
  input: ResearchFunnelClosedChainInput,
  requireDecision: boolean
): boolean {
  const required = [
    input.gapMapRaw,
    input.evidenceAxesRaw,
    input.priorAbsorptionMatrixRaw,
    input.hypothesesRaw,
    input.draftsRaw,
    input.reviewsRaw,
    input.probeShortlistRaw,
    input.portfolioRaw,
    ...(requireDecision ? [input.decisionRaw] : [])
  ];
  return required.every((raw) => raw !== undefined);
}

function closedChainSourceArtifactContents(
  input: ResearchFunnelClosedChainInput
): Record<ResearchFunnelSourceArtifactPath, string | undefined> {
  return {
    "analysis/gap_map.json": input.gapMapRaw,
    "hypothesis_generation/evidence_axes.json": input.evidenceAxesRaw,
    "hypothesis_generation/prior_absorption_matrix.json":
      input.priorAbsorptionMatrixRaw,
    "hypotheses.jsonl": input.hypothesesRaw,
    "hypothesis_generation/drafts.jsonl": input.draftsRaw,
    "hypothesis_generation/reviews.jsonl": input.reviewsRaw,
    "hypothesis_generation/probe_shortlist.json": input.probeShortlistRaw
  };
}

function collectTopicDecisionBindingReasons(
  actual: TopicDecision,
  expected: TopicDecision
): string[] {
  const reasons: string[] = [];
  if (actual.portfolio_content_sha256 !== expected.portfolio_content_sha256) {
    reasons.push("topic_decision_portfolio_hash_mismatch");
  }
  if (!stringArraysEqual(actual.probe_candidate_ids, expected.probe_candidate_ids)) {
    reasons.push("topic_decision_probe_candidate_state_mismatch");
  }
  if (!stringArraysEqual(actual.probe_topic_ids, expected.probe_topic_ids)) {
    reasons.push("topic_decision_probe_topic_state_mismatch");
  }
  if (actual.probe_allowed !== expected.probe_allowed || actual.disposition !== expected.disposition) {
    reasons.push("topic_decision_closed_chain_disposition_mismatch");
  }
  if (!stringArraysEqual(
    uniqueStrings(actual.reason_codes).sort(),
    uniqueStrings(expected.reason_codes).sort()
  )) {
    reasons.push("topic_decision_reason_code_mismatch");
  }
  return reasons;
}
function validateClosedChainSourceArtifacts(
  input: ResearchFunnelClosedChainInput,
  gapMap: ResearchGapMap | undefined,
  evidenceAxes: HypothesisEvidenceAxis[] | undefined,
  priorAbsorptionMatrix: PriorAbsorptionMatrix | undefined,
  evidence: HypothesisEvidenceSeed[],
  portfolio: TopicPortfolio
): string[] {
  const reasons = validateSourceArtifactBindings(input, portfolio);
  const drafts = parseJsonlArtifact(input.draftsRaw, "draft");
  const reviews = parseJsonlArtifact(input.reviewsRaw, "review");
  const hypotheses = parseJsonlArtifact(input.hypothesesRaw, "hypothesis");
  const shortlistResult = parseProbeShortlist(input.probeShortlistRaw);
  reasons.push(...drafts.reasons, ...reviews.reasons, ...hypotheses.reasons, ...shortlistResult.reasons);

  const draftIds = collectRecordIdentifiers(drafts.records, "id", "draft", reasons);
  const evidenceAxisIds = new Set((evidenceAxes || []).map((axis) => axis.id));
  for (const draft of drafts.records) {
    const candidateId = normalizeOptionalText(draft.id) || "missing";
    const draftAxisIds = readStringArray(draft.axis_ids);
    if (!draftAxisIds || draftAxisIds.length === 0) {
      reasons.push(`research_funnel_draft_axis_ids_missing:${candidateId}`);
      continue;
    }
    for (const axisId of draftAxisIds) {
      if (!evidenceAxisIds.has(axisId)) {
        reasons.push(
          `research_funnel_draft_axis_id_unknown:${candidateId}:${axisId}`
        );
      }
    }
  }
  const reviewIds = collectRecordIdentifiers(reviews.records, "candidate_id", "review", reasons);
  for (const review of reviews.records) {
    const candidateId = normalizeOptionalText(review.candidate_id) || "missing";
    if (!isHypothesisReviewProvenanceAuthorizing(review.provenance)) {
      reasons.push(
        `research_funnel_review_provenance_not_independent:${candidateId}`
      );
    }
  }
  const hypothesisCandidateIds = collectRecordIdentifiers(
    hypotheses.records,
    "candidate_id",
    "hypothesis",
    reasons
  );
  const hypothesisIds = collectRecordIdentifiers(
    hypotheses.records,
    "hypothesis_id",
    "hypothesis_record",
    reasons
  );
  if (new Set(hypothesisIds).size !== hypothesisIds.length) {
    reasons.push("research_funnel_duplicate_hypothesis_id");
  }
  if (priorAbsorptionMatrix) {
    const matrixCandidateIds = priorAbsorptionMatrix.candidates.map(
      (candidate) => candidate.candidate_id
    );
    if (!stringArraysEqual(matrixCandidateIds, draftIds)) {
      reasons.push("research_funnel_prior_absorption_candidate_set_mismatch");
    }
    const matrixCandidatesById = new Map(
      priorAbsorptionMatrix.candidates.map(
        (candidate) => [candidate.candidate_id, candidate] as const
      )
    );
    const evidenceById = new Map(
      evidence.flatMap((item, index) => {
        const evidenceId = normalizeOptionalText(item.evidence_id)
          || `ev_${index + 1}`;
        return [[evidenceId, item] as const];
      })
    );
    for (const draft of drafts.records) {
      const candidateId = normalizeOptionalText(draft.id);
      if (!candidateId) {
        continue;
      }
      const matrixCandidate = matrixCandidatesById.get(candidateId);
      if (!matrixCandidate) {
        continue;
      }
      const expectedContract = buildPriorAbsorptionCandidateContract(
        draft as unknown as HypothesisCandidate
      );
      if (
        hashCanonical(matrixCandidate.candidate_contract)
          !== hashCanonical(expectedContract)
      ) {
        reasons.push(
          `research_funnel_prior_absorption_candidate_contract_mismatch:${candidateId}`
        );
      }
      for (const comparison of matrixCandidate.comparisons) {
        const references = [
          ...comparison.axes.flatMap((axis) => axis.evidence_refs),
          ...comparison.independent_evidence_refs
        ];
        for (const reference of references) {
          const sourceEvidence = evidenceById.get(reference.evidence_id);
          const expectedReferencePayload = sourceEvidence
            && sourceEvidence.source_type === "full_text"
            && normalizeOptionalText(sourceEvidence.paper_id)
              === reference.paper_id
            && normalizeOptionalText(sourceEvidence.evidence_span)
              === reference.evidence_span
              ? {
                  evidence_id: reference.evidence_id,
                  paper_id: reference.paper_id,
                  source_type: "full_text" as const,
                  evidence_span: reference.evidence_span
                }
              : undefined;
          if (
            !expectedReferencePayload
            || hashCanonical(expectedReferencePayload)
              !== reference.content_sha256
          ) {
            reasons.push(
              `research_funnel_prior_absorption_evidence_ref_mismatch:${candidateId}:${reference.evidence_id}`
            );
          }
        }
      }
    }
  }

  reasons.push(
    ...validateJsonlRecordContexts(
      drafts.records,
      "draft",
      "id",
      input.expectedRunId,
      input.expectedResearchCycle
    ),
    ...validateJsonlRecordContexts(
      reviews.records,
      "review",
      "candidate_id",
      input.expectedRunId,
      input.expectedResearchCycle
    ),
    ...validateJsonlRecordContexts(
      hypotheses.records,
      "hypothesis",
      "candidate_id",
      input.expectedRunId,
      input.expectedResearchCycle
    )
  );

  const portfolioCandidateIds = [
    ...portfolio.candidates.map((candidate) => candidate.source_candidate_id),
    ...portfolio.overflow_candidates.map((candidate) => candidate.source_candidate_id)
  ];
  if (!stringSetsEqual(draftIds, portfolioCandidateIds)) {
    reasons.push("research_funnel_portfolio_draft_candidate_set_mismatch");
  }
  if (!stringSetsEqual(reviewIds, draftIds)) {
    reasons.push("research_funnel_review_candidate_set_mismatch");
  }
  for (const candidateId of draftIds) {
    if (!reviewIds.includes(candidateId)) {
      reasons.push(`research_funnel_review_missing:${candidateId}`);
    }
  }
  for (const candidateId of reviewIds) {
    if (!draftIds.includes(candidateId)) {
      reasons.push(`research_funnel_review_candidate_unknown:${candidateId}`);
    }
  }
  const reviewsByCandidateId = new Map(
    reviews.records.flatMap((review) => {
      const candidateId = normalizeOptionalText(review.candidate_id);
      return candidateId ? [[candidateId, review] as const] : [];
    })
  );
  for (const candidate of portfolio.candidates) {
    const review = reviewsByCandidateId.get(candidate.source_candidate_id);
    if (!review) {
      continue;
    }
    const reviewIsIndependent = isHypothesisReviewProvenanceAuthorizing(
      review.provenance
    );
    const expectedReviewStatus = reviewIsIndependent
      ? review.keep === true
        ? "kept"
        : review.keep === false
          ? "rejected"
          : "not_reviewed"
      : "not_reviewed";
    if (candidate.review_status !== expectedReviewStatus) {
      reasons.push(
        `research_funnel_review_disposition_mismatch:${candidate.source_candidate_id}`
      );
    }
    if (
      normalizeOptionalText(candidate.review_summary)
      !== normalizeOptionalText(review.critique_summary)
    ) {
      reasons.push(
        `research_funnel_review_summary_mismatch:${candidate.source_candidate_id}`
      );
    }
  }

  const shortlist = shortlistResult.shortlist;
  if (shortlist) {
    reasons.push(...validateProbeShortlistContext(shortlist, input));
    if (new Set(shortlist.probe_candidate_ids).size !== shortlist.probe_candidate_ids.length) {
      reasons.push("research_funnel_probe_shortlist_duplicate_candidate_id");
    }
    if (new Set(shortlist.probe_topic_ids).size !== shortlist.probe_topic_ids.length) {
      reasons.push("research_funnel_probe_shortlist_duplicate_topic_id");
    }
    if (new Set(shortlist.ranked_candidate_ids).size !== shortlist.ranked_candidate_ids.length) {
      reasons.push("research_funnel_probe_shortlist_duplicate_ranked_candidate_id");
    }
    for (const candidateId of shortlist.probe_candidate_ids) {
      if (!draftIds.includes(candidateId)) {
        reasons.push(`research_funnel_probe_shortlist_candidate_unknown:${candidateId}`);
      }
      if (!reviewIds.includes(candidateId)) {
        reasons.push(`research_funnel_probe_shortlist_review_missing:${candidateId}`);
      }
    }
    for (const candidateId of shortlist.ranked_candidate_ids) {
      if (!draftIds.includes(candidateId)) {
        reasons.push(`research_funnel_probe_shortlist_ranked_candidate_unknown:${candidateId}`);
      }
    }
    for (const score of shortlist.scores) {
      const candidateId = normalizeOptionalText(score.candidate_id);
      if (!candidateId || !draftIds.includes(candidateId)) {
        reasons.push(`research_funnel_probe_shortlist_score_candidate_unknown:${candidateId || "missing"}`);
      }
    }

    const topicByCandidateId = new Map(
      portfolio.candidates.map((candidate) => [candidate.source_candidate_id, candidate.topic_id] as const)
    );
    const expectedTopicIds = shortlist.probe_candidate_ids.flatMap((candidateId) => {
      const topicId = topicByCandidateId.get(candidateId);
      return topicId ? [topicId] : [];
    });
    if (!stringArraysEqual(shortlist.probe_topic_ids, expectedTopicIds)) {
      reasons.push("research_funnel_probe_shortlist_candidate_topic_mapping_mismatch");
    }
    if (!stringArraysEqual(portfolio.probe_candidate_ids, shortlist.probe_candidate_ids)) {
      reasons.push("research_funnel_portfolio_shortlist_candidate_mismatch");
    }
    if (!stringArraysEqual(portfolio.probe_topic_ids, shortlist.probe_topic_ids)) {
      reasons.push("research_funnel_portfolio_shortlist_topic_mismatch");
    }
    if (!stringArraysEqual(hypothesisCandidateIds, shortlist.probe_candidate_ids)) {
      reasons.push("research_funnel_hypothesis_shortlist_candidate_mismatch");
    }
  }

  const draftsById = indexRecordsByIdentifier(drafts.records, "id");
  const hypothesesByCandidateId = indexRecordsByIdentifier(hypotheses.records, "candidate_id");
  const gapsById = new Map((gapMap?.gaps || []).map((gap) => [gap.gap_id, gap] as const));
  for (const candidate of portfolio.candidates) {
    const candidateId = candidate.source_candidate_id;
    const unresolvedClusterIds = candidate.cluster_ids.filter(
      (clusterId) => !evidenceAxisIds.has(clusterId)
    );
    if (!stringArraysEqual(candidate.unresolved_cluster_ids, unresolvedClusterIds)) {
      reasons.push(
        `research_funnel_candidate_axis_resolution_mismatch:${candidateId}`
      );
    }
    const expectedPriorProjection = projectPriorAbsorptionCandidate(
      priorAbsorptionMatrix,
      candidateId
    );
    if (
      !candidate.prior_absorption
      || !expectedPriorProjection
      || hashCanonical(candidate.prior_absorption)
        !== hashCanonical(expectedPriorProjection)
    ) {
      reasons.push(
        `research_funnel_candidate_prior_absorption_projection_mismatch:${candidateId}`
      );
    }
    if (candidate.supported_gap_ids.length === 0) {
      reasons.push(`research_funnel_candidate_supported_gap_missing:${candidateId}`);
    }
    for (const gapId of candidate.supported_gap_ids) {
      const gap = gapsById.get(gapId);
      if (!gap) {
        reasons.push(`research_funnel_candidate_supported_gap_unknown:${candidateId}:${gapId}`);
      } else if (gap.epistemic_status !== "supported_candidate") {
        reasons.push(`research_funnel_candidate_gap_not_supported:${candidateId}:${gapId}`);
      } else if (gap.evidence_links.some((id) => !candidate.evidence_links.includes(id))) {
        reasons.push(`research_funnel_candidate_gap_evidence_incomplete:${candidateId}:${gapId}`);
      }
    }
    if (gapMap) {
      const expectedGapIds = resolveSupportedGapIds(candidate.evidence_links, gapMap);
      if (!stringArraysEqual(candidate.supported_gap_ids, expectedGapIds)) {
        reasons.push(`research_funnel_candidate_supported_gap_set_mismatch:${candidateId}`);
      }
    }

    const draft = draftsById.get(candidateId);
    if (draft) {
      const draftGapIds = readStringArray(draft.supported_gap_ids);
      if (!draftGapIds) {
        reasons.push(`research_funnel_draft_supported_gap_ids_missing:${candidateId}`);
      } else if (!stringArraysEqual(draftGapIds, candidate.supported_gap_ids)) {
        reasons.push(`research_funnel_draft_supported_gap_ids_mismatch:${candidateId}`);
      }
      const draftEvidenceLinks = readStringArray(draft.evidence_links);
      if (!draftEvidenceLinks || !stringArraysEqual(draftEvidenceLinks, candidate.evidence_links)) {
        reasons.push(`research_funnel_draft_evidence_links_mismatch:${candidateId}`);
      }
      const draftAxisIds = readStringArray(draft.axis_ids);
      if (
        !draftAxisIds
        || !stringArraysEqual(normalizeClusterIds(draftAxisIds), candidate.cluster_ids)
      ) {
        reasons.push(`research_funnel_draft_axis_ids_mismatch:${candidateId}`);
      }
      if (normalizeOptionalText(draft.text) !== candidate.statement) {
        reasons.push(`research_funnel_draft_statement_mismatch:${candidateId}`);
      }
      reasons.push(...collectDraftCandidateObjectiveReasons(draft, candidate));
    }

    const hypothesis = hypothesesByCandidateId.get(candidateId);
    if (hypothesis) {
      const hypothesisGapIds = readStringArray(hypothesis.supported_gap_ids);
      if (!hypothesisGapIds || !stringArraysEqual(hypothesisGapIds, candidate.supported_gap_ids)) {
        reasons.push(`research_funnel_hypothesis_supported_gap_ids_mismatch:${candidateId}`);
      }
      reasons.push(...collectHypothesisCandidateContractReasons(
        hypothesis,
        candidate
      ));
    }
  }

  return uniqueStrings(reasons);
}

function collectDraftCandidateObjectiveReasons(
  draft: Record<string, unknown>,
  candidate: TopicPortfolioCandidate
): string[] {
  const candidateId = candidate.source_candidate_id;
  const reasons: string[] = [];
  const textBindings: Array<readonly [string, unknown, unknown]> = [
    ["primary_metric", draft.primary_metric, candidate.primary_metric],
    ["metric_unit", draft.metric_unit, candidate.metric_unit],
    ["metric_scale", draft.metric_scale, candidate.metric_scale],
    ["metric_direction", draft.metric_direction, candidate.metric_direction],
    ["comparator", draft.comparator, candidate.comparator],
    ["dataset_task_bench", draft.dataset_task_bench, candidate.dataset_task_bench],
    ["meaningful_effect", draft.meaningful_effect, candidate.meaningful_effect]
  ];
  for (const [field, draftValue, candidateValue] of textBindings) {
    if (normalizeOptionalText(draftValue) !== normalizeOptionalText(candidateValue)) {
      reasons.push(`research_funnel_draft_contract_mismatch:${candidateId}:${field}`);
    }
  }
  if (!effectCriterionValuesEqual(draft.effect_criterion, candidate.effect_criterion)) {
    reasons.push(
      `research_funnel_draft_contract_mismatch:${candidateId}:effect_criterion`
    );
  }
  return reasons;
}

function collectHypothesisCandidateContractReasons(
  hypothesis: Record<string, unknown>,
  candidate: TopicPortfolioCandidate
): string[] {
  const candidateId = candidate.source_candidate_id;
  const reasons: string[] = [];
  const textBindings: Array<readonly [string, unknown, unknown]> = [
    ["statement", hypothesis.text, candidate.statement],
    ["gap_statement", hypothesis.gap_statement, candidate.gap_statement],
    ["closest_prior_non_overlap", hypothesis.closest_prior_non_overlap, candidate.closest_prior_non_overlap],
    ["reviewer_absorption_objection", hypothesis.reviewer_absorption_objection, candidate.reviewer_absorption_objection],
    ["comparator", hypothesis.comparator, candidate.comparator],
    ["dataset_task_bench", hypothesis.dataset_task_bench, candidate.dataset_task_bench],
    ["primary_metric", hypothesis.primary_metric, candidate.primary_metric],
    ["metric_unit", hypothesis.metric_unit, candidate.metric_unit],
    ["metric_scale", hypothesis.metric_scale, candidate.metric_scale],
    ["metric_direction", hypothesis.metric_direction, candidate.metric_direction],
    ["meaningful_effect", hypothesis.meaningful_effect, candidate.meaningful_effect],
    ["objective_raw", hypothesis.objective_raw, candidate.objective_raw],
    ["falsifier", hypothesis.falsifier, candidate.falsifier],
    ["local_budget", hypothesis.local_budget, candidate.local_budget],
    ["kill_signal", hypothesis.kill_signal, candidate.kill_signal],
    ["contribution_claim", hypothesis.contribution_claim, candidate.contribution_claim],
    [
      "minimum_publishable_evidence",
      hypothesis.minimum_publishable_evidence,
      candidate.minimum_publishable_evidence
    ]
  ];
  for (const [field, hypothesisValue, candidateValue] of textBindings) {
    if (normalizeOptionalText(hypothesisValue) !== normalizeOptionalText(candidateValue)) {
      reasons.push(`research_funnel_hypothesis_contract_mismatch:${candidateId}:${field}`);
    }
  }
  if (!effectCriterionValuesEqual(hypothesis.effect_criterion, candidate.effect_criterion)) {
    reasons.push(`research_funnel_hypothesis_contract_mismatch:${candidateId}:effect_criterion`);
  }

  const hypothesisEvidenceLinks = readStringArray(hypothesis.evidence_links);
  if (
    !hypothesisEvidenceLinks
    || !stringArraysEqual(hypothesisEvidenceLinks, candidate.evidence_links)
  ) {
    reasons.push(`research_funnel_hypothesis_contract_mismatch:${candidateId}:evidence_links`);
  }

  const hypothesisAxisIds = readStringArray(hypothesis.axis_ids);
  if (
    !hypothesisAxisIds
    || !stringArraysEqual(normalizeClusterIds(hypothesisAxisIds), candidate.cluster_ids)
  ) {
    reasons.push(`research_funnel_hypothesis_contract_mismatch:${candidateId}:axis_ids`);
  }

  return reasons;
}
interface ParsedJsonlArtifact {
  records: Array<Record<string, unknown>>;
  reasons: string[];
}

function validateSourceArtifactBindings(
  input: ResearchFunnelClosedChainInput,
  portfolio: TopicPortfolio
): string[] {
  const reasons: string[] = [];
  const contents = closedChainSourceArtifactContents(input);
  const bindingsByPath = new Map(
    portfolio.source_artifact_bindings.map((binding) => [binding.path, binding] as const)
  );
  for (const artifactPath of RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS) {
    const binding = bindingsByPath.get(artifactPath);
    if (!binding) {
      continue;
    }
    const content = contents[artifactPath];
    if (content === undefined) {
      reasons.push(`research_funnel_source_artifact_missing:${artifactPath}`);
      continue;
    }
    const expected = buildResearchFunnelArtifactBinding(artifactPath, content);
    if (binding.sha256 !== expected.sha256) {
      reasons.push(`topic_portfolio_source_binding_hash_mismatch:${artifactPath}`);
    }
    if (binding.byte_length !== expected.byte_length) {
      reasons.push(`topic_portfolio_source_binding_byte_length_mismatch:${artifactPath}`);
    }
  }
  return reasons;
}

function parseJsonlArtifact(raw: string | undefined, kind: string): ParsedJsonlArtifact {
  if (raw === undefined) {
    return { records: [], reasons: [] };
  }
  const records: Array<Record<string, unknown>> = [];
  const reasons: string[] = [];
  raw.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (!isRecord(value)) {
        reasons.push(`research_funnel_${kind}_invalid_jsonl:${index + 1}`);
        return;
      }
      records.push(value);
    } catch {
      reasons.push(`research_funnel_${kind}_invalid_jsonl:${index + 1}`);
    }
  });
  return { records, reasons };
}

function parseProbeShortlist(raw: string | undefined): {
  shortlist?: ResearchFunnelProbeShortlist;
  reasons: string[];
} {
  if (raw === undefined) {
    return { reasons: ["research_funnel_probe_shortlist_missing"] };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { reasons: ["research_funnel_probe_shortlist_invalid_json"] };
  }
  if (!isResearchFunnelProbeShortlist(value)) {
    return { reasons: ["research_funnel_probe_shortlist_schema_invalid"] };
  }
  return { shortlist: value, reasons: [] };
}

function collectRecordIdentifiers(
  records: Array<Record<string, unknown>>,
  field: string,
  kind: string,
  reasons: string[]
): string[] {
  const identifiers: string[] = [];
  const seen = new Set<string>();
  records.forEach((record, index) => {
    const identifier = normalizeOptionalText(record[field]);
    if (!identifier) {
      reasons.push(`research_funnel_${kind}_identifier_missing:${index + 1}`);
      return;
    }
    if (seen.has(identifier)) {
      reasons.push(`research_funnel_${kind}_duplicate_identifier:${identifier}`);
    }
    seen.add(identifier);
    identifiers.push(identifier);
  });
  return identifiers;
}

function validateJsonlRecordContexts(
  records: Array<Record<string, unknown>>,
  kind: string,
  identifierField: string,
  expectedRunId: string,
  expectedResearchCycle: number
): string[] {
  const reasons: string[] = [];
  records.forEach((record, index) => {
    const identifier = normalizeOptionalText(record[identifierField]) || String(index + 1);
    const runId = normalizeOptionalText(record.run_id);
    if (!runId) {
      reasons.push(`research_funnel_${kind}_run_id_missing:${identifier}`);
    } else if (runId !== expectedRunId) {
      reasons.push(`research_funnel_${kind}_run_id_mismatch:${identifier}`);
    }
    if (!isValidResearchCycle(record.research_cycle)) {
      reasons.push(`research_funnel_${kind}_research_cycle_missing:${identifier}`);
    } else if (record.research_cycle !== expectedResearchCycle) {
      reasons.push(`research_funnel_${kind}_research_cycle_mismatch:${identifier}`);
    }
  });
  return reasons;
}

function validateProbeShortlistContext(
  shortlist: ResearchFunnelProbeShortlist,
  input: ResearchFunnelClosedChainInput
): string[] {
  const reasons: string[] = [];
  if (shortlist.run_id !== input.expectedRunId) {
    reasons.push("research_funnel_probe_shortlist_run_id_mismatch");
  }
  if (shortlist.research_cycle !== input.expectedResearchCycle) {
    reasons.push("research_funnel_probe_shortlist_research_cycle_mismatch");
  }
  return reasons;
}

function indexRecordsByIdentifier(
  records: Array<Record<string, unknown>>,
  field: string
): Map<string, Record<string, unknown>> {
  const indexed = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const identifier = normalizeOptionalText(record[field]);
    if (identifier && !indexed.has(identifier)) {
      indexed.set(identifier, record);
    }
  }
  return indexed;
}

function readStringArray(value: unknown): string[] | undefined {
  return isStringArray(value) ? value : undefined;
}

function stringSetsEqual(left: string[], right: string[]): boolean {
  return stringArraysEqual([...left].sort(), [...right].sort());
}

function isResearchFunnelProbeShortlist(value: unknown): value is ResearchFunnelProbeShortlist {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.run_id === "string"
    && typeof value.research_cycle === "number"
    && isStringArray(value.probe_candidate_ids)
    && isStringArray(value.probe_topic_ids)
    && isStringArray(value.ranked_candidate_ids)
    && Array.isArray(value.scores)
    && value.scores.every(isRecord)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHypothesisEvidenceAxis(
  value: unknown
): value is HypothesisEvidenceAxis {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Boolean(normalizeOptionalText(value.id))
    && Boolean(normalizeOptionalText(value.label))
    && Boolean(normalizeOptionalText(value.mechanism))
    && Boolean(normalizeOptionalText(value.intervention))
    && (value.boundary_condition === undefined
      || typeof value.boundary_condition === "string")
    && (value.evaluation_hint === undefined
      || typeof value.evaluation_hint === "string")
    && isStringArray(value.evidence_links)
    && value.evidence_links.length > 0
  );
}

function buildGapCandidate(
  items: HypothesisEvidenceSeed[],
  statementOverride?: string,
  allowSupported = true,
  constructionOrigin: ResearchGapCandidate["construction_origin"] = "exact_grouping",
  opportunityType?: ResearchOpportunityType
): ResearchGapCandidate {
  const statement =
    normalizeOptionalText(statementOverride) ||
    normalizeOptionalText(items[0]?.limitation_slot) ||
    "Unspecified limitation";
  const evidenceLinks = uniqueStrings(items.map((item, index) => item.evidence_id || `ev_${index + 1}`));
  const paperIds = uniqueStrings(items.map((item) => item.paper_id));
  const fullTextPaperIds = uniqueStrings(
    items.filter((item) => item.source_type === "full_text").map((item) => item.paper_id)
  );
  const abstractPaperIds = uniqueStrings(
    items.filter((item) => item.source_type !== "full_text").map((item) => item.paper_id)
  );
  const independentlySupported =
    allowSupported && paperIds.length >= 2 && fullTextPaperIds.length >= 2;
  return {
    gap_id: `gap_${hashCanonical({
      statement,
      evidence_links: evidenceLinks,
      opportunity_type: opportunityType ?? null
    }).slice(0, 12)}`,
    construction_origin: constructionOrigin,
    ...(opportunityType ? { opportunity_type: opportunityType } : {}),
    statement,
    evidence_links: evidenceLinks,
    paper_ids: paperIds,
    source_types: uniqueSourceTypes(items),
    datasets: uniqueStrings(items.map((item) => item.dataset_slot)),
    metrics: uniqueStrings(items.map((item) => item.metric_slot)),
    support: {
      distinct_paper_count: paperIds.length,
      full_text_paper_count: fullTextPaperIds.length,
      abstract_only_paper_count: abstractPaperIds.filter((paperId) => !fullTextPaperIds.includes(paperId)).length
    },
    epistemic_status: independentlySupported ? "supported_candidate" : "provisional_candidate",
    gates: [
      gate(
        "independent_paper_support",
        paperIds.length >= 2,
        paperIds.length >= 2
          ? "The candidate is supported by at least two papers."
          : "The candidate is supported by fewer than two papers."
      ),
      gate(
        "full_text_support",
        fullTextPaperIds.length >= 2,
        fullTextPaperIds.length >= 2
          ? "The candidate includes full-text evidence from at least two independent papers."
          : "The candidate lacks full-text evidence from two independent papers."
      ),
      gate(
        "promotion_authorized",
        independentlySupported,
        independentlySupported
          ? "The candidate passed its construction-mode promotion gate."
          : "The candidate remains diagnostic or provisional under its construction mode."
      )
    ]
  };
}

function buildTopicPortfolioCandidate(
  candidate: HypothesisCandidate,
  review: HypothesisReview | undefined,
  probeCandidateIds: Set<string>,
  evidenceById: Map<string, HypothesisEvidenceSeed>,
  evidenceAxisIds: Set<string>,
  gapMap: ResearchGapMap | undefined,
  priorAbsorptionMatrix: PriorAbsorptionMatrix | undefined,
  candidatePriorSearchBinding: CandidatePriorSearchReviewBinding | undefined,
  computeBudgetCeiling: TopicProbeComputeBudgetLimits | undefined,
  topicMemoryLedger: TopicMemoryLedger,
  topicReentryTicket: TopicReentryTicket | undefined,
  topicSemanticAudit: TopicMemorySemanticAudit | undefined
): TopicPortfolioCandidate {
  const clusterIds = normalizeClusterIds(candidate.axis_ids || []);
  const unresolvedClusterIds = clusterIds.filter(
    (clusterId) => !evidenceAxisIds.has(clusterId)
  );
  const linkedEvidence = candidate.evidence_links
    .map((evidenceId) => evidenceById.get(evidenceId))
    .filter((item): item is HypothesisEvidenceSeed => Boolean(item));
  const closestPriorPaperIds = uniqueStrings(linkedEvidence.map((item) => item.paper_id));
  const unresolvedEvidenceLinks = candidate.evidence_links.filter(
    (evidenceId) => !evidenceById.has(evidenceId)
  );
  const closestPriorFullTextPaperIds = uniqueStrings(
    linkedEvidence.filter((item) => item.source_type === "full_text").map((item) => item.paper_id)
  );
  const priorAbsorption = projectPriorAbsorptionCandidate(
    priorAbsorptionMatrix,
    candidate.id
  );
  const datasetTaskBench = normalizeOptionalText(candidate.dataset_task_bench);
  const primaryMetric = normalizeOptionalText(candidate.primary_metric);
  const metricUnit = normalizeOptionalText(candidate.metric_unit);
  const metricScale = isExplicitMetricScale(candidate.metric_scale) ? candidate.metric_scale : undefined;
  const comparator = normalizeOptionalText(candidate.comparator);
  const effectCriterion = parseEffectCriterion(candidate.effect_criterion);
  const computeBudgetValidation = validateTopicProbeComputeBudgetDeclaration(
    candidate.local_budget
  );
  const computeBudgetWithinCeiling = Boolean(
    computeBudgetCeiling
    && computeBudgetValidation.limits
    && topicProbeComputeBudgetFitsWithin(
      computeBudgetValidation.limits,
      computeBudgetCeiling
    )
  );
  const objectiveRaw =
    primaryMetric
    && metricUnit
    && metricScale
    && comparator
    && (candidate.metric_direction === "maximize" || candidate.metric_direction === "minimize")
    && effectCriterion
      ? buildCandidateObjectiveRaw({
          primary_metric: primaryMetric,
          metric_unit: metricUnit,
          metric_scale: metricScale,
          metric_direction: candidate.metric_direction,
          comparator,
          effect_criterion: effectCriterion
        })
      : undefined;
  const gapStatement =
    normalizeOptionalText(candidate.gap_statement) ||
    uniqueStrings(linkedEvidence.map((item) => item.limitation_slot)).join("; ") ||
    undefined;
  const supportedGapIds = resolveSupportedGapIds(candidate.evidence_links, gapMap);
  const independentReviewRecorded = Boolean(
    review && isHypothesisReviewProvenanceAuthorizing(review.provenance)
  );
  const reviewStatus = independentReviewRecorded && review
    ? review.keep
      ? "kept"
      : "rejected"
    : "not_reviewed";
  let topicDescriptor: TopicFormulationDescriptor | undefined;
  let topicMemoryDecision: TopicMemoryDecision;
  try {
    topicDescriptor = buildTopicFormulationDescriptor({
      statement: candidate.text,
      gap_statement: gapStatement,
      contribution_claim: normalizeOptionalText(candidate.contribution_claim),
      dataset_task_bench: datasetTaskBench,
      comparator,
      primary_metric: primaryMetric,
      metric_unit: metricUnit,
      meaningful_effect: normalizeOptionalText(candidate.meaningful_effect),
      minimum_publishable_evidence: normalizeOptionalText(
        candidate.minimum_publishable_evidence
      )
    });
    topicMemoryDecision = evaluateTopicMemory(
      topicMemoryLedger,
      topicDescriptor,
      topicReentryTicket,
      topicSemanticAudit
    );
  } catch (error) {
    topicMemoryDecision = {
      disposition: "blocked",
      blocked: true,
      exact_formulation_match: false,
      exact_lineage_match: false,
      near_lineage_match: false,
      matching_record_sha256s: [],
      maximum_lineage_similarity: 0,
      reason_codes: [
        `topic_memory_descriptor_invalid:${error instanceof Error ? error.message : String(error)}`
      ]
    };
  }
  const topicMemoryEligible =
    topicMemoryDecision.disposition === "clear"
    || topicMemoryDecision.disposition === "reentry_allowed";
  const formulationVersion = topicDescriptor
    ? topicMemoryLedger.records.filter(
        (record) =>
          record.descriptor.lineage_sha256 === topicDescriptor?.lineage_sha256
      ).length + 1
    : undefined;
  const priorAbsorptionCoverageComplete = Boolean(
    priorAbsorption?.coverage_complete
    && stringArraysEqual(priorAbsorption.prior_paper_ids, closestPriorPaperIds)
    && stringArraysEqual(
      priorAbsorption.comparisons.map((comparison) => comparison.prior_paper_id),
      closestPriorPaperIds
    )
  );
  const priorAbsorptionDispositionEligible = Boolean(
    priorAbsorptionCoverageComplete && priorAbsorption?.probe_eligible
  );
  const currentPriorAbsorptionContract =
    buildPriorAbsorptionCandidateContract(candidate);
  const candidatePriorSearchLineageBound = Boolean(
    candidatePriorSearchBinding
    && isCandidatePriorSearchReviewBinding(candidatePriorSearchBinding)
    && candidatePriorSearchBinding.candidate_id === candidate.id
    && candidatePriorSearchBinding.prior_absorption_contract_sha256
      === currentPriorAbsorptionContract.content_sha256
  );
  const selectedDirectPriorCoverageComplete = Boolean(
    candidatePriorSearchLineageBound
    && candidatePriorSearchBinding?.selected_direct_prior_ids.every(
      (paperId) =>
        closestPriorPaperIds.includes(paperId)
        && closestPriorFullTextPaperIds.includes(paperId)
        && priorAbsorption?.prior_paper_ids.includes(paperId)
        && priorAbsorption.comparisons.some(
          (comparison) => comparison.prior_paper_id === paperId
        )
    )
  );
  const gates: ResearchFunnelGate[] = [
    gate(
      "evidence_axis_references_resolved",
      clusterIds.length > 0 && unresolvedClusterIds.length === 0,
      clusterIds.length > 0 && unresolvedClusterIds.length === 0
        ? "Every candidate evidence-axis reference resolves to the emitted axis artifact."
        : unresolvedClusterIds.length > 0
          ? `Unknown evidence-axis references: ${unresolvedClusterIds.join(", ")}.`
          : "The candidate does not reference an emitted evidence axis."
    ),
    requiredTextGate("gap_statement_present", gapStatement, "research gap statement"),
    gate(
      "supported_gap_reference_present",
      supportedGapIds.length > 0,
      supportedGapIds.length > 0
        ? "The candidate binds the complete evidence chain for at least one supported gap."
        : "The candidate does not bind every required evidence item for a supported gap."
    ),
    gate(
      "evidence_links_present",
      candidate.evidence_links.length > 0 && unresolvedEvidenceLinks.length === 0,
      candidate.evidence_links.length > 0 && unresolvedEvidenceLinks.length === 0
        ? "Every evidence link resolves to analyzed evidence."
        : "Evidence links are missing or do not resolve to analyzed evidence."
    ),
    gate(
      "closest_prior_independent_support",
      closestPriorPaperIds.length >= 2,
      closestPriorPaperIds.length >= 2
        ? "At least two distinct closest-prior papers are linked."
        : "Fewer than two distinct closest-prior papers are linked."
    ),
    gate(
      "closest_prior_full_text_support",
      closestPriorFullTextPaperIds.length >= 2,
      closestPriorFullTextPaperIds.length >= 2
        ? "At least two distinct closest-prior papers have full-text evidence."
        : "Fewer than two distinct closest-prior papers have full-text evidence."
    ),
    gate(
      "prior_absorption_matrix_bound",
      Boolean(priorAbsorption),
      priorAbsorption
        ? "The candidate is bound to a content-hashed prior-absorption matrix entry."
        : "No content-hashed prior-absorption matrix entry is bound to the candidate."
    ),
    gate(
      "prior_absorption_prior_coverage_complete",
      priorAbsorptionCoverageComplete,
      priorAbsorptionCoverageComplete
        ? "Every linked closest prior has exactly one structured absorption comparison."
        : "The absorption matrix does not cover every linked closest prior exactly once."
    ),
    gate(
      "prior_absorption_full_text_evidence_complete",
      Boolean(priorAbsorption?.full_text_evidence_complete),
      priorAbsorption?.full_text_evidence_complete
        ? "Every absorption axis is grounded in an exact full-text evidence reference."
        : "At least one absorption axis lacks an exact full-text evidence reference."
    ),
    gate(
      "prior_absorption_independent_evidence_complete",
      Boolean(priorAbsorption?.independent_evidence_complete),
      priorAbsorption?.independent_evidence_complete
        ? "Absorption dispositions are supported by full-text evidence from independent linked priors."
        : "Absorption dispositions lack independent full-text support from at least two linked priors."
    ),
    gate(
      "prior_absorption_partial_comparison_complete",
      Boolean(priorAbsorption?.partial_comparisons_complete),
      priorAbsorption?.partial_comparisons_complete
        ? "Every reported partial absorption includes a residual difference and falsifiable comparison."
        : "A reported partial absorption lacks a grounded residual difference or falsifiable comparison."
    ),
    gate(
      "prior_absorption_disposition_eligible",
      priorAbsorptionDispositionEligible,
      priorAbsorptionDispositionEligible
        ? "Every closest prior has an evidence-grounded eligible absorption disposition."
        : `Prior absorption blocks probe eligibility: ${priorAbsorption?.reason_codes.join(", ") || "matrix entry missing"}.`
    ),
    ...(candidatePriorSearchBinding
      ? [
          gate(
            "candidate_prior_search_lineage_bound",
            candidatePriorSearchLineageBound,
            candidatePriorSearchLineageBound
              ? "The direct-prior review is bound to the candidate contract, search plan, and validated receipt lineage."
              : "The direct-prior review does not match the candidate contract or receipt lineage."
          ),
          gate(
            "candidate_prior_search_selected_prior_coverage_complete",
            selectedDirectPriorCoverageComplete,
            selectedDirectPriorCoverageComplete
              ? "Every selected direct prior is linked as full-text closest-prior evidence and covered by the absorption matrix."
              : "At least one selected direct prior is omitted from full-text closest-prior or absorption-matrix coverage."
          )
        ]
      : []),
    requiredTextGate(
      "closest_prior_non_overlap_present",
      candidate.closest_prior_non_overlap,
      "non-overlap from the closest prior work"
    ),
    requiredTextGate(
      "reviewer_absorption_objection_present",
      candidate.reviewer_absorption_objection,
      "reviewer absorption objection"
    ),
    requiredTextGate("comparator_present", candidate.comparator, "baseline or comparator"),
    requiredTextGate("dataset_task_bench_present", datasetTaskBench, "dataset, task, or benchmark"),
    requiredTextGate("primary_metric_present", primaryMetric, "primary metric"),
    requiredTextGate("metric_unit_present", metricUnit, "explicit metric unit"),
    gate(
      "metric_scale_valid",
      Boolean(metricScale),
      "The candidate declares the observed metric scale independently of the effect scale."
    ),
    gate(
      "metric_direction_present",
      candidate.metric_direction === "maximize" || candidate.metric_direction === "minimize",
      "The candidate declares whether the primary metric is maximized or minimized."
    ),
    gate(
      "effect_criterion_valid",
      isEffectCriterion(candidate.effect_criterion),
      "The candidate declares a valid structured delta-versus-reference effect criterion."
    ),
    requiredTextGate("falsifier_present", candidate.falsifier, "falsifying outcome"),
    requiredTextGate("local_budget_present", candidate.local_budget, "bounded local budget"),
    gate(
      "compute_budget_declaration_valid",
      computeBudgetValidation.valid,
      computeBudgetValidation.valid
        ? "The local budget declares bounded-probe and confirmatory GPU-hour, concurrency, and fresh-trial ceilings."
        : `The local budget is not a complete two-stage compute declaration: ${computeBudgetValidation.reason}.`
    ),
    ...(computeBudgetCeiling
      ? [gate(
          "compute_budget_within_brief_ceiling",
          computeBudgetWithinCeiling,
          computeBudgetWithinCeiling
            ? "Every candidate stage limit is within the brief-owned compute ceiling."
            : "The candidate exceeds at least one brief-owned GPU-hour, concurrency, or fresh-trial ceiling."
        )]
      : []),
    requiredTextGate("kill_signal_present", candidate.kill_signal, "kill signal"),
    requiredTextGate(
      "contribution_claim_present",
      candidate.contribution_claim,
      "specific contribution that survives the closest-prior and strongest-baseline objections"
    ),
    requiredTextGate(
      "minimum_publishable_evidence_present",
      candidate.minimum_publishable_evidence,
      "minimum publishable-evidence contract beyond a screening probe"
    ),
    gate(
      "topic_memory_clear_or_reentry_allowed",
      topicMemoryEligible,
      topicMemoryEligible
        ? topicMemoryDecision.disposition === "reentry_allowed"
          ? "A content-hashed reentry ticket authorizes the materially revised topic formulation."
          : "The project topic memory contains no killed exact or near lineage match."
        : `Project topic memory blocks this candidate: ${topicMemoryDecision.reason_codes.join(", ")}.`
    ),
    gate(
      "review_provenance_independent",
      independentReviewRecorded,
      independentReviewRecorded
        ? "The review is bound to distinct proposer and reviewer identities plus validated invocation hashes."
        : review
          ? "The recorded review is self-review or lacks authorizing provenance."
          : "No review provenance is recorded."
    ),
    gate(
      "review_kept",
      reviewStatus === "kept",
      reviewStatus === "kept"
        ? "Independent hypothesis review kept the candidate."
        : reviewStatus === "rejected"
          ? "Independent hypothesis review rejected the candidate."
          : "No independent hypothesis review is recorded."
    )
  ];
  const identityContent = {
    statement: candidate.text,
    gap_statement: gapStatement,
    supported_gap_ids: supportedGapIds,
    evidence_links: candidate.evidence_links,
    cluster_ids: clusterIds,
    unresolved_cluster_ids: unresolvedClusterIds,
    closest_prior_paper_ids: closestPriorPaperIds,
    unresolved_evidence_links: unresolvedEvidenceLinks,
    closest_prior_full_text_paper_ids: closestPriorFullTextPaperIds,
    candidate_prior_search: candidatePriorSearchBinding,
    prior_absorption: priorAbsorption,
    closest_prior_non_overlap: normalizeOptionalText(candidate.closest_prior_non_overlap),
    reviewer_absorption_objection: normalizeOptionalText(candidate.reviewer_absorption_objection),
    comparator,
    dataset_task_bench: datasetTaskBench,
    primary_metric: primaryMetric,
    metric_unit: metricUnit,
    metric_scale: metricScale,
    metric_direction: candidate.metric_direction,
    meaningful_effect: normalizeOptionalText(candidate.meaningful_effect),
    effect_criterion: effectCriterion,
    objective_raw: objectiveRaw,
    falsifier: normalizeOptionalText(candidate.falsifier),
    local_budget: normalizeOptionalText(candidate.local_budget),
    brief_compute_budget_ceiling: computeBudgetCeiling,
    kill_signal: normalizeOptionalText(candidate.kill_signal),
    contribution_claim: normalizeOptionalText(candidate.contribution_claim),
    minimum_publishable_evidence: normalizeOptionalText(candidate.minimum_publishable_evidence)
  };
  const fallbackTopicId = `topic_${hashCanonical(identityContent).slice(0, 12)}`;
  const topicLineageId = topicDescriptor
    ? `topic_${topicDescriptor.lineage_sha256.slice(0, 12)}`
    : fallbackTopicId;
  const formulationId = topicDescriptor
    ? `formulation_${topicDescriptor.formulation_sha256.slice(0, 12)}`
    : undefined;
  const candidatePayload: Omit<TopicPortfolioCandidate, "content_sha256"> = {
    topic_id: topicLineageId,
    topic_lineage_id: topicLineageId,
    ...(formulationId ? { formulation_id: formulationId } : {}),
    ...(formulationVersion !== undefined
      ? { formulation_version: formulationVersion }
      : {}),
    source_candidate_id: candidate.id,
    statement: candidate.text,
    gap_statement: gapStatement,
    supported_gap_ids: supportedGapIds,
    evidence_links: [...candidate.evidence_links],
    cluster_ids: clusterIds,
    unresolved_cluster_ids: unresolvedClusterIds,
    closest_prior_paper_ids: closestPriorPaperIds,
    unresolved_evidence_links: unresolvedEvidenceLinks,
    comparator,
    closest_prior_full_text_paper_ids: closestPriorFullTextPaperIds,
    candidate_prior_search: candidatePriorSearchBinding,
    prior_absorption: priorAbsorption,
    closest_prior_non_overlap: normalizeOptionalText(candidate.closest_prior_non_overlap),
    reviewer_absorption_objection: normalizeOptionalText(candidate.reviewer_absorption_objection),
    dataset_task_bench: datasetTaskBench,
    primary_metric: primaryMetric,
    metric_unit: metricUnit,
    metric_scale: metricScale,
    metric_direction: candidate.metric_direction,
    meaningful_effect: normalizeOptionalText(candidate.meaningful_effect),
    effect_criterion: effectCriterion,
    objective_raw: objectiveRaw,
    falsifier: normalizeOptionalText(candidate.falsifier),
    local_budget: normalizeOptionalText(candidate.local_budget),
    brief_compute_budget_ceiling: computeBudgetCeiling,
    kill_signal: normalizeOptionalText(candidate.kill_signal),
    contribution_claim: normalizeOptionalText(candidate.contribution_claim),
    minimum_publishable_evidence: normalizeOptionalText(candidate.minimum_publishable_evidence),
    review_status: reviewStatus,
    probe_status: probeCandidateIds.has(candidate.id) ? "shortlisted" : "not_shortlisted",
    review_summary: normalizeOptionalText(review?.critique_summary),
    topic_memory: {
      ledger_sha256: topicMemoryLedger.ledger_sha256,
      ...(topicDescriptor ? { descriptor: topicDescriptor } : {}),
      ...(topicReentryTicket ? { reentry_ticket: topicReentryTicket } : {}),
      ...(topicSemanticAudit ? { semantic_audit: topicSemanticAudit } : {}),
      decision: topicMemoryDecision
    },
    scores: {
      novelty: candidate.novelty,
      feasibility: candidate.feasibility,
      testability: candidate.testability,
      cost: candidate.cost,
      expected_gain: candidate.expected_gain
    },
    gates,
    probe_eligible: gates.every((item) => item.status === "pass")
  };
  return {
    ...candidatePayload,
    content_sha256: hashCanonical(candidatePayload)
  };
}

function gate(code: string, passed: boolean, message: string): ResearchFunnelGate {
  return {
    code,
    status: passed ? "pass" : "block",
    message
  };
}

function requiredTextGate(code: string, value: unknown, label: string): ResearchFunnelGate {
  const present = Boolean(normalizeOptionalText(value));
  return gate(code, present, present ? `The ${label} is explicit.` : `The ${label} is missing or unknown.`);
}

function expectedResearchGapGates(gap: ResearchGapCandidate): ResearchFunnelGate[] {
  return [
    gate(
      "independent_paper_support",
      gap.paper_ids.length >= 2,
      "Independent paper support is recomputed from distinct paper identifiers."
    ),
    gate(
      "full_text_support",
      gap.support.full_text_paper_count >= 2,
      "Full-text support is recomputed from the stored support count."
    ),
    gate(
      "promotion_authorized",
      gap.epistemic_status === "supported_candidate",
      "Promotion authorization is recomputed from epistemic status."
    )
  ];
}

function expectedResearchGapMapGates(gapMap: ResearchGapMap): ResearchFunnelGate[] {
  const independentlySupported = gapMap.gaps.some(
    (gap) => gap.epistemic_status === "supported_candidate"
  );
  return [
    gate("gap_candidate_present", gapMap.gaps.length > 0, "Gap-candidate presence is recomputed."),
    gate(
      "independent_gap_support_present",
      independentlySupported,
      "Independent gap support is recomputed from candidate support."
    )
  ];
}

function validateGapLinksAgainstEvidence(
  gapMap: ResearchGapMap,
  evidence: HypothesisEvidenceSeed[],
  reviewedClusters: ResearchGapClusterSeed[] | undefined
): string[] {
  const reasons: string[] = [];
  const evidenceById = new Map<string, HypothesisEvidenceSeed>();
  for (const item of evidence) {
    const evidenceId = normalizeOptionalText(item.evidence_id);
    if (evidenceId && !evidenceById.has(evidenceId)) {
      evidenceById.set(evidenceId, item);
    }
  }
  const reviewedClusterKeys = new Set(
    (reviewedClusters ?? []).map((cluster) =>
      hashCanonical({
        statement: normalizeOptionalText(cluster.statement) ?? "",
        evidence_ids: uniqueStrings(cluster.evidence_ids).sort(),
        opportunity_type: cluster.opportunity_type ?? null
      })
    )
  );

  for (const gap of gapMap.gaps) {
    const linked: HypothesisEvidenceSeed[] = [];
    for (const evidenceId of gap.evidence_links) {
      const item = evidenceById.get(evidenceId);
      if (!item) {
        reasons.push(`research_gap_unknown_evidence:${gap.gap_id}:${evidenceId}`);
        continue;
      }
      linked.push(item);
    }
    if (linked.length !== gap.evidence_links.length) {
      continue;
    }

    const expectedPaperIds = uniqueStrings(linked.map((item) => item.paper_id));
    const expectedFullTextPaperIds = uniqueStrings(
      linked.filter((item) => item.source_type === "full_text").map((item) => item.paper_id)
    );
    const expectedAbstractPaperIds = uniqueStrings(
      linked.filter((item) => item.source_type !== "full_text").map((item) => item.paper_id)
    );
    const expectedSourceTypes = uniqueSourceTypes(linked);
    const expectedDatasets = uniqueStrings(linked.map((item) => item.dataset_slot));
    const expectedMetrics = uniqueStrings(linked.map((item) => item.metric_slot));

    if (!stringSetsEqual(gap.paper_ids, expectedPaperIds)) {
      reasons.push(`research_gap_evidence_paper_mismatch:${gap.gap_id}`);
    }
    if (!stringSetsEqual(gap.source_types, expectedSourceTypes)) {
      reasons.push(`research_gap_evidence_source_type_mismatch:${gap.gap_id}`);
    }
    if (!stringSetsEqual(gap.datasets, expectedDatasets)) {
      reasons.push(`research_gap_evidence_dataset_mismatch:${gap.gap_id}`);
    }
    if (!stringSetsEqual(gap.metrics, expectedMetrics)) {
      reasons.push(`research_gap_evidence_metric_mismatch:${gap.gap_id}`);
    }
    const expectedAbstractOnlyCount = expectedAbstractPaperIds.filter(
      (paperId) => !expectedFullTextPaperIds.includes(paperId)
    ).length;
    if (
      gap.support.distinct_paper_count !== expectedPaperIds.length ||
      gap.support.full_text_paper_count !== expectedFullTextPaperIds.length ||
      gap.support.abstract_only_paper_count !== expectedAbstractOnlyCount
    ) {
      reasons.push(`research_gap_evidence_support_mismatch:${gap.gap_id}`);
    }

    if (gap.epistemic_status !== "supported_candidate") {
      continue;
    }
    if (gapMap.construction_mode === "reviewed_semantic_synthesis") {
      const clusterKey = hashCanonical({
        statement: normalizeOptionalText(gap.statement) ?? "",
        evidence_ids: uniqueStrings(gap.evidence_links).sort(),
        opportunity_type: gap.opportunity_type ?? null
      });
      if (!reviewedClusterKeys.has(clusterKey)) {
        reasons.push(`research_gap_not_in_reviewed_synthesis:${gap.gap_id}`);
      }
      const canonicalWorkIds = uniqueStrings(
        linked
          .filter((item) => item.source_type === "full_text")
          .map((item) => normalizeOptionalText(item.canonical_work_id) ?? item.paper_id)
      );
      if (canonicalWorkIds.length < 2) {
        reasons.push(`research_gap_independent_work_support_missing:${gap.gap_id}`);
      }
      if (
        !gap.opportunity_type ||
        linked.some(
          (item) => !classifyResearchOpportunityEvidence(item).includes(gap.opportunity_type!)
        )
      ) {
        reasons.push(`research_gap_quality_eligibility_mismatch:${gap.gap_id}`);
      }
    }
  }
  return reasons;
}

function collectPriorAbsorptionProjectionReasons(
  candidate: TopicPortfolioCandidate,
  matrixContentSha256: string | undefined
): string[] {
  const projection = candidate.prior_absorption;
  if (!projection) {
    return [];
  }
  const reasons: string[] = [];
  const comparisonPriorIds = projection.comparisons.map((item) => item.prior_paper_id);
  const coverageComplete =
    projection.prior_paper_ids.length > 0
    && stringArraysEqual(projection.prior_paper_ids, candidate.closest_prior_paper_ids)
    && stringArraysEqual(comparisonPriorIds, candidate.closest_prior_paper_ids);
  const partialComplete = projection.comparisons.every(
    (comparison) =>
      comparison.reported_disposition !== "partially_absorbed"
      || comparison.disposition === "partially_absorbed"
  );
  const dispositionsEligible = projection.comparisons.every(
    (comparison) =>
      comparison.disposition === "non_overlapping"
      || comparison.disposition === "partially_absorbed"
  );
  const probeEligible =
    coverageComplete
    && projection.full_text_evidence_complete
    && projection.independent_evidence_complete
    && partialComplete
    && dispositionsEligible;
  if (projection.matrix_content_sha256 !== matrixContentSha256) {
    reasons.push(`topic_candidate_prior_absorption_matrix_hash_mismatch:${candidate.topic_id}`);
  }
  if (projection.coverage_complete !== coverageComplete) {
    reasons.push(`topic_candidate_prior_absorption_coverage_mismatch:${candidate.topic_id}`);
  }
  if (projection.partial_comparisons_complete !== partialComplete) {
    reasons.push(`topic_candidate_prior_absorption_partial_state_mismatch:${candidate.topic_id}`);
  }
  if (projection.probe_eligible !== probeEligible) {
    reasons.push(`topic_candidate_prior_absorption_eligibility_mismatch:${candidate.topic_id}`);
  }
  return reasons;
}

function expectedTopicCandidateGates(
  candidate: TopicPortfolioCandidate,
  topicMemoryDecision?: TopicMemoryDecision
): ResearchFunnelGate[] {
  const evidenceLinksResolve =
    candidate.evidence_links.length > 0 && candidate.unresolved_evidence_links.length === 0;
  const priorAbsorption = candidate.prior_absorption;
  const priorAbsorptionCoverageComplete = Boolean(
    priorAbsorption?.coverage_complete
    && stringArraysEqual(priorAbsorption.prior_paper_ids, candidate.closest_prior_paper_ids)
    && stringArraysEqual(
      priorAbsorption.comparisons.map((comparison) => comparison.prior_paper_id),
      candidate.closest_prior_paper_ids
    )
  );
  const candidatePriorSearchBinding = candidate.candidate_prior_search;
  const expectedPriorAbsorptionContract =
    buildPriorAbsorptionCandidateContract({
      id: candidate.source_candidate_id,
      text: candidate.statement,
      novelty: candidate.scores.novelty,
      feasibility: candidate.scores.feasibility,
      testability: candidate.scores.testability,
      cost: candidate.scores.cost,
      expected_gain: candidate.scores.expected_gain,
      evidence_links: candidate.evidence_links,
      contribution_claim: candidate.contribution_claim,
      dataset_task_bench: candidate.dataset_task_bench,
      comparator: candidate.comparator,
      primary_metric: candidate.primary_metric,
      effect_criterion: candidate.effect_criterion,
      meaningful_effect: candidate.meaningful_effect,
      minimum_publishable_evidence: candidate.minimum_publishable_evidence,
      falsifier: candidate.falsifier
    });
  const candidatePriorSearchLineageBound = Boolean(
    candidatePriorSearchBinding
    && isCandidatePriorSearchReviewBinding(candidatePriorSearchBinding)
    && candidatePriorSearchBinding.candidate_id === candidate.source_candidate_id
    && candidatePriorSearchBinding.prior_absorption_contract_sha256
      === expectedPriorAbsorptionContract.content_sha256
  );
  const selectedDirectPriorCoverageComplete = Boolean(
    candidatePriorSearchLineageBound
    && candidatePriorSearchBinding?.selected_direct_prior_ids.every(
      (paperId) =>
        candidate.closest_prior_paper_ids.includes(paperId)
        && candidate.closest_prior_full_text_paper_ids.includes(paperId)
        && priorAbsorption?.prior_paper_ids.includes(paperId)
        && priorAbsorption.comparisons.some(
          (comparison) => comparison.prior_paper_id === paperId
        )
    )
  );
  const computeBudgetValidation = validateTopicProbeComputeBudgetDeclaration(
    candidate.local_budget
  );
  const computeBudgetWithinCeiling = Boolean(
    candidate.brief_compute_budget_ceiling
    && computeBudgetValidation.limits
    && topicProbeComputeBudgetFitsWithin(
      computeBudgetValidation.limits,
      candidate.brief_compute_budget_ceiling
    )
  );
  return [
    gate(
      "evidence_axis_references_resolved",
      candidate.cluster_ids.length > 0
        && candidate.unresolved_cluster_ids.length === 0,
      "Candidate evidence-axis resolution is recomputed."
    ),
    requiredTextGate("gap_statement_present", candidate.gap_statement, "research gap statement"),
    gate(
      "supported_gap_reference_present",
      candidate.supported_gap_ids.length > 0,
      "Supported-gap reference presence is recomputed."
    ),
    gate("evidence_links_present", evidenceLinksResolve, "Evidence-link resolution is recomputed."),
    gate(
      "closest_prior_independent_support",
      uniqueStrings(candidate.closest_prior_paper_ids).length >= 2,
      "Closest-prior support is recomputed from distinct paper identifiers."
    ),
    gate(
      "closest_prior_full_text_support",
      uniqueStrings(candidate.closest_prior_full_text_paper_ids).length >= 2,
      "Full-text closest-prior support is recomputed from distinct paper identifiers."
    ),
    gate(
      "prior_absorption_matrix_bound",
      Boolean(priorAbsorption),
      "Prior-absorption matrix binding is recomputed."
    ),
    gate(
      "prior_absorption_prior_coverage_complete",
      priorAbsorptionCoverageComplete,
      "Prior-absorption closest-prior coverage is recomputed."
    ),
    gate(
      "prior_absorption_full_text_evidence_complete",
      Boolean(priorAbsorption?.full_text_evidence_complete),
      "Prior-absorption full-text evidence completeness is recomputed."
    ),
    gate(
      "prior_absorption_independent_evidence_complete",
      Boolean(priorAbsorption?.independent_evidence_complete),
      "Prior-absorption independent evidence completeness is recomputed."
    ),
    gate(
      "prior_absorption_partial_comparison_complete",
      Boolean(priorAbsorption?.partial_comparisons_complete),
      "Prior-absorption partial-comparison completeness is recomputed."
    ),
    gate(
      "prior_absorption_disposition_eligible",
      Boolean(priorAbsorptionCoverageComplete && priorAbsorption?.probe_eligible),
      "Prior-absorption disposition eligibility is recomputed."
    ),
    ...(candidatePriorSearchBinding
      ? [
          gate(
            "candidate_prior_search_lineage_bound",
            candidatePriorSearchLineageBound,
            "Candidate-prior search lineage is recomputed from the embedded binding."
          ),
          gate(
            "candidate_prior_search_selected_prior_coverage_complete",
            selectedDirectPriorCoverageComplete,
            "Selected direct-prior coverage is recomputed from closest-prior and absorption identifiers."
          )
        ]
      : []),
    requiredTextGate(
      "closest_prior_non_overlap_present",
      candidate.closest_prior_non_overlap,
      "non-overlap from the closest prior work"
    ),
    requiredTextGate(
      "reviewer_absorption_objection_present",
      candidate.reviewer_absorption_objection,
      "reviewer absorption objection"
    ),
    requiredTextGate("comparator_present", candidate.comparator, "baseline or comparator"),
    requiredTextGate("dataset_task_bench_present", candidate.dataset_task_bench, "dataset, task, or benchmark"),
    requiredTextGate("primary_metric_present", candidate.primary_metric, "primary metric"),
    requiredTextGate("metric_unit_present", candidate.metric_unit, "explicit metric unit"),
    gate(
      "metric_scale_valid",
      isExplicitMetricScale(candidate.metric_scale),
      "Observed metric-scale validity is recomputed independently of the effect scale."
    ),
    gate(
      "metric_direction_present",
      candidate.metric_direction === "maximize" || candidate.metric_direction === "minimize",
      "Primary-metric direction is recomputed."
    ),
    gate(
      "effect_criterion_valid",
      isEffectCriterion(candidate.effect_criterion),
      "Structured effect-criterion validity is recomputed."
    ),
    requiredTextGate("falsifier_present", candidate.falsifier, "falsifying outcome"),
    requiredTextGate("local_budget_present", candidate.local_budget, "bounded local budget"),
    gate(
      "compute_budget_declaration_valid",
      computeBudgetValidation.valid,
      computeBudgetValidation.valid
        ? "Two-stage compute-budget validity is recomputed."
        : `Two-stage compute-budget validity failed: ${computeBudgetValidation.reason}.`
    ),
    ...(candidate.brief_compute_budget_ceiling
      ? [gate(
          "compute_budget_within_brief_ceiling",
          computeBudgetWithinCeiling,
          "Candidate compute-budget compliance with its brief-owned ceiling is recomputed."
        )]
      : []),
    requiredTextGate("kill_signal_present", candidate.kill_signal, "kill signal"),
    requiredTextGate(
      "contribution_claim_present",
      candidate.contribution_claim,
      "specific contribution that survives the closest-prior and strongest-baseline objections"
    ),
    requiredTextGate(
      "minimum_publishable_evidence_present",
      candidate.minimum_publishable_evidence,
      "minimum publishable-evidence contract beyond a screening probe"
    ),
    gate(
      "topic_memory_clear_or_reentry_allowed",
      topicMemoryDecision?.disposition === "clear"
        || topicMemoryDecision?.disposition === "reentry_allowed",
      "Project topic-memory eligibility is recomputed from the embedded ledger snapshot."
    ),
    gate(
      "review_provenance_independent",
      candidate.review_status === "kept"
        || candidate.review_status === "rejected",
      "Independent review provenance eligibility is recomputed from the bound review disposition."
    ),
    gate("review_kept", candidate.review_status === "kept", "Independent review disposition is recomputed.")
  ];
}

function buildTopicDescriptorFromPortfolioCandidate(
  candidate: TopicPortfolioCandidate
): TopicFormulationDescriptor {
  return buildTopicFormulationDescriptor({
    statement: candidate.statement,
    gap_statement: candidate.gap_statement,
    contribution_claim: candidate.contribution_claim,
    dataset_task_bench: candidate.dataset_task_bench,
    comparator: candidate.comparator,
    primary_metric: candidate.primary_metric,
    metric_unit: candidate.metric_unit,
    meaningful_effect: candidate.meaningful_effect,
    minimum_publishable_evidence: candidate.minimum_publishable_evidence
  });
}

function deriveTopicCandidateObjectiveRaw(
  candidate: TopicPortfolioCandidate
): string | undefined {
  const primaryMetric = normalizeOptionalText(candidate.primary_metric);
  const metricUnit = normalizeOptionalText(candidate.metric_unit);
  const metricScale = isExplicitMetricScale(candidate.metric_scale) ? candidate.metric_scale : undefined;
  const comparator = normalizeOptionalText(candidate.comparator);
  const effectCriterion = parseEffectCriterion(candidate.effect_criterion);
  if (
    !primaryMetric
    || !metricUnit
    || !metricScale
    || !comparator
    || (candidate.metric_direction !== "maximize" && candidate.metric_direction !== "minimize")
    || !effectCriterion
  ) {
    return undefined;
  }
  return buildCandidateObjectiveRaw({
    primary_metric: primaryMetric,
    metric_unit: metricUnit,
    metric_scale: metricScale,
    metric_direction: candidate.metric_direction,
    comparator,
    effect_criterion: effectCriterion
  });
}

function expectedTopicPortfolioGates(portfolio: TopicPortfolio): ResearchFunnelGate[] {
  const probeCandidates = portfolio.candidates.filter(
    (candidate) => candidate.probe_status === "shortlisted"
  );
  const observed = portfolio.candidates.length + portfolio.overflow_candidates.length;
  const countInRange =
    observed >= TOPIC_PORTFOLIO_MIN_CANDIDATES && observed <= TOPIC_PORTFOLIO_MAX_CANDIDATES;
  const clusterCoverageComplete =
    collectDistinctClusterIds(portfolio.candidates).length >= TOPIC_PORTFOLIO_MIN_DISTINCT_CLUSTERS;
  const probeCandidatesEligible =
    probeCandidates.length > 0 && probeCandidates.every((candidate) => candidate.probe_eligible);
  const portfolioCandidatesAdmissible =
    portfolio.candidates.length > 0
    && portfolio.candidates.every(isTopicPortfolioCandidateDispositionAuditable);
  return [
    gate("gap_map_hash_bound", isSha256(portfolio.source_gap_map_sha256), "Gap-map binding is recomputed."),
    gate(
      "source_artifact_bindings_complete",
      hasCompleteArtifactBindingManifest(portfolio.source_artifacts, portfolio.source_artifact_bindings),
      "Required source artifact bindings are recomputed."
    ),
    gate(
      "prior_absorption_matrix_hash_bound",
      isSha256(portfolio.source_prior_absorption_matrix_sha256),
      "Prior-absorption matrix hash binding is recomputed."
    ),
    gate(
      "topic_memory_snapshot_valid",
      validateTopicMemoryLedger(portfolio.topic_memory_ledger).valid,
      "Project topic-memory snapshot validity is recomputed."
    ),
    gate("candidate_count_in_range", countInRange, "Candidate-count policy is recomputed."),
    gate(
      "evidence_axis_cluster_diversity",
      clusterCoverageComplete,
      "Evidence-axis cluster diversity is recomputed exclusively from candidate cluster identifiers."
    ),
    gate(
      "portfolio_candidates_admissible",
      portfolioCandidatesAdmissible,
      "Portfolio-wide candidate admissibility is recomputed."
    ),
    gate("probe_candidate_present", probeCandidates.length > 0, "Probe-candidate presence is recomputed."),
    gate(
      "probe_candidate_contract_complete",
      probeCandidatesEligible,
      "Probe-candidate eligibility is recomputed from candidate contracts."
    )
  ];
}

function collectGateIntegrityReasons(
  prefix: string,
  actual: ResearchFunnelGate[],
  expected: ResearchFunnelGate[]
): string[] {
  const reasons: string[] = [];
  const actualCodes = actual.map((item) => item.code);
  if (new Set(actualCodes).size !== actualCodes.length) {
    reasons.push(`${prefix}_duplicate_gate_code`);
  }
  const expectedByCode = new Map(expected.map((item) => [item.code, item.status] as const));
  const actualByCode = new Map(actual.map((item) => [item.code, item.status] as const));
  for (const [code, expectedStatus] of expectedByCode) {
    if (!actualByCode.has(code)) {
      reasons.push(`${prefix}_missing_gate:${code}`);
    } else if (actualByCode.get(code) !== expectedStatus) {
      reasons.push(`${prefix}_gate_status_mismatch:${code}`);
    }
  }
  for (const code of actualByCode.keys()) {
    if (!expectedByCode.has(code)) {
      reasons.push(`${prefix}_unexpected_gate:${code}`);
    }
  }
  return reasons;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isValidTopicScore(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 5;
}

function uniqueSourceTypes(items: HypothesisEvidenceSeed[]): Array<"full_text" | "abstract"> {
  const values = new Set<"full_text" | "abstract">();
  for (const item of items) {
    values.add(item.source_type === "full_text" ? "full_text" : "abstract");
  }
  return [...values].sort();
}


function normalizeGapIds(values: string[]): string[] {
  return uniqueStrings(values).sort((left, right) => left.localeCompare(right));
}

function normalizeArtifactBindings(
  bindings: ResearchFunnelArtifactBinding[]
): ResearchFunnelArtifactBinding[] {
  const order = new Map(
    RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS.map((artifactPath, index) => [artifactPath, index] as const)
  );
  return [...bindings].sort((left, right) => {
    const leftOrder = order.get(left.path) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = order.get(right.path) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.path.localeCompare(right.path);
  });
}

function hasCompleteArtifactBindingManifest(
  sourceArtifacts: string[],
  bindings: ResearchFunnelArtifactBinding[]
): boolean {
  return collectArtifactBindingManifestReasons({
    source_artifacts: sourceArtifacts,
    source_artifact_bindings: bindings
  }).length === 0;
}

function collectArtifactBindingManifestReasons(
  value: Pick<TopicPortfolio, "source_artifacts" | "source_artifact_bindings">
): string[] {
  const reasons: string[] = [];
  const expectedPaths = [...RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS];
  if (!stringArraysEqual(value.source_artifacts, expectedPaths)) {
    reasons.push("topic_portfolio_source_artifact_inventory_mismatch");
  }
  for (const artifactPath of value.source_artifacts) {
    if (!isPortableRelativeArtifactPath(artifactPath)) {
      reasons.push(`topic_portfolio_source_artifact_path_not_portable:${artifactPath}`);
    }
  }

  const bindingPaths = value.source_artifact_bindings.map((binding) => binding.path);
  if (new Set(bindingPaths).size !== bindingPaths.length) {
    reasons.push("topic_portfolio_duplicate_source_binding_path");
  }
  if (!stringArraysEqual(bindingPaths, expectedPaths)) {
    reasons.push("topic_portfolio_source_binding_inventory_mismatch");
  }
  for (const artifactPath of expectedPaths) {
    const binding = value.source_artifact_bindings.find((item) => item.path === artifactPath);
    if (!binding) {
      reasons.push(`topic_portfolio_source_binding_missing:${artifactPath}`);
      continue;
    }
    if (!isPortableRelativeArtifactPath(binding.path)) {
      reasons.push(`topic_portfolio_source_binding_path_not_portable:${binding.path}`);
    }
    if (!isSha256(binding.sha256)) {
      reasons.push(`topic_portfolio_source_binding_sha256_invalid:${artifactPath}`);
    }
    if (!Number.isInteger(binding.byte_length) || binding.byte_length < 0) {
      reasons.push(`topic_portfolio_source_binding_byte_length_invalid:${artifactPath}`);
    }
  }
  for (const artifactPath of bindingPaths) {
    if (!expectedPaths.includes(artifactPath)) {
      reasons.push(`topic_portfolio_source_binding_unexpected:${artifactPath}`);
    }
  }
  return uniqueStrings(reasons);
}

function isPortableRelativeArtifactPath(value: string): boolean {
  return (
    Boolean(value)
    && !value.startsWith("/")
    && !value.includes("\\")
    && value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== "..")
  );
}

function normalizeResearchCycle(value: unknown): number {
  return isValidResearchCycle(value) ? value : -1;
}

function normalizeArtifactByteLength(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : -1;
}

function isValidResearchCycle(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function hashArtifactBytes(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
function normalizeClusterIds(values: string[]): string[] {
  return uniqueStrings(values).sort((left, right) => left.localeCompare(right));
}

function collectDistinctClusterIds(candidates: TopicPortfolioCandidate[]): string[] {
  return normalizeClusterIds(candidates.flatMap((candidate) => candidate.cluster_ids));
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => normalizeOptionalText(value)).filter((value): value is string => Boolean(value)))];
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function validateTopicProbeComputeBudgetDeclaration(
  value: unknown
): { valid: boolean; reason: string; limits?: TopicProbeComputeBudgetLimits } {
  const budget = normalizeOptionalText(value);
  if (!budget) {
    return { valid: false, reason: "declaration_missing" };
  }
  try {
    const limits = parseTopicProbeComputeBudgetDeclaration(budget);
    return { valid: true, reason: "valid", limits };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : "declaration_invalid"
    };
  }
}


function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function normalizeGroupingKey(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function isNonLimitation(value: string): boolean {
  return /^(?:none|n\/a|not (?:reported|specified|available)|unknown|no limitations?)\.?$/iu.test(value);
}

function isResearchGapMap(value: unknown): value is ResearchGapMap {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<ResearchGapMap>;
  return (
    item.schema_version === 1 &&
    item.artifact_kind === "research_gap_evidence_map" &&
    item.semantics_version === RESEARCH_GAP_MAP_SEMANTICS_VERSION &&
    item.epistemic_status === "candidate_evidence_map" &&
    [
      "legacy_exact_grouping",
      "reviewed_semantic_synthesis",
      "deterministic_safe_fallback",
      "deferred_partial_analysis"
    ].includes(String(item.construction_mode)) &&
    (item.synthesis_binding === undefined || isResearchGapSynthesisBinding(item.synthesis_binding)) &&
    isResearchGapAnalysisCoverage(item.analysis_coverage) &&
    typeof item.run_id === "string" &&
    typeof item.research_cycle === "number" &&
    Number.isInteger(item.research_cycle) &&
    typeof item.collect_attempt_id === "string" &&
    typeof item.corpus_sha256 === "string" &&
    typeof item.corpus_byte_length === "number" &&
    Number.isInteger(item.corpus_byte_length) &&
    typeof item.evidence_sha256 === "string" &&
    typeof item.evidence_byte_length === "number" &&
    Number.isInteger(item.evidence_byte_length) &&
    typeof item.generated_at === "string" &&
    isStringArray(item.source_artifacts) &&
    Array.isArray(item.gaps) &&
    item.gaps.every((gap) =>
      Boolean(gap) &&
      typeof gap.gap_id === "string" &&
      (gap.construction_origin === "reviewed_cluster" || gap.construction_origin === "exact_grouping") &&
      (gap.opportunity_type === undefined || isResearchOpportunityType(gap.opportunity_type)) &&
      (gap.construction_origin !== "reviewed_cluster" || gap.opportunity_type !== undefined) &&
      typeof gap.statement === "string" &&
      isStringArray(gap.evidence_links) &&
      isStringArray(gap.paper_ids) &&
      Array.isArray(gap.source_types) &&
      gap.source_types.every((sourceType) => sourceType === "full_text" || sourceType === "abstract") &&
      isStringArray(gap.datasets) &&
      isStringArray(gap.metrics) &&
      isResearchGapSupport(gap.support) &&
      ["supported_candidate", "provisional_candidate"].includes(String(gap.epistemic_status)) &&
      Array.isArray(gap.gates) &&
      gap.gates.every(isResearchFunnelGate)
    ) &&
    Array.isArray(item.gates) &&
    item.gates.every(isResearchFunnelGate) &&
    isSha256(item.content_sha256)
  );
}
function isResearchGapSynthesisBinding(
  value: unknown
): value is NonNullable<ResearchGapMap["synthesis_binding"]> {
  return isRecord(value) &&
    isSha256(value.content_sha256) &&
    typeof value.semantics_version === "number" &&
    Number.isInteger(value.semantics_version) &&
    (value.status === "completed" || value.status === "safe_fallback");
}

function isResearchGapAnalysisCoverage(
  value: unknown
): value is ResearchGapMap["analysis_coverage"] {
  return isRecord(value) &&
    typeof value.selected_paper_count === "number" &&
    Number.isInteger(value.selected_paper_count) &&
    value.selected_paper_count >= 0 &&
    typeof value.completed_paper_count === "number" &&
    Number.isInteger(value.completed_paper_count) &&
    value.completed_paper_count >= 0 &&
    value.completed_paper_count <= value.selected_paper_count &&
    isStringArray(value.failed_paper_ids) &&
    typeof value.complete === "boolean";
}

function isResearchGapSupport(value: unknown): value is ResearchGapCandidate["support"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const item = value as Partial<ResearchGapCandidate["support"]>;
  return [
    item.distinct_paper_count,
    item.full_text_paper_count,
    item.abstract_only_paper_count
  ].every(
    (count) =>
      typeof count === "number"
      && Number.isInteger(count)
      && count >= 0
  );
}


const TOPIC_PORTFOLIO_CANDIDATE_FIELDS = new Set([
  "topic_id",
  "topic_lineage_id",
  "formulation_id",
  "formulation_version",
  "source_candidate_id",
  "statement",
  "gap_statement",
  "supported_gap_ids",
  "evidence_links",
  "cluster_ids",
  "unresolved_cluster_ids",
  "closest_prior_paper_ids",
  "unresolved_evidence_links",
  "comparator",
  "candidate_prior_search",
  "prior_absorption",
  "closest_prior_full_text_paper_ids",
  "closest_prior_non_overlap",
  "reviewer_absorption_objection",
  "dataset_task_bench",
  "primary_metric",
  "metric_unit",
  "metric_scale",
  "metric_direction",
  "meaningful_effect",
  "effect_criterion",
  "objective_raw",
  "falsifier",
  "local_budget",
  "brief_compute_budget_ceiling",
  "kill_signal",
  "contribution_claim",
  "minimum_publishable_evidence",
  "review_status",
  "probe_status",
  "review_summary",
  "topic_memory",
  "scores",
  "gates",
  "probe_eligible",
  "content_sha256"
]);

const TOPIC_DECISION_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "run_id",
  "research_cycle",
  "generated_at",
  "portfolio_content_sha256",
  "probe_candidate_ids",
  "probe_topic_ids",
  "disposition",
  "probe_allowed",
  "reason_codes",
  "content_sha256"
]);

const TOPIC_PORTFOLIO_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "run_id",
  "research_cycle",
  "generated_at",
  "source_artifacts",
  "source_artifact_bindings",
  "source_gap_map_sha256",
  "source_prior_absorption_matrix_sha256",
  "topic_memory_ledger",
  "candidate_policy",
  "candidates",
  "overflow_candidates",
  "cluster_policy",
  "probe_candidate_ids",
  "probe_topic_ids",
  "gates",
  "probe_allowed",
  "content_sha256"
]);
function isTopicPortfolioCandidate(value: unknown): value is TopicPortfolioCandidate {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<TopicPortfolioCandidate>;
  const scores = item.scores as Partial<TopicPortfolioCandidate["scores"]> | undefined;
  return (
    typeof item.topic_id === "string" &&
    (item.topic_lineage_id === undefined || typeof item.topic_lineage_id === "string") &&
    (item.formulation_id === undefined || typeof item.formulation_id === "string") &&
    (item.formulation_version === undefined
      || (typeof item.formulation_version === "number"
        && Number.isInteger(item.formulation_version)
        && item.formulation_version > 0)) &&
    typeof item.source_candidate_id === "string" &&
    (item.contribution_claim === undefined || typeof item.contribution_claim === "string") &&
    (item.minimum_publishable_evidence === undefined || typeof item.minimum_publishable_evidence === "string") &&
    (item.metric_unit === undefined || typeof item.metric_unit === "string") &&
    (item.metric_scale === undefined || isExplicitMetricScale(item.metric_scale)) &&
    (item.metric_direction === undefined || item.metric_direction === "maximize" || item.metric_direction === "minimize") &&
    (item.meaningful_effect === undefined || typeof item.meaningful_effect === "string") &&
    (item.effect_criterion === undefined || isEffectCriterion(item.effect_criterion)) &&
    (item.brief_compute_budget_ceiling === undefined
      || isTopicProbeComputeBudgetLimits(item.brief_compute_budget_ceiling)) &&
    (item.objective_raw === undefined || typeof item.objective_raw === "string") &&
    typeof item.statement === "string" &&
    isStringArray(item.supported_gap_ids) &&
    isStringArray(item.cluster_ids) &&
    isStringArray(item.unresolved_cluster_ids) &&
    isStringArray(item.evidence_links) &&
    isStringArray(item.unresolved_evidence_links) &&
    isStringArray(item.closest_prior_paper_ids) &&
    ["kept", "rejected", "not_reviewed"].includes(String(item.review_status)) &&
    (item.candidate_prior_search === undefined
      || isCandidatePriorSearchReviewBinding(item.candidate_prior_search)) &&
    (item.prior_absorption === undefined || isPriorAbsorptionCandidateProjection(item.prior_absorption)) &&
    isStringArray(item.closest_prior_full_text_paper_ids) &&
    ["shortlisted", "not_shortlisted"].includes(String(item.probe_status)) &&
    (item.topic_memory === undefined || isTopicMemoryProjection(item.topic_memory)) &&
    Boolean(scores) &&
    [scores?.novelty, scores?.feasibility, scores?.testability, scores?.cost, scores?.expected_gain].every(
      (score) => typeof score === "number" && Number.isFinite(score)
    ) &&
    Array.isArray(item.gates) &&
    item.gates.every(isResearchFunnelGate) &&
    typeof item.probe_eligible === "boolean" &&
    hasOnlyKnownFields(value, TOPIC_PORTFOLIO_CANDIDATE_FIELDS) &&
    isSha256(item.content_sha256)
  );
}

function isResearchFunnelGate(value: unknown): value is ResearchFunnelGate {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<ResearchFunnelGate>;
  return typeof item.code === "string" && ["pass", "block"].includes(String(item.status)) && typeof item.message === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTopicMemoryProjection(
  value: unknown
): value is NonNullable<TopicPortfolioCandidate["topic_memory"]> {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isSha256(value.ledger_sha256)
    && (value.descriptor === undefined || isRecord(value.descriptor))
    && (value.reentry_ticket === undefined || isRecord(value.reentry_ticket))
    && (value.semantic_audit === undefined || isRecord(value.semantic_audit))
    && isRecord(value.decision)
    && hasOnlyKnownFields(
      value,
      new Set([
        "ledger_sha256",
        "descriptor",
        "reentry_ticket",
        "semantic_audit",
        "decision"
      ])
    )
  );
}

function isTopicDecision(value: unknown): value is TopicDecision {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<TopicDecision>;
  return (
    item.schema_version === 1 &&
    item.artifact_kind === "research_topic_probe_authorization" &&
    typeof item.run_id === "string" &&
    typeof item.research_cycle === "number" &&
    Number.isInteger(item.research_cycle) &&
    typeof item.generated_at === "string" &&
    (item.portfolio_content_sha256 === undefined || isSha256(item.portfolio_content_sha256)) &&
    isStringArray(item.probe_candidate_ids) &&
    isStringArray(item.probe_topic_ids) &&
    ["probe_authorized", "backtrack_to_hypotheses"].includes(String(item.disposition)) &&
    typeof item.probe_allowed === "boolean" &&
    hasOnlyKnownFields(value, TOPIC_DECISION_FIELDS) &&
    isStringArray(item.reason_codes) &&
    isSha256(item.content_sha256)
  );
}

const RESEARCH_FUNNEL_ARTIFACT_BINDING_FIELDS = new Set(["path", "sha256", "byte_length"]);

function isResearchFunnelArtifactBindingShape(value: unknown): value is ResearchFunnelArtifactBinding {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.path === "string" && hasOnlyKnownFields(value, RESEARCH_FUNNEL_ARTIFACT_BINDING_FIELDS);
}

function isTopicPortfolio(value: unknown): value is TopicPortfolio {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<TopicPortfolio>;
  const policy = item.candidate_policy as Partial<TopicPortfolio["candidate_policy"]> | undefined;
  const clusterPolicy = item.cluster_policy as Partial<TopicPortfolio["cluster_policy"]> | undefined;
  return (
    item.schema_version === 1 &&
    item.artifact_kind === "research_topic_portfolio" &&
    typeof item.run_id === "string" &&
    typeof item.research_cycle === "number" &&
    Number.isInteger(item.research_cycle) &&
    typeof item.generated_at === "string" &&
    isSha256(item.content_sha256) &&
    typeof item.probe_allowed === "boolean" &&
    isStringArray(item.source_artifacts) &&
    Array.isArray(item.source_artifact_bindings) &&
    item.source_artifact_bindings.every(isResearchFunnelArtifactBindingShape) &&
    (item.source_gap_map_sha256 === undefined || typeof item.source_gap_map_sha256 === "string") &&
    (item.source_prior_absorption_matrix_sha256 === undefined || typeof item.source_prior_absorption_matrix_sha256 === "string") &&
    (item.topic_memory_ledger === undefined || isRecord(item.topic_memory_ledger)) &&
    Array.isArray(item.candidates) &&
    item.candidates.every(isTopicPortfolioCandidate) &&
    Array.isArray(item.overflow_candidates) &&
    item.overflow_candidates.every(
      (candidate) =>
        Boolean(candidate) && typeof candidate.source_candidate_id === "string" && candidate.reason === "portfolio_maximum_exceeded"
    ) &&
    isStringArray(item.probe_candidate_ids) &&
    isStringArray(item.probe_topic_ids) &&
    Array.isArray(item.gates) &&
    item.gates.every(isResearchFunnelGate) &&
    Boolean(policy) &&
    [policy?.minimum, policy?.maximum, policy?.observed].every((count) => typeof count === "number" && Number.isInteger(count)) &&
    Boolean(clusterPolicy) &&
    [clusterPolicy?.minimum_distinct_nonempty, clusterPolicy?.observed_distinct_nonempty].every(
      (count) => typeof count === "number" && Number.isInteger(count) && count >= 0
    ) &&
    hasOnlyKnownFields(value, TOPIC_PORTFOLIO_FIELDS)
  );
}

function hasOnlyKnownFields(value: object, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}
