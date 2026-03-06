import { EventStream } from "../../events.js";
import { GraphNodeId } from "../../../types.js";

export interface PlanStep {
  id: string;
  tool: string;
  inputTemplate: string;
  outputVar: string;
  dependsOn: string[];
}

export interface WorkerTool {
  name: string;
  run(input: string): Promise<string>;
}

export interface ReWOOResult {
  plan: PlanStep[];
  vars: Record<string, string>;
  summary: string;
  toolCallsUsed: number;
}

export async function executeReWOO(args: {
  runId: string;
  node: GraphNodeId;
  plan: PlanStep[];
  tools: WorkerTool[];
  eventStream: EventStream;
}): Promise<ReWOOResult> {
  const vars: Record<string, string> = {};
  let toolCallsUsed = 0;

  for (const step of args.plan) {
    const tool = args.tools.find((t) => t.name === step.tool);
    if (!tool) {
      vars[step.outputVar] = `missing tool: ${step.tool}`;
      continue;
    }

    const input = interpolate(step.inputTemplate, vars);
    args.eventStream.emit({
      type: "TOOL_CALLED",
      runId: args.runId,
      node: args.node,
      payload: { step: step.id, tool: step.tool, input }
    });

    const output = await tool.run(input);
    vars[step.outputVar] = output;
    toolCallsUsed += 1;

    args.eventStream.emit({
      type: "OBS_RECEIVED",
      runId: args.runId,
      node: args.node,
      payload: { step: step.id, outputVar: step.outputVar, output }
    });
  }

  const summary = Object.entries(vars)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  return {
    plan: args.plan,
    vars,
    summary,
    toolCallsUsed
  };
}

export function buildDefaultPlan(goal: string): PlanStep[] {
  return [
    {
      id: "p1",
      tool: "summarize",
      inputTemplate: goal,
      outputVar: "summary",
      dependsOn: []
    },
    {
      id: "p2",
      tool: "finalize",
      inputTemplate: "Use summary: {{summary}}",
      outputVar: "final",
      dependsOn: ["p1"]
    }
  ];
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key) => vars[key] ?? "");
}
