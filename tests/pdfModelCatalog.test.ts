import { describe, expect, it } from "vitest";

import {
  DEFAULT_RESPONSES_PDF_MODEL,
  RESPONSES_PDF_MODEL_OPTIONS,
  buildResponsesPdfModelChoices,
  getResponsesPdfModelDescription,
  normalizeResponsesPdfModel
} from "../src/integrations/openai/pdfModelCatalog.js";

describe("pdfModelCatalog", () => {
  it("exposes stable Responses API PDF model choices", () => {
    expect(buildResponsesPdfModelChoices()).toEqual(
      RESPONSES_PDF_MODEL_OPTIONS.map((option) => option.value)
    );
    expect(buildResponsesPdfModelChoices()).toContain("gpt-5.4");
    expect(buildResponsesPdfModelChoices()).toContain("gpt-4o");
    expect(buildResponsesPdfModelChoices()).toContain("gpt-4o-mini");
  });

  it("returns readable descriptions", () => {
    expect(getResponsesPdfModelDescription("gpt-5.4")).toContain("Highest-quality");
    expect(getResponsesPdfModelDescription("gpt-5-mini")).toContain("lowest-cost");
    expect(getResponsesPdfModelDescription("gpt-4o")).toContain("text and image support");
  });

  it("falls back to the default model for unknown input", () => {
    expect(normalizeResponsesPdfModel("")).toBe(DEFAULT_RESPONSES_PDF_MODEL);
    expect(normalizeResponsesPdfModel("unknown-model")).toBe(DEFAULT_RESPONSES_PDF_MODEL);
    expect(normalizeResponsesPdfModel(undefined)).toBe(DEFAULT_RESPONSES_PDF_MODEL);
  });
});
