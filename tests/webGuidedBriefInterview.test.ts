import { describe, expect, it } from "vitest";

import {
  resolveAdaptiveGuidedBriefAnswer,
  type AdaptiveGuidedBriefResolution
} from "../src/core/runs/adaptiveGuidedBriefInterview.js";
import { getGuidedBriefInterviewCopy } from "../src/core/runs/guidedBriefInterview.js";
import {
  WebGuidedBriefInterviewBusyError,
  WebGuidedBriefInterviewManager,
  WebGuidedBriefInterviewNotFoundError
} from "../src/web/guidedBriefInterview.js";

function createManager(overrides: Partial<ConstructorParameters<typeof WebGuidedBriefInterviewManager>[0]> = {}) {
  return new WebGuidedBriefInterviewManager({
    idFactory: () => "guided-brief-fixture",
    resolveAnswer: (input) => resolveAdaptiveGuidedBriefAnswer({
      ...input,
      copy: getGuidedBriefInterviewCopy(input.state.language, input.state.researchMode)
    }),
    ...overrides
  });
}

describe("web guided brief interview manager", () => {
  it("projects shared coverage and returns a governed brief only after completion", async () => {
    const manager = createManager();
    const started = manager.start({ language: "en", researchMode: "hypothesis_test" });

    expect(started).toMatchObject({
      id: "guided-brief-fixture",
      status: "active",
      prompt: { kind: "field", field: "topic" },
      coverage: { answered: 0, required: 15 }
    });
    expect(started.generatedBrief).toBeUndefined();

    const requiredAnswer = [
      "Topic: Bounded comparison of declared conditions",
      "Primary metric: primary_score",
      "Meaningful improvement: at least 0.05",
      "Constraints: one local hour",
      "Research question: Does the candidate improve primary_score?",
      "Small experiment: one fixed public validation split is sufficient",
      "Baseline: declared reference condition",
      "Dataset: public validation set",
      "Target comparison: candidate versus reference",
      "Minimum evidence: one complete result table",
      "Disallowed shortcuts: no synthetic success rows",
      "Allowed passes: one bounded repair pass",
      "Paper ceiling: research_memo",
      "Minimum experiment plan: execute both conditions with fixed seeds",
      "Failure conditions: missing baseline or incomplete metrics"
    ].join("; ");
    const covered = await manager.answer({ id: started.id, answer: requiredAnswer });

    expect(covered).toMatchObject({
      status: "active",
      prompt: { kind: "optional_gate" },
      coverage: { answered: 15, required: 15 },
      lastResolutionSource: "labeled_input"
    });
    expect(covered.lastAcceptedFields).toHaveLength(15);
    expect(covered.generatedBrief).toBeUndefined();

    const complete = await manager.answer({ id: started.id, answer: "no" });

    expect(complete).toMatchObject({
      status: "complete",
      prompt: { kind: "complete" },
      coverage: { answered: 15, required: 15 },
      lastResolutionSource: "operator_control"
    });
    expect(complete.generatedBrief).toContain("# Research Brief");
    expect(complete.generatedBrief).toContain("Bounded comparison of declared conditions");

    await expect(manager.answer({ id: started.id, answer: "ignored after completion" }))
      .resolves.toEqual(complete);
  });

  it("rejects a concurrent answer for the same server-owned draft", async () => {
    let finish!: (resolution: AdaptiveGuidedBriefResolution) => void;
    const manager = createManager({
      resolveAnswer: () => new Promise((resolve) => {
        finish = resolve;
      })
    });
    const started = manager.start({ language: "en", researchMode: "hypothesis_test" });
    const first = manager.answer({ id: started.id, answer: "Declared topic" });

    await expect(manager.answer({ id: started.id, answer: "Duplicate topic" }))
      .rejects.toBeInstanceOf(WebGuidedBriefInterviewBusyError);

    finish({
      state: {
        language: "en",
        researchMode: "hypothesis_test",
        answers: { topic: "Declared topic" },
        skippedOptionalFields: [],
        optionalMode: "undecided",
        conversation: []
      },
      status: "advanced",
      acceptedFields: ["topic"],
      source: "guarded_fallback",
      fallbackReason: "provider_request_rejected"
    });
    await expect(first).resolves.toMatchObject({
      coverage: { answered: 1 },
      lastFallbackReason: "provider_request_rejected"
    });
  });

  it("expires inactive drafts instead of presenting them as durable state", () => {
    let now = 10;
    const manager = createManager({ now: () => now, ttlMs: 5 });
    const started = manager.start({ language: "ko", researchMode: "topic_discovery" });
    now = 16;

    expect(() => manager.get(started.id)).toThrow(WebGuidedBriefInterviewNotFoundError);
  });

  it("does not resurrect a draft cancelled while an answer is in flight", async () => {
    let finish!: (resolution: AdaptiveGuidedBriefResolution) => void;
    const manager = createManager({
      resolveAnswer: () => new Promise((resolve) => {
        finish = resolve;
      })
    });
    const started = manager.start({ language: "en", researchMode: "hypothesis_test" });
    const pending = manager.answer({ id: started.id, answer: "Declared topic" });

    expect(manager.cancel(started.id)).toBe(true);
    finish({
      state: {
        language: "en",
        researchMode: "hypothesis_test",
        answers: { topic: "Declared topic" },
        skippedOptionalFields: [],
        optionalMode: "undecided",
        conversation: []
      },
      status: "advanced",
      acceptedFields: ["topic"],
      source: "guarded_fallback"
    });

    await expect(pending).rejects.toBeInstanceOf(WebGuidedBriefInterviewNotFoundError);
    expect(() => manager.get(started.id)).toThrow(WebGuidedBriefInterviewNotFoundError);
  });
});
