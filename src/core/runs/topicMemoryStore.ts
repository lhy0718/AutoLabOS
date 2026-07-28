import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {
  appendTopicKillRecord,
  createTopicMemoryLedger,
  evaluateTopicMemory,
  requireValidTopicMemoryLedger,
  type TopicFormulationDescriptor,
  type TopicKillRecordInput,
  type TopicMemoryDecision,
  type TopicMemoryLedger,
  type TopicReentryTicket
} from "../topicMemory.js";
import { normalizeFsPath } from "../../utils/fs.js";

interface TopicMemoryRow {
  sequence_id: number;
  record_sha256: string;
  record_json: string;
}

export interface TopicMemoryAppendResult {
  previous_ledger_sha256: string;
  ledger: TopicMemoryLedger;
  record_sha256: string;
}

export interface TopicMemoryIdempotentAppendResult
  extends TopicMemoryAppendResult {
  appended: boolean;
}

export function buildTopicMemoryDatabasePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".autolabos", "topic-memory.sqlite");
}

export class TopicMemoryStore {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    const normalizedFilePath = normalizeFsPath(filePath);
    mkdirSync(path.dirname(normalizedFilePath), { recursive: true });
    this.db = new Database(normalizedFilePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topic_kill_record (
        sequence_id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_sha256 TEXT NOT NULL UNIQUE,
        formulation_sha256 TEXT NOT NULL UNIQUE,
        source_topic_content_sha256 TEXT NOT NULL UNIQUE,
        source_decision_content_sha256 TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL
      );

      CREATE TRIGGER IF NOT EXISTS topic_kill_record_immutable_update
      BEFORE UPDATE ON topic_kill_record
      BEGIN
        SELECT RAISE(ABORT, 'topic_kill_record_immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS topic_kill_record_immutable_delete
      BEFORE DELETE ON topic_kill_record
      BEGIN
        SELECT RAISE(ABORT, 'topic_kill_record_immutable');
      END;
    `);
  }

  close(): void {
    this.db.close();
  }

  loadLedger(): TopicMemoryLedger {
    const rows = this.db
      .prepare(`
        SELECT sequence_id, record_sha256, record_json
        FROM topic_kill_record
        ORDER BY sequence_id ASC
      `)
      .all() as TopicMemoryRow[];
    const records: unknown[] = [];
    for (const row of rows) {
      let record: unknown;
      try {
        record = JSON.parse(row.record_json);
      } catch {
        throw new Error(
          `topic_memory_store_record_json_invalid:${row.sequence_id}`
        );
      }
      if (
        !record
        || typeof record !== "object"
        || (record as { record_sha256?: unknown }).record_sha256
          !== row.record_sha256
      ) {
        throw new Error(
          `topic_memory_store_record_hash_binding_mismatch:${row.sequence_id}`
        );
      }
      records.push(record);
    }
    return requireValidTopicMemoryLedger(
      rebuildLedgerFromRecords({ records })
    );
  }

  evaluate(
    descriptor: TopicFormulationDescriptor,
    reentryTicket?: TopicReentryTicket
  ): TopicMemoryDecision {
    return evaluateTopicMemory(
      this.loadLedger(),
      descriptor,
      reentryTicket
    );
  }

  append(
    input: TopicKillRecordInput,
    expectedLedgerSha256?: string
  ): TopicMemoryAppendResult {
    const transaction = this.db.transaction(() => {
      const parent = this.loadLedger();
      if (
        expectedLedgerSha256
        && parent.ledger_sha256 !== expectedLedgerSha256
      ) {
        throw new Error("topic_memory_store_compare_and_swap_mismatch");
      }
      const ledger = appendTopicKillRecord(parent, input);
      const record = ledger.records.at(-1);
      if (!record) {
        throw new Error("topic_memory_store_append_record_missing");
      }
      this.db.prepare(`
        INSERT INTO topic_kill_record (
          record_sha256,
          formulation_sha256,
          source_topic_content_sha256,
          source_decision_content_sha256,
          record_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        record.record_sha256,
        record.descriptor.formulation_sha256,
        record.source_topic_content_sha256,
        record.source_decision_content_sha256,
        JSON.stringify(record)
      );
      const persisted = this.loadLedger();
      if (persisted.ledger_sha256 !== ledger.ledger_sha256) {
        throw new Error("topic_memory_store_persisted_ledger_mismatch");
      }
      return {
        previous_ledger_sha256: parent.ledger_sha256,
        ledger: persisted,
        record_sha256: record.record_sha256
      };
    });
    return transaction.immediate();
  }

  appendIdempotent(
    input: TopicKillRecordInput,
    expectedLedgerSha256?: string
  ): TopicMemoryIdempotentAppendResult {
    const transaction = this.db.transaction(() => {
      const parent = this.loadLedger();
      const existing = parent.records.find(
        (record) =>
          record.source_decision_content_sha256
            === input.source_decision_content_sha256
      );
      if (existing) {
        assertRecordMatchesInput(existing, input);
        return {
          previous_ledger_sha256: existing.previous_ledger_sha256,
          ledger: parent,
          record_sha256: existing.record_sha256,
          appended: false
        };
      }
      if (
        expectedLedgerSha256
        && parent.ledger_sha256 !== expectedLedgerSha256
      ) {
        throw new Error("topic_memory_store_compare_and_swap_mismatch");
      }
      const ledger = appendTopicKillRecord(parent, input);
      const record = ledger.records.at(-1);
      if (!record) {
        throw new Error("topic_memory_store_append_record_missing");
      }
      this.db.prepare(`
        INSERT INTO topic_kill_record (
          record_sha256,
          formulation_sha256,
          source_topic_content_sha256,
          source_decision_content_sha256,
          record_json
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        record.record_sha256,
        record.descriptor.formulation_sha256,
        record.source_topic_content_sha256,
        record.source_decision_content_sha256,
        JSON.stringify(record)
      );
      const persisted = this.loadLedger();
      if (persisted.ledger_sha256 !== ledger.ledger_sha256) {
        throw new Error("topic_memory_store_persisted_ledger_mismatch");
      }
      return {
        previous_ledger_sha256: parent.ledger_sha256,
        ledger: persisted,
        record_sha256: record.record_sha256,
        appended: true
      };
    });
    return transaction.immediate();
  }
}

function assertRecordMatchesInput(
  existing: TopicMemoryLedger["records"][number],
  input: TopicKillRecordInput
): void {
  const normalized = appendTopicKillRecord(
    createTopicMemoryLedger(),
    input
  ).records[0];
  if (!normalized) {
    throw new Error("topic_memory_store_idempotent_input_invalid");
  }
  const fieldsMatch =
    existing.descriptor.formulation_sha256
      === normalized.descriptor.formulation_sha256
    && existing.kill_scope === normalized.kill_scope
    && existing.disposition_category === normalized.disposition_category
    && JSON.stringify(existing.public_reason_codes)
      === JSON.stringify(normalized.public_reason_codes)
    && existing.source_run_id === normalized.source_run_id
    && existing.source_research_cycle === normalized.source_research_cycle
    && JSON.stringify(existing.source_full_text_evidence_ids)
      === JSON.stringify(normalized.source_full_text_evidence_ids)
    && existing.source_topic_content_sha256
      === normalized.source_topic_content_sha256;
  if (!fieldsMatch) {
    throw new Error("topic_memory_store_idempotent_conflict");
  }
}

function rebuildLedgerFromRecords(value: unknown): TopicMemoryLedger {
  const records = (
    value as { records?: unknown[] }
  ).records || [];
  let ledger = createTopicMemoryLedger();
  for (const record of records) {
    if (!record || typeof record !== "object") {
      throw new Error("topic_memory_store_record_schema_invalid");
    }
    const item = record as Record<string, unknown>;
    ledger = appendTopicKillRecord(ledger, {
      descriptor: item.descriptor as TopicKillRecordInput["descriptor"],
      kill_scope: item.kill_scope as TopicKillRecordInput["kill_scope"],
      disposition_category:
        item.disposition_category as TopicKillRecordInput["disposition_category"],
      public_reason_codes:
        item.public_reason_codes as TopicKillRecordInput["public_reason_codes"],
      source_run_id: item.source_run_id as string,
      source_research_cycle: item.source_research_cycle as number,
      source_full_text_evidence_ids:
        item.source_full_text_evidence_ids as string[],
      source_topic_content_sha256:
        item.source_topic_content_sha256 as string,
      source_decision_content_sha256:
        item.source_decision_content_sha256 as string
    });
    if (
      ledger.records.at(-1)?.record_sha256
        !== item.record_sha256
      || ledger.records.at(-1)?.previous_ledger_sha256
        !== item.previous_ledger_sha256
    ) {
      throw new Error("topic_memory_store_record_chain_mismatch");
    }
  }
  return ledger;
}
