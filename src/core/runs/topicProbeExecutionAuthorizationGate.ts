import path from "node:path";

import { hashCanonical } from "../canonicalHash.js";
import type { TopicProbeExecutionAuthorization } from "../topicProbeExecutionAuthorization.js";
import { loadResearchFunnelProjection } from "./researchFunnelProjection.js";

export const TOPIC_PROBE_EXECUTION_AUTHORIZATION_GATE_RELATIVE_PATH =
  "governance/topic_probe_execution_authorization.json";

export interface TopicProbeExecutionAuthorizationGateArtifact {
  schema_version: 1;
  artifact_kind: "topic_probe_execution_authorization_gate";
  run_id: string;
  research_cycle: number;
  status: TopicProbeExecutionAuthorization["status"];
  effective_execution_authorized: boolean;
  authorization: TopicProbeExecutionAuthorization;
  content_sha256: string;
}

export async function loadTopicProbeExecutionAuthorizationGate(input: {
  workspaceRoot: string;
  runId: string;
  expectedResearchCycle: number;
}): Promise<TopicProbeExecutionAuthorizationGateArtifact> {
  const projection = await loadResearchFunnelProjection(
    path.join(input.workspaceRoot, ".autolabos", "runs", input.runId),
    {
      runId: input.runId,
      researchCycle: input.expectedResearchCycle,
      researchMode: "topic_discovery"
    }
  );
  const authorization = projection?.executionAuthorization ?? unmeasuredAuthorization();
  const payload = {
    schema_version: 1 as const,
    artifact_kind: "topic_probe_execution_authorization_gate" as const,
    run_id: input.runId,
    research_cycle: input.expectedResearchCycle,
    status: authorization.status,
    effective_execution_authorized: authorization.authorized,
    authorization: {
      ...authorization,
      required_candidate_ids: [...authorization.required_candidate_ids],
      covered_candidate_ids: [...authorization.covered_candidate_ids],
      reason_codes: [...authorization.reason_codes]
    }
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function unmeasuredAuthorization(): TopicProbeExecutionAuthorization {
  return {
    status: "unmeasured",
    trusted: false,
    authorized: false,
    base_funnel_authorized: false,
    candidate_prior_search_authorized: false,
    estimator_authorized: false,
    required_candidate_ids: [],
    covered_candidate_ids: [],
    reason_codes: ["effective_execution_projection_unavailable"]
  };
}
