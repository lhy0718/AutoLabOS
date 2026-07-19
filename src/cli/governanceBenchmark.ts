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
import {
  preparePromotionExecutionEvidence,
  type PreparePromotionExecutionEvidenceInput
} from "../core/benchmark/promotionBenchmarkExecutionEvidence.js";
import {
  projectPromotionSource,
  type ProjectPromotionSourceInput
} from "../core/benchmark/promotionBenchmarkSourceProjection.js";
import {
  auditPromotionSourceExpansion,
  type AuditPromotionSourceExpansionInput
} from "../core/benchmark/promotionBenchmarkSourceExpansionAudit.js";
import {
  exportPromotionTrialCandidateHandoff,
  type ExportPromotionTrialCandidateHandoffInput
} from "../core/benchmark/promotionBenchmarkTrialCandidateHandoff.js";
import {
  adjudicatePromotionTrialCandidateReview,
  preparePromotionTrialCandidateAnnotationWorksheet,
  preparePromotionTrialCandidateLicenseReviewWorksheet,
  preflightPromotionTrialCandidateAnnotation,
  preflightPromotionTrialCandidateLicenseReview,
  type AdjudicatePromotionTrialCandidateReviewInput,
  type PreparePromotionTrialCandidateAnnotationWorksheetInput,
  type PreparePromotionTrialCandidateLicenseReviewWorksheetInput,
  type PreflightPromotionTrialCandidateAnnotationInput,
  type PreflightPromotionTrialCandidateLicenseReviewInput
} from "../core/benchmark/promotionBenchmarkTrialCandidateReview.js";
import {
  preparePromotionTrialCandidateReviewCampaign,
  type PreparePromotionTrialCandidateReviewCampaignInput
} from "../core/benchmark/promotionBenchmarkTrialCandidateReviewCampaign.js";
import {
  collectPromotionTrialCandidateReviewCampaign,
  type CollectPromotionTrialCandidateReviewCampaignInput
} from "../core/benchmark/promotionBenchmarkTrialCandidateReviewCampaignReturn.js";
import {
  auditPromotionTrialCandidateReviewWorkspace,
  finalizePromotionTrialCandidateReviewWorkspace,
  preparePromotionTrialCandidateReviewWorkspace,
  type AuditPromotionTrialCandidateReviewWorkspaceInput,
  type FinalizePromotionTrialCandidateReviewWorkspaceInput,
  type PreparePromotionTrialCandidateReviewWorkspaceInput
} from "../core/benchmark/promotionBenchmarkTrialCandidateReviewWorkspace.js";
import {
  preparePromotionCanonicalCurationHandoff,
  type PreparePromotionCanonicalCurationHandoffInput
} from "../core/benchmark/promotionBenchmarkCanonicalCurationHandoff.js";
import {
  collectPromotionCanonicalCurationReturn,
  type CollectPromotionCanonicalCurationReturnInput
} from "../core/benchmark/promotionBenchmarkCanonicalCurationReturn.js";
import {
  exportPromotionSourceNormalizationPack,
  normalizePromotionSource,
  type ExportPromotionSourceNormalizationPackInput,
  type NormalizePromotionSourceInput
} from "../core/benchmark/promotionBenchmarkSourceNormalization.js";
import {
  exportPromotionSourceNormalizationBatch,
  type ExportPromotionSourceNormalizationBatchInput
} from "../core/benchmark/promotionBenchmarkSourceNormalizationBatch.js";
import {
  preflightPromotionSourceNormalizationAnnotation,
  type PreflightPromotionSourceNormalizationAnnotationInput
} from "../core/benchmark/promotionBenchmarkSourceNormalizationAnnotationPreflight.js";
import {
  adjudicatePromotionSourceNormalizationBatch,
  type AdjudicatePromotionSourceNormalizationBatchInput
} from "../core/benchmark/promotionBenchmarkSourceNormalizationAdjudication.js";
import {
  materializePromotionSourceNormalizationBatch,
  type MaterializePromotionSourceNormalizationBatchInput
} from "../core/benchmark/promotionBenchmarkSourceNormalizationMaterialization.js";
import {
  runPromotionBenchmarkProvider
} from "../core/benchmark/promotionBenchmarkProviderRunner.js";
import {
  aggregatePromotionBenchmarkProviderRuns,
  type AggregatePromotionProviderRunsInput
} from "../core/benchmark/promotionBenchmarkProviderAggregate.js";
import {
  evaluatePromotionConfirmatoryGate,
  type EvaluatePromotionConfirmatoryGateInput
} from "../core/benchmark/promotionBenchmarkConfirmatoryGate.js";
import {
  evaluatePromotionBenchmarkRecovery,
  type EvaluatePromotionRecoveryInput
} from "../core/benchmark/promotionBenchmarkRecovery.js";
import {
  runPromotionDevelopmentRecovery,
  type RunPromotionDevelopmentRecoveryInput
} from "../core/benchmark/promotionBenchmarkDevelopmentRecovery.js";
import {
  exportPromotionDevelopmentEvidence,
  type ExportPromotionDevelopmentEvidenceInput
} from "../core/benchmark/promotionBenchmarkDevelopmentEvidence.js";
import { resolveOpenAiApiKey } from "../config.js";
import { OpenAiResponsesTextClient } from "../integrations/openai/responsesTextClient.js";
import { OllamaClient } from "../integrations/ollama/ollamaClient.js";
import { DEFAULT_OLLAMA_BASE_URL } from "../integrations/ollama/modelCatalog.js";

export interface RunPromotionProviderCliInput {
  cwd: string;
  suitePath: string;
  provider: "openai" | "ollama";
  model: string;
  reasoningEffort: string;
  baseUrl?: string;
  systemId: string;
  trialId: string;
  outDir: string;
}

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
      `Output: ${result.predictions_path}`,
      `Manifest: ${result.manifest_path}`
    ].join("\n") + "\n"
  );
}

export async function runPromotionProviderCli(
  input: RunPromotionProviderCliInput
): Promise<void> {
  const result = input.provider === "ollama"
    ? await runOllamaPromotionProvider(input)
    : await runOpenAiPromotionProvider(input);
  process.stdout.write(
    [
      `Promotion provider run completed: ${result.manifest.run_id}`,
      `Suite: ${result.manifest.suite_id}`,
      `Responses: ${result.manifest.completed_response_count}/${result.manifest.request_count}`,
      `Provider: ${result.manifest.provider}`,
      `Execution environment: ${result.manifest.execution_environment}`,
      `Cost USD: ${result.manifest.usage.cost_usd.toFixed(6)}`,
      `Paper-claim evidence eligible: ${result.manifest.paper_claim_evidence_eligible}`,
      `Predictions: ${result.predictions_path}`,
      `Manifest: ${result.manifest_path}`
    ].join("\n") + "\n"
  );
}

async function runOpenAiPromotionProvider(input: RunPromotionProviderCliInput) {
  const apiKey = await resolveOpenAiApiKey(input.cwd);
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for an external promotion provider run.");
  }
  const client = new OpenAiResponsesTextClient(async () => apiKey, {
    model: input.model,
    reasoningEffort: input.reasoningEffort
  });
  return runPromotionBenchmarkProvider({
    cwd: input.cwd,
    suitePath: input.suitePath,
    outDir: input.outDir,
    provider: "openai_responses_api",
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    systemId: input.systemId,
    trialId: input.trialId,
    evidenceClass: "external_real_provider"
  }, {
    complete: (request) => client.complete({
      prompt: request.prompt,
      model: request.model,
      reasoningEffort: request.reasoningEffort
    })
  });
}

async function runOllamaPromotionProvider(input: RunPromotionProviderCliInput) {
  const client = new OllamaClient(input.baseUrl || DEFAULT_OLLAMA_BASE_URL);
  const models = await client.listModels();
  const installed = models.find((model) =>
    model.name === input.model || model.name === `${input.model}:latest`);
  if (!installed?.digest) {
    throw new Error(`Ollama model is unavailable or has no digest: ${input.model}.`);
  }
  return runPromotionBenchmarkProvider({
    cwd: input.cwd,
    suitePath: input.suitePath,
    outDir: input.outDir,
    provider: "ollama_local",
    model: input.model,
    modelArtifactDigest: installed.digest,
    reasoningEffort: input.reasoningEffort,
    systemId: input.systemId,
    trialId: input.trialId,
    evidenceClass: "local_real_model"
  }, {
    complete: async (request) => {
      const completion = await client.chat({
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
        format: "json",
        think: false,
        options: { temperature: 0 }
      });
      return {
        text: completion.text,
        model: completion.model,
        totalDurationNs: completion.totalDuration,
        usage: {
          inputTokens: completion.promptEvalCount,
          outputTokens: completion.evalCount,
          costUsd: 0
        }
      };
    }
  });
}

export async function runPromotionProviderAggregationCli(
  input: AggregatePromotionProviderRunsInput
): Promise<void> {
  const result = await aggregatePromotionBenchmarkProviderRuns(input);
  process.stdout.write(
    [
      `Promotion provider runs aggregated: ${result.manifest.aggregate_id}`,
      `Suite: ${result.manifest.suite_id}`,
      `Trials: ${result.manifest.trial_count}`,
      `Predictions: ${result.manifest.prediction_count}`,
      `Independent trial requirement: ${result.manifest.independent_trial_requirement_met}`,
      `Paper-claim evidence eligible: ${result.manifest.paper_claim_evidence_eligible}`,
      `Output: ${result.predictions_path}`,
      `Manifest: ${result.manifest_path}`
    ].join("\n") + "\n"
  );
}

export async function runPromotionConfirmatoryGateCli(
  input: EvaluatePromotionConfirmatoryGateInput
): Promise<void> {
  const result = await evaluatePromotionConfirmatoryGate(input);
  process.stdout.write(
    [
      "Promotion confirmatory gate: " + result.report.readiness,
      "Suite: " + result.report.suite_id,
      "Claim class: " + result.report.claim_class,
      "Cases: " + result.report.case_count,
      "Base bundles: " + result.report.base_bundle_count,
      "Blockers: " + result.report.blockers.length,
      "Report: " + result.gate_report_path,
      "Recommendations: " + result.recommendations_path
    ].join("\n") + "\n"
  );
  if (!result.report.evidence_gate_passed) process.exitCode = 1;
}

export async function runPromotionRecoveryEvaluationCli(
  input: EvaluatePromotionRecoveryInput
): Promise<void> {
  const result = await evaluatePromotionBenchmarkRecovery(input);
  process.stdout.write(
    [
      "Promotion recovery evaluation " + (result.report.passed ? "passed" : "failed") + ": " + result.report.study_id,
      "System: " + result.report.system_id,
      "Fault-family coverage: " + result.report.covered_fault_families.length + "/" + result.report.required_fault_families.length,
      "Fault-case coverage: " + result.report.covered_fault_case_count + "/" + result.report.original_fault_case_count,
      "Successful recovery: " + formatOptionalRate(result.report.successful_recovery_rate),
      "Clean-control regression: " + formatOptionalRate(result.report.clean_control_regression_rate),
      "Report: " + result.report_path,
      "Summary: " + result.markdown_path,
      "Evidence boundary: paper-scale recovery requires external real-run, double-adjudicated, artifact-verified suites"
    ].join("\n") + "\n"
  );
  if (!result.report.passed) process.exitCode = 1;
}

export async function runPromotionDevelopmentRecoveryCli(
  input: RunPromotionDevelopmentRecoveryInput
): Promise<void> {
  const result = await runPromotionDevelopmentRecovery(input);
  process.stdout.write(
    [
      "Promotion development recovery verified: " + result.summary.source_suite_id,
      "System: " + result.summary.system_id,
      "Fault-case coverage: " + result.summary.covered_fault_case_count + "/" + result.summary.original_fault_case_count,
      "Successful recovery: " + formatOptionalRate(result.summary.successful_recovery_rate),
      "Clean-control regression: " + formatOptionalRate(result.summary.clean_control_regression_rate),
      "Recovery manifest: " + result.recovery_manifest_path,
      "Summary: " + result.summary_path,
      "Evidence boundary: synthetic development only; not eligible for paper claims"
    ].join("\n") + "\n"
  );
}

export async function runPromotionDevelopmentEvidenceExportCli(
  input: ExportPromotionDevelopmentEvidenceInput
): Promise<void> {
  const result = await exportPromotionDevelopmentEvidence(input);
  process.stdout.write(
    [
      "Promotion development evidence exported and cross-verified",
      "Corpus: " + result.report.corpus.corpus_id,
      "Cases: " + result.report.corpus.case_count,
      "Readiness: " + result.report.confirmatory_gate.readiness,
      "Paper-claim eligible: " + result.report.paper_claim_eligible,
      "Output: " + result.output_path
    ].join("\n") + "\n"
  );
}

function formatOptionalRate(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

export async function runPromotionPromptPackExportCli(
  input: ExportPromotionPromptPackInput
): Promise<void> {
  const result = await exportPromotionBenchmarkPromptPack(input);
  process.stdout.write(
    [
      `Promotion prompt pack exported: ${result.suite_id}`,
      `Requests: ${result.request_count}`,
      `Requests SHA-256: ${result.requests_sha256}`,
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

export async function runPromotionExecutionEvidencePreparationCli(
  input: PreparePromotionExecutionEvidenceInput
): Promise<void> {
  const result = await preparePromotionExecutionEvidence(input);
  process.stdout.write(
    [
      "Promotion execution evidence prepared and self-inspected",
      `Manifest: ${result.manifest_path}`,
      `Artifact roles: ${result.inspection.roles.length}`,
      `Execution fingerprint: ${result.inspection.execution_fingerprint}`,
      "Evidence boundary: artifact existence and hashes verified; execution occurrence and operator independence are not proven"
    ].join("\n") + "\n"
  );
}

export async function runPromotionSourceProjectionCli(
  input: ProjectPromotionSourceInput
): Promise<void> {
  const result = await projectPromotionSource(input);
  process.stdout.write(
    [
      `Promotion source projection ${result.manifest.ready_for_confirmatory_intake ? "ready" : "prepared with blockers"}`,
      `Output: ${result.output_dir}`,
      `Manifest: ${result.manifest_path}`,
      `Outputs: ${result.manifest.outputs.length}`,
      `Promotion compatible: ${result.manifest.promotion_compatible}`,
      `Execution evidence verified: ${result.manifest.execution_evidence_verified}`,
      "Evidence boundary: deterministic byte selection and JSON-pointer extraction only; execution, operator identity, licensing, and scientific validity are not inferred"
    ].join("\n") + "\n"
  );
}

export async function runPromotionSourceExpansionAuditCli(
  input: AuditPromotionSourceExpansionInput
): Promise<void> {
  const result = await auditPromotionSourceExpansion(input);
  process.stdout.write(
    [
      `Promotion source expansion audit ${result.report.paper_scale_source_ready ? "passed" : "failed"}: ${result.report.study_id}`,
      `Exact confirmatory admissions: ${result.report.exact_confirmatory_admitted_count}/${result.report.required_base_bundle_count}`,
      `Remaining base-bundle gap: ${result.report.remaining_base_bundle_gap}`,
      `Admitted source families: ${result.report.admitted_source_family_count}`,
      `Admitted operator groups: ${result.report.admitted_operator_group_count}`,
      `Upstream rechecks: ${result.report.node_recommendations.map((item) => item.node).join(", ") || "none"}`,
      `Report: ${result.report_path}`,
      `Summary: ${result.summary_path}`
    ].join("\n") + "\n"
  );
  if (!result.report.paper_scale_source_ready) process.exitCode = 1;
}

export async function runPromotionTrialCandidateHandoffExportCli(
  input: ExportPromotionTrialCandidateHandoffInput
): Promise<void> {
  const result = await exportPromotionTrialCandidateHandoff(input);
  process.stdout.write(
    [
      `Promotion trial-candidate handoff prepared: ${result.handoff_id}`,
      `Base candidates: ${result.base_candidate_count}`,
      `Trial artifacts: ${result.trial_artifact_count}`,
      `Reviewer packet: ${result.reviewer_dir}`,
      `License-review packet: ${result.license_reviewer_dir}`,
      `Controller map: ${result.controller_map_path}`,
      `Portable source recipe: ${result.source_recipe_path}`,
      `Manifest: ${result.manifest_path}`,
      `Evidence summary: ${result.evidence_summary_path}`,
      "Evidence boundary: revision-bound source-trace candidate handoff only; no licensing, human annotation, confirmatory admission, or paper-readiness claim"
    ].join("\n") + "\n"
  );
}

export async function runPromotionTrialCandidateReviewCampaignCli(
  input: PreparePromotionTrialCandidateReviewCampaignInput
): Promise<void> {
  const result = await preparePromotionTrialCandidateReviewCampaign(input);
  process.stdout.write(
    [
      "Pending human-review campaign prepared",
      `Campaign: ${result.campaign_id}`,
      `Handoff: ${result.handoff_id}`,
      `Candidates: ${result.candidate_count}`,
      `Reviewer packages: ${result.reviewer_package_paths.join(", ")}`,
      `License-review package: ${result.license_package_path}`,
      `Manifest: ${result.manifest_path}`,
      "Completed human annotations: 0",
      "Status: all templates remain incomplete; no human review, license decision, adjudication, or confirmatory admission"
    ].join("\n") + "\n"
  );
}

export async function runPromotionTrialCandidateReviewCampaignCollectionCli(
  input: CollectPromotionTrialCandidateReviewCampaignInput
): Promise<void> {
  const result = await collectPromotionTrialCandidateReviewCampaign(input);
  process.stdout.write(
    [
      `Campaign return collection ${result.receipt.passed ? "passed" : "blocked"}`,
      `Campaign: ${result.receipt.campaign_id}`,
      `Handoff: ${result.receipt.handoff_id}`,
      `Assigned returns: ${result.receipt.assigned_return_count}/${result.receipt.required_return_count}`,
      `Adjudication: ${result.receipt.adjudication.attempted ? (result.receipt.adjudication.passed ? "passed" : "failed") : "not attempted"}`,
      `Accepted labels: ${result.receipt.adjudication.accepted_label_count}/${result.receipt.adjudication.task_count}`,
      `Source-eligible candidates: ${result.receipt.adjudication.source_eligible_candidate_count}`,
      `Receipt: ${result.receipt_path}`,
      `Evidence boundary: ${result.receipt.evidence_boundary}`
    ].join("\n") + "\n"
  );
  if (!result.receipt.passed) process.exitCode = 1;
}

export async function runPromotionTrialCandidateAnnotationPreflightCli(
  input: PreflightPromotionTrialCandidateAnnotationInput
): Promise<void> {
  const result = await preflightPromotionTrialCandidateAnnotation(input);
  process.stdout.write(
    [
      `Promotion trial-candidate annotation preflight ${result.report.passed ? "passed" : "failed"}`,
      `Annotator: ${result.report.annotator_id || "unresolved"}`,
      `Coverage: ${result.report.annotation_count}/${result.report.task_count}`,
      `Source-eligible candidates: ${result.report.source_eligible_candidate_count}/${result.report.task_count}`,
      `All-artifact-positive candidates: ${result.report.positive_candidate_count}/${result.report.task_count}`,
      `Report: ${result.report_path}`,
      `Summary: ${result.summary_path}`,
      "Evidence boundary: one candidate-review file only; no reviewer comparison, source-license assessment, or confirmatory admission"
    ].join("\n") + "\n"
  );
  if (!result.report.passed) process.exitCode = 1;
}

export async function runPromotionTrialCandidateLicenseReviewPreflightCli(
  input: PreflightPromotionTrialCandidateLicenseReviewInput
): Promise<void> {
  const result = await preflightPromotionTrialCandidateLicenseReview(input);
  process.stdout.write(
    [
      `Promotion trial-candidate source-license review preflight ${result.report.passed ? "passed" : "failed"}`,
      `Reviewer: ${result.report.reviewer_id || "unresolved"}`,
      `License status: ${result.report.license_status || "unresolved"}`,
      `Evidence references: ${result.report.evidence_reference_count}`,
      `Report: ${result.report_path}`,
      `Summary: ${result.summary_path}`,
      `Evidence boundary: ${result.report.evidence_boundary}`
    ].join("\n") + "\n"
  );
  if (!result.report.passed) process.exitCode = 1;
}

export async function runPromotionTrialCandidateAnnotationWorksheetCli(
  input: PreparePromotionTrialCandidateAnnotationWorksheetInput
): Promise<void> {
  const result = await preparePromotionTrialCandidateAnnotationWorksheet(input);
  process.stdout.write(
    [
      "Unlabeled trial-candidate annotation worksheet prepared",
      `Handoff: ${result.handoff_id}`,
      `Annotator ID: ${result.annotator_id}`,
      `Tasks: ${result.task_count}`,
      `Output: ${result.output_path}`,
      "Status: incomplete by construction; human review and attestation are required before preflight"
    ].join("\n") + "\n"
  );
}

export async function runPromotionTrialCandidateReviewWorkspacePreparationCli(
  input: PreparePromotionTrialCandidateReviewWorkspaceInput
): Promise<void> {
  const result = await preparePromotionTrialCandidateReviewWorkspace(input);
  process.stdout.write(
    [
      "Resumable trial-candidate review workspace prepared",
      `Handoff: ${result.handoff_id}`,
      `Annotator ID: ${result.annotator_id}`,
      `Tasks: ${result.task_count}`,
      `Workspace: ${result.output_dir}`,
      `Manifest: ${result.manifest_path}`,
      "Status: all candidate labels and attestations remain incomplete by construction"
    ].join("\n") + "\n"
  );
}

export async function runPromotionTrialCandidateReviewWorkspaceAuditCli(
  input: AuditPromotionTrialCandidateReviewWorkspaceInput
): Promise<void> {
  const result = await auditPromotionTrialCandidateReviewWorkspace(input);
  process.stdout.write(
    [
      `Trial-candidate review workspace ${result.report.workspace_valid ? "valid" : "invalid"}`,
      `Ready to finalize: ${result.report.ready_to_finalize}`,
      `Completed: ${result.report.completed_annotation_count}/${result.report.task_count}`,
      `Incomplete: ${result.report.incomplete_annotation_count}`,
      `Malformed: ${result.report.malformed_annotation_count}`,
      `Attestation complete: ${result.report.attestation_complete}`,
      `Report: ${result.report_path}`,
      `Summary: ${result.summary_path}`,
      "Evidence boundary: structural progress only; no human identity, semantic preflight, adjudication, or confirmatory admission"
    ].join("\n") + "\n"
  );
  if (!result.report.workspace_valid) process.exitCode = 1;
}

export async function runPromotionTrialCandidateReviewWorkspaceFinalizationCli(
  input: FinalizePromotionTrialCandidateReviewWorkspaceInput
): Promise<void> {
  const result = await finalizePromotionTrialCandidateReviewWorkspace(input);
  process.stdout.write(
    [
      "Trial-candidate review workspace assembled",
      `Handoff: ${result.handoff_id}`,
      `Annotator ID: ${result.annotator_id}`,
      `Tasks: ${result.task_count}`,
      `Output: ${result.output_path}`,
      `Reviewer packet: ${result.reviewer_root}`,
      "Status: packet-bound annotation preflight remains required before campaign collection"
    ].join("\n") + "\n"
  );
}

export async function runPromotionTrialCandidateLicenseReviewWorksheetCli(
  input: PreparePromotionTrialCandidateLicenseReviewWorksheetInput
): Promise<void> {
  const result = await preparePromotionTrialCandidateLicenseReviewWorksheet(input);
  process.stdout.write(
    [
      "Unreviewed trial-candidate source-license worksheet prepared",
      `Handoff: ${result.handoff_id}`,
      `Reviewer ID: ${result.reviewer_id}`,
      `Output: ${result.output_path}`,
      "Status: incomplete by construction; human source-license review and attestation are required before adjudication"
    ].join("\n") + "\n"
  );
}

export async function runPromotionTrialCandidateReviewAdjudicationCli(
  input: AdjudicatePromotionTrialCandidateReviewInput
): Promise<void> {
  const result = await adjudicatePromotionTrialCandidateReview(input);
  process.stdout.write(
    [
      `Promotion trial-candidate review adjudication ${result.report.passed ? "passed" : "failed"}`,
      `Accepted labels: ${result.report.accepted_label_count}/${result.report.task_count}`,
      `Disagreements: ${result.report.disagreement_count}`,
      `Resolved disagreements: ${result.report.resolved_disagreement_count}`,
      `License reviewer: ${result.report.license_reviewer_id || "unresolved"}`,
      `Report: ${result.report_path}`,
      `Evidence summary: ${result.evidence_path || "not emitted"}`,
      "Evidence boundary: adjudicated candidate review remains separate from canonical normalization and confirmatory admission"
    ].join("\n") + "\n"
  );
  if (!result.report.passed) process.exitCode = 1;
}

export async function runPromotionCanonicalCurationHandoffCli(
  input: PreparePromotionCanonicalCurationHandoffInput
): Promise<void> {
  const result = await preparePromotionCanonicalCurationHandoff(input);
  process.stdout.write(
    [
      "Pending canonical-curation handoff prepared",
      `Handoff: ${result.handoff_id}`,
      `Tasks: ${result.task_count}`,
      `Curator guide: ${result.curator_guide_path}`,
      `Verifier guide: ${result.verifier_guide_path}`,
      `Manifest: ${result.manifest_path}`,
      "Canonical sources: 0",
      "Status: human curation and independent verification remain incomplete; no confirmatory admission"
    ].join("\n") + "\n"
  );
}

export async function runPromotionCanonicalCurationReturnCollectionCli(
  input: CollectPromotionCanonicalCurationReturnInput
): Promise<void> {
  const result = await collectPromotionCanonicalCurationReturn(input);
  process.stdout.write(
    [
      `Canonical curation return ${result.receipt.passed ? "verified" : "blocked"}`,
      `Handoff: ${result.receipt.handoff_id}`,
      `Received returns: ${result.receipt.received_return_count}/${result.receipt.required_return_count}`,
      `Assignment matched: ${result.receipt.assigned_return_count}/${result.receipt.required_return_count}`,
      `Canonical validation passed: ${result.receipt.verified_return_count}/${result.receipt.required_return_count}`,
      `Receipt: ${result.receipt_path}`,
      "Evidence boundary: a verified return remains pre-confirmatory evidence and does not establish paper readiness"
    ].join("\n") + "\n"
  );
  if (!result.receipt.passed) process.exitCode = 1;
}

export async function runPromotionSourceNormalizationPackExportCli(
  input: ExportPromotionSourceNormalizationPackInput
): Promise<void> {
  const result = await exportPromotionSourceNormalizationPack(input);
  process.stdout.write(
    [
      `Promotion source-normalization pack exported: ${result.normalization_id}`,
      `Annotator pack: ${result.annotator_dir}`,
      `Tasks: ${result.tasks_path}`,
      `Private map: ${result.private_map_path}`,
      `Rubric: ${result.rubric_path}`,
      "Evidence boundary: annotation tasks expose projected artifacts but no canonical promotion label"
    ].join("\n") + "\n"
  );
}

export async function runPromotionSourceNormalizationBatchExportCli(
  input: ExportPromotionSourceNormalizationBatchInput
): Promise<void> {
  const result = await exportPromotionSourceNormalizationBatch(input);
  process.stdout.write(
    [
      `Promotion source-normalization review batch exported: ${result.batch_id}`,
      `Items: ${result.item_count}`,
      `Reviewer pack: ${result.reviewer_dir}`,
      `Tasks: ${result.tasks_path}`,
      `Controller map: ${result.controller_map_path}`,
      `Manifest: ${result.manifest_path}`,
      "Evidence boundary: distribute the reviewer directory only; packaging does not establish human completion or independence"
    ].join("\n") + "\n"
  );
}

export async function runPromotionSourceNormalizationAnnotationPreflightCli(
  input: PreflightPromotionSourceNormalizationAnnotationInput
): Promise<void> {
  const result = await preflightPromotionSourceNormalizationAnnotation(input);
  process.stdout.write(
    [
      `Source-normalization annotation preflight ${result.report.passed ? "passed" : "failed"}`,
      `Annotator: ${result.report.annotator_id || "unresolved"}`,
      `Coverage: ${result.report.annotation_count}/${result.report.task_count}`,
      `Materialization-ready: ${result.report.materialization_ready_count}/${result.report.task_count}`,
      `Report: ${result.report_path}`,
      `Summary: ${result.summary_path}`
    ].join("\n") + "\n"
  );
  if (!result.report.passed) process.exitCode = 1;
}

export async function runPromotionSourceNormalizationBatchAdjudicationCli(
  input: AdjudicatePromotionSourceNormalizationBatchInput
): Promise<void> {
  const result = await adjudicatePromotionSourceNormalizationBatch(input);
  process.stdout.write(
    [
      `Promotion source-normalization batch adjudicated: ${result.report.batch_id}`,
      `Passed: ${result.report.passed}`,
      `Accepted labels: ${result.report.accepted_label_count}/${result.report.task_count}`,
      `Disagreements: ${result.report.disagreement_count}`,
      `Resolved disagreements: ${result.report.resolved_disagreement_count}`,
      `Report: ${result.report_path}`,
      `Materialization jobs: ${result.materialization_jobs_path || "not emitted"}`,
      "Evidence boundary: structural coverage and pseudonymous role separation do not prove real-world reviewer identity or independence"
    ].join("\n") + "\n"
  );
}

export async function runPromotionSourceNormalizationBatchMaterializationCli(
  input: MaterializePromotionSourceNormalizationBatchInput
): Promise<void> {
  const result = await materializePromotionSourceNormalizationBatch(input);
  process.stdout.write(
    [
      `Promotion source-normalization batch materialized: ${result.report.batch_id}`,
      `Passed: ${result.report.passed}`,
      `Materialized: ${result.report.materialized_count}/${result.report.item_count}`,
      `Failed: ${result.report.failed_count}`,
      `Report: ${result.report_path}`,
      "Evidence boundary: batch success requires every item to pass source, execution, license, and mutation inspection"
    ].join("\n") + "\n"
  );
}

export async function runPromotionSourceNormalizationCli(
  input: NormalizePromotionSourceInput
): Promise<void> {
  const result = await normalizePromotionSource(input);
  process.stdout.write(
    [
      `Promotion source normalized: ${result.normalization_id}`,
      `Adjudication: ${result.adjudication_source}`,
      `Output: ${result.output_dir}`,
      `Manifest: ${result.manifest_path}`,
      "Evidence boundary: human mapping is preserved separately from hash-bound source execution artifacts"
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
      `Intake tier: ${result.intake_tier}`,
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
      `Intake tier: ${result.report.intake_tier}`,
      `Artifact-verified sources: ${result.report.artifact_verified_source_count}/${result.report.source_count}`,
      `Minimum sources: ${result.report.minimum_source_count}`,
      `Declared source families: ${result.report.declared_source_family_count}/${result.report.minimum_source_family_count} minimum`,
      `Declared operator groups: ${result.report.declared_operator_group_count}/${result.report.minimum_operator_group_count} minimum`,
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
