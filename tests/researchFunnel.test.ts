import { describe, expect, it } from "vitest";

import {
  buildTopicDecision,
  bindResearchGapMapArtifact,
  buildResearchGapMap as buildResearchGapMapBase,
  buildResearchFunnelArtifactBinding,
  buildTopicPortfolio,
  hashCanonical,
  resolveSupportedGapIds,
  validateTopicPortfolioArtifact,
  validateResearchGapMapArtifact,
  validateTopicDecisionArtifact,
  RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS,
  type TopicPortfolio
} from "../src/core/researchFunnel.js";
import type {
  HypothesisCandidate,
  HypothesisReview
} from "../src/core/analysis/researchPlanning.js";
import { RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION } from "../src/core/analysis/researchGapSynthesis.js";
import {
  PRIOR_ABSORPTION_AXES,
  buildPriorAbsorptionCandidateContract,
  buildPriorAbsorptionMatrix,
  parsePriorAbsorptionAxisVerificationResponse,
  type PriorAbsorptionAssessment,
  type PriorAbsorptionEvidenceSeed
} from "../src/core/priorAbsorption.js";
import type { CandidatePriorSearchReviewBinding } from "../src/core/candidatePriorSearch.js";
import {
  makeTopicProbeComputeBudgetDeclaration,
  makeTopicProbeComputeBudgetLimits
} from "./support/topicProbeComputeBudget.js";
import { makeIndependentHypothesisReviewProvenance } from "./support/hypothesisReviewProvenance.js";

const GENERATED_AT = "2026-01-01T00:00:00.000Z";
const RUN_ID = "run_funnel_fixture";
const RESEARCH_CYCLE = 2;
const GAP_MAP_BINDING = {
  collectAttemptId: "20260102030405678-genericattempt",
  corpusSha256: "a".repeat(64),
  corpusByteLength: 128,
  evidenceSha256: "b".repeat(64),
  evidenceByteLength: 256
};

function buildResearchGapMap(
  input: Parameters<typeof buildResearchGapMapBase>[0]
): ReturnType<typeof buildResearchGapMapBase> {
  return buildResearchGapMapBase({ ...input, ...GAP_MAP_BINDING });
}

describe("research funnel", () => {
  it("does not silently rebind an unbound gap map", () => {
    const gapMap = buildResearchGapMapBase({
      evidence: [
        evidence("ev_unbound", "paper_unbound", "A configured limitation remains.", "full_text")
      ],
      generatedAt: GENERATED_AT
    });
    const raw = JSON.stringify(gapMap, null, 2);
    const binding = bindResearchGapMapArtifact(raw, {
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      collectAttemptId: GAP_MAP_BINDING.collectAttemptId,
      corpusSha256: GAP_MAP_BINDING.corpusSha256,
      corpusByteLength: GAP_MAP_BINDING.corpusByteLength,
      evidenceSha256: GAP_MAP_BINDING.evidenceSha256,
      evidenceByteLength: GAP_MAP_BINDING.evidenceByteLength
    });

    expect(binding.changed).toBe(false);
    expect(binding.raw).toBe(raw);
    expect(binding.validation).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "research_gap_map_run_id_unbound",
        "research_gap_map_research_cycle_unbound",
        "research_gap_map_collect_attempt_unbound",
        "research_gap_map_corpus_unbound",
        "research_gap_map_evidence_unbound"
      ])
    });
  });

  it("keeps unsupported limitations provisional instead of declaring a research gap", () => {
    const gapMap = buildResearchGapMap({
      evidence: [
        evidence("ev_a", "paper_a", "Only one task family was evaluated.", "full_text"),
        evidence("ev_b", "paper_b", "Only one task family was evaluated.", "full_text"),
        evidence("ev_c", "paper_c", "No repeated evaluation was reported.", "full_text"),
        evidence("ev_d", "paper_d", "No repeated evaluation was reported.", "abstract")
      ],
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });

    expect(gapMap.gaps).toHaveLength(2);
    expect(gapMap.gaps.find((gap) => gap.statement.startsWith("Only one"))).toMatchObject({
      epistemic_status: "supported_candidate",
      support: {
        distinct_paper_count: 2,
        full_text_paper_count: 2
      }
    });
    expect(gapMap.gaps.find((gap) => gap.statement.startsWith("No repeated"))).toMatchObject({
      epistemic_status: "provisional_candidate",
      support: {
        distinct_paper_count: 2,
        full_text_paper_count: 1
      }
    });
    expect(gapMap.gates.find((gate) => gate.code === "independent_gap_support_present")?.status).toBe("pass");
    expect(gapMap.content_sha256).toMatch(/^[a-f0-9]{64}$/u);
    const validation = validateResearchGapMapArtifact(JSON.stringify(gapMap));
    const tampered = JSON.parse(JSON.stringify(gapMap)) as typeof gapMap;
    tampered.gaps[0]!.statement = "Tampered gap.";

    expect(validation.valid).toBe(true);
    expect(validateResearchGapMapArtifact(JSON.stringify(gapMap), {
      expectedRunId: RUN_ID,
      expectedResearchCycle: RESEARCH_CYCLE,
      expectedCollectAttemptId: GAP_MAP_BINDING.collectAttemptId,
      expectedCorpusSha256: "c".repeat(64),
      expectedCorpusByteLength: GAP_MAP_BINDING.corpusByteLength,
      expectedEvidenceSha256: GAP_MAP_BINDING.evidenceSha256,
      expectedEvidenceByteLength: GAP_MAP_BINDING.evidenceByteLength
    })).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining(["research_gap_map_corpus_hash_mismatch"])
    });
    expect(validateResearchGapMapArtifact(JSON.stringify(tampered))).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "research_gap_map_content_hash_mismatch",
        expect.stringMatching(/^research_gap_id_mismatch:/u)
      ])
    });
  });

  it("projects reviewed semantic clusters while excluding source-visibility evidence", () => {
    const gapMap = buildResearchGapMap({
      evidence: [
        evidence(
          "ev_semantic_a",
          "paper_semantic_a",
          "The release comparison changes the evaluated cohort and scoring procedure together.",
          "full_text"
        ),
        evidence(
          "ev_semantic_b",
          "paper_semantic_b",
          "Attribution is unresolved because evaluator revisions coincide with model-set turnover.",
          "full_text"
        ),
        evidence(
          "ev_visibility_a",
          "paper_visibility_a",
          "The supplied excerpt does not report the denominator.",
          "full_text"
        ),
        evidence(
          "ev_visibility_b",
          "paper_visibility_b",
          "The supplied excerpt does not report the denominator.",
          "full_text"
        )
      ],
      semanticClusters: [{
        statement: "Existing evaluations do not separate cohort changes from scoring-protocol changes.",
        evidence_ids: ["ev_semantic_a", "ev_semantic_b"],
        opportunity_type: "explicit_limitation"
      }],
      synthesisBinding: {
        content_sha256: "c".repeat(64),
        semantics_version: RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION,
        status: "completed"
      },
      analysisCoverage: {
        selected_paper_count: 2,
        completed_paper_count: 2,
        failed_paper_ids: [],
        complete: true
      },
      excludedEvidenceIds: ["ev_visibility_a", "ev_visibility_b"],
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });

    expect(gapMap.gaps).toHaveLength(1);
    expect(gapMap.gaps[0]).toMatchObject({
      statement: "Existing evaluations do not separate cohort changes from scoring-protocol changes.",
      evidence_links: ["ev_semantic_a", "ev_semantic_b"],
      epistemic_status: "supported_candidate",
      support: {
        distinct_paper_count: 2,
        full_text_paper_count: 2
      }
    });
    expect(gapMap.gaps[0]?.evidence_links).not.toContain("ev_visibility_a");
    expect(gapMap.gates.find((gate) => gate.code === "independent_gap_support_present")?.status).toBe("pass");
  });

  it("does not re-promote reviewer-rejected evidence through exact-string grouping", () => {
    const evidenceRows = [
      evidence("ev_rejected_a", "paper_rejected_a", "The same extracted limitation sentence.", "full_text"),
      evidence("ev_rejected_b", "paper_rejected_b", "The same extracted limitation sentence.", "full_text")
    ];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      semanticClusters: [],
      synthesisBinding: {
        content_sha256: "d".repeat(64),
        semantics_version: 2,
        status: "completed"
      },
      analysisCoverage: {
        selected_paper_count: 2,
        completed_paper_count: 2,
        failed_paper_ids: [],
        complete: true
      },
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });

    expect(gapMap.gaps).toHaveLength(1);
    expect(gapMap.gaps[0]).toMatchObject({
      construction_origin: "exact_grouping",
      epistemic_status: "provisional_candidate"
    });
    expect(gapMap.gates.find((gate) => gate.code === "independent_gap_support_present")?.status).toBe("block");
    expect(validateResearchGapMapArtifact(JSON.stringify(gapMap), {
      evidence: evidenceRows,
      reviewedClusters: [],
      requireReviewedSynthesis: true,
      synthesisArtifactValid: true,
      expectedSynthesisContentSha256: "d".repeat(64),
      expectedSynthesisSemanticsVersion: 2,
      expectedAnalysisComplete: true
    })).toMatchObject({ valid: true, reasons: [] });
  });

  it("preserves shared grounded evidence across independently reviewed opportunity types", () => {
    const limitation =
      "The evaluation omits random seeds and does not separate protocol changes from cohort changes.";
    const evidenceRows = [
      evidence("ev_shared_a", "paper_shared_a", limitation, "full_text"),
      evidence("ev_shared_b", "paper_shared_b", limitation, "full_text")
    ];
    const semanticClusters = [
      {
        statement: "Protocol and cohort changes remain empirically confounded across evaluations.",
        evidence_ids: ["ev_shared_a", "ev_shared_b"],
        opportunity_type: "explicit_limitation" as const
      },
      {
        statement: "Missing random-seed disclosure prevents independent reproduction across evaluations.",
        evidence_ids: ["ev_shared_a", "ev_shared_b"],
        opportunity_type: "reproducibility_gap" as const
      }
    ];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      semanticClusters,
      synthesisBinding: {
        content_sha256: "d".repeat(64),
        semantics_version: RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION,
        status: "completed"
      },
      analysisCoverage: {
        selected_paper_count: 2,
        completed_paper_count: 2,
        failed_paper_ids: [],
        complete: true
      },
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });

    expect(gapMap.gaps).toHaveLength(2);
    expect(gapMap.gaps.map((gap) => gap.opportunity_type).sort()).toEqual([
      "explicit_limitation",
      "reproducibility_gap"
    ]);
    expect(validateResearchGapMapArtifact(JSON.stringify(gapMap), {
      evidence: evidenceRows,
      reviewedClusters: semanticClusters,
      requireReviewedSynthesis: true,
      synthesisArtifactValid: true,
      expectedSynthesisContentSha256: "d".repeat(64),
      expectedSynthesisSemanticsVersion: RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION,
      expectedAnalysisComplete: true
    })).toMatchObject({ valid: true, reasons: [] });
  });

  it("rejects a rehashed gap map whose identifiers do not exist in external evidence", () => {
    const evidenceRows = [
      evidence("ev_grounded_a", "paper_grounded_a", "A shared scientific limitation.", "full_text"),
      evidence("ev_grounded_b", "paper_grounded_b", "A shared scientific limitation.", "full_text")
    ];
    const statement = "A shared scientific limitation remains unresolved across the compared evaluations.";
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      semanticClusters: [{
        statement,
        evidence_ids: ["ev_grounded_a", "ev_grounded_b"],
        opportunity_type: "explicit_limitation"
      }],
      synthesisBinding: {
        content_sha256: "e".repeat(64),
        semantics_version: RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION,
        status: "completed"
      },
      analysisCoverage: {
        selected_paper_count: 2,
        completed_paper_count: 2,
        failed_paper_ids: [],
        complete: true
      },
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });
    const ghost = structuredClone(gapMap);
    ghost.gaps[0]!.evidence_links = ["ghost_evidence_a", "ghost_evidence_b"];
    ghost.gaps[0]!.paper_ids = ["ghost_paper_a", "ghost_paper_b"];
    ghost.gaps[0]!.gap_id = `gap_${hashCanonical({
      statement: ghost.gaps[0]!.statement,
      evidence_links: ghost.gaps[0]!.evidence_links,
      opportunity_type: ghost.gaps[0]!.opportunity_type ?? null
    }).slice(0, 12)}`;
    const { content_sha256: _oldHash, ...ghostPayload } = ghost;
    ghost.content_sha256 = hashCanonical(ghostPayload);

    expect(validateResearchGapMapArtifact(JSON.stringify(ghost), {
      evidence: evidenceRows,
      reviewedClusters: [{
        statement,
        evidence_ids: ["ev_grounded_a", "ev_grounded_b"],
        opportunity_type: "explicit_limitation"
      }],
      requireReviewedSynthesis: true,
      synthesisArtifactValid: true,
      expectedSynthesisContentSha256: "e".repeat(64),
      expectedSynthesisSemanticsVersion: RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION,
      expectedAnalysisComplete: true
    })).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "research_gap_unknown_evidence:" + ghost.gaps[0]!.gap_id + ":ghost_evidence_a"
      ])
    });
  });

  it("ignores semantic clusters without two independent full-text papers", () => {
    const gapMap = buildResearchGapMap({
      evidence: [
        evidence(
          "ev_partial_a",
          "paper_partial_a",
          "The comparison changes the cohort and scoring procedure together.",
          "full_text"
        ),
        evidence(
          "ev_partial_b",
          "paper_partial_b",
          "Evaluator revisions coincide with model-set turnover.",
          "abstract"
        )
      ],
      semanticClusters: [{
        statement: "Existing evaluations do not separate cohort changes from scoring-protocol changes.",
        evidence_ids: ["ev_partial_a", "ev_partial_b"]
      }],
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });

    expect(gapMap.gaps).toHaveLength(2);
    expect(gapMap.gaps.every((gap) => gap.epistemic_status === "provisional_candidate")).toBe(true);
    expect(gapMap.gates.find((gate) => gate.code === "independent_gap_support_present")?.status).toBe("block");
  });

  it("allows bounded probe authorization only for a reviewed 5-7 candidate portfolio with complete contracts", () => {
    const evidenceRows = [
      evidence("ev_a", "paper_a", "The evaluation omits a held-out task family.", "full_text"),
      evidence("ev_b", "paper_b", "The evaluation omits a held-out task family.", "full_text")
    ];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });
    const candidates = Array.from({ length: 5 }, (_, index) =>
      candidate(`candidate_${index + 1}`, ["ev_a", "ev_b"], [`axis_${(index % 3) + 1}`])
    );
    delete candidates[0]!.meaningful_effect;
    const reviews = candidates.map((item) => review(item.id, true));
    const portfolio = buildTopicPortfolio({
      candidates,
      evidenceAxes: evidenceAxesFor(candidates),
      reviews,
      probeCandidateIds: [candidates[0]!.id],
      evidence: evidenceRows,
      gapMap,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      priorAbsorptionMatrix: passingPriorAbsorptionMatrix(candidates, evidenceRows),
      sourceArtifactBindings: sourceArtifactBindings()
    });

    expect(portfolio.candidate_policy.observed).toBe(5);
    expect(portfolio.candidates).toHaveLength(5);
    expect(portfolio.cluster_policy.observed_distinct_nonempty).toBe(3);
    expect(portfolio.probe_candidate_ids).toHaveLength(1);
    expect(
      portfolio.candidates.flatMap((candidate) =>
        candidate.gates
          .filter((gate) => gate.status === "block")
          .map((gate) => `${candidate.source_candidate_id}:${gate.code}`)
      )
    ).toEqual([]);
    expect(portfolio.probe_allowed).toBe(true);
    expect(portfolio.gates.every((gate) => gate.status === "pass")).toBe(true);
    const validation = validateTopicPortfolioArtifact(JSON.stringify(portfolio));
    const decision = buildTopicDecision({
      runId: "run_a",
      researchCycle: RESEARCH_CYCLE,
      validation,
      generatedAt: GENERATED_AT
    });
    const decisionValidation = validateTopicDecisionArtifact(JSON.stringify(decision), validation, {
      expectedRunId: "run_a",
      expectedResearchCycle: RESEARCH_CYCLE
    });

    expect(validation.valid).toBe(true);
    expect(decisionValidation.valid).toBe(true);
    expect(decision.disposition).toBe("probe_authorized");
    expect(decision.probe_candidate_ids).toEqual(portfolio.probe_candidate_ids);
    expect(decision.content_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(portfolio.candidates.every((item) => item.probe_eligible)).toBe(true);
    expect(portfolio.candidates[0]?.meaningful_effect).toBeUndefined();
    expect(JSON.parse(portfolio.candidates[0]?.objective_raw || "null")).toEqual({
      primary_metric: "primary_score",
      metric_unit: "unitless",
      metric_scale: "raw",
      metric_direction: "maximize",
      comparator: "Matched-budget baseline",
      effect_criterion: {
        basis: "delta_vs_reference",
        magnitude: 0.05,
        scale: "raw",
        inclusive: true
      }
    });
  });

  it("requires every selected direct prior in closest-prior and absorption coverage", () => {
    const evidenceRows = [
      evidence("ev_primary", "paper_primary", "A declared comparison remains incomplete.", "full_text"),
      evidence("ev_secondary", "paper_secondary", "A declared comparison remains incomplete.", "full_text")
    ];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });
    const candidates = Array.from({ length: 5 }, (_, index) =>
      candidate(
        `candidate_${index + 1}`,
        ["ev_primary", "ev_secondary"],
        [`axis_${(index % 3) + 1}`]
      )
    );
    const sharedInput = {
      candidates,
      evidenceAxes: evidenceAxesFor(candidates),
      reviews: candidates.map((item) => review(item.id, true)),
      probeCandidateIds: [candidates[0].id],
      evidence: evidenceRows,
      gapMap,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      priorAbsorptionMatrix: passingPriorAbsorptionMatrix(candidates, evidenceRows),
      sourceArtifactBindings: sourceArtifactBindings()
    };

    const omitted = buildTopicPortfolio({
      ...sharedInput,
      candidatePriorSearchBindingsByCandidateId: new Map([
        [
          candidates[0].id,
          candidatePriorSearchReviewBinding(candidates[0], ["paper_omitted"])
        ]
      ])
    });
    expect(
      omitted.candidates[0].gates.find(
        (gate) =>
          gate.code === "candidate_prior_search_selected_prior_coverage_complete"
      )?.status
    ).toBe("block");
    expect(omitted.candidates[0].probe_eligible).toBe(false);
    expect(omitted.probe_allowed).toBe(false);
    expect(validateTopicPortfolioArtifact(JSON.stringify(omitted))).toMatchObject({
      valid: true,
      reasons: []
    });

    const complete = buildTopicPortfolio({
      ...sharedInput,
      candidatePriorSearchBindingsByCandidateId: new Map([
        [
          candidates[0].id,
          candidatePriorSearchReviewBinding(candidates[0], ["paper_secondary"])
        ]
      ])
    });
    expect(complete.candidates[0].candidate_prior_search).toMatchObject({
      selected_direct_prior_ids: ["paper_secondary"]
    });
    expect(
      complete.candidates[0].gates.filter((gate) =>
        gate.code.startsWith("candidate_prior_search_")
      ).map((gate) => gate.status)
    ).toEqual(["pass", "pass"]);
    expect(complete.candidates[0].probe_eligible).toBe(true);
    expect(complete.probe_allowed).toBe(true);
    expect(validateTopicPortfolioArtifact(JSON.stringify(complete))).toMatchObject({
      valid: true,
      reasons: []
    });
  });

  it("preserves an explicitly rejected non-shortlisted candidate without blocking an eligible shortlist", () => {
    const evidenceRows = [
      evidence("ev_a", "paper_a", "The evaluation omits a held-out task family.", "full_text"),
      evidence("ev_b", "paper_b", "The evaluation omits a held-out task family.", "full_text")
    ];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });
    const candidates = Array.from({ length: 5 }, (_, index) =>
      candidate(`candidate_${index + 1}`, ["ev_a", "ev_b"], [`axis_${(index % 3) + 1}`])
    );
    const reviews = candidates.map((item, index) => review(item.id, index !== 1));
    const portfolio = buildTopicPortfolio({
      candidates,
      evidenceAxes: evidenceAxesFor(candidates),
      reviews,
      probeCandidateIds: [candidates[0]!.id],
      evidence: evidenceRows,
      gapMap,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      priorAbsorptionMatrix: passingPriorAbsorptionMatrix(candidates, evidenceRows),
      sourceArtifactBindings: sourceArtifactBindings()
    });

    expect(portfolio.candidates[1]).toMatchObject({
      review_status: "rejected",
      probe_status: "not_shortlisted",
      probe_eligible: false
    });
    expect(
      portfolio.gates.find((gate) => gate.code === "portfolio_candidates_admissible")?.status
    ).toBe("pass");
    expect(portfolio.probe_candidate_ids).toEqual([candidates[0]!.id]);
    expect(portfolio.probe_allowed).toBe(true);
  });

  it("requires a candidate to bind every evidence row in a supported gap", () => {
    const evidenceRows = [
      evidence("ev_complete_a", "paper_complete_a", "The comparison omits a held-out context.", "full_text"),
      evidence("ev_complete_b", "paper_complete_b", "The comparison omits a held-out context.", "full_text")
    ];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });
    const partialCandidate = candidate(
      "candidate_partial",
      ["ev_complete_a"],
      ["axis_partial"]
    );
    const portfolio = buildTopicPortfolio({
      candidates: [partialCandidate],
      evidenceAxes: evidenceAxesFor([partialCandidate]),
      reviews: [review(partialCandidate.id, true)],
      probeCandidateIds: [partialCandidate.id],
      evidence: evidenceRows,
      gapMap,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      sourceArtifactBindings: sourceArtifactBindings()
    });

    expect(resolveSupportedGapIds(partialCandidate.evidence_links, gapMap)).toEqual([]);
    expect(portfolio.candidates[0]?.supported_gap_ids).toEqual([]);
    expect(
      portfolio.candidates[0]?.gates.find(
        (gate) => gate.code === "supported_gap_reference_present"
      )?.status
    ).toBe("block");
    expect(portfolio.candidates[0]?.probe_eligible).toBe(false);
    expect(portfolio.probe_allowed).toBe(false);
  });

  it.each([
    ["metric_unit", "metric_unit_present"],
    ["metric_scale", "metric_scale_valid"],
    ["metric_direction", "metric_direction_present"],
    ["effect_criterion", "effect_criterion_valid"]
  ] as const)("blocks probe authorization when %s is missing", (field, gateCode) => {
    const evidenceRows = [
      evidence("ev_a", "paper_a", "The evaluation omits a held-out task family.", "full_text"),
      evidence("ev_b", "paper_b", "The evaluation omits a held-out task family.", "full_text")
    ];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });
    const candidates = Array.from({ length: 5 }, (_, index) =>
      candidate(`candidate_${index + 1}`, ["ev_a", "ev_b"], [`axis_${(index % 3) + 1}`])
    );
    delete candidates[0]![field];

    const portfolio = buildTopicPortfolio({
      candidates,
      evidenceAxes: evidenceAxesFor(candidates),
      reviews: candidates.map((item) => review(item.id, true)),
      probeCandidateIds: [candidates[0]!.id],
      evidence: evidenceRows,
      gapMap,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      sourceArtifactBindings: sourceArtifactBindings()
    });
    const probeCandidate = portfolio.candidates.find(
      (item) => item.source_candidate_id === candidates[0]!.id
    );

    expect(probeCandidate?.gates.find((gate) => gate.code === gateCode)?.status).toBe("block");
    expect(probeCandidate?.probe_eligible).toBe(false);
    expect(portfolio.probe_allowed).toBe(false);
  });


  it.each([
    ["nonnumeric magnitude", { basis: "delta_vs_reference", magnitude: "0.05", scale: "raw", inclusive: true }],
    ["NaN magnitude", { basis: "delta_vs_reference", magnitude: Number.NaN, scale: "raw", inclusive: true }],
    ["negative magnitude", { basis: "delta_vs_reference", magnitude: -0.01, scale: "raw", inclusive: true }],
    ["missing magnitude", { basis: "delta_vs_reference", scale: "raw", inclusive: true }],
    ["unsupported basis", { basis: "absolute_target", magnitude: 0.05, scale: "raw", inclusive: true }],
    ["unsupported scale", { basis: "delta_vs_reference", magnitude: 0.05, scale: "ratio", inclusive: true }]
  ])("blocks probe authorization for %s", (_label, invalidCriterion) => {
    const evidenceRows = [
      evidence("ev_a", "paper_a", "The evaluation omits a held-out task family.", "full_text"),
      evidence("ev_b", "paper_b", "The evaluation omits a held-out task family.", "full_text")
    ];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });
    const candidates = Array.from({ length: 5 }, (_, index) =>
      candidate(`candidate_${index + 1}`, ["ev_a", "ev_b"], [`axis_${(index % 3) + 1}`])
    );
    Object.assign(candidates[0]!, { effect_criterion: invalidCriterion });

    const portfolio = buildTopicPortfolio({
      candidates,
      evidenceAxes: evidenceAxesFor(candidates),
      reviews: candidates.map((item) => review(item.id, true)),
      probeCandidateIds: [candidates[0]!.id],
      evidence: evidenceRows,
      gapMap,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      sourceArtifactBindings: sourceArtifactBindings()
    });
    const probeCandidate = portfolio.candidates.find(
      (item) => item.source_candidate_id === candidates[0]!.id
    );

    expect(probeCandidate?.gates.find((gate) => gate.code === "effect_criterion_valid")?.status).toBe("block");
    expect(probeCandidate?.objective_raw).toBeUndefined();
    expect(probeCandidate?.probe_eligible).toBe(false);
    expect(portfolio.probe_allowed).toBe(false);
  });

  it("derives cluster breadth only from candidate axis identifiers", () => {
    const evidenceRows = [
      evidence("ev_a", "paper_a", "The evaluation omits a held-out task family.", "full_text"),
      evidence("ev_b", "paper_b", "The evaluation omits a held-out task family.", "full_text")
    ];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });
    const candidates = Array.from({ length: 5 }, (_, index) => {
      const item = candidate(`candidate_${index + 1}`, ["ev_a", "ev_b"], ["axis_shared"]);
      item.text = `Cluster ${index + 1} label and score suggest a distinct route, but the evidence axis is shared.`;
      item.score = index + 1;
      return item;
    });
    const portfolio = buildTopicPortfolio({
      candidates,
      evidenceAxes: evidenceAxesFor(candidates),
      reviews: candidates.map((item) => review(item.id, true)),
      probeCandidateIds: [candidates[0]!.id],
      evidence: evidenceRows,
      gapMap,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      sourceArtifactBindings: sourceArtifactBindings()
    });

    expect(portfolio.candidates.every((item) => item.cluster_ids.join(",") === "axis_shared")).toBe(true);
    expect(portfolio.cluster_policy.observed_distinct_nonempty).toBe(1);
    expect(portfolio.gates.find((gate) => gate.code === "evidence_axis_cluster_diversity")?.status).toBe("block");
    expect(portfolio.probe_allowed).toBe(false);
    expect(validateTopicPortfolioArtifact(JSON.stringify(portfolio)).valid).toBe(true);
  });

  it("blocks a shortlisted topic when its surviving contribution or publishable evidence contract is missing", () => {
    const evidenceRows = [
      evidence("ev_a", "paper_a", "The comparison covers only one evaluation context.", "full_text"),
      evidence("ev_b", "paper_b", "The reported evidence omits repeated measurements.", "full_text")
    ];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });
    const candidates = Array.from({ length: 5 }, (_, index) =>
      candidate(`candidate_${index + 1}`, ["ev_a", "ev_b"], [`axis_${(index % 3) + 1}`])
    );
    delete candidates[0]!.contribution_claim;
    delete candidates[0]!.minimum_publishable_evidence;
    const portfolio = buildTopicPortfolio({
      candidates,
      evidenceAxes: evidenceAxesFor(candidates),
      reviews: candidates.map((item) => review(item.id, true)),
      probeCandidateIds: [candidates[0]!.id],
      evidence: evidenceRows,
      gapMap,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      sourceArtifactBindings: sourceArtifactBindings()
    });

    expect(
      portfolio.candidates[0]!.gates.find(
        (gate) => gate.code === "contribution_claim_present"
      )?.status
    ).toBe("block");
    expect(
      portfolio.candidates[0]!.gates.find(
        (gate) => gate.code === "minimum_publishable_evidence_present"
      )?.status
    ).toBe("block");
    expect(portfolio.candidates[0]!.probe_eligible).toBe(false);
    expect(portfolio.probe_allowed).toBe(false);
  });
  it("blocks unknown contracts and preserves rejected and overflow candidates", () => {
    const evidenceRows = [evidence("ev_a", "paper_a", "The study reports one setting.", "full_text")];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });
    const candidates = Array.from({ length: 8 }, (_, index) =>
      candidate(`candidate_${index + 1}`, ["ev_a"], [`axis_${(index % 3) + 1}`])
    );
    delete candidates[0]!.comparator;
    const reviews = candidates.map((item, index) => review(item.id, index !== 1));
    const portfolio: TopicPortfolio = buildTopicPortfolio({
      candidates,
      evidenceAxes: evidenceAxesFor(candidates),
      reviews,
      probeCandidateIds: [candidates[0]!.id],
      evidence: evidenceRows,
      gapMap,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      sourceArtifactBindings: sourceArtifactBindings()
    });

    expect(portfolio.probe_allowed).toBe(false);
    expect(portfolio.candidate_policy.observed).toBe(8);
    expect(portfolio.candidates).toHaveLength(7);
    expect(portfolio.overflow_candidates).toEqual([
      {
        source_candidate_id: "candidate_8",
        reason: "portfolio_maximum_exceeded"
      }
    ]);
    expect(portfolio.candidates[0]!.gates.find((gate) => gate.code === "comparator_present")?.status).toBe("block");
    expect(portfolio.candidates[0]!.gates.find((gate) => gate.code === "closest_prior_independent_support")?.status).toBe("block");
    expect(portfolio.candidates[0]!.gates.find((gate) => gate.code === "closest_prior_full_text_support")?.status).toBe("block");
    expect(portfolio.candidates[1]!.review_status).toBe("rejected");

    const tampered = JSON.parse(JSON.stringify(portfolio)) as TopicPortfolio;
    tampered.candidates[0]!.statement = "Tampered statement.";
    const validation = validateTopicPortfolioArtifact(JSON.stringify(tampered));
    const decision = buildTopicDecision({
      runId: "run_b",
      researchCycle: RESEARCH_CYCLE,
      validation,
      generatedAt: GENERATED_AT
    });

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain("topic_portfolio_content_hash_mismatch");
    expect(decision.reason_codes).toContain("prior_absorption_matrix_bound");
    expect(decision.reason_codes).toContain("prior_absorption_disposition_eligible");
    expect(decision.disposition).toBe("backtrack_to_hypotheses");
    expect(decision.reason_codes).toContain("topic_portfolio_content_hash_mismatch");
  });

  it("blocks a portfolio when a non-shortlisted candidate is contract-incomplete filler", () => {
    const evidenceRows = [
      evidence("ev_a", "paper_a", "The evaluation omits a held-out context.", "full_text"),
      evidence("ev_b", "paper_b", "The evaluation omits a held-out context.", "full_text")
    ];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });
    const candidates = Array.from({ length: 5 }, (_, index) =>
      candidate(`candidate_${index + 1}`, ["ev_a", "ev_b"], [`axis_${(index % 3) + 1}`])
    );
    candidates[4]!.local_budget = "A bounded local execution budget.";
    const portfolio = buildTopicPortfolio({
      candidates,
      evidenceAxes: evidenceAxesFor(candidates),
      reviews: candidates.map((item) => review(item.id, true)),
      probeCandidateIds: [candidates[0]!.id],
      evidence: evidenceRows,
      gapMap,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      priorAbsorptionMatrix: passingPriorAbsorptionMatrix(candidates, evidenceRows),
      sourceArtifactBindings: sourceArtifactBindings()
    });

    expect(portfolio.candidates[0]!.probe_eligible).toBe(true);
    expect(
      portfolio.candidates[4]!.gates.find((gate) => gate.code === "compute_budget_declaration_valid")?.status
    ).toBe("block");
    expect(
      portfolio.gates.find((gate) => gate.code === "portfolio_candidates_admissible")?.status
    ).toBe("block");
    expect(portfolio.probe_allowed).toBe(false);
  });

  it("blocks a candidate whose valid two-stage budget exceeds the brief ceiling", () => {
    const evidenceRows = [
      evidence("ev_a", "paper_a", "A held-out context is omitted.", "full_text"),
      evidence("ev_b", "paper_b", "A held-out context is omitted.", "full_text")
    ];
    const gapMap = buildResearchGapMap({
      evidence: evidenceRows,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT
    });
    const candidates = Array.from({ length: 5 }, (_, index) =>
      candidate(`candidate_${index + 1}`, ["ev_a", "ev_b"], [`axis_${(index % 3) + 1}`])
    );
    const ceiling = makeTopicProbeComputeBudgetLimits();
    candidates[0]!.local_budget = JSON.stringify({
      ...ceiling,
      bounded_probe: {
        ...ceiling.bounded_probe,
        max_trials: ceiling.bounded_probe.max_trials + 1
      }
    });

    const portfolio = buildTopicPortfolio({
      candidates,
      evidenceAxes: evidenceAxesFor(candidates),
      reviews: candidates.map((item) => review(item.id, true)),
      probeCandidateIds: [candidates[0]!.id],
      evidence: evidenceRows,
      gapMap,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      priorAbsorptionMatrix: passingPriorAbsorptionMatrix(candidates, evidenceRows),
      sourceArtifactBindings: sourceArtifactBindings(),
      computeBudgetCeiling: ceiling
    });

    expect(
      portfolio.candidates[0]!.gates.find(
        (gate) => gate.code === "compute_budget_declaration_valid"
      )?.status
    ).toBe("pass");
    expect(
      portfolio.candidates[0]!.gates.find(
        (gate) => gate.code === "compute_budget_within_brief_ceiling"
      )?.status
    ).toBe("block");
    expect(portfolio.candidates[0]!.probe_eligible).toBe(false);
    expect(validateTopicPortfolioArtifact(JSON.stringify(portfolio)).valid).toBe(true);
  });
});

function sourceArtifactBindings() {
  return RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS.map((artifactPath) =>
    buildResearchFunnelArtifactBinding(artifactPath, `${artifactPath}\n`)
  );
}

function candidatePriorSearchReviewBinding(
  sourceCandidate: HypothesisCandidate,
  selectedDirectPriorIds: string[]
): CandidatePriorSearchReviewBinding {
  const payload: Omit<CandidatePriorSearchReviewBinding, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "candidate_prior_search_review_binding",
    candidate_id: sourceCandidate.id,
    candidate_content_sha256: hashCanonical(sourceCandidate),
    prior_absorption_contract_sha256:
      buildPriorAbsorptionCandidateContract(sourceCandidate).content_sha256,
    plan_content_sha256: "a".repeat(64),
    receipt_content_sha256: "b".repeat(64),
    candidate_receipt_content_sha256: "c".repeat(64),
    selected_direct_prior_ids: [...selectedDirectPriorIds].sort()
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function evidenceAxesFor(candidates: HypothesisCandidate[]) {
  const evidenceByAxis = new Map<string, string[]>();
  for (const item of candidates) {
    for (const axisId of item.axis_ids || []) {
      evidenceByAxis.set(
        axisId,
        [...new Set([
          ...(evidenceByAxis.get(axisId) || []),
          ...item.evidence_links
        ])]
      );
    }
  }
  return [...evidenceByAxis.entries()].map(([axisId, evidenceLinks]) => ({
    id: axisId,
    label: axisId,
    mechanism: `Mechanism for ${axisId}.`,
    intervention: `Intervention for ${axisId}.`,
    evidence_links: evidenceLinks
  }));
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
  const input = {
    candidates,
    evidence: evidenceRows,
    assessments,
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    generatedAt: GENERATED_AT,
    assessmentSource: "llm_structured_comparison"
  } as const;
  const provisional = buildPriorAbsorptionMatrix(input);
  const axisVerifications = parsePriorAbsorptionAxisVerificationResponse(
    JSON.stringify({
      verifications: provisional.candidates.flatMap((candidateRow) =>
        candidateRow.comparisons.flatMap((comparison) =>
          comparison.axes.map((axis) => ({
            candidate_id: candidateRow.candidate_id,
            prior_paper_id: comparison.prior_paper_id,
            axis: axis.axis,
            reported_relation: axis.relation,
            verification_input_sha256: axis.verification_input_sha256,
            verdict: "supported",
            rationale: `The fixture independently verifies ${axis.axis}.`
          }))
        )
      )
    }),
    {
      verifier_id: "fixture_axis_verifier",
      provider: "fixture_provider",
      model: "fixture_review_model",
      verification_run_id: "fixture_verification_run",
      context_isolated: true
    }
  );
  return buildPriorAbsorptionMatrix({
    ...input,
    axisVerifications
  });
}

function evidence(
  evidenceId: string,
  paperId: string,
  limitation: string,
  sourceType: "full_text" | "abstract"
): PriorAbsorptionEvidenceSeed {
  return {
    evidence_id: evidenceId,
    paper_id: paperId,
    canonical_work_id: `work_${paperId}`,
    claim: "A measured result was reported.",
    method_slot: "A declared mechanism was evaluated.",
    result_slot: "A matched comparison result was reported.",
    limitation_slot: limitation,
    limitation_kind: "scientific",
    dataset_slot: "dataset_a",
    metric_slot: "primary_score",
    evidence_span: limitation,
    source_type: sourceType,
    source_scope: sourceType === "full_text" ? "full_text_excerpt" : "abstract",
    grounding_status: "grounded_span",
    confidence: sourceType === "full_text" ? 0.9 : 0.6,
    confidence_reason: "The evidence span is grounded in the supplied source."
  };
}

function candidate(id: string, evidenceLinks: string[], axisIds: string[]): HypothesisCandidate {
  return {
    id,
    text: `Intervention ${id} improves the primary outcome relative to the comparator.`,
    novelty: 4,
    feasibility: 4,
    testability: 5,
    cost: 2,
    expected_gain: 3,
    evidence_links: evidenceLinks,
    axis_ids: axisIds,
    gap_statement: "Existing evaluations omit an independent held-out task family.",
    closest_prior_non_overlap: "The candidate tests an intervention absent from the linked prior work.",
    reviewer_absorption_objection: "A reviewer may consider the intervention equivalent to the strongest baseline.",
    comparator: "Matched-budget baseline",
    dataset_task_bench: "dataset_a",
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
    falsifier: "The confidence interval includes the prespecified null margin.",
    local_budget: makeTopicProbeComputeBudgetDeclaration(),
    kill_signal: "Stop if the first bounded probe cannot execute the comparator.",
    contribution_claim:
      `A preregistered comparison of ${id} identifies a measurable failure mode not evaluated by the closest prior work.`,
    minimum_publishable_evidence:
      "A confirmatory comparison with repeated runs, uncertainty intervals, and prespecified failure analysis."
  };
}

function review(candidateId: string, keep: boolean): HypothesisReview {
  return {
    candidate_id: candidateId,
    keep,
    groundedness: 4,
    causal_clarity: 4,
    falsifiability: 4,
    experimentability: 4,
    measurement_specificity: 3,
    measurement_signals: ["repeated_run_variance"],
    measurement_hint: "Compare the primary score with uncertainty across repeated matched runs.",
    limitation_reflection: 4,
    measurement_readiness: 4,
    strengths: ["The comparison is explicit."],
    weaknesses: keep ? ["The scope is narrow."] : ["The proposed intervention is absorbed by the comparator."],
    provenance: makeIndependentHypothesisReviewProvenance(candidateId)
  };
}
