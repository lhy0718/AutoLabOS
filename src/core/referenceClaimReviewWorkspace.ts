import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonFile } from "../utils/fs.js";
import {
  inspectPrivateReferenceClaimReviewPackage,
  inspectReferenceClaimReviewPacket,
  inspectReferenceClaimReviewReturnFile,
  REFERENCE_CLAIM_REVIEW_DECISIONS,
  REFERENCE_CLAIM_REVIEW_MANIFEST,
  REFERENCE_CLAIM_REVIEW_PRIVATE_PACKAGE,
  REFERENCE_CLAIM_REVIEW_TASKS,
  REFERENCE_CLAIM_REVIEW_TEMPLATE,
  type ReferenceClaimReviewDecision,
  type ReferenceClaimReviewPrivatePackageManifest,
  type ReferenceClaimReviewTask
} from "./referenceClaimReview.js";

export const REFERENCE_CLAIM_REVIEW_WORKSPACE_MANIFEST =
  "reference-claim-review-workspace.json";
export const REFERENCE_CLAIM_REVIEW_WORKSPACE_ATTESTATION =
  "reviewer-attestation.json";
export const REFERENCE_CLAIM_REVIEW_WORKSPACE_AUDIT =
  "reference-claim-review-workspace-audit.json";

const SOURCE_PACKAGE_MANIFEST = "source-private-package.json";
const PACKET_DIR = "packet";
const TASK_REVIEWS_DIR = "task-reviews";
const WORKSPACE_GUIDE = "WORKSPACE_GUIDE.md";
const PROCESS_TIMEOUT_MS = 120_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;

interface EditableReferenceClaimReview {
  schema_version: "1.0";
  task_id: string;
  decision: ReferenceClaimReviewDecision | null;
  source_location: string | null;
  supporting_passage: string | null;
  proposed_claim_text: string | null;
  rationale: string | null;
}

export interface ReferenceClaimReviewWorkspaceAttestation {
  schema_version: "1.0";
  reviewer_id: string | null;
  completed_by_human: boolean;
  reviewer_did_not_generate_evidence_candidates: boolean;
  full_source_text_inspected: boolean;
}

export interface ReferenceClaimReviewWorkspaceManifest {
  schema_version: "1.0";
  workspace_id: string;
  package_id: string;
  distribution_id: string;
  handoff_id: string;
  status: "human_review_in_progress";
  task_count: number;
  packet_root: typeof PACKET_DIR;
  source_package_manifest_path: typeof SOURCE_PACKAGE_MANIFEST;
  source_package_manifest_sha256: string;
  source_archive_sha256: string;
  source_template_sha256: string;
  attestation_path: typeof REFERENCE_CLAIM_REVIEW_WORKSPACE_ATTESTATION;
  task_files: Array<{ task_id: string; path: string }>;
  public_distribution_allowed: false;
  finalized_review_emitted: false;
  final_approval_emitted: false;
  claim_statuses_modified: false;
  evidence_boundary: string;
}

export interface ReferenceClaimReviewWorkspaceIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface ReferenceClaimReviewWorkspaceAuditReport {
  schema_version: "1.0";
  generated_at: string;
  workspace_id: string | null;
  package_id: string | null;
  handoff_id: string | null;
  workspace_valid: boolean;
  ready_to_finalize: boolean;
  task_count: number;
  completed_review_count: number;
  incomplete_review_count: number;
  malformed_review_count: number;
  decision_counts: Record<ReferenceClaimReviewDecision, number>;
  all_supported_review_set: boolean;
  attestation: ReferenceClaimReviewWorkspaceAttestation | null;
  attestation_complete: boolean;
  source_package_binding_valid: boolean;
  packet_integrity_valid: boolean;
  public_distribution_allowed: false;
  final_approval_completed: false;
  claim_statuses_modified: false;
  validation_issues: ReferenceClaimReviewWorkspaceIssue[];
  evidence_boundary: string;
}

export interface PrepareReferenceClaimReviewWorkspaceInput {
  cwd: string;
  packageRoot: string;
  outDir: string;
}

export interface PrepareReferenceClaimReviewWorkspaceResult {
  workspace_id: string;
  package_id: string;
  handoff_id: string;
  task_count: number;
  output_dir: string;
  manifest_path: string;
  packet_root: string;
  public_distribution_allowed: false;
}

export interface AuditReferenceClaimReviewWorkspaceInput {
  cwd: string;
  workspaceRoot: string;
  outDir: string;
}

export interface AuditReferenceClaimReviewWorkspaceResult {
  report: ReferenceClaimReviewWorkspaceAuditReport;
  report_path: string;
  summary_path: string;
}

export interface FinalizeReferenceClaimReviewWorkspaceInput {
  cwd: string;
  workspaceRoot: string;
  outputPath: string;
}

export interface FinalizeReferenceClaimReviewWorkspaceResult {
  workspace_id: string;
  handoff_id: string;
  reviewer_id: string;
  task_count: number;
  output_path: string;
  packet_root: string;
  preflight_required: true;
  final_approval_required: true;
  claim_statuses_modified: false;
}

interface WorkspaceInspection {
  report: ReferenceClaimReviewWorkspaceAuditReport;
  manifest: ReferenceClaimReviewWorkspaceManifest | null;
  completedReviews: Map<string, CompletedReview>;
  workspaceRoot: string;
}

interface CompletedReview {
  task_id: string;
  decision: ReferenceClaimReviewDecision;
  source_location: string | null;
  supporting_passage: string | null;
  proposed_claim_text: string | null;
  rationale: string;
}

export async function prepareReferenceClaimReviewWorkspace(
  input: PrepareReferenceClaimReviewWorkspaceInput
): Promise<PrepareReferenceClaimReviewWorkspaceResult> {
  const cwd = await fs.realpath(path.resolve(input.cwd));
  const packageRoot = await resolveDirectoryInside(
    cwd,
    path.resolve(cwd, input.packageRoot),
    "Private reference review package"
  );
  const outDir = path.resolve(cwd, input.outDir);
  await assertFreshOutputPath(cwd, outDir, "Reference claim review workspace");
  const canonicalOutDir = await resolveProspectiveCanonicalPath(outDir);
  if (isSameOrContainedPath(packageRoot, canonicalOutDir)
      || isSameOrContainedPath(canonicalOutDir, packageRoot)) {
    throw new Error("Reference claim review workspace must be separate from its source package.");
  }

  const packageInspection = await inspectPrivateReferenceClaimReviewPackage(packageRoot);
  if (!packageInspection.passed || !packageInspection.manifest) {
    throw new Error(
      "Private reference review package failed inspection: "
      + packageInspection.issues.map((issue) => issue.code).join(", ")
    );
  }
  const packageManifest = packageInspection.manifest;
  const sourcePackageBytes = await readContainedRegularFile(
    packageRoot,
    path.join(packageRoot, REFERENCE_CLAIM_REVIEW_PRIVATE_PACKAGE)
  );
  const archivePath = path.join(packageRoot, packageManifest.archive_path);
  const archiveBytes = await readContainedRegularFile(packageRoot, archivePath);
  if (archiveBytes.length !== packageManifest.archive_bytes
      || sha256(archiveBytes) !== packageManifest.archive_sha256) {
    throw new Error(
      "Private reference review archive changed after package inspection."
    );
  }
  const stagingRoot = path.join(
    path.dirname(outDir),
    `.${path.basename(outDir)}.staging-${randomUUID()}`
  );
  const extractionRoot = path.join(stagingRoot, ".extraction");
  const packetRoot = path.join(stagingRoot, PACKET_DIR);

  try {
    await fs.mkdir(extractionRoot, { recursive: true });
    const archiveSnapshotPath = path.join(stagingRoot, ".source-archive.tar.gz");
    await fs.writeFile(archiveSnapshotPath, archiveBytes, {
      flag: "wx",
      mode: 0o600
    });
    await runProcess("tar", ["-xzf", archiveSnapshotPath, "-C", extractionRoot]);
    await fs.rm(archiveSnapshotPath, { force: true });
    const extractedRoot = path.join(extractionRoot, packageManifest.archive_root);
    await resolveDirectoryInside(extractionRoot, extractedRoot, "Extracted reference reviewer packet");
    await fs.rename(extractedRoot, packetRoot);
    await fs.rm(extractionRoot, { recursive: true, force: true });

    const packet = await inspectReferenceClaimReviewPacket(packetRoot);
    if (!packet.private_distribution_present
        || packet.manifest.handoff_id !== packageManifest.handoff_id
        || packet.tasks.length !== packet.manifest.task_count) {
      throw new Error("Extracted reference reviewer packet does not match the source package.");
    }
    const packetFiles = await inventoryRegularFiles(packetRoot);
    if (JSON.stringify(packetFiles) !== JSON.stringify(packageManifest.files)) {
      throw new Error("Extracted reference reviewer packet inventory changed after package inspection.");
    }

    const templateBytes = await readContainedRegularFile(
      packetRoot,
      path.join(packetRoot, REFERENCE_CLAIM_REVIEW_TEMPLATE)
    );
    const blankTemplate = parseBlankReviewTemplate(
      JSON.parse(templateBytes.toString("utf8")) as unknown,
      packet.manifest.handoff_id,
      packet.tasks
    );
    const sourcePackageManifestPath = path.join(stagingRoot, SOURCE_PACKAGE_MANIFEST);
    await fs.writeFile(sourcePackageManifestPath, sourcePackageBytes);
    await writeJsonFile(path.join(
      stagingRoot,
      REFERENCE_CLAIM_REVIEW_WORKSPACE_ATTESTATION
    ), {
      schema_version: "1.0",
      reviewer_id: null,
      completed_by_human: false,
      reviewer_did_not_generate_evidence_candidates: false,
      full_source_text_inspected: false
    } satisfies ReferenceClaimReviewWorkspaceAttestation);

    const taskFiles = blankTemplate.reviews.map((review, index) => ({
      task_id: review.task_id,
      path: taskReviewPath(review.task_id, index)
    }));
    for (const [index, review] of blankTemplate.reviews.entries()) {
      const target = path.join(stagingRoot, taskFiles[index].path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await writeJsonFile(target, review);
    }
    await fs.writeFile(path.join(stagingRoot, WORKSPACE_GUIDE), workspaceGuide(), "utf8");

    const workspaceId = `reference-claim-review-workspace-${sha256(Buffer.from([
      packageManifest.package_id,
      packageManifest.handoff_id,
      ...taskFiles.map((item) => item.task_id)
    ].join(":"), "utf8")).slice(0, 16)}`;
    const manifest: ReferenceClaimReviewWorkspaceManifest = {
      schema_version: "1.0",
      workspace_id: workspaceId,
      package_id: packageManifest.package_id,
      distribution_id: packageManifest.distribution_id,
      handoff_id: packageManifest.handoff_id,
      status: "human_review_in_progress",
      task_count: taskFiles.length,
      packet_root: PACKET_DIR,
      source_package_manifest_path: SOURCE_PACKAGE_MANIFEST,
      source_package_manifest_sha256: sha256(sourcePackageBytes),
      source_archive_sha256: packageManifest.archive_sha256,
      source_template_sha256: sha256(templateBytes),
      attestation_path: REFERENCE_CLAIM_REVIEW_WORKSPACE_ATTESTATION,
      task_files: taskFiles,
      public_distribution_allowed: false,
      finalized_review_emitted: false,
      final_approval_emitted: false,
      claim_statuses_modified: false,
      evidence_boundary: "This private workspace reproduces one integrity-valid reviewer packet and separates its blank return into resumable task files. It supplies no human decision, reviewer identity, attestation, final approval, checked claim, Refgate result, redistribution permission, or paper-readiness decision. The workspace contains third-party full text and must not be published."
    };
    await writeJsonFile(path.join(
      stagingRoot,
      REFERENCE_CLAIM_REVIEW_WORKSPACE_MANIFEST
    ), manifest);
    await fs.rename(stagingRoot, outDir);
    return {
      workspace_id: workspaceId,
      package_id: packageManifest.package_id,
      handoff_id: packageManifest.handoff_id,
      task_count: taskFiles.length,
      output_dir: portableRef(cwd, outDir),
      manifest_path: portableRef(
        cwd,
        path.join(outDir, REFERENCE_CLAIM_REVIEW_WORKSPACE_MANIFEST)
      ),
      packet_root: portableRef(cwd, path.join(outDir, PACKET_DIR)),
      public_distribution_allowed: false
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function auditReferenceClaimReviewWorkspace(
  input: AuditReferenceClaimReviewWorkspaceInput
): Promise<AuditReferenceClaimReviewWorkspaceResult> {
  const cwd = await fs.realpath(path.resolve(input.cwd));
  const inspection = await inspectReferenceClaimReviewWorkspace(
    cwd,
    input.workspaceRoot
  );
  const outDir = path.resolve(cwd, input.outDir);
  await assertFreshOutputPath(cwd, outDir, "Reference claim review workspace audit");
  const canonicalOutDir = await resolveProspectiveCanonicalPath(outDir);
  if (isSameOrContainedPath(inspection.workspaceRoot, canonicalOutDir)
      || isSameOrContainedPath(canonicalOutDir, inspection.workspaceRoot)) {
    throw new Error("Reference claim review workspace audit must be separate from the workspace.");
  }
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, REFERENCE_CLAIM_REVIEW_WORKSPACE_AUDIT);
  const summaryPath = path.join(outDir, "reference-claim-review-workspace-audit.md");
  await writeJsonFile(reportPath, inspection.report);
  await fs.writeFile(summaryPath, renderWorkspaceAudit(inspection.report), "utf8");
  return {
    report: inspection.report,
    report_path: portableRef(cwd, reportPath),
    summary_path: portableRef(cwd, summaryPath)
  };
}

export async function finalizeReferenceClaimReviewWorkspace(
  input: FinalizeReferenceClaimReviewWorkspaceInput
): Promise<FinalizeReferenceClaimReviewWorkspaceResult> {
  const cwd = await fs.realpath(path.resolve(input.cwd));
  const inspection = await inspectReferenceClaimReviewWorkspace(
    cwd,
    input.workspaceRoot
  );
  if (!inspection.report.ready_to_finalize
      || !inspection.manifest
      || !inspection.report.attestation
      || !inspection.report.attestation.reviewer_id) {
    const issueCodes = inspection.report.validation_issues.map((issue) => issue.code);
    throw new Error(
      "Reference claim review workspace is not ready to finalize"
      + (issueCodes.length > 0 ? `: ${issueCodes.join(", ")}` : ".")
    );
  }
  const manifest = inspection.manifest;
  const attestation = inspection.report.attestation;
  const reviewerId = attestation.reviewer_id;
  if (!reviewerId) {
    throw new Error("Reference claim review workspace reviewer ID is missing.");
  }
  const review = {
    schema_version: "1.0",
    handoff_id: manifest.handoff_id,
    reviewer_id: reviewerId,
    label_source: "human",
    review_role: "independent_claim_review",
    independence_attestation: {
      completed_by_human: true,
      reviewer_did_not_generate_evidence_candidates: true,
      full_source_text_inspected: true
    },
    reviews: manifest.task_files.map((item) => {
      const completed = inspection.completedReviews.get(item.task_id);
      if (!completed) {
        throw new Error(`Completed reference claim review is missing: ${item.task_id}.`);
      }
      return completed;
    })
  };
  const outputPath = path.resolve(cwd, input.outputPath);
  await assertFreshOutputPath(cwd, outputPath, "Finalized reference claim review");
  const canonicalOutputPath = await resolveProspectiveCanonicalPath(outputPath);
  if (isSameOrContainedPath(inspection.workspaceRoot, canonicalOutputPath)) {
    throw new Error("Finalized reference claim review output must be outside the workspace.");
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const stagedOutput = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.staging-${randomUUID()}`
  );
  try {
    await writeJsonFile(stagedOutput, review);
    const preflightReport = await inspectReferenceClaimReviewReturnFile(
      path.join(inspection.workspaceRoot, manifest.packet_root),
      stagedOutput
    );
    if (!preflightReport.preflight_passed) {
      throw new Error(
        "Finalized reference claim review failed the existing preflight contract: "
        + preflightReport.issues.map((issue) => issue.code).join(", ")
      );
    }
    await fs.rename(stagedOutput, outputPath);
  } catch (error) {
    await fs.rm(stagedOutput, { force: true });
    throw error;
  }
  return {
    workspace_id: manifest.workspace_id,
    handoff_id: manifest.handoff_id,
    reviewer_id: reviewerId,
    task_count: manifest.task_count,
    output_path: portableRef(cwd, outputPath),
    packet_root: portableRef(
      cwd,
      path.join(inspection.workspaceRoot, manifest.packet_root)
    ),
    preflight_required: true,
    final_approval_required: true,
    claim_statuses_modified: false
  };
}

async function inspectReferenceClaimReviewWorkspace(
  cwd: string,
  workspacePath: string
): Promise<WorkspaceInspection> {
  const workspaceRoot = await resolveDirectoryInside(
    cwd,
    path.resolve(cwd, workspacePath),
    "Reference claim review workspace"
  );
  const issues: ReferenceClaimReviewWorkspaceIssue[] = [];
  let manifest: ReferenceClaimReviewWorkspaceManifest | null = null;
  try {
    const bytes = await readContainedRegularFile(
      workspaceRoot,
      path.join(workspaceRoot, REFERENCE_CLAIM_REVIEW_WORKSPACE_MANIFEST)
    );
    manifest = parseWorkspaceManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    issues.push({
      code: "reference_claim_review_workspace_manifest_invalid",
      message: errorMessage(error)
    });
  }

  let sourcePackageBindingValid = false;
  let packetIntegrityValid = false;
  let tasks: ReferenceClaimReviewTask[] = [];
  if (manifest) {
    try {
      const sourcePackageBytes = await readContainedRegularFile(
        workspaceRoot,
        path.join(workspaceRoot, manifest.source_package_manifest_path)
      );
      if (sha256(sourcePackageBytes) !== manifest.source_package_manifest_sha256) {
        throw new Error("Copied source package manifest hash mismatch.");
      }
      const sourcePackage = parseSourcePackageManifest(
        JSON.parse(sourcePackageBytes.toString("utf8")) as unknown
      );
      if (sourcePackage.package_id !== manifest.package_id
          || sourcePackage.distribution_id !== manifest.distribution_id
          || sourcePackage.handoff_id !== manifest.handoff_id
          || sourcePackage.archive_sha256 !== manifest.source_archive_sha256
          || sourcePackage.file_count !== sourcePackage.files.length) {
        throw new Error("Copied source package manifest does not bind this workspace.");
      }
      const packetRoot = path.join(workspaceRoot, manifest.packet_root);
      const packetFiles = await inventoryRegularFiles(packetRoot);
      if (JSON.stringify(packetFiles) !== JSON.stringify(sourcePackage.files)) {
        throw new Error("Workspace packet inventory does not match the source package.");
      }
      sourcePackageBindingValid = true;

      const packet = await inspectReferenceClaimReviewPacket(packetRoot);
      if (!packet.private_distribution_present
          || packet.manifest.handoff_id !== manifest.handoff_id
          || packet.manifest.task_count !== manifest.task_count
          || packet.tasks.length !== manifest.task_count) {
        throw new Error("Workspace packet does not match its manifest.");
      }
      const templateBytes = await readContainedRegularFile(
        packetRoot,
        path.join(packetRoot, REFERENCE_CLAIM_REVIEW_TEMPLATE)
      );
      if (sha256(templateBytes) !== manifest.source_template_sha256) {
        throw new Error("Workspace source review template hash mismatch.");
      }
      parseBlankReviewTemplate(
        JSON.parse(templateBytes.toString("utf8")) as unknown,
        manifest.handoff_id,
        packet.tasks
      );
      tasks = packet.tasks;
      packetIntegrityValid = true;
    } catch (error) {
      issues.push({
        code: "reference_claim_review_workspace_source_binding_invalid",
        message: errorMessage(error)
      });
    }
  }

  let attestation: ReferenceClaimReviewWorkspaceAttestation | null = null;
  if (manifest) {
    try {
      const bytes = await readContainedRegularFile(
        workspaceRoot,
        path.join(workspaceRoot, manifest.attestation_path)
      );
      attestation = parseWorkspaceAttestation(
        JSON.parse(bytes.toString("utf8")) as unknown
      );
    } catch (error) {
      issues.push({
        code: "reference_claim_review_workspace_attestation_invalid",
        message: errorMessage(error)
      });
    }
  }
  const attestationComplete = attestation !== null
    && validId(attestation.reviewer_id)
    && attestation.completed_by_human
    && attestation.reviewer_did_not_generate_evidence_candidates
    && attestation.full_source_text_inspected;

  const completedReviews = new Map<string, CompletedReview>();
  let incompleteCount = 0;
  let malformedCount = 0;
  const counts = emptyDecisionCounts();
  if (manifest) {
    const taskIds = new Set(tasks.map((task) => task.task_id));
    for (const item of manifest.task_files) {
      if (!taskIds.has(item.task_id)) {
        malformedCount += 1;
        issues.push({
          code: "reference_claim_review_workspace_task_unknown",
          message: "Workspace task is not present in the packet.",
          ref: item.task_id
        });
        continue;
      }
      try {
        const bytes = await readContainedRegularFile(
          workspaceRoot,
          path.join(workspaceRoot, item.path)
        );
        const editable = parseEditableReview(
          JSON.parse(bytes.toString("utf8")) as unknown,
          item.task_id
        );
        const completed = completedReview(editable);
        if (completed) {
          completedReviews.set(item.task_id, completed);
          counts[completed.decision] += 1;
        } else {
          incompleteCount += 1;
        }
      } catch (error) {
        malformedCount += 1;
        issues.push({
          code: "reference_claim_review_workspace_task_invalid",
          message: errorMessage(error),
          ref: item.task_id
        });
      }
    }
  }

  const taskCount = manifest?.task_count ?? tasks.length;
  const completedCount = completedReviews.size;
  const workspaceValid = manifest !== null
    && sourcePackageBindingValid
    && packetIntegrityValid
    && attestation !== null
    && malformedCount === 0
    && issues.length === 0;
  const readyToFinalize = workspaceValid
    && completedCount === taskCount
    && incompleteCount === 0
    && attestationComplete;
  const allSupportedReviewSet = completedCount === taskCount
    && incompleteCount === 0
    && counts.supported === taskCount;
  return {
    report: {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      workspace_id: manifest?.workspace_id || null,
      package_id: manifest?.package_id || null,
      handoff_id: manifest?.handoff_id || null,
      workspace_valid: workspaceValid,
      ready_to_finalize: readyToFinalize,
      task_count: taskCount,
      completed_review_count: completedCount,
      incomplete_review_count: incompleteCount,
      malformed_review_count: malformedCount,
      decision_counts: counts,
      all_supported_review_set: allSupportedReviewSet,
      attestation,
      attestation_complete: attestationComplete,
      source_package_binding_valid: sourcePackageBindingValid,
      packet_integrity_valid: packetIntegrityValid,
      public_distribution_allowed: false,
      final_approval_completed: false,
      claim_statuses_modified: false,
      validation_issues: issues,
      evidence_boundary: "This audit verifies private-package binding, extracted-packet integrity, editable task coverage, decision structure, and attestation fields only. It does not infer that a human performed the review, verify identity or expertise, approve any claim, authorize checked status, establish redistribution permission, run Refgate, or change claim status."
    },
    manifest,
    completedReviews,
    workspaceRoot
  };
}

function parseBlankReviewTemplate(
  value: unknown,
  handoffId: string,
  tasks: ReferenceClaimReviewTask[]
): { reviews: EditableReferenceClaimReview[] } {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "handoff_id", "reviewer_id", "label_source",
        "review_role", "independence_attestation", "reviews"
      ])
      || value.schema_version !== "1.0"
      || value.handoff_id !== handoffId
      || value.reviewer_id !== null
      || value.label_source !== "human"
      || value.review_role !== "independent_claim_review"
      || !isRecord(value.independence_attestation)
      || !hasExactKeys(value.independence_attestation, [
        "completed_by_human",
        "reviewer_did_not_generate_evidence_candidates",
        "full_source_text_inspected"
      ])
      || value.independence_attestation.completed_by_human !== false
      || value.independence_attestation.reviewer_did_not_generate_evidence_candidates !== false
      || value.independence_attestation.full_source_text_inspected !== false
      || !Array.isArray(value.reviews)
      || value.reviews.length !== tasks.length) {
    throw new Error("Assigned reference claim review template is invalid.");
  }
  const reviews = value.reviews.map((item, index) => {
    const parsed = parseEditableReview({
      schema_version: "1.0",
      ...(isRecord(item) ? item : {})
    }, tasks[index]?.task_id);
    if (parsed.decision !== null
        || parsed.source_location !== null
        || parsed.supporting_passage !== null
        || parsed.proposed_claim_text !== null
        || parsed.rationale !== null) {
      throw new Error("Assigned reference claim review template must be blank.");
    }
    return parsed;
  });
  return { reviews };
}

function parseEditableReview(
  value: unknown,
  expectedTaskId: string
): EditableReferenceClaimReview {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "task_id", "decision", "source_location",
        "supporting_passage", "proposed_claim_text", "rationale"
      ])
      || value.schema_version !== "1.0"
      || value.task_id !== expectedTaskId
      || (value.decision !== null
        && !REFERENCE_CLAIM_REVIEW_DECISIONS.includes(
          value.decision as ReferenceClaimReviewDecision
        ))) {
    throw new Error("Reference claim task review has an invalid editable structure.");
  }
  const sourceLocation = editableNullableString(value.source_location, 2048);
  const supportingPassage = editableNullableString(value.supporting_passage, 8000);
  const proposedClaimText = editableNullableString(value.proposed_claim_text, 8000);
  const rationale = editableNullableString(value.rationale, 4000);
  for (const [label, field] of [
    ["source location", sourceLocation],
    ["supporting passage", supportingPassage],
    ["proposed claim", proposedClaimText],
    ["rationale", rationale]
  ] as const) {
    if (field !== null && /[\t\r\n]/u.test(field)) {
      throw new Error(`Reference claim task ${label} contains a tab or newline.`);
    }
  }
  return {
    schema_version: "1.0",
    task_id: expectedTaskId,
    decision: value.decision as ReferenceClaimReviewDecision | null,
    source_location: sourceLocation,
    supporting_passage: supportingPassage,
    proposed_claim_text: proposedClaimText,
    rationale
  };
}

function completedReview(
  review: EditableReferenceClaimReview
): CompletedReview | null {
  if (!review.decision || !nonEmpty(review.rationale)) return null;
  if ((review.decision === "supported" || review.decision === "rewrite")
      && (!nonEmpty(review.source_location) || !nonEmpty(review.supporting_passage))) {
    return null;
  }
  if (review.decision === "rewrite" && !nonEmpty(review.proposed_claim_text)) {
    return null;
  }
  if (review.decision === "supported" && nonEmpty(review.proposed_claim_text)) {
    throw new Error("Supported reference claim review contains a proposed rewrite.");
  }
  if (review.decision === "missing_source"
      && (nonEmpty(review.source_location) || nonEmpty(review.supporting_passage))) {
    throw new Error("Missing-source reference claim review contains source support.");
  }
  return {
    task_id: review.task_id,
    decision: review.decision,
    source_location: normalizedNullable(review.source_location),
    supporting_passage: normalizedNullable(review.supporting_passage),
    proposed_claim_text: normalizedNullable(review.proposed_claim_text),
    rationale: review.rationale.trim()
  };
}

function parseWorkspaceAttestation(
  value: unknown
): ReferenceClaimReviewWorkspaceAttestation {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "reviewer_id", "completed_by_human",
        "reviewer_did_not_generate_evidence_candidates",
        "full_source_text_inspected"
      ])
      || value.schema_version !== "1.0"
      || (value.reviewer_id !== null && !validId(value.reviewer_id))
      || typeof value.completed_by_human !== "boolean"
      || typeof value.reviewer_did_not_generate_evidence_candidates !== "boolean"
      || typeof value.full_source_text_inspected !== "boolean") {
    throw new Error("Reference claim review workspace attestation is invalid.");
  }
  return value as unknown as ReferenceClaimReviewWorkspaceAttestation;
}

function parseWorkspaceManifest(value: unknown): ReferenceClaimReviewWorkspaceManifest {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "workspace_id", "package_id", "distribution_id",
        "handoff_id", "status", "task_count", "packet_root",
        "source_package_manifest_path", "source_package_manifest_sha256",
        "source_archive_sha256", "source_template_sha256", "attestation_path",
        "task_files", "public_distribution_allowed", "finalized_review_emitted",
        "final_approval_emitted", "claim_statuses_modified", "evidence_boundary"
      ])
      || value.schema_version !== "1.0"
      || !validId(value.workspace_id)
      || !validId(value.package_id)
      || !validId(value.distribution_id)
      || !validId(value.handoff_id)
      || value.status !== "human_review_in_progress"
      || !positiveInteger(value.task_count)
      || value.packet_root !== PACKET_DIR
      || value.source_package_manifest_path !== SOURCE_PACKAGE_MANIFEST
      || !sha256String(value.source_package_manifest_sha256)
      || !sha256String(value.source_archive_sha256)
      || !sha256String(value.source_template_sha256)
      || value.attestation_path !== REFERENCE_CLAIM_REVIEW_WORKSPACE_ATTESTATION
      || !Array.isArray(value.task_files)
      || value.task_files.length !== value.task_count
      || value.public_distribution_allowed !== false
      || value.finalized_review_emitted !== false
      || value.final_approval_emitted !== false
      || value.claim_statuses_modified !== false
      || !nonEmpty(value.evidence_boundary)) {
    throw new Error("Reference claim review workspace manifest is invalid.");
  }
  const taskFiles = value.task_files.map((item, index) => {
    if (!isRecord(item)
        || !hasExactKeys(item, ["task_id", "path"])
        || !validId(item.task_id)
        || item.path !== taskReviewPath(item.task_id, index)) {
      throw new Error("Reference claim review workspace task inventory is invalid.");
    }
    return { task_id: item.task_id, path: item.path };
  });
  if (new Set(taskFiles.map((item) => item.task_id)).size !== taskFiles.length) {
    throw new Error("Reference claim review workspace task inventory contains duplicates.");
  }
  const expectedWorkspaceId = `reference-claim-review-workspace-${sha256(Buffer.from([
    value.package_id,
    value.handoff_id,
    ...taskFiles.map((item) => item.task_id)
  ].join(":"), "utf8")).slice(0, 16)}`;
  if (value.workspace_id !== expectedWorkspaceId) {
    throw new Error("Reference claim review workspace id mismatch.");
  }
  return {
    ...(value as unknown as ReferenceClaimReviewWorkspaceManifest),
    task_files: taskFiles
  };
}

function parseSourcePackageManifest(
  value: unknown
): ReferenceClaimReviewPrivatePackageManifest {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "package_id", "distribution_id", "handoff_id",
        "source_distribution_manifest_sha256", "status", "archive_path",
        "archive_sha256", "archive_bytes", "archive_entry_count", "archive_root",
        "file_count", "files", "single_reviewer_root",
        "regular_file_or_directory_entries_only",
        "fresh_extraction_exact_tree_match", "public_distribution_allowed",
        "license_review_status", "human_review_completed",
        "human_identity_verified", "claim_gate_passed", "self_inspection_passed",
        "evidence_boundary"
      ])
      || value.schema_version !== "1.0"
      || !validId(value.package_id)
      || !validId(value.distribution_id)
      || !validId(value.handoff_id)
      || !sha256String(value.source_distribution_manifest_sha256)
      || value.status !== "human_review_pending"
      || value.archive_path !== "archives/reference-reviewer.tar.gz"
      || !sha256String(value.archive_sha256)
      || !positiveInteger(value.archive_bytes)
      || !positiveInteger(value.archive_entry_count)
      || value.archive_root !== "reference-reviewer"
      || !positiveInteger(value.file_count)
      || !Array.isArray(value.files)
      || value.files.length !== value.file_count
      || value.single_reviewer_root !== true
      || value.regular_file_or_directory_entries_only !== true
      || value.fresh_extraction_exact_tree_match !== true
      || value.public_distribution_allowed !== false
      || value.license_review_status !== "not_assessed"
      || value.human_review_completed !== false
      || value.human_identity_verified !== false
      || value.claim_gate_passed !== false
      || value.self_inspection_passed !== true
      || !nonEmpty(value.evidence_boundary)) {
    throw new Error("Copied private reference review package manifest is invalid.");
  }
  const files = value.files.map((item) => {
    if (!isRecord(item)
        || !hasExactKeys(item, ["path", "sha256"])
        || !safeRelativePath(item.path)
        || !sha256String(item.sha256)) {
      throw new Error("Copied private reference review package file inventory is invalid.");
    }
    return { path: item.path, sha256: item.sha256 };
  });
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(files.map((item) => item.path)).size !== files.length
      || JSON.stringify(files) !== JSON.stringify(sorted)
      || !files.some((item) => item.path === REFERENCE_CLAIM_REVIEW_MANIFEST)
      || !files.some((item) => item.path === REFERENCE_CLAIM_REVIEW_TASKS)) {
    throw new Error("Copied private reference review package file inventory is invalid.");
  }
  const expectedPackageId = `reference-claim-review-package-${sha256(Buffer.from([
    value.distribution_id,
    value.source_distribution_manifest_sha256,
    value.archive_sha256
  ].join(":"), "utf8")).slice(0, 16)}`;
  if (value.package_id !== expectedPackageId) {
    throw new Error("Copied private reference review package id mismatch.");
  }
  return {
    ...(value as unknown as ReferenceClaimReviewPrivatePackageManifest),
    files
  };
}

function taskReviewPath(taskId: string, index: number): string {
  return `${TASK_REVIEWS_DIR}/${String(index + 1).padStart(4, "0")}-${sha256(
    Buffer.from(taskId, "utf8")
  ).slice(0, 12)}.json`;
}

function workspaceGuide(): string {
  return [
    "# Private Reference Claim Review Workspace",
    "",
    "This workspace contains hash-bound third-party full text for private review. Do not publish or redistribute it.",
    "",
    "1. Inspect the full source in `packet/reviewer/sources/` for every task.",
    "2. Edit only the corresponding JSON files in `task-reviews/`.",
    "3. Keep undecided fields null. A partial workspace remains valid but cannot be finalized.",
    "4. After personally completing every task, fill `reviewer-attestation.json`. Do not set an attestation on another person's behalf.",
    "5. Run `autolabos reference-review audit-workspace --workspace <workspace> --out-dir <new-audit-dir>`.",
    "6. When the audit reports `ready_to_finalize=true`, run `autolabos reference-review finalize-workspace --workspace <workspace> --output <completed-review.json>`.",
    "7. Run the existing packet-bound preflight with the returned packet root and completed review.",
    "",
    "Finalization does not approve claims, alter Refgate status, or create the separate final-human approval required for import."
  ].join("\n") + "\n";
}

function renderWorkspaceAudit(report: ReferenceClaimReviewWorkspaceAuditReport): string {
  return [
    "# Reference Claim Review Workspace Audit",
    "",
    `- Workspace valid: ${report.workspace_valid}`,
    `- Ready to finalize: ${report.ready_to_finalize}`,
    `- Coverage: ${report.completed_review_count}/${report.task_count}`,
    `- Incomplete: ${report.incomplete_review_count}`,
    `- Malformed: ${report.malformed_review_count}`,
    `- All supported: ${report.all_supported_review_set}`,
    `- Attestation complete: ${report.attestation_complete}`,
    `- Source package binding valid: ${report.source_package_binding_valid}`,
    `- Packet integrity valid: ${report.packet_integrity_valid}`,
    "- Public distribution allowed: false",
    "- Final approval completed: false",
    "- Claim statuses modified: false",
    "",
    "## Issues",
    "",
    ...(report.validation_issues.length > 0
      ? report.validation_issues.map((issue) =>
          `- ${issue.code}${issue.ref ? ` (${issue.ref})` : ""}: ${issue.message}`)
      : ["- None."]),
    "",
    report.evidence_boundary
  ].join("\n") + "\n";
}

function emptyDecisionCounts(): Record<ReferenceClaimReviewDecision, number> {
  return { supported: 0, rewrite: 0, wrong_source: 0, missing_source: 0 };
}

function editableNullableString(value: unknown, maxLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error("Reference claim task review contains an invalid text field.");
  }
  return value;
}

function normalizedNullable(value: string | null): string | null {
  return nonEmpty(value) ? value.trim() : null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !path.isAbsolute(value)
    && !value.includes("\\")
    && !value.includes("\n")
    && !value.includes("\r")
    && !value.split("/").includes("..");
}

async function resolveDirectoryInside(
  allowedRoot: string,
  target: string,
  label: string
): Promise<string> {
  const root = await fs.realpath(allowedRoot);
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory.`);
  }
  const resolved = await fs.realpath(target);
  if (!isSameOrContainedPath(root, resolved)) {
    throw new Error(`${label} must stay inside the workspace root.`);
  }
  return resolved;
}

async function assertFreshOutputPath(
  allowedRoot: string,
  target: string,
  label: string
): Promise<void> {
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error(`${label} already exists.`);
  const root = await fs.realpath(allowedRoot);
  const resolved = await resolveProspectiveCanonicalPath(target);
  if (!isSameOrContainedPath(root, resolved)) {
    throw new Error(`${label} must stay inside the workspace root.`);
  }
}

async function resolveProspectiveCanonicalPath(target: string): Promise<string> {
  const missing: string[] = [];
  let cursor = path.resolve(target);
  while (true) {
    try {
      const existing = await fs.realpath(cursor);
      return path.join(existing, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function isSameOrContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readContainedRegularFile(root: string, target: string): Promise<Buffer> {
  const rootReal = await fs.realpath(root);
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Reference claim review workspace file must be a regular file.");
  }
  const targetReal = await fs.realpath(target);
  if (!isSameOrContainedPath(rootReal, targetReal)) {
    throw new Error("Reference claim review workspace file escaped its root.");
  }
  return fs.readFile(targetReal);
}

async function inventoryRegularFiles(
  root: string
): Promise<Array<{ path: string; sha256: string }>> {
  const rootReal = await resolveDirectoryInside(root, root, "Reference review packet");
  const files: Array<{ path: string; sha256: string }> = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Reference review packet contains a symbolic link.");
      }
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("Reference review packet contains a non-regular file.");
      }
      const relative = path.relative(rootReal, absolute).replace(/\\/gu, "/");
      if (!safeRelativePath(relative)) {
        throw new Error("Reference review packet contains an unsafe path.");
      }
      files.push({ path: relative, sha256: sha256(await fs.readFile(absolute)) });
    }
  };
  await visit(rootReal);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out.`));
    }, PROCESS_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_PROCESS_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${command} failed with exit code ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`
      ));
    });
  });
}

function portableRef(cwd: string, target: string): string {
  const relative = path.relative(cwd, target).replace(/\\/gu, "/");
  return relative || ".";
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
