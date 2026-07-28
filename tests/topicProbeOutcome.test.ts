import { describe, expect, it } from "vitest";

import type { ActiveTopicProbeContract } from "../src/core/activeTopicProbeContract.js";
import {
  buildCandidateObjectiveRaw,
  buildCandidateObjectiveProfileBinding
} from "../src/core/effectCriterion.js";
import { buildTopicProbeExecutionBinding } from "../src/core/experimentGovernance.js";
import { hashCanonical } from "../src/core/researchFunnel.js";
import type { AnalysisReport } from "../src/core/resultAnalysis.js";
import {
  buildTopicProbeOutcomeDecision,
  validateTopicProbeOutcomeDecision
} from "../src/core/topicProbeOutcome.js";
import {
  makeTopicProbeComputeBudgetDeclaration,
  makeTopicProbeComputeBudgetLimits
} from "./support/topicProbeComputeBudget.js";

function makeContract(input: {
  direction?: "maximize" | "minimize";
  inclusive?: boolean;
  magnitude?: number;
  deferredCandidateIds?: string[];
} = {}): ActiveTopicProbeContract {
  const metricDirection = input.direction ?? "maximize";
  const effectCriterion = {
    basis: "delta_vs_reference" as const,
    magnitude: input.magnitude ?? 0.05,
    scale: "raw" as const,
    inclusive: input.inclusive ?? true
  };
  const objectiveRaw = buildCandidateObjectiveRaw({
    primary_metric: "primary_score",
    metric_unit: "unitless",
    metric_scale: "raw",
    metric_direction: metricDirection,
    comparator: "reference_condition",
    effect_criterion: effectCriterion
  });
  const payload: Omit<ActiveTopicProbeContract, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "active_topic_probe_contract",
    generated_at: "2026-01-01T00:00:00.000Z",
    run_id: "run_probe",
    research_cycle: 2,
    research_mode: "topic_discovery",
    evidence_stage: "bounded_probe",
    selection_status: "probe_only",
    portfolio_content_sha256: "a".repeat(64),
    candidate_id: "candidate_primary",
    topic_id: "topic_primary",
    candidate_content_sha256: "b".repeat(64),
    statement: "A bounded comparison with an explicit practical-effect floor.",
    primary_metric: "primary_score",
    metric_unit: "unitless",
    metric_scale: "raw",
    metric_direction: metricDirection,
    effect_criterion: effectCriterion,
    objective_raw: objectiveRaw,
    comparator: "reference_condition",
    dataset_task_bench: "declared_evaluation_scope",
    falsifier: "The declared primary comparison fails the practical-effect floor.",
    kill_signal: "The matched comparison cannot be executed.",
    local_budget: makeTopicProbeComputeBudgetDeclaration(),
    brief_compute_budget_ceiling: makeTopicProbeComputeBudgetLimits(),
    compute_budget: makeTopicProbeComputeBudgetLimits(),
    deferred_candidate_ids: input.deferredCandidateIds ?? ["candidate_deferred"]
  };
  return { ...payload, content_sha256: hashCanonical(payload) };
}

function makeReport(
  contract: ActiveTopicProbeContract,
  input: {
    delta?: number;
    judgement?: string;
    executedTrials?: number;
    cachedTrials?: number;
    includeCi?: boolean;
    highFailure?: boolean;
    metricId?: string;
    metricDirection?: "higher_better" | "lower_better";
    subjectSeriesId?: string;
    referenceSeriesId?: string;
    observationScope?: Record<string, string>;
    planScope?: Record<string, string>;
    ciComparisonId?: string;
    ciEstimand?: "metric_value" | "effect_delta";
    ciMetricScale?: "raw" | "proportion" | "percent" | "percentage_point";
    ciTrialSource?: "fresh_executed" | "mixed" | "cached";
    ciLower?: number;
    ciUpper?: number;
    ciLevel?: number;
    ciSampleSize?: number;
  } = {}
): AnalysisReport {
  const executionBinding = buildTopicProbeExecutionBinding({
    candidateId: contract.candidate_id,
    candidateContentSha256: contract.candidate_content_sha256,
    comparator: contract.comparator,
    datasetTaskScope: contract.dataset_task_bench
  });
  const metricId = input.metricId ?? contract.primary_metric;
  const delta = input.delta ?? (
    contract.metric_direction === "maximize" ? 0.06 : -0.06
  );
  const referenceValue = 0.5;
  const subjectValue = referenceValue + delta;
  const subjectSeriesId = input.subjectSeriesId ?? executionBinding.subject_series_id;
  const referenceSeriesId = input.referenceSeriesId ?? executionBinding.reference_series_id;
  const observationScope = input.observationScope ?? executionBinding.observation_scope;
  const candidateBinding = buildCandidateObjectiveProfileBinding({
    candidateId: contract.candidate_id,
    primaryMetric: contract.primary_metric,
    metricUnit: contract.metric_unit,
    metricScale: contract.metric_scale,
    metricDirection: contract.metric_direction,
    comparator: contract.comparator,
    effectCriterion: contract.effect_criterion,
    objectiveRaw: contract.objective_raw
  });

  return {
    objective_metric: {
      profile: {
        candidate_contract: candidateBinding
      }
    },
    results_plan: {
      schema_version: "2.0",
      required_metrics: [{
        id: contract.primary_metric,
        label: contract.primary_metric,
        direction: contract.metric_direction === "maximize" ? "higher_better" : "lower_better",
        unit: contract.metric_unit
      }],
      minimum_series_count: 2,
      minimum_comparison_count: 1,
      required_series: [
        { id: executionBinding.subject_series_id, role: "primary" },
        { id: executionBinding.reference_series_id, role: "baseline" }
      ],
      required_comparisons: [{
        id: executionBinding.primary_comparison_id,
        subject_series_id: executionBinding.subject_series_id,
        reference_series_id: executionBinding.reference_series_id,
        metric_id: contract.primary_metric,
        scope: input.planScope ?? executionBinding.observation_scope
      }],
      primary_comparison_id: executionBinding.primary_comparison_id,
      primary_effect_criterion: {
        comparison_id: executionBinding.primary_comparison_id,
        metric_id: contract.primary_metric,
        metric_scale: contract.metric_scale,
        direction: contract.metric_direction,
        effect_criterion: contract.effect_criterion
      }
    },
    primary_comparison_id: executionBinding.primary_comparison_id,
    results_artifact: {
      schema_version: "2.0",
      metrics: [{
        id: metricId,
        label: "Primary score",
        direction: input.metricDirection ?? (
          contract.metric_direction === "maximize" ? "higher_better" : "lower_better"
        ),
        unit: contract.metric_unit
      }],
      series: [
        {
          id: subjectSeriesId,
          label: "Candidate condition",
          role: "primary",
          dimensions: {}
        },
        {
          id: referenceSeriesId,
          label: "Reference condition",
          role: "baseline",
          dimensions: {}
        }
      ],
      observations: [
        {
          id: "observation_candidate",
          series_id: subjectSeriesId,
          metric_id: metricId,
          scope: observationScope,
          value: subjectValue,
          evidence_refs: ["metrics.json#/candidate"]
        },
        {
          id: "observation_reference",
          series_id: referenceSeriesId,
          metric_id: metricId,
          scope: observationScope,
          value: referenceValue,
          evidence_refs: ["metrics.json#/reference"]
        }
      ],
      comparisons: [{
        id: executionBinding.primary_comparison_id,
        subject_observation_id: "observation_candidate",
        reference_observation_id: "observation_reference",
        delta,
        judgement: input.judgement ?? "supported",
        evidence_refs: ["metrics.json#/comparison"]
      }]
    },
    statistical_summary: {
      executed_trials: input.executedTrials ?? 2,
      cached_trials: input.cachedTrials ?? 0,
      confidence_intervals: input.includeCi === false
        ? []
        : [{
            metric_key: contract.primary_metric,
            comparison_id: input.ciComparisonId ?? executionBinding.primary_comparison_id,
            estimand: input.ciEstimand ?? "effect_delta",
            metric_scale: input.ciMetricScale ?? contract.metric_scale,
            trial_source: input.ciTrialSource ?? "fresh_executed",
            label: "Primary interval",
            lower: input.ciLower ?? delta - 0.01,
            upper: input.ciUpper ?? delta + 0.01,
            level: input.ciLevel ?? 0.95,
            sample_size: input.ciSampleSize ?? input.executedTrials ?? 2,
            source: "metrics",
            summary: "Interval over fresh bounded trials."
          }],
      stability_metrics: [],
      effect_estimates: [{
        comparison_id: executionBinding.primary_comparison_id,
        metric_key: contract.primary_metric,
        delta,
        direction: delta > 0 ? "positive" : delta < 0 ? "negative" : "neutral",
        summary: "Effect estimate for the declared primary comparison."
      }],
      notes: []
    },
    failure_taxonomy: input.highFailure
      ? [{
          id: "execution_integrity_failure",
          category: "runtime_failure",
          severity: "high",
          status: "observed",
          summary: "A high-severity execution failure invalidates the probe.",
          evidence: ["run.log"]
        }]
      : []
  } as unknown as AnalysisReport;
}

describe("topicProbeOutcome", () => {
  it("promotes only a supported, floor-meeting probe with two fresh trials and a matching CI", () => {
    const contract = makeContract();
    const report = makeReport(contract, { cachedTrials: 7 });
    const decision = buildTopicProbeOutcomeDecision({ contract, report });
    const binding = buildTopicProbeExecutionBinding({
      candidateId: contract.candidate_id,
      candidateContentSha256: contract.candidate_content_sha256,
      comparator: contract.comparator,
      datasetTaskScope: contract.dataset_task_bench
    });

    expect(decision).toMatchObject({
      schema_version: 1,
      artifact_kind: "topic_probe_outcome_decision",
      run_id: contract.run_id,
      research_cycle: contract.research_cycle,
      candidate_id: contract.candidate_id,
      topic_id: contract.topic_id,
      contract_content_sha256: contract.content_sha256,
      primary_comparison_id: binding.primary_comparison_id,
      primary_metric: contract.primary_metric,
      observed_delta: 0.06,
      directed_delta: 0.06,
      required_magnitude: 0.05,
      executed_trials: 2,
      cached_trials: 7,
      primary_metric_ci_present: true,
      primary_effect_ci_criterion_met: true,
      disposition: "promote_to_confirmatory",
      reason_codes: ["confirmatory_gate_satisfied"],
      next_action: "start_confirmatory_run"
    });
    expect(decision.primary_effect_ci_directed_bound).toBeCloseTo(0.05, 12);
    expect(decision.content_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(validateTopicProbeOutcomeDecision(JSON.stringify(decision), {
      expectedRunId: contract.run_id,
      expectedResearchCycle: contract.research_cycle,
      contract,
      report
    })).toMatchObject({ measured: true, valid: true, reasons: [] });
  });

  it("rejects unsupported hypotheses and routes to a deferred candidate", () => {
    const contract = makeContract();
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: makeReport(contract, { judgement: "not_supported" })
    });

    expect(decision.disposition).toBe("reject_candidate");
    expect(decision.reason_codes).toContain("hypothesis_not_supported");
    expect(decision.next_action).toBe("try_deferred_candidate");
  });

  it("refreshes the portfolio after rejection when no deferred candidate remains", () => {
    const contract = makeContract({ deferredCandidateIds: [] });
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: makeReport(contract, { delta: 0.01 })
    });

    expect(decision.disposition).toBe("reject_candidate");
    expect(decision.reason_codes).toContain("effect_floor_not_met");
    expect(decision.next_action).toBe("refresh_topic_portfolio");
  });

  it.each([
    [{ executedTrials: 1, includeCi: false }, "fresh_trial_count_below_confirmatory_floor"],
    [{ includeCi: false }, "primary_metric_confidence_interval_missing"],
    [{ ciLower: 0.049 }, "primary_effect_confidence_interval_floor_not_met"]
  ] as const)("repeats a promising probe when confirmatory prerequisites remain", (overrides, reason) => {
    const contract = makeContract();
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: makeReport(contract, overrides)
    });

    expect(decision.disposition).toBe("repeat_probe");
    expect(decision.reason_codes).toContain(reason);
    expect(decision.next_action).toBe("repeat_bounded_probe");
  });

  it.each([
    [{ executedTrials: 0, cachedTrials: 9 }, "fresh_executed_trials_missing"],
    [{ highFailure: true }, "high_severity_failure_present"],
    [{ metricId: "secondary_score" }, "primary_metric_binding_mismatch"],
    [{ ciComparisonId: "unbound_comparison" }, "primary_effect_confidence_interval_binding_mismatch"],
    [{ ciEstimand: "metric_value" }, "primary_effect_confidence_interval_binding_mismatch"],
    [{ ciTrialSource: "cached" }, "primary_effect_confidence_interval_binding_mismatch"],
    [{ ciSampleSize: 1 }, "primary_effect_confidence_interval_sample_invalid"]
  ] as const)("blocks invalid probe evidence before considering apparent performance", (overrides, reason) => {
    const contract = makeContract();
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: makeReport(contract, overrides)
    });

    expect(decision.disposition).toBe("blocked_invalid_evidence");
    expect(decision.reason_codes).toContain(reason);
    expect(decision.next_action).toBe("repair_probe_evidence");
  });

  it.each([
    [{ subjectSeriesId: "other_treatment" }, "primary_treatment_binding_mismatch"],
    [{ referenceSeriesId: "other_reference" }, "primary_reference_binding_mismatch"],
    [
      { observationScope: { dataset_task_scope_id: "other_scope" } },
      "dataset_task_scope_binding_mismatch"
    ],
    [
      { planScope: { dataset_task_scope_id: "other_scope" } },
      "dataset_task_scope_binding_mismatch"
    ]
  ] as const)(
    "blocks a same-metric result with a different treatment, reference, or dataset/task scope",
    (overrides, reason) => {
      const contract = makeContract();
      const decision = buildTopicProbeOutcomeDecision({
        contract,
        report: makeReport(contract, overrides)
      });

      expect(decision.disposition).toBe("blocked_invalid_evidence");
      expect(decision.reason_codes).toContain(reason);
      expect(decision.observed_delta).toBeNull();
    }
  );

  it.each([
    ["maximize", 0.06, 0.06],
    ["minimize", -0.06, 0.06]
  ] as const)("normalizes %s deltas so improvement is positive", (direction, observed, directed) => {
    const contract = makeContract({ direction });
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: makeReport(contract, { delta: observed })
    });

    expect(decision.observed_delta).toBe(observed);
    expect(decision.directed_delta).toBe(directed);
    expect(decision.disposition).toBe("promote_to_confirmatory");
  });

  it.each([
    [true, "promote_to_confirmatory"],
    [false, "reject_candidate"]
  ] as const)("honors an inclusive=%s effect-floor boundary", (inclusive, disposition) => {
    const contract = makeContract({ inclusive, magnitude: 0.05 });
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: makeReport(contract, { delta: 0.05, ciLower: 0.05, ciUpper: 0.06 })
    });

    expect(decision.directed_delta).toBe(0.05);
    expect(decision.disposition).toBe(disposition);
  });

  it("detects content tampering and rehashed report-derived tampering", () => {
    const contract = makeContract();
    const report = makeReport(contract);
    const decision = buildTopicProbeOutcomeDecision({ contract, report });
    const hashTamper = { ...decision, executed_trials: 99 };

    expect(validateTopicProbeOutcomeDecision(JSON.stringify(hashTamper)).reasons).toContain(
      "topic_probe_outcome_decision_content_hash_mismatch"
    );

    const { content_sha256: _oldHash, ...changedPayload } = {
      ...decision,
      disposition: "repeat_probe" as const,
      reason_codes: ["primary_metric_confidence_interval_missing"] as const,
      next_action: "repeat_bounded_probe" as const
    };
    const rehashed = {
      ...changedPayload,
      content_sha256: hashCanonical(changedPayload)
    };
    const validation = validateTopicProbeOutcomeDecision(JSON.stringify(rehashed), {
      contract,
      report
    });

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toEqual(expect.arrayContaining([
      "topic_probe_outcome_decision_report_binding_mismatch:disposition",
      "topic_probe_outcome_decision_report_binding_mismatch:reason_codes",
      "topic_probe_outcome_decision_report_binding_mismatch:next_action"
    ]));
  });

  it("rejects schema, runtime context, and contract binding mismatches", () => {
    const contract = makeContract();
    const report = makeReport(contract);
    const decision = buildTopicProbeOutcomeDecision({ contract, report });
    const { content_sha256: _oldHash, ...unknownFieldPayload } = {
      ...decision,
      unexpected_field: true
    };
    const unknownFieldDecision = {
      ...unknownFieldPayload,
      content_sha256: hashCanonical(unknownFieldPayload)
    };

    expect(
      validateTopicProbeOutcomeDecision(JSON.stringify(unknownFieldDecision)).reasons
    ).toEqual(["topic_probe_outcome_decision_schema_invalid"]);

    const contextValidation = validateTopicProbeOutcomeDecision(JSON.stringify(decision), {
      expectedRunId: "another_run",
      expectedResearchCycle: 7
    });
    expect(contextValidation.reasons).toEqual(expect.arrayContaining([
      "topic_probe_outcome_decision_run_id_mismatch",
      "topic_probe_outcome_decision_research_cycle_mismatch"
    ]));

    const otherContract = makeContract({ magnitude: 0.08 });
    const contractValidation = validateTopicProbeOutcomeDecision(JSON.stringify(decision), {
      contract: otherContract
    });
    expect(contractValidation.reasons).toEqual(expect.arrayContaining([
      "topic_probe_outcome_decision_contract_binding_mismatch:contract_content_sha256",
      "topic_probe_outcome_decision_contract_binding_mismatch:required_magnitude"
    ]));
  });
});
