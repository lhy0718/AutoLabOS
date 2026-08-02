import { describe, expect, it } from "vitest";

import {
  assessTopicDiscoveryProviderCoverage,
  TOPIC_DISCOVERY_PROVIDER_COVERAGE_VERSION
} from "../src/core/collection/topicDiscoveryProviderCoverage.js";
import type {
  PaperSearchProvider,
  PaperSearchProviderDiagnostics
} from "../src/core/collection/types.js";

function diagnostic(
  provider: PaperSearchProvider,
  input: { fetched?: number; error?: string } = {}
): PaperSearchProviderDiagnostics {
  return {
    provider,
    query: "configured research object comparative reliability",
    fetched: input.fetched ?? 0,
    attemptCount: 1,
    attempts: [],
    ...(input.error ? { error: input.error } : {})
  };
}

describe("topic-discovery provider coverage", () => {
  it("marks coverage degraded when half of a four-provider portfolio is unavailable throughout", () => {
    const audit = assessTopicDiscoveryProviderCoverage([
      diagnostic("semantic_scholar", { error: "rate limited" }),
      diagnostic("openalex", { error: "rate limited" }),
      diagnostic("crossref", { fetched: 8 }),
      diagnostic("arxiv", { fetched: 6 }),
      diagnostic("semantic_scholar", { error: "rate limited" }),
      diagnostic("openalex", { error: "rate limited" }),
      diagnostic("crossref", { fetched: 5 }),
      diagnostic("arxiv", { fetched: 4 })
    ]);

    expect(audit).toEqual({
      version: TOPIC_DISCOVERY_PROVIDER_COVERAGE_VERSION,
      status: "degraded",
      configured_provider_count: 4,
      unavailable_provider_count: 2,
      available_providers: ["arxiv", "crossref"],
      unavailable_providers: ["openalex", "semantic_scholar"],
      observations_by_provider: {
        arxiv: 2,
        crossref: 2,
        openalex: 2,
        semantic_scholar: 2
      }
    });
  });

  it("keeps fallback coverage available for a single-provider outage", () => {
    const audit = assessTopicDiscoveryProviderCoverage([
      diagnostic("semantic_scholar", { error: "temporarily unavailable" }),
      diagnostic("openalex", { fetched: 0 }),
      diagnostic("crossref", { fetched: 3 }),
      diagnostic("arxiv", { fetched: 2 })
    ]);

    expect(audit.status).toBe("available");
    expect(audit.unavailable_providers).toEqual(["semantic_scholar"]);
  });

  it("does not call a valid empty response unavailable", () => {
    const audit = assessTopicDiscoveryProviderCoverage([
      diagnostic("semantic_scholar", { fetched: 0 }),
      diagnostic("openalex", { fetched: 0 }),
      diagnostic("crossref", { fetched: 0 }),
      diagnostic("arxiv", { fetched: 0 })
    ]);

    expect(audit.status).toBe("available");
    expect(audit.unavailable_providers).toEqual([]);
  });
});
