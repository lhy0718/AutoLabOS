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

export const PROMOTION_TRIAL_CANDIDATE_SOURCE_ELIGIBILITY_OBSERVATIONS = [
  "execution_trace_completeness",
  "repeated_trial_comparability"
] as const satisfies readonly PromotionTrialCandidateObservation[];

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

export type PromotionTrialCandidateLicenseSubjectKind =
  | "source_collection"
  | "base_material"
  | "operator_output";

export interface PromotionTrialCandidateLicenseSubject {
  subject_id: string;
  subject_kind: PromotionTrialCandidateLicenseSubjectKind;
  source_url: string;
  source_revision: string | null;
  declared_license: string | null;
  evidence_refs: string[];
  evidence_files: string[];
}

export interface PromotionTrialCandidateSourceOnlyLicenseTask {
  schema_version: "1.0";
  handoff_id: string;
  source_url: string;
  source_revision: string;
  evidence_files: Array<{ path: string; sha256: string }>;
  required_decision: "distribution_scope";
}

export interface PromotionTrialCandidateScopedLicenseTask {
  schema_version: "1.1";
  handoff_id: string;
  source_url: string;
  source_revision: string;
  evidence_files: Array<{ path: string; sha256: string }>;
  required_decision: "candidate_scoped_distribution";
  subjects: PromotionTrialCandidateLicenseSubject[];
  candidate_requirements: Array<{
    candidate_id: string;
    subject_ids: string[];
  }>;
}

export type PromotionTrialCandidateLicenseTask =
  | PromotionTrialCandidateSourceOnlyLicenseTask
  | PromotionTrialCandidateScopedLicenseTask;

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

export interface PromotionTrialCandidateSourceOnlyLicenseReviewSet {
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

export interface PromotionTrialCandidateScopedLicenseReviewSet {
  schema_version: "1.1";
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
  subject_reviews: Array<PromotionTrialCandidateLicenseReview & {
    subject_id: string;
  }>;
}

export type PromotionTrialCandidateLicenseReviewSet =
  | PromotionTrialCandidateSourceOnlyLicenseReviewSet
  | PromotionTrialCandidateScopedLicenseReviewSet;

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

export function parsePromotionTrialCandidateLicenseTask(
  value: unknown
): PromotionTrialCandidateLicenseTask {
  if (!isRecord(value)
      || !validId(value.handoff_id)
      || !validHttpsUrl(value.source_url)
      || !sha1String(value.source_revision)
      || !validTaskEvidenceFiles(value.evidence_files)) {
    throw new Error("Trial-candidate source-license task is invalid.");
  }
  const evidenceFiles = (value.evidence_files as Array<Record<string, unknown>>).map((item) => ({
    path: item.path as string,
    sha256: item.sha256 as string
  }));
  if (value.schema_version === "1.0") {
    if (!hasExactKeys(value, [
      "schema_version",
      "handoff_id",
      "source_url",
      "source_revision",
      "evidence_files",
      "required_decision"
    ]) || value.required_decision !== "distribution_scope") {
      throw new Error("Trial-candidate source-only license task is invalid.");
    }
    return {
      schema_version: "1.0",
      handoff_id: value.handoff_id,
      source_url: value.source_url as string,
      source_revision: value.source_revision,
      evidence_files: evidenceFiles,
      required_decision: "distribution_scope"
    };
  }
  if (value.schema_version !== "1.1"
      || !hasExactKeys(value, [
        "schema_version",
        "handoff_id",
        "source_url",
        "source_revision",
        "evidence_files",
        "required_decision",
        "subjects",
        "candidate_requirements"
      ])
      || value.required_decision !== "candidate_scoped_distribution"
      || !Array.isArray(value.subjects)
      || value.subjects.length < 3
      || value.subjects.length > 512
      || !Array.isArray(value.candidate_requirements)
      || value.candidate_requirements.length === 0
      || value.candidate_requirements.length > 512) {
    throw new Error("Trial-candidate candidate-scoped license task is invalid.");
  }
  const evidencePaths = new Set(evidenceFiles.map((item) => item.path));
  const subjects = value.subjects.map((item) => parseLicenseSubject(item, evidencePaths));
  const subjectById = new Map(subjects.map((item) => [item.subject_id, item]));
  if (subjectById.size !== subjects.length) {
    throw new Error("Candidate-scoped license subjects must be unique.");
  }
  const requirements = value.candidate_requirements.map((item) =>
    parseLicenseCandidateRequirement(item, subjectById));
  if (new Set(requirements.map((item) => item.candidate_id)).size !== requirements.length) {
    throw new Error("Candidate-scoped license requirements must contain unique candidates.");
  }
  const collectionSubjects = subjects.filter((item) => item.subject_kind === "source_collection");
  if (collectionSubjects.length !== 1
      || collectionSubjects[0].source_url !== value.source_url
      || collectionSubjects[0].source_revision !== value.source_revision) {
    throw new Error("Candidate-scoped licensing requires one task-bound source collection.");
  }
  const usage = new Map(subjects.map((item) => [item.subject_id, 0]));
  for (const requirement of requirements) {
    const requiredSubjects = requirement.subject_ids.map((id) => subjectById.get(id) as PromotionTrialCandidateLicenseSubject);
    if (requiredSubjects.filter((item) => item.subject_kind === "source_collection").length !== 1
        || requiredSubjects.filter((item) => item.subject_kind === "base_material").length !== 1
        || requiredSubjects.filter((item) => item.subject_kind === "operator_output").length < 1) {
      throw new Error("Every candidate requires collection, base-material, and operator-output license subjects.");
    }
    for (const subjectId of requirement.subject_ids) {
      usage.set(subjectId, (usage.get(subjectId) || 0) + 1);
    }
  }
  if (subjects.some((item) => (usage.get(item.subject_id) || 0) === 0)
      || collectionSubjects.some((item) => usage.get(item.subject_id) !== requirements.length)) {
    throw new Error("Candidate-scoped license subjects must have exact candidate coverage.");
  }
  const usedEvidenceFiles = new Set(subjects.flatMap((item) => item.evidence_files));
  if ([...evidencePaths].some((item) => !usedEvidenceFiles.has(item))) {
    throw new Error("Every task evidence file must support at least one license subject.");
  }
  return {
    schema_version: "1.1",
    handoff_id: value.handoff_id,
    source_url: value.source_url,
    source_revision: value.source_revision,
    evidence_files: evidenceFiles,
    required_decision: "candidate_scoped_distribution",
    subjects,
    candidate_requirements: requirements
  };
}

export function parsePromotionTrialCandidateLicenseReviewSet(
  value: unknown
): PromotionTrialCandidateLicenseReviewSet {
  if (!isRecord(value)
      || !validId(value.handoff_id)
      || !validId(value.reviewer_id)
      || value.label_source !== "human"
      || value.review_role !== "source_license"
      || !validLicenseAttestation(value.independence_attestation)) {
    throw new Error("Trial-candidate source-license review set is invalid.");
  }
  const common = {
    handoff_id: value.handoff_id,
    reviewer_id: value.reviewer_id,
    label_source: "human" as const,
    review_role: "source_license" as const,
    independence_attestation: {
      completed_by_human: true as const,
      candidate_annotations_unseen: true as const,
      controller_map_unseen: true as const
    },
    review: parseLicenseReview(value.review)
  };
  if (value.schema_version === "1.0") {
    if (!hasExactKeys(value, [
      "schema_version",
      "handoff_id",
      "reviewer_id",
      "label_source",
      "review_role",
      "independence_attestation",
      "review"
    ])) {
      throw new Error("Trial-candidate source-only license review set is invalid.");
    }
    return {
      schema_version: "1.0",
      ...common
    };
  }
  if (value.schema_version !== "1.1"
      || !hasExactKeys(value, [
        "schema_version",
        "handoff_id",
        "reviewer_id",
        "label_source",
        "review_role",
        "independence_attestation",
        "review",
        "subject_reviews"
      ])
      || !Array.isArray(value.subject_reviews)
      || value.subject_reviews.length === 0
      || value.subject_reviews.length > 512) {
    throw new Error("Trial-candidate candidate-scoped license review set is invalid.");
  }
  const subjectReviews = value.subject_reviews.map(parseLicenseSubjectReview);
  if (new Set(subjectReviews.map((item) => item.subject_id)).size !== subjectReviews.length
      || common.review.status !== aggregateLicenseStatuses(
        subjectReviews.map((item) => item.status)
      )) {
    throw new Error("Candidate-scoped license reviews require unique subjects and a conservative aggregate status.");
  }
  return {
    schema_version: "1.1",
    ...common,
    subject_reviews: subjectReviews
  };
}

export function validatePromotionTrialCandidateLicenseReviewCoverage(
  review: PromotionTrialCandidateLicenseReviewSet,
  task: PromotionTrialCandidateLicenseTask
): void {
  if (review.schema_version !== task.schema_version) {
    throw new Error("Source-license review scope does not match the task scope.");
  }
  if (task.schema_version === "1.0") return;
  const scopedReview = review as PromotionTrialCandidateScopedLicenseReviewSet;
  const expected = task.subjects.map((item) => item.subject_id).sort();
  const observed = scopedReview.subject_reviews.map((item) => item.subject_id).sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw new Error("Candidate-scoped source-license review must cover every declared subject exactly once.");
  }
}

export function promotionTrialCandidateLicenseTaskIsCandidateScoped(
  task: PromotionTrialCandidateLicenseTask
): task is PromotionTrialCandidateScopedLicenseTask {
  return task.schema_version === "1.1";
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

export function promotionTrialCandidateLicenseReviewSchema(
  candidateScoped = false
): Record<string, unknown> {
  const licenseReview = {
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
  };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: candidateScoped
      ? "Promotion Trial Candidate-Scoped Source-License Human Review"
      : "Promotion Trial Candidate Source-License Human Review",
    type: "object",
    additionalProperties: false,
    required: [
      "schema_version",
      "handoff_id",
      "reviewer_id",
      "label_source",
      "review_role",
      "independence_attestation",
      "review",
      ...(candidateScoped ? ["subject_reviews"] : [])
    ],
    properties: {
      schema_version: { const: candidateScoped ? "1.1" : "1.0" },
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
      review: licenseReview,
      ...(candidateScoped
        ? {
            subject_reviews: {
              type: "array",
              minItems: 1,
              maxItems: 512,
              items: {
                ...licenseReview,
                required: ["subject_id", "status", "evidence_refs", "rationale"],
                properties: {
                  subject_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,127}$" },
                  ...licenseReview.properties
                }
              }
            }
          }
        : {})
    }
  };
}

export function promotionTrialCandidateReviewRubric(pairedOperator = false): string {
  if (pairedOperator) {
    return [
      "# Paired Trial Candidate Review Rubric",
      "",
      "Use only the opaque reviewer artifacts. Do not inspect the controller map, source group labels, peer annotations, or downstream outcomes.",
      "",
      "Each candidate contains two opaque groups, `group-a` and `group-b`, with three traces in each group. The group names do not identify a source operator or preferred system.",
      "",
      "For every observation, record `positive` only when the trace artifacts contain direct evidence, `negative` when direct evidence shows the requirement is absent or violated, and `uncertain` when the packet cannot support either conclusion.",
      "",
      "- `execution_trace_completeness`: all six traces contain enough ordered execution evidence to audit the runs.",
      "- `repeated_trial_comparability`: the three traces within each group and the two groups describe the same governed object under comparable conditions.",
      "- `comparison_result_availability`: a machine-readable result explicitly compares the two groups or another declared baseline/comparator.",
      "- `explicit_readiness_availability`: an explicit paper-readiness or blocked decision is present.",
      "- `figure_audit_availability`: a source-grounded figure audit is present.",
      "- `claim_evidence_link_availability`: explicit claim-to-evidence links are present.",
      "",
      "A positive completeness or comparability label must cite all six trial IDs. Every other positive label must cite at least one trial. Evidence references use trial IDs plus JSON Pointers; an empty pointer identifies the whole JSON document.",
      "",
      "The annotation file must be completed by a human without peer annotations or the controller map. Pseudonymous IDs and attestations support process checking but do not prove real-world identity or expertise.",
      ""
    ].join("\n");
  }
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

export function promotionTrialCandidateReviewerGuide(pairedOperator = false): string {
  if (pairedOperator) {
    return [
      "# Paired Trial Candidate Review Guide",
      "",
      "Review only `candidate-tasks.jsonl`, the two JSON Schemas, `RUBRIC.md`, and the opaque artifacts in this directory.",
      "Each candidate contains two anonymous source-operator groups with three revision-bound traces per group, selected before content inspection.",
      "Use `trial_groups` to distinguish `group-a` from `group-b`; do not infer source identity, quality ordering, or preferred status from the group names.",
      "Reviewer artifacts may replace private machine paths with `<private-path>`; raw and reviewer hashes remain separate in the controller manifest.",
      "Create one JSON annotation set that validates against `annotation-schema.json`. Use one stable pseudonymous annotator ID across the file.",
      "Record unavailable evidence as negative or uncertain according to the rubric. Do not infer completion, comparability, readiness, figure review, or claim links from filenames or task descriptions.",
      "Do not read another reviewer's file before submitting the initial annotation set. A distinct resolver uses `resolution-schema.json` only after disagreements are identified.",
      "This packet is a local paired-candidate triage handoff, not proof of independent stochastic repeats, a confirmatory benchmark, a license grant, or paper-readiness evidence.",
      ""
    ].join("\n");
  }
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

export function promotionTrialCandidateLicenseReviewerGuide(
  candidateScoped = false
): string {
  return [
    "# Source-License Review Guide",
    "",
    candidateScoped
      ? "Review every subject in `source-license-task.json` using `license-review-schema.json` and the task-declared public evidence."
      : "Review only `source-license-task.json`, `license-review-schema.json`, and public source-license or permission evidence for the exact URL and revision in the task.",
    "Do not inspect candidate artifacts, candidate annotations, peer decisions, or the controller map.",
    candidateScoped
      ? "Assess the collection, each selected base material, and every operator-output condition. Do not infer one subject's permission from another subject."
      : "This source-only task cannot establish candidate-scoped redistribution coverage.",
    "Use `redistribution_permitted` only when an HTTPS license or permission reference directly supports redistribution of that subject. Absence of a license is not permission.",
    "Use `local_evaluation_only` when local inspection is supportable but redistribution is not, `redistribution_prohibited` when direct evidence prohibits it, and `uncertain` when the available evidence cannot establish a status.",
    candidateScoped
      ? "Complete every `subject_reviews` row exactly once. Set the top-level status conservatively: prohibited before uncertain, uncertain before local-only, and local-only before permitted."
      : "Create one JSON review that validates against `license-review-schema.json`.",
    "Pseudonymous identity and attestations support process checking but do not prove real-world identity, expertise, or legal authority.",
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

function parseLicenseSubject(
  value: unknown,
  evidencePaths: ReadonlySet<string>
): PromotionTrialCandidateLicenseSubject {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "subject_id",
        "subject_kind",
        "source_url",
        "source_revision",
        "declared_license",
        "evidence_refs",
        "evidence_files"
      ])
      || !validId(value.subject_id)
      || (value.subject_kind !== "source_collection"
        && value.subject_kind !== "base_material"
        && value.subject_kind !== "operator_output")
      || !validHttpsUrl(value.source_url)
      || (value.source_revision !== null && !boundedText(value.source_revision, 256))
      || (value.declared_license !== null && !boundedText(value.declared_license, 256))
      || !Array.isArray(value.evidence_refs)
      || value.evidence_refs.length > 16
      || new Set(value.evidence_refs).size !== value.evidence_refs.length
      || !value.evidence_refs.every(validHttpsUrl)
      || !Array.isArray(value.evidence_files)
      || value.evidence_files.length > 16
      || new Set(value.evidence_files).size !== value.evidence_files.length
      || !value.evidence_files.every((item) =>
        typeof item === "string" && evidencePaths.has(item))
      || value.evidence_refs.length + value.evidence_files.length === 0) {
    throw new Error("Candidate-scoped license subject is invalid.");
  }
  return {
    subject_id: value.subject_id,
    subject_kind: value.subject_kind,
    source_url: value.source_url as string,
    source_revision: value.source_revision,
    declared_license: value.declared_license,
    evidence_refs: [...value.evidence_refs] as string[],
    evidence_files: [...value.evidence_files] as string[]
  };
}

function parseLicenseCandidateRequirement(
  value: unknown,
  subjectById: ReadonlyMap<string, PromotionTrialCandidateLicenseSubject>
): PromotionTrialCandidateScopedLicenseTask["candidate_requirements"][number] {
  if (!isRecord(value)
      || !hasExactKeys(value, ["candidate_id", "subject_ids"])
      || !validId(value.candidate_id)
      || !Array.isArray(value.subject_ids)
      || value.subject_ids.length < 3
      || value.subject_ids.length > 16
      || new Set(value.subject_ids).size !== value.subject_ids.length
      || !value.subject_ids.every((item) =>
        typeof item === "string" && subjectById.has(item))) {
    throw new Error("Candidate-scoped license requirement is invalid.");
  }
  return {
    candidate_id: value.candidate_id,
    subject_ids: [...value.subject_ids] as string[]
  };
}

function parseLicenseSubjectReview(
  value: unknown
): PromotionTrialCandidateScopedLicenseReviewSet["subject_reviews"][number] {
  if (!isRecord(value)
      || !hasExactKeys(value, ["subject_id", "status", "evidence_refs", "rationale"])
      || !validId(value.subject_id)) {
    throw new Error("Candidate-scoped license subject review is invalid.");
  }
  return {
    subject_id: value.subject_id,
    ...parseLicenseReview({
      status: value.status,
      evidence_refs: value.evidence_refs,
      rationale: value.rationale
    })
  };
}

export function aggregatePromotionTrialCandidateLicenseStatuses(
  statuses: readonly PromotionTrialCandidateLicenseStatus[]
): PromotionTrialCandidateLicenseStatus {
  if (statuses.length === 0) {
    throw new Error("At least one license status is required for aggregation.");
  }
  if (statuses.includes("redistribution_prohibited")) return "redistribution_prohibited";
  if (statuses.includes("uncertain")) return "uncertain";
  if (statuses.includes("local_evaluation_only")) return "local_evaluation_only";
  return "redistribution_permitted";
}

function aggregateLicenseStatuses(
  statuses: readonly PromotionTrialCandidateLicenseStatus[]
): PromotionTrialCandidateLicenseStatus {
  return aggregatePromotionTrialCandidateLicenseStatuses(statuses);
}

function validTaskEvidenceFiles(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return false;
  const paths = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)
        || !hasExactKeys(item, ["path", "sha256"])
        || !validLicenseEvidencePath(item.path)
        || !sha256String(item.sha256)
        || paths.has(item.path)) {
      return false;
    }
    paths.add(item.path);
  }
  return true;
}

function validLicenseEvidencePath(value: unknown): value is string {
  if (typeof value !== "string"
      || value.length === 0
      || value.length > 512
      || value.startsWith("/")
      || value.includes("\\")
      || value.includes("\0")) {
    return false;
  }
  const segments = value.split("/");
  return segments[0] === "source-evidence"
    && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function sha1String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
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
