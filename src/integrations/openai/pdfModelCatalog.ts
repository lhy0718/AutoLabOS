export interface ResponsesPdfModelOption {
  value: string;
  label: string;
  description: string;
}

// Official docs basis:
// - File inputs guide: PDF parsing with page images requires vision-capable models such as gpt-4o and later.
// - gpt-4o / gpt-4o-mini model pages explicitly accept text and image inputs.
// - GPT-4.1 is referenced in official cookbook examples as a vision OCR model.
// - GPT-5.4 prompt guidance includes vision/image-detail guidance; GPT-5 family is "later" than gpt-4o.
export const DEFAULT_RESPONSES_PDF_MODEL = "gpt-5.4";

export const RESPONSES_PDF_MODEL_OPTIONS: ResponsesPdfModelOption[] = [
  {
    value: "gpt-5.4",
    label: "gpt-5.4",
    description: "Highest-quality default for complex PDF reasoning. Usually the slowest option here."
  },
  {
    value: "gpt-5",
    label: "gpt-5",
    description: "Balanced GPT-5 choice for multimodal PDF analysis."
  },
  {
    value: "gpt-5-mini",
    label: "gpt-5-mini",
    description: "Fastest, lowest-cost GPT-5 option for lighter PDF extraction and analysis."
  },
  {
    value: "gpt-4.1",
    label: "gpt-4.1",
    description: "Strong OCR and document-analysis choice used in official document workflows."
  },
  {
    value: "gpt-4o",
    label: "gpt-4o",
    description: "Strong multimodal PDF model with explicit text and image support."
  },
  {
    value: "gpt-4o-mini",
    label: "gpt-4o-mini",
    description: "Fast, lower-cost multimodal option when latency and cost matter."
  }
];

const RESPONSES_PDF_MODEL_SET = new Set(
  RESPONSES_PDF_MODEL_OPTIONS.map((option) => option.value)
);

export function buildResponsesPdfModelChoices(): string[] {
  return RESPONSES_PDF_MODEL_OPTIONS.map((option) => option.value);
}

export function getResponsesPdfModelDescription(model: string): string {
  return (
    RESPONSES_PDF_MODEL_OPTIONS.find((option) => option.value === model)?.description ||
    "Responses API PDF analysis model."
  );
}

export function normalizeResponsesPdfModel(model: unknown): string {
  if (typeof model !== "string") {
    return DEFAULT_RESPONSES_PDF_MODEL;
  }
  const normalized = model.trim();
  if (!normalized) {
    return DEFAULT_RESPONSES_PDF_MODEL;
  }
  return RESPONSES_PDF_MODEL_SET.has(normalized)
    ? normalized
    : DEFAULT_RESPONSES_PDF_MODEL;
}
