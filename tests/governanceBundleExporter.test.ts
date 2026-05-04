import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { exportGovernanceDemoBundles } from "../src/core/benchmark/governanceBundleExporter.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("governance demo bundle exporter", () => {
  it("exports three public output bundles and keeps readiness states distinct", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-demo-bundle-"));
    tempDirs.push(workspace);
    const ready = await writePublicOutputFixture(workspace, {
      slug: "paper-ready-run",
      runId: "ready-12345678",
      title: "Paper Ready Run",
      paperReady: true,
      readinessState: "paper_ready",
      mainTex: true,
      pdf: true,
      unsupportedClaim: false
    });
    const pdfOnly = await writePublicOutputFixture(workspace, {
      slug: "pdf-only-run",
      runId: "pdf-12345678",
      title: "PDF Only Run",
      paperReady: false,
      readinessState: "research_memo",
      mainTex: true,
      pdf: true,
      unsupportedClaim: true
    });
    const manuscriptOnly = await writePublicOutputFixture(workspace, {
      slug: "manuscript-only-run",
      runId: "draft-12345678",
      title: "Draft Only Run",
      paperReady: false,
      readinessState: "paper_scale_candidate",
      mainTex: true,
      pdf: false,
      unsupportedClaim: true
    });

    const manifest = await exportGovernanceDemoBundles({
      cwd: workspace,
      publicOutputRoots: [ready, pdfOnly, manuscriptOnly],
      outDir: "outputs/governance-benchmark/demo-bundles"
    });

    expect(manifest.selected_count).toBe(3);
    expect(manifest.readiness_summary).toEqual({
      workflow_completed_count: 3,
      write_paper_completed_count: 3,
      pdf_built_count: 2,
      paper_ready_count: 1
    });
    expect(manifest.entries.map((entry) => entry.readiness.paper_ready)).toEqual([true, false, false]);
    expect(manifest.entries.map((entry) => entry.readiness.pdf_built)).toEqual([true, true, false]);
    expect(manifest.entries[1].unsupported_claim_notes).toContain("Unsupported improvement claim.");

    const exportedPdf = path.join(workspace, manifest.entries[0].bundle_dir, "paper", "main.pdf");
    await expect(readFile(exportedPdf, "utf8")).resolves.toContain("%PDF");
    const readme = await readFile(path.join(workspace, manifest.output_dir, "README.md"), "utf8");
    expect(readme).toContain("built PDF is not equivalent to `paper_ready=true`");
    expect(readme).toContain("Paper Ready Run");

    expect(await readdir(path.join(workspace, "outputs", "paper-ready-run"))).not.toContain("demo_bundle_entry.json");
  });

  it("uses a placeholder for external public output roots", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-demo-bundle-workspace-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "autolabos-demo-bundle-external-"));
    tempDirs.push(workspace, external);
    const source = await writePublicOutputFixture(external, {
      slug: "external-run",
      runId: "external-12345678",
      title: "External Run",
      paperReady: false,
      readinessState: "research_memo",
      mainTex: true,
      pdf: false,
      unsupportedClaim: true
    });

    const manifest = await exportGovernanceDemoBundles({
      cwd: workspace,
      publicOutputRoots: [source]
    });

    expect(manifest.entries[0].source_ref).toBe("<external-public-output>/external-run");
    const summary = await readFile(path.join(workspace, manifest.output_dir, "bundle_manifest.json"), "utf8");
    expect(summary).not.toContain(external);
  });
});

async function writePublicOutputFixture(
  workspace: string,
  input: {
    slug: string;
    runId: string;
    title: string;
    paperReady: boolean;
    readinessState: string;
    mainTex: boolean;
    pdf: boolean;
    unsupportedClaim: boolean;
  }
): Promise<string> {
  const root = path.join(workspace, "outputs", input.slug);
  await mkdir(path.join(root, "experiment"), { recursive: true });
  await mkdir(path.join(root, "review"), { recursive: true });
  await mkdir(path.join(root, "paper"), { recursive: true });
  await mkdir(path.join(root, "reproduce"), { recursive: true });
  await mkdir(path.join(root, "results"), { recursive: true });
  await writeJson(path.join(root, "manifest.json"), {
    version: 1,
    run_id: input.runId,
    title: input.title,
    generated_files: [
      "experiment/brief.md",
      "review/decision.json",
      ...(input.mainTex ? ["paper/main.tex"] : []),
      ...(input.pdf ? ["paper/main.pdf"] : [])
    ]
  });
  await writeFile(path.join(root, "experiment", "brief.md"), "# Brief\n", "utf8");
  await writeJson(path.join(root, "experiment", "governance_condition.json"), { name: "gated" });
  await writeJson(path.join(root, "reproduce", "run_config.json"), { provider: "test" });
  await writeFile(path.join(root, "reproduce", "events.jsonl"), JSON.stringify({ type: "NODE_COMPLETED" }) + "\n", "utf8");
  await writeJson(path.join(root, "results", "governance_score.json"), { overall_score: 0.8 });
  await writeJson(path.join(root, "review", "decision.json"), { outcome: "advance" });
  await writeJson(path.join(root, "paper", "paper_readiness.json"), {
    paper_ready: input.paperReady,
    readiness_state: input.readinessState
  });
  await writeJson(path.join(root, "paper", "evidence_gate_decision.json"), {
    blocked_comparative_claims: input.unsupportedClaim
      ? [{ reason: "Unsupported improvement claim." }]
      : []
  });
  await writeJson(path.join(root, "paper", "claim_status_table.json"), {
    claims: input.unsupportedClaim
      ? [{ claim_id: "claim_1", statement: "Unsupported improvement claim.", status: "unverified" }]
      : []
  });
  if (input.mainTex) {
    await writeFile(path.join(root, "paper", "main.tex"), "\\section{Result}\n", "utf8");
  }
  if (input.pdf) {
    await writeFile(path.join(root, "paper", "main.pdf"), "%PDF-1.4 mock\n", "utf8");
  }
  await writeFile(path.join(root, "README.md"), `# ${input.title}\n`, "utf8");
  return root;
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}
