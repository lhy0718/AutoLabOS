import path from "node:path";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { ImplementSessionManager } from "../agents/implementSessionManager.js";
import { NodeExecutionDeps } from "./types.js";

export function createImplementExperimentsNode(deps: NodeExecutionDeps): GraphNodeHandler {
  const sessions = new ImplementSessionManager({
    config: deps.config,
    codex: deps.codex,
    aci: deps.aci,
    eventStream: deps.eventStream,
    runStore: deps.runStore,
    workspaceRoot: process.cwd()
  });

  return {
    id: "implement_experiments",
    async execute({ run, abortSignal }) {
      const result = await sessions.run(run, abortSignal);
      const publicOutputRoot = path.relative(process.cwd(), result.publicDir).replace(/\\/g, "/");
      return {
        status: "success",
        summary: result.handoffReason
          ? `${result.summary} ${result.handoffReason} Public outputs: ${publicOutputRoot}.`
          : `${result.summary} Public outputs: ${publicOutputRoot}.`,
        needsApproval: !result.autoHandoffToRunExperiments,
        toolCallsUsed: Math.max(1, result.changedFiles.length)
      };
    }
  };
}
