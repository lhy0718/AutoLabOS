import { describe, expect, it } from "vitest";

import { isGraphNodeId, migrateAnyRunsFileToV3, migrateRunsFileV1ToV2, migrateRunsFileV2ToV3 } from "../src/core/runs/migrateRuns.js";

describe("migrate runs to v3", () => {
  it("migrates v1 -> v2 -> v3 and maps execute stage to graph nodes", () => {
    const ts = new Date().toISOString();
    const v1 = {
      version: 1 as const,
      runs: [
        {
          id: "run-1",
          title: "Legacy run",
          topic: "agents",
          constraints: [],
          objectiveMetric: "f1",
          status: "paused" as const,
          currentStage: "execute" as const,
          latestSummary: "legacy summary",
          implementThreadId: "thread-xyz",
          createdAt: ts,
          updatedAt: ts,
          stages: {
            collect: { status: "completed" as const, updatedAt: ts },
            analyze: { status: "completed" as const, updatedAt: ts },
            hypothesize: { status: "completed" as const, updatedAt: ts },
            design: { status: "completed" as const, updatedAt: ts },
            implement: { status: "completed" as const, updatedAt: ts },
            execute: { status: "needs_approval" as const, updatedAt: ts },
            results: { status: "pending" as const, updatedAt: ts },
            write: { status: "pending" as const, updatedAt: ts }
          }
        }
      ]
    };

    const v2 = migrateRunsFileV1ToV2(v1);
    expect(v2.version).toBe(2);
    expect(v2.runs[0].currentAgent).toBe("experiment_runner");

    const v3 = migrateRunsFileV2ToV3(v2);
    expect(v3.version).toBe(3);
    expect(v3.runs[0].version).toBe(3);
    expect(v3.runs[0].workflowVersion).toBe(3);
    expect(v3.runs[0].currentNode).toBe("implement_experiments");
    expect(v3.runs[0].nodeThreads.implement_experiments).toBe("thread-xyz");
    expect(v3.runs[0].graph.nodeStates.implement_experiments.status).toBe("needs_approval");
  });

  it("migrateAnyRunsFileToV3 accepts v1/v2 and keeps graph node ids valid", () => {
    const ts = new Date().toISOString();
    const migrated = migrateAnyRunsFileToV3({
      version: 2,
      runs: [
        {
          version: 2,
          id: "run-2",
          title: "v2 run",
          topic: "topic",
          constraints: [],
          objectiveMetric: "acc",
          status: "running",
          currentAgent: "literature",
          latestSummary: "",
          agentThreads: {},
          createdAt: ts,
          updatedAt: ts,
          agents: {
            literature: { status: "running", updatedAt: ts },
            idea: { status: "pending", updatedAt: ts },
            hypothesis: { status: "pending", updatedAt: ts },
            experiment_designer: { status: "pending", updatedAt: ts },
            experiment_runner: { status: "pending", updatedAt: ts },
            result_analyzer: { status: "pending", updatedAt: ts },
            paper_writer: { status: "pending", updatedAt: ts }
          }
        }
      ]
    });

    expect(migrated.version).toBe(3);
    expect(isGraphNodeId(migrated.runs[0].currentNode)).toBe(true);
  });
});
