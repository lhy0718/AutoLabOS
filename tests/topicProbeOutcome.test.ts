import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ActiveTopicProbeContract } from "../src/core/activeTopicProbeContract.js";
import {
  assessEvidenceAdequacy,
  buildEvidenceAdequacyContract,
  buildEvidenceAdequacyExecutionReceipt,
  EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH,
  type EvidenceAdequacyAssessmentV2,
  type EvidenceAdequacyContractV2
} from "../src/core/analysis/evidenceAdequacy.js";
import {
  reassessEvidenceAdequacyArtifacts,
  type EvidenceAdequacyAuthorization
} from "../src/core/analysis/evidenceAdequacyArtifacts.js";
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

const GENERATED_AT = "2026-01-01T00:00:00.000Z";
const DEFAULT_TARGET_INDEPENDENT_UNITS = 4;
const DEFAULT_CONFIDENCE_LEVEL = 0.9;
const DEFAULT_UNCERTAINTY_METHOD = "paired_bootstrap";
const DEFAULT_EFFECT_RESOLUTION = 0.01;
const temporaryRunDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRunDirs.splice(0).map((runDir) =>
      fs.rm(runDir, { recursive: true, force: true })
    )
  );
});

interface ReportOverrides {
  delta?: number;
  judgement?: string;
  analysisVersion?: number;
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
  ciMethod?: string;
  ciLower?: number;
  ciUpper?: number;
  ciLevel?: number;
  ciSampleSize?: number;
}

interface EvidenceFixtureOverrides {
  targetIndependentUnits?: number;
  confidenceLevel?: number;
  uncertaintyMethod?: string;
  minimumResolvableEffect?: number;
}

interface AuthorizedEvidenceFixture {
  runDir: string;
  evidenceContract: EvidenceAdequacyContractV2;
  assessment: EvidenceAdequacyAssessmentV2;
  authorization: EvidenceAdequacyAuthorization;
}

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

async function issueEvidenceAuthorization(
  contract: ActiveTopicProbeContract,
  input: EvidenceFixtureOverrides = {}
): Promise<AuthorizedEvidenceFixture> {
  const binding = buildTopicProbeExecutionBinding({
    candidateId: contract.candidate_id,
    candidateContentSha256: contract.candidate_content_sha256,
    comparator: contract.comparator,
    datasetTaskScope: contract.dataset_task_bench
  });
  const targetIndependentUnits = input.targetIndependentUnits
    ?? DEFAULT_TARGET_INDEPENDENT_UNITS;
  const confidenceLevel = input.confidenceLevel
    ?? DEFAULT_CONFIDENCE_LEVEL;
  const uncertaintyMethod = input.uncertaintyMethod
    ?? DEFAULT_UNCERTAINTY_METHOD;
  const evidenceContract = buildEvidenceAdequacyContract({
    primaryComparisonId: binding.primary_comparison_id,
    designSource: {
      kind: "estimator_protocol",
      contentSha256: hashCanonical({
        fixture_kind: "topic_probe_outcome_test_design",
        primary_comparison_id: binding.primary_comparison_id,
        target_independent_units: targetIndependentUnits,
        confidence_level: confidenceLevel,
        uncertainty_method: uncertaintyMethod
      })
    },
    independentUnit: {
      key: "matched_item_id",
      analysisUnit: "matched candidate-reference outcome"
    },
    plannedIndependentCoverage: {
      mode: "sampled",
      targetUniqueUnits: targetIndependentUnits,
      targetDenominatorPerArm: targetIndependentUnits
    },
    requiredContrast: {
      arms: ["candidate", "reference"],
      paired: true,
      requiredCompletePairs: targetIndependentUnits
    },
    uncertaintyRequirement: {
      mode: "required",
      allowedMethods: [uncertaintyMethod],
      confidenceLevel,
      decisionRule: "directed_interval_bound_meets_effect_criterion"
    },
    effectResolution: {
      scale: contract.metric_scale,
      minimumResolvableEffect: input.minimumResolvableEffect
        ?? DEFAULT_EFFECT_RESOLUTION
    },
    executionBudget: {
      applicable: false,
      notApplicableRationale:
        "The outcome unit test freezes evidence coverage instead of an execution-cost floor."
    }
  });
  const primaryEvidenceRefs = [
    "metrics.json#/candidate",
    "metrics.json#/reference",
    "metrics.json#/comparison"
  ];
  const receipt = buildEvidenceAdequacyExecutionReceipt({
    contractSha256: evidenceContract.content_sha256,
    primaryComparisonId: evidenceContract.primary_comparison_id,
    uniqueExecutionIds: Array.from(
      { length: targetIndependentUnits * 2 },
      (_, index) => `execution_${index + 1}`
    ),
    observedIndependentUnitIds: Array.from(
      { length: targetIndependentUnits },
      (_, index) => `matched_item_${index + 1}`
    ),
    observedDenominatorByArm: {
      candidate: targetIndependentUnits,
      reference: targetIndependentUnits
    },
    observedPairCoverage: {
      completePairIds: Array.from(
        { length: targetIndependentUnits },
        (_, index) => `matched_pair_${index + 1}`
      ),
      incompletePairIds: []
    },
    observedUncertaintyMethods: [uncertaintyMethod],
    primaryEvidenceRefs
  });
  const assessment = assessEvidenceAdequacy({
    contract: evidenceContract,
    receipt,
    verifiedEvidenceRefs: receipt.primary_evidence_refs
  });
  const runDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "autolabos-topic-probe-outcome-")
  );
  temporaryRunDirs.push(runDir);
  await Promise.all([
    fs.writeFile(
      path.join(runDir, EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH),
      `${JSON.stringify(evidenceContract, null, 2)}\n`,
      "utf8"
    ),
    fs.writeFile(
      path.join(runDir, EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8"
    ),
    fs.writeFile(
      path.join(runDir, EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH),
      `${JSON.stringify(assessment, null, 2)}\n`,
      "utf8"
    ),
    fs.writeFile(
      path.join(runDir, "metrics.json"),
      `${JSON.stringify({
        candidate: { value: 0.56 },
        reference: { value: 0.5 },
        comparison: { delta: 0.06 }
      }, null, 2)}\n`,
      "utf8"
    )
  ]);
  const reassessment = await reassessEvidenceAdequacyArtifacts({
    runDir,
    evidenceRoots: [runDir],
    expectedPrimaryComparisonId: binding.primary_comparison_id,
    requireStoredAssessment: true
  });
  if (!reassessment.authorization || !reassessment.assessment) {
    throw new Error(
      `test_evidence_authorization_missing:${reassessment.issues.join("|")}`
    );
  }
  return {
    runDir,
    evidenceContract,
    assessment: reassessment.assessment,
    authorization: reassessment.authorization
  };
}

function makeReport(
  contract: ActiveTopicProbeContract,
  evidenceContract: EvidenceAdequacyContractV2,
  assessment: EvidenceAdequacyAssessmentV2,
  input: ReportOverrides = {}
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
    analysis_version: input.analysisVersion ?? 1,
    generated_at: GENERATED_AT,
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
      executed_trials: input.executedTrials ?? 1,
      cached_trials: input.cachedTrials ?? 0,
      confidence_intervals: input.includeCi === false
        ? []
        : [{
            metric_key: contract.primary_metric,
            comparison_id: input.ciComparisonId ?? executionBinding.primary_comparison_id,
            estimand: input.ciEstimand ?? "effect_delta",
            metric_scale: input.ciMetricScale ?? contract.metric_scale,
            trial_source: input.ciTrialSource ?? "fresh_executed",
            method: input.ciMethod
              ?? evidenceContract.uncertainty_requirement.allowed_methods[0],
            label: "Primary interval",
            lower: input.ciLower ?? delta - 0.01,
            upper: input.ciUpper ?? delta + 0.01,
            level: input.ciLevel
              ?? evidenceContract.uncertainty_requirement.confidence_level
              ?? 1,
            sample_size: input.ciSampleSize
              ?? evidenceContract.planned_independent_coverage.target_unique_units,
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
    evidence_adequacy_assessment: assessment,
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

async function makeAuthorizedReport(
  contract: ActiveTopicProbeContract,
  reportOverrides: ReportOverrides = {},
  evidenceOverrides: EvidenceFixtureOverrides = {}
): Promise<AuthorizedEvidenceFixture & { report: AnalysisReport }> {
  const evidence = await issueEvidenceAuthorization(
    contract,
    evidenceOverrides
  );
  return {
    ...evidence,
    report: makeReport(
      contract,
      evidence.evidenceContract,
      evidence.assessment,
      reportOverrides
    )
  };
}

function rehash<T extends { content_sha256: string }>(value: T): T {
  const { content_sha256: _contentSha256, ...payload } = value;
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  } as T;
}

describe("topicProbeOutcome", () => {
  it("promotes a supported probe when frozen sampled coverage and its matching CI are satisfied", async () => {
    const contract = makeContract();
    const fixture = await makeAuthorizedReport(contract, { cachedTrials: 7 });
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });
    const binding = buildTopicProbeExecutionBinding({
      candidateId: contract.candidate_id,
      candidateContentSha256: contract.candidate_content_sha256,
      comparator: contract.comparator,
      datasetTaskScope: contract.dataset_task_bench
    });
    const interval = fixture.report.statistical_summary.confidence_intervals[0];

    expect(fixture.report.analysis_version).toBe(1);
    expect(fixture.report.evidence_adequacy_assessment).toEqual(fixture.assessment);
    expect(interval).toMatchObject({
      method: fixture.evidenceContract.uncertainty_requirement.allowed_methods[0],
      level: fixture.evidenceContract.uncertainty_requirement.confidence_level,
      sample_size:
        fixture.evidenceContract.planned_independent_coverage.target_unique_units
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
      evidence_adequacy_contract_sha256: fixture.evidenceContract.content_sha256,
      evidence_adequacy_assessment_sha256: fixture.assessment.content_sha256,
      evidence_adequacy_status: "pass",
      executed_trials: 1,
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
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    })).toMatchObject({ measured: true, valid: true, reasons: [] });
  });

  it("rejects unsupported hypotheses and routes to a deferred candidate", async () => {
    const contract = makeContract();
    const fixture = await makeAuthorizedReport(contract, {
      judgement: "not_supported"
    });
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });

    expect(decision.disposition).toBe("reject_candidate");
    expect(decision.reason_codes).toContain("hypothesis_not_supported");
    expect(decision.next_action).toBe("try_deferred_candidate");
  });

  it("refreshes the portfolio after rejection when no deferred candidate remains", async () => {
    const contract = makeContract({ deferredCandidateIds: [] });
    const fixture = await makeAuthorizedReport(contract, { delta: 0.01 });
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });

    expect(decision.disposition).toBe("reject_candidate");
    expect(decision.reason_codes).toContain("effect_floor_not_met");
    expect(decision.next_action).toBe("refresh_topic_portfolio");
  });

  it("repeats a sampled probe when adequacy passes but its required CI is absent", async () => {
    const contract = makeContract();
    const fixture = await makeAuthorizedReport(contract, { includeCi: false });
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });

    expect(fixture.assessment.passed).toBe(true);
    expect(decision.executed_trials).toBe(1);
    expect(decision.disposition).toBe("repeat_probe");
    expect(decision.reason_codes).toEqual([
      "primary_metric_confidence_interval_missing"
    ]);
    expect(decision.next_action).toBe("repeat_bounded_probe");
  });

  it("repeats a promising probe when the contract-bound CI misses the effect floor", async () => {
    const contract = makeContract();
    const fixture = await makeAuthorizedReport(contract, { ciLower: 0.049 });
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });

    expect(decision.disposition).toBe("repeat_probe");
    expect(decision.reason_codes).toContain(
      "primary_effect_confidence_interval_floor_not_met"
    );
    expect(decision.next_action).toBe("repeat_bounded_probe");
  });

  it.each([
    [{ executedTrials: 0, cachedTrials: 9 }, "fresh_executed_trials_missing"],
    [{ highFailure: true }, "high_severity_failure_present"],
    [{ metricId: "secondary_score" }, "primary_metric_binding_mismatch"],
    [{ ciComparisonId: "unbound_comparison" }, "primary_effect_confidence_interval_binding_mismatch"],
    [{ ciEstimand: "metric_value" }, "primary_effect_confidence_interval_binding_mismatch"],
    [{ ciTrialSource: "cached" }, "primary_effect_confidence_interval_binding_mismatch"]
  ] as const)(
    "blocks invalid probe evidence before considering apparent performance",
    async (overrides, reason) => {
      const contract = makeContract();
      const fixture = await makeAuthorizedReport(contract, overrides);
      const decision = buildTopicProbeOutcomeDecision({
        contract,
        report: fixture.report,
        evidenceAdequacyAuthorization: fixture.authorization
      });

      expect(decision.disposition).toBe("blocked_invalid_evidence");
      expect(decision.reason_codes).toContain(reason);
      expect(decision.next_action).toBe("repair_probe_evidence");
    }
  );

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
    async (overrides, reason) => {
      const contract = makeContract();
      const fixture = await makeAuthorizedReport(contract, overrides);
      const decision = buildTopicProbeOutcomeDecision({
        contract,
        report: fixture.report,
        evidenceAdequacyAuthorization: fixture.authorization
      });

      expect(decision.disposition).toBe("blocked_invalid_evidence");
      expect(decision.reason_codes).toContain(reason);
      expect(decision.observed_delta).toBeNull();
    }
  );

  it.each([
    ["maximize", 0.06, 0.06],
    ["minimize", -0.06, 0.06]
  ] as const)(
    "normalizes %s deltas so improvement is positive",
    async (direction, observed, directed) => {
      const contract = makeContract({ direction });
      const fixture = await makeAuthorizedReport(contract, { delta: observed });
      const decision = buildTopicProbeOutcomeDecision({
        contract,
        report: fixture.report,
        evidenceAdequacyAuthorization: fixture.authorization
      });

      expect(decision.observed_delta).toBe(observed);
      expect(decision.directed_delta).toBe(directed);
      expect(decision.disposition).toBe("promote_to_confirmatory");
    }
  );

  it.each([
    [true, "promote_to_confirmatory"],
    [false, "reject_candidate"]
  ] as const)(
    "honors an inclusive=%s effect-floor boundary",
    async (inclusive, disposition) => {
      const contract = makeContract({ inclusive, magnitude: 0.05 });
      const fixture = await makeAuthorizedReport(contract, {
        delta: 0.05,
        ciLower: 0.05,
        ciUpper: 0.06
      });
      const decision = buildTopicProbeOutcomeDecision({
        contract,
        report: fixture.report,
        evidenceAdequacyAuthorization: fixture.authorization
      });

      expect(decision.directed_delta).toBe(0.05);
      expect(decision.disposition).toBe(disposition);
    }
  );

  it("does not promote a forged, rehashed inline assessment without an authorization", async () => {
    const contract = makeContract();
    const evidence = await issueEvidenceAuthorization(contract);
    const forgedAssessment = rehash<EvidenceAdequacyAssessmentV2>({
      ...evidence.assessment,
      receipt_sha256: "f".repeat(64)
    });
    const report = makeReport(
      contract,
      evidence.evidenceContract,
      forgedAssessment
    );
    const decision = buildTopicProbeOutcomeDecision({ contract, report });

    expect(forgedAssessment.content_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(decision.disposition).toBe("blocked_invalid_evidence");
    expect(decision.evidence_adequacy_status).toBe("missing");
    expect(decision.reason_codes).toContain(
      "evidence_adequacy_authorization_missing"
    );
    expect(decision.next_action).toBe("repair_probe_evidence");
  });

  it("blocks an unknown analysis_version even with trusted evidence", async () => {
    const contract = makeContract();
    const fixture = await makeAuthorizedReport(contract, {
      analysisVersion: 99
    });
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });

    expect(decision.disposition).toBe("blocked_invalid_evidence");
    expect(decision.reason_codes).toContain("analysis_report_version_invalid");
    expect(decision.next_action).toBe("repair_probe_evidence");
  });

  it("rejects a structurally valid rehashed promotion in authoritative validation when report context is absent", async () => {
    const contract = makeContract();
    const fixture = await makeAuthorizedReport(contract);
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });
    const rehashedPromotion = rehash({
      ...decision,
      cached_trials: decision.cached_trials + 100
    });

    expect(validateTopicProbeOutcomeDecision(JSON.stringify(rehashedPromotion), {
      contract,
      structuralOnly: true
    })).toMatchObject({ valid: true, reasons: [] });
    const authoritative = validateTopicProbeOutcomeDecision(
      JSON.stringify(rehashedPromotion),
      {
        contract,
        evidenceAdequacyAuthorization: fixture.authorization
      }
    );
    expect(authoritative.valid).toBe(false);
    expect(authoritative.reasons).toContain(
      "topic_probe_outcome_authorization_context_missing"
    );
  });

  it("blocks a CI method outside the frozen evidence contract", async () => {
    const contract = makeContract();
    const fixture = await makeAuthorizedReport(contract, {
      ciMethod: "unapproved_interval_method"
    });
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });

    expect(decision.disposition).toBe("blocked_invalid_evidence");
    expect(decision.reason_codes).toContain(
      "primary_effect_confidence_interval_method_mismatch"
    );
  });

  it("blocks a CI below the contract-required confidence level", async () => {
    const contract = makeContract();
    const evidence = await issueEvidenceAuthorization(contract);
    const requiredLevel = evidence.evidenceContract
      .uncertainty_requirement.confidence_level;
    if (requiredLevel === null) {
      throw new Error("test_sampled_confidence_level_missing");
    }
    const report = makeReport(
      contract,
      evidence.evidenceContract,
      evidence.assessment,
      { ciLevel: requiredLevel - 0.01 }
    );
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report,
      evidenceAdequacyAuthorization: evidence.authorization
    });

    expect(decision.disposition).toBe("blocked_invalid_evidence");
    expect(decision.reason_codes).toContain(
      "primary_effect_confidence_interval_sample_invalid"
    );
  });

  it("blocks a CI whose sample size misses the contract target independent units", async () => {
    const contract = makeContract();
    const evidence = await issueEvidenceAuthorization(contract);
    const targetUnits = evidence.evidenceContract
      .planned_independent_coverage.target_unique_units;
    const report = makeReport(
      contract,
      evidence.evidenceContract,
      evidence.assessment,
      { ciSampleSize: targetUnits - 1 }
    );
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report,
      evidenceAdequacyAuthorization: evidence.authorization
    });

    expect(targetUnits).toBeGreaterThan(1);
    expect(decision.disposition).toBe("blocked_invalid_evidence");
    expect(decision.reason_codes).toContain(
      "primary_effect_confidence_interval_sample_invalid"
    );
  });

  it("blocks evidence whose attainable resolution is coarser than the topic effect criterion", async () => {
    const contract = makeContract();
    const fixture = await makeAuthorizedReport(
      contract,
      {},
      {
        minimumResolvableEffect:
          contract.effect_criterion.magnitude + 0.01
      }
    );
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });

    expect(fixture.assessment.passed).toBe(true);
    expect(decision.disposition).toBe("blocked_invalid_evidence");
    expect(decision.reason_codes).toContain(
      "evidence_adequacy_effect_resolution_incompatible"
    );
  });

  it("detects content tampering and rehashed report-derived tampering", async () => {
    const contract = makeContract();
    const fixture = await makeAuthorizedReport(contract);
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });
    const hashTamper = { ...decision, executed_trials: 99 };

    expect(validateTopicProbeOutcomeDecision(JSON.stringify(hashTamper)).reasons).toContain(
      "topic_probe_outcome_decision_content_hash_mismatch"
    );

    const rehashed = rehash({
      ...decision,
      disposition: "repeat_probe" as const,
      reason_codes: ["primary_metric_confidence_interval_missing"] as const,
      next_action: "repeat_bounded_probe" as const
    });
    const validation = validateTopicProbeOutcomeDecision(JSON.stringify(rehashed), {
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toEqual(expect.arrayContaining([
      "topic_probe_outcome_decision_report_binding_mismatch:disposition",
      "topic_probe_outcome_decision_report_binding_mismatch:reason_codes",
      "topic_probe_outcome_decision_report_binding_mismatch:next_action"
    ]));
  });

  it("rejects schema, runtime context, and contract binding mismatches", async () => {
    const contract = makeContract();
    const fixture = await makeAuthorizedReport(contract);
    const decision = buildTopicProbeOutcomeDecision({
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });
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
      expectedResearchCycle: 7,
      contract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });
    expect(contextValidation.reasons).toEqual(expect.arrayContaining([
      "topic_probe_outcome_decision_run_id_mismatch",
      "topic_probe_outcome_decision_research_cycle_mismatch"
    ]));

    const otherContract = makeContract({ magnitude: 0.08 });
    const contractValidation = validateTopicProbeOutcomeDecision(JSON.stringify(decision), {
      contract: otherContract,
      report: fixture.report,
      evidenceAdequacyAuthorization: fixture.authorization
    });
    expect(contractValidation.reasons).toEqual(expect.arrayContaining([
      "topic_probe_outcome_decision_contract_binding_mismatch:contract_content_sha256",
      "topic_probe_outcome_decision_contract_binding_mismatch:required_magnitude"
    ]));
  });
});
