import {
  TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
  TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
} from "../topicDiscoveryScientificTerms.js";

export const TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_VERSION = 6 as const;
export const TOPIC_DISCOVERY_SEMANTIC_REVIEW_INPUT_ARTIFACT_VERSION = 1 as const;
export const TOPIC_DISCOVERY_CANDIDATE_SIDECAR_VERSION = 2 as const;

export const TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT = {
  version: TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_VERSION,
  term_normalization_version: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
  candidate_recall_semantics_version:
    TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION
} as const;

export function isCurrentTopicDiscoveryCollectQueryPlanArtifact(
  value: unknown
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const artifact = value as Record<string, unknown>;
  return artifact.version === TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.version
    && artifact.term_normalization_version
      === TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.term_normalization_version
    && artifact.candidate_recall_semantics_version
      === TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.candidate_recall_semantics_version;
}
