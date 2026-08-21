import { describe, expect, it } from "vitest";

import {
  buildHeuristicObjectiveMetricProfile,
  evaluateObjectiveMetric,
  normalizeObjectiveMetricProfile,
  synthesizeRelativeMetrics,
  type ObjectiveMetricProfile
} from "../src/core/objectiveMetric.js";
import {
  buildCandidateObjectiveProfileBinding,
  candidateRawDeltaMetricKey,
  objectiveComparatorForEffectCriterion,
  signedRawDeltaTargetForEffectCriterion,
  type EffectCriterion
} from "../src/core/effectCriterion.js";

function structuredProfile(
  overrides: Partial<ObjectiveMetricProfile> = {}
): ObjectiveMetricProfile {
  return {
    source: "llm",
    raw: "",
    primaryMetric: "primary_score",
    preferredMetricKeys: ["primary_score"],
    direction: "maximize",
    comparator: ">=",
    targetValue: 0,
    analysisFocus: [],
    paperEmphasis: [],
    assumptions: [],
    ...overrides
  };
}

function candidateOwnedProfile(input: {
  direction: "maximize" | "minimize";
  criterion: EffectCriterion;
  metricScale?: "raw" | "proportion";
}): ObjectiveMetricProfile {
  const binding = buildCandidateObjectiveProfileBinding({
    candidateId: "declared_subject",
    primaryMetric: "primary_score",
    metricUnit: "unitless",
    metricScale: input.metricScale ?? "raw",
    metricDirection: input.direction,
    comparator: "declared_reference",
    effectCriterion: input.criterion
  });
  const outputMetricKey = candidateRawDeltaMetricKey(binding.primary_metric);
  const comparator = objectiveComparatorForEffectCriterion(
    binding.metric_direction,
    binding.effect_criterion
  );
  const signedTarget = signedRawDeltaTargetForEffectCriterion(
    binding.metric_direction,
    binding.effect_criterion
  );
  return normalizeObjectiveMetricProfile(
    {
      source: "heuristic_fallback",
      primaryMetric: outputMetricKey,
      preferredMetricKeys: [outputMetricKey],
      analysisFocus: [],
      paperEmphasis: [],
      assumptions: [],
      candidate_contract: binding,
      delta_contract: {
        output_metric_key: outputMetricKey,
        source_metric_key: binding.primary_metric,
        raw_delta_definition: "subject_minus_reference",
        comparator,
        signed_target: signedTarget
      }
    },
    binding.objective_raw
  );
}

describe("objectiveMetric", () => {
  it("rejects a positive candidate delta that misses the declared effect floor after scale conversion", () => {
    const profile = candidateOwnedProfile({
      direction: "maximize",
      metricScale: "proportion",
      criterion: {
        basis: "delta_vs_reference",
        magnitude: 5,
        scale: "percentage_point",
        inclusive: true
      }
    });
    const evaluation = evaluateObjectiveMetric(
      {
        conditions: [
          { id: "declared_reference", role: "baseline", primary_score: 0.5 },
          { id: "declared_subject", role: "candidate", primary_score: 0.54 }
        ]
      },
      profile,
      profile.raw
    );

    expect(evaluation.observedValue).toBeCloseTo(0.04, 10);
    expect(evaluation.targetValue).toBeCloseTo(0.05, 10);
    expect(evaluation.status).toBe("not_met");
  });

  it("applies the signed effect floor correctly for a minimize objective", () => {
    const profile = candidateOwnedProfile({
      direction: "minimize",
      criterion: {
        basis: "delta_vs_reference",
        magnitude: 0.1,
        scale: "raw",
        inclusive: true
      }
    });
    const belowFloor = evaluateObjectiveMetric(
      {
        conditions: [
          { id: "declared_reference", role: "baseline", primary_score: 1 },
          { id: "declared_subject", role: "candidate", primary_score: 0.95 }
        ]
      },
      profile,
      profile.raw
    );
    const worsening = evaluateObjectiveMetric(
      {
        conditions: [
          { id: "declared_reference", role: "baseline", primary_score: 1 },
          { id: "declared_subject", role: "candidate", primary_score: 1.01 }
        ]
      },
      profile,
      profile.raw
    );

    expect(profile.targetValue).toBe(-0.1);
    expect(belowFloor.status).toBe("not_met");
    expect(worsening.status).toBe("not_met");
  });

  it("honors inclusive and exclusive zero-effect boundaries in both directions", () => {
    const evaluateBoundary = (
      direction: "maximize" | "minimize",
      inclusive: boolean
    ) => {
      const profile = candidateOwnedProfile({
        direction,
        criterion: {
          basis: "delta_vs_reference",
          magnitude: 0,
          scale: "raw",
          inclusive
        }
      });
      return evaluateObjectiveMetric(
        {
          conditions: [
            { id: "declared_reference", role: "baseline", primary_score: 1 },
            { id: "declared_subject", role: "candidate", primary_score: 1 }
          ]
        },
        profile,
        profile.raw
      ).status;
    };

    expect(evaluateBoundary("maximize", true)).toBe("met");
    expect(evaluateBoundary("maximize", false)).toBe("not_met");
    expect(evaluateBoundary("minimize", true)).toBe("met");
    expect(evaluateBoundary("minimize", false)).toBe("not_met");
  });

  it("fails closed when the delta contract drifts from the hash-bound candidate objective", () => {
    const profile = candidateOwnedProfile({
      direction: "maximize",
      criterion: {
        basis: "delta_vs_reference",
        magnitude: 0.1,
        scale: "raw",
        inclusive: true
      }
    });

    expect(() => normalizeObjectiveMetricProfile(
      {
        ...profile,
        delta_contract: {
          ...profile.delta_contract!,
          signed_target: 0
        }
      },
      profile.raw
    )).toThrow("candidate_objective_delta_contract_invalid");
  });

  it("reads an adjacent metric identifier without inventing aliases", () => {
    const profile = buildHeuristicObjectiveMetricProfile("primary_score below 12");

    expect(profile.primaryMetric).toBe("primary_score");
    expect(profile.preferredMetricKeys).toEqual(["primary_score"]);
    expect(profile.direction).toBe("minimize");
    expect(profile.comparator).toBe("<");
    expect(profile.targetValue).toBe(12);
  });

  it("uses a metric key explicitly declared beside its comparator", () => {
    const profile = buildHeuristicObjectiveMetricProfile(
      "primary_score_delta_vs_baseline >= 0.1"
    );
    const evaluation = evaluateObjectiveMetric(
      { primary_score_delta_vs_baseline: 0.12, secondary_score: 0.99 },
      profile,
      profile.raw
    );

    expect(profile.preferredMetricKeys).toEqual(["primary_score_delta_vs_baseline"]);
    expect(evaluation.matchedMetricKey).toBe("primary_score_delta_vs_baseline");
    expect(evaluation.status).toBe("met");
  });

  it("does not prioritize either metric or the first threshold when text is ambiguous", () => {
    const vocabularyProfile = buildHeuristicObjectiveMetricProfile(
      "primary_score and secondary_score at least 0.8"
    );
    const declaredKeyProfile = buildHeuristicObjectiveMetricProfile(
      "metric_alpha >= 0.5 and metric_beta >= 0.6"
    );

    expect(vocabularyProfile.primaryMetric).toBeUndefined();
    expect(vocabularyProfile.preferredMetricKeys).toEqual([]);
    expect(declaredKeyProfile.primaryMetric).toBeUndefined();
    expect(declaredKeyProfile.preferredMetricKeys).toEqual([]);
    expect(declaredKeyProfile.targetValue).toBeUndefined();
  });

  it("keeps every supplied structured profile field authoritative over text fallback", () => {
    const profile = normalizeObjectiveMetricProfile(
      {
        source: "llm",
        primaryMetric: "secondary_score",
        preferredMetricKeys: ["secondary_score"],
        direction: "minimize",
        comparator: "<=",
        targetValue: -0.25,
        targetDescription: "declared signed target",
        unit: "score",
        scale: "raw",
        targetUnit: "score",
        targetScale: "raw",
        analysisFocus: [],
        paperEmphasis: [],
        assumptions: []
      },
      "Improve primary_score over a reference by at least 5 percentage points."
    );

    expect(profile.primaryMetric).toBe("secondary_score");
    expect(profile.preferredMetricKeys).toEqual(["secondary_score"]);
    expect(profile.direction).toBe("minimize");
    expect(profile.comparator).toBe("<=");
    expect(profile.targetValue).toBe(-0.25);
    expect(profile.unit).toBe("score");
    expect(profile.scale).toBe("raw");
    expect(profile.analysisFocus).toEqual([]);
    expect(profile.preferredMetricKeys).not.toContain("primary_score_delta_vs_baseline");
  });

  it("does not synthesize a best delta from ambiguous multiple candidates", () => {
    const metrics = {
      conditions: [
        { id: "reference", baseline: true, primary_score: 0.4 },
        { id: "candidate_a", role: "candidate", primary_score: 0.5 },
        { id: "candidate_b", role: "candidate", primary_score: 0.8 }
      ]
    };
    const profile = structuredProfile({
      primaryMetric: "primary_score_delta_vs_baseline",
      preferredMetricKeys: ["primary_score_delta_vs_baseline"],
      targetValue: 0.05
    });

    const enriched = synthesizeRelativeMetrics(metrics, profile);
    const evaluation = evaluateObjectiveMetric(metrics, profile, "primary score improvement over baseline");

    expect(enriched).not.toHaveProperty("primary_score_delta_vs_baseline");
    expect(evaluation.status).toBe("missing");
    expect(evaluation.observedValue).toBeUndefined();
  });

  it("does not assign baseline roles from spoofed labels or names", () => {
    const metrics = {
      conditions: [
        { id: "reference_named_only", primary_score: 0.4 },
        { id: "candidate_named_only", primary_score: 0.7 }
      ]
    };
    const profile = structuredProfile({
      primaryMetric: "primary_score_delta_vs_baseline",
      preferredMetricKeys: ["primary_score_delta_vs_baseline"]
    });

    expect(synthesizeRelativeMetrics(metrics, profile)).not.toHaveProperty(
      "primary_score_delta_vs_baseline"
    );
    expect(evaluateObjectiveMetric(metrics, profile, "primary score improvement").status).toBe("missing");
  });

  it("preserves an explicitly keyed percentage-point target without unit conversion", () => {
    const profile = buildHeuristicObjectiveMetricProfile(
      "primary_score_delta_vs_baseline >= -2 percentage points"
    );

    expect(profile.primaryMetric).toBe("primary_score_delta_vs_baseline");
    expect(profile.targetValue).toBe(-2);
    expect(profile.comparator).toBe(">=");
    expect(profile.targetScale).toBe("percentage_point");
    expect(profile.assumptions).toEqual([]);
  });

  it("preserves a negative observed delta from one explicit pair", () => {
    const profile = structuredProfile({
      primaryMetric: "primary_score_delta_vs_baseline",
      preferredMetricKeys: ["primary_score_delta_vs_baseline"],
      targetValue: -0.04
    });
    const evaluation = evaluateObjectiveMetric(
      {
        conditions: [
          { id: "reference", role: "reference", primary_score: 0.5 },
          { id: "candidate_a", role: "candidate", primary_score: 0.45 }
        ]
      },
      profile,
      "declared relative primary score target"
    );

    expect(evaluation.observedValue).toBeCloseTo(-0.05, 10);
    expect(evaluation.targetValue).toBe(-0.04);
    expect(evaluation.status).toBe("not_met");
  });

  it("does not divide a unitless target by 100 to fit an observed proportion", () => {
    const profile = structuredProfile({ targetValue: 5 });
    const evaluation = evaluateObjectiveMetric(
      { primary_score: 0.08 },
      profile,
      "declared primary score target"
    );

    expect(evaluation.targetValue).toBe(5);
    expect(evaluation.observedValue).toBe(0.08);
    expect(evaluation.status).toBe("not_met");
  });

  it("converts percent targets only when both scales are explicit", () => {
    const profile = structuredProfile({
      targetValue: 5,
      scale: "proportion",
      targetScale: "percent"
    });
    const evaluation = evaluateObjectiveMetric(
      { primary_score: 0.08 },
      profile,
      "declared scaled primary score target"
    );

    expect(evaluation.targetValue).toBe(0.05);
    expect(evaluation.status).toBe("met");
  });

  it("does not infer reproducibility from trial counts or stability metrics", () => {
    const profile = structuredProfile({ targetValue: 0.5 });
    const evaluation = evaluateObjectiveMetric(
      {
        primary_score: 0.7,
        sampling_profile: { executed_trials: 8 },
        run_to_run_variance: 0.001,
        ordering_stability: 0.99
      },
      profile,
      "primary score at least 0.5 with reproducible execution"
    );

    expect(evaluation.status).toBe("missing");
    expect(evaluation.summary).toContain("Reproducibility requirement could not be verified");
  });

  it("requires an explicit resource threshold instead of a fixed regression limit", () => {
    const profile = structuredProfile({
      primaryMetric: "primary_score_delta_vs_baseline",
      preferredMetricKeys: ["primary_score_delta_vs_baseline"],
      targetValue: 0.05
    });
    const evaluation = evaluateObjectiveMetric(
      {
        conditions: [
          {
            id: "reference",
            role: "reference",
            primary_score: 0.5,
            runtime_sec: 10
          },
          {
            id: "candidate_a",
            role: "candidate",
            primary_score: 0.6,
            runtime_sec: 11
          }
        ]
      },
      profile,
      "primary score improvement without an unacceptable runtime regression"
    );

    expect(evaluation.status).toBe("missing");
    expect(evaluation.summary).toContain("explicit ratio thresholds");
  });

  it("evaluates one explicit baseline and candidate pair without metric aliases", () => {
    const profile = structuredProfile({
      primaryMetric: "primary_score_delta_vs_baseline",
      preferredMetricKeys: ["primary_score_delta_vs_baseline"],
      targetValue: 0.1
    });
    const evaluation = evaluateObjectiveMetric(
      {
        conditions: [
          { id: "reference", is_baseline: true, primary_score: 0.4 },
          { id: "candidate_a", is_candidate: true, primary_score: 0.55 }
        ]
      },
      profile,
      "declared relative primary score target"
    );

    expect(evaluation.matchedMetricKey).toBe("primary_score_delta_vs_baseline");
    expect(evaluation.observedValue).toBeCloseTo(0.15, 10);
    expect(evaluation.status).toBe("met");
  });

  it("uses a single explicit comparison artifact when row roles are absent", () => {
    const profile = structuredProfile({
      primaryMetric: "primary_score_delta_vs_baseline",
      preferredMetricKeys: ["primary_score_delta_vs_baseline"],
      targetValue: 0.1
    });
    const evaluation = evaluateObjectiveMetric(
      {
        objective_comparison: {
          baseline_id: "reference",
          candidate_id: "candidate_a",
          metric_key: "primary_score"
        },
        conditions: [
          { id: "reference", primary_score: 0.3 },
          { id: "candidate_a", primary_score: 0.45 }
        ]
      },
      profile,
      "declared relative primary score target"
    );

    expect(evaluation.observedValue).toBeCloseTo(0.15, 10);
    expect(evaluation.status).toBe("met");
  });
});
