import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureScaffold, resolveAppPaths } from "../src/config.js";
import { InMemoryEventStream } from "../src/core/events.js";
import { ImplementSessionManager } from "../src/core/agents/implementSessionManager.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { RunStore } from "../src/core/runs/runStore.js";
import { buildPublicExperimentDir } from "../src/core/publicArtifacts.js";
import { CodexCliClient } from "../src/integrations/codex/codexCliClient.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ImplementSessionManager", () => {
  it("persists thread id and run command from Codex session", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autoresearch-implement-session-"));
    tempDirs.push(workspace);
    const paths = resolveAppPaths(workspace);
    await ensureScaffold(paths);

    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Implementation Run",
      topic: "agent reasoning",
      constraints: ["recent"],
      objectiveMetric: "accuracy"
    });

    const runDir = path.join(workspace, ".autoresearch", "runs", run.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "experiment_plan.yaml"), "hypotheses:\n  - baseline\n", "utf8");

    const scriptPath = path.join(runDir, "experiment.py");
    const publicDir = buildPublicExperimentDir(workspace, run);
    const codex = {
      runTurnStream: async ({ onEvent }: { onEvent?: (event: Record<string, unknown>) => void }) => {
        writeFileSync(scriptPath, "print('ok')\n", "utf8");
        onEvent?.({ type: "file.changed", path: scriptPath });
        return {
          threadId: "thread-impl-1",
          finalText: JSON.stringify({
            summary: "Implemented a runnable experiment script.",
            run_command: `python3 ${JSON.stringify(scriptPath)}`,
            changed_files: [scriptPath],
            artifacts: [scriptPath],
            script_path: scriptPath,
            metrics_path: path.join(runDir, "metrics.json"),
            experiment_mode: "real_execution"
          }),
          events: []
        };
      }
    } as unknown as CodexCliClient;

    const eventStream = new InMemoryEventStream();
    const manager = new ImplementSessionManager({
      config: {
        version: 1,
        project_name: "test",
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: {
            model: "gpt-5.4",
            chat_model: "gpt-5.4",
            experiment_model: "gpt-5.4",
            pdf_model: "gpt-5.4",
            reasoning_effort: "xhigh",
            chat_reasoning_effort: "low",
            experiment_reasoning_effort: "xhigh",
            pdf_reasoning_effort: "xhigh",
            command_reasoning_effort: "low",
            fast_mode: false,
            chat_fast_mode: false,
            experiment_fast_mode: false,
            pdf_fast_mode: false,
            auth_required: true
          },
          openai: {
            model: "gpt-5.4",
            chat_model: "gpt-5.4",
            experiment_model: "gpt-5.4",
            pdf_model: "gpt-5.4",
            reasoning_effort: "medium",
            chat_reasoning_effort: "low",
            experiment_reasoning_effort: "medium",
            pdf_reasoning_effort: "medium",
            command_reasoning_effort: "low",
            api_key_required: true
          }
        },
        analysis: {
          pdf_mode: "codex_text_image_hybrid",
          responses_model: "gpt-5.4",
          responses_reasoning_effort: "xhigh"
        },
        papers: { max_results: 200, per_second_limit: 1 },
        research: {
          default_topic: "Multi-agent collaboration",
          default_constraints: ["recent papers"],
          default_objective_metric: "reproducibility"
        },
        workflow: { mode: "agent_approval", wizard_enabled: true },
        experiments: { runner: "local_python", timeout_sec: 3600, allow_network: false },
        paper: { template: "acl", build_pdf: true, latex_engine: "auto_install" },
        paths: { runs_dir: ".autoresearch/runs", logs_dir: ".autoresearch/logs" }
      },
      codex,
      eventStream,
      runStore,
      workspaceRoot: workspace
    });

    const result = await manager.run(run);
    const updatedRun = await runStore.getRun(run.id);
    const memory = new RunContextMemory(run.memoryRefs.runContextPath);

    expect(result.threadId).toBe("thread-impl-1");
    expect(result.runCommand).toContain("python3");
    expect(result.changedFiles).toContain(path.join(publicDir, "experiment.py"));
    expect(result.scriptPath).toBe(path.join(publicDir, "experiment.py"));
    expect(result.publicDir).toBe(publicDir);
    expect(result.publicArtifacts).toContain(path.join(publicDir, "experiment.py"));
    expect(updatedRun?.nodeThreads.implement_experiments).toBe("thread-impl-1");
    expect(await memory.get("implement_experiments.run_command")).toBe(result.runCommand);
    expect(await memory.get("implement_experiments.script")).toBe(path.join(publicDir, "experiment.py"));
    expect(await memory.get("implement_experiments.public_dir")).toBe(publicDir);
    expect(await memory.get("implement_experiments.mode")).toBe("real_execution");
    expect(eventStream.history().some((event) => event.type === "PATCH_APPLIED")).toBe(true);
  });

  it("emits coalesced intermediate Codex output", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autoresearch-implement-stream-"));
    tempDirs.push(workspace);
    const paths = resolveAppPaths(workspace);
    await ensureScaffold(paths);

    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Implementation Stream",
      topic: "agent reasoning",
      constraints: [],
      objectiveMetric: "accuracy"
    });

    const runDir = path.join(workspace, ".autoresearch", "runs", run.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "experiment_plan.yaml"), "hypotheses:\n  - baseline\n", "utf8");

    const scriptPath = path.join(runDir, "experiment.py");
    const publicDir = buildPublicExperimentDir(workspace, run);
    let capturedPrompt = "";
    let capturedSystemPrompt = "";
    const codex = {
      runTurnStream: async ({
        onEvent,
        prompt,
        systemPrompt
      }: {
        onEvent?: (event: Record<string, unknown>) => void;
        prompt?: string;
        systemPrompt?: string;
      }) => {
        capturedPrompt = prompt || "";
        capturedSystemPrompt = systemPrompt || "";
        onEvent?.({ type: "response.output_text.delta", delta: "Writing experiment " });
        onEvent?.({ type: "response.output_text.delta", delta: "script now." });
        writeFileSync(scriptPath, "print('ok')\n", "utf8");
        return {
          threadId: "thread-impl-2",
          finalText: JSON.stringify({
            summary: "Implemented a runnable experiment script.",
            run_command: `python3 ${JSON.stringify(scriptPath)}`,
            changed_files: [scriptPath],
            artifacts: [scriptPath],
            script_path: scriptPath,
            metrics_path: path.join(runDir, "metrics.json")
          }),
          events: []
        };
      }
    } as unknown as CodexCliClient;

    const eventStream = new InMemoryEventStream();
    const manager = new ImplementSessionManager({
      config: {
        version: 1,
        project_name: "test",
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: {
            model: "gpt-5.4",
            chat_model: "gpt-5.4",
            experiment_model: "gpt-5.4",
            pdf_model: "gpt-5.4",
            reasoning_effort: "xhigh",
            chat_reasoning_effort: "low",
            experiment_reasoning_effort: "xhigh",
            pdf_reasoning_effort: "xhigh",
            command_reasoning_effort: "low",
            fast_mode: false,
            chat_fast_mode: false,
            experiment_fast_mode: false,
            pdf_fast_mode: false,
            auth_required: true
          },
          openai: {
            model: "gpt-5.4",
            chat_model: "gpt-5.4",
            experiment_model: "gpt-5.4",
            pdf_model: "gpt-5.4",
            reasoning_effort: "medium",
            chat_reasoning_effort: "low",
            experiment_reasoning_effort: "medium",
            pdf_reasoning_effort: "medium",
            command_reasoning_effort: "low",
            api_key_required: true
          }
        },
        analysis: {
          pdf_mode: "codex_text_image_hybrid",
          responses_model: "gpt-5.4",
          responses_reasoning_effort: "xhigh"
        },
        papers: { max_results: 200, per_second_limit: 1 },
        research: {
          default_topic: "Multi-agent collaboration",
          default_constraints: ["recent papers"],
          default_objective_metric: "reproducibility"
        },
        workflow: { mode: "agent_approval", wizard_enabled: true },
        experiments: { runner: "local_python", timeout_sec: 3600, allow_network: false },
        paper: { template: "acl", build_pdf: true, latex_engine: "auto_install" },
        paths: { runs_dir: ".autoresearch/runs", logs_dir: ".autoresearch/logs" }
      },
      codex,
      eventStream,
      runStore,
      workspaceRoot: workspace
    });

    await manager.run(run);

    const obs = eventStream
      .history()
      .filter((event) => event.type === "OBS_RECEIVED")
      .map((event) => event.payload.text);
    expect(obs).toContain("Writing experiment script now.");
    expect(capturedPrompt).toContain(`Public experiment directory: ${publicDir}`);
    expect(capturedSystemPrompt).toContain(`Preferred public experiment directory: ${publicDir}`);
    expect(capturedSystemPrompt).toContain("Use a synthetic validation harness only as a fallback");
    expect(capturedSystemPrompt).toContain("Configured real-execution LLM: provider=codex, model=gpt-5.4, reasoning=xhigh");
  });

  it("promotes synthetic reproducibility runs to the reusable real_execution bundle", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autoresearch-implement-promote-"));
    tempDirs.push(workspace);
    const paths = resolveAppPaths(workspace);
    await ensureScaffold(paths);

    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Reproducibility Promotion",
      topic: "Multi-agent collaboration",
      constraints: ["recent papers", "last five years"],
      objectiveMetric: "state-of-the-art reproducibility"
    });

    const runDir = path.join(workspace, ".autoresearch", "runs", run.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "experiment_plan.yaml"), "hypotheses:\n  - shared-state schema\n", "utf8");

    const syntheticScriptPath = path.join(runDir, "experiment.py");
    const publicDir = buildPublicExperimentDir(workspace, run);
    const codex = {
      runTurnStream: async () => {
        writeFileSync(syntheticScriptPath, "print('synthetic')\n", "utf8");
        return {
          threadId: "thread-impl-promote",
          finalText: JSON.stringify({
            summary: "Implemented a synthetic validation harness because a real benchmark path was not obvious.",
            run_command: `python3 ${JSON.stringify(syntheticScriptPath)}`,
            changed_files: [syntheticScriptPath],
            artifacts: [syntheticScriptPath],
            script_path: syntheticScriptPath,
            metrics_path: path.join(runDir, "metrics.json"),
            experiment_mode: "synthetic_validation"
          }),
          events: []
        };
      }
    } as unknown as CodexCliClient;

    const eventStream = new InMemoryEventStream();
    const manager = new ImplementSessionManager({
      config: {
        version: 1,
        project_name: "test",
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: {
            model: "gpt-5.4",
            chat_model: "gpt-5.4",
            experiment_model: "gpt-5.4",
            pdf_model: "gpt-5.4",
            reasoning_effort: "xhigh",
            chat_reasoning_effort: "low",
            experiment_reasoning_effort: "xhigh",
            pdf_reasoning_effort: "xhigh",
            command_reasoning_effort: "low",
            fast_mode: false,
            chat_fast_mode: false,
            experiment_fast_mode: false,
            pdf_fast_mode: false,
            auth_required: true
          },
          openai: {
            model: "gpt-5.4",
            chat_model: "gpt-5.4",
            experiment_model: "gpt-5.4",
            pdf_model: "gpt-5.4",
            reasoning_effort: "medium",
            chat_reasoning_effort: "low",
            experiment_reasoning_effort: "medium",
            pdf_reasoning_effort: "medium",
            command_reasoning_effort: "low",
            api_key_required: true
          }
        },
        analysis: {
          pdf_mode: "codex_text_extract",
          responses_model: "gpt-5.4",
          responses_reasoning_effort: "xhigh"
        },
        papers: { max_results: 200, per_second_limit: 1 },
        research: {
          default_topic: "Multi-agent collaboration",
          default_constraints: ["recent papers"],
          default_objective_metric: "reproducibility"
        },
        workflow: { mode: "agent_approval", wizard_enabled: true },
        experiments: { runner: "local_python", timeout_sec: 3600, allow_network: true },
        paper: { template: "acl", build_pdf: true, latex_engine: "auto_install" },
        paths: { runs_dir: ".autoresearch/runs", logs_dir: ".autoresearch/logs" }
      },
      codex,
      eventStream,
      runStore,
      workspaceRoot: workspace
    });

    const result = await manager.run(run);
    const memory = new RunContextMemory(run.memoryRefs.runContextPath);

    expect(result.experimentMode).toBe("real_execution");
    expect(result.scriptPath).toBe(path.join(publicDir, "run_experiment.py"));
    expect(result.runCommand).toContain(path.join(publicDir, "run_experiment.py"));
    expect(await memory.get("implement_experiments.mode")).toBe("real_execution");

    const publicConfig = JSON.parse(readFileSync(path.join(publicDir, "experiment_config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(publicConfig.llm_profile).toMatchObject({
      provider: "codex",
      model: "gpt-5.4",
      reasoning_effort: "xhigh"
    });
    expect(result.publicArtifacts).toContain(path.join(publicDir, "README.md"));
  });

  it("replaces incompatible real_execution commands with the managed public bundle", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autoresearch-implement-managed-real-"));
    tempDirs.push(workspace);
    const paths = resolveAppPaths(workspace);
    await ensureScaffold(paths);

    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Managed Real Execution",
      topic: "Multi-agent collaboration",
      constraints: ["recent papers", "last five years"],
      objectiveMetric: "state-of-the-art reproducibility"
    });

    const runDir = path.join(workspace, ".autoresearch", "runs", run.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "experiment_plan.yaml"), "hypotheses:\n  - shared-state schema\n", "utf8");

    const publicDir = buildPublicExperimentDir(workspace, run);
    const incompatibleScriptPath = path.join(publicDir, "run_experiment.py");
    const codex = {
      runTurnStream: async () => {
        mkdirSync(publicDir, { recursive: true });
        writeFileSync(incompatibleScriptPath, "print('custom real execution')\n", "utf8");
        return {
          threadId: "thread-impl-managed-real",
          finalText: JSON.stringify({
            summary: "Implemented a real execution runner.",
            run_command: `python3 ${JSON.stringify(incompatibleScriptPath)} --metadata-dir ${JSON.stringify(runDir)} --metrics-out ${JSON.stringify(path.join(runDir, "metrics.json"))}`,
            changed_files: [incompatibleScriptPath],
            artifacts: [incompatibleScriptPath],
            public_dir: publicDir,
            public_artifacts: [incompatibleScriptPath],
            script_path: incompatibleScriptPath,
            metrics_path: path.join(runDir, "metrics.json"),
            experiment_mode: "real_execution"
          }),
          events: []
        };
      }
    } as unknown as CodexCliClient;

    const eventStream = new InMemoryEventStream();
    const manager = new ImplementSessionManager({
      config: {
        version: 1,
        project_name: "test",
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: {
            model: "gpt-5.4",
            chat_model: "gpt-5.4",
            experiment_model: "gpt-5.4",
            pdf_model: "gpt-5.4",
            reasoning_effort: "xhigh",
            chat_reasoning_effort: "low",
            experiment_reasoning_effort: "xhigh",
            pdf_reasoning_effort: "xhigh",
            command_reasoning_effort: "low",
            fast_mode: false,
            chat_fast_mode: false,
            experiment_fast_mode: false,
            pdf_fast_mode: false,
            auth_required: true
          },
          openai: {
            model: "gpt-5.4",
            chat_model: "gpt-5.4",
            experiment_model: "gpt-5.4",
            pdf_model: "gpt-5.4",
            reasoning_effort: "medium",
            chat_reasoning_effort: "low",
            experiment_reasoning_effort: "medium",
            pdf_reasoning_effort: "medium",
            command_reasoning_effort: "low",
            api_key_required: true
          }
        },
        analysis: {
          pdf_mode: "codex_text_extract",
          responses_model: "gpt-5.4",
          responses_reasoning_effort: "xhigh"
        },
        papers: { max_results: 200, per_second_limit: 1 },
        research: {
          default_topic: "Multi-agent collaboration",
          default_constraints: ["recent papers"],
          default_objective_metric: "reproducibility"
        },
        workflow: { mode: "agent_approval", wizard_enabled: true },
        experiments: { runner: "local_python", timeout_sec: 3600, allow_network: true },
        paper: { template: "acl", build_pdf: true, latex_engine: "auto_install" },
        paths: { runs_dir: ".autoresearch/runs", logs_dir: ".autoresearch/logs" }
      },
      codex,
      eventStream,
      runStore,
      workspaceRoot: workspace
    });

    const result = await manager.run(run);

    expect(result.experimentMode).toBe("real_execution");
    expect(result.scriptPath).toBe(path.join(publicDir, "run_experiment.py"));
    expect(result.runCommand).toContain(path.join(publicDir, "run_experiment.py"));
    expect(result.runCommand).not.toContain("--metadata-dir");
    expect(result.testCommand).toContain("py_compile");
    expect(readFileSync(path.join(publicDir, "README.md"), "utf8")).toContain("Shared-State Schema vs Free-Form Chat");
  });
});
