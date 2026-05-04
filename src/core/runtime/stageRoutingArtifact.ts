import path from "node:path";

import { GraphNodeId } from "../../types.js";
import { writeJsonFile } from "../../utils/fs.js";
import { buildWorkspaceRunRoot } from "../runs/runPaths.js";
import { CheckpointPhase } from "../stateGraph/types.js";

export type StageRoutingEvent =
  | "timeout_partial"
  | "checkpoint_write_failure"
  | "stale_resume_state";

export type StageRoutingDisposition =
  | "safe_pause"
  | "safe_retry"
  | "resume_current_state"
  | "manual_repair";

export interface StageRoutingArtifact {
  version: 1;
  run_id: string;
  node_id: GraphNodeId;
  event: StageRoutingEvent;
  phase?: CheckpointPhase;
  reason: string;
  disposition: StageRoutingDisposition;
  retry_safe: boolean;
  checkpoint_seq: number;
  created_at: string;
  evidence: string[];
  suggested_commands: string[];
}

export interface StageRoutingArtifactInput {
  runId: string;
  nodeId: GraphNodeId;
  event: StageRoutingEvent;
  phase?: CheckpointPhase;
  reason: string;
  disposition: StageRoutingDisposition;
  retrySafe: boolean;
  checkpointSeq: number;
  evidence?: string[];
  suggestedCommands?: string[];
  createdAt?: string;
}

export function buildStageRoutingArtifact(input: StageRoutingArtifactInput): StageRoutingArtifact {
  return {
    version: 1,
    run_id: input.runId,
    node_id: input.nodeId,
    event: input.event,
    phase: input.phase,
    reason: input.reason,
    disposition: input.disposition,
    retry_safe: input.retrySafe,
    checkpoint_seq: input.checkpointSeq,
    created_at: input.createdAt ?? new Date().toISOString(),
    evidence: sanitizeStringList(input.evidence),
    suggested_commands: sanitizeStringList(input.suggestedCommands)
  };
}

export async function writeStageRoutingArtifact(
  workspaceRoot: string,
  artifact: StageRoutingArtifact
): Promise<string> {
  const runRoot = buildWorkspaceRunRoot(workspaceRoot, artifact.run_id);
  const artifactDir = path.join(runRoot, "stage_routing");
  const fileName = `${formatArtifactTimestamp(artifact.created_at)}-${artifact.event}.json`;
  const artifactPath = path.join(artifactDir, fileName);
  await writeJsonFile(artifactPath, artifact);
  await writeJsonFile(path.join(artifactDir, "latest.json"), {
    ...artifact,
    file: fileName
  });
  return artifactPath;
}

export async function writeStageRoutingArtifactBestEffort(
  workspaceRoot: string,
  artifact: StageRoutingArtifact
): Promise<string | undefined> {
  try {
    return await writeStageRoutingArtifact(workspaceRoot, artifact);
  } catch {
    return undefined;
  }
}

export function classifyStageRoutingFailure(errorMessage: string): StageRoutingEvent | undefined {
  const normalized = errorMessage.trim().toLowerCase();
  if (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("deadline") ||
    normalized.includes("partial")
  ) {
    return "timeout_partial";
  }
  return undefined;
}

function sanitizeStringList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function formatArtifactTimestamp(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/gu, "-").replace(/^-|-$/gu, "");
}
