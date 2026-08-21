import { describe, expect, it } from "vitest";

import {
  DEFAULT_CODEX_MODEL,
  GPT_5_4_FAST_MODEL_LABEL,
  GPT_5_6_LUNA_MODEL,
  GPT_5_6_SOL_MODEL,
  GPT_5_6_TERRA_MODEL,
  OFFICIAL_CODEX_MODELS,
  buildCodexModelSelectionChoices,
  getCurrentCodexModelSelectionValue,
  getReasoningEffortChoicesForModel,
  isRecommendedCodexModelSelection,
  normalizeReasoningEffortForModel,
  RECOMMENDED_CODEX_MODEL,
  resolveCodexModelSelection
} from "../src/integrations/codex/modelCatalog.js";

describe("modelCatalog", () => {
  it("lists current models first while retaining compatibility entries", () => {
    expect(OFFICIAL_CODEX_MODELS).toContain(GPT_5_6_SOL_MODEL);
    expect(OFFICIAL_CODEX_MODELS).toContain(GPT_5_6_TERRA_MODEL);
    expect(OFFICIAL_CODEX_MODELS).toContain(GPT_5_6_LUNA_MODEL);
    expect(OFFICIAL_CODEX_MODELS).toContain("gpt-5.5");
    expect(OFFICIAL_CODEX_MODELS).toContain("gpt-5.4");
    expect(OFFICIAL_CODEX_MODELS).toContain("gpt-5.4-mini");
    expect(OFFICIAL_CODEX_MODELS).toContain("gpt-5.3-codex-spark");
    expect(OFFICIAL_CODEX_MODELS).toContain("gpt-5.3-codex");
    expect(OFFICIAL_CODEX_MODELS).toContain("gpt-5.2");
  });

  it("exposes gpt-5.4 and gpt-5.4 (fast) as separate selector options", () => {
    const choices = buildCodexModelSelectionChoices();
    expect(choices).toContain("gpt-5.4");
    expect(choices).toContain(GPT_5_4_FAST_MODEL_LABEL);
    expect(resolveCodexModelSelection("gpt-5.4")).toEqual({
      model: "gpt-5.4",
      fastMode: false
    });
    expect(resolveCodexModelSelection(GPT_5_4_FAST_MODEL_LABEL)).toEqual({
      model: "gpt-5.4",
      fastMode: true
    });
    expect(getCurrentCodexModelSelectionValue("gpt-5.4", true)).toBe(GPT_5_4_FAST_MODEL_LABEL);
    expect(getCurrentCodexModelSelectionValue(undefined, false)).toBe(DEFAULT_CODEX_MODEL);
  });

  it("orders the GPT-5.6 family first while retaining a configured compatibility choice", () => {
    const choices = buildCodexModelSelectionChoices("gpt-5.1-codex");
    expect(choices.slice(0, 8)).toEqual([
      RECOMMENDED_CODEX_MODEL,
      GPT_5_6_TERRA_MODEL,
      GPT_5_6_LUNA_MODEL,
      "gpt-5.5",
      "gpt-5.4",
      GPT_5_4_FAST_MODEL_LABEL,
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]);
    expect(choices).toContain("gpt-5.1-codex");
    expect(choices.indexOf("gpt-5.3-codex-spark")).toBeLessThan(choices.indexOf("gpt-5.1-codex"));
  });

  it("marks only GPT-5.6 Sol as recommended", () => {
    expect(isRecommendedCodexModelSelection(RECOMMENDED_CODEX_MODEL)).toBe(true);
    expect(isRecommendedCodexModelSelection(GPT_5_4_FAST_MODEL_LABEL)).toBe(false);
    expect(DEFAULT_CODEX_MODEL).toBe(GPT_5_6_SOL_MODEL);
    expect(isRecommendedCodexModelSelection(DEFAULT_CODEX_MODEL)).toBe(true);
  });

  it("exposes xhigh for Codex models that document it", () => {
    expect(getReasoningEffortChoicesForModel(GPT_5_6_SOL_MODEL)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getReasoningEffortChoicesForModel(GPT_5_6_TERRA_MODEL)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getReasoningEffortChoicesForModel(GPT_5_6_LUNA_MODEL)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getReasoningEffortChoicesForModel("gpt-5.3-codex")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getReasoningEffortChoicesForModel("gpt-5.2-codex")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getReasoningEffortChoicesForModel("gpt-5.1-codex")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("uses conservative effort subsets for general and preview models", () => {
    expect(getReasoningEffortChoicesForModel("gpt-5.4")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getReasoningEffortChoicesForModel("gpt-5.3-codex-spark")).toEqual(["low", "medium", "high"]);
    expect(getReasoningEffortChoicesForModel("gpt-5.2")).toEqual(["low", "medium", "high"]);
    expect(getReasoningEffortChoicesForModel("gpt-5")).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("normalizes invalid reasoning effort to a supported default", () => {
    expect(normalizeReasoningEffortForModel("gpt-5.2", "xhigh")).toBe("medium");
    expect(normalizeReasoningEffortForModel("gpt-5.3-codex", "minimal")).toBe("medium");
    expect(normalizeReasoningEffortForModel("gpt-5", "xhigh")).toBe("medium");
  });
});
