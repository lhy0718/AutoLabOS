import type { HypothesisCandidate } from "../../src/core/analysis/researchPlanning.js";
import {
  PRIOR_ABSORPTION_AXES,
  buildPriorAbsorptionMatrix,
  type PriorAbsorptionAssessment,
  type PriorAbsorptionEvidenceSeed,
  type PriorAbsorptionMatrix
} from "../../src/core/priorAbsorption.js";

export function buildPassingPriorAbsorptionMatrixFixture(input: {
  candidates: HypothesisCandidate[];
  evidence: PriorAbsorptionEvidenceSeed[];
  runId: string;
  researchCycle: number;
  generatedAt: string;
}): PriorAbsorptionMatrix {
  const independentEvidenceIds = input.evidence.map(
    (item) => item.evidence_id || ""
  );
  const assessments: PriorAbsorptionAssessment[] = input.candidates.flatMap(
    (candidate) => input.evidence.map((prior) => ({
      candidate_id: candidate.id,
      prior_paper_id: prior.paper_id || "",
      disposition: "non_overlapping" as const,
      axes: PRIOR_ABSORPTION_AXES.map((axis) => ({
        axis,
        relation: "distinct" as const,
        evidence_ids: [prior.evidence_id || ""]
      })),
      independent_evidence_ids: independentEvidenceIds
    }))
  );
  return buildPriorAbsorptionMatrix({
    candidates: input.candidates,
    evidence: input.evidence,
    assessments,
    runId: input.runId,
    researchCycle: input.researchCycle,
    generatedAt: input.generatedAt,
    assessmentSource: "llm_structured_comparison"
  });
}
