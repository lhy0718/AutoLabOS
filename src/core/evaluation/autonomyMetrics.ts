import { GraphNodeId, GRAPH_NODE_ORDER, RunRecord, TransitionHistoryEntry } from "../../types.js";

export type AutonomyFailureCategory = "bug" | "prompt" | "architecture" | "hyperparameter" | "none";

export interface RunAutonomyMetrics {
  version: 1;
  run_id: string;
  current_node: GraphNodeId;
  run_status: RunRecord["status"];
  fitness_signal: number;
  fitness_signal_source: "eval_harness_overall_score";
  evidence_gates_preserved: true;
  retry_attempts_total: number;
  rollback_count_total: number;
  backward_jump_count: number;
  checkpoint_seq: number;
  auto_handoff_to_run_experiments: boolean;
  policy_blocked: boolean;
  artifact_completeness_ratio: number;
  dominant_failure_category: AutonomyFailureCategory;
  failure_category_priority: AutonomyFailureCategory[];
}

export interface AutonomyAggregateMetrics {
  avg_fitness_signal: number;
  auto_handoff_rate: number;
  policy_blocked_rate: number;
  avg_retry_attempts_total: number;
  avg_backward_jump_count: number;
  dominant_failure_categories: Array<{
    category: AutonomyFailureCategory;
    count: number;
  }>;
}

export function buildRunAutonomyMetrics(input: {
  run: RunRecord;
  overallScore: number;
  artifactCompletenessRatio: number;
  autoHandoffToRunExperiments: boolean;
  policyBlocked: boolean;
  findings?: string[];
}): RunAutonomyMetrics {
  const failurePriority = categorizeFailureFindings(input.findings || []);
  return {
    version: 1,
    run_id: input.run.id,
    current_node: input.run.currentNode,
    run_status: input.run.status,
    fitness_signal: round(input.overallScore),
    fitness_signal_source: "eval_harness_overall_score",
    evidence_gates_preserved: true,
    retry_attempts_total: sumRecord(input.run.graph.retryCounters),
    rollback_count_total: sumRecord(input.run.graph.rollbackCounters),
    backward_jump_count: countBackwardJumps(input.run.graph.transitionHistory || []),
    checkpoint_seq: input.run.graph.checkpointSeq || 0,
    auto_handoff_to_run_experiments: input.autoHandoffToRunExperiments,
    policy_blocked: input.policyBlocked,
    artifact_completeness_ratio: round(input.artifactCompletenessRatio),
    dominant_failure_category: failurePriority[0] || "none",
    failure_category_priority: failurePriority.length > 0 ? failurePriority : ["none"]
  };
}

export function buildAutonomyAggregateMetrics(runs: RunAutonomyMetrics[]): AutonomyAggregateMetrics {
  return {
    avg_fitness_signal: round(average(runs.map((run) => run.fitness_signal))),
    auto_handoff_rate: averageRate(runs, (run) => run.auto_handoff_to_run_experiments),
    policy_blocked_rate: averageRate(runs, (run) => run.policy_blocked),
    avg_retry_attempts_total: round(average(runs.map((run) => run.retry_attempts_total))),
    avg_backward_jump_count: round(average(runs.map((run) => run.backward_jump_count))),
    dominant_failure_categories: countCategories(runs)
  };
}

export function categorizeFailureFindings(findings: string[]): AutonomyFailureCategory[] {
  const categories: AutonomyFailureCategory[] = [];
  const text = findings.join("\n").toLowerCase();
  const checks: Array<[AutonomyFailureCategory, RegExp]> = [
    ["bug", /traceback|exception|crash|missing artifact|could not|failed|error/u],
    ["prompt", /prompt|instruction|format|parse|json|schema/u],
    ["architecture", /architecture|contract|policy|gate|validator|workflow|rollback|checkpoint/u],
    ["hyperparameter", /hyperparameter|threshold|learning rate|batch size|temperature|seed/u]
  ];

  for (const [category, pattern] of checks) {
    if (pattern.test(text)) {
      categories.push(category);
    }
  }

  return categories;
}

function sumRecord(record: Partial<Record<GraphNodeId, number>>): number {
  return Object.values(record).reduce((sum, value) => sum + (Number.isFinite(value) ? Number(value) : 0), 0);
}

function countBackwardJumps(history: TransitionHistoryEntry[]): number {
  return history.filter((entry) => {
    if (!entry.toNode) {
      return false;
    }
    const from = GRAPH_NODE_ORDER.indexOf(entry.fromNode);
    const to = GRAPH_NODE_ORDER.indexOf(entry.toNode);
    return from >= 0 && to >= 0 && to < from;
  }).length;
}

function countCategories(runs: RunAutonomyMetrics[]): AutonomyAggregateMetrics["dominant_failure_categories"] {
  const counts = new Map<AutonomyFailureCategory, number>();
  for (const run of runs) {
    counts.set(run.dominant_failure_category, (counts.get(run.dominant_failure_category) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0].localeCompare(right[0]);
    })
    .map(([category, count]) => ({ category, count }));
}

function averageRate<T>(items: T[], predicate: (item: T) => boolean): number {
  if (items.length === 0) {
    return 0;
  }
  return round(items.filter(predicate).length / items.length);
}

function average(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) {
    return 0;
  }
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : 0;
}
