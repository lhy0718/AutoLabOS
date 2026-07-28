import { describe, expect, it } from "vitest";

import {
  buildEstimatorFeasibilityContractFromProtocol,
  normalizeEstimatorProtocolDeclaration,
  type EstimatorProtocolDeclaration
} from "../src/core/estimatorProtocol.js";
import {
  evaluateEstimatorFeasibility,
  validateEstimatorFeasibilityContract
} from "../src/core/estimatorFeasibility.js";

describe("estimator protocol", () => {
  it("expands a concise paired protocol into an auditable design matrix", () => {
    const protocol = pairedProtocol();
    const contract = buildEstimatorFeasibilityContractFromProtocol({
      protocol,
      bindings: bindings()
    });

    expect(validateEstimatorFeasibilityContract(contract, {
      expectedRunId: "run_protocol_fixture",
      expectedActiveProbeSha256: "a".repeat(64),
      expectedExperimentContractSha256: "b".repeat(64)
    })).toMatchObject({ valid: true, reasons: [] });
    expect(contract).toMatchObject({
      design_matrix: {
        columns: ["intercept", "arm_2"],
        cells: [
          { arm_id: "reference", n: 40, x: [1, 0] },
          { arm_id: "candidate", n: 40, x: [1, 1] }
        ]
      }
    });
    expect(contract.design_matrix.assignments).toHaveLength(80);
    expect(evaluateEstimatorFeasibility(contract)).toMatchObject({
      status: "pass",
      reason_codes: [],
      metrics: {
        complete_pair_count: 40,
        independent_cluster_count: 40,
        design_matrix_rank: 2,
        primary_denominator: 40,
        computed_resolution: 0.025
      }
    });
  });

  it("supports a balanced multi-arm paired design while preserving one primary contrast", () => {
    const protocol = pairedProtocol();
    protocol.arms = ["reference", "candidate", "ablation"];
    const contract = buildEstimatorFeasibilityContractFromProtocol({
      protocol,
      bindings: bindings()
    });
    const report = evaluateEstimatorFeasibility(contract);

    expect(contract.design_matrix.assignments).toHaveLength(120);
    expect(contract.design_matrix.columns).toEqual([
      "intercept",
      "arm_2",
      "arm_3"
    ]);
    expect(report).toMatchObject({
      status: "pass",
      metrics: {
        complete_pair_count: 40,
        design_matrix_rank: 3,
        design_matrix_column_count: 3
      }
    });
  });

  it("rejects unknown fields and inconsistent event totals", () => {
    const unknown = {
      ...pairedProtocol(),
      inferred_from_prose: true
    };
    expect(normalizeEstimatorProtocolDeclaration(unknown)).toEqual({
      valid: false,
      reasons: ["estimator_protocol_schema_invalid"]
    });

    const inconsistent = pairedProtocol();
    inconsistent.event_counts = [
      { arm_id: "reference", events: 10, non_events: 29 },
      { arm_id: "candidate", events: 12, non_events: 28 }
    ];
    expect(normalizeEstimatorProtocolDeclaration(inconsistent)).toMatchObject({
      valid: false,
      reasons: ["estimator_protocol_event_count_total_mismatch"]
    });
  });

  it("keeps an under-clustered protocol blocked after deterministic expansion", () => {
    const protocol = pairedProtocol();
    protocol.pairing.independent_clusters = 12;
    protocol.outcome.attainable_resolution = 1 / 12;
    protocol.power.assumed_standard_deviation = 0.05;
    const contract = buildEstimatorFeasibilityContractFromProtocol({
      protocol,
      bindings: bindings()
    });
    expect(evaluateEstimatorFeasibility(contract)).toMatchObject({
      status: "blocked",
      reason_codes: expect.arrayContaining(["too_few_clusters"])
    });
  });
});

function pairedProtocol(): EstimatorProtocolDeclaration {
  return {
    schema_version: 1,
    units: {
      execution_unit: "condition execution",
      exposure_unit: "pipeline condition",
      outcome_unit: "schema witness result",
      analysis_unit: "matched witness comparison",
      independent_cluster_key: "schema_case_id"
    },
    arms: ["reference", "candidate"],
    primary_contrast: ["candidate", "reference"],
    pairing: {
      mode: "paired",
      independent_clusters: 40,
      observations_per_arm_per_cluster: 1
    },
    outcome: {
      type: "binary",
      attainable_resolution: 0.025
    },
    estimand: {
      id: "primary_effect",
      type: "paired_risk_difference",
      scale: "proportion"
    },
    estimator: {
      family: "paired_risk_difference",
      covariance: "cluster_bootstrap",
      separation_policy: "not_applicable"
    },
    power: {
      alpha: 0.05,
      target_power: 0.8,
      minimum_detectable_effect: 0.1,
      assumed_standard_deviation: 0.15,
      sidedness: "two_sided"
    },
    resampling: {
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

function bindings() {
  return {
    run_id: "run_protocol_fixture",
    active_probe_sha256: "a".repeat(64),
    experiment_contract_sha256: "b".repeat(64)
  };
}
