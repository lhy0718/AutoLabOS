import { describe, expect, it } from "vitest";

import {
  designExperimentsFromHypotheses,
  generateHypothesesFromEvidence
} from "../src/core/analysis/researchPlanning.js";
import { MockLLMClient } from "../src/core/llm/client.js";
import { makeTopicProbeComputeBudgetDeclaration } from "./support/topicProbeComputeBudget.js";

class QueueJsonLLMClient extends MockLLMClient {
  private index = 0;

  constructor(private readonly outputs: string[]) {
    super();
  }

  override async complete(_prompt: string): Promise<{ text: string }> {
    const output = this.outputs[Math.min(this.index, this.outputs.length - 1)] ?? "";
    this.index += 1;
    return { text: output };
  }
}

class CapturingQueueJsonLLMClient extends QueueJsonLLMClient {
  readonly prompts: string[] = [];

  override async complete(prompt: string): Promise<{ text: string }> {
    this.prompts.push(prompt);
    return await super.complete(prompt);
  }
}

class DelegatingLLMClient extends MockLLMClient {
  constructor(private readonly delegate: MockLLMClient) {
    super();
  }

  override async complete(
    prompt: string,
    opts?: Parameters<MockLLMClient["complete"]>[1]
  ): Promise<{ text: string }> {
    return await this.delegate.complete(prompt, opts);
  }
}

function independentReviewBoundary(llm: MockLLMClient) {
  return {
    proposerIdentity: { identity: "fixture_proposer" },
    reviewer: {
      llm: new DelegatingLLMClient(llm),
      identity: { identity: "fixture_reviewer" }
    }
  };
}

class HangingLLMClient extends MockLLMClient {
  override async complete(): Promise<{ text: string }> {
    return await new Promise<{ text: string }>(() => {});
  }
}

class QueueProgressThenHangLLMClient extends MockLLMClient {
  private index = 0;

  constructor(private readonly partialOutputs: string[]) {
    super();
  }

  override async complete(
    _prompt: string,
    opts?: { onProgress?: (event: { type: "status" | "delta"; text: string }) => void; abortSignal?: AbortSignal }
  ): Promise<{ text: string }> {
    const partial = this.partialOutputs[Math.min(this.index, this.partialOutputs.length - 1)] ?? "";
    this.index += 1;
    if (partial) {
      opts?.onProgress?.({ type: "delta", text: partial });
    }
    return await new Promise<{ text: string }>((_, reject) => {
      opts?.abortSignal?.addEventListener(
        "abort",
        () => reject(new Error("Operation aborted by user")),
        { once: true }
      );
    });
  }
}

class AbortAwareHangingLLMClient extends MockLLMClient {
  aborted = false;

  override async complete(
    _prompt: string,
    opts?: { abortSignal?: AbortSignal }
  ): Promise<{ text: string }> {
    return await new Promise<{ text: string }>((_, reject) => {
      opts?.abortSignal?.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          reject(new Error("Operation aborted by user"));
        },
        { once: true }
      );
    });
  }
}

function topicMeasurementContract() {
  return {
    primary_metric: "primary_score",
    metric_unit: "unitless",
    metric_scale: "raw" as const,
    metric_direction: "maximize" as const,
    effect_criterion: {
      basis: "delta_vs_reference" as const,
      magnitude: 0.05,
      scale: "raw" as const,
      inclusive: true
    },
    meaningful_effect: "At least 0.05 over the declared comparator.",
    measurement_signals: ["primary_score", "uncertainty_interval"],
    measurement_hint: "Compare the primary score with uncertainty across repeated matched runs.",
    gap_statement: "Prior evaluations omit an independently matched context.",
    closest_prior_non_overlap: "The candidate measures a boundary absent from the linked prior work.",
    reviewer_absorption_objection: "A reviewer may absorb the candidate into the strongest matched comparator.",
    comparator: "Matched-budget comparator",
    dataset_task_bench: "evaluation_fixture",
    falsifier: "The prespecified interval includes the null margin.",
    local_budget: makeTopicProbeComputeBudgetDeclaration(),
    kill_signal: "Stop if the comparator cannot execute or the effect misses the prespecified floor.",
    contribution_claim: "The comparison identifies a prespecified boundary absent from the closest priors.",
    minimum_publishable_evidence: "Repeated comparisons with uncertainty intervals and failure analysis."
  };
}

describe("researchPlanning helpers", () => {
  it("generates structured hypothesis candidates from LLM JSON", async () => {
    const llm = new QueueJsonLLMClient([
      JSON.stringify({
        summary: "Mapped evidence into reproducibility axes.",
        axes: [
          {
            id: "ax_1",
            label: "Structured communication",
            mechanism: "Structured interfaces reduce ambiguous handoffs.",
            intervention: "Replace free-form agent chat with schema-constrained messages.",
            boundary_condition: "Benefits may shrink on tasks that already use deterministic APIs.",
            evaluation_hint: "Measure run-to-run variance and message validity.",
            evidence_links: ["ev_1"]
          },
          {
            id: "ax_2",
            label: "Executable feedback",
            mechanism: "Execution-grounded correction prevents error cascades.",
            intervention: "Add bounded test-execute-repair loops.",
            boundary_condition: "May add cost on tasks without cheap validators.",
            evaluation_hint: "Measure pass-rate variance and failure mode stability.",
            evidence_links: ["ev_2"]
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated mechanism drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Schema-constrained inter-agent messages will reduce run-to-run variance relative to free-form chat on software-generation benchmarks.",
            novelty: 4,
            feasibility: 4,
            testability: 5,
            cost: 2,
            expected_gain: 5,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "This isolates communication structure as the intervention.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated contradiction drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Role-specialized multi-agent setups improve reproducibility only on tasks with stable decomposition; on tightly coupled reasoning tasks they will match or trail solo baselines.",
            novelty: 5,
            feasibility: 3,
            testability: 4,
            cost: 2,
            expected_gain: 4,
            evidence_links: ["ev_2"],
            axis_ids: ["ax_2"],
            rationale: "Task dependence should be exposed directly as a boundary condition.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated intervention drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Bounded execution-feedback loops will improve reproducibility more than extra peer discussion because validator-backed corrections reduce error amplification.",
            novelty: 4,
            feasibility: 5,
            testability: 5,
            cost: 2,
            expected_gain: 5,
            evidence_links: ["ev_1", "ev_2"],
            axis_ids: ["ax_2"],
            rationale: "The intervention is explicit and directly testable.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Selected the most falsifiable drafts.",
        reviews: [
          {
            candidate_id: "mechanism_1",
            keep: true,
            groundedness: 4,
            causal_clarity: 5,
            falsifiability: 5,
            experimentability: 5,
            measurement_specificity: 5,
            measurement_signals: ["run_to_run_variance"],
            measurement_hint: "Measure run-to-run variance across repeated seeded runs.",
            limitation_reflection: 4,
            measurement_readiness: 5,
            strengths: ["Clear intervention and baseline."],
            weaknesses: ["Mostly software-generation focused."],
            critique_summary: "Strong, targeted hypothesis."
          },
          {
            candidate_id: "contradiction_1",
            keep: false,
            groundedness: 3,
            causal_clarity: 3,
            falsifiability: 3,
            experimentability: 2,
            measurement_specificity: 2,
            measurement_signals: [],
            limitation_reflection: 2,
            measurement_readiness: 1,
            strengths: ["Interesting task boundary."],
            weaknesses: ["Needs a sharper operational definition."],
            critique_summary: "Promising but underspecified."
          },
          {
            candidate_id: "intervention_1",
            keep: true,
            groundedness: 5,
            causal_clarity: 5,
            falsifiability: 5,
            experimentability: 5,
            measurement_specificity: 5,
            measurement_signals: ["failure_mode_stability", "run_to_run_variance"],
            measurement_hint: "Measure failure-mode stability and repeated-run variance.",
            limitation_reflection: 4,
            measurement_readiness: 5,
            strengths: ["Directly implementable."],
            weaknesses: ["May increase runtime cost."],
            critique_summary: "Best overall balance."
          }
        ]
      })
    ]);

    const result = await generateHypothesesFromEvidence({
      llm,
      ...independentReviewBoundary(llm),
      runTitle: "Multi-Agent Collaboration",
      runTopic: "Multi-Agent Collaboration",
      objectiveMetric: "primary_score >= 0.9",
      evidenceSeeds: [
        { evidence_id: "ev_1", claim: "Planning matters." },
        { evidence_id: "ev_2", claim: "Memory matters." }
      ],
      branchCount: 6,
      topK: 2
    });

    expect(result.source).toBe("llm");
    expect(result.toolCallsUsed).toBe(5);
    expect(result.artifacts.pipeline).toBe("staged");
    expect(result.artifacts.evidence_axes).toHaveLength(2);
    expect(result.artifacts.llm_trace.axes?.prompt).toContain("Evidence panel:");
    expect(result.artifacts.llm_trace.drafts).toHaveLength(3);
    expect(result.artifacts.llm_trace.review?.completion).toContain("Selected the most falsifiable drafts.");
    expect(result.candidates).toHaveLength(2);
    expect(result.probe_candidates.map((item) => item.id)).toEqual(["intervention_1", "mechanism_1"]);
    expect(new Set(result.probe_candidates.map((item) => item.id)).size).toBe(result.probe_candidates.length);
  });

  it("does not rank candidates by self-reported expected gain", async () => {
    const candidate = (text: string, expectedGain: number) => ({
      id: "candidate_input",
      text,
      novelty: 4,
      feasibility: 4,
      testability: 5,
      cost: 2,
      expected_gain: expectedGain,
      evidence_links: ["ev_1", "ev_2"],
      axis_ids: ["ax_1"],
      rationale: "The declared intervention is bounded and directly testable.",
      ...topicMeasurementContract()
    });
    const review = (candidateId: string, keep: boolean) => ({
      candidate_id: candidateId,
      keep,
      groundedness: 5,
      causal_clarity: 5,
      falsifiability: 5,
      experimentability: 5,
      measurement_specificity: 5,
      measurement_signals: ["primary_score", "uncertainty_interval"],
      measurement_hint: "Compare matched conditions using the declared estimator.",
      limitation_reflection: 4,
      measurement_readiness: 5,
      strengths: ["Clear control and concrete intervention."],
      weaknesses: ["The claim remains bounded."],
      critique_summary: "The contract is complete."
    });
    const llm = new QueueJsonLLMClient([
      JSON.stringify({
        summary: "One bounded evidence axis.",
        axes: [{
          id: "ax_1",
          label: "Bounded intervention",
          mechanism: "A single controlled change may alter the primary outcome.",
          intervention: "Apply one declared change against a matched comparator.",
          boundary_condition: "The effect may disappear outside the declared scope.",
          evaluation_hint: "Use the prespecified estimator and falsifier.",
          evidence_links: ["ev_1", "ev_2"]
        }]
      }),
      JSON.stringify({
        summary: "Mechanism candidate.",
        candidates: [candidate(
          "A bounded adapter changes the declared primary outcome under a fixed comparator.",
          5
        )]
      }),
      JSON.stringify({
        summary: "Contradiction candidate.",
        candidates: [candidate(
          "A bounded alternative changes the declared primary outcome under a fixed comparator.",
          0
        )]
      }),
      JSON.stringify({
        summary: "Reserve candidate.",
        candidates: [candidate(
          "A bounded reserve changes the declared primary outcome under a fixed comparator.",
          3
        )]
      }),
      JSON.stringify({
        summary: "Two candidates pass independent review.",
        reviews: [
          review("mechanism_1", true),
          review("contradiction_1", true),
          review("intervention_1", false)
        ]
      })
    ]);

    const result = await generateHypothesesFromEvidence({
      llm,
      ...independentReviewBoundary(llm),
      runTitle: "Bounded candidate comparison",
      runTopic: "Evidence-grounded topic selection",
      objectiveMetric: "primary_score",
      evidenceSeeds: [
        {
          evidence_id: "ev_1",
          paper_id: "paper_1",
          claim: "The first source motivates a bounded comparison.",
          source_type: "full_text",
          confidence: 0.95
        },
        {
          evidence_id: "ev_2",
          paper_id: "paper_2",
          claim: "The second source motivates a matched estimator.",
          source_type: "full_text",
          confidence: 0.95
        }
      ],
      branchCount: 3,
      topK: 1
    });

    expect(result.probe_candidates.map((item) => item.id)).toEqual([
      "contradiction_1"
    ]);
    const scores = new Map(
      result.artifacts.probe_shortlist.scores.map((item) => [
        item.candidate_id,
        item.raw_base_score
      ])
    );
    expect(scores.get("mechanism_1")).toBe(scores.get("contradiction_1"));
  });

  it.each([
    "primary_metric",
    "metric_unit",
    "metric_scale",
    "metric_direction",
    "effect_criterion",
    "measurement_signals",
    "measurement_hint"
  ] as const)("fails closed when a generated probe candidate omits %s", async (missingField) => {
    const draft: Record<string, unknown> = {
      id: "candidate_input",
      text: "A bounded intervention changes the primary score relative to the declared comparator.",
      novelty: 4,
      feasibility: 4,
      testability: 5,
      cost: 2,
      expected_gain: 4,
      evidence_links: ["ev_1"],
      axis_ids: ["axis_measurement"],
      rationale: "The intervention and comparison are explicit.",
      ...topicMeasurementContract()
    };
    const singlePassDraft = { ...draft };
    const reviewRecord: Record<string, unknown> = {
      candidate_id: "mechanism_1",
      keep: true,
      groundedness: 5,
      causal_clarity: 5,
      falsifiability: 5,
      experimentability: 5,
      measurement_specificity: 5,
      measurement_signals: ["primary_score", "uncertainty_interval"],
      measurement_hint: "Compare the primary score with uncertainty across repeated matched runs.",
      limitation_reflection: 4,
      measurement_readiness: 5,
      strengths: ["The measurement contract is otherwise complete."],
      weaknesses: ["One required field is deliberately absent."]
    };
    delete draft[missingField];
    delete singlePassDraft[missingField];
    if (missingField === "measurement_signals" || missingField === "measurement_hint") {
      delete reviewRecord[missingField];
    }

    const llm = new QueueJsonLLMClient([
      JSON.stringify({
        summary: "Mapped one bounded measurement axis.",
        axes: [{
          id: "axis_measurement",
          label: "Bounded comparison",
          mechanism: "The intervention changes the declared outcome.",
          intervention: "Compare the intervention with the declared comparator.",
          evidence_links: ["ev_1"]
        }]
      }),
      JSON.stringify({ summary: "Generated one mechanism draft.", candidates: [draft] }),
      JSON.stringify({ summary: "No contradiction draft.", candidates: [] }),
      JSON.stringify({ summary: "No additional intervention draft.", candidates: [] }),
      JSON.stringify({ summary: "Reviewed the mechanism draft.", reviews: [reviewRecord] }),
      JSON.stringify({ summary: "Retried the incomplete draft.", candidates: [singlePassDraft] })
    ]);

    const result = await generateHypothesesFromEvidence({
      llm,
      ...independentReviewBoundary(llm),
      runTitle: "Bounded comparative study",
      runTopic: "Bounded comparative study",
      objectiveMetric: "primary_score >= 0.50",
      evidenceSeeds: [{ evidence_id: "ev_1", claim: "A bounded comparison was reported." }],
      branchCount: 2,
      topK: 1
    });

    expect(result.source).toBe("fallback");
    expect(result.artifacts.pipeline).toBe("fallback");
    expect(result.fallbackReason).toContain("no_probe_candidates");
    expect(result.fallbackReason).toContain("No valid hypothesis candidates were returned");
  });

  it.each([
    {
      label: "omits evidence links",
      draftEvidenceLinks: undefined,
      expectedReason: "too_few_evidence_links:0<1"
    },
    {
      label: "references an unknown evidence id",
      draftEvidenceLinks: ["ev_unknown"],
      expectedReason: "unresolved_evidence_links:ev_unknown"
    }
  ])("fails closed when a generated probe candidate $label", async ({ draftEvidenceLinks, expectedReason }) => {
    const draft: Record<string, unknown> = {
      id: "candidate_input",
      text: "A bounded intervention changes the primary score relative to the declared comparator.",
      novelty: 4,
      feasibility: 4,
      testability: 5,
      cost: 2,
      expected_gain: 4,
      axis_ids: ["axis_measurement"],
      rationale: "The intervention and comparison are explicit.",
      ...topicMeasurementContract()
    };
    if (draftEvidenceLinks) {
      draft.evidence_links = draftEvidenceLinks;
    }

    const llm = new QueueJsonLLMClient([
      JSON.stringify({
        summary: "Mapped one bounded measurement axis.",
        axes: [{
          id: "axis_measurement",
          label: "Bounded comparison",
          mechanism: "The intervention changes the declared outcome.",
          intervention: "Compare the intervention with the declared comparator.",
          evidence_links: ["ev_1"]
        }]
      }),
      JSON.stringify({ summary: "Generated one mechanism draft.", candidates: [draft] }),
      JSON.stringify({ summary: "No contradiction draft.", candidates: [] }),
      JSON.stringify({ summary: "No additional intervention draft.", candidates: [] }),
      JSON.stringify({
        summary: "Reviewed the mechanism draft.",
        reviews: [{
          candidate_id: "mechanism_1",
          keep: true,
          groundedness: 5,
          causal_clarity: 5,
          falsifiability: 5,
          experimentability: 5,
          measurement_specificity: 5,
          measurement_signals: ["primary_score", "uncertainty_interval"],
          measurement_hint: "Compare the primary score with uncertainty across repeated matched runs.",
          limitation_reflection: 4,
          measurement_readiness: 5,
          strengths: ["The measurement contract is otherwise complete."],
          weaknesses: ["The evidence provenance is deliberately invalid."]
        }]
      }),
      JSON.stringify({ summary: "Retried the invalid draft.", candidates: [draft] })
    ]);

    const result = await generateHypothesesFromEvidence({
      llm,
      ...independentReviewBoundary(llm),
      runTitle: "Bounded comparative study",
      runTopic: "Bounded comparative study",
      objectiveMetric: "primary_score >= 0.50",
      evidenceSeeds: [{ evidence_id: "ev_1", claim: "A bounded comparison was reported." }],
      branchCount: 2,
      topK: 1
    });

    expect(result.source).toBe("fallback");
    expect(result.artifacts.pipeline).toBe("fallback");
    expect(result.fallbackReason).toContain("no_probe_candidates");
    expect(result.fallbackReason).toContain("No valid hypothesis candidates were returned");
    const evidenceGateRejections = result.artifacts.hard_gate_rejections.filter(
      (item) => item.reasons.includes(expectedReason)
    );
    expect(evidenceGateRejections.map((item) => item.generation_path)).toEqual([
      "staged",
      "single_pass"
    ]);
  });

  it("fails closed when a topic-discovery candidate references an unknown evidence axis", async () => {
    const draft = {
      id: "candidate_input",
      text: "A bounded intervention changes the primary score relative to the declared comparator.",
      novelty: 4,
      feasibility: 4,
      testability: 5,
      cost: 2,
      expected_gain: 4,
      evidence_links: ["ev_1"],
      axis_ids: ["axis_unknown"],
      rationale: "The intervention and comparison are explicit.",
      ...topicMeasurementContract()
    };
    const llm = new QueueJsonLLMClient([
      JSON.stringify({
        summary: "Mapped one bounded measurement axis.",
        axes: [{
          id: "axis_measurement",
          label: "Bounded comparison",
          mechanism: "The intervention changes the declared outcome.",
          intervention: "Compare the intervention with the declared comparator.",
          evidence_links: ["ev_1"]
        }]
      }),
      JSON.stringify({ summary: "Generated one mechanism draft.", candidates: [draft] }),
      JSON.stringify({ summary: "No contradiction draft.", candidates: [] }),
      JSON.stringify({ summary: "No additional intervention draft.", candidates: [] }),
      JSON.stringify({
        summary: "Reviewed the mechanism draft.",
        reviews: [{
          candidate_id: "mechanism_1",
          keep: true,
          groundedness: 5,
          causal_clarity: 5,
          falsifiability: 5,
          experimentability: 5,
          measurement_specificity: 5,
          measurement_signals: ["primary_score", "uncertainty_interval"],
          measurement_hint: "Compare the primary score with uncertainty across repeated matched runs.",
          limitation_reflection: 4,
          measurement_readiness: 5,
          strengths: ["The measurement contract is otherwise complete."],
          weaknesses: ["The evidence-axis provenance is deliberately invalid."]
        }]
      }),
      JSON.stringify({ summary: "Retried the invalid draft.", candidates: [draft] })
    ]);

    const result = await generateHypothesesFromEvidence({
      llm,
      proposerIdentity: { identity: "fixture_proposer" },
      reviewer: {
        llm: new DelegatingLLMClient(llm),
        identity: { identity: "fixture_reviewer" }
      },
      runTitle: "Bounded comparative study",
      runTopic: "Bounded comparative study",
      objectiveMetric: "primary_score >= 0.50",
      evidenceSeeds: [{ evidence_id: "ev_1", claim: "A bounded comparison was reported." }],
      branchCount: 2,
      topK: 1,
      governance: {
        researchMode: "topic_discovery",
        constraints: []
      }
    });

    expect(result.source).toBe("fallback");
    expect(result.artifacts.pipeline).toBe("fallback");
    expect(result.artifacts.hard_gate_rejections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        generation_path: "staged",
        candidate_id: "mechanism_1",
        reasons: expect.arrayContaining(["unresolved_axis_ids:axis_unknown"])
      })
    ]));
  });

  it("falls back deterministically when hypothesis JSON is invalid", async () => {
    const llm = new QueueJsonLLMClient(["not json"]);

    const result = await generateHypothesesFromEvidence({
      llm,
      ...independentReviewBoundary(llm),
      runTitle: "Multi-Agent Collaboration",
      runTopic: "Multi-Agent Collaboration",
      objectiveMetric: "primary_score >= 0.9",
      evidenceSeeds: [{ evidence_id: "ev_1", claim: "Planning matters." }],
      branchCount: 4,
      topK: 2
    });

    expect(result.source).toBe("fallback");
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    expect(result.probe_candidates).toEqual([]);
    expect(result.artifacts.pipeline).toBe("fallback");
    expect(result.artifacts.provenance.review_authorization.authorized_for_probe).toBe(false);
    expect(result.artifacts.provenance.review_authorization.reason_codes).toContain(
      "independent_review_not_completed"
    );
  });

  it("captures partial staged and single-pass hypothesis output before timeout fallback", async () => {
    const llm = new QueueProgressThenHangLLMClient([
      '{"summary":"partial axes"',
      '{"summary":"partial single-pass"'
    ]);

    const result = await generateHypothesesFromEvidence({
      llm,
      ...independentReviewBoundary(llm),
      runTitle: "Multi-Agent Collaboration",
      runTopic: "Multi-Agent Collaboration",
      objectiveMetric: "primary_score >= 0.9",
      evidenceSeeds: [{ evidence_id: "ev_1", claim: "Planning matters." }],
      branchCount: 4,
      topK: 2,
      timeoutMs: 10
    });

    expect(result.source).toBe("fallback");
    expect(result.fallbackReason).toContain("hypothesis_axes_timeout:10ms");
    expect(result.fallbackReason).toContain("hypothesis_single_pass_timeout:10ms");
    expect(result.artifacts.llm_trace.axes_partial?.completion).toContain("partial axes");
    expect(result.artifacts.llm_trace.single_pass_partial?.completion).toContain("partial single-pass");
  });

  it("keeps hypothesis progress coarse instead of logging streamed token deltas", async () => {
    const llm = new QueueProgressThenHangLLMClient(["token fragment"]);
    const progress: string[] = [];

    await generateHypothesesFromEvidence({
      llm,
      ...independentReviewBoundary(llm),
      runTitle: "Multi-Agent Collaboration",
      runTopic: "Multi-Agent Collaboration",
      objectiveMetric: "primary_score >= 0.9",
      evidenceSeeds: [{ evidence_id: "ev_1", claim: "Planning matters." }],
      branchCount: 4,
      topK: 2,
      timeoutMs: 10,
      onProgress: (message) => progress.push(message)
    });

    expect(progress).toContain("Captured partial evidence-axis output before the staged hypothesis timeout.");
    expect(progress.some((message) => message.includes("token fragment"))).toBe(false);
  });

  it("repairs truncated hypothesis-planning JSON and continues the staged pipeline", async () => {
    const llm = new QueueJsonLLMClient([
      '{"summary":"Mapped evidence into one axis.","axes":[{"id":"ax_1","label":"Structured communication","mechanism":"Structured interfaces reduce ambiguity.","intervention":"Compare typed messages against free-form chat.","evaluation_hint":"Measure run-to-run variance.","evidence_links":["ev_1"]}]',
      JSON.stringify({
        summary: "Generated mechanism drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Typed message schemas will reduce run-to-run variance relative to free-form chat.",
            novelty: 4,
            feasibility: 4,
            testability: 5,
            cost: 2,
            expected_gain: 5,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "This isolates communication structure as the intervention.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated contradiction drafts.",
        candidates: []
      }),
      JSON.stringify({
        summary: "Generated intervention drafts.",
        candidates: []
      }),
      JSON.stringify({
        summary: "Selected the most falsifiable drafts.",
        reviews: [
          {
            candidate_id: "mechanism_1",
            keep: true,
            groundedness: 4,
            causal_clarity: 5,
            falsifiability: 5,
            experimentability: 5,
            measurement_specificity: 5,
            measurement_signals: ["run_to_run_variance"],
            measurement_hint: "Measure run-to-run variance across repeated seeded runs.",
            limitation_reflection: 4,
            measurement_readiness: 5,
            strengths: ["Clear intervention and baseline."],
            weaknesses: ["Mostly software-generation focused."],
            critique_summary: "Strong, targeted hypothesis."
          }
        ]
      })
    ]);

    const result = await generateHypothesesFromEvidence({
      llm,
      ...independentReviewBoundary(llm),
      runTitle: "Multi-Agent Collaboration",
      runTopic: "Multi-Agent Collaboration",
      objectiveMetric: "primary_score >= 0.9",
      evidenceSeeds: [{ evidence_id: "ev_1", claim: "Planning matters." }],
      branchCount: 4,
      topK: 1
    });

    expect(result.source).toBe("llm");
    expect(result.artifacts.pipeline).toBe("staged");
    expect(result.artifacts.evidence_axes).toHaveLength(1);
    expect(result.probe_candidates).toHaveLength(1);
    expect(result.probe_candidates[0]?.id).toBe("mechanism_1");
  });

  it("does not reselect review-rejected hypotheses when fewer than top-k survive review", async () => {
    const llm = new QueueJsonLLMClient([
      JSON.stringify({
        summary: "Mapped evidence into one axis.",
        axes: [
          {
            id: "ax_1",
            label: "Structured communication",
            mechanism: "Structured interfaces reduce ambiguity.",
            intervention: "Compare typed messages against free-form chat.",
            evidence_links: ["ev_1"]
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated mechanism drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Typed message schemas will reduce run-to-run variance relative to free-form chat.",
            novelty: 4,
            feasibility: 4,
            testability: 5,
            cost: 2,
            expected_gain: 5,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "Directly tests structured handoff.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated contradiction drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "A broader coordination package will outperform the schema-only intervention.",
            novelty: 5,
            feasibility: 4,
            testability: 4,
            cost: 3,
            expected_gain: 5,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "Combines several changes.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated intervention drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Adding discussion plus repair plus routing changes will improve reproducibility.",
            novelty: 5,
            feasibility: 4,
            testability: 4,
            cost: 3,
            expected_gain: 5,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "Covers multiple interventions at once.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Rejected the bundled variants.",
        reviews: [
          {
            candidate_id: "mechanism_1",
            keep: true,
            groundedness: 5,
            causal_clarity: 5,
            falsifiability: 5,
            experimentability: 5,
            measurement_specificity: 5,
            measurement_signals: ["run_to_run_variance"],
            measurement_hint: "Measure variance over repeated seeded runs.",
            limitation_reflection: 4,
            measurement_readiness: 5,
            strengths: ["Clear intervention and baseline."],
            weaknesses: ["Narrow benchmark coverage."],
            critique_summary: "Keep."
          },
          {
            candidate_id: "contradiction_1",
            keep: false,
            groundedness: 4,
            causal_clarity: 3,
            falsifiability: 3,
            experimentability: 2,
            measurement_specificity: 2,
            measurement_signals: [],
            limitation_reflection: 2,
            measurement_readiness: 1,
            strengths: ["Ambitious."],
            weaknesses: ["Bundled and hard to isolate."],
            critique_summary: "Reject."
          },
          {
            candidate_id: "intervention_1",
            keep: false,
            groundedness: 4,
            causal_clarity: 3,
            falsifiability: 3,
            experimentability: 2,
            measurement_specificity: 2,
            measurement_signals: [],
            limitation_reflection: 2,
            measurement_readiness: 1,
            strengths: ["Potentially strong effect."],
            weaknesses: ["Conflates several interventions."],
            critique_summary: "Reject."
          }
        ]
      })
    ]);

    const result = await generateHypothesesFromEvidence({
      llm,
      ...independentReviewBoundary(llm),
      runTitle: "Multi-Agent Collaboration",
      runTopic: "Multi-Agent Collaboration",
      objectiveMetric: "primary_score",
      evidenceSeeds: [{ evidence_id: "ev_1", claim: "Structured handoff reduces ambiguity." }],
      branchCount: 6,
      topK: 2
    });

    expect(result.artifacts.pipeline).toBe("staged");
    expect(result.probe_candidates.map((item) => item.id)).toEqual(["mechanism_1"]);
    expect(result.artifacts.probe_shortlist.ranked_candidate_ids).toEqual(["mechanism_1"]);
  });

  it("falls back to single-pass generation when staged review coverage is incomplete", async () => {
    const llm = new CapturingQueueJsonLLMClient([
      JSON.stringify({
        summary: "Mapped evidence into one axis.",
        axes: [
          {
            id: "ax_1",
            label: "Execution feedback",
            mechanism: "Validator-backed correction reduces drift.",
            intervention: "Add bounded execute-test-repair loops.",
            evidence_links: ["ev_1"]
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated mechanism drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Bounded repair loops will reduce run-to-run variance.",
            novelty: 4,
            feasibility: 4,
            testability: 5,
            cost: 2,
            expected_gain: 5,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "Directly testable.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated contradiction drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Repair loops help only when validators are cheap.",
            novelty: 4,
            feasibility: 4,
            testability: 4,
            cost: 2,
            expected_gain: 4,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "A boundary-condition hypothesis.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated intervention drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Repair loops beat extra peer discussion for reproducibility.",
            novelty: 4,
            feasibility: 5,
            testability: 5,
            cost: 2,
            expected_gain: 5,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "Intervention-first hypothesis.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Only partially reviewed the drafts.",
        reviews: [
          {
            candidate_id: "mechanism_1",
            keep: true,
            groundedness: 5,
            causal_clarity: 5,
            falsifiability: 5,
            experimentability: 5,
            measurement_specificity: 5,
            measurement_signals: ["run_to_run_variance"],
            measurement_hint: "Compare repeated seeded runs.",
            limitation_reflection: 4,
            measurement_readiness: 5,
            strengths: ["Clear intervention."],
            weaknesses: ["Needs more task diversity."],
            critique_summary: "Keep."
          },
          {
            candidate_id: "contradiction_1",
            keep: false,
            groundedness: 4,
            causal_clarity: 4,
            falsifiability: 4,
            experimentability: 4,
            measurement_specificity: 4,
            measurement_signals: ["run_to_run_variance"],
            measurement_hint: "Compare repeated seeded runs.",
            limitation_reflection: 4,
            measurement_readiness: 4,
            strengths: ["The boundary condition is explicit."],
            weaknesses: ["The contribution is absorbed by the comparator."],
            critique_summary: "Reject."
          },
          {
            candidate_id: "intervention_1",
            groundedness: 5,
            causal_clarity: 5,
            falsifiability: 5,
            experimentability: 5,
            measurement_specificity: 5,
            measurement_signals: ["run_to_run_variance"],
            measurement_hint: "Compare repeated seeded runs.",
            limitation_reflection: 5,
            measurement_readiness: 5,
            strengths: ["The intervention is executable."],
            weaknesses: ["The required keep disposition is missing."],
            critique_summary: "Malformed review."
          }
        ]
      }),
      JSON.stringify({
        summary: "Recovered via single-pass generation.",
        candidates: [
          {
            id: "cand_1",
            text: "Schema-constrained execution feedback will reduce failure-mode variance.",
            novelty: 4,
            feasibility: 5,
            testability: 5,
            cost: 2,
            expected_gain: 5,
            evidence_links: ["ev_1"],
            rationale: "Recovered after incomplete staged review.",
            ...topicMeasurementContract(),
            measurement_signals: ["failure_mode_stability", "run_to_run_variance"],
            measurement_hint: "Measure failure-mode variance across repeated seeded runs.",
            boundary_condition: "Benefits may shrink when validators are unreliable."
          }
        ],
        selected_ids: ["cand_1"]
      })
    ]);

    const result = await generateHypothesesFromEvidence({
      llm,
      runTitle: "Multi-Agent Collaboration",
      runTopic: "Multi-Agent Collaboration",
      objectiveMetric: "primary_score",
      evidenceSeeds: [{ evidence_id: "ev_1", claim: "Execution feedback improves correction." }],
      branchCount: 6,
      topK: 2,
      governance: {
        researchMode: "topic_discovery",
        constraints: [
          "Bound the probe and confirmatory stages with explicit aggregate compute ceilings."
        ]
      }
    });

    expect(result.source).toBe("llm");
    expect(result.artifacts.pipeline).toBe("single_pass");
    expect(result.fallbackReason).toContain("incomplete_hypothesis_reviews:1");
    expect(result.probe_candidates).toEqual([]);
    expect(
      result.artifacts.provenance.review_authorization.authorized_for_probe
    ).toBe(false);
    expect(
      result.artifacts.provenance.review_authorization.reason_codes
    ).toContain("independent_review_not_completed");
    const reviewPrompt = llm.prompts.find((prompt) =>
      prompt.includes("Review the hypothesis drafts skeptically")
    ) ?? "";
    for (const field of [
      "gap_statement=",
      "closest_prior_non_overlap=",
      "reviewer_absorption_objection=",
      "comparator=",
      "dataset_task_bench=",
      "primary_metric=",
      "metric_unit=",
      "metric_scale=",
      "metric_direction=",
      "effect_criterion=",
      "falsifier=",
      "local_budget=",
      "kill_signal=",
      "contribution_claim=",
      "minimum_publishable_evidence="
    ]) {
      expect(reviewPrompt).toContain(field);
    }
    const singlePassPrompt = llm.prompts.at(-1) ?? "";
    expect(singlePassPrompt).toContain(
      "local_budget must be a JSON-encoded object with bounded_probe and confirmatory objects"
    );
    expect(singlePassPrompt).toContain(
      "values must not exceed the research brief"
    );
    expect((singlePassPrompt.match(/evidence_id=/g) ?? []).length).toBeLessThanOrEqual(6);
    expect(singlePassPrompt).not.toContain("paper_id=");
    expect(singlePassPrompt).not.toContain("confidence_reason=");
  });

  it("compresses staged hypothesis evidence prompts to a smaller compact panel", async () => {
    const llm = new CapturingQueueJsonLLMClient([
      JSON.stringify({
        summary: "Mapped evidence into one axis.",
        axes: [
          {
            id: "ax_1",
            label: "Structured communication",
            mechanism: "Typed handoffs reduce ambiguity.",
            intervention: "Use schema-constrained messages.",
            evidence_links: ["ev_1", "ev_2"]
          }
        ]
      }),
      JSON.stringify({ summary: "Generated mechanism drafts.", candidates: [] }),
      JSON.stringify({ summary: "Generated contradiction drafts.", candidates: [] }),
      JSON.stringify({ summary: "Generated intervention drafts.", candidates: [] }),
      JSON.stringify({
        summary: "No drafts survived review.",
        reviews: []
      })
    ]);

    await generateHypothesesFromEvidence({
      llm,
      ...independentReviewBoundary(llm),
      runTitle: "Multi-Agent Collaboration",
      runTopic: "Multi-Agent Collaboration",
      objectiveMetric: "primary_score",
      evidenceSeeds: Array.from({ length: 20 }, (_, index) => ({
        evidence_id: `ev_${index + 1}`,
        paper_id: `paper_${index + 1}`,
        claim: `This is a deliberately verbose evidence claim number ${index + 1} that should be truncated before hypothesis planning prompts are built because long claims increase latency and token pressure.`,
        limitation_slot: `limitation_${index + 1}`,
        dataset_slot: `dataset_${index + 1}`,
        metric_slot: `metric_${index + 1}`,
        confidence: 0.4,
        source_type: index % 2 === 0 ? "full_text" : "abstract",
        confidence_reason:
          "This long confidence rationale should never be forwarded into the compact hypothesis planning prompts."
      })),
      branchCount: 6,
      topK: 2
    });

    const axesPrompt = llm.prompts[0] ?? "";
    const draftPrompt = llm.prompts.find((prompt) => prompt.includes('"candidates"')) ?? "";
    expect((axesPrompt.match(/evidence_id=/g) ?? []).length).toBeLessThanOrEqual(8);
    expect(axesPrompt).not.toContain("paper_id=");
    expect(axesPrompt).not.toContain("confidence_reason=");
    expect(draftPrompt).toContain('"metric_unit"');
    expect(draftPrompt).toContain('"metric_scale"');
    expect(draftPrompt).toContain('"effect_criterion"');
    expect(draftPrompt).toContain("meaningful_effect prose");
  });

  it("hard-gates weakly grounded hypotheses on evidence count, limitation handling, and measurement readiness", async () => {
    const llm = new QueueJsonLLMClient([
      JSON.stringify({
        summary: "Mapped evidence into two axes.",
        axes: [
          {
            id: "ax_1",
            label: "Structured communication",
            mechanism: "Typed handoffs reduce ambiguity.",
            intervention: "Use schema-constrained messages.",
            boundary_condition: "Benefits may shrink on already deterministic tasks.",
            evidence_links: ["ev_1", "ev_2"]
          },
          {
            id: "ax_2",
            label: "Execution feedback",
            mechanism: "Validator-backed repair reduces error cascades.",
            intervention: "Add bounded execute-test-repair loops.",
            boundary_condition: "Less useful when validators are unreliable.",
            evidence_links: ["ev_2", "ev_3"]
          }
        ]
      }),
      JSON.stringify({
        summary: "Refined axes with the remaining evidence.",
        axes: []
      }),
      JSON.stringify({
        summary: "Generated mechanism drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Typed message schemas will reduce run-to-run variance.",
            novelty: 4,
            feasibility: 4,
            testability: 5,
            cost: 2,
            expected_gain: 5,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "Grounded in a single schema paper.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated contradiction drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Repair loops help less when validators are unreliable.",
            novelty: 4,
            feasibility: 4,
            testability: 4,
            cost: 2,
            expected_gain: 4,
            evidence_links: ["ev_2", "ev_3"],
            axis_ids: ["ax_2"],
            rationale: "Boundary condition implied by the evidence.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated intervention drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Combining schema-constrained messages with bounded repair loops will reduce failure variance.",
            novelty: 4,
            feasibility: 5,
            testability: 5,
            cost: 2,
            expected_gain: 5,
            evidence_links: ["ev_1", "ev_2"],
            axis_ids: ["ax_1", "ax_2"],
            rationale: "Both intervention and measurement are explicit.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Applied hard-gate aware review.",
        reviews: [
          {
            candidate_id: "mechanism_1",
            keep: true,
            groundedness: 5,
            causal_clarity: 5,
            falsifiability: 5,
            experimentability: 5,
            measurement_specificity: 5,
            measurement_signals: ["run_to_run_variance"],
            measurement_hint: "Measure repeated-run variance across seeded runs.",
            limitation_reflection: 4,
            measurement_readiness: 5,
            strengths: ["Clear intervention."],
            weaknesses: ["Only one evidence item is linked."],
            critique_summary: "Fails evidence-count gate."
          },
          {
            candidate_id: "contradiction_1",
            keep: true,
            groundedness: 4,
            causal_clarity: 4,
            falsifiability: 4,
            experimentability: 4,
            measurement_specificity: 4,
            measurement_signals: ["failure_mode_stability"],
            limitation_reflection: 1,
            measurement_readiness: 1,
            strengths: ["Interesting boundary condition."],
            weaknesses: ["Does not explain how to measure the predicted failure mode."],
            critique_summary: "Fails limitation and measurement gates."
          },
          {
            candidate_id: "intervention_1",
            keep: true,
            groundedness: 5,
            causal_clarity: 5,
            falsifiability: 5,
            experimentability: 5,
            measurement_specificity: 5,
            measurement_signals: ["run_to_run_variance", "failure_mode_stability"],
            measurement_hint: "Track run-to-run variance and failure-mode stability across repeated seeded runs.",
            limitation_reflection: 4,
            measurement_readiness: 5,
            strengths: ["Operationalized and evidence-backed."],
            weaknesses: ["Adds execution cost."],
            critique_summary: "Passes the hard gates."
          }
        ]
      })
    ]);

    const result = await generateHypothesesFromEvidence({
      llm,
      ...independentReviewBoundary(llm),
      runTitle: "Multi-Agent Collaboration",
      runTopic: "Multi-Agent Collaboration",
      objectiveMetric: "primary_score",
      evidenceSeeds: [
        { evidence_id: "ev_1", claim: "Structured handoff reduces ambiguity.", limitation_slot: "Effects shrink on deterministic APIs." },
        { evidence_id: "ev_2", claim: "Execution feedback improves correction.", limitation_slot: "Validator quality matters." },
        { evidence_id: "ev_3", claim: "Repair loops depend on validator reliability.", limitation_slot: "Noisy validators can reverse gains." }
      ],
      branchCount: 6,
      topK: 2
    });

    expect(result.artifacts.pipeline).toBe("staged");
    expect(result.candidates.map((item) => item.id)).toEqual(["intervention_1"]);
    expect(result.probe_candidates.map((item) => item.id)).toEqual(["intervention_1"]);
    expect(result.artifacts.probe_shortlist.ranked_candidate_ids).toEqual(["intervention_1"]);
  });

  it("prefers cleaner, more implementable hypotheses over broader bundled ones", async () => {
    const llm = new QueueJsonLLMClient([
      JSON.stringify({
        summary: "Mapped evidence into one axis.",
        axes: [
          {
            id: "ax_1",
            label: "Shared state",
            mechanism: "Explicit state handoff reduces hidden coordination drift.",
            intervention: "Compare structured state handoff against free-form dialogue.",
            boundary_condition: "Benefits may reverse when summaries are stale or lossy.",
            evaluation_hint: "Measure run-to-run variance and state agreement.",
            evidence_links: ["ev_1"]
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated mechanism drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "An explicit state-handoff package will reduce run-to-run variance relative to free-form dialogue on long-horizon tasks.",
            novelty: 4,
            feasibility: 5,
            testability: 5,
            cost: 3,
            expected_gain: 5,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "This is an inference-time intervention with a direct control.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated contradiction drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Compared with naive SFT, multi-agent trace distillation plus feedback-driven policy optimization will reduce across-seed and across-checkpoint variance across downstream tasks.",
            novelty: 5,
            feasibility: 5,
            testability: 5,
            cost: 2,
            expected_gain: 5,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "This is a broader but more ambitious training hypothesis.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated intervention drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Validator-backed repair loops will reduce failure-mode variance relative to discussion-only baselines.",
            novelty: 4,
            feasibility: 4,
            testability: 4,
            cost: 3,
            expected_gain: 4,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "Concrete but less central than the state-handoff hypothesis.",
            ...topicMeasurementContract()
          }
        ]
      }),
      JSON.stringify({
        summary: "Selected the cleanest reproducibility hypotheses.",
        reviews: [
          {
            candidate_id: "mechanism_1",
            keep: true,
            groundedness: 5,
            causal_clarity: 5,
            falsifiability: 5,
            experimentability: 4,
            measurement_specificity: 5,
            measurement_signals: ["run_to_run_variance", "state_agreement"],
            measurement_hint: "Run 20 seeds and compare trajectory variance and state disagreement.",
            limitation_reflection: 4,
            measurement_readiness: 5,
            strengths: ["Clear control and concrete intervention."],
            weaknesses: ["Still treated as one package rather than isolated subcomponents."],
            critique_summary: "Clean and implementable."
          },
          {
            candidate_id: "contradiction_1",
            keep: true,
            groundedness: 4,
            causal_clarity: 4,
            falsifiability: 5,
            experimentability: 3,
            measurement_specificity: 5,
            measurement_signals: ["run_to_run_variance", "checkpoint_stability"],
            measurement_hint:
              "Train each regime with multiple seeds, evaluate several checkpoints, and sweep interaction-data size across downstream tasks.",
            limitation_reflection: 4,
            measurement_readiness: 5,
            strengths: ["Interesting training direction."],
            weaknesses: [
              "Merges two distinct interaction-aware methods into one combined treatment.",
              "The experimental scope is too broad and expensive.",
              "Separate arms are needed to keep the causal claim clean."
            ],
            critique_summary: "Interesting but over-bundled."
          },
          {
            candidate_id: "intervention_1",
            keep: true,
            groundedness: 4,
            causal_clarity: 4,
            falsifiability: 4,
            experimentability: 4,
            measurement_specificity: 4,
            measurement_signals: ["failure_mode_stability"],
            measurement_hint: "Repeat identical tasks across seeds and compare failure-mode frequencies.",
            limitation_reflection: 4,
            measurement_readiness: 5,
            strengths: ["Directly implementable."],
            weaknesses: ["Less grounded than the state-handoff hypothesis."],
            critique_summary: "Solid but secondary."
          }
        ]
      })
    ]);

    const result = await generateHypothesesFromEvidence({
      llm,
      ...independentReviewBoundary(llm),
      runTitle: "Multi-Agent Collaboration",
      runTopic: "Multi-Agent Collaboration",
      objectiveMetric: "primary_score",
      evidenceSeeds: [{ evidence_id: "ev_1", claim: "Structured handoff reduces ambiguity." }],
      branchCount: 6,
      topK: 1
    });

    expect(result.probe_candidates.map((item) => item.id)).toEqual(["mechanism_1"]);
    const broadCandidateScore = result.artifacts.probe_shortlist.scores.find((item) => item.candidate_id === "contradiction_1");
    expect(broadCandidateScore?.implementation_bonus).toBeGreaterThan(0);
    expect(broadCandidateScore?.bundling_penalty).toBeGreaterThan(0);
    expect(broadCandidateScore?.scope_penalty).toBeGreaterThan(0);
  });

  it("builds structured experiment designs from LLM JSON and augments reproducibility guidance", async () => {
    const llm = new QueueJsonLLMClient([
      JSON.stringify({
        summary: "Generated three experiment plans.",
        candidates: [
          {
            id: "plan_1",
            title: "Recovery benchmark",
            hypothesis_ids: ["h_1"],
            plan_summary: "Evaluate recovery behavior against a baseline.",
            datasets: ["Benchmark-A"],
            metrics: [
              "Primary metric: task success. Secondary metrics: runtime and memory.",
              "latency"
            ],
            baselines: [],
            implementation_notes: [],
            evaluation_steps: [],
            risks: ["Benchmark may be too narrow."],
            resource_notes: ["Keep runs within local execution limits."]
          }
        ],
        selected_id: "plan_1"
      })
    ]);

    const result = await designExperimentsFromHypotheses({
      llm,
      runTitle: "Multi-Agent Collaboration",
      runTopic: "Multi-Agent Collaboration",
      objectiveMetric: "primary_score",
      hypotheses: [
        {
          hypothesis_id: "h_1",
          text: "Typed message schemas will reduce run-to-run variance relative to free-form chat.",
          measurement_specificity: 5,
          measurement_signals: ["run_to_run_variance", "artifact_consistency"],
          measurement_hint: "Measure primary-score uncertainty and artifact consistency across repeated runs."
        }
      ],
      constraintProfile: {
        source: "heuristic_fallback",
        collect: {},
        writing: {},
        experiment: {
          designNotes: [],
          implementationNotes: [],
          evaluationNotes: []
        },
        assumptions: []
      },
      objectiveProfile: {
        source: "heuristic_fallback",
        raw: "primary_score",
        primaryMetric: "primary_score",
        preferredMetricKeys: ["primary_score"],
        analysisFocus: [],
        paperEmphasis: [],
        assumptions: []
      },
      candidateCount: 3
    });

    expect(result.source).toBe("llm");
    expect(result.selected.id).toBe("plan_1");
    expect(result.selected.metrics).toContain("primary_score");
    expect(result.selected.metrics).toContain("latency");
    expect(result.selected.metrics).not.toContain("Primary metric: task success. Secondary metrics: runtime and memory.");
    expect(result.selected.metrics).toContain("run_to_run_variance");
    expect(result.selected.metrics).toContain("artifact_consistency");
    expect(result.selected.baselines).toEqual(["current_best_baseline"]);
    expect(result.selected.evaluation_steps.some((step) => step.includes("repeated runs"))).toBe(true);
    expect(result.selected.implementation_notes.some((step) => step.includes("Measurement"))).toBe(false);
    expect(result.selected.implementation_notes.some((step) => step.includes("Instrumentation should support"))).toBe(true);
  });

  it("falls back to known hypotheses when llm returns dangling hypothesis ids", async () => {
    const llm = new QueueJsonLLMClient([
      JSON.stringify({
        summary: "Generated one experiment plan with a mismatched id.",
        candidates: [
          {
            id: "plan_1",
            title: "Recovery benchmark",
            hypothesis_ids: ["missing_id"],
            plan_summary: "Evaluate recovery behavior against a baseline.",
            datasets: ["Benchmark-A"],
            metrics: [],
            baselines: [],
            implementation_notes: [],
            evaluation_steps: [],
            risks: [],
            resource_notes: []
          }
        ],
        selected_id: "plan_1"
      })
    ]);

    const result = await designExperimentsFromHypotheses({
      llm,
      runTitle: "Multi-Agent Collaboration",
      runTopic: "Multi-Agent Collaboration",
      objectiveMetric: "primary_score",
      hypotheses: [
        {
          hypothesis_id: "h_1",
          text: "Typed message schemas will reduce run-to-run variance relative to free-form chat.",
          measurement_specificity: 5,
          measurement_signals: ["run_to_run_variance"],
          measurement_hint: "Measure run-to-run variance across repeated runs."
        }
      ],
      constraintProfile: {
        source: "heuristic_fallback",
        collect: {},
        writing: {},
        experiment: {
          designNotes: [],
          implementationNotes: [],
          evaluationNotes: []
        },
        assumptions: []
      },
      objectiveProfile: {
        source: "heuristic_fallback",
        raw: "primary_score",
        primaryMetric: "primary_score",
        preferredMetricKeys: ["primary_score"],
        analysisFocus: [],
        paperEmphasis: [],
        assumptions: []
      },
      candidateCount: 3
    });

    expect(result.selected.hypothesis_ids).toEqual(["h_1"]);
    expect(result.selected.metrics).toContain("run_to_run_variance");
    expect(result.selected.baselines).toEqual(["current_best_baseline"]);
    expect(result.selected.evaluation_steps.some((step) => step.includes("repeated runs"))).toBe(true);
  });

  it("falls back deterministically when experiment design llm exceeds the timeout", async () => {
    const result = await designExperimentsFromHypotheses({
      llm: new HangingLLMClient(),
      runTitle: "Bounded comparative study",
      runTopic: "Bounded comparative study",
      objectiveMetric: "primary_outcome_delta",
      hypotheses: [
        {
          hypothesis_id: "h_1",
          text: "A bounded intervention improves the primary outcome.",
          measurement_signals: ["run_to_run_variance"],
          measurement_hint: "Compare primary_outcome_delta across repeated bounded runs."
        }
      ],
      constraintProfile: {
        source: "heuristic_fallback",
        collect: {},
        writing: {},
        experiment: {
          designNotes: [],
          implementationNotes: [],
          evaluationNotes: []
        },
        assumptions: []
      },
      objectiveProfile: {
        source: "heuristic_fallback",
        raw: "primary_outcome_delta",
        primaryMetric: "primary_outcome_delta",
        preferredMetricKeys: ["primary_outcome_delta"],
        analysisFocus: [],
        paperEmphasis: [],
        assumptions: []
      },
      retryContext: {
        previous_pilot_size: 8,
        previous_repeats: 1,
        registered_pilot_size: 200,
        registered_repeats: 5,
        previous_primary_metric_name: "primary_outcome_delta",
        previous_primary_metric_value: -0.125,
        previous_baseline_name: "reference_system",
        previous_objective_status: "not_met",
        transition_action: "backtrack_to_design",
        retry_directives: [
          "Move the next bounded local branch materially closer to the registered pilot scope while keeping the run locally executable.",
          "Revise the intervention or stopping policy because the previous primary_outcome_delta did not improve over reference_system."
        ]
      },
      timeoutMs: 5
    });

    expect(result.source).toBe("fallback");
    expect(result.fallbackReason).toContain("experiment_design_timeout:5ms");
    expect(result.selected.title).toContain("Compare primary_outcome_delta across repeated bounded runs.");
    expect(result.selected.single_change).toBe("Compare primary_outcome_delta across repeated bounded runs.");
    expect(result.selected.title).not.toContain("A bounded intervention improves the primary outcome");
    expect(result.selected.plan_summary).toContain("did not improve primary_outcome_delta");
    expect(result.selected.evaluation_steps).toContain(
      "Move the next bounded local branch materially closer to the registered pilot scope while keeping the run locally executable."
    );
  });

  it("keeps fallback experiment designs executable after implementation handoff failures", async () => {
    const result = await designExperimentsFromHypotheses({
      llm: new HangingLLMClient(),
      runTitle: "Bounded comparative study",
      runTopic: "Bounded comparative study",
      objectiveMetric: "primary_outcome_delta",
      hypotheses: [
        {
          hypothesis_id: "h_1",
          text: "A compact condition sweep improves the primary outcome.",
          measurement_hint: "Compare treatment and baseline across repeated bounded runs."
        }
      ],
      constraintProfile: {
        source: "heuristic_fallback",
        raw: [],
        collect: {},
        writing: {},
        experiment: {
          designNotes: [],
          implementationNotes: [],
          evaluationNotes: []
        },
        assumptions: []
      },
      objectiveProfile: {
        source: "heuristic_fallback",
        raw: "primary_outcome_delta",
        primaryMetric: "primary_outcome_delta",
        preferredMetricKeys: ["primary_outcome_delta"],
        analysisFocus: [],
        paperEmphasis: [],
        assumptions: []
      },
      retryContext: {
        previous_primary_metric_name: "primary_outcome_delta",
        previous_baseline_name: "locked_control",
        previous_objective_status: "not_met",
        implementation_failure: "Implementation execution failed before any runnable implementation was produced: terminated",
        transition_action: "backtrack_to_design",
        retry_directives: [
          "Keep the explicit comparator discipline and preserve the locked baselines unless there is direct evidence to replace them."
        ]
      },
      timeoutMs: 5
    });

    expect(result.source).toBe("fallback");
    expect(result.selected.datasets).toEqual(["configured_task_or_dataset"]);
    expect(result.selected.baselines).toEqual(["locked_control"]);
    expect(result.selected.implementation_notes).toContain(
      "Repair the implementation contract before expanding scope: produce one runnable minimal branch, verify artifacts, then add repeated conditions."
    );
    expect(result.selected.implementation_notes.some((note) => note.includes("metrics payload"))).toBe(true);
    expect(result.selected.evaluation_steps).toContain(
      "Validate the metrics payload contract before handing off to the execution node."
    );
  });

  it("aborts the in-flight experiment design completion when the timeout fires", async () => {
    const llm = new AbortAwareHangingLLMClient();

    const result = await designExperimentsFromHypotheses({
      llm,
      runTitle: "Bounded comparative study",
      runTopic: "Bounded comparative study",
      objectiveMetric: "primary_outcome_delta",
      hypotheses: [
        {
          hypothesis_id: "h_1",
          text: "A bounded intervention improves the primary outcome."
        }
      ],
      constraintProfile: {
        source: "heuristic_fallback",
        collect: {},
        writing: {},
        experiment: {
          designNotes: [],
          implementationNotes: [],
          evaluationNotes: []
        },
        assumptions: []
      },
      objectiveProfile: {
        source: "heuristic_fallback",
        raw: "primary_outcome_delta",
        primaryMetric: "primary_outcome_delta",
        preferredMetricKeys: ["primary_outcome_delta"],
        analysisFocus: [],
        paperEmphasis: [],
        assumptions: []
      },
      timeoutMs: 5
    });

    expect(result.source).toBe("fallback");
    expect(result.fallbackReason).toContain("experiment_design_timeout:5ms");
    expect(llm.aborted).toBe(true);
  });
});
