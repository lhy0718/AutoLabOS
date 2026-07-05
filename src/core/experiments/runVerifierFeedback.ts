export type RunVerifierTrigger = "auto_handoff" | "manual";

export type RunVerifierStage = "preflight_test" | "command" | "metrics" | "policy" | "success";

export type RunVerifierFailureCode = "model_dependency_unavailable";

export type RunVerifierRepairTarget =
  | "implementation"
  | "experiment_design"
  | "environment_dependency"
  | "policy";

export type RunVerifierBacktrackNode = "implement_experiments" | "design_experiments";

export interface RunVerifierReport {
  source: "run_experiments";
  status: "pass" | "fail" | "skipped";
  trigger: RunVerifierTrigger;
  stage: RunVerifierStage;
  summary: string;
  policy_rule_id?: string;
  policy_reason?: string;
  command?: string;
  cwd?: string;
  metrics_path?: string;
  exit_code?: number;
  stdout_excerpt?: string;
  stderr_excerpt?: string;
  log_file?: string;
  suggested_next_action?: string;
  failure_code?: RunVerifierFailureCode;
  repair_target?: RunVerifierRepairTarget;
  recommended_backtrack_node?: RunVerifierBacktrackNode;
  upstream_repair_hint?: string;
  operator_action_required?: boolean;
  recorded_at: string;
}
