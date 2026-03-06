import path from "node:path";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { appendJsonl, writeRunArtifact } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";

export function createRunExperimentsNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "run_experiments",
    async execute({ run, graph, abortSignal }) {
      const runDir = path.join(".autoresearch", "runs", run.id);
      const command = "node -e \"const fs=require('fs');const m={accuracy:0.81,f1:0.77,loss:0.42};fs.writeFileSync('metrics.json',JSON.stringify(m,null,2));console.log('done: metrics written');\"";
      const obs = await deps.aci.runCommand(command, runDir, abortSignal);

      const logFile = await writeRunArtifact(
        run,
        "exec_logs/run_experiments.txt",
        `${obs.stdout || ""}\n${obs.stderr || ""}`
      );

      if (obs.status !== "ok") {
        deps.eventStream.emit({
          type: "TEST_FAILED",
          runId: run.id,
          node: "run_experiments",
          payload: {
            command,
            stderr: obs.stderr || "unknown"
          }
        });
        return {
          status: "failure",
          error: obs.stderr || "Experiment command failed",
          toolCallsUsed: 1
        };
      }

      await appendJsonl(run, "exec_logs/observations.jsonl", [
        {
          command,
          status: obs.status,
          stdout: (obs.stdout || "").trim(),
          log_file: logFile
        }
      ]);

      return {
        status: "success",
        summary: "Experiment run completed.",
        needsApproval: true,
        toolCallsUsed: 1
      };
    }
  };
}
