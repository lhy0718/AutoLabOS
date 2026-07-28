import { describe, expect, it } from "vitest";

import {
  buildEstimatorFeasibilityContract,
  evaluateEstimatorFeasibility,
  type EstimatorFeasibilityContract,
  type EstimatorFeasibilityContractInput
} from "../src/core/estimatorFeasibility.js";
import {
  buildEstimatorFeasibilityContractFromProtocol,
  type EstimatorProtocolDeclaration
} from "../src/core/estimatorProtocol.js";

describe("estimator feasibility adversarial contracts", () => {
  it("fails closed when clustered observations lack a cluster-aware power model", () => {
    const protocol = meanProtocol({
      mode: "unpaired",
      observationsPerArmPerCluster: 2
    });
    expect(() => evaluateProtocol(protocol)).toThrow(
      "estimator_protocol_clustered_repetition_requires_design_effect"
    );
  });

  it("blocks paired units whose pair members disagree on cluster and analysis unit", () => {
    const input = contractInput(meanProtocol({ mode: "paired" }));
    const variantAssignments = input.design_matrix.assignments.filter(
      (assignment) => assignment.arm_id === "variant"
    );
    const first = variantAssignments[0];
    const second = variantAssignments[1];
    if (!first || !second) throw new Error("paired_fixture_incomplete");

    swapField(first, second, "independent_cluster_id");
    swapField(first, second, "analysis_unit_id");

    const report = evaluateEstimatorFeasibility(
      buildEstimatorFeasibilityContract(input)
    );
    expect(report.status).toBe("blocked");
    expect(report.reason_codes.length).toBeGreaterThan(0);
  });

  for (const field of ["outcome_unit_id", "analysis_unit_id"] as const) {
    it(`blocks unpaired arms that reuse ${field}`, () => {
      const input = contractInput(meanProtocol({ mode: "unpaired" }));
      const reference = input.design_matrix.assignments.find(
        (assignment) => assignment.arm_id === "reference"
      );
      const variant = input.design_matrix.assignments.find(
        (assignment) => assignment.arm_id === "variant"
      );
      if (!reference || !variant) throw new Error("unpaired_fixture_incomplete");

      variant[field] = reference[field];

      const report = evaluateEstimatorFeasibility(
        buildEstimatorFeasibilityContract(input)
      );
      expect(report.status).toBe("blocked");
      expect(report.reason_codes.length).toBeGreaterThan(0);
    });
  }

  for (const family of ["odds_ratio", "rate_ratio"] as const) {
    it(`fails closed for unsupported ${family} power calculations`, () => {
      const protocol = ratioProtocol(family);
      const report = evaluateProtocol(protocol);

      expect(report.status).toBe("blocked");
      expect(report.reason_codes.length).toBeGreaterThan(0);
    });
  }

  for (const method of ["bonferroni", "holm"] as const) {
    it(`uses a multiplicity-adjusted alpha for ${method} MDE`, () => {
      const protocol = meanProtocol({
        mode: "paired",
        independentClusters: 3_000
      });
      protocol.power.minimum_detectable_effect = 0.06;
      protocol.power.assumed_standard_deviation = 1;
      protocol.multiplicity = {
        primary_comparison_id: "primary_contrast",
        family: [
          "primary_contrast",
          ...Array.from(
            { length: 19 },
            (_, index) => `secondary_contrast_${String(index + 1).padStart(2, "0")}`
          )
        ],
        method,
        family_alpha: 0.05
      };

      const report = evaluateProtocol(protocol);
      expect(report.metrics.computed_minimum_detectable_effect).not.toBeNull();
      expect(
        report.metrics.computed_minimum_detectable_effect
      ).toBeGreaterThan(protocol.power.minimum_detectable_effect);
      expect(report.status).toBe("blocked");
    });
  }

  it("does not require bootstrap replicates for exact paired inference", () => {
    const protocol = meanProtocol({
      mode: "paired",
      covariance: "exact_paired"
    });
    protocol.power.minimum_detectable_effect = 0.2;
    protocol.power.assumed_standard_deviation = 0.2;
    protocol.resampling.replicates = 1;

    const report = evaluateProtocol(protocol);
    expect(report.reason_codes).not.toContain("too_few_resamples");
    expect(report.status).toBe("pass");
  });
});

function meanProtocol(input: {
  mode: "paired" | "unpaired";
  independentClusters?: number;
  observationsPerArmPerCluster?: number;
  covariance?: "cluster_bootstrap" | "cluster_robust" | "exact_paired";
}): EstimatorProtocolDeclaration {
  const paired = input.mode === "paired";
  return {
    schema_version: 1,
    units: {
      execution_unit: "condition execution",
      exposure_unit: "assigned condition",
      outcome_unit: "measured response",
      analysis_unit: paired ? "matched comparison" : "independent response",
      independent_cluster_key: "independent cluster"
    },
    arms: ["reference", "variant"],
    primary_contrast: ["variant", "reference"],
    pairing: {
      mode: input.mode,
      independent_clusters: input.independentClusters ?? 40,
      observations_per_arm_per_cluster:
        input.observationsPerArmPerCluster ?? 1
    },
    outcome: {
      type: "continuous",
      attainable_resolution: 0.001
    },
    estimand: {
      id: "primary_contrast",
      type: paired ? "paired_mean_difference" : "mean_difference",
      scale: "mean"
    },
    estimator: {
      family: paired ? "paired_mean_difference" : "linear_model",
      covariance: input.covariance
        ?? (paired ? "cluster_bootstrap" : "cluster_robust"),
      separation_policy: "not_applicable"
    },
    power: {
      alpha: 0.05,
      target_power: 0.8,
      minimum_detectable_effect: 0.1,
      assumed_standard_deviation: 0.1,
      sidedness: "two_sided"
    },
    resampling: {
      minimum_clusters: 30,
      replicates: 2_000
    },
    multiplicity: {
      primary_comparison_id: "primary_contrast",
      family: ["primary_contrast"],
      method: "none",
      family_alpha: 0.05
    }
  };
}

function ratioProtocol(
  family: "odds_ratio" | "rate_ratio"
): EstimatorProtocolDeclaration {
  const protocol = meanProtocol({ mode: "unpaired" });
  protocol.outcome = {
    type: family === "odds_ratio" ? "binary" : "count",
    attainable_resolution: family === "odds_ratio" ? 0.025 : 0.01
  };
  protocol.estimand = {
    id: "primary_contrast",
    type: family,
    scale: family
  };
  protocol.estimator = {
    family: family === "odds_ratio"
      ? "logistic_regression"
      : "poisson_regression",
    covariance: "cluster_robust",
    separation_policy: family === "odds_ratio"
      ? "block_on_separation"
      : "not_applicable"
  };
  protocol.power.minimum_detectable_effect = 0.1;
  protocol.power.assumed_standard_deviation = 0.1;
  if (family === "odds_ratio") {
    protocol.event_counts = [
      { arm_id: "reference", events: 20, non_events: 20 },
      { arm_id: "variant", events: 20, non_events: 20 }
    ];
  }
  return protocol;
}

function evaluateProtocol(protocol: EstimatorProtocolDeclaration) {
  return evaluateEstimatorFeasibility(
    buildEstimatorFeasibilityContractFromProtocol({
      protocol,
      bindings: {
        run_id: "adversarial_fixture",
        active_probe_sha256: "a".repeat(64),
        experiment_contract_sha256: "b".repeat(64)
      }
    })
  );
}

function contractInput(
  protocol: EstimatorProtocolDeclaration
): EstimatorFeasibilityContractInput {
  const contract = buildEstimatorFeasibilityContractFromProtocol({
    protocol,
    bindings: {
      run_id: "adversarial_fixture",
      active_probe_sha256: "a".repeat(64),
      experiment_contract_sha256: "b".repeat(64)
    }
  });
  return copyContractInput(contract);
}

function copyContractInput(
  contract: EstimatorFeasibilityContract
): EstimatorFeasibilityContractInput {
  return structuredClone({
    bindings: contract.bindings,
    units: contract.units,
    outcome: contract.outcome,
    estimand: contract.estimand,
    estimator: contract.estimator,
    design_matrix: contract.design_matrix,
    power: contract.power,
    resampling: contract.resampling,
    multiplicity: contract.multiplicity
  });
}

function swapField(
  left: EstimatorFeasibilityContractInput["design_matrix"]["assignments"][number],
  right: EstimatorFeasibilityContractInput["design_matrix"]["assignments"][number],
  field: "independent_cluster_id" | "analysis_unit_id"
): void {
  const value = left[field];
  left[field] = right[field];
  right[field] = value;
}
