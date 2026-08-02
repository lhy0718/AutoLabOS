import { randomUUID } from "node:crypto";

import { EventStream } from "./events.js";
import type { RiskSignal } from "./analysis/riskSignals.js";
import { parseStructuredModelJsonObject } from "./analysis/modelJson.js";
import {
  LLMClient,
  LLMCompletionUsage,
  type LLMCompletionProvenance
} from "./llm/client.js";
import { hashCanonical } from "./canonicalHash.js";
import type { GateFinding } from "./researchGovernanceArtifacts.js";
import {
  hashModelReviewAdjudicatorInput,
  hashModelReviewOutput,
  REQUIRED_MODEL_REVIEW_ROLES,
  validateModelReviewBundle,
  type ModelReviewBundle,
  type ModelReviewAdjudicator,
  type ModelReviewGateBinding,
  type ModelReviewerProvenance,
  type ModelReviewRole,
  type ModelSpecialistReview
} from "./modelReviewProtocol.js";
import type { FigureAuditSummary } from "./exploration/types.js";
import {
  AnalysisFailureCategory,
  AnalysisPaperClaim,
  AnalysisReport,
  resolvePrimaryResultsArtifactComparison
} from "./resultAnalysis.js";
import { RunRecord, GraphNodeId } from "../types.js";
import { loadReviewPromptSections } from "./nodePrompts.js";

export type ReviewDimension =
  | "claim_verification"
  | "methodology"
  | "statistics"
  | "reproducibility"
  | "adversarial"
  | "writing_readiness"
  | "integrity";

export type ReviewSeverity = "low" | "medium" | "high";
export type ReviewRecommendation =
  | "advance"
  | "revise_in_place"
  | "backtrack_to_hypotheses"
  | "backtrack_to_design"
  | "backtrack_to_implement"
  | "manual_block";

export type ReviewAgreement = "high" | "medium" | "low";
export type ReviewBiasKind =
  | "positive_outcome_bias"
  | "verbosity_imbalance"
  | "consensus_gap"
  | "concern_acceptance_conflict";

export interface ReviewArtifactPresence {
  corpusPresent: boolean;
  paperSummariesPresent: boolean;
  evidenceStorePresent: boolean;
  hypothesesPresent: boolean;
  experimentPlanPresent: boolean;
  metricsPresent: boolean;
  figurePresent: boolean;
  synthesisPresent: boolean;
  baselineSummaryPresent: boolean;
  resultTablePresent: boolean;
  richnessSummaryPresent: boolean;
  richnessReadiness: "adequate" | "marginal" | "insufficient" | "unknown";
}

export interface ReviewFinding {
  id: string;
  reviewer_id: string;
  reviewer_label: string;
  dimension: ReviewDimension;
  severity: ReviewSeverity;
  title: string;
  detail: string;
  claim_ids: string[];
  evidence_paths: string[];
  fix_hint?: string;
  confidence: number;
}

export interface PaperSurfaceReviewIssue {
  code: string;
  detail: string;
  evidence_path: string;
  severity?: ReviewSeverity;
}

export interface SpecialistReviewResult {
  reviewer_id: string;
  reviewer_label: string;
  dimension: ReviewDimension;
  score_1_to_5: number;
  confidence: number;
  recommendation: ReviewRecommendation;
  summary: string;
  findings: ReviewFinding[];
  source: "heuristic" | "llm+heuristic";
}

export interface ReviewScorecardDimension {
  dimension: ReviewDimension;
  label: string;
  score_1_to_5: number;
  confidence: number;
  summary: string;
  top_finding_ids: string[];
}

export interface ReviewScorecard {
  overall_score_1_to_5: number;
  dimensions: ReviewScorecardDimension[];
}

export interface ReviewConsistencyReport {
  panel_agreement: ReviewAgreement;
  pairwise_recommendation_agreement: number;
  score_spread: number;
  recommendation_histogram: Record<string, number>;
  conflicts: string[];
  summary: string;
}

export interface ReviewBiasFlag {
  kind: ReviewBiasKind;
  severity: ReviewSeverity;
  detail: string;
}

export interface ReviewBiasReport {
  flags: ReviewBiasFlag[];
  summary: string;
}

export interface ReviewRevisionPlanItem {
  id: string;
  priority: ReviewSeverity;
  owner: "analysis" | "design" | "implementation" | "writing" | "human_review";
  title: string;
  action: string;
  source_finding_ids: string[];
}

export interface ReviewRevisionPlan {
  items: ReviewRevisionPlanItem[];
  summary: string;
}

export interface ReviewDecision {
  outcome: ReviewRecommendation;
  recommended_transition?: "advance" | "backtrack_to_hypotheses" | "backtrack_to_design" | "backtrack_to_implement";
  confidence: number;
  summary: string;
  rationale: string;
  blocking_finding_ids: string[];
  required_actions: string[];
}

export interface ReviewPanelResult {
  reviewers: SpecialistReviewResult[];
  findings: ReviewFinding[];
  scorecard: ReviewScorecard;
  consistency: ReviewConsistencyReport;
  bias: ReviewBiasReport;
  revision_plan: ReviewRevisionPlan;
  decision: ReviewDecision;
  llm_calls_used: number;
  llm_cost_usd?: number;
  llm_input_tokens?: number;
  llm_output_tokens?: number;
  meta_review?: SpecialistReviewResult;
  model_review_bundle?: ModelReviewBundle;
  assurance: ReviewAssurance;
}

export interface ReviewActorProfile {
  provider: string;
  model: string;
  reasoning_effort: string;
}

export interface ReviewAgentBinding {
  llm: LLMClient;
  profile: ReviewActorProfile;
}

export type ReviewAssuranceClass =
  | "runtime_attested_actor_diverse_panel_with_meta_review"
  | "runtime_attested_context_isolated_panel_with_meta_review"
  | "role_separated_panel"
  | "heuristic_only";

export interface ReviewAssurance {
  schema_version: 1;
  required_for_paper_ready: boolean;
  assurance_class: ReviewAssuranceClass;
  requested_specialist_roles: ModelReviewRole[];
  completed_model_specialist_roles: ModelReviewRole[];
  heuristic_fallback_roles: ModelReviewRole[];
  transport_receipt_failure_roles: ModelReviewRole[];
  meta_review_completed: boolean;
  unique_actor_count: number;
  unique_execution_count: number;
  provider_response_receipt_count: number;
  adapter_attested_receipt_count: number;
  isolation_evidence: "runtime_attested" | "unverified";
  model_review_bundle_valid: boolean;
  paper_ready_eligible: boolean;
  reason_codes: string[];
  model_review_bundle_content_sha256: string | null;
  gate_report_content_sha256: string | null;
  review_input_manifest_content_sha256: string | null;
  content_sha256: string;
}

interface ReviewPanelArgs {
  run: Pick<RunRecord, "id" | "title" | "topic" | "objectiveMetric" | "constraints">;
  node: GraphNodeId;
  report: AnalysisReport;
  presence: ReviewArtifactPresence;
  orphanCitations?: string[];
  paperSurfaceIssues?: PaperSurfaceReviewIssue[];
  riskSignals?: RiskSignal[];
  figureAuditSummary?: FigureAuditSummary;
  llm: LLMClient;
  specialistAgent?: ReviewAgentBinding;
  metaReviewer?: ReviewAgentBinding;
  gateBinding?: ModelReviewGateBinding;
  inputManifestBinding?: ModelReviewGateBinding;
  requireIndependentReview?: boolean;
  eventStream?: EventStream;
  abortSignal?: AbortSignal;
}

interface ReviewerSpec {
  reviewer_id: string;
  reviewer_label: string;
  dimension: ReviewDimension;
  model_review_role: ModelReviewRole;
  buildFallback: (report: AnalysisReport, presence: ReviewArtifactPresence) => SpecialistReviewResult;
}

interface RawReviewerFinding {
  title?: unknown;
  severity?: unknown;
  detail?: unknown;
  evidence_paths?: unknown;
  claim_ids?: unknown;
  fix_hint?: unknown;
  confidence?: unknown;
}

interface RawReviewerResponse {
  summary?: unknown;
  score_1_to_5?: unknown;
  confidence?: unknown;
  recommendation?: unknown;
  findings?: unknown;
}

const REVIEWER_SPECS: ReviewerSpec[] = [
  {
    reviewer_id: "claim_verifier",
    reviewer_label: "Claim verifier",
    dimension: "claim_verification",
    model_review_role: "claim_evidence",
    buildFallback: buildClaimVerificationFallback
  },
  {
    reviewer_id: "methodology_reviewer",
    reviewer_label: "Methodology reviewer",
    dimension: "methodology",
    model_review_role: "methodology",
    buildFallback: buildMethodologyFallback
  },
  {
    reviewer_id: "statistics_reviewer",
    reviewer_label: "Statistics reviewer",
    dimension: "statistics",
    model_review_role: "statistics",
    buildFallback: buildStatisticsFallback
  },
  {
    reviewer_id: "reproducibility_reviewer",
    reviewer_label: "Reproducibility reviewer",
    dimension: "reproducibility",
    model_review_role: "reproducibility",
    buildFallback: buildReproducibilityFallback
  },
  {
    reviewer_id: "adversarial_reviewer",
    reviewer_label: "Adversarial reviewer",
    dimension: "adversarial",
    model_review_role: "adversarial",
    buildFallback: buildAdversarialFallback
  }
];

const DEFAULT_REVIEW_REFINEMENT_TIMEOUT_MS = 20_000;

interface ReviewerRefinement {
  result: SpecialistReviewResult;
  usedLlm: boolean;
  costUsd?: number;
  usage?: LLMCompletionUsage;
  modelReview?: ModelSpecialistReview;
}

interface MetaReviewerRefinement {
  result: SpecialistReviewResult;
  usedLlm: boolean;
  costUsd?: number;
  usage?: LLMCompletionUsage;
  adjudicator?: ModelReviewAdjudicator;
}

export async function runReviewPanel(args: ReviewPanelArgs): Promise<ReviewPanelResult> {
  const reviewers: SpecialistReviewResult[] = [];
  const modelReviews: ModelSpecialistReview[] = [];
  const transportReceiptFailureRoles: ModelReviewRole[] = [];
  let llmCallsUsed = 0;
  let llmCostUsd = 0;
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  const specialistAgent = args.specialistAgent ?? {
    llm: args.llm,
    profile: unverifiedReviewActorProfile()
  };

  for (const spec of REVIEWER_SPECS) {
    args.eventStream?.emit({
      type: "OBS_RECEIVED",
      runId: args.run.id,
      node: args.node,
      agentRole: "reviewer",
      payload: {
        text: `Review panel: running ${spec.reviewer_label.toLowerCase()}.`
      }
    });

    const fallback = spec.buildFallback(args.report, args.presence);
    const refined = await refineReviewerWithLlm(args, specialistAgent, spec, fallback);
    if (refined.usedLlm) {
      llmCallsUsed += 1;
      llmCostUsd += refined.costUsd ?? 0;
      llmInputTokens += refined.usage?.inputTokens ?? 0;
      llmOutputTokens += refined.usage?.outputTokens ?? 0;
    }
    reviewers.push(refined.result);
    if (refined.modelReview) {
      modelReviews.push(refined.modelReview);
    } else if (refined.usedLlm) {
      transportReceiptFailureRoles.push(spec.model_review_role);
    }
  }

  let metaReview: SpecialistReviewResult | undefined;
  let adjudicator: ModelReviewAdjudicator | undefined;
  let metaTransportReceiptFailed = false;
  if (
    args.gateBinding
    && args.metaReviewer
    && modelReviews.length === REQUIRED_MODEL_REVIEW_ROLES.length
  ) {
    const meta = await refineMetaReviewerWithLlm(args, args.metaReviewer, reviewers, modelReviews);
    metaReview = meta.result;
    adjudicator = meta.adjudicator;
    metaTransportReceiptFailed = meta.usedLlm && !meta.adjudicator;
    if (meta.usedLlm) {
      llmCallsUsed += 1;
      llmCostUsd += meta.costUsd ?? 0;
      llmInputTokens += meta.usage?.inputTokens ?? 0;
      llmOutputTokens += meta.usage?.outputTokens ?? 0;
    }
  }

  const modelReviewBundle = args.gateBinding && adjudicator
    ? buildModelReviewBundle(args.gateBinding, modelReviews, adjudicator)
    : undefined;
  const assurance = buildReviewAssurance({
    modelReviews,
    metaReviewCompleted: Boolean(adjudicator),
    modelReviewBundle,
    gateBindingPresent: Boolean(args.gateBinding),
    metaReviewerPresent: Boolean(args.metaReviewer),
    transportReceiptFailureRoles,
    gateBinding: args.gateBinding,
    inputManifestBinding: args.inputManifestBinding,
    metaTransportReceiptFailed,
    requireIndependentReview: args.requireIndependentReview === true
  });
  const assuranceFindings = args.requireIndependentReview === true && !assurance.paper_ready_eligible
    ? [buildReviewAssuranceFinding(assurance)]
    : [];
  const findings = dedupeFindings([
    ...reviewers.flatMap((reviewer) => reviewer.findings),
    ...(metaReview?.findings ?? []),
    ...buildPaperSurfaceFindings(args.paperSurfaceIssues ?? []),
    ...assuranceFindings
  ]);
  const scorecard = buildScorecard(reviewers);
  const consistency = buildConsistencyReport(reviewers, findings);
  const bias = buildBiasReport(args.report, reviewers, findings, consistency);
  const revisionPlan = buildRevisionPlan(findings);
  const decision = buildDecision(args.report, reviewers, findings, consistency, bias, revisionPlan);

  return {
    reviewers,
    findings,
    scorecard,
    consistency,
    bias,
    revision_plan: revisionPlan,
    decision,
    llm_calls_used: llmCallsUsed,
    llm_cost_usd: llmCallsUsed > 0 ? roundTwo(llmCostUsd) : undefined,
    llm_input_tokens: llmCallsUsed > 0 ? Math.max(0, Math.round(llmInputTokens)) : undefined,
    llm_output_tokens: llmCallsUsed > 0 ? Math.max(0, Math.round(llmOutputTokens)) : undefined,
    meta_review: metaReview,
    model_review_bundle: modelReviewBundle,
    assurance
  };
}

async function refineReviewerWithLlm(
  args: ReviewPanelArgs,
  agent: ReviewAgentBinding,
  spec: ReviewerSpec,
  fallback: SpecialistReviewResult
): Promise<ReviewerRefinement> {
  const timeoutMs = resolveReviewRefinementTimeoutMs();
  const prompt = buildReviewerPrompt(
    args.run,
    args.report,
    args.presence,
    spec,
    args.orphanCitations,
    args.paperSurfaceIssues,
    args.riskSignals,
    args.figureAuditSummary,
    args.gateBinding,
    args.inputManifestBinding
  );
  const systemPrompt = buildReviewerSystemPrompt(spec);
  const invocationAttemptId = randomUUID();
  try {
    const completion = await runWithAbortableTimeout(
      timeoutMs,
      args.abortSignal,
      (abortSignal) =>
        agent.llm.complete(prompt, {
          systemPrompt,
          model: agent.profile.model,
          reasoningEffort: agent.profile.reasoning_effort,
          abortSignal
        }),
      `review_refinement_timeout_after_${timeoutMs}ms`
    );
    const parsed = parseReviewerResponse(completion.text, spec, fallback);
    if (parsed.repaired) {
      args.eventStream?.emit({
        type: "OBS_RECEIVED",
        runId: args.run.id,
        node: args.node,
        agentRole: "reviewer",
        payload: {
          text: `Review panel repaired truncated JSON for ${spec.reviewer_label.toLowerCase()} before parsing.`
        }
      });
    }
    const result = mergeReviewerResults(fallback, parsed.result);
    const findings = result.findings.map(toGateFinding);
    const inputSha256 = hashCanonical({ prompt, system_prompt: systemPrompt });
    const outputSha256 = hashModelReviewOutput({
        reviewer_id: spec.reviewer_id,
        role: spec.model_review_role,
        findings
      });
    const provenance = buildTransportBoundModelProvenance({
      expected: agent.profile,
      observed: completion.provenance,
      invocationAttemptId,
      inputSha256,
      outputSha256
    });
    if (!provenance) {
      args.eventStream?.emit({
        type: "OBS_RECEIVED",
        runId: args.run.id,
        node: args.node,
        agentRole: "reviewer",
        payload: {
          text: `Review output for ${spec.reviewer_label.toLowerCase()} was not counted as an assured model review because its transport receipt was missing or mismatched.`
        }
      });
    }
    return {
      result,
      usedLlm: true,
      costUsd: completion.usage?.costUsd,
      usage: completion.usage,
      modelReview: provenance ? {
        reviewer_id: spec.reviewer_id,
        role: spec.model_review_role,
        provenance,
        findings
      } : undefined
    };
  } catch (error) {
    const reason = describeReviewRefinementFallbackReason(error);
    args.eventStream?.emit({
      type: "OBS_RECEIVED",
      runId: args.run.id,
      node: args.node,
      agentRole: "reviewer",
      payload: {
        text: `Review panel fallback for ${spec.reviewer_label.toLowerCase()}: ${reason}`
      }
    });
    return {
      result: fallback,
      usedLlm: false
    };
  }
}

async function refineMetaReviewerWithLlm(
  args: ReviewPanelArgs,
  agent: ReviewAgentBinding,
  reviewers: SpecialistReviewResult[],
  modelReviews: ModelSpecialistReview[]
): Promise<MetaReviewerRefinement> {
  const timeoutMs = resolveReviewRefinementTimeoutMs();
  const spec: ReviewerSpec = {
    reviewer_id: "meta_reviewer",
    reviewer_label: "Meta reviewer",
    dimension: "adversarial",
    model_review_role: "adversarial",
    buildFallback: () => buildMetaReviewFallback(reviewers)
  };
  const fallback = buildMetaReviewFallback(reviewers);
  const prompt = buildMetaReviewerPrompt(args.gateBinding!, reviewers, modelReviews);
  const systemPrompt = [
    "You are the final meta reviewer for a governed research workflow.",
    "Adjudicate conflicts across frozen specialist outputs without treating consensus as evidence.",
    "You may only add concerns or preserve a conservative recommendation; you cannot override a deterministic gate or create evidence."
  ].join(" ");
  const invocationAttemptId = randomUUID();
  try {
    const completion = await runWithAbortableTimeout(
      timeoutMs,
      args.abortSignal,
      (abortSignal) => agent.llm.complete(prompt, {
        systemPrompt,
        model: agent.profile.model,
        reasoningEffort: agent.profile.reasoning_effort,
        abortSignal
      }),
      `meta_review_timeout_after_${timeoutMs}ms`
    );
    const parsed = parseReviewerResponse(completion.text, spec, fallback);
    const result = mergeReviewerResults(fallback, parsed.result);
    const findings = result.findings.map(toGateFinding);
    const inputSha256 = hashModelReviewAdjudicatorInput(args.gateBinding!, modelReviews);
    const outputSha256 = hashModelReviewOutput({
        reviewer_id: spec.reviewer_id,
        role: "meta_reviewer",
        findings
      });
    const provenance = buildTransportBoundModelProvenance({
      expected: agent.profile,
      observed: completion.provenance,
      invocationAttemptId,
      inputSha256,
      outputSha256
    });
    if (!provenance) {
      return { result, usedLlm: true, costUsd: completion.usage?.costUsd, usage: completion.usage };
    }
    args.eventStream?.emit({
      type: "OBS_RECEIVED",
      runId: args.run.id,
      node: args.node,
      agentRole: "reviewer",
      payload: { text: "Review panel: completed a fresh-context meta review bound to all specialist outputs." }
    });
    return {
      result,
      usedLlm: true,
      costUsd: completion.usage?.costUsd,
      usage: completion.usage,
      adjudicator: {
        reviewer_id: spec.reviewer_id,
        role: "meta_reviewer",
        provenance,
        findings
      }
    };
  } catch (error) {
    const reason = describeReviewRefinementFallbackReason(error);
    args.eventStream?.emit({
      type: "OBS_RECEIVED",
      runId: args.run.id,
      node: args.node,
      agentRole: "reviewer",
      payload: { text: `Review panel meta-review fallback: ${reason}` }
    });
    return { result: fallback, usedLlm: false };
  }
}

function buildMetaReviewerPrompt(
  gateBinding: ModelReviewGateBinding,
  reviewers: SpecialistReviewResult[],
  modelReviews: ModelSpecialistReview[]
): string {
  const roleByReviewer = new Map(
    modelReviews.map((review) => [review.reviewer_id, review.role])
  );
  return [
    "Return one JSON object using the same review schema:",
    '{"summary": string, "score_1_to_5": number, "confidence": number, "recommendation": "advance" | "revise_in_place" | "backtrack_to_hypotheses" | "backtrack_to_design" | "backtrack_to_implement" | "manual_block", "findings": [{"title": string, "severity": "low" | "medium" | "high", "detail": string, "evidence_paths": string[], "claim_ids": string[], "fix_hint": string, "confidence": number}]}',
    "Rules:",
    "- Treat the deterministic gate as a non-overridable floor.",
    "- Consensus is not evidence; inspect disagreement, shared blind spots, and unsupported advancement.",
    "- Do not invent evidence paths or claims.",
    "- Return at most four adjudicated findings.",
    JSON.stringify({
      gate_report: gateBinding,
      specialists: reviewers.map((reviewer) => ({
        reviewer_id: reviewer.reviewer_id,
        role: roleByReviewer.get(reviewer.reviewer_id),
        score_1_to_5: reviewer.score_1_to_5,
        confidence: reviewer.confidence,
        recommendation: reviewer.recommendation,
        summary: reviewer.summary,
        findings: reviewer.findings,
        output_sha256: modelReviews.find(
          (review) => review.reviewer_id === reviewer.reviewer_id
        )?.provenance.output_sha256
      }))
    }, null, 2)
  ].join("\n");
}

function buildMetaReviewFallback(reviewers: SpecialistReviewResult[]): SpecialistReviewResult {
  const scores = reviewers.map((reviewer) => reviewer.score_1_to_5);
  const confidence = reviewers.length > 0
    ? reviewers.reduce((sum, reviewer) => sum + reviewer.confidence, 0) / reviewers.length
    : 0.5;
  const recommendation = reviewers.reduce<ReviewRecommendation>(
    (current, reviewer) => moreConservativeRecommendation(current, reviewer.recommendation),
    "advance"
  );
  return {
    reviewer_id: "meta_reviewer",
    reviewer_label: "Meta reviewer",
    dimension: "adversarial",
    score_1_to_5: scores.length > 0
      ? roundTwo(scores.reduce((sum, score) => sum + score, 0) / scores.length)
      : 1,
    confidence: roundTwo(confidence),
    recommendation,
    summary: "The deterministic fallback preserves the most conservative specialist recommendation but does not count as an independent meta review.",
    findings: [],
    source: "heuristic"
  };
}

function buildModelReviewBundle(
  gateBinding: ModelReviewGateBinding,
  reviewers: ModelSpecialistReview[],
  adjudicator: ModelReviewAdjudicator
): ModelReviewBundle {
  return {
    schema_version: "1.0",
    artifact_type: "ModelReviewBundle",
    gate_report: { ...gateBinding },
    policy: {
      consensus_is_evidence: false,
      may_override_deterministic_gate: false,
      may_create_external_evidence: false
    },
    reviewers,
    adjudicator
  };
}

function buildReviewAssurance(input: {
  modelReviews: ModelSpecialistReview[];
  metaReviewCompleted: boolean;
  modelReviewBundle?: ModelReviewBundle;
  gateBindingPresent: boolean;
  metaReviewerPresent: boolean;
  transportReceiptFailureRoles: ModelReviewRole[];
  gateBinding?: ModelReviewGateBinding;
  inputManifestBinding?: ModelReviewGateBinding;
  metaTransportReceiptFailed: boolean;
  requireIndependentReview: boolean;
}): ReviewAssurance {
  const completedRoles = input.modelReviews.map((review) => review.role);
  const completedRoleSet = new Set(completedRoles);
  const fallbackRoles = REQUIRED_MODEL_REVIEW_ROLES.filter(
    (role) => !completedRoleSet.has(role)
  );
  const participants = [
    ...input.modelReviews.map((review) => review.provenance),
    ...(input.modelReviewBundle ? [input.modelReviewBundle.adjudicator.provenance] : [])
  ];
  const uniqueActors = new Set(
    participants.map((provenance) => [
      provenance.provider.trim().toLowerCase(),
      provenance.model.trim().toLowerCase(),
      provenance.reasoning_effort.trim().toLowerCase()
    ].join(":"))
  );
  const uniqueExecutions = new Set(
    participants.map((provenance) => provenance.execution_id)
  );
  const providerResponseReceiptCount = participants.filter(
    (provenance) => provenance.execution_id.startsWith("provider-receipt-")
  ).length;
  const adapterAttestedReceiptCount = participants.filter(
    (provenance) => provenance.execution_id.startsWith("adapter-attested-")
  ).length;
  const reasonCodes: string[] = [];
  if (!input.gateBindingPresent) reasonCodes.push("deterministic_gate_binding_missing");
  if (input.requireIndependentReview && !input.inputManifestBinding) {
    reasonCodes.push("review_input_manifest_binding_missing");
  }
  if (!input.metaReviewerPresent) reasonCodes.push("meta_reviewer_not_configured");
  if (fallbackRoles.length > 0) reasonCodes.push("specialist_model_review_incomplete");
  if (input.transportReceiptFailureRoles.length > 0) {
    reasonCodes.push("specialist_transport_receipt_missing_or_mismatched");
  }
  if (!input.metaReviewCompleted) reasonCodes.push("meta_review_incomplete");
  if (input.metaTransportReceiptFailed) {
    reasonCodes.push("meta_transport_receipt_missing_or_mismatched");
  }
  if (participants.some((provenance) => !isVerifiedModelProvenance(provenance))) {
    reasonCodes.push("review_actor_profile_unverified");
  }
  if (uniqueExecutions.size !== participants.length) {
    reasonCodes.push("review_execution_context_reused");
  }
  const bundleValidation = input.modelReviewBundle
    ? validateModelReviewBundle(input.modelReviewBundle, input.modelReviewBundle.gate_report)
    : { ok: false, issues: [] };
  if (!bundleValidation.ok) reasonCodes.push("model_review_bundle_invalid");
  const normalizedReasons = uniqueStrings(reasonCodes);
  const eligible = normalizedReasons.length === 0;
  const assuranceClass: ReviewAssuranceClass = eligible
    ? uniqueActors.size > 1
      ? "runtime_attested_actor_diverse_panel_with_meta_review"
      : "runtime_attested_context_isolated_panel_with_meta_review"
    : input.modelReviews.length > 0
      ? "role_separated_panel"
      : "heuristic_only";
  const payload = {
    schema_version: 1 as const,
    required_for_paper_ready: input.requireIndependentReview,
    assurance_class: assuranceClass,
    requested_specialist_roles: [...REQUIRED_MODEL_REVIEW_ROLES],
    completed_model_specialist_roles: completedRoles,
    heuristic_fallback_roles: fallbackRoles,
    transport_receipt_failure_roles: [...input.transportReceiptFailureRoles],
    meta_review_completed: input.metaReviewCompleted,
    unique_actor_count: uniqueActors.size,
    unique_execution_count: uniqueExecutions.size,
    provider_response_receipt_count: providerResponseReceiptCount,
    adapter_attested_receipt_count: adapterAttestedReceiptCount,
    isolation_evidence: eligible ? "runtime_attested" as const : "unverified" as const,
    model_review_bundle_valid: bundleValidation.ok,
    paper_ready_eligible: eligible,
    reason_codes: normalizedReasons,
    model_review_bundle_content_sha256: input.modelReviewBundle
      ? hashCanonical(input.modelReviewBundle)
      : null,
    gate_report_content_sha256: input.gateBinding?.sha256 ?? null,
    review_input_manifest_content_sha256: input.inputManifestBinding?.sha256 ?? null
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function buildReviewAssuranceFinding(assurance: ReviewAssurance): ReviewFinding {
  return createFinding(
    "review_assurance_gate",
    "Review assurance gate",
    "adversarial",
    "high",
    "Independent model review is incomplete",
    `The review panel cannot authorize paper readiness because ${assurance.reason_codes.join(", ") || "its model-review provenance is incomplete"}.`,
    ["review/review_assurance.json", "review/model_review_bundle.json", "review/minimum_gate.json"],
    [],
    "Rerun review with five successful fresh-context specialist calls and one separately bound meta-review call, then validate the resulting ModelReviewBundle.",
    0.99
  );
}

function toGateFinding(finding: ReviewFinding): GateFinding {
  return {
    code: `review.${slugify(finding.id) || "finding"}`,
    severity: finding.severity === "high" ? "blocker" : "warning",
    message: finding.detail.trim(),
    evidence_refs: uniqueStrings(
      finding.evidence_paths.filter(isPortableReviewEvidenceRef)
    ),
    ...(finding.fix_hint ? { recheck_condition: finding.fix_hint.trim() } : {})
  };
}

function isPortableReviewEvidenceRef(value: string): boolean {
  return Boolean(value)
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/u.test(value)
    && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)
    && !value.includes("\\")
    && !value.split("/").some((segment) => segment === "..");
}

function buildTransportBoundModelProvenance(input: {
  expected: ReviewActorProfile;
  observed: LLMCompletionProvenance | undefined;
  invocationAttemptId: string;
  inputSha256: string;
  outputSha256: string;
}): ModelReviewerProvenance | undefined {
  const observed = input.observed;
  if (!observed || observed.identityBasis === "mock" || observed.provider === "mock") {
    return undefined;
  }
  const expectedProvider = input.expected.provider.trim().toLowerCase();
  const expectedModel = input.expected.model.trim().toLowerCase();
  const expectedReasoning = input.expected.reasoning_effort.trim().toLowerCase();
  const requestedModel = observed.requestedModel.trim().toLowerCase();
  const effectiveModel = observed.effectiveModel.trim().toLowerCase();
  const observedReasoning = observed.reasoningEffort.trim().toLowerCase();
  if (
    !expectedProvider
    || !expectedModel
    || !expectedReasoning
    || observed.provider !== expectedProvider
    || requestedModel !== expectedModel
    || effectiveModel !== expectedModel
    || observedReasoning !== expectedReasoning
    || observed.contextMode === "continued"
    || (observed.contextMode === "fresh" && !observed.responseId)
  ) {
    return undefined;
  }
  const executionDigest = observed.responseId
    ? hashCanonical({ provider: observed.provider, response_id: observed.responseId })
    : hashCanonical({
        provider: observed.provider,
        model: observed.effectiveModel,
        invocation_attempt_id: input.invocationAttemptId,
        input_sha256: input.inputSha256
      });
  const executionPrefix = observed.identityBasis === "provider_response"
    ? "provider-receipt"
    : "adapter-attested";
  return {
    actor: "model",
    provider: observed.provider,
    model: observed.effectiveModel.trim(),
    reasoning_effort: observed.reasoningEffort.trim(),
    execution_id: `${executionPrefix}-${executionDigest.slice(0, 48)}`,
    context_isolated: true,
    input_sha256: input.inputSha256,
    output_sha256: input.outputSha256
  };
}

function isVerifiedModelProvenance(provenance: ModelReviewerProvenance): boolean {
  const values = [provenance.provider, provenance.model, provenance.reasoning_effort]
    .map((value) => value.trim().toLowerCase());
  return values.every(
    (value) => Boolean(value) && value !== "unknown" && value !== "unverified" && value !== "unconfigured"
  );
}

function unverifiedReviewActorProfile(): ReviewActorProfile {
  return {
    provider: "unverified",
    model: "unverified",
    reasoning_effort: "unverified"
  };
}

function buildReviewerSystemPrompt(spec: ReviewerSpec): string {
  return loadReviewPromptSections()
    .reviewerSystemTemplate
    .replace(/\{\{\s*reviewer_label\s*\}\}/gu, spec.reviewer_label.toLowerCase())
    .trim();
}

function buildReviewerPrompt(
  run: ReviewPanelArgs["run"],
  report: AnalysisReport,
  presence: ReviewArtifactPresence,
  spec: ReviewerSpec,
  orphanCitations: string[] = [],
  paperSurfaceIssues: PaperSurfaceReviewIssue[] = [],
  riskSignals: RiskSignal[] = [],
  figureAuditSummary?: FigureAuditSummary,
  gateBinding?: ModelReviewGateBinding,
  inputManifestBinding?: ModelReviewGateBinding
): string {
  const primaryComparison = resolveExplicitPrimaryComparison(report);
  const primaryEffectEstimates = primaryComparison
    ? report.statistical_summary.effect_estimates.filter(
        (item) => item.comparison_id === primaryComparison.comparison.id
      )
    : [];
  const transitionRecommendation =
    report.transition_recommendation?.action !== "backtrack_to_hypotheses" ||
    primaryComparison?.hypothesis_supported === false
      ? report.transition_recommendation
      : undefined;
  const payload = {
    reviewer: {
      id: spec.reviewer_id,
      label: spec.reviewer_label,
      dimension: spec.dimension
    },
    run: {
      topic: run.topic,
      title: run.title,
      objective_metric: run.objectiveMetric,
      constraints: run.constraints
    },
    deterministic_gate: gateBinding,
    review_input_manifest: inputManifestBinding,
    overview: {
      objective_status: report.overview.objective_status,
      objective_summary: report.overview.objective_summary,
      execution_runs: report.overview.execution_runs
    },
    transition_recommendation: transitionRecommendation
      ? {
          action: transitionRecommendation.action,
          targetNode: transitionRecommendation.targetNode,
          reason: transitionRecommendation.reason,
          confidence: transitionRecommendation.confidence
        }
      : undefined,
    artifact_presence: presence,
    primary_findings: report.primary_findings.slice(0, 4),
    limitations: report.limitations.slice(0, 4),
    warnings: report.warnings.slice(0, 4),
    orphan_citations: orphanCitations.slice(0, 12),
    paper_surface_issues: paperSurfaceIssues.slice(0, 12),
    risk_signals: riskSignals.slice(0, 12),
    figure_audit_summary: figureAuditSummary
      ? {
          severe_mismatch_count: figureAuditSummary.severe_mismatch_count,
          review_block_required: figureAuditSummary.review_block_required,
          issues: figureAuditSummary.issues.slice(0, 6)
        }
      : undefined,
    paper_claims: report.paper_claims.slice(0, 4).map((claim) => ({
      claim: claim.claim,
      evidence_count: claim.evidence.length
    })),
    figure_specs: report.figure_specs.slice(0, 3).map((figure) => ({
      title: figure.title,
      path: figure.path,
      metric_keys: figure.metric_keys
    })),
    selected_design: report.plan_context.selected_design
      ? {
          title: report.plan_context.selected_design.title,
          metrics: report.plan_context.selected_design.metrics,
          baselines: report.plan_context.selected_design.baselines,
          evaluation_steps: report.plan_context.selected_design.evaluation_steps,
          risks: report.plan_context.selected_design.risks
        }
      : undefined,
    primary_comparison: primaryComparison
      ? {
          id: primaryComparison.comparison.id,
          subject_series_id: primaryComparison.subject_series.id,
          reference_series_id: primaryComparison.reference_series.id,
          metric_id: primaryComparison.metric.id,
          hypothesis_supported: primaryComparison.hypothesis_supported,
          summary: primaryComparison.summary
        }
      : undefined,
    statistical_summary: {
      total_trials: report.statistical_summary.total_trials,
      executed_trials: report.statistical_summary.executed_trials,
      confidence_intervals: report.statistical_summary.confidence_intervals.slice(0, 4).map((item) => item.summary),
      effect_estimates: primaryEffectEstimates.slice(0, 4).map((item) => item.summary),
      notes: report.statistical_summary.notes.slice(0, 4)
    },
    failure_taxonomy: report.failure_taxonomy.slice(0, 6).map((item) => ({
      category: item.category,
      severity: item.severity,
      status: item.status,
      summary: item.summary,
      recommended_action: item.recommended_action
    }))
  };

  return [
    "Return one JSON object with this shape:",
    "{",
    '  "summary": string,',
    '  "score_1_to_5": number,',
    '  "confidence": number,',
    '  "recommendation": "advance" | "revise_in_place" | "backtrack_to_hypotheses" | "backtrack_to_design" | "backtrack_to_implement" | "manual_block",',
    '  "findings": [',
    "    {",
    '      "title": string,',
    '      "severity": "low" | "medium" | "high",',
    '      "detail": string,',
    '      "evidence_paths": string[],',
    '      "claim_ids": string[],',
    '      "fix_hint": string,',
    '      "confidence": number',
    "    }",
    "  ]",
    "}",
    "",
    "Rules:",
    "- Keep summary to one or two sentences.",
    "- score_1_to_5: 1 means not ready at all, 5 means publication-ready for this dimension.",
    "- confidence: 0.0 to 1.0.",
    "- findings: up to 4 concrete issues, conservative and evidence-grounded.",
    "- Review the supplied artifacts independently; no prior reviewer conclusion is authoritative.",
    "",
    JSON.stringify(payload, null, 2)
  ].join("\n");
}

function parseReviewerResponse(
  raw: string,
  spec: ReviewerSpec,
  fallback: SpecialistReviewResult
): { result: SpecialistReviewResult; repaired: boolean } {
  const parsed = parseStructuredModelJsonObject<RawReviewerResponse>(raw, {
    emptyError: "Reviewer LLM returned an empty response.",
    notFoundError: "Reviewer LLM returned no JSON object.",
    incompleteError: "Reviewer JSON object looks truncated.",
    invalidError: "Reviewer JSON must decode to an object."
  });

  const record = parsed.value;
  return {
    repaired: parsed.repaired,
    result: {
      reviewer_id: spec.reviewer_id,
      reviewer_label: spec.reviewer_label,
      dimension: spec.dimension,
      score_1_to_5: clampScore(asNumber(record.score_1_to_5) ?? fallback.score_1_to_5),
      confidence: clampConfidence(asNumber(record.confidence) ?? fallback.confidence),
      recommendation: normalizeRecommendation(record.recommendation) ?? fallback.recommendation,
      summary: cleanString(record.summary) || fallback.summary,
      findings: normalizeReviewerFindings(record.findings, spec, fallback.reviewer_label),
      source: "llm+heuristic"
    }
  };
}

function normalizeReviewerFindings(
  value: unknown,
  spec: ReviewerSpec,
  reviewerLabel: string
): ReviewFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => normalizeReviewerFinding(item, spec, reviewerLabel, index))
    .filter((item): item is ReviewFinding => Boolean(item))
    .slice(0, 4);
}

function normalizeReviewerFinding(
  value: unknown,
  spec: ReviewerSpec,
  reviewerLabel: string,
  index: number
): ReviewFinding | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as RawReviewerFinding;
  const title = cleanString(record.title);
  const detail = cleanString(record.detail);
  if (!title || !detail) {
    return undefined;
  }

  return {
    id: `${spec.reviewer_id}_${index + 1}`,
    reviewer_id: spec.reviewer_id,
    reviewer_label: reviewerLabel,
    dimension: spec.dimension,
    severity: normalizeSeverity(record.severity) ?? "medium",
    title,
    detail,
    claim_ids: normalizeStringArray(record.claim_ids, 6),
    evidence_paths: normalizeStringArray(record.evidence_paths, 6),
    fix_hint: cleanString(record.fix_hint) || undefined,
    confidence: clampConfidence(asNumber(record.confidence) ?? 0.6)
  };
}

function mergeReviewerResults(
  fallback: SpecialistReviewResult,
  refined: SpecialistReviewResult
): SpecialistReviewResult {
  const findings = dedupeFindings([...fallback.findings, ...refined.findings]);
  return {
    ...fallback,
    score_1_to_5: Math.min(fallback.score_1_to_5, refined.score_1_to_5),
    confidence: roundTwo((fallback.confidence + refined.confidence) / 2),
    recommendation: moreConservativeRecommendation(fallback.recommendation, refined.recommendation),
    summary: refined.summary || fallback.summary,
    findings,
    source: "llm+heuristic"
  };
}

function buildClaimVerificationFallback(
  report: AnalysisReport,
  presence: ReviewArtifactPresence
): SpecialistReviewResult {
  const findings: ReviewFinding[] = [];

  if (!presence.evidenceStorePresent) {
    findings.push(
      createFinding("claim_verifier", "Claim verifier", "claim_verification", "high", "Missing evidence store", "Claims cannot be fully audited because evidence_store.jsonl is missing.", ["evidence_store.jsonl"], [], "Recreate evidence_store.jsonl before drafting claims.", 0.94)
    );
  }

  if ((report.paper_claims?.length || 0) === 0) {
    findings.push(
      createFinding("claim_verifier", "Claim verifier", "claim_verification", "medium", "No grounded paper claims", "The analysis does not yet contain structured paper_claims for the reviewer to verify.", ["result_analysis.json"], [], "Generate grounded paper_claims before writing the paper.", 0.82)
    );
  }

  if (report.overview.objective_status !== "met" && report.overview.objective_status !== "observed" && (report.paper_claims?.length || 0) > 0) {
    findings.push(
      createFinding("claim_verifier", "Claim verifier", "claim_verification", "high", "Claims outpace measured outcome", "Paper claims exist even though the configured objective is not met, so stronger success claims would be unsafe.", ["result_analysis.json"], claimIds(report.paper_claims), "Reduce claims or rerun experiments until the objective is met.", 0.86)
    );
  }

  if (report.paper_claims.some((claim) => claim.evidence.length === 0)) {
    findings.push(
      createFinding("claim_verifier", "Claim verifier", "claim_verification", "medium", "Claim without explicit evidence", "At least one paper claim has no attached evidence link in result_analysis.json.", ["result_analysis.json"], claimIds(report.paper_claims.filter((claim) => claim.evidence.length === 0)), "Attach explicit evidence to every paper claim or remove unsupported claims.", 0.79)
    );
  }

  const primaryComparison = resolveExplicitPrimaryComparison(report);
  if (!primaryComparison && report.paper_claims.length > 0) {
    findings.push(
      createFinding("claim_verifier", "Claim verifier", "claim_verification", "medium", "No explicit primary comparison for drafted claims", "Claims are present but the report does not expose a uniquely bound primary ResultsArtifactV2 comparison to justify them.", ["result_analysis.json"], claimIds(report.paper_claims), "Bind primary_comparison_id to a valid ResultsArtifactV2 comparison or soften the claims to descriptive statements only.", 0.74)
    );
  }

  return finalizeFallbackReviewer({
    reviewer_id: "claim_verifier",
    reviewer_label: "Claim verifier",
    dimension: "claim_verification",
    findings,
    cleanSummary: "Claims are grounded when explicit evidence links and measured comparisons back each paper-facing statement.",
    issueSummary: findings[0]?.detail || "Claim support is incomplete."
  });
}

function buildMethodologyFallback(
  report: AnalysisReport,
  presence: ReviewArtifactPresence
): SpecialistReviewResult {
  const findings: ReviewFinding[] = [];
  const selectedDesign = report.plan_context.selected_design;

  if (!presence.experimentPlanPresent) {
    findings.push(
      createFinding("methodology_reviewer", "Methodology reviewer", "methodology", "high", "Missing experiment plan", "experiment_plan.yaml is missing, so the reviewer cannot trace the intended baselines and evaluation design.", ["experiment_plan.yaml"], [], "Regenerate experiment_plan.yaml before proceeding.", 0.95)
    );
  }

  if (!selectedDesign) {
    findings.push(
      createFinding("methodology_reviewer", "Methodology reviewer", "methodology", "medium", "No selected design context", "The report does not contain a selected design summary for the review panel.", ["result_analysis.json"], [], "Persist selected_design details into the analysis report.", 0.76)
    );
  } else {
    if ((selectedDesign.baselines?.length || 0) === 0) {
      findings.push(
        createFinding("methodology_reviewer", "Methodology reviewer", "methodology", "medium", "Baselines not explicit", "The selected design does not list explicit baselines, which weakens methodological comparison.", ["experiment_plan.yaml", "result_analysis.json"], [], "Add explicit baselines to the selected design and compare against them.", 0.72)
      );
    }
    if ((selectedDesign.evaluation_steps?.length || 0) === 0) {
      findings.push(
        createFinding("methodology_reviewer", "Methodology reviewer", "methodology", "medium", "Evaluation steps missing", "The selected design does not enumerate evaluation steps, making reproduction and auditing harder.", ["experiment_plan.yaml", "result_analysis.json"], [], "Document the evaluation steps in the experiment plan.", 0.71)
      );
    }
  }

  const scopeIssue = report.failure_taxonomy.find((item) => item.category === "scope_limit");
  if (scopeIssue) {
    findings.push(
      createFinding("methodology_reviewer", "Methodology reviewer", "methodology", scopeIssue.severity === "high" ? "high" : "medium", "Method scope remains narrow", scopeIssue.summary, ["result_analysis.json"], [], scopeIssue.recommended_action || "Widen confirmatory coverage before drafting stronger conclusions.", 0.77)
    );
  }

  const coverageChecks = report.evidence_adequacy_assessment?.checks.filter(
    (check) =>
      [
        "execution_identity_uniqueness",
        "independent_coverage",
        "contrast_coverage",
        "denominator_coverage",
        "pair_coverage",
        "execution_budget",
        "evidence_linkage"
      ].includes(check.check_id)
      && check.status !== "pass"
  ) ?? [];
  if (coverageChecks.length > 0) {
    const failed = coverageChecks.some((check) => check.status === "fail");
    findings.push(
      createFinding(
        "methodology_reviewer",
        "Methodology reviewer",
        "methodology",
        failed ? "high" : "medium",
        "Frozen evidence coverage incomplete",
        `The contract-bound assessment has non-pass coverage checks: ${coverageChecks.map((check) => `${check.check_id}=${check.status}`).join(", ")}.`,
        ["result_analysis.json", "evidence_adequacy_assessment.json"],
        [],
        "Complete the independent-unit, contrast, denominator, pairing, budget, and evidence-linkage requirements declared by the frozen contract.",
        0.92
      )
    );
  }

  return finalizeFallbackReviewer({
    reviewer_id: "methodology_reviewer",
    reviewer_label: "Methodology reviewer",
    dimension: "methodology",
    findings,
    cleanSummary: "Methodology is ready when the design, baselines, and evaluation procedure are explicit and adequately covered by runs.",
    issueSummary: findings[0]?.detail || "Methodology evidence is incomplete."
  });
}

function buildStatisticsFallback(
  report: AnalysisReport,
  presence: ReviewArtifactPresence
): SpecialistReviewResult {
  const findings: ReviewFinding[] = [];
  const executedTrials = report.statistical_summary.executed_trials ?? report.execution_summary.observation_count ?? 0;
  const primaryComparison = resolveExplicitPrimaryComparison(report);
  const hasPrimaryEffectEstimate = primaryComparison
    ? report.statistical_summary.effect_estimates.some(
        (item) => item.comparison_id === primaryComparison.comparison.id
      )
    : false;

  if (executedTrials <= 0) {
    findings.push(
      createFinding("statistics_reviewer", "Statistics reviewer", "statistics", "high", "No executed trials", "No executed trials were recorded, so statistical review cannot support publication claims.", ["result_analysis.json"], [], "Run experiments and persist execution records before review.", 0.97)
    );
  }

  if (!presence.metricsPresent) {
    findings.push(
      createFinding("statistics_reviewer", "Statistics reviewer", "statistics", "high", "Missing metrics snapshot", "metrics.json is missing, so the statistical reviewer cannot verify the numerical snapshot.", ["metrics.json"], [], "Restore metrics.json and rerun analyze_results if needed.", 0.95)
    );
  }

  const uncertaintyCheck = report.evidence_adequacy_assessment?.checks.find(
    (check) => check.check_id === "uncertainty"
  );
  if (uncertaintyCheck && uncertaintyCheck.status !== "pass") {
    findings.push(
      createFinding(
        "statistics_reviewer",
        "Statistics reviewer",
        "statistics",
        uncertaintyCheck.status === "fail" ? "high" : "medium",
        "Frozen uncertainty requirement unresolved",
        `The contract-bound uncertainty check is ${uncertaintyCheck.status}: ${uncertaintyCheck.reasons.join(", ") || "no reason recorded"}.`,
        ["result_analysis.json", "evidence_adequacy_assessment.json"],
        [],
        "Satisfy the uncertainty method declared by the frozen evidence contract, or use its predeclared deterministic-exhaustive rationale.",
        0.93
      )
    );
  }

  if (primaryComparison && !hasPrimaryEffectEstimate) {
    findings.push(
      createFinding("statistics_reviewer", "Statistics reviewer", "statistics", "medium", "Missing primary effect estimate summary", "The explicitly selected primary comparison has no matching structured effect estimate.", ["result_analysis.json"], [], "Add an effect estimate whose comparison_id matches primary_comparison_id.", 0.73)
    );
  }

  return finalizeFallbackReviewer({
    reviewer_id: "statistics_reviewer",
    reviewer_label: "Statistics reviewer",
    dimension: "statistics",
    findings,
    cleanSummary: "Statistical readiness depends on executed trials, explicit intervals, and effect estimates that support the primary comparisons.",
    issueSummary: findings[0]?.detail || "Statistical support remains incomplete."
  });
}

function buildReproducibilityFallback(
  report: AnalysisReport,
  presence: ReviewArtifactPresence
): SpecialistReviewResult {
  const findings: ReviewFinding[] = [];

  if (!presence.experimentPlanPresent) {
    findings.push(
      createFinding("reproducibility_reviewer", "Reproducibility reviewer", "reproducibility", "high", "Experiment plan is not reproducible", "experiment_plan.yaml is missing, so an independent rerun cannot recover the declared design.", ["experiment_plan.yaml"], [], "Restore the governed experiment plan before review.", 0.94)
    );
  }

  if (!presence.metricsPresent || !presence.resultTablePresent) {
    findings.push(
      createFinding("reproducibility_reviewer", "Reproducibility reviewer", "reproducibility", "high", "Machine-readable results are incomplete", "The review cannot reconstruct the reported comparisons without both the metric snapshot and the structured result table.", ["metrics.json", "result_table.json"], [], "Persist both machine-readable artifacts from the same executed observations and rerun analysis.", 0.95)
    );
  }

  if (!presence.evidenceStorePresent) {
    findings.push(
      createFinding("reproducibility_reviewer", "Reproducibility reviewer", "reproducibility", "high", "Evidence lineage is missing", "evidence_store.jsonl is absent, so claims and aggregates cannot be traced back to executed evidence.", ["evidence_store.jsonl", "result_analysis.json"], [], "Rebuild the evidence store from immutable run outputs and verify every claim reference.", 0.96)
    );
  }

  if (!presence.baselineSummaryPresent) {
    findings.push(
      createFinding("reproducibility_reviewer", "Reproducibility reviewer", "reproducibility", "medium", "Comparator reconstruction is incomplete", "baseline_summary.json is missing, so the declared comparator cannot be independently checked against the primary result.", ["baseline_summary.json", "result_analysis.json"], [], "Persist the comparator summary and bind it to the same result-table observations.", 0.84)
    );
  }

  if (report.verifier_feedback?.status === "fail") {
    findings.push(
      createFinding("reproducibility_reviewer", "Reproducibility reviewer", "reproducibility", "high", "Execution verifier did not pass", "The analysis verifier reports a failure, so the persisted outputs do not yet support an independent replay.", ["result_analysis.json", "verification_report.json"], [], "Repair the verifier failure and rerun the exact execution and analysis path before review.", 0.97)
    );
  }

  return finalizeFallbackReviewer({
    reviewer_id: "reproducibility_reviewer",
    reviewer_label: "Reproducibility reviewer",
    dimension: "reproducibility",
    findings,
    cleanSummary: "Reproducibility requires a governed plan, machine-readable outcomes, comparator reconstruction, and traceable evidence lineage.",
    issueSummary: findings[0]?.detail || "Reproducibility artifacts remain incomplete."
  });
}

function buildAdversarialFallback(
  report: AnalysisReport,
  presence: ReviewArtifactPresence
): SpecialistReviewResult {
  const findings: ReviewFinding[] = [];
  const transition = report.transition_recommendation;
  const highObserved = report.failure_taxonomy.filter((item) => item.status === "observed" && item.severity === "high");
  const mediumOrHighConcerns = report.failure_taxonomy.filter(
    (item) => item.severity === "high" || (item.severity === "medium" && item.status === "observed")
  );

  if (transition?.action === "advance" && report.overview.objective_status !== "met" && report.overview.objective_status !== "observed") {
    findings.push(
      createFinding("adversarial_reviewer", "Adversarial reviewer", "adversarial", "high", "Advance recommendation conflicts with unmet objective", "The report recommends advancing even though the configured objective is not met.", ["transition_recommendation.json", "result_analysis.json"], [], "Hold the run for manual review and revisit the transition recommendation.", 0.93)
    );
  }

  if (transition?.action === "advance" && highObserved.length > 0) {
    findings.push(
      createFinding("adversarial_reviewer", "Adversarial reviewer", "adversarial", "high", "Concern-acceptance conflict", "The report still contains high-severity observed issues while recommending an advance to the next stage.", ["transition_recommendation.json", "result_analysis.json"], [], "Resolve the blocking issue or downgrade the recommendation before continuing.", 0.91)
    );
  }

  if (transition?.action === "advance" && mediumOrHighConcerns.length >= 2 && (transition.confidence || 0) >= 0.8) {
    findings.push(
      createFinding("adversarial_reviewer", "Adversarial reviewer", "adversarial", "medium", "Positive outcome bias risk", "The advance recommendation is highly confident despite multiple unresolved concerns.", ["transition_recommendation.json", "result_analysis.json"], [], "Run a more conservative review pass and document the unresolved concerns explicitly.", 0.78)
    );
  }

  if (!presence.evidenceStorePresent && transition?.action === "advance") {
    findings.push(
      createFinding("adversarial_reviewer", "Adversarial reviewer", "adversarial", "high", "Advance recommendation without evidence store", "The run is marked ready to advance even though evidence_store.jsonl is missing.", ["evidence_store.jsonl", "transition_recommendation.json"], [], "Regenerate the evidence store and re-evaluate the transition recommendation.", 0.94)
    );
  }

  if ((report.warnings?.length || 0) >= 3 && transition?.action === "advance") {
    findings.push(
      createFinding("adversarial_reviewer", "Adversarial reviewer", "adversarial", "medium", "Warning-heavy advance", "The analysis carries several warnings but still recommends advancing.", ["result_analysis.json", "transition_recommendation.json"], [], "Review the warnings and justify why they do not block the paper stage.", 0.72)
    );
  }

  return finalizeFallbackReviewer({
    reviewer_id: "adversarial_reviewer",
    reviewer_label: "Adversarial reviewer",
    dimension: "adversarial",
    findings,
    cleanSummary: "Adversarial review looks for overclaiming, concern-acceptance conflicts, shared blind spots, and optimistic transitions.",
    issueSummary: findings[0]?.detail || "Adversarial checks are incomplete."
  });
}

function buildScorecard(reviewers: SpecialistReviewResult[]): ReviewScorecard {
  const dimensions = reviewers.map((reviewer) => ({
    dimension: reviewer.dimension,
    label: reviewer.reviewer_label,
    score_1_to_5: reviewer.score_1_to_5,
    confidence: reviewer.confidence,
    summary: reviewer.summary,
    top_finding_ids: reviewer.findings.slice(0, 3).map((item) => item.id)
  }));
  const overall = reviewers.length > 0
    ? roundTwo(reviewers.reduce((sum, reviewer) => sum + reviewer.score_1_to_5, 0) / reviewers.length)
    : 0;

  return {
    overall_score_1_to_5: overall,
    dimensions
  };
}

function buildConsistencyReport(
  reviewers: SpecialistReviewResult[],
  findings: ReviewFinding[]
): ReviewConsistencyReport {
  const histogram: Record<string, number> = {};
  for (const reviewer of reviewers) {
    histogram[reviewer.recommendation] = (histogram[reviewer.recommendation] || 0) + 1;
  }

  const scores = reviewers.map((item) => item.score_1_to_5);
  const scoreSpread = scores.length > 0 ? Math.max(...scores) - Math.min(...scores) : 0;
  const pairwiseAgreement = computePairwiseRecommendationAgreement(reviewers);
  const conflicts: string[] = [];

  const uniqueRecommendations = Object.keys(histogram).length;
  const recommendationDisagreement =
    uniqueRecommendations > 1
      ? `Reviewer recommendations disagree: ${Object.entries(histogram)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")}`
      : undefined;

  const hasBlockingSeverity = findings.some((item) => item.severity === "high");
  const averageScore = scores.length > 0 ? scores.reduce((sum, item) => sum + item, 0) / scores.length : 0;
  if (hasBlockingSeverity && averageScore >= 4) {
    conflicts.push("Panel scores remain high despite at least one high-severity finding.");
  }

  const agreement: ReviewAgreement =
    conflicts.length > 0 || pairwiseAgreement < 0.5 || (uniqueRecommendations >= 3 && scoreSpread >= 2)
      ? "low"
      : scoreSpread > 1 || uniqueRecommendations > 1 || pairwiseAgreement < 0.8
        ? "medium"
        : "high";

  return {
    panel_agreement: agreement,
    pairwise_recommendation_agreement: roundTwo(pairwiseAgreement),
    score_spread: roundTwo(scoreSpread),
    recommendation_histogram: histogram,
    conflicts: recommendationDisagreement ? [recommendationDisagreement, ...conflicts] : conflicts,
    summary:
      conflicts[0] ||
      recommendationDisagreement ||
      (agreement === "high"
        ? "Reviewer recommendations are aligned and score spread is low."
        : agreement === "medium"
          ? "Reviewer recommendations are mostly aligned but still carry some disagreement."
          : "Reviewer recommendations diverge enough to require careful manual review.")
  };
}

function buildBiasReport(
  report: AnalysisReport,
  reviewers: SpecialistReviewResult[],
  findings: ReviewFinding[],
  consistency: ReviewConsistencyReport
): ReviewBiasReport {
  const flags: ReviewBiasFlag[] = [];
  const summaryLengths = reviewers.map((item) => item.summary.length).filter((value) => value > 0);
  if (summaryLengths.length >= 2) {
    const max = Math.max(...summaryLengths);
    const min = Math.min(...summaryLengths);
    if (min > 0 && max / min >= 2.5) {
      flags.push({
        kind: "verbosity_imbalance",
        severity: "low",
        detail: "Reviewer summaries vary sharply in length, which can create verbosity bias in downstream judging."
      });
    }
  }

  const highOrMediumFindings = findings.filter((item) => item.severity !== "low");
  const majorityAdvance = reviewers.filter((item) => item.recommendation === "advance").length >= Math.ceil(reviewers.length / 2);
  if (report.overview.objective_status === "met" && majorityAdvance && highOrMediumFindings.length >= 3) {
    flags.push({
      kind: "positive_outcome_bias",
      severity: "medium",
      detail: "The panel still leans positive even though several unresolved concerns remain after the objective was met."
    });
  }

  if (consistency.panel_agreement === "low") {
    flags.push({
      kind: "consensus_gap",
      severity: "medium",
      detail: "Reviewer disagreement is large enough that consensus itself should be treated cautiously."
    });
  }

  if (findings.some((item) => item.title.toLowerCase().includes("concern-acceptance conflict"))) {
    flags.push({
      kind: "concern_acceptance_conflict",
      severity: "high",
      detail: "A reviewer detected concern-acceptance conflict, where serious issues coexist with an overly positive acceptance signal."
    });
  }

  return {
    flags,
    summary:
      flags[0]?.detail ||
      "No major panel-level bias flag was detected beyond the normal need for human sign-off."
  };
}

function buildRevisionPlan(findings: ReviewFinding[]): ReviewRevisionPlan {
  const items = findings
    .slice()
    .sort(compareFindings)
    .slice(0, 8)
    .map((finding, index) => ({
      id: `revision_${index + 1}`,
      priority: finding.severity,
      owner: ownerForDimension(finding.dimension, finding.title),
      title: finding.title,
      action: finding.fix_hint || finding.detail,
      source_finding_ids: [finding.id]
    }));

  return {
    items,
    summary:
      items.length > 0
        ? `Prepared ${items.length} revision action(s) from the specialist review findings.`
        : "No revision actions were generated because the panel reported no actionable findings."
  };
}

function buildDecision(
  report: AnalysisReport,
  reviewers: SpecialistReviewResult[],
  findings: ReviewFinding[],
  consistency: ReviewConsistencyReport,
  bias: ReviewBiasReport,
  revisionPlan: ReviewRevisionPlan
): ReviewDecision {
  const highFindings = findings.filter((item) => item.severity === "high");
  const blockingIds = highFindings.map((item) => item.id);
  const hasRuntimeFailure =
    report.failure_taxonomy.some((item) => item.category === "runtime_failure" && item.severity === "high") ||
    report.verifier_feedback?.status === "fail";
  const primaryComparison = resolveExplicitPrimaryComparison(report);
  const unsupportedComparison = primaryComparison?.hypothesis_supported === false;
  const hasClaimBlocker = highFindings.some((item) => item.dimension === "claim_verification");
  const shouldResetHypotheses =
    unsupportedComparison &&
    (
      report.transition_recommendation?.action === "backtrack_to_hypotheses" ||
      report.overview.objective_status !== "met" ||
      hasClaimBlocker
    );
  const hasMethodologyBlocker = highFindings.some((item) => item.dimension === "methodology" || item.dimension === "statistics");
  const hasReproducibilityBlocker = highFindings.some((item) => item.dimension === "reproducibility");
  const hasAdversarialBlocker = highFindings.some((item) => item.dimension === "adversarial" || item.dimension === "integrity");
  const hasReviewAssuranceBlocker = highFindings.some((item) => item.reviewer_id === "review_assurance_gate");
  const hasIntegrityBlocker = highFindings.some((item) => item.dimension === "integrity" || item.dimension === "claim_verification");
  const hasWritingBlocker = highFindings.some((item) => item.dimension === "writing_readiness");
  const mediumCount = findings.filter((item) => item.severity === "medium").length;

  let outcome: ReviewRecommendation = "advance";
  let recommendedTransition: ReviewDecision["recommended_transition"];
  const shouldCarryRevisionChecklist = mediumCount >= 3 || revisionPlan.items.some((item) => item.owner === "writing");
  if (hasReviewAssuranceBlocker) {
    outcome = "manual_block";
  } else if (hasRuntimeFailure || hasReproducibilityBlocker) {
    outcome = "backtrack_to_implement";
    recommendedTransition = "backtrack_to_implement";
  } else if (shouldResetHypotheses) {
    outcome = "backtrack_to_hypotheses";
    recommendedTransition = "backtrack_to_hypotheses";
  } else if (hasMethodologyBlocker) {
    outcome = "backtrack_to_design";
    recommendedTransition = "backtrack_to_design";
  } else if (hasAdversarialBlocker || hasIntegrityBlocker || bias.flags.some((item) => item.severity === "high")) {
    if (report.transition_recommendation?.action === "backtrack_to_implement" || revisionPlan.items.some((item) => item.owner === "implementation")) {
      outcome = "backtrack_to_implement";
      recommendedTransition = "backtrack_to_implement";
    } else if (hasClaimBlocker) {
      outcome = "backtrack_to_hypotheses";
      recommendedTransition = "backtrack_to_hypotheses";
    } else {
      outcome = "backtrack_to_design";
      recommendedTransition = "backtrack_to_design";
    }
  } else if (hasWritingBlocker) {
    outcome = "revise_in_place";
  } else if (consistency.panel_agreement === "low" && highFindings.length > 0) {
    // Low agreement with high findings: conservative backtrack
    if (report.transition_recommendation?.action === "backtrack_to_implement" || revisionPlan.items.some((item) => item.owner === "implementation")) {
      outcome = "backtrack_to_implement";
      recommendedTransition = "backtrack_to_implement";
    } else if (hasClaimBlocker) {
      outcome = "backtrack_to_hypotheses";
      recommendedTransition = "backtrack_to_hypotheses";
    } else {
      outcome = "backtrack_to_design";
      recommendedTransition = "backtrack_to_design";
    }
  } else {
    outcome = "advance";
    recommendedTransition = "advance";
  }

  const reviewerConfidences = reviewers.map((item) => item.confidence);
  const confidence = reviewerConfidences.length > 0
    ? roundTwo(reviewerConfidences.reduce((sum, item) => sum + item, 0) / reviewerConfidences.length)
    : 0.5;
  const rationale = buildDecisionRationale(outcome, highFindings, findings, consistency, bias);

  return {
    outcome,
    recommended_transition: recommendedTransition,
    confidence,
    summary: summarizeDecision(outcome, highFindings, mediumCount, shouldCarryRevisionChecklist),
    rationale,
    blocking_finding_ids: blockingIds,
    required_actions: revisionPlan.items.slice(0, 4).map((item) => item.action)
  };
}

function resolveExplicitPrimaryComparison(report: AnalysisReport) {
  if (!report.primary_comparison_id) {
    return undefined;
  }
  return resolvePrimaryResultsArtifactComparison(
    report.results_artifact,
    report.primary_comparison_id
  );
}

function buildPaperSurfaceFindings(issues: PaperSurfaceReviewIssue[]): ReviewFinding[] {
  return issues.slice(0, 12).map((issue) =>
    createFinding(
      "paper_surface_reviewer",
      "Paper surface reviewer",
      "writing_readiness",
      issue.severity ?? "high",
      paperSurfaceIssueTitle(issue.code),
      issue.detail,
      [issue.evidence_path].filter(Boolean),
      [],
      "Route this defect back to write_paper or the paper-surface validator before treating the manuscript as clean.",
      0.9
    )
  );
}

function paperSurfaceIssueTitle(code: string): string {
  switch (code) {
    case "paper_acl_bibliography_style_mismatch":
      return "ACL bibliography style mismatch";
    case "paper_acl_template_absent_keywords":
      return "Template-absent keywords rendered";
    case "paper_repeated_citation_bundle":
      return "Repeated citation bundle";
    case "paper_render_validation_failed":
      return "Rendered paper validation failed";
    case "paper_missing_rendered_citations":
      return "Evidence-backed citations not rendered";
    default:
      return "Paper surface defect";
  }
}

function buildDecisionRationale(
  outcome: ReviewRecommendation,
  highFindings: ReviewFinding[],
  findings: ReviewFinding[],
  consistency: ReviewConsistencyReport,
  bias: ReviewBiasReport
): string {
  const parts: string[] = [];
  if (highFindings[0]) {
    parts.push(`Top blocking concern: ${highFindings[0].title}.`);
  }
  if (findings.length > 0) {
    parts.push(`Total findings: ${findings.length}.`);
  }
  parts.push(`Panel agreement: ${consistency.panel_agreement}.`);
  if (bias.flags[0]) {
    parts.push(`Bias flag: ${bias.flags[0].kind}.`);
  }
  parts.push(`Final outcome: ${outcome}.`);
  return parts.join(" ");
}

function summarizeDecision(
  outcome: ReviewRecommendation,
  highFindings: ReviewFinding[],
  mediumCount: number,
  carryRevisionChecklist = false
): string {
  if (outcome === "advance" && carryRevisionChecklist) {
    return `Advance with revisions: ${mediumCount} medium-severity issue(s) should be addressed while drafting the paper.`;
  }

  switch (outcome) {
    case "backtrack_to_implement":
      return `Backtrack to implement: runtime or verifier issues still block paper readiness.`;
    case "backtrack_to_hypotheses":
      return `Backtrack to hypotheses: the current claim set is no longer well supported by the reviewed evidence bundle.`;
    case "backtrack_to_design":
      return `Backtrack to design: methodological or statistical blockers remain.`;
    case "manual_block":
      return `Manual block: reviewer integrity concerns require human adjudication before writing.`;
    case "revise_in_place":
      return `Revise in place: ${mediumCount} medium-severity issue(s) should be resolved before paper drafting.`;
    default:
      return highFindings.length > 0
        ? `Advance only after human confirmation: blocking concerns were detected.`
        : "Advance: the panel found no blocking review issues.";
  }
}

function finalizeFallbackReviewer(input: {
  reviewer_id: string;
  reviewer_label: string;
  dimension: ReviewDimension;
  findings: ReviewFinding[];
  cleanSummary: string;
  issueSummary: string;
}): SpecialistReviewResult {
  const highest = input.findings[0];
  const recommendation = recommendFromFindings(input.dimension, input.findings);
  const score = scoreFromFindings(input.findings);
  return {
    reviewer_id: input.reviewer_id,
    reviewer_label: input.reviewer_label,
    dimension: input.dimension,
    score_1_to_5: score,
    confidence: highest ? highest.confidence : 0.68,
    recommendation,
    summary: input.findings.length > 0 ? input.issueSummary : input.cleanSummary,
    findings: input.findings.sort(compareFindings),
    source: "heuristic"
  };
}

function recommendFromFindings(
  dimension: ReviewDimension,
  findings: ReviewFinding[]
): ReviewRecommendation {
  const high = findings.filter((item) => item.severity === "high");
  const medium = findings.filter((item) => item.severity === "medium");
  if (high.length > 0) {
    if (dimension === "methodology" || dimension === "statistics") {
      return "backtrack_to_design";
    }
    if (dimension === "integrity" || dimension === "claim_verification") {
      return "manual_block";
    }
    return "revise_in_place";
  }
  if (medium.length >= 2 && (dimension === "methodology" || dimension === "statistics")) {
    return "backtrack_to_design";
  }
  if (medium.length > 0) {
    return "revise_in_place";
  }
  return "advance";
}

function scoreFromFindings(findings: ReviewFinding[]): number {
  const high = findings.filter((item) => item.severity === "high").length;
  const medium = findings.filter((item) => item.severity === "medium").length;
  if (high > 0) {
    return 2;
  }
  if (medium >= 2) {
    return 3;
  }
  if (medium === 1) {
    return 4;
  }
  return 5;
}

function computePairwiseRecommendationAgreement(reviewers: SpecialistReviewResult[]): number {
  if (reviewers.length <= 1) {
    return 1;
  }
  let pairs = 0;
  let matches = 0;
  for (let i = 0; i < reviewers.length; i += 1) {
    for (let j = i + 1; j < reviewers.length; j += 1) {
      pairs += 1;
      if (reviewers[i].recommendation === reviewers[j].recommendation) {
        matches += 1;
      }
    }
  }
  return pairs > 0 ? matches / pairs : 1;
}

function createFinding(
  reviewerId: string,
  reviewerLabel: string,
  dimension: ReviewDimension,
  severity: ReviewSeverity,
  title: string,
  detail: string,
  evidencePaths: string[],
  claimIds: string[],
  fixHint: string | undefined,
  confidence: number
): ReviewFinding {
  return {
    id: `${reviewerId}_${slugify(title)}`,
    reviewer_id: reviewerId,
    reviewer_label: reviewerLabel,
    dimension,
    severity,
    title,
    detail,
    claim_ids: claimIds,
    evidence_paths: evidencePaths,
    fix_hint: fixHint,
    confidence: clampConfidence(confidence)
  };
}

function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const map = new Map<string, ReviewFinding>();
  for (const finding of findings) {
    const key = `${finding.dimension}:${finding.title.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, finding);
      continue;
    }
    if (severityRank(finding.severity) > severityRank(existing.severity)) {
      map.set(key, {
        ...finding,
        evidence_paths: uniqueStrings([...existing.evidence_paths, ...finding.evidence_paths]),
        claim_ids: uniqueStrings([...existing.claim_ids, ...finding.claim_ids]),
        confidence: Math.max(existing.confidence, finding.confidence)
      });
      continue;
    }
    map.set(key, {
      ...existing,
      evidence_paths: uniqueStrings([...existing.evidence_paths, ...finding.evidence_paths]),
      claim_ids: uniqueStrings([...existing.claim_ids, ...finding.claim_ids]),
      confidence: Math.max(existing.confidence, finding.confidence)
    });
  }
  return [...map.values()].sort(compareFindings);
}

function compareFindings(left: ReviewFinding, right: ReviewFinding): number {
  return severityRank(right.severity) - severityRank(left.severity) || right.confidence - left.confidence;
}

function ownerForDimension(
  dimension: ReviewDimension,
  title: string
): ReviewRevisionPlanItem["owner"] {
  if (dimension === "methodology" || dimension === "statistics") {
    return "design";
  }
  if (dimension === "reproducibility") {
    return "implementation";
  }
  if (dimension === "writing_readiness") {
    return "writing";
  }
  if ((dimension === "integrity" || dimension === "adversarial") && /runtime|verifier|implement/iu.test(title)) {
    return "implementation";
  }
  if (dimension === "integrity" || dimension === "adversarial") {
    return "human_review";
  }
  return "analysis";
}

function claimIds(claims: AnalysisPaperClaim[]): string[] {
  return claims.map((claim) => slugify(claim.claim).slice(0, 24)).filter(Boolean);
}

function moreConservativeRecommendation(
  left: ReviewRecommendation,
  right: ReviewRecommendation
): ReviewRecommendation {
  return recommendationRank(left) >= recommendationRank(right) ? left : right;
}

function recommendationRank(value: ReviewRecommendation): number {
  switch (value) {
    case "advance":
      return 0;
    case "revise_in_place":
      return 1;
    case "backtrack_to_implement":
      return 2;
    case "backtrack_to_design":
      return 3;
    case "backtrack_to_hypotheses":
      return 4;
    case "manual_block":
      return 5;
  }
}

function normalizeRecommendation(value: unknown): ReviewRecommendation | undefined {
  switch (value) {
    case "advance":
    case "revise_in_place":
    case "backtrack_to_hypotheses":
    case "backtrack_to_design":
    case "backtrack_to_implement":
    case "manual_block":
      return value;
    default:
      return undefined;
  }
}

function normalizeSeverity(value: unknown): ReviewSeverity | undefined {
  switch (value) {
    case "low":
    case "medium":
    case "high":
      return value;
    default:
      return undefined;
  }
}

function severityRank(value: ReviewSeverity): number {
  switch (value) {
    case "low":
      return 0;
    case "medium":
      return 1;
    case "high":
      return 2;
  }
}

function clampScore(value: number): number {
  return Math.max(1, Math.min(5, Math.round(value)));
}

function clampConfidence(value: number): number {
  return roundTwo(Math.max(0, Math.min(1, value)));
}

function normalizeStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.map((item) => cleanString(item)).filter(Boolean)).slice(0, limit);
}

function uniqueStrings(items: Array<string | undefined | null>): string[] {
  return [
    ...new Set(
      items
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    )
  ];
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

function resolveReviewRefinementTimeoutMs(): number {
  const raw = process.env.AUTOLABOS_REVIEW_REFINEMENT_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_REVIEW_REFINEMENT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REVIEW_REFINEMENT_TIMEOUT_MS;
}

function describeReviewRefinementFallbackReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const timeoutMs = resolveReviewRefinementTimeoutMs();
  if (message === `review_refinement_timeout_after_${timeoutMs}ms`) {
    return `reviewer exceeded the ${timeoutMs}ms timeout`;
  }
  return message;
}

async function runWithAbortableTimeout<T>(
  timeoutMs: number,
  outerAbortSignal: AbortSignal | undefined,
  operation: (abortSignal: AbortSignal | undefined) => Promise<T>,
  timeoutErrorMessage: string
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return operation(outerAbortSignal);
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;

  const abortFromOuterSignal = () => controller.abort();
  if (outerAbortSignal) {
    if (outerAbortSignal.aborted) {
      controller.abort();
    } else {
      outerAbortSignal.addEventListener("abort", abortFromOuterSignal, { once: true });
    }
  }

  timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) {
      throw new Error(timeoutErrorMessage);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    outerAbortSignal?.removeEventListener("abort", abortFromOuterSignal);
  }
}
