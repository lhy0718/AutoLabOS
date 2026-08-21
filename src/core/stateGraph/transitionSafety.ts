import { GraphNodeId, RunRecord } from "../../types.js";

export function isSafeAutoExecutableAdvance(
  run: Pick<RunRecord, "currentNode" | "graph">,
  sourceNode: GraphNodeId,
  targetNode: GraphNodeId
): boolean {
  const transition = run.graph.pendingTransition;
  return (
    run.currentNode === sourceNode &&
    run.graph.nodeStates[sourceNode].status === "needs_approval" &&
    transition?.action === "advance" &&
    transition.sourceNode === sourceNode &&
    transition.targetNode === targetNode &&
    transition.autoExecutable === true
  );
}
