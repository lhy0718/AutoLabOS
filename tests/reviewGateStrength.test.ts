import { describe, it, expect } from "vitest";
import { buildPreDraftCritique } from "../src/core/paperCritique.js";
import { buildNodeStrengtheningRecommendations } from "../src/core/nodes/review.js";
import type { ReviewArtifactPresence, ReviewScorecard, ReviewDecision, ReviewFinding } from "../src/core/reviewSystem.js";

function makePresence(overrides: Partial<ReviewArtifactPresence> = {}): ReviewArtifactPresence {
  return {
    corpusPresent: true,
    paperSummariesPresent: true,
    evidenceStorePresent: true,
    hypothesesPresent: true,
    experimentPlanPresent: true,
    metricsPresent: true,
    figurePresent: false,
    synthesisPresent: true,
    baselineSummaryPresent: true,
    resultTablePresent: true,
    richnessSummaryPresent: true,
    richnessReadiness: "adequate",
    ...overrides
  };
}

function makeScorecard(overall = 3.5): ReviewScorecard {
  return {
    overall_score_1_to_5: overall,
    dimensions: [
      { dimension: "claim_verification", label: "Claim Verification", score_1_to_5: overall, confidence: 0.8, summary: "ok", top_finding_ids: [] },
      { dimension: "methodology", label: "Methodology", score_1_to_5: overall, confidence: 0.8, summary: "ok", top_finding_ids: [] },
      { dimension: "statistics", label: "Statistics", score_1_to_5: overall, confidence: 0.8, summary: "ok", top_finding_ids: [] },
      { dimension: "writing_readiness", label: "Writing Readiness", score_1_to_5: overall, confidence: 0.8, summary: "ok", top_finding_ids: [] },
      { dimension: "integrity", label: "Integrity", score_1_to_5: overall + 0.5, confidence: 0.8, summary: "ok", top_finding_ids: [] }
    ]
  };
}

function makeDecision(): ReviewDecision {
  return {
    outcome: "advance",
    recommended_transition: "advance",
    confidence: 0.8,
    summary: "Ready to write",
    rationale: "test rationale",
    blocking_finding_ids: [],
    required_actions: []
  };
}

describe("review gate with new artifacts", () => {
  it("all 3 artifacts missing → blocked_for_paper_scale", () => {
    const presence = makePresence({
      baselineSummaryPresent: false,
      resultTablePresent: false,
      richnessSummaryPresent: false,
      richnessReadiness: "unknown"
    });
    const critique = buildPreDraftCritique({
      venueStyle: "generic_cs_paper",
      scorecard: makeScorecard(),
      decision: makeDecision(),
      findings: [],
      presence
    });
    expect(critique.manuscript_type).toBe("blocked_for_paper_scale");
  });

  it("richness insufficient → research_memo at most", () => {
    const presence = makePresence({
      richnessReadiness: "insufficient"
    });
    const critique = buildPreDraftCritique({
      venueStyle: "generic_cs_paper",
      scorecard: makeScorecard(),
      decision: makeDecision(),
      findings: [],
      presence
    });
    expect(["research_memo", "system_validation_note"]).toContain(critique.manuscript_type);
  });

  it("all present + adequate → can reach paper_ready or paper_scale_candidate", () => {
    const presence = makePresence();
    const critique = buildPreDraftCritique({
      venueStyle: "generic_cs_paper",
      scorecard: makeScorecard(),
      decision: makeDecision(),
      findings: [],
      presence
    });
    expect(["paper_ready", "paper_scale_candidate"]).toContain(critique.manuscript_type);
  });

  it("2 of 3 missing with high scores → capped at research_memo", () => {
    const presence = makePresence({
      baselineSummaryPresent: false,
      resultTablePresent: false,
      richnessSummaryPresent: true,
      richnessReadiness: "adequate"
    });
    const critique = buildPreDraftCritique({
      venueStyle: "generic_cs_paper",
      scorecard: makeScorecard(3.5),
      decision: makeDecision(),
      findings: [],
      presence
    });
    expect(critique.manuscript_type).toBe("research_memo");
  });

  it("maps review findings into node-strengthening recommendations when minimum diagnostics are empty", () => {
    const findings: ReviewFinding[] = [
      {
        id: "claim_verifier_claims_outpace_measured_outcome",
        reviewer_id: "claim_verifier",
        reviewer_label: "Claim verifier",
        dimension: "claim_verification",
        severity: "high",
        title: "Claims outpace measured outcome",
        detail: "Paper claims exist even though the configured objective is not met.",
        claim_ids: ["objective_metric_not_met"],
        evidence_paths: ["result_analysis.json"],
        fix_hint: "Reduce claims or rerun experiments until the objective is met.",
        confidence: 0.86
      },
      {
        id: "statistics_reviewer_no_confidence_intervals",
        reviewer_id: "statistics_reviewer",
        reviewer_label: "Statistics reviewer",
        dimension: "statistics",
        severity: "medium",
        title: "No confidence intervals",
        detail: "The report does not provide confidence intervals for the primary metrics.",
        claim_ids: [],
        evidence_paths: ["result_analysis.json"],
        fix_hint: "Add repeated-trial confidence intervals before writing stronger results claims.",
        confidence: 0.84
      }
    ];
    const decision: ReviewDecision = {
      outcome: "backtrack_to_hypotheses",
      recommended_transition: "backtrack_to_hypotheses",
      confidence: 0.77,
      summary: "Backtrack to hypotheses: the current claim set is no longer well supported.",
      rationale: "Claims outpace measured outcome.",
      blocking_finding_ids: ["claim_verifier_claims_outpace_measured_outcome"],
      required_actions: [
        "Reduce claims or rerun experiments until the objective is met.",
        "Add repeated-trial confidence intervals before writing stronger results claims."
      ]
    };

    const artifact = buildNodeStrengtheningRecommendations([], findings, decision);

    expect(artifact.recommendations.length).toBeGreaterThan(0);
    expect(artifact.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node: "generate_hypotheses",
          priority: "high",
          diagnostic_ids: expect.arrayContaining([
            "finding:claim_verifier_claims_outpace_measured_outcome",
            "decision:backtrack_to_hypotheses"
          ])
        }),
        expect.objectContaining({
          node: "analyze_results",
          diagnostic_ids: expect.arrayContaining(["finding:statistics_reviewer_no_confidence_intervals"])
        })
      ])
    );
  });
});
