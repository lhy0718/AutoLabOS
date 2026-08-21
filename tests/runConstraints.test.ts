import { describe, expect, it } from "vitest";

import {
  buildTopicDiscoveryLiteratureQuery,
  buildLiteratureQueryCandidates,
  extractLiteratureQueryPositiveTerms,
  isSubstantiveTopicDiscoveryAxisTerm,
  normalizeTopicDiscoveryLiteratureQuery,
  normalizeConstraintProfile,
  selectIndependentLiteratureQueries
} from "../src/core/runConstraints.js";

describe("normalizeConstraintProfile", () => {
  it("does not treat generic evaluation or benchmark labels as scientific axes", () => {
    expect(isSubstantiveTopicDiscoveryAxisTerm("evaluation")).toBe(false);
    expect(isSubstantiveTopicDiscoveryAxisTerm("benchmarks")).toBe(false);
    expect(isSubstantiveTopicDiscoveryAxisTerm("uncertainty")).toBe(true);
    expect(isSubstantiveTopicDiscoveryAxisTerm("contamination")).toBe(true);
  });

  it("drops generic publication types inferred from phrases like recent papers", () => {
    const profile = normalizeConstraintProfile(
      {
        source: "llm",
        collect: {
          lastYears: 5,
          publicationTypes: ["paper", "Review", "articles"]
        }
      },
      ["recent papers", "last 5 years"]
    );

    expect(profile.collect.lastYears).toBe(5);
    expect(profile.collect.publicationTypes).toEqual(["Review"]);
  });

  it("keeps only fields of study explicitly named by raw constraints", () => {
    const profile = normalizeConstraintProfile(
      {
        source: "llm",
        collect: {
          fieldsOfStudy: ["Computer Science", "evaluation reliability"]
        }
      },
      ["Restrict the provider taxonomy filter to Computer Science."]
    );

    expect(profile.collect.fieldsOfStudy).toEqual(["Computer Science"]);
  });

  it("builds deterministic topic-derived candidates when llm queries are absent", () => {
    const candidates = buildLiteratureQueryCandidates({
      runTopic: "Acoustic event segmentation under intermittent sensor noise"
    });

    expect(candidates[0]?.reason).toBe("run_topic");
    expect(candidates[0]?.query).toMatch(/^\+"[^"]+" \+"[^"]+"$/u);
    expect(candidates.some((candidate) => candidate.reason === "keyword_anchor")).toBe(true);
  });

  it("prefers an explicit requested query and does not append llm-generated fallbacks", () => {
    const candidates = buildLiteratureQueryCandidates({
      requestedQuery: '"signal segmentation" +baseline',
      runTopic: "Sequence baselines for acoustic event segmentation",
      llmGeneratedQueries: ['"acoustic segmentation" +(baseline | benchmark)']
    });

    expect(candidates).toEqual([{ query: '"signal segmentation" +baseline', reason: "requested_query" }]);
  });

  it("sanitizes llm-generated queries to Semantic Scholar-friendly bulk syntax and prioritizes them", () => {
    const candidates = buildLiteratureQueryCandidates({
      runTopic: "Robust acoustic event segmentation for noisy sensors",
      llmGeneratedQueries: [
        "adaptive acoustic segmentation",
        'title:"acoustic segmentation" AND ("noisy sensors" OR "intermittent sensors") NOT survey'
      ]
    });

    expect(candidates[0]).toEqual({
      query: "adaptive acoustic segmentation",
      reason: "llm_generated"
    });
    expect(candidates).toContainEqual({
      query: '"acoustic segmentation" +("noisy sensors" | "intermittent sensors") -survey',
      reason: "llm_generated"
    });
    expect(candidates).not.toContainEqual({
      query: 'title:"acoustic segmentation" AND ("noisy sensors" OR "intermittent sensors") NOT survey',
      reason: "llm_generated"
    });
  });

  it("builds deterministic phrase bundles for arbitrary research topics", () => {
    const candidates = buildLiteratureQueryCandidates({
      runTopic: "Measure how robust graph encoders behave for sparse networks under perturbation budgets"
    });

    expect(candidates[0]?.reason).toBe("run_topic");
    expect(candidates[0]?.query).toMatch(/^\+"[^"]+" \+"[^"]+"$/u);
    expect(candidates.every((candidate) => !/acoustic segmentation|noisy sensors/iu.test(candidate.query))).toBe(true);

    const contextualTerms = buildLiteratureQueryCandidates({
      runTopic: "Neural search for topic modeling with empirical risk estimation"
    })
      .map((candidate) => candidate.query)
      .join(" ");
    expect(contextualTerms).toContain("neural search");
    expect(contextualTerms).toContain("topic modeling");
    expect(contextualTerms).toContain("empirical risk estimation");
  });

  it("builds deterministic phrase bundles without requiring Latin-only topics", () => {
    const candidates = buildLiteratureQueryCandidates({
      runTopic: "소음 환경의 음향 사건 분할을 위한 강건한 표현 학습"
    });

    expect(candidates[0]?.reason).toBe("run_topic");
    expect(candidates[0]?.query).toMatch(/^\+"[^"]+" \+"[^"]+"$/u);
  });

  it("drops invalid llm-derived collect date filters instead of treating freeform prose as a date range", () => {
    const profile = normalizeConstraintProfile(
      {
        source: "llm",
        collect: {
          dateRange: "recent papers plus core older benchmark/evaluation papers where relevant",
          year: "recent"
        }
      },
      ["Include both recent papers and core older benchmark or evaluation papers where relevant."]
    );

    expect(profile.collect.dateRange).toBeUndefined();
    expect(profile.collect.year).toBeUndefined();
  });

  it("treats exclusion-only query variants as one semantic family", () => {
    const queries = selectIndependentLiteratureQueries([
      '+"document retrieval" +"uncertainty calibration" -clinical',
      '+"document retrieval" +"uncertainty calibration" -survey',
      '+"document retrieval" +"distribution shift"'
    ]);

    expect(queries).toEqual([
      '+"document retrieval" +"uncertainty calibration" -clinical',
      '+"document retrieval" +"distribution shift"'
    ]);
  });

  it("treats a query with only appended meta qualifiers as the same semantic family", () => {
    const queries = selectIndependentLiteratureQueries([
      '+"document retrieval" +"uncertainty calibration" +"limited labels"',
      '+"document retrieval" +"uncertainty calibration" +"limited labels" +"workshop contribution"',
      '+"document retrieval" +"distribution shift"'
    ]);

    expect(queries).toEqual([
      '+"document retrieval" +"uncertainty calibration" +"limited labels"',
      '+"document retrieval" +"distribution shift"'
    ]);
  });

  it("extracts only normalized positive terms for query-family provenance", () => {
    const terms = extractLiteratureQueryPositiveTerms(
      '+"document-retrieval evaluation" +(calibration | confidence) -"health reporting"'
    );

    expect(terms).toEqual(
      expect.arrayContaining(["calibration", "confidence", "document", "evaluation", "retrieval"])
    );
    expect(terms).not.toContain("health");
    expect(terms).not.toContain("reporting");
  });

  it("builds a compact topic-discovery query from a shared anchor and one axis", () => {
    expect(
      buildTopicDiscoveryLiteratureQuery(
        "document-retrieval evaluation",
        "uncertainty calibration"
      )
    ).toBe('"document retrieval evaluation" uncertainty calibration');
  });

  it("normalizes Boolean topic-discovery queries and drops exclusions", () => {
    expect(
      normalizeTopicDiscoveryLiteratureQuery(
        '+"document retrieval" +"distribution shift" -"clinical reporting"'
      )
    ).toBe('"document retrieval" distribution shift');
  });

  it("rejects topic-discovery query families that exceed the compact concept budget", () => {
    expect(
      buildTopicDiscoveryLiteratureQuery(
        "document retrieval evaluation corpus benchmark framework",
        "uncertainty calibration stability reliability"
      )
    ).toBeUndefined();
  });

  it("rejects one-term and execution-only topic-discovery axes", () => {
    expect(
      buildTopicDiscoveryLiteratureQuery("document retrieval evaluation", "reliability")
    ).toBeUndefined();
    expect(
      buildTopicDiscoveryLiteratureQuery(
        "document retrieval evaluation",
        "limited local budget"
      )
    ).toBeUndefined();
    expect(
      buildTopicDiscoveryLiteratureQuery(
        "document retrieval evaluation",
        "empirical comparison workshop contribution"
      )
    ).toBeUndefined();
    expect(
      buildTopicDiscoveryLiteratureQuery(
        "document retrieval evaluation",
        "ranking stability"
      )
    ).toBe('"document retrieval evaluation" ranking stability');
  });

  it("preserves an interior scientific compound token in a governed anchor", () => {
    expect(
      buildTopicDiscoveryLiteratureQuery(
        "automated research workflow",
        "retrieval coverage calibration"
      )
    ).toBe('"automated research workflow" retrieval coverage calibration');
    expect(
      normalizeTopicDiscoveryLiteratureQuery(
        '"automated research workflow" premature stopping'
      )
    ).toBe('"automated research workflow" premature stopping');
    expect(
      buildTopicDiscoveryLiteratureQuery("research paper", "retrieval coverage")
    ).toBeUndefined();
  });
});
