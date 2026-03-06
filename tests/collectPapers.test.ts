import { describe, expect, it } from "vitest";

import { buildBibtexEntry, buildBibtexFile } from "../src/core/nodes/collectPapers.js";

describe("collectPapers bibtex", () => {
  it("builds bibtex entry with rich metadata", () => {
    const entry = buildBibtexEntry({
      paperId: "12345",
      title: "Agentic Workflows for Science",
      abstract: "x",
      year: 2025,
      venue: "NeurIPS",
      url: "https://example.org/paper",
      authors: ["Alice Kim", "Bob Lee"],
      doi: "10.1000/xyz-123",
      arxivId: "2501.01234"
    });

    expect(entry).toContain("@article{10_1000_xyz_123,");
    expect(entry).toContain("author = {Alice Kim and Bob Lee},");
    expect(entry).toContain("title = {Agentic Workflows for Science},");
    expect(entry).toContain("year = {2025},");
    expect(entry).toContain("journal = {NeurIPS},");
    expect(entry).toContain("doi = {10.1000/xyz-123},");
    expect(entry).toContain("url = {https://example.org/paper},");
    expect(entry).toContain("note = {arXiv:2501.01234},");
  });

  it("builds bibtex file for multiple papers", () => {
    const bib = buildBibtexFile([
      {
        paperId: "p1",
        title: "Paper One",
        authors: []
      },
      {
        paperId: "p2",
        title: "Paper Two",
        authors: ["A B"]
      }
    ]);

    expect(bib).toContain("@article{p1,");
    expect(bib).toContain("@article{p2,");
    expect(bib.split("@article{").length - 1).toBe(2);
  });

  it("uses S2 bibtex in hybrid mode when available", () => {
    const bib = buildBibtexFile(
      [
        {
          paperId: "p1",
          title: "Paper One",
          authors: [],
          citationStylesBibtex: "@article{s2key,\n  title = {From S2},\n}"
        }
      ],
      "hybrid"
    );

    expect(bib).toContain("@article{s2key,");
    expect(bib).toContain("From S2");
  });

  it("skips entries without S2 bibtex in s2 mode", () => {
    const bib = buildBibtexFile(
      [
        {
          paperId: "p1",
          title: "Paper One",
          authors: []
        }
      ],
      "s2"
    );

    expect(bib.trim()).toBe("");
  });
});
