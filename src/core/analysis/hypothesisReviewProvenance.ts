import type { LLMClient } from "../llm/client.js";
import { hashCanonical } from "../canonicalHash.js";

export type HypothesisReviewIndependenceClass =
  | "independent_review"
  | "self_review";

export type HypothesisLlmInvocationStage =
  | "evidence_axes"
  | "candidate_generation"
  | "single_pass_generation"
  | "hypothesis_review"
  | (string & {});

export interface HypothesisLlmIdentity {
  identity?: string;
  backend?: string;
  provider?: string;
  model?: string;
}

export type TopicMemoryReviewerTrustClass =
  | "local"
  | "external"
  | "unknown";

export type TopicMemoryTransmissionPayloadMode =
  | "raw_descriptors"
  | "deny";

export interface TopicMemoryTransmissionPolicy {
  reviewer_trust_class: TopicMemoryReviewerTrustClass;
  payload_mode: TopicMemoryTransmissionPayloadMode;
  raw_descriptor_consent: boolean;
}

export interface ResolvedTopicMemoryTransmissionPolicy
  extends TopicMemoryTransmissionPolicy {
  policy_source: "caller_supplied" | "default_deny";
}

export interface HypothesisReviewerDependency {
  llm: LLMClient;
  identity?: HypothesisLlmIdentity;
  topicMemoryTransmissionPolicy?: TopicMemoryTransmissionPolicy;
}

export interface ResolvedHypothesisLlmIdentity {
  identity: string | null;
  backend: string | null;
  provider: string | null;
  model: string | null;
  identity_source:
    | "caller_supplied"
    | "backend_provider_model"
    | "missing";
  identity_fingerprint_sha256: string | null;
}

export interface HypothesisReviewBoundary {
  reviewerLlm: LLMClient;
  proposer: ResolvedHypothesisLlmIdentity;
  reviewer: ResolvedHypothesisLlmIdentity;
  topicMemoryTransmissionPolicy: ResolvedTopicMemoryTransmissionPolicy;
  independence_class: HypothesisReviewIndependenceClass;
  reason_codes: string[];
}

export interface HypothesisLlmInvocationProvenance {
  schema_version: 1;
  role: "proposer" | "reviewer";
  stage: HypothesisLlmInvocationStage;
  invocation_index: number;
  actor: ResolvedHypothesisLlmIdentity;
  input_sha256: string;
  output_sha256: string;
  invocation_sha256: string;
}

export interface HypothesisReviewProvenance {
  schema_version: 1;
  proposer: ResolvedHypothesisLlmIdentity;
  reviewer: ResolvedHypothesisLlmIdentity;
  proposer_invocations: HypothesisLlmInvocationProvenance[];
  reviewer_invocation: HypothesisLlmInvocationProvenance;
  independence_class: HypothesisReviewIndependenceClass;
  authorization_eligible: boolean;
  reason_codes: string[];
  provenance_sha256: string;
}

export interface HypothesisReviewAuthorization {
  schema_version: 1;
  proposer: ResolvedHypothesisLlmIdentity;
  reviewer: ResolvedHypothesisLlmIdentity;
  independence_class: HypothesisReviewIndependenceClass;
  authorized_for_probe: boolean;
  reason_codes: string[];
  completed_review_invocation_sha256s: string[];
  authorization_sha256: string;
}

export interface HypothesisPlanningProvenance {
  schema_version: 1;
  proposer: ResolvedHypothesisLlmIdentity;
  reviewer: ResolvedHypothesisLlmIdentity;
  proposer_invocations: HypothesisLlmInvocationProvenance[];
  reviewer_invocations: HypothesisLlmInvocationProvenance[];
  review_authorization: HypothesisReviewAuthorization;
  content_sha256: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function resolveHypothesisReviewBoundary(input: {
  proposerLlm: LLMClient;
  proposerIdentity?: HypothesisLlmIdentity;
  reviewer?: HypothesisReviewerDependency;
}): HypothesisReviewBoundary {
  const reviewerLlm = input.reviewer?.llm ?? input.proposerLlm;
  const proposer = resolveHypothesisLlmIdentity(input.proposerIdentity);
  const reviewer = resolveHypothesisLlmIdentity(input.reviewer?.identity);
  const topicMemoryTransmissionPolicy =
    resolveTopicMemoryTransmissionPolicy(
      input.reviewer?.topicMemoryTransmissionPolicy
    );
  const reasonCodes: string[] = [];

  if (!proposer.identity_fingerprint_sha256) {
    reasonCodes.push("proposer_identity_missing");
  }
  if (!reviewer.identity_fingerprint_sha256) {
    reasonCodes.push("reviewer_identity_missing");
  }
  if (reviewerLlm === input.proposerLlm) {
    reasonCodes.push("review_client_matches_proposer");
  }
  if (
    proposer.identity_fingerprint_sha256
    && reviewer.identity_fingerprint_sha256
    && proposer.identity_fingerprint_sha256
      === reviewer.identity_fingerprint_sha256
  ) {
    reasonCodes.push("review_identity_matches_proposer");
  }

  return {
    reviewerLlm,
    proposer,
    reviewer,
    topicMemoryTransmissionPolicy,
    independence_class:
      reasonCodes.length === 0 ? "independent_review" : "self_review",
    reason_codes: dedupeStrings(reasonCodes)
  };
}

function resolveTopicMemoryTransmissionPolicy(
  value: TopicMemoryTransmissionPolicy | undefined
): ResolvedTopicMemoryTransmissionPolicy {
  if (
    value
    && (
      value.reviewer_trust_class === "local"
      || value.reviewer_trust_class === "external"
      || value.reviewer_trust_class === "unknown"
    )
    && (
      value.payload_mode === "raw_descriptors"
      || value.payload_mode === "deny"
    )
    && typeof value.raw_descriptor_consent === "boolean"
  ) {
    return {
      reviewer_trust_class: value.reviewer_trust_class,
      payload_mode: value.payload_mode,
      raw_descriptor_consent: value.raw_descriptor_consent,
      policy_source: "caller_supplied"
    };
  }
  return {
    reviewer_trust_class: "unknown",
    payload_mode: "deny",
    raw_descriptor_consent: false,
    policy_source: "default_deny"
  };
}

export function buildHypothesisLlmInvocationProvenance(input: {
  role: HypothesisLlmInvocationProvenance["role"];
  stage: HypothesisLlmInvocationStage;
  invocationIndex: number;
  actor: ResolvedHypothesisLlmIdentity;
  prompt: string;
  systemPrompt: string;
  output: string;
}): HypothesisLlmInvocationProvenance {
  const payload = {
    schema_version: 1 as const,
    role: input.role,
    stage: input.stage,
    invocation_index: input.invocationIndex,
    actor: input.actor,
    input_sha256: hashCanonical({
      prompt: input.prompt,
      system_prompt: input.systemPrompt
    }),
    output_sha256: hashCanonical(input.output)
  };
  return {
    ...payload,
    invocation_sha256: hashCanonical(payload)
  };
}

export function buildHypothesisReviewProvenance(input: {
  boundary: HypothesisReviewBoundary;
  proposerInvocations: HypothesisLlmInvocationProvenance[];
  reviewerInvocation: HypothesisLlmInvocationProvenance;
}): HypothesisReviewProvenance {
  const reasonCodes = [...input.boundary.reason_codes];
  const proposerInvocations = input.proposerInvocations.map(copyInvocation);
  const reviewerInvocation = copyInvocation(input.reviewerInvocation);

  if (proposerInvocations.length === 0) {
    reasonCodes.push("proposer_invocation_provenance_missing");
  }
  for (const invocation of proposerInvocations) {
    if (
      invocation.role !== "proposer"
      || invocation.actor.identity_fingerprint_sha256
        !== input.boundary.proposer.identity_fingerprint_sha256
      || validateHypothesisLlmInvocationProvenance(invocation).length > 0
    ) {
      reasonCodes.push("proposer_invocation_provenance_invalid");
      break;
    }
  }
  if (
    reviewerInvocation.role !== "reviewer"
    || reviewerInvocation.stage !== "hypothesis_review"
    || reviewerInvocation.actor.identity_fingerprint_sha256
      !== input.boundary.reviewer.identity_fingerprint_sha256
    || validateHypothesisLlmInvocationProvenance(reviewerInvocation).length > 0
  ) {
    reasonCodes.push("reviewer_invocation_provenance_invalid");
  }

  const normalizedReasons = dedupeStrings(reasonCodes);
  const independenceClass: HypothesisReviewIndependenceClass =
    input.boundary.independence_class === "independent_review"
    && normalizedReasons.length === 0
      ? "independent_review"
      : "self_review";
  const payload = {
    schema_version: 1 as const,
    proposer: input.boundary.proposer,
    reviewer: input.boundary.reviewer,
    proposer_invocations: proposerInvocations,
    reviewer_invocation: reviewerInvocation,
    independence_class: independenceClass,
    authorization_eligible: independenceClass === "independent_review",
    reason_codes: normalizedReasons
  };
  return {
    ...payload,
    provenance_sha256: hashCanonical(payload)
  };
}

export function buildHypothesisReviewAuthorization(input: {
  boundary: HypothesisReviewBoundary;
  proposerInvocations: HypothesisLlmInvocationProvenance[];
  reviewProvenances: HypothesisReviewProvenance[];
}): HypothesisReviewAuthorization {
  const reasonCodes = [...input.boundary.reason_codes];
  const expectedProposerInvocations = input.proposerInvocations.map(
    (invocation) => invocation.invocation_sha256
  );
  if (input.reviewProvenances.length === 0) {
    reasonCodes.push("independent_review_not_completed");
  }
  for (const provenance of input.reviewProvenances) {
    if (
      provenance.proposer.identity_fingerprint_sha256
        !== input.boundary.proposer.identity_fingerprint_sha256
      || provenance.reviewer.identity_fingerprint_sha256
        !== input.boundary.reviewer.identity_fingerprint_sha256
    ) {
      reasonCodes.push("review_provenance_boundary_mismatch");
    }
    const observedProposerInvocations = provenance.proposer_invocations.map(
      (invocation) => invocation.invocation_sha256
    );
    if (
      JSON.stringify(observedProposerInvocations)
        !== JSON.stringify(expectedProposerInvocations)
    ) {
      reasonCodes.push("review_provenance_proposer_invocations_mismatch");
    }
    if (!isHypothesisReviewProvenanceAuthorizing(provenance)) {
      reasonCodes.push(...validateHypothesisReviewProvenance(provenance));
      if (provenance.independence_class !== "independent_review") {
        reasonCodes.push("review_provenance_is_self_review");
      }
      if (!provenance.authorization_eligible) {
        reasonCodes.push("review_provenance_not_authorization_eligible");
      }
    }
  }

  const normalizedReasons = dedupeStrings(reasonCodes);
  const authorized =
    input.boundary.independence_class === "independent_review"
    && input.reviewProvenances.length > 0
    && normalizedReasons.length === 0;
  const payload = {
    schema_version: 1 as const,
    proposer: input.boundary.proposer,
    reviewer: input.boundary.reviewer,
    independence_class: authorized
      ? "independent_review" as const
      : "self_review" as const,
    authorized_for_probe: authorized,
    reason_codes: normalizedReasons,
    completed_review_invocation_sha256s: input.reviewProvenances.map(
      (provenance) => provenance.reviewer_invocation.invocation_sha256
    )
  };
  return {
    ...payload,
    authorization_sha256: hashCanonical(payload)
  };
}

export function buildHypothesisPlanningProvenance(input: {
  boundary: HypothesisReviewBoundary;
  proposerInvocations: HypothesisLlmInvocationProvenance[];
  reviewProvenances: HypothesisReviewProvenance[];
}): HypothesisPlanningProvenance {
  const reviewAuthorization = buildHypothesisReviewAuthorization({
    boundary: input.boundary,
    proposerInvocations: input.proposerInvocations,
    reviewProvenances: input.reviewProvenances
  });
  const payload = {
    schema_version: 1 as const,
    proposer: input.boundary.proposer,
    reviewer: input.boundary.reviewer,
    proposer_invocations: input.proposerInvocations.map(copyInvocation),
    reviewer_invocations: input.reviewProvenances.map(
      (provenance) => copyInvocation(provenance.reviewer_invocation)
    ),
    review_authorization: reviewAuthorization
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function isHypothesisReviewProvenanceAuthorizing(
  value: unknown
): boolean {
  return validateHypothesisReviewProvenance(value).length === 0
    && (value as HypothesisReviewProvenance).independence_class
      === "independent_review"
    && (value as HypothesisReviewProvenance).authorization_eligible === true;
}

export function validateHypothesisReviewProvenance(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["review_provenance_missing"];
  }
  const provenance = value as Partial<HypothesisReviewProvenance>;
  const reasons: string[] = [];
  if (provenance.schema_version !== 1) {
    reasons.push("review_provenance_schema_invalid");
  }
  const proposerReasons = validateResolvedIdentity(provenance.proposer);
  const reviewerReasons = validateResolvedIdentity(provenance.reviewer);
  if (proposerReasons.length > 0) {
    reasons.push("review_provenance_proposer_identity_invalid");
  }
  if (reviewerReasons.length > 0) {
    reasons.push("review_provenance_reviewer_identity_invalid");
  }
  if (
    provenance.proposer?.identity_fingerprint_sha256
    && provenance.reviewer?.identity_fingerprint_sha256
    && provenance.proposer.identity_fingerprint_sha256
      === provenance.reviewer.identity_fingerprint_sha256
  ) {
    reasons.push("review_provenance_identity_not_independent");
  }
  if (
    !Array.isArray(provenance.proposer_invocations)
    || provenance.proposer_invocations.length === 0
  ) {
    reasons.push("review_provenance_proposer_invocations_missing");
  } else {
    for (const invocation of provenance.proposer_invocations) {
      if (
        invocation.role !== "proposer"
        || invocation.actor.identity_fingerprint_sha256
          !== provenance.proposer?.identity_fingerprint_sha256
        || validateHypothesisLlmInvocationProvenance(invocation).length > 0
      ) {
        reasons.push("review_provenance_proposer_invocation_invalid");
        break;
      }
    }
  }
  if (
    !provenance.reviewer_invocation
    || provenance.reviewer_invocation.role !== "reviewer"
    || provenance.reviewer_invocation.stage !== "hypothesis_review"
    || provenance.reviewer_invocation.actor.identity_fingerprint_sha256
      !== provenance.reviewer?.identity_fingerprint_sha256
    || validateHypothesisLlmInvocationProvenance(
      provenance.reviewer_invocation
    ).length > 0
  ) {
    reasons.push("review_provenance_reviewer_invocation_invalid");
  }
  if (provenance.independence_class !== "independent_review") {
    reasons.push("review_provenance_independence_class_invalid");
  }
  if (provenance.authorization_eligible !== true) {
    reasons.push("review_provenance_authorization_ineligible");
  }
  if (!Array.isArray(provenance.reason_codes)) {
    reasons.push("review_provenance_reason_codes_invalid");
  } else if (provenance.reason_codes.length > 0) {
    reasons.push("review_provenance_has_blocking_reasons");
  }

  if (
    !isSha256(provenance.provenance_sha256)
    || hashCanonical(reviewProvenancePayload(provenance))
      !== provenance.provenance_sha256
  ) {
    reasons.push("review_provenance_hash_invalid");
  }
  return dedupeStrings(reasons);
}

export function validateHypothesisLlmInvocationProvenance(
  value: unknown
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["llm_invocation_provenance_missing"];
  }
  const invocation = value as Partial<HypothesisLlmInvocationProvenance>;
  const reasons: string[] = [];
  if (
    invocation.schema_version !== 1
    || (invocation.role !== "proposer" && invocation.role !== "reviewer")
    || !isHypothesisInvocationStage(invocation.stage)
    || !Number.isInteger(invocation.invocation_index)
    || (invocation.invocation_index ?? 0) < 1
  ) {
    reasons.push("llm_invocation_shape_invalid");
  }
  if (validateResolvedIdentity(invocation.actor).length > 0) {
    reasons.push("llm_invocation_actor_invalid");
  }
  if (!isSha256(invocation.input_sha256)) {
    reasons.push("llm_invocation_input_hash_invalid");
  }
  if (!isSha256(invocation.output_sha256)) {
    reasons.push("llm_invocation_output_hash_invalid");
  }
  if (
    !isSha256(invocation.invocation_sha256)
    || hashCanonical(invocationPayload(invocation))
      !== invocation.invocation_sha256
  ) {
    reasons.push("llm_invocation_hash_invalid");
  }
  return dedupeStrings(reasons);
}

export function resolveHypothesisLlmIdentity(
  value: HypothesisLlmIdentity | undefined
): ResolvedHypothesisLlmIdentity {
  const identity = normalizeOptionalText(value?.identity);
  const backend = normalizeOptionalText(value?.backend);
  const provider = normalizeOptionalText(value?.provider);
  const model = normalizeOptionalText(value?.model);
  const tupleComplete = Boolean(backend && provider && model);
  const identitySource = identity
    ? "caller_supplied" as const
    : tupleComplete
      ? "backend_provider_model" as const
      : "missing" as const;
  const identityPayload = identity
    ? { identity_source: identitySource, identity }
    : tupleComplete
      ? {
          identity_source: identitySource,
          backend,
          provider,
          model
        }
      : undefined;
  return {
    identity: identity ?? null,
    backend: backend ?? null,
    provider: provider ?? null,
    model: model ?? null,
    identity_source: identitySource,
    identity_fingerprint_sha256: identityPayload
      ? hashCanonical(identityPayload)
      : null
  };
}

function validateResolvedIdentity(
  value: unknown
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["resolved_identity_missing"];
  }
  const identity = value as Partial<ResolvedHypothesisLlmIdentity>;
  const reasons: string[] = [];
  const normalized = resolveHypothesisLlmIdentity({
    identity: normalizeOptionalText(identity.identity) || undefined,
    backend: normalizeOptionalText(identity.backend) || undefined,
    provider: normalizeOptionalText(identity.provider) || undefined,
    model: normalizeOptionalText(identity.model) || undefined
  });
  if (
    identity.identity_source !== normalized.identity_source
    || identity.identity_fingerprint_sha256
      !== normalized.identity_fingerprint_sha256
    || !normalized.identity_fingerprint_sha256
  ) {
    reasons.push("resolved_identity_invalid");
  }
  return reasons;
}

function invocationPayload(
  invocation: Partial<HypothesisLlmInvocationProvenance>
): Omit<HypothesisLlmInvocationProvenance, "invocation_sha256"> {
  return {
    schema_version: invocation.schema_version as 1,
    role: invocation.role as HypothesisLlmInvocationProvenance["role"],
    stage: invocation.stage as HypothesisLlmInvocationStage,
    invocation_index: invocation.invocation_index as number,
    actor: invocation.actor as ResolvedHypothesisLlmIdentity,
    input_sha256: invocation.input_sha256 as string,
    output_sha256: invocation.output_sha256 as string
  };
}

function reviewProvenancePayload(
  provenance: Partial<HypothesisReviewProvenance>
): Omit<HypothesisReviewProvenance, "provenance_sha256"> {
  return {
    schema_version: provenance.schema_version as 1,
    proposer: provenance.proposer as ResolvedHypothesisLlmIdentity,
    reviewer: provenance.reviewer as ResolvedHypothesisLlmIdentity,
    proposer_invocations:
      provenance.proposer_invocations as HypothesisLlmInvocationProvenance[],
    reviewer_invocation:
      provenance.reviewer_invocation as HypothesisLlmInvocationProvenance,
    independence_class:
      provenance.independence_class as HypothesisReviewIndependenceClass,
    authorization_eligible: provenance.authorization_eligible as boolean,
    reason_codes: provenance.reason_codes as string[]
  };
}

function copyInvocation(
  invocation: HypothesisLlmInvocationProvenance
): HypothesisLlmInvocationProvenance {
  return {
    ...invocation,
    actor: { ...invocation.actor }
  };
}

function isHypothesisInvocationStage(
  value: unknown
): value is HypothesisLlmInvocationStage {
  return typeof value === "string"
    && /^[a-z][a-z0-9_]{0,63}$/u.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
