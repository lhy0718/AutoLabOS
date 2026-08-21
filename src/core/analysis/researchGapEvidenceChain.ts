import { createHash } from "node:crypto";

import type { ResearchFunnelValidationContext } from "../researchFunnel.js";
import {
  parseReusableResearchGapSynthesisArtifact,
  type ResearchGapSynthesisArtifact
} from "./researchGapSynthesis.js";
import type { HypothesisEvidenceSeed } from "./researchPlanning.js";

export interface ResearchGapEvidenceRow extends HypothesisEvidenceSeed {
  method_slot?: string;
  result_slot?: string;
}

export interface ResearchGapEvidenceAudit {
  total_evidence_count: number;
  scientific_evidence_count: number;
  grounded_scientific_evidence_count: number;
  synthesis_eligible_evidence_count: number;
  synthesis_excluded_evidence_count: number;
  accepted_cluster_count: number;
  malformed_evidence_row_count: number;
  source_scope_counts: Record<"abstract" | "full_text_excerpt" | "full_document" | "unknown", number>;
  grounding_status_counts: Record<"grounded_span" | "ungrounded_span" | "fallback" | "unknown", number>;
}

export interface ResearchGapEvidenceChain {
  collectAttemptId?: string;
  corpusSha256: string;
  corpusByteLength: number;
  evidenceSha256: string;
  evidenceByteLength: number;
  evidenceRows: ResearchGapEvidenceRow[];
  synthesisArtifact?: ResearchGapSynthesisArtifact;
  validationContext: Omit<
    ResearchFunnelValidationContext,
    "expectedRunId" | "expectedResearchCycle" | "allowUnbound"
  >;
  reasonCodes: string[];
  audit: ResearchGapEvidenceAudit;
}

export function buildResearchGapEvidenceChain(input: {
  runId: string;
  researchCycle: number;
  corpusRaw: string;
  evidenceRaw: string;
  synthesisRaw: string;
  collectGenerationRaw: string;
}): ResearchGapEvidenceChain {
  const collectAttemptId = parseCollectAttemptId(input.collectGenerationRaw);
  const corpusSha256 = sha256(input.corpusRaw);
  const evidenceSha256 = sha256(input.evidenceRaw);
  const parsedEvidence = parseResearchGapEvidenceRows(input.evidenceRaw);
  const reasonCodes: string[] = [];
  if (!collectAttemptId) {
    reasonCodes.push("research_gap_collect_generation_missing_or_invalid");
  }
  if (!input.corpusRaw.trim()) {
    reasonCodes.push("research_gap_corpus_missing_or_empty");
  }
  if (!input.evidenceRaw.trim()) {
    reasonCodes.push("research_gap_evidence_store_missing_or_empty");
  }
  if (parsedEvidence.malformedRowCount > 0) {
    reasonCodes.push("research_gap_evidence_store_invalid_jsonl");
  }
  const synthesisArtifact = parseReusableResearchGapSynthesisArtifact(
    input.synthesisRaw,
    {
      runId: input.runId,
      researchCycle: input.researchCycle,
      collectAttemptId: collectAttemptId ?? "",
      corpusSha256,
      evidenceSha256
    }
  );
  if (!synthesisArtifact) {
    reasonCodes.push("research_gap_synthesis_missing_or_invalid");
  }
  const evidenceAvailable = input.evidenceRaw.trim().length > 0 && parsedEvidence.malformedRowCount === 0;
  const reviewedClusters = synthesisArtifact?.accepted_clusters.map((cluster) => ({
    statement: cluster.statement,
    evidence_ids: cluster.evidence_ids,
    opportunity_type: cluster.opportunity_type
  }));
  const validationContext: ResearchGapEvidenceChain["validationContext"] = {
    expectedCollectAttemptId: collectAttemptId ?? "",
    expectedCorpusSha256: corpusSha256,
    expectedCorpusByteLength: Buffer.byteLength(input.corpusRaw, "utf8"),
    expectedEvidenceSha256: evidenceSha256,
    expectedEvidenceByteLength: Buffer.byteLength(input.evidenceRaw, "utf8"),
    evidence: evidenceAvailable ? parsedEvidence.rows : undefined,
    reviewedClusters,
    requireExternalEvidence: true,
    requireReviewedSynthesis: true,
    synthesisArtifactValid: Boolean(synthesisArtifact),
    expectedSynthesisContentSha256: synthesisArtifact?.content_sha256,
    expectedSynthesisSemanticsVersion: synthesisArtifact?.semantics_version,
    expectedAnalysisComplete: true
  };

  return {
    collectAttemptId,
    corpusSha256,
    corpusByteLength: Buffer.byteLength(input.corpusRaw, "utf8"),
    evidenceSha256,
    evidenceByteLength: Buffer.byteLength(input.evidenceRaw, "utf8"),
    evidenceRows: parsedEvidence.rows,
    synthesisArtifact,
    validationContext,
    reasonCodes: uniqueStrings(reasonCodes),
    audit: buildEvidenceAudit(parsedEvidence.rows, parsedEvidence.malformedRowCount, synthesisArtifact)
  };
}

export function parseResearchGapEvidenceRows(raw: string): {
  rows: ResearchGapEvidenceRow[];
  malformedRowCount: number;
} {
  const rows: ResearchGapEvidenceRow[] = [];
  let malformedRowCount = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) {
        malformedRowCount += 1;
        continue;
      }
      rows.push(parsed as ResearchGapEvidenceRow);
    } catch {
      malformedRowCount += 1;
    }
  }
  return { rows, malformedRowCount };
}

function buildEvidenceAudit(
  rows: ResearchGapEvidenceRow[],
  malformedEvidenceRowCount: number,
  synthesisArtifact: ResearchGapSynthesisArtifact | undefined
): ResearchGapEvidenceAudit {
  const sourceScopeCounts: ResearchGapEvidenceAudit["source_scope_counts"] = {
    abstract: 0,
    full_text_excerpt: 0,
    full_document: 0,
    unknown: 0
  };
  const groundingStatusCounts: ResearchGapEvidenceAudit["grounding_status_counts"] = {
    grounded_span: 0,
    ungrounded_span: 0,
    fallback: 0,
    unknown: 0
  };
  for (const row of rows) {
    const sourceScope = row.source_scope;
    sourceScopeCounts[
      sourceScope === "abstract" || sourceScope === "full_text_excerpt" || sourceScope === "full_document"
        ? sourceScope
        : "unknown"
    ] += 1;
    const groundingStatus = row.grounding_status;
    groundingStatusCounts[
      groundingStatus === "grounded_span" || groundingStatus === "ungrounded_span" || groundingStatus === "fallback"
        ? groundingStatus
        : "unknown"
    ] += 1;
  }
  return {
    total_evidence_count: rows.length,
    scientific_evidence_count: rows.filter((row) => row.limitation_kind === "scientific").length,
    grounded_scientific_evidence_count: rows.filter(
      (row) => row.limitation_kind === "scientific" && row.grounding_status === "grounded_span"
    ).length,
    synthesis_eligible_evidence_count: synthesisArtifact?.diagnostics.eligible_evidence_count ?? 0,
    synthesis_excluded_evidence_count: synthesisArtifact?.excluded_evidence.length ?? 0,
    accepted_cluster_count: synthesisArtifact?.accepted_clusters.length ?? 0,
    malformed_evidence_row_count: malformedEvidenceRowCount,
    source_scope_counts: sourceScopeCounts,
    grounding_status_counts: groundingStatusCounts
  };
}

function parseCollectAttemptId(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed)
      || parsed.version !== 1
      || parsed.kind !== "collect_generation"
      || typeof parsed.collect_attempt_id !== "string"
    ) {
      return undefined;
    }
    const normalized = parsed.collect_attempt_id.trim();
    return normalized || undefined;
  } catch {
    return undefined;
  }
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
