import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";

import {
  applyUnifiedDiff,
  parseMetaHarnessResponse,
  runMetaHarness
} from "../src/core/metaHarness/metaHarness.js";
import type {
  HarnessApplyResult,
  HarnessEvaluationResult,
  HarnessEvaluator
} from "../src/core/metaHarness/harnessApplier.js";

const cleanupPaths: string[] = [];
const execFile = promisify(execFileCallback);

describe("runMetaHarness", () => {
  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))
    );
  });

  it("builds a proposer context directory with TASK.md and expected run files", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results", "review"],
        noApply: true
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace)
      }
    );

    expect(result.contextDir).toContain(path.join("outputs", "meta-harness"));
    const task = await fs.readFile(path.join(result.contextDir, "TASK.md"), "utf8");
    expect(task).toContain("TARGET_FILE: node-prompts/<node>.md");
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "analyze_results_events.jsonl"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "result_analysis.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "decision.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "node_strengthening_recommendations.json"))).resolves.toBeTruthy();
    expect(task).toContain("node_strengthening_recommendations.json");
    expect(task).toContain("prompt_target_map.json");
    expect(task).toContain("manuscript_quality_gate.json");
    expect(task).toContain("scientific_validation.json");
    expect(task).toContain("compile_report.json");
    expect(task).toContain("동결된 evidence contract");
    expect(task).toContain("단일 점수나 paper_readiness.overall_score를 직접 최적화하지 마세요");
    expect(task).toContain("research_process check");
    expect(task).not.toContain("seed 반복 부재");
    expect(task).not.toContain("smoke-test 수준 train budget");
    const promptTargetMap = JSON.parse(await fs.readFile(path.join(result.contextDir, "prompt_target_map.json"), "utf8")) as {
      targets: Array<{ source_artifact?: string; target_node: string; recommended_prompt_node: string; prompt_file: string }>;
    };
    expect(promptTargetMap.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_artifact: "run_status.json",
          target_node: "analyze_results",
          recommended_prompt_node: "analyze_results",
          diagnostic_ids: expect.arrayContaining(["hypothesis_disposition", "hypothesis_disposition_not_explicit"])
        }),
        expect.objectContaining({
          target_node: "run_experiments",
          recommended_prompt_node: "design_experiments",
          prompt_file: "node-prompts/design_experiments.md"
        }),
        expect.objectContaining({
          target_node: "write_paper",
          recommended_prompt_node: "review",
          prompt_file: "node-prompts/review.md"
        }),
        expect.objectContaining({
          source_artifact: "paper/manuscript_quality_gate.json",
          target_node: "write_paper",
          recommended_prompt_node: "review",
          prompt_file: "node-prompts/review.md"
        }),
        expect.objectContaining({
          source_artifact: "paper/scientific_validation.json",
          target_node: "run_experiments",
          recommended_prompt_node: "design_experiments",
          prompt_file: "node-prompts/design_experiments.md",
          diagnostic_ids: expect.arrayContaining(["resource measurement"])
        }),
        expect.objectContaining({
          source_artifact: "paper/gate_decision.json",
          target_node: "write_paper",
          recommended_prompt_node: "review",
          prompt_file: "node-prompts/review.md",
          diagnostic_ids: expect.arrayContaining(["cross_surface_aggregate_metric_conflict"])
        }),
        expect.objectContaining({
          source_artifact: "paper/compile_report.json",
          target_node: "write_paper",
          recommended_prompt_node: "review",
          prompt_file: "node-prompts/review.md",
          diagnostic_ids: expect.arrayContaining(["missing_bibliography_style_file"])
        })
      ])
    );
    await expect(fs.stat(path.join(result.contextDir, "node-prompts", "design_experiments.md"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "paper_readiness.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "run_status.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "manuscript_quality_gate.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "scientific_validation.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(result.contextDir, "runs", "run-1", "compile_report.json"))).resolves.toBeTruthy();
  });

  it("returns the context dir without modifying files in --no-apply mode", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const before = await fs.readFile(path.join(workspace, "node-prompts", "analyze_results.md"), "utf8");
    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results"],
        noApply: true
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace)
      }
    );

    expect(result.lines[0]).toContain("Meta-harness context prepared");
    expect(await fs.readFile(path.join(workspace, "node-prompts", "analyze_results.md"), "utf8")).toBe(before);
  });

  it("builds read-only external multi-run context bundles without calling LLM or apply", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const externalRunA = await createExternalRunRoot("external-a", {
      resultAnalysis: true,
      reviewDecision: true,
      paperReadiness: true,
      nodeStrengthening: true,
      unrelated: true
    });
    const externalRunB = await createExternalRunRoot("external-b", {
      resultAnalysis: true,
      reviewDecision: false,
      paperReadiness: false,
      unrelated: true
    });
    const callLlm = vi.fn();
    const applyWithSafetyNet = vi.fn();
    const bootstrapRuntime = vi.fn();

    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 0,
        nodes: ["analyze_results", "review"],
        externalRunRoots: [externalRunA, externalRunB],
        noApply: true
      },
      {
        bootstrapRuntime,
        callLlm,
        applyWithSafetyNet
      }
    );

    expect(result.lines.join("\n")).toContain("External run contexts included: 2");
    expect(callLlm).not.toHaveBeenCalled();
    expect(applyWithSafetyNet).not.toHaveBeenCalled();
    expect(bootstrapRuntime).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(result.contextDir, "external-runs", "external-1", "result_analysis.json"))
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(result.contextDir, "external-runs", "external-1", "review", "decision.json"))
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(result.contextDir, "external-runs", "external-1", "paper", "paper_readiness.json"))
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(result.contextDir, "external-runs", "external-1", "secret.txt"))
    ).rejects.toThrow();

    const manifestRaw = await fs.readFile(path.join(result.contextDir, "manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as {
      mode: string;
      external_context_count: number;
      external_contexts: Array<{
        source_label: string;
        copied_artifacts: string[];
        missing_optional_artifacts: string[];
      }>;
    };
    expect(manifest.mode).toBe("external_context");
    expect(manifest.external_context_count).toBe(2);
    expect(manifestRaw).not.toContain(externalRunA);
    expect(manifest.external_contexts[0]).toMatchObject({
      source_label: path.basename(externalRunA),
      copied_artifacts: expect.arrayContaining([
        "result_analysis.json",
        "review/decision.json",
        "paper/paper_readiness.json",
        "paper/manuscript_quality_gate.json",
        "paper/scientific_validation.json",
        "paper/compile_report.json"
      ])
    });
    expect(manifest.external_contexts[1]?.missing_optional_artifacts).toEqual(
      expect.arrayContaining(["review/decision.json", "paper/paper_readiness.json"])
    );
    const promptTargetMap = JSON.parse(await fs.readFile(path.join(result.contextDir, "prompt_target_map.json"), "utf8")) as {
      targets: Array<{
        source_artifact: string;
        target_node: string;
        recommended_prompt_node: string;
        diagnostic_ids?: string[];
      }>;
    };
    expect(promptTargetMap.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_artifact: "external-runs/external-1/review/node_strengthening_recommendations.json",
          target_node: "write_paper",
          recommended_prompt_node: "review"
        }),
        expect.objectContaining({
          source_artifact: "external-runs/external-1/review/node_strengthening_recommendations.json",
          target_node: "run_experiments",
          recommended_prompt_node: "design_experiments"
        }),
        expect.objectContaining({
          source_artifact: "external-runs/external-1/paper/compile_report.json",
          target_node: "write_paper",
          recommended_prompt_node: "review"
        })
      ])
    );
    expect(
      promptTargetMap.targets.filter((target) => target.diagnostic_ids?.includes("evidence_adequacy_not_passed"))
    ).toHaveLength(1);
    await expect(fs.stat(path.join(result.contextDir, "node-prompts", "design_experiments.md"))).resolves.toBeTruthy();
  });

  it("blocks external meta-harness contexts when apply mode is requested", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const externalRun = await createExternalRunRoot("external-blocked", { resultAnalysis: true });

    await expect(
      runMetaHarness(
        {
          cwd: workspace,
          runs: 0,
          nodes: ["analyze_results"],
          externalRunRoots: [externalRun],
          noApply: false
        },
        {
          bootstrapRuntime: fakeBootstrapRuntime(workspace)
        }
      )
    ).rejects.toThrow("--no-apply");
  });

  it("prints diff only in dry-run mode without changing files", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const before = await fs.readFile(targetFile, "utf8");
    const diff = [
      "TARGET_FILE: node-prompts/analyze_results.md",
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1 +1 @@",
      "-Prompt",
      "+Prompt improved"
    ].join("\n");

    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results"],
        dryRun: true
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace),
        callLlm: vi.fn().mockResolvedValue(diff)
      }
    );

    expect(result.diffText).toContain("+++ b/node-prompts/analyze_results.md");
    expect(await fs.readFile(targetFile, "utf8")).toBe(before);
  });

  it("surfaces invalid LLM diff output without changing files", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const before = await fs.readFile(targetFile, "utf8");

    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results"]
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace),
        callLlm: vi.fn().mockResolvedValue("not a diff")
      }
    );

    expect(result.lines.join("\n")).toContain("did not match");
    expect(await fs.readFile(targetFile, "utf8")).toBe(before);
  });

  it("passes the selected run scope and injected evaluator to the promotion safety net", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const diff = [
      "TARGET_FILE: node-prompts/analyze_results.md",
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1 +1 @@",
      "-Prompt",
      "+Prompt improved"
    ].join("\n");
    const promotionEvaluator: HarnessEvaluator = async ({ phase, subjectHash }) => evaluationResult(
      phase === "before" ? 0.62 : 0.84,
      subjectHash
    );
    const applyWithSafetyNet = vi.fn().mockResolvedValue(harnessApplyResult({
      applied: true,
      targetFile,
      workspace,
      scoreBefore: 0.62,
      scoreAfter: 0.84,
      scoreDelta: 0.22,
      promotionAllowed: true,
      structuralValidationPassed: true
    }));

    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results"]
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace),
        callLlm: vi.fn().mockResolvedValue(diff),
        applyWithSafetyNet,
        promotionEvaluator,
        promotionCriteria: {
          minimumScoreDelta: 0.1,
          minimumScoreAfter: 0.8
        }
      }
    );

    expect(applyWithSafetyNet).toHaveBeenCalledTimes(1);
    expect(applyWithSafetyNet).toHaveBeenCalledWith(expect.objectContaining({
      evaluator: promotionEvaluator,
      promotionCriteria: {
        minimumScoreDelta: 0.1,
        minimumScoreAfter: 0.8
      },
      evaluationScope: {
        run_ids: ["run-1"],
        target_node: "analyze_results",
        context_dir: expect.stringContaining("outputs/meta-harness/")
      }
    }));
    expect(result.lines.join("\n")).toContain("Promotion committed after matched re-evaluation");
    expect(result.lines.join("\n")).toContain("score_before=0.62, score_after=0.84");
  });

  it("defaults automatic apply to report-only when no evaluator is configured", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const diff = [
      "TARGET_FILE: node-prompts/analyze_results.md",
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1 +1 @@",
      "-Prompt",
      "+Prompt candidate"
    ].join("\n");

    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results"]
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace),
        callLlm: vi.fn().mockResolvedValue(diff)
      }
    );

    expect(await fs.readFile(targetFile, "utf8")).toBe("Prompt\n");
    expect(result.applied).toMatchObject({
      applied: false,
      promotionAllowed: false,
      structuralValidationPassed: false,
      rolledBack: false,
      scoreBefore: null,
      scoreAfter: null,
      blockedReason: expect.stringContaining("evaluation_before_unavailable")
    });
    expect(result.lines.join("\n")).toContain("Promotion unavailable; no file changes were applied");
    expect(result.lines.join("\n")).toContain("score_before=unavailable, score_after=unavailable");
    const audit = await fs.readFile(result.applied!.auditLogPath, "utf8");
    expect(audit).toContain('"promotion_allowed":false');
    expect(audit).toContain('"score_before":null');
    expect(audit).toContain('"score_after":null');
  });

  it("reports rollback when validation fails during apply", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const diff = [
      "TARGET_FILE: node-prompts/analyze_results.md",
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1 +1 @@",
      "-Prompt",
      "+Prompt improved"
    ].join("\n");
    const applyWithSafetyNet = vi.fn().mockResolvedValue(harnessApplyResult({
      applied: false,
      targetFile: path.join(workspace, "node-prompts", "analyze_results.md"),
      workspace,
      scoreBefore: 0.7,
      scoreAfter: 0.7,
      scoreDelta: 0,
      structuralValidationPassed: true,
      promotionAllowed: false,
      rolledBack: true,
      blockedReason: "score_not_improved",
      rollbackReason: "score_not_improved"
    }));

    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results"]
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace),
        callLlm: vi.fn().mockResolvedValue(diff),
        applyWithSafetyNet
      }
    );

    expect(result.lines.join("\n")).toContain("restored original file");
  });

  it("does not claim no changes when a created commit fails verification", async () => {
    const workspace = await createWorkspaceWithCompletedRun();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const diff = [
      "TARGET_FILE: node-prompts/analyze_results.md",
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1 +1 @@",
      "-Prompt",
      "+Prompt improved"
    ].join("\n");
    const applyWithSafetyNet = vi.fn().mockResolvedValue({
      ...harnessApplyResult({
        applied: false,
        targetFile,
        workspace,
        structuralValidationPassed: true,
        promotionAllowed: false,
        scoreBefore: 0.6,
        scoreAfter: 0.9,
        blockedReason: "commit_verification_failed: subject_hash_mismatch"
      }),
      gitCommitAfter: "def456",
      commitVerificationPassed: false
    });

    const result = await runMetaHarness(
      {
        cwd: workspace,
        runs: 1,
        nodes: ["analyze_results"]
      },
      {
        bootstrapRuntime: fakeBootstrapRuntime(workspace),
        callLlm: vi.fn().mockResolvedValue(diff),
        applyWithSafetyNet
      }
    );

    expect(result.lines.join("\n")).toContain("repository may already have changed");
    expect(result.lines.join("\n")).not.toContain("no file changes were applied");
  });
});

describe("parseMetaHarnessResponse", () => {
  it("returns null when the response format is invalid", () => {
    expect(parseMetaHarnessResponse("hello")).toBeNull();
  });

  it("requires both diff headers to match the declared prompt target", () => {
    const mismatched = [
      "TARGET_FILE: node-prompts/analyze_results.md",
      "--- a/node-prompts/review.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1 +1 @@",
      "-Prompt",
      "+Prompt improved"
    ].join("\n");

    expect(parseMetaHarnessResponse(mismatched)).toBeNull();
  });

  it("rejects undeclared prompt files and multi-file diffs", () => {
    const undeclared = [
      "TARGET_FILE: node-prompts/../outside.md",
      "--- a/node-prompts/../outside.md",
      "+++ b/node-prompts/../outside.md",
      "@@ -1 +1 @@",
      "-before",
      "+after"
    ].join("\n");
    const multiFile = [
      "TARGET_FILE: node-prompts/analyze_results.md",
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1 +1 @@",
      "-Prompt",
      "+Prompt improved",
      "--- a/node-prompts/review.md",
      "+++ b/node-prompts/review.md"
    ].join("\n");

    expect(parseMetaHarnessResponse(undeclared)).toBeNull();
    expect(parseMetaHarnessResponse(multiFile)).toBeNull();
  });
});

describe("applyUnifiedDiff", () => {
  it("applies ordered multi-hunk diffs only when source context matches", () => {
    const original = "alpha\nbeta\ngamma\ndelta\n";
    const diff = [
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1,2 +1,2 @@",
      " alpha",
      "-beta",
      "+beta revised",
      "@@ -4 +4 @@",
      "-delta",
      "+delta revised"
    ].join("\n");

    expect(applyUnifiedDiff(original, diff)).toBe(
      "alpha\nbeta revised\ngamma\ndelta revised\n"
    );
  });

  it("applies insertion-only hunks at the declared boundary", () => {
    const diff = [
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1,0 +2 @@",
      "+inserted"
    ].join("\n");

    expect(applyUnifiedDiff("alpha\nomega\n", diff)).toBe(
      "alpha\ninserted\nomega\n"
    );
  });

  it("rejects context or deleted lines that do not match the source", () => {
    const badContext = [
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1 +1 @@",
      " wrong"
    ].join("\n");
    const badDeletion = [
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1 +1 @@",
      "-wrong",
      "+replacement"
    ].join("\n");

    expect(() => applyUnifiedDiff("original\n", badContext)).toThrow("does not match source");
    expect(() => applyUnifiedDiff("original\n", badDeletion)).toThrow("does not match source");
  });

  it("rejects incorrect hunk counts and overlapping hunks", () => {
    const wrongCount = [
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1,2 +1 @@",
      "-alpha",
      "+revised"
    ].join("\n");
    const overlapping = [
      "--- a/node-prompts/analyze_results.md",
      "+++ b/node-prompts/analyze_results.md",
      "@@ -1,2 +1,2 @@",
      " alpha",
      " beta",
      "@@ -2 +2 @@",
      "-beta",
      "+revised"
    ].join("\n");

    expect(() => applyUnifiedDiff("alpha\nbeta\n", wrongCount)).toThrow("hunk count mismatch");
    expect(() => applyUnifiedDiff("alpha\nbeta\n", overlapping)).toThrow("overlap");
  });
});

function evaluationResult(score: number, subjectHash: string): HarnessEvaluationResult {
  return {
    status: "available",
    evaluatorId: "quality-evaluator-v1",
    diagnosticId: "weak-node-diagnostic",
    score,
    passed: true,
    subjectHash,
    artifactPath: "outputs/evaluations/meta-harness.json",
    reason: null
  };
}

function harnessApplyResult(input: {
  applied: boolean;
  targetFile: string;
  workspace: string;
  structuralValidationPassed: boolean;
  promotionAllowed: boolean;
  scoreBefore?: number | null;
  scoreAfter?: number | null;
  scoreDelta?: number | null;
  evaluationBefore?: HarnessEvaluationResult | null;
  evaluationAfter?: HarnessEvaluationResult | null;
  blockedReason?: string | null;
  rolledBack?: boolean;
  rollbackReason?: string | null;
}): HarnessApplyResult {
  const scoreBefore = input.scoreBefore ?? input.evaluationBefore?.score ?? null;
  const scoreAfter = input.scoreAfter ?? input.evaluationAfter?.score ?? null;
  const subjectHashBefore = input.evaluationBefore?.subjectHash
    ?? (scoreBefore === null ? null : "a".repeat(64));
  const subjectHashAfter = input.evaluationAfter?.subjectHash
    ?? (scoreAfter === null ? null : "b".repeat(64));
  const evaluationBefore = input.evaluationBefore
    ?? (scoreBefore === null ? null : evaluationResult(scoreBefore, subjectHashBefore!));
  const evaluationAfter = input.evaluationAfter
    ?? (scoreAfter === null ? null : evaluationResult(scoreAfter, subjectHashAfter!));
  return {
    applied: input.applied,
    targetFile: input.targetFile,
    gitCommitBefore: "abc123",
    gitCommitAfter: input.applied ? "def456" : null,
    commitVerificationPassed: input.applied,
    validationPassed: input.structuralValidationPassed,
    structuralValidationPassed: input.structuralValidationPassed,
    promotionAllowed: input.promotionAllowed,
    evaluationBefore,
    evaluationAfter,
    scoreBefore,
    scoreAfter,
    scoreDelta: input.scoreDelta ?? null,
    subjectHashBefore,
    subjectHashAfter,
    promotionCriteria: {
      minimumScoreDelta: 0.1,
      minimumScoreAfter: 0.8
    },
    blockedReason: input.blockedReason ?? null,
    rolledBack: input.rolledBack ?? false,
    rollbackReason: input.rollbackReason ?? null,
    auditLogPath: path.join(input.workspace, ".autolabos", "harness-apply-log.jsonl")
  };
}

async function createWorkspaceWithCompletedRun(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-meta-harness-"));
  cleanupPaths.push(workspace);
  const runRoot = path.join(workspace, ".autolabos", "runs", "run-1");
  await fs.mkdir(path.join(runRoot, "review"), { recursive: true });
  await fs.mkdir(path.join(runRoot, "paper"), { recursive: true });
  await fs.mkdir(path.join(workspace, "node-prompts"), { recursive: true });
  await fs.mkdir(path.join(workspace, "outputs", "eval-harness"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, ".autolabos", "runs", "run-1", "events.jsonl"),
    [
      JSON.stringify(makeEvent("run-1", "analyze_results", "NODE_STARTED")),
      JSON.stringify(makeEvent("run-1", "review", "NODE_COMPLETED"))
    ].join("\n") + "\n",
    "utf8"
  );
  await fs.writeFile(path.join(runRoot, "result_analysis.json"), JSON.stringify({ summary: "analysis" }, null, 2), "utf8");
  await fs.writeFile(
    path.join(runRoot, "run_status.json"),
    JSON.stringify({
      version: 1,
      run_id: "run-1",
      research_process: {
        version: 1,
        status: "blocked",
        checks: [{
          id: "hypothesis_disposition",
          status: "fail",
          required: true,
          reason_codes: ["hypothesis_disposition_not_explicit"],
          artifact_refs: [{ label: "Result analysis", path: "result_analysis.json" }]
        }]
      }
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(path.join(runRoot, "review", "decision.json"), JSON.stringify({ outcome: "revise" }, null, 2), "utf8");
  await fs.writeFile(path.join(runRoot, "review", "minimum_gate.json"), JSON.stringify({ passed: false }, null, 2), "utf8");
  await fs.writeFile(
    path.join(runRoot, "review", "paper_scale_diagnostics.json"),
    JSON.stringify({ diagnostics: [{ id: "evidence_adequacy_not_passed", target_node: "run_experiments" }] }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(runRoot, "review", "node_strengthening_recommendations.json"),
    JSON.stringify({
      recommendations: [
        { node: "run_experiments", priority: "high" },
        {
          node: "write_paper",
          priority: "high",
          diagnostic_ids: ["finding:paper_repeated_citation_bundle"],
          problem_summary: "Paper surface defect must be blocked before accepting the manuscript.",
          recheck_condition: "paper/render_validation.json passes and repeated citations are gone."
        }
      ]
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(path.join(runRoot, "review", "readiness_risks.json"), JSON.stringify({ risks: [] }, null, 2), "utf8");
  await fs.writeFile(path.join(runRoot, "review", "paper_quality_evaluation.json"), JSON.stringify({ overall_score_1_to_10: 2 }, null, 2), "utf8");
  await fs.writeFile(path.join(runRoot, "review", "paper_critique.json"), JSON.stringify({ manuscript_type: "research_memo" }, null, 2), "utf8");
  await fs.writeFile(
    path.join(runRoot, "paper", "paper_readiness.json"),
    JSON.stringify({ paper_ready: false, overall_score: 6.5 }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(runRoot, "paper", "manuscript_quality_gate.json"),
    JSON.stringify({ action: "pass", issues_after: [{ code: "alignment", section: "Results" }] }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(runRoot, "paper", "scientific_validation.json"),
    JSON.stringify({
      status: "warn",
      evidence_diagnostics: { missing_evidence_categories: ["resource measurement"] }
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(runRoot, "paper", "gate_decision.json"),
    JSON.stringify({
      status: "fail",
      blocking_issues: [
        { reason: "Table 1 and Figure 1 report conflicting aggregate primary outcome values." }
      ]
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(runRoot, "paper", "compile_report.json"),
    JSON.stringify({
      status: "success",
      attempts: [
        {
          commands: [
            {
              step: "bibtex",
              status: "error",
              stdout: "I couldn't open style file manuscript_style.bst\nI found no style file"
            }
          ]
        }
      ]
    }, null, 2),
    "utf8"
  );
  await fs.writeFile(path.join(workspace, "node-prompts", "analyze_results.md"), "Prompt\n", "utf8");
  await fs.writeFile(path.join(workspace, "node-prompts", "design_experiments.md"), "Design prompt\n", "utf8");
  await fs.writeFile(path.join(workspace, "node-prompts", "review.md"), "Review prompt\n", "utf8");
  await fs.writeFile(path.join(workspace, "outputs", "eval-harness", "history.jsonl"), "{\"timestamp\":\"2026-04-02T00:00:00.000Z\"}\n", "utf8");
  await fs.writeFile(path.join(workspace, ".gitignore"), ".autolabos/\noutputs/\n", "utf8");
  await execFile("git", ["init", "-q"], { cwd: workspace });
  await execFile("git", ["config", "user.name", "Meta Harness Test"], { cwd: workspace });
  await execFile("git", ["config", "user.email", "meta-harness@example.invalid"], { cwd: workspace });
  await execFile("git", ["add", ".gitignore", "node-prompts"], { cwd: workspace });
  await execFile("git", ["commit", "-q", "-m", "seed"], { cwd: workspace });
  return workspace;
}

async function createExternalRunRoot(
  name: string,
  options: {
    resultAnalysis?: boolean;
    reviewDecision?: boolean;
    paperReadiness?: boolean;
    nodeStrengthening?: boolean;
    unrelated?: boolean;
  }
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `autolabos-meta-harness-${name}-`));
  cleanupPaths.push(root);
  await fs.mkdir(path.join(root, "review"), { recursive: true });
  await fs.mkdir(path.join(root, "paper"), { recursive: true });
  if (options.resultAnalysis) {
    await fs.writeFile(path.join(root, "result_analysis.json"), JSON.stringify({ summary: name }, null, 2), "utf8");
  }
  if (options.reviewDecision) {
    await fs.writeFile(path.join(root, "review", "decision.json"), JSON.stringify({ outcome: "revise" }, null, 2), "utf8");
  }
  if (options.nodeStrengthening) {
    await fs.writeFile(
      path.join(root, "review", "node_strengthening_recommendations.json"),
      JSON.stringify({
        recommendations: [
          { node: "write_paper", priority: "high", diagnostic_ids: ["finding:paper_surface"] },
          { node: "run_experiments", priority: "high", diagnostic_ids: ["evidence_adequacy_not_passed"] }
        ]
      }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "review", "paper_scale_diagnostics.json"),
      JSON.stringify({
        diagnostics: [
          { id: "evidence_adequacy_not_passed", target_node: "run_experiments" },
          { id: "evidence_adequacy_not_passed", target_node: "run_experiments" }
        ]
      }, null, 2),
      "utf8"
    );
  }
  if (options.paperReadiness) {
    await fs.writeFile(
      path.join(root, "paper", "paper_readiness.json"),
      JSON.stringify({ paper_ready: false, overall_score: 5 }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "paper", "manuscript_quality_gate.json"),
      JSON.stringify({ action: "pass", issues_after: [{ code: "alignment" }] }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "paper", "scientific_validation.json"),
      JSON.stringify({
        status: "warn",
        evidence_diagnostics: { missing_evidence_categories: ["resource measurement"] }
      }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "paper", "gate_decision.json"),
      JSON.stringify({
        status: "fail",
        blocking_issues: [
          { reason: "Table 1 and Figure 1 report conflicting aggregate primary outcome values." }
        ]
      }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "paper", "compile_report.json"),
      JSON.stringify({
        status: "success",
        attempts: [
          { commands: [{ step: "bibtex", status: "error", stdout: "I couldn't open style file manuscript_style.bst" }] }
        ]
      }, null, 2),
      "utf8"
    );
  }
  if (options.unrelated) {
    await fs.writeFile(path.join(root, "secret.txt"), "do not copy\n", "utf8");
  }
  return root;
}

function fakeBootstrapRuntime(workspace: string) {
  return vi.fn().mockResolvedValue({
    configured: true,
    firstRunSetup: false,
    paths: { cwd: workspace },
    runtime: {
      paths: { cwd: workspace },
      config: {
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: {
            model: "gpt-5.3-codex",
            reasoning_effort: "medium",
            fast_mode: false
          },
          openai: {
            model: "gpt-5.1",
            reasoning_effort: "medium"
          },
          ollama: {
            base_url: "http://127.0.0.1:11434"
          }
        }
      },
      codex: {},
      openAiTextClient: {},
      runStore: {
        listRuns: vi.fn().mockResolvedValue([
          {
            id: "run-1",
            title: "Run 1",
            topic: "Topic",
            objectiveMetric: "metric",
            constraints: [],
            status: "completed",
            currentNode: "write_paper",
            latestSummary: "done",
            nodeThreads: {},
            createdAt: "2026-04-02T00:00:00.000Z",
            updatedAt: "2026-04-02T00:00:00.000Z",
            graph: {} as never,
            memoryRefs: {
              runContextPath: ".autolabos/runs/run-1/memory/run_context.json",
              longTermPath: ".autolabos/runs/run-1/memory/long_term.jsonl",
              episodePath: ".autolabos/runs/run-1/memory/episodes.jsonl"
            }
          }
        ])
      }
    }
  });
}

function makeEvent(runId: string, node: "analyze_results" | "review", type: "NODE_STARTED" | "NODE_COMPLETED") {
  return {
    id: `evt-${node}`,
    type,
    timestamp: "2026-04-02T00:00:00.000Z",
    runId,
    node,
    payload: {}
  };
}
