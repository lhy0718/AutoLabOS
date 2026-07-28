import { describe, expect, it } from "vitest";

import {
  buildExperimentComparisonContract,
  buildTopicProbeExecutionBinding
} from "../src/core/experimentGovernance.js";
import {
  buildCandidateObjectiveProfileBinding,
  candidateRawDeltaMetricKey,
  objectiveComparatorForEffectCriterion,
  signedRawDeltaTargetForEffectCriterion
} from "../src/core/effectCriterion.js";
import { buildDesignResultsPlan } from "../src/core/nodes/designExperiments.js";
import { normalizeObjectiveMetricProfile } from "../src/core/objectiveMetric.js";

describe("design results plan", () => {
  it("binds a candidate effect criterion to the raw primary comparison metric", () => {
    const candidateContentSha256 = "a".repeat(64);
    const datasetTaskScope = "declared_evaluation_scope";
    const binding = buildCandidateObjectiveProfileBinding({
      candidateId: "authorized_candidate",
      primaryMetric: "primary_measure",
      metricUnit: "unitless",
      metricScale: "proportion",
      metricDirection: "maximize",
      comparator: "declared_reference",
      effectCriterion: {
        basis: "delta_vs_reference",
        magnitude: 5,
        scale: "percentage_point",
        inclusive: true
      }
    });
    const outputMetricKey = candidateRawDeltaMetricKey(binding.primary_metric);
    const objectiveProfile = normalizeObjectiveMetricProfile(
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
          comparator: objectiveComparatorForEffectCriterion(
            binding.metric_direction,
            binding.effect_criterion
          ),
          signed_target: signedRawDeltaTargetForEffectCriterion(
            binding.metric_direction,
            binding.effect_criterion
          )
        }
      },
      binding.objective_raw
    );
    const comparisonContract = buildExperimentComparisonContract({
      run: { id: "run_effect_contract", objectiveMetric: "broad discovery objective" },
      selectedDesign: {
        id: "design_effect_contract",
        hypothesis_ids: ["hypothesis_a"],
        baselines: ["declared_reference"],
        datasets: [datasetTaskScope]
      },
      objectiveProfile,
      topicProbe: {
        candidateId: binding.candidate_id,
        candidateContentSha256,
        comparator: binding.comparator,
        datasetTaskScope
      },
      managedBundleSupported: false,
      createdAt: "2026-01-01T00:00:00.000Z"
    });

    const resolution = buildDesignResultsPlan({ objectiveProfile, comparisonContract });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const executionBinding = buildTopicProbeExecutionBinding({
      candidateId: binding.candidate_id,
      candidateContentSha256,
      comparator: binding.comparator,
      datasetTaskScope
    });
    expect(resolution.resultsPlan.required_metrics).toEqual([
      {
        id: "primary_measure",
        label: "primary_measure",
        direction: "higher_better",
        unit: "unitless"
      }
    ]);
    expect(resolution.resultsPlan.primary_effect_criterion).toEqual({
      comparison_id: resolution.resultsPlan.primary_comparison_id,
      metric_id: "primary_measure",
      metric_scale: "proportion",
      direction: "maximize",
      effect_criterion: {
        basis: "delta_vs_reference",
        magnitude: 5,
        scale: "percentage_point",
        inclusive: true
      }
    });
    expect(resolution.resultsPlan.required_series).toEqual([
      { id: executionBinding.subject_series_id, role: "primary" },
      { id: executionBinding.reference_series_id, role: "baseline" }
    ]);
    expect(resolution.resultsPlan.required_comparisons).toEqual([{
      id: executionBinding.primary_comparison_id,
      subject_series_id: executionBinding.subject_series_id,
      reference_series_id: executionBinding.reference_series_id,
      metric_id: binding.primary_metric,
      scope: executionBinding.observation_scope
    }]);
  });
});
