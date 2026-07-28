import { describe, expect, it } from "vitest";

import {
  RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS,
  buildResearchFunnelArtifactBinding,
  buildResearchGapMap,
  buildTopicDecision,
  buildTopicPortfolio,
  hashCanonical,
  resolveSupportedGapIds,
  validateResearchFunnelClosedChain,
  validateResearchGapMapArtifact,
  validateTopicDecisionArtifact,
  validateTopicPortfolioArtifact,
  type ResearchFunnelClosedChainInput,
  type TopicDecision,
  type TopicPortfolio
} from "../src/core/researchFunnel.js";
import type {
  HypothesisCandidate,
  HypothesisEvidenceAxis,
  HypothesisReview
} from "../src/core/analysis/researchPlanning.js";
import {
  PRIOR_ABSORPTION_AXES,
  buildPriorAbsorptionMatrix,
  projectPriorAbsorptionCandidate,
  type PriorAbsorptionAssessment,
  type PriorAbsorptionEvidenceSeed
} from "../src/core/priorAbsorption.js";
import { makeTopicProbeComputeBudgetDeclaration } from "./support/topicProbeComputeBudget.js";

const GENERATED_AT = "2026-01-01T00:00:00.000Z";
const RUN_ID = "run_integrity_fixture";
const RESEARCH_CYCLE = 3;
const ROUTE_IDS = [
  "route_alpha",
  "route_beta",
  "route_gamma",
  "route_delta",
  "route_epsilon"
] as const;

describe("research funnel semantic integrity", () => {
  it("accepts one complete, byte-bound closed chain", () => {
    const fixture = buildClosedChainFixture();

    const validation = validateResearchFunnelClosedChain(fixture.input);

    expect(validation).toMatchObject({
      complete: true,
      valid: true,
      probeAllowed: true,
      approvedCandidateIds: [ROUTE_IDS[0]],
      reasons: []
    });
  });

  it("rejects forged candidate gates even after candidate and portfolio hashes are recomputed", () => {
    const fixture = buildClosedChainFixture();
    const forged = structuredClone(fixture.portfolio);
    delete forged.candidates[0]!.comparator;
    forged.candidates[0] = rehashCandidate(forged.candidates[0]!);
    const rehashed = rehashPortfolio(forged);

    const validation = validateTopicPortfolioArtifact(JSON.stringify(rehashed), fixture.context);

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(
      `topic_candidate:${rehashed.candidates[0]!.topic_id}_gate_status_mismatch:comparator_present`
    );
    expect(validation.reasons).toContain(
      `topic_candidate_formulation_id_mismatch:${rehashed.candidates[0]!.topic_id}`
    );
  });

  it("rejects rehashed cluster breadth and probe authorization tampering", () => {
    const fixture = buildClosedChainFixture();
    const forged = structuredClone(fixture.portfolio);
    for (const item of forged.candidates) {
      item.cluster_ids = ["axis_shared"];
      Object.assign(item, rehashCandidate(item));
    }
    const validation = validateTopicPortfolioArtifact(
      JSON.stringify(rehashPortfolio(forged)),
      fixture.context
    );

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain("topic_portfolio_cluster_policy_mismatch");
    expect(validation.reasons).toContain(
      "topic_portfolio_gate_status_mismatch:evidence_axis_cluster_diversity"
    );
    expect(validation.reasons).toContain("topic_portfolio_probe_allowed_state_mismatch");
    expect(validation.reasons).not.toContain(
      `topic_candidate_id_mismatch:${forged.candidates[0]!.topic_id}`
    );
  });

  it("rejects rehashed gap support and decision state that contradict bound artifacts", () => {
    const fixture = buildClosedChainFixture();
    const forgedGapMap = structuredClone(fixture.gapMap);
    forgedGapMap.gaps[0]!.support.full_text_paper_count = 0;
    const { content_sha256: _gapHash, ...gapPayload } = forgedGapMap;
    forgedGapMap.content_sha256 = hashCanonical(gapPayload);

    const forgedDecision = rehashDecision({
      ...fixture.decision,
      portfolio_content_sha256: "b".repeat(64)
    });
    const gapValidation = validateResearchGapMapArtifact(
      JSON.stringify(forgedGapMap),
      fixture.context
    );
    const decisionValidation = validateTopicDecisionArtifact(
      JSON.stringify(forgedDecision),
      fixture.upstreamValidation.portfolioValidation,
      fixture.context
    );

    expect(gapValidation.valid).toBe(false);
    expect(gapValidation.reasons).toContain(
      `research_gap_epistemic_status_mismatch:${forgedGapMap.gaps[0]!.gap_id}`
    );
    expect(decisionValidation.valid).toBe(false);
    expect(decisionValidation.reasons).toContain("topic_decision_portfolio_hash_mismatch");
  });

  it("rejects fake or missing source hashes even when the portfolio is rehashed", () => {
    const fixture = buildClosedChainFixture();
    const fakeHashPortfolio = structuredClone(fixture.portfolio);
    fakeHashPortfolio.source_artifact_bindings.find(
      (binding) => binding.path === "hypotheses.jsonl"
    )!.sha256 = "0".repeat(64);
    const fakeHashValidation = validateResearchFunnelClosedChain({
      ...fixture.input,
      portfolioRaw: JSON.stringify(rehashPortfolio(fakeHashPortfolio))
    });

    const missingHashPortfolio = structuredClone(fixture.portfolio);
    missingHashPortfolio.source_artifact_bindings.find(
      (binding) => binding.path === "hypotheses.jsonl"
    )!.sha256 = "";
    const missingHashValidation = validateResearchFunnelClosedChain({
      ...fixture.input,
      portfolioRaw: JSON.stringify(rehashPortfolio(missingHashPortfolio))
    });

    expect(fakeHashValidation.valid).toBe(false);
    expect(fakeHashValidation.reasons).toContain(
      "topic_portfolio_source_binding_hash_mismatch:hypotheses.jsonl"
    );
    expect(missingHashValidation.valid).toBe(false);
    expect(missingHashValidation.reasons).toContain(
      "topic_portfolio_source_binding_sha256_invalid:hypotheses.jsonl"
    );
  });

  it("rejects a re-bound evidence-axis artifact that no longer resolves draft axes", () => {
    const fixture = buildClosedChainFixture();
    const axes = JSON.parse(fixture.input.evidenceAxesRaw!) as Array<{
      id: string;
    }>;
    axes[0]!.id = "axis_forged";
    const evidenceAxesRaw = `${JSON.stringify(axes, null, 2)}\n`;
    const portfolio = replaceSourceBinding(
      fixture.portfolio,
      "hypothesis_generation/evidence_axes.json",
      evidenceAxesRaw
    );

    const validation = validateResearchFunnelClosedChain({
      ...fixture.input,
      evidenceAxesRaw,
      portfolioRaw: JSON.stringify(portfolio)
    });

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(
      `research_funnel_draft_axis_id_unknown:${ROUTE_IDS[0]}:axis_1`
    );
    expect(validation.reasons).toContain(
      `research_funnel_candidate_axis_resolution_mismatch:${ROUTE_IDS[0]}`
    );
  });

  it("rejects a self-consistent prior matrix whose evidence span differs from the source row", () => {
    const fixture = buildClosedChainFixture();
    const drafts = parseJsonl(fixture.input.draftsRaw!) as unknown as HypothesisCandidate[];
    const forgedEvidence = evidence().map((item) => ({
      ...item,
      evidence_span: `${item.evidence_span} Forged suffix.`
    }));
    const forgedMatrix = passingPriorAbsorptionMatrix(drafts, forgedEvidence);
    const priorAbsorptionMatrixRaw =
      `${JSON.stringify(forgedMatrix, null, 2)}\n`;
    const forgedPortfolio = structuredClone(fixture.portfolio);
    forgedPortfolio.source_prior_absorption_matrix_sha256 =
      forgedMatrix.content_sha256;
    forgedPortfolio.candidates = forgedPortfolio.candidates.map((candidate) =>
      rehashCandidate({
        ...candidate,
        prior_absorption: projectPriorAbsorptionCandidate(
          forgedMatrix,
          candidate.source_candidate_id
        )
      })
    );
    const portfolio = replaceSourceBinding(
      forgedPortfolio,
      "hypothesis_generation/prior_absorption_matrix.json",
      priorAbsorptionMatrixRaw
    );

    const validation = validateResearchFunnelClosedChain({
      ...fixture.input,
      priorAbsorptionMatrixRaw,
      portfolioRaw: JSON.stringify(portfolio)
    });

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(
      `research_funnel_prior_absorption_evidence_ref_mismatch:${ROUTE_IDS[0]}:ev_methods`
    );
  });

  it("rejects a copied chain from another run or research cycle", () => {
    const fixture = buildClosedChainFixture();

    const validation = validateResearchFunnelClosedChain({
      ...fixture.input,
      expectedRunId: "run_copy_target",
      expectedResearchCycle: RESEARCH_CYCLE + 1
    });

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toEqual(expect.arrayContaining([
      "research_gap_map_run_id_mismatch",
      "research_gap_map_research_cycle_mismatch",
      "topic_portfolio_run_id_mismatch",
      "topic_portfolio_research_cycle_mismatch",
      `research_funnel_hypothesis_run_id_mismatch:${ROUTE_IDS[0]}`,
      `research_funnel_hypothesis_research_cycle_mismatch:${ROUTE_IDS[0]}`,
      "topic_decision_run_id_mismatch",
      "topic_decision_research_cycle_mismatch"
    ]));
  });

  it("rejects missing review coverage despite matching source bytes and hashes", () => {
    const fixture = buildClosedChainFixture();
    const reviewsRaw = serializeJsonl(fixture.boundReviews.slice(1));
    const portfolio = replaceSourceBinding(
      fixture.portfolio,
      "hypothesis_generation/reviews.jsonl",
      reviewsRaw
    );

    const validation = validateResearchFunnelClosedChain({
      ...fixture.input,
      reviewsRaw,
      portfolioRaw: JSON.stringify(portfolio)
    });

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(
      `research_funnel_review_missing:${ROUTE_IDS[0]}`
    );
    expect(validation.reasons).toContain("research_funnel_review_candidate_set_mismatch");
  });

  it("rejects hypothesis and shortlist candidate/topic identity mismatches", () => {
    const fixture = buildClosedChainFixture();
    const hypotheses = parseJsonl(fixture.input.hypothesesRaw!);
    hypotheses[0]!.candidate_id = ROUTE_IDS[1];
    const hypothesesRaw = serializeJsonl(hypotheses);
    const hypothesisPortfolio = replaceSourceBinding(
      fixture.portfolio,
      "hypotheses.jsonl",
      hypothesesRaw
    );
    const hypothesisValidation = validateResearchFunnelClosedChain({
      ...fixture.input,
      hypothesesRaw,
      portfolioRaw: JSON.stringify(hypothesisPortfolio)
    });

    const shortlist = JSON.parse(fixture.input.probeShortlistRaw!) as Record<string, unknown>;
    shortlist.probe_topic_ids = ["topic_unbound"];
    const probeShortlistRaw = JSON.stringify(shortlist, null, 2);
    const shortlistPortfolio = replaceSourceBinding(
      fixture.portfolio,
      "hypothesis_generation/probe_shortlist.json",
      probeShortlistRaw
    );
    const shortlistValidation = validateResearchFunnelClosedChain({
      ...fixture.input,
      probeShortlistRaw,
      portfolioRaw: JSON.stringify(shortlistPortfolio)
    });

    expect(hypothesisValidation.valid).toBe(false);
    expect(hypothesisValidation.reasons).toContain(
      "research_funnel_hypothesis_shortlist_candidate_mismatch"
    );
    expect(shortlistValidation.valid).toBe(false);
    expect(shortlistValidation.reasons).toEqual(expect.arrayContaining([
      "research_funnel_probe_shortlist_candidate_topic_mapping_mismatch",
      "research_funnel_portfolio_shortlist_topic_mismatch"
    ]));
  });

  it.each([
    { contractField: "statement", hypothesisField: "text", tamperedValue: "Tampered candidate statement." },
    { contractField: "evidence_links", hypothesisField: "evidence_links", tamperedValue: ["ev_unbound"] },
    { contractField: "axis_ids", hypothesisField: "axis_ids", tamperedValue: ["axis_unbound"] },
    { contractField: "gap_statement", hypothesisField: "gap_statement", tamperedValue: "Tampered gap." },
    {
      contractField: "closest_prior_non_overlap",
      hypothesisField: "closest_prior_non_overlap",
      tamperedValue: "Tampered prior-work boundary."
    },
    {
      contractField: "reviewer_absorption_objection",
      hypothesisField: "reviewer_absorption_objection",
      tamperedValue: "Tampered reviewer objection."
    },
    { contractField: "comparator", hypothesisField: "comparator", tamperedValue: "Unbound comparator" },
    {
      contractField: "dataset_task_bench",
      hypothesisField: "dataset_task_bench",
      tamperedValue: "unbound_evaluation_fixture"
    },
    { contractField: "primary_metric", hypothesisField: "primary_metric", tamperedValue: "unbound_score" },
    { contractField: "metric_unit", hypothesisField: "metric_unit", tamperedValue: "milliseconds" },
    { contractField: "metric_scale", hypothesisField: "metric_scale", tamperedValue: "percent" },
    { contractField: "metric_direction", hypothesisField: "metric_direction", tamperedValue: "minimize" },
    {
      contractField: "objective_raw",
      hypothesisField: "objective_raw",
      tamperedValue: "tampered objective contract"
    },
    {
      contractField: "effect_criterion",
      hypothesisField: "effect_criterion",
      tamperedValue: {
        basis: "delta_vs_reference",
        magnitude: 0.10,
        scale: "raw",
        inclusive: true
      }
    },
    {
      contractField: "meaningful_effect",
      hypothesisField: "meaningful_effect",
      tamperedValue: "Any nonzero change."
    },
    { contractField: "falsifier", hypothesisField: "falsifier", tamperedValue: "Tampered falsifier." },
    { contractField: "local_budget", hypothesisField: "local_budget", tamperedValue: "Unbounded execution." },
    { contractField: "kill_signal", hypothesisField: "kill_signal", tamperedValue: "Never stop." },
    {
      contractField: "contribution_claim",
      hypothesisField: "contribution_claim",
      tamperedValue: "Tampered contribution claim."
    },
    {
      contractField: "minimum_publishable_evidence",
      hypothesisField: "minimum_publishable_evidence",
      tamperedValue: "One unverified observation."
    }
  ])(
    "rejects rebound hypotheses.jsonl tampering of $contractField",
    ({ contractField, hypothesisField, tamperedValue }) => {
      const fixture = buildClosedChainFixture();
      const hypotheses = parseJsonl(fixture.input.hypothesesRaw!);
      hypotheses[0]![hypothesisField] = tamperedValue;
      const hypothesesRaw = serializeJsonl(hypotheses);
      const portfolio = replaceSourceBinding(
        fixture.portfolio,
        "hypotheses.jsonl",
        hypothesesRaw
      );

      const validation = validateResearchFunnelClosedChain({
        ...fixture.input,
        hypothesesRaw,
        portfolioRaw: JSON.stringify(portfolio),
        decisionRaw: undefined,
        requireDecision: false
      });

      expect(validation.valid).toBe(false);
      expect(validation.reasons).toContain(
        `research_funnel_hypothesis_contract_mismatch:${ROUTE_IDS[0]}:${contractField}`
      );
      expect(validation.reasons).not.toContain(
        "topic_portfolio_source_binding_hash_mismatch:hypotheses.jsonl"
      );
    }
  );

  it.each(["metric_unit", "metric_scale", "effect_criterion", "objective_raw"])(
    "rejects omission of required hypotheses.jsonl contract field %s",
    (field) => {
      const fixture = buildClosedChainFixture();
      const hypotheses = parseJsonl(fixture.input.hypothesesRaw!);
      delete hypotheses[0]![field];
      const hypothesesRaw = serializeJsonl(hypotheses);
      const portfolio = replaceSourceBinding(
        fixture.portfolio,
        "hypotheses.jsonl",
        hypothesesRaw
      );

      const validation = validateResearchFunnelClosedChain({
        ...fixture.input,
        hypothesesRaw,
        portfolioRaw: JSON.stringify(portfolio),
        decisionRaw: undefined,
        requireDecision: false
      });

      expect(validation.valid).toBe(false);
      expect(validation.reasons).toContain(
        `research_funnel_hypothesis_contract_mismatch:${ROUTE_IDS[0]}:${field}`
      );
    }
  );

  it.each([
    { field: "metric_unit", tamperedValue: "milliseconds" },
    { field: "metric_scale", tamperedValue: "percent" },
    {
      field: "effect_criterion",
      tamperedValue: {
        basis: "delta_vs_reference",
        magnitude: 0.10,
        scale: "raw",
        inclusive: true
      }
    }
  ])("rejects rebound draft tampering of $field", ({ field, tamperedValue }) => {
    const fixture = buildClosedChainFixture();
    const drafts = parseJsonl(fixture.input.draftsRaw!);
    drafts[0]![field] = tamperedValue;
    const draftsRaw = serializeJsonl(drafts);
    const portfolio = replaceSourceBinding(
      fixture.portfolio,
      "hypothesis_generation/drafts.jsonl",
      draftsRaw
    );

    const validation = validateResearchFunnelClosedChain({
      ...fixture.input,
      draftsRaw,
      portfolioRaw: JSON.stringify(portfolio),
      decisionRaw: undefined,
      requireDecision: false
    });

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(
      `research_funnel_draft_contract_mismatch:${ROUTE_IDS[0]}:${field}`
    );
    expect(validation.reasons).not.toContain(
      "topic_portfolio_source_binding_hash_mismatch:hypothesis_generation/drafts.jsonl"
    );
  });
});

interface ClosedChainFixture {
  context: { expectedRunId: string; expectedResearchCycle: number };
  input: ResearchFunnelClosedChainInput;
  gapMap: ReturnType<typeof buildResearchGapMap>;
  portfolio: TopicPortfolio;
  decision: TopicDecision;
  boundReviews: Array<HypothesisReview & { run_id: string; research_cycle: number }>;
  upstreamValidation: ReturnType<typeof validateResearchFunnelClosedChain>;
}

function buildClosedChainFixture(): ClosedChainFixture {
  const evidenceRows = evidence();
  const gapMap = buildResearchGapMap({
    evidence: evidenceRows,
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    collectAttemptId: "20260102030405678-genericattempt",
    corpusSha256: "a".repeat(64),
    corpusByteLength: 128,
    evidenceSha256: "b".repeat(64),
    evidenceByteLength: 256,
    generatedAt: GENERATED_AT
  });
  const candidates = ROUTE_IDS.map(candidate);
  const evidenceAxes: HypothesisEvidenceAxis[] = [1, 2, 3].map((index) => ({
    id: `axis_${index}`,
    label: `Evidence axis ${index}`,
    mechanism: `Mechanism ${index} is grounded in both linked priors.`,
    intervention: `Intervention ${index} isolates the declared comparison.`,
    evidence_links: ["ev_methods", "ev_audit"]
  }));
  const boundDrafts = candidates.map((item) => ({
    ...item,
    run_id: RUN_ID,
    research_cycle: RESEARCH_CYCLE,
    supported_gap_ids: resolveSupportedGapIds(item.evidence_links, gapMap)
  }));
  const priorAbsorptionMatrix = passingPriorAbsorptionMatrix(candidates, evidenceRows);
  const boundReviews = candidates.map((item) => ({
    ...review(item.id),
    run_id: RUN_ID,
    research_cycle: RESEARCH_CYCLE
  }));
  const preliminaryPortfolio = buildTopicPortfolio({
    candidates: boundDrafts,
    reviews: boundReviews,
    probeCandidateIds: [ROUTE_IDS[0]],
    evidence: evidenceRows,
    evidenceAxes,
    gapMap,
    priorAbsorptionMatrix,
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    generatedAt: GENERATED_AT
  });
  const hypotheses = preliminaryPortfolio.probe_candidate_ids.map((candidateId, index) => {
    const item = boundDrafts.find((draft) => draft.id === candidateId)!;
    return {
      hypothesis_id: `h_${index + 1}`,
      candidate_id: candidateId,
      run_id: RUN_ID,
      research_cycle: RESEARCH_CYCLE,
      supported_gap_ids: item.supported_gap_ids,
      text: item.text,
      evidence_links: item.evidence_links,
      axis_ids: item.axis_ids,
      gap_statement: item.gap_statement,
      closest_prior_non_overlap: item.closest_prior_non_overlap,
      reviewer_absorption_objection: item.reviewer_absorption_objection,
      comparator: item.comparator,
      dataset_task_bench: item.dataset_task_bench,
      primary_metric: item.primary_metric,
      metric_unit: item.metric_unit,
      metric_scale: item.metric_scale,
      metric_direction: item.metric_direction,
      effect_criterion: item.effect_criterion,
      objective_raw: preliminaryPortfolio.candidates.find(
        (candidate) => candidate.source_candidate_id === candidateId
      )?.objective_raw,
      meaningful_effect: item.meaningful_effect,
      measurement_signals: item.measurement_signals,
      measurement_hint: item.measurement_hint,
      falsifier: item.falsifier,
      local_budget: item.local_budget,
      kill_signal: item.kill_signal,
      contribution_claim: item.contribution_claim,
      minimum_publishable_evidence: item.minimum_publishable_evidence
    };
  });
  const shortlist = {
    run_id: RUN_ID,
    research_cycle: RESEARCH_CYCLE,
    probe_candidate_ids: preliminaryPortfolio.probe_candidate_ids,
    probe_topic_ids: preliminaryPortfolio.probe_topic_ids,
    ranked_candidate_ids: candidates.map((item) => item.id),
    scores: candidates.map((item) => ({ candidate_id: item.id }))
  };
  const gapMapRaw = JSON.stringify(gapMap, null, 2);
  const evidenceAxesRaw = `${JSON.stringify(evidenceAxes, null, 2)}\n`;
  const priorAbsorptionMatrixRaw =
    `${JSON.stringify(priorAbsorptionMatrix, null, 2)}\n`;
  const hypothesesRaw = serializeJsonl(hypotheses);
  const draftsRaw = serializeJsonl(boundDrafts);
  const reviewsRaw = serializeJsonl(boundReviews);
  const probeShortlistRaw = JSON.stringify(shortlist, null, 2);
  const sourceContents = {
    "analysis/gap_map.json": gapMapRaw,
    "hypothesis_generation/evidence_axes.json": evidenceAxesRaw,
    "hypothesis_generation/prior_absorption_matrix.json":
      priorAbsorptionMatrixRaw,
    "hypotheses.jsonl": hypothesesRaw,
    "hypothesis_generation/drafts.jsonl": draftsRaw,
    "hypothesis_generation/reviews.jsonl": reviewsRaw,
    "hypothesis_generation/probe_shortlist.json": probeShortlistRaw
  } as const;
  const sourceArtifactBindings = RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS.map((artifactPath) =>
    buildResearchFunnelArtifactBinding(artifactPath, sourceContents[artifactPath])
  );
  const portfolio = buildTopicPortfolio({
    candidates: boundDrafts,
    reviews: boundReviews,
    probeCandidateIds: shortlist.probe_candidate_ids,
    evidence: evidenceRows,
    evidenceAxes,
    gapMap,
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    generatedAt: GENERATED_AT,
    priorAbsorptionMatrix,
    sourceArtifactBindings
  });
  const portfolioRaw = JSON.stringify(portfolio, null, 2);
  const upstreamInput: ResearchFunnelClosedChainInput = {
    expectedRunId: RUN_ID,
    expectedResearchCycle: RESEARCH_CYCLE,
    gapMapRaw,
    evidenceAxesRaw,
    priorAbsorptionMatrixRaw,
    hypothesesRaw,
    draftsRaw,
    reviewsRaw,
    probeShortlistRaw,
    portfolioRaw,
    gapValidationContext: {
      evidence: evidenceRows
    },
    requireDecision: false
  };
  const upstreamValidation = validateResearchFunnelClosedChain(upstreamInput);
  const decision = buildTopicDecision({
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    validation: upstreamValidation,
    generatedAt: GENERATED_AT
  });
  return {
    context: { expectedRunId: RUN_ID, expectedResearchCycle: RESEARCH_CYCLE },
    input: {
      ...upstreamInput,
      decisionRaw: JSON.stringify(decision, null, 2),
      requireDecision: true
    },
    gapMap,
    portfolio,
    decision,
    boundReviews,
    upstreamValidation
  };
}

function replaceSourceBinding(
  portfolio: TopicPortfolio,
  artifactPath: (typeof RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS)[number],
  content: string
): TopicPortfolio {
  const changed = structuredClone(portfolio);
  const index = changed.source_artifact_bindings.findIndex((binding) => binding.path === artifactPath);
  changed.source_artifact_bindings[index] = buildResearchFunnelArtifactBinding(artifactPath, content);
  return rehashPortfolio(changed);
}

function rehashCandidate(candidateValue: TopicPortfolio["candidates"][number]) {
  const { content_sha256: _contentHash, ...payload } = candidateValue;
  return { ...payload, content_sha256: hashCanonical(payload) };
}

function rehashPortfolio(portfolio: TopicPortfolio): TopicPortfolio {
  const { content_sha256: _contentHash, ...payload } = portfolio;
  return { ...payload, content_sha256: hashCanonical(payload) };
}

function rehashDecision(decision: TopicDecision): TopicDecision {
  const { content_sha256: _contentHash, ...payload } = decision;
  return { ...payload, content_sha256: hashCanonical(payload) };
}

function serializeJsonl(items: unknown[]): string {
  return items.length > 0 ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
}

function parseJsonl(raw: string): Array<Record<string, unknown>> {
  return raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function passingPriorAbsorptionMatrix(
  candidates: HypothesisCandidate[],
  evidenceRows: PriorAbsorptionEvidenceSeed[]
) {
  const independentEvidenceIds = evidenceRows.map((item) => item.evidence_id || "");
  const assessments: PriorAbsorptionAssessment[] = candidates.flatMap((item) =>
    evidenceRows.map((prior) => ({
      candidate_id: item.id,
      prior_paper_id: prior.paper_id || "",
      disposition: "non_overlapping" as const,
      axes: PRIOR_ABSORPTION_AXES.map((axis) => ({
        axis,
        relation: "distinct" as const,
        evidence_ids: [prior.evidence_id || ""]
      })),
      independent_evidence_ids: independentEvidenceIds
    }))
  );
  return buildPriorAbsorptionMatrix({
    candidates,
    evidence: evidenceRows,
    assessments,
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    generatedAt: GENERATED_AT,
    assessmentSource: "llm_structured_comparison"
  });
}

function evidence(): PriorAbsorptionEvidenceSeed[] {
  return [
    {
      evidence_id: "ev_methods",
      paper_id: "prior_methods",
      claim: "The method reports a measured comparison.",
      method_slot: "The prior evaluates a declared mechanism.",
      result_slot: "The prior reports a matched result.",
      limitation_slot: "The evaluation covers only one data partition.",
      dataset_slot: "evaluation_fixture",
      metric_slot: "primary_score",
      evidence_span: "Exact full-text evidence for the method prior.",
      source_type: "full_text",
      confidence: 0.9
    },
    {
      evidence_id: "ev_audit",
      paper_id: "prior_audit",
      claim: "The audit reports a bounded failure analysis.",
      method_slot: "The prior evaluates a declared audit mechanism.",
      result_slot: "The prior reports a bounded audit result.",
      limitation_slot: "The evaluation covers only one data partition.",
      dataset_slot: "evaluation_fixture",
      metric_slot: "primary_score",
      evidence_span: "Exact full-text evidence for the audit prior.",
      source_type: "full_text",
      confidence: 0.9
    }
  ];
}

function candidate(id: string, index: number): HypothesisCandidate {
  return {
    id,
    text: `The ${id} intervention changes the primary outcome relative to the declared comparator.`,
    novelty: 4,
    feasibility: 4,
    testability: 5,
    cost: 2,
    expected_gain: 3,
    evidence_links: ["ev_methods", "ev_audit"],
    axis_ids: [`axis_${(index % 3) + 1}`],
    gap_statement: "Existing evaluations cover only one data partition.",
    closest_prior_non_overlap: "The intervention measures a boundary absent from the linked priors.",
    reviewer_absorption_objection: "A reviewer may argue that the strongest comparator absorbs the intervention.",
    comparator: "Matched-budget comparator",
    dataset_task_bench: "evaluation_fixture",
    primary_metric: "primary_score",
    metric_unit: "unitless",
    metric_scale: "raw",
    metric_direction: "maximize",
    effect_criterion: {
      basis: "delta_vs_reference",
      magnitude: 0.05,
      scale: "raw",
      inclusive: true
    },
    meaningful_effect: "At least 0.05 over the declared comparator.",
    measurement_signals: ["primary_score", "uncertainty_interval"],
    measurement_hint: "Compare the primary score with uncertainty across repeated matched runs.",
    falsifier: "The paired interval includes the preregistered null margin.",
    local_budget: makeTopicProbeComputeBudgetDeclaration(),
    kill_signal: "Stop if the intervention cannot be distinguished from the comparator.",
    contribution_claim: `The ${id} comparison identifies a prespecified boundary absent from the closest prior work.`,
    minimum_publishable_evidence: "Repeated comparisons with uncertainty intervals and failure analysis."
  };
}

function review(candidateId: string): HypothesisReview {
  return {
    candidate_id: candidateId,
    keep: true,
    groundedness: 4,
    causal_clarity: 4,
    falsifiability: 4,
    experimentability: 4,
    measurement_specificity: 4,
    measurement_signals: ["paired_campaigns"],
    measurement_hint: "Compare the primary score with uncertainty across repeated matched runs.",
    limitation_reflection: 4,
    measurement_readiness: 4,
    strengths: ["The comparison and falsifier are explicit."],
    weaknesses: ["The claim is limited to controlled campaigns."]
  };
}
