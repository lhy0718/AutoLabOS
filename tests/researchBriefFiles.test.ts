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
      topic: "Compare a candidate condition with a declared reference under a bounded protocol.",
      primaryMetric: "Primary score over the declared evaluation collection.",
      secondaryMetrics: "Secondary score; resource use.",
      meaningfulImprovement: "A preregistered practical-effect boundary over the reference condition.",
      constraints: "Single workstation only; licensed public data only; fixed declared seed.",
      researchQuestion: "Does the candidate condition improve the primary score over the reference condition?",
      whySmallExperiment: "Public evaluation units exist; the matched comparison is feasible; a named reference is available.",
      baselineComparator: "Baseline name: reference condition; Why relevant: declared comparator; Comparison dimension: primary score and resource use.",
      datasetTaskBench: "Dataset: public evaluation collection; Task type: configured evaluation; Validation discipline: fixed seed and split.",
      targetComparison: "Proposed method: candidate condition; Comparator: reference condition; Dimension: primary-score delta.",
      minimumAcceptableEvidence: "The practical-effect boundary is met; all conditions execute; an interval estimate is required.",
      disallowedShortcuts: "No fabricated metrics; no skipped reference; no checkpoint carry-over.",
      allowedBudgetedPasses: "One bounded repair pass; rerun only failed conditions.",
      paperCeiling: "research_memo",
      minimumExperimentPlan: "One reference run; one candidate run; one result table; one limitations note.",
      failureConditions: "Reference execution fails; metrics are missing; no defensible quantitative comparison.",
      manuscriptTemplate: "template.tex",
      appendixPrefer: "environment_manifest; extended_error_analysis",
      appendixKeepMain: "main_result_table; primary_comparison",
      notes: "Stay within local workstation limits.",
      questionsRisks: "Will the candidate provide enough signal?"
    });

    expect(markdown).toContain("# Research Brief");
    expect(markdown).toContain("## Topic");
    expect(markdown).toContain("Compare a candidate condition with a declared reference");
    expect(markdown).toContain("## Manuscript Template");
    expect(markdown).toContain("template.tex");
    expect(markdown).toContain("Prefer appendix for:");
    expect(markdown).toContain("- environment_manifest");
    expect(markdown).toContain("Keep in main body:");
    expect(markdown).toContain("- main_result_table");
    expect(markdown).toContain("## Failure Conditions");
  });

  it("builds a topic-discovery plan without pre-committing the final experiment", () => {
    const markdown = buildGuidedResearchBriefMarkdown({
      researchMode: "topic_discovery",
      topic: "Reliability methods for bounded automated research workflows.",
      scientificObject: "automated research evaluation",
      empiricalProblems: "decision stability under finite evidence; uncertainty calibration under dependent tasks",
      priorWorkProbes: "whether adaptive evaluation already subsumes the proposed scope",
      primaryMetric: "Every candidate must declare one judge-independent primary metric.",
      meaningfulImprovement: "Every candidate must declare a practical-effect boundary.",
      constraints: "Licensed public data only; bounded local compute.",
      researchQuestion: "Which under-studied failure supports a falsifiable local study?",
      whySmallExperiment: "Only candidates with a bounded real probe may be promoted.",
      baselineComparator: "Each candidate must name a strong comparator.",
      datasetTaskBench: "Each candidate must bind a licensed source and frozen split.",
      targetComparison: "Each candidate must declare an intervention, direction, and falsifier.",
      minimumAcceptableEvidence: "Two closest priors, real probe evidence, uncertainty, and a kill decision.",
      disallowedShortcuts: "No outcome-driven gate changes.",
      allowedBudgetedPasses: "One bounded repair pass before outcomes are opened.",
      paperCeiling: "research_memo",
      minimumExperimentPlan: "One frozen candidate contract; one comparator; one bounded probe.",
      failureConditions: "No licensed data; no deterministic endpoint; prior work absorbs the claim."
    });

    expect(markdown).toContain("## Research Mode\ntopic_discovery");
    expect(markdown).toContain("## Scientific Scope");
    expect(markdown).toContain("### Scientific Object\n- automated research evaluation");
    expect(markdown).toContain("### Empirical Problems");
    expect(markdown).toContain("generate five to seven candidate-owned contracts");
    expect(markdown).toContain("metric, explicit unit and numeric scale, direction, structured effect criterion");
    expect(markdown).toContain("authorize exactly one bounded probe");
    expect(markdown).not.toContain("lock a named baseline");
    expect(markdown).not.toContain("implement and run the baseline plus alternative condition(s)");
  });
});
