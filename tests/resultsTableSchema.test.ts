import { describe, expect, it } from "vitest";

import {
  adaptResultsTableSchemaV1ToV2,
  buildResultsTableSchema,
  checkResultsContractCompleteness,
  validateResultsArtifactV2,
  validateResultsPlanV2,
  type ResultsArtifactV2,
  type ResultsPlanV2,
  type ResultsSeriesRole,
  type ResultsTableSchema
} from "../src/core/analysis/resultsTableSchema.js";

const COMPARISON_ROLE_CASES: Array<{
  name: string;
  subjectRole: ResultsSeriesRole | undefined;
  referenceRole: ResultsSeriesRole | undefined;
  valid: boolean;
}> = [
  { name: "primary versus baseline", subjectRole: "primary", referenceRole: "baseline", valid: true },
  { name: "comparator versus baseline", subjectRole: "comparator", referenceRole: "baseline", valid: true },
  { name: "missing subject role", subjectRole: undefined, referenceRole: "baseline", valid: false },
  { name: "missing reference role", subjectRole: "primary", referenceRole: undefined, valid: false },
  { name: "reversed primary comparison", subjectRole: "baseline", referenceRole: "primary", valid: false },
  { name: "baseline versus baseline", subjectRole: "baseline", referenceRole: "baseline", valid: false },
  { name: "primary versus primary", subjectRole: "primary", referenceRole: "primary", valid: false },
  { name: "control subject", subjectRole: "control", referenceRole: "baseline", valid: false },
  { name: "other subject", subjectRole: "other", referenceRole: "baseline", valid: false },
  { name: "control reference", subjectRole: "primary", referenceRole: "control", valid: false },
  { name: "other reference", subjectRole: "primary", referenceRole: "other", valid: false }
];

describe("resultsTableSchema", () => {
  it("keeps V1 metric filtering and direction inference behavior", () => {
    const rows = buildResultsTableSchema(
      [
        "Primary metric: response mismatch rate",
        "Incorrect output count and rate",
        "Hidden failed-or-incomplete item count and rate",
        "Successful completion count and rate",
        "primary_score_delta_vs_baseline"
      ],
      "higher_better"
    );

    expect(rows).toEqual([
      expect.objectContaining({ metric: "Incorrect output count and rate", direction: "lower_better" }),
      expect.objectContaining({ metric: "Hidden failed-or-incomplete item count and rate", direction: "lower_better" }),
      expect.objectContaining({ metric: "Successful completion count and rate", direction: "higher_better" }),
      expect.objectContaining({ metric: "primary_score_delta_vs_baseline", direction: "higher_better" })
    ]);
    expect(rows.map((row) => row.metric)).not.toContain("Primary metric: response mismatch rate");
  });

  it("excludes prose metric descriptions that cannot be populated as result-table keys", () => {
    const rows = buildResultsTableSchema(
      [
        "Primary metric within each condition: mean score and relative change",
        "Partition score with raw accepted and reviewed counts across evaluation partitions",
        "primary_score_delta_vs_baseline",
        "mean_primary_score"
      ],
      "higher_better"
    );

    expect(rows.map((row) => row.metric)).toEqual([
      "primary_score_delta_vs_baseline",
      "mean_primary_score"
    ]);
  });

  it("validates normalized results with three series, arbitrary dimensions, and scoped metrics", () => {
    const artifact = buildNormalizedArtifact();

    expect(validateResultsArtifactV2(artifact)).toEqual({ valid: true, issues: [] });
    expect(artifact.series).toHaveLength(3);
    expect(artifact.series[0].dimensions).toMatchObject({ environment: "shared", repetition: 1 });
    expect(artifact.observations[0].scope).toEqual({ partition: "evaluation", fold: 1 });
  });

  it("reports invalid directions, nonfinite numbers, and non-scalar dimensions or scopes", () => {
    const valid = buildNormalizedArtifact();
    const artifact = {
      ...valid,
      metrics: [
        { ...valid.metrics[0], direction: "sideways" },
        ...valid.metrics.slice(1)
      ],
      series: [
        {
          ...valid.series[0],
          dimensions: { environment: { name: "nested" }, repetition: Number.POSITIVE_INFINITY }
        },
        ...valid.series.slice(1)
      ],
      observations: [
        {
          ...valid.observations[0],
          scope: { partition: ["evaluation"], fold: 1 },
          value: Number.NaN
        },
        ...valid.observations.slice(1)
      ],
      comparisons: [
        { ...valid.comparisons[0], delta: Number.NEGATIVE_INFINITY },
        ...valid.comparisons.slice(1)
      ]
    };

    const validation = validateResultsArtifactV2(artifact);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("metrics[0].direction"),
      expect.stringContaining("series[0].dimensions"),
      expect.stringContaining("observations[0].scope"),
      expect.stringContaining("observations[0].value must be a finite number"),
      expect.stringContaining("comparisons[0].delta must be a finite number")
    ]));
  });

  it("reports dangling series, metric, and observation references", () => {
    const artifact = buildNormalizedArtifact();
    artifact.observations[0].series_id = "series-absent";
    artifact.observations[1].metric_id = "metric-absent";
    artifact.comparisons[0].subject_observation_id = "observation-absent";

    const validation = validateResultsArtifactV2(artifact);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("references unknown series id \"series-absent\""),
      expect.stringContaining("references unknown metric id \"metric-absent\""),
      expect.stringContaining("references unknown observation id \"observation-absent\"")
    ]));
  });

  it("reports duplicate stable IDs in every artifact collection", () => {
    const artifact = buildNormalizedArtifact();
    artifact.metrics[1].id = artifact.metrics[0].id;
    artifact.series[1].id = artifact.series[0].id;
    artifact.observations[1].id = artifact.observations[0].id;
    artifact.comparisons[1].id = artifact.comparisons[0].id;

    const validation = validateResultsArtifactV2(artifact);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("metrics[1].id duplicates"),
      expect.stringContaining("series[1].id duplicates"),
      expect.stringContaining("observations[1].id duplicates"),
      expect.stringContaining("comparisons[1].id duplicates")
    ]));
  });

  it("rejects duplicate semantic observations and comparisons even with unique IDs", () => {
    const artifact = buildNormalizedArtifact();
    artifact.observations.push({
      ...artifact.observations[0],
      id: "reference_primary_observation-duplicate"
    });
    artifact.comparisons.push({
      ...artifact.comparisons[0],
      id: "candidate_a_primary_comparison-duplicate"
    });

    const validation = validateResultsArtifactV2(artifact);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("duplicates the series, metric, and scope"),
      expect.stringContaining("duplicates the subject/reference pair")
    ]));
  });

  it("allows floating-point noise but rejects a comparison delta mismatch", () => {
    const artifact = buildNormalizedArtifact();
    artifact.comparisons[0].delta = 6 + 5e-10;
    expect(validateResultsArtifactV2(artifact).valid).toBe(true);

    artifact.comparisons[0].delta = 6.001;
    const validation = validateResultsArtifactV2(artifact);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual([
      expect.stringContaining("delta must equal subject value minus reference value")
    ]);
  });

  it("rejects comparisons across different metrics even when the arithmetic matches", () => {
    const artifact = buildNormalizedArtifact();
    artifact.comparisons[0].subject_observation_id = "candidate_a_secondary_observation";
    artifact.comparisons[0].delta = 25;

    const validation = validateResultsArtifactV2(artifact);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual([
      expect.stringContaining("must compare observations for the same metric")
    ]);
  });

  it.each(COMPARISON_ROLE_CASES)(
    "applies fail-closed comparison roles to artifact, plan, and completeness: $name",
    ({ subjectRole, referenceRole, valid }) => {
      const artifact = buildNormalizedArtifact();
      const plan = buildNormalizedPlan();
      setSeriesRole(artifact.series[1], subjectRole);
      setSeriesRole(artifact.series[0], referenceRole);
      setSeriesRole(plan.required_series![1], subjectRole);
      setSeriesRole(plan.required_series![0], referenceRole);

      const artifactValidation = validateResultsArtifactV2(artifact);
      const planValidation = validateResultsPlanV2(plan);
      const completeness = checkResultsContractCompleteness(artifact, plan);

      expect(artifactValidation.valid).toBe(valid);
      expect(planValidation.valid).toBe(valid);
      expect(completeness.complete).toBe(valid);
      if (!valid) {
        expect([...artifactValidation.issues, ...planValidation.issues]).toEqual(
          expect.arrayContaining([expect.stringMatching(/requires (subject|reference) series role/u)])
        );
      }
    }
  );

  it.each([
    { name: "explicit unitless", unit: "unitless", valid: true },
    { name: "missing unit", unit: undefined, valid: false },
    { name: "blank unit", unit: "   ", valid: false }
  ])(
    "requires an explicit non-empty metric unit across artifact, plan, and completeness: $name",
    ({ unit, valid }) => {
      const artifact = buildNormalizedArtifact();
      const plan = buildNormalizedPlan();
      setMetricUnit(artifact.metrics[0], unit);
      setMetricUnit(plan.required_metrics[0], unit);

      const artifactValidation = validateResultsArtifactV2(artifact);
      const planValidation = validateResultsPlanV2(plan);
      const completeness = checkResultsContractCompleteness(artifact, plan);

      expect(artifactValidation.valid).toBe(valid);
      expect(planValidation.valid).toBe(valid);
      expect(completeness.complete).toBe(valid);
      if (!valid) {
        expect(artifactValidation.issues).toContain(
          "results_artifact.metrics[0].unit must be a non-empty string."
        );
        expect(planValidation.issues).toContain(
          "results_plan.required_metrics[0].unit must be a non-empty string."
        );
      }
      expect(artifact.metrics[0].unit).toBe(unit);
      expect(plan.required_metrics[0].unit).toBe(unit);
    }
  );

  it.each([
    { name: "one required comparison", comparisonCount: 1 },
    { name: "multiple required comparisons", comparisonCount: 2 }
  ])("requires primary_comparison_id for $name", ({ comparisonCount }) => {
    const plan = buildNormalizedPlan();
    plan.required_comparisons = plan.required_comparisons!.slice(0, comparisonCount);
    plan.minimum_comparison_count = comparisonCount;
    delete plan.primary_comparison_id;

    const validation = validateResultsPlanV2(plan);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toContain(
      "results_plan.primary_comparison_id is required when results_plan.required_comparisons includes one or more comparisons."
    );
    expect(checkResultsContractCompleteness(buildNormalizedArtifact(), plan).complete).toBe(false);
  });

  it("keeps plans observation-free and checks integrity plus minimum completeness", () => {
    const artifact = buildNormalizedArtifact();
    const plan = buildNormalizedPlan();

    expect(validateResultsPlanV2(plan)).toEqual({ valid: true, issues: [] });
    expect(checkResultsContractCompleteness(artifact, plan)).toEqual({ complete: true, issues: [] });

    const roleMismatch = buildNormalizedArtifact();
    roleMismatch.series[0].role = "control";
    expect(checkResultsContractCompleteness(roleMismatch, plan).issues).toEqual(
      expect.arrayContaining([expect.stringContaining("requires reference series role baseline")])
    );

    const directionMismatch = buildNormalizedArtifact();
    directionMismatch.metrics[0].direction = "lower_better";
    expect(checkResultsContractCompleteness(directionMismatch, plan).issues).toContain(
      `results_plan.required_metrics[0] requires direction "higher_better" for metric "primary_score", received "lower_better".`
    );

    const unitMismatch = buildNormalizedArtifact();
    unitMismatch.metrics[0].unit = "percent";
    expect(checkResultsContractCompleteness(unitMismatch, plan).issues).toContain(
      `results_plan.required_metrics[0] requires unit "points" for metric "primary_score", received "percent".`
    );

    const comparisonMismatchPlan: ResultsPlanV2 = {
      ...plan,
      required_comparisons: plan.required_comparisons?.map(
        (comparison, index) => index === 0 ? { ...comparison, id: "comparison-absent" } : comparison
      ),
      primary_comparison_id: "comparison-absent"
    };
    expect(checkResultsContractCompleteness(artifact, comparisonMismatchPlan).issues).toEqual(
      expect.arrayContaining([expect.stringContaining("missing comparison id \"comparison-absent\"")])
    );

    const planWithObservations = { ...plan, observations: [] };
    expect(validateResultsPlanV2(planWithObservations).issues).toContain(
      "results_plan.observations is not allowed; plans declare requirements only."
    );

    const ambiguousPrimaryPlan = { ...plan, primary_comparison_id: undefined };
    expect(validateResultsPlanV2(ambiguousPrimaryPlan).issues).toContain(
      "results_plan.primary_comparison_id is required when results_plan.required_comparisons includes one or more comparisons."
    );

    const undersizedPlan = {
      ...plan,
      minimum_series_count: 4,
      minimum_comparison_count: 4
    };
    expect(checkResultsContractCompleteness(artifact, undersizedPlan).issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("below minimum_series_count 4"),
        expect.stringContaining("below minimum_comparison_count 4")
      ])
    );

    const missingRequiredObservation = buildNormalizedArtifact();
    missingRequiredObservation.observations = missingRequiredObservation.observations.filter(
      (observation) => observation.metric_id !== "secondary_score"
    );
    missingRequiredObservation.comparisons = missingRequiredObservation.comparisons.filter(
      (comparison) => comparison.id !== "candidate_a_secondary_comparison"
    );
    expect(checkResultsContractCompleteness(missingRequiredObservation, plan).issues).toContain(
      "required metric id \"secondary_score\" has no observation."
    );

    const brokenArtifact = buildNormalizedArtifact();
    brokenArtifact.comparisons[0].reference_observation_id = "observation-absent";
    expect(checkResultsContractCompleteness(brokenArtifact, plan).issues).toEqual([
      expect.stringContaining("references unknown observation id")
    ]);
  });

  it("validates a primary effect criterion against the primary comparison and raw metric", () => {
    const plan = buildNormalizedPlan();
    plan.primary_effect_criterion = {
      comparison_id: "candidate_a_primary_comparison",
      metric_id: "primary_score",
      metric_scale: "proportion",
      direction: "maximize",
      effect_criterion: {
        basis: "delta_vs_reference",
        magnitude: 5,
        scale: "percentage_point",
        inclusive: true
      }
    };

    expect(validateResultsPlanV2(plan)).toEqual({ valid: true, issues: [] });

    const drifted = {
      ...plan,
      primary_effect_criterion: {
        ...plan.primary_effect_criterion,
        comparison_id: "candidate_a_secondary_comparison"
      }
    };
    expect(validateResultsPlanV2(drifted).issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("comparison_id must equal results_plan.primary_comparison_id")
      ])
    );
  });

  it("keeps V1 adaptation deterministic without inventing paper-facing metric units", () => {
    const v1Rows: ResultsTableSchema = [
      {
        metric: "Primary label retained verbatim",
        baseline: 10,
        comparator: 12,
        delta: 2,
        direction: "higher_better"
      },
      {
        metric: "Secondary label retained verbatim",
        baseline: 8,
        comparator: 6,
        delta: 999,
        direction: "lower_better"
      }
    ];

    const converted = adaptResultsTableSchemaV1ToV2(v1Rows);
    const repeated = adaptResultsTableSchemaV1ToV2(v1Rows);
    const reordered = adaptResultsTableSchemaV1ToV2([...v1Rows].reverse());

    expect(converted).toEqual(repeated);
    expect(converted.schema_version).toBe("2.0");
    expect(converted.series.map(({ role }) => role)).toEqual(["baseline", "comparator"]);
    expect(converted.metrics.map(({ label, direction }) => ({ label, direction }))).toEqual([
      { label: "Primary label retained verbatim", direction: "higher_better" },
      { label: "Secondary label retained verbatim", direction: "lower_better" }
    ]);
    expect(converted.observations).toHaveLength(4);
    expect(converted.comparisons).toHaveLength(2);
    expect(converted.comparisons[1].delta).toBe(-2);
    expect(converted.metrics.every((metric) => !Object.hasOwn(metric, "unit"))).toBe(true);
    expect(validateResultsArtifactV2(converted)).toEqual({
      valid: false,
      issues: [
        "results_artifact.metrics[0].unit must be a non-empty string.",
        "results_artifact.metrics[1].unit must be a non-empty string."
      ]
    });

    const reorderedMetricIds = new Map(reordered.metrics.map((metric) => [metric.label, metric.id]));
    for (const metric of converted.metrics) {
      expect(reorderedMetricIds.get(metric.label)).toBe(metric.id);
    }
  });
});

function buildNormalizedArtifact(): ResultsArtifactV2 {
  return {
    schema_version: "2.0",
    metrics: [
      {
        id: "primary_score",
        label: "Primary score",
        direction: "higher_better",
        unit: "points"
      },
      {
        id: "secondary_score",
        label: "Secondary score",
        direction: "lower_better",
        unit: "ms"
      }
    ],
    series: [
      {
        id: "reference",
        label: "Reference",
        role: "baseline",
        dimensions: { environment: "shared", repetition: 1, cached: false, note: null }
      },
      {
        id: "candidate_a",
        label: "Candidate A",
        role: "primary",
        dimensions: { environment: "shared", repetition: 1, cached: true, note: null }
      },
      {
        id: "candidate_b",
        label: "Candidate B",
        role: "comparator",
        dimensions: { environment: "alternate", repetition: 2, cached: false, note: null }
      }
    ],
    observations: [
      {
        id: "reference_primary_observation",
        series_id: "reference",
        metric_id: "primary_score",
        scope: { partition: "evaluation", fold: 1 },
        value: 70,
        evidence_refs: ["evidence/reference-primary.json"]
      },
      {
        id: "candidate_a_primary_observation",
        series_id: "candidate_a",
        metric_id: "primary_score",
        scope: { partition: "evaluation", fold: 1 },
        value: 76,
        evidence_refs: ["evidence/candidate-a-primary.json"]
      },
      {
        id: "candidate_b_primary_observation",
        series_id: "candidate_b",
        metric_id: "primary_score",
        scope: { partition: "evaluation", fold: 1 },
        value: 72
      },
      {
        id: "reference_secondary_observation",
        series_id: "reference",
        metric_id: "secondary_score",
        scope: { partition: "evaluation", fold: 1 },
        value: 120
      },
      {
        id: "candidate_a_secondary_observation",
        series_id: "candidate_a",
        metric_id: "secondary_score",
        scope: { partition: "evaluation", fold: 1 },
        value: 95
      }
    ],
    comparisons: [
      {
        id: "candidate_a_primary_comparison",
        subject_observation_id: "candidate_a_primary_observation",
        reference_observation_id: "reference_primary_observation",
        delta: 6,
        judgement: "better",
        evidence_refs: ["evidence/candidate-a-comparison.json"]
      },
      {
        id: "candidate_b_primary_comparison",
        subject_observation_id: "candidate_b_primary_observation",
        reference_observation_id: "reference_primary_observation",
        delta: 2
      },
      {
        id: "candidate_a_secondary_comparison",
        subject_observation_id: "candidate_a_secondary_observation",
        reference_observation_id: "reference_secondary_observation",
        delta: -25,
        judgement: "better"
      }
    ]
  };
}

function buildNormalizedPlan(): ResultsPlanV2 {
  return {
    schema_version: "2.0",
    required_metrics: [
      {
        id: "primary_score",
        label: "Primary score",
        direction: "higher_better",
        unit: "points"
      },
      {
        id: "secondary_score",
        label: "Secondary score",
        direction: "lower_better",
        unit: "ms"
      }
    ],
    minimum_series_count: 3,
    minimum_comparison_count: 2,
    required_series: [
      { id: "reference", role: "baseline" },
      { id: "candidate_a", role: "primary" }
    ],
    required_comparisons: [
      {
        id: "candidate_a_primary_comparison",
        subject_series_id: "candidate_a",
        reference_series_id: "reference",
        metric_id: "primary_score",
        scope: { fold: 1, partition: "evaluation" }
      },
      {
        id: "candidate_a_secondary_comparison",
        subject_series_id: "candidate_a",
        reference_series_id: "reference",
        metric_id: "secondary_score",
        scope: { partition: "evaluation", fold: 1 }
      }
    ],
    primary_comparison_id: "candidate_a_primary_comparison"
  };
}

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
