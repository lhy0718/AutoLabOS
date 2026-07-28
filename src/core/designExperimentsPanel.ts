import { ExperimentDesignCandidate } from "./analysis/researchPlanning.js";
import { ObjectiveMetricProfile } from "./objectiveMetric.js";
import { normalizeEstimatorProtocolDeclaration } from "./estimatorProtocol.js";

export type DesignExperimentsPanelReviewerId =
  | "designer"
  | "feasibility_reviewer"
  | "statistical_reviewer"
  | "ops_capacity_planner";

export interface DesignExperimentsPanelReview {
  reviewer_id: DesignExperimentsPanelReviewerId;
  reviewer_label: string;
  candidate_id: string;
  score_1_to_5: number;
  hard_block: boolean;
  summary: string;
  findings: string[];
}

export interface DesignExperimentsPanelCandidateScore {
  candidate_id: string;
  blocked_by: DesignExperimentsPanelReviewerId[];
  feasibility_score: number;
  statistical_score: number;
  ops_fit_score: number;
  evidence_strength_score: number;
  total_score: number;
}

export interface DesignExperimentsPanelSelection {
  selected_candidate_id: string;
  mode: "best_non_blocked" | "all_blocked_fallback";
  rejected_candidate_ids: string[];
  rationale: string[];
  scores: DesignExperimentsPanelCandidateScore[];
}

export interface DesignExperimentsPanelResult {
  evidence_stage: "bounded_probe" | "confirmatory";
  reviews: DesignExperimentsPanelReview[];
  selection: DesignExperimentsPanelSelection;
  selected: ExperimentDesignCandidate;
}

export function runDesignExperimentsPanel(input: {
  candidates: ExperimentDesignCandidate[];
  objectiveProfile: ObjectiveMetricProfile;
  evidenceStage?: "bounded_probe" | "confirmatory";
  requireExecutableEstimator?: boolean;
}): DesignExperimentsPanelResult {
  const evidenceStage = input.evidenceStage || "confirmatory";
  const reviews: DesignExperimentsPanelReview[] = [];

  for (const candidate of input.candidates) {
    reviews.push(buildDesignerReview(candidate));
    reviews.push(buildFeasibilityReview(candidate));
    reviews.push(buildStatisticalReview(
      candidate,
      input.objectiveProfile,
      evidenceStage,
      input.requireExecutableEstimator === true
    ));
    reviews.push(buildOpsCapacityReview(candidate));
  }

  const scores = input.candidates.map((candidate) =>
    buildCandidateScore(candidate, reviews, input.objectiveProfile)
  );
  const nonBlocked = scores.filter((item) => item.blocked_by.length === 0);
  const selectionPool = nonBlocked.length > 0 ? nonBlocked : scores;
  const chosenScore = [...selectionPool].sort(compareScores)[0] || scores[0];
  const selected = input.candidates.find((candidate) => candidate.id === chosenScore?.candidate_id) || input.candidates[0];
  const mode = nonBlocked.length > 0 ? "best_non_blocked" : "all_blocked_fallback";

  return {
    evidence_stage: evidenceStage,
    reviews,
    selection: {
      selected_candidate_id: selected.id,
      mode,
      rejected_candidate_ids: scores
        .filter((item) => item.candidate_id !== selected.id)
        .map((item) => item.candidate_id),
      rationale: buildSelectionRationale(selected, chosenScore, mode),
      scores
    },
    selected
  };
}

function buildDesignerReview(candidate: ExperimentDesignCandidate): DesignExperimentsPanelReview {
  const datasetsDeclared = isCandidateFieldDeclared(candidate, "datasets", candidate.datasets.length > 0);
  const metricsDeclared = isCandidateFieldDeclared(candidate, "metrics", candidate.metrics.length > 0);
  const baselinesDeclared = isCandidateFieldDeclared(candidate, "baselines", candidate.baselines.length > 0);
  const implementationDeclared = isCandidateFieldDeclared(
    candidate,
    "implementation_notes",
    candidate.implementation_notes.length > 0
  );
  const evaluationDeclared = isCandidateFieldDeclared(
    candidate,
    "evaluation_steps",
    candidate.evaluation_steps.length > 0
  );
  const completeness =
    (datasetsDeclared ? 1 : 0) +
    (metricsDeclared ? 1 : 0) +
    (baselinesDeclared ? 1 : 0) +
    (implementationDeclared ? 1 : 0) +
    (evaluationDeclared ? 1 : 0);
  return {
    reviewer_id: "designer",
    reviewer_label: "Designer",
    candidate_id: candidate.id,
    score_1_to_5: Math.max(1, Math.min(5, completeness)),
    hard_block: false,
    summary:
      completeness >= 4
        ? "The plan is structurally complete enough for panel review."
        : "The plan is underspecified and will likely need reviewer corrections.",
    findings: uniqueStrings([
      candidate.plan_summary,
      datasetsDeclared
        ? `${candidate.datasets.length} dataset(s) were specified.`
        : "No datasets were specified.",
      metricsDeclared
        ? `${candidate.metrics.length} metric(s) were specified.`
        : "No metrics were specified."
    ]).slice(0, 3)
  };
}

function buildFeasibilityReview(candidate: ExperimentDesignCandidate): DesignExperimentsPanelReview {
  const missingDatasets = !isCandidateFieldDeclared(candidate, "datasets", candidate.datasets.length > 0);
  const missingImplementation = !isCandidateFieldDeclared(
    candidate,
    "implementation_notes",
    candidate.implementation_notes.length > 0
  );
  const missingEvaluation = !isCandidateFieldDeclared(
    candidate,
    "evaluation_steps",
    candidate.evaluation_steps.length > 0
  );
  const hardBlock = missingDatasets || missingImplementation || missingEvaluation;
  const rawScore =
    5 -
    (missingDatasets ? 2 : 0) -
    (missingImplementation ? 2 : 0) -
    (missingEvaluation ? 1 : 0) -
    (candidate.risks.length > 4 ? 1 : 0);
  return {
    reviewer_id: "feasibility_reviewer",
    reviewer_label: "Feasibility reviewer",
    candidate_id: candidate.id,
    score_1_to_5: clampScore(rawScore),
    hard_block: hardBlock,
    summary: hardBlock
      ? "The plan is not implementation-ready because essential execution details are missing."
      : "The plan looks feasible enough to hand off for implementation.",
    findings: uniqueStrings([
      missingDatasets ? "Datasets are missing." : "",
      missingImplementation ? "Implementation notes are missing." : "",
      missingEvaluation ? "Evaluation steps are missing." : "",
      candidate.risks[0] || ""
    ]).slice(0, 4)
  };
}

function buildStatisticalReview(
  candidate: ExperimentDesignCandidate,
  objectiveProfile: ObjectiveMetricProfile,
  evidenceStage: "bounded_probe" | "confirmatory",
  requireExecutableEstimator: boolean
): DesignExperimentsPanelReview {
  const preferredMetrics = uniqueStrings([
    objectiveProfile.primaryMetric || "",
    ...(objectiveProfile.preferredMetricKeys || [])
  ]).map(normalizeMetricIdentifier);
  const declaredPrimaryMetric = normalizeMetricIdentifier(candidate.primary_metric);
  const declaredMetrics = candidate.metrics.map(normalizeMetricIdentifier).filter(Boolean);
  const primaryMetricDeclared = isCandidateFieldDeclared(
    candidate,
    "primary_metric",
    declaredPrimaryMetric.length > 0
  ) && declaredPrimaryMetric.length > 0;
  const metricsDeclared = isCandidateFieldDeclared(candidate, "metrics", declaredMetrics.length > 0);
  const baselinesDeclared = isCandidateFieldDeclared(candidate, "baselines", candidate.baselines.length > 0);
  const evaluationDeclared = isCandidateFieldDeclared(
    candidate,
    "evaluation_steps",
    candidate.evaluation_steps.length > 0
  );
  const primaryMetricIncluded = primaryMetricDeclared && metricsDeclared && declaredMetrics.includes(declaredPrimaryMetric);
  const objectiveDeclaresMetric = preferredMetrics.length > 0;
  const primaryMetricMatch = !objectiveDeclaresMetric || preferredMetrics.includes(declaredPrimaryMetric);
  const metricMatch = !objectiveDeclaresMetric || declaredMetrics.some((metric) => preferredMetrics.includes(metric));
  const objectiveDrift = objectiveDeclaresMetric && !primaryMetricMatch;
  const insufficientPaperScaleEvidence = isInsufficientPaperScaleEvidence(candidate);
  const estimatorProtocolValidation = normalizeEstimatorProtocolDeclaration(
    candidate.estimator_protocol
  );
  const executableEstimatorReady = estimatorProtocolValidation.valid;
  const hardBlock =
    !metricsDeclared ||
    !baselinesDeclared ||
    !evaluationDeclared ||
    !primaryMetricDeclared ||
    !primaryMetricIncluded ||
    objectiveDrift ||
    (requireExecutableEstimator && !executableEstimatorReady) ||
    (evidenceStage === "confirmatory" && insufficientPaperScaleEvidence);
  const rawScore =
    2 +
    (metricsDeclared ? 1 : 0) +
    (baselinesDeclared ? 1 : 0) +
    (evaluationDeclared ? 1 : 0) +
    (metricMatch ? 1 : 0) -
    (requireExecutableEstimator && !executableEstimatorReady ? 3 : 0) -
    (objectiveDrift ? 2 : 0) -
    (insufficientPaperScaleEvidence ? 3 : 0);
  return {
    reviewer_id: "statistical_reviewer",
    reviewer_label: "Statistical reviewer",
    candidate_id: candidate.id,
    score_1_to_5: clampScore(rawScore),
    hard_block: hardBlock,
    summary: hardBlock
      ? insufficientPaperScaleEvidence && evidenceStage === "confirmatory"
        ? "The plan is explicitly limited to screening evidence and cannot support the requested paper-scale claim."
        : requireExecutableEstimator && !executableEstimatorReady
        ? "The plan has no valid executable estimator protocol, so its comparison cannot be identified before implementation."
        : objectiveDrift
        ? "The declared primary metric does not match the governed objective metric."
        : "The plan cannot support a reliable comparison because its primary metric, metric set, baseline, or evaluation steps are incomplete."
      : metricMatch
        ? "The plan is statistically aligned with the objective metric and comparison requirements."
        : "The plan is viable, but the metric set is only loosely aligned with the objective profile.",
    findings: uniqueStrings([
      insufficientPaperScaleEvidence
        ? evidenceStage === "bounded_probe"
          ? "The candidate is explicitly screening-only; it may run as a bounded probe but cannot support paper-scale claims."
          : "The candidate states a screening-only ceiling or a single-execution limitation, so it cannot serve as paper-scale evidence."
        : "",
      requireExecutableEstimator && !executableEstimatorReady
        ? `Executable estimator protocol is invalid: ${estimatorProtocolValidation.reasons.join(", ")}.`
        : executableEstimatorReady
          ? "Executable estimator protocol passed structural validation."
          : "",
      objectiveDrift
        ? `Declared primary metric ${candidate.primary_metric || "<missing>"} does not match the governed objective metric.`
        : "",
      !primaryMetricDeclared ? "No explicit primary metric was declared." : "",
      primaryMetricDeclared && !primaryMetricIncluded
        ? "The declared primary metric is absent from the metric set."
        : "",
      metricMatch
        ? `Objective-aligned metric found: ${candidate.metrics.find((metric) => preferredMetrics.includes(normalizeMetricIdentifier(metric))) || candidate.primary_metric}.`
        : "No explicit objective-aligned metric was found.",
      baselinesDeclared
        ? `${candidate.baselines.length} baseline(s) were specified.`
        : "No baselines were specified.",
      candidate.evaluation_steps[0] || ""
    ]).slice(0, 3)
  };
}

function isInsufficientPaperScaleEvidence(
  candidate: ExperimentDesignCandidate
): boolean {
  const text = buildCandidateText(candidate);
  const explicitPilotOnly =
    /\b(?:pilot|preflight|screening)\s+ceiling\b/u.test(text) ||
    /\b(?:pilot|preflight)\s+(?:only|stage|record|evidence)\b/u.test(text) ||
    /\b(?:cannot|can\s+not)\s+support\s+(?:the\s+)?[^.!?]{0,72}(?:claim|claims|evidence|conclusion|recommendation)s?\b/u.test(text) ||
    /\b(?:no|not)\s+(?:paper[- ]ready|paper[- ]scale|confirmatory|statistically supported)\b/u.test(text);
  const singleExecutionOnly =
    /\b(?:single|one)[- ](?:run|repeat|replicate|seed|trial)\b/u.test(text) ||
    /\bonly\s+(?:a\s+)?single\s+(?:run|repeat|replicate|seed|trial)\b/u.test(text) ||
    /\b1\s+(?:run|repeat|replicate|seed|trial)\s+per\s+(?:cell|condition|arm|group)\b/u.test(text);
  const repeatedExecution =
    /\b(?:repeated|multiple|replicated|independent)\s+(?:runs?|repeats?|replicates?|seeds?|trials?)\b/u.test(text) ||
    /\bat\s+least\s+(?:[2-9]|two|three|four|five)\s+(?:runs?|repeats?|replicates?|seeds?|trials?)\b/u.test(text);

  return explicitPilotOnly || (singleExecutionOnly && !repeatedExecution);
}

function buildOpsCapacityReview(candidate: ExperimentDesignCandidate): DesignExperimentsPanelReview {
  const datasetLoad = candidate.datasets.length;
  const implementationLoad = candidate.implementation_notes.length;
  const resourceNotesPresent = candidate.resource_notes.length > 0;
  const hardBlock = datasetLoad > 6 || (!resourceNotesPresent && datasetLoad > 3);
  const rawScore =
    5 -
    (datasetLoad > 4 ? 1 : 0) -
    (datasetLoad > 6 ? 2 : 0) -
    (implementationLoad > 6 ? 1 : 0) -
    (!resourceNotesPresent ? 1 : 0);
  return {
    reviewer_id: "ops_capacity_planner",
    reviewer_label: "Ops-capacity planner",
    candidate_id: candidate.id,
    score_1_to_5: clampScore(rawScore),
    hard_block: hardBlock,
    summary: hardBlock
      ? "The plan is oversized for the declared execution capacity."
      : "The plan is operationally bounded by its declared datasets, implementation steps, and resource notes.",
    findings: uniqueStrings([
      resourceNotesPresent ? candidate.resource_notes[0] || "" : "No resource notes were specified.",
      "Implementation steps are explicitly declared.",
      datasetLoad > 0 ? `${datasetLoad} dataset(s) are in scope.` : "No datasets are in scope."
    ]).slice(0, 3)
  };
}

function buildCandidateScore(
  candidate: ExperimentDesignCandidate,
  reviews: DesignExperimentsPanelReview[],
  objectiveProfile: ObjectiveMetricProfile
): DesignExperimentsPanelCandidateScore {
  const candidateReviews = reviews.filter((review) => review.candidate_id === candidate.id);
  const feasibilityScore = candidateReviews.find((review) => review.reviewer_id === "feasibility_reviewer")?.score_1_to_5 || 0;
  const statisticalScore = candidateReviews.find((review) => review.reviewer_id === "statistical_reviewer")?.score_1_to_5 || 0;
  const opsFitScore = candidateReviews.find((review) => review.reviewer_id === "ops_capacity_planner")?.score_1_to_5 || 0;
  const blockedBy = candidateReviews
    .filter((review) => review.hard_block)
    .map((review) => review.reviewer_id);
  const evidenceStrengthScore = buildEvidenceStrengthScore(candidate);

  return {
    candidate_id: candidate.id,
    blocked_by: blockedBy,
    feasibility_score: feasibilityScore,
    statistical_score: statisticalScore,
    ops_fit_score: opsFitScore,
    evidence_strength_score: evidenceStrengthScore,
    total_score: Number((feasibilityScore * 0.32 + statisticalScore * 0.32 + opsFitScore * 0.16 + evidenceStrengthScore * 0.2).toFixed(2))
  };
}

function buildEvidenceStrengthScore(
  candidate: ExperimentDesignCandidate
): number {
  const candidateText = buildCandidateText(candidate);
  let score = 3;

  if (/\b(repeat(?:ed)?|replication|replicate|multi[- ]seed|multiple\s+seeds?|at\s+least\s+(?:[3-9]|three|four|five)\s+seeds?|confidence|interval|bootstrap|paired|stability)\b/u.test(candidateText)) {
    score += 1;
  }
  if (/\b(full\s+(?:validation|test|split|grid)|all\s+cells?|complete\s+(?:table|grid)|raw\s+n|sample\s+size|per\s+condition|condition\s+table)\b/u.test(candidateText)) {
    score += 1;
  }
  if (isInsufficientPaperScaleEvidence(candidate)) {
    score -= 2;
  }

  return clampScore(score);
}

function buildCandidateText(candidate: ExperimentDesignCandidate): string {
  return [
    candidate.title,
    candidate.plan_summary,
    candidate.metrics.join(" "),
    candidate.baselines.join(" "),
    candidate.implementation_notes.join(" "),
    candidate.evaluation_steps.join(" "),
    candidate.risks.join(" "),
    candidate.resource_notes.join(" ")
  ].join(" ").toLowerCase().replace(/[_-]+/g, " ");
}

function normalizeMetricIdentifier(value: string | undefined): string {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function isCandidateFieldDeclared(
  candidate: ExperimentDesignCandidate,
  field: keyof NonNullable<ExperimentDesignCandidate["declared_contract"]>,
  fallback: boolean
): boolean {
  return candidate.declared_contract?.[field] ?? fallback;
}

function buildSelectionRationale(
  candidate: ExperimentDesignCandidate,
  score: DesignExperimentsPanelCandidateScore | undefined,
  mode: DesignExperimentsPanelSelection["mode"]
): string[] {
  return uniqueStrings([
    mode === "all_blocked_fallback"
      ? "All candidates were hard-blocked, so the panel selected the least-bad option to preserve a reviewable blocked-plan output."
      : "The panel selected the highest-scoring non-blocked candidate.",
    score
      ? `Scores - feasibility ${score.feasibility_score}, statistics ${score.statistical_score}, ops ${score.ops_fit_score}, evidence ${score.evidence_strength_score}.`
      : "",
    `Selected design: ${candidate.title}.`
  ]).slice(0, 3);
}

function compareScores(
  left: DesignExperimentsPanelCandidateScore,
  right: DesignExperimentsPanelCandidateScore
): number {
  return (
    right.total_score - left.total_score ||
    left.blocked_by.length - right.blocked_by.length ||
    right.statistical_score - left.statistical_score ||
    right.evidence_strength_score - left.evidence_strength_score ||
    left.candidate_id.localeCompare(right.candidate_id)
  );
}

function clampScore(value: number): number {
  return Math.max(1, Math.min(5, Math.round(value)));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
