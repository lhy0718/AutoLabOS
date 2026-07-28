import { describe, expect, it } from "vitest";

import type { PaperSearchCandidate } from "../src/core/collection/types.js";
import { filterPaperSearchCandidates } from "../src/tools/paperSearchCommon.js";

describe("paper search candidate ordering", () => {
  it.each([
    {
      domain: "materials science",
      filters: { year: "2024" },
      candidates: [
        paper("materials-provider-first", "Porous transport measurements", 4, {
          year: 2024
        }),
        paper("materials-filtered", "Archived alloy measurements", 900, {
          year: 2021
        }),
        paper("materials-provider-second", "Composite interface measurements", 320, {
          year: 2024
        })
      ],
      expectedIds: ["materials-provider-first", "materials-provider-second"]
    },
    {
      domain: "ecological forecasting",
      filters: { venue: ["Ecology Letters"] },
      candidates: [
        paper("ecology-provider-first", "Seasonal habitat forecasts", 7, {
          venue: "Ecology Letters"
        }),
        paper("ecology-filtered", "Urban mobility forecasts", 700, {
          venue: "Transport Review"
        }),
        paper("ecology-provider-second", "Coastal population forecasts", 260, {
          venue: "Ecology Letters"
        })
      ],
      expectedIds: ["ecology-provider-first", "ecology-provider-second"]
    }
  ])("preserves provider relevance order after filtering $domain papers", ({ candidates, expectedIds, filters }) => {
    const filtered = filterPaperSearchCandidates(
      {
        query: "neutral topic query",
        limit: candidates.length,
        sort: { field: "relevance", order: "desc" },
        filters
      },
      candidates
    );

    expect(filtered.map((candidate) => candidate.providerId)).toEqual(expectedIds);
  });

  it("retains citation reranking for an explicit citation-count sort", () => {
    const filtered = filterPaperSearchCandidates(
      {
        query: "general paper query",
        limit: 2,
        sort: { field: "citationCount", order: "desc" }
      },
      [
        paper("lower-citation-paper", "Initial measurement study", 5),
        paper("higher-citation-paper", "Follow-up measurement study", 50)
      ]
    );

    expect(filtered.map((candidate) => candidate.providerId)).toEqual([
      "higher-citation-paper",
      "lower-citation-paper"
    ]);
  });
});

function paper(
  providerId: string,
  title: string,
  citationCount: number,
  overrides: Partial<PaperSearchCandidate> = {}
): PaperSearchCandidate {
  return {
    provider: "openalex",
    providerId,
    title,
    authors: [],
    citationCount,
    ...overrides
  };
}
