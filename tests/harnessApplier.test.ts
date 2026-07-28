import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";

import {
  applyWithSafetyNet,
  type HarnessEvaluationResult,
  type HarnessEvaluator
} from "../src/core/metaHarness/harnessApplier.js";

const cleanupPaths: string[] = [];
const execFile = promisify(execFileCallback);

describe("applyWithSafetyNet", () => {
  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))
    );
  });

  it("fails closed before writing when no domain evaluator is configured", async () => {
    const workspace = await createWorkspace();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const original = await fs.readFile(targetFile, "utf8");
    const runValidateHarness = vi.fn().mockResolvedValue(undefined);
    const gitCommit = vi.fn().mockResolvedValue(undefined);

    const result = await applyWithSafetyNet(
      {
        targetFile,
        newContent: "updated prompt\n",
        source: "meta-harness",
        candidateId: "candidate-unavailable"
      },
      {
        runValidateHarness,
        gitRevParseHead: vi.fn().mockResolvedValue("abc123"),
        gitCommit
      }
    );

    expect(result.applied).toBe(false);
    expect(result.promotionAllowed).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.blockedReason).toContain("evaluation_before_unavailable");
    expect(runValidateHarness).not.toHaveBeenCalled();
    expect(gitCommit).not.toHaveBeenCalled();
    expect(await fs.readFile(targetFile, "utf8")).toBe(original);

    const audit = await readLastAuditEntry(result.auditLogPath);
    expect(audit).toMatchObject({
      promotion_allowed: false,
      score_before: null,
      score_after: null,
      blocked_reason: expect.stringContaining("evaluation_before_unavailable"),
      promotion_criteria: {
        same_evaluator_required: true,
        same_diagnostic_required: true,
        score_after_must_exceed_score_before: true,
        minimum_score_delta: 0,
        minimum_score_after: null,
        evaluation_after_pass_required: true
      }
    });
  });

  it("rolls back when structural validation fails after the before evaluation", async () => {
    const workspace = await createWorkspace();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const original = await fs.readFile(targetFile, "utf8");
    const evaluator = createPhaseEvaluator({ before: 0.6, after: 0.9 });

    const result = await applyWithSafetyNet(
      {
        targetFile,
        newContent: "broken prompt\n",
        source: "meta-harness",
        candidateId: "candidate-structural",
        evaluator
      },
      {
        runValidateHarness: vi.fn().mockRejectedValue(new Error("validate failed")),
        gitRevParseHead: vi.fn().mockResolvedValue("abc123"),
        gitCommit: vi.fn().mockResolvedValue(undefined)
      }
    );

    expect(result.applied).toBe(false);
    expect(result.structuralValidationPassed).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.blockedReason).toContain("structural_validation_failed");
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(targetFile, "utf8")).toBe(original);
  });

  it("blocks promotion and records scores when re-evaluation does not improve", async () => {
    const workspace = await createWorkspace();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const original = await fs.readFile(targetFile, "utf8");
    const evaluator = createPhaseEvaluator({ before: 0.72, after: 0.72 });
    const gitCommit = vi.fn().mockResolvedValue(undefined);

    const result = await applyWithSafetyNet(
      {
        targetFile,
        newContent: "candidate prompt\n",
        source: "meta-harness",
        candidateId: "candidate-flat",
        evaluator,
        promotionCriteria: {
          minimumScoreDelta: 0.05,
          minimumScoreAfter: 0.8
        }
      },
      {
        runValidateHarness: vi.fn().mockResolvedValue(undefined),
        gitRevParseHead: vi.fn().mockResolvedValue("abc123"),
        gitCommit
      }
    );

    expect(result.applied).toBe(false);
    expect(result.structuralValidationPassed).toBe(true);
    expect(result.promotionAllowed).toBe(false);
    expect(result.scoreBefore).toBe(0.72);
    expect(result.scoreAfter).toBe(0.72);
    expect(result.scoreDelta).toBe(0);
    expect(result.blockedReason).toContain("score_not_improved");
    expect(result.rolledBack).toBe(true);
    expect(evaluator.mock.calls.map(([input]) => input.phase)).toEqual(["before", "after"]);
    expect(gitCommit).not.toHaveBeenCalled();
    expect(await fs.readFile(targetFile, "utf8")).toBe(original);

    const audit = await readLastAuditEntry(result.auditLogPath);
    expect(audit).toMatchObject({
      structural_validation_passed: true,
      promotion_allowed: false,
      evaluator_id: "quality-evaluator-v1",
      diagnostic_id: "weak-node-diagnostic",
      score_before: 0.72,
      score_after: 0.72,
      score_delta: 0,
      blocked_reason: expect.stringContaining("score_not_improved")
    });
  });

  it("blocks an improved score that remains below the explicit passing threshold", async () => {
    const workspace = await createWorkspace();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const original = await fs.readFile(targetFile, "utf8");
    const evaluator = createPhaseEvaluator({ before: 0.58, after: 0.76 });
    const gitCommit = vi.fn().mockResolvedValue(undefined);

    const result = await applyWithSafetyNet(
      {
        targetFile,
        newContent: "candidate prompt\n",
        source: "meta-harness",
        candidateId: "candidate-below-threshold",
        evaluator,
        promotionCriteria: {
          minimumScoreDelta: 0.1,
          minimumScoreAfter: 0.8
        }
      },
      {
        runValidateHarness: vi.fn().mockResolvedValue(undefined),
        gitRevParseHead: vi.fn().mockResolvedValue("abc123"),
        gitCommit
      }
    );

    expect(result.applied).toBe(false);
    expect(result.scoreDelta).toBe(0.18);
    expect(result.blockedReason).toContain("minimum_score_after_not_met");
    expect(result.rolledBack).toBe(true);
    expect(gitCommit).not.toHaveBeenCalled();
    expect(await fs.readFile(targetFile, "utf8")).toBe(original);
  });

  it("blocks promotion when the after evaluation changes diagnostic identity", async () => {
    const workspace = await createWorkspace();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const original = await fs.readFile(targetFile, "utf8");
    const evaluator: HarnessEvaluator = vi.fn(async ({ phase, subjectHash }) => evaluationResult({
      score: phase === "before" ? 0.5 : 0.9,
      diagnosticId: phase === "before" ? "diagnostic-a" : "diagnostic-b",
      subjectHash
    }));
    const gitCommit = vi.fn().mockResolvedValue(undefined);

    const result = await applyWithSafetyNet(
      {
        targetFile,
        newContent: "candidate prompt\n",
        source: "meta-harness",
        candidateId: "candidate-mismatch",
        evaluator
      },
      {
        runValidateHarness: vi.fn().mockResolvedValue(undefined),
        gitRevParseHead: vi.fn().mockResolvedValue("abc123"),
        gitCommit
      }
    );

    expect(result.applied).toBe(false);
    expect(result.blockedReason).toContain("diagnostic_mismatch");
    expect(result.rolledBack).toBe(true);
    expect(gitCommit).not.toHaveBeenCalled();
    expect(await fs.readFile(targetFile, "utf8")).toBe(original);
  });

  it("blocks an improved score that is not bound to the candidate subject hash", async () => {
    const workspace = await createWorkspace();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const original = await fs.readFile(targetFile, "utf8");
    const evaluator: HarnessEvaluator = vi.fn(async ({ phase, subjectHash }) => evaluationResult({
      score: phase === "before" ? 0.48 : 0.91,
      subjectHash: phase === "before" ? subjectHash : "0".repeat(64)
    }));
    const gitCommit = vi.fn().mockResolvedValue(undefined);

    const result = await applyWithSafetyNet(
      {
        targetFile,
        newContent: "candidate prompt\n",
        source: "meta-harness",
        candidateId: "candidate-unbound-score",
        evaluator
      },
      {
        runValidateHarness: vi.fn().mockResolvedValue(undefined),
        gitRevParseHead: vi.fn().mockResolvedValue("abc123"),
        gitCommit
      }
    );

    expect(result.applied).toBe(false);
    expect(result.blockedReason).toContain("evaluation_after_subject_hash_mismatch");
    expect(result.rolledBack).toBe(true);
    expect(gitCommit).not.toHaveBeenCalled();
    expect(await fs.readFile(targetFile, "utf8")).toBe(original);

    const audit = await readLastAuditEntry(result.auditLogPath);
    expect(audit).toMatchObject({
      promotion_allowed: false,
      score_before: 0.48,
      score_after: 0.91,
      blocked_reason: expect.stringContaining("evaluation_after_subject_hash_mismatch")
    });
  });

  it("commits only after matched re-evaluation improves and passes explicit criteria", async () => {
    const workspace = await createWorkspace();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const evaluator = createPhaseEvaluator({ before: 0.61, after: 0.84 });
    const runValidateHarness = vi.fn().mockResolvedValue(undefined);
    const gitCommit = vi.fn().mockResolvedValue(undefined);

    const result = await applyWithSafetyNet(
      {
        targetFile,
        newContent: "improved prompt\n",
        source: "meta-harness",
        candidateId: "candidate-promoted",
        evaluator,
        evaluationScope: {
          run_ids: ["run-validation"],
          target_node: "analyze_results"
        },
        promotionCriteria: {
          minimumScoreDelta: 0.1,
          minimumScoreAfter: 0.8
        }
      },
      {
        runValidateHarness,
        gitRevParseHead: vi.fn().mockResolvedValue("abc123"),
        gitCommit
      }
    );

    expect(result.applied).toBe(true);
    expect(result.validationPassed).toBe(true);
    expect(result.structuralValidationPassed).toBe(true);
    expect(result.promotionAllowed).toBe(true);
    expect(result.scoreBefore).toBe(0.61);
    expect(result.scoreAfter).toBe(0.84);
    expect(result.scoreDelta).toBe(0.23);
    expect(result.subjectHashBefore).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.subjectHashAfter).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.subjectHashAfter).not.toBe(result.subjectHashBefore);
    expect(result.blockedReason).toBeNull();
    expect(evaluator.mock.calls.map(([input]) => input.phase)).toEqual(["before", "after"]);
    expect(runValidateHarness).toHaveBeenCalledTimes(1);
    expect(gitCommit).toHaveBeenCalledWith(
      workspace,
      targetFile,
      expect.stringContaining("auto-apply meta-harness")
    );
    expect(await fs.readFile(targetFile, "utf8")).toBe("improved prompt\n");

    const audit = await readLastAuditEntry(result.auditLogPath);
    expect(audit).toMatchObject({
      applied: true,
      structural_validation_passed: true,
      promotion_allowed: true,
      score_before: 0.61,
      score_after: 0.84,
      score_delta: 0.23,
      subject_hash_before: result.subjectHashBefore,
      subject_hash_after: result.subjectHashAfter,
      promotion_criteria: {
        score_subject_hash_binding_required: true,
        minimum_score_delta: 0.1,
        minimum_score_after: 0.8
      }
    });
  });

  it("restores the original worktree content when the isolated commit fails", async () => {
    const workspace = await createWorkspace();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const original = await fs.readFile(targetFile, "utf8");
    const evaluator = createPhaseEvaluator({ before: 0.4, after: 0.9 });

    const result = await applyWithSafetyNet(
      {
        targetFile,
        newContent: "candidate prompt\n",
        source: "meta-harness",
        candidateId: "candidate-commit-failure",
        evaluator
      },
      {
        runValidateHarness: vi.fn().mockResolvedValue(undefined),
        gitRevParseHead: vi.fn().mockResolvedValue("abc123"),
        gitCommit: vi.fn().mockRejectedValue(new Error("commit hook rejected candidate"))
      }
    );

    expect(result.applied).toBe(false);
    expect(result.promotionAllowed).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.blockedReason).toContain("commit_failed");
    expect(await fs.readFile(targetFile, "utf8")).toBe(original);
  });

  it("does not leave a rejected candidate in the real Git index", async () => {
    const workspace = await createWorkspace();
    const targetFile = path.join(workspace, "node-prompts", "analyze_results.md");
    const original = await fs.readFile(targetFile, "utf8");
    await execFile("git", ["init"], { cwd: workspace });
    await execFile("git", ["config", "user.name", "Harness Test"], { cwd: workspace });
    await execFile("git", ["config", "user.email", "harness@example.invalid"], { cwd: workspace });
    await execFile("git", ["add", "node-prompts/analyze_results.md"], { cwd: workspace });
    await execFile("git", ["commit", "-m", "seed"], { cwd: workspace });
    const hookPath = path.join(workspace, ".git", "hooks", "pre-commit");
    await fs.writeFile(hookPath, "#!/bin/sh\nexit 1\n", "utf8");
    await fs.chmod(hookPath, 0o755);

    const result = await applyWithSafetyNet(
      {
        targetFile,
        newContent: "candidate prompt\n",
        source: "meta-harness",
        candidateId: "candidate-real-index-check",
        evaluator: createPhaseEvaluator({ before: 0.4, after: 0.9 })
      },
      {
        runValidateHarness: vi.fn().mockResolvedValue(undefined)
      }
    );

    const { stdout: stagedNames } = await execFile(
      "git",
      ["diff", "--cached", "--name-only"],
      { cwd: workspace }
    );
    expect(result.applied).toBe(false);
    expect(result.blockedReason).toContain("commit_failed");
    expect(stagedNames.trim()).toBe("");
    expect(await fs.readFile(targetFile, "utf8")).toBe(original);
  });

  it("rejects target files outside node-prompts", async () => {
    const workspace = await createWorkspace();
    const outsideFile = path.join(workspace, "outside.md");
    await fs.writeFile(outsideFile, "oops\n", "utf8");

    await expect(
      applyWithSafetyNet({
        targetFile: outsideFile,
        newContent: "new\n",
        source: "meta-harness",
        candidateId: null
      })
    ).rejects.toThrow("node-prompts");
  });
});

function createPhaseEvaluator(scores: { before: number; after: number }) {
  return vi.fn<HarnessEvaluator>(async ({ phase, subjectHash }) => evaluationResult({
    score: scores[phase],
    subjectHash
  }));
}

function evaluationResult(input: {
  score: number;
  evaluatorId?: string;
  diagnosticId?: string;
  passed?: boolean;
  subjectHash: string;
}): HarnessEvaluationResult {
  return {
    status: "available",
    evaluatorId: input.evaluatorId || "quality-evaluator-v1",
    diagnosticId: input.diagnosticId || "weak-node-diagnostic",
    score: input.score,
    passed: input.passed ?? true,
    subjectHash: input.subjectHash,
    artifactPath: "outputs/evaluations/result.json",
    reason: null
  };
}

async function readLastAuditEntry(filePath: string): Promise<Record<string, unknown>> {
  const rows = (await fs.readFile(filePath, "utf8"))
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return JSON.parse(rows.at(-1) || "{}") as Record<string, unknown>;
}

async function createWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-harness-apply-"));
  cleanupPaths.push(workspace);
  await fs.mkdir(path.join(workspace, "node-prompts"), { recursive: true });
  await fs.mkdir(path.join(workspace, ".autolabos"), { recursive: true });
  await fs.writeFile(path.join(workspace, "node-prompts", "analyze_results.md"), "original prompt\n", "utf8");
  return workspace;
}
