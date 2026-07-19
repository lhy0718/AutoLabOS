import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonFile } from "../../utils/fs.js";
import { assertPromotionArtifactPrivacySafe } from "./promotionArtifactPrivacy.js";
import {
  inspectPromotionTrialCandidateLicensePacket,
  inspectPromotionTrialCandidateReviewerPacket,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST,
  PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST,
  PROMOTION_TRIAL_CANDIDATE_TASKS,
  type PromotionTrialCandidateLicensePacketManifest,
  type PromotionTrialCandidateReviewerPacketManifest
} from "./promotionBenchmarkTrialCandidateHandoff.js";
import {
  aggregatePromotionTrialCandidateLicenseStatuses,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK,
  PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS,
  parsePromotionTrialCandidateInitialAnnotationSet,
  parsePromotionTrialCandidateLicenseReviewSet,
  parsePromotionTrialCandidateLicenseTask,
  promotionTrialCandidateLicenseTaskIsCandidateScoped,
  validatePromotionTrialCandidateLicenseReviewCoverage,
  type PromotionTrialCandidateHumanLabel,
  type PromotionTrialCandidateInitialAnnotationSet,
  type PromotionTrialCandidateLicenseReview,
  type PromotionTrialCandidateLicenseReviewSet,
  type PromotionTrialCandidateLicenseStatus,
  type PromotionTrialCandidateLicenseTask,
  type PromotionTrialCandidateObservation,
  type PromotionTrialCandidateObservationValue
} from "./promotionBenchmarkTrialCandidateReviewContract.js";

export const PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_MANIFEST =
  "review-workspace.json";
export const PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_ATTESTATION =
  "attestation.json";
export const PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_AUDIT =
  "review-workspace-audit.json";
export const PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_MANIFEST =
  "license-review-workspace.json";
export const PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_ATTESTATION =
  "license-attestation.json";
export const PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_AUDIT =
  "license-review-workspace-audit.json";

const ANNOTATION_TEMPLATE = "annotation-template.json";
const LICENSE_TEMPLATE = "license-review-template.json";
const PACKET_DIR = "packet";
const ANNOTATIONS_DIR = "annotations";
const LICENSE_SUBJECTS_DIR = "subject-reviews";
const LICENSE_AGGREGATE_REVIEW = "aggregate-review.json";
const WORKSPACE_GUIDE = "WORKSPACE_GUIDE.md";
const LICENSE_WORKSPACE_GUIDE = "LICENSE_WORKSPACE_GUIDE.md";

type EditableObservationValue = PromotionTrialCandidateObservationValue | null;
type EditableLicenseStatus = PromotionTrialCandidateLicenseStatus | null;

interface EditableCandidateAnnotation {
  schema_version: "1.0";
  candidate_id: string;
  observations: Record<PromotionTrialCandidateObservation, EditableObservationValue>;
  evidence_refs: unknown[];
  rationale: string;
}

interface BlankAnnotationTemplate {
  handoff_id: string;
  annotator_id: string;
  annotations: EditableCandidateAnnotation[];
}

export interface PromotionTrialCandidateReviewWorkspaceAttestation {
  completed_by_human: boolean;
  peer_annotations_unseen: boolean;
  controller_map_unseen: boolean;
}

export interface PromotionTrialCandidateReviewWorkspaceManifest {
  schema_version: "1.0";
  handoff_id: string;
  annotator_id: string;
  status: "human_review_in_progress";
  task_count: number;
  packet_root: typeof PACKET_DIR;
  packet_manifest_sha256: string;
  source_template_sha256: string;
  attestation_path: typeof PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_ATTESTATION;
  candidate_files: Array<{ candidate_id: string; path: string }>;
  finalized_annotation_emitted: false;
  confirmatory_admitted: false;
  evidence_boundary: string;
}

export interface PromotionTrialCandidateReviewWorkspaceIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionTrialCandidateReviewWorkspaceAuditReport {
  schema_version: "1.0";
  generated_at: string;
  handoff_id: string | null;
  annotator_id: string | null;
  workspace_valid: boolean;
  ready_to_finalize: boolean;
  task_count: number;
  completed_annotation_count: number;
  incomplete_annotation_count: number;
  malformed_annotation_count: number;
  attestation: PromotionTrialCandidateReviewWorkspaceAttestation | null;
  attestation_complete: boolean;
  packet_integrity_valid: boolean;
  validation_issues: PromotionTrialCandidateReviewWorkspaceIssue[];
  evidence_boundary: string;
}

export interface PreparePromotionTrialCandidateReviewWorkspaceInput {
  cwd: string;
  packageRoot: string;
  outDir: string;
}

export interface PreparePromotionTrialCandidateReviewWorkspaceResult {
  handoff_id: string;
  annotator_id: string;
  task_count: number;
  output_dir: string;
  manifest_path: string;
}

export interface AuditPromotionTrialCandidateReviewWorkspaceInput {
  cwd: string;
  workspaceRoot: string;
  outDir: string;
}

export interface AuditPromotionTrialCandidateReviewWorkspaceResult {
  report: PromotionTrialCandidateReviewWorkspaceAuditReport;
  report_path: string;
  summary_path: string;
}

export interface FinalizePromotionTrialCandidateReviewWorkspaceInput {
  cwd: string;
  workspaceRoot: string;
  outputPath: string;
}

export interface FinalizePromotionTrialCandidateReviewWorkspaceResult {
  handoff_id: string;
  annotator_id: string;
  task_count: number;
  output_path: string;
  reviewer_root: string;
  preflight_required: true;
}

interface EditableLicenseReview {
  schema_version: "1.0";
  status: EditableLicenseStatus;
  evidence_refs: unknown[];
  rationale: string;
}

interface EditableLicenseSubjectReview extends EditableLicenseReview {
  subject_id: string;
}

interface BlankLicenseReviewTemplate {
  schema_version: "1.0" | "1.1";
  handoff_id: string;
  reviewer_id: string;
  review: EditableLicenseReview;
  subject_reviews: EditableLicenseSubjectReview[];
}

export interface PromotionTrialCandidateLicenseReviewWorkspaceAttestation {
  completed_by_human: boolean;
  candidate_annotations_unseen: boolean;
  controller_map_unseen: boolean;
}

export interface PromotionTrialCandidateLicenseReviewWorkspaceManifest {
  schema_version: "1.0";
  handoff_id: string;
  reviewer_id: string;
  status: "human_license_review_in_progress";
  review_scope: "source_only" | "candidate_scoped";
  subject_count: number;
  packet_root: typeof PACKET_DIR;
  packet_manifest_sha256: string;
  source_template_sha256: string;
  attestation_path: typeof PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_ATTESTATION;
  aggregate_review_path: typeof LICENSE_AGGREGATE_REVIEW;
  subject_files: Array<{ subject_id: string; path: string }>;
  finalized_license_review_emitted: false;
  confirmatory_admitted: false;
  evidence_boundary: string;
}

export interface PromotionTrialCandidateLicenseReviewWorkspaceAuditReport {
  schema_version: "1.0";
  generated_at: string;
  handoff_id: string | null;
  reviewer_id: string | null;
  review_scope: "source_only" | "candidate_scoped" | null;
  workspace_valid: boolean;
  ready_to_finalize: boolean;
  subject_count: number;
  completed_subject_review_count: number;
  incomplete_subject_review_count: number;
  malformed_subject_review_count: number;
  aggregate_review_complete: boolean;
  attestation: PromotionTrialCandidateLicenseReviewWorkspaceAttestation | null;
  attestation_complete: boolean;
  packet_integrity_valid: boolean;
  validation_issues: PromotionTrialCandidateReviewWorkspaceIssue[];
  evidence_boundary: string;
}

export interface PreparePromotionTrialCandidateLicenseReviewWorkspaceInput {
  cwd: string;
  packageRoot: string;
  outDir: string;
}

export interface PreparePromotionTrialCandidateLicenseReviewWorkspaceResult {
  handoff_id: string;
  reviewer_id: string;
  review_scope: "source_only" | "candidate_scoped";
  subject_count: number;
  output_dir: string;
  manifest_path: string;
}

export interface AuditPromotionTrialCandidateLicenseReviewWorkspaceInput {
  cwd: string;
  workspaceRoot: string;
  outDir: string;
}

export interface AuditPromotionTrialCandidateLicenseReviewWorkspaceResult {
  report: PromotionTrialCandidateLicenseReviewWorkspaceAuditReport;
  report_path: string;
  summary_path: string;
}

export interface FinalizePromotionTrialCandidateLicenseReviewWorkspaceInput {
  cwd: string;
  workspaceRoot: string;
  outputPath: string;
}

export interface FinalizePromotionTrialCandidateLicenseReviewWorkspaceResult {
  handoff_id: string;
  reviewer_id: string;
  review_scope: "source_only" | "candidate_scoped";
  subject_count: number;
  output_path: string;
  license_root: string;
  preflight_required: true;
}

interface LicenseWorkspaceInspection {
  report: PromotionTrialCandidateLicenseReviewWorkspaceAuditReport;
  manifest: PromotionTrialCandidateLicenseReviewWorkspaceManifest | null;
  finalizedReview: PromotionTrialCandidateLicenseReviewSet | null;
  workspaceRoot: string;
}
interface WorkspaceInspection {
  report: PromotionTrialCandidateReviewWorkspaceAuditReport;
  manifest: PromotionTrialCandidateReviewWorkspaceManifest | null;
  completedLabels: Map<string, PromotionTrialCandidateHumanLabel>;
  workspaceRoot: string;
}

export async function preparePromotionTrialCandidateReviewWorkspace(
  input: PreparePromotionTrialCandidateReviewWorkspaceInput
): Promise<PreparePromotionTrialCandidateReviewWorkspaceResult> {
  const cwd = path.resolve(input.cwd);
  const packageRoot = await resolveDirectoryInside(
    cwd,
    path.resolve(cwd, input.packageRoot),
    "Trial-candidate reviewer package"
  );
  const packetRoot = await resolveDirectoryInside(
    packageRoot,
    path.join(packageRoot, PACKET_DIR),
    "Trial-candidate reviewer packet"
  );
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Trial-candidate review workspace output");
  if (isSameOrContainedPath(packageRoot, outDir)) {
    throw new Error("Trial-candidate review workspace must stay outside the assigned package.");
  }
  await prepareFreshDirectoryParent(cwd, outDir, "Trial-candidate review workspace output");

  const packet = await requireValidReviewerPacket(packetRoot);
  const taskIds = await readReviewerTaskIds(packetRoot);
  const templatePath = await resolveFileInside(
    packageRoot,
    path.join(packageRoot, ANNOTATION_TEMPLATE),
    "Trial-candidate annotation template"
  );
  const templateBytes = await fs.readFile(templatePath);
  assertPromotionArtifactPrivacySafe(ANNOTATION_TEMPLATE, templateBytes);
  const template = parseBlankAnnotationTemplate(
    JSON.parse(templateBytes.toString("utf8")) as unknown,
    packet.handoff_id,
    taskIds
  );

  const stagingRoot = path.join(
    path.dirname(outDir),
    `.${path.basename(outDir)}.staging-${randomUUID()}`
  );
  await fs.mkdir(stagingRoot, { recursive: true });
  try {
    const targetPacketRoot = path.join(stagingRoot, PACKET_DIR);
    await copyBoundReviewerPacket(packetRoot, targetPacketRoot, packet);
    const candidateFiles = template.annotations.map((annotation) => ({
      candidate_id: annotation.candidate_id,
      path: `${ANNOTATIONS_DIR}/${annotation.candidate_id}.json`
    }));
    const manifest: PromotionTrialCandidateReviewWorkspaceManifest = {
      schema_version: "1.0",
      handoff_id: template.handoff_id,
      annotator_id: template.annotator_id,
      status: "human_review_in_progress",
      task_count: taskIds.length,
      packet_root: PACKET_DIR,
      packet_manifest_sha256: await hashFile(path.join(
        targetPacketRoot,
        PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST
      )),
      source_template_sha256: sha256(templateBytes),
      attestation_path: PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_ATTESTATION,
      candidate_files: candidateFiles,
      finalized_annotation_emitted: false,
      confirmatory_admitted: false,
      evidence_boundary: "This editable workspace splits one assigned blank human-review template into resumable per-candidate files. It does not supply labels, set attestations, verify reviewer identity or independence, compare reviewers, adjudicate findings, or admit confirmatory evidence."
    };
    await writeJsonFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_MANIFEST),
      manifest
    );
    await writeJsonFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_ATTESTATION),
      blankAttestation()
    );
    for (const annotation of template.annotations) {
      await writeJsonFile(
        path.join(stagingRoot, ANNOTATIONS_DIR, `${annotation.candidate_id}.json`),
        annotation
      );
    }
    await fs.writeFile(path.join(stagingRoot, WORKSPACE_GUIDE), workspaceGuide(), "utf8");
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    handoff_id: template.handoff_id,
    annotator_id: template.annotator_id,
    task_count: taskIds.length,
    output_dir: portableRef(cwd, outDir),
    manifest_path: portableRef(
      cwd,
      path.join(outDir, PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_MANIFEST)
    )
  };
}

export async function auditPromotionTrialCandidateReviewWorkspace(
  input: AuditPromotionTrialCandidateReviewWorkspaceInput
): Promise<AuditPromotionTrialCandidateReviewWorkspaceResult> {
  const cwd = path.resolve(input.cwd);
  const inspection = await inspectWorkspace(cwd, input.workspaceRoot);
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Trial-candidate review workspace audit output");
  if (isSameOrContainedPath(inspection.workspaceRoot, outDir)) {
    throw new Error("Trial-candidate review workspace audit output must stay outside the editable workspace.");
  }
  await prepareFreshDirectoryParent(cwd, outDir, "Trial-candidate review workspace audit output");
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_AUDIT);
  const summaryPath = path.join(outDir, "review-workspace-audit.md");
  await writeJsonFile(reportPath, inspection.report);
  await fs.writeFile(summaryPath, renderAuditSummary(inspection.report), "utf8");
  return {
    report: inspection.report,
    report_path: portableRef(cwd, reportPath),
    summary_path: portableRef(cwd, summaryPath)
  };
}

export async function finalizePromotionTrialCandidateReviewWorkspace(
  input: FinalizePromotionTrialCandidateReviewWorkspaceInput
): Promise<FinalizePromotionTrialCandidateReviewWorkspaceResult> {
  const cwd = path.resolve(input.cwd);
  const inspection = await inspectWorkspace(cwd, input.workspaceRoot);
  if (!inspection.report.ready_to_finalize || !inspection.manifest) {
    throw new Error(
      `Trial-candidate review workspace is not ready to finalize: ${
        inspection.report.validation_issues.map((issue) => issue.code).join(", ")
        || `${inspection.report.completed_annotation_count}/${inspection.report.task_count} annotations complete or attestation incomplete`
      }.`
    );
  }
  const outputPath = path.resolve(cwd, input.outputPath);
  assertStrictlyInside(cwd, outputPath, "Trial-candidate finalized annotation output");
  if (isSameOrContainedPath(inspection.workspaceRoot, outputPath)) {
    throw new Error("Finalized annotation output must stay outside the editable workspace.");
  }
  await prepareFreshFileParent(cwd, outputPath, "Trial-candidate finalized annotation output");
  const annotation = parsePromotionTrialCandidateInitialAnnotationSet({
    schema_version: "1.0",
    handoff_id: inspection.manifest.handoff_id,
    annotator_id: inspection.manifest.annotator_id,
    label_source: "human",
    review_role: "initial",
    independence_attestation: {
      completed_by_human: true,
      peer_annotations_unseen: true,
      controller_map_unseen: true
    },
    annotations: inspection.manifest.candidate_files.map((item) => {
      const label = inspection.completedLabels.get(item.candidate_id);
      if (!label) throw new Error(`Completed annotation missing: ${item.candidate_id}.`);
      return label;
    })
  } satisfies PromotionTrialCandidateInitialAnnotationSet);
  await writeJsonFile(outputPath, annotation);
  return {
    handoff_id: inspection.manifest.handoff_id,
    annotator_id: inspection.manifest.annotator_id,
    task_count: annotation.annotations.length,
    output_path: portableRef(cwd, outputPath),
    reviewer_root: portableRef(cwd, path.join(inspection.workspaceRoot, PACKET_DIR)),
    preflight_required: true
  };
}

export async function preparePromotionTrialCandidateLicenseReviewWorkspace(
  input: PreparePromotionTrialCandidateLicenseReviewWorkspaceInput
): Promise<PreparePromotionTrialCandidateLicenseReviewWorkspaceResult> {
  const cwd = path.resolve(input.cwd);
  const packageRoot = await resolveDirectoryInside(
    cwd,
    path.resolve(cwd, input.packageRoot),
    "Trial-candidate license-reviewer package"
  );
  const packetRoot = await resolveDirectoryInside(
    packageRoot,
    path.join(packageRoot, PACKET_DIR),
    "Trial-candidate license-reviewer packet"
  );
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Trial-candidate license review workspace output");
  if (isSameOrContainedPath(packageRoot, outDir)) {
    throw new Error("Trial-candidate license review workspace must stay outside the assigned package.");
  }
  await prepareFreshDirectoryParent(
    cwd,
    outDir,
    "Trial-candidate license review workspace output"
  );

  const packet = await requireValidLicensePacket(packetRoot);
  const task = await readLicenseTask(packetRoot);
  const templatePath = await resolveFileInside(
    packageRoot,
    path.join(packageRoot, LICENSE_TEMPLATE),
    "Trial-candidate license review template"
  );
  const templateBytes = await fs.readFile(templatePath);
  assertPromotionArtifactPrivacySafe(LICENSE_TEMPLATE, templateBytes);
  const template = parseBlankLicenseTemplate(
    JSON.parse(templateBytes.toString("utf8")) as unknown,
    packet.handoff_id,
    task
  );
  const reviewScope = promotionTrialCandidateLicenseTaskIsCandidateScoped(task)
    ? "candidate_scoped" as const
    : "source_only" as const;

  const stagingRoot = path.join(
    path.dirname(outDir),
    `.${path.basename(outDir)}.staging-${randomUUID()}`
  );
  await fs.mkdir(stagingRoot, { recursive: true });
  try {
    const targetPacketRoot = path.join(stagingRoot, PACKET_DIR);
    await copyBoundLicensePacket(packetRoot, targetPacketRoot, packet);
    const subjectFiles = template.subject_reviews.map((review) => ({
      subject_id: review.subject_id,
      path: `${LICENSE_SUBJECTS_DIR}/${review.subject_id}.json`
    }));
    const manifest: PromotionTrialCandidateLicenseReviewWorkspaceManifest = {
      schema_version: "1.0",
      handoff_id: template.handoff_id,
      reviewer_id: template.reviewer_id,
      status: "human_license_review_in_progress",
      review_scope: reviewScope,
      subject_count: subjectFiles.length,
      packet_root: PACKET_DIR,
      packet_manifest_sha256: await hashFile(path.join(
        targetPacketRoot,
        PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST
      )),
      source_template_sha256: sha256(templateBytes),
      attestation_path: PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_ATTESTATION,
      aggregate_review_path: LICENSE_AGGREGATE_REVIEW,
      subject_files: subjectFiles,
      finalized_license_review_emitted: false,
      confirmatory_admitted: false,
      evidence_boundary: "This editable workspace splits one assigned blank human source-license review into resumable files. It does not supply decisions, set attestations, verify reviewer identity or legal authority, grant redistribution permission, inspect candidate annotations, or admit confirmatory evidence."
    };
    await writeJsonFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_MANIFEST),
      manifest
    );
    await writeJsonFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_ATTESTATION),
      blankLicenseAttestation()
    );
    await writeJsonFile(path.join(stagingRoot, LICENSE_AGGREGATE_REVIEW), template.review);
    await fs.mkdir(path.join(stagingRoot, LICENSE_SUBJECTS_DIR), { recursive: true });
    for (const review of template.subject_reviews) {
      await writeJsonFile(
        path.join(stagingRoot, LICENSE_SUBJECTS_DIR, `${review.subject_id}.json`),
        review
      );
    }
    await fs.writeFile(
      path.join(stagingRoot, LICENSE_WORKSPACE_GUIDE),
      licenseWorkspaceGuide(reviewScope),
      "utf8"
    );
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    handoff_id: template.handoff_id,
    reviewer_id: template.reviewer_id,
    review_scope: reviewScope,
    subject_count: template.subject_reviews.length,
    output_dir: portableRef(cwd, outDir),
    manifest_path: portableRef(
      cwd,
      path.join(outDir, PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_MANIFEST)
    )
  };
}

export async function auditPromotionTrialCandidateLicenseReviewWorkspace(
  input: AuditPromotionTrialCandidateLicenseReviewWorkspaceInput
): Promise<AuditPromotionTrialCandidateLicenseReviewWorkspaceResult> {
  const cwd = path.resolve(input.cwd);
  const inspection = await inspectLicenseWorkspace(cwd, input.workspaceRoot);
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Trial-candidate license review workspace audit output");
  if (isSameOrContainedPath(inspection.workspaceRoot, outDir)) {
    throw new Error("License review workspace audit output must stay outside the editable workspace.");
  }
  await prepareFreshDirectoryParent(
    cwd,
    outDir,
    "Trial-candidate license review workspace audit output"
  );
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(
    outDir,
    PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_AUDIT
  );
  const summaryPath = path.join(outDir, "license-review-workspace-audit.md");
  await writeJsonFile(reportPath, inspection.report);
  await fs.writeFile(summaryPath, renderLicenseAuditSummary(inspection.report), "utf8");
  return {
    report: inspection.report,
    report_path: portableRef(cwd, reportPath),
    summary_path: portableRef(cwd, summaryPath)
  };
}

export async function finalizePromotionTrialCandidateLicenseReviewWorkspace(
  input: FinalizePromotionTrialCandidateLicenseReviewWorkspaceInput
): Promise<FinalizePromotionTrialCandidateLicenseReviewWorkspaceResult> {
  const cwd = path.resolve(input.cwd);
  const inspection = await inspectLicenseWorkspace(cwd, input.workspaceRoot);
  if (!inspection.report.ready_to_finalize
      || !inspection.manifest
      || !inspection.finalizedReview) {
    throw new Error(
      `Trial-candidate license review workspace is not ready to finalize: ${
        inspection.report.validation_issues.map((issue) => issue.code).join(", ")
        || `${inspection.report.completed_subject_review_count}/${inspection.report.subject_count} subject reviews complete, aggregate review or attestation incomplete`
      }.`
    );
  }
  const outputPath = path.resolve(cwd, input.outputPath);
  assertStrictlyInside(cwd, outputPath, "Trial-candidate finalized license review output");
  if (isSameOrContainedPath(inspection.workspaceRoot, outputPath)) {
    throw new Error("Finalized license review output must stay outside the editable workspace.");
  }
  await prepareFreshFileParent(
    cwd,
    outputPath,
    "Trial-candidate finalized license review output"
  );
  await writeJsonFile(outputPath, inspection.finalizedReview);
  return {
    handoff_id: inspection.manifest.handoff_id,
    reviewer_id: inspection.manifest.reviewer_id,
    review_scope: inspection.manifest.review_scope,
    subject_count: inspection.report.subject_count,
    output_path: portableRef(cwd, outputPath),
    license_root: portableRef(cwd, path.join(inspection.workspaceRoot, PACKET_DIR)),
    preflight_required: true
  };
}

async function inspectWorkspace(cwd: string, workspacePath: string): Promise<WorkspaceInspection> {
  const workspaceRoot = await resolveDirectoryInside(
    cwd,
    path.resolve(cwd, workspacePath),
    "Trial-candidate review workspace"
  );
  const issues: PromotionTrialCandidateReviewWorkspaceIssue[] = [];
  let manifest: PromotionTrialCandidateReviewWorkspaceManifest | null = null;
  try {
    const bytes = await readContainedRegularFile(
      workspaceRoot,
      path.join(workspaceRoot, PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_MANIFEST)
    );
    assertPromotionArtifactPrivacySafe(
      PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_MANIFEST,
      bytes
    );
    manifest = parseWorkspaceManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    issues.push({
      code: "trial_candidate_review_workspace_manifest_invalid",
      message: errorMessage(error)
    });
  }

  let packetIntegrityValid = false;
  let taskIds: string[] = [];
  if (manifest) {
    try {
      const packetRoot = await resolveDirectoryInside(
        workspaceRoot,
        path.join(workspaceRoot, manifest.packet_root),
        "Trial-candidate review workspace packet"
      );
      const packet = await requireValidReviewerPacket(packetRoot);
      taskIds = await readReviewerTaskIds(packetRoot);
      const packetHash = await hashFile(path.join(
        packetRoot,
        PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST
      ));
      if (packet.handoff_id !== manifest.handoff_id
          || packet.candidate_count !== manifest.task_count
          || packetHash !== manifest.packet_manifest_sha256
          || !sameOrderedValues(
            taskIds,
            manifest.candidate_files.map((item) => item.candidate_id)
          )) {
        throw new Error("Workspace manifest and copied reviewer packet diverge.");
      }
      packetIntegrityValid = true;
    } catch (error) {
      issues.push({
        code: "trial_candidate_review_workspace_packet_invalid",
        message: errorMessage(error)
      });
    }
  }

  let attestation: PromotionTrialCandidateReviewWorkspaceAttestation | null = null;
  if (manifest) {
    try {
      const bytes = await readContainedRegularFile(
        workspaceRoot,
        path.join(workspaceRoot, manifest.attestation_path)
      );
      assertPromotionArtifactPrivacySafe(manifest.attestation_path, bytes);
      attestation = parseWorkspaceAttestation(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch (error) {
      issues.push({
        code: "trial_candidate_review_workspace_attestation_invalid",
        message: errorMessage(error)
      });
    }
  }

  const completedLabels = new Map<string, PromotionTrialCandidateHumanLabel>();
  let incompleteCount = 0;
  let malformedCount = 0;
  if (manifest) {
    const expectedPaths = new Set(manifest.candidate_files.map((item) => item.path));
    try {
      const observedPaths = await inventoryRegularFiles(
        workspaceRoot,
        path.join(workspaceRoot, ANNOTATIONS_DIR)
      );
      for (const observed of observedPaths) {
        if (!expectedPaths.has(observed)) {
          issues.push({
            code: "trial_candidate_review_workspace_unknown_annotation_file",
            message: "The annotations directory contains an undeclared file.",
            ref: observed
          });
        }
      }
    } catch (error) {
      issues.push({
        code: "trial_candidate_review_workspace_annotation_inventory_invalid",
        message: errorMessage(error)
      });
    }
    for (const item of manifest.candidate_files) {
      try {
        const bytes = await readContainedRegularFile(
          workspaceRoot,
          path.join(workspaceRoot, item.path)
        );
        assertPromotionArtifactPrivacySafe(item.path, bytes);
        const editable = parseEditableCandidateAnnotation(
          JSON.parse(bytes.toString("utf8")) as unknown,
          item.candidate_id
        );
        const label = completedHumanLabel(editable, manifest);
        if (label) completedLabels.set(item.candidate_id, label);
        else incompleteCount += 1;
      } catch (error) {
        malformedCount += 1;
        issues.push({
          code: "trial_candidate_review_workspace_annotation_invalid",
          message: errorMessage(error),
          ref: item.candidate_id
        });
      }
    }
  }

  const attestationComplete = attestation !== null
    && attestation.completed_by_human
    && attestation.peer_annotations_unseen
    && attestation.controller_map_unseen;
  const taskCount = manifest?.task_count || taskIds.length;
  const completedCount = completedLabels.size;
  const workspaceValid = manifest !== null
    && packetIntegrityValid
    && attestation !== null
    && malformedCount === 0
    && issues.length === 0;
  const readyToFinalize = workspaceValid
    && completedCount === taskCount
    && incompleteCount === 0
    && attestationComplete;
  return {
    report: {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      handoff_id: manifest?.handoff_id || null,
      annotator_id: manifest?.annotator_id || null,
      workspace_valid: workspaceValid,
      ready_to_finalize: readyToFinalize,
      task_count: taskCount,
      completed_annotation_count: completedCount,
      incomplete_annotation_count: incompleteCount,
      malformed_annotation_count: malformedCount,
      attestation,
      attestation_complete: attestationComplete,
      packet_integrity_valid: packetIntegrityValid,
      validation_issues: issues,
      evidence_boundary: "This audit reports editable-file integrity and structural completion only. It does not infer that a human performed the review, validate real-world identity or independence, semantically verify evidence citations, compare reviewers, adjudicate labels, or admit confirmatory evidence. Finalized output must still pass the reviewer-packet annotation preflight."
    },
    manifest,
    completedLabels,
    workspaceRoot
  };
}

async function inspectLicenseWorkspace(
  cwd: string,
  workspacePath: string
): Promise<LicenseWorkspaceInspection> {
  const workspaceRoot = await resolveDirectoryInside(
    cwd,
    path.resolve(cwd, workspacePath),
    "Trial-candidate license review workspace"
  );
  const issues: PromotionTrialCandidateReviewWorkspaceIssue[] = [];
  let manifest: PromotionTrialCandidateLicenseReviewWorkspaceManifest | null = null;
  try {
    const bytes = await readContainedRegularFile(
      workspaceRoot,
      path.join(workspaceRoot, PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_MANIFEST)
    );
    assertPromotionArtifactPrivacySafe(
      PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_MANIFEST,
      bytes
    );
    manifest = parseLicenseWorkspaceManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    issues.push({
      code: "trial_candidate_license_review_workspace_manifest_invalid",
      message: errorMessage(error)
    });
  }

  let packetIntegrityValid = false;
  let task: PromotionTrialCandidateLicenseTask | null = null;
  if (manifest) {
    try {
      const packetRoot = await resolveDirectoryInside(
        workspaceRoot,
        path.join(workspaceRoot, manifest.packet_root),
        "Trial-candidate license review workspace packet"
      );
      const packet = await requireValidLicensePacket(packetRoot);
      task = await readLicenseTask(packetRoot);
      const packetHash = await hashFile(path.join(
        packetRoot,
        PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST
      ));
      const subjectIds = promotionTrialCandidateLicenseTaskIsCandidateScoped(task)
        ? task.subjects.map((item) => item.subject_id)
        : [];
      if (packet.handoff_id !== manifest.handoff_id
          || task.handoff_id !== manifest.handoff_id
          || packetHash !== manifest.packet_manifest_sha256
          || manifest.review_scope !== (task.schema_version === "1.1" ? "candidate_scoped" : "source_only")
          || manifest.subject_count !== subjectIds.length
          || !sameOrderedValues(
            [...subjectIds].sort(),
            manifest.subject_files.map((item) => item.subject_id).sort()
          )) {
        throw new Error("Workspace manifest and copied license-reviewer packet diverge.");
      }
      packetIntegrityValid = true;
    } catch (error) {
      issues.push({
        code: "trial_candidate_license_review_workspace_packet_invalid",
        message: errorMessage(error)
      });
    }
  }

  let attestation: PromotionTrialCandidateLicenseReviewWorkspaceAttestation | null = null;
  if (manifest) {
    try {
      const bytes = await readContainedRegularFile(
        workspaceRoot,
        path.join(workspaceRoot, manifest.attestation_path)
      );
      assertPromotionArtifactPrivacySafe(manifest.attestation_path, bytes);
      attestation = parseLicenseWorkspaceAttestation(
        JSON.parse(bytes.toString("utf8")) as unknown
      );
    } catch (error) {
      issues.push({
        code: "trial_candidate_license_review_workspace_attestation_invalid",
        message: errorMessage(error)
      });
    }
  }
  const attestationComplete = attestation !== null
    && attestation.completed_by_human
    && attestation.candidate_annotations_unseen
    && attestation.controller_map_unseen;

  let aggregateReview: PromotionTrialCandidateLicenseReview | null = null;
  let aggregateReviewComplete = false;
  if (manifest) {
    try {
      const bytes = await readContainedRegularFile(
        workspaceRoot,
        path.join(workspaceRoot, manifest.aggregate_review_path)
      );
      assertPromotionArtifactPrivacySafe(manifest.aggregate_review_path, bytes);
      const editable = parseEditableLicenseReview(
        JSON.parse(bytes.toString("utf8")) as unknown
      );
      aggregateReview = completedStandaloneLicenseReview(
        editable,
        manifest.handoff_id,
        manifest.reviewer_id
      );
      aggregateReviewComplete = aggregateReview !== null;
    } catch (error) {
      issues.push({
        code: "trial_candidate_license_review_workspace_aggregate_invalid",
        message: errorMessage(error)
      });
    }
  }

  const completedSubjectReviews = new Map<
    string,
    PromotionTrialCandidateLicenseReview & { subject_id: string }
  >();
  let incompleteCount = 0;
  let malformedCount = 0;
  if (manifest) {
    const expectedPaths = new Set(manifest.subject_files.map((item) => item.path));
    try {
      const observedPaths = await inventoryRegularFiles(
        workspaceRoot,
        path.join(workspaceRoot, LICENSE_SUBJECTS_DIR)
      );
      for (const observed of observedPaths) {
        if (!expectedPaths.has(observed)) {
          issues.push({
            code: "trial_candidate_license_review_workspace_unknown_subject_file",
            message: "The subject-reviews directory contains an undeclared file.",
            ref: observed
          });
        }
      }
    } catch (error) {
      issues.push({
        code: "trial_candidate_license_review_workspace_subject_inventory_invalid",
        message: errorMessage(error)
      });
    }
    for (const item of manifest.subject_files) {
      try {
        const bytes = await readContainedRegularFile(
          workspaceRoot,
          path.join(workspaceRoot, item.path)
        );
        assertPromotionArtifactPrivacySafe(item.path, bytes);
        const editable = parseEditableLicenseSubjectReview(
          JSON.parse(bytes.toString("utf8")) as unknown,
          item.subject_id
        );
        const review = completedLicenseSubjectReview(
          editable,
          manifest.handoff_id,
          manifest.reviewer_id
        );
        if (review) completedSubjectReviews.set(item.subject_id, review);
        else incompleteCount += 1;
      } catch (error) {
        malformedCount += 1;
        issues.push({
          code: "trial_candidate_license_review_workspace_subject_invalid",
          message: errorMessage(error),
          ref: item.subject_id
        });
      }
    }
  }

  let contractCompleteReview: PromotionTrialCandidateLicenseReviewSet | null = null;
  if (manifest
      && task
      && aggregateReview
      && completedSubjectReviews.size === manifest.subject_count
      && incompleteCount === 0
      && malformedCount === 0) {
    try {
      contractCompleteReview = assembleFinalLicenseReview(
        manifest,
        task,
        aggregateReview,
        completedSubjectReviews
      );
    } catch (error) {
      issues.push({
        code: "trial_candidate_license_review_workspace_final_contract_invalid",
        message: errorMessage(error)
      });
    }
  }
  const finalizedReview = attestationComplete ? contractCompleteReview : null;

  const subjectCount = manifest?.subject_count
    ?? (task && promotionTrialCandidateLicenseTaskIsCandidateScoped(task)
      ? task.subjects.length
      : 0);
  const completedCount = completedSubjectReviews.size;
  const workspaceValid = manifest !== null
    && packetIntegrityValid
    && attestation !== null
    && malformedCount === 0
    && issues.length === 0;
  const readyToFinalize = workspaceValid
    && aggregateReviewComplete
    && completedCount === subjectCount
    && incompleteCount === 0
    && attestationComplete
    && finalizedReview !== null;
  return {
    report: {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      handoff_id: manifest?.handoff_id || null,
      reviewer_id: manifest?.reviewer_id || null,
      review_scope: manifest?.review_scope || null,
      workspace_valid: workspaceValid,
      ready_to_finalize: readyToFinalize,
      subject_count: subjectCount,
      completed_subject_review_count: completedCount,
      incomplete_subject_review_count: incompleteCount,
      malformed_subject_review_count: malformedCount,
      aggregate_review_complete: aggregateReviewComplete,
      attestation,
      attestation_complete: attestationComplete,
      packet_integrity_valid: packetIntegrityValid,
      validation_issues: issues,
      evidence_boundary: "This audit reports copied-packet integrity, editable-file structure, coverage, conservative aggregation, and attestation fields only. It does not infer that a human performed the review, validate reviewer identity or legal authority, verify real-world license grants, inspect candidate annotations, or admit confirmatory evidence. Finalized output must still pass the packet-bound license-review preflight."
    },
    manifest,
    finalizedReview,
    workspaceRoot
  };
}

function parseBlankAnnotationTemplate(
  value: unknown,
  handoffId: string,
  taskIds: string[]
): BlankAnnotationTemplate {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "handoff_id", "annotator_id", "label_source",
        "review_role", "independence_attestation", "annotations"
      ])
      || value.schema_version !== "1.0"
      || value.handoff_id !== handoffId
      || !validId(value.annotator_id)
      || value.label_source !== "human"
      || value.review_role !== "initial"
      || !isRecord(value.independence_attestation)
      || !hasExactKeys(value.independence_attestation, [
        "completed_by_human", "peer_annotations_unseen", "controller_map_unseen"
      ])
      || value.independence_attestation.completed_by_human !== false
      || value.independence_attestation.peer_annotations_unseen !== false
      || value.independence_attestation.controller_map_unseen !== false
      || !Array.isArray(value.annotations)
      || value.annotations.length !== taskIds.length) {
    throw new Error("Assigned package contains an invalid blank annotation template.");
  }
  const annotations = value.annotations.map(parseBlankTemplateCandidate);
  if (!sameOrderedValues(
    [...annotations.map((item) => item.candidate_id)].sort(),
    [...taskIds].sort()
  )) {
    throw new Error("Assigned annotation template task coverage changed.");
  }
  return {
    handoff_id: value.handoff_id,
    annotator_id: value.annotator_id,
    annotations
  };
}

function parseBlankTemplateCandidate(value: unknown): EditableCandidateAnnotation {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "candidate_id", "observations", "evidence_refs", "rationale"
      ])) {
    throw new Error("Assigned annotation template contains an invalid candidate row.");
  }
  return parseEditableCandidateAnnotation({
    schema_version: "1.0",
    ...value
  }, undefined, true);
}

function parseEditableCandidateAnnotation(
  value: unknown,
  expectedCandidateId?: string,
  requireBlank = false
): EditableCandidateAnnotation {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "candidate_id", "observations", "evidence_refs", "rationale"
      ])
      || value.schema_version !== "1.0"
      || !validId(value.candidate_id)
      || (expectedCandidateId !== undefined && value.candidate_id !== expectedCandidateId)
      || !isRecord(value.observations)
      || !hasExactKeys(value.observations, [...PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS])
      || !Array.isArray(value.evidence_refs)
      || typeof value.rationale !== "string") {
    throw new Error("Candidate annotation has an invalid editable structure.");
  }
  const observationRecord = value.observations;
  const observations = Object.fromEntries(
    PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.map((field) => {
      const fieldValue = observationRecord[field];
      if (fieldValue !== null
          && fieldValue !== "positive"
          && fieldValue !== "negative"
          && fieldValue !== "uncertain") {
        throw new Error(`Candidate annotation has an invalid observation: ${field}.`);
      }
      return [field, fieldValue];
    })
  ) as Record<PromotionTrialCandidateObservation, EditableObservationValue>;
  if (requireBlank
      && (PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.some((field) => observations[field] !== null)
        || value.evidence_refs.length !== 0
        || value.rationale !== "")) {
    throw new Error("Assigned annotation template must be blank.");
  }
  validateEditableEvidenceAndRationale(
    value.candidate_id,
    observations,
    value.evidence_refs,
    value.rationale
  );
  return {
    schema_version: "1.0",
    candidate_id: value.candidate_id,
    observations,
    evidence_refs: value.evidence_refs,
    rationale: value.rationale
  };
}

function validateEditableEvidenceAndRationale(
  candidateId: string,
  observations: Record<PromotionTrialCandidateObservation, EditableObservationValue>,
  evidenceRefs: unknown[],
  rationale: string
): void {
  parsePromotionTrialCandidateInitialAnnotationSet({
    schema_version: "1.0",
    handoff_id: "workspace-validation",
    annotator_id: "workspace-reviewer",
    label_source: "human",
    review_role: "initial",
    independence_attestation: {
      completed_by_human: true,
      peer_annotations_unseen: true,
      controller_map_unseen: true
    },
    annotations: [{
      candidate_id: candidateId,
      observations: Object.fromEntries(PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.map(
        (field) => [field, observations[field] ?? "uncertain"]
      )),
      evidence_refs: evidenceRefs,
      rationale: rationale.trim() || "Review in progress."
    }]
  });
}

function completedHumanLabel(
  editable: EditableCandidateAnnotation,
  manifest: PromotionTrialCandidateReviewWorkspaceManifest
): PromotionTrialCandidateHumanLabel | null {
  if (PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.some(
    (field) => editable.observations[field] === null
  ) || editable.rationale.trim().length === 0) {
    return null;
  }
  const {
    schema_version: _workspaceSchemaVersion,
    ...humanLabel
  } = editable;
  const parsed = parsePromotionTrialCandidateInitialAnnotationSet({
    schema_version: "1.0",
    handoff_id: manifest.handoff_id,
    annotator_id: manifest.annotator_id,
    label_source: "human",
    review_role: "initial",
    independence_attestation: {
      completed_by_human: true,
      peer_annotations_unseen: true,
      controller_map_unseen: true
    },
    annotations: [humanLabel]
  });
  return parsed.annotations[0];
}

function parseBlankLicenseTemplate(
  value: unknown,
  handoffId: string,
  task: PromotionTrialCandidateLicenseTask
): BlankLicenseReviewTemplate {
  const candidateScoped = promotionTrialCandidateLicenseTaskIsCandidateScoped(task);
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "handoff_id", "reviewer_id", "label_source",
        "review_role", "independence_attestation", "review",
        ...(candidateScoped ? ["subject_reviews"] : [])
      ])
      || value.schema_version !== task.schema_version
      || value.handoff_id !== handoffId
      || task.handoff_id !== handoffId
      || !validId(value.reviewer_id)
      || value.label_source !== "human"
      || value.review_role !== "source_license"
      || !isRecord(value.independence_attestation)
      || !hasExactKeys(value.independence_attestation, [
        "completed_by_human", "candidate_annotations_unseen", "controller_map_unseen"
      ])
      || value.independence_attestation.completed_by_human !== false
      || value.independence_attestation.candidate_annotations_unseen !== false
      || value.independence_attestation.controller_map_unseen !== false
      || !isRecord(value.review)) {
    throw new Error("Assigned package contains an invalid blank license review template.");
  }
  const review = parseEditableLicenseReview({
    schema_version: "1.0",
    ...value.review
  }, true);
  if (!candidateScoped) {
    return {
      schema_version: "1.0",
      handoff_id: value.handoff_id,
      reviewer_id: value.reviewer_id,
      review,
      subject_reviews: []
    };
  }
  if (!Array.isArray(value.subject_reviews)
      || value.subject_reviews.length !== task.subjects.length) {
    throw new Error("Assigned package contains invalid blank subject-license reviews.");
  }
  const subjectReviews = value.subject_reviews.map((item) => {
    if (!isRecord(item)) {
      throw new Error("Assigned package contains an invalid blank subject-license row.");
    }
    return parseEditableLicenseSubjectReview({
      schema_version: "1.0",
      ...item
    }, undefined, true);
  });
  if (!sameOrderedValues(
    subjectReviews.map((item) => item.subject_id).sort(),
    task.subjects.map((item) => item.subject_id).sort()
  )) {
    throw new Error("Assigned license review template subject coverage changed.");
  }
  return {
    schema_version: "1.1",
    handoff_id: value.handoff_id,
    reviewer_id: value.reviewer_id,
    review,
    subject_reviews: subjectReviews
  };
}

function parseEditableLicenseReview(
  value: unknown,
  requireBlank = false
): EditableLicenseReview {
  if (!isRecord(value)
      || !hasExactKeys(value, ["schema_version", "status", "evidence_refs", "rationale"])
      || value.schema_version !== "1.0"
      || (value.status !== null && !isLicenseStatus(value.status))
      || !Array.isArray(value.evidence_refs)
      || value.evidence_refs.length > 16
      || new Set(value.evidence_refs).size !== value.evidence_refs.length
      || !value.evidence_refs.every((item) =>
        typeof item === "string"
        && item.trim().length > 0
        && item.length <= 2048)
      || typeof value.rationale !== "string"
      || value.rationale.length > 4000) {
    throw new Error("License review has an invalid editable structure.");
  }
  if (requireBlank
      && (value.status !== null
        || value.evidence_refs.length !== 0
        || value.rationale !== "")) {
    throw new Error("Assigned license review template must be blank.");
  }
  if (value.status !== null && value.rationale.trim().length > 0) {
    completedStandaloneLicenseReview({
      schema_version: "1.0",
      status: value.status,
      evidence_refs: value.evidence_refs,
      rationale: value.rationale
    }, "workspace-validation", "workspace-reviewer");
  }
  return {
    schema_version: "1.0",
    status: value.status,
    evidence_refs: [...value.evidence_refs],
    rationale: value.rationale
  };
}

function parseEditableLicenseSubjectReview(
  value: unknown,
  expectedSubjectId?: string,
  requireBlank = false
): EditableLicenseSubjectReview {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "subject_id", "status", "evidence_refs", "rationale"
      ])
      || !validId(value.subject_id)
      || (expectedSubjectId !== undefined && value.subject_id !== expectedSubjectId)) {
    throw new Error("Subject-license review has an invalid editable structure.");
  }
  const review = parseEditableLicenseReview({
    schema_version: value.schema_version,
    status: value.status,
    evidence_refs: value.evidence_refs,
    rationale: value.rationale
  }, requireBlank);
  return {
    ...review,
    subject_id: value.subject_id
  };
}

function completedStandaloneLicenseReview(
  editable: EditableLicenseReview,
  handoffId: string,
  reviewerId: string
): PromotionTrialCandidateLicenseReview | null {
  if (editable.status === null || editable.rationale.trim().length === 0) return null;
  return parsePromotionTrialCandidateLicenseReviewSet({
    schema_version: "1.0",
    handoff_id: handoffId,
    reviewer_id: reviewerId,
    label_source: "human",
    review_role: "source_license",
    independence_attestation: {
      completed_by_human: true,
      candidate_annotations_unseen: true,
      controller_map_unseen: true
    },
    review: {
      status: editable.status,
      evidence_refs: editable.evidence_refs,
      rationale: editable.rationale
    }
  }).review;
}

function completedLicenseSubjectReview(
  editable: EditableLicenseSubjectReview,
  handoffId: string,
  reviewerId: string
): (PromotionTrialCandidateLicenseReview & { subject_id: string }) | null {
  if (editable.status === null || editable.rationale.trim().length === 0) return null;
  const parsed = parsePromotionTrialCandidateLicenseReviewSet({
    schema_version: "1.1",
    handoff_id: handoffId,
    reviewer_id: reviewerId,
    label_source: "human",
    review_role: "source_license",
    independence_attestation: {
      completed_by_human: true,
      candidate_annotations_unseen: true,
      controller_map_unseen: true
    },
    review: {
      status: editable.status,
      evidence_refs: editable.evidence_refs,
      rationale: editable.rationale
    },
    subject_reviews: [{
      subject_id: editable.subject_id,
      status: editable.status,
      evidence_refs: editable.evidence_refs,
      rationale: editable.rationale
    }]
  });
  if (parsed.schema_version !== "1.1") {
    throw new Error("Completed subject-license review has the wrong scope.");
  }
  return parsed.subject_reviews[0];
}

function assembleFinalLicenseReview(
  manifest: PromotionTrialCandidateLicenseReviewWorkspaceManifest,
  task: PromotionTrialCandidateLicenseTask,
  aggregateReview: PromotionTrialCandidateLicenseReview,
  subjectReviews: ReadonlyMap<
    string,
    PromotionTrialCandidateLicenseReview & { subject_id: string }
  >
): PromotionTrialCandidateLicenseReviewSet {
  const common = {
    handoff_id: manifest.handoff_id,
    reviewer_id: manifest.reviewer_id,
    label_source: "human" as const,
    review_role: "source_license" as const,
    independence_attestation: {
      completed_by_human: true as const,
      candidate_annotations_unseen: true as const,
      controller_map_unseen: true as const
    },
    review: aggregateReview
  };
  if (!promotionTrialCandidateLicenseTaskIsCandidateScoped(task)) {
    if (manifest.review_scope !== "source_only" || subjectReviews.size !== 0) {
      throw new Error("Source-only license review workspace has subject-level reviews.");
    }
    const review = parsePromotionTrialCandidateLicenseReviewSet({
      schema_version: "1.0",
      ...common
    });
    validatePromotionTrialCandidateLicenseReviewCoverage(review, task);
    return review;
  }
  const completedSubjects = manifest.subject_files.map((item) => {
    const review = subjectReviews.get(item.subject_id);
    if (!review) throw new Error(`Completed subject-license review missing: ${item.subject_id}.`);
    return review;
  });
  const aggregateStatus = aggregatePromotionTrialCandidateLicenseStatuses(
    completedSubjects.map((item) => item.status)
  );
  if (aggregateReview.status !== aggregateStatus) {
    throw new Error("Aggregate license status is not the conservative subject-level aggregate.");
  }
  const review = parsePromotionTrialCandidateLicenseReviewSet({
    schema_version: "1.1",
    ...common,
    subject_reviews: completedSubjects
  });
  validatePromotionTrialCandidateLicenseReviewCoverage(review, task);
  return review;
}

function parseLicenseWorkspaceManifest(
  value: unknown
): PromotionTrialCandidateLicenseReviewWorkspaceManifest {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "handoff_id", "reviewer_id", "status", "review_scope",
        "subject_count", "packet_root", "packet_manifest_sha256",
        "source_template_sha256", "attestation_path", "aggregate_review_path",
        "subject_files", "finalized_license_review_emitted", "confirmatory_admitted",
        "evidence_boundary"
      ])
      || value.schema_version !== "1.0"
      || !validId(value.handoff_id)
      || !validId(value.reviewer_id)
      || value.status !== "human_license_review_in_progress"
      || (value.review_scope !== "source_only" && value.review_scope !== "candidate_scoped")
      || !nonNegativeInteger(value.subject_count)
      || (value.review_scope === "source_only" && value.subject_count !== 0)
      || (value.review_scope === "candidate_scoped" && value.subject_count === 0)
      || value.packet_root !== PACKET_DIR
      || !validSha256(value.packet_manifest_sha256)
      || !validSha256(value.source_template_sha256)
      || value.attestation_path
        !== PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_ATTESTATION
      || value.aggregate_review_path !== LICENSE_AGGREGATE_REVIEW
      || !Array.isArray(value.subject_files)
      || value.subject_files.length !== value.subject_count
      || value.finalized_license_review_emitted !== false
      || value.confirmatory_admitted !== false
      || typeof value.evidence_boundary !== "string"
      || value.evidence_boundary.trim().length === 0) {
    throw new Error("Trial-candidate license review workspace manifest is invalid.");
  }
  const subjectFiles = value.subject_files.map((item) => {
    if (!isRecord(item)
        || !hasExactKeys(item, ["subject_id", "path"])
        || !validId(item.subject_id)
        || item.path !== `${LICENSE_SUBJECTS_DIR}/${item.subject_id}.json`) {
      throw new Error("License review workspace subject inventory is invalid.");
    }
    return { subject_id: item.subject_id, path: item.path };
  });
  if (new Set(subjectFiles.map((item) => item.subject_id)).size !== subjectFiles.length) {
    throw new Error("License review workspace subject inventory contains duplicates.");
  }
  return {
    schema_version: "1.0",
    handoff_id: value.handoff_id,
    reviewer_id: value.reviewer_id,
    status: "human_license_review_in_progress",
    review_scope: value.review_scope,
    subject_count: value.subject_count,
    packet_root: PACKET_DIR,
    packet_manifest_sha256: value.packet_manifest_sha256,
    source_template_sha256: value.source_template_sha256,
    attestation_path: PROMOTION_TRIAL_CANDIDATE_LICENSE_REVIEW_WORKSPACE_ATTESTATION,
    aggregate_review_path: LICENSE_AGGREGATE_REVIEW,
    subject_files: subjectFiles,
    finalized_license_review_emitted: false,
    confirmatory_admitted: false,
    evidence_boundary: value.evidence_boundary
  };
}

function parseLicenseWorkspaceAttestation(
  value: unknown
): PromotionTrialCandidateLicenseReviewWorkspaceAttestation {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "completed_by_human", "candidate_annotations_unseen", "controller_map_unseen"
      ])
      || typeof value.completed_by_human !== "boolean"
      || typeof value.candidate_annotations_unseen !== "boolean"
      || typeof value.controller_map_unseen !== "boolean") {
    throw new Error("Trial-candidate license review workspace attestation is invalid.");
  }
  return {
    completed_by_human: value.completed_by_human,
    candidate_annotations_unseen: value.candidate_annotations_unseen,
    controller_map_unseen: value.controller_map_unseen
  };
}

function isLicenseStatus(value: unknown): value is PromotionTrialCandidateLicenseStatus {
  return value === "redistribution_permitted"
    || value === "local_evaluation_only"
    || value === "redistribution_prohibited"
    || value === "uncertain";
}

function parseWorkspaceManifest(value: unknown): PromotionTrialCandidateReviewWorkspaceManifest {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "handoff_id", "annotator_id", "status", "task_count",
        "packet_root", "packet_manifest_sha256", "source_template_sha256",
        "attestation_path", "candidate_files", "finalized_annotation_emitted",
        "confirmatory_admitted", "evidence_boundary"
      ])
      || value.schema_version !== "1.0"
      || !validId(value.handoff_id)
      || !validId(value.annotator_id)
      || value.status !== "human_review_in_progress"
      || !positiveInteger(value.task_count)
      || value.packet_root !== PACKET_DIR
      || !validSha256(value.packet_manifest_sha256)
      || !validSha256(value.source_template_sha256)
      || value.attestation_path !== PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_ATTESTATION
      || !Array.isArray(value.candidate_files)
      || value.candidate_files.length !== value.task_count
      || value.finalized_annotation_emitted !== false
      || value.confirmatory_admitted !== false
      || typeof value.evidence_boundary !== "string") {
    throw new Error("Trial-candidate review workspace manifest is invalid.");
  }
  const candidateFiles = value.candidate_files.map((item) => {
    if (!isRecord(item)
        || !hasExactKeys(item, ["candidate_id", "path"])
        || !validId(item.candidate_id)
        || item.path !== `${ANNOTATIONS_DIR}/${item.candidate_id}.json`) {
      throw new Error("Trial-candidate review workspace candidate inventory is invalid.");
    }
    return { candidate_id: item.candidate_id, path: item.path };
  });
  if (new Set(candidateFiles.map((item) => item.candidate_id)).size !== candidateFiles.length) {
    throw new Error("Trial-candidate review workspace candidate inventory contains duplicates.");
  }
  return {
    schema_version: "1.0",
    handoff_id: value.handoff_id,
    annotator_id: value.annotator_id,
    status: "human_review_in_progress",
    task_count: value.task_count,
    packet_root: PACKET_DIR,
    packet_manifest_sha256: value.packet_manifest_sha256,
    source_template_sha256: value.source_template_sha256,
    attestation_path: PROMOTION_TRIAL_CANDIDATE_REVIEW_WORKSPACE_ATTESTATION,
    candidate_files: candidateFiles,
    finalized_annotation_emitted: false,
    confirmatory_admitted: false,
    evidence_boundary: value.evidence_boundary
  };
}

function parseWorkspaceAttestation(value: unknown): PromotionTrialCandidateReviewWorkspaceAttestation {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "completed_by_human", "peer_annotations_unseen", "controller_map_unseen"
      ])
      || typeof value.completed_by_human !== "boolean"
      || typeof value.peer_annotations_unseen !== "boolean"
      || typeof value.controller_map_unseen !== "boolean") {
    throw new Error("Trial-candidate review workspace attestation is invalid.");
  }
  return {
    completed_by_human: value.completed_by_human,
    peer_annotations_unseen: value.peer_annotations_unseen,
    controller_map_unseen: value.controller_map_unseen
  };
}

async function requireValidReviewerPacket(
  packetRoot: string
): Promise<PromotionTrialCandidateReviewerPacketManifest> {
  const inspection = await inspectPromotionTrialCandidateReviewerPacket(packetRoot);
  if (!inspection.passed || !inspection.manifest) {
    throw new Error(`Review workspace requires an integrity-valid reviewer packet: ${
      inspection.issues.map((issue) => issue.code).join(", ") || "unreadable"
    }.`);
  }
  return inspection.manifest;
}

async function readReviewerTaskIds(packetRoot: string): Promise<string[]> {
  const taskPath = path.join(
    packetRoot,
    PROMOTION_TRIAL_CANDIDATE_TASKS.replace(/^reviewer\//u, "")
  );
  const rows = (await readContainedRegularFile(packetRoot, taskPath))
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
  const ids = rows.map((row) => {
    if (!isRecord(row) || !validId(row.candidate_id)) {
      throw new Error("Reviewer packet contains an invalid candidate task.");
    }
    return row.candidate_id;
  });
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("Reviewer packet candidate tasks must be non-empty and unique.");
  }
  return ids;
}

async function copyBoundReviewerPacket(
  sourceRoot: string,
  targetRoot: string,
  manifest: PromotionTrialCandidateReviewerPacketManifest
): Promise<void> {
  for (const item of [
    { path: PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST, sha256: null },
    ...manifest.files
  ]) {
    const bytes = await readContainedRegularFile(sourceRoot, path.join(sourceRoot, item.path));
    if (item.sha256 !== null && sha256(bytes) !== item.sha256) {
      throw new Error("Reviewer packet changed while preparing the review workspace.");
    }
    const target = path.join(targetRoot, item.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
}

async function requireValidLicensePacket(
  packetRoot: string
): Promise<PromotionTrialCandidateLicensePacketManifest> {
  const inspection = await inspectPromotionTrialCandidateLicensePacket(packetRoot);
  if (!inspection.passed || !inspection.manifest) {
    throw new Error(`License review workspace requires an integrity-valid packet: ${
      inspection.issues.map((issue) => issue.code).join(", ") || "unreadable"
    }.`);
  }
  return inspection.manifest;
}

async function readLicenseTask(packetRoot: string): Promise<PromotionTrialCandidateLicenseTask> {
  const taskPath = path.join(
    packetRoot,
    licensePacketPath(PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK)
  );
  const bytes = await readContainedRegularFile(packetRoot, taskPath);
  assertPromotionArtifactPrivacySafe(
    licensePacketPath(PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK),
    bytes
  );
  return parsePromotionTrialCandidateLicenseTask(
    JSON.parse(bytes.toString("utf8")) as unknown
  );
}

async function copyBoundLicensePacket(
  sourceRoot: string,
  targetRoot: string,
  manifest: PromotionTrialCandidateLicensePacketManifest
): Promise<void> {
  for (const item of [
    { path: PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST, sha256: null },
    ...manifest.files
  ]) {
    const bytes = await readContainedRegularFile(sourceRoot, path.join(sourceRoot, item.path));
    if (item.sha256 !== null && sha256(bytes) !== item.sha256) {
      throw new Error("License-reviewer packet changed while preparing the workspace.");
    }
    const target = path.join(targetRoot, item.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
}

function licensePacketPath(value: string): string {
  return value.replace(/^license\//u, "");
}

async function inventoryRegularFiles(root: string, directory: string): Promise<string[]> {
  const canonicalDirectory = await resolveDirectoryInside(
    root,
    directory,
    "Trial-candidate review workspace annotations"
  );
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Review workspace may not contain symlinks.");
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(portableRef(root, target));
      else throw new Error("Review workspace contains an unsupported file type.");
    }
  };
  await walk(canonicalDirectory);
  return files.sort();
}

function blankAttestation(): PromotionTrialCandidateReviewWorkspaceAttestation {
  return {
    completed_by_human: false,
    peer_annotations_unseen: false,
    controller_map_unseen: false
  };
}

function blankLicenseAttestation(): PromotionTrialCandidateLicenseReviewWorkspaceAttestation {
  return {
    completed_by_human: false,
    candidate_annotations_unseen: false,
    controller_map_unseen: false
  };
}

function workspaceGuide(): string {
  return [
    "# Trial Candidate Review Workspace",
    "",
    "Review each opaque candidate using only the copied `packet/` artifacts and rubric.",
    "Edit the matching file under `annotations/`; every observation must be `positive`, `negative`, or `uncertain`, and every completed candidate needs a non-empty rationale.",
    "Positive observations require the evidence citations described by the packet rubric.",
    "Set all three values in `attestation.json` to `true` only after a human has completed the full review under those conditions.",
    "Run the workspace audit during review. Finalization only assembles the existing annotation schema and does not replace its packet-bound preflight.",
    ""
  ].join("\n");
}

function licenseWorkspaceGuide(
  reviewScope: PromotionTrialCandidateLicenseReviewWorkspaceManifest["review_scope"]
): string {
  return [
    "# Trial Candidate Source-License Review Workspace",
    "",
    "Use only the copied packet/ artifacts and public evidence permitted by its reviewer guide.",
    reviewScope === "candidate_scoped"
      ? "Edit every file under subject-reviews/, then set aggregate-review.json to the conservative status across all subjects."
      : "Complete aggregate-review.json; this source-only task has no subject-review files.",
    "Every completed review needs one allowed status and a non-empty rationale. redistribution_permitted also requires at least one HTTPS evidence reference.",
    "Set all three values in license-attestation.json to true only after a human has personally completed the full review under those conditions.",
    "Run the workspace audit during review. Finalization only assembles the existing license-review schema and does not replace its packet-bound preflight.",
    "",
    "No workspace command supplies a license decision, asserts legal authority, or grants redistribution permission.",
    ""
  ].join("\n");
}

function renderAuditSummary(report: PromotionTrialCandidateReviewWorkspaceAuditReport): string {
  return [
    "# Trial Candidate Review Workspace Audit",
    "",
    `- Workspace valid: ${report.workspace_valid}`,
    `- Ready to finalize: ${report.ready_to_finalize}`,
    `- Completed annotations: ${report.completed_annotation_count}/${report.task_count}`,
    `- Incomplete annotations: ${report.incomplete_annotation_count}`,
    `- Malformed annotations: ${report.malformed_annotation_count}`,
    `- Attestation complete: ${report.attestation_complete}`,
    `- Packet integrity valid: ${report.packet_integrity_valid}`,
    `- Validation issues: ${report.validation_issues.length}`,
    "",
    `Evidence boundary: ${report.evidence_boundary}`,
    ""
  ].join("\n");
}
function renderLicenseAuditSummary(
  report: PromotionTrialCandidateLicenseReviewWorkspaceAuditReport
): string {
  return [
    "# Trial Candidate Source-License Review Workspace Audit",
    "",
    `- Workspace valid: ${report.workspace_valid}`,
    `- Ready to finalize: ${report.ready_to_finalize}`,
    `- Completed subject reviews: ${report.completed_subject_review_count}/${report.subject_count}`,
    `- Incomplete subject reviews: ${report.incomplete_subject_review_count}`,
    `- Malformed subject reviews: ${report.malformed_subject_review_count}`,
    `- Aggregate review complete: ${report.aggregate_review_complete}`,
    `- Attestation complete: ${report.attestation_complete}`,
    `- Packet integrity valid: ${report.packet_integrity_valid}`,
    `- Validation issues: ${report.validation_issues.length}`,
    "",
    `Evidence boundary: ${report.evidence_boundary}`,
    ""
  ].join("\n");
}

async function prepareFreshDirectoryParent(root: string, target: string, label: string): Promise<void> {
  if (await pathExists(target)) throw new Error(`${label} already exists.`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const canonicalRoot = await fs.realpath(root);
  const canonicalParent = await fs.realpath(path.dirname(target));
  if (!isSameOrContainedPath(canonicalRoot, canonicalParent)) {
    throw new Error(`${label} must stay inside the workspace root.`);
  }
}

async function prepareFreshFileParent(root: string, target: string, label: string): Promise<void> {
  if (await pathExists(target)) throw new Error(`${label} already exists.`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const canonicalRoot = await fs.realpath(root);
  const canonicalParent = await fs.realpath(path.dirname(target));
  if (!isSameOrContainedPath(canonicalRoot, canonicalParent)) {
    throw new Error(`${label} must stay inside the workspace root.`);
  }
}

async function resolveDirectoryInside(root: string, target: string, label: string): Promise<string> {
  const canonicalRoot = await fs.realpath(root);
  const canonicalTarget = await fs.realpath(target);
  if (!isSameOrContainedPath(canonicalRoot, canonicalTarget)
      || !(await fs.stat(canonicalTarget)).isDirectory()
      || (await fs.lstat(target)).isSymbolicLink()) {
    throw new Error(`${label} must be a directory inside the workspace root.`);
  }
  return canonicalTarget;
}

async function resolveFileInside(root: string, target: string, label: string): Promise<string> {
  const canonicalRoot = await fs.realpath(root);
  const canonicalTarget = await fs.realpath(target);
  if (!isSameOrContainedPath(canonicalRoot, canonicalTarget)
      || !(await fs.stat(canonicalTarget)).isFile()
      || (await fs.lstat(target)).isSymbolicLink()) {
    throw new Error(`${label} must be a regular file inside its package.`);
  }
  return canonicalTarget;
}

async function readContainedRegularFile(root: string, target: string): Promise<Buffer> {
  const canonicalRoot = await fs.realpath(root);
  if ((await fs.lstat(target)).isSymbolicLink()) {
    throw new Error("Review workspace files may not be symlinks.");
  }
  const canonicalTarget = await fs.realpath(target);
  if (!isSameOrContainedPath(canonicalRoot, canonicalTarget)
      || !(await fs.stat(canonicalTarget)).isFile()) {
    throw new Error("Review workspace file escaped its declared root.");
  }
  return fs.readFile(canonicalTarget);
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be strictly inside the workspace root.`);
  }
}

function isSameOrContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portableRef(root: string, target: string): string {
  return path.relative(path.resolve(root), path.resolve(target)).split(path.sep).join("/");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(target: string): Promise<string> {
  return sha256(await fs.readFile(target));
}

async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true).catch(() => false);
}

function sameOrderedValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
