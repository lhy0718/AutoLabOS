import { describe, expect, it } from "vitest";

import {
  buildJudgeCandidateOrder,
  parsePaperAnalysisComparisonJudgeJson,
  selectPapersForComparison
} from "../src/core/analysis/paperAnalysisComparison.js";
import { AnalysisCorpusRow } from "../src/core/analysis/paperText.js";

function makePaper(overrides: Partial<AnalysisCorpusRow> = {}): AnalysisCorpusRow {
  return {
    paper_id: overrides.paper_id ?? "paper-1",
    title: overrides.title ?? "Paper One",
    abstract: overrides.abstract ?? "Abstract text",
    authors: overrides.authors ?? ["Alice"],
    pdf_url: overrides.pdf_url,
    url: overrides.url,
    citation_count: overrides.citation_count,
    year: overrides.year
  };
}

describe("paperAnalysisComparison", () => {
  it("selects manifest papers with PDFs first", () => {
    const selection = selectPapersForComparison({
      corpusRows: [
        makePaper({ paper_id: "p1", pdf_url: "https://example.com/p1.pdf" }),
        makePaper({ paper_id: "p2" }),
        makePaper({ paper_id: "p3", pdf_url: "https://example.com/p3.pdf" })
      ],
      selectedPaperIds: ["p2", "p3", "missing", "p1"],
      limit: 2
    });

    expect(selection.selectionSource).toBe("analysis_manifest");
    expect(selection.papers.map((paper) => paper.paper_id)).toEqual(["p3", "p1"]);
    expect(selection.skipped).toEqual([
      { paper_id: "p2", title: "Paper One", reason: "no_pdf_url" },
      { paper_id: "missing", title: "missing", reason: "missing_from_corpus" }
    ]);
  });

  it("falls back to citation-sorted corpus selection", () => {
    const selection = selectPapersForComparison({
      corpusRows: [
        makePaper({ paper_id: "p1", pdf_url: "https://example.com/p1.pdf", citation_count: 5 }),
        makePaper({ paper_id: "p2", pdf_url: "https://example.com/p2.pdf", citation_count: 12 }),
        makePaper({ paper_id: "p3", citation_count: 30 })
      ],
      limit: 2
    });

    expect(selection.selectionSource).toBe("corpus_fallback");
    expect(selection.papers.map((paper) => paper.paper_id)).toEqual(["p2", "p1"]);
    expect(selection.skipped).toEqual([{ paper_id: "p3", title: "Paper One", reason: "no_pdf_url" }]);
  });

  it("parses blind judge output and maps the winner back to modes", () => {
    const order = buildJudgeCandidateOrder("paper-judge");
    const result = parsePaperAnalysisComparisonJudgeJson(
      [
        "```json",
        JSON.stringify({
          winner: "A",
          candidate_a: {
            faithfulness: 5,
            coverage: 4,
            visual_grounding: 4,
            specificity: 5,
            overall: 5,
            strengths: ["More complete"],
            weaknesses: []
          },
          candidate_b: {
            faithfulness: 3,
            coverage: 3,
            visual_grounding: 2,
            specificity: 3,
            overall: 3,
            strengths: [],
            weaknesses: ["Missed tables"]
          },
          rationale: "Candidate A is more faithful."
        }),
        "```"
      ].join("\n"),
      order
    );

    expect(result.winner).toBe(order.candidateA);
    expect(result.rationale).toContain("more faithful");
    expect(result.codex.overall === 5 || result.api.overall === 5).toBe(true);
  });
});
