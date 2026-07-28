export interface PythonRunnerBudgetGuardInput {
  source: string;
  timeoutSec: number | undefined;
  scriptName: string;
}

export function detectLongRunningPythonBudgetGuardFailure(
  input: PythonRunnerBudgetGuardInput
): string | undefined {
  if (!input.timeoutSec) {
    return undefined;
  }

  const requiredRunCount = inferRequiredRunCountFromPythonSource(input.source);
  const longRunShape = requiredRunCount !== undefined && requiredRunCount >= 8;
  const declaresBudget =
    /--(?:budget-|condition-|locked-budget-)?timeout-sec\b|\btimeout_sec\b/u.test(input.source);
  if (
    !longRunShape ||
    !declaresBudget ||
    hasPythonBudgetEnforcementSurface(input.source)
  ) {
    return undefined;
  }

  return [
    "Long-running Python experiment runner " + input.scriptName +
      " declares required_run_count=" + requiredRunCount +
      " and timeout_sec=" + input.timeoutSec +
      " but no executable planned-work loop consumes a deadline.",
    "A declared timeout is not a budget control unless the runner checks it before work units and planned runs and persists partial or timed-out accounting without promoting incomplete work."
  ].join(" ");
}

export function hasPythonBudgetEnforcementSurface(source: string): boolean {
  return /\.(?:expired|check_deadline|deadline_exceeded|budget_exhausted|has_time_for|can_start_run|can_start_new_run|assert_time_available|ensure_time_available)\s*\(/u.test(source)
    || /\b(?:check_deadline|ensure_budget|raise_if_(?:expired|timed_out)|deadline_exceeded|budget_exhausted)\s*\(/u.test(source)
    || /\b(?:time\.)?monotonic\s*\(\s*\)\s*(?:>=|>)\s*\w*deadline\b/u.test(source)
    || /\b\w*deadline\b\s*(?:<=|<)\s*(?:time\.)?monotonic\s*\(\s*\)/u.test(source)
    || /\bsignal\.alarm\s*\(/u.test(source);
}

export function inferRequiredRunCountFromPythonSource(source: string): number | undefined {
  const direct = source.match(
    /\b(?:REQUIRED_RUN_COUNT|PLANNED_RUN_COUNT|required_run_count)\b\s*[:=]\s*(\d+)/u
  );
  if (direct) {
    return Number.parseInt(direct[1], 10);
  }
  const conditionCount = source.match(
    /\b(?:REQUIRED_CONDITION_COUNT|PLANNED_CONDITION_COUNT|required_condition_count)\b\s*[:=]\s*(\d+)/u
  );
  const seedTuple = source.match(/\b(?:PLANNED_SEEDS|SEED_SCHEDULE|seeds)\b\s*[:=]\s*\(([^)]*)\)/u);
  if (!conditionCount || !seedTuple) {
    return undefined;
  }
  const seedCount = seedTuple[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean).length;
  return Number.parseInt(conditionCount[1], 10) * Math.max(1, seedCount);
}
