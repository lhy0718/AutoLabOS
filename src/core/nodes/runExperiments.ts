import path from "node:path";
import { promises as fs } from "node:fs";

import { RunContextMemory } from "../memory/runContextMemory.js";
import { GraphNodeHandler } from "../stateGraph/types.js";
import { appendJsonl, writeRunArtifact } from "./helpers.js";
import { resolveRunCommand } from "./runCommandResolver.js";
import { NodeExecutionDeps } from "./types.js";
import { fileExists } from "../../utils/fs.js";
import {
  evaluateObjectiveMetric,
  ObjectiveMetricEvaluation,
  resolveObjectiveMetricProfile
} from "../objectiveMetric.js";
import { RunVerifierReport, RunVerifierTrigger } from "../experiments/runVerifierFeedback.js";

type SupplementalProfileName = "quick_check" | "confirmatory";

interface ManagedSupplementalProfile {
  profile: SupplementalProfileName;
  command: string;
  metricsPath: string;
}

interface ManagedSupplementalPlan {
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
}

export function createRunExperimentsNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "run_experiments",
    async execute({ run, abortSignal }) {
      const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
      const pendingHandoff =
        (await runContext.get<boolean>("implement_experiments.pending_handoff_to_run_experiments")) === true;
      const handoffReason = await runContext.get<string>("implement_experiments.handoff_reason");
      const trigger: RunVerifierTrigger = pendingHandoff ? "auto_handoff" : "manual";
      const managedSupplementalPlan = await resolveManagedSupplementalPlan(runContext, process.cwd());
      await runContext.put("run_experiments.trigger", trigger);
      await runContext.put("run_experiments.handoff_reason", handoffReason || null);
      await runContext.put("run_experiments.supplemental_runs", []);
      await runContext.put("run_experiments.supplemental_summary", null);
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
      if (managedSupplementalPlan) {
        const staleBackups = await clearManagedSupplementalOutputs(run, managedSupplementalPlan.profiles);
        if (staleBackups.length > 0) {
          deps.eventStream.emit({
            type: "OBS_RECEIVED",
            runId: run.id,
            node: "run_experiments",
            agentRole: "runner",
            payload: {
              text: `Cleared stale supplemental metrics before the standard run (${staleBackups.join(", ")}).`
            }
          });
        }
      }
      let resolved: Awaited<ReturnType<typeof resolveRunCommand>>;
      try {
        resolved = await resolveRunCommand(run, process.cwd());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
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
        return {
          status: "failure",
          error: message,
          toolCallsUsed: 0
        };
      }
      const commandToolCallsUsed = resolved.testCommand ? 2 : 1;

      if (resolved.testCommand) {
        deps.eventStream.emit({
          type: "TOOL_CALLED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            command: resolved.testCommand,
            cwd: resolved.testCwd || resolved.cwd,
            source: "preflight_test"
          }
        });

        const testObs = await deps.aci.runTests(
          resolved.testCommand,
          resolved.testCwd || resolved.cwd,
          abortSignal
        );
        if (testObs.status !== "ok") {
          const policyBlock = extractPolicyBlock(testObs);
          const report = buildRunVerifierReport({
            status: "fail",
            trigger,
            stage: policyBlock.blocked ? "policy" : "preflight_test",
            summary: testObs.stderr || "Preflight tests failed",
            policyRuleId: policyBlock.ruleId,
            policyReason: policyBlock.reason,
            command: resolved.testCommand,
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

      deps.eventStream.emit({
        type: "TOOL_CALLED",
        runId: run.id,
        node: "run_experiments",
        agentRole: "runner",
        payload: {
          command: resolved.command,
          cwd: resolved.cwd,
          source: resolved.source
        }
      });

      const obs = await deps.aci.runCommand(resolved.command, resolved.cwd, abortSignal);

      const logFile = await writeRunArtifact(
        run,
        "exec_logs/run_experiments.txt",
        [
          `command: ${resolved.command}`,
          `cwd: ${resolved.cwd}`,
          `source: ${resolved.source}`,
          "",
          obs.stdout || "",
          obs.stderr || ""
        ].join("\n")
      );

      if (obs.status !== "ok") {
        const policyBlock = extractPolicyBlock(obs);
        const report = buildRunVerifierReport({
          status: "fail",
          trigger,
          stage: policyBlock.blocked ? "policy" : "command",
          summary: obs.stderr || "Experiment command failed",
          policyRuleId: policyBlock.ruleId,
          policyReason: policyBlock.reason,
          command: resolved.command,
          cwd: resolved.cwd,
          metricsPath: resolved.metricsPath,
          exitCode: obs.exit_code ?? 1,
          stdout: obs.stdout,
          stderr: obs.stderr,
          logFile,
          suggestedNextAction: policyBlock.blocked
            ? "Replace the blocked run command with a policy-compliant command before retrying."
            : "Repair the experiment command or runtime dependencies before handing back to the runner."
        });
        deps.eventStream.emit({
          type: "TEST_FAILED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            command: resolved.command,
            stderr: obs.stderr || "unknown"
          }
        });
        await persistRunVerifierReport(run, runContext, report);
        await persistRunFailureState(runContext, {
          command: resolved.command,
          cwd: resolved.cwd,
          logFile,
          exitCode: obs.exit_code ?? 1,
          error: obs.stderr || "Experiment command failed"
        });
        return {
          status: "failure",
          error: obs.stderr || "Experiment command failed",
          toolCallsUsed: commandToolCallsUsed
        };
      }

      const metricsExists = await fileExists(resolved.metricsPath);
      if (!metricsExists) {
        const missingMessage = `Experiment finished without metrics output at ${resolved.metricsPath}`;
        const report = buildRunVerifierReport({
          status: "fail",
          trigger,
          stage: "metrics",
          summary: missingMessage,
          command: resolved.command,
          cwd: resolved.cwd,
          metricsPath: resolved.metricsPath,
          exitCode: obs.exit_code ?? 0,
          stdout: obs.stdout,
          stderr: obs.stderr,
          logFile,
          suggestedNextAction: "Ensure the experiment writes JSON metrics to the required metrics path before finishing."
        });
        deps.eventStream.emit({
          type: "TEST_FAILED",
          runId: run.id,
          node: "run_experiments",
          agentRole: "runner",
          payload: {
            command: resolved.command,
            metrics_path: resolved.metricsPath,
            stderr: missingMessage
          }
        });
        await persistRunVerifierReport(run, runContext, report);
        await persistRunFailureState(runContext, {
          command: resolved.command,
          cwd: resolved.cwd,
          logFile,
          exitCode: obs.exit_code ?? 0,
          error: missingMessage
        });
        return {
          status: "failure",
          error: missingMessage,
          toolCallsUsed: commandToolCallsUsed
        };
      }

      let objectiveEvaluationSummary = "";
      await appendJsonl(run, "exec_logs/observations.jsonl", [
        {
          command: resolved.command,
          cwd: resolved.cwd,
          source: resolved.source,
          status: obs.status,
          stdout: (obs.stdout || "").trim(),
          stderr: (obs.stderr || "").trim(),
          metrics_path: resolved.metricsPath,
          log_file: logFile
        }
      ]);

      let parsedMetrics: Record<string, unknown> = {};
      try {
        const rawMetrics = await fs.readFile(resolved.metricsPath, "utf8");
        const parsed = JSON.parse(rawMetrics) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("metrics.json must decode to an object");
        }
        parsedMetrics = parsed as Record<string, unknown>;
      } catch (error) {
        const metricsError = `Experiment produced invalid metrics JSON at ${resolved.metricsPath}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        const report = buildRunVerifierReport({
          status: "fail",
          trigger,
          stage: "metrics",
          summary: metricsError,
          command: resolved.command,
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
            command: resolved.command,
            metrics_path: resolved.metricsPath,
            stderr: metricsError
          }
        });
        await persistRunVerifierReport(run, runContext, report);
        await persistRunFailureState(runContext, {
          command: resolved.command,
          cwd: resolved.cwd,
          logFile,
          exitCode: obs.exit_code ?? 0,
          error: metricsError
        });
        return {
          status: "failure",
          error: metricsError,
          toolCallsUsed: commandToolCallsUsed
        };
      }

      const objectiveProfile = await resolveObjectiveMetricProfile({
        run,
        runContextMemory: runContext,
        llm: deps.llm,
        eventStream: deps.eventStream,
        node: "run_experiments"
      });
      const experimentMode =
        (await runContext.get<string>("implement_experiments.mode")) || "real_execution";
      const objectiveEvaluation = evaluateObjectiveMetric(
        parsedMetrics,
        objectiveProfile,
        run.objectiveMetric
      );
      objectiveEvaluationSummary = objectiveEvaluation.summary;
      await writeRunArtifact(run, "objective_evaluation.json", JSON.stringify(objectiveEvaluation, null, 2));
      await persistRunVerifierReport(
        run,
        runContext,
        buildRunVerifierReport({
          status: "pass",
          trigger,
          stage: "success",
          summary: objectiveEvaluation.summary,
          command: resolved.command,
          cwd: resolved.cwd,
          metricsPath: resolved.metricsPath,
          exitCode: obs.exit_code ?? 0,
          stdout: obs.stdout,
          stderr: obs.stderr,
          logFile
        })
      );
      const supplementalRuns = await maybeRunManagedSupplementalProfiles({
        deps,
        run,
        runContext,
        objectiveProfile,
        objectiveEvaluation,
        primaryCommand: resolved.command,
        plan: managedSupplementalPlan,
        abortSignal
      });

      await runContext.put("run_experiments.command", resolved.command);
      await runContext.put("run_experiments.cwd", resolved.cwd);
      await runContext.put("run_experiments.last_log_file", logFile);
      await runContext.put("run_experiments.exit_code", obs.exit_code ?? 0);
      await runContext.put("run_experiments.last_error", undefined);
      await runContext.put("objective_metric.last_evaluation", objectiveEvaluation);
      await runContext.put("run_experiments.supplemental_runs", supplementalRuns.records);
      await runContext.put("run_experiments.supplemental_summary", supplementalRuns.summary || null);
      await writeRunArtifact(
        run,
        "run_experiments_supplemental_runs.json",
        JSON.stringify(supplementalRuns.records, null, 2)
      );

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

      return {
        status: "success",
        summary: `${formatRunLabel(experimentMode, trigger)} completed via ${resolved.command}. ${objectiveEvaluationSummary}${
          supplementalRuns.summary ? ` ${supplementalRuns.summary}` : ""
        }`,
        needsApproval: true,
        toolCallsUsed: commandToolCallsUsed + supplementalRuns.toolCallsUsed
      };
    }
  };
}

async function resolveManagedSupplementalPlan(
  runContext: RunContextMemory,
  workspaceRoot: string
): Promise<ManagedSupplementalPlan | undefined> {
  const experimentMode = await runContext.get<string>("implement_experiments.mode");
  if (experimentMode !== "real_execution") {
    return undefined;
  }

  const publicDir = resolveMaybeRelative(await runContext.get<string>("implement_experiments.public_dir"), workspaceRoot);
  const scriptPath = resolveMaybeRelative(await runContext.get<string>("implement_experiments.script"), workspaceRoot);
  if (!publicDir || !scriptPath) {
    return undefined;
  }

  const manifestPath = path.join(publicDir, "artifact_manifest.json");
  if (!(await fileExists(manifestPath)) || !(await fileExists(scriptPath))) {
    return undefined;
  }

  return {
    publicDir,
    profiles: [
      {
        profile: "quick_check",
        command: `python3 -B ${JSON.stringify(scriptPath)} --quick-check --metrics-out ${JSON.stringify(
          path.join(publicDir, "quick_check_metrics.json")
        )}`,
        metricsPath: path.join(publicDir, "quick_check_metrics.json")
      },
      {
        profile: "confirmatory",
        command: `python3 -B ${JSON.stringify(scriptPath)} --profile confirmatory --metrics-out ${JSON.stringify(
          path.join(publicDir, "confirmatory_metrics.json")
        )}`,
        metricsPath: path.join(publicDir, "confirmatory_metrics.json")
      }
    ]
  };
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
}): Promise<{
  records: SupplementalRunRecord[];
  summary?: string;
  toolCallsUsed: number;
}> {
  if (!input.plan) {
    return {
      records: [],
      toolCallsUsed: 0
    };
  }

  if (!isManagedStandardRunCommand(input.primaryCommand)) {
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
      toolCallsUsed: 0
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
      toolCallsUsed: 0
    };
  }

  let toolCallsUsed = 0;
  const records: SupplementalRunRecord[] = [];
  const quickCheck = await runManagedSupplementalProfile({
    ...input,
    profile: input.plan.profiles[0]
  });
  toolCallsUsed += 1;
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
    toolCallsUsed += 1;
    records.push(confirmatory);
  }

  return {
    records,
    summary: summarizeSupplementalRuns(records),
    toolCallsUsed
  };
}

async function runManagedSupplementalProfile(input: {
  deps: NodeExecutionDeps;
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"];
  objectiveProfile: Awaited<ReturnType<typeof resolveObjectiveMetricProfile>>;
  profile: ManagedSupplementalProfile;
  abortSignal?: AbortSignal;
}): Promise<SupplementalRunRecord> {
  input.deps.eventStream.emit({
    type: "TOOL_CALLED",
    runId: input.run.id,
    node: "run_experiments",
    agentRole: "runner",
    payload: {
      command: input.profile.command,
      cwd: path.dirname(input.profile.metricsPath),
      source: `supplemental_${input.profile.profile}`
    }
  });

  const cwd = path.dirname(input.profile.metricsPath);
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
      objective_evaluation: objectiveEvaluation
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

function isManagedStandardRunCommand(command: string): boolean {
  if (/--quick-check/u.test(command) || /--profile\s+confirmatory/u.test(command)) {
    return false;
  }
  return /--profile\s+standard/u.test(command);
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
  status: "pass" | "fail";
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
}): RunVerifierReport {
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
    recorded_at: new Date().toISOString()
  };
}

async function persistRunVerifierReport(
  run: Parameters<typeof writeRunArtifact>[0],
  runContext: RunContextMemory,
  report: RunVerifierReport
): Promise<void> {
  await writeRunArtifact(run, "run_experiments_verify_report.json", JSON.stringify(report, null, 2));
  await runContext.put("run_experiments.last_report", report);
  if (report.status === "fail") {
    await runContext.put("run_experiments.feedback_for_implementer", report);
    await runContext.put("implement_experiments.runner_feedback", report);
    return;
  }
  await runContext.put("run_experiments.feedback_for_implementer", null);
  await runContext.put("implement_experiments.runner_feedback", null);
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
