import { describe, expect, it } from "vitest";

import {
  buildTopicDiscoveryCandidateFamilySignature,
  normalizeTopicDiscoveryCandidateTerms,
  normalizeTopicDiscoveryScientificTerms
} from "../src/core/topicDiscoveryScientificTerms.js";

describe("topic-discovery scientific term semantics", () => {
  it("keeps contextual equivalence out of scientific fingerprints", () => {
    expect(normalizeTopicDiscoveryScientificTerms("detection limit")).toEqual([
      "detection",
      "limit"
    ]);
    expect(normalizeTopicDiscoveryScientificTerms("limited sample")).toEqual([
      "limit",
      "sample"
    ]);
    expect(normalizeTopicDiscoveryScientificTerms("overgeneralization failure"))
      .not.toEqual(normalizeTopicDiscoveryScientificTerms("generalization failure"));
    expect(normalizeTopicDiscoveryScientificTerms("sampling uncertainty"))
      .not.toEqual(normalizeTopicDiscoveryScientificTerms("sample uncertainty"));
  });

  it("canonicalizes limited-sample only inside candidate recall", () => {
    for (const value of [
      "limited sample uncertainty",
      "limited-samples uncertainty",
      "sample-limited uncertainty",
      "samples-limited uncertainty",
      "finite samples uncertainty"
    ]) {
      expect(normalizeTopicDiscoveryCandidateTerms(value)).toEqual([
        "finite",
        "sample",
        "uncertainty"
      ]);
    }
    expect(normalizeTopicDiscoveryCandidateTerms("limited budget uncertainty")).toEqual([
      "limit",
      "budget",
      "uncertainty"
    ]);
    expect(normalizeTopicDiscoveryCandidateTerms("detection limit")).toEqual([
      "detection",
      "limit"
    ]);
    expect(
      normalizeTopicDiscoveryCandidateTerms("detection limit for sample concentration")
    ).toEqual(["detection", "limit", "sample", "concentration"]);
    expect(
      normalizeTopicDiscoveryCandidateTerms("sample size limited by budget")
    ).toEqual(["sample", "size", "limit", "budget"]);
  });

  it("assigns one family signature to finite-sample surface variants", () => {
    const finite = buildTopicDiscoveryCandidateFamilySignature({
      sharedAnchorTerms: ["model", "evaluation"],
      axisTerms: ["finite", "sample", "uncertainty"]
    });
    const limited = buildTopicDiscoveryCandidateFamilySignature({
      sharedAnchorTerms: ["evaluation", "model"],
      axisTerms: ["limited", "sample", "uncertainty"]
    });
    const sampleLimited = buildTopicDiscoveryCandidateFamilySignature({
      sharedAnchorTerms: ["model", "evaluation"],
      axisTerms: ["sample", "limited", "uncertainty"]
    });

    expect(limited).toBe(finite);
    expect(sampleLimited).toBe(finite);
  });
});
