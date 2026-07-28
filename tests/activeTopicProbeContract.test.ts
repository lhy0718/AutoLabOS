import { describe, expect, it } from "vitest";

import {
  buildActiveTopicProbeContract,
  validateActiveTopicProbeContract
} from "../src/core/activeTopicProbeContract.js";
import { buildCandidateObjectiveRaw } from "../src/core/effectCriterion.js";
import { hashCanonical, type TopicPortfolio, type TopicPortfolioCandidate } from "../src/core/researchFunnel.js";

function candidate(overrides: Partial<TopicPortfolioCandidate> = {}): TopicPortfolioCandidate {
  const objectiveContract = {
    primary_metric: "primary_score",
    metric_unit: "unitless",
    metric_scale: "raw" as const,
    metric_direction: "maximize" as const,
    comparator: "reference_condition",
    effect_criterion: {
      basis: "delta_vs_reference" as const,
      magnitude: 0.03,
      scale: "raw" as const,
      inclusive: true
    }
  };
  const payload: Omit<TopicPortfolioCandidate, "content_sha256"> = {
    topic_id: "topic_candidate_a",
    source_candidate_id: "candidate_a",
    statement: "A controlled comparison with an explicit practical-effect boundary.",
    gap_statement: "Existing comparisons do not isolate the declared intervention.",
    cluster_ids: ["cluster_a"],
    supported_gap_ids: ["gap_a"],
    evidence_links: ["evidence_a"],
    unresolved_evidence_links: [],
    closest_prior_paper_ids: ["paper_a", "paper_b"],
    closest_prior_full_text_paper_ids: ["paper_a", "paper_b"],
    closest_prior_non_overlap: "The candidate isolates a previously confounded comparison.",
    reviewer_absorption_objection: "The closest prior does not report the matched intervention contrast.",
    ...objectiveContract,
    objective_raw: buildCandidateObjectiveRaw(objectiveContract),
    dataset_task_bench: "public_evaluation_collection",
    meaningful_effect: "At least 0.03 absolute improvement over the reference condition.",
    falsifier: "The paired interval includes effects smaller than the boundary.",
    local_budget: JSON.stringify({
      bounded_probe: {
        max_gpu_hours: 3,
        max_concurrent_gpus: 2,
        max_trials: 8
      },
      confirmatory: {
        max_gpu_hours: 13,
        max_concurrent_gpus: 2,
        max_trials: 24
      }
    }),
    brief_compute_budget_ceiling: {
      bounded_probe: {
        max_gpu_hours: 3,
        max_concurrent_gpus: 2,
        max_trials: 8
      },
      confirmatory: {
        max_gpu_hours: 13,
        max_concurrent_gpus: 2,
        max_trials: 24
      }
    },
    kill_signal: "Stop if the intervention cannot be applied to matched units.",
    contribution_claim: "A controlled estimate of the intervention effect.",
    minimum_publishable_evidence: "Repeated matched comparisons with uncertainty estimates.",
    review_status: "kept",
    probe_status: "shortlisted",
    scores: { novelty: 4, feasibility: 5, testability: 5, cost: 5, expected_gain: 3 },
    gates: [],
    probe_eligible: true,
    ...overrides
  };
  return { ...payload, content_sha256: hashCanonical(payload) };
}

function portfolio(active: TopicPortfolioCandidate): TopicPortfolio {
  return {
    schema_version: 1,
    artifact_kind: "research_topic_portfolio",
    generated_at: "2026-01-01T00:00:00.000Z",
    run_id: "run_a",
    research_cycle: 1,
    source_artifacts: [],
    source_artifact_bindings: [],
    candidate_policy: { minimum: 1, maximum: 1, observed: 1 },
    candidates: [active],
    cluster_policy: { minimum_distinct_nonempty: 1, observed_distinct_nonempty: 1 },
    overflow_candidates: [],
    probe_candidate_ids: [active.source_candidate_id],
    gates: [],
    probe_allowed: true,
    probe_topic_ids: [active.topic_id],
    content_sha256: "a".repeat(64)
  };
}

describe("activeTopicProbeContract", () => {
  it("accepts the initial research cycle used by the runtime graph", () => {
    const active = candidate();
    const contract = buildActiveTopicProbeContract({
      runId: "run_initial_cycle",
      researchCycle: 0,
      researchMode: "topic_discovery",
      portfolioContentSha256: "a".repeat(64),
      candidate: active,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(contract.research_cycle).toBe(0);
    expect(validateActiveTopicProbeContract(JSON.stringify(contract), {
      expectedRunId: "run_initial_cycle",
      expectedResearchCycle: 0
    }).valid).toBe(true);
  });

  it("binds a single probe-only candidate and validates it against its portfolio", () => {
    const active = candidate();
    const sourcePortfolio = portfolio(active);
    const contract = buildActiveTopicProbeContract({
      runId: "run_a",
      researchCycle: 1,
      researchMode: "topic_discovery",
      portfolioContentSha256: sourcePortfolio.content_sha256,
      candidate: active,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });

    const validation = validateActiveTopicProbeContract(JSON.stringify(contract), {
      expectedRunId: "run_a",
      expectedResearchCycle: 1,
      portfolio: sourcePortfolio
    });

    expect(validation.valid).toBe(true);
    expect(contract.evidence_stage).toBe("bounded_probe");
    expect(contract.selection_status).toBe("probe_only");
    expect(contract.compute_budget).toEqual({
      bounded_probe: {
        max_gpu_hours: 3,
        max_concurrent_gpus: 2,
        max_trials: 8
      },
      confirmatory: {
        max_gpu_hours: 13,
        max_concurrent_gpus: 2,
        max_trials: 24
      }
    });
    expect(contract.primary_metric).toBe("primary_score");
    expect(contract.metric_unit).toBe("unitless");
    expect(contract.metric_scale).toBe("raw");
    expect(contract.effect_criterion).toEqual({
      basis: "delta_vs_reference",
      magnitude: 0.03,
      scale: "raw",
      inclusive: true
    });
    expect(contract.objective_raw).toBe(active.objective_raw);
  });

  it("rejects a rehashed structured-effect tamper even when objective_raw is updated", () => {
    const active = candidate();
    const sourcePortfolio = portfolio(active);
    const contract = buildActiveTopicProbeContract({
      runId: "run_a",
      researchCycle: 1,
      researchMode: "topic_discovery",
      portfolioContentSha256: sourcePortfolio.content_sha256,
      candidate: active,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });
    const effectCriterion = { ...contract.effect_criterion, magnitude: 0.04 };
    const changedPayload = {
      ...contract,
      effect_criterion: effectCriterion,
      objective_raw: buildCandidateObjectiveRaw({
        primary_metric: contract.primary_metric,
        metric_unit: contract.metric_unit,
        metric_scale: contract.metric_scale,
        metric_direction: contract.metric_direction,
        comparator: contract.comparator,
        effect_criterion: effectCriterion
      })
    };
    const { content_sha256: _oldHash, ...payload } = changedPayload;
    const changed = { ...payload, content_sha256: hashCanonical(payload) };

    const validation = validateActiveTopicProbeContract(JSON.stringify(changed), {
      portfolio: sourcePortfolio
    });

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toEqual(expect.arrayContaining([
      "active_topic_probe_contract_candidate_field_mismatch:effect_criterion",
      "active_topic_probe_contract_candidate_field_mismatch:objective_raw"
    ]));
  });

  it("authorizes a contract without meaningful_effect prose", () => {
    const active = candidate({ meaningful_effect: undefined });
    const sourcePortfolio = portfolio(active);
    const contract = buildActiveTopicProbeContract({
      runId: "run_a",
      researchCycle: 1,
      researchMode: "topic_discovery",
      portfolioContentSha256: sourcePortfolio.content_sha256,
      candidate: active,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });

    const validation = validateActiveTopicProbeContract(JSON.stringify(contract), {
      portfolio: sourcePortfolio
    });

    expect(contract).not.toHaveProperty("meaningful_effect");
    expect(validation.valid).toBe(true);
  });

  it("rejects rehashed objective_raw tampering", () => {
    const active = candidate();
    const sourcePortfolio = portfolio(active);
    const contract = buildActiveTopicProbeContract({
      runId: "run_a",
      researchCycle: 1,
      researchMode: "topic_discovery",
      portfolioContentSha256: sourcePortfolio.content_sha256,
      candidate: active
    });
    const { content_sha256: _oldHash, ...payload } = {
      ...contract,
      objective_raw: "{\"tampered\":true}"
    };
    const changed = { ...payload, content_sha256: hashCanonical(payload) };

    const validation = validateActiveTopicProbeContract(JSON.stringify(changed), {
      portfolio: sourcePortfolio
    });

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain("active_topic_probe_contract_objective_raw_mismatch");
  });

  it("rejects a bounded topic-probe contract outside topic-discovery mode", () => {
    const active = candidate();
    const sourcePortfolio = portfolio(active);
    const contract = buildActiveTopicProbeContract({
      runId: "run_a",
      researchCycle: 1,
      researchMode: "topic_discovery",
      portfolioContentSha256: sourcePortfolio.content_sha256,
      candidate: active,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });
    const { content_sha256: _oldHash, ...payload } = {
      ...contract,
      research_mode: "hypothesis_test"
    };
    const invalid = { ...payload, content_sha256: hashCanonical(payload) };

    const validation = validateActiveTopicProbeContract(JSON.stringify(invalid), {
      portfolio: sourcePortfolio
    });

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toEqual(["active_topic_probe_contract_schema_invalid"]);
  });

  it("refuses an ambiguous free-text compute budget", () => {
    const incomplete = candidate({
      local_budget:
        "The bounded probe is limited to 4 GPU-hours on at most one GPU and at most 8 trials."
    });

    expect(() =>
      buildActiveTopicProbeContract({
        runId: "run_a",
        researchCycle: 1,
        researchMode: "topic_discovery",
        portfolioContentSha256: "a".repeat(64),
        candidate: incomplete
      })
    ).toThrow(
      "topic_probe_compute_budget_confirmatory_max_gpu_hours_missing"
    );
  });

  it.each([
    ["metric direction", { metric_direction: undefined }, "active_topic_probe_contract_metric_direction_missing"],
    ["metric unit", { metric_unit: "   " }, "active_topic_probe_contract_metric_unit_missing"],
    ["metric scale", { metric_scale: "ratio" }, "active_topic_probe_contract_metric_scale_invalid"],
    [
      "effect criterion",
      { effect_criterion: { basis: "delta_vs_reference", magnitude: -0.01, scale: "raw", inclusive: true } },
      "active_topic_probe_contract_effect_criterion_invalid"
    ],
    ["objective raw", { objective_raw: "{}" }, "active_topic_probe_contract_objective_raw_mismatch"]
  ])("refuses to build a contract with invalid %s", (_label, overrides, errorCode) => {
    const incomplete = candidate(overrides as Partial<TopicPortfolioCandidate>);

    expect(() =>
      buildActiveTopicProbeContract({
        runId: "run_a",
        researchCycle: 1,
        researchMode: "topic_discovery",
        portfolioContentSha256: "a".repeat(64),
        candidate: incomplete
      })
    ).toThrow(errorCode);
  });
});
