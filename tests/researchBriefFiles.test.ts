import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildGuidedResearchBriefMarkdown,
  createResearchBriefFile,
  findLatestResearchBrief,
  getWorkspaceResearchBriefPath,
  resolveResearchBriefPath
} from "../src/core/runs/researchBriefFiles.js";

describe("researchBriefFiles", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(
      workspaces.splice(0).map((workspace) => rm(workspace, { recursive: true, force: true }))
    );
  });

  async function createWorkspace(): Promise<string> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-brief-files-"));
    workspaces.push(workspace);
    return workspace;
  }

  it("creates Brief.md at the workspace root", async () => {
    const workspace = await createWorkspace();

    const filePath = await createResearchBriefFile(workspace);

    expect(filePath).toBe(path.join(workspace, "Brief.md"));
    expect(await readFile(filePath, "utf8")).toContain("# Research Brief");
  });

  it("does not overwrite an existing workspace Brief.md", async () => {
    const workspace = await createWorkspace();
    const filePath = getWorkspaceResearchBriefPath(workspace);
    await writeFile(filePath, "# Research Brief\n\n## Topic\n\nKeep this content.", "utf8");

    const ensuredPath = await createResearchBriefFile(workspace);

    expect(ensuredPath).toBe(filePath);
    expect(await readFile(filePath, "utf8")).toContain("Keep this content.");
  });

  it("prefers workspace Brief.md over saved brief files", async () => {
    const workspace = await createWorkspace();
    const workspaceBriefPath = getWorkspaceResearchBriefPath(workspace);
    await writeFile(workspaceBriefPath, "# Research Brief\n\n## Topic\n\nWorkspace brief.", "utf8");
    const savedBriefDir = path.join(workspace, ".autolabos", "briefs");
    await mkdir(savedBriefDir, { recursive: true });
    await writeFile(
      path.join(savedBriefDir, "20260325-saved.md"),
      "# Research Brief\n\n## Topic\n\nSaved brief.",
      "utf8"
    );

    const latest = await findLatestResearchBrief(workspace);

    expect(latest).toBe(workspaceBriefPath);
  });

  it("falls back to the latest saved brief when workspace Brief.md is absent", async () => {
    const workspace = await createWorkspace();
    const savedBriefDir = path.join(workspace, ".autolabos", "briefs");
    await mkdir(savedBriefDir, { recursive: true });
    await writeFile(
      path.join(savedBriefDir, "20260324-older.md"),
      "# Research Brief\n\n## Topic\n\nOlder brief.",
      "utf8"
    );
    const latestSavedPath = path.join(savedBriefDir, "20260325-newer.md");
    await writeFile(latestSavedPath, "# Research Brief\n\n## Topic\n\nNewer brief.", "utf8");

    const latest = await findLatestResearchBrief(workspace);

    expect(latest).toBe(latestSavedPath);
  });

  it("resolves bare Brief.md to the workspace root while keeping other bare names as saved brief paths", () => {
    const workspace = path.join("/tmp", "autolabos-brief-resolution");

    expect(resolveResearchBriefPath(workspace, "Brief.md")).toBe(path.join(workspace, "Brief.md"));
    expect(resolveResearchBriefPath(workspace, "saved-brief.md")).toBe(
      path.join(workspace, ".autolabos", "briefs", "saved-brief.md")
    );
  });

  it("builds a substantive guided brief draft from interview answers", () => {
    const markdown = buildGuidedResearchBriefMarkdown({
      topic: "Compare lightweight instruction-tuning recipe choices for compact language models.",
      primaryMetric: "Mean zero-shot accuracy across Benchmark Task A and Benchmark Task B.",
      secondaryMetrics: "Runtime; peak GPU memory.",
      meaningfulImprovement: "+1.0 point over the tuned baseline.",
      constraints: "2x RTX 4090 only; public datasets only; seed=42 everywhere.",
      researchQuestion: "Which lightweight recipe choice improves benchmark accuracy most reliably under the local budget?",
      whySmallExperiment: "Public benchmarks exist; four-condition comparison is feasible; a named baseline is available.",
      baselineComparator: "Baseline name: tuned adapter baseline; Why relevant: standard compact-model comparator; Comparison dimension: accuracy and runtime.",
      datasetTaskBench: "Datasets: public instruction subset; Task type: instruction tuning and zero-shot evaluation; Validation discipline: fixed seed and fixed prompts.",
      targetComparison: "Proposed method: strongest alternative recipe; Comparator: tuned baseline; Dimension: benchmark accuracy delta.",
      minimumAcceptableEvidence: "At least +1.0 point over baseline; all planned conditions must execute; bootstrap CI required.",
      disallowedShortcuts: "No fabricated metrics; no skipped baseline; no checkpoint carry-over.",
      allowedBudgetedPasses: "One bounded repair pass; rerun only failed conditions.",
      paperCeiling: "research_memo",
      minimumExperimentPlan: "One tuned baseline; three alternatives; one result table; one limitations note.",
      failureConditions: "Baseline fails; metrics missing; no defensible quantitative comparison.",
      manuscriptTemplate: "template.tex",
      appendixPrefer: "hyperparameter_grids; environment_dump",
      appendixKeepMain: "main_result_tables; primary_recipe_ablation",
      notes: "Stay within local workstation limits.",
      questionsRisks: "Will the compact model provide enough signal?"
    });

    expect(markdown).toContain("# Research Brief");
    expect(markdown).toContain("## Topic");
    expect(markdown).toContain("Compare lightweight instruction-tuning recipe choices");
    expect(markdown).toContain("## Manuscript Template");
    expect(markdown).toContain("template.tex");
    expect(markdown).toContain("Prefer appendix for:");
    expect(markdown).toContain("- hyperparameter_grids");
    expect(markdown).toContain("Keep in main body:");
    expect(markdown).toContain("- main_result_tables");
    expect(markdown).toContain("## Failure Conditions");
  });
});
