import { hashCanonical } from "./researchFunnel.js";
import type {
  TopicProbeOutcomeDecision,
  TopicProbeOutcomeDisposition
} from "./topicProbeOutcome.js";
import type { TopicProbeFollowupHandoff } from "./topicProbeFollowup.js";

export const TOPIC_PROBE_REVIEW_GATE_RELATIVE_PATH =
  "review/topic_probe_gate.json";

export type TopicProbeReviewGateStatus =
  | "followup_required"
  | "blocked_invalid_artifact_chain";

export interface TopicProbeReviewGateArtifact {
  schema_version: 1;
  artifact_kind: "topic_probe_review_gate";
  run_id: string;
  research_cycle: number;
  status: TopicProbeReviewGateStatus;
  paper_drafting_allowed: false;
  candidate_id: string | null;
  disposition: TopicProbeOutcomeDisposition | null;
  outcome_content_sha256: string | null;
  handoff_content_sha256: string | null;
  reason_codes: string[];
  content_sha256: string;
}

export interface BuildTopicProbeReviewGateInput {
  runId: string;
  researchCycle: number;
  outcome?: TopicProbeOutcomeDecision;
  handoff?: TopicProbeFollowupHandoff;
  validationReasons?: string[];
}

export interface TopicProbeReviewGateValidationContext
  extends BuildTopicProbeReviewGateInput {}

export interface TopicProbeReviewGateValidation {
  measured: boolean;
  valid: boolean;
  reasons: string[];
  gate?: TopicProbeReviewGateArtifact;
  expectedGate?: TopicProbeReviewGateArtifact;
}

const GATE_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "run_id",
  "research_cycle",
  "status",
  "paper_drafting_allowed",
  "candidate_id",
  "disposition",
  "outcome_content_sha256",
  "handoff_content_sha256",
  "reason_codes",
  "content_sha256"
]);

const RECOMPUTED_FIELDS: Array<Exclude<keyof TopicProbeReviewGateArtifact, "content_sha256">> = [
  "schema_version",
  "artifact_kind",
  "run_id",
  "research_cycle",
  "status",
  "paper_drafting_allowed",
  "candidate_id",
  "disposition",
  "outcome_content_sha256",
  "handoff_content_sha256",
  "reason_codes"
];

export function buildTopicProbeReviewGate(
  input: BuildTopicProbeReviewGateInput
): TopicProbeReviewGateArtifact {
  const bindingReasons = collectBindingReasons(input);
  const reasonCodes = uniqueStrings([
    ...(input.validationReasons ?? []),
    ...bindingReasons
  ]).sort();
  const complete = Boolean(input.outcome && input.handoff) && reasonCodes.length === 0;
  const payload: Omit<TopicProbeReviewGateArtifact, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "topic_probe_review_gate",
    run_id: input.runId,
    research_cycle: input.researchCycle,
    status: complete ? "followup_required" : "blocked_invalid_artifact_chain",
    paper_drafting_allowed: false,
    candidate_id: input.outcome?.candidate_id ?? null,
    disposition: input.outcome?.disposition ?? null,
    outcome_content_sha256: input.outcome?.content_sha256 ?? null,
    handoff_content_sha256: input.handoff?.content_sha256 ?? null,
    reason_codes: reasonCodes
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function validateTopicProbeReviewGate(
  raw: string,
  context: TopicProbeReviewGateValidationContext
): TopicProbeReviewGateValidation {
  if (!raw.trim()) {
    return {
      measured: false,
      valid: false,
      reasons: ["topic_probe_review_gate_missing"]
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      measured: true,
      valid: false,
      reasons: ["topic_probe_review_gate_invalid_json"]
    };
  }
  if (!isTopicProbeReviewGateArtifact(value)) {
    return {
      measured: true,
      valid: false,
      reasons: ["topic_probe_review_gate_schema_invalid"]
    };
  }

  const reasons: string[] = [];
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("topic_probe_review_gate_content_hash_mismatch");
  }

  const expectedGate = buildTopicProbeReviewGate(context);
  for (const field of RECOMPUTED_FIELDS) {
    if (!valuesEqual(value[field], expectedGate[field])) {
      reasons.push(`topic_probe_review_gate_recomputed_field_mismatch:${String(field)}`);
    }
  }

  return {
    measured: true,
    valid: reasons.length === 0,
    reasons: uniqueStrings(reasons),
    gate: value,
    expectedGate
  };
}

function collectBindingReasons(input: BuildTopicProbeReviewGateInput): string[] {
  const reasons: string[] = [];
  if (!input.runId.trim()) {
    reasons.push("topic_probe_review_gate_run_id_missing");
  }
  if (!Number.isInteger(input.researchCycle) || input.researchCycle < 0) {
    reasons.push("topic_probe_review_gate_research_cycle_invalid");
  }
  if (!input.outcome) {
    reasons.push("topic_probe_review_gate_outcome_missing");
  }
  if (!input.handoff) {
    reasons.push("topic_probe_review_gate_handoff_missing");
  }
  if (input.outcome) {
    if (input.outcome.run_id !== input.runId) {
      reasons.push("topic_probe_review_gate_outcome_run_id_mismatch");
    }
    if (input.outcome.research_cycle !== input.researchCycle) {
      reasons.push("topic_probe_review_gate_outcome_research_cycle_mismatch");
    }
  }
  if (input.handoff) {
    if (input.handoff.parent_run_id !== input.runId) {
      reasons.push("topic_probe_review_gate_handoff_parent_run_id_mismatch");
    }
    if (input.handoff.parent_research_cycle !== input.researchCycle) {
      reasons.push("topic_probe_review_gate_handoff_parent_research_cycle_mismatch");
    }
  }
  if (input.outcome && input.handoff) {
    if (input.handoff.outcome_content_sha256 !== input.outcome.content_sha256) {
      reasons.push("topic_probe_review_gate_handoff_outcome_hash_mismatch");
    }
    if (input.handoff.candidate_id !== input.outcome.candidate_id) {
      reasons.push("topic_probe_review_gate_handoff_candidate_id_mismatch");
    }
    if (input.handoff.disposition !== input.outcome.disposition) {
      reasons.push("topic_probe_review_gate_handoff_disposition_mismatch");
    }
    if (input.handoff.next_action !== input.outcome.next_action) {
      reasons.push("topic_probe_review_gate_handoff_next_action_mismatch");
    }
  }
  return reasons;
}

function isTopicProbeReviewGateArtifact(
  value: unknown
): value is TopicProbeReviewGateArtifact {
  if (!isRecord(value) || !hasOnlyKnownFields(value, GATE_FIELDS)) {
    return false;
  }
  return value.schema_version === 1
    && value.artifact_kind === "topic_probe_review_gate"
    && hasText(value.run_id)
    && isNonNegativeInteger(value.research_cycle)
    && (
      value.status === "followup_required"
      || value.status === "blocked_invalid_artifact_chain"
    )
    && value.paper_drafting_allowed === false
    && (value.candidate_id === null || hasText(value.candidate_id))
    && (value.disposition === null || isDisposition(value.disposition))
    && (value.outcome_content_sha256 === null || isSha256(value.outcome_content_sha256))
    && (value.handoff_content_sha256 === null || isSha256(value.handoff_content_sha256))
    && Array.isArray(value.reason_codes)
    && value.reason_codes.every(hasText)
    && isSha256(value.content_sha256);
}

function isDisposition(value: unknown): value is TopicProbeOutcomeDisposition {
  return value === "promote_to_confirmatory"
    || value === "reject_candidate"
    || value === "repeat_probe"
    || value === "blocked_invalid_evidence";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKnownFields(
  value: Record<string, unknown>,
  fields: Set<string>
): boolean {
  return Object.keys(value).every((field) => fields.has(field));
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
