import { describe, it, expect } from "vitest";
import {
  evaluateMinimumGate,
  type MinimumGateInput
} from "../src/core/analysis/paperMinimumGate.js";
import type { ReviewArtifactPresence } from "../src/core/reviewSystem.js";
import type { AnalysisReport } from "../src/core/resultAnalysis.js";
import type {
  ResultsArtifactV2,
  ResultsSeriesRole
} from "../src/core/analysis/resultsTableSchema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fullPresence(): ReviewArtifactPresence {
  return {
    corpusPresent: true,
    paperSummariesPresent: true,
    evidenceStorePresent: true,
    hypothesesPresent: true,
    experimentPlanPresent: true,
    metricsPresent: true,
    figurePresent: true,
    synthesisPresent: true,
    baselineSummaryPresent: true,
    resultTablePresent: true,
    richnessSummaryPresent: true,
    richnessReadiness: true
  };
}

function minimalResultsArtifact(): ResultsArtifactV2 {
  return {
    schema_version: "2.0",
    metrics: [
      {
        id: "metric-quality",
        label: "Outcome quality",
        direction: "higher_better",
        unit: "unitless"
      }
    ],
    series: [
      {
        id: "series-reference",
        label: "Observed series north",
        role: "baseline",
        dimensions: { partition: "evaluation", repetition_set: "confirmed" }
      },
      {
        id: "series-subject",
        label: "Observed series south",
        role: "primary",
        dimensions: { partition: "evaluation", repetition_set: "confirmed" }
      }
    ],
    observations: [
      {
        id: "observation-quality-reference",
        series_id: "series-reference",
        metric_id: "metric-quality",
        scope: { partition: "evaluation" },
        value: 0.82,
        evidence_refs: ["artifacts/reference-quality.json"]
      },
      {
        id: "observation-quality-subject",
        series_id: "series-subject",
        metric_id: "metric-quality",
        scope: { partition: "evaluation" },
        value: 0.87,
        evidence_refs: ["artifacts/subject-quality.json"]
      }
    ],
    comparisons: [
      {
        id: "comparison-quality",
        subject_observation_id: "observation-quality-subject",
        reference_observation_id: "observation-quality-reference",
        delta: 0.05,
        evidence_refs: ["artifacts/quality-comparison.json"]
      }
    ]
  };
}

function minimalReport(): AnalysisReport {
  return {
    overview: {
      objective_status: "met",
      objective_summary: "Test objective met",
      execution_runs: 3
    },
    metrics: {
      run_config: {
        seed: 11,
        max_steps: 40
      },
      condition_results: [
        {
          condition_marker: "reference_condition",
          seeds: [11, 12, 13],
          seed_count: 3
        },
        {
          condition_marker: "candidate_condition",
          seeds: [11, 12, 13],
          seed_count: 3
        }
      ]
    },
    results_artifact: minimalResultsArtifact(),
    primary_comparison_id: "comparison-quality",
    condition_comparisons: [],
    primary_findings: ["The explicit subject observation exceeds the reference observation."],
    paper_claims: [
      {
        claim: "The tested subject condition improves the measured outcome.",
        evidence: [{ type: "metric", reference: "metric-quality", detail: "delta=0.05" }]
      }
    ],
    limitations: [],
    warnings: [],
    statistical_summary: {
      total_trials: 3,
      executed_trials: 3,
      cached_trials: 0,
      confidence_intervals: [],
      stability_metrics: [],
      effect_estimates: [],
      notes: []
    },
    shortlisted_designs: [],
    recommendations: []
  } as unknown as AnalysisReport;
}

function fullInput(): MinimumGateInput {
  return {
    presence: fullPresence(),
    report: minimalReport(),
    topic: "Neutral comparison study",
    objectiveMetric: "outcome quality"
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("paperMinimumGate", () => {
  it("passes when all structural prerequisites are met", () => {
    const result = evaluateMinimumGate(fullInput());

    expect(result.passed).toBe(true);
    expect(result.ceiling_type).toBe("unrestricted");
    expect(result.blockers).toHaveLength(0);
    expect(result.checks.every(c => c.passed)).toBe(true);
    expect(result.summary).toContain("passed");
  });

  it("records measured values and threshold values for every gate check", () => {
    const result = evaluateMinimumGate(fullInput());

    for (const check of result.checks) {
      expect(check.measured_value).toBeDefined();
      expect(check.threshold_value).toBeDefined();
      expect(check.threshold_source).toMatch(/^docs\//u);
    }
  });

  it("has the expected deterministic checks", () => {
    const result = evaluateMinimumGate(fullInput());
    expect(result.checks).toHaveLength(15);
    const checkIds = result.checks.map(c => c.id);
    expect(checkIds).toContain("objective_metric");
    expect(checkIds).toContain("experiment_plan");
    expect(checkIds).toContain("baseline_or_comparator");
    expect(checkIds).toContain("executed_result");
    expect(checkIds).toContain("evidence_depth");
    expect(checkIds).toContain("evaluation_sample_size");
    expect(checkIds).toContain("seed_replication");
    expect(checkIds).toContain("planned_execution_coverage");
    expect(checkIds).toContain("effect_granularity");
    expect(checkIds).toContain("training_budget_depth");
    expect(checkIds).toContain("result_artifacts");
    expect(checkIds).toContain("claim_evidence_linkage");
    expect(checkIds).toContain("claim_evidence_missing");
    expect(checkIds).toContain("results_artifact_comparison");
    expect(checkIds).toContain("not_smoke_only");
  });

  it("blocks when objective metric is missing", () => {
    const input = fullInput();
    input.objectiveMetric = "";
    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Objective metric identified");
    // Missing objective + not_smoke_only (needs objective) => system_validation_note ceiling
    expect(["system_validation_note", "blocked_for_paper_scale"]).toContain(result.ceiling_type);
  });

  it("blocks when no experiment plan exists", () => {
    const input = fullInput();
    input.presence.experimentPlanPresent = false;
    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Experiment plan exists (task/dataset grounding)");
  });

  it("fails closed when role-like labels, order, and scores have no explicit V2 comparison", () => {
    const input = fullInput();
    input.report.results_artifact.comparisons = [];
    input.report.results_artifact.series[0].label = "Baseline-labelled series";
    input.report.results_artifact.series[1].label = "Comparator-labelled series";
    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Baseline or comparator is explicit");
    expect(result.failed_checks).toEqual(
      expect.arrayContaining([
        "baseline_or_comparator",
        "executed_result",
        "results_artifact_comparison"
      ])
    );
  });

  it("accepts a negative lower-is-better result when the explicit delta is consistent", () => {
    const input = fullInput();
    input.report.results_artifact.metrics[0].direction = "lower_better";
    input.report.results_artifact.observations[0].value = 120;
    input.report.results_artifact.observations[1].value = 95;
    input.report.results_artifact.comparisons[0].delta = -25;

    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(true);
    expect(result.checks.find((check) => check.id === "results_artifact_comparison")?.passed).toBe(true);
  });

  it.each([
    { name: "primary versus baseline", subjectRole: "primary", referenceRole: "baseline", passed: true },
    { name: "comparator versus baseline", subjectRole: "comparator", referenceRole: "baseline", passed: true },
    { name: "missing subject role", subjectRole: undefined, referenceRole: "baseline", passed: false },
    { name: "missing reference role", subjectRole: "primary", referenceRole: undefined, passed: false },
    { name: "reversed roles", subjectRole: "baseline", referenceRole: "primary", passed: false },
    { name: "baseline versus baseline", subjectRole: "baseline", referenceRole: "baseline", passed: false },
    { name: "primary versus primary", subjectRole: "primary", referenceRole: "primary", passed: false },
    { name: "control subject", subjectRole: "control", referenceRole: "baseline", passed: false },
    { name: "other subject", subjectRole: "other", referenceRole: "baseline", passed: false },
    { name: "control reference", subjectRole: "primary", referenceRole: "control", passed: false },
    { name: "other reference", subjectRole: "primary", referenceRole: "other", passed: false }
  ] as Array<{
    name: string;
    subjectRole: ResultsSeriesRole | undefined;
    referenceRole: ResultsSeriesRole | undefined;
    passed: boolean;
  }>)("enforces comparison role semantics in the minimum gate: $name", ({ subjectRole, referenceRole, passed }) => {
    const input = fullInput();
    setSeriesRole(input.report.results_artifact.series[1], subjectRole);
    setSeriesRole(input.report.results_artifact.series[0], referenceRole);

    const result = evaluateMinimumGate(input);
    const comparisonCheck = result.checks.find(
      (check) => check.id === "results_artifact_comparison"
    );

    expect(comparisonCheck?.passed).toBe(passed);
    if (!passed) {
      expect(comparisonCheck?.detail).toMatch(/requires (subject|reference) series role/u);
    }
  });

  it.each([
    { name: "missing", unit: undefined },
    { name: "blank", unit: "   " }
  ])("fails closed when the paper-facing metric unit is $name", ({ unit }) => {
    const input = fullInput();
    setMetricUnit(input.report.results_artifact.metrics[0], unit);

    const result = evaluateMinimumGate(input);
    const comparisonCheck = result.checks.find(
      (check) => check.id === "results_artifact_comparison"
    );

    expect(comparisonCheck?.passed).toBe(false);
    expect(comparisonCheck?.detail).toContain(
      "results_artifact.metrics[0].unit must be a non-empty string"
    );
    expect(input.report.results_artifact.metrics[0].unit).toBe(unit);
  });

  it.each([
    { name: "omitted", primaryComparisonId: undefined, issue: "is required" },
    { name: "unknown", primaryComparisonId: "comparison-absent", issue: "references unknown comparison id" }
  ])("does not fall back to the sole comparison when primary_comparison_id is $name", ({
    primaryComparisonId,
    issue
  }) => {
    const input = fullInput();
    if (primaryComparisonId === undefined) {
      delete input.report.primary_comparison_id;
    } else {
      input.report.primary_comparison_id = primaryComparisonId;
    }

    const result = evaluateMinimumGate(input);
    const comparisonCheck = result.checks.find(
      (check) => check.id === "results_artifact_comparison"
    );

    expect(comparisonCheck?.passed).toBe(false);
    expect(comparisonCheck?.detail).toContain(issue);
  });

  it("blocks when no executed result (metrics) exists", () => {
    const input = fullInput();
    input.presence.metricsPresent = false;
    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Executed comparison result exists");
  });

  it("blocks when no result table exists", () => {
    const input = fullInput();
    input.presence.resultTablePresent = false;
    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Key result artifacts present");
    expect(result.ceiling_type).toBe("research_memo");
  });

  it("blocks when no claim-evidence linkage exists", () => {
    const input = fullInput();
    input.presence.evidenceStorePresent = false;
    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Claim→evidence linkage present");
  });

  it("passes the new claim-evidence artifact check when paper artifacts are grounded", () => {
    const input = fullInput();
    input.evidenceLinksArtifact = {
      claims: [
        {
          claim_id: "c1",
          statement: "Our method improves accuracy",
          evidence_ids: ["ev_1"],
          citation_paper_ids: ["paper_1"]
        }
      ]
    };
    input.claimEvidenceTableArtifact = {
      claims: [
        {
          claim_id: "c1",
          artifact_refs: ["ev_1"],
          citation_refs: ["paper_1"]
        }
      ]
    };

    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(true);
    expect(result.failed_checks).toEqual([]);
    expect(result.checks.find((check) => check.id === "claim_evidence_missing")?.passed).toBe(true);
  });

  it("fails the new claim-evidence artifact check when claim evidence arrays are empty", () => {
    const input = fullInput();
    input.evidenceLinksArtifact = {
      claims: [
        {
          claim_id: "c1",
          statement: "Our method improves accuracy",
          evidence_ids: ["ev_1"]
        }
      ]
    };
    input.claimEvidenceTableArtifact = {
      claims: [
        {
          claim_id: "c1",
          artifact_refs: [],
          citation_refs: []
        }
      ]
    };

    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.failed_checks).toContain("claim_evidence_missing");
    expect(result.checks.find((check) => check.id === "claim_evidence_missing")?.passed).toBe(false);
  });

  it("does not use historical V1 rows when the V2 artifact has no explicit comparison", () => {
    const input = fullInput();
    input.report.results_artifact.comparisons = [];
    input.report.results_table = [
      {
        metric: "outcome_quality",
        baseline: 0.82,
        comparator: 0.87,
        delta: 0.05,
        direction: "higher_better"
      }
    ];

    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.failed_checks).toContain("results_artifact_comparison");
  });

  it("fails closed when a V2 comparison has a dangling observation reference", () => {
    const input = fullInput();
    input.report.results_artifact.comparisons[0].subject_observation_id = "observation-missing";

    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.failed_checks).toContain("results_artifact_comparison");
    expect(result.checks.find((check) => check.id === "results_artifact_comparison")?.detail)
      .toContain("references unknown observation id");
  });

  it("fails closed when a V2 metric direction is invalid", () => {
    const input = fullInput();
    (input.report.results_artifact.metrics[0] as { direction: string }).direction = "sideways";

    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.failed_checks).toContain("results_artifact_comparison");
    expect(result.checks.find((check) => check.id === "results_artifact_comparison")?.detail)
      .toContain("direction must be higher_better or lower_better");
  });

  it("fails closed when a V2 delta is nonfinite or inconsistent", () => {
    const nonfiniteInput = fullInput();
    nonfiniteInput.report.results_artifact.comparisons[0].delta = Number.NaN;
    const nonfiniteResult = evaluateMinimumGate(nonfiniteInput);

    const inconsistentInput = fullInput();
    inconsistentInput.report.results_artifact.comparisons[0].delta = 0.5;
    const inconsistentResult = evaluateMinimumGate(inconsistentInput);

    expect(nonfiniteResult.failed_checks).toContain("results_artifact_comparison");
    expect(nonfiniteResult.checks.find((check) => check.id === "results_artifact_comparison")?.detail)
      .toContain("delta must be a finite number");
    expect(inconsistentResult.failed_checks).toContain("results_artifact_comparison");
    expect(inconsistentResult.checks.find((check) => check.id === "results_artifact_comparison")?.detail)
      .toContain("delta must equal subject value minus reference value");
  });

  it("assigns blocked_for_paper_scale when many checks fail", () => {
    const input: MinimumGateInput = {
      presence: {
        corpusPresent: false,
        paperSummariesPresent: false,
        evidenceStorePresent: false,
        hypothesesPresent: false,
        experimentPlanPresent: false,
        metricsPresent: false,
        figurePresent: false,
        synthesisPresent: false,
        baselineSummaryPresent: false,
        resultTablePresent: false,
        richnessSummaryPresent: false,
        richnessReadiness: false
      },
      report: {
        overview: { objective_status: "not_met", objective_summary: "", execution_runs: 0 },
        condition_comparisons: [],
        primary_findings: [],
        paper_claims: [],
        limitations: [],
        warnings: [],
        shortlisted_designs: [],
        recommendations: []
      } as unknown as AnalysisReport,
      topic: "Test",
      objectiveMetric: ""
    };

    const result = evaluateMinimumGate(input);
    expect(result.passed).toBe(false);
    expect(result.ceiling_type).toBe("blocked_for_paper_scale");
    expect(result.blockers.length).toBeGreaterThanOrEqual(4);
  });

  it("assigns research_memo when minor gaps exist", () => {
    const input = fullInput();
    // Remove result table only — everything else passes
    input.presence.resultTablePresent = false;
    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.ceiling_type).toBe("research_memo");
  });

  it("assigns research_memo when evidence stays at a single thin run without robustness support", () => {
    const input = fullInput();
    (input.report as AnalysisReport).overview.execution_runs = 1;
    (input.report as AnalysisReport).statistical_summary = {
      total_trials: 1,
      executed_trials: 1,
      cached_trials: 0,
      confidence_intervals: [],
      stability_metrics: [],
      effect_estimates: [],
      notes: []
    } as AnalysisReport["statistical_summary"];

    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.blockers).toContain("Evidence goes beyond a single thin run");
    expect(result.ceiling_type).toBe("research_memo");
  });

  it("blocks paper-scale promotion for tiny one-example gains without repeated seeds", () => {
    const input = fullInput();
    input.topic = "bounded configuration tuning";
    input.report.results_artifact.metrics[0].unit = "ratio";
    input.report.results_artifact.observations[0].value = 4 / 12;
    input.report.results_artifact.observations[1].value = 5 / 12;
    input.report.results_artifact.comparisons[0].delta = 1 / 12;
    input.report.metrics = {
      run_config: {
        max_steps: 4
      },
      condition_results: [
        {
          condition_marker: "reference_condition",
          seeds: [],
          seed_count: 0,
          steps_completed: 4
        },
        {
          condition_marker: "candidate_condition",
          seeds: [],
          seed_count: 0,
          steps_completed: 4
        }
      ]
    };
    input.report.statistical_summary.confidence_intervals = [
      {
        metric_key: "metric-quality",
        label: "Structured interval",
        lower: 0.1,
        upper: 0.7,
        level: 0.95,
        sample_size: 12,
        source: "condition_metrics",
        summary: "Small-sample interval evidence."
      }
    ];

    const result = evaluateMinimumGate(input);

    expect(result.passed).toBe(false);
    expect(result.failed_checks).toEqual(
      expect.arrayContaining([
        "evaluation_sample_size",
        "seed_replication",
        "effect_granularity",
        "training_budget_depth"
      ])
    );
    expect(result.ceiling_type).toBe("blocked_for_paper_scale");
    expect(result.paper_scale_diagnostics?.map((diagnostic) => diagnostic.id)).toEqual(
      expect.arrayContaining(["tiny_eval_sample", "missing_seed_replication", "single_item_gain", "thin_training_budget"])
    );
  });

  it("rejects positive incomplete comparisons when seed, execution, and training coverage are missing", () => {
    const input = fullInput();
    input.report.overview = {
      objective_status: "not_met",
      objective_summary: "Observed gain stays below the target.",
      observed_value: 0.004,
      execution_runs: 2
    };
    input.report.results_artifact.metrics[0].unit = "ratio";
    input.report.results_artifact.observations[0].value = 0.7;
    input.report.results_artifact.observations[1].value = 0.704;
    input.report.results_artifact.comparisons[0].delta = 0.004;
    input.report.metrics = {
      run_config: {
        max_steps: 30,
        optimizer_steps: 30,
        max_train_samples: 60,
        planned_max_train_samples: 600
      },
      condition_results: [
        { condition_marker: "reference_condition", seeds: [], seed_count: 0 },
        { condition_marker: "candidate_condition", seeds: [], seed_count: 0 }
      ]
    };
    input.report.statistical_summary = {
      total_trials: 6,
      executed_trials: 2,
      cached_trials: 0,
      confidence_intervals: [
        {
          metric_key: "metric-quality",
          label: "Candidate outcome interval",
          lower: 0.68,
          upper: 0.73,
          level: 0.95,
          sample_size: 120,
          source: "condition_metrics",
          summary: "Item-level interval."
        }
      ],
      stability_metrics: [],
      effect_estimates: [
        {
          comparison_id: "comparison-quality",
          metric_key: "metric-quality",
          delta: 0.004,
          direction: "positive",
          summary: "Small positive delta."
        }
      ],
      notes: []
    };

    const result = evaluateMinimumGate(input);
    const diagnosticIds = result.paper_scale_diagnostics?.map((diagnostic) => diagnostic.id) ?? [];

    expect(diagnosticIds).toEqual(
      expect.arrayContaining([
        "missing_seed_replication",
        "incomplete_planned_runs",
        "training_budget_mismatch"
      ])
    );
    expect(result.checks.find((check) => check.id === "evidence_depth")?.passed).toBe(false);
    expect(result.checks.find((check) => check.id === "seed_replication")?.passed).toBe(false);
    expect(result.checks.find((check) => check.id === "planned_execution_coverage")?.passed).toBe(false);
    expect(result.checks.find((check) => check.id === "training_budget_depth")?.passed).toBe(false);
  });

  it("includes ISO timestamp in evaluated_at", () => {
    const result = evaluateMinimumGate(fullInput());
    expect(result.evaluated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("uses the explicit V2 comparison when summary and analysis comparisons are absent", () => {
    const input = fullInput();
    input.presence.baselineSummaryPresent = false;
    input.report.condition_comparisons = [];
    const result = evaluateMinimumGate(input);
    const baselineCheck = result.checks.find(c => c.id === "baseline_or_comparator");
    expect(baselineCheck?.passed).toBe(true);
    expect(baselineCheck?.detail).toContain("comparison-quality");
  });

  it("uses condition result seed arrays as repeated-seed evidence", () => {
    const input = fullInput();
    input.report.metrics = {
      run_config: { seed: 36 },
      condition_results: [
        {
          condition_marker: "reference_condition",
          seeds: [42, 43, 44],
          seed_count: 3,
          correct_count: 132,
          total_count: 288,
          evaluation: {
            validation_partition: { correct_count: 69, total_count: 144 },
            held_out_partition: { correct_count: 63, total_count: 144 }
          }
        },
        {
          condition_marker: "candidate_condition",
          seeds: [42, 43, 44],
          seed_count: 3,
          correct_count: 138,
          total_count: 288,
          evaluation: {
            validation_partition: { correct_count: 69, total_count: 144 },
            held_out_partition: { correct_count: 69, total_count: 144 }
          }
        }
      ]
    } as unknown as AnalysisReport["metrics"];

    const result = evaluateMinimumGate(input);

    expect(result.paper_scale_diagnostics?.map((diagnostic) => diagnostic.id)).not.toContain(
      "missing_seed_replication"
    );
    expect(result.checks.find((check) => check.id === "seed_replication")?.passed).toBe(true);
  });
});

function setSeriesRole(
  series: { role?: ResultsSeriesRole },
  role: ResultsSeriesRole | undefined
): void {
  if (role === undefined) {
    delete series.role;
    return;
  }
  series.role = role;
}

function setMetricUnit(metric: { unit?: string }, unit: string | undefined): void {
  if (unit === undefined) {
    delete metric.unit;
    return;
  }
  metric.unit = unit;
}
