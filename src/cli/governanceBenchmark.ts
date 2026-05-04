import { importGovernanceSeedBundle } from "../core/benchmark/governanceSeedBundle.js";
import {
  runGovernanceBenchmarkDryRun,
  type GovernanceBenchmarkDryRunInput
} from "../core/benchmark/governanceDryRun.js";
import {
  runGovernanceBenchmarkBatch,
  type GovernanceBenchmarkBatchInput
} from "../core/benchmark/governanceRunner.js";
import {
  exportGovernanceDemoBundles,
  type GovernanceDemoBundleExportInput
} from "../core/benchmark/governanceBundleExporter.js";

export interface RunGovernanceBenchmarkSeedCliInput {
  cwd: string;
  sourcePath: string;
  taskId?: string;
  outDir?: string;
  referenceOnly?: boolean;
}

export async function runGovernanceBenchmarkSeedCli(
  input: RunGovernanceBenchmarkSeedCliInput
): Promise<void> {
  const result = await importGovernanceSeedBundle({
    cwd: input.cwd,
    sourcePath: input.sourcePath,
    taskId: input.taskId,
    outDir: input.outDir,
    referenceOnly: input.referenceOnly
  });
  process.stdout.write(
    [
      `Governance seed ${result.manifest.mode === "reference" ? "referenced" : "imported"}: ${result.manifest.task_id}`,
      `Manifest: ${result.manifestPath}`,
      `Files: ${result.manifest.files.length}`,
      `Source SHA-256: ${result.manifest.source_sha256}`
    ].join("\n") + "\n"
  );
}

export async function runGovernanceBenchmarkDryRunCli(
  input: GovernanceBenchmarkDryRunInput
): Promise<void> {
  const report = await runGovernanceBenchmarkDryRun(input);
  process.stdout.write(
    [
      `Governance dry-run ${report.passed ? "passed" : "failed"}: ${report.task_id}`,
      `Output: ${report.output_dir}`,
      `Summary: ${report.summary_path}`,
      `README: ${report.readme_path}`,
      ...report.conditions.map((condition) =>
        `${condition.condition}: run=${condition.run_id}, contract=${condition.contract.passed ? "passed" : "failed"}, missing_baseline=${condition.missing_baseline_detected}`
      )
    ].join("\n") + "\n"
  );
}

export async function runGovernanceBenchmarkBatchCli(
  input: GovernanceBenchmarkBatchInput
): Promise<void> {
  const report = await runGovernanceBenchmarkBatch(input);
  process.stdout.write(
    [
      `Governance batch ${report.passed ? "passed" : "failed"}: ${report.total_tasks} task(s)`,
      `Output: ${report.output_dir}`,
      `Summary: ${report.summary_path}`,
      `README: ${report.readme_path}`,
      `Coverage: discovered=${report.coverage.discovered_task_ids.length}, missing=${report.coverage.missing_task_ids.length}`,
      `Tasks: replayed=${report.replayed_tasks}, queued=${report.queued_tasks}, failed=${report.failed_tasks}`,
      ...report.tasks.map((task) =>
        `${task.task_id}: ${task.status}, conditions=${task.conditions.join("/")}, replay_supported=${task.replay_supported}`
      )
    ].join("\n") + "\n"
  );
}

export async function runGovernanceBenchmarkExportBundlesCli(
  input: GovernanceDemoBundleExportInput
): Promise<void> {
  const manifest = await exportGovernanceDemoBundles(input);
  process.stdout.write(
    [
      `Governance demo bundle export completed: ${manifest.selected_count} bundle(s)`,
      `Output: ${manifest.output_dir}`,
      `Manifest: ${manifest.output_dir}/bundle_manifest.json`,
      `README: ${manifest.output_dir}/README.md`,
      `Readiness: workflow_completed=${manifest.readiness_summary.workflow_completed_count}, write_paper_completed=${manifest.readiness_summary.write_paper_completed_count}, pdf_built=${manifest.readiness_summary.pdf_built_count}, paper_ready=${manifest.readiness_summary.paper_ready_count}`,
      ...manifest.entries.map((entry) =>
        `${entry.run_id}: paper_ready=${entry.readiness.paper_ready}, pdf_built=${entry.readiness.pdf_built}, write_paper_completed=${entry.readiness.write_paper_completed}`
      )
    ].join("\n") + "\n"
  );
}
