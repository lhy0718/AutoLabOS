import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPENAI_RESPONSES_MODEL,
  OPENAI_RESPONSES_MODEL_OPTIONS,
  buildOpenAiResponsesModelChoices,
  getOpenAiResponsesModelDescription,
  normalizeOpenAiResponsesModel,
  normalizeOpenAiResponsesReasoningEffort,
  supportsOpenAiResponsesReasoning
} from "../src/integrations/openai/modelCatalog.js";

describe("openaiModelCatalog", () => {
  it("exposes stable OpenAI Responses model choices", () => {
    expect(buildOpenAiResponsesModelChoices()).toEqual(
      OPENAI_RESPONSES_MODEL_OPTIONS.map((option) => option.value)
    );
    expect(buildOpenAiResponsesModelChoices()).toContain("gpt-5.4");
    expect(buildOpenAiResponsesModelChoices()).toContain("gpt-4o-mini");
  });

  it("returns readable descriptions", () => {
    expect(getOpenAiResponsesModelDescription("gpt-5.4")).toContain("Highest-quality");
    expect(getOpenAiResponsesModelDescription("gpt-4o")).toContain("multimodal");
  });

  it("normalizes unknown models and reasoning effort", () => {
    expect(normalizeOpenAiResponsesModel("")).toBe(DEFAULT_OPENAI_RESPONSES_MODEL);
    expect(normalizeOpenAiResponsesModel("unknown-model")).toBe(DEFAULT_OPENAI_RESPONSES_MODEL);
    expect(normalizeOpenAiResponsesReasoningEffort("gpt-5.4", "xhigh")).toBe("xhigh");
    expect(normalizeOpenAiResponsesReasoningEffort("gpt-4o", "xhigh")).toBe("medium");
    expect(supportsOpenAiResponsesReasoning("gpt-5")).toBe(true);
    expect(supportsOpenAiResponsesReasoning("gpt-4o")).toBe(false);
  });
});
