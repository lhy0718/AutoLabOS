import { describe, expect, it } from "vitest";

import {
  assessTopicDiscoveryCorpusQuality,
  assessTopicDiscoveryPaperRelevance,
  buildTopicDiscoveryCorpusRelevanceProfile,
  TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION
} from "../src/core/collection/topicDiscoveryCorpusQuality.js";
import type {
  TopicDiscoverySemanticAuditTrace,
  TopicDiscoverySemanticVerdict
} from "../src/core/collection/topicDiscoverySemanticAudit.js";
import {
  runTopicDiscoverySemanticAudit,
  TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION
} from "../src/core/collection/topicDiscoverySemanticAudit.js";
import { StoredCorpusRow } from "../src/core/collection/types.js";
import type { LLMClient } from "../src/core/llm/client.js";
import {
  TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
  TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
} from "../src/core/topicDiscoveryScientificTerms.js";

describe("topic discovery corpus quality", () => {
  it("retains an on-topic corpus backed by multiple independent query families", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) =>
        paper(
          `relevant-${index + 1}`,
          index % 2 === 0
            ? `Document retrieval uncertainty calibration evaluation ${index + 1}`
            : `Document retrieval distribution shift evaluation ${index + 1}`
        )
      ),
      paper("excluded-1", "Clinical reporting checklist"),
      paper("excluded-2", "Municipal budget accounting")
    ];
    const paperQueryFamilies = new Map(
      rows.slice(0, 8).map((row, index) => [
        row.paper_id,
        new Set([index % 2 === 0 ? "family-calibration" : "family-shift"])
      ])
    );
    const assessment = assessTopicDiscoveryCorpusQuality({
      rows,
      searchFamilies: searchFamilies(),
      paperQueryFamilies,
      semanticAudit: semanticAudit(rows, paperQueryFamilies),
      globalLimit: 20,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(assessment.audit.passed).toBe(true);
    expect(assessment.audit).toMatchObject({
      version: TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION,
      term_normalization_version: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
      candidate_recall_semantics_version:
        TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
      strategy: "shared_anchor_bounded_provider_recall_plus_semantic_precision"
    });
    expect(assessment.audit.observed).toEqual(
      expect.objectContaining({
        total_papers: 10,
        relevant_papers: 8,
        covered_query_families: 2
      })
    );
    expect([...assessment.retainedPaperIds]).toHaveLength(8);
    expect([...assessment.anchorProximatePaperIds]).toHaveLength(8);
    expect(assessment.audit.excluded_paper_ids).toEqual(["excluded-1", "excluded-2"]);
    expect(assessment.audit.query_families).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direct_support_paper_count: 4,
          semantic_precision: 1
        })
      ])
    );
  });

  it("rejects incidental or distant axis mentions even when the anchor is present", () => {
    const profile = buildTopicDiscoveryCorpusRelevanceProfile(searchFamilies());
    const oneAxisTerm = assessTopicDiscoveryPaperRelevance({
      row: paper(
        "incidental-axis",
        "Document retrieval evaluation reports uncertainty but no paired measurement concept"
      ),
      profile,
      eligibleQueryFamilies: new Set(["family-calibration"])
    });
    const distantAxisTerms = assessTopicDiscoveryPaperRelevance({
      row: {
        paper_id: "distant-axis",
        title: "Document retrieval evaluation protocol",
        abstract: [
          "Uncertainty appears near the task description.",
          ...Array.from({ length: 32 }, () => "neutral"),
          "Calibration is mentioned only in an unrelated closing note."
        ].join(" "),
        authors: ["Example Author"]
      },
      profile,
      eligibleQueryFamilies: new Set(["family-calibration"])
    });
    const linkedAxisTerms = assessTopicDiscoveryPaperRelevance({
      row: paper(
        "linked-axis",
        "Document retrieval uncertainty calibration evaluation"
      ),
      profile,
      eligibleQueryFamilies: new Set(["family-calibration"])
    });

    expect(oneAxisTerm.relevant).toBe(false);
    expect(distantAxisTerms.relevant).toBe(false);
    expect(linkedAxisTerms).toMatchObject({
      relevant: true,
      anchorAxisProximate: true,
      matchedQueryFamilies: ["family-calibration"]
    });
  });

  it("preserves a paper-review object through profile and candidate matching", () => {
    const profile = buildTopicDiscoveryCorpusRelevanceProfile([
      {
        queryFamily: "family-defect-localization",
        query: '"paper review" manuscript defect localization',
        source: "llm_query_planner",
        sharedAnchorTerms: ["paper", "review"],
        axisTerms: ["manuscript", "defect", "localization"]
      }
    ]);
    const relevance = assessTopicDiscoveryPaperRelevance({
      row: paper(
        "paper-review-localization",
        "Paper review with manuscript defect localization and grounded evidence"
      ),
      profile,
      eligibleQueryFamilies: new Set(["family-defect-localization"])
    });

    expect(profile.sharedAnchorTerms).toEqual(["paper", "review"]);
    expect(profile.families[0]?.familySignature).toBe(JSON.stringify({
      sharedAnchorTerms: ["paper", "review"],
      axisTerms: ["defect", "localization", "manuscript"]
    }));
    expect(relevance).toMatchObject({
      relevant: true,
      anchorProximate: true,
      anchorAxisProximate: true,
      matchedQueryFamilies: ["family-defect-localization"]
    });
  });

  it("requires two thirds of a three-term axis before semantic review", () => {
    const profile = buildTopicDiscoveryCorpusRelevanceProfile([
      {
        queryFamily: "family-validity",
        query: '"language model benchmark" test set contamination',
        source: "llm_query_planner",
        sharedAnchorTerms: ["language", "model", "benchmark"],
        axisTerms: ["test", "set", "contamination"]
      }
    ]);
    const oneTerm = assessTopicDiscoveryPaperRelevance({
      row: paper(
        "one-axis-term",
        "A language model benchmark with a new test protocol"
      ),
      profile,
      eligibleQueryFamilies: new Set(["family-validity"])
    });
    const twoTerms = assessTopicDiscoveryPaperRelevance({
      row: paper(
        "two-axis-terms",
        "A language model benchmark with a new test set"
      ),
      profile,
      eligibleQueryFamilies: new Set(["family-validity"])
    });
    const completeAxis = assessTopicDiscoveryPaperRelevance({
      row: paper(
        "complete-axis",
        "Test set contamination in a language model benchmark"
      ),
      profile,
      eligibleQueryFamilies: new Set(["family-validity"])
    });

    expect(oneTerm.relevant).toBe(false);
    expect(twoTerms.relevant).toBe(true);
    expect(completeAxis).toMatchObject({
      relevant: true,
      matchedQueryFamilies: ["family-validity"]
    });
  });

  it("forwards normalized finite-sample variants to semantic review", () => {
    const profile = buildTopicDiscoveryCorpusRelevanceProfile([
      {
        queryFamily: "family-finite-sample",
        query: '"language model evaluation" finite sample uncertainty',
        source: "llm_query_planner",
        sharedAnchorTerms: ["language", "model", "evaluation"],
        axisTerms: ["finite", "sample", "uncertainty"]
      }
    ]);
    const directCandidate = assessTopicDiscoveryPaperRelevance({
      row: paper(
        "limited-sample-candidate",
        "Probabilistic model ranking for language model evaluation under limited-sample regimes"
      ),
      profile,
      eligibleQueryFamilies: new Set(["family-finite-sample"])
    });
    const incompleteCandidate = assessTopicDiscoveryPaperRelevance({
      row: paper(
        "limited-benchmark-only",
        "Language model evaluation on a limited benchmark without comparative analysis"
      ),
      profile,
      eligibleQueryFamilies: new Set(["family-finite-sample"])
    });

    expect(profile.families[0]?.axisTerms).toEqual(["finite", "sample", "uncertainty"]);
    expect(directCandidate).toMatchObject({
      relevant: true,
      matchedQueryFamilies: ["family-finite-sample"]
    });
    expect(incompleteCandidate.relevant).toBe(false);
  });

  it("forwards partial conceptual evidence to semantic review and retains only direct support", async () => {
    const familyContract = {
      queryFamily: "family-sample-confidence",
      query: '"language model evaluation" finite sample uncertainty',
      source: "llm_query_planner",
      sharedAnchorTerms: ["language", "model", "evaluation"],
      axisTerms: ["finite", "sample", "uncertainty"],
      lens: "confidence under finite samples",
      contributionIntent: "measurement",
      contractSource: "planner_declared" as const
    };
    const rows = [
      paper(
        "direct-a",
        "Probabilistic ranking for language model evaluation under limited-sample regimes"
      ),
      paper(
        "direct-b",
        "Bayesian ranking of language model evaluation under limited-sample conditions"
      ),
      paper(
        "application-context",
        "A toolkit for language model evaluation under limited-sample uncertainty"
      )
    ];
    const profile = buildTopicDiscoveryCorpusRelevanceProfile([familyContract]);
    const lexicalMatches = new Map<string, Set<string>>();
    for (const row of rows) {
      const relevance = assessTopicDiscoveryPaperRelevance({
        row,
        profile,
        eligibleQueryFamilies: new Set([familyContract.queryFamily])
      });
      if (relevance.relevant) {
        lexicalMatches.set(row.paper_id, new Set(relevance.matchedQueryFamilies));
      }
    }
    const llm: LLMClient = {
      async complete() {
        return {
          text: JSON.stringify({
            judgments: rows.map((row) => ({
              paper_id: row.paper_id,
              family_id: familyContract.queryFamily,
              verdict: row.paper_id === "application-context"
                ? "application_only"
                : "direct_support",
              reason: row.paper_id === "application-context"
                ? "The family is only an application context."
                : "The central contribution measures limited-sample confidence.",
              ...(row.paper_id === "application-context"
                ? {}
                : { evidence_span: row.title })
            }))
          })
        };
      }
    };
    const semanticReview = await runTopicDiscoverySemanticAudit({
      llm,
      rows,
      searchFamilies: [familyContract],
      lexicalMatchedFamilyIdsByPaper: lexicalMatches
    });
    const assessment = assessTopicDiscoveryCorpusQuality({
      rows,
      searchFamilies: [familyContract],
      paperQueryFamilies: new Map(
        rows.map((row) => [row.paper_id, new Set([familyContract.queryFamily])])
      ),
      semanticAudit: semanticReview,
      globalLimit: 3
    });

    expect(semanticReview.reviewer_input_payload.requested_pairs).toHaveLength(3);
    expect(semanticReview.reviewer_input_payload).toMatchObject({
      version: TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
      term_normalization_version: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
      candidate_recall_semantics_version:
        TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION
    });
    expect(assessment.retainedPaperIds).toEqual(new Set(["direct-a", "direct-b"]));
    expect(assessment.audit.excluded_paper_ids).toContain("application-context");
  });

  it("does not count equivalent surface variants as independent families", () => {
    const families = [
      {
        queryFamily: "family-finite",
        query: '"document retrieval" finite sample uncertainty',
        source: "llm_query_planner",
        sharedAnchorTerms: ["document", "retrieval"],
        axisTerms: ["finite", "sample", "uncertainty"],
        lens: "finite sample uncertainty",
        contributionIntent: "measurement",
        contractSource: "planner_declared" as const
      },
      {
        queryFamily: "family-limited",
        query: '"document retrieval" limited sample uncertainty',
        source: "llm_query_planner",
        sharedAnchorTerms: ["document", "retrieval"],
        axisTerms: ["limited", "sample", "uncertainty"],
        lens: "limited sample uncertainty",
        contributionIntent: "measurement",
        contractSource: "planner_declared" as const
      }
    ];
    const rows = [
      paper("finite-a", "Document retrieval finite sample uncertainty study A"),
      paper("finite-b", "Document retrieval finite sample uncertainty study B"),
      paper("limited-a", "Document retrieval limited-sample uncertainty study A"),
      paper("limited-b", "Document retrieval limited-sample uncertainty study B")
    ];
    const provenance = new Map([
      ["finite-a", new Set(["family-finite"])],
      ["finite-b", new Set(["family-finite"])],
      ["limited-a", new Set(["family-limited"])],
      ["limited-b", new Set(["family-limited"])]
    ]);
    const assessment = assessTopicDiscoveryCorpusQuality({
      rows,
      searchFamilies: families,
      paperQueryFamilies: provenance,
      semanticAudit: semanticAudit(rows, provenance),
      globalLimit: 4
    });

    expect(assessment.audit.observed.covered_query_families).toBe(1);
    expect(new Set(
      assessment.audit.query_families.map((family) => family.canonical_family_signature)
    ).size).toBe(1);
    expect(assessment.audit.passed).toBe(false);
    expect(assessment.audit.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("independent query family")])
    );
  });

  it("keeps the explicit anchor separate from an axis repeated across families", () => {
    const profile = buildTopicDiscoveryCorpusRelevanceProfile([
      family("family-ranking-stability", "ranking stability"),
      family("family-ranking-variance", "ranking variance"),
      family("family-ranking-calibration", "ranking calibration"),
      family("family-sampling-variance", "sampling variance")
    ]);

    expect(profile.sharedAnchorTerms).toEqual(["document", "retrieval"]);
    expect(profile.sharedAnchorTerms).not.toContain("ranking");
  });

  it("scores scientific axis terms without requiring leaked execution qualifiers", () => {
    const profile = buildTopicDiscoveryCorpusRelevanceProfile([
      {
        queryFamily: "family-power",
        query: '"language model evaluation" limited budget statistical power',
        source: "llm_query_planner",
        sharedAnchorTerms: ["language", "model", "evaluation"],
        axisTerms: ["limited", "budget", "statistical", "power"]
      }
    ]);
    const relevance = assessTopicDiscoveryPaperRelevance({
      row: paper(
        "scientific-axis",
        "Language model evaluation with statistical power analysis"
      ),
      profile,
      eligibleQueryFamilies: new Set(["family-power"])
    });

    expect(profile.families[0]?.axisTerms).toEqual(["statistical", "power"]);
    expect(relevance.relevant).toBe(true);
  });

  it("keeps complete shared-anchor evidence as the precision gate after broad retrieval", () => {
    const profile = buildTopicDiscoveryCorpusRelevanceProfile([
      {
        queryFamily: "family-reliability",
        query: '"language model evaluation" uncertainty reliability',
        source: "llm_query_planner",
        sharedAnchorTerms: ["language", "model", "evaluation"],
        axisTerms: ["uncertainty", "reliability"]
      }
    ]);
    const completeAnchor = assessTopicDiscoveryPaperRelevance({
      row: paper(
        "complete-anchor",
        "Language model evaluation uncertainty reliability analysis"
      ),
      profile,
      eligibleQueryFamilies: new Set(["family-reliability"])
    });
    const partialAnchor = assessTopicDiscoveryPaperRelevance({
      row: paper(
        "partial-anchor",
        "Language model uncertainty reliability analysis"
      ),
      profile,
      eligibleQueryFamilies: new Set(["family-reliability"])
    });

    expect(completeAnchor.relevant).toBe(true);
    expect(partialAnchor.anchorProximate).toBe(false);
    expect(partialAnchor.relevant).toBe(false);
  });

  it("does not conflate long tokens with the same seven-character prefix", () => {
    const profile = buildTopicDiscoveryCorpusRelevanceProfile([
      family("family-calibration", "calibration reliability"),
      family("family-distribution", "distribution stability")
    ]);
    const relevance = assessTopicDiscoveryPaperRelevance({
      row: paper(
        "prefix-collision",
        "Document retrieval calibrator reliability evaluation"
      ),
      profile,
      eligibleQueryFamilies: new Set(["family-calibration"])
    });

    expect(relevance.relevant).toBe(false);
  });

  it("preserves Unicode terms in explicit anchor and axis matching", () => {
    const profile = buildTopicDiscoveryCorpusRelevanceProfile([
      {
        queryFamily: "family-stability",
        query: '"문서 검색 평가" 순위 안정성',
        source: "llm_query_planner",
        sharedAnchorTerms: ["문서", "검색", "평가"],
        axisTerms: ["순위", "안정성"]
      },
      {
        queryFamily: "family-uncertainty",
        query: '"문서 검색 평가" 표본 불확실성',
        source: "llm_query_planner",
        sharedAnchorTerms: ["문서", "검색", "평가"],
        axisTerms: ["표본", "불확실성"]
      }
    ]);
    const relevance = assessTopicDiscoveryPaperRelevance({
      row: paper("unicode-match", "문서 검색 평가의 순위 안정성 분석"),
      profile,
      eligibleQueryFamilies: new Set(["family-stability"])
    });

    expect(profile.sharedAnchorTerms).toEqual(["문서", "검색", "평가"]);
    expect(relevance.relevant).toBe(true);
  });

  it("fails closed when search providers return a mostly unrelated corpus", () => {
    const rows = [
      paper("relevant-1", "Document retrieval uncertainty calibration evaluation"),
      paper("relevant-2", "Document retrieval distribution shift evaluation"),
      ...Array.from({ length: 10 }, (_, index) =>
        paper(`unrelated-${index + 1}`, `Unrelated reporting domain ${index + 1}`)
      )
    ];
    const paperQueryFamilies = new Map([
      ["relevant-1", new Set(["family-calibration"])],
      ["relevant-2", new Set(["family-shift"])]
    ]);
    const assessment = assessTopicDiscoveryCorpusQuality({
      rows,
      searchFamilies: searchFamilies(),
      paperQueryFamilies,
      semanticAudit: semanticAudit(rows, paperQueryFamilies),
      globalLimit: 20,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(assessment.audit.passed).toBe(false);
    expect(assessment.audit.observed.relevant_papers).toBe(2);
    expect(assessment.audit.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("direct-support paper"),
        expect.stringContaining("independent query family")
      ])
    );
  });

  it("keeps verdicts scoped to each paper-family pair", () => {
    const rows = [
      paper(
        "cross-family",
        "Document retrieval uncertainty calibration distribution shift evaluation"
      )
    ];
    const paperQueryFamilies = new Map([
      ["cross-family", new Set(["family-calibration", "family-shift"])]
    ]);
    const assessment = assessTopicDiscoveryCorpusQuality({
      rows,
      searchFamilies: searchFamilies(),
      paperQueryFamilies,
      semanticAudit: semanticAudit(rows, paperQueryFamilies, new Map([
        ["cross-family|family-shift", "application_only"]
      ])),
      globalLimit: 20,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(assessment.matchedQueryFamiliesByPaper.get("cross-family")).toEqual(
      new Set(["family-calibration"])
    );
    expect(assessment.audit.query_families).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          query_family: "family-shift",
          direct_support_paper_count: 0,
          application_only_paper_count: 1
        })
      ])
    );
  });

  it("fails closed when a semantic pair claims provider recall despite being lexical", () => {
    const rows = [
      paper("provenance-check", "Document retrieval uncertainty calibration evaluation")
    ];
    const paperQueryFamilies = new Map([
      ["provenance-check", new Set(["family-calibration"])]
    ]);
    const audit = semanticAudit(rows, paperQueryFamilies);
    audit.reviewer_input_payload.requested_pairs[0]!.selection_source =
      "provider_provenance_floor";
    audit.recall = {
      provider_recall_floor_per_family: 4,
      lexical_requested_pairs: 0,
      provider_provenance_requested_pairs: 1
    };

    const assessment = assessTopicDiscoveryCorpusQuality({
      rows,
      searchFamilies: searchFamilies(),
      paperQueryFamilies,
      semanticAudit: audit,
      globalLimit: 20
    });

    expect(assessment.audit.passed).toBe(false);
    expect(assessment.audit.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining("valid selection source")
      ])
    );
    expect(assessment.retainedPaperIds).toEqual(new Set());
  });

  it("computes precision over the full lexical universe before bounding the retained corpus", () => {
    const calibrationRows = Array.from({ length: 6 }, (_, index) =>
      paper(
        `calibration-${index + 1}`,
        `Document retrieval uncertainty calibration evaluation ${index + 1}`
      )
    );
    const shiftRows = Array.from({ length: 6 }, (_, index) =>
      paper(
        `shift-${index + 1}`,
        `Document retrieval distribution shift evaluation ${index + 1}`
      )
    );
    const rows = [...calibrationRows, ...shiftRows];
    const paperQueryFamilies = new Map([
      ...calibrationRows.map((row) => [
        row.paper_id,
        new Set(["family-calibration"])
      ] as const),
      ...shiftRows.map((row) => [
        row.paper_id,
        new Set(["family-shift"])
      ] as const)
    ]);
    const verdictOverrides = new Map<string, TopicDiscoverySemanticVerdict>([
      ["calibration-3|family-calibration", "application_only"],
      ["calibration-4|family-calibration", "application_only"],
      ["shift-3|family-shift", "application_only"],
      ["shift-4|family-shift", "application_only"]
    ]);

    const assessment = assessTopicDiscoveryCorpusQuality({
      rows,
      searchFamilies: searchFamilies(),
      paperQueryFamilies,
      semanticAudit: semanticAudit(rows, paperQueryFamilies, verdictOverrides),
      globalLimit: 8,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });

    expect(assessment.audit.passed).toBe(true);
    expect(assessment.audit.observed).toEqual(
      expect.objectContaining({
        lexical_relevant_papers: 12,
        direct_support_papers: 8,
        relevant_papers: 8,
        application_only_pairs: 4
      })
    );
    expect(assessment.audit.query_families).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lexical_relevant_paper_count: 6,
          direct_support_paper_count: 4,
          application_only_paper_count: 2,
          semantic_precision: 4 / 6
        })
      ])
    );
    expect(assessment.retainedPaperIds).toEqual(
      new Set([
        "calibration-1",
        "calibration-2",
        "shift-1",
        "shift-2",
        "calibration-5",
        "calibration-6",
        "shift-5",
        "shift-6"
      ])
    );
  });
});

function searchFamilies() {
  return [
    {
      queryFamily: "family-calibration",
      query: '+"document retrieval" +"uncertainty calibration"',
      source: "llm_query_planner",
      lens: "uncertainty calibration",
      contributionIntent: "measurement",
      contractSource: "planner_declared" as const
    },
    {
      queryFamily: "family-shift",
      query: '+"document retrieval" +"distribution shift"',
      source: "llm_query_planner",
      lens: "distribution shift",
      contributionIntent: "empirical_finding",
      contractSource: "planner_declared" as const
    }
  ];
}

function semanticAudit(
  rows: StoredCorpusRow[],
  paperQueryFamilies: ReadonlyMap<string, ReadonlySet<string>>,
  verdictOverrides: ReadonlyMap<string, TopicDiscoverySemanticVerdict> = new Map()
): TopicDiscoverySemanticAuditTrace {
  const rowById = new Map(rows.map((row) => [row.paper_id, row] as const));
  const requestedPairs = Array.from(paperQueryFamilies.entries()).flatMap(
    ([paperId, familyIds]) => Array.from(familyIds, (familyId) => ({
      paper_id: paperId,
      family_id: familyId,
      selection_source: "lexical_match" as const
    }))
  );
  const judgments = requestedPairs.map((pair) => {
    const verdict = verdictOverrides.get(`${pair.paper_id}|${pair.family_id}`)
      ?? "direct_support";
    return {
      ...pair,
      verdict,
      reason: `${verdict}_fixture`,
      ...(verdict === "direct_support"
        ? { evidence_span: rowById.get(pair.paper_id)?.title ?? "" }
        : {})
    };
  });
  const count = (verdict: TopicDiscoverySemanticVerdict) =>
    judgments.filter((judgment) => judgment.verdict === verdict).length;
  return {
    version: 4,
    status: "complete",
    prompt_sha256: "a".repeat(64),
    response_sha256: "b".repeat(64),
    limits: {
      max_pairs: 64,
      max_input_bytes: 131_072,
      abstract_chars: 2_000,
      timeout_ms: 30_000
    },
    reviewer_input_bytes: 1,
    reviewer_input_payload: {
      version: 4,
      term_normalization_version: 2,
      candidate_recall_semantics_version: 4,
      papers: rows.map((row) => ({
        paper_id: row.paper_id,
        title: row.title,
        abstract: row.abstract
      })),
      family_contracts: searchFamilies().map((family) => ({
        family_id: family.queryFamily,
        query: family.query,
        axis_terms: family.queryFamily === "family-calibration"
          ? ["uncertainty", "calibration"]
          : ["distribution", "shift"],
        lens: family.lens,
        contribution_intent: family.contributionIntent
      })),
      requested_pairs: requestedPairs
    },
    counts: {
      requested_pairs: judgments.length,
      reviewed_pairs: judgments.length,
      budget_excluded_pairs: 0,
      returned_judgments: judgments.length,
      direct_support: count("direct_support"),
      application_only: count("application_only"),
      uncertain: count("uncertain"),
      omitted_judgments: 0,
      duplicate_judgments: 0,
      conflicting_judgments: 0,
      invented_judgments: 0,
      malformed_judgments: 0,
      protocol_violations: 0
    },
    recall: {
      provider_recall_floor_per_family: 4,
      lexical_requested_pairs: judgments.length,
      provider_provenance_requested_pairs: 0
    },
    reasons: [],
    protocol_violations: [],
    judgments
  };
}

function family(queryFamily: string, axis: string) {
  return {
    queryFamily,
    query: `"document retrieval" ${axis}`,
    source: "llm_query_planner"
  };
}

function paper(paperId: string, title: string): StoredCorpusRow {
  return {
    paper_id: paperId,
    title,
    abstract: `${title} with controlled evidence.`,
    authors: ["Example Author"]
  };
}
