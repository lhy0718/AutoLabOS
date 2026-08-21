import { describe, expect, it } from "vitest";

import type {
  LLMClient,
  LLMCompletion
} from "../src/core/llm/client.js";
import { generateHypothesesFromEvidence } from "../src/core/analysis/researchPlanning.js";
import { makeTopicProbeComputeBudgetDeclaration } from "./support/topicProbeComputeBudget.js";

class StageAwareProposer implements LLMClient {
  async complete(prompt: string): Promise<LLMCompletion> {
    if (prompt.startsWith("Synthesize the evidence")) {
      return {
        text: JSON.stringify({
          summary: "Mapped one evidence-backed axis.",
          axes: [{
            id: "ax_1",
            label: "Controlled intervention",
            mechanism: "A bounded intervention may change the declared outcome.",
            intervention: "Compare the candidate intervention with the declared control.",
            evidence_links: ["evidence_1"]
          }]
        })
      };
    }
    if (prompt.startsWith("Generate hypotheses that isolate")) {
      return {
        text: JSON.stringify({
          summary: "Generated one bounded candidate.",
          candidates: [candidateRecord()]
        })
      };
    }
    if (
      prompt.startsWith("Generate boundary-condition")
      || prompt.startsWith("Generate intervention-first")
    ) {
      return {
        text: JSON.stringify({
          summary: "No additional candidate.",
          candidates: []
        })
      };
    }
    if (prompt.startsWith("Review the hypothesis drafts")) {
      return { text: JSON.stringify(reviewRecord()) };
    }
    throw new Error(`unexpected proposer prompt: ${prompt.slice(0, 60)}`);
  }
}

class ReviewOnlyClient implements LLMClient {
  async complete(prompt: string): Promise<LLMCompletion> {
    if (!prompt.startsWith("Review the hypothesis drafts")) {
      throw new Error(`unexpected reviewer prompt: ${prompt.slice(0, 60)}`);
    }
    return { text: JSON.stringify(reviewRecord()) };
  }
}

describe("research planning independent reviewer boundary", () => {
  it("records same-client review as self-review and withholds probe authorization", async () => {
    const sharedClient = new StageAwareProposer();
    const result = await generateHypothesesFromEvidence({
      llm: sharedClient,
      proposerIdentity: { identity: "candidate_proposer" },
      reviewer: {
        llm: sharedClient,
        identity: { identity: "candidate_reviewer" }
      },
      runTitle: "Bounded comparison",
      runTopic: "Controlled research question",
      objectiveMetric: "",
      evidenceSeeds: [{
        evidence_id: "evidence_1",
        claim: "The prior comparison leaves a bounded evaluation gap."
      }],
      branchCount: 2,
      topK: 1,
      governance: {
        researchMode: "topic_discovery",
        constraints: []
      }
    });

    expect(result.artifacts.pipeline).toBe("staged");
    expect(result.probe_candidates).toEqual([]);
    expect(
      result.artifacts.provenance.review_authorization.authorized_for_probe
    ).toBe(false);
    expect(
      result.artifacts.provenance.review_authorization.reason_codes
    ).toContain("review_client_matches_proposer");
    expect(result.artifacts.reviews[0]?.provenance).toMatchObject({
      independence_class: "self_review",
      authorization_eligible: false,
      reason_codes: expect.arrayContaining([
        "review_client_matches_proposer"
      ])
    });
    expect(
      result.artifacts.reviews[0]?.provenance?.reviewer_invocation.input_sha256
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.artifacts.hard_gate_rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidate_id: "mechanism_1",
          reasons: expect.arrayContaining([
            expect.stringContaining("independent_review_required")
          ])
        })
      ])
    );
  });

  it("uses a distinct reviewer dependency and binds authorizing provenance", async () => {
    const result = await generateHypothesesFromEvidence({
      llm: new StageAwareProposer(),
      proposerIdentity: {
        backend: "local_backend",
        provider: "configured_provider",
        model: "research_model"
      },
      reviewer: {
        llm: new ReviewOnlyClient(),
        identity: {
          backend: "local_backend",
          provider: "configured_provider",
          model: "review_model"
        }
      },
      runTitle: "Bounded comparison",
      runTopic: "Controlled research question",
      objectiveMetric: "",
      evidenceSeeds: [{
        evidence_id: "evidence_1",
        claim: "The prior comparison leaves a bounded evaluation gap."
      }],
      branchCount: 2,
      topK: 1,
      governance: {
        researchMode: "topic_discovery",
        constraints: []
      }
    });

    expect(result.artifacts.pipeline).toBe("staged");
    expect(result.probe_candidates.map((candidate) => candidate.id)).toEqual([
      "mechanism_1"
    ]);
    expect(result.artifacts.provenance.review_authorization).toMatchObject({
      independence_class: "independent_review",
      authorized_for_probe: true,
      reason_codes: []
    });
    expect(result.artifacts.reviews[0]?.provenance).toMatchObject({
      independence_class: "independent_review",
      authorization_eligible: true,
      reason_codes: []
    });
    expect(
      result.artifacts.provenance.proposer_invocations.map(
        (invocation) => invocation.stage
      )
    ).toEqual([
      "evidence_axes",
      "candidate_generation",
      "candidate_generation",
      "candidate_generation"
    ]);
  });
});

function candidateRecord(): Record<string, unknown> {
  return {
    id: "candidate_1",
    text: "A bounded intervention changes the primary outcome relative to the declared control.",
    novelty: 4,
    feasibility: 4,
    testability: 5,
    cost: 2,
    expected_gain: 4,
    evidence_links: ["evidence_1"],
    axis_ids: ["ax_1"],
    rationale: "The candidate isolates one intervention and one comparator.",
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
    meaningful_effect: "At least 0.05 over the declared control.",
    measurement_signals: ["primary_score", "uncertainty_interval"],
    measurement_hint: "Compare repeated matched runs with an uncertainty interval.",
    boundary_condition: "The effect may disappear outside the declared scope.",
    gap_statement: "The linked evidence omits the controlled comparison.",
    closest_prior_non_overlap: "The candidate adds the missing controlled comparison.",
    reviewer_absorption_objection: "The closest prior may already imply the intervention.",
    comparator: "declared_control",
    dataset_task_bench: "configured_evaluation_scope",
    falsifier: "The interval excludes the prespecified effect in the wrong direction.",
    local_budget: makeTopicProbeComputeBudgetDeclaration(),
    kill_signal: "Stop when the bounded comparison cannot execute.",
    contribution_claim: "The comparison identifies a prespecified boundary.",
    minimum_publishable_evidence: "Repeated controlled comparisons with uncertainty and failure analysis."
  };
}

function reviewRecord(): Record<string, unknown> {
  return {
    summary: "Reviewed the bounded candidate.",
    reviews: [{
      candidate_id: "mechanism_1",
      keep: true,
      groundedness: 5,
      causal_clarity: 5,
      falsifiability: 5,
      experimentability: 5,
      measurement_specificity: 5,
      measurement_signals: ["primary_score", "uncertainty_interval"],
      measurement_hint: "Compare repeated matched runs with an uncertainty interval.",
      limitation_reflection: 4,
      measurement_readiness: 5,
      strengths: ["The intervention and comparator are explicit."],
      weaknesses: ["The claim remains bounded to the configured scope."],
      critique_summary: "Keep only as a bounded probe candidate."
    }]
  };
}
