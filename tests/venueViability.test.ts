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
import type {
  TopicProbeOutcomeDecision,
  TopicProbeOutcomeDisposition,
  TopicProbeOutcomeNextAction,
  TopicProbeOutcomeReasonCode
} from "../src/core/topicProbeOutcome.js";
import {
  buildVenueViabilityReport,
  validateVenueViabilityReport
} from "../src/core/venueViability.js";
import {
  makeTopicProbeComputeBudgetDeclaration,
  makeTopicProbeComputeBudgetLimits
} from "./support/topicProbeComputeBudget.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function makeCandidate(): TopicPortfolioCandidate {
  const payload: Omit<TopicPortfolioCandidate, "content_sha256"> = {
    topic_id: "topic_controlled_intervention",
    source_candidate_id: "candidate_controlled_intervention",
    statement: "A controlled intervention improves a declared outcome.",
    gap_statement: "Prior work does not isolate the controlled intervention.",
    cluster_ids: ["cluster_controlled_evaluation"],
    unresolved_cluster_ids: [],
    supported_gap_ids: ["gap_controlled_evaluation"],
    evidence_links: ["evidence_primary", "evidence_independent"],
    unresolved_evidence_links: [],
    closest_prior_paper_ids: ["prior_primary", "prior_independent"],
    closest_prior_full_text_paper_ids: ["prior_primary", "prior_independent"],
    prior_absorption: {
      matrix_content_sha256: HASH_A,
      candidate_content_sha256: HASH_B,
      prior_paper_ids: ["prior_primary", "prior_independent"],
      comparisons: [
        {
          prior_paper_id: "prior_primary",
          reported_disposition: "non_overlapping",
          disposition: "non_overlapping",
          content_sha256: HASH_A
        },
        {
          prior_paper_id: "prior_independent",
          reported_disposition: "non_overlapping",
          disposition: "non_overlapping",
          content_sha256: HASH_B
        }
      ],
      coverage_complete: true,
      full_text_evidence_complete: true,
      axis_relation_verification_complete: true,
      independent_evidence_complete: true,
      partial_comparisons_complete: true,
      probe_eligible: true,
      reason_codes: []
    },
    closest_prior_non_overlap:
      "The controlled intervention is not evaluated by the closest prior.",
    reviewer_absorption_objection:
      "The comparison must beat the strongest matched reference.",
    comparator: "declared_reference",
    dataset_task_bench: "declared_evaluation_scope",
    primary_metric: "primary_measure",
    metric_unit: "score_unit",
    metric_scale: "raw",
    metric_direction: "maximize",
    meaningful_effect: "At least 0.04 score-unit improvement.",
    effect_criterion: {
      basis: "delta_vs_reference",
      magnitude: 0.04,
      scale: "raw",
      inclusive: true
    },
    objective_raw: buildCandidateObjectiveRaw({
      primary_metric: "primary_measure",
      metric_unit: "score_unit",
      metric_scale: "raw",
      metric_direction: "maximize",
      comparator: "declared_reference",
      effect_criterion: {
        basis: "delta_vs_reference",
        magnitude: 0.04,
        scale: "raw",
        inclusive: true
      }
    }),
    falsifier: "The controlled effect does not meet the frozen floor.",
    local_budget: makeTopicProbeComputeBudgetDeclaration(),
    brief_compute_budget_ceiling: makeTopicProbeComputeBudgetLimits(),
    kill_signal: "Stop when the frozen effect floor is not met.",
    contribution_claim: "A controlled estimate under a matched protocol.",
    minimum_publishable_evidence:
      "Independent confirmation, uncertainty, strong baselines, and failure analysis.",
    review_status: "kept",
    probe_status: "shortlisted",
    review_summary: "Retained for one bounded probe.",
    scores: {
      novelty: 4,
      feasibility: 5,
      testability: 5,
      cost: 4,
      expected_gain: 3
    },
    gates: [],
    probe_eligible: true
  };
  return { ...payload, content_sha256: hashCanonical(payload) };
}

function makeContract(
  candidate: TopicPortfolioCandidate,
  deferredCandidateIds: string[] = []
): ActiveTopicProbeContract {
  return buildActiveTopicProbeContract({
    runId: "run_venue_viability",
    researchCycle: 2,
    researchMode: "topic_discovery",
    portfolioContentSha256: HASH_A,
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
  const reasonCodes: Record<TopicProbeOutcomeDisposition, TopicProbeOutcomeReasonCode[]> = {
    promote_to_confirmatory: ["confirmatory_gate_satisfied"],
    reject_candidate: ["effect_floor_not_met"],
    repeat_probe: ["primary_metric_confidence_interval_missing"],
    blocked_invalid_evidence: ["fresh_executed_trials_missing"]
  };
  const measured = disposition !== "blocked_invalid_evidence";
  const payload: Omit<TopicProbeOutcomeDecision, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "topic_probe_outcome_decision",
    run_id: contract.run_id,
    research_cycle: contract.research_cycle,
    candidate_id: contract.candidate_id,
    topic_id: contract.topic_id,
    contract_content_sha256: contract.content_sha256,
    primary_comparison_id: measured ? "comparison_primary" : null,
    primary_metric: contract.primary_metric,
    observed_delta: measured ? 0.04 : null,
    directed_delta: measured ? 0.04 : null,
    required_magnitude: contract.effect_criterion.magnitude,
    executed_trials: measured ? 2 : 0,
    cached_trials: 0,
    primary_metric_ci_present: disposition === "promote_to_confirmatory",
    primary_effect_ci_directed_bound:
      disposition === "promote_to_confirmatory" ? 0.04 : null,
    primary_effect_ci_criterion_met: disposition === "promote_to_confirmatory",
    disposition,
    reason_codes: reasonCodes[disposition],
    evidence_refs: ["result_analysis.json#/primary_comparison_id"],
    next_action: nextAction
  };
  return { ...payload, content_sha256: hashCanonical(payload) };
}

describe("venueViability", () => {
  const routes = [
    ["promote_to_confirmatory", "start_confirmatory_run", [], "continue", "unresolved", "supported", "passed"],
    ["repeat_probe", "repeat_bounded_probe", [], "continue", "unresolved", "unresolved", "unresolved"],
    ["reject_candidate", "try_deferred_candidate", ["candidate_deferred"], "pivot", "blocked", "unsupported", "failed"],
    ["reject_candidate", "refresh_topic_portfolio", [], "kill", "blocked", "unsupported", "failed"],
    ["blocked_invalid_evidence", "repair_probe_evidence", [], "blocked", "unresolved", "unresolved", "invalid"]
  ] as const;

  it.each(routes)(
    "projects %s as %s without granting paper authority",
    (
      disposition,
      nextAction,
      deferredIds,
      viability,
      topTierReadiness,
      confirmatoryCandidacy,
      comparatorGate
    ) => {
      const candidate = makeCandidate();
      const contract = makeContract(candidate, [...deferredIds]);
      const outcome = makeOutcome(contract, disposition, nextAction);
      const context = { candidate, contract, outcome };
      const report = buildVenueViabilityReport(context);

      expect(report).toMatchObject({
        decision_scope: "active_candidate",
        candidate_viability: viability,
        current_evidence_ceiling: "screening_only",
        paper_scale_claims_allowed: false,
        paper_submission_allowed: false,
        top_tier_ready: false,
        acceptance_likelihood_assessed: false,
        top_tier_readiness: topTierReadiness,
        confirmatory_candidacy: confirmatoryCandidacy,
        declared_comparator_effect_gate: comparatorGate,
        next_action: nextAction
      });
      expect(validateVenueViabilityReport(JSON.stringify(report), context)).toMatchObject({
        valid: true,
        reasons: []
      });
    }
  );

  it("rejects a rehashed optimistic projection that disagrees with upstream evidence", () => {
    const candidate = makeCandidate();
    const contract = makeContract(candidate);
    const outcome = makeOutcome(
      contract,
      "reject_candidate",
      "refresh_topic_portfolio"
    );
    const context = { candidate, contract, outcome };
    const report = buildVenueViabilityReport(context);
    const { content_sha256: _contentSha256, ...payload } = report;
    const tamperedPayload = {
      ...payload,
      candidate_viability: "continue" as const,
      top_tier_readiness: "unresolved" as const
    };
    const tampered = {
      ...tamperedPayload,
      content_sha256: hashCanonical(tamperedPayload)
    };

    expect(validateVenueViabilityReport(JSON.stringify(tampered), context)).toMatchObject({
      valid: false,
      reasons: ["venue_viability_report_recomputed_mismatch"]
    });
  });

  it("treats a closest-prior-absorbed candidate as non-continuing", () => {
    const original = makeCandidate();
    const { content_sha256: _contentSha256, ...base } = original;
    const candidatePayload = {
      ...base,
      prior_absorption: {
        ...base.prior_absorption!,
        comparisons: base.prior_absorption!.comparisons.map((comparison, index) =>
          index === 0
            ? { ...comparison, disposition: "absorbed" as const }
            : comparison
        )
      }
    };
    const candidate = {
      ...candidatePayload,
      content_sha256: hashCanonical(candidatePayload)
    };
    const contract = makeContract(candidate);
    const outcome = makeOutcome(
      contract,
      "promote_to_confirmatory",
      "start_confirmatory_run"
    );

    expect(buildVenueViabilityReport({ candidate, contract, outcome })).toMatchObject({
      novelty_status: "absorbed",
      candidate_viability: "kill",
      confirmatory_candidacy: "unsupported",
      top_tier_readiness: "blocked",
      required_upgrades: expect.arrayContaining(["reformulate_contribution"])
    });
  });

  it("accepts canonical content when JSON object keys are reordered", () => {
    const candidate = makeCandidate();
    const contract = makeContract(candidate);
    const outcome = makeOutcome(
      contract,
      "promote_to_confirmatory",
      "start_confirmatory_run"
    );
    const context = { candidate, contract, outcome };
    const report = buildVenueViabilityReport(context);
    const reordered = Object.fromEntries(Object.entries(report).reverse());

    expect(validateVenueViabilityReport(JSON.stringify(reordered), context)).toMatchObject({
      valid: true,
      reasons: []
    });
  });

  it("rejects a candidate whose hash is not bound by the active contract", () => {
    const candidate = makeCandidate();
    const contract = makeContract(candidate);
    const { content_sha256: _contentSha256, ...changedPayload } = {
      ...candidate,
      statement: "Changed after the active contract was created."
    };
    const changedCandidate = {
      ...changedPayload,
      content_sha256: hashCanonical(changedPayload)
    };
    const outcome = makeOutcome(
      contract,
      "promote_to_confirmatory",
      "start_confirmatory_run"
    );

    expect(() => buildVenueViabilityReport({
      candidate: changedCandidate,
      contract,
      outcome
    })).toThrow("venue_viability_candidate_contract_mismatch");
  });
});
