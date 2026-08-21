import path from "node:path";

import { appendFile } from "node:fs/promises";

import { ensureDir } from "../../utils/fs.js";

export interface LongTermEntry {
  id: string;
  runId: string;
  category: string;
  text: string;
  tags: string[];
  embedding?: number[];
  createdAt: string;
}

export class LongTermStore {
  constructor(private readonly filePath: string) {}

  async append(entry: Omit<LongTermEntry, "id" | "createdAt">): Promise<LongTermEntry> {
    const next: LongTermEntry = {
      ...entry,
      id: `lt_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
      createdAt: new Date().toISOString()
    };

    await ensureDir(path.dirname(this.filePath));
    await appendFile(this.filePath, `${JSON.stringify(next)}\n`, "utf8");
    return next;
  }

  async search(query: string, limit = 10): Promise<LongTermEntry[]> {
    const rows = await this.readAll();
    const q = query.trim().toLowerCase();
    if (!q) {
      return rows.slice(-limit);
    }

    return rows
      .filter((row) => row.text.toLowerCase().includes(q) || row.tags.some((x) => x.toLowerCase().includes(q)))
      .slice(0, limit);
  }

  async readAll(): Promise<LongTermEntry[]> {
    const text = await safeRead(this.filePath);
    if (!text) {
      return [];
    }

    const out: LongTermEntry[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        out.push(JSON.parse(trimmed) as LongTermEntry);
      } catch {
        continue;
      }
    }

    return out;
  }
}

async function safeRead(filePath: string): Promise<string> {
  try {
    const fs = await import("node:fs/promises");
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}
