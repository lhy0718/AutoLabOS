import path from "node:path";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { AnalysisReport } from "../resultAnalysis.js";
import { buildReviewPacket } from "../reviewPacket.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import { safeRead, writeRunArtifact } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";

export function createReviewNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "review",
    async execute({ run }) {
      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      const report = await loadAnalysisReport(run.id, runContextMemory);
      if (!report) {
        return {
          status: "failure",
          error: "review requires a completed analyze_results artifact at result_analysis.json.",
          summary: "review requires analyze_results output before it can prepare a manual review packet.",
          toolCallsUsed: 1
        };
      }

      const runDir = path.join(".autolabos", "runs", run.id);
      const packet = buildReviewPacket(report, {
        corpusPresent: Boolean(await safeRead(path.join(runDir, "corpus.jsonl"))),
        paperSummariesPresent: Boolean(await safeRead(path.join(runDir, "paper_summaries.jsonl"))),
        evidenceStorePresent: Boolean(await safeRead(path.join(runDir, "evidence_store.jsonl"))),
        hypothesesPresent: Boolean(await safeRead(path.join(runDir, "hypotheses.jsonl"))),
        experimentPlanPresent: Boolean(await safeRead(path.join(runDir, "experiment_plan.yaml"))),
        metricsPresent: Boolean(await safeRead(path.join(runDir, "metrics.json"))),
        figurePresent: Boolean(await safeRead(path.join(runDir, "figures", "performance.svg"))),
        synthesisPresent:
          Boolean(report.synthesis?.discussion_points?.length) ||
          Boolean(await safeRead(path.join(runDir, "result_analysis_synthesis.json")))
      });
      const markdown = renderReviewChecklist(run, packet);

      await writeRunArtifact(run, "review/review_packet.json", `${JSON.stringify(packet, null, 2)}\n`);
      await writeRunArtifact(run, "review/checklist.md", markdown);
      await runContextMemory.put("review.packet", packet);
      await runContextMemory.put("review.last_summary", packet.objective_summary);
      await runContextMemory.put("review.last_recommendation", packet.recommendation || null);

      deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: "review",
        payload: {
          text: `Review packet prepared with ${packet.checks.length} checklist item(s). Human approval is required before write_paper.`
        }
      });

      const blockers = packet.readiness.blocking_checks;
      const warnings = packet.readiness.warning_checks;
      const manual = packet.readiness.manual_checks;
      return {
        status: "success",
        summary:
          blockers > 0
            ? `Review packet prepared with ${blockers} blocking issue(s), ${warnings} warning(s), and ${manual} manual sign-off item(s). Resolve the blockers before approving write_paper.`
            : warnings > 0 || manual > 0
              ? `Review packet prepared with ${warnings} warning(s) and ${manual} manual sign-off item(s). Approve review to continue to write_paper or jump back from the recommendation.`
              : "Review packet prepared. Approve review to continue to write_paper.",
        needsApproval: true,
        toolCallsUsed: 1
      };
    }
  };
}

async function loadAnalysisReport(
  runId: string,
  runContextMemory: RunContextMemory
): Promise<AnalysisReport | undefined> {
  const cached = await runContextMemory.get<AnalysisReport>("analyze_results.last_summary");
  if (cached) {
    return cached;
  }

  const raw = await safeRead(path.join(".autolabos", "runs", runId, "result_analysis.json"));
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as AnalysisReport;
  } catch {
    return undefined;
  }
}

function renderReviewChecklist(
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"],
  packet: ReturnType<typeof buildReviewPacket>
): string {
  const lines = [
    "# Review checklist",
    "",
    `Run: ${run.id}`,
    `Title: ${run.title}`,
    `Generated: ${packet.generated_at}`,
    "",
    `Readiness: ${packet.readiness.status} (${packet.readiness.ready_checks} ready, ${packet.readiness.warning_checks} warning, ${packet.readiness.blocking_checks} blocking, ${packet.readiness.manual_checks} manual)`,
    "",
    `Objective: ${packet.objective_status}`,
    packet.objective_summary,
    ""
  ];

  if (packet.recommendation) {
    lines.push(
      `Recommendation: ${packet.recommendation.action}${packet.recommendation.target ? ` -> ${packet.recommendation.target}` : ""} (${packet.recommendation.confidence_pct}%)`
    );
    lines.push(packet.recommendation.reason);
    if (packet.recommendation.evidence.length > 0) {
      lines.push("");
      lines.push("Evidence:");
      for (const item of packet.recommendation.evidence) {
        lines.push(`- ${item}`);
      }
    }
    lines.push("");
  }

  lines.push("Checklist:");
  for (const item of packet.checks) {
    lines.push(`- [ ] ${item.label} (${item.status}): ${item.detail}`);
  }

  lines.push("");
  lines.push("Suggested actions:");
  for (const action of packet.suggested_actions) {
    lines.push(`- ${action}`);
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}
