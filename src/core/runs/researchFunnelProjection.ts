import { promises as fs } from "node:fs";
import path from "node:path";

import {
  validateActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "../activeTopicProbeContract.js";
import {
  hashCanonical,
  validateResearchGapMapArtifact,
  validateResearchFunnelClosedChain,
  type ResearchFunnelGate,
  type ResearchGapMap,
  type TopicPortfolio,
  type TopicDecision
} from "../researchFunnel.js";
import { parseAnalysisReport } from "../resultAnalysis.js";
import {
  buildResearchGapEvidenceChain,
  type ResearchGapEvidenceAudit
} from "../analysis/researchGapEvidenceChain.js";
import {
  loadTopicProbeOutcomeArtifacts
} from "../topicProbeOutcomeArtifacts.js";
import {
  validateTopicProbeFollowupHandoff,
  type TopicProbeFollowupEvidenceStage,
  type TopicProbeFollowupHandoff,
  type TopicProbeFollowupMode
} from "../topicProbeFollowup.js";
import {
  validateTopicProbeReviewGate,
  type TopicProbeReviewGateStatus
} from "../topicProbeReviewGate.js";
import type {
  TopicProbeOutcomeDecision,
  TopicProbeOutcomeDisposition,
  TopicProbeOutcomeNextAction
} from "../topicProbeOutcome.js";
import {
  validateVenueViabilityReport,
  VENUE_VIABILITY_REPORT_RELATIVE_PATH
} from "../venueViability.js";
import {
  parseResearchRunMode,
  type ResearchRunMode
} from "./runBriefParser.js";
import type { EffectCriterion } from "../effectCriterion.js";
import {
  TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
  TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
} from "../topicDiscoveryScientificTerms.js";
import {
  TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY,
  TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION
} from "../collection/topicDiscoveryCorpusQuality.js";
import { validateTopicDiscoveryCollectionAuthorizationLineage } from "./topicDiscoveryCollectionLineage.js";
import {
  validateCandidatePriorSearchPlanIntegrity,
  validateCandidatePriorSearchReceipt,
  type CandidatePriorSearchPlan,
  type CandidatePriorSearchReceipt
} from "../candidatePriorSearch.js";
import {
  ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH,
  ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH,
  ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH,
  loadPersistedEstimatorFeasibilityAudit
} from "../estimatorFeasibilityGate.js";
import {
  composeTopicProbeExecutionAuthorization,
  type TopicProbeExecutionAuthorization
} from "../topicProbeExecutionAuthorization.js";

export type ResearchFunnelIntegrityStatus = "unmeasured" | "partial" | "complete" | "mismatch";
export type ResearchFunnelAuthorizationDisposition = TopicDecision["disposition"] | "unmeasured";
export type ResearchFunnelLifecycleStage =
  | "discovery"
  | "probe_authorized"
  | "outcome_decided"
  | "followup_required"
  | "reviewed"
  | "invalid_chain";

export type ResearchFunnelCollectionState =
  | "unmeasured"
  | "collecting"
  | "quality_gate_failed"
  | "quality_gate_exhausted"
  | "quality_gate_passed"
  | "failed";

export type ResearchFunnelCollectionFailureClass =
  | "query_quality_failure"
  | "semantic_review_operational_failure"
  | "semantic_review_incomplete";

export type ResearchFunnelSemanticReviewStatus =
  | "complete"
  | "partial"
  | "operational_failure";

export interface ResearchFunnelProjectionHashes {
  gapMap?: string;
  topicPortfolio?: string;
  topicDecision?: string;
  activeTopicProbeContract?: string;
  topicProbeOutcome?: string;
  topicProbeOutcomeGate?: string;
  venueViability?: string;
  topicProbeFollowupHandoff?: string;
  topicProbeReviewGate?: string;
}

export interface ResearchFunnelProjectionArtifactRef {
  label: string;
  path: string;
}

export interface ResearchFunnelTopicMemoryProjection {
  status: "unmeasured" | "verified" | "blocked";
  trusted: boolean;
  ledgerHash?: string;
  recordCount: number;
  blockedCandidateCount: number;
  reentryRequiredCount: number;
  reentryAllowedCount: number;
  auditArtifactRef?: ResearchFunnelProjectionArtifactRef;
  updateArtifactRef?: ResearchFunnelProjectionArtifactRef;
}

export interface ResearchFunnelCandidatePriorSearchProjection {
  status: "unmeasured" | "search_required" | "complete" | "exhausted" | "blocked";
  trusted: boolean;
  action?:
    | "request_collection"
    | "already_searched"
    | "exhausted"
    | "not_required"
    | "blocked_invalid_lineage";
  completedRounds: number;
  maxRounds: number;
  currentReceiptStatus: "unmeasured" | "not_applicable" | "valid" | "invalid";
  candidateCount: number;
  selectedCandidateCount: number;
  broadLaneAttemptCount: number;
  recentLaneAttemptCount: number;
  fetchedCount: number;
  selectedPaperCount: number;
  coveredCandidateIds: string[];
  planHash?: string;
  receiptHash?: string;
  reasonCodes: string[];
  artifactRefs: ResearchFunnelProjectionArtifactRef[];
}

export interface ResearchFunnelEstimatorFeasibilityProjection {
  status: "unmeasured" | "pass" | "blocked" | "invalid";
  trusted: boolean;
  executionAuthorized: boolean;
  estimandType?: string;
  estimatorFamily?: string;
  independentClusterCount?: number;
  primaryDenominator?: number;
  attainableResolution?: number;
  plannedMinimumDetectableEffect?: number;
  computedMinimumDetectableEffect?: number;
  reasonCodes: string[];
  artifactRefs: ResearchFunnelProjectionArtifactRef[];
}

export interface ResearchFunnelCandidateProjection {
  rank: number;
  candidateId: string;
  topicId: string;
  statement: string;
  trusted: boolean;
  reviewStatus: "kept" | "rejected" | "not_reviewed";
  probeStatus: "shortlisted" | "not_shortlisted";
  probeEligible: boolean;
  scores: TopicPortfolio["candidates"][number]["scores"];
  closestPriorPaperIds: string[];
  closestPriorFullTextPaperIds: string[];
  priorAbsorptionComparisons: Array<{
    priorPaperId: string;
    disposition: "absorbed" | "partially_absorbed" | "non_overlapping" | "uncertain";
  }>;
  priorAbsorptionReasonCodes: string[];
  closestPriorNonOverlap?: string;
  reviewerAbsorptionObjection?: string;
  comparator?: string;
  datasetTaskBench?: string;
  primaryMetric?: string;
  localBudget?: string;
  killSignal?: string;
  contributionClaim?: string;
  minimumPublishableEvidence?: string;
  reviewSummary?: string;
  topicMemoryDisposition?:
    | "clear"
    | "blocked"
    | "requires_reentry_adjudication"
    | "reentry_allowed";
  topicMemoryMaximumLineageSimilarity?: number;
  blockedGateCodes: string[];
}

export interface ResearchFunnelGateProjection {
  scope: "gap_map" | "gap_candidate" | "topic_portfolio" | "topic_candidate";
  code: string;
  status: ResearchFunnelGate["status"];
  message: string;
  trusted: boolean;
  candidateId?: string;
}

export interface ResearchFunnelDissentProjection {
  source: "portfolio_review" | "design_panel";
  candidateId: string;
  hardBlock: boolean;
  summary: string;
  findings: string[];
  trusted: boolean;
  reviewerId?: string;
  reviewerLabel?: string;
}

export interface ResearchFunnelLiteratureQueryProjection {
  query: string;
  source: "requested_query" | "llm_query_planner" | "deterministic_query" | "unknown";
  sourceReason: string;
  reason: string;
  fallback: boolean;
  filtersRelaxed: boolean;
  allocatedLimit?: number;
  retrievalLimit?: number;
  fetched?: number;
  relevantFetched?: number;
  selected?: number;
}

export interface ResearchFunnelReformulationHintProjection {
  evidenceStatus: "query_hint_only";
  paperEvidenceAllowed: false;
  active: boolean;
  failureClass: ResearchFunnelCollectionFailureClass;
  feedbackApplied: boolean;
  semanticReviewStatus: ResearchFunnelSemanticReviewStatus;
  sharedAnchorTerms: string[];
  candidateTitles: string[];
  axes: Array<{
    queryFamily?: string;
    query?: string;
    axisTerms: string[];
    relevantPaperCount?: number;
  }>;
  artifactRef?: ResearchFunnelProjectionArtifactRef;
}

export interface ResearchFunnelOutcomeGateProjection {
  status: "unmeasured" | "decided" | "blocked_invalid_artifact_chain" | "invalid";
  trusted: boolean;
  reasonCodes: string[];
  contentHash?: string;
  artifactRef?: ResearchFunnelProjectionArtifactRef;
}

export interface ResearchFunnelFollowupHandoffProjection {
  status: "unmeasured" | "ready" | "invalid";
  trusted: boolean;
  recommendedFollowupMode?: TopicProbeFollowupMode;
  evidenceStage?: TopicProbeFollowupEvidenceStage;
  contentHash?: string;
  artifactRef?: ResearchFunnelProjectionArtifactRef;
}

export interface ResearchFunnelReviewGateProjection {
  status: "unmeasured" | TopicProbeReviewGateStatus | "invalid";
  trusted: boolean;
  paperDraftingAllowed: false;
  reasonCodes: string[];
  contentHash?: string;
  artifactRef?: ResearchFunnelProjectionArtifactRef;
}

export interface ResearchFunnelProjection {
  researchMode: "topic_discovery";
  lifecycleStage: ResearchFunnelLifecycleStage;
  boundedProbePaperEvidenceAllowed: false;
  collectionState: ResearchFunnelCollectionState;
  collectionNodeAttempt?: number;
  collectionNodeMaxAttempts?: number;
  queryPlanAttempt?: number;
  collectionQualityFailureReasons: string[];
  collectionReformulationHint?: ResearchFunnelReformulationHintProjection;
  gapEvidenceAudit: ResearchGapEvidenceAudit & {
    status: "unmeasured" | "verified" | "blocked";
    constructionMode?: ResearchGapMap["construction_mode"];
    synthesisStatus?: "completed" | "safe_fallback";
    analysisCoverage?: ResearchGapMap["analysis_coverage"];
  };
  candidateCount: number;
  clusterCount: number;
  candidatePriorSearch: ResearchFunnelCandidatePriorSearchProjection;
  estimatorFeasibility: ResearchFunnelEstimatorFeasibilityProjection;
  topicMemory: ResearchFunnelTopicMemoryProjection;
  diagnosticsTrusted: boolean;
  authorizationTrusted: boolean;
  portfolioCandidates: ResearchFunnelCandidateProjection[];
  probeCandidateCount: number;
  probeCandidateIds: string[];
  probeCandidateStatements: string[];
  activeCandidateId?: string;
  activeTopicId?: string;
  activeCandidateHash?: string;
  activePrimaryMetric?: string;
  activeMetricUnit?: string;
  activeMetricScale?: ActiveTopicProbeContract["metric_scale"];
  activeMetricDirection?: ActiveTopicProbeContract["metric_direction"];
  activeEffectCriterion?: EffectCriterion;
  activeObjectiveRaw?: string;
  activeMeaningfulEffect?: string;
  activeEvidenceStage?: ActiveTopicProbeContract["evidence_stage"];
  activeDeferredCandidateIds?: string[];
  authorizationDisposition: ResearchFunnelAuthorizationDisposition;
  authorizationProbeAllowed: boolean;
  effectiveExecutionAuthorized: boolean;
  executionAuthorization: TopicProbeExecutionAuthorization;
  outcomeDisposition?: TopicProbeOutcomeDisposition;
  outcomeNextAction?: TopicProbeOutcomeNextAction;
  outcomeGate: ResearchFunnelOutcomeGateProjection;
  venueViability: {
    status: "unmeasured" | "trusted" | "invalid";
    trusted: boolean;
    candidateViability?: "continue" | "pivot" | "kill" | "blocked";
    currentEvidenceCeiling?: "screening_only";
    topTierReadiness?: "blocked" | "unresolved";
    confirmatoryCandidacy?: "supported" | "unsupported" | "unresolved";
    declaredComparatorEffectGate?: "passed" | "failed" | "unresolved" | "invalid";
    topTierReady: false;
    acceptanceLikelihoodAssessed: false;
    reasonCodes: string[];
    requiredUpgrades: string[];
    contentHash?: string;
    artifactRef?: ResearchFunnelProjectionArtifactRef;
  };
  followupHandoff: ResearchFunnelFollowupHandoffProjection;
  reviewGate: ResearchFunnelReviewGateProjection;
  invalidChainBlockers: string[];
  reasonCodes: string[];
  gates: ResearchFunnelGateProjection[];
  dissent: ResearchFunnelDissentProjection[];
  literatureQueries: ResearchFunnelLiteratureQueryProjection[];
  queryFallbackUsed: boolean;
  queryFallbackReasons: string[];
  hashes: ResearchFunnelProjectionHashes;
  artifactRefs: ResearchFunnelProjectionArtifactRef[];
  integrityStatus: ResearchFunnelIntegrityStatus;
}

export interface ResearchFunnelProjectionContext {
  runId?: string;
  researchCycle?: number;
  researchMode?: ResearchRunMode;
}

const ARTIFACTS = {
  gapMap: {
    label: "Research gap map",
    path: "analysis/gap_map.json",
    readErrorPrefix: "research_gap_map"
  },
  gapSynthesis: {
    label: "Reviewed research gap synthesis",
    path: "analysis/gap_synthesis.json",
    readErrorPrefix: "research_gap_synthesis"
  },
  evidenceStore: {
    label: "Research evidence store",
    path: "evidence_store.jsonl",
    readErrorPrefix: "research_gap_evidence_store"
  },
  corpus: {
    label: "Research corpus",
    path: "corpus.jsonl",
    readErrorPrefix: "research_gap_corpus"
  },
  collectGeneration: {
    label: "Literature collection generation",
    path: "collect_generation.json",
    readErrorPrefix: "research_gap_collect_generation"
  },
  topicPortfolio: {
    label: "Topic portfolio",
    path: "hypothesis_generation/topic_portfolio.json",
    readErrorPrefix: "topic_portfolio"
  },
  topicMemoryAudit: {
    label: "Topic memory audit",
    path: "hypothesis_generation/topic_memory_audit.json",
    readErrorPrefix: "topic_memory_audit"
  },
  topicMemoryUpdate: {
    label: "Topic memory update",
    path: "analysis/topic_memory_update.json",
    readErrorPrefix: "topic_memory_update"
  },
  topicDecision: {
    label: "Topic decision",
    path: "design_experiments_panel/topic_decision.json",
    readErrorPrefix: "topic_decision"
  },
  activeTopicProbeContract: {
    label: "Active topic probe contract",
    path: "design_experiments_panel/active_topic_probe_contract.json",
    readErrorPrefix: "active_topic_probe_contract"
  },
  resultAnalysis: {
    label: "Analysis report",
    path: "result_analysis.json",
    readErrorPrefix: "topic_probe_result_analysis"
  },
  topicProbeOutcome: {
    label: "Topic probe outcome",
    path: "analysis/topic_probe_outcome.json",
    readErrorPrefix: "topic_probe_outcome"
  },
  topicProbeOutcomeGate: {
    label: "Topic probe outcome gate",
    path: "analysis/topic_probe_outcome_gate.json",
    readErrorPrefix: "topic_probe_outcome_gate"
  },
  venueViability: {
    label: "Venue viability",
    path: VENUE_VIABILITY_REPORT_RELATIVE_PATH,
    readErrorPrefix: "venue_viability"
  },
  topicProbeFollowupHandoff: {
    label: "Topic probe follow-up handoff",
    path: "review/topic_probe_followup_handoff.json",
    readErrorPrefix: "topic_probe_followup_handoff"
  },
  topicProbeReviewGate: {
    label: "Topic probe review gate",
    path: "review/topic_probe_gate.json",
    readErrorPrefix: "topic_probe_review_gate"
  },
  collectResult: {
    label: "Literature collection result",
    path: "collect_result.json",
    readErrorPrefix: "collect_result"
  },
  collectCorpusQuality: {
    label: "Literature collection quality audit",
    path: "collect_corpus_quality.json",
    readErrorPrefix: "collect_corpus_quality"
  },
  collectSemanticReviewInput: {
    label: "Literature semantic review input",
    path: "collect_semantic_review_input.json",
    readErrorPrefix: "collect_semantic_review_input"
  },
  collectSemanticReview: {
    label: "Literature semantic review judgment",
    path: "collect_semantic_review.json",
    readErrorPrefix: "collect_semantic_review"
  },
  collectTopicDiscoveryCandidates: {
    label: "Literature topic discovery candidates",
    path: "collect_topic_discovery_candidates.jsonl",
    readErrorPrefix: "collect_topic_discovery_candidates"
  },
  collectQueryPlan: {
    label: "Literature query plan",
    path: "collect_query_plan.json",
    readErrorPrefix: "collect_query_plan"
  },
  collectQueryReformulationHints: {
    label: "Literature query reformulation hints",
    path: "collect_query_reformulation_hints.json",
    readErrorPrefix: "collect_query_reformulation_hints"
  },
  designReviews: {
    label: "Experiment design panel reviews",
    path: "design_experiments_panel/reviews.json",
    readErrorPrefix: "design_panel_reviews"
  },
  candidatePriorSearchDecision: {
    label: "Candidate direct-prior search decision",
    path: "hypothesis_generation/candidate_prior_search_decision.json",
    readErrorPrefix: "candidate_prior_search_decision"
  },
  candidatePriorSearchPendingPlan: {
    label: "Candidate direct-prior pending plan",
    path: "hypothesis_generation/candidate_prior_search_plan.json",
    readErrorPrefix: "candidate_prior_search_pending_plan"
  },
  candidatePriorSearchCollectPlan: {
    label: "Candidate direct-prior collection plan",
    path: "collect_candidate_prior_search_plan.json",
    readErrorPrefix: "candidate_prior_search_collect_plan"
  },
  candidatePriorSearchReceipt: {
    label: "Candidate direct-prior search receipt",
    path: "collect_candidate_prior_search_receipt.json",
    readErrorPrefix: "candidate_prior_search_receipt"
  },
  estimatorCandidateExperimentContract: {
    label: "Non-executable candidate experiment contract",
    path: ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH,
    readErrorPrefix: "estimator_candidate_experiment_contract"
  },
  estimatorContract: {
    label: "Estimator feasibility contract",
    path: ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH,
    readErrorPrefix: "estimator_feasibility_contract"
  },
  estimatorReport: {
    label: "Estimator feasibility report",
    path: ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH,
    readErrorPrefix: "estimator_feasibility_report"
  },
  executableExperimentContract: {
    label: "Executable experiment contract",
    path: "experiment_contract.json",
    readErrorPrefix: "executable_experiment_contract"
  }
} as const;

const SOURCE_ARTIFACTS = {
  evidenceAxes: {
    path: "hypothesis_generation/evidence_axes.json",
    readErrorPrefix: "research_funnel_evidence_axes"
  },
  priorAbsorptionMatrix: {
    path: "hypothesis_generation/prior_absorption_matrix.json",
    readErrorPrefix: "research_funnel_prior_absorption_matrix"
  },
  hypotheses: {
    path: "hypotheses.jsonl",
    readErrorPrefix: "research_funnel_hypotheses"
  },
  drafts: {
    path: "hypothesis_generation/drafts.jsonl",
    readErrorPrefix: "research_funnel_drafts"
  },
  reviews: {
    path: "hypothesis_generation/reviews.jsonl",
    readErrorPrefix: "research_funnel_reviews"
  },
  probeShortlist: {
    path: "hypothesis_generation/probe_shortlist.json",
    readErrorPrefix: "research_funnel_probe_shortlist"
  }
} as const;

type ArtifactKey = keyof typeof ARTIFACTS;

type ArtifactRead =
  | { status: "read"; raw: string }
  | { status: "missing" }
  | { status: "read_error"; reasonCode: string };

export async function loadResearchFunnelProjection(
  runDir: string,
  context: ResearchFunnelProjectionContext = {}
): Promise<ResearchFunnelProjection | undefined> {
  const researchMode = context.researchMode ?? await loadResearchRunMode(runDir);
  if (researchMode !== "topic_discovery") {
    return undefined;
  }
  const expectedRunId = context.runId || path.basename(runDir);
  const expectedResearchCycle =
    context.researchCycle ?? await loadResearchCycle(runDir);
  const [
    gapRead,
    gapSynthesisRead,
    evidenceStoreRead,
    corpusRead,
    collectGenerationRead,
    evidenceAxesRead,
    priorAbsorptionMatrixRead,
    hypothesesRead,
    draftsRead,
    reviewsRead,
    shortlistRead,
    portfolioRead,
    topicMemoryAuditRead,
    topicMemoryUpdateRead,
    decisionRead,
    activeProbeRead,
    resultAnalysisRead,
    outcomeRead,
    outcomeGateRead,
    venueViabilityRead,
    followupHandoffRead,
    reviewGateRead,
    collectResultRead,
    collectCorpusQualityRead,
    collectSemanticReviewInputRead,
    collectSemanticReviewRead,
    collectTopicDiscoveryCandidatesRead,
    collectQueryPlanRead,
    collectQueryReformulationHintsRead,
    designReviewsRead,
    candidatePriorDecisionRead,
    candidatePriorPendingPlanRead,
    candidatePriorCollectPlanRead,
    candidatePriorReceiptRead,
    estimatorCandidateExperimentRead,
    estimatorContractRead,
    estimatorReportRead,
    executableExperimentRead,
    estimatorAudit,
    collectionRunState
  ] =
    await Promise.all([
      readArtifact(runDir, ARTIFACTS.gapMap),
      readArtifact(runDir, ARTIFACTS.gapSynthesis),
      readArtifact(runDir, ARTIFACTS.evidenceStore),
      readArtifact(runDir, ARTIFACTS.corpus),
      readArtifact(runDir, ARTIFACTS.collectGeneration),
      readArtifact(runDir, SOURCE_ARTIFACTS.evidenceAxes),
      readArtifact(runDir, SOURCE_ARTIFACTS.priorAbsorptionMatrix),
      readArtifact(runDir, SOURCE_ARTIFACTS.hypotheses),
      readArtifact(runDir, SOURCE_ARTIFACTS.drafts),
      readArtifact(runDir, SOURCE_ARTIFACTS.reviews),
      readArtifact(runDir, SOURCE_ARTIFACTS.probeShortlist),
      readArtifact(runDir, ARTIFACTS.topicPortfolio),
      readArtifact(runDir, ARTIFACTS.topicMemoryAudit),
      readArtifact(runDir, ARTIFACTS.topicMemoryUpdate),
      readArtifact(runDir, ARTIFACTS.topicDecision),
      readArtifact(runDir, ARTIFACTS.activeTopicProbeContract),
      readArtifact(runDir, ARTIFACTS.resultAnalysis),
      readArtifact(runDir, ARTIFACTS.topicProbeOutcome),
      readArtifact(runDir, ARTIFACTS.topicProbeOutcomeGate),
      readArtifact(runDir, ARTIFACTS.venueViability),
      readArtifact(runDir, ARTIFACTS.topicProbeFollowupHandoff),
      readArtifact(runDir, ARTIFACTS.topicProbeReviewGate),
      readArtifact(runDir, ARTIFACTS.collectResult),
      readArtifact(runDir, ARTIFACTS.collectCorpusQuality),
      readArtifact(runDir, ARTIFACTS.collectSemanticReviewInput),
      readArtifact(runDir, ARTIFACTS.collectSemanticReview),
      readArtifact(runDir, ARTIFACTS.collectTopicDiscoveryCandidates),
      readArtifact(runDir, ARTIFACTS.collectQueryPlan),
      readArtifact(runDir, ARTIFACTS.collectQueryReformulationHints),
      readArtifact(runDir, ARTIFACTS.designReviews),
      readArtifact(runDir, ARTIFACTS.candidatePriorSearchDecision),
      readArtifact(runDir, ARTIFACTS.candidatePriorSearchPendingPlan),
      readArtifact(runDir, ARTIFACTS.candidatePriorSearchCollectPlan),
      readArtifact(runDir, ARTIFACTS.candidatePriorSearchReceipt),
      readArtifact(runDir, ARTIFACTS.estimatorCandidateExperimentContract),
      readArtifact(runDir, ARTIFACTS.estimatorContract),
      readArtifact(runDir, ARTIFACTS.estimatorReport),
      readArtifact(runDir, ARTIFACTS.executableExperimentContract),
      loadEstimatorFeasibilityAuditSafely({
        runDir,
        runId: expectedRunId,
        expectedResearchCycle
      }),
      loadCollectionRunState(runDir)
    ]);
  const claimsClosedChain =
    portfolioRead.status === "read"
    || decisionRead.status === "read"
    || activeProbeRead.status === "read";
  const gapEvidenceChain = buildResearchGapEvidenceChain({
    runId: expectedRunId,
    researchCycle: expectedResearchCycle,
    corpusRaw: readRaw(corpusRead) ?? "",
    evidenceRaw: readRaw(evidenceStoreRead) ?? "",
    synthesisRaw: readRaw(gapSynthesisRead) ?? "",
    collectGenerationRaw: readRaw(collectGenerationRead) ?? ""
  });
  const gapValidationReasonCodes = gapRead.status === "read"
    ? gapEvidenceChain.reasonCodes
    : [];

  const validation = validateResearchFunnelClosedChain({
    expectedRunId,
    expectedResearchCycle,
    gapMapRaw: readRaw(gapRead),
    evidenceAxesRaw: readRaw(evidenceAxesRead),
    priorAbsorptionMatrixRaw: readRaw(priorAbsorptionMatrixRead),
    hypothesesRaw: readRaw(hypothesesRead),
    draftsRaw: readRaw(draftsRead),
    reviewsRaw: readRaw(reviewsRead),
    probeShortlistRaw: readRaw(shortlistRead),
    portfolioRaw: readRaw(portfolioRead),
    decisionRaw: readRaw(decisionRead),
    requireDecision: true,
    gapValidationContext: gapEvidenceChain.validationContext,
    gapValidationReasonCodes
  });
  const relaxedGapValidation = gapRead.status === "read"
    ? validateResearchGapMapArtifact(gapRead.raw, {
        ...gapEvidenceChain.validationContext,
        allowUnbound: true
      })
    : validation.gapMapValidation;
  const allowUnboundGapProgress =
    !claimsClosedChain &&
    relaxedGapValidation.valid &&
    relaxedGapValidation.gapMap?.run_id === "" &&
    relaxedGapValidation.gapMap.research_cycle === -1;
  const projectedGapValidation = allowUnboundGapProgress
    ? relaxedGapValidation
    : validation.gapMapValidation;
  const validationReasons = allowUnboundGapProgress
    ? [
        ...validation.reasons.filter(
          (reason) => !validation.gapMapValidation.reasons.includes(reason)
        ),
        ...relaxedGapValidation.reasons
      ]
    : validation.reasons;

  const diagnosticGapMap = projectedGapValidation.gapMap;
  const diagnosticPortfolio = validation.portfolioValidation.portfolio;
  const gapMap = projectedGapValidation.valid ? diagnosticGapMap : undefined;
  const portfolio = validation.portfolioValidation.valid ? validation.portfolio : undefined;
  const decision = validation.decisionValidation.valid ? validation.decision : undefined;
  const activeProbeValidation = activeProbeRead.status === "read"
    ? validateActiveTopicProbeContract(activeProbeRead.raw, {
        expectedRunId,
        expectedResearchCycle,
        portfolio
      })
    : undefined;
  const activeProbeContract =
    validation.valid && activeProbeValidation?.valid
      ? activeProbeValidation.contract
      : undefined;

  const reads = [
    gapRead,
    gapSynthesisRead,
    evidenceStoreRead,
    corpusRead,
    collectGenerationRead,
    hypothesesRead,
    draftsRead,
    reviewsRead,
    shortlistRead,
    portfolioRead,
    decisionRead,
    activeProbeRead
  ];
  const reasonCodes = [
    ...validationReasons,
    ...(activeProbeValidation?.reasons ?? []),
    ...readErrorReasons(reads),
    ...readErrorReasons([
      collectResultRead,
      collectCorpusQualityRead,
      collectSemanticReviewInputRead,
      collectSemanticReviewRead,
      collectTopicDiscoveryCandidatesRead,
      collectQueryPlanRead,
      collectQueryReformulationHintsRead,
      designReviewsRead,
      topicMemoryAuditRead,
      topicMemoryUpdateRead
    ])
  ];
  if (decision) {
    reasonCodes.push(...decision.reason_codes);
  }

  const hasReadError = reads.some((artifact) => artifact.status === "read_error");
  const hasInvalidArtifact =
    (gapRead.status === "read" && !projectedGapValidation.valid) ||
    (portfolioRead.status === "read" && !validation.portfolioValidation.valid) ||
    (decisionRead.status === "read" && !validation.decisionValidation.valid) ||
    (activeProbeRead.status === "read" && activeProbeValidation?.valid !== true);
  const readCount = reads.filter((artifact) => artifact.status === "read").length;
  const baseIntegrityStatus: ResearchFunnelIntegrityStatus =
    readCount === 0 && !hasReadError
      ? "unmeasured"
      : hasReadError || hasInvalidArtifact || (claimsClosedChain && !validation.valid)
        ? "mismatch"
        : validation.complete && validation.valid
          ? "complete"
          : "partial";
  const baseAuthorizationTrusted =
    baseIntegrityStatus === "complete" && validation.valid;
  const diagnosticsTrusted = validation.portfolioValidation.valid;
  const preChainInvalidBlockers = baseIntegrityStatus === "mismatch"
    ? uniqueStrings([
        ...validationReasons,
        ...(activeProbeValidation?.reasons ?? []),
        ...readErrorReasons(reads)
      ])
    : [];
  const postProbe = await projectPostProbeLifecycle({
    runDir,
    expectedRunId,
    expectedResearchCycle,
    resultAnalysisRead,
    outcomeRead,
    outcomeGateRead,
    venueViabilityRead,
    followupHandoffRead,
    reviewGateRead,
    preChainInvalidBlockers
  });
  const integrityStatus: ResearchFunnelIntegrityStatus =
    postProbe.invalidChainBlockers.length > 0 ? "mismatch" : baseIntegrityStatus;
  const authorizationDisposition = decision?.disposition ?? "unmeasured";
  const collection = projectCollectionLifecycle({
    collectGenerationRaw: readRaw(collectGenerationRead),
    collectResultRaw: readRaw(collectResultRead),
    qualityRaw: readRaw(collectCorpusQualityRead),
    queryPlanRaw: readRaw(collectQueryPlanRead),
    reformulationHintsRaw: readRaw(collectQueryReformulationHintsRead),
    reformulationHintsRef: artifactRef(
      "collectQueryReformulationHints",
      collectQueryReformulationHintsRead
    ),
    runState: collectionRunState
  });
  reasonCodes.push(...collection.reasonCodes);
  const semanticLineage = collection.state === "quality_gate_passed"
    ? await validateTopicDiscoveryCollectionAuthorizationLineage({
        runDir,
        expectedRunId,
        expectedResearchCycle,
        expectedAttemptId: parseCollectionGenerationAttempt(
          readRaw(collectGenerationRead)
        ).attemptId,
        qualityRaw: readRaw(collectCorpusQualityRead),
        semanticReviewInputRaw: readRaw(collectSemanticReviewInputRead),
        semanticReviewRaw: readRaw(collectSemanticReviewRead),
        candidatesRaw: readRaw(collectTopicDiscoveryCandidatesRead),
        queryPlanRaw: readRaw(collectQueryPlanRead),
        corpusRaw: readRaw(corpusRead),
        candidatePriorPlanRaw: readRaw(candidatePriorCollectPlanRead),
        candidatePriorReceiptRaw: readRaw(candidatePriorReceiptRead)
      })
    : { trusted: false, reasonCodes: [] };
  reasonCodes.push(...semanticLineage.reasonCodes);
  const collectionAuthorizationPassed =
    collection.state === "quality_gate_passed" && semanticLineage.trusted;
  const authorizationTrusted =
    baseAuthorizationTrusted && collectionAuthorizationPassed;
  const authorizationProbeAllowed =
    authorizationTrusted && validation.probeAllowed;
  if (claimsClosedChain && collection.state !== "quality_gate_passed") {
    reasonCodes.push(
      `collect_corpus_quality_gate_not_passed:${collection.state}`
    );
  } else if (claimsClosedChain && !semanticLineage.trusted) {
    reasonCodes.push("collect_semantic_lineage_not_trusted");
  }
  const lifecycleStage = resolveLifecycleStage({
    invalidChainBlockers: postProbe.invalidChainBlockers,
    reviewGate: postProbe.reviewGate,
    followupHandoff: postProbe.followupHandoff,
    outcomeGate: postProbe.outcomeGate,
    outcome: postProbe.outcome,
    authorizationDisposition,
    authorizationProbeAllowed
  });

  const probeCandidateIds = [...(decision?.probe_candidate_ids ?? portfolio?.probe_candidate_ids ?? [])];
  const statementsByCandidateId = new Map(
    (portfolio?.candidates ?? []).map((candidate) => [candidate.source_candidate_id, candidate.statement] as const)
  );
  const topicMemory = projectTopicMemory({
    portfolioRead,
    portfolio,
    auditRead: topicMemoryAuditRead,
    updateRead: topicMemoryUpdateRead
  });
  const candidatePriorSearch = await projectCandidatePriorSearch({
    runDir,
    expectedRunId,
    expectedResearchCycle,
    currentCorpusRaw: readRaw(corpusRead),
    queryPlanRaw: readRaw(collectQueryPlanRead),
    decisionRead: candidatePriorDecisionRead,
    pendingPlanRead: candidatePriorPendingPlanRead,
    collectPlanRead: candidatePriorCollectPlanRead,
    receiptRead: candidatePriorReceiptRead,
    requiredCandidateIds: activeProbeContract
      ? [activeProbeContract.candidate_id]
      : probeCandidateIds.slice(0, 1),
    expectedCandidateContractHashes: new Map(
      (validation.priorAbsorptionMatrix?.candidates ?? []).map((candidate) => [
        candidate.candidate_id,
        candidate.candidate_contract.content_sha256
      ] as const)
    )
  });
  const estimatorFeasibility = projectEstimatorFeasibility({
    audit: estimatorAudit,
    candidateExperimentRead: estimatorCandidateExperimentRead,
    contractRead: estimatorContractRead,
    reportRead: estimatorReportRead,
    executableExperimentRead
  });
  reasonCodes.push(
    ...candidatePriorSearch.reasonCodes,
    ...estimatorFeasibility.reasonCodes
  );
  const executionAuthorization = composeTopicProbeExecutionAuthorization({
    baseFunnel: {
      measured: claimsClosedChain,
      trusted: authorizationTrusted,
      authorized: authorizationProbeAllowed
    },
    candidatePriorSearch: {
      status: candidatePriorSearch.status,
      trusted: candidatePriorSearch.trusted,
      action: candidatePriorSearch.action,
      currentReceiptStatus: candidatePriorSearch.currentReceiptStatus,
      coveredCandidateIds: candidatePriorSearch.coveredCandidateIds
    },
    estimator: {
      status: estimatorFeasibility.status,
      trusted: estimatorFeasibility.trusted,
      executionAuthorized: estimatorFeasibility.executionAuthorized
    },
    requiredCandidateIds: activeProbeContract
      ? [activeProbeContract.candidate_id]
      : probeCandidateIds.slice(0, 1)
  });

  return {
    researchMode,
    lifecycleStage,
    boundedProbePaperEvidenceAllowed: false,
    collectionState: collection.state,
    collectionNodeAttempt: collection.nodeAttempt,
    collectionNodeMaxAttempts: collection.nodeMaxAttempts,
    queryPlanAttempt: collection.queryPlanAttempt,
    collectionQualityFailureReasons: collection.qualityFailureReasons,
    collectionReformulationHint: collection.reformulationHint,
    gapEvidenceAudit: {
      ...gapEvidenceChain.audit,
      status: gapRead.status !== "read"
        ? "unmeasured"
        : projectedGapValidation.valid
          ? "verified"
          : "blocked",
      constructionMode: diagnosticGapMap?.construction_mode,
      synthesisStatus: gapEvidenceChain.synthesisArtifact?.status,
      analysisCoverage: diagnosticGapMap
        ? {
            ...diagnosticGapMap.analysis_coverage,
            failed_paper_ids: [...diagnosticGapMap.analysis_coverage.failed_paper_ids]
          }
        : undefined
    },
    candidateCount: diagnosticPortfolio?.candidate_policy.observed ?? 0,
    clusterCount: diagnosticPortfolio?.cluster_policy.observed_distinct_nonempty ?? 0,
    candidatePriorSearch,
    estimatorFeasibility,
    topicMemory,
    diagnosticsTrusted,
    authorizationTrusted,
    portfolioCandidates: (diagnosticPortfolio?.candidates ?? []).map(
      (candidate, index) => ({
        rank: index + 1,
        candidateId: candidate.source_candidate_id,
        topicId: candidate.topic_id,
        statement: candidate.statement,
        trusted: diagnosticsTrusted,
        reviewStatus: candidate.review_status,
        probeStatus: candidate.probe_status,
        probeEligible: candidate.probe_eligible,
        scores: { ...candidate.scores },
        closestPriorPaperIds: [...candidate.closest_prior_paper_ids],
        closestPriorFullTextPaperIds: [
          ...candidate.closest_prior_full_text_paper_ids
        ],
        priorAbsorptionComparisons:
          candidate.prior_absorption?.comparisons.map((comparison) => ({
            priorPaperId: comparison.prior_paper_id,
            disposition: comparison.disposition
          })) ?? [],
        priorAbsorptionReasonCodes: [
          ...(candidate.prior_absorption?.reason_codes ?? [])
        ],
        ...(candidate.closest_prior_non_overlap
          ? { closestPriorNonOverlap: candidate.closest_prior_non_overlap }
          : {}),
        ...(candidate.reviewer_absorption_objection
          ? { reviewerAbsorptionObjection: candidate.reviewer_absorption_objection }
          : {}),
        ...(candidate.comparator ? { comparator: candidate.comparator } : {}),
        ...(candidate.dataset_task_bench
          ? { datasetTaskBench: candidate.dataset_task_bench }
          : {}),
        ...(candidate.primary_metric
          ? { primaryMetric: candidate.primary_metric }
          : {}),
        ...(candidate.local_budget ? { localBudget: candidate.local_budget } : {}),
        ...(candidate.kill_signal ? { killSignal: candidate.kill_signal } : {}),
        ...(candidate.contribution_claim
          ? { contributionClaim: candidate.contribution_claim }
          : {}),
        ...(candidate.minimum_publishable_evidence
          ? { minimumPublishableEvidence: candidate.minimum_publishable_evidence }
          : {}),
        ...(candidate.review_summary
          ? { reviewSummary: candidate.review_summary }
          : {}),
        ...(candidate.topic_memory
          ? {
              topicMemoryDisposition: candidate.topic_memory.decision.disposition,
              topicMemoryMaximumLineageSimilarity:
                candidate.topic_memory.decision.maximum_lineage_similarity
            }
          : {}),
        blockedGateCodes: candidate.gates
          .filter((gate) => gate.status === "block")
          .map((gate) => gate.code)
      })
    ),
    probeCandidateCount: probeCandidateIds.length,
    probeCandidateIds,
    probeCandidateStatements: probeCandidateIds.flatMap((candidateId) => {
      const statement = statementsByCandidateId.get(candidateId);
      return statement ? [statement] : [];
    }),
    activeCandidateId: activeProbeContract?.candidate_id,
    activeTopicId: activeProbeContract?.topic_id,
    activeCandidateHash: activeProbeContract?.candidate_content_sha256,
    activePrimaryMetric: activeProbeContract?.primary_metric,
    activeMetricUnit: activeProbeContract?.metric_unit,
    activeMetricScale: activeProbeContract?.metric_scale,
    activeMetricDirection: activeProbeContract?.metric_direction,
    activeEffectCriterion: activeProbeContract?.effect_criterion,
    activeObjectiveRaw: activeProbeContract?.objective_raw,
    activeMeaningfulEffect: activeProbeContract?.meaningful_effect,
    activeEvidenceStage: activeProbeContract?.evidence_stage,
    activeDeferredCandidateIds: activeProbeContract
      ? [...activeProbeContract.deferred_candidate_ids]
      : undefined,
    authorizationDisposition,
    authorizationProbeAllowed,
    effectiveExecutionAuthorized: executionAuthorization.authorized,
    executionAuthorization,
    outcomeDisposition: postProbe.outcome?.disposition,
    outcomeNextAction: postProbe.outcome?.next_action,
    outcomeGate: postProbe.outcomeGate,
    venueViability: postProbe.venueViability,
    followupHandoff: postProbe.followupHandoff,
    reviewGate: postProbe.reviewGate,
    invalidChainBlockers: postProbe.invalidChainBlockers,
    reasonCodes: uniqueStrings([
      ...reasonCodes,
      ...(postProbe.outcome?.reason_codes ?? []),
      ...postProbe.outcomeGate.reasonCodes,
      ...postProbe.reviewGate.reasonCodes,
      ...postProbe.invalidChainBlockers
    ]),
    gates: collectGateProjections({
      gapMap: diagnosticGapMap,
      gapMapTrusted: projectedGapValidation.valid,
      portfolio: diagnosticPortfolio,
      portfolioTrusted: validation.portfolioValidation.valid
    }),
    dissent: [
      ...collectPortfolioDissent(
        diagnosticPortfolio,
        validation.portfolioValidation.valid
      ),
      ...parseDesignPanelDissent(
        readRaw(designReviewsRead),
        baseIntegrityStatus !== "mismatch"
      )
    ],
    ...collectLiteratureQueryProjection(readRaw(collectResultRead)),
    hashes: {
      gapMap: gapMap?.content_sha256,
      topicPortfolio: portfolio?.content_sha256,
      topicDecision: decision?.content_sha256,
      activeTopicProbeContract: activeProbeContract?.content_sha256,
      topicProbeOutcome: postProbe.outcome?.content_sha256,
      topicProbeOutcomeGate: postProbe.outcomeGate.contentHash,
      venueViability: postProbe.venueViability.contentHash,
      topicProbeFollowupHandoff: postProbe.followupHandoff.contentHash,
      topicProbeReviewGate: postProbe.reviewGate.contentHash
    },
    artifactRefs: artifactRefs([
      ["gapMap", gapRead],
      ["gapSynthesis", gapSynthesisRead],
      ["evidenceStore", evidenceStoreRead],
      ["corpus", corpusRead],
      ["collectGeneration", collectGenerationRead],
      ["topicPortfolio", portfolioRead],
      ["topicMemoryAudit", topicMemoryAuditRead],
      ["topicMemoryUpdate", topicMemoryUpdateRead],
      ["topicDecision", decisionRead],
      ["activeTopicProbeContract", activeProbeRead],
      ["resultAnalysis", resultAnalysisRead],
      ["topicProbeOutcome", outcomeRead],
      ["topicProbeOutcomeGate", outcomeGateRead],
      ["venueViability", venueViabilityRead],
      ["topicProbeFollowupHandoff", followupHandoffRead],
      ["topicProbeReviewGate", reviewGateRead],
      ["collectResult", collectResultRead],
      ["collectCorpusQuality", collectCorpusQualityRead],
      ["collectSemanticReviewInput", collectSemanticReviewInputRead],
      ["collectSemanticReview", collectSemanticReviewRead],
      ["collectTopicDiscoveryCandidates", collectTopicDiscoveryCandidatesRead],
      ["collectQueryPlan", collectQueryPlanRead],
      ["collectQueryReformulationHints", collectQueryReformulationHintsRead],
      ["designReviews", designReviewsRead],
      ["candidatePriorSearchDecision", candidatePriorDecisionRead],
      ["candidatePriorSearchPendingPlan", candidatePriorPendingPlanRead],
      ["candidatePriorSearchCollectPlan", candidatePriorCollectPlanRead],
      ["candidatePriorSearchReceipt", candidatePriorReceiptRead],
      ["estimatorCandidateExperimentContract", estimatorCandidateExperimentRead],
      ["estimatorContract", estimatorContractRead],
      ["estimatorReport", estimatorReportRead],
      ["executableExperimentContract", executableExperimentRead]
    ]),
    integrityStatus
  };
}

export interface TopicProbeOutcomeGateArtifact {
  schema_version: 1;
  artifact_kind: "topic_probe_outcome_gate";
  run_id: string;
  research_cycle: number;
  status: "decided" | "blocked_invalid_artifact_chain";
  disposition: TopicProbeOutcomeDisposition | null;
  outcome_content_sha256: string | null;
  reason_codes: string[];
  venue_viability_report_contract_version?: 1;
  content_sha256: string;
}

export const TOPIC_PROBE_OUTCOME_GATE_RELATIVE_PATH =
  "analysis/topic_probe_outcome_gate.json";

interface PostProbeLifecycleProjection {
  outcome?: TopicProbeOutcomeDecision;
  outcomeGate: ResearchFunnelOutcomeGateProjection;
  venueViability: ResearchFunnelProjection["venueViability"];
  followupHandoff: ResearchFunnelFollowupHandoffProjection;
  reviewGate: ResearchFunnelReviewGateProjection;
  invalidChainBlockers: string[];
}

async function projectPostProbeLifecycle(input: {
  runDir: string;
  expectedRunId: string;
  expectedResearchCycle: number;
  resultAnalysisRead: ArtifactRead;
  outcomeRead: ArtifactRead;
  outcomeGateRead: ArtifactRead;
  venueViabilityRead: ArtifactRead;
  followupHandoffRead: ArtifactRead;
  reviewGateRead: ArtifactRead;
  preChainInvalidBlockers: string[];
}): Promise<PostProbeLifecycleProjection> {
  const invalidChainBlockers = [...input.preChainInvalidBlockers];
  let sourceValidation:
    | Awaited<ReturnType<typeof loadTopicProbeOutcomeArtifacts>>
    | undefined;
  let outcome: TopicProbeOutcomeDecision | undefined;

  if (input.outcomeRead.status === "read") {
    if (input.resultAnalysisRead.status === "missing") {
      invalidChainBlockers.push("topic_probe_result_analysis_missing");
    } else if (input.resultAnalysisRead.status === "read_error") {
      invalidChainBlockers.push(input.resultAnalysisRead.reasonCode);
    } else {
      const report = parseAnalysisReport(input.resultAnalysisRead.raw);
      if (!report) {
        invalidChainBlockers.push("topic_probe_result_analysis_invalid");
      } else {
        const workspaceRoot = resolveWorkspaceRoot(input.runDir, input.expectedRunId);
        if (!workspaceRoot) {
          invalidChainBlockers.push("topic_probe_projection_workspace_root_unresolved");
        } else {
          sourceValidation = await loadTopicProbeOutcomeArtifacts({
            workspaceRoot,
            runId: input.expectedRunId,
            expectedResearchCycle: input.expectedResearchCycle,
            requireOutcome: true,
            report
          });
          if (sourceValidation.valid && sourceValidation.decision) {
            outcome = sourceValidation.decision;
          } else {
            invalidChainBlockers.push(
              ...(sourceValidation.reasons.length > 0
                ? sourceValidation.reasons
                : ["topic_probe_outcome_artifact_chain_invalid"])
            );
          }
        }
      }
    }
  } else if (input.outcomeRead.status === "read_error") {
    invalidChainBlockers.push(input.outcomeRead.reasonCode);
  }

  const outcomeGateRef = artifactRef("topicProbeOutcomeGate", input.outcomeGateRead);
  let outcomeGate: ResearchFunnelOutcomeGateProjection = {
    status: "unmeasured",
    trusted: false,
    reasonCodes: [],
    ...(outcomeGateRef ? { artifactRef: outcomeGateRef } : {})
  };
  let venueViabilityRequired = false;
  if (input.outcomeGateRead.status === "read") {
    const gateValidation = validateTopicProbeOutcomeGateProjection(
      input.outcomeGateRead.raw,
      {
        expectedRunId: input.expectedRunId,
        expectedResearchCycle: input.expectedResearchCycle,
        outcome
      }
    );
    const gate = gateValidation.gate;
    venueViabilityRequired = gateValidation.reasons.length === 0
      && gate?.venue_viability_report_contract_version === 1;
    outcomeGate = {
      status: gate?.status ?? "invalid",
      trusted: gateValidation.reasons.length === 0,
      reasonCodes: [...(gate?.reason_codes ?? gateValidation.reasons)],
      ...(gateValidation.reasons.length === 0 && gate
        ? { contentHash: gate.content_sha256 }
        : {}),
      ...(outcomeGateRef ? { artifactRef: outcomeGateRef } : {})
    };
    invalidChainBlockers.push(...gateValidation.reasons);
    if (gate?.status === "blocked_invalid_artifact_chain") {
      invalidChainBlockers.push(
        "topic_probe_outcome_gate_blocked_invalid_artifact_chain",
        ...gate.reason_codes
      );
    }
  } else if (input.outcomeGateRead.status === "read_error") {
    outcomeGate = {
      status: "invalid",
      trusted: false,
      reasonCodes: [input.outcomeGateRead.reasonCode],
      ...(outcomeGateRef ? { artifactRef: outcomeGateRef } : {})
    };
    invalidChainBlockers.push(input.outcomeGateRead.reasonCode);
  } else if (input.outcomeRead.status === "read") {
    invalidChainBlockers.push("topic_probe_outcome_gate_missing");
  }

  const venueRef = artifactRef("venueViability", input.venueViabilityRead);
  let venueViability: ResearchFunnelProjection["venueViability"] = {
    status: "unmeasured",
    trusted: false,
    topTierReady: false,
    acceptanceLikelihoodAssessed: false,
    reasonCodes: [],
    requiredUpgrades: [],
    ...(venueRef ? { artifactRef: venueRef } : {})
  };
  if (input.venueViabilityRead.status === "read") {
    const portfolio = sourceValidation?.portfolio;
    const contract = sourceValidation?.contract;
    const matchingCandidates = portfolio && contract
      ? portfolio.candidates.filter(
          (candidate) =>
            candidate.source_candidate_id === contract.candidate_id
            && candidate.topic_id === contract.topic_id
        )
      : [];
    if (outcome && contract && matchingCandidates.length === 1) {
      const validation = validateVenueViabilityReport(
        input.venueViabilityRead.raw,
        {
          candidate: matchingCandidates[0],
          contract,
          outcome
        }
      );
      const report = validation.report;
      venueViability = validation.valid && report
        ? {
            status: "trusted",
            trusted: true,
            candidateViability: report.candidate_viability,
            currentEvidenceCeiling: report.current_evidence_ceiling,
            topTierReadiness: report.top_tier_readiness,
            confirmatoryCandidacy: report.confirmatory_candidacy,
            declaredComparatorEffectGate: report.declared_comparator_effect_gate,
            topTierReady: false,
            acceptanceLikelihoodAssessed: false,
            reasonCodes: [...report.reason_codes],
            requiredUpgrades: [...report.required_upgrades],
            contentHash: report.content_sha256,
            ...(venueRef ? { artifactRef: venueRef } : {})
          }
        : {
            status: "invalid",
            trusted: false,
            topTierReady: false,
            acceptanceLikelihoodAssessed: false,
            reasonCodes: [...validation.reasons],
            requiredUpgrades: [],
            ...(venueRef ? { artifactRef: venueRef } : {})
          };
    } else {
      venueViability = {
        status: "invalid",
        trusted: false,
        topTierReady: false,
        acceptanceLikelihoodAssessed: false,
        reasonCodes: [
          matchingCandidates.length > 1
            ? "venue_viability_candidate_ambiguous"
            : "venue_viability_source_context_missing"
        ],
        requiredUpgrades: [],
        ...(venueRef ? { artifactRef: venueRef } : {})
      };
    }
  } else if (input.venueViabilityRead.status === "read_error") {
    venueViability = {
      status: "invalid",
      trusted: false,
      topTierReady: false,
      acceptanceLikelihoodAssessed: false,
      reasonCodes: [input.venueViabilityRead.reasonCode],
      requiredUpgrades: [],
      ...(venueRef ? { artifactRef: venueRef } : {})
    };
  } else if (venueViabilityRequired) {
    venueViability = {
      status: "invalid",
      trusted: false,
      topTierReady: false,
      acceptanceLikelihoodAssessed: false,
      reasonCodes: ["venue_viability_report_missing"],
      requiredUpgrades: []
    };
    invalidChainBlockers.push("venue_viability_report_missing");
  }

  const handoffRef = artifactRef("topicProbeFollowupHandoff", input.followupHandoffRead);
  let handoff: TopicProbeFollowupHandoff | undefined;
  let followupHandoff: ResearchFunnelFollowupHandoffProjection = {
    status: "unmeasured",
    trusted: false,
    ...(handoffRef ? { artifactRef: handoffRef } : {})
  };
  if (input.followupHandoffRead.status === "read") {
    const candidateMatches = sourceValidation?.portfolio
      && sourceValidation.contract
      ? sourceValidation.portfolio.candidates.filter(
          (candidate) =>
            candidate.source_candidate_id === sourceValidation?.contract?.candidate_id
            && candidate.topic_id === sourceValidation.contract.topic_id
        )
      : [];
    if (
      !sourceValidation?.valid
      || !sourceValidation.portfolio
      || !sourceValidation.contract
      || !outcome
      || outcomeGate.status !== "decided"
      || !outcomeGate.trusted
      || candidateMatches.length !== 1
    ) {
      const reason = candidateMatches.length > 1
        ? "topic_probe_projection_active_candidate_ambiguous"
        : candidateMatches.length === 0
          ? "topic_probe_projection_active_candidate_missing"
          : "topic_probe_followup_source_chain_invalid";
      followupHandoff = {
        status: "invalid",
        trusted: false,
        ...(handoffRef ? { artifactRef: handoffRef } : {})
      };
      invalidChainBlockers.push(reason);
    } else {
      const validation = validateTopicProbeFollowupHandoff(
        input.followupHandoffRead.raw,
        {
          portfolio: sourceValidation.portfolio,
          contract: sourceValidation.contract,
          outcome,
          candidate: candidateMatches[0],
          expectedRunId: input.expectedRunId,
          expectedResearchCycle: input.expectedResearchCycle
        }
      );
      if (validation.valid && validation.handoff) {
        handoff = validation.handoff;
        followupHandoff = {
          status: "ready",
          trusted: true,
          recommendedFollowupMode: handoff.recommended_followup_mode,
          evidenceStage: handoff.evidence_stage,
          contentHash: handoff.content_sha256,
          ...(handoffRef ? { artifactRef: handoffRef } : {})
        };
      } else {
        followupHandoff = {
          status: "invalid",
          trusted: false,
          ...(handoffRef ? { artifactRef: handoffRef } : {})
        };
        invalidChainBlockers.push(...validation.reasons);
      }
    }
  } else if (input.followupHandoffRead.status === "read_error") {
    followupHandoff = {
      status: "invalid",
      trusted: false,
      ...(handoffRef ? { artifactRef: handoffRef } : {})
    };
    invalidChainBlockers.push(input.followupHandoffRead.reasonCode);
  }

  const reviewGateRef = artifactRef("topicProbeReviewGate", input.reviewGateRead);
  let reviewGate: ResearchFunnelReviewGateProjection = {
    status: "unmeasured",
    trusted: false,
    paperDraftingAllowed: false,
    reasonCodes: [],
    ...(reviewGateRef ? { artifactRef: reviewGateRef } : {})
  };
  if (input.reviewGateRead.status === "read") {
    const validation = validateTopicProbeReviewGate(
      input.reviewGateRead.raw,
      {
        runId: input.expectedRunId,
        researchCycle: input.expectedResearchCycle,
        outcome,
        handoff,
        validationReasons: []
      }
    );
    const gate = validation.gate;
    reviewGate = {
      status: gate?.status ?? "invalid",
      trusted: validation.valid,
      paperDraftingAllowed: false,
      reasonCodes: [...(gate?.reason_codes ?? validation.reasons)],
      ...(validation.valid && gate ? { contentHash: gate.content_sha256 } : {}),
      ...(reviewGateRef ? { artifactRef: reviewGateRef } : {})
    };
    invalidChainBlockers.push(...validation.reasons);
    if (gate?.status === "blocked_invalid_artifact_chain") {
      invalidChainBlockers.push(
        "topic_probe_review_gate_blocked_invalid_artifact_chain",
        ...gate.reason_codes
      );
    }
  } else if (input.reviewGateRead.status === "read_error") {
    reviewGate = {
      status: "invalid",
      trusted: false,
      paperDraftingAllowed: false,
      reasonCodes: [input.reviewGateRead.reasonCode],
      ...(reviewGateRef ? { artifactRef: reviewGateRef } : {})
    };
    invalidChainBlockers.push(input.reviewGateRead.reasonCode);
  }

  return {
    outcome,
    outcomeGate,
    venueViability,
    followupHandoff,
    reviewGate,
    invalidChainBlockers: uniqueStrings(invalidChainBlockers)
  };
}

function resolveLifecycleStage(input: {
  invalidChainBlockers: string[];
  reviewGate: ResearchFunnelReviewGateProjection;
  followupHandoff: ResearchFunnelFollowupHandoffProjection;
  outcomeGate: ResearchFunnelOutcomeGateProjection;
  outcome?: TopicProbeOutcomeDecision;
  authorizationDisposition: ResearchFunnelAuthorizationDisposition;
  authorizationProbeAllowed: boolean;
}): ResearchFunnelLifecycleStage {
  if (input.invalidChainBlockers.length > 0) {
    return "invalid_chain";
  }
  if (input.reviewGate.trusted && input.reviewGate.status === "followup_required") {
    return "reviewed";
  }
  if (input.followupHandoff.trusted && input.followupHandoff.status === "ready") {
    return "followup_required";
  }
  if (
    input.outcome
    && input.outcomeGate.trusted
    && input.outcomeGate.status === "decided"
  ) {
    return "outcome_decided";
  }
  if (
    input.authorizationDisposition === "probe_authorized"
    && input.authorizationProbeAllowed
  ) {
    return "probe_authorized";
  }
  return "discovery";
}

export function validateTopicProbeOutcomeGateProjection(
  raw: string,
  context: {
    expectedRunId: string;
    expectedResearchCycle: number;
    outcome?: TopicProbeOutcomeDecision;
  }
): { reasons: string[]; gate?: TopicProbeOutcomeGateArtifact } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { reasons: ["topic_probe_outcome_gate_invalid_json"] };
  }
  if (!isTopicProbeOutcomeGateArtifact(value)) {
    return { reasons: ["topic_probe_outcome_gate_schema_invalid"] };
  }

  const reasons: string[] = [];
  const { content_sha256: contentHash, ...payload } = value;
  if (hashCanonical(payload) !== contentHash) {
    reasons.push("topic_probe_outcome_gate_content_hash_mismatch");
  }
  if (value.run_id !== context.expectedRunId) {
    reasons.push("topic_probe_outcome_gate_run_id_mismatch");
  }
  if (value.research_cycle !== context.expectedResearchCycle) {
    reasons.push("topic_probe_outcome_gate_research_cycle_mismatch");
  }

  if (value.status === "decided") {
    if (!context.outcome) {
      reasons.push("topic_probe_outcome_gate_outcome_missing");
    } else {
      if (value.disposition !== context.outcome.disposition) {
        reasons.push("topic_probe_outcome_gate_disposition_mismatch");
      }
      if (value.outcome_content_sha256 !== context.outcome.content_sha256) {
        reasons.push("topic_probe_outcome_gate_outcome_hash_mismatch");
      }
      if (!valuesEqual(value.reason_codes, context.outcome.reason_codes)) {
        reasons.push("topic_probe_outcome_gate_reason_codes_mismatch");
      }
    }
  } else {
    if (value.disposition !== null) {
      reasons.push("topic_probe_outcome_gate_blocked_disposition_present");
    }
    if (value.outcome_content_sha256 !== null) {
      reasons.push("topic_probe_outcome_gate_blocked_outcome_hash_present");
    }
    if (value.reason_codes.length === 0) {
      reasons.push("topic_probe_outcome_gate_blocked_reasons_missing");
    }
  }

  return { reasons: uniqueStrings(reasons), gate: value };
}

const TOPIC_PROBE_OUTCOME_GATE_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "run_id",
  "research_cycle",
  "status",
  "disposition",
  "outcome_content_sha256",
  "reason_codes",
  "venue_viability_report_contract_version",
  "content_sha256"
]);

function isTopicProbeOutcomeGateArtifact(
  value: unknown
): value is TopicProbeOutcomeGateArtifact {
  if (!isRecord(value) || !hasOnlyKnownFields(value, TOPIC_PROBE_OUTCOME_GATE_FIELDS)) {
    return false;
  }
  return value.schema_version === 1
    && value.artifact_kind === "topic_probe_outcome_gate"
    && hasText(value.run_id)
    && isNonNegativeInteger(value.research_cycle)
    && (value.status === "decided" || value.status === "blocked_invalid_artifact_chain")
    && (value.disposition === null || isTopicProbeOutcomeDisposition(value.disposition))
    && (value.outcome_content_sha256 === null || isSha256(value.outcome_content_sha256))
    && Array.isArray(value.reason_codes)
    && value.reason_codes.every(hasText)
    && (value.venue_viability_report_contract_version === undefined
      || value.venue_viability_report_contract_version === 1)
    && isSha256(value.content_sha256);
}

function resolveWorkspaceRoot(runDir: string, expectedRunId: string): string | undefined {
  const resolvedRunDir = path.resolve(runDir);
  const runsDir = path.dirname(resolvedRunDir);
  const stateDir = path.dirname(runsDir);
  if (
    path.basename(resolvedRunDir) !== expectedRunId
    || path.basename(runsDir) !== "runs"
    || path.basename(stateDir) !== ".autolabos"
  ) {
    return undefined;
  }
  return path.dirname(stateDir);
}

function artifactRef(
  key: ArtifactKey,
  read: ArtifactRead
): ResearchFunnelProjectionArtifactRef | undefined {
  return read.status === "missing"
    ? undefined
    : { label: ARTIFACTS[key].label, path: ARTIFACTS[key].path };
}

function hasOnlyKnownFields(value: Record<string, unknown>, fields: Set<string>): boolean {
  return Object.keys(value).every((field) => fields.has(field));
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isTopicProbeOutcomeDisposition(
  value: unknown
): value is TopicProbeOutcomeDisposition {
  return value === "promote_to_confirmatory"
    || value === "reject_candidate"
    || value === "repeat_probe"
    || value === "blocked_invalid_evidence";
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function loadResearchRunMode(runDir: string): Promise<ResearchRunMode> {
  try {
    const raw = await fs.readFile(path.join(runDir, "brief", "source_brief.md"), "utf8");
    return parseResearchRunMode(raw);
  } catch {
    return "hypothesis_test";
  }
}

function collectGateProjections(input: {
  gapMap?: ResearchGapMap;
  gapMapTrusted: boolean;
  portfolio?: TopicPortfolio;
  portfolioTrusted: boolean;
}): ResearchFunnelGateProjection[] {
  const gates: ResearchFunnelGateProjection[] = [];
  for (const gate of input.gapMap?.gates ?? []) {
    gates.push(projectGate("gap_map", gate, input.gapMapTrusted));
  }
  for (const gap of input.gapMap?.gaps ?? []) {
    for (const gate of gap.gates) {
      gates.push(projectGate("gap_candidate", gate, input.gapMapTrusted, gap.gap_id));
    }
  }
  for (const gate of input.portfolio?.gates ?? []) {
    gates.push(projectGate("topic_portfolio", gate, input.portfolioTrusted));
  }
  for (const candidate of input.portfolio?.candidates ?? []) {
    for (const gate of candidate.gates) {
      gates.push(
        projectGate(
          "topic_candidate",
          gate,
          input.portfolioTrusted,
          candidate.source_candidate_id
        )
      );
    }
  }
  return gates;
}

function projectGate(
  scope: ResearchFunnelGateProjection["scope"],
  gate: ResearchFunnelGate,
  trusted: boolean,
  candidateId?: string
): ResearchFunnelGateProjection {
  return {
    scope,
    code: gate.code,
    status: gate.status,
    message: gate.message,
    trusted,
    ...(candidateId ? { candidateId } : {})
  };
}

function collectPortfolioDissent(
  portfolio: TopicPortfolio | undefined,
  trusted: boolean
): ResearchFunnelDissentProjection[] {
  return (portfolio?.candidates ?? []).flatMap((candidate) => {
    const blockingGateMessages = candidate.gates
      .filter((gate) => gate.status === "block")
      .map((gate) => gate.message);
    const findings = uniqueStrings([
      candidate.reviewer_absorption_objection || "",
      candidate.review_summary || "",
      ...blockingGateMessages
    ]).filter(Boolean);
    const hardBlock = candidate.review_status === "rejected" || blockingGateMessages.length > 0;
    if (findings.length === 0 && !hardBlock) {
      return [];
    }
    return [{
      source: "portfolio_review" as const,
      candidateId: candidate.source_candidate_id,
      hardBlock,
      summary:
        candidate.review_summary
        || candidate.reviewer_absorption_objection
        || "The candidate did not pass its declared topic gates.",
      findings,
      trusted
    }];
  });
}

function parseDesignPanelDissent(
  raw: string | undefined,
  trusted: boolean
): ResearchFunnelDissentProjection[] {
  if (!raw?.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((value) => {
      if (!isRecord(value)) {
        return [];
      }
      const candidateId = readText(value.candidate_id);
      const summary = readText(value.summary);
      const reviewerId = readText(value.reviewer_id);
      const reviewerLabel = readText(value.reviewer_label);
      if (!candidateId || !summary || typeof value.hard_block !== "boolean") {
        return [];
      }
      const findings = Array.isArray(value.findings)
        ? uniqueStrings(value.findings.flatMap((finding) => {
            const text = readText(finding);
            return text ? [text] : [];
          }))
        : [];
      return [{
        source: "design_panel" as const,
        candidateId,
        hardBlock: value.hard_block,
        summary,
        findings,
        trusted,
        ...(reviewerId ? { reviewerId } : {}),
        ...(reviewerLabel ? { reviewerLabel } : {})
      }];
    });
  } catch {
    return [];
  }
}

interface CollectionRunStateSnapshot {
  nodeAttempt?: number;
  nodeMaxAttempts?: number;
  nodeStatus?: string;
  runStatus?: string;
}

interface CollectionQualitySnapshot {
  attemptId?: string;
  passed: boolean;
  reasons: string[];
  semanticsValid: boolean;
  semanticReviewStatus?: ResearchFunnelSemanticReviewStatus;
}

interface CollectionResultSnapshot {
  attemptId?: string;
  completed?: boolean;
  fetchError?: string;
  quality?: CollectionQualitySnapshot;
}

interface CollectionLifecycleProjection {
  state: ResearchFunnelCollectionState;
  nodeAttempt?: number;
  nodeMaxAttempts?: number;
  queryPlanAttempt?: number;
  qualityFailureReasons: string[];
  reformulationHint?: ResearchFunnelReformulationHintProjection;
  reasonCodes: string[];
}

function projectCollectionLifecycle(input: {
  collectGenerationRaw?: string;
  collectResultRaw?: string;
  qualityRaw?: string;
  queryPlanRaw?: string;
  reformulationHintsRaw?: string;
  reformulationHintsRef?: ResearchFunnelProjectionArtifactRef;
  runState: CollectionRunStateSnapshot;
}): CollectionLifecycleProjection {
  const generation = parseCollectionGenerationAttempt(
    input.collectGenerationRaw
  );
  const result = parseCollectionResultSnapshot(input.collectResultRaw);
  const quality = parseCollectionQualitySnapshot(input.qualityRaw);
  const queryPlanValue = parseJsonRecord(input.queryPlanRaw);
  const candidatePriorCollection =
    queryPlanValue?.strategy === "candidate_prior_portfolio";
  const effectiveQuality = candidatePriorCollection
    ? result.value?.quality
    : quality.value ?? result.value?.quality;
  const queryPlan = parseQueryPlanAttempt(input.queryPlanRaw);
  const reformulation = effectiveQuality?.passed === false
    ? parseCollectionReformulationHint(
        input.reformulationHintsRaw,
        input.reformulationHintsRef,
        effectiveQuality.semanticReviewStatus
      )
    : { reasonCodes: [] as string[] };
  const artifactGenerationMismatch = hasCollectionArtifactGenerationMismatch({
    collectGenerationRaw: input.collectGenerationRaw,
    collectGenerationAttemptId: generation.attemptId,
    collectResultRaw: input.collectResultRaw,
    collectResultAttemptId: result.value?.attemptId,
    qualityRaw: candidatePriorCollection ? undefined : input.qualityRaw,
    qualityAttemptId: candidatePriorCollection ? undefined : quality.value?.attemptId,
    queryPlanRaw: input.queryPlanRaw,
    queryPlanAttemptId: queryPlan.attemptId,
    reformulationHintsRaw:
      effectiveQuality?.passed === false ? input.reformulationHintsRaw : undefined,
    reformulationHintsAttemptId: reformulation.attemptId
  }) || (
    Boolean(input.collectGenerationRaw?.trim())
    && !generation.attemptId
  );
  const collectionFailureClass =
    effectiveQuality?.passed === false
      ? reformulation.hint?.failureClass
        ?? failureClassForSemanticReviewStatus(
          effectiveQuality.semanticReviewStatus
        )
      : undefined;
  const exhausted =
    effectiveQuality?.passed === false
    && input.runState.nodeStatus === "failed"
    && input.runState.nodeAttempt !== undefined
    && input.runState.nodeMaxAttempts !== undefined
    && input.runState.nodeAttempt >= input.runState.nodeMaxAttempts;

  let state: ResearchFunnelCollectionState = "unmeasured";
  if (
    artifactGenerationMismatch
    && input.runState.nodeStatus === "running"
  ) {
    state = "collecting";
  } else if (artifactGenerationMismatch) {
    state = "failed";
  } else if (
    candidatePriorCollection
    && result.value?.completed === true
    && !result.value.fetchError
  ) {
    state = "quality_gate_passed";
  } else if (
    effectiveQuality?.passed === true
    && effectiveQuality.semanticsValid
    && effectiveQuality.semanticReviewStatus === "complete"
  ) {
    state = "quality_gate_passed";
  } else if (effectiveQuality) {
    state = exhausted ? "quality_gate_exhausted" : "quality_gate_failed";
  } else if (input.runState.nodeStatus === "running") {
    state = "collecting";
  } else if (
    input.runState.nodeStatus === "failed"
    || input.runState.runStatus === "failed"
    || Boolean(result.value?.fetchError)
  ) {
    state = "failed";
  } else if (result.value?.completed === true) {
    state = "failed";
  }

  return {
    state,
    nodeAttempt: input.runState.nodeAttempt,
    nodeMaxAttempts: input.runState.nodeMaxAttempts,
    queryPlanAttempt: artifactGenerationMismatch
      ? undefined
      : queryPlan.attempt,
    qualityFailureReasons:
      !artifactGenerationMismatch && effectiveQuality?.passed === false
        ? [...effectiveQuality.reasons]
        : [],
    reformulationHint: artifactGenerationMismatch ? undefined : reformulation.hint,
    reasonCodes: uniqueStrings([
      ...generation.reasonCodes,
      ...(!artifactGenerationMismatch ? result.reasonCodes : []),
      ...(!artifactGenerationMismatch && !candidatePriorCollection
        ? quality.reasonCodes
        : []),
      ...(!artifactGenerationMismatch ? queryPlan.reasonCodes : []),
      ...(!artifactGenerationMismatch ? reformulation.reasonCodes : []),
      ...(!artifactGenerationMismatch && collectionFailureClass
        ? [collectionFailureClass]
        : []),
      ...(!artifactGenerationMismatch && effectiveQuality && !effectiveQuality.semanticsValid
        ? ["collect_corpus_quality_semantics_unsupported"]
        : []),
      ...(!artifactGenerationMismatch
        && !candidatePriorCollection
        && !effectiveQuality
        && result.value?.completed === true
        ? ["collect_corpus_quality_required"]
        : []),
      ...(artifactGenerationMismatch
        ? ["collect_artifact_generation_mismatch"]
        : []),
      ...(state === "quality_gate_exhausted"
        ? ["collect_papers_quality_gate_exhausted"]
        : [])
    ])
  };
}

function parseCollectionQualitySnapshot(raw: string | undefined): {
  value?: CollectionQualitySnapshot;
  reasonCodes: string[];
} {
  if (!raw?.trim()) {
    return { reasonCodes: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const quality = readCollectionQualityRecord(parsed);
    return quality
      ? { value: quality, reasonCodes: [] }
      : { reasonCodes: ["collect_corpus_quality_invalid"] };
  } catch {
    return { reasonCodes: ["collect_corpus_quality_invalid"] };
  }
}

function parseCollectionResultSnapshot(raw: string | undefined): {
  value?: CollectionResultSnapshot;
  reasonCodes: string[];
} {
  if (!raw?.trim()) {
    return { reasonCodes: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { reasonCodes: ["collect_result_invalid"] };
    }
    return {
      value: {
        ...(readText(parsed.collect_attempt_id)
          ? { attemptId: readText(parsed.collect_attempt_id) }
          : {}),
        ...(typeof parsed.completed === "boolean" ? { completed: parsed.completed } : {}),
        ...(readText(parsed.fetchError) ? { fetchError: readText(parsed.fetchError) } : {}),
        ...(readCollectionQualityRecord(parsed.corpusQuality)
          ? { quality: readCollectionQualityRecord(parsed.corpusQuality) }
          : {})
      },
      reasonCodes: []
    };
  } catch {
    return { reasonCodes: ["collect_result_invalid"] };
  }
}

function readCollectionQualityRecord(value: unknown): CollectionQualitySnapshot | undefined {
  if (!isRecord(value) || typeof value.passed !== "boolean" || !Array.isArray(value.reasons)) {
    return undefined;
  }
  const reasons = value.reasons.flatMap((reason) => {
    const text = readText(reason);
    return text ? [text] : [];
  });
  if (!value.passed && reasons.length === 0) {
    return undefined;
  }
  const semanticReview = isRecord(value.semantic_review)
    ? value.semantic_review
    : undefined;
  const semanticReviewStatus =
    semanticReview?.status === "complete"
    || semanticReview?.status === "partial"
    || semanticReview?.status === "operational_failure"
      ? semanticReview.status
      : undefined;
  const semanticsValid =
    value.version === TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION
    && value.strategy === TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY
    && value.term_normalization_version === TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
    && value.candidate_recall_semantics_version
      === TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION
    && Boolean(semanticReviewStatus)
    && (!value.passed || semanticReviewStatus === "complete");
  return {
    ...(readText(value.collect_attempt_id)
      ? { attemptId: readText(value.collect_attempt_id) }
      : {}),
    passed: value.passed,
    reasons: uniqueStrings(reasons),
    semanticsValid,
    ...(semanticReviewStatus ? { semanticReviewStatus } : {})
  };
}

function parseQueryPlanAttempt(raw: string | undefined): {
  attemptId?: string;
  attempt?: number;
  reasonCodes: string[];
} {
  if (!raw?.trim()) {
    return { reasonCodes: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { reasonCodes: ["collect_query_plan_invalid"] };
    }
    const planner = isRecord(parsed.planner) ? parsed.planner : undefined;
    const diagnostics = Array.isArray(planner?.attempt_diagnostics)
      ? planner.attempt_diagnostics
      : [];
    const attempts = diagnostics.flatMap((diagnostic) => {
      if (!isRecord(diagnostic) || !isPositiveInteger(diagnostic.attempt)) {
        return [];
      }
      return [diagnostic.attempt];
    });
    return {
      ...(readText(parsed.collect_attempt_id)
        ? { attemptId: readText(parsed.collect_attempt_id) }
        : {}),
      ...(attempts.length > 0 ? { attempt: Math.max(...attempts) } : {}),
      reasonCodes: []
    };
  } catch {
    return { reasonCodes: ["collect_query_plan_invalid"] };
  }
}

function parseCollectionReformulationHint(
  raw: string | undefined,
  artifactRefValue: ResearchFunnelProjectionArtifactRef | undefined,
  fallbackSemanticReviewStatus?: ResearchFunnelSemanticReviewStatus
): {
  attemptId?: string;
  hint?: ResearchFunnelReformulationHintProjection;
  reasonCodes: string[];
} {
  if (!raw?.trim()) {
    return { reasonCodes: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.evidence_status !== "query_hint_only") {
      return { reasonCodes: ["collect_query_reformulation_hints_invalid"] };
    }
    const sharedAnchorTerms = readStringArray(parsed.shared_anchor_terms);
    const candidateTitles = readStringArray(parsed.candidate_titles);
    const semanticReviewStatus =
      readSemanticReviewStatus(parsed.semantic_review_status)
      ?? fallbackSemanticReviewStatus
      ?? "complete";
    const failureClass =
      readCollectionFailureClass(parsed.failure_class)
      ?? failureClassForSemanticReviewStatus(semanticReviewStatus);
    const active =
      typeof parsed.active === "boolean"
        ? parsed.active
        : failureClass === "query_quality_failure";
    const feedbackApplied =
      typeof parsed.feedback_applied === "boolean"
        ? parsed.feedback_applied
        : active;
    const axes = Array.isArray(parsed.rejected_query_families)
      ? parsed.rejected_query_families.flatMap((family) => {
          if (!isRecord(family)) {
            return [];
          }
          const axisTerms = readStringArray(family.axis_terms);
          if (axisTerms.length === 0) {
            return [];
          }
          const queryFamily = readText(family.query_family);
          const query = readText(family.query);
          const relevantPaperCount = readNonNegativeInteger(family.relevant_paper_count);
          return [{
            ...(queryFamily ? { queryFamily } : {}),
            ...(query ? { query } : {}),
            axisTerms,
            ...(relevantPaperCount !== undefined ? { relevantPaperCount } : {})
          }];
        })
      : [];
    return {
      ...(readText(parsed.collect_attempt_id)
        ? { attemptId: readText(parsed.collect_attempt_id) }
        : {}),
      hint: {
        evidenceStatus: "query_hint_only",
        paperEvidenceAllowed: false,
        active,
        failureClass,
        feedbackApplied,
        semanticReviewStatus,
        sharedAnchorTerms,
        candidateTitles,
        axes,
        ...(artifactRefValue ? { artifactRef: artifactRefValue } : {})
      },
      reasonCodes: []
    };
  } catch {
    return { reasonCodes: ["collect_query_reformulation_hints_invalid"] };
  }
}

function hasCollectionArtifactGenerationMismatch(input: {
  collectGenerationRaw?: string;
  collectGenerationAttemptId?: string;
  collectResultRaw?: string;
  collectResultAttemptId?: string;
  qualityRaw?: string;
  qualityAttemptId?: string;
  queryPlanRaw?: string;
  queryPlanAttemptId?: string;
  reformulationHintsRaw?: string;
  reformulationHintsAttemptId?: string;
}): boolean {
  const artifacts = [
    {
      raw: input.collectGenerationRaw,
      attemptId: input.collectGenerationAttemptId
    },
    { raw: input.collectResultRaw, attemptId: input.collectResultAttemptId },
    { raw: input.qualityRaw, attemptId: input.qualityAttemptId },
    { raw: input.queryPlanRaw, attemptId: input.queryPlanAttemptId },
    { raw: input.reformulationHintsRaw, attemptId: input.reformulationHintsAttemptId }
  ].filter((artifact) => Boolean(artifact.raw?.trim()));
  const observedIds = artifacts.flatMap((artifact) =>
    artifact.attemptId ? [artifact.attemptId] : []
  );
  if (observedIds.length === 0) {
    return false;
  }
  return artifacts.some((artifact) => !artifact.attemptId)
    || new Set(observedIds).size !== 1;
}

function parseCollectionGenerationAttempt(raw: string | undefined): {
  attemptId?: string;
  reasonCodes: string[];
} {
  if (!raw?.trim()) {
    return { reasonCodes: [] };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { reasonCodes: ["collect_generation_invalid"] };
    }
    const attemptId = readText(parsed.collect_attempt_id);
    return attemptId
      ? { attemptId, reasonCodes: [] }
      : { reasonCodes: ["collect_generation_invalid"] };
  } catch {
    return { reasonCodes: ["collect_generation_invalid"] };
  }
}

async function loadCollectionRunState(runDir: string): Promise<CollectionRunStateSnapshot> {
  try {
    const raw = await fs.readFile(path.join(runDir, "run_record.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.graph)) {
      return {};
    }
    const graph = parsed.graph;
    const retryCounters = isRecord(graph.retryCounters) ? graph.retryCounters : {};
    const retryPolicy = isRecord(graph.retryPolicy) ? graph.retryPolicy : {};
    const nodeStates = isRecord(graph.nodeStates) ? graph.nodeStates : {};
    const collectState = isRecord(nodeStates.collect_papers) ? nodeStates.collect_papers : {};
    const failedAttempts = readNonNegativeInteger(retryCounters.collect_papers) ?? 0;
    const nodeStatus = readText(collectState.status);
    const nodeMaxAttempts = readPositiveInteger(retryPolicy.maxAttemptsPerNode);
    const currentAttempt =
      nodeStatus === "running"
      || nodeStatus === "completed"
      || nodeStatus === "needs_approval"
        ? failedAttempts + 1
        : nodeStatus === "failed"
          ? failedAttempts
          : 0;
    const nodeAttempt = nodeMaxAttempts !== undefined
      ? Math.min(currentAttempt, nodeMaxAttempts)
      : currentAttempt;
    return {
      ...(nodeAttempt > 0 ? { nodeAttempt } : {}),
      ...(nodeMaxAttempts !== undefined ? { nodeMaxAttempts } : {}),
      ...(nodeStatus ? { nodeStatus } : {}),
      ...(readText(parsed.status) ? { runStatus: readText(parsed.status) } : {})
    };
  } catch {
    return {};
  }
}

function readCollectionFailureClass(
  value: unknown
): ResearchFunnelCollectionFailureClass | undefined {
  return value === "query_quality_failure"
    || value === "semantic_review_operational_failure"
    || value === "semantic_review_incomplete"
    ? value
    : undefined;
}

function readSemanticReviewStatus(
  value: unknown
): ResearchFunnelSemanticReviewStatus | undefined {
  return value === "complete"
    || value === "partial"
    || value === "operational_failure"
    ? value
    : undefined;
}

function failureClassForSemanticReviewStatus(
  status: ResearchFunnelSemanticReviewStatus | undefined
): ResearchFunnelCollectionFailureClass {
  if (status === "operational_failure") {
    return "semantic_review_operational_failure";
  }
  if (status === "partial") {
    return "semantic_review_incomplete";
  }
  return "query_quality_failure";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.flatMap((item) => {
    const textValue = readText(item);
    return textValue ? [textValue] : [];
  }));
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return isNonNegativeInteger(value) ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return isPositiveInteger(value) ? value : undefined;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function collectLiteratureQueryProjection(raw: string | undefined): {
  literatureQueries: ResearchFunnelLiteratureQueryProjection[];
  queryFallbackUsed: boolean;
  queryFallbackReasons: string[];
} {
  if (!raw?.trim()) {
    return {
      literatureQueries: [],
      queryFallbackUsed: false,
      queryFallbackReasons: []
    };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("collect_result_not_object");
    }
    const attempts = Array.isArray(parsed.queryAttempts) ? parsed.queryAttempts : [];
    const literatureQueries = attempts.flatMap((value) => {
      if (!isRecord(value)) {
        return [];
      }
      const query = readText(value.query);
      if (!query) {
        return [];
      }
      const source = readQuerySource(value.source);
      const sourceReason = readText(value.sourceReason) || "unspecified";
      const fallback = source === "deterministic_query" || isFallbackReason(sourceReason);
      return [{
        query,
        source,
        sourceReason,
        reason: readText(value.reason) || "unspecified",
        fallback,
        filtersRelaxed: value.filtersRelaxed === true,
        ...(readFiniteNumber(value.allocatedLimit) !== undefined
          ? { allocatedLimit: readFiniteNumber(value.allocatedLimit) }
          : {}),
        ...(readFiniteNumber(value.retrievalLimit) !== undefined
          ? { retrievalLimit: readFiniteNumber(value.retrievalLimit) }
          : {}),
        ...(readFiniteNumber(value.fetched) !== undefined
          ? { fetched: readFiniteNumber(value.fetched) }
          : {}),
        ...(readFiniteNumber(value.relevantFetched) !== undefined
          ? { relevantFetched: readFiniteNumber(value.relevantFetched) }
          : {}),
        ...(readFiniteNumber(value.selected) !== undefined
          ? { selected: readFiniteNumber(value.selected) }
          : {})
      }];
    });
    const fallbackReasons = literatureQueries
      .filter((attempt) => attempt.fallback)
      .map((attempt) => attempt.sourceReason);
    const fallbackAttempts = readFiniteNumber(parsed.fallbackAttempts) ?? 0;
    const persistedFallbackSources = Array.isArray(parsed.fallbackSources)
      ? parsed.fallbackSources.flatMap((value) => {
          const text = readText(value);
          return text ? [text] : [];
        })
      : [];
    return {
      literatureQueries,
      queryFallbackUsed: fallbackAttempts > 0 || fallbackReasons.length > 0,
      queryFallbackReasons: uniqueStrings([...fallbackReasons, ...persistedFallbackSources])
    };
  } catch {
    return {
      literatureQueries: [],
      queryFallbackUsed: false,
      queryFallbackReasons: ["collect_result_invalid"]
    };
  }
}

function readQuerySource(
  value: unknown
): ResearchFunnelLiteratureQueryProjection["source"] {
  return value === "requested_query"
    || value === "llm_query_planner"
    || value === "deterministic_query"
    ? value
    : "unknown";
}

function isFallbackReason(value: string): boolean {
  return /fallback|timeout|invalid|unavailable/iu.test(value);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

type CandidatePriorSearchDecisionAction = NonNullable<
  ResearchFunnelCandidatePriorSearchProjection["action"]
>;

interface CandidatePriorSearchDecisionProjectionSource {
  run_id: string;
  research_cycle: number;
  collect_attempt_id: string;
  completed_rounds: number;
  max_rounds: number;
  current_receipt_status: "not_applicable" | "valid" | "invalid";
  action: CandidatePriorSearchDecisionAction;
  candidates: Array<{
    candidate_id: string;
    prior_absorption_contract_sha256: string;
    reason_codes: string[];
    absorbed_by_prior: boolean;
    covered_by_valid_receipt: boolean;
    selected_for_search: boolean;
  }>;
  plan_content_sha256?: string;
  lineage_failure?: string;
  content_sha256: string;
}

async function projectCandidatePriorSearch(input: {
  runDir: string;
  expectedRunId: string;
  expectedResearchCycle: number;
  currentCorpusRaw?: string;
  queryPlanRaw?: string;
  decisionRead: ArtifactRead;
  pendingPlanRead: ArtifactRead;
  collectPlanRead: ArtifactRead;
  receiptRead: ArtifactRead;
  requiredCandidateIds: string[];
  expectedCandidateContractHashes: ReadonlyMap<string, string>;
}): Promise<ResearchFunnelCandidatePriorSearchProjection> {
  const refs = artifactRefs([
    ["candidatePriorSearchDecision", input.decisionRead],
    ["candidatePriorSearchPendingPlan", input.pendingPlanRead],
    ["candidatePriorSearchCollectPlan", input.collectPlanRead],
    ["candidatePriorSearchReceipt", input.receiptRead]
  ]);
  const reads = [
    input.decisionRead,
    input.pendingPlanRead,
    input.collectPlanRead,
    input.receiptRead
  ];
  const anyMeasured = reads.some((read) => read.status !== "missing");
  if (!anyMeasured) {
    return {
      status: "unmeasured",
      trusted: false,
      completedRounds: 0,
      maxRounds: 0,
      currentReceiptStatus: "unmeasured",
      candidateCount: 0,
      selectedCandidateCount: 0,
      broadLaneAttemptCount: 0,
      recentLaneAttemptCount: 0,
      fetchedCount: 0,
      selectedPaperCount: 0,
      coveredCandidateIds: [],
      reasonCodes: [],
      artifactRefs: []
    };
  }

  const reasons = readErrorReasons(reads);
  const decisionResult = parseCandidatePriorSearchDecision(
    readRaw(input.decisionRead),
    input.expectedRunId,
    input.expectedResearchCycle
  );
  reasons.push(...decisionResult.reasons);
  const decision = decisionResult.decision;
  let plan: CandidatePriorSearchPlan | undefined;
  let receipt: CandidatePriorSearchReceipt | undefined;

  if (decision?.action === "request_collection") {
    const pendingPlanValidation = validateCandidatePriorPlanRead(
      readRaw(input.pendingPlanRead),
      "pending",
      input.expectedRunId,
      input.expectedResearchCycle
    );
    reasons.push(...pendingPlanValidation.reasons);
    plan = pendingPlanValidation.plan;
    if (
      plan
      && decision.plan_content_sha256 !== plan.content_sha256
    ) {
      reasons.push("candidate_prior_search_pending_plan_binding_mismatch");
    }
  }

  if (decision?.current_receipt_status === "valid") {
    const collectPlanValidation = validateCandidatePriorPlanRead(
      readRaw(input.collectPlanRead),
      "collect",
      input.expectedRunId,
      input.expectedResearchCycle - 1
    );
    reasons.push(...collectPlanValidation.reasons);
    plan = collectPlanValidation.plan ?? plan;
    const queryPlan = parseJsonRecord(input.queryPlanRaw);
    if (
      !queryPlan
      || queryPlan.strategy !== "candidate_prior_portfolio"
      || queryPlan.collect_attempt_id !== decision.collect_attempt_id
      || !plan
      || !isRecord(queryPlan.candidate_prior_search_plan)
      || queryPlan.candidate_prior_search_plan.content_sha256 !== plan.content_sha256
    ) {
      reasons.push("candidate_prior_search_projection_query_plan_binding_mismatch");
    }
    const sourceCorpusRead = plan
      ? await readArtifact(input.runDir, {
          path: path.join(
            "collect_attempts",
            plan.source_corpus.collect_attempt_id,
            "corpus.jsonl"
          ),
          readErrorPrefix: "candidate_prior_search_source_corpus_archive"
        })
      : { status: "missing" } as ArtifactRead;
    reasons.push(...readErrorReasons([sourceCorpusRead]));
    if (
      plan
      && sourceCorpusRead.status === "read"
      && input.currentCorpusRaw !== undefined
    ) {
      const receiptValue = parseJsonRecord(readRaw(input.receiptRead));
      const receiptValidation = validateCandidatePriorSearchReceipt(
        receiptValue,
        {
          plan,
          expectedCollectAttemptId: decision.collect_attempt_id,
          sourceCorpusRaw: sourceCorpusRead.raw,
          resultCorpusRaw: input.currentCorpusRaw
        }
      );
      reasons.push(
        ...receiptValidation.reasons.map(
          (reason) => `candidate_prior_search_projection_receipt_invalid:${reason}`
        )
      );
      receipt = receiptValidation.valid
        ? receiptValidation.receipt
        : undefined;
    } else {
      reasons.push(
        sourceCorpusRead.status === "missing"
          ? "candidate_prior_search_projection_source_corpus_missing"
          : "candidate_prior_search_projection_result_corpus_missing"
      );
    }
  } else if (decision?.current_receipt_status === "invalid") {
    reasons.push("candidate_prior_search_projection_receipt_declared_invalid");
  }

  if (decision?.lineage_failure) {
    reasons.push(decision.lineage_failure);
  }
  const decisionCandidatesById = new Map(
    (decision?.candidates ?? []).map((candidate) => [candidate.candidate_id, candidate] as const)
  );
  for (const candidateId of uniqueStrings(input.requiredCandidateIds)) {
    const decisionCandidate = decisionCandidatesById.get(candidateId);
    if (!decisionCandidate) {
      reasons.push(`candidate_prior_search_projection_required_candidate_missing:${candidateId}`);
      continue;
    }
    const expectedContractHash = input.expectedCandidateContractHashes.get(candidateId);
    if (!expectedContractHash) {
      reasons.push(`candidate_prior_search_projection_candidate_contract_missing:${candidateId}`);
    } else if (
      decisionCandidate.prior_absorption_contract_sha256 !== expectedContractHash
    ) {
      reasons.push(`candidate_prior_search_projection_candidate_contract_mismatch:${candidateId}`);
    }
    if (!decisionCandidate.covered_by_valid_receipt) {
      reasons.push(`candidate_prior_search_projection_candidate_not_covered:${candidateId}`);
    }
  }
  const integrityReasons = uniqueStrings(reasons);
  const decisionReasonCodes: string[] = [];
  if (
    decision?.action === "request_collection"
    || decision?.action === "exhausted"
    || decision?.action === "blocked_invalid_lineage"
  ) {
    decisionReasonCodes.push(
      ...decision.candidates.flatMap((candidate) => candidate.reason_codes)
    );
  }
  const projectedReasonCodes = uniqueStrings([
    ...integrityReasons,
    ...decisionReasonCodes
  ]);
  const trusted = Boolean(
    decision
    && integrityReasons.length === 0
    && decision.action !== "blocked_invalid_lineage"
    && decision.current_receipt_status !== "invalid"
  );
  const status: ResearchFunnelCandidatePriorSearchProjection["status"] = !decision
    || !trusted
      ? "blocked"
      : decision.action === "request_collection"
        ? "search_required"
        : decision.action === "exhausted"
          ? "exhausted"
          : "complete";
  const attempts = receipt?.candidates.flatMap((candidate) => candidate.attempts) ?? [];
  const pendingLanes = !receipt && plan
    ? plan.candidates.flatMap((candidate) =>
        candidate.families.flatMap((family) => family.lanes)
      )
    : [];
  const laneSources = attempts.length > 0 ? attempts : pendingLanes;
  return {
    status,
    trusted,
    ...(decision ? { action: decision.action } : {}),
    completedRounds: decision?.completed_rounds ?? 0,
    maxRounds: decision?.max_rounds ?? 0,
    currentReceiptStatus: decision?.current_receipt_status ?? "unmeasured",
    candidateCount: decision?.candidates.length ?? 0,
    selectedCandidateCount:
      decision?.candidates.filter((candidate) => candidate.selected_for_search).length ?? 0,
    broadLaneAttemptCount: laneSources.filter(
      (attempt) => attempt.retrieval_lane === "broad_relevance"
    ).length,
    recentLaneAttemptCount: laneSources.filter(
      (attempt) => attempt.retrieval_lane === "recent_direct_prior"
    ).length,
    fetchedCount: attempts.reduce((sum, attempt) => sum + attempt.fetched, 0),
    selectedPaperCount: attempts.reduce((sum, attempt) => sum + attempt.selected, 0),
    coveredCandidateIds: uniqueStrings(
      (decision?.candidates ?? [])
        .filter((candidate) => candidate.covered_by_valid_receipt)
        .map((candidate) => candidate.candidate_id)
    ),
    ...(plan?.content_sha256
      ? { planHash: plan.content_sha256 }
      : decision?.plan_content_sha256
        ? { planHash: decision.plan_content_sha256 }
        : {}),
    ...(receipt?.content_sha256 ? { receiptHash: receipt.content_sha256 } : {}),
    reasonCodes: projectedReasonCodes,
    artifactRefs: refs
  };
}

function projectEstimatorFeasibility(input: {
  audit: Awaited<ReturnType<typeof loadPersistedEstimatorFeasibilityAudit>>;
  candidateExperimentRead: ArtifactRead;
  contractRead: ArtifactRead;
  reportRead: ArtifactRead;
  executableExperimentRead: ArtifactRead;
}): ResearchFunnelEstimatorFeasibilityProjection {
  const report = input.audit.estimator_report;
  const contract = input.audit.estimator_contract;
  return {
    status: input.audit.status,
    trusted: input.audit.trusted,
    executionAuthorized: input.audit.execution_authorized,
    ...(contract?.estimand.type ? { estimandType: contract.estimand.type } : {}),
    ...(contract?.estimator.family
      ? { estimatorFamily: contract.estimator.family }
      : {}),
    ...(report
      ? {
          independentClusterCount: report.metrics.independent_cluster_count,
          primaryDenominator: report.metrics.primary_denominator,
          ...(report.metrics.computed_minimum_detectable_effect !== null
            ? {
                computedMinimumDetectableEffect:
                  report.metrics.computed_minimum_detectable_effect
              }
            : {})
        }
      : {}),
    ...(contract
      ? {
          attainableResolution: contract.outcome.attainable_resolution,
          plannedMinimumDetectableEffect:
            contract.power.minimum_detectable_effect
        }
      : {}),
    reasonCodes: [...input.audit.reason_codes],
    artifactRefs: artifactRefs([
      ["estimatorCandidateExperimentContract", input.candidateExperimentRead],
      ["estimatorContract", input.contractRead],
      ["estimatorReport", input.reportRead],
      ["executableExperimentContract", input.executableExperimentRead]
    ])
  };
}

async function loadEstimatorFeasibilityAuditSafely(input: {
  runDir: string;
  runId: string;
  expectedResearchCycle?: number;
}): Promise<Awaited<ReturnType<typeof loadPersistedEstimatorFeasibilityAudit>>> {
  try {
    return await loadPersistedEstimatorFeasibilityAudit(input);
  } catch (error) {
    const code = isNodeError(error) && error.code
      ? error.code.toLowerCase()
      : "unknown";
    return {
      measured: true,
      trusted: false,
      status: "invalid",
      execution_authorized: false,
      reason_codes: [`estimator_audit_read_error:${code}`]
    };
  }
}

function validateCandidatePriorPlanRead(
  raw: string | undefined,
  source: "pending" | "collect",
  expectedRunId: string,
  expectedResearchCycle: number
): { plan?: CandidatePriorSearchPlan; reasons: string[] } {
  if (!raw) {
    return {
      reasons: [`candidate_prior_search_projection_${source}_plan_missing`]
    };
  }
  const validation = validateCandidatePriorSearchPlanIntegrity(parseJsonRecord(raw));
  const reasons = validation.reasons.map(
    (reason) => `candidate_prior_search_projection_${source}_plan_invalid:${reason}`
  );
  if (validation.plan?.run_id !== expectedRunId) {
    reasons.push(`candidate_prior_search_projection_${source}_plan_run_mismatch`);
  }
  if (validation.plan?.research_cycle !== expectedResearchCycle) {
    reasons.push(`candidate_prior_search_projection_${source}_plan_cycle_mismatch`);
  }
  return {
    ...(validation.valid && validation.plan && reasons.length === 0
      ? { plan: validation.plan }
      : {}),
    reasons
  };
}

function parseCandidatePriorSearchDecision(
  raw: string | undefined,
  expectedRunId: string,
  expectedResearchCycle: number
): { decision?: CandidatePriorSearchDecisionProjectionSource; reasons: string[] } {
  if (!raw) {
    return { reasons: ["candidate_prior_search_projection_decision_missing"] };
  }
  const value = parseJsonRecord(raw);
  if (!value) {
    return { reasons: ["candidate_prior_search_projection_decision_invalid_json"] };
  }
  const actions = new Set<CandidatePriorSearchDecisionAction>([
    "request_collection",
    "already_searched",
    "exhausted",
    "not_required",
    "blocked_invalid_lineage"
  ]);
  const receiptStatuses = new Set(["not_applicable", "valid", "invalid"]);
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  const structurallyValid =
    value.schema_version === 1
    && value.artifact_kind === "candidate_prior_search_decision"
    && hasText(value.run_id)
    && isNonNegativeInteger(value.research_cycle)
    && typeof value.collect_attempt_id === "string"
    && isNonNegativeInteger(value.completed_rounds)
    && isNonNegativeInteger(value.max_rounds)
    && value.completed_rounds <= value.max_rounds
    && receiptStatuses.has(String(value.current_receipt_status))
    && actions.has(value.action as CandidatePriorSearchDecisionAction)
    && isSha256(value.content_sha256)
    && candidates.every((candidate) =>
      isRecord(candidate)
      && hasText(candidate.candidate_id)
      && isSha256(candidate.prior_absorption_contract_sha256)
      && Array.isArray(candidate.reason_codes)
      && candidate.reason_codes.every(hasText)
      && typeof candidate.absorbed_by_prior === "boolean"
      && typeof candidate.covered_by_valid_receipt === "boolean"
      && typeof candidate.selected_for_search === "boolean"
    )
    && (value.plan_content_sha256 === undefined || isSha256(value.plan_content_sha256))
    && (value.lineage_failure === undefined || hasText(value.lineage_failure));
  if (!structurallyValid) {
    return { reasons: ["candidate_prior_search_projection_decision_schema_invalid"] };
  }
  const { content_sha256: declaredHash, ...payload } = value;
  const reasons: string[] = [];
  if (hashCanonical(payload) !== declaredHash) {
    reasons.push("candidate_prior_search_projection_decision_hash_mismatch");
  }
  if (value.run_id !== expectedRunId) {
    reasons.push("candidate_prior_search_projection_decision_run_mismatch");
  }
  if (value.research_cycle !== expectedResearchCycle) {
    reasons.push("candidate_prior_search_projection_decision_cycle_mismatch");
  }
  if (new Set(candidates.map((candidate) => (candidate as Record<string, unknown>).candidate_id)).size !== candidates.length) {
    reasons.push("candidate_prior_search_projection_candidate_duplicate");
  }
  return {
    decision: value as unknown as CandidatePriorSearchDecisionProjectionSource,
    reasons
  };
}

function parseJsonRecord(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function projectTopicMemory(input: {
  portfolioRead: ArtifactRead;
  portfolio: TopicPortfolio | undefined;
  auditRead: ArtifactRead;
  updateRead: ArtifactRead;
}): ResearchFunnelTopicMemoryProjection {
  const auditArtifactRef = artifactRef("topicMemoryAudit", input.auditRead);
  const updateArtifactRef = artifactRef("topicMemoryUpdate", input.updateRead);
  if (input.portfolioRead.status === "missing") {
    return {
      status: "unmeasured",
      trusted: false,
      recordCount: 0,
      blockedCandidateCount: 0,
      reentryRequiredCount: 0,
      reentryAllowedCount: 0,
      ...(auditArtifactRef ? { auditArtifactRef } : {}),
      ...(updateArtifactRef ? { updateArtifactRef } : {})
    };
  }
  const ledger = input.portfolio?.topic_memory_ledger;
  if (!input.portfolio || !ledger) {
    return {
      status: "blocked",
      trusted: false,
      recordCount: 0,
      blockedCandidateCount: 0,
      reentryRequiredCount: 0,
      reentryAllowedCount: 0,
      ...(auditArtifactRef ? { auditArtifactRef } : {}),
      ...(updateArtifactRef ? { updateArtifactRef } : {})
    };
  }
  const decisions = input.portfolio.candidates.map(
    (candidate) => candidate.topic_memory!.decision
  );
  return {
    status: "verified",
    trusted: true,
    ledgerHash: ledger.ledger_sha256,
    recordCount: ledger.records.length,
    blockedCandidateCount: decisions.filter((decision) => decision.blocked).length,
    reentryRequiredCount: decisions.filter(
      (decision) => decision.disposition === "requires_reentry_adjudication"
    ).length,
    reentryAllowedCount: decisions.filter(
      (decision) => decision.disposition === "reentry_allowed"
    ).length,
    ...(auditArtifactRef ? { auditArtifactRef } : {}),
    ...(updateArtifactRef ? { updateArtifactRef } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readArtifact(
  runDir: string,
  artifact: { path: string; readErrorPrefix: string }
): Promise<ArtifactRead> {
  try {
    return {
      status: "read",
      raw: await fs.readFile(path.join(runDir, artifact.path), "utf8")
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "missing" };
    }
    const errorCode = isNodeError(error) && error.code ? `:${error.code.toLowerCase()}` : "";
    return {
      status: "read_error",
      reasonCode: `${artifact.readErrorPrefix}_read_error${errorCode}`
    };
  }
}

function readRaw(read: ArtifactRead): string | undefined {
  return read.status === "read" ? read.raw : undefined;
}

function readErrorReasons(reads: ArtifactRead[]): string[] {
  return reads.flatMap((read) => read.status === "read_error" ? [read.reasonCode] : []);
}

async function loadResearchCycle(runDir: string): Promise<number> {
  try {
    const raw = await fs.readFile(path.join(runDir, "run_record.json"), "utf8");
    const parsed = JSON.parse(raw) as { graph?: { researchCycle?: unknown } };
    const cycle = parsed.graph?.researchCycle;
    return typeof cycle === "number" && Number.isInteger(cycle) && cycle >= 0 ? cycle : 0;
  } catch {
    return 0;
  }
}

function artifactRefs(entries: Array<readonly [ArtifactKey, ArtifactRead]>): ResearchFunnelProjectionArtifactRef[] {
  return entries
    .filter(([, read]) => read.status !== "missing")
    .map(([key]) => ({
      label: ARTIFACTS[key].label,
      path: ARTIFACTS[key].path
    }));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
