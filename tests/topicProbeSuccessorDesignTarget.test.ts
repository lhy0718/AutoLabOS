import { describe, expect, it } from "vitest";

import type {
  TopicPortfolioCandidate
} from "../src/core/researchFunnel.js";
import {
  validateTopicProbeSuccessorPortfolioTarget,
  validateTopicProbeSuccessorDesignTarget
} from "../src/core/topicProbeSuccessorDesignTarget.js";
import {
  buildTopicFormulationDescriptor,
  type TopicFormulationDescriptor
} from "../src/core/topicMemory.js";
import type {
  TopicProbeSuccessorRouteTarget
} from "../src/core/topicProbeSuccessorRouteTarget.js";
import {
  makeTopicProbeComputeBudgetDeclaration,
  makeTopicProbeComputeBudgetLimits
} from "./support/topicProbeComputeBudget.js";

describe("topic-probe successor design target", () => {
  it.each([
    "preserve_active_candidate",
    "select_deferred_candidate"
  ] as const)("accepts only the exact target projection for %s", (policy) => {
    const candidate = makeCandidate("candidate_target", "topic_target", "a");
    const routeTarget = makeRouteTarget(policy, candidate);

    expect(validateTopicProbeSuccessorDesignTarget({
      routeTarget,
      candidate
    })).toEqual({ valid: true, reasons: [] });

    const drifted = {
      ...candidate,
      comparator: "substituted_reference"
    } as TopicPortfolioCandidate;
    expect(validateTopicProbeSuccessorDesignTarget({
      routeTarget,
      candidate: drifted
    })).toMatchObject({
      valid: false,
      reasons: [
        "successor_design_candidate_projection_mismatch"
      ]
    });
  });

  it("rejects a refreshed candidate that revives the rejected topic under a new id", () => {
    const rejected = makeCandidate("candidate_rejected", "topic_rejected", "b");
    const routeTarget = makeRouteTarget(
      "refresh_portfolio_excluding_rejected",
      null,
      rejected
    );
    const renamed = makeCandidate("candidate_renamed", "topic_rejected", "c");

    expect(validateTopicProbeSuccessorDesignTarget({
      routeTarget,
      candidate: renamed
    })).toEqual({
      valid: false,
      reasons: ["successor_design_topic_id_forbidden"]
    });
  });

  it("rejects a refreshed candidate that only renames an unchanged formulation", () => {
    const rejected = makeCandidate("candidate_rejected", "topic_rejected", "b");
    const routeTarget = makeRouteTarget(
      "refresh_portfolio_excluding_rejected",
      null,
      rejected
    );
    const renamed = makeCandidate(
      "candidate_renamed",
      "topic_renamed",
      "c",
      rejected.topic_memory!.descriptor
    );

    expect(validateTopicProbeSuccessorDesignTarget({
      routeTarget,
      candidate: renamed
    }).reasons).toEqual(expect.arrayContaining([
      "successor_design_refresh_required_axis_unchanged",
      "successor_design_refresh_changed_axes_insufficient"
    ]));
  });

  it("rejects a refresh that changes fewer than three counted axes", () => {
    const rejected = makeCandidate("candidate_rejected", "topic_rejected", "b");
    const routeTarget = makeRouteTarget(
      "refresh_portfolio_excluding_rejected",
      null,
      rejected
    );
    const source = rejected.topic_memory!.descriptor!;
    const shallowDescriptor = buildTopicFormulationDescriptor({
      statement: "A different mechanism statement.",
      contribution_claim: "A different contribution object.",
      dataset_task_bench: source.data_task_scope,
      comparator: source.evaluation_protocol,
      minimum_publishable_evidence: source.claim_ceiling
    });
    const shallow = makeCandidate(
      "candidate_shallow",
      "topic_shallow",
      "e",
      shallowDescriptor
    );

    expect(validateTopicProbeSuccessorDesignTarget({
      routeTarget,
      candidate: shallow
    }).reasons).toContain(
      "successor_design_refresh_changed_axes_insufficient"
    );
  });

  it("accepts a distinct eligible candidate after portfolio refresh", () => {
    const rejected = makeCandidate("candidate_rejected", "topic_rejected", "b");
    const routeTarget = makeRouteTarget(
      "refresh_portfolio_excluding_rejected",
      null,
      rejected
    );
    const replacement = makeCandidate("candidate_replacement", "topic_new", "d");

    expect(validateTopicProbeSuccessorDesignTarget({
      routeTarget,
      candidate: replacement
    })).toEqual({ valid: true, reasons: [] });
  });

  it("rejects a refresh portfolio that hides an unchanged deferred candidate", () => {
    const rejected = makeCandidate("candidate_rejected", "topic_rejected", "b");
    const routeTarget = makeRouteTarget(
      "refresh_portfolio_excluding_rejected",
      null,
      rejected
    );
    const replacement = makeCandidate("candidate_replacement", "topic_new", "d");
    const revivedDeferred = makeCandidate(
      "candidate_deferred",
      "topic_deferred",
      "e",
      rejected.topic_memory!.descriptor
    );

    expect(validateTopicProbeSuccessorPortfolioTarget({
      routeTarget,
      candidates: [replacement, revivedDeferred]
    }).reasons).toEqual(expect.arrayContaining([
      "successor_design_refresh_required_axis_unchanged:candidate_deferred",
      "successor_design_refresh_changed_axes_insufficient:candidate_deferred"
    ]));
  });

  it("accepts a refresh portfolio only when every candidate diverges", () => {
    const rejected = makeCandidate("candidate_rejected", "topic_rejected", "b");
    const routeTarget = makeRouteTarget(
      "refresh_portfolio_excluding_rejected",
      null,
      rejected
    );

    expect(validateTopicProbeSuccessorPortfolioTarget({
      routeTarget,
      candidates: [
        makeCandidate("candidate_replacement_a", "topic_new_a", "d"),
        makeCandidate("candidate_replacement_b", "topic_new_b", "e")
      ]
    })).toEqual({ valid: true, reasons: [] });
  });
});

function makeRouteTarget(
  policy: TopicProbeSuccessorRouteTarget["policy"],
  targetCandidate: TopicPortfolioCandidate | null,
  rejectedCandidate: TopicPortfolioCandidate = targetCandidate!
): TopicProbeSuccessorRouteTarget {
  return {
    schema_version: 3,
    artifact_kind: "topic_probe_successor_route_target",
    policy,
    source_portfolio_content_sha256: "1".repeat(64),
    source_active_contract_content_sha256: "2".repeat(64),
    source_outcome_content_sha256: "3".repeat(64),
    source_active_candidate_id: rejectedCandidate.source_candidate_id,
    source_active_candidate_content_sha256: rejectedCandidate.content_sha256,
    source_active_descriptor:
      policy === "refresh_portfolio_excluding_rejected"
        ? rejectedCandidate.topic_memory!.descriptor!
        : null,
    refresh_divergence_policy:
      policy === "refresh_portfolio_excluding_rejected"
        ? {
            counted_axes: [
              "contribution_object",
              "method_mechanism",
              "data_task_scope",
              "evaluation_protocol"
            ],
            required_changed_axes: ["contribution_object"],
            minimum_changed_axes: 3
          }
        : null,
    target_candidate: targetCandidate,
    forbidden_candidate_ids:
      policy === "refresh_portfolio_excluding_rejected"
        ? [rejectedCandidate.source_candidate_id]
        : [],
    forbidden_topic_ids:
      policy === "refresh_portfolio_excluding_rejected"
        ? [rejectedCandidate.topic_id]
        : [],
    remaining_deferred_candidate_ids: [],
    content_sha256: "4".repeat(64)
  };
}

function makeCandidate(
  sourceCandidateId: string,
  topicId: string,
  hashPrefix: string,
  descriptor: TopicFormulationDescriptor = makeDescriptor(hashPrefix)
): TopicPortfolioCandidate {
  return {
    source_candidate_id: sourceCandidateId,
    topic_id: topicId,
    content_sha256: hashPrefix.repeat(64),
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
    objective_raw: "declared_objective_contract",
    falsifier: "The declared effect floor is not met.",
    local_budget: makeTopicProbeComputeBudgetDeclaration(),
    brief_compute_budget_ceiling: makeTopicProbeComputeBudgetLimits(),
    kill_signal: "Stop when the comparator cannot execute.",
    contribution_claim: "A controlled matched comparison.",
    minimum_publishable_evidence:
      "Repeated runs, uncertainty, and failure analysis.",
    topic_memory: {
      ledger_sha256: "f".repeat(64),
      descriptor,
      decision: {
        disposition: "clear",
        blocked: false,
        exact_formulation_match: false,
        exact_lineage_match: false,
        near_lineage_match: false,
        matching_record_sha256s: [],
        maximum_lineage_similarity: 0,
        reason_codes: []
      }
    },
    probe_eligible: true
  } as TopicPortfolioCandidate;
}

function makeDescriptor(tag: string): TopicFormulationDescriptor {
  return buildTopicFormulationDescriptor({
    statement: `mechanism ${tag}`,
    contribution_claim: `contribution ${tag}`,
    dataset_task_bench: `data scope ${tag}`,
    comparator: `evaluation protocol ${tag}`,
    minimum_publishable_evidence: `claim ceiling ${tag}`
  });
}
