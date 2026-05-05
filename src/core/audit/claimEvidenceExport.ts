import type { ClaimEvidenceScore } from "../benchmark/claimEvidenceScoring.js";
import type { PaperReadinessAuditUnsupportedClaim } from "./paperReadinessAudit.js";

export interface ClaimEvidenceExportInput {
  claimEvidenceTableArtifact?: unknown;
  claimStatusTableArtifact?: unknown;
  evidenceLinksArtifact?: unknown;
  claimEvidenceScore: ClaimEvidenceScore;
  unsupportedClaims: PaperReadinessAuditUnsupportedClaim[];
}

export interface ClaimEvidenceExportRow {
  claim_id: string;
  statement?: string;
  section_heading?: string;
  status: "supported" | "unsupported" | "blocked" | "unverified" | "unknown";
  artifact_refs: string[];
  citation_refs: string[];
  evidence_ids: string[];
  support_level: "artifact_or_citation_linked" | "unsupported" | "blocked" | "unmeasured";
  issue_codes: string[];
}

export interface ClaimEvidenceExport {
  version: 1;
  generated_at: string;
  measured: boolean;
  summary: {
    major_claim_count: number;
    supported_claim_count: number;
    unsupported_claim_count: number;
    claim_to_evidence_coverage: number | null;
  };
  claims: ClaimEvidenceExportRow[];
  policy_note: string;
}

export function buildClaimEvidenceExport(input: ClaimEvidenceExportInput): ClaimEvidenceExport {
  const rows = mergeClaimRows([
    ...extractClaimRows(input.claimEvidenceTableArtifact),
    ...extractClaimRows(input.claimStatusTableArtifact),
    ...extractEvidenceLinkRows(input.evidenceLinksArtifact)
  ]);
  const issueCodesByClaim = new Map<string, string[]>();
  for (const issue of input.claimEvidenceScore.issues) {
    const existing = issueCodesByClaim.get(issue.claim_id) ?? [];
    existing.push(issue.code);
    issueCodesByClaim.set(issue.claim_id, existing);
  }
  for (const claim of input.unsupportedClaims) {
    if (!rows.has(claim.claim_id)) {
      rows.set(claim.claim_id, {
        claim_id: claim.claim_id,
        statement: claim.statement,
        artifact_refs: [],
        citation_refs: [],
        evidence_ids: [],
        status: claim.status
      });
    }
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    measured: input.claimEvidenceScore.measured,
    summary: {
      major_claim_count: input.claimEvidenceScore.major_claim_count,
      supported_claim_count: input.claimEvidenceScore.supported_claim_count,
      unsupported_claim_count: input.claimEvidenceScore.unsupported_claim_count,
      claim_to_evidence_coverage: input.claimEvidenceScore.claim_to_evidence_coverage
    },
    claims: [...rows.values()]
      .sort((left, right) => left.claim_id.localeCompare(right.claim_id))
      .map((row) => normalizeExportRow(row, issueCodesByClaim.get(row.claim_id) ?? [], input.claimEvidenceScore.measured)),
    policy_note: "This export normalizes existing claim artifacts and scorer issues; it does not create evidence for unsupported claims."
  };
}

interface PartialClaimRow {
  claim_id: string;
  statement?: string;
  section_heading?: string;
  status?: string;
  artifact_refs: string[];
  citation_refs: string[];
  evidence_ids: string[];
}

function normalizeExportRow(row: PartialClaimRow, issueCodes: string[], measured: boolean): ClaimEvidenceExportRow {
  const status = normalizeStatus(row.status, issueCodes);
  const hasEvidence = row.artifact_refs.length > 0 || row.citation_refs.length > 0 || row.evidence_ids.length > 0;
  const blocked = status === "blocked";
  return {
    claim_id: row.claim_id,
    ...(row.statement ? { statement: row.statement } : {}),
    ...(row.section_heading ? { section_heading: row.section_heading } : {}),
    status,
    artifact_refs: unique(row.artifact_refs),
    citation_refs: unique(row.citation_refs),
    evidence_ids: unique(row.evidence_ids),
    support_level: !measured
      ? "unmeasured"
      : blocked
        ? "blocked"
        : issueCodes.length > 0
          ? "unsupported"
          : hasEvidence
            ? "artifact_or_citation_linked"
            : "unsupported",
    issue_codes: unique(issueCodes)
  };
}

function normalizeStatus(value: string | undefined, issueCodes: string[]): ClaimEvidenceExportRow["status"] {
  if (value === "blocked") {
    return "blocked";
  }
  if (value === "unverified") {
    return "unverified";
  }
  if (value === "verified" || value === "inferred") {
    return "supported";
  }
  return issueCodes.length > 0 ? "unsupported" : "unknown";
}

function mergeClaimRows(rows: PartialClaimRow[]): Map<string, PartialClaimRow> {
  const merged = new Map<string, PartialClaimRow>();
  for (const row of rows) {
    const existing = merged.get(row.claim_id);
    merged.set(row.claim_id, {
      claim_id: row.claim_id,
      statement: row.statement || existing?.statement,
      section_heading: row.section_heading || existing?.section_heading,
      status: row.status || existing?.status,
      artifact_refs: unique([...(existing?.artifact_refs ?? []), ...row.artifact_refs]),
      citation_refs: unique([...(existing?.citation_refs ?? []), ...row.citation_refs]),
      evidence_ids: unique([...(existing?.evidence_ids ?? []), ...row.evidence_ids])
    });
  }
  return merged;
}

function extractClaimRows(value: unknown): PartialClaimRow[] {
  return normalizeClaimsArray(value).map((claim, index) => ({
    claim_id: normalizeClaimId(claim, index),
    statement: stringValue(claim.statement),
    section_heading: stringValue(claim.section_heading),
    status: stringValue(claim.status),
    artifact_refs: normalizeStringArray(claim.artifact_refs),
    citation_refs: normalizeStringArray(claim.citation_refs),
    evidence_ids: normalizeStringArray(claim.evidence_ids)
  }));
}

function extractEvidenceLinkRows(value: unknown): PartialClaimRow[] {
  return normalizeClaimsArray(value).map((claim, index) => ({
    claim_id: normalizeClaimId(claim, index),
    artifact_refs: normalizeStringArray(claim.artifact_refs),
    citation_refs: normalizeStringArray(claim.citation_paper_ids),
    evidence_ids: normalizeStringArray(claim.evidence_ids)
  }));
}

function normalizeClaimsArray(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const claims = (value as { claims?: unknown }).claims;
  return Array.isArray(claims)
    ? claims.filter((claim): claim is Record<string, unknown> => Boolean(claim) && typeof claim === "object" && !Array.isArray(claim))
    : [];
}

function normalizeClaimId(claim: Record<string, unknown>, index: number): string {
  return stringValue(claim.claim_id) || `claim_${index + 1}`;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
