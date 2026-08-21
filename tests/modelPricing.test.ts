import { describe, expect, it } from "vitest";

import { computeModelUsageCostUsd, resolveModelBilling } from "../src/core/llm/modelPricing.js";
import { OFFICIAL_CODEX_MODELS } from "../src/integrations/codex/modelCatalog.js";
import { OPENAI_RESPONSES_MODEL_OPTIONS } from "../src/integrations/openai/modelCatalog.js";
const UNPRICED_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
  "gpt-5-codex-mini"
]);

describe("modelPricing", () => {
  it("covers every configured OpenAI Responses model with an explicit billing state", () => {
    for (const option of OPENAI_RESPONSES_MODEL_OPTIONS) {
      const resolved = resolveModelBilling(option.value);
      expect(resolved?.modelId).toBe(option.value);
      expect(resolved?.billing.kind).toBe(UNPRICED_MODELS.has(option.value) ? "unpriced" : "token");
    }
  });

  it("covers configured Codex models with explicit billing states", () => {
    for (const model of OFFICIAL_CODEX_MODELS) {
      expect(resolveModelBilling(model)).toMatchObject({
        modelId: model,
        billing: { kind: UNPRICED_MODELS.has(model) ? "unpriced" : "token" }
      });
    }
  });

  it("uses provider context rather than a static model catalog for Ollama billing", () => {
    const model = "local-model-a:latest";
    expect(resolveModelBilling(model)).toBeUndefined();
    expect(resolveModelBilling(model, { provider: "ollama" })).toMatchObject({
      modelId: model,
      billing: { kind: "local" }
    });
    expect(
      computeModelUsageCostUsd(
        model,
        { inputTokens: 100_000, outputTokens: 50_000 },
        { provider: "ollama" }
      )
    ).toBe(0);
  });

  it("computes costs for snapshot and provider-prefixed model ids", () => {
    expect(
      computeModelUsageCostUsd("openai/gpt-4o-2024-08-06", {
        inputTokens: 1_000,
        outputTokens: 2_000
      })
    ).toBe(0.0225);
    expect(
      computeModelUsageCostUsd("gpt-5.4-20260305", {
        inputTokens: 200_000,
        outputTokens: 50_000
      })
    ).toBe(1.25);
  });

  it("refuses to invent costs for known but unpriced models", () => {
    expect(
      computeModelUsageCostUsd("gpt-5.3-codex-spark", {
        inputTokens: 1_000,
        outputTokens: 2_000
      })
    ).toBeUndefined();
  });
});
