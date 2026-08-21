import { describe, expect, it } from "vitest";

import { parseCollectArgs, tokenizeQuotedArgs, validateCollectRequest } from "../src/core/commands/collectOptions.js";

describe("collectOptions", () => {
  it("parses query and core options", () => {
    const parsed = parseCollectArgs([
      "agentic",
      "workflows",
      "--limit",
      "100",
      "--last-years",
      "5",
      "--sort",
      "relevance",
      "--open-access",
      "--bibtex",
      "hybrid"
    ]);

    expect(parsed.ok).toBe(true);
    expect(parsed.request?.query).toBe("agentic workflows");
    expect(parsed.request?.limit).toBe(100);
    expect(parsed.request?.filters.lastYears).toBe(5);
    expect(parsed.request?.filters.openAccessPdf).toBe(true);
    expect(parsed.request?.bibtexMode).toBe("hybrid");
  });

  it("rejects mutually exclusive limit/additional", () => {
    const parsed = parseCollectArgs(["--limit", "100", "--additional", "20"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((x) => x.includes("--limit and --additional"))).toBe(true);
  });

  it("applies precedence date-range > year > last-years", () => {
    const parsed = parseCollectArgs(["--last-years", "5", "--year", "2020-2024", "--date-range", "2021-01-01:"]);
    expect(parsed.ok).toBe(true);
    expect(parsed.request?.filters.dateRange).toBe("2021-01-01:");
    expect(parsed.request?.filters.year).toBeUndefined();
    expect(parsed.request?.filters.lastYears).toBeUndefined();
    expect(parsed.request?.warnings.length).toBeGreaterThan(0);
  });

  it("tokenizes quoted option values", () => {
    const tokens = tokenizeQuotedArgs('graph agents --venue "New England Journal of Medicine,Nature"');
    expect(tokens).toEqual(["graph", "agents", "--venue", "New England Journal of Medicine,Nature"]);
  });

  it("validates year/date specs", () => {
    const parsed = parseCollectArgs(["--year", "20xx"]);
    expect(parsed.ok).toBe(false);

    const valid = parseCollectArgs(["--date-range", "2020:2024"]);
    expect(valid.ok).toBe(true);
    expect(validateCollectRequest(valid.request!)).toHaveLength(0);
  });
});
