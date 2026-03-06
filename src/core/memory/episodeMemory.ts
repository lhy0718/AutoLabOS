import path from "node:path";

import { appendFile, readFile } from "node:fs/promises";

import { GraphNodeId } from "../../types.js";
import { ensureDir } from "../../utils/fs.js";

export interface EpisodeRecord {
  episode_id: string;
  run_id: string;
  node_id: GraphNodeId;
  attempt: number;
  error_class: string;
  error_message: string;
  plan_excerpt: string;
  observations: string[];
  lesson: string;
  next_try_instruction: string;
  timestamp: string;
}

export class EpisodeMemory {
  constructor(private readonly filePath: string) {}

  async save(record: Omit<EpisodeRecord, "episode_id" | "timestamp">): Promise<EpisodeRecord> {
    const next: EpisodeRecord = {
      ...record,
      episode_id: `ep_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
      timestamp: new Date().toISOString()
    };

    await ensureDir(path.dirname(this.filePath));
    await appendFile(this.filePath, `${JSON.stringify(next)}\n`, "utf8");
    return next;
  }

  async recent(runId: string, nodeId?: GraphNodeId, limit = 5): Promise<EpisodeRecord[]> {
    const rows = await this.readAll();
    return rows
      .filter((row) => row.run_id === runId && (!nodeId || row.node_id === nodeId))
      .slice(-limit)
      .reverse();
  }

  async readAll(): Promise<EpisodeRecord[]> {
    let text = "";
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return [];
    }

    const out: EpisodeRecord[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        out.push(JSON.parse(trimmed) as EpisodeRecord);
      } catch {
        continue;
      }
    }

    return out;
  }
}
