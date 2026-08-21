import { describe, expect, it } from "vitest";

import type {
  LLMClient,
  LLMCompletion
} from "../src/core/llm/client.js";
import {
  appendTopicKillRecord,
  buildTopicFormulationDescriptor,
  createTopicMemoryLedger,
  evaluateTopicMemory
} from "../src/core/topicMemory.js";
import {
  runTopicMemorySemanticAudit,
  validateTopicMemorySemanticAudit
} from "../src/core/topicMemorySemanticAudit.js";
import {
  resolveHypothesisReviewBoundary,
  type TopicMemoryTransmissionPolicy
} from "../src/core/analysis/hypothesisReviewProvenance.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const LOCAL_RAW_TOPIC_MEMORY_POLICY = {
  reviewer_trust_class: "local",
  payload_mode: "raw_descriptors",
  raw_descriptor_consent: true
} satisfies TopicMemoryTransmissionPolicy;

class StaticLlm implements LLMClient {
  calls = 0;

  constructor(private readonly buildText: (prompt: string) => string) {}

  async complete(prompt: string): Promise<LLMCompletion> {
    this.calls += 1;
    return { text: this.buildText(prompt) };
  }
}

function descriptor(input: {
  statement: string;
  contribution: string;
  scope: string;
}) {
  return buildTopicFormulationDescriptor({
    statement: input.statement,
    contribution_claim: input.contribution,
    dataset_task_bench: input.scope,
    comparator: "A declared reference condition.",
    primary_metric: "primary_score",
    metric_unit: "proportion",
    meaningful_effect: "At least five percentage points.",
    minimum_publishable_evidence:
      "Repeated independent units with paired uncertainty."
  });
}

function killedLedger(
  killScope: "exact_formulation" | "topic_lineage" = "topic_lineage"
) {
  const killed = descriptor({
    statement:
      "Constrain generated patches to declared editable regions and preserve all other bytes.",
    contribution:
      "A constrained patch protocol for preservation-sensitive document revision.",
    scope: "A licensed collection of document revision pairs."
  });
  return appendTopicKillRecord(createTopicMemoryLedger(), {
    descriptor: killed,
    kill_scope: killScope,
    disposition_category: "prior_work_absorbed",
    public_reason_codes: ["closest_prior_absorbs_contribution"],
    source_run_id: "run-one",
    source_research_cycle: 1,
    source_full_text_evidence_ids: ["source-one", "source-two"],
    source_topic_content_sha256: HASH_A,
    source_decision_content_sha256: HASH_B
  });
}

function independentBoundary(response: (prompt: string) => string) {
  return resolveHypothesisReviewBoundary({
    proposerLlm: new StaticLlm(() => "{}"),
    proposerIdentity: { identity: "candidate_proposer" },
    reviewer: {
      llm: new StaticLlm(response),
      identity: { identity: "semantic_identity_reviewer" },
      topicMemoryTransmissionPolicy: LOCAL_RAW_TOPIC_MEMORY_POLICY
    }
  });
}

function responseFor(
  prompt: string,
  contribution: "equivalent" | "distinct" | "uncertain",
  method: "equivalent" | "distinct" | "uncertain"
): string {
  const recordHashes = [...prompt.matchAll(/[a-f0-9]{64}/gu)]
    .map((match) => match[0])
    .filter((value, index, values) => values.indexOf(value) === index);
  const priorRecordSha256 = recordHashes.find((value) =>
    prompt.includes(`\"record_sha256\":\"${value}\"`)
  );
  if (!priorRecordSha256) {
    throw new Error("test_record_hash_missing");
  }
  return JSON.stringify({
    comparisons: [{
      prior_record_sha256: priorRecordSha256,
      contribution_object_relation: contribution,
      method_mechanism_relation: method,
      rationale: "The two core research axes were compared directly."
    }]
  });
}

describe("topic memory semantic audit", () => {
  it("fails closed when a lexically dissimilar candidate has no semantic audit", () => {
    const proposed = descriptor({
      statement:
        "Emit bounded edits only inside authorized spans while retaining untouched content exactly.",
      contribution:
        "Region-authorized editing with exact preservation outside the region.",
      scope: "A permission-cleared corpus of paired revisions."
    });

    expect(evaluateTopicMemory(killedLedger(), proposed)).toMatchObject({
      disposition: "blocked",
      blocked: true,
      semantic_audit_required: true,
      semantic_audit_valid: false,
      reason_codes: expect.arrayContaining([
        "topic_memory_semantic_audit_required"
      ])
    });
  });

  it("blocks an unknown reviewer before raw topic memory reaches complete", async () => {
    const ledger = killedLedger();
    const proposed = descriptor({
      statement: "Compare a bounded intervention under a declared scope.",
      contribution: "A neutral comparison protocol.",
      scope: "A permission-cleared evaluation collection."
    });
    const reviewer = new StaticLlm(() => {
      throw new Error("reviewer_must_not_be_called");
    });
    const boundary = resolveHypothesisReviewBoundary({
      proposerLlm: new StaticLlm(() => "{}"),
      proposerIdentity: { identity: "local_test_proposer" },
      reviewer: {
        llm: reviewer,
        identity: { identity: "unclassified_test_reviewer" }
      }
    });

    const audit = await runTopicMemorySemanticAudit({
      boundary,
      ledger,
      descriptor: proposed
    });

    expect(reviewer.calls).toBe(0);
    expect(audit.transmission).toMatchObject({
      reviewer_trust_class: "unknown",
      requested_payload_mode: "deny",
      raw_descriptor_consent: false,
      policy_source: "default_deny",
      transmission_mode: "blocked",
      bound_audit_input_sha256: audit.audit_input_sha256
    });
    expect(audit.reviewer_invocations).toEqual([]);
    expect(audit.reason_codes).toContain(
      "topic_memory_semantic_audit_transmission_policy_missing"
    );
    expect(validateTopicMemorySemanticAudit(audit, ledger, proposed)).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "topic_memory_semantic_audit_transmission_not_authorized"
      ])
    });
  });

  it("blocks explicit external raw dispatch before complete", async () => {
    const ledger = killedLedger();
    const proposed = descriptor({
      statement: "Compare another bounded intervention.",
      contribution: "A second neutral comparison protocol.",
      scope: "A permission-cleared evaluation collection."
    });
    const reviewer = new StaticLlm(() => {
      throw new Error("external_reviewer_must_not_be_called");
    });
    const boundary = resolveHypothesisReviewBoundary({
      proposerLlm: new StaticLlm(() => "{}"),
      proposerIdentity: { identity: "local_test_proposer" },
      reviewer: {
        llm: reviewer,
        identity: { identity: "external_test_reviewer" },
        topicMemoryTransmissionPolicy: {
          reviewer_trust_class: "external",
          payload_mode: "raw_descriptors",
          raw_descriptor_consent: true
        }
      }
    });

    const audit = await runTopicMemorySemanticAudit({
      boundary,
      ledger,
      descriptor: proposed
    });

    expect(reviewer.calls).toBe(0);
    expect(audit.transmission.transmission_mode).toBe("blocked");
    expect(audit.reason_codes).toContain(
      "topic_memory_semantic_audit_external_raw_dispatch_forbidden"
    );
    expect(audit.reviewer_invocations).toEqual([]);
  });

  it("blocks a synonym reformulation after independent semantic comparison", async () => {
    const ledger = killedLedger();
    const proposed = descriptor({
      statement:
        "Emit bounded edits only inside authorized spans while retaining untouched content exactly.",
      contribution:
        "Region-authorized editing with exact preservation outside the region.",
      scope: "A permission-cleared corpus of paired revisions."
    });
    const audit = await runTopicMemorySemanticAudit({
      boundary: independentBoundary((prompt) =>
        responseFor(prompt, "equivalent", "equivalent")
      ),
      ledger,
      descriptor: proposed
    });

    expect(validateTopicMemorySemanticAudit(audit, ledger, proposed)).toMatchObject({
      valid: true
    });
    expect(evaluateTopicMemory(ledger, proposed, undefined, audit)).toMatchObject({
      disposition: "requires_reentry_adjudication",
      blocked: true,
      semantic_audit_valid: true,
      semantic_lineage_match: true,
      accepted_semantic_audit_sha256: audit.content_sha256
    });
  });

  it("clears only a core-axis distinction reviewed against every record", async () => {
    const ledger = killedLedger();
    const proposed = descriptor({
      statement:
        "Estimate selective abstention from conflicting audio and text evidence.",
      contribution:
        "Calibrated abstention under cross-modal evidence conflict.",
      scope: "A licensed multimodal contradiction benchmark."
    });
    const audit = await runTopicMemorySemanticAudit({
      boundary: independentBoundary((prompt) =>
        responseFor(prompt, "distinct", "distinct")
      ),
      ledger,
      descriptor: proposed
    });

    expect(evaluateTopicMemory(ledger, proposed, undefined, audit)).toMatchObject({
      disposition: "clear",
      blocked: false,
      semantic_audit_valid: true,
      accepted_semantic_audit_sha256: audit.content_sha256
    });
  });

  it("clears a lexically matching sibling only after a distinct core mechanism review", async () => {
    const ledger = killedLedger("exact_formulation");
    const proposed = descriptor({
      statement:
        "Require executable counterexamples before accepting a proposed source patch.",
      contribution:
        "A constrained patch protocol for preservation-sensitive document revision.",
      scope: "A licensed collection of document revision pairs."
    });
    const audit = await runTopicMemorySemanticAudit({
      boundary: independentBoundary((prompt) =>
        responseFor(prompt, "equivalent", "distinct")
      ),
      ledger,
      descriptor: proposed
    });

    expect(evaluateTopicMemory(ledger, proposed, undefined, audit)).toMatchObject({
      disposition: "clear",
      blocked: false,
      exact_lineage_match: true,
      semantic_audit_valid: true,
      accepted_semantic_audit_sha256: audit.content_sha256
    });
  });

  it("invalidates tampered transmission policy and payload binding", async () => {
    const ledger = killedLedger();
    const proposed = descriptor({
      statement: "Estimate a bounded outcome from conflicting inputs.",
      contribution: "A neutral estimator for conflicting evidence.",
      scope: "A licensed contradiction benchmark."
    });
    const audit = await runTopicMemorySemanticAudit({
      boundary: independentBoundary((prompt) =>
        responseFor(prompt, "distinct", "distinct")
      ),
      ledger,
      descriptor: proposed
    });

    expect(audit.transmission.transmission_mode).toBe("local_raw");
    expect(audit.transmission.bound_audit_input_sha256).toBe(
      audit.audit_input_sha256
    );
    expect(typeof audit.reviewer_invocations[0]?.payload_sha256).toBe(
      "string"
    );
    expect(audit.reviewer_invocations[0]?.payload_sha256.length).toBe(64);

    const policyTampered = structuredClone(audit);
    policyTampered.transmission.reviewer_trust_class = "external";
    expect(validateTopicMemorySemanticAudit(
      policyTampered,
      ledger,
      proposed
    )).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "topic_memory_semantic_audit_transmission_mode_mismatch",
        "topic_memory_semantic_audit_policy_binding_mismatch"
      ])
    });

    const bindingTampered = structuredClone(audit);
    bindingTampered.reviewer_invocations[0]!.payload_sha256 = "0".repeat(64);
    expect(validateTopicMemorySemanticAudit(
      bindingTampered,
      ledger,
      proposed
    )).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "topic_memory_semantic_audit_invocation_hash_invalid"
      ])
    });
  });

  it("rejects self-review and tampered coverage", async () => {
    const ledger = killedLedger();
    const proposed = descriptor({
      statement: "Estimate a calibrated response from conflicting inputs.",
      contribution: "A calibration method for conflicting evidence.",
      scope: "A licensed contradiction benchmark."
    });
    const shared = new StaticLlm((prompt) =>
      responseFor(prompt, "distinct", "distinct")
    );
    const selfBoundary = resolveHypothesisReviewBoundary({
      proposerLlm: shared,
      proposerIdentity: { identity: "proposer" },
      reviewer: {
        llm: shared,
        identity: { identity: "reviewer" },
        topicMemoryTransmissionPolicy: LOCAL_RAW_TOPIC_MEMORY_POLICY
      }
    });
    const audit = await runTopicMemorySemanticAudit({
      boundary: selfBoundary,
      ledger,
      descriptor: proposed
    });

    expect(validateTopicMemorySemanticAudit(audit, ledger, proposed)).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "topic_memory_semantic_audit_not_independent"
      ])
    });

    const independent = await runTopicMemorySemanticAudit({
      boundary: independentBoundary((prompt) =>
        responseFor(prompt, "distinct", "distinct")
      ),
      ledger,
      descriptor: proposed
    });
    const tampered = structuredClone(independent);
    tampered.comparisons = [];
    expect(validateTopicMemorySemanticAudit(tampered, ledger, proposed)).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "topic_memory_semantic_audit_coverage_incomplete"
      ])
    });
  });
});
