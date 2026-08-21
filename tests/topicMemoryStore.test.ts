import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { buildTopicFormulationDescriptor } from "../src/core/topicMemory.js";
import { TopicMemoryStore } from "../src/core/runs/topicMemoryStore.js";

const roots: string[] = [];

async function createStore() {
  const root = await mkdtemp(path.join(tmpdir(), "autolabos-topic-memory-"));
  roots.push(root);
  return new TopicMemoryStore(path.join(root, "topic-memory.sqlite"));
}

function descriptor() {
  return buildTopicFormulationDescriptor({
    statement: "Compare two bounded research interfaces.",
    contribution_claim: "A bounded research-interface comparison.",
    dataset_task_bench: "A licensed task corpus.",
    comparator: "The strongest public baseline.",
    primary_metric: "task_success",
    metric_unit: "proportion",
    meaningful_effect: "Five percentage points.",
    minimum_publishable_evidence: "Repeated clustered evidence."
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("TopicMemoryStore", () => {
  it("persists an append-only record and reloads the same ledger", async () => {
    const store = await createStore();
    const before = store.loadLedger();
    const result = store.append({
      descriptor: descriptor(),
      kill_scope: "exact_formulation",
      disposition_category: "bounded_probe_rejected",
      public_reason_codes: ["bounded_probe_effect_floor_not_met"],
      source_run_id: "run-store",
      source_research_cycle: 1,
      source_full_text_evidence_ids: [],
      source_topic_content_sha256: "c".repeat(64),
      source_decision_content_sha256: "d".repeat(64)
    }, before.ledger_sha256);

    expect(result.previous_ledger_sha256).toBe(before.ledger_sha256);
    expect(result.ledger.records).toHaveLength(1);
    expect(store.loadLedger().ledger_sha256).toBe(result.ledger.ledger_sha256);
    store.close();
  });

  it("fails closed when compare-and-swap sees a stale ledger", async () => {
    const store = await createStore();
    expect(() => store.append({
      descriptor: descriptor(),
      kill_scope: "exact_formulation",
      disposition_category: "bounded_probe_rejected",
      public_reason_codes: ["bounded_probe_effect_floor_not_met"],
      source_run_id: "run-store",
      source_research_cycle: 1,
      source_full_text_evidence_ids: [],
      source_topic_content_sha256: "e".repeat(64),
      source_decision_content_sha256: "f".repeat(64)
    }, "0".repeat(64))).toThrow("topic_memory_store_compare_and_swap_mismatch");
    store.close();
  });

  it("reuses an identical source decision without appending twice", async () => {
    const store = await createStore();
    const before = store.loadLedger();
    const input = {
      descriptor: descriptor(),
      kill_scope: "exact_formulation" as const,
      disposition_category: "bounded_probe_rejected" as const,
      public_reason_codes: ["bounded_probe_hypothesis_not_supported" as const],
      source_run_id: "run-idempotent",
      source_research_cycle: 2,
      source_full_text_evidence_ids: [],
      source_topic_content_sha256: "1".repeat(64),
      source_decision_content_sha256: "2".repeat(64)
    };

    const first = store.appendIdempotent(input, before.ledger_sha256);
    const second = store.appendIdempotent(input, before.ledger_sha256);

    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(second.record_sha256).toBe(first.record_sha256);
    expect(second.ledger.records).toHaveLength(1);
    store.close();
  });
});
