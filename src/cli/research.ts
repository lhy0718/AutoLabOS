import type { PaperReadinessAuditInput } from "../core/audit/paperReadinessAudit.js";
import {
  inspectPaperReadinessBundle,
  runResearchAudit,
  runResearchImprove,
  runResearchNew,
  runResearchPack,
  runResearchReview,
  type ResearchOperationResult
} from "../core/researchGovernanceOperations.js";
import { verifyResearchMilestone } from "../core/researchMilestoneAudit.js";
import { runResearchValidation } from "../core/researchValidationRun.js";

export async function runResearchNewCli(input: {
  cwd: string;
  briefPath: string;
  outDir?: string;
}): Promise<void> {
  printResult(await runResearchNew(input));
}

export async function runResearchAuditCli(input: PaperReadinessAuditInput): Promise<void> {
  printResult(await runResearchAudit(input));
}

export async function runResearchReviewCli(input: {
  cwd: string;
  gatePath: string;
  modelReviewBundlePath?: string;
  outDir?: string;
}): Promise<void> {
  printResult(await runResearchReview(input));
}

export async function runResearchImproveCli(input: {
  cwd: string;
  reviewPath: string;
  outDir?: string;
}): Promise<void> {
  printResult(await runResearchImprove(input));
}

export async function runResearchPackCli(input: {
  cwd: string;
  gatePath: string;
  reviewPath: string;
  sourceDir?: string;
  outDir?: string;
}): Promise<void> {
  printResult(await runResearchPack(input));
}

export async function runResearchPackVerificationCli(input: {
  cwd: string;
  bundleRoot: string;
}): Promise<void> {
  const report = await inspectPaperReadinessBundle(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== "pass") process.exitCode = 1;
}

export async function runResearchMilestoneVerificationCli(input: {
  cwd: string;
  contractPath: string;
  outDir: string;
}): Promise<void> {
  const result = await verifyResearchMilestone(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.report.achieved) process.exitCode = 1;
}

export async function runResearchValidationCli(input: {
  cwd: string;
  profilePath: string;
  outDir: string;
}): Promise<void> {
  const result = await runResearchValidation(input, {
    onStep: (step) => {
      process.stdout.write(
        `[research-validation] ${step.id}: ${step.passed ? "pass" : "fail"} `
        + `(exit=${step.exit_code}, timeout=${step.timed_out}, ${step.duration_ms} ms)\n`
      );
    }
  });
  process.stdout.write(`${JSON.stringify({
    status: result.report.status,
    passed: result.report.passed,
    steps: result.report.summary,
    stable_head: result.report.repository.stable_head,
    clean_before_and_after: result.report.repository.clean_before_and_after,
    report_path: result.report_path,
    summary_path: result.summary_path
  }, null, 2)}\n`);
  if (!result.report.passed) process.exitCode = 1;
}

function printResult<T>(result: ResearchOperationResult<T>): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
