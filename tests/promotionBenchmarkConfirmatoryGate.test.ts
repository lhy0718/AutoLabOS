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
import type { PromotionBenchmarkSystemRunManifest } from "../src/core/benchmark/promotionBenchmarkSystems.js";
import { promotionVariantDefinitions } from "../src/core/benchmark/promotionBenchmarkVariants.js";

const tempDirs: string[] = [];

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

  it("keeps complete null or mixed evidence publishable while lowering the claim class", () => {
    const fixture = makeAssessmentFixture(false);
    const assessment = assessPromotionConfirmatoryEvidence(fixture);

    expect(assessment.blockers).toEqual([]);
    expect(assessment.readiness).toBe("paper_scale_candidate");
    expect(assessment.claim_class).toBe("mixed_or_weak_signal");
    expect(assessment.hypotheses.find((item) => item.hypothesis_id === "H1")?.status).toBe("not_supported");
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
  for (let baseIndex = 0; baseIndex < 20; baseIndex += 1) {
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
    systemMetrics(roles.manuscript, 3, 0.45, 0.08, 0.90, 0.20),
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
    case_count: 200,
    prediction_count: 1400,
    systems,
    source_family_analysis: {
      availability: "complete",
      unavailable_reason: null,
      family_count: 3,
      families: [0, 1, 2].map((index) => ({
        source_family_id_sha256: repeatedHash(index + 101),
        base_bundle_count: index === 2 ? 6 : 7,
        case_count: index === 2 ? 60 : 70,
        systems
      })),
      leave_one_family_out: [0, 1, 2].map((index) => ({
        omitted_source_family_id_sha256: repeatedHash(index + 101),
        remaining_base_bundle_count: index === 2 ? 14 : 13,
        remaining_case_count: index === 2 ? 140 : 130,
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
    external_empirical_evidence_eligible: true
  } as PromotionProviderAggregateManifest;
  const systemRunManifest = {
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
    prediction_count: 200 * trialCount,
    covered_case_count: 200,
    expected_case_count: 200,
    coverage_rate: 1,
    exact_decision_accuracy: 0.80,
    macro_decision_f1: 0.80,
    false_paper_ready_count: Math.round(falsePromotionRate * 180),
    false_paper_ready_rate: falsePromotionRate,
    concern_acceptance_conflict_count: Math.round(conflictRate * 200),
    concern_acceptance_conflict_rate: conflictRate,
    clean_case_count: 20,
    clean_case_promotion_accuracy: cleanAccuracy,
    blocker_precision: 0.80,
    blocker_recall: 0.80,
    blocker_f1: 0.80,
    repair_owner_exact_match_accuracy: repairAccuracy,
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
    system_a: checklist,
    system_b: full,
    common_case_count: 200,
    common_base_bundle_count: 20,
    decision_accuracy_delta: -delta,
    decision_accuracy_cluster_bootstrap_95_ci: [-0.40, -0.10],
    decision_accuracy_exact_paired_sign_test_p: 0.01,
    false_paper_ready_common_case_count: 180,
    false_paper_ready_rate_delta: delta,
    false_paper_ready_cluster_bootstrap_95_ci: [delta - 0.05, delta + 0.05],
    false_paper_ready_exact_paired_sign_test_p: 0.01
  };
}

function repeatedHash(value: number): string {
  return value.toString(16).padStart(64, "0").slice(-64);
}
