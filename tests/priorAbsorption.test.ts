import { describe, expect, it } from "vitest";

import type { HypothesisCandidate } from "../src/core/analysis/researchPlanning.js";
import {
  PRIOR_ABSORPTION_AXES,
  buildPriorAbsorptionAxisVerificationPrompt,
  buildPriorAbsorptionMatrix,
  parsePriorAbsorptionAxisVerificationResponse,
  validatePriorAbsorptionMatrixArtifact,
  type PriorAbsorptionAssessment,
  type PriorAbsorptionAxis,
  type PriorAbsorptionAxisVerificationSeed,
  type PriorAbsorptionAxisVerificationVerdict,
  type PriorAbsorptionDisposition,
  type PriorAbsorptionEvidenceSeed
} from "../src/core/priorAbsorption.js";

const RUN_ID = "run_prior_absorption_fixture";
const RESEARCH_CYCLE = 3;
const GENERATED_AT = "2026-01-01T00:00:00.000Z";

describe("prior absorption matrix", () => {
  it("downgrades an unsupported non-overlap self-assessment to uncertain", () => {
    const matrix = buildMatrix([
      ...assessments("non_overlapping", {
        axisEvidence: false,
        independentEvidence: false
      })
    ]);

    expect(matrix.candidates[0]?.probe_eligible).toBe(false);
    expect(matrix.candidates[0]?.comparisons.every(
      (comparison) => comparison.disposition === "uncertain"
    )).toBe(true);
    expect(matrix.candidates[0]?.reason_codes).toContain(
      "prior_absorption_uncertain"
    );
  });

  it("fails closed when a cited prior lacks full-text evidence", () => {
    const evidenceRows = evidence();
    evidenceRows[0] = {
      ...evidenceRows[0]!,
      source_type: "abstract"
    };
    const matrix = buildMatrix(assessments("partially_absorbed"), evidenceRows);

    expect(matrix.candidates[0]?.full_text_evidence_complete).toBe(false);
    expect(matrix.candidates[0]?.probe_eligible).toBe(false);
    expect(matrix.candidates[0]?.comparisons[0]).toMatchObject({
      reported_disposition: "partially_absorbed",
      disposition: "uncertain",
      full_text_evidence_complete: false
    });
  });

  it.each(["absorbed", "uncertain"] as const)(
    "blocks probe eligibility for %s closest-prior dispositions",
    (disposition) => {
      const matrix = buildMatrix(assessments(disposition));

      expect(matrix.candidates[0]?.probe_eligible).toBe(false);
      expect(matrix.candidates[0]?.comparisons.every(
        (comparison) => comparison.disposition === disposition
      )).toBe(true);
    }
  );

  it("allows partial absorption only with a residual difference, falsifiable comparison, and independent full-text support", () => {
    const matrix = buildMatrix(assessments("partially_absorbed"));
    const candidate = matrix.candidates[0]!;

    expect(candidate.coverage_complete).toBe(true);
    expect(candidate.full_text_evidence_complete).toBe(true);
    expect(candidate.independent_evidence_complete).toBe(true);
    expect(candidate.partial_comparisons_complete).toBe(true);
    expect(candidate.probe_eligible).toBe(true);
    expect(candidate.comparisons.every(
      (comparison) =>
        comparison.disposition === "partially_absorbed"
        && comparison.axes.length === PRIOR_ABSORPTION_AXES.length
        && comparison.axes.every(
          (axis) =>
            axis.evidence_refs.length === 1
            && axis.evidence_refs[0]?.source_type === "full_text"
            && axis.evidence_refs[0]?.evidence_span
            && axis.verification_status === "supported"
            && axis.relation_verification?.provenance.context_isolated === true
        )
    )).toBe(true);
    expect(candidate.comparisons.every(
      (comparison) =>
        new Set(comparison.axes.map(
          (axis) => axis.relation_verification?.verification_input_sha256
        )).size === PRIOR_ABSORPTION_AXES.length
    )).toBe(true);
    expect(validatePriorAbsorptionMatrixArtifact(JSON.stringify(matrix), {
      expectedRunId: RUN_ID,
      expectedResearchCycle: RESEARCH_CYCLE
    })).toMatchObject({ measured: true, valid: true, reasons: [] });
  });

  it("blocks a dataset or object swap when mechanism, evaluation, and claim scope remain absorbed", () => {
    const rows = assessments("partially_absorbed").map((assessment) => ({
      ...assessment,
      axes: assessment.axes.map((axis) => ({
        ...axis,
        relation:
          axis.axis === "contribution_object" || axis.axis === "data_task_scope"
            ? "distinct" as const
            : "overlapping" as const
      }))
    }));

    const matrix = buildMatrix(rows);
    const candidate = matrix.candidates[0]!;

    expect(candidate.probe_eligible).toBe(false);
    expect(candidate.comparisons.every(
      (comparison) =>
        comparison.reported_disposition === "partially_absorbed"
        && comparison.disposition === "uncertain"
        && comparison.reason_codes.includes("prior_absorption_scope_swap_only")
    )).toBe(true);
  });

  it("accepts fully grounded non-overlap and detects content tampering", () => {
    const matrix = buildMatrix(assessments("non_overlapping"));
    const tampered = structuredClone(matrix);
    tampered.candidates[0]!.comparisons[0]!.axes[0]!.prior_position =
      "Tampered prior position.";

    expect(matrix.candidates[0]?.probe_eligible).toBe(true);
    expect(validatePriorAbsorptionMatrixArtifact(JSON.stringify(tampered))).toMatchObject({
      measured: true,
      valid: false,
      reasons: expect.arrayContaining([
        "prior_absorption_matrix_content_hash_mismatch",
        expect.stringMatching(/^prior_absorption_axis_content_hash_mismatch:/u)
      ])
    });
  });

  it("fails closed when one generic full-text span is reused across all axes without axis verification", () => {
    const matrix = buildMatrix(
      assessments("non_overlapping"),
      evidence(),
      { verifyAxes: false }
    );
    const candidate = matrix.candidates[0]!;

    expect(candidate.comparisons.every(
      (comparison) =>
        new Set(comparison.axes.flatMap(
          (axis) => axis.evidence_refs.map((reference) => reference.evidence_span)
        )).size === 1
    )).toBe(true);
    expect(candidate.probe_eligible).toBe(false);
    expect(candidate.reason_codes).toContain(
      "prior_absorption_axis_relation_verification_incomplete"
    );
  });

  it.each(["contradicted", "insufficient"] as const)(
    "fails closed when one axis verifier returns %s",
    (verdict) => {
      const matrix = buildMatrix(
        assessments("non_overlapping"),
        evidence(),
        {
          verdictForAxis: (axis) =>
            axis === "method_mechanism" ? verdict : "supported"
        }
      );
      const candidate = matrix.candidates[0]!;

      expect(candidate.probe_eligible).toBe(false);
      expect(candidate.comparisons.every(
        (comparison) => comparison.disposition === "uncertain"
      )).toBe(true);
      expect(candidate.reason_codes).toContain(
        `prior_absorption_axis_relation_verification_${verdict}`
      );
    }
  );

  it("rejects a verification input hash copied from a different axis", () => {
    const matrix = buildMatrix(
      assessments("non_overlapping"),
      evidence(),
      {
        transformVerifications: (rows) => {
          const copiedHash = rows[0]!.verification_input_sha256;
          return rows.map((row) => ({
            ...row,
            verification_input_sha256: copiedHash
          }));
        }
      }
    );

    expect(matrix.candidates[0]?.probe_eligible).toBe(false);
    expect(matrix.candidates[0]?.comparisons.some(
      (comparison) => comparison.axes.some(
        (axis) => axis.verification_status === "invalid"
      )
    )).toBe(true);
  });

  it("marks schema v1 matrices stale instead of accepting their prior gate state", () => {
    const matrix = buildMatrix(assessments("non_overlapping"));
    const staleSchema = {
      ...structuredClone(matrix),
      schema_version: 1
    };

    expect(validatePriorAbsorptionMatrixArtifact(JSON.stringify(staleSchema))).toEqual({
      measured: true,
      valid: false,
      reasons: ["prior_absorption_matrix_schema_version_unsupported:1"]
    });
  });

  it("binds the verifier prompt and parsed provenance to every axis input hash", () => {
    const provisional = buildMatrix(
      assessments("non_overlapping"),
      evidence(),
      { verifyAxes: false }
    );
    const prompt = buildPriorAbsorptionAxisVerificationPrompt(provisional);
    const targets = JSON.parse(prompt.split("Targets:\n")[1] || "[]") as Array<{
      verification_input_sha256: string;
      candidate_position: string;
      prior_position: string;
    }>;

    for (const axis of provisional.candidates[0]!.comparisons[0]!.axes) {
      expect(targets).toContainEqual(expect.objectContaining({
        verification_input_sha256: axis.verification_input_sha256,
        candidate_position: axis.candidate_position,
        prior_position: axis.prior_position
      }));
    }
  });
});

function buildMatrix(
  assessmentRows: PriorAbsorptionAssessment[],
  evidenceRows = evidence(),
  options: {
    verifyAxes?: boolean;
    verdictForAxis?: (
      axis: PriorAbsorptionAxis
    ) => PriorAbsorptionAxisVerificationVerdict;
    transformVerifications?: (
      rows: PriorAbsorptionAxisVerificationSeed[]
    ) => PriorAbsorptionAxisVerificationSeed[];
  } = {}
) {
  const baseInput = {
    candidates: [candidate()],
    evidence: evidenceRows,
    assessments: assessmentRows,
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    generatedAt: GENERATED_AT,
    assessmentSource: "llm_structured_comparison"
  } as const;
  const provisional = buildPriorAbsorptionMatrix(baseInput);
  if (options.verifyAxes === false) {
    return provisional;
  }
  const responseText = JSON.stringify({
    verifications: provisional.candidates.flatMap((candidateRow) =>
      candidateRow.comparisons.flatMap((comparison) =>
        comparison.axes.map((axis) => ({
          candidate_id: candidateRow.candidate_id,
          prior_paper_id: comparison.prior_paper_id,
          axis: axis.axis,
          reported_relation: axis.relation,
          verification_input_sha256: axis.verification_input_sha256,
          verdict: options.verdictForAxis?.(axis.axis) || "supported",
          rationale: `Axis-specific verification for ${axis.axis}.`
        }))
      )
    )
  });
  let axisVerifications = parsePriorAbsorptionAxisVerificationResponse(
    responseText,
    {
      verifier_id: "context_isolated_fixture_verifier",
      provider: "fixture_provider",
      model: "fixture_model",
      verification_run_id: "fixture_verification_pass",
      context_isolated: true
    }
  );
  axisVerifications = options.transformVerifications?.(axisVerifications)
    || axisVerifications;
  return buildPriorAbsorptionMatrix({
    ...baseInput,
    axisVerifications
  });
}

function assessments(
  disposition: PriorAbsorptionDisposition,
  options: {
    axisEvidence?: boolean;
    independentEvidence?: boolean;
  } = {}
): PriorAbsorptionAssessment[] {
  const axisEvidence = options.axisEvidence !== false;
  const independentEvidence = options.independentEvidence !== false;
  return ["prior_alpha", "prior_beta"].map((priorPaperId, priorIndex) => {
    const evidenceId = priorIndex === 0 ? "evidence_alpha" : "evidence_beta";
    return {
      candidate_id: "candidate_controlled",
      prior_paper_id: priorPaperId,
      disposition,
      axes: PRIOR_ABSORPTION_AXES.map((axis, axisIndex) => ({
        axis,
        relation:
          disposition === "non_overlapping"
            ? "distinct" as const
            : disposition === "partially_absorbed"
              ? axisIndex === 0
                ? "overlapping" as const
                : "distinct" as const
              : "overlapping" as const,
        evidence_ids: axisEvidence ? [evidenceId] : []
      })),
      residual_difference:
        disposition === "partially_absorbed"
          ? "The candidate isolates an evaluation boundary not tested by the prior."
          : undefined,
      falsifiable_comparison:
        disposition === "partially_absorbed"
          ? "Compare matched conditions and reject the residual difference if the interval crosses the frozen margin."
          : undefined,
      independent_evidence_ids:
        independentEvidence ? ["evidence_alpha", "evidence_beta"] : []
    };
  });
}

function candidate(): HypothesisCandidate {
  return {
    id: "candidate_controlled",
    text: "A bounded intervention changes the measured outcome under a held-out condition.",
    novelty: 4,
    feasibility: 4,
    testability: 5,
    cost: 2,
    expected_gain: 3,
    evidence_links: ["evidence_alpha", "evidence_beta"],
    contribution_claim: "The comparison identifies a reproducible boundary condition.",
    dataset_task_bench: "held_out_evaluation_task",
    comparator: "matched_budget_reference",
    primary_metric: "primary_score",
    metric_unit: "unitless",
    metric_scale: "raw",
    metric_direction: "maximize",
    meaningful_effect: "A delta of at least 0.05 over the reference.",
    effect_criterion: {
      basis: "delta_vs_reference",
      magnitude: 0.05,
      scale: "raw",
      inclusive: true
    },
    falsifier: "The repeated-run interval crosses the frozen null margin.",
    minimum_publishable_evidence:
      "Repeated matched comparisons with uncertainty and explicit failure analysis.",
    closest_prior_non_overlap:
      "Self-reported distinction that must not authorize a probe by itself."
  };
}

function evidence(): PriorAbsorptionEvidenceSeed[] {
  return [
    evidenceRow("evidence_alpha", "prior_alpha"),
    evidenceRow("evidence_beta", "prior_beta")
  ];
}

function evidenceRow(
  evidenceId: string,
  paperId: string
): PriorAbsorptionEvidenceSeed {
  return {
    evidence_id: evidenceId,
    paper_id: paperId,
    source_type: "full_text",
    claim: "The prior reports a bounded contribution object.",
    method_slot: "The prior applies a specified mechanism.",
    dataset_slot: "The prior evaluates a declared task scope.",
    metric_slot: "primary_score",
    result_slot: "The prior reports a matched evaluation result.",
    limitation_slot: "The prior limits claims to the observed evaluation scope.",
    evidence_span: `Exact full-text evidence span for ${evidenceId}.`,
    confidence: 0.95
  };
}
