import {
  validateActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "./activeTopicProbeContract.js";
import {
  hashCanonical,
  validateTopicPortfolioArtifact,
  type TopicPortfolio,
  type TopicPortfolioCandidate
} from "./researchFunnel.js";
import {
  validateTopicProbeOutcomeDecision,
  type TopicProbeOutcomeDecision
} from "./topicProbeOutcome.js";
import {
  TOPIC_MEMORY_AXES,
  type TopicFormulationDescriptor,
  type TopicMemoryAxis
} from "./topicMemory.js";

export type TopicProbeSuccessorTargetPolicy =
  | "preserve_active_candidate"
  | "select_deferred_candidate"
  | "refresh_portfolio_excluding_rejected";

export const TOPIC_PROBE_REFRESH_COUNTED_AXES = [
  "contribution_object",
  "method_mechanism",
  "data_task_scope",
  "evaluation_protocol"
] as const satisfies readonly TopicMemoryAxis[];
export const TOPIC_PROBE_REFRESH_REQUIRED_CHANGED_AXES = [
  "contribution_object"
] as const satisfies readonly TopicMemoryAxis[];
export const TOPIC_PROBE_REFRESH_MINIMUM_CHANGED_AXES = 3;

export interface TopicProbeRefreshDivergencePolicy {
  counted_axes: TopicMemoryAxis[];
  required_changed_axes: TopicMemoryAxis[];
  minimum_changed_axes: number;
}

export interface TopicProbeSuccessorRouteTarget {
  schema_version: 3;
  artifact_kind: "topic_probe_successor_route_target";
  policy: TopicProbeSuccessorTargetPolicy;
  source_portfolio_content_sha256: string;
  source_active_contract_content_sha256: string;
  source_outcome_content_sha256: string;
  source_active_candidate_id: string;
  source_active_candidate_content_sha256: string;
  source_active_descriptor: TopicFormulationDescriptor | null;
  refresh_divergence_policy: TopicProbeRefreshDivergencePolicy | null;
  target_candidate: TopicPortfolioCandidate | null;
  forbidden_candidate_ids: string[];
  forbidden_topic_ids: string[];
  remaining_deferred_candidate_ids: string[];
  content_sha256: string;
}

export interface TopicProbeSuccessorRouteTargetInput {
  portfolio: TopicPortfolio;
  contract: ActiveTopicProbeContract;
  outcome: TopicProbeOutcomeDecision;
  activeCandidate: TopicPortfolioCandidate;
}

export interface TopicProbeSuccessorRouteTargetValidation {
  valid: boolean;
  reasons: string[];
  target?: TopicProbeSuccessorRouteTarget;
  expectedTarget?: TopicProbeSuccessorRouteTarget;
}

export interface TopicProbeSuccessorTargetSelection {
  policy: TopicProbeSuccessorTargetPolicy;
  targetCandidate: TopicPortfolioCandidate | null;
  forbiddenCandidateIds: string[];
  forbiddenTopicIds: string[];
  remainingDeferredCandidateIds: string[];
}

const TARGET_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "policy",
  "source_portfolio_content_sha256",
  "source_active_contract_content_sha256",
  "source_outcome_content_sha256",
  "source_active_candidate_id",
  "source_active_candidate_content_sha256",
  "source_active_descriptor",
  "refresh_divergence_policy",
  "target_candidate",
  "forbidden_candidate_ids",
  "forbidden_topic_ids",
  "remaining_deferred_candidate_ids",
  "content_sha256"
]);

export function buildTopicProbeSuccessorRouteTarget(
  input: TopicProbeSuccessorRouteTargetInput
): TopicProbeSuccessorRouteTarget {
  const sourceReasons = collectSourceReasons(input);
  if (sourceReasons.length > 0) {
    throw new Error(
      `topic_probe_successor_route_target_source_invalid:${sourceReasons.join(",")}`
    );
  }

  const selection = resolveTopicProbeSuccessorTargetSelection(input);
  const refreshDivergence = selection.policy === "refresh_portfolio_excluding_rejected"
    ? requireRefreshDivergence(input.activeCandidate)
    : {
        sourceActiveDescriptor: null,
        policy: null
      };
  const payload: Omit<TopicProbeSuccessorRouteTarget, "content_sha256"> = {
    schema_version: 3,
    artifact_kind: "topic_probe_successor_route_target",
    policy: selection.policy,
    source_portfolio_content_sha256: input.portfolio.content_sha256,
    source_active_contract_content_sha256: input.contract.content_sha256,
    source_outcome_content_sha256: input.outcome.content_sha256,
    source_active_candidate_id: input.activeCandidate.source_candidate_id,
    source_active_candidate_content_sha256: input.activeCandidate.content_sha256,
    source_active_descriptor: refreshDivergence.sourceActiveDescriptor,
    refresh_divergence_policy: refreshDivergence.policy,
    target_candidate: selection.targetCandidate,
    forbidden_candidate_ids: selection.forbiddenCandidateIds,
    forbidden_topic_ids: selection.forbiddenTopicIds,
    remaining_deferred_candidate_ids: selection.remainingDeferredCandidateIds
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function validateTopicProbeSuccessorRouteTarget(
  value: unknown,
  context: TopicProbeSuccessorRouteTargetInput
): TopicProbeSuccessorRouteTargetValidation {
  const reasons: string[] = [];
  if (!isTopicProbeSuccessorRouteTarget(value)) {
    return {
      valid: false,
      reasons: ["topic_probe_successor_route_target_schema_invalid"]
    };
  }
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("topic_probe_successor_route_target_content_hash_mismatch");
  }

  let expectedTarget: TopicProbeSuccessorRouteTarget | undefined;
  try {
    expectedTarget = buildTopicProbeSuccessorRouteTarget(context);
    if (!valuesEqual(value, expectedTarget)) {
      reasons.push("topic_probe_successor_route_target_recomputed_mismatch");
    }
  } catch (error) {
    reasons.push(normalizeSourceError(error));
  }

  return {
    valid: reasons.length === 0,
    reasons: uniqueStrings(reasons),
    target: value,
    ...(expectedTarget ? { expectedTarget } : {})
  };
}

function collectSourceReasons(
  input: TopicProbeSuccessorRouteTargetInput
): string[] {
  const reasons: string[] = [];
  const portfolioValidation = validateTopicPortfolioArtifact(
    JSON.stringify(input.portfolio),
    {
      expectedRunId: input.contract.run_id,
      expectedResearchCycle: input.contract.research_cycle
    }
  );
  reasons.push(...portfolioValidation.reasons.map(
    (reason) => `topic_probe_successor_route_target_portfolio_invalid:${reason}`
  ));

  const contractValidation = validateActiveTopicProbeContract(
    JSON.stringify(input.contract),
    {
      expectedRunId: input.contract.run_id,
      expectedResearchCycle: input.contract.research_cycle,
      portfolio: input.portfolio
    }
  );
  reasons.push(...contractValidation.reasons.map(
    (reason) => `topic_probe_successor_route_target_contract_invalid:${reason}`
  ));

  const outcomeValidation = validateTopicProbeOutcomeDecision(
    JSON.stringify(input.outcome),
    {
      expectedRunId: input.contract.run_id,
      expectedResearchCycle: input.contract.research_cycle,
      contract: input.contract,
      structuralOnly: true
    }
  );
  reasons.push(...outcomeValidation.reasons.map(
    (reason) => `topic_probe_successor_route_target_outcome_invalid:${reason}`
  ));

  const matches = input.portfolio.candidates.filter(
    (candidate) =>
      candidate.source_candidate_id === input.contract.candidate_id
      && candidate.topic_id === input.contract.topic_id
  );
  if (matches.length !== 1) {
    reasons.push(
      matches.length === 0
        ? "topic_probe_successor_route_target_active_candidate_missing"
        : "topic_probe_successor_route_target_active_candidate_ambiguous"
    );
  } else if (!valuesEqual(matches[0], input.activeCandidate)) {
    reasons.push("topic_probe_successor_route_target_active_candidate_mismatch");
  }
  if (
    input.activeCandidate.content_sha256
      !== input.contract.candidate_content_sha256
  ) {
    reasons.push("topic_probe_successor_route_target_active_candidate_hash_mismatch");
  }
  return uniqueStrings(reasons);
}

export function resolveTopicProbeSuccessorTargetSelection(
  input: TopicProbeSuccessorRouteTargetInput
): TopicProbeSuccessorTargetSelection {
  switch (input.outcome.next_action) {
    case "start_confirmatory_run":
    case "repeat_bounded_probe":
    case "repair_probe_evidence":
      return {
        policy: "preserve_active_candidate",
        targetCandidate: input.activeCandidate,
        forbiddenCandidateIds: [],
        forbiddenTopicIds: [],
        remainingDeferredCandidateIds: [...input.contract.deferred_candidate_ids]
      };
    case "try_deferred_candidate": {
      const [selectedId, ...remainingDeferredCandidateIds] =
        input.contract.deferred_candidate_ids;
      if (!selectedId) {
        throw new Error("topic_probe_successor_route_target_deferred_candidate_missing");
      }
      const matches = input.portfolio.candidates.filter(
        (candidate) => candidate.source_candidate_id === selectedId
      );
      if (matches.length !== 1) {
        throw new Error(
          matches.length === 0
            ? "topic_probe_successor_route_target_deferred_candidate_unknown"
            : "topic_probe_successor_route_target_deferred_candidate_ambiguous"
        );
      }
      const selected = matches[0];
      if (
        !selected.probe_eligible
        || !input.portfolio.probe_candidate_ids.includes(selectedId)
      ) {
        throw new Error(
          "topic_probe_successor_route_target_deferred_candidate_not_authorized"
        );
      }
      return {
        policy: "select_deferred_candidate",
        targetCandidate: selected,
        forbiddenCandidateIds: [input.activeCandidate.source_candidate_id],
        forbiddenTopicIds: [input.activeCandidate.topic_id],
        remainingDeferredCandidateIds
      };
    }
    case "refresh_topic_portfolio":
      return {
        policy: "refresh_portfolio_excluding_rejected",
        targetCandidate: null,
        forbiddenCandidateIds: [input.activeCandidate.source_candidate_id],
        forbiddenTopicIds: [input.activeCandidate.topic_id],
        remainingDeferredCandidateIds: []
      };
  }
}

function isTopicProbeSuccessorRouteTarget(
  value: unknown
): value is TopicProbeSuccessorRouteTarget {
  if (
    !isRecord(value)
    || !Object.keys(value).every((field) => TARGET_FIELDS.has(field))
  ) {
    return false;
  }
  const policy = value.policy;
  const targetCandidate = value.target_candidate;
  const isRefresh = policy === "refresh_portfolio_excluding_rejected";
  const sourceActiveDescriptor = value.source_active_descriptor;
  const refreshDivergencePolicy = value.refresh_divergence_policy;
  const refreshFieldsValid = isRefresh
    ? isTopicFormulationDescriptorShape(sourceActiveDescriptor)
      && isTopicProbeRefreshDivergencePolicy(refreshDivergencePolicy)
    : sourceActiveDescriptor === null && refreshDivergencePolicy === null;
  return value.schema_version === 3
    && value.artifact_kind === "topic_probe_successor_route_target"
    && (
      policy === "preserve_active_candidate"
      || policy === "select_deferred_candidate"
      || policy === "refresh_portfolio_excluding_rejected"
    )
    && isSha256(value.source_portfolio_content_sha256)
    && isSha256(value.source_active_contract_content_sha256)
    && isSha256(value.source_outcome_content_sha256)
    && hasText(value.source_active_candidate_id)
    && isSha256(value.source_active_candidate_content_sha256)
    && refreshFieldsValid
    && (targetCandidate === null || isRecord(targetCandidate))
    && isStringArray(value.forbidden_candidate_ids)
    && isStringArray(value.forbidden_topic_ids)
    && isStringArray(value.remaining_deferred_candidate_ids)
    && new Set(value.forbidden_candidate_ids).size
      === value.forbidden_candidate_ids.length
    && new Set(value.forbidden_topic_ids).size
      === value.forbidden_topic_ids.length
    && new Set(value.remaining_deferred_candidate_ids).size
      === value.remaining_deferred_candidate_ids.length
    && isSha256(value.content_sha256);
}

function requireRefreshDivergence(candidate: TopicPortfolioCandidate): {
  sourceActiveDescriptor: TopicFormulationDescriptor;
  policy: TopicProbeRefreshDivergencePolicy;
} {
  const sourceActiveDescriptor = candidate.topic_memory?.descriptor;
  if (!sourceActiveDescriptor) {
    throw new Error(
      "topic_probe_successor_route_target_refresh_source_descriptor_missing"
    );
  }
  return {
    sourceActiveDescriptor,
    policy: {
      counted_axes: [...TOPIC_PROBE_REFRESH_COUNTED_AXES],
      required_changed_axes: [...TOPIC_PROBE_REFRESH_REQUIRED_CHANGED_AXES],
      minimum_changed_axes: TOPIC_PROBE_REFRESH_MINIMUM_CHANGED_AXES
    }
  };
}

function isTopicProbeRefreshDivergencePolicy(
  value: unknown
): value is TopicProbeRefreshDivergencePolicy {
  if (!isRecord(value)) {
    return false;
  }
  return arraysEqual(
    value.counted_axes,
    TOPIC_PROBE_REFRESH_COUNTED_AXES
  )
    && arraysEqual(
      value.required_changed_axes,
      TOPIC_PROBE_REFRESH_REQUIRED_CHANGED_AXES
    )
    && value.minimum_changed_axes === TOPIC_PROBE_REFRESH_MINIMUM_CHANGED_AXES;
}

function isTopicFormulationDescriptorShape(
  value: unknown
): value is TopicFormulationDescriptor {
  return isRecord(value)
    && TOPIC_MEMORY_AXES.every((axis) => hasText(value[axis]))
    && isSha256(value.lineage_sha256)
    && isSha256(value.formulation_sha256)
    && isSha256(value.content_sha256);
}

function arraysEqual(
  value: unknown,
  expected: readonly string[]
): boolean {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string")
    && JSON.stringify(value) === JSON.stringify(expected);
}

function normalizeSourceError(error: unknown): string {
  if (!(error instanceof Error) || !error.message.trim()) {
    return "topic_probe_successor_route_target_source_invalid";
  }
  return error.message
    .replace(/[^a-z0-9_:.\/-]+/giu, "_")
    .slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(hasText);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}
