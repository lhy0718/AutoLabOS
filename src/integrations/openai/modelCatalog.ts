export interface OpenAiResponsesModelOption {
  value: string;
  label: string;
  description: string;
}

export interface OpenAiResponsesReasoningOption {
  value: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  label: string;
  description: string;
}

// Official docs basis:
// - GPT-5 and GPT-4.1 / GPT-4o family are documented on developers.openai.com model pages.
// - Responses API supports reasoning controls for supported GPT-5 models.
export const GPT_5_6_SOL_API_MODEL = "gpt-5.6-sol";
export const GPT_5_6_TERRA_API_MODEL = "gpt-5.6-terra";
export const GPT_5_6_LUNA_API_MODEL = "gpt-5.6-luna";
export const DEFAULT_OPENAI_RESPONSES_MODEL = GPT_5_6_SOL_API_MODEL;
export const DEFAULT_OPENAI_RESPONSES_CHAT_MODEL = GPT_5_6_TERRA_API_MODEL;
export const DEFAULT_OPENAI_RESPONSES_REASONING_EFFORT = "medium";

const GPT_5_6_REASONING_OPTIONS: OpenAiResponsesReasoningOption[] = [
  {
    value: "none",
    label: "none",
    description: "No added reasoning effort for the lowest-latency GPT-5.6 API turns."
  },
  {
    value: "low",
    label: "low",
    description: "Fast, lower-cost reasoning for simple structured tasks."
  },
  {
    value: "medium",
    label: "medium",
    description: "Balanced default for general workflow tasks."
  },
  {
    value: "high",
    label: "high",
    description: "Deeper reasoning for complex research and implementation work."
  },
  {
    value: "xhigh",
    label: "xhigh",
    description: "Extra-high reasoning for difficult review and adjudication work."
  },
  {
    value: "max",
    label: "max",
    description: "Maximum API reasoning for exceptional quality-first tasks."
  }
];

export const OPENAI_RESPONSES_REASONING_OPTIONS: OpenAiResponsesReasoningOption[] = [
  {
    value: "minimal",
    label: "minimal",
    description: "Lowest reasoning effort for the fastest GPT-5 API turns."
  },
  {
    value: "low",
    label: "low",
    description: "Fast, lower-cost reasoning for simple structured tasks."
  },
  {
    value: "medium",
    label: "medium",
    description: "Balanced default for general workflow tasks."
  },
  {
    value: "high",
    label: "high",
    description: "Deeper reasoning when extraction quality matters more than latency."
  },
  {
    value: "xhigh",
    label: "xhigh",
    description: "Maximum reasoning effort for the hardest GPT-5 API turns."
  }
];

export const OPENAI_RESPONSES_MODEL_OPTIONS: OpenAiResponsesModelOption[] = [
  {
    value: GPT_5_6_SOL_API_MODEL,
    label: "gpt-5.6-sol",
    description: "Flagship GPT-5.6 model for complex research, coding, and polished writing."
  },
  {
    value: GPT_5_6_TERRA_API_MODEL,
    label: "gpt-5.6-terra",
    description: "Balanced GPT-5.6 model for everyday agent work at lower cost."
  },
  {
    value: GPT_5_6_LUNA_API_MODEL,
    label: "gpt-5.6-luna",
    description: "Fast GPT-5.6 model for clear, repeatable, high-volume tasks."
  },
  {
    value: "gpt-5.5",
    label: "gpt-5.5",
    description: "Previous-generation frontier model retained for compatibility."
  },
  {
    value: "gpt-5.4",
    label: "gpt-5.4",
    description: "Previous professional-work model retained for compatibility."
  },
  {
    value: "gpt-5",
    label: "gpt-5",
    description: "Balanced GPT-5 choice for general workflow tasks."
  },
  {
    value: "gpt-5-mini",
    label: "gpt-5-mini",
    description: "Fast, lower-cost GPT-5 option for lighter workflow turns."
  },
  {
    value: "gpt-4.1",
    label: "gpt-4.1",
    description: "Strong instruction-following model for structured extraction and analysis."
  },
  {
    value: "gpt-4o",
    label: "gpt-4o",
    description: "Strong multimodal model for mixed text and document tasks."
  },
  {
    value: "gpt-4o-mini",
    label: "gpt-4o-mini",
    description: "Fast, affordable multimodal option when latency matters."
  }
];

const OPENAI_RESPONSES_MODEL_SET = new Set(
  OPENAI_RESPONSES_MODEL_OPTIONS.map((option) => option.value)
);

export function buildOpenAiResponsesModelChoices(): string[] {
  return OPENAI_RESPONSES_MODEL_OPTIONS.map((option) => option.value);
}

export function buildOpenAiResponsesReasoningChoices(model: string): string[] {
  return getOpenAiResponsesReasoningOptions(model).map((option) => option.value);
}

export function getOpenAiResponsesReasoningOptions(
  model: string
): OpenAiResponsesReasoningOption[] {
  const normalizedModel = normalizeOpenAiResponsesModel(model);
  if (isGpt56Model(normalizedModel)) {
    return GPT_5_6_REASONING_OPTIONS;
  }
  if (supportsOpenAiResponsesReasoning(normalizedModel)) {
    return OPENAI_RESPONSES_REASONING_OPTIONS;
  }
  return OPENAI_RESPONSES_REASONING_OPTIONS.filter(
    (option) => option.value === DEFAULT_OPENAI_RESPONSES_REASONING_EFFORT
  );
}

export function getOpenAiResponsesModelDescription(model: string): string {
  return (
    OPENAI_RESPONSES_MODEL_OPTIONS.find((option) => option.value === model)?.description ||
    "OpenAI Responses API model."
  );
}

export function normalizeOpenAiResponsesModel(model: unknown): string {
  if (typeof model !== "string") {
    return DEFAULT_OPENAI_RESPONSES_MODEL;
  }
  const normalized = model.trim();
  if (!normalized) {
    return DEFAULT_OPENAI_RESPONSES_MODEL;
  }
  return OPENAI_RESPONSES_MODEL_SET.has(normalized)
    ? normalized
    : DEFAULT_OPENAI_RESPONSES_MODEL;
}

export function normalizeOpenAiResponsesReasoningEffort(model: unknown, effort: unknown): string {
  const normalizedModel = normalizeOpenAiResponsesModel(model);
  if (!supportsOpenAiResponsesReasoning(normalizedModel)) {
    return DEFAULT_OPENAI_RESPONSES_REASONING_EFFORT;
  }
  if (typeof effort !== "string") {
    return DEFAULT_OPENAI_RESPONSES_REASONING_EFFORT;
  }
  const normalized = effort.trim().toLowerCase();
  const supported = getOpenAiResponsesReasoningOptions(normalizedModel).map((option) => option.value);
  if (supported.includes(normalized as OpenAiResponsesReasoningOption["value"])) {
    return normalized;
  }
  return DEFAULT_OPENAI_RESPONSES_REASONING_EFFORT;
}

export function supportsOpenAiResponsesReasoning(model: string): boolean {
  return normalizeOpenAiResponsesModel(model).startsWith("gpt-5");
}

function isGpt56Model(model: string): boolean {
  return model.startsWith("gpt-5.6");
}
