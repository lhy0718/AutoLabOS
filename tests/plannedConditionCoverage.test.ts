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
            adapter: { peft_type: "none", trainable_parameters: 0 },
            training: { skipped: true }
          },
          {
            recipe: "lora",
            adapter: { peft_type: "lora", trainable_parameters: 1179648 },
            training: { skipped: false }
          },
          {
            recipe: "ia3",
            adapter: { peft_type: "ia3", trainable_parameters: 98304 },
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
        lora_r16: {
          type: "peft_lora_instruction_tuned",
          train: {
            trainable_params: 2252800,
            recipe: { name: "lora_r16" }
          },
          evaluation: { primary_mean_accuracy: 0.4875 }
        },
        lora_r8: {
          type: "peft_lora_instruction_tuned",
          train: {
            trainable_params: 1126400,
            recipe: { name: "lora_r8" }
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
          marker: "locked_lora_baseline",
          status: "completed",
          training: { train_steps: 40, trainable_params: 1179648 }
        },
        {
          marker: "dora",
          status: "completed",
          training: { train_steps: 40, trainable_params: 1179648 }
        },
        {
          marker: "lora_plus_neftune_style_embedding_noise_while_pr",
          status: "failed",
          training: { train_steps: 0 }
        },
        {
          marker: "rslora",
          status: "completed",
          training: { train_steps: 40, trainable_params: 1179648 }
        }
      ]
    };

    expect(countExecutedPlannedConditions(metrics, { tunedOnly: true })).toBe(3);
  });
});
