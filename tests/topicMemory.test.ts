import { describe, expect, it } from "vitest";

import {
  appendTopicKillRecord,
  buildTopicFormulationDescriptor,
  buildTopicReentryTicket,
  createTopicMemoryLedger,
  evaluateTopicMemory,
  TOPIC_MEMORY_NEAR_LINEAGE_THRESHOLD,
  topicLineageSimilarity,
  validateTopicMemoryLedger,
  validateTopicReentryTicket
} from "../src/core/topicMemory.js";
import { hashCanonical } from "../src/core/canonicalHash.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function formulation(overrides: Record<string, string | undefined> = {}) {
  return buildTopicFormulationDescriptor({
    statement:
      overrides.statement
      || "Generate anchored minimal patches for localized scientific source errors.",
    gap_statement:
      overrides.gap_statement
      || "Localized scientific-source repair lacks a preservation-aware interface comparison.",
    contribution_claim:
      overrides.contribution_claim
      || "A preservation-aware interface comparison for localized scientific-source repair.",
    dataset_task_bench:
      overrides.dataset_task_bench
      || "A licensed corpus of localized scientific source errors.",
    comparator:
      overrides.comparator || "Localized span regeneration.",
    primary_metric:
      overrides.primary_metric || "patch_f0_5",
    metric_unit: overrides.metric_unit || "proportion",
    meaningful_effect:
      overrides.meaningful_effect || "At least five percentage points.",
    minimum_publishable_evidence:
      overrides.minimum_publishable_evidence
      || "Repeated paper-cluster evidence against the strongest baseline."
  });
}

function killed(
  descriptor = formulation(),
  killScope: "exact_formulation" | "topic_lineage" = "exact_formulation"
) {
  return appendTopicKillRecord(createTopicMemoryLedger(), {
    descriptor,
    kill_scope: killScope,
    disposition_category: "prior_work_absorbed",
    public_reason_codes: ["closest_prior_absorbs_contribution"],
    source_run_id: "run-a",
    source_research_cycle: 2,
    source_full_text_evidence_ids: ["prior-a", "prior-b"],
    source_topic_content_sha256: HASH_A,
    source_decision_content_sha256: HASH_B
  });
}

describe("topic memory", () => {
  it("keeps a stable lineage while distinguishing revised formulations", () => {
    const first = formulation();
    const revised = formulation({
      statement:
        "Use a constrained search-and-replace interface for localized scientific source repair.",
      comparator: "Anchored unified diff.",
      primary_metric: "exact_restoration"
    });

    expect(revised.lineage_sha256).toBe(first.lineage_sha256);
    expect(revised.formulation_sha256).not.toBe(first.formulation_sha256);
  });

  it("blocks an exact killed formulation", () => {
    const descriptor = formulation();
    const decision = evaluateTopicMemory(killed(descriptor), descriptor);

    expect(decision).toMatchObject({
      disposition: "blocked",
      blocked: true,
      exact_formulation_match: true,
      exact_lineage_match: true
    });
  });

  it("requires explicit adjudication for a revised formulation in the same lineage", () => {
    const first = formulation();
    const revised = formulation({
      statement:
        "Use a constrained search-and-replace interface for localized scientific source repair.",
      comparator: "Anchored unified diff."
    });
    const decision = evaluateTopicMemory(killed(first), revised);

    expect(decision).toMatchObject({
      disposition: "requires_reentry_adjudication",
      blocked: true,
      exact_formulation_match: false,
      exact_lineage_match: true
    });
  });

  it("allows a materially changed formulation with an independently grounded reentry ticket", () => {
    const first = formulation();
    const revised = formulation({
      statement:
        "Use a constrained search-and-replace interface for localized scientific source repair.",
      comparator: "Anchored unified diff."
    });
    const ledger = killed(first);
    const ticket = buildTopicReentryTicket({
      priorRecordSha256: ledger.records[0].record_sha256,
      changedAxes: ["method_mechanism", "evaluation_protocol"],
      newFullTextEvidenceIds: ["new-full-text-a", "new-full-text-b"],
      proposedFormulationSha256: revised.formulation_sha256,
      ledgerHeadSha256: ledger.ledger_sha256,
      issuerId: "reviewer-a",
      decisionArtifactSha256: HASH_C,
      rationale:
        "The revised formulation changes both the repair mechanism and strongest comparison."
    });

    expect(evaluateTopicMemory(ledger, revised, ticket)).toMatchObject({
      disposition: "reentry_allowed",
      blocked: false,
      accepted_reentry_ticket_sha256: ticket.content_sha256
    });
  });

  it("rejects a reentry ticket that does not name every changed axis", () => {
    const first = formulation();
    const revised = formulation({
      statement:
        "Use a constrained search-and-replace interface for localized scientific source repair.",
      comparator: "Anchored unified diff."
    });
    const ledger = killed(first);
    const ticket = buildTopicReentryTicket({
      priorRecordSha256: ledger.records[0].record_sha256,
      changedAxes: ["method_mechanism"],
      newFullTextEvidenceIds: ["new-full-text-a", "new-full-text-b"],
      proposedFormulationSha256: revised.formulation_sha256,
      ledgerHeadSha256: ledger.ledger_sha256,
      issuerId: "reviewer-a",
      decisionArtifactSha256: HASH_C,
      rationale: "The method changed."
    });

    expect(evaluateTopicMemory(ledger, revised, ticket)).toMatchObject({
      disposition: "requires_reentry_adjudication",
      blocked: true
    });
  });

  it("flags a near-lineage paraphrase instead of silently treating it as new", () => {
    const first = formulation();
    const paraphrase = formulation({
      contribution_claim:
        "Compare preservation-aware interfaces for repairing localized source errors in scientific papers.",
      dataset_task_bench:
        "A licensed scientific-source corpus with localized error annotations.",
      statement:
        "Repair localized errors in scientific LaTeX with constrained minimal edits."
    });

    expect(topicLineageSimilarity(first, paraphrase)).toBeGreaterThanOrEqual(
      TOPIC_MEMORY_NEAR_LINEAGE_THRESHOLD
    );
    expect(evaluateTopicMemory(killed(first), paraphrase)).toMatchObject({
      disposition: "requires_reentry_adjudication",
      blocked: true,
      near_lineage_match: true
    });
  });

  it("leaves an unrelated research object clear", () => {
    const unrelated = formulation({
      contribution_claim:
        "Calibrate abstention under multimodal evidence conflicts.",
      dataset_task_bench:
        "A licensed multimodal contradiction benchmark.",
      statement:
        "Predict abstention from paired visual and textual evidence.",
      comparator: "A full-document multimodal model.",
      primary_metric: "selective_risk"
    });

    expect(evaluateTopicMemory(killed(), unrelated)).toMatchObject({
      disposition: "clear",
      blocked: false
    });
  });

  it("detects ledger tampering", () => {
    const ledger = killed();
    const tampered = structuredClone(ledger);
    tampered.records[0].descriptor.method_mechanism = "Changed after the decision.";

    expect(validateTopicMemoryLedger(tampered)).toMatchObject({
      valid: false
    });
  });

  it("rejects reuse of a reentry ticket for a different proposed formulation", () => {
    const first = formulation();
    const approvedRevision = formulation({
      statement:
        "Use constrained replacement for localized scientific source repair."
    });
    const replayedRevision = formulation({
      statement:
        "Use anchored replacement for localized scientific source repair."
    });
    const ledger = killed(first);
    const ticket = buildTopicReentryTicket({
      priorRecordSha256: ledger.records[0].record_sha256,
      changedAxes: ["method_mechanism"],
      newFullTextEvidenceIds: ["new-full-text-a", "new-full-text-b"],
      proposedFormulationSha256: approvedRevision.formulation_sha256,
      ledgerHeadSha256: ledger.ledger_sha256,
      issuerId: "reviewer-a",
      decisionArtifactSha256: HASH_C,
      rationale: "The revised mechanism has independent support."
    });

    expect(evaluateTopicMemory(ledger, replayedRevision, ticket)).toMatchObject({
      disposition: "requires_reentry_adjudication",
      blocked: true
    });
  });

  it("rejects duplicate evidence IDs even when a forged hash is self-consistent", () => {
    const first = formulation();
    const revised = formulation({
      statement:
        "Use constrained replacement for localized scientific source repair."
    });
    const ledger = killed(first);
    const ticket = buildTopicReentryTicket({
      priorRecordSha256: ledger.records[0].record_sha256,
      changedAxes: ["method_mechanism"],
      newFullTextEvidenceIds: ["new-full-text-a", "new-full-text-b"],
      proposedFormulationSha256: revised.formulation_sha256,
      ledgerHeadSha256: ledger.ledger_sha256,
      issuerId: "reviewer-a",
      decisionArtifactSha256: HASH_C,
      rationale: "The revised mechanism has independent support."
    });
    const forged = structuredClone(ticket);
    forged.new_full_text_evidence_ids = [
      "duplicated-full-text",
      "duplicated-full-text"
    ];
    const { content_sha256: _contentSha256, ...payload } = forged;
    forged.content_sha256 = hashCanonical(payload);

    expect(evaluateTopicMemory(ledger, revised, forged)).toMatchObject({
      disposition: "requires_reentry_adjudication",
      blocked: true
    });
  });

  it("rejects a reentry ticket after the ledger head advances", () => {
    const first = formulation();
    const revised = formulation({
      statement:
        "Use constrained replacement for localized scientific source repair."
    });
    const ledger = killed(first);
    const ticket = buildTopicReentryTicket({
      priorRecordSha256: ledger.records[0].record_sha256,
      changedAxes: ["method_mechanism"],
      newFullTextEvidenceIds: ["new-full-text-a", "new-full-text-b"],
      proposedFormulationSha256: revised.formulation_sha256,
      ledgerHeadSha256: ledger.ledger_sha256,
      issuerId: "reviewer-a",
      decisionArtifactSha256: HASH_C,
      rationale: "The revised mechanism has independent support."
    });
    const unrelated = formulation({
      contribution_claim: "Calibrate abstention under multimodal conflict.",
      dataset_task_bench: "A multimodal contradiction benchmark.",
      statement: "Predict abstention from visual and textual evidence.",
      comparator: "A multimodal full-document model."
    });
    const advancedLedger = appendTopicKillRecord(ledger, {
      descriptor: unrelated,
      kill_scope: "exact_formulation",
      disposition_category: "prior_work_absorbed",
      public_reason_codes: ["closest_prior_absorbs_contribution"],
      source_run_id: "run-b",
      source_research_cycle: 3,
      source_full_text_evidence_ids: ["prior-c", "prior-d"],
      source_topic_content_sha256: HASH_C,
      source_decision_content_sha256: HASH_D
    });

    expect(evaluateTopicMemory(advancedLedger, revised, ticket)).toMatchObject({
      disposition: "requires_reentry_adjudication",
      blocked: true
    });
  });

  it("validates issuer and decision artifact identity when supplied by the caller", () => {
    const first = formulation();
    const revised = formulation({
      statement:
        "Use constrained replacement for localized scientific source repair."
    });
    const ledger = killed(first);
    const ticket = buildTopicReentryTicket({
      priorRecordSha256: ledger.records[0].record_sha256,
      changedAxes: ["method_mechanism"],
      newFullTextEvidenceIds: ["new-full-text-a", "new-full-text-b"],
      proposedFormulationSha256: revised.formulation_sha256,
      ledgerHeadSha256: ledger.ledger_sha256,
      issuerId: "reviewer-a",
      decisionArtifactSha256: HASH_C,
      rationale: "The revised mechanism has independent support."
    });

    expect(validateTopicReentryTicket(
      ticket,
      ledger.records[0],
      revised,
      {
        expectedLedgerHeadSha256: ledger.ledger_sha256,
        expectedIssuerId: "reviewer-b",
        expectedDecisionArtifactSha256: HASH_D
      }
    )).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        "topic_reentry_ticket_issuer_mismatch",
        "topic_reentry_ticket_decision_artifact_mismatch"
      ])
    });
  });

  it("requires one ticket to adjudicate every matching blocking record", () => {
    const first = formulation({
      statement:
        "Use the first earlier mechanism for localized scientific source repair."
    });
    const second = formulation({
      statement:
        "Use the second earlier mechanism for localized scientific source repair."
    });
    const revised = formulation({
      statement:
        "Use a new constrained mechanism for localized scientific source repair."
    });
    let ledger = killed(first);
    ledger = appendTopicKillRecord(ledger, {
      descriptor: second,
      kill_scope: "exact_formulation",
      disposition_category: "prior_work_absorbed",
      public_reason_codes: ["closest_prior_absorbs_contribution"],
      source_run_id: "run-b",
      source_research_cycle: 3,
      source_full_text_evidence_ids: ["prior-c", "prior-d"],
      source_topic_content_sha256: HASH_C,
      source_decision_content_sha256: HASH_D
    });
    const partialTicket = buildTopicReentryTicket({
      priorRecordSha256: ledger.records[0].record_sha256,
      changedAxes: ["method_mechanism"],
      newFullTextEvidenceIds: ["new-full-text-a", "new-full-text-b"],
      proposedFormulationSha256: revised.formulation_sha256,
      ledgerHeadSha256: ledger.ledger_sha256,
      issuerId: "reviewer-a",
      decisionArtifactSha256: hashCanonical({ decision: "partial" }),
      rationale: "Only one prior record was adjudicated."
    });

    expect(evaluateTopicMemory(ledger, revised, partialTicket)).toMatchObject({
      disposition: "requires_reentry_adjudication",
      blocked: true
    });

    const completeTicket = buildTopicReentryTicket({
      priorRecordSha256: ledger.records[0].record_sha256,
      changedAxes: ["method_mechanism"],
      additionalRecordAdjudications: [
        {
          priorRecordSha256: ledger.records[1].record_sha256,
          changedAxes: ["method_mechanism"]
        }
      ],
      newFullTextEvidenceIds: ["new-full-text-a", "new-full-text-b"],
      proposedFormulationSha256: revised.formulation_sha256,
      ledgerHeadSha256: ledger.ledger_sha256,
      issuerId: "reviewer-a",
      decisionArtifactSha256: hashCanonical({ decision: "complete" }),
      rationale: "Every matching prior record was adjudicated."
    });

    expect(evaluateTopicMemory(ledger, revised, completeTicket)).toMatchObject({
      disposition: "reentry_allowed",
      blocked: false
    });
  });

  it("rejects self-consistent serialized ledgers with invalid kill semantics", () => {
    const wrongReason = structuredClone(killed());
    wrongReason.records[0].public_reason_codes = [
      "bounded_probe_hypothesis_not_supported"
    ];
    rehashSingleRecordLedger(wrongReason);

    expect(validateTopicMemoryLedger(wrongReason)).toMatchObject({
      valid: false
    });

    const insufficientEvidence = structuredClone(killed());
    insufficientEvidence.records[0].source_full_text_evidence_ids = [];
    rehashSingleRecordLedger(insufficientEvidence);

    expect(validateTopicMemoryLedger(insufficientEvidence)).toMatchObject({
      valid: false
    });
  });
});

function rehashSingleRecordLedger(
  ledger: ReturnType<typeof killed>
): void {
  const record = ledger.records[0];
  const { record_sha256: _recordSha256, ...recordPayload } = record;
  record.record_sha256 = hashCanonical(recordPayload);
  const { ledger_sha256: _ledgerSha256, ...ledgerPayload } = ledger;
  ledger.ledger_sha256 = hashCanonical(ledgerPayload);
}
