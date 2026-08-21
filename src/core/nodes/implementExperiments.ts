import path from "node:path";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { ImplementSessionManager, ImplementSessionStopError } from "../agents/implementSessionManager.js";
import { NodeExecutionDeps } from "./types.js";
import { EnvironmentSnapshot } from "../environmentSnapshot.js";
import { collectNonBlockingEnvironmentSnapshot } from "../runtime/environmentSnapshot.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import {
  loadResearchBriefSnapshot,
  resolveResearchRunModeGuard
} from "../runs/researchRunModeGuard.js";
import {
  loadTopicProbeExecutionAuthorizationGate,
  TOPIC_PROBE_EXECUTION_AUTHORIZATION_GATE_RELATIVE_PATH
} from "../runs/topicProbeExecutionAuthorizationGate.js";
import { writeRunArtifact } from "./helpers.js";

export interface ImplementExperimentsNodeOptions {
  collectEnvironmentSnapshot?: () => Promise<EnvironmentSnapshot>;
}

export function createImplementExperimentsNode(
  deps: NodeExecutionDeps,
  options: ImplementExperimentsNodeOptions = {}
): GraphNodeHandler {
  const sessions = new ImplementSessionManager({
    config: deps.config,
    codex: deps.codex,
    llm: deps.experimentLlm,
    aci: deps.aci,
    eventStream: deps.eventStream,
    runStore: deps.runStore,
    workspaceRoot: process.cwd()
  });

  return {
    id: "implement_experiments",
    async execute({ run, abortSignal }) {
      const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
      const memoryRawBrief = await runContext.get<string>("run_brief.raw");
      const snapshotBrief = await loadResearchBriefSnapshot(process.cwd(), run.id);
      const researchModeGuard = await resolveResearchRunModeGuard({
        workspaceRoot: process.cwd(),
        runId: run.id,
        rawBrief: memoryRawBrief || snapshotBrief,
        run,
        expectedResearchCycle: run.graph.researchCycle,
        requireActiveBoundedProbeLineage: true
      });
      if (!researchModeGuard.valid) {
        const message =
          "implement_experiments blocked because the persisted research mode and evidence lineage do not agree: "
          + researchModeGuard.reasons.join(", ");
        return {
          status: "failure",
          failureKind: "gate_blocked",
          error: message,
          summary: message,
          toolCallsUsed: 0
        };
      }
      if (researchModeGuard.effectiveMode === "topic_discovery") {
        const executionAuthorizationGate = await loadTopicProbeExecutionAuthorizationGate({
          workspaceRoot: process.cwd(),
          runId: run.id,
          expectedResearchCycle: run.graph.researchCycle
        });
        await runContext.put(
          "research_governance.topic_probe_execution_authorization",
          executionAuthorizationGate
        );
        await writeRunArtifact(
          run,
          TOPIC_PROBE_EXECUTION_AUTHORIZATION_GATE_RELATIVE_PATH,
          `${JSON.stringify(executionAuthorizationGate, null, 2)}\n`
        );
        if (!executionAuthorizationGate.effective_execution_authorized) {
          const message =
            "topic_probe_execution_preflight_blocked:"
            + executionAuthorizationGate.authorization.reason_codes.join(",");
          return {
            status: "failure",
            failureKind: "gate_blocked",
            error: message,
            summary: message,
            toolCallsUsed: 0
          };
        }
      }
      let result;
      try {
        const environmentSurface = await collectNonBlockingEnvironmentSnapshot(options.collectEnvironmentSnapshot);
        result = await sessions.run(
          run,
          abortSignal,
          environmentSurface.status === "available" ? environmentSurface.snapshot : undefined
        );
      } catch (error) {
        if (error instanceof ImplementSessionStopError) {
          return {
            status: "failure",
            failureKind: error.failureKind,
            summary: error.message,
            error: error.message,
            toolCallsUsed: error.toolCallsUsed
          };
        }
        throw error;
      }
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
