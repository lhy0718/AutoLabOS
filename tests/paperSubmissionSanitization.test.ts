import { describe, expect, it } from "vitest";

import {
  buildPaperBibtex,
  buildFallbackPaperDraft,
  normalizePaperDraft,
  PaperWritingBundle,
  sanitizePaperNarrativeText
} from "../src/core/analysis/paperWriting.js";
import {
  buildFallbackPaperManuscript,
  buildPaperSubmissionValidation,
  buildPaperTraceability,
  normalizePaperManuscript,
  parsePaperManuscriptJson,
  renderSubmissionPaperTex,
  stabilizePaperManuscriptForSubmission
} from "../src/core/analysis/paperManuscript.js";

describe("paper submission sanitization", () => {
  it("cleans brief-derived study prompts before they reach reader-facing manuscript text", () => {
    const text = sanitizePaperNarrativeText(
      "This study addresses Study how condition parameters interact during parameter-efficient instruction tuning under a fixed local compute budget. The study is framed as a local preflight. This paper studies Study how condition parameters interact during parameter-efficient instruction tuning under a fixed local compute budget. under an explicitly bounded evidence ceiling."
    );

    expect(text).toContain("This study addresses how condition parameters interact");
    expect(text).toContain("This paper studies how condition parameters interact");
    expect(text).not.toContain("addresses Study how");
    expect(text).not.toContain("studies Study how");
    expect(text).not.toContain("clean. under");
    expect(text).not.toContain("budget. under");
  });

  it("sanitizes LLM paper draft paragraphs during normalization", () => {
    const draft = normalizePaperDraft({
      raw: {
        title: "A Reader Facing Study",
        abstract: "This paper studies Study how condition parameters interact.",
        sections: [
          {
            heading: "Introduction",
            paragraphs: [
              {
                text: "This study addresses Study how condition parameters interact. This paper studies Study how condition parameters interact. under an explicitly bounded evidence ceiling.",
                evidence_ids: [],
                citation_paper_ids: []
              }
            ]
          }
        ],
        claims: []
      } as any,
      bundle: {
        runTitle: "method run",
        topic: "condition parameters",
        objectiveMetric: "accuracy",
        constraints: [],
        paperSummaries: [],
        evidenceRows: [],
        hypotheses: [],
        corpus: []
      }
    });

    const serialized = JSON.stringify(draft);
    expect(serialized).toContain("This study addresses how condition parameters interact");
    expect(serialized).toContain("This paper studies how condition parameters interact under an explicitly bounded evidence ceiling");
    expect(serialized).not.toContain("Study how");
    expect(serialized).not.toContain(". under an explicitly");
  });

  it("sanitizes final submission TeX even when restored manuscripts contain raw draft phrasing", () => {
    const tex = renderSubmissionPaperTex({
      manuscript: {
        title: "Reader Surface Guard",
        abstract: "This paper studies Study how condition parameters interact.",
        keywords: [],
        sections: [
          {
            heading: "Introduction",
            paragraphs: [
              "This study addresses Study how condition parameters interact. under an explicitly bounded evidence ceiling."
            ]
          }
        ],
        appendix_sections: [
          {
            heading: "Supplementary Notes",
            paragraphs: ["This paper studies Study how condition parameters interact."]
          }
        ],
        tables: [],
        figures: []
      },
      traceability: { paragraphs: [] },
      citationKeysByPaperId: new Map(),
      includeKeywords: false
    });

    expect(tex).toContain("This paper studies how condition parameters interact");
    expect(tex).toContain("This study addresses how condition parameters interact under an explicitly bounded evidence ceiling");
    expect(tex).not.toContain("Study how");
    expect(tex).not.toContain(". under an explicitly");
  });

  it("removes process residue from final rendered TeX paragraphs", () => {
    const tex = renderSubmissionPaperTex({
      manuscript: {
        title: "Reader Surface Guard",
        abstract: "A concise abstract.",
        keywords: [],
        sections: [
          {
            heading: "Introduction",
            paragraphs: [
              "This draft studies how condition parameters interact during parameter-efficient instruction tuning under a fixed local compute budget.",
              "This study addresses Study how condition parameters interact. The paper is scoped around - Primary metric: average accuracy across Benchmark Task A and Benchmark Task B. - Secondary metrics: per-task accuracy, failed-run visibility, and claim-scope correctness.",
              "This study addresses Study how condition parameters interact. The paper is scoped around - Primary metric: average accuracy across Benchmark Task A and Benchmark Task B. - Secondary metrics: per-task accuracy, failed-run visibility, and claim-scope correctness."
            ]
          },
          {
            heading: "Related Work",
            paragraphs: [
              "Prior work in this area spans prompting and control, literature discovery and retrieval, and stateful coordination.",
              "The closest prior studies emphasize not established from abstract-only fallback evidence and planner-timeout fallback evidence."
            ]
          }
        ],
        tables: [],
        figures: []
      },
      traceability: { paragraphs: [] },
      citationKeysByPaperId: new Map(),
      includeKeywords: false
    });

    expect(tex).not.toContain("This paper reports a fixed-budget experimental pilot");
    expect(tex).not.toContain("The contribution is a cautious local preflight over a configured condition set");
    expect(tex).not.toContain("This draft studies");
    expect(tex).not.toContain("Primary metric:");
    expect(tex).not.toContain("failed-run visibility");
    expect(tex).not.toContain("claim-scope correctness");
    expect(tex).not.toContain("abstract-only fallback");
    expect(tex).not.toContain("planner-timeout");
    expect(tex).not.toContain("abstract-only fallback");
    expect(tex).not.toContain("planner-timeout");
  });

  it("preserves ACL template surface while using Python-rendered figure assets and omitting non-template keywords", () => {
    const manuscript = {
      title: "Template-faithful paper",
      abstract: "A concise abstract.",
      keywords: ["should not render"],
      sections: [
        { heading: "Introduction", paragraphs: ["We introduce the question."] },
        { heading: "Results", paragraphs: ["The comparison is shown in Figure 1."] }
      ],
      tables: [
        {
          caption: "Condition-level accuracy.",
          rows: [{ label: "baseline", value: 0.3333 }]
        }
      ],
      figures: [
        {
          caption: "Python-rendered task-level accuracy split.",
          bars: [{ label: "baseline", value: 0.3333 }]
        }
      ]
    };
    const tex = renderSubmissionPaperTex({
      manuscript,
      traceability: { paragraphs: [] },
      citationKeysByPaperId: new Map(),
      parsedTemplate: {
        sourcePath: "/workspace/template.tex",
        preDocumentPreamble: "\\pdfoutput=1",
        documentClass: "\\documentclass[11pt]{article}",
        preamble: "\\usepackage[review]{acl}",
        columnLayout: 1,
        packages: ["\\usepackage[review]{acl}"],
        sectionOrder: ["Introduction", "Results"],
        customCommands: [],
        bibliographyStyle: null
      },
      includeKeywords: false,
      figureRenderMode: "external_pdf"
    });

    expect(tex).toContain("\\pdfoutput=1");
    expect(tex).toContain("\\usepackage[review]{acl}");
    expect(tex).not.toContain("\\textbf{Keywords:}");
    expect(tex).not.toContain("\\bibliographystyle{");
    expect(tex).toContain("\\includegraphics[width=\\columnwidth]{figures/main-result-figure-1.pdf}");
    expect(tex).not.toContain("\\makebox[4.2em][l]");
  });

  it("renders structured condition tables with paper-style experiment columns", () => {
    const tex = renderSubmissionPaperTex({
      manuscript: {
        title: "Condition Grid Paper",
        abstract: "A concise abstract.",
        keywords: [],
        sections: [{ heading: "Results", paragraphs: ["Table 1 reports the executed grid."] }],
        tables: [
          {
            caption: "Condition-level mean accuracy across the executed condition-parameter grid.",
            rows: [
              {
                label: "baseline condition",
                value: 0.333334,
                condition_parameter_x: 8,
                condition_parameter_y: 0,
                average_accuracy: 0.333334,
                accuracy_delta_vs_baseline: 0,
                benchmark_task_a_accuracy: 0.5,
                benchmark_task_b_accuracy: 0.166667,
                is_baseline: true
              },
              {
                label: "candidate condition A",
                value: 0.333334,
                condition_parameter_x: 4,
                condition_parameter_y: 0,
                average_accuracy: 0.333334,
                accuracy_delta_vs_baseline: 0,
                benchmark_task_a_accuracy: 0.5,
                benchmark_task_b_accuracy: 0.166667
              },
              {
                label: "candidate condition a",
                value: 0.333334,
                condition_parameter_x: 16,
                condition_parameter_y: 0.05,
                average_accuracy: 0.333334,
                accuracy_delta_vs_baseline: 0,
                benchmark_task_a_accuracy: 0.5,
                benchmark_task_b_accuracy: 0.166667
              },
              {
                label: "candidate condition b",
                value: 0.416666,
                condition_parameter_x: 32,
                condition_parameter_y: 0.05,
                average_accuracy: 0.416666,
                accuracy_delta_vs_baseline: 0.083332,
                benchmark_task_a_accuracy: 0.5,
                benchmark_task_b_accuracy: 0.333333
              }
            ]
          }
        ],
        figures: []
      },
      traceability: { paragraphs: [] },
      citationKeysByPaperId: new Map(),
      includeKeywords: false
    });

    expect(tex).toContain("\\begin{table*}[t]");
    expect(tex).toContain("Condition & Factor X & Factor Y & Avg. acc. & $\\Delta$ vs comp. & Benchmark Task A & Benchmark Task B");
    expect(tex).toContain("Registered baseline & 8 & 0 & 0.3333 & 0 & 0.5 & 0.1667");
    expect(tex).toContain("candidate condition b & 32 & 0.05 & 0.4167 & +0.0833 & 0.5 & 0.3333");
    expect(tex).not.toContain("Metric & Value");
  });

  it("omits keywords by default when rendering through an explicit LaTeX template", () => {
    const manuscript = {
      title: "Template keyword policy",
      abstract: "A concise abstract.",
      keywords: ["should not render"],
      sections: [{ heading: "Introduction", paragraphs: ["We introduce the question."] }],
      tables: [],
      figures: []
    };
    const tex = renderSubmissionPaperTex({
      manuscript,
      traceability: { paragraphs: [] },
      citationKeysByPaperId: new Map(),
      parsedTemplate: {
        sourcePath: "/workspace/template.tex",
        preDocumentPreamble: "\\pdfoutput=1",
        documentClass: "\\documentclass[11pt]{article}",
        preamble: "\\usepackage[review]{ACL2023}",
        columnLayout: 1,
        packages: ["\\usepackage[review]{ACL2023}"],
        sectionOrder: ["Introduction"],
        customCommands: [],
        bibliographyStyle: null
      }
    });

    expect(tex).toContain("\\usepackage[review]{ACL2023}");
    expect(tex).not.toContain("\\textbf{Keywords:}");
    expect(tex).toContain("\\bibliographystyle{acl_natbib}");
    expect(tex).not.toContain("\\bibliographystyle{plain}");
  });

  it("preserves an explicit template bibliography style when one is supplied", () => {
    const tex = renderSubmissionPaperTex({
      manuscript: {
        title: "Template bibliography policy",
        abstract: "A concise abstract.",
        keywords: [],
        sections: [{ heading: "Introduction", paragraphs: ["We introduce the question."] }],
        tables: [],
        figures: []
      },
      traceability: { paragraphs: [] },
      citationKeysByPaperId: new Map(),
      parsedTemplate: {
        sourcePath: "/workspace/template.tex",
        preDocumentPreamble: "",
        documentClass: "\\documentclass[11pt]{article}",
        preamble: "\\usepackage{natbib}",
        columnLayout: 1,
        packages: ["\\usepackage{natbib}"],
        sectionOrder: ["Introduction"],
        customCommands: [],
        bibliographyStyle: "plainnat"
      }
    });

    expect(tex).toContain("\\bibliographystyle{plainnat}");
  });

  it("does not attach literature citations to paper-specific Introduction framing", () => {
    const manuscript = {
      title: "Citation hygiene paper",
      abstract: "A concise abstract.",
      keywords: [],
      sections: [
        {
          heading: "Introduction",
          paragraphs: [
            "Parameter-efficient fine-tuning is often used when memory and available hardware are fixed in advance.",
            "Against that background, this paper asks a narrow question and treats the experiment as a governed preflight whose primary comparator is the locked internal baseline."
          ]
        },
        {
          heading: "Method",
          paragraphs: [
            "The method condition-parameter run compares parameter_x and parameter_y choices with Benchmark Task A and Benchmark Task B as the task-level evaluation surface."
          ]
        },
        {
          heading: "Related Work",
          paragraphs: [
            "Prior method-family literature motivates memory-aware finetuning and task-sensitive evaluation."
          ]
        }
      ]
    };
    const tex = renderSubmissionPaperTex({
      manuscript,
      traceability: {
        paragraphs: [
          {
            manuscript_section: "Introduction",
            paragraph_index: 0,
            source_draft_section: "Introduction",
            evidence_ids: [],
            citation_paper_ids: ["paper_a"]
          },
          {
            manuscript_section: "Introduction",
            paragraph_index: 1,
            source_draft_section: "Introduction",
            evidence_ids: [],
            citation_paper_ids: ["paper_b"]
          },
          {
            manuscript_section: "Related Work",
            paragraph_index: 0,
            source_draft_section: "Related Work",
            evidence_ids: [],
            citation_paper_ids: ["paper_a"]
          }
        ]
      },
      citationKeysByPaperId: new Map([
        ["paper_a", "paperA"],
        ["paper_b", "paperB"]
      ])
    });

    expect(tex).toContain("Parameter-efficient fine-tuning is often used");
    expect(tex).not.toContain("fixed in advance. \\cite{paperA}");
    expect(tex).not.toContain("locked internal baseline. \\cite{paperB}");
    expect(tex).toContain("Prior method-family literature motivates memory-aware finetuning and task-sensitive evaluation. \\cite{paperA}");
  });

  it("does not attach literature citations to Method execution and protocol records", () => {
    const manuscript = {
      title: "Citation hygiene paper",
      abstract: "A concise abstract.",
      keywords: [],
      sections: [
        {
          heading: "Method",
          paragraphs: [
            "The experiment used a configured factorial design crossing method parameter_x with parameter_y.",
            "The realized data and evaluation settings were training data from the configured training dataset, evaluation on Benchmark Task A and Benchmark Task B, and seed 17."
          ]
        },
        {
          heading: "Related Work",
          paragraphs: ["Prior method-family literature motivates memory-aware finetuning and task-sensitive evaluation."]
        }
      ]
    };
    const tex = renderSubmissionPaperTex({
      manuscript,
      traceability: {
        paragraphs: [
          {
            manuscript_section: "Method",
            paragraph_index: 0,
            source_draft_section: "Method",
            evidence_ids: [],
            citation_paper_ids: ["paper_a"]
          },
          {
            manuscript_section: "Method",
            paragraph_index: 1,
            source_draft_section: "Method",
            evidence_ids: [],
            citation_paper_ids: ["paper_b"]
          },
          {
            manuscript_section: "Related Work",
            paragraph_index: 0,
            source_draft_section: "Related Work",
            evidence_ids: [],
            citation_paper_ids: ["paper_a"]
          }
        ]
      },
      citationKeysByPaperId: new Map([
        ["paper_a", "paperA"],
        ["paper_b", "paperB"]
      ])
    });

    expect(tex).not.toContain("factorial design crossing method parameter_x with parameter_y. \\cite{paperA}");
    expect(tex).not.toContain("Benchmark Task A and Benchmark Task B, and seed 17. \\cite{paperB}");
    expect(tex).toContain("Prior method-family literature motivates memory-aware finetuning and task-sensitive evaluation. \\cite{paperA}");
  });

  it("preserves the same citation bundle when distinct claims need the same evidence", () => {
    const tex = renderSubmissionPaperTex({
      manuscript: {
        title: "Citation bundle hygiene paper",
        abstract: "A concise abstract.",
        keywords: [],
        sections: [
          {
            heading: "Related Work",
            paragraphs: [
              "Prior method-family literature motivates memory-aware finetuning.",
              "Method literature also motivates small-budget model adaptation.",
              "Benchmarking literature motivates cautious interpretation."
            ]
          }
        ],
        tables: [],
        figures: []
      },
      traceability: {
        paragraphs: [
          {
            manuscript_section: "Related Work",
            paragraph_index: 0,
            source_draft_section: "Related Work",
            evidence_ids: [],
            citation_paper_ids: ["paper_a", "paper_b"]
          },
          {
            manuscript_section: "Related Work",
            paragraph_index: 1,
            source_draft_section: "Related Work",
            evidence_ids: [],
            citation_paper_ids: ["paper_b", "paper_a"]
          },
          {
            manuscript_section: "Related Work",
            paragraph_index: 2,
            source_draft_section: "Related Work",
            evidence_ids: [],
            citation_paper_ids: ["paper_c"]
          }
        ]
      },
      citationKeysByPaperId: new Map([
        ["paper_a", "paperA"],
        ["paper_b", "paperB"],
        ["paper_c", "paperC"]
      ])
    });

    expect((tex.match(/\\cite\{paperA,paperB\}/g) || []).length).toBe(2);
    expect(tex).toContain("Benchmarking literature motivates cautious interpretation. \\cite{paperC}");
  });

  it("preserves repeated single-paper citations for distinct supported claims", () => {
    const tex = renderSubmissionPaperTex({
      manuscript: {
        title: "Single citation hygiene paper",
        abstract: "A concise abstract.",
        keywords: [],
        sections: [
          {
            heading: "Related Work",
            paragraphs: [
              "The first related-work claim uses the anchor paper.",
              "The second related-work claim also needs the same anchor.",
              "The third related-work claim should not mechanically repeat it.",
              "The fourth related-work claim should stay readable."
            ]
          }
        ],
        tables: [],
        figures: []
      },
      traceability: {
        paragraphs: [0, 1, 2, 3].map((paragraph_index) => ({
          manuscript_section: "Related Work",
          paragraph_index,
          source_draft_section: "Related Work",
          evidence_ids: [],
          citation_paper_ids: ["paper_a"]
        }))
      },
      citationKeysByPaperId: new Map([["paper_a", "paperA"]])
    });

    expect((tex.match(/\\cite\{paperA\}/g) || []).length).toBe(4);
  });

  it("removes repeated long reader-facing sentences within a section", () => {
    const repeated =
      "The related work is used to position the experiment, not to substitute for direct evidence.";
    const tex = renderSubmissionPaperTex({
      manuscript: {
        title: "Repeated sentence hygiene paper",
        abstract: "A concise abstract.",
        keywords: [],
        sections: [
          {
            heading: "Related Work",
            paragraphs: [
              `First positioning sentence. ${repeated} Prior work motivates the comparison axes.`,
              `Second positioning sentence. ${repeated} The present run supplies the numerical support.`,
              `Third positioning sentence. ${repeated} The claim ceiling remains bounded.`
            ]
          }
        ],
        tables: [],
        figures: []
      },
      traceability: { paragraphs: [] },
      citationKeysByPaperId: new Map()
    });

    expect((tex.match(new RegExp(repeated.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length).toBe(1);
    expect(tex).toContain("Second positioning sentence. The present run supplies the numerical support.");
    expect(tex).toContain("Third positioning sentence. The claim boundary remains bounded.");
  });

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
          paper_id: "paper_reference_method",
          title: "reference method: Efficient Finetuning of Quantized LLMs",
          abstract: "reference method enables memory-efficient finetuning.",
          authors: ["Tim Dettmers"],
          year: 2023,
          venue: "NeurIPS",
          bibtex: [
            "@article{https://doi.org/10.48550/arXiv.2305.14314,",
            "  title={reference method: Efficient Finetuning of Quantized LLMs},",
            "  author={Tim Dettmers},",
            "  year={2023}",
            "}"
          ].join("\n")
        } as any
      ],
      ["paper_reference_method"]
    );

    const key = bibtex.citationKeysByPaperId.get("paper_reference_method");
    expect(key).toBe("dettmers_2023_reference_method");
    expect(bibtex.references).toContain("@article{dettmers_2023_reference_method,");
    expect(bibtex.references).not.toContain("@article{https://doi.org");
  });

  it("removes raw DOI and opaque paper identifiers from normalized manuscript prose", () => {
    const draft = buildFallbackPaperDraft({
      runTitle: "method benchmark",
      topic: "condition-parameter benchmark",
      objectiveMetric: "accuracy_delta_vs_baseline > 0",
      constraints: [],
      paperSummaries: [],
      evidenceRows: [],
      hypotheses: [],
      corpus: [],
      experimentPlan: { selectedTitle: "method benchmark", selectedSummary: "Compare conditions.", rawText: "" }
    } as any);
    const manuscript = normalizePaperManuscript({
      raw: {
        title: "A method Benchmark",
        abstract: "A cautious benchmark (doi:10.48550/arxiv.2305.14314; arXiv:2305.14314; 15a1c2d8eb2c55e3ceb9ce9f72b3446ac1eb183a).",
        keywords: ["method"],
        sections: [
          {
            heading: "Introduction",
            paragraphs: [
              "Prior method-family work motivates this setup (e.g., doi:10.48550/arxiv.2305.14314; 75bc30bf394625c784ea59f8c2fe04718a4b4042)."
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
      runTitle: "method benchmark",
      topic: "condition-parameter benchmark",
      objectiveMetric: "accuracy_delta_vs_baseline > 0",
      constraints: [],
      paperSummaries: [],
      evidenceRows: [],
      hypotheses: [],
      corpus: [],
      experimentPlan: { selectedTitle: "method benchmark", selectedSummary: "Compare conditions.", rawText: "" }
    } as any);
    const raw = parsePaperManuscriptJson(JSON.stringify({
      revised_manuscript: {
        title: "A method Benchmark",
        abstract: "A cautious benchmark reports accuracy\\_delta\\_vs\\_baseline as a screening metric.",
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

  it("keeps protocol checklist residue and comparator tokens out of Method prose", () => {
    const manuscript = stabilizePaperManuscriptForSubmission({
      title: "A Condition Sweep",
      abstract: "A cautious benchmark.",
      keywords: [],
      sections: [
        {
          heading: "Method",
          paragraphs: [
            "The planned backbone preference was the selected backbone, with the configured fallback backbone reserved as a fallback if the preferred model failed preflight.",
            "The executed run used current_best_baseline as the selected backbone. Uncertainty summaries were reported as condition-level 95% intervals over n=6 prediction records; they are treated as screening intervals rather than significance tests.",
            "The evaluation spans Training: fixed subset capped at exactly 10,000 examples. Models or conditions include Primary trained baseline: condition x with the same train budget.",
            "Preprocessing follows this order: Paper-scale evidence floor: all cells must complete. Model selection and reporting focus on baseline-relative accuracy gain, accuracy_pass_at_1_delta_vs_baseline, and accuracy_improvement_over_baseline.",
            "The protocol records Repeat each condition across multiple seeded runs and report run-to-run variance.",
            "The fixed search space is the condition-parameter grid described above."
          ]
        }
      ]
    } as any);

    const text = JSON.stringify(manuscript);
    expect(text).not.toContain("current_best_baseline as the selected backbone");
    expect(text).not.toContain("Evaluation spans Training:");
    expect(text).not.toContain("Preprocessing follows this order:");
    expect(text).not.toContain("accuracy_pass_at_1_delta_vs_baseline");
    expect(text).not.toContain("The protocol records Repeat each condition");
    expect(text).not.toContain("condition 32 parameter 0 0 vs condition 4 parameter 0 0");
    expect(text).not.toContain("Evidence accounting:");
    expect(text).toContain("fixed search space");
  });

  it("renders reader-visible citations for related discussion claims but not Method execution records", () => {
    const draft = buildFallbackPaperDraft({
      runTitle: "method benchmark",
      topic: "condition-parameter benchmark",
      objectiveMetric: "accuracy_delta_vs_baseline > 0",
      constraints: [],
      paperSummaries: [],
      evidenceRows: [],
      hypotheses: [],
      corpus: [
        {
          paper_id: "paper_method",
          title: "Budget-aware method study",
          abstract: "method study.",
          authors: ["Alice Doe"],
          year: 2025,
          venue: "TestConf"
        } as any
      ],
      experimentPlan: { selectedTitle: "method benchmark", selectedSummary: "Compare conditions.", rawText: "" }
    } as any);
    for (const section of draft.sections) {
      if (section.heading === "Method" || section.heading === "Discussion") {
        section.citation_paper_ids = ["paper_method"];
      }
    }

    const manuscript = normalizePaperManuscript({
      raw: {
        title: "A method Benchmark",
        abstract: "A cautious benchmark.",
        sections: [
          {
            heading: "Method",
            paragraphs: [
              "The design fixed parameter_x and parameter_y before execution.",
              "In the preregistered plan, the training source was an the configured training dataset subset capped at 10,000 examples, and evaluation was limited to Benchmark Task A and Benchmark Task B. The preferred base model for this plan was the selected backbone, with the configured fallback backbone reserved only as a fallback if preflight checks failed. However, the reported execution artifact is narrower than that original plan: the metric summary records 48 training samples and a run seed of 17."
            ]
          },
          {
            heading: "Discussion",
            paragraphs: [
              "Prior work reports that parameter choices can influence downstream performance.",
              "Previous studies warn that modest differences are vulnerable to overstatement when evaluations omit incomplete conditions or uncertainty-aware wording."
            ]
          }
        ]
      },
      draft
    });

    const tex = renderSubmissionPaperTex({
      manuscript,
      traceability: {
        paragraphs: [
          {
            manuscript_section: "Method",
            paragraph_index: 1,
            source_draft_section: "Method",
            evidence_ids: [],
            citation_paper_ids: ["paper_method"]
          },
          {
            manuscript_section: "Discussion",
            paragraph_index: 0,
            source_draft_section: "Discussion",
            evidence_ids: [],
            citation_paper_ids: ["paper_method"]
          },
          {
            manuscript_section: "Discussion",
            paragraph_index: 1,
            source_draft_section: "Discussion",
            evidence_ids: [],
            citation_paper_ids: ["paper_method"]
          }
        ]
      },
      citationKeysByPaperId: new Map([["paper_method", "doe_2025_method"]])
    });

    const citedParagraphs = tex.split("\\cite{doe_2025_method}").length - 1;
    expect(citedParagraphs).toBe(2);
    expect(tex).toContain("the selected backbone");
    expect(tex).not.toContain("run seed of 17. \\cite{doe_2025_method}");
    expect(tex).toContain("\\cite{doe_2025_method}");
  });

  it("adds TeX line-stretch guard for long model identifiers in narrow paper columns", () => {
    const draft = buildFallbackPaperDraft({
      runTitle: "method benchmark",
      topic: "condition-parameter benchmark",
      objectiveMetric: "accuracy_delta_vs_baseline > 0",
      constraints: [],
      paperSummaries: [],
      evidenceRows: [],
      hypotheses: [],
      corpus: [],
      experimentPlan: { selectedTitle: "method benchmark", selectedSummary: "Compare conditions.", rawText: "" }
    } as any);

    const manuscript = normalizePaperManuscript({
      raw: {
        title: "A method Benchmark",
        abstract: "A cautious benchmark.",
        sections: [
          {
            heading: "Method",
            paragraphs: [
              "The protocol used the selected backbone with the configured fallback backbone reserved as a fallback under the same local workstation budget."
            ]
          }
        ]
      },
      draft
    });

    const tex = renderSubmissionPaperTex({
      manuscript,
      traceability: { paragraphs: [] },
      citationKeysByPaperId: new Map()
    });

    expect(tex).toContain("\\emergencystretch=3em");
    expect(tex.indexOf("\\emergencystretch=3em")).toBeLessThan(tex.indexOf("\\begin{document}"));
    expect(tex).toContain("the selected backbone");
  });

  it("keeps registered-baseline and delta-reference visuals separate when their rows differ", () => {
    const stabilized = stabilizePaperManuscriptForSubmission(
      {
        title: "A method Benchmark",
        abstract: "A cautious benchmark.",
        keywords: ["method"],
        sections: [
          { heading: "Method", paragraphs: ["The method uses a fixed condition grid."] },
          { heading: "Results", paragraphs: ["The reported delta is positive, but the planned baseline row is unresolved."] }
        ],
        figures: [
          {
            caption: "Task-level score differences for a leading condition relative to the registered baseline.",
            bars: [
              { label: "Benchmark Task A task difference", value: 0 },
              { label: "Benchmark Task B task difference", value: 0.1 }
            ]
          }
        ]
      },
      {
        conditionSummaries: [
          {
            label: "reference condition",
            is_comparator: true,
            condition_parameter_x: 1,
            condition_parameter_y: 0,
            average_accuracy_mean: 0.45,
            benchmark_task_a_accuracy: 0.5,
            benchmark_task_b_accuracy: 0.4
          },
          {
            label: "planned baseline condition",
            is_baseline: true,
            is_registered_baseline: true,
            condition_parameter_x: 2,
            condition_parameter_y: 0,
            average_accuracy_mean: 0.46,
            benchmark_task_a_accuracy: 0.5,
            benchmark_task_b_accuracy: 0.42
          },
          {
            label: "candidate condition a",
            condition_parameter_x: 3,
            condition_parameter_y: 0,
            average_accuracy_mean: 0.48,
            accuracy_delta_vs_baseline_mean: 0.03,
            benchmark_task_a_accuracy: 0.52,
            benchmark_task_b_accuracy: 0.44
          },
          {
            label: "candidate condition b",
            condition_parameter_x: 4,
            condition_parameter_y: 0,
            average_accuracy_mean: 0.47,
            accuracy_delta_vs_baseline_mean: 0.02,
            benchmark_task_a_accuracy: 0.51,
            benchmark_task_b_accuracy: 0.43
          }
        ]
      }
    );

    expect(stabilized.tables?.[0]?.caption).toContain("archived reference row and registered baseline are different");
    expect(stabilized.tables?.[0]?.rows.map((row) => row.label)).toContain(
      "Registered baseline condition, not delta reference (factor x=2, factor y=0)"
    );
    expect(stabilized.figures).toHaveLength(1);
    expect(stabilized.figures?.[0]?.caption).toContain("registered baseline and delta-reference row are kept separate");
    expect(stabilized.figures?.[0]?.caption).not.toContain("relative to the registered baseline");
    expect(stabilized.figures?.[0]?.bars.map((row) => row.label)).toContain(
      "Registered baseline, not reference"
    );
    expect(stabilized.figures?.[0]?.bars.map((row) => row.label).join(" ")).not.toMatch(/task difference/i);
  });

  it("replaces redundant condition-delta figures with a task-level split when condition summaries are available", () => {
    const stabilized = stabilizePaperManuscriptForSubmission(
      {
        title: "A method Benchmark",
        abstract: "A cautious benchmark.",
        keywords: ["method"],
        sections: [
          {
            heading: "Results",
            paragraphs: [
              "Table 1 reports mean average accuracy for all executed condition-parameter conditions."
            ]
          }
        ],
        tables: [
          {
            caption: "Condition-level mean accuracy across the executed condition-parameter grid.",
            rows: [
              { label: "baseline condition", value: 0.333334 },
              { label: "candidate condition c", value: 0.333334 },
              { label: "candidate condition a", value: 0.333334 },
              { label: "candidate condition b", value: 0.416666 }
            ]
          }
        ],
        figures: [
          {
            caption: "Baseline-relative mean accuracy gain by evaluated condition-parameter condition.",
            bars: [
              { label: "baseline condition", value: 0 },
              { label: "candidate condition c", value: 0 },
              { label: "candidate condition a", value: 0 },
              { label: "candidate condition b", value: 0.083332 }
            ]
          },
          {
            caption:
              "Task-level and average accuracy for the leading condition; paired bars compare the locked baseline with the best observed condition-parameter cell.",
            bars: [
              { label: "Baseline Benchmark Task A", value: 0.5 },
              { label: "Leading Benchmark Task A", value: 0.5 },
              { label: "Baseline Benchmark Task B", value: 0.1667 },
              { label: "Leading Benchmark Task B", value: 0.3333 },
              { label: "Baseline Average", value: 0.3333 },
              { label: "Leading Average", value: 0.4167 }
            ]
          }
        ]
      },
      {
        conditionSummaries: [
          {
            label: "baseline condition",
            is_baseline: true,
            average_accuracy_mean: 0.333334,
            benchmark_task_a_accuracy: 0.5,
            benchmark_task_b_accuracy: 0.166667
          },
          {
            label: "candidate condition c",
            average_accuracy_mean: 0.333334,
            benchmark_task_a_accuracy: 0.5,
            benchmark_task_b_accuracy: 0.166667
          },
          {
            label: "candidate condition a",
            average_accuracy_mean: 0.333334,
            benchmark_task_a_accuracy: 0.5,
            benchmark_task_b_accuracy: 0.166667
          },
          {
            label: "candidate condition b",
            average_accuracy_mean: 0.416666,
            accuracy_delta_vs_baseline_mean: 0.083332,
            benchmark_task_a_accuracy: 0.5,
            benchmark_task_b_accuracy: 0.333333
          }
        ]
      }
    );

    expect(stabilized.figures).toHaveLength(1);
    expect(stabilized.figures?.[0]?.caption).toContain("Task-level score differences");
    expect(stabilized.figures?.[0]?.bars).toEqual([
      { label: "Benchmark Task A task difference", value: 0 },
      { label: "Benchmark Task B task difference", value: 0.1666 }
    ]);
  });

  it("re-applies verified backbone metadata after manuscript repair stabilization", () => {
    const stabilized = stabilizePaperManuscriptForSubmission(
      {
        title: "A method Benchmark",
        abstract: "A cautious benchmark.",
        keywords: ["method"],
        sections: [
          {
            heading: "Method",
            paragraphs: [
              "The protocol preferred the selected backbone (cited model source) and allowed the configured fallback backbone only as a fallback.",
              "Although the broader protocol preferred the selected backbone and allowed the configured fallback backbone only as a fallback, the compact realized summary does not clearly expose the final instantiated backbone."
            ]
          }
        ]
      },
      {
        resultAnalysis: {
          metrics: {
            selected_model_id: "the selected backbone",
            fallback_model_id: "the configured fallback backbone",
            run_config: {
              learning_rate: 0.0002,
              per_device_train_batch_size: 1,
              gradient_accumulation_steps: 4,
              max_steps: 4,
              max_seq_length: 256,
              timeout_sec: 1800,
              seed: 17,
              max_train_samples: 48,
              max_eval_samples_per_task: 6
            },
            data: {
              train: { dataset: { path: "instruction_dataset" } },
              eval: {
                benchmark_task_a: { dataset: { path: "benchmark_task_a_dataset", name: "Benchmark Task A", split: "validation" } },
                benchmark_task_b: { dataset: { path: "benchmark_task_b", split: "validation" } }
              }
            }
          },
          statistical_summary: {
            confidence_intervals: [{ level: 0.95, sample_size: 12 }]
          }
        } as any
      }
    );

    const methodText = stabilized.sections.find((section) => section.heading === "Method")?.paragraphs.join(" ") || "";
    expect(methodText).toContain("The executed run used the selected backbone as the selected backbone");
    expect(methodText).toContain("the configured fallback backbone retained only as the fallback candidate");
    expect(methodText).not.toContain("cited model source");
    expect(methodText).not.toContain("does not clearly expose the final instantiated backbone");
  });

  it("removes prompt, cache, and duplicate reviewer residue after manuscript repair", () => {
    const cachedRecoveryResidue = [
      ["Recovered", "cached", "full", "text"].join(" "),
      "describing a compact",
      "adaptation recipe."
    ].join(" " );
    const promptTopicResidue = [
      "Study how",
      "condition parameters interact during",
      "constrained model adaptation under a fixed local compute budget."
    ].join(" " );
    const readinessResidue = ["paper-readiness", "inspect"].join(" " );
    const remoteDomainResidue = ["bearing", "fault setting"].join("-" );
    const datasetLead = ["Dataset-level", "reporting shows"].join(" " );
    const awkwardMetricResidue = ["Parameter-computationally", "practical within the reported setup"].join(" " );
    const suppliedBriefResidue = ["supplied", "related-work brief"].join(" " );
    const identifiedBriefResidue = ["identified", "in the brief"].join(" " );
    const budgetCaveatResidue = ["The 36-run workload may exceed", "the desired first preflight local budget."].join(" " );

    const stabilized = stabilizePaperManuscriptForSubmission({
      title: "A Fixed-Budget Condition Study",
      abstract: "A cautious condition study with a small positive screening signal.",
      keywords: ["condition study"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: [
            `This study addresses ${promptTopicResidue} The local preflight run uses a cached, locally runnable small target so the validation focuses on real training, result-table consistency, review checks, and ${readinessResidue} rather than on new model access. ${cachedRecoveryResidue}`,
            `${awkwardMetricResidue} fine-tuning is attractive when language-model adaptation must fit within local memory, runtime, and hardware constraints. Several literature extractions were produced under timeout or fallback conditions and should be read as contextual rather than decisive.`
          ]
        },
        {
          heading: "Related Work",
          paragraphs: [
            `One practical but remote adaptation contrast in the cited material is a lightweight method-based model in a ${remoteDomainResidue}, which shares an interest in practical adaptation under constraints but differs in domain.`,
            `The closest prior framing ${identifiedBriefResidue} is a lightweight method-based model in a ${remoteDomainResidue}, whereas other nearby papers emphasize resource-constrained adaptation.`,
            `The ${suppliedBriefResidue} organizes nearby work along three broad axes: method-method development, survey or synthesis of fine-tuning practice, and evaluation-oriented benchmarking.`
          ]
        },
        {
          heading: "Results",
          paragraphs: [
            `${datasetLead} a symmetric leading point estimate across the two evaluation tasks. The leading-condition summary lists Task A accuracy=0.479167 and Task B accuracy=0.479167.`,
            `${datasetLead} a symmetric best-condition point estimate across the two evaluation tasks. The best-condition summary lists Task A accuracy=0.479167 and Task B accuracy=0.479167.`,
            "The primary point estimate exceeded the pre-specified +0.01 threshold. The aggregate summary reports baseline-relative accuracy gain=0.02083333333333337.",
            "The primary point estimate exceeded the pre-specified +0.01 threshold. The aggregate summary reports baseline-relative accuracy gain=0.02083333333333337."
          ]
        },
        {
          heading: "Limitations",
          paragraphs: [
            "The first limitation is scope. The study is a local small-model screen, not a broad benchmark.",
            budgetCaveatResidue
          ]
        }
      ]
    });

    const text = JSON.stringify(stabilized);
    expect(text).not.toContain(cachedRecoveryResidue);
    expect(text).not.toContain(promptTopicResidue);
    expect(text).not.toContain(readinessResidue);
    expect(text).not.toContain(remoteDomainResidue);
    expect(text).not.toContain(awkwardMetricResidue);
    expect(text).not.toContain(identifiedBriefResidue);
    expect(text).not.toContain(suppliedBriefResidue);
    expect(text).toContain(budgetCaveatResidue);
    const resultText = stabilized.sections.find((section) => section.heading === "Results")?.paragraphs.join("\n") || "";
    expect((resultText.match(new RegExp(datasetLead, "g")) || []).length).toBe(1);
    expect(resultText).not.toContain("best-condition point estimate");
  });

  it("downgrades garbled registered-baseline threshold claims after manuscript repair", () => {
    const stabilized = stabilizePaperManuscriptForSubmission(
      {
        title: "A Fixed-Budget Condition Study",
        abstract:
          "The archived aggregate comparison shows baseline-relative accuracy gain=0.020833 against the displayed reference row, with a 0.01 practical-improvement threshold used as a screening yardstick; because the registered baseline and archived comparator roles remain unreconciled in the available artifacts, the stronger claim that the registered-baseline objective remains unresolved is deferred.",
        keywords: ["condition study"],
        sections: [
          {
            heading: "Results",
            paragraphs: [
              "The aggregate result summary is best read as a bounded screening contrast rather than a resolved registered-baseline test. It reports an average-score difference of 0.020833 between the tied leading displayed row(s) and the displayed reference row, with 0.01 as the pre-specified practical-improvement threshold. Because the registered baseline and archived delta reference are not fully reconciled in the available artifacts, the stronger claim that the registered registered-baseline objective remains unresolved is deferred. Expressed in percentage points, the reported difference is approximately +2.08 points.",
              "The leading configuration is reported with 288 total evaluation examples. These denominators are important for interpretation: the gain is practically meaningful under the stated threshold, but it is still a small-count effect in a screening-scale evaluation.",
              "The primary objective metric was baseline-relative average accuracy across Benchmark Task A and Benchmark Task B. The aggregate result table reports an observed gain of 0.020833 against a target of 0.01. In percentage-point terms, this is approximately +2.08 points, exceeding the pre-specified +1.0 point threshold."
            ]
          },
          {
            heading: "Conclusion",
            paragraphs: [
              "The displayed-reference two-task average-score difference of 0.020833 exceeds the pre-specified practical screening threshold of 0.01, while the registered-baseline interpretation remains unresolved."
            ]
          }
        ]
      },
      {
        conditionSummaries: [
          { label: "Registered baseline", condition_parameter_x: 1, condition_parameter_y: 0, average_accuracy_mean: 0.45, is_registered_baseline: true, is_baseline: true },
          { label: "Displayed reference", condition_parameter_x: 2, condition_parameter_y: 0, average_accuracy_mean: 0.46, is_comparator: true },
          { label: "Leading condition", condition_parameter_x: 3, condition_parameter_y: 1, average_accuracy_mean: 0.48 }
        ]
      }
    );

    const text = JSON.stringify(stabilized);
    expect(text).not.toContain("registered registered-baseline");
    expect(text).not.toContain("stronger claim that the registered-baseline objective remains unresolved is deferred");
    expect(text).not.toContain("the gain is practically meaningful under the stated threshold");
    expect(text).not.toContain("baseline-relative accuracy gain=0.020833");
    expect(text).not.toContain("exceeding the pre-specified +1.0 point threshold");
    expect(text).not.toContain("threshold claims remain unresolved");
    expect(text).toContain("displayed-reference accuracy difference 0.020833");
    expect(text).toContain("no registered-baseline success claim is accepted");
    expect(text).toContain("not evidence that the registered-baseline target of 0.01 was met");
    expect(stabilized.tables?.[0]?.caption).toContain("not accepted as a registered-baseline threshold success");
  });


});
