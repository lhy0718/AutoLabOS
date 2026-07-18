import {
  importReferenceClaimReview,
  prepareReferenceClaimReview,
  prepareReferenceClaimReviewPrivateDistribution,
  preflightReferenceClaimReview,
  type ImportReferenceClaimReviewInput,
  type PrepareReferenceClaimReviewInput,
  type PrepareReferenceClaimReviewPrivateDistributionInput,
  type PreflightReferenceClaimReviewInput
} from "../core/referenceClaimReview.js";

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
