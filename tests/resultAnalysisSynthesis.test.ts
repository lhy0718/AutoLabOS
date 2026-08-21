import { describe, expect, it } from "vitest";

import { synthesizeAnalysisReport } from "../src/core/resultAnalysisSynthesis.js";
import type { LLMClient } from "../src/core/llm/client.js";
import type { AnalysisReport } from "../src/core/resultAnalysis.js";

describe("resultAnalysisSynthesis", () => {
  it("preserves synthesis text while exposing generic evidence-accounting fields", async () => {
    let capturedPrompt = "";
    const emittedEvents: Array<Record<string, any>> = [];
    const llm: LLMClient = {
      async complete(prompt, options) {
        capturedPrompt = prompt;
        options?.onProgress?.({ type: "status", text: "Provider request accepted." });
        for (let index = 0; index < 500; index += 1) {
          options?.onProgress?.({ type: "delta", text: `token-${index}` });
        }
        return {
          text: JSON.stringify({
            discussion_points: [
              "The objective was met by Candidate A.",
              "The evidence should be treated as weak because numerator/denominator pairs are not provided and interval sample sizes are absent.",
              "The payload has trial-accounting ambiguity between primary and executed trials."
            ],
            failure_analysis: [
              "Residual evidence risk remains from a single repetition and missing denominator evidence."
            ],
            follow_up_actions: [
              "Export numerator/denominator pairs before making claims.",
              "Use the structured result table in the writeup."
            ],
            confidence_statement:
              "Confidence is low because repetition and denominator evidence are missing."
          })
        };
      }
    };
    const report = {
      overview: {
        objective_status: "met",
        objective_summary: "The declared primary score target was met for Candidate A.",
        selected_design_title: "Configured comparison",
        observed_value: 0.02,
        matched_metric_key: "primary_score_delta"
      },
      primary_findings: ["Candidate A improved over its declared reference."],
      primary_comparison_id: "comparison_primary",
      condition_comparisons: [
        {
          id: "comparison_secondary",
          label: "Candidate B vs reference",
          subject_series_id: "candidate_b",
          reference_series_id: "reference",
          metric_id: "primary_score_delta",
          metric_direction: "higher_better",
          summary: "The replication comparison is secondary.",
          hypothesis_supported: true
        },
        {
          id: "comparison_primary",
          label: "Candidate A vs reference",
          subject_series_id: "candidate_a",
          reference_series_id: "reference",
          metric_id: "primary_score_delta",
          metric_direction: "higher_better",
          summary: "The declared primary comparison improved by 0.02.",
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
            metric_key: "condition_results.candidate_a.primary_score",
            label: "Candidate A primary score",
            lower: 0.42,
            upper: 0.54,
            level: 0.95,
            sample_size: 24,
            source: "metrics",
            summary: "95% interval [0.42, 0.54] over 24 analysis units."
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
            condition_marker: "reference",
            replicate_count: 3,
            event_count: 132,
            observation_count: 288,
            confidence_interval: { sample_size: 288 },
            evaluation: {
              validation_partition: {
                event_count: 69,
                observation_count: 144,
                confidence_interval: { sample_size: 144 }
              },
              held_out_partition: {
                event_count: 63,
                observation_count: 144,
                confidence_interval: { sample_size: 144 }
              }
            }
          },
          {
            condition_marker: "candidate_a",
            replicate_count: 3,
            event_count: 138,
            observation_count: 288,
            confidence_interval: { sample_size: 288 },
            evaluation: {
              validation_partition: {
                event_count: 69,
                observation_count: 144,
                confidence_interval: { sample_size: 144 }
              },
              held_out_partition: {
                event_count: 69,
                observation_count: 144,
                confidence_interval: { sample_size: 144 }
              }
            }
          }
        ]
      }
    } as unknown as AnalysisReport;

    const synthesis = await synthesizeAnalysisReport({
      run: {
        id: "run-analysis-synthesis",
        topic: "Configured comparison",
        objectiveMetric: "Increase the declared primary score over the reference.",
        constraints: []
      },
      report,
      llm,
      eventStream: {
        emit(event: Record<string, any>) {
          emittedEvents.push(event);
          return event;
        }
      } as any,
      node: "analyze_results"
    });

    expect(capturedPrompt).toContain('"evidence_accounting"');
    expect(capturedPrompt).toContain('"max_repetition_count": 3');
    expect(capturedPrompt).toContain('"replicate_count"');
    expect(capturedPrompt).toContain('"max_interval_sample_size": 288');
    expect(capturedPrompt).toContain('"has_condition_denominator_pairs": true');
    expect(capturedPrompt).toContain('"has_nested_denominator_pairs": true');
    expect(capturedPrompt).toContain('"primary_comparison_id": "comparison_primary"');
    expect(capturedPrompt).toContain('"is_primary": true');
    expect(capturedPrompt.indexOf('"id": "comparison_primary"')).toBeLessThan(
      capturedPrompt.indexOf('"id": "comparison_secondary"')
    );
    expect(synthesis.discussion_points[0]).toContain("Evidence accounting:");
    const combined = JSON.stringify(synthesis);
    expect(combined).toContain("numerator/denominator pairs are not provided");
    expect(combined).toContain("single repetition");
    expect(combined).toContain("trial-accounting ambiguity");
    expect(combined).toContain("Use the structured result table in the writeup.");
    const progressTexts = emittedEvents
      .map((event) => event.payload?.text)
      .filter((text): text is string => typeof text === "string");
    expect(progressTexts).toEqual([
      "Generating grounded discussion synthesis for the structured result analysis.",
      "Result analysis synthesis: Provider request accepted.",
      "Result analysis synthesis response received; validating structured output."
    ]);
    expect(progressTexts.some((text) => text.includes("token-"))).toBe(false);
  });
});
