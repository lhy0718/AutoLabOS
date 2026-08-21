import path from "node:path";
import { randomUUID } from "node:crypto";

import { GRAPH_NODE_ORDER, GraphNodeId, RunRecord } from "../types.js";
import { RunContextMemory } from "./memory/runContextMemory.js";
import { withHumanInterventionRunLock } from "./humanInterventionLock.js";
import { ensureDir, writeJsonFile } from "../utils/fs.js";

export const HUMAN_INTERVENTION_PENDING_KEY = "human_intervention.pending";
export const HUMAN_INTERVENTION_HISTORY_KEY = "human_intervention.history";

export type HumanInterventionKind =
  | "objective_metric_clarification"
  | "transition_choice"
  | "generic_pause";

export type HumanInterventionInputMode = "free_text" | "single_choice";
export type HumanInterventionResumeAction =
  | "retry_current"
  | "approve_current"
  | "apply_transition"
  | "jump";

export interface HumanInterventionChoice {
  id: string;
  label: string;
  description?: string;
  answerAliases?: string[];
  resumeAction?: HumanInterventionResumeAction;
  targetNode?: GraphNodeId;
}

export interface HumanInterventionRequest {
  id: string;
  sourceNode: GraphNodeId;
  kind: HumanInterventionKind;
  title: string;
  question: string;
  context: string[];
  choices?: HumanInterventionChoice[];
  inputMode: HumanInterventionInputMode;
  resumeAction: HumanInterventionResumeAction;
  conversation?: HumanInterventionConversationTurn[];
  createdAt: string;
}

export interface HumanInterventionConversationTurn {
  question: string;
  answer: string;
  followupQuestion?: string;
  rationale?: string;
  resolutionSource?: "exact" | "model" | "guarded_fallback";
  recordedAt: string;
}

export interface HumanInterventionHistoryEntry {
  requestId: string;
  sourceNode: GraphNodeId;
  kind: HumanInterventionKind;
  title: string;
  answer: string;
  selectedChoiceId?: string;
  resumeAction: HumanInterventionResumeAction;
  targetNode?: GraphNodeId;
  resolutionSource?: "exact" | "model" | "guarded_fallback";
  rationale?: string;
  conversation?: HumanInterventionConversationTurn[];
  answeredAt: string;
}

export interface ResolvedHumanInterventionAnswer {
  request: HumanInterventionRequest;
  answer: string;
  selectedChoice?: HumanInterventionChoice;
  resumeAction: HumanInterventionResumeAction;
  targetNode?: GraphNodeId;
}

export function createHumanInterventionRequest(
  input: Omit<HumanInterventionRequest, "id" | "createdAt">
): HumanInterventionRequest {
  return {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString()
  };
}

export async function writeHumanInterventionRequest(input: {
  workspaceRoot: string;
  run: RunRecord;
  runContext: RunContextMemory;
  request: HumanInterventionRequest;
}): Promise<void> {
  await withHumanInterventionRunLock(
    {
      workspaceRoot: input.workspaceRoot,
      runId: input.run.id
    },
    async () => {
      await input.runContext.put(HUMAN_INTERVENTION_PENDING_KEY, input.request);
      const artifactPath = humanInterventionArtifactPath(input.workspaceRoot, input.run.id);
      await ensureDir(path.dirname(artifactPath));
      await writeJsonFile(artifactPath, input.request);
    }
  );
}

export async function readPendingHumanInterventionRequest(
  runContext: RunContextMemory
): Promise<HumanInterventionRequest | undefined> {
  const request = await runContext.get<HumanInterventionRequest>(HUMAN_INTERVENTION_PENDING_KEY);
  return isHumanInterventionRequest(request) ? request : undefined;
}

export async function clearPendingHumanInterventionRequest(runContext: RunContextMemory): Promise<void> {
  await runContext.put(HUMAN_INTERVENTION_PENDING_KEY, null);
}

export function appendHumanInterventionFollowup(input: {
  request: HumanInterventionRequest;
  answer: string;
  followupQuestion: string;
  rationale?: string;
  resolutionSource: "model" | "guarded_fallback";
}): HumanInterventionRequest {
  return {
    ...input.request,
    question: input.followupQuestion,
    conversation: [
      ...(input.request.conversation || []),
      {
        question: input.request.question,
        answer: input.answer,
        followupQuestion: input.followupQuestion,
        rationale: input.rationale,
        resolutionSource: input.resolutionSource,
        recordedAt: new Date().toISOString()
      }
    ].slice(-12)
  };
}

export async function appendHumanInterventionHistory(
  runContext: RunContextMemory,
  entry: HumanInterventionHistoryEntry
): Promise<void> {
  const current = await runContext.get<HumanInterventionHistoryEntry[]>(HUMAN_INTERVENTION_HISTORY_KEY);
  const history = Array.isArray(current) ? current : [];
  history.push(entry);
  await runContext.put(HUMAN_INTERVENTION_HISTORY_KEY, history.slice(-50));
}

export function humanInterventionArtifactPath(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, ".autolabos", "runs", runId, "human_intervention", "request.json");
}

export function isActiveHumanInterventionRequest(
  run: RunRecord,
  request: HumanInterventionRequest | undefined
): request is HumanInterventionRequest {
  if (!request) {
    return false;
  }
  const nodeState = run.graph.nodeStates[run.currentNode];
  return (
    run.status === "paused" &&
    nodeState.status === "needs_approval" &&
    request.sourceNode === run.currentNode
  );
}

export function resolveHumanInterventionAnswer(
  request: HumanInterventionRequest,
  rawAnswer: string
): ResolvedHumanInterventionAnswer | { error: string } {
  const answer = rawAnswer.trim();
  if (!answer) {
    return { error: "Please provide an answer before resuming the run." };
  }

  if (request.inputMode === "free_text") {
    return {
      request,
      answer,
      resumeAction: request.resumeAction
    };
  }

  const choices = request.choices || [];
  if (choices.length === 0) {
    return { error: "This question has no configured choices." };
  }

  const selectedChoice = resolveChoiceByAnswer(choices, answer);
  if (!selectedChoice) {
    const labels = choices.map((choice, index) => `${index + 1}) ${choice.label}`).join(" | ");
    return { error: `Choose one of: ${labels}` };
  }

  return {
    request,
    answer,
    selectedChoice,
    resumeAction: selectedChoice.resumeAction || request.resumeAction,
    targetNode: selectedChoice.targetNode
  };
}

function resolveChoiceByAnswer(
  choices: HumanInterventionChoice[],
  rawAnswer: string
): HumanInterventionChoice | undefined {
  const normalized = rawAnswer.trim().toLowerCase();
  const index = /^\d+$/u.test(normalized)
    ? Number.parseInt(normalized, 10)
    : Number.NaN;
  if (Number.isFinite(index) && index >= 1 && index <= choices.length) {
    return choices[index - 1];
  }
  return choices.find((choice) => {
    const aliases = new Set<string>([
      choice.id.toLowerCase(),
      choice.label.toLowerCase(),
      ...(choice.answerAliases || []).map((item) => item.toLowerCase())
    ]);
    return aliases.has(normalized);
  });
}

export function isHumanInterventionRequest(value: unknown): value is HumanInterventionRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as Partial<HumanInterventionRequest>;
  return (
    typeof request.id === "string"
    && typeof request.sourceNode === "string"
    && GRAPH_NODE_ORDER.includes(request.sourceNode as GraphNodeId)
    && ["objective_metric_clarification", "transition_choice", "generic_pause"].includes(
      request.kind || ""
    )
    && typeof request.title === "string"
    && typeof request.question === "string"
    && Array.isArray(request.context)
    && request.context.every((item) => typeof item === "string")
    && (
      request.choices === undefined
      || (
        Array.isArray(request.choices)
        && request.choices.every(isHumanInterventionChoice)
      )
    )
    && ["free_text", "single_choice"].includes(request.inputMode || "")
    && ["retry_current", "approve_current", "apply_transition", "jump"].includes(
      request.resumeAction || ""
    )
    && (
      request.conversation === undefined
      || (
        Array.isArray(request.conversation)
        && request.conversation.every(isHumanInterventionConversationTurn)
      )
    )
    && typeof request.createdAt === "string"
  );
}

function isHumanInterventionChoice(value: unknown): value is HumanInterventionChoice {
  if (!value || typeof value !== "object") {
    return false;
  }
  const choice = value as Partial<HumanInterventionChoice>;
  return (
    typeof choice.id === "string"
    && typeof choice.label === "string"
    && (choice.description === undefined || typeof choice.description === "string")
    && (
      choice.answerAliases === undefined
      || (
        Array.isArray(choice.answerAliases)
        && choice.answerAliases.every((item) => typeof item === "string")
      )
    )
    && (
      choice.resumeAction === undefined
      || ["retry_current", "approve_current", "apply_transition", "jump"].includes(
        choice.resumeAction
      )
    )
    && (
      choice.targetNode === undefined
      || GRAPH_NODE_ORDER.includes(choice.targetNode)
    )
  );
}

function isHumanInterventionConversationTurn(
  value: unknown
): value is HumanInterventionConversationTurn {
  if (!value || typeof value !== "object") {
    return false;
  }
  const turn = value as Partial<HumanInterventionConversationTurn>;
  return (
    typeof turn.question === "string"
    && typeof turn.answer === "string"
    && (turn.followupQuestion === undefined || typeof turn.followupQuestion === "string")
    && (turn.rationale === undefined || typeof turn.rationale === "string")
    && (
      turn.resolutionSource === undefined
      || ["exact", "model", "guarded_fallback"].includes(turn.resolutionSource)
    )
    && typeof turn.recordedAt === "string"
  );
}
