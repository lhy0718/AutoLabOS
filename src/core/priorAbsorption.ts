import { createHash } from "node:crypto";

import type {
  HypothesisCandidate,
  HypothesisEvidenceSeed
} from "./analysis/researchPlanning.js";
import { parseStructuredModelJsonObject } from "./analysis/modelJson.js";

export const PRIOR_ABSORPTION_AXES = [
  "contribution_object",
  "method_mechanism",
  "data_task_scope",
  "evaluation_protocol",
  "claim_ceiling"
] as const;

export type PriorAbsorptionAxis = (typeof PRIOR_ABSORPTION_AXES)[number];
export type PriorAbsorptionDisposition =
  | "absorbed"
  | "partially_absorbed"
  | "non_overlapping"
  | "uncertain";
export type PriorAbsorptionAxisRelation =
  | "overlapping"
  | "partially_overlapping"
  | "distinct"
  | "uncertain";

export interface PriorAbsorptionEvidenceSeed extends HypothesisEvidenceSeed {
  method_slot?: string;
  result_slot?: string;
  evidence_span?: string;
}

export interface PriorAbsorptionAxisAssessment {
  axis: PriorAbsorptionAxis;
  relation: PriorAbsorptionAxisRelation;
  evidence_ids: string[];
}

export interface PriorAbsorptionAssessment {
  candidate_id: string;
  prior_paper_id: string;
  disposition: PriorAbsorptionDisposition;
  axes: PriorAbsorptionAxisAssessment[];
  residual_difference?: string;
  falsifiable_comparison?: string;
  independent_evidence_ids?: string[];
}

export interface PriorAbsorptionEvidenceRef {
  evidence_id: string;
  paper_id: string;
  source_type: "full_text";
  evidence_span: string;
  content_sha256: string;
}

export interface PriorAbsorptionAxisComparison {
  axis: PriorAbsorptionAxis;
  candidate_position: string;
  prior_position: string;
  relation: PriorAbsorptionAxisRelation;
  evidence_refs: PriorAbsorptionEvidenceRef[];
  content_sha256: string;
}

export interface PriorAbsorptionPriorComparison {
  prior_paper_id: string;
  reported_disposition: PriorAbsorptionDisposition;
  disposition: PriorAbsorptionDisposition;
  axes: PriorAbsorptionAxisComparison[];
  residual_difference?: string;
  falsifiable_comparison?: string;
  independent_evidence_refs: PriorAbsorptionEvidenceRef[];
  full_text_evidence_complete: boolean;
  independent_evidence_complete: boolean;
  decision_eligible: boolean;
  reason_codes: string[];
  content_sha256: string;
}

export interface PriorAbsorptionCandidateContract {
  contribution_object: string;
  method_mechanism: string;
  data_task_scope: string;
  evaluation_protocol: string;
  claim_ceiling: string;
  falsifier: string;
  comparator: string;
  content_sha256: string;
}

export interface PriorAbsorptionCandidate {
  candidate_id: string;
  candidate_contract: PriorAbsorptionCandidateContract;
  prior_paper_ids: string[];
  comparisons: PriorAbsorptionPriorComparison[];
  coverage_complete: boolean;
  full_text_evidence_complete: boolean;
  independent_evidence_complete: boolean;
  partial_comparisons_complete: boolean;
  probe_eligible: boolean;
  reason_codes: string[];
  content_sha256: string;
}

export interface PriorAbsorptionMatrix {
  schema_version: 1;
  artifact_kind: "prior_absorption_matrix";
  run_id: string;
  research_cycle: number;
  generated_at: string;
  assessment_source: "llm_structured_comparison" | "unavailable";
  candidates: PriorAbsorptionCandidate[];
  content_sha256: string;
}

export interface PriorAbsorptionMatrixValidation {
  measured: boolean;
  valid: boolean;
  reasons: string[];
  matrix?: PriorAbsorptionMatrix;
}

export interface PriorAbsorptionCandidateProjection {
  matrix_content_sha256: string;
  candidate_content_sha256: string;
  prior_paper_ids: string[];
  comparisons: Array<{
    prior_paper_id: string;
    reported_disposition: PriorAbsorptionDisposition;
    disposition: PriorAbsorptionDisposition;
    content_sha256: string;
  }>;
  coverage_complete: boolean;
  full_text_evidence_complete: boolean;
  independent_evidence_complete: boolean;
  partial_comparisons_complete: boolean;
  probe_eligible: boolean;
  reason_codes: string[];
}

interface RawPriorAbsorptionResponse {
  assessments?: unknown;
}

interface PriorAbsorptionBuildInput {
  candidates: HypothesisCandidate[];
  evidence: PriorAbsorptionEvidenceSeed[];
  assessments?: PriorAbsorptionAssessment[];
  runId: string;
  researchCycle: number;
  generatedAt?: string;
  assessmentSource?: PriorAbsorptionMatrix["assessment_source"];
}

export function buildPriorAbsorptionMatrix(
  input: PriorAbsorptionBuildInput
): PriorAbsorptionMatrix {
  const evidenceById = new Map(
    input.evidence.flatMap((item) => {
      const evidenceId = normalizeText(item.evidence_id);
      return evidenceId ? [[evidenceId, item] as const] : [];
    })
  );
  const assessments = input.assessments || [];
  const assessmentCounts = new Map<string, number>();
  const assessmentByKey = new Map<string, PriorAbsorptionAssessment>();
  for (const assessment of assessments) {
    const key = assessmentKey(assessment.candidate_id, assessment.prior_paper_id);
    assessmentCounts.set(key, (assessmentCounts.get(key) || 0) + 1);
    if (!assessmentByKey.has(key)) {
      assessmentByKey.set(key, assessment);
    }
  }

  const candidates = input.candidates.map((candidate) =>
    buildCandidateAbsorption({
      candidate,
      evidenceById,
      assessmentByKey,
      assessmentCounts
    })
  );
  const payload = {
    schema_version: 1 as const,
    artifact_kind: "prior_absorption_matrix" as const,
    run_id: input.runId,
    research_cycle: input.researchCycle,
    generated_at: input.generatedAt || new Date().toISOString(),
    assessment_source:
      input.assessmentSource ||
      (assessments.length > 0 ? "llm_structured_comparison" as const : "unavailable" as const),
    candidates
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function buildPriorAbsorptionAssessmentPrompt(input: {
  candidates: HypothesisCandidate[];
  evidence: PriorAbsorptionEvidenceSeed[];
}): string {
  const evidenceById = new Map(
    input.evidence.flatMap((item) => {
      const evidenceId = normalizeText(item.evidence_id);
      return evidenceId ? [[evidenceId, item] as const] : [];
    })
  );
  const candidatePayload = input.candidates.map((candidate) => ({
    candidate_id: candidate.id,
    candidate_contract: buildCandidateContractPayload(candidate),
    closest_prior_non_overlap_self_report:
      normalizeText(candidate.closest_prior_non_overlap) || null,
    reviewer_absorption_objection:
      normalizeText(candidate.reviewer_absorption_objection) || null,
    linked_evidence_ids: uniqueStrings(candidate.evidence_links),
    linked_prior_paper_ids: uniqueStrings(
      candidate.evidence_links.map((evidenceId) => evidenceById.get(evidenceId)?.paper_id)
    )
  }));
  const linkedEvidenceIds = new Set(
    input.candidates.flatMap((candidate) => candidate.evidence_links)
  );
  const evidencePayload = input.evidence
    .filter((item) => linkedEvidenceIds.has(normalizeText(item.evidence_id) || ""))
    .map((item) => ({
      evidence_id: normalizeText(item.evidence_id),
      paper_id: normalizeText(item.paper_id),
      source_type: item.source_type,
      claim: normalizeText(item.claim),
      method_slot: normalizeText(item.method_slot),
      result_slot: normalizeText(item.result_slot),
      limitation_slot: normalizeText(item.limitation_slot),
      dataset_slot: normalizeText(item.dataset_slot),
      metric_slot: normalizeText(item.metric_slot),
      evidence_span: normalizeText(item.evidence_span)
    }));

  return [
    "Build a conservative prior-absorption assessment for every candidate/prior pair in the input.",
    "The candidate's self-reported non-overlap is not evidence and must never determine the disposition by itself.",
    "For every pair, compare exactly these five axes: contribution_object, method_mechanism, data_task_scope, evaluation_protocol, claim_ceiling.",
    "Each axis must cite evidence_ids from that exact prior paper. Use only full_text rows with a nonempty evidence_span.",
    "Use uncertain whenever the supplied evidence cannot support a relation.",
    "Use non_overlapping only when every axis is distinct and independent_evidence_ids cite full-text evidence from at least two linked prior papers.",
    "Use partially_absorbed only when at least one axis overlaps, at least one axis is distinct, residual_difference and falsifiable_comparison are explicit, and independent_evidence_ids cite full-text evidence from at least two linked prior papers.",
    "A change confined to contribution_object or data_task_scope is not a residual contribution when method_mechanism, evaluation_protocol, and claim_ceiling all overlap. Report that case as absorbed or uncertain, never as decision-eligible partially_absorbed.",
    "Return JSON only with this shape:",
    JSON.stringify({
      assessments: [{
        candidate_id: "candidate id",
        prior_paper_id: "linked prior paper id",
        disposition: "absorbed|partially_absorbed|non_overlapping|uncertain",
        axes: PRIOR_ABSORPTION_AXES.map((axis) => ({
          axis,
          relation: "overlapping|partially_overlapping|distinct|uncertain",
          evidence_ids: ["exact evidence id from the same prior"]
        })),
        residual_difference: "required for partially_absorbed",
        falsifiable_comparison: "required for partially_absorbed",
        independent_evidence_ids: ["full-text evidence ids spanning at least two linked priors"]
      }]
    }),
    "Input:",
    JSON.stringify({
      candidates: candidatePayload,
      evidence: evidencePayload
    })
  ].join("\n");
}

export function parsePriorAbsorptionAssessmentResponse(
  text: string
): PriorAbsorptionAssessment[] {
  const parsed = parseStructuredModelJsonObject<RawPriorAbsorptionResponse>(text, {
    emptyError: "prior_absorption_response_empty",
    notFoundError: "prior_absorption_response_json_not_found",
    incompleteError: "prior_absorption_response_json_incomplete",
    invalidError: "prior_absorption_response_json_invalid"
  }).value;
  if (!Array.isArray(parsed.assessments)) {
    throw new Error("prior_absorption_assessments_missing");
  }
  return parsed.assessments.flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }
    const candidateId = normalizeText(value.candidate_id);
    const priorPaperId = normalizeText(value.prior_paper_id);
    const disposition = normalizeDisposition(value.disposition);
    if (!candidateId || !priorPaperId || !disposition) {
      return [];
    }
    const axes = Array.isArray(value.axes)
      ? value.axes.flatMap((axisValue) => parseAxisAssessment(axisValue))
      : [];
    return [{
      candidate_id: candidateId,
      prior_paper_id: priorPaperId,
      disposition,
      axes,
      residual_difference: normalizeText(value.residual_difference),
      falsifiable_comparison: normalizeText(value.falsifiable_comparison),
      independent_evidence_ids: isStringArray(value.independent_evidence_ids)
        ? uniqueStrings(value.independent_evidence_ids)
        : []
    }];
  });
}

export function validatePriorAbsorptionMatrixArtifact(
  raw: string,
  context: {
    expectedRunId?: string;
    expectedResearchCycle?: number;
  } = {}
): PriorAbsorptionMatrixValidation {
  if (!raw.trim()) {
    return {
      measured: false,
      valid: false,
      reasons: ["prior_absorption_matrix_missing"]
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      measured: true,
      valid: false,
      reasons: ["prior_absorption_matrix_invalid_json"]
    };
  }
  if (!isPriorAbsorptionMatrix(value)) {
    return {
      measured: true,
      valid: false,
      reasons: ["prior_absorption_matrix_schema_invalid"]
    };
  }

  const reasons: string[] = [];
  const { content_sha256: matrixHash, ...matrixPayload } = value;
  if (hashCanonical(matrixPayload) !== matrixHash) {
    reasons.push("prior_absorption_matrix_content_hash_mismatch");
  }
  if (context.expectedRunId !== undefined && value.run_id !== context.expectedRunId) {
    reasons.push("prior_absorption_matrix_run_id_mismatch");
  }
  if (
    context.expectedResearchCycle !== undefined
    && value.research_cycle !== context.expectedResearchCycle
  ) {
    reasons.push("prior_absorption_matrix_research_cycle_mismatch");
  }
  const candidateIds = value.candidates.map((candidate) => candidate.candidate_id);
  if (new Set(candidateIds).size !== candidateIds.length) {
    reasons.push("prior_absorption_matrix_duplicate_candidate_id");
  }

  for (const candidate of value.candidates) {
    const { content_sha256: candidateHash, ...candidatePayload } = candidate;
    if (hashCanonical(candidatePayload) !== candidateHash) {
      reasons.push(`prior_absorption_candidate_content_hash_mismatch:${candidate.candidate_id}`);
    }
    const { content_sha256: contractHash, ...contractPayload } = candidate.candidate_contract;
    if (hashCanonical(contractPayload) !== contractHash) {
      reasons.push(`prior_absorption_candidate_contract_hash_mismatch:${candidate.candidate_id}`);
    }
    const comparisonPaperIds = candidate.comparisons.map((comparison) => comparison.prior_paper_id);
    if (!stringArraysEqual(candidate.prior_paper_ids, comparisonPaperIds)) {
      reasons.push(`prior_absorption_candidate_coverage_mismatch:${candidate.candidate_id}`);
    }
    if (new Set(comparisonPaperIds).size !== comparisonPaperIds.length) {
      reasons.push(`prior_absorption_candidate_duplicate_prior:${candidate.candidate_id}`);
    }
    for (const comparison of candidate.comparisons) {
      reasons.push(...validateComparisonIntegrity(candidate, comparison));
    }
    const expectedState = recomputeCandidateState(candidate);
    if (
      candidate.coverage_complete !== expectedState.coverageComplete
      || candidate.full_text_evidence_complete !== expectedState.fullTextComplete
      || candidate.independent_evidence_complete !== expectedState.independentComplete
      || candidate.partial_comparisons_complete !== expectedState.partialComplete
      || candidate.probe_eligible !== expectedState.probeEligible
    ) {
      reasons.push(`prior_absorption_candidate_gate_state_mismatch:${candidate.candidate_id}`);
    }
  }

  return {
    measured: true,
    valid: reasons.length === 0,
    reasons: uniqueStrings(reasons),
    matrix: value
  };
}

export function projectPriorAbsorptionCandidate(
  matrix: PriorAbsorptionMatrix | undefined,
  candidateId: string
): PriorAbsorptionCandidateProjection | undefined {
  const candidate = matrix?.candidates.find((item) => item.candidate_id === candidateId);
  if (!matrix || !candidate) {
    return undefined;
  }
  return {
    matrix_content_sha256: matrix.content_sha256,
    candidate_content_sha256: candidate.content_sha256,
    prior_paper_ids: [...candidate.prior_paper_ids],
    comparisons: candidate.comparisons.map((comparison) => ({
      prior_paper_id: comparison.prior_paper_id,
      reported_disposition: comparison.reported_disposition,
      disposition: comparison.disposition,
      content_sha256: comparison.content_sha256
    })),
    coverage_complete: candidate.coverage_complete,
    full_text_evidence_complete: candidate.full_text_evidence_complete,
    independent_evidence_complete: candidate.independent_evidence_complete,
    partial_comparisons_complete: candidate.partial_comparisons_complete,
    probe_eligible: candidate.probe_eligible,
    reason_codes: [...candidate.reason_codes]
  };
}

export function isPriorAbsorptionCandidateProjection(
  value: unknown
): value is PriorAbsorptionCandidateProjection {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isSha256(value.matrix_content_sha256)
    && isSha256(value.candidate_content_sha256)
    && isStringArray(value.prior_paper_ids)
    && Array.isArray(value.comparisons)
    && value.comparisons.every((comparison) =>
      isRecord(comparison)
      && typeof comparison.prior_paper_id === "string"
      && Boolean(normalizeDisposition(comparison.reported_disposition))
      && Boolean(normalizeDisposition(comparison.disposition))
      && isSha256(comparison.content_sha256))
    && typeof value.coverage_complete === "boolean"
    && typeof value.full_text_evidence_complete === "boolean"
    && typeof value.independent_evidence_complete === "boolean"
    && typeof value.partial_comparisons_complete === "boolean"
    && typeof value.probe_eligible === "boolean"
    && isStringArray(value.reason_codes)
  );
}

function buildCandidateAbsorption(input: {
  candidate: HypothesisCandidate;
  evidenceById: Map<string, PriorAbsorptionEvidenceSeed>;
  assessmentByKey: Map<string, PriorAbsorptionAssessment>;
  assessmentCounts: Map<string, number>;
}): PriorAbsorptionCandidate {
  const candidateContract = buildPriorAbsorptionCandidateContract(input.candidate);
  const priorPaperIds = uniqueStrings(
    input.candidate.evidence_links.map(
      (evidenceId) => input.evidenceById.get(evidenceId)?.paper_id
    )
  );
  const candidateEvidenceIds = new Set(uniqueStrings(input.candidate.evidence_links));
  const comparisons = priorPaperIds.map((priorPaperId) => {
    const key = assessmentKey(input.candidate.id, priorPaperId);
    return buildPriorComparison({
      candidate: input.candidate,
      candidateContract,
      priorPaperId,
      candidateEvidenceIds,
      evidenceById: input.evidenceById,
      assessment: input.assessmentByKey.get(key),
      duplicateAssessment: (input.assessmentCounts.get(key) || 0) > 1,
      linkedPriorPaperIds: priorPaperIds
    });
  });
  const coverageComplete =
    priorPaperIds.length > 0
    && comparisons.length === priorPaperIds.length
    && comparisons.every((comparison, index) => comparison.prior_paper_id === priorPaperIds[index]);
  const fullTextComplete =
    comparisons.length > 0
    && comparisons.every((comparison) => comparison.full_text_evidence_complete);
  const independentComplete =
    comparisons.length > 0
    && comparisons.every((comparison) => comparison.independent_evidence_complete);
  const partialComplete = comparisons.every(
    (comparison) =>
      comparison.reported_disposition !== "partially_absorbed"
      || comparison.disposition === "partially_absorbed"
  );
  const probeEligible =
    coverageComplete
    && fullTextComplete
    && independentComplete
    && partialComplete
    && comparisons.every((comparison) => comparison.decision_eligible);
  const reasonCodes = uniqueStrings([
    ...(coverageComplete ? [] : ["prior_absorption_prior_coverage_incomplete"]),
    ...(fullTextComplete ? [] : ["prior_absorption_full_text_evidence_incomplete"]),
    ...(independentComplete ? [] : ["prior_absorption_independent_evidence_incomplete"]),
    ...(partialComplete ? [] : ["prior_absorption_partial_comparison_incomplete"]),
    ...comparisons.flatMap((comparison) => comparison.reason_codes)
  ]);
  const payload = {
    candidate_id: input.candidate.id,
    candidate_contract: candidateContract,
    prior_paper_ids: priorPaperIds,
    comparisons,
    coverage_complete: coverageComplete,
    full_text_evidence_complete: fullTextComplete,
    independent_evidence_complete: independentComplete,
    partial_comparisons_complete: partialComplete,
    probe_eligible: probeEligible,
    reason_codes: reasonCodes
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function buildPriorComparison(input: {
  candidate: HypothesisCandidate;
  candidateContract: PriorAbsorptionCandidateContract;
  priorPaperId: string;
  candidateEvidenceIds: Set<string>;
  evidenceById: Map<string, PriorAbsorptionEvidenceSeed>;
  assessment?: PriorAbsorptionAssessment;
  duplicateAssessment: boolean;
  linkedPriorPaperIds: string[];
}): PriorAbsorptionPriorComparison {
  const assessment = input.assessment;
  const reportedDisposition = assessment?.disposition || "uncertain";
  const axes = PRIOR_ABSORPTION_AXES.map((axis) => {
    const axisAssessments = (assessment?.axes || []).filter((item) => item.axis === axis);
    const axisAssessment = axisAssessments.length === 1 ? axisAssessments[0] : undefined;
    return buildAxisComparison({
      axis,
      candidateContract: input.candidateContract,
      priorPaperId: input.priorPaperId,
      candidateEvidenceIds: input.candidateEvidenceIds,
      evidenceById: input.evidenceById,
      assessment: axisAssessment
    });
  });
  const fullTextComplete = axes.every(
    (axis) =>
      Boolean(normalizeText(axis.candidate_position))
      && Boolean(normalizeText(axis.prior_position))
      && axis.evidence_refs.length > 0
      && axis.relation !== "uncertain"
  );
  const independentEvidenceRefs = hydrateIndependentEvidenceRefs({
    evidenceIds: assessment?.independent_evidence_ids || [],
    candidateEvidenceIds: input.candidateEvidenceIds,
    evidenceById: input.evidenceById,
    linkedPriorPaperIds: input.linkedPriorPaperIds
  });
  const independentEvidenceComplete =
    new Set(independentEvidenceRefs.map((reference) => reference.paper_id)).size >= 2;
  const hasOverlappingAxis = axes.some(
    (axis) =>
      axis.relation === "overlapping"
      || axis.relation === "partially_overlapping"
  );
  const hasDistinctAxis = axes.some((axis) => axis.relation === "distinct");
  const hasDistinctCoreAxis = axes.some(
    (axis) =>
      (axis.axis === "method_mechanism"
        || axis.axis === "evaluation_protocol"
        || axis.axis === "claim_ceiling")
      && axis.relation === "distinct"
  );
  const coreAxesAllOverlap = axes
    .filter((axis) =>
      axis.axis === "method_mechanism"
      || axis.axis === "evaluation_protocol"
      || axis.axis === "claim_ceiling"
    )
    .every(
      (axis) =>
        axis.relation === "overlapping"
        || axis.relation === "partially_overlapping"
    );
  const allDistinct = axes.every((axis) => axis.relation === "distinct");
  const residualDifference = normalizeText(assessment?.residual_difference);
  const falsifiableComparison = normalizeText(assessment?.falsifiable_comparison);
  const partialContractComplete =
    hasOverlappingAxis
    && hasDistinctAxis
    && hasDistinctCoreAxis
    && Boolean(residualDifference)
    && Boolean(falsifiableComparison)
    && Boolean(input.candidateContract.falsifier)
    && Boolean(input.candidateContract.comparator)
    && independentEvidenceComplete;
  const nonOverlapContractComplete =
    allDistinct
    && independentEvidenceComplete;

  const reasons: string[] = [];
  if (!assessment) {
    reasons.push("prior_absorption_assessment_missing");
  }
  if (input.duplicateAssessment) {
    reasons.push("prior_absorption_duplicate_assessment");
  }
  if (!fullTextComplete) {
    reasons.push("prior_absorption_full_text_evidence_incomplete");
  }
  if (!independentEvidenceComplete) {
    reasons.push("prior_absorption_independent_evidence_incomplete");
  }
  if (coreAxesAllOverlap && hasDistinctAxis) {
    reasons.push("prior_absorption_scope_swap_only");
  }

  let disposition: PriorAbsorptionDisposition = reportedDisposition;
  if (!assessment || input.duplicateAssessment || !fullTextComplete) {
    disposition = "uncertain";
  } else if (reportedDisposition === "non_overlapping" && !nonOverlapContractComplete) {
    disposition = "uncertain";
    reasons.push("prior_absorption_non_overlap_not_grounded");
  } else if (reportedDisposition === "partially_absorbed" && !partialContractComplete) {
    disposition = "uncertain";
    reasons.push("prior_absorption_partial_comparison_incomplete");
  }

  if (disposition === "absorbed") {
    reasons.push("prior_absorption_absorbed");
  }
  if (disposition === "uncertain") {
    reasons.push("prior_absorption_uncertain");
  }
  const decisionEligible =
    (disposition === "non_overlapping" && nonOverlapContractComplete)
    || (disposition === "partially_absorbed" && partialContractComplete);
  const payload = {
    prior_paper_id: input.priorPaperId,
    reported_disposition: reportedDisposition,
    disposition,
    axes,
    residual_difference: residualDifference,
    falsifiable_comparison: falsifiableComparison,
    independent_evidence_refs: independentEvidenceRefs,
    full_text_evidence_complete: fullTextComplete,
    independent_evidence_complete: independentEvidenceComplete,
    decision_eligible: decisionEligible,
    reason_codes: uniqueStrings(reasons)
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function buildAxisComparison(input: {
  axis: PriorAbsorptionAxis;
  candidateContract: PriorAbsorptionCandidateContract;
  priorPaperId: string;
  candidateEvidenceIds: Set<string>;
  evidenceById: Map<string, PriorAbsorptionEvidenceSeed>;
  assessment?: PriorAbsorptionAxisAssessment;
}): PriorAbsorptionAxisComparison {
  const evidenceRefs = uniqueStrings(input.assessment?.evidence_ids || []).flatMap((evidenceId) => {
    if (!input.candidateEvidenceIds.has(evidenceId)) {
      return [];
    }
    const evidence = input.evidenceById.get(evidenceId);
    const reference = buildEvidenceRef(evidenceId, evidence, input.priorPaperId);
    return reference ? [reference] : [];
  });
  const priorPosition = uniqueStrings(
    evidenceRefs.map((reference) => {
      const evidence = input.evidenceById.get(reference.evidence_id);
      return priorAxisPosition(input.axis, evidence);
    })
  ).join(" | ");
  const payload = {
    axis: input.axis,
    candidate_position: candidateAxisPosition(input.axis, input.candidateContract),
    prior_position: priorPosition,
    relation: input.assessment?.relation || "uncertain",
    evidence_refs: evidenceRefs
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function hydrateIndependentEvidenceRefs(input: {
  evidenceIds: string[];
  candidateEvidenceIds: Set<string>;
  evidenceById: Map<string, PriorAbsorptionEvidenceSeed>;
  linkedPriorPaperIds: string[];
}): PriorAbsorptionEvidenceRef[] {
  const allowedPapers = new Set(input.linkedPriorPaperIds);
  return uniqueStrings(input.evidenceIds).flatMap((evidenceId) => {
    if (!input.candidateEvidenceIds.has(evidenceId)) {
      return [];
    }
    const evidence = input.evidenceById.get(evidenceId);
    const paperId = normalizeText(evidence?.paper_id);
    if (!paperId || !allowedPapers.has(paperId)) {
      return [];
    }
    const reference = buildEvidenceRef(evidenceId, evidence, paperId);
    return reference ? [reference] : [];
  });
}

function buildEvidenceRef(
  evidenceId: string,
  evidence: PriorAbsorptionEvidenceSeed | undefined,
  expectedPaperId: string
): PriorAbsorptionEvidenceRef | undefined {
  const paperId = normalizeText(evidence?.paper_id);
  const evidenceSpan = normalizeText(evidence?.evidence_span);
  if (
    !evidence
    || paperId !== expectedPaperId
    || evidence.source_type !== "full_text"
    || !evidenceSpan
  ) {
    return undefined;
  }
  const payload = {
    evidence_id: evidenceId,
    paper_id: paperId,
    source_type: "full_text" as const,
    evidence_span: evidenceSpan
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function buildPriorAbsorptionCandidateContract(
  candidate: HypothesisCandidate
): PriorAbsorptionCandidateContract {
  const payload = buildCandidateContractPayload(candidate);
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function buildCandidateContractPayload(candidate: HypothesisCandidate) {
  return {
    contribution_object: normalizeText(candidate.contribution_claim) || "",
    method_mechanism: normalizeText(candidate.text) || "",
    data_task_scope: normalizeText(candidate.dataset_task_bench) || "",
    evaluation_protocol: [
      normalizeText(candidate.comparator),
      normalizeText(candidate.primary_metric),
      candidate.effect_criterion ? JSON.stringify(candidate.effect_criterion) : undefined,
      normalizeText(candidate.meaningful_effect)
    ].filter((value): value is string => Boolean(value)).join(" | "),
    claim_ceiling: normalizeText(candidate.minimum_publishable_evidence) || "",
    falsifier: normalizeText(candidate.falsifier) || "",
    comparator: normalizeText(candidate.comparator) || ""
  };
}

function candidateAxisPosition(
  axis: PriorAbsorptionAxis,
  contract: PriorAbsorptionCandidateContract
): string {
  return contract[axis];
}

function priorAxisPosition(
  axis: PriorAbsorptionAxis,
  evidence: PriorAbsorptionEvidenceSeed | undefined
): string {
  if (!evidence) {
    return "";
  }
  if (axis === "contribution_object") {
    return normalizeText(evidence.claim) || "";
  }
  if (axis === "method_mechanism") {
    return normalizeText(evidence.method_slot) || "";
  }
  if (axis === "data_task_scope") {
    return normalizeText(evidence.dataset_slot) || "";
  }
  if (axis === "evaluation_protocol") {
    return uniqueStrings([
      normalizeText(evidence.metric_slot),
      normalizeText(evidence.result_slot)
    ]).join(" | ");
  }
  return normalizeText(evidence.limitation_slot) || "";
}

function validateComparisonIntegrity(
  candidate: PriorAbsorptionCandidate,
  comparison: PriorAbsorptionPriorComparison
): string[] {
  const reasons: string[] = [];
  const prefix = `${candidate.candidate_id}:${comparison.prior_paper_id}`;
  const { content_sha256: comparisonHash, ...comparisonPayload } = comparison;
  if (hashCanonical(comparisonPayload) !== comparisonHash) {
    reasons.push(`prior_absorption_comparison_content_hash_mismatch:${prefix}`);
  }
  if (!stringArraysEqual(
    comparison.axes.map((axis) => axis.axis),
    [...PRIOR_ABSORPTION_AXES]
  )) {
    reasons.push(`prior_absorption_axis_inventory_mismatch:${prefix}`);
  }
  for (const axis of comparison.axes) {
    const { content_sha256: axisHash, ...axisPayload } = axis;
    if (hashCanonical(axisPayload) !== axisHash) {
      reasons.push(`prior_absorption_axis_content_hash_mismatch:${prefix}:${axis.axis}`);
    }
    if (axis.candidate_position !== candidateAxisPosition(axis.axis, candidate.candidate_contract)) {
      reasons.push(`prior_absorption_candidate_axis_binding_mismatch:${prefix}:${axis.axis}`);
    }
    for (const reference of axis.evidence_refs) {
      reasons.push(...validateEvidenceRef(reference, comparison.prior_paper_id, prefix));
    }
  }
  for (const reference of comparison.independent_evidence_refs) {
    reasons.push(...validateEvidenceRef(reference, undefined, prefix));
    if (!candidate.prior_paper_ids.includes(reference.paper_id)) {
      reasons.push(`prior_absorption_independent_ref_prior_unknown:${prefix}`);
    }
  }
  const expectedState = recomputeComparisonState(candidate, comparison);
  if (
    comparison.full_text_evidence_complete !== expectedState.fullTextComplete
    || comparison.independent_evidence_complete !== expectedState.independentComplete
    || comparison.decision_eligible !== expectedState.decisionEligible
    || comparison.disposition !== expectedState.disposition
  ) {
    reasons.push(`prior_absorption_comparison_gate_state_mismatch:${prefix}`);
  }
  return reasons;
}

function validateEvidenceRef(
  reference: PriorAbsorptionEvidenceRef,
  expectedPaperId: string | undefined,
  prefix: string
): string[] {
  const reasons: string[] = [];
  const { content_sha256: referenceHash, ...referencePayload } = reference;
  if (hashCanonical(referencePayload) !== referenceHash) {
    reasons.push(`prior_absorption_evidence_ref_hash_mismatch:${prefix}:${reference.evidence_id}`);
  }
  if (
    reference.source_type !== "full_text"
    || !normalizeText(reference.evidence_span)
    || (expectedPaperId !== undefined && reference.paper_id !== expectedPaperId)
  ) {
    reasons.push(`prior_absorption_evidence_ref_invalid:${prefix}:${reference.evidence_id}`);
  }
  return reasons;
}

function recomputeComparisonState(
  candidate: PriorAbsorptionCandidate,
  comparison: PriorAbsorptionPriorComparison
): {
  disposition: PriorAbsorptionDisposition;
  fullTextComplete: boolean;
  independentComplete: boolean;
  decisionEligible: boolean;
} {
  const fullTextComplete = comparison.axes.every(
    (axis) =>
      Boolean(normalizeText(axis.candidate_position))
      && Boolean(normalizeText(axis.prior_position))
      && axis.evidence_refs.length > 0
      && axis.relation !== "uncertain"
  );
  const independentComplete =
    new Set(comparison.independent_evidence_refs.map((reference) => reference.paper_id)).size >= 2;
  const hasOverlap = comparison.axes.some(
    (axis) =>
      axis.relation === "overlapping"
      || axis.relation === "partially_overlapping"
  );
  const hasDistinct = comparison.axes.some((axis) => axis.relation === "distinct");
  const hasDistinctCoreAxis = comparison.axes.some(
    (axis) =>
      (axis.axis === "method_mechanism"
        || axis.axis === "evaluation_protocol"
        || axis.axis === "claim_ceiling")
      && axis.relation === "distinct"
  );
  const allDistinct = comparison.axes.every((axis) => axis.relation === "distinct");
  const partialComplete =
    hasOverlap
    && hasDistinct
    && hasDistinctCoreAxis
    && Boolean(normalizeText(comparison.residual_difference))
    && Boolean(normalizeText(comparison.falsifiable_comparison))
    && Boolean(normalizeText(candidate.candidate_contract.falsifier))
    && Boolean(normalizeText(candidate.candidate_contract.comparator))
    && independentComplete;
  const nonOverlapComplete = allDistinct && independentComplete;
  let disposition = comparison.reported_disposition;
  if (!fullTextComplete) {
    disposition = "uncertain";
  } else if (disposition === "partially_absorbed" && !partialComplete) {
    disposition = "uncertain";
  } else if (disposition === "non_overlapping" && !nonOverlapComplete) {
    disposition = "uncertain";
  }
  return {
    disposition,
    fullTextComplete,
    independentComplete,
    decisionEligible:
      (disposition === "partially_absorbed" && partialComplete)
      || (disposition === "non_overlapping" && nonOverlapComplete)
  };
}

function recomputeCandidateState(candidate: PriorAbsorptionCandidate): {
  coverageComplete: boolean;
  fullTextComplete: boolean;
  independentComplete: boolean;
  partialComplete: boolean;
  probeEligible: boolean;
} {
  const coverageComplete =
    candidate.prior_paper_ids.length > 0
    && stringArraysEqual(
      candidate.prior_paper_ids,
      candidate.comparisons.map((comparison) => comparison.prior_paper_id)
    );
  const fullTextComplete =
    candidate.comparisons.length > 0
    && candidate.comparisons.every((comparison) => comparison.full_text_evidence_complete);
  const independentComplete =
    candidate.comparisons.length > 0
    && candidate.comparisons.every((comparison) => comparison.independent_evidence_complete);
  const partialComplete = candidate.comparisons.every(
    (comparison) =>
      comparison.reported_disposition !== "partially_absorbed"
      || comparison.disposition === "partially_absorbed"
  );
  return {
    coverageComplete,
    fullTextComplete,
    independentComplete,
    partialComplete,
    probeEligible:
      coverageComplete
      && fullTextComplete
      && independentComplete
      && partialComplete
      && candidate.comparisons.every((comparison) => comparison.decision_eligible)
  };
}

function parseAxisAssessment(value: unknown): PriorAbsorptionAxisAssessment[] {
  if (!isRecord(value)) {
    return [];
  }
  const axis = normalizeAxis(value.axis);
  const relation = normalizeRelation(value.relation);
  if (!axis || !relation || !isStringArray(value.evidence_ids)) {
    return [];
  }
  return [{
    axis,
    relation,
    evidence_ids: uniqueStrings(value.evidence_ids)
  }];
}

function normalizeAxis(value: unknown): PriorAbsorptionAxis | undefined {
  return PRIOR_ABSORPTION_AXES.includes(value as PriorAbsorptionAxis)
    ? value as PriorAbsorptionAxis
    : undefined;
}

function normalizeRelation(value: unknown): PriorAbsorptionAxisRelation | undefined {
  return [
    "overlapping",
    "partially_overlapping",
    "distinct",
    "uncertain"
  ].includes(String(value))
    ? value as PriorAbsorptionAxisRelation
    : undefined;
}

function normalizeDisposition(value: unknown): PriorAbsorptionDisposition | undefined {
  return [
    "absorbed",
    "partially_absorbed",
    "non_overlapping",
    "uncertain"
  ].includes(String(value))
    ? value as PriorAbsorptionDisposition
    : undefined;
}

function assessmentKey(candidateId: string, priorPaperId: string): string {
  return `${candidateId}\u0000${priorPaperId}`;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)])
  );
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isPriorAbsorptionMatrix(value: unknown): value is PriorAbsorptionMatrix {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.schema_version === 1
    && value.artifact_kind === "prior_absorption_matrix"
    && typeof value.run_id === "string"
    && typeof value.research_cycle === "number"
    && Number.isInteger(value.research_cycle)
    && typeof value.generated_at === "string"
    && (
      value.assessment_source === "llm_structured_comparison"
      || value.assessment_source === "unavailable"
    )
    && Array.isArray(value.candidates)
    && value.candidates.every(isPriorAbsorptionCandidate)
    && isSha256(value.content_sha256)
  );
}

function isPriorAbsorptionCandidate(value: unknown): value is PriorAbsorptionCandidate {
  if (!isRecord(value) || !isCandidateContract(value.candidate_contract)) {
    return false;
  }
  return (
    typeof value.candidate_id === "string"
    && isStringArray(value.prior_paper_ids)
    && Array.isArray(value.comparisons)
    && value.comparisons.every(isPriorComparison)
    && typeof value.coverage_complete === "boolean"
    && typeof value.full_text_evidence_complete === "boolean"
    && typeof value.independent_evidence_complete === "boolean"
    && typeof value.partial_comparisons_complete === "boolean"
    && typeof value.probe_eligible === "boolean"
    && isStringArray(value.reason_codes)
    && isSha256(value.content_sha256)
  );
}

function isCandidateContract(value: unknown): value is PriorAbsorptionCandidateContract {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.contribution_object === "string"
    && typeof value.method_mechanism === "string"
    && typeof value.data_task_scope === "string"
    && typeof value.evaluation_protocol === "string"
    && typeof value.claim_ceiling === "string"
    && typeof value.falsifier === "string"
    && typeof value.comparator === "string"
    && isSha256(value.content_sha256)
  );
}

function isPriorComparison(value: unknown): value is PriorAbsorptionPriorComparison {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.prior_paper_id === "string"
    && Boolean(normalizeDisposition(value.reported_disposition))
    && Boolean(normalizeDisposition(value.disposition))
    && Array.isArray(value.axes)
    && value.axes.every(isAxisComparison)
    && (value.residual_difference === undefined || typeof value.residual_difference === "string")
    && (value.falsifiable_comparison === undefined || typeof value.falsifiable_comparison === "string")
    && Array.isArray(value.independent_evidence_refs)
    && value.independent_evidence_refs.every(isEvidenceRef)
    && typeof value.full_text_evidence_complete === "boolean"
    && typeof value.independent_evidence_complete === "boolean"
    && typeof value.decision_eligible === "boolean"
    && isStringArray(value.reason_codes)
    && isSha256(value.content_sha256)
  );
}

function isAxisComparison(value: unknown): value is PriorAbsorptionAxisComparison {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Boolean(normalizeAxis(value.axis))
    && typeof value.candidate_position === "string"
    && typeof value.prior_position === "string"
    && Boolean(normalizeRelation(value.relation))
    && Array.isArray(value.evidence_refs)
    && value.evidence_refs.every(isEvidenceRef)
    && isSha256(value.content_sha256)
  );
}

function isEvidenceRef(value: unknown): value is PriorAbsorptionEvidenceRef {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.evidence_id === "string"
    && typeof value.paper_id === "string"
    && value.source_type === "full_text"
    && typeof value.evidence_span === "string"
    && isSha256(value.content_sha256)
  );
}
