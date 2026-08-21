import { describe, expect, it } from "vitest";

import { hashCanonical } from "../src/core/canonicalHash.js";
import {
  buildEstimatorFeasibilityContract,
  evaluateEstimatorFeasibility,
  matrixRank,
  validateEstimatorFeasibilityContract,
  validateEstimatorFeasibilityReport,
  type EstimatorDesignAssignment,
  type EstimatorFeasibilityContractInput
} from "../src/core/estimatorFeasibility.js";

describe("estimator feasibility", () => {
  it("builds and validates a deterministic hash-bound contract and report", () => {
    const input = pairedInput();
    const first = buildEstimatorFeasibilityContract(input);
    const second = buildEstimatorFeasibilityContract({
      ...input,
      design_matrix: {
        ...input.design_matrix,
        cells: [...input.design_matrix.cells].reverse(),
        assignments: [...input.design_matrix.assignments].reverse()
      }
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schema_version: 1,
      artifact_kind: "estimator_feasibility_contract"
    });
    const { content_sha256: _contractHash, ...contractPayload } = first;
    expect(first.content_sha256).toBe(hashCanonical(contractPayload));
    expect(validateEstimatorFeasibilityContract(first, bindingContext())).toEqual({
      valid: true,
      reasons: [],
      contract: first
    });

    const report = evaluateEstimatorFeasibility(first, bindingContext());
    expect(report).toMatchObject({
      schema_version: 1,
      artifact_kind: "estimator_feasibility_report",
      status: "pass",
      reason_codes: [],
      metrics: {
        assignment_count: 80,
        independent_cluster_count: 40,
        complete_pair_count: 40,
        design_matrix_rank: 2,
        design_matrix_column_count: 2,
        primary_denominator: 40,
        computed_resolution: 0.025
      }
    });
    expect(
      report.metrics.computed_minimum_detectable_effect
    ).toBeLessThanOrEqual(first.power.minimum_detectable_effect);
    expect(validateEstimatorFeasibilityReport(
      report,
      first,
      bindingContext()
    )).toEqual({
      valid: true,
      reasons: [],
      report
    });
  });

  it("computes matrix rank without external dependencies and blocks deficiency", () => {
    expect(matrixRank([
      [1, 0, 1],
      [0, 1, 1],
      [1, 1, 2]
    ])).toBe(2);

    const input = pairedInput();
    input.design_matrix.cells[0].x = [1, 1];
    input.design_matrix.cells[1].x = [2, 2];

    expect(blockedReasons(input)).toContain("rank_deficient");
  });

  it("blocks an incomplete paired design", () => {
    const input = pairedInput();
    input.design_matrix.assignments = input.design_matrix.assignments.filter(
      (assignment) => assignment.assignment_id !== "assignment_candidate_040"
    );
    const candidateCell = input.design_matrix.cells.find(
      (cell) => cell.arm_id === "candidate"
    );
    if (!candidateCell) throw new Error("candidate_cell_missing");
    candidateCell.n -= 1;

    expect(blockedReasons(input)).toEqual(expect.arrayContaining([
      "incomplete_pair",
      "pair_count_mismatch"
    ]));
  });

  it("blocks multiple arms assigned to one execution unit", () => {
    const input = pairedInput();
    const candidate = assignmentById(
      input.design_matrix.assignments,
      "assignment_candidate_001"
    );
    candidate.execution_unit_id = "execution_control_001";

    expect(blockedReasons(input)).toContain("arm_isolation_violation");
  });

  it("blocks a denominator whose resolution is coarser than the target MDE", () => {
    const input = pairedInput();
    input.power.minimum_detectable_effect = 0.02;
    input.power.assumed_standard_deviation = 0.01;

    const report = evaluateEstimatorFeasibility(
      buildEstimatorFeasibilityContract(input)
    );
    expect(report.reason_codes).toContain("resolution_exceeds_mde");
    expect(report.reason_codes).not.toContain("power_target_unattainable");
  });

  it("blocks resampling with too few independent clusters", () => {
    const input = pairedInput();
    input.design_matrix.assignments.forEach((assignment, index) => {
      assignment.independent_cluster_id =
        `cluster_${String(index % 10).padStart(2, "0")}`;
    });
    input.resampling.planned_clusters = 10;

    const report = evaluateEstimatorFeasibility(
      buildEstimatorFeasibilityContract(input)
    );
    expect(report.reason_codes).toContain("too_few_clusters");
    expect(report.metrics.independent_cluster_count).toBe(10);
  });

  it("blocks unpenalized logistic estimation without a safe separation policy", () => {
    const input = unpairedLogisticInput();
    input.estimator.separation_policy = "not_applicable";

    expect(blockedReasons(input)).toContain("unsafe_separation_policy");
  });

  it("blocks a multiplicity contract that targets a different primary effect", () => {
    const input = pairedInput();
    input.multiplicity.primary_comparison_id = "secondary_effect";
    input.multiplicity.family = ["secondary_effect"];

    expect(blockedReasons(input)).toContain("multiplicity_primary_mismatch");
  });

  it("fails closed for stale content and source-binding hashes", () => {
    const contract = buildEstimatorFeasibilityContract(pairedInput());
    contract.outcome.planned_denominator += 1;

    expect(validateEstimatorFeasibilityContract(contract)).toMatchObject({
      valid: false,
      reasons: ["contract_hash_mismatch"]
    });
    const report = evaluateEstimatorFeasibility(contract);
    expect(report.status).toBe("blocked");
    expect(report.reason_codes).toContain("contract_hash_mismatch");
    expect(report.contract_recomputed_sha256).not.toBe(
      report.contract_declared_sha256
    );

    const fresh = buildEstimatorFeasibilityContract(pairedInput());
    expect(validateEstimatorFeasibilityContract(fresh, {
      ...bindingContext(),
      expectedExperimentContractSha256: "f".repeat(64)
    })).toMatchObject({
      valid: false,
      reasons: ["experiment_binding_mismatch"]
    });
  });

  it("rejects unknown fields and detects a modified report", () => {
    const contract = buildEstimatorFeasibilityContract(pairedInput());
    const unknownField = {
      ...contract,
      undeclared_field: true
    };
    expect(validateEstimatorFeasibilityContract(unknownField)).toEqual({
      valid: false,
      reasons: ["schema_invalid"]
    });
    expect(() => evaluateEstimatorFeasibility(unknownField)).toThrow(
      "estimator_feasibility_contract_schema_invalid"
    );

    const report = evaluateEstimatorFeasibility(contract);
    report.metrics.design_matrix_rank = 1;
    expect(validateEstimatorFeasibilityReport(report, contract)).toMatchObject({
      valid: false,
      reasons: [
        "report_hash_mismatch",
        "report_recomputed_mismatch"
      ]
    });
  });
});

function pairedInput(): EstimatorFeasibilityContractInput {
  const assignments = pairedAssignments(40);
  return {
    bindings: {
      run_id: "run_fixture",
      active_probe_sha256: "a".repeat(64),
      experiment_contract_sha256: "b".repeat(64)
    },
    units: {
      execution_unit: "declared execution item",
      exposure_unit: "assigned condition",
      outcome_unit: "measured response",
      analysis_unit: "matched comparison",
      independent_cluster_key: "matched_set_id",
      arm_isolation: "one_arm_per_execution_unit",
      pairing: {
        mode: "paired",
        pair_key: "matched_set_id",
        required_arms: ["control", "candidate"],
        expected_complete_pairs: 40
      }
    },
    outcome: {
      type: "binary",
      planned_denominator: 40,
      attainable_resolution: 0.025
    },
    estimand: {
      id: "primary_effect",
      type: "paired_risk_difference",
      contrast: ["candidate", "control"],
      scale: "proportion"
    },
    estimator: {
      family: "paired_risk_difference",
      covariance: "cluster_bootstrap",
      separation_policy: "not_applicable"
    },
    design_matrix: {
      columns: ["intercept", "candidate_indicator"],
      cells: [
        {
          cell_id: "cell_control",
          arm_id: "control",
          n: 40,
          x: [1, 0],
          events: null,
          non_events: null
        },
        {
          cell_id: "cell_candidate",
          arm_id: "candidate",
          n: 40,
          x: [1, 1],
          events: null,
          non_events: null
        }
      ],
      assignments
    },
    power: {
      alpha: 0.05,
      target_power: 0.8,
      minimum_detectable_effect: 0.05,
      assumed_standard_deviation: 0.1,
      sidedness: "two_sided"
    },
    resampling: {
      cluster_key: "matched_set_id",
      planned_clusters: 40,
      minimum_clusters: 30,
      replicates: 2_000
    },
    multiplicity: {
      primary_comparison_id: "primary_effect",
      family: ["primary_effect"],
      method: "none",
      family_alpha: 0.05
    }
  };
}

function unpairedLogisticInput(): EstimatorFeasibilityContractInput {
  const assignments: EstimatorDesignAssignment[] = [];
  for (let index = 1; index <= 40; index += 1) {
    const suffix = String(index).padStart(3, "0");
    for (const arm of ["control", "candidate"] as const) {
      assignments.push({
        assignment_id: `assignment_${arm}_${suffix}`,
        execution_unit_id: `execution_${arm}_${suffix}`,
        exposure_unit_id: `exposure_${arm}_${suffix}`,
        outcome_unit_id: `outcome_${arm}_${suffix}`,
        analysis_unit_id: `analysis_${arm}_${suffix}`,
        independent_cluster_id: `cluster_${arm}_${suffix}`,
        arm_id: arm,
        cell_id: `cell_${arm}`,
        pair_id: null
      });
    }
  }
  return {
    ...pairedInput(),
    units: {
      ...pairedInput().units,
      analysis_unit: "independent response",
      independent_cluster_key: "independent_cluster_id",
      pairing: {
        mode: "unpaired",
        pair_key: null,
        required_arms: ["control", "candidate"],
        expected_complete_pairs: null
      }
    },
    estimand: {
      id: "primary_effect",
      type: "odds_ratio",
      contrast: ["candidate", "control"],
      scale: "odds_ratio"
    },
    estimator: {
      family: "logistic_regression",
      covariance: "cluster_robust",
      separation_policy: "block_on_separation"
    },
    design_matrix: {
      columns: ["intercept", "candidate_indicator"],
      cells: [
        {
          cell_id: "cell_control",
          arm_id: "control",
          n: 40,
          x: [1, 0],
          events: 20,
          non_events: 20
        },
        {
          cell_id: "cell_candidate",
          arm_id: "candidate",
          n: 40,
          x: [1, 1],
          events: 20,
          non_events: 20
        }
      ],
      assignments
    },
    power: {
      alpha: 0.05,
      target_power: 0.8,
      minimum_detectable_effect: 0.07,
      assumed_standard_deviation: 0.1,
      sidedness: "two_sided"
    },
    resampling: {
      cluster_key: "independent_cluster_id",
      planned_clusters: 80,
      minimum_clusters: 30,
      replicates: 2_000
    }
  };
}

function pairedAssignments(pairCount: number): EstimatorDesignAssignment[] {
  const assignments: EstimatorDesignAssignment[] = [];
  for (let index = 1; index <= pairCount; index += 1) {
    const suffix = String(index).padStart(3, "0");
    for (const arm of ["control", "candidate"] as const) {
      assignments.push({
        assignment_id: `assignment_${arm}_${suffix}`,
        execution_unit_id: `execution_${arm}_${suffix}`,
        exposure_unit_id: `exposure_${arm}_${suffix}`,
        outcome_unit_id: `outcome_${arm}_${suffix}`,
        analysis_unit_id: `matched_set_${suffix}`,
        independent_cluster_id: `matched_set_${suffix}`,
        arm_id: arm,
        cell_id: `cell_${arm}`,
        pair_id: `matched_set_${suffix}`
      });
    }
  }
  return assignments;
}

function blockedReasons(
  input: EstimatorFeasibilityContractInput
): string[] {
  const report = evaluateEstimatorFeasibility(
    buildEstimatorFeasibilityContract(input)
  );
  expect(report.status).toBe("blocked");
  return report.reason_codes;
}

function assignmentById(
  assignments: EstimatorDesignAssignment[],
  assignmentId: string
): EstimatorDesignAssignment {
  const assignment = assignments.find(
    (item) => item.assignment_id === assignmentId
  );
  if (!assignment) throw new Error("assignment_fixture_missing");
  return assignment;
}

function bindingContext() {
  return {
    expectedRunId: "run_fixture",
    expectedActiveProbeSha256: "a".repeat(64),
    expectedExperimentContractSha256: "b".repeat(64)
  };
}
