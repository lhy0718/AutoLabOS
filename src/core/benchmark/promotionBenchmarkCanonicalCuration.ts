import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { PromotionTrialCandidateRecord } from "./promotionBenchmarkTrialCandidateHandoff.js";
import { scoreClaimEvidenceArtifacts } from "./claimEvidenceScoring.js";
import { scoreResultTableArtifact } from "./resultTableScoring.js";
import { isSha256 } from "./promotionBenchmarkSourceDiversity.js";

export const PROMOTION_CANONICAL_CURATION_RECORD = "benchmark-curation.json";
export const PROMOTION_CANONICAL_CURATION_SCHEMA_VERSION = "1.1" as const;

export const PROMOTION_CANONICAL_ARTIFACT_PATHS = {
  result_table: "result_table.json",
  experiment_evidence: "experiment_evidence.json",
  run_config: "run_config.json",
  run_record: "run_record.json",
  evidence_store: "evidence_store.jsonl",
  design_contracts: "design_contracts.json",
  figure_audit: "figure_audit/figure_audit_summary.json",
  review_critique: "review/paper_critique.json",
  review_decision: "review/decision.json",
  paper_main: "paper/main.tex",
  paper_readiness: "paper/paper_readiness.json",
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
  schema_version: typeof PROMOTION_CANONICAL_CURATION_SCHEMA_VERSION;
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
  const artifactBytes = new Map<PromotionCanonicalArtifactRole, Buffer>();
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
      const bytes = await fs.readFile(artifactPath);
      if (sha256(bytes) !== artifact.sha256) {
        issues.push({
          code: "canonical_curation_artifact_hash_mismatch",
          message: "A hash-bound canonical artifact changed.",
          ref: artifact.role
        });
        continue;
      }
      artifactBytes.set(artifact.role, bytes);
      verifiedArtifactCount += 1;
    } catch {
      issues.push({
        code: "canonical_curation_artifact_unreadable",
        message: "A required canonical artifact is missing or unreadable.",
        ref: artifact.role
      });
    }
  }
  if (verifiedArtifactCount === Object.keys(PROMOTION_CANONICAL_ARTIFACT_PATHS).length) {
    issues.push(...inspectCanonicalArtifactSemantics(record, artifactBytes));
  }
  return {
    passed: issues.length === 0,
    record,
    record_sha256: sha256(bytes),
    verified_artifact_count: verifiedArtifactCount,
    issues
  };
}

function inspectCanonicalArtifactSemantics(
  record: PromotionCanonicalCurationRecord,
  artifacts: Map<PromotionCanonicalArtifactRole, Buffer>
): PromotionCanonicalCurationIssue[] {
  const issues: PromotionCanonicalCurationIssue[] = [];
  const json = new Map<PromotionCanonicalArtifactRole, unknown>();
  for (const role of Object.keys(PROMOTION_CANONICAL_ARTIFACT_PATHS) as PromotionCanonicalArtifactRole[]) {
    if (role === "evidence_store" || role === "paper_main") continue;
    const bytes = artifacts.get(role);
    if (!bytes) continue;
    try {
      json.set(role, JSON.parse(bytes.toString("utf8")) as unknown);
    } catch {
      issues.push({
        code: "canonical_curation_artifact_json_invalid",
        message: "Canonical JSON artifacts must contain parseable JSON.",
        ref: role
      });
    }
  }

  const resultTable = json.get("result_table");
  const resultScore = scoreResultTableArtifact(resultTable);
  const resultRows = Array.isArray(resultTable) ? resultTable : [];
  const deltaConsistent = resultRows.every((row) => {
    if (!isRecord(row)
        || !finiteNumber(row.baseline)
        || !finiteNumber(row.comparator)
        || !finiteNumber(row.delta)) return false;
    const expected = row.comparator - row.baseline;
    return Math.abs(expected - row.delta) <= 1e-9 * Math.max(1, Math.abs(expected), Math.abs(row.delta));
  });
  if (!resultScore.measured
      || !resultScore.valid_schema
      || resultScore.row_count === 0
      || resultScore.complete_row_count !== resultScore.row_count
      || resultScore.comparator_coverage !== 1
      || !deltaConsistent) {
    issues.push({
      code: "canonical_curation_result_table_invalid",
      message: "Canonical clean controls require complete comparator rows with arithmetically consistent deltas.",
      ref: PROMOTION_CANONICAL_ARTIFACT_PATHS.result_table
    });
  }

  const experimentEvidence = json.get("experiment_evidence");
  const trials = isRecord(experimentEvidence) && Array.isArray(experimentEvidence.trials)
    ? experimentEvidence.trials
    : [];
  const trialIds = trials.flatMap((trial) =>
    isRecord(trial) && validId(trial.trial_id) ? [trial.trial_id] : []);
  const expectedTrialIds = record.source_trials.map((trial) => trial.trial_id);
  if (trialIds.length !== trials.length
      || new Set(trialIds).size !== trialIds.length
      || !sameStringSet(trialIds, expectedTrialIds)) {
    issues.push({
      code: "canonical_curation_trial_evidence_invalid",
      message: "Experiment evidence must contain every bound primary and comparator source trial exactly once.",
      ref: PROMOTION_CANONICAL_ARTIFACT_PATHS.experiment_evidence
    });
  }

  const runConfig = json.get("run_config");
  const runRecord = json.get("run_record");
  const plannedTrials = nestedPositiveInteger(runConfig, "planned_budget", "trials");
  const executedTrials = nestedPositiveInteger(runRecord, "executed_budget", "trials");
  if (plannedTrials !== expectedTrialIds.length
      || executedTrials !== plannedTrials
      || !isRecord(runRecord)
      || !validId(runRecord.id)
      || runRecord.status !== "completed") {
    issues.push({
      code: "canonical_curation_run_contract_invalid",
      message: "The run record must identify a completed run whose planned and executed budgets cover all bound trials.",
      ref: `${PROMOTION_CANONICAL_ARTIFACT_PATHS.run_config} + ${PROMOTION_CANONICAL_ARTIFACT_PATHS.run_record}`
    });
  }

  const figureAudit = json.get("figure_audit");
  if (!isRecord(figureAudit)
      || !validTimestamp(figureAudit.audited_at)
      || !positiveInteger(figureAudit.figure_count)
      || !Array.isArray(figureAudit.issues)
      || figureAudit.issues.length !== 0
      || figureAudit.severe_mismatch_count !== 0
      || figureAudit.review_block_required !== false) {
    issues.push({
      code: "canonical_curation_figure_audit_invalid",
      message: "Canonical clean controls require a completed, issue-free figure audit with at least one figure.",
      ref: PROMOTION_CANONICAL_ARTIFACT_PATHS.figure_audit
    });
  }

  const claimStatus = json.get("claim_status");
  const claimEvidence = json.get("claim_evidence");
  const evidenceLinks = json.get("evidence_links");
  const claimScore = scoreClaimEvidenceArtifacts({
    claimStatusTableArtifact: claimStatus,
    claimEvidenceTableArtifact: claimEvidence,
    evidenceLinksArtifact: evidenceLinks
  });
  const statusRows = claimRows(claimStatus);
  const evidenceRows = claimRows(claimEvidence);
  const linkRows = claimRows(evidenceLinks);
  const claimIds = statusRows.map((row) => row.claim_id as string);
  const claimsConsistent = claimIds.length > 0
    && uniqueStringField(statusRows, "claim_id")
    && uniqueStringField(evidenceRows, "claim_id")
    && uniqueStringField(linkRows, "claim_id")
    && sameStringSet(claimIds, evidenceRows.map((row) => row.claim_id as string))
    && sameStringSet(claimIds, linkRows.map((row) => row.claim_id as string))
    && statusRows.every((row) => row.status === "verified"
      && row.reproduction_trace_present === true
      && stringArrayIncludes(row.artifact_refs, PROMOTION_CANONICAL_ARTIFACT_PATHS.result_table)
      && nonEmptyStringArray(row.citation_refs))
    && evidenceRows.every((row) =>
      stringArrayIncludes(row.artifact_refs, PROMOTION_CANONICAL_ARTIFACT_PATHS.result_table)
      && nonEmptyStringArray(row.citation_refs))
    && linkRows.every((row) => nonEmptyStringArray(row.evidence_ids)
      && nonEmptyStringArray(row.citation_paper_ids));
  if (!claimScore.measured
      || claimScore.unsupported_claim_count !== 0
      || claimScore.claim_to_evidence_coverage !== 1
      || !claimsConsistent) {
    issues.push({
      code: "canonical_curation_claim_evidence_invalid",
      message: "Canonical claims must be verified and exactly linked across status, evidence, citation, and reproduction records.",
      ref: "paper"
    });
  }

  const evidenceStoreIds = parseEvidenceStoreIds(artifacts.get("evidence_store"));
  const linkedEvidenceIds = linkRows.flatMap((row) =>
    Array.isArray(row.evidence_ids) ? row.evidence_ids.filter(nonEmptyString) : []);
  if (!evidenceStoreIds
      || linkedEvidenceIds.length === 0
      || linkedEvidenceIds.some((id) => !evidenceStoreIds.has(id))) {
    issues.push({
      code: "canonical_curation_evidence_store_invalid",
      message: "Every claim evidence ID must resolve to a unique metric-bearing evidence-store record.",
      ref: PROMOTION_CANONICAL_ARTIFACT_PATHS.evidence_store
    });
  }

  const checkpoint = json.get("readiness_state");
  const paperReadiness = json.get("paper_readiness");
  const reviewCritique = json.get("review_critique");
  const reviewDecision = json.get("review_decision");
  if (!isRecord(checkpoint)
      || checkpoint.paper_ready !== true
      || checkpoint.run_status !== "completed"
      || !isRecord(paperReadiness)
      || paperReadiness.paper_ready !== true
      || paperReadiness.readiness_state !== "paper_ready"
      || !isRecord(reviewCritique)
      || reviewCritique.paper_readiness_state !== "paper_ready"
      || reviewCritique.claim_ceiling_applied !== true
      || !isRecord(reviewDecision)
      || reviewDecision.outcome !== "accept") {
    issues.push({
      code: "canonical_curation_readiness_inconsistent",
      message: "Checkpoint, review, and paper readiness artifacts must agree on a completed clean-control promotion.",
      ref: "checkpoint + review + paper"
    });
  }

  const designContracts = json.get("design_contracts");
  if (!isRecord(designContracts)
      || typeof designContracts.sota_ranking_claimed !== "boolean"
      || typeof designContracts.sota_evidence_present !== "boolean"
      || (designContracts.sota_ranking_claimed && !designContracts.sota_evidence_present)) {
    issues.push({
      code: "canonical_curation_design_contract_invalid",
      message: "Canonical clean controls must explicitly bind whether any SOTA claim has supporting evidence.",
      ref: PROMOTION_CANONICAL_ARTIFACT_PATHS.design_contracts
    });
  }

  const paperMain = artifacts.get("paper_main")?.toString("utf8") || "";
  if (!/\\section\*?\{Results\}/u.test(paperMain)
      || /\b(?:TODO|TBD|placeholder)\b/iu.test(paperMain)) {
    issues.push({
      code: "canonical_curation_paper_artifact_invalid",
      message: "Canonical clean controls require a non-placeholder Results section.",
      ref: PROMOTION_CANONICAL_ARTIFACT_PATHS.paper_main
    });
  }

  if (Date.parse(record.curated_at) > Date.parse(record.verified_at)) {
    issues.push({
      code: "canonical_curation_timestamp_order_invalid",
      message: "Canonical curation must be verified at or after it was curated.",
      ref: PROMOTION_CANONICAL_CURATION_RECORD
    });
  }
  return issues;
}

function claimRows(value: unknown): Record<string, unknown>[] {
  return isRecord(value) && Array.isArray(value.claims)
    ? value.claims.filter(isRecord)
    : [];
}

function uniqueStringField(rows: Record<string, unknown>[], field: string): boolean {
  const values = rows.map((row) => row[field]);
  return rows.length > 0
    && values.every(nonEmptyString)
    && new Set(values).size === values.length;
}

function stringArrayIncludes(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.some((item) => item === expected);
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function parseEvidenceStoreIds(bytes: Buffer | undefined): Set<string> | null {
  if (!bytes) return null;
  const lines = bytes.toString("utf8").split(/\r?\n/u).filter((line) => line.trim());
  const ids = new Set<string>();
  try {
    for (const line of lines) {
      const row = JSON.parse(line) as unknown;
      if (!isRecord(row)
          || !validId(row.id)
          || row.metric_evidence_present !== true
          || ids.has(row.id)) return null;
      ids.add(row.id);
    }
  } catch {
    return null;
  }
  return ids.size > 0 ? ids : null;
}

function nestedPositiveInteger(value: unknown, parent: string, child: string): number | null {
  if (!isRecord(value) || !isRecord(value[parent])) return null;
  const nested = value[parent] as Record<string, unknown>;
  return positiveInteger(nested[child]) ? nested[child] : null;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.length === right.length
    && new Set(left).size === left.length
    && rightSet.size === right.length
    && left.every((value) => rightSet.has(value));
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parsePromotionCanonicalCurationRecord(value: unknown): PromotionCanonicalCurationRecord {
  if (!isRecord(value)
      || value.schema_version !== PROMOTION_CANONICAL_CURATION_SCHEMA_VERSION
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
