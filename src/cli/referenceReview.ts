import path from "node:path";

import {
  importReferenceClaimReview,
  inspectPrivateReferenceClaimReviewPackage,
  packagePrivateReferenceClaimReviewDistribution,
  prepareReferenceClaimReview,
  prepareReferenceClaimReviewPrivateDistribution,
  preflightReferenceClaimReview,
  type ImportReferenceClaimReviewInput,
  type PrepareReferenceClaimReviewInput,
  type PackagePrivateReferenceClaimReviewInput,
  type PrepareReferenceClaimReviewPrivateDistributionInput,
  type PreflightReferenceClaimReviewInput
} from "../core/referenceClaimReview.js";
import {
  auditReferenceClaimReviewWorkspace,
  finalizeReferenceClaimReviewWorkspace,
  prepareReferenceClaimReviewWorkspace,
  type AuditReferenceClaimReviewWorkspaceInput,
  type FinalizeReferenceClaimReviewWorkspaceInput,
  type PrepareReferenceClaimReviewWorkspaceInput
} from "../core/referenceClaimReviewWorkspace.js";


export async function runReferenceClaimReviewPreparationCli(
  input: PrepareReferenceClaimReviewInput
): Promise<void> {
  const result = await prepareReferenceClaimReview(input);
  process.stdout.write([
    `Reference claim review handoff prepared: ${result.handoff_id}`,
    `Review tasks: ${result.task_count}`,
    `Missing full-text claims: ${result.missing_full_text_claim_count}`,
    `Manifest: ${result.manifest_path}`,
    `Incomplete human template: ${result.template_path}`,
    "Claim statuses modified: false"
  ].join("\n") + "\n");
}

export async function runReferenceClaimReviewPreflightCli(
  input: PreflightReferenceClaimReviewInput
): Promise<void> {
  const result = await preflightReferenceClaimReview(input);
  process.stdout.write([
    `Reference claim review preflight ${result.report.preflight_passed ? "passed" : "failed"}`,
    `Reviewer: ${result.report.reviewer_id || "unresolved"}`,
    `Coverage: ${result.report.reviewed_task_count}/${result.report.task_count}`,
    `Claim gate passed: ${result.report.claim_gate_passed}`,
    `Report: ${result.report_path}`,
    `Incomplete final approval template: ${result.approval_template_path}`,
    "Claim statuses modified: false"
  ].join("\n") + "\n");
  if (!result.report.preflight_passed) process.exitCode = 1;
}

export async function runReferenceClaimReviewImportCli(
  input: ImportReferenceClaimReviewInput
): Promise<void> {
  const result = await importReferenceClaimReview(input);
  process.stdout.write([
    `Reference claim review import prepared: ${result.receipt.import_id}`,
    `Checked claims in output: ${result.receipt.checked_claim_count}`,
    `Remaining unchecked claims: ${result.receipt.remaining_unchecked_claim_count}`,
    `Submission claim gate passed: ${result.receipt.submission_claim_gate_passed}`,
    `Import receipt: ${result.receipt_path}`,
    `Import-candidate claims: ${result.claims_path}`,
    "Source claims modified: false",
    "Refgate submission audit still required: true"
  ].join("\n") + "\n");
}

export async function runReferenceClaimReviewPrivateDistributionCli(
  input: PrepareReferenceClaimReviewPrivateDistributionInput
): Promise<void> {
  const result = await prepareReferenceClaimReviewPrivateDistribution(input);
  process.stdout.write([
    "Private reference claim review distribution prepared: " + result.distribution_id,
    "Handoff: " + result.handoff_id,
    "Hash-bound full-text sources: " + result.source_count,
    "Manifest: " + result.manifest_path,
    "Incomplete human template: " + result.review_template_path,
    "Public distribution allowed: false",
    "Claim statuses modified: false"
  ].join("\n") + "\n");
}

export async function runReferenceClaimReviewPrivatePackageCli(
  input: PackagePrivateReferenceClaimReviewInput
): Promise<void> {
  const result = await packagePrivateReferenceClaimReviewDistribution(input);
  process.stdout.write([
    "Private reference claim review package prepared: " + result.package_id,
    "Distribution: " + result.distribution_id,
    "Handoff: " + result.handoff_id,
    "Hash-bound files: " + result.file_count,
    "Manifest: " + result.manifest_path,
    "Reviewer archive: " + result.archive_path,
    "Fresh extraction verified: true",
    "Public distribution allowed: false",
    "Human review completed: false",
    "Claim gate passed: false"
  ].join("\n") + "\n");
}

export async function runReferenceClaimReviewPrivatePackageVerificationCli(
  input: { cwd: string; packageRoot: string }
): Promise<void> {
  const inspection = await inspectPrivateReferenceClaimReviewPackage(
    path.resolve(input.cwd, input.packageRoot)
  );
  process.stdout.write([
    "Private reference claim review package verification: " + (inspection.passed ? "passed" : "failed"),
    "Package: " + input.packageRoot,
    "Package id: " + (inspection.manifest?.package_id || "unresolved"),
    "Issues: " + inspection.issues.length,
    "Human review completed: false",
    "Claim gate passed: false"
  ].join("\n") + "\n");
  if (!inspection.passed) process.exitCode = 1;
}

export async function runReferenceClaimReviewWorkspacePreparationCli(
  input: PrepareReferenceClaimReviewWorkspaceInput
): Promise<void> {
  const result = await prepareReferenceClaimReviewWorkspace(input);
  process.stdout.write([
    "Private reference claim review workspace prepared: " + result.workspace_id,
    "Package: " + result.package_id,
    "Handoff: " + result.handoff_id,
    "Review tasks: " + result.task_count,
    "Workspace manifest: " + result.manifest_path,
    "Packet root: " + result.packet_root,
    "Public distribution allowed: false",
    "Human review completed: false",
    "Final approval completed: false",
    "Claim statuses modified: false"
  ].join("\n") + "\n");
}

export async function runReferenceClaimReviewWorkspaceAuditCli(
  input: AuditReferenceClaimReviewWorkspaceInput
): Promise<void> {
  const result = await auditReferenceClaimReviewWorkspace(input);
  process.stdout.write([
    "Reference claim review workspace audit: "
      + (result.report.workspace_valid ? "valid" : "invalid"),
    "Ready to finalize: " + result.report.ready_to_finalize,
    "Coverage: " + result.report.completed_review_count + "/" + result.report.task_count,
    "Malformed reviews: " + result.report.malformed_review_count,
    "All supported: " + result.report.all_supported_review_set,
    "Attestation complete: " + result.report.attestation_complete,
    "Report: " + result.report_path,
    "Final approval completed: false",
    "Claim statuses modified: false"
  ].join("\n") + "\n");
  if (!result.report.workspace_valid) process.exitCode = 1;
}

export async function runReferenceClaimReviewWorkspaceFinalizationCli(
  input: FinalizeReferenceClaimReviewWorkspaceInput
): Promise<void> {
  const result = await finalizeReferenceClaimReviewWorkspace(input);
  process.stdout.write([
    "Reference claim review return finalized: " + result.output_path,
    "Workspace: " + result.workspace_id,
    "Handoff: " + result.handoff_id,
    "Reviewer: " + result.reviewer_id,
    "Review tasks: " + result.task_count,
    "Packet root: " + result.packet_root,
    "Packet-bound preflight required: true",
    "Separate final human approval required: true",
    "Claim statuses modified: false"
  ].join("\n") + "\n");
}
