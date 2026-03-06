import { afterEach, describe, expect, it, vi } from "vitest";

import { SemanticScholarClient } from "../src/tools/semanticScholar.js";

describe("SemanticScholarClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses /paper/search for relevance mode", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ paperId: "p1", title: "Paper 1", authors: [] }]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new SemanticScholarClient({ perSecondLimit: 1000 });
    await client.searchPapers({
      query: "agent",
      limit: 1,
      sort: { field: "relevance" },
      filters: {
        year: "2024",
        fieldsOfStudy: ["Computer Science"]
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/graph/v1/paper/search");
    expect(url.searchParams.get("query")).toBe("agent");
    expect(url.searchParams.get("year")).toBe("2024");
    expect(url.searchParams.get("fieldsOfStudy")).toBe("Computer Science");
  });

  it("uses /paper/search/bulk for sortable modes", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ paperId: "p1", title: "Paper 1", authors: [] }]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new SemanticScholarClient({ perSecondLimit: 1000 });
    await client.searchPapers({
      query: "agent",
      limit: 1,
      sort: { field: "citationCount", order: "desc" },
      filters: {
        openAccessPdf: true,
        minCitationCount: 100,
        publicationTypes: ["Review"]
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/graph/v1/paper/search/bulk");
    expect(url.searchParams.get("sort")).toBe("citationCount:desc");
    expect(url.searchParams.get("minCitationCount")).toBe("100");
    expect(url.searchParams.get("publicationTypes")).toBe("Review");
    expect(url.searchParams.has("openAccessPdf")).toBe(true);
  });

  it("normalizes rich fields including citationStyles bibtex", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            paperId: "p1",
            title: "Paper 1",
            authors: [{ name: "Alice" }],
            citationCount: 12,
            influentialCitationCount: 3,
            publicationDate: "2025-01-10",
            publicationTypes: ["Review"],
            fieldsOfStudy: ["Computer Science"],
            openAccessPdf: { url: "https://example.org/paper.pdf" },
            citationStyles: { bibtex: "@article{p1, title={Paper 1}}" },
            externalIds: { DOI: "10.1000/xyz" }
          }
        ]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new SemanticScholarClient({ perSecondLimit: 1000 });
    const papers = await client.searchPapers({
      query: "agent",
      limit: 1,
      sort: { field: "relevance" }
    });

    expect(papers).toHaveLength(1);
    expect(papers[0]?.citationCount).toBe(12);
    expect(papers[0]?.influentialCitationCount).toBe(3);
    expect(papers[0]?.publicationDate).toBe("2025-01-10");
    expect(papers[0]?.publicationTypes).toEqual(["Review"]);
    expect(papers[0]?.fieldsOfStudy).toEqual(["Computer Science"]);
    expect(papers[0]?.openAccessPdfUrl).toBe("https://example.org/paper.pdf");
    expect(papers[0]?.citationStylesBibtex).toContain("@article{p1");
    expect(papers[0]?.doi).toBe("10.1000/xyz");
  });
});
