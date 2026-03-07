import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalysisCorpusRow, resolvePaperTextSource } from "../src/core/analysis/paperText.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function makePaper(overrides: Partial<AnalysisCorpusRow> = {}): AnalysisCorpusRow {
  return {
    paper_id: overrides.paper_id ?? "paper-1",
    title: overrides.title ?? "Paper One",
    abstract: overrides.abstract ?? "Abstract text",
    authors: overrides.authors ?? ["Alice"],
    year: overrides.year,
    venue: overrides.venue,
    pdf_url: overrides.pdf_url,
    url: overrides.url,
    citation_count: overrides.citation_count
  };
}

describe("paperText", () => {
  it("falls back to abstract when no PDF URL exists", async () => {
    const source = await resolvePaperTextSource({
      runId: "run-1",
      paper: makePaper()
    });

    expect(source.sourceType).toBe("abstract");
    expect(source.fallbackReason).toBe("no_pdf_url");
    expect(source.text).toContain("Abstract:");
  });

  it("uses cached extracted text when present", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autoresearch-paper-text-"));
    tempDirs.push(root);
    process.chdir(root);

    const textPath = path.join(
      ".autoresearch",
      "runs",
      "run-1",
      "analysis_cache",
      "texts",
      "paper-1.txt"
    );
    await mkdir(path.dirname(textPath), { recursive: true });
    await writeFile(textPath, "Full text from cache", "utf8");

    const source = await resolvePaperTextSource({
      runId: "run-1",
      paper: makePaper({ pdf_url: "https://example.org/paper-1.pdf" })
    });

    expect(source.sourceType).toBe("full_text");
    expect(source.text).toBe("Full text from cache");
  });

  it("falls back to abstract when PDF download fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autoresearch-paper-text-fallback-"));
    tempDirs.push(root);
    process.chdir(root);
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 404 })) as typeof fetch;

    const source = await resolvePaperTextSource({
      runId: "run-1",
      paper: makePaper({ pdf_url: "https://example.org/missing.pdf" })
    });

    expect(source.sourceType).toBe("abstract");
    expect(source.fallbackReason).toContain("pdf_download_failed:404");
  });
});
