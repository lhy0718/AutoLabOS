import path from "node:path";

import { promises as fs } from "node:fs";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { safeRead, writeRunArtifact } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";
import { LongTermStore } from "../memory/longTermStore.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import {
  evaluateObjectiveMetric,
  ObjectiveMetricEvaluation,
  resolveObjectiveMetricProfile
} from "../objectiveMetric.js";
import { buildAnalysisReport, renderPerformanceFigureSvg } from "../resultAnalysis.js";
import { synthesizeAnalysisReport } from "../resultAnalysisSynthesis.js";
import { RunVerifierReport } from "../experiments/runVerifierFeedback.js";

export function createAnalyzeResultsNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "analyze_results",
    async execute({ run }) {
      const longTermStore = new LongTermStore(run.memoryRefs.longTermPath);
      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      const metricsPath = path.join(".autoresearch", "runs", run.id, "metrics.json");
      let metrics: Record<string, unknown> = {};
      const inputWarnings: string[] = [];
      let metricsLoadError: string | undefined;
      try {
        const raw = await fs.readFile(metricsPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("metrics.json must decode to an object");
        }
        metrics = parsed as Record<string, unknown>;
      } catch (error) {
        metrics = {};
        metricsLoadError = `Structured result analysis requires a valid metrics file at ${metricsPath}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        inputWarnings.push(metricsLoadError);
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "analyze_results",
          payload: { text: metricsLoadError }
        });
      }

      const objectiveProfile = await resolveObjectiveMetricProfile({
        run,
        runContextMemory,
        llm: deps.llm,
        eventStream: deps.eventStream,
        node: "analyze_results"
      });
      const cachedEvaluation =
        await runContextMemory.get<ObjectiveMetricEvaluation>("objective_metric.last_evaluation");
      const objectiveEvaluation =
        cachedEvaluation || evaluateObjectiveMetric(metrics, objectiveProfile, run.objectiveMetric);

      const experimentPlanRaw = await safeRead(path.join(".autoresearch", "runs", run.id, "experiment_plan.yaml"));
      const observationsRaw = await safeRead(
        path.join(".autoresearch", "runs", run.id, "exec_logs", "observations.jsonl")
      );
      const runVerifierReport = await readJsonObject<RunVerifierReport>(
        path.join(".autoresearch", "runs", run.id, "run_experiments_verify_report.json"),
        inputWarnings,
        "run_experiments_verify_report.json"
      );
      const publicDir =
        resolveMaybeRelative(
          await runContextMemory.get<string>("implement_experiments.public_dir"),
          process.cwd()
        ) || undefined;
      const supplementalMetrics = await loadSupplementalMetrics(publicDir, inputWarnings);
      const recentPaperComparisonPath =
        resolveMaybeRelative(asString(metrics.recent_paper_reproducibility_path), publicDir || process.cwd()) ||
        (publicDir ? path.join(publicDir, "recent_paper_reproducibility.json") : undefined);
      const recentPaperComparison =
        (recentPaperComparisonPath &&
          (await readJsonObject<Record<string, unknown>>(
            recentPaperComparisonPath,
            inputWarnings,
            "recent_paper_reproducibility.json"
          ))) ||
        undefined;
      const summary = buildAnalysisReport({
        run,
        metrics,
        objectiveProfile,
        objectiveEvaluation,
        experimentPlanRaw,
        observationsRaw,
        inputWarnings,
        runVerifierReport,
        supplementalMetrics,
        recentPaperComparison,
        recentPaperComparisonPath
      });
      const noNumericMetrics = summary.metric_table.length === 0;
      if (!metricsLoadError && !noNumericMetrics) {
        summary.synthesis = await synthesizeAnalysisReport({
          run,
          report: summary,
          llm: deps.llm,
          eventStream: deps.eventStream,
          node: "analyze_results"
        });
      }

      await writeRunArtifact(run, "result_analysis.json", JSON.stringify(summary, null, 2));
      if (summary.synthesis) {
        await writeRunArtifact(run, "result_analysis_synthesis.json", JSON.stringify(summary.synthesis, null, 2));
      }
      const figureSvg = renderPerformanceFigureSvg(summary);
      if (figureSvg) {
        await writeRunArtifact(run, "figures/performance.svg", figureSvg);
      }
      await runContextMemory.put("analyze_results.last_summary", summary);
      await runContextMemory.put("analyze_results.last_error", metricsLoadError || null);
      await runContextMemory.put("analyze_results.last_synthesis", summary.synthesis || null);
      await longTermStore.append({
        runId: run.id,
        category: "results",
        text: `Result summary: ${JSON.stringify(summary)}`,
        tags: ["analyze_results"]
      });

      if (metricsLoadError || noNumericMetrics) {
        const error =
          metricsLoadError ||
          `Structured result analysis requires at least one numeric metric in ${metricsPath}.`;
        if (!metricsLoadError) {
          deps.eventStream.emit({
            type: "OBS_RECEIVED",
            runId: run.id,
            node: "analyze_results",
            payload: { text: error }
          });
          await runContextMemory.put("analyze_results.last_error", error);
        }
        return {
          status: "failure",
          error,
          summary: error,
          toolCallsUsed: 1
        };
      }

      return {
        status: "success",
        summary: `Result analysis complete. mean_score=${summary.mean_score}. ${objectiveEvaluation.summary}`,
        needsApproval: true,
        toolCallsUsed: 1
      };
    }
  };
}

async function loadSupplementalMetrics(publicDir: string | undefined, warnings: string[]): Promise<
  Array<{
    profile: string;
    path?: string;
    metrics: Record<string, unknown>;
  }>
> {
  if (!publicDir) {
    return [];
  }

  const results: Array<{
    profile: string;
    path?: string;
    metrics: Record<string, unknown>;
  }> = [];

  for (const [profile, fileName] of [
    ["confirmatory", "confirmatory_metrics.json"],
    ["quick_check", "quick_check_metrics.json"]
  ] as const) {
    const filePath = path.join(publicDir, fileName);
    const parsed = await readJsonObject<Record<string, unknown>>(filePath, warnings, fileName);
    if (parsed) {
      results.push({
        profile,
        path: filePath,
        metrics: parsed
      });
    }
  }

  return results;
}

async function readJsonObject<T extends object>(
  filePath: string,
  warnings: string[],
  label: string
): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must decode to an object`);
    }
    return parsed as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ENOENT/u.test(message)) {
      warnings.push(`Failed to parse ${label} at ${filePath}: ${message}`);
    }
    return undefined;
  }
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
