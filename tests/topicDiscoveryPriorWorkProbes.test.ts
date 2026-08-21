import { describe, expect, it, vi } from "vitest";

import type { SearchProviderClient } from "../src/core/collection/searchAggregation.js";
import {
  buildTopicDiscoveryPriorWorkProbePlan,
  buildTopicDiscoveryPriorWorkProbePlanningHints,
  runTopicDiscoveryPriorWorkProbes
} from "../src/core/collection/topicDiscoveryPriorWorkProbes.js";
import { buildTopicDiscoveryScopeContract } from "../src/core/topicDiscoveryScopeContract.js";

function buildBrief(priorWorkProbes: string[]): string {
  return [
    "# Research Brief",
    "",
    "## Research Mode",
    "topic_discovery",
    "",
    "## Scientific Scope",
    "### Scientific Object",
    "- document review evidence",
    "",
    "### Empirical Problems",
    "- defect localization under incomplete records",
    "- revision consistency across reviewer rounds",
    "",
    "### Prior-Work Probes",
    ...priorWorkProbes.map((probe) => `- ${probe}`)
  ].join("\n");
}

describe("topic-discovery prior-work probes", () => {
  it("requires a substantive probe and preserves queryable surface terms", () => {
    const contract = buildTopicDiscoveryScopeContract(buildBrief([
      "whether direct prior work already subsumes the declared problems",
      "automatic reviewers detect faulty reasoning",
      "grounded revision verification in peer-review records"
    ]));

    const plan = buildTopicDiscoveryPriorWorkProbePlan(contract);

    expect(plan.map((probe) => probe.query)).toEqual([
      "automatic reviewers detect faulty reasoning",
      "grounded revision verification peer-review records"
    ]);
    expect(plan.every((probe) => probe.source_terms.length >= 2)).toBe(true);
  });

  it("keeps bounded probe results outside paper evidence and returns planning hints", async () => {
    const provider: SearchProviderClient = {
      provider: "semantic_scholar",
      searchPapers: vi.fn(async (request) => [
        {
          provider: "semantic_scholar",
          providerId: `provider-${request.query}`,
          paperId: `paper-${request.query}`,
          title: request.query.includes("automatic")
            ? "Automatic Reviewers for Detecting Faulty Reasoning"
            : "Grounded Revision Verification over Review Records",
          abstract: "This abstract is provider material and must not become a planning-hint payload.",
          year: 2025,
          authors: ["Fixture Author"],
          citationCount: 5
        },
        {
          provider: "semantic_scholar",
          providerId: `future-${request.query}`,
          paperId: `future-paper-${request.query}`,
          title: "Future Metadata Result",
          year: 2027,
          authors: []
        }
      ]),
      getLastSearchDiagnostics: () => ({
        provider: "semantic_scholar",
        query: "fixture query",
        fetched: 2,
        attemptCount: 1,
        attempts: [{
          provider: "semantic_scholar",
          attempt: 1,
          ok: true,
          status: 200,
          endpoint: "fixture"
        }]
      })
    };
    const contract = buildTopicDiscoveryScopeContract(buildBrief([
      "automatic reviewers detect faulty reasoning",
      "grounded revision verification in peer-review records"
    ]));

    const receipt = await runTopicDiscoveryPriorWorkProbes({
      contract,
      providers: [provider],
      asOfDate: "2026-08-02",
      generatedAt: "2026-08-02T00:00:00.000Z"
    });
    const hints = buildTopicDiscoveryPriorWorkProbePlanningHints(receipt);

    expect(receipt).toMatchObject({
      status: "complete",
      evidence_status: "query_hint_only",
      paper_evidence_allowed: false,
      planned_probe_count: 2,
      executed_probe_count: 2
    });
    expect(receipt.candidate_titles).toEqual([
      "Automatic Reviewers for Detecting Faulty Reasoning",
      "Grounded Revision Verification over Review Records"
    ]);
    expect(JSON.stringify(hints)).not.toContain("provider material");
    expect(hints).toHaveLength(2);
    expect(provider.searchPapers).toHaveBeenCalledTimes(2);
  });
});
