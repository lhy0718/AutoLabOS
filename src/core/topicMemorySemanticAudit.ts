import { hashCanonical } from "./canonicalHash.js";
import { parseStructuredModelJsonObject } from "./analysis/modelJson.js";
import {
  resolveHypothesisLlmIdentity,
  type HypothesisReviewBoundary,
  type ResolvedHypothesisLlmIdentity,
  type ResolvedTopicMemoryTransmissionPolicy
} from "./analysis/hypothesisReviewProvenance.js";
import type {
  TopicFormulationDescriptor,
  TopicKillRecord,
  TopicMemoryLedger
} from "./topicMemory.js";

export const TOPIC_MEMORY_SEMANTIC_AUDIT_SCHEMA_VERSION = 2 as const;
export const TOPIC_MEMORY_SEMANTIC_AUDIT_MAX_RECORDS_PER_CALL = 20;
export const TOPIC_MEMORY_SEMANTIC_AUDIT_MAX_CALLS = 10;
export const TOPIC_MEMORY_SEMANTIC_AUDIT_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT = [
  "You are an independent semantic identity auditor for research topics.",
  "Compare the proposed topic with every requested killed topic record.",
  "Treat paraphrases, synonyms, renamed identifiers, and wording changes as equivalent.",
  "Differences limited to dataset, evaluation, metric, or claim wording are not a material topic change.",
  "Mark a core axis distinct only when the contribution object or method mechanism genuinely changes.",
  "Return JSON only. Do not omit requested records."
].join(" ");

export type TopicMemoryCoreSemanticRelation =
  | "equivalent"
  | "distinct"
  | "uncertain";

export type TopicMemorySemanticRelation =
  | "same_research_object"
  | "materially_distinct"
  | "uncertain";

export interface TopicMemorySemanticComparison {
  prior_record_sha256: string;
  contribution_object_relation: TopicMemoryCoreSemanticRelation;
  method_mechanism_relation: TopicMemoryCoreSemanticRelation;
  relation: TopicMemorySemanticRelation;
  rationale: string;
}

export type TopicMemorySemanticAuditTransmissionMode =
  | "local_raw"
  | "blocked";

export interface TopicMemorySemanticAuditTransmission {
  reviewer_trust_class: ResolvedTopicMemoryTransmissionPolicy["reviewer_trust_class"];
  requested_payload_mode: ResolvedTopicMemoryTransmissionPolicy["payload_mode"];
  raw_descriptor_consent: boolean;
  policy_source: ResolvedTopicMemoryTransmissionPolicy["policy_source"];
  transmission_mode: TopicMemorySemanticAuditTransmissionMode;
  bound_audit_input_sha256: string;
  policy_binding_sha256: string;
}

export interface TopicMemorySemanticAuditInvocation {
  call_index: number;
  requested_record_sha256s: string[];
  reviewer: ResolvedHypothesisLlmIdentity;
  transmission_mode: "local_raw";
  payload_sha256: string;
  input_sha256: string;
  response_sha256: string;
  normalized_output_sha256: string;
  invocation_sha256: string;
}

export interface TopicMemorySemanticAudit {
  schema_version: typeof TOPIC_MEMORY_SEMANTIC_AUDIT_SCHEMA_VERSION;
  artifact_kind: "topic_memory_semantic_audit";
  ledger_sha256: string;
  proposed_descriptor_content_sha256: string;
  audit_input_sha256: string;
  transmission: TopicMemorySemanticAuditTransmission;
  proposer: ResolvedHypothesisLlmIdentity;
  reviewer: ResolvedHypothesisLlmIdentity;
  independence_class: "independent_review" | "self_review";
  review_complete: boolean;
  authorization_eligible: boolean;
  reason_codes: string[];
  comparisons: TopicMemorySemanticComparison[];
  reviewer_invocations: TopicMemorySemanticAuditInvocation[];
  content_sha256: string;
}

export interface TopicMemorySemanticAuditValidation {
  valid: boolean;
  reasons: string[];
  audit?: TopicMemorySemanticAudit;
}

export interface TopicMemorySemanticAuditEvaluation {
  valid: boolean;
  independently_reviewed: boolean;
  review_complete: boolean;
  materially_distinct_from_all: boolean;
  same_record_sha256s: string[];
  uncertain_record_sha256s: string[];
  reasons: string[];
  audit_sha256?: string;
}

interface SemanticAuditInputPayload {
  schema_version: 1;
  policy: "core_semantic_identity_v1";
  ledger_sha256: string;
  proposed_descriptor: TopicFormulationDescriptor;
  prior_records: Array<{
    record_sha256: string;
    kill_scope: TopicKillRecord["kill_scope"];
    disposition_category: TopicKillRecord["disposition_category"];
    descriptor: TopicFormulationDescriptor;
  }>;
}

interface RawSemanticComparison {
  prior_record_sha256?: unknown;
  contribution_object_relation?: unknown;
  method_mechanism_relation?: unknown;
  rationale?: unknown;
}

export async function runTopicMemorySemanticAudit(input: {
  boundary: HypothesisReviewBoundary;
  ledger: TopicMemoryLedger;
  descriptor: TopicFormulationDescriptor;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<TopicMemorySemanticAudit> {
  const payload = buildTopicMemorySemanticAuditInput(
    input.ledger,
    input.descriptor
  );
  const auditInputSha256 = hashCanonical(payload);
  const transmission = buildTopicMemorySemanticAuditTransmission(
    input.boundary.topicMemoryTransmissionPolicy,
    auditInputSha256,
    input.boundary.reviewer
  );
  const comparisons: TopicMemorySemanticComparison[] = [];
  const invocations: TopicMemorySemanticAuditInvocation[] = [];
  const reasonCodes = [...input.boundary.reason_codes];
  const partitions = partition(
    payload.prior_records,
    TOPIC_MEMORY_SEMANTIC_AUDIT_MAX_RECORDS_PER_CALL
  );

  if (transmission.transmission_mode === "blocked") {
    reasonCodes.push(transmissionBlockingReason(
      input.boundary.topicMemoryTransmissionPolicy
    ));
    comparisons.push(
      ...payload.prior_records.map((record) => uncertainComparison(
        record.record_sha256,
        "Topic-memory transmission was not authorized."
      ))
    );
  } else if (partitions.length > TOPIC_MEMORY_SEMANTIC_AUDIT_MAX_CALLS) {
    reasonCodes.push("topic_memory_semantic_audit_call_budget_exceeded");
    comparisons.push(
      ...payload.prior_records.map((record) => uncertainComparison(
        record.record_sha256,
        "Semantic audit call budget was exceeded."
      ))
    );
  } else {
    for (const [index, records] of partitions.entries()) {
      if (input.abortSignal?.aborted) {
        throw new Error("topic_memory_semantic_audit_aborted");
      }
      const callPayload: SemanticAuditInputPayload = {
        ...payload,
        prior_records: records
      };
      const prompt = buildTopicMemorySemanticAuditPrompt(callPayload);
      let responseText = "";
      let callComparisons: TopicMemorySemanticComparison[];
      let callReasons: string[] = [];
      try {
        const response = await completeWithTimeout({
          boundary: input.boundary,
          prompt,
          timeoutMs: input.timeoutMs
            ?? TOPIC_MEMORY_SEMANTIC_AUDIT_TIMEOUT_MS,
          abortSignal: input.abortSignal
        });
        responseText = response;
        const normalized = normalizeSemanticAuditResponse(
          response,
          records.map((record) => record.record_sha256)
        );
        callComparisons = normalized.comparisons;
        callReasons = normalized.reasons;
      } catch (error) {
        const reason = error instanceof Error
          ? error.message
          : "topic_memory_semantic_audit_llm_failure";
        if (reason === "topic_memory_semantic_audit_aborted") {
          throw error;
        }
        callReasons = [boundedReasonCode(reason)];
        callComparisons = records.map((record) => uncertainComparison(
          record.record_sha256,
          "Independent semantic review was unavailable."
        ));
      }
      reasonCodes.push(...callReasons);
      comparisons.push(...callComparisons);
      invocations.push(buildInvocation({
        callIndex: index + 1,
        reviewer: input.boundary.reviewer,
        requestedRecordSha256s: records.map((record) => record.record_sha256),
        callPayload,
        prompt,
        responseText,
        comparisons: callComparisons
      }));
      if (callReasons.length > 0) {
        const completed = new Set(
          comparisons.map((comparison) => comparison.prior_record_sha256)
        );
        comparisons.push(
          ...payload.prior_records
            .filter((record) => !completed.has(record.record_sha256))
            .map((record) => uncertainComparison(
              record.record_sha256,
              "Semantic audit stopped after an invalid reviewer response."
            ))
        );
        break;
      }
    }
  }

  const normalizedReasons = uniqueStrings(reasonCodes);
  const reviewComplete = normalizedReasons.length === 0
    && comparisons.length === payload.prior_records.length;
  const authorizationEligible =
    input.boundary.independence_class === "independent_review"
    && transmission.transmission_mode === "local_raw"
    && reviewComplete;
  const artifactPayload = {
    schema_version: TOPIC_MEMORY_SEMANTIC_AUDIT_SCHEMA_VERSION,
    artifact_kind: "topic_memory_semantic_audit" as const,
    ledger_sha256: payload.ledger_sha256,
    proposed_descriptor_content_sha256:
      payload.proposed_descriptor.content_sha256,
    audit_input_sha256: auditInputSha256,
    transmission,
    proposer: input.boundary.proposer,
    reviewer: input.boundary.reviewer,
    independence_class: input.boundary.independence_class,
    review_complete: reviewComplete,
    authorization_eligible: authorizationEligible,
    reason_codes: normalizedReasons,
    comparisons: orderComparisons(comparisons, payload.prior_records),
    reviewer_invocations: invocations
  };
  return {
    ...artifactPayload,
    content_sha256: hashCanonical(artifactPayload)
  };
}

export function evaluateTopicMemorySemanticAudit(
  value: unknown,
  ledger: TopicMemoryLedger,
  descriptor: TopicFormulationDescriptor
): TopicMemorySemanticAuditEvaluation {
  const validation = validateTopicMemorySemanticAudit(
    value,
    ledger,
    descriptor
  );
  if (!validation.valid || !validation.audit) {
    return {
      valid: false,
      independently_reviewed: false,
      review_complete: false,
      materially_distinct_from_all: false,
      same_record_sha256s: [],
      uncertain_record_sha256s: [],
      reasons: validation.reasons
    };
  }
  const audit = validation.audit;
  const same = audit.comparisons
    .filter((comparison) => comparison.relation === "same_research_object")
    .map((comparison) => comparison.prior_record_sha256);
  const uncertain = audit.comparisons
    .filter((comparison) => comparison.relation === "uncertain")
    .map((comparison) => comparison.prior_record_sha256);
  return {
    valid: true,
    independently_reviewed: audit.independence_class === "independent_review"
      && audit.authorization_eligible,
    review_complete: audit.review_complete,
    materially_distinct_from_all: same.length === 0 && uncertain.length === 0,
    same_record_sha256s: same,
    uncertain_record_sha256s: uncertain,
    reasons: [],
    audit_sha256: audit.content_sha256
  };
}

export function validateTopicMemorySemanticAudit(
  value: unknown,
  ledger: TopicMemoryLedger,
  descriptor: TopicFormulationDescriptor
): TopicMemorySemanticAuditValidation {
  if (!isRecord(value)) {
    return {
      valid: false,
      reasons: ["topic_memory_semantic_audit_missing"]
    };
  }
  const audit = value as unknown as TopicMemorySemanticAudit;
  const reasons: string[] = [];
  const expectedInput = buildTopicMemorySemanticAuditInput(ledger, descriptor);
  if (
    audit.schema_version !== TOPIC_MEMORY_SEMANTIC_AUDIT_SCHEMA_VERSION
    || audit.artifact_kind !== "topic_memory_semantic_audit"
  ) {
    reasons.push("topic_memory_semantic_audit_schema_invalid");
  }
  if (audit.ledger_sha256 !== ledger.ledger_sha256) {
    reasons.push("topic_memory_semantic_audit_ledger_mismatch");
  }
  if (
    audit.proposed_descriptor_content_sha256 !== descriptor.content_sha256
  ) {
    reasons.push("topic_memory_semantic_audit_descriptor_mismatch");
  }
  if (audit.audit_input_sha256 !== hashCanonical(expectedInput)) {
    reasons.push("topic_memory_semantic_audit_input_mismatch");
  }
  validateTopicMemorySemanticAuditTransmission(
    audit.transmission,
    hashCanonical(expectedInput),
    audit.reviewer,
    reasons
  );
  const proposer = validateStoredIdentity(audit.proposer);
  const reviewer = validateStoredIdentity(audit.reviewer);
  if (!proposer) {
    reasons.push("topic_memory_semantic_audit_proposer_identity_invalid");
  }
  if (!reviewer) {
    reasons.push("topic_memory_semantic_audit_reviewer_identity_invalid");
  }
  if (
    !proposer
    || !reviewer
    || proposer.identity_fingerprint_sha256
      === reviewer.identity_fingerprint_sha256
    || audit.independence_class !== "independent_review"
    || audit.authorization_eligible !== true
  ) {
    reasons.push("topic_memory_semantic_audit_not_independent");
  }
  if (audit.review_complete !== true) {
    reasons.push("topic_memory_semantic_audit_incomplete");
  }
  if (!Array.isArray(audit.reason_codes) || audit.reason_codes.length > 0) {
    reasons.push("topic_memory_semantic_audit_has_blocking_reasons");
  }
  const expectedHashes = expectedInput.prior_records.map(
    (record) => record.record_sha256
  );
  if (!Array.isArray(audit.comparisons)) {
    reasons.push("topic_memory_semantic_audit_comparisons_invalid");
  } else {
    const observedHashes = audit.comparisons.map(
      (comparison) => comparison.prior_record_sha256
    );
    if (!sameStrings(observedHashes, expectedHashes)) {
      reasons.push("topic_memory_semantic_audit_coverage_incomplete");
    }
    for (const comparison of audit.comparisons) {
      if (!validComparison(comparison)) {
        reasons.push("topic_memory_semantic_audit_comparison_invalid");
        break;
      }
    }
  }
  if (!Array.isArray(audit.reviewer_invocations)) {
    reasons.push("topic_memory_semantic_audit_invocations_invalid");
  } else {
    validateInvocations(
      audit.reviewer_invocations,
      audit.comparisons || [],
      expectedInput,
      audit.reviewer,
      reasons
    );
  }
  const { content_sha256: contentSha256, ...artifactPayload } = audit;
  if (
    !isSha256(contentSha256)
    || hashCanonical(artifactPayload) !== contentSha256
  ) {
    reasons.push("topic_memory_semantic_audit_content_hash_mismatch");
  }
  const uniqueReasons = uniqueStrings(reasons);
  return uniqueReasons.length > 0
    ? { valid: false, reasons: uniqueReasons }
    : { valid: true, reasons: [], audit: structuredClone(audit) };
}

export function buildTopicMemorySemanticAuditInput(
  ledger: TopicMemoryLedger,
  descriptor: TopicFormulationDescriptor
): SemanticAuditInputPayload {
  return {
    schema_version: 1,
    policy: "core_semantic_identity_v1",
    ledger_sha256: ledger.ledger_sha256,
    proposed_descriptor: descriptor,
    prior_records: ledger.records.map((record) => ({
      record_sha256: record.record_sha256,
      kill_scope: record.kill_scope,
      disposition_category: record.disposition_category,
      descriptor: record.descriptor
    }))
  };
}

export function buildTopicMemorySemanticAuditPrompt(
  payload: SemanticAuditInputPayload
): string {
  return [
    "Audit semantic topic identity for the following exact payload.",
    "For each requested prior record return contribution_object_relation and method_mechanism_relation as equivalent, distinct, or uncertain.",
    "Return {\"comparisons\":[{\"prior_record_sha256\":\"...\",\"contribution_object_relation\":\"equivalent|distinct|uncertain\",\"method_mechanism_relation\":\"equivalent|distinct|uncertain\",\"rationale\":\"...\"}]}.",
    JSON.stringify(payload)
  ].join("\n\n");
}

function buildTopicMemorySemanticAuditTransmission(
  policy: ResolvedTopicMemoryTransmissionPolicy,
  auditInputSha256: string,
  reviewer: ResolvedHypothesisLlmIdentity
): TopicMemorySemanticAuditTransmission {
  const transmissionWithoutBinding = {
    reviewer_trust_class: policy.reviewer_trust_class,
    requested_payload_mode: policy.payload_mode,
    raw_descriptor_consent: policy.raw_descriptor_consent,
    policy_source: policy.policy_source,
    transmission_mode: topicMemoryRawTransmissionAllowed(policy)
      ? "local_raw" as const
      : "blocked" as const,
    bound_audit_input_sha256: auditInputSha256
  };
  return {
    ...transmissionWithoutBinding,
    policy_binding_sha256: hashCanonical({
      ...transmissionWithoutBinding,
      reviewer_identity_fingerprint_sha256:
        reviewer.identity_fingerprint_sha256
    })
  };
}

function validateTopicMemorySemanticAuditTransmission(
  value: unknown,
  expectedAuditInputSha256: string,
  reviewer: unknown,
  reasons: string[]
): void {
  if (!isRecord(value)) {
    reasons.push("topic_memory_semantic_audit_transmission_missing");
    return;
  }
  const transmission = value as unknown as TopicMemorySemanticAuditTransmission;
  if (
    (transmission.reviewer_trust_class !== "local"
      && transmission.reviewer_trust_class !== "external"
      && transmission.reviewer_trust_class !== "unknown")
    || (transmission.requested_payload_mode !== "raw_descriptors"
      && transmission.requested_payload_mode !== "deny")
    || typeof transmission.raw_descriptor_consent !== "boolean"
    || (transmission.policy_source !== "caller_supplied"
      && transmission.policy_source !== "default_deny")
    || (transmission.transmission_mode !== "local_raw"
      && transmission.transmission_mode !== "blocked")
  ) {
    reasons.push("topic_memory_semantic_audit_transmission_policy_invalid");
    return;
  }
  if (
    transmission.policy_source === "default_deny"
    && (
      transmission.reviewer_trust_class !== "unknown"
      || transmission.requested_payload_mode !== "deny"
      || transmission.raw_descriptor_consent !== false
    )
  ) {
    reasons.push("topic_memory_semantic_audit_transmission_policy_invalid");
  }
  const expectedMode = topicMemoryRawTransmissionAllowed({
    reviewer_trust_class: transmission.reviewer_trust_class,
    payload_mode: transmission.requested_payload_mode,
    raw_descriptor_consent: transmission.raw_descriptor_consent
  })
    ? "local_raw"
    : "blocked";
  if (transmission.transmission_mode !== expectedMode) {
    reasons.push("topic_memory_semantic_audit_transmission_mode_mismatch");
  }
  if (transmission.bound_audit_input_sha256 !== expectedAuditInputSha256) {
    reasons.push("topic_memory_semantic_audit_payload_binding_mismatch");
  }
  const expectedBinding = hashCanonical({
    reviewer_trust_class: transmission.reviewer_trust_class,
    requested_payload_mode: transmission.requested_payload_mode,
    raw_descriptor_consent: transmission.raw_descriptor_consent,
    policy_source: transmission.policy_source,
    transmission_mode: transmission.transmission_mode,
    bound_audit_input_sha256: transmission.bound_audit_input_sha256,
    reviewer_identity_fingerprint_sha256:
      isRecord(reviewer)
        && typeof reviewer.identity_fingerprint_sha256 === "string"
        ? reviewer.identity_fingerprint_sha256
        : null
  });
  if (
    !isSha256(transmission.policy_binding_sha256)
    || transmission.policy_binding_sha256 !== expectedBinding
  ) {
    reasons.push("topic_memory_semantic_audit_policy_binding_mismatch");
  }
  if (transmission.transmission_mode !== "local_raw") {
    reasons.push("topic_memory_semantic_audit_transmission_not_authorized");
  }
}

function topicMemoryRawTransmissionAllowed(
  policy: Pick<
    ResolvedTopicMemoryTransmissionPolicy,
    "reviewer_trust_class" | "payload_mode" | "raw_descriptor_consent"
  >
): boolean {
  return policy.reviewer_trust_class === "local"
    && policy.payload_mode === "raw_descriptors"
    && policy.raw_descriptor_consent === true;
}

function transmissionBlockingReason(
  policy: ResolvedTopicMemoryTransmissionPolicy
): string {
  if (policy.policy_source === "default_deny") {
    return "topic_memory_semantic_audit_transmission_policy_missing";
  }
  if (
    policy.reviewer_trust_class === "external"
    && policy.payload_mode === "raw_descriptors"
  ) {
    return "topic_memory_semantic_audit_external_raw_dispatch_forbidden";
  }
  if (
    policy.reviewer_trust_class === "unknown"
    && policy.payload_mode === "raw_descriptors"
  ) {
    return "topic_memory_semantic_audit_unknown_raw_dispatch_forbidden";
  }
  if (policy.payload_mode === "deny") {
    return "topic_memory_semantic_audit_transmission_denied";
  }
  if (policy.raw_descriptor_consent !== true) {
    return "topic_memory_semantic_audit_raw_consent_missing";
  }
  return "topic_memory_semantic_audit_transmission_denied";
}

function validateInvocations(
  invocations: TopicMemorySemanticAuditInvocation[],
  comparisons: TopicMemorySemanticComparison[],
  input: SemanticAuditInputPayload,
  reviewer: ResolvedHypothesisLlmIdentity,
  reasons: string[]
): void {
  const covered: string[] = [];
  for (const [index, invocation] of invocations.entries()) {
    const requested = invocation.requested_record_sha256s;
    const records = requested.map((recordSha256) =>
      input.prior_records.find(
        (record) => record.record_sha256 === recordSha256
      )
    );
    const callComparisons = requested.map((recordSha256) =>
      comparisons.find(
        (comparison) => comparison.prior_record_sha256 === recordSha256
      )
    );
    if (
      invocation.call_index !== index + 1
      || !Array.isArray(requested)
      || requested.length === 0
      || requested.length > TOPIC_MEMORY_SEMANTIC_AUDIT_MAX_RECORDS_PER_CALL
      || records.some((record) => !record)
      || callComparisons.some((comparison) => !comparison)
      || invocation.reviewer.identity_fingerprint_sha256
        !== reviewer.identity_fingerprint_sha256
    ) {
      reasons.push("topic_memory_semantic_audit_invocation_shape_invalid");
      continue;
    }
    const callPayload: SemanticAuditInputPayload = {
      ...input,
      prior_records: records as SemanticAuditInputPayload["prior_records"]
    };
    const prompt = buildTopicMemorySemanticAuditPrompt(callPayload);
    const expectedPayload = {
      call_index: invocation.call_index,
      requested_record_sha256s: requested,
      reviewer: invocation.reviewer,
      transmission_mode: "local_raw" as const,
      payload_sha256: hashCanonical(callPayload),
      input_sha256: hashCanonical({
        system_prompt: SYSTEM_PROMPT,
        prompt
      }),
      response_sha256: invocation.response_sha256,
      normalized_output_sha256: hashCanonical({
        comparisons: callComparisons
      })
    };
    if (
      invocation.input_sha256 !== expectedPayload.input_sha256
      || invocation.transmission_mode !== "local_raw"
      || invocation.payload_sha256 !== expectedPayload.payload_sha256
      || invocation.normalized_output_sha256
        !== expectedPayload.normalized_output_sha256
      || !isSha256(invocation.response_sha256)
      || invocation.invocation_sha256 !== hashCanonical(expectedPayload)
    ) {
      reasons.push("topic_memory_semantic_audit_invocation_hash_invalid");
    }
    covered.push(...requested);
  }
  if (!sameStrings(covered, input.prior_records.map((record) => record.record_sha256))) {
    reasons.push("topic_memory_semantic_audit_invocation_coverage_incomplete");
  }
}

function buildInvocation(input: {
  callIndex: number;
  reviewer: ResolvedHypothesisLlmIdentity;
  requestedRecordSha256s: string[];
  callPayload: SemanticAuditInputPayload;
  prompt: string;
  responseText: string;
  comparisons: TopicMemorySemanticComparison[];
}): TopicMemorySemanticAuditInvocation {
  const payload = {
    call_index: input.callIndex,
    requested_record_sha256s: input.requestedRecordSha256s,
    reviewer: input.reviewer,
    transmission_mode: "local_raw" as const,
    payload_sha256: hashCanonical(input.callPayload),
    input_sha256: hashCanonical({
      system_prompt: SYSTEM_PROMPT,
      prompt: input.prompt
    }),
    response_sha256: hashCanonical(input.responseText),
    normalized_output_sha256: hashCanonical({
      comparisons: input.comparisons
    })
  };
  return {
    ...payload,
    invocation_sha256: hashCanonical(payload)
  };
}

function normalizeSemanticAuditResponse(
  text: string,
  expectedRecordSha256s: string[]
): { comparisons: TopicMemorySemanticComparison[]; reasons: string[] } {
  const parsed = parseStructuredModelJsonObject<{ comparisons?: unknown }>(
    text,
    {
      emptyError: "topic_memory_semantic_audit_response_empty",
      notFoundError: "topic_memory_semantic_audit_response_json_not_found",
      incompleteError: "topic_memory_semantic_audit_response_json_incomplete",
      invalidError: "topic_memory_semantic_audit_response_json_invalid"
    }
  ).value;
  if (!Array.isArray(parsed.comparisons)) {
    throw new Error("topic_memory_semantic_audit_comparisons_missing");
  }
  const grouped = new Map<string, RawSemanticComparison[]>();
  const expected = new Set(expectedRecordSha256s);
  const reasons: string[] = [];
  for (const raw of parsed.comparisons) {
    if (!isRecord(raw) || typeof raw.prior_record_sha256 !== "string") {
      reasons.push("topic_memory_semantic_audit_malformed_response");
      continue;
    }
    if (!expected.has(raw.prior_record_sha256)) {
      reasons.push("topic_memory_semantic_audit_invented_record");
      continue;
    }
    const rows = grouped.get(raw.prior_record_sha256) || [];
    rows.push(raw);
    grouped.set(raw.prior_record_sha256, rows);
  }
  const comparisons = expectedRecordSha256s.map((recordSha256) => {
    const rows = grouped.get(recordSha256) || [];
    if (rows.length !== 1) {
      reasons.push(rows.length === 0
        ? "topic_memory_semantic_audit_omitted_record"
        : "topic_memory_semantic_audit_duplicate_record");
      return uncertainComparison(
        recordSha256,
        rows.length === 0
          ? "The reviewer omitted this record."
          : "The reviewer returned duplicate judgments."
      );
    }
    const row = rows[0]!;
    const contribution = normalizeCoreRelation(
      row.contribution_object_relation
    );
    const method = normalizeCoreRelation(row.method_mechanism_relation);
    const rationale = normalizeText(row.rationale);
    if (!contribution || !method || !rationale) {
      reasons.push("topic_memory_semantic_audit_malformed_response");
      return uncertainComparison(
        recordSha256,
        "The reviewer returned an invalid semantic judgment."
      );
    }
    return {
      prior_record_sha256: recordSha256,
      contribution_object_relation: contribution,
      method_mechanism_relation: method,
      relation: deriveSemanticRelation(contribution, method),
      rationale
    };
  });
  return { comparisons, reasons: uniqueStrings(reasons) };
}

function validComparison(value: unknown): value is TopicMemorySemanticComparison {
  if (!isRecord(value)) {
    return false;
  }
  const contribution = normalizeCoreRelation(value.contribution_object_relation);
  const method = normalizeCoreRelation(value.method_mechanism_relation);
  const rationale = normalizeText(value.rationale);
  return isSha256(value.prior_record_sha256)
    && Boolean(contribution && method && rationale)
    && value.relation === deriveSemanticRelation(contribution!, method!);
}

function deriveSemanticRelation(
  contribution: TopicMemoryCoreSemanticRelation,
  method: TopicMemoryCoreSemanticRelation
): TopicMemorySemanticRelation {
  if (contribution === "distinct" || method === "distinct") {
    return "materially_distinct";
  }
  if (contribution === "equivalent" && method === "equivalent") {
    return "same_research_object";
  }
  return "uncertain";
}

function uncertainComparison(
  recordSha256: string,
  rationale: string
): TopicMemorySemanticComparison {
  return {
    prior_record_sha256: recordSha256,
    contribution_object_relation: "uncertain",
    method_mechanism_relation: "uncertain",
    relation: "uncertain",
    rationale
  };
}

function orderComparisons(
  comparisons: TopicMemorySemanticComparison[],
  records: SemanticAuditInputPayload["prior_records"]
): TopicMemorySemanticComparison[] {
  const byHash = new Map(
    comparisons.map((comparison) => [
      comparison.prior_record_sha256,
      comparison
    ] as const)
  );
  return records.map((record) => byHash.get(record.record_sha256)
    || uncertainComparison(record.record_sha256, "No judgment was available."));
}

async function completeWithTimeout(input: {
  boundary: HypothesisReviewBoundary;
  prompt: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.abortSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const completion = await input.boundary.reviewerLlm.complete(
      input.prompt,
      {
        systemPrompt: SYSTEM_PROMPT,
        abortSignal: controller.signal
      }
    );
    return completion.text;
  } catch (error) {
    if (input.abortSignal?.aborted) {
      throw new Error("topic_memory_semantic_audit_aborted");
    }
    if (controller.signal.aborted) {
      throw new Error("topic_memory_semantic_audit_timeout");
    }
    throw new Error("topic_memory_semantic_audit_llm_failure", {
      cause: error
    });
  } finally {
    clearTimeout(timer);
    input.abortSignal?.removeEventListener("abort", abort);
  }
}

function validateStoredIdentity(
  value: unknown
): ResolvedHypothesisLlmIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const resolved = resolveHypothesisLlmIdentity({
    identity: normalizeText(value.identity),
    backend: normalizeText(value.backend),
    provider: normalizeText(value.provider),
    model: normalizeText(value.model)
  });
  return resolved.identity_source === value.identity_source
    && resolved.identity_fingerprint_sha256
      === value.identity_fingerprint_sha256
    && resolved.identity_fingerprint_sha256
      ? resolved
      : undefined;
}

function normalizeCoreRelation(
  value: unknown
): TopicMemoryCoreSemanticRelation | undefined {
  return value === "equivalent" || value === "distinct" || value === "uncertain"
    ? value
    : undefined;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 400) : undefined;
}

function boundedReasonCode(value: string): string {
  const normalized = value.replace(/[^a-z0-9_:-]+/giu, "_").toLowerCase();
  return normalized.slice(0, 120) || "topic_memory_semantic_audit_failure";
}

function partition<T>(values: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    parts.push(values.slice(index, index + size));
  }
  return parts;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
