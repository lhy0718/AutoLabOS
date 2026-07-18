#!/usr/bin/env node
import path from "node:path";

import { runAutoLabOSApp } from "../app.js";
import { resolveCliAction } from "./args.js";
import { runAutoLabOSWebServer } from "../web/server.js";
import { runCompareAnalysisCli } from "./compareAnalysis.js";
import { runEvalHarnessCli } from "./evalHarness.js";
import { runEvolveCli } from "./evolveRun.js";
import { runPaperReadinessAuditCli } from "./audit.js";
import {
  runGovernanceBenchmarkBatchCli,
  runGovernanceBenchmarkDryRunCli,
  runGovernanceBenchmarkExportBundlesCli,
  runGovernanceBenchmarkSeedCli,
  runPromotionBenchmarkBuildCli,
  runPromotionPromptPackExportCli,
  runPromotionResponseImportCli,
  runPromotionAnnotationPackExportCli,
  runPromotionMutationAuditPackExportCli,
  runPromotionMutationAuditVerificationCli,
  runPromotionAdjudicationCli,
  runPromotionBenchmarkSystemsCli,
  runPromotionProviderCli,
  runPromotionProviderAggregationCli,
  runSyntheticPromotionCorpusCli,
  runPromotionSourceExpansionAuditCli,
  runPromotionTrialCandidateHandoffExportCli,
  runPromotionTrialCandidateReviewCampaignCli,
  runPromotionTrialCandidateReviewCampaignCollectionCli,
  runPromotionTrialCandidateAnnotationWorksheetCli,
  runPromotionTrialCandidateLicenseReviewWorksheetCli,
  runPromotionTrialCandidateAnnotationPreflightCli,
  runPromotionTrialCandidateLicenseReviewPreflightCli,
  runPromotionTrialCandidateReviewAdjudicationCli,
  runPromotionCanonicalCurationHandoffCli,
  runPromotionCanonicalCurationReturnCollectionCli,
  runPromotionSourceProjectionCli,
  runPromotionSourceNormalizationPackExportCli,
  runPromotionSourceNormalizationBatchExportCli,
  runPromotionSourceNormalizationAnnotationPreflightCli,
  runPromotionSourceNormalizationBatchAdjudicationCli,
  runPromotionSourceNormalizationBatchMaterializationCli,
  runPromotionSourceNormalizationCli,
  runPromotionExecutionEvidencePreparationCli,
  runPromotionConfirmatoryAuditCli,
  runPromotionConfirmatoryFreezeCli,
  runPromotionConfirmatoryGateCli,
  runPromotionDevelopmentEvidenceExportCli,
  runPromotionFailureAnalysisCli,
  runPromotionBenchmarkScoreCli
} from "./governanceBenchmark.js";
import { runMetaHarnessCli } from "./metaHarness.js";
import { getAppVersion } from "../tui/version.js";
import {
  runResearchAuditCli,
  runResearchImproveCli,
  runResearchNewCli,
  runResearchPackCli,
  runResearchPackVerificationCli,
  runResearchReviewCli
} from "./research.js";
import { runWithProcessLifetime } from "./processLifetime.js";
import {
  runReferenceClaimReviewPreparationCli,
  runReferenceClaimReviewPrivateDistributionCli,
  runReferenceClaimReviewPreflightCli
} from "./referenceReview.js";

function printHelp(): void {
  process.stdout.write([
    "autolabos",
    "",
    "Single entrypoint for the AutoLabOS brief-first TUI.",
    "All operations are available inside the app via /commands.",
    "",
    "Usage:",
    "  autolabos",
    "  autolabos [--package <fast|thorough|paper_scale>] [--benchmark-condition gated|ungated|no_claim_ceiling|no_review_gate|no_figure_audit]",
    "  autolabos web [--host 127.0.0.1] [--port 4317] [--benchmark-condition gated|ungated|no_claim_ceiling|no_review_gate|no_figure_audit]",
    "  autolabos compare-analysis --run <run-id> [--limit 3] [--no-judge]",
    "  autolabos eval-harness [--run <run-id>] [--limit 10] [--output outputs/eval-harness/latest.json] [--no-history]",
    "  autolabos evolve [--max-cycles 3] [--target skills|prompts|all] [--dry-run]",
    "  autolabos audit (--run <run-artifact-root> | --external <artifact-root> [--draft <draft.md>] [--log <run.log>]) [--out-dir outputs/audit]",
    "  autolabos research <new|audit|review|improve|pack|verify-pack> [options]",
    "  autolabos reference-review prepare --claims <refgate_claims.tsv> --status <reference-evidence-status.json> --lock <refgate.lock.json> --out-dir <new-handoff-dir>",
    "  autolabos reference-review distribute-private --packet <handoff-dir> --source-dir <citation-key-named-full-text-dir> --out-dir <new-private-distribution-dir>",
    "  autolabos reference-review preflight --packet <handoff-dir-or-private-distribution-dir> --review <completed-review.json> --out-dir <new-preflight-dir>",
    "  autolabos governance-benchmark seed --source <path> [--task <id>] [--out-dir outputs/governance-benchmark/seeds] [--reference-only]",
    "  autolabos governance-benchmark dry-run --seed <path> [--task <id>] [--condition gated|ungated] [--out-dir outputs/governance-benchmark/<task>]",
    "  autolabos governance-benchmark batch --seeds <path> [--task <id>] [--condition gated|ungated] [--out-dir outputs/governance-benchmark/batch]",
    "  autolabos governance-benchmark export-bundles --source <outputs/run> [--source <outputs/run>] [--max 3] [--out-dir outputs/governance-benchmark/demo-bundles]",
    "  autolabos governance-benchmark generate-promotion-development [--out-dir outputs/governance-benchmark/promotion-development-corpus]",
    "  autolabos governance-benchmark export-promotion-development-evidence --corpus-manifest <corpus-manifest.json> --suite <suite.json> --predictions <predictions.jsonl> --system-run-manifest <manifest.json> --score <promotion-score.json> --gate <promotion-confirmatory-gate.json> --recommendations <node-strengthening-recommendations.json> --output <evidence.json>",
    "  autolabos governance-benchmark audit-promotion-source-expansion --inventory <source-inventory.json> --out-dir <new-audit-dir>",
    "  autolabos governance-benchmark export-promotion-trial-candidates --recipe <portable-source-recipe.json> --source-root <hash-bound-local-source> --out-dir <new-handoff-dir>",
    "  autolabos governance-benchmark prepare-promotion-trial-candidate-review-campaign --handoff-root <handoff> --annotator-id <reviewer-a> --annotator-id <reviewer-b> --license-reviewer-id <license-reviewer> --out-dir <new-review-campaign>",
    "  autolabos governance-benchmark collect-promotion-trial-candidate-review-campaign --campaign-root <review-campaign> --handoff-root <handoff> --annotation <review-a.json> --annotation <review-b.json> --license-review <license-review.json> [--resolution <resolution.json>] --out-dir <new-campaign-return>",
    "  autolabos governance-benchmark prepare-promotion-trial-candidate-worksheet --handoff-root <handoff> --annotator-id <pseudonym> --output <annotation.json>",
    "  autolabos governance-benchmark prepare-promotion-trial-candidate-license-worksheet --handoff-root <handoff> --reviewer-id <pseudonym> --output <license-review.json>",
    "  autolabos governance-benchmark preflight-promotion-trial-candidate-annotation --reviewer-root <handoff/reviewer> --annotation <review.json> --out-dir <preflight-output>",
    "  autolabos governance-benchmark preflight-promotion-trial-candidate-license-review --license-root <handoff/license> --review <license-review.json> --out-dir <preflight-output>",
    "  autolabos governance-benchmark adjudicate-promotion-trial-candidate-review --handoff-root <handoff> --annotation <review-a.json> --annotation <review-b.json> --license-review <license-review.json> [--resolution <resolution.json>] --out-dir <adjudication>",
    "  autolabos governance-benchmark prepare-promotion-canonical-curation --handoff-root <handoff> --campaign-return-root <assigned-campaign-return> --curator-id <pseudonym> --verifier-id <pseudonym> --curator-protocol <version> --verifier-protocol <version> --out-dir <new-curation-handoff>",
    "  autolabos governance-benchmark collect-promotion-canonical-curation --curation-handoff-root <curation-handoff> --source-root <canonical-source> [--source-root <canonical-source>] --out-dir <new-curation-return>",
    "  autolabos governance-benchmark project-promotion-source --source-root <raw-source> --recipe <projection.json> --out-dir <projected-bundle>",
    "  autolabos governance-benchmark export-promotion-source-normalization --source-root <projected-bundle> --out-dir <annotation-pack>",
    "  autolabos governance-benchmark export-promotion-source-normalization-batch --recipe <batch-recipe.json> --out-dir <review-batch>",
    "  autolabos governance-benchmark preflight-promotion-source-normalization-annotation --reviewer-root <review-batch/reviewer> --annotation <labels.jsonl> --out-dir <preflight-output>",
    "  autolabos governance-benchmark adjudicate-promotion-source-normalization-batch --batch-root <review-batch> --annotations <labels-a.jsonl> --annotations <labels-b.jsonl> [--resolution <labels-resolution.jsonl>] --out-dir <adjudication>",
    "  autolabos governance-benchmark materialize-promotion-source-normalization-batch --adjudication-root <adjudication> --out-dir <normalized-batch>",
    "  autolabos governance-benchmark normalize-promotion-source --source-root <projected-bundle> --map <private-normalization-map.json> --annotations <labels-a.jsonl> --annotations <labels-b.jsonl> [--resolution <labels-resolution.jsonl>] --out-dir <normalized-bundle>",
    "  autolabos governance-benchmark prepare-promotion-execution-evidence --source-root <bundle> --run-id <id> --backend <backend> --started-at <ISO> --completed-at <ISO> --trial <id> --trial <id> --trial <id> --artifact <role=relative-path> [--artifact <role=relative-path>]",
    "  autolabos governance-benchmark audit-promotion-confirmatory --manifest <intake.json> [--out-dir outputs/governance-benchmark/promotion-confirmatory-audit]",
    "  autolabos governance-benchmark freeze-promotion-confirmatory --manifest <intake.json> [--out-dir outputs/governance-benchmark/promotion-confirmatory]",
    "  autolabos governance-benchmark gate-promotion-confirmatory --suite <suite.json> --predictions <non-provider-predictions.jsonl> [--system-run-manifest <manifest.json>] --ungated-system <id> --checklist-system <id> --manuscript-system <id> --full-system <id> [--ablation-system <id>] [--provider-run-manifest <manifest.json>] [--recovery-manifest <manifest.json>] [--out-dir <new-output-dir>]",
    "  autolabos governance-benchmark build-promotion --recipe <recipe.json> [--freeze-manifest <frozen-intake-manifest.json>] [--out-dir outputs/governance-benchmark/promotion-suite]",
    "  autolabos governance-benchmark run-promotion --suite <suite.json> [--system always-promote|presence-checklist|advisory-artifact-audit|artifact-audit] [--trial <id>] [--out-dir outputs/governance-benchmark/promotion-predictions]",
    "  autolabos governance-benchmark run-promotion-provider --suite <suite.json> --provider openai --model <id> --reasoning <effort> --system <id> --trial <id> --out-dir <new-output-dir>",
    "  autolabos governance-benchmark aggregate-promotion-provider-runs --suite <suite.json> --run-manifest <trial-a/provider-run-manifest.json> --run-manifest <trial-b/provider-run-manifest.json> --run-manifest <trial-c/provider-run-manifest.json> --out-dir <new-output-dir>",
    "  autolabos governance-benchmark export-promotion-prompts --suite <suite.json> [--out-dir outputs/governance-benchmark/promotion-prompts]",
    "  autolabos governance-benchmark import-promotion-responses --map <private-request-map.json> --responses <responses.jsonl> --system <id> --trial <id> [--out-dir outputs/governance-benchmark/provider-predictions]",
    "  autolabos governance-benchmark export-promotion-annotations --suite <suite.json> [--out-dir outputs/governance-benchmark/promotion-annotations]",
    "  autolabos governance-benchmark export-promotion-mutation-audit --suite <suite.json> [--out-dir outputs/governance-benchmark/promotion-mutation-audit]",
    "  autolabos governance-benchmark verify-promotion-mutations --suite <suite.json> --map <private-mutation-audit-map.json> --audits <audit-a.jsonl> --audits <audit-b.jsonl> [--out-dir outputs/governance-benchmark/promotion-mutation-verification]",
    "  autolabos governance-benchmark adjudicate-promotion --suite <suite.json> --map <private-annotation-map.json> --annotations <labels-a.jsonl> --annotations <labels-b.jsonl> [--resolution <labels-resolution.jsonl>] [--mutation-audit-report <mutation-audit-report.json>] [--out-dir outputs/governance-benchmark/promotion-adjudication]",
    "  autolabos governance-benchmark analyze-promotion-failures --suite <suite.json> --predictions <predictions.jsonl> --system <id> [--out-dir outputs/governance-benchmark/promotion-failures]",
    "  autolabos governance-benchmark score-promotion --suite <suite.json> --predictions <predictions.jsonl> [--out-dir outputs/governance-benchmark/promotion-score]",
    "  autolabos meta-harness [--runs 5] [--node generate_hypotheses|design_experiments|analyze_results|review] [--no-apply] [--dry-run]",
    "  autolabos meta-harness --external-run <run-artifact-root> [--external-run <run-artifact-root>] --no-apply",
    "  autolabos --help",
    "  autolabos --version"
  ].join("\n") + "\n");
}

function printAuditHelp(): void {
  process.stdout.write([
    "autolabos audit",
    "",
    "Audit AI research-agent outputs for paper-readiness without treating write_paper completion as paper-ready.",
    "",
    "Usage:",
    "  autolabos audit --run <run-artifact-root> [--out-dir outputs/audit]",
    "  autolabos audit --external <artifact-root> [--draft <draft.md>] [--log <run.log>] [--out-dir outputs/audit]",
    "",
    "Examples:",
    "  autolabos audit --run .autolabos/runs/<run-id> --out-dir outputs/audit/<run-id>",
    "  autolabos audit --external <external-artifact-root> --draft <draft.md> --log <run.log> --out-dir outputs/audit/external",
    "",
    "Outputs:",
    "  paper-readiness-audit.md",
    "  claim-evidence-table.json",
    "  audit-timeline.json",
    "  claim-promotion-timeline.json",
    "  blocked-claim-events.json",
    "  done-condition-audit.json",
    "  autonomy-metrics.json",
    "  audit-summary.json",
    "  blockers.json",
    "  external-intake-manifest.json (for --external)"
  ].join("\n") + "\n");
}

function printResearchHelp(): void {
  process.stdout.write([
    "autolabos research",
    "",
    "Execute the artifact-first research governance contract.",
    "",
    "Usage:",
    "  autolabos research new --brief <path> [--out-dir <dir>]",
    "  autolabos research audit (--run <run-root> | --external <artifact-root> [--draft <draft>] [--log <log>]) [--out-dir <dir>]",
    "  autolabos research review --gate <gate-report.json> [--out-dir <dir>]",
    "  autolabos research improve --review <review-report.json> [--out-dir <dir>]",
    "  autolabos research pack --gate <gate-report.json> --review <review-report.json> [--source-dir <audit-artifact-dir>] [--out-dir <dir>]",
    "  autolabos research verify-pack --root <paper-readiness-bundle-dir>"
  ].join("\n") + "\n");
}

async function main(): Promise<void> {
  const action = resolveCliAction(process.argv.slice(2));

  if (action.kind === "reference-review-prepare") {
    await runReferenceClaimReviewPreparationCli({
      cwd: process.cwd(),
      claimsPath: action.claimsPath,
      statusPath: action.statusPath,
      lockPath: action.lockPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "reference-review-preflight") {
    await runReferenceClaimReviewPreflightCli({
      cwd: process.cwd(),
      packetRoot: action.packetRoot,
      reviewPath: action.reviewPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "reference-review-distribute-private") {
    await runReferenceClaimReviewPrivateDistributionCli({
      cwd: process.cwd(),
      packetRoot: action.packetRoot,
      sourceDir: action.sourceDir,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "help") {
    printHelp();
    return;
  }

  if (action.kind === "audit-help") {
    printAuditHelp();
    return;
  }

  if (action.kind === "research-help") {
    printResearchHelp();
    return;
  }

  if (action.kind === "version") {
    process.stdout.write(`autolabos ${getAppVersion()}\n`);
    return;
  }

  if (action.kind === "error") {
    process.stderr.write(`${action.message}\n`);
    process.exitCode = 1;
    return;
  }

  if (action.kind === "web") {
    await runAutoLabOSWebServer({
      cwd: process.cwd(),
      host: action.host,
      port: action.port,
      benchmarkCondition: action.benchmarkCondition
    });
    return;
  }

  if (action.kind === "compare-analysis") {
    await runCompareAnalysisCli({
      cwd: process.cwd(),
      runId: action.runId,
      limit: action.limit,
      judge: action.judge
    });
    return;
  }

  if (action.kind === "eval-harness") {
    await runEvalHarnessCli({
      cwd: process.cwd(),
      runIds: action.runIds,
      limit: action.limit,
      outputPath: action.outputPath,
      noHistory: action.noHistory
    });
    return;
  }

  if (action.kind === "evolve") {
    await runEvolveCli({
      cwd: process.cwd(),
      maxCycles: action.maxCycles,
      target: action.target,
      dryRun: action.dryRun
    });
    return;
  }

  if (action.kind === "audit") {
    await runPaperReadinessAuditCli({
      cwd: process.cwd(),
      runRoot: action.runRoot,
      externalRoot: action.externalRoot,
      draftPath: action.draftPath,
      logPath: action.logPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "research-new") {
    await runResearchNewCli({ cwd: process.cwd(), briefPath: action.briefPath, outDir: action.outDir });
    return;
  }

  if (action.kind === "research-audit") {
    await runResearchAuditCli({
      cwd: process.cwd(),
      runRoot: action.runRoot,
      externalRoot: action.externalRoot,
      draftPath: action.draftPath,
      logPath: action.logPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "research-review") {
    await runResearchReviewCli({ cwd: process.cwd(), gatePath: action.gatePath, outDir: action.outDir });
    return;
  }

  if (action.kind === "research-improve") {
    await runResearchImproveCli({ cwd: process.cwd(), reviewPath: action.reviewPath, outDir: action.outDir });
    return;
  }

  if (action.kind === "research-pack") {
    await runResearchPackCli({
      cwd: process.cwd(),
      gatePath: action.gatePath,
      reviewPath: action.reviewPath,
      sourceDir: action.sourceDir,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "research-pack-verify") {
    await runResearchPackVerificationCli({ cwd: process.cwd(), bundleRoot: action.bundleRoot });
    return;
  }

  if (action.kind === "governance-benchmark-seed") {
    await runGovernanceBenchmarkSeedCli({
      cwd: process.cwd(),
      sourcePath: action.sourcePath,
      taskId: action.taskId,
      outDir: action.outDir,
      referenceOnly: action.referenceOnly
    });
    return;
  }

  if (action.kind === "governance-benchmark-dry-run") {
    await runGovernanceBenchmarkDryRunCli({
      cwd: process.cwd(),
      seedPath: action.seedPath,
      taskId: action.taskId,
      outDir: action.outDir,
      conditions: action.conditions
    });
    return;
  }

  if (action.kind === "governance-benchmark-batch") {
    await runGovernanceBenchmarkBatchCli({
      cwd: process.cwd(),
      seedsRoot: action.seedsRoot,
      taskIds: action.taskIds,
      outDir: action.outDir,
      conditions: action.conditions
    });
    return;
  }

  if (action.kind === "governance-benchmark-export-bundles") {
    await runGovernanceBenchmarkExportBundlesCli({
      cwd: process.cwd(),
      publicOutputRoots: action.publicOutputRoots,
      outDir: action.outDir,
      maxBundles: action.maxBundles
    });
    return;
  }

  if (action.kind === "governance-benchmark-generate-promotion-development") {
    await runSyntheticPromotionCorpusCli({ cwd: process.cwd(), outDir: action.outDir });
    return;
  }

  if (action.kind === "governance-benchmark-audit-promotion-source-expansion") {
    await runPromotionSourceExpansionAuditCli({
      cwd: process.cwd(),
      inventoryPath: action.inventoryPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-export-promotion-trial-candidates") {
    await runPromotionTrialCandidateHandoffExportCli({
      cwd: process.cwd(),
      recipePath: action.recipePath,
      sourceRoot: action.sourceRoot,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-prepare-promotion-trial-candidate-review-campaign") {
    await runPromotionTrialCandidateReviewCampaignCli({
      cwd: process.cwd(),
      handoffRoot: action.handoffRoot,
      annotatorIds: action.annotatorIds,
      licenseReviewerId: action.licenseReviewerId,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-collect-promotion-trial-candidate-review-campaign") {
    await runPromotionTrialCandidateReviewCampaignCollectionCli({
      cwd: process.cwd(),
      campaignRoot: action.campaignRoot,
      handoffRoot: action.handoffRoot,
      annotationPaths: action.annotationPaths,
      licenseReviewPath: action.licenseReviewPath,
      resolutionPath: action.resolutionPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-prepare-promotion-trial-candidate-worksheet") {
    await runPromotionTrialCandidateAnnotationWorksheetCli({
      cwd: process.cwd(),
      handoffRoot: action.handoffRoot,
      annotatorId: action.annotatorId,
      outputPath: action.outputPath
    });
    return;
  }

  if (action.kind === "governance-benchmark-prepare-promotion-trial-candidate-license-worksheet") {
    await runPromotionTrialCandidateLicenseReviewWorksheetCli({
      cwd: process.cwd(),
      handoffRoot: action.handoffRoot,
      reviewerId: action.reviewerId,
      outputPath: action.outputPath
    });
    return;
  }

  if (action.kind === "governance-benchmark-preflight-promotion-trial-candidate-annotation") {
    await runPromotionTrialCandidateAnnotationPreflightCli({
      cwd: process.cwd(),
      reviewerRoot: action.reviewerRoot,
      annotationPath: action.annotationPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-preflight-promotion-trial-candidate-license-review") {
    await runPromotionTrialCandidateLicenseReviewPreflightCli({
      cwd: process.cwd(),
      licenseRoot: action.licenseRoot,
      reviewPath: action.reviewPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-adjudicate-promotion-trial-candidate-review") {
    await runPromotionTrialCandidateReviewAdjudicationCli({
      cwd: process.cwd(),
      handoffRoot: action.handoffRoot,
      annotationPaths: action.annotationPaths,
      licenseReviewPath: action.licenseReviewPath,
      resolutionPath: action.resolutionPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-prepare-promotion-canonical-curation") {
    await runPromotionCanonicalCurationHandoffCli({
      cwd: process.cwd(),
      handoffRoot: action.handoffRoot,
      campaignReturnRoot: action.campaignReturnRoot,
      curatorId: action.curatorId,
      verifierId: action.verifierId,
      curatorProtocolVersion: action.curatorProtocolVersion,
      verifierProtocolVersion: action.verifierProtocolVersion,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-collect-promotion-canonical-curation") {
    await runPromotionCanonicalCurationReturnCollectionCli({
      cwd: process.cwd(),
      curationHandoffRoot: action.curationHandoffRoot,
      sourceRoots: action.sourceRoots,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-project-promotion-source") {
    await runPromotionSourceProjectionCli({
      cwd: process.cwd(),
      sourceRoot: action.sourceRoot,
      recipePath: action.recipePath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-export-promotion-source-normalization") {
    await runPromotionSourceNormalizationPackExportCli({
      cwd: process.cwd(),
      sourceRoot: action.sourceRoot,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-export-promotion-source-normalization-batch") {
    await runPromotionSourceNormalizationBatchExportCli({
      cwd: process.cwd(),
      recipePath: action.recipePath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-preflight-promotion-source-normalization-annotation") {
    await runPromotionSourceNormalizationAnnotationPreflightCli({
      cwd: process.cwd(),
      reviewerRoot: action.reviewerRoot,
      annotationPath: action.annotationPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-adjudicate-promotion-source-normalization-batch") {
    await runPromotionSourceNormalizationBatchAdjudicationCli({
      cwd: process.cwd(),
      batchRoot: action.batchRoot,
      annotationPaths: action.annotationPaths,
      resolutionPath: action.resolutionPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-materialize-promotion-source-normalization-batch") {
    await runPromotionSourceNormalizationBatchMaterializationCli({
      cwd: process.cwd(),
      adjudicationRoot: action.adjudicationRoot,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-normalize-promotion-source") {
    await runPromotionSourceNormalizationCli({
      cwd: process.cwd(),
      sourceRoot: action.sourceRoot,
      privateMapPath: action.privateMapPath,
      annotationPaths: action.annotationPaths,
      resolutionPath: action.resolutionPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-prepare-promotion-execution-evidence") {
    await runPromotionExecutionEvidencePreparationCli({
      cwd: process.cwd(),
      sourceRoot: action.sourceRoot,
      runId: action.runId,
      executionBackend: action.executionBackend,
      startedAt: action.startedAt,
      completedAt: action.completedAt,
      trialIds: action.trialIds,
      artifacts: action.artifacts
    });
    return;
  }

  if (action.kind === "governance-benchmark-audit-promotion-confirmatory") {
    await runPromotionConfirmatoryAuditCli({
      cwd: process.cwd(),
      manifestPath: action.manifestPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-freeze-promotion-confirmatory") {
    await runPromotionConfirmatoryFreezeCli({
      cwd: process.cwd(),
      manifestPath: action.manifestPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-gate-promotion-confirmatory") {
    await runPromotionConfirmatoryGateCli({
      cwd: process.cwd(),
      suitePath: action.suitePath,
      predictionsPath: action.predictionsPath,
      systemRunManifestPath: action.systemRunManifestPath,
      providerRunManifestPaths: action.providerRunManifestPaths,
      recoveryManifestPath: action.recoveryManifestPath,
      systemRoles: action.systemRoles,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-export-promotion-development-evidence") {
    await runPromotionDevelopmentEvidenceExportCli({
      cwd: process.cwd(),
      corpusManifestPath: action.corpusManifestPath,
      suitePath: action.suitePath,
      predictionsPath: action.predictionsPath,
      systemRunManifestPath: action.systemRunManifestPath,
      scoreReportPath: action.scoreReportPath,
      gateReportPath: action.gateReportPath,
      recommendationsPath: action.recommendationsPath,
      outputPath: action.outputPath
    });
    return;
  }

  if (action.kind === "governance-benchmark-build-promotion") {
    await runPromotionBenchmarkBuildCli({
      cwd: process.cwd(),
      recipePath: action.recipePath,
      freezeManifestPath: action.freezeManifestPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-run-promotion") {
    await runPromotionBenchmarkSystemsCli({
      cwd: process.cwd(),
      suitePath: action.suitePath,
      systems: action.systems,
      trialId: action.trialId,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-run-promotion-provider") {
    await runPromotionProviderCli({
      cwd: process.cwd(),
      suitePath: action.suitePath,
      provider: action.provider,
      model: action.model,
      reasoningEffort: action.reasoningEffort,
      systemId: action.systemId,
      trialId: action.trialId,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-aggregate-promotion-provider-runs") {
    await runPromotionProviderAggregationCli({
      cwd: process.cwd(),
      suitePath: action.suitePath,
      runManifestPaths: action.runManifestPaths,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-export-promotion-prompts") {
    await runPromotionPromptPackExportCli({
      cwd: process.cwd(),
      suitePath: action.suitePath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-import-promotion-responses") {
    await runPromotionResponseImportCli({
      cwd: process.cwd(),
      requestMapPath: action.requestMapPath,
      responsesPath: action.responsesPath,
      systemId: action.systemId,
      trialId: action.trialId,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-export-promotion-annotations") {
    await runPromotionAnnotationPackExportCli({
      cwd: process.cwd(),
      suitePath: action.suitePath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-export-promotion-mutation-audit") {
    await runPromotionMutationAuditPackExportCli({
      cwd: process.cwd(),
      suitePath: action.suitePath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-verify-promotion-mutations") {
    await runPromotionMutationAuditVerificationCli({
      cwd: process.cwd(),
      suitePath: action.suitePath,
      privateMapPath: action.privateMapPath,
      auditPaths: action.auditPaths,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-adjudicate-promotion") {
    await runPromotionAdjudicationCli({
      cwd: process.cwd(),
      suitePath: action.suitePath,
      privateMapPath: action.privateMapPath,
      annotationPaths: action.annotationPaths,
      resolutionPath: action.resolutionPath,
      mutationAuditReportPath: action.mutationAuditReportPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-analyze-promotion-failures") {
    await runPromotionFailureAnalysisCli({
      cwd: process.cwd(),
      suitePath: action.suitePath,
      predictionsPath: action.predictionsPath,
      systemId: action.systemId,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "governance-benchmark-score-promotion") {
    await runPromotionBenchmarkScoreCli({
      cwd: process.cwd(),
      suitePath: action.suitePath,
      predictionsPath: action.predictionsPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "meta-harness") {
    await runMetaHarnessCli({
      cwd: process.cwd(),
      runs: action.runs,
      nodes: action.nodes,
      externalRunRoots: action.externalRunRoots,
      noApply: action.noApply,
      dryRun: action.dryRun
    });
    return;
  }

  await runAutoLabOSApp({
    packageName: action.kind === "run" ? action.packageName : undefined,
    benchmarkCondition: action.kind === "run" ? action.benchmarkCondition : undefined
  });
}

function formatFatalError(error: unknown): string {
  const debug = process.env.AUTOLABOS_DEBUG === "1";
  const raw = error instanceof Error
    ? debug ? error.stack || error.message : error.message
    : String(error);
  const cwd = process.cwd();
  return cwd.length > path.parse(cwd).root.length ? raw.replaceAll(cwd, "<workspace>") : raw;
}

runWithProcessLifetime(main).catch((error) => {
  process.stderr.write(`${formatFatalError(error)}\n`);
  process.exitCode = 1;
});
