import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { runPaperReadinessAudit } from "../src/core/audit/paperReadinessAudit.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external artifact audit intake", () => {
  it("copies only allowlisted external artifacts and omits machine-local source paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-external-audit-workspace-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "autolabos-external-audit-source-"));
    tempDirs.push(workspace, external);

    await mkdir(path.join(external, "paper"), { recursive: true });
    await mkdir(path.join(external, "figure_audit"), { recursive: true });
    await mkdir(path.join(external, "secret"), { recursive: true });
    await writeFile(path.join(external, "governance_condition.json"), JSON.stringify({ name: "gated" }), "utf8");
    await writeFile(
      path.join(external, "result_table.json"),
      JSON.stringify([{ metric: "accuracy", baseline: 0.7, comparator: 0.74, delta: 0.04, direction: "higher_better" }]),
      "utf8"
    );
    await writeFile(path.join(external, "evidence_store.jsonl"), JSON.stringify({ id: "ev_metric", metric: "accuracy", value: 0.74 }) + "\n", "utf8");
    await writeFile(
      path.join(external, "paper", "claim_evidence_table.json"),
      JSON.stringify({
        claims: [{
          claim_id: "claim_accuracy_delta",
          statement: "The method improves accuracy in this run.",
          section_heading: "Results",
          artifact_refs: ["result_table.json"],
          citation_refs: [],
          evidence_ids: ["ev_metric"]
        }]
      }),
      "utf8"
    );
    await writeFile(
      path.join(external, "paper", "claim_status_table.json"),
      JSON.stringify({
        claims: [{
          claim_id: "claim_accuracy_delta",
          statement: "The method improves accuracy in this run.",
          section_heading: "Results",
          status: "verified",
          artifact_refs: ["result_table.json"],
          citation_refs: [],
          reproduction_trace_present: true
        }]
      }),
      "utf8"
    );
    await writeFile(
      path.join(external, "paper", "evidence_links.json"),
      JSON.stringify({ claims: [{ claim_id: "claim_accuracy_delta", artifact_refs: ["result_table.json"], evidence_ids: ["ev_metric"] }] }),
      "utf8"
    );
    await writeFile(path.join(external, "paper", "paper_readiness.json"), JSON.stringify({ paper_ready: false, readiness_state: "research_memo" }), "utf8");
    await writeFile(path.join(external, "figure_audit", "figure_audit_summary.json"), JSON.stringify({ severe_mismatch_count: 0, review_block_required: false, issues: [] }), "utf8");
    await writeFile(path.join(external, "secret", "notes.txt"), "do not copy", "utf8");
    const draftPath = path.join(external, "draft.md");
    const logPath = path.join(external, "run.log");
    await writeFile(draftPath, "# Draft\n", "utf8");
    await writeFile(logPath, "ran\n", "utf8");

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      externalRoot: external,
      draftPath,
      logPath,
      outDir: "outputs/audit-external"
    });

    expect(summary.input.mode).toBe("external");
    expect(summary.input.run_root).toBe("outputs/audit-external/_external-intake/run-artifacts");
    expect(summary.outputs.external_intake_manifest_path).toBe("outputs/audit-external/external-intake-manifest.json");
    expect(summary.outputs.claim_evidence_path).toBe("outputs/audit-external/claim-evidence-table.json");

    const manifestRaw = await readFile(path.join(workspace, "outputs", "audit-external", "external-intake-manifest.json"), "utf8");
    expect(manifestRaw).not.toContain(external);
    expect(manifestRaw).toContain("<external-artifact-root>");
    expect(manifestRaw).not.toContain("secret/notes.txt");
    expect(manifestRaw).toContain("paper/draft.md");
    expect(manifestRaw).toContain("logs/external.log");

    const claimExport = await readFile(path.join(workspace, "outputs", "audit-external", "claim-evidence-table.json"), "utf8");
    expect(claimExport).toContain("claim_accuracy_delta");
    expect(claimExport).toContain("artifact_or_citation_linked");
  });
});
