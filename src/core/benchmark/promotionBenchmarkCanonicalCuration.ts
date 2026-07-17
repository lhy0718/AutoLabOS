import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { PromotionTrialCandidateRecord } from "./promotionBenchmarkTrialCandidateHandoff.js";
import { isSha256 } from "./promotionBenchmarkSourceDiversity.js";

export const PROMOTION_CANONICAL_CURATION_RECORD = "benchmark-curation.json";

export const PROMOTION_CANONICAL_ARTIFACT_PATHS = {
  result_table: "result_table.json",
  experiment_evidence: "experiment_evidence.json",
  run_config: "run_config.json",
  run_record: "run_record.json",
  figure_audit: "figure_audit/figure_audit_summary.json",
  claim_status: "paper/claim_status_table.json",
  claim_evidence: "paper/claim_evidence_table.json",
  evidence_links: "paper/evidence_links.json",
  readiness_state: "checkpoint/state.json"
} as const;

export type PromotionCanonicalArtifactRole = keyof typeof PROMOTION_CANONICAL_ARTIFACT_PATHS;

export interface PromotionCanonicalCurationIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionCanonicalCurationRecord {
  schema_version: "1.0";
  provenance_class: "benchmark_curated";
  handoff_id: string;
  candidate_id: string;
  source_revision: string;
  base_candidate_sha256: string;
  curation_status: "human_verified";
  curator_id: string;
  verifier_id: string;
  curated_at: string;
  verified_at: string;
  curator_protocol_version: string;
  verifier_protocol_version: string;
  derivation_mode: "deterministic" | "human_authored";
  intended_readiness: "promote";
  evidence_ceiling: "paper_scale_candidate";
  source_trials: Array<{
    group_id: "group-a" | "group-b";
    trial_id: string;
    source_ref_sha256: string;
    source_blob_sha256: string;
    reviewer_blob_sha256: string;
  }>;
  artifacts: Array<{
    role: PromotionCanonicalArtifactRole;
    path: string;
    sha256: string;
  }>;
  evidence_boundary: string;
}

export interface InspectPromotionCanonicalCurationInput {
  sourceRoot: string;
  handoffId: string;
  sourceRevision: string;
  candidate: PromotionTrialCandidateRecord;
}

export interface PromotionCanonicalCurationInspection {
  passed: boolean;
  record: PromotionCanonicalCurationRecord | null;
  record_sha256: string | null;
  verified_artifact_count: number;
  issues: PromotionCanonicalCurationIssue[];
}

export async function inspectPromotionCanonicalCuration(
  input: InspectPromotionCanonicalCurationInput
): Promise<PromotionCanonicalCurationInspection> {
  const sourceRoot = path.resolve(input.sourceRoot);
  const canonicalSourceRoot = await fs.realpath(sourceRoot).catch(() => sourceRoot);
  const recordPath = path.join(sourceRoot, PROMOTION_CANONICAL_CURATION_RECORD);
  const issues: PromotionCanonicalCurationIssue[] = [];
  let bytes: Buffer;
  let record: PromotionCanonicalCurationRecord;
  try {
    const stat = await fs.lstat(recordPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error("invalid file");
    bytes = await fs.readFile(recordPath);
    record = parsePromotionCanonicalCurationRecord(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    return {
      passed: false,
      record: null,
      record_sha256: null,
      verified_artifact_count: 0,
      issues: [{
        code: "canonical_curation_record_unreadable",
        message: `Canonical sources require a valid ${PROMOTION_CANONICAL_CURATION_RECORD}.`
      }]
    };
  }

  if (record.handoff_id !== input.handoffId
      || record.candidate_id !== input.candidate.candidate_id
      || record.source_revision !== input.sourceRevision
      || record.base_candidate_sha256 !== input.candidate.base_candidate_sha256) {
    issues.push({
      code: "canonical_curation_candidate_identity_mismatch",
      message: "Canonical curation identity must match the inspected handoff candidate."
    });
  }
  if (record.curator_id === record.verifier_id) {
    issues.push({
      code: "canonical_curation_human_roles_not_independent",
      message: "Canonical curation requires distinct curator and verifier IDs."
    });
  }
  const expectedTrials = canonicalTrialBindings(input.candidate);
  if (JSON.stringify(sortedTrialBindings(record.source_trials))
      !== JSON.stringify(sortedTrialBindings(expectedTrials))) {
    issues.push({
      code: "canonical_curation_source_trace_mismatch",
      message: "Canonical curation must bind all six exact primary and comparator source traces."
    });
  }

  let verifiedArtifactCount = 0;
  for (const artifact of record.artifacts) {
    const expectedPath = PROMOTION_CANONICAL_ARTIFACT_PATHS[artifact.role];
    if (artifact.path !== expectedPath) {
      issues.push({
        code: "canonical_curation_artifact_path_mismatch",
        message: "Canonical artifact roles must use the benchmark mutation contract paths.",
        ref: artifact.role
      });
      continue;
    }
    const artifactPath = path.resolve(sourceRoot, artifact.path);
    const canonicalArtifactPath = await fs.realpath(artifactPath).catch(() => artifactPath);
    if (!isSameOrContainedPath(canonicalSourceRoot, canonicalArtifactPath)
        || artifactPath === recordPath) {
      issues.push({
        code: "canonical_curation_artifact_path_unsafe",
        message: "Canonical artifact references must stay inside the source bundle.",
        ref: artifact.role
      });
      continue;
    }
    try {
      const stat = await fs.lstat(artifactPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error("invalid file");
      if (sha256(await fs.readFile(artifactPath)) !== artifact.sha256) {
        issues.push({
          code: "canonical_curation_artifact_hash_mismatch",
          message: "A hash-bound canonical artifact changed.",
          ref: artifact.role
        });
        continue;
      }
      verifiedArtifactCount += 1;
    } catch {
      issues.push({
        code: "canonical_curation_artifact_unreadable",
        message: "A required canonical artifact is missing or unreadable.",
        ref: artifact.role
      });
    }
  }
  return {
    passed: issues.length === 0,
    record,
    record_sha256: sha256(bytes),
    verified_artifact_count: verifiedArtifactCount,
    issues
  };
}

function parsePromotionCanonicalCurationRecord(value: unknown): PromotionCanonicalCurationRecord {
  if (!isRecord(value)
      || value.schema_version !== "1.0"
      || value.provenance_class !== "benchmark_curated"
      || !validId(value.handoff_id)
      || !validId(value.candidate_id)
      || !nonEmptyString(value.source_revision)
      || !isSha256(value.base_candidate_sha256)
      || value.curation_status !== "human_verified"
      || !validId(value.curator_id)
      || !validId(value.verifier_id)
      || !validTimestamp(value.curated_at)
      || !validTimestamp(value.verified_at)
      || !nonEmptyString(value.curator_protocol_version)
      || !nonEmptyString(value.verifier_protocol_version)
      || (value.derivation_mode !== "deterministic" && value.derivation_mode !== "human_authored")
      || value.intended_readiness !== "promote"
      || value.evidence_ceiling !== "paper_scale_candidate"
      || !Array.isArray(value.source_trials)
      || value.source_trials.length !== 6
      || !Array.isArray(value.artifacts)
      || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Canonical curation record is invalid.");
  }
  const sourceTrials = value.source_trials.map(parseTrialBinding);
  if (new Set(sourceTrials.map((item) => item.trial_id)).size !== sourceTrials.length
      || sourceTrials.filter((item) => item.group_id === "group-a").length !== 3
      || sourceTrials.filter((item) => item.group_id === "group-b").length !== 3) {
    throw new Error("Canonical curation source-trial bindings are invalid.");
  }
  const artifacts = value.artifacts.map(parseArtifactBinding);
  const requiredRoles = Object.keys(PROMOTION_CANONICAL_ARTIFACT_PATHS).sort();
  if (artifacts.length !== requiredRoles.length
      || artifacts.map((item) => item.role).sort().join("\0") !== requiredRoles.join("\0")
      || new Set(artifacts.map((item) => item.path)).size !== artifacts.length) {
    throw new Error("Canonical curation artifact inventory is invalid.");
  }
  return {
    ...(value as unknown as PromotionCanonicalCurationRecord),
    source_trials: sourceTrials,
    artifacts
  };
}

function parseTrialBinding(value: unknown): PromotionCanonicalCurationRecord["source_trials"][number] {
  if (!isRecord(value)
      || (value.group_id !== "group-a" && value.group_id !== "group-b")
      || !validId(value.trial_id)
      || !isSha256(value.source_ref_sha256)
      || !isSha256(value.source_blob_sha256)
      || !isSha256(value.reviewer_blob_sha256)) {
    throw new Error("Canonical source-trial binding is invalid.");
  }
  return value as unknown as PromotionCanonicalCurationRecord["source_trials"][number];
}

function parseArtifactBinding(value: unknown): PromotionCanonicalCurationRecord["artifacts"][number] {
  if (!isRecord(value)
      || typeof value.role !== "string"
      || !Object.prototype.hasOwnProperty.call(PROMOTION_CANONICAL_ARTIFACT_PATHS, value.role)
      || !nonEmptyString(value.path)
      || path.isAbsolute(value.path)
      || !isSha256(value.sha256)) {
    throw new Error("Canonical artifact binding is invalid.");
  }
  return value as unknown as PromotionCanonicalCurationRecord["artifacts"][number];
}

function canonicalTrialBindings(
  candidate: PromotionTrialCandidateRecord
): PromotionCanonicalCurationRecord["source_trials"] {
  return [
    ...candidate.trials.map((trial) => ({
      group_id: "group-a" as const,
      trial_id: trial.trial_id,
      source_ref_sha256: trial.source_ref_sha256,
      source_blob_sha256: trial.source_blob_sha256,
      reviewer_blob_sha256: trial.reviewer_blob_sha256
    })),
    ...(candidate.comparator_trials || []).map((trial) => ({
      group_id: "group-b" as const,
      trial_id: trial.trial_id,
      source_ref_sha256: trial.source_ref_sha256,
      source_blob_sha256: trial.source_blob_sha256,
      reviewer_blob_sha256: trial.reviewer_blob_sha256
    }))
  ];
}

function sortedTrialBindings(
  trials: PromotionCanonicalCurationRecord["source_trials"]
): PromotionCanonicalCurationRecord["source_trials"] {
  return [...trials].sort((left, right) =>
    `${left.group_id}:${left.trial_id}`.localeCompare(`${right.group_id}:${right.trial_id}`));
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSameOrContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
