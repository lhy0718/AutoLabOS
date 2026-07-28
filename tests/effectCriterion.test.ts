import { describe, expect, it } from "vitest";

import {
  buildCandidateObjectiveProfileBinding,
  buildCandidateObjectiveRaw,
  candidateRawDeltaMetricKey,
  isCandidateObjectiveProfileBinding,
  isEffectCriterion,
  objectiveComparatorForEffectCriterion,
  rawDeltaMeetsEffectCriterion,
  signedRawDeltaTargetForEffectCriterion,
  validateEffectCriterion
} from "../src/core/effectCriterion.js";

const validCriterion = {
  basis: "delta_vs_reference" as const,
  magnitude: 0.05,
  scale: "raw" as const,
  inclusive: true
};

describe("effectCriterion", () => {
  it.each(["raw", "proportion", "percent", "percentage_point"] as const)(
    "accepts a finite nonnegative %s criterion",
    (scale) => {
      expect(isEffectCriterion({
        ...validCriterion,
        magnitude: 0,
        scale
      })).toBe(true);
    }
  );

  it.each([
    ["missing criterion", undefined],
    ["nonnumeric magnitude", { ...validCriterion, magnitude: "0.05" }],
    ["NaN magnitude", { ...validCriterion, magnitude: Number.NaN }],
    ["infinite magnitude", { ...validCriterion, magnitude: Number.POSITIVE_INFINITY }],
    ["negative magnitude", { ...validCriterion, magnitude: -0.01 }],
    ["missing magnitude", {
      basis: "delta_vs_reference",
      scale: "raw",
      inclusive: true
    }],
    ["unsupported basis", { ...validCriterion, basis: "absolute_target" }],
    ["unsupported scale", { ...validCriterion, scale: "ratio" }],
    ["missing inclusive", {
      basis: "delta_vs_reference",
      magnitude: 0.05,
      scale: "raw"
    }],
    ["nonboolean inclusive", { ...validCriterion, inclusive: "true" }],
    ["unknown field", { ...validCriterion, tolerance: 0.01 }]
  ])("rejects %s", (_label, value) => {
    const validation = validateEffectCriterion(value);

    expect(validation.valid).toBe(false);
    expect(validation.reasons.length).toBeGreaterThan(0);
  });

  it("serializes and binds the candidate-owned objective without broad-objective inheritance", () => {
    const contract = {
      primary_metric: "primary_score",
      metric_unit: "unitless",
      metric_scale: "raw" as const,
      metric_direction: "maximize" as const,
      comparator: "reference_condition",
      effect_criterion: validCriterion
    };
    const raw = buildCandidateObjectiveRaw(contract);
    const binding = buildCandidateObjectiveProfileBinding({
      candidateId: "candidate_a",
      primaryMetric: contract.primary_metric,
      metricUnit: contract.metric_unit,
      metricScale: contract.metric_scale,
      metricDirection: contract.metric_direction,
      comparator: contract.comparator,
      effectCriterion: contract.effect_criterion,
      objectiveRaw: raw
    });

    expect(raw).toBe(JSON.stringify(contract));
    expect(binding).toEqual({
      candidate_id: "candidate_a",
      objective_raw: raw,
      ...contract
    });
    expect(isCandidateObjectiveProfileBinding(binding)).toBe(true);
  });


  it.each([
    ["maximize", ">=", 0.05, 0.05, -0.01],
    ["minimize", "<=", -0.05, -0.05, 0.01]
  ] as const)("uses a signed raw-delta target for %s", (direction, comparator, target, passingDelta, worseningDelta) => {
    expect(candidateRawDeltaMetricKey("primary_score")).toBe("primary_score_delta_vs_baseline");
    expect(objectiveComparatorForEffectCriterion(direction, validCriterion)).toBe(comparator);
    expect(signedRawDeltaTargetForEffectCriterion(direction, validCriterion)).toBe(target);
    expect(rawDeltaMeetsEffectCriterion(passingDelta, direction, validCriterion)).toBe(true);
    expect(rawDeltaMeetsEffectCriterion(worseningDelta, direction, validCriterion)).toBe(false);
  });

  it.each(["maximize", "minimize"] as const)(
    "honors zero-magnitude inclusive and exclusive boundaries for %s",
    (direction) => {
      expect(rawDeltaMeetsEffectCriterion(0, direction, { ...validCriterion, magnitude: 0, inclusive: true })).toBe(true);
      expect(rawDeltaMeetsEffectCriterion(0, direction, { ...validCriterion, magnitude: 0, inclusive: false })).toBe(false);
    }
  );

  it("rejects missing units and raw/profile mismatches", () => {
    expect(() => buildCandidateObjectiveRaw({
      primary_metric: "primary_score",
      metric_unit: " ",
      metric_scale: "raw",
      metric_direction: "maximize",
      comparator: "reference_condition",
      effect_criterion: validCriterion
    })).toThrow("candidate_objective_metric_unit_missing");

    const binding = buildCandidateObjectiveProfileBinding({
      candidateId: "candidate_a",
      primaryMetric: "primary_score",
      metricUnit: "unitless",
      metricScale: "raw",
      metricDirection: "maximize",
      comparator: "reference_condition",
      effectCriterion: validCriterion
    });
    expect(isCandidateObjectiveProfileBinding({
      ...binding,
      metric_unit: "milliseconds"
    })).toBe(false);
    expect(() => buildCandidateObjectiveProfileBinding({
      candidateId: "candidate_a",
      primaryMetric: "primary_score",
      metricUnit: "unitless",
      metricScale: "raw",
      metricDirection: "maximize",
      comparator: "reference_condition",
      effectCriterion: validCriterion,
      objectiveRaw: "{}"
    })).toThrow("candidate_objective_raw_mismatch");
  });

  it("rejects incomparable metric and effect scales before execution", () => {
    expect(() => buildCandidateObjectiveRaw({
      primary_metric: "primary_score",
      metric_unit: "unitless",
      metric_scale: "raw",
      metric_direction: "maximize",
      comparator: "reference_condition",
      effect_criterion: {
        ...validCriterion,
        scale: "percentage_point"
      }
    })).toThrow("candidate_objective_effect_scale_incompatible");

    expect(() => buildCandidateObjectiveRaw({
      primary_metric: "primary_score",
      metric_unit: "unitless",
      metric_scale: "proportion",
      metric_direction: "maximize",
      comparator: "reference_condition",
      effect_criterion: {
        ...validCriterion,
        scale: "percentage_point"
      }
    })).not.toThrow();
  });
});
