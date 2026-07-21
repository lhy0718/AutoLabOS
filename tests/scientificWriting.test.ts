import { describe, expect, it } from "vitest";

import { choosePaperTitle, sanitizePaperNarrativeText, type PaperDraft, type PaperWritingBundle } from "../src/core/analysis/paperWriting.js";
import {
  AUTHORED_MAIN_FIGURE_SOURCE_REF_ID,
  AUTHORED_MAIN_TABLE_SOURCE_REF_ID,
  stabilizePaperManuscriptForSubmission,
  type PaperManuscript
} from "../src/core/analysis/paperManuscript.js";
import {
  applyScientificWritingPolicy,
  buildScientificValidationArtifact,
  buildWritePaperGateDecision,
  enforceManuscriptPageBudgetFloor,
  experimentArtifactLoader,
  materializeScientificManuscript,
  methodCompletenessValidator,
  pageBudgetManager,
  refreshScientificValidationForManuscript,
  resolvePaperProfile,
  resultsRichnessValidator,
  strengthenPaperScaleManuscript
} from "../src/core/analysis/scientificWriting.js";

const PAPER_PROFILE = {
  target_main_pages: 8,
  minimum_main_pages: 8,
  main_page_limit: 8,
  references_counted: false,
  appendix_allowed: true,
  appendix_format: "double_column" as const,
  prefer_appendix_for: [
    "hyperparameter_grids",
    "per_fold_results",
    "environment_dump",
    "extended_error_analysis"
  ],
  estimated_words_per_page: 650
};

function makeRichBundle(): PaperWritingBundle {
  return {
    runTitle: "Repeated Tabular Benchmark",
    topic: "resource-aware tabular baseline comparison",
    objectiveMetric: "macro_f1_delta_vs_logreg >= 0.02",
    constraints: ["ACL style", "evidence-first writing"],
    paperSummaries: [
      {
        paper_id: "paper_1",
        title: "Nested Validation for Tabular Baselines",
        source_type: "full_text",
        summary: "Nested validation stabilizes model selection in small tabular benchmarks.",
        key_findings: ["Nested validation reduces selection optimism."],
        limitations: ["Compute cost rises with repeated evaluation."],
        datasets: ["breast_cancer", "iris"],
        metrics: ["macro_f1"],
        novelty: "Evaluation and benchmarking for small tabular datasets",
        reproducibility_notes: ["Explicit seeds and folds are reported."]
      },
      {
        paper_id: "paper_2",
        title: "CPU-Only Tree Baselines",
        source_type: "full_text",
        summary: "Tree ensembles offer small gains over logistic regression on public datasets.",
        key_findings: ["Extra trees produce small positive deltas on some datasets."],
        limitations: ["Gains vary by dataset."],
        datasets: ["breast_cancer", "iris"],
        metrics: ["macro_f1_delta_vs_logreg"],
        novelty: "Classical model comparison under CPU-only constraints",
        reproducibility_notes: ["OpenML datasets and seed schedules are listed."]
      },
      {
        paper_id: "paper_3",
        title: "Reproducibility Notes for Repeated CV",
        source_type: "full_text",
        summary: "Repeated CV supports cautious, not universal, claims about ranking stability.",
        key_findings: ["Repeated evaluation exposes heterogeneity."],
        limitations: ["Repeated CV does not justify strong inferential language."],
        datasets: ["OpenML tabular suites"],
        metrics: ["pairwise_ranking_agreement"],
        novelty: "Reproducibility framing for repeated evaluation",
        reproducibility_notes: ["Intervals and heterogeneity are emphasized."]
      }
    ],
    evidenceRows: [
      {
        evidence_id: "ev_1",
        paper_id: "paper_1",
        claim: "Nested evaluation lowers selection optimism.",
        method_slot: "nested and non-nested CPU-only workflows",
        result_slot: "lower optimism with small macro-F1 deltas",
        limitation_slot: "dataset-dependent gains",
        dataset_slot: "breast_cancer",
        metric_slot: "macro_f1_delta_vs_logreg",
        evidence_span: "Repeated evaluation exposes small but positive deltas on breast_cancer and iris.",
        source_type: "full_text",
        confidence: 0.91,
        confidence_reason: "Repeated evaluations and explicit datasets are available."
      }
    ],
    hypotheses: [
      {
        hypothesis_id: "h_1",
        text: "Non-nested extra trees may show a small positive macro-F1 delta over logistic regression on some public datasets.",
        evidence_links: ["ev_1"],
        rationale: "Positive deltas are plausible but should remain modest and dataset-dependent.",
        measurement_hint: "Track macro_f1_delta_vs_logreg, runtime, memory, and ranking stability."
      }
    ],
    corpus: [
      {
        paper_id: "paper_1",
        title: "Nested Validation for Tabular Baselines",
        abstract: "Nested validation stabilizes model selection in small tabular benchmarks.",
        authors: ["Alice Doe"],
        year: 2025,
        venue: "ACL Findings"
      },
      {
        paper_id: "paper_2",
        title: "CPU-Only Tree Baselines",
        abstract: "Tree ensembles offer small gains over logistic regression on public datasets.",
        authors: ["Bob Doe"],
        year: 2024,
        venue: "EMNLP"
      },
      {
        paper_id: "paper_3",
        title: "Reproducibility Notes for Repeated CV",
        abstract: "Repeated CV supports cautious, not universal, claims about ranking stability.",
        authors: ["Cara Doe"],
        year: 2024,
        venue: "TMLR"
      }
    ],
    experimentPlan: {
      selectedTitle: "Repeated CPU-only tabular baseline comparison",
      selectedSummary: "Compare nested and non-nested workflows on OpenML datasets with runtime and memory tracking.",
      rawText: [
        "selected_design:",
        '  title: "Repeated CPU-only tabular baseline comparison"',
        "  datasets:",
        '    - "breast_cancer"',
        '    - "iris"',
        "  metrics:",
        '    - "macro_f1_delta_vs_logreg"',
        '    - "pairwise_ranking_agreement"',
        "  baselines:",
        '    - "logistic regression"',
        '    - "extra trees"',
        "  implementation_notes:",
        '    - "OpenML datasets with 569 samples, 30 features, and 2 classes are used."',
        '    - "Standardize numeric columns, impute missing values, and fit preprocessing within each fold."',
        '    - "Class imbalance is tracked explicitly."',
        "  evaluation_steps:",
        '    - "Run outer 5-fold CV with inner 3-fold tuning."',
        '    - "Use stratified splits and repeat each workflow across fixed random seeds."',
        "  resource_notes:",
        '    - "Hyperparameter grid includes max_depth, n_estimators, and C."',
        "constraints:",
        "  implementation_notes:",
        '    - "OpenML dataset source and preprocessing order must be reported."',
        "  evaluation_notes:",
        '    - "Keep claims scoped to repeated evaluation artifacts and report runtime and memory."'
      ].join("\n")
    },
    resultAnalysis: {
      objective_metric: {
        evaluation: {
          summary: "Observed a small positive macro-F1 delta over logistic regression on the strongest workflow."
        },
        profile: {
          preferred_metric_keys: ["macro_f1_delta_vs_logreg"]
        }
      },
      metric_table: [
        { key: "macro_f1_delta_vs_logreg", value: 0.026 },
        { key: "pairwise_ranking_agreement", value: 0.885 },
        { key: "runtime_seconds_mean", value: 1.05 },
        { key: "peak_memory_mb_mean", value: 149 }
      ],
      condition_comparisons: [
        {
          id: "non_nested_vs_nested",
          label: "non-nested vs nested",
          source: "metrics.condition_metrics",
          metrics: [],
          summary: "Non-nested extra trees show a small positive delta over nested logistic regression."
        }
      ],
      primary_findings: [
        "The strongest workflow suggests a small positive macro-F1 delta over logistic regression.",
        "Runtime and memory remain close across the two workflows."
      ],
      limitations: [
        "The delta is small and varies by dataset.",
        "Repeated CV does not justify strong inferential language."
      ],
      statistical_summary: {
        total_trials: 3,
        executed_trials: 3,
        cached_trials: 0,
        confidence_intervals: [
          {
            metric_key: "macro_f1_delta_vs_logreg",
            label: "Macro-F1 delta",
            lower: 0.015,
            upper: 0.036,
            level: 0.95,
            source: "metrics",
            summary: "The 95% interval for the macro-F1 delta spans 0.015 to 0.036."
          }
        ],
        stability_metrics: [{ key: "pairwise_ranking_agreement", value: 0.885 }],
        effect_estimates: [
          {
            comparison_id: "non_nested_vs_nested",
            metric_key: "macro_f1_delta_vs_logreg",
            delta: 0.026,
            direction: "positive",
            summary: "The estimated macro-F1 delta remains positive but modest."
          }
        ],
        notes: [
          "Dispersion across repeated runs is moderate rather than negligible.",
          "Heterogeneity remains visible across datasets."
        ]
      },
      figure_specs: [
        {
          id: "delta_overview",
          title: "Dataset-level macro-F1 deltas",
          path: "figures/delta.svg",
          metric_keys: ["macro_f1_delta_vs_logreg"],
          summary: "Dataset-level macro-F1 deltas with uncertainty-aware interpretation."
        }
      ],
      synthesis: {
        source: "fallback",
        discussion_points: [
          "The observed gain is consistent with a benchmark note rather than a broad method claim."
        ],
        failure_analysis: [],
        follow_up_actions: [],
        confidence_statement: "Confidence is moderate because repeated evaluations exist, but dataset scope remains narrow."
      }
    } as any,
    latestResults: {
      protocol: {
        dataset_source: "OpenML",
        datasets: ["breast_cancer", "iris"],
        models: ["logreg", "extra_trees"],
        workflows: ["nested", "non_nested"],
        repeats: 3,
        seed_schedule: [100, 101, 102],
        n_samples: 569,
        n_features: 30,
        n_classes: 2
      },
      dataset_summaries: [
        {
          dataset: "breast_cancer",
          workflows: {
            nested: {
              models: {
                logreg: { mean_test_macro_f1: 0.91 },
                extra_trees: { mean_test_macro_f1: 0.922, mean_delta_vs_logreg: 0.012 }
              },
              pairwise_ranking_agreement: 0.86,
              winner_consistency: 0.8,
              runtime_seconds_mean: 1.3,
              peak_memory_mb_mean: 148
            },
            non_nested: {
              models: {
                logreg: { mean_test_macro_f1: 0.91 },
                extra_trees: { mean_test_macro_f1: 0.944, mean_delta_vs_logreg: 0.034 }
              },
              pairwise_ranking_agreement: 0.9,
              winner_consistency: 1,
              runtime_seconds_mean: 0.95,
              peak_memory_mb_mean: 151
            }
          }
        },
        {
          dataset: "iris",
          workflows: {
            nested: {
              models: {
                logreg: { mean_test_macro_f1: 0.89 },
                extra_trees: { mean_test_macro_f1: 0.905, mean_delta_vs_logreg: 0.015 }
              },
              pairwise_ranking_agreement: 0.84,
              winner_consistency: 0.8,
              runtime_seconds_mean: 1.1,
              peak_memory_mb_mean: 146
            },
            non_nested: {
              models: {
                logreg: { mean_test_macro_f1: 0.89 },
                extra_trees: { mean_test_macro_f1: 0.918, mean_delta_vs_logreg: 0.028 }
              },
              pairwise_ranking_agreement: 0.88,
              winner_consistency: 1,
              runtime_seconds_mean: 0.82,
              peak_memory_mb_mean: 150
            }
          }
        }
      ],
      repeat_records: [
        {
          repeat_index: 0,
          datasets: [
            {
              dataset: "breast_cancer",
              workflows: {
                non_nested: {
                  models: {
                    logreg: { test_macro_f1: 0.91 },
                    extra_trees: { test_macro_f1: 0.945 }
                  }
                }
              }
            },
            {
              dataset: "iris",
              workflows: {
                non_nested: {
                  models: {
                    logreg: { test_macro_f1: 0.89 },
                    extra_trees: { test_macro_f1: 0.919 }
                  }
                }
              }
            }
          ]
        },
        {
          repeat_index: 1,
          datasets: [
            {
              dataset: "breast_cancer",
              workflows: {
                non_nested: {
                  models: {
                    logreg: { test_macro_f1: 0.91 },
                    extra_trees: { test_macro_f1: 0.944 }
                  }
                }
              }
            },
            {
              dataset: "iris",
              workflows: {
                non_nested: {
                  models: {
                    logreg: { test_macro_f1: 0.89 },
                    extra_trees: { test_macro_f1: 0.918 }
                  }
                }
              }
            }
          ]
        },
        {
          repeat_index: 2,
          datasets: [
            {
              dataset: "breast_cancer",
              workflows: {
                non_nested: {
                  models: {
                    logreg: { test_macro_f1: 0.91 },
                    extra_trees: { test_macro_f1: 0.943 }
                  }
                }
              }
            },
            {
              dataset: "iris",
              workflows: {
                non_nested: {
                  models: {
                    logreg: { test_macro_f1: 0.89 },
                    extra_trees: { test_macro_f1: 0.917 }
                  }
                }
              }
            }
          ]
        }
      ]
    },
    relatedWorkNotes: [
      {
        paper_id: "paper_1",
        title: "Nested Validation for Tabular Baselines",
        source_type: "analyzed_paper",
        comparison_role: "closest",
        method_family: "evaluation and benchmarking",
        problem_focus: "selection optimism in small tabular data",
        setting_focus: "public tabular datasets",
        contribution_focus: "nested validation baselines",
        limitation_or_caveat: "added compute cost",
        relation_to_study: "closest baseline for evaluation protocol"
      },
      {
        paper_id: "paper_2",
        title: "CPU-Only Tree Baselines",
        source_type: "analyzed_paper",
        comparison_role: "supporting",
        method_family: "classical model baselines",
        problem_focus: "small positive deltas over logistic regression",
        setting_focus: "CPU-only public datasets",
        contribution_focus: "resource-aware tree baselines",
        limitation_or_caveat: "dataset-dependent gains",
        relation_to_study: "supports model comparison framing"
      },
      {
        paper_id: "paper_3",
        title: "Reproducibility Notes for Repeated CV",
        source_type: "analyzed_paper",
        comparison_role: "supporting",
        method_family: "reproducibility and statistics",
        problem_focus: "heterogeneity under repeated evaluation",
        setting_focus: "repeated CV",
        contribution_focus: "cautious statistical framing",
        limitation_or_caveat: "does not justify strong inferential claims",
        relation_to_study: "supports cautious discussion framing"
      }
    ]
  };
}

function makeTerseDraft(): PaperDraft {
  return {
    title: "A Short Draft",
    abstract: "A short draft.",
    keywords: ["tabular baselines"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: [{ text: "We compare tabular baselines.", evidence_ids: ["ev_1"], citation_paper_ids: ["paper_1"] }],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Method",
        paragraphs: [{ text: "We use a benchmark.", evidence_ids: ["ev_1"], citation_paper_ids: ["paper_1"] }],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Results",
        paragraphs: [{ text: "We observed improvement.", evidence_ids: ["ev_1"], citation_paper_ids: ["paper_1"] }],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Conclusion",
        paragraphs: [{ text: "The benchmark is useful.", evidence_ids: ["ev_1"], citation_paper_ids: ["paper_1"] }],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      }
    ],
    claims: [
      {
        claim_id: "c1",
        statement: "The method demonstrates significant improvement.",
        section_heading: "Results",
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      }
    ]
  };
}

describe("scientificWriting", () => {
  it("sanitizes internal provenance and bounds schema-reported objective claims", () => {
    const cleaned = sanitizePaperNarrativeText(
      "The paper-writing payload records a threshold decision for the configured model [configured model]. Objective metric met: validation_score=0.72 >= 0.65. raw_precision=0.71 raw_recall=0.69. The evidence remains under a bounded claim ceiling, and details are stored at /tmp/run/results.json."
    );

    expect(cleaned).toContain("reported evidence records a threshold decision");
    expect(cleaned).toContain("archived objective check cleared its configured screening threshold");
    expect(cleaned).toContain("structured result tables remain the source of numerical support");
    expect(cleaned).toContain("bounded interpretation");
    expect(cleaned).toContain("the local workspace");
    expect(cleaned).not.toMatch(/paper-writing payload|Objective metric met|raw_precision|raw_recall|\[configured model\]|\/tmp\/run/i);
  });

  it("keeps internal manuscript defaults minimal when brief and template policy are absent", () => {
    const profile = resolvePaperProfile(undefined);
    expect(profile.column_count).toBe(2);
    expect(profile.appendix_format).toBe("double_column");
    expect(profile.prefer_appendix_for).toEqual([]);
    expect(profile.estimated_words_per_page).toBe(650);
  });

  it("derives single-column layout defaults without inventing appendix routing preferences", () => {
    const profile = resolvePaperProfile({ column_count: 1 });
    expect(profile.column_count).toBe(1);
    expect(profile.appendix_format).toBe("single_column");
    expect(profile.prefer_appendix_for).toEqual([]);
    expect(profile.estimated_words_per_page).toBe(700);
  });

  it("uses target_main_pages for word budgets while preserving a separate minimum_main_pages floor", () => {
    const report = pageBudgetManager({
      draft: makeTerseDraft(),
      profile: {
        ...PAPER_PROFILE,
        target_main_pages: 10,
        minimum_main_pages: 8,
        main_page_limit: 8
      }
    });

    expect(report.target_main_pages).toBe(10);
    expect(report.minimum_main_pages).toBe(8);
    expect(report.main_page_limit).toBe(8);
    expect(report.target_main_words).toBe(6500);
    expect(report.warnings[0]).toContain("10-page target budget");
  });

  it("expands a terse draft into a richer main paper and appendix when detailed artifacts exist", () => {
    const bundle = makeRichBundle();
    const draft = makeTerseDraft();

    const scientific = applyScientificWritingPolicy({
      draft,
      bundle,
      profile: PAPER_PROFILE
    });

    expect(scientific.method_completeness.status).toBe("complete");
    expect(scientific.results_richness.status).toBe("complete");
    expect(scientific.related_work_richness.status).toBe("complete");
    expect(scientific.discussion_richness.status).toBe("complete");
    expect(scientific.draft.sections.find((section) => section.heading === "Discussion")).toBeTruthy();
    expect(scientific.draft.sections.find((section) => section.heading === "Limitations")).toBeTruthy();
    expect(scientific.draft.sections.find((section) => section.heading === "Method")?.paragraphs.length).toBeGreaterThanOrEqual(3);
    expect(scientific.draft.sections.find((section) => section.heading === "Results")?.paragraphs.length).toBeGreaterThanOrEqual(4);
    expect(scientific.appendix_plan.sections.length).toBeGreaterThan(0);

    const candidate: PaperManuscript = {
      title: "Repeated Tabular Benchmark",
      abstract: "A short abstract.",
      keywords: ["tabular"],
      sections: scientific.draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
      }))
    };

    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(manuscript.manuscript.appendix_sections?.length).toBeGreaterThan(0);
    expect(manuscript.manuscript.sections.find((section) => section.heading === "Method")?.paragraphs.at(-1)).toMatch(/Appendix/i);
    expect(manuscript.manuscript.sections.find((section) => section.heading === "Results")?.paragraphs.at(-1)).toMatch(/Appendix/i);
    const relatedText = manuscript.manuscript.sections.find((section) => section.heading === "Related Work")?.paragraphs.join(" ") || "";
    expect(relatedText).toContain("Nested Validation for Tabular Baselines");
    expect(relatedText).toContain("CPU-Only Tree Baselines");
    expect(relatedText).toMatch(/positioning anchors rather than direct condition-matched baselines/i);
    const conclusionText = manuscript.manuscript.sections.find((section) => section.heading === "Conclusion")?.paragraphs.join(" ") || "";
    expect(conclusionText).toMatch(/keeps execution coverage and supplementary metrics secondary/i);
    expect(conclusionText).not.toMatch(/Detailed protocol and repeat-level evidence/i);
    expect(manuscript.consistency_lint.ok).toBe(true);
    expect(manuscript.appendix_lint.ok).toBe(true);
    expect(manuscript.provenance_map.paragraph_anchors.length).toBeGreaterThan(0);
    expect(manuscript.provenance_map.numeric_anchors.some((anchor) => anchor.support_status === "supported")).toBe(true);
  });

  it("records auto-repair recheck state after expanding thin sections", () => {
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle: makeRichBundle(),
      profile: PAPER_PROFILE
    });

    expect(scientific.auto_repairs.expansion_recheck.attempted).toBe(true);
    expect(scientific.auto_repairs.expanded_sections.length).toBeGreaterThan(0);
    expect(
      scientific.auto_repairs.expansion_recheck.resolved_headings.length
      + scientific.auto_repairs.expansion_recheck.unresolved_headings.length
    ).toBe(scientific.auto_repairs.expanded_sections.length);
  });

  it("keeps related-work expansion from turning raw abstracts, authors, or metric bullets into prose", () => {
    const bundle = makeRichBundle();
    bundle.experimentPlan = {
      ...(bundle.experimentPlan || {}),
      selectedTitle: "condition parameters under fixed budget instruction tuning",
      selectedSummary: "Compare condition parameters cells on Benchmark Task A and Benchmark Task B with a selected instruction-tuning backbone.",
      rawText: [
        "selected_design:",
        '  title: "condition parameters under fixed budget instruction tuning"',
        '  model: "the selected backbone"',
        '  method: "parameterized method"',
        "  datasets:",
        '    - "Benchmark Task A"',
        '    - "Benchmark Task B"'
      ].join("\n")
    };
    bundle.objectiveMetric = [
      "- Primary metric: average accuracy across Benchmark Task A and Benchmark Task B.",
      "- Secondary metrics: per-task accuracy, train loss, wall-clock runtime.",
      "- Meaningful improvement: at least +1.0 percentage point."
    ].join(" ");
    bundle.relatedWorkNotes = [
      {
        paper_id: "paper_1",
        title: "Composable Methods: Enhancing Instruction Fine-Tuning",
        source_type: "analyzed_paper",
        comparison_role: "closest",
        method_family: "prompting and control",
        problem_focus:
          "Recently, large language models with conversational-style interaction, such as ChatGPT and Claude, have gained significant importance in the advancement of artificial gen...",
        setting_focus: "instruction tuning",
        contribution_focus: "parameterized method comparison",
        limitation_or_caveat: "Small empirical scope",
        relation_to_study: "Provides a nearby comparison point."
      },
      {
        paper_id: "paper_2",
        title: "From Base to Conversational: Japanese Instruction Dataset and Tuning Large Language Models",
        source_type: "analyzed_paper",
        comparison_role: "supporting",
        method_family: "prompting and control",
        problem_focus:
          "From Base to Conversational: Japanese Instruction Dataset and Tuning Large Language Models Masahiro Suzuki Masanori Hirano Hiroki Sakaji The University of Tokyo The University o...",
        setting_focus: "instruction tuning",
        contribution_focus: "Instruction dataset construction",
        limitation_or_caveat: "Metadata-only support",
        relation_to_study: "Provides background."
      },
      {
        paper_id: "paper_3",
        title: "Abstract-only fallback for A review on genetic algorithm: past, present, and future",
        source_type: "analyzed_paper",
        comparison_role: "supporting",
        method_family: "literature discovery and retrieval",
        problem_focus: "This paper proposes a low-cost educational advising LLM for study-abroad contexts.",
        setting_focus: "resource-constrained deployment",
        contribution_focus: "Resource-constrained configuration application",
        limitation_or_caveat: "Different task setting",
        relation_to_study: "Provides background."
      },
      {
        paper_id: "paper_4",
        title: "GIFT: A Framework for Tool Coordination",
        source_type: "analyzed_paper",
        comparison_role: "supporting",
        method_family: "stateful coordination",
        problem_focus: "GIFT is a framework for stateful coordination across external tools.",
        setting_focus: "agent orchestration",
        contribution_focus: "Agent coordination",
        limitation_or_caveat: "Different task setting",
        relation_to_study: "Provides background."
      }
    ];
    bundle.relatedWorkScout = {
      query: "configured condition parameter x",
      rationale: "Exercise bibliographic spillover filtering.",
      papers: [
        {
          paper_id: "paper_scout_1",
          title: "Decoupled Parameterization",
          summary:
            "Published as a conference paper at ICLR 2025 on decoupling parameter magnitude and direction in a configurable method.",
          source_type: "semantic_scholar_scout",
          venue: "ICLR",
          year: 2025,
          citation_count: 12
        }
      ]
    };

    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const context = experimentArtifactLoader({ bundle });
    expect(context.related_work.clusters.length).toBeGreaterThanOrEqual(3);
    expect(context.related_work.clusters.join(" ")).not.toMatch(/literature discovery|stateful coordination|genetic algorithm/i);

    const relatedText = scientific.draft.sections.find((section) => section.heading === "Related Work")?.paragraphs
      .map((paragraph) => paragraph.text)
      .join(" ") || "";
    expect(relatedText).not.toContain("Masahiro Suzuki");
    expect(relatedText).not.toContain("The University of Tokyo");
    expect(relatedText).not.toContain("- Primary metric:");
    expect(relatedText).not.toMatch(/comparison axes concern Recently,/i);
    expect(relatedText).not.toMatch(/literature discovery|stateful coordination|GIFT is|genetic algorithm|Published as a conference paper|D E L O RA|Massimo Bini/i);
    expect(relatedText).toMatch(/method family|resource budget|evaluation scope|prompting and control/i);
  });

  it("restores only available draft evidence when the manuscript remains below the page floor", () => {
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle: makeRichBundle(),
      profile: {
        ...PAPER_PROFILE,
        target_main_pages: 6,
        minimum_main_pages: 6,
        main_page_limit: 6
      }
    });
    const budgetParagraph =
      "The restored manuscript retains this evidence-grounded detail in the main body so that the compiled paper remains comparable to the page-budgeted scientific draft and does not collapse into a short summary after repair.";
    const draft = {
      ...scientific.draft,
      sections: scientific.draft.sections.map((section) =>
        ["Method", "Results", "Discussion"].includes(section.heading)
          ? {
              ...section,
              paragraphs: [
                ...section.paragraphs,
                ...Array.from({ length: 25 }, (_, index) => ({
                  text:
                    index === 0 && section.heading === "Results"
                      ? "Objective metric met: validation_score=0.72 >= 0.65. candidate_score=0.72 reference_score=0.64."
                      : index === 2 && section.heading === "Results"
                        ? "The observed leading condition cleared the configured screening threshold by point estimate, but the result remains a follow-up signal rather than a stable success claim."
                      : index === 1 && section.heading === "Method"
                        ? "Workflow audit details describe an internal cached-target validation."
                      : index === 2 && section.heading === "Method"
                        ? "The evaluation spans Training: a fixed subset. Models or conditions include Primary trained baseline: condition x with the same budget and configured_primary_baseline."
                      : `Restoration note ${index + 1} for ${section.heading}: ${budgetParagraph}`,
                  evidence_ids: section.evidence_ids,
                  citation_paper_ids: section.citation_paper_ids
                }))
              ]
            }
          : section
      )
    };
    const pageBudget = pageBudgetManager({
      draft,
      profile: {
        ...PAPER_PROFILE,
        target_main_pages: 6,
        minimum_main_pages: 6,
        main_page_limit: 6
      }
    });
    const compressed: PaperManuscript = {
      title: "Compressed manuscript",
      abstract: "A short abstract.",
      keywords: ["tabular"],
      sections: draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.slice(0, 1).map((paragraph) => paragraph.text)
      }))
    };

    const restored = enforceManuscriptPageBudgetFloor({
      manuscript: compressed,
      draft,
      pageBudget
    });

    const restoredWords = restored.manuscript.sections.reduce(
      (total, section) => total + section.paragraphs.join(" ").split(/\s+/u).filter(Boolean).length,
      0
    );
    expect(pageBudget.status).toBe("ok");
    expect(restored.applied).toBe(true);
    expect(restored.added_paragraph_count).toBeGreaterThan(0);
    expect(restoredWords).toBeGreaterThan(0);
    expect(restoredWords).toBeLessThan(pageBudget.minimum_main_words);
    expect(restored.added_sections).toEqual(expect.arrayContaining(["Method", "Results"]));
    const restoredText = JSON.stringify(restored.manuscript);
    expect(restoredText).toContain("The archived objective check cleared its configured screening threshold");
    expect(restoredText.match(/configured screening threshold/gi)?.length).toBeLessThanOrEqual(2);
    expect(restoredText).not.toContain("The prespecified baseline-relative accuracy target was met");
    expect(restoredText).toContain("observed leading condition");
    expect(restoredText).not.toContain("validation_score");
    expect(restoredText).not.toContain("candidate_score");
    expect(restoredText).not.toContain("reference_score");
    expect(restoredText).not.toContain("Workflow audit details");
    expect(restoredText).not.toContain("Evaluation spans Training:");
    expect(restoredText).not.toContain("Models or conditions include Primary trained baseline");
    expect(restoredText).not.toContain("configured_primary_baseline");
    expect(restoredText).not.toMatch(/review gating|paper-readiness audit|result-table integrity/i);
    expect(restoredText).not.toMatch(/bounded claim ceiling|claim downgrade correctness/i);
  });
  it("does not restore prompt or cache residue while enforcing the final page floor", () => {
    const cachedRecoveryResidue = "Cache recovery note for an internal source snapshot.";
    const promptTopicResidue = [
      "Study how",
      "condition parameters interact during",
      "constrained model adaptation under a fixed local compute budget."
    ].join(" " );
    const readinessResidue = ["paper-readiness", "inspect"].join(" " );
    const awkwardMetricResidue = ["Parameter-computationally", "practical within the reported setup"].join(" " );
    const datasetLead = ["Dataset-level", "reporting shows"].join(" " );
    const budgetCaveatResidue = "The run workload may exceed the configured local compute budget.";

    const draft: PaperDraft = {
      title: "Residue restoration test",
      abstract: "Short.",
      keywords: [],
      sections: [
        {
          heading: "Introduction",
          paragraphs: [
            {
              text: `This study addresses ${promptTopicResidue} The local preflight run uses a cached target so the validation focuses on real training, result-table consistency, review checks, and ${readinessResidue}. ${cachedRecoveryResidue}`,
              evidence_ids: [],
              citation_paper_ids: []
            },
            { text: `${awkwardMetricResidue} tuning is attractive under local budgets.`, evidence_ids: [], citation_paper_ids: [] },
            { text: "This framing matters because the experiment is a bounded screening study whose evidence remains tied to the executed run record.", evidence_ids: [], citation_paper_ids: [] }
          ],
          evidence_ids: [],
          citation_paper_ids: []
        },
        {
          heading: "Results",
          paragraphs: [
            { text: `${datasetLead} a symmetric leading point estimate across the two evaluation tasks.`, evidence_ids: [], citation_paper_ids: [] },
            { text: `${datasetLead} a symmetric best-condition point estimate across the two evaluation tasks.`, evidence_ids: [], citation_paper_ids: [] },
            { text: "The exposed condition-level intervals remain wide, so the point estimate remains a screening signal.", evidence_ids: [], citation_paper_ids: [] }
          ],
          evidence_ids: [],
          citation_paper_ids: []
        },
        {
          heading: "Limitations",
          paragraphs: [
            { text: "The first limitation is scope. The study is a local small-model screen, not a broad benchmark.", evidence_ids: [], citation_paper_ids: [] },
            { text: budgetCaveatResidue, evidence_ids: [], citation_paper_ids: [] }
          ],
          evidence_ids: [],
          citation_paper_ids: []
        }
      ],
      claims: []
    };
    const pageBudget = pageBudgetManager({
      draft,
      profile: {
        ...PAPER_PROFILE,
        target_main_pages: 2,
        minimum_main_pages: 2,
        main_page_limit: 2,
        estimated_words_per_page: 260
      }
    });
    const restored = enforceManuscriptPageBudgetFloor({
      manuscript: {
        title: "Compressed",
        abstract: "Short.",
        keywords: [],
        sections: [
          { heading: "Introduction", paragraphs: ["This is a short introduction."] },
          { heading: "Results", paragraphs: [`${datasetLead} a symmetric leading point estimate across the two evaluation tasks.`] },
          { heading: "Limitations", paragraphs: ["The first limitation is scope. The study is a local small-model screen, not a broad benchmark."] }
        ]
      },
      draft,
      pageBudget: { ...pageBudget, minimum_main_words: 360, maximum_main_words: 520 }
    });

    const text = JSON.stringify(restored.manuscript);
    expect(restored.applied).toBe(true);
    expect(text).not.toContain(cachedRecoveryResidue);
    expect(text).not.toContain(promptTopicResidue);
    expect(text).not.toContain(readinessResidue);
    expect(text).not.toContain(awkwardMetricResidue);
    expect(text).not.toContain(budgetCaveatResidue);
    const resultText = restored.manuscript.sections.find((section) => section.heading === "Results")?.paragraphs.join("\n") || "";
    expect((resultText.match(new RegExp(datasetLead, "g")) || []).length).toBe(1);
    expect(resultText).not.toContain("best-condition point estimate");
  });

  it("does not restore draft-facing citation instructions through page-floor repair", () => {
    const draftFacingMethodSentence = "The reporting material available for this draft does not include the full numerical hyperparameter table; those values should be presented in the reproducibility supplement before the study is treated as externally replicable.";
    const draftFacingLimitationsSentence = "Several related-work notes available to this draft are conservative summaries rather than fully validated extraction records, so they should not be used as quantitative baselines.";
    const finalCitationInstruction = "In addition, the final manuscript should cite stable sources for the base model, dataset, benchmark, and evaluation harness.";
    const draft: PaperDraft = {
      title: "Draft-facing residue floor test",
      abstract: "Short.",
      keywords: [],
      sections: [
        {
          heading: "Method",
          paragraphs: [
            {
              text: `The shared protocol fixes the configured condition grid, seed handling, and evaluation tasks. ${draftFacingMethodSentence}`,
              evidence_ids: [],
              citation_paper_ids: []
            },
            {
              text: "The method still records enough information to identify the baseline, completed condition cells, data cap, and scoring convention.",
              evidence_ids: [],
              citation_paper_ids: []
            }
          ],
          evidence_ids: [],
          citation_paper_ids: []
        },
        {
          heading: "Results",
          paragraphs: [
            {
              text: "The results table keeps the baseline and leading condition visible while treating the observed gain as a screening signal.",
              evidence_ids: [],
              citation_paper_ids: []
            }
          ],
          evidence_ids: [],
          citation_paper_ids: []
        },
        {
          heading: "Limitations",
          paragraphs: [
            {
              text: `${draftFacingLimitationsSentence} ${finalCitationInstruction} Until the full reproducibility supplement is included, claims should remain bounded to the reported local workflow.`,
              evidence_ids: [],
              citation_paper_ids: []
            }
          ],
          evidence_ids: [],
          citation_paper_ids: []
        }
      ],
      claims: []
    };
    const pageBudget = pageBudgetManager({
      draft,
      profile: {
        ...PAPER_PROFILE,
        target_main_pages: 2,
        minimum_main_pages: 2,
        main_page_limit: 2,
        estimated_words_per_page: 300
      }
    });

    const restored = enforceManuscriptPageBudgetFloor({
      manuscript: {
        title: "Compressed",
        abstract: "Short.",
        keywords: [],
        sections: [
          { heading: "Method", paragraphs: ["The method starts from a short protocol summary."] },
          { heading: "Results", paragraphs: ["The result is a bounded screening comparison."] },
          { heading: "Limitations", paragraphs: ["The main limitation is scope."] }
        ]
      },
      draft,
      pageBudget: { ...pageBudget, minimum_main_words: 360, maximum_main_words: 640 }
    });
    const stabilized = stabilizePaperManuscriptForSubmission(restored.manuscript);
    const text = JSON.stringify(stabilized);

    expect(restored.applied).toBe(true);
    expect(text).toContain("The shared protocol fixes the configured condition grid");
    expect(text).not.toMatch(/this draft|available to this draft|final manuscript should cite|stable sources/iu);
    expect(text).not.toMatch(/those values should be presented|reproducibility supplement/iu);
  });

  it("refreshes page-budget validation from the repaired manuscript before strict gating", () => {
    const profile = {
      ...PAPER_PROFILE,
      target_main_pages: 6,
      minimum_main_pages: 6,
      main_page_limit: 6,
      estimated_words_per_page: 780
    };
    const shortDraft: PaperDraft = {
      title: "Short draft",
      abstract: "Short.",
      keywords: [],
      sections: ["Introduction", "Related Work", "Method", "Results", "Discussion", "Limitations", "Conclusion"].map((heading) => ({
        heading,
        paragraphs: [{ text: "short", evidence_ids: [], citation_paper_ids: [] }],
        evidence_ids: [],
        citation_paper_ids: []
      })),
      claims: []
    };
    const shortBudget = pageBudgetManager({ draft: shortDraft, profile });
    const complete = {
      status: "complete" as const,
      present: [],
      missing: [],
      warnings: []
    };
    const validation = buildScientificValidationArtifact({
      draft: shortDraft,
      page_budget: shortBudget,
      method_completeness: complete,
      results_richness: complete,
      related_work_richness: { ...complete, cluster_count: 3 },
      discussion_richness: complete,
      evidence_diagnostics: {
        expandable_from_existing_evidence: true,
        missing_evidence_categories: [],
        thin_sections: shortBudget.auto_expand_headings,
        blocked_by_evidence_insufficiency: false,
        section_diagnostics: []
      },
      claim_rewrite_report: { rewrites: [] },
      appendix_plan: { sections: [], tables: [], figures: [], cross_references: [] },
      auto_repairs: {
        expanded_sections: [],
        expansion_recheck: {
          attempted: false,
          page_budget_before: shortBudget.status,
          page_budget_after: shortBudget.status,
          resolved_headings: [],
          unresolved_headings: shortBudget.auto_expand_headings
        }
      }
    });
    const longParagraph = Array.from({ length: 1400 }, (_, index) => `word${index}`).join(" ");
    const manuscript: PaperManuscript = {
      title: "Repaired manuscript",
      abstract: "A repaired abstract.",
      keywords: [],
      sections: shortDraft.sections.map((section) => ({
        heading: section.heading,
        paragraphs: [longParagraph]
      }))
    };

    const refreshed = refreshScientificValidationForManuscript({
      validation,
      manuscript,
      profile
    });
    const gateDecision = buildWritePaperGateDecision({
      mode: "strict_paper",
      scientificValidation: refreshed,
      consistencyLint: { ok: true, issues: [] },
      appendixLint: { ok: true, issues: [] }
    });

    expect(validation.issues.some((issue) => issue.category === "page_budget")).toBe(true);
    expect(refreshed.page_budget.status).toBe("ok");
    expect(refreshed.issues.some((issue) => issue.category === "page_budget")).toBe(false);
    expect(gateDecision.status).toBe("pass");
  });

  it("does not fabricate fallback paragraphs when the draft cannot meet the page floor", () => {
    const draft: PaperDraft = {
      title: "Compressed draft",
      abstract: "Short.",
      keywords: [],
      sections: ["Method", "Results"].map((heading) => ({
        heading,
        paragraphs: [{ text: "A short duplicate paragraph.", evidence_ids: [], citation_paper_ids: [] }],
        evidence_ids: [],
        citation_paper_ids: []
      })),
      claims: []
    };
    const profile = {
      ...PAPER_PROFILE,
      target_main_pages: 2,
      minimum_main_pages: 2,
      main_page_limit: 2,
      estimated_words_per_page: 500
    };
    const pageBudget = pageBudgetManager({ draft, profile });
    const compressed: PaperManuscript = {
      title: "Compressed manuscript",
      abstract: "Short.",
      keywords: [],
      sections: draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
      }))
    };

    const restored = enforceManuscriptPageBudgetFloor({
      manuscript: compressed,
      draft,
      pageBudget: {
        ...pageBudget,
        minimum_main_words: 1000,
        maximum_main_words: 1300,
        estimated_words_per_page: 500
      }
    });

    expect(restored.applied).toBe(false);
    expect(restored.estimated_main_words_after).toBeLessThan(1000);
    expect(restored.added_paragraph_count).toBe(0);
  });

  it("uses LM benchmark evidence instead of tabular CV requirements when latest_results is absent", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition repeated-seed benchmark";
    bundle.topic = "condition parameters interaction for a small LLM benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = undefined as any;
    bundle.experimentPlan = {
      selectedTitle: "5-seed condition-parameter stability against locked baseline",
      selectedSummary: "Compare repeated condition-parameter cells on Benchmark Task A and Benchmark Task B.",
      rawText: [
        "selected_design:",
        '  title: "5-seed condition-parameter stability against locked baseline"',
        "  datasets:",
        '    - "training dataset subset"',
        '    - "Benchmark Task A"',
        '    - "Benchmark Task B"',
        "  metrics:",
        '    - "average_accuracy"',
        '    - "accuracy_delta_vs_baseline"',
        '    - "benchmark_task_a_accuracy"',
        '    - "benchmark_task_b_accuracy"',
        "  baselines:",
        '    - "locked baseline condition"',
        "  implementation_notes:",
        '    - "Use the selected backbone as the base model with parameterized updates."',
        '    - "Hold optimizer, token budget, data order, and evaluation harness constant."',
        '    - "Training dataset is training dataset with max_train_samples=10000 examples."',
        "  evaluation_steps:",
        '    - "Execute 25 train-plus-eval runs total across repeated seeded condition-parameter cells."',
        '    - "Use training seeds [42,43,44,45,46] and report failed runs."',
        "  resource_notes:",
        '    - "Hyperparameter grid covers condition parameters."'
      ].join("\n")
    };
    bundle.relatedWorkNotes = [
      {
        paper_id: "quantized_method",
        title: "quantized method: Efficient Finetuning of Quantized LLMs",
        source_type: "analyzed_paper",
        comparison_role: "supporting",
        method_family: "configuration fine-tuning",
        problem_focus: "configuration-based fine-tuning of language models.",
        setting_focus: "LLM adaptation.",
        contribution_focus: "Quantized LLM fine-tuning with parameterized updates.",
        limitation_or_caveat: "Not a condition-parameter repeated-seed audit.",
        relation_to_study: "Provides a nearby comparison point for the current study objective.",
        year: 2023
      },
      {
        paper_id: "maple",
        title: "MAPLE: Multilingual Evaluation of Parameter Efficient Finetuning",
        source_type: "analyzed_paper",
        comparison_role: "supporting",
        method_family: "evaluation and benchmarking",
        problem_focus: "method-family benchmark design for language models.",
        setting_focus: "Benchmark evaluation.",
        contribution_focus: "Evaluation breadth for method-family.",
        limitation_or_caveat: "Different task mix.",
        relation_to_study: "Supports positioning of benchmark scope.",
        year: 2024
      },
      {
        paper_id: "vbadapter",
        title: "Variant-B",
        source_type: "analyzed_paper",
        comparison_role: "background",
        method_family: "alternative parameterization",
        problem_focus: "Parameter-efficient condition variants.",
        setting_focus: "LLM adaptation.",
        contribution_focus: "Alternative configuration parameterization.",
        limitation_or_caveat: "Not the same locked-baseline audit.",
        relation_to_study: "Background for parameter x-sensitive configuration choices.",
        year: 2024
      }
    ];
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "accuracy_delta_vs_baseline", value: 0.0375 },
        { key: "benchmark_task_a_accuracy", value: 0.625 },
        { key: "benchmark_task_b_accuracy", value: 0.375 },
        { key: "average_accuracy", value: 0.4775 },
        { key: "run_accuracy_delta_vs_baseline_std", value: 0.0748 },
        { key: "run_accuracy_delta_vs_baseline_ci95", value: 0.0293 },
        { key: "wall_clock_runtime_s", value: 244.2 },
        { key: "peak_vram_bytes_mean", value: 4946062049 },
        { key: "completed_run_count", value: 25 }
      ],
      condition_comparisons: [
        {
          id: "candidate_condition_vs_baseline",
          label: "candidate condition b vs baseline condition",
          source: "metrics.condition_summaries",
          summary: "Candidate condition b improves average accuracy relative to the locked baseline.",
          metrics: [{ key: "accuracy_delta_vs_baseline_mean", value: 0.0525 }]
        }
      ],
      statistical_summary: {
        total_trials: 25,
        executed_trials: 25,
        cached_trials: 0,
        confidence_intervals: [
          {
            metric_key: "accuracy_delta_vs_baseline",
            label: "Accuracy delta",
            lower: 0.0155,
            upper: 0.0741,
            level: 0.95,
            source: "metrics",
            summary: "The repeated-seed 95% interval for the accuracy delta remains positive."
          }
        ],
        stability_metrics: [{ key: "run_accuracy_delta_vs_baseline_std", value: 0.0748 }],
        effect_estimates: [
          {
            comparison_id: "candidate_condition_vs_baseline",
            metric_key: "accuracy_delta_vs_baseline",
            delta: 0.0525,
            direction: "positive",
            summary: "The best nonbaseline cell has a positive mean delta."
          }
        ],
        notes: ["Seed-level dispersion is reported across the repeated benchmark runs."]
      },
      figure_specs: [
        {
          id: "performance",
          title: "configuration benchmark performance",
          path: "figures/performance.svg",
          metric_keys: ["accuracy_delta_vs_baseline"],
          summary: "Repeated-seed configuration benchmark comparison with task accuracies."
        }
      ],
      primary_findings: [
        "All 25 planned runs executed.",
        "The best nonbaseline cell shows a positive directional accuracy delta."
      ],
      limitations: ["The small LLM preflight does not establish a general stability law."],
      synthesis: {
        source: "fallback",
        discussion_points: ["The evidence supports a narrow benchmark signal, not a universal configuration prescription."],
        failure_analysis: [],
        follow_up_actions: [],
        confidence_statement: "Confidence is moderate because repeated runs and intervals are available."
      }
    } as any;

    const context = experimentArtifactLoader({ bundle });
    expect(context.protocol_kind).toBe("lm_benchmark");

    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });

    expect(scientific.method_completeness.status).toBe("complete");
    expect(scientific.method_completeness.present).toContain("model/backbone");
    expect(scientific.method_completeness.missing).not.toContain("#classes");
    expect(scientific.method_completeness.missing).not.toContain("outer folds");
    expect(scientific.results_richness.status).toBe("complete");
    expect(scientific.related_work_richness.status).toBe("complete");
  });

  it("recovers live configuration method and dispersion evidence from execution metadata", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition repeated-seed benchmark";
    bundle.topic = "condition parameters interaction for a small LLM benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.experimentPlan = {
      selectedTitle: "5-seed condition-parameter stability against locked baseline",
      selectedSummary: "Compare repeated condition-parameter cells on Benchmark Task A and Benchmark Task B.",
      rawText: [
        "selected_design:",
        '  title: "5-seed condition-parameter stability against locked baseline"',
        "  datasets:",
        '    - "training dataset subset"',
        "  metrics:",
        '    - "average_accuracy"',
        '    - "accuracy_delta_vs_baseline"',
        "  implementation_notes:",
        '    - "Use the selected backbone as the base model with parameterized updates."',
        '    - "Hold optimizer, data order, and evaluation harness constant."',
        "  evaluation_steps:",
        '    - "Use training seeds [42,43,44] and report failed runs."',
        "  resource_notes:",
        '    - "Hyperparameter grid covers condition parameters."'
      ].join("\n")
    };
    bundle.latestResults = {
      protocol: {
        datasets: ["training dataset"],
        seed_schedule: [42, 43, 44],
        repeats: 3
      },
      selected_model: "the selected backbone",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          label: "baseline condition",
          is_baseline: true,
          completed_seed_count: 3,
          seed_results: [
            {
              train_metadata: {
                num_train_samples: 48,
                train_dataset_token_count: 8120,
                trainer_state: {
                  learning_rate: 0.0002,
                  per_device_train_batch_size: 1,
                  gradient_accumulation_steps: 4,
                  optimizer_steps: 6
                }
              }
            }
          ]
        },
        {
          condition_marker: "candidate_condition_f5",
          label: "candidate condition b",
          completed_seed_count: 3,
          average_accuracy_mean: 0.4775,
          accuracy_delta_vs_baseline_mean: 0.075
        }
      ],
      condition_results: [
        {
          marker: "baseline_condition",
          per_task_metrics: {
            benchmark_task_a: { accuracy: 0.5, correct: 3, total: 6 },
            benchmark_task_b: { accuracy: 0.35, correct: 2, total: 6 }
          }
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "accuracy_delta_vs_baseline", value: 0.075 },
        { key: "benchmark_task_a_accuracy", value: 0.625 },
        { key: "benchmark_task_b_accuracy", value: 0.375 },
        { key: "average_accuracy", value: 0.4775 },
        { key: "runtime_seconds_mean", value: 244.2 },
        { key: "peak_vram_bytes_mean", value: 4946062049 }
      ],
      primary_findings: [
        "Benchmark Task A and Benchmark Task B task accuracies are reported for the configuration benchmark.",
        "The candidate condition b condition improves over the locked baseline."
      ],
      figure_specs: [
        {
          id: "condition_delta",
          title: "Condition-level accuracy deltas",
          path: "figures/condition_delta.svg",
          metric_keys: ["accuracy_delta_vs_baseline"],
          summary: "Repeated-seed condition deltas for the condition grid."
        }
      ],
      statistical_summary: {
        total_trials: 6,
        executed_trials: 6,
        cached_trials: 0,
        confidence_intervals: [
          {
            metric_key: "accuracy_delta_vs_baseline",
            label: "Accuracy delta",
            lower: -0.01,
            upper: 0.12,
            level: 0.95,
            source: "condition_summaries",
            summary: ""
          }
        ],
        notes: []
      }
    } as any;

    const context = experimentArtifactLoader({ bundle });
    expect(context.protocol_kind).toBe("lm_benchmark");
    expect(context.method.sample_size_notes.join(" ")).toContain("48 training examples");
    expect(context.method.sample_size_notes.join(" ")).toContain("6 evaluation examples");
    expect(methodCompletenessValidator(context).missing).not.toContain("#samples");
    expect(methodCompletenessValidator(context).missing).not.toContain("benchmark task names");
    expect(context.results.dispersion_notes.join(" ")).toContain("95% interval");
    expect(resultsRichnessValidator(context).missing).not.toContain("dispersion estimates");
  });

  it("uses result-analysis evaluation totals as sample evidence without treating accounting rows as accuracy facts", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition fixed-budget pilot";
    bundle.topic = "condition parameters interaction for a small language-model benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.experimentPlan = {
      selectedTitle: "Seeded condition comparison against a locked baseline",
      selectedSummary: "Compare two candidate families on Benchmark Task A and Benchmark Task B.",
      rawText: [
        "selected_design:",
        '  datasets: ["training subset", "Benchmark Task A", "Benchmark Task B"]',
        '  implementation_notes: ["Use a tokenized instruction-tuning pipeline with a fixed evaluation harness."]',
        '  evaluation_steps: ["Run three seeded evaluations for each condition family."]'
      ].join("\n")
    } as any;
    bundle.latestResults = {
      condition_summaries: [
        { label: "baseline_family", average_accuracy_mean: 0.46, accuracy_delta_vs_baseline_mean: 0 }
      ]
    } as any;
    bundle.resultAnalysis = {
      metrics: {
        accuracy_delta_vs_baseline: 0.02,
        best_condition: {
          average_accuracy: 0.48,
          correct_count: 96,
          total_count: 200,
          evaluation: {
            task_a: { accuracy: 0.5, correct_count: 50, total_count: 100, confidence_interval: { sample_size: 100 } },
            task_b: { accuracy: 0.46, correct_count: 46, total_count: 100, confidence_interval: { sample_size: 100 } }
          },
          confidence_interval: { sample_size: 200, correct_count: 96, total_count: 200 }
        },
        condition_results: [
          {
            label: "baseline_family",
            average_accuracy: 0.46,
            accuracy_delta_vs_baseline: 0,
            evaluation: {
              task_a: { accuracy: 0.5, correct_count: 50, total_count: 100 },
              task_b: { accuracy: 0.42, correct_count: 42, total_count: 100 }
            }
          },
          {
            label: "candidate_family_a",
            average_accuracy: 0.48,
            accuracy_delta_vs_baseline: 0.02,
            evaluation: {
              task_a: { accuracy: 0.5, correct_count: 50, total_count: 100 },
              task_b: { accuracy: 0.46, correct_count: 46, total_count: 100 }
            }
          }
        ]
      },
      metric_table: [
        { key: "accuracy_delta_vs_baseline", value: 0.02 },
        { key: "average_accuracy", value: 0.48 }
      ],
      primary_findings: ["The candidate family improves modestly over the locked baseline."],
      figure_specs: [
        {
          id: "condition_delta",
          title: "Condition-level accuracy deltas",
          path: "figures/condition_delta.svg",
          metric_keys: ["accuracy_delta_vs_baseline"],
          summary: "Condition deltas for a seeded comparison."
        }
      ],
      statistical_summary: {
        total_trials: 6,
        executed_trials: 6,
        confidence_intervals: [
          { metric_key: "accuracy_delta_vs_baseline", label: "Accuracy delta", lower: -0.01, upper: 0.05, level: 0.95 }
        ],
        notes: []
      }
    } as any;

    const context = experimentArtifactLoader({ bundle });
    expect(context.method.sample_size_notes.join(" ")).toContain("sample size=200");
    expect(methodCompletenessValidator(context).missing).not.toContain("#samples");
    expect(methodCompletenessValidator(context).missing).not.toContain("benchmark task names");
    expect(context.results.condition_summaries[0]?.benchmark_task_a_accuracy).toBe(0.5);
    expect(context.results.condition_summaries[0]?.benchmark_task_b_accuracy).toBe(0.42);

    const scientific = applyScientificWritingPolicy({ draft: makeTerseDraft(), bundle, profile: PAPER_PROFILE });
    const manuscript = materializeScientificManuscript({
      candidate: {
        title: "Compact Condition Pilot",
        abstract: "The candidate family improved average accuracy from 0.46 to 0.48.",
        keywords: ["condition comparison"],
        sections: [
          { heading: "Introduction", paragraphs: ["We test a compact condition comparison."] },
          { heading: "Method", paragraphs: ["The evaluation uses Benchmark Task A and Benchmark Task B."] },
          { heading: "Results", paragraphs: ["Average accuracy rose from 0.46 to 0.48, a baseline-relative gain of 0.02."] },
          { heading: "Conclusion", paragraphs: ["The gain is a follow-up candidate rather than a broad rule."] }
        ],
        tables: [
          {
            caption: "Accuracy signal and evaluation coverage.",
            rows: [
              { label: "Screening threshold", value: 0.01 },
              { label: "Best-condition accuracy", value: 0.48 },
              { label: "Best-condition correct predictions", value: 96 },
              { label: "Best-condition total predictions", value: 200 }
            ]
          }
        ],
        figures: [
          {
            caption: "Mixed outcome and coverage summary.",
            bars: [
              { label: "Accuracy delta vs baseline", value: 0.02 },
              { label: "Best condition accuracy", value: 0.48 },
              { label: "Best condition sample size", value: 200 }
            ]
          }
        ]
      },
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const messages = manuscript.consistency_lint.issues.map((issue) => issue.message).join("\n");
    expect(messages).not.toMatch(/correct predictions|total predictions|sample size/i);
    expect(manuscript.consistency_lint.issues.some((issue) => issue.kind === "numeric_inconsistency" && issue.severity === "error")).toBe(false);
  });

  it("keeps the locked comparison marker separate from the registered baseline in artifact context", () => {
    const bundle = makeRichBundle();
    bundle.latestResults = {} as any;
    bundle.resultAnalysis = {
      metrics: {
        baseline_condition_marker: "comparison_row_marker",
        condition_results: [
          {
            condition_marker: "comparison_row_marker",
            condition_parameter_x: 2,
            condition_parameter_y: 0,
            average_accuracy: 0.45,
            accuracy_delta_vs_baseline: 0
          },
          {
            condition_marker: "registered_row_marker",
            condition_parameter_x: 4,
            condition_parameter_y: 0,
            average_accuracy: 0.45,
            accuracy_delta_vs_baseline: 0
          },
          {
            condition_marker: "candidate_row_marker",
            condition_parameter_x: 6,
            condition_parameter_y: 0.1,
            average_accuracy: 0.47,
            accuracy_delta_vs_baseline: 0.02
          }
        ],
        plan_context: {
          selected_design: {
            baselines: ["Primary trained baseline: factor x=4/factor y=0.0 with matched training budget."]
          }
        }
      }
    } as any;

    const context = experimentArtifactLoader({ bundle });
    const comparison = context.results.condition_summaries.find((row) => row.condition === "comparison_row_marker");
    const registered = context.results.condition_summaries.find((row) => row.condition === "registered_row_marker");

    expect(comparison).toMatchObject({ is_baseline: false, is_comparator: true });
    expect(registered).toMatchObject({ is_baseline: true, is_registered_baseline: true });
  });

  it("sanitizes provenance residue and promotes run-recorded method details", () => {
    const bundle = makeRichBundle();
    bundle.latestResults = {
      selected_model: "candidate_model",
      condition_summaries: [
        {
          condition_marker: "candidate_condition",
          seed_results: [
            {
              train_metadata: {
                model_name: "candidate_model",
                selected_target_modules: ["module_alpha", "module_beta"],
                num_train_samples: 64,
                train_dataset_token_count: 4096,
                trainer_state: {
                  learning_rate: 0.0003,
                  per_device_train_batch_size: 2,
                  gradient_accumulation_steps: 3,
                  optimizer_steps: 9
                }
              }
            }
          ]
        }
      ]
    } as any;

    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Bounded Condition Comparison",
      abstract: "A bounded comparison.",
      keywords: ["benchmark"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: [
            "Prior work (doi:10.1000/example) and [0123456789abcdef0123456789abcdef] motivate the comparison."
          ]
        },
        {
          heading: "Related Work",
          paragraphs: ["Prior evidence frames the comparison rather than serving as run evidence."]
        },
        {
          heading: "Method",
          paragraphs: [
            "The available summary does not disclose optimizer, batch size, learning rate, or target modules, so reproduction claims remain bounded."
          ]
        },
        {
          heading: "Results",
          paragraphs: [
            "Objective metric met: validation_score=0.72 >= 0.65.",
            "raw_precision=0.71 raw_recall=0.69."
          ]
        },
        {
          heading: "Discussion",
          paragraphs: ["The evidence remains under a bounded claim ceiling."]
        },
        {
          heading: "Conclusion",
          paragraphs: ["The candidate warrants follow-up."]
        }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });
    const allText = [
      result.manuscript.abstract,
      ...result.manuscript.sections.flatMap((section) => section.paragraphs)
    ].join(" ");
    const methodText =
      result.manuscript.sections.find((section) => section.heading === "Method")?.paragraphs.join(" ")
      || "";

    expect(allText).not.toMatch(/doi:|0123456789abcdef0123456789abcdef/i);
    expect(allText).not.toMatch(/Objective metric met|raw_precision|raw_recall/i);
    expect(allText).toContain("archived objective check cleared");
    expect(allText).toContain("bounded interpretation");
    expect(methodText).toContain("candidate_model");
    expect(methodText).toMatch(/learning rate 0\.0003/i);
    expect(methodText).toMatch(/does not disclose optimizer/i);
    expect(
      result.consistency_lint.issues.filter(
        (issue) => ["numeric_inconsistency", "numeric_unverifiable"].includes(issue.kind)
      )
    ).toHaveLength(0);
  });
  it("does not treat missing-setting prose as executed method detail coverage", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "bounded language-model condition comparison";
    bundle.topic = "condition effects under a fixed evaluation budget";
    bundle.objectiveMetric = "score_delta_vs_baseline >= 0.05";
    bundle.experimentPlan = {
      selectedTitle: "condition comparison under a fixed budget",
      selectedSummary: "Compare declared conditions on two evaluation tasks.",
      rawText: [
        "selected_design:",
        '  title: "condition comparison under a fixed budget"',
        "  implementation_notes:",
        '    - "Preferred model: candidate_model."',
        '    - "Hold data order and the evaluation harness constant."'
      ].join("\n")
    };
    bundle.latestResults = {};
    bundle.resultAnalysis = {
      metrics: {
        selected_model_id: "candidate_model",
        run_config: {
          learning_rate: 0.0003,
          per_device_batch_size: 2,
          gradient_accumulation_steps: 3,
          max_seq_length: 384,
          max_steps: 9,
          timeout_sec: 1200,
          train_samples: 64
        },
        data: {
          train: { count: 64 }
        }
      },
      metric_table: [{ key: "score_delta_vs_baseline", value: 0.075 }],
      condition_comparisons: [],
      primary_findings: [],
      limitations: [],
      statistical_summary: { confidence_intervals: [] }
    } as any;

    const context = experimentArtifactLoader({ bundle });
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "A Fixed-Budget Condition Comparison",
      abstract: "This paper reports a bounded comparison.",
      keywords: ["benchmark"],
      sections: [
        {
          heading: "Method",
          paragraphs: [
            "The available summary does not disclose the instantiated model, optimizer, batch size, learning rate, or prompt template."
          ]
        },
        {
          heading: "Results",
          paragraphs: ["The comparison remains bounded to the executed record."]
        },
        {
          heading: "Conclusion",
          paragraphs: ["The observed condition merits follow-up."]
        }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });
    const allText = result.manuscript.sections.flatMap((section) => section.paragraphs).join(" ");
    const methodText =
      result.manuscript.sections.find((section) => section.heading === "Method")?.paragraphs.join(" ")
      || "";

    expect(context.method.hyperparameter_notes.join(" ")).toMatch(/learning rate 0\.0003/i);
    expect(context.method.hyperparameter_notes.join(" ")).toMatch(/maximum sequence length 384/i);
    expect(context.method.sample_size_notes.join(" ")).toContain("64 training examples");
    expect(methodText).toContain("candidate_model");
    expect(methodText).toMatch(/per-device train batch size 2/i);
    expect(allText).toMatch(/does not disclose the instantiated model/i);
  });
  it("prefers the deterministic condition-level table and preserves condition figures for paper render audit", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition repeated-seed benchmark";
    bundle.topic = "condition parameters interaction for a small LLM benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          condition_parameter_x: 8,
          condition_parameter_y: 0,
          completed_seed_count: 5,
          average_accuracy_mean: 0.4417,
          accuracy_delta_vs_baseline_mean: 0,
          accuracy_delta_vs_baseline_ci95: 0
        },
        {
          condition_marker: "candidate_condition_d",
          condition_parameter_x: 16,
          condition_parameter_y: 0,
          completed_seed_count: 5,
          average_accuracy_mean: 0.4667,
          average_accuracy_ci95: 0.0586,
          accuracy_delta_vs_baseline_mean: 0.025,
          accuracy_delta_vs_baseline_ci95: 0.0841
        },
        {
          condition_marker: "candidate_condition_d5",
          condition_parameter_x: 16,
          condition_parameter_y: 0.05,
          completed_seed_count: 5,
          average_accuracy_mean: 0.4583,
          average_accuracy_ci95: 0.0542,
          accuracy_delta_vs_baseline_mean: 0.0167,
          accuracy_delta_vs_baseline_ci95: 0.051
        },
        {
          condition_marker: "candidate_condition_f",
          condition_parameter_x: 32,
          condition_parameter_y: 0,
          completed_seed_count: 5,
          average_accuracy_mean: 0.5125,
          accuracy_delta_vs_baseline_mean: 0.0708,
          accuracy_delta_vs_baseline_ci95: 0.071
        },
        {
          condition_marker: "candidate_condition_f5",
          condition_parameter_x: 32,
          condition_parameter_y: 0.05,
          completed_seed_count: 5,
          average_accuracy_mean: 0.5083,
          accuracy_delta_vs_baseline_mean: 0.0525,
          accuracy_delta_vs_baseline_ci95: 0.0638
        }
      ]
    };

    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated-Seed configuration ParameterY Benchmark",
      abstract: "A conservative repeated-seed benchmark.",
      keywords: ["configuration", "instruction tuning"],
      sections: scientific.draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
      })),
      tables: [
        {
          caption: "Key quantitative outcomes.",
          rows: [
            { label: "Conditions analyzed", value: 5 },
            { label: "Study delta", value: 0.0375 }
          ]
        }
      ],
      figures: [
        {
          caption: "Study summary bars.",
          bars: [
            { label: "Accuracy delta vs baseline", value: 0.0375 },
            { label: "Average accuracy", value: 0.4775 }
          ]
        }
      ]
    };
    candidate.sections = candidate.sections.map((section) =>
      section.heading === "Results"
        ? {
            ...section,
            paragraphs: [
              "Mean average accuracy rises from 0.4417 for the locked baseline at baseline condition to 0.4667 for One reported condition-level 95% interval, 0.4583 for One reported condition-level 95% interval5, 0.5125 for candidate condition e, and 0.5083 for candidate condition b.",
              "The absolute mean-accuracy intervals were similarly close for One reported condition-level 95% interval: [0.4081, 0.5253] without parameter_y and [0.4125, 0.5209] with condition parameter value.",
              "The protocol tracked runtime, training loss, and peak memory, and the full 25-run workload completed under the workstation budget with planned parallelism.",
              ...section.paragraphs
            ]
          }
        : section.heading === "Related Work"
          ? {
              ...section,
              paragraphs: [
                "Configuration-variant studies instead modify the configuration mechanism itself, so their gains speak more directly to alternative method-family parameterizations than to whether standard configuration at candidate conditions benefits from modest parameter_y in a local preflight.",
                "quantized method shows memory-efficient adaptation (quantized method, arXiv:2305.14314), while MAPLE compares broader method-family settings (MAPLE, arXiv:2403.14608).",
                ...section.paragraphs
              ]
            }
        : section
    );

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });
    const manuscript = result.manuscript;

    expect(manuscript.tables?.[0]?.caption).toMatch(/Condition-level mean accuracy/i);
    expect(manuscript.tables?.[0]?.rows).toHaveLength(5);
    expect(manuscript.tables?.[0]?.rows.map((row) => row.label).join(" ")).toMatch(/candidate condition [a-z]/);
    expect(manuscript.tables?.[0]?.rows.map((row) => row.label).join(" ")).toMatch(/n=5/);
    expect(manuscript.tables?.[0]?.rows.map((row) => row.label).join(" ")).not.toMatch(/delta/);
    expect(manuscript.tables?.[0]?.rows.map((row) => row.label).join(" ")).not.toMatch(/Conditions analyzed/);
    expect(manuscript.figures?.length ?? 0).toBeGreaterThan(0);
    expect(
      result.consistency_lint.issues.filter(
        (issue) =>
          issue.kind === "numeric_inconsistency"
          && issue.severity === "error"
          && (issue.involved_sections || []).some((section) => section.startsWith("Figure"))
      )
    ).toHaveLength(0);
    expect(
      result.consistency_lint.issues.filter(
        (issue) =>
          issue.kind === "numeric_inconsistency"
          && issue.severity === "error"
          && (issue.involved_sections || []).includes("Results")
          && /0\.4417|0\.4667|0\.4583|0\.5125|0\.5083/.test(issue.message)
      )
    ).toHaveLength(0);
    expect(
      result.consistency_lint.issues.some(
        (issue) =>
          (issue.normalized_facts || []).some(
            (fact) => fact.source === "results" && fact.value === 0.05 && fact.raw_text.includes("condition parameter value")
          )
      )
    ).toBe(false);
    expect(
      result.consistency_lint.issues.filter(
        (issue) =>
          issue.kind === "numeric_inconsistency"
          && issue.severity === "error"
          && /0\.4081|0\.5253|0\.4125|0\.5209/.test(issue.message)
      )
    ).toHaveLength(0);
    expect(
      result.consistency_lint.issues.filter(
        (issue) =>
          issue.kind === "numeric_inconsistency"
          && issue.severity === "error"
          && /peak memory mb/i.test(issue.message)
      )
    ).toHaveLength(0);
    expect(
      result.consistency_lint.issues.filter(
        (issue) =>
          /peak memory mb/i.test(issue.message)
          && /2305\.143|2403\.146/i.test(JSON.stringify(issue.normalized_facts || []))
      )
    ).toHaveLength(0);
    expect(
      result.consistency_lint.issues.filter(
        (issue) =>
          issue.kind === "numeric_inconsistency"
          && issue.severity === "error"
          && /0\.04479|0\.0667/.test(issue.message)
      )
    ).toHaveLength(0);
  });

  it("recovers condition-level configuration rows from live metrics conditions schema", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition live validation";
    bundle.topic = "condition parameters under a fixed-budget instruction tuning sweep";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      summary: {
        baseline_condition_marker: "baseline_condition",
        completed_condition_count: 8,
        best_condition_marker: "candidate_condition_f5",
        best_average_accuracy: 0.425,
        best_accuracy_delta_vs_baseline: 0.075
      },
      conditions: [
        {
          marker: "baseline_condition",
          condition_parameter_x: 8,
          parameter_y: 0,
          status: "ok",
          train_loss: 1.46211,
          benchmark_task_a_accuracy: 0.5,
          benchmark_task_b_accuracy: 0.166667,
          average_accuracy: 0.35,
          runtime_sec: 5.276,
          peak_cuda_memory_bytes: 2127520768,
          accuracy_delta_vs_baseline: 0
        },
        {
          marker: "candidate_condition_a",
          condition_parameter_x: 4,
          parameter_y: 0,
          status: "ok",
          benchmark_task_a_accuracy: 0.5,
          benchmark_task_b_accuracy: 0.166667,
          average_accuracy: 0.35,
          accuracy_delta_vs_baseline: 0
        },
        {
          marker: "candidate_condition_a5",
          condition_parameter_x: 4,
          parameter_y: 0.05,
          status: "ok",
          benchmark_task_a_accuracy: 0.5,
          benchmark_task_b_accuracy: 0.166667,
          average_accuracy: 0.35,
          accuracy_delta_vs_baseline: 0
        },
        {
          marker: "baseline_condition5",
          condition_parameter_x: 8,
          parameter_y: 0.05,
          status: "ok",
          benchmark_task_a_accuracy: 0.5,
          benchmark_task_b_accuracy: 0.166667,
          average_accuracy: 0.35,
          accuracy_delta_vs_baseline: 0
        },
        {
          marker: "candidate_condition_d",
          condition_parameter_x: 16,
          parameter_y: 0,
          status: "ok",
          benchmark_task_a_accuracy: 0.5,
          benchmark_task_b_accuracy: 0.166667,
          average_accuracy: 0.35,
          accuracy_delta_vs_baseline: 0
        },
        {
          marker: "candidate_condition_d5",
          condition_parameter_x: 16,
          parameter_y: 0.05,
          status: "ok",
          benchmark_task_a_accuracy: 0.5,
          benchmark_task_b_accuracy: 0.166667,
          average_accuracy: 0.35,
          accuracy_delta_vs_baseline: 0
        },
        {
          marker: "candidate_condition_f",
          condition_parameter_x: 32,
          parameter_y: 0,
          status: "ok",
          benchmark_task_a_accuracy: 0.5,
          benchmark_task_b_accuracy: 0.166667,
          average_accuracy: 0.35,
          accuracy_delta_vs_baseline: 0
        },
        {
          marker: "candidate_condition_f5",
          condition_parameter_x: 32,
          parameter_y: 0.05,
          status: "ok",
          benchmark_task_a_accuracy: 0.5,
          benchmark_task_b_accuracy: 0.35,
          average_accuracy: 0.425,
          accuracy_delta_vs_baseline: 0.075
        }
      ]
    };
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition Parameters under Fixed Budget",
      abstract: "A conservative fixed-budget condition-parameter sweep.",
      keywords: ["configuration", "instruction tuning"],
      sections: scientific.draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
      })),
      tables: [
        {
          caption: "Fallback authored summary.",
          rows: [{ label: "Completed Conditions In Sweep", value: 8 }]
        }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(result.manuscript.tables?.[0]?.caption).toMatch(/Condition-level mean accuracy/i);
    expect(result.manuscript.tables?.[0]?.rows).toHaveLength(8);
    const rowLabels = result.manuscript.tables?.[0]?.rows.map((row) => row.label).join(" ") || "";
    expect(rowLabels).toMatch(/locked comparison row/i);
    expect(rowLabels).toMatch(/candidate condition [a-z]/i);
    expect(rowLabels).not.toMatch(/Benchmark Task A 0\.5/i);
    expect(rowLabels).not.toMatch(/Benchmark Task B 0\.3333/i);
    expect((rowLabels.match(/comparison row/g) || [])).toHaveLength(1);
    expect(result.manuscript.tables?.[0]?.rows.map((row) => row.value)).toContain(0.425);
    expect(result.manuscript.figures?.[0]?.caption).toMatch(/Condition-level average accuracy/i);
    const figureLabels = result.manuscript.figures?.[0]?.bars.map((row) => row.label).join(" ") || "";
    expect(figureLabels).toMatch(/locked comparison row/i);
    expect(figureLabels).toMatch(/candidate condition [a-z]/i);
    expect(result.manuscript.figures?.[0]?.bars).toHaveLength(8);
    expect(result.manuscript.figures?.[0]?.bars.map((row) => row.value)).toContain(0.425);
  });

  it("does not compare baseline and best-cell accuracies as contradictory table facts", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition live validation";
    bundle.topic = "condition parameters under a fixed-budget instruction tuning sweep";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      summary: {
        baseline_condition_marker: "baseline_condition",
        completed_condition_count: 2,
        best_condition_marker: "candidate_condition_f5",
        best_average_accuracy: 0.425,
        best_accuracy_delta_vs_baseline: 0.075
      },
      conditions: [
        {
          marker: "baseline_condition",
          condition_parameter_x: 8,
          parameter_y: 0,
          status: "ok",
          average_accuracy: 0.35,
          accuracy_delta_vs_baseline: 0
        },
        {
          marker: "candidate_condition_f5",
          condition_parameter_x: 32,
          parameter_y: 0.05,
          status: "ok",
          average_accuracy: 0.425,
          accuracy_delta_vs_baseline: 0.075
        }
      ]
    };
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition Parameters under Fixed Budget",
      abstract: "A conservative fixed-budget condition-parameter sweep.",
      keywords: ["configuration", "instruction tuning"],
      sections: scientific.draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs:
          section.heading === "Conclusion"
            ? [
                "In the main run, candidate condition b achieved the best observed average accuracy, improving from 0.35 to 0.425 over the locked baseline."
              ]
            : section.paragraphs.map((paragraph) => paragraph.text)
      }))
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(
      result.consistency_lint.issues.filter(
        (issue) =>
          issue.kind === "numeric_inconsistency"
          && issue.severity === "error"
          && (issue.involved_sections || []).includes("Conclusion")
          && (issue.involved_sections || []).some((section) => /Table/i.test(section))
      )
    ).toHaveLength(0);
  });

  it("keeps configuration auxiliary metrics and CI bounds under their own numeric keys", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition live validation";
    bundle.topic = "condition parameters under a fixed-budget instruction tuning sweep";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      summary: {
        baseline_condition_marker: "baseline_condition",
        completed_condition_count: 2,
        best_condition_marker: "candidate_condition_f5",
        best_average_accuracy: 0.425,
        best_accuracy_delta_vs_baseline: 0.075
      },
      conditions: [
        {
          marker: "baseline_condition",
          condition_parameter_x: 8,
          parameter_y: 0,
          status: "ok",
          average_accuracy: 0.35,
          train_loss: 1.462,
          runtime_sec: 31.25,
          peak_cuda_memory_bytes: 2684354560,
          accuracy_delta_vs_baseline: 0
        },
        {
          marker: "candidate_condition_f5",
          condition_parameter_x: 32,
          parameter_y: 0.05,
          status: "ok",
          average_accuracy: 0.425,
          train_loss: 1.524,
          runtime_sec: 31.25,
          peak_cuda_memory_bytes: 2684354560,
          accuracy_delta_vs_baseline: 0.075
        }
      ]
    };
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      dataset_summaries: [],
      metric_table: [
        { key: "device.cuda_max_memory_allocated_bytes", value: 2684354560 },
        { key: "wall_clock_runtime_sec", value: 31.25 },
        { key: "run_config.timeout_sec", value: 1800 },
        { key: "run_config.max_seq_length", value: 256 }
      ]
    };
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition Parameters under Fixed Budget",
      abstract:
        "The best observed cell improved mean accuracy from 0.35 to 0.425, an absolute gain of 7.5 percentage points. Training loss changed from 1.462 to 1.524, with 31.25 s wall-clock time and about 2.5 GB peak CUDA memory.",
      keywords: ["configuration", "instruction tuning"],
      sections: scientific.draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs:
          section.heading === "Results"
            ? [
                "The best observed cell improved mean accuracy from 0.35 to 0.425, with training loss 1.524 versus 1.462 for the baseline and a cost profile of 31.25 s wall-clock time and about 2.5 GB peak CUDA memory.",
                "Average accuracy rises from 0.35 to 0.425, an absolute gain of 0.075, which is equivalent to 7.5 percentage points.",
                "For the leading observed condition, mean accuracy was 0.425 versus 0.35 for the locked baseline, a gain of 0.075.",
                "Read directly, it shows that seven conditions clustered at 0.35 mean accuracy and that only candidate condition b exceeded the baseline, reaching 0.425.",
                "The comparison-condition rows are useful mainly as a calibration point, while the leading-condition rows carry the strongest follow-up signal.",
                "The primary sweep completed all eight planned conditions in 31.25 seconds of wall-clock runtime, with a peak CUDA allocation of 2,684,354,560 bytes, or roughly 2.5 GB."
              ]
            : section.heading === "Method"
              ? [
                  ...section.paragraphs.map((paragraph) => paragraph.text),
                  "The executed metadata specify a maximum sequence length of 256 tokens, 4 optimizer steps, and an 1800-second timeout budget."
                ]
            : section.heading === "Discussion"
              ? [
                  ...section.paragraphs.map((paragraph) => paragraph.text),
                  "The leading condition cell improved accuracy delta versus the locked baseline by 0.075 in the reported comparison."
                ]
            : section.heading === "Conclusion"
              ? [
                  ...section.paragraphs.map((paragraph) => paragraph.text),
                  "In the main verified run, candidate condition b outperformed the locked baseline by 0.075 mean accuracy, with the improvement driven entirely by Benchmark Task B and not accompanied by lower training loss."
                ]
            : section.paragraphs.map((paragraph) => paragraph.text)
      })),
      tables: [
        {
          caption: "Condition-level mean accuracy across the executed condition-parameter grid; labels identify the locked baseline row.",
          rows: [
            { label: "baseline condition", value: 0.35 },
            { label: "candidate condition A", value: 0.35 },
            { label: "candidate condition d", value: 0.35 },
            { label: "candidate condition f", value: 0.35 },
            { label: "candidate condition B", value: 0.35 },
            { label: "One reported condition-level 95% interval", value: 0.35 },
            { label: "candidate condition e", value: 0.35 },
            { label: "candidate condition b", value: 0.425 }
          ]
        }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const problematicErrors = result.consistency_lint.issues
      .filter(
        (issue) =>
          issue.kind === "numeric_inconsistency"
          && issue.severity === "error"
          && /train loss|training loss|runtime seconds|peak memory mb|accuracy_delta_vs_baseline|lower 95|upper 95/i.test(issue.message)
      )
      .map((issue) => issue.message);
    expect(problematicErrors).toEqual([]);
    const problematicMessages = result.consistency_lint.issues
      .filter(
        (issue) =>
          ["numeric_inconsistency", "numeric_unverifiable", "count_unverifiable"].includes(issue.kind)
          && /train loss|training loss|45\.687|4\.28|2684354560|0\.3333|0\.4167|0\.0833|comparison condition|leading condition|16 as a samples|32 as a samples|256|1800|peak memory mb|conflicting aggregate accuracy/i.test(issue.message)
      )
      .map((issue) => issue.message);
    expect(problematicMessages).toEqual([]);
  });

  it("recovers configured condition rows from result analysis metrics when latest results are absent", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition live validation";
    bundle.topic = "condition parameters under a fixed-budget instruction tuning sweep";
    delete bundle.latestResults;
    bundle.resultAnalysis = {
      metrics: {
        selected_model_id: "the selected backbone",
        run_config: {
          learning_rate: 0.0002,
          per_device_batch_size: 1,
          gradient_accumulation_steps: 4,
          max_seq_length: 256,
          max_steps: 4,
          timeout_sec: 1800
        },
        data: {
          train: {
            count: 48
          }
        },
        summary: {
          baseline_condition_marker: "baseline_condition"
        },
        conditions: [
          {
            marker: "baseline_condition",
            condition_parameter_x: 8,
            parameter_y: 0,
            benchmark_task_a_accuracy: 0.5,
            benchmark_task_b_accuracy: 0.166667,
            average_accuracy: 0.35,
            accuracy_delta_vs_baseline: 0
          },
          {
            marker: "candidate_condition_f5",
            condition_parameter_x: 32,
            parameter_y: 0.05,
            benchmark_task_a_accuracy: 0.5,
            benchmark_task_b_accuracy: 0.35,
            average_accuracy: 0.425,
            accuracy_delta_vs_baseline: 0.075
          }
        ]
      }
    } as any;

    const context = experimentArtifactLoader({ bundle });
    expect(context.method.model_names).toContain("the selected backbone");
    expect(context.method.hyperparameter_notes.join(" ")).toMatch(/learning rate 0\.0002/i);
    expect(context.method.hyperparameter_notes.join(" ")).toMatch(/maximum sequence length 256/i);
    expect(context.method.hyperparameter_notes.join(" ")).toMatch(/1,?800-second timeout/i);

    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition Parameters under Fixed Budget",
      abstract: "A conservative fixed-budget condition-parameter sweep.",
      keywords: ["configuration", "instruction tuning"],
      sections: scientific.draft.sections.map((section) =>
        section.heading === "Discussion"
          ? {
              heading: section.heading,
              paragraphs: [
                "The practical implication is incremental rather than prescriptive. Parameter x 32 with condition parameter value is a reasonable follow-up candidate because it produced the best observed average accuracy, but the present record does not justify treating it as a settled default.",
                "The current evidence is most actionable as a cautious benchmark note for this fixed-budget condition-parameter pilot, especially where the best observed cell clears the pre-specified screening threshold.",
                "For this bounded pilot, the most defensible use of the result is triage: it nominates a condition worth retesting under broader data or tasks, but it does not establish a general method rule.",
                "The claim ceiling is therefore central to the interpretation. Completion of the run, a positive mean difference, and a usable table jointly support a candidate-selection claim, while stronger statements about robustness, mechanism, or broad transfer remain outside the available evidence."
              ]
            }
          : {
              heading: section.heading,
              paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
            }
      ),
      tables: [
        {
          caption: "Fallback authored summary.",
          rows: [{ label: "Reported Accuracy Delta Vs Baseline", value: 0.075 }]
        }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(result.manuscript.tables?.[0]?.caption).toMatch(/Condition-level mean accuracy/i);
    const rowLabels = result.manuscript.tables?.[0]?.rows.map((row) => row.label).join(" ") || "";
    expect(rowLabels).not.toMatch(/Benchmark Task A 0\.5/i);
    expect(rowLabels).not.toMatch(/Benchmark Task B 0\.3333/i);
    expect((rowLabels.match(/comparison row/g) || [])).toHaveLength(1);
    const discussion = result.manuscript.sections.find((section) => section.heading === "Discussion");
    const discussionText = discussion?.paragraphs.join(" ") || "";
    expect(discussionText).toMatch(/The current evidence is most actionable as a cautious benchmark note/i);
    expect(discussionText).toMatch(/For this bounded pilot/i);
    expect(discussionText).not.toMatch(/The claim ceiling is therefore central/i);
  });

  it("does not parse comma-separated seed-resampling counts as manuscript repeat counts", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Tabular Benchmark",
      abstract: "A short abstract.",
      keywords: ["tabular"],
      sections: scientific.draft.sections.map((section) =>
        section.heading === "Method"
          ? {
              heading: section.heading,
              paragraphs: [
                "We evaluate 2 datasets with outer 5-fold CV and inner 3-fold tuning.",
                "Uncertainty is summarized with bootstrap intervals over 10,000 seed resamples."
              ]
            }
          : {
              heading: section.heading,
              paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
            }
      )
    };

    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(
      manuscript.consistency_lint.issues.some(
        (issue) =>
          issue.kind === "count_inconsistency"
          && (issue.normalized_facts || []).some(
            (fact) => fact.raw_text === "000 seed" || fact.raw_text === "10,000 seed" || fact.value === 0 || fact.value === 10000
          )
      )
    ).toBe(false);
  });

  it("does not flag equivalent numeric formatting as a contradiction", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const baseSections = scientific.draft.sections.map((section) => ({
      heading: section.heading,
      paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
    }));
    const candidate: PaperManuscript = {
      title: "Repeated Tabular Benchmark",
      abstract: "A short abstract.",
      keywords: ["tabular"],
      sections: baseSections.map((section) =>
        section.heading === "Results"
          ? {
              ...section,
              paragraphs: ["The observed macro-F1 delta vs logistic regression is 0.0260 across 2 datasets."]
            }
          : section
      )
    };

    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(manuscript.consistency_lint.issues.some((issue) => issue.kind === "numeric_inconsistency")).toBe(false);
    expect(manuscript.consistency_lint.issues.some((issue) => issue.kind === "numeric_unverifiable")).toBe(false);
  });

  it("does not treat objective threshold text as a measured result fact", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Tabular Benchmark",
      abstract: "The writing objective remains macro_f1_delta_vs_logreg >= 0.02.",
      keywords: ["tabular"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: ["The paper positions itself around macro_f1_delta_vs_logreg >= 0.02 while keeping claims cautious."]
        },
        {
          heading: "Method",
          paragraphs: [
            "We evaluate 2 datasets with outer 5-fold CV and inner 3-fold tuning.",
            "A separate no-signal rule was specified for cases in which the maximum condition spread stayed below 0.005 absolute accuracy or the available uncertainty evidence was inconclusive."
          ]
        },
        {
          heading: "Results",
          paragraphs: ["The observed macro-F1 delta vs logistic regression is 0.026 across 2 datasets."]
        },
        {
          heading: "Conclusion",
          paragraphs: ["The empirical claim remains narrow."]
        }
      ]
    };

    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(
      manuscript.consistency_lint.issues.some(
        (issue) =>
          ["numeric_inconsistency", "numeric_unverifiable"].includes(issue.kind)
          && (issue.involved_sections || []).some((section) => ["Abstract", "Introduction"].includes(section))
      )
    ).toBe(false);
  });

  it("does not treat seed and grid design values as measured metric facts", () => {
    const bundle = makeRichBundle();
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        ...(((bundle.resultAnalysis as any).metric_table || []) as Array<{ key: string; value: number }>),
        { key: "wall_clock_runtime_sec", value: 31.25 },
        { key: "peak_memory_mb_mean", value: 4280 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Parameterized Design Audit",
      abstract:
        "The protocol crossed parameter x values 4, 8, 16, and 32 with parameter y values 0.0 and 0.05; the full 4 x 2 sweep completed in 31.3 s.",
      keywords: ["parameterized method"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: ["This manuscript keeps design settings separate from measured outcomes."]
        },
        {
          heading: "Method",
          paragraphs: [
            "The primary factorial plan specified seed 42 and compared condition parameters settings under a fixed budget."
          ]
        },
        {
          heading: "Results",
          paragraphs: ["The wall-clock runtime was 31.3 s and peak memory was about 4280 MB."]
        },
        {
          heading: "Limitations",
          paragraphs: [
            "The design specification names a seed-42 run, whereas the runtime summary reports seed 17; this is provenance context rather than a measured runtime value."
          ]
        },
        {
          heading: "Conclusion",
          paragraphs: ["The empirical claim remains narrow."]
        }
      ]
    };

    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(
      manuscript.consistency_lint.issues.filter(
        (issue) =>
          issue.kind === "numeric_inconsistency"
          && (issue.normalized_facts || []).some(
            (fact) =>
              fact.metric_key === "runtime_seconds"
              && [4, 8, 16, 32, 42, 17].includes(fact.value)
              && /parameter x|parameter_y|seed/i.test(fact.raw_text)
          )
      )
    ).toHaveLength(0);
    expect(
      manuscript.consistency_lint.issues.filter(
        (issue) =>
          issue.kind === "numeric_inconsistency"
          && (issue.normalized_facts || []).some(
            (fact) =>
              fact.metric_key === "accuracy"
              && [0, 0.05, 4, 8, 16, 32].includes(fact.value)
              && /parameter x|parameter_y|grid|sweep/i.test(fact.raw_text)
          )
      )
    ).toHaveLength(0);
    expect(
      manuscript.consistency_lint.issues.filter(
        (issue) =>
          issue.kind === "count_unverifiable"
          && /cites 42 as a runs/iu.test(issue.message)
      )
    ).toHaveLength(0);
  });

  it("maps mixed delta metrics to their own keys instead of attributing all values to accuracy", () => {
    const bundle = makeRichBundle();
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "accuracy_delta", value: 0.07 },
        { key: "f1_delta", value: 0.09 },
        { key: "reproducibility_delta", value: 0.16 }
      ]
    } as any;

    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Tabular Benchmark",
      abstract: "A short abstract.",
      keywords: ["tabular"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: ["This benchmark studies repeated tabular evaluation."]
        },
        {
          heading: "Method",
          paragraphs: ["We evaluate repeated treatment and baseline runs with the reported metrics."]
        },
        {
          heading: "Results",
          paragraphs: ["Shared state vs free form: accuracy_delta=0.07, f1_delta=0.09, reproducibility_delta=0.16."]
        },
        {
          heading: "Conclusion",
          paragraphs: ["The aggregate result remains modest."]
        }
      ]
    };

    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(manuscript.consistency_lint.issues.some((issue) => issue.kind === "numeric_inconsistency")).toBe(false);
  });

  it("distinguishes aggregate metrics from per-dataset values when checking numeric consistency", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Tabular Benchmark",
      abstract: "Average across datasets, the macro-F1 delta vs logistic regression is 0.012.",
      keywords: ["tabular"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: ["This benchmark studies repeated tabular evaluation."]
        },
        {
          heading: "Method",
          paragraphs: ["We evaluate 2 datasets with outer 5-fold CV and inner 3-fold tuning."]
        },
        {
          heading: "Results",
          paragraphs: ["The observed macro-F1 delta vs logistic regression is 0.026 across 2 datasets."]
        },
        {
          heading: "Conclusion",
          paragraphs: ["The aggregate result remains modest."]
        }
      ]
    };

    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const numericIssue = manuscript.consistency_lint.issues.find((issue) => issue.kind === "numeric_inconsistency");
    expect(numericIssue).toBeTruthy();
    expect(numericIssue?.involved_sections).toContain("Abstract");
    expect(numericIssue?.reason).toMatch(/structured numeric facts disagree|main-manuscript sections|scope\/key mismatch|metric-key mismatch/i);
  });

  it("rewrites over-strong performance claims when statistical support is missing", () => {
    const bundle = makeRichBundle();
    bundle.latestResults = {
      protocol: {
        datasets: ["breast_cancer"],
        models: ["logreg", "extra_trees"]
      },
      dataset_summaries: []
    };
    (bundle.resultAnalysis as any).statistical_summary.confidence_intervals = [];
    (bundle.resultAnalysis as any).statistical_summary.notes = [];

    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });

    expect(scientific.claim_rewrite_report.rewrites.length).toBeGreaterThan(0);
    expect(scientific.draft.claims[0]?.statement).toMatch(/positive delta|suggests/i);
  });

  it("fills an evidence-rich terse draft to the six-page strict-paper floor without LLM repair", () => {
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle: makeRichBundle(),
      profile: {
        ...PAPER_PROFILE,
        target_main_pages: 6,
        minimum_main_pages: 6,
        main_page_limit: 6
      }
    });
    const validation = buildScientificValidationArtifact(scientific);

    expect(scientific.page_budget.status).toBe("ok");
    expect(scientific.page_budget.estimated_main_words).toBeGreaterThanOrEqual(
      scientific.page_budget.minimum_main_words
    );
    expect(validation.issues.some((issue) => issue.code === "page_budget_warning")).toBe(false);
  });

  it("treats richness/page-budget issues as warn by default and fail in strict-paper mode", () => {
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle: makeRichBundle(),
      profile: PAPER_PROFILE
    });
    const scientificValidation = buildScientificValidationArtifact(scientific);
    const candidate: PaperManuscript = {
      title: "Repeated Tabular Benchmark",
      abstract: "A short abstract.",
      keywords: ["tabular"],
      sections: scientific.draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
      }))
    };
    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle: makeRichBundle(),
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const defaultDecision = buildWritePaperGateDecision({
      mode: "default",
      scientificValidation,
      consistencyLint: manuscript.consistency_lint,
      appendixLint: manuscript.appendix_lint
    });
    const strictDecision = buildWritePaperGateDecision({
      mode: "strict_paper",
      scientificValidation,
      consistencyLint: manuscript.consistency_lint,
      appendixLint: manuscript.appendix_lint
    });

    expect(defaultDecision.status).toBe("warn");
    expect(strictDecision.status).toBe("fail");
    expect(strictDecision.failure_reasons.some((message) => /target budget|too thin|incomplete/i.test(message))).toBe(true);
    expect(defaultDecision.evidence_summary.blocked_by_evidence_insufficiency).toBe(false);
    expect(defaultDecision.evidence_summary.expandable_from_existing_evidence).toBe(true);
    expect(defaultDecision.classification_summary.repairable_count).toBeGreaterThan(0);
    expect(scientificValidation.evidence_diagnostics.thin_sections.length).toBeGreaterThan(0);
  });

  it("flags numeric contradictions between abstract/conclusion and structured results", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Tabular Benchmark",
      abstract: "We improve macro-F1 by 0.2 across 8 datasets.",
      keywords: ["tabular"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: ["This benchmark studies repeated tabular evaluation."]
        },
        {
          heading: "Method",
          paragraphs: ["We evaluate 2 datasets with outer 5-fold CV and inner 3-fold tuning."]
        },
        {
          heading: "Results",
          paragraphs: ["The observed macro-F1 delta is 0.026 on the strongest workflow across 2 datasets."]
        },
        {
          heading: "Conclusion",
          paragraphs: ["The study shows significant improvement across 8 datasets."]
        }
      ]
    };
    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(manuscript.consistency_lint.ok).toBe(false);
    expect(manuscript.consistency_lint.issues.some((issue) => issue.kind === "numeric_inconsistency")).toBe(true);
    expect(manuscript.consistency_lint.issues.some((issue) => issue.kind === "count_inconsistency")).toBe(true);
    expect(manuscript.consistency_lint.issues.some((issue) => issue.kind === "unsupported_strong_claim")).toBe(true);
    expect(
      manuscript.consistency_lint.issues.some(
        (issue) => issue.kind === "numeric_inconsistency" && (issue.involved_sections || []).includes("Abstract")
      )
    ).toBe(true);
  });

  it("sanitizes internal-token captions before consistency linting", () => {
    const bundle = makeRichBundle();
    bundle.latestResults = {} as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [],
      figure_specs: []
    };
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Tabular Benchmark",
      abstract: "A short abstract.",
      keywords: ["tabular"],
      sections: scientific.draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
      })),
      figures: [
        {
          caption: "Objective metric not met: metrics.tui_full_cycle_consistent_success_count=0 does not satisfy >= 1.",
          bars: [{ label: "breast_cancer", value: 0 }]
        }
      ]
    };
    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(manuscript.manuscript.figures?.[0]?.caption).toBe(
      "Dataset-level outcome summary with uncertainty-aware interpretation retained in the main paper."
    );
    expect(manuscript.consistency_lint.issues.some((issue) => issue.kind === "caption_internal_name")).toBe(false);
  });

  it("preserves authored main-paper visuals so manuscript-quality repair can inspect them later", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Tabular Benchmark",
      abstract: "A short abstract.",
      keywords: ["tabular"],
      sections: scientific.draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
      })),
      tables: [
        {
          caption: "Exact numeric comparison for revision stability.",
          rows: [
            { label: "Stateless baseline", value: 0.71 },
            { label: "Thread-backed drafting", value: 0.76 }
          ],
          source_refs: [{ kind: "artifact", id: AUTHORED_MAIN_TABLE_SOURCE_REF_ID }]
        }
      ],
      figures: [
        {
          caption: "A redundant authored figure that still needs manuscript-level review.",
          bars: [
            { label: "Stateless baseline", value: 0.71 },
            { label: "Thread-backed drafting", value: 0.76 }
          ],
          source_refs: [{ kind: "artifact", id: AUTHORED_MAIN_FIGURE_SOURCE_REF_ID }]
        }
      ]
    };
    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(manuscript.manuscript.tables?.[0]?.caption).toBe("Exact numeric comparison for revision stability.");
    expect(manuscript.manuscript.figures?.[0]?.caption).toBe(
      "A redundant authored figure that still needs manuscript-level review."
    );
    expect(manuscript.manuscript.figures?.length).toBe(1);
  });

  it("still prunes redundant unmarked figures that originate from automatic fallback visuals", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Tabular Benchmark",
      abstract: "A short abstract.",
      keywords: ["tabular"],
      sections: scientific.draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
      })),
      tables: [
        {
          caption: "Selected reported metrics from the structured results analysis.",
          rows: [
            { label: "Accuracy", value: 0.91 },
            { label: "Replication Success Rate", value: 0.94 },
            { label: "F1", value: 0.88 }
          ]
        }
      ],
      figures: [
        {
          caption: "Objective metric met: accuracy=0.91 >= 0.9.",
          bars: [
            { label: "Accuracy", value: 0.91 },
            { label: "Replication Success Rate", value: 0.94 },
            { label: "F1", value: 0.88 }
          ]
        }
      ]
    };
    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(manuscript.manuscript.tables?.length).toBe(1);
    expect(manuscript.manuscript.figures?.length || 0).toBe(0);
  });

  it("downgrades numeric_inconsistency to warning when values differ by >50% (likely metric-key mismatch)", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    // Manuscript quotes a Brier score value (0.08) while structured results only have macro_f1 (0.026).
    // With bad metric_key assignment, both get key "macro_f1_delta_vs_logreg" and get compared.
    // The >50% delta heuristic should downgrade from error to warning.
    const candidate: PaperManuscript = {
      title: "Repeated Tabular Benchmark",
      abstract: "The overall macro-F1 delta is 0.026.",
      keywords: ["tabular"],
      sections: [
        { heading: "Introduction", paragraphs: ["This benchmark studies repeated tabular evaluation."] },
        { heading: "Method", paragraphs: ["We evaluate 2 datasets with outer 5-fold CV and inner 3-fold tuning."] },
        {
          heading: "Results",
          paragraphs: [
            "The observed macro_f1_delta_vs_logreg is 0.026 on the strongest workflow.",
            "The Brier score macro_f1_delta_vs_logreg was 0.0008 for the calibrated model."
          ]
        },
        { heading: "Conclusion", paragraphs: ["The aggregate result remains modest."] }
      ]
    };
    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const inconsistencyIssues = manuscript.consistency_lint.issues.filter(
      (issue) => issue.kind === "numeric_inconsistency"
    );
    // The 0.0008 vs 0.026 comparison (>50% delta) should be warning, not error
    const errorIssues = inconsistencyIssues.filter((i) => i.severity === "error");
    const warningIssues = inconsistencyIssues.filter((i) => i.severity === "warning");
    // If any comparison triggers, the large-delta ones should be warnings
    if (inconsistencyIssues.length > 0) {
      const largeGapIssues = inconsistencyIssues.filter(
        (i) => i.message.includes("0.0008") || i.message.includes("0.026")
      );
      for (const issue of largeGapIssues) {
        // 0.0008 vs 0.026 differ by >50%, so should be downgraded
        if (issue.message.includes("0.0008")) {
          expect(issue.severity).toBe("warning");
        }
      }
    }
  });

  it("does not flag CI bounds reported consistently across sections as a contradiction", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    // Simulate the real false-positive scenario: Abstract and Results both
    // report the same mean and CI interval, but the drift checker was
    // treating the CI lower and upper bounds as two distinct "conflicting"
    // values for the same metric key.
    const candidate: PaperManuscript = {
      title: "Calibration Benchmark",
      abstract:
        "The best overall configuration achieves mean macro-F1 0.790455 " +
        "with a 95% confidence interval from 0.757351 to 0.819898.",
      keywords: ["calibration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study calibration effects on tabular classification."] },
        { heading: "Method", paragraphs: ["We evaluate 5 datasets with repeated nested 5x3 CV."] },
        {
          heading: "Results",
          paragraphs: [
            "The best aggregate configuration is sigmoid-calibrated RBF-SVM. " +
            "Its mean macro-F1 is 0.790455, and the benchmark summary reports " +
            "a 95% interval from 0.757351 to 0.819898 for that configuration."
          ]
        },
        { heading: "Conclusion", paragraphs: ["Calibration consistently improves ranking stability."] }
      ]
    };
    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    // CI bound values (0.757351, 0.819898) must NOT produce a blocking error
    // when the same interval appears identically in Abstract and Results.
    const blockingErrors = manuscript.consistency_lint.issues.filter(
      (issue) =>
        issue.kind === "numeric_inconsistency" &&
        issue.severity === "error" &&
        (issue.normalized_facts || []).some(
          (f) => f.unit === "ci_lower" || f.unit === "ci_upper"
        )
    );
    expect(blockingErrors).toHaveLength(0);
  });

  it("does not treat uncertainty summaries as conflicting accuracy-delta means", () => {
    const bundle = makeRichBundle();
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "accuracy_delta_vs_baseline", value: 0.0375 },
        { key: "best_nonbaseline_accuracy_delta_vs_baseline_mean", value: 0.0525 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract: "The study-level delta relative to baseline was +0.0375.",
      keywords: ["configuration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a repeated-seed condition-parameter comparison."] },
        { heading: "Method", paragraphs: ["We compare a locked locked baseline baseline with higher-parameter x cells."] },
        {
          heading: "Results",
          paragraphs: [
            "The strongest cell achieved a mean accuracy delta of +0.0525, or 5.25 percentage points. Its maximum observed seed-level delta was +0.1667 and its minimum was -0.0208, while the reported standard deviation was 0.0728 and the standard error was 0.0325."
          ]
        },
        { heading: "Conclusion", paragraphs: ["The result supports a narrow follow-up candidate."] }
      ]
    };
    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const blockingUncertaintyErrors = result.consistency_lint.issues.filter(
      (issue) =>
        issue.kind === "numeric_inconsistency"
        && issue.severity === "error"
        && /0\.0728|0\.0325/.test(JSON.stringify(issue.normalized_facts || []))
    );
    expect(blockingUncertaintyErrors).toHaveLength(0);
  });

  it("does not headline the study-level objective check as a conflicting condition delta", () => {
    const bundle = makeRichBundle();
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "accuracy_delta_vs_baseline", value: 0.0375 },
        { key: "best_nonbaseline_accuracy_delta_vs_baseline_mean", value: 0.0525 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract:
        "The study-level objective was met: the available summary reports accuracy_delta_vs_baseline = 0.0375. The strongest summarized condition was candidate condition b, with a mean delta of 0.0525.",
      keywords: ["configuration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a repeated-seed condition-parameter comparison."] },
        { heading: "Method", paragraphs: ["We compare a locked locked baseline baseline with higher-parameter x cells."] },
        {
          heading: "Results",
          paragraphs: [
            "At the study level, the primary metric was accuracy_delta_vs_baseline = 0.0375, which exceeded the predeclared target of 0.01.",
            "The strongest cell achieved a mean accuracy delta of +0.0525, or 5.25 percentage points."
          ]
        },
        { heading: "Conclusion", paragraphs: ["The result supports a narrow follow-up candidate."] }
      ]
    };
    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const blockingDeltaErrors = result.consistency_lint.issues.filter(
      (issue) =>
        issue.kind === "numeric_inconsistency"
        && issue.severity === "error"
        && /0\.0448|0\.0667/.test(JSON.stringify(issue.normalized_facts || []))
    );
    expect(blockingDeltaErrors).toHaveLength(0);
    expect(result.manuscript.abstract).not.toContain("accuracy_delta_vs_baseline = 0.0375");
  });

  it("keeps baseline and best-condition accuracy targets separate in compact abstract comparisons", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition preflight";
    bundle.topic = "condition parameters interaction for a small LLM benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          condition_parameter_x: 8,
          condition_parameter_y: 0,
          completed_seed_count: 1,
          average_accuracy_mean: 0.35,
          accuracy_delta_vs_baseline_mean: 0
        },
        {
          condition_marker: "candidate_condition_f5",
          condition_parameter_x: 32,
          condition_parameter_y: 0.05,
          completed_seed_count: 1,
          average_accuracy_mean: 0.425,
          accuracy_delta_vs_baseline_mean: 0.075
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "average_accuracy", value: 0.425 },
        { key: "accuracy_delta_vs_baseline", value: 0.075 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract:
        "Within this realized run, the best exposed condition, candidate condition b, raises mean accuracy from 0.35 to 0.425 relative to the baseline.",
      keywords: ["configuration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The locked baseline condition served as the comparison anchor. The compact setup table has 1 rows."] },
        {
          heading: "Results",
          paragraphs: [
            "The reported results identifies candidate condition b as the strongest observed condition, with average accuracy 0.425 compared with 0.35 for the locked baseline at baseline condition."
          ]
        },
        { heading: "Discussion", paragraphs: ["The comparison supports a narrow follow-up candidate."] },
        { heading: "Conclusion", paragraphs: ["The result remains a local preflight signal."] }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const targetErrors = result.consistency_lint.issues.filter(
      (issue) =>
        issue.kind === "numeric_inconsistency"
        && issue.severity === "error"
        && /accuracy_delta_vs_baseline|candidate_condition_f5/.test(JSON.stringify(issue.normalized_facts || []))
        && /0\.333334/.test(JSON.stringify(issue.normalized_facts || []))
    );
    expect(targetErrors).toHaveLength(0);
    expect(
      result.consistency_lint.issues.filter(
        (issue) => issue.kind === "numeric_inconsistency" && issue.severity === "error"
      )
    ).toHaveLength(0);
    expect(
      result.consistency_lint.issues.filter(
        (issue) =>
          issue.kind === "numeric_inconsistency"
          && /cites 0\.3333, but the comparable structured results support .*accuracy_delta_vs_baseline/iu.test(issue.message)
      )
    ).toHaveLength(0);
  });

  it("does not treat reference value in a paired reference-comparator accuracy sentence as a current accuracy contradiction", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "condition-parameter preflight";
    bundle.topic = "condition parameters interaction for a compact benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      condition_summaries: [
        {
          condition_marker: "reference_condition",
          label: "reference condition",
          is_baseline: true,
          average_accuracy_mean: 0.45
        },
        {
          condition_marker: "comparator_condition",
          label: "comparator condition",
          average_accuracy_mean: 0.475,
          accuracy_delta_vs_baseline_mean: 0.025
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "average_accuracy", value: 0.475 },
        { key: "accuracy_delta_vs_baseline", value: 0.025 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Reference Comparator Preflight",
      abstract: "A compact comparison reports a bounded result.",
      keywords: [],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The reference condition served as the comparison anchor."] },
        {
          heading: "Results",
          paragraphs: [
            "The available analysis reports a positive exported primary contrast. The reported reference average accuracy is 0.45 and the reported comparator average accuracy is 0.475."
          ]
        },
        { heading: "Discussion", paragraphs: ["The comparison supports a narrow follow-up candidate."] },
        { heading: "Conclusion", paragraphs: ["The result remains a local preflight signal."] }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(
      result.consistency_lint.issues.filter(
        (issue) => issue.kind === "numeric_inconsistency" && issue.severity === "error"
      )
    ).toHaveLength(0);
    expect(
      result.consistency_lint.issues.filter((issue) => /Results cites 0\.4583/iu.test(issue.message))
    ).toHaveLength(0);
    expect(JSON.stringify(result.manuscript)).toContain("reported reference average accuracy is 0.45");
    expect(JSON.stringify(result.manuscript)).toContain("reported comparator average accuracy is 0.475");
  });

  it("keeps anaphoric best-condition accuracy separate from a following baseline comparison", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition preflight";
    bundle.topic = "condition parameters interaction for a small LLM benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          condition_parameter_x: 8,
          condition_parameter_y: 0,
          completed_seed_count: 1,
          average_accuracy_mean: 0.35,
          accuracy_delta_vs_baseline_mean: 0
        },
        {
          condition_marker: "candidate_condition_f5",
          condition_parameter_x: 32,
          condition_parameter_y: 0.05,
          completed_seed_count: 1,
          average_accuracy_mean: 0.425,
          accuracy_delta_vs_baseline_mean: 0.075
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "average_accuracy", value: 0.425 },
        { key: "accuracy_delta_vs_baseline", value: 0.075 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract:
        "The best reported condition combines candidate condition b. Its average accuracy across Benchmark Task A and Benchmark Task B is 0.425, compared with 0.35 for the locked baseline at baseline condition.",
      keywords: ["configuration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The locked baseline condition served as the comparison anchor."] },
        {
          heading: "Results",
          paragraphs: [
            "Within that analyzed configuration, the best reported condition combines candidate condition b.",
            "Its average accuracy across Benchmark Task A and Benchmark Task B is 0.425, compared with 0.35 for the locked baseline at baseline condition."
          ]
        },
        { heading: "Discussion", paragraphs: ["The comparison supports a narrow follow-up candidate."] },
        { heading: "Conclusion", paragraphs: ["The result remains a local preflight signal."] }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const blockingErrors = result.consistency_lint.issues.filter(
      (issue) => issue.kind === "numeric_inconsistency" && issue.severity === "error"
    );
    expect(blockingErrors).toHaveLength(0);
  });

  it("keeps from-to accuracy values aligned with both named condition-parameter sides", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition preflight";
    bundle.topic = "condition parameters interaction for a small LLM benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          condition_parameter_x: 8,
          condition_parameter_y: 0,
          completed_seed_count: 1,
          average_accuracy_mean: 0.35,
          accuracy_delta_vs_baseline_mean: 0
        },
        {
          condition_marker: "candidate_condition_f5",
          condition_parameter_x: 32,
          condition_parameter_y: 0.05,
          completed_seed_count: 1,
          average_accuracy_mean: 0.425,
          accuracy_delta_vs_baseline_mean: 0.075
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "average_accuracy", value: 0.425 },
        { key: "accuracy_delta_vs_baseline", value: 0.075 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract:
        "The explicit comparison is candidate condition b versus baseline condition, with average accuracy rising from 0.35 to 0.425.",
      keywords: ["configuration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The locked baseline condition served as the comparison anchor."] },
        {
          heading: "Results",
          paragraphs: [
            "The explicit comparison reported in the summary is candidate condition b versus baseline condition, with average accuracy rising from 0.35 to 0.425."
          ]
        },
        { heading: "Discussion", paragraphs: ["The comparison supports a narrow follow-up candidate."] },
        { heading: "Conclusion", paragraphs: ["The result remains a local preflight signal."] }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const blockingErrors = result.consistency_lint.issues.filter(
      (issue) => issue.kind === "numeric_inconsistency" && issue.severity === "error"
    );
    expect(blockingErrors).toHaveLength(0);
  });

  it("does not treat baseline, comparator, and delta accuracy values as one contradiction", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "condition-parameter preflight";
    bundle.topic = "condition-parameter interaction under a fixed local budget";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          label: "baseline condition",
          is_baseline: true,
          completed_seed_count: 3,
          average_accuracy_mean: 0.45,
          accuracy_delta_vs_baseline_mean: 0
        },
        {
          condition_marker: "candidate_condition_a",
          label: "candidate condition a",
          is_baseline: false,
          completed_seed_count: 3,
          average_accuracy_mean: 0.475,
          accuracy_delta_vs_baseline_mean: 0.025
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "average_accuracy", value: 0.475 },
        { key: "accuracy_delta_vs_baseline", value: 0.025 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract:
        "The baseline-relative accuracy gain is 0.025, and average accuracy increases from 0.45 to 0.475 for candidate condition a versus baseline condition. The reported metric summary gives a baseline-relative average-accuracy gain of 0.025, increasing from 0.45 to 0.475.",
      keywords: ["condition sweep"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The locked baseline condition served as the comparison anchor."] },
        {
          heading: "Results",
          paragraphs: [
            "The results table reports baseline average accuracy 0.45 and candidate condition a average accuracy 0.475, with baseline-relative accuracy gain 0.025.",
            "The compact comparison is labelled as condition family a versus condition family b, with average accuracy 0.475 versus 0.45 (delta 0.025).",
            "For the displayed contrast, average accuracy is reported as 0.475 versus 0.45, with baseline-relative accuracy gain reported as 0.025 versus 0.",
            "For that contrast, the table reports baseline-relative accuracy gain of 0.025 versus 0, average accuracy of 0.475 versus 0.45, accuracy of 0.475 versus 0.45, and mean zero shot accuracy of 0.475 versus 0.45.",
            "The available summary reports that the objective metric crossed the numerical accuracy threshold: mean accuracy increased by 0.025, from 0.45 to 0.475.",
            "In particular, one summarized comparison reports task accuracy as 0.475 for both comparator and leading condition, implying no task-specific gain in that view.",
            "For that comparison, the reported mean accuracy values are 0.475 and 0.45, respectively, with a +0.025 difference.",
            "The exposed denominators are 144 examples per task, for 288 evaluated items in the combined summary, with 138 correct predictions reported across the combined candidate count.",
            "A separate named condition contrast identifies condition family c with parameter_y 0.0 as a promising zero-setting candidate relative to the locked condition family a parameter_y 0.0 delta-reference.",
            "The aggregate task accuracy for candidate condition a is 0.475."
          ]
        },
        { heading: "Discussion", paragraphs: ["The comparison supports a narrow follow-up candidate. It is not sufficient to justify claims about generalization to a 7B-class model or larger-memory regimes."] },
        { heading: "Conclusion", paragraphs: ["The result remains a local preflight signal."] }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const blockingErrors = result.consistency_lint.issues.filter(
      (issue) => issue.kind === "numeric_inconsistency" && issue.severity === "error"
    );
    expect(blockingErrors).toHaveLength(0);
    expect(JSON.stringify(result.consistency_lint.issues)).not.toMatch(/0\.020833.*0\.479167|0\.479167.*0\.020833/);
    expect(JSON.stringify(result.consistency_lint.issues)).not.toMatch(/accuracy_delta[^\n]+0\.479167|accuracy_delta[^\n]+0\.458333/);
    expect(JSON.stringify(result.consistency_lint.issues)).not.toMatch(/peak_memory_mb[^\n]+(?:288|138)|(?:288|138)[^\n]+peak_memory_mb/);
    expect(JSON.stringify(result.consistency_lint.issues)).not.toMatch(/cites 0, but the comparable structured results support 0\.0208/);
    expect(JSON.stringify(result.consistency_lint.issues)).not.toMatch(/1 rows|7B-class|larger-memory/);
  });

  it("does not treat a paired accuracy comparison plus a representative summary score as contradiction", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "condition-parameter preflight";
    bundle.topic = "condition-parameter interaction under a fixed local budget";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          label: "baseline condition",
          is_baseline: true,
          completed_seed_count: 3,
          average_accuracy_mean: 0.45,
          accuracy_delta_vs_baseline_mean: 0
        },
        {
          condition_marker: "candidate_condition_a",
          label: "candidate condition a",
          is_baseline: false,
          completed_seed_count: 3,
          average_accuracy_mean: 0.475,
          accuracy_delta_vs_baseline_mean: 0.025
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "average_accuracy", value: 0.475 },
        { key: "accuracy_delta_vs_baseline", value: 0.025 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract:
        "The compact preflight reports a baseline-relative accuracy gain of 0.025 under a narrow local budget.",
      keywords: ["condition sweep"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition comparison."] },
        { heading: "Method", paragraphs: ["The baseline condition served as the comparison field for a candidate condition."] },
        {
          heading: "Results",
          paragraphs: [
            "The corresponding average-accuracy values were 0.475 for the leading reported comparator and 0.45 for the baseline field, yielding an absolute gain of approximately 2.5 percentage points.",
            "In that row, average accuracy is 0.4792 for condition b and 0.4583 for condition a, a difference of about +2.5 percentage points.",
            "In that contrast, average accuracy is reported as 0.4792 versus 0.4583, with a difference of approximately +0.0208.",
            "The available summaries indicate broad confidence-interval information and do not provide a clean interval specifically for the +0.025 baseline-relative delta."
          ]
        },
        { heading: "Discussion", paragraphs: ["The comparison should remain a follow-up candidate rather than a broad tuning rule."] },
        {
          heading: "Conclusion",
          paragraphs: [
            "The aggregate objective calculation reported a baseline-relative average-accuracy gain of 0.025, exceeding the +0.01 screening threshold.",
            "The aggregate objective calculation reports a +0.025 accuracy delta over the baseline field, exceeding the +0.01 threshold, and the best-condition summary reports 0.475 average accuracy across benchmark_task_a and benchmark_task_b."
          ]
        }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const aggregateAccuracyErrors = result.consistency_lint.issues.filter(
      (issue) =>
        issue.kind === "numeric_inconsistency"
        && issue.severity === "error"
        && /aggregate accuracy values/i.test(issue.message)
    );
    expect(aggregateAccuracyErrors).toHaveLength(0);
    expect(JSON.stringify(result.consistency_lint.issues)).not.toMatch(/cites 0\.4583[^\n]+support 0\.4792/i);
  });

  it("does not compare related-work model-scale numbers against current-run memory", () => {
    const bundle = makeRichBundle();
    bundle.latestResults = {
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          label: "baseline condition",
          is_baseline: true,
          average_accuracy_mean: 0.45,
          accuracy_delta_vs_baseline_mean: 0,
          peak_memory_mb_mean: 4278.951936
        },
        {
          condition_marker: "candidate_condition_a",
          label: "candidate condition a",
          average_accuracy_mean: 0.475,
          accuracy_delta_vs_baseline_mean: 0.025,
          peak_memory_mb_mean: 4278.951936
        }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({ draft: makeTerseDraft(), bundle, profile: PAPER_PROFILE });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract: "The candidate improves average accuracy from 0.45 to 0.475.",
      keywords: [],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition comparison."] },
        {
          heading: "Related Work",
          paragraphs: [
            "Prior work notes that fine-tuning an external 175B model can reduce trainable parameters and GPU memory, but that model-scale number is not a current-run peak-memory measurement."
          ]
        },
        { heading: "Method", paragraphs: ["The run uses a locked baseline and one candidate family."] },
        {
          heading: "Results",
          paragraphs: ["Average accuracy is reported as 0.475 versus 0.45, with a gain of 0.025."]
        },
        { heading: "Discussion", paragraphs: ["The result is a local screening signal."] },
        { heading: "Limitations", paragraphs: ["Memory efficiency is not claimed from related-work model-scale numbers."] },
        { heading: "Conclusion", paragraphs: ["The candidate remains a follow-up option."] }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(result.consistency_lint.issues.map((issue) => issue.message).join("\n")).not.toMatch(
      /175.*peak memory|conflicting aggregate peak memory mb/i
    );
  });

  it("does not treat repeated from-to average accuracy statements as a contradiction", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "condition-parameter preflight";
    bundle.topic = "condition-parameter interaction under a fixed local budget";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          label: "baseline condition",
          is_baseline: true,
          completed_seed_count: 3,
          average_accuracy_mean: 0.45,
          accuracy_delta_vs_baseline_mean: 0
        },
        {
          condition_marker: "candidate_condition_a",
          label: "candidate condition a",
          is_baseline: false,
          completed_seed_count: 3,
          average_accuracy_mean: 0.475,
          accuracy_delta_vs_baseline_mean: 0.025
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "average_accuracy", value: 0.475 },
        { key: "accuracy_delta_vs_baseline", value: 0.025 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract: "A conservative condition-parameter preflight.",
      keywords: ["condition sweep"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The locked baseline condition served as the comparison anchor."] },
        {
          heading: "Results",
          paragraphs: [
            "On the primary accuracy metric, the summarized comparison reports an increase in average Benchmark Task A/Benchmark Task B accuracy from 0.45 to 0.475."
          ]
        },
        { heading: "Discussion", paragraphs: ["The comparison supports a narrow follow-up candidate."] },
        {
          heading: "Conclusion",
          paragraphs: [
            "The summarized results report an average Benchmark Task A/Benchmark Task B accuracy increase from 0.45 to 0.475, corresponding to a +0.025 screening point estimate."
          ]
        }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(
      result.consistency_lint.issues.some(
        (issue) => issue.kind === "numeric_inconsistency" && issue.severity === "error"
      )
    ).toBe(false);
  });

  it("does not compare recorded comparison accuracy against the leading condition accuracy", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "condition-parameter preflight";
    bundle.topic = "condition-parameter interaction under a fixed local budget";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          label: "baseline condition",
          is_baseline: true,
          completed_seed_count: 3,
          average_accuracy_mean: 0.45,
          accuracy_delta_vs_baseline_mean: 0
        },
        {
          condition_marker: "candidate_condition_a",
          label: "candidate condition a",
          is_baseline: false,
          completed_seed_count: 3,
          average_accuracy_mean: 0.475,
          accuracy_delta_vs_baseline_mean: 0.025
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "average_accuracy", value: 0.475 },
        { key: "accuracy_delta_vs_baseline", value: 0.025 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract:
        "The available record reports a leading displayed condition with average accuracy 0.475 compared with a recorded comparison value of 0.45, a difference of 0.025. The same summary reports 0.475 average accuracy for the leading recorded result and 0.45 for the recorded comparison, with a 0.025 gain.",
      keywords: ["condition sweep"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The archived comparison row served as the comparison anchor."] },
        {
          heading: "Results",
          paragraphs: [
            "Results cite 0.475 for the leading recorded result and 0.45 for the recorded comparison row.",
            "The available record lists a recorded comparison average accuracy of 0.45 and a leading displayed condition average accuracy of 0.475.",
            "Both rows display average accuracy 0.45 in the available table, so the point-estimate contrast is numerically aligned in this display.",
            "The baseline-relative accuracy gain remains 0.025."
          ]
        },
        { heading: "Discussion", paragraphs: ["The comparison supports a narrow follow-up candidate."] },
        { heading: "Conclusion", paragraphs: ["The result remains a local preflight signal."] }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const blockingErrors = result.consistency_lint.issues.filter(
      (issue) => issue.kind === "numeric_inconsistency" && issue.severity === "error"
    );
    expect(blockingErrors).toHaveLength(0);
    expect(JSON.stringify(blockingErrors)).not.toMatch(/0\.458333[^\n]+0\.479167|0\.479167[^\n]+0\.458333/);
  });

  it("sanitizes over-specific singular leading-condition figure captions", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract: "The study reports a bounded condition-parameter comparison.",
      keywords: ["condition sweep"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The locked comparison row served as the comparison anchor."] },
        { heading: "Results", paragraphs: ["The reported comparison remains a bounded screening result."] },
        { heading: "Discussion", paragraphs: ["The comparison supports tied follow-up candidates."] },
        { heading: "Conclusion", paragraphs: ["The result identifies candidates for follow-up."] }
      ],
      figures: [
        {
          caption: "Task-level score differences for the leading condition (parameter x=32, parameter y=0) relative to the registered baseline; Table 1 identifies the archived reference condition separately when applicable.",
          bars: [
            { label: "Benchmark Task A task difference", value: 0.02 },
            { label: "Benchmark Task B task difference", value: 0.02 }
          ]
        }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(result.manuscript.figures?.[0]?.caption).toContain("a tied leading condition");
    expect(result.manuscript.figures?.[0]?.caption).not.toMatch(/the leading condition \(/i);
    expect(result.manuscript.figures?.[0]?.caption).not.toMatch(/registered baseline \(/i);
    expect(result.manuscript.figures?.[0]?.caption).not.toMatch(/locked comparison details/i);
  });

  it("prefers explicit seed schedules over protocol repeat-like counts", () => {
    const bundle = makeRichBundle();
    bundle.latestResults = {
      protocol: {
        repeats: 10
      }
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract: "The study reports a bounded repeated-seed evaluation.",
      keywords: ["condition sweep"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The protocol used 3 seeds for the reported comparison."] },
        { heading: "Results", paragraphs: ["The reported comparison remains a bounded screening result."] },
        { heading: "Discussion", paragraphs: ["The evidence does not support broad tuning rules."] },
        { heading: "Conclusion", paragraphs: ["The result identifies a candidate for follow-up."] }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const repeatCountErrors = result.consistency_lint.issues.filter(
      (issue) =>
        issue.kind === "count_inconsistency"
        && issue.severity === "error"
        && /3 repeats|3 seeds|10 repeats/iu.test(issue.message + JSON.stringify(issue.normalized_facts || []))
    );
    expect(repeatCountErrors.map((issue) => issue.message)).toEqual([]);
  });

  it("does not treat baseline and leading bars in the main figure as contradictory aggregate accuracy", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition preflight";
    bundle.topic = "condition parameters interaction for a small LLM benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          label: "baseline condition",
          condition_parameter_x: 8,
          condition_parameter_y: 0,
          is_baseline: true,
          completed_seed_count: 1,
          average_accuracy_mean: 0.35,
          accuracy_delta_vs_baseline_mean: 0,
          benchmark_task_a_accuracy: 0.5,
          benchmark_task_b_accuracy: 0.1667
        },
        {
          condition_marker: "candidate_condition_f5",
          label: "candidate condition b",
          condition_parameter_x: 32,
          condition_parameter_y: 0.05,
          completed_seed_count: 1,
          average_accuracy_mean: 0.425,
          accuracy_delta_vs_baseline_mean: 0.075,
          benchmark_task_a_accuracy: 0.5,
          benchmark_task_b_accuracy: 0.35
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "average_accuracy", value: 0.425 },
        { key: "accuracy_delta_vs_baseline", value: 0.075 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract:
        "The best observed condition was candidate condition b, increasing average accuracy from 33.3% to 41.7%, an 7.5-point gain over the locked baseline.",
      keywords: ["configuration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The locked baseline condition served as the comparison anchor."] },
        {
          heading: "Results",
          paragraphs: [
            "The locked baseline, baseline condition with zero parameter_y, achieved mean accuracy 0.35.",
            "The best observed setting was candidate condition b, which achieved mean accuracy 0.425 across Benchmark Task A and Benchmark Task B.",
            "The average difference remains a local screening signal rather than a settled prescription."
          ]
        },
        { heading: "Discussion", paragraphs: ["The comparison supports a narrow follow-up candidate."] },
        { heading: "Conclusion", paragraphs: ["The result remains a local preflight signal."] }
      ],
      figures: [
        {
          caption:
            "Task-level and average accuracy for the leading condition; paired bars compare the locked baseline with the best observed condition-parameter cell.",
          bars: [
            { label: "Baseline Average", value: 0.35 },
            { label: "Leading Average", value: 0.425 }
          ],
          source_refs: [{ kind: "artifact", id: "manuscript.derived_main_figure" }]
        }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(
      result.consistency_lint.issues.filter((issue) =>
        /Results and Figure 1 report conflicting aggregate accuracy values/iu.test(issue.message)
      )
    ).toHaveLength(0);
    expect(
      result.consistency_lint.issues.filter(
        (issue) => issue.kind === "numeric_inconsistency" && issue.severity === "error"
      )
    ).toHaveLength(0);
  });

  it("does not treat abstract from-to accuracy prose as conflicting with the leading artifact value", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition preflight";
    bundle.topic = "condition parameters interaction for a small LLM benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          label: "baseline condition",
          condition_parameter_x: 8,
          condition_parameter_y: 0,
          is_baseline: true,
          completed_seed_count: 1,
          average_accuracy_mean: 0.35,
          accuracy_delta_vs_baseline_mean: 0
        },
        {
          condition_marker: "candidate_condition_f5",
          label: "candidate condition b",
          condition_parameter_x: 32,
          condition_parameter_y: 0.05,
          completed_seed_count: 1,
          average_accuracy_mean: 0.425,
          accuracy_delta_vs_baseline_mean: 0.075
        }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract:
        "In the archived main run, the best observed condition was candidate condition b, which improved average accuracy from 0.35 to 0.425, an absolute gain of 0.075 over the baseline and above the prespecified +0.01 target.",
      keywords: ["configuration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The locked baseline condition served as the comparison anchor."] },
        {
          heading: "Results",
          paragraphs: [
            "The leading observed condition reached mean average accuracy 0.425, compared with 0.35 for the locked baseline."
          ]
        },
        { heading: "Discussion", paragraphs: ["The comparison supports a narrow follow-up candidate."] },
        { heading: "Conclusion", paragraphs: ["The result remains a local preflight signal."] }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(
      result.consistency_lint.issues.filter((issue) =>
        /Abstract cites 0\.3333.*structured results support 0\.4167/iu.test(issue.message)
      )
    ).toHaveLength(0);
  });

  it("keeps resource values separate from nearby sequence length and dataset names", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition preflight";
    bundle.topic = "condition parameters interaction for a small LLM benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "device.cuda_max_memory_allocated_bytes", value: 2684354560 },
        { key: "wall_clock_seconds", value: 31.25 },
        { key: "accuracy_delta_vs_baseline", value: 0.075 },
        { key: "train_loss", value: 1.5242 }
      ]
    } as any;
    bundle.latestResults = {
      protocol: {
        datasets: ["Benchmark Task A", "Benchmark Task B"],
        condition_count: 8,
        executed_condition_count: 8
      },
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          label: "baseline condition",
          condition_parameter_x: 8,
          condition_parameter_y: 0,
          is_baseline: true,
          completed_seed_count: 1,
          average_accuracy_mean: 0.35,
          accuracy_delta_vs_baseline_mean: 0,
          train_loss_mean: 1.462,
          runtime_seconds_mean: 5.339,
          peak_memory_mb_mean: 4278.951936,
          benchmark_task_a_accuracy: 0.5,
          benchmark_task_b_accuracy: 0.166667
        },
        {
          condition_marker: "candidate_condition_f5",
          label: "candidate condition b",
          condition_parameter_x: 32,
          condition_parameter_y: 0.05,
          is_baseline: false,
          completed_seed_count: 1,
          average_accuracy_mean: 0.425,
          accuracy_delta_vs_baseline_mean: 0.075,
          train_loss_mean: 1.5242,
          runtime_seconds_mean: 5.339,
          peak_memory_mb_mean: 4278.951936,
          benchmark_task_a_accuracy: 0.5,
          benchmark_task_b_accuracy: 0.35
        }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract:
        "The intended sweep crossed parameter x {4, 8, 16, 32} and parameter y {0.0, 0.05}, with average accuracy as the endpoint. The best condition improves average accuracy from 0.35 to 0.425, an increase of 0.075 over the baseline. In the main recorded sweep, the best reported condition, candidate condition b, achieved 0.425 average accuracy compared with 0.35 for the baseline, a gain of 0.075. The best reported comparison, candidate condition b versus the baseline, achieved average accuracy 0.425 versus 0.35, a gain of 0.075 that exceeds the prespecified 0.01 improvement target. The run is operationally lightweight, reporting 8 of 8 requested conditions completed, 31.25 s wall-clock time, and about 2.5 GB peak CUDA allocation. The sweep completed in 31.25 s with 2.5 GB peak CUDA allocation. Condition-level 95% intervals overlap substantially, and each interval is based on only 12 predictions.",
      keywords: ["parameterized method"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: [
            "We study a fixed-budget condition-parameter preflight. In a related low-budget study, parameterized reasoning training was executed on a single 48 GB GPU within 24 hours."
          ]
        },
        {
          heading: "Method",
          paragraphs: [
            "Maximum sequence length was 256 for the retained pilot, and the timeout budget was 1,800 s."
          ]
        },
        {
          heading: "Results",
          paragraphs: [
            "The best recorded condition was candidate condition b, which improved average accuracy from 0.35 in the locked baseline to 0.425.",
            "The baseline average accuracy is 0.35, while the best reported condition reaches 0.425, giving a delta of 0.075 over baseline.",
            "Reported training loss did not improve in parallel: the baseline loss was 1.4620, whereas the best-accuracy condition reported 1.5242.",
            "The baseline train loss is 1.461996, whereas the best reported condition has a higher train loss of 1.524199 despite better evaluation accuracy.",
            "The higher-accuracy condition did not coincide with lower training loss: the baseline is reported at 1.4620, whereas the best-accuracy setting is reported at 1.5242.",
            "Training loss moved in the opposite direction, rising from 1.462 to 1.524, so the favorable accuracy result was not accompanied by a lower reported loss.",
            "In the best condition-to-baseline comparison, Benchmark Task A accuracy stayed at 0.50 for both settings, while Benchmark Task B increased from 0.1667 to 0.35.",
            "Benchmark Task A accuracy is reported as 0.500000 for both the baseline and the best condition, so there is no observed improvement on that benchmark.",
            "The artifact reports 8 requested and 8 completed conditions, 31.25 s wall-clock runtime, and peak CUDA allocation of approximately 2.5 GB.",
            "Reported wall-clock time was 31.25 seconds, peak CUDA allocation was 2,684,354,560 bytes (about 2.5 GB), and the experiment remained well within the 1,800-second budget.",
            "At this preflight scale, the execution reports 31.25 seconds of wall-clock time and 2,684,354,560 bytes of peak allocated CUDA memory.",
            "The summarized run finished in 31.25 s, remained within the 1,800 s timeout, and reached a peak CUDA allocation of 2,684,354,560 bytes, or about 4.0 GiB.",
            "They should not be read as a runtime or memory estimate for the originally planned 10000-example protocol.",
            "For most conditions, the reported 95% intervals for average accuracy span approximately 0.138 to 0.609 over 12 predictions, and the best observed cell spans approximately 0.193 to 0.680."
          ]
        },
        {
          heading: "Discussion",
          paragraphs: ["The resource measurements support feasibility rather than condition-level efficiency claims."]
        },
        {
          heading: "Conclusion",
          paragraphs: [
            "The gain was concentrated in Benchmark Task B, and the full eight-cell sweep remained cheap to execute at under a minute, roughly 2.5 GB of peak GPU memory, and an accuracy delta of 0.075 over the baseline."
          ]
        }
      ],
      appendix_tables: [
        {
          caption: "Supplementary uncertainty summary for average accuracy.",
          rows: [{ label: "Predictions Per Condition", value: 12 }]
        }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(
      result.consistency_lint.issues
        .filter((issue) =>
          /conflicting aggregate peak memory mb values/iu.test(issue.message)
          || /conflicting aggregate accuracy delta vs baseline values/iu.test(issue.message)
          || /cites 0\.3333, but the comparable structured results support .*accuracy_delta_vs_baseline/iu.test(issue.message)
          || /cites 0\.4167, but the comparable structured results support .*accuracy_delta_vs_baseline/iu.test(issue.message)
          || /cites 0\.333334, but the comparable structured results support .*accuracy_delta_vs_baseline/iu.test(issue.message)
          || /cites 0\.416666, but the comparable structured results support .*accuracy_delta_vs_baseline/iu.test(issue.message)
          || /cites 0\.3333, but the comparable structured results support .*accuracy_delta_vs_baseline/iu.test(issue.message)
          || /cites 0\.4167, but the comparable structured results support .*accuracy_delta_vs_baseline/iu.test(issue.message)
          || /cites 1\.462, but the comparable structured results support .*accuracy_delta_vs_baseline/iu.test(issue.message)
          || /cites (?:8|45\.687|45\.7), but the comparable structured results support .*runtime_seconds/iu.test(issue.message)
          || /Abstract cites 12, but the comparable structured results support .*runtime_seconds/iu.test(issue.message)
          || /cites 2684354560, but the comparable structured results support .*runtime_seconds/iu.test(issue.message)
          || /cites 10,?000, but the comparable structured results support .*peak_memory_mb/iu.test(issue.message)
          || /cites (?:24|48|256), but the comparable structured results support .*peak_memory_mb/iu.test(issue.message)
          || /Results cites (?:0\.138|0\.609|0\.1381|0\.6094), but the comparable structured results support .*peak_memory_mb/iu.test(issue.message)
          || /cites 1\.5242, but the current artifacts do not expose a comparable structured numeric fact for train_loss/iu.test(issue.message)
          || /cites 1\.462, but the current artifacts do not expose a comparable structured numeric fact for train_loss/iu.test(issue.message)
          || /cites 1\.5242, but the comparable structured results support .*accuracy/iu.test(issue.message)
          || /cites 1\.462, but the comparable structured results support .*accuracy/iu.test(issue.message)
          || /cites 1,?800, but the comparable structured results support .*runtime_seconds/iu.test(issue.message)
          || /cites 0\.138, but the comparable structured results support .*accuracy/iu.test(issue.message)
          || /cites 0\.5, but the current artifacts do not expose a comparable structured numeric fact for accuracy_delta/iu.test(issue.message)
          || /Results cites 0\.5, but the comparable structured results support .*accuracy/iu.test(issue.message)
          || /Abstract cites 0\.05, but the comparable structured results support .*accuracy/iu.test(issue.message)
          || /Results and Figure 1 report conflicting Benchmark Task A accuracy values/iu.test(issue.message)
          || /Results and Figure 1 report conflicting Benchmark Task B accuracy values/iu.test(issue.message)
          || /Appendix Table \d+ cites 12, but the comparable structured results support .*accuracy/iu.test(issue.message)
          || /Supplementary Boundary Notes cites 45\.687, but the comparable structured results support .*runtime_seconds/iu.test(issue.message)
          || /Abstract and Results report conflicting aggregate runtime seconds values/iu.test(issue.message)
        )
        .map((issue) => issue.message)
    ).toEqual([]);
    const conclusionMemoryIssues = result.consistency_lint.issues.filter((issue) =>
        issue.kind === "numeric_unverifiable"
        && /Conclusion cites 4\.28, but the current artifacts do not expose a comparable structured numeric fact for peak_memory_mb/iu.test(issue.message)
      );
    expect(conclusionMemoryIssues).toHaveLength(0);
  });

  it("does not treat condition-cluster table prose as a conflicting single aggregate accuracy", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition preflight";
    bundle.topic = "condition parameters interaction for a small LLM benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          label: "baseline condition",
          condition_parameter_x: 8,
          condition_parameter_y: 0,
          is_baseline: true,
          completed_seed_count: 1,
          average_accuracy_mean: 0.35,
          accuracy_delta_vs_baseline_mean: 0
        },
        {
          condition_marker: "candidate_condition_f5",
          label: "candidate condition b",
          condition_parameter_x: 32,
          condition_parameter_y: 0.05,
          completed_seed_count: 1,
          average_accuracy_mean: 0.425,
          accuracy_delta_vs_baseline_mean: 0.075
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "average_accuracy", value: 0.425 },
        { key: "accuracy_delta_vs_baseline", value: 0.075 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract: "We report a bounded condition-parameter preflight.",
      keywords: ["configuration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The locked baseline condition served as the comparison anchor."] },
        {
          heading: "Results",
          paragraphs: [
            "Table 1 shows seven cells tied at 0.35 mean accuracy and one cell, candidate condition b, at 0.425.",
            "Seven of the eight cells reported the same mean average accuracy, 0.35, and only candidate condition b reached 0.425."
          ]
        },
        { heading: "Discussion", paragraphs: ["The comparison supports a narrow follow-up candidate."] },
        { heading: "Conclusion", paragraphs: ["The result remains a local preflight signal."] }
      ],
      tables: [
        {
          caption: "Condition-level mean accuracy across the executed condition-parameter grid; labels identify the locked baseline row.",
          rows: [
            { label: "baseline condition", value: 0.35 },
            { label: "candidate condition A", value: 0.35 },
            { label: "candidate condition d", value: 0.35 },
            { label: "candidate condition f", value: 0.35 },
            { label: "candidate condition B", value: 0.35 },
            { label: "One reported condition-level 95% interval", value: 0.35 },
            { label: "candidate condition e", value: 0.35 },
            { label: "candidate condition b", value: 0.425 }
          ],
          source_refs: [{ kind: "artifact", id: "latest_results.condition_summaries" }]
        }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    expect(
      result.consistency_lint.issues.filter((issue) =>
        /Results and Table 1 report conflicting aggregate accuracy values/iu.test(issue.message)
      )
    ).toHaveLength(0);
    expect(
      result.consistency_lint.issues.filter((issue) =>
        /Results cites 0\.3333, but the comparable structured results support/iu.test(issue.message)
      )
    ).toHaveLength(0);
    expect(
      result.consistency_lint.issues.filter((issue) =>
        /Results and Table 1 report conflicting aggregate accuracy values/iu.test(issue.message)
      )
    ).toHaveLength(0);
    expect(
      result.consistency_lint.issues.filter(
        (issue) => issue.kind === "numeric_inconsistency" && issue.severity === "error"
      )
    ).toHaveLength(0);
  });

  it("does not treat condition parameter values near accuracy prose as metric facts", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition preflight";
    bundle.topic = "condition parameters interaction for a small benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          label: "condition a",
          condition_parameter_x: 4,
          condition_parameter_y: 0,
          is_baseline: true,
          completed_seed_count: 1,
          average_accuracy_mean: 0.45,
          accuracy_delta_vs_baseline_mean: 0
        },
        {
          condition_marker: "candidate_condition_b",
          label: "condition b",
          condition_parameter_x: 32,
          condition_parameter_y: 0,
          completed_seed_count: 1,
          average_accuracy_mean: 0.475,
          accuracy_delta_vs_baseline_mean: 0.025
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "average_accuracy", value: 0.475 },
        { key: "accuracy_delta_vs_baseline", value: 0.025 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Condition-Parameter Preflight",
      abstract:
        "The most detailed available contrast favored candidate condition b over baseline condition a, with average accuracy 0.475 versus 0.45.",
      keywords: ["configuration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget condition-parameter preflight."] },
        { heading: "Method", paragraphs: ["The comparison keeps condition parameters fixed except for the reported grid cells."] },
        {
          heading: "Results",
          paragraphs: [
            "In that contrast, average accuracy was 0.475 for condition b and 0.45 for condition a."
          ]
        },
        { heading: "Discussion", paragraphs: ["The comparison supports a narrow follow-up candidate."] },
        {
          heading: "Conclusion",
          paragraphs: [
            "The reported primary point estimate was positive: average accuracy improved by 0.025 relative to the reported reference value."
          ]
        }
      ]
    };

    const result = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    const aggregateAccuracyIssues = result.consistency_lint.issues.filter((issue) =>
        issue.kind === "numeric_inconsistency"
        && /conflicting aggregate accuracy values/iu.test(issue.message)
      );
    expect(aggregateAccuracyIssues, JSON.stringify(aggregateAccuracyIssues, null, 2)).toHaveLength(0);
    expect(
      result.consistency_lint.issues.filter((issue) =>
        issue.kind === "numeric_unverifiable"
        && /accuracy_delta/iu.test(issue.message)
      )
    ).toHaveLength(0);
  });

  it("can re-apply evidence-grounded paper-scale strengthening after manuscript repair", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "parameterized condition repeated-seed benchmark";
    bundle.topic = "condition parameters interaction for a small LLM benchmark";
    bundle.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    bundle.latestResults = {
      baseline_marker: "baseline_condition",
      condition_summaries: [
        {
          condition_marker: "baseline_condition",
          condition_parameter_x: 8,
          condition_parameter_y: 0,
          completed_seed_count: 5,
          average_accuracy_mean: 0.4417,
          accuracy_delta_vs_baseline_mean: 0
        },
        {
          condition_marker: "candidate_condition_f5",
          condition_parameter_x: 32,
          condition_parameter_y: 0.05,
          completed_seed_count: 5,
          average_accuracy_mean: 0.5084,
          accuracy_delta_vs_baseline_mean: 0.0525
        }
      ]
    } as any;
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "accuracy_delta_vs_baseline", value: 0.0375 },
        { key: "completed_run_count", value: 25 }
      ],
      statistical_summary: {
        effect_estimates: [
          {
            comparison_id: "candidate_condition_vs_baseline",
            metric_key: "accuracy_delta_vs_baseline",
            delta: 0.0525,
            direction: "positive",
            summary: "The best nonbaseline cell has a positive mean delta."
          }
        ],
        notes: ["Seed-level dispersion remains visible."]
      },
      synthesis: {
        discussion_points: ["The evidence supports a narrow benchmark signal, not a universal configuration prescription."],
        failure_analysis: [],
        follow_up_actions: ["Carry candidate condition b into a larger scale-up."],
        confidence_statement: "Confidence is moderate."
      },
      limitations: ["The small LLM preflight does not establish a general stability law."]
    } as any;
    const context = experimentArtifactLoader({ bundle });
    const repaired: PaperManuscript = {
      title: "Repeated-Seed configuration ParameterY Benchmark",
      abstract: "The study-level delta relative to baseline was +0.0375.",
      keywords: ["configuration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study condition parameters under a fixed local budget."] },
        { heading: "Related Work", paragraphs: ["quantized method and method-family benchmarks motivate the local configuration question."] },
        { heading: "Method", paragraphs: ["The protocol uses a locked baseline condition and a higher-parameter x comparison."] },
        { heading: "Results", paragraphs: ["The candidate condition b cell had the strongest mean delta."] },
        { heading: "Discussion", paragraphs: ["The result is a follow-up signal rather than a broad conclusion."] },
        { heading: "Limitations", paragraphs: ["The study is a small-backbone preflight."] },
        { heading: "Conclusion", paragraphs: ["The strongest cell merits follow-up."] }
      ]
    };

    const strengthened = strengthenPaperScaleManuscript(repaired, context);
    const resultsWords = strengthened.sections
      .find((section) => section.heading === "Results")
      ?.paragraphs.join(" ").split(/\s+/u).length || 0;

    expect(resultsWords).toBeGreaterThan(0);
    expect(strengthened.sections.find((section) => section.heading === "Limitations")?.paragraphs.length).toBeGreaterThan(0);
  });

  it("sanitizes reader-facing provenance, schema dumps, and claim-boundary terms", () => {
    const context = experimentArtifactLoader({ bundle: makeRichBundle() });
    const manuscript: PaperManuscript = {
      title: "Bounded Evaluation",
      abstract: "A short abstract.",
      keywords: ["benchmark"],
      sections: [
        {
          heading: "Method",
          paragraphs: [
            "The paper-writing payload records the configured model [configured model] and configured dataset [configured dataset]. Details are stored at /tmp/run/metrics.json."
          ]
        },
        {
          heading: "Limitations",
          paragraphs: [
            "condition summaries / candidate condition / validation score 95% CI [0.18, 0.26] over n=7."
          ]
        },
        {
          heading: "Discussion",
          paragraphs: [
            "The evidence remains under a bounded claim ceiling, while review gating remains an internal process term."
          ]
        },
        {
          heading: "Results",
          paragraphs: [
            "raw_precision=0.71 raw_recall=0.69.",
            "Objective metric met: validation_score=0.72 >= 0.65."
          ]
        },
        {
          heading: "Conclusion",
          paragraphs: [
            "A reader-visible audit-log sentence marks an internal transition."
          ]
        }
      ]
    };

    const strengthened = strengthenPaperScaleManuscript(manuscript, context);
    const text = strengthened.sections.flatMap((section) => section.paragraphs).join(" ");

    expect(text).toContain("reported evidence records the configured model and configured dataset");
    expect(text).toContain(
      "One reported condition-level 95% interval for validation score spans [0.18, 0.26] over 7 observations"
    );
    expect(text).toContain("archived objective check cleared");
    expect(text).toContain("bounded interpretation");
    expect(text).toContain("review checks");
    expect(text).toContain("reader-facing transition sentence");
    expect(text).not.toMatch(/paper-writing payload|\[configured model\]|\[configured dataset\]/i);
    expect(text).not.toMatch(/Objective metric met|raw_precision|raw_recall/i);
    expect(text).not.toMatch(/\/tmp\/run\/metrics\.json/i);
  });
  it("rejects internal planning titles and drops internal appendix material", () => {
    expect(
      choosePaperTitle({
        candidateTitle: "Plan 1: Internal workflow draft",
        runTitle: "governed baseline comparison",
        fallbackTitle: "A Bounded Empirical Comparison"
      })
    ).toBe("A Bounded Empirical Comparison");

    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Evaluation",
      abstract: "A short abstract.",
      keywords: ["benchmark"],
      sections: [
        { heading: "Introduction", paragraphs: ["We compare bounded conditions."] },
        {
          heading: "Method",
          paragraphs: [
            "Resource diagnostics are explicitly measured in the evaluation outputs.",
            "The fixed search space is the condition-parameter grid described above."
          ]
        },
        {
          heading: "Results",
          paragraphs: [
            "Objective metric met: validation_score=0.72 >= 0.65.",
            "precision_score=0.71 recall_score=0.69.",
            "The comparison remains bounded by the declared baseline."
          ]
        },
        {
          heading: "Discussion",
          paragraphs: ["The evidence remains under a bounded claim ceiling."]
        },
        {
          heading: "Limitations",
          paragraphs: [
            "condition summaries / candidate condition / validation score 95% CI [0.18, 0.26] over n=7."
          ]
        },
        { heading: "Conclusion", paragraphs: ["The leading condition merits replication."] }
      ],
      appendix_sections: [
        {
          heading: "Appendix: Gate Output",
          paragraphs: [
            "The appendix preserves the manuscript-quality gate output and page-budget validation."
          ]
        },
        {
          heading: "Supplementary Experimental Details",
          paragraphs: ["Supplementary setup details describe the repeated condition grid."]
        },
        {
          heading: "Supplementary Experimental Details",
          paragraphs: ["Supplementary setup details describe the repeated condition grid."]
        }
      ],
      appendix_tables: [
        {
          caption: "Declared and observed setup values.",
          rows: [
            { label: "Declared Budget", value: 12 },
            { label: "Observed Count", value: 9 }
          ]
        },
        {
          caption: "Declared and observed setup values.",
          rows: [
            { label: "Declared Budget", value: 12 },
            { label: "Observed Count", value: 9 }
          ]
        }
      ]
    };

    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: { sections: [], tables: [], figures: [], cross_references: [] },
      pageBudget: scientific.page_budget
    }).manuscript;
    const allText = [
      manuscript.title,
      manuscript.sections.flatMap((section) => section.paragraphs).join(" "),
      (manuscript.appendix_sections || [])
        .flatMap((section) => [section.heading, ...section.paragraphs])
        .join(" ")
    ].join(" ");

    expect(allText).toContain("Supplementary setup details");
    expect(allText).toContain("archived objective check cleared");
    expect(allText).toContain("bounded interpretation");
    expect(
      (manuscript.appendix_sections || []).filter(
        (section) => section.heading === "Supplementary Experimental Details"
      )
    ).toHaveLength(1);
    expect(manuscript.appendix_tables || []).toHaveLength(1);
    expect(allText).not.toMatch(
      /Plan 1|Objective metric met|precision_score|recall_score|manuscript-quality gate|page-budget validation|gate output/i
    );
  });
  it("LV-016: comma-separated numbers (e.g. 20,789) are not split into phantom matches", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    // Manuscript text mentions "20,789 tokens" — previously the regex split
    // this into "20" and "789", and "789" was close enough to runtime_seconds
    // (828.56) to produce a blocking "contradiction" error.
    const candidate: PaperManuscript = {
      title: "Token Count Study",
      abstract: "The adaptive condition generated 20,789 tokens total.",
      keywords: ["test-time compute"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study adaptive inference."] },
        { heading: "Method", paragraphs: ["We evaluate 2 datasets with outer 5-fold CV and inner 3-fold tuning."] },
        {
          heading: "Results",
          paragraphs: [
            "The adaptive condition generated 20,789 tokens in total, " +
            "while the baseline generated 19,002 tokens. " +
            "Average latency rose from 736.84 ms to 828.56 ms."
          ]
        },
        { heading: "Conclusion", paragraphs: ["Token savings remain modest."] }
      ]
    };
    const manuscript = materializeScientificManuscript({
      candidate,
      draft: scientific.draft,
      bundle,
      profile: PAPER_PROFILE,
      appendixPlan: scientific.appendix_plan,
      pageBudget: scientific.page_budget
    });

    // "789" must NOT appear as a standalone extracted numeric fact
    const phantomFact = manuscript.consistency_lint.issues.find(
      (issue) =>
        issue.kind === "numeric_inconsistency" &&
        (issue.normalized_facts || []).some((f) => f.value === 789)
    );
    expect(phantomFact).toBeUndefined();

    // "20789" (the correct parsed value) should not produce a blocking error either
    const blockingFromComma = manuscript.consistency_lint.issues.filter(
      (issue) =>
        issue.kind === "numeric_inconsistency" &&
        issue.severity === "error" &&
        (issue.normalized_facts || []).some((f) => f.value === 20789 || f.value === 19002)
    );
    expect(blockingFromComma).toHaveLength(0);
  });
});
