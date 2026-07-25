import { describe, expect, it } from "vitest";

import { scoreResultTableArtifact } from "../src/core/benchmark/resultTableScoring.js";

describe("result table scoring", () => {
  it("does not authorize comparison claims from numeric completeness alone", () => {
    const score = scoreResultTableArtifact([
      {
        metric: "accuracy",
        baseline: 0.7,
        comparator: 0.75,
        delta: 0.05,
        direction: "higher_better"
      }
    ]);

    expect(score).toMatchObject({
      measured: true,
      valid_schema: true,
      row_count: 1,
      complete_row_count: 1,
      comparator_coverage: 1,
      comparative_claim_supported: false,
      superiority_claim_supported: false
    });
    expect(score.issues).toEqual([]);
  });

  it("requires separate explicit authorization for comparison and superiority claims", () => {
    const rows = [{
      metric: "primary_score",
      baseline: 0.7,
      comparator: 0.75,
      delta: 0.05,
      direction: "higher_better"
    }];

    expect(scoreResultTableArtifact(rows, {
      comparativeClaimAuthorized: true
    })).toMatchObject({
      comparative_claim_supported: true,
      superiority_claim_supported: false
    });
    expect(scoreResultTableArtifact(rows, {
      comparativeClaimAuthorized: true,
      superiorityClaimAuthorized: true,
      superiorityPrimaryMetrics: ["primary_score"]
    })).toMatchObject({
      comparative_claim_supported: true,
      superiority_claim_supported: true
    });
  });

  it("rejects superiority for zero, adverse, arithmetically inconsistent, or unregistered effects", () => {
    const authorization = {
      comparativeClaimAuthorized: true,
      superiorityClaimAuthorized: true,
      superiorityPrimaryMetrics: ["primary_score"]
    };
    const score = (baseline: number, comparator: number, delta: number, direction = "higher_better") =>
      scoreResultTableArtifact([{
        metric: "primary_score",
        baseline,
        comparator,
        delta,
        direction
      }], authorization);

    expect(score(0.7, 0.7, 0).superiority_claim_supported).toBe(false);
    expect(score(0.7, 0.6, -0.1).superiority_claim_supported).toBe(false);
    expect(score(0.7, 0.75, -0.05).superiority_claim_supported).toBe(false);
    expect(score(0.7, 0.6, -0.1, "lower_better").superiority_claim_supported).toBe(true);
    expect(scoreResultTableArtifact([{
      metric: "secondary_score",
      baseline: 0.7,
      comparator: 0.8,
      delta: 0.1,
      direction: "higher_better"
    }], authorization).superiority_claim_supported).toBe(false);
  });

  it("fails closed when an authorized table has any schema issue", () => {
    const score = scoreResultTableArtifact([
      {
        metric: "primary_score",
        baseline: 0.7,
        comparator: 0.75,
        delta: 0.05,
        direction: "unsupported_direction"
      }
    ], {
      comparativeClaimAuthorized: true,
      superiorityClaimAuthorized: true,
      superiorityPrimaryMetrics: ["primary_score"]
    });

    expect(score.valid_schema).toBe(false);
    expect(score.complete_row_count).toBe(1);
    expect(score.comparative_claim_supported).toBe(false);
    expect(score.superiority_claim_supported).toBe(false);
  });

  it("keeps missing comparator and metric values explicit", () => {
    const score = scoreResultTableArtifact([
      {
        metric: "accuracy",
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

    expect(score.valid_schema).toBe(false);
    expect(score.complete_row_count).toBe(0);
    expect(score.missing_metric_count).toBe(1);
    expect(score.missing_baseline_count).toBe(1);
    expect(score.missing_comparator_count).toBe(1);
    expect(score.missing_delta_count).toBe(2);
    expect(score.superiority_claim_supported).toBe(false);
    expect(score.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "result_table_metric_missing",
        "result_table_baseline_missing",
        "result_table_comparator_missing",
        "result_table_delta_missing"
      ])
    );
  });

  it("does not treat malformed non-array artifacts as measured results", () => {
    const score = scoreResultTableArtifact({ rows: [] });

    expect(score.measured).toBe(false);
    expect(score.valid_schema).toBe(false);
    expect(score.comparator_coverage).toBeNull();
    expect(score.superiority_claim_supported).toBe(false);
  });

  it("scores runtime comparison-summary artifacts as measured but incomplete", () => {
    const score = scoreResultTableArtifact({
      conditions: [
        {
          name: "candidate_condition_f5_vs_baseline_condition",
          metrics: {
            accuracy_delta_vs_baseline_mean: 0.066667
          }
        }
      ],
      comparisons: [
        {
          primary: "candidate_condition_f5_vs_baseline_condition",
          baseline: "metrics.condition_summaries",
          metric: "accuracy_delta_vs_baseline_mean",
          delta: 0.066667,
          hypothesis_supported: true
        }
      ],
      primary_metric: "accuracy_delta_vs_baseline"
    });

    expect(score.measured).toBe(true);
    expect(score.valid_schema).toBe(false);
    expect(score.row_count).toBe(1);
    expect(score.complete_row_count).toBe(0);
    expect(score.missing_baseline_count).toBe(1);
    expect(score.missing_comparator_count).toBe(1);
    expect(score.missing_delta_count).toBe(0);
    expect(score.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "result_table_schema_noncanonical",
        "result_table_baseline_missing",
        "result_table_comparator_missing"
      ])
    );
  });
});
