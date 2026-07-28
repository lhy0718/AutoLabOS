import path from "node:path";
import { describe, expect, it } from "vitest";

import type {
  ExperimentPortfolio,
  ExperimentRunManifest
} from "../src/core/experiments/experimentPortfolio.js";
import type { ResultsArtifactV2 } from "../src/core/analysis/resultsTableSchema.js";
import {
  buildResultsTableValidation,
  selectAnalysisMetricsPath
} from "../src/core/nodes/analyzeResults.js";
import {
  buildAnalysisReport,
  buildPersistedAnalysisMetricsProjection,
  parseAnalysisReport
} from "../src/core/resultAnalysis.js";
import { projectPortableArtifactValue } from "../src/utils/portableArtifact.js";

interface ArtifactOptions {
  metricId?: string;
  metricLabel?: string;
  direction?: "higher_better" | "lower_better";
  subjectId?: string;
  referenceId?: string;
  subjectLabel?: string;
  referenceLabel?: string;
  subjectValue?: number;
  referenceValue?: number;
  judgement?: string;
  includeComparison?: boolean;
  reverseOrder?: boolean;
  decoyValues?: [number, number];
}

function comparisonArtifact(options: ArtifactOptions = {}): ResultsArtifactV2 {
  const metricId = options.metricId ?? "primary_score";
  const subjectId = options.subjectId ?? "candidate_a";
  const referenceId = options.referenceId ?? "reference";
  const subjectObservationId = `${subjectId}_observation`;
  const referenceObservationId = `${referenceId}_observation`;
  const metrics: ResultsArtifactV2["metrics"] = [
    {
      id: metricId,
      label: options.metricLabel ?? "Primary score",
      direction: options.direction ?? "higher_better",
      unit: "unitless"
    }
  ];
  const series: ResultsArtifactV2["series"] = [
    {
      id: subjectId,
      label: options.subjectLabel ?? "Candidate A",
      role: "primary",
      dimensions: { partition: "validation_partition" }
    },
    {
      id: referenceId,
      label: options.referenceLabel ?? "Reference",
      role: "baseline",
      dimensions: { partition: "validation_partition" }
    }
  ];
  const observations: ResultsArtifactV2["observations"] = [
    {
      id: subjectObservationId,
      series_id: subjectId,
      metric_id: metricId,
      scope: { partition: "validation_partition" },
      value: options.subjectValue ?? 0.62
    },
    {
      id: referenceObservationId,
      series_id: referenceId,
      metric_id: metricId,
      scope: { partition: "validation_partition" },
      value: options.referenceValue ?? 0.57
    }
  ];

  if (options.decoyValues) {
    metrics.push({
      id: "secondary_score",
      label: "Secondary score",
      direction: "higher_better",
      unit: "unitless"
    });
    observations.push(
      {
        id: `${subjectId}_decoy_observation`,
        series_id: subjectId,
        metric_id: "secondary_score",
        scope: { partition: "validation_partition" },
        value: options.decoyValues[0]
      },
      {
        id: `${referenceId}_decoy_observation`,
        series_id: referenceId,
        metric_id: "secondary_score",
        scope: { partition: "validation_partition" },
        value: options.decoyValues[1]
      }
    );
  }

  const comparisons: ResultsArtifactV2["comparisons"] =
    options.includeComparison === false
      ? []
      : [
          {
            id: "declared_comparison",
            subject_observation_id: subjectObservationId,
            reference_observation_id: referenceObservationId,
            delta: Number(((options.subjectValue ?? 0.62) - (options.referenceValue ?? 0.57)).toFixed(6)),
            ...(options.judgement ? { judgement: options.judgement } : {})
          }
        ];

  return {
    schema_version: "2.0",
    metrics: options.reverseOrder ? [...metrics].reverse() : metrics,
    series: options.reverseOrder ? [...series].reverse() : series,
    observations: options.reverseOrder ? [...observations].reverse() : observations,
    comparisons: options.reverseOrder ? [...comparisons].reverse() : comparisons
  };
}

function multipleComparisonArtifact(): ResultsArtifactV2 {
  const artifact = comparisonArtifact({ judgement: "supported" });
  return {
    ...artifact,
    series: [
      ...artifact.series,
      {
        id: "candidate_b",
        label: "Candidate B",
        role: "primary",
        dimensions: { partition: "validation_partition" }
      }
    ],
    observations: [
      ...artifact.observations,
      {
        id: "candidate_b_observation",
        series_id: "candidate_b",
        metric_id: "primary_score",
        scope: { partition: "validation_partition" },
        value: 0.54,
        evidence_refs: ["evidence-west"]
      }
    ],
    comparisons: [
      {
        ...artifact.comparisons[0],
        evidence_refs: ["evidence-declared"]
      },
      {
        id: "declared_alternate",
        subject_observation_id: "candidate_b_observation",
        reference_observation_id: "reference_observation",
        delta: -0.03,
        judgement: "not_supported",
        evidence_refs: ["evidence-alternate"]
      }
    ]
  };
}

function reportFor(
  artifact: ResultsArtifactV2,
  options: {
    primaryMetricId?: string;
    primaryComparisonId?: string;
    objectiveDirection?: "maximize" | "minimize";
    rawMetrics?: Record<string, unknown>;
    includeArtifact?: boolean;
    experimentPlanRaw?: string;
    experimentPortfolio?: ExperimentPortfolio;
    runManifest?: ExperimentRunManifest;
    supplementalMetrics?: Array<{
      profile: string;
      path?: string;
      metrics: Record<string, unknown>;
    }>;
    supplementalExpectation?: {
      applicable: boolean;
      profiles: string[];
      reason?: string;
    };
  } = {}
) {
  const primaryMetricId = options.primaryMetricId ?? "primary_score";
  const observedValue = artifact.observations.find(
    (observation) => observation.metric_id === primaryMetricId
  )?.value;
  const objectiveText = `Track ${primaryMetricId} exactly.`;
  return buildAnalysisReport({
    run: { objectiveMetric: objectiveText },
    metrics: {
      ...(options.rawMetrics ?? {}),
      ...(options.includeArtifact === false ? {} : { results_artifact: artifact })
    },
    objectiveProfile: {
      source: "llm",
      raw: objectiveText,
      primaryMetric: primaryMetricId,
      preferredMetricKeys: [primaryMetricId],
      direction: options.objectiveDirection ?? "maximize",
      comparator: ">",
      targetValue: 0,
      targetDescription: `${primaryMetricId} is declared by exact ID.`,
      analysisFocus: [],
      paperEmphasis: [],
      assumptions: []
    },
    objectiveEvaluation: {
      rawObjectiveMetric: objectiveText,
      profileSource: "llm",
      primaryMetric: primaryMetricId,
      preferredMetricKeys: [primaryMetricId],
      matchedMetricKey: primaryMetricId,
      direction: options.objectiveDirection ?? "maximize",
      comparator: ">",
      targetValue: 0,
      observedValue,
      status: observedValue === undefined ? "missing" : "observed",
      summary:
        observedValue === undefined
          ? `No observation exists for exact metric ID ${primaryMetricId}.`
          : `Observed ${primaryMetricId}=${observedValue}.`
    },
    experimentPlanRaw: options.experimentPlanRaw,
    experimentPortfolio: options.experimentPortfolio,
    runManifest: options.runManifest,
    primaryComparisonId: options.primaryComparisonId,
    supplementalMetrics: options.supplementalMetrics,
    supplementalExpectation: options.supplementalExpectation
  });
}

function comparisonSemantics(report: ReturnType<typeof reportFor>) {
  const comparison = report.condition_comparisons[0];
  const metric = comparison?.metrics[0];
  return {
    source: comparison?.source,
    metric: metric?.key,
    delta: metric?.value,
    direction: metric?.direction,
    subjectValue: metric?.subject_value,
    referenceValue: metric?.reference_value,
    hypothesisSupported: comparison?.hypothesis_supported
  };
}

describe("resultAnalysis", () => {
  it("projects machine-local paths out of nested public artifact strings", () => {
    const privateRoot = ["", "home", "operator", "workspace-neutral"].join("/");
    const artifact = {
      metrics_path: `${privateRoot}/.autolabos/runs/run-neutral/metrics.json`,
      command: `python ${privateRoot}/outputs/bundle-neutral/experiment/run.py --metrics-path ${privateRoot}/.autolabos/runs/run-neutral/metrics.json`,
      nested: [{ path: `${privateRoot}/outputs/bundle-neutral/analysis/result.json` }]
    };

    const projected = projectPortableArtifactValue(artifact);
    const serialized = JSON.stringify(projected);

    expect(projected.metrics_path).toBe(".autolabos/runs/<run-id>/metrics.json");
    expect(projected.command).toContain("outputs/bundle-neutral/experiment/run.py");
    expect(projected.nested[0].path).toBe("outputs/bundle-neutral/analysis/result.json");
    expect(serialized).not.toContain(privateRoot);
    expect(serialized).not.toContain(["", "home", ""].join("/"));
  });

  it("prefers a run-local metrics artifact over a stale external configured path", () => {
    const workspaceRoot = path.resolve("workspace-neutral");
    const runLocalPath = path.join(workspaceRoot, ".autolabos", "runs", "run-neutral", "metrics.json");
    const externalPath = path.resolve("..", "external-neutral", "metrics.json");

    expect(
      selectAnalysisMetricsPath({
        workspaceRoot,
        configuredPath: externalPath,
        runLocalPath,
        runLocalExists: true
      })
    ).toBe(runLocalPath);
    expect(
      selectAnalysisMetricsPath({
        workspaceRoot,
        configuredPath: path.join(workspaceRoot, "outputs", "metrics.json"),
        runLocalPath,
        runLocalExists: true
      })
    ).toBe(path.join(workspaceRoot, "outputs", "metrics.json"));
  });

  it("bounds raw metrics generically while preserving the canonical top-level artifact", () => {
    const records = Array.from({ length: 80 }, (_, index) => ({
      example_id: `example-${index}`,
      prediction: "candidate_a",
      correct: index % 2 === 0
    }));
    const artifact = comparisonArtifact();
    const metrics = {
      status: "completed",
      results_artifact: artifact,
      record_batch: records,
      nested_bundle: {
        entries: records.slice(0, 50)
      },
      long_note: "x".repeat(2_500)
    };

    const projected = buildPersistedAnalysisMetricsProjection(
      metrics,
      ".autolabos/runs/run-neutral/metrics.json"
    );
    const report = reportFor(artifact, { rawMetrics: metrics });

    expect(projected.results_artifact).toBeUndefined();
    expect(projected.record_batch).toHaveLength(24);
    expect((projected.nested_bundle as { entries: unknown[] }).entries).toHaveLength(24);
    expect(projected.long_note).toBe(`${"x".repeat(2_000)}...`);
    expect(projected.analysis_artifact_projection).toMatchObject({
      source_metrics_ref: ".autolabos/runs/run-neutral/metrics.json",
      omitted_fields: expect.arrayContaining([
        "long_note",
        "nested_bundle.entries[24:]",
        "record_batch[24:]",
        "results_artifact"
      ]),
      limits: {
        max_depth: 6,
        max_array_items: 24,
        max_object_entries: 64,
        max_string_length: 2_000
      }
    });
    expect(report.results_artifact).toEqual(artifact);
  });

  it("keeps comparison semantics invariant to series renaming, array order, and unrelated scores", () => {
    const first = reportFor(
      comparisonArtifact({
        subjectId: "candidate_a",
        referenceId: "reference",
        subjectLabel: "Candidate A",
        referenceLabel: "Reference",
        subjectValue: 0.62,
        referenceValue: 0.57,
        judgement: "supported",
        decoyValues: [1000, -1000]
      })
    );
    const renamedAndReordered = reportFor(
      comparisonArtifact({
        subjectId: "candidate_b",
        referenceId: "reference_b",
        subjectLabel: "Candidate B",
        referenceLabel: "Reference B",
        subjectValue: 0.62,
        referenceValue: 0.57,
        judgement: "supported",
        decoyValues: [-999999, 999999],
        reverseOrder: true
      })
    );

    expect(first.condition_comparisons).toHaveLength(1);
    expect(renamedAndReordered.condition_comparisons).toHaveLength(1);
    expect(comparisonSemantics(renamedAndReordered)).toEqual(comparisonSemantics(first));
    expect(comparisonSemantics(first)).toEqual({
      source: "results_artifact",
      metric: "primary_score",
      delta: 0.05,
      direction: "higher_better",
      subjectValue: 0.62,
      referenceValue: 0.57,
      hypothesisSupported: true
    });
    const comparisonClaim = first.paper_claims.find((claim) =>
      claim.evidence.includes("result_analysis.json#/results_artifact/comparisons/0")
    );
    expect(comparisonClaim?.evidence).toEqual(expect.arrayContaining([
      "result_analysis.json#/results_artifact/comparisons/0",
      "result_analysis.json#/results_artifact/observations/0",
      "result_analysis.json#/results_artifact/observations/1"
    ]));
    expect(comparisonClaim?.evidence.some((item) => item.includes("condition_comparisons"))).toBe(false);
  });

  it("keeps compatibility comparisons non-authoritative when multiple explicit comparisons have no primary ID", () => {
    const report = reportFor(multipleComparisonArtifact());

    expect(report.condition_comparisons).toHaveLength(2);
    expect(report.primary_comparison_id).toBeUndefined();
    expect(report.paper_claims.some((claim) =>
      claim.evidence.some((item) => item.includes("#/results_artifact/comparisons/"))
    )).toBe(false);
    expect(report.primary_findings.some((finding) => finding.includes("Candidate A vs Reference"))).toBe(false);
    expect(report.primary_findings.some((finding) => finding.includes("Candidate B vs Reference"))).toBe(false);
    expect(report.statistical_summary.notes.some((note) => note.includes(" vs "))).toBe(false);
  });

  it("uses only a validated exact primary comparison ID for claims and parse canonicalization", () => {
    const report = reportFor(multipleComparisonArtifact(), {
      primaryComparisonId: "declared_alternate"
    });

    expect(report.primary_comparison_id).toBe("declared_alternate");
    const comparisonClaim = report.paper_claims.find((claim) =>
      claim.evidence.includes("result_analysis.json#/results_artifact/comparisons/1")
    );
    expect(comparisonClaim).toMatchObject({
      claim: expect.stringContaining("Candidate B vs Reference")
    });
    expect(comparisonClaim?.evidence).toEqual(expect.arrayContaining([
      "result_analysis.json#/results_artifact/comparisons/1",
      "result_analysis.json#/results_artifact/observations/2",
      "result_analysis.json#/results_artifact/observations/1",
      "evidence-alternate"
    ]));
    expect(comparisonClaim?.evidence.some((item) => item.includes("condition_comparisons"))).toBe(false);

    const parsed = parseAnalysisReport(JSON.stringify(report));
    expect(parsed?.primary_comparison_id).toBe("declared_alternate");
    expect(parsed?.paper_claims.some((claim) =>
      claim.evidence.includes("result_analysis.json#/results_artifact/comparisons/1")
    )).toBe(true);

    const rejectedPrimary = parseAnalysisReport(JSON.stringify({
      ...report,
      primary_comparison_id: "missing_comparison"
    }));
    expect(rejectedPrimary?.primary_comparison_id).toBeUndefined();
    expect(rejectedPrimary?.paper_claims.some((claim) =>
      claim.evidence.some((item) => item.includes("#/results_artifact/comparisons/"))
    )).toBe(false);
  });

  it("does not synthesize a comparison when the explicit V2 comparison list is empty", () => {
    const artifact = comparisonArtifact({ includeComparison: false });
    const report = reportFor(artifact, {
      rawMetrics: {
        comparison: {
          declared_pair: { delta: 0.9, hypothesis_supported: true }
        },
        condition_metrics: {
          candidate_a: { primary_score: 0.9 },
          reference: { primary_score: 0.1 }
        },
        results: [
          { condition_id: "candidate_a", primary_score: 0.9 },
          { condition_id: "reference", primary_score: 0.1 }
        ],
        result_rows: [
          { condition_id: "candidate_a", primary_score: 0.9 },
          { condition_id: "reference", primary_score: 0.1 }
        ],
        recipes: {
          candidate_a: { primary_score: 0.9 },
          reference: { primary_score: 0.1 }
        },
        conditions: [
          { condition_id: "candidate_a", primary_score: 0.9 },
          { condition_id: "reference", primary_score: 0.1 }
        ],
        condition_results: [
          { condition_id: "candidate_a", primary_score: 0.9 },
          { condition_id: "reference", primary_score: 0.1 }
        ],
        per_condition: [
          { condition_id: "candidate_a", primary_score: 0.9 },
          { condition_id: "reference", primary_score: 0.1 }
        ]
      }
    });

    expect(report.results_artifact).toEqual(artifact);
    expect(report.condition_comparisons).toEqual([]);
    expect(report.statistical_summary.effect_estimates).toEqual([]);
  });

  it("does not promote a generic metrics projection into the canonical artifact", () => {
    const report = reportFor(comparisonArtifact({ includeComparison: false }), {
      includeArtifact: false,
      rawMetrics: {
        baseline_condition: "reference",
        metric_definitions: [
          {
            id: "primary_score",
            label: "Primary score",
            direction: "higher_better",
            unit: "unitless"
          }
        ],
        condition_results: [
          {
            condition_id: "candidate_a",
            role: "primary",
            dimensions: { partition: "validation_partition" },
            scope: { partition: "validation_partition" },
            metrics: { primary_score: 0.9 }
          },
          {
            condition_id: "reference",
            dimensions: { partition: "validation_partition" },
            scope: { partition: "validation_partition" },
            metrics: { primary_score: 0.1 }
          }
        ]
      }
    });

    expect(report.results_artifact).toEqual({
      schema_version: "2.0",
      metrics: [],
      series: [],
      observations: [],
      comparisons: []
    });
    expect(report.condition_comparisons).toEqual([]);
    expect(report.statistical_summary.effect_estimates).toEqual([]);
    expect(report.warnings).toContain(
      "No explicit ResultsArtifactV2 was available; generic metrics were retained without synthesizing canonical observations or comparisons."
    );
  });

  it("uses the explicit lower-better metric direction instead of the metric name or objective fallback", () => {
    const artifact = comparisonArtifact({
      metricId: "secondary_score",
      metricLabel: "Secondary score",
      direction: "lower_better",
      subjectValue: 0.2,
      referenceValue: 0.5,
      judgement: "better"
    });
    const report = reportFor(artifact, {
      primaryMetricId: "secondary_score",
      objectiveDirection: "maximize"
    });

    expect(report.condition_comparisons[0]).toMatchObject({
      source: "results_artifact",
      metric_direction: "lower_better"
    });
    expect(report.condition_comparisons[0]?.hypothesis_supported).toBeUndefined();
    expect(report.statistical_summary.effect_estimates).toEqual([
      expect.objectContaining({
        comparison_id: "declared_comparison",
        metric_key: "secondary_score",
        delta: -0.3,
        direction: "positive"
      })
    ]);
    expect(buildResultsTableValidation({ report }).rows).toEqual([
      {
        metric: "secondary_score",
        baseline: 0.5,
        comparator: 0.2,
        delta: -0.3,
        direction: "lower_better"
      }
    ]);
  });

  it("maps only exact declared hypothesis judgements and never derives support from delta", () => {
    const explicitlyUnsupported = reportFor(
      comparisonArtifact({ judgement: "not_supported", subjectValue: 0.9, referenceValue: 0.1 })
    );
    const effectOnly = reportFor(
      comparisonArtifact({ judgement: "better", subjectValue: 0.9, referenceValue: 0.1 })
    );

    expect(explicitlyUnsupported.condition_comparisons[0]?.hypothesis_supported).toBe(false);
    expect(effectOnly.condition_comparisons[0]?.hypothesis_supported).toBeUndefined();
  });

  it("does not promote the first or partially matching metric when no exact objective metric ID exists", () => {
    const report = reportFor(
      comparisonArtifact({
        metricId: "primary_score",
        metricLabel: "Primary score",
        decoyValues: [5000, -5000],
        reverseOrder: true
      }),
      { primaryMetricId: "primary" }
    );

    expect(report.metric_table.length).toBeGreaterThan(0);
    expect(report.overview.top_metric).toBeUndefined();
    expect(report.mean_score).toBe(0);
    expect(report.figure_specs).toEqual([]);
  });

  it("fails closed when historical V1 data has no explicit metric unit", () => {
    const report = parseAnalysisReport(JSON.stringify({
      results_table: [
        {
          metric: "primary_score",
          baseline: 0.6,
          comparator: 0.4,
          delta: -0.2,
          direction: "lower_better"
        }
      ],
      condition_comparisons: [
        {
          id: "stale_comparison",
          label: "Stale comparison",
          source: "metrics.comparison",
          metrics: [{ key: "other_measure", value: 99 }],
          summary: "Stale comparison projection."
        }
      ],
      objective_metric: {
        evaluation: {
          matchedMetricKey: "primary_score",
          primaryMetric: "primary_score",
          preferredMetricKeys: ["primary_score"]
        },
        profile: {
          primary_metric: "primary_score",
          preferred_metric_keys: ["primary_score"]
        }
      },
      statistical_summary: {
        confidence_intervals: [],
        stability_metrics: [],
        effect_estimates: [
          {
            comparison_id: "stale_comparison",
            metric_key: "other_measure",
            delta: 99,
            direction: "negative",
            summary: "Stale effect."
          }
        ],
        notes: []
      }
    }));

    expect(report?.results_artifact.metrics[0]?.unit).toBeUndefined();
    expect(report?.condition_comparisons).toEqual([]);
    expect(report?.statistical_summary.effect_estimates).toEqual([]);
  });

  it("extracts a preset runtime guardrail without raw condition inference", () => {
    const report = reportFor(comparisonArtifact(), {
      experimentPlanRaw: `
selected_design:
  title: "Variance Control"
  evaluation_steps:
    - "Declare support only if runtime does not increase beyond a predefined practical threshold such as 25 percent."
  risks:
    - "A practical threshold on runtime increase must be specified before analysis to avoid post hoc interpretation."
`
    });

    expect(report.plan_context.selected_design?.runtime_guardrail_pct).toBe(25);
    expect(report.limitations.some((line) => /must be specified before analysis/u.test(line))).toBe(false);
    expect(report.primary_findings.some((line) => line.includes("runtime-increase guardrail of 25"))).toBe(true);
  });

  it("surfaces neutral portfolio groups and links supplemental runs to the manifest", () => {
    const experimentPortfolio: ExperimentPortfolio = {
      version: 1,
      run_id: "run-portfolio",
      created_at: "2026-07-26T00:00:00.000Z",
      execution_model: "managed_bundle",
      comparison_axes: ["runner_profile", "partition", "repeat"],
      primary_trial_group_id: "primary_standard",
      total_expected_trials: 18,
      trial_groups: [
        {
          id: "primary_standard",
          label: "Primary standard run",
          role: "primary",
          profile: "standard",
          expected_trials: 12,
          dataset_scope: ["validation_partition", "held_out_partition"],
          metrics: ["primary_score"],
          baselines: ["reference"],
          notes: ["Main declared comparison."]
        },
        {
          id: "quick_check",
          label: "Quick-check replication",
          role: "supplemental",
          profile: "quick_check",
          expected_trials: 6,
          dataset_scope: ["validation_partition"],
          metrics: ["primary_score"],
          baselines: ["reference"],
          notes: ["Bounded validation run."]
        }
      ]
    };
    const runManifest: ExperimentRunManifest = {
      version: 1,
      run_id: "run-portfolio",
      generated_at: "2026-07-26T00:01:00.000Z",
      execution_model: "managed_bundle",
      primary_command: "node run-configured-experiment.js --profile standard",
      primary_metrics_path: ".autolabos/runs/run-portfolio/metrics.json",
      total_expected_trials: 18,
      executed_trials: 18,
      cached_trials: 0,
      portfolio: experimentPortfolio,
      trial_groups: [
        {
          ...experimentPortfolio.trial_groups[0],
          status: "pass",
          metrics_path: ".autolabos/runs/run-portfolio/metrics.json",
          summary: "Primary run passed.",
          sampling_profile: {
            name: "standard",
            total_trials: 12,
            executed_trials: 12,
            cached_trials: 0
          }
        },
        {
          ...experimentPortfolio.trial_groups[1],
          status: "pass",
          metrics_path: "quick_check_metrics.json",
          summary: "Quick-check passed.",
          sampling_profile: {
            name: "quick_check",
            total_trials: 6,
            executed_trials: 6,
            cached_trials: 0
          }
        }
      ]
    };
    const report = reportFor(comparisonArtifact(), {
      rawMetrics: {
        sampling_profile: {
          total_trials: 12,
          executed_trials: 12,
          cached_trials: 0
        }
      },
      experimentPortfolio,
      runManifest,
      supplementalMetrics: [
        {
          profile: "quick_check",
          path: "quick_check_metrics.json",
          metrics: {
            primary_score: 0.08,
            sampling_profile: {
              name: "quick_check",
              total_trials: 6,
              executed_trials: 6,
              cached_trials: 0
            }
          }
        }
      ],
      supplementalExpectation: {
        applicable: true,
        profiles: ["quick_check"]
      }
    });

    expect(report.experiment_portfolio).toMatchObject({
      execution_model: "managed_bundle",
      total_expected_trials: 18,
      executed_trials: 18
    });
    expect(report.experiment_portfolio?.trial_groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "primary_standard", status: "pass", executed_trials: 12 }),
      expect.objectContaining({ id: "quick_check", status: "pass", executed_trials: 6 })
    ]));
    expect(report.supplemental_runs[0]).toMatchObject({
      mean_score: 0.08,
      portfolio: {
        trial_group_id: "quick_check",
        trial_group_label: "Quick-check replication",
        execution_model: "managed_bundle"
      }
    });
    expect(report.primary_findings.some((line) => line.includes("Execution portfolio"))).toBe(true);
  });
});
