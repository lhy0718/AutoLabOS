export const PROMOTION_TRIAL_CANDIDATE_ANNOTATION_SCHEMA = "reviewer/annotation-schema.json";
export const PROMOTION_TRIAL_CANDIDATE_RESOLUTION_SCHEMA = "reviewer/resolution-schema.json";
export const PROMOTION_TRIAL_CANDIDATE_RUBRIC = "reviewer/RUBRIC.md";
export const PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK = "license/source-license-task.json";
export const PROMOTION_TRIAL_CANDIDATE_LICENSE_SCHEMA = "license/license-review-schema.json";
export const PROMOTION_TRIAL_CANDIDATE_LICENSE_GUIDE = "license/REVIEWER_GUIDE.md";

export const PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS = [
  "execution_trace_completeness",
  "repeated_trial_comparability",
  "comparison_result_availability",
  "explicit_readiness_availability",
  "figure_audit_availability",
  "claim_evidence_link_availability"
] as const;

export type PromotionTrialCandidateObservation =
  typeof PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS[number];

export type PromotionTrialCandidateObservationValue =
  | "positive"
  | "negative"
  | "uncertain";

export type PromotionTrialCandidateLicenseStatus =
  | "redistribution_permitted"
  | "local_evaluation_only"
  | "redistribution_prohibited"
  | "uncertain";

export interface PromotionTrialCandidateEvidenceRef {
  trial_id: string;
  observations: PromotionTrialCandidateObservation[];
  json_pointers: string[];
}

export interface PromotionTrialCandidateHumanLabel {
  candidate_id: string;
  observations: Record<PromotionTrialCandidateObservation, PromotionTrialCandidateObservationValue>;
  evidence_refs: PromotionTrialCandidateEvidenceRef[];
  rationale: string;
}

export interface PromotionTrialCandidateLicenseReview {
  status: PromotionTrialCandidateLicenseStatus;
  evidence_refs: string[];
  rationale: string;
}

export interface PromotionTrialCandidateInitialAnnotationSet {
  schema_version: "1.0";
  handoff_id: string;
  annotator_id: string;
  label_source: "human";
  review_role: "initial";
  independence_attestation: {
    completed_by_human: true;
    peer_annotations_unseen: true;
    controller_map_unseen: true;
  };
  annotations: PromotionTrialCandidateHumanLabel[];
}

export interface PromotionTrialCandidateResolutionSet {
  schema_version: "1.0";
  handoff_id: string;
  resolver_id: string;
  label_source: "human";
  review_role: "resolver";
  independence_attestation: {
    completed_by_human: true;
    controller_map_unseen: true;
  };
  resolutions: PromotionTrialCandidateHumanLabel[];
}

export interface PromotionTrialCandidateLicenseReviewSet {
  schema_version: "1.0";
  handoff_id: string;
  reviewer_id: string;
  label_source: "human";
  review_role: "source_license";
  independence_attestation: {
    completed_by_human: true;
    candidate_annotations_unseen: true;
    controller_map_unseen: true;
  };
  review: PromotionTrialCandidateLicenseReview;
}

const OBSERVATION_VALUES = new Set<PromotionTrialCandidateObservationValue>([
  "positive",
  "negative",
  "uncertain"
]);

const LICENSE_STATUSES = new Set<PromotionTrialCandidateLicenseStatus>([
  "redistribution_permitted",
  "local_evaluation_only",
  "redistribution_prohibited",
  "uncertain"
]);

export function parsePromotionTrialCandidateInitialAnnotationSet(
  value: unknown
): PromotionTrialCandidateInitialAnnotationSet {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version",
        "handoff_id",
        "annotator_id",
        "label_source",
        "review_role",
        "independence_attestation",
        "annotations"
      ])
      || value.schema_version !== "1.0"
      || !validId(value.handoff_id)
      || !validId(value.annotator_id)
      || value.label_source !== "human"
      || value.review_role !== "initial"
      || !validInitialAttestation(value.independence_attestation)
      || !Array.isArray(value.annotations)) {
    throw new Error("Trial-candidate initial annotation set is invalid.");
  }
  return {
    schema_version: "1.0",
    handoff_id: value.handoff_id,
    annotator_id: value.annotator_id,
    label_source: "human",
    review_role: "initial",
    independence_attestation: {
      completed_by_human: true,
      peer_annotations_unseen: true,
      controller_map_unseen: true
    },
    annotations: value.annotations.map(parseHumanLabel)
  };
}

export function parsePromotionTrialCandidateResolutionSet(
  value: unknown
): PromotionTrialCandidateResolutionSet {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version",
        "handoff_id",
        "resolver_id",
        "label_source",
        "review_role",
        "independence_attestation",
        "resolutions"
      ])
      || value.schema_version !== "1.0"
      || !validId(value.handoff_id)
      || !validId(value.resolver_id)
      || value.label_source !== "human"
      || value.review_role !== "resolver"
      || !validResolverAttestation(value.independence_attestation)
      || !Array.isArray(value.resolutions)) {
    throw new Error("Trial-candidate resolution set is invalid.");
  }
  return {
    schema_version: "1.0",
    handoff_id: value.handoff_id,
    resolver_id: value.resolver_id,
    label_source: "human",
    review_role: "resolver",
    independence_attestation: {
      completed_by_human: true,
      controller_map_unseen: true
    },
    resolutions: value.resolutions.map(parseHumanLabel)
  };
}

export function parsePromotionTrialCandidateLicenseReviewSet(
  value: unknown
): PromotionTrialCandidateLicenseReviewSet {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version",
        "handoff_id",
        "reviewer_id",
        "label_source",
        "review_role",
        "independence_attestation",
        "review"
      ])
      || value.schema_version !== "1.0"
      || !validId(value.handoff_id)
      || !validId(value.reviewer_id)
      || value.label_source !== "human"
      || value.review_role !== "source_license"
      || !validLicenseAttestation(value.independence_attestation)) {
    throw new Error("Trial-candidate source-license review set is invalid.");
  }
  return {
    schema_version: "1.0",
    handoff_id: value.handoff_id,
    reviewer_id: value.reviewer_id,
    label_source: "human",
    review_role: "source_license",
    independence_attestation: {
      completed_by_human: true,
      candidate_annotations_unseen: true,
      controller_map_unseen: true
    },
    review: parseLicenseReview(value.review)
  };
}

export function promotionTrialCandidateHumanLabelsEqual(
  left: PromotionTrialCandidateHumanLabel,
  right: PromotionTrialCandidateHumanLabel
): boolean {
  return PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.every((field) =>
    left.observations[field] === right.observations[field]);
}

export function promotionTrialCandidateAnnotationSchema(): Record<string, unknown> {
  const observationProperties = Object.fromEntries(
    PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.map((field) => [field, {
      type: "string",
      enum: ["positive", "negative", "uncertain"]
    }])
  );
  const evidenceRef = {
    type: "object",
    additionalProperties: false,
    required: ["trial_id", "observations", "json_pointers"],
    properties: {
      trial_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
      observations: {
        type: "array",
        minItems: 1,
        maxItems: PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.length,
        uniqueItems: true,
        items: { type: "string", enum: [...PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS] }
      },
      json_pointers: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        uniqueItems: true,
        items: { type: "string", maxLength: 512 }
      }
    }
  };
  const humanLabel = {
    type: "object",
    additionalProperties: false,
    required: ["candidate_id", "observations", "evidence_refs", "rationale"],
    properties: {
      candidate_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
      observations: {
        type: "object",
        additionalProperties: false,
        required: [...PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS],
        properties: observationProperties
      },
      evidence_refs: {
        type: "array",
        maxItems: 96,
        items: evidenceRef
      },
      rationale: { type: "string", minLength: 1, maxLength: 4000 }
    }
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Promotion Trial Candidate Initial Human Annotation Set",
    type: "object",
    additionalProperties: false,
    required: [
      "schema_version",
      "handoff_id",
      "annotator_id",
      "label_source",
      "review_role",
      "independence_attestation",
      "annotations"
    ],
    properties: {
      schema_version: { const: "1.0" },
      handoff_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
      annotator_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
      label_source: { const: "human" },
      review_role: { const: "initial" },
      independence_attestation: {
        type: "object",
        additionalProperties: false,
        required: ["completed_by_human", "peer_annotations_unseen", "controller_map_unseen"],
        properties: {
          completed_by_human: { const: true },
          peer_annotations_unseen: { const: true },
          controller_map_unseen: { const: true }
        }
      },
      annotations: { type: "array", minItems: 1, items: humanLabel }
    }
  };
}

export function promotionTrialCandidateResolutionSchema(): Record<string, unknown> {
  const initialSchema = promotionTrialCandidateAnnotationSchema() as {
    properties: {
      annotations: { items: Record<string, unknown> };
    };
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Promotion Trial Candidate Human Resolution Set",
    type: "object",
    additionalProperties: false,
    required: [
      "schema_version",
      "handoff_id",
      "resolver_id",
      "label_source",
      "review_role",
      "independence_attestation",
      "resolutions"
    ],
    properties: {
      schema_version: { const: "1.0" },
      handoff_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
      resolver_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
      label_source: { const: "human" },
      review_role: { const: "resolver" },
      independence_attestation: {
        type: "object",
        additionalProperties: false,
        required: ["completed_by_human", "controller_map_unseen"],
        properties: {
          completed_by_human: { const: true },
          controller_map_unseen: { const: true }
        }
      },
      resolutions: {
        type: "array",
        items: initialSchema.properties.annotations.items
      }
    }
  };
}

export function promotionTrialCandidateLicenseReviewSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Promotion Trial Candidate Source-License Human Review",
    type: "object",
    additionalProperties: false,
    required: [
      "schema_version",
      "handoff_id",
      "reviewer_id",
      "label_source",
      "review_role",
      "independence_attestation",
      "review"
    ],
    properties: {
      schema_version: { const: "1.0" },
      handoff_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
      reviewer_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
      label_source: { const: "human" },
      review_role: { const: "source_license" },
      independence_attestation: {
        type: "object",
        additionalProperties: false,
        required: ["completed_by_human", "candidate_annotations_unseen", "controller_map_unseen"],
        properties: {
          completed_by_human: { const: true },
          candidate_annotations_unseen: { const: true },
          controller_map_unseen: { const: true }
        }
      },
      review: {
        type: "object",
        additionalProperties: false,
        required: ["status", "evidence_refs", "rationale"],
        properties: {
          status: {
            type: "string",
            enum: [
              "redistribution_permitted",
              "local_evaluation_only",
              "redistribution_prohibited",
              "uncertain"
            ]
          },
          evidence_refs: {
            type: "array",
            maxItems: 16,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 2048 }
          },
          rationale: { type: "string", minLength: 1, maxLength: 4000 }
        }
      }
    }
  };
}

export function promotionTrialCandidateReviewRubric(): string {
  return [
    "# Trial Candidate Review Rubric",
    "",
    "Use only the opaque reviewer artifacts. Do not inspect the controller map, source group labels, peer annotations, or downstream outcomes.",
    "",
    "For every observation, record `positive` only when the trace artifacts contain direct evidence, `negative` when direct evidence shows the requirement is absent or violated, and `uncertain` when the packet cannot support either conclusion.",
    "",
    "- `execution_trace_completeness`: all three traces contain enough ordered execution evidence to audit the run.",
    "- `repeated_trial_comparability`: the three traces describe the same governed object under a comparable protocol.",
    "- `comparison_result_availability`: a machine-readable baseline/comparator result is present.",
    "- `explicit_readiness_availability`: an explicit paper-readiness or blocked decision is present.",
    "- `figure_audit_availability`: a source-grounded figure audit is present.",
    "- `claim_evidence_link_availability`: explicit claim-to-evidence links are present.",
    "",
    "A positive completeness or comparability label must cite all three trial IDs. Every other positive label must cite at least one trial. Evidence references use trial IDs plus JSON Pointers; an empty pointer identifies the whole JSON document.",
    "",
    "The annotation file must be completed by a human without peer annotations or the controller map. Pseudonymous IDs and attestations support process checking but do not prove real-world identity or expertise.",
    ""
  ].join("\n");
}

export function promotionTrialCandidateReviewerGuide(): string {
  return [
    "# Trial Candidate Review Guide",
    "",
    "Review only `candidate-tasks.jsonl`, the two JSON Schemas, `RUBRIC.md`, and the opaque artifacts in this directory.",
    "Each candidate contains three revision-bound source traces selected before content inspection.",
    "Reviewer artifacts may replace private machine paths with `<private-path>`; raw and reviewer hashes remain separate in the controller manifest.",
    "Create one JSON annotation set that validates against `annotation-schema.json`. Use one stable pseudonymous annotator ID across the file.",
    "Record unavailable evidence as negative or uncertain according to the rubric. Do not infer completion, comparability, readiness, figure review, or claim links from filenames or task descriptions.",
    "Do not read another reviewer's file before submitting the initial annotation set. A distinct resolver uses `resolution-schema.json` only after disagreements are identified.",
    "This packet is a local candidate-triage handoff, not a confirmatory benchmark, a license grant, or paper-readiness evidence.",
    ""
  ].join("\n");
}

export function promotionTrialCandidateLicenseReviewerGuide(): string {
  return [
    "# Source-License Review Guide",
    "",
    "Review only `source-license-task.json`, `license-review-schema.json`, and public source-license or permission evidence for the exact URL and revision in the task.",
    "Do not inspect candidate artifacts, candidate annotations, peer decisions, or the controller map.",
    "Use `redistribution_permitted` only when an HTTPS license or permission reference directly supports redistribution of the selected source material. Absence of a license is not permission.",
    "Use `local_evaluation_only` when local inspection is supportable but redistribution is not, `redistribution_prohibited` when direct evidence prohibits it, and `uncertain` when the available evidence cannot establish a status.",
    "Create one JSON review that validates against `license-review-schema.json`. Pseudonymous identity and attestations support process checking but do not prove real-world identity, expertise, or legal authority.",
    "This review records a human evidence assessment; AutoLabOS does not turn it into a legal grant or confirmatory admission.",
    ""
  ].join("\n");
}

function parseHumanLabel(value: unknown): PromotionTrialCandidateHumanLabel {
  if (!isRecord(value)
      || !hasExactKeys(value, ["candidate_id", "observations", "evidence_refs", "rationale"])
      || !validId(value.candidate_id)
      || !isRecord(value.observations)
      || !hasExactKeys(value.observations, [...PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS])
      || !Array.isArray(value.evidence_refs)
      || value.evidence_refs.length > 96
      || !boundedText(value.rationale, 4000)) {
    throw new Error("Trial-candidate human label is invalid.");
  }
  const observationRecord = value.observations;
  const observations = Object.fromEntries(PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.map((field) => {
    const fieldValue = observationRecord[field];
    if (!OBSERVATION_VALUES.has(fieldValue as PromotionTrialCandidateObservationValue)) {
      throw new Error(`Trial-candidate observation is invalid: ${field}.`);
    }
    return [field, fieldValue];
  })) as Record<PromotionTrialCandidateObservation, PromotionTrialCandidateObservationValue>;
  return {
    candidate_id: value.candidate_id,
    observations,
    evidence_refs: value.evidence_refs.map(parseEvidenceRef),
    rationale: value.rationale.trim()
  };
}

function parseEvidenceRef(value: unknown): PromotionTrialCandidateEvidenceRef {
  if (!isRecord(value)
      || !hasExactKeys(value, ["trial_id", "observations", "json_pointers"])
      || !validId(value.trial_id)
      || !Array.isArray(value.observations)
      || value.observations.length === 0
      || value.observations.length > PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.length
      || new Set(value.observations).size !== value.observations.length
      || !value.observations.every((item) =>
        PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.includes(item as PromotionTrialCandidateObservation))
      || !Array.isArray(value.json_pointers)
      || value.json_pointers.length === 0
      || value.json_pointers.length > 32
      || new Set(value.json_pointers).size !== value.json_pointers.length
      || !value.json_pointers.every(validJsonPointer)) {
    throw new Error("Trial-candidate evidence reference is invalid.");
  }
  return {
    trial_id: value.trial_id,
    observations: value.observations as PromotionTrialCandidateObservation[],
    json_pointers: [...value.json_pointers]
  };
}

function parseLicenseReview(value: unknown): PromotionTrialCandidateLicenseReview {
  if (!isRecord(value)
      || !hasExactKeys(value, ["status", "evidence_refs", "rationale"])
      || !LICENSE_STATUSES.has(value.status as PromotionTrialCandidateLicenseStatus)
      || !Array.isArray(value.evidence_refs)
      || value.evidence_refs.length > 16
      || new Set(value.evidence_refs).size !== value.evidence_refs.length
      || !value.evidence_refs.every((item) => boundedText(item, 2048))
      || !boundedText(value.rationale, 4000)) {
    throw new Error("Trial-candidate source-license review is invalid.");
  }
  if (value.status === "redistribution_permitted"
      && (value.evidence_refs.length === 0 || !value.evidence_refs.every(validHttpsUrl))) {
    throw new Error("Redistribution permission requires at least one HTTPS evidence reference.");
  }
  return {
    status: value.status as PromotionTrialCandidateLicenseStatus,
    evidence_refs: value.evidence_refs.map((item) => String(item).trim()),
    rationale: value.rationale.trim()
  };
}

function validInitialAttestation(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["completed_by_human", "peer_annotations_unseen", "controller_map_unseen"])
    && value.completed_by_human === true
    && value.peer_annotations_unseen === true
    && value.controller_map_unseen === true;
}

function validResolverAttestation(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["completed_by_human", "controller_map_unseen"])
    && value.completed_by_human === true
    && value.controller_map_unseen === true;
}

function validLicenseAttestation(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ["completed_by_human", "candidate_annotations_unseen", "controller_map_unseen"])
    && value.completed_by_human === true
    && value.candidate_annotations_unseen === true
    && value.controller_map_unseen === true;
}

function validJsonPointer(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 512
    && (value === "" || (value.startsWith("/") && !/~(?:[^01]|$)/u.test(value)));
}

function validHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maxLength
    && !value.includes("\0");
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
