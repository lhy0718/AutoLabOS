import { describe, expect, it } from "vitest";

import {
  buildAutonomyAggregateMetrics,
  buildRunAutonomyMetrics,
  categorizeFailureFindings
} from "../src/core/evaluation/autonomyMetrics.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { RunRecord } from "../src/types.js";

describe("autonomy metrics", () => {
  it("records run-level autonomy signals without replacing evidence gates", () => {
    const run = makeRun();
    run.graph.retryCounters.implement_experiments = 2;
    run.graph.rollbackCounters.run_experiments = 1;
    run.graph.checkpointSeq = 7;
    run.graph.transitionHistory.push({
      action: "backtrack_to_design",
      sourceNode: "analyze_results",
      fromNode: "analyze_results",
      toNode: "design_experiments",
      reason: "Objective not met.",
      confidence: 0.8,
      autoExecutable: true,
      appliedAt: "2026-05-03T00:00:00.000Z"
    });

    const metrics = buildRunAutonomyMetrics({
      run,
      overallScore: 0.72555,
      artifactCompletenessRatio: 0.875,
      autoHandoffToRunExperiments: true,
      policyBlocked: false,
      findings: ["Missing artifacts: result_analysis.json"]
    });

    expect(metrics).toMatchObject({
      version: 1,
      run_id: "run-autonomy",
      current_node: "analyze_results",
      fitness_signal: 0.7256,
      fitness_signal_source: "eval_harness_overall_score",
      evidence_gates_preserved: true,
      retry_attempts_total: 2,
      rollback_count_total: 1,
      backward_jump_count: 1,
      checkpoint_seq: 7,
      auto_handoff_to_run_experiments: true,
      policy_blocked: false,
      artifact_completeness_ratio: 0.875,
      dominant_failure_category: "bug"
    });
  });

  it("summarizes autonomy fitness across runs", () => {
    const run = makeRun();
    const first = buildRunAutonomyMetrics({
      run,
      overallScore: 1,
      artifactCompletenessRatio: 1,
      autoHandoffToRunExperiments: true,
      policyBlocked: false
    });
    const second = buildRunAutonomyMetrics({
      run: { ...run, id: "run-policy" },
      overallScore: 0.4,
      artifactCompletenessRatio: 0.5,
      autoHandoffToRunExperiments: false,
      policyBlocked: true,
      findings: ["Policy gate blocked the workflow contract."]
    });

    expect(buildAutonomyAggregateMetrics([first, second])).toMatchObject({
      avg_fitness_signal: 0.7,
      auto_handoff_rate: 0.5,
      policy_blocked_rate: 0.5,
      dominant_failure_categories: [
        { category: "architecture", count: 1 },
        { category: "none", count: 1 }
      ]
    });
  });

  it("orders failure categories by bug, prompt, architecture, hyperparameter priority", () => {
    expect(
      categorizeFailureFindings([
        "JSON parse error in prompt output.",
        "Workflow contract validator blocked the checkpoint.",
        "Learning rate hyperparameter was unstable."
      ])
    ).toEqual(["bug", "prompt", "architecture", "hyperparameter"]);
  });
});

function makeRun(): RunRecord {
  return {
    version: 3,
    workflowVersion: 3,
    id: "run-autonomy",
    title: "Autonomy",
    topic: "topic",
    constraints: [],
    objectiveMetric: "metric",
    status: "running",
    currentNode: "analyze_results",
    nodeThreads: {},
    createdAt: "2026-05-03T00:00:00.000Z",
    updatedAt: "2026-05-03T00:00:00.000Z",
    graph: createDefaultGraphState(),
    memoryRefs: {
      runContextPath: ".autolabos/runs/run-autonomy/memory/run_context.json",
      longTermPath: ".autolabos/runs/run-autonomy/memory/long_term.jsonl",
      episodePath: ".autolabos/runs/run-autonomy/memory/episodes.jsonl"
    }
  };
}
