import type { ResearchEvidenceStage } from "./runs/researchRunModeGuard.js";
import { TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS } from "./runs/topicProbeSuccessorLineage.js";
import type { TopicProbeComputeStage } from "./topicProbeComputeBudget.js";
import { ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH } from "./topicProbeOutcomeArtifacts.js";

export interface TopicProbeComputeContractSource {
  stage: TopicProbeComputeStage;
  relativePath: string;
  requireCurrentRunId: boolean;
}

export function resolveTopicProbeComputeContractSource(
  evidenceStage: ResearchEvidenceStage
): TopicProbeComputeContractSource | undefined {
  if (evidenceStage === "standard") {
    return undefined;
  }
  if (evidenceStage === "confirmatory_followup") {
    return {
      stage: "confirmatory",
      relativePath: TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.activeContract,
      requireCurrentRunId: false
    };
  }
  return {
    stage: "bounded_probe",
    relativePath: ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH,
    requireCurrentRunId: true
  };
}
