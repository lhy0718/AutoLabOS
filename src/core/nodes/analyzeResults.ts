import path from "node:path";

import { promises as fs } from "node:fs";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { writeRunArtifact } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";
import { LongTermStore } from "../memory/longTermStore.js";

export function createAnalyzeResultsNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "analyze_results",
    async execute({ run, graph }) {
      const longTermStore = new LongTermStore(run.memoryRefs.longTermPath);
      const metricsPath = path.join(".autoresearch", "runs", run.id, "metrics.json");
      let metrics: Record<string, number> = {};
      try {
        const raw = await fs.readFile(metricsPath, "utf8");
        metrics = JSON.parse(raw) as Record<string, number>;
      } catch {
        metrics = { accuracy: 0, f1: 0, loss: 1 };
      }

      const summary = {
        mean_score: Number((((metrics.accuracy || 0) + (metrics.f1 || 0)) / 2).toFixed(4)),
        metrics
      };

      await writeRunArtifact(run, "metrics.json", JSON.stringify(summary, null, 2));
      await writeRunArtifact(run, "figures/performance.png", "placeholder_png_binary");
      await longTermStore.append({
        runId: run.id,
        category: "results",
        text: `Result summary: ${JSON.stringify(summary)}`,
        tags: ["analyze_results"]
      });

      return {
        status: "success",
        summary: `Result analysis complete. mean_score=${summary.mean_score}`,
        needsApproval: true,
        toolCallsUsed: 1
      };
    }
  };
}
