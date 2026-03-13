import { EpisodeMemory } from "../../memory/episodeMemory.js";
import { EventStream } from "../../events.js";
import { GraphNodeId } from "../../../types.js";

export async function saveReflexion(args: {
  runId: string;
  nodeId: GraphNodeId;
  attempt: number;
  errorMessage: string;
  planExcerpt: string;
  observations: string[];
  episodeMemory: EpisodeMemory;
  eventStream: EventStream;
}): Promise<void> {
  const lesson = deriveLesson(args.errorMessage, args.observations);
  const nextInstruction = `Next attempt should avoid: ${args.errorMessage}. Apply lesson: ${lesson}`;

  const record = await args.episodeMemory.save({
    run_id: args.runId,
    node_id: args.nodeId,
    attempt: args.attempt,
    error_class: classifyError(args.errorMessage),
    error_message: args.errorMessage,
    plan_excerpt: args.planExcerpt,
    observations: args.observations,
    lesson,
    next_try_instruction: nextInstruction
  });

  args.eventStream.emit({
    type: "REFLECTION_SAVED",
    runId: args.runId,
    node: args.nodeId,
    payload: { episode_id: record.episode_id, lesson: record.lesson }
  });
}

function classifyError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("timeout")) {
    return "timeout";
  }
  if (lower.includes("limit")) {
    return "limit";
  }
  if (lower.includes("auth") || lower.includes("permission")) {
    return "auth";
  }
  if (lower.includes("network")) {
    return "network";
  }
  return "runtime";
}

function deriveLesson(errorMessage: string, observations: string[]): string {
  const shortObs = observations.slice(-2).join(" | ");
  return `Error(${errorMessage.slice(0, 120)}) with observations(${shortObs.slice(0, 180)}). Reduce scope and verify prerequisites first.`;
}
