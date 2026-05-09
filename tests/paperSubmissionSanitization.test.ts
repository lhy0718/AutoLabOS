import { describe, expect, it } from "vitest";

import {
  buildPaperBibtex,
  buildFallbackPaperDraft,
  PaperWritingBundle
} from "../src/core/analysis/paperWriting.js";
import {
  buildFallbackPaperManuscript,
  buildPaperSubmissionValidation,
  buildPaperTraceability,
  normalizePaperManuscript,
  parsePaperManuscriptJson,
  renderSubmissionPaperTex
} from "../src/core/analysis/paperManuscript.js";

describe("paper submission sanitization", () => {
  it("removes internal run paths from fallback paper drafting before submission validation", () => {
    const bundle: PaperWritingBundle = {
      runTitle: "Budget-aware run",
      topic: "Efficient test-time reasoning for small language models",
      objectiveMetric: "accuracy_delta_vs_baseline > 0",
      constraints: [
        "provider/tooling constraints: keep auditable artifacts under `.autolabos/` and `outputs/` within the active workspace."
      ],
      paperSummaries: [
        {
          paper_id: "paper_1",
          title: "Schema Bench",
          source_type: "full_text",
          summary: "Structured coordination improves reproducibility.",
          key_findings: ["Structured coordination improves reproducibility."],
          limitations: [],
          datasets: ["AgentBench-mini"],
          metrics: ["reproducibility_score"],
          novelty: "Persistent coordination state",
          reproducibility_notes: ["Repeated trials are reported."]
        }
      ],
      evidenceRows: [
        {
          evidence_id: "ev_1",
          paper_id: "paper_1",
          claim: "Structured coordination improves reproducibility.",
          method_slot: "shared state schema",
          result_slot: "higher reproducibility_score",
          limitation_slot: "small benchmark",
          dataset_slot: "AgentBench-mini",
          metric_slot: "reproducibility_score",
          evidence_span: "Repeated trials improved reproducibility_score.",
          source_type: "full_text",
          confidence: 0.9
        }
      ],
      hypotheses: [
        {
          hypothesis_id: "h_1",
          text: "Persistent coordination improves reproducibility.",
          evidence_links: ["ev_1"]
        }
      ],
      corpus: [
        {
          paper_id: "paper_1",
          title: "Schema Bench",
          abstract: "Structured coordination improves reproducibility.",
          authors: ["Alice Doe"],
          year: 2025,
          venue: "ACL"
        } as any
      ],
      experimentPlan: {
        selectedTitle: "Schema benchmark",
        selectedSummary: "Compare persistent schemas with a baseline.",
        rawText: ""
      },
      resultAnalysis: {
        objective_metric: {
          evaluation: {
            summary: "Objective metric met: reproducibility_score=0.88 >= 0.8."
          }
        }
      } as any
    };

    const draft = buildFallbackPaperDraft(bundle);
    const manuscript = buildFallbackPaperManuscript({
      draft,
      resultAnalysis: bundle.resultAnalysis
    });
    const traceability = buildPaperTraceability({ draft, manuscript });
    const citations = new Map([["paper_1", "paper1"]]);
    const tex = renderSubmissionPaperTex({
      manuscript,
      traceability,
      citationKeysByPaperId: citations
    });
    const validation = buildPaperSubmissionValidation({
      manuscript,
      tex,
      traceability,
      citationKeysByPaperId: citations
    });

    expect(JSON.stringify({ draft, manuscript, tex })).not.toContain(".autolabos/");
    expect(validation.issues.some((issue) => issue.kind === "absolute_path")).toBe(false);
  });

  it("rewrites DOI or URL shaped BibTeX keys to safe citation identifiers", () => {
    const bibtex = buildPaperBibtex(
      [
        {
          paper_id: "paper_qlora",
          title: "QLoRA: Efficient Finetuning of Quantized LLMs",
          abstract: "QLoRA enables memory-efficient finetuning.",
          authors: ["Tim Dettmers"],
          year: 2023,
          venue: "NeurIPS",
          bibtex: [
            "@article{https://doi.org/10.48550/arXiv.2305.14314,",
            "  title={QLoRA: Efficient Finetuning of Quantized LLMs},",
            "  author={Tim Dettmers},",
            "  year={2023}",
            "}"
          ].join("\n")
        } as any
      ],
      ["paper_qlora"]
    );

    const key = bibtex.citationKeysByPaperId.get("paper_qlora");
    expect(key).toBe("dettmers_2023_qlora_efficient");
    expect(bibtex.references).toContain("@article{dettmers_2023_qlora_efficient,");
    expect(bibtex.references).not.toContain("@article{https://doi.org");
  });

  it("removes raw DOI and opaque paper identifiers from normalized manuscript prose", () => {
    const draft = buildFallbackPaperDraft({
      runTitle: "LoRA benchmark",
      topic: "LoRA rank/dropout benchmark",
      objectiveMetric: "accuracy_delta_vs_baseline > 0",
      constraints: [],
      paperSummaries: [],
      evidenceRows: [],
      hypotheses: [],
      corpus: [],
      experimentPlan: { selectedTitle: "LoRA benchmark", selectedSummary: "Compare conditions.", rawText: "" }
    } as any);
    const manuscript = normalizePaperManuscript({
      raw: {
        title: "A LoRA Benchmark",
        abstract: "A cautious benchmark (doi:10.48550/arxiv.2305.14314; arXiv:2305.14314; 15a1c2d8eb2c55e3ceb9ce9f72b3446ac1eb183a).",
        keywords: ["LoRA"],
        sections: [
          {
            heading: "Introduction",
            paragraphs: [
              "Prior PEFT work motivates this setup (e.g., doi:10.48550/arxiv.2305.14314; 75bc30bf394625c784ea59f8c2fe04718a4b4042)."
            ]
          }
        ]
      },
      draft
    });

    const text = JSON.stringify(manuscript);
    expect(text).not.toContain("doi:");
    expect(text).not.toContain("arXiv:2305.14314");
    expect(text).not.toContain("15a1c2d8eb2c55e3ceb9ce9f72b3446ac1eb183a");
    expect(text).not.toContain("75bc30bf394625c784ea59f8c2fe04718a4b4042");
  });

  it("sanitizes wrapped revised manuscript repair prose", () => {
    const draft = buildFallbackPaperDraft({
      runTitle: "LoRA benchmark",
      topic: "LoRA rank/dropout benchmark",
      objectiveMetric: "accuracy_delta_vs_baseline > 0",
      constraints: [],
      paperSummaries: [],
      evidenceRows: [],
      hypotheses: [],
      corpus: [],
      experimentPlan: { selectedTitle: "LoRA benchmark", selectedSummary: "Compare conditions.", rawText: "" }
    } as any);
    const raw = parsePaperManuscriptJson(JSON.stringify({
      revised_manuscript: {
        title: "A LoRA Benchmark",
        abstract: "A cautious benchmark.",
        sections: [
          {
            heading: "Related Work",
            paragraphs: [
              "Prior work motivates this comparison (doi:10.48550/arxiv.2305.14314; 75bc30bf394625c784ea59f8c2fe04718a4b4042)."
            ]
          }
        ]
      }
    }));
    const manuscript = normalizePaperManuscript({ raw, draft });

    const text = JSON.stringify(manuscript);
    expect(text).not.toContain("doi:");
    expect(text).not.toContain("75bc30bf394625c784ea59f8c2fe04718a4b4042");
  });
});
