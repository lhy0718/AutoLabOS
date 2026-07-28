import { describe, expect, it } from "vitest";

import type {
  LLMClient,
  LLMCompletion
} from "../src/core/llm/client.js";
import {
  buildHypothesisLlmInvocationProvenance,
  buildHypothesisPlanningProvenance,
  buildHypothesisReviewAuthorization,
  buildHypothesisReviewProvenance,
  isHypothesisReviewProvenanceAuthorizing,
  resolveHypothesisLlmIdentity,
  resolveHypothesisReviewBoundary,
  validateHypothesisLlmInvocationProvenance
} from "../src/core/analysis/hypothesisReviewProvenance.js";
import { hashCanonical } from "../src/core/canonicalHash.js";
import { resolveGenerateHypothesesReviewDependencies } from "../src/core/nodes/generateHypotheses.js";

class StaticLlmClient implements LLMClient {
  constructor(private readonly text = "{}") {}

  async complete(): Promise<LLMCompletion> {
    return { text: this.text };
  }
}

describe("hypothesis review provenance", () => {
  it("classifies a reused client as self-review even with different labels", () => {
    const llm = new StaticLlmClient();
    const boundary = resolveHypothesisReviewBoundary({
      proposerLlm: llm,
      proposerIdentity: { identity: "proposer_role" },
      reviewer: {
        llm,
        identity: { identity: "reviewer_role" }
      }
    });

    expect(boundary.independence_class).toBe("self_review");
    expect(boundary.reason_codes).toContain("review_client_matches_proposer");
  });

  it("classifies matching or missing identities as self-review", () => {
    const matching = resolveHypothesisReviewBoundary({
      proposerLlm: new StaticLlmClient(),
      proposerIdentity: { identity: "shared_role" },
      reviewer: {
        llm: new StaticLlmClient(),
        identity: { identity: "shared_role" }
      }
    });
    const missing = resolveHypothesisReviewBoundary({
      proposerLlm: new StaticLlmClient(),
      reviewer: {
        llm: new StaticLlmClient()
      }
    });

    expect(matching.independence_class).toBe("self_review");
    expect(matching.reason_codes).toContain(
      "review_identity_matches_proposer"
    );
    expect(missing.independence_class).toBe("self_review");
    expect(missing.reason_codes).toEqual(expect.arrayContaining([
      "proposer_identity_missing",
      "reviewer_identity_missing"
    ]));
  });

  it("authorizes only distinct clients and identities with valid invocation hashes", () => {
    const boundary = resolveHypothesisReviewBoundary({
      proposerLlm: new StaticLlmClient(),
      proposerIdentity: {
        backend: "local_backend",
        provider: "configured_provider",
        model: "research_model"
      },
      reviewer: {
        llm: new StaticLlmClient(),
        identity: {
          backend: "local_backend",
          provider: "configured_provider",
          model: "review_model"
        }
      }
    });
    const proposerInvocation = buildHypothesisLlmInvocationProvenance({
      role: "proposer",
      stage: "candidate_generation",
      invocationIndex: 1,
      actor: boundary.proposer,
      prompt: "Generate candidates.",
      systemPrompt: "Return structured output.",
      output: "{\"candidates\":[]}"
    });
    const reviewerInvocation = buildHypothesisLlmInvocationProvenance({
      role: "reviewer",
      stage: "hypothesis_review",
      invocationIndex: 1,
      actor: boundary.reviewer,
      prompt: "Review candidates.",
      systemPrompt: "Return structured output.",
      output: "{\"reviews\":[]}"
    });
    const provenance = buildHypothesisReviewProvenance({
      boundary,
      proposerInvocations: [proposerInvocation],
      reviewerInvocation
    });
    const planning = buildHypothesisPlanningProvenance({
      boundary,
      proposerInvocations: [proposerInvocation],
      reviewProvenances: [provenance]
    });

    expect(boundary.independence_class).toBe("independent_review");
    expect(provenance.independence_class).toBe("independent_review");
    expect(provenance.reviewer_invocation.input_sha256).toMatch(
      /^[a-f0-9]{64}$/u
    );
    expect(provenance.reviewer_invocation.input_sha256).toBe(hashCanonical({
      prompt: "Review candidates.",
      system_prompt: "Return structured output."
    }));
    expect(provenance.provenance_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(isHypothesisReviewProvenanceAuthorizing(provenance)).toBe(true);
    expect(planning.review_authorization.authorized_for_probe).toBe(true);
  });

  it("rejects provenance when a bound invocation input hash is altered", () => {
    const boundary = resolveHypothesisReviewBoundary({
      proposerLlm: new StaticLlmClient(),
      proposerIdentity: { identity: "proposer_role" },
      reviewer: {
        llm: new StaticLlmClient(),
        identity: { identity: "reviewer_role" }
      }
    });
    const proposerInvocation = buildHypothesisLlmInvocationProvenance({
      role: "proposer",
      stage: "candidate_generation",
      invocationIndex: 1,
      actor: boundary.proposer,
      prompt: "Generate candidates.",
      systemPrompt: "Return structured output.",
      output: "{\"candidates\":[]}"
    });
    const reviewerInvocation = buildHypothesisLlmInvocationProvenance({
      role: "reviewer",
      stage: "hypothesis_review",
      invocationIndex: 1,
      actor: boundary.reviewer,
      prompt: "Review candidates.",
      systemPrompt: "Return structured output.",
      output: "{\"reviews\":[]}"
    });
    const provenance = buildHypothesisReviewProvenance({
      boundary,
      proposerInvocations: [proposerInvocation],
      reviewerInvocation
    });
    const altered = structuredClone(provenance);
    altered.reviewer_invocation.input_sha256 = "0".repeat(64);

    expect(validateHypothesisLlmInvocationProvenance(
      altered.reviewer_invocation
    )).toContain("llm_invocation_hash_invalid");
    expect(isHypothesisReviewProvenanceAuthorizing(altered)).toBe(false);
  });

  it("rejects an authorizing review reused across a different boundary", () => {
    const originalBoundary = resolveHypothesisReviewBoundary({
      proposerLlm: new StaticLlmClient(),
      proposerIdentity: { identity: "original_proposer" },
      reviewer: {
        llm: new StaticLlmClient(),
        identity: { identity: "original_reviewer" }
      }
    });
    const originalProposerInvocation = buildHypothesisLlmInvocationProvenance({
      role: "proposer",
      stage: "candidate_generation",
      invocationIndex: 1,
      actor: originalBoundary.proposer,
      prompt: "Generate original candidates.",
      systemPrompt: "Return structured output.",
      output: "{\"candidates\":[]}"
    });
    const originalReviewerInvocation = buildHypothesisLlmInvocationProvenance({
      role: "reviewer",
      stage: "hypothesis_review",
      invocationIndex: 1,
      actor: originalBoundary.reviewer,
      prompt: "Review original candidates.",
      systemPrompt: "Return structured output.",
      output: "{\"reviews\":[]}"
    });
    const staleProvenance = buildHypothesisReviewProvenance({
      boundary: originalBoundary,
      proposerInvocations: [originalProposerInvocation],
      reviewerInvocation: originalReviewerInvocation
    });
    const currentBoundary = resolveHypothesisReviewBoundary({
      proposerLlm: new StaticLlmClient(),
      proposerIdentity: { identity: "current_proposer" },
      reviewer: {
        llm: new StaticLlmClient(),
        identity: { identity: "current_reviewer" }
      }
    });
    const currentProposerInvocation = buildHypothesisLlmInvocationProvenance({
      role: "proposer",
      stage: "candidate_generation",
      invocationIndex: 1,
      actor: currentBoundary.proposer,
      prompt: "Generate current candidates.",
      systemPrompt: "Return structured output.",
      output: "{\"candidates\":[]}"
    });

    const authorization = buildHypothesisReviewAuthorization({
      boundary: currentBoundary,
      proposerInvocations: [currentProposerInvocation],
      reviewProvenances: [staleProvenance]
    });

    expect(authorization.authorized_for_probe).toBe(false);
    expect(authorization.reason_codes).toEqual(expect.arrayContaining([
      "review_provenance_boundary_mismatch",
      "review_provenance_proposer_invocations_mismatch"
    ]));
  });

  it("keeps identity resolution public and accepts namespaced future stages", () => {
    const actor = resolveHypothesisLlmIdentity({
      identity: "topic_memory_reviewer"
    });
    const invocation = buildHypothesisLlmInvocationProvenance({
      role: "reviewer",
      stage: "topic_memory_semantic_audit",
      invocationIndex: 1,
      actor,
      prompt: "Compare two normalized research objects.",
      systemPrompt: "Return a bounded semantic judgment.",
      output: "{\"decision\":\"distinct\"}"
    });

    expect(actor.identity_source).toBe("caller_supplied");
    expect(invocation.stage).toBe("topic_memory_semantic_audit");
    expect(validateHypothesisLlmInvocationProvenance(invocation)).toEqual([]);
  });

  it("derives runtime role identities and blocks an unchanged reviewer model", () => {
    const proposerLlm = new StaticLlmClient();
    const reviewerLlm = new StaticLlmClient();
    const baseProviders = {
      llm_mode: "ollama",
      ollama: {
        research_model: "configured_model",
        experiment_model: "configured_model"
      }
    };
    const sameModel = resolveGenerateHypothesesReviewDependencies({
      config: { providers: baseProviders } as never,
      llm: proposerLlm,
      experimentLlm: reviewerLlm
    });
    const distinctModel = resolveGenerateHypothesesReviewDependencies({
      config: {
        providers: {
          ...baseProviders,
          ollama: {
            ...baseProviders.ollama,
            experiment_model: "independent_review_model"
          }
        }
      } as never,
      llm: proposerLlm,
      experimentLlm: reviewerLlm
    });

    expect(resolveHypothesisReviewBoundary({
      proposerLlm,
      proposerIdentity: sameModel.proposerIdentity,
      reviewer: sameModel.reviewer
    }).independence_class).toBe("self_review");
    expect(resolveHypothesisReviewBoundary({
      proposerLlm,
      proposerIdentity: distinctModel.proposerIdentity,
      reviewer: distinctModel.reviewer
    }).independence_class).toBe("independent_review");
  });
});
