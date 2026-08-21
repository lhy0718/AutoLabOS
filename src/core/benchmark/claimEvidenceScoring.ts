import type { GovernanceTaskScoreInput } from "./governanceScorer.js";

export interface ClaimEvidenceScoringIssue {
  code: string;
  claim_id: string;
  message: string;
}

export interface ClaimEvidenceScore {
  measured: boolean;
  major_claim_count: number;
  supported_claim_count: number;
  unsupported_claim_count: number;
  blocked_claim_count: number;
  claim_to_evidence_coverage: number | null;
  issues: ClaimEvidenceScoringIssue[];
}

export interface ScoreClaimEvidenceArtifactsInput {
  claimEvidenceTableArtifact?: unknown;
  claimStatusTableArtifact?: unknown;
  evidenceLinksArtifact?: unknown;
  evidenceStoreArtifact?: unknown;
  availableArtifactRefs?: readonly string[];
}

interface NormalizedClaimEvidenceRow {
  claim_id: string;
  artifact_refs: string[];
  citation_refs: string[];
  evidence_ids: string[];
  strength?: string;
}

interface NormalizedClaimStatusRow {
  claim_id: string;
  status?: string;
  artifact_refs: string[];
  citation_refs: string[];
  reproduction_trace_present?: boolean;
}

const SUPPORTED_CLAIM_STATUSES = new Set([
  "verified",
  "supported",
  "supported_by_code_and_tests",
  "supported_with_scope_limitation",
  "supported_with_task_gold_mismatch",
  "supported_with_local_runtime_boundary"
]);

const BLOCKED_CLAIM_STATUSES = new Set([
  "blocked",
  "development_only",
  "inferred"
]);

export function scoreClaimEvidenceArtifacts(
  input: ScoreClaimEvidenceArtifactsInput
): ClaimEvidenceScore {
  const tableClaims = normalizeClaimEvidenceRows(input.claimEvidenceTableArtifact);
  const statusRows = normalizeClaimStatusRows(input.claimStatusTableArtifact);
  const evidenceLinkClaims = normalizeEvidenceLinkRows(input.evidenceLinksArtifact);
  const duplicateClaimIds = new Set([
    ...duplicateIds(tableClaims.map((claim) => claim.claim_id)),
    ...duplicateIds(statusRows.map((claim) => claim.claim_id)),
    ...duplicateIds(evidenceLinkClaims.map((claim) => claim.claim_id))
  ]);
  const claimIds = new Set<string>([
    ...tableClaims.map((claim) => claim.claim_id),
    ...statusRows.map((claim) => claim.claim_id),
    ...evidenceLinkClaims.map((claim) => claim.claim_id)
  ]);

  if (claimIds.size === 0) {
    return {
      measured: false,
      major_claim_count: 0,
      supported_claim_count: 0,
      unsupported_claim_count: 0,
      blocked_claim_count: 0,
      claim_to_evidence_coverage: null,
      issues: [
        {
          code: "claim_evidence_unmeasured",
          claim_id: "unknown",
          message: "No claim evidence artifacts contained parseable claim rows."
        }
      ]
    };
  }

  const tableById = new Map(tableClaims.map((claim) => [claim.claim_id, claim] as const));
  const statusById = new Map(statusRows.map((claim) => [claim.claim_id, claim] as const));
  const evidenceLinksById = new Map(evidenceLinkClaims.map((claim) => [claim.claim_id, claim] as const));
  const evidenceStoreById = groupEvidenceStoreRows(input.evidenceStoreArtifact);
  const availableArtifactRefs = input.availableArtifactRefs
    ? new Set(input.availableArtifactRefs.map(normalizeArtifactRef))
    : undefined;
  let supported = 0;
  let unsupported = 0;
  let blockedCount = 0;
  const issues: ClaimEvidenceScoringIssue[] = [];

  for (const claimId of [...claimIds].sort()) {
    if (duplicateClaimIds.has(claimId)) {
      unsupported += 1;
      issues.push({
        code: "claim_id_duplicate",
        claim_id: claimId,
        message: `Claim ${claimId} appears more than once in at least one claim artifact; duplicate identifiers are rejected before map construction.`
      });
      continue;
    }
    const tableClaim = tableById.get(claimId);
    const statusClaim = statusById.get(claimId);
    const evidenceLinkClaim = evidenceLinksById.get(claimId);
    const artifactRefs = [
      ...(tableClaim?.artifact_refs ?? []),
      ...(statusClaim?.artifact_refs ?? []),
      ...(evidenceLinkClaim?.artifact_refs ?? [])
    ].filter(Boolean);
    const evidenceIds = [
      ...(tableClaim?.evidence_ids ?? []),
      ...(evidenceLinkClaim?.evidence_ids ?? [])
    ].filter(Boolean);
    const resolvedEvidenceIdRefs: string[] = [];
    const unresolvedEvidenceIds: string[] = [];
    for (const evidenceId of evidenceIds) {
      const matches = evidenceStoreById.get(evidenceId) ?? [];
      if (matches.length !== 1) {
        unresolvedEvidenceIds.push(evidenceId);
        continue;
      }
      const evidenceRow = matches[0];
      const boundClaimId = typeof evidenceRow.claim_id === "string" ? evidenceRow.claim_id.trim() : "";
      const evidenceValid = evidenceRow.claim_evidence_valid === true;
      if (boundClaimId !== claimId || !evidenceValid) {
        unresolvedEvidenceIds.push(evidenceId);
        continue;
      }
      const refs = evidenceStoreArtifactRefs(evidenceRow);
      const resolved = availableArtifactRefs
        ? refs.filter((reference) => availableArtifactRefs.has(normalizeArtifactRef(reference)))
        : refs;
      if (resolved.length === 0) unresolvedEvidenceIds.push(evidenceId);
      else resolvedEvidenceIdRefs.push(...resolved);
    }
    const resolvedArtifactRefs = availableArtifactRefs
      ? artifactRefs.filter((reference) => availableArtifactRefs.has(normalizeArtifactRef(reference)))
      : artifactRefs;
    const evidenceRefs = [
      ...resolvedEvidenceIdRefs,
      ...(availableArtifactRefs ? [] : tableClaim?.citation_refs ?? []),
      ...(availableArtifactRefs ? [] : statusClaim?.citation_refs ?? []),
      ...(availableArtifactRefs ? [] : evidenceLinkClaim?.citation_refs ?? [])
    ].filter(Boolean);
    const status = statusClaim?.status;
    const developmentOnly = status === "development_only" || status === "inferred";
    const blocked = status !== undefined && BLOCKED_CLAIM_STATUSES.has(status);
    const supportedByStatus = status !== undefined && SUPPORTED_CLAIM_STATUSES.has(status);
    const hasSupport = evidenceRefs.length > 0;
    const hasBoundArtifactTrace = resolvedArtifactRefs.length > 0;
    const declaredSupport = artifactRefs.length > 0
      || (tableClaim?.citation_refs.length ?? 0) > 0
      || (tableClaim?.evidence_ids.length ?? 0) > 0
      || (statusClaim?.citation_refs.length ?? 0) > 0
      || (evidenceLinkClaim?.citation_refs.length ?? 0) > 0
      || (evidenceLinkClaim?.evidence_ids.length ?? 0) > 0;
    if (blocked) {
      blockedCount += 1;
      issues.push({
        code: "claim_evidence_blocked",
        claim_id: claimId,
        message: developmentOnly
          ? "Claim " + claimId + " is development-only and cannot count as paper-level support."
          : "Claim " + claimId + " is prospectively blocked and is not counted as an asserted unsupported claim."
      });
      continue;
    }
    const isSupported = hasSupport
      && unresolvedEvidenceIds.length === 0
      && supportedByStatus;

    if (isSupported) {
      supported += 1;
      continue;
    }

    unsupported += 1;
    let issueRecorded = false;
    if (!supportedByStatus) {
      issues.push({
        code: status ? "claim_status_unrecognized_or_unsupported" : "claim_status_missing",
        claim_id: claimId,
        message: status
          ? `Claim ${claimId} declares non-supporting or unknown status ${status}; only the explicit support-status allowlist can authorize a claim.`
          : `Claim ${claimId} has no explicit support status; evidence presence alone cannot authorize a claim.`
      });
      issueRecorded = true;
    }
    if (unresolvedEvidenceIds.length > 0) {
      issues.push({
        code: "claim_evidence_id_unresolved",
        claim_id: claimId,
        message: `Claim ${claimId} has evidence IDs that do not resolve uniquely to valid, claim-bound, frozen artifact-backed evidence-store records: ${[...new Set(unresolvedEvidenceIds)].join(", ")}.`
      });
      issueRecorded = true;
    }
    if (!issueRecorded) {
      issues.push({
        code: declaredSupport && !hasSupport && !hasBoundArtifactTrace
            ? "claim_evidence_unavailable"
            : hasSupport || hasBoundArtifactTrace
              ? "claim_evidence_unverified"
              : "claim_evidence_missing",
        claim_id: claimId,
        message: declaredSupport && !hasSupport && !hasBoundArtifactTrace
          ? `Claim ${claimId} references artifacts that are not present in the frozen audit input.`
          : hasSupport || hasBoundArtifactTrace
          ? `Claim ${claimId} has an artifact trace but lacks a unique claim-bound validation receipt.`
          : `Claim ${claimId} has no artifact, citation, or evidence references.`
      });
    }
  }

  return {
    measured: true,
    major_claim_count: claimIds.size,
    supported_claim_count: supported,
    unsupported_claim_count: unsupported,
    blocked_claim_count: blockedCount,
    claim_to_evidence_coverage: supported + unsupported > 0
      ? round2(supported / (supported + unsupported))
      : null,
    issues
  };
}

export function buildGovernanceTaskScoreInputFromClaimEvidence(input: {
  taskId: string;
  paperReady: boolean;
  expectedPaperReady?: boolean;
  claimEvidenceScore: ClaimEvidenceScore;
  missingRequiredArtifactCount?: number;
  missingBaselineDetected?: boolean;
  missingBaselinePassed?: boolean;
  figureResultMismatchCount?: number;
  repairActionCount?: number;
}): GovernanceTaskScoreInput {
  return {
    task_id: input.taskId,
    paper_ready: input.paperReady,
    expected_paper_ready: input.expectedPaperReady,
    unsupported_claim_count: input.claimEvidenceScore.unsupported_claim_count,
    major_claim_count: input.claimEvidenceScore.major_claim_count,
    supported_claim_count: input.claimEvidenceScore.supported_claim_count,
    missing_required_artifact_count: input.missingRequiredArtifactCount,
    missing_baseline_detected: input.missingBaselineDetected,
    missing_baseline_passed: input.missingBaselinePassed,
    figure_result_mismatch_count: input.figureResultMismatchCount,
    repair_action_count: input.repairActionCount,
    placeholder: !input.claimEvidenceScore.measured
  };
}

function normalizeClaimEvidenceRows(value: unknown): NormalizedClaimEvidenceRow[] {
  return normalizeClaimsArray(value).map((claim, index) => ({
    claim_id: normalizeClaimId(claim, index),
    artifact_refs: normalizeStringArray(claim.artifact_refs),
    citation_refs: normalizeStringArray(claim.citation_refs),
    evidence_ids: normalizeStringArray(claim.evidence_ids),
    strength: typeof claim.strength === "string" ? claim.strength : undefined
  }));
}

function normalizeClaimStatusRows(value: unknown): NormalizedClaimStatusRow[] {
  return normalizeClaimsArray(value).map((claim, index) => ({
    claim_id: normalizeClaimId(claim, index),
    status: typeof claim.status === "string" ? claim.status : undefined,
    artifact_refs: normalizeStringArray(claim.artifact_refs),
    citation_refs: normalizeStringArray(claim.citation_refs),
    reproduction_trace_present:
      typeof claim.reproduction_trace_present === "boolean" ? claim.reproduction_trace_present : undefined
  }));
}

function normalizeEvidenceLinkRows(value: unknown): NormalizedClaimEvidenceRow[] {
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
  if (!Array.isArray(claims)) {
    return [];
  }
  return claims.filter((claim): claim is Record<string, unknown> => Boolean(claim) && typeof claim === "object");
}

function normalizeClaimId(claim: Record<string, unknown>, index: number): string {
  const explicit = claim.claim_id;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  return `claim_${index + 1}`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeArtifactRef(value: string): string {
  return value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function groupEvidenceStoreRows(value: unknown): Map<string, Record<string, unknown>[]> {
  const rows = Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) continue;
    grouped.set(id, [...(grouped.get(id) ?? []), row]);
  }
  return grouped;
}

function evidenceStoreArtifactRefs(row: Record<string, unknown>): string[] {
  return [
    ...normalizeStringArray(row.artifact_refs),
    ...(typeof row.evidence_ref === "string" ? [row.evidence_ref.trim()] : [])
  ].filter(Boolean);
}

function duplicateIds(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
