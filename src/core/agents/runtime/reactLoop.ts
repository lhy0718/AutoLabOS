import { EventStream } from "../../events.js";
import { GraphNodeId } from "../../../types.js";

export interface ReActTool {
  name: string;
  run(input: string): Promise<{ status: "ok" | "error"; output: string; toolCallsUsed?: number }>;
}

export interface ReActResult {
  summary: string;
  observations: string[];
  steps: number;
  toolCallsUsed: number;
}

export async function runReActLoop(args: {
  runId: string;
  node: GraphNodeId;
  goal: string;
  tools: ReActTool[];
  maxSteps?: number;
  eventStream: EventStream;
}): Promise<ReActResult> {
  const maxSteps = args.maxSteps ?? 8;
  const observations: string[] = [];
  let toolCallsUsed = 0;

  for (let step = 0; step < maxSteps; step += 1) {
    const plan = `Step ${step + 1}: pursue goal - ${args.goal}`;
    args.eventStream.emit({
      type: "PLAN_CREATED",
      runId: args.runId,
      node: args.node,
      payload: { step, plan }
    });

    const tool = args.tools[step % Math.max(1, args.tools.length)];
    if (!tool) {
      observations.push("No tool available.");
      break;
    }

    args.eventStream.emit({
      type: "TOOL_CALLED",
      runId: args.runId,
      node: args.node,
      payload: { step, tool: tool.name }
    });

    const result = await tool.run(plan);
    toolCallsUsed += result.toolCallsUsed ?? 1;
    const obs = `[${tool.name}] ${result.status}: ${result.output}`;
    observations.push(obs);

    args.eventStream.emit({
      type: "OBS_RECEIVED",
      runId: args.runId,
      node: args.node,
      payload: { step, observation: obs }
    });

    if (result.status === "ok" && result.output.toLowerCase().includes("done")) {
      return {
        summary: result.output,
        observations,
        steps: step + 1,
        toolCallsUsed
      };
    }
  }

  return {
    summary: observations[observations.length - 1] || "No observation",
    observations,
    steps: maxSteps,
    toolCallsUsed
  };
}
