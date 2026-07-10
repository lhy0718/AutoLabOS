import type { PaperReadinessAuditInput } from "../core/audit/paperReadinessAudit.js";
import {
  runResearchAudit,
  runResearchImprove,
  runResearchNew,
  runResearchPack,
  runResearchReview,
  type ResearchOperationResult
} from "../core/researchGovernanceOperations.js";

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

function printResult<T>(result: ResearchOperationResult<T>): void {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
