import { describe, expect, it } from "vitest";

import {
  buildActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "../src/core/activeTopicProbeContract.js";
import { buildCandidateObjectiveRaw } from "../src/core/effectCriterion.js";
import {
  hashCanonical,
  type TopicPortfolioCandidate
} from "../src/core/researchFunnel.js";
import { validateResearchBriefMarkdown } from "../src/core/runs/researchBriefFiles.js";
import { parseMarkdownRunBriefSections } from "../src/core/runs/runBriefParser.js";
import {
  buildTopicProbeFollowupHandoff,
  resolveTopicProbeSuccessorRelation,
  validateTopicProbeFollowupHandoff,
  type TopicProbeFollowupHandoffInput
} from "../src/core/topicProbeFollowup.js";
import type {
  TopicProbeOutcomeDecision,
  TopicProbeOutcomeDisposition,
  TopicProbeOutcomeNextAction,
  TopicProbeOutcomeReasonCode
} from "../src/core/topicProbeOutcome.js";
import {
  makeTopicProbeComputeBudgetDeclaration,
  makeTopicProbeComputeBudgetLimits
} from "./support/topicProbeComputeBudget.js";
import {
  TOPIC_PROBE_FIXTURE_CANDIDATE_IDS,
  buildTopicProbePortfolioFixture
} from "./support/topicProbePortfolioFixture.js";

function makeCandidate(
  overrides: Partial<Omit<TopicPortfolioCandidate, "content_sha256">> = {}
): TopicPortfolioCandidate {
  const objectiveContract = {
    primary_metric: "primary_measure",
    metric_unit: "score_unit",
    metric_scale: "raw" as const,
    metric_direction: "maximize" as const,
    comparator: "declared_reference",
    effect_criterion: {
      basis: "delta_vs_reference" as const,
      magnitude: 0.04,
      scale: "raw" as const,
      inclusive: true
    }
  };
  const payload: Omit<TopicPortfolioCandidate, "content_sha256"> = {
    topic_id: "topic_controlled_comparison",
    source_candidate_id: "candidate_controlled_comparison",
    statement:
      "A declared intervention improves a primary measure under a matched evaluation protocol.",
    gap_statement:
      "Existing evidence does not isolate the intervention under the matched protocol.",
    cluster_ids: ["cluster_controlled_evaluation"],
    supported_gap_ids: ["gap_matched_protocol"],
    evidence_links: ["evidence_primary_source"],
    unresolved_evidence_links: [],
    closest_prior_paper_ids: ["prior_reference", "prior_adjacent"],
    closest_prior_full_text_paper_ids: ["prior_reference", "prior_adjacent"],
    closest_prior_non_overlap:
      "The closest prior does not report the declared matched intervention contrast.",
    reviewer_absorption_objection:
      "The candidate must show that the matched contrast is not absorbed by the closest prior.",
    ...objectiveContract,
    objective_raw: buildCandidateObjectiveRaw(objectiveContract),
    meaningful_effect:
      "At least 0.04 raw-score improvement over the declared reference.",
    dataset_task_bench: "declared_public_evaluation_scope",
    falsifier:
      "The matched estimate does not meet the structured practical-effect criterion.",
    local_budget: makeTopicProbeComputeBudgetDeclaration(),
    brief_compute_budget_ceiling: makeTopicProbeComputeBudgetLimits(),
    kill_signal:
      "Stop when matched evaluation units or the declared reference cannot be executed.",
    contribution_claim:
      "A controlled estimate of the declared intervention under a matched protocol.",
    minimum_publishable_evidence:
      "Independent repetitions, uncertainty estimates, a baseline comparison, and failure analysis.",
    review_status: "kept",
    probe_status: "shortlisted",
    review_summary: "Retained for one bounded real probe.",
    scores: {
      novelty: 4,
      feasibility: 5,
      testability: 5,
      cost: 4,
      expected_gain: 3
    },
    gates: [],
    probe_eligible: true,
    ...overrides
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function makeContract(
  candidate: TopicPortfolioCandidate,
  deferredCandidateIds: string[] = ["candidate_deferred"],
  portfolioContentSha256 = "a".repeat(64)
): ActiveTopicProbeContract {
  return buildActiveTopicProbeContract({
    runId: "run_topic_probe",
    researchCycle: 3,
    researchMode: "topic_discovery",
    portfolioContentSha256,
    candidate,
    deferredCandidateIds,
    generatedAt: "2026-01-01T00:00:00.000Z"
  });
}

function makeOutcome(
  contract: ActiveTopicProbeContract,
  disposition: TopicProbeOutcomeDisposition,
  nextAction: TopicProbeOutcomeNextAction
): TopicProbeOutcomeDecision {
  const reasonCodes: Record<
    TopicProbeOutcomeDisposition,
    TopicProbeOutcomeReasonCode[]
  > = {
    promote_to_confirmatory: ["confirmatory_gate_satisfied"],
    reject_candidate: ["effect_floor_not_met"],
    repeat_probe: ["fresh_trial_count_below_confirmatory_floor"],
    blocked_invalid_evidence: ["fresh_executed_trials_missing"]
  };
  const hasMeasuredEffect = disposition !== "blocked_invalid_evidence";
  const payload: Omit<TopicProbeOutcomeDecision, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "topic_probe_outcome_decision",
    run_id: contract.run_id,
    research_cycle: contract.research_cycle,
    candidate_id: contract.candidate_id,
    topic_id: contract.topic_id,
    contract_content_sha256: contract.content_sha256,
    primary_comparison_id: hasMeasuredEffect ? "comparison_primary" : null,
    primary_metric: contract.primary_metric,
    observed_delta: hasMeasuredEffect ? 0.04 : null,
    directed_delta: hasMeasuredEffect ? 0.04 : null,
    required_magnitude: contract.effect_criterion.magnitude,
    executed_trials: disposition === "blocked_invalid_evidence"
      ? 0
      : disposition === "repeat_probe"
        ? 1
        : 2,
    cached_trials: 0,
    primary_metric_ci_present:
      disposition === "promote_to_confirmatory"
      || disposition === "reject_candidate",
    primary_effect_ci_directed_bound: hasMeasuredEffect ? 0.04 : null,
    primary_effect_ci_criterion_met: disposition === "promote_to_confirmatory",
    disposition,
    reason_codes: reasonCodes[disposition],
    evidence_refs: [
      "active_topic_probe_contract.json#/content_sha256",
      "result_analysis.json#/primary_comparison_id"
    ],
    next_action: nextAction
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function makeFixture(
  disposition: TopicProbeOutcomeDisposition = "promote_to_confirmatory",
  nextAction: TopicProbeOutcomeNextAction = "start_confirmatory_run"
): TopicProbeFollowupHandoffInput {
  const deferredCandidateIds =
    nextAction === "refresh_topic_portfolio"
      ? []
      : [TOPIC_PROBE_FIXTURE_CANDIDATE_IDS[1]];
  const { portfolio } = buildTopicProbePortfolioFixture({
    runId: "run_topic_probe",
    researchCycle: 3,
    probeCandidateIds: [
      TOPIC_PROBE_FIXTURE_CANDIDATE_IDS[0],
      ...deferredCandidateIds
    ]
  });
  const candidate = portfolio.candidates.find(
    (item) =>
      item.source_candidate_id === TOPIC_PROBE_FIXTURE_CANDIDATE_IDS[0]
  )!;
  const contract = makeContract(
    candidate,
    deferredCandidateIds,
    portfolio.content_sha256
  );
  return {
    portfolio,
    candidate,
    contract,
    outcome: makeOutcome(contract, disposition, nextAction)
  };
}

function rehashCandidate(
  candidate: TopicPortfolioCandidate,
  changes: Partial<Omit<TopicPortfolioCandidate, "content_sha256">>
): TopicPortfolioCandidate {
  const { content_sha256: _contentSha256, ...payload } = candidate;
  const changedPayload = { ...payload, ...changes };
  return {
    ...changedPayload,
    content_sha256: hashCanonical(changedPayload)
  };
}

const FOLLOWUP_ROUTES = [
  [
    "promote_to_confirmatory",
    "start_confirmatory_run",
    "hypothesis_test",
    "confirmatory",
    "topic_probe_confirmatory"
  ],
  [
    "repeat_probe",
    "repeat_bounded_probe",
    "topic_discovery",
    "bounded_probe",
    "topic_probe_repeat"
  ],
  [
    "reject_candidate",
    "try_deferred_candidate",
    "topic_discovery",
    "bounded_probe",
    "topic_probe_deferred_candidate"
  ],
  [
    "reject_candidate",
    "refresh_topic_portfolio",
    "topic_discovery",
    "topic_refresh",
    "topic_probe_portfolio_refresh"
  ],
  [
    "blocked_invalid_evidence",
    "repair_probe_evidence",
    "topic_discovery",
    "bounded_probe",
    "topic_probe_evidence_repair"
  ]
] as const;

describe("topicProbeFollowup", () => {
  it.each(FOLLOWUP_ROUTES)(
    "builds a complete, deterministic handoff for %s -> %s",
    (disposition, nextAction, mode, evidenceStage, relation) => {
      const fixture = makeFixture(disposition, nextAction);
      const first = buildTopicProbeFollowupHandoff(fixture);
      const second = buildTopicProbeFollowupHandoff(fixture);

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        schema_version: 2,
        artifact_kind: "topic_probe_followup_handoff",
        parent_run_id: fixture.contract.run_id,
        parent_research_cycle: fixture.contract.research_cycle,
        candidate_id: fixture.candidate.source_candidate_id,
        topic_id: fixture.candidate.topic_id,
        contract_content_sha256: fixture.contract.content_sha256,
        outcome_content_sha256: fixture.outcome.content_sha256,
        candidate_content_sha256: fixture.candidate.content_sha256,
        source_portfolio_content_sha256: fixture.portfolio.content_sha256,
        disposition,
        next_action: nextAction,
        recommended_followup_mode: mode,
        evidence_stage: evidenceStage
      });
      expect(resolveTopicProbeSuccessorRelation(nextAction)).toBe(relation);
      expect(first.content_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(validateResearchBriefMarkdown(first.research_brief_markdown).errors).toEqual([]);
      expect(
        parseMarkdownRunBriefSections(first.research_brief_markdown)?.paperCeiling
      ).toBe("blocked_for_paper_scale");
      expect(first.research_brief_markdown.toLowerCase()).toContain(
        "bounded probe alone must not be used as evidence for paper claims"
      );
      expect(validateTopicProbeFollowupHandoff(JSON.stringify(first), {
        ...fixture,
        expectedRunId: fixture.contract.run_id,
        expectedResearchCycle: fixture.contract.research_cycle
      })).toMatchObject({
        measured: true,
        valid: true,
        reasons: []
      });
    }
  );

  it("freezes the complete promoted candidate contract and keeps the probe below paper claims", () => {
    const fixture = makeFixture();
    const handoff = buildTopicProbeFollowupHandoff(fixture);
    const markdown = handoff.research_brief_markdown;

    expect(markdown).toContain(fixture.candidate.statement);
    expect(markdown).toContain(fixture.contract.comparator);
    expect(markdown).toContain(fixture.contract.dataset_task_bench);
    expect(markdown).toContain(`"primary_metric": "${fixture.contract.primary_metric}"`);
    expect(markdown).toContain(`"metric_unit": "${fixture.contract.metric_unit}"`);
    expect(markdown).toContain(`"metric_scale": "${fixture.contract.metric_scale}"`);
    expect(markdown).toContain(`"metric_direction": "${fixture.contract.metric_direction}"`);
    expect(markdown).toContain(`"magnitude": ${fixture.contract.effect_criterion.magnitude}`);
    expect(markdown).toContain(fixture.contract.falsifier);
    expect(markdown).toContain(fixture.contract.kill_signal);
    expect(markdown).toContain(fixture.contract.local_budget);
    expect(markdown).toContain(fixture.candidate.contribution_claim);
    expect(markdown).toContain(fixture.candidate.minimum_publishable_evidence);
    expect(parseMarkdownRunBriefSections(markdown)?.objectiveMetric).toContain(
      fixture.contract.objective_raw
    );

    const normalized = markdown.toLowerCase();
    expect(normalized).toContain("real confirmatory repetitions are required");
    expect(normalized).toContain("uncertainty");
    expect(normalized).toContain("baseline comparison");
    expect(normalized).toContain("failure analysis");
  });

  it.each([
    ["contribution_claim", { contribution_claim: "   " }],
    ["minimum_publishable_evidence", { minimum_publishable_evidence: undefined }]
  ] as const)("fails closed when candidate %s is missing", (field, changes) => {
    const fixture = makeFixture();
    const candidate = rehashCandidate(
      fixture.candidate,
      changes as Partial<Omit<TopicPortfolioCandidate, "content_sha256">>
    );

    expect(() =>
      buildTopicProbeFollowupHandoff({ ...fixture, candidate })
    ).toThrow(`topic_probe_followup_candidate_${field}_missing`);
  });

  it("detects brief tampering with and without a replacement content hash", () => {
    const fixture = makeFixture();
    const handoff = buildTopicProbeFollowupHandoff(fixture);
    const changedBrief = `${handoff.research_brief_markdown}\nUnbound claim expansion.\n`;
    const directTamper = {
      ...handoff,
      research_brief_markdown: changedBrief
    };

    const directValidation = validateTopicProbeFollowupHandoff(
      JSON.stringify(directTamper),
      fixture
    );
    expect(directValidation.reasons).toEqual(expect.arrayContaining([
      "topic_probe_followup_handoff_content_hash_mismatch",
      "topic_probe_followup_handoff_recomputed_field_mismatch:research_brief_markdown"
    ]));

    const { content_sha256: _contentSha256, ...changedPayload } = directTamper;
    const rehashedTamper = {
      ...changedPayload,
      content_sha256: hashCanonical(changedPayload)
    };
    const rehashedValidation = validateTopicProbeFollowupHandoff(
      JSON.stringify(rehashedTamper),
      fixture
    );
    expect(rehashedValidation.reasons).not.toContain(
      "topic_probe_followup_handoff_content_hash_mismatch"
    );
    expect(rehashedValidation.reasons).toContain(
      "topic_probe_followup_handoff_recomputed_field_mismatch:research_brief_markdown"
    );
  });

  it.each(FOLLOWUP_ROUTES)(
    "rejects rehashed route projection tampering for %s -> %s",
    (disposition, nextAction, mode, evidenceStage) => {
      const fixture = makeFixture(disposition, nextAction);
      const handoff = buildTopicProbeFollowupHandoff(fixture);
      const { content_sha256: _contentSha256, ...payload } = handoff;
      const changedPayload = {
        ...payload,
        recommended_followup_mode:
          mode === "hypothesis_test" ? "topic_discovery" : "hypothesis_test",
        evidence_stage:
          evidenceStage === "confirmatory" ? "bounded_probe" : "confirmatory"
      };
      const rehashedTamper = {
        ...changedPayload,
        content_sha256: hashCanonical(changedPayload)
      };

      const validation = validateTopicProbeFollowupHandoff(
        JSON.stringify(rehashedTamper),
        fixture
      );

      expect(validation.reasons).not.toContain(
        "topic_probe_followup_handoff_content_hash_mismatch"
      );
      expect(validation.reasons).toEqual(expect.arrayContaining([
        "topic_probe_followup_handoff_recomputed_field_mismatch:recommended_followup_mode",
        "topic_probe_followup_handoff_recomputed_field_mismatch:evidence_stage"
      ]));
    }
  );

  it("detects schema, context, and rehashed source-binding tampering", () => {
    const fixture = makeFixture();
    const handoff = buildTopicProbeFollowupHandoff(fixture);
    const { content_sha256: _contentSha256, ...payload } = handoff;
    const sourceChangedPayload = {
      ...payload,
      outcome_content_sha256: "f".repeat(64)
    };
    const sourceChanged = {
      ...sourceChangedPayload,
      content_sha256: hashCanonical(sourceChangedPayload)
    };
    const sourceValidation = validateTopicProbeFollowupHandoff(
      JSON.stringify(sourceChanged),
      fixture
    );
    expect(sourceValidation.reasons).toEqual(expect.arrayContaining([
      "topic_probe_followup_handoff_source_binding_mismatch:outcome_content_sha256",
      "topic_probe_followup_handoff_recomputed_field_mismatch:outcome_content_sha256"
    ]));

    const contextValidation = validateTopicProbeFollowupHandoff(
      JSON.stringify(handoff),
      {
        ...fixture,
        expectedRunId: "run_other",
        expectedResearchCycle: 8
      }
    );
    expect(contextValidation.reasons).toEqual(expect.arrayContaining([
      "topic_probe_followup_handoff_parent_run_id_mismatch",
      "topic_probe_followup_handoff_parent_research_cycle_mismatch"
    ]));

    const unknownFieldPayload = {
      ...payload,
      unbound_field: true
    };
    const unknownFieldHandoff = {
      ...unknownFieldPayload,
      content_sha256: hashCanonical(unknownFieldPayload)
    };
    expect(
      validateTopicProbeFollowupHandoff(
        JSON.stringify(unknownFieldHandoff),
        fixture
      ).reasons
    ).toEqual(["topic_probe_followup_handoff_schema_invalid"]);
  });

  it("rejects mismatched candidate, contract, and outcome sources", () => {
    const fixture = makeFixture();
    const mismatchedCandidate = rehashCandidate(fixture.candidate, {
      source_candidate_id: "candidate_other"
    });
    expect(() =>
      buildTopicProbeFollowupHandoff({
        ...fixture,
        candidate: mismatchedCandidate
      })
    ).toThrow(
      "topic_probe_followup_candidate_contract_binding_mismatch:candidate_id"
    );

    const otherCandidate = makeCandidate({
      topic_id: "topic_other",
      source_candidate_id: "candidate_other",
      statement: "A different candidate statement under a different contract."
    });
    const otherContract = makeContract(otherCandidate);
    expect(() =>
      buildTopicProbeFollowupHandoff({
        portfolio: fixture.portfolio,
        candidate: otherCandidate,
        contract: otherContract,
        outcome: fixture.outcome
      })
    ).toThrow("topic_probe_followup_outcome_invalid");

    const {
      content_sha256: _outcomeContentSha256,
      ...outcomePayload
    } = fixture.outcome;
    const mismatchedOutcomePayload = {
      ...outcomePayload,
      candidate_id: "candidate_other"
    };
    const mismatchedOutcome = {
      ...mismatchedOutcomePayload,
      content_sha256: hashCanonical(mismatchedOutcomePayload)
    };
    expect(() =>
      buildTopicProbeFollowupHandoff({
        ...fixture,
        outcome: mismatchedOutcome
      })
    ).toThrow(
      "topic_probe_outcome_decision_contract_binding_mismatch:candidate_id"
    );
  });
});
