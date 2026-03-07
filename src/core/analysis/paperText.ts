import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ensureDir, fileExists } from "../../utils/fs.js";

const execFileAsync = promisify(execFile);
const MAX_SOURCE_CHARS = 16_000;

export interface AnalysisCorpusRow {
  paper_id: string;
  title: string;
  abstract: string;
  year?: number;
  venue?: string;
  url?: string;
  pdf_url?: string;
  authors: string[];
  citation_count?: number;
  influential_citation_count?: number;
  publication_date?: string;
  publication_types?: string[];
  fields_of_study?: string[];
}

export interface ResolvedPaperSource {
  sourceType: "full_text" | "abstract";
  text: string;
  fullTextAvailable: boolean;
  pdfUrl?: string;
  pdfCachePath?: string;
  textCachePath?: string;
  fallbackReason?: string;
}

export async function resolvePaperTextSource(args: {
  runId: string;
  paper: AnalysisCorpusRow;
  abortSignal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<ResolvedPaperSource> {
  const fallback = buildAbstractFallbackText(args.paper);
  const pdfUrl = resolvePaperPdfUrl(args.paper);
  if (!pdfUrl) {
    args.onProgress?.("No PDF URL found. Using abstract fallback.");
    return {
      sourceType: "abstract",
      text: fallback,
      fullTextAvailable: false,
      fallbackReason: "no_pdf_url"
    };
  }

  const cacheDir = path.join(".autoresearch", "runs", args.runId, "analysis_cache");
  const pdfCachePath = path.join(cacheDir, "pdfs", `${sanitizeFileStem(args.paper.paper_id)}.pdf`);
  const textCachePath = path.join(cacheDir, "texts", `${sanitizeFileStem(args.paper.paper_id)}.txt`);

  const cachedText = await readCachedText(textCachePath);
  if (cachedText) {
    args.onProgress?.("Reusing cached extracted full text.");
    return {
      sourceType: "full_text",
      text: cachedText,
      fullTextAvailable: true,
      pdfUrl,
      pdfCachePath,
      textCachePath
    };
  }

  try {
    args.onProgress?.("Downloading PDF for text extraction.");
    await downloadPdf(pdfUrl, pdfCachePath, args.abortSignal);
    args.onProgress?.("Extracting text from downloaded PDF.");
    const extracted = await extractPdfText(pdfCachePath, args.abortSignal);
    if (extracted) {
      await ensureDir(path.dirname(textCachePath));
      await fs.writeFile(textCachePath, extracted, "utf8");
      args.onProgress?.("PDF text extraction completed.");
      return {
        sourceType: "full_text",
        text: extracted,
        fullTextAvailable: true,
        pdfUrl,
        pdfCachePath,
        textCachePath
      };
    }
    args.onProgress?.("PDF extraction produced no usable text. Falling back to abstract.");
    return {
      sourceType: "abstract",
      text: fallback,
      fullTextAvailable: false,
      pdfUrl,
      pdfCachePath,
      textCachePath,
      fallbackReason: "pdf_extract_failed"
    };
  } catch (error) {
    args.onProgress?.(
      `PDF resolution failed (${error instanceof Error ? error.message : String(error)}). Falling back to abstract.`
    );
    return {
      sourceType: "abstract",
      text: fallback,
      fullTextAvailable: false,
      pdfUrl,
      pdfCachePath,
      textCachePath,
      fallbackReason: error instanceof Error ? error.message : String(error)
    };
  }
}

export function resolvePaperPdfUrl(paper: AnalysisCorpusRow): string | undefined {
  return toNonEmptyString(paper.pdf_url) || extractPdfLikeUrl(paper.url);
}

export function buildAbstractFallbackText(paper: AnalysisCorpusRow): string {
  const parts = [
    `Title: ${paper.title || "Untitled"}`,
    paper.year ? `Year: ${paper.year}` : undefined,
    paper.venue ? `Venue: ${paper.venue}` : undefined,
    paper.authors.length > 0 ? `Authors: ${paper.authors.join(", ")}` : undefined,
    paper.citation_count !== undefined ? `Citation count: ${paper.citation_count}` : undefined,
    paper.abstract ? `Abstract:\n${paper.abstract}` : "Abstract unavailable."
  ].filter(Boolean);

  return truncateText(parts.join("\n"), MAX_SOURCE_CHARS);
}

async function readCachedText(filePath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const trimmed = raw.trim();
    return trimmed ? truncateText(trimmed, MAX_SOURCE_CHARS) : undefined;
  } catch {
    return undefined;
  }
}

async function downloadPdf(url: string, filePath: string, abortSignal?: AbortSignal): Promise<void> {
  if (await fileExists(filePath)) {
    return;
  }
  const response = await fetch(url, {
    headers: {
      Accept: "application/pdf,*/*;q=0.8",
      "User-Agent": "AutoResearch/1.0.0"
    },
    signal: abortSignal
  });
  if (!response.ok) {
    throw new Error(`pdf_download_failed:${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, Buffer.from(arrayBuffer));
}

async function extractPdfText(filePath: string, abortSignal?: AbortSignal): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-layout", "-enc", "UTF-8", filePath, "-"], {
      signal: abortSignal,
      maxBuffer: 16 * 1024 * 1024
    });
    const normalized = truncateText(normalizeWhitespace(stdout), MAX_SOURCE_CHARS);
    return normalized || undefined;
  } catch {
    return undefined;
  }
}

function truncateText(text: string, maxChars: number): string {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trim()}\n[TRUNCATED]`;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function extractPdfLikeUrl(url: string | undefined): string | undefined {
  if (!url || !/\.pdf($|[?#])/i.test(url)) {
    return undefined;
  }
  return url;
}

function toNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
