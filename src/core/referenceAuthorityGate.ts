import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash, verify as verifySignature } from "node:crypto";

import { parseReferenceClaimsTsv } from "./referenceClaimReview.js";

const HUMAN_AUTHORITY_RECEIPT = "reference-claim-review-import.json";

export interface ReferenceAuthorityGateArtifact {
  status: "pass" | "fail";
  status_ref: "paper/reference_evidence_status.json";
  claims_ref: "paper/refgate_claims.tsv";
  manuscript_ref: "paper/main.tex";
  human_authority_ref: "paper/reference-claim-review-import.json";
  status_present: boolean;
  claims_present: boolean;
  manuscript_present: boolean;
  manuscript_projection_present: boolean;
  manuscript_projection_valid: boolean;
  manuscript_bound: boolean;
  human_authority_required: boolean;
  human_authority_present: boolean;
  human_authority_valid: boolean;
  human_authority_artifacts_bound: boolean;
  human_identity_verification_valid: boolean;
  status_sha256: string | null;
  claims_sha256: string | null;
  manuscript_sha256: string | null;
  authoritative_manuscript_sha256: string | null;
  human_authority_sha256: string | null;
  submission_gate_passed: boolean;
  citation_bearing_claim_count: number | null;
  independently_checked_claim_count: number | null;
  inventory_claim_count: number | null;
  unchecked_claim_count: number | null;
  missing_full_text_claim_count: number | null;
  blocking_requirement_count: number | null;
  reason: string;
}

export interface ReferenceAuthorityTrustOptions {
  trusted_public_keys?: Record<string, string>;
}

export async function inspectReferenceAuthorityGate(
  paperDir: string,
  trustOptions: ReferenceAuthorityTrustOptions = {}
): Promise<ReferenceAuthorityGateArtifact> {
  const statusPath = path.join(paperDir, "reference_evidence_status.json");
  const claimsPath = path.join(paperDir, "refgate_claims.tsv");
  const manuscriptPath = path.join(paperDir, "main.tex");
  const humanAuthorityPath = path.join(paperDir, HUMAN_AUTHORITY_RECEIPT);
  const [statusText, claimsText, manuscriptText, humanAuthorityText] = await Promise.all([
    readText(statusPath),
    readText(claimsPath),
    readText(manuscriptPath),
    readText(humanAuthorityPath)
  ]);
  const status = parseJsonRecord(statusText);
  const summary = recordValue(status?.summary);
  const manuscriptProjection = recordValue(status?.manuscript_projection);
  const authoritativeManuscriptSha256 = sha256Value(manuscriptProjection?.package_content_sha256);
  const manuscriptProjectionPresent = manuscriptProjection !== null;
  const manuscriptProjectionValid = manuscriptProjectionPresent
    && manuscriptProjection?.package_ref === "paper/main.tex"
    && nonEmptyString(manuscriptProjection?.source_ref)
    && sha256Value(manuscriptProjection?.source_sha256) !== null
    && authoritativeManuscriptSha256 !== null;
  const manuscriptSha256 = manuscriptText === null ? null : sha256(manuscriptText);
  const manuscriptBound = manuscriptProjectionValid
    && manuscriptSha256 !== null
    && manuscriptSha256 === authoritativeManuscriptSha256;
  const citationBearingClaimCount = nonNegativeInteger(summary?.citation_bearing_claim_count);
  const independentlyCheckedClaimCount = nonNegativeInteger(summary?.independently_checked_claim_count);
  const missingFullTextClaimCount = nonNegativeInteger(summary?.missing_full_text_claim_count);
  const blockingRequirementsValid = Array.isArray(status?.blocking_requirements)
    && status.blocking_requirements.every((value) => nonEmptyString(value));
  const blockingRequirements = blockingRequirementsValid
    ? status?.blocking_requirements as string[]
    : null;

  let inventoryClaimCount: number | null = null;
  let uncheckedClaimCount: number | null = null;
  let inventoryError: string | null = null;
  if (claimsText !== null) {
    try {
      const claims = parseReferenceClaimsTsv(claimsText);
      inventoryClaimCount = claims.length;
      uncheckedClaimCount = claims.filter((claim) => claim.status !== "checked").length;
    } catch (error) {
      inventoryError = error instanceof Error ? error.message : String(error);
    }
  }

  const humanAuthorityRequired = (citationBearingClaimCount ?? inventoryClaimCount ?? 0) > 0;
  const humanAuthority = parseJsonRecord(humanAuthorityText);
  const authorityEvidence = recordValue(humanAuthority?.authority_evidence);
  const [packetManifestText, reviewText, preflightText, approvalText] = await Promise.all([
    readAuthorityEvidence(paperDir, authorityEvidence?.packet_manifest_ref),
    readAuthorityEvidence(paperDir, authorityEvidence?.review_ref),
    readAuthorityEvidence(paperDir, authorityEvidence?.preflight_report_ref),
    readAuthorityEvidence(paperDir, authorityEvidence?.approval_ref)
  ]);
  const packetManifest = parseJsonRecord(packetManifestText);
  const review = parseJsonRecord(reviewText);
  const preflight = parseJsonRecord(preflightText);
  const approval = parseJsonRecord(approvalText);
  const independenceAttestation = recordValue(review?.independence_attestation);
  const approvalAttestation = recordValue(approval?.approval_attestation);
  const humanAuthorityArtifactsBound = humanAuthority !== null
    && packetManifestText !== null
    && reviewText !== null
    && preflightText !== null
    && approvalText !== null
    && humanAuthority.packet_manifest_sha256 === sha256(packetManifestText)
    && humanAuthority.review_sha256 === sha256(reviewText)
    && humanAuthority.preflight_report_sha256 === sha256(preflightText)
    && humanAuthority.approval_sha256 === sha256(approvalText)
    && packetManifest?.handoff_id === humanAuthority.handoff_id
    && review?.handoff_id === humanAuthority.handoff_id
    && review?.reviewer_id === humanAuthority.reviewer_id
    && independenceAttestation?.completed_by_human === true
    && independenceAttestation?.reviewer_did_not_generate_evidence_candidates === true
    && independenceAttestation?.full_source_text_inspected === true
    && preflight?.handoff_id === humanAuthority.handoff_id
    && preflight?.reviewer_id === humanAuthority.reviewer_id
    && preflight?.preflight_passed === true
    && preflight?.claim_gate_passed === true
    && preflight?.review_sha256 === humanAuthority.review_sha256
    && approval?.handoff_id === humanAuthority.handoff_id
    && approval?.review_sha256 === humanAuthority.review_sha256
    && approval?.preflight_report_sha256 === humanAuthority.preflight_report_sha256
    && approval?.approver_id === humanAuthority.approver_id
    && approvalAttestation?.completed_by_human === true
    && approvalAttestation?.reviewed_complete_return === true
    && approvalAttestation?.approver_did_not_perform_initial_review === true
    && approvalAttestation?.authorizes_checked_status === true
    && approvalAttestation?.accepts_evidence_boundary === true;
  const humanIdentityVerification = recordValue(humanAuthority?.identity_verification);
  const trustedPublicKeys = resolveTrustedPublicKeys(trustOptions);
  const humanIdentityVerificationValid = verifyHumanIdentityBinding(
    humanAuthority,
    humanIdentityVerification,
    trustedPublicKeys
  );
  const humanAuthorityValid = !humanAuthorityRequired || (
    humanAuthority !== null
    && humanAuthority.schema_version === "1.0"
    && nonEmptyString(humanAuthority.reviewer_id)
    && nonEmptyString(humanAuthority.approver_id)
    && humanAuthority.reviewer_id !== humanAuthority.approver_id
    && sha256Value(humanAuthority.packet_manifest_sha256) !== null
    && sha256Value(humanAuthority.review_sha256) !== null
    && sha256Value(humanAuthority.preflight_report_sha256) !== null
    && sha256Value(humanAuthority.approval_sha256) !== null
    && sha256Value(humanAuthority.imported_claims_sha256) !== null
    && claimsText !== null
    && humanAuthority.imported_claims_sha256 === sha256(claimsText)
    && humanAuthority.reviewed_claim_count === citationBearingClaimCount
    && humanAuthority.checked_claim_count === citationBearingClaimCount
    && humanAuthority.remaining_unchecked_claim_count === 0
    && Array.isArray(humanAuthority.remaining_unchecked_claim_ids)
    && humanAuthority.remaining_unchecked_claim_ids.length === 0
    && humanAuthority.reviewed_claim_gate_passed === true
    && humanAuthority.submission_claim_gate_passed === true
    && humanAuthority.human_identity_verified === true
    && humanAuthority.source_claim_statuses_modified === false
    && humanAuthority.output_claim_statuses_updated === true
    && humanAuthorityArtifactsBound
    && humanIdentityVerificationValid
  );

  const statusPresent = statusText !== null;
  const statusValid = status !== null;
  const claimsPresent = claimsText !== null;
  const manuscriptPresent = manuscriptText !== null;
  const submissionGatePassed = status?.submission_gate_passed === true;
  const blockingRequirementCount = blockingRequirements?.length ?? null;
  const failures = [
    !statusPresent ? "authoritative reference evidence status is missing" : null,
    statusPresent && !statusValid ? "authoritative reference evidence status is malformed" : null,
    !claimsPresent ? "Refgate claim inventory is missing" : null,
    !manuscriptPresent ? "final manuscript is missing" : null,
    inventoryError ? `Refgate claim inventory is invalid: ${inventoryError}` : null,
    statusPresent && status?.schema_version !== "1.0" ? "reference evidence status schema is unsupported" : null,
    !manuscriptProjectionPresent ? "final manuscript projection is missing from the authoritative status" : null,
    manuscriptProjectionPresent && !manuscriptProjectionValid
      ? "final manuscript projection is invalid"
      : null,
    manuscriptProjectionValid && !manuscriptBound
      ? "final manuscript hash does not match the authoritative status"
      : null,
    humanAuthorityRequired && humanAuthorityText === null
      ? "hash-bound human reference-review import receipt is missing"
      : null,
    humanAuthorityRequired && humanAuthorityText !== null && !humanAuthorityValid
      ? "hash-bound human reference-review import receipt is invalid or does not bind the checked claim inventory"
      : null,
    humanAuthorityRequired && humanAuthorityText !== null && !humanIdentityVerificationValid
      ? "human reference-review identity lacks a trusted external signature"
      : null,
    !blockingRequirementsValid ? "reference blocking requirements are missing or invalid" : null,
    !submissionGatePassed ? "authoritative reference submission gate has not passed" : null,
    citationBearingClaimCount === null ? "citation-bearing claim count is missing" : null,
    independentlyCheckedClaimCount === null ? "independently checked claim count is missing" : null,
    missingFullTextClaimCount === null ? "missing full-text claim count is missing" : null,
    citationBearingClaimCount !== null
      && independentlyCheckedClaimCount !== citationBearingClaimCount
      ? "independent claim review is incomplete"
      : null,
    citationBearingClaimCount !== null
      && inventoryClaimCount !== citationBearingClaimCount
      ? "Refgate inventory count does not match the authoritative status"
      : null,
    uncheckedClaimCount !== null && uncheckedClaimCount > 0
      ? `${uncheckedClaimCount} Refgate claim(s) remain unchecked`
      : null,
    missingFullTextClaimCount !== null && missingFullTextClaimCount > 0
      ? `${missingFullTextClaimCount} citation-bearing claim(s) lack full text`
      : null,
    blockingRequirementCount !== null && blockingRequirementCount > 0
      ? `${blockingRequirementCount} reference blocking requirement(s) remain open`
      : null
  ].filter((value): value is string => Boolean(value));

  return {
    status: failures.length === 0 ? "pass" : "fail",
    status_ref: "paper/reference_evidence_status.json",
    claims_ref: "paper/refgate_claims.tsv",
    manuscript_ref: "paper/main.tex",
    human_authority_ref: "paper/reference-claim-review-import.json",
    status_present: statusPresent,
    claims_present: claimsPresent,
    manuscript_present: manuscriptPresent,
    manuscript_projection_present: manuscriptProjectionPresent,
    manuscript_projection_valid: manuscriptProjectionValid,
    manuscript_bound: manuscriptBound,
    human_authority_required: humanAuthorityRequired,
    human_authority_present: humanAuthorityText !== null,
    human_authority_valid: humanAuthorityValid,
    human_authority_artifacts_bound: humanAuthorityArtifactsBound,
    human_identity_verification_valid: humanIdentityVerificationValid,
    status_sha256: statusText === null ? null : sha256(statusText),
    claims_sha256: claimsText === null ? null : sha256(claimsText),
    manuscript_sha256: manuscriptSha256,
    authoritative_manuscript_sha256: authoritativeManuscriptSha256,
    human_authority_sha256: humanAuthorityText === null ? null : sha256(humanAuthorityText),
    submission_gate_passed: submissionGatePassed,
    citation_bearing_claim_count: citationBearingClaimCount,
    independently_checked_claim_count: independentlyCheckedClaimCount,
    inventory_claim_count: inventoryClaimCount,
    unchecked_claim_count: uncheckedClaimCount,
    missing_full_text_claim_count: missingFullTextClaimCount,
    blocking_requirement_count: blockingRequirementCount,
    reason: failures.length === 0
      ? "Every citation-bearing claim is independently checked and the authoritative reference submission gate passes."
      : failures.join("; ")
  };
}

async function readAuthorityEvidence(paperDir: string, value: unknown): Promise<string | null> {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\")) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  const candidate = path.resolve(paperDir, ...normalized.split("/"));
  const relative = path.relative(paperDir, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return await fs.readFile(candidate, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function resolveTrustedPublicKeys(
  options: ReferenceAuthorityTrustOptions
): Record<string, string> {
  if (options.trusted_public_keys) return options.trusted_public_keys;
  const encoded = process.env.AUTOLABOS_REFERENCE_AUTHORITY_PUBLIC_KEYS_JSON;
  if (!encoded) return {};
  try {
    const parsed = JSON.parse(encoded) as unknown;
    const record = recordValue(parsed);
    if (!record) return {};
    return Object.fromEntries(Object.entries(record).filter(
      (entry): entry is [string, string] => nonEmptyString(entry[0]) && nonEmptyString(entry[1])
    ));
  } catch {
    return {};
  }
}

function verifyHumanIdentityBinding(
  authority: Record<string, unknown> | null,
  identity: Record<string, unknown> | null,
  trustedPublicKeys: Record<string, string>
): boolean {
  if (!authority || !identity || authority.human_identity_verified !== true) return false;
  const keyId = identity.public_key_id;
  const signature = identity.signature_base64;
  if (identity.algorithm !== "ed25519"
      || !nonEmptyString(keyId)
      || !nonEmptyString(signature)
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(signature)) {
    return false;
  }
  const publicKey = trustedPublicKeys[keyId];
  if (!nonEmptyString(publicKey)) return false;
  const payload = humanIdentityPayload(authority);
  if (!payload || identity.signed_payload_sha256 !== sha256(payload)) return false;
  try {
    return verifySignature(
      null,
      Buffer.from(payload, "utf8"),
      publicKey,
      Buffer.from(signature, "base64")
    );
  } catch {
    return false;
  }
}

function humanIdentityPayload(authority: Record<string, unknown>): string | null {
  const fields = [
    "handoff_id",
    "reviewer_id",
    "approver_id",
    "packet_manifest_sha256",
    "review_sha256",
    "preflight_report_sha256",
    "approval_sha256",
    "imported_claims_sha256"
  ] as const;
  if (fields.some((field) => !nonEmptyString(authority[field]))) return null;
  return JSON.stringify(Object.fromEntries(fields.map((field) => [field, authority[field]])));
}

function parseJsonRecord(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return recordValue(value);
  } catch {
    return null;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Value(value: unknown): string | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}
