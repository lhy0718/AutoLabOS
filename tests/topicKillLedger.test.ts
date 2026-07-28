import { describe, expect, it } from "vitest";

import { hashCanonical } from "../src/core/canonicalHash.js";
import {
  appendTopicKillLedger,
  createTopicKillLedger,
  evaluateTopicKillLedgerBlock,
  fingerprintTopicCandidateStatement,
  normalizeTopicCandidateStatement,
  requireValidTopicKillLedger,
  topicKillLedgerBlocksSourceIdentity,
  topicKillLedgerBlocksStatement,
  validateTopicKillLedger,
  type TopicKillRecord,
  type TopicKillRecordInput
} from "../src/core/topicKillLedger.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

function recordInput(
  overrides: Partial<TopicKillRecordInput> = {}
): TopicKillRecordInput {
  return {
    statement: "Does the proposed intervention satisfy the declared criterion?",
    source_topic_content_sha256: HASH_A,
    disposition_category: "bounded_probe_rejected",
    public_reason_codes: ["bounded_probe_effect_floor_not_met"],
    source_run_id: "topic-refresh-01",
    source_research_cycle: 2,
    source_bounded_outcome_content_sha256: HASH_B,
    ...overrides
  };
}

function rehashRecord(record: Record<string, unknown>): Record<string, unknown> {
  const { record_sha256: _recordSha256, ...payload } = record;
  return { ...payload, record_sha256: hashCanonical(payload) };
}

function rehashLedger(value: Record<string, unknown>): Record<string, unknown> {
  const { ledger_sha256: _ledgerSha256, ...payload } = value;
  return { ...payload, ledger_sha256: hashCanonical(payload) };
}

describe("topicKillLedger", () => {
  it("creates a deterministic empty genesis ledger", () => {
    const first = createTopicKillLedger();
    const second = createTopicKillLedger();

    expect(first).toEqual(second);
    expect(first.records).toEqual([]);
    expect(validateTopicKillLedger(first)).toEqual({
      valid: true,
      reasons: [],
      ledger: first
    });
  });

  it("stores only an exact normalized statement fingerprint and bounded public metadata", () => {
    const statement = "  ＤＯＥＳ the proposed\n intervention satisfy the declared criterion?  ";
    const ledger = appendTopicKillLedger(
      createTopicKillLedger(),
      recordInput({ statement })
    );
    const record = ledger.records[0];

    expect(normalizeTopicCandidateStatement(statement)).toBe(
      "does the proposed intervention satisfy the declared criterion?"
    );
    expect(record.candidate_statement_sha256).toBe(
      fingerprintTopicCandidateStatement(statement)
    );
    expect(record).not.toHaveProperty("statement");
    expect(record).not.toHaveProperty("metric");
    expect(record).not.toHaveProperty("result");
    expect(record).not.toHaveProperty("outcome");
    expect(Object.keys(record).sort()).toEqual([
      "candidate_statement_sha256",
      "disposition_category",
      "previous_ledger_sha256",
      "public_reason_codes",
      "record_sha256",
      "source_bounded_outcome_content_sha256",
      "source_research_cycle",
      "source_run_id",
      "source_topic_content_sha256"
    ]);
  });

  it("appends through the prior ledger hash and blocks both exact identities", () => {
    const genesis = createTopicKillLedger();
    const parent = appendTopicKillLedger(genesis, recordInput());
    const child = appendTopicKillLedger(parent, recordInput({
      statement: "Can a second candidate survive independent novelty review?",
      source_topic_content_sha256: HASH_C,
      disposition_category: "prior_work_absorbed",
      public_reason_codes: [
        "novelty_not_defensible",
        "closest_prior_absorbs_contribution"
      ],
      source_bounded_outcome_content_sha256: HASH_D
    }));

    expect(child.records[1].previous_ledger_sha256).toBe(parent.ledger_sha256);
    expect(child.records[1].public_reason_codes).toEqual([
      "closest_prior_absorbs_contribution",
      "novelty_not_defensible"
    ]);
    expect(validateTopicKillLedger(child, { expectedParentLedger: parent }).valid).toBe(true);
    expect(topicKillLedgerBlocksStatement(
      child,
      "CAN A SECOND CANDIDATE survive independent novelty review?"
    )).toBe(true);
    expect(topicKillLedgerBlocksSourceIdentity(child, HASH_A)).toBe(true);
    expect(topicKillLedgerBlocksSourceIdentity(child, HASH_E)).toBe(false);
    expect(evaluateTopicKillLedgerBlock(child, {
      statement: "An unseen candidate",
      source_topic_content_sha256: HASH_C
    })).toMatchObject({
      blocked: true,
      matched_by_statement: false,
      matched_by_source_topic_content: true
    });
  });

  it("accepts reordered object keys because hashes are canonical", () => {
    const ledger = appendTopicKillLedger(createTopicKillLedger(), recordInput());
    const record = ledger.records[0];
    const reorderedRecord = {
      record_sha256: record.record_sha256,
      source_run_id: record.source_run_id,
      previous_ledger_sha256: record.previous_ledger_sha256,
      source_research_cycle: record.source_research_cycle,
      public_reason_codes: record.public_reason_codes,
      disposition_category: record.disposition_category,
      source_topic_content_sha256: record.source_topic_content_sha256,
      candidate_statement_sha256: record.candidate_statement_sha256,
      source_bounded_outcome_content_sha256:
        record.source_bounded_outcome_content_sha256
    };
    const reordered = {
      ledger_sha256: ledger.ledger_sha256,
      records: [reorderedRecord],
      artifact_kind: ledger.artifact_kind,
      schema_version: ledger.schema_version
    };

    expect(validateTopicKillLedger(JSON.stringify(reordered)).valid).toBe(true);
  });

  it("rejects rehashed unknown top-level and record payload fields", () => {
    const ledger = appendTopicKillLedger(createTopicKillLedger(), recordInput());
    const topLevelAttack = rehashLedger({
      ...ledger,
      result_payload: { score: 1 }
    });

    const recordAttack = rehashRecord({
      ...ledger.records[0],
      metric: "private_metric",
      outcome: "private_outcome"
    });
    const recordPayloadAttack = rehashLedger({
      schema_version: ledger.schema_version,
      artifact_kind: ledger.artifact_kind,
      records: [recordAttack],
      ledger_sha256: ledger.ledger_sha256
    });

    expect(validateTopicKillLedger(topLevelAttack).reasons).toEqual([
      "topic_kill_ledger_schema_invalid"
    ]);
    expect(validateTopicKillLedger(recordPayloadAttack).reasons).toEqual([
      "topic_kill_ledger_schema_invalid"
    ]);
  });

  it("rejects chain truncation and parent-record modification", () => {
    const parent = appendTopicKillLedger(createTopicKillLedger(), recordInput());
    const child = appendTopicKillLedger(parent, recordInput({
      statement: "A distinct candidate",
      source_topic_content_sha256: HASH_C,
      source_bounded_outcome_content_sha256: HASH_D
    }));

    const truncated = rehashLedger({
      ...child,
      records: [child.records[1]]
    });
    expect(validateTopicKillLedger(truncated).reasons).toContain(
      "topic_kill_ledger_previous_hash_mismatch:0"
    );

    const modifiedParentRecord = rehashRecord({
      ...child.records[0],
      source_run_id: "rewritten-parent"
    }) as unknown as TopicKillRecord;
    const modifiedParent = rehashLedger({
      ...child,
      records: [modifiedParentRecord, child.records[1]]
    });
    expect(validateTopicKillLedger(modifiedParent).reasons).toContain(
      "topic_kill_ledger_previous_hash_mismatch:1"
    );
  });

  it("rejects a fully rehashed alternate history against the expected parent", () => {
    const expectedParent = appendTopicKillLedger(createTopicKillLedger(), recordInput());
    const alternateParent = appendTopicKillLedger(createTopicKillLedger(), recordInput({
      statement: "An alternate first candidate",
      source_topic_content_sha256: HASH_C,
      source_bounded_outcome_content_sha256: HASH_D
    }));
    const alternateChild = appendTopicKillLedger(alternateParent, recordInput({
      statement: "A later candidate",
      source_topic_content_sha256: HASH_E,
      source_bounded_outcome_content_sha256: HASH_F
    }));

    expect(validateTopicKillLedger(alternateChild).valid).toBe(true);
    expect(validateTopicKillLedger(alternateChild, {
      expectedParentLedger: expectedParent
    }).reasons).toEqual(expect.arrayContaining([
      "topic_kill_ledger_parent_prefix_mismatch",
      "topic_kill_ledger_parent_hash_mismatch"
    ]));
  });

  it("rejects duplicate or conflicting statement, source, and outcome identities", () => {
    const parent = appendTopicKillLedger(createTopicKillLedger(), recordInput());

    expect(() => appendTopicKillLedger(parent, recordInput())).toThrow(
      "topic_kill_ledger_duplicate_or_conflicting_record"
    );
    expect(() => appendTopicKillLedger(parent, recordInput({
      source_topic_content_sha256: HASH_C,
      source_bounded_outcome_content_sha256: HASH_D
    }))).toThrow("topic_kill_ledger_duplicate_or_conflicting_record");
    expect(() => appendTopicKillLedger(parent, recordInput({
      statement: "A different statement",
      source_bounded_outcome_content_sha256: HASH_D
    }))).toThrow("topic_kill_ledger_duplicate_or_conflicting_record");
    expect(() => appendTopicKillLedger(parent, recordInput({
      statement: "A different statement",
      source_topic_content_sha256: HASH_C
    }))).toThrow("topic_kill_ledger_duplicate_or_conflicting_record");
  });

  it("rejects a canonically rehashed duplicate injected into serialized history", () => {
    const parent = appendTopicKillLedger(createTopicKillLedger(), recordInput());
    const first = parent.records[0];
    const duplicate = rehashRecord({
      ...first,
      previous_ledger_sha256: parent.ledger_sha256,
      source_run_id: "topic-refresh-02"
    });
    const attack = rehashLedger({
      ...parent,
      records: [first, duplicate]
    });

    expect(validateTopicKillLedger(attack).reasons).toEqual(expect.arrayContaining([
      "topic_kill_ledger_duplicate_or_conflicting_statement:1",
      "topic_kill_ledger_duplicate_or_conflicting_source_topic:1",
      "topic_kill_ledger_duplicate_or_conflicting_bounded_outcome:1"
    ]));
  });

  it("rejects disguised payload codes, duplicate codes, and category conflicts", () => {
    const genesis = createTopicKillLedger();

    expect(() => appendTopicKillLedger(genesis, recordInput({
      public_reason_codes: ["private_measurement_value" as never]
    }))).toThrow("topic_kill_ledger_public_reason_code_unknown");
    expect(() => appendTopicKillLedger(genesis, recordInput({
      public_reason_codes: [
        "bounded_probe_effect_floor_not_met",
        "bounded_probe_effect_floor_not_met"
      ]
    }))).toThrow("topic_kill_ledger_public_reason_code_duplicate");
    expect(() => appendTopicKillLedger(genesis, recordInput({
      disposition_category: "prior_work_absorbed",
      public_reason_codes: ["bounded_probe_effect_floor_not_met"]
    }))).toThrow("topic_kill_ledger_disposition_reason_conflict");
  });

  it("rejects unknown input fields instead of silently dropping outcome data", () => {
    const input = {
      ...recordInput(),
      observed_result: 0.75
    } as TopicKillRecordInput;

    expect(() => appendTopicKillLedger(createTopicKillLedger(), input)).toThrow(
      "topic_kill_ledger_record_input_schema_invalid"
    );
  });

  it("fails closed when a block lookup receives a tampered ledger", () => {
    const ledger = appendTopicKillLedger(createTopicKillLedger(), recordInput());
    const tampered = {
      ...ledger,
      ledger_sha256: HASH_F
    };

    expect(validateTopicKillLedger(tampered).valid).toBe(false);
    expect(() => requireValidTopicKillLedger(tampered)).toThrow(
      "topic_kill_ledger_invalid"
    );
    expect(() => topicKillLedgerBlocksStatement(tampered, recordInput().statement)).toThrow(
      "topic_kill_ledger_invalid"
    );
  });

  it("rejects noncanonical serialized reason ordering even after rehashing", () => {
    const ledger = appendTopicKillLedger(createTopicKillLedger(), recordInput({
      disposition_category: "prior_work_absorbed",
      public_reason_codes: [
        "closest_prior_absorbs_contribution",
        "novelty_not_defensible"
      ]
    }));
    const unsortedRecord = rehashRecord({
      ...ledger.records[0],
      public_reason_codes: [
        "novelty_not_defensible",
        "closest_prior_absorbs_contribution"
      ]
    });
    const attack = rehashLedger({
      ...ledger,
      records: [unsortedRecord]
    });

    expect(validateTopicKillLedger(attack).reasons).toEqual([
      "topic_kill_ledger_schema_invalid"
    ]);
  });

  it("requires an exact lookup schema and lowercase SHA-256 source identity", () => {
    const ledger = appendTopicKillLedger(createTopicKillLedger(), recordInput());

    expect(() => evaluateTopicKillLedgerBlock(ledger, {
      statement: recordInput().statement,
      source_topic_content_sha256: HASH_A,
      metric: "forbidden"
    } as never)).toThrow("topic_kill_ledger_block_candidate_schema_invalid");
    expect(() => topicKillLedgerBlocksSourceIdentity(ledger, HASH_A.toUpperCase())).toThrow(
      "topic_kill_ledger_source_topic_content_sha256_invalid"
    );
  });
});
