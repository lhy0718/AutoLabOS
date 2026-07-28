import type { TopicPortfolioCandidate } from "./researchFunnel.js";
import type {
  TopicProbeSuccessorRouteTarget
} from "./topicProbeSuccessorRouteTarget.js";
import { changedTopicMemoryAxes } from "./topicMemory.js";

type RequiredCandidateContractFields =
  | "comparator"
  | "dataset_task_bench"
  | "primary_metric"
  | "metric_unit"
  | "metric_scale"
  | "metric_direction"
  | "effect_criterion"
  | "objective_raw"
  | "falsifier"
  | "local_budget"
  | "brief_compute_budget_ceiling"
  | "kill_signal"
  | "contribution_claim"
  | "minimum_publishable_evidence";

export type TopicProbeSuccessorDesignCandidate =
  TopicPortfolioCandidate
  & Required<Pick<TopicPortfolioCandidate, RequiredCandidateContractFields>>;

export interface TopicProbeSuccessorDesignTargetValidation {
  valid: boolean;
  reasons: string[];
}

export interface TopicProbeSuccessorPortfolioTargetValidation {
  valid: boolean;
  reasons: string[];
}

export function validateTopicProbeSuccessorPortfolioTarget(input: {
  routeTarget: TopicProbeSuccessorRouteTarget;
  candidates: TopicPortfolioCandidate[];
}): TopicProbeSuccessorPortfolioTargetValidation {
  const { routeTarget, candidates } = input;
  const reasons: string[] = [];
  if (candidates.length === 0) {
    return {
      valid: false,
      reasons: ["successor_design_portfolio_candidates_missing"]
    };
  }

  if (routeTarget.policy === "refresh_portfolio_excluding_rejected") {
    for (const candidate of candidates) {
      const validation = validateTopicProbeSuccessorDesignTarget({
        routeTarget,
        candidate
      });
      reasons.push(...validation.reasons.map(
        (reason) => `${reason}:${candidate.source_candidate_id}`
      ));
    }
  } else {
    const target = routeTarget.target_candidate;
    if (!target) {
      reasons.push("successor_design_portfolio_target_candidate_missing");
    } else {
      const matches = candidates.filter(
        (candidate) =>
          candidate.source_candidate_id === target.source_candidate_id
          && candidate.topic_id === target.topic_id
      );
      if (matches.length !== 1) {
        reasons.push(
          matches.length === 0
            ? "successor_design_portfolio_target_candidate_absent"
            : "successor_design_portfolio_target_candidate_ambiguous"
        );
      } else {
        reasons.push(...validateTopicProbeSuccessorDesignTarget({
          routeTarget,
          candidate: matches[0]
        }).reasons);
      }
    }
  }

  return {
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)]
  };
}

export function validateTopicProbeSuccessorDesignTarget(input: {
  routeTarget: TopicProbeSuccessorRouteTarget;
  candidate: TopicPortfolioCandidate;
}): TopicProbeSuccessorDesignTargetValidation {
  const { routeTarget, candidate } = input;
  const reasons: string[] = [];

  if (routeTarget.policy === "refresh_portfolio_excluding_rejected") {
    if (routeTarget.target_candidate !== null) {
      reasons.push("successor_design_refresh_target_candidate_must_be_null");
    }
    if (
      routeTarget.forbidden_candidate_ids.includes(
        candidate.source_candidate_id
      )
    ) {
      reasons.push("successor_design_candidate_id_forbidden");
    }
    if (routeTarget.forbidden_topic_ids.includes(candidate.topic_id)) {
      reasons.push("successor_design_topic_id_forbidden");
    }
    const sourceDescriptor = routeTarget.source_active_descriptor;
    const divergencePolicy = routeTarget.refresh_divergence_policy;
    const candidateDescriptor = candidate.topic_memory?.descriptor;
    if (!sourceDescriptor || !divergencePolicy) {
      reasons.push("successor_design_refresh_divergence_policy_missing");
    } else if (!candidateDescriptor) {
      reasons.push("successor_design_refresh_candidate_descriptor_missing");
    } else {
      const changedAxes = changedTopicMemoryAxes(
        sourceDescriptor,
        candidateDescriptor
      );
      const countedChangedAxes = changedAxes.filter((axis) =>
        divergencePolicy.counted_axes.includes(axis)
      );
      if (
        divergencePolicy.required_changed_axes.some(
          (axis) => !changedAxes.includes(axis)
        )
      ) {
        reasons.push("successor_design_refresh_required_axis_unchanged");
      }
      if (countedChangedAxes.length < divergencePolicy.minimum_changed_axes) {
        reasons.push("successor_design_refresh_changed_axes_insufficient");
      }
    }
    if (candidate.topic_memory?.decision.disposition !== "clear") {
      reasons.push("successor_design_refresh_candidate_memory_not_clear");
    }
  } else {
    const targetCandidate = routeTarget.target_candidate;
    if (!targetCandidate) {
      reasons.push("successor_design_target_candidate_missing");
    } else {
      if (
        candidate.source_candidate_id
          !== targetCandidate.source_candidate_id
      ) {
        reasons.push("successor_design_candidate_id_mismatch");
      }
      if (candidate.topic_id !== targetCandidate.topic_id) {
        reasons.push("successor_design_topic_id_mismatch");
      }
      if (candidate.content_sha256 !== targetCandidate.content_sha256) {
        reasons.push("successor_design_candidate_content_hash_mismatch");
      }
      if (!valuesEqual(candidate, targetCandidate)) {
        reasons.push("successor_design_candidate_projection_mismatch");
      }
    }
  }

  if (!candidate.probe_eligible) {
    reasons.push("successor_design_candidate_not_probe_eligible");
  }
  if (!isTopicProbeSuccessorDesignCandidate(candidate)) {
    reasons.push("successor_design_candidate_contract_incomplete");
  }
  return {
    valid: reasons.length === 0,
    reasons: [...new Set(reasons)]
  };
}

export function isTopicProbeSuccessorDesignCandidate(
  candidate: TopicPortfolioCandidate
): candidate is TopicProbeSuccessorDesignCandidate {
  return hasText(candidate.comparator)
    && hasText(candidate.dataset_task_bench)
    && hasText(candidate.primary_metric)
    && hasText(candidate.metric_unit)
    && candidate.metric_scale !== undefined
    && candidate.metric_direction !== undefined
    && candidate.effect_criterion !== undefined
    && hasText(candidate.objective_raw)
    && hasText(candidate.falsifier)
    && hasText(candidate.local_budget)
    && candidate.brief_compute_budget_ceiling !== undefined
    && hasText(candidate.kill_signal)
    && hasText(candidate.contribution_claim)
    && hasText(candidate.minimum_publishable_evidence);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
