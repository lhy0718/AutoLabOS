import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildTopicFormulationDescriptor,
  createTopicMemoryLedger
} from "../src/core/topicMemory.js";
import type {
  TopicPortfolio,
  TopicPortfolioCandidate
} from "../src/core/researchFunnel.js";
import {
  persistTerminalTopicMemoryDispositions,
  resolveTerminalTopicMemoryDisposition
} from "../src/core/runs/terminalTopicMemoryDispositions.js";
import {
  buildTopicMemoryDatabasePath,
  TopicMemoryStore
} from "../src/core/runs/topicMemoryStore.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

function rejectedCandidate(): TopicPortfolioCandidate {
  const descriptor = buildTopicFormulationDescriptor({
    statement: "Compare a bounded intervention with a declared control.",
    contribution_claim:
      "A controlled comparison for a bounded intervention.",
    dataset_task_bench: "A permission-cleared evaluation collection.",
    comparator: "Declared control.",
    primary_metric: "primary_score",
    metric_unit: "proportion",
    meaningful_effect: "At least five percentage points.",
    minimum_publishable_evidence:
      "Repeated independent units with paired uncertainty."
  });
  return {
    source_candidate_id: "candidate_alpha",
    content_sha256: "c".repeat(64),
    review_status: "rejected",
    topic_memory: {
      ledger_sha256: createTopicMemoryLedger().ledger_sha256,
      descriptor,
      decision: {
        disposition: "clear",
        blocked: false,
        exact_formulation_match: false,
        exact_lineage_match: false,
        near_lineage_match: false,
        matching_record_sha256s: [],
        maximum_lineage_similarity: 0,
        reason_codes: []
      }
    }
  } as unknown as TopicPortfolioCandidate;
}

function portfolio(candidate: TopicPortfolioCandidate): TopicPortfolio {
  return {
    topic_memory_ledger: createTopicMemoryLedger(),
    candidates: [candidate],
    content_sha256: "d".repeat(64)
  } as unknown as TopicPortfolio;
}

describe("terminal topic-memory dispositions", () => {
  it("classifies an independently rejected candidate as a terminal formulation", () => {
    expect(resolveTerminalTopicMemoryDisposition(rejectedCandidate())).toMatchObject({
      disposition_category: "independent_review_rejected",
      public_reason_codes: ["independent_review_rejected"]
    });
  });

  it("persists the terminal formulation idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "topic-memory-terminal-"));
    roots.push(root);
    const candidate = rejectedCandidate();
    const input = {
      workspaceRoot: root,
      runId: "run-terminal",
      researchCycle: 2,
      generatedAt: "2026-01-01T00:00:00.000Z",
      portfolio: portfolio(candidate)
    };

    const first = persistTerminalTopicMemoryDispositions(input);
    const second = persistTerminalTopicMemoryDispositions(input);
    const store = new TopicMemoryStore(buildTopicMemoryDatabasePath(root));
    const ledger = store.loadLedger();
    store.close();

    expect(first.artifact.updates).toEqual([
      expect.objectContaining({
        source_candidate_id: "candidate_alpha",
        status: "appended",
        disposition_category: "independent_review_rejected"
      })
    ]);
    expect(second.artifact.updates).toEqual([
      expect.objectContaining({
        source_candidate_id: "candidate_alpha",
        status: "already_present"
      })
    ]);
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({
      disposition_category: "independent_review_rejected",
      public_reason_codes: ["independent_review_rejected"]
    });
  });
});
