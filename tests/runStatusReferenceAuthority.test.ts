import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { buildRunOperatorStatus } from "../src/core/runs/runStatus.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import type { RunRecord } from "../src/types.js";

let workspaceRoot = "";

afterEach(async () => {
  if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true });
  workspaceRoot = "";
});

describe("run status reference authority defense", () => {
  it("does not project paper_ready from an unbound or failing reference gate", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-status-reference-"));
    const run = makeRun("run-reference-authority");
    const paperDir = path.join(workspaceRoot, ".autolabos", "runs", run.id, "paper");
    await fs.mkdir(paperDir, { recursive: true });
    await fs.writeFile(
      path.join(paperDir, "paper_readiness.json"),
      JSON.stringify({ paper_ready: true, readiness_state: "paper_ready" }),
      "utf8"
    );

    const unbound = await buildRunOperatorStatus({ workspaceRoot, run, approvalMode: "minimal" });
    expect(unbound.paper_ready).toBe(false);

    await fs.writeFile(
      path.join(paperDir, "paper_readiness.json"),
      JSON.stringify({
        paper_ready: true,
        readiness_state: "paper_ready",
        reference_authority_gate: { status: "pass", submission_gate_passed: true }
      }),
      "utf8"
    );
    const selfAsserted = await buildRunOperatorStatus({ workspaceRoot, run, approvalMode: "minimal" });
    expect(selfAsserted.paper_ready).toBe(false);

    await writePassingReferenceAuthority(paperDir);
    const bound = await buildRunOperatorStatus({ workspaceRoot, run, approvalMode: "minimal" });
    expect(bound.paper_ready).toBe(true);
  });
});

function makeRun(id: string): RunRecord {
  const now = new Date().toISOString();
  const graph = createDefaultGraphState();
  graph.currentNode = "write_paper";
  graph.nodeStates.write_paper.status = "completed";
  return {
    version: 3,
    workflowVersion: 3,
    id,
    title: "Reference authority fixture",
    topic: "Domain-neutral governance",
    constraints: [],
    objectiveMetric: "decision quality",
    status: "completed",
    currentNode: "write_paper",
    nodeThreads: {},
    createdAt: now,
    updatedAt: now,
    graph,
    memoryRefs: {
      runContextPath: `.autolabos/runs/${id}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${id}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${id}/memory/episodes.jsonl`
    }
  };
}

async function writePassingReferenceAuthority(paperDir: string): Promise<void> {
  const manuscript = "\\section{Results}\n";
  const manuscriptSha256 = createHash("sha256").update(manuscript, "utf8").digest("hex");
  await fs.writeFile(path.join(paperDir, "main.tex"), manuscript, "utf8");
  await fs.writeFile(
    path.join(paperDir, "reference_evidence_status.json"),
    JSON.stringify({
      schema_version: "1.0",
      manuscript: "paper/main.tex",
      manuscript_projection: {
        source_ref: "paper/main.tex",
        package_ref: "paper/main.tex",
        source_sha256: manuscriptSha256,
        package_content_sha256: manuscriptSha256
      },
      submission_gate_passed: true,
      summary: {
        citation_bearing_claim_count: 0,
        independently_checked_claim_count: 0,
        missing_full_text_claim_count: 0
      },
      blocking_requirements: []
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(paperDir, "refgate_claims.tsv"),
    "claim_id\tmanuscript_location\tclaim_text\tcitation_key\tsource_location\tquote_or_evidence\tevidence_kind\tstatus\tnotes\tclaim_type\timportance\n",
    "utf8"
  );
}
