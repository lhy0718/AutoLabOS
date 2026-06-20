import { describe, expect, it } from "vitest";

import { synthesizeAnalysisReport } from "../src/core/resultAnalysisSynthesis.js";
import type { LLMClient } from "../src/core/llm/client.js";
import type { AnalysisReport } from "../src/core/resultAnalysis.js";

describe("resultAnalysisSynthesis", () => {
  it("grounds LLM synthesis against explicit evidence-accounting fields", async () => {
    let capturedPrompt = "";
    const llm: LLMClient = {
      async complete(prompt) {
        capturedPrompt = prompt;
        return {
          text: JSON.stringify({
            discussion_points: [
              "The objective was met by the candidate condition.",
              "The evidence should be treated as weak because raw correct-count denominators are not provided and available CI summaries cite only n=6 predictions.",
              "The payload has trial-accounting ambiguity between primary and executed trials."
            ],
            failure_analysis: [
              "Residual evidence risk remains from single-seed primary evaluation and missing raw correct/total counts."
            ],
            follow_up_actions: [
              "Export per-task raw correct/total counts before making claims.",
              "Use the structured result table in the writeup."
            ],
            confidence_statement:
              "Confidence is low because the result is single-seed, n=6, and raw counts are missing."
          })
        };
      }
    };
    const report = {
      overview: {
        objective_status: "met",
        objective_summary: "Objective metric met for candidate_condition_a.",
        selected_design_title: "Neutral benchmark comparison",
        observed_value: 0.02,
        matched_metric_key: "accuracy_delta_vs_baseline"
      },
      primary_findings: ["candidate_condition_a improved over baseline_condition."],
      condition_comparisons: [
        {
          label: "candidate_condition_a vs baseline_condition",
          summary: "candidate_condition_a improved by 0.02.",
          hypothesis_supported: true
        }
      ],
      supplemental_runs: [
        { profile: "quick_check", summary: "quick_check met the objective.", objective_evaluation: { status: "met" } },
        { profile: "confirmatory", summary: "confirmatory met the objective.", objective_evaluation: { status: "met" } }
      ],
      external_comparisons: [],
      statistical_summary: {
        total_trials: 36,
        executed_trials: 38,
        confidence_intervals: [
          {
            metric_key: "condition_results.candidate_condition_a.average_accuracy",
            label: "candidate condition average accuracy",
            lower: 0.42,
            upper: 0.54,
            level: 0.95,
            sample_size: 6,
            source: "metrics",
            summary: "95% CI [0.42, 0.54], n=6."
          }
        ],
        effect_estimates: [],
        stability_metrics: [],
        notes: ["Primary trial accounting covers 36 primary runs plus 2 supplemental profiles."]
      },
      verifier_feedback: { status: "pass", stage: "success", summary: "Verifier passed." },
      failure_taxonomy: [],
      warnings: [],
      limitations: [],
      metrics: {
        condition_results: [
          {
            condition_marker: "baseline_condition",
            seed_count: 3,
            correct_count: 132,
            total_count: 288,
            confidence_interval: { sample_size: 288, correct_count: 132, total_count: 288 },
            evaluation: {
              benchmark_task_a: {
                correct_count: 69,
                total_count: 144,
                confidence_interval: { sample_size: 144, correct_count: 69, total_count: 144 }
              },
              benchmark_task_b: {
                correct_count: 63,
                total_count: 144,
                confidence_interval: { sample_size: 144, correct_count: 63, total_count: 144 }
              }
            }
          },
          {
            condition_marker: "candidate_condition_a",
            seed_count: 3,
            correct_count: 138,
            total_count: 288,
            confidence_interval: { sample_size: 288, correct_count: 138, total_count: 288 },
            evaluation: {
              benchmark_task_a: {
                correct_count: 69,
                total_count: 144,
                confidence_interval: { sample_size: 144, correct_count: 69, total_count: 144 }
              },
              benchmark_task_b: {
                correct_count: 69,
                total_count: 144,
                confidence_interval: { sample_size: 144, correct_count: 69, total_count: 144 }
              }
            }
          }
        ]
      }
    } as unknown as AnalysisReport;

    const synthesis = await synthesizeAnalysisReport({
      run: {
        id: "run-analysis-synthesis",
        topic: "Neutral benchmark comparison",
        objectiveMetric: "Improve candidate accuracy over baseline.",
        constraints: []
      },
      report,
      llm,
      node: "analyze_results"
    });

    expect(capturedPrompt).toContain('"evidence_accounting"');
    expect(capturedPrompt).toContain('"max_seed_count": 3');
    expect(capturedPrompt).toContain('"max_ci_sample_size": 288');
    expect(synthesis.discussion_points[0]).toContain("Evidence accounting:");
    const combined = JSON.stringify(synthesis);
    expect(combined).not.toMatch(/single[- ]seed|n=6|raw counts are missing|raw correct\/total counts|raw correct-count denominators are not provided|trial-accounting ambiguity/iu);
    expect(combined).toContain("Use the structured result table in the writeup.");
  });
});
