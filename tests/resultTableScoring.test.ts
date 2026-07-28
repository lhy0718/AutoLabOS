import { describe, expect, it } from "vitest";

import type { ResultsArtifactV2 } from "../src/core/analysis/resultsTableSchema.js";
import { scoreResultTableArtifact } from "../src/core/benchmark/resultTableScoring.js";

const FULL_AUTHORIZATION = {
  comparativeClaimAuthorized: true,
  superiorityClaimAuthorized: true,
  superiorityPrimaryMetrics: ["secondary_score"],
  primaryComparisonId: "secondary_comparison"
};

describe("result table scoring", () => {
  it("scores canonical V2 comparisons from explicit metric and observation references", () => {
    const artifact = buildCanonicalArtifact();
    const score = scoreResultTableArtifact(artifact, FULL_AUTHORIZATION);

    expect(score).toMatchObject({
      measured: true,
      valid_schema: true,
      row_count: 2,
      complete_row_count: 2,
      missing_metric_count: 0,
      missing_baseline_count: 0,
      missing_comparator_count: 0,
      missing_delta_count: 0,
      comparator_coverage: 1,
      comparative_claim_supported: true,
      superiority_claim_supported: true
    });
    expect(score.issues).toEqual([]);

    const reordered: ResultsArtifactV2 = {
      ...artifact,
      metrics: [...artifact.metrics].reverse(),
      series: [...artifact.series].reverse(),
      observations: [...artifact.observations].reverse(),
      comparisons: [...artifact.comparisons].reverse()
    };
    expect(scoreResultTableArtifact(reordered, FULL_AUTHORIZATION)).toMatchObject({
      row_count: 2,
      complete_row_count: 2,
      superiority_claim_supported: true
    });
    expect(scoreResultTableArtifact(artifact, {
      ...FULL_AUTHORIZATION,
      superiorityPrimaryMetrics: ["Secondary score"]
    }).superiority_claim_supported).toBe(false);
  });

  it("does not infer authorization or a missing metric direction", () => {
    const artifact = buildCanonicalArtifact();
    expect(scoreResultTableArtifact(artifact)).toMatchObject({
      measured: true,
      valid_schema: true,
      comparative_claim_supported: false,
      superiority_claim_supported: false
    });

    const absentDirection = buildCanonicalArtifact();
    delete (absentDirection.metrics[0] as Partial<ResultsArtifactV2["metrics"][number]>).direction;
    const score = scoreResultTableArtifact(absentDirection, FULL_AUTHORIZATION);

    expect(score).toMatchObject({
      measured: false,
      valid_schema: false,
      row_count: 0,
      complete_row_count: 0,
      comparative_claim_supported: false,
      superiority_claim_supported: false
    });
    expect(score.issues).toContainEqual(expect.objectContaining({
      code: "result_table_schema_invalid",
      message: expect.stringContaining("direction must be higher_better or lower_better")
    }));
  });

  it("does not authorize a canonical comparative claim without an explicit primary comparison id", () => {
    const score = scoreResultTableArtifact(buildCanonicalArtifact(), {
      comparativeClaimAuthorized: true,
      superiorityClaimAuthorized: true,
      superiorityPrimaryMetrics: ["secondary_score"]
    });

    expect(score).toMatchObject({
      measured: true,
      valid_schema: true,
      comparative_claim_supported: false,
      superiority_claim_supported: false
    });
    expect(score.issues).toEqual([
      {
        code: "result_table_primary_comparison_missing",
        row_index: null,
        message: "Canonical V2 comparative claims require an explicit primaryComparisonId bound from ResultsPlanV2.primary_comparison_id."
      }
    ]);
  });

  it("fails closed when a V2 comparison reports the wrong delta", () => {
    const artifact = buildCanonicalArtifact();
    artifact.comparisons[0].delta = -9;

    const score = scoreResultTableArtifact(artifact, FULL_AUTHORIZATION);

    expect(score).toMatchObject({
      measured: false,
      valid_schema: false,
      row_count: 0,
      complete_row_count: 0,
      comparative_claim_supported: false,
      superiority_claim_supported: false
    });
    expect(score.issues).toContainEqual(expect.objectContaining({
      row_index: 0,
      message: expect.stringContaining("delta must equal subject value minus reference value")
    }));
  });

  it("fails closed for cross-metric comparison references", () => {
    const artifact = buildCanonicalArtifact();
    artifact.comparisons[0].reference_observation_id = "reference_primary_observation";
    artifact.comparisons[0].delta = 89.3;

    const score = scoreResultTableArtifact(artifact, FULL_AUTHORIZATION);

    expect(score).toMatchObject({
      measured: false,
      valid_schema: false,
      row_count: 0,
      complete_row_count: 0,
      comparative_claim_supported: false,
      superiority_claim_supported: false
    });
    expect(score.issues).toContainEqual(expect.objectContaining({
      row_index: 0,
      message: expect.stringContaining("must compare observations for the same metric")
    }));
  });

  it("fails closed for missing or ambiguous observation references", () => {
    const missingReference = buildCanonicalArtifact();
    missingReference.comparisons[0].subject_observation_id = "observation-absent";

    const ambiguousReference = buildCanonicalArtifact();
    ambiguousReference.observations.push({
      ...ambiguousReference.observations[0],
      id: ambiguousReference.observations[1].id,
      scope: { partition: "alternate" }
    });

    const missingScore = scoreResultTableArtifact(missingReference, FULL_AUTHORIZATION);
    const ambiguousScore = scoreResultTableArtifact(ambiguousReference, FULL_AUTHORIZATION);
    for (const score of [missingScore, ambiguousScore]) {
      expect(score).toMatchObject({
        measured: false,
        valid_schema: false,
        row_count: 0,
        complete_row_count: 0,
        comparative_claim_supported: false,
        superiority_claim_supported: false
      });
    }
    expect(missingScore.issues).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("references unknown observation id")
    }));
    expect(ambiguousScore.issues).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("id duplicates")
    }));
  });

  it("does not select the first or most favorable non-primary comparison", () => {
    const artifact = buildCanonicalArtifact();
    const primarySubject = artifact.observations.find(
      (observation) => observation.id === "candidate_a_primary_observation"
    );
    if (!primarySubject) throw new Error("fixture observation is required");
    primarySubject.value = 0.6;
    artifact.comparisons[1].delta = -0.1;

    expect(scoreResultTableArtifact(artifact, {
      ...FULL_AUTHORIZATION,
      superiorityPrimaryMetrics: ["primary_score"],
      primaryComparisonId: "primary_comparison"
    })).toMatchObject({
      valid_schema: true,
      comparative_claim_supported: true,
      superiority_claim_supported: false
    });
  });

  it("fails closed for an invalid V2 artifact", () => {
    const score = scoreResultTableArtifact({
      schema_version: "2.0",
      metrics: [],
      series: [],
      observations: [],
      comparisons: "not-an-array"
    }, FULL_AUTHORIZATION);

    expect(score).toMatchObject({
      measured: false,
      valid_schema: false,
      row_count: 0,
      complete_row_count: 0,
      comparator_coverage: null,
      comparative_claim_supported: false,
      superiority_claim_supported: false
    });
    expect(score.issues).toContainEqual(expect.objectContaining({
      code: "result_table_schema_invalid",
      message: "results_artifact.comparisons must be an array."
    }));
  });

  it("keeps historical V1 array reader compatibility explicit and read-only", () => {
    const rows = [{
      metric: "primary_score",
      baseline: 0.7,
      comparator: 0.75,
      delta: 0.05,
      direction: "higher_better"
    }];
    const before = JSON.stringify(rows);

    const score = scoreResultTableArtifact(rows, {
      comparativeClaimAuthorized: true,
      superiorityClaimAuthorized: true,
      superiorityPrimaryMetrics: ["primary_score"]
    });

    expect(score).toMatchObject({
      measured: true,
      valid_schema: true,
      row_count: 1,
      complete_row_count: 1,
      comparator_coverage: 1,
      comparative_claim_supported: true,
      superiority_claim_supported: true
    });
    expect(score.issues).toEqual([
      expect.objectContaining({ code: "result_table_schema_v1_historical_reader" })
    ]);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("preserves explicit V1 missing-value counts without repairing rows", () => {
    const score = scoreResultTableArtifact([
      {
        metric: "primary_score",
        baseline: 0.7,
        comparator: null,
        delta: null,
        direction: "higher_better"
      },
      {
        metric: "",
        baseline: null,
        comparator: 0.4,
        delta: null,
        direction: "lower_better"
      }
    ]);

    expect(score).toMatchObject({
      measured: true,
      valid_schema: false,
      row_count: 2,
      complete_row_count: 0,
      missing_metric_count: 1,
      missing_baseline_count: 1,
      missing_comparator_count: 1,
      missing_delta_count: 2,
      superiority_claim_supported: false
    });
    expect(score.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "result_table_schema_v1_historical_reader",
      "result_table_metric_missing",
      "result_table_baseline_missing",
      "result_table_comparator_missing",
      "result_table_delta_missing"
    ]));
  });

  it("does not repair arbitrary object summaries into result evidence", () => {
    const score = scoreResultTableArtifact({
      conditions: [{ id: "candidate_a", metrics: { "primary_score": 0.75 } }],
      comparisons: [{
        metric: "primary_score",
        baseline: 0.7,
        comparator: 0.75,
        delta: 0.05,
        direction: "higher_better"
      }]
    }, FULL_AUTHORIZATION);

    expect(score).toMatchObject({
      measured: false,
      valid_schema: false,
      row_count: 0,
      complete_row_count: 0,
      missing_metric_count: 0,
      missing_baseline_count: 0,
      missing_comparator_count: 0,
      missing_delta_count: 0,
      comparator_coverage: null,
      comparative_claim_supported: false,
      superiority_claim_supported: false
    });
    expect(score.issues.map((issue) => issue.code)).toContain("result_table_schema_invalid");
  });
});

function buildCanonicalArtifact(): ResultsArtifactV2 {
  return {
    schema_version: "2.0",
    metrics: [
      {
        id: "secondary_score",
        label: "Secondary score",
        direction: "lower_better",
        unit: "units"
      },
      {
        id: "primary_score",
        label: "Primary score",
        direction: "higher_better",
        unit: "ratio"
      }
    ],
    series: [
      {
        id: "candidate_a",
        label: "Candidate A",
        role: "primary",
        dimensions: { environment: "shared", repetition: 1 }
      },
      {
        id: "reference",
        label: "Reference",
        role: "baseline",
        dimensions: { environment: "shared", repetition: 1 }
      }
    ],
    observations: [
      {
        id: "candidate_a_secondary_observation",
        series_id: "candidate_a",
        metric_id: "secondary_score",
        scope: { partition: "evaluation" },
        value: 90
      },
      {
        id: "reference_primary_observation",
        series_id: "reference",
        metric_id: "primary_score",
        scope: { partition: "evaluation" },
        value: 0.7
      },
      {
        id: "reference_secondary_observation",
        series_id: "reference",
        metric_id: "secondary_score",
        scope: { partition: "evaluation" },
        value: 100
      },
      {
        id: "candidate_a_primary_observation",
        series_id: "candidate_a",
        metric_id: "primary_score",
        scope: { partition: "evaluation" },
        value: 0.75
      }
    ],
    comparisons: [
      {
        id: "secondary_comparison",
        subject_observation_id: "candidate_a_secondary_observation",
        reference_observation_id: "reference_secondary_observation",
        delta: -10
      },
      {
        id: "primary_comparison",
        subject_observation_id: "candidate_a_primary_observation",
        reference_observation_id: "reference_primary_observation",
        delta: 0.05
      }
    ]
  };
}
