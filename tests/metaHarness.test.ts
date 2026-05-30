import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";

import { parseMetaHarnessResponse, runMetaHarness } from "../src/core/metaHarness/metaHarness.js";

const cleanupPaths: string[] = [];

describe("runMetaHarness", () => {
  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))
    );
  });

  it("builds a proposer context directory with TASK.md and expected run files", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results", "review"],
        noApply: true
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace)
      }
    );

    expect(result.contextDir).toContain(path.join("outputs", "meta-harness"));
    const task = await fs.readFile(path.join(result.contextDir, "TASK.md"), "utf8");
    expect(task).toContain("TARGET_FILE: node-prompts/<node>.md");
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "analyze_results_events.jsonl"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "result_analysis.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "decision.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "node_strengthening_recommendations.json"))).resolves.toBeTruthy();
    expect(task).toContain("node_strengthening_recommendations.json");
    expect(task).toContain("prompt_target_map.json");
    const promptTargetMap = JSON.parse(await fs.readFile(path.join(result.contextDir, "prompt_target_map.json"), "utf8")) as {
      targets: Array<{ target_node: string; recommended_prompt_node: string; prompt_file: string }>;
    };
    expect(promptTargetMap.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_node: "run_experiments",
          recommended_prompt_node: "design_experiments",
          prompt_file: "node-prompts/design_experiments.md"
        }),
        expect.objectContaining({
          target_node: "write_paper",
          recommended_prompt_node: "review",
          prompt_file: "node-prompts/review.md"
        })
      ])
    );
    await expect(fs.stat(path.join(result.contextDir, "node-prompts", "design_experiments.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "paper_readiness.json"))).resolves.toBeTruthy();
  });

  it("returns the context dir without modifying files in --no-apply mode", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const before = await fs.readFile(path.join(workspace, "node-prompts", "analyze_results.md"), "utf8");
    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results"],
        noApply: true
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace)
      }
    );

    expect(result.lines[0]).toContain("Meta-harness context prepared");
    expect(await fs.readFile(path.join(workspace, "node-prompts", "analyze_results.md"), "utf8")).toBe(before);
  });

  it("builds read-only external multi-run context bundles without calling LLM or apply", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const externalRunA = await createExternalRunRoot("external-a", {
      resultAnalysis: true,
      reviewDecision: true,
      paperReadiness: true,
      unrelated: true
    });
    const externalRunB = await createExternalRunRoot("external-b", {
      resultAnalysis: true,
      reviewDecision: false,
      paperReadiness: false,
      unrelated: true
    });
    const callLlm = vi.fn();
    const applyWithSafetyNet = vi.fn();

    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 0,
        nodes: ["analyze_results", "review"],
        externalRunRoots: [externalRunA, externalRunB],
        noApply: true
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace),
        callLlm,
        applyWithSafetyNet
      }
    );

    expect(result.lines.join("\n")).toContain("External run contexts included: 2");
    expect(callLlm).not.toHaveBeenCalled();
    expect(applyWithSafetyNet).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(result.contextDir, "external-runs", "external-1", "result_analysis.json"))
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(result.contextDir, "external-runs", "external-1", "review", "decision.json"))
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(result.contextDir, "external-runs", "external-1", "paper", "paper_readiness.json"))
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(result.contextDir, "external-runs", "external-1", "secret.txt"))
    ).rejects.toThrow();

    const manifestRaw = await fs.readFile(path.join(result.contextDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as {
      mode: string;
      external_context_count: number;
      external_contexts: Array<{
        source_label: string;
        copied_artifacts: string[];
        missing_optional_artifacts: string[];
      }>;
    };
    expect(manifest.mode).toBe("external_context");
    expect(manifest.external_context_count).toBe(2);
    expect(manifestRaw).not.toContain(externalRunA);
    expect(manifest.external_contexts[0]).toMatchObject({
      source_label: path.basename(externalRunA),
      copied_artifacts: expect.arrayContaining(["result_analysis.json", "review/decision.json", "paper/paper_readiness.json"])
    });
    expect(manifest.external_contexts[1]?.missing_optional_artifacts).toEqual(
      expect.arrayContaining(["review/decision.json", "paper/paper_readiness.json"])
    );
  });

  it("blocks external meta-harness contexts when apply mode is requested", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const externalRun = await createExternalRunRoot("external-blocked", { resultAnalysis: true });

    await expect(
      runMetaHarness(
        {
          cwd: workspace,
          runs: 0,
          nodes: ["analyze_results"],
          externalRunRoots: [externalRun],
          noApply: false
        },
        {
          bootstrapRuntime: fakeBootstrapRuntime(workspace)
        }
      )
    ).rejects.toThrow("--no-apply");
  });

  it("prints diff only in dry-run mode without changing files", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const before = await fs.readFile(targetFile, "utf8");
    const diff = [
      "TARGET_FILE: node-prompts/analyze_results.md",
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1 +1 @@",
      "-Prompt",
      "+Prompt improved"
    ].join("\n");

    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results"],
        dryRun: true
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace),
        callLlm: vi.fn().mockResolvedValue(diff)
      }
    );

    expect(result.diffText).toContain("+++ b/node-prompts/analyze_results.md");
    expect(await fs.readFile(targetFile, "utf8")).toBe(before);
  });

  it("surfaces invalid LLM diff output without changing files", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const before = await fs.readFile(targetFile, "utf8");

    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results"]
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace),
        callLlm: vi.fn().mockResolvedValue("not a diff")
      }
    );

    expect(result.lines.join("\n")).toContain("did not match");
    expect(await fs.readFile(targetFile, "utf8")).toBe(before);
  });

  it("applies safely when the LLM diff parses and validation succeeds", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const diff = [
      "TARGET_FILE: node-prompts/analyze_results.md",
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1 +1 @@",
      "-Prompt",
      "+Prompt improved"
    ].join("\n");
    const applyWithSafetyNet = vi.fn().mockResolvedValue({
      applied: true,
      targetFile,
      gitCommitBefore: "abc123",
      validationPassed: true,
      rolledBack: false,
      rollbackReason: null,
      auditLogPath: path.join(workspace, ".autolabos", "harness-apply-log.jsonl")
    });

    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results"]
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace),
        callLlm: vi.fn().mockResolvedValue(diff),
        applyWithSafetyNet
      }
    );

    expect(applyWithSafetyNet).toHaveBeenCalledTimes(1);
    expect(result.lines.join("\n")).toContain("Applied safely and committed");
  });

  it("reports rollback when validation fails during apply", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const diff = [
      "TARGET_FILE: node-prompts/analyze_results.md",
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1 +1 @@",
      "-Prompt",
      "+Prompt improved"
    ].join("\n");
    const applyWithSafetyNet = vi.fn().mockResolvedValue({
      applied: false,
      targetFile: path.join(workspace, "node-prompts", "analyze_results.md"),
      gitCommitBefore: "abc123",
      validationPassed: false,
      rolledBack: true,
      rollbackReason: "validate failed",
      auditLogPath: path.join(workspace, ".autolabos", "harness-apply-log.jsonl")
    });

    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results"]
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace),
        callLlm: vi.fn().mockResolvedValue(diff),
        applyWithSafetyNet
      }
    );

    expect(result.lines.join("\n")).toContain("restored original file");
  });
});

describe("parseMetaHarnessResponse", () => {
  it("returns null when the response format is invalid", () => {
    expect(parseMetaHarnessResponse("hello")).toBeNull();
  });
});

async function createWorkspaceWithCompletedRun(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-meta-harness-"));
  cleanupPaths.push(workspace);
  const runRoot = path.join(workspace, ".autolabos", "runs", "run-1");
  await fs.mkdir(path.join(runRoot, "review"), { recursive: true });
  await fs.mkdir(path.join(runRoot, "paper"), { recursive: true });
  await fs.mkdir(path.join(workspace, "node-prompts"), { recursive: true });
  await fs.mkdir(path.join(workspace, "outputs", "eval-harness"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, ".autolabos", "runs", "run-1", "events.jsonl"),
    [
      JSON.stringify(makeEvent("run-1", "analyze_results", "NODE_STARTED")),
      JSON.stringify(makeEvent("run-1", "review", "NODE_COMPLETED"))
    ].join("\n") + "\n",
    "utf8"
  );
  await fs.writeFile(path.join(runRoot, "result_analysis.json"), JSON.stringify({ summary: "analysis" }, null, 2), "utf8");
  await fs.writeFile(path.join(runRoot, "review", "decision.json"), JSON.stringify({ outcome: "revise" }, null, 2), "utf8");
  await fs.writeFile(path.join(runRoot, "review", "minimum_gate.json"), JSON.stringify({ passed: false }, null, 2), "utf8");
  await fs.writeFile(
    path.join(runRoot, "review", "paper_scale_diagnostics.json"),
    JSON.stringify({ diagnostics: [{ id: "tiny_eval_sample", target_node: "run_experiments" }] }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(runRoot, "review", "node_strengthening_recommendations.json"),
    JSON.stringify({
      recommendations: [
        { node: "run_experiments", priority: "high" },
        {
          node: "write_paper",
          priority: "high",
          diagnostic_ids: ["finding:paper_repeated_citation_bundle"],
          problem_summary: "Paper surface defect must be blocked before accepting the manuscript.",
          recheck_condition: "paper/render_validation.json passes and repeated citations are gone."
        }
      ]
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(path.join(runRoot, "review", "readiness_risks.json"), JSON.stringify({ risks: [] }, null, 2), "utf8");
  await fs.writeFile(path.join(runRoot, "review", "paper_quality_evaluation.json"), JSON.stringify({ overall_score_1_to_10: 2 }, null, 2), "utf8");
  await fs.writeFile(path.join(runRoot, "review", "paper_critique.json"), JSON.stringify({ manuscript_type: "research_memo" }, null, 2), "utf8");
  await fs.writeFile(
    path.join(runRoot, "paper", "paper_readiness.json"),
    JSON.stringify({ paper_ready: false, overall_score: 6.5 }, null, 2),
    "utf8"
  );
  await fs.writeFile(path.join(workspace, "node-prompts", "analyze_results.md"), "Prompt\n", "utf8");
  await fs.writeFile(path.join(workspace, "node-prompts", "design_experiments.md"), "Design prompt\n", "utf8");
  await fs.writeFile(path.join(workspace, "node-prompts", "review.md"), "Review prompt\n", "utf8");
  await fs.writeFile(path.join(workspace, "outputs", "eval-harness", "history.jsonl"), "{\"timestamp\":\"2026-04-02T00:00:00.000Z\"}\n", "utf8");
  return workspace;
}

async function createExternalRunRoot(
  name: string,
  options: {
    resultAnalysis?: boolean;
    reviewDecision?: boolean;
    paperReadiness?: boolean;
    unrelated?: boolean;
  }
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `autolabos-meta-harness-${name}-`));
  cleanupPaths.push(root);
  await fs.mkdir(path.join(root, "review"), { recursive: true });
  await fs.mkdir(path.join(root, "paper"), { recursive: true });
  if (options.resultAnalysis) {
    await fs.writeFile(path.join(root, "result_analysis.json"), JSON.stringify({ summary: name }, null, 2), "utf8");
  }
  if (options.reviewDecision) {
    await fs.writeFile(path.join(root, "review", "decision.json"), JSON.stringify({ outcome: "revise" }, null, 2), "utf8");
  }
  if (options.paperReadiness) {
    await fs.writeFile(
      path.join(root, "paper", "paper_readiness.json"),
      JSON.stringify({ paper_ready: false, overall_score: 5 }, null, 2),
      "utf8"
    );
  }
  if (options.unrelated) {
    await fs.writeFile(path.join(root, "secret.txt"), "do not copy\n", "utf8");
  }
  return root;
}

function fakeBootstrapRuntime(workspace: string) {
  return vi.fn().mockResolvedValue({
    configured: true,
    firstRunSetup: false,
    paths: { cwd: workspace },
    runtime: {
      paths: { cwd: workspace },
      config: {
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: {
            model: "gpt-5.3-codex",
            reasoning_effort: "medium",
            fast_mode: false
          },
          openai: {
            model: "gpt-5.1",
            reasoning_effort: "medium"
          },
          ollama: {
            base_url: "http://127.0.0.1:11434"
          }
        }
      },
      codex: {},
      openAiTextClient: {},
      runStore: {
        listRuns: vi.fn().mockResolvedValue([
          {
            id: "run-1",
            title: "Run 1",
            topic: "Topic",
            objectiveMetric: "metric",
            constraints: [],
            status: "completed",
            currentNode: "write_paper",
            latestSummary: "done",
            nodeThreads: {},
            createdAt: "2026-04-02T00:00:00.000Z",
            updatedAt: "2026-04-02T00:00:00.000Z",
            graph: {} as never,
            memoryRefs: {
              runContextPath: ".autolabos/runs/run-1/memory/run_context.json",
              longTermPath: ".autolabos/runs/run-1/memory/long_term.jsonl",
              episodePath: ".autolabos/runs/run-1/memory/episodes.jsonl"
            }
          }
        ])
      }
    }
  });
}

function makeEvent(runId: string, node: "analyze_results" | "review", type: "NODE_STARTED" | "NODE_COMPLETED") {
  return {
    id: `evt-${node}`,
    type,
    timestamp: "2026-04-02T00:00:00.000Z",
    runId,
    node,
    payload: {}
  };
}
