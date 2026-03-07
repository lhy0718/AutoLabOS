import { GraphNodeHandler } from "../stateGraph/types.js";
import { ImplementSessionManager } from "../agents/implementSessionManager.js";
import { NodeExecutionDeps } from "./types.js";

export function createImplementExperimentsNode(deps: NodeExecutionDeps): GraphNodeHandler {
  const sessions = new ImplementSessionManager({
    codex: deps.codex,
    eventStream: deps.eventStream,
    runStore: deps.runStore,
    workspaceRoot: process.cwd()
  });

  return {
    id: "implement_experiments",
    async execute({ run, abortSignal }) {
      const result = await sessions.run(run, abortSignal);
      return {
        status: "success",
        summary: result.summary,
        needsApproval: true,
        toolCallsUsed: Math.max(1, result.changedFiles.length)
      };
    }
  };
}
