import path from "node:path";

import { ensureScaffold, resolveAppPaths } from "../config.js";
import {
  generateEvalHarnessReport,
  renderEvalHarnessSummary,
  writeEvalHarnessReport
} from "../core/evaluation/evalHarness.js";

export interface EvalHarnessCliOptions {
  cwd: string;
  runIds: string[];
  limit: number;
  outputPath?: string;
}

export async function runEvalHarnessCli(options: EvalHarnessCliOptions): Promise<void> {
  const paths = resolveAppPaths(options.cwd);
  await ensureScaffold(paths);

  const report = await generateEvalHarnessReport({
    cwd: options.cwd,
    runIds: options.runIds,
    limit: options.limit
  });

  const outputPath = options.outputPath
    ? path.resolve(options.cwd, options.outputPath)
    : path.join(paths.outputsDir, "eval-harness", "latest.json");
  const written = await writeEvalHarnessReport(report, outputPath);

  process.stdout.write(`${renderEvalHarnessSummary(report)}\n`);
  process.stdout.write(`Saved JSON report: ${written.jsonPath}\n`);
  process.stdout.write(`Saved Markdown summary: ${written.markdownPath}\n`);
}
