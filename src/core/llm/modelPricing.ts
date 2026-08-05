export interface TokenPricedModelBilling {
  kind: "token";
  inputUsdPer1MTokens: number;
  outputUsdPer1MTokens: number;
}

export interface LocalModelBilling {
  kind: "local";
}

export interface UnpricedModelBilling {
  kind: "unpriced";
  reason: string;
}

export type ModelBilling = TokenPricedModelBilling | LocalModelBilling | UnpricedModelBilling;

export interface ResolvedModelBilling {
  modelId: string;
  billing: ModelBilling;
}

export interface ModelBillingContext {
  provider?: "codex" | "openai" | "ollama";
}

const TOKEN_PRICED_MODELS: Record<string, TokenPricedModelBilling> = {
  // OpenAI Responses family.
  "gpt-5.5": { kind: "token", inputUsdPer1MTokens: 2.5, outputUsdPer1MTokens: 15 },
  "gpt-5.4": { kind: "token", inputUsdPer1MTokens: 2.5, outputUsdPer1MTokens: 15 },
  "gpt-5": { kind: "token", inputUsdPer1MTokens: 1.25, outputUsdPer1MTokens: 10 },
  "gpt-5-mini": { kind: "token", inputUsdPer1MTokens: 0.25, outputUsdPer1MTokens: 2 },
  "gpt-4.1": { kind: "token", inputUsdPer1MTokens: 2, outputUsdPer1MTokens: 8 },
  "gpt-4o": { kind: "token", inputUsdPer1MTokens: 2.5, outputUsdPer1MTokens: 10 },
  "gpt-4o-mini": { kind: "token", inputUsdPer1MTokens: 0.15, outputUsdPer1MTokens: 0.6 },

  // Codex / coding-oriented GPT family where token pricing is publicly exposed.
  "gpt-5.3-codex": { kind: "token", inputUsdPer1MTokens: 1.75, outputUsdPer1MTokens: 14 },
  "gpt-5.2": { kind: "token", inputUsdPer1MTokens: 1.75, outputUsdPer1MTokens: 14 },
  "gpt-5.2-codex": { kind: "token", inputUsdPer1MTokens: 1.75, outputUsdPer1MTokens: 14 },
  "gpt-5.1": { kind: "token", inputUsdPer1MTokens: 1.25, outputUsdPer1MTokens: 10 },
  "gpt-5.1-codex": { kind: "token", inputUsdPer1MTokens: 1.25, outputUsdPer1MTokens: 10 },
  "gpt-5.1-codex-max": { kind: "token", inputUsdPer1MTokens: 1.25, outputUsdPer1MTokens: 10 },
  "gpt-5-codex": { kind: "token", inputUsdPer1MTokens: 1.25, outputUsdPer1MTokens: 10 }
};

const UNPRICED_MODELS: Record<string, UnpricedModelBilling> = {
  "gpt-5.6-sol": {
    kind: "unpriced",
    reason: "The verified Codex credit rate is not an OpenAI API USD token price."
  },
  "gpt-5.6-terra": {
    kind: "unpriced",
    reason: "The verified Codex credit rate is not an OpenAI API USD token price."
  },
  "gpt-5.6-luna": {
    kind: "unpriced",
    reason: "The verified Codex credit rate is not an OpenAI API USD token price."
  },
  "gpt-5.4-mini": {
    kind: "unpriced",
    reason: "No verified OpenAI API USD token rate is recorded for this Codex compatibility model."
  },
  "gpt-5.3-codex-spark": {
    kind: "unpriced",
    reason: "No verifiable token-priced public rate was available from accessible sources."
  },
  "gpt-5-codex-mini": {
    kind: "unpriced",
    reason: "No verifiable token-priced public rate was available from accessible sources."
  }
};

const KNOWN_MODEL_IDS = [
  ...Object.keys(TOKEN_PRICED_MODELS),
  ...Object.keys(UNPRICED_MODELS)
].sort((left, right) => right.length - left.length);

export function resolveModelBilling(
  model: string | undefined,
  context: ModelBillingContext = {}
): ResolvedModelBilling | undefined {
  const normalized = normalizeModelForBilling(model);
  if (!normalized) {
    return undefined;
  }

  if (context.provider === "ollama") {
    return {
      modelId: normalized,
      billing: { kind: "local" }
    };
  }

  if (TOKEN_PRICED_MODELS[normalized]) {
    return {
      modelId: normalized,
      billing: TOKEN_PRICED_MODELS[normalized]
    };
  }

  if (UNPRICED_MODELS[normalized]) {
    return {
      modelId: normalized,
      billing: UNPRICED_MODELS[normalized]
    };
  }

  for (const candidate of KNOWN_MODEL_IDS) {
    if (!isSnapshotAliasOfModel(normalized, candidate)) {
      continue;
    }

    if (TOKEN_PRICED_MODELS[candidate]) {
      return {
        modelId: candidate,
        billing: TOKEN_PRICED_MODELS[candidate]
      };
    }

    if (UNPRICED_MODELS[candidate]) {
      return {
        modelId: candidate,
        billing: UNPRICED_MODELS[candidate]
      };
    }
  }

  return undefined;
}

export function computeModelUsageCostUsd(
  model: string | undefined,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
  },
  context: ModelBillingContext = {}
): number | undefined {
  const resolved = resolveModelBilling(model, context);
  if (!resolved) {
    return undefined;
  }

  if (resolved.billing.kind === "local") {
    return 0;
  }

  if (resolved.billing.kind === "unpriced") {
    return undefined;
  }

  const inputTokens = sanitizeTokenCount(usage.inputTokens) ?? 0;
  const outputTokens = sanitizeTokenCount(usage.outputTokens) ?? 0;
  if (inputTokens === 0 && outputTokens === 0) {
    return undefined;
  }

  return (
    (inputTokens * resolved.billing.inputUsdPer1MTokens +
      outputTokens * resolved.billing.outputUsdPer1MTokens) /
    1_000_000
  );
}

function normalizeModelForBilling(model: string | undefined): string | undefined {
  if (typeof model !== "string") {
    return undefined;
  }

  const trimmed = model.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/^openai\//u, "");
}

function isSnapshotAliasOfModel(model: string, candidate: string): boolean {
  if (!model.startsWith(candidate)) {
    return false;
  }

  const remainder = model.slice(candidate.length);
  if (!remainder.startsWith("-")) {
    return false;
  }

  return /\d/u.test(remainder[1] || "");
}

function sanitizeTokenCount(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}
