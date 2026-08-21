import type { ResearchRunMode } from "./runs/runBriefParser.js";
import {
  hashCanonical,
  type ResearchFunnelValidationContext,
  type TopicPortfolio,
  type TopicPortfolioCandidate
} from "./researchFunnel.js";
import {
  areEffectScalesComparable,
  buildCandidateObjectiveRaw,
  effectCriterionValuesEqual,
  isEffectCriterion,
  isExplicitMetricScale,
  requireEffectCriterion,
  requireExplicitMetricScale,
  requireExplicitMetricUnit,
  type CandidateMetricScale,
  type EffectCriterion
} from "./effectCriterion.js";
import {
  isTopicProbeComputeBudgetLimits,
  parseTopicProbeComputeBudgetDeclaration,
  topicProbeComputeBudgetFitsWithin,
  topicProbeComputeBudgetLimitsEqual,
  type TopicProbeComputeBudgetLimits
} from "./topicProbeComputeBudget.js";

export interface ActiveTopicProbeContract {
  schema_version: 1;
  artifact_kind: "active_topic_probe_contract";
  generated_at: string;
  run_id: string;
  research_cycle: number;
  research_mode: "topic_discovery";
  evidence_stage: "bounded_probe";
  selection_status: "probe_only";
  portfolio_content_sha256: string;
  candidate_id: string;
  topic_id: string;
  candidate_content_sha256: string;
  statement: string;
  primary_metric: string;
  metric_unit: string;
  metric_scale: CandidateMetricScale;
  metric_direction: "maximize" | "minimize";
  effect_criterion: EffectCriterion;
  objective_raw: string;
  meaningful_effect?: string;
  comparator: string;
  dataset_task_bench: string;
  falsifier: string;
  kill_signal: string;
  local_budget: string;
  brief_compute_budget_ceiling: TopicProbeComputeBudgetLimits;
  compute_budget: TopicProbeComputeBudgetLimits;
  deferred_candidate_ids: string[];
  content_sha256: string;
}

export interface ActiveTopicProbeContractValidation {
  measured: boolean;
  valid: boolean;
  reasons: string[];
  contract?: ActiveTopicProbeContract;
}

const ACTIVE_TOPIC_PROBE_CONTRACT_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "generated_at",
  "run_id",
  "research_cycle",
  "research_mode",
  "evidence_stage",
  "selection_status",
  "portfolio_content_sha256",
  "candidate_id",
  "topic_id",
  "candidate_content_sha256",
  "statement",
  "primary_metric",
  "metric_unit",
  "metric_scale",
  "metric_direction",
  "effect_criterion",
  "objective_raw",
  "meaningful_effect",
  "comparator",
  "dataset_task_bench",
  "falsifier",
  "kill_signal",
  "local_budget",
  "brief_compute_budget_ceiling",
  "compute_budget",
  "deferred_candidate_ids",
  "content_sha256"
]);

export function buildActiveTopicProbeContract(input: {
  runId: string;
  researchCycle: number;
  researchMode: Extract<ResearchRunMode, "topic_discovery">;
  portfolioContentSha256: string;
  candidate: TopicPortfolioCandidate;
  deferredCandidateIds?: string[];
  generatedAt?: string;
}): ActiveTopicProbeContract {
  const candidate = input.candidate;
  const primaryMetric = requireText(candidate.primary_metric, "primary_metric");
  const metricUnit = requireExplicitMetricUnit(
    candidate.metric_unit,
    "active_topic_probe_contract_metric_unit_missing"
  );
  const metricScale = requireExplicitMetricScale(
    candidate.metric_scale,
    "active_topic_probe_contract_metric_scale_invalid"
  );
  const metricDirection = requireDirection(candidate.metric_direction);
  const comparator = requireText(candidate.comparator, "comparator");
  const effectCriterion = requireEffectCriterion(
    candidate.effect_criterion,
    "active_topic_probe_contract_effect_criterion_invalid"
  );
  const expectedObjectiveRaw = buildCandidateObjectiveRaw({
    primary_metric: primaryMetric,
    metric_unit: metricUnit,
    metric_scale: metricScale,
    metric_direction: metricDirection,
    comparator,
    effect_criterion: effectCriterion
  });
  const objectiveRaw = requireText(candidate.objective_raw, "objective_raw");
  if (objectiveRaw !== expectedObjectiveRaw) {
    throw new Error("active_topic_probe_contract_objective_raw_mismatch");
  }
  const meaningfulEffect = optionalText(candidate.meaningful_effect);
  const localBudget = requireText(candidate.local_budget, "local_budget");
  const computeBudget = parseTopicProbeComputeBudgetDeclaration(localBudget);
  const briefComputeBudgetCeiling = candidate.brief_compute_budget_ceiling;
  if (!isTopicProbeComputeBudgetLimits(briefComputeBudgetCeiling)) {
    throw new Error(
      "active_topic_probe_contract_brief_compute_budget_ceiling_missing"
    );
  }
  if (!topicProbeComputeBudgetFitsWithin(computeBudget, briefComputeBudgetCeiling)) {
    throw new Error(
      "active_topic_probe_contract_compute_budget_exceeds_brief_ceiling"
    );
  }
  const payload = {
    schema_version: 1 as const,
    artifact_kind: "active_topic_probe_contract" as const,
    generated_at: input.generatedAt || new Date().toISOString(),
    run_id: requireText(input.runId, "run_id"),
    research_cycle: requireResearchCycle(input.researchCycle),
    research_mode: input.researchMode,
    evidence_stage: "bounded_probe" as const,
    selection_status: "probe_only" as const,
    portfolio_content_sha256: requireSha256(input.portfolioContentSha256, "portfolio_content_sha256"),
    candidate_id: requireText(candidate.source_candidate_id, "candidate_id"),
    topic_id: requireText(candidate.topic_id, "topic_id"),
    candidate_content_sha256: requireSha256(candidate.content_sha256, "candidate_content_sha256"),
    statement: requireText(candidate.statement, "statement"),
    primary_metric: primaryMetric,
    metric_unit: metricUnit,
    metric_scale: metricScale,
    metric_direction: metricDirection,
    effect_criterion: effectCriterion,
    objective_raw: objectiveRaw,
    ...(meaningfulEffect ? { meaningful_effect: meaningfulEffect } : {}),
    comparator,
    dataset_task_bench: requireText(candidate.dataset_task_bench, "dataset_task_bench"),
    falsifier: requireText(candidate.falsifier, "falsifier"),
    kill_signal: requireText(candidate.kill_signal, "kill_signal"),
    local_budget: localBudget,
    brief_compute_budget_ceiling: briefComputeBudgetCeiling,
    compute_budget: computeBudget,
    deferred_candidate_ids: uniqueStrings(input.deferredCandidateIds || [])
  };
  if (payload.deferred_candidate_ids.includes(payload.candidate_id)) {
    throw new Error("active_topic_probe_contract_active_candidate_deferred");
  }
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function validateActiveTopicProbeContract(
  raw: string,
  context: ResearchFunnelValidationContext & { portfolio?: TopicPortfolio } = {}
): ActiveTopicProbeContractValidation {
  if (!raw.trim()) {
    return { measured: false, valid: false, reasons: ["active_topic_probe_contract_missing"] };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { measured: true, valid: false, reasons: ["active_topic_probe_contract_invalid_json"] };
  }
  if (!isActiveTopicProbeContract(value)) {
    return { measured: true, valid: false, reasons: ["active_topic_probe_contract_schema_invalid"] };
  }

  const reasons: string[] = [];
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("active_topic_probe_contract_content_hash_mismatch");
  }
  const expectedObjectiveRaw = buildCandidateObjectiveRaw({
    primary_metric: value.primary_metric,
    metric_unit: value.metric_unit,
    metric_scale: value.metric_scale,
    metric_direction: value.metric_direction,
    comparator: value.comparator,
    effect_criterion: value.effect_criterion
  });
  if (value.objective_raw !== expectedObjectiveRaw) {
    reasons.push("active_topic_probe_contract_objective_raw_mismatch");
  }
  try {
    if (
      !topicProbeComputeBudgetLimitsEqual(
        parseTopicProbeComputeBudgetDeclaration(value.local_budget),
        value.compute_budget
      )
    ) {
      reasons.push(
        "active_topic_probe_contract_compute_budget_declaration_mismatch"
      );
    }
  } catch {
    reasons.push(
      "active_topic_probe_contract_compute_budget_declaration_invalid"
    );
  }
  if (
    !topicProbeComputeBudgetFitsWithin(
      value.compute_budget,
      value.brief_compute_budget_ceiling
    )
  ) {
    reasons.push(
      "active_topic_probe_contract_compute_budget_exceeds_brief_ceiling"
    );
  }
  if (context.expectedRunId !== undefined && value.run_id !== context.expectedRunId) {
    reasons.push("active_topic_probe_contract_run_id_mismatch");
  }
  if (
    context.expectedResearchCycle !== undefined
    && value.research_cycle !== context.expectedResearchCycle
  ) {
    reasons.push("active_topic_probe_contract_research_cycle_mismatch");
  }
  if (new Set(value.deferred_candidate_ids).size !== value.deferred_candidate_ids.length) {
    reasons.push("active_topic_probe_contract_duplicate_deferred_candidate_id");
  }
  if (value.deferred_candidate_ids.includes(value.candidate_id)) {
    reasons.push("active_topic_probe_contract_active_candidate_deferred");
  }

  const portfolio = context.portfolio;
  if (portfolio) {
    if (value.portfolio_content_sha256 !== portfolio.content_sha256) {
      reasons.push("active_topic_probe_contract_portfolio_hash_mismatch");
    }
    const candidate = portfolio.candidates.find(
      (item) => item.source_candidate_id === value.candidate_id
    );
    if (!candidate) {
      reasons.push("active_topic_probe_contract_candidate_unknown");
    } else {
      const expectedFields: Array<[keyof ActiveTopicProbeContract, unknown]> = [
        ["topic_id", candidate.topic_id],
        ["candidate_content_sha256", candidate.content_sha256],
        ["statement", candidate.statement],
        ["primary_metric", candidate.primary_metric],
        ["metric_unit", candidate.metric_unit],
        ["metric_scale", candidate.metric_scale],
        ["metric_direction", candidate.metric_direction],
        ["objective_raw", candidate.objective_raw],
        ["meaningful_effect", candidate.meaningful_effect],
        ["comparator", candidate.comparator],
        ["dataset_task_bench", candidate.dataset_task_bench],
        ["falsifier", candidate.falsifier],
        ["kill_signal", candidate.kill_signal],
        ["local_budget", candidate.local_budget]
      ];
      for (const [field, expected] of expectedFields) {
        if (value[field] !== expected) {
          reasons.push(`active_topic_probe_contract_candidate_field_mismatch:${String(field)}`);
        }
      }
      if (!effectCriterionValuesEqual(value.effect_criterion, candidate.effect_criterion)) {
        reasons.push(
          "active_topic_probe_contract_candidate_field_mismatch:effect_criterion"
        );
      }
      if (
        !isTopicProbeComputeBudgetLimits(candidate.brief_compute_budget_ceiling)
        || !topicProbeComputeBudgetLimitsEqual(
          value.brief_compute_budget_ceiling,
          candidate.brief_compute_budget_ceiling
        )
      ) {
        reasons.push(
          "active_topic_probe_contract_candidate_field_mismatch:brief_compute_budget_ceiling"
        );
      }
      try {
        const candidateBudget = parseTopicProbeComputeBudgetDeclaration(
          candidate.local_budget || ""
        );
        if (
          !topicProbeComputeBudgetLimitsEqual(
            value.compute_budget,
            candidateBudget
          )
        ) {
          reasons.push(
            "active_topic_probe_contract_candidate_field_mismatch:compute_budget"
          );
        }
      } catch {
        reasons.push("active_topic_probe_contract_candidate_compute_budget_invalid");
      }
    }
    const authorized = new Set(portfolio.probe_candidate_ids);
    if (!authorized.has(value.candidate_id)) {
      reasons.push("active_topic_probe_contract_candidate_not_authorized");
    }
    for (const candidateId of value.deferred_candidate_ids) {
      if (!authorized.has(candidateId)) {
        reasons.push(`active_topic_probe_contract_deferred_candidate_not_authorized:${candidateId}`);
      }
    }
  }

  return {
    measured: true,
    valid: reasons.length === 0,
    reasons: uniqueStrings(reasons),
    contract: value
  };
}

function isActiveTopicProbeContract(value: unknown): value is ActiveTopicProbeContract {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schema_version === 1
    && value.artifact_kind === "active_topic_probe_contract"
    && hasText(value.generated_at)
    && hasText(value.run_id)
    && Number.isInteger(value.research_cycle)
    && Number(value.research_cycle) >= 0
    && value.research_mode === "topic_discovery"
    && value.evidence_stage === "bounded_probe"
    && value.selection_status === "probe_only"
    && isSha256(value.portfolio_content_sha256)
    && hasText(value.candidate_id)
    && hasText(value.topic_id)
    && isSha256(value.candidate_content_sha256)
    && hasText(value.statement)
    && hasText(value.primary_metric)
    && hasText(value.metric_unit)
    && isExplicitMetricScale(value.metric_scale)
    && (value.metric_direction === "maximize" || value.metric_direction === "minimize")
    && isEffectCriterion(value.effect_criterion)
    && areEffectScalesComparable(value.metric_scale, value.effect_criterion.scale)
    && hasText(value.objective_raw)
    && (value.meaningful_effect === undefined || hasText(value.meaningful_effect))
    && hasText(value.comparator)
    && hasText(value.dataset_task_bench)
    && hasText(value.falsifier)
    && hasText(value.kill_signal)
    && hasText(value.local_budget)
    && isTopicProbeComputeBudgetLimits(value.brief_compute_budget_ceiling)
    && isTopicProbeComputeBudgetLimits(value.compute_budget)
    && isStringArray(value.deferred_candidate_ids)
    && hasOnlyKnownFields(value, ACTIVE_TOPIC_PROBE_CONTRACT_FIELDS)
    && isSha256(value.content_sha256)
  );
}

function optionalText(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireText(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`active_topic_probe_contract_${field}_missing`);
  }
  return normalized;
}

function requireDirection(value: unknown): "maximize" | "minimize" {
  if (value === "maximize" || value === "minimize") {
    return value;
  }
  throw new Error("active_topic_probe_contract_metric_direction_missing");
}

function requireResearchCycle(value: number): number {
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new Error("active_topic_probe_contract_research_cycle_invalid");
}

function requireSha256(value: unknown, field: string): string {
  if (isSha256(value)) {
    return value;
  }
  throw new Error(`active_topic_probe_contract_${field}_invalid`);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function hasOnlyKnownFields(value: object, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
