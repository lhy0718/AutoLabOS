import type { ActiveTopicProbeContract } from "./activeTopicProbeContract.js";
import {
  hashCanonical,
  type TopicPortfolioCandidate
} from "./researchFunnel.js";
import type {
  TopicProbeOutcomeDecision,
  TopicProbeOutcomeNextAction,
  TopicProbeOutcomeReasonCode
} from "./topicProbeOutcome.js";

export const VENUE_VIABILITY_REPORT_RELATIVE_PATH =
  "analysis/venue_viability_report.json";

export type CandidateViability = "continue" | "pivot" | "kill" | "blocked";
export type TopTierReadiness = "blocked" | "unresolved";
export type ConfirmatoryCandidacy = "supported" | "unsupported" | "unresolved";
export type VenueNoveltyStatus =
  | "absorbed"
  | "partially_absorbed"
  | "non_overlapping"
  | "uncertain";
export type DeclaredComparatorEffectGate = "passed" | "failed" | "unresolved" | "invalid";

export type VenueViabilityReasonCode =
  | TopicProbeOutcomeReasonCode
  | "closest_prior_absorbed"
  | "closest_prior_partially_absorbed"
  | "closest_prior_non_overlap_verified"
  | "closest_prior_status_uncertain"
  | "bounded_probe_is_screening_only";

export type VenueViabilityUpgradeCode =
  | "confirmatory_evidence_required"
  | "current_venue_fit_review_required"
  | "paper_scale_model_review_required"
  | "closest_prior_non_overlap_review_required"
  | "repeat_bounded_probe_with_uncertainty"
  | "select_deferred_candidate"
  | "refresh_topic_portfolio"
  | "repair_probe_evidence"
  | "reformulate_contribution";

export interface VenueViabilityReport {
  schema_version: 1;
  artifact_kind: "venue_viability_report";
  authority: "A0_deterministic";
  assessment_stage: "bounded_topic_probe";
  decision_scope: "active_candidate";
  run_id: string;
  research_cycle: number;
  candidate_id: string;
  topic_id: string;
  candidate_content_sha256: string;
  active_contract_content_sha256: string;
  outcome_content_sha256: string;
  candidate_viability: CandidateViability;
  current_evidence_ceiling: "screening_only";
  paper_scale_claims_allowed: false;
  paper_submission_allowed: false;
  top_tier_ready: false;
  acceptance_likelihood_assessed: false;
  top_tier_readiness: TopTierReadiness;
  confirmatory_candidacy: ConfirmatoryCandidacy;
  novelty_status: VenueNoveltyStatus;
  declared_comparator_effect_gate: DeclaredComparatorEffectGate;
  minimum_publishable_evidence_contract: string;
  reason_codes: VenueViabilityReasonCode[];
  required_upgrades: VenueViabilityUpgradeCode[];
  next_action: TopicProbeOutcomeNextAction;
  content_sha256: string;
}

export interface VenueViabilityContext {
  candidate: TopicPortfolioCandidate;
  contract: ActiveTopicProbeContract;
  outcome: TopicProbeOutcomeDecision;
}

export interface VenueViabilityValidation {
  valid: boolean;
  reasons: string[];
  report?: VenueViabilityReport;
  expectedReport?: VenueViabilityReport;
}

const REPORT_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "authority",
  "assessment_stage",
  "decision_scope",
  "run_id",
  "research_cycle",
  "candidate_id",
  "topic_id",
  "candidate_content_sha256",
  "active_contract_content_sha256",
  "outcome_content_sha256",
  "candidate_viability",
  "current_evidence_ceiling",
  "paper_scale_claims_allowed",
  "paper_submission_allowed",
  "top_tier_ready",
  "acceptance_likelihood_assessed",
  "top_tier_readiness",
  "confirmatory_candidacy",
  "novelty_status",
  "declared_comparator_effect_gate",
  "minimum_publishable_evidence_contract",
  "reason_codes",
  "required_upgrades",
  "next_action",
  "content_sha256"
]);

export function buildVenueViabilityReport(
  context: VenueViabilityContext
): VenueViabilityReport {
  assertContextBindings(context);
  const noveltyStatus = resolveNoveltyStatus(context.candidate);
  const candidateViability = resolveCandidateViability(context, noveltyStatus);
  const declaredComparatorEffectGate = resolveDeclaredComparatorEffectGate(
    context.outcome
  );
  const confirmatoryCandidacy = resolveConfirmatoryCandidacy(
    context.outcome,
    noveltyStatus
  );
  const topTierReadiness = resolveTopTierReadiness(
    context.outcome,
    noveltyStatus
  );
  const payload: Omit<VenueViabilityReport, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "venue_viability_report",
    authority: "A0_deterministic",
    assessment_stage: "bounded_topic_probe",
    decision_scope: "active_candidate",
    run_id: context.contract.run_id,
    research_cycle: context.contract.research_cycle,
    candidate_id: context.contract.candidate_id,
    topic_id: context.contract.topic_id,
    candidate_content_sha256: context.candidate.content_sha256,
    active_contract_content_sha256: context.contract.content_sha256,
    outcome_content_sha256: context.outcome.content_sha256,
    candidate_viability: candidateViability,
    current_evidence_ceiling: "screening_only",
    paper_scale_claims_allowed: false,
    paper_submission_allowed: false,
    top_tier_ready: false,
    acceptance_likelihood_assessed: false,
    top_tier_readiness: topTierReadiness,
    confirmatory_candidacy: confirmatoryCandidacy,
    novelty_status: noveltyStatus,
    declared_comparator_effect_gate: declaredComparatorEffectGate,
    minimum_publishable_evidence_contract:
      context.candidate.minimum_publishable_evidence || "",
    reason_codes: unique([
      ...context.outcome.reason_codes,
      noveltyReasonCode(noveltyStatus),
      "bounded_probe_is_screening_only"
    ]),
    required_upgrades: resolveRequiredUpgrades(
      context.outcome,
      noveltyStatus
    ),
    next_action: context.outcome.next_action
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function validateVenueViabilityReport(
  raw: string,
  context: VenueViabilityContext
): VenueViabilityValidation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { valid: false, reasons: ["venue_viability_report_invalid_json"] };
  }
  if (!isVenueViabilityReport(value)) {
    return { valid: false, reasons: ["venue_viability_report_schema_invalid"] };
  }

  const reasons: string[] = [];
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("venue_viability_report_content_hash_mismatch");
  }

  let expectedReport: VenueViabilityReport | undefined;
  try {
    expectedReport = buildVenueViabilityReport(context);
    if (value.content_sha256 !== expectedReport.content_sha256) {
      reasons.push("venue_viability_report_recomputed_mismatch");
    }
  } catch (error) {
    reasons.push(normalizeContextError(error));
  }

  return {
    valid: reasons.length === 0,
    reasons: unique(reasons),
    report: value,
    ...(expectedReport ? { expectedReport } : {})
  };
}

function assertContextBindings(context: VenueViabilityContext): void {
  if (
    context.candidate.source_candidate_id !== context.contract.candidate_id
    || context.candidate.topic_id !== context.contract.topic_id
    || context.candidate.content_sha256 !== context.contract.candidate_content_sha256
  ) {
    throw new Error("venue_viability_candidate_contract_mismatch");
  }
  if (
    context.outcome.candidate_id !== context.contract.candidate_id
    || context.outcome.topic_id !== context.contract.topic_id
    || context.outcome.contract_content_sha256 !== context.contract.content_sha256
    || context.outcome.run_id !== context.contract.run_id
    || context.outcome.research_cycle !== context.contract.research_cycle
  ) {
    throw new Error("venue_viability_outcome_contract_mismatch");
  }
  if (!context.candidate.minimum_publishable_evidence?.trim()) {
    throw new Error("venue_viability_minimum_publishable_evidence_missing");
  }
}

function resolveNoveltyStatus(
  candidate: TopicPortfolioCandidate
): VenueNoveltyStatus {
  const comparisons = candidate.prior_absorption?.comparisons || [];
  if (comparisons.some((item) => item.disposition === "absorbed")) {
    return "absorbed";
  }
  if (
    comparisons.length === 0
    || candidate.prior_absorption?.coverage_complete !== true
    || candidate.prior_absorption?.full_text_evidence_complete !== true
    || candidate.prior_absorption?.independent_evidence_complete !== true
    || comparisons.some((item) => item.disposition === "uncertain")
  ) {
    return "uncertain";
  }
  if (comparisons.some((item) => item.disposition === "partially_absorbed")) {
    return "partially_absorbed";
  }
  return "non_overlapping";
}

function resolveCandidateViability(
  context: VenueViabilityContext,
  noveltyStatus: VenueNoveltyStatus
): CandidateViability {
  if (context.outcome.disposition === "blocked_invalid_evidence") {
    return "blocked";
  }
  if (context.outcome.disposition === "reject_candidate") {
    return context.contract.deferred_candidate_ids.length > 0 ? "pivot" : "kill";
  }
  if (noveltyStatus === "absorbed") {
    return context.contract.deferred_candidate_ids.length > 0 ? "pivot" : "kill";
  }
  return "continue";
}

function resolveDeclaredComparatorEffectGate(
  outcome: TopicProbeOutcomeDecision
): DeclaredComparatorEffectGate {
  if (outcome.disposition === "promote_to_confirmatory") {
    return "passed";
  }
  if (outcome.disposition === "reject_candidate") {
    return "failed";
  }
  if (outcome.disposition === "repeat_probe") {
    return "unresolved";
  }
  return "invalid";
}

function resolveConfirmatoryCandidacy(
  outcome: TopicProbeOutcomeDecision,
  noveltyStatus: VenueNoveltyStatus
): ConfirmatoryCandidacy {
  if (noveltyStatus === "absorbed") return "unsupported";
  if (outcome.disposition === "promote_to_confirmatory") return "supported";
  if (outcome.disposition === "reject_candidate") return "unsupported";
  return "unresolved";
}

function resolveTopTierReadiness(
  outcome: TopicProbeOutcomeDecision,
  noveltyStatus: VenueNoveltyStatus
): TopTierReadiness {
  if (
    noveltyStatus === "absorbed"
    || outcome.disposition === "reject_candidate"
  ) {
    return "blocked";
  }
  return "unresolved";
}

function resolveRequiredUpgrades(
  outcome: TopicProbeOutcomeDecision,
  noveltyStatus: VenueNoveltyStatus
): VenueViabilityUpgradeCode[] {
  const upgrades: VenueViabilityUpgradeCode[] = [];
  if (noveltyStatus === "absorbed") {
    upgrades.push("reformulate_contribution");
  } else if (noveltyStatus !== "non_overlapping") {
    upgrades.push("closest_prior_non_overlap_review_required");
  }

  if (outcome.disposition === "promote_to_confirmatory") {
    upgrades.push(
      "confirmatory_evidence_required",
      "current_venue_fit_review_required",
      "paper_scale_model_review_required"
    );
  } else if (outcome.disposition === "repeat_probe") {
    upgrades.push("repeat_bounded_probe_with_uncertainty");
  } else if (outcome.disposition === "reject_candidate") {
    upgrades.push(
      outcome.next_action === "try_deferred_candidate"
        ? "select_deferred_candidate"
        : "refresh_topic_portfolio"
    );
  } else {
    upgrades.push("repair_probe_evidence");
  }
  return unique(upgrades);
}

function noveltyReasonCode(
  noveltyStatus: VenueNoveltyStatus
): VenueViabilityReasonCode {
  if (noveltyStatus === "absorbed") return "closest_prior_absorbed";
  if (noveltyStatus === "partially_absorbed") {
    return "closest_prior_partially_absorbed";
  }
  if (noveltyStatus === "non_overlapping") {
    return "closest_prior_non_overlap_verified";
  }
  return "closest_prior_status_uncertain";
}

function isVenueViabilityReport(value: unknown): value is VenueViabilityReport {
  if (!isRecord(value) || !hasOnlyKnownFields(value, REPORT_FIELDS)) return false;
  return value.schema_version === 1
    && value.artifact_kind === "venue_viability_report"
    && value.authority === "A0_deterministic"
    && value.assessment_stage === "bounded_topic_probe"
    && value.decision_scope === "active_candidate"
    && hasText(value.run_id)
    && isNonNegativeInteger(value.research_cycle)
    && hasText(value.candidate_id)
    && hasText(value.topic_id)
    && isSha256(value.candidate_content_sha256)
    && isSha256(value.active_contract_content_sha256)
    && isSha256(value.outcome_content_sha256)
    && ["continue", "pivot", "kill", "blocked"].includes(String(value.candidate_viability))
    && value.current_evidence_ceiling === "screening_only"
    && value.paper_scale_claims_allowed === false
    && value.paper_submission_allowed === false
    && value.top_tier_ready === false
    && value.acceptance_likelihood_assessed === false
    && ["blocked", "unresolved"].includes(String(value.top_tier_readiness))
    && ["supported", "unsupported", "unresolved"].includes(String(value.confirmatory_candidacy))
    && ["absorbed", "partially_absorbed", "non_overlapping", "uncertain"].includes(String(value.novelty_status))
    && ["passed", "failed", "unresolved", "invalid"].includes(String(value.declared_comparator_effect_gate))
    && hasText(value.minimum_publishable_evidence_contract)
    && Array.isArray(value.reason_codes)
    && value.reason_codes.every(hasText)
    && Array.isArray(value.required_upgrades)
    && value.required_upgrades.every(hasText)
    && [
      "start_confirmatory_run",
      "try_deferred_candidate",
      "refresh_topic_portfolio",
      "repeat_bounded_probe",
      "repair_probe_evidence"
    ].includes(String(value.next_action))
    && isSha256(value.content_sha256);
}

function normalizeContextError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("venue_viability_")
    ? message
    : "venue_viability_context_invalid";
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

function unique<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}
