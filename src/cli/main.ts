#!/usr/bin/env node
import path from "node:path";

import { runAutoLabOSApp } from "../app.js";
import { resolveCliAction } from "./args.js";
import {
  WEB_AUTH_SECRET_ENV,
  WEB_AUTH_USERNAME,
  WEB_TRUSTED_ORIGIN_ENV,
  runAutoLabOSWebServer
} from "../web/server.js";
import { runCompareAnalysisCli } from "./compareAnalysis.js";
import { runEvalHarnessCli } from "./evalHarness.js";
import { runReviewReasoningBenchmarkCli } from "./reviewReasoningBenchmark.js";
import { runEvolveCli } from "./evolveRun.js";
import { runPaperReadinessAuditCli } from "./audit.js";
import { resolvePortableExternalAuditOutputDir } from "../core/audit/externalArtifactIntake.js";
import { runMetaHarnessCli } from "./metaHarness.js";
import { getAppVersion } from "../tui/version.js";
import {
  runResearchAuditCli,
  runResearchImproveCli,
  runResearchNewCli,
  runResearchMilestoneVerificationCli,
  runResearchValidationCli,
  runResearchPackCli,
  runResearchPackVerificationCli,
  runResearchReviewCli
} from "./research.js";
import { runWithProcessLifetime } from "./processLifetime.js";
import {
  runReferenceClaimReviewImportCli,
  runReferenceClaimReviewPreparationCli,
  runReferenceClaimReviewPrivatePackageCli,
  runReferenceClaimReviewPrivatePackageVerificationCli,
  runReferenceClaimReviewPrivateDistributionCli,
  runReferenceClaimReviewWorkspaceAuditCli,
  runReferenceClaimReviewWorkspaceFinalizationCli,
  runReferenceClaimReviewWorkspacePreparationCli,
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
    `  Non-loopback web hosts require ${WEB_AUTH_SECRET_ENV} (16+ UTF-8 bytes). Browser username: ${WEB_AUTH_USERNAME}.`,
    "  HTTP Basic authentication does not encrypt traffic; use TLS or a trusted tunnel outside a trusted local network.",
    `  For an HTTPS tunnel, set ${WEB_TRUSTED_ORIGIN_ENV} to the exact browser-facing origin.`,
    "  autolabos compare-analysis --run <run-id> [--limit 3] [--no-judge]",
    "  autolabos eval-harness [--run <run-id>] [--limit 10] [--output outputs/eval-harness/latest.json] [--no-history]",
    "  autolabos review-benchmark [--provider codex|openai] [--model <model>] [--effort high|xhigh|max] [--repetitions 3] [--split development|test] [--output <dir>] [--dry-run]",
    "  autolabos evolve [--max-cycles 3] [--target skills|prompts|all] [--dry-run]",
    "  autolabos audit (--run <run-artifact-root> | --external <artifact-root> [--draft <draft.md>] [--log <run.log>] [--support-root <root> --support-manifest <manifest.json>]) [--out-dir outputs/audit]",
    "  autolabos research <new|audit|review|improve|pack|verify-pack|verify-milestone|run-validation> [options]",
    "  autolabos reference-review prepare --claims <refgate_claims.tsv> --status <reference-evidence-status.json> --lock <refgate.lock.json> --out-dir <new-handoff-dir>",
    "  autolabos reference-review distribute-private --packet <handoff-dir> --source-dir <citation-key-named-full-text-dir> --out-dir <new-private-distribution-dir>",
    "  autolabos reference-review package-private --distribution <private-distribution-dir> --out-dir <new-private-package-dir>",
    "  autolabos reference-review verify-private-package --package <private-package-dir>",
    "  autolabos reference-review prepare-workspace --package <private-package-dir> --out-dir <new-private-workspace>",
    "  autolabos reference-review audit-workspace --workspace <private-workspace> --out-dir <new-audit-dir>",
    "  autolabos reference-review finalize-workspace --workspace <private-workspace> --output <completed-review.json>",
    "  autolabos reference-review preflight --packet <handoff-dir-or-private-distribution-dir> --review <completed-review.json> --out-dir <new-preflight-dir>",
    "  autolabos reference-review import --packet <handoff-dir-or-private-distribution-dir> --review <completed-review.json> --preflight <preflight-report.json> --approval <completed-final-approval.json> --claims <refgate_claims.tsv> --out-dir <new-import-dir>",
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
    "  autolabos audit --external <artifact-root> [--draft <draft.md>] [--log <run.log>] [--support-root <root> --support-manifest <manifest.json>] [--out-dir outputs/audit]",
    "",
    "Examples:",
    "  autolabos audit --run .autolabos/runs/<run-id> --out-dir outputs/audit/<run-id>",
    "  autolabos audit --external <external-artifact-root> --draft <draft.md> --log <run.log> --out-dir outputs/audit/external",
    "  autolabos audit --external <external-artifact-root> --support-root <root> --support-manifest <manifest.json> --out-dir outputs/audit/external",
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
    "  autolabos research audit (--run <run-root> | --external <artifact-root> [--draft <draft>] [--log <log>] [--support-root <root> --support-manifest <manifest.json>]) [--out-dir <dir>]",
    "  autolabos research review --gate <gate-report.json> [--model-review <model-review-bundle.json>] [--out-dir <dir>]",
    "  autolabos research improve --review <review-report.json> [--out-dir <dir>]",
    "  autolabos research pack --gate <gate-report.json> --review <review-report.json> [--source-dir <audit-artifact-dir>] [--out-dir <dir>]",
    "  autolabos research verify-pack --root <paper-readiness-bundle-dir>",
    "  autolabos research verify-milestone --contract <milestone.json> --out-dir <new-output-dir>",
    "  autolabos research run-validation --profile <validation-profile.json> --out-dir <new-output-dir>",
    "",
    "A2:",
    "  --model-review supplies an optional conservative critique bundle alongside the required gate."
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

  if (action.kind === "reference-review-import") {
    await runReferenceClaimReviewImportCli({
      cwd: process.cwd(),
      packetRoot: action.packetRoot,
      reviewPath: action.reviewPath,
      preflightReportPath: action.preflightReportPath,
      approvalPath: action.approvalPath,
      claimsPath: action.claimsPath,
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

  if (action.kind === "reference-review-package-private") {
    await runReferenceClaimReviewPrivatePackageCli({
      cwd: process.cwd(),
      distributionRoot: action.distributionRoot,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "reference-review-verify-private-package") {
    await runReferenceClaimReviewPrivatePackageVerificationCli({
      cwd: process.cwd(),
      packageRoot: action.packageRoot
    });
    return;
  }

  if (action.kind === "reference-review-prepare-workspace") {
    await runReferenceClaimReviewWorkspacePreparationCli({
      cwd: process.cwd(),
      packageRoot: action.packageRoot,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "reference-review-audit-workspace") {
    await runReferenceClaimReviewWorkspaceAuditCli({
      cwd: process.cwd(),
      workspaceRoot: action.workspaceRoot,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "reference-review-finalize-workspace") {
    await runReferenceClaimReviewWorkspaceFinalizationCli({
      cwd: process.cwd(),
      workspaceRoot: action.workspaceRoot,
      outputPath: action.outputPath
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

  if (action.kind === "review-benchmark") {
    await runReviewReasoningBenchmarkCli({
      cwd: process.cwd(),
      provider: action.provider,
      model: action.model,
      efforts: action.efforts.length > 0 ? action.efforts : undefined,
      repetitions: action.repetitions,
      split: action.split,
      outputDir: action.outputDir,
      dryRun: action.dryRun
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
    const cwd = process.cwd();
    if (action.externalRoot && action.outDir) {
      resolvePortableExternalAuditOutputDir(cwd, action.outDir);
    }
    await runPaperReadinessAuditCli({
      cwd,
      runRoot: action.runRoot,
      externalRoot: action.externalRoot,
      draftPath: action.draftPath,
      logPath: action.logPath,
      supportRoot: action.supportRoot,
      supportManifestPath: action.supportManifestPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "research-new") {
    await runResearchNewCli({ cwd: process.cwd(), briefPath: action.briefPath, outDir: action.outDir });
    return;
  }

  if (action.kind === "research-audit") {
    const cwd = process.cwd();
    if (action.externalRoot && action.outDir) {
      resolvePortableExternalAuditOutputDir(cwd, action.outDir);
    }
    await runResearchAuditCli({
      cwd,
      runRoot: action.runRoot,
      externalRoot: action.externalRoot,
      draftPath: action.draftPath,
      logPath: action.logPath,
      supportRoot: action.supportRoot,
      supportManifestPath: action.supportManifestPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "research-review") {
    await runResearchReviewCli({
      cwd: process.cwd(),
      gatePath: action.gatePath,
      modelReviewBundlePath: action.modelReviewBundlePath,
      outDir: action.outDir
    });
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

  if (action.kind === "research-milestone-verify") {
    await runResearchMilestoneVerificationCli({
      cwd: process.cwd(),
      contractPath: action.contractPath,
      outDir: action.outDir
    });
    return;
  }

  if (action.kind === "research-validation-run") {
    await runResearchValidationCli({
      cwd: process.cwd(),
      profilePath: action.profilePath,
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
