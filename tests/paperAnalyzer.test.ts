import { describe, expect, it, vi } from "vitest";

import {
  analyzePaperWithLlm,
  analyzePaperWithResponsesPdf,
  normalizePaperAnalysis,
  parsePaperAnalysisJson
} from "../src/core/analysis/paperAnalyzer.js";
import { MockLLMClient } from "../src/core/llm/client.js";
import { AnalysisCorpusRow, ResolvedPaperSource } from "../src/core/analysis/paperText.js";
import { ResponsesPdfAnalysisClient } from "../src/integrations/openai/responsesPdfAnalysisClient.js";

class SequenceLLM extends MockLLMClient {
  private index = 0;

  constructor(private readonly outputs: string[]) {
    super();
  }

  override async complete(_prompt: string): Promise<{ text: string }> {
    const next = this.outputs[Math.min(this.index, this.outputs.length - 1)] ?? "";
    this.index += 1;
    return { text: next };
  }
}

const paper: AnalysisCorpusRow = {
  paper_id: "paper-1",
  title: "Agentic Workflows for Science",
  abstract: "This paper studies agentic workflows and reports strong results.",
  authors: ["Alice Kim"],
  year: 2025,
  venue: "NeurIPS",
  citation_count: 42
};

const source: ResolvedPaperSource = {
  sourceType: "abstract",
  text: "Abstract: This paper studies agentic workflows and reports strong results.",
  fullTextAvailable: false,
  fallbackReason: "no_pdf_url"
};

describe("paperAnalyzer", () => {
  it("parses fenced JSON responses", () => {
    const parsed = parsePaperAnalysisJson('```json\n{"summary":"ok","evidence_items":[]}\n```');
    expect(parsed.summary).toBe("ok");
  });

  it("normalizes structured output into summary and evidence rows", () => {
    const normalized = normalizePaperAnalysis(paper, source, {
      summary: "A concise summary",
      key_findings: ["Finding A"],
      limitations: ["Limitation A"],
      datasets: ["Dataset A"],
      metrics: ["Accuracy"],
      novelty: "Novel contribution",
      reproducibility_notes: ["Code unavailable"],
      evidence_items: [
        {
          claim: "Agents improve performance.",
          method_slot: "Prompted agent workflow",
          result_slot: "Accuracy improved by 10%.",
          limitation_slot: "Only tested on one benchmark.",
          dataset_slot: "ScienceBench",
          metric_slot: "Accuracy",
          evidence_span: "This paper studies agentic workflows and reports strong results.",
          confidence: 0.8
        }
      ]
    });

    expect(normalized.summaryRow.summary).toBe("A concise summary");
    expect(normalized.summaryRow.key_findings).toEqual(["Finding A"]);
    expect(normalized.evidenceRows[0].claim).toBe("Agents improve performance.");
    expect(normalized.evidenceRows[0].source_type).toBe("abstract");
    expect(normalized.evidenceRows[0].confidence).toBe(0.8);
    expect(normalized.evidenceRows[0].confidence_reason).toBeUndefined();
  });

  it("retries once when the staged pipeline produces unusable JSON", async () => {
    const llm = new SequenceLLM([
      "not-json",
      "still-not-json",
      JSON.stringify({
        summary: "Recovered summary",
        key_findings: ["Recovered finding"],
        limitations: ["Recovered limitation"],
        datasets: ["Recovered dataset"],
        metrics: ["Recovered metric"],
        novelty: "Recovered novelty",
        reproducibility_notes: ["Recovered reproducibility note"],
        evidence_items: [{ claim: "Recovered claim", confidence: 0.7 }]
      })
    ]);

    const result = await analyzePaperWithLlm({
      llm,
      paper,
      source,
      maxAttempts: 2
    });

    expect(result.attempts).toBe(2);
    expect(result.summaryRow.summary).toBe("Recovered summary");
    expect(result.evidenceRows[0].claim).toBe("Recovered claim");
  });

  it("uses planner and reviewer stages to refine the final analysis", async () => {
    const llm = new SequenceLLM([
      JSON.stringify({
        focus_sections: ["method", "results"],
        target_claims: ["main result", "limitation"],
        extraction_priorities: ["prefer explicit metrics"],
        verification_checks: ["drop unsupported claims"],
        risk_flags: ["abstract may omit setup details"]
      }),
      JSON.stringify({
        summary: "Draft summary",
        key_findings: ["Draft finding"],
        limitations: ["Draft limitation"],
        datasets: ["Draft dataset"],
        metrics: ["Draft metric"],
        novelty: "Draft novelty",
        reproducibility_notes: ["Draft repro"],
        evidence_items: [{ claim: "Draft claim", evidence_span: "Draft span", confidence: 0.9 }]
      }),
      JSON.stringify({
        summary: "Reviewed summary",
        key_findings: ["Reviewed finding"],
        limitations: ["Reviewed limitation"],
        datasets: ["Reviewed dataset"],
        metrics: ["Reviewed metric"],
        novelty: "Reviewed novelty",
        reproducibility_notes: ["Reviewed repro"],
        evidence_items: [
          {
            claim: "Reviewed claim",
            evidence_span: "Reviewed summary",
            confidence: 0.6,
            confidence_reason: "Only the abstract supports this claim."
          }
        ]
      })
    ]);

    const result = await analyzePaperWithLlm({
      llm,
      paper,
      source,
      maxAttempts: 1
    });

    expect(result.attempts).toBe(1);
    expect(result.summaryRow.summary).toBe("Reviewed summary");
    expect(result.evidenceRows[0].claim).toBe("Reviewed claim");
    expect(result.evidenceRows[0].confidence_reason).toBe("Only the abstract supports this claim.");
  });

  it("logs reviewer confidence reductions with claim-level reasons", async () => {
    const progress: string[] = [];
    const llm = new SequenceLLM([
      JSON.stringify({
        focus_sections: ["results"],
        target_claims: ["main result"],
        extraction_priorities: ["prefer direct spans"],
        verification_checks: ["lower confidence when support is indirect"],
        risk_flags: []
      }),
      JSON.stringify({
        summary: "Draft summary",
        key_findings: ["Draft finding"],
        limitations: [],
        datasets: ["Draft dataset"],
        metrics: ["Draft metric"],
        novelty: "Draft novelty",
        reproducibility_notes: [],
        evidence_items: [
          {
            claim: "Claim A",
            evidence_span: "This paper studies agentic workflows and reports strong results.",
            confidence: 0.92
          }
        ]
      }),
      JSON.stringify({
        summary: "Reviewed summary",
        key_findings: ["Reviewed finding"],
        limitations: [],
        datasets: ["Draft dataset"],
        metrics: ["Draft metric"],
        novelty: "Reviewed novelty",
        reproducibility_notes: [],
        evidence_items: [
          {
            claim: "Claim A",
            evidence_span: "This paper studies agentic workflows and reports strong results.",
            confidence: 0.58,
            confidence_reason: "The available source only provides an abstract-level description."
          }
        ]
      })
    ]);

    const result = await analyzePaperWithLlm({
      llm,
      paper,
      source,
      maxAttempts: 1,
      onProgress: (message) => progress.push(message)
    });

    expect(result.evidenceRows[0].confidence_reason).toBe(
      "The available source only provides an abstract-level description."
    );
    expect(
      progress.some((message) =>
        message.includes('Reviewer lowered confidence for "Claim A"')
        && message.includes("abstract-level description")
      )
    ).toBe(true);
  });

  it("passes rendered PDF page images into hybrid LLM analysis", async () => {
    const llm = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          summary: "Hybrid summary",
          key_findings: ["Hybrid finding"],
          limitations: [],
          datasets: [],
          metrics: [],
          novelty: "Hybrid novelty",
          reproducibility_notes: [],
          evidence_items: [{ claim: "Hybrid claim", confidence: 0.8 }]
        })
      }))
    };

    const result = await analyzePaperWithLlm({
      llm: llm as any,
      paper,
      source: {
        sourceType: "full_text",
        text: "Full text with extracted content.",
        fullTextAvailable: true,
        pageImagePaths: ["/tmp/page-001.png", "/tmp/page-003.png"],
        pageImagePages: [1, 3]
      }
    });

    expect(result.summaryRow.summary).toBe("Hybrid summary");
    expect(llm.complete).toHaveBeenCalledWith(
      expect.stringContaining("Attached page numbers: 1, 3"),
      expect.objectContaining({
        inputImagePaths: ["/tmp/page-001.png", "/tmp/page-003.png"]
      })
    );
  });

  it("normalizes Responses API PDF analysis results", async () => {
    const client = {
      analyzePdf: async () => ({
        text: JSON.stringify({
          summary: "PDF summary",
          key_findings: ["PDF finding"],
          limitations: ["PDF limitation"],
          datasets: ["PDF dataset"],
          metrics: ["PDF metric"],
          novelty: "PDF novelty",
          reproducibility_notes: ["PDF repro"],
          evidence_items: [{ claim: "PDF claim", confidence: 0.9 }]
        })
      })
    } as unknown as ResponsesPdfAnalysisClient;

    const result = await analyzePaperWithResponsesPdf({
      client,
      paper,
      pdfUrl: "https://example.com/paper.pdf",
      model: "gpt-5.4"
    });

    expect(result.summaryRow.summary).toBe("PDF summary");
    expect(result.summaryRow.source_type).toBe("full_text");
    expect(result.evidenceRows[0].claim).toBe("PDF claim");
  });

  it("caps confidence when the evidence span is not grounded in the source text", () => {
    const normalized = normalizePaperAnalysis(paper, source, {
      summary: "A concise summary",
      key_findings: ["Finding A"],
      limitations: ["Limitation A"],
      datasets: ["Dataset A"],
      metrics: ["Accuracy"],
      novelty: "Novel contribution",
      reproducibility_notes: ["Code unavailable"],
      evidence_items: [
        {
          claim: "Agents improve performance.",
          method_slot: "Prompted agent workflow",
          result_slot: "Accuracy improved by 10%.",
          limitation_slot: "Only tested on one benchmark.",
          dataset_slot: "ScienceBench",
          metric_slot: "Accuracy",
          evidence_span: "This span does not appear in the source text.",
          confidence: 0.95
        }
      ]
    });

    expect(normalized.evidenceRows[0].confidence).toBe(0.45);
    expect(normalized.evidenceRows[0].confidence_reason).toContain("could not be grounded");
  });

  it("propagates abort during text LLM analysis", async () => {
    const controller = new AbortController();
    const llm = {
      complete: (_prompt: string, opts?: { abortSignal?: AbortSignal }) =>
        new Promise<{ text: string }>((_resolve, reject) => {
          opts?.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("Operation aborted by user")),
            { once: true }
          );
        })
    };

    const promise = analyzePaperWithLlm({
      llm: llm as any,
      paper,
      source,
      abortSignal: controller.signal
    });

    controller.abort();

    await expect(promise).rejects.toThrow("Operation aborted by user");
  });
});
