import path from "node:path";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { runTreeOfThoughts } from "../agents/runtime/tot.js";
import { appendJsonl, safeRead } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";
import { RunContextMemory } from "../memory/runContextMemory.js";

export function createGenerateHypothesesNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "generate_hypotheses",
    async execute({ run, graph }) {
      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      const evidencePath = path.join(".autoresearch", "runs", run.id, "evidence_store.jsonl");
      const evidenceText = await safeRead(evidencePath);
      const seeds = evidenceText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 8)
        .map((line, idx) => {
          try {
            const obj = JSON.parse(line) as {
              claim?: string;
              limitation_slot?: string;
              dataset_slot?: string;
              metric_slot?: string;
            };
            const parts = [
              obj.claim,
              obj.limitation_slot && obj.limitation_slot !== "Not specified." ? `limitation: ${obj.limitation_slot}` : undefined,
              obj.dataset_slot && obj.dataset_slot !== "Not specified." ? `dataset: ${obj.dataset_slot}` : undefined,
              obj.metric_slot && obj.metric_slot !== "Not specified." ? `metric: ${obj.metric_slot}` : undefined
            ].filter(Boolean);
            return parts.join(" | ") || `seed_${idx + 1}`;
          } catch {
            return `seed_${idx + 1}`;
          }
        });

      const tot = runTreeOfThoughts(seeds, { branchCount: 6, topK: 2 });
      const hypotheses = tot.selected.map((candidate, idx) => ({
        hypothesis_id: `h_${idx + 1}`,
        text: candidate.text,
        score: candidate.novelty + candidate.feasibility + candidate.testability + candidate.expected_gain - candidate.cost,
        evidence_links: ["ev_1"]
      }));

      await appendJsonl(run, "hypotheses.jsonl", hypotheses);
      await runContextMemory.put("generate_hypotheses.top_k", hypotheses.length);
      deps.eventStream.emit({
        type: "PLAN_CREATED",
        runId: run.id,
        node: "generate_hypotheses",
        payload: {
          branchCount: tot.candidates.length,
          topK: hypotheses.length
        }
      });

      return {
        status: "success",
        summary: `Generated ${tot.candidates.length} candidates and selected ${hypotheses.length} hypotheses.`,
        needsApproval: true,
        toolCallsUsed: 1
      };
    }
  };
}
