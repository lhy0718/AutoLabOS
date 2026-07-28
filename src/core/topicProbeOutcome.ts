import {
  validateActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "./activeTopicProbeContract.js";
import type {
  CandidateMetricScale,
  EffectCriterionScale
} from "./effectCriterion.js";
import { readCandidateObjectiveProfileBinding } from "./effectCriterion.js";
import {
  buildTopicProbeExecutionBinding,
  type TopicProbeExecutionBinding
} from "./experimentGovernance.js";
import { hashCanonical } from "./researchFunnel.js";
import {
  resolvePrimaryResultsArtifactComparison,
  type AnalysisReport
} from "./resultAnalysis.js";

export type TopicProbeOutcomeDisposition =
  | "promote_to_confirmatory"
  | "reject_candidate"
  | "repeat_probe"
  | "blocked_invalid_evidence";

export type TopicProbeOutcomeNextAction =
  | "start_confirmatory_run"
  | "try_deferred_candidate"
  | "refresh_topic_portfolio"
  | "repeat_bounded_probe"
  | "repair_probe_evidence";

export type TopicProbeOutcomeReasonCode =
  | "primary_comparison_binding_missing"
  | "primary_comparison_binding_mismatch"
  | "primary_treatment_binding_mismatch"
  | "primary_reference_binding_mismatch"
  | "dataset_task_scope_binding_mismatch"
  | "candidate_contract_binding_mismatch"
  | "results_plan_binding_missing"
  | "primary_effect_binding_mismatch"
  | "primary_metric_binding_mismatch"
  | "primary_metric_direction_mismatch"
  | "primary_metric_unit_mismatch"
  | "executed_trial_count_invalid"
  | "cached_trial_count_invalid"
  | "fresh_executed_trials_missing"
  | "high_severity_failure_present"
  | "hypothesis_support_missing"
  | "hypothesis_not_supported"
  | "effect_floor_not_met"
  | "fresh_trial_count_below_confirmatory_floor"
  | "primary_metric_confidence_interval_missing"
  | "primary_effect_confidence_interval_binding_mismatch"
  | "primary_effect_confidence_interval_sample_invalid"
  | "primary_effect_confidence_interval_floor_not_met"
  | "confirmatory_gate_satisfied";

export interface TopicProbeOutcomeDecision {
  schema_version: 1;
  artifact_kind: "topic_probe_outcome_decision";
  run_id: string;
  research_cycle: number;
  candidate_id: string;
  topic_id: string;
  contract_content_sha256: string;
  primary_comparison_id: string | null;
  primary_metric: string;
  observed_delta: number | null;
  directed_delta: number | null;
  required_magnitude: number;
  executed_trials: number;
  cached_trials: number;
  primary_metric_ci_present: boolean;
  primary_effect_ci_directed_bound: number | null;
  primary_effect_ci_criterion_met: boolean;
  disposition: TopicProbeOutcomeDisposition;
  reason_codes: TopicProbeOutcomeReasonCode[];
  evidence_refs: string[];
  next_action: TopicProbeOutcomeNextAction;
  content_sha256: string;
}

export interface TopicProbeOutcomeDecisionValidationContext {
  expectedRunId?: string;
  expectedResearchCycle?: number;
  contract?: ActiveTopicProbeContract;
  report?: AnalysisReport;
}

export interface TopicProbeOutcomeDecisionValidation {
  measured: boolean;
  valid: boolean;
  reasons: string[];
  decision?: TopicProbeOutcomeDecision;
}

const TOPIC_PROBE_OUTCOME_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "run_id",
  "research_cycle",
  "candidate_id",
  "topic_id",
  "contract_content_sha256",
  "primary_comparison_id",
  "primary_metric",
  "observed_delta",
  "directed_delta",
  "required_magnitude",
  "executed_trials",
  "cached_trials",
  "primary_metric_ci_present",
  "primary_effect_ci_directed_bound",
  "primary_effect_ci_criterion_met",
  "disposition",
  "reason_codes",
  "evidence_refs",
  "next_action",
  "content_sha256"
]);

const REASON_CODES = new Set<TopicProbeOutcomeReasonCode>([
  "primary_comparison_binding_missing",
  "primary_comparison_binding_mismatch",
  "primary_treatment_binding_mismatch",
  "primary_reference_binding_mismatch",
  "dataset_task_scope_binding_mismatch",
  "candidate_contract_binding_mismatch",
  "results_plan_binding_missing",
  "primary_effect_binding_mismatch",
  "primary_metric_binding_mismatch",
  "primary_metric_direction_mismatch",
  "primary_metric_unit_mismatch",
  "executed_trial_count_invalid",
  "cached_trial_count_invalid",
  "fresh_executed_trials_missing",
  "high_severity_failure_present",
  "hypothesis_support_missing",
  "hypothesis_not_supported",
  "effect_floor_not_met",
  "fresh_trial_count_below_confirmatory_floor",
  "primary_metric_confidence_interval_missing",
  "primary_effect_confidence_interval_binding_mismatch",
  "primary_effect_confidence_interval_sample_invalid",
  "primary_effect_confidence_interval_floor_not_met",
  "confirmatory_gate_satisfied"
]);

const DERIVED_FIELDS: Array<Exclude<keyof TopicProbeOutcomeDecision, "content_sha256">> = [
  "schema_version",
  "artifact_kind",
  "run_id",
  "research_cycle",
  "candidate_id",
  "topic_id",
  "contract_content_sha256",
  "primary_comparison_id",
  "primary_metric",
  "observed_delta",
  "directed_delta",
  "required_magnitude",
  "executed_trials",
  "cached_trials",
  "primary_metric_ci_present",
  "primary_effect_ci_directed_bound",
  "primary_effect_ci_criterion_met",
  "disposition",
  "reason_codes",
  "evidence_refs",
  "next_action"
];

export function buildTopicProbeOutcomeDecision(input: {
  contract: ActiveTopicProbeContract;
  report: AnalysisReport;
}): TopicProbeOutcomeDecision {
  assertValidContract(input.contract);

  const contract = input.contract;
  const report = input.report;
  const blockingReasons: TopicProbeOutcomeReasonCode[] = [];
  const expectedBinding = buildTopicProbeExecutionBinding({
    candidateId: contract.candidate_id,
    candidateContentSha256: contract.candidate_content_sha256,
    comparator: contract.comparator,
    datasetTaskScope: contract.dataset_task_bench
  });
  blockingReasons.push(
    ...resolveCandidateContractBindingReasons(contract, report),
    ...resolveResultsPlanBindingReasons(contract, report, expectedBinding)
  );
  const explicitPrimaryId = hasText(report.primary_comparison_id)
    ? report.primary_comparison_id
    : undefined;
  if (explicitPrimaryId && explicitPrimaryId !== expectedBinding.primary_comparison_id) {
    blockingReasons.push("primary_comparison_binding_mismatch");
  }
  const primaryComparison = explicitPrimaryId
    ? resolvePrimaryResultsArtifactComparison(report.results_artifact, explicitPrimaryId)
    : undefined;
  if (!primaryComparison) {
    blockingReasons.push("primary_comparison_binding_missing");
  } else {
    if (primaryComparison.subject_series.id !== expectedBinding.subject_series_id) {
      blockingReasons.push("primary_treatment_binding_mismatch");
    }
    if (primaryComparison.reference_series.id !== expectedBinding.reference_series_id) {
      blockingReasons.push("primary_reference_binding_mismatch");
    }
    if (!primaryComparisonScopesMatch(report, primaryComparison.comparison.id, expectedBinding)) {
      blockingReasons.push("dataset_task_scope_binding_mismatch");
    }
  }

  const expectedMetricDirection = contract.metric_direction === "maximize"
    ? "higher_better"
    : "lower_better";
  const metricDefinition = primaryComparison
    ? report.results_artifact.metrics.find((item) => item.id === primaryComparison.metric.id)
    : undefined;
  if (primaryComparison && primaryComparison.metric.id !== contract.primary_metric) {
    blockingReasons.push("primary_metric_binding_mismatch");
  }
  if (primaryComparison && primaryComparison.metric.direction !== expectedMetricDirection) {
    blockingReasons.push("primary_metric_direction_mismatch");
  }
  if (
    primaryComparison
    && (metricDefinition?.unit?.trim() || undefined) !== contract.metric_unit
  ) {
    blockingReasons.push("primary_metric_unit_mismatch");
  }

  const executedTrials = readTrialCount(
    report.statistical_summary?.executed_trials,
    "executed_trial_count_invalid",
    blockingReasons
  );
  const cachedTrials = readTrialCount(
    report.statistical_summary?.cached_trials,
    "cached_trial_count_invalid",
    blockingReasons
  );
  if (executedTrials === 0) {
    blockingReasons.push("fresh_executed_trials_missing");
  }

  const highFailureIndexes = (report.failure_taxonomy || [])
    .map((failure, index) => ({ failure, index }))
    .filter(({ failure }) => failure.severity === "high");
  if (highFailureIndexes.length > 0) {
    blockingReasons.push("high_severity_failure_present");
  }

  const comparisonBound = !blockingReasons.some((reason) =>
    reason === "primary_comparison_binding_missing"
    || reason === "primary_comparison_binding_mismatch"
    || reason === "primary_treatment_binding_mismatch"
    || reason === "primary_reference_binding_mismatch"
    || reason === "dataset_task_scope_binding_mismatch"
    || reason === "candidate_contract_binding_mismatch"
    || reason === "results_plan_binding_missing"
  );
  const metricBound = Boolean(
    comparisonBound
    && primaryComparison
    && primaryComparison.metric.id === contract.primary_metric
    && primaryComparison.metric.direction === expectedMetricDirection
    && (metricDefinition?.unit?.trim() || undefined) === contract.metric_unit
  );
  const observedDelta = metricBound ? primaryComparison!.delta : null;
  const effectScaleDelta = observedDelta === null
    ? null
    : convertScale(observedDelta, contract.metric_scale, contract.effect_criterion.scale);
  const directedDelta = effectScaleDelta === null
    ? null
    : contract.metric_direction === "maximize"
      ? effectScaleDelta
      : -effectScaleDelta;
  const floorMet = directedDelta === null
    ? false
    : meetsEffectCriterion(
        directedDelta,
        contract.effect_criterion.magnitude,
        contract.effect_criterion.inclusive
      );

  const hypothesisSupported = metricBound
    ? primaryComparison?.hypothesis_supported
    : undefined;
  if (metricBound && hypothesisSupported === undefined) {
    blockingReasons.push("hypothesis_support_missing");
  }

  const matchingEffectIndexes = (report.statistical_summary?.effect_estimates || [])
    .map((effect, index) => ({ effect, index }))
    .filter(({ effect }) =>
      effect.comparison_id === expectedBinding.primary_comparison_id
      && effect.metric_key === contract.primary_metric
      && observedDelta !== null
      && numbersEqual(effect.delta, observedDelta)
    )
    .map(({ index }) => index);
  if (metricBound && matchingEffectIndexes.length === 0) {
    blockingReasons.push("primary_effect_binding_mismatch");
  }

  const declaredIntervals = report.statistical_summary?.confidence_intervals || [];
  const primaryMetricIntervals = declaredIntervals
    .map((interval, index) => ({ interval, index }))
    .filter(({ interval }) => interval.metric_key === contract.primary_metric);
  const boundEffectIntervals = primaryMetricIntervals.filter(({ interval }) =>
    interval.comparison_id === expectedBinding.primary_comparison_id
    && interval.estimand === "effect_delta"
    && interval.metric_scale === contract.metric_scale
    && interval.trial_source === "fresh_executed"
  );
  if (metricBound && primaryMetricIntervals.length > 0 && boundEffectIntervals.length === 0) {
    blockingReasons.push("primary_effect_confidence_interval_binding_mismatch");
  }
  const validBoundEffectIntervals = boundEffectIntervals.filter(({ interval }) => {
    const sampleSize = interval.sample_size;
    return Number.isFinite(interval.lower)
      && Number.isFinite(interval.upper)
      && interval.lower <= interval.upper
      && Number.isFinite(interval.level)
      && interval.level >= 0.95
      && interval.level <= 1
      && Number.isInteger(sampleSize)
      && Number(sampleSize) >= 2
      && Number(sampleSize) <= executedTrials
      && observedDelta !== null
      && interval.lower <= observedDelta + 1e-12
      && interval.upper >= observedDelta - 1e-12;
  });
  if (metricBound && boundEffectIntervals.length > validBoundEffectIntervals.length) {
    blockingReasons.push("primary_effect_confidence_interval_sample_invalid");
  }
  const matchingCiIndexes = validBoundEffectIntervals.map(({ index }) => index);
  const primaryMetricCiPresent = metricBound
    && matchingEffectIndexes.length > 0
    && validBoundEffectIntervals.length > 0;
  const directedCiBounds = validBoundEffectIntervals
    .map(({ interval }) => {
      const conservativeEndpoint = contract.metric_direction === "maximize"
        ? interval.lower
        : interval.upper;
      const converted = convertScale(
        conservativeEndpoint,
        contract.metric_scale,
        contract.effect_criterion.scale
      );
      if (converted === null) {
        return null;
      }
      return contract.metric_direction === "maximize" ? converted : -converted;
    })
    .filter((value): value is number => value !== null);
  const primaryEffectCiDirectedBound = directedCiBounds.length > 0
    ? Math.min(...directedCiBounds)
    : null;
  const primaryEffectCiCriterionMet = primaryEffectCiDirectedBound !== null
    && meetsEffectCriterion(
      primaryEffectCiDirectedBound,
      contract.effect_criterion.magnitude,
      contract.effect_criterion.inclusive
    );

  let disposition: TopicProbeOutcomeDisposition;
  let reasonCodes: TopicProbeOutcomeReasonCode[];
  let nextAction: TopicProbeOutcomeNextAction;
  if (blockingReasons.length > 0) {
    disposition = "blocked_invalid_evidence";
    reasonCodes = uniqueReasonCodes(blockingReasons);
    nextAction = "repair_probe_evidence";
  } else if (hypothesisSupported === false || !floorMet) {
    disposition = "reject_candidate";
    reasonCodes = uniqueReasonCodes([
      ...(hypothesisSupported === false ? ["hypothesis_not_supported" as const] : []),
      ...(!floorMet ? ["effect_floor_not_met" as const] : [])
    ]);
    nextAction = contract.deferred_candidate_ids.length > 0
      ? "try_deferred_candidate"
      : "refresh_topic_portfolio";
  } else if (executedTrials < 2 || !primaryMetricCiPresent || !primaryEffectCiCriterionMet) {
    disposition = "repeat_probe";
    reasonCodes = uniqueReasonCodes([
      ...(executedTrials < 2
        ? ["fresh_trial_count_below_confirmatory_floor" as const]
        : []),
      ...(!primaryMetricCiPresent
        ? ["primary_metric_confidence_interval_missing" as const]
        : []),
      ...(primaryMetricCiPresent && !primaryEffectCiCriterionMet
        ? ["primary_effect_confidence_interval_floor_not_met" as const]
        : [])
    ]);
    nextAction = "repeat_bounded_probe";
  } else {
    disposition = "promote_to_confirmatory";
    reasonCodes = ["confirmatory_gate_satisfied"];
    nextAction = "start_confirmatory_run";
  }

  const evidenceRefs = uniqueStrings([
    "active_topic_probe_contract.json#/content_sha256",
    "result_analysis.json#/primary_comparison_id",
    "result_analysis.json#/results_plan/primary_comparison_id",
    "result_analysis.json#/results_plan/required_comparisons/0",
    "result_analysis.json#/statistical_summary/executed_trials",
    "result_analysis.json#/statistical_summary/cached_trials",
    ...(primaryComparison?.evidence_links || []),
    ...matchingCiIndexes.map(
      (index) => `result_analysis.json#/statistical_summary/confidence_intervals/${index}`
    ),
    ...matchingEffectIndexes.map(
      (index) => `result_analysis.json#/statistical_summary/effect_estimates/${index}`
    ),
    ...highFailureIndexes.map(
      ({ index }) => `result_analysis.json#/failure_taxonomy/${index}`
    )
  ]);

  const payload: Omit<TopicProbeOutcomeDecision, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "topic_probe_outcome_decision",
    run_id: contract.run_id,
    research_cycle: contract.research_cycle,
    candidate_id: contract.candidate_id,
    topic_id: contract.topic_id,
    contract_content_sha256: contract.content_sha256,
    primary_comparison_id: explicitPrimaryId || null,
    primary_metric: contract.primary_metric,
    observed_delta: observedDelta,
    directed_delta: directedDelta,
    required_magnitude: contract.effect_criterion.magnitude,
    executed_trials: executedTrials,
    cached_trials: cachedTrials,
    primary_metric_ci_present: primaryMetricCiPresent,
    primary_effect_ci_directed_bound: primaryEffectCiDirectedBound,
    primary_effect_ci_criterion_met: primaryEffectCiCriterionMet,
    disposition,
    reason_codes: reasonCodes,
    evidence_refs: evidenceRefs,
    next_action: nextAction
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function validateTopicProbeOutcomeDecision(
  raw: string,
  context: TopicProbeOutcomeDecisionValidationContext = {}
): TopicProbeOutcomeDecisionValidation {
  if (!raw.trim()) {
    return { measured: false, valid: false, reasons: ["topic_probe_outcome_decision_missing"] };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      measured: true,
      valid: false,
      reasons: ["topic_probe_outcome_decision_invalid_json"]
    };
  }
  if (!isTopicProbeOutcomeDecision(value)) {
    return {
      measured: true,
      valid: false,
      reasons: ["topic_probe_outcome_decision_schema_invalid"]
    };
  }

  const reasons: string[] = [];
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("topic_probe_outcome_decision_content_hash_mismatch");
  }
  if (context.expectedRunId !== undefined && value.run_id !== context.expectedRunId) {
    reasons.push("topic_probe_outcome_decision_run_id_mismatch");
  }
  if (
    context.expectedResearchCycle !== undefined
    && value.research_cycle !== context.expectedResearchCycle
  ) {
    reasons.push("topic_probe_outcome_decision_research_cycle_mismatch");
  }

  const contract = context.contract;
  let contractValid = false;
  if (contract) {
    const contractValidation = validateActiveTopicProbeContract(JSON.stringify(contract), {
      expectedRunId: context.expectedRunId,
      expectedResearchCycle: context.expectedResearchCycle
    });
    contractValid = contractValidation.valid;
    for (const reason of contractValidation.reasons) {
      reasons.push(`topic_probe_outcome_decision_contract_invalid:${reason}`);
    }
    const expectedBindings: Array<[keyof TopicProbeOutcomeDecision, unknown]> = [
      ["run_id", contract.run_id],
      ["research_cycle", contract.research_cycle],
      ["candidate_id", contract.candidate_id],
      ["topic_id", contract.topic_id],
      ["contract_content_sha256", contract.content_sha256],
      ["primary_metric", contract.primary_metric],
      ["required_magnitude", contract.effect_criterion.magnitude]
    ];
    for (const [field, expected] of expectedBindings) {
      if (!valuesEqual(value[field], expected)) {
        reasons.push(`topic_probe_outcome_decision_contract_binding_mismatch:${String(field)}`);
      }
    }
    if (
      value.disposition === "reject_candidate"
      && value.next_action !== (
        contract.deferred_candidate_ids.length > 0
          ? "try_deferred_candidate"
          : "refresh_topic_portfolio"
      )
    ) {
      reasons.push("topic_probe_outcome_decision_contract_binding_mismatch:next_action");
    }
  }

  if (contract && contractValid && context.report) {
    const expected = buildTopicProbeOutcomeDecision({
      contract,
      report: context.report
    });
    for (const field of DERIVED_FIELDS) {
      if (!valuesEqual(value[field], expected[field])) {
        reasons.push(`topic_probe_outcome_decision_report_binding_mismatch:${String(field)}`);
      }
    }
  }

  return {
    measured: true,
    valid: reasons.length === 0,
    reasons: uniqueStrings(reasons),
    decision: value
  };
}

function assertValidContract(contract: ActiveTopicProbeContract): void {
  const validation = validateActiveTopicProbeContract(JSON.stringify(contract), {
    expectedRunId: contract.run_id,
    expectedResearchCycle: contract.research_cycle
  });
  if (!validation.valid) {
    throw new Error(
      `topic_probe_outcome_active_contract_invalid:${validation.reasons.join(",")}`
    );
  }
}

function resolveCandidateContractBindingReasons(
  contract: ActiveTopicProbeContract,
  report: AnalysisReport
): TopicProbeOutcomeReasonCode[] {
  const reportBinding = readCandidateObjectiveProfileBinding({
    candidate_contract: report.objective_metric?.profile?.candidate_contract
  });
  if (!reportBinding) {
    return ["candidate_contract_binding_mismatch"];
  }
  const exact =
    reportBinding.candidate_id === contract.candidate_id
    && reportBinding.objective_raw === contract.objective_raw
    && reportBinding.primary_metric === contract.primary_metric
    && reportBinding.metric_unit === contract.metric_unit
    && reportBinding.metric_scale === contract.metric_scale
    && reportBinding.metric_direction === contract.metric_direction
    && reportBinding.comparator === contract.comparator
    && valuesEqual(reportBinding.effect_criterion, contract.effect_criterion);
  return exact ? [] : ["candidate_contract_binding_mismatch"];
}

function resolveResultsPlanBindingReasons(
  contract: ActiveTopicProbeContract,
  report: AnalysisReport,
  binding: TopicProbeExecutionBinding
): TopicProbeOutcomeReasonCode[] {
  const plan = report.results_plan;
  if (!plan) {
    return ["results_plan_binding_missing"];
  }

  const reasons: TopicProbeOutcomeReasonCode[] = [];
  if (plan.primary_comparison_id !== binding.primary_comparison_id) {
    reasons.push("primary_comparison_binding_mismatch");
  }
  const requiredComparisons = plan.required_comparisons || [];
  const primaryRequirement = requiredComparisons.find(
    (comparison) => comparison.id === binding.primary_comparison_id
  );
  if (requiredComparisons.length !== 1 || !primaryRequirement) {
    reasons.push("primary_comparison_binding_mismatch");
  }
  if (
    !primaryRequirement
    || primaryRequirement.subject_series_id !== binding.subject_series_id
  ) {
    reasons.push("primary_treatment_binding_mismatch");
  }
  if (
    !primaryRequirement
    || primaryRequirement.reference_series_id !== binding.reference_series_id
  ) {
    reasons.push("primary_reference_binding_mismatch");
  }
  if (
    !primaryRequirement
    || primaryRequirement.metric_id !== contract.primary_metric
  ) {
    reasons.push("primary_metric_binding_mismatch");
  }
  if (
    !primaryRequirement
    || !valuesEqual(primaryRequirement.scope || {}, binding.observation_scope)
  ) {
    reasons.push("dataset_task_scope_binding_mismatch");
  }

  const requiredSeries = plan.required_series || [];
  const subjectSeries = requiredSeries.find((series) => series.id === binding.subject_series_id);
  const referenceSeries = requiredSeries.find((series) => series.id === binding.reference_series_id);
  if (requiredSeries.length !== 2 || subjectSeries?.role !== "primary") {
    reasons.push("primary_treatment_binding_mismatch");
  }
  if (requiredSeries.length !== 2 || referenceSeries?.role !== "baseline") {
    reasons.push("primary_reference_binding_mismatch");
  }

  const effect = plan.primary_effect_criterion;
  if (
    !effect
    || effect.comparison_id !== binding.primary_comparison_id
    || effect.metric_id !== contract.primary_metric
    || effect.metric_scale !== contract.metric_scale
    || effect.direction !== contract.metric_direction
    || !valuesEqual(effect.effect_criterion, contract.effect_criterion)
  ) {
    reasons.push("primary_effect_binding_mismatch");
  }
  return uniqueReasonCodes(reasons);
}

function primaryComparisonScopesMatch(
  report: AnalysisReport,
  comparisonId: string,
  binding: TopicProbeExecutionBinding
): boolean {
  const comparison = report.results_artifact.comparisons.find((item) => item.id === comparisonId);
  if (!comparison) {
    return false;
  }
  const subject = report.results_artifact.observations.find(
    (item) => item.id === comparison.subject_observation_id
  );
  const reference = report.results_artifact.observations.find(
    (item) => item.id === comparison.reference_observation_id
  );
  return Boolean(
    subject
    && reference
    && valuesEqual(subject.scope, binding.observation_scope)
    && valuesEqual(reference.scope, binding.observation_scope)
  );
}

function numbersEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-12;
}

function meetsEffectCriterion(
  value: number,
  magnitude: number,
  inclusive: boolean
): boolean {
  if (inclusive) {
    return value > magnitude || numbersEqual(value, magnitude);
  }
  return value > magnitude && !numbersEqual(value, magnitude);
}

function readTrialCount(
  value: unknown,
  invalidReason: Extract<
    TopicProbeOutcomeReasonCode,
    "executed_trial_count_invalid" | "cached_trial_count_invalid"
  >,
  reasons: TopicProbeOutcomeReasonCode[]
): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isInteger(value) || Number(value) < 0) {
    reasons.push(invalidReason);
    return 0;
  }
  return Number(value);
}

function convertScale(
  value: number,
  from: CandidateMetricScale,
  to: EffectCriterionScale
): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (from === to) {
    return value;
  }
  if (from === "raw" || to === "raw") {
    return null;
  }
  const fromHundred = from === "percent" || from === "percentage_point";
  const toHundred = to === "percent" || to === "percentage_point";
  if (fromHundred && to === "proportion") {
    return value / 100;
  }
  if (from === "proportion" && toHundred) {
    return value * 100;
  }
  return fromHundred && toHundred ? value : null;
}

function isTopicProbeOutcomeDecision(value: unknown): value is TopicProbeOutcomeDecision {
  if (!isRecord(value) || !hasOnlyKnownFields(value, TOPIC_PROBE_OUTCOME_FIELDS)) {
    return false;
  }
  return value.schema_version === 1
    && value.artifact_kind === "topic_probe_outcome_decision"
    && hasText(value.run_id)
    && Number.isInteger(value.research_cycle)
    && Number(value.research_cycle) >= 0
    && hasText(value.candidate_id)
    && hasText(value.topic_id)
    && isSha256(value.contract_content_sha256)
    && (value.primary_comparison_id === null || hasText(value.primary_comparison_id))
    && hasText(value.primary_metric)
    && isFiniteNumberOrNull(value.observed_delta)
    && isFiniteNumberOrNull(value.directed_delta)
    && (value.observed_delta === null) === (value.directed_delta === null)
    && isNonNegativeFiniteNumber(value.required_magnitude)
    && isNonNegativeInteger(value.executed_trials)
    && isNonNegativeInteger(value.cached_trials)
    && typeof value.primary_metric_ci_present === "boolean"
    && isFiniteNumberOrNull(value.primary_effect_ci_directed_bound)
    && typeof value.primary_effect_ci_criterion_met === "boolean"
    && isDisposition(value.disposition)
    && isReasonCodeArray(value.reason_codes)
    && reasonCodesMatchDisposition(value.disposition, value.reason_codes)
    && isUniqueStringArray(value.evidence_refs)
    && value.evidence_refs.length > 0
    && isNextAction(value.next_action)
    && nextActionMatchesDisposition(value.disposition, value.next_action)
    && isSha256(value.content_sha256);
}

function isDisposition(value: unknown): value is TopicProbeOutcomeDisposition {
  return value === "promote_to_confirmatory"
    || value === "reject_candidate"
    || value === "repeat_probe"
    || value === "blocked_invalid_evidence";
}

function isNextAction(value: unknown): value is TopicProbeOutcomeNextAction {
  return value === "start_confirmatory_run"
    || value === "try_deferred_candidate"
    || value === "refresh_topic_portfolio"
    || value === "repeat_bounded_probe"
    || value === "repair_probe_evidence";
}

function nextActionMatchesDisposition(
  disposition: TopicProbeOutcomeDisposition,
  nextAction: TopicProbeOutcomeNextAction
): boolean {
  if (disposition === "promote_to_confirmatory") {
    return nextAction === "start_confirmatory_run";
  }
  if (disposition === "reject_candidate") {
    return nextAction === "try_deferred_candidate" || nextAction === "refresh_topic_portfolio";
  }
  if (disposition === "repeat_probe") {
    return nextAction === "repeat_bounded_probe";
  }
  return nextAction === "repair_probe_evidence";
}

function reasonCodesMatchDisposition(
  disposition: TopicProbeOutcomeDisposition,
  reasonCodes: TopicProbeOutcomeReasonCode[]
): boolean {
  const allowed = disposition === "promote_to_confirmatory"
    ? new Set<TopicProbeOutcomeReasonCode>(["confirmatory_gate_satisfied"])
    : disposition === "reject_candidate"
      ? new Set<TopicProbeOutcomeReasonCode>([
          "hypothesis_not_supported",
          "effect_floor_not_met"
        ])
      : disposition === "repeat_probe"
        ? new Set<TopicProbeOutcomeReasonCode>([
            "fresh_trial_count_below_confirmatory_floor",
            "primary_metric_confidence_interval_missing",
            "primary_effect_confidence_interval_floor_not_met"
          ])
        : new Set<TopicProbeOutcomeReasonCode>([
            "primary_comparison_binding_missing",
            "primary_comparison_binding_mismatch",
            "primary_treatment_binding_mismatch",
            "primary_reference_binding_mismatch",
            "dataset_task_scope_binding_mismatch",
            "candidate_contract_binding_mismatch",
            "results_plan_binding_missing",
            "primary_effect_binding_mismatch",
            "primary_metric_binding_mismatch",
            "primary_metric_direction_mismatch",
            "primary_metric_unit_mismatch",
            "executed_trial_count_invalid",
            "cached_trial_count_invalid",
            "fresh_executed_trials_missing",
            "high_severity_failure_present",
            "hypothesis_support_missing",
            "primary_effect_confidence_interval_binding_mismatch",
            "primary_effect_confidence_interval_sample_invalid"
          ]);
  return reasonCodes.every((reason) => allowed.has(reason));
}

function isReasonCodeArray(value: unknown): value is TopicProbeOutcomeReasonCode[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "string" && REASON_CODES.has(item as TopicProbeOutcomeReasonCode))
    && new Set(value).size === value.length;
}

function isUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => hasText(item))
    && new Set(value).size === value.length;
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKnownFields(value: object, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uniqueReasonCodes(
  values: TopicProbeOutcomeReasonCode[]
): TopicProbeOutcomeReasonCode[] {
  return [...new Set(values)];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
