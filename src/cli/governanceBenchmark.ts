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
import {
  scorePromotionBenchmarkFromFiles,
  type ScorePromotionBenchmarkInput
} from "../core/benchmark/promotionBenchmark.js";
import {
  buildPromotionBenchmarkSuite,
  type BuildPromotionBenchmarkInput
} from "../core/benchmark/promotionBenchmarkBuilder.js";
import {
  runPromotionBenchmarkSystems,
  type RunPromotionBenchmarkSystemsInput
} from "../core/benchmark/promotionBenchmarkSystems.js";
import {
  exportPromotionBenchmarkPromptPack,
  importPromotionBenchmarkResponses,
  type ExportPromotionPromptPackInput,
  type ImportPromotionResponsesInput
} from "../core/benchmark/promotionBenchmarkPromptPack.js";
import {
  generateSyntheticPromotionCorpus,
  type GenerateSyntheticPromotionCorpusInput
} from "../core/benchmark/promotionBenchmarkSyntheticCorpus.js";
import {
  auditPromotionConfirmatoryIntake,
  freezePromotionConfirmatoryCorpus,
  type AuditPromotionConfirmatoryIntakeInput,
  type FreezePromotionConfirmatoryInput
} from "../core/benchmark/promotionBenchmarkConfirmatoryIntake.js";
import {
  analyzePromotionBenchmarkFailures,
  type AnalyzePromotionBenchmarkFailuresInput
} from "../core/benchmark/promotionBenchmarkMetaHarness.js";
import {
  adjudicatePromotionBenchmark,
  exportPromotionAnnotationPack,
  type AdjudicatePromotionBenchmarkInput,
  type ExportPromotionAnnotationPackInput
} from "../core/benchmark/promotionBenchmarkAdjudication.js";
import {
  exportPromotionMutationAuditPack,
  verifyPromotionMutationAudit,
  type ExportPromotionMutationAuditPackInput,
  type VerifyPromotionMutationAuditInput
} from "../core/benchmark/promotionBenchmarkMutationAudit.js";

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

export async function runPromotionBenchmarkScoreCli(
  input: ScorePromotionBenchmarkInput
): Promise<void> {
  const result = await scorePromotionBenchmarkFromFiles(input);
  process.stdout.write(
    [
      `Promotion benchmark score ${result.report.passed ? "passed" : "failed"}: ${result.report.suite_id}`,
      `Cases: ${result.report.case_count}`,
      `Predictions: ${result.report.prediction_count}`,
      `Systems: ${result.report.systems.length}`,
      `Output: ${result.output_path}`,
      `Report: ${result.report_path}`,
      ...result.report.systems.map((system) =>
        `${system.system_id}: coverage=${system.covered_case_count}/${system.expected_case_count}, false_promotion=${system.false_paper_ready_rate ?? "n/a"}, concern_acceptance_conflict=${system.concern_acceptance_conflict_rate ?? "n/a"}`
      )
    ].join("\n") + "\n"
  );
  if (!result.report.passed) process.exitCode = 1;
}

export async function runPromotionBenchmarkBuildCli(
  input: BuildPromotionBenchmarkInput
): Promise<void> {
  const result = await buildPromotionBenchmarkSuite(input);
  process.stdout.write(
    [
      `Promotion benchmark built: ${result.suite_id}`,
      `Cases: ${result.case_count}`,
      `Output: ${result.output_dir}`,
      `Suite: ${result.suite_path}`
    ].join("\n") + "\n"
  );
}

export async function runPromotionBenchmarkSystemsCli(
  input: RunPromotionBenchmarkSystemsInput
): Promise<void> {
  const result = await runPromotionBenchmarkSystems(input);
  process.stdout.write(
    [
      `Promotion benchmark systems completed: ${result.suite_id}`,
      `Systems: ${result.systems.join(", ")}`,
      `Predictions: ${result.prediction_count}`,
      `Output: ${result.predictions_path}`
    ].join("\n") + "\n"
  );
}

export async function runPromotionPromptPackExportCli(
  input: ExportPromotionPromptPackInput
): Promise<void> {
  const result = await exportPromotionBenchmarkPromptPack(input);
  process.stdout.write(
    [
      `Promotion prompt pack exported: ${result.suite_id}`,
      `Requests: ${result.request_count}`,
      `Provider input: ${result.requests_path}`,
      `Private map: ${result.private_map_path}`
    ].join("\n") + "\n"
  );
}

export async function runPromotionResponseImportCli(
  input: ImportPromotionResponsesInput
): Promise<void> {
  const result = await importPromotionBenchmarkResponses(input);
  process.stdout.write(
    [
      `Promotion provider responses imported: ${result.prediction_count}`,
      `Output: ${result.predictions_path}`
    ].join("\n") + "\n"
  );
}

export async function runPromotionAnnotationPackExportCli(
  input: ExportPromotionAnnotationPackInput
): Promise<void> {
  const result = await exportPromotionAnnotationPack(input);
  process.stdout.write(
    [
      `Promotion annotation pack exported: ${result.suite_id}`,
      `Tasks: ${result.annotation_count}`,
      `Annotator directory: ${result.annotator_dir}`,
      `Annotator input: ${result.tasks_path}`,
      `Private map: ${result.private_map_path}`,
      `Rubric: ${result.rubric_path}`
    ].join("\n") + "\n"
  );
}

export async function runPromotionMutationAuditPackExportCli(
  input: ExportPromotionMutationAuditPackInput
): Promise<void> {
  const result = await exportPromotionMutationAuditPack(input);
  process.stdout.write(
    [
      `Promotion mutation audit pack exported: ${result.suite_id}`,
      `Tasks: ${result.audit_count}`,
      `Auditor directory: ${result.auditor_dir}`,
      `Auditor input: ${result.tasks_path}`,
      `Private map: ${result.private_map_path}`,
      `Rubric: ${result.rubric_path}`
    ].join("\n") + "\n"
  );
}

export async function runPromotionMutationAuditVerificationCli(
  input: VerifyPromotionMutationAuditInput
): Promise<void> {
  const result = await verifyPromotionMutationAudit(input);
  process.stdout.write(
    [
      `Promotion mutation audit ${result.report.passed ? "passed" : "failed"}: ${result.report.suite_id}`,
      `Isolated cases: ${result.report.verified_case_count}/${result.report.case_count}`,
      `Confounded cases: ${result.report.confounded_case_count}`,
      `Status: ${result.report.mutation_isolation_status}`,
      `Report: ${result.report_path}`
    ].join("\n") + "\n"
  );
  if (!result.report.passed) process.exitCode = 1;
}

export async function runPromotionAdjudicationCli(
  input: AdjudicatePromotionBenchmarkInput
): Promise<void> {
  const result = await adjudicatePromotionBenchmark(input);
  process.stdout.write(
    [
      `Promotion adjudication ${result.report.passed ? "passed" : "failed"}: ${result.report.suite_id}`,
      `Accepted labels: ${result.report.accepted_label_count}/${result.report.case_count}`,
      `Disagreements: ${result.report.disagreement_count}; resolved=${result.report.resolved_disagreement_count}`,
      `Mutation isolation: ${result.report.mutation_isolation.status}`,
      `Paper-claim eligible: ${result.report.eligibility.paper_claim_eligible}`,
      `Report: ${result.report_path}`,
      ...(result.suite_path ? [`Suite: ${result.suite_path}`] : [])
    ].join("\n") + "\n"
  );
  if (!result.report.passed) process.exitCode = 1;
}

export async function runSyntheticPromotionCorpusCli(
  input: GenerateSyntheticPromotionCorpusInput
): Promise<void> {
  const result = await generateSyntheticPromotionCorpus(input);
  process.stdout.write(
    [
      `Synthetic promotion development corpus generated: ${result.corpus_id}`,
      `Base bundles: ${result.base_bundle_count}`,
      `Cases: ${result.case_count}`,
      `Recipe: ${result.recipe_path}`,
      "Evidence class: synthetic development; not paper-claim eligible"
    ].join("\n") + "\n"
  );
}

export async function runPromotionConfirmatoryFreezeCli(
  input: FreezePromotionConfirmatoryInput
): Promise<void> {
  const result = await freezePromotionConfirmatoryCorpus(input);
  process.stdout.write(
    [
      `Promotion confirmatory intake frozen: ${result.study_id}`,
      `Base bundles: ${result.base_bundle_count}`,
      `Cases: ${result.case_count}`,
      `Recipe: ${result.recipe_path}`,
      `Freeze manifest: ${result.freeze_manifest_path}`,
      "Labels: provisional; blind independent adjudication required",
      "Paper-claim eligible: false"
    ].join("\n") + "\n"
  );
}

export async function runPromotionConfirmatoryAuditCli(
  input: AuditPromotionConfirmatoryIntakeInput
): Promise<void> {
  const result = await auditPromotionConfirmatoryIntake(input);
  process.stdout.write(
    [
      `Promotion confirmatory intake audit ${result.report.passed ? "passed" : "failed"}: ${result.report.study_id}`,
      `Artifact-verified sources: ${result.report.artifact_verified_source_count}/${result.report.source_count}`,
      `Minimum sources: ${result.report.minimum_source_count}`,
      `Report: ${result.report_path}`
    ].join("\n") + "\n"
  );
  if (!result.report.passed) process.exitCode = 1;
}

export async function runPromotionFailureAnalysisCli(
  input: AnalyzePromotionBenchmarkFailuresInput
): Promise<void> {
  const result = await analyzePromotionBenchmarkFailures(input);
  process.stdout.write(
    [
      `Promotion failure analysis completed: ${result.suite_id}`,
      `System: ${result.system_id}`,
      `Failed cases: ${result.failed_case_count}/${result.evaluated_case_count}`,
      `Node recommendations: ${result.recommendation_count}`,
      `Output: ${result.output_dir}`
    ].join("\n") + "\n"
  );
}
