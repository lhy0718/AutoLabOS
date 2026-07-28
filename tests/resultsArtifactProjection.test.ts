import { describe, expect, it } from "vitest";

import {
  projectResultsArtifactV2
} from "../src/core/analysis/resultsArtifactProjection.js";
import {
  validateResultsArtifactV2,
  type ResultsArtifactV2
} from "../src/core/analysis/resultsTableSchema.js";

describe("projectResultsArtifactV2", () => {
  it("projects four conditions with arbitrary dimensions and every explicit subject role", () => {
    const result = projectResultsArtifactV2({
      metrics: {
        baseline_condition: "reference_protocol",
        metric_definitions: [
          {
            id: "response_stability",
            label: "Response stability",
            direction: "higher_better",
            unit: "ratio"
          },
          {
            id: "resource_cost",
            label: "Resource cost",
            direction: "lower_better",
            unit: "credits"
          }
        ],
        condition_results: [
          {
            condition_id: "replication_protocol",
            role: "primary",
            dimensions: {
              execution_profile: "replicated",
              revision: 3,
              verified: true,
              note: null
            },
            scope: { evaluation_partition: "held_out", round: 2 },
            metrics: { response_stability: 0.78, resource_cost: 6 }
          },
          {
            condition_id: "reference_protocol",
            dimensions: {
              execution_profile: "reference",
              revision: 1,
              verified: true,
              note: null
            },
            scope: { evaluation_partition: "held_out", round: 2 },
            metrics: { response_stability: 0.7, resource_cost: 8 }
          },
          {
            condition_id: "candidate_protocol",
            role: "primary",
            dimensions: {
              execution_profile: "candidate",
              revision: 2,
              verified: false,
              note: null
            },
            scope: { evaluation_partition: "held_out", round: 2 },
            metrics: { response_stability: 0.82, resource_cost: 5 }
          },
          {
            condition_id: "alternate_protocol",
            role: "comparator",
            dimensions: {
              execution_profile: "alternate",
              revision: 4,
              verified: true,
              note: null
            },
            scope: { evaluation_partition: "held_out", round: 2 },
            metrics: { response_stability: 0.74, resource_cost: 7 }
          }
        ]
      },
      evidenceRef: "evidence/condition-summary.json"
    });

    expect(result.valid).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.issues).toEqual([]);
    expect(validateResultsArtifactV2(result.artifact)).toEqual({ valid: true, issues: [] });
    expect(result.artifact.series).toHaveLength(4);
    expect(result.artifact.observations).toHaveLength(8);
    expect(result.artifact.comparisons).toHaveLength(6);
    expect(
      Object.fromEntries(result.artifact.series.map((series) => [series.id, series.role]))
    ).toEqual({
      alternate_protocol: "comparator",
      candidate_protocol: "primary",
      reference_protocol: "baseline",
      replication_protocol: "primary"
    });
    expect(
      result.artifact.series.find((series) => series.id === "candidate_protocol")?.dimensions
    ).toEqual({
      execution_profile: "candidate",
      note: null,
      revision: 2,
      verified: false
    });
    expect(
      result.artifact.metrics.find((metric) => metric.id === "resource_cost")
    ).toMatchObject({
      label: "Resource cost",
      direction: "lower_better",
      unit: "credits"
    });
    expect(
      result.artifact.observations.every(
        (observation) =>
          observation.evidence_refs?.[0] === "evidence/condition-summary.json"
      )
    ).toBe(true);
    expect(
      result.artifact.comparisons.every(
        (comparison) =>
          comparison.evidence_refs?.[0] === "evidence/condition-summary.json"
      )
    ).toBe(true);
  });

  it("does not infer metric direction from a metric name", () => {
    const result = projectResultsArtifactV2({
      metrics: {
        baseline_condition: "reference_protocol",
        primary_condition: "candidate_protocol",
        metric_definitions: {
          loss_named_measure: {
            label: "Loss-named measure",
            unit: "points"
          }
        },
        conditions: [
          {
            condition_id: "reference_protocol",
            metrics: { loss_named_measure: 4 }
          },
          {
            condition_id: "candidate_protocol",
            metrics: { loss_named_measure: 3 }
          }
        ]
      },
      primaryMetricId: "loss_named_measure",
      fallbackDirection: "higher_better"
    });

    expect(result.valid).toBe(true);
    expect(result.artifact.metrics[0]?.direction).toBe("higher_better");
    expect(result.artifact.metrics[0]?.unit).toBe("points");
    expect(result.warnings).toContain(
      'metrics.metric_definitions["loss_named_measure"].direction is absent; fallbackDirection was used.'
    );
  });

  it("preserves zero and negative scoped values and compares only shared scopes", () => {
    const result = projectResultsArtifactV2({
      metrics: {
        metric_definitions: {
          net_effect: {
            label: "Net effect",
            direction: "higher_better",
            unit: "points"
          }
        },
        conditions: [
          {
            condition_id: "reference_protocol",
            role: "baseline",
            scope: { evaluation_phase: "confirmatory" },
            metrics: {
              net_effect: [
                {
                  value: 0,
                  scope: {
                    evaluation_partition: "validation",
                    locale_band: "north",
                    repeat: 1
                  }
                },
                {
                  value: -3,
                  scope: {
                    evaluation_partition: "validation",
                    locale_band: "south",
                    repeat: 1
                  }
                }
              ]
            }
          },
          {
            condition_id: "candidate_protocol",
            role: "primary",
            scope: { evaluation_phase: "confirmatory" },
            metrics: {
              net_effect: [
                {
                  value: -1,
                  scope: {
                    evaluation_partition: "validation",
                    locale_band: "north",
                    repeat: 1
                  }
                },
                {
                  value: -5,
                  scope: {
                    evaluation_partition: "validation",
                    locale_band: "south",
                    repeat: 1
                  }
                },
                {
                  value: 4,
                  scope: {
                    evaluation_partition: "validation",
                    locale_band: "west",
                    repeat: 1
                  }
                }
              ]
            }
          }
        ]
      }
    });

    expect(result.valid).toBe(true);
    expect(
      result.artifact.observations
        .map((observation) => observation.value)
        .sort((left, right) => left - right)
    ).toEqual([-5, -3, -1, 0, 4]);
    expect(result.artifact.comparisons.map((comparison) => comparison.delta)).toEqual([
      -1,
      -2
    ]);
    expect(
      result.artifact.observations.find((observation) => observation.value === 0)?.scope
    ).toEqual({
      evaluation_partition: "validation",
      evaluation_phase: "confirmatory",
      locale_band: "north",
      repeat: 1
    });
  });

  it("keeps observations but creates no comparisons when no role or pair is declared", () => {
    const result = projectResultsArtifactV2({
      metrics: {
        metric_definitions: {
          signal_strength: {
            label: "Signal strength",
            direction: "higher_better",
            unit: "ratio"
          }
        },
        conditions: [
          {
            condition_id: "reference_protocol",
            metrics: { signal_strength: 0.4 }
          },
          {
            condition_id: "candidate_protocol",
            metrics: { signal_strength: 0.6 }
          }
        ]
      }
    });

    expect(result.valid).toBe(true);
    expect(result.artifact.observations).toHaveLength(2);
    expect(result.artifact.comparisons).toEqual([]);
    expect(result.artifact.series.every((series) => series.role === undefined)).toBe(true);
  });

  it("fails closed for explicit comparison rows without required condition roles", () => {
    const result = projectResultsArtifactV2({
      metrics: {
        metric_definitions: {
          consistency_index: {
            label: "Consistency index",
            direction: "higher_better",
            unit: "ratio"
          }
        },
        conditions: [
          {
            condition_id: "reference_protocol",
            metrics: { consistency_index: 0.5 }
          },
          {
            condition_id: "candidate_protocol",
            metrics: { consistency_index: 0.65 }
          }
        ],
        comparisons: [
          {
            subject_condition: "candidate_protocol",
            reference_condition: "reference_protocol"
          }
        ]
      }
    });

    expect(result.valid).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.artifact).toEqual({
      schema_version: "2.0",
      metrics: [],
      series: [],
      observations: [],
      comparisons: []
    });
    expect(result.issues).toEqual([
      "Projected artifact validation failed: results_artifact.comparisons[0] requires subject series role primary or comparator; received unspecified.",
      "Projected artifact validation failed: results_artifact.comparisons[0] requires reference series role baseline; received unspecified."
    ]);
  });

  it("excludes undeclared flat numeric metadata while admitting every declared source", () => {
    const result = projectResultsArtifactV2({
      primaryMetricId: "outcome_score",
      preferredMetricIds: ["consistency_index"],
      metrics: {
        reporting_metrics: ["resource_use"],
        metric_definitions: {
          consistency_index: {
            label: "Consistency index",
            direction: "higher_better",
            unit: "ratio"
          },
          nested_signal: {
            label: "Nested signal",
            direction: "higher_better",
            unit: "points"
          },
          outcome_score: {
            label: "Outcome score",
            direction: "higher_better",
            unit: "ratio"
          },
          resource_use: {
            label: "Resource use",
            direction: "lower_better",
            unit: "credits"
          }
        },
        condition_summaries: [
          {
            condition_id: "reference_protocol",
            outcome_score: 0,
            consistency_index: -0.1,
            resource_use: 3,
            seed: 17,
            sample_count: 40,
            status_code: 200,
            runtime_ms: 900,
            metrics: {
              nested_signal: -2
            }
          }
        ]
      }
    });

    expect(result.valid).toBe(true);
    expect(result.artifact.metrics.map((metric) => metric.id)).toEqual([
      "consistency_index",
      "nested_signal",
      "outcome_score",
      "resource_use"
    ]);
    expect(
      result.artifact.observations
        .map((observation) => observation.value)
        .sort((left, right) => left - right)
    ).toEqual([-2, -0.1, 0, 3]);
    expect(result.artifact.metrics.map((metric) => metric.id)).not.toEqual(
      expect.arrayContaining(["seed", "sample_count", "status_code", "runtime_ms"])
    );
  });

  it("uses nested metrics ahead of admitted flat values and supports condition_metrics maps", () => {
    const result = projectResultsArtifactV2({
      primaryMetricId: "outcome_score",
      metrics: {
        metric_definitions: {
          outcome_score: {
            label: "Outcome score",
            direction: "higher_better",
            unit: "points"
          }
        },
        conditions: [
          {
            condition_id: "reference_protocol",
            role: "baseline",
            dimensions: { execution_profile: "reference" }
          }
        ],
        condition_metrics: {
          reference_protocol: {
            outcome_score: 99,
            metrics: { outcome_score: 1 }
          },
          candidate_protocol: {
            role: "comparator",
            dimensions: { execution_profile: "candidate" },
            outcome_score: 100,
            metrics: { outcome_score: 2 }
          }
        }
      }
    });

    expect(result.valid).toBe(true);
    expect(result.artifact.series.map((series) => series.id)).toEqual([
      "candidate_protocol",
      "reference_protocol"
    ]);
    expect(result.artifact.observations.map((observation) => observation.value)).toEqual([
      2,
      1
    ]);
    expect(result.artifact.comparisons).toHaveLength(1);
    expect(result.artifact.comparisons[0].delta).toBe(1);
  });

  it("returns a defensive contract-only copy of an authoritative explicit V2 artifact", () => {
    const explicit = buildExplicitArtifact();
    const rawExplicit = {
      ...explicit,
      ignored_top_level_field: "not part of V2",
      metrics: explicit.metrics.map((metric) => ({
        ...metric,
        ignored_metric_field: true
      }))
    };

    const result = projectResultsArtifactV2({
      metrics: {
        results_artifact: rawExplicit,
        conditions: [
          {
            condition_id: "fallback_protocol",
            role: "primary",
            metrics: { ignored_signal: 100 }
          }
        ]
      }
    });

    expect(result.source).toBe("explicit_results_artifact");
    expect(result.valid).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.artifact).toEqual(explicit);
    expect(result.artifact).not.toBe(rawExplicit);
    expect(result.artifact.metrics).not.toBe(rawExplicit.metrics);
    expect((result.artifact as ResultsArtifactV2 & { ignored_top_level_field?: string })
      .ignored_top_level_field).toBeUndefined();
    expect((result.artifact.metrics[0] as ResultsArtifactV2["metrics"][number] & {
      ignored_metric_field?: boolean;
    }).ignored_metric_field).toBeUndefined();

    explicit.series[0].dimensions.execution_profile = "mutated_after_projection";
    explicit.observations[0].evidence_refs?.push("evidence/late.json");
    expect(result.artifact.series[0].dimensions.execution_profile).toBe("reference");
    expect(result.artifact.observations[0].evidence_refs).toEqual([
      "evidence/explicit.json"
    ]);
  });

  it("blocks fallback projection when an explicit V2 artifact is present but invalid", () => {
    const result = projectResultsArtifactV2({
      metrics: {
        results_artifact: {
          schema_version: "1.0",
          metrics: [],
          series: [],
          observations: [],
          comparisons: []
        },
        conditions: [
          {
            condition_id: "candidate_protocol",
            role: "primary",
            metrics: { outcome_score: 0.9 }
          }
        ]
      }
    });

    expect(result.source).toBe("explicit_results_artifact");
    expect(result.valid).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("present but invalid"),
        expect.stringContaining("schema_version")
      ])
    );
    expect(result.artifact).toEqual({
      schema_version: "2.0",
      metrics: [],
      series: [],
      observations: [],
      comparisons: []
    });
    expect(validateResultsArtifactV2(result.artifact).valid).toBe(true);
  });

  it("reports duplicate condition ids and omits the ambiguous condition", () => {
    const result = projectResultsArtifactV2({
      primaryMetricId: "outcome_score",
      metrics: {
        metric_definitions: {
          outcome_score: {
            label: "Outcome score",
            direction: "higher_better",
            unit: "points"
          }
        },
        conditions: [
          {
            condition_id: "ambiguous_protocol",
            outcome_score: 1
          },
          {
            condition_id: "ambiguous_protocol",
            outcome_score: 2
          },
          {
            condition_id: "independent_protocol",
            outcome_score: -1
          }
        ]
      }
    });

    expect(result.valid).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.issues).toEqual([
      expect.stringContaining('Condition id "ambiguous_protocol" is duplicated or ambiguous')
    ]);
    expect(result.artifact.series.map((series) => series.id)).toEqual([
      "independent_protocol"
    ]);
    expect(result.artifact.observations.map((observation) => observation.value)).toEqual([
      -1
    ]);
    expect(validateResultsArtifactV2(result.artifact).valid).toBe(true);
  });

  it("keeps generated ids and normalized output invariant to condition and metric order", () => {
    const forward = projectResultsArtifactV2({
      metrics: buildOrderInvariantMetrics(false)
    });
    const reversed = projectResultsArtifactV2({
      metrics: buildOrderInvariantMetrics(true)
    });

    expect(forward.valid).toBe(true);
    expect(reversed.valid).toBe(true);
    expect(forward.artifact).toEqual(reversed.artifact);
    expect(allArtifactIds(forward.artifact)).toEqual(allArtifactIds(reversed.artifact));
  });
});

function buildExplicitArtifact(): ResultsArtifactV2 {
  return {
    schema_version: "2.0",
    metrics: [
      {
        id: "outcome_score",
        label: "Outcome score",
        direction: "higher_better",
        unit: "points"
      }
    ],
    series: [
      {
        id: "reference_protocol",
        label: "Reference protocol",
        role: "baseline",
        dimensions: { execution_profile: "reference" }
      },
      {
        id: "candidate_protocol",
        label: "Candidate protocol",
        role: "primary",
        dimensions: { execution_profile: "candidate" }
      }
    ],
    observations: [
      {
        id: "explicit-reference-observation",
        series_id: "reference_protocol",
        metric_id: "outcome_score",
        scope: { evaluation_partition: "held_out" },
        value: 0,
        evidence_refs: ["evidence/explicit.json"]
      },
      {
        id: "explicit-candidate-observation",
        series_id: "candidate_protocol",
        metric_id: "outcome_score",
        scope: { evaluation_partition: "held_out" },
        value: -1
      }
    ],
    comparisons: [
      {
        id: "explicit-comparison",
        subject_observation_id: "explicit-candidate-observation",
        reference_observation_id: "explicit-reference-observation",
        delta: -1
      }
    ]
  };
}

function buildOrderInvariantMetrics(reverse: boolean): Record<string, unknown> {
  const rows = [
    {
      condition_id: "reference_protocol",
      role: "baseline",
      dimensions: { revision: 1, execution_profile: "reference" },
      scope: { repeat: 2, evaluation_partition: "held_out" },
      metrics: { resource_cost: 8, outcome_score: 0.5 }
    },
    {
      condition_id: "candidate_protocol",
      role: "primary",
      dimensions: { execution_profile: "candidate", revision: 2 },
      scope: { evaluation_partition: "held_out", repeat: 2 },
      metrics: { outcome_score: 0.7, resource_cost: 6 }
    },
    {
      condition_id: "replication_protocol",
      role: "comparator",
      dimensions: { revision: 3, execution_profile: "replicated" },
      scope: { repeat: 2, evaluation_partition: "held_out" },
      metrics: { resource_cost: 7, outcome_score: 0.6 }
    }
  ];

  const metricDefinitions = reverse
    ? {
        resource_cost: {
          label: "Resource cost",
          direction: "lower_better",
          unit: "credits"
        },
        outcome_score: {
          label: "Outcome score",
          direction: "higher_better",
          unit: "ratio"
        }
      }
    : {
        outcome_score: {
          direction: "higher_better",
          label: "Outcome score",
          unit: "ratio"
        },
        resource_cost: {
          direction: "lower_better",
          label: "Resource cost",
          unit: "credits"
        }
      };

  return {
    metric_definitions: metricDefinitions,
    conditions: reverse ? [...rows].reverse() : rows
  };
}

function allArtifactIds(artifact: ResultsArtifactV2): string[] {
  return [
    ...artifact.metrics.map((metric) => metric.id),
    ...artifact.series.map((series) => series.id),
    ...artifact.observations.map((observation) => observation.id),
    ...artifact.comparisons.map((comparison) => comparison.id)
  ];
}
