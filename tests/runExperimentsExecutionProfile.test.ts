import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";

import { InMemoryEventStream } from "../src/core/events.js";
import { MockLLMClient } from "../src/core/llm/client.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { createRunExperimentsNode } from "../src/core/nodes/runExperiments.js";
import { FailureMemory, buildErrorFingerprint } from "../src/core/experiments/failureMemory.js";
import { buildPublicSectionDir } from "../src/core/publicArtifacts.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { EXPERIMENT_GOVERNANCE_CONTRACT_KEY } from "../src/core/experimentGovernance.js";
import { RunRecord } from "../src/types.js";

const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
});

function makeRun(runId: string): RunRecord {
  return {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Execution profile test",
    topic: "execution profile handling",
    constraints: [],
    objectiveMetric: "accuracy at least 0.9",
    status: "running",
    currentNode: "run_experiments",
    latestSummary: undefined,
    nodeThreads: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    graph: {
      ...createDefaultGraphState(),
      currentNode: "run_experiments"
    },
    memoryRefs: {
      runContextPath: `.autolabos/runs/${runId}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${runId}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${runId}/memory/episodes.jsonl`
    }
  };
}

describe("run_experiments execution profile behavior", () => {
  it("blocks same-node execution when failure memory marks run_experiments do-not-retry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-profile-"));
    process.chdir(root);
    const run = makeRun("run-do-not-retry-start");
    run.graph.retryCounters.run_experiments = 1;
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const errorMessage =
      "Experiment metrics contract failed: Condition summary accuracy is inconsistent with correct/total counts.";
    await FailureMemory.forRun(run.id).append({
      run_id: run.id,
      node_id: "run_experiments",
      attempt: 1,
      failure_class: "structural",
      error_fingerprint: buildErrorFingerprint(errorMessage),
      error_message: errorMessage,
      do_not_retry: true,
      do_not_retry_reason: "Structural execution failure."
    });

    const aci = {
      runCommand: vi.fn(),
      runTests: vi.fn()
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("do-not-retry");
    expect(aci.runCommand).not.toHaveBeenCalled();
    expect(aci.runTests).not.toHaveBeenCalled();
  });

  it("allows run_experiments after a newer upstream implementation repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-profile-"));
    process.chdir(root);
    const run = makeRun("run-upstream-repair-after-failure-memory");
    run.graph.retryCounters.run_experiments = 2;
    run.graph.nodeStates.implement_experiments.status = "completed";
    run.graph.nodeStates.implement_experiments.updatedAt = "2026-04-07T00:10:00.000Z";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(
      path.join(runDir, "failure_memory.jsonl"),
      JSON.stringify({
        failure_id: "failure-before-upstream-repair",
        run_id: run.id,
        node_id: "run_experiments",
        attempt: 1,
        timestamp: "2026-04-07T00:00:00.000Z",
        failure_class: "structural",
        error_fingerprint: "structural execution failure",
        error_message: "Experiment metrics contract failed.",
        do_not_retry: true,
        do_not_retry_reason: "Structural execution failure."
      }) + "\n",
      "utf8"
    );

    const aci = {
      runCommand: vi.fn(),
      runTests: vi.fn()
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "plan_only",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "plan_only_mode"
    });
    expect(aci.runCommand).not.toHaveBeenCalled();
    expect(aci.runTests).not.toHaveBeenCalled();
  });

  it("allows run_experiments after a newer harness repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-harness-repair-after-failure-memory-"));
    process.chdir(root);
    const run = makeRun("run-harness-repair-after-failure-memory");
    run.graph.retryCounters.run_experiments = 2;
    run.graph.nodeStates.implement_experiments.status = "completed";
    run.graph.nodeStates.implement_experiments.updatedAt = "1970-01-01T00:00:00.000Z";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(
      path.join(runDir, "failure_memory.jsonl"),
      JSON.stringify({
        failure_id: "failure-before-harness-repair",
        run_id: run.id,
        node_id: "run_experiments",
        attempt: 1,
        timestamp: "1970-01-01T00:00:00.000Z",
        failure_class: "structural",
        error_fingerprint: "structural execution failure",
        error_message: "Experiment metrics contract failed.",
        do_not_retry: true,
        do_not_retry_reason: "Structural execution failure."
      }) + "\n",
      "utf8"
    );

    const aci = {
      runCommand: vi.fn(),
      runTests: vi.fn()
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "plan_only",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "plan_only_mode"
    });
    expect(aci.runCommand).not.toHaveBeenCalled();
    expect(aci.runTests).not.toHaveBeenCalled();
  });

  it("skips code execution in plan_only mode and records a skipped verifier report", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-profile-"));
    process.chdir(root);
    const run = makeRun("run-plan-only");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const aci = {
      runCommand: vi.fn(),
      runTests: vi.fn()
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "plan_only",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "plan_only_mode"
    });
    expect(aci.runCommand).not.toHaveBeenCalled();
    expect(aci.runTests).not.toHaveBeenCalled();

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; summary: string };
    expect(verifierReport.status).toBe("skipped");
    expect(verifierReport.summary).toContain("plan_only");

    const intermediateArtifacts = JSON.parse(
      await readFile(path.join(runDir, "run_experiments", "intermediate_artifacts.json"), "utf8")
    ) as {
      summary: { present: number; missing_required: number };
      entries: Array<{ artifact_id: string; status: string; parse_status: string; relative_path: string }>;
    };
    expect(intermediateArtifacts.summary.present).toBeGreaterThanOrEqual(1);
    expect(intermediateArtifacts.summary.missing_required).toBe(0);
    expect(intermediateArtifacts.entries).toContainEqual(
      expect.objectContaining({
        artifact_id: "run_experiments_verify_report",
        relative_path: "run_experiments_verify_report.json",
        status: "present",
        parse_status: "parseable"
      })
    );
  });

  it("treats remote bootstrap requirements as metadata instead of a hard policy stop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-bootstrap-contract-"));
    process.chdir(root);
    const run = makeRun("run-bootstrap-blocked");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "outputs", "experiment");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });
    await writeFile(
      path.join(publicDir, "bootstrap_contract.json"),
      JSON.stringify(
        {
          version: 1,
          requires_network: true,
          summary:
            "This run may fetch a public Hugging Face model/tokenizer on demand.",
          remediation: ["Prewarm the cache or allow network bootstrap."]
        },
        null,
        2
      ),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.public_dir", publicDir);

    const aci = {
      runCommand: vi.fn().mockResolvedValue({
        status: "error",
        stderr: "synthetic failure after bootstrap warning",
        exit_code: 1,
        duration_ms: 1
      }),
      runTests: vi.fn().mockResolvedValue({
        status: "error",
        stderr: "synthetic failure after bootstrap warning",
        exit_code: 1,
        duration_ms: 1
      })
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(String(result.error || "")).not.toContain("Offline execution cannot proceed");
    expect(aci.runCommand).not.toHaveBeenCalledWith(
      expect.stringContaining("Offline execution cannot proceed")
    );
  });

  it("passes overwrite intent to reusable public runners that expose an overwrite flag", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-reusable-output-"));
    process.chdir(root);
    const run = makeRun("run-reusable-output");
    run.objectiveMetric = "accuracy >= 0.9";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "outputs", "public-runner");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const scriptPath = path.join(publicDir, "run_condition_sweep.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "parser = argparse.ArgumentParser()",
        "parser.add_argument('--output-dir')",
        "parser.add_argument('--metrics-path')",
        "parser.add_argument('--overwrite-output', action='store_true')",
        "parser.parse_args()"
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(publicDir, "study_results.json"), JSON.stringify({ status: "previous" }), "utf8");

    const metricsPath = path.join(runDir, "metrics.json");
    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put(
      "implement_experiments.run_command",
      `python3 ${JSON.stringify(scriptPath)} --output-dir ${JSON.stringify(publicDir)} --metrics-path ${JSON.stringify(metricsPath)}`
    );
    await runContext.put("implement_experiments.cwd", publicDir);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const aci = {
      runCommand: vi.fn(async (command: string) => {
        expect(command).toContain("--overwrite-output");
        await writeFile(
          metricsPath,
          JSON.stringify(
            {
              status: "completed",
              accuracy: 0.95,
              primary_metric: { name: "accuracy", value: 0.95, target: 0.9, met: true }
            },
            null,
            2
          ),
          "utf8"
        );
        return {
          status: "ok" as const,
          stdout: "runner completed",
          stderr: "",
          exit_code: 0,
          duration_ms: 10
        };
      }),
      runTests: vi.fn()
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(aci.runCommand).toHaveBeenCalledTimes(1);
    expect(aci.runTests).not.toHaveBeenCalled();
  });

  it("blocks long-running generated runners that lack progress or partial metrics artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-long-run-observability-"));
    process.chdir(root);
    const run = makeRun("run-long-run-observability");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "outputs", "public-runner");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const scriptPath = path.join(publicDir, "run_condition_sweep.py");
    await writeFile(
      scriptPath,
      [
        "from pathlib import Path",
        "import json",
        "",
        "REQUIRED_RUN_COUNT = 12",
        "train_steps_per_run = 48",
        "",
        "def load_model():",
        "    return AutoModel.from_pretrained(\"local-or-remote-model\")",
        "",
        "def run_condition():",
        "    optimizer.step()",
        "",
        "def main():",
        "    Path(\"metrics.json\").write_text(json.dumps({\"status\": \"completed\"}), encoding=\"utf-8\")",
        "",
        "if __name__ == \"__main__\":",
        "    main()",
        ""
      ].join("\n"),
      "utf8"
    );

    const metricsPath = path.join(runDir, "metrics.json");
    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put(
      "implement_experiments.run_command",
      `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`
    );
    await runContext.put("implement_experiments.cwd", publicDir);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const aci = {
      runCommand: vi.fn(),
      runTests: vi.fn()
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(String(result.error)).toContain("no observable progress, heartbeat, or partial-metrics surface");
    expect(aci.runCommand).not.toHaveBeenCalled();

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "preflight_test"
    });
    expect(verifierReport.summary).toContain("required_run_count=12");
    expect(verifierReport.suggested_next_action).toContain("progress");
  });

  it("does not promote objective metrics from stale public bundle outputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-stale-public-metric-"));
    process.chdir(root);
    const run = makeRun("run-stale-public-metric");
    run.objectiveMetric = "accuracy >= 0.9";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "outputs", "public-runner");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const staleMetricsPath = path.join(publicDir, "metrics.json");
    await writeFile(
      staleMetricsPath,
      JSON.stringify({ status: "completed", accuracy: 0.99, primary_metric_key: "accuracy" }, null, 2),
      "utf8"
    );
    const staleDate = new Date(Date.now() - 60_000);
    await utimes(staleMetricsPath, staleDate, staleDate);

    const metricsPath = path.join(runDir, "metrics.json");
    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    const eventStream = new InMemoryEventStream();

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream,
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            metricsPath,
            JSON.stringify({ status: "completed", completed_run_count: 1, required_run_count: 1 }, null, 2),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    const metrics = JSON.parse(await readFile(metricsPath, "utf8")) as { accuracy?: number };
    expect(metrics.accuracy).toBeUndefined();
    expect(
      eventStream.history().some((event) =>
        String(event.payload.text || "").includes("Promoted objective metric accuracy=0.99")
      )
    ).toBe(false);
  });

  it("fails verification when a successful command writes incomplete comparator metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-incomplete-comparator-"));
    process.chdir(root);
    const run = makeRun("run-incomplete-comparator");
    run.objectiveMetric = "accuracy_delta_vs_baseline";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    await runContext.put(EXPERIMENT_GOVERNANCE_CONTRACT_KEY, {
      version: 1,
      run_id: run.id,
      plan_id: "plan-incomplete-comparator",
      selected_hypothesis_ids: ["hypothesis-1"],
      objective_metric_name: run.objectiveMetric,
      baseline_first_required: true,
      baseline_candidate_ids: ["baseline"],
      comparison_mode: "baseline_first_locked",
      budget_profile: {
        mode: "single_run_locked",
        locked: true,
        timeout_sec: 7200
      },
      objective_profile: {
        source: "heuristic_fallback",
        raw: run.objectiveMetric,
        primaryMetric: "accuracy_delta_vs_baseline",
        preferredMetricKeys: ["accuracy_delta_vs_baseline"],
        direction: "maximize"
      },
      evaluator_contract_id: "eval-contract-incomplete-comparator",
      created_at: new Date().toISOString()
    });

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                summary: {
                  primary_metric: {
                    name: "mean_zero_shot_accuracy_benchmark_tasks",
                    baseline_value: null,
                    best_tuned_value: null,
                    best_tuned_delta_vs_baseline: null,
                    winner: "baseline"
                  }
                },
                study: {
                  aggregate: {
                    all_conditions_succeeded: false,
                    completed_condition_count: 1,
                    failed_condition_count: 3,
                    successful_tuned_condition_count: 0,
                    baseline_mean_accuracy: null,
                    best_tuned_mean_accuracy: null,
                    best_tuned_delta_vs_baseline: null
                  }
                }
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "experiment command completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics contract failed");
    expect(result.error).toContain("No tuned comparator condition completed successfully");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Study aggregate reports incomplete execution");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
  });

  it("fails verification when planned brief conditions are under-executed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-under-executed-conditions-"));
    process.chdir(root);
    const run = makeRun("run-under-executed-conditions");
    run.objectiveMetric =
      "Primary metric: mean zero-shot accuracy. Meaningful improvement: at least +1.0 percentage point over the tuned baseline.";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    await runContext.put(
      "run_brief.raw",
      [
        "# Research Brief",
        "## Minimum Acceptable Evidence",
        "- All planned conditions must execute successfully and report bootstrap confidence intervals.",
        "## Minimum Experiment Plan",
        "- one named tuned baseline run",
        "- three alternative recipe conditions"
      ].join("\n")
    );
    await runContext.put(EXPERIMENT_GOVERNANCE_CONTRACT_KEY, {
      version: 1,
      run_id: run.id,
      plan_id: "plan-under-executed-conditions",
      selected_hypothesis_ids: ["hypothesis-1"],
      objective_metric_name: run.objectiveMetric,
      baseline_first_required: true,
      baseline_candidate_ids: ["standard_adapter_baseline"],
      comparison_mode: "baseline_first_locked",
      budget_profile: {
        mode: "single_run_locked",
        locked: true,
        timeout_sec: 7200
      },
      objective_profile: {
        source: "heuristic_fallback",
        raw: run.objectiveMetric,
        primaryMetric: "accuracy_delta_vs_baseline",
        preferredMetricKeys: ["accuracy_delta_vs_baseline"],
        direction: "maximize",
        comparator: ">=",
        targetValue: 0.01
      },
      evaluator_contract_id: "eval-contract-under-executed-conditions",
      created_at: new Date().toISOString()
    });

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                primary_metric: {
                  name: "accuracy_delta_vs_baseline",
                  value: 0.012,
                  target: 0.01,
                  met: true
                },
                conditions: [
                  {
                    name: "base_unmodified",
                    condition_type: "baseline_unmodified_checkpoint",
                    evaluation: { mean_zero_shot_accuracy: 0.4 }
                  },
                  {
                    name: "candidate_condition_a",
                    condition_type: "adapter_instruction_tuned",
                    evaluation: { mean_zero_shot_accuracy: 0.412 }
                  },
                  {
                    name: "candidate_condition_b",
                    condition_type: "adapter_instruction_tuned",
                    evaluation: { mean_zero_shot_accuracy: 0.411 }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "experiment command completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics contract failed");
    expect(result.error).toContain("Planned condition coverage incomplete");
    expect(result.error).toContain("observed 2 successful tuned condition");
    expect(result.error).toContain("requires 4");
  });

  it("fails verification when successful metrics expand the planned condition and seed contract", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-expanded-condition-contract-"));
    process.chdir(root);
    const run = makeRun("run-expanded-condition-contract");
    run.objectiveMetric = "accuracy >= 0.9";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    await runContext.put(
      "run_brief.raw",
      [
        "# Research Brief",
        "## Constraints",
        "- Seed: 7 for the primary condition sweep.",
        "- Condition grid: width in `{1, 2}` x regularization in `{0.0, 0.5}`.",
        "## Minimum Acceptable Evidence",
        "- All 4 planned conditions must execute with parseable metrics.",
        "## Minimum Experiment Plan",
        "- Four planned conditions from the declared grid.",
        "## Allowed Budgeted Passes",
        "- Repeat runs for the baseline and strongest condition when runtime allows."
      ].join("\n")
    );

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                accuracy: 0.95,
                primary_metric: {
                  name: "accuracy",
                  value: 0.95,
                  target: 0.9,
                  met: true
                },
                completed_condition_count: 5,
                condition_summaries: [
                  { condition_marker: "baseline_condition", width: 1, regularization: 0, planned_seed_count: 2, status: "completed" },
                  { condition_marker: "candidate_condition_a", width: 1, regularization: 0.5, planned_seed_count: 2, status: "completed" },
                  { condition_marker: "candidate_condition_b", width: 2, regularization: 0, planned_seed_count: 2, status: "completed" },
                  { condition_marker: "candidate_condition_c", width: 2, regularization: 0.5, planned_seed_count: 2, status: "completed" },
                  { condition_marker: "candidate_condition_d", width: 2, regularization: 1, planned_seed_count: 2, status: "completed" }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed with expanded contract",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Planned condition contract expanded");
    expect(result.error).toContain("observed 5 successful condition(s)");
    expect(result.error).toContain("regularization=1 is outside declared values {0,0.5}");
    expect(result.error).toContain("Primary seed contract expanded");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Planned condition contract expanded");
    expect(verifierReport.summary).toContain("Primary seed contract expanded");
  });

  it("fails verification when a successful command writes top-level failed metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-failed-metrics-"));
    process.chdir(root);
    const run = makeRun("run-failed-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: true,
                candidate_results: [],
                failure: {
                  type: "RuntimeError",
                  message: "No per-candidate execution/evaluation helper was materialized."
                }
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote failed metrics",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics payload reports failed status");
    expect(result.error).toContain("No per-candidate execution/evaluation helper was materialized");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Experiment metrics payload reports failed status");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
  });

  it("rejects aggregate completion counts when execution rows all failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-contradictory-row-counts-"));
    process.chdir(root);
    const run = makeRun("run-contradictory-row-counts");
    run.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                primary_metric_key: "accuracy_delta_vs_baseline",
                accuracy_delta_vs_baseline: 0.02,
                completed_run_count: 2,
                required_run_count: 2,
                failed_run_count: 0,
                rows: [
                  {
                    condition_marker: "baseline_condition",
                    seed: 1,
                    status: "failed",
                    accuracy: null,
                    error_message: "No execution helper is available"
                  },
                  {
                    condition_marker: "candidate_condition_a",
                    seed: 1,
                    status: "failed",
                    accuracy: null,
                    error_message: "No execution helper is available"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote contradictory aggregate metrics",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment row evidence contradicts failed_run_count=0");
    expect(result.error).toContain("Experiment row evidence contradicts completed_run_count=2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("execution row(s) report failed status");
  });

  it("summarizes completed train-only rows when objective metrics are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-train-only-metrics-"));
    process.chdir(root);
    const run = makeRun("run-train-only-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(runDir, { recursive: true });
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 2,
                required_condition_count: 2,
                condition_results: [
                  { condition_marker: "baseline_condition", status: "completed", train_loss: 1.2, wall_time_sec: 3 },
                  {
                    condition_marker: "candidate_condition",
                    status: "unknown",
                    result: { status: "completed", train_loss: 1.1, wall_time_sec: 4 }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("primary_metric_value=quality_delta:null");
    expect(result.error).toContain("condition_result_statuses=completed:2");
    expect(result.error).toContain("completed_condition_metric_keys=none");
    expect(result.error).toContain("completed_condition_missing_evaluation_metrics=2/2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { suggested_next_action?: string };
    expect(verifierReport.suggested_next_action).toContain("Repair metrics aggregation");
    expect(verifierReport.suggested_next_action).toContain("condition-level accuracy");
    expect(verifierReport.suggested_next_action).toContain("model/tokenizer");
  });

  it("rejects completed condition summaries whose counts contradict metric values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-inconsistent-summary-metrics-"));
    process.chdir(root);
    const run = makeRun("run-inconsistent-summary-metrics");
    run.objectiveMetric = "quality_delta >= 0.01";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(runDir, { recursive: true });
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric_key: "quality_delta",
                primary_metric_value: 0.02,
                quality_delta: 0.02,
                completed_run_count: 4,
                required_run_count: 4,
                completed_condition_count: 2,
                required_condition_count: 2,
                raw_condition_results: [
                  { condition_marker: "baseline_condition", status: "completed", seed: 1, accuracy: 0.5 },
                  { condition_marker: "baseline_condition", status: "completed", seed: 2, accuracy: 0.5 },
                  { condition_marker: "candidate_condition_a", status: "completed", seed: 1, accuracy: 0.52 },
                  { condition_marker: "candidate_condition_a", status: "completed", seed: 2, accuracy: 0.52 }
                ],
                condition_summaries: [
                  {
                    condition_marker: "baseline_condition",
                    status: "completed",
                    average_accuracy: 0.5,
                    correct_count: 0,
                    total_count: 1,
                    seeds: [],
                    seed_count: 0,
                    confidence_interval: { sample_size: 1 },
                    evaluation: {
                      overall: {
                        accuracy: 0.5,
                        correct_count: 0,
                        total_count: 1,
                        confidence_interval: { sample_size: 1 }
                      }
                    }
                  },
                  {
                    condition_marker: "candidate_condition_a",
                    status: "completed",
                    average_accuracy: 0.52,
                    correct_count: 0,
                    total_count: 1,
                    seeds: [],
                    seed_count: 0,
                    confidence_interval: { sample_size: 1 },
                    evaluation: {
                      overall: {
                        accuracy: 0.52,
                        correct_count: 0,
                        total_count: 1,
                        confidence_interval: { sample_size: 1 }
                      }
                    },
                    quality_delta: 0.02
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Condition summary accuracy is inconsistent with correct/total counts");
    expect(result.error).toContain("condition summaries report seed_count=0");
    expect(result.error).toContain("confidence intervals with sample_size below the expected per-condition seed count");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Condition summary accuracy is inconsistent");
  });

  it("projects seed-task metric rows into repeated-condition summaries with seed counts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-seed-task-summary-metrics-"));
    process.chdir(root);
    const run = makeRun("run-seed-task-summary-metrics");
    run.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(runDir, { recursive: true });
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");
    await runContext.put(
      "run_brief.raw",
      [
        "# Research Brief",
        "## Constraints",
        "- Seed: 7 for the primary condition sweep.",
        "## Minimum Experiment Plan",
        "- Two planned conditions with two governed runs per condition."
      ].join("\n")
    );

    const rows = [
      ["baseline_condition", 1, "benchmark_task_a", 5, 10],
      ["baseline_condition", 1, "benchmark_task_b", 4, 10],
      ["baseline_condition", 2, "benchmark_task_a", 6, 10],
      ["baseline_condition", 2, "benchmark_task_b", 5, 10],
      ["candidate_condition_a", 1, "benchmark_task_a", 7, 10],
      ["candidate_condition_a", 1, "benchmark_task_b", 6, 10],
      ["candidate_condition_a", 2, "benchmark_task_a", 8, 10],
      ["candidate_condition_a", 2, "benchmark_task_b", 7, 10]
    ].map(([condition_marker, seed, task, correct_count, evaluated_count]) => ({
      condition_marker,
      seed,
      task,
      status: "completed",
      accuracy: Number(correct_count) / Number(evaluated_count),
      raw_evidence: {
        task_metrics: {
          [String(task)]: {
            correct_count,
            evaluated_count,
            accuracy: Number(correct_count) / Number(evaluated_count)
          }
        }
      }
    }));

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric_key: "accuracy_delta_vs_baseline",
                completed_run_count: 4,
                required_run_count: 4,
                completed_condition_count: 2,
                required_condition_count: 2,
                baseline_condition_marker: "baseline_condition",
                condition_results: [
                  { condition_marker: "baseline_condition", status: "completed", accuracy: 0, seed_count: 0 },
                  { condition_marker: "candidate_condition_a", status: "completed", accuracy: 0, seed_count: 0 }
                ],
                raw_condition_results: rows
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const metrics = JSON.parse(await readFile(path.join(runDir, "metrics.json"), "utf8")) as {
      primary_metric_value: number;
      condition_summaries: Array<Record<string, any>>;
    };
    const candidate = metrics.condition_summaries.find((row) => row.condition_marker === "candidate_condition_a");
    expect(candidate).toMatchObject({
      seed_count: 2,
      correct_count: 28,
      total_count: 40,
      average_accuracy: 0.7
    });
    expect(candidate?.confidence_interval.sample_size).toBe(40);
    expect(metrics.primary_metric_value).toBeCloseTo(0.2, 6);
  });

  it("projects wrapped task-summary rows with numeric correct counts and nested baseline flags", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-wrapped-task-summary-metrics-"));
    process.chdir(root);
    const run = makeRun("run-wrapped-task-summary-metrics");
    run.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(runDir, { recursive: true });
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");
    await runContext.put(
      "run_brief.raw",
      [
        "# Research Brief",
        "## Constraints",
        "- Seed schedule: 1 and 2.",
        "## Minimum Experiment Plan",
        "- One control condition and one candidate condition with two benchmark tasks."
      ].join("\n")
    );

    const rows = [
      ["z_control_condition", true, 1, "benchmark_task_a", 5, 10],
      ["z_control_condition", true, 1, "benchmark_task_b", 4, 10],
      ["z_control_condition", true, 2, "benchmark_task_a", 5, 10],
      ["z_control_condition", true, 2, "benchmark_task_b", 4, 10],
      ["a_candidate_condition", false, 1, "benchmark_task_a", 8, 10],
      ["a_candidate_condition", false, 1, "benchmark_task_b", 7, 10],
      ["a_candidate_condition", false, 2, "benchmark_task_a", 8, 10],
      ["a_candidate_condition", false, 2, "benchmark_task_b", 7, 10]
    ].map(([condition_marker, is_baseline, seed, task, correct, evaluated_count]) => ({
      condition_marker,
      seed,
      seed_id: seed,
      task,
      status: "completed",
      accuracy: Number(correct) / Number(evaluated_count),
      correct,
      raw_evidence: {
        condition_marker,
        seed,
        seed_id: seed,
        task,
        total: null,
        raw_evidence: {
          is_baseline,
          task_metrics: {
            [String(task)]: {
              correct,
              evaluated_count,
              accuracy: Number(correct) / Number(evaluated_count)
            }
          }
        }
      }
    }));

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric_key: "accuracy_delta_vs_baseline",
                baseline_condition_marker: "a_candidate_condition",
                condition_results: [
                  { condition_marker: "z_control_condition", status: "completed", accuracy: 0, seed_count: 0 },
                  { condition_marker: "a_candidate_condition", status: "completed", accuracy: 0, seed_count: 0 }
                ],
                raw_condition_results: rows
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const metrics = JSON.parse(await readFile(path.join(runDir, "metrics.json"), "utf8")) as {
      baseline_condition_marker: string;
      primary_metric_value: number;
      condition_summaries: Array<Record<string, any>>;
    };
    const control = metrics.condition_summaries.find((row) => row.condition_marker === "z_control_condition");
    const candidate = metrics.condition_summaries.find((row) => row.condition_marker === "a_candidate_condition");
    expect(metrics.baseline_condition_marker).toBe("z_control_condition");
    expect(control).toMatchObject({ correct_count: 18, total_count: 40, average_accuracy: 0.45, seed_count: 2 });
    expect(candidate).toMatchObject({ correct_count: 30, total_count: 40, average_accuracy: 0.75, seed_count: 2 });
    expect(candidate?.accuracy_delta_vs_baseline).toBeCloseTo(0.3, 6);
    expect(metrics.primary_metric_value).toBeCloseTo(0.3, 6);
  });

  it("uses failed metrics payload as feedback when the command exits unsuccessfully", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-failed-command-metrics-"));
    process.chdir(root);
    const run = makeRun("run-failed-command-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(root, "study_failure.json"),
            JSON.stringify(
              {
                error: "TypeError: _build_model_load_kwargs() missing 1 required positional argument: 'local_files_only'",
                traceback: [
                  "Traceback (most recent call last):",
                  "  File \"experiment.py\", line 1, in <module>",
                  "TypeError: _build_model_load_kwargs() missing 1 required positional argument: 'local_files_only'"
                ].join("\n")
              },
              null,
              2
            ),
            "utf8"
          );
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 8,
                observed_condition_count: 31,
                missing_required_condition_markers: ["baseline_condition", "candidate_condition_a"],
                condition_results_path: path.join(root, "condition_results.json"),
                condition_results: [
                  { condition_id: "baseline_condition", status: "missing", reason: "ok_without_condition_records" },
                  { condition_id: "candidate_condition_a", status: "missing", reason: "ok_without_condition_records" }
                ],
                evidence: [
                  {
                    kind: "orchestration_exception",
                    message: "Could not resolve run-plan construction helper from the current module state.",
                    traceback: "RuntimeError: Could not resolve run-plan construction helper from the current module state."
                  }
                ],
                error: {
                  type: "AttributeError",
                  message: "dict object has no attribute baseline_run"
                },
                error_messages: [
                  "TypeError: SyntheticRunSpec.__init__() missing required argument output_dir"
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "error" as const,
            stdout: "verbose model loading log",
            stderr: "status=failed | completed_conditions=0",
            exit_code: 1,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics payload reports failed status");
    expect(result.error).toContain("completed_condition_count=0/8");
    expect(result.error).toContain("primary_metric_value=quality_delta:null");
    expect(result.error).toContain("condition_result_statuses=missing:2");
    expect(result.error).toContain("condition_result_reasons=ok_without_condition_records:2");
    expect(result.error).toContain("missing_required_condition_markers=baseline_condition,candidate_condition_a");
    expect(result.error).toContain("_build_model_load_kwargs()");
    expect(result.error).toContain("local_files_only");
    expect(result.error).toContain("metrics_evidence=orchestration_exception");
    expect(result.error).toContain("run-plan construction helper");
    expect(result.error).toContain("baseline_run");
    expect(result.error).toContain("metrics_error_messages=TypeError: SyntheticRunSpec.__init__()");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; stderr_excerpt?: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("completed_condition_count=0/8");
    expect(verifierReport.summary).toContain("primary_metric_value=quality_delta:null");
    expect(verifierReport.summary).toContain("condition_result_statuses=missing:2");
    expect(verifierReport.summary).toContain("metrics_error=AttributeError");
    expect(verifierReport.summary).toContain("metrics_error_messages=TypeError: SyntheticRunSpec.__init__()");
    expect(verifierReport.summary).toContain("metrics_evidence=orchestration_exception");
    expect(verifierReport.summary).toContain("run-plan construction helper");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(feedback?.summary).toContain("condition_result_reasons=ok_without_condition_records:2");
    expect(feedback?.summary).toContain("observed_condition_count=31");
    expect(feedback?.summary).toContain("_build_model_load_kwargs()");
    expect(feedback?.summary).toContain("baseline_run");
    expect(feedback?.summary).toContain("SyntheticRunSpec.__init__()");
    expect(feedback?.summary).toContain("run-plan construction helper");
  });

  it("suggests repairing evaluation normalization when no objective metric is produced", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-no-objective-metric-"));
    process.chdir(root);
    const run = makeRun("run-no-objective-metric");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation produced no objective metric",
                    raw_evidence: {
                      task_metrics: { task_a: { accuracy: null, evaluated: 0, requested: 12 } }
                    }
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation produced no objective metric",
                    raw_evidence: {
                      task_metrics: { task_a: { accuracy: null, evaluated: 0, requested: 12 } }
                    }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("evaluation produced no objective metric:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair evaluation data normalization");
    expect(verifierReport.suggested_next_action).toContain("answer_index");
    expect(verifierReport.suggested_next_action).toContain("correct_index");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("evaluated counts nonzero");
  });

  it("suggests repairing evaluation handoff when train-complete conditions are skipped before scoring", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-eval-handoff-skip-"));
    process.chdir(root);
    const run = makeRun("run-eval-handoff-skip");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation produced no objective metric",
                    raw_evidence: {
                      status: "completed_training",
                      evaluation_status: "skipped_not_completed",
                      task_metrics: {}
                    }
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation produced no objective metric",
                    raw_evidence: {
                      status: "completed_training",
                      evaluation_status: "skipped_not_completed",
                      task_metrics: {}
                    }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("condition_evaluation_statuses=skipped_not_completed:2");
    expect(result.error).toContain("condition_training_statuses=completed_training:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair condition evaluation handoff");
    expect(verifierReport.suggested_next_action).toContain("completed_training");
    expect(verifierReport.suggested_next_action).toContain("skipped_not_completed");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("evaluators must run after training");
  });

  it("suggests repairing evaluation handoff when train-complete rows are final evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-train-only-final-"));
    process.chdir(root);
    const run = makeRun("run-train-only-final");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "completed_training",
                    task_metrics: {}
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "completed_training",
                    task_metrics: {}
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("condition_result_statuses=completed_training:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair condition evaluation handoff");
    expect(verifierReport.suggested_next_action).toContain("train-only completion");
    expect(verifierReport.suggested_next_action).toContain("model/tokenizer");
    expect(verifierReport.suggested_next_action).not.toContain("Repair evaluation data normalization");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("task_metrics must be populated");
  });

  it("suggests repairing artifact reload when evaluation loads from the process cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-artifact-reload-"));
    process.chdir(root);
    const run = makeRun("run-artifact-reload");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation produced no objective metric",
                    raw_evidence: {
                      status: "evaluation_failed_runtime_load",
                      diagnostics: { error: "ValueError(\"Can't find 'runtime_artifact.json' at '.'\")" },
                      task_metrics: {}
                    }
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation produced no objective metric",
                    raw_evidence: {
                      status: "evaluation_failed_runtime_load",
                      diagnostics: { error: "ValueError(\"Can't find 'runtime_artifact.json' at '.'\")" },
                      task_metrics: {}
                    }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("condition_training_statuses=evaluation_failed_runtime_load:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair evaluation artifact reload");
    expect(verifierReport.suggested_next_action).toContain("process cwd");
    expect(verifierReport.suggested_next_action).toContain("explicit path");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("artifact-path diagnostics");
  });

  it("suggests repairing evaluation invocation bridge when evaluator state is omitted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-eval-invocation-"));
    process.chdir(root);
    const run = makeRun("run-eval-invocation");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_condition without required argument 'state'\")",
                    raw_evidence: {
                      error: "TypeError(\"Cannot call evaluate_condition without required argument 'state'\")"
                    }
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_condition without required argument 'state'\")",
                    raw_evidence: {
                      error: "TypeError(\"Cannot call evaluate_condition without required argument 'state'\")"
                    }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("evaluation call failed");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair the evaluation invocation bridge");
    expect(verifierReport.suggested_next_action).toContain("state");
    expect(verifierReport.suggested_next_action).toContain("condition_result");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("signature diagnostics");
  });

  it("suggests repairing invocation bridge when loaders or condition runners miss required bundles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-task-bundle-"));
    process.chdir(root);
    const run = makeRun("run-missing-task-bundle");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 3,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "TypeError(\"Cannot call run_single_condition without required argument 'task_bundle'\")"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "TypeError(\"Cannot call execute_condition without required argument 'task_data'\")"
                  },
                  {
                    condition_marker: "candidate_condition_b",
                    status: "failed",
                    reason: "RuntimeError('Experiment data bundle could not be materialized: load_training_examples: TypeError(\"Cannot call load_training_examples without required argument \'runtime\'\")')"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("required argument 'task_bundle'");
    expect(result.error).toContain("required argument 'task_data'");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair the experiment invocation bridge");
    expect(verifierReport.suggested_next_action).toContain("task_bundle");
    expect(verifierReport.suggested_next_action).toContain("task_data");
    expect(verifierReport.suggested_next_action).toContain("dataset_bundle");
    expect(verifierReport.suggested_next_action).toContain("runtime");
    expect(verifierReport.suggested_next_action).toContain("run_context");
    expect(verifierReport.suggested_next_action).toContain("data loader");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("eval_examples_by_task");
    expect(feedback?.suggested_next_action).toContain("runtime_context");
  });

  it("suggests repairing invocation bridge when evaluators miss eval sets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-eval-sets-"));
    process.chdir(root);
    const run = makeRun("run-missing-eval-sets");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_condition_outputs without required argument 'eval_sets'\")"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_condition_outputs without required argument 'eval_sets'\")"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("required argument 'eval_sets'");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair the experiment invocation bridge");
    expect(verifierReport.suggested_next_action).toContain("eval_sets");
    expect(verifierReport.suggested_next_action).toContain("eval_examples_by_task");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("benchmark_examples");
  });

  it("suggests repairing invocation bridge when evaluators miss runtime context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-runtime-context-"));
    process.chdir(root);
    const run = makeRun("run-missing-runtime-context");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_condition without required argument 'run'\")"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_condition without required argument 'run'\")"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("required argument 'run'");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair the experiment invocation bridge");
    expect(verifierReport.suggested_next_action).toContain("run");
    expect(verifierReport.suggested_next_action).toContain("runtime_context");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("condition_result");
  });

  it("suggests repairing invocation bridge when evaluators miss artifact paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-eval-paths-"));
    process.chdir(root);
    const run = makeRun("run-missing-eval-paths");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_completed_condition without required argument 'paths'\")"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_completed_condition without required argument 'paths'\")"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("required argument 'paths'");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair the experiment invocation bridge");
    expect(verifierReport.suggested_next_action).toContain("paths");
    expect(verifierReport.suggested_next_action).toContain("artifact_paths");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("output_paths");
  });

  it("suggests repairing runtime config defaults when Namespace attributes are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-runtime-default-"));
    process.chdir(root);
    const run = makeRun("run-missing-runtime-default");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "{'stage': 'condition_model_execution', 'error_type': 'AttributeError', 'message': \"'Namespace' object has no attribute 'allow_model_download'\"}"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "{'stage': 'condition_model_execution', 'error_type': 'AttributeError', 'message': \"'Namespace' object has no attribute 'allow_model_download'\"}"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Namespace");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair runtime config defaults");
    expect(verifierReport.suggested_next_action).toContain("allow_model_download");
    expect(verifierReport.suggested_next_action).toContain("local_files_only");
    expect(verifierReport.suggested_next_action).toContain("artifact_dir");
    expect(verifierReport.suggested_next_action).toContain("condition_output_dir");
    expect(verifierReport.suggested_next_action).toContain("paths");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("cache_dir");
    expect(feedback?.suggested_next_action).toContain("run_artifact_dir");
    expect(feedback?.suggested_next_action).toContain("runtime_paths");
  });

  it("suggests repairing runtime path aliases when Namespace artifact directories are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-runtime-path-alias-"));
    process.chdir(root);
    const run = makeRun("run-missing-runtime-path-alias");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "AttributeError(\"'Namespace' object has no attribute 'artifact_dir'\")"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "AttributeError(\"'Namespace' object has no attribute 'condition_output_dir'\")"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("artifact_dir");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair runtime config defaults");
    expect(verifierReport.suggested_next_action).toContain("artifact_dir");
    expect(verifierReport.suggested_next_action).toContain("condition_output_dir");
    expect(verifierReport.suggested_next_action).toContain("run_artifact_dir");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("path aliases");
  });

  it("suggests repairing runtime config helper capabilities when config methods are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-runtime-helper-"));
    process.chdir(root);
    const run = makeRun("run-missing-runtime-helper");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "'RunnerConfig' object has no attribute 'ensure_dirs'"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "'RunnerConfig' object has no attribute 'ensure_dirs'"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("RunnerConfig");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair runtime config defaults");
    expect(verifierReport.suggested_next_action).toContain("helper capabilities");
    expect(verifierReport.suggested_next_action).toContain("ensure_dirs");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("ensure_dirs");
  });

  it("suggests repairing runtime budget defaults when budget attributes are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-budget-default-"));
    process.chdir(root);
    const run = makeRun("run-missing-budget-default");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "AttributeError(\"'_AutoLabOSEntrypointBudget' object has no attribute 'seed'\")"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "AttributeError(\"'_AutoLabOSEntrypointBudget' object has no attribute 'seed'\")"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("_AutoLabOSEntrypointBudget");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair runtime config defaults");
    expect(verifierReport.suggested_next_action).toContain("seed");
    expect(verifierReport.suggested_next_action).toContain("max_train_examples");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("max_eval_examples_per_task");
  });

  it("suggests repairing data materialization when training examples are unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-train-examples-"));
    process.chdir(root);
    const run = makeRun("run-missing-train-examples");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "no training examples were provided for real condition execution"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "no training examples were provided for real condition execution"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("no training examples were provided");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair data materialization");
    expect(verifierReport.suggested_next_action).toContain("train_records");
    expect(verifierReport.suggested_next_action).toContain("data_access");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("evaluation examples");
  });

  it("suggests repairing training text normalization when loaded records normalize to zero usable texts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-zero-usable-train-texts-"));
    process.chdir(root);
    const run = makeRun("run-zero-usable-train-texts");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "data_access produced zero usable instruction/training texts",
                    raw_evidence: {
                      status: "failed",
                      training_status: "failed",
                      evaluation_status: "skipped_not_completed"
                    }
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "data_access_failure: zero usable training texts after normalization",
                    raw_evidence: {
                      status: "failed",
                      training_status: "failed",
                      evaluation_status: "skipped_not_completed"
                    }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("zero usable instruction/training texts");
    expect(result.error).toContain("zero usable training texts after normalization");
    expect(result.error).toContain("condition_evaluation_statuses=skipped_not_completed:2");
    expect(result.error).toContain("condition_training_statuses=failed:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair data materialization");
    expect(verifierReport.suggested_next_action).toContain("train_records");
    expect(verifierReport.suggested_next_action).toContain("messages");
    expect(verifierReport.suggested_next_action).not.toContain("Repair condition evaluation handoff");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("empty train set");
  });

  it("suggests repairing condition normalization when tuple condition records reach execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-condition-normalization-"));
    process.chdir(root);
    const run = makeRun("run-condition-normalization");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  { condition_marker: "condition", status: "failed", reason: "AttributeError(\"'tuple' object has no attribute 'rank'\")" },
                  { condition_marker: "condition", status: "failed", reason: "AttributeError(\"'tuple' object has no attribute 'rank'\")" }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("tuple");
    expect(result.error).toContain("rank");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair condition normalization");
    expect(verifierReport.suggested_next_action).toContain("tuple");
    expect(verifierReport.suggested_next_action).toContain("stable condition identifiers");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("mapping");
  });

  it("suggests repairing record shape normalization when mapping records are numerically indexed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-record-shape-indexing-"));
    process.chdir(root);
    const run = makeRun("run-record-shape-indexing");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  { condition_marker: "baseline_condition", status: "failed", failure_reason: "KeyError(0)" },
                  { condition_marker: "candidate_condition", status: "failed", failure_reason: "KeyError(0)" }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("KeyError(0)");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair record shape normalization");
    expect(verifierReport.suggested_next_action).toContain("mapping");
    expect(verifierReport.suggested_next_action).toContain("[0]");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("schema diagnostics");
  });

  it("suggests repairing evaluation record normalization when scalar records break label access", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-eval-scalar-record-normalization-"));
    process.chdir(root);
    const run = makeRun("run-eval-scalar-record-normalization");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                error:
                  "RuntimeError('Experiment data bundle could not be materialized: load_task_bundle: DataAccessError({\"message\":\"real dataset access/normalization failed\",\"missing_eval_tasks\":[\"task_alpha\"],\"diagnostics\":{\"tasks\":{\"task_alpha\":{\"error\":\"argument of type \\'int\\' is not iterable\"},\"task_beta\":{\"train_usable\":96,\"eval_usable\":64}},\"schema_failures\":[\"argument of type \\'int\\' is not iterable\"]}})')"
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("argument of type \\'int\\' is not iterable");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair evaluation record normalization");
    expect(verifierReport.suggested_next_action).toContain("field in record");
    expect(verifierReport.suggested_next_action).not.toContain("Repair data materialization");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("scalar evaluation records");
  });

  it("suggests preserving evaluator runtime handles when completed conditions cannot be scored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-eval-handles-"));
    process.chdir(root);
    const run = makeRun("run-missing-eval-handles");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "completed condition did not expose model/tokenizer for real evaluation"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "completed condition did not expose model/tokenizer for real evaluation"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("completed_condition_count=0/2");
    expect(result.error).toContain("completed condition did not expose model/tokenizer for real evaluation:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("preserve evaluator-required runtime handles");
    expect(verifierReport.suggested_next_action).toContain("reload the saved condition artifact");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback).toMatchObject({ status: "fail", stage: "metrics" });
    expect(feedback?.suggested_next_action).toContain("preserve evaluator-required runtime handles");
  });

  it("surfaces model download cache dependency failures when no metrics are written", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-command-dependency-failure-"));
    process.chdir(root);
    const run = makeRun("run-command-dependency-failure");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const runCommand = vi.fn(async () => ({
      status: "error" as const,
      stdout: "Generating benchmark_task_a split...",
      stderr: [
        "Loading tokenizer with from_pretrained",
        "xet retry failed: failed to lookup address information: Temporary failure in name resolution",
        "artifact model cache contains an incomplete blob"
      ].join("\n"),
      exit_code: 1,
      duration_ms: 10
    }));

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand,
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(result.error).toContain("exit_code=1");
    expect(result.error).toContain("metrics_written=false");
    expect(result.error).toContain("model_download_or_cache_failure=true");
    expect(result.error).toContain("Temporary failure in name resolution");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as {
      status: string;
      stage: string;
      summary: string;
      suggested_next_action?: string;
      metrics_path?: string;
      exit_code?: number;
    };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "command",
      exit_code: 1
    });
    expect(verifierReport.summary).toContain("metrics_written=false");
    expect(verifierReport.summary).toContain("model_download_or_cache_failure=true");
    expect(verifierReport.metrics_path).toContain("metrics.json");
    expect(verifierReport.suggested_next_action).toContain("standard Hugging Face cache");
    expect(verifierReport.suggested_next_action).toContain("avoid artifact-local model cache redownloads");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback).toMatchObject({
      status: "fail",
      stage: "command"
    });
    expect(feedback?.summary).toContain("metrics_written=false");
    expect(feedback?.summary).toContain("model_download_or_cache_failure=true");
  });
  it("prioritizes entrypoint failed metrics over warning-only stderr on command failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-entrypoint-failed-metrics-"));
    process.chdir(root);
    const run = makeRun("run-entrypoint-failed-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "entrypoint_failed",
                success: false,
                completed_condition_count: 0,
                required_condition_count: 12,
                completed_run_count: 0,
                required_run_count: 36,
                error_type: "RuntimeError",
                error_message: "Missing run-plan execution helper in experiment scaffold.",
                traceback: "RuntimeError: Missing run-plan execution helper in experiment scaffold.",
                condition_results: [
                  {
                    completed: false,
                    condition: { marker: "baseline_condition" },
                    train_result: { status: "failed", failure_reason: "No training examples were provided" }
                  },
                  {
                    completed: false,
                    status: "failed",
                    condition: { marker: "candidate_condition" },
                    failure: { message: "No training examples were provided" }
                  }
                ],
                raw_condition_results: [
                  {
                    status: "failed",
                    condition_marker: "candidate_condition_b",
                    failure_stage: "evaluation",
                    failure_reason: "no objective evaluation callable was available"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "error" as const,
            stdout: "",
            stderr: "`torch_dtype` is deprecated! Use `dtype` instead!\nLoading weights: 100%|done|",
            exit_code: 1,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics payload reports failed status");
    expect(result.error).toContain("Missing run-plan execution helper");
    expect(result.error).toContain("completed_condition_count=0/12");
    expect(result.error).toContain("condition_result_statuses=failed:3");
    expect(result.error).toContain("condition_result_reasons=No training examples were provided:2");
    expect(result.error).toContain("no objective evaluation callable was available:1");
    expect(result.error).toContain("condition_result_samples=baseline_condition,status=failed,reason=No training examples were provided");
    expect(result.error).not.toContain("unlabeled_condition,status=failed");
    expect(result.error).not.toContain("torch_dtype");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Missing run-plan execution helper");
    expect(verifierReport.summary).toContain("no objective evaluation callable was available:1");
    expect(verifierReport.summary).toContain("condition_result_samples=baseline_condition,status=failed,reason=No training examples were provided");
    expect(verifierReport.summary).not.toContain("unlabeled_condition,status=failed");
    expect(verifierReport.summary).not.toContain("torch_dtype");
  });

  it("includes data access preview diagnostics when failed metrics hide empty training data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-data-access-preview-"));
    process.chdir(root);
    const run = makeRun("run-data-access-preview");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "public_experiment");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(publicDir, "data_access_preview.json"),
            JSON.stringify(
              {
                train_count: 0,
                eval_counts: { benchmark_task_a: 2 },
                diagnostics: {
                  schema_errors: ["No usable instruction/training texts normalized from loaded records."],
                  tasks: {
                    benchmark_task_a: {
                      normalized_train_count: 0,
                      normalized_eval_count: 2
                    }
                  }
                },
                sample_train: null
              },
              null,
              2
            ),
            "utf8"
          );
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                raw_condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    error_type: "IndexError",
                    failure_reason: "list index out of range"
                  },
                  {
                    condition_marker: "candidate_condition_a",
                    status: "failed",
                    error_type: "IndexError",
                    failure_reason: "list index out of range"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "Loading weights: 100%|done|",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics payload reports failed status");
    expect(result.error).toContain("completed_condition_count=0/2");
    expect(result.error).toContain("condition_result_reasons=list index out of range:2");
    expect(result.error).toContain("data_access_preview.json");
    expect(result.error).toContain("train_count=0");
    expect(result.error).toContain("zero usable instruction/training texts");
    expect(result.error).toContain("schema_errors=No usable instruction/training texts normalized from loaded records.");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("data_access_preview.json");
    expect(verifierReport.suggested_next_action).toContain("Repair data materialization before retrying");
  });

  it("blocks canonical skeleton-only Python runners before executing stale metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-skeleton-preflight-"));
    process.chdir(root);
    const run = makeRun("run-skeleton-preflight");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    const scriptPath = path.join(root, "generated_runner.py");
    await writeFile(
      scriptPath,
      [
        "# AUTOLABOS CANONICAL SKELETON",
        "# BEGIN AUTOLABOS SECTION runner_contract :: Runner imports and execution contract",
        "import argparse",
        "from dataclasses import dataclass",
        "",
        "@dataclass",
        "class RuntimeConfig:",
        "    output_dir: str",
        "",
        "def parse_args(argv=None):",
        "    return argparse.Namespace(output_dir='outputs')",
        "# END AUTOLABOS SECTION runner_contract",
        "",
        "# BEGIN AUTOLABOS SECTION runner_entrypoint :: CLI entrypoint and final handoff",
        "# END AUTOLABOS SECTION runner_entrypoint",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "metrics.json"),
      JSON.stringify(
        {
          status: "completed",
          completed_condition_count: 2,
          required_condition_count: 2,
          quality_delta: 0.2
        },
        null,
        2
      ),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 " + JSON.stringify(scriptPath));
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      aci: {
        runCommand: async () => {
          throw new Error("skeleton preflight should block before command execution");
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("canonical skeleton");
    expect(result.error).toContain("stale metrics");
    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "preflight_test" });
    expect(verifierReport.summary).toContain("canonical skeleton");
    expect(verifierReport.suggested_next_action).toContain("runnable implementation");
  });

  it("blocks partial canonical skeleton runners with empty evaluation metrics or entrypoint sections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-partial-skeleton-preflight-"));
    process.chdir(root);
    const run = makeRun("run-partial-skeleton-preflight");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    const scriptPath = path.join(root, "generated_runner.py");
    await writeFile(
      scriptPath,
      [
        "# AUTOLABOS CANONICAL SKELETON",
        "import sys",
        "# BEGIN AUTOLABOS SECTION runner_contract :: Runner imports and execution contract",
        "def build_plan():",
        "    return ['baseline_condition', 'candidate_condition_a']",
        "# END AUTOLABOS SECTION runner_contract",
        "",
        "# BEGIN AUTOLABOS SECTION runner_evaluation :: Task evaluation and raw evidence capture",
        "# END AUTOLABOS SECTION runner_evaluation",
        "",
        "# BEGIN AUTOLABOS SECTION runner_metrics :: Metric aggregation and failure-safe payload",
        "# END AUTOLABOS SECTION runner_metrics",
        "",
        "# BEGIN AUTOLABOS SECTION runner_entrypoint :: CLI entrypoint and final handoff",
        "def main():",
        "    return 0",
        "if __name__ == '__main__':",
        "    raise SystemExit(main())",
        "# END AUTOLABOS SECTION runner_entrypoint",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "metrics.json"),
      JSON.stringify(
        {
          status: "completed",
          completed_condition_count: 2,
          required_condition_count: 2,
          quality_delta: 0.2
        },
        null,
        2
      ),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 " + JSON.stringify(scriptPath));
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      aci: {
        runCommand: async () => {
          throw new Error("partial skeleton preflight should block before command execution");
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("canonical skeleton");
    expect(result.error).toContain("stale metrics");
  });

  it("preserves rejected metrics when a rejected rerun writes failed metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-restore-rejected-metrics-"));
    process.chdir(root);
    const run = makeRun("run-restore-rejected-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const previousMetrics = {
      status: "completed",
      accuracy_delta_vs_baseline: 0.04,
      completed_condition_count: 2,
      required_condition_count: 2,
      condition_results: [
        { condition_marker: "baseline_condition", status: "completed", average_accuracy: 0.5 },
        { condition_marker: "candidate_condition_a", status: "completed", average_accuracy: 0.54 }
      ]
    };
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify(previousMetrics, null, 2), "utf8");

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "node generated_runner.js");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                completed_condition_count: 0,
                required_condition_count: 2,
                error: "No locked conditions are available to select from."
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 5 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("No locked conditions are available");
    const rejectedMetrics = JSON.parse(await readFile(path.join(runDir, "metrics.json"), "utf8"));
    expect(rejectedMetrics).toMatchObject({
      status: "failed",
      completed_condition_count: 0,
      required_condition_count: 2,
      error: "No locked conditions are available to select from."
    });
    await expect(runContext.get("run_experiments.restored_previous_metrics_after_failure")).resolves.toBeUndefined();
  });

  it("rejects zero-exit runtime tracebacks instead of recovering stale public metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-zero-exit-stale-public-metrics-"));
    process.chdir(root);
    const run = makeRun("run-zero-exit-stale-public-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "outputs", "neutral-study", "experiment");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const previousMetrics = {
      status: "completed",
      primary_metric_key: "quality_delta",
      quality_delta: 0.04,
      completed_condition_count: 2,
      required_condition_count: 2,
      condition_results: [
        { condition_marker: "baseline_condition", status: "completed", average_accuracy: 0.5 },
        { condition_marker: "candidate_condition_a", status: "completed", average_accuracy: 0.54 }
      ]
    };
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify(previousMetrics, null, 2), "utf8");
    await writeFile(
      path.join(publicDir, "metrics.json"),
      JSON.stringify(
        {
          status: "completed",
          primary_metric_key: "quality_delta",
          quality_delta: 0,
          completed_condition_count: 2,
          required_condition_count: 2,
          condition_results: [
            { condition_marker: "baseline_condition", status: "completed", average_accuracy: 0.5 },
            { condition_marker: "candidate_condition_a", status: "completed", average_accuracy: 0.5 }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 generated_runner.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: [
            "Experiment execution failed before normal finalization.",
            "Traceback (most recent call last):",
            "TypeError: _as_path() missing 1 required positional argument: fallback"
          ].join("\n"),
          exit_code: 0,
          duration_ms: 5
        }),
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("fatal stderr despite zero exit status");
    expect(result.error).toContain("_as_path()");
    const restoredMetrics = JSON.parse(await readFile(path.join(runDir, "metrics.json"), "utf8"));
    expect(restoredMetrics).toMatchObject(previousMetrics);
    await expect(runContext.get("run_experiments.recovered_public_metrics_path")).resolves.toBeUndefined();
  });

  it("surfaces string metrics error before stale failure artifact evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-string-metrics-error-"));
    process.chdir(root);
    const run = makeRun("run-string-metrics-error");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(root, "study_failure.json"),
            JSON.stringify({ error: "old stale failure" }, null, 2),
            "utf8"
          );
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                error: "write_experiment_artifacts() missing 4 required positional arguments"
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "", exit_code: 1, duration_ms: 5 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("write_experiment_artifacts()");
    expect(result.error).toContain("metrics_error=write_experiment_artifacts()");
    expect(result.error).toContain("old stale failure");
  });

  it("archives preexisting failure artifacts before running a fresh experiment command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-clear-stale-failure-artifact-"));
    process.chdir(root);
    const run = makeRun("run-clear-stale-failure-artifact");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "public");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(path.join(root, "study_failure.json"), JSON.stringify({ error: "old stale failure" }), "utf8");
    const nestedFailurePath = path.join(root, "condition_artifacts", "condition_a", "seed_1", "failure.json");
    await mkdir(path.dirname(nestedFailurePath), { recursive: true });
    await writeFile(nestedFailurePath, JSON.stringify({ error: "old nested stale failure" }), "utf8");
    const rawEvidencePath = path.join(root, "artifacts", "raw_evaluation_evidence.jsonl");
    await mkdir(path.dirname(rawEvidencePath), { recursive: true });
    await writeFile(rawEvidencePath, JSON.stringify({ status: "condition_evaluation_summary", schema_diagnostics: ["old stale diagnostic"] }) + "\n", "utf8");
    const publicRawEvidencePath = path.join(publicDir, "artifacts", "raw_evaluation_evidence.jsonl");
    await mkdir(path.dirname(publicRawEvidencePath), { recursive: true });
    await writeFile(publicRawEvidencePath, JSON.stringify({ status: "condition_evaluation_summary", schema_diagnostics: ["old public stale diagnostic"] }) + "\n", "utf8");

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                completed_run_count: 0,
                completed_condition_count: 0,
                selected_model: null,
                per_seed_rows: [
                  {
                    condition_marker: "baseline_condition",
                    seed: 42,
                    status: "failed",
                    failure_reason: "missing_row_for_required_condition_seed"
                  }
                ],
                error: "fresh run produced no executable rows"
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "", exit_code: 1, duration_ms: 5 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("fresh run produced no executable rows");
    expect(result.error).toContain("selected_model=null");
    expect(result.error).toContain("missing_row_for_required_condition_seed");
    expect(result.error).not.toContain("old stale failure");
    expect(result.error).not.toContain("old nested stale failure");
    await expect(readFile(nestedFailurePath, "utf8")).rejects.toThrow();
    const backups = await runContext.get<string[]>("run_experiments.previous_failure_artifact_backups");
    expect(backups).toHaveLength(2);
    expect(backups?.some((backup) => backup.includes("preexisting_study_failure"))).toBe(true);
    expect(backups?.some((backup) => backup.includes("preexisting_nested_failure"))).toBe(true);
    await expect(readFile(rawEvidencePath, "utf8")).rejects.toThrow();
    await expect(readFile(publicRawEvidencePath, "utf8")).rejects.toThrow();
    const evidenceBackups = await runContext.get<string[]>("run_experiments.previous_evidence_artifact_backups");
    expect(evidenceBackups).toHaveLength(2);
    expect(evidenceBackups?.every((backup) => backup.includes("preexisting_artifacts_raw_evaluation_evidence"))).toBe(true);
    const backedUpEvidence = await Promise.all(evidenceBackups!.map((backup) => readFile(backup, "utf8")));
    expect(backedUpEvidence.join("\n")).toContain("old stale diagnostic");
    expect(backedUpEvidence.join("\n")).toContain("old public stale diagnostic");
  });

  it("recovers completed public bundle metrics over failed run metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-recover-public-completed-metrics-"));
    process.chdir(root);
    const run = makeRun("run-recover-public-completed-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "public");
    const metricsPath = path.join(runDir, "metrics.json");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await mkdir(path.dirname(metricsPath), { recursive: true });
          await writeFile(
            metricsPath,
            JSON.stringify(
              {
                status: "failed",
                primary_metric_key: "accuracy",
                accuracy: 0.4,
                error: "stale failed run metrics"
              },
              null,
              2
            ),
            "utf8"
          );
          await writeFile(
            path.join(publicDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                primary_metric_key: "accuracy",
                accuracy: 0.95,
                completed_condition_count: 2,
                required_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "ok" as const, stdout: "completed", stderr: "", exit_code: 0, duration_ms: 5 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const recoveredMetrics = JSON.parse(await readFile(metricsPath, "utf8")) as { status?: string; accuracy?: number };
    expect(recoveredMetrics.status).toBe("completed");
    expect(recoveredMetrics.accuracy).toBe(0.95);
    await expect(runContext.get("run_experiments.recovered_public_metrics_path")).resolves.toBe(path.join(publicDir, "metrics.json"));
  });

  it("repairs runtime-resolved metrics payload builders before run_experiments execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-runtime-metrics-repair-"));
    process.chdir(root);
    const run = makeRun("run-runtime-metrics-repair");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "import inspect",
        "from typing import Any, Optional, Sequence",
        "",
        "class Config:",
        "    dry_run = False",
        "",
        "def build_metrics_payload(*, config, run_context, data_summary, condition_results):",
        "    return {'condition_count': len(condition_results)}",
        "",
        "def _resolve_runtime_helper(candidate_names: Sequence[str]) -> Optional[Any]:",
        "    for candidate_name in candidate_names:",
        "        helper = globals().get(candidate_name)",
        "        if callable(helper):",
        "            return helper",
        "    return None",
        "",
        "def _filter_kwargs_for_helper(helper: Any, kwargs: dict[str, Any]) -> dict[str, Any]:",
        "    signature = inspect.signature(helper)",
        "    parameters = signature.parameters",
        "    accepts_var_keyword = any(parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters.values())",
        "    if accepts_var_keyword:",
        "        return kwargs",
        "    return {key: value for key, value in kwargs.items() if key in parameters}",
        "",
        "def _call_helper_variants(helper: Any, helper_name: str, call_variants):",
        "    for positional_args, keyword_args in call_variants:",
        "        filtered_keyword_args = _filter_kwargs_for_helper(helper, dict(keyword_args))",
        "        return helper(*positional_args, **filtered_keyword_args)",
        "    raise RuntimeError('no variant')",
        "",
        "def main() -> int:",
        "    config = Config()",
        "    raw_result = {'condition_results': [{'status': 'completed'}], 'run_context': {}, 'data_summary': {}}",
        "    normalized_result = dict(raw_result)",
        "    metrics_builder = _resolve_runtime_helper(('build_metrics_payload',))",
        "    _call_helper_variants(metrics_builder, 'build_metrics_payload', (((), {",
        "        'config': config,",
        "        'study_result': raw_result,",
        "        'result': raw_result,",
        "        'study_result_dict': normalized_result,",
        "    }),))",
        "    return 0",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", `python3 ${JSON.stringify(scriptPath)}`);
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    let repairedBeforeExecution = false;
    const eventStream = new InMemoryEventStream();
    const node = createRunExperimentsNode({
      config: {
        experiments: {
          network_policy: "declared",
          network_purpose: "model_download"
        }
      } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream,
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async (command: string) => {
          expect(command).toContain("AUTOLABOS_ALLOW_MODEL_DOWNLOAD=1 ");
          const repairedSource = await readFile(scriptPath, "utf8");
          repairedBeforeExecution = repairedSource.includes("_autolabos_main_metrics_payload_builder_call_marker");
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric: {
                  name: "accuracy_delta_vs_baseline",
                  value: 0.02,
                  target: 0.01,
                  met: true
                },
                condition_results: [
                  {
                    condition_id: "baseline",
                    condition_type: "baseline",
                    status: "completed",
                    accuracy: 0.4
                  },
                  {
                    condition_id: "candidate",
                    condition_type: "candidate",
                    status: "completed",
                    accuracy: 0.42
                  }
                ],
                completed_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });

    expect(repairedBeforeExecution).toBe(true);
    expect(await readFile(scriptPath, "utf8")).toContain("_autolabos_original_build_metrics_payload = build_metrics_payload");
    expect(
      eventStream.history().some((event) =>
        String(event.payload.text || "").includes("Wrapped generated build_metrics_payload calls")
      )
    ).toBe(true);
  });

  it("repairs model bundle resolver aliases before run_experiments execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-model-bundle-resolver-repair-"));
    process.chdir(root);
    const run = makeRun("run-model-bundle-resolver-repair");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "import inspect",
        "",
        "def _call_setup_helper(stage, names, evidence, **kwargs):",
        "    for name in names:",
        "        helper = globals().get(name)",
        "        if callable(helper):",
        "            signature = inspect.signature(helper)",
        "            accepted = {key: value for key, value in kwargs.items() if key in signature.parameters}",
        "            return helper(**accepted)",
        "    raise RuntimeError('no usable helper for ' + stage)",
        "",
        "def resolve_preferred_fallback_model_bundle(dependency_preflight=None, access_policy=None):",
        "    return {'model': 'base-model', 'tokenizer': 'tokenizer'}",
        "",
        "def run_preflight_setup():",
        "    return _call_setup_helper(",
        "        'model_tokenizer',",
        "        ('load_preferred_fallback_model_bundle', 'load_model_bundle_with_fallback', 'load_base_model_bundle', 'resolve_model_bundle', 'load_model_and_tokenizer'),",
        "        {},",
        "        model_candidates=['candidate-a'],",
        "        requested_model='candidate-a',",
        "    )",
        "",
        "def main():",
        "    return 0 if run_preflight_setup().get('model') == 'base-model' else 1",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 " + JSON.stringify(scriptPath));
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    let repairedBeforeExecution = false;
    const eventStream = new InMemoryEventStream();
    const node = createRunExperimentsNode({
      config: {
        experiments: {
          timeout_sec: 43200,
          network_policy: "declared",
          network_purpose: "model_download"
        }
      } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream,
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          const repairedSource = await readFile(scriptPath, "utf8");
          repairedBeforeExecution =
            repairedSource.includes("def load_model_and_tokenizer(model_name=None") &&
            repairedSource.includes("resolve_preferred_fallback_model_bundle");
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric: {
                  name: "accuracy_delta_vs_baseline",
                  value: 0.02,
                  target: 0.01,
                  met: true
                },
                condition_results: [
                  { condition_id: "baseline_condition", status: "completed", accuracy: 0.4 },
                  { condition_id: "candidate_condition_a", status: "completed", accuracy: 0.42 }
                ],
                completed_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });

    expect(repairedBeforeExecution).toBe(true);
    expect(
      eventStream.history().some((event) =>
        String(event.payload.text || "").includes("Added model/tokenizer loader alias to experiment.py before run_experiments execution.")
      )
    ).toBe(true);
  });

  it("forwards timeout flags through shell wrappers that pass through argv", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-shell-timeout-"));
    process.chdir(root);
    const run = makeRun("run-shell-wrapper-timeout");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "run_condition_sweep_experiment.py");
    const wrapperPath = path.join(root, "run_command.sh");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "from pathlib import Path",
        "",
        "def parse_args(argv=None):",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--metrics-path', default='metrics.json')",
        "    parser.add_argument('--timeout-sec', dest='timeout_sec', type=int, default=0)",
        "    return parser.parse_args(argv)",
        "",
        "if __name__ == '__main__':",
        "    args = parse_args()",
        "    Path(args.metrics_path).write_text('{\"status\":\"completed\",\"success\":true}', encoding='utf8')",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "SCRIPT_DIR=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"",
        "RUNNER=\"${SCRIPT_DIR}/run_condition_sweep_experiment.py\"",
        "exec \"${PYTHON_BIN:-python3}\" \"$RUNNER\" \"$@\"",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", `bash ${JSON.stringify(wrapperPath)}`);
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: { experiments: { timeout_sec: 43200 } } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async (command: string) => {
          expect(command).toContain("--timeout-sec 43200");
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify({
              status: "completed",
              success: true,
              primary_metric: { name: "accuracy_delta_vs_baseline", value: 0.02, target: 0.01, met: true },
              condition_results: [{ condition_id: "baseline_condition", status: "completed", accuracy: 0.4 }],
              completed_condition_count: 1
            }),
            "utf8"
          );
          return { status: "ok" as const, stdout: "done", stderr: "", exit_code: 0, duration_ms: 1 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });
  });
  it("repairs entrypoint argv dispatch before run_experiments execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-entrypoint-argv-repair-"));
    process.chdir(root);
    const run = makeRun("run-entrypoint-argv-repair");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "import inspect",
        "import json",
        "import sys",
        "from pathlib import Path",
        "",
        "def build_arg_parser():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--metrics-path', required=True)",
        "    return parser",
        "",
        "def parse_args(argv=None):",
        "    return build_arg_parser().parse_args(argv)",
        "",
        "def _autolabos_entrypoint_accepts(func, positional, keywords):",
        "    try:",
        "        inspect.signature(func).bind(*positional, **keywords)",
        "        return True",
        "    except ValueError:",
        "        return True",
        "    except TypeError:",
        "        return False",
        "",
        "def _autolabos_entrypoint_call(func, attempts, stage_name):",
        "    for positional, keywords in attempts:",
        "        if _autolabos_entrypoint_accepts(func, positional, keywords):",
        "            return func(*positional, **keywords)",
        "    raise RuntimeError(f'Callable for {stage_name} does not accept any supported entrypoint signature: {func!r}')",
        "",
        "def _autolabos_entrypoint_parse_args(argv):",
        "    func = globals().get('parse_args')",
        "    return _autolabos_entrypoint_call(func, ((tuple(argv), {}), (list(argv), {})), 'CLI argument parsing')",
        "",
        "def main(argv=None):",
        "    argv = tuple(sys.argv[1:] if argv is None else argv)",
        "    args = _autolabos_entrypoint_parse_args(argv)",
        "    Path(args.metrics_path).write_text(json.dumps({'status': 'completed'}), encoding='utf-8')",
        "    return 0",
        "",
        "if __name__ == '__main__':",
        "    raise SystemExit(main())",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 " + JSON.stringify(scriptPath));
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    let repairedBeforeExecution = false;
    const eventStream = new InMemoryEventStream();
    const node = createRunExperimentsNode({
      config: {
        experiments: {
          timeout_sec: 43200,
          network_policy: "declared",
          network_purpose: "model_download"
        }
      } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream,
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          const repairedSource = await readFile(scriptPath, "utf8");
          repairedBeforeExecution = repairedSource.includes("(((tuple(argv),), {})");
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric: {
                  name: "accuracy_delta_vs_baseline",
                  value: 0.02,
                  target: 0.01,
                  met: true
                },
                condition_results: [
                  { condition_id: "baseline_condition", status: "completed", accuracy: 0.4 },
                  { condition_id: "candidate_condition_a", status: "completed", accuracy: 0.42 }
                ],
                completed_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });

    expect(repairedBeforeExecution).toBe(true);
    expect(
      eventStream.history().some((event) =>
        String(event.payload.text || "").includes("Repaired entrypoint CLI argv dispatch in experiment.py before run_experiments execution.")
      )
    ).toBe(true);
  });

  it("repairs public study top-level runner aliases before run_experiments execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-public-runner-alias-repair-"));
    process.chdir(root);
    const run = makeRun("run-public-runner-alias-repair");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "from typing import Any, Optional, Sequence",
        "",
        "def build_arg_parser():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--timeout-sec', type=int, default=0)",
        "    return parser",
        "",
        "def _resolve_global_callable(candidate_names: Sequence[str]) -> Optional[Any]:",
        "    for candidate_name in candidate_names:",
        "        candidate = globals().get(candidate_name)",
        "        if callable(candidate):",
        "            return candidate",
        "    return None",
        "",
        "def _call_with_supported_kwargs(callable_obj, *args, **kwargs):",
        "    return callable_obj(*args, **kwargs)",
        "",
        "def prepare_runtime_context(args=None, **kwargs):",
        "    return {'args': args}",
        "",
        "def build_experiment_schedule(runtime=None, runtime_context=None, run_output_dir=None, **kwargs):",
        "    return [{'condition_id': 'baseline_condition'}]",
        "",
        "def execute_run_schedule(planned_runs=None, runtime_context=None, **kwargs):",
        "    return [{'condition_id': 'baseline_condition', 'status': 'completed'}]",
        "",
        "def main() -> int:",
        "    runner = _resolve_global_callable(('run_experiment', 'execute_experiment', 'run_study'))",
        "    if not callable(runner):",
        "        raise RuntimeError('No experiment runner callable was found in the script globals.')",
        "    return 0",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", `python3 ${JSON.stringify(scriptPath)}`);
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    let repairedBeforeExecution = false;
    const eventStream = new InMemoryEventStream();
    const node = createRunExperimentsNode({
      config: {
        experiments: {
          timeout_sec: 43200,
          network_policy: "declared",
          network_purpose: "model_download"
        }
      } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream,
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async (command: string) => {
          expect(command).toContain("AUTOLABOS_ALLOW_MODEL_DOWNLOAD=1 ");
          expect(command).toContain("--timeout-sec 43200");
          const repairedSource = await readFile(scriptPath, "utf8");
          repairedBeforeExecution =
            repairedSource.includes("_autolabos_public_study_top_level_runner_alias_marker") &&
            repairedSource.includes("def run_experiment(*positional, **keyword):");
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric: {
                  name: "accuracy_delta_vs_baseline",
                  value: 0.02,
                  target: 0.01,
                  met: true
                },
                condition_results: [
                  {
                    condition_id: "baseline_condition",
                    condition_type: "baseline",
                    status: "completed",
                    accuracy: 0.4
                  },
                  {
                    condition_id: "candidate_condition_a",
                    condition_type: "candidate",
                    status: "completed",
                    accuracy: 0.42
                  }
                ],
                completed_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });

    expect(repairedBeforeExecution).toBe(true);
    expect(await readFile(scriptPath, "utf8")).toContain(
      "_autolabos_public_study_top_level_runner_alias_marker"
    );
    expect(
      eventStream.history().some((event) =>
        String(event.payload.text || "").includes(
          "Added public study top-level runner alias in experiment.py before run_experiments execution."
        )
      )
    ).toBe(true);
  });

  it("repairs high-level workload context aliases before run_experiments execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-workload-context-alias-repair-"));
    process.chdir(root);
    const run = makeRun("run-workload-context-alias-repair");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    const markerExpression = '"candidate_condition_a"';
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "import inspect",
        "from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple",
        "",
        "def build_arg_parser():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--metrics-path')",
        "    parser.add_argument('--timeout-sec', type=int, default=0)",
        "    return parser",
        "",
        "def execute_planned_runs(args: argparse.Namespace, context):",
        "    return {'status': 'completed', 'context': context}",
        "",
        "def _safe_int(value: Any, default=None):",
        "    return default if value is None else int(value)",
        "",
        "def _safe_float(value: Any, default=None):",
        "    return default if value is None else float(value)",
        "",
        "def _parse_condition_marker(marker: str):",
        "    return {'rank': 8, 'parameter_y': 0.05, 'condition_marker': marker}",
        "",
        `PLANNED_CONDITIONS = [{'condition_marker': ${markerExpression}}]`,
        "SEED_SCHEDULE = [42]",
        "",
        "def _global_value(*names, default=None):",
        "    for name in names:",
        "        if name in globals():",
        "            return globals()[name]",
        "    return default",
        "",
        "def get_planned_run_schedule() -> List[Dict[str, Any]]:",
        "    explicit_rows = _global_value('PLANNED_RUNS', default=None)",
        "    condition_rows = _global_value('PLANNED_CONDITIONS', default=None)",
        "    seeds = _global_value('SEED_SCHEDULE', default=[42])",
        "    schedule: List[Dict[str, Any]] = []",
        "    if isinstance(condition_rows, Sequence) and condition_rows:",
        "        for condition in condition_rows:",
        "            if not isinstance(condition, Mapping):",
        "                continue",
        "            rank = _safe_int(condition.get(\"rank\", condition.get(\"condition_parameter_x\", condition.get(\"r\"))), default=None)",
        "            parameter_y = _safe_float(condition.get(\"parameter_y\", condition.get(\"condition_parameter_y\")), default=None)",
        "            marker = condition.get(\"condition_marker\") or condition.get(\"marker\")",
        "            if marker is None and rank is not None and parameter_y is not None:",
        "                marker = 'candidate'",
        "            for seed in seeds:",
        "                schedule.append({'condition_marker': str(marker), 'rank': rank, 'parameter_y': parameter_y, 'seed': int(seed)})",
        "    return schedule",
        "",
        "def _signature_compatible_kwargs(fn: Any, kwargs: Mapping[str, Any]) -> Optional[dict[str, Any]]:",
        "    signature = inspect.signature(fn)",
        "    filtered = {k: v for k, v in kwargs.items() if k in signature.parameters}",
        "    for name, parameter in signature.parameters.items():",
        "        if parameter.default is inspect._empty and name not in filtered:",
        "            return None",
        "    return filtered",
        "",
        "def _try_call_callable(fn: Any, kwarg_options: Sequence[Mapping[str, Any]]) -> Tuple[bool, Any, Optional[BaseException]]:",
        "    last_error = None",
        "    for kwargs in kwarg_options:",
        "        compatible = _signature_compatible_kwargs(fn, kwargs)",
        "        if compatible is None:",
        "            continue",
        "        try:",
        "            return True, fn(**compatible), None",
        "        except Exception as exc:",
        "            last_error = exc",
        "    return False, None, last_error",
        "",
        "def _run_workload_from_previous_sections(args, runtime_context, plan_metadata, backend, resolved_model):",
        "    high_level_fn = execute_planned_runs",
        "    ok, value, error = _try_call_callable(",
        "        high_level_fn,",
        "        [",
        "            {",
        "                \"args\": args,",
        "                \"runtime_context\": runtime_context,",
        "                \"planned_runs\": plan_metadata.get(\"planned_runs\"),",
        "                \"plan_metadata\": plan_metadata,",
        "                \"backend\": backend,",
        "                \"resolved_model\": resolved_model,",
        "            },",
        "            {\"args\": args, \"runtime_context\": runtime_context},",
        "            {\"runtime_context\": runtime_context, \"plan_metadata\": plan_metadata},",
        "        ],",
        "    )",
        "    if ok:",
        "        return value",
        "    raise RuntimeError(f\"High-level execution callable {high_level_fn.__name__} failed: {error}\")",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", `python3 ${JSON.stringify(scriptPath)}`);
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    let repairedBeforeExecution = false;
    let recoveredScheduleParametersBeforeExecution = false;
    const eventStream = new InMemoryEventStream();
    const node = createRunExperimentsNode({
      config: {
        experiments: {
          timeout_sec: 43200,
          network_policy: "declared",
          network_purpose: "model_download"
        }
      } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream,
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          const repairedSource = await readFile(scriptPath, "utf8");
          repairedBeforeExecution = repairedSource.includes('"context": runtime_context');
          recoveredScheduleParametersBeforeExecution = repairedSource.includes(
            "_autolabos_condition_schedule_marker_parameter_surface"
          );
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric: {
                  name: "accuracy_delta_vs_baseline",
                  value: 0.02,
                  target: 0.01,
                  met: true
                },
                condition_results: [
                  { condition_id: "baseline_condition", status: "completed", accuracy: 0.4 },
                  { condition_id: "candidate_condition_a", status: "completed", accuracy: 0.42 }
                ],
                completed_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });

    expect(repairedBeforeExecution).toBe(true);
    expect(recoveredScheduleParametersBeforeExecution).toBe(true);
    expect(await readFile(scriptPath, "utf8")).toContain('"context": runtime_context');
    expect(await readFile(scriptPath, "utf8")).toContain(
      "_autolabos_condition_schedule_marker_parameter_surface"
    );
    expect(
      eventStream.history().some((event) =>
        String(event.payload.text || "").includes(
          "Added context alias to high-level workload invocation in experiment.py"
        )
      )
    ).toBe(true);
  });

  it("does not let P6 harness timeout override runner timeout flags", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-timeout-env-separation-"));
    process.chdir(root);
    const run = makeRun("run-timeout-env-separation");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "def main(argv=None):",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument(\"--metrics-path\", default=\"metrics.json\")",
        "    parser.add_argument(\"--timeout-sec\", type=int, default=0)",
        "    return parser.parse_args(argv)",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 " + JSON.stringify(scriptPath));
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const originalP6Timeout = process.env.AUTOLABOS_P6_NEXT_TIMEOUT_SEC;
    process.env.AUTOLABOS_P6_NEXT_TIMEOUT_SEC = "9876";
    let observedCommand = "";
    try {
      const node = createRunExperimentsNode({
        config: {
          experiments: {
            timeout_sec: 1234,
            network_policy: "blocked"
          }
        } as any,
        executionProfile: "local",
        runStore: {} as any,
        eventStream: new InMemoryEventStream(),
        llm: new MockLLMClient(),
        experimentLlm: new MockLLMClient(),
        pdfTextLlm: new MockLLMClient(),
        codex: {} as any,
        aci: {
          runCommand: async (command: string) => {
            observedCommand = command;
            await writeFile(
              path.join(runDir, "metrics.json"),
              JSON.stringify(
                {
                  status: "completed",
                  success: true,
                  primary_metric: {
                    name: "accuracy_delta_vs_baseline",
                    value: 0.02,
                    target: 0.01,
                    met: true
                  },
                  condition_results: [
                    { condition_id: "baseline_condition", status: "completed", accuracy: 0.4 },
                    { condition_id: "candidate_condition_a", status: "completed", accuracy: 0.42 }
                  ],
                  completed_condition_count: 2
                },
                null,
                2
              ),
              "utf8"
            );
            return {
              status: "ok" as const,
              stdout: "runner completed",
              stderr: "",
              exit_code: 0,
              duration_ms: 10
            };
          },
          runTests: async () => ({
            status: "ok" as const,
            stdout: "",
            stderr: "",
            exit_code: 0,
            duration_ms: 1
          })
        } as any,
        semanticScholar: {} as any,
        openAlex: {} as any,
        crossref: {} as any,
        arxiv: {} as any,
        responsesPdfAnalysis: {} as any
      });

      await node.execute({ run, graph: run.graph });
    } finally {
      if (originalP6Timeout === undefined) {
        delete process.env.AUTOLABOS_P6_NEXT_TIMEOUT_SEC;
      } else {
        process.env.AUTOLABOS_P6_NEXT_TIMEOUT_SEC = originalP6Timeout;
      }
    }

    expect(observedCommand).toContain("--timeout-sec 1234");
    expect(observedCommand).not.toContain("--timeout-sec 9876");
  });

  it("appends per-condition timeout when accepted by the Python runner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-condition-timeout-"));
    process.chdir(root);
    const run = makeRun("run-condition-timeout");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "def main(argv=None):",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--metrics-path', default='metrics.json')",
        "    parser.add_argument('--timeout-sec', type=int, default=0)",
        "    parser.add_argument('--condition-timeout-sec', type=int, default=0)",
        "    return parser.parse_args(argv)",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 " + JSON.stringify(scriptPath));
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    let observedCommand = "";
    const node = createRunExperimentsNode({
      config: {
        experiments: {
          timeout_sec: 1234,
          network_policy: "blocked"
        }
      } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async (command: string) => {
          observedCommand = command;
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric: {
                  name: "accuracy_delta_vs_baseline",
                  value: 0.02,
                  target: 0.01,
                  met: true
                },
                condition_results: [
                  { condition_id: "baseline_condition", status: "completed", accuracy: 0.4 },
                  { condition_id: "candidate_condition_a", status: "completed", accuracy: 0.42 }
                ],
                completed_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });

    expect(observedCommand).toContain("--timeout-sec 1234");
    expect(observedCommand).toContain("--condition-timeout-sec 1234");
  });

  it("does not append timeout flags only mentioned outside argparse", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-timeout-flag-source-mention-"));
    process.chdir(root);
    const run = makeRun("run-timeout-flag-source-mention");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "TIMEOUT_FLAG = '--timeout-sec'",
        "def main(argv=None):",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--output-dir', default='.')",
        "    parser.add_argument('--metrics-path', default='metrics.json')",
        "    return parser.parse_args(argv)",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", `python3 ${JSON.stringify(scriptPath)}`);
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    let observedCommand = "";
    const node = createRunExperimentsNode({
      config: {
        experiments: {
          timeout_sec: 14400,
          network_policy: "blocked"
        }
      } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async (command: string) => {
          observedCommand = command;
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric: {
                  name: "accuracy_delta_vs_baseline",
                  value: 0.02,
                  target: 0.01,
                  met: true
                },
                condition_results: [
                  { condition_id: "baseline_condition", status: "completed", accuracy: 0.4 },
                  { condition_id: "candidate_condition_a", status: "completed", accuracy: 0.42 }
                ],
                completed_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });

    expect(observedCommand).not.toContain("--timeout-sec 14400");
    expect(observedCommand).not.toContain("--budget-timeout-sec 14400");
  });

  it("does not append timeout flags accepted only by a fallback parser", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-timeout-fallback-parser-"));
    process.chdir(root);
    const run = makeRun("run-timeout-fallback-parser");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "def build_arg_parser():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--output-dir', default='.')",
        "    parser.add_argument('--metrics-path', default='metrics.json')",
        "    return parser",
        "def _fallback_arg_parser():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--timeout-sec', type=int, default=None)",
        "    return parser",
        "def main(argv=None):",
        "    return build_arg_parser().parse_args(argv)",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", `python3 ${JSON.stringify(scriptPath)}`);
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    let observedCommand = "";
    const node = createRunExperimentsNode({
      config: {
        experiments: {
          timeout_sec: 14400,
          network_policy: "blocked"
        }
      } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async (command: string) => {
          observedCommand = command;
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric: {
                  name: "accuracy_delta_vs_baseline",
                  value: 0.02,
                  target: 0.01,
                  met: true
                },
                condition_results: [
                  { condition_id: "baseline_condition", status: "completed", accuracy: 0.4 },
                  { condition_id: "candidate_condition_a", status: "completed", accuracy: 0.42 }
                ],
                completed_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });

    expect(observedCommand).not.toContain("--timeout-sec 14400");
    expect(observedCommand).not.toContain("--budget-timeout-sec 14400");
  });

  it("promotes top-level primary_metric_key and primary_metric before objective contract validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-primary-metric-key-projection-"));
    process.chdir(root);
    const run = makeRun("run-primary-metric-key-projection");
    run.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    await runContext.put(EXPERIMENT_GOVERNANCE_CONTRACT_KEY, {
      version: 1,
      run_id: run.id,
      plan_id: "plan-primary-metric-key-projection",
      selected_hypothesis_ids: ["hypothesis-1"],
      objective_metric_name: run.objectiveMetric,
      baseline_first_required: true,
      baseline_candidate_ids: ["baseline"],
      comparison_mode: "baseline_first_locked",
      budget_profile: {
        mode: "single_run_locked",
        locked: true,
        timeout_sec: 1800
      },
      objective_profile: {
        source: "test",
        raw: run.objectiveMetric,
        primaryMetric: "accuracy_delta_vs_baseline",
        preferredMetricKeys: ["accuracy_delta_vs_baseline"],
        direction: "maximize",
        threshold: 0.01,
        thresholdOperator: ">="
      },
      created_at: new Date().toISOString()
    });

    const eventStream = new InMemoryEventStream();
    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream,
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric_key: "accuracy_delta_vs_baseline",
                primary_metric: -0.03125,
                completed_condition_count: 3,
                required_condition_count: 3,
                conditions: [
                  {
                    marker: "baseline_condition",
                    status: "completed",
                    average_accuracy: 0.28125,
                    accuracy_delta_vs_baseline: 0
                  },
                  {
                    marker: "candidate_condition_d",
                    status: "completed",
                    average_accuracy: 0.25,
                    accuracy_delta_vs_baseline: -0.03125
                  },
                  {
                    marker: "candidate_condition_f",
                    status: "completed",
                    average_accuracy: 0.21875,
                    accuracy_delta_vs_baseline: -0.0625
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).not.toBe("failure");
    const metrics = JSON.parse(await readFile(path.join(runDir, "metrics.json"), "utf8")) as {
      accuracy_delta_vs_baseline?: number;
    };
    expect(metrics.accuracy_delta_vs_baseline).toBe(-0.03125);
    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; summary: string };
    expect(verifierReport.status).toBe("pass");
    expect(
      eventStream.history().some((event) =>
        String(event.payload.text || "").includes("Promoted primary metric accuracy_delta_vs_baseline=-0.03125")
      )
    ).toBe(true);
  });

  it("promotes aggregate metrics projection before objective contract validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-aggregate-metric-projection-"));
    process.chdir(root);
    const run = makeRun("run-aggregate-metric-projection");
    run.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    await runContext.put(EXPERIMENT_GOVERNANCE_CONTRACT_KEY, {
      version: 1,
      run_id: run.id,
      plan_id: "plan-aggregate-metric-projection",
      selected_hypothesis_ids: ["hypothesis-1"],
      objective_metric_name: run.objectiveMetric,
      baseline_first_required: true,
      baseline_candidate_ids: ["baseline_condition"],
      comparison_mode: "baseline_first_locked",
      budget_profile: {
        mode: "single_run_locked",
        locked: true,
        timeout_sec: 1800
      },
      objective_profile: {
        source: "test",
        raw: run.objectiveMetric,
        primaryMetric: "accuracy_delta_vs_baseline",
        preferredMetricKeys: ["accuracy_delta_vs_baseline"],
        direction: "maximize",
        threshold: 0.01,
        thresholdOperator: ">="
      },
      created_at: new Date().toISOString()
    });

    const eventStream = new InMemoryEventStream();
    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream,
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "success",
                config: {
                  primary_metric_key: "accuracy_delta_vs_baseline",
                  required_condition_markers: [
                    "baseline_condition",
                    "candidate_condition_a",
                    "candidate_condition_b"
                  ],
                  seed_schedule: [11, 12]
                },
                per_seed_rows: ["baseline_condition", "candidate_condition_a", "candidate_condition_b"].flatMap((marker) =>
                  [11, 12].map((seed) => ({ condition_marker: marker, seed, status: "completed" }))
                ),
                aggregate: {
                  baseline_marker: "baseline_condition",
                  completed_run_count: 6,
                  completed_condition_count: 3,
                  failed_run_count: 0,
                  best_condition: {
                    marker: "candidate_condition_b",
                    mean_accuracy: 0.62,
                    accuracy_delta_vs_baseline: 0.02
                  },
                  condition_aggregates: [
                    {
                      marker: "baseline_condition",
                      mean_accuracy: 0.6,
                      accuracy_delta_vs_baseline: 0,
                      fully_completed: true
                    },
                    {
                      marker: "candidate_condition_a",
                      mean_accuracy: 0.61,
                      accuracy_delta_vs_baseline: 0.01,
                      fully_completed: true
                    },
                    {
                      marker: "candidate_condition_b",
                      mean_accuracy: 0.62,
                      accuracy_delta_vs_baseline: 0.02,
                      fully_completed: true
                    }
                  ]
                }
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).not.toBe("failure");
    const metrics = JSON.parse(await readFile(path.join(runDir, "metrics.json"), "utf8")) as {
      accuracy_delta_vs_baseline?: number;
      primary_metric_key?: string;
      primary_metric_value?: number;
      completed_run_count?: number;
      completed_condition_count?: number;
      required_run_count?: number;
      required_condition_count?: number;
      best_condition?: { marker?: string };
    };
    expect(metrics.accuracy_delta_vs_baseline).toBe(0.02);
    expect(metrics.primary_metric_key).toBe("accuracy_delta_vs_baseline");
    expect(metrics.primary_metric_value).toBe(0.02);
    expect(metrics.completed_run_count).toBe(6);
    expect(metrics.completed_condition_count).toBe(3);
    expect(metrics.required_run_count).toBe(6);
    expect(metrics.required_condition_count).toBe(3);
    expect(metrics.best_condition?.marker).toBe("candidate_condition_b");
    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; summary: string };
    expect(verifierReport.status).toBe("pass");
    expect(
      eventStream.history().some((event) =>
        String(event.payload.text || "").includes("Promoted aggregate metrics projection")
      )
    ).toBe(true);
  });
  it("prefers adjacent generated backend implementation over partial internal runner fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-adjacent-backend-discovery-"));
    process.chdir(root);
    const run = makeRun("run-adjacent-backend-discovery");
    run.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const scriptPath = path.join(root, "experiment.py");
    const backendPath = path.join(root, "backend_experiment_impl.py");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(
      scriptPath,
      [
        "from pathlib import Path",
        "import importlib.util",
        "import json",
        "import sys",
        "",
        "def discover_backend(explicit_module=None):",
        "    search_dir = Path(__file__).resolve().parent",
        "    candidates = []",
        "    candidates.extend(",
        "        [",
        "            search_dir / \"study_backend.py\",",
        "            search_dir / \"backend.py\",",
        "        ]",
        "    )",
        "    current_file = Path(__file__).resolve()",
        "    for candidate in candidates:",
        "        if not candidate.exists() or candidate.resolve() == current_file:",
        "            continue",
        "        spec = importlib.util.spec_from_file_location(f\"study_backend_{candidate.stem}\", candidate)",
        "        if spec is None or spec.loader is None:",
        "            continue",
        "        module = importlib.util.module_from_spec(spec)",
        "        spec.loader.exec_module(module)",
        "        for fn_name in (\"run_study\", \"run_experiment\", \"execute_study\"):",
        "            fn = getattr(module, fn_name, None)",
        "            if callable(fn):",
        "                return {\"callable\": fn, \"path\": str(candidate)}",
        "    return None",
        "",
        "def partial_internal_backend():",
        "    return {\"status\": \"partial_completed\", \"primary_metric_key\": \"accuracy_delta_vs_baseline\", \"completed_run_count\": 1, \"required_run_count\": 2, \"completed_condition_count\": 0, \"required_condition_count\": 2}",
        "",
        "def main():",
        "    metrics_path = Path(sys.argv[sys.argv.index(\"--metrics-path\") + 1])",
        "    backend = discover_backend(None)",
        "    result = backend[\"callable\"](<metrics_path=metrics_path>) if backend else partial_internal_backend()",
        "    metrics_path.parent.mkdir(parents=True, exist_ok=True)",
        "    metrics_path.write_text(json.dumps(result, indent=2), encoding=\"utf8\")",
        "    print(json.dumps({\"status\": result.get(\"status\"), \"completed_run_count\": result.get(\"completed_run_count\")}))",
        "    return 0",
        "",
        "if __name__ == \"__main__\":",
        "    raise SystemExit(main())"
      ].join("\n").replace("<metrics_path=metrics_path>", "metrics_path=metrics_path"),
      "utf8"
    );
    await writeFile(
      backendPath,
      [
        "import inspect",
        "from typing import Any, Dict, Mapping",
        "",
        "def _backend_call_with_supported_kwargs(func, **kwargs):",
        "    signature = inspect.signature(func)",
        "    filtered_kwargs = {key: value for key, value in kwargs.items() if key in signature.parameters}",
        "    return func(**filtered_kwargs)",
        "",
        "def _invoke_with_supported_kwargs(func: Any, kwargs: Mapping[str, Any]) -> Any:",
        "    signature = inspect.signature(func)",
        "    parameters = signature.parameters",
        "    if any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters.values()):",
        "        return func(**kwargs)",
        "    supported_kwargs: Dict[str, Any] = {}",
        "    for name, parameter in parameters.items():",
        "        if parameter.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.VAR_POSITIONAL):",
        "            continue",
        "        if name in kwargs:",
        "            supported_kwargs[name] = kwargs[name]",
        "    return func(**supported_kwargs)",
        "",
        "def aggregate_study_results(seed_rows, required_condition_markers=None, baseline_condition_marker=None):",
        "    return {",
        "        \"status\": \"success\",",
        "        \"primary_metric_key\": \"accuracy_delta_vs_baseline\",",
        "        \"primary_metric\": 0.02,",
        "        \"primary_metric_value\": 0.02,",
        "        \"accuracy_delta_vs_baseline\": 0.02,",
        "        \"completed_run_count\": len(seed_rows),",
        "        \"required_run_count\": 2,",
        "        \"completed_condition_count\": 2,",
        "        \"required_condition_count\": 2,",
        "        \"baseline_condition_marker\": \"baseline_condition\",",
        "        \"condition_summaries\": [",
        "            {\"condition_marker\": \"baseline_condition\", \"accuracy_delta_vs_baseline\": 0},",
        "            {\"condition_marker\": \"candidate_condition_a\", \"accuracy_delta_vs_baseline\": 0.02},",
        "        ],",
        "    }",
        "",
        "def summarize_payload_for_public_report(aggregate_payload):",
        "    best_condition_summary = {}",
        "    condition_summaries = list(aggregate_payload.get(\"condition_summaries\", []))",
        "    return [summary.get(\"accuracy_delta_vs_baseline\") for summary in condition_summaries]",
        "",
        "def normalize_execution_payload(execution_payload):",
        "    raw_seed_results = execution_payload.get(\"seed_results\")",
        "    if raw_seed_results is None:",
        "        raw_seed_results = execution_payload.get(\"raw_seed_results\")",
        "    if raw_seed_results is None:",
        "        raw_seed_results = execution_payload.get(\"results\")",
        "    return raw_seed_results",
        "",
        "def load_condition_model_bundle(**kwargs):",
        "    return None",
        "",
        "def prepare_single_seed_data_bundle(**kwargs):",
        "    return {\"train_examples\": [], \"eval_examples\": {}}",
        "",
        "def run_single_seed_training(*, condition, seed, model, tokenizer, train_examples, device, runtime_config=None):",
        "    return {\"status\": \"completed\"}",
        "",
        "def run_single_condition_seed(condition_dict, seed, runtime_context):",
        "    training_runner = run_single_seed_training",
        "    try:",
        "        raw_training_output = None",
        "        if training_runner is not None:",
        "            raw_training_output = _invoke_with_supported_kwargs(",
        "                training_runner,",
        "                condition=condition_dict,",
        "                seed=seed,",
        "                runtime_context=runtime_context,",
        "                output_dir=None,",
        "                device=runtime_context.get(\"device\"),",
        "            )",
        "        return raw_training_output",
        "    finally:",
        "        pass",
        "",
        "def run_experiment(metrics_path=None, output_dir=None, **kwargs):",
        "    seed_results = [",
        "        {\"condition_marker\": \"baseline_condition\", \"status\": \"completed\"},",
        "        {\"condition_marker\": \"candidate_condition_a\", \"status\": \"completed\"},",
        "    ]",
        "    return _invoke_with_supported_kwargs(",
        "        aggregate_study_results,",
        "        seed_results=seed_results,",
        "        raw_seed_results=seed_results,",
        "        results=seed_results,",
        "        baseline_condition_marker=\"baseline_condition\",",
        "        required_condition_markers=[\"baseline_condition\", \"candidate_condition_a\"],",
        "    )"
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", `python3 "${scriptPath}" --metrics-path "${path.join(runDir, "metrics.json")}"`);
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    await runContext.put(EXPERIMENT_GOVERNANCE_CONTRACT_KEY, {
      version: 1,
      run_id: run.id,
      plan_id: "plan-adjacent-backend-discovery",
      selected_hypothesis_ids: ["hypothesis-1"],
      objective_metric_name: run.objectiveMetric,
      baseline_first_required: true,
      baseline_candidate_ids: ["baseline_condition"],
      comparison_mode: "baseline_first_locked",
      budget_profile: { mode: "single_run_locked", locked: true, timeout_sec: 1800 },
      objective_profile: {
        source: "test",
        raw: run.objectiveMetric,
        primaryMetric: "accuracy_delta_vs_baseline",
        preferredMetricKeys: ["accuracy_delta_vs_baseline"],
        direction: "maximize",
        threshold: 0.01,
        thresholdOperator: ">="
      },
      created_at: new Date().toISOString()
    });

    const eventStream = new InMemoryEventStream();
    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream,
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async (command: string) => {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          const match = command.match(/python3?\s+"([^"]+)"\s+--metrics-path\s+"([^"]+)"/u);
          if (!match) {
            throw new Error(`unexpected command: ${command}`);
          }
          const result = await execFileAsync("python3", [match[1], "--metrics-path", match[2]], { cwd: root });
          return {
            status: "ok" as const,
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).not.toBe("failure");
    const metrics = JSON.parse(await readFile(path.join(runDir, "metrics.json"), "utf8")) as {
      accuracy_delta_vs_baseline?: number;
      completed_run_count?: number;
      completed_condition_count?: number;
    };
    expect(metrics.accuracy_delta_vs_baseline).toBe(0.02);
    expect(metrics.completed_run_count).toBe(2);
    expect(metrics.completed_condition_count).toBe(2);
    expect(await readFile(scriptPath, "utf8")).toContain("backend_experiment_impl.py");
    const backendSource = await readFile(backendPath, "utf8");
    expect(backendSource).toContain("raw_condition_summaries = aggregate_payload.get");
    expect(backendSource).toContain("kwargs: Any = None, **extra_kwargs: Any");
    expect(backendSource).toContain('execution_payload.get("seed_rows")');
    expect(backendSource).toContain("_autolabos_training_inputs_bridge_marker");
    expect(backendSource).toContain("train_examples=bridge_train_examples");
    expect(
      eventStream.history().some((event) =>
        String(event.payload.text || "").includes("Added adjacent backend_experiment_impl.py discovery")
      )
    ).toBe(true);
  });
  it("promotes condition summary primary metric when the top-level objective metric is null", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-condition-summary-metric-projection-"));
    process.chdir(root);
    const run = makeRun("run-condition-summary-metric-projection");
    run.objectiveMetric = "accuracy_delta_vs_baseline >= 0.01";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    await runContext.put(EXPERIMENT_GOVERNANCE_CONTRACT_KEY, {
      version: 1,
      run_id: run.id,
      plan_id: "plan-condition-summary-metric-projection",
      selected_hypothesis_ids: ["hypothesis-1"],
      objective_metric_name: run.objectiveMetric,
      baseline_first_required: true,
      baseline_candidate_ids: ["baseline"],
      comparison_mode: "baseline_first_locked",
      budget_profile: {
        mode: "single_run_locked",
        locked: true,
        timeout_sec: 1800
      },
      objective_profile: {
        source: "test",
        raw: run.objectiveMetric,
        primaryMetric: "accuracy_delta_vs_baseline",
        preferredMetricKeys: ["accuracy_delta_vs_baseline"],
        direction: "maximize",
        threshold: 0.01,
        thresholdOperator: ">="
      },
      created_at: new Date().toISOString()
    });

    const eventStream = new InMemoryEventStream();
    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream,
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                primary_metric_key: "accuracy_delta_vs_baseline",
                primary_metric_value: null,
                accuracy_delta_vs_baseline: null,
                completed_run_count: 22,
                completed_condition_count: 4,
                baseline_condition_marker: "baseline_condition",
                condition_summaries: [
                  {
                    condition_marker: "baseline_condition",
                    completed_runs: 7,
                    accuracy_delta_vs_baseline: 0
                  },
                  {
                    condition_marker: "candidate_condition_a",
                    completed_runs: 5,
                    accuracy_delta_vs_baseline: 0
                  },
                  {
                    condition_marker: "candidate_condition_d",
                    completed_runs: 5,
                    accuracy_delta_vs_baseline: -0.0375
                  },
                  {
                    condition_marker: "candidate_condition_f",
                    completed_runs: 5,
                    accuracy_delta_vs_baseline: -0.0375
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).not.toBe("failure");
    const metrics = JSON.parse(await readFile(path.join(runDir, "metrics.json"), "utf8")) as {
      accuracy_delta_vs_baseline?: number;
      primary_metric_value?: number;
    };
    expect(metrics.accuracy_delta_vs_baseline).toBe(0);
    expect(metrics.primary_metric_value).toBe(0);
    expect(
      eventStream.history().some((event) =>
        String(event.payload.text || "").includes("Promoted condition-summary primary metric accuracy_delta_vs_baseline=0")
      )
    ).toBe(true);
  });

  it("publishes canonical public summaries from accepted run metrics instead of stale runner summaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-public-summary-sync-"));
    process.chdir(root);
    const run = makeRun("run-public-summary-sync");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicExperimentDir = buildPublicSectionDir(root, run, "experiment");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicExperimentDir, { recursive: true });
    await writeFile(
      path.join(publicExperimentDir, "summary.json"),
      JSON.stringify({ status: "failed", completed_run_count: 0, required_run_count: 24 }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(publicExperimentDir, "study_summary.json"),
      JSON.stringify({ status: "failed", completed_run_count: 0, required_run_count: 24 }, null, 2),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                accuracy: 0.95,
                completed_run_count: 24,
                required_run_count: 24,
                attempted_run_count: 24,
                failed_run_count: 0,
                completed_condition_count: 8,
                required_condition_count: 8,
                accuracy_delta_vs_baseline: 0,
                per_seed_rows: Array.from({ length: 8 }, (_unused, index) => `condition_${index + 1}`).flatMap((marker) =>
                  [101, 202, 303].map((seed) => ({ condition_marker: marker, seed, status: "completed" }))
                ),
                condition_summaries: [
                  {
                    condition_marker: "baseline_condition",
                    completed_runs: 3,
                    accuracy_delta_vs_baseline: 0
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const publicSummary = JSON.parse(await readFile(path.join(publicExperimentDir, "summary.json"), "utf8")) as {
      source?: string;
      completed_run_count?: number;
      required_run_count?: number;
      failed_run_count?: number;
    };
    const publicStudySummary = JSON.parse(
      await readFile(path.join(publicExperimentDir, "study_summary.json"), "utf8")
    ) as {
      source?: string;
      completed_run_count?: number;
      required_run_count?: number;
      completed_condition_count?: number;
    };
    expect(publicSummary).toMatchObject({
      source: "run_experiments",
      completed_run_count: 24,
      required_run_count: 24,
      failed_run_count: 0
    });
    expect(publicStudySummary).toMatchObject({
      source: "run_experiments",
      completed_run_count: 24,
      required_run_count: 24,
      completed_condition_count: 8
    });
  });

  it("repairs _make_config_instance dataclass aliases before run_experiments execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-config-instance-alias-"));
    process.chdir(root);
    const run = makeRun("run-config-instance-alias");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "from dataclasses import dataclass",
        "",
        "@dataclass(frozen=True)",
        "class ConditionSpec:",
        "    marker: str",
        "    condition_parameter_x: int",
        "    adapter_alpha: int",
        "    condition_parameter_y: float",
        "",
        "def _make_config_instance(type_name, **kwargs):",
        "    cls = globals().get(type_name)",
        "    if cls is None:",
        "        payload = dict(kwargs)",
        "        payload.setdefault('_type', type_name)",
        "        return payload",
        "    try:",
        "        return cls(**kwargs)",
        "    except TypeError:",
        "        dataclass_fields = getattr(cls, '__dataclass_fields__', None)",
        "        if dataclass_fields:",
        "            filtered = {key: value for key, value in kwargs.items() if key in dataclass_fields}",
        "            return cls(**filtered)",
        "        payload = dict(kwargs)",
        "        payload.setdefault('_type', type_name)",
        "        return payload",
        "",
        "BASELINE_CONDITION_SPEC = _make_config_instance(",
        "    'ConditionSpec',",
        "    marker='baseline',",
        "    condition_id='baseline',",
        "    " + "ra" + "nk=8,",
        "    adapter_alpha=16,",
        "    condition_parameter_y=0.0,",
        ")",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", `python3 ${JSON.stringify(scriptPath)}`);
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    let repairedBeforeExecution = false;
    const eventStream = new InMemoryEventStream();
    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream,
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          const repairedSource = await readFile(scriptPath, "utf8");
          repairedBeforeExecution = repairedSource.includes("_autolabos_config_instance_dataclass_field_alias_marker");
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric: {
                  name: "accuracy_delta_vs_baseline",
                  value: 0.02,
                  target: 0.01,
                  met: true
                },
                condition_results: [
                  {
                    condition_id: "baseline",
                    condition_type: "baseline",
                    status: "completed",
                    accuracy: 0.4
                  },
                  {
                    condition_id: "candidate",
                    condition_type: "candidate",
                    status: "completed",
                    accuracy: 0.42
                  }
                ],
                completed_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });

    expect(repairedBeforeExecution).toBe(true);
    expect(await readFile(scriptPath, "utf8")).toContain("alias_values = dict(kwargs)");
    expect(
      eventStream.history().some((event) =>
        String(event.payload.text || "").includes("Added dataclass field aliases for _make_config_instance")
      )
    ).toBe(true);
  });

  it("classifies all-condition Hugging Face model load failures as dependency blockers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-model-dependency-blocker-"));
    process.chdir(root);
    const run = makeRun("run-model-dependency-blocker");
    run.objectiveMetric = "accuracy_delta_vs_baseline";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                condition_results: [
                  {
                    condition_id: "unmodified_base",
                    status: "failed",
                    error:
                      "OSError: Can't load the configuration of 'EleutherAI/pythia-410m'. If you were trying to load it from Hugging Face, make sure the model is available or cached locally."
                  },
                  {
                    condition_id: "reference_candidate",
                    status: "failed",
                    evidence: {
                      error_message:
                        "OSError: Can't load the configuration of 'EleutherAI/pythia-410m'. AutoModelForCausalLM.from_pretrained failed."
                    }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote dependency-failed metrics",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment dependency blocker");
    expect(result.error).toContain("EleutherAI/pythia-410m");
    expect(result.error).toContain("No condition metrics were accepted as evidence");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Experiment dependency blocker");
  });

  it("fails verification when comparator recipes report failed statuses inside otherwise ok metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-failed-recipes-"));
    process.chdir(root);
    const run = makeRun("run-failed-recipes");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "ok",
                primary_metric: {
                  name: "mean_zero_shot_accuracy",
                  absolute_improvement_over_baseline: 0
                },
                recipes: {
                  baseline: {
                    status: "ok",
                    evaluation: {
                      mean_zero_shot_accuracy: 0.4
                    }
                  },
                  condition_parameter_x4: {
                    status: "failed",
                    error: "TrainingArguments.__init__() got an unexpected keyword argument 'overwrite_output_dir'"
                  }
                }
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote partial metrics",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics payload reports failed recipe(s)");
    expect(result.error).toContain("condition_parameter_x4");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Experiment metrics payload reports failed recipe(s)");
  });

  it("fails verification when a required run contract exits zero with no completed runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-zero-completed-"));
    process.chdir(root);
    const run = makeRun("run-zero-completed");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "success",
                accuracy: 0.95,
                required_condition_count: 5,
                completed_condition_count: 0,
                required_run_count: 25,
                completed_run_count: 0,
                failure_count: 2,
                seed_results: [
                  {
                    status: "failed",
                    error_type: "RuntimeError",
                    error_stage: "execution",
                    error_message: "No seed execution helper was found in the current runner module."
                  },
                  {
                    status: "failed",
                    error_type: "RuntimeError",
                    error_stage: "execution",
                    error_message: "No seed execution helper was found in the current runner module."
                  }
                ],
                study_summary: {
                  status: "failed",
                  required_run_count: 25,
                  completed_run_count: 0
                }
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner exited zero after failed condition loop",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("No required experiment runs completed successfully");
    expect(result.error).toContain("No seed execution helper was found in the current runner module");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("No required experiment runs completed successfully");
    expect(verifierReport.summary).toContain("seed_failure_messages=RuntimeError: stage=execution");
  });

  it("surfaces nested backend discovery failures from rejected metrics payloads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-nested-backend-failure-"));
    process.chdir(root);
    const run = makeRun("run-nested-backend-failure");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                primary_metric: {
                  key: "accuracy_delta_vs_baseline",
                  value: null
                },
                aggregates: {
                  completed_run_count: 0,
                  failed_run_count: 2
                },
                backend: {
                  status: "not_found",
                  attempts: [
                    {
                      candidate: "backend_candidate_a",
                      error: "ModuleNotFoundError: No module named backend_candidate_a",
                      status: "failed"
                    }
                  ]
                },
                raw_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    error_message: "No supported backend module discovered: not_found"
                  }
                ],
                condition_summaries: [
                  {
                    marker: "baseline_condition",
                    completed_run_count: 0,
                    status: "failed",
                    seed_results: [
                      {
                        seed: 1,
                        status: "failed",
                        error_message: "No supported backend module discovered: not_found"
                      }
                    ]
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote failed metrics payload",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("No supported backend module discovered: not_found");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("metrics_error_messages=ModuleNotFoundError");
    expect(verifierReport.summary).toContain("seed_failure_messages=No supported backend module discovered: not_found");
  });

  it("fails verification when planned run coverage is contracted below the portfolio evidence floor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-contracted-coverage-"));
    process.chdir(root);
    const run = makeRun("run-contracted-coverage");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(
      path.join(runDir, "experiment_portfolio.json"),
      JSON.stringify(
        {
          version: 1,
          run_id: run.id,
          created_at: new Date().toISOString(),
          execution_model: "single_run",
          comparison_axes: ["rank"],
          primary_trial_group_id: "primary",
          trial_groups: [
            {
              id: "primary",
              label: "Primary repeated-seed rank sweep",
              role: "primary",
              group_kind: "aggregate",
              dataset_scope: ["Benchmark Task A", "Benchmark Task B"],
              metrics: ["accuracy_delta_vs_baseline"],
              baselines: ["Locked baseline condition"],
              notes: [
                "Paper-scale evidence floor: 4 ranks x 5 seeds = 20 fine-tune runs, plus 2 exact baseline reruns.",
                "Training budget is 22 runs total including exact baseline repeats."
              ]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "success",
                accuracy: 0.95,
                accuracy_delta_vs_baseline: 0,
                completed_run_count: 4,
                completed_condition_count: 4,
                condition_summaries: [
                  { condition_marker: "baseline_condition", completed_runs: 1 },
                  { condition_marker: "candidate_condition_a", completed_runs: 1 },
                  { condition_marker: "candidate_condition_d", completed_runs: 1 },
                  { condition_marker: "candidate_condition_f", completed_runs: 1 }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner exited zero with a smoke-scale contracted run",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment run coverage incomplete: completed_run_count=4/22");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("completed_run_count=4/22");
  });

  it("fails repeated-run verification when completed counters lack condition-seed evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-seed-evidence-"));
    process.chdir(root);
    const run = makeRun("run-seed-evidence");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "success",
                success: true,
                accuracy_delta_vs_baseline: 0.12,
                primary_metric_key: "accuracy_delta_vs_baseline",
                primary_metric_value: 0.12,
                completed_run_count: 6,
                required_run_count: 6,
                completed_condition_count: 2,
                required_condition_count: 2,
                condition_results: [
                  { condition_marker: "baseline_condition", status: "completed", seed_count: 0, seeds: [] },
                  { condition_marker: "candidate_condition_a", status: "completed", seed_count: 0, seeds: [] }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "ok" as const, stdout: "runner exited zero", stderr: "", exit_code: 0, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Repeated-run evidence incomplete");
    expect(result.error).toContain("observed_condition_seed_count=0/6");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("observed_condition_seed_count=0/6");
  });
});
