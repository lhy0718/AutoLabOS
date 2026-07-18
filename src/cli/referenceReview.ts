import {
  prepareReferenceClaimReview,
  preflightReferenceClaimReview,
  type PrepareReferenceClaimReviewInput,
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
    "Claim statuses modified: false"
  ].join("\n") + "\n");
  if (!result.report.preflight_passed) process.exitCode = 1;
}
