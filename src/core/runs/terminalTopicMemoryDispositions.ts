import { hashCanonical } from "../canonicalHash.js";
import type {
  TopicPortfolio,
  TopicPortfolioCandidate
} from "../researchFunnel.js";
import type { PriorAbsorptionMatrix } from "../priorAbsorption.js";
import type {
  TopicKillDispositionCategory,
  TopicKillPublicReasonCode,
  TopicMemoryLedger
} from "../topicMemory.js";
import {
  buildTopicMemoryDatabasePath,
  TopicMemoryStore
} from "./topicMemoryStore.js";

export interface TerminalTopicMemoryDisposition {
  disposition_category:
    | "prior_work_absorbed"
    | "independent_review_rejected";
  public_reason_codes: TopicKillPublicReasonCode[];
  source_full_text_evidence_ids: string[];
  source_decision_content_sha256: string;
}

export interface TerminalTopicMemoryUpdateArtifact {
  schema_version: 1;
  artifact_kind: "terminal_topic_memory_updates";
  run_id: string;
  research_cycle: number;
  generated_at: string;
  source_portfolio_content_sha256: string;
  source_ledger_sha256: string;
  resulting_ledger_sha256: string;
  updates: Array<{
    source_candidate_id: string;
    formulation_sha256: string;
    disposition_category: TopicKillDispositionCategory;
    public_reason_codes: TopicKillPublicReasonCode[];
    source_decision_content_sha256: string;
    source_full_text_evidence_ids: string[];
    status: "appended" | "already_present";
    record_sha256: string;
  }>;
  content_sha256: string;
}

export function resolveTerminalTopicMemoryDisposition(
  candidate: TopicPortfolioCandidate,
  priorAbsorptionMatrix?: PriorAbsorptionMatrix
): TerminalTopicMemoryDisposition | undefined {
  const absorbed = candidate.prior_absorption?.comparisons.some(
    (comparison) => comparison.disposition === "absorbed"
  ) ?? false;
  const dispositionCategory = absorbed
    ? "prior_work_absorbed" as const
    : candidate.review_status === "rejected"
      ? "independent_review_rejected" as const
      : undefined;
  if (!dispositionCategory) {
    return undefined;
  }
  const publicReasonCodes: TopicKillPublicReasonCode[] =
    dispositionCategory === "prior_work_absorbed"
      ? ["closest_prior_absorbs_contribution"]
      : ["independent_review_rejected"];
  const matrixCandidate = priorAbsorptionMatrix?.candidates.find(
    (item) => item.candidate_id === candidate.source_candidate_id
  );
  const evidenceIds = uniqueStrings(
    matrixCandidate?.comparisons.flatMap((comparison) => [
      ...comparison.axes.flatMap((axis) =>
        axis.evidence_refs.map((reference) => reference.evidence_id)
      ),
      ...comparison.independent_evidence_refs.map(
        (reference) => reference.evidence_id
      )
    ]) || []
  );
  const decisionPayload = {
    schema_version: 1 as const,
    artifact_kind: "terminal_topic_candidate_decision" as const,
    source_candidate_id: candidate.source_candidate_id,
    source_candidate_content_sha256: candidate.content_sha256,
    disposition_category: dispositionCategory,
    public_reason_codes: publicReasonCodes,
    source_full_text_evidence_ids: evidenceIds,
    source_prior_absorption_matrix_sha256:
      candidate.prior_absorption?.matrix_content_sha256 || null,
    review_status: candidate.review_status,
    review_summary: candidate.review_summary || null
  };
  return {
    disposition_category: dispositionCategory,
    public_reason_codes: publicReasonCodes,
    source_full_text_evidence_ids: evidenceIds,
    source_decision_content_sha256: hashCanonical(decisionPayload)
  };
}

export function persistTerminalTopicMemoryDispositions(input: {
  workspaceRoot: string;
  runId: string;
  researchCycle: number;
  generatedAt: string;
  portfolio: TopicPortfolio;
  priorAbsorptionMatrix?: PriorAbsorptionMatrix;
}): {
  ledger: TopicMemoryLedger;
  artifact: TerminalTopicMemoryUpdateArtifact;
} {
  const snapshot = input.portfolio.topic_memory_ledger;
  if (!snapshot) {
    throw new Error("terminal_topic_memory_snapshot_missing");
  }
  const terminalCandidates = input.portfolio.candidates.flatMap((candidate) => {
    const disposition = resolveTerminalTopicMemoryDisposition(
      candidate,
      input.priorAbsorptionMatrix
    );
    return disposition && candidate.topic_memory?.descriptor
      ? [{ candidate, disposition }]
      : [];
  });
  const store = new TopicMemoryStore(
    buildTopicMemoryDatabasePath(input.workspaceRoot)
  );
  try {
    let current = store.loadLedger();
    if (!ledgerHasPrefix(current, snapshot)) {
      throw new Error("terminal_topic_memory_snapshot_not_ancestor");
    }
    const updates: TerminalTopicMemoryUpdateArtifact["updates"] = [];
    for (const { candidate, disposition } of terminalCandidates) {
      if (
        disposition.disposition_category === "prior_work_absorbed"
        && disposition.source_full_text_evidence_ids.length < 2
      ) {
        throw new Error(
          `terminal_topic_memory_absorption_evidence_insufficient:${candidate.source_candidate_id}`
        );
      }
      const descriptor = candidate.topic_memory!.descriptor!;
      const existing = current.records.find(
        (record) =>
          record.descriptor.formulation_sha256
            === descriptor.formulation_sha256
      );
      if (existing) {
        updates.push({
          source_candidate_id: candidate.source_candidate_id,
          formulation_sha256: descriptor.formulation_sha256,
          disposition_category: disposition.disposition_category,
          public_reason_codes: disposition.public_reason_codes,
          source_decision_content_sha256:
            disposition.source_decision_content_sha256,
          source_full_text_evidence_ids:
            disposition.source_full_text_evidence_ids,
          status: "already_present",
          record_sha256: existing.record_sha256
        });
        continue;
      }
      const append = store.appendIdempotent({
        descriptor,
        kill_scope: "exact_formulation",
        disposition_category: disposition.disposition_category,
        public_reason_codes: disposition.public_reason_codes,
        source_run_id: input.runId,
        source_research_cycle: input.researchCycle,
        source_full_text_evidence_ids:
          disposition.source_full_text_evidence_ids,
        source_topic_content_sha256: candidate.content_sha256,
        source_decision_content_sha256:
          disposition.source_decision_content_sha256
      }, current.ledger_sha256);
      current = append.ledger;
      updates.push({
        source_candidate_id: candidate.source_candidate_id,
        formulation_sha256: descriptor.formulation_sha256,
        disposition_category: disposition.disposition_category,
        public_reason_codes: disposition.public_reason_codes,
        source_decision_content_sha256:
          disposition.source_decision_content_sha256,
        source_full_text_evidence_ids:
          disposition.source_full_text_evidence_ids,
        status: append.appended ? "appended" : "already_present",
        record_sha256: append.record_sha256
      });
    }
    const artifactPayload = {
      schema_version: 1 as const,
      artifact_kind: "terminal_topic_memory_updates" as const,
      run_id: input.runId,
      research_cycle: input.researchCycle,
      generated_at: input.generatedAt,
      source_portfolio_content_sha256: input.portfolio.content_sha256,
      source_ledger_sha256: snapshot.ledger_sha256,
      resulting_ledger_sha256: current.ledger_sha256,
      updates
    };
    return {
      ledger: current,
      artifact: {
        ...artifactPayload,
        content_sha256: hashCanonical(artifactPayload)
      }
    };
  } finally {
    store.close();
  }
}

function ledgerHasPrefix(
  current: TopicMemoryLedger,
  snapshot: TopicMemoryLedger
): boolean {
  return snapshot.records.length <= current.records.length
    && snapshot.records.every(
      (record, index) =>
        current.records[index]?.record_sha256 === record.record_sha256
    );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right)
  );
}
