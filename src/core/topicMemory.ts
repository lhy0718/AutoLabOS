import { hashCanonical } from "./canonicalHash.js";
import {
  evaluateTopicMemorySemanticAudit,
  type TopicMemorySemanticAudit
} from "./topicMemorySemanticAudit.js";

export const TOPIC_MEMORY_AXES = [
  "contribution_object",
  "method_mechanism",
  "data_task_scope",
  "evaluation_protocol",
  "claim_ceiling"
] as const;
export const TOPIC_MEMORY_NEAR_LINEAGE_THRESHOLD = 0.42;

export type TopicMemoryAxis = (typeof TOPIC_MEMORY_AXES)[number];
export type TopicKillScope = "exact_formulation" | "topic_lineage";

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

export interface TopicFormulationSource {
  statement: string;
  gap_statement?: string;
  contribution_claim?: string;
  dataset_task_bench?: string;
  comparator?: string;
  primary_metric?: string;
  metric_unit?: string;
  meaningful_effect?: string;
  minimum_publishable_evidence?: string;
}

export interface TopicFormulationDescriptor {
  contribution_object: string;
  method_mechanism: string;
  data_task_scope: string;
  evaluation_protocol: string;
  claim_ceiling: string;
  lineage_sha256: string;
  formulation_sha256: string;
  content_sha256: string;
}

export interface TopicKillRecordInput {
  descriptor: TopicFormulationDescriptor;
  kill_scope: TopicKillScope;
  disposition_category: TopicKillDispositionCategory;
  public_reason_codes: TopicKillPublicReasonCode[];
  source_run_id: string;
  source_research_cycle: number;
  source_full_text_evidence_ids: string[];
  source_topic_content_sha256: string;
  source_decision_content_sha256: string;
}

export interface TopicKillRecord {
  previous_ledger_sha256: string;
  descriptor: TopicFormulationDescriptor;
  kill_scope: TopicKillScope;
  disposition_category: TopicKillDispositionCategory;
  public_reason_codes: TopicKillPublicReasonCode[];
  source_run_id: string;
  source_research_cycle: number;
  source_full_text_evidence_ids: string[];
  source_topic_content_sha256: string;
  source_decision_content_sha256: string;
  record_sha256: string;
}

export interface TopicMemoryLedger {
  schema_version: 2;
  artifact_kind: "topic_memory_ledger";
  records: TopicKillRecord[];
  ledger_sha256: string;
}

export interface TopicReentryAdjudication {
  prior_record_sha256: string;
  changed_axes: TopicMemoryAxis[];
}

export interface TopicReentryTicket {
  schema_version: 2;
  artifact_kind: "topic_reentry_ticket";
  proposed_formulation_sha256: string;
  ledger_head_sha256: string;
  issuer_id: string;
  decision_artifact_sha256: string;
  adjudications: TopicReentryAdjudication[];
  new_full_text_evidence_ids: string[];
  rationale: string;
  content_sha256: string;
}

export type TopicMemoryDecisionDisposition =
  | "clear"
  | "blocked"
  | "requires_reentry_adjudication"
  | "reentry_allowed";

export interface TopicMemoryDecision {
  disposition: TopicMemoryDecisionDisposition;
  blocked: boolean;
  exact_formulation_match: boolean;
  exact_lineage_match: boolean;
  near_lineage_match: boolean;
  matching_record_sha256s: string[];
  maximum_lineage_similarity: number;
  reason_codes: string[];
  accepted_reentry_ticket_sha256?: string;
  semantic_audit_required?: boolean;
  semantic_audit_valid?: boolean;
  semantic_lineage_match?: boolean;
  semantic_relation_uncertain?: boolean;
  accepted_semantic_audit_sha256?: string;
}

export interface TopicMemoryValidation {
  valid: boolean;
  reasons: string[];
  ledger?: TopicMemoryLedger;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DISPOSITION_CATEGORIES = new Set<string>(TOPIC_KILL_DISPOSITION_CATEGORIES);
const PUBLIC_REASON_CODES = new Set<string>(TOPIC_KILL_PUBLIC_REASON_CODES);
const AXES = new Set<string>(TOPIC_MEMORY_AXES);

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
  independent_review_rejected: new Set(["independent_review_rejected"]),
  safety_or_policy_rejected: new Set(["safety_or_policy_blocked"]),
  superseded: new Set(["superseded_by_canonical_candidate"])
};

export function buildTopicFormulationDescriptor(
  source: TopicFormulationSource
): TopicFormulationDescriptor {
  const contributionObject = requireText(
    source.contribution_claim || source.gap_statement || source.statement,
    "topic_memory_contribution_object_missing"
  );
  const methodMechanism = requireText(
    source.statement,
    "topic_memory_method_mechanism_missing"
  );
  const dataTaskScope = requireText(
    source.dataset_task_bench,
    "topic_memory_data_task_scope_missing"
  );
  const evaluationProtocol = requireText(
    [
      source.comparator,
      source.primary_metric,
      source.metric_unit,
      source.meaningful_effect
    ]
      .map(normalizeOptionalText)
      .filter((value): value is string => Boolean(value))
      .join(" | "),
    "topic_memory_evaluation_protocol_missing"
  );
  const claimCeiling = requireText(
    source.minimum_publishable_evidence,
    "topic_memory_claim_ceiling_missing"
  );
  const axes = {
    contribution_object: contributionObject,
    method_mechanism: methodMechanism,
    data_task_scope: dataTaskScope,
    evaluation_protocol: evaluationProtocol,
    claim_ceiling: claimCeiling
  };
  const lineageSha256 = hashCanonical({
    contribution_object: normalizeForIdentity(contributionObject),
    data_task_scope: normalizeForIdentity(dataTaskScope)
  });
  const formulationSha256 = hashCanonical(
    Object.fromEntries(
      TOPIC_MEMORY_AXES.map((axis) => [axis, normalizeForIdentity(axes[axis])])
    )
  );
  const payload = {
    ...axes,
    lineage_sha256: lineageSha256,
    formulation_sha256: formulationSha256
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function createTopicMemoryLedger(): TopicMemoryLedger {
  return buildLedger([]);
}

export function appendTopicKillRecord(
  parentValue: unknown,
  input: TopicKillRecordInput
): TopicMemoryLedger {
  const parent = requireValidTopicMemoryLedger(parentValue);
  const normalized = requireKillRecordInput(input);
  if (
    parent.records.some(
      (record) =>
        record.descriptor.formulation_sha256
          === normalized.descriptor.formulation_sha256
    )
  ) {
    throw new Error("topic_memory_duplicate_formulation");
  }
  if (
    parent.records.some(
      (record) =>
        record.source_topic_content_sha256
          === normalized.source_topic_content_sha256
    )
  ) {
    throw new Error("topic_memory_duplicate_source_topic");
  }
  if (
    parent.records.some(
      (record) =>
        record.source_decision_content_sha256
          === normalized.source_decision_content_sha256
    )
  ) {
    throw new Error("topic_memory_duplicate_source_decision");
  }

  const payload: Omit<TopicKillRecord, "record_sha256"> = {
    previous_ledger_sha256: parent.ledger_sha256,
    descriptor: cloneDescriptor(normalized.descriptor),
    kill_scope: normalized.kill_scope,
    disposition_category: normalized.disposition_category,
    public_reason_codes: [...normalized.public_reason_codes],
    source_run_id: normalized.source_run_id,
    source_research_cycle: normalized.source_research_cycle,
    source_full_text_evidence_ids: [
      ...normalized.source_full_text_evidence_ids
    ],
    source_topic_content_sha256: normalized.source_topic_content_sha256,
    source_decision_content_sha256: normalized.source_decision_content_sha256
  };
  const record = {
    ...payload,
    record_sha256: hashCanonical(payload)
  };
  const ledger = buildLedger([...parent.records, record]);
  const validation = validateTopicMemoryLedger(ledger, {
    expectedParentLedger: parent
  });
  if (!validation.valid) {
    throw new Error(`topic_memory_append_invalid:${validation.reasons.join(",")}`);
  }
  return ledger;
}

export function buildTopicReentryTicket(input: {
  priorRecordSha256: string;
  changedAxes: TopicMemoryAxis[];
  additionalRecordAdjudications?: Array<{
    priorRecordSha256: string;
    changedAxes: TopicMemoryAxis[];
  }>;
  newFullTextEvidenceIds: string[];
  proposedFormulationSha256: string;
  ledgerHeadSha256: string;
  issuerId: string;
  decisionArtifactSha256: string;
  rationale: string;
}): TopicReentryTicket {
  const adjudications = requireReentryAdjudications([
    {
      priorRecordSha256: input.priorRecordSha256,
      changedAxes: input.changedAxes
    },
    ...(input.additionalRecordAdjudications || [])
  ]);
  const payload = {
    schema_version: 2 as const,
    artifact_kind: "topic_reentry_ticket" as const,
    proposed_formulation_sha256: requireSha256(
      input.proposedFormulationSha256,
      "topic_reentry_proposed_formulation_sha256_invalid"
    ),
    ledger_head_sha256: requireSha256(
      input.ledgerHeadSha256,
      "topic_reentry_ledger_head_sha256_invalid"
    ),
    issuer_id: requireIssuerId(input.issuerId),
    decision_artifact_sha256: requireSha256(
      input.decisionArtifactSha256,
      "topic_reentry_decision_artifact_sha256_invalid"
    ),
    adjudications,
    new_full_text_evidence_ids: requireEvidenceIds(
      input.newFullTextEvidenceIds
    ),
    rationale: requireText(
      input.rationale,
      "topic_reentry_rationale_missing"
    )
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function evaluateTopicMemory(
  ledgerValue: unknown,
  descriptorValue: TopicFormulationDescriptor,
  reentryTicket?: TopicReentryTicket,
  semanticAudit?: TopicMemorySemanticAudit
): TopicMemoryDecision {
  const ledger = requireValidTopicMemoryLedger(ledgerValue);
  const descriptor = requireDescriptor(descriptorValue);
  const scored = ledger.records
    .map((record) => ({
      record,
      similarity: topicLineageSimilarity(record.descriptor, descriptor),
      near: isNearTopicLineage(record.descriptor, descriptor)
    }))
    .filter(
      ({ record, near }) =>
        record.descriptor.lineage_sha256 === descriptor.lineage_sha256
        || record.descriptor.formulation_sha256
          === descriptor.formulation_sha256
        || near
    )
    .sort((left, right) => {
      if (left.similarity !== right.similarity) {
        return right.similarity - left.similarity;
      }
      return left.record.record_sha256.localeCompare(right.record.record_sha256);
    });
  if (scored.length === 0) {
    if (ledger.records.length === 0) {
      return clearDecision();
    }
    return evaluateSemanticTopicMemoryDecision({
      ledger,
      descriptor,
      semanticAudit,
      reentryTicket,
      scored
    });
  }

  const exactFormulation = scored.filter(
    ({ record }) =>
      record.descriptor.formulation_sha256
        === descriptor.formulation_sha256
  );
  const exactLineage = scored.filter(
    ({ record }) =>
      record.descriptor.lineage_sha256 === descriptor.lineage_sha256
  );
  const maximumSimilarity = Math.max(...scored.map((item) => item.similarity));
  const matchingHashes = scored.map((item) => item.record.record_sha256);

  if (exactFormulation.length > 0) {
    return {
      disposition: "blocked",
      blocked: true,
      exact_formulation_match: true,
      exact_lineage_match: exactLineage.length > 0,
      near_lineage_match: false,
      matching_record_sha256s: matchingHashes,
      maximum_lineage_similarity: maximumSimilarity,
      reason_codes: ["topic_memory_exact_formulation_killed"]
    };
  }

  const blockingLineageRecords = exactLineage.filter(
    ({ record }) => record.kill_scope === "topic_lineage"
  );
  if (
    reentryTicket
    && validateTopicReentryTicket(
      reentryTicket,
      scored.map(({ record }) => record),
      descriptor,
      { expectedLedgerHeadSha256: ledger.ledger_sha256 }
    ).valid
  ) {
    return {
      disposition: "reentry_allowed",
      blocked: false,
      exact_formulation_match: false,
      exact_lineage_match: exactLineage.length > 0,
      near_lineage_match: exactLineage.length === 0,
      matching_record_sha256s: matchingHashes,
      maximum_lineage_similarity: maximumSimilarity,
      reason_codes: ["topic_memory_reentry_ticket_accepted"],
      accepted_reentry_ticket_sha256: reentryTicket.content_sha256
    };
  }

  if (blockingLineageRecords.length > 0 && !reentryTicket) {
    return {
      disposition: "blocked",
      blocked: true,
      exact_formulation_match: false,
      exact_lineage_match: true,
      near_lineage_match: false,
      matching_record_sha256s: matchingHashes,
      maximum_lineage_similarity: maximumSimilarity,
      reason_codes: ["topic_memory_lineage_scope_killed"]
    };
  }

  return evaluateSemanticTopicMemoryDecision({
    ledger,
    descriptor,
    semanticAudit,
    reentryTicket,
    scored
  });
}

function evaluateSemanticTopicMemoryDecision(input: {
  ledger: TopicMemoryLedger;
  descriptor: TopicFormulationDescriptor;
  semanticAudit?: TopicMemorySemanticAudit;
  reentryTicket?: TopicReentryTicket;
  scored: Array<{
    record: TopicKillRecord;
    similarity: number;
    near: boolean;
  }>;
}): TopicMemoryDecision {
  const exactLineage = input.scored.filter(
    ({ record }) =>
      record.descriptor.lineage_sha256 === input.descriptor.lineage_sha256
  );
  const maximumSimilarity = input.scored.length > 0
    ? Math.max(...input.scored.map((item) => item.similarity))
    : 0;
  const lexicalMatches = input.scored.map(
    ({ record }) => record.record_sha256
  );
  const semantic = evaluateTopicMemorySemanticAudit(
    input.semanticAudit,
    input.ledger,
    input.descriptor
  );
  if (
    !semantic.valid
    || !semantic.independently_reviewed
    || !semantic.review_complete
  ) {
    return {
      disposition: input.scored.length > 0
        ? "requires_reentry_adjudication"
        : "blocked",
      blocked: true,
      exact_formulation_match: false,
      exact_lineage_match: exactLineage.length > 0,
      near_lineage_match:
        input.scored.length > 0 && exactLineage.length === 0,
      matching_record_sha256s: lexicalMatches,
      maximum_lineage_similarity: maximumSimilarity,
      reason_codes: uniqueStrings([
        ...(input.reentryTicket
          ? ["topic_memory_reentry_ticket_invalid"]
          : []),
        input.semanticAudit
          ? "topic_memory_semantic_audit_invalid"
          : "topic_memory_semantic_audit_required",
        ...semantic.reasons
      ]),
      semantic_audit_required: true,
      semantic_audit_valid: false,
      semantic_lineage_match: false,
      semantic_relation_uncertain: false
    };
  }
  const semanticMatches = uniqueStrings([
    ...semantic.same_record_sha256s,
    ...semantic.uncertain_record_sha256s
  ]);
  if (!semantic.materially_distinct_from_all) {
    return {
      disposition: "requires_reentry_adjudication",
      blocked: true,
      exact_formulation_match: false,
      exact_lineage_match: exactLineage.length > 0,
      near_lineage_match:
        input.scored.length > 0 && exactLineage.length === 0,
      matching_record_sha256s: semanticMatches,
      maximum_lineage_similarity: maximumSimilarity,
      reason_codes: uniqueStrings([
        ...(input.reentryTicket
          ? ["topic_memory_reentry_ticket_invalid"]
          : []),
        ...(semantic.same_record_sha256s.length > 0
          ? ["topic_memory_semantic_lineage_requires_ticket"]
          : []),
        ...(semantic.uncertain_record_sha256s.length > 0
          ? ["topic_memory_semantic_relation_uncertain"]
          : [])
      ]),
      semantic_audit_required: true,
      semantic_audit_valid: true,
      semantic_lineage_match: semantic.same_record_sha256s.length > 0,
      semantic_relation_uncertain:
        semantic.uncertain_record_sha256s.length > 0,
      accepted_semantic_audit_sha256: semantic.audit_sha256
    };
  }
  return {
    ...clearDecision(),
    exact_lineage_match: exactLineage.length > 0,
    near_lineage_match:
      input.scored.length > 0 && exactLineage.length === 0,
    maximum_lineage_similarity: maximumSimilarity,
    semantic_audit_required: true,
    semantic_audit_valid: true,
    semantic_lineage_match: false,
    semantic_relation_uncertain: false,
    accepted_semantic_audit_sha256: semantic.audit_sha256
  };
}

export function validateTopicMemoryLedger(
  rawValue: unknown,
  context: {
    expectedLedgerSha256?: string;
    expectedParentLedger?: unknown;
  } = {}
): TopicMemoryValidation {
  const value = parseJsonValue(rawValue);
  if (!isTopicMemoryLedgerShape(value)) {
    return { valid: false, reasons: ["topic_memory_ledger_schema_invalid"] };
  }
  const reasons: string[] = [];
  const formulationHashes = new Set<string>();
  const sourceTopicHashes = new Set<string>();
  const sourceDecisionHashes = new Set<string>();

  for (const [index, record] of value.records.entries()) {
    const descriptorValidation = validateDescriptor(record.descriptor);
    reasons.push(
      ...descriptorValidation.reasons.map(
        (reason) => `${reason}:${index}`
      )
    );
    try {
      const normalized = requireKillRecordInput(record);
      if (
        JSON.stringify(record.public_reason_codes)
          !== JSON.stringify(normalized.public_reason_codes)
      ) {
        reasons.push(`topic_memory_reason_codes_noncanonical:${index}`);
      }
      if (
        JSON.stringify(record.source_full_text_evidence_ids)
          !== JSON.stringify(normalized.source_full_text_evidence_ids)
      ) {
        reasons.push(
          `topic_memory_source_full_text_evidence_noncanonical:${index}`
        );
      }
    } catch (error) {
      reasons.push(
        `${error instanceof Error
          ? error.message
          : "topic_memory_record_semantics_invalid"}:${index}`
      );
    }
    const { record_sha256: recordSha256, ...payload } = record;
    if (hashCanonical(payload) !== recordSha256) {
      reasons.push(`topic_memory_record_hash_mismatch:${index}`);
    }
    const expectedPrevious = buildLedger(value.records.slice(0, index))
      .ledger_sha256;
    if (record.previous_ledger_sha256 !== expectedPrevious) {
      reasons.push(`topic_memory_previous_hash_mismatch:${index}`);
    }
    collectDuplicate(
      formulationHashes,
      record.descriptor.formulation_sha256,
      `topic_memory_duplicate_formulation:${index}`,
      reasons
    );
    collectDuplicate(
      sourceTopicHashes,
      record.source_topic_content_sha256,
      `topic_memory_duplicate_source_topic:${index}`,
      reasons
    );
    collectDuplicate(
      sourceDecisionHashes,
      record.source_decision_content_sha256,
      `topic_memory_duplicate_source_decision:${index}`,
      reasons
    );
  }
  const { ledger_sha256: ledgerSha256, ...payload } = value;
  if (hashCanonical(payload) !== ledgerSha256) {
    reasons.push("topic_memory_ledger_hash_mismatch");
  }
  if (
    context.expectedLedgerSha256
    && (
      !SHA256_PATTERN.test(context.expectedLedgerSha256)
      || context.expectedLedgerSha256 !== ledgerSha256
    )
  ) {
    reasons.push("topic_memory_expected_ledger_hash_mismatch");
  }
  if (context.expectedParentLedger !== undefined) {
    const parentValidation = validateTopicMemoryLedger(
      context.expectedParentLedger
    );
    const parent = parentValidation.ledger;
    if (!parentValidation.valid || !parent) {
      reasons.push("topic_memory_parent_invalid");
    } else if (
      value.records.length !== parent.records.length + 1
      || hashCanonical(value.records.slice(0, parent.records.length))
        !== hashCanonical(parent.records)
    ) {
      reasons.push("topic_memory_parent_prefix_mismatch");
    }
  }
  const unique = uniqueStrings(reasons);
  return unique.length > 0
    ? { valid: false, reasons: unique }
    : { valid: true, reasons: [], ledger: cloneLedger(value) };
}

export function requireValidTopicMemoryLedger(
  value: unknown
): TopicMemoryLedger {
  const validation = validateTopicMemoryLedger(value);
  if (!validation.valid || !validation.ledger) {
    throw new Error(`topic_memory_ledger_invalid:${validation.reasons.join(",")}`);
  }
  return validation.ledger;
}

export function validateTopicReentryTicket(
  ticketValue: unknown,
  priorRecordValue: TopicKillRecord | readonly TopicKillRecord[],
  proposedDescriptor: TopicFormulationDescriptor,
  context: {
    expectedLedgerHeadSha256?: string;
    expectedIssuerId?: string;
    expectedDecisionArtifactSha256?: string;
  } = {}
): { valid: boolean; reasons: string[] } {
  const ticket = parseJsonValue(ticketValue);
  const reasons: string[] = [];
  if (!isTopicReentryTicketShape(ticket)) {
    return { valid: false, reasons: ["topic_reentry_ticket_schema_invalid"] };
  }
  const priorRecords = Array.isArray(priorRecordValue)
    ? [...priorRecordValue]
    : [priorRecordValue as TopicKillRecord];
  const { content_sha256: contentSha256, ...payload } = ticket;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("topic_reentry_ticket_hash_mismatch");
  }
  if (
    ticket.proposed_formulation_sha256
      !== proposedDescriptor.formulation_sha256
  ) {
    reasons.push("topic_reentry_ticket_proposed_formulation_mismatch");
  }
  if (
    context.expectedLedgerHeadSha256
    && ticket.ledger_head_sha256 !== context.expectedLedgerHeadSha256
  ) {
    reasons.push("topic_reentry_ticket_ledger_head_mismatch");
  }
  if (
    context.expectedIssuerId
    && ticket.issuer_id !== context.expectedIssuerId
  ) {
    reasons.push("topic_reentry_ticket_issuer_mismatch");
  }
  if (
    context.expectedDecisionArtifactSha256
    && ticket.decision_artifact_sha256
      !== context.expectedDecisionArtifactSha256
  ) {
    reasons.push("topic_reentry_ticket_decision_artifact_mismatch");
  }

  const adjudicatedRecordHashes = ticket.adjudications.map(
    (adjudication) => adjudication.prior_record_sha256
  );
  const expectedRecordHashes = priorRecords.map(
    (record) => record.record_sha256
  );
  if (
    new Set(adjudicatedRecordHashes).size
      !== adjudicatedRecordHashes.length
  ) {
    reasons.push("topic_reentry_ticket_duplicate_adjudication");
  }
  if (
    priorRecords.length === 0
    || !sameStrings(adjudicatedRecordHashes, expectedRecordHashes)
  ) {
    reasons.push("topic_reentry_ticket_blocking_records_mismatch");
  }

  const distinctEvidenceIds = uniqueStrings(
    ticket.new_full_text_evidence_ids
  );
  if (
    distinctEvidenceIds.length !== ticket.new_full_text_evidence_ids.length
    || JSON.stringify(distinctEvidenceIds)
      !== JSON.stringify(ticket.new_full_text_evidence_ids)
  ) {
    reasons.push("topic_reentry_ticket_evidence_ids_not_distinct");
  }
  if (distinctEvidenceIds.length < 2) {
    reasons.push("topic_reentry_ticket_independent_evidence_insufficient");
  }

  for (const priorRecord of priorRecords) {
    const adjudication = ticket.adjudications.find(
      (item) => item.prior_record_sha256 === priorRecord.record_sha256
    );
    if (!adjudication) {
      continue;
    }
    const actualChangedAxes = TOPIC_MEMORY_AXES.filter(
      (axis) =>
        normalizeForIdentity(priorRecord.descriptor[axis])
          !== normalizeForIdentity(proposedDescriptor[axis])
    );
    if (
      actualChangedAxes.length === 0
      || !sameStrings(actualChangedAxes, adjudication.changed_axes)
    ) {
      reasons.push("topic_reentry_ticket_changed_axes_mismatch");
    }
    const actuallyNewEvidence = distinctEvidenceIds.filter(
      (evidenceId) =>
        !priorRecord.source_full_text_evidence_ids.includes(evidenceId)
    );
    if (actuallyNewEvidence.length < 2) {
      reasons.push("topic_reentry_ticket_evidence_not_new");
    }
    if (
      priorRecord.disposition_category === "prior_work_absorbed"
      && !adjudication.changed_axes.some(
        (axis) =>
          axis === "contribution_object"
          || axis === "method_mechanism"
          || axis === "data_task_scope"
      )
    ) {
      reasons.push("topic_reentry_ticket_absorption_axis_unchanged");
    }
  }
  return { valid: reasons.length === 0, reasons: uniqueStrings(reasons) };
}

export function topicLineageSimilarity(
  left: TopicFormulationDescriptor,
  right: TopicFormulationDescriptor
): number {
  const contribution = jaccardTokens(
    left.contribution_object,
    right.contribution_object
  );
  const scope = jaccardTokens(left.data_task_scope, right.data_task_scope);
  return roundSimilarity((contribution + scope) / 2);
}

export function changedTopicMemoryAxes(
  left: TopicFormulationDescriptor,
  right: TopicFormulationDescriptor
): TopicMemoryAxis[] {
  return TOPIC_MEMORY_AXES.filter(
    (axis) =>
      normalizeForIdentity(left[axis]) !== normalizeForIdentity(right[axis])
  );
}

export function isNearTopicLineage(
  left: TopicFormulationDescriptor,
  right: TopicFormulationDescriptor
): boolean {
  const contribution = jaccardTokens(
    left.contribution_object,
    right.contribution_object
  );
  const scope = jaccardTokens(left.data_task_scope, right.data_task_scope);
  return contribution >= 0.25
    && scope >= 0.25
    && roundSimilarity((contribution + scope) / 2)
      >= TOPIC_MEMORY_NEAR_LINEAGE_THRESHOLD;
}

function buildLedger(records: TopicKillRecord[]): TopicMemoryLedger {
  const payload = {
    schema_version: 2 as const,
    artifact_kind: "topic_memory_ledger" as const,
    records: records.map(cloneRecord)
  };
  return {
    ...payload,
    ledger_sha256: hashCanonical(payload)
  };
}

function requireKillRecordInput(
  input: TopicKillRecordInput
): TopicKillRecordInput {
  const descriptor = requireDescriptor(input.descriptor);
  if (
    input.kill_scope !== "exact_formulation"
    && input.kill_scope !== "topic_lineage"
  ) {
    throw new Error("topic_memory_kill_scope_invalid");
  }
  if (!DISPOSITION_CATEGORIES.has(input.disposition_category)) {
    throw new Error("topic_memory_disposition_invalid");
  }
  const publicReasonCodes = uniqueStrings(input.public_reason_codes);
  if (
    publicReasonCodes.length === 0
    || publicReasonCodes.some(
      (code) =>
        !PUBLIC_REASON_CODES.has(code)
        || !REASONS_BY_DISPOSITION[input.disposition_category].has(
          code as TopicKillPublicReasonCode
        )
    )
  ) {
    throw new Error("topic_memory_reason_codes_invalid");
  }
  if (!RUN_ID_PATTERN.test(input.source_run_id)) {
    throw new Error("topic_memory_source_run_id_invalid");
  }
  if (
    !Number.isInteger(input.source_research_cycle)
    || input.source_research_cycle < 0
  ) {
    throw new Error("topic_memory_source_research_cycle_invalid");
  }
  const sourceFullTextEvidenceIds = uniqueStrings(
    input.source_full_text_evidence_ids
  );
  if (
    input.disposition_category === "prior_work_absorbed"
    && sourceFullTextEvidenceIds.length < 2
  ) {
    throw new Error("topic_memory_source_full_text_evidence_insufficient");
  }
  return {
    descriptor,
    kill_scope: input.kill_scope,
    disposition_category: input.disposition_category,
    public_reason_codes:
      publicReasonCodes as TopicKillPublicReasonCode[],
    source_run_id: input.source_run_id,
    source_research_cycle: input.source_research_cycle,
    source_full_text_evidence_ids: sourceFullTextEvidenceIds,
    source_topic_content_sha256: requireSha256(
      input.source_topic_content_sha256,
      "topic_memory_source_topic_hash_invalid"
    ),
    source_decision_content_sha256: requireSha256(
      input.source_decision_content_sha256,
      "topic_memory_source_decision_hash_invalid"
    )
  };
}

function requireDescriptor(
  value: TopicFormulationDescriptor
): TopicFormulationDescriptor {
  const validation = validateDescriptor(value);
  if (!validation.valid || !validation.descriptor) {
    throw new Error(
      `topic_memory_descriptor_invalid:${validation.reasons.join(",")}`
    );
  }
  return validation.descriptor;
}

function validateDescriptor(
  value: unknown
): {
  valid: boolean;
  reasons: string[];
  descriptor?: TopicFormulationDescriptor;
} {
  if (!isRecord(value)) {
    return { valid: false, reasons: ["topic_memory_descriptor_schema_invalid"] };
  }
  const axes = Object.fromEntries(
    TOPIC_MEMORY_AXES.map((axis) => [axis, normalizeOptionalText(value[axis])])
  ) as Record<TopicMemoryAxis, string | undefined>;
  if (TOPIC_MEMORY_AXES.some((axis) => !axes[axis])) {
    return { valid: false, reasons: ["topic_memory_descriptor_axis_missing"] };
  }
  const expected = buildTopicFormulationDescriptor({
    statement: axes.method_mechanism!,
    contribution_claim: axes.contribution_object!,
    dataset_task_bench: axes.data_task_scope!,
    comparator: axes.evaluation_protocol!,
    primary_metric: undefined,
    minimum_publishable_evidence: axes.claim_ceiling!
  });
  const candidate = value as Partial<TopicFormulationDescriptor>;
  const reasons = [
    candidate.lineage_sha256 !== expected.lineage_sha256
      ? "topic_memory_descriptor_lineage_hash_mismatch"
      : undefined,
    candidate.formulation_sha256 !== expected.formulation_sha256
      ? "topic_memory_descriptor_formulation_hash_mismatch"
      : undefined
  ].filter((reason): reason is string => Boolean(reason));
  const payload = {
    contribution_object: axes.contribution_object!,
    method_mechanism: axes.method_mechanism!,
    data_task_scope: axes.data_task_scope!,
    evaluation_protocol: axes.evaluation_protocol!,
    claim_ceiling: axes.claim_ceiling!,
    lineage_sha256: candidate.lineage_sha256,
    formulation_sha256: candidate.formulation_sha256
  };
  if (
    !SHA256_PATTERN.test(candidate.content_sha256 || "")
    || hashCanonical(payload) !== candidate.content_sha256
  ) {
    reasons.push("topic_memory_descriptor_content_hash_mismatch");
  }
  return reasons.length > 0
    ? { valid: false, reasons }
    : {
        valid: true,
        reasons: [],
        descriptor: cloneDescriptor(candidate as TopicFormulationDescriptor)
      };
}

function isTopicMemoryLedgerShape(
  value: unknown
): value is TopicMemoryLedger {
  return isRecord(value)
    && value.schema_version === 2
    && value.artifact_kind === "topic_memory_ledger"
    && Array.isArray(value.records)
    && value.records.every(isTopicKillRecordShape)
    && SHA256_PATTERN.test(String(value.ledger_sha256 || ""));
}

function isTopicKillRecordShape(value: unknown): value is TopicKillRecord {
  return isRecord(value)
    && SHA256_PATTERN.test(String(value.previous_ledger_sha256 || ""))
    && isRecord(value.descriptor)
    && (
      value.kill_scope === "exact_formulation"
      || value.kill_scope === "topic_lineage"
    )
    && DISPOSITION_CATEGORIES.has(String(value.disposition_category || ""))
    && Array.isArray(value.public_reason_codes)
    && value.public_reason_codes.every(
      (code) => PUBLIC_REASON_CODES.has(String(code))
    )
    && RUN_ID_PATTERN.test(String(value.source_run_id || ""))
    && Number.isInteger(value.source_research_cycle)
    && Number(value.source_research_cycle) >= 0
    && Array.isArray(value.source_full_text_evidence_ids)
    && value.source_full_text_evidence_ids.every(
      (id) => typeof id === "string" && id.trim().length > 0
    )
    && SHA256_PATTERN.test(String(value.source_topic_content_sha256 || ""))
    && SHA256_PATTERN.test(String(value.source_decision_content_sha256 || ""))
    && SHA256_PATTERN.test(String(value.record_sha256 || ""));
}

function isTopicReentryTicketShape(
  value: unknown
): value is TopicReentryTicket {
  return isRecord(value)
    && value.schema_version === 2
    && value.artifact_kind === "topic_reentry_ticket"
    && SHA256_PATTERN.test(
      String(value.proposed_formulation_sha256 || "")
    )
    && SHA256_PATTERN.test(String(value.ledger_head_sha256 || ""))
    && RUN_ID_PATTERN.test(String(value.issuer_id || ""))
    && SHA256_PATTERN.test(
      String(value.decision_artifact_sha256 || "")
    )
    && Array.isArray(value.adjudications)
    && value.adjudications.length > 0
    && value.adjudications.every(isTopicReentryAdjudicationShape)
    && Array.isArray(value.new_full_text_evidence_ids)
    && value.new_full_text_evidence_ids.every(
      (id) => typeof id === "string" && id.trim().length > 0
    )
    && typeof value.rationale === "string"
    && value.rationale.trim().length > 0
    && SHA256_PATTERN.test(String(value.content_sha256 || ""));
}

function isTopicReentryAdjudicationShape(
  value: unknown
): value is TopicReentryAdjudication {
  return isRecord(value)
    && SHA256_PATTERN.test(String(value.prior_record_sha256 || ""))
    && Array.isArray(value.changed_axes)
    && value.changed_axes.length > 0
    && value.changed_axes.every((axis) => AXES.has(String(axis)));
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function clearDecision(): TopicMemoryDecision {
  return {
    disposition: "clear",
    blocked: false,
    exact_formulation_match: false,
    exact_lineage_match: false,
    near_lineage_match: false,
    matching_record_sha256s: [],
    maximum_lineage_similarity: 0,
    reason_codes: []
  };
}

function requireChangedAxes(axes: TopicMemoryAxis[]): TopicMemoryAxis[] {
  const normalized = uniqueStrings(axes).filter(
    (axis): axis is TopicMemoryAxis => AXES.has(axis)
  );
  if (normalized.length === 0 || normalized.length !== axes.length) {
    throw new Error("topic_reentry_changed_axes_invalid");
  }
  return TOPIC_MEMORY_AXES.filter((axis) => normalized.includes(axis));
}

function requireReentryAdjudications(
  values: Array<{
    priorRecordSha256: string;
    changedAxes: TopicMemoryAxis[];
  }>
): TopicReentryAdjudication[] {
  if (values.length === 0) {
    throw new Error("topic_reentry_adjudications_missing");
  }
  const adjudications = values.map((value) => ({
    prior_record_sha256: requireSha256(
      value.priorRecordSha256,
      "topic_reentry_prior_record_sha256_invalid"
    ),
    changed_axes: requireChangedAxes(value.changedAxes)
  }));
  if (
    new Set(
      adjudications.map((item) => item.prior_record_sha256)
    ).size !== adjudications.length
  ) {
    throw new Error("topic_reentry_duplicate_adjudication");
  }
  return adjudications.sort((left, right) =>
    left.prior_record_sha256.localeCompare(right.prior_record_sha256)
  );
}

function requireEvidenceIds(ids: string[]): string[] {
  const normalized = uniqueStrings(ids);
  if (normalized.length < 2 || normalized.length !== ids.length) {
    throw new Error("topic_reentry_independent_evidence_insufficient");
  }
  return normalized;
}

function requireIssuerId(value: unknown): string {
  const issuerId = normalizeOptionalText(value);
  if (!issuerId || !RUN_ID_PATTERN.test(issuerId)) {
    throw new Error("topic_reentry_issuer_id_invalid");
  }
  return issuerId;
}

function collectDuplicate(
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

function cloneDescriptor(
  descriptor: TopicFormulationDescriptor
): TopicFormulationDescriptor {
  return { ...descriptor };
}

function cloneRecord(record: TopicKillRecord): TopicKillRecord {
  return {
    ...record,
    descriptor: cloneDescriptor(record.descriptor),
    public_reason_codes: [...record.public_reason_codes],
    source_full_text_evidence_ids: [
      ...record.source_full_text_evidence_ids
    ]
  };
}

function cloneLedger(ledger: TopicMemoryLedger): TopicMemoryLedger {
  return {
    ...ledger,
    records: ledger.records.map(cloneRecord)
  };
}

function normalizeForIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function jaccardTokens(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  return intersection / union.size;
}

function tokenize(value: string): string[] {
  return normalizeForIdentity(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length > 1);
}

function roundSimilarity(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function requireText(value: unknown, code: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(code);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function requireSha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(code);
  }
  return value;
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean)
  )].sort();
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
