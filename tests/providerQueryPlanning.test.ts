import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSearchQueryPlan } from "../src/tools/paperSearchCommon.js";
import { OpenAlexClient } from "../src/tools/openAlex.js";
import { CrossrefClient } from "../src/tools/crossref.js";
import { ArxivClient } from "../src/tools/arxiv.js";
import { SemanticScholarClient } from "../src/tools/semanticScholar.js";

describe("provider query planning", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps shared AND terms when expanding OR clauses and tracks excluded terms", () => {
    const plan = buildSearchQueryPlan('("small language models" OR "compact language models") +reasoning -survey');

    expect(plan.variantClauses.map((clause) => clause.text)).toEqual([
      "small language models reasoning",
      "compact language models reasoning"
    ]);
    expect(plan.excludedTerms).toEqual(["survey"]);
  });

  it("fans out OpenAlex OR clauses and pushes down supported filters", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              id: "https://openalex.org/W1",
              display_name: "Agent collaboration benchmark",
              publication_year: 2024,
              publication_date: "2024-01-01",
              authorships: [{ author: { display_name: "Alice Kim" } }],
              primary_location: {
                landing_page_url: "https://example.org/openalex-1",
                source: { display_name: "BMJ" }
              },
              open_access: {
                oa_url: "https://example.org/openalex-1.pdf"
              },
              cited_by_count: 140
            }
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            {
              id: "https://openalex.org/W2",
              display_name: "Survey of orchestration benchmark",
              publication_year: 2024,
              publication_date: "2024-02-01",
              authorships: [{ author: { display_name: "Bob Lee" } }],
              primary_location: {
                landing_page_url: "https://example.org/openalex-2",
                source: { display_name: "Nature" }
              },
              cited_by_count: 180
            }
          ]
        })
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenAlexClient();
    const papers = await client.searchPapers({
      query: '("agent collaboration" OR orchestration) +benchmark -survey',
      limit: 4,
      sort: { field: "citationCount", order: "desc" },
      filters: {
        year: "2024",
        openAccessPdf: true,
        minCitationCount: 100
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(firstUrl.searchParams.get("search")).toBe('"agent collaboration" benchmark');
    expect(firstUrl.searchParams.get("per-page")).toBe("2");
    expect(firstUrl.searchParams.get("sort")).toBe("cited_by_count:desc");
    expect(firstUrl.searchParams.get("filter")).toContain("from_publication_date:2024-01-01");
    expect(firstUrl.searchParams.get("filter")).toContain("to_publication_date:2024-12-31");
    expect(firstUrl.searchParams.get("filter")).toContain("is_oa:true");
    expect(firstUrl.searchParams.get("filter")).toContain("cited_by_count:>100");

    const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(secondUrl.searchParams.get("search")).toBe("orchestration benchmark");

    expect(papers).toHaveLength(1);
    expect(papers[0]?.title).toBe("Agent collaboration benchmark");
    expect(client.getLastSearchDiagnostics()).toMatchObject({
      query: '"agent collaboration" benchmark OR orchestration benchmark',
      originalQuery: '("agent collaboration" OR orchestration) +benchmark -survey',
      fetched: 1,
      attemptCount: 2,
      providerLimit: 50,
      queryTransformation: {
        strategy: "split_or_and_exclude_terms",
        variants: ['"agent collaboration" benchmark', "orchestration benchmark"]
      }
    });
  });

  it("authenticates OpenAlex requests without persisting the API key in diagnostics", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [] })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenAlexClient({ apiKey: "test-openalex-secret" });
    await client.searchPapers({ query: "retrieval evaluation", limit: 1 });

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestUrl.searchParams.get("api_key")).toBe("test-openalex-secret");

    const diagnostics = client.getLastSearchDiagnostics();
    expect(diagnostics.attempts[0]?.endpoint).not.toContain("test-openalex-secret");
    expect(new URL(diagnostics.attempts[0]!.endpoint!).searchParams.has("api_key")).toBe(false);

    fetchMock.mockRejectedValueOnce(
      new Error("request failed: https://api.openalex.org/works?api_key=test-openalex-secret")
    );
    await client.searchPapers({ query: "retrieval evaluation", limit: 1 });

    expect(JSON.stringify(client.getLastSearchDiagnostics())).not.toContain("test-openalex-secret");
    expect(client.getLastSearchDiagnostics().error).toContain("[redacted]");
  });

  it("uses relevance search for topic discovery while preserving the phrase query for other providers", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            paperId: "paper-1",
            title: "Document retrieval under calibration shift",
            authors: []
          }
        ]
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new SemanticScholarClient({ perSecondLimit: 100, maxRetries: 1 });
    const papers = await client.searchPapers({
      query: '"document retrieval" calibration shift',
      limit: 1,
      retrievalIntent: "topic_discovery",
      sort: { field: "relevance", order: "desc" }
    });

    expect(papers).toHaveLength(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/graph/v1/paper/search");
    expect(url.searchParams.get("query")).toBe("document retrieval calibration shift");
  });

  it("compiles one topic family with provider-specific relevance semantics", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      return {
        ok: true,
        status: 200,
        json: async () =>
          url.hostname.includes("semanticscholar")
            ? { data: [] }
            : url.hostname.includes("openalex")
              ? { results: [] }
              : { message: { items: [] } },
        text: async () => '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'
      };
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      query: '"document retrieval evaluation" ranking stability',
      limit: 1,
      retrievalIntent: "topic_discovery" as const,
      topicDiscoveryFamily: {
        familyId: "ranking_stability",
        sharedAnchorTerms: ["document", "retrieval", "evaluation"],
        axisTerms: ["ranking", "stability"]
      },
      sort: { field: "relevance" as const, order: "desc" as const }
    };

    await new SemanticScholarClient({ perSecondLimit: 100, maxRetries: 1 }).searchPapers(request);
    const openAlexClient = new OpenAlexClient();
    await openAlexClient.searchPapers(request);
    await new CrossrefClient().searchPapers(request);
    await new ArxivClient().searchPapers(request);

    const urls = fetchMock.mock.calls.map((call) => new URL(String(call[0])));
    const semanticScholarUrl = urls.find((url) => url.hostname.includes("semanticscholar"));
    const openAlexUrl = urls.find((url) => url.hostname.includes("openalex"));
    const crossrefUrl = urls.find((url) => url.hostname.includes("crossref"));
    const arxivUrl = urls.find((url) => url.hostname.includes("arxiv"));

    expect(semanticScholarUrl?.searchParams.get("query")).toBe(
      "document retrieval evaluation ranking stability"
    );
    expect(openAlexUrl?.searchParams.get("search")).toBe(
      "document retrieval evaluation ranking stability"
    );
    expect(openAlexUrl?.searchParams.get("search")).not.toMatch(/\b(?:AND|OR)\b/u);
    expect(openAlexClient.getLastSearchDiagnostics()).toMatchObject({
      queryTransformation: {
        transformed: "document retrieval evaluation ranking stability",
        strategy: "topic_discovery_plain_relevance",
        variants: ["document retrieval evaluation ranking stability"]
      }
    });
    expect(crossrefUrl?.searchParams.get("query.bibliographic")).toBe(
      "document retrieval evaluation ranking stability"
    );
    expect(arxivUrl?.searchParams.get("search_query")).toBe(
      "((all:document AND all:retrieval) OR (all:document AND all:evaluation) OR (all:retrieval AND all:evaluation)) AND (all:ranking OR all:stability)"
    );
  });

  it("pushes Crossref date, venue, and type filters into the request", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        message: {
          items: [
            {
              DOI: "10.1000/xyz",
              title: ["Machine learning in medicine"],
              issued: { "date-parts": [[2024, 4, 16]] },
              "container-title": ["BMJ"],
              type: "journal-article",
              author: [{ given: "Alice", family: "Kim" }]
            }
          ]
        }
      })
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CrossrefClient();
    const papers = await client.searchPapers({
      query: "machine learning",
      limit: 3,
      sort: { field: "relevance", order: "desc" },
      filters: {
        year: "2024",
        venue: ["BMJ"],
        publicationTypes: ["journal-article"]
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("query.bibliographic")).toBe("machine learning");
    expect(url.searchParams.get("query.container-title")).toBe("BMJ");
    expect(url.searchParams.get("filter")).toContain("from-pub-date:2024-01-01");
    expect(url.searchParams.get("filter")).toContain("until-pub-date:2024-12-31");
    expect(url.searchParams.get("filter")).toContain("type:journal-article");

    expect(papers).toHaveLength(1);
    expect(papers[0]?.venue).toBe("BMJ");
    expect(client.getLastSearchDiagnostics()).toMatchObject({
      fetched: 1,
      filterApplications: expect.arrayContaining([
        expect.objectContaining({
          filter: "venue",
          appliedAt: "query",
          nativeParameter: "query.container-title"
        }),
        expect.objectContaining({
          filter: "publicationTypes",
          appliedAt: "query",
          nativeParameter: "filter=type"
        })
      ])
    });
  });

  it("builds fielded arXiv queries for each variant and maps publicationDate sorting", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2501.00001v1</id>
    <title>Agent Collaboration Benchmark</title>
    <summary>Useful benchmark paper.</summary>
    <published>2024-01-10T00:00:00Z</published>
    <author><name>Alice Kim</name></author>
  </entry>
</feed>`
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2501.00002v1</id>
    <title>Survey of Orchestration Benchmark</title>
    <summary>Survey entry that should be excluded.</summary>
    <published>2024-02-10T00:00:00Z</published>
    <author><name>Bob Lee</name></author>
  </entry>
</feed>`
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new ArxivClient();
    const papers = await client.searchPapers({
      query: '("agent collaboration" OR orchestration) +benchmark -survey',
      limit: 4,
      sort: { field: "publicationDate", order: "asc" }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(firstUrl.searchParams.get("search_query")).toBe('all:"agent collaboration" AND all:benchmark');
    expect(firstUrl.searchParams.get("sortBy")).toBe("submittedDate");
    expect(firstUrl.searchParams.get("sortOrder")).toBe("ascending");

    const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(secondUrl.searchParams.get("search_query")).toBe("all:orchestration AND all:benchmark");

    expect(papers).toHaveLength(1);
    expect(papers[0]?.title).toBe("Agent Collaboration Benchmark");
    expect(client.getLastSearchDiagnostics()).toMatchObject({
      fetched: 1,
      queryTransformation: {
        strategy: "field_query_union_and_exclude_terms",
        variants: ['all:"agent collaboration" AND all:benchmark', "all:orchestration AND all:benchmark"]
      }
    });
  });
});
