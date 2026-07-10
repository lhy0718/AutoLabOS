import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCliAction } from "../src/cli/args.js";
import {
  runResearchAudit,
  runResearchImprove,
  runResearchNew,
  runResearchPack,
  runResearchReview
} from "../src/core/researchGovernanceOperations.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("research governance operations", () => {
  it("parses all five artifact-first research intents", () => {
    expect(resolveCliAction(["research", "new", "--brief", "Brief.md"])).toMatchObject({ kind: "research-new" });
    expect(resolveCliAction(["research", "audit", "--external", "artifacts"])).toMatchObject({ kind: "research-audit" });
    expect(resolveCliAction(["research", "review", "--gate", "gate-report.json"])).toMatchObject({ kind: "research-review" });
    expect(resolveCliAction(["research", "improve", "--review", "review-report.json"])).toMatchObject({ kind: "research-improve" });
    expect(resolveCliAction([
      "research",
      "pack",
      "--gate",
      "gate-report.json",
      "--review",
      "review-report.json"
    ])).toMatchObject({ kind: "research-pack" });
  });

  it("creates a versioned ResearchBrief artifact without pretending an empty template is complete", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-new-"));
    tempDirs.push(workspace);

    const result = await runResearchNew({
      cwd: workspace,
      briefPath: "Brief.md",
      outDir: "outputs/governance/new"
    });

    expect(result.artifact.artifact_type).toBe("ResearchBrief");
    expect(result.artifact.schema_version).toBe("1.0");
    expect(result.artifact.completeness.paper_scale_ready).toBe(false);
    expect(result.artifact.validation.errors.length).toBeGreaterThan(0);
    expect(result.output_path).toBe("outputs/governance/new/research-brief.json");
  });

  it("preserves an honest downgrade through audit, review, improve, and pack", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-chain-"));
    const external = path.join(workspace, "external-artifacts");
    tempDirs.push(workspace);
    await mkdir(external, { recursive: true });

    const gateResult = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit"
    });
    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      outDir: "outputs/governance/review"
    });
    const improveResult = await runResearchImprove({
      cwd: workspace,
      reviewPath: reviewResult.output_path,
      outDir: "outputs/governance/improve"
    });
    const packResult = await runResearchPack({
      cwd: workspace,
      gatePath: gateResult.output_path,
      reviewPath: reviewResult.output_path,
      sourceDir: "outputs/governance/audit",
      outDir: "outputs/governance/pack"
    });

    expect(gateResult.artifact.verdict).toBe("blocked");
    expect(reviewResult.artifact.readiness_class).toBe("blocked_for_paper_scale");
    expect(reviewResult.artifact.paper_ready).toBe(false);
    expect(improveResult.artifact.apply_mode).toBe("plan_only");
    expect(improveResult.artifact.targets.length).toBeGreaterThan(0);
    expect(improveResult.artifact.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ finding_code: "artifact_contract_incomplete", target_node: "run_experiments" }),
      expect.objectContaining({ finding_code: "result_table_missing", target_node: "analyze_results" })
    ]));
    expect(packResult.artifact.paper_ready).toBe(false);
    expect(packResult.artifact.limitations.length).toBeGreaterThan(0);
    expect(packResult.artifact.files.every((file) => !path.isAbsolute(file.path))).toBe(true);
    expect(JSON.stringify(packResult)).not.toContain(workspace);
  });

  it("advances a structurally complete external bundle only to its supported claim ceiling", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-complete-"));
    const external = path.join(workspace, "external-artifacts");
    tempDirs.push(workspace);
    await writeCompleteExternalBundle(external);

    const gateResult = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit"
    });
    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      outDir: "outputs/governance/review"
    });

    expect(gateResult.artifact.verdict).toBe("pass");
    expect(gateResult.artifact.claim_ceiling).toBe("conditional_claims_with_artifact_links");
    expect(reviewResult.artifact.readiness_class).toBe("paper_scale_candidate");
    expect(reviewResult.artifact.paper_ready).toBe(false);
  });
});

async function writeCompleteExternalBundle(root: string): Promise<void> {
  await mkdir(path.join(root, "figure_audit"), { recursive: true });
  await mkdir(path.join(root, "review"), { recursive: true });
  await mkdir(path.join(root, "paper"), { recursive: true });
  await writeJson(path.join(root, "governance_condition.json"), { name: "gated" });
  await writeJson(path.join(root, "result_table.json"), [
    {
      metric: "primary_score",
      baseline: 0.61,
      comparator: 0.67,
      delta: 0.06,
      direction: "higher_better"
    }
  ]);
  await writeFile(
    path.join(root, "evidence_store.jsonl"),
    `${JSON.stringify({ id: "metric_evidence", metric: "primary_score", value: 0.67, metric_evidence_present: true })}\n`,
    "utf8"
  );
  await writeJson(path.join(root, "figure_audit", "figure_audit_summary.json"), {
    figure_count: 1,
    issues: [],
    severe_mismatch_count: 0,
    review_block_required: false
  });
  await writeJson(path.join(root, "review", "paper_critique.json"), {
    paper_readiness_state: "paper_scale_candidate",
    claim_ceiling_applied: true
  });
  await writeJson(path.join(root, "review", "decision.json"), { outcome: "revise" });
  await writeFile(path.join(root, "paper", "main.tex"), "\\section{Results}\n", "utf8");
  await writeJson(path.join(root, "paper", "paper_readiness.json"), {
    paper_ready: false,
    readiness_state: "paper_scale_candidate"
  });
  await writeJson(path.join(root, "paper", "claim_evidence_table.json"), { claims: [] });
  await writeJson(path.join(root, "paper", "claim_status_table.json"), { claims: [] });
  await writeJson(path.join(root, "paper", "evidence_links.json"), { claims: [] });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}
