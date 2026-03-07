import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureScaffold, resolveAppPaths } from "../src/config.js";
import { InMemoryEventStream } from "../src/core/events.js";
import { ImplementSessionManager } from "../src/core/agents/implementSessionManager.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { RunStore } from "../src/core/runs/runStore.js";
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
            metrics_path: path.join(runDir, "metrics.json")
          }),
          events: []
        };
      }
    } as unknown as CodexCliClient;

    const eventStream = new InMemoryEventStream();
    const manager = new ImplementSessionManager({
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
    expect(result.changedFiles).toContain(scriptPath);
    expect(updatedRun?.nodeThreads.implement_experiments).toBe("thread-impl-1");
    expect(await memory.get("implement_experiments.run_command")).toBe(result.runCommand);
    expect(await memory.get("implement_experiments.script")).toBe(scriptPath);
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
    const codex = {
      runTurnStream: async ({ onEvent }: { onEvent?: (event: Record<string, unknown>) => void }) => {
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
  });
});
