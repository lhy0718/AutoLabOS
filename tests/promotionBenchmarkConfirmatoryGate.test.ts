import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  assessPromotionConfirmatoryEvidence,
  evaluatePromotionConfirmatoryGate
} from "../src/core/benchmark/promotionBenchmarkConfirmatoryGate.js";
import type {
  LoadedPromotionBenchmarkSuite,
  PromotionBenchmarkCaseManifest,
  PromotionBenchmarkPairedComparison,
  PromotionBenchmarkScoreReport,
  PromotionBenchmarkSystemMetrics
} from "../src/core/benchmark/promotionBenchmark.js";
import type { PromotionProviderAggregateManifest } from "../src/core/benchmark/promotionBenchmarkProviderAggregate.js";
import type { PromotionRecoveryReport } from "../src/core/benchmark/promotionBenchmarkRecovery.js";
import {
  PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION,
  type PromotionBenchmarkSystemRunManifest
} from "../src/core/benchmark/promotionBenchmarkSystems.js";
import { promotionVariantDefinitions } from "../src/core/benchmark/promotionBenchmarkVariants.js";
import {
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES
} from "../src/core/benchmark/promotionBenchmarkConfirmatoryContract.js";

const tempDirs: string[] = [];
const CONFIRMATORY_BASE_COUNT = MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES;
const CONFIRMATORY_CASE_COUNT = MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES;
const CONFIRMATORY_FAULT_CASE_COUNT = CONFIRMATORY_CASE_COUNT - CONFIRMATORY_BASE_COUNT;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion confirmatory gate", () => {
  it("blocks paper-scale promotion even when score validation passes but evidence is incomplete", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-confirmatory-gate-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, "cases"), { recursive: true });
    await mkdir(path.join(workspace, "artifacts", "clean"), { recursive: true });
    await mkdir(path.join(workspace, "artifacts", "fault"), { recursive: true });
    await writeFile(path.join(workspace, "suite.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "gate-fixture",
      cases: ["cases/clean.json", "cases/fault.json"]
    }));
    await writeFile(path.join(workspace, "cases", "clean.json"), JSON.stringify({
      schema_version: "1.0",
      case_id: "case-clean",
      base_bundle_id: "base-clean",
      split: "test",
      artifact_root: "../artifacts/clean",
      gold: { decision: "promote", blocking_concerns: [], repair_owners: [] }
    }));
    await writeFile(path.join(workspace, "cases", "fault.json"), JSON.stringify({
      schema_version: "1.0",
      case_id: "case-fault",
      base_bundle_id: "base-fault",
      split: "test",
      artifact_root: "../artifacts/fault",
      mutation_family: "executed_budget_mismatch",
      gold: {
        decision: "block",
        blocking_concerns: ["budget_contract_mismatch"],
        repair_owners: ["run_experiments"]
      }
    }));
    const predictions = [
      prediction("case-clean", "ungated", "promote", [], []),
      prediction("case-fault", "ungated", "promote", [], []),
      prediction("case-clean", "checklist", "promote", [], []),
      prediction("case-fault", "checklist", "promote", [], []),
      prediction("case-clean", "full-policy", "promote", [], []),
      prediction("case-fault", "full-policy", "block", ["budget_contract_mismatch"], ["run_experiments"]),
      prediction("case-clean", "policy-ablation", "promote", [], []),
      prediction("case-fault", "policy-ablation", "promote", [], [])
    ];
    await writeFile(
      path.join(workspace, "predictions.jsonl"),
      predictions.map((row) => JSON.stringify(row)).join("\n") + "\n"
    );

    const result = await evaluatePromotionConfirmatoryGate({
      cwd: workspace,
      suitePath: "suite.json",
      predictionsPath: "predictions.jsonl",
      providerRunManifestPaths: [],
      systemRoles: {
        ungated: "ungated",
        checklist: "checklist",
        manuscript: "manuscript-review",
        full: "full-policy",
        ablations: ["policy-ablation"]
      },
      outDir: "gate-output"
    });

    expect(result.report.score_validation_passed).toBe(true);
    expect(result.report).toMatchObject({
      readiness: "blocked_for_paper_scale",
      paper_ready: false,
      evidence_gate_passed: false,
      provider_repetition: { status: "missing_or_invalid", trial_count: 0 },
      recovery: { status: "missing_or_invalid" }
    });
    expect(result.report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "confirmatory_evidence_status_ineligible", target_node: "review" }),
      expect.objectContaining({ code: "minimum_case_count_not_met", target_node: "design_experiments" }),
      expect.objectContaining({ code: "provider_three_trial_evidence_missing", target_node: "run_experiments" }),
      expect.objectContaining({ code: "post_repair_evidence_missing", target_node: "run_experiments" }),
      expect.objectContaining({ code: "system_run_manifest_not_verified", target_node: "run_experiments" })
    ]));
    const recommendations = JSON.parse(
      await readFile(path.join(workspace, result.recommendations_path), "utf8")
    ) as { recommendations: Array<{ node: string }> };
    expect(recommendations.recommendations.map((item) => item.node)).toEqual(expect.arrayContaining([
      "design_experiments",
      "run_experiments",
      "review"
    ]));
  });

  it("admits complete confirmatory evidence without claiming paper_ready", () => {
    const fixture = makeAssessmentFixture(true);
    const assessment = assessPromotionConfirmatoryEvidence(fixture);

    expect(assessment).toMatchObject({
      blockers: [],
      readiness: "paper_scale_candidate",
      claim_class: "confirmatory_signal"
    });
    expect(assessment.hypotheses.every((item) => item.status === "supported")).toBe(true);
  });

  it("rejects provider repetitions that are not eligible for paper claims", () => {
    const fixture = makeAssessmentFixture(true);
    fixture.providerAggregate.paper_claim_evidence_eligible = false;

    const assessment = assessPromotionConfirmatoryEvidence(fixture);

    expect(assessment.readiness).toBe("blocked_for_paper_scale");
    expect(assessment.blockers).toContainEqual(expect.objectContaining({
      code: "provider_evidence_not_paper_eligible",
      target_node: "review"
    }));
  });

  it("rejects a provider aggregate that does not prove real model execution", () => {
    const fixture = makeAssessmentFixture(true);
    fixture.providerAggregate.real_model_empirical_evidence_eligible = false;

    const assessment = assessPromotionConfirmatoryEvidence(fixture);

    expect(assessment.readiness).toBe("blocked_for_paper_scale");
    expect(assessment.blockers).toContainEqual(expect.objectContaining({
      code: "provider_repetition_not_verified",
      target_node: "run_experiments"
    }));
  });

  it("rejects deterministic evidence from an unversioned system protocol", () => {
    const fixture = makeAssessmentFixture(true);
    fixture.systemRunManifest.schema_version = "1.0";
    fixture.systemRunManifest.protocol_revision = null;

    const assessment = assessPromotionConfirmatoryEvidence(fixture);

    expect(assessment.readiness).toBe("blocked_for_paper_scale");
    expect(assessment.blockers).toContainEqual(expect.objectContaining({
      code: "system_run_protocol_revision_mismatch",
      target_node: "run_experiments"
    }));
  });

  it("rejects a paper-eligible suite without hash-bound adjudication provenance", () => {
    const fixture = makeAssessmentFixture(true);
    delete fixture.loaded.manifest.adjudication_provenance;

    const assessment = assessPromotionConfirmatoryEvidence(fixture);

    expect(assessment.readiness).toBe("blocked_for_paper_scale");
    expect(assessment.blockers).toContainEqual(expect.objectContaining({
      code: "confirmatory_adjudication_provenance_missing",
      target_node: "review"
    }));
  });

  it("rejects adjudication provenance that cannot reproduce the source-suite snapshot", () => {
    const fixture = makeAssessmentFixture(true);
    delete fixture.loaded.manifest.adjudication_provenance?.source_suite_evidence;

    const assessment = assessPromotionConfirmatoryEvidence(fixture);

    expect(assessment.readiness).toBe("blocked_for_paper_scale");
    expect(assessment.blockers).toContainEqual(expect.objectContaining({
      code: "confirmatory_adjudication_provenance_missing",
      target_node: "review"
    }));
  });

  it("routes missing paper-scale freeze provenance back to experiment design", () => {
    const fixture = makeAssessmentFixture(true);
    delete fixture.loaded.manifest.confirmatory_freeze_provenance;

    const assessment = assessPromotionConfirmatoryEvidence(fixture);

    expect(assessment.readiness).toBe("blocked_for_paper_scale");
    expect(assessment.blockers).toContainEqual(expect.objectContaining({
      code: "confirmatory_freeze_provenance_missing",
      target_node: "design_experiments"
    }));
  });

  it("routes a freeze without contained upstream evidence back to experiment design", () => {
    const fixture = makeAssessmentFixture(true);
    delete fixture.loaded.manifest.confirmatory_freeze_provenance?.upstream_evidence_inventory_sha256;
    delete fixture.loaded.manifest.confirmatory_freeze_provenance?.upstream_evidence_file_count;

    const assessment = assessPromotionConfirmatoryEvidence(fixture);

    expect(assessment.readiness).toBe("blocked_for_paper_scale");
    expect(assessment.blockers).toContainEqual(expect.objectContaining({
      code: "confirmatory_freeze_provenance_missing",
      target_node: "design_experiments"
    }));
  });

  it("keeps complete null or mixed evidence publishable while lowering the claim class", () => {
    const fixture = makeAssessmentFixture(false);
    const assessment = assessPromotionConfirmatoryEvidence(fixture);

    expect(assessment.blockers).toEqual([]);
    expect(assessment.readiness).toBe("paper_scale_candidate");
    expect(assessment.claim_class).toBe("mixed_or_weak_signal");
    expect(assessment.hypotheses.find((item) => item.hypothesis_id === "H1")?.status).toBe("not_supported");
  });

  it("does not support a point-threshold result when its clustered interval crosses the threshold", () => {
    const fixture = makeAssessmentFixture(true);
    const comparison = fixture.score.paired_analysis.comparisons[0];
    comparison.false_paper_ready_cluster_bootstrap_95_ci = [-0.30, -0.10];

    const assessment = assessPromotionConfirmatoryEvidence(fixture);
    const h1 = assessment.hypotheses.find((item) => item.hypothesis_id === "H1");

    expect(assessment.blockers).toEqual([]);
    expect(assessment.readiness).toBe("paper_scale_candidate");
    expect(assessment.claim_class).toBe("mixed_or_weak_signal");
    expect(h1).toMatchObject({
      status: "not_supported",
      observed_value: 0.30,
      confidence_interval_95: [0.10, 0.30],
      point_threshold_met: true,
      decision_rule: "lower_bound_at_least_threshold"
    });
  });

  it("uses the upper interval bound for an at-most hypothesis", () => {
    const fixture = makeAssessmentFixture(true);
    const full = fixture.score.systems.find((system) => system.system_id === fixture.roles.full);
    if (!full) throw new Error("Full-policy fixture is missing.");
    full.concern_acceptance_conflict_cluster_bootstrap_95_ci = [0, 0.08];

    const assessment = assessPromotionConfirmatoryEvidence(fixture);
    const h2 = assessment.hypotheses.find((item) => item.hypothesis_id === "H2");

    expect(assessment.blockers).toEqual([]);
    expect(h2).toMatchObject({
      status: "not_supported",
      observed_value: 0.01,
      confidence_interval_95: [0, 0.08],
      point_threshold_met: true,
      decision_rule: "upper_bound_at_most_threshold"
    });
  });

  it("blocks paper-scale progression when a preregistered clustered interval is absent", () => {
    const fixture = makeAssessmentFixture(true);
    const full = fixture.score.systems.find((system) => system.system_id === fixture.roles.full);
    if (!full) throw new Error("Full-policy fixture is missing.");
    full.clean_case_promotion_accuracy_cluster_bootstrap_95_ci = null;

    const assessment = assessPromotionConfirmatoryEvidence(fixture);

    expect(assessment.readiness).toBe("blocked_for_paper_scale");
    expect(assessment.claim_class).toBe("not_evaluable");
    expect(assessment.blockers).toContainEqual(expect.objectContaining({
      code: "hypothesis_clustered_interval_not_evaluable",
      evidence_ref: "H3",
      target_node: "analyze_results"
    }));
    expect(assessment.hypotheses.find((item) => item.hypothesis_id === "H3")?.status).toBe("not_evaluable");
  });
});

function prediction(
  caseId: string,
  systemId: string,
  decision: "promote" | "block",
  blockers: string[],
  repairOwners: string[]
): Record<string, unknown> {
  return {
    case_id: caseId,
    system_id: systemId,
    trial_id: "fixture-trial",
    decision,
    concerns: blockers.map((code) => ({ code, severity: "blocking" })),
    repair_owners: repairOwners
  };
}

function makeAssessmentFixture(h1Supported: boolean): {
  loaded: LoadedPromotionBenchmarkSuite;
  score: PromotionBenchmarkScoreReport;
  systemRunManifest: PromotionBenchmarkSystemRunManifest;
  providerAggregate: PromotionProviderAggregateManifest;
  recovery: PromotionRecoveryReport;
  roles: { ungated: string; checklist: string; manuscript: string; full: string; ablations: string[] };
  suiteSha256: string;
  suiteSnapshotSha256: string;
  inputPredictionsSha256: string;
  systemRunManifestSha256: string;
} {
  const roles = {
    ungated: "always-promote",
    checklist: "presence-checklist",
    manuscript: "manuscript",
    full: "artifact-audit",
    ablations: ["advisory-artifact-audit"]
  };
  const variants = promotionVariantDefinitions();
  const cases: PromotionBenchmarkCaseManifest[] = [];
  for (let baseIndex = 0; baseIndex < CONFIRMATORY_BASE_COUNT; baseIndex += 1) {
    for (const [variantIndex, variant] of variants.entries()) {
      cases.push({
        schema_version: "1.0",
        case_id: "case-" + baseIndex + "-" + variantIndex,
        base_bundle_id: "base-" + baseIndex,
        split: "test",
        artifact_root: "artifacts/case-" + baseIndex + "-" + variantIndex,
        source_sha256: repeatedHash(baseIndex + 1),
        source_family_id_sha256: repeatedHash((baseIndex % 3) + 101),
        operator_group_id_sha256: repeatedHash((baseIndex % 3) + 201),
        artifact_sha256: repeatedHash((baseIndex * variants.length + variantIndex) + 301),
        ...(variant.mutation_family ? { mutation_family: variant.mutation_family } : {}),
        gold: variant.gold
      });
    }
  }
  const suiteSha256 = "a".repeat(64);
  const suiteSnapshotSha256 = "d".repeat(64);
  const inputPredictionsSha256 = "b".repeat(64);
  const systemRunManifestSha256 = "c".repeat(64);
  const checklistFalsePromotion = h1Supported ? 0.50 : 0.30;
  const systems = [
    systemMetrics(roles.ungated, 1, 0.90, 0, 1, 0.10),
    systemMetrics(roles.checklist, 1, checklistFalsePromotion, 0, 1, 0.20),
    systemMetrics(roles.manuscript, 3, 0.45, 0.08, 0.90, 0.15),
    systemMetrics(roles.full, 1, 0.20, 0.01, 0.95, 0.80),
    systemMetrics(roles.ablations[0], 1, 0.40, 0.20, 1, 0.50)
  ];
  const paired = pairedComparison(roles.checklist, roles.full, checklistFalsePromotion - 0.20);
  const loaded: LoadedPromotionBenchmarkSuite = {
    suite_path: "suite.json",
    suite_root: ".",
    manifest: {
      schema_version: "1.0",
      suite_id: "confirmatory-fixture",
      evidence_class: "external_real_run",
      paper_claim_eligible: true,
      adjudication_status: "double_adjudicated",
      mutation_isolation_status: "double_verified",
      execution_provenance_status: "artifact_verified",
      source_diversity_status: "declared_stratified",
      confirmatory_freeze_provenance: confirmatoryFreezeProvenance(
        CONFIRMATORY_BASE_COUNT,
        CONFIRMATORY_CASE_COUNT
      ),
      adjudication_provenance: adjudicationProvenance(CONFIRMATORY_CASE_COUNT),
      cases: cases.map((item) => "cases/" + item.case_id + ".json")
    },
    cases,
    case_artifact_roots: Object.fromEntries(cases.map((item) => [item.case_id, item.artifact_root]))
  };
  const score: PromotionBenchmarkScoreReport = {
    schema_version: "1.0",
    generated_at: "2026-01-01T00:00:00.000Z",
    suite_id: loaded.manifest.suite_id,
    evidence_class: "external_real_run",
    paper_claim_eligible: true,
    adjudication_status: "double_adjudicated",
    mutation_isolation_status: "double_verified",
    execution_provenance_status: "artifact_verified",
    source_diversity_status: "declared_stratified",
    suite_ref: "suite.json",
    prediction_ref: "predictions.jsonl",
    passed: true,
    validation_issues: [],
    case_count: CONFIRMATORY_CASE_COUNT,
    prediction_count: CONFIRMATORY_CASE_COUNT * 7,
    systems,
    source_family_analysis: {
      availability: "complete",
      unavailable_reason: null,
      family_count: 3,
      families: [0, 1, 2].map((index) => ({
        source_family_id_sha256: repeatedHash(index + 101),
        base_bundle_count: CONFIRMATORY_BASE_COUNT / 3,
        case_count: CONFIRMATORY_CASE_COUNT / 3,
        systems
      })),
      leave_one_family_out: [0, 1, 2].map((index) => ({
        omitted_source_family_id_sha256: repeatedHash(index + 101),
        remaining_base_bundle_count: CONFIRMATORY_BASE_COUNT * 2 / 3,
        remaining_case_count: CONFIRMATORY_CASE_COUNT * 2 / 3,
        comparisons: [paired]
      }))
    },
    paired_analysis: {
      inference_unit: "base_bundle_id",
      bootstrap_replicates: 5000,
      exploratory_only: false,
      comparisons: [paired]
    }
  };
  const providerAggregate = {
    suite_id: loaded.manifest.suite_id,
    system_id: roles.manuscript,
    trial_count: 3,
    independent_trial_requirement_met: true,
    external_empirical_evidence_eligible: true,
    real_model_empirical_evidence_eligible: true,
    paper_claim_evidence_eligible: true
  } as PromotionProviderAggregateManifest;
  const systemRunManifest = {
    schema_version: "1.1",
    protocol_revision: PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION,
    systems: [
      { system_id: roles.ungated, protocol: "ungated", ablated_components: [] },
      { system_id: roles.checklist, protocol: "artifact_presence_checklist", ablated_components: [] },
      { system_id: roles.full, protocol: "full_artifact_policy", ablated_components: [] },
      {
        system_id: roles.ablations[0],
        protocol: "gate_ablation",
        ablated_components: ["concern_to_action_binding"]
      }
    ]
  } as PromotionBenchmarkSystemRunManifest;
  const recovery = {
    passed: true,
    study_id: loaded.manifest.suite_id,
    system_id: roles.full,
    original_suite_sha256: suiteSha256,
    original_suite_snapshot_sha256: suiteSnapshotSha256,
    original_predictions_sha256: inputPredictionsSha256,
    original_system_run_manifest_sha256: systemRunManifestSha256,
    missing_fault_families: [],
    original_fault_case_count: 648,
    covered_fault_case_count: 648,
    missing_fault_case_count: 0,
    successful_recovery_rate: 0.90,
    clean_control_regression_rate: 0.05
  } as PromotionRecoveryReport;
  return {
    loaded,
    score,
    systemRunManifest,
    providerAggregate,
    recovery,
    roles,
    suiteSha256,
    suiteSnapshotSha256,
    inputPredictionsSha256,
    systemRunManifestSha256
  };
}

function confirmatoryFreezeProvenance(baseCount: number, caseCount: number) {
  return {
    schema_version: "1.2" as const,
    method: "verified_confirmatory_freeze" as const,
    study_id: "confirmatory-fixture",
    intake_tier: "paper_scale" as const,
    freeze_manifest_ref: "confirmatory-freeze/frozen-intake-manifest.json",
    freeze_manifest_sha256: "7".repeat(64),
    recipe_ref: "confirmatory-freeze/recipe.json",
    recipe_sha256: "8".repeat(64),
    intake_manifest_sha256: "9".repeat(64),
    upstream_evidence_inventory_sha256: "d".repeat(64),
    upstream_evidence_file_count: 5,
    base_bundle_count: baseCount,
    case_count: caseCount,
    candidate_review: {
      handoff_id: "fixture-handoff",
      source_revision: "fixture-revision",
      handoff_manifest_sha256: "a".repeat(64),
      campaign_return_receipt_sha256: "e".repeat(64),
      curation_return_receipt_sha256: "6".repeat(64),
      review_report_sha256: "f".repeat(64),
      adjudicated_labels_sha256: "b".repeat(64),
      review_evidence_sha256: "c".repeat(64),
      source_eligible_candidate_count: baseCount
    }
  };
}

function adjudicationProvenance(caseCount: number) {
  return {
    schema_version: "1.0" as const,
    method: "independent_double_adjudication" as const,
    source_suite_snapshot_sha256: "1".repeat(64),
    source_suite_evidence: {
      schema_version: "1.0" as const,
      method: "contained_source_suite_manifests" as const,
      suite_manifest_ref: "adjudication/source-suite/suite.json",
      suite_manifest_sha256: "0".repeat(64),
      case_manifests: Array.from({ length: caseCount }, (_, index) => ({
        case_id: `case-${index + 1}`,
        source_ref: `cases/case-${index + 1}.json`,
        evidence_ref: `adjudication/source-suite/case-manifests/${String(index + 1).padStart(6, "0")}.json`,
        sha256: "f".repeat(64)
      }))
    },
    private_annotation_map_ref: "adjudication/private-annotation-map.json",
    private_annotation_map_sha256: "2".repeat(64),
    initial_annotation_refs: [
      "adjudication/initial-annotation-1.jsonl",
      "adjudication/initial-annotation-2.jsonl"
    ] as [string, string],
    initial_annotation_sha256: ["3".repeat(64), "4".repeat(64)] as [string, string],
    resolution_ref: null,
    resolution_sha256: null,
    mutation_audit_report_ref: "adjudication/mutation-audit-report.json",
    mutation_audit_report_sha256: "5".repeat(64),
    adjudicated_labels_ref: "adjudication/adjudicated-labels.jsonl",
    adjudicated_labels_sha256: "6".repeat(64),
    case_count: caseCount
  };
}

function systemMetrics(
  systemId: string,
  trialCount: number,
  falsePromotionRate: number,
  conflictRate: number,
  cleanAccuracy: number,
  repairAccuracy: number
): PromotionBenchmarkSystemMetrics {
  const emptyRow = { promote: 0, needs_review: 0, downgrade: 0, block: 0 };
  return {
    system_id: systemId,
    trial_count: trialCount,
    prediction_count: CONFIRMATORY_CASE_COUNT * trialCount,
    covered_case_count: CONFIRMATORY_CASE_COUNT,
    expected_case_count: CONFIRMATORY_CASE_COUNT,
    coverage_rate: 1,
    exact_decision_accuracy: 0.80,
    macro_decision_f1: 0.80,
    false_paper_ready_count: Math.round(falsePromotionRate * CONFIRMATORY_FAULT_CASE_COUNT),
    false_paper_ready_rate: falsePromotionRate,
    false_paper_ready_cluster_bootstrap_95_ci: boundedInterval(falsePromotionRate, 0.02),
    concern_acceptance_conflict_count: Math.round(conflictRate * CONFIRMATORY_CASE_COUNT),
    concern_acceptance_conflict_rate: conflictRate,
    concern_acceptance_conflict_cluster_bootstrap_95_ci: boundedInterval(conflictRate, 0.01),
    clean_case_count: CONFIRMATORY_BASE_COUNT,
    clean_case_promotion_accuracy: cleanAccuracy,
    clean_case_promotion_accuracy_cluster_bootstrap_95_ci: boundedInterval(cleanAccuracy, 0.02),
    blocker_precision: 0.80,
    blocker_recall: 0.80,
    blocker_f1: 0.80,
    repair_owner_exact_match_accuracy: repairAccuracy,
    repair_owner_exact_match_accuracy_cluster_bootstrap_95_ci: boundedInterval(repairAccuracy, 0.02),
    trace_coverage: 1,
    mean_latency_ms: 1,
    total_cost_usd: 0,
    decision_confusion: {
      promote: { ...emptyRow },
      needs_review: { ...emptyRow },
      downgrade: { ...emptyRow },
      block: { ...emptyRow }
    },
    by_mutation_family: []
  };
}

function pairedComparison(
  checklist: string,
  full: string,
  delta: number
): PromotionBenchmarkPairedComparison {
  return {
    system_a: full,
    system_b: checklist,
    common_case_count: CONFIRMATORY_CASE_COUNT,
    common_base_bundle_count: CONFIRMATORY_BASE_COUNT,
    decision_accuracy_delta: delta,
    decision_accuracy_cluster_bootstrap_95_ci: [0.10, 0.40],
    decision_accuracy_exact_paired_sign_test_p: 0.01,
    false_paper_ready_common_case_count: CONFIRMATORY_FAULT_CASE_COUNT,
    false_paper_ready_rate_delta: -delta,
    false_paper_ready_cluster_bootstrap_95_ci: [-delta - 0.05, -delta + 0.05],
    false_paper_ready_exact_paired_sign_test_p: 0.01,
    repair_owner_common_case_count: CONFIRMATORY_FAULT_CASE_COUNT,
    repair_owner_exact_match_accuracy_delta: 0.60,
    repair_owner_cluster_bootstrap_95_ci: [0.55, 0.65],
    repair_owner_exact_paired_sign_test_p: 0.01
  };
}

function boundedInterval(value: number, margin: number): [number, number] {
  return [Math.max(0, value - margin), Math.min(1, value + margin)];
}

function repeatedHash(value: number): string {
  return value.toString(16).padStart(64, "0").slice(-64);
}
