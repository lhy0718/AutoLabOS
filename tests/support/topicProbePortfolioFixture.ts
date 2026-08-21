import type {
  HypothesisCandidate,
  HypothesisEvidenceSeed,
  HypothesisReview
} from "../../src/core/analysis/researchPlanning.js";
import {
  RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS,
  buildResearchFunnelArtifactBinding,
  buildResearchGapMap,
  buildTopicDecision,
  buildTopicPortfolio,
  validateTopicPortfolioArtifact,
  type TopicDecision,
  type TopicPortfolio
} from "../../src/core/researchFunnel.js";
import {
  buildActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "../../src/core/activeTopicProbeContract.js";
import {
  buildPassingPriorAbsorptionMatrixFixture
} from "./priorAbsorptionFixture.js";
import {
  makeTopicProbeComputeBudgetLimits
} from "./topicProbeComputeBudget.js";
import type { TopicProbeComputeBudgetLimits } from "../../src/core/topicProbeComputeBudget.js";
import { makeIndependentHypothesisReviewProvenance } from "./hypothesisReviewProvenance.js";
import type { TopicMemoryLedger } from "../../src/core/topicMemory.js";
import type { TopicMemorySemanticAudit } from "../../src/core/topicMemorySemanticAudit.js";

export const TOPIC_PROBE_FIXTURE_CANDIDATE_IDS = [
  "candidate_reference_1",
  "candidate_reference_2",
  "candidate_reference_3",
  "candidate_reference_4",
  "candidate_reference_5"
] as const;

export interface TopicProbePortfolioFixture {
  portfolio: TopicPortfolio;
  candidates: HypothesisCandidate[];
  evidence: HypothesisEvidenceSeed[];
}

export interface TopicProbePortfolioFixtureOptions {
  runId?: string;
  researchCycle?: number;
  generatedAt?: string;
  probeCandidateIds?: string[];
  computeBudgetLimits?: TopicProbeComputeBudgetLimits;
  topicMemoryLedger?: TopicMemoryLedger;
  topicSemanticAuditsByCandidateId?: ReadonlyMap<
    string,
    TopicMemorySemanticAudit
  >;
}

export interface TopicProbeLineageFixture extends TopicProbePortfolioFixture {
  decision: TopicDecision;
  activeContract: ActiveTopicProbeContract;
}

export function buildTopicProbePortfolioFixture(
  options: TopicProbePortfolioFixtureOptions = {}
): TopicProbePortfolioFixture {
  const runId = options.runId ?? "run_topic_probe_fixture";
  const researchCycle = options.researchCycle ?? 1;
  const generatedAt = options.generatedAt ?? "2026-01-01T00:00:00.000Z";
  const computeBudgetLimits =
    options.computeBudgetLimits ?? makeTopicProbeComputeBudgetLimits();
  const evidence = buildEvidence();
  const gapMap = buildResearchGapMap({
    evidence,
    runId,
    researchCycle,
    generatedAt
  });
  const candidates = TOPIC_PROBE_FIXTURE_CANDIDATE_IDS.map((id, index) =>
    buildCandidate(
      id,
      index,
      evidence.map((item) => item.evidence_id!),
      computeBudgetLimits
    )
  );
  const evidenceAxes = [1, 2, 3].map((index) => ({
    id: `evaluation_axis_${index}`,
    label: `Evaluation axis ${index}`,
    mechanism: `Mechanism ${index} defines a distinct bounded comparison.`,
    intervention: `Intervention ${index} is evaluated under the matched protocol.`,
    evidence_links: evidence.map((item) => item.evidence_id!)
  }));
  const reviews = candidates.map((candidate) => buildReview(candidate.id));
  const priorAbsorptionMatrix = buildPassingPriorAbsorptionMatrixFixture({
    candidates,
    evidence,
    runId,
    researchCycle,
    generatedAt
  });
  const sourceArtifactBindings = RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS.map(
    (artifactPath) =>
      buildResearchFunnelArtifactBinding(artifactPath, `${artifactPath}\n`)
  );
  const portfolio = buildTopicPortfolio({
    candidates,
    reviews,
    probeCandidateIds:
      options.probeCandidateIds ?? [...TOPIC_PROBE_FIXTURE_CANDIDATE_IDS],
    evidence,
    evidenceAxes,
    gapMap,
    runId,
    researchCycle,
    generatedAt,
    sourceArtifactBindings,
    priorAbsorptionMatrix,
    computeBudgetCeiling: computeBudgetLimits,
    topicMemoryLedger: options.topicMemoryLedger,
    topicSemanticAuditsByCandidateId:
      options.topicSemanticAuditsByCandidateId
  });
  const validation = validateTopicPortfolioArtifact(JSON.stringify(portfolio), {
    expectedRunId: runId,
    expectedResearchCycle: researchCycle
  });
  if (!validation.valid || !portfolio.probe_allowed) {
    throw new Error(
      `invalid_topic_probe_portfolio_fixture:${validation.reasons.join(",")}`
    );
  }
  return { portfolio, candidates, evidence };
}

export function buildTopicProbeLineageFixture(
  options: TopicProbePortfolioFixtureOptions = {}
): TopicProbeLineageFixture {
  const runId = options.runId ?? "run_topic_probe_fixture";
  const researchCycle = options.researchCycle ?? 1;
  const generatedAt = options.generatedAt ?? "2026-01-01T00:00:00.000Z";
  const fixture = buildTopicProbePortfolioFixture({
    ...options,
    runId,
    researchCycle,
    generatedAt
  });
  const validation = validateTopicPortfolioArtifact(
    JSON.stringify(fixture.portfolio),
    { expectedRunId: runId, expectedResearchCycle: researchCycle }
  );
  const decision = buildTopicDecision({
    runId,
    researchCycle,
    validation,
    generatedAt
  });
  const activeCandidate = fixture.portfolio.candidates.find(
    (candidate) =>
      candidate.source_candidate_id === decision.probe_candidate_ids[0]
  );
  if (!decision.probe_allowed || !activeCandidate) {
    throw new Error("invalid_topic_probe_lineage_fixture");
  }
  const activeContract = buildActiveTopicProbeContract({
    runId,
    researchCycle,
    researchMode: "topic_discovery",
    portfolioContentSha256: fixture.portfolio.content_sha256,
    candidate: activeCandidate,
    deferredCandidateIds: fixture.portfolio.probe_candidate_ids.filter(
      (candidateId) => candidateId !== activeCandidate.source_candidate_id
    ),
    generatedAt
  });
  return { ...fixture, decision, activeContract };
}

function buildEvidence(): HypothesisEvidenceSeed[] {
  return [
    buildEvidenceRow("evidence_reference_1", "paper_reference_1"),
    buildEvidenceRow("evidence_reference_2", "paper_reference_2")
  ];
}

function buildEvidenceRow(
  evidenceId: string,
  paperId: string
): HypothesisEvidenceSeed {
  return {
    evidence_id: evidenceId,
    paper_id: paperId,
    canonical_work_id: `work_${paperId}`,
    claim: "A measured result was reported under the declared evaluation scope.",
    method_slot: "A declared intervention was evaluated against a comparator.",
    result_slot: "A matched comparison result was reported.",
    limitation_slot:
      "The evaluation omits an independently controlled validation partition.",
    limitation_kind: "scientific",
    dataset_slot: "declared_public_evaluation_scope",
    metric_slot: "primary_measure",
    evidence_span:
      "The evaluation omits an independently controlled validation partition.",
    source_type: "full_text",
    source_scope: "full_text_excerpt",
    grounding_status: "grounded_span",
    confidence: 0.9,
    confidence_reason: "The supplied source span directly states the limitation."
  };
}

function buildCandidate(
  id: string,
  index: number,
  evidenceLinks: string[],
  computeBudgetLimits: TopicProbeComputeBudgetLimits
): HypothesisCandidate {
  return {
    id,
    text:
      `Intervention ${index + 1} improves the primary measure under a matched protocol.`,
    novelty: 4,
    feasibility: 4,
    testability: 5,
    cost: 2,
    expected_gain: 3,
    evidence_links: evidenceLinks,
    axis_ids: [`evaluation_axis_${(index % 3) + 1}`],
    gap_statement:
      "Existing evaluations omit an independently controlled validation partition.",
    closest_prior_non_overlap:
      "The candidate tests a matched intervention absent from the linked prior work.",
    reviewer_absorption_objection:
      "The candidate must distinguish its intervention from the strongest comparator.",
    comparator: "declared_reference",
    dataset_task_bench: "declared_public_evaluation_scope",
    primary_metric: "primary_measure",
    metric_unit: "score_unit",
    metric_scale: "raw",
    metric_direction: "maximize",
    effect_criterion: {
      basis: "delta_vs_reference",
      magnitude: 0.04,
      scale: "raw",
      inclusive: true
    },
    meaningful_effect:
      "At least 0.04 raw-score improvement over the declared reference.",
    measurement_signals: ["primary_measure", "uncertainty_interval"],
    measurement_hint:
      "Compare repeated matched runs with an uncertainty interval.",
    falsifier:
      "The matched estimate does not meet the structured practical-effect criterion.",
    local_budget: JSON.stringify(computeBudgetLimits),
    kill_signal:
      "Stop when matched evaluation units or the declared reference cannot execute.",
    contribution_claim:
      `A controlled estimate of intervention ${index + 1} under a matched protocol.`,
    minimum_publishable_evidence:
      "Independent repetitions, uncertainty estimates, a baseline comparison, and failure analysis."
  };
}

function buildReview(candidateId: string): HypothesisReview {
  return {
    candidate_id: candidateId,
    keep: true,
    groundedness: 4,
    causal_clarity: 4,
    falsifiability: 4,
    experimentability: 4,
    measurement_specificity: 4,
    measurement_signals: ["repeated_run_variance"],
    measurement_hint:
      "Compare the primary measure with uncertainty across matched runs.",
    limitation_reflection: 4,
    measurement_readiness: 4,
    strengths: ["The comparison and falsifier are explicit."],
    weaknesses: ["The bounded scope requires later external validation."],
    provenance: makeIndependentHypothesisReviewProvenance(candidateId)
  };
}
