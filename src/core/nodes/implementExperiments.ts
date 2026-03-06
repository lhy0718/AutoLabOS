import path from "node:path";

import { RunContextMemory } from "../memory/runContextMemory.js";
import { GraphNodeHandler } from "../stateGraph/types.js";
import { NodeExecutionDeps } from "./types.js";

export function createImplementExperimentsNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "implement_experiments",
    async execute({ run, graph }) {
      const scriptPath = path.join(".autoresearch", "runs", run.id, "experiment.py");
      const script = [
        "import json",
        "import random",
        "",
        "def main():",
        "    metrics = {",
        "        'accuracy': round(0.6 + random.random() * 0.35, 4),",
        "        'f1': round(0.5 + random.random() * 0.45, 4)",
        "    }",
        "    with open('metrics.json', 'w', encoding='utf-8') as f:",
        "        json.dump(metrics, f, indent=2)",
        "",
        "if __name__ == '__main__':",
        "    main()"
      ].join("\n");

      const writeObs = await deps.aci.writeFile(scriptPath, script);

      deps.eventStream.emit({
        type: "PATCH_APPLIED",
        runId: run.id,
        node: "implement_experiments",
        payload: {
          file: scriptPath,
          status: writeObs.status
        }
      });

      if (writeObs.status !== "ok") {
        return {
          status: "failure",
          error: writeObs.stderr || "Failed to write experiment implementation",
          toolCallsUsed: 1
        };
      }

      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      await runContextMemory.put("implement_experiments.script", scriptPath);

      return {
        status: "success",
        summary: `Implementation prepared at ${scriptPath}`,
        needsApproval: true,
        toolCallsUsed: 1
      };
    }
  };
}
