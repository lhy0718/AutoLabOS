import { describe, expect, it } from "vitest";

import { hashCanonical } from "../src/core/researchFunnel.js";
import type { TopicProbeFollowupHandoff } from "../src/core/topicProbeFollowup.js";
import type { TopicProbeOutcomeDecision } from "../src/core/topicProbeOutcome.js";
import {
  buildTopicProbeReviewGate,
  validateTopicProbeReviewGate
} from "../src/core/topicProbeReviewGate.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function makeOutcome(): TopicProbeOutcomeDecision {
  const payload: Omit<TopicProbeOutcomeDecision, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "topic_probe_outcome_decision",
    run_id: "run_fixture",
    research_cycle: 2,
    candidate_id: "candidate_active",
    topic_id: "topic_active",
    contract_content_sha256: HASH_A,
    primary_comparison_id: "comparison_primary",
    primary_metric: "quality_score",
    observed_delta: 0.04,
    directed_delta: 0.04,
    required_magnitude: 0.03,
    executed_trials: 3,
    cached_trials: 0,
    primary_metric_ci_present: true,
    primary_effect_ci_directed_bound: 0.035,
    primary_effect_ci_criterion_met: true,
    disposition: "promote_to_confirmatory",
    reason_codes: ["confirmatory_gate_satisfied"],
    evidence_refs: ["result_analysis.json"],
    next_action: "start_confirmatory_run"
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function makeHandoff(outcome: TopicProbeOutcomeDecision): TopicProbeFollowupHandoff {
  const payload: Omit<TopicProbeFollowupHandoff, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "topic_probe_followup_handoff",
    parent_run_id: outcome.run_id,
    parent_research_cycle: outcome.research_cycle,
    candidate_id: outcome.candidate_id,
    topic_id: outcome.topic_id,
    contract_content_sha256: outcome.contract_content_sha256,
    outcome_content_sha256: outcome.content_sha256,
    candidate_content_sha256: HASH_B,
    disposition: outcome.disposition,
    next_action: outcome.next_action,
    recommended_followup_mode: "hypothesis_test",
    evidence_stage: "confirmatory",
    research_brief_markdown: "# Research Brief\n"
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

describe("topicProbeReviewGate", () => {
  it("binds a validated outcome and handoff while always forbidding parent paper drafting", () => {
    const outcome = makeOutcome();
    const handoff = makeHandoff(outcome);
    const context = {
      runId: outcome.run_id,
      researchCycle: outcome.research_cycle,
      outcome,
      handoff
    };
    const gate = buildTopicProbeReviewGate(context);

    expect(gate).toMatchObject({
      status: "followup_required",
      paper_drafting_allowed: false,
      candidate_id: outcome.candidate_id,
      disposition: "promote_to_confirmatory",
      outcome_content_sha256: outcome.content_sha256,
      handoff_content_sha256: handoff.content_sha256,
      reason_codes: []
    });
    expect(validateTopicProbeReviewGate(JSON.stringify(gate), context)).toMatchObject({
      measured: true,
      valid: true,
      reasons: []
    });
  });

  it("fails closed when the follow-up handoff is absent", () => {
    const outcome = makeOutcome();
    const context = {
      runId: outcome.run_id,
      researchCycle: outcome.research_cycle,
      outcome
    };
    const gate = buildTopicProbeReviewGate(context);

    expect(gate.status).toBe("blocked_invalid_artifact_chain");
    expect(gate.paper_drafting_allowed).toBe(false);
    expect(gate.reason_codes).toContain("topic_probe_review_gate_handoff_missing");
    expect(validateTopicProbeReviewGate(JSON.stringify(gate), context).valid).toBe(true);
  });

  it("detects a rehashed attempt to promote a blocked gate", () => {
    const outcome = makeOutcome();
    const context = {
      runId: outcome.run_id,
      researchCycle: outcome.research_cycle,
      outcome,
      validationReasons: ["source_chain_invalid"]
    };
    const gate = buildTopicProbeReviewGate(context);
    const { content_sha256: _contentSha256, ...payload } = gate;
    const tamperedPayload = {
      ...payload,
      status: "followup_required" as const,
      reason_codes: []
    };
    const tampered = {
      ...tamperedPayload,
      content_sha256: hashCanonical(tamperedPayload)
    };

    const validation = validateTopicProbeReviewGate(
      JSON.stringify(tampered),
      context
    );
    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(
      "topic_probe_review_gate_recomputed_field_mismatch:status"
    );
    expect(validation.reasons).toContain(
      "topic_probe_review_gate_recomputed_field_mismatch:reason_codes"
    );
  });

  it("blocks a handoff bound to a different outcome", () => {
    const outcome = makeOutcome();
    const handoff = {
      ...makeHandoff(outcome),
      outcome_content_sha256: HASH_B
    };
    const gate = buildTopicProbeReviewGate({
      runId: outcome.run_id,
      researchCycle: outcome.research_cycle,
      outcome,
      handoff
    });

    expect(gate.status).toBe("blocked_invalid_artifact_chain");
    expect(gate.reason_codes).toContain(
      "topic_probe_review_gate_handoff_outcome_hash_mismatch"
    );
  });
});
