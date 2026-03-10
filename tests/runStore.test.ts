import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { ensureScaffold, resolveAppPaths } from "../src/config.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { RunStore } from "../src/core/runs/runStore.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("RunStore", () => {
  it("creates v3 run with graph defaults", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "autolabos-runstore-"));
    tempDirs.push(cwd);
    const paths = resolveAppPaths(cwd);
    await ensureScaffold(paths);

    const store = new RunStore(paths);
    const run = await store.createRun({
      title: "Test Run Title",
      topic: "ai agent",
      constraints: ["recent"],
      objectiveMetric: "accuracy"
    });

    expect(run.title).toBe("Test Run Title");
    expect(run.version).toBe(3);
    expect(run.workflowVersion).toBe(3);
    expect(run.currentNode).toBe("collect_papers");
    expect(run.graph.nodeStates.collect_papers.status).toBe("pending");
    expect(run.memoryRefs.runContextPath).toContain(run.id);

    const fetched = await store.getRun(run.id);
    expect(fetched?.title).toBe("Test Run Title");
  });

  it("searches runs by id and title", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "autolabos-runsearch-"));
    tempDirs.push(cwd);
    const paths = resolveAppPaths(cwd);
    await ensureScaffold(paths);

    const store = new RunStore(paths);
    const run = await store.createRun({
      title: "Planning Benchmark",
      topic: "planning",
      constraints: [],
      objectiveMetric: "f1"
    });

    const byId = await store.searchRuns(run.id.slice(0, 8));
    expect(byId.length).toBe(1);

    const byTitle = await store.searchRuns("benchmark");
    expect(byTitle.length).toBe(1);
  });

  it("normalizes existing v3 runs to include review state and review-target transitions", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "autolabos-runnormalize-"));
    tempDirs.push(cwd);
    const paths = resolveAppPaths(cwd);
    await ensureScaffold(paths);

    const graph = createDefaultGraphState();
    delete (graph.nodeStates as Partial<typeof graph.nodeStates>).review;
    graph.currentNode = "analyze_results";
    graph.nodeStates.analyze_results.status = "needs_approval";
    graph.pendingTransition = {
      action: "advance",
      sourceNode: "analyze_results",
      targetNode: "write_paper",
      reason: "legacy target",
      confidence: 0.88,
      autoExecutable: true,
      evidence: ["ok"],
      suggestedCommands: ["/approve"],
      generatedAt: new Date().toISOString()
    };

    await writeFile(
      paths.runsFile,
      `${JSON.stringify({
        version: 3,
        runs: [
          {
            version: 3,
            workflowVersion: 3,
            id: "legacy-run",
            title: "Legacy",
            topic: "topic",
            constraints: [],
            objectiveMetric: "acc",
            status: "paused",
            currentNode: "analyze_results",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            nodeThreads: {},
            graph,
            memoryRefs: {
              runContextPath: ".autolabos/runs/legacy-run/memory/run_context.json",
              longTermPath: ".autolabos/runs/legacy-run/memory/long_term.jsonl",
              episodePath: ".autolabos/runs/legacy-run/memory/episodes.jsonl"
            }
          }
        ]
      }, null, 2)}\n`,
      "utf8"
    );

    const store = new RunStore(paths);
    const run = await store.getRun("legacy-run");

    expect(run?.graph.nodeStates.review.status).toBe("pending");
    expect(run?.graph.pendingTransition?.targetNode).toBe("review");
  });
});
