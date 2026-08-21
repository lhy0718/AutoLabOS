import type {
  LLMClient,
  LLMCompletion
} from "../../src/core/llm/client.js";
import {
  buildHypothesisLlmInvocationProvenance,
  buildHypothesisReviewProvenance,
  resolveHypothesisReviewBoundary,
  type HypothesisReviewProvenance
} from "../../src/core/analysis/hypothesisReviewProvenance.js";

class FixtureLlmClient implements LLMClient {
  async complete(): Promise<LLMCompletion> {
    return { text: "{}" };
  }
}

export function makeIndependentHypothesisReviewProvenance(
  fixtureId = "candidate"
): HypothesisReviewProvenance {
  const boundary = resolveHypothesisReviewBoundary({
    proposerLlm: new FixtureLlmClient(),
    proposerIdentity: { identity: `${fixtureId}_proposer` },
    reviewer: {
      llm: new FixtureLlmClient(),
      identity: { identity: `${fixtureId}_reviewer` }
    }
  });
  const proposerInvocation = buildHypothesisLlmInvocationProvenance({
    role: "proposer",
    stage: "candidate_generation",
    invocationIndex: 1,
    actor: boundary.proposer,
    prompt: `Generate ${fixtureId}.`,
    systemPrompt: "Return a structured candidate.",
    output: "{\"candidates\":[]}"
  });
  const reviewerInvocation = buildHypothesisLlmInvocationProvenance({
    role: "reviewer",
    stage: "hypothesis_review",
    invocationIndex: 1,
    actor: boundary.reviewer,
    prompt: `Review ${fixtureId}.`,
    systemPrompt: "Return a structured review.",
    output: "{\"reviews\":[]}"
  });
  return buildHypothesisReviewProvenance({
    boundary,
    proposerInvocations: [proposerInvocation],
    reviewerInvocation
  });
}
