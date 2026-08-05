import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  runTopicDiscoverySemanticAudit,
  TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
  type TopicDiscoverySemanticSearchFamilyContract
} from "../src/core/collection/topicDiscoverySemanticAudit.js";
import type { StoredCorpusRow } from "../src/core/collection/types.js";
import type { LLMClient, LLMCompleteOptions } from "../src/core/llm/client.js";

describe("topic discovery semantic audit", () => {
  it("normalizes pair-level direct, application-only, and uncertain verdicts in one batch", async () => {
    const llm = new CapturingLlm(response([
      judgment(
        "paper-a",
        "family-a",
        "direct_support",
        "The central study directly evaluates consistency.",
        "Consistency assessment for structured records"
      ),
      judgment(
        "paper-b",
        "family-a",
        "application_only",
        "Consistency is only an evaluation setting."
      ),
      judgment(
        "paper-c",
        "family-b",
        "uncertain",
        "The abstract does not establish the central contribution."
      )
    ]));

    const audit = await runTopicDiscoverySemanticAudit({
      llm,
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([
        ["paper-c", "family-b"],
        ["paper-a", "family-a"],
        ["paper-b", "family-a"]
      ])
    });

    expect(llm.calls).toHaveLength(1);
    expect(audit).toMatchObject({
      version: TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
      status: "complete",
      counts: {
        requested_pairs: 3,
        reviewed_pairs: 3,
        direct_support: 1,
        application_only: 1,
        uncertain: 1
      },
      limits: {
        timeout_ms: 120_000
      },
      reasons: []
    });
    expect(audit.recall).toEqual({
      provider_recall_floor_per_family: 8,
      lexical_requested_pairs: 3,
      provider_provenance_requested_pairs: 0
    });
    expect(audit.judgments.map((item) => [item.paper_id, item.family_id, item.verdict])).toEqual([
      ["paper-a", "family-a", "direct_support"],
      ["paper-c", "family-b", "uncertain"],
      ["paper-b", "family-a", "application_only"]
    ]);
    expect(audit.judgments[0]?.evidence_span).toBe(
      "Consistency assessment for structured records"
    );
    expect(llm.calls[0]?.options?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(llm.calls[0]?.prompt).toContain("12-240 characters long");
    expect(llm.calls[0]?.prompt).toContain(
      "do not use direct_support; choose application_only or uncertain"
    );
    expect(llm.calls[0]?.prompt).toContain(
      '"verdict":"<direct_support|application_only|uncertain>"'
    );
    expect(audit).not.toHaveProperty("response");
    expect(audit).not.toHaveProperty("completion");
  });

  it("downgrades direct support when its exact evidence span is absent from local input", async () => {
    const audit = await runTopicDiscoverySemanticAudit({
      llm: new CapturingLlm(response([
        judgment(
          "paper-a",
          "family-a",
          "direct_support",
          "The study appears central.",
          "A span not present in the title or abstract"
        )
      ])),
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([["paper-a", "family-a"]])
    });

    expect(audit.status).toBe("partial");
    expect(audit.judgments[0]).toMatchObject({
      paper_id: "paper-a",
      family_id: "family-a",
      verdict: "uncertain",
      reason: "invalid_direct_support_evidence_span"
    });
    expect(audit.counts.malformed_judgments).toBe(1);
    expect(audit.protocol_violations).toContainEqual(expect.objectContaining({
      code: "invalid_direct_support_evidence_span",
      paper_id: "paper-a",
      family_id: "family-a"
    }));
  });

  it("keeps non-evidence schema failures in the generic malformed category", async () => {
    const audit = await runTopicDiscoverySemanticAudit({
      llm: new CapturingLlm(response([{
        paper_id: "paper-a",
        family_id: "family-a",
        verdict: "uncertain"
      }])),
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([["paper-a", "family-a"]])
    });

    expect(audit.judgments[0]).toMatchObject({
      verdict: "uncertain",
      reason: "malformed_model_judgment"
    });
    expect(audit.protocol_violations).toContainEqual(expect.objectContaining({
      code: "malformed_response_judgment",
      paper_id: "paper-a",
      family_id: "family-a"
    }));
  });

  it("rejects tiny or contract-irrelevant exact substrings as direct evidence", async () => {
    const tiny = await runTopicDiscoverySemanticAudit({
      llm: new CapturingLlm(response([
        judgment("paper-a", "family-a", "direct_support", "Exact but too small.", "Consistency")
      ])),
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([["paper-a", "family-a"]])
    });
    const irrelevant = await runTopicDiscoverySemanticAudit({
      llm: new CapturingLlm(response([
        judgment(
          "paper-a",
          "family-a",
          "direct_support",
          "Exact but unrelated to the family axis.",
          "structured records"
        )
      ])),
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([["paper-a", "family-a"]])
    });

    expect(tiny.status).toBe("partial");
    expect(tiny.judgments[0]).toMatchObject({
      verdict: "uncertain",
      reason: "invalid_direct_support_evidence_span"
    });
    expect(irrelevant.status).toBe("partial");
    expect(irrelevant.judgments[0]).toMatchObject({
      verdict: "uncertain",
      reason: "invalid_direct_support_evidence_span"
    });
  });

  it("accepts exact synonym evidence for a provider-provenance fallback pair", async () => {
    const evidenceSpan = "Agreement scoring for structured records";
    const audit = await runTopicDiscoverySemanticAudit({
      llm: new CapturingLlm(response([
        judgment(
          "paper-provider",
          "family-a",
          "direct_support",
          "The provider candidate directly studies the family through equivalent terminology.",
          evidenceSpan
        )
      ])),
      rows: [paper("paper-provider", evidenceSpan)],
      searchFamilies: [families()[0]!],
      lexicalMatchedFamilyIdsByPaper: matches([]),
      providerCandidatePaperIdsByFamily: new Map([
        ["family-a", ["paper-provider"]]
      ])
    });

    expect(audit.status).toBe("complete");
    expect(audit.reviewer_input_payload.requested_pairs).toEqual([
      {
        paper_id: "paper-provider",
        family_id: "family-a",
        selection_source: "provider_provenance_floor"
      }
    ]);
    expect(audit.judgments[0]).toMatchObject({
      verdict: "direct_support",
      evidence_span: evidenceSpan
    });
    expect(audit.counts.malformed_judgments).toBe(0);
  });

  it("downgrades provider direct support backed only by family anchor terms", async () => {
    const audit = await runTopicDiscoverySemanticAudit({
      llm: new CapturingLlm(response([
        judgment(
          "paper-provider",
          "family-a",
          "direct_support",
          "The supplied span is exact but contains only shared anchors.",
          "structured records"
        )
      ])),
      rows: [paper(
        "paper-provider",
        "A controlled study of structured records"
      )],
      searchFamilies: [families()[0]!],
      lexicalMatchedFamilyIdsByPaper: matches([]),
      providerCandidatePaperIdsByFamily: new Map([
        ["family-a", ["paper-provider"]]
      ])
    });

    expect(audit.status).toBe("partial");
    expect(audit.judgments[0]).toMatchObject({
      verdict: "uncertain",
      reason: "invalid_direct_support_evidence_span"
    });
    expect(audit.counts.malformed_judgments).toBe(1);
  });

  it("keeps the literal axis-term requirement for lexical pairs", async () => {
    const evidenceSpan = "Agreement scoring for structured records";
    const audit = await runTopicDiscoverySemanticAudit({
      llm: new CapturingLlm(response([
        judgment(
          "paper-lexical",
          "family-a",
          "direct_support",
          "The exact span uses equivalent terminology but no literal axis term.",
          evidenceSpan
        )
      ])),
      rows: [paper("paper-lexical", evidenceSpan)],
      searchFamilies: [families()[0]!],
      lexicalMatchedFamilyIdsByPaper: matches([
        ["paper-lexical", "family-a"]
      ])
    });

    expect(audit.reviewer_input_payload.requested_pairs[0]?.selection_source).toBe(
      "lexical_match"
    );
    expect(audit.status).toBe("partial");
    expect(audit.judgments[0]).toMatchObject({
      verdict: "uncertain",
      reason: "invalid_direct_support_evidence_span"
    });
    expect(audit.counts.malformed_judgments).toBe(1);
  });

  it("marks omissions, duplicate and conflicting pairs, malformed spans, and unknown IDs as partial", async () => {
    const llm = new CapturingLlm(response([
      judgment("paper-a", "family-a", "direct_support", "First.", "Consistency assessment"),
      judgment("paper-a", "family-a", "direct_support", "Duplicate.", "Consistency assessment"),
      judgment("invented-paper", "family-a", "direct_support", "Unknown ID.", "Unknown"),
      judgment("paper-c", "family-b", "direct_support", "Missing exact span."),
      judgment("paper-d", "family-b", "application_only", "Transfer is only an application."),
      judgment("paper-e", "family-b", "application_only", "First classification."),
      judgment("paper-e", "family-b", "uncertain", "Conflicting classification.")
    ]));

    const audit = await runTopicDiscoverySemanticAudit({
      llm,
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([
        ["paper-a", "family-a"],
        ["paper-b", "family-a"],
        ["paper-c", "family-b"],
        ["paper-d", "family-b"],
        ["paper-e", "family-b"]
      ])
    });

    expect(audit.status).toBe("partial");
    expect(audit.judgments).toEqual([
      expect.objectContaining({ paper_id: "paper-a", verdict: "uncertain", reason: "duplicate_model_judgment" }),
      expect.objectContaining({ paper_id: "paper-c", verdict: "uncertain", reason: "invalid_direct_support_evidence_span" }),
      expect.objectContaining({ paper_id: "paper-b", verdict: "uncertain", reason: "model_judgment_omitted" }),
      expect.objectContaining({ paper_id: "paper-d", verdict: "application_only" }),
      expect.objectContaining({ paper_id: "paper-e", verdict: "uncertain", reason: "conflicting_model_judgments" })
    ]);
    expect(audit.counts).toMatchObject({
      direct_support: 0,
      application_only: 1,
      uncertain: 4,
      omitted_judgments: 1,
      duplicate_judgments: 1,
      conflicting_judgments: 1,
      invented_judgments: 1,
      malformed_judgments: 1
    });
    expect(audit.protocol_violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unknown_response_pair", paper_id: "invented-paper" }),
      expect.objectContaining({ code: "duplicate_response_pair", paper_id: "paper-a" }),
      expect.objectContaining({ code: "conflicting_response_pair", paper_id: "paper-e" })
    ]));
    expect(audit.judgments.some((item) => item.paper_id === "invented-paper")).toBe(false);
  });

  it("returns canonical bounded reviewer input and explicitly excludes over-budget pairs", async () => {
    const llm = new CapturingLlm(response([
      judgment("paper-a", "family-a", "uncertain", "The bounded input is inconclusive.")
    ]));
    const audit = await runTopicDiscoverySemanticAudit({
      llm,
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([
        ["paper-b", "family-a"],
        ["paper-a", "family-a"]
      ]),
      maxPairs: 1,
      maxInputBytes: 4_096,
      abstractChars: 24
    });

    expect(audit.status).toBe("partial");
    expect(audit.limits).toMatchObject({
      max_pairs: 1,
      max_input_bytes: 4_096,
      abstract_chars: 24
    });
    expect(audit.reviewer_input_bytes).toBeLessThanOrEqual(4_096);
    expect(audit.reviewer_input_payload.requested_pairs).toEqual([
      {
        paper_id: "paper-a",
        family_id: "family-a",
        selection_source: "lexical_match"
      }
    ]);
    expect(audit.reviewer_input_payload.papers[0]?.abstract).toHaveLength(24);
    expect(audit.judgments).toEqual([
      expect.objectContaining({ paper_id: "paper-a", verdict: "uncertain" }),
      expect.objectContaining({
        paper_id: "paper-b",
        verdict: "uncertain",
        reason: "max_pairs_budget_excluded"
      })
    ]);
    expect(audit.counts.budget_excluded_pairs).toBe(1);
    expect(llm.calls).toHaveLength(1);
  });

  it("keeps the serialized reviewer payload below the hard byte cap when family contracts alone exceed it", async () => {
    const llm = new CapturingLlm(response([]));
    const oversizedFamilies = families().map((family) => ({
      ...family,
      query: `${family.query} ${"bounded context ".repeat(80)}`,
      contributionIntent: `${family.contributionIntent} ${"bounded intent ".repeat(80)}`
    }));
    const audit = await runTopicDiscoverySemanticAudit({
      llm,
      rows: rows(),
      searchFamilies: oversizedFamilies,
      lexicalMatchedFamilyIdsByPaper: matches([
        ["paper-a", "family-a"],
        ["paper-b", "family-b"]
      ]),
      maxInputBytes: 256
    });

    expect(audit.status).toBe("partial");
    expect(audit.reviewer_input_bytes).toBeLessThanOrEqual(256);
    expect(audit.reviewer_input_payload).toMatchObject({
      papers: [],
      family_contracts: [],
      requested_pairs: []
    });
    expect(audit.counts).toMatchObject({
      requested_pairs: 2,
      reviewed_pairs: 0,
      budget_excluded_pairs: 2,
      uncertain: 2
    });
    expect(audit.judgments.every((item) =>
      item.reason === "max_input_bytes_base_envelope_budget_excluded"
    )).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it("allocates a bounded review budget round-robin across query families", async () => {
    const familyContracts = Array.from({ length: 4 }, (_, index) => ({
      queryFamily: `family-${String.fromCharCode(97 + index)}`,
      query: `structured records axis ${index + 1}`,
      axisTerms: ["structured", `axis-${index + 1}`],
      lens: `axis ${index + 1} behavior`,
      contributionIntent: `characterize axis ${index + 1}`
    }));
    const candidateRows = familyContracts.flatMap((family) =>
      Array.from({ length: 17 }, (_, index) =>
        paper(
          `${family.queryFamily}-paper-${String(index + 1).padStart(2, "0")}`,
          `Structured records ${family.queryFamily} study ${index + 1}`
        )
      )
    );
    const candidateMatches = new Map<string, Set<string>>();
    for (const row of candidateRows) {
      const familyId = row.paper_id.slice(0, "family-a".length);
      candidateMatches.set(row.paper_id, new Set([familyId]));
    }

    const audit = await runTopicDiscoverySemanticAudit({
      llm: new EchoingUncertainLlm(),
      rows: candidateRows,
      searchFamilies: familyContracts,
      lexicalMatchedFamilyIdsByPaper: candidateMatches,
      maxPairs: 64,
      maxInputBytes: 512 * 1024
    });

    const reviewedCounts = new Map<string, number>();
    for (const pair of audit.reviewer_input_payload.requested_pairs) {
      reviewedCounts.set(pair.family_id, (reviewedCounts.get(pair.family_id) ?? 0) + 1);
    }
    expect(audit.status).toBe("partial");
    expect(audit.counts).toMatchObject({
      requested_pairs: 68,
      reviewed_pairs: 64,
      budget_excluded_pairs: 4
    });
    expect([...reviewedCounts.entries()]).toEqual([
      ["family-a", 16],
      ["family-b", 16],
      ["family-c", 16],
      ["family-d", 16]
    ]);
    expect(audit.reviewer_input_payload.requested_pairs.slice(0, 4)).toEqual([
      { paper_id: "family-a-paper-01", family_id: "family-a", selection_source: "lexical_match" },
      { paper_id: "family-b-paper-01", family_id: "family-b", selection_source: "lexical_match" },
      { paper_id: "family-c-paper-01", family_id: "family-c", selection_source: "lexical_match" },
      { paper_id: "family-d-paper-01", family_id: "family-d", selection_source: "lexical_match" }
    ]);
  });

  it("keeps only allowed paper fields in the canonical reviewer payload", async () => {
    const llm = new CapturingLlm(response([
      judgment("paper-a", "family-a", "uncertain", "Insufficient evidence.")
    ]));
    const row = {
      ...paper("paper-a", "Neutral systems study", "A bounded abstract."),
      authors: ["Private Fixture Name"],
      year: 2099,
      venue: "Fixture Venue"
    };
    const audit = await runTopicDiscoverySemanticAudit({
      llm,
      rows: [row],
      searchFamilies: [families()[0]!],
      lexicalMatchedFamilyIdsByPaper: matches([["paper-a", "family-a"]])
    });

    const serialized = JSON.stringify(audit.reviewer_input_payload);
    expect(audit.reviewer_input_payload.papers[0]).toEqual({
      paper_id: "paper-a",
      title: "Neutral systems study",
      abstract: "A bounded abstract."
    });
    expect(serialized).not.toContain("Private Fixture Name");
    expect(serialized).not.toContain("Fixture Venue");
    expect(serialized).not.toContain("2099");
  });

  it("preserves declared family contracts even when a family has no lexical pair", async () => {
    const audit = await runTopicDiscoverySemanticAudit({
      llm: new CapturingLlm(response([
        judgment("paper-a", "family-a", "uncertain", "Insufficient evidence.")
      ])),
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([["paper-a", "family-a"]])
    });

    expect(audit.reviewer_input_payload.requested_pairs).toEqual([
      {
        paper_id: "paper-a",
        family_id: "family-a",
        selection_source: "lexical_match"
      }
    ]);
    expect(
      audit.reviewer_input_payload.family_contracts.map((family) => family.family_id)
    ).toEqual(["family-a", "family-b"]);
  });

  it("uses exact family-local provider ranks and preserves deterministic interleaving", async () => {
    const audit = await runTopicDiscoverySemanticAudit({
      llm: new EchoingUncertainLlm(),
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([
        ["paper-a", "family-a"],
        ["unknown-paper", "family-a"],
        ["paper-b", "unknown-family"]
      ]),
      providerCandidatePaperIdsByFamily: new Map([
        ["family-b", ["paper-e", "unknown-paper", "paper-c", "paper-e", "paper-d", "paper-b"]],
        ["unknown-family", ["paper-a"]],
        ["family-a", ["paper-a", "paper-d", "paper-d", "unknown-paper", "paper-b", "paper-c", "paper-e"]]
      ])
    });

    expect(audit.status).toBe("complete");
    expect(audit.recall).toEqual({
      provider_recall_floor_per_family: 8,
      lexical_requested_pairs: 1,
      provider_provenance_requested_pairs: 8
    });
    expect(audit.reviewer_input_payload.requested_pairs).toEqual([
      { paper_id: "paper-a", family_id: "family-a", selection_source: "lexical_match" },
      { paper_id: "paper-b", family_id: "family-b", selection_source: "provider_provenance_floor" },
      { paper_id: "paper-b", family_id: "family-a", selection_source: "provider_provenance_floor" },
      { paper_id: "paper-e", family_id: "family-b", selection_source: "provider_provenance_floor" },
      { paper_id: "paper-d", family_id: "family-a", selection_source: "provider_provenance_floor" },
      { paper_id: "paper-c", family_id: "family-b", selection_source: "provider_provenance_floor" },
      { paper_id: "paper-c", family_id: "family-a", selection_source: "provider_provenance_floor" },
      { paper_id: "paper-d", family_id: "family-b", selection_source: "provider_provenance_floor" },
      { paper_id: "paper-e", family_id: "family-a", selection_source: "provider_provenance_floor" }
    ]);
    expect(audit.judgments.some((item) =>
      item.paper_id === "unknown-paper" || item.family_id === "unknown-family"
    )).toBe(false);
  });

  it("fills provider recall from declared-scope proximity before raw provider rank", async () => {
    const searchFamily: TopicDiscoverySemanticSearchFamilyContract = {
      queryFamily: "family-a",
      query: "language model agent trajectory attribution",
      sharedAnchorTerms: ["language", "model", "agent"],
      axisTerms: ["trajectory", "attribution"],
      lens: "failure attribution from agent trajectories",
      contributionIntent: "measure trajectory attribution"
    };
    const candidateRows = [
      paper("raw-unrelated", "Trajectory attribution in tourism recovery"),
      paper("raw-other", "Reproducible environmental accounting"),
      paper("scope-only", "A survey of language model agents"),
      paper("scope-partial", "Trajectory analysis for language model agents"),
      paper("scope-acronym", "Trajectory attribution for LLM agents"),
      paper("scope-direct", "Language model agent trajectory attribution"),
      paper("scope-evidence", "Evidence for attribution in language model agent trajectories"),
      paper("scope-errors", "Error attribution from language model agent trajectories"),
      paper("scope-audit", "Auditing language model agent trajectory attribution"),
      paper("scope-study", "A study of trajectory attribution for language model agents")
    ];

    const audit = await runTopicDiscoverySemanticAudit({
      llm: new EchoingUncertainLlm(),
      rows: candidateRows,
      searchFamilies: [searchFamily],
      lexicalMatchedFamilyIdsByPaper: matches([]),
      providerCandidatePaperIdsByFamily: new Map([["family-a", candidateRows.map(
        (row) => row.paper_id
      )]])
    });

    expect(audit.reviewer_input_payload.requested_pairs).toHaveLength(8);
    expect(audit.reviewer_input_payload.requested_pairs.every(
      (pair) => pair.paper_id.startsWith("scope-")
    )).toBe(true);
  });

  it("reviews an exact title object phrase before loose body-level axis coincidences", async () => {
    const searchFamily: TopicDiscoverySemanticSearchFamilyContract = {
      queryFamily: "family-a",
      query: "structured review workflow error calibration",
      sharedAnchorTerms: ["structured", "review", "workflow"],
      axisTerms: ["error", "calibration"],
      lens: "error calibration in structured review workflows",
      contributionIntent: "measure calibration"
    };
    const distractors = Array.from({ length: 8 }, (_, index) => paper(
      `loose-body-${index + 1}`,
      `Calibration analysis ${index + 1}`,
      "A structured process measures error calibration. The workflow later includes review of unrelated outputs."
    ));
    const exactTitle = paper(
      "exact-title-object",
      "Structured Review Workflow: A Controlled Study",
      "The study reports a bounded comparison."
    );
    const candidateRows = [...distractors, exactTitle];

    const audit = await runTopicDiscoverySemanticAudit({
      llm: new EchoingUncertainLlm(),
      rows: candidateRows,
      searchFamilies: [searchFamily],
      lexicalMatchedFamilyIdsByPaper: matches([]),
      providerCandidatePaperIdsByFamily: new Map([[
        "family-a",
        candidateRows.map((row) => row.paper_id)
      ]])
    });

    const requestedIds = audit.reviewer_input_payload.requested_pairs.map(
      (pair) => pair.paper_id
    );
    expect(requestedIds).toHaveLength(8);
    expect(requestedIds[0]).toBe("exact-title-object");
    expect(requestedIds.filter((paperId) => paperId.startsWith("loose-body-"))).toHaveLength(7);
  });

  it("does not promote an unprovenanced provider candidate into semantic review", async () => {
    const audit = await runTopicDiscoverySemanticAudit({
      llm: new EchoingUncertainLlm(),
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([["paper-a", "family-a"]]),
      providerCandidatePaperIdsByFamily: new Map([
        ["family-a", ["paper-b", "paper-c"]]
      ])
    });

    expect(audit.reviewer_input_payload.requested_pairs).toEqual([
      { paper_id: "paper-a", family_id: "family-a", selection_source: "lexical_match" },
      { paper_id: "paper-b", family_id: "family-a", selection_source: "provider_provenance_floor" },
      { paper_id: "paper-c", family_id: "family-a", selection_source: "provider_provenance_floor" }
    ]);
    expect(audit.reviewer_input_payload.requested_pairs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family_id: "family-b" })
      ])
    );
  });

  it("returns operational failure and all uncertain when structured parsing fails", async () => {
    const raw = "not structured JSON";
    const audit = await runTopicDiscoverySemanticAudit({
      llm: new CapturingLlm(raw),
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([
        ["paper-a", "family-a"],
        ["paper-b", "family-a"]
      ])
    });

    expect(audit.status).toBe("operational_failure");
    expect(audit.reasons).toContain("semantic_audit_parse_failure");
    expect(audit.judgments).toHaveLength(2);
    expect(audit.judgments.every((item) => item.verdict === "uncertain")).toBe(true);
    expect(audit.response_sha256).toBe(hash(raw));
    expect(audit).not.toHaveProperty("raw_response");
  });

  it("recovers a frozen twelve-pair payload as three canonical four-pair partitions", async () => {
    const searchFamilies = Array.from({ length: 3 }, (_, familyIndex) => ({
      queryFamily: `family-${familyIndex + 1}`,
      query: `structured evaluation axis ${familyIndex + 1}`,
      axisTerms: ["axis", String(familyIndex + 1)],
      lens: `family lens ${familyIndex + 1}`,
      contributionIntent: `measure family ${familyIndex + 1}`
    }));
    const candidateRows = searchFamilies.flatMap((family, familyIndex) =>
      Array.from({ length: 4 }, (_, paperIndex) => paper(
        `paper-${familyIndex + 1}-${paperIndex + 1}`,
        `Structured evaluation candidate ${familyIndex + 1}-${paperIndex + 1}`
      ))
    );
    const providerCandidates = new Map(searchFamilies.map((family, familyIndex) => [
      family.queryFamily,
      candidateRows
        .slice(familyIndex * 4, familyIndex * 4 + 4)
        .map((row) => row.paper_id)
    ] as const));
    const llm = new TimeoutThenEchoingLlm();

    const audit = await runTopicDiscoverySemanticAudit({
      llm,
      rows: candidateRows,
      searchFamilies,
      lexicalMatchedFamilyIdsByPaper: matches([]),
      providerCandidatePaperIdsByFamily: providerCandidates,
      timeoutMs: 2
    });

    expect(audit.status).toBe("complete");
    expect(llm.calls.map(reviewerPairCount)).toEqual([12, 4, 4, 4]);
    expect(audit.execution).toMatchObject({
      calls_started: 4,
      calls_completed: 3,
      fallback_partition_size: 4,
      calls: [
        { mode: "primary", pair_start_index: 0, pair_end_index_exclusive: 12, outcome: "timeout" },
        { mode: "timeout_partition", pair_start_index: 0, pair_end_index_exclusive: 4, outcome: "complete" },
        { mode: "timeout_partition", pair_start_index: 4, pair_end_index_exclusive: 8, outcome: "complete" },
        { mode: "timeout_partition", pair_start_index: 8, pair_end_index_exclusive: 12, outcome: "complete" }
      ]
    });
    expect(audit.counts.uncertain).toBe(12);
    expect(audit.execution.cumulative_reviewer_input_bytes).toBe(
      audit.execution.calls.reduce(
        (sum, call) => sum + call.reviewer_input_bytes,
        0
      )
    );
  });

  it("propagates parent abort without starting a fallback partition", async () => {
    const controller = new AbortController();
    controller.abort();
    const llm = new CapturingLlm(response([]));

    await expect(runTopicDiscoverySemanticAudit({
      llm,
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([["paper-a", "family-a"]]),
      abortSignal: controller.signal
    })).rejects.toThrow("semantic_audit_parent_aborted");
    expect(llm.calls).toHaveLength(0);
  });

  it("classifies timeout and LLM rejection as operational failures", async () => {
    const base = {
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([["paper-a", "family-a"]])
    };
    const timeoutLlm = new HangingLlm();
    const timeout = await runTopicDiscoverySemanticAudit({
      llm: timeoutLlm,
      ...base,
      timeoutMs: 2
    });
    const rejected = await runTopicDiscoverySemanticAudit({
      llm: { async complete() { throw new Error("provider unavailable"); } },
      ...base
    });

    expect(timeout.status).toBe("operational_failure");
    expect(timeout.reasons).toContain("semantic_audit_timeout_partitions_exhausted");
    expect(timeout.execution.calls_started).toBe(2);
    expect(timeoutLlm.calls).toBe(2);
    expect(rejected.status).toBe("operational_failure");
    expect(rejected.reasons).toContain("semantic_audit_llm_failure");
    expect(rejected.execution.calls_started).toBe(1);
  });

  it("produces deterministic prompt, response hashes, and canonical payloads", async () => {
    const raw = response([
      judgment(
        "paper-a",
        "family-a",
        "direct_support",
        "The central contribution matches.",
        "Consistency assessment"
      )
    ]);
    const firstLlm = new CapturingLlm(raw);
    const secondLlm = new CapturingLlm(raw);
    const base = {
      rows: rows(),
      searchFamilies: families(),
      lexicalMatchedFamilyIdsByPaper: matches([["paper-a", "family-a"]])
    };

    const first = await runTopicDiscoverySemanticAudit({ llm: firstLlm, ...base });
    const second = await runTopicDiscoverySemanticAudit({ llm: secondLlm, ...base });

    expect(first.prompt_sha256).toBe(hash(firstLlm.calls[0]!.prompt));
    expect(first.response_sha256).toBe(hash(raw));
    expect(second.prompt_sha256).toBe(first.prompt_sha256);
    expect(second.response_sha256).toBe(first.response_sha256);
    expect(second.reviewer_input_payload).toEqual(first.reviewer_input_payload);
    expect(second).toEqual(first);
  });
});

class CapturingLlm implements LLMClient {
  readonly calls: Array<{ prompt: string; options?: LLMCompleteOptions }> = [];
  constructor(private readonly raw: string) {}
  async complete(prompt: string, options?: LLMCompleteOptions): Promise<{ text: string }> {
    this.calls.push({ prompt, options });
    return { text: this.raw };
  }
}

class HangingLlm implements LLMClient {
  calls = 0;
  async complete(_prompt: string, options?: LLMCompleteOptions): Promise<{ text: string }> {
    this.calls += 1;
    return await new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
}

class TimeoutThenEchoingLlm implements LLMClient {
  readonly calls: string[] = [];

  async complete(prompt: string, options?: LLMCompleteOptions): Promise<{ text: string }> {
    this.calls.push(prompt);
    if (this.calls.length === 1) {
      return await new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true }
        );
      });
    }
    const payload = reviewerPayload(prompt);
    return {
      text: response(payload.requested_pairs.map((pair) => ({
        ...pair,
        verdict: "uncertain",
        reason: "The supplied metadata is inconclusive."
      })))
    };
  }
}

class EchoingUncertainLlm implements LLMClient {
  async complete(prompt: string): Promise<{ text: string }> {
    const marker = "Input:\n";
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as {
      requested_pairs: Array<{ paper_id: string; family_id: string }>;
    };
    return {
      text: response(payload.requested_pairs.map((pair) => ({
        ...pair,
        verdict: "uncertain",
        reason: "The supplied metadata is inconclusive."
      })))
    };
  }
}

function families(): TopicDiscoverySemanticSearchFamilyContract[] {
  return [
    {
      queryFamily: "family-a",
      query: "structured records consistency assessment",
      sharedAnchorTerms: ["structured", "records"],
      axisTerms: ["consistency", "assessment"],
      lens: "consistency of structured records",
      contributionIntent: "measure and improve consistency assessment"
    },
    {
      queryFamily: "family-b",
      query: "structured records transfer analysis",
      sharedAnchorTerms: ["structured", "records"],
      axisTerms: ["transfer", "analysis"],
      lens: "transfer behavior across record formats",
      contributionIntent: "characterize transfer behavior"
    }
  ];
}

function rows(): StoredCorpusRow[] {
  return [
    paper("paper-a", "Consistency assessment for structured records"),
    paper("paper-b", "A compiler evaluated on structured-record consistency"),
    paper("paper-c", "Transfer observations in record processing"),
    paper("paper-d", "A workflow using record-format transfer"),
    paper("paper-e", "Transfer behavior in record conversion")
  ];
}

function paper(
  paperId: string,
  title: string,
  abstract = `${title}. The study reports controlled evidence.`
): StoredCorpusRow {
  return { paper_id: paperId, title, abstract, authors: ["Fixture Author"] };
}

function matches(
  pairs: Array<readonly [string, string]>
): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>();
  for (const [paperId, familyId] of pairs) {
    const familyIds = result.get(paperId) ?? new Set<string>();
    familyIds.add(familyId);
    result.set(paperId, familyIds);
  }
  return result;
}

function response(judgments: unknown[]): string {
  return JSON.stringify({ judgments });
}

function reviewerPayload(prompt: string): {
  requested_pairs: Array<{ paper_id: string; family_id: string }>;
} {
  const marker = "Input:\n";
  return JSON.parse(
    prompt.slice(prompt.lastIndexOf(marker) + marker.length)
  ) as {
    requested_pairs: Array<{ paper_id: string; family_id: string }>;
  };
}

function reviewerPairCount(prompt: string): number {
  return reviewerPayload(prompt).requested_pairs.length;
}

function judgment(
  paperId: string,
  familyId: string,
  verdict: "direct_support" | "application_only" | "uncertain",
  reason: string,
  evidenceSpan?: string
) {
  return {
    paper_id: paperId,
    family_id: familyId,
    verdict,
    reason,
    ...(evidenceSpan === undefined ? {} : { evidence_span: evidenceSpan })
  };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
