import { describe, expect, it, vi } from "vitest";

import {
  DefaultTuneNodeRunner,
  TuneNodeEvaluator,
  type TuneNodeVariantScore
} from "../src/core/agents/tuneNode.js";

describe("DefaultTuneNodeRunner", () => {
  it("renders a comparable report from an injected evaluator", async () => {
    const evaluator: TuneNodeEvaluator = vi.fn(async (input) => evaluationResult({
      label: input.variant,
      score: input.variant === "original" ? 0.62 : 0.79,
      subjectHash: input.promptHash,
      notes: input.variant === "original" ? ["baseline prompt"] : ["candidate prompt"]
    }));

    const runner = new DefaultTuneNodeRunner(evaluator);
    const report = await runner.run(createRunnerInput());

    expect(report.evaluationStatus).toBe("comparable");
    expect(report.original.score).toBe(0.62);
    expect(report.mutant.score).toBe(0.79);
    expect(report.delta).toBe(0.17);
    expect(report.recommendation).toBe("keep");
    expect(report.lines.some((line) => line.includes("SCORE_BEFORE: 0.62"))).toBe(true);
    expect(report.lines.some((line) => line.includes("SCORE_AFTER: 0.79"))).toBe(true);
    expect(report.lines.some((line) => line.includes("DELTA: +0.17"))).toBe(true);
    expect(report.lines.some((line) => line.includes("bound to its prompt hash"))).toBe(true);
    expect(report.original.subjectHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.mutant.subjectHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.original.subjectHash).not.toBe(report.mutant.subjectHash);
    expect(evaluator).toHaveBeenCalledTimes(2);
    expect(vi.mocked(evaluator).mock.calls.map(([input]) => input.variant)).toEqual(["original", "mutant"]);
  });

  it("fails closed as report-only when no evaluator is injected", async () => {
    const runner = new DefaultTuneNodeRunner();
    const report = await runner.run(createRunnerInput());

    expect(report.evaluationStatus).toBe("unavailable");
    expect(report.original.score).toBeNull();
    expect(report.mutant.score).toBeNull();
    expect(report.delta).toBeNull();
    expect(report.recommendation).toBe("unavailable");
    expect(report.lines).toEqual(expect.arrayContaining([
      "EVALUATION STATUS: unavailable",
      "SCORE_BEFORE: unavailable",
      "SCORE_AFTER: unavailable",
      "RECOMMENDATION: unavailable",
      "This comparison is report-only. No prompt changes were applied."
    ]));
  });

  it("does not compare scores from different diagnostics", async () => {
    const evaluator: TuneNodeEvaluator = async (input) => evaluationResult({
      label: input.variant,
      score: input.variant === "original" ? 0.5 : 0.9,
      subjectHash: input.promptHash,
      diagnosticId: input.variant === "original" ? "diagnostic-before" : "diagnostic-after"
    });
    const runner = new DefaultTuneNodeRunner(evaluator);

    const report = await runner.run(createRunnerInput());

    expect(report.evaluationStatus).toBe("incomparable");
    expect(report.recommendation).toBe("unavailable");
    expect(report.lines.some((line) => line.includes("diagnostic mismatch"))).toBe(true);
  });

  it("reverts a higher score that does not pass the evaluator criterion", async () => {
    const evaluator: TuneNodeEvaluator = async (input) => evaluationResult({
      label: input.variant,
      score: input.variant === "original" ? 0.58 : 0.76,
      subjectHash: input.promptHash,
      passed: input.variant === "original"
    });
    const runner = new DefaultTuneNodeRunner(evaluator);

    const report = await runner.run(createRunnerInput());

    expect(report.evaluationStatus).toBe("comparable");
    expect(report.delta).toBe(0.18);
    expect(report.recommendation).toBe("revert");
    expect(report.lines.some((line) => line.includes("candidate did not pass"))).toBe(true);
  });

  it("rejects a score that is not bound to the evaluated prompt", async () => {
    const evaluator: TuneNodeEvaluator = async (input) => evaluationResult({
      label: input.variant,
      score: input.variant === "original" ? 0.42 : 0.88,
      subjectHash: input.variant === "original" ? input.promptHash : "0".repeat(64)
    });
    const runner = new DefaultTuneNodeRunner(evaluator);

    const report = await runner.run(createRunnerInput());

    expect(report.evaluationStatus).toBe("unavailable");
    expect(report.mutant.status).toBe("error");
    expect(report.mutant.score).toBeNull();
    expect(report.recommendation).toBe("unavailable");
    expect(report.lines.some((line) => line.includes("score subject hash mismatch"))).toBe(true);
  });

  it("rejects unsupported nodes clearly", async () => {
    const runner = new DefaultTuneNodeRunner(async (input) => evaluationResult({
      label: input.variant,
      score: 0.5,
      subjectHash: input.promptHash
    }));

    await expect(
      runner.run({
        ...createRunnerInput(),
        node: "collect_papers" as never
      })
    ).rejects.toThrow("Unsupported node for tune-node");
  });
});

function evaluationResult(input: {
  label: "original" | "mutant";
  score: number;
  evaluatorId?: string;
  diagnosticId?: string;
  passed?: boolean;
  notes?: string[];
  subjectHash: string;
}): TuneNodeVariantScore {
  return {
    label: input.label,
    status: "available",
    evaluatorId: input.evaluatorId || "node-quality-evaluator-v1",
    diagnosticId: input.diagnosticId || "prompt-quality-diagnostic",
    score: input.score,
    passed: input.passed ?? true,
    subjectHash: input.subjectHash,
    artifactPath: "outputs/evaluations/tune-node.json",
    notes: input.notes || []
  };
}

function createRunnerInput() {
  return {
    workspaceRoot: "/workspace",
    run: {
      id: "run-validation",
      title: "Tune run",
      topic: "topic",
      objectiveMetric: "metric",
      constraints: []
    },
    node: "generate_hypotheses" as const
  };
}
