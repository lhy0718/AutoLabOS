import { describe, expect, it } from "vitest";

import {
  buildRelatedWorkBrief,
  buildRelatedWorkNotes,
  PaperWritingBundle,
  validatePaperDraft
} from "../src/core/analysis/paperWriting.js";

function makeBundle(): PaperWritingBundle {
  return {
    runTitle: "Related Work Upgrade",
    topic: "agent collaboration",
    objectiveMetric: "reproducibility_score >= 0.8",
    constraints: ["formal tone"],
    paperSummaries: [
      {
        paper_id: "paper_1",
        title: "Stateful Agent Coordination",
        source_type: "full_text",
        summary: "Stateful coordination improves revision stability in collaborative agents.",
        key_findings: ["Stateful coordination improves revision stability."],
        limitations: ["Evaluation uses a small benchmark."],
        datasets: ["AgentBench-mini"],
        metrics: ["reproducibility_score"],
        novelty: "Stateful coordination for agent workflows",
        reproducibility_notes: ["Repeated trials are reported."]
      },
      {
        paper_id: "paper_2",
        title: "Benchmarking Multi-Agent Workflows",
        source_type: "full_text",
        summary: "Benchmark studies compare orchestration strategies across workflow settings.",
        key_findings: ["Benchmarking clarifies tradeoffs across orchestration strategies."],
        limitations: ["Coverage across domains remains limited."],
        datasets: ["WorkflowArena"],
        metrics: ["stability_score"],
        novelty: "Evaluation and benchmarking for workflow orchestration",
        reproducibility_notes: ["The benchmark is limited to a few domains."]
      }
    ],
    evidenceRows: [
      {
        evidence_id: "ev_1",
        paper_id: "paper_1",
        claim: "Stateful coordination improves revision stability.",
        method_slot: "stateful coordination",
        result_slot: "higher reproducibility_score",
        limitation_slot: "small benchmark",
        dataset_slot: "AgentBench-mini",
        metric_slot: "reproducibility_score",
        evidence_span: "Repeated trials improved reproducibility_score.",
        source_type: "full_text",
        confidence: 0.92
      }
    ],
    hypotheses: [
      {
        hypothesis_id: "h_1",
        text: "Stateful coordination improves reproducibility in agent collaboration workflows.",
        evidence_links: ["ev_1"],
        measurement_hint: "Track reproducibility_score over repeated runs."
      }
    ],
    corpus: [
      {
        paper_id: "paper_1",
        title: "Stateful Agent Coordination",
        authors: ["Alice Doe"],
        abstract: "Stateful coordination improves revision stability in collaborative agents.",
        venue: "ACL",
        year: 2025,
        citation_count: 42
      },
      {
        paper_id: "paper_2",
        title: "Benchmarking Multi-Agent Workflows",
        authors: ["Bob Doe"],
        abstract: "Benchmark studies compare orchestration strategies across workflow settings.",
        venue: "EMNLP",
        year: 2024,
        citation_count: 35
      },
      {
        paper_id: "paper_scout_1",
        title: "Related Work Coverage Backfill",
        authors: ["Sam Scout"],
        abstract: "Scout metadata broadens the related-work framing for agent collaboration.",
        venue: "NAACL",
        year: 2024,
        citation_count: 18
      }
    ],
    experimentPlan: {
      selectedTitle: "Thread-backed drafting benchmark",
      selectedSummary: "Compare stateful and stateless coordination strategies."
    },
    relatedWorkScout: {
      query: "agent collaboration thread-backed drafting benchmark reproducibility_score",
      rationale: "Backfill thin related-work coverage around stateful coordination and benchmarking.",
      papers: [
        {
          paper_id: "paper_scout_1",
          title: "Related Work Coverage Backfill",
          summary: "Scout metadata broadens the related-work framing for agent collaboration.",
          source_type: "semantic_scholar_scout",
          venue: "NAACL",
          year: 2024,
          citation_count: 18
        }
      ]
    }
  };
}

describe("paperWriting related-work support", () => {
  it("builds structured related-work notes and a two-paragraph brief", () => {
    const bundle = makeBundle();

    const notes = buildRelatedWorkNotes(bundle);
    const brief = buildRelatedWorkBrief(bundle);

    expect(notes).toHaveLength(3);
    expect(notes.some((item) => item.comparison_role === "closest")).toBe(true);
    expect(brief.comparison_axes.length).toBeGreaterThan(0);
    expect(brief.paragraph_plan).toHaveLength(2);
  });

  it("reconstructs a missing Related Work section from structured notes", () => {
    const bundle = makeBundle();

    const validation = validatePaperDraft({
      bundle,
      draft: {
        title: "A Draft Without Related Work",
        abstract: "A minimal draft.",
        keywords: ["agent collaboration"],
        sections: [
          {
            heading: "Introduction",
            paragraphs: [
              {
                text: "This study evaluates stateful coordination for agent collaboration.",
                evidence_ids: ["ev_1"],
                citation_paper_ids: ["paper_1"]
              }
            ],
            evidence_ids: ["ev_1"],
            citation_paper_ids: ["paper_1"]
          },
          {
            heading: "Method",
            paragraphs: [
              {
                text: "The benchmark compares stateful and stateless coordination.",
                evidence_ids: ["ev_1"],
                citation_paper_ids: ["paper_1"]
              }
            ],
            evidence_ids: ["ev_1"],
            citation_paper_ids: ["paper_1"]
          },
          {
            heading: "Results",
            paragraphs: [
              {
                text: "Stateful coordination improved reproducibility_score.",
                evidence_ids: ["ev_1"],
                citation_paper_ids: ["paper_1"]
              }
            ],
            evidence_ids: ["ev_1"],
            citation_paper_ids: ["paper_1"]
          }
        ],
        claims: []
      }
    });

    const relatedWork = validation.draft.sections.find((item) => item.heading === "Related Work");
    expect(relatedWork).toBeDefined();
    expect(relatedWork?.paragraphs).toHaveLength(2);
    expect(relatedWork?.citation_paper_ids).toEqual(
      expect.arrayContaining(["paper_1", "paper_2", "paper_scout_1"])
    );
    expect(validation.issues.some((item) => /reconstructed from related-work notes/i.test(item.message))).toBe(true);
  });
});
