import path from "node:path";
import { promises as fs } from "node:fs";

import { RunContextMemory } from "../memory/runContextMemory.js";
import { GraphNodeHandler } from "../stateGraph/types.js";
import { appendJsonl, writeRunArtifact } from "./helpers.js";
import { publishPublicRunOutputs, PublishPublicRunOutputsResult } from "../publicOutputPublisher.js";
import {
  resolveRunCommand,
  resolveRunCommandGpuRequestMetadata
} from "./runCommandResolver.js";
import { NodeExecutionDeps } from "./types.js";
import { fileExists } from "../../utils/fs.js";
import {
  evaluateObjectiveMetric,
  ObjectiveMetricEvaluation,
  ObjectiveMetricProfile,
  resolveObjectiveMetricProfile
} from "../objectiveMetric.js";
import {
  buildCrashLedgerEntry,
  EXPERIMENT_GOVERNANCE_CONTRACT_KEY,
  freezeManagedBundleLock,
  getGovernedObjectiveProfile,
  loadExperimentComparisonContract,
  loadExperimentImplementationContext,
  storeExperimentGovernanceDecision
} from "../experimentGovernance.js";
import { RunVerifierReport, RunVerifierTrigger } from "../experiments/runVerifierFeedback.js";
import {
  detectLongRunningPythonBudgetGuardFailure,
  inferRequiredRunCountFromPythonSource
} from "../experiments/pythonRunnerBudgetGuard.js";
import { detectPreflightOnlyMetrics } from "../experiments/executedMetrics.js";
import { FailureMemory, buildErrorFingerprint } from "../experiments/failureMemory.js";
import {
  loadExperimentContract,
  type ExperimentContract
} from "../experiments/experimentContract.js";
import {
  buildExperimentRunManifest,
  BuildExperimentRunManifestTrialGroupExecution,
  buildFallbackExperimentPortfolio,
  ExperimentPortfolio,
  ExperimentPortfolioTrialGroup,
  ExperimentPortfolioSamplingProfile
} from "../experiments/experimentPortfolio.js";
import {
  buildRunExperimentsExecutionPlan,
  classifyRunExperimentsFailure,
  createRunExperimentsWatchdogState,
  decideRunExperimentsRerun,
  finalizeRunExperimentsTriage,
  recordSupplementalOutputs,
  RunExperimentsExecutionPlan,
  RunExperimentsRerunDecision,
  RunExperimentsTriageAttempt,
  setSentinelFindings,
  setMetricsState
} from "../runExperimentsPanel.js";
import { wrapCommandForExecutionProfile } from "../../runtime/executionProfile.js";
import { parseMarkdownRunBriefSections, type MarkdownRunBriefSections } from "../runs/runBriefParser.js";
import {
  loadResearchBriefSnapshot,
  resolveResearchRunModeGuard,
  type ResearchEvidenceStage
} from "../runs/researchRunModeGuard.js";
import {
  countExecutedPlannedConditions,
  deriveRequiredPlannedConditionCount
} from "../analysis/plannedConditionCoverage.js";
import { buildIntermediateArtifactCaptureManifest } from "../artifacts/intermediateArtifactCapture.js";
import {
  checkResultsContractCompleteness,
  validateResultsArtifactV2,
  type ResultsArtifactV2,
  type ResultsComparisonV2,
  type ResultsMetricDefinitionV2,
  type ResultsObservationV2,
  type ResultsSeriesRole,
  type ResultsSeriesV2
} from "../analysis/resultsTableSchema.js";
import {
  validateActiveTopicProbeContract
} from "../activeTopicProbeContract.js";
import { resolveTopicProbeComputeContractSource } from "../topicProbeComputeContractSource.js";
import {
  loadTopicProbeExecutionAuthorizationGate,
  TOPIC_PROBE_EXECUTION_AUTHORIZATION_GATE_RELATIVE_PATH
} from "../runs/topicProbeExecutionAuthorizationGate.js";
import {
  appendTopicProbeComputeActualUsage,
  appendTopicProbeComputePreflight,
  appendTopicProbeComputeUnverifiableUsage,
  buildTopicProbeComputeBudgetContract,
  parseTopicProbeComputeBudgetCeilingFromBrief,
  parseTopicProbeComputeUsageEvidence,
  sha256Utf8,
  topicProbeComputeBudgetLimitsEqual,
  validateTopicProbeComputeUsageLedger,
  type TopicProbeComputeBudgetContract
} from "../topicProbeComputeBudget.js";
type SupplementalProfileName = "quick_check" | "confirmatory";

interface ManagedSupplementalProfile {
  profile: SupplementalProfileName;
  command: string;
  metricsPath: string;
  workingDir: string;
}

interface ManagedSupplementalPlan {
  kind: "managed_bundle" | "compatibility_python_runner";
  publicDir: string;
  profiles: [ManagedSupplementalProfile, ManagedSupplementalProfile];
}

interface SupplementalRunRecord {
  profile: SupplementalProfileName;
  status: "pass" | "fail" | "skipped";
  command?: string;
  cwd?: string;
  metrics_path: string;
  summary: string;
  exit_code?: number;
  log_file?: string;
  objective_evaluation?: ObjectiveMetricEvaluation;
  sampling_profile?: ExperimentPortfolioSamplingProfile;
  compute_budget_blocked?: boolean;
}

interface SupplementalExpectationArtifact {
  applicable: boolean;
  profiles: string[];
  reason?: string;
}

interface TopicProbeComputeGovernor {
  contract: TopicProbeComputeBudgetContract;
  ledgerPath: string;
  estimatedWallTimeMs: number;
  estimatedGpuCount: number;
  enforceEnvironmentGpuLimit: boolean;
  estimatedFreshTrials?: number;
  supplementalEstimatedFreshTrials: Partial<Record<SupplementalProfileName, number>>;
}

interface ManagedMatrixSliceArtifact {
  version: 1;
  run_id: string;
  trial_group_id: string;
  source_trial_group_id: string;
  generated_at: string;
  execution_model: "managed_bundle";
  runner_profile?: string;
  dataset: string;
  source_metrics_path?: string;
  command?: string;
  cwd?: string;
  sampling_profile?: ExperimentPortfolioSamplingProfile;
  condition_metrics: Record<string, unknown>;
  comparison: Record<string, unknown>;
  diagnostics?: Array<{ code: string; message: string }>;
  summary: string;
}

export function createRunExperimentsNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "run_experiments",
    async execute({ run, abortSignal }) {
      const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
      const comparisonContract = await loadExperimentComparisonContract(run, runContext);
      const experimentContract = await loadExperimentContract(run.id);
      const implementationContext = await loadExperimentImplementationContext(run, runContext);
      const memoryRawBrief = await runContext.get<string>("run_brief.raw");
      const snapshotBrief = await loadResearchBriefSnapshot(process.cwd(), run.id);
      const researchModeGuard = await resolveResearchRunModeGuard({
        workspaceRoot: process.cwd(),
        runId: run.id,
        rawBrief: memoryRawBrief,
        run,
        expectedResearchCycle: run.graph.researchCycle,
        requireActiveBoundedProbeLineage: true
      });
      const rawBrief = memoryRawBrief || snapshotBrief;
      await runContext.put("research_governance.mode_guard", researchModeGuard);
      await writeRunArtifact(
        run,
        "governance/research_mode_guard.json",
        `${JSON.stringify(researchModeGuard, null, 2)}\n`
      );
      if (!researchModeGuard.valid) {
        const error =
          "run_experiments blocked because the persisted research mode and evidence lineage do not agree: "
          + researchModeGuard.reasons.join(", ");
        return {
          status: "failure",
          error,
          summary: error,
          toolCallsUsed: 0
        };
      }
      const briefSections = rawBrief ? parseMarkdownRunBriefSections(rawBrief) : undefined;
      const pendingHandoff =
        (await runContext.get<boolean>("implement_experiments.pending_handoff_to_run_experiments")) === true;
      const handoffReason = await runContext.get<string>("implement_experiments.handoff_reason");
      const trigger: RunVerifierTrigger = pendingHandoff ? "auto_handoff" : "manual";
      const experimentMode =
        (await runContext.get<string>("implement_experiments.mode")) || "real_execution";
      const managedSupplementalPlan = await resolveManagedSupplementalPlan(runContext, process.cwd());
      const loadedExperimentPortfolio = await loadExperimentPortfolio(run.id);
      const experimentPortfolio =
        loadedExperimentPortfolio ||
        buildFallbackExperimentPortfolio({
          runId: run.id,
          executionModel: managedSupplementalPlan?.kind || "single_run",
          supplementalProfiles: managedSupplementalPlan?.profiles.map((profile) => ({
            profile: profile.profile
          }))
        });
      if (!loadedExperimentPortfolio) {
        await writeRunArtifact(run, "experiment_portfolio.json", JSON.stringify(experimentPortfolio, null, 2));
      }
      await runContext.put("run_experiments.trigger", trigger);
      await runContext.put("run_experiments.handoff_reason", handoffReason || null);
      await runContext.put("run_experiments.supplemental_runs", []);
      await runContext.put("run_experiments.supplemental_summary", null);
      await runContext.put("run_experiments.triage", null);
      await runContext.put("run_experiments.portfolio", null);
      await runContext.put("run_experiments.run_manifest", null);

      if (deps.executionProfile === "plan_only") {
        const summary = "Skipped code execution because the detected execution profile is plan_only.";
        const report = buildRunVerifierReport({
          status: "skipped",
          trigger,
          stage: "policy",
          summary,
          suggestedNextAction: "Switch to a local, docker, or remote execution environment before retrying run_experiments."
        });
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            text: summary
          }
        });
        await persistRunVerifierReport(run, runContext, report);
        return {
          status: "skipped",
          reason: "plan_only_mode",
          summary,
          toolCallsUsed: 0
        };
      }

      if (researchModeGuard.effectiveMode === "topic_discovery") {
        const executionAuthorizationGate = await loadTopicProbeExecutionAuthorizationGate({
          workspaceRoot: process.cwd(),
          runId: run.id,
          expectedResearchCycle: run.graph.researchCycle
        });
        await runContext.put(
          "research_governance.topic_probe_execution_authorization",
          executionAuthorizationGate
        );
        await writeRunArtifact(
          run,
          TOPIC_PROBE_EXECUTION_AUTHORIZATION_GATE_RELATIVE_PATH,
          `${JSON.stringify(executionAuthorizationGate, null, 2)}\n`
        );
        if (!executionAuthorizationGate.effective_execution_authorized) {
          const message =
            "topic_probe_execution_preflight_blocked:"
            + executionAuthorizationGate.authorization.reason_codes.join(",");
          return {
            status: "failure",
            failureKind: "gate_blocked",
            error: message,
            summary: message,
            toolCallsUsed: 0
          };
        }
      }

      let topicProbeComputeGovernor: TopicProbeComputeGovernor | undefined;

      const defaultMetricsPath = path.join(process.cwd(), ".autolabos", "runs", run.id, "metrics.json");
      const failureMemory = FailureMemory.forRun(run.id);
      const triageAttempts: RunExperimentsTriageAttempt[] = [];
      let executionPlan: RunExperimentsExecutionPlan | undefined;
      let rerunDecision: RunExperimentsRerunDecision = {
        decision: "not_needed",
        reason: "No automatic rerun was required."
      };
      let watchdog = createRunExperimentsWatchdogState({
        metricsPath: defaultMetricsPath
      });
      const persistPanelState = async () => {
        await persistRunPanelArtifacts({
          run,
          runContext,
          executionPlan,
          triageAttempts,
          watchdog,
          rerunDecision
        });
      };

      // --- Failure memory: check for do-not-retry before starting ---
      const latestDoNotRetry = await failureMemory.latestDoNotRetry("run_experiments");
      const priorDoNotRetry = Boolean(latestDoNotRetry);
      if (priorDoNotRetry) {
        const retryCount = run.graph.retryCounters.run_experiments ?? 0;
        const upstreamRepairUpdatedAt = run.graph.nodeStates.implement_experiments?.updatedAt;
        const upstreamRepairIsNewer = Boolean(
          latestDoNotRetry?.timestamp &&
            upstreamRepairUpdatedAt &&
            Date.parse(upstreamRepairUpdatedAt) > Date.parse(latestDoNotRetry.timestamp)
        );
        const harnessRepairUpdatedAt = await currentRunExperimentsHarnessUpdatedAt();
        const harnessRepairIsNewer = Boolean(
          latestDoNotRetry?.timestamp &&
            harnessRepairUpdatedAt !== undefined &&
            harnessRepairUpdatedAt > Date.parse(latestDoNotRetry.timestamp)
        );
        if (retryCount > 0 && !upstreamRepairIsNewer && !harnessRepairIsNewer) {
          const summary =
            "Failure memory marks run_experiments as do-not-retry after a structural execution failure; blocking another same-node retry until upstream repair is applied.";
          deps.eventStream.emit({
            type: "OBS_RECEIVED",
            runId: run.id,
            node: "run_experiments",
            payload: { text: summary }
          });
          return {
            status: "failure",
            error: summary,
            summary,
            toolCallsUsed: 0
          };
        }
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "run_experiments",
          payload: {
            text: "Failure memory contains a do-not-retry marker for run_experiments; proceeding because an upstream or harness repair is newer than the latest failure marker."
          }
        });
      }

      /** Record a failure to the run-scoped failure memory JSONL. */
      const recordRunFailure = async (
        errorMsg: string,
        failureClass: "transient" | "structural" | "equivalent" | "resource" | "unknown"
      ) => {
        const fingerprint = buildErrorFingerprint(errorMsg);
        const equivalentCount = await failureMemory.countEquivalentFailures("run_experiments", fingerprint);
        const doNotRetry = failureClass === "structural" || equivalentCount >= 2;
        await failureMemory.append({
          run_id: run.id,
          node_id: "run_experiments",
          attempt: (run.graph.retryCounters.run_experiments ?? 0) + 1,
          failure_class: equivalentCount >= 2 ? "equivalent" : failureClass,
          error_fingerprint: fingerprint,
          error_message: errorMsg.slice(0, 1200),
          do_not_retry: doNotRetry,
          do_not_retry_reason: doNotRetry
            ? equivalentCount >= 2
              ? `Same failure pattern repeated ${equivalentCount + 1} times without improvement.`
              : "Structural failure unlikely to resolve without design change."
            : undefined
        });
      };

      if (pendingHandoff) {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            text: handoffReason
              ? `Starting second-stage verification from implement_experiments. ${handoffReason}`
              : "Starting second-stage verification from implement_experiments."
          }
        });
        await runContext.put("implement_experiments.pending_handoff_to_run_experiments", false);
      }
      const implementPublicDir = resolveMaybeRelative(
        await runContext.get<string>("implement_experiments.public_dir"),
        process.cwd()
      );
      const bootstrapContract = implementPublicDir
        ? await loadImplementBootstrapContract(implementPublicDir)
        : undefined;
      if (bootstrapContract?.requires_network) {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            text:
              bootstrapContract.summary ||
              "Bootstrap contract declares remote assets or services. This run will proceed as network-assisted if those assets are fetched on demand."
          }
        });
      }
      let clearedSupplementalOutputs: string[] = [];
      if (managedSupplementalPlan) {
        clearedSupplementalOutputs = await clearManagedSupplementalOutputs(run, managedSupplementalPlan.profiles);
        if (clearedSupplementalOutputs.length > 0) {
          deps.eventStream.emit({
            type: "OBS_RECEIVED",
            runId: run.id,
            node: "run_experiments",
            agentRole: "runner",
            payload: {
              text: `Cleared stale supplemental metrics before the standard run (${clearedSupplementalOutputs.join(", ")}).`
            }
          });
        }
      }
      watchdog = createRunExperimentsWatchdogState({
        metricsPath: defaultMetricsPath,
        clearedSupplementalOutputs
      });

      let resolved: Awaited<ReturnType<typeof resolveRunCommand>>;
      try {
        resolved = await resolveRunCommand(run, process.cwd());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        triageAttempts.push(
          classifyRunExperimentsFailure({
            attempt: 1,
            stage: "resolve",
            summary: message,
            metricsPath: defaultMetricsPath
          })
        );
        rerunDecision = decideRunExperimentsRerun({
          triage: triageAttempts[triageAttempts.length - 1],
          automaticRerunsUsed: 0
        });
        await persistPanelState();
        const report = buildRunVerifierReport({
          status: "fail",
          trigger,
          stage: "command",
          summary: message,
          suggestedNextAction:
            "Publish a runnable experiment command, script, or package.json experiment target before retrying."
        });
        deps.eventStream.emit({
          type: "TEST_FAILED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            stderr: message
          }
        });
        await persistRunVerifierReport(run, runContext, report);
        await persistRunFailureState(runContext, {
          error: message
        });
        await persistGovernanceCrash({
          run,
          runContext,
          comparisonContract,
          implementationContext,
          objectiveMetricName: run.objectiveMetric,
          rationale: report.summary,
          resourceUsage: {
            stage: "resolve"
          }
        });
        await recordRunFailure(message, "structural");
        return {
          status: "failure",
          error: message,
          toolCallsUsed: 0
        };
      }

      try {
        topicProbeComputeGovernor = await initializeTopicProbeComputeGovernor({
          run,
          researchModeGuard,
          comparisonContract,
          experimentPortfolio,
          managedSupplementalPlan,
          resolvedCommand: resolved,
          rawBrief,
          enforceEnvironmentGpuLimit: (deps.executionProfile || "local") === "local",
          configuredTimeoutSec: resolveRunExperimentsBudgetTimeoutSec(deps.config)
        });
      } catch (error) {
        const summary =
          "Topic-probe compute budget initialization blocked execution: " +
          (error instanceof Error ? error.message : String(error));
        await runContext.put("run_experiments.topic_probe_compute_budget_failure", {
          stage: "initialization",
          reasons: [summary]
        });
        return {
          status: "failure",
          error: summary,
          summary,
          toolCallsUsed: 0
        };
      }

      executionPlan = buildRunExperimentsExecutionPlan({
        trigger,
        command: wrapCommandForExecutionProfile({
          profile: deps.executionProfile || "local",
          command: resolved.command,
          cwd: resolved.cwd
        }),
        cwd: resolved.cwd,
        metricsPath: resolved.metricsPath,
        source: resolved.source,
        comparisonMode: comparisonContract?.comparison_mode,
        budgetProfile: comparisonContract?.budget_profile,
        evaluatorContractId: comparisonContract?.evaluator_contract_id,
        baselineCandidateIds: comparisonContract?.baseline_candidate_ids,
        testCommand: resolved.testCommand
          ? wrapCommandForExecutionProfile({
              profile: deps.executionProfile || "local",
              command: resolved.testCommand,
              cwd: resolved.testCwd || resolved.cwd
            })
          : undefined,
        testCwd: resolved.testCwd,
        portfolio: experimentPortfolio,
        supplementalProfiles: managedSupplementalPlan?.profiles.map((profile) => ({
          profile: profile.profile,
          command: wrapCommandForExecutionProfile({
            profile: deps.executionProfile || "local",
            command: profile.command,
            cwd: profile.workingDir
          }),
          metricsPath: profile.metricsPath
        }))
      });
      watchdog = createRunExperimentsWatchdogState({
        metricsPath: resolved.metricsPath,
        clearedSupplementalOutputs
      });
      await persistPanelState();

      const profiledTestCommand = resolved.testCommand
        ? wrapCommandForExecutionProfile({
            profile: deps.executionProfile || "local",
            command: resolved.testCommand,
            cwd: resolved.testCwd || resolved.cwd
          })
        : undefined;
      const preflightToolCallsUsed = profiledTestCommand ? 1 : 0;

      if (profiledTestCommand) {
        deps.eventStream.emit({
          type: "TOOL_CALLED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            command: profiledTestCommand,
            cwd: resolved.testCwd || resolved.cwd,
            source: "preflight_test"
          }
        });

        const testObs = await deps.aci.runTests(
          profiledTestCommand,
          resolved.testCwd || resolved.cwd,
          abortSignal
        );
        if (testObs.status !== "ok") {
          const policyBlock = extractPolicyBlock(testObs);
          triageAttempts.push(
            classifyRunExperimentsFailure({
              attempt: 1,
              stage: "preflight",
              summary: testObs.stderr || "Preflight tests failed",
              command: profiledTestCommand,
              cwd: resolved.testCwd || resolved.cwd,
              exitCode: testObs.exit_code ?? 1,
              policyBlocked: policyBlock.blocked
            })
          );
          rerunDecision = decideRunExperimentsRerun({
            triage: triageAttempts[triageAttempts.length - 1],
            automaticRerunsUsed: 0
          });
          await persistPanelState();
          const report = buildRunVerifierReport({
            status: "fail",
            trigger,
            stage: policyBlock.blocked ? "policy" : "preflight_test",
            summary: testObs.stderr || "Preflight tests failed",
            policyRuleId: policyBlock.ruleId,
            policyReason: policyBlock.reason,
            command: profiledTestCommand,
            cwd: resolved.testCwd || resolved.cwd,
            exitCode: testObs.exit_code ?? 1,
            stdout: testObs.stdout,
            stderr: testObs.stderr,
            suggestedNextAction: policyBlock.blocked
              ? "Replace the blocked preflight test with a policy-compliant local check before retrying."
              : "Repair the lightweight preflight test path or patch the experiment so the syntax/test command passes."
          });
          deps.eventStream.emit({
            type: "TEST_FAILED",
            runId: run.id,
            node: "run_experiments",
            agentRole: "runner",
            payload: {
              command: resolved.testCommand,
              stderr: testObs.stderr || "preflight tests failed"
            }
          });
          await persistRunVerifierReport(run, runContext, report);
          await persistRunFailureState(runContext, {
            command: resolved.testCommand,
            cwd: resolved.testCwd || resolved.cwd,
            exitCode: testObs.exit_code ?? 1,
            error: testObs.stderr || "preflight tests failed"
          });
          await persistGovernanceCrash({
            run,
            runContext,
            comparisonContract,
            implementationContext,
            objectiveMetricName: run.objectiveMetric,
            rationale: report.summary,
            resourceUsage: {
              stage: "preflight",
              command: resolved.testCommand,
              cwd: resolved.testCwd || resolved.cwd,
              exit_code: testObs.exit_code ?? 1
            }
          });
          await recordRunFailure(testObs.stderr || "Preflight tests failed", "transient");
          return {
            status: "failure",
            error: testObs.stderr || "Preflight tests failed",
            toolCallsUsed: 1
          };
        }
      }

      const previousMetricsBackup = await clearPreexistingMetricsOutput(run, resolved.metricsPath);
      if (previousMetricsBackup) {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            text: `Archived previous metrics output before execution to ${previousMetricsBackup}.`
          }
        });
        await runContext.put("run_experiments.previous_metrics_backup", previousMetricsBackup);
      } else {
        await runContext.put("run_experiments.previous_metrics_backup", null);
      }
      const restoreMetricsAfterRejectedAttempt = async (reason: string) => {
        const restoredPath = await restorePreexistingMetricsOutput({
          run,
          metricsPath: resolved.metricsPath,
          backupPath: previousMetricsBackup,
          reason
        });
        if (restoredPath) {
          deps.eventStream.emit({
            type: "OBS_RECEIVED",
            runId: run.id,
            node: "run_experiments",
            agentRole: "runner",
            payload: {
              text: `Restored previous metrics output after rejected attempt from ${restoredPath}.`
            }
          });
          await runContext.put("run_experiments.restored_previous_metrics_after_failure", restoredPath);
        }
      };
      const previousFailureArtifactBackups = await clearPreexistingExperimentFailureArtifacts(run, resolved.cwd);
      if (previousFailureArtifactBackups.length > 0) {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            text: `Archived stale experiment failure artifact(s) before execution to ${previousFailureArtifactBackups.join(", ")}.`
          }
        });
        await runContext.put("run_experiments.previous_failure_artifact_backups", previousFailureArtifactBackups);
      } else {
        await runContext.put("run_experiments.previous_failure_artifact_backups", null);
      }
      const previousEvidenceArtifactBackups = Array.from(new Set([
        ...(await clearPreexistingExperimentEvidenceArtifacts(run, resolved.cwd)),
        ...(await clearPreexistingExperimentEvidenceArtifacts(run, implementPublicDir))
      ]));
      if (previousEvidenceArtifactBackups.length > 0) {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            text: `Archived stale experiment evidence artifact(s) before execution to ${previousEvidenceArtifactBackups.join(", ")}.`
          }
        });
        await runContext.put("run_experiments.previous_evidence_artifact_backups", previousEvidenceArtifactBackups);
      } else {
        await runContext.put("run_experiments.previous_evidence_artifact_backups", null);
      }
      watchdog = createRunExperimentsWatchdogState({
        metricsPath: resolved.metricsPath,
        previousMetricsBackup,
        clearedSupplementalOutputs
      });
      let primaryCommand = shouldForceFreshManagedStandardRun({
        command: resolved.command,
        experimentMode,
        previousMetricsBackup
      })
        ? appendFreshFlag(resolved.command)
        : resolved.command;
      primaryCommand = await appendPythonTimeoutArgIfAccepted(
        primaryCommand,
        resolved.cwd,
        resolveRunExperimentsBudgetTimeoutSec(deps.config)
      );
      primaryCommand = await appendPythonOverwriteOutputArgIfAccepted(primaryCommand, resolved.cwd);
      primaryCommand = wrapCommandForExecutionProfile({
        profile: deps.executionProfile || "local",
        command: primaryCommand,
        cwd: resolved.cwd
      });
      primaryCommand = withModelDownloadEnvIfDeclared(primaryCommand, deps.config);
      if (executionPlan && executionPlan.command !== primaryCommand) {
        executionPlan = {
          ...executionPlan,
          command: primaryCommand
        };
        await persistPanelState();
      }

      const skeletonSurfaceIssue = await detectPythonRunnerSkeletonOnlySurface({
        runContext,
        command: primaryCommand,
        cwd: resolved.cwd,
        workspaceRoot: process.cwd()
      });
      if (skeletonSurfaceIssue) {
        const report = buildRunVerifierReport({
          status: "fail",
          trigger,
          stage: "preflight_test",
          summary: skeletonSurfaceIssue,
          command: primaryCommand,
          cwd: resolved.cwd,
          metricsPath: resolved.metricsPath,
          suggestedNextAction:
            "Regenerate the Python runner so the public command targets a runnable implementation instead of a canonical skeleton."
        });
        deps.eventStream.emit({
          type: "TEST_FAILED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            command: primaryCommand,
            metrics_path: resolved.metricsPath,
            stderr: skeletonSurfaceIssue
          }
        });
        await persistRunVerifierReport(run, runContext, report);
        await persistRunFailureState(runContext, {
          command: primaryCommand,
          cwd: resolved.cwd,
          error: skeletonSurfaceIssue
        });
        await persistGovernanceCrash({
          run,
          runContext,
          comparisonContract,
          implementationContext,
          objectiveMetricName: run.objectiveMetric,
          rationale: report.summary,
          resourceUsage: {
            stage: "preflight_python_runner_surface",
            command: primaryCommand,
            cwd: resolved.cwd,
            metrics_path: resolved.metricsPath
          }
        });
        await recordRunFailure(skeletonSurfaceIssue, "structural");
        return {
          status: "failure",
          error: skeletonSurfaceIssue,
          toolCallsUsed: preflightToolCallsUsed
        };
      }

      const progressSurfaceIssue = await detectLongRunningPythonRunnerWithoutProgressSurface({
        runContext,
        command: primaryCommand,
        cwd: resolved.cwd,
        workspaceRoot: process.cwd()
      });
      if (progressSurfaceIssue) {
        const report = buildRunVerifierReport({
          status: "fail",
          trigger,
          stage: "preflight_test",
          summary: progressSurfaceIssue,
          command: primaryCommand,
          cwd: resolved.cwd,
          metricsPath: resolved.metricsPath,
          suggestedNextAction:
            "Add node-owned progress, heartbeat, or partial-metrics artifacts for long-running experiment runners before executing the full command."
        });
        deps.eventStream.emit({
          type: "TEST_FAILED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            command: primaryCommand,
            metrics_path: resolved.metricsPath,
            stderr: progressSurfaceIssue
          }
        });
        await persistRunVerifierReport(run, runContext, report);
        await persistRunFailureState(runContext, {
          command: primaryCommand,
          cwd: resolved.cwd,
          error: progressSurfaceIssue
        });
        await persistGovernanceCrash({
          run,
          runContext,
          comparisonContract,
          implementationContext,
          objectiveMetricName: run.objectiveMetric,
          rationale: report.summary,
          resourceUsage: {
            stage: "preflight_progress_surface",
            command: primaryCommand,
            cwd: resolved.cwd,
            metrics_path: resolved.metricsPath
          }
        });
        await recordRunFailure(progressSurfaceIssue, "structural");
        return {
          status: "failure",
          error: progressSurfaceIssue,
          toolCallsUsed: preflightToolCallsUsed
        };
      }

      const budgetEnforcementIssue = await detectLongRunningPythonRunnerWithoutBudgetEnforcement({
        runContext,
        command: primaryCommand,
        cwd: resolved.cwd,
        workspaceRoot: process.cwd(),
        timeoutSec: resolveRunExperimentsBudgetTimeoutSec(deps.config)
      });
      if (budgetEnforcementIssue) {
        const report = buildRunVerifierReport({
          status: "fail",
          trigger,
          stage: "preflight_test",
          summary: budgetEnforcementIssue,
          command: primaryCommand,
          cwd: resolved.cwd,
          metricsPath: resolved.metricsPath,
          suggestedNextAction:
            "Make the generated runner consume its shared wall-clock deadline inside training and evaluation loops, then persist partial or timed-out run accounting before retrying."
        });
        deps.eventStream.emit({
          type: "TEST_FAILED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            command: primaryCommand,
            metrics_path: resolved.metricsPath,
            stderr: budgetEnforcementIssue
          }
        });
        await persistRunVerifierReport(run, runContext, report);
        await persistRunFailureState(runContext, {
          command: primaryCommand,
          cwd: resolved.cwd,
          error: budgetEnforcementIssue
        });
        await persistGovernanceCrash({
          run,
          runContext,
          comparisonContract,
          implementationContext,
          objectiveMetricName: run.objectiveMetric,
          rationale: report.summary,
          resourceUsage: {
            stage: "preflight_budget_enforcement",
            command: primaryCommand,
            cwd: resolved.cwd,
            metrics_path: resolved.metricsPath
          }
        });
        await recordRunFailure(budgetEnforcementIssue, "structural");
        return {
          status: "failure",
          error: budgetEnforcementIssue,
          toolCallsUsed: preflightToolCallsUsed
        };
      }

      let parsedMetrics: Record<string, unknown> = {};
      let objectiveEvaluationSummary = "";
      let obs: Awaited<ReturnType<NodeExecutionDeps["aci"]["runCommand"]>> | undefined;
      let logFile = "";
      let primaryAttemptsUsed = 0;
      let automaticRerunsUsed = 0;
      let latestCommandStartedAtMs: number | undefined;

      while (true) {
        const attemptNumber = primaryAttemptsUsed + 1;
        primaryAttemptsUsed += 1;
        const computePreflight = topicProbeComputeGovernor
          ? await appendTopicProbeComputePreflight({
              ledgerPath: topicProbeComputeGovernor.ledgerPath,
              contract: topicProbeComputeGovernor.contract,
              profile: attemptNumber === 1 ? "primary" : "primary_retry",
              command: primaryCommand,
              estimatedWallTimeMs:
                topicProbeComputeGovernor.estimatedWallTimeMs,
              estimatedGpuCount: topicProbeComputeGovernor.estimatedGpuCount,
              estimatedFreshTrials:
                topicProbeComputeGovernor.estimatedFreshTrials
            })
          : undefined;
        if (computePreflight && !computePreflight.allowed) {
          const summary = formatTopicProbeComputeBudgetFailure(
            computePreflight.reasons
          );
          await runContext.put(
            "run_experiments.topic_probe_compute_budget_failure",
            {
              stage: "preflight",
              reasons: computePreflight.reasons
            }
          );
          await recordRunFailure(summary, "resource");
          return {
            status: "failure",
            error: summary,
            summary,
            toolCallsUsed: preflightToolCallsUsed + primaryAttemptsUsed - 1
          };
        }
        deps.eventStream.emit({
          type: "TOOL_CALLED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            command: primaryCommand,
            cwd: resolved.cwd,
            source: primaryAttemptsUsed > 1 ? `${resolved.source}:retry_${attemptNumber}` : resolved.source
          }
        });

        const commandStartedAtMs = Date.now();
        latestCommandStartedAtMs = commandStartedAtMs;
        obs = await deps.aci.runCommand(primaryCommand, resolved.cwd, abortSignal);
        logFile = await writeRunArtifact(
          run,
          primaryAttemptsUsed === 1
            ? "exec_logs/run_experiments.txt"
            : `exec_logs/run_experiments_retry_${attemptNumber}.txt`,
          [
            `command: ${primaryCommand}`,
            `cwd: ${resolved.cwd}`,
            `source: ${resolved.source}`,
            `attempt: ${attemptNumber}`,
            "",
            obs.stdout || "",
            obs.stderr || ""
          ].join("\n")
        );

        if (
          topicProbeComputeGovernor
          && computePreflight?.entry
        ) {
          const computeActual = await finalizeTopicProbeComputeUsage({
            run,
            governor: topicProbeComputeGovernor,
            profile: computePreflight.entry.profile,
            command: primaryCommand,
            metricsPath: resolved.metricsPath,
            attempt: computePreflight.entry.attempt,
            startedAt: new Date(commandStartedAtMs).toISOString(),
            wallTimeMs:
              typeof obs.duration_ms === "number"
                ? obs.duration_ms
                : Math.max(0, Date.now() - commandStartedAtMs)
          });
          if (!computeActual.allowed) {
            const summary = formatTopicProbeComputeBudgetFailure(
              computeActual.reasons
            );
            await runContext.put(
              "run_experiments.topic_probe_compute_budget_failure",
              {
                stage: "actual",
                reasons: computeActual.reasons
              }
            );
            await recordRunFailure(summary, "resource");
            return {
              status: "failure",
              error: summary,
              summary,
              toolCallsUsed:
                preflightToolCallsUsed + primaryAttemptsUsed
            };
          }
        }

        if (obs.status !== "ok") {
          const policyBlock = extractPolicyBlock(obs);
          const metricsFailureSummary = policyBlock.blocked
            ? undefined
            : await loadFailedMetricsSummary(resolved.metricsPath, resolved.cwd, implementPublicDir);
          const failureStage = metricsFailureSummary ? "metrics" : policyBlock.blocked ? "policy" : "command";
          const triageStage = failureStage === "metrics" ? "metrics" : "command";
          const failureSummary = metricsFailureSummary || buildCommandFailureSummary({
            stderr: obs.stderr,
            stdout: obs.stdout,
            exitCode: obs.exit_code ?? 1,
            metricsPath: resolved.metricsPath,
            aborted: abortSignal?.aborted === true,
            durationMs: obs.duration_ms
          });
          const suggestedNextAction = metricsFailureSummary
            ? buildMetricsFailureSuggestedNextAction(metricsFailureSummary)
            : policyBlock.blocked
              ? "Replace the blocked run command with a policy-compliant command before retrying."
              : buildCommandFailureSuggestedNextAction({
                stderr: obs.stderr,
                stdout: obs.stdout
              });
          const triage = classifyRunExperimentsFailure({
            attempt: attemptNumber,
            stage: triageStage,
            summary: failureSummary,
            command: primaryCommand,
            cwd: resolved.cwd,
            exitCode: obs.exit_code ?? 1,
            logFile,
            metricsPath: resolved.metricsPath,
            policyBlocked: policyBlock.blocked
          });
          triageAttempts.push(triage);
          watchdog = setMetricsState(watchdog, "not_checked", logFile);
          rerunDecision = decideRunExperimentsRerun({
            triage,
            automaticRerunsUsed
          });
          await persistPanelState();
          if (rerunDecision.decision === "retry_once") {
            automaticRerunsUsed += 1;
            deps.eventStream.emit({
              type: "OBS_RECEIVED",
              runId: run.id,
              node: "run_experiments",
              agentRole: "runner",
              payload: {
                text: `Retrying the primary command once because the failure looked transient (${rerunDecision.reason})`
              }
            });
            if (topicProbeComputeGovernor) {
              await fs.unlink(resolved.metricsPath).catch(() => undefined);
            }
            continue;
          }

          const report = buildRunVerifierReport({
            status: "fail",
            trigger,
            stage: failureStage,
            summary: failureSummary,
            policyRuleId: policyBlock.ruleId,
            policyReason: policyBlock.reason,
            command: primaryCommand,
            cwd: resolved.cwd,
            metricsPath: resolved.metricsPath,
            exitCode: obs.exit_code ?? 1,
            stdout: obs.stdout,
            stderr: failureSummary,
            logFile,
            suggestedNextAction
          });
          deps.eventStream.emit({
            type: "TEST_FAILED",
            runId: run.id,
            node: "run_experiments",
            agentRole: "runner",
            payload: {
              command: primaryCommand,
              stderr: failureSummary
            }
          });
          await persistRunVerifierReport(run, runContext, report);
          await persistRunFailureState(runContext, {
            command: primaryCommand,
            cwd: resolved.cwd,
            logFile,
            exitCode: obs.exit_code ?? 1,
            error: failureSummary
          });
          await persistGovernanceCrash({
            run,
            runContext,
            comparisonContract,
            implementationContext,
            objectiveMetricName: run.objectiveMetric,
            rationale: report.summary,
            resourceUsage: {
              stage: failureStage,
              command: primaryCommand,
              cwd: resolved.cwd,
              exit_code: obs.exit_code ?? 1,
              log_file: logFile
            }
          });
          await recordRunFailure(failureSummary, "structural");
          await restoreMetricsAfterRejectedAttempt(failureSummary);
          return {
            status: "failure",
            error: failureSummary,
            toolCallsUsed: preflightToolCallsUsed + primaryAttemptsUsed
          };
        }

        let metricsExists = await fileExists(resolved.metricsPath);
        const zeroExitRuntimeFailure = !metricsExists
          ? detectZeroExitRuntimeFailure(obs.stderr || "")
          : undefined;
        if (zeroExitRuntimeFailure) {
          const failureSummary =
            `${zeroExitRuntimeFailure} The command exited successfully but did not write required metrics at ${resolved.metricsPath}.`;
          const triage = classifyRunExperimentsFailure({
            attempt: attemptNumber,
            stage: "command",
            summary: failureSummary,
            command: primaryCommand,
            cwd: resolved.cwd,
            exitCode: obs.exit_code ?? 0,
            logFile,
            metricsPath: resolved.metricsPath
          });
          triageAttempts.push(triage);
          watchdog = setMetricsState(watchdog, "missing", logFile);
          rerunDecision = decideRunExperimentsRerun({
            triage,
            automaticRerunsUsed
          });
          await persistPanelState();
          const report = buildRunVerifierReport({
            status: "fail",
            trigger,
            stage: "command",
            summary: failureSummary,
            command: primaryCommand,
            cwd: resolved.cwd,
            metricsPath: resolved.metricsPath,
            exitCode: obs.exit_code ?? 0,
            stdout: obs.stdout,
            stderr: failureSummary,
            logFile,
            suggestedNextAction:
              "Repair the experiment command so runtime exceptions fail the process or write a failed metrics payload to the required metrics path."
          });
          deps.eventStream.emit({
            type: "TEST_FAILED",
            runId: run.id,
            node: "run_experiments",
            agentRole: "runner",
            payload: {
              command: primaryCommand,
              metrics_path: resolved.metricsPath,
              stderr: failureSummary
            }
          });
          await persistRunVerifierReport(run, runContext, report);
          await persistRunFailureState(runContext, {
            command: primaryCommand,
            cwd: resolved.cwd,
            logFile,
            exitCode: obs.exit_code ?? 0,
            error: failureSummary
          });
          await persistGovernanceCrash({
            run,
            runContext,
            comparisonContract,
            implementationContext,
            objectiveMetricName: run.objectiveMetric,
            rationale: report.summary,
            resourceUsage: {
              stage: "command",
              command: primaryCommand,
              cwd: resolved.cwd,
              exit_code: obs.exit_code ?? 0,
              log_file: logFile,
              metrics_path: resolved.metricsPath
            }
          });
          await recordRunFailure(failureSummary, "structural");
          await restoreMetricsAfterRejectedAttempt(failureSummary);
          return {
            status: "failure",
            error: failureSummary,
            toolCallsUsed: preflightToolCallsUsed + primaryAttemptsUsed
          };
        }
        const recoveredPublicMetricsPath = await recoverPublicBundleMetricsOutput({
          runContext,
          workspaceRoot: process.cwd(),
          metricsPath: resolved.metricsPath,
          minModifiedAtMs: commandStartedAtMs
        });
        if (recoveredPublicMetricsPath) {
          metricsExists = true;
          deps.eventStream.emit({
              type: "OBS_RECEIVED",
              runId: run.id,
              node: "run_experiments",
              agentRole: "runner",
              payload: {
                text: `Recovered required metrics output from public bundle metrics at ${recoveredPublicMetricsPath}.`
              }
          });
          await runContext.put("run_experiments.recovered_public_metrics_path", recoveredPublicMetricsPath);
        }
        if (!metricsExists) {
          const missingMessage = `Experiment finished without metrics output at ${resolved.metricsPath}`;
          const triage = classifyRunExperimentsFailure({
            attempt: attemptNumber,
            stage: "metrics",
            summary: missingMessage,
            command: primaryCommand,
            cwd: resolved.cwd,
            exitCode: obs.exit_code ?? 0,
            logFile,
            metricsPath: resolved.metricsPath
          });
          triageAttempts.push(triage);
          watchdog = setMetricsState(watchdog, "missing", logFile);
          rerunDecision = decideRunExperimentsRerun({
            triage,
            automaticRerunsUsed
          });
          await persistPanelState();
          const report = buildRunVerifierReport({
            status: "fail",
            trigger,
            stage: "metrics",
            summary: missingMessage,
            command: primaryCommand,
            cwd: resolved.cwd,
            metricsPath: resolved.metricsPath,
            exitCode: obs.exit_code ?? 0,
            stdout: obs.stdout,
            stderr: obs.stderr,
            logFile,
            suggestedNextAction:
              "Ensure the experiment writes JSON metrics to the required metrics path before finishing."
          });
          deps.eventStream.emit({
            type: "TEST_FAILED",
            runId: run.id,
            node: "run_experiments",
            agentRole: "runner",
            payload: {
              command: primaryCommand,
              metrics_path: resolved.metricsPath,
              stderr: missingMessage
            }
          });
          await persistRunVerifierReport(run, runContext, report);
          await persistRunFailureState(runContext, {
            command: primaryCommand,
            cwd: resolved.cwd,
            logFile,
            exitCode: obs.exit_code ?? 0,
            error: missingMessage
          });
          await persistGovernanceCrash({
            run,
            runContext,
            comparisonContract,
            implementationContext,
            objectiveMetricName: run.objectiveMetric,
            rationale: report.summary,
            resourceUsage: {
              stage: "metrics",
              command: primaryCommand,
              cwd: resolved.cwd,
              exit_code: obs.exit_code ?? 0,
              log_file: logFile,
              metrics_path: resolved.metricsPath
            }
          });
          await recordRunFailure(missingMessage, "structural");
          await restoreMetricsAfterRejectedAttempt(missingMessage);
          return {
            status: "failure",
            error: missingMessage,
            toolCallsUsed: preflightToolCallsUsed + primaryAttemptsUsed
          };
        }

        await appendJsonl(run, "exec_logs/observations.jsonl", [
          {
            command: primaryCommand,
            cwd: resolved.cwd,
            source: primaryAttemptsUsed > 1 ? `${resolved.source}:retry_${attemptNumber}` : resolved.source,
            status: obs.status,
            stdout: (obs.stdout || "").trim(),
            stderr: (obs.stderr || "").trim(),
            metrics_path: resolved.metricsPath,
            log_file: logFile
          }
        ]);

        try {
          const rawMetrics = await fs.readFile(resolved.metricsPath, "utf8");
          const parsed = JSON.parse(rawMetrics) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("metrics.json must decode to an object");
          }
          parsedMetrics = parsed as Record<string, unknown>;
          await enrichMetricsWithRawConditionEvidence({
            metrics: parsedMetrics,
            metricsPath: resolved.metricsPath,
            workspaceRoot: process.cwd()
          });
          const runtimeMetadataPromotion = await enrichMetricsWithPythonRuntimeDefaults({
            metrics: parsedMetrics,
            command: primaryCommand,
            cwd: resolved.cwd
          });
          if (runtimeMetadataPromotion) {
            deps.eventStream.emit({
              type: "OBS_RECEIVED",
              runId: run.id,
              node: "run_experiments",
              agentRole: "runner",
              payload: {
                text: runtimeMetadataPromotion
              }
            });
          }
          const projectedConditionSummaries = promotePerExampleConditionRowsToSummaries(parsedMetrics);
          if (projectedConditionSummaries) {
            deps.eventStream.emit({
              type: "OBS_RECEIVED",
              runId: run.id,
              node: "run_experiments",
              agentRole: "runner",
              payload: {
                text: projectedConditionSummaries
              }
            });
          }
          const promotedObjectiveMetric = promoteExplicitResultsPrimaryObservation(parsedMetrics);
          if (promotedObjectiveMetric) {
            deps.eventStream.emit({
              type: "OBS_RECEIVED",
              runId: run.id,
              node: "run_experiments",
              agentRole: "runner",
              payload: {
                text: promotedObjectiveMetric
              }
            });
          }
          watchdog = setMetricsState(watchdog, "valid", logFile);
          const failedMetricsMessage = appendExperimentFailureArtifactEvidence(
            detectFailedMetricsPayload(parsedMetrics),
            await loadExperimentFailureArtifactSummary(resolved.cwd, implementPublicDir)
          );
          if (failedMetricsMessage) {
            const failedMetricsSuggestedNextAction = failedMetricsMessage.includes("Experiment dependency blocker:")
              ? "Prewarm or make the required experiment dependency available, or revise the governed experiment design to use an available model before rerunning."
              : buildMetricsFailureSuggestedNextAction(failedMetricsMessage);
            const triage = classifyRunExperimentsFailure({
              attempt: attemptNumber,
              stage: "metrics",
              summary: failedMetricsMessage,
              command: primaryCommand,
              cwd: resolved.cwd,
              exitCode: obs.exit_code ?? 0,
              logFile,
              metricsPath: resolved.metricsPath
            });
            triageAttempts.push(triage);
            rerunDecision = decideRunExperimentsRerun({
              triage,
              automaticRerunsUsed
            });
            await persistPanelState();
            const report = buildRunVerifierReport({
              status: "fail",
              trigger,
              stage: "metrics",
              summary: failedMetricsMessage,
              command: primaryCommand,
              cwd: resolved.cwd,
              metricsPath: resolved.metricsPath,
              exitCode: obs.exit_code ?? 0,
              stdout: obs.stdout,
              stderr: failedMetricsMessage,
              logFile,
              suggestedNextAction: failedMetricsSuggestedNextAction
            });
            deps.eventStream.emit({
              type: "TEST_FAILED",
              runId: run.id,
              node: "run_experiments",
              agentRole: "runner",
              payload: {
                command: primaryCommand,
                metrics_path: resolved.metricsPath,
                stderr: failedMetricsMessage
              }
            });
            await persistRunVerifierReport(run, runContext, report);
            await persistRunFailureState(runContext, {
              command: primaryCommand,
              cwd: resolved.cwd,
              logFile,
              exitCode: obs.exit_code ?? 0,
              error: failedMetricsMessage
            });
            await persistGovernanceCrash({
              run,
              runContext,
              comparisonContract,
              implementationContext,
              objectiveMetricName: run.objectiveMetric,
              rationale: report.summary,
              resourceUsage: {
                stage: "metrics",
                command: primaryCommand,
                cwd: resolved.cwd,
                exit_code: obs.exit_code ?? 0,
                log_file: logFile,
                metrics_path: resolved.metricsPath
              }
            });
            await recordRunFailure(failedMetricsMessage, "structural");
            await restoreMetricsAfterRejectedAttempt(failedMetricsMessage);
            return {
              status: "failure",
              error: failedMetricsMessage,
              toolCallsUsed: preflightToolCallsUsed + primaryAttemptsUsed
            };
          }
          const sentinelFindings = detectSentinelWatchdogFindings(parsedMetrics);
          watchdog = setSentinelFindings(watchdog, sentinelFindings);
          if (sentinelFindings.some((finding) => finding.severity === "fail")) {
            const sentinelMessage = sentinelFindings.map((finding) => finding.message).join(" ");
            await persistPanelState();
            await persistRunVerifierReport(
              run,
              runContext,
              buildRunVerifierReport({
                status: "fail",
                trigger,
                stage: "metrics",
                summary: sentinelMessage,
                command: primaryCommand,
                cwd: resolved.cwd,
                metricsPath: resolved.metricsPath,
                exitCode: obs.exit_code ?? 0,
                stdout: obs.stdout,
                stderr: sentinelMessage,
                logFile,
                suggestedNextAction:
                  "Repair the metrics writer so NaN/Inf-like outputs are removed before the run is accepted."
              })
            );
            await persistRunFailureState(runContext, {
              command: primaryCommand,
              cwd: resolved.cwd,
              logFile,
              exitCode: obs.exit_code ?? 0,
              error: sentinelMessage
            });
            await recordRunFailure(sentinelMessage, "structural");
            await restoreMetricsAfterRejectedAttempt(sentinelMessage);
            return {
              status: "failure",
              error: sentinelMessage,
              toolCallsUsed: preflightToolCallsUsed + primaryAttemptsUsed
            };
          }
          const preflightOnlyMessage = detectPreflightOnlyMetrics(parsedMetrics);
          if (preflightOnlyMessage) {
            await persistPanelState();
            await persistRunVerifierReport(
              run,
              runContext,
              buildRunVerifierReport({
                status: "fail",
                trigger,
                stage: "metrics",
                summary: preflightOnlyMessage,
                command: primaryCommand,
                cwd: resolved.cwd,
                metricsPath: resolved.metricsPath,
                exitCode: obs.exit_code ?? 0,
                stdout: obs.stdout,
                stderr: preflightOnlyMessage,
                logFile,
                suggestedNextAction:
                  "Run the actual bounded experiment command so metrics.json contains executed task metrics, not only environment readiness data."
              })
            );
            await persistRunFailureState(runContext, {
              command: primaryCommand,
              cwd: resolved.cwd,
              logFile,
              exitCode: obs.exit_code ?? 0,
              error: preflightOnlyMessage
            });
            await recordRunFailure(preflightOnlyMessage, "structural");
            await restoreMetricsAfterRejectedAttempt(preflightOnlyMessage);
            return {
              status: "failure",
              error: preflightOnlyMessage,
              toolCallsUsed: preflightToolCallsUsed + primaryAttemptsUsed
            };
          }
          rerunDecision = {
            decision: "not_needed",
            reason:
              primaryAttemptsUsed > 1
                ? `The primary command succeeded on retry attempt ${attemptNumber}.`
                : "The primary command succeeded without requiring an automatic rerun."
          };
          await persistPanelState();
          break;
        } catch (error) {
          const metricsError = `Experiment produced invalid metrics JSON at ${resolved.metricsPath}: ${
            error instanceof Error ? error.message : String(error)
          }`;
          const triage = classifyRunExperimentsFailure({
            attempt: attemptNumber,
            stage: "metrics",
            summary: metricsError,
            command: primaryCommand,
            cwd: resolved.cwd,
            exitCode: obs.exit_code ?? 0,
            logFile,
            metricsPath: resolved.metricsPath
          });
          triageAttempts.push(triage);
          watchdog = setMetricsState(watchdog, "invalid", logFile);
          rerunDecision = decideRunExperimentsRerun({
            triage,
            automaticRerunsUsed
          });
          await persistPanelState();
          const report = buildRunVerifierReport({
            status: "fail",
            trigger,
            stage: "metrics",
            summary: metricsError,
            command: primaryCommand,
            cwd: resolved.cwd,
            metricsPath: resolved.metricsPath,
            exitCode: obs.exit_code ?? 0,
            stdout: obs.stdout,
            stderr: metricsError,
            logFile,
            suggestedNextAction:
              "Ensure the experiment writes valid JSON metrics objects to the required metrics path before finishing."
          });
          deps.eventStream.emit({
            type: "TEST_FAILED",
            runId: run.id,
            node: "run_experiments",
            agentRole: "runner",
            payload: {
              command: primaryCommand,
              metrics_path: resolved.metricsPath,
              stderr: metricsError
            }
          });
          await persistRunVerifierReport(run, runContext, report);
          await persistRunFailureState(runContext, {
            command: primaryCommand,
            cwd: resolved.cwd,
            logFile,
            exitCode: obs.exit_code ?? 0,
            error: metricsError
          });
          await persistGovernanceCrash({
            run,
            runContext,
            comparisonContract,
            implementationContext,
            objectiveMetricName: run.objectiveMetric,
            rationale: report.summary,
            resourceUsage: {
              stage: "metrics",
              command: primaryCommand,
              cwd: resolved.cwd,
              exit_code: obs.exit_code ?? 0,
              log_file: logFile,
              metrics_path: resolved.metricsPath
            }
          });
          await recordRunFailure(metricsError, "structural");
          await restoreMetricsAfterRejectedAttempt(metricsError);
          return {
            status: "failure",
            error: metricsError,
            toolCallsUsed: preflightToolCallsUsed + primaryAttemptsUsed
          };
        }
      }

      const objectiveProfile =
        getGovernedObjectiveProfile(comparisonContract, run.objectiveMetric) ||
        (await resolveObjectiveMetricProfile({
          run,
          runContextMemory: runContext,
          llm: deps.llm,
          eventStream: deps.eventStream,
          node: "run_experiments"
        }));
      const publicMetricPromotion = await promoteObjectiveMetricFromPublicBundle({
        metrics: parsedMetrics,
        objectiveProfile,
        runContext,
        workspaceRoot: process.cwd(),
        metricsPath: resolved.metricsPath,
        minModifiedAtMs: latestCommandStartedAtMs
      });
      if (publicMetricPromotion) {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            text: publicMetricPromotion
          }
        });
      }
      const objectiveEvaluation = evaluateObjectiveMetric(
        parsedMetrics,
        objectiveProfile,
        objectiveProfile.raw
      );
      objectiveEvaluationSummary = objectiveEvaluation.summary;
      await writeRunArtifact(run, "metrics.json", JSON.stringify(parsedMetrics, null, 2));
      await writeRunArtifact(run, "objective_evaluation.json", JSON.stringify(objectiveEvaluation, null, 2));
      const metricsContractIssues = validateRunMetricsContract({
        metrics: parsedMetrics,
        objectiveEvaluation,
        comparisonContract,
        experimentContract,
        briefSections,
        experimentPortfolio
      });
      if (metricsContractIssues.length > 0) {
        const contractMessage = appendExperimentFailureArtifactEvidence(
          appendMetricsFailureEvidence(
            `Experiment metrics contract failed: ${metricsContractIssues.join(" ")}`,
            parsedMetrics
          ),
          await loadExperimentFailureArtifactSummary(resolved.cwd, implementPublicDir)
        ) || `Experiment metrics contract failed: ${metricsContractIssues.join(" ")}`;
        await persistPanelState();
        const report = buildRunVerifierReport({
          status: "fail",
          trigger,
          stage: "metrics",
          summary: contractMessage,
          command: primaryCommand,
          cwd: resolved.cwd,
          metricsPath: resolved.metricsPath,
          exitCode: obs?.exit_code ?? 0,
          stdout: obs?.stdout,
          stderr: contractMessage,
          logFile,
          suggestedNextAction: buildMetricsContractSuggestedNextAction(contractMessage)
        });
        deps.eventStream.emit({
          type: "TEST_FAILED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            command: primaryCommand,
            metrics_path: resolved.metricsPath,
            stderr: contractMessage
          }
        });
        await persistRunVerifierReport(run, runContext, report);
        await persistRunFailureState(runContext, {
          command: primaryCommand,
          cwd: resolved.cwd,
          logFile,
          exitCode: obs?.exit_code ?? 0,
          error: contractMessage
        });
        await persistGovernanceCrash({
          run,
          runContext,
          comparisonContract,
          implementationContext,
          objectiveMetricName: run.objectiveMetric,
          rationale: report.summary,
          resourceUsage: {
            stage: "metrics",
            command: primaryCommand,
            cwd: resolved.cwd,
            exit_code: obs?.exit_code ?? 0,
            log_file: logFile,
            metrics_path: resolved.metricsPath,
            objective_evaluation_status: objectiveEvaluation.status
          }
        });
        await recordRunFailure(contractMessage, "structural");
        await restoreMetricsAfterRejectedAttempt(contractMessage);
        return {
          status: "failure",
          error: contractMessage,
          toolCallsUsed: preflightToolCallsUsed + primaryAttemptsUsed
        };
      }
      if (comparisonContract) {
        const managedBundleLock = await freezeManagedBundleLock({
          contract: comparisonContract,
          workspaceRoot: process.cwd(),
          publicDir:
            managedSupplementalPlan?.publicDir ||
            resolveMaybeRelative(await runContext.get<string>("implement_experiments.public_dir"), process.cwd()) ||
            undefined
        });
        if (managedBundleLock) {
          await storeExperimentGovernanceDecision(run, runContext, {
            managedBundleLock,
            entries: []
          });
        } else if (comparisonContract.budget_profile.mode === "managed_standard") {
          deps.eventStream.emit({
            type: "OBS_RECEIVED",
            runId: run.id,
            node: "run_experiments",
            agentRole: "runner",
            payload: {
              text: "Managed standard run completed without a frozen evaluator/environment lock; analyze_results will treat the candidate as non-comparable until the bundle artifacts are restored."
            }
          });
        }
      }
      await persistRunVerifierReport(
        run,
        runContext,
        buildRunVerifierReport({
          status: "pass",
          trigger,
          stage: "success",
          summary: objectiveEvaluation.summary,
          command: primaryCommand,
          cwd: resolved.cwd,
          metricsPath: resolved.metricsPath,
          exitCode: obs?.exit_code ?? 0,
          stdout: obs?.stdout,
          stderr: obs?.stderr,
          logFile
        })
      );
      const supplementalRuns = await maybeRunManagedSupplementalProfiles({
        deps,
        run,
        runContext,
        objectiveProfile,
        objectiveEvaluation,
        primaryCommand,
        plan: managedSupplementalPlan,
        abortSignal,
        topicProbeComputeGovernor
      });
      for (const record of supplementalRuns.records.filter((item) => item.status === "fail")) {
        triageAttempts.push(
          classifyRunExperimentsFailure({
            attempt: primaryAttemptsUsed + triageAttempts.length + 1,
            stage: "supplemental",
            summary: record.summary,
            command: record.command,
            cwd: record.cwd,
            exitCode: record.exit_code,
            logFile: record.log_file,
            metricsPath: record.metrics_path
          })
        );
      }
      const supplementalComputeFailure = supplementalRuns.records.find(
        (record) => record.compute_budget_blocked
      );
      if (supplementalComputeFailure) {
        const summary = supplementalComputeFailure.summary;
        await persistRunVerifierReport(
          run,
          runContext,
          buildRunVerifierReport({
            status: "fail",
            trigger,
            stage: "policy",
            summary,
            command: supplementalComputeFailure.command,
            cwd: supplementalComputeFailure.cwd,
            metricsPath: supplementalComputeFailure.metrics_path,
            suggestedNextAction:
              "Repair the compute declaration or execution profile before another topic-probe command."
          })
        );
        await persistRunFailureState(runContext, {
          command: supplementalComputeFailure.command,
          cwd: supplementalComputeFailure.cwd,
          error: summary
        });
        await recordRunFailure(summary, "resource");
        return {
          status: "failure",
          error: summary,
          summary,
          toolCallsUsed:
            preflightToolCallsUsed
            + primaryAttemptsUsed
            + supplementalRuns.toolCallsUsed
        };
      }
      watchdog = recordSupplementalOutputs(
        watchdog,
        supplementalRuns.records.map((record) => ({
          profile: record.profile,
          status: record.status,
          metrics_path: record.metrics_path
        }))
      );
      await persistPanelState();

      await runContext.put("run_experiments.command", primaryCommand);
      await runContext.put("run_experiments.cwd", resolved.cwd);
      await runContext.put("run_experiments.last_log_file", logFile);
      await runContext.put("run_experiments.exit_code", obs?.exit_code ?? 0);
      await runContext.put("run_experiments.last_error", undefined);
      await runContext.put(EXPERIMENT_GOVERNANCE_CONTRACT_KEY, comparisonContract || null);
      await runContext.put("objective_metric.last_evaluation", objectiveEvaluation);
      await runContext.put("run_experiments.supplemental_runs", supplementalRuns.records);
      await runContext.put("run_experiments.supplemental_summary", supplementalRuns.summary || null);
      await runContext.put("run_experiments.supplemental_expectation", supplementalRuns.expectation || null);
      const matrixTrialGroups = await materializeManagedMatrixTrialGroupArtifacts({
        run,
        portfolio: experimentPortfolio,
        primaryCommand,
        primaryCwd: resolved.cwd,
        primaryMetricsPath: resolved.metricsPath,
        primaryMetrics: parsedMetrics,
        primarySummary: objectiveEvaluation.summary,
        supplementalRuns: supplementalRuns.records
      });
      const runManifest = buildExperimentRunManifest({
        runId: run.id,
        portfolio: experimentPortfolio,
        executionModel: managedSupplementalPlan?.kind || experimentPortfolio.execution_model,
        primaryCommand,
        primaryCwd: resolved.cwd,
        primaryMetricsPath: resolved.metricsPath,
        primaryMetrics: parsedMetrics,
        objectiveEvaluation,
        comparisonMode: comparisonContract?.comparison_mode,
        supplementalRuns: supplementalRuns.records,
        executedTrialGroups: matrixTrialGroups
      });
      await runContext.put("run_experiments.portfolio", runManifest.portfolio);
      await runContext.put("run_experiments.matrix_trial_groups", matrixTrialGroups);
      await runContext.put("run_experiments.run_manifest", runManifest);
      await writeRunArtifact(
        run,
        "run_experiments_supplemental_runs.json",
        JSON.stringify(supplementalRuns.records, null, 2)
      );
      await writeRunArtifact(
        run,
        "run_experiments_supplemental_expectation.json",
        JSON.stringify(supplementalRuns.expectation || null, null, 2)
      );
      await writeRunArtifact(
        run,
        "run_experiments_matrix_trial_groups.json",
        JSON.stringify(matrixTrialGroups, null, 2)
      );
      await writeRunArtifact(run, "experiment_portfolio.json", JSON.stringify(runManifest.portfolio, null, 2));
      await writeRunArtifact(run, "run_manifest.json", JSON.stringify(runManifest, null, 2));
      const publicSummaryProjection = await materializeRunExperimentPublicSummaryProjection({
        run,
        metrics: parsedMetrics,
        objectiveEvaluation,
        metricsPath: resolved.metricsPath,
        command: primaryCommand,
        cwd: resolved.cwd
      });
      const publicOutputs = await publishRunExperimentOutputs({
        workspaceRoot: process.cwd(),
        run,
        runContext,
        metricsPath: resolved.metricsPath,
        supplementalPlan: managedSupplementalPlan,
        matrixTrialGroups,
        publicSummaryProjection
      });

      deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: "run_experiments",
        agentRole: "runner",
        payload: {
          text: `${formatRunLabel(experimentMode, trigger)} completed. Metrics written to ${resolved.metricsPath}`
        }
      });
      deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: "run_experiments",
        agentRole: "runner",
        payload: {
          text: objectiveEvaluation.summary
        }
      });
      deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: "run_experiments",
        agentRole: "runner",
        payload: {
          text: `Public experiment outputs are available at ${publicOutputs.sectionDirRelative}.`
        }
      });

      return {
        status: "success",
        summary: `${formatRunLabel(experimentMode, trigger)} completed via ${primaryCommand}. ${objectiveEvaluationSummary}${
          supplementalRuns.summary ? ` ${supplementalRuns.summary}` : ""
        } Public outputs: ${publicOutputs.outputRootRelative}.`,
        needsApproval: true,
        toolCallsUsed: preflightToolCallsUsed + primaryAttemptsUsed + supplementalRuns.toolCallsUsed
      };
  }
};
}

async function initializeTopicProbeComputeGovernor(input: {
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"];
  researchModeGuard: {
    evidenceStage: ResearchEvidenceStage;
  };
  comparisonContract?: Awaited<
    ReturnType<typeof loadExperimentComparisonContract>
  >;
  experimentPortfolio: ExperimentPortfolio;
  managedSupplementalPlan?: ManagedSupplementalPlan;
  resolvedCommand: Awaited<ReturnType<typeof resolveRunCommand>>;
  rawBrief?: string;
  enforceEnvironmentGpuLimit: boolean;
  configuredTimeoutSec?: number;
}): Promise<TopicProbeComputeGovernor | undefined> {
  if (input.researchModeGuard.evidenceStage === "standard") {
    return undefined;
  }
  if (input.resolvedCommand.testCommand?.trim()) {
    throw new Error("topic_probe_pre_execution_test_command_forbidden");
  }
  if (input.resolvedCommand.gpuRequestIssue) {
    throw new Error(input.resolvedCommand.gpuRequestIssue);
  }
  const requestedGpuCount = input.resolvedCommand.requestedGpuCount;
  if (requestedGpuCount === undefined) {
    throw new Error("topic_probe_compute_preflight_requested_gpu_count_missing");
  }
  if (
    input.enforceEnvironmentGpuLimit
    && input.resolvedCommand.environmentGpuLimit !== undefined
    && requestedGpuCount > input.resolvedCommand.environmentGpuLimit
  ) {
    throw new Error(
      "topic_probe_compute_preflight_environment_gpu_limit_exceeded:"
      + `requested=${requestedGpuCount},`
      + `environment_limit=${input.resolvedCommand.environmentGpuLimit},`
      + `source=${input.resolvedCommand.environmentGpuLimitSource || "unknown"}`
    );
  }
  const contractSource = resolveTopicProbeComputeContractSource(
    input.researchModeGuard.evidenceStage
  );
  if (!contractSource) {
    return undefined;
  }
  const stage = contractSource.stage;
  const activeContractRelativePath = contractSource.relativePath;
  const activeContractPath = path.join(
    process.cwd(),
    ".autolabos",
    "runs",
    input.run.id,
    activeContractRelativePath
  );
  let activeContractRaw: string;
  try {
    activeContractRaw = await fs.readFile(activeContractPath, "utf8");
  } catch {
    throw new Error(
      "topic_probe_compute_active_contract_missing"
    );
  }
  const activeValidation = validateActiveTopicProbeContract(
    activeContractRaw,
    contractSource.requireCurrentRunId ? { expectedRunId: input.run.id } : {}
  );
  if (!activeValidation.valid || !activeValidation.contract) {
    throw new Error(
      `topic_probe_compute_active_contract_invalid:${activeValidation.reasons.join(",")}`
    );
  }
  const activeContract = activeValidation.contract;
  const briefComputeBudgetCeiling =
    parseTopicProbeComputeBudgetCeilingFromBrief(input.rawBrief || "");
  if (
    !topicProbeComputeBudgetLimitsEqual(
      activeContract.brief_compute_budget_ceiling,
      briefComputeBudgetCeiling
    )
  ) {
    throw new Error(
      "topic_probe_compute_active_contract_brief_ceiling_mismatch"
    );
  }
  const budgetContract = buildTopicProbeComputeBudgetContract({
    runId: input.run.id,
    stage,
    activeTopicProbeContractSha256: activeContract.content_sha256,
    localBudget: activeContract.local_budget,
    briefComputeBudgetCeiling,
    limits: activeContract.compute_budget,
    generatedAt: activeContract.generated_at
  });
  await writeRunArtifact(
    input.run,
    "governance/topic_probe_compute_budget_contract.json",
    `${JSON.stringify(budgetContract, null, 2)}\n`
  );
  const ledgerPath = path.join(
    process.cwd(),
    ".autolabos",
    "runs",
    input.run.id,
    "governance",
    "topic_probe_compute_usage_ledger.jsonl"
  );
  let existingLedger = "";
  try {
    existingLedger = await fs.readFile(ledgerPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const ledgerValidation = validateTopicProbeComputeUsageLedger(
    existingLedger,
    budgetContract
  );
  if (
    !ledgerValidation.valid
    || ledgerValidation.pendingAttempt !== undefined
    || ledgerValidation.blocked
  ) {
    throw new Error(
      `topic_probe_compute_usage_ledger_not_appendable:${[
        ...ledgerValidation.reasons,
        ...(ledgerValidation.pendingAttempt !== undefined
          ? ["pending_attempt_unresolved"]
          : []),
        ...(ledgerValidation.blocked ? ["terminally_blocked"] : [])
      ].join(",")}`
    );
  }

  const timeoutSec =
    input.comparisonContract?.budget_profile.timeout_sec
    ?? input.configuredTimeoutSec;
  if (
    typeof timeoutSec !== "number"
    || !Number.isFinite(timeoutSec)
    || timeoutSec <= 0
  ) {
    throw new Error(
      "topic_probe_compute_preflight_timeout_missing"
    );
  }
  const trialResolution = deriveRequiredPlannedRunCount({
    metrics: {},
    comparisonContract: input.comparisonContract,
    experimentPortfolio: input.experimentPortfolio
  });
  if (
    budgetContract.active_limit.max_trials !== undefined
    && (
      trialResolution.count === undefined
      || trialResolution.issue
    )
  ) {
    throw new Error(
      trialResolution.issue
        ? `topic_probe_compute_preflight_trial_estimate_ambiguous:${trialResolution.issue}`
        : "topic_probe_compute_preflight_trial_estimate_missing"
    );
  }
  const supplementalEstimatedFreshTrials: Partial<
    Record<SupplementalProfileName, number>
  > = {};
  if (
    budgetContract.active_limit.max_trials !== undefined
    && input.managedSupplementalPlan
  ) {
    for (const profile of input.managedSupplementalPlan.profiles) {
      const resolution = deriveSupplementalProfileTrialEstimate(
        input.experimentPortfolio,
        profile.profile
      );
      if (resolution.count === undefined || resolution.issue) {
        throw new Error(
          resolution.issue
            ? `topic_probe_compute_preflight_supplemental_trial_estimate_ambiguous:profile=${profile.profile}:${resolution.issue}`
            : `topic_probe_compute_preflight_supplemental_trial_estimate_missing:profile=${profile.profile}`
        );
      }
      supplementalEstimatedFreshTrials[profile.profile] = resolution.count;
    }
  }
  return {
    contract: budgetContract,
    ledgerPath,
    estimatedWallTimeMs: timeoutSec * 1_000,
    estimatedGpuCount: requestedGpuCount,
    enforceEnvironmentGpuLimit: input.enforceEnvironmentGpuLimit,
    supplementalEstimatedFreshTrials,
    ...(trialResolution.count !== undefined
      ? { estimatedFreshTrials: trialResolution.count }
      : {})
  };
}

async function finalizeTopicProbeComputeUsage(input: {
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"];
  governor: TopicProbeComputeGovernor;
  profile: string;
  command: string;
  metricsPath: string;
  attempt: number;
  startedAt: string;
  wallTimeMs: number;
}): Promise<{ allowed: boolean; reasons: string[] }> {
  let raw: string;
  try {
    raw = await fs.readFile(input.metricsPath, "utf8");
  } catch {
    return appendTopicProbeComputeUnverifiableUsage({
      ledgerPath: input.governor.ledgerPath,
      contract: input.governor.contract,
      profile: input.profile,
      command: input.command,
      startedAt: input.startedAt,
      wallTimeMs: input.wallTimeMs,
      reasonCodes: ["topic_probe_compute_usage_evidence_missing"]
    });
  }
  let metrics: unknown;
  let evidence;
  try {
    metrics = JSON.parse(raw);
    evidence = parseTopicProbeComputeUsageEvidence(metrics);
  } catch (error) {
    return appendTopicProbeComputeUnverifiableUsage({
      ledgerPath: input.governor.ledgerPath,
      contract: input.governor.contract,
      profile: input.profile,
      command: input.command,
      startedAt: input.startedAt,
      wallTimeMs: input.wallTimeMs,
      reasonCodes: [
        error instanceof Error
          ? error.message
          : "topic_probe_compute_usage_evidence_invalid"
      ]
    });
  }
  const normalizedUsageEvidenceBytes = raw.endsWith("\n") ? raw : `${raw}\n`;
  await writeRunArtifact(
    input.run,
    `governance/topic_probe_compute_usage_evidence/attempt_${input.attempt}.json`,
    normalizedUsageEvidenceBytes
  );
  return appendTopicProbeComputeActualUsage({
    ledgerPath: input.governor.ledgerPath,
    contract: input.governor.contract,
    profile: input.profile,
    command: input.command,
    startedAt: input.startedAt,
    wallTimeMs: input.wallTimeMs,
    evidence,
    usageEvidenceSha256: sha256Utf8(normalizedUsageEvidenceBytes)
  });
}

function formatTopicProbeComputeBudgetFailure(
  reasons: string[]
): string {
  return (
    "Topic-probe compute budget blocked execution: "
    + (reasons.join(", ") || "usage could not be verified")
  );
}

function detectZeroExitRuntimeFailure(stderr: string): string | undefined {
  const normalized = stderr.trim();
  if (!normalized) {
    return undefined;
  }
  const fatalPattern = /\b(?:Traceback|Error|Exception|RuntimeError|ValueError|TypeError|ImportError|ModuleNotFoundError|AssertionError)\b/iu;
  if (!fatalPattern.test(normalized)) {
    return undefined;
  }
  const excerpt = normalized.replace(/\s+/gu, " ").slice(0, 600);
  return `Experiment command emitted fatal stderr despite zero exit status: ${excerpt}`;
}

function buildCommandFailureSummary(input: {
  stderr?: string;
  stdout?: string;
  exitCode: number;
  metricsPath: string;
  aborted?: boolean;
  durationMs?: number;
}): string {
  const output = [input.stderr || "", input.stdout || ""].join("\n");
  const details = [
    `Experiment command failed with exit_code=${input.exitCode}`,
    "metrics_written=false",
    `metrics_path=${input.metricsPath}`
  ];
  if (input.aborted) {
    details.push("execution_budget_exhausted=true", "command_aborted=true");
    if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) {
      details.push(`duration_ms=${Math.max(0, Math.round(input.durationMs))}`);
    }
    return details.join(" | ");
  }
  const dependencySummary = detectModelDownloadOrCacheFailure(output);
  if (dependencySummary) {
    details.push(dependencySummary);
  }
  const excerpt = oneLine((input.stderr || input.stdout || "Experiment command failed").replace(/\s+/gu, " ")).slice(
    0,
    600
  );
  if (excerpt && !details.some((detail) => detail.includes(excerpt))) {
    details.push(`stderr_excerpt=${excerpt}`);
  }
  return details.join(" | ");
}

function buildCommandFailureSuggestedNextAction(input: { stderr?: string; stdout?: string }): string {
  if (detectModelDownloadOrCacheFailure([input.stderr || "", input.stdout || ""].join("\n"))) {
    return "Repair the experiment dependency handling before retrying: reuse or prewarm the standard Hugging Face cache, avoid artifact-local model cache redownloads, set local_files_only when appropriate, or select an available local model/tokenizer.";
  }
  return "Repair the experiment command or runtime dependencies before handing back to the runner.";
}

function buildMetricsFailureSuggestedNextAction(summary: string): string {
  if (detectRuntimeConfigAttributeFailure(summary)) {
    return "Repair runtime config defaults before retrying: generated runners must either call their neutral config resolver or populate optional Namespace/runtime budget attributes, path aliases, and helper capabilities such as allow_model_download, local_files_only, cache_dir, trust_remote_code, output_dir, public_dir, run_artifact_dir, artifact_dir, artifacts_dir, condition_output_dir, condition_dir, metrics_path, paths, output_paths, artifact_paths, experiment_paths, runtime_paths, seed, max_train_examples, max_eval_examples_per_task, max_steps, and ensure_dirs before condition execution.";
  }
  if (detectEvaluationRuntimeHandleFailure(summary)) {
    return "Repair the experiment implementation before retrying: preserve evaluator-required runtime handles in the in-memory condition result until evaluation completes, or reload the saved condition artifact before scoring; do not count train-only completion as evaluated evidence.";
  }
  if (detectEvaluationArtifactReloadFailure(summary)) {
    return "Repair evaluation artifact reload before retrying: persist a valid per-condition trained artifact directory, pass that explicit path through the condition state, reload from that path instead of the process cwd or '.', and fail with artifact-path diagnostics before writing objective metric rows when the artifact is absent.";
  }
  if (detectEvaluationRecordScalarNormalizationFailure(summary)) {
    return "Repair evaluation record normalization before retrying: generated runners must coerce mapping, sequence, dataclass, attribute-style, and scalar evaluation records before label/example access, must not use membership checks such as field in record until the record is known to be iterable, must preserve objective labels from gold, label, answer, answer_index, correct_index, and answerKey, and must emit per-task schema diagnostics instead of collapsing the task as missing.";
  }
  if (detectMissingExecutionDataBundleArgumentFailure(summary)) {
    return "Repair the experiment invocation bridge before retrying: pass the materialized data/task/evaluation/path bundle and runtime context through neutral aliases such as task_bundle, task_data, dataset_bundle, data_bundle, eval_examples_by_task, eval_sets, benchmark_examples, train_examples, run, runtime, runtime_context, run_context, condition_result, paths, output_paths, and artifact_paths whenever a generated data loader, condition runner, or evaluator requires them.";
  }
  if (detectTrainingExamplesUnavailableFailure(summary)) {
    return "Repair data materialization before retrying: generated runners must load real bounded training examples and evaluation examples from the declared reusable dataset/task contract, preserve train_records/train_examples aliases, preserve usable text from common fields such as instruction, input, output, prompt, response, text, question, answer, messages, and conversations, and fail at data_access with loader diagnostics instead of executing conditions with an empty train set.";
  }
  if (detectTrainCompleteEvaluationSkippedFailure(summary)) {
    return "Repair condition evaluation handoff before retrying: train-complete condition states such as completed_training must remain eligible for evaluation, evaluators must run after training before final metrics are written, and skipped_not_completed rows must be emitted as a state-machine failure rather than objective evidence.";
  }
  if (detectTrainCompleteWithoutEvaluationMetricsFailure(summary)) {
    return "Repair condition evaluation handoff before retrying: train-complete condition states such as completed_training must be evaluated before final metrics are written, task_metrics must be populated from objective scoring, train-only completion must not be emitted as final condition evidence, and runtime-only objects such as model/tokenizer must be kept out of metrics.json condition rows.";
  }
  if (detectEvaluationInvocationBridgeFailure(summary)) {
    return "Repair the evaluation invocation bridge before retrying: inspect the evaluator signature, pass the condition state/result plus data, task, runtime, and artifact-path context through supported keyword aliases such as state, condition_state, condition_result, task_bundle, eval_examples_by_task, runtime, runtime_context, run_context, and artifact_paths, and fail with signature diagnostics instead of dropping required arguments.";
  }
  if (detectRecordShapeIndexingFailure(summary)) {
    return "Repair record shape normalization before retrying: generated runners must normalize mapping, list/tuple, dataclass, and attribute-style condition/data/evaluation records before field access, must not index mapping records with numeric keys such as [0], and must emit schema diagnostics identifying the record family before writing failed condition rows.";
  }
  if (detectConditionSpecNormalizationFailure(summary)) {
    return "Repair condition normalization before retrying: generated runners must normalize tuple, mapping, dataclass, and attribute-style condition records into a single condition spec with numeric-setting and name accessors before condition execution, and must preserve stable condition identifiers in metrics rows.";
  }
  if (detectTrainingExamplesUnavailableFailure(summary)) {
    return "Repair data materialization before retrying: generated runners must load real bounded training examples and evaluation examples from the declared reusable dataset/task contract, preserve train_records/train_examples aliases, preserve usable text from common fields such as instruction, input, output, prompt, response, text, question, answer, messages, and conversations, and fail at data_access with loader diagnostics instead of executing conditions with an empty train set.";
  }
  if (detectEvaluationNoObjectiveMetricFailure(summary)) {
    return "Repair evaluation data normalization before retrying: preserve or map objective labels such as gold, label, answer, answer_index, correct_index, and answerKey, keep evaluated counts nonzero when requested examples exist, and emit schema diagnostics instead of null objective observations.";
  }
  return "Repair the experiment implementation so metrics.json records completed execution, the configured objective observation, and any comparison explicitly required by the experiment contract instead of a top-level failed status.";
}

function buildMetricsContractSuggestedNextAction(summary: string): string {
  if (detectEvaluationNoObjectiveMetricFailure(summary)) {
    return "Repair metrics aggregation before retrying: preserve explicitly recorded metric ids and numeric observations in condition-level objective rows, exclude train-only runtime fields such as model/tokenizer from metrics.json, and emit a relative comparison only when the runner explicitly records its operands and role pair.";
  }
  return "Repair the experiment implementation so completed metrics include the configured objective metric and every comparison explicitly required by the experiment contract before analysis proceeds.";
}

function detectRuntimeConfigAttributeFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /(?:AttributeError|has no attribute)[^|.;]*(?:Namespace|args|config|Config|Budget|budget)[^|.;]*(?:allow_model_download|allow_model_downloads|local_files_only|cache_dir|trust_remote_code|output_dir|public_dir|run_artifact_dir|artifact_dir|artifacts_dir|condition_output_dir|condition_dir|metrics_path|paths|output_paths|artifact_paths|experiment_paths|runtime_paths|seed|max_train_examples|max_eval_examples_per_task|max_steps|max_seq_len|ensure_dirs|ensure_output_dirs|ensure_runtime_dirs)/iu.test(normalized) ||
    /(?:Namespace|args|config|Config|Budget|budget)[^|.;]*(?:has no attribute)[^|.;]*(?:allow_model_download|allow_model_downloads|local_files_only|cache_dir|trust_remote_code|output_dir|public_dir|run_artifact_dir|artifact_dir|artifacts_dir|condition_output_dir|condition_dir|metrics_path|paths|output_paths|artifact_paths|experiment_paths|runtime_paths|seed|max_train_examples|max_eval_examples_per_task|max_steps|max_seq_len|ensure_dirs|ensure_output_dirs|ensure_runtime_dirs)/iu.test(normalized) ||
    /(?:AttributeError|has no attribute)[^|.;]*(?:Namespace|args|config|Config|Budget|budget)[^|.;]*has no attribute/iu.test(normalized)
  );
}

function detectMissingExecutionDataBundleArgumentFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " " ).trim();
  if (!normalized) {
    return false;
  }
  return /Cannot call [^|.;]*(?:without required argument|missing required arguments?)[^|.;]*(?:task_bundle|task_bundles|task_data|task_dataset|dataset_bundle|data_bundle|eval_examples_by_task|evaluation_examples_by_task|eval_sets|evaluation_sets|task_sets|task_examples_by_name|benchmark_examples|benchmark_samples|train_examples|training_examples|train_records|training_records|train_rows|training_rows|train_bundle|training_bundle|train_source|training_source|run|runtime|runtime_context|run_context|condition_result|condition_state|paths|output_paths|artifact_paths|experiment_paths|runtime_paths)/iu.test(normalized);
}

function detectEvaluationInvocationBridgeFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /evaluation call failed[^|.;]*(?:Cannot call|TypeError|missing required|without required argument)[^|.;]*(?:state|condition_state|condition_result|task_bundle|eval_examples_by_task|runtime|runtime_context|run_context|artifact_paths)/iu.test(normalized) ||
    /Cannot call [^|.;]*(?:evaluate|score|eval)[^|.;]*(?:without required argument|missing required arguments?)[^|.;]*(?:state|condition_state|condition_result|task_bundle|eval_examples_by_task|runtime|runtime_context|run_context|artifact_paths)/iu.test(normalized) ||
    /(?:evaluate_condition|score_condition|run_evaluation)[^|.;]*(?:missing required|without required argument)[^|.;]*(?:state|condition_state|condition_result|task_bundle|eval_examples_by_task|runtime|runtime_context|run_context|artifact_paths)/iu.test(normalized)
  );
}

function detectRecordShapeIndexingFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /(?:condition_result_reasons|failure_reason|reason)[^|.;]*(?:KeyError\((?:0|1|2)\)|KeyError:\s*(?:0|1|2)|KeyError["']?\s*(?:0|1|2))/iu.test(normalized) ||
    /KeyError\((?:0|1|2)\)[^|.;]*(?:condition|record|row|example|sample|task|evaluation|data)/iu.test(normalized) ||
    /(?:condition|record|row|example|sample|task|evaluation|data)[^|.;]*KeyError\((?:0|1|2)\)/iu.test(normalized)
  );
}

function detectEvaluationRecordScalarNormalizationFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /argument of type \\*['"](?:int|float|bool|NoneType)\\*['"] is not iterable/iu.test(normalized) &&
    /(?:evaluation|eval|task|dataset|data_access|schema_failures|missing_eval_tasks|objective|label|answer|gold|correct_index|answerKey)/iu.test(normalized)
  );
}

function detectTrainingExamplesUnavailableFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /No training examples were supplied/iu.test(normalized) ||
    /no training examples were provided/iu.test(normalized) ||
    /training examples normalized to zero usable instruction texts/iu.test(normalized) ||
    /zero usable instruction texts/iu.test(normalized) ||
    /zero usable instruction\/training texts/iu.test(normalized) ||
    /zero usable training texts(?: after normalization)?/iu.test(normalized) ||
    /data_access[^|.;]*zero usable (?:instruction\/training|instruction|training) texts/iu.test(normalized) ||
    /data_access_failure[^|.;]*zero usable training texts/iu.test(normalized) ||
    /missing train (?:examples|rows|records)/iu.test(normalized) ||
    /Experiment data bundle could not be materialized/iu.test(normalized) ||
    /No real training records were loaded/iu.test(normalized) ||
    /completed_condition_count=0\/\d+[^|]*(?:train|training)[^|]*(?:empty|missing|supplied|loaded)/iu.test(normalized)
  );
}

function detectConditionSpecNormalizationFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /(?:AttributeError|has no attribute)[^|.;]*(?:tuple|list|dict|mapping)[^|.;]*(?:parameter|condition|marker|name)/iu.test(normalized) ||
    /condition[_ ]?(?:spec|record|row)[^|.;]*(?:tuple|mapping|dict)[^|.;]*(?:parameter|marker|name)/iu.test(normalized) ||
    /condition_result_samples=condition,status=failed,reason=AttributeError/iu.test(normalized)
  );
}

function detectEvaluationNoObjectiveMetricFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /evaluation produced no objective metric/iu.test(normalized) ||
    /completed_condition_missing_evaluation_metrics=\d+\/\d+/iu.test(normalized) ||
    /(?:objective|primary)[ _-]?(?:metric|observation|value)[^|.;]*(?:null|none|nan)/iu.test(normalized)
  );
}

function detectTrainCompleteEvaluationSkippedFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /condition_evaluation_statuses=[^|.;]*skipped_not_completed(?!_training)/iu.test(normalized) ||
    /evaluation_status["'=:\s]+skipped_not_completed(?!_training)/iu.test(normalized) ||
    /skipped_not_completed(?!_training)[^|.;]*(?:completed_training|training_completed|train_complete)/iu.test(normalized) ||
    /(?:completed_training|training_completed|train_complete)[^|.;]*skipped_not_completed(?!_training)/iu.test(normalized)
  );
}

function detectTrainCompleteWithoutEvaluationMetricsFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /completed_condition_count=0\/\d+[^|.;]*primary_(?:metric|observation)_value:null[^|.;]*condition_result_statuses=[^|.;]*(?:completed_training|training_completed|train_complete)/iu.test(normalized) ||
    /condition_result_statuses=[^|.;]*(?:completed_training|training_completed|train_complete)[^|.;]*primary_(?:metric|observation)_value:null/iu.test(normalized) ||
    /condition_result_samples=[^|.;]*(?:status=completed_training|status=training_completed|status=train_complete)/iu.test(normalized)
  );
}

function detectEvaluationRuntimeHandleFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /completed condition did not expose [^|.;]*(?:model|tokenizer|runtime handle|model bundle)/iu.test(normalized) ||
    /(?:model bundle|runtime handle|model\/tokenizer)[^|.;]*(?:missing|omitted|discarded|not expose|unavailable)/iu.test(normalized) ||
    /(?:condition result|condition state)[^|.;]*(?:model|tokenizer|runtime handle)[^|.;]*(?:missing|omitted|discarded|unavailable)/iu.test(normalized)
  );
}

function detectEvaluationArtifactReloadFailure(output: string): boolean {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return false;
  }
  return (
    /condition_training_statuses=[^|.;]*(?:evaluation_failed_runtime_load|evaluation_failed_artifact_load|artifact_reload_failed)/iu.test(normalized) ||
    /(?:evaluation_failed_runtime_load|evaluation_failed_artifact_load|artifact_reload_failed)/iu.test(normalized) ||
    /Can't find ['"][^'"]*(?:model|runtime|artifact|checkpoint)[^'"]*['"] at ['"]\.(?:\/)?['"]/iu.test(normalized) ||
    /(?:from_pretrained|reload|load_runtime|load_artifact)[^|.;]*(?:['"]\.['"]|process cwd|current working directory|cwd)[^|.;]*(?:missing|not found|can't find|absent|invalid)/iu.test(normalized) ||
    /(?:trained artifact|artifact directory|checkpoint directory|runtime artifact)[^|.;]*(?:missing|not found|absent|invalid|empty)/iu.test(normalized)
  );
}

function detectModelDownloadOrCacheFailure(output: string): string | undefined {
  const normalized = output.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  const dependencyPattern =
    /\b(?:hugging\s*face|huggingface|xet|xethub|from_pretrained|local_files_only|cache_dir|model_cache|tokenizer|model download|download|downloading|\.incomplete|temporary failure in name resolution|failed to lookup address information|name or service not known|connection timed out|read timed out|network is unreachable)\b/iu;
  if (!dependencyPattern.test(normalized)) {
    return undefined;
  }
  const evidence =
    normalized.match(
      /(?:Temporary failure in name resolution|failed to lookup address information|xet|xethub|from_pretrained|local_files_only|cache_dir|\.incomplete|download(?:ing)?|Read timed out|Connection timed out|Network is unreachable)[^|]{0,220}/iu
    )?.[0] || normalized.slice(0, 240);
  return `model_download_or_cache_failure=true | dependency_evidence=${evidence.slice(0, 240)}`;
}

function detectSentinelWatchdogFindings(
  metrics: Record<string, unknown>
): Array<{
  code: "nan_or_inf_metric" | "statistical_anomaly" | "citation_reliability_anomaly";
  severity: "warning" | "fail";
  message: string;
  requires_human_review: boolean;
  downgrade_to_unverified?: boolean;
}> {
  const findings: Array<{
    code: "nan_or_inf_metric" | "statistical_anomaly" | "citation_reliability_anomaly";
    severity: "warning" | "fail";
    message: string;
    requires_human_review: boolean;
    downgrade_to_unverified?: boolean;
  }> = [];
  const flat = flattenMetricValues(metrics);

  for (const entry of flat) {
    if (typeof entry.value === "string" && /^(nan|inf|-inf|infinity|-infinity)$/iu.test(entry.value.trim())) {
      findings.push({
        code: "nan_or_inf_metric",
        severity: "fail",
        message: `Sentinel watchdog blocked the run because ${entry.path} resolved to ${entry.value}.`,
        requires_human_review: true
      });
      return findings;
    }
  }

  for (const entry of flat) {
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
      continue;
    }
    if (/(citation_reliability|citation_confidence)$/iu.test(entry.path) && entry.value < 0.5) {
      findings.push({
        code: "citation_reliability_anomaly",
        severity: "warning",
        message: `Sentinel watchdog flagged low citation reliability at ${entry.path}=${entry.value}.`,
        requires_human_review: true,
        downgrade_to_unverified: true
      });
    }
  }

  return findings;
}

function detectFailedMetricsPayload(metrics: Record<string, unknown>): string | null {
  const status = typeof metrics.status === "string" ? metrics.status.trim().toLowerCase() : "";
  const success = metrics.success;
  const failure = metrics.failure && typeof metrics.failure === "object" && !Array.isArray(metrics.failure)
    ? metrics.failure as Record<string, unknown>
    : undefined;
  const directErrorMessage = typeof metrics.error === "string" && metrics.error.trim()
    ? metrics.error.trim()
    : undefined;
  const errorRecord = asRecord(metrics.error);
  const nestedErrorMessage = asString(errorRecord.message) || asString(errorRecord.error);
  const nestedErrorType = asString(errorRecord.type);
  const failureMessage =
    typeof failure?.message === "string" && failure.message.trim()
      ? failure.message.trim()
      : typeof metrics.error_message === "string" && metrics.error_message.trim()
        ? metrics.error_message.trim()
        : directErrorMessage ||
          (nestedErrorMessage
            ? `${nestedErrorType ? `${nestedErrorType}: ` : ""}${nestedErrorMessage}`
            : undefined);
  const distinctFailures = collectDistinctMetricsFailures(metrics);
  const explicitFailureCode = asString(metrics.failure_code) || asString(failure?.failure_code);
  const distinctFailureCodes = [...new Set(
    distinctFailures.map((item) => item.code).filter((value): value is string => Boolean(value))
  )];
  const representativeFailureCode = explicitFailureCode ||
    (distinctFailureCodes.length === 1 ? distinctFailureCodes[0] : undefined);
  const dependencyBlocked =
    status === "dependency_blocked" ||
    status === "dependency_failed" ||
    [explicitFailureCode, ...distinctFailureCodes].some((code) =>
      /(?:^|_)dependency(?:_|$)/iu.test(code || "") || /_unavailable$/iu.test(code || "")
    );

  if (isFailureLikeMetricsStatus(status)) {
    const prefix = dependencyBlocked
      ? `Experiment dependency blocked${representativeFailureCode ? ` (${representativeFailureCode})` : ""}`
      : "Experiment metrics payload reports failed status";
    return appendMetricsFailureEvidence(
      `${prefix}${failureMessage ? `: ${failureMessage}` : "."}`,
      metrics
    );
  }
  if (success === false) {
    return appendMetricsFailureEvidence(
      `Experiment metrics payload reports success=false${failureMessage ? `: ${failureMessage}` : "."}`,
      metrics
    );
  }
  const conditionDependencyBlocker = detectConditionDependencyBlocker(metrics);
  if (conditionDependencyBlocker) {
    return conditionDependencyBlocker;
  }
  const recipes = asRecord(metrics.recipes);
  const failedRecipeSummaries = Object.entries(recipes)
    .filter(([, recipe]) => {
      const recipeRecord = asRecord(recipe);
      const recipeStatus = typeof recipeRecord.status === "string" ? recipeRecord.status.trim().toLowerCase() : "";
      return isFailureLikeMetricsStatus(recipeStatus);
    })
    .map(([name, recipe]) => {
      const recipeRecord = asRecord(recipe);
      const recipeError = typeof recipeRecord.error === "string" && recipeRecord.error.trim()
        ? recipeRecord.error.trim()
        : undefined;
      return recipeError ? `${name}: ${recipeError}` : name;
    });
  if (failedRecipeSummaries.length > 0) {
    return `Experiment metrics payload reports failed recipe(s): ${failedRecipeSummaries.join("; ")}.`;
  }
  return null;
}

function collectDistinctMetricsFailures(metrics: Record<string, unknown>): Array<{
  code?: string;
  reason?: string;
}> {
  const failures: Array<{ code?: string; reason?: string }> = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    const record = asRecord(value);
    if (Object.keys(record).length === 0) {
      return;
    }
    const status = asString(record.status)?.toLowerCase();
    const code =
      asString(record.failure_code) ||
      asString(record.error_code) ||
      asString(record.code) ||
      asString(record.type) ||
      asString(asRecord(record.error).type);
    const reason =
      asString(record.failure_reason) ||
      asString(record.reason) ||
      asString(record.message) ||
      asString(record.error) ||
      asString(asRecord(record.error).message) ||
      asString(asRecord(record.exception).message);
    if (!code && !reason && (!status || !isFailureLikeMetricsStatus(status))) {
      return;
    }
    const key = `${code || ""}\u0000${reason || ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    failures.push({ code, reason });
  };
  const addMany = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        add(item);
      }
      return;
    }
    add(value);
  };

  addMany(metrics.failure);
  addMany(metrics.failures);
  const result = asRecord(metrics.result);
  addMany(result.failure);
  addMany(result.failures);
  for (const rows of [
    metrics.condition_results,
    metrics.raw_condition_results,
    metrics.condition_seed_rows,
    metrics.condition_states,
    metrics.per_seed_rows,
    metrics.seed_results,
    result.condition_results,
    result.failures
  ]) {
    addMany(rows);
  }
  return failures;
}

function isFailureLikeMetricsStatus(status: string): boolean {
  return (
    ["failed", "failure", "error", "errored"].includes(status) ||
    /(?:^|[_-])(?:failed|failure|error|errored|blocked|crashed|exception)(?:$|[_-])/iu.test(status)
  );
}

async function loadFailedMetricsSummary(
  metricsPath: string | undefined,
  artifactDir?: string,
  publicDir?: string
): Promise<string | undefined> {
  if (!metricsPath || !(await fileExists(metricsPath))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(metricsPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return appendExperimentFailureArtifactEvidence(
      detectFailedMetricsPayload(parsed as Record<string, unknown>) || undefined,
      await loadExperimentFailureArtifactSummary(artifactDir, publicDir)
    );
  } catch {
    return undefined;
  }
}

function appendExperimentFailureArtifactEvidence(
  message: string | null | undefined,
  artifactSummary: string | undefined
): string | undefined {
  if (!message) {
    return undefined;
  }
  return artifactSummary ? `${message} ${artifactSummary}` : message;
}

async function loadExperimentFailureArtifactSummary(
  artifactDir: string | undefined,
  publicDir?: string
): Promise<string | undefined> {
  if (!artifactDir && !publicDir) {
    return undefined;
  }
  const summaries: string[] = [];
  if (artifactDir) {
    const studyFailurePath = path.join(artifactDir, "study_failure.json");
    const studyFailuresPath = path.join(artifactDir, "study_failures.json");
    const studyFailure = await readJsonRecordIfExists(studyFailurePath);
    if (studyFailure) {
      const summary = summarizeFailureRecord("study_failure.json", studyFailure);
      if (summary) {
        summaries.push(summary);
      }
    }
    const studyFailures = await readJsonArrayIfExists(studyFailuresPath);
    for (const failure of studyFailures.slice(0, 2)) {
      const summary = summarizeFailureRecord("study_failures.json", failure);
      if (summary) {
        summaries.push(summary);
      }
    }
  }
  const dataAccessSummary = await loadDataAccessPreviewSummary(publicDir, artifactDir);
  if (dataAccessSummary) {
    summaries.push(dataAccessSummary);
  }
  return summaries.length > 0 ? `Failure artifact evidence: ${summaries.join(" | ")}.` : undefined;
}

async function loadDataAccessPreviewSummary(
  publicDir: string | undefined,
  artifactDir?: string
): Promise<string | undefined> {
  const candidates = [publicDir, artifactDir]
    .filter((candidate): candidate is string => Boolean(candidate))
    .flatMap((candidate) => [candidate, path.join(candidate, "experiment")]);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const previewPath = path.join(candidate, "data_access_preview.json");
    if (seen.has(previewPath)) {
      continue;
    }
    seen.add(previewPath);
    const preview = await readJsonRecordIfExists(previewPath);
    if (!preview) {
      continue;
    }
    const parts = summarizeDataAccessPreview(preview);
    if (parts.length > 0) {
      return `data_access_preview.json; ${parts.join("; ")}`;
    }
  }
  return undefined;
}

function summarizeDataAccessPreview(preview: Record<string, unknown>): string[] {
  const parts: string[] = [];
  const trainCount = asNumber(preview.train_count);
  if (trainCount !== undefined) {
    parts.push(`train_count=${trainCount}`);
    if (trainCount === 0) {
      parts.push("zero usable instruction/training texts");
    }
  }
  const evalCounts = asRecord(preview.eval_counts);
  const evalCountEntries = Object.entries(evalCounts)
    .map(([task, count]) => {
      const numericCount = asNumber(count);
      return numericCount === undefined ? undefined : `${task}:${numericCount}`;
    })
    .filter((entry): entry is string => Boolean(entry));
  if (evalCountEntries.length > 0) {
    parts.push(`eval_counts=${evalCountEntries.slice(0, 6).join(",")}`);
  }
  const diagnostics = asRecord(preview.diagnostics);
  const schemaErrors = Array.isArray(diagnostics.schema_errors)
    ? diagnostics.schema_errors
        .map((item) => asString(item))
        .filter((item): item is string => Boolean(item))
    : [];
  if (schemaErrors.length > 0) {
    parts.push(`schema_errors=${schemaErrors.slice(0, 3).map((item) => trimShort(item, 160)).join(" | ")}`);
  }
  const tasks = asRecord(diagnostics.tasks);
  const trainCounts = Object.entries(tasks)
    .map(([task, value]) => {
      const taskRecord = asRecord(value);
      const count = asNumber(taskRecord.normalized_train_count);
      return count === undefined ? undefined : `${task}:${count}`;
    })
    .filter((entry): entry is string => Boolean(entry));
  if (trainCounts.length > 0) {
    parts.push(`task_train_counts=${trainCounts.slice(0, 6).join(",")}`);
  }
  return parts;
}

async function readJsonRecordIfExists(filePath: string): Promise<Record<string, unknown> | undefined> {
  if (!(await fileExists(filePath))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonArrayIfExists(filePath: string): Promise<Record<string, unknown>[]> {
  if (!(await fileExists(filePath))) {
    return [];
  }
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];
  } catch {
    return [];
  }
}

function summarizeFailureRecord(label: string, failure: Record<string, unknown>): string | undefined {
  const error = asString(failure.error) || asString(failure.message);
  const type = asString(failure.type);
  const tracebackTail = tracebackLastLine(asString(failure.traceback));
  const parts = [
    `${label}`,
    type ? `type=${trimShort(type, 80)}` : undefined,
    error ? `error=${trimShort(error, 220)}` : undefined,
    tracebackTail && tracebackTail !== error ? `traceback_tail=${trimShort(tracebackTail, 220)}` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length > 1 ? parts.join("; ") : undefined;
}

function trimShort(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, Math.max(0, maxLength - 1))}...` : compact;
}

function tracebackLastLine(traceback: string | undefined): string | undefined {
  if (!traceback) {
    return undefined;
  }
  const lines = traceback
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1);
}

function appendMetricsFailureEvidence(message: string, metrics: Record<string, unknown>): string {
  const evidence = summarizeMetricsFailureEvidence(metrics);
  return evidence ? `${message} ${evidence}` : message;
}

function summarizeMetricsFailureEvidence(metrics: Record<string, unknown>): string {
  const parts: string[] = [];
  const status = asString(metrics.status);
  if (status && isFailureLikeMetricsStatus(status.toLowerCase())) {
    parts.push(`metrics_status=${trimShort(status, 80)}`);
  }
  const failureRecord = asRecord(metrics.failure);
  const distinctFailures = collectDistinctMetricsFailures(metrics);
  const failureCodes = [...new Set([
    asString(metrics.failure_code),
    asString(failureRecord.failure_code),
    ...distinctFailures.map((item) => item.code)
  ].filter((value): value is string => Boolean(value)))];
  if (failureCodes.length === 1) {
    parts.push(`failure_code=${trimShort(failureCodes[0], 120)}`);
  } else if (failureCodes.length > 1) {
    parts.push(`failure_codes=${failureCodes.slice(0, 8).map((code) => trimShort(code, 120)).join(",")}`);
  }
  if (distinctFailures.length > 0) {
    const boundedFailures = distinctFailures.slice(0, 8).map((item) => [
      item.code ? `code=${trimShort(item.code, 80)}` : undefined,
      item.reason ? `reason=${trimShort(item.reason, 180)}` : undefined
    ].filter((value): value is string => Boolean(value)).join(","));
    const omitted = distinctFailures.length - boundedFailures.length;
    parts.push(
      `distinct_failures=${boundedFailures.join(" | ")}${omitted > 0 ? ` | +${omitted} more distinct failure(s)` : ""}`
    );
  }
  const loaderDiagnostics = summarizeLoaderDiagnostics(metrics);
  if (loaderDiagnostics.length > 0) {
    parts.push(`loader_diagnostics=${loaderDiagnostics.join(" | ")}`);
  }

  const requiredRunCount = asNumber(metrics.required_run_count);
  const completedRunCount = asNumber(metrics.completed_run_count);
  if (requiredRunCount !== undefined && completedRunCount !== undefined) {
    parts.push(`completed_run_count=${completedRunCount}/${requiredRunCount}`);
  }

  const requiredConditionCount = asNumber(metrics.required_condition_count);
  const completedConditionCount = asNumber(metrics.completed_condition_count);
  if (requiredConditionCount !== undefined && completedConditionCount !== undefined) {
    parts.push(`completed_condition_count=${completedConditionCount}/${requiredConditionCount}`);
  }

  const failureCount = asNumber(metrics.failure_count) ?? asNumber(metrics.failed_run_count);
  if (failureCount !== undefined) {
    parts.push(`failure_count=${failureCount}`);
  }

  if (Object.prototype.hasOwnProperty.call(metrics, "selected_model") && metrics.selected_model == null) {
    parts.push("selected_model=null");
  }
  const selectedModelId = asString(metrics.selected_model_id);
  if (selectedModelId) {
    parts.push(`selected_model_id=${trimShort(selectedModelId, 120)}`);
  }

  const directErrorMessage = typeof metrics.error === "string" && metrics.error.trim()
    ? metrics.error.trim()
    : undefined;
  const errorRecord = asRecord(metrics.error);
  const nestedErrorMessage = asString(errorRecord.message) || asString(errorRecord.error);
  if (directErrorMessage || nestedErrorMessage) {
    const nestedErrorType = asString(errorRecord.type);
    const errorText = directErrorMessage || `${nestedErrorType ? `${nestedErrorType}: ` : ""}${nestedErrorMessage}`;
    parts.push(`metrics_error=${trimShort(errorText, 220)}`);
  }

  const errorMessages = summarizeMetricsErrorMessages(metrics);
  if (errorMessages.length > 0) {
    parts.push(`metrics_error_messages=${errorMessages.join(" | ")}`);
  }

  const evidenceMessages = summarizeMetricsEvidenceRecords(metrics);
  if (evidenceMessages.length > 0) {
    parts.push(`metrics_evidence=${evidenceMessages.join(" | ")}`);
  }

  const nestedFailureMessages = summarizeNestedFailureRecords(metrics);
  if (nestedFailureMessages.length > 0) {
    parts.push(`nested_failures=${nestedFailureMessages.join(" | ")}`);
  }

  const evaluationHandoffMessages = summarizeConditionEvaluationHandoffEvidence(metrics);
  if (evaluationHandoffMessages.length > 0) {
    parts.push(...evaluationHandoffMessages);
  }

  const seedFailureMessages = summarizeSeedFailureMessages(metrics);
  if (seedFailureMessages.length > 0) {
    parts.push(`seed_failure_messages=${seedFailureMessages.join(" | ")}`);
  }

  parts.push(...summarizePrimaryMetricValueEvidence(metrics));
  parts.push(...summarizeConditionStateFailureEvidence(metrics));
  parts.push(...summarizeConditionResultFailureEvidence(metrics));

  const observedConditionCount = asNumber(metrics.observed_condition_count);
  if (observedConditionCount !== undefined) {
    parts.push(`observed_condition_count=${observedConditionCount}`);
  }

  const missingMarkers = Array.isArray(metrics.missing_required_condition_markers)
    ? metrics.missing_required_condition_markers.filter((marker): marker is string => typeof marker === "string")
    : [];
  if (missingMarkers.length > 0) {
    parts.push(`missing_required_condition_markers=${missingMarkers.slice(0, 8).join(",")}`);
  }

  const conditionResultsPath = asString(metrics.condition_results_path);
  if (conditionResultsPath) {
    parts.push(`condition_results_path=${conditionResultsPath}`);
  }

  return parts.length > 0 ? `Metrics evidence: ${parts.join("; ")}.` : "";
}


function summarizeLoaderDiagnostics(metrics: Record<string, unknown>): string[] {
  const summaries: string[] = [];
  const addSummary = (value: string | undefined) => {
    if (!value || summaries.length >= 3 || summaries.includes(value)) {
      return;
    }
    summaries.push(value);
  };
  const collectLoaderFailures = (value: unknown): unknown[] => {
    const record = asRecord(value);
    const loaderFailures = record.loader_failures;
    return Array.isArray(loaderFailures) ? loaderFailures : [];
  };
  const sources: unknown[] = [metrics.diagnostics];
  for (const failure of Array.isArray(metrics.failures) ? metrics.failures : []) {
    sources.push(asRecord(failure).diagnostics);
  }
  for (const source of sources) {
    for (const item of collectLoaderFailures(source)) {
      const failure = asRecord(item);
      const diagnostics = asRecord(failure.diagnostics);
      const loaderName = asString(failure.loader);
      const stage = asString(diagnostics.stage);
      const task = asString(diagnostics.task);
      const usableCount = asNumber(diagnostics.usable_count);
      const requiredCount = asNumber(diagnostics.required_count);
      const fields = [
        loaderName ? `loader=${trimShort(loaderName, 80)}` : undefined,
        stage ? `stage=${trimShort(stage, 80)}` : undefined,
        task ? `task=${trimShort(task, 80)}` : undefined,
        typeof diagnostics.allow_dataset_download === "boolean" ? `allow_dataset_download=${diagnostics.allow_dataset_download}` : undefined,
        usableCount !== undefined ? `usable_count=${usableCount}` : undefined,
        requiredCount !== undefined ? `required_count=${requiredCount}` : undefined
      ].filter((field): field is string => Boolean(field));
      addSummary(fields.join(","));
    }
  }
  return summaries;
}

function summarizeMetricsErrorMessages(metrics: Record<string, unknown>): string[] {
  const messages: string[] = [];
  const addMessage = (value: unknown) => {
    if (messages.length >= 3) {
      return;
    }
    const text = asString(value);
    if (!text) {
      return;
    }
    const summary = trimShort(text, 220);
    if (!messages.includes(summary)) {
      messages.push(summary);
    }
  };
  const addMessages = (value: unknown) => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      addMessage(item);
    }
  };

  addMessage(metrics.error_message);
  addMessages(metrics.error_messages);
  addMessages(asRecord(metrics.baseline_summary)?.error_messages);
  const conditionSummaries = Array.isArray(metrics.condition_summaries) ? metrics.condition_summaries : [];
  for (const conditionSummary of conditionSummaries) {
    if (messages.length >= 3) {
      break;
    }
    const condition = asRecord(conditionSummary);
    addMessage(condition.error_message);
    addMessages(condition.error_messages);
  }
  const backendAttempts = collectConditionRows(asRecord(metrics.backend).attempts);
  for (const attempt of backendAttempts) {
    if (messages.length >= 3) {
      break;
    }
    addMessage(attempt.error);
  }

  return messages;
}

async function currentRunExperimentsHarnessUpdatedAt(): Promise<number | undefined> {
  try {
    const stats = await fs.stat(new URL(import.meta.url));
    return stats.mtimeMs;
  } catch {
    return undefined;
  }
}


function summarizeNestedFailureRecords(metrics: Record<string, unknown>): string[] {
  const summaries: string[] = [];
  const failureStatusPattern = /^(?:failed|failure|error|errored|blocked|dependency_blocked|dependency_failed|partial|partial_completed)$/iu;
  const hasRecordFields = (record: Record<string, unknown>) => Object.keys(record).length > 0;
  const addSummary = (summary: string | undefined) => {
    if (!summary || summaries.length >= 3 || summaries.includes(summary)) {
      return;
    }
    summaries.push(summary);
  };
  const addFailure = (value: unknown, fallbackStatus?: string) => {
    if (value === undefined || value === null) {
      return;
    }
    const record = asRecord(value);
    if (!hasRecordFields(record)) {
      const text = asString(value);
      if (text) {
        addSummary(trimShort(text, 220));
      } else if (fallbackStatus && failureStatusPattern.test(fallbackStatus)) {
        addSummary(`status=${trimShort(fallbackStatus, 80)}`);
      }
      return;
    }
    const status = asString(record.status) || fallbackStatus;
    const kind =
      asString(record.failure_code) ||
      asString(record.error_code) ||
      asString(record.code) ||
      asString(record.type) ||
      asString(asRecord(record.error)?.type);
    const message =
      asString(record.message) ||
      asString(record.error) ||
      asString(record.failure_reason) ||
      asString(asRecord(record.error)?.message) ||
      asString(asRecord(record.exception)?.message);
    const tracebackTail =
      tracebackLastLine(asString(record.traceback)) ||
      tracebackLastLine(asString(record.failure_traceback)) ||
      tracebackLastLine(asString(record.stack_trace)) ||
      tracebackLastLine(asString(record.exception_traceback));
    const summary = [
      kind ? trimShort(kind, 80) : status && failureStatusPattern.test(status) ? `status=${trimShort(status, 80)}` : undefined,
      message ? trimShort(message, 220) : undefined,
      tracebackTail && tracebackTail !== message ? trimShort(tracebackTail, 220) : undefined
    ].filter((part): part is string => Boolean(part)).join(": ");
    addSummary(summary);
  };
  const addFailures = (value: unknown, fallbackStatus?: string) => {
    if (value === undefined || value === null) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        addFailure(item, fallbackStatus);
      }
      return;
    }
    addFailure(value, fallbackStatus);
  };

  addFailures(metrics.failures, asString(metrics.status));
  addFailures(metrics.failure, asString(metrics.status));
  const result = asRecord(metrics.result);
  if (hasRecordFields(result)) {
    const resultStatus = asString(result.status);
    addFailures(result.failures, resultStatus);
    addFailures(result.failure, resultStatus);
    const resultError = result.error;
    if (typeof resultError === "object" && resultError !== null) {
      addFailure(resultError, resultStatus);
    }
    if (summaries.length === 0 && resultStatus && failureStatusPattern.test(resultStatus)) {
      addSummary(`status=${trimShort(resultStatus, 80)}`);
    }
  }

  return summaries;
}

function summarizeMetricsEvidenceRecords(metrics: Record<string, unknown>): string[] {
  const evidence = Array.isArray(metrics.evidence) ? metrics.evidence : [];
  const summaries: string[] = [];
  for (const item of evidence) {
    if (summaries.length >= 2) {
      break;
    }
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const kind = asString(record.kind) || asString(record.type);
    const message =
      asString(record.message) ||
      asString(record.error) ||
      asString(asRecord(record.error)?.message);
    const tracebackTail = tracebackLastLine(asString(record.traceback));
    const summary = [
      kind ? trimShort(kind, 80) : undefined,
      message ? trimShort(message, 220) : undefined,
      tracebackTail && tracebackTail !== message ? trimShort(tracebackTail, 220) : undefined
    ].filter((part): part is string => Boolean(part)).join(": ");
    if (summary) {
      summaries.push(summary);
    }
  }
  return summaries;
}

function summarizePrimaryMetricValueEvidence(metrics: Record<string, unknown>): string[] {
  const objective = asRecord(metrics.objective);
  const resultsSelection = asRecord(metrics.results_selection);
  const keys = [
    asString(resultsSelection.metric_id),
    asString(metrics.primary_metric_key),
    asString(objective.primary_metric_key)
  ].filter((key): key is string => Boolean(key));
  const uniqueKeys = [...new Set(keys)];
  const parts: string[] = [];
  for (const key of uniqueKeys.slice(0, 2)) {
    if (Object.prototype.hasOwnProperty.call(metrics, key)) {
      if (asNumber(metrics[key]) === undefined) {
        parts.push(`primary_metric_value=${trimShort(key, 100)}:${describeMetricValue(metrics[key])}`);
      }
      continue;
    }
    parts.push(`primary_metric_value=${trimShort(key, 100)}:missing`);
  }
  return parts;
}

function describeMetricValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "missing";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object") {
    return "object";
  }
  if (typeof value === "string") {
    return value.trim() ? "non_numeric_string" : "empty_string";
  }
  return typeof value;
}

function summarizeConditionStateFailureEvidence(metrics: Record<string, unknown>): string[] {
  const study = asRecord(metrics.study);
  const studySummary = asRecord(metrics.study_summary);
  const conditionRows = [
    ...collectConditionRows(metrics.condition_states),
    ...collectConditionRows(metrics.condition_state_results),
    ...collectConditionRows(metrics.per_condition_states),
    ...collectConditionRows(metrics.run_rows),
    ...collectConditionRows(metrics.run_records),
    ...collectConditionRows(metrics.per_run_rows),
    ...collectConditionRows(study.condition_states),
    ...collectConditionRows(study.condition_state_results),
    ...collectConditionRows(study.per_condition_states),
    ...collectConditionRows(study.run_rows),
    ...collectConditionRows(study.run_records),
    ...collectConditionRows(study.per_run_rows),
    ...collectConditionRows(studySummary.condition_states),
    ...collectConditionRows(studySummary.condition_state_results),
    ...collectConditionRows(studySummary.per_condition_states),
    ...collectConditionRows(studySummary.run_rows),
    ...collectConditionRows(studySummary.run_records),
    ...collectConditionRows(studySummary.per_run_rows)
  ];
  if (conditionRows.length === 0) {
    return [];
  }

  const statusCounts = new Map<string, number>();
  const reasonCounts = new Map<string, number>();
  const failureCodeCounts = new Map<string, number>();
  const failureStageCounts = new Map<string, number>();
  const sampleFailures: string[] = [];

  for (const row of conditionRows) {
    const status = normalizeConditionResultStatus(row);
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    if (isCompletedConditionStatus(status)) {
      continue;
    }

    const reason = conditionResultReason(row);
    if (reason) {
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }

    const errorRecord = asRecord(row.error);
    const failureCode =
      asString(row.failure_code) ||
      asString(row.error_code) ||
      asString(row.error_type) ||
      asString(errorRecord.code) ||
      asString(errorRecord.type);
    if (failureCode) {
      failureCodeCounts.set(failureCode, (failureCodeCounts.get(failureCode) || 0) + 1);
    }

    const failureStage = asString(row.failure_stage) || asString(row.error_stage) || asString(row.stage);
    if (failureStage) {
      failureStageCounts.set(failureStage, (failureStageCounts.get(failureStage) || 0) + 1);
    }

    if (sampleFailures.length < 2) {
      const id = conditionResultId(row);
      const sample = [
        id ? trimShort(id, 80) : "unlabeled_condition",
        `status=${status}`,
        failureStage ? `stage=${trimShort(failureStage, 80)}` : undefined,
        reason ? `reason=${trimShort(reason, 120)}` : undefined
      ].filter((part): part is string => Boolean(part)).join(",");
      sampleFailures.push(sample);
    }
  }

  const parts = [`condition_state_statuses=${formatCountMap(statusCounts, 6)}`];
  const formattedReasons = formatCountMap(reasonCounts, 4);
  if (formattedReasons) {
    parts.push(`condition_state_reasons=${formattedReasons}`);
  }
  const formattedCodes = formatCountMap(failureCodeCounts, 4);
  if (formattedCodes) {
    parts.push(`condition_state_failure_codes=${formattedCodes}`);
  }
  const formattedStages = formatCountMap(failureStageCounts, 4);
  if (formattedStages) {
    parts.push(`condition_state_failure_stages=${formattedStages}`);
  }
  if (sampleFailures.length > 0) {
    parts.push(`condition_state_samples=${sampleFailures.join(" | ")}`);
  }
  return parts;
}

function summarizeConditionResultFailureEvidence(metrics: Record<string, unknown>): string[] {
  const study = asRecord(metrics.study);
  const studySummary = asRecord(metrics.study_summary);
  const conditionRows = [
    ...collectConditionRows(metrics.condition_results),
    ...collectConditionRows(metrics.conditions),
    ...collectConditionRows(metrics.raw_condition_results),
    ...collectConditionRows(study.condition_results),
    ...collectConditionRows(study.conditions),
    ...collectConditionRows(study.raw_condition_results),
    ...collectConditionRows(studySummary.condition_results),
    ...collectConditionRows(studySummary.conditions),
    ...collectConditionRows(studySummary.raw_condition_results)
  ];
  if (conditionRows.length === 0) {
    return [];
  }

  const statusCounts = new Map<string, number>();
  const reasonCounts = new Map<string, number>();
  const sampleFailures: string[] = [];
  for (const row of conditionRows) {
    const status = normalizeConditionResultStatus(row);
    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    if (isCompletedConditionStatus(status)) {
      continue;
    }
    const reason = conditionResultReason(row);
    if (reason) {
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
    if (sampleFailures.length < 2) {
      const id = conditionResultId(row);
      const sample = [
        id ? trimShort(id, 80) : "unlabeled_condition",
        `status=${status}`,
        reason ? `reason=${trimShort(reason, 120)}` : undefined
      ].filter((part): part is string => Boolean(part)).join(",");
      sampleFailures.push(sample);
    }
  }

  const parts = [`condition_result_statuses=${formatCountMap(statusCounts, 6)}`];
  const completedRows = conditionRows.filter((row) => isCompletedConditionStatus(normalizeConditionResultStatus(row)));
  if (completedRows.length > 0) {
    const metricKeyCounts = summarizeCompletedConditionMetricKeyCounts(completedRows);
    const formattedMetricKeys = formatCountMap(metricKeyCounts, 8);
    parts.push(`completed_condition_metric_keys=${formattedMetricKeys || "none"}`);
    const rowsWithoutEvaluationMetrics = completedRows.filter((row) => !conditionRowHasEvaluationMetric(row)).length;
    if (rowsWithoutEvaluationMetrics > 0) {
      parts.push(`completed_condition_missing_evaluation_metrics=${rowsWithoutEvaluationMetrics}/${completedRows.length}`);
    }
  }
  const formattedReasons = formatCountMap(reasonCounts, 4);
  if (formattedReasons) {
    parts.push(`condition_result_reasons=${formattedReasons}`);
  }
  if (sampleFailures.length > 0) {
    parts.push(`condition_result_samples=${sampleFailures.join(" | ")}`);
  }
  return parts;
}

function summarizeConditionEvaluationHandoffEvidence(metrics: Record<string, unknown>): string[] {
  const study = asRecord(metrics.study);
  const studySummary = asRecord(metrics.study_summary);
  const conditionRows = [
    ...collectConditionRows(metrics.condition_results),
    ...collectConditionRows(metrics.conditions),
    ...collectConditionRows(study.condition_results),
    ...collectConditionRows(study.conditions),
    ...collectConditionRows(studySummary.condition_results),
    ...collectConditionRows(studySummary.conditions)
  ];
  if (conditionRows.length === 0) {
    return [];
  }

  const evaluationStatusCounts = new Map<string, number>();
  const trainingStatusCounts = new Map<string, number>();
  for (const row of conditionRows) {
    const rawEvidence = asRecord(row.raw_evidence);
    const evaluationStatus = asString(row.evaluation_status) || asString(rawEvidence.evaluation_status);
    if (evaluationStatus) {
      const normalized = evaluationStatus.toLowerCase().replace(/\s+/gu, "_");
      evaluationStatusCounts.set(normalized, (evaluationStatusCounts.get(normalized) || 0) + 1);
    }
    const trainingStatus = asString(rawEvidence.status) || asString(row.training_status) || asString(rawEvidence.training_status);
    if (trainingStatus) {
      const normalized = trainingStatus.toLowerCase().replace(/\s+/gu, "_");
      trainingStatusCounts.set(normalized, (trainingStatusCounts.get(normalized) || 0) + 1);
    }
  }

  const parts: string[] = [];
  const formattedEvaluationStatuses = formatCountMap(evaluationStatusCounts, 6);
  if (formattedEvaluationStatuses) {
    parts.push(`condition_evaluation_statuses=${formattedEvaluationStatuses}`);
  }
  const formattedTrainingStatuses = formatCountMap(trainingStatusCounts, 6);
  if (formattedTrainingStatuses) {
    parts.push(`condition_training_statuses=${formattedTrainingStatuses}`);
  }
  return parts;
}

function summarizeCompletedConditionMetricKeyCounts(rows: Record<string, unknown>[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const key of conditionRowEvaluationMetricKeys(row)) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

function conditionRowHasEvaluationMetric(row: Record<string, unknown>): boolean {
  return conditionRowEvaluationMetricKeys(row).length > 0;
}

function conditionRowEvaluationMetricKeys(row: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  const raw = asRecord(row.raw_evidence);
  const candidates = [
    row,
    raw,
    asRecord(raw.raw_evidence),
    asRecord(row.result),
    asRecord(raw.result)
  ];
  const explicitMetricIds = new Set(
    candidates
      .flatMap((candidate) => [
        asString(candidate.metric_id),
        asString(candidate.metric_key),
        asString(candidate.primary_metric_key)
      ])
      .filter((value): value is string => Boolean(value))
  );
  for (const metricId of explicitMetricIds) {
    for (const candidate of candidates) {
      if (asNumber(candidate[metricId]) !== undefined) {
        keys.add(metricId);
      }
      if (asString(candidate.metric_id) === metricId && asNumber(candidate.value) !== undefined) {
        keys.add(`${metricId}:value`);
      }
    }
  }

  const addStructuredNumericLeaves = (
    record: Record<string, unknown>,
    prefix: string,
    depth = 0
  ): void => {
    if (depth > 2) {
      return;
    }
    for (const [key, value] of Object.entries(record)) {
      const path = `${prefix}.${key}`;
      if (asNumber(value) !== undefined) {
        keys.add(path);
        continue;
      }
      const nested = asRecord(value);
      if (Object.keys(nested).length > 0) {
        addStructuredNumericLeaves(nested, path, depth + 1);
      }
    }
  };
  for (const candidate of candidates) {
    for (const containerKey of ["metrics", "evaluation", "eval_result", "evaluation_result"]) {
      const record = asRecord(candidate[containerKey]);
      if (Object.keys(record).length > 0) {
        addStructuredNumericLeaves(record, containerKey);
      }
    }
  }
  return [...keys].sort();
}

function normalizeConditionResultStatus(row: Record<string, unknown>): string {
  const nestedRecords = conditionResultNestedRecords(row);
  for (const source of [row, ...nestedRecords]) {
    const explicitStatus = asString(source.status)?.toLowerCase().replace(/\s+/gu, "_");
    if (explicitStatus && !["unknown", "none", "null", "n_a", "na", "not_available"].includes(explicitStatus)) {
      return explicitStatus;
    }
  }
  for (const source of [row, ...nestedRecords]) {
    if (source.success === true || source.completed === true) {
      return "completed";
    }
    if (source.success === false || source.completed === false) {
      return "failed";
    }
  }
  return "unknown";
}

function isCompletedConditionStatus(status: string): boolean {
  return ["completed", "complete", "success", "succeeded", "ok", "passed"].includes(status);
}

function isFailedConditionStatus(status: string): boolean {
  return isFailureLikeMetricsStatus(status);
}

function conditionResultNestedRecords(row: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    asRecord(row.record),
    asRecord(row.raw_record),
    asRecord(row.evidence_record),
    asRecord(row.condition),
    asRecord(row.train_result),
    asRecord(row.training_result),
    asRecord(row.eval_result),
    asRecord(row.evaluation_result),
    asRecord(row.result),
    asRecord(row.raw_result),
    asRecord(row.condition_raw_result),
    asRecord(row.failure),
    asRecord(row.error)
  ].filter((record) => Object.keys(record).length > 0);
}

function conditionResultId(row: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    row.condition_marker,
    row.marker,
    row.condition_id,
    row.condition,
    row.name
  ];
  for (const nested of conditionResultNestedRecords(row)) {
    candidates.push(nested.condition_marker, nested.marker, nested.condition_id, nested.id, nested.name);
  }
  for (const candidate of candidates) {
    const value = asString(candidate);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function collectExecutionStatusRows(metrics: Record<string, unknown>): Array<Record<string, unknown>> {
  const study = asRecord(metrics.study);
  const studySummary = asRecord(metrics.study_summary);
  return [
    ...collectConditionRows(metrics.rows),
    ...collectConditionRows(metrics.raw_condition_results),
    ...collectConditionRows(metrics.condition_results),
    ...collectConditionRows(metrics.run_results),
    ...collectConditionRows(metrics.per_run_results),
    ...collectConditionRows(metrics.raw_results),
    ...collectConditionRows(metrics.seed_results),
    ...collectConditionRows(metrics.per_seed_rows),
    ...collectConditionRows(metrics.per_seed_results),
    ...collectConditionRows(metrics.condition_seed_rows),
    ...collectConditionRows(study.rows),
    ...collectConditionRows(study.run_results),
    ...collectConditionRows(study.per_run_results),
    ...collectConditionRows(study.raw_results),
    ...collectConditionRows(study.seed_results),
    ...collectConditionRows(study.per_seed_rows),
    ...collectConditionRows(studySummary.rows),
    ...collectConditionRows(studySummary.run_results),
    ...collectConditionRows(studySummary.per_run_results),
    ...collectConditionRows(studySummary.raw_results),
    ...collectConditionRows(studySummary.seed_results),
    ...collectConditionRows(studySummary.per_seed_rows)
  ].filter((row) => normalizeConditionResultStatus(row) !== "unknown");
}

function collectConditionSeedValues(row: Record<string, unknown>): unknown[] {
  const candidates: unknown[] = [row.seed, row.seed_id, row.random_seed, row.evaluation_seed];
  for (const nested of conditionResultNestedRecords(row)) {
    candidates.push(nested.seed, nested.seed_id, nested.random_seed, nested.evaluation_seed);
  }
  const rawEvidence = asRecord(row.raw_evidence);
  candidates.push(rawEvidence.seed, rawEvidence.seed_id, rawEvidence.random_seed, rawEvidence.evaluation_seed);
  for (const value of [row.seeds, row.seed_schedule, row.planned_seeds]) {
    if (Array.isArray(value)) {
      candidates.push(...value);
    }
  }
  return candidates.filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function collectSeedProvenanceRows(metrics: Record<string, unknown>): Array<Record<string, unknown>> {
  const study = asRecord(metrics.study);
  const studySummary = asRecord(metrics.study_summary);
  return [
    ...collectConditionRows(metrics.raw_condition_results),
    ...collectConditionRows(metrics.condition_results),
    ...collectConditionRows(metrics.condition_summaries),
    ...collectConditionRows(metrics.rows),
    ...collectConditionRows(metrics.run_results),
    ...collectConditionRows(metrics.per_run_results),
    ...collectConditionRows(metrics.raw_results),
    ...collectConditionRows(metrics.seed_results),
    ...collectConditionRows(metrics.per_seed_rows),
    ...collectConditionRows(metrics.per_seed_results),
    ...collectConditionRows(metrics.condition_seed_rows),
    ...collectConditionRows(study.raw_condition_results),
    ...collectConditionRows(study.condition_results),
    ...collectConditionRows(study.condition_summaries),
    ...collectConditionRows(study.run_results),
    ...collectConditionRows(study.per_run_results),
    ...collectConditionRows(study.seed_results),
    ...collectConditionRows(studySummary.raw_condition_results),
    ...collectConditionRows(studySummary.condition_results),
    ...collectConditionRows(studySummary.condition_summaries),
    ...collectConditionRows(studySummary.run_results),
    ...collectConditionRows(studySummary.per_run_results),
    ...collectConditionRows(studySummary.seed_results)
  ];
}

function conditionResultMarker(row: Record<string, unknown>): string | undefined {
  return (
    asString(row.condition_marker) ||
    asString(row.marker) ||
    asString(row.condition_id) ||
    asString(row.condition) ||
    asString(row.name)
  );
}

function conditionResultModelLoadReason(row: Record<string, unknown>): string | undefined {
  const errors = asRecord(row.model_load_errors);
  const entries = Object.entries(errors)
    .map(([modelId, message]) => {
      const text = asString(message) || JSON.stringify(message);
      return text ? modelId + ': ' + text : undefined;
    })
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 2);
  if (entries.length === 0) {
    return undefined;
  }
  const stage = asString(row.stage) || asString(row.failure_stage) || 'model_load';
  return stage + ': ' + entries.join(' | ');
}

function conditionResultReason(row: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    row.reason,
    row.failure_reason,
    row.error_message,
    row.message,
    tracebackLastLine(asString(row.failure_traceback)),
    tracebackLastLine(asString(row.traceback)),
    tracebackLastLine(asString(row.stack_trace)),
    tracebackLastLine(asString(row.exception_traceback)),
    conditionResultModelLoadReason(row)
  ];
  if (typeof row.error === 'string') {
    candidates.push(row.error);
  }
  for (const nested of conditionResultNestedRecords(row)) {
    candidates.push(
      nested.reason,
      nested.failure_reason,
      nested.error_message,
      nested.message,
      nested.error,
      nested.failure,
      nested.failure_type,
      tracebackLastLine(asString(nested.failure_traceback)),
      tracebackLastLine(asString(nested.traceback)),
      tracebackLastLine(asString(nested.stack_trace)),
      tracebackLastLine(asString(nested.exception_traceback)),
      conditionResultModelLoadReason(nested)
    );
  }
  for (const candidate of candidates) {
    const reason = asString(candidate);
    if (reason) {
      return trimShort(reason, 160);
    }
  }
  return undefined;
}

function formatCountMap(counts: Map<string, number>, limit: number): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => `${trimShort(key, 80)}:${count}`)
    .join(",");
}

function summarizeSeedFailureMessages(metrics: Record<string, unknown>): string[] {
  const study = asRecord(metrics.study);
  const studySummary = asRecord(metrics.study_summary);
  const conditionSummaries = [
    ...collectConditionRows(metrics.condition_summaries),
    ...collectConditionRows(study.condition_summaries),
    ...collectConditionRows(studySummary.condition_summaries)
  ];
  const nestedSeedRows = conditionSummaries.flatMap((row) => [
    ...collectConditionRows(row.seed_results),
    ...collectConditionRows(row.seed_rows),
    ...collectConditionRows(row.raw_seed_results),
    ...collectConditionRows(row.results)
  ]);
  const seedRows = [
    ...collectConditionRows(metrics.seed_results),
    ...collectConditionRows(metrics.per_seed_rows),
    ...collectConditionRows(metrics.per_seed_results),
    ...collectConditionRows(metrics.condition_seed_rows),
    ...collectConditionRows(metrics.per_run_results),
    ...collectConditionRows(metrics.run_results),
    ...collectConditionRows(metrics.raw_results),
    ...collectConditionRows(study.seed_results),
    ...collectConditionRows(study.per_seed_rows),
    ...collectConditionRows(studySummary.seed_results),
    ...nestedSeedRows
  ];
  const counts = new Map<string, number>();
  for (const row of seedRows) {
    const status = asString(row.status)?.toLowerCase();
    if (status && !["failed", "failure", "error", "errored"].includes(status)) {
      continue;
    }
    const message =
      asString(row.error_message) ||
      asString(row.error) ||
      asString(row.message) ||
      asString(row.failure_reason) ||
      conditionResultReason(row);
    if (!message) {
      continue;
    }
    const type = asString(row.error_type);
    const stage = asString(row.error_stage);
    const signature = [
      type ? `${type}` : undefined,
      stage ? `stage=${stage}` : undefined,
      trimShort(message, 180)
    ].filter((part): part is string => Boolean(part)).join(": ");
    counts.set(signature, (counts.get(signature) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([message, count]) => `${message}${count > 1 ? ` (${count}x)` : ""}`);
}

function detectConditionDependencyBlocker(metrics: Record<string, unknown>): string | null {
  const conditionRows = [
    ...collectConditionRows(metrics.condition_results),
    ...collectConditionRows(metrics.conditions),
    ...collectConditionRows(metrics.raw_condition_results),
    ...collectConditionRows(metrics.condition_seed_rows),
    ...collectConditionRows(asRecord(metrics.study).condition_results),
    ...collectConditionRows(asRecord(metrics.study).conditions),
    ...collectConditionRows(asRecord(metrics.study).raw_condition_results),
    ...collectConditionRows(asRecord(metrics.study).condition_seed_rows)
  ];
  if (conditionRows.length === 0) {
    return null;
  }
  const failedRows = conditionRows.filter((row) => {
    const status = asString(row.status)?.toLowerCase();
    return ["failed", "failure", "error", "errored"].includes(status || "");
  });
  if (failedRows.length !== conditionRows.length) {
    return null;
  }

  const messages = failedRows.flatMap((row) =>
    [...collectDiagnosticStrings(row), conditionResultReason(row)].filter((message): message is string => Boolean(message))
  );
  const combined = messages.join("\n");
  if (!isModelDependencyFailure(combined)) {
    return null;
  }

  const modelId = extractModelAssetId(combined);
  return [
    "Experiment dependency blocker:",
    `model asset ${modelId || "required model/tokenizer asset"} could not be loaded.`,
    "Prewarm/cache the model, allow required Hugging Face access, or select an available local model before retrying.",
    `No condition metrics were accepted as evidence (${failedRows.length}/${conditionRows.length} condition rows failed).`
  ].join(" ");
}

function collectConditionRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.map(asRecord).filter((row) => Object.keys(row).length > 0);
  }
  const record = asRecord(value);
  return Object.values(record).map(asRecord).filter((row) => Object.keys(row).length > 0);
}

function collectDiagnosticStrings(value: unknown, depth = 0): string[] {
  if (depth > 4) {
    return [];
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectDiagnosticStrings(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
    if (!/(error|exception|trace|message|reason|evidence|diagnostic|stderr|failure|model|tokenizer|config)/iu.test(key)) {
      return [];
    }
    return collectDiagnosticStrings(nested, depth + 1);
  });
}

function isModelDependencyFailure(message: string): boolean {
  return (
    /can't\s+load\s+the\s+(?:configuration|config|tokenizer|model)\b/iu.test(message) ||
    /\bModuleNotFoundError\b[\s\S]{0,220}(?:Tokenizer|AutoTokenizer|AutoModel|transformers|requirements defined corr)/iu.test(message) ||
    /Could not import module[\s\S]{0,180}(?:Tokenizer|Model|requirements defined corr)/iu.test(message) ||
    /\bfrom_pretrained\b/iu.test(message) ||
    /\b(?:hugging\s*face|transformers)\b[\s\S]{0,160}\b(?:cache|config|tokenizer|model|download|access)\b/iu.test(message) ||
    /\bconfig\.json\b/iu.test(message) ||
    /\blocal\s+cache\b[\s\S]{0,120}\b(?:missing|unavailable|not\s+found|disabled)\b/iu.test(message)
  );
}

function extractModelAssetId(message: string): string | undefined {
  const quoted = message.match(/['"]([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)['"]/u)?.[1];
  if (quoted) {
    return quoted;
  }
  return message.match(/\bmodel(?:_id|[-_\s]name)?\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*)/iu)?.[1];
}

function flattenMetricValues(
  value: unknown,
  prefix = ""
): Array<{ path: string; value: unknown }> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenMetricValues(item, prefix ? `${prefix}[${index}]` : `[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, nested]) =>
      flattenMetricValues(nested, prefix ? `${prefix}.${key}` : key)
    );
  }
  return [{ path: prefix || "value", value }];
}

async function resolveManagedSupplementalPlan(
  runContext: RunContextMemory,
  workspaceRoot: string
): Promise<ManagedSupplementalPlan | undefined> {
  const experimentMode = (await runContext.get<string>("implement_experiments.mode")) || "real_execution";
  if (experimentMode !== "real_execution") {
    return undefined;
  }

  const publicDir = resolveMaybeRelative(await runContext.get<string>("implement_experiments.public_dir"), workspaceRoot);
  const scriptPath = resolveMaybeRelative(await runContext.get<string>("implement_experiments.script"), workspaceRoot);
  const primaryWorkingDir =
    resolveMaybeRelative(await runContext.get<string>("implement_experiments.cwd"), workspaceRoot) || workspaceRoot;
  const explicitCommand = await runContext.get<string>("implement_experiments.run_command");
  if (!publicDir || !scriptPath) {
    return undefined;
  }

  const manifestPath = path.join(publicDir, "artifact_manifest.json");
  const scriptText = await readOptionalText(scriptPath);
  const commandSurface = explicitCommand || "";
  const supportsManagedProfiles =
    scriptText.includes("--quick-check") &&
    scriptText.includes("--profile") &&
    scriptText.includes("--metrics-out");
  const explicitManagedProfileCommand =
    commandSurface.includes("--profile") &&
    commandSurface.includes("--metrics-out") &&
    path.basename(scriptPath).length > 0;
  if (await fileExists(manifestPath) && (await fileExists(scriptPath)) && (supportsManagedProfiles || explicitManagedProfileCommand)) {
    return {
      kind: "managed_bundle",
      publicDir,
      profiles: [
        {
          profile: "quick_check",
          command: `python3 -B ${JSON.stringify(scriptPath)} --quick-check --metrics-out ${JSON.stringify(
            path.join(publicDir, "quick_check_metrics.json")
          )}`,
          metricsPath: path.join(publicDir, "quick_check_metrics.json"),
          workingDir: publicDir
        },
        {
          profile: "confirmatory",
          command: `python3 -B ${JSON.stringify(scriptPath)} --profile confirmatory --metrics-out ${JSON.stringify(
            path.join(publicDir, "confirmatory_metrics.json")
          )}`,
          metricsPath: path.join(publicDir, "confirmatory_metrics.json"),
          workingDir: publicDir
        }
      ]
    };
  }

  if (!(await fileExists(scriptPath)) || !explicitCommand) {
    return undefined;
  }

  const quickCheckMetricsPath = path.join(publicDir, "quick_check_metrics.json");
  const confirmatoryMetricsPath = path.join(publicDir, "confirmatory_metrics.json");
  const quickCheckCommand = deriveCompatibilitySupplementalCommand({
    primaryCommand: explicitCommand,
    metricsPath: quickCheckMetricsPath,
    profile: "quick_check",
    primaryWorkingDir,
    scriptPath,
    seedOnly: supportsSeedOnlyCompatibilitySupplemental(scriptText)
  });
  const confirmatoryCommand = deriveCompatibilitySupplementalCommand({
    primaryCommand: explicitCommand,
    metricsPath: confirmatoryMetricsPath,
    profile: "confirmatory",
    primaryWorkingDir,
    scriptPath,
    seedOnly: supportsSeedOnlyCompatibilitySupplemental(scriptText)
  });
  if (!quickCheckCommand || !confirmatoryCommand) {
    return undefined;
  }

  return {
    kind: "compatibility_python_runner",
    publicDir,
    profiles: [
      {
        profile: "quick_check",
        command: quickCheckCommand,
        metricsPath: quickCheckMetricsPath,
        workingDir: primaryWorkingDir
      },
      {
        profile: "confirmatory",
        command: confirmatoryCommand,
        metricsPath: confirmatoryMetricsPath,
        workingDir: primaryWorkingDir
      }
    ]
  };
}

function deriveCompatibilitySupplementalCommand(input: {
  primaryCommand: string;
  metricsPath: string;
  profile: SupplementalProfileName;
  primaryWorkingDir: string;
  scriptPath: string;
  seedOnly?: boolean;
}): string | undefined {
  const normalized = input.primaryCommand.trim();
  if (!/run_experiment\.py/u.test(normalized) && !input.seedOnly) {
    return undefined;
  }
  if (/--profile\s+\w+/u.test(normalized) || /--quick-check/u.test(normalized)) {
    return undefined;
  }

  let command = rewriteFlagValue(normalized, "--metrics-path", input.metricsPath);
  let metricsFlag = "--metrics-path";
  if (command === normalized && !input.seedOnly) {
    command = rewriteFlagValue(normalized, "--metrics-out", input.metricsPath);
    metricsFlag = "--metrics-out";
  }
  if (command === normalized && !new RegExp(`${escapeRegExp(metricsFlag)}(?:\\s|=)`, "u").test(normalized)) {
    if (/--metrics-path/u.test(normalized) || /--metrics-out/u.test(normalized)) {
      return undefined;
    }
    command = `${normalized} ${metricsFlag} ${JSON.stringify(input.metricsPath)}`;
  }

  const repeats = input.profile === "quick_check" ? "2" : "8";
  const seedBase = input.profile === "quick_check" ? "700" : "900";
  if (input.seedOnly) {
    command = rewriteFlagValue(command, "--seed", seedBase, true);
  } else {
    command = rewriteFlagValue(command, "--repeats", repeats, true);
    command = rewriteFlagValue(command, "--seed-base", seedBase, true);
  }
  return absolutizeCompatibilitySupplementalCommand(command, input.primaryWorkingDir, input.scriptPath);
}

function supportsSeedOnlyCompatibilitySupplemental(scriptText: string): boolean {
  return scriptText.includes("--seed") && scriptText.includes("--metrics-path");
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function rewriteFlagValue(command: string, flag: string, value: string, appendIfMissing = false): string {
  const quotedValue = JSON.stringify(value);
  const inlinePattern = new RegExp(`(${escapeRegExp(flag)}=)(\"[^\"]*\"|'[^']*'|\\S+)`, "u");
  if (inlinePattern.test(command)) {
    return command.replace(inlinePattern, `$1${quotedValue}`);
  }

  const spacedPattern = new RegExp(`(${escapeRegExp(flag)}\\s+)(\"[^\"]*\"|'[^']*'|\\S+)`, "u");
  if (spacedPattern.test(command)) {
    return command.replace(spacedPattern, `$1${quotedValue}`);
  }

  if (appendIfMissing) {
    return `${command} ${flag} ${quotedValue}`;
  }
  return command;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function absolutizeCompatibilitySupplementalCommand(
  command: string,
  primaryWorkingDir: string,
  scriptPath: string
): string {
  let tokenIndex = 0;
  return command.replace(/"[^"]+"|'[^']+'|\S+/g, (rawToken) => {
    const token = unquoteShellToken(rawToken);
    let replacement: string | undefined;

    if (tokenIndex === 0 && token.includes("/") && !path.isAbsolute(token)) {
      replacement = path.resolve(primaryWorkingDir, token);
    } else if (/run_experiment\.py$/u.test(token) && !path.isAbsolute(token)) {
      replacement = scriptPath;
    }

    tokenIndex += 1;
    return replacement ? JSON.stringify(replacement) : rawToken;
  });
}

function unquoteShellToken(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

async function clearManagedSupplementalOutputs(
  run: Parameters<typeof writeRunArtifact>[0],
  profiles: ManagedSupplementalProfile[]
): Promise<string[]> {
  const backups: string[] = [];
  for (const profile of profiles) {
    const backupPath = await clearPreexistingMetricsOutput(run, profile.metricsPath);
    if (backupPath) {
      backups.push(path.basename(profile.metricsPath));
    }
  }
  return backups;
}

async function maybeRunManagedSupplementalProfiles(input: {
  deps: NodeExecutionDeps;
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"];
  runContext: RunContextMemory;
  objectiveProfile: Awaited<ReturnType<typeof resolveObjectiveMetricProfile>>;
  objectiveEvaluation: ObjectiveMetricEvaluation;
  primaryCommand: string;
  plan?: ManagedSupplementalPlan;
  abortSignal?: AbortSignal;
  topicProbeComputeGovernor?: TopicProbeComputeGovernor;
}): Promise<{
  records: SupplementalRunRecord[];
  summary?: string;
  toolCallsUsed: number;
  expectation?: SupplementalExpectationArtifact;
}> {
  if (!input.plan) {
    return {
      records: [],
      toolCallsUsed: 0
    };
  }

  if (input.plan.kind === "managed_bundle" && !isManagedStandardRunCommand(input.primaryCommand)) {
    const records = input.plan.profiles.map((profile) => ({
      profile: profile.profile,
      status: "skipped" as const,
      metrics_path: profile.metricsPath,
      summary: "Skipped because the primary run command was not the managed standard profile."
    }));
    const summary = "Supplemental runs skipped because the primary run command was not the managed standard profile.";
    emitSupplementalObservation(input, summary);
    return {
      records,
      summary,
      toolCallsUsed: 0,
      expectation: {
        applicable: true,
        profiles: input.plan.profiles.map((profile) => profile.profile),
        reason: summary
      }
    };
  }

  if (!["met", "observed"].includes(input.objectiveEvaluation.status)) {
    const records = input.plan.profiles.map((profile) => ({
      profile: profile.profile,
      status: "skipped" as const,
      metrics_path: profile.metricsPath,
      summary: `Skipped because the primary objective status was ${input.objectiveEvaluation.status}.`
    }));
    const summary = `Supplemental runs skipped because the primary objective status was ${input.objectiveEvaluation.status}.`;
    emitSupplementalObservation(input, summary);
    return {
      records,
      summary,
      toolCallsUsed: 0,
      expectation: {
        applicable: true,
        profiles: input.plan.profiles.map((profile) => profile.profile),
        reason: summary
      }
    };
  }

  let toolCallsUsed = 0;
  const records: SupplementalRunRecord[] = [];
  const quickCheck = await runManagedSupplementalProfile({
    ...input,
    profile: input.plan.profiles[0]
  });
  toolCallsUsed += quickCheck.compute_budget_blocked ? 0 : 1;
  if (input.plan.kind === "compatibility_python_runner" && isCompatibilitySupplementalUnsupported(quickCheck.summary)) {
    const summary =
      "Supplemental quick_check and confirmatory profiles are not supported by this compatibility experiment runner; the repeated standard run is the complete executed design.";
    const records: SupplementalRunRecord[] = input.plan.profiles.map((profile) => ({
      profile: profile.profile,
      status: "skipped",
      command: profile.command,
      cwd: profile.workingDir,
      metrics_path: profile.metricsPath,
      summary
    }));
    emitSupplementalObservation(input, summary);
    return {
      records,
      summary,
      toolCallsUsed,
      expectation: {
        applicable: false,
        profiles: [],
        reason: summary
      }
    };
  }
  records.push(quickCheck);

  if (quickCheck.status !== "pass") {
    const confirmatoryProfile = input.plan.profiles[1];
    const skipped: SupplementalRunRecord = {
      profile: confirmatoryProfile.profile,
      status: "skipped",
      metrics_path: confirmatoryProfile.metricsPath,
      summary: `Skipped because ${quickCheck.profile} did not complete successfully.`
    };
    records.push(skipped);
    emitSupplementalObservation(input, skipped.summary);
  } else {
    const confirmatory = await runManagedSupplementalProfile({
      ...input,
      profile: input.plan.profiles[1]
    });
    toolCallsUsed += confirmatory.compute_budget_blocked ? 0 : 1;
    records.push(confirmatory);
  }

  return {
    records,
    summary: summarizeSupplementalRuns(records),
    toolCallsUsed,
    expectation: {
      applicable: true,
      profiles: input.plan.profiles.map((profile) => profile.profile),
      reason: summarizeSupplementalRuns(records)
    }
  };
}

async function runManagedSupplementalProfile(input: {
  deps: NodeExecutionDeps;
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"];
  objectiveProfile: Awaited<ReturnType<typeof resolveObjectiveMetricProfile>>;
  profile: ManagedSupplementalProfile;
  abortSignal?: AbortSignal;
  topicProbeComputeGovernor?: TopicProbeComputeGovernor;
}): Promise<SupplementalRunRecord> {
  const supplementalGpuMetadata = input.topicProbeComputeGovernor
    ? resolveRunCommandGpuRequestMetadata(input.profile.command)
    : undefined;
  if (supplementalGpuMetadata?.gpuRequestIssue) {
    return {
      profile: input.profile.profile,
      status: "fail",
      command: input.profile.command,
      cwd: input.profile.workingDir,
      metrics_path: input.profile.metricsPath,
      summary: supplementalGpuMetadata.gpuRequestIssue,
      compute_budget_blocked: true
    };
  }
  const supplementalEstimatedGpuCount = input.topicProbeComputeGovernor
    ? supplementalGpuMetadata?.requestedGpuCount
      ?? input.topicProbeComputeGovernor.estimatedGpuCount
    : undefined;
  if (
    input.topicProbeComputeGovernor?.enforceEnvironmentGpuLimit
    && supplementalGpuMetadata?.environmentGpuLimit !== undefined
    && supplementalEstimatedGpuCount !== undefined
    && supplementalEstimatedGpuCount
      > supplementalGpuMetadata.environmentGpuLimit
  ) {
    return {
      profile: input.profile.profile,
      status: "fail",
      command: input.profile.command,
      cwd: input.profile.workingDir,
      metrics_path: input.profile.metricsPath,
      summary:
        "topic_probe_compute_preflight_environment_gpu_limit_exceeded:"
        + `requested=${supplementalEstimatedGpuCount},`
        + `environment_limit=${supplementalGpuMetadata.environmentGpuLimit},`
        + `source=${supplementalGpuMetadata.environmentGpuLimitSource || "unknown"}`,
      compute_budget_blocked: true
    };
  }
  const computePreflight = input.topicProbeComputeGovernor
    ? await appendTopicProbeComputePreflight({
        ledgerPath: input.topicProbeComputeGovernor.ledgerPath,
        contract: input.topicProbeComputeGovernor.contract,
        profile: input.profile.profile,
        command: input.profile.command,
        estimatedWallTimeMs:
          input.topicProbeComputeGovernor.estimatedWallTimeMs,
        estimatedGpuCount: supplementalEstimatedGpuCount!,
        estimatedFreshTrials:
          input.topicProbeComputeGovernor.supplementalEstimatedFreshTrials[
            input.profile.profile
          ]
      })
    : undefined;
  if (computePreflight && !computePreflight.allowed) {
    return {
      profile: input.profile.profile,
      status: "fail",
      command: input.profile.command,
      cwd: input.profile.workingDir,
      metrics_path: input.profile.metricsPath,
      summary: formatTopicProbeComputeBudgetFailure(
        computePreflight.reasons
      ),
      compute_budget_blocked: true
    };
  }

  input.deps.eventStream.emit({
    type: "TOOL_CALLED",
    runId: input.run.id,
    node: "run_experiments",
    agentRole: "runner",
    payload: {
      command: input.profile.command,
      cwd: input.profile.workingDir,
      source: `supplemental_${input.profile.profile}`
    }
  });

  const cwd = input.profile.workingDir;
  const obs = await input.deps.aci.runCommand(input.profile.command, cwd, input.abortSignal);
  const logFile = await writeRunArtifact(
    input.run,
    `exec_logs/run_experiments_${input.profile.profile}.txt`,
    [
      `command: ${input.profile.command}`,
      `cwd: ${cwd}`,
      `source: supplemental_${input.profile.profile}`,
      "",
      obs.stdout || "",
      obs.stderr || ""
    ].join("\n")
  );

  if (
    input.topicProbeComputeGovernor
    && computePreflight?.entry
  ) {
    const computeActual = await finalizeTopicProbeComputeUsage({
      run: input.run,
      governor: input.topicProbeComputeGovernor,
      profile: input.profile.profile,
      command: input.profile.command,
      metricsPath: input.profile.metricsPath,
      attempt: computePreflight.entry.attempt,
      startedAt: new Date(
        Date.now() - (
          typeof obs.duration_ms === "number" ? obs.duration_ms : 0
        )
      ).toISOString(),
      wallTimeMs:
        typeof obs.duration_ms === "number" ? obs.duration_ms : 0
    });
    if (!computeActual.allowed) {
      const summary = formatTopicProbeComputeBudgetFailure(
        computeActual.reasons
      );
      emitSupplementalObservation(input, summary);
      return {
        profile: input.profile.profile,
        status: "fail",
        command: input.profile.command,
        cwd,
        metrics_path: input.profile.metricsPath,
        summary,
        exit_code: obs.exit_code ?? 1,
        log_file: logFile,
        compute_budget_blocked: true
      };
    }
  }

  if (obs.status !== "ok") {
    const summary = `Supplemental ${input.profile.profile} run failed: ${obs.stderr || "command failed"}`;
    emitSupplementalObservation(input, summary);
    return {
      profile: input.profile.profile,
      status: "fail",
      command: input.profile.command,
      cwd,
      metrics_path: input.profile.metricsPath,
      summary,
      exit_code: obs.exit_code ?? 1,
      log_file: logFile
    };
  }

  if (!(await fileExists(input.profile.metricsPath))) {
    const summary = `Supplemental ${input.profile.profile} run did not produce metrics at ${input.profile.metricsPath}.`;
    emitSupplementalObservation(input, summary);
    return {
      profile: input.profile.profile,
      status: "fail",
      command: input.profile.command,
      cwd,
      metrics_path: input.profile.metricsPath,
      summary,
      exit_code: obs.exit_code ?? 0,
      log_file: logFile
    };
  }

  try {
    const raw = await fs.readFile(input.profile.metricsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("metrics.json must decode to an object");
    }
    const objectiveEvaluation = evaluateObjectiveMetric(
      parsed as Record<string, unknown>,
      input.objectiveProfile,
      input.run.objectiveMetric
    );
    const summary = `Supplemental ${input.profile.profile} completed. ${objectiveEvaluation.summary}`;
    emitSupplementalObservation(input, summary);
    return {
      profile: input.profile.profile,
      status: "pass",
      command: input.profile.command,
      cwd,
      metrics_path: input.profile.metricsPath,
      summary,
      exit_code: obs.exit_code ?? 0,
      log_file: logFile,
      objective_evaluation: objectiveEvaluation,
      sampling_profile: extractSamplingProfile(parsed as Record<string, unknown>)
    };
  } catch (error) {
    const summary = `Supplemental ${input.profile.profile} produced invalid metrics: ${
      error instanceof Error ? error.message : String(error)
    }`;
    emitSupplementalObservation(input, summary);
    return {
      profile: input.profile.profile,
      status: "fail",
      command: input.profile.command,
      cwd,
      metrics_path: input.profile.metricsPath,
      summary,
      exit_code: obs.exit_code ?? 0,
      log_file: logFile
    };
  }
}

function summarizeSupplementalRuns(records: SupplementalRunRecord[]): string | undefined {
  if (records.length === 0) {
    return undefined;
  }
  return `Supplemental runs: ${records
    .map((record) => `${record.profile} ${record.status}`)
    .join(", ")}.`;
}

function isCompatibilitySupplementalUnsupported(summary: string | undefined): boolean {
  const normalized = (summary || "").toLowerCase();
  return (
    normalized.includes("unrecognized arguments:") &&
    (normalized.includes("--repeats") ||
      normalized.includes("--seed-base") ||
      normalized.includes("--quick-check") ||
      normalized.includes("--profile"))
  );
}

function emitSupplementalObservation(
  input:
    | {
        deps: NodeExecutionDeps;
        run: Parameters<GraphNodeHandler["execute"]>[0]["run"];
      }
    | {
        deps: NodeExecutionDeps;
        run: Parameters<GraphNodeHandler["execute"]>[0]["run"];
      },
  text: string
): void {
  input.deps.eventStream.emit({
    type: "OBS_RECEIVED",
    runId: input.run.id,
    node: "run_experiments",
    agentRole: "runner",
    payload: {
      text
    }
  });
}

async function promoteObjectiveMetricFromPublicBundle(input: {
  metrics: Record<string, unknown>;
  objectiveProfile: ObjectiveMetricProfile;
  runContext: RunContextMemory;
  workspaceRoot: string;
  metricsPath: string;
  minModifiedAtMs?: number;
}): Promise<string | undefined> {
  const preferredKeys = [...new Set([
    ...input.objectiveProfile.preferredMetricKeys,
    ...(input.objectiveProfile.primaryMetric ? [input.objectiveProfile.primaryMetric] : [])
  ])].filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key));
  if (preferredKeys.some((key) => asNumber(input.metrics[key]) !== undefined)) {
    return undefined;
  }
  const publicDir = resolveMaybeRelative(
    await input.runContext.get<string>("implement_experiments.public_dir"),
    input.workspaceRoot
  );
  if (!publicDir) {
    return undefined;
  }
  const candidates = [
    path.join(publicDir, "metrics.json"),
    path.join(publicDir, "latest_metrics.json"),
    path.join(publicDir, "metrics_summary.json")
  ];
  for (const candidate of candidates) {
    if (candidate === input.metricsPath || !(await fileExists(candidate))) {
      continue;
    }
    const candidateStat = await fs.stat(candidate).catch(() => undefined);
    if (input.minModifiedAtMs !== undefined && candidateStat && candidateStat.mtimeMs + 1000 < input.minModifiedAtMs) {
      continue;
    }
    const candidateMetrics = await readMetricsObject(candidate, input.workspaceRoot);
    if (!candidateMetrics) {
      continue;
    }
    const candidateSelection = resolveExplicitResultsSelection(candidateMetrics).selection;
    if (!candidateSelection || !preferredKeys.includes(candidateSelection.metric.id)) {
      continue;
    }
    promoteExplicitResultsPrimaryObservation(candidateMetrics);
    const matchedKey = candidateSelection.metric.id;
    if (asNumber(candidateMetrics[matchedKey]) === undefined) {
      continue;
    }
    const selectedValue = asNumber(candidateMetrics[matchedKey]);
    if (selectedValue !== undefined && asNumber(input.metrics[matchedKey]) === undefined) {
      input.metrics[matchedKey] = selectedValue;
    }
    for (const key of [
      "primary_metric_key",
      "primary_metric_value",
      "primary_metric_direction",
      "primary_observation_id",
      "primary_comparison_id",
      "results_selection",
      "results_artifact",
      "completed_run_count",
      "completed_condition_count",
      "failed_run_count",
      "required_run_count",
      "required_condition_count"
    ]) {
      if (input.metrics[key] == null && candidateMetrics[key] != null) {
        input.metrics[key] = candidateMetrics[key];
      }
    }
    return `Promoted objective metric ${matchedKey}=${candidateMetrics[matchedKey]} from public bundle metrics at ${candidate}.`;
  }
  return undefined;
}

async function recoverPublicBundleMetricsOutput(input: {
  runContext: RunContextMemory;
  workspaceRoot: string;
  metricsPath: string;
  minModifiedAtMs?: number;
}): Promise<string | undefined> {
  const existingMetrics = await readMetricsObject(input.metricsPath, input.workspaceRoot);
  const publicDir = resolveMaybeRelative(
    await input.runContext.get<string>("implement_experiments.public_dir"),
    input.workspaceRoot
  );
  if (!publicDir) {
    return undefined;
  }
  const candidates = [
    path.join(publicDir, "metrics.json"),
    path.join(publicDir, "study_results.json"),
    path.join(publicDir, "latest_metrics.json")
  ];
  for (const candidate of candidates) {
    if (candidate === input.metricsPath || !(await fileExists(candidate))) {
      continue;
    }
    const candidateStat = await fs.stat(candidate).catch(() => undefined);
    if (input.minModifiedAtMs !== undefined && candidateStat && candidateStat.mtimeMs + 1000 < input.minModifiedAtMs) {
      continue;
    }
    const metrics = await readMetricsObject(candidate, input.workspaceRoot);
    if (!metrics || Object.keys(metrics).length === 0) {
      continue;
    }
    const publicSelection = resolveExplicitResultsSelection(metrics).selection;
    if (!publicSelection) {
      continue;
    }
    if (existingMetrics) {
      const existingSelection = resolveExplicitResultsSelection(existingMetrics).selection;
      const publicStatus = asString(metrics.status)?.toLowerCase();
      const existingStatus = asString(existingMetrics.status)?.toLowerCase();
      const publicCompleted = publicStatus === "completed" || publicStatus === "success" || publicStatus === "succeeded";
      const existingFailed = existingStatus === "failed" || existingStatus === "failure" || existingStatus === "error";
      if (existingSelection && !(publicCompleted && existingFailed)) {
        continue;
      }
    }
    await fs.mkdir(path.dirname(input.metricsPath), { recursive: true });
    await fs.copyFile(candidate, input.metricsPath);
    return candidate;
  }
  return undefined;
}

async function clearPreexistingMetricsOutput(
  run: Parameters<typeof writeRunArtifact>[0],
  metricsPath: string
): Promise<string | undefined> {
  if (!(await fileExists(metricsPath))) {
    return undefined;
  }

  const existingMetrics = await fs.readFile(metricsPath, "utf8");
  const backupPath = await writeRunArtifact(
    run,
    `exec_logs/preexisting_metrics_${Date.now()}.json`,
    existingMetrics
  );
  await fs.unlink(metricsPath);
  return backupPath;
}

async function restorePreexistingMetricsOutput(input: {
  run: Parameters<typeof writeRunArtifact>[0];
  metricsPath: string;
  backupPath: string | undefined;
  reason: string;
}): Promise<string | undefined> {
  if (!input.backupPath || !(await fileExists(input.backupPath))) {
    return undefined;
  }

  if (await fileExists(input.metricsPath)) {
    const rejectedMetrics = await fs.readFile(input.metricsPath, "utf8");
    await writeRunArtifact(
      input.run,
      `exec_logs/rejected_metrics_${Date.now()}.json`,
      rejectedMetrics
    );
    await writeRunArtifact(
      input.run,
      `exec_logs/metrics_restore_skipped_${Date.now()}.json`,
      JSON.stringify({
        preserved_rejected_metrics: input.metricsPath,
        previous_backup: input.backupPath,
        reason: input.reason
      }, null, 2)
    );
    return undefined;
  }

  const previousMetrics = await fs.readFile(input.backupPath, "utf8");
  await fs.mkdir(path.dirname(input.metricsPath), { recursive: true });
  await fs.writeFile(input.metricsPath, previousMetrics, "utf8");
  await writeRunArtifact(
    input.run,
    `exec_logs/metrics_restore_${Date.now()}.json`,
    JSON.stringify({
      restored_from: input.backupPath,
      restored_to: input.metricsPath,
      reason: input.reason
    }, null, 2)
  );
  return input.backupPath;
}

async function clearPreexistingExperimentFailureArtifacts(
  run: Parameters<typeof writeRunArtifact>[0],
  artifactDir: string | undefined
): Promise<string[]> {
  if (!artifactDir) {
    return [];
  }

  const backups: string[] = [];
  for (const fileName of ["study_failure.json", "study_failures.json"]) {
    const filePath = path.join(artifactDir, fileName);
    if (!(await fileExists(filePath))) {
      continue;
    }
    const existingArtifact = await fs.readFile(filePath, "utf8");
    const backupPath = await writeRunArtifact(
      run,
      `exec_logs/preexisting_${fileName.replace(/\.json$/u, "")}_${Date.now()}.json`,
      existingArtifact
    );
    await fs.unlink(filePath);
    backups.push(backupPath);
  }
  const nestedFailurePaths = await collectNestedFailureArtifactPaths(artifactDir);
  for (const [index, filePath] of nestedFailurePaths.entries()) {
    const existingArtifact = await fs.readFile(filePath, "utf8");
    const relativePath = path.relative(artifactDir, filePath).replace(/\\/gu, "/");
    const backupPath = await writeRunArtifact(
      run,
      `exec_logs/preexisting_nested_failure_${Date.now()}_${index}.json`,
      JSON.stringify(
        {
          relative_path: relativePath,
          artifact: safeJsonParse(existingArtifact) ?? existingArtifact
        },
        null,
        2
      )
    );
    await fs.unlink(filePath);
    backups.push(backupPath);
  }
  return backups;
}

async function clearPreexistingExperimentEvidenceArtifacts(
  run: Parameters<typeof writeRunArtifact>[0],
  artifactDir: string | undefined
): Promise<string[]> {
  if (!artifactDir) {
    return [];
  }

  const candidatePaths = [
    path.join(artifactDir, "artifacts", "raw_evaluation_evidence.jsonl"),
    path.join(artifactDir, "raw_evaluation_evidence.jsonl"),
    path.join(artifactDir, "artifacts", "evaluation_evidence.jsonl"),
    path.join(artifactDir, "evaluation_evidence.jsonl")
  ];
  const backups: string[] = [];
  const seen = new Set<string>();
  for (const filePath of candidatePaths) {
    const resolvedPath = path.resolve(filePath);
    if (seen.has(resolvedPath) || !(await fileExists(resolvedPath))) {
      continue;
    }
    seen.add(resolvedPath);
    const existingArtifact = await fs.readFile(resolvedPath, "utf8");
    const relativePath = path.relative(artifactDir, resolvedPath).replace(/\\/gu, "/");
    const safeName = relativePath
      .replace(/\.jsonl$/u, "")
      .replace(/[^a-z0-9]+/giu, "_")
      .replace(/^_+|_+$/gu, "") || "evidence";
    const backupPath = await writeRunArtifact(
      run,
      `exec_logs/preexisting_${safeName}_${Date.now()}.jsonl`,
      existingArtifact
    );
    await fs.unlink(resolvedPath);
    backups.push(backupPath);
  }
  return backups;
}

async function collectNestedFailureArtifactPaths(artifactDir: string): Promise<string[]> {
  const results: string[] = [];
  const stack = [artifactDir];
  while (stack.length > 0 && results.length < 200) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".autolabos") {
        continue;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === "failure.json" && path.dirname(entryPath) !== artifactDir) {
        results.push(entryPath);
        if (results.length >= 200) {
          break;
        }
      }
    }
  }
  return results.sort();
}

function safeJsonParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isManagedStandardRunCommand(command: string): boolean {
  if (/--quick-check/u.test(command) || /--profile\s+confirmatory/u.test(command)) {
    return false;
  }
  return /--profile\s+standard/u.test(command);
}

function shouldForceFreshManagedStandardRun(input: {
  command: string;
  experimentMode: string;
  previousMetricsBackup?: string;
}): boolean {
  if (!input.previousMetricsBackup || input.experimentMode !== "real_execution") {
    return false;
  }
  if (!/run_experiment\.py/u.test(input.command)) {
    return false;
  }
  return isManagedStandardRunCommand(input.command) && !/\s--fresh(?:\s|$)/u.test(input.command);
}

function appendFreshFlag(command: string): string {
  return /\s--fresh(?:\s|$)/u.test(command) ? command : `${command} --fresh`;
}

function resolveMaybeRelative(value: string | undefined, workspaceRoot: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.join(workspaceRoot, value);
}

function withModelDownloadEnvIfDeclared(
  command: string,
  config: NodeExecutionDeps["config"]
): string {
  if (
    config.experiments?.network_purpose !== "model_download" ||
    config.experiments?.network_policy === "blocked" ||
    /(^|\s)AUTOLABOS_ALLOW_MODEL_DOWNLOAD=/u.test(command)
  ) {
    return command;
  }
  return `AUTOLABOS_ALLOW_MODEL_DOWNLOAD=1 ${command}`;
}

function resolveRunExperimentsBudgetTimeoutSec(config: NodeExecutionDeps["config"]): number | undefined {
  const configTimeout = Number(config.experiments?.timeout_sec || 0);
  if (Number.isFinite(configTimeout) && configTimeout > 0) {
    return Math.floor(configTimeout);
  }
  return undefined;
}

async function appendPythonTimeoutArgIfAccepted(
  command: string,
  cwd: string,
  timeoutSec: number | undefined
): Promise<string> {
  if (!timeoutSec) {
    return command;
  }
  const scriptPath = await resolvePythonRunCommandScriptPath(command, cwd);
  if (!scriptPath || path.extname(scriptPath) !== ".py" || !(await fileExists(scriptPath))) {
    return command;
  }
  const source = await fs.readFile(scriptPath, "utf8");
  const acceptedFlags = extractPythonArgparseLongFlagsForRunCommand(source);
  let nextCommand = command;
  if (!/--(?:budget-)?timeout-sec\b/u.test(nextCommand)) {
    if (acceptedFlags.has("--timeout-sec")) {
      nextCommand = `${nextCommand} --timeout-sec ${timeoutSec}`;
    } else if (acceptedFlags.has("--budget-timeout-sec")) {
      nextCommand = `${nextCommand} --budget-timeout-sec ${timeoutSec}`;
    }
  }
  if (acceptedFlags.has("--condition-timeout-sec") && !hasCommandFlag(nextCommand, "--condition-timeout-sec")) {
    nextCommand = `${nextCommand} --condition-timeout-sec ${Math.max(1, Math.floor(timeoutSec))}`;
  }
  return nextCommand;
}
async function appendPythonOverwriteOutputArgIfAccepted(command: string, cwd: string): Promise<string> {
  if (hasCommandFlag(command, "--overwrite-output")) {
    return command;
  }
  const scriptPath = await resolvePythonRunCommandScriptPath(command, cwd);
  if (!scriptPath || path.extname(scriptPath) !== ".py" || !(await fileExists(scriptPath))) {
    return command;
  }
  const outputDir =
    extractCommandPathFlagValue(command, cwd, "--output-dir") ||
    extractCommandPathFlagValue(command, cwd, "--public-dir");
  if (!outputDir || !(await looksLikeReusableExperimentOutputDir(outputDir))) {
    return command;
  }
  const source = await fs.readFile(scriptPath, "utf8");
  const acceptedFlags = extractPythonArgparseLongFlagsForRunCommand(source);
  return acceptedFlags.has("--overwrite-output") ? `${command} --overwrite-output` : command;
}
async function resolvePythonRunCommandScriptPath(command: string, cwd: string): Promise<string | undefined> {
  const directScriptPath = extractPythonScriptPathFromCommand(command, cwd);
  if (directScriptPath) {
    return directScriptPath;
  }
  return resolveForwardedShellWrapperPythonScriptPath(command, cwd);
}

async function resolveForwardedShellWrapperPythonScriptPath(command: string, cwd: string): Promise<string | undefined> {
  const wrapperPath = extractShellScriptPathFromCommand(command, cwd);
  if (!wrapperPath || !(await fileExists(wrapperPath))) {
    return undefined;
  }
  const wrapperSource = await fs.readFile(wrapperPath, "utf8");
  if (!/(?:["']?\$@["']?|\$\{[@*]\})/u.test(wrapperSource)) {
    return undefined;
  }
  const scriptDir = path.dirname(wrapperPath);
  const variableValues = new Map<string, string>([["SCRIPT_DIR", scriptDir]]);
  const assignmentPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(["'])(.*?)\2\s*$/gmu;
  for (const match of wrapperSource.matchAll(assignmentPattern)) {
    const name = match[1];
    const rawValue = match[3] || "";
    if (!name || !rawValue.includes(".py")) {
      continue;
    }
    const resolved = resolveShellWrapperPathExpression(rawValue, variableValues, scriptDir);
    if (resolved && path.extname(resolved) === ".py" && (await fileExists(resolved))) {
      variableValues.set(name, resolved);
      return resolved;
    }
  }
  const directPythonMatch = wrapperSource.match(
    /\b(?:python|python3|\$\{PYTHON_BIN:-python3\})\b[\s\\]+(?:"([^"]+\.py)"|'([^']+\.py)'|(\S+\.py))/u
  );
  const directCandidate = directPythonMatch?.[1] || directPythonMatch?.[2] || directPythonMatch?.[3];
  if (directCandidate) {
    const resolved = resolveShellWrapperPathExpression(directCandidate, variableValues, scriptDir);
    if (resolved && path.extname(resolved) === ".py" && (await fileExists(resolved))) {
      return resolved;
    }
  }
  const variablePythonMatch = wrapperSource.match(/\b(?:python|python3|\$\{PYTHON_BIN:-python3\})\b[\s\\]+["']?\$([A-Za-z_][A-Za-z0-9_]*)["']?/u);
  const variableName = variablePythonMatch?.[1];
  if (variableName) {
    const resolved = variableValues.get(variableName);
    if (resolved && path.extname(resolved) === ".py" && (await fileExists(resolved))) {
      return resolved;
    }
  }
  return undefined;
}

function extractShellScriptPathFromCommand(command: string, cwd: string): string | undefined {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = unquoteShellToken(tokens[index] || "");
    if (!token || token.startsWith("-")) {
      continue;
    }
    const candidate =
      token === "bash" || token === "sh" || token.endsWith("/bash") || token.endsWith("/sh")
        ? unquoteShellToken(tokens[index + 1] || "")
        : token;
    if (!candidate || candidate.startsWith("-") || path.extname(candidate) !== ".sh") {
      continue;
    }
    return path.isAbsolute(candidate) ? candidate : path.join(cwd, candidate);
  }
  return undefined;
}

function resolveShellWrapperPathExpression(
  rawValue: string,
  variableValues: Map<string, string>,
  scriptDir: string
): string | undefined {
  let value = rawValue.trim();
  for (const [name, replacement] of variableValues.entries()) {
    value = value
      .replace(new RegExp(`\\$\\{${escapeRegex(name)}\\}`, "gu"), replacement)
      .replace(new RegExp(`\\${escapeRegex(name)}\\b`, "gu"), replacement);
  }
  value = value.replace(/\$\((?:cd|dirname)[^)]+\)/gu, scriptDir);
  if (!value.includes(".py")) {
    return undefined;
  }
  const pyMatch = value.match(/(.+?\.py)(?:\s|$)/u);
  const candidate = pyMatch?.[1] || value;
  return path.isAbsolute(candidate) ? candidate : path.resolve(scriptDir, candidate);
}

function hasCommandFlag(command: string, flag: string): boolean {
  const escaped = escapeRegex(flag);
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|=|$)`, "u").test(command);
}

function extractCommandPathFlagValue(command: string, cwd: string, flag: string): string | undefined {
  const inlinePattern = new RegExp(`${escapeRegex(flag)}=("[^"]*"|'[^']*'|\\S+)`, "u");
  const inlineMatch = command.match(inlinePattern);
  const spacedPattern = new RegExp(`${escapeRegex(flag)}\\s+("[^"]*"|'[^']*'|\\S+)`, "u");
  const spacedMatch = command.match(spacedPattern);
  const rawValue = inlineMatch?.[1] || spacedMatch?.[1];
  if (!rawValue) {
    return undefined;
  }
  const value = unquoteShellToken(rawValue);
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

async function looksLikeReusableExperimentOutputDir(dirPath: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return false;
  }
  return entries.some((entry) =>
    /^(study_results|latest_results|aggregate_results|condition_results|result_table|metrics|summary)\.(json|jsonl|csv|tsv|md)$/iu.test(
      entry
    )
  );
}

function extractPythonArgparseLongFlagsForRunCommand(source: string): Set<string> {
  const primaryParserFunctionNames = [
    "parse_args",
    "parse_cli_args",
    "parse_arguments",
    "build_arg_parser",
    "make_arg_parser",
    "create_arg_parser"
  ];
  for (const functionName of primaryParserFunctionNames) {
    const body = extractPythonTopLevelFunctionBody(source, functionName);
    if (body && /\badd_argument\s*\(/u.test(body)) {
      return extractPythonArgparseLongFlagsFromText(body);
    }
  }
  return extractPythonArgparseLongFlagsFromText(source);
}

function extractPythonArgparseLongFlagsFromText(text: string): Set<string> {
  const flags = new Set<string>();
  const addArgumentPattern = /\badd_argument\s*\(([\s\S]*?)\)/gu;
  for (const match of text.matchAll(addArgumentPattern)) {
    const callText = match[1] || "";
    for (const flagMatch of callText.matchAll(/["'](--[a-z0-9][a-z0-9_-]*)["']/giu)) {
      flags.add(flagMatch[1].toLowerCase());
    }
  }
  return flags;
}

function extractPythonTopLevelFunctionBody(source: string, functionName: string): string | undefined {
  const lines = source.split(/\r?\n/u);
  const definitionPattern = new RegExp(`^def\\s+${escapeRegex(functionName)}\\s*\\(`, "u");
  const startIndex = lines.findIndex((line) => definitionPattern.test(line));
  if (startIndex < 0) {
    return undefined;
  }
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] || "";
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !/^[ \t]/u.test(line)) {
      endIndex = index;
      break;
    }
  }
  return lines.slice(startIndex, endIndex).join("\n");
}

async function detectPythonRunnerSkeletonOnlySurface(input: {
  runContext: RunContextMemory;
  command: string;
  cwd: string;
  workspaceRoot: string;
}): Promise<string | undefined> {
  const explicitScript = resolveMaybeRelative(
    await input.runContext.get<string>("implement_experiments.script"),
    input.workspaceRoot
  );
  const commandScript = extractPythonScriptPathFromCommand(input.command, input.cwd);
  const candidates = [commandScript, explicitScript]
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter((candidate) => path.extname(candidate) === ".py");
  const scriptPath = await firstExistingCandidate(candidates);
  if (!scriptPath) {
    return undefined;
  }

  let source = "";
  try {
    source = await fs.readFile(scriptPath, "utf8");
  } catch {
    return undefined;
  }

  if (!isCanonicalPythonRunnerSkeletonOnly(source)) {
    return undefined;
  }

  return [
    "Python experiment runner " + path.basename(scriptPath) + " is still a canonical skeleton and has no executable main entrypoint.",
    "run_experiments must not execute a skeleton-only runner or recover stale metrics as experiment evidence."
  ].join(" ");
}

function isCanonicalPythonRunnerSkeletonOnly(source: string): boolean {
  if (!/AUTOLABOS\s+CANONICAL\s+SKELETON/iu.test(source)) {
    return false;
  }
  if (hasUnfilledCriticalAutolabosRunnerSection(source)) {
    return true;
  }
  const hasMainFunction = /(?:^|\n)def\s+main\s*\(/u.test(source);
  const hasMainGuard = /if\s+__name__\s*==\s*["']__main__["']/u.test(source);
  const hasDirectCliExit = /raise\s+SystemExit\s*\(|sys\.exit\s*\(/u.test(source);
  return !hasMainFunction || !hasMainGuard || !hasDirectCliExit;
}

function hasUnfilledCriticalAutolabosRunnerSection(source: string): boolean {
  const criticalSections = ["runner_evaluation", "runner_metrics", "runner_entrypoint"];
  return criticalSections.some((sectionId) => {
    const bodies = extractAutolabosSectionBodies(source, sectionId);
    return bodies.length > 0 && bodies.some((body) => !pythonSectionHasExecutableContent(body));
  });
}

function extractAutolabosSectionBodies(source: string, sectionId: string): string[] {
  const escapedSectionId = sectionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`^\s*#\s*BEGIN AUTOLABOS SECTION\s+${escapedSectionId}[^\n]*\n([\s\S]*?)^\s*#\s*END AUTOLABOS SECTION\s+${escapedSectionId}\b[^\n]*`,
    "gmu"
  );
  return Array.from(source.matchAll(pattern), (match) => match[1] || "");
}

function pythonSectionHasExecutableContent(body: string): boolean {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => !line.startsWith("#"));
}

async function detectLongRunningPythonRunnerWithoutProgressSurface(input: {
  runContext: RunContextMemory;
  command: string;
  cwd: string;
  workspaceRoot: string;
}): Promise<string | undefined> {
  const explicitScript = resolveMaybeRelative(
    await input.runContext.get<string>("implement_experiments.script"),
    input.workspaceRoot
  );
  const commandScript = extractPythonScriptPathFromCommand(input.command, input.cwd);
  const candidates = [commandScript, explicitScript]
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter((candidate) => path.extname(candidate) === ".py");
  const scriptPath = await firstExistingCandidate(candidates);
  if (!scriptPath) {
    return undefined;
  }

  let source = "";
  try {
    source = await fs.readFile(scriptPath, "utf8");
  } catch {
    return undefined;
  }

  const requiredRunCount = inferRequiredRunCountFromPythonSource(source);
  const longRunShape = requiredRunCount !== undefined && requiredRunCount >= 8;
  const heavyExecutionShape = [
    /\bfrom_pretrained\b/u,
    /\b(?:optimizer|scheduler)\s*\.\s*step\s*\(/u,
    /\b[A-Za-z_][A-Za-z0-9_]*\s*\.\s*backward\s*\(/u,
    /\brequires_grad_?\s*=\s*True\b/u,
    /\btrainable_(?:parameters|weights)\b/u,
    /\b(?:train|update)_steps?_per_run\b/u,
    /\bwhile\s+step_count\s*</u
  ].some((pattern) => pattern.test(source));
  if (!longRunShape || !heavyExecutionShape) {
    return undefined;
  }
  if (hasPythonProgressOrPartialMetricsSurface(source)) {
    return undefined;
  }

  return [
    "Long-running Python experiment runner " + path.basename(scriptPath) + " declares required_run_count=" + requiredRunCount + " and model/training execution but has no observable progress, heartbeat, or partial-metrics surface.",
    "A full paper-scale run must emit node-owned progress artifacts before long training/evaluation loops so the meta harness can distinguish real progress from a hang or silent dependency stall."
  ].join(" ");
}

async function detectLongRunningPythonRunnerWithoutBudgetEnforcement(input: {
  runContext: RunContextMemory;
  command: string;
  cwd: string;
  workspaceRoot: string;
  timeoutSec: number | undefined;
}): Promise<string | undefined> {
  if (!input.timeoutSec) {
    return undefined;
  }
  const explicitScript = resolveMaybeRelative(
    await input.runContext.get<string>("implement_experiments.script"),
    input.workspaceRoot
  );
  const commandScript = extractPythonScriptPathFromCommand(input.command, input.cwd);
  const scriptPath = await firstExistingCandidate(
    [commandScript, explicitScript]
      .filter((candidate): candidate is string => Boolean(candidate))
      .filter((candidate) => path.extname(candidate) === ".py")
  );
  if (!scriptPath) {
    return undefined;
  }

  let source = "";
  try {
    source = await fs.readFile(scriptPath, "utf8");
  } catch {
    return undefined;
  }
  return detectLongRunningPythonBudgetGuardFailure({
    source,
    timeoutSec: input.timeoutSec,
    scriptName: path.basename(scriptPath)
  });
}

function hasPythonProgressOrPartialMetricsSurface(source: string): boolean {
  return /\b(?:progress_path|heartbeat_path|partial_metrics_path|progress_file|heartbeat_file|status_path|progress_jsonl|heartbeat_jsonl|partial_metrics|run_progress|write_progress|emit_progress|record_progress|progress\.jsonl|heartbeat\.jsonl|partial_metrics\.json)\b/iu.test(source);
}

async function firstExistingCandidate(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function extractPythonScriptPathFromCommand(command: string, cwd: string): string | undefined {
  const match = command.match(/(?:^|\s)python(?:3)?(?:\s+-B)?\s+(?:"([^"]+\.py)"|'([^']+\.py)'|(\S+\.py))/u);
  const candidate = match?.[1] || match?.[2] || match?.[3];
  if (!candidate) {
    return undefined;
  }
  return path.isAbsolute(candidate) ? candidate : path.join(cwd, candidate);
}

async function enrichMetricsWithRawConditionEvidence(input: {
  metrics: Record<string, unknown>;
  metricsPath: string;
  workspaceRoot: string;
}): Promise<number> {
  const rawPath = rawConditionEvidencePath(input.metrics);
  if (!rawPath) {
    return 0;
  }
  const resolved = resolveMaybeRelative(rawPath, path.dirname(input.metricsPath));
  if (!resolved || !isLocalEvidencePath(resolved, [path.dirname(input.metricsPath), input.workspaceRoot])) {
    return 0;
  }

  let raw = '';
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
      return 0;
    }
    raw = await fs.readFile(resolved, 'utf8');
  } catch {
    return 0;
  }

  const rows = parseRawConditionEvidenceJsonl(raw).slice(0, 256);
  if (rows.length === 0) {
    return 0;
  }

  if (!Array.isArray(input.metrics.condition_seed_rows) || input.metrics.condition_seed_rows.length === 0) {
    input.metrics.condition_seed_rows = rows;
  }

  let enriched = 0;
  const unmatchedSummaryIds: string[] = [];
  const ambiguousFailureEvidence: Array<{ id: string; evidence: string[] }> = [];
  for (const summary of collectConditionRows(input.metrics.condition_results)) {
    if (conditionResultReason(summary)) {
      continue;
    }
    const id = conditionResultId(summary);
    const matchingRawRows = id
      ? rows.filter((row) => conditionResultId(row) === id)
      : [];
    if (matchingRawRows.length === 0) {
      unmatchedSummaryIds.push(id || "<missing condition id>");
      continue;
    }
    const distinctEvidence = new Map<string, { code?: string; reason: string; stage?: string }>();
    for (const matchingRaw of matchingRawRows) {
      const reason = conditionResultReason(matchingRaw);
      if (!reason) {
        continue;
      }
      const code =
        asString(matchingRaw.failure_code) ||
        asString(matchingRaw.error_code) ||
        asString(asRecord(matchingRaw.error).type);
      const stage = asString(matchingRaw.stage) || asString(matchingRaw.failure_stage);
      const evidence = { code, reason, stage };
      distinctEvidence.set(JSON.stringify(evidence), evidence);
    }
    if (distinctEvidence.size === 0) {
      continue;
    }
    if (distinctEvidence.size > 1) {
      ambiguousFailureEvidence.push({
        id: id || "<missing condition id>",
        evidence: [...distinctEvidence.values()].map((item) =>
          [
            item.code ? `code=${trimShort(item.code, 80)}` : undefined,
            `reason=${trimShort(item.reason, 160)}`,
            item.stage ? `stage=${trimShort(item.stage, 80)}` : undefined
          ].filter((value): value is string => Boolean(value)).join(",")
        )
      });
      continue;
    }
    let explicitEvidence: { code?: string; reason: string; stage?: string } | undefined;
    for (const item of distinctEvidence.values()) {
      explicitEvidence = item;
    }
    if (!explicitEvidence) {
      continue;
    }
    summary.failure_reason = explicitEvidence.reason;
    if (explicitEvidence.code && !asString(summary.failure_code)) {
      summary.failure_code = explicitEvidence.code;
    }
    if (explicitEvidence.stage && !asString(summary.failure_stage)) {
      summary.failure_stage = explicitEvidence.stage;
    }
    enriched += 1;
  }
  if (unmatchedSummaryIds.length > 0) {
    const distinctIds = [...new Set(unmatchedSummaryIds)];
    const boundedIds = distinctIds.slice(0, 8);
    const omitted = distinctIds.length - boundedIds.length;
    appendResultMeaningDiagnostic(input.metrics, {
      code: "raw_condition_evidence_enrichment_skipped_unmatched_condition",
      message:
        `Skipped raw condition evidence enrichment for ${unmatchedSummaryIds.length} condition summary row(s) ` +
        `without an exact condition id match (${boundedIds.join(", ")}${omitted > 0 ? `, +${omitted} more` : ""}).`
    });
  }
  if (ambiguousFailureEvidence.length > 0) {
    const allEvidence = ambiguousFailureEvidence.flatMap((item) =>
      item.evidence.map((evidence) => `${trimShort(item.id, 80)}[${evidence}]`)
    );
    const boundedEvidence = allEvidence.slice(0, 8);
    const omitted = allEvidence.length - boundedEvidence.length;
    appendResultMeaningDiagnostic(input.metrics, {
      code: "raw_condition_evidence_enrichment_skipped_ambiguous_failures",
      message:
        `Skipped raw condition evidence enrichment for ${ambiguousFailureEvidence.length} condition summary row(s) ` +
        `with multiple distinct failure observations: ${boundedEvidence.join(" | ")}` +
        `${omitted > 0 ? ` | +${omitted} more distinct failure(s)` : ""}.`
    });
  }

  if (enriched > 0) {
    input.metrics.raw_condition_evidence_path = resolved;
  }
  return rows.length;
}

function rawConditionEvidencePath(metrics: Record<string, unknown>): string | undefined {
  return (
    asString(metrics.raw_evidence_path) ||
    asString(metrics.raw_condition_results_path) ||
    asString(metrics.condition_seed_results_path) ||
    asString(metrics.per_seed_results_path)
  );
}

function parseRawConditionEvidenceJsonl(raw: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const record = asRecord(parsed);
      const nestedRecord = asRecord(record.record);
      rows.push(Object.keys(nestedRecord).length > 0 ? nestedRecord : record);
    } catch {
      continue;
    }
  }
  return rows;
}

function isLocalEvidencePath(filePath: string, roots: string[]): boolean {
  const resolved = path.resolve(filePath);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

async function enrichMetricsWithPythonRuntimeDefaults(input: {
  metrics: Record<string, unknown>;
  command: string;
  cwd: string;
}): Promise<string | undefined> {
  const scriptPath = extractPythonScriptPathFromCommand(input.command, input.cwd);
  if (!scriptPath) {
    return undefined;
  }
  let source: string;
  try {
    source = await fs.readFile(scriptPath, "utf8");
  } catch {
    return undefined;
  }

  const existingRunConfig = asRecord(input.metrics.run_config);
  const runConfig: Record<string, unknown> = { ...existingRunConfig };
  let changed = false;
  const setMetricString = (key: string, value: string | undefined): void => {
    if (!value || asString(input.metrics[key])) {
      return;
    }
    input.metrics[key] = value;
    changed = true;
  };
  const setRunConfigNumber = (key: string, value: number | undefined): void => {
    if (typeof value !== "number" || !Number.isFinite(value) || asNumber(runConfig[key]) !== undefined) {
      return;
    }
    runConfig[key] = value;
    changed = true;
  };
  const setRunConfigArray = (key: string, value: unknown[] | undefined): void => {
    if (!value || value.length === 0 || Array.isArray(runConfig[key])) {
      return;
    }
    runConfig[key] = value;
    changed = true;
  };

  setMetricString("selected_model_id", readPythonStringConstant(source, [
    "SELECTED_BASE_MODEL",
    "SELECTED_MODEL",
    "PREFERRED_BASE_MODEL",
    "PREFERRED_MODEL",
    "BASE_MODEL",
    "DEFAULT_BASE_MODEL"
  ]));
  setMetricString("preferred_model_id", readPythonStringConstant(source, [
    "PREFERRED_BASE_MODEL",
    "PREFERRED_MODEL",
    "DEFAULT_PREFERRED_MODEL"
  ]));
  setMetricString("fallback_model", readPythonStringConstant(source, [
    "FALLBACK_BASE_MODEL",
    "FALLBACK_MODEL",
    "DEFAULT_FALLBACK_MODEL"
  ]));
  setMetricString("fallback_model_id", asString(input.metrics.fallback_model));

  setRunConfigNumber("learning_rate", readPythonNumberConstant(source, ["DEFAULT_LEARNING_RATE", "LEARNING_RATE"]));
  setRunConfigNumber("max_steps", readPythonNumberConstant(source, ["DEFAULT_MAX_STEPS", "DEFAULT_OPTIMIZER_STEPS", "MAX_STEPS"]));
  setRunConfigNumber("optimizer_steps", asNumber(runConfig.max_steps));
  setRunConfigNumber("per_device_batch_size", readPythonNumberConstant(source, ["DEFAULT_BATCH_SIZE", "DEFAULT_PER_DEVICE_BATCH_SIZE", "BATCH_SIZE"]));
  setRunConfigNumber("per_device_train_batch_size", asNumber(runConfig.per_device_batch_size));
  setRunConfigNumber("gradient_accumulation_steps", readPythonNumberConstant(source, ["DEFAULT_GRAD_ACCUM_STEPS", "DEFAULT_GRADIENT_ACCUMULATION_STEPS", "GRADIENT_ACCUMULATION_STEPS"]));
  setRunConfigNumber("max_seq_length", readPythonNumberConstant(source, ["DEFAULT_MAX_SEQ_LENGTH", "DEFAULT_MAX_SEQUENCE_LENGTH", "MAX_SEQ_LENGTH", "MAX_SEQUENCE_LENGTH"]));
  setRunConfigNumber("timeout_sec", readPythonNumberConstant(source, ["DEFAULT_TIMEOUT_SEC", "TIMEOUT_SEC"]));
  setRunConfigNumber("max_train_samples", readPythonNumberConstant(source, ["DEFAULT_MAX_TRAIN_EXAMPLES", "MAX_TRAIN_EXAMPLES"]));
  setRunConfigNumber("max_eval_samples_per_task", readPythonNumberConstant(source, ["DEFAULT_MAX_EVAL_EXAMPLES_PER_TASK", "MAX_EVAL_EXAMPLES_PER_TASK"]));
  setRunConfigArray("seeds", readPythonTupleConstant(source, ["SEED_SCHEDULE", "PLANNED_SEEDS", "DEFAULT_SEEDS"]));

  if (changed) {
    if (Object.keys(runConfig).length > 0) {
      input.metrics.run_config = runConfig;
    }
    return `Projected runtime metadata from ${path.basename(scriptPath)} into metrics.json for reproducibility reporting.`;
  }
  return undefined;
}

function readPythonStringConstant(source: string, names: string[]): string | undefined {
  for (const name of names) {
    const match = source.match(new RegExp(`^\\s*${escapeRegExp(name)}\\s*=\\s*(["'])(.*?)\\1`, "mu"));
    const value = match?.[2]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readPythonNumberConstant(source: string, names: string[]): number | undefined {
  for (const name of names) {
    const match = source.match(new RegExp(`^\\s*${escapeRegExp(name)}\\s*=\\s*([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[-+]?\\d+)?)`, "mi"));
    if (!match?.[1]) {
      continue;
    }
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function readPythonTupleConstant(source: string, names: string[]): unknown[] | undefined {
  for (const name of names) {
    const match = source.match(new RegExp(`^\\s*${escapeRegExp(name)}\\s*=\\s*\\(([^\\)]*)\\)`, "mu"));
    if (!match?.[1]) {
      continue;
    }
    const values = match[1]
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const numeric = Number(item);
        return Number.isFinite(numeric) ? numeric : item.replace(/^['"]|['"]$/gu, "");
      });
    if (values.length > 0) {
      return values;
    }
  }
  return undefined;
}

function promotePerExampleConditionRowsToSummaries(metrics: Record<string, unknown>): string | undefined {
  if (Object.prototype.hasOwnProperty.call(metrics, "results_artifact")) {
    return undefined;
  }
  const conditionRows = collectConditionRows(metrics.condition_results);
  const rawRows = collectConditionRows(metrics.raw_condition_results);
  const preferRawRows = shouldPreferRawRowsForConditionProjection(conditionRows, rawRows);
  const rows = preferRawRows ? rawRows : conditionRows;
  if (rows.length === 0) {
    return undefined;
  }

  const binaryRows = rows.filter((row) => {
    const marker = asString(row.condition_marker) || asString(row.marker) || asString(row.condition_id);
    return Boolean(marker) && hasExplicitBinaryOutcomeContract(row);
  });
  const ambiguousObservationCount = rows.filter(
    (row) => hasAmbiguousPerExampleMetricObservation(row) && !hasExplicitBinaryOutcomeContract(row)
  ).length;
  if (binaryRows.length === 0) {
    if (ambiguousObservationCount > 0) {
      appendResultMeaningDiagnostic(metrics, {
        code: "per_example_projection_skipped_ambiguous_metric_semantics",
        message:
          `Preserved ${ambiguousObservationCount} per-example observation row(s) without binary-rate projection ` +
          "because they did not declare binary outcome semantics."
      });
      return `Skipped binary-rate projection for ${ambiguousObservationCount} ambiguous observation row(s); raw observations were preserved.`;
    }
    return undefined;
  }

  const metricResolution = resolveExplicitBinaryMetricDefinition(binaryRows);
  if (!metricResolution.metric) {
    appendResultMeaningDiagnostic(metrics, {
      code: "binary_projection_skipped_missing_metric_contract",
      message: metricResolution.diagnostic ||
        "Preserved explicit binary rows without projection because metric_id and metric_direction were not explicit and unique."
    });
    if (!Array.isArray(metrics.raw_condition_results)) {
      metrics.raw_condition_results = rows;
    }
    return metricResolution.diagnostic;
  }
  const metric = metricResolution.metric;

  type Group = { rows: Array<Record<string, unknown>>; tasks: Map<string, Array<Record<string, unknown>>> };
  const grouped = new Map<string, Group>();
  for (const row of binaryRows) {
    const marker = asString(row.condition_marker) || asString(row.marker) || asString(row.condition_id);
    if (!marker) {
      continue;
    }
    const tasks = projectionRowTasks(row);
    const group = grouped.get(marker) ?? { rows: [], tasks: new Map<string, Array<Record<string, unknown>>>() };
    group.rows.push(row);
    for (const task of tasks) {
      const taskRows = group.tasks.get(task) ?? [];
      taskRows.push(row);
      group.tasks.set(task, taskRows);
    }
    grouped.set(marker, group);
  }

  const roleResolution = resolveExplicitConditionRoles(metrics, rows);
  const series: ResultsSeriesV2[] = [];
  const observations: ResultsObservationV2[] = [];
  const confidenceIntervals: Array<Record<string, unknown>> = [];
  const binaryCountEvidence: Array<Record<string, unknown>> = [];
  const pooledObservationBySeries = new Map<string, ResultsObservationV2>();
  for (const [marker, group] of grouped.entries()) {
    const role = resolveExplicitSeriesRole(marker, group.rows, roleResolution);
    series.push({
      id: marker,
      label: marker,
      ...(role ? { role } : {}),
      dimensions: {}
    });
    const seeds: unknown[] = [];
    for (const row of group.rows) {
      const seed = projectionRowSeed(row);
      if (seed !== undefined && seed !== null && !seeds.some((seen) => String(seen) === String(seed))) {
        seeds.push(seed);
      }
    }
    let totalCorrect = 0;
    let totalCount = 0;
    for (const [task, taskRows] of [...group.tasks.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      let correctCount = 0;
      let count = 0;
      for (const row of taskRows) {
        const outcome = extractExplicitBinaryOutcome(row, conditionRowTaskMetrics(row, task));
        if (!outcome) {
          continue;
        }
        correctCount += outcome.correctCount;
        count += outcome.totalCount;
      }
      if (count <= 0) {
        continue;
      }
      const observation: ResultsObservationV2 = {
        id: buildResultsObservationId(marker, metric.id, `task:${task}`),
        series_id: marker,
        metric_id: metric.id,
        scope: { task },
        value: correctCount / count
      };
      observations.push(observation);
      binaryCountEvidence.push({
        observation_id: observation.id,
        correct_count: correctCount,
        total_count: count
      });
      const interval = wilsonInterval(correctCount, count);
      if (interval) {
        confidenceIntervals.push({ observation_id: observation.id, ...interval });
      }
      totalCorrect += correctCount;
      totalCount += count;
    }
    if (totalCount <= 0) {
      continue;
    }
    const pooledObservation: ResultsObservationV2 = {
      id: buildResultsObservationId(marker, metric.id, "pooled"),
      series_id: marker,
      metric_id: metric.id,
      scope: { aggregation: "pooled_binary_count" },
      value: totalCorrect / totalCount
    };
    observations.push(pooledObservation);
    pooledObservationBySeries.set(marker, pooledObservation);
    binaryCountEvidence.push({
      observation_id: pooledObservation.id,
      correct_count: totalCorrect,
      total_count: totalCount,
      seeds,
      seed_count: seeds.length
    });
    const interval = wilsonInterval(totalCorrect, totalCount);
    if (interval) {
      confidenceIntervals.push({ observation_id: pooledObservation.id, ...interval });
    }
  }
  if (observations.length === 0) {
    return undefined;
  }

  const artifact: ResultsArtifactV2 = {
    schema_version: "2.0",
    metrics: [metric],
    series,
    observations,
    comparisons: []
  };
  const validation = validateResultsArtifactV2(artifact);
  if (!validation.valid) {
    appendResultMeaningDiagnostic(metrics, {
      code: "binary_projection_rejected_invalid_results_v2",
      message:
        `Rejected binary projection because the generated ResultsArtifactV2 was invalid: ` +
        validation.issues.slice(0, 8).join(" "),
      severity: "error"
    });
    return "Binary projection was rejected by ResultsArtifactV2 validation.";
  }

  if (grouped.size > 1 && (!roleResolution.baselineId || !roleResolution.primaryId)) {
    appendResultMeaningDiagnostic(metrics, {
      code: "comparison_projection_skipped_ambiguous_series_roles",
      message: roleResolution.diagnostic ||
        "Preserved condition observations without a comparison because baseline and primary series roles were not explicit and unique."
    });
  }
  if (ambiguousObservationCount > 0) {
    appendResultMeaningDiagnostic(metrics, {
      code: "per_example_projection_skipped_ambiguous_metric_semantics",
      message:
        `Preserved ${ambiguousObservationCount} per-example observation row(s) without binary-rate projection ` +
        "because they did not declare binary outcome semantics."
    });
  }

  metrics.results_artifact = artifact;
  metrics.binary_count_evidence = binaryCountEvidence;
  if (roleResolution.primaryId) {
    const selectedObservation = pooledObservationBySeries.get(roleResolution.primaryId);
    if (selectedObservation) {
      metrics.results_selection = {
        metric_id: metric.id,
        primary_observation_id: selectedObservation.id
      };
    }
  }
  if (!Array.isArray(metrics.raw_condition_results)) {
    metrics.raw_condition_results = rows;
  }
  metrics.confidence_intervals = [
    ...(Array.isArray(metrics.confidence_intervals) ? metrics.confidence_intervals : []),
    ...confidenceIntervals
  ];
  metrics.statistical_summary = {
    ...asRecord(metrics.statistical_summary),
    confidence_intervals: metrics.confidence_intervals
  };
  return (
    `Projected ${binaryRows.length} explicit binary outcome row(s) into ` +
    `${observations.length} ResultsArtifactV2 observation(s) with Wilson intervals and no synthesized comparison.`
  );
}

function resolveExplicitBinaryMetricDefinition(
  rows: Array<Record<string, unknown>>
): { metric?: ResultsMetricDefinitionV2; diagnostic?: string } {
  const definitions = new Map<string, ResultsMetricDefinitionV2>();
  let incompleteCount = 0;
  for (const row of rows) {
    const raw = asRecord(row.raw_evidence);
    const taskRecords = projectionRowTasks(row).map((task) => conditionRowTaskMetrics(row, task));
    const candidates = [
      row,
      raw,
      asRecord(raw.raw_evidence),
      asRecord(row.result),
      asRecord(raw.result),
      ...taskRecords
    ];
    const metricId = candidates.map((item) => asString(item.metric_id)).find(Boolean);
    const direction = candidates
      .map((item) => asString(item.metric_direction) || asString(item.direction))
      .find((value) => value === "higher_better" || value === "lower_better");
    const unit = candidates
      .map((item) => asString(item.metric_unit) || asString(item.unit))
      .find(Boolean);
    const label = candidates.map((item) => asString(item.metric_label)).find(Boolean) || metricId;
    if (!metricId || !direction || !unit || !label) {
      incompleteCount += 1;
      continue;
    }
    const definition: ResultsMetricDefinitionV2 = {
      id: metricId,
      label,
      direction,
      unit
    };
    definitions.set(JSON.stringify(definition), definition);
  }
  if (incompleteCount > 0) {
    return {
      diagnostic:
        `Skipped binary projection because ${incompleteCount}/${rows.length} row(s) omitted ` +
        "an explicit metric_id, metric_direction, or metric_unit."
    };
  }
  if (definitions.size !== 1) {
    return {
      diagnostic:
        `Skipped binary projection because rows declared ${definitions.size} distinct metric contracts; ` +
        "one explicit metric id and direction are required."
    };
  }
  for (const metric of definitions.values()) {
    return { metric };
  }
  return { diagnostic: "Skipped binary projection because no explicit metric contract was recorded." };
}

function resolveExplicitSeriesRole(
  marker: string,
  rows: Array<Record<string, unknown>>,
  roleResolution: ReturnType<typeof resolveExplicitConditionRoles>
): ResultsSeriesRole | undefined {
  const roles = new Set<ResultsSeriesRole>();
  for (const row of rows) {
    const role = projectionRowRole(row);
    if (role === "baseline" || role === "comparator" || role === "primary" || role === "control" || role === "other") {
      roles.add(role);
    }
  }
  if (roleResolution.baselineId === marker) {
    roles.add("baseline");
  }
  if (roleResolution.primaryId === marker) {
    roles.add("primary");
  }
  return roles.size === 1 ? [...roles][0] : undefined;
}

function buildResultsObservationId(seriesId: string, metricId: string, scopeId: string): string {
  return [seriesId, metricId, scopeId]
    .map((value) => value.replace(/[^A-Za-z0-9_.:-]+/gu, "_"))
    .join("::");
}

function shouldPreferRawRowsForConditionProjection(
  conditionRows: Array<Record<string, unknown>>,
  rawRows: Array<Record<string, unknown>>
): boolean {
  if (rawRows.length === 0) {
    return conditionRows.length === 0;
  }
  if (conditionRows.length === 0) {
    return true;
  }
  const conditionSeedRows = conditionRows.filter((row) => projectionRowSeed(row) !== undefined).length;
  const rawSeedRows = rawRows.filter((row) => projectionRowSeed(row) !== undefined).length;
  const rawMetricRows = rawRows.filter(isProjectablePerExampleConditionRow).length;
  const projectableRawEvidenceCount = rawRows.filter(isProjectablePerExampleConditionRow).length;
  return (
    rawMetricRows > 0 &&
    (rawSeedRows > conditionSeedRows || projectableRawEvidenceCount > conditionRows.length)
  );
}

function isClearlyPerExampleConditionRow(row: Record<string, unknown>): boolean {
  const marker = asString(row.condition_marker) || asString(row.marker) || asString(row.condition_id);
  if (!marker) {
    return false;
  }
  const raw = asRecord(row.raw_evidence);
  const nestedRaw = asRecord(raw.raw_evidence);
  return [row, raw, nestedRaw].some(
    (candidate) =>
      typeof candidate.correct === "boolean" ||
      (asNumber(candidate.correct_count) !== undefined && asNumber(candidate.total_count) !== undefined) ||
      candidate.example_id !== undefined ||
      candidate.prediction !== undefined ||
      candidate.gold_key !== undefined
  );
}

function isProjectablePerExampleConditionRow(row: Record<string, unknown>): boolean {
  const marker = asString(row.condition_marker) || asString(row.marker) || asString(row.condition_id);
  return Boolean(marker) && hasExplicitBinaryOutcomeContract(row);
}

function hasExplicitBinaryOutcomeContract(row: Record<string, unknown>): boolean {
  return projectionRowTasks(row).some((task) =>
    Boolean(extractExplicitBinaryOutcome(row, conditionRowTaskMetrics(row, task)))
  );
}

function hasAmbiguousPerExampleMetricObservation(row: Record<string, unknown>): boolean {
  if (!isClearlyPerExampleConditionRow(row)) {
    return false;
  }
  const structuralNumericKeys = new Set([
    "seed",
    "seed_id",
    "random_seed",
    "correct_count",
    "total_count",
    "example_index",
    "row_index",
    "duration_ms"
  ]);
  const candidates = [
    row,
    asRecord(row.raw_evidence),
    asRecord(asRecord(row.raw_evidence).raw_evidence),
    ...projectionRowTasks(row).map((task) => conditionRowTaskMetrics(row, task))
  ];
  return candidates.some((candidate) =>
    Object.entries(candidate).some(
      ([key, value]) => !structuralNumericKeys.has(key) && asNumber(value) !== undefined
    )
  );
}

function extractExplicitBinaryOutcome(
  row: Record<string, unknown>,
  taskMetrics: Record<string, unknown>
): {
  correctCount: number;
  totalCount: number;
  booleanOutcome?: boolean;
} | undefined {
  const raw = asRecord(row.raw_evidence);
  const candidates = [
    row,
    raw,
    asRecord(raw.raw_evidence),
    asRecord(row.result),
    asRecord(raw.result),
    taskMetrics
  ];
  for (const candidate of candidates) {
    const booleanOutcome = [candidate.correct, candidate.is_correct, candidate.outcome]
      .find((value): value is boolean => typeof value === "boolean");
    if (booleanOutcome !== undefined) {
      return {
        correctCount: booleanOutcome ? 1 : 0,
        totalCount: 1,
        booleanOutcome
      };
    }
    const correctCount = asNumber(candidate.correct_count);
    const totalCount = asNumber(candidate.total_count);
    if (
      correctCount !== undefined &&
      totalCount !== undefined &&
      Number.isInteger(correctCount) &&
      Number.isInteger(totalCount) &&
      correctCount >= 0 &&
      totalCount > 0 &&
      correctCount <= totalCount
    ) {
      return { correctCount, totalCount };
    }
  }
  return undefined;
}

function appendResultMeaningDiagnostic(
  metrics: Record<string, unknown>,
  diagnostic: { code: string; message: string; severity?: "warning" | "error" }
): void {
  const existing = Array.isArray(metrics.run_experiments_diagnostics)
    ? metrics.run_experiments_diagnostics
        .map((item) => asRecord(item))
        .filter((item) => Object.keys(item).length > 0)
    : [];
  if (existing.some((item) => asString(item.code) === diagnostic.code && asString(item.message) === diagnostic.message)) {
    return;
  }
  metrics.run_experiments_diagnostics = [...existing, diagnostic].slice(0, 32);
}

function resolveExplicitConditionRoles(
  metrics: Record<string, unknown>,
  rows: Array<Record<string, unknown>>
): {
  baselineId?: string;
  primaryId?: string;
  diagnostic?: string;
} {
  const baselineIds = new Set<string>();
  const primaryIds = new Set<string>();
  const comparison = asRecord(metrics.primary_comparison);
  const genericComparison = asRecord(metrics.comparison);
  const primaryObservation = asRecord(metrics.primary_observation);
  const add = (target: Set<string>, value: unknown): void => {
    const id = asString(value);
    if (id) {
      target.add(id);
    }
  };

  for (const value of [
    metrics.baseline_condition_marker,
    metrics.baseline_condition_id,
    metrics.baseline_condition,
    metrics.baseline_id,
    comparison.baseline_condition_id,
    comparison.baseline_id,
    genericComparison.baseline_condition_id,
    genericComparison.baseline_id
  ]) {
    add(baselineIds, value);
  }
  for (const value of [
    metrics.primary_condition_marker,
    metrics.primary_condition_id,
    metrics.primary_condition,
    comparison.primary_condition_id,
    comparison.primary_id,
    comparison.candidate_id,
    genericComparison.primary_condition_id,
    genericComparison.primary_id,
    primaryObservation.condition_id,
    primaryObservation.condition_marker
  ]) {
    add(primaryIds, value);
  }

  for (const row of rows) {
    const id = asString(row.condition_marker) || asString(row.marker) || asString(row.condition_id) || asString(row.id);
    if (!id) {
      continue;
    }
    if (projectionRowBaselineFlag(row) === true || projectionRowRole(row) === "baseline") {
      baselineIds.add(id);
    }
    if (projectionRowPrimaryFlag(row) === true || projectionRowRole(row) === "primary") {
      primaryIds.add(id);
    }
  }

  const baselineId = baselineIds.size === 1 ? [...baselineIds][0] : undefined;
  const primaryId = primaryIds.size === 1 ? [...primaryIds][0] : undefined;
  const diagnostics: string[] = [];
  if (baselineIds.size === 0) {
    diagnostics.push("No explicit baseline condition id or role was recorded.");
  } else if (baselineIds.size > 1) {
    diagnostics.push(`Multiple explicit baseline conditions were recorded: ${[...baselineIds].join(", ")}.`);
  }
  if (primaryIds.size === 0) {
    diagnostics.push("No explicit primary condition id or role was recorded.");
  } else if (primaryIds.size > 1) {
    diagnostics.push(`Multiple explicit primary conditions were recorded: ${[...primaryIds].join(", ")}.`);
  }
  if (baselineId && primaryId && baselineId === primaryId) {
    diagnostics.push(`Condition ${baselineId} was declared as both baseline and primary.`);
    return { diagnostic: diagnostics.join(" ") };
  }
  return {
    baselineId,
    primaryId,
    diagnostic: diagnostics.length > 0 ? diagnostics.join(" ") : undefined
  };
}

function projectionRowRole(row: Record<string, unknown>): string | undefined {
  const raw = asRecord(row.raw_evidence);
  for (const candidate of [row, raw, asRecord(raw.raw_evidence), asRecord(row.result), asRecord(raw.result)]) {
    const role = asString(candidate.role) || asString(candidate.condition_role);
    if (role) {
      return role.toLowerCase();
    }
  }
  return undefined;
}

function projectionRowPrimaryFlag(row: Record<string, unknown>): boolean | undefined {
  const raw = asRecord(row.raw_evidence);
  for (const candidate of [row, raw, asRecord(raw.raw_evidence), asRecord(row.result), asRecord(raw.result)]) {
    if (candidate.is_primary === true || candidate.primary === true) {
      return true;
    }
    if (candidate.is_primary === false || candidate.primary === false) {
      return false;
    }
  }
  return undefined;
}

function projectionRowSeed(row: Record<string, unknown>): unknown {
  const raw = asRecord(row.raw_evidence);
  const nestedRaw = asRecord(raw.raw_evidence);
  return row.seed ?? row.seed_id ?? row.random_seed ?? raw.seed ?? raw.seed_id ?? raw.random_seed ?? nestedRaw.seed ?? nestedRaw.seed_id ?? nestedRaw.random_seed;
}

function projectionRowTasks(row: Record<string, unknown>): string[] {
  const explicitTask = asString(row.task) || asString(row.benchmark) || asString(row.dataset);
  if (explicitTask) {
    return [explicitTask];
  }
  const tasks = new Set<string>();
  const candidates = [
    row,
    asRecord(row.raw_evidence),
    asRecord(asRecord(row.raw_evidence).raw_evidence),
    asRecord(row.result),
    asRecord(asRecord(row.raw_evidence).result)
  ];
  for (const candidate of candidates) {
    for (const key of Object.keys(asRecord(candidate.task_metrics))) {
      tasks.add(key);
    }
    for (const key of Object.keys(asRecord(candidate.evaluation))) {
      tasks.add(key);
    }
  }
  return tasks.size > 0 ? [...tasks].sort() : ["overall"];
}

function conditionRowTaskMetrics(row: Record<string, unknown>, task: string): Record<string, unknown> {
  const candidates = [
    row,
    asRecord(row.raw_evidence),
    asRecord(asRecord(row.raw_evidence).raw_evidence),
    asRecord(row.result),
    asRecord(asRecord(row.raw_evidence).result)
  ];
  for (const candidate of candidates) {
    const taskMetrics = asRecord(candidate.task_metrics);
    const taskRecord = asRecord(taskMetrics[task]);
    if (Object.keys(taskRecord).length > 0) {
      return taskRecord;
    }
    const evaluation = asRecord(candidate.evaluation);
    const evaluationRecord = asRecord(evaluation[task]);
    if (Object.keys(evaluationRecord).length > 0) {
      return evaluationRecord;
    }
  }
  return {};
}

function wilsonInterval(correctCount: number, totalCount: number): Record<string, unknown> | undefined {
  if (
    !Number.isFinite(correctCount) ||
    !Number.isFinite(totalCount) ||
    !Number.isInteger(correctCount) ||
    !Number.isInteger(totalCount) ||
    correctCount < 0 ||
    totalCount <= 0 ||
    correctCount > totalCount
  ) {
    return undefined;
  }
  const z = 1.96;
  const p = correctCount / totalCount;
  const denominator = 1 + (z * z) / totalCount;
  const center = (p + (z * z) / (2 * totalCount)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * totalCount)) / totalCount)) / denominator;
  return {
    confidence_level: 0.95,
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
    sample_size: totalCount,
    correct_count: correctCount,
    total_count: totalCount
  };
}

interface ExplicitResultsSelection {
  artifact: ResultsArtifactV2;
  metric: ResultsMetricDefinitionV2;
  series: ResultsSeriesV2;
  observation: ResultsObservationV2;
  comparison?: ResultsComparisonV2;
}

interface ExplicitResultsSelectionResolution {
  selection?: ExplicitResultsSelection;
  diagnostic?: { code: string; message: string; severity: "warning" | "error" };
}

function promoteExplicitResultsPrimaryObservation(metrics: Record<string, unknown>): string | undefined {
  const promotions = [
    promoteAggregateExecutionMetadata(metrics),
    promoteTrainingAggregateMetrics(metrics)
  ].filter((value): value is string => Boolean(value));
  const resolution = resolveExplicitResultsSelection(metrics);
  if (resolution.diagnostic) {
    appendResultMeaningDiagnostic(metrics, resolution.diagnostic);
    promotions.push(resolution.diagnostic.message);
  }
  const selection = resolution.selection;
  if (!selection) {
    return promotions.length > 0 ? promotions.join(" ") : undefined;
  }

  const declaredMetricId = asString(metrics.primary_metric_key);
  const declaredMetricValue = asNumber(metrics.primary_metric_value);
  const existingMetricValue = asNumber(metrics[selection.metric.id]);
  const conflicts = [
    declaredMetricId && declaredMetricId !== selection.metric.id
      ? `primary_metric_key=${declaredMetricId} conflicts with selected metric_id=${selection.metric.id}`
      : undefined,
    declaredMetricValue !== undefined && Math.abs(declaredMetricValue - selection.observation.value) > 1e-12
      ? `primary_metric_value=${declaredMetricValue} conflicts with selected observation value=${selection.observation.value}`
      : undefined,
    existingMetricValue !== undefined && Math.abs(existingMetricValue - selection.observation.value) > 1e-12
      ? `${selection.metric.id}=${existingMetricValue} conflicts with selected observation value=${selection.observation.value}`
      : undefined
  ].filter((value): value is string => Boolean(value));
  if (conflicts.length > 0) {
    const diagnostic = {
      code: "results_v2_primary_selection_conflict",
      message: `Rejected primary observation promotion because ${conflicts.join("; ")}.`,
      severity: "error" as const
    };
    appendResultMeaningDiagnostic(metrics, diagnostic);
    promotions.push(diagnostic.message);
    return promotions.join(" ");
  }

  metrics.primary_metric_key = selection.metric.id;
  metrics.primary_metric_value = selection.observation.value;
  metrics.primary_metric_direction = selection.metric.direction;
  metrics.primary_observation_id = selection.observation.id;
  metrics[selection.metric.id] = selection.observation.value;
  if (selection.comparison) {
    metrics.primary_comparison_id = selection.comparison.id;
  }
  promotions.push(
    `Promoted explicit ResultsArtifactV2 observation ${selection.observation.id} ` +
      `for metric ${selection.metric.id}=${selection.observation.value}.`
  );
  return promotions.join(" ");
}

function resolveExplicitResultsSelection(
  metrics: Record<string, unknown>
): ExplicitResultsSelectionResolution {
  if (!Object.prototype.hasOwnProperty.call(metrics, "results_artifact")) {
    return {};
  }
  const validation = validateResultsArtifactV2(metrics.results_artifact);
  if (!validation.valid) {
    return {
      diagnostic: {
        code: "results_v2_contract_rejected",
        message:
          `Rejected ResultsArtifactV2 projection: ${validation.issues.slice(0, 8).join(" ")}` +
          `${validation.issues.length > 8 ? ` +${validation.issues.length - 8} more issue(s).` : ""}`,
        severity: "error"
      }
    };
  }

  const artifact = metrics.results_artifact as ResultsArtifactV2;
  const selector = asRecord(metrics.results_selection);
  const explicitObservationId =
    asString(selector.primary_observation_id) || asString(metrics.primary_observation_id);
  const explicitComparisonId =
    asString(selector.primary_comparison_id) || asString(metrics.primary_comparison_id);
  let comparison: ResultsComparisonV2 | undefined;
  if (explicitComparisonId) {
    comparison = artifact.comparisons.find((item) => item.id === explicitComparisonId);
    if (!comparison) {
      return {
        diagnostic: {
          code: "results_v2_selection_rejected_unknown_comparison",
          message: `Results selection references unknown comparison id ${explicitComparisonId}.`,
          severity: "error"
        }
      };
    }
  }

  let observation: ResultsObservationV2 | undefined;
  if (explicitObservationId) {
    observation = artifact.observations.find((item) => item.id === explicitObservationId);
    if (!observation) {
      return {
        diagnostic: {
          code: "results_v2_selection_rejected_unknown_observation",
          message: `Results selection references unknown observation id ${explicitObservationId}.`,
          severity: "error"
        }
      };
    }
  }
  if (comparison) {
    const subject = artifact.observations.find(
      (item) => item.id === comparison?.subject_observation_id
    );
    if (!subject) {
      return {
        diagnostic: {
          code: "results_v2_selection_rejected_invalid_comparison",
          message: `Selected comparison ${comparison.id} has no resolvable subject observation.`,
          severity: "error"
        }
      };
    }
    if (observation && observation.id !== subject.id) {
      return {
        diagnostic: {
          code: "results_v2_selection_rejected_conflicting_references",
          message:
            `Selected observation ${observation.id} is not the subject of selected comparison ${comparison.id}.`,
          severity: "error"
        }
      };
    }
    observation = subject;
  }

  const explicitMetricId =
    asString(selector.metric_id) ||
    asString(metrics.primary_metric_key) ||
    observation?.metric_id;
  if (!observation && explicitMetricId) {
    const primarySeries = artifact.series.filter((item) => item.role === "primary");
    if (primarySeries.length === 1) {
      const candidates = artifact.observations.filter(
        (item) => item.series_id === primarySeries[0].id && item.metric_id === explicitMetricId
      );
      if (candidates.length === 1) {
        observation = candidates[0];
      } else if (candidates.length > 1) {
        return {
          diagnostic: {
            code: "results_v2_selection_rejected_ambiguous_primary_observations",
            message:
              `Primary series ${primarySeries[0].id} has ${candidates.length} observations for metric ${explicitMetricId}; ` +
              "results_selection.primary_observation_id is required.",
            severity: "error"
          }
        };
      }
    } else if (primarySeries.length > 1) {
      return {
        diagnostic: {
          code: "results_v2_selection_rejected_ambiguous_primary_series",
          message: `ResultsArtifactV2 declares ${primarySeries.length} series with role=primary.`,
          severity: "error"
        }
      };
    }
  }
  if (!observation) {
    return {
      diagnostic: {
        code: "results_v2_selection_missing",
        message:
          "Preserved ResultsArtifactV2 without objective promotion because no explicit primary observation, " +
          "comparison subject, or unique primary-series observation was selected.",
        severity: "warning"
      }
    };
  }

  const metricId = explicitMetricId || observation.metric_id;
  if (observation.metric_id !== metricId) {
    return {
      diagnostic: {
        code: "results_v2_selection_rejected_metric_mismatch",
        message:
          `Selected observation ${observation.id} records metric_id=${observation.metric_id}, ` +
          `not selected metric_id=${metricId}.`,
        severity: "error"
      }
    };
  }
  const metric = artifact.metrics.find((item) => item.id === metricId);
  const series = artifact.series.find((item) => item.id === observation?.series_id);
  if (!metric || !series || !series.role) {
    return {
      diagnostic: {
        code: "results_v2_selection_rejected_incomplete_semantics",
        message:
          `Selected observation ${observation.id} requires an explicit metric definition with direction ` +
          "and a series with an explicit role.",
        severity: "error"
      }
    };
  }
  return { selection: { artifact, metric, series, observation, comparison } };
}

function promoteAggregateExecutionMetadata(metrics: Record<string, unknown>): string | undefined {
  const aggregate = asRecord(metrics.aggregate);
  if (Object.keys(aggregate).length === 0) {
    return undefined;
  }
  const promoted: string[] = [];
  for (const key of [
    "completed_run_count",
    "required_run_count",
    "completed_condition_count",
    "required_condition_count",
    "failed_run_count",
    "timed_out_run_count"
  ]) {
    promoteNumericField(metrics, aggregate, key, promoted);
  }
  return promoted.length > 0
    ? `Promoted explicit aggregate execution counts before contract evaluation: ${promoted.join(", ")}.`
    : undefined;
}

function promoteTrainingAggregateMetrics(metrics: Record<string, unknown>): string | undefined {
  const trainingAggregates = asRecord(metrics.training_aggregates);
  if (Object.keys(trainingAggregates).length === 0) {
    return undefined;
  }

  const promoted: string[] = [];
  for (const key of [
    "completed_run_count",
    "required_run_count",
    "failed_run_count",
    "timed_out_run_count",
    "completed_condition_count",
    "required_condition_count"
  ]) {
    promoteNumericField(metrics, trainingAggregates, key, promoted);
  }
  return promoted.length > 0
    ? `Promoted explicitly declared training aggregate fields before contract evaluation: ${promoted.join(", ")}.`
    : undefined;
}

function promoteNumericField(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  promoted: string[]
): void {
  if (asNumber(target[key]) !== undefined) {
    return;
  }
  const value = asNumber(source[key]);
  if (value === undefined) {
    return;
  }
  target[key] = value;
  promoted.push(`${key}=${value}`);
}

function projectionRowBaselineFlag(row: Record<string, unknown>): boolean | undefined {
  const raw = asRecord(row.raw_evidence);
  const nestedRaw = asRecord(raw.raw_evidence);
  for (const candidate of [row, raw, nestedRaw, asRecord(row.result), asRecord(raw.result)]) {
    if (candidate.is_baseline === true || candidate.baseline === true) {
      return true;
    }
    if (candidate.is_baseline === false || candidate.baseline === false) {
      return false;
    }
  }
  return undefined;
}

function countTextOccurrences(text: string, token: string): number {
  if (!token) {
    return 0;
  }
  let count = 0;
  let index = text.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(token, index + token.length);
  }
  return count;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function loadImplementBootstrapContract(publicDir: string): Promise<{
  requires_network?: boolean;
  blocking_reason?: string;
  summary?: string;
  remediation?: string[];
} | undefined> {
  const contractPath = path.join(publicDir, "bootstrap_contract.json");
  if (!(await fileExists(contractPath))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(contractPath, "utf8")) as Record<string, unknown>;
    return {
      requires_network: parsed.requires_network === true,
      blocking_reason: typeof parsed.blocking_reason === "string" ? parsed.blocking_reason : undefined,
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
      remediation: Array.isArray(parsed.remediation)
        ? parsed.remediation.filter((item): item is string => typeof item === "string")
        : undefined
    };
  } catch {
    return undefined;
  }
}

function formatRunLabel(experimentMode: string, trigger = "manual"): string {
  const prefix = trigger === "auto_handoff" ? "Second-stage verifier" : undefined;
  if (experimentMode === "synthetic_validation") {
    return prefix ? `${prefix} synthetic validation run` : "Synthetic validation run";
  }
  if (experimentMode === "hybrid_validation") {
    return prefix ? `${prefix} hybrid experiment run` : "Hybrid experiment run";
  }
  return prefix ? `${prefix} experiment run` : "Experiment run";
}

function buildRunVerifierReport(input: {
  status: "pass" | "fail" | "skipped";
  trigger: RunVerifierTrigger;
  stage: "preflight_test" | "command" | "metrics" | "policy" | "success";
  summary: string;
  policyRuleId?: string;
  policyReason?: string;
  command?: string;
  cwd?: string;
  metricsPath?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  logFile?: string;
  suggestedNextAction?: string;
  failureCode?: RunVerifierReport["failure_code"];
  repairTarget?: RunVerifierReport["repair_target"];
  recommendedBacktrackNode?: RunVerifierReport["recommended_backtrack_node"];
  upstreamRepairHint?: string;
  operatorActionRequired?: boolean;
}): RunVerifierReport {
  const inferredDependencyRepair = inferRunVerifierDependencyRepair(
    input.summary,
    input.stderr,
    input.suggestedNextAction
  );
  const failureCode = input.failureCode || inferredDependencyRepair?.failureCode;
  const repairTarget = input.repairTarget || inferredDependencyRepair?.repairTarget;
  const recommendedBacktrackNode = input.recommendedBacktrackNode || inferredDependencyRepair?.recommendedBacktrackNode;
  const upstreamRepairHint = input.upstreamRepairHint || inferredDependencyRepair?.upstreamRepairHint;
  const operatorActionRequired = input.operatorActionRequired ?? inferredDependencyRepair?.operatorActionRequired;
  return {
    source: "run_experiments",
    status: input.status,
    trigger: input.trigger,
    stage: input.stage,
    summary: oneLine(input.summary),
    policy_rule_id: input.policyRuleId,
    policy_reason: input.policyReason,
    command: input.command,
    cwd: input.cwd,
    metrics_path: input.metricsPath,
    exit_code: input.exitCode,
    stdout_excerpt: trimExcerpt(input.stdout),
    stderr_excerpt: trimExcerpt(input.stderr),
    log_file: input.logFile,
    suggested_next_action: input.suggestedNextAction,
    failure_code: failureCode,
    repair_target: repairTarget,
    recommended_backtrack_node: recommendedBacktrackNode,
    upstream_repair_hint: upstreamRepairHint,
    operator_action_required: operatorActionRequired,
    recorded_at: new Date().toISOString()
  };
}

function inferRunVerifierDependencyRepair(...parts: Array<string | undefined>): {
  failureCode: RunVerifierReport["failure_code"];
  repairTarget: RunVerifierReport["repair_target"];
  recommendedBacktrackNode: RunVerifierReport["recommended_backtrack_node"];
  upstreamRepairHint: string;
  operatorActionRequired: boolean;
} | undefined {
  const text = parts.filter((part): part is string => Boolean(part)).join("\n");
  if (/data_dependency_unavailable|Experiment dependency blocked\s*\(data_dependency|loader_diagnostics=.*stage=data_access/iu.test(text)) {
    return {
      failureCode: "data_dependency_unavailable",
      repairTarget: "implementation",
      recommendedBacktrackNode: "implement_experiments",
      upstreamRepairHint:
        "Repair task-specific data materialization and schema normalization in implement_experiments before rerunning; preserve the approved task, split, and minimum-count contract, and do not lower the evidence floor or fabricate records.",
      operatorActionRequired: true
    };
  }
  if (/Experiment dependency blocker:/iu.test(text)) {
    return {
      failureCode: "model_dependency_unavailable",
      repairTarget: "environment_dependency",
      recommendedBacktrackNode: "design_experiments",
      upstreamRepairHint:
        "If the model/tokenizer assets cannot be made available in this environment, backtrack to design_experiments and select an available local model or explicitly mark the run as dependency-blocked; do not retry the same implementation unchanged.",
      operatorActionRequired: true
    };
  }
  return undefined;
}

async function persistRunVerifierReport(
  run: Parameters<typeof writeRunArtifact>[0],
  runContext: RunContextMemory,
  report: RunVerifierReport
): Promise<PublishPublicRunOutputsResult> {
  const reportPath = await writeRunArtifact(run, "run_experiments_verify_report.json", JSON.stringify(report, null, 2));
  const runDir = path.join(process.cwd(), ".autolabos", "runs", run.id);
  const intermediateArtifactCapture = await buildIntermediateArtifactCaptureManifest({
    runId: run.id,
    runDir,
    node: "run_experiments",
    phase: report.stage,
    status: report.status,
    artifacts: [
      {
        artifactId: "run_experiments_verify_report",
        filePath: reportPath,
        role: "verification",
        required: true,
        parseAs: "json"
      },
      {
        artifactId: "metrics",
        filePath: report.metrics_path,
        role: "metric",
        required: report.status === "pass",
        parseAs: "json",
        notes: report.metrics_path
          ? ["Metrics are required for paper-scale claims only when verification passes."]
          : ["No metrics path was recorded by the runner."]
      },
      {
        artifactId: "run_log",
        filePath: report.log_file,
        role: "log",
        required: false,
        parseAs: "text"
      }
    ]
  });
  const intermediateArtifactCapturePath = await writeRunArtifact(
    run,
    "run_experiments/intermediate_artifacts.json",
    JSON.stringify(intermediateArtifactCapture, null, 2)
  );
  const publicOutputs = await publishPublicRunOutputs({
    workspaceRoot: process.cwd(),
    run,
    node: "run_experiments",
    runContext,
    section: "experiment",
    files: [
      {
        sourcePath: reportPath,
        targetRelativePath: "run_experiments_verify_report.json"
      },
      {
        sourcePath: intermediateArtifactCapturePath,
        targetRelativePath: "run_experiments_intermediate_artifacts.json"
      }
    ]
  });
  await runContext.put("run_experiments.last_report", report);
  await runContext.put("run_experiments.intermediate_artifact_capture", intermediateArtifactCapture);
  if (report.status === "fail") {
    await runContext.put("run_experiments.feedback_for_implementer", report);
    await runContext.put("implement_experiments.runner_feedback", report);
    return publicOutputs;
  }
  await runContext.put("run_experiments.feedback_for_implementer", null);
  await runContext.put("implement_experiments.runner_feedback", null);
  return publicOutputs;
}

async function persistRunPanelArtifacts(input: {
  run: Parameters<typeof writeRunArtifact>[0];
  runContext: RunContextMemory;
  executionPlan?: RunExperimentsExecutionPlan;
  triageAttempts: RunExperimentsTriageAttempt[];
  watchdog: ReturnType<typeof createRunExperimentsWatchdogState>;
  rerunDecision: RunExperimentsRerunDecision;
}): Promise<void> {
  if (input.executionPlan) {
    await writeRunArtifact(
      input.run,
      "run_experiments_panel/execution_plan.json",
      JSON.stringify(input.executionPlan, null, 2)
    );
  }
  const triage = finalizeRunExperimentsTriage({
    attempts: input.triageAttempts,
    watchdog: input.watchdog
  });
  await writeRunArtifact(input.run, "run_experiments_panel/triage.json", JSON.stringify(triage, null, 2));
  await writeRunArtifact(
    input.run,
    "run_experiments_panel/rerun_decision.json",
    JSON.stringify(input.rerunDecision, null, 2)
  );
  await input.runContext.put("run_experiments.triage", triage);
}

async function persistRunFailureState(
  runContext: RunContextMemory,
  input: {
    command?: string;
    cwd?: string;
    logFile?: string;
    exitCode?: number;
    error: string;
  }
): Promise<void> {
  await runContext.put("run_experiments.command", input.command);
  await runContext.put("run_experiments.cwd", input.cwd);
  await runContext.put("run_experiments.last_log_file", input.logFile);
  await runContext.put("run_experiments.exit_code", input.exitCode);
  await runContext.put("run_experiments.last_error", input.error);
}

async function persistGovernanceCrash(input: {
  run: Parameters<typeof writeRunArtifact>[0];
  runContext: RunContextMemory;
  comparisonContract?: Awaited<ReturnType<typeof loadExperimentComparisonContract>>;
  implementationContext?: Awaited<ReturnType<typeof loadExperimentImplementationContext>>;
  objectiveMetricName: string;
  rationale: string;
  resourceUsage: Record<string, unknown>;
}): Promise<void> {
  const entry = buildCrashLedgerEntry({
    contract: input.comparisonContract,
    implementationContext: input.implementationContext,
    objectiveMetricName: input.objectiveMetricName,
    rationale: input.rationale,
    resourceUsage: input.resourceUsage
  });
  await storeExperimentGovernanceDecision(input.run, input.runContext, {
    entries: [entry]
  });
}

async function materializeRunExperimentPublicSummaryProjection(input: {
  run: Parameters<typeof writeRunArtifact>[0];
  metrics: Record<string, unknown>;
  objectiveEvaluation: ObjectiveMetricEvaluation;
  metricsPath: string;
  command: string;
  cwd?: string;
}): Promise<{
  summaryPath: string;
  studySummaryPath: string;
}> {
  const artifactValidation = validateResultsArtifactV2(input.metrics.results_artifact);
  const resultsArtifact = artifactValidation.valid
    ? input.metrics.results_artifact as ResultsArtifactV2
    : undefined;
  const selection = resolveExplicitResultsSelection(input.metrics).selection;
  const primaryMetricKey = selection?.metric.id;
  const primaryMetricValue = selection?.observation.value;
  const primaryReferenceObservation = selection?.comparison
    ? resultsArtifact?.observations.find(
        (item) => item.id === selection.comparison?.reference_observation_id
      )
    : undefined;
  const summary = {
    version: 2,
    source: "run_experiments",
    projection_source: "metrics.json",
    status: asString(input.metrics.status) || "completed",
    objective: {
      raw_objective_metric: input.objectiveEvaluation.rawObjectiveMetric,
      metric_id: primaryMetricKey || null,
      metric_direction: selection?.metric.direction || null,
      observed_value: primaryMetricValue ?? null,
      status: input.objectiveEvaluation.status,
      summary: input.objectiveEvaluation.summary
    },
    primary_observation: selection
      ? {
          id: selection.observation.id,
          series_id: selection.observation.series_id,
          series_role: selection.series.role,
          metric_id: selection.metric.id,
          metric_direction: selection.metric.direction,
          scope: selection.observation.scope,
          value: selection.observation.value
        }
      : null,
    primary_comparison: selection?.comparison
      ? {
          id: selection.comparison.id,
          subject_observation_id: selection.comparison.subject_observation_id,
          reference_observation_id: selection.comparison.reference_observation_id,
          metric_id: selection.metric.id,
          metric_direction: selection.metric.direction,
          delta: selection.comparison.delta,
          reference_value: primaryReferenceObservation?.value ?? null
        }
      : null,
    results_selection: Object.keys(asRecord(input.metrics.results_selection)).length > 0
      ? input.metrics.results_selection
      : null,
    results_artifact: resultsArtifact || null,
    metrics_path: input.metricsPath,
    command: input.command,
    cwd: input.cwd || null,
    completed_run_count: asNumber(input.metrics.completed_run_count) ?? null,
    required_run_count: asNumber(input.metrics.required_run_count) ?? null,
    attempted_run_count: asNumber(input.metrics.attempted_run_count) ?? null,
    failed_run_count: asNumber(input.metrics.failed_run_count) ?? null,
    completed_condition_count: asNumber(input.metrics.completed_condition_count) ?? null,
    required_condition_count: asNumber(input.metrics.required_condition_count) ?? null,
    primary_metric_key: primaryMetricKey || null,
    primary_metric_value: primaryMetricValue ?? null,
    run_experiments_diagnostics: Array.isArray(input.metrics.run_experiments_diagnostics)
      ? input.metrics.run_experiments_diagnostics
      : []
  };
  const studySummary = {
    ...summary,
    study_status: summary.status,
    series_roles: resultsArtifact
      ? resultsArtifact.series
          .filter((item) => Boolean(item.role))
          .map((item) => ({ series_id: item.id, role: item.role }))
      : [],
    seed_count: asNumber(input.metrics.seed_count) ?? null,
    successful_seed_count: asNumber(input.metrics.successful_seed_count) ?? null,
    failed_seed_count: asNumber(input.metrics.failed_seed_count) ?? null
  };

  const summaryPath = await writeRunArtifact(
    input.run,
    "run_experiments_public_summary.json",
    JSON.stringify(summary, null, 2)
  );
  const studySummaryPath = await writeRunArtifact(
    input.run,
    "run_experiments_public_study_summary.json",
    JSON.stringify(studySummary, null, 2)
  );
  return { summaryPath, studySummaryPath };
}

async function publishRunExperimentOutputs(input: {
  workspaceRoot: string;
  run: Parameters<typeof writeRunArtifact>[0];
  runContext: RunContextMemory;
  metricsPath: string;
  supplementalPlan?: ManagedSupplementalPlan;
  matrixTrialGroups?: BuildExperimentRunManifestTrialGroupExecution[];
  publicSummaryProjection?: {
    summaryPath: string;
    studySummaryPath: string;
  };
}): Promise<PublishPublicRunOutputsResult> {
  const runDir = path.join(input.workspaceRoot, ".autolabos", "runs", input.run.id);
  const files: Array<{
    sourcePath: string;
    targetRelativePath?: string;
    optional?: boolean;
  }> = [
    {
      sourcePath: input.metricsPath,
      targetRelativePath: "metrics.json",
      optional: true
    },
    {
      sourcePath: path.join(runDir, "objective_evaluation.json"),
      targetRelativePath: "objective_evaluation.json",
      optional: true
    },
    {
      sourcePath: path.join(runDir, "run_experiments_verify_report.json"),
      targetRelativePath: "run_experiments_verify_report.json",
      optional: true
    },
    {
      sourcePath: path.join(runDir, "run_manifest.json"),
      targetRelativePath: "run_manifest.json",
      optional: true
    },
    {
      sourcePath: path.join(runDir, "experiment_portfolio.json"),
      targetRelativePath: "experiment_portfolio.json",
      optional: true
    },
    {
      sourcePath: path.join(runDir, "trial_group_matrix.json"),
      targetRelativePath: "trial_group_matrix.json",
      optional: true
    }
  ];
  if (input.supplementalPlan) {
    for (const profile of input.supplementalPlan.profiles) {
      files.push({
        sourcePath: profile.metricsPath,
        targetRelativePath: path.basename(profile.metricsPath),
        optional: true
      });
    }
    files.push({
      sourcePath: path.join(input.supplementalPlan.publicDir, "recent_paper_reproducibility.json"),
      targetRelativePath: "recent_paper_reproducibility.json",
      optional: true
    });
  }
  if (input.matrixTrialGroups?.length) {
    for (const group of input.matrixTrialGroups) {
      if (!group.metrics_path || !group.metrics_path.startsWith(path.join(".autolabos", "runs", input.run.id, "trial_group_metrics"))) {
        continue;
      }
      files.push({
        sourcePath: group.metrics_path,
        targetRelativePath: path.join("trial_group_metrics", path.basename(group.metrics_path)),
        optional: true
      });
    }
  }
  if (input.publicSummaryProjection) {
    files.push(
      {
        sourcePath: input.publicSummaryProjection.summaryPath,
        targetRelativePath: "summary.json",
        optional: true
      },
      {
        sourcePath: input.publicSummaryProjection.studySummaryPath,
        targetRelativePath: "study_summary.json",
        optional: true
      }
    );
  }

  return publishPublicRunOutputs({
    workspaceRoot: input.workspaceRoot,
    run: input.run,
    node: "run_experiments",
    runContext: input.runContext,
    section: "experiment",
    files
  });
}

async function materializeManagedMatrixTrialGroupArtifacts(input: {
  run: Parameters<typeof writeRunArtifact>[0];
  portfolio: ExperimentPortfolio;
  primaryCommand: string;
  primaryCwd?: string;
  primaryMetricsPath: string;
  primaryMetrics: Record<string, unknown>;
  primarySummary: string;
  supplementalRuns: SupplementalRunRecord[];
}): Promise<BuildExperimentRunManifestTrialGroupExecution[]> {
  if (input.portfolio.execution_model !== "managed_bundle") {
    return [];
  }

  const matrixGroups = input.portfolio.trial_groups.filter((group) => group.group_kind === "matrix_slice");
  if (matrixGroups.length === 0) {
    return [];
  }

  const aggregateGroups = input.portfolio.trial_groups.filter((group) => group.group_kind !== "matrix_slice");
  const sourceExecutions = new Map<string, {
    group: ExperimentPortfolioTrialGroup;
    status: "pass" | "fail" | "skipped";
    command?: string;
    cwd?: string;
    metricsPath?: string;
    metrics?: Record<string, unknown>;
    summary: string;
  }>();
  const primaryResolution = resolvePortfolioPrimaryTrialGroup(input.portfolio, aggregateGroups);
  if (primaryResolution.group) {
    sourceExecutions.set(primaryResolution.group.id, {
      group: primaryResolution.group,
      status: "pass",
      command: input.primaryCommand,
      cwd: input.primaryCwd,
      metricsPath: input.primaryMetricsPath,
      metrics: input.primaryMetrics,
      summary: input.primarySummary
    });
  }

  for (const record of input.supplementalRuns) {
    const matchingGroups = aggregateGroups.filter((group) => group.profile === record.profile);
    if (matchingGroups.length !== 1) {
      continue;
    }
    const sourceGroup = matchingGroups[0];
    sourceExecutions.set(sourceGroup.id, {
      group: sourceGroup,
      status: record.status,
      command: record.command,
      cwd: record.cwd,
      metricsPath: record.metrics_path,
      metrics: record.status === "pass"
        ? await readMetricsObject(record.metrics_path, process.cwd())
        : undefined,
      summary: record.summary
    });
  }

  const records: BuildExperimentRunManifestTrialGroupExecution[] = [];
  const matrixSummary: Array<Record<string, unknown>> = [];
  for (const group of matrixGroups) {
    const sourceId = asString(group.source_trial_group_id);
    const axisDataset = asString(group.matrix_axes?.dataset);
    const dataset = axisDataset || (group.dataset_scope.length === 1 ? asString(group.dataset_scope[0]) : undefined);
    const sourceExecution = sourceId ? sourceExecutions.get(sourceId) : undefined;
    if (!sourceId || !dataset || !sourceExecution) {
      const reasons = [
        !sourceId ? "source_trial_group_id was not declared" : undefined,
        !dataset ? "the matrix dataset was absent or ambiguous" : undefined,
        sourceId && !sourceExecution
          ? primaryResolution.diagnostic || `source trial group ${sourceId} had no unique execution`
          : undefined
      ].filter((value): value is string => Boolean(value));
      const record = {
        id: group.id,
        status: "skipped" as const,
        summary: `Matrix slice was not materialized: ${reasons.join("; ")}.`
      };
      records.push(record);
      matrixSummary.push({
        ...record,
        group_kind: group.group_kind,
        source_trial_group_id: sourceId,
        matrix_axes: group.matrix_axes,
        dataset_scope: group.dataset_scope
      });
      continue;
    }

    if (sourceExecution.status !== "pass" || !sourceExecution.metrics || !sourceExecution.metricsPath) {
      const record = {
        id: group.id,
        status: sourceExecution.status,
        command: sourceExecution.command,
        cwd: sourceExecution.cwd,
        summary: `${group.label} inherited ${sourceExecution.status} from ${sourceExecution.group.label}: ${sourceExecution.summary}`
      };
      records.push(record);
      matrixSummary.push({
        ...record,
        group_kind: group.group_kind,
        source_trial_group_id: sourceId,
        matrix_axes: group.matrix_axes,
        dataset_scope: group.dataset_scope
      });
      continue;
    }

    const projection = buildManagedMatrixSliceArtifact({
      runId: input.run.id,
      group,
      sourceGroup: sourceExecution.group,
      dataset,
      command: sourceExecution.command,
      cwd: sourceExecution.cwd,
      sourceMetrics: sourceExecution.metrics,
      sourceMetricsPath: sourceExecution.metricsPath
    });
    if (!projection.artifact) {
      const record = {
        id: group.id,
        status: "skipped" as const,
        command: sourceExecution.command,
        cwd: sourceExecution.cwd,
        summary: projection.diagnostic
      };
      records.push(record);
      matrixSummary.push({
        ...record,
        group_kind: group.group_kind,
        source_trial_group_id: sourceId,
        matrix_axes: group.matrix_axes,
        dataset_scope: group.dataset_scope
      });
      continue;
    }

    const metricsPath = await writeRunArtifact(
      input.run,
      path.join("trial_group_metrics", `${group.id}.json`),
      `${JSON.stringify(projection.artifact, null, 2)}\n`
    );
    const record = {
      id: group.id,
      status: "pass" as const,
      command: sourceExecution.command,
      cwd: sourceExecution.cwd,
      metrics_path: metricsPath,
      summary: projection.artifact.summary,
      sampling_profile: projection.artifact.sampling_profile
    };
    records.push(record);
    matrixSummary.push({
      ...record,
      group_kind: group.group_kind,
      source_trial_group_id: sourceId,
      matrix_axes: group.matrix_axes,
      dataset_scope: group.dataset_scope
    });
  }

  await writeRunArtifact(
    input.run,
    "trial_group_matrix.json",
    `${JSON.stringify({
      version: 1,
      run_id: input.run.id,
      generated_at: new Date().toISOString(),
      execution_model: input.portfolio.execution_model,
      trial_groups: matrixSummary
    }, null, 2)}\n`
  );

  return records;
}

function resolvePortfolioPrimaryTrialGroup(
  portfolio: ExperimentPortfolio,
  groups: ExperimentPortfolioTrialGroup[] = portfolio.trial_groups.filter(
    (group) => group.group_kind !== "matrix_slice"
  )
): {
  group?: ExperimentPortfolioTrialGroup;
  diagnostic?: string;
} {
  const explicitPrimaryId = asString(asRecord(portfolio).primary_trial_group_id);
  if (explicitPrimaryId) {
    const matches = groups.filter((group) => group.id === explicitPrimaryId);
    return matches.length === 1
      ? { group: matches[0] }
      : { diagnostic: `Explicit primary_trial_group_id ${explicitPrimaryId} did not resolve to one aggregate trial group.` };
  }
  const roleMatches = groups.filter((group) => group.role === "primary");
  if (roleMatches.length === 1) {
    return { group: roleMatches[0] };
  }
  return {
    diagnostic: roleMatches.length === 0
      ? "Portfolio omitted primary_trial_group_id and no aggregate trial group declared role=primary."
      : `Portfolio omitted primary_trial_group_id and ${roleMatches.length} aggregate trial groups declared role=primary.`
  };
}

function buildManagedMatrixSliceArtifact(input: {
  runId: string;
  group: ExperimentPortfolioTrialGroup;
  sourceGroup: ExperimentPortfolioTrialGroup;
  dataset: string;
  command?: string;
  cwd?: string;
  sourceMetrics: Record<string, unknown>;
  sourceMetricsPath: string;
}): {
  artifact?: ManagedMatrixSliceArtifact;
  diagnostic: string;
} {
  const metrics = asRecord(input.sourceMetrics);
  const artifactValidation = validateResultsArtifactV2(metrics.results_artifact);
  if (!artifactValidation.valid) {
    return {
      diagnostic:
        `Matrix slice ${input.group.id} was skipped because source metrics did not provide a valid ` +
        `ResultsArtifactV2: ${artifactValidation.issues.slice(0, 4).join(" ")}`
    };
  }
  const artifact = metrics.results_artifact as ResultsArtifactV2;
  const seriesById = new Map(artifact.series.map((series) => [series.id, series]));
  const observationsById = new Map(
    artifact.observations.map((observation) => [observation.id, observation])
  );
  const candidates = artifact.comparisons.flatMap((comparison) => {
    const subject = observationsById.get(comparison.subject_observation_id);
    const reference = observationsById.get(comparison.reference_observation_id);
    if (!subject || !reference || subject.metric_id !== reference.metric_id) {
      return [];
    }
    const subjectSeries = seriesById.get(subject.series_id);
    const referenceSeries = seriesById.get(reference.series_id);
    const metric = artifact.metrics.find((item) => item.id === subject.metric_id);
    if (
      !subjectSeries ||
      !referenceSeries ||
      !metric ||
      subjectSeries.role !== "primary" ||
      referenceSeries.role !== "baseline" ||
      !matrixObservationMatchesDataset(subject, subjectSeries, input.dataset) ||
      !matrixObservationMatchesDataset(reference, referenceSeries, input.dataset)
    ) {
      return [];
    }
    if (input.group.metrics.length > 0 && !input.group.metrics.includes(metric.id)) {
      return [];
    }
    return [{ comparison, subject, reference, subjectSeries, referenceSeries, metric }];
  });
  if (candidates.length !== 1) {
    return {
      diagnostic:
        `Matrix slice ${input.group.id} was skipped because ${candidates.length} explicit ResultsArtifactV2 ` +
        `comparison(s) matched dataset ${input.dataset} with subject role=primary and reference role=baseline; ` +
        "exactly one is required."
    };
  }

  const selected = candidates[0];
  const sampling = extractExplicitMatrixSliceSamplingProfile(
    input.sourceMetrics,
    input.group.id,
    input.dataset
  );
  const diagnostics = sampling.diagnostic
    ? [{ code: "matrix_slice_sampling_ambiguous", message: sampling.diagnostic }]
    : undefined;
  const comparison = {
    id: selected.comparison.id,
    metric_id: selected.metric.id,
    metric_direction: selected.metric.direction,
    subject_observation_id: selected.subject.id,
    reference_observation_id: selected.reference.id,
    delta: selected.comparison.delta
  };

  return {
    diagnostic: diagnostics?.[0]?.message || "",
    artifact: {
      version: 1,
      run_id: input.runId,
      trial_group_id: input.group.id,
      source_trial_group_id: input.sourceGroup.id,
      generated_at: new Date().toISOString(),
      execution_model: "managed_bundle",
      runner_profile: input.group.profile || input.sourceGroup.profile,
      dataset: input.dataset,
      source_metrics_path: input.sourceMetricsPath,
      command: input.command,
      cwd: input.cwd,
      sampling_profile: sampling.profile,
      condition_metrics: {
        [selected.subjectSeries.id]: {
          role: selected.subjectSeries.role,
          observation_id: selected.subject.id,
          metric_id: selected.metric.id,
          metric_direction: selected.metric.direction,
          scope: selected.subject.scope,
          value: selected.subject.value
        },
        [selected.referenceSeries.id]: {
          role: selected.referenceSeries.role,
          observation_id: selected.reference.id,
          metric_id: selected.metric.id,
          metric_direction: selected.metric.direction,
          scope: selected.reference.scope,
          value: selected.reference.value
        }
      },
      comparison,
      diagnostics,
      summary: buildManagedMatrixSliceSummary({
        dataset: input.dataset,
        sourceLabel: input.sourceGroup.label,
        profile: input.group.profile || input.sourceGroup.profile,
        metricId: selected.metric.id,
        metricDirection: selected.metric.direction,
        comparisonDelta: selected.comparison.delta
      })
    }
  };
}

function matrixObservationMatchesDataset(
  observation: ResultsObservationV2,
  series: ResultsSeriesV2,
  dataset: string
): boolean {
  return asString(observation.scope.dataset) === dataset || asString(series.dimensions.dataset) === dataset;
}

function buildManagedMatrixSliceSummary(input: {
  dataset: string;
  sourceLabel: string;
  profile?: string;
  metricId: string;
  metricDirection: ResultsMetricDefinitionV2["direction"];
  comparisonDelta: number;
}): string {
  return [
    `Matrix slice ${input.dataset}`,
    input.profile ? `(profile=${input.profile})` : undefined,
    `from ${input.sourceLabel}.`,
    `metric_id=${input.metricId}.`,
    `metric_direction=${input.metricDirection}.`,
    `comparison_delta=${formatMetricValue(input.comparisonDelta)}.`
  ].filter((part): part is string => Boolean(part)).join(" ");
}

function extractExplicitMatrixSliceSamplingProfile(
  metrics: Record<string, unknown>,
  groupId: string,
  dataset: string
): {
  profile?: ExperimentPortfolioSamplingProfile;
  diagnostic?: string;
} {
  const candidates = [
    asRecord(asRecord(metrics.matrix_slice_sampling)[groupId]),
    asRecord(asRecord(metrics.trial_group_sampling)[groupId]),
    asRecord(asRecord(metrics.dataset_sampling_profiles)[dataset]),
    asRecord(asRecord(asRecord(metrics.matrix_slices)[groupId]).sampling_profile)
  ]
    .map(normalizeExplicitSamplingProfile)
    .filter((profile): profile is ExperimentPortfolioSamplingProfile => Boolean(profile));
  const distinct = new Map(candidates.map((profile) => [JSON.stringify(profile), profile]));
  if (distinct.size === 1) {
    return { profile: [...distinct.values()][0] };
  }
  if (distinct.size > 1) {
    return {
      diagnostic:
        `Matrix slice ${groupId} recorded conflicting explicit sampling profiles; trial counts were omitted.`
    };
  }
  return {};
}

function normalizeExplicitSamplingProfile(value: Record<string, unknown>): ExperimentPortfolioSamplingProfile | undefined {
  if (Object.keys(value).length === 0) {
    return undefined;
  }
  const source = Object.keys(asRecord(value.sampling_profile)).length > 0
    ? asRecord(value.sampling_profile)
    : value;
  const profile: ExperimentPortfolioSamplingProfile = {};
  const name = asString(source.name);
  if (name) {
    profile.name = name;
  }
  for (const key of ["total_trials", "executed_trials", "cached_trials"] as const) {
    const count = asNumber(source[key]);
    if (count !== undefined) {
      profile[key] = count;
    }
  }
  return Object.keys(profile).length > 0 ? profile : undefined;
}

async function readMetricsObject(
  metricsPath: string | undefined,
  workspaceRoot: string
): Promise<Record<string, unknown> | undefined> {
  const resolvedPath = resolveMaybeRelative(metricsPath, workspaceRoot);
  if (!resolvedPath) {
    return undefined;
  }
  try {
    const raw = await fs.readFile(resolvedPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function trimExcerpt(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 1200);
}

function extractPolicyBlock(
  obs: {
    policy?: { allowed: boolean; rule_id?: string; reason?: string };
    stderr?: string;
  }
): { blocked: boolean; ruleId?: string; reason?: string } {
  if (obs.policy?.allowed === false) {
    return {
      blocked: true,
      ruleId: obs.policy.rule_id,
      reason: obs.policy.reason
    };
  }

  const stderr = obs.stderr || "";
  const match = stderr.match(/rule=([a-z0-9_]+)/i);
  if (/policy blocked (?:test command|command)/i.test(stderr)) {
    return {
      blocked: true,
      ruleId: match?.[1],
      reason: undefined
    };
  }

  return { blocked: false };
}

function oneLine(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() || "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function validatePlannedConditionCoverage(input: {
  metrics: Record<string, unknown>;
  briefSections?: MarkdownRunBriefSections;
  experimentPortfolio?: ExperimentPortfolio;
}): string | undefined {
  const primaryGroup = input.experimentPortfolio
    ? resolvePortfolioPrimaryTrialGroup(input.experimentPortfolio).group
    : undefined;
  const requirement = deriveRequiredPlannedConditionCount(input.briefSections, {
    summary: primaryGroup?.label,
    implementation_notes: primaryGroup?.notes,
    evaluation_steps: primaryGroup?.notes,
    resource_notes: primaryGroup?.notes,
    metrics: primaryGroup?.metrics
  });
  if (!requirement) {
    return undefined;
  }

  const executedCount = countExecutedPlannedConditions(input.metrics, {
    tunedOnly: requirement.tunedOnly
  });
  if (executedCount >= requirement.conditionCount) {
    return undefined;
  }

  return [
    "Planned condition coverage incomplete:",
    `observed ${executedCount} successful${requirement.tunedOnly ? " tuned" : ""} condition(s)`,
    `but the brief/design requires ${requirement.conditionCount}.`
  ].join(" ");
}

function validatePlannedConditionExpansion(input: {
  metrics: Record<string, unknown>;
  briefSections?: MarkdownRunBriefSections;
  experimentPortfolio?: ExperimentPortfolio;
}): string[] {
  const primaryGroup = input.experimentPortfolio
    ? resolvePortfolioPrimaryTrialGroup(input.experimentPortfolio).group
    : undefined;
  const requirement = deriveRequiredPlannedConditionCount(input.briefSections, {
    summary: primaryGroup?.label,
    implementation_notes: primaryGroup?.notes,
    evaluation_steps: primaryGroup?.notes,
    resource_notes: primaryGroup?.notes,
    metrics: primaryGroup?.metrics
  });
  const issues: string[] = [];
  if (requirement) {
    const executedCount = countExecutedPlannedConditions(input.metrics, {
      tunedOnly: requirement.tunedOnly
    });
    if (executedCount > requirement.conditionCount) {
      issues.push(
        [
          "Planned condition contract expanded:",
          `observed ${executedCount} successful${requirement.tunedOnly ? " tuned" : ""} condition(s)`,
          `but the brief/design declares ${requirement.conditionCount}.`
        ].join(" ")
      );
    }
  }

  const axisIssues = validateDeclaredParameterAxisMembership(input);
  issues.push(...axisIssues);

  const seedIssue = validatePrimarySeedExpansion(input.metrics, input.briefSections);
  if (seedIssue) {
    issues.push(seedIssue);
  }

  return issues;
}

function validateDeclaredParameterAxisMembership(input: {
  metrics: Record<string, unknown>;
  briefSections?: MarkdownRunBriefSections;
  experimentPortfolio?: ExperimentPortfolio;
}): string[] {
  const axes = parseDeclaredNumericParameterAxes(input.briefSections, input.experimentPortfolio);
  if (axes.size === 0) {
    return [];
  }

  const rows = collectMetricsConditionRows(input.metrics);
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const [axis, allowed] of axes.entries()) {
      const observed = asNumber(row[axis]);
      if (observed === undefined || allowed.has(observed)) {
        continue;
      }
      const key = `${axis}:${observed}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      issues.push(
        `Planned condition parameter contract violated: ${axis}=${observed} is outside declared values {${[
          ...allowed
        ].join(",")}}.`
      );
    }
  }
  return issues;
}

function parseDeclaredNumericParameterAxes(
  briefSections?: MarkdownRunBriefSections,
  experimentPortfolio?: ExperimentPortfolio
): Map<string, Set<number>> {
  const text = [
    briefSectionText(briefSections?.constraints),
    briefSections?.minimumExperimentPlan,
    briefSections?.minimumAcceptableEvidence,
    briefSections?.plan,
    briefSections?.datasetTaskBench,
    ...(experimentPortfolio?.trial_groups ?? []).flatMap((group) => [
      group.label,
      ...(group.notes ?? []),
      ...(group.metrics ?? [])
    ])
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
  const axes = new Map<string, Set<number>>();
  for (const match of text.matchAll(/\b([A-Za-z][A-Za-z0-9_-]*)\s+in\s+`?\{([^}]+)\}`?/giu)) {
    const axis = normalizeMetricFieldName(match[1]);
    const values = match[2]
      .split(",")
      .map((item) => Number.parseFloat(item.trim().replace(/[`'"]/gu, "")))
      .filter((value) => Number.isFinite(value));
    if (!axis || values.length === 0) {
      continue;
    }
    axes.set(axis, new Set(values));
  }
  return axes;
}

function normalizeMetricFieldName(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function briefSectionText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const text = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("\n");
    return text || undefined;
  }
  return typeof value === "string" && value.trim() ? value : undefined;
}

function collectMetricsConditionRows(metrics: Record<string, unknown>): Array<Record<string, unknown>> {
  const study = asRecord(metrics.study);
  const studySummary = asRecord(metrics.study_summary);
  return [
    ...collectConditionRows(metrics.condition_summaries),
    ...collectConditionRows(metrics.condition_results),
    ...collectConditionRows(metrics.conditions),
    ...collectConditionRows(metrics.result_rows),
    ...collectConditionRows(metrics.raw_results),
    ...collectConditionRows(metrics.per_seed_results),
    ...collectConditionRows(metrics.condition_seed_rows),
    ...collectConditionRows(study.condition_summaries),
    ...collectConditionRows(study.condition_results),
    ...collectConditionRows(study.conditions),
    ...collectConditionRows(studySummary.condition_summaries),
    ...collectConditionRows(studySummary.condition_results),
    ...collectConditionRows(studySummary.conditions)
  ];
}

function validatePrimarySeedExpansion(
  metrics: Record<string, unknown>,
  briefSections?: MarkdownRunBriefSections
): string | undefined {
  const governedSeedCount = deriveExplicitSeedScheduleCount(metrics);
  const declaredSeedCount = parseDeclaredPrimarySeedCount(briefSections);
  const expectedSeedCount = governedSeedCount ?? declaredSeedCount;
  if (expectedSeedCount === undefined) {
    return undefined;
  }
  const rows = collectMetricsConditionRows(metrics);
  const expanded = new Map<string, number>();
  for (const row of rows) {
    const seedCount =
      asNumber(row.planned_seed_count) ??
      asNumber(row.seed_count) ??
      asNumber(row.completed_seed_count);
    if (seedCount === undefined || seedCount <= expectedSeedCount) {
      continue;
    }
    const marker =
      asString(row.condition_marker) ||
      asString(row.marker) ||
      asString(row.condition_id) ||
      asString(row.name) ||
      `condition_${expanded.size + 1}`;
    expanded.set(marker, Math.max(expanded.get(marker) || 0, seedCount));
  }
  if (expanded.size === 0) {
    return undefined;
  }

  const samples = [...expanded.entries()]
    .slice(0, 4)
    .map(([marker, count]) => `${trimShort(marker, 80)}:${count}`)
    .join(",");
  return (
    `Primary seed contract expanded: ${expanded.size} condition(s) report planned seed counts above ` +
    `${expectedSeedCount}${samples ? ` (${samples})` : ""}.`
  );
}

function deriveExplicitSeedScheduleCount(metrics: Record<string, unknown>): number | undefined {
  const config = asRecord(metrics.config);
  const runConfig = asRecord(metrics.run_config);
  const study = asRecord(metrics.study);
  const scheduleCounts = [
    metrics.seed_schedule,
    metrics.seeds,
    config.seed_schedule,
    config.seeds,
    runConfig.seed_schedule,
    runConfig.seeds,
    study.seed_schedule,
    study.seeds
  ]
    .filter((value): value is unknown[] => Array.isArray(value) && value.length > 0)
    .map((value) => value.length);
  const countRecords = [
    asRecord(metrics.seed_count_provenance),
    asRecord(config.seed_count_provenance),
    asRecord(runConfig.seed_count_provenance)
  ];
  for (const record of countRecords) {
    const provenance = asString(record.provenance) || asString(record.source) || asString(record.schedule_id);
    const count = firstNumber(record.count, record.seed_count, record.seeds_per_condition);
    if (provenance && count !== undefined && Number.isInteger(count) && count > 0) {
      scheduleCounts.push(count);
    }
  }
  const distinctCounts = [...new Set(scheduleCounts)];
  if (distinctCounts.length === 1) {
    return distinctCounts[0];
  }
  if (distinctCounts.length > 1) {
    appendResultMeaningDiagnostic(metrics, {
      code: "seed_schedule_provenance_ambiguous",
      message:
        `Explicit seed schedules reported conflicting counts (${distinctCounts.join(", ")}); no seeds-per-condition contract was inferred.`
    });
  }
  return undefined;
}

function parseDeclaredPrimarySeedCount(briefSections?: MarkdownRunBriefSections): number | undefined {
  const text = [
    briefSectionText(briefSections?.constraints),
    briefSections?.minimumExperimentPlan,
    briefSections?.datasetTaskBench,
    briefSections?.allowedBudgetedPasses
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
  const explicitList = text.match(/\b(?:seeds?|random\s+seeds?)\s*[:=]\s*`?\{?([0-9,\s]+)\}?`?/iu);
  if (explicitList) {
    const values = explicitList[1]
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length > 1) {
      return values.length;
    }
  }
  const countMatch = text.match(/\b(\d+)\s+(?:primary\s+)?(?:random\s+)?seeds?\b/iu);
  if (countMatch) {
    const count = Number.parseInt(countMatch[1], 10);
    if (Number.isFinite(count) && count > 0 && count < 1000) {
      return count;
    }
  }
  if (
    /\ball\s+primary\s+conditions\s+use\s+seed\s+\d+\b/iu.test(text) ||
    /\bseed\s*:\s*`?\d+`?\s+for\s+the\s+primary\b/iu.test(text)
  ) {
    return 1;
  }
  return undefined;
}


function validateRunMetricsContract(input: {
  metrics: Record<string, unknown>;
  objectiveEvaluation: ObjectiveMetricEvaluation;
  comparisonContract?: Awaited<ReturnType<typeof loadExperimentComparisonContract>>;
  experimentContract?: ExperimentContract;
  briefSections?: MarkdownRunBriefSections;
  experimentPortfolio?: ExperimentPortfolio;
}): string[] {
  const issues: string[] = [];
  for (const diagnostic of collectConditionRows(input.metrics.run_experiments_diagnostics)) {
    if (asString(diagnostic.severity) === "error") {
      issues.push(asString(diagnostic.message) || "Results projection was rejected by an error diagnostic.");
    }
  }
  if (input.objectiveEvaluation.status === "missing") {
    issues.push(input.objectiveEvaluation.summary);
  }
  if (input.experimentPortfolio) {
    const primaryGroupResolution = resolvePortfolioPrimaryTrialGroup(input.experimentPortfolio);
    if (!primaryGroupResolution.group) {
      issues.push(`Experiment portfolio primary trial group is ambiguous: ${primaryGroupResolution.diagnostic}`);
    }
  }

  const conditionCoverageIssue = validatePlannedConditionCoverage({
    metrics: input.metrics,
    briefSections: input.briefSections,
    experimentPortfolio: input.experimentPortfolio
  });
  if (conditionCoverageIssue) {
    issues.push(conditionCoverageIssue);
  }
  issues.push(
    ...validatePlannedConditionExpansion({
      metrics: input.metrics,
      briefSections: input.briefSections,
      experimentPortfolio: input.experimentPortfolio
    })
  );

  const study = asRecord(input.metrics.study);
  const studySummary = asRecord(input.metrics.study_summary);
  const studySummaryStatus = asString(studySummary.status)?.toLowerCase();
  if (studySummaryStatus && ["failed", "failure", "error", "errored"].includes(studySummaryStatus)) {
    issues.push(`Study summary reports failed status: ${studySummaryStatus}.`);
  }
  const explicitRequiredRunCount = [
    asNumber(input.metrics.required_run_count),
    asNumber(studySummary.required_run_count),
    asNumber(study.required_run_count)
  ].find((value): value is number => typeof value === "number");
  const requiredRunResolution = deriveRequiredPlannedRunCount(input);
  if (requiredRunResolution.issue) {
    issues.push(requiredRunResolution.issue);
  }
  const derivedRequiredRunCount = requiredRunResolution.count;
  const requiredRunCount = explicitRequiredRunCount ?? derivedRequiredRunCount;
  if (
    explicitRequiredRunCount !== undefined &&
    derivedRequiredRunCount !== undefined &&
    explicitRequiredRunCount < derivedRequiredRunCount
  ) {
    issues.push(
      "Experiment metrics contracted required_run_count below the governed run plan: required_run_count=" + explicitRequiredRunCount + ", governed_required_run_count=" + derivedRequiredRunCount + "."
    );
  }
  const completedRunCount = [
    asNumber(input.metrics.completed_run_count),
    asNumber(studySummary.completed_run_count),
    asNumber(study.completed_run_count)
  ].find((value): value is number => typeof value === "number");
  const failedRunCount = [
    asNumber(input.metrics.failed_run_count),
    asNumber(studySummary.failed_run_count),
    asNumber(study.failed_run_count)
  ].find((value): value is number => typeof value === "number");
  const timedOutRunCount = [
    asNumber(input.metrics.timed_out_run_count),
    asNumber(studySummary.timed_out_run_count),
    asNumber(study.timed_out_run_count)
  ].find((value): value is number => typeof value === "number");
  if (failedRunCount !== undefined && failedRunCount > 0) {
    issues.push(
      `Experiment metrics report failed_run_count=${failedRunCount}` +
        (completedRunCount !== undefined ? ` with completed_run_count=${completedRunCount}.` : ".")
    );
  }
  if (timedOutRunCount !== undefined && timedOutRunCount > 0) {
    issues.push(`Experiment metrics report timed_out_run_count=${timedOutRunCount}.`);
  }
  if (requiredRunCount !== undefined && requiredRunCount > 0) {
    if (completedRunCount === undefined && explicitRequiredRunCount !== undefined) {
      issues.push(`Experiment metrics omitted completed_run_count for required ${requiredRunCount} run(s).`);
    } else if (completedRunCount !== undefined) {
      if (completedRunCount === 0) {
        issues.push(`No required experiment runs completed successfully (${completedRunCount}/${requiredRunCount}).`);
      } else if (completedRunCount < requiredRunCount) {
        issues.push(`Experiment run coverage incomplete: completed_run_count=${completedRunCount}/${requiredRunCount}.`);
      }
    }
  }

  const executionStatusRows = collectExecutionStatusRows(input.metrics);
  if (executionStatusRows.length > 0) {
    const completedEvidenceRows = executionStatusRows.filter((row) =>
      isCompletedConditionStatus(normalizeConditionResultStatus(row))
    );
    const failedEvidenceRows = executionStatusRows.filter((row) =>
      isFailedConditionStatus(normalizeConditionResultStatus(row))
    );
    if (failedEvidenceRows.length > 0 && failedRunCount === 0) {
      issues.push(
        `Experiment row evidence contradicts failed_run_count=0: ${failedEvidenceRows.length}/${executionStatusRows.length} execution row(s) report failed status.`
      );
    }
    if (failedEvidenceRows.length === executionStatusRows.length && completedRunCount !== undefined && completedRunCount > 0) {
      issues.push(
        `Experiment row evidence contradicts completed_run_count=${completedRunCount}: 0 successful execution row(s), ${failedEvidenceRows.length} failed execution row(s).`
      );
    } else if (
      requiredRunCount !== undefined &&
      requiredRunCount > 0 &&
      completedEvidenceRows.length === 0 &&
      failedEvidenceRows.length > 0
    ) {
      issues.push(
        `No execution rows completed successfully (${completedEvidenceRows.length}/${executionStatusRows.length} status-bearing row(s)).`
      );
    }
  }
  const requiredConditionCount = [
    asNumber(input.metrics.required_condition_count),
    asNumber(studySummary.required_condition_count),
    asNumber(study.required_condition_count)
  ].find((value): value is number => typeof value === "number");
  const completedConditionCount = [
    asNumber(input.metrics.completed_condition_count),
    asNumber(studySummary.completed_condition_count),
    asNumber(study.completed_condition_count)
  ].find((value): value is number => typeof value === "number");
  if (requiredConditionCount !== undefined && requiredConditionCount > 0 && completedConditionCount !== undefined) {
    if (completedConditionCount === 0) {
      issues.push(
        "No required experiment conditions completed successfully (" + completedConditionCount + "/" + requiredConditionCount + ")."
      );
    } else if (completedConditionCount < requiredConditionCount) {
      issues.push(
        `Experiment condition coverage incomplete: completed_condition_count=${completedConditionCount}/${requiredConditionCount}.`
      );
    }
  }
  const explicitSeedScheduleCount = deriveExplicitSeedScheduleCount(input.metrics);
  if (explicitSeedScheduleCount !== undefined && explicitSeedScheduleCount > 1) {
    const seedRows = collectSeedProvenanceRows(input.metrics);
    const completedSeedRows = seedRows.filter((row) => {
      const status = normalizeConditionResultStatus(row);
      return status === "unknown" || isCompletedConditionStatus(status);
    });
    const seedValues = new Set(
      completedSeedRows.flatMap((row) => collectConditionSeedValues(row)).map((value) => String(value))
    );
    if (completedSeedRows.length > 0 && seedValues.size === 0) {
      issues.push(
        `Explicit seed schedule (${explicitSeedScheduleCount} seeds) requires seed provenance, but ` +
          `${completedSeedRows.length} completed evidence row(s) omit seed or seed_id.`
      );
    }
  }
  issues.push(...validateExplicitResultsArtifactEvidence(input.metrics, input.experimentContract));

  const aggregate = asRecord(study.aggregate);
  if (Object.keys(aggregate).length > 0) {
    const failedCount = asNumber(aggregate.failed_condition_count);
    const completedCount = asNumber(aggregate.completed_condition_count);
    if (aggregate.all_conditions_succeeded === false) {
      const counts = [
        completedCount !== undefined ? `${completedCount} completed` : undefined,
        failedCount !== undefined ? `${failedCount} failed` : undefined
      ].filter(Boolean);
      issues.push(
        `Study aggregate reports incomplete execution${counts.length > 0 ? ` (${counts.join(", ")})` : ""}.`
      );
    }
  }

  return [...new Set(issues.map((issue) => issue.trim()).filter(Boolean))];
}

function validateExplicitResultsArtifactEvidence(
  metrics: Record<string, unknown>,
  experimentContract?: ExperimentContract
): string[] {
  if (!Object.prototype.hasOwnProperty.call(metrics, "results_artifact")) {
    return experimentContract
      ? ["Experiment results omitted results_artifact required by experiment_contract.results_plan."]
      : [];
  }
  const validation = validateResultsArtifactV2(metrics.results_artifact);
  if (!validation.valid) {
    return [
      `ResultsArtifactV2 contract failed: ${validation.issues.slice(0, 8).join(" ")}` +
        `${validation.issues.length > 8 ? ` +${validation.issues.length - 8} more issue(s).` : ""}`
    ];
  }
  const issues: string[] = [];
  if (experimentContract) {
    const completeness = checkResultsContractCompleteness(
      metrics.results_artifact,
      experimentContract.results_plan
    );
    if (!completeness.complete) {
      issues.push(
        "ResultsArtifactV2 does not satisfy experiment_contract.results_plan: " +
          completeness.issues.slice(0, 8).join(" ") +
          (completeness.issues.length > 8
            ? ` +${completeness.issues.length - 8} more issue(s).`
            : "")
      );
    }
  }
  const resolution = resolveExplicitResultsSelection(metrics);
  if (resolution.diagnostic?.severity === "error") {
    issues.push(resolution.diagnostic.message);
  }
  return issues;
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.map(asNumber).find((value): value is number => typeof value === "number");
}

function deriveSupplementalProfileTrialEstimate(
  experimentPortfolio: ExperimentPortfolio,
  profile: SupplementalProfileName
): { count?: number; issue?: string } {
  const candidates = experimentPortfolio.trial_groups
    .filter(
      (group) =>
        group.role === "supplemental"
        && group.profile === profile
        && group.group_kind !== "matrix_slice"
    )
    .map((group) => ({
      source: `experiment_portfolio.trial_groups.${group.id}.expected_trials`,
      value: asNumber(group.expected_trials)
    }))
    .filter(
      (candidate): candidate is { source: string; value: number } =>
        typeof candidate.value === "number"
        && Number.isInteger(candidate.value)
        && candidate.value > 0
    );
  if (candidates.length === 0) {
    return {};
  }
  const distinctCounts = new Map<number, string[]>();
  for (const candidate of candidates) {
    distinctCounts.set(candidate.value, [
      ...(distinctCounts.get(candidate.value) || []),
      candidate.source
    ]);
  }
  if (distinctCounts.size === 1) {
    return { count: candidates[0].value };
  }
  return {
    issue:
      "Explicit supplemental trial count provenance is ambiguous: "
      + candidates.map((candidate) => `${candidate.source}=${candidate.value}`).join(", ")
  };
}

function deriveRequiredPlannedRunCount(input: {
  metrics: Record<string, unknown>;
  comparisonContract?: Awaited<ReturnType<typeof loadExperimentComparisonContract>>;
  experimentPortfolio?: ExperimentPortfolio;
}): { count?: number; issue?: string } {
  const primaryGroup = input.experimentPortfolio
    ? resolvePortfolioPrimaryTrialGroup(input.experimentPortfolio).group
    : undefined;
  const candidates = [
    {
      source: "comparison_contract.budget_profile.total_trials",
      value: asNumber(input.comparisonContract?.budget_profile.total_trials)
    },
    {
      source: "experiment_portfolio.total_expected_trials",
      value: asNumber(input.experimentPortfolio?.total_expected_trials)
    },
    {
      source: "experiment_portfolio.primary_trial_group.expected_trials",
      value: asNumber(primaryGroup?.expected_trials)
    }
  ].filter(
    (candidate): candidate is { source: string; value: number } =>
      typeof candidate.value === "number" && Number.isInteger(candidate.value) && candidate.value > 0
  );
  if (candidates.length === 0) {
    return {};
  }
  const distinctCounts = new Map<number, string[]>();
  for (const candidate of candidates) {
    const sources = distinctCounts.get(candidate.value) ?? [];
    sources.push(candidate.source);
    distinctCounts.set(candidate.value, sources);
  }
  if (distinctCounts.size === 1) {
    return { count: candidates[0].value };
  }
  return {
    issue:
      "Explicit required run count provenance is ambiguous: " +
      candidates.map((candidate) => `${candidate.source}=${candidate.value}`).join(", ") +
      ". No governed required_run_count was inferred."
  };
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function formatMetricValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) >= 1 ? 3 : 4);
}

async function loadExperimentPortfolio(runId: string): Promise<ExperimentPortfolio | undefined> {
  try {
    const raw = await fs.readFile(path.join(".autolabos", "runs", runId, "experiment_portfolio.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as ExperimentPortfolio;
  } catch {
    return undefined;
  }
}

function extractSamplingProfile(metrics: Record<string, unknown>): ExperimentPortfolioSamplingProfile | undefined {
  const sampling =
    metrics.sampling_profile &&
    typeof metrics.sampling_profile === "object" &&
    !Array.isArray(metrics.sampling_profile)
      ? metrics.sampling_profile as Record<string, unknown>
      : {};
  const profile: ExperimentPortfolioSamplingProfile = {};
  if (typeof sampling.name === "string" && sampling.name.trim().length > 0) {
    profile.name = sampling.name.trim();
  }
  if (typeof sampling.total_trials === "number" && Number.isFinite(sampling.total_trials)) {
    profile.total_trials = sampling.total_trials;
  }
  if (typeof sampling.executed_trials === "number" && Number.isFinite(sampling.executed_trials)) {
    profile.executed_trials = sampling.executed_trials;
  }
  if (typeof sampling.cached_trials === "number" && Number.isFinite(sampling.cached_trials)) {
    profile.cached_trials = sampling.cached_trials;
  }
  return Object.keys(profile).length > 0 ? profile : undefined;
}
