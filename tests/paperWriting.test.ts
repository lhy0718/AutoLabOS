import { describe, expect, it } from "vitest";

import {
  buildPaperWriterPrompt,
  buildRelatedWorkBrief,
  buildRelatedWorkNotes,
  PaperWritingBundle,
  validatePaperDraft,
  renderPaperTex
} from "../src/core/analysis/paperWriting.js";
import { buildHeuristicObjectiveMetricProfile } from "../src/core/objectiveMetric.js";
import { buildHeuristicConstraintProfile } from "../src/core/runConstraints.js";

function makeBundle(): PaperWritingBundle {
  return {
    runTitle: "Related Work Upgrade",
    topic: "agent collaboration",
    objectiveMetric: "reproducibility_score >= 0.8",
    constraints: ["formal tone"],
    paperSummaries: [
      {
        paper_id: "paper_1",
        title: "Stateful Agent Coordination",
        source_type: "full_text",
        summary: "Stateful coordination improves revision stability in collaborative agents.",
        key_findings: ["Stateful coordination improves revision stability."],
        limitations: ["Evaluation uses a small benchmark."],
        datasets: ["AgentBench-mini"],
        metrics: ["reproducibility_score"],
        novelty: "Stateful coordination for agent workflows",
        reproducibility_notes: ["Repeated trials are reported."]
      },
      {
        paper_id: "paper_2",
        title: "Benchmarking Multi-Agent Workflows",
        source_type: "full_text",
        summary: "Benchmark studies compare orchestration strategies across workflow settings.",
        key_findings: ["Benchmarking clarifies tradeoffs across orchestration strategies."],
        limitations: ["Coverage across domains remains limited."],
        datasets: ["WorkflowArena"],
        metrics: ["stability_score"],
        novelty: "Evaluation and benchmarking for workflow orchestration",
        reproducibility_notes: ["The benchmark is limited to a few domains."]
      }
    ],
    evidenceRows: [
      {
        evidence_id: "ev_1",
        paper_id: "paper_1",
        claim: "Stateful coordination improves revision stability.",
        method_slot: "stateful coordination",
        result_slot: "higher reproducibility_score",
        limitation_slot: "small benchmark",
        dataset_slot: "AgentBench-mini",
        metric_slot: "reproducibility_score",
        evidence_span: "Repeated trials improved reproducibility_score.",
        source_type: "full_text",
        confidence: 0.92
      }
    ],
    hypotheses: [
      {
        hypothesis_id: "h_1",
        text: "Stateful coordination improves reproducibility in agent collaboration workflows.",
        evidence_links: ["ev_1"],
        measurement_hint: "Track reproducibility_score over repeated runs."
      }
    ],
    corpus: [
      {
        paper_id: "paper_1",
        title: "Stateful Agent Coordination",
        authors: ["Alice Doe"],
        abstract: "Stateful coordination improves revision stability in collaborative agents.",
        venue: "ACL",
        year: 2025,
        citation_count: 42
      },
      {
        paper_id: "paper_2",
        title: "Benchmarking Multi-Agent Workflows",
        authors: ["Bob Doe"],
        abstract: "Benchmark studies compare orchestration strategies across workflow settings.",
        venue: "EMNLP",
        year: 2024,
        citation_count: 35
      },
      {
        paper_id: "paper_scout_1",
        title: "Related Work Coverage Backfill",
        authors: ["Sam Scout"],
        abstract: "Scout metadata broadens the related-work framing for agent collaboration.",
        venue: "NAACL",
        year: 2024,
        citation_count: 18
      }
    ],
    experimentPlan: {
      selectedTitle: "Thread-backed drafting benchmark",
      selectedSummary: "Compare stateful and stateless coordination strategies."
    },
    relatedWorkScout: {
      query: "agent collaboration thread-backed drafting benchmark reproducibility_score",
      rationale: "Backfill thin related-work coverage around stateful coordination and benchmarking.",
      papers: [
        {
          paper_id: "paper_scout_1",
          title: "Related Work Coverage Backfill",
          summary: "Scout metadata broadens the related-work framing for agent collaboration.",
          source_type: "semantic_scholar_scout",
          venue: "NAACL",
          year: 2024,
          citation_count: 18
        }
      ]
    }
  };
}

function parsePromptContext(prompt: string): Record<string, unknown> {
  const marker = "Context JSON:\n";
  const markerIndex = prompt.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  return JSON.parse(prompt.slice(markerIndex + marker.length)) as Record<string, unknown>;
}

describe("paperWriting related-work support", () => {
  it("keeps paper-writer prompts compact when result analysis carries large raw metrics", () => {
    const bundle = makeBundle();
    bundle.resultAnalysis = {
      analysis_version: 1,
      generated_at: "2026-05-07T00:00:00.000Z",
      mean_score: 0.51,
      metrics: {
        huge_raw_condition_blob: "x".repeat(1_200_000),
        quality_delta_vs_reference_mean: 0.0667
      },
      objective_metric: {
        raw: "mean outcome quality",
        evaluation: {
          status: "met",
          summary: "Mean outcome quality changed by 0.0667.",
          observedValue: 0.0667,
          targetValue: 0.01,
          matchedMetricKey: "quality_delta_vs_reference_mean"
        },
        profile: {
          source: "brief",
          primary_metric: "quality_delta_vs_reference_mean",
          preferred_metric_keys: ["quality_delta_vs_reference_mean"],
          analysis_focus: ["explicit reference comparison"],
          paper_emphasis: ["bounded claim"],
          assumptions: []
        }
      },
      overview: {
        objective_status: "met",
        objective_summary: "All declared repeated runs completed.",
        matched_metric_key: "quality_delta_vs_reference_mean",
        observed_value: 0.0667,
        target_description: ">= 0.01",
        selected_design_title: "Repeated comparison under a fixed protocol",
        execution_runs: 25
      },
      plan_context: {
        selected_design: {
          title: "Repeated comparison under a fixed protocol",
          summary: "Compare two declared series through explicit observation references."
        }
      },
      metric_table: [
        {
          key: "quality_delta_vs_reference_mean",
          value: 0.0667,
          label: "quality_delta_vs_reference_mean"
        }
      ],
      results_artifact: {
        schema_version: "2.0",
        metrics: [
          {
            id: "metric-quality",
            label: "Mean outcome quality",
            direction: "higher_better",
            unit: "ratio"
          }
        ],
        series: [
          {
            id: "series-zeta",
            label: "Zeta-labelled series",
            role: "baseline",
            dimensions: { partition: "evaluation", repetitions: 5 }
          },
          {
            id: "series-alpha",
            label: "Alpha-labelled series",
            role: "primary",
            dimensions: { partition: "evaluation", repetitions: 5 }
          }
        ],
        observations: [
          {
            id: "observation-zeta-quality",
            series_id: "series-zeta",
            metric_id: "metric-quality",
            scope: { partition: "evaluation" },
            value: 0.51,
            evidence_refs: ["artifacts/observations/zeta.json"]
          },
          {
            id: "observation-alpha-quality",
            series_id: "series-alpha",
            metric_id: "metric-quality",
            scope: { partition: "evaluation" },
            value: 0.5767,
            evidence_refs: ["artifacts/observations/alpha.json"]
          }
        ],
        comparisons: [
          {
            id: "comparison-explicit-quality",
            subject_observation_id: "observation-alpha-quality",
            reference_observation_id: "observation-zeta-quality",
            delta: 0.0667,
            judgement: "higher observed value",
            evidence_refs: ["artifacts/comparisons/quality.json"]
          }
        ]
      },
      primary_comparison_id: "comparison-explicit-quality",
      condition_comparisons: [],
      execution_summary: {
        observations: [],
        observation_count: 25,
        success_count: 25,
        failure_count: 0
      },
      primary_findings: ["The explicitly referenced subject observation is higher than its reference."],
      limitations: ["The study is scoped to a bounded evaluation slice."],
      warnings: [],
      paper_claims: [
        {
          claim_id: "claim_1",
          statement: "The declared subject-reference comparison has a positive delta in this bounded run.",
          evidence: ["artifacts/comparisons/quality.json"],
          strength: "moderate"
        }
      ],
      figure_specs: [],
      supplemental_runs: [],
      external_comparisons: [],
      statistical_summary: {
        total_trials: 25,
        executed_trials: 25,
        cached_trials: 0,
        notes: ["Five seeds per condition were executed."]
      },
      failure_taxonomy: [],
      synthesis: {
        discussion_points: ["The claim remains scoped to the declared evaluation budget."],
        failure_analysis: [],
        confidence_statement: "Moderate confidence under the bounded run scope."
      }
    } as any;

    const prompt = buildPaperWriterPrompt({
      bundle,
      constraintProfile: {
        writing: {
          targetVenue: "workshop",
          toneHint: "cautious",
          lengthHint: "full paper"
        },
        experiment: {
          designNotes: "Use repeated seeds.",
          evaluationNotes: "Report baseline and comparator."
        }
      } as any,
      objectiveMetricProfile: {
        source: "brief",
        primaryMetric: "quality_delta_vs_reference_mean",
        targetDescription: ">= 0.01",
        analysisFocus: ["explicit reference comparison"],
        paperEmphasis: ["bounded claim"],
        assumptions: []
      } as any
    });

    const context = parsePromptContext(prompt);
    const resultAnalysis = context.result_analysis as Record<string, unknown>;
    expect(resultAnalysis).not.toHaveProperty("condition_comparisons");
    const resultsArtifact = resultAnalysis.results_artifact as {
      metrics: Array<Record<string, unknown>>;
      series: Array<Record<string, unknown>>;
      observations: Array<Record<string, unknown>>;
      comparisons: Array<Record<string, unknown>>;
    };

    expect(prompt.length).toBeLessThan(60_000);
    expect(resultAnalysis).not.toHaveProperty("results_table");
    expect(resultsArtifact.metrics).toEqual([
      {
        id: "metric-quality",
        label: "Mean outcome quality",
        direction: "higher_better",
        unit: "ratio"
      }
    ]);
    expect(resultsArtifact.series.map((item) => item.role)).toEqual([
      "baseline",
      "primary"
    ]);
    expect(resultsArtifact.observations.map((item) => item.evidence_refs)).toEqual([
      ["artifacts/observations/zeta.json"],
      ["artifacts/observations/alpha.json"]
    ]);
    expect(resultsArtifact.comparisons).toEqual([
      expect.objectContaining({
        id: "comparison-explicit-quality",
        subject_observation_id: "observation-alpha-quality",
        reference_observation_id: "observation-zeta-quality",
        delta: 0.0667,
        evidence_refs: ["artifacts/comparisons/quality.json"]
      })
    ]);
    expect(prompt).toContain("raw_metrics_omitted");
    expect(prompt).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  });

  it("builds structured related-work notes and a two-paragraph brief", () => {
    const bundle = makeBundle();

    const notes = buildRelatedWorkNotes(bundle);
    const brief = buildRelatedWorkBrief(bundle);

    expect(notes).toHaveLength(3);
    expect(notes.some((item) => item.comparison_role === "closest")).toBe(true);
    expect(brief.comparison_axes.length).toBeGreaterThan(0);
    expect(brief.paragraph_plan).toHaveLength(2);
  });

  it("reconstructs a missing Related Work section from structured notes", () => {
    const bundle = makeBundle();

    const validation = validatePaperDraft({
      bundle,
      draft: {
        title: "A Draft Without Related Work",
        abstract: "A minimal draft.",
        keywords: ["agent collaboration"],
        sections: [
          {
            heading: "Introduction",
            paragraphs: [
              {
                text: "This study evaluates stateful coordination for agent collaboration.",
                evidence_ids: ["ev_1"],
                citation_paper_ids: ["paper_1"]
              }
            ],
            evidence_ids: ["ev_1"],
            citation_paper_ids: ["paper_1"]
          },
          {
            heading: "Method",
            paragraphs: [
              {
                text: "The benchmark compares stateful and stateless coordination.",
                evidence_ids: ["ev_1"],
                citation_paper_ids: ["paper_1"]
              }
            ],
            evidence_ids: ["ev_1"],
            citation_paper_ids: ["paper_1"]
          },
          {
            heading: "Results",
            paragraphs: [
              {
                text: "Stateful coordination improved reproducibility_score.",
                evidence_ids: ["ev_1"],
                citation_paper_ids: ["paper_1"]
              }
            ],
            evidence_ids: ["ev_1"],
            citation_paper_ids: ["paper_1"]
          }
        ],
        claims: []
      }
    });

    const relatedWork = validation.draft.sections.find((item) => item.heading === "Related Work");
    expect(relatedWork).toBeDefined();
    expect(relatedWork?.paragraphs).toHaveLength(2);
    expect(relatedWork?.citation_paper_ids).toEqual(
      expect.arrayContaining(["paper_1", "paper_2", "paper_scout_1"])
    );
    expect(validation.issues.some((item) => /reconstructed from related-work notes/i.test(item.message))).toBe(true);
  });

  it("replaces related-work paragraphs that leak bibliography text or metric bullet lists", () => {
    const bundle = makeBundle();
    bundle.relatedWorkScout = {
      query: "parameterized method",
      rationale: "Exercise bibliography spillover filtering.",
      papers: [
        {
          paper_id: "paper_scout_1",
          title: "From Base to Conversational: Japanese Instruction Dataset and Tuning Large Language Models",
          summary:
            "From Base to Conversational: Japanese Instruction Dataset and Tuning Large Language Models Masahiro Suzuki Masanori Hirano Hiroki Sakaji The University of Tokyo The University o...",
          source_type: "semantic_scholar_scout",
          venue: "BigData",
          year: 2023,
          citation_count: 18
        }
      ]
    };

    const validation = validatePaperDraft({
      bundle,
      draft: {
        title: "Bibliography Spillover Draft",
        abstract: "A minimal draft.",
        keywords: ["agent collaboration"],
        sections: [
          {
            heading: "Related Work",
            paragraphs: [
              {
                text: "Related work clusters around prompting and control. The most relevant comparison axes concern Recently, large language models with conversational-style interaction, such as ChatGPT and Claude, have gained significant importance in the advancement of artificial gen..., From Base to Conversational: Japanese Instruction Dataset and Tuning Large Language Models Masahiro Suzuki Masanori Hirano Hiroki Sakaji The University of Tokyo The University o..., and This paper proposes a low-cost educational advising LLM for study-abroad contexts.",
                evidence_ids: ["ev_1"],
                citation_paper_ids: ["paper_1"]
              },
              {
                text: "The closest prior work includes Chain-of-Adapters. The present paper positions itself around - Primary metric: average accuracy across Benchmark Task A and Benchmark Task B. - Secondary metrics: per-task accuracy and runtime. while keeping claims limited to the available artifacts.",
                evidence_ids: ["ev_1"],
                citation_paper_ids: ["paper_2"]
              }
            ],
            evidence_ids: ["ev_1"],
            citation_paper_ids: ["paper_1", "paper_2"]
          }
        ],
        claims: []
      }
    });

    const relatedWork = validation.draft.sections.find((item) => item.heading === "Related Work");
    const serialized = JSON.stringify(relatedWork);
    expect(serialized).not.toContain("Masahiro Suzuki");
    expect(serialized).not.toContain("The University of Tokyo");
    expect(serialized).not.toContain("- Primary metric:");
    expect(serialized).toContain("Prior work");
    expect(validation.issues.some((item) => /bibliographic.*spillover/i.test(item.message))).toBe(true);
  });

  it("uses first-citation bibliography ordering in TeX compatibility fallback", () => {
    const tex = renderPaperTex({
      runTitle: "Neutral Paper",
      topic: "neutral evaluation",
      objectiveMetric: "quality >= 0.8",
      draft: {
        title: "Neutral Paper",
        abstract: "A concise abstract.",
        keywords: [],
        sections: [
          {
            heading: "Related Work",
            paragraphs: [
              {
                text: "Prior work motivates the evaluation setting.",
                evidence_ids: [],
                citation_paper_ids: ["paper_1"]
              }
            ],
            evidence_ids: [],
            citation_paper_ids: ["paper_1"]
          }
        ],
        claims: []
      },
      constraintProfile: buildHeuristicConstraintProfile([]),
      objectiveMetricProfile: buildHeuristicObjectiveMetricProfile("quality >= 0.8"),
      constraints: [],
      citationKeysByPaperId: new Map([["paper_1", "doe_2025_method"]])
    });

    expect(tex).toContain("\\bibliographystyle{unsrt}");
    expect(tex).not.toContain("\\bibliographystyle{plain}");
  });
});
