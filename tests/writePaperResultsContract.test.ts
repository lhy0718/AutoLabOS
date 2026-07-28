import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PaperManuscript } from "../src/core/analysis/paperManuscript.js";
import type { AnalysisReport } from "../src/core/resultAnalysis.js";
import type { ResultsArtifactV2 } from "../src/core/analysis/resultsTableSchema.js";
import {
  adaptHistoricalWritePaperResultForReadOnlyContext,
  buildValidatedWritePaperAnalysisProjection,
  buildPythonVectorFigureRendererScript,
  buildWritePaperFigurePayload,
  buildWritePaperResultsInput,
  resolveWritePaperResultsContract,
  type WritePaperResultsContract
} from "../src/core/nodes/writePaper.js";

function buildArtifact(): ResultsArtifactV2 {
  return {
    schema_version: "2.0",
    metrics: [
      {
        id: "metric-quality",
        label: "Quality measure",
        direction: "higher_better",
        unit: "points"
      },
      {
        id: "metric-resource",
        label: "Resource measure",
        direction: "lower_better",
        unit: "credits"
      }
    ],
    series: [
      {
        id: "series-subject",
        label: "Configured subject",
        role: "primary",
        dimensions: { split: "evaluation" }
      },
      {
        id: "series-reference",
        label: "Declared reference",
        role: "baseline",
        dimensions: { split: "evaluation" }
      }
    ],
    observations: [
      {
        id: "observation-quality-subject",
        series_id: "series-subject",
        metric_id: "metric-quality",
        scope: { partition: "held_out" },
        value: 0.42,
        evidence_refs: ["artifact:quality-subject"]
      },
      {
        id: "observation-quality-reference",
        series_id: "series-reference",
        metric_id: "metric-quality",
        scope: { partition: "held_out" },
        value: 0.58,
        evidence_refs: ["artifact:quality-reference"]
      },
      {
        id: "observation-resource-subject",
        series_id: "series-subject",
        metric_id: "metric-resource",
        scope: { partition: "held_out" },
        value: 14
      },
      {
        id: "observation-resource-reference",
        series_id: "series-reference",
        metric_id: "metric-resource",
        scope: { partition: "held_out" },
        value: 11
      }
    ],
    comparisons: [
      {
        id: "comparison-resource",
        subject_observation_id: "observation-resource-subject",
        reference_observation_id: "observation-resource-reference",
        delta: 3
      },
      {
        id: "comparison-quality",
        subject_observation_id: "observation-quality-subject",
        reference_observation_id: "observation-quality-reference",
        delta: -0.16
      }
    ]
  };
}

function requireContract(): WritePaperResultsContract {
  const resolution = resolveWritePaperResultsContract({
    results_artifact: buildArtifact(),
    primary_comparison_id: "comparison-quality"
  });
  if (!resolution.ok) {
    throw new Error(resolution.issues.join(" "));
  }
  return resolution.contract;
}

function buildManuscript(contract: WritePaperResultsContract): PaperManuscript {
  const primary = contract.primary;
  return {
    title: "Declared Comparison Study",
    abstract: "A bounded comparison.",
    keywords: ["comparison"],
    sections: [],
    figures: [
      {
        caption: "Untrusted authored caption",
        bars: [
          {
            label: "Reference row supplied first",
            value: primary.referenceObservation.value,
            comparison_id: primary.comparison.id,
            observation_id: primary.referenceObservation.id,
            metric_id: primary.metric.id,
            series_id: primary.referenceSeries.id,
            series_role: primary.referenceSeries.role,
            comparison_side: "reference"
          },
          {
            label: "Subject row supplied second",
            value: primary.subjectObservation.value,
            comparison_id: primary.comparison.id,
            observation_id: primary.subjectObservation.id,
            metric_id: primary.metric.id,
            series_id: primary.subjectSeries.id,
            series_role: primary.subjectSeries.role,
            comparison_side: "subject"
          }
        ]
      }
    ]
  };
}

describe("writePaper V2 results contract", () => {
  it("selects the declared primary comparison instead of array position or observed value", () => {
    const resolution = resolveWritePaperResultsContract({
      results_artifact: buildArtifact(),
      primary_comparison_id: "comparison-quality"
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.contract.primaryComparisonId).toBe("comparison-quality");
    expect(resolution.contract.primary.metric).toMatchObject({
      id: "metric-quality",
      direction: "higher_better",
      unit: "points"
    });
    expect(resolution.contract.primary.subjectObservation.value).toBe(0.42);
    expect(resolution.contract.primary.referenceObservation.value).toBe(0.58);
  });

  it("fails closed when primary_comparison_id is missing, including for one comparison", () => {
    const multiple = resolveWritePaperResultsContract({
      results_artifact: buildArtifact()
    });
    const singletonArtifact = buildArtifact();
    singletonArtifact.comparisons = singletonArtifact.comparisons.filter(
      (comparison) => comparison.id === "comparison-quality"
    );
    const singleton = resolveWritePaperResultsContract({
      results_artifact: singletonArtifact
    });

    for (const resolution of [multiple, singleton]) {
      expect(resolution.ok).toBe(false);
      expect(resolution.issues).toContain(
        "AnalysisReport.primary_comparison_id is required when results_artifact.comparisons includes one or more comparisons."
      );
    }
  });

  it("fails closed when primary_comparison_id references an unknown comparison", () => {
    const resolution = resolveWritePaperResultsContract({
      results_artifact: buildArtifact(),
      primary_comparison_id: "comparison-unknown"
    });

    expect(resolution.ok).toBe(false);
    expect(resolution.issues).toContain(
      'AnalysisReport.primary_comparison_id references unknown comparison id "comparison-unknown" in results_artifact.comparisons.'
    );
  });

  it("fails closed when compared series roles, units, or scopes are incomplete", () => {
    const missingRole = buildArtifact();
    delete missingRole.series[0].role;
    expect(resolveWritePaperResultsContract({
      results_artifact: missingRole,
      primary_comparison_id: "comparison-quality"
    })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.stringContaining("requires subject series role primary or comparator")
      ])
    });

    const missingUnit = buildArtifact();
    delete missingUnit.metrics[0].unit;
    expect(resolveWritePaperResultsContract({
      results_artifact: missingUnit,
      primary_comparison_id: "comparison-quality"
    })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.stringContaining("results_artifact.metrics[0].unit")
      ])
    });

    const mismatchedScope = buildArtifact();
    mismatchedScope.observations[1].scope = { partition: "development" };
    expect(resolveWritePaperResultsContract({
      results_artifact: mismatchedScope,
      primary_comparison_id: "comparison-quality"
    })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.stringContaining("must declare the same scope")
      ])
    });
  });

  it("does not promote a historical loose table into a paper comparison contract", () => {
    const resolution = resolveWritePaperResultsContract({
      results_table: [
        {
          metric: "quality_measure",
          baseline: 0.5,
          comparator: 0.6,
          delta: 0.1,
          direction: "higher_better"
        }
      ]
    });

    expect(resolution).toEqual({
      ok: false,
      issues: [
        "AnalysisReport.results_artifact must be supplied explicitly for quantitative paper claims."
      ]
    });
  });

  it("bounds historical read compatibility to non-claim context", () => {
    const adapted = adaptHistoricalWritePaperResultForReadOnlyContext(JSON.stringify({
      analysis_version: 1,
      generated_at: "2026-01-01T00:00:00.000Z",
      mean_score: 0.91,
      metrics: { quality_measure: 0.91 },
      objective_metric: {
        raw: "",
        evaluation: { profileSource: "heuristic_fallback" },
        profile: { source: "heuristic_fallback" }
      },
      overview: { selected_design_title: "Bounded study" },
      plan_context: { design_notes: ["Fixed protocol"] },
      execution_summary: { observation_count: 2, commands: ["run"], sources: ["run.json"] },
      results_table: [
        {
          metric: "quality_measure",
          baseline: 0.4,
          comparator: 0.91,
          delta: 0.51,
          direction: "higher_better"
        }
      ],
      primary_findings: ["Unsupported quantitative finding"],
      paper_claims: [{ claim: "Unsupported quantitative claim", evidence: ["loose-table"] }],
      figure_specs: [{ id: "result-figure", metric_keys: ["quality_measure"] }]
    }));

    expect(adapted).toBeDefined();
    expect(adapted?.results_artifact).toEqual({
      schema_version: "2.0",
      metrics: [],
      series: [],
      observations: [],
      comparisons: []
    });
    expect(adapted?.metric_table).toEqual([]);
    expect(adapted?.primary_findings).toEqual([]);
    expect(adapted?.paper_claims).toEqual([]);
    expect(adapted?.figure_specs).toEqual([]);
    expect(adapted?.statistical_summary.effect_estimates).toEqual([]);
    expect(JSON.stringify(adapted)).not.toMatch(
      /quality_measure|Unsupported quantitative|result-figure|loose-table/u
    );
  });

  it("projects only the selected comparison and its explicit semantics into paper input", () => {
    const input = buildWritePaperResultsInput(requireContract());
    const artifact = input.results_artifact as ResultsArtifactV2;

    expect(input.primary_comparison_id).toBe("comparison-quality");
    expect(input.metric_definition).toMatchObject({
      id: "metric-quality",
      direction: "higher_better",
      unit: "points"
    });
    expect(input.subject_series).toMatchObject({ id: "series-subject", role: "primary" });
    expect(input.reference_series).toMatchObject({ id: "series-reference", role: "baseline" });
    expect(artifact.comparisons.map((item) => item.id)).toEqual(["comparison-quality"]);
    expect(artifact.metrics.map((item) => item.id)).toEqual(["metric-quality"]);
    expect(artifact.observations.map((item) => item.id)).toEqual([
      "observation-quality-subject",
      "observation-quality-reference"
    ]);
  });

  it("preserves analysis evidence and meaning while narrowing only primary-bound comparisons", () => {
    const contract = requireContract();
    const report = {
      analysis_version: 1,
      generated_at: "2026-01-02T00:00:00.000Z",
      mean_score: 0.42,
      metrics: { source_marker: "preserve-original-metrics" },
      objective_metric: {
        raw: "quality measure >= 0.8",
        evaluation: {
          rawObjectiveMetric: "quality measure >= 0.8",
          profileSource: "heuristic_fallback",
          primaryMetric: "metric-quality",
          preferredMetricKeys: ["metric-quality"],
          matchedMetricKey: "metric-quality",
          direction: "maximize",
          comparator: ">=",
          targetValue: 0.8,
          unit: "points",
          observedValue: 0.42,
          status: "not_met",
          summary: "The declared target was not met."
        },
        profile: {
          source: "heuristic_fallback",
          primary_metric: "metric-quality",
          preferred_metric_keys: ["metric-quality"],
          analysis_focus: ["Retain the target comparison."],
          paper_emphasis: ["Report the negative result."],
          assumptions: ["No target reinterpretation."]
        }
      },
      results_plan: {
        schema_version: "2.0",
        required_metrics: buildArtifact().metrics,
        minimum_series_count: 2,
        minimum_comparison_count: 2,
        required_series: [
          { id: "series-subject", role: "primary" },
          { id: "series-reference", role: "baseline" }
        ],
        required_comparisons: [
          {
            id: "comparison-quality",
            subject_series_id: "series-subject",
            reference_series_id: "series-reference",
            metric_id: "metric-quality"
          },
          {
            id: "comparison-resource",
            subject_series_id: "series-subject",
            reference_series_id: "series-reference",
            metric_id: "metric-resource"
          }
        ],
        primary_comparison_id: "comparison-quality",
        primary_effect_criterion: {
          comparison_id: "comparison-quality",
          metric_id: "metric-quality",
          metric_scale: "raw",
          direction: "maximize",
          effect_criterion: { operator: ">=", magnitude: 0.1 }
        }
      },
      overview: {
        objective_status: "not_met",
        objective_summary: "The declared target was not met.",
        matched_metric_key: "metric-quality",
        observed_value: 0.42,
        execution_runs: 4
      },
      plan_context: {
        shortlisted_designs: [],
        design_notes: ["Preserve the preregistered target."],
        implementation_notes: [],
        evaluation_notes: [],
        assumptions: []
      },
      metric_table: [{ key: "metric-quality", value: 0.42 }],
      results_artifact: buildArtifact(),
      primary_comparison_id: "comparison-quality",
      condition_comparisons: [
        {
          id: "comparison-quality",
          label: "Existing quality comparison",
          source: "results_artifact",
          metrics: [],
          summary: "Existing primary comparison summary."
        },
        {
          id: "comparison-resource",
          label: "Existing resource comparison",
          source: "results_artifact",
          metrics: [],
          summary: "Existing secondary comparison summary."
        }
      ],
      execution_summary: {
        observation_count: 4,
        commands: ["run declared experiment"],
        sources: ["metrics.json"],
        stderr_excerpts: []
      },
      primary_findings: ["Existing target-not-met finding."],
      limitations: ["Existing sample-size limitation."],
      warnings: ["Existing calibration warning."],
      paper_claims: [
        {
          claim: "Existing bounded claim; do not replace it.",
          evidence: ["result_analysis.json#/paper_claims/0"]
        }
      ],
      figure_specs: [],
      supplemental_runs: [],
      external_comparisons: [],
      statistical_summary: {
        total_trials: 4,
        executed_trials: 4,
        cached_trials: 0,
        confidence_intervals: [
          {
            metric_key: "metric-quality",
            label: "Existing interval",
            lower: 0.31,
            upper: 0.53,
            level: 0.95,
            sample_size: 4,
            source: "metrics",
            summary: "Existing confidence interval summary."
          }
        ],
        stability_metrics: [{ key: "quality_stability", value: 0.12 }],
        effect_estimates: [
          {
            comparison_id: "comparison-quality",
            metric_key: "metric-quality",
            delta: -0.15,
            direction: "negative",
            summary: "Existing rounded primary effect estimate."
          },
          {
            comparison_id: "comparison-resource",
            metric_key: "metric-resource",
            delta: 3,
            direction: "negative",
            summary: "Existing secondary effect estimate."
          }
        ],
        notes: ["Existing statistical caution."]
      },
      failure_taxonomy: [
        {
          id: "objective-gap",
          category: "objective_gap",
          severity: "high",
          status: "observed",
          summary: "The preregistered target was not met.",
          evidence: ["objective_metric.evaluation"]
        }
      ],
      transition_recommendation: {
        action: "backtrack_to_hypotheses",
        sourceNode: "analyze_results",
        targetNode: "generate_hypotheses",
        reason: "The declared target was not met.",
        confidence: 0.91,
        autoExecutable: true,
        evidence: ["objective_metric.evaluation.status=not_met"],
        suggestedCommands: ["/agent jump generate_hypotheses"],
        generatedAt: "2026-01-02T00:00:00.000Z"
      }
    } as unknown as AnalysisReport;
    const original = structuredClone(report);

    const projected = buildValidatedWritePaperAnalysisProjection(report, contract);

    expect(report).toEqual(original);
    expect(projected.metrics).toEqual(report.metrics);
    expect(projected.objective_metric).toEqual(report.objective_metric);
    expect(projected.overview).toEqual(report.overview);
    expect(projected.overview.objective_status).toBe("not_met");
    expect(projected.primary_findings).toEqual(report.primary_findings);
    expect(projected.limitations).toEqual(report.limitations);
    expect(projected.warnings).toEqual(report.warnings);
    expect(projected.paper_claims).toEqual(report.paper_claims);
    expect(projected.failure_taxonomy).toEqual(report.failure_taxonomy);
    expect(projected.transition_recommendation).toEqual(report.transition_recommendation);
    expect(projected.results_artifact.metrics).toEqual(report.results_artifact.metrics);
    expect(projected.results_artifact.series).toEqual(report.results_artifact.series);
    expect(projected.results_artifact.observations).toEqual(report.results_artifact.observations);
    expect(projected.results_artifact.comparisons.map((item) => item.id)).toEqual([
      "comparison-quality"
    ]);
    expect(projected.condition_comparisons.map((item) => item.id)).toEqual([
      "comparison-quality"
    ]);
    expect(projected.statistical_summary.confidence_intervals).toEqual(
      report.statistical_summary.confidence_intervals
    );
    expect(projected.statistical_summary.stability_metrics).toEqual(
      report.statistical_summary.stability_metrics
    );
    expect(projected.statistical_summary.notes).toEqual(report.statistical_summary.notes);
    expect(projected.statistical_summary.effect_estimates).toEqual([
      report.statistical_summary.effect_estimates[0]
    ]);
    expect(projected.statistical_summary.effect_estimates[0]?.delta).toBe(-0.15);
    expect(projected.results_plan?.primary_effect_criterion).toEqual(
      report.results_plan.primary_effect_criterion
    );
    expect(projected.results_plan?.primary_effect_criterion).not.toBe(
      report.results_plan.primary_effect_criterion
    );
    expect(projected.results_plan?.primary_effect_criterion?.effect_criterion).not.toBe(
      report.results_plan.primary_effect_criterion.effect_criterion
    );
  });

  it("builds figure payload from explicit links even when manuscript rows are reversed", () => {
    const contract = requireContract();
    const payload = buildWritePaperFigurePayload(buildManuscript(contract), contract);

    expect(payload.figures).toHaveLength(1);
    expect(payload.figures[0].metric).toMatchObject({
      id: "metric-quality",
      direction: "higher_better",
      unit: "points"
    });
    expect(payload.figures[0].bars.map((row) => row.comparison_side)).toEqual([
      "subject",
      "reference"
    ]);
    expect(payload.figures[0].bars.map((row) => row.observation_id)).toEqual([
      "observation-quality-subject",
      "observation-quality-reference"
    ]);
    expect(payload.figures[0].caption).toContain("comparison-quality");
    expect(payload.figures[0].caption).toContain("unit: points");
  });

  it("rejects label-only figure semantics and mismatched observation values", () => {
    const contract = requireContract();
    const labelOnly = buildManuscript(contract);
    labelOnly.figures![0].bars = [
      { label: "Displayed subject", value: 0.42 },
      { label: "Displayed reference", value: 0.58 }
    ];
    expect(() => buildWritePaperFigurePayload(labelOnly, contract)).toThrow(
      /complete comparison metadata/u
    );

    const mismatchedValue = buildManuscript(contract);
    mismatchedValue.figures![0].bars[1].value = 0.99;
    expect(() => buildWritePaperFigurePayload(mismatchedValue, contract)).toThrow(
      /must match the linked observation value/u
    );
  });

  it("generates a renderer without label-derived roles or score-based selection", () => {
    const script = buildPythonVectorFigureRendererScript();

    expect(script).toContain("comparison_side");
    expect(script).toContain("series_role");
    expect(script).toContain("metric_unit");
    expect(script).not.toMatch(/label\.lower\(\)/u);
    expect(script).not.toMatch(/max\([^\n]+key=/u);
    expect(script).not.toContain("condition_parameter");
    expect(script).not.toContain("Task-level");
  });

  it("emits syntactically valid Python", () => {
    const result = spawnSync(
      "python3",
      ["-c", "import sys; compile(sys.stdin.read(), '<write-paper-renderer>', 'exec')"],
      {
        input: buildPythonVectorFigureRendererScript(),
        encoding: "utf8"
      }
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it("renders the validated payload to a PDF", () => {
    const contract = requireContract();
    const root = mkdtempSync(path.join(tmpdir(), "write-paper-v2-render-"));
    try {
      writeFileSync(
        path.join(root, "figure_payload.json"),
        `${JSON.stringify(buildWritePaperFigurePayload(buildManuscript(contract), contract), null, 2)}\n`,
        "utf8"
      );
      writeFileSync(
        path.join(root, "render_paper_figures.py"),
        buildPythonVectorFigureRendererScript(),
        "utf8"
      );

      const result = spawnSync("python3", ["render_paper_figures.py"], {
        cwd: root,
        encoding: "utf8"
      });
      expect(result.status, result.stderr).toBe(0);
      expect(
        readFileSync(path.join(root, "main-result-figure-1.pdf")).subarray(0, 4).toString("ascii")
      ).toBe("%PDF");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
