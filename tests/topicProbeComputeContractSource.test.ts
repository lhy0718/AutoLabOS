import { describe, expect, it } from "vitest";

import { resolveTopicProbeComputeContractSource } from "../src/core/topicProbeComputeContractSource.js";
import { ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH } from "../src/core/topicProbeOutcomeArtifacts.js";
import { TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS } from "../src/core/runs/topicProbeSuccessorLineage.js";
import type { ResearchEvidenceStage } from "../src/core/runs/researchRunModeGuard.js";

describe("topic-probe compute contract source", () => {
  it.each([
    ["bounded_probe", "bounded_probe"],
    ["bounded_probe_successor", "bounded_probe"],
    ["topic_refresh_successor", "bounded_probe"]
  ] satisfies Array<[ResearchEvidenceStage, "bounded_probe"]>)(
    "uses the child-owned active contract for %s",
    (evidenceStage, stage) => {
      expect(resolveTopicProbeComputeContractSource(evidenceStage)).toEqual({
        stage,
        relativePath: ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH,
        requireCurrentRunId: true
      });
    }
  );

  it("uses the frozen source contract only for a confirmatory follow-up", () => {
    expect(resolveTopicProbeComputeContractSource("confirmatory_followup")).toEqual({
      stage: "confirmatory",
      relativePath: TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.activeContract,
      requireCurrentRunId: false
    });
  });

  it("does not create a topic-probe compute contract for a standard run", () => {
    expect(resolveTopicProbeComputeContractSource("standard")).toBeUndefined();
  });
});
