import { describe, expect, it } from "vitest";

import {
  OFFICIAL_CODEX_MODELS,
  getReasoningEffortChoicesForModel,
  normalizeReasoningEffortForModel
} from "../src/integrations/codex/modelCatalog.js";

describe("modelCatalog", () => {
  it("matches the official Codex model list and excludes removed entries", () => {
    expect(OFFICIAL_CODEX_MODELS).toContain("gpt-5.4");
    expect(OFFICIAL_CODEX_MODELS).toContain("gpt-5.3-codex-spark");
    expect(OFFICIAL_CODEX_MODELS).toContain("gpt-5.2");
    expect(OFFICIAL_CODEX_MODELS).toContain("gpt-5-codex-mini");
    expect(OFFICIAL_CODEX_MODELS).not.toContain("gpt-5.1-codex-mini");
  });

  it("exposes xhigh for Codex models that document it", () => {
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
