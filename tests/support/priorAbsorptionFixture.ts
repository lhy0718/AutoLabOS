import type { HypothesisCandidate } from "../../src/core/analysis/researchPlanning.js";
import {
  PRIOR_ABSORPTION_AXES,
  buildPriorAbsorptionMatrix,
  parsePriorAbsorptionAxisVerificationResponse,
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
  const baseInput = {
    candidates: input.candidates,
    evidence: input.evidence,
    assessments,
    runId: input.runId,
    researchCycle: input.researchCycle,
    generatedAt: input.generatedAt,
    assessmentSource: "llm_structured_comparison"
  } as const;
  const provisional = buildPriorAbsorptionMatrix(baseInput);
  const responseText = JSON.stringify({
    verifications: provisional.candidates.flatMap((candidate) =>
      candidate.comparisons.flatMap((comparison) =>
        comparison.axes.map((axis) => ({
          candidate_id: candidate.candidate_id,
          prior_paper_id: comparison.prior_paper_id,
          axis: axis.axis,
          reported_relation: axis.relation,
          verification_input_sha256: axis.verification_input_sha256,
          verdict: "supported",
          rationale: `Fixture verification is bound to ${axis.axis}.`
        }))
      )
    )
  });
  const axisVerifications = parsePriorAbsorptionAxisVerificationResponse(
    responseText,
    {
      verifier_id: "context_isolated_fixture_verifier",
      provider: "fixture_provider",
      model: "fixture_model",
      verification_run_id: "fixture_verification_pass",
      context_isolated: true
    }
  );
  return buildPriorAbsorptionMatrix({
    ...baseInput,
    axisVerifications
  });
}
