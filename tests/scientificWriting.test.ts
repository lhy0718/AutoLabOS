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
  primaryComparisonTableBuilder,
  buildScientificValidationArtifact,
  buildWritePaperGateDecision,
  enforceManuscriptPageBudgetFloor,
  experimentArtifactLoader,
  materializeScientificManuscript,
  pageBudgetManager,
  refreshScientificValidationForManuscript,
  resolvePaperProfile,
  strengthenPaperScaleManuscript
} from "../src/core/analysis/scientificWriting.js";
import type { ResultsArtifactV2, ResultsPlanV2 } from "../src/core/analysis/resultsTableSchema.js";

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

function makeCanonicalResultsArtifact(options: {
  direction?: "higher_better" | "lower_better";
  unit?: string;
  subjectValue?: number;
  referenceValue?: number;
  subjectLabel?: string;
  referenceLabel?: string;
  includeSecondaryComparison?: boolean;
  reverseArrays?: boolean;
} = {}): ResultsArtifactV2 {
  const direction = options.direction || "higher_better";
  const unit = options.unit || "points";
  const subjectValue = options.subjectValue ?? 0.776;
  const referenceValue = options.referenceValue ?? 0.75;
  const metrics: ResultsArtifactV2["metrics"] = [
    { id: "metric_m1", label: "Primary measure", direction, unit },
    { id: "metric_m2", label: "Elapsed time", direction: "lower_better", unit: "seconds" },
    { id: "metric_m3", label: "Allocated memory", direction: "lower_better", unit: "megabytes" }
  ];
  const series: ResultsArtifactV2["series"] = [
    {
      id: "series_s1",
      label: options.subjectLabel || "Declared subject",
      role: "comparator",
      dimensions: { group: "g1" }
    },
    {
      id: "series_s2",
      label: options.referenceLabel || "Declared reference",
      role: "baseline",
      dimensions: { group: "g2" }
    },
    ...(options.includeSecondaryComparison
      ? [{
          id: "series_s3",
          label: "Secondary subject",
          role: "comparator" as const,
          dimensions: { group: "g3" }
        }]
      : [])
  ];
  const observations: ResultsArtifactV2["observations"] = [
    {
      id: "observation_o1",
      series_id: "series_s1",
      metric_id: "metric_m1",
      scope: { split: "evaluation" },
      value: subjectValue,
      evidence_refs: ["evidence_e1"]
    },
    {
      id: "observation_o2",
      series_id: "series_s2",
      metric_id: "metric_m1",
      scope: { split: "evaluation" },
      value: referenceValue,
      evidence_refs: ["evidence_e2"]
    },
    ...(options.includeSecondaryComparison
      ? [{
          id: "observation_o3",
          series_id: "series_s3",
          metric_id: "metric_m1",
          scope: { split: "evaluation" },
          value: referenceValue + (subjectValue - referenceValue) / 2,
          evidence_refs: ["evidence_e3"]
        }]
      : [])
  ];
  const comparisons: ResultsArtifactV2["comparisons"] = [
    {
      id: "comparison_c1",
      subject_observation_id: "observation_o1",
      reference_observation_id: "observation_o2",
      delta: subjectValue - referenceValue,
      evidence_refs: ["evidence_e1", "evidence_e2"]
    },
    ...(options.includeSecondaryComparison
      ? [{
          id: "comparison_c2",
          subject_observation_id: "observation_o3",
          reference_observation_id: "observation_o2",
          delta: (subjectValue - referenceValue) / 2,
          evidence_refs: ["evidence_e2", "evidence_e3"]
        }]
      : [])
  ];
  return {
    schema_version: "2.0",
    metrics: options.reverseArrays ? [...metrics].reverse() : metrics,
    series: options.reverseArrays ? [...series].reverse() : series,
    observations: options.reverseArrays ? [...observations].reverse() : observations,
    comparisons: options.reverseArrays ? [...comparisons].reverse() : comparisons
  };
}

function makeCanonicalResultsPlan(
  artifact: ResultsArtifactV2,
  options: { primaryComparisonId?: string; omitPrimaryComparison?: boolean } = {}
): ResultsPlanV2 {
  const observationsById = new Map(
    artifact.observations.map((observation) => [observation.id, observation] as const)
  );
  const requiredComparisons = artifact.comparisons.flatMap((comparison) => {
    const subject = observationsById.get(comparison.subject_observation_id);
    const reference = observationsById.get(comparison.reference_observation_id);
    if (!subject || !reference || subject.metric_id !== reference.metric_id) {
      return [];
    }
    return [{
      id: comparison.id,
      subject_series_id: subject.series_id,
      reference_series_id: reference.series_id,
      metric_id: subject.metric_id,
      scope: subject.scope
    }];
  });
  const requiredMetricIds = new Set(requiredComparisons.map((comparison) => comparison.metric_id));
  const requiredSeriesIds = new Set(
    requiredComparisons.flatMap((comparison) => [
      comparison.subject_series_id,
      comparison.reference_series_id
    ])
  );
  const requiredSeries = artifact.series.flatMap((series) =>
    requiredSeriesIds.has(series.id) && series.role
      ? [{ id: series.id, role: series.role }]
      : []
  );
  const primaryComparisonId = options.omitPrimaryComparison
    ? undefined
    : options.primaryComparisonId
      || (artifact.comparisons.length === 1 ? artifact.comparisons[0]?.id : undefined);
  return {
    schema_version: "2.0",
    required_metrics: artifact.metrics.filter((metric) => requiredMetricIds.has(metric.id)),
    minimum_series_count: requiredSeries.length,
    minimum_comparison_count: requiredComparisons.length,
    required_series: requiredSeries,
    required_comparisons: requiredComparisons,
    ...(primaryComparisonId ? { primary_comparison_id: primaryComparisonId } : {})
  };
}

function makeRichBundle(): PaperWritingBundle {
  const resultsArtifact = makeCanonicalResultsArtifact();
  const resultsPlan = makeCanonicalResultsPlan(resultsArtifact);
  return {
    runTitle: "Repeated Declared-Series Comparison",
    topic: "resource-aware evaluation of a declared primary comparison",
    objectiveMetric: "primary_measure_delta >= 0.02",
    constraints: ["ACL style", "evidence-first writing"],
    paperSummaries: [
      {
        paper_id: "paper_1",
        title: "Repeated Evaluation for Declared Comparisons",
        source_type: "full_text",
        summary: "Repeated evaluation improves the auditability of bounded comparisons.",
        key_findings: ["Explicit comparison links reduce post-hoc selection ambiguity."],
        limitations: ["Additional repetitions increase compute cost."],
        datasets: ["evaluation_scope_alpha", "evaluation_scope_beta"],
        metrics: ["primary_measure"],
        novelty: "Evaluation design for declared subject-reference comparisons",
        reproducibility_notes: ["Explicit seeds and evaluation scopes are reported."]
      },
      {
        paper_id: "paper_2",
        title: "Resource-Aware Baseline Comparisons",
        source_type: "full_text",
        summary: "Resource measurements complement, but do not replace, the primary outcome.",
        key_findings: ["Primary and resource metrics require separate interpretation."],
        limitations: ["Results vary across evaluation scopes."],
        datasets: ["evaluation_scope_alpha", "evaluation_scope_beta"],
        metrics: ["primary_measure_delta"],
        novelty: "Resource-aware comparison under a fixed budget",
        reproducibility_notes: ["Dataset provenance and seed schedules are listed."]
      },
      {
        paper_id: "paper_3",
        title: "Uncertainty in Repeated Evaluation",
        source_type: "full_text",
        summary: "Repeated measurements support cautious claims about directional stability.",
        key_findings: ["Repeated evaluation exposes heterogeneity."],
        limitations: ["Intervals do not justify universal claims."],
        datasets: ["declared evaluation suite"],
        metrics: ["stability_measure"],
        novelty: "Uncertainty-aware reporting for bounded evaluation",
        reproducibility_notes: ["Intervals and heterogeneity are emphasized."]
      }
    ],
    evidenceRows: [
      {
        evidence_id: "ev_1",
        paper_id: "paper_1",
        claim: "Repeated evaluation makes declared comparisons easier to audit.",
        method_slot: "fixed subject-reference comparison",
        result_slot: "bounded positive primary-measure difference",
        limitation_slot: "scope-dependent outcomes",
        dataset_slot: "evaluation_scope_alpha",
        metric_slot: "primary_measure_delta",
        evidence_span: "Repeated evaluation exposes a small directional difference across declared scopes.",
        source_type: "full_text",
        confidence: 0.91,
        confidence_reason: "Repeated measurements and explicit scopes are available."
      }
    ],
    hypotheses: [
      {
        hypothesis_id: "h_1",
        text: "The declared subject may show a small positive primary-measure difference from the declared reference.",
        evidence_links: ["ev_1"],
        rationale: "A directional difference is plausible but should remain scoped to the declared comparison.",
        measurement_hint: "Track the primary measure, runtime, memory, and stability."
      }
    ],
    corpus: [
      {
        paper_id: "paper_1",
        title: "Repeated Evaluation for Declared Comparisons",
        abstract: "Repeated evaluation improves the auditability of bounded comparisons.",
        authors: ["Alice Doe"],
        year: 2025,
        venue: "ACL Findings"
      },
      {
        paper_id: "paper_2",
        title: "Resource-Aware Baseline Comparisons",
        abstract: "Resource measurements complement the primary outcome under a fixed budget.",
        authors: ["Bob Doe"],
        year: 2024,
        venue: "EMNLP"
      },
      {
        paper_id: "paper_3",
        title: "Uncertainty in Repeated Evaluation",
        abstract: "Repeated measurements support cautious directional claims.",
        authors: ["Cara Doe"],
        year: 2024,
        venue: "TMLR"
      }
    ],
    experimentPlan: {
      selectedTitle: "Repeated declared-series comparison",
      selectedSummary: "Compare an explicitly linked subject and reference across declared evaluation scopes.",
      rawText: [
        "selected_design:",
        '  title: "Repeated declared-series comparison"',
        '  dataset_source: "declared public source"',
        "  n_samples: 569",
        "  datasets:",
        '    - "evaluation_scope_alpha"',
        '    - "evaluation_scope_beta"',
        "  metrics:",
        '    - "primary_measure"',
        '    - "stability_measure"',
        "  baselines:",
        '    - "declared reference"',
        "  implementation_notes:",
        '    - "Normalize numeric inputs and fit transformations within each training partition."',
        '    - "Track missingness and class balance explicitly."',
        "  evaluation_steps:",
        '    - "Run outer 5-fold evaluation with inner 3-fold selection."',
        '    - "Use stratified partitions and repeat the declared comparison across fixed random seeds."',
        "  resource_notes:",
        '    - "The declared search space includes three bounded configuration values."',
        "constraints:",
        "  implementation_notes:",
        '    - "Dataset provenance and preprocessing order must be reported."',
        "  evaluation_notes:",
        '    - "Keep claims scoped to the linked comparison and report runtime and memory."'
      ].join("\n")
    },
    resultAnalysis: {
      results_artifact: resultsArtifact,
      results_plan: resultsPlan,
      primary_comparison_id: "comparison_c1",
      objective_metric: {
        evaluation: {
          summary: "The declared subject has a small positive primary-measure difference from the reference."
        },
        profile: {
          preferred_metric_keys: ["primary_measure_delta"]
        }
      },
      metric_table: [
        { key: "primary_measure_delta", value: 0.026 },
        { key: "stability_measure", value: 0.885 },
        { key: "runtime_seconds_mean", value: 1.05 },
        { key: "peak_memory_mb_mean", value: 149 }
      ],
      primary_findings: [
        "The declared subject has a small positive primary-measure difference.",
        "Runtime and memory remain secondary resource observations."
      ],
      limitations: [
        "The difference is small and varies by evaluation scope.",
        "Repeated evaluation does not justify broad inferential language."
      ],
      statistical_summary: {
        total_trials: 3,
        executed_trials: 3,
        cached_trials: 0,
        confidence_intervals: [
          {
            metric_key: "metric_m1",
            label: "Primary measure difference",
            lower: 0.015,
            upper: 0.036,
            level: 0.95,
            source: "results_artifact",
            summary: "The 95% interval for the primary measure difference spans 0.015 to 0.036."
          }
        ],
        stability_metrics: [{ key: "stability_measure", value: 0.885 }],
        effect_estimates: [
          {
            comparison_id: "comparison_c1",
            metric_key: "metric_m1",
            delta: 0.026,
            direction: "positive",
            summary: "The declared primary-measure difference is positive but modest."
          }
        ],
        notes: [
          "Dispersion across repeated measurements is moderate rather than negligible.",
          "Heterogeneity remains visible across evaluation scopes."
        ]
      },
      figure_specs: [
        {
          id: "figure_primary",
          title: "Primary comparison by evaluation scope",
          path: "figures/primary-comparison.svg",
          metric_keys: ["primary_measure_delta"],
          summary: "Declared primary comparison with uncertainty-aware interpretation."
        }
      ],
      synthesis: {
        source: "fallback",
        discussion_points: [
          "The observed difference is a bounded follow-up signal rather than a broad method claim."
        ],
        failure_analysis: [],
        follow_up_actions: [],
        confidence_statement: "Confidence is moderate because repeated measurements exist, but scope remains narrow."
      }
    } as any,
    latestResults: {
      protocol: {
        dataset_source: "declared public source",
        datasets: ["evaluation_scope_alpha", "evaluation_scope_beta"],
        repeats: 3,
        seed_schedule: [100, 101, 102],
        n_samples: 569,
        n_features: 30,
        n_classes: 2
      }
    },
    relatedWorkNotes: [
      {
        paper_id: "paper_1",
        title: "Repeated Evaluation for Declared Comparisons",
        source_type: "analyzed_paper",
        comparison_role: "closest",
        method_family: "repeated evaluation design",
        problem_focus: "auditability of explicit comparisons",
        setting_focus: "bounded evaluation suites",
        contribution_focus: "declared comparison links",
        limitation_or_caveat: "additional compute cost",
        relation_to_study: "closest comparison for the evaluation protocol"
      },
      {
        paper_id: "paper_2",
        title: "Resource-Aware Baseline Comparisons",
        source_type: "analyzed_paper",
        comparison_role: "supporting",
        method_family: "resource-aware evaluation",
        problem_focus: "separation of primary and resource outcomes",
        setting_focus: "fixed-budget evaluation",
        contribution_focus: "resource measurement boundaries",
        limitation_or_caveat: "scope-dependent outcomes",
        relation_to_study: "supports comparison framing"
      },
      {
        paper_id: "paper_3",
        title: "Uncertainty in Repeated Evaluation",
        source_type: "analyzed_paper",
        comparison_role: "supporting",
        method_family: "uncertainty-aware reporting",
        problem_focus: "heterogeneity under repeated measurement",
        setting_focus: "repeated evaluation",
        contribution_focus: "cautious statistical framing",
        limitation_or_caveat: "does not justify broad inferential claims",
        relation_to_study: "supports cautious discussion framing"
      }
    ]
  };
}

function makeTerseDraft(): PaperDraft {
  return {
    title: "A Short Draft",
    abstract: "A short draft.",
    keywords: ["declared comparison"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: [{ text: "We compare an explicitly linked subject and reference.", evidence_ids: ["ev_1"], citation_paper_ids: ["paper_1"] }],
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
  it("keeps explicit lower-better claim selection invariant under series renaming and array reordering", () => {
    const originalBundle = makeRichBundle();
    const originalArtifact = makeCanonicalResultsArtifact({
      direction: "lower_better",
      unit: "milliseconds",
      subjectValue: 85,
      referenceValue: 100,
      subjectLabel: "Series label one",
      referenceLabel: "Series label two",
      includeSecondaryComparison: true
    });

    originalBundle.resultAnalysis = {
      ...originalBundle.resultAnalysis,
      results_artifact: originalArtifact,
      results_plan: makeCanonicalResultsPlan(originalArtifact, { primaryComparisonId: "comparison_c1" }),
      primary_comparison_id: "comparison_c1"
    } as any;

    const reorderedBundle = makeRichBundle();
    const reorderedArtifact = makeCanonicalResultsArtifact({
      direction: "lower_better",
      unit: "milliseconds",
      subjectValue: 85,
      referenceValue: 100,
      subjectLabel: "Renamed subject display",
      referenceLabel: "Renamed reference display",
      includeSecondaryComparison: true,
      reverseArrays: true
    });

    reorderedBundle.resultAnalysis = {
      ...reorderedBundle.resultAnalysis,
      results_artifact: reorderedArtifact,
      results_plan: makeCanonicalResultsPlan(reorderedArtifact, { primaryComparisonId: "comparison_c1" }),
      primary_comparison_id: "comparison_c1"
    } as any;

    const original = experimentArtifactLoader({ bundle: originalBundle });
    const reordered = experimentArtifactLoader({ bundle: reorderedBundle });
    const projectSelection = (context: typeof original) => ({
      issues: context.results.primary_comparison_issues,
      status: context.results.primary_comparison_status,
      comparisonId: context.results.primary_comparison?.comparison_id,
      metricId: context.results.primary_comparison?.metric_id,
      direction: context.results.primary_comparison?.metric_direction,
      unit: context.results.primary_comparison?.metric_unit,
      subjectObservationId: context.results.primary_comparison?.subject.observation_id,
      referenceObservationId: context.results.primary_comparison?.reference.observation_id,
      subjectRole: context.results.primary_comparison?.subject.series_role,
      referenceRole: context.results.primary_comparison?.reference.series_role,
      delta: context.results.primary_comparison?.delta,
      outcome: context.results.primary_comparison?.directional_outcome
    });

    expect(projectSelection(reordered)).toEqual(projectSelection(original));
    expect(projectSelection(original)).toMatchObject({
      status: "resolved",
      direction: "lower_better",
      unit: "milliseconds",
      delta: -15,
      outcome: "favors_subject"
    });
    expect(primaryComparisonTableBuilder(reordered)[0]?.rows.map((row) => ({
      side: row.comparison_side,
      observationId: row.observation_id,
      value: row.value
    }))).toEqual([
      { side: "subject", observationId: "observation_o1", value: 85 },
      { side: "reference", observationId: "observation_o2", value: 100 },
      { side: "difference", observationId: undefined, value: -15 }
    ]);
  });

  it("derives outcomes from the declared direction while preserving the declared unit", () => {
    const cases = [
      { direction: "higher_better" as const, expected: "favors_subject" },
      { direction: "lower_better" as const, expected: "favors_reference" }
    ];

    for (const testCase of cases) {
      const artifact = makeCanonicalResultsArtifact({
        direction: testCase.direction,
        unit: "declared-units",
        subjectValue: 12,
        referenceValue: 10
      });
      const bundle = makeRichBundle();
      bundle.resultAnalysis = {
        ...bundle.resultAnalysis,
        results_artifact: artifact,
        results_plan: makeCanonicalResultsPlan(artifact),
        primary_comparison_id: "comparison_c1"
      } as any;

      const context = experimentArtifactLoader({ bundle });

      expect(context.results.primary_comparison).toMatchObject({
        metric_direction: testCase.direction,
        metric_unit: "declared-units",
        delta: 2,
        directional_outcome: testCase.expected
      });
      expect(primaryComparisonTableBuilder(context)[0]?.caption).toContain("unit: declared-units");
    }
  });

  it("fails closed instead of inferring roles or units from labels and values", () => {
    const roleArtifact = makeCanonicalResultsArtifact({
      subjectLabel: "Reference-looking display label",
      referenceLabel: "Subject-looking display label"
    });
    roleArtifact.series = roleArtifact.series.map((series) =>
      series.id === "series_s1"
        ? { ...series, role: "control" }
        : series.id === "series_s2"
          ? { ...series, role: "other" }
          : series
    );
    const roleBundle = makeRichBundle();
    roleBundle.resultAnalysis = {
      ...roleBundle.resultAnalysis,
      results_artifact: roleArtifact,
      results_plan: makeCanonicalResultsPlan(roleArtifact),
      primary_comparison_id: "comparison_c1"
    } as any;

    const roleContext = experimentArtifactLoader({ bundle: roleBundle });

    expect(roleContext.results.primary_comparison_status).toBe("invalid");
    expect(roleContext.results.primary_comparison_issues).toEqual([
      'results_artifact.comparisons[0] requires subject series role primary or comparator; received "control".',
      'results_artifact.comparisons[0] requires reference series role baseline; received "other".',
      'results_plan.required_comparisons[0] requires subject series role primary or comparator; received "control".',
      'results_plan.required_comparisons[0] requires reference series role baseline; received "other".'
    ]);
    expect(roleContext.results.primary_comparison).toBeUndefined();

    const unitArtifact = makeCanonicalResultsArtifact();
    delete unitArtifact.metrics[0].unit;
    const unitBundle = makeRichBundle();
    unitBundle.resultAnalysis = {
      ...unitBundle.resultAnalysis,
      results_artifact: unitArtifact,
      results_plan: makeCanonicalResultsPlan(unitArtifact),
      primary_comparison_id: "comparison_c1"
    } as any;

    const unitContext = experimentArtifactLoader({ bundle: unitBundle });

    expect(unitContext.results.primary_comparison_status).toBe("invalid");
    expect(unitContext.results.primary_comparison_issues).toEqual([
      "results_artifact.metrics[0].unit must be a non-empty string.",
      "results_plan.required_metrics[0].unit must be a non-empty string."
    ]);
    expect(unitContext.results.aggregate_metric_facts).toEqual([]);
  });

  it("fails closed as invalid when canonical comparisons omit an explicit primary ID", () => {
    const artifact = makeCanonicalResultsArtifact({ includeSecondaryComparison: true });
    const bundle = makeRichBundle();
    bundle.resultAnalysis = {
      ...bundle.resultAnalysis,
      results_artifact: artifact,
      results_plan: makeCanonicalResultsPlan(artifact, { omitPrimaryComparison: true })
    } as any;
    delete (bundle.resultAnalysis as any).primary_comparison_id;

    const context = experimentArtifactLoader({ bundle });

    expect(context.results.primary_comparison_status).toBe("invalid");
    expect(context.results.primary_comparison_issues).toEqual([
      "results_plan.primary_comparison_id is required when results_plan.required_comparisons includes one or more comparisons."
    ]);
    expect(context.results.primary_comparison).toBeUndefined();
    expect(context.results.aggregate_summary).toEqual([]);
    expect(context.results.aggregate_metric_facts).toEqual([]);
    expect(context.results.dataset_summaries).toEqual([]);
    expect(context.results.effect_notes).toEqual([]);
    expect(primaryComparisonTableBuilder(context)).toEqual([]);
  });

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
      title: "Repeated Declared-Series Comparison",
      abstract: "A short abstract.",
      keywords: ["declared comparison"],
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
    expect(relatedText).toContain("repeated evaluation design");
    expect(relatedText).toContain("resource-aware evaluation");
    expect(relatedText).toMatch(/positioning anchors rather than direct numerical baselines/i);
    const conclusionText = manuscript.manuscript.sections.find((section) => section.heading === "Conclusion")?.paragraphs.join(" ") || "";
    expect(conclusionText).toMatch(/keeps execution coverage and supplementary metrics secondary/i);
    expect(conclusionText).not.toMatch(/Detailed protocol and repeat-level evidence/i);
    expect(
      manuscript.consistency_lint.ok,
      JSON.stringify(manuscript.consistency_lint.issues, null, 2)
    ).toBe(true);
    expect(manuscript.appendix_lint.ok).toBe(true);
    expect(manuscript.provenance_map.paragraph_anchors.length).toBeGreaterThan(0);
    expect(
      manuscript.provenance_map.numeric_anchors.some(
        (anchor) => anchor.fact.metric_key === "metric_m1"
      )
    ).toBe(true);
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
      selectedTitle: "declared series under fixed-budget adaptation",
      selectedSummary: "Compare declared series across Evaluation Scope One and Evaluation Scope Two with a selected implementation.",
      rawText: [
        "selected_design:",
        '  title: "declared series under fixed-budget adaptation"',
        '  implementation: "the selected implementation"',
        '  method: "parameterized method"',
        "  datasets:",
        '    - "Evaluation Scope One"',
        '    - "Evaluation Scope Two"'
      ].join("\n")
    };
    bundle.objectiveMetric = [
      "- Primary metric: primary measure across Evaluation Scope One and Evaluation Scope Two.",
      "- Secondary metrics: per-scope primary measure, train loss, wall-clock runtime.",
      "- Meaningful improvement: at least +1.0 percentage point."
    ].join(" ");
    bundle.relatedWorkNotes = [
      {
        paper_id: "paper_1",
        title: "Composable Methods for Bounded Adaptation",
        source_type: "analyzed_paper",
        comparison_role: "closest",
        method_family: "bounded adaptation",
        problem_focus:
          "Recently, configurable systems have gained significant importance across bounded evaluation settings...",
        setting_focus: "bounded adaptation",
        contribution_focus: "parameterized method comparison",
        limitation_or_caveat: "Small empirical scope",
        relation_to_study: "Provides a nearby comparison point."
      },
      {
        paper_id: "paper_2",
        title: "From Static to Adaptive: A Configurable Evaluation Dataset",
        source_type: "analyzed_paper",
        comparison_role: "supporting",
        method_family: "bounded adaptation",
        problem_focus:
          "From Static to Adaptive: A Configurable Evaluation Dataset Dana Example Evan Example Institute of Evaluation Institute of Eval...",
        setting_focus: "bounded adaptation",
        contribution_focus: "Evaluation dataset construction",
        limitation_or_caveat: "Metadata-only support",
        relation_to_study: "Provides background."
      },
      {
        paper_id: "paper_3",
        title: "Abstract-only fallback for a review of bounded search procedures",
        source_type: "analyzed_paper",
        comparison_role: "supporting",
        method_family: "literature discovery and retrieval",
        problem_focus: "This paper proposes a low-cost advising system for a specialized deployment context.",
        setting_focus: "resource-constrained deployment",
        contribution_focus: "Resource-constrained configuration application",
        limitation_or_caveat: "Different task setting",
        relation_to_study: "Provides background."
      },
      {
        paper_id: "paper_4",
        title: "Framework Delta: Tool Coordination",
        source_type: "analyzed_paper",
        comparison_role: "supporting",
        method_family: "stateful coordination",
        problem_focus: "Stateful coordination across external tools provides a contrasting systems axis.",
        setting_focus: "agent orchestration",
        contribution_focus: "Agent coordination",
        limitation_or_caveat: "Different task setting",
        relation_to_study: "Provides background."
      }
    ];
    bundle.relatedWorkScout = {
      query: "configured series dimension",
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
    expect(context.related_work.clusters).toEqual(expect.arrayContaining([
      "bounded adaptation",
      "literature discovery and retrieval",
      "stateful coordination"
    ]));

    const relatedText = scientific.draft.sections.find((section) => section.heading === "Related Work")?.paragraphs
      .map((paragraph) => paragraph.text)
      .join(" ") || "";
    expect(relatedText).not.toContain("Dana Example");
    expect(relatedText).not.toContain("Institute of Evaluation");
    expect(relatedText).not.toContain("- Primary metric:");
    expect(relatedText).not.toMatch(/comparison axes concern Recently,/i);
    expect(relatedText).toMatch(/literature discovery|stateful coordination/i);
    expect(relatedText).toContain("Stateful coordination across external tools provides a contrasting systems axis.");
    expect(relatedText).toMatch(/method family|resource budget|evaluation scope|bounded adaptation/i);
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
                        ? "The observed declared subject cleared the configured screening threshold by point estimate, but the result remains a follow-up signal rather than a stable success claim."
                      : index === 1 && section.heading === "Method"
                        ? "Workflow audit details describe an internal cached-target validation."
                      : index === 2 && section.heading === "Method"
                        ? "The evaluation spans Training: a fixed subset. Models or series include Primary trained baseline: series x with the same budget and configured_primary_baseline."
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
      keywords: ["declared comparison"],
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
    expect(restoredText).not.toContain("The prespecified baseline-relative primary-measure target was met");
    expect(restoredText).toContain("observed declared subject");
    expect(restoredText).not.toContain("validation_score");
    expect(restoredText).not.toContain("candidate_score");
    expect(restoredText).not.toContain("reference_score");
    expect(restoredText).not.toContain("Workflow audit details");
    expect(restoredText).not.toContain("Evaluation spans Training:");
    expect(restoredText).not.toContain("Models or series include Primary trained baseline");
    expect(restoredText).not.toContain("configured_primary_baseline");
    expect(restoredText).not.toMatch(/review gating|paper-readiness audit|result-table integrity/i);
    expect(restoredText).not.toMatch(/bounded claim ceiling|claim downgrade correctness/i);
  });
  it("does not restore prompt or cache residue while enforcing the final page floor", () => {
    const cachedRecoveryResidue = "Cache recovery note for an internal source snapshot.";
    const promptTopicResidue = [
      "Study how",
      "declared series interact during",
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
            { text: `${datasetLead} a symmetric primary-comparison point estimate across the two evaluation tasks.`, evidence_ids: [], citation_paper_ids: [] },
            { text: "The exposed comparison-level intervals remain wide, so the point estimate remains a screening signal.", evidence_ids: [], citation_paper_ids: [] }
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
    expect(resultText).not.toContain("primary-comparison point estimate");
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
              text: `The shared protocol fixes the configured comparison plan, seed handling, and evaluation tasks. ${draftFacingMethodSentence}`,
              evidence_ids: [],
              citation_paper_ids: []
            },
            {
              text: "The method still records enough information to identify the baseline, completed comparison records, data cap, and scoring convention.",
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
              text: "The results table keeps the baseline and declared subject visible while treating the observed gain as a screening signal.",
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
    expect(text).toContain("The shared protocol fixes the configured comparison plan");
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

  it("sanitizes provenance and uses direct run details without promoting unregistered metrics", () => {
    const bundle = makeRichBundle();
    bundle.latestResults = {
      selected_model: "candidate_model",
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
    } as any;

    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Bounded Declared Comparison",
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
    expect(methodText).toContain("Declared subject (comparator role)");
    expect(methodText).toMatch(/learning rate 0\.0003/i);
    expect(methodText).toMatch(/does not disclose optimizer/i);
    const numericIssues = result.consistency_lint.issues.filter(
      (issue) => ["numeric_inconsistency", "numeric_unverifiable"].includes(issue.kind)
    );
    expect(numericIssues).toEqual([]);
    expect(
      numericIssues.some(
        (issue) => issue.kind === "numeric_inconsistency" && issue.severity === "error"
      )
    ).toBe(false);
  });
  it("does not treat missing-setting prose as executed method detail coverage", () => {
    const bundle = makeRichBundle();
    bundle.runTitle = "bounded declared-series comparison";
    bundle.topic = "series effects under a fixed evaluation budget";
    bundle.objectiveMetric = "declared_measure_difference >= 0.05";
    bundle.experimentPlan = {
      selectedTitle: "declared comparison under a fixed budget",
      selectedSummary: "Compare declared series on two evaluation tasks.",
      rawText: [
        "selected_design:",
        '  title: "declared comparison under a fixed budget"',
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
      metric_table: [{ key: "declared_measure_difference", value: 0.075 }],
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
      title: "A Fixed-Budget Declared Comparison",
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
          paragraphs: ["The observed series merits follow-up."]
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
    expect(methodText).not.toContain("candidate_model");
    expect(methodText).toMatch(/per-device train batch size 2/i);
    expect(allText).toMatch(/does not disclose the instantiated model/i);
  });
  it("does not parse comma-separated seed-resampling counts as manuscript repeat counts", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Declared-Series Comparison",
      abstract: "A short abstract.",
      keywords: ["declared comparison"],
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
      title: "Repeated Declared-Series Comparison",
      abstract: "A short abstract.",
      keywords: ["declared comparison"],
      sections: baseSections.map((section) =>
        section.heading === "Results"
          ? {
              ...section,
              paragraphs: ["For Primary measure, the declared subject-minus-reference difference is 0.0260."]
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
    const numericUnverifiable = manuscript.consistency_lint.issues.filter(
      (issue) => issue.kind === "numeric_unverifiable"
    );
    expect(
      numericUnverifiable,
      JSON.stringify(numericUnverifiable, null, 2)
    ).toHaveLength(0);
  });

  it("does not treat objective threshold text as a measured result fact", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Declared-Series Comparison",
      abstract: "The writing objective remains metric_delta >= 0.02.",
      keywords: ["declared comparison"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: ["The paper positions itself around metric_delta >= 0.02 while keeping claims cautious."]
        },
        {
          heading: "Method",
          paragraphs: [
            "We evaluate 2 datasets with outer 5-fold CV and inner 3-fold tuning.",
            "A separate no-signal rule was specified for cases in which the maximum series spread stayed below 0.005 absolute primary measure or the available uncertainty evidence was inconclusive."
          ]
        },
        {
          heading: "Results",
          paragraphs: ["The observed primary measure delta vs declared reference is 0.026 across 2 datasets."]
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

    const thresholdFacts = manuscript.consistency_lint.issues
      .flatMap((issue) => issue.normalized_facts || [])
      .filter(
        (fact) =>
          [0.02, 0.005].includes(fact.normalized_value)
          && /objective|position|no-signal|boundary|rule|target|threshold/iu.test(fact.raw_text)
      );

    expect(thresholdFacts, JSON.stringify(thresholdFacts, null, 2)).toEqual([]);
  });

  it("does not treat seed and declared design values as measured metric facts", () => {
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
        "The protocol declared search values 4, 8, 16, and 32 plus auxiliary settings 0.0 and 0.05; the repeated design completed in 31.3 s.",
      keywords: ["parameterized method"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: ["This manuscript keeps design settings separate from measured outcomes."]
        },
        {
          heading: "Method",
          paragraphs: [
            "The primary factorial plan specified seed 42 and compared declared series settings under a fixed budget."
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
              && /declared search|auxiliary setting|seed/i.test(fact.raw_text)
          )
      )
    ).toHaveLength(0);
    expect(
      manuscript.consistency_lint.issues.filter(
        (issue) =>
          issue.kind === "numeric_inconsistency"
          && (issue.normalized_facts || []).some(
            (fact) =>
              fact.fact_kind === "metric"
              && [0, 0.05, 4, 8, 16, 32].includes(fact.value)
              && /declared search|auxiliary setting|design/i.test(fact.raw_text)
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

  it("flags conflicting canonical primary-difference claims at the declared scope", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Declared-Series Comparison",
      abstract: "For Primary measure, the declared subject-minus-reference difference is 0.012.",
      keywords: ["declared comparison"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: ["This benchmark studies repeated declared comparison."]
        },
        {
          heading: "Method",
          paragraphs: ["We evaluate 2 datasets with outer 5-fold CV and inner 3-fold tuning."]
        },
        {
          heading: "Results",
          paragraphs: ["For Primary measure, the declared subject-minus-reference difference is 0.026."]
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
    expect(numericIssue?.reason).toMatch(/structured numeric facts disagree|canonical facts disagree|main-manuscript sections/i);
  });

  it("rewrites over-strong performance claims when statistical support is missing", () => {
    const bundle = makeRichBundle();
    bundle.latestResults = {
      protocol: {
        datasets: ["evaluation_scope_alpha"],
        models: ["declared_reference", "declared_subject"]
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

  it("fills an evidence-rich terse draft to the six-page strict-paper floor without model repair", () => {
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
      title: "Repeated Declared-Series Comparison",
      abstract: "A short abstract.",
      keywords: ["declared comparison"],
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
      title: "Repeated Declared-Series Comparison",
      abstract: "For Primary measure, the declared subject-minus-reference difference is 0.2 across 8 datasets.",
      keywords: ["declared comparison"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: ["This benchmark studies repeated declared comparison."]
        },
        {
          heading: "Method",
          paragraphs: ["We evaluate 2 datasets with outer 5-fold CV and inner 3-fold tuning."]
        },
        {
          heading: "Results",
          paragraphs: ["For Primary measure, the declared subject-minus-reference difference is 0.026 across 2 datasets."]
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

  it("replaces an unmarked internal-token figure with the canonical comparison figure", () => {
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
      title: "Repeated Declared-Series Comparison",
      abstract: "A short abstract.",
      keywords: ["declared comparison"],
      sections: scientific.draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
      })),
      figures: [
        {
          caption: "Objective metric not met: metrics.tui_full_cycle_consistent_success_count=0 does not satisfy >= 1.",
          bars: [{ label: "evaluation_scope_alpha", value: 0 }]
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

    expect(manuscript.manuscript.figures?.[0]?.caption).toMatch(/declared primary comparison for Primary measure/i);
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
      title: "Repeated Declared-Series Comparison",
      abstract: "A short abstract.",
      keywords: ["declared comparison"],
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

  it("prunes an unmarked fallback figure and retains the canonical comparison figure", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Repeated Declared-Series Comparison",
      abstract: "A short abstract.",
      keywords: ["declared comparison"],
      sections: scientific.draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs: section.paragraphs.map((paragraph) => paragraph.text)
      })),
      tables: [
        {
          caption: "Selected reported metrics from the structured results analysis.",
          rows: [
            { label: "Primary measure", value: 0.91 },
            { label: "Replication Success Rate", value: 0.94 },
            { label: "Auxiliary measure", value: 0.88 }
          ]
        }
      ],
      figures: [
        {
          caption: "Objective metric met: primary_measure=0.91 >= 0.9.",
          bars: [
            { label: "Primary measure", value: 0.91 },
            { label: "Replication Success Rate", value: 0.94 },
            { label: "Auxiliary measure", value: 0.88 }
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
    expect(manuscript.manuscript.figures).toHaveLength(1);
    expect(manuscript.manuscript.figures?.[0]?.caption).toMatch(/declared primary comparison for Primary measure/i);
    expect(manuscript.manuscript.figures?.[0]?.bars.map((row) => row.observation_id)).toEqual(["observation_o1", "observation_o2"]);
  });

  it("downgrades numeric_inconsistency to warning when values differ by >50% (likely metric-key mismatch)", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    // Manuscript quotes a auxiliary score value (0.08) while structured results only have metric_score (0.026).
    // With bad metric_key assignment, both get key "metric_delta" and get compared.
    // The >50% delta heuristic should downgrade from error to warning.
    const candidate: PaperManuscript = {
      title: "Repeated Declared-Series Comparison",
      abstract: "The overall primary measure delta is 0.026.",
      keywords: ["declared comparison"],
      sections: [
        { heading: "Introduction", paragraphs: ["This benchmark studies repeated declared comparison."] },
        { heading: "Method", paragraphs: ["We evaluate 2 datasets with outer 5-fold CV and inner 3-fold tuning."] },
        {
          heading: "Results",
          paragraphs: [
            "The observed metric_delta is 0.026 on the strongest workflow.",
            "The auxiliary score metric_delta was 0.0008 for the declared series."
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
      title: "Repeated Measure Report",
      abstract:
        "The best overall configuration achieves mean primary measure 0.790455 " +
        "with a 95% confidence interval from 0.757351 to 0.819898.",
      keywords: ["repeatability"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study repeated measurement on a declared evaluation scope."] },
        { heading: "Method", paragraphs: ["We evaluate five declared scopes with a repeated measurement plan."] },
        {
          heading: "Results",
          paragraphs: [
            "The best aggregate configuration is the declared subject series. " +
            "Its mean primary measure is 0.790455, and the benchmark summary reports " +
            "a 95% interval from 0.757351 to 0.819898 for that configuration."
          ]
        },
        { heading: "Conclusion", paragraphs: ["Repeated evaluation preserves interval reporting."] }
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

  it("does not treat uncertainty summaries as conflicting primary-measure-difference means", () => {
    const bundle = makeRichBundle();
    bundle.objectiveMetric = "metric_delta >= 0.01";
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "metric_delta", value: 0.0375 },
        { key: "reported_metric_delta_mean", value: 0.0525 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Declared-Series Preflight",
      abstract: "The study-level delta relative to baseline was +0.0375.",
      keywords: ["configuration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a repeated-seed declared-series comparison."] },
        { heading: "Method", paragraphs: ["We compare an explicitly linked subject with its declared reference."] },
        {
          heading: "Results",
          paragraphs: [
            "The strongest cell achieved a mean primary-measure difference of +0.0525, or 5.25 percentage points. Its maximum observed seed-level delta was +0.1667 and its minimum was -0.0208, while the reported standard deviation was 0.0728 and the standard error was 0.0325."
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

  it("does not headline the study-level objective check as a conflicting series delta", () => {
    const bundle = makeRichBundle();
    bundle.objectiveMetric = "metric_delta >= 0.01";
    bundle.resultAnalysis = {
      ...(bundle.resultAnalysis as any),
      metric_table: [
        { key: "metric_delta", value: 0.0375 },
        { key: "reported_metric_delta_mean", value: 0.0525 }
      ]
    } as any;
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Declared-Series Preflight",
      abstract:
        "The study-level objective was met: the available summary reports metric_delta = 0.0375. The strongest summarized series was declared subject, with a mean delta of 0.0525.",
      keywords: ["configuration"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a repeated-seed declared-series comparison."] },
        { heading: "Method", paragraphs: ["We compare an explicitly linked subject with its declared reference."] },
        {
          heading: "Results",
          paragraphs: [
            "At the study level, the primary metric was metric_delta = 0.0375, which exceeded the predeclared target of 0.01.",
            "The strongest cell achieved a mean primary-measure difference of +0.0525, or 5.25 percentage points."
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
    expect(result.manuscript.abstract).not.toContain("metric_delta = 0.0375");
  });

  it("ignores an unmarked winner caption and derives the canonical comparison figure", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Declared-Series Preflight",
      abstract: "The study reports a bounded declared-series comparison.",
      keywords: ["declared comparison"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget declared-series preflight."] },
        { heading: "Method", paragraphs: ["The locked comparison row served as the comparison anchor."] },
        { heading: "Results", paragraphs: ["The reported comparison remains a bounded screening result."] },
        { heading: "Discussion", paragraphs: ["The comparison supports tied follow-up candidates."] },
        { heading: "Conclusion", paragraphs: ["The result identifies candidates for follow-up."] }
      ],
      figures: [
        {
          caption: "Scope-level score differences for the declared subject relative to the registered baseline; Table 1 identifies the archived reference series separately when applicable.",
          bars: [
            { label: "Evaluation Scope One task difference", value: 0.02 },
            { label: "Evaluation Scope Two task difference", value: 0.02 }
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

    expect(result.manuscript.figures?.[0]?.caption).toMatch(/declared primary comparison for Primary measure/i);
    expect(result.manuscript.figures?.[0]?.caption).not.toMatch(/the declared subject \(/i);
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
      title: "Declared-Series Preflight",
      abstract: "The study reports a bounded repeated-seed evaluation.",
      keywords: ["declared comparison"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a fixed-budget declared-series preflight."] },
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

  it("does not promote unregistered resource or auxiliary names to manuscript facts", () => {
    const bundle = makeRichBundle();
    const scientific = applyScientificWritingPolicy({
      draft: makeTerseDraft(),
      bundle,
      profile: PAPER_PROFILE
    });
    const candidate: PaperManuscript = {
      title: "Canonical Auxiliary Boundary",
      abstract: "A bounded canonical comparison.",
      keywords: ["comparison"],
      sections: scientific.draft.sections.map((section) => ({
        heading: section.heading,
        paragraphs:
          section.heading === "Results"
            ? [
                "The unregistered auxiliary_measure is 1.462, and hardware_allocation is 2684354560."
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

    const unregisteredFacts = result.consistency_lint.issues
      .flatMap((issue) => issue.normalized_facts || [])
      .filter((fact) => /auxiliary_measure|hardware_allocation/iu.test(fact.raw_text));
    expect(unregisteredFacts).toEqual([]);
    expect(JSON.stringify(result.consistency_lint.issues)).not.toMatch(/1\.462|2684354560/u);
    expect(
      result.manuscript.tables?.flatMap((table) => table.rows).map((row) => row.metric_id)
    ).toContain("metric_m1");
  });

  it("can re-apply evidence-grounded paper-scale strengthening after manuscript repair", () => {
    const bundle = makeRichBundle();
    const context = experimentArtifactLoader({ bundle });
    const repaired: PaperManuscript = {
      title: "Repeated Declared-Series Comparison",
      abstract: "The declared subject-reference difference is 0.026 points.",
      keywords: ["declared comparison"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study a declared comparison under a fixed budget."] },
        { heading: "Related Work", paragraphs: ["Repeated evaluation motivates the comparison design."] },
        { heading: "Method", paragraphs: ["The protocol links one subject and one reference through an explicit metric and scope."] },
        { heading: "Results", paragraphs: ["The declared subject has a positive primary-measure difference."] },
        { heading: "Discussion", paragraphs: ["The result is a follow-up signal rather than a broad conclusion."] },
        { heading: "Limitations", paragraphs: ["The declared evaluation scope is narrow."] },
        { heading: "Conclusion", paragraphs: ["The declared comparison merits replication."] }
      ]
    };

    const strengthened = strengthenPaperScaleManuscript(repaired, context);
    const resultsWords = strengthened.sections
      .find((section) => section.heading === "Results")
      ?.paragraphs.join(" ").split(/\s+/u).length || 0;

    expect(resultsWords).toBeGreaterThan(0);
    expect(strengthened.sections.find((section) => section.heading === "Limitations")?.paragraphs.length).toBeGreaterThan(0);
  });

  it("sanitizes reader-facing provenance and claim-boundary terms", () => {
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
            "The reported comparison is limited to the declared evaluation scope."
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
    expect(text).toContain("limited to the declared evaluation scope");
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
        { heading: "Introduction", paragraphs: ["We compare bounded series."] },
        {
          heading: "Method",
          paragraphs: [
            "Resource diagnostics are explicitly measured in the evaluation outputs.",
            "The fixed search space is the declared comparison plan described above."
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
            "The reported comparison is limited to the declared evaluation scope."
          ]
        },
        { heading: "Conclusion", paragraphs: ["The declared subject merits replication."] }
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
          paragraphs: ["Supplementary setup details describe the repeated comparison plan."]
        },
        {
          heading: "Supplementary Experimental Details",
          paragraphs: ["Supplementary setup details describe the repeated comparison plan."]
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
    // Manuscript text mentions "20,789 records" — previously the regex split
    // this into "20" and "789", and "789" was close enough to runtime_seconds
    // (828.56) to produce a blocking "contradiction" error.
    const candidate: PaperManuscript = {
      title: "Comma-Separated Count Study",
      abstract: "The declared series processed 20,789 records in total.",
      keywords: ["count parsing"],
      sections: [
        { heading: "Introduction", paragraphs: ["We study count reporting in repeated evaluation."] },
        { heading: "Method", paragraphs: ["We evaluate 2 datasets with outer 5-fold CV and inner 3-fold tuning."] },
        {
          heading: "Results",
          paragraphs: [
            "The declared series processed 20,789 records in total, " +
            "while the reference series processed 19,002 records. " +
            "Average latency rose from 736.84 ms to 828.56 ms."
          ]
        },
        { heading: "Conclusion", paragraphs: ["The reported count difference remains modest."] }
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
