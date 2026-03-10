import { createHash } from "node:crypto";

import { AnalysisCorpusRow, resolvePaperPdfUrl } from "./paperText.js";
import { PaperAnalysisResult } from "./paperAnalyzer.js";

export interface AnalysisComparisonSkip {
  paper_id: string;
  title: string;
  reason: "no_pdf_url" | "missing_from_corpus";
}

export interface AnalysisComparisonSelection {
  papers: AnalysisCorpusRow[];
  skipped: AnalysisComparisonSkip[];
  selectionSource: "analysis_manifest" | "corpus_fallback";
}

export interface AnalysisResultDigest {
  source_type: "full_text" | "abstract";
  attempts: number;
  summary: string;
  key_findings: string[];
  limitations: string[];
  datasets: string[];
  metrics: string[];
  novelty: string;
  reproducibility_notes: string[];
  evidence_items: Array<{
    claim: string;
    method_slot: string;
    result_slot: string;
    limitation_slot: string;
    dataset_slot: string;
    metric_slot: string;
    evidence_span: string;
    confidence: number;
  }>;
}

export interface AnalysisResultStats {
  sourceType: "full_text" | "abstract";
  summaryChars: number;
  keyFindingCount: number;
  limitationCount: number;
  datasetCount: number;
  metricCount: number;
  reproducibilityNoteCount: number;
  evidenceCount: number;
  evidenceWithClaimCount: number;
  evidenceWithResultCount: number;
  averageConfidence: number;
}

export interface AnalysisJudgeScoreCard {
  faithfulness: number;
  coverage: number;
  visual_grounding: number;
  specificity: number;
  overall: number;
  strengths: string[];
  weaknesses: string[];
}

export interface AnalysisJudgeResult {
  winner: "codex" | "api" | "tie";
  codex: AnalysisJudgeScoreCard;
  api: AnalysisJudgeScoreCard;
  rationale: string;
}

interface RawJudgeScoreCard {
  faithfulness?: unknown;
  coverage?: unknown;
  visual_grounding?: unknown;
  specificity?: unknown;
  overall?: unknown;
  strengths?: unknown;
  weaknesses?: unknown;
}

interface RawJudgeResponse {
  winner?: unknown;
  candidate_a?: unknown;
  candidate_b?: unknown;
  rationale?: unknown;
}

export function selectPapersForComparison(args: {
  corpusRows: AnalysisCorpusRow[];
  selectedPaperIds?: string[];
  limit: number;
}): AnalysisComparisonSelection {
  const limit = Math.max(1, args.limit);
  const byId = new Map(args.corpusRows.map((row) => [row.paper_id, row]));
  const skipped: AnalysisComparisonSkip[] = [];

  if ((args.selectedPaperIds?.length ?? 0) > 0) {
    const papers: AnalysisCorpusRow[] = [];
    for (const paperId of args.selectedPaperIds || []) {
      const row = byId.get(paperId);
      if (!row) {
        skipped.push({ paper_id: paperId, title: paperId, reason: "missing_from_corpus" });
        continue;
      }
      if (!resolvePaperPdfUrl(row)) {
        skipped.push({ paper_id: row.paper_id, title: row.title, reason: "no_pdf_url" });
        continue;
      }
      papers.push(row);
      if (papers.length >= limit) {
        break;
      }
    }
    return {
      papers,
      skipped,
      selectionSource: "analysis_manifest"
    };
  }

  const ordered = [...args.corpusRows].sort((left, right) => {
    const citationDelta = (right.citation_count ?? 0) - (left.citation_count ?? 0);
    if (citationDelta !== 0) {
      return citationDelta;
    }
    const yearDelta = (right.year ?? 0) - (left.year ?? 0);
    if (yearDelta !== 0) {
      return yearDelta;
    }
    return left.paper_id.localeCompare(right.paper_id);
  });

  const papers: AnalysisCorpusRow[] = [];
  for (const row of ordered) {
    if (!resolvePaperPdfUrl(row)) {
      skipped.push({ paper_id: row.paper_id, title: row.title, reason: "no_pdf_url" });
      continue;
    }
    papers.push(row);
    if (papers.length >= limit) {
      break;
    }
  }

  return {
    papers,
    skipped,
    selectionSource: "corpus_fallback"
  };
}

export function buildAnalysisResultDigest(result: PaperAnalysisResult): AnalysisResultDigest {
  return {
    source_type: result.summaryRow.source_type,
    attempts: result.attempts,
    summary: result.summaryRow.summary,
    key_findings: result.summaryRow.key_findings,
    limitations: result.summaryRow.limitations,
    datasets: result.summaryRow.datasets,
    metrics: result.summaryRow.metrics,
    novelty: result.summaryRow.novelty,
    reproducibility_notes: result.summaryRow.reproducibility_notes,
    evidence_items: result.evidenceRows.slice(0, 12).map((item) => ({
      claim: item.claim,
      method_slot: item.method_slot,
      result_slot: item.result_slot,
      limitation_slot: item.limitation_slot,
      dataset_slot: item.dataset_slot,
      metric_slot: item.metric_slot,
      evidence_span: item.evidence_span,
      confidence: item.confidence
    }))
  };
}

export function computeAnalysisResultStats(result: PaperAnalysisResult): AnalysisResultStats {
  const confidenceValues = result.evidenceRows
    .map((row) => row.confidence)
    .filter((value) => Number.isFinite(value));
  const averageConfidence =
    confidenceValues.length > 0
      ? Number(
          (confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length).toFixed(4)
        )
      : 0;

  return {
    sourceType: result.summaryRow.source_type,
    summaryChars: result.summaryRow.summary.length,
    keyFindingCount: result.summaryRow.key_findings.length,
    limitationCount: result.summaryRow.limitations.length,
    datasetCount: result.summaryRow.datasets.length,
    metricCount: result.summaryRow.metrics.length,
    reproducibilityNoteCount: result.summaryRow.reproducibility_notes.length,
    evidenceCount: result.evidenceRows.length,
    evidenceWithClaimCount: result.evidenceRows.filter((row) => Boolean(row.claim.trim())).length,
    evidenceWithResultCount: result.evidenceRows.filter((row) => Boolean(row.result_slot.trim())).length,
    averageConfidence
  };
}

export function buildJudgeCandidateOrder(paperId: string): {
  candidateA: "codex" | "api";
  candidateB: "codex" | "api";
} {
  const hash = createHash("sha256").update(paperId).digest("hex");
  return Number.parseInt(hash.slice(0, 2), 16) % 2 === 0
    ? { candidateA: "codex", candidateB: "api" }
    : { candidateA: "api", candidateB: "codex" };
}

export function buildPaperAnalysisComparisonJudgePrompt(args: {
  paper: AnalysisCorpusRow;
  candidateA: AnalysisResultDigest;
  candidateB: AnalysisResultDigest;
}): string {
  return [
    "Compare two structured analyses of the attached paper PDF.",
    "Judge them against the PDF itself, not against each other alone.",
    "Prefer factual faithfulness, coverage of core findings and limitations, recovery of table/figure details when relevant, and concrete structured evidence.",
    "Candidate labels are blind. Do not assume either candidate is better because of formatting.",
    "Return one JSON object with this exact shape:",
    "{",
    '  "winner": "A" | "B" | "tie",',
    '  "candidate_a": {',
    '    "faithfulness": 1-5,',
    '    "coverage": 1-5,',
    '    "visual_grounding": 1-5,',
    '    "specificity": 1-5,',
    '    "overall": 1-5,',
    '    "strengths": ["string"],',
    '    "weaknesses": ["string"]',
    "  },",
    '  "candidate_b": {',
    '    "faithfulness": 1-5,',
    '    "coverage": 1-5,',
    '    "visual_grounding": 1-5,',
    '    "specificity": 1-5,',
    '    "overall": 1-5,',
    '    "strengths": ["string"],',
    '    "weaknesses": ["string"]',
    "  },",
    '  "rationale": "string"',
    "}",
    "",
    `Paper ID: ${args.paper.paper_id}`,
    `Title: ${args.paper.title}`,
    `Abstract: ${args.paper.abstract || "unavailable"}`,
    "",
    "Candidate A:",
    JSON.stringify(args.candidateA, null, 2),
    "",
    "Candidate B:",
    JSON.stringify(args.candidateB, null, 2)
  ].join("\n");
}

export function parsePaperAnalysisComparisonJudgeJson(
  text: string,
  candidateOrder: { candidateA: "codex" | "api"; candidateB: "codex" | "api" }
): AnalysisJudgeResult {
  const parsed = parseLooseJsonObject(text) as RawJudgeResponse;
  const candidateAScore = normalizeJudgeScoreCard(parsed.candidate_a);
  const candidateBScore = normalizeJudgeScoreCard(parsed.candidate_b);
  const winner = normalizeWinner(parsed.winner, candidateOrder);

  return {
    winner,
    codex: candidateOrder.candidateA === "codex" ? candidateAScore : candidateBScore,
    api: candidateOrder.candidateA === "api" ? candidateAScore : candidateBScore,
    rationale: cleanString(parsed.rationale) || "No rationale provided."
  };
}

function normalizeJudgeScoreCard(value: unknown): AnalysisJudgeScoreCard {
  const raw = (value as RawJudgeScoreCard | undefined) || {};
  return {
    faithfulness: normalizeJudgeScore(raw.faithfulness),
    coverage: normalizeJudgeScore(raw.coverage),
    visual_grounding: normalizeJudgeScore(raw.visual_grounding),
    specificity: normalizeJudgeScore(raw.specificity),
    overall: normalizeJudgeScore(raw.overall),
    strengths: normalizeStringArray(raw.strengths),
    weaknesses: normalizeStringArray(raw.weaknesses)
  };
}

function normalizeJudgeScore(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(5, Number(parsed)));
}

function normalizeWinner(
  value: unknown,
  candidateOrder: { candidateA: "codex" | "api"; candidateB: "codex" | "api" }
): "codex" | "api" | "tie" {
  const normalized = cleanString(value)?.toLowerCase();
  if (!normalized || normalized === "tie") {
    return "tie";
  }
  if (normalized === "a" || normalized === "candidate_a") {
    return candidateOrder.candidateA;
  }
  if (normalized === "b" || normalized === "candidate_b") {
    return candidateOrder.candidateB;
  }
  if (normalized === "codex" || normalized === "api") {
    return normalized;
  }
  return "tie";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => cleanString(item))
    .filter((item): item is string => Boolean(item));
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseLooseJsonObject(text: string): Record<string, unknown> {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    throw new Error("empty judge response");
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }

  if (trimmed.includes("```")) {
    for (const part of trimmed.split("```")) {
      const candidate = part.trim().replace(/^json/u, "").trim();
      if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
        continue;
      }
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const parsed = JSON.parse(trimmed.slice(first, last + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }

  throw new Error("judge response did not contain a JSON object");
}
