import { describe, expect, it } from "vitest";

import {
  buildTopicDiscoveryCandidateFamilySignature,
  countTopicDiscoveryCandidateTitleSupport,
  normalizeTopicDiscoveryCandidateObjectTerms,
  normalizeTopicDiscoveryCandidateTerms,
  normalizeTopicDiscoveryScientificObjectTerms,
  normalizeTopicDiscoveryScientificTerms,
  resolveTopicDiscoveryRequiredAxisMatches
} from "../src/core/topicDiscoveryScientificTerms.js";

describe("topic-discovery scientific term semantics", () => {
  it("normalizes automatic-process derivations to one scientific term", () => {
    for (const variant of ["automatic", "automated", "automation", "automating"]) {
      expect(normalizeTopicDiscoveryScientificTerms(variant)).toEqual(["automat"]);
      expect(normalizeTopicDiscoveryCandidateTerms(variant)).toEqual(["automat"]);
    }
  });

  it("normalizes generation derivations to one scientific term", () => {
    for (const variant of ["generate", "generated", "generative", "generation"]) {
      expect(normalizeTopicDiscoveryScientificTerms(variant)).toEqual(["generation"]);
      expect(normalizeTopicDiscoveryCandidateTerms(variant)).toEqual(["generation"]);
    }
  });

  it("expands common agent-literature surface forms for candidate recall only", () => {
    expect(normalizeTopicDiscoveryCandidateObjectTerms("LLM agents and agentic LLMs"))
      .toEqual(["language", "model", "agent", "agent", "language", "model"]);
    expect(normalizeTopicDiscoveryScientificObjectTerms("LLM agents"))
      .toEqual(["llm", "agent"]);
  });

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

  it("preserves compositional paper-review terms only in object-aware normalization", () => {
    expect(normalizeTopicDiscoveryScientificTerms("scientific paper review"))
      .toEqual(["scientific"]);
    expect(normalizeTopicDiscoveryScientificObjectTerms("scientific paper review"))
      .toEqual(["scientific", "paper", "review"]);
    expect(normalizeTopicDiscoveryCandidateObjectTerms(
      "Paper review limited-sample uncertainty"
    )).toEqual(["paper", "review", "finite", "sample", "uncertainty"]);
    expect(JSON.parse(buildTopicDiscoveryCandidateFamilySignature({
      sharedAnchorTerms: ["paper", "review"],
      axisTerms: ["defect", "localization"]
    }))).toEqual({
      sharedAnchorTerms: ["paper", "review"],
      axisTerms: ["defect", "localization"]
    });
  });

  it("preserves an interior scientific compound token without promoting generic prefixes", () => {
    expect(normalizeTopicDiscoveryScientificTerms("automated research workflows"))
      .toEqual(["automat", "workflow"]);
    expect(normalizeTopicDiscoveryScientificObjectTerms("automated research workflows"))
      .toEqual(["automat", "research", "workflow"]);
    expect(normalizeTopicDiscoveryCandidateObjectTerms("automated research workflows"))
      .toEqual(["automat", "research", "workflow"]);
    expect(normalizeTopicDiscoveryScientificObjectTerms("research paper"))
      .toEqual(["paper"]);
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

  it("uses the bounded two-thirds axis floor for candidate-title support", () => {
    expect(resolveTopicDiscoveryRequiredAxisMatches(["error"])).toBe(1);
    expect(resolveTopicDiscoveryRequiredAxisMatches(["trajectory", "error"])).toBe(2);
    expect(resolveTopicDiscoveryRequiredAxisMatches([
      "trajectory",
      "error",
      "detection"
    ])).toBe(2);
    expect(resolveTopicDiscoveryRequiredAxisMatches([
      "trajectory",
      "error",
      "detection",
      "localization"
    ])).toBe(3);

    expect(countTopicDiscoveryCandidateTitleSupport(
      ["trajectory", "error", "detection"],
      [
        "Trajectory error analysis for structured evaluation",
        "Error detection through bounded traces",
        "ERROR DETECTION through bounded traces",
        "Detection-only baseline",
        "Error detection through bounded traces"
      ]
    )).toBe(2);
  });
});
