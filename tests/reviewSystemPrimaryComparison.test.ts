import { describe, expect, it } from "vitest";

import type { ResultsArtifactV2 } from "../src/core/analysis/resultsTableSchema.js";
import {
  MockLLMClient,
  type LLMClient,
  type LLMCompleteOptions
} from "../src/core/llm/client.js";
import {
  parseAnalysisReport,
  type AnalysisReport
} from "../src/core/resultAnalysis.js";
import {
  runReviewPanel,
  type ReviewArtifactPresence
} from "../src/core/reviewSystem.js";

const PRESENCE: ReviewArtifactPresence = {
  corpusPresent: true,
  paperSummariesPresent: true,
  evidenceStorePresent: true,
  hypothesesPresent: true,
  experimentPlanPresent: true,
  metricsPresent: true,
  figurePresent: true,
  synthesisPresent: true,
  baselineSummaryPresent: true,
  resultTablePresent: true,
  richnessSummaryPresent: true,
  richnessReadiness: "adequate"
};

function comparisonArtifact(
  primaryJudgement: "supported" | "not_supported",
  secondaryJudgement: "supported" | "not_supported"
): ResultsArtifactV2 {
  return {
    schema_version: "2.0",
    metrics: [
      {
        id: "primary_measure",
        label: "Primary measure",
        direction: "higher_better",
        unit: "unitless"
      }
    ],
    series: [
      {
        id: "candidate_series",
        label: "Candidate series",
        role: "primary",
        dimensions: { arm: "candidate" }
      },
      {
        id: "reference_series",
        label: "Reference series",
        role: "baseline",
        dimensions: { arm: "reference" }
      },
      {
        id: "secondary_series",
        label: "Secondary series",
        role: "comparator",
        dimensions: { arm: "secondary" }
      }
    ],
    observations: [
      {
        id: "candidate_observation",
        series_id: "candidate_series",
        metric_id: "primary_measure",
        scope: { partition: "evaluation" },
        value: primaryJudgement === "supported" ? 0.72 : 0.48
      },
      {
        id: "reference_observation",
        series_id: "reference_series",
        metric_id: "primary_measure",
        scope: { partition: "evaluation" },
        value: 0.6
      },
      {
        id: "secondary_observation",
        series_id: "secondary_series",
        metric_id: "primary_measure",
        scope: { partition: "evaluation" },
        value: secondaryJudgement === "supported" ? 0.68 : 0.42
      }
    ],
    comparisons: [
      {
        id: "declared_primary_comparison",
        subject_observation_id: "candidate_observation",
        reference_observation_id: "reference_observation",
        delta: (primaryJudgement === "supported" ? 0.72 : 0.48) - 0.6,
        judgement: primaryJudgement,
        evidence_refs: ["metrics.json#/primary"]
      },
      {
        id: "secondary_comparison",
        subject_observation_id: "secondary_observation",
        reference_observation_id: "reference_observation",
        delta: (secondaryJudgement === "supported" ? 0.68 : 0.42) - 0.6,
        judgement: secondaryJudgement,
        evidence_refs: ["metrics.json#/secondary"]
      }
    ]
  };
}

function reportWithComparisons(options: {
  primaryJudgement: "supported" | "not_supported";
  secondaryJudgement: "supported" | "not_supported";
  staleHypothesisBacktrack?: boolean;
}): AnalysisReport {
  const objectiveStatus = options.primaryJudgement === "supported" ? "met" : "not_met";
  const parsed = parseAnalysisReport(JSON.stringify({
    analysis_version: 1,
    generated_at: new Date().toISOString(),
    mean_score: options.primaryJudgement === "supported" ? 0.72 : 0.48,
    metrics: { primary_measure: options.primaryJudgement === "supported" ? 0.72 : 0.48 },
    objective_metric: {
      raw: "primary_measure improves over the declared reference",
      evaluation: {
        status: objectiveStatus,
        summary: `Objective metric ${objectiveStatus === "met" ? "met" : "not met"}.`
      },
      profile: {
        source: "default",
        primary_metric: "primary_measure",
        preferred_metric_keys: ["primary_measure"],
        analysis_focus: [],
        paper_emphasis: [],
        assumptions: []
      }
    },
    overview: {
      objective_status: objectiveStatus,
      objective_summary: `Objective metric ${objectiveStatus === "met" ? "met" : "not met"}.`,
      execution_runs: 3
    },
    plan_context: {
      selected_design: {
        id: "declared_design",
        title: "Declared comparison design",
        summary: "Evaluate a declared primary comparison.",
        selected_hypothesis_ids: ["hypothesis_1"],
        metrics: ["primary_measure"],
        baselines: ["Reference series"],
        implementation_notes: [],
        evaluation_steps: ["run three repeated evaluations"],
        risks: [],
        resource_notes: []
      },
      shortlisted_designs: [],
      design_notes: [],
      implementation_notes: [],
      evaluation_notes: [],
      assumptions: []
    },
    metric_table: [{ key: "primary_measure", value: 0.72 }],
    results_artifact: comparisonArtifact(
      options.primaryJudgement,
      options.secondaryJudgement
    ),
    primary_comparison_id: "declared_primary_comparison",
    condition_comparisons: [],
    execution_summary: {
      observation_count: 3,
      commands: ["node run_declared_comparison.js"],
      sources: ["local_node"],
      stderr_excerpts: []
    },
    primary_findings: ["The declared primary comparison was executed."],
    limitations: [],
    warnings: [],
    paper_claims: [],
    figure_specs: [
      {
        id: "primary_figure",
        title: "Primary comparison",
        path: "figures/performance.svg",
        metric_keys: ["primary_measure"],
        summary: "The primary comparison is plotted."
      }
    ],
    supplemental_runs: [],
    external_comparisons: [],
    statistical_summary: {
      total_trials: 3,
      executed_trials: 3,
      cached_trials: 0,
      confidence_intervals: [
        {
          metric_key: "primary_measure",
          label: "Primary measure interval",
          lower: 0.4,
          upper: 0.8,
          level: 0.95,
          sample_size: 3,
          source: "metrics",
          summary: "A repeated-evaluation interval was recorded."
        }
      ],
      stability_metrics: [],
      effect_estimates: [],
      notes: []
    },
    failure_taxonomy: [],
    synthesis: {
      source: "fallback",
      discussion_points: ["The primary comparison determines hypothesis support."],
      failure_analysis: [],
      follow_up_actions: [],
      confidence_statement: "Confidence is bounded by the declared primary comparison."
    },
    ...(options.staleHypothesisBacktrack
      ? {
          transition_recommendation: {
            action: "backtrack_to_hypotheses",
            sourceNode: "analyze_results",
            targetNode: "generate_hypotheses",
            reason: "A secondary comparison was unsupported.",
            confidence: 0.8,
            autoExecutable: true,
            evidence: ["secondary_comparison"],
            suggestedCommands: [],
            generatedAt: new Date().toISOString()
          }
        }
      : {})
  }));

  if (!parsed) {
    throw new Error("Expected the canonical review fixture to parse.");
  }
  return parsed;
}

async function runPanel(report: AnalysisReport) {
  return runReviewPanel({
    run: {
      id: "run-review-primary-comparison",
      title: "Primary comparison review",
      topic: "Domain-neutral comparison review",
      objectiveMetric: "primary_measure improves over the declared reference",
      constraints: []
    },
    node: "review",
    report,
    presence: PRESENCE,
    llm: new MockLLMClient()
  });
}

class StructuredReviewLlm implements LLMClient {
  readonly prompts: string[] = [];
  private callCount = 0;

  constructor(private readonly failAtCall?: number) {}

  async complete(prompt: string, opts?: LLMCompleteOptions) {
    this.callCount += 1;
    this.prompts.push(prompt);
    if (this.callCount === this.failAtCall) {
      throw new Error("bounded reviewer failure");
    }
    const responseId = `response-${opts?.model || "default"}-${this.callCount}`;
    return {
      text: JSON.stringify({
        summary: "The supplied evidence is reviewable within its declared ceiling.",
        score_1_to_5: 4,
        confidence: 0.8,
        recommendation: "advance",
        findings: []
      }),
      threadId: responseId,
      usage: { inputTokens: 20, outputTokens: 10, costUsd: 0 },
      provenance: {
        provider: "openai" as const,
        requestedModel: opts?.model || "",
        effectiveModel: opts?.model || "",
        reasoningEffort: opts?.reasoningEffort || "",
        responseId,
        contextMode: "fresh" as const,
        identityBasis: "provider_response" as const
      }
    };
  }
}

function reviewBinding(llm: LLMClient, model = "review-model") {
  return {
    llm,
    profile: {
      provider: "openai",
      model,
      reasoning_effort: "high"
    }
  };
}

async function runAssuredPanel(options: {
  specialistLlm: LLMClient;
  metaLlm?: LLMClient;
  specialistModel?: string;
  metaModel?: string;
  unverifiedProfile?: boolean;
}) {
  const report = reportWithComparisons({
    primaryJudgement: "supported",
    secondaryJudgement: "supported"
  });
  const specialist = reviewBinding(options.specialistLlm, options.specialistModel);
  const meta = reviewBinding(options.metaLlm ?? options.specialistLlm, options.metaModel);
  if (options.unverifiedProfile) {
    specialist.profile.provider = "unverified";
    meta.profile.provider = "unverified";
  }
  return runReviewPanel({
    run: {
      id: "run-review-assurance",
      title: "Assured review",
      topic: "Domain-neutral review assurance",
      objectiveMetric: "primary_measure improves over the declared reference",
      constraints: []
    },
    node: "review",
    report,
    presence: PRESENCE,
    llm: options.specialistLlm,
    specialistAgent: specialist,
    metaReviewer: meta,
    gateBinding: {
      artifact_id: "review.minimum_gate",
      sha256: "a".repeat(64)
    },
    requireIndependentReview: true
  });
}

describe("review system primary comparison binding", () => {
  it("does not reset the hypothesis when the primary is supported and a secondary is unsupported", async () => {
    const report = reportWithComparisons({
      primaryJudgement: "supported",
      secondaryJudgement: "not_supported",
      staleHypothesisBacktrack: true
    });

    const panel = await runPanel(report);

    expect(panel.decision.outcome).not.toBe("backtrack_to_hypotheses");
    expect(panel.decision.recommended_transition).not.toBe("backtrack_to_hypotheses");
  });

  it("resets the hypothesis when the explicit primary comparison is unsupported", async () => {
    const report = reportWithComparisons({
      primaryJudgement: "not_supported",
      secondaryJudgement: "supported"
    });

    const panel = await runPanel(report);

    expect(panel.decision).toMatchObject({
      outcome: "backtrack_to_hypotheses",
      recommended_transition: "backtrack_to_hypotheses"
    });
  });

  it("does not let a secondary effect estimate satisfy the primary effect requirement", async () => {
    const report = reportWithComparisons({
      primaryJudgement: "supported",
      secondaryJudgement: "supported"
    });
    report.statistical_summary.effect_estimates = report.statistical_summary.effect_estimates.filter(
      (item) => item.comparison_id === "secondary_comparison"
    );

    const panel = await runPanel(report);

    expect(panel.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "statistics",
          title: "Missing primary effect estimate summary"
        })
      ])
    );
  });

  it("authorizes paper readiness only after five model specialists and a bound fresh meta review", async () => {
    const specialistLlm = new StructuredReviewLlm();
    const metaLlm = new StructuredReviewLlm();

    const panel = await runAssuredPanel({
      specialistLlm,
      metaLlm,
      specialistModel: "specialist-model",
      metaModel: "meta-model"
    });

    expect(panel.assurance).toMatchObject({
      assurance_class: "runtime_attested_actor_diverse_panel_with_meta_review",
      completed_model_specialist_roles: [
        "claim_evidence",
        "methodology",
        "statistics",
        "reproducibility",
        "adversarial"
      ],
      heuristic_fallback_roles: [],
      meta_review_completed: true,
      unique_actor_count: 2,
      unique_execution_count: 6,
      provider_response_receipt_count: 6,
      adapter_attested_receipt_count: 0,
      isolation_evidence: "runtime_attested",
      model_review_bundle_valid: true,
      paper_ready_eligible: true,
      reason_codes: []
    });
    expect(panel.model_review_bundle?.reviewers).toHaveLength(5);
    expect(panel.meta_review?.source).toBe("llm+heuristic");
    expect(specialistLlm.prompts).toHaveLength(5);
    expect(metaLlm.prompts).toHaveLength(1);
    expect(specialistLlm.prompts.every((prompt) => !prompt.includes("heuristic_baseline"))).toBe(true);
  });

  it("fails closed when one specialist falls back and never runs the meta reviewer", async () => {
    const specialistLlm = new StructuredReviewLlm(3);
    const metaLlm = new StructuredReviewLlm();

    const panel = await runAssuredPanel({ specialistLlm, metaLlm });

    expect(panel.assurance).toMatchObject({
      assurance_class: "role_separated_panel",
      heuristic_fallback_roles: ["statistics"],
      meta_review_completed: false,
      model_review_bundle_valid: false,
      paper_ready_eligible: false
    });
    expect(panel.assurance.reason_codes).toEqual(
      expect.arrayContaining([
        "specialist_model_review_incomplete",
        "meta_review_incomplete",
        "model_review_bundle_invalid"
      ])
    );
    expect(panel.decision.outcome).toBe("manual_block");
    expect(panel.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewer_id: "review_assurance_gate",
          severity: "high"
        })
      ])
    );
    expect(metaLlm.prompts).toHaveLength(0);
  });

  it("does not accept caller-supplied unverified actor labels as review assurance", async () => {
    const llm = new StructuredReviewLlm();

    const panel = await runAssuredPanel({
      specialistLlm: llm,
      unverifiedProfile: true
    });

    expect(panel.assurance.model_review_bundle_valid).toBe(false);
    expect(panel.assurance.paper_ready_eligible).toBe(false);
    expect(panel.assurance.transport_receipt_failure_roles).toEqual([
      "claim_evidence",
      "methodology",
      "statistics",
      "reproducibility",
      "adversarial"
    ]);
    expect(panel.assurance.reason_codes).toContain(
      "specialist_transport_receipt_missing_or_mismatched"
    );
    expect(panel.decision.outcome).toBe("manual_block");
  });
});
