import { describe, expect, it, vi } from "vitest";

import {
  buildAdaptiveGuidedBriefAnswers,
  createAdaptiveGuidedBriefState,
  getGuidedBriefRequiredFields,
  getNextAdaptiveGuidedBriefPrompt,
  resolveAdaptiveGuidedBriefAnswer
} from "../src/core/runs/adaptiveGuidedBriefInterview.js";
import { getGuidedBriefInterviewCopy } from "../src/core/runs/guidedBriefInterview.js";
import {
  CodexOAuthCompletionError,
  type CodexOAuthCompletionErrorCode
} from "../src/integrations/codex/oauthCompletionError.js";

describe("adaptive guided brief interview", () => {
  it("uses one narrative answer to cover several source-grounded fields", async () => {
    const state = createAdaptiveGuidedBriefState({ language: "en", researchMode: "hypothesis_test" });
    const copy = getGuidedBriefInterviewCopy("en", "hypothesis_test");
    const answer =
      "Compare a candidate approach with a reference approach on a public validation set; primary_score must improve by 0.05 under a one-hour local budget.";
    const runForText = vi.fn().mockResolvedValue(JSON.stringify({
      answer_adequate: true,
      extractions: [
        { field: "primaryMetric", quote: "primary_score" },
        { field: "meaningfulImprovement", quote: "improve by 0.05" },
        { field: "constraints", quote: "one-hour local budget" },
        { field: "baselineComparator", quote: "candidate approach with a reference approach" },
        { field: "datasetTaskBench", quote: "public validation set" }
      ],
      followup_question: "",
      rationale: "The answer directly states these fields."
    }));

    const resolution = await resolveAdaptiveGuidedBriefAnswer({
      state,
      copy,
      answer,
      llm: { runForText }
    });

    expect(resolution.status).toBe("advanced");
    expect(resolution.source).toBe("model");
    expect(resolution.state.answers.topic).toBe(answer);
    expect(resolution.state.answers.primaryMetric).toBe("primary_score");
    expect(resolution.state.answers.meaningfulImprovement).toBe("improve by 0.05");
    expect(resolution.state.answers.constraints).toBe("one-hour local budget");
    expect(resolution.state.answers.baselineComparator).toBe("candidate approach with a reference approach");
    expect(resolution.state.answers.datasetTaskBench).toBe("public validation set");
    expect(getNextAdaptiveGuidedBriefPrompt(resolution.state, copy)).toMatchObject({
      kind: "field",
      field: "researchQuestion"
    });
  });

  it("rejects model-invented values that are absent from the operator answer", async () => {
    const state = createAdaptiveGuidedBriefState({ language: "en", researchMode: "hypothesis_test" });
    const copy = getGuidedBriefInterviewCopy("en", "hypothesis_test");
    const answer = "Evaluate a bounded comparison on declared inputs.";

    const resolution = await resolveAdaptiveGuidedBriefAnswer({
      state,
      copy,
      answer,
      llm: {
        runForText: vi.fn().mockResolvedValue(JSON.stringify({
          answer_adequate: true,
          extractions: [{ field: "primaryMetric", quote: "invented_metric" }],
          followup_question: ""
        }))
      }
    });

    expect(resolution.state.answers.topic).toBe(answer);
    expect(resolution.state.answers.primaryMetric).toBeUndefined();
    expect(resolution.acceptedFields).toEqual(["topic"]);
    expect(getNextAdaptiveGuidedBriefPrompt(resolution.state, copy)).toMatchObject({
      kind: "field",
      field: "primaryMetric"
    });
  });

  it.each([
    ["empty text", "", "provider_empty_response"],
    ["non-JSON text", "unstructured response", "invalid_model_json"],
    [
      "a structurally invalid object",
      JSON.stringify({ answer_adequate: "yes", extractions: [] }),
      "invalid_model_schema"
    ]
  ])("reports %s without exposing provider output", async (_label, raw, expectedReason) => {
    const state = createAdaptiveGuidedBriefState({ language: "en", researchMode: "hypothesis_test" });
    const copy = getGuidedBriefInterviewCopy("en", "hypothesis_test");
    const answer = "Evaluate a bounded comparison on declared inputs.";

    const resolution = await resolveAdaptiveGuidedBriefAnswer({
      state,
      copy,
      answer,
      llm: { runForText: vi.fn().mockResolvedValue(raw) }
    });

    expect(resolution.source).toBe("guarded_fallback");
    expect(resolution.fallbackReason).toBe(expectedReason);
    expect(resolution.state.conversation.at(-1)?.fallbackReason).toBe(expectedReason);
    expect(JSON.stringify(resolution)).not.toContain(raw || "provider output");
  });

  it.each([
    ["authentication failure", "OAuth is required. Run the configured login flow.", "provider_auth_unavailable"],
    [
      "OAuth request rejection",
      "Codex OAuth backend request failed: 400 configured model is unsupported",
      "provider_request_rejected"
    ],
    ["rate limiting", "Provider request failed: 429 too many requests", "provider_rate_limited"],
    ["timeout", "Provider request timed out", "provider_timeout"],
    ["transport failure", "Network fetch failed before receiving an HTTP response", "provider_transport_error"],
    ["empty provider output", "Provider completed without text output", "provider_empty_response"],
    ["unclassified failure", "Unexpected provider failure", "provider_error"]
  ])("classifies %s without returning raw error text", async (_label, message, expectedReason) => {
    const state = createAdaptiveGuidedBriefState({ language: "en", researchMode: "hypothesis_test" });
    const copy = getGuidedBriefInterviewCopy("en", "hypothesis_test");

    const resolution = await resolveAdaptiveGuidedBriefAnswer({
      state,
      copy,
      answer: "Evaluate a bounded comparison on declared inputs.",
      llm: { runForText: vi.fn().mockRejectedValue(new Error(message)) }
    });

    expect(resolution.source).toBe("guarded_fallback");
    expect(resolution.fallbackReason).toBe(expectedReason);
    expect(JSON.stringify(resolution)).not.toContain(message);
  });

  it.each([
    ["auth_unavailable", "provider_auth_unavailable"],
    ["request_rejected", "provider_request_rejected"],
    ["quota_exhausted", "provider_quota_exhausted"],
    ["rate_limited", "provider_rate_limited"],
    ["transport_error", "provider_transport_error"],
    ["incomplete_response", "provider_empty_response"],
    ["empty_response", "provider_empty_response"],
    ["input_unavailable", "provider_error"],
    ["provider_unavailable", "provider_error"],
    ["stream_terminated", "provider_error"],
    ["provider_error", "provider_error"],
    ["observer_error", "provider_error"]
  ])("classifies typed Codex OAuth %s failures", async (code, expectedReason) => {
    const state = createAdaptiveGuidedBriefState({ language: "en", researchMode: "hypothesis_test" });
    const copy = getGuidedBriefInterviewCopy("en", "hypothesis_test");

    const resolution = await resolveAdaptiveGuidedBriefAnswer({
      state,
      copy,
      answer: "Evaluate a bounded comparison on declared inputs.",
      llm: {
        runForText: vi.fn().mockRejectedValue(
          new CodexOAuthCompletionError(code as CodexOAuthCompletionErrorCode)
        )
      }
    });

    expect(resolution.source).toBe("guarded_fallback");
    expect(resolution.fallbackReason).toBe(expectedReason);
  });

  it("does not reuse one quoted phrase as coverage for several fields", async () => {
    const state = createAdaptiveGuidedBriefState({ language: "en", researchMode: "hypothesis_test" });
    const copy = getGuidedBriefInterviewCopy("en", "hypothesis_test");
    const answer = "Evaluate a bounded comparison using primary_score.";

    const resolution = await resolveAdaptiveGuidedBriefAnswer({
      state,
      copy,
      answer,
      llm: {
        runForText: vi.fn().mockResolvedValue(JSON.stringify({
          answer_adequate: true,
          extractions: [
            { field: "primaryMetric", quote: "primary_score" },
            { field: "targetComparison", quote: "primary_score" }
          ],
          followup_question: ""
        }))
      }
    });

    expect(resolution.state.answers.primaryMetric).toBe("primary_score");
    expect(resolution.state.answers.targetComparison).toBeUndefined();
  });

  it("supports explicit labeled multi-field input without a model call", async () => {
    const state = createAdaptiveGuidedBriefState({ language: "en", researchMode: "hypothesis_test" });
    const copy = getGuidedBriefInterviewCopy("en", "hypothesis_test");
    const runForText = vi.fn();
    const answer = [
      "Topic: Bounded comparison of two declared conditions",
      "Primary metric: primary_score",
      "Meaningful improvement: at least 0.05",
      "Constraints: one local hour",
      "Baseline: reference approach",
      "Dataset: public validation set"
    ].join("; ");

    const resolution = await resolveAdaptiveGuidedBriefAnswer({
      state,
      copy,
      answer,
      llm: { runForText }
    });

    expect(runForText).not.toHaveBeenCalled();
    expect(resolution.source).toBe("labeled_input");
    expect(resolution.state.answers.topic).toBe("Bounded comparison of two declared conditions");
    expect(resolution.state.answers.primaryMetric).toBe("primary_score");
    expect(getNextAdaptiveGuidedBriefPrompt(resolution.state, copy)).toMatchObject({
      kind: "field",
      field: "researchQuestion"
    });
  });

  it("does not misassign a labeled answer when it omits the current field", async () => {
    const state = createAdaptiveGuidedBriefState({ language: "en", researchMode: "hypothesis_test" });
    const copy = getGuidedBriefInterviewCopy("en", "hypothesis_test");

    const resolution = await resolveAdaptiveGuidedBriefAnswer({
      state,
      copy,
      answer: "Primary metric: primary_score"
    });

    expect(resolution.status).toBe("followup_required");
    expect(resolution.state.answers.topic).toBeUndefined();
    expect(resolution.state.answers.primaryMetric).toBe("primary_score");
    expect(resolution.acceptedFields).toEqual(["primaryMetric"]);
    expect(getNextAdaptiveGuidedBriefPrompt(resolution.state, copy)).toMatchObject({
      kind: "field",
      field: "topic"
    });
  });

  it("keeps an explicitly uncertain field pending with a focused follow-up", async () => {
    const state = createAdaptiveGuidedBriefState({ language: "ko", researchMode: "hypothesis_test" });
    const copy = getGuidedBriefInterviewCopy("ko", "hypothesis_test");
    const runForText = vi.fn();

    const resolution = await resolveAdaptiveGuidedBriefAnswer({
      state,
      copy,
      answer: "아직 잘 모르겠습니다.",
      llm: { runForText }
    });

    expect(runForText).not.toHaveBeenCalled();
    expect(resolution.status).toBe("followup_required");
    expect(resolution.fallbackReason).toBe("explicit_uncertainty");
    expect(resolution.state.answers.topic).toBeUndefined();
    expect(getNextAdaptiveGuidedBriefPrompt(resolution.state, copy)).toMatchObject({
      kind: "field",
      field: "topic",
      question: expect.stringContaining("구체화")
    });
  });

  it("retains valid extractions while asking again for an inadequate current field", async () => {
    const state = createAdaptiveGuidedBriefState({ language: "en", researchMode: "hypothesis_test" });
    const copy = getGuidedBriefInterviewCopy("en", "hypothesis_test");
    const answer = "The topic remains open, while the current metric is primary_score.";

    const resolution = await resolveAdaptiveGuidedBriefAnswer({
      state,
      copy,
      answer,
      llm: {
        runForText: vi.fn().mockResolvedValue(JSON.stringify({
          answer_adequate: false,
          extractions: [{ field: "primaryMetric", quote: "primary_score" }],
          followup_question: "Which concrete problem should the comparison test?"
        }))
      }
    });

    expect(resolution.status).toBe("followup_required");
    expect(resolution.state.answers.topic).toBeUndefined();
    expect(resolution.state.answers.primaryMetric).toBe("primary_score");
    expect(resolution.acceptedFields).toEqual(["primaryMetric"]);
    expect(getNextAdaptiveGuidedBriefPrompt(resolution.state, copy)).toMatchObject({
      kind: "field",
      field: "topic",
      question: "Which concrete problem should the comparison test?"
    });
  });

  it("finishes after required coverage when the operator declines optional fields", async () => {
    const state = createAdaptiveGuidedBriefState({ language: "en", researchMode: "hypothesis_test" });
    for (const field of getGuidedBriefRequiredFields(state.researchMode)) {
      state.answers[field] = `declared ${field}`;
    }
    const copy = getGuidedBriefInterviewCopy("en", "hypothesis_test");
    expect(getNextAdaptiveGuidedBriefPrompt(state, copy).kind).toBe("optional_gate");

    const resolution = await resolveAdaptiveGuidedBriefAnswer({ state, copy, answer: "no" });

    expect(resolution.status).toBe("complete");
    expect(getNextAdaptiveGuidedBriefPrompt(resolution.state, copy).kind).toBe("complete");
    expect(buildAdaptiveGuidedBriefAnswers(resolution.state).topic).toBe("declared topic");
  });

  it("adds discovery scope fields before the shared experimental contract", async () => {
    const state = createAdaptiveGuidedBriefState({ language: "en", researchMode: "topic_discovery" });
    const copy = getGuidedBriefInterviewCopy("en", "topic_discovery");
    const first = await resolveAdaptiveGuidedBriefAnswer({
      state,
      copy,
      answer: "Search for reliability failures in bounded evaluation workflows."
    });

    expect(getNextAdaptiveGuidedBriefPrompt(first.state, copy)).toMatchObject({
      kind: "field",
      field: "scientificObject"
    });
    expect(first.fallbackReason).toBe("model_unavailable");
  });
});
