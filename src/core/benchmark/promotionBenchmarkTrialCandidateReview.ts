import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonFile } from "../../utils/fs.js";
import { assertPromotionArtifactPrivacySafe } from "./promotionArtifactPrivacy.js";
import {
  inspectPromotionTrialCandidateHandoff,
  PROMOTION_TRIAL_CANDIDATE_GUIDE,
  PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST,
  PROMOTION_TRIAL_CANDIDATE_TASKS,
  type PromotionTrialCandidateHandoffManifest
} from "./promotionBenchmarkTrialCandidateHandoff.js";
import {
  PROMOTION_TRIAL_CANDIDATE_ANNOTATION_SCHEMA,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_GUIDE,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_SCHEMA,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK,
  PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS,
  PROMOTION_TRIAL_CANDIDATE_RESOLUTION_SCHEMA,
  PROMOTION_TRIAL_CANDIDATE_RUBRIC,
  parsePromotionTrialCandidateInitialAnnotationSet,
  parsePromotionTrialCandidateLicenseReviewSet,
  parsePromotionTrialCandidateResolutionSet,
  promotionTrialCandidateAnnotationSchema,
  promotionTrialCandidateHumanLabelsEqual,
  promotionTrialCandidateLicenseReviewerGuide,
  promotionTrialCandidateLicenseReviewSchema,
  promotionTrialCandidateReviewerGuide,
  promotionTrialCandidateResolutionSchema,
  promotionTrialCandidateReviewRubric,
  type PromotionTrialCandidateHumanLabel,
  type PromotionTrialCandidateInitialAnnotationSet,
  type PromotionTrialCandidateLicenseReview,
  type PromotionTrialCandidateLicenseReviewSet,
  type PromotionTrialCandidateLicenseStatus,
  type PromotionTrialCandidateObservation,
  type PromotionTrialCandidateObservationValue,
  type PromotionTrialCandidateResolutionSet
} from "./promotionBenchmarkTrialCandidateReviewContract.js";

export const PROMOTION_TRIAL_CANDIDATE_ANNOTATION_PREFLIGHT_REPORT =
  "trial-candidate-annotation-preflight.json";
export const PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_PREFLIGHT_REPORT =
  "trial-candidate-license-review-preflight.json";
export const PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT =
  "trial-candidate-review-adjudication.json";
export const PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS =
  "adjudicated-candidate-labels.jsonl";
export const PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE =
  "trial-candidate-review-evidence.json";

export interface PreparePromotionTrialCandidateAnnotationWorksheetInput {
  cwd: string;
  handoffRoot: string;
  annotatorId: string;
  outputPath: string;
}

export interface PromotionTrialCandidateAnnotationWorksheet {
  schema_version: "1.0";
  handoff_id: string;
  annotator_id: string;
  label_source: "human";
  review_role: "initial";
  independence_attestation: {
    completed_by_human: false;
    peer_annotations_unseen: false;
    controller_map_unseen: false;
  };
  annotations: Array<{
    candidate_id: string;
    observations: Record<PromotionTrialCandidateObservation, null>;
    evidence_refs: [];
    rationale: "";
  }>;
}

export interface PreparePromotionTrialCandidateAnnotationWorksheetResult {
  handoff_id: string;
  annotator_id: string;
  task_count: number;
  output_path: string;
}

export interface PreparePromotionTrialCandidateLicenseReviewWorksheetInput {
  cwd: string;
  handoffRoot: string;
  reviewerId: string;
  outputPath: string;
}

export interface PromotionTrialCandidateLicenseReviewWorksheet {
  schema_version: "1.0";
  handoff_id: string;
  reviewer_id: string;
  label_source: "human";
  review_role: "source_license";
  independence_attestation: {
    completed_by_human: false;
    candidate_annotations_unseen: false;
    controller_map_unseen: false;
  };
  review: {
    status: null;
    evidence_refs: [];
    rationale: "";
  };
}

export interface PreparePromotionTrialCandidateLicenseReviewWorksheetResult {
  handoff_id: string;
  reviewer_id: string;
  output_path: string;
}

export interface PreflightPromotionTrialCandidateAnnotationInput {
  cwd: string;
  handoffRoot: string;
  annotationPath: string;
  outDir: string;
}

export interface PromotionTrialCandidateReviewIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionTrialCandidateAnnotationPreflightReport {
  schema_version: "1.0";
  generated_at: string;
  handoff_id: string;
  passed: boolean;
  annotator_id: string | null;
  task_count: number;
  annotation_count: number;
  positive_candidate_count: number;
  input_sha256: {
    handoff_manifest: string;
    tasks: string;
    schema: string;
    resolution_schema: string;
    guide: string;
    rubric: string;
    annotation: string;
  };
  validation_issues: PromotionTrialCandidateReviewIssue[];
  evidence_boundary: string;
}

export interface PreflightPromotionTrialCandidateAnnotationResult {
  report: PromotionTrialCandidateAnnotationPreflightReport;
  report_path: string;
  summary_path: string;
}

export interface PreflightPromotionTrialCandidateLicenseReviewInput {
  cwd: string;
  handoffRoot: string;
  reviewPath: string;
  outDir: string;
}

export interface PromotionTrialCandidateLicenseReviewPreflightReport {
  schema_version: "1.0";
  generated_at: string;
  handoff_id: string;
  passed: boolean;
  reviewer_id: string | null;
  license_status: PromotionTrialCandidateLicenseStatus | null;
  evidence_reference_count: number;
  input_sha256: {
    handoff_manifest: string;
    license_task: string;
    license_schema: string;
    license_guide: string;
    review: string;
  };
  validation_issues: PromotionTrialCandidateReviewIssue[];
  evidence_boundary: string;
}

export interface PreflightPromotionTrialCandidateLicenseReviewResult {
  report: PromotionTrialCandidateLicenseReviewPreflightReport;
  report_path: string;
  summary_path: string;
}

export interface AdjudicatePromotionTrialCandidateReviewInput {
  cwd: string;
  handoffRoot: string;
  annotationPaths: string[];
  licenseReviewPath: string;
  resolutionPath?: string;
  outDir: string;
}

export interface PromotionTrialCandidateReviewAgreement {
  full_label_exact_rate: number | null;
  field_exact_rates: Record<PromotionTrialCandidateObservation, number | null>;
}

export interface PromotionTrialCandidateReviewEvidence {
  schema_version: "1.0";
  handoff_id: string;
  source_revision: string;
  candidate_count: number;
  double_human_annotation_completed: true;
  human_license_review_recorded: true;
  source_license_status: PromotionTrialCandidateLicenseStatus;
  source_license_adjudication: {
    reviewer_id: string;
    review: PromotionTrialCandidateLicenseReview;
  };
  observation_counts: Record<PromotionTrialCandidateObservation, Record<PromotionTrialCandidateObservationValue, number>>;
  positive_candidate_count: number;
  redistributable_positive_candidate_count: number;
  candidate_review_progression_floor_met: boolean;
  confirmatory_admitted: false;
  remaining_blockers: string[];
  evidence_boundary: string;
}

export interface PromotionTrialCandidateReviewAdjudicationReport {
  schema_version: "1.0";
  generated_at: string;
  handoff_id: string;
  passed: boolean;
  task_count: number;
  accepted_label_count: number;
  initial_annotator_ids: string[];
  resolver_id: string | null;
  license_reviewer_id: string | null;
  disagreement_count: number;
  resolved_disagreement_count: number;
  agreement: PromotionTrialCandidateReviewAgreement;
  input_sha256: {
    handoff_manifest: string;
    annotations: Array<string | null>;
    license_review: string | null;
    resolution: string | null;
  };
  outputs: {
    labels_path: string | null;
    labels_sha256: string | null;
    evidence_path: string | null;
    evidence_sha256: string | null;
  };
  validation_issues: PromotionTrialCandidateReviewIssue[];
  evidence_boundary: string;
}

export interface AdjudicatePromotionTrialCandidateReviewResult {
  report: PromotionTrialCandidateReviewAdjudicationReport;
  output_dir: string;
  report_path: string;
  labels_path: string | null;
  evidence_path: string | null;
}

interface ReviewerTask {
  schema_version: "1.0";
  candidate_id: string;
  artifact_root: string;
  trial_ids: string[];
  required_observations: PromotionTrialCandidateObservation[];
}

interface ValidatedInitialSet {
  annotation: PromotionTrialCandidateInitialAnnotationSet | null;
  bytes: Buffer | null;
}

interface AcceptedLabel {
  source: "double_adjudication_consensus" | "third_party_resolution";
  label: {
    candidate_id: string;
    observations: Record<PromotionTrialCandidateObservation, PromotionTrialCandidateObservationValue>;
  };
  initial: [PromotionTrialCandidateHumanLabel, PromotionTrialCandidateHumanLabel];
  resolution: PromotionTrialCandidateHumanLabel | null;
  annotator_ids: string[];
}

export async function preparePromotionTrialCandidateAnnotationWorksheet(
  input: PreparePromotionTrialCandidateAnnotationWorksheetInput
): Promise<PreparePromotionTrialCandidateAnnotationWorksheetResult> {
  const cwd = path.resolve(input.cwd);
  const handoffRoot = await resolveDirectoryInside(
    cwd,
    path.resolve(cwd, input.handoffRoot),
    "Trial-candidate handoff"
  );
  if (!validId(input.annotatorId)) {
    throw new Error("Trial-candidate worksheet requires a portable pseudonymous annotator ID.");
  }
  const outputPath = path.resolve(cwd, input.outputPath);
  assertStrictlyInside(cwd, outputPath, "Trial-candidate annotation worksheet output");
  if (isSameOrContainedPath(handoffRoot, outputPath)) {
    throw new Error("Trial-candidate annotation worksheet output must stay outside the closed handoff.");
  }
  await prepareFreshFileOutputInside(
    cwd,
    outputPath,
    "Trial-candidate annotation worksheet output"
  );

  const { manifest, tasks } = await loadHandoffContract(handoffRoot);
  const observations = Object.fromEntries(
    PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.map((field) => [field, null])
  ) as Record<PromotionTrialCandidateObservation, null>;
  const worksheet: PromotionTrialCandidateAnnotationWorksheet = {
    schema_version: "1.0",
    handoff_id: manifest.handoff_id,
    annotator_id: input.annotatorId,
    label_source: "human",
    review_role: "initial",
    independence_attestation: {
      completed_by_human: false,
      peer_annotations_unseen: false,
      controller_map_unseen: false
    },
    annotations: tasks.map((task) => ({
      candidate_id: task.candidate_id,
      observations: { ...observations },
      evidence_refs: [],
      rationale: ""
    }))
  };
  await writeJsonFile(outputPath, worksheet);
  return {
    handoff_id: manifest.handoff_id,
    annotator_id: input.annotatorId,
    task_count: tasks.length,
    output_path: portableRef(cwd, outputPath)
  };
}

export async function preparePromotionTrialCandidateLicenseReviewWorksheet(
  input: PreparePromotionTrialCandidateLicenseReviewWorksheetInput
): Promise<PreparePromotionTrialCandidateLicenseReviewWorksheetResult> {
  const cwd = path.resolve(input.cwd);
  const handoffRoot = await resolveDirectoryInside(
    cwd,
    path.resolve(cwd, input.handoffRoot),
    "Trial-candidate handoff"
  );
  if (!validId(input.reviewerId)) {
    throw new Error("Trial-candidate license worksheet requires a portable pseudonymous reviewer ID.");
  }
  const outputPath = path.resolve(cwd, input.outputPath);
  assertStrictlyInside(cwd, outputPath, "Trial-candidate license review worksheet output");
  if (isSameOrContainedPath(handoffRoot, outputPath)) {
    throw new Error("Trial-candidate license review worksheet output must stay outside the closed handoff.");
  }
  await prepareFreshFileOutputInside(
    cwd,
    outputPath,
    "Trial-candidate license review worksheet output"
  );

  const { manifest } = await loadHandoffContract(handoffRoot);
  const worksheet: PromotionTrialCandidateLicenseReviewWorksheet = {
    schema_version: "1.0",
    handoff_id: manifest.handoff_id,
    reviewer_id: input.reviewerId,
    label_source: "human",
    review_role: "source_license",
    independence_attestation: {
      completed_by_human: false,
      candidate_annotations_unseen: false,
      controller_map_unseen: false
    },
    review: {
      status: null,
      evidence_refs: [],
      rationale: ""
    }
  };
  await writeJsonFile(outputPath, worksheet);
  return {
    handoff_id: manifest.handoff_id,
    reviewer_id: input.reviewerId,
    output_path: portableRef(cwd, outputPath)
  };
}

export async function preflightPromotionTrialCandidateAnnotation(
  input: PreflightPromotionTrialCandidateAnnotationInput
): Promise<PreflightPromotionTrialCandidateAnnotationResult> {
  const cwd = path.resolve(input.cwd);
  const handoffRoot = await resolveDirectoryInside(cwd, path.resolve(cwd, input.handoffRoot), "Trial-candidate handoff");
  const annotationPath = await resolveFileInside(cwd, path.resolve(cwd, input.annotationPath), "Trial-candidate annotation");
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Trial-candidate annotation preflight output");
  if (isSameOrContainedPath(handoffRoot, outDir)) {
    throw new Error("Trial-candidate annotation preflight output must stay outside the closed handoff.");
  }
  await assertFreshOutput(outDir, "Trial-candidate annotation preflight output");

  const { manifest, tasks } = await loadHandoffContract(handoffRoot);
  const issues: PromotionTrialCandidateReviewIssue[] = [];
  const validated = await readInitialAnnotation(annotationPath, manifest, tasks, handoffRoot, issues);
  const annotation = validated.annotation;
  const positiveCandidateCount = annotation
    ? annotation.annotations.filter(allObservationsPositive).length
    : 0;
  const contractPaths = reviewerContractPaths(handoffRoot);
  const report: PromotionTrialCandidateAnnotationPreflightReport = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    handoff_id: manifest.handoff_id,
    passed: issues.length === 0 && annotation?.annotations.length === tasks.length,
    annotator_id: annotation?.annotator_id || null,
    task_count: tasks.length,
    annotation_count: annotation?.annotations.length || 0,
    positive_candidate_count: positiveCandidateCount,
    input_sha256: {
      handoff_manifest: await hashFile(path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST)),
      tasks: await hashFile(path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_TASKS)),
      schema: await hashFile(contractPaths.schema),
      resolution_schema: await hashFile(contractPaths.resolutionSchema),
      guide: await hashFile(contractPaths.guide),
      rubric: await hashFile(contractPaths.rubric),
      annotation: validated.bytes ? sha256(validated.bytes) : await hashFile(annotationPath).catch(() => "")
    },
    validation_issues: issues,
    evidence_boundary: "This preflight validates the hash-bound reviewer contract, one human-attested annotation file, exact opaque-task coverage, and cited JSON Pointer existence. It does not compare reviewers, establish real-world identity or independence, grant redistribution rights, verify label truth, or admit confirmatory evidence."
  };
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, PROMOTION_TRIAL_CANDIDATE_ANNOTATION_PREFLIGHT_REPORT);
  const summaryPath = path.join(outDir, "trial-candidate-annotation-preflight.md");
  await writeJsonFile(reportPath, report);
  await fs.writeFile(summaryPath, renderPreflightSummary(report, path.basename(annotationPath)), "utf8");
  return {
    report,
    report_path: portableRef(cwd, reportPath),
    summary_path: portableRef(cwd, summaryPath)
  };
}

export async function preflightPromotionTrialCandidateLicenseReview(
  input: PreflightPromotionTrialCandidateLicenseReviewInput
): Promise<PreflightPromotionTrialCandidateLicenseReviewResult> {
  const cwd = path.resolve(input.cwd);
  const handoffRoot = await resolveDirectoryInside(cwd, path.resolve(cwd, input.handoffRoot), "Trial-candidate handoff");
  const reviewPath = await resolveFileInside(cwd, path.resolve(cwd, input.reviewPath), "Trial-candidate source-license review");
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Trial-candidate source-license review preflight output");
  if (isSameOrContainedPath(handoffRoot, outDir)) {
    throw new Error("Trial-candidate source-license review preflight output must stay outside the closed handoff.");
  }
  await assertFreshOutput(outDir, "Trial-candidate source-license review preflight output");

  const { manifest } = await loadHandoffContract(handoffRoot);
  const issues: PromotionTrialCandidateReviewIssue[] = [];
  const review = await readLicenseReview(reviewPath, manifest, [], issues);
  const contractPaths = reviewerContractPaths(handoffRoot);
  const report: PromotionTrialCandidateLicenseReviewPreflightReport = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    handoff_id: manifest.handoff_id,
    passed: issues.length === 0 && Boolean(review),
    reviewer_id: review?.reviewer_id || null,
    license_status: review?.review.status || null,
    evidence_reference_count: review?.review.evidence_refs.length || 0,
    input_sha256: {
      handoff_manifest: await hashFile(path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST)),
      license_task: await hashFile(path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK)),
      license_schema: await hashFile(contractPaths.licenseSchema),
      license_guide: await hashFile(contractPaths.licenseGuide),
      review: await hashFile(reviewPath)
    },
    validation_issues: issues,
    evidence_boundary: "This preflight validates the hash-bound source-license task and contract plus one human-attested source-license review file. It does not inspect candidate artifacts or annotations, establish reviewer identity or legal authority, grant redistribution rights, verify the legal conclusion, or admit confirmatory evidence."
  };
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_PREFLIGHT_REPORT);
  const summaryPath = path.join(outDir, "trial-candidate-license-review-preflight.md");
  await writeJsonFile(reportPath, report);
  await fs.writeFile(summaryPath, renderLicenseReviewPreflightSummary(report, path.basename(reviewPath)), "utf8");
  return {
    report,
    report_path: portableRef(cwd, reportPath),
    summary_path: portableRef(cwd, summaryPath)
  };
}

export async function adjudicatePromotionTrialCandidateReview(
  input: AdjudicatePromotionTrialCandidateReviewInput
): Promise<AdjudicatePromotionTrialCandidateReviewResult> {
  const cwd = path.resolve(input.cwd);
  const handoffRoot = await resolveDirectoryInside(cwd, path.resolve(cwd, input.handoffRoot), "Trial-candidate handoff");
  const outDir = path.resolve(cwd, input.outDir);
  if (input.annotationPaths.length !== 2) {
    throw new Error("Trial-candidate review adjudication requires exactly two initial annotation files.");
  }
  assertStrictlyInside(cwd, outDir, "Trial-candidate review adjudication output");
  if (isSameOrContainedPath(handoffRoot, outDir)) {
    throw new Error("Trial-candidate review adjudication output must stay outside the closed handoff.");
  }
  await assertFreshOutput(outDir, "Trial-candidate review adjudication output");

  const { manifest, tasks } = await loadHandoffContract(handoffRoot);
  const issues: PromotionTrialCandidateReviewIssue[] = [];
  const initialPaths = await Promise.all(input.annotationPaths.map((item, index) =>
    resolveFileInside(cwd, path.resolve(cwd, item), `Trial-candidate annotation ${index + 1}`)));
  const initialValidated = await Promise.all(initialPaths.map((annotationPath) =>
    readInitialAnnotation(annotationPath, manifest, tasks, handoffRoot, issues)));
  const initial = initialValidated.map((item) => item.annotation);
  const initialIds = initial.flatMap((item) => item ? [item.annotator_id] : []);
  if (initialIds.length !== 2 || new Set(initialIds).size !== 2) {
    issues.push({
      code: "trial_candidate_review_initial_annotators_not_independent",
      message: "Initial annotation files must use two distinct annotator IDs."
    });
  }

  const initialMaps = initial.map((item) => new Map(
    (item?.annotations || []).map((label) => [label.candidate_id, label])
  ));
  const disagreementIds = new Set(tasks.flatMap((task) => {
    const left = initialMaps[0].get(task.candidate_id);
    const right = initialMaps[1].get(task.candidate_id);
    return left && right && !promotionTrialCandidateHumanLabelsEqual(left, right)
      ? [task.candidate_id]
      : [];
  }));
  const resolutionPath = input.resolutionPath
    ? await resolveFileInside(cwd, path.resolve(cwd, input.resolutionPath), "Trial-candidate resolution")
    : undefined;
  const resolution = resolutionPath
    ? await readResolution(
        resolutionPath,
        manifest,
        tasks,
        handoffRoot,
        disagreementIds,
        initialIds,
        issues
      )
    : null;
  if (!resolutionPath && disagreementIds.size > 0) {
    for (const candidateId of disagreementIds) {
      issues.push({
        code: "trial_candidate_review_disagreement_unresolved",
        message: "Every candidate-label disagreement requires a distinct human resolver.",
        ref: candidateId
      });
    }
  }
  if (resolutionPath && disagreementIds.size === 0) {
    issues.push({
      code: "trial_candidate_review_resolution_not_required",
      message: "A resolution file is not allowed when the two initial reviews agree."
    });
  }

  const licenseReviewPath = await resolveFileInside(
    cwd,
    path.resolve(cwd, input.licenseReviewPath),
    "Trial-candidate source-license review"
  );
  const licenseReview = await readLicenseReview(
    licenseReviewPath,
    manifest,
    [...initialIds, ...(resolution ? [resolution.resolver_id] : [])],
    issues
  );

  const resolutionMap = new Map((resolution?.resolutions || []).map((label) => [label.candidate_id, label]));
  const accepted = new Map<string, AcceptedLabel>();
  for (const task of tasks) {
    const left = initialMaps[0].get(task.candidate_id);
    const right = initialMaps[1].get(task.candidate_id);
    if (!left || !right) continue;
    if (promotionTrialCandidateHumanLabelsEqual(left, right)) {
      accepted.set(task.candidate_id, {
        source: "double_adjudication_consensus",
        label: categoricalLabel(left),
        initial: [left, right],
        resolution: null,
        annotator_ids: initialIds
      });
      continue;
    }
    const resolved = resolutionMap.get(task.candidate_id);
    if (resolved && resolution) {
      accepted.set(task.candidate_id, {
        source: "third_party_resolution",
        label: categoricalLabel(resolved),
        initial: [left, right],
        resolution: resolved,
        annotator_ids: [...initialIds, resolution.resolver_id]
      });
    }
  }
  const passed = issues.length === 0
    && accepted.size === tasks.length
    && Boolean(licenseReview)
    && initial.length === 2
    && initial.every(Boolean);
  const inputHashes = {
    handoff_manifest: await hashFile(path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST)),
    annotations: await Promise.all(initialPaths.map((item) => hashFile(item).catch(() => null))),
    license_review: await hashFile(licenseReviewPath).catch(() => null),
    resolution: resolutionPath ? await hashFile(resolutionPath).catch(() => null) : null
  };

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  let labelsPath: string | null = null;
  let labelsSha256: string | null = null;
  let evidencePath: string | null = null;
  let evidenceSha256: string | null = null;
  try {
    if (passed && licenseReview) {
      const rows = tasks.map((task) => {
        const item = accepted.get(task.candidate_id);
        if (!item) throw new Error(`Accepted trial-candidate label missing: ${task.candidate_id}`);
        return JSON.stringify({
          schema_version: "1.0",
          candidate_id: task.candidate_id,
          adjudication_source: item.source,
          annotator_ids: item.annotator_ids,
          label: item.label,
          initial_annotations: item.initial,
          resolution: item.resolution
        });
      });
      const labelsFile = path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS);
      await fs.writeFile(labelsFile, `${rows.join("\n")}\n`, "utf8");
      labelsSha256 = await hashFile(labelsFile);
      labelsPath = portableRef(cwd, path.join(outDir, PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS));

      const evidence = buildReviewEvidence(manifest, tasks, accepted, licenseReview);
      const evidenceFile = path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE);
      await writeJsonFile(evidenceFile, evidence);
      evidenceSha256 = await hashFile(evidenceFile);
      evidencePath = portableRef(cwd, path.join(outDir, PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE));
    }

    const report: PromotionTrialCandidateReviewAdjudicationReport = {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      handoff_id: manifest.handoff_id,
      passed,
      task_count: tasks.length,
      accepted_label_count: accepted.size,
      initial_annotator_ids: [...new Set(initialIds)].sort(),
      resolver_id: resolution?.resolver_id || null,
      license_reviewer_id: licenseReview?.reviewer_id || null,
      disagreement_count: disagreementIds.size,
      resolved_disagreement_count: [...disagreementIds].filter((id) => resolutionMap.has(id)).length,
      agreement: agreementMetrics(tasks, initialMaps),
      input_sha256: inputHashes,
      outputs: {
        labels_path: labelsPath,
        labels_sha256: labelsSha256,
        evidence_path: evidencePath,
        evidence_sha256: evidenceSha256
      },
      validation_issues: issues,
      evidence_boundary: "This adjudication verifies exact task coverage, two distinct pseudonymous candidate-review attestations, categorical agreement, cited artifact locations, independent resolution coverage, and a separately attested source-license review. It preserves negative and uncertain outcomes. It does not prove reviewer identity or expertise, infer missing labels, grant a license, materialize canonical benchmark cases, or admit confirmatory evidence."
    };
    await writeJsonFile(path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT), report);
    await fs.rename(stagingRoot, outDir);
    if (passed) {
      const inspection = await inspectPromotionTrialCandidateReviewAdjudication(outDir);
      if (!inspection.passed) {
        throw new Error(`Trial-candidate review adjudication failed self-inspection: ${inspection.issues.map((item) => item.code).join(", ")}.`);
      }
    }
    return {
      report,
      output_dir: portableRef(cwd, outDir),
      report_path: portableRef(cwd, path.join(outDir, PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT)),
      labels_path: labelsPath,
      evidence_path: evidencePath
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    if (await pathExists(outDir)) await fs.rm(outDir, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectPromotionTrialCandidateReviewAdjudication(
  rootPath: string
): Promise<{ passed: boolean; report: PromotionTrialCandidateReviewAdjudicationReport | null; issues: PromotionTrialCandidateReviewIssue[] }> {
  const root = path.resolve(rootPath);
  const issues: PromotionTrialCandidateReviewIssue[] = [];
  let report: PromotionTrialCandidateReviewAdjudicationReport;
  try {
    report = parseAdjudicationReport(JSON.parse(await fs.readFile(
      path.join(root, PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT),
      "utf8"
    )) as unknown);
  } catch {
    return {
      passed: false,
      report: null,
      issues: [{ code: "trial_candidate_review_report_unreadable", message: "The adjudication report is missing or invalid." }]
    };
  }
  const expected = new Set([PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT]);
  if (report.passed) {
    expected.add(PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS);
    expected.add(PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE);
  }
  const observed = await listRegularFiles(root).catch((): string[] => []);
  if (observed.length !== expected.size || observed.some((item) => !expected.has(item))) {
    issues.push({ code: "trial_candidate_review_output_inventory_invalid", message: "Adjudication outputs are missing or untracked." });
  }
  if (report.passed) {
    const labelsHash = await hashFile(path.join(root, PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS)).catch(() => null);
    const evidenceHash = await hashFile(path.join(root, PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE)).catch(() => null);
    if (labelsHash !== report.outputs.labels_sha256 || evidenceHash !== report.outputs.evidence_sha256) {
      issues.push({ code: "trial_candidate_review_output_hash_mismatch", message: "A hash-bound adjudication output changed." });
    }
    try {
      const rows = (await fs.readFile(path.join(root, PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS), "utf8"))
        .split(/\r?\n/gu).filter(Boolean).map((line) => JSON.parse(line) as unknown);
      const ids = rows.map((row) => isRecord(row) && validId(row.candidate_id) ? row.candidate_id : "");
      if (rows.length !== report.task_count || new Set(ids).size !== rows.length || ids.includes("")) throw new Error("invalid");
      const evidence = JSON.parse(await fs.readFile(
        path.join(root, PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE),
        "utf8"
      )) as unknown;
      if (!isRecord(evidence)
          || evidence.handoff_id !== report.handoff_id
          || evidence.candidate_count !== report.task_count
          || evidence.confirmatory_admitted !== false) throw new Error("invalid");
    } catch {
      issues.push({ code: "trial_candidate_review_output_semantics_invalid", message: "Adjudicated labels or evidence summary are structurally inconsistent." });
    }
  }
  return { passed: issues.length === 0, report, issues };
}

async function loadHandoffContract(
  handoffRoot: string
): Promise<{ manifest: PromotionTrialCandidateHandoffManifest; tasks: ReviewerTask[] }> {
  const inspection = await inspectPromotionTrialCandidateHandoff(handoffRoot);
  if (!inspection.passed || !inspection.manifest) {
    throw new Error(`Trial-candidate review requires an integrity-valid handoff: ${inspection.issues.map((item) => item.code).join(", ") || "unreadable"}.`);
  }
  const contract = reviewerContractPaths(handoffRoot);
  const schema = JSON.parse(await fs.readFile(contract.schema, "utf8")) as unknown;
  const resolutionSchema = JSON.parse(await fs.readFile(contract.resolutionSchema, "utf8")) as unknown;
  const licenseSchema = JSON.parse(await fs.readFile(contract.licenseSchema, "utf8")) as unknown;
  const guide = await fs.readFile(contract.guide, "utf8");
  const licenseGuide = await fs.readFile(contract.licenseGuide, "utf8");
  const rubric = await fs.readFile(contract.rubric, "utf8");
  if (JSON.stringify(schema) !== JSON.stringify(promotionTrialCandidateAnnotationSchema())
      || JSON.stringify(resolutionSchema) !== JSON.stringify(promotionTrialCandidateResolutionSchema())
      || JSON.stringify(licenseSchema) !== JSON.stringify(promotionTrialCandidateLicenseReviewSchema())
      || guide !== promotionTrialCandidateReviewerGuide()
      || licenseGuide !== promotionTrialCandidateLicenseReviewerGuide()
      || rubric !== promotionTrialCandidateReviewRubric()) {
    throw new Error("Trial-candidate reviewer contract does not match the runtime contract.");
  }
  const tasks = parseReviewerTasks(await fs.readFile(
    path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_TASKS),
    "utf8"
  ));
  const manifestIds = inspection.manifest.candidates.map((item) => item.candidate_id).sort();
  const taskIds = tasks.map((item) => item.candidate_id).sort();
  if (manifestIds.join("\0") !== taskIds.join("\0")) {
    throw new Error("Trial-candidate reviewer tasks do not match the handoff manifest.");
  }
  for (const task of tasks) {
    const candidate = inspection.manifest.candidates.find((item) => item.candidate_id === task.candidate_id);
    if (!candidate
        || task.artifact_root !== `artifacts/${task.candidate_id}`
        || task.trial_ids.join("\0") !== candidate.trials.map((item) => item.trial_id).join("\0")) {
      throw new Error(`Trial-candidate reviewer task does not match the manifest: ${task.candidate_id}.`);
    }
  }
  return { manifest: inspection.manifest, tasks };
}

async function readInitialAnnotation(
  annotationPath: string,
  manifest: PromotionTrialCandidateHandoffManifest,
  tasks: ReviewerTask[],
  handoffRoot: string,
  issues: PromotionTrialCandidateReviewIssue[]
): Promise<ValidatedInitialSet> {
  let bytes: Buffer;
  let annotation: PromotionTrialCandidateInitialAnnotationSet;
  try {
    bytes = await fs.readFile(annotationPath);
    assertPromotionArtifactPrivacySafe(path.basename(annotationPath), bytes);
    annotation = parsePromotionTrialCandidateInitialAnnotationSet(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    issues.push({
      code: "trial_candidate_annotation_file_invalid",
      message: error instanceof Error ? error.message : String(error),
      ref: path.basename(annotationPath)
    });
    return { annotation: null, bytes: null };
  }
  if (annotation.handoff_id !== manifest.handoff_id) {
    issues.push({ code: "trial_candidate_annotation_handoff_mismatch", message: "Annotation handoff ID does not match the packet.", ref: annotation.annotator_id });
  }
  await validateLabels(annotation.annotations, tasks, handoffRoot, issues, "annotation");
  return { annotation, bytes };
}

async function readResolution(
  resolutionPath: string,
  manifest: PromotionTrialCandidateHandoffManifest,
  tasks: ReviewerTask[],
  handoffRoot: string,
  disagreementIds: Set<string>,
  initialIds: string[],
  issues: PromotionTrialCandidateReviewIssue[]
): Promise<PromotionTrialCandidateResolutionSet | null> {
  let resolution: PromotionTrialCandidateResolutionSet;
  try {
    const bytes = await fs.readFile(resolutionPath);
    assertPromotionArtifactPrivacySafe(path.basename(resolutionPath), bytes);
    resolution = parsePromotionTrialCandidateResolutionSet(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    issues.push({
      code: "trial_candidate_resolution_file_invalid",
      message: error instanceof Error ? error.message : String(error),
      ref: path.basename(resolutionPath)
    });
    return null;
  }
  if (resolution.handoff_id !== manifest.handoff_id) {
    issues.push({ code: "trial_candidate_resolution_handoff_mismatch", message: "Resolution handoff ID does not match the packet." });
  }
  if (initialIds.includes(resolution.resolver_id)) {
    issues.push({ code: "trial_candidate_review_resolver_not_independent", message: "Resolver ID must differ from both initial annotator IDs." });
  }
  const resolutionIds = new Set(resolution.resolutions.map((item) => item.candidate_id));
  if (resolutionIds.size !== resolution.resolutions.length
      || [...resolutionIds].some((id) => !disagreementIds.has(id))
      || [...disagreementIds].some((id) => !resolutionIds.has(id))) {
    issues.push({ code: "trial_candidate_resolution_coverage_invalid", message: "Resolution records must cover exactly the candidate disagreements." });
  }
  const disagreementTasks = tasks.filter((task) => disagreementIds.has(task.candidate_id));
  await validateLabels(resolution.resolutions, disagreementTasks, handoffRoot, issues, "resolution");
  return resolution;
}

async function readLicenseReview(
  reviewPath: string,
  manifest: PromotionTrialCandidateHandoffManifest,
  excludedReviewerIds: string[],
  issues: PromotionTrialCandidateReviewIssue[]
): Promise<PromotionTrialCandidateLicenseReviewSet | null> {
  let review: PromotionTrialCandidateLicenseReviewSet;
  try {
    const bytes = await fs.readFile(reviewPath);
    assertPromotionArtifactPrivacySafe(path.basename(reviewPath), bytes);
    review = parsePromotionTrialCandidateLicenseReviewSet(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    issues.push({
      code: "trial_candidate_license_review_file_invalid",
      message: error instanceof Error ? error.message : String(error),
      ref: path.basename(reviewPath)
    });
    return null;
  }
  if (review.handoff_id !== manifest.handoff_id) {
    issues.push({ code: "trial_candidate_license_review_handoff_mismatch", message: "Source-license review handoff ID does not match the packet." });
  }
  if (excludedReviewerIds.includes(review.reviewer_id)) {
    issues.push({
      code: "trial_candidate_license_reviewer_not_independent",
      message: "Source-license reviewer ID must differ from candidate annotator and resolver IDs."
    });
  }
  return review;
}

async function validateLabels(
  labels: PromotionTrialCandidateHumanLabel[],
  tasks: ReviewerTask[],
  handoffRoot: string,
  issues: PromotionTrialCandidateReviewIssue[],
  context: "annotation" | "resolution"
): Promise<void> {
  const taskById = new Map(tasks.map((item) => [item.candidate_id, item]));
  const labelById = new Map<string, PromotionTrialCandidateHumanLabel>();
  for (const label of labels) {
    if (!taskById.has(label.candidate_id)) {
      issues.push({ code: `trial_candidate_${context}_unknown_candidate`, message: "Label references a candidate outside the expected task set.", ref: label.candidate_id });
      continue;
    }
    if (labelById.has(label.candidate_id)) {
      issues.push({ code: `trial_candidate_${context}_duplicate_candidate`, message: "Label set contains a duplicate candidate.", ref: label.candidate_id });
      continue;
    }
    labelById.set(label.candidate_id, label);
  }
  for (const task of tasks) {
    const label = labelById.get(task.candidate_id);
    if (!label) {
      issues.push({ code: `trial_candidate_${context}_coverage_incomplete`, message: "Label set is missing an expected candidate.", ref: task.candidate_id });
      continue;
    }
    const trialIds = new Set(task.trial_ids);
    const artifactByTrial = new Map<string, unknown>();
    for (const evidenceRef of label.evidence_refs) {
      if (!trialIds.has(evidenceRef.trial_id)) {
        issues.push({ code: `trial_candidate_${context}_unknown_trial`, message: "Evidence reference uses a trial outside the candidate.", ref: `${task.candidate_id}:${evidenceRef.trial_id}` });
        continue;
      }
      let artifact = artifactByTrial.get(evidenceRef.trial_id);
      if (artifact === undefined) {
        try {
          artifact = JSON.parse(await fs.readFile(path.join(
            handoffRoot,
            "reviewer",
            task.artifact_root,
            evidenceRef.trial_id,
            "trace.json"
          ), "utf8")) as unknown;
          artifactByTrial.set(evidenceRef.trial_id, artifact);
        } catch {
          issues.push({ code: `trial_candidate_${context}_evidence_artifact_unreadable`, message: "Referenced trial artifact is missing or invalid.", ref: `${task.candidate_id}:${evidenceRef.trial_id}` });
          continue;
        }
      }
      for (const pointer of evidenceRef.json_pointers) {
        if (!jsonPointerExists(artifact, pointer)) {
          issues.push({ code: `trial_candidate_${context}_json_pointer_missing`, message: "A cited JSON Pointer does not exist in the reviewer artifact.", ref: `${task.candidate_id}:${evidenceRef.trial_id}:${pointer}` });
        }
      }
    }
    for (const observation of PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS) {
      if (label.observations[observation] !== "positive") continue;
      const citedTrials = new Set(label.evidence_refs
        .filter((ref) => ref.observations.includes(observation))
        .map((ref) => ref.trial_id));
      const allTrialsRequired = observation === "execution_trace_completeness"
        || observation === "repeated_trial_comparability";
      if ((allTrialsRequired && task.trial_ids.some((trialId) => !citedTrials.has(trialId)))
          || (!allTrialsRequired && citedTrials.size === 0)) {
        issues.push({ code: `trial_candidate_${context}_positive_evidence_incomplete`, message: "Positive labels require observation-specific artifact citations.", ref: `${task.candidate_id}:${observation}` });
      }
    }
  }
}

function buildReviewEvidence(
  manifest: PromotionTrialCandidateHandoffManifest,
  tasks: ReviewerTask[],
  accepted: Map<string, AcceptedLabel>,
  license: PromotionTrialCandidateLicenseReviewSet
): PromotionTrialCandidateReviewEvidence {
  const counts = Object.fromEntries(PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.map((field) => [field, {
    positive: 0,
    negative: 0,
    uncertain: 0
  }])) as PromotionTrialCandidateReviewEvidence["observation_counts"];
  let positiveCandidateCount = 0;
  for (const task of tasks) {
    const item = accepted.get(task.candidate_id);
    if (!item) throw new Error(`Accepted label missing while building evidence: ${task.candidate_id}`);
    for (const field of PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS) {
      counts[field][item.label.observations[field]] += 1;
    }
    if (allObservationsPositive(item.label)) positiveCandidateCount += 1;
  }
  const redistributablePositiveCandidateCount = license.review.status === "redistribution_permitted"
    ? positiveCandidateCount
    : 0;
  const floorMet = redistributablePositiveCandidateCount >= manifest.required_base_candidate_count;
  const remainingBlockers = [
    ...(license.review.status === "redistribution_permitted" ? [] : ["redistribution_permission_unresolved"]),
    ...(positiveCandidateCount === tasks.length ? [] : ["candidate_evidence_requirements_unmet"]),
    "canonical_source_projection",
    "confirmatory_intake_freeze"
  ];
  return {
    schema_version: "1.0",
    handoff_id: manifest.handoff_id,
    source_revision: manifest.source_revision,
    candidate_count: tasks.length,
    double_human_annotation_completed: true,
    human_license_review_recorded: true,
    source_license_status: license.review.status,
    source_license_adjudication: {
      reviewer_id: license.reviewer_id,
      review: license.review
    },
    observation_counts: counts,
    positive_candidate_count: positiveCandidateCount,
    redistributable_positive_candidate_count: redistributablePositiveCandidateCount,
    candidate_review_progression_floor_met: floorMet,
    confirmatory_admitted: false,
    remaining_blockers: remainingBlockers,
    evidence_boundary: "This summary records double-human categorical review and adjudication over revision-bound trace candidates plus a separate human source-license assessment. It preserves negative and uncertain findings and never converts a reviewer assessment into canonical normalization, a legal grant, confirmatory admission, or paper-readiness evidence."
  };
}

function agreementMetrics(
  tasks: ReviewerTask[],
  maps: Array<Map<string, PromotionTrialCandidateHumanLabel>>
): PromotionTrialCandidateReviewAgreement {
  const pairs = tasks.flatMap((task) => {
    const left = maps[0].get(task.candidate_id);
    const right = maps[1].get(task.candidate_id);
    return left && right ? [[left, right] as const] : [];
  });
  return {
    full_label_exact_rate: pairs.length === 0
      ? null
      : pairs.filter(([left, right]) => promotionTrialCandidateHumanLabelsEqual(left, right)).length / pairs.length,
    field_exact_rates: Object.fromEntries(PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.map((field) => [
      field,
      pairs.length === 0
        ? null
        : pairs.filter(([left, right]) => left.observations[field] === right.observations[field]).length / pairs.length
    ])) as Record<PromotionTrialCandidateObservation, number | null>
  };
}

function parseReviewerTasks(raw: string): ReviewerTask[] {
  const tasks = raw.split(/\r?\n/gu).filter(Boolean).map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(`Trial-candidate task line ${index + 1} is not valid JSON.`);
    }
    if (!isRecord(value)
        || value.schema_version !== "1.0"
        || !validId(value.candidate_id)
        || value.artifact_root !== `artifacts/${value.candidate_id}`
        || !Array.isArray(value.trial_ids)
        || value.trial_ids.length !== 3
        || new Set(value.trial_ids).size !== 3
        || !value.trial_ids.every(validId)
        || !Array.isArray(value.required_observations)
        || value.required_observations.join("\0") !== PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.join("\0")) {
      throw new Error(`Trial-candidate task line ${index + 1} has an invalid review contract.`);
    }
    return {
      schema_version: "1.0" as const,
      candidate_id: value.candidate_id,
      artifact_root: value.artifact_root,
      trial_ids: value.trial_ids as string[],
      required_observations: [...PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS]
    };
  });
  if (tasks.length === 0 || new Set(tasks.map((item) => item.candidate_id)).size !== tasks.length) {
    throw new Error("Trial-candidate reviewer tasks must be non-empty and unique.");
  }
  return tasks;
}

function parseAdjudicationReport(value: unknown): PromotionTrialCandidateReviewAdjudicationReport {
  if (!isRecord(value)
      || value.schema_version !== "1.0"
      || !validId(value.handoff_id)
      || typeof value.passed !== "boolean"
      || !nonNegativeInteger(value.task_count)
      || !nonNegativeInteger(value.accepted_label_count)
      || !Array.isArray(value.initial_annotator_ids)
      || !value.initial_annotator_ids.every(validId)
      || !(value.resolver_id === null || validId(value.resolver_id))
      || !nonNegativeInteger(value.disagreement_count)
      || !nonNegativeInteger(value.resolved_disagreement_count)
      || !(value.license_reviewer_id === null || validId(value.license_reviewer_id))
      || !isRecord(value.outputs)
      || !Array.isArray(value.validation_issues)
      || typeof value.evidence_boundary !== "string") {
    throw new Error("Trial-candidate adjudication report is invalid.");
  }
  const report = value as unknown as PromotionTrialCandidateReviewAdjudicationReport;
  if (report.passed && (!validIdPath(report.outputs.labels_path)
      || !sha256String(report.outputs.labels_sha256)
      || !validIdPath(report.outputs.evidence_path)
      || !sha256String(report.outputs.evidence_sha256))) {
    throw new Error("Passed trial-candidate adjudication report is missing hash-bound outputs.");
  }
  return report;
}

function reviewerContractPaths(handoffRoot: string): {
  schema: string;
  resolutionSchema: string;
  licenseSchema: string;
  guide: string;
  licenseGuide: string;
  rubric: string;
} {
  return {
    schema: path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_ANNOTATION_SCHEMA),
    resolutionSchema: path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_RESOLUTION_SCHEMA),
    licenseSchema: path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_LICENSE_SCHEMA),
    guide: path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_GUIDE),
    licenseGuide: path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_LICENSE_GUIDE),
    rubric: path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_RUBRIC)
  };
}

function jsonPointerExists(value: unknown, pointer: string): boolean {
  if (pointer === "") return true;
  let current: unknown = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const part = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(part)) return false;
      const index = Number(part);
      if (index >= current.length) return false;
      current = current[index];
    } else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
    } else {
      return false;
    }
  }
  return true;
}

function categoricalLabel(label: PromotionTrialCandidateHumanLabel): AcceptedLabel["label"] {
  return {
    candidate_id: label.candidate_id,
    observations: { ...label.observations }
  };
}

function allObservationsPositive(
  label: Pick<PromotionTrialCandidateHumanLabel, "observations">
): boolean {
  return PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.every((field) => label.observations[field] === "positive");
}

function renderPreflightSummary(
  report: PromotionTrialCandidateAnnotationPreflightReport,
  annotationName: string
): string {
  return [
    "# Trial Candidate Annotation Preflight",
    "",
    `- Status: ${report.passed ? "passed" : "failed"}`,
    `- Annotation file: ${annotationName}`,
    `- Annotator ID: ${report.annotator_id || "unresolved"}`,
    `- Task coverage: ${report.annotation_count}/${report.task_count}`,
    `- All-positive candidates: ${report.positive_candidate_count}/${report.task_count}`,
    "",
    "## Validation Issues",
    "",
    ...(report.validation_issues.length > 0
      ? report.validation_issues.map((item) => `- ${item.code}${item.ref ? ` (${item.ref})` : ""}: ${item.message}`)
      : ["- None."]),
    "",
    "## Evidence Boundary",
    "",
    report.evidence_boundary,
    ""
  ].join("\n");
}

function renderLicenseReviewPreflightSummary(
  report: PromotionTrialCandidateLicenseReviewPreflightReport,
  reviewName: string
): string {
  return [
    "# Trial Candidate Source-License Review Preflight",
    "",
    `- Status: ${report.passed ? "passed" : "failed"}`,
    `- Review file: ${reviewName}`,
    `- Reviewer ID: ${report.reviewer_id || "unresolved"}`,
    `- License status: ${report.license_status || "unresolved"}`,
    `- Evidence references: ${report.evidence_reference_count}`,
    "",
    "## Validation Issues",
    "",
    ...(report.validation_issues.length > 0
      ? report.validation_issues.map((item) => `- ${item.code}${item.ref ? ` (${item.ref})` : ""}: ${item.message}`)
      : ["- None."]),
    "",
    "## Evidence Boundary",
    "",
    report.evidence_boundary,
    ""
  ].join("\n");
}

async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/gu, "/");
      if (entry.isSymbolicLink()) throw new Error("Adjudication output must not contain symbolic links.");
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(relative);
      else throw new Error("Adjudication output contains a non-regular filesystem entry.");
    }
  }
  await visit(root);
  return files.sort();
}

async function hashFile(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function assertFreshOutput(outDir: string, label: string): Promise<void> {
  if (await pathExists(outDir)) throw new Error(`${label} already exists: ${outDir}`);
}

async function prepareFreshFileOutputInside(
  root: string,
  outputPath: string,
  label: string
): Promise<void> {
  assertStrictlyInside(root, outputPath, label);
  await assertFreshOutput(outputPath, label);

  let existingAncestor = path.dirname(outputPath);
  while (!(await pathExists(existingAncestor))) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error(`${label} has no existing workspace ancestor.`);
    existingAncestor = parent;
  }
  const resolvedAncestor = await fs.realpath(existingAncestor);
  if (resolvedAncestor !== root) assertStrictlyInside(root, resolvedAncestor, `${label} parent`);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const resolvedParent = await fs.realpath(path.dirname(outputPath));
  if (resolvedParent !== root) assertStrictlyInside(root, resolvedParent, `${label} parent`);
}

async function resolveDirectoryInside(root: string, candidate: string, label: string): Promise<string> {
  const resolved = await resolveExistingInside(root, candidate, label);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error(`${label} must be a directory.`);
  return resolved;
}

async function resolveFileInside(root: string, candidate: string, label: string): Promise<string> {
  const resolved = await resolveExistingInside(root, candidate, label);
  if (!(await fs.stat(resolved)).isFile()) throw new Error(`${label} must be a regular file.`);
  return resolved;
}

async function resolveExistingInside(root: string, candidate: string, label: string): Promise<string> {
  assertStrictlyInside(root, candidate, label);
  const resolved = await fs.realpath(candidate);
  assertStrictlyInside(root, resolved, label);
  return resolved;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the workspace.`);
  }
}

function isSameOrContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portableRef(cwd: string, target: string): string {
  return path.relative(cwd, target).replace(/\\/gu, "/");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
}

function validIdPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0");
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
