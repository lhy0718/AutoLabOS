import { createHash } from "node:crypto";

import { hashCanonical } from "./canonicalHash.js";

export const TOPIC_KILL_DISPOSITION_CATEGORIES = [
  "prior_work_absorbed",
  "scope_rejected",
  "feasibility_rejected",
  "evidence_rejected",
  "bounded_probe_rejected",
  "independent_review_rejected",
  "safety_or_policy_rejected",
  "superseded"
] as const;

export type TopicKillDispositionCategory =
  (typeof TOPIC_KILL_DISPOSITION_CATEGORIES)[number];

export const TOPIC_KILL_PUBLIC_REASON_CODES = [
  "baseline_fairness_invalid",
  "bounded_probe_effect_floor_not_met",
  "bounded_probe_evidence_invalid",
  "bounded_probe_hypothesis_not_supported",
  "closest_prior_absorbs_contribution",
  "comparison_design_invalid",
  "independent_review_rejected",
  "local_budget_infeasible",
  "minimum_evidence_unavailable",
  "novelty_not_defensible",
  "reproducibility_requirements_unmet",
  "safety_or_policy_blocked",
  "sampling_frame_invalid",
  "scientific_scope_mismatch",
  "superseded_by_canonical_candidate",
  "testable_question_missing"
] as const;

export type TopicKillPublicReasonCode =
  (typeof TOPIC_KILL_PUBLIC_REASON_CODES)[number];

export interface TopicKillRecordInput {
  statement: string;
  source_topic_content_sha256: string;
  disposition_category: TopicKillDispositionCategory;
  public_reason_codes: TopicKillPublicReasonCode[];
  source_run_id: string;
  source_research_cycle: number;
  source_bounded_outcome_content_sha256: string;
}

export interface TopicKillRecord {
  previous_ledger_sha256: string;
  candidate_statement_sha256: string;
  source_topic_content_sha256: string;
  disposition_category: TopicKillDispositionCategory;
  public_reason_codes: TopicKillPublicReasonCode[];
  source_run_id: string;
  source_research_cycle: number;
  source_bounded_outcome_content_sha256: string;
  record_sha256: string;
}

export interface TopicKillLedger {
  schema_version: 1;
  artifact_kind: "topic_kill_ledger";
  records: TopicKillRecord[];
  ledger_sha256: string;
}

export interface TopicKillLedgerValidationContext {
  expectedLedgerSha256?: string;
  expectedParentLedger?: unknown;
}

export interface TopicKillLedgerValidation {
  valid: boolean;
  reasons: string[];
  ledger?: TopicKillLedger;
}

export interface TopicKillBlockDecision {
  blocked: boolean;
  matched_by_statement: boolean;
  matched_by_source_topic_content: boolean;
  matching_record_sha256s: string[];
}

const LEDGER_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "records",
  "ledger_sha256"
]);

const RECORD_FIELDS = new Set([
  "previous_ledger_sha256",
  "candidate_statement_sha256",
  "source_topic_content_sha256",
  "disposition_category",
  "public_reason_codes",
  "source_run_id",
  "source_research_cycle",
  "source_bounded_outcome_content_sha256",
  "record_sha256"
]);

const RECORD_INPUT_FIELDS = new Set([
  "statement",
  "source_topic_content_sha256",
  "disposition_category",
  "public_reason_codes",
  "source_run_id",
  "source_research_cycle",
  "source_bounded_outcome_content_sha256"
]);

const DISPOSITION_CATEGORIES = new Set<string>(TOPIC_KILL_DISPOSITION_CATEGORIES);
const PUBLIC_REASON_CODES = new Set<string>(TOPIC_KILL_PUBLIC_REASON_CODES);

const REASONS_BY_DISPOSITION: Record<
  TopicKillDispositionCategory,
  ReadonlySet<TopicKillPublicReasonCode>
> = {
  prior_work_absorbed: new Set([
    "closest_prior_absorbs_contribution",
    "novelty_not_defensible"
  ]),
  scope_rejected: new Set([
    "scientific_scope_mismatch",
    "testable_question_missing"
  ]),
  feasibility_rejected: new Set([
    "local_budget_infeasible",
    "minimum_evidence_unavailable"
  ]),
  evidence_rejected: new Set([
    "baseline_fairness_invalid",
    "comparison_design_invalid",
    "minimum_evidence_unavailable",
    "reproducibility_requirements_unmet",
    "sampling_frame_invalid"
  ]),
  bounded_probe_rejected: new Set([
    "bounded_probe_effect_floor_not_met",
    "bounded_probe_evidence_invalid",
    "bounded_probe_hypothesis_not_supported"
  ]),
  independent_review_rejected: new Set([
    "independent_review_rejected"
  ]),
  safety_or_policy_rejected: new Set([
    "safety_or_policy_blocked"
  ]),
  superseded: new Set([
    "superseded_by_canonical_candidate"
  ])
};

export function normalizeTopicCandidateStatement(statement: string): string {
  if (typeof statement !== "string") {
    throw new Error("topic_kill_ledger_statement_invalid");
  }
  const normalized = statement
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (!normalized) {
    throw new Error("topic_kill_ledger_statement_missing");
  }
  return normalized;
}

export function fingerprintTopicCandidateStatement(statement: string): string {
  return sha256(normalizeTopicCandidateStatement(statement));
}

export function createTopicKillLedger(): TopicKillLedger {
  return buildLedger([]);
}

export function appendTopicKillLedger(
  parentValue: unknown,
  input: TopicKillRecordInput
): TopicKillLedger {
  const parent = requireValidTopicKillLedger(parentValue);
  const normalizedInput = requireRecordInput(input);
  const candidateStatementSha256 = fingerprintTopicCandidateStatement(
    normalizedInput.statement
  );
  assertNoIdentityConflict(parent.records, {
    candidateStatementSha256,
    sourceTopicContentSha256: normalizedInput.source_topic_content_sha256,
    sourceBoundedOutcomeContentSha256:
      normalizedInput.source_bounded_outcome_content_sha256
  });

  const recordPayload: Omit<TopicKillRecord, "record_sha256"> = {
    previous_ledger_sha256: parent.ledger_sha256,
    candidate_statement_sha256: candidateStatementSha256,
    source_topic_content_sha256: normalizedInput.source_topic_content_sha256,
    disposition_category: normalizedInput.disposition_category,
    public_reason_codes: normalizedInput.public_reason_codes,
    source_run_id: normalizedInput.source_run_id,
    source_research_cycle: normalizedInput.source_research_cycle,
    source_bounded_outcome_content_sha256:
      normalizedInput.source_bounded_outcome_content_sha256
  };
  const record: TopicKillRecord = {
    ...recordPayload,
    record_sha256: hashCanonical(recordPayload)
  };
  const ledger = buildLedger([...parent.records.map(cloneRecord), record]);
  const validation = validateTopicKillLedger(ledger, {
    expectedParentLedger: parent
  });
  if (!validation.valid) {
    throw new Error(`topic_kill_ledger_append_invalid:${validation.reasons.join(",")}`);
  }
  return ledger;
}

export function validateTopicKillLedger(
  rawValue: unknown,
  context: TopicKillLedgerValidationContext = {}
): TopicKillLedgerValidation {
  const parsed = parseUnknownJson(rawValue);
  if (!parsed.ok) {
    return { valid: false, reasons: [parsed.reason] };
  }
  const value = parsed.value;
  if (!isTopicKillLedgerShape(value)) {
    return { valid: false, reasons: ["topic_kill_ledger_schema_invalid"] };
  }

  const reasons: string[] = [];
  const seenStatementHashes = new Set<string>();
  const seenSourceHashes = new Set<string>();
  const seenOutcomeHashes = new Set<string>();
  const seenRecordHashes = new Set<string>();

  for (const [index, record] of value.records.entries()) {
    const { record_sha256: recordSha256, ...recordPayload } = record;
    if (hashCanonical(recordPayload) !== recordSha256) {
      reasons.push(`topic_kill_ledger_record_hash_mismatch:${index}`);
    }

    const expectedParentHash = hashLedgerRecords(value.records.slice(0, index));
    if (record.previous_ledger_sha256 !== expectedParentHash) {
      reasons.push(`topic_kill_ledger_previous_hash_mismatch:${index}`);
    }

    collectDuplicateReason(
      seenStatementHashes,
      record.candidate_statement_sha256,
      `topic_kill_ledger_duplicate_or_conflicting_statement:${index}`,
      reasons
    );
    collectDuplicateReason(
      seenSourceHashes,
      record.source_topic_content_sha256,
      `topic_kill_ledger_duplicate_or_conflicting_source_topic:${index}`,
      reasons
    );
    collectDuplicateReason(
      seenOutcomeHashes,
      record.source_bounded_outcome_content_sha256,
      `topic_kill_ledger_duplicate_or_conflicting_bounded_outcome:${index}`,
      reasons
    );
    collectDuplicateReason(
      seenRecordHashes,
      record.record_sha256,
      `topic_kill_ledger_duplicate_record_hash:${index}`,
      reasons
    );
  }

  const { ledger_sha256: ledgerSha256, ...ledgerPayload } = value;
  if (hashCanonical(ledgerPayload) !== ledgerSha256) {
    reasons.push("topic_kill_ledger_content_hash_mismatch");
  }

  if (context.expectedLedgerSha256 !== undefined) {
    if (!isSha256(context.expectedLedgerSha256)) {
      reasons.push("topic_kill_ledger_expected_hash_invalid");
    } else if (ledgerSha256 !== context.expectedLedgerSha256) {
      reasons.push("topic_kill_ledger_expected_hash_mismatch");
    }
  }

  if (context.expectedParentLedger !== undefined) {
    const parentValidation = validateTopicKillLedger(context.expectedParentLedger);
    const parent = parentValidation.ledger;
    if (!parentValidation.valid || !parent) {
      reasons.push("topic_kill_ledger_parent_invalid");
    } else {
      if (value.records.length !== parent.records.length + 1) {
        reasons.push("topic_kill_ledger_parent_append_count_mismatch");
      }
      const childPrefix = value.records.slice(0, parent.records.length);
      if (!canonicalValuesEqual(childPrefix, parent.records)) {
        reasons.push("topic_kill_ledger_parent_prefix_mismatch");
      }
      const appended = value.records[parent.records.length];
      if (!appended || appended.previous_ledger_sha256 !== parent.ledger_sha256) {
        reasons.push("topic_kill_ledger_parent_hash_mismatch");
      }
    }
  }

  const unique = uniqueStrings(reasons);
  return unique.length === 0
    ? { valid: true, reasons: [], ledger: cloneLedger(value) }
    : { valid: false, reasons: unique };
}

export function requireValidTopicKillLedger(value: unknown): TopicKillLedger {
  const validation = validateTopicKillLedger(value);
  if (!validation.valid || !validation.ledger) {
    throw new Error(`topic_kill_ledger_invalid:${validation.reasons.join(",")}`);
  }
  return validation.ledger;
}

export function topicKillLedgerBlocksStatement(
  ledgerValue: unknown,
  statement: string
): boolean {
  const ledger = requireValidTopicKillLedger(ledgerValue);
  const fingerprint = fingerprintTopicCandidateStatement(statement);
  return ledger.records.some(
    (record) => record.candidate_statement_sha256 === fingerprint
  );
}

export function topicKillLedgerBlocksSourceIdentity(
  ledgerValue: unknown,
  sourceTopicContentSha256: string
): boolean {
  const ledger = requireValidTopicKillLedger(ledgerValue);
  const sourceHash = requireSha256(
    sourceTopicContentSha256,
    "source_topic_content_sha256"
  );
  return ledger.records.some(
    (record) => record.source_topic_content_sha256 === sourceHash
  );
}

export function evaluateTopicKillLedgerBlock(
  ledgerValue: unknown,
  candidate: { statement: string; source_topic_content_sha256: string }
): TopicKillBlockDecision {
  if (
    !isRecord(candidate)
    || !hasExactFields(candidate, new Set(["statement", "source_topic_content_sha256"]))
  ) {
    throw new Error("topic_kill_ledger_block_candidate_schema_invalid");
  }
  const ledger = requireValidTopicKillLedger(ledgerValue);
  const statementHash = fingerprintTopicCandidateStatement(candidate.statement);
  const sourceHash = requireSha256(
    candidate.source_topic_content_sha256,
    "source_topic_content_sha256"
  );
  const statementMatches = ledger.records.filter(
    (record) => record.candidate_statement_sha256 === statementHash
  );
  const sourceMatches = ledger.records.filter(
    (record) => record.source_topic_content_sha256 === sourceHash
  );
  const matchingRecordSha256s = [...new Set([
    ...statementMatches.map((record) => record.record_sha256),
    ...sourceMatches.map((record) => record.record_sha256)
  ])].sort(compareStrings);
  return {
    blocked: matchingRecordSha256s.length > 0,
    matched_by_statement: statementMatches.length > 0,
    matched_by_source_topic_content: sourceMatches.length > 0,
    matching_record_sha256s: matchingRecordSha256s
  };
}

function buildLedger(records: TopicKillRecord[]): TopicKillLedger {
  const payload = {
    schema_version: 1 as const,
    artifact_kind: "topic_kill_ledger" as const,
    records: records.map(cloneRecord)
  };
  return {
    ...payload,
    ledger_sha256: hashCanonical(payload)
  };
}

function hashLedgerRecords(records: TopicKillRecord[]): string {
  return hashCanonical({
    schema_version: 1,
    artifact_kind: "topic_kill_ledger",
    records
  });
}

function requireRecordInput(input: TopicKillRecordInput): TopicKillRecordInput {
  if (!isRecord(input) || !hasExactFields(input, RECORD_INPUT_FIELDS)) {
    throw new Error("topic_kill_ledger_record_input_schema_invalid");
  }
  normalizeTopicCandidateStatement(input.statement);
  const sourceTopicContentSha256 = requireSha256(
    input.source_topic_content_sha256,
    "source_topic_content_sha256"
  );
  if (!isDispositionCategory(input.disposition_category)) {
    throw new Error("topic_kill_ledger_disposition_category_invalid");
  }
  const publicReasonCodes = requirePublicReasonCodes(
    input.disposition_category,
    input.public_reason_codes
  );
  const sourceRunId = requireRunId(input.source_run_id);
  if (!isNonNegativeInteger(input.source_research_cycle)) {
    throw new Error("topic_kill_ledger_source_research_cycle_invalid");
  }
  const sourceBoundedOutcomeContentSha256 = requireSha256(
    input.source_bounded_outcome_content_sha256,
    "source_bounded_outcome_content_sha256"
  );
  return {
    statement: input.statement,
    source_topic_content_sha256: sourceTopicContentSha256,
    disposition_category: input.disposition_category,
    public_reason_codes: publicReasonCodes,
    source_run_id: sourceRunId,
    source_research_cycle: input.source_research_cycle,
    source_bounded_outcome_content_sha256: sourceBoundedOutcomeContentSha256
  };
}

function requirePublicReasonCodes(
  disposition: TopicKillDispositionCategory,
  value: unknown
): TopicKillPublicReasonCode[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("topic_kill_ledger_public_reason_codes_invalid");
  }
  if (!value.every(isPublicReasonCode)) {
    throw new Error("topic_kill_ledger_public_reason_code_unknown");
  }
  if (new Set(value).size !== value.length) {
    throw new Error("topic_kill_ledger_public_reason_code_duplicate");
  }
  if (!value.every((reason) => REASONS_BY_DISPOSITION[disposition].has(reason))) {
    throw new Error("topic_kill_ledger_disposition_reason_conflict");
  }
  return [...value].sort(compareStrings);
}

function assertNoIdentityConflict(
  records: TopicKillRecord[],
  identity: {
    candidateStatementSha256: string;
    sourceTopicContentSha256: string;
    sourceBoundedOutcomeContentSha256: string;
  }
): void {
  if (
    records.some(
      (record) =>
        record.candidate_statement_sha256 === identity.candidateStatementSha256
        || record.source_topic_content_sha256 === identity.sourceTopicContentSha256
        || record.source_bounded_outcome_content_sha256
          === identity.sourceBoundedOutcomeContentSha256
    )
  ) {
    throw new Error("topic_kill_ledger_duplicate_or_conflicting_record");
  }
}

function isTopicKillLedgerShape(value: unknown): value is TopicKillLedger {
  return isRecord(value)
    && hasExactFields(value, LEDGER_FIELDS)
    && value.schema_version === 1
    && value.artifact_kind === "topic_kill_ledger"
    && Array.isArray(value.records)
    && value.records.every(isTopicKillRecordShape)
    && isSha256(value.ledger_sha256);
}

function isTopicKillRecordShape(value: unknown): value is TopicKillRecord {
  if (!isRecord(value) || !hasExactFields(value, RECORD_FIELDS)) {
    return false;
  }
  if (
    !isSha256(value.previous_ledger_sha256)
    || !isSha256(value.candidate_statement_sha256)
    || !isSha256(value.source_topic_content_sha256)
    || !isDispositionCategory(value.disposition_category)
    || !isCanonicalReasonCodeArray(value.disposition_category, value.public_reason_codes)
    || !isRunId(value.source_run_id)
    || !isNonNegativeInteger(value.source_research_cycle)
    || !isSha256(value.source_bounded_outcome_content_sha256)
    || !isSha256(value.record_sha256)
  ) {
    return false;
  }
  return true;
}

function isCanonicalReasonCodeArray(
  disposition: TopicKillDispositionCategory,
  value: unknown
): value is TopicKillPublicReasonCode[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || !value.every(isPublicReasonCode)
    || new Set(value).size !== value.length
    || !value.every((reason) => REASONS_BY_DISPOSITION[disposition].has(reason))
  ) {
    return false;
  }
  return value.every(
    (reason, index) => index === 0 || compareStrings(value[index - 1], reason) < 0
  );
}

function isDispositionCategory(value: unknown): value is TopicKillDispositionCategory {
  return typeof value === "string" && DISPOSITION_CATEGORIES.has(value);
}

function isPublicReasonCode(value: unknown): value is TopicKillPublicReasonCode {
  return typeof value === "string" && PUBLIC_REASON_CODES.has(value);
}

function requireRunId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!isRunId(normalized)) {
    throw new Error("topic_kill_ledger_source_run_id_invalid");
  }
  return normalized;
}

function isRunId(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function requireSha256(value: unknown, field: string): string {
  if (!isSha256(value)) {
    throw new Error(`topic_kill_ledger_${field}_invalid`);
  }
  return value;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(value: object, fields: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function parseUnknownJson(value: unknown):
  | { ok: true; value: unknown }
  | { ok: false; reason: string } {
  if (typeof value !== "string") {
    return { ok: true, value };
  }
  if (!value.trim()) {
    return { ok: false, reason: "topic_kill_ledger_missing" };
  }
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false, reason: "topic_kill_ledger_invalid_json" };
  }
}

function collectDuplicateReason(
  seen: Set<string>,
  value: string,
  reason: string,
  reasons: string[]
): void {
  if (seen.has(value)) {
    reasons.push(reason);
  }
  seen.add(value);
}

function cloneRecord(record: TopicKillRecord): TopicKillRecord {
  return {
    ...record,
    public_reason_codes: [...record.public_reason_codes]
  };
}

function cloneLedger(ledger: TopicKillLedger): TopicKillLedger {
  return {
    ...ledger,
    records: ledger.records.map(cloneRecord)
  };
}

function canonicalValuesEqual(left: unknown, right: unknown): boolean {
  return hashCanonical(left) === hashCanonical(right);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
