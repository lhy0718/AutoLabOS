import type { AppConfig } from "../types.js";

export const DEFAULT_COLLECT_PLANNING_TIMEOUT_MS = 180_000;
export const MAX_COLLECT_PLANNING_TIMEOUT_MS = 180_000;

export interface CollectPlanningTimeoutPolicy {
  llm_mode: AppConfig["providers"]["llm_mode"];
  constraint_profile_timeout_ms: number;
  literature_query_timeout_ms: number;
  constraint_profile_source: "bounded_default" | "environment_override";
  literature_query_source: "bounded_default" | "environment_override";
}

interface CollectPlanningTimeoutEnvironment {
  AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS?: string;
  AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS?: string;
}

export function resolveCollectPlanningTimeoutPolicy(
  config: Partial<Pick<AppConfig, "providers">>,
  env: CollectPlanningTimeoutEnvironment = process.env
): CollectPlanningTimeoutPolicy {
  const constraintOverride = parseBoundedTimeoutMs(
    env.AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS
  );
  const literatureOverride = parseBoundedTimeoutMs(
    env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS
  );

  return {
    llm_mode: config.providers?.llm_mode ?? "codex",
    constraint_profile_timeout_ms:
      constraintOverride ?? DEFAULT_COLLECT_PLANNING_TIMEOUT_MS,
    literature_query_timeout_ms:
      literatureOverride ?? DEFAULT_COLLECT_PLANNING_TIMEOUT_MS,
    constraint_profile_source: constraintOverride
      ? "environment_override"
      : "bounded_default",
    literature_query_source: literatureOverride
      ? "environment_override"
      : "bounded_default"
  };
}

function parseBoundedTimeoutMs(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.min(MAX_COLLECT_PLANNING_TIMEOUT_MS, Math.floor(parsed));
}
