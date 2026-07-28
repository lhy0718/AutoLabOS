import { describe, expect, it } from "vitest";

import { runDesignExperimentsPanel } from "../src/core/designExperimentsPanel.js";
import type { ExperimentDesignCandidate } from "../src/core/analysis/researchPlanning.js";
import type { EstimatorProtocolDeclaration } from "../src/core/estimatorProtocol.js";
import type { ObjectiveMetricProfile } from "../src/core/objectiveMetric.js";

function candidate(overrides: Partial<ExperimentDesignCandidate>): ExperimentDesignCandidate {
  return {
    id: "candidate",
    title: "Controlled comparison",
    hypothesis_ids: ["hypothesis_a"],
    plan_summary: "Compare a candidate system against a declared reference system.",
    datasets: ["evaluation_corpus"],
    primary_metric: "primary_outcome_delta",
    metrics: ["primary_outcome_delta", "uncertainty_interval"],
    baselines: ["reference_system"],
    implementation_notes: ["Run the declared protocol without changing the evaluation inputs."],
    evaluation_steps: ["Report matched comparisons and uncertainty across repeated runs."],
    risks: ["The bounded execution budget may limit precision."],
    resource_notes: ["Execution is bounded by the governed brief."],
    ...overrides
  };
}

function objective(primaryMetric = "primary_outcome_delta"): ObjectiveMetricProfile {
  return {
    source: "heuristic_fallback",
    raw: `metric:${primaryMetric} >= 0.01`,
    primaryMetric,
    preferredMetricKeys: [primaryMetric],
    direction: "maximize",
    analysisFocus: [],
    paperEmphasis: [],
    assumptions: []
  };
}

function estimatorProtocol(): EstimatorProtocolDeclaration {
  return {
    schema_version: 1,
    units: {
      execution_unit: "experimental unit",
      exposure_unit: "assigned condition",
      outcome_unit: "observed response",
      analysis_unit: "matched comparison",
      independent_cluster_key: "cluster_id"
    },
    arms: ["reference", "candidate"],
    primary_contrast: ["candidate", "reference"],
    pairing: {
      mode: "paired",
      independent_clusters: 40,
      observations_per_arm_per_cluster: 1
    },
    outcome: {
      type: "continuous",
      attainable_resolution: 0.01
    },
    estimand: {
      id: "primary_effect",
      type: "paired_mean_difference",
      scale: "mean"
    },
    estimator: {
      family: "paired_mean_difference",
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

describe("designExperimentsPanel", () => {
  it("blocks a design whose explicit primary metric drifts from the governed objective", () => {
    const aligned = candidate({ id: "aligned" });
    const drifted = candidate({
      id: "drifted",
      primary_metric: "secondary_audit_rate",
      metrics: ["secondary_audit_rate", "primary_outcome_delta"]
    });

    const result = runDesignExperimentsPanel({
      candidates: [drifted, aligned],
      objectiveProfile: objective()
    });

    expect(result.selected.id).toBe("aligned");
    expect(result.selection.scores.find((score) => score.candidate_id === "drifted")?.blocked_by).toContain(
      "statistical_reviewer"
    );
    expect(
      result.reviews.find(
        (review) => review.candidate_id === "drifted" && review.reviewer_id === "statistical_reviewer"
      )?.summary
    ).toContain("does not match");
  });

  it("does not infer the primary metric from metric-array order", () => {
    const first = candidate({
      id: "first_order",
      metrics: ["primary_outcome_delta", "uncertainty_interval"]
    });
    const reversed = candidate({
      id: "reversed_order",
      metrics: ["uncertainty_interval", "primary_outcome_delta"]
    });

    const firstResult = runDesignExperimentsPanel({ candidates: [first], objectiveProfile: objective() });
    const reversedResult = runDesignExperimentsPanel({ candidates: [reversed], objectiveProfile: objective() });

    expect(firstResult.selection.scores[0]?.blocked_by).not.toContain("statistical_reviewer");
    expect(reversedResult.selection.scores[0]?.blocked_by).not.toContain("statistical_reviewer");
    expect(firstResult.selection.scores[0]?.statistical_score).toBe(
      reversedResult.selection.scores[0]?.statistical_score
    );
  });

  it("allows an audit design when the audit outcome is the declared research objective", () => {
    const audit = candidate({
      id: "interface_audit",
      title: "Interface invariance audit",
      plan_summary: "Audit whether two lossless evidence interfaces change reviewer verdicts.",
      primary_metric: "interface_flip_rate",
      metrics: ["interface_flip_rate", "paired_disagreement_interval"],
      evaluation_steps: ["Compare matched verdicts across repeated, preregistered interface views."]
    });

    const result = runDesignExperimentsPanel({
      candidates: [audit],
      objectiveProfile: objective("interface_flip_rate")
    });

    expect(result.selected.id).toBe("interface_audit");
    expect(result.selection.scores[0]?.blocked_by).not.toContain("statistical_reviewer");
  });

  it("prefers confirmatory repeated evidence over a single-run screening design", () => {
    const confirmatory = candidate({
      id: "confirmatory",
      plan_summary: "Run matched comparisons over independent repetitions and report a confidence interval.",
      evaluation_steps: [
        "Evaluate every declared unit in each arm.",
        "Report raw sample size, paired effects, uncertainty intervals, and failed runs."
      ]
    });
    const screening = candidate({
      id: "screening",
      title: "Single-run preflight",
      plan_summary: "Use one run per arm as preflight evidence only; it cannot support the paper claim.",
      evaluation_steps: ["Use the output only to decide whether a confirmatory run is feasible."],
      resource_notes: ["Lowest-cost screening option."]
    });

    const result = runDesignExperimentsPanel({
      candidates: [screening, confirmatory],
      objectiveProfile: objective()
    });

    expect(result.selected.id).toBe("confirmatory");
    expect(result.selection.scores.find((score) => score.candidate_id === "screening")?.blocked_by).toContain(
      "statistical_reviewer"
    );
    expect(result.selection.scores.find((score) => score.candidate_id === "screening")?.evidence_strength_score).toBeLessThan(
      result.selection.scores.find((score) => score.candidate_id === "confirmatory")?.evidence_strength_score || 0
    );
  });

  it("allows screening-only evidence only for an explicitly bounded probe", () => {
    const probe = candidate({
      id: "bounded_probe",
      title: "Bounded feasibility probe",
      plan_summary: "Run one matched pass per arm as screening evidence only.",
      evaluation_steps: ["Use the result only to decide whether a confirmatory comparison is warranted."],
      resource_notes: ["This is a preflight-only stage under a fixed local budget."]
    });

    const confirmatory = runDesignExperimentsPanel({
      candidates: [probe],
      objectiveProfile: objective()
    });
    const bounded = runDesignExperimentsPanel({
      candidates: [probe],
      objectiveProfile: objective(),
      evidenceStage: "bounded_probe"
    });

    expect(confirmatory.evidence_stage).toBe("confirmatory");
    expect(confirmatory.selection.scores[0]?.blocked_by).toContain("statistical_reviewer");
    expect(bounded.evidence_stage).toBe("bounded_probe");
    expect(bounded.selection.scores[0]?.blocked_by).not.toContain("statistical_reviewer");
    expect(bounded.selection.mode).toBe("best_non_blocked");
    expect(
      bounded.reviews.find((review) => review.reviewer_id === "statistical_reviewer")?.findings
    ).toContain(
      "The candidate is explicitly screening-only; it may run as a bounded probe but cannot support paper-scale claims."
    );
  });

  it("blocks a design that declares a primary metric absent from its metric set", () => {
    const incomplete = candidate({
      id: "incomplete",
      metrics: ["uncertainty_interval"]
    });

    const result = runDesignExperimentsPanel({
      candidates: [incomplete],
      objectiveProfile: objective()
    });

    expect(result.selection.scores[0]?.blocked_by).toContain("statistical_reviewer");
    expect(
      result.reviews.find((review) => review.reviewer_id === "statistical_reviewer")?.findings
    ).toContain("The declared primary metric is absent from the metric set.");
  });

  it("falls back when every candidate lacks a valid executable estimator protocol", () => {
    const missingProtocol = candidate({ id: "missing_protocol" });
    const invalidProtocol = candidate({
      id: "invalid_protocol",
      estimator_protocol: {
        schema_version: 1
      } as unknown as EstimatorProtocolDeclaration
    });

    const result = runDesignExperimentsPanel({
      candidates: [missingProtocol, invalidProtocol],
      objectiveProfile: objective(),
      requireExecutableEstimator: true
    });

    expect(result.selection.mode).toBe("all_blocked_fallback");
    for (const candidateId of ["missing_protocol", "invalid_protocol"]) {
      expect(
        result.selection.scores.find((score) => score.candidate_id === candidateId)?.blocked_by
      ).toContain("statistical_reviewer");
      expect(
        result.reviews.find(
          (review) =>
            review.candidate_id === candidateId
            && review.reviewer_id === "statistical_reviewer"
        )
      ).toMatchObject({
        hard_block: true,
        summary:
          "The plan has no valid executable estimator protocol, so its comparison cannot be identified before implementation."
      });
    }
  });

  it("does not block a candidate with a valid generic executable estimator protocol", () => {
    const result = runDesignExperimentsPanel({
      candidates: [
        candidate({
          id: "executable_protocol",
          estimator_protocol: estimatorProtocol()
        })
      ],
      objectiveProfile: objective(),
      requireExecutableEstimator: true
    });

    expect(result.selection.mode).toBe("best_non_blocked");
    expect(result.selection.scores[0]?.blocked_by).not.toContain("statistical_reviewer");
    expect(
      result.reviews.find((review) => review.reviewer_id === "statistical_reviewer")
    ).toMatchObject({
      hard_block: false,
      findings: expect.arrayContaining([
        "Executable estimator protocol passed structural validation."
      ])
    });
  });
});
