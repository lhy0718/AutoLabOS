import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { AgentRoleId, GraphNodeId } from "../types.js";
import { normalizeFsPath } from "../utils/fs.js";
import { buildRunsDbFile, IndexedRunEvent, RunIndexDatabase } from "./runs/runIndexDatabase.js";
import { buildRunEventsPath } from "./runs/runPaths.js";

const repairedEventLogPaths = new Set<string>();

export type EventType =
  | "PLAN_CREATED"
  | "TOOL_CALLED"
  | "OBS_RECEIVED"
  | "PATCH_APPLIED"
  | "TEST_FAILED"
  | "REFLECTION_SAVED"
  | "CHECKPOINT_SAVED"
  | "NODE_RETRY"
  | "NODE_ROLLBACK"
  | "NODE_JUMP"
  | "TRANSITION_RECOMMENDED"
  | "TRANSITION_APPLIED"
  | "NODE_STARTED"
  | "NODE_COMPLETED"
  | "NODE_FAILED";

export interface AutoLabOSEvent {
  id: string;
  type: EventType;
  timestamp: string;
  runId: string;
  node?: GraphNodeId;
  agentRole?: AgentRoleId;
  payload: Record<string, unknown>;
}

export type EventListener = (event: AutoLabOSEvent) => void;

export interface EventStream {
  emit(event: Omit<AutoLabOSEvent, "id" | "timestamp">): AutoLabOSEvent;
  subscribe(listener: EventListener): () => void;
  history(limit?: number, runId?: string): AutoLabOSEvent[];
}

export class InMemoryEventStream implements EventStream {
  private readonly listeners = new Set<EventListener>();
  private readonly items: AutoLabOSEvent[] = [];

  emit(event: Omit<AutoLabOSEvent, "id" | "timestamp">): AutoLabOSEvent {
    const next: AutoLabOSEvent = {
      ...event,
      id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
      timestamp: new Date().toISOString()
    };

    this.items.push(next);
    for (const listener of this.listeners) {
      listener(next);
    }
    return next;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  history(limit = 200, runId?: string): AutoLabOSEvent[] {
    return sliceEventHistory(this.items, limit, runId);
  }
}

export class PersistedEventStream implements EventStream {
  private readonly listeners = new Set<EventListener>();
  private readonly items: AutoLabOSEvent[] = [];
  private readonly runIndex: RunIndexDatabase;

  constructor(
    private readonly runsDir: string,
    private readonly retainedHistoryLimit = 1000
  ) {
    this.runIndex = new RunIndexDatabase(buildRunsDbFile(runsDir));
  }

  emit(event: Omit<AutoLabOSEvent, "id" | "timestamp">): AutoLabOSEvent {
    const next = createEventRecord(event);
    this.items.push(next);
    if (this.items.length > this.retainedHistoryLimit) {
      this.items.splice(0, this.items.length - this.retainedHistoryLimit);
    }
    const eventPath = persistEventToRunLog(this.runsDir, next);
    this.runIndex.appendRunEvent({
      runId: next.runId,
      eventId: next.id,
      eventType: next.type,
      nodeId: next.node,
      createdAt: next.timestamp,
      filePath: eventPath,
      eventJson: JSON.stringify(next)
    });
    for (const listener of this.listeners) {
      listener(next);
    }
    return next;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  history(limit = 200, runId?: string): AutoLabOSEvent[] {
    return sliceEventHistory(this.items, limit, runId);
  }
}

export function readPersistedRunEvents(input: {
  runsDir: string;
  runId: string;
  limit?: number;
}): AutoLabOSEvent[] {
  const limit = input.limit ?? 200;
  if (limit <= 0) {
    return [];
  }

  const eventPath = normalizeFsPath(runEventLogPath(input.runsDir, input.runId));
  if (!existsSync(eventPath)) {
    return [];
  }

  const runIndex = new RunIndexDatabase(buildRunsDbFile(input.runsDir));
  try {
    const indexed = runIndex.listRunEvents(input.runId, limit);
    if (indexed.length > 0) {
      return parseIndexedRunEvents(indexed);
    }

    const parsed = parsePersistedEventLines(readFileSync(eventPath, "utf8"));
    if (parsed.length > 0) {
      runIndex.replaceRunEvents(
        input.runId,
        parsed.map((event, idx) => toIndexedRunEvent(event, idx + 1, eventPath))
      );
    }
    return parsed.slice(-limit);
  } catch {
    return [];
  } finally {
    runIndex.close();
  }
}

function createEventRecord(event: Omit<AutoLabOSEvent, "id" | "timestamp">): AutoLabOSEvent {
  return {
    ...event,
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
    timestamp: new Date().toISOString()
  };
}

function persistEventToRunLog(runsDir: string, event: AutoLabOSEvent): string {
  const eventPath = runEventLogPath(runsDir, event.runId);
  mkdirSync(path.dirname(eventPath), { recursive: true });
  repairMalformedRunEventLogOnce(eventPath);
  appendFileSync(eventPath, `${JSON.stringify(event)}\n`, "utf8");
  return normalizeFsPath(eventPath);
}

function repairMalformedRunEventLogOnce(eventPath: string): void {
  const normalizedPath = normalizeFsPath(eventPath);
  if (repairedEventLogPaths.has(normalizedPath) || !existsSync(eventPath)) {
    return;
  }
  repairedEventLogPaths.add(normalizedPath);

  const lockDir = `${eventPath}.repair.lock`;
  if (!acquireRepairLock(lockDir)) {
    return;
  }

  try {
    const raw = readFileSync(eventPath, "utf8");
    const validLines: string[] = [];
    const malformedLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (isAutoLabOSEvent(parsed)) {
          validLines.push(JSON.stringify(parsed));
        } else {
          malformedLines.push(line);
        }
      } catch {
        malformedLines.push(line);
      }
    }

    if (malformedLines.length === 0) {
      return;
    }

    const stamp = `${Date.now()}-${process.pid}`;
    writeFileSync(`${eventPath}.malformed-${stamp}.jsonl`, malformedLines.map((line) => `${line}\n`).join(""), "utf8");
    const repairedPath = `${eventPath}.repair-${stamp}.tmp`;
    writeFileSync(repairedPath, validLines.map((line) => `${line}\n`).join(""), "utf8");
    renameSync(repairedPath, eventPath);
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function acquireRepairLock(lockDir: string): boolean {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      sleepSync(25);
    }
  }
  return false;
}

function sleepSync(milliseconds: number): void {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function runEventLogPath(runsDir: string, runId: string): string {
  return buildRunEventsPath(runsDir, runId);
}

function sliceEventHistory(
  items: AutoLabOSEvent[],
  limit: number,
  runId?: string
): AutoLabOSEvent[] {
  if (limit <= 0) {
    return [];
  }
  const filtered = runId ? items.filter((item) => item.runId === runId) : items;
  return filtered.slice(-limit);
}

function isAutoLabOSEvent(event: unknown): event is AutoLabOSEvent {
  return Boolean(
    event &&
      typeof event === "object" &&
      typeof (event as AutoLabOSEvent).id === "string" &&
      typeof (event as AutoLabOSEvent).type === "string" &&
      typeof (event as AutoLabOSEvent).timestamp === "string" &&
      typeof (event as AutoLabOSEvent).runId === "string" &&
      typeof (event as AutoLabOSEvent).payload === "object"
  );
}

function parsePersistedEventLines(raw: string): AutoLabOSEvent[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as AutoLabOSEvent;
      } catch {
        return undefined;
      }
    })
    .filter((event): event is AutoLabOSEvent => isAutoLabOSEvent(event));
}

function parseIndexedRunEvents(indexed: IndexedRunEvent[]): AutoLabOSEvent[] {
  return indexed
    .map((item) => {
      try {
        return JSON.parse(item.eventJson) as AutoLabOSEvent;
      } catch {
        return undefined;
      }
    })
    .filter((event): event is AutoLabOSEvent => isAutoLabOSEvent(event));
}

function toIndexedRunEvent(event: AutoLabOSEvent, eventSeq: number, filePath: string): IndexedRunEvent {
  return {
    runId: event.runId,
    eventSeq,
    eventId: event.id,
    eventType: event.type,
    nodeId: event.node,
    createdAt: event.timestamp,
    filePath,
    eventJson: JSON.stringify(event)
  };
}
