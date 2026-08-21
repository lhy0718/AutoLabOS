import { describe, expect, it } from "vitest";

import {
  isSourceVisibilityLimitation,
  parseReusableResearchGapSynthesisArtifact,
  synthesizeResearchGapClusters,
  type ResearchGapSynthesisContext,
  type ResearchOpportunityType
} from "../src/core/analysis/researchGapSynthesis.js";
import type { HypothesisEvidenceSeed } from "../src/core/analysis/researchPlanning.js";
import type {
  LLMClient,
  LLMCompleteOptions
} from "../src/core/llm/client.js";
import { hashCanonical } from "../src/core/canonicalHash.js";

const CONTEXT: ResearchGapSynthesisContext = {
  runId: "run_gap_fixture",
  researchCycle: 3,
  collectAttemptId: "attempt_generic_3",
  corpusSha256: "a".repeat(64),
  evidenceSha256: "b".repeat(64)
};

const REQUIRED_REVIEW_CONDITIONS = {
  explicit_limitation: ["same_unresolved_limitation"],
  cross_paper_result_disagreement: [
    "same_research_question",
    "genuine_result_disagreement",
    "not_task_or_metric_mismatch"
  ],
  boundary_or_transfer_mismatch: [
    "boundary_difference_grounded",
    "transfer_gap_unresolved"
  ],
  missing_comparator_or_control: [
    "comparator_absence_grounded",
    "omission_affects_inference"
  ],
  reproducibility_gap: [
    "reproducibility_omission_grounded",
    "omission_affects_reproduction"
  ]
} as const satisfies Record<ResearchOpportunityType, readonly string[]>;

const OPPORTUNITY_STATEMENTS: Record<ResearchOpportunityType, string> = {
  explicit_limitation:
    "Independent studies leave the same stated evaluation limitation unresolved.",
  cross_paper_result_disagreement:
    "Independent studies report conflicting results under the same comparison frame.",
  boundary_or_transfer_mismatch:
    "Independent studies leave transfer across grounded evaluation boundaries unresolved.",
  missing_comparator_or_control:
    "Independent studies omit a comparator needed to isolate the reported effect.",
  reproducibility_gap:
    "Independent studies omit execution details needed for faithful reproduction."
};

class SequenceLlm implements LLMClient {
  readonly prompts: string[] = [];

  constructor(private readonly responses: string[]) {}

  async complete(prompt: string, _options?: LLMCompleteOptions): Promise<{ text: string }> {
    this.prompts.push(prompt);
    const response = this.responses[this.prompts.length - 1];
    if (response === undefined) {
      throw new Error("unexpected_test_llm_call");
    }
    return { text: response };
  }
}

describe("research gap synthesis", () => {
  it.each([
    "The supplied excerpt does not report the evaluation denominator.",
    "The visible source text is truncated before the ablation section.",
    "The method details are not reported in the abstract.",
    "The criterion names are not visible in the provided source.",
    "The supplied source does not show the statistical test.",
    "The provided source text omits the ablation table.",
    "Only the first ten PDF pages were retrieved."
  ])("classifies source visibility caveats: %s", (statement) => {
    expect(isSourceVisibilityLimitation(statement)).toBe(true);
  });

  it("does not classify a scientific coverage limitation as a source caveat", () => {
    expect(
      isSourceVisibilityLimitation(
        "The evaluation includes one domain and does not test whether the effect transfers across domains."
      )
    ).toBe(false);
    expect(
      isSourceVisibilityLimitation(
        "The provided source code lacks concurrency control under parallel requests."
      )
    ).toBe(false);
  });

  it("accepts an explicit limitation only after review validates the shared unresolved limitation", async () => {
    const evidenceIds = ["ev_explicit_alpha", "ev_explicit_beta"];
    const llm = new SequenceLlm(
      acceptedResponses(
        "explicit_limitation",
        evidenceIds,
        REQUIRED_REVIEW_CONDITIONS.explicit_limitation,
        "cluster_explicit"
      )
    );

    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        explicitLimitationEvidence(
          evidenceIds[0],
          "paper_alpha",
          "The evaluation leaves transfer testing across deployment regions unresolved."
        ),
        explicitLimitationEvidence(
          evidenceIds[1],
          "paper_beta",
          "Transfer testing across deployment regions remains outside the evaluation scope."
        )
      ],
      context: CONTEXT
    });

    expect(result.toolCallsUsed).toBe(2);
    expect(result.artifact).toMatchObject({
      schema_version: 2,
      semantics_version: 3,
      accepted_clusters: [{
        cluster_id: "cluster_explicit",
        opportunity_type: "explicit_limitation",
        evidence_ids: evidenceIds,
        paper_ids: ["paper_alpha", "paper_beta"]
      }]
    });
    expect(result.artifact.reviews[0]).toMatchObject({
      decision: "accept",
      validated_conditions: ["same_unresolved_limitation"]
    });
  });

  it("accepts conflicting results only for a shared dataset and metric with every review condition", async () => {
    const evidenceIds = ["ev_result_alpha", "ev_result_beta"];
    const llm = new SequenceLlm(
      acceptedResponses(
        "cross_paper_result_disagreement",
        evidenceIds,
        REQUIRED_REVIEW_CONDITIONS.cross_paper_result_disagreement,
        "cluster_result_disagreement"
      )
    );

    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        resultEvidence(
          evidenceIds[0],
          "paper_alpha",
          "The intervention increases calibrated response score by twelve points.",
          "Shared evaluation corpus",
          "Calibrated response score"
        ),
        resultEvidence(
          evidenceIds[1],
          "paper_beta",
          "The intervention decreases calibrated response score by eight points.",
          "Shared evaluation corpus",
          "Calibrated response score"
        )
      ],
      context: CONTEXT
    });

    expect(result.artifact.accepted_clusters).toEqual([
      expect.objectContaining({
        cluster_id: "cluster_result_disagreement",
        opportunity_type: "cross_paper_result_disagreement",
        evidence_ids: evidenceIds
      })
    ]);
    expect(result.artifact.reviews[0]).toMatchObject({
      decision: "accept",
      validated_conditions: REQUIRED_REVIEW_CONDITIONS.cross_paper_result_disagreement
    });
  });

  it("does not infer an opportunity from topical similarity alone", async () => {
    const llm = new SequenceLlm([]);
    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        genericEvidence("ev_topic_alpha", "paper_alpha", {
          claim: "The study analyzes reliability in a constrained evaluation setting.",
          evidence_span: "The study analyzes reliability in a constrained evaluation setting."
        }),
        genericEvidence("ev_topic_beta", "paper_beta", {
          claim: "The study analyzes reliability in a separate evaluation setting.",
          evidence_span: "The study analyzes reliability in a separate evaluation setting."
        })
      ],
      context: CONTEXT
    });

    expect(result.toolCallsUsed).toBe(0);
    expect(result.artifact.accepted_clusters).toEqual([]);
    expect(result.artifact.excluded_evidence).toEqual([
      { evidence_id: "ev_topic_alpha", reason: "no_supported_opportunity_signal" },
      { evidence_id: "ev_topic_beta", reason: "no_supported_opportunity_signal" }
    ]);
  });

  it("rejects apparent result disagreement across different task and metric frames", async () => {
    const evidenceIds = ["ev_frame_alpha", "ev_frame_beta"];
    const llm = new SequenceLlm([
      proposalResponse(
        "cross_paper_result_disagreement",
        evidenceIds,
        "cluster_frame_mismatch"
      )
    ]);

    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        resultEvidence(
          evidenceIds[0],
          "paper_alpha",
          "The intervention increases normalized utility by twelve points.",
          "Evaluation corpus alpha",
          "Normalized utility index"
        ),
        resultEvidence(
          evidenceIds[1],
          "paper_beta",
          "The intervention decreases calibrated fidelity by eight points.",
          "Evaluation corpus beta",
          "Calibrated fidelity ratio"
        )
      ],
      context: CONTEXT
    });

    expect(result.toolCallsUsed).toBe(1);
    expect(result.artifact.proposed_clusters).toEqual([]);
    expect(result.artifact.accepted_clusters).toEqual([]);
  });

  it("uses only grounded comparator or control omissions and excludes blank-field inference", async () => {
    const evidenceIds = ["ev_comparator_alpha", "ev_comparator_beta"];
    const llm = new SequenceLlm(
      acceptedResponses(
        "missing_comparator_or_control",
        evidenceIds,
        REQUIRED_REVIEW_CONDITIONS.missing_comparator_or_control,
        "cluster_missing_comparator"
      )
    );

    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        reportingEvidence(
          evidenceIds[0],
          "paper_alpha",
          "The evaluation omits a matched comparator for the reported intervention effect."
        ),
        reportingEvidence(
          evidenceIds[1],
          "paper_beta",
          "No control arm is included for the reported intervention effect."
        ),
        genericEvidence("ev_inferred_comparator", "paper_gamma", {
          limitation_kind: "reporting",
          limitation_slot: "A comparator may be missing, but the grounded span does not state that omission.",
          evidence_span: "The source reports the primary outcome estimate for the intervention."
        })
      ],
      context: CONTEXT
    });

    expect(result.artifact.accepted_clusters).toEqual([
      expect.objectContaining({
        cluster_id: "cluster_missing_comparator",
        opportunity_type: "missing_comparator_or_control",
        evidence_ids: evidenceIds
      })
    ]);
    expect(result.artifact.excluded_evidence).toContainEqual({
      evidence_id: "ev_inferred_comparator",
      reason: "no_supported_opportunity_signal"
    });
    expect(llm.prompts[0]).not.toContain("ev_inferred_comparator");
  });

  it("accepts a reproducibility gap only when grounded spans state the omission", async () => {
    const evidenceIds = ["ev_repro_alpha", "ev_repro_beta"];
    const llm = new SequenceLlm(
      acceptedResponses(
        "reproducibility_gap",
        evidenceIds,
        REQUIRED_REVIEW_CONDITIONS.reproducibility_gap,
        "cluster_reproducibility"
      )
    );

    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        reportingEvidence(
          evidenceIds[0],
          "paper_alpha",
          "The released materials omit the random seed required to reproduce the sampling sequence."
        ),
        reportingEvidence(
          evidenceIds[1],
          "paper_beta",
          "No software version is reported for the executable protocol."
        )
      ],
      context: CONTEXT
    });

    expect(result.artifact.accepted_clusters).toEqual([
      expect.objectContaining({
        cluster_id: "cluster_reproducibility",
        opportunity_type: "reproducibility_gap",
        evidence_ids: evidenceIds
      })
    ]);
  });

  it("requires a grounded boundary signal and different frames for transfer opportunities", async () => {
    const acceptedIds = ["ev_boundary_alpha", "ev_boundary_beta"];
    const sameFrameIds = ["ev_boundary_gamma", "ev_boundary_delta"];
    const noBoundaryIds = ["ev_no_boundary_alpha", "ev_no_boundary_beta"];
    const llm = new SequenceLlm([
      JSON.stringify({
        clusters: [
          clusterProposal(
            "boundary_or_transfer_mismatch",
            acceptedIds,
            "cluster_boundary_valid"
          ),
          clusterProposal(
            "boundary_or_transfer_mismatch",
            sameFrameIds,
            "cluster_boundary_same_frame"
          )
        ]
      }),
      reviewResponse(
        "boundary_or_transfer_mismatch",
        acceptedIds,
        REQUIRED_REVIEW_CONDITIONS.boundary_or_transfer_mismatch,
        "cluster_boundary_valid"
      )
    ]);

    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        boundaryEvidence(
          acceptedIds[0],
          "paper_alpha",
          "Regional evaluation corpus alpha",
          "Structured estimator variant alpha",
          "The full text marks cross-domain transfer as unresolved for the evaluated system."
        ),
        boundaryEvidence(
          acceptedIds[1],
          "paper_beta",
          "Regional evaluation corpus beta",
          "Structured estimator variant beta",
          "The full text marks out-of-domain generalization as unresolved for the evaluated system."
        ),
        boundaryEvidence(
          sameFrameIds[0],
          "paper_gamma",
          "Shared boundary evaluation corpus",
          "Shared structured estimator",
          "The full text marks cross-task transfer as unresolved for the evaluated system."
        ),
        boundaryEvidence(
          sameFrameIds[1],
          "paper_delta",
          "Shared boundary evaluation corpus",
          "Shared structured estimator",
          "The full text marks unseen-task generalization as unresolved for the evaluated system."
        ),
        boundaryEvidence(
          noBoundaryIds[0],
          "paper_epsilon",
          "Unreported evaluation corpus alpha",
          "Unreported estimator variant alpha",
          "The source gives a conventional evaluation summary with complete measurements."
        ),
        boundaryEvidence(
          noBoundaryIds[1],
          "paper_zeta",
          "Unreported evaluation corpus beta",
          "Unreported estimator variant beta",
          "The source gives another conventional evaluation summary with complete measurements."
        )
      ],
      context: CONTEXT
    });

    expect(result.artifact.proposed_clusters.map((cluster) => cluster.cluster_id)).toEqual([
      "cluster_boundary_valid"
    ]);
    expect(result.artifact.accepted_clusters).toEqual([
      expect.objectContaining({
        cluster_id: "cluster_boundary_valid",
        opportunity_type: "boundary_or_transfer_mismatch",
        evidence_ids: acceptedIds
      })
    ]);
    expect(result.artifact.excluded_evidence).toEqual(
      expect.arrayContaining(
        noBoundaryIds.map((evidenceId) => ({
          evidence_id: evidenceId,
          reason: "no_supported_opportunity_signal"
        }))
      )
    );
  });

  it("downgrades an accept response when one required review condition is missing", async () => {
    const evidenceIds = ["ev_condition_alpha", "ev_condition_beta"];
    const llm = new SequenceLlm([
      proposalResponse(
        "cross_paper_result_disagreement",
        evidenceIds,
        "cluster_missing_condition"
      ),
      reviewResponse(
        "cross_paper_result_disagreement",
        evidenceIds,
        ["same_research_question", "genuine_result_disagreement"],
        "cluster_missing_condition"
      )
    ]);

    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        resultEvidence(
          evidenceIds[0],
          "paper_alpha",
          "The treatment increases normalized response score by ten points.",
          "Shared condition corpus",
          "Normalized response score"
        ),
        resultEvidence(
          evidenceIds[1],
          "paper_beta",
          "The treatment decreases normalized response score by six points.",
          "Shared condition corpus",
          "Normalized response score"
        )
      ],
      context: CONTEXT
    });

    expect(result.toolCallsUsed).toBe(2);
    expect(result.artifact.accepted_clusters).toEqual([]);
    expect(result.artifact.reviews).toEqual([
      expect.objectContaining({
        cluster_id: "cluster_missing_condition",
        decision: "reject",
        accepted_evidence_ids: [],
        validated_conditions: []
      })
    ]);
  });

  it("continues to exclude source-visibility, abstract-only, and low-confidence evidence", async () => {
    const acceptedIds = ["ev_visible_alpha", "ev_visible_beta"];
    const llm = new SequenceLlm(
      acceptedResponses(
        "explicit_limitation",
        acceptedIds,
        REQUIRED_REVIEW_CONDITIONS.explicit_limitation,
        "cluster_visible_evidence"
      )
    );

    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        explicitLimitationEvidence(
          acceptedIds[0],
          "paper_alpha",
          "The evaluation leaves transfer testing across operational settings unresolved."
        ),
        explicitLimitationEvidence(
          acceptedIds[1],
          "paper_beta",
          "Transfer testing across operational settings remains outside the evaluation."
        ),
        genericEvidence("ev_visibility", "paper_gamma", {
          limitation_kind: "source_visibility",
          limitation_slot: "The supplied excerpt does not report the evaluation denominator.",
          evidence_span: "The supplied excerpt does not report the evaluation denominator."
        }),
        explicitLimitationEvidence(
          "ev_abstract_only",
          "paper_delta",
          "The evaluation leaves transfer testing across operational settings unresolved.",
          {
            source_type: "abstract",
            source_scope: "abstract"
          }
        ),
        explicitLimitationEvidence(
          "ev_low_confidence",
          "paper_epsilon",
          "The evaluation leaves transfer testing across operational settings unresolved.",
          {
            confidence: 0.59
          }
        )
      ],
      context: CONTEXT
    });

    expect(result.artifact.excluded_evidence).toEqual(
      expect.arrayContaining([
        { evidence_id: "ev_visibility", reason: "source_visibility" },
        { evidence_id: "ev_abstract_only", reason: "insufficient_source_scope" },
        { evidence_id: "ev_low_confidence", reason: "insufficient_confidence" }
      ])
    );
    for (const excludedId of ["ev_visibility", "ev_abstract_only", "ev_low_confidence"]) {
      expect(llm.prompts[0]).not.toContain(excludedId);
    }
  });

  it("keeps rejected, hallucinated, and single-work clusters out of accepted evidence", async () => {
    const llm = new SequenceLlm([
      JSON.stringify({
        clusters: [
          clusterProposal(
            "explicit_limitation",
            ["ev_alpha", "ev_beta"],
            "cluster_valid_but_rejected"
          ),
          clusterProposal(
            "explicit_limitation",
            ["ev_alpha", "ev_missing"],
            "cluster_hallucinated"
          ),
          clusterProposal(
            "explicit_limitation",
            ["ev_alpha", "ev_alpha_alias"],
            "cluster_single_work"
          )
        ]
      }),
      JSON.stringify({
        reviews: [{
          cluster_id: "cluster_valid_but_rejected",
          opportunity_type: "explicit_limitation",
          decision: "reject",
          accepted_evidence_ids: ["ev_alpha", "ev_beta"],
          validated_conditions: ["same_unresolved_limitation"],
          reason: "The records do not establish the same unresolved limitation."
        }]
      })
    ]);
    const sharedWorkId = "work_shared_alpha";
    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        explicitLimitationEvidence(
          "ev_alpha",
          "paper_alpha",
          "The evaluation omits an independent transfer assessment.",
          { canonical_work_id: sharedWorkId }
        ),
        explicitLimitationEvidence(
          "ev_alpha_alias",
          "paper_alpha_alias",
          "An independent transfer assessment remains outside the evaluation.",
          { canonical_work_id: sharedWorkId }
        ),
        explicitLimitationEvidence(
          "ev_beta",
          "paper_beta",
          "The evaluation omits an independent transfer assessment."
        )
      ],
      context: CONTEXT
    });

    expect(result.artifact.proposed_clusters.map((cluster) => cluster.cluster_id)).toEqual([
      "cluster_valid_but_rejected"
    ]);
    expect(result.artifact.accepted_clusters).toEqual([]);
    expect(result.artifact.unclustered_evidence_ids).toEqual([
      "ev_alpha",
      "ev_alpha_alias",
      "ev_beta"
    ]);
  });

  it("does not count two identifiers for the same canonical work as independent support", async () => {
    const sharedWorkId = "work_shared_alias";
    const llm = new SequenceLlm([
      proposalResponse(
        "explicit_limitation",
        ["ev_alias_alpha", "ev_alias_beta"],
        "cluster_alias_collision"
      )
    ]);

    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        explicitLimitationEvidence(
          "ev_alias_alpha",
          "paper_alias_alpha",
          "The evaluation omits an independent transfer assessment.",
          { canonical_work_id: sharedWorkId }
        ),
        explicitLimitationEvidence(
          "ev_alias_beta",
          "paper_alias_beta",
          "An independent transfer assessment remains outside the evaluation.",
          { canonical_work_id: sharedWorkId }
        )
      ],
      context: CONTEXT
    });

    expect(result.toolCallsUsed).toBe(1);
    expect(result.artifact.proposed_clusters).toEqual([]);
    expect(result.artifact.accepted_clusters).toEqual([]);
  });

  it("rejects old schema and old semantics artifacts even when hashes are recomputed", async () => {
    const llm = new SequenceLlm([JSON.stringify({ clusters: [] })]);
    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        explicitLimitationEvidence(
          "ev_reuse_alpha",
          "paper_alpha",
          "The evaluation omits an independent transfer assessment."
        ),
        explicitLimitationEvidence(
          "ev_reuse_beta",
          "paper_beta",
          "An independent transfer assessment remains outside the evaluation."
        )
      ],
      context: CONTEXT
    });
    const raw = JSON.stringify(result.artifact);

    expect(parseReusableResearchGapSynthesisArtifact(raw, CONTEXT)).toEqual(result.artifact);

    const oldSchema = JSON.parse(raw) as Record<string, unknown>;
    oldSchema.schema_version = 1;
    expect(
      parseReusableResearchGapSynthesisArtifact(rehashArtifact(oldSchema), CONTEXT)
    ).toBeUndefined();

    const oldSemantics = JSON.parse(raw) as Record<string, unknown>;
    oldSemantics.semantics_version = 2;
    expect(
      parseReusableResearchGapSynthesisArtifact(rehashArtifact(oldSemantics), CONTEXT)
    ).toBeUndefined();
  });

  it("reuses only deeply valid artifacts bound to the exact evidence generation", async () => {
    const llm = new SequenceLlm([JSON.stringify({ clusters: [] })]);
    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        explicitLimitationEvidence(
          "ev_alpha",
          "paper_alpha",
          "The evaluation omits an independent transfer assessment."
        ),
        explicitLimitationEvidence(
          "ev_beta",
          "paper_beta",
          "An independent transfer assessment remains outside the evaluation."
        )
      ],
      context: CONTEXT
    });
    const raw = JSON.stringify(result.artifact);

    expect(parseReusableResearchGapSynthesisArtifact(raw, CONTEXT)).toEqual(result.artifact);
    expect(parseReusableResearchGapSynthesisArtifact(raw, {
      ...CONTEXT,
      evidenceSha256: "c".repeat(64)
    })).toBeUndefined();

    const tampered = JSON.parse(raw) as Record<string, unknown>;
    tampered.accepted_clusters = [{ cluster_id: "broken", evidence_ids: "not-an-array" }];
    expect(
      parseReusableResearchGapSynthesisArtifact(rehashArtifact(tampered), CONTEXT)
    ).toBeUndefined();
  });

  it("rejects a rehashed accepted artifact when reviewer conditions are removed", async () => {
    const evidenceIds = ["ev_tamper_alpha", "ev_tamper_beta"];
    const llm = new SequenceLlm([
      JSON.stringify({
        clusters: [clusterProposal("explicit_limitation", evidenceIds, "cluster_tamper")]
      }),
      reviewResponse(
        "explicit_limitation",
        evidenceIds,
        REQUIRED_REVIEW_CONDITIONS.explicit_limitation,
        "cluster_tamper"
      )
    ]);
    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        explicitLimitationEvidence(
          evidenceIds[0],
          "paper_tamper_alpha",
          "The evaluation omits an independent transfer assessment."
        ),
        explicitLimitationEvidence(
          evidenceIds[1],
          "paper_tamper_beta",
          "An independent transfer assessment remains outside the evaluation."
        )
      ],
      context: CONTEXT
    });
    const tampered = JSON.parse(JSON.stringify(result.artifact)) as {
      reviews: Array<{ validated_conditions: string[] }>;
    } & Record<string, unknown>;
    tampered.reviews[0]!.validated_conditions = [];

    expect(
      parseReusableResearchGapSynthesisArtifact(rehashArtifact(tampered), CONTEXT)
    ).toBeUndefined();
  });

  it("uses a zero-call safe fallback while upstream analysis remains partial", async () => {
    const llm = new SequenceLlm([]);
    const result = await synthesizeResearchGapClusters({
      llm,
      evidence: [
        explicitLimitationEvidence(
          "ev_alpha",
          "paper_alpha",
          "The evaluation omits an independent transfer assessment."
        ),
        explicitLimitationEvidence(
          "ev_beta",
          "paper_beta",
          "An independent transfer assessment remains outside the evaluation."
        )
      ],
      context: CONTEXT,
      allowModelCalls: false
    });

    expect(result.toolCallsUsed).toBe(0);
    expect(result.artifact).toMatchObject({
      status: "safe_fallback",
      diagnostics: {
        failure_reason: "semantic_synthesis_deferred_due_analysis_failures"
      }
    });
  });
});

function acceptedResponses(
  opportunityType: ResearchOpportunityType,
  evidenceIds: string[],
  validatedConditions: readonly string[],
  clusterId: string
): string[] {
  return [
    proposalResponse(opportunityType, evidenceIds, clusterId),
    reviewResponse(opportunityType, evidenceIds, validatedConditions, clusterId)
  ];
}

function proposalResponse(
  opportunityType: ResearchOpportunityType,
  evidenceIds: string[],
  clusterId: string
): string {
  return JSON.stringify({
    clusters: [clusterProposal(opportunityType, evidenceIds, clusterId)]
  });
}

function clusterProposal(
  opportunityType: ResearchOpportunityType,
  evidenceIds: string[],
  clusterId: string
): Record<string, unknown> {
  return {
    cluster_id: clusterId,
    opportunity_type: opportunityType,
    statement: OPPORTUNITY_STATEMENTS[opportunityType],
    evidence_ids: evidenceIds,
    rationale: "The records satisfy the typed comparison contract."
  };
}

function reviewResponse(
  opportunityType: ResearchOpportunityType,
  evidenceIds: string[],
  validatedConditions: readonly string[],
  clusterId: string
): string {
  return JSON.stringify({
    reviews: [{
      cluster_id: clusterId,
      opportunity_type: opportunityType,
      decision: "accept",
      statement: OPPORTUNITY_STATEMENTS[opportunityType],
      accepted_evidence_ids: evidenceIds,
      validated_conditions: validatedConditions,
      reason: "The linked full-text records satisfy the typed review conditions."
    }]
  });
}

function explicitLimitationEvidence(
  evidenceId: string,
  paperId: string,
  limitation: string,
  overrides: Partial<HypothesisEvidenceSeed> = {}
): HypothesisEvidenceSeed {
  return genericEvidence(evidenceId, paperId, {
    limitation_slot: limitation,
    limitation_kind: "scientific",
    evidence_span: limitation,
    ...overrides
  });
}

function resultEvidence(
  evidenceId: string,
  paperId: string,
  result: string,
  dataset: string,
  metric: string,
  overrides: Partial<HypothesisEvidenceSeed> = {}
): HypothesisEvidenceSeed {
  return genericEvidence(evidenceId, paperId, {
    result_slot: result,
    dataset_slot: dataset,
    metric_slot: metric,
    evidence_span: result,
    ...overrides
  });
}

function reportingEvidence(
  evidenceId: string,
  paperId: string,
  evidenceSpan: string,
  overrides: Partial<HypothesisEvidenceSeed> = {}
): HypothesisEvidenceSeed {
  return genericEvidence(evidenceId, paperId, {
    limitation_kind: "reporting",
    evidence_span: evidenceSpan,
    ...overrides
  });
}

function boundaryEvidence(
  evidenceId: string,
  paperId: string,
  dataset: string,
  method: string,
  evidenceSpan: string,
  overrides: Partial<HypothesisEvidenceSeed> = {}
): HypothesisEvidenceSeed {
  return genericEvidence(evidenceId, paperId, {
    method_slot: method,
    result_slot: "The measured outcome remains stable within the reported evaluation frame.",
    dataset_slot: dataset,
    metric_slot: "Normalized evaluation outcome",
    evidence_span: evidenceSpan,
    ...overrides
  });
}

function genericEvidence(
  evidenceId: string,
  paperId: string,
  overrides: Partial<HypothesisEvidenceSeed> = {}
): HypothesisEvidenceSeed {
  const sourceType = overrides.source_type ?? "full_text";
  return {
    claim: "The study reports a measured comparison.",
    limitation_slot: "",
    limitation_kind: "unknown",
    method_slot: "",
    result_slot: "",
    dataset_slot: "",
    metric_slot: "",
    evidence_span: "The source provides a grounded neutral observation.",
    source_type: sourceType,
    source_scope:
      overrides.source_scope ??
      (sourceType === "full_text" ? "full_text_excerpt" : "abstract"),
    grounding_status: "grounded_span",
    confidence: 0.9,
    confidence_reason: "The evidence span is present in the supplied source.",
    ...overrides,
    evidence_id: evidenceId,
    paper_id: paperId,
    canonical_work_id: overrides.canonical_work_id ?? "work_" + paperId
  };
}

function rehashArtifact(artifact: Record<string, unknown>): string {
  delete artifact.content_sha256;
  artifact.content_sha256 = hashCanonical(artifact);
  return JSON.stringify(artifact);
}
