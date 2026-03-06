import path from "node:path";

import { promises as fs } from "node:fs";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { runTreeOfThoughts } from "../agents/runtime/tot.js";
import { safeRead, writeRunArtifact } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";
import { RunContextMemory } from "../memory/runContextMemory.js";

export function createDesignExperimentsNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "design_experiments",
    async execute({ run, graph }) {
      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      const hypothesesPath = path.join(".autoresearch", "runs", run.id, "hypotheses.jsonl");
      const hypothesesText = await safeRead(hypothesesPath);
      const seeds = hypothesesText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 4)
        .map((line, idx) => {
          try {
            const obj = JSON.parse(line) as { text?: string };
            return obj.text || `hypothesis_${idx + 1}`;
          } catch {
            return `hypothesis_${idx + 1}`;
          }
        });

      const tot = runTreeOfThoughts(seeds, { branchCount: 6, topK: 2 });
      const selected = tot.selected[0];

      const planYaml = [
        `run_id: ${run.id}`,
        `topic: "${escapeQuote(run.topic)}"`,
        "objective:",
        `  metric: "${escapeQuote(run.objectiveMetric)}"`,
        "hypotheses:",
        ...tot.selected.map((x) => `  - "${escapeQuote(x.text)}"`),
        "execution:",
        "  container: local",
        "  timeout_sec: 1800",
        "  budget:",
        "    max_tool_calls: 150"
      ].join("\n");

      const outputPath = await writeRunArtifact(run, "experiment_plan.yaml", planYaml);
      await fs.access(outputPath);
      await runContextMemory.put("design_experiments.primary", selected?.text || "");

      return {
        status: "success",
        summary: `Experiment plan fixed with ${tot.selected.length} shortlisted designs.`,
        needsApproval: true,
        toolCallsUsed: 1
      };
    }
  };
}

function escapeQuote(text: string): string {
  return text.replace(/"/g, "'");
}
