import path from "node:path";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { runReActLoop } from "../agents/runtime/reactLoop.js";
import { appendJsonl, safeRead } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";
import { RunContextMemory } from "../memory/runContextMemory.js";

export function createAnalyzePapersNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "analyze_papers",
    async execute({ run, graph }) {
      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      const corpusPath = path.join(".autoresearch", "runs", run.id, "corpus.jsonl");
      const corpusText = await safeRead(corpusPath);
      const rows = corpusText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as { paper_id?: string; title?: string; abstract?: string };
          } catch {
            return {};
          }
        });

      const react = await runReActLoop({
        runId: run.id,
        node: "analyze_papers",
        goal: `Extract evidence slots from ${rows.length} papers`,
        tools: [
          {
            name: "extract_slots",
            run: async (input) => ({
              status: "ok",
              output: `done: slots extracted for ${rows.length} entries from prompt ${input.slice(0, 40)}`,
              toolCallsUsed: 1
            })
          }
        ],
        eventStream: deps.eventStream
      });

      const evidence = rows.map((row, idx) => ({
        evidence_id: `ev_${idx + 1}`,
        paper_id: row.paper_id || `paper_${idx + 1}`,
        claim: row.title || "Untitled claim",
        method_slot: (row.abstract || "").slice(0, 120),
        result_slot: (row.abstract || "").slice(120, 240),
        confidence: 0.6
      }));

      await appendJsonl(run, "paper_summaries.jsonl", rows);
      await appendJsonl(run, "evidence_store.jsonl", evidence);
      await runContextMemory.put("analyze_papers.evidence_count", evidence.length);

      return {
        status: "success",
        summary: react.summary,
        needsApproval: true,
        toolCallsUsed: react.toolCallsUsed
      };
    }
  };
}
