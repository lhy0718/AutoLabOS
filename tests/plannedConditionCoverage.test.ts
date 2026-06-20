import { describe, expect, it } from "vitest";

import { countExecutedPlannedConditions } from "../src/core/analysis/plannedConditionCoverage.js";

describe("planned condition coverage", () => {
  it("counts successful tuned rows from nested study recipes while excluding no-tune baselines", () => {
    const metrics = {
      status: "completed",
      study: {
        recipes: [
          {
            recipe: "baseline",
            adapter: { adapter_type: "none", trainable_parameters: 0 },
            training: { skipped: true }
          },
          {
            recipe: "adapter",
            adapter: { adapter_type: "adapter", trainable_parameters: 1179648 },
            training: { skipped: false }
          },
          {
            recipe: "ia3",
            adapter: { adapter_type: "compact_method", trainable_parameters: 98304 },
            training: { skipped: false }
          }
        ]
      }
    };

    expect(countExecutedPlannedConditions(metrics, { tunedOnly: true })).toBe(2);
  });

  it("counts successful tuned rows from top-level conditions object maps", () => {
    const metrics = {
      status: "completed",
      conditions: {
        base: {
          type: "locked_untuned_baseline",
          evaluation: { primary_mean_accuracy: 0.525 }
        },
        candidate_condition_b: {
          type: "adapter_instruction_tuned",
          train: {
            trainable_params: 2252800,
            recipe: { name: "candidate_condition_b" }
          },
          evaluation: { primary_mean_accuracy: 0.4875 }
        },
        candidate_condition_a: {
          type: "adapter_instruction_tuned",
          train: {
            trainable_params: 1126400,
            recipe: { name: "candidate_condition_a" }
          },
          evaluation: { primary_mean_accuracy: 0.5125 }
        }
      }
    };

    expect(countExecutedPlannedConditions(metrics, { tunedOnly: true })).toBe(2);
  });

  it("counts successful tuned rows from top-level condition_results marker rows", () => {
    const metrics = {
      status: "completed",
      condition_results: [
        {
          marker: "unmodified_base",
          status: "completed",
          training: { skipped: true, trainable_params: 0 }
        },
        {
          marker: "locked_tuned_baseline",
          status: "completed",
          training: { train_steps: 40, trainable_params: 1179648 }
        },
        {
          marker: "candidate_condition_b",
          status: "completed",
          training: { train_steps: 40, trainable_params: 1179648 }
        },
        {
          marker: "adapter_plus_neftune_style_embedding_noise_while_pr",
          status: "failed",
          training: { train_steps: 0 }
        },
        {
          marker: "stronger_candidate",
          status: "completed",
          training: { train_steps: 40, trainable_params: 1179648 }
        }
      ]
    };

    expect(countExecutedPlannedConditions(metrics, { tunedOnly: true })).toBe(3);
  });
});
