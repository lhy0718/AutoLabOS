import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  REQUIRED_CONFIRMATORY_MUTATION_FAMILIES,
  adjudicatePromotionBenchmark,
  evaluatePromotionAdjudicationEligibility,
  exportPromotionAnnotationPack,
  type PromotionAnnotationLabel
} from "../src/core/benchmark/promotionBenchmarkAdjudication.js";
import {
  loadPromotionBenchmarkSuite,
  type PromotionBenchmarkCaseManifest
} from "../src/core/benchmark/promotionBenchmark.js";
import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";
import {
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES
} from "../src/core/benchmark/promotionBenchmarkConfirmatoryContract.js";
import {
  exportPromotionMutationAuditPack,
  verifyPromotionMutationAudit
} from "../src/core/benchmark/promotionBenchmarkMutationAudit.js";
import { runPromotionBenchmarkScoreCli } from "../src/cli/governanceBenchmark.js";
import { runMetaHarness } from "../src/core/metaHarness/metaHarness.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion benchmark adjudication", () => {
  it("exports a gold-blind pack and replaces provisional labels after double adjudication", async () => {
    const workspace = await createWorkspace();
    const exported = await exportPromotionAnnotationPack({
      cwd: workspace,
      suitePath: "suite/suite.json",
      outDir: "annotation-pack"
    });
    const tasksText = await readFile(path.join(workspace, exported.tasks_path), "utf8");
    expect(tasksText).not.toMatch(/case-clean|case-fault|mutation_family|gold/iu);
    expect(tasksText).toMatch(/blocking_concerns|repair_owners/iu);
    expect(tasksText).toContain("annotation-");
    const rubric = await readFile(path.join(workspace, exported.rubric_path), "utf8");
    expect(rubric).toContain("Do not use the private map");
    expect(rubric).toContain("`figure_audit`");
    expect(exported.tasks_path).toContain("annotation-pack/annotator/");
    expect(exported.private_map_path).toBe("annotation-pack/private-annotation-map.json");
    await expect(access(path.join(workspace, exported.annotator_dir, "private-annotation-map.json"))).rejects.toThrow();

    const privateMap = JSON.parse(await readFile(path.join(workspace, exported.private_map_path), "utf8")) as PrivateMap;
    expect(privateMap.entries.map((entry) => entry.case_id)).toEqual(["case-clean", "case-fault"]);
    await writeAnnotations(workspace, "labels-a.jsonl", privateMap, "annotator-alpha");
    await writeAnnotations(workspace, "labels-b.jsonl", privateMap, "annotator-beta");

    const result = await adjudicatePromotionBenchmark({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: exported.private_map_path,
      annotationPaths: ["labels-a.jsonl", "labels-b.jsonl"],
      outDir: "adjudicated"
    });
    expect(result.report).toMatchObject({
      passed: true,
      disagreement_count: 0,
      accepted_label_count: 2,
      agreement: {
        decision_exact_rate: 1,
        blocking_concern_exact_rate: 1,
        repair_owner_exact_rate: 1,
        full_label_exact_rate: 1
      },
      eligibility: { paper_claim_eligible: false, base_bundle_count: 1, case_count: 2 }
    });
    expect(result.report.mutation_isolation).toMatchObject({
      status: "unreviewed",
      report_path: null,
      validation_issues: [expect.objectContaining({ code: "mutation_isolation_report_missing" })]
    });
    expect(result.report.eligibility.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "base_bundle_minimum_not_met",
      "held_out_case_minimum_not_met",
      "paired_fault_family_coverage_incomplete"
    ]));

    const loaded = await loadPromotionBenchmarkSuite(path.join(workspace, result.suite_path || "missing"));
    expect(loaded.issues).toEqual([]);
    expect(loaded.suite?.manifest).toMatchObject({
      evidence_class: "external_real_run",
      adjudication_status: "double_adjudicated",
      mutation_isolation_status: "unreviewed",
      execution_provenance_status: "artifact_verified",
      paper_claim_eligible: false
    });
    expect(loaded.suite?.cases.find((benchmarkCase) => benchmarkCase.case_id === "case-fault")?.gold).toEqual({
      decision: "block",
      blocking_concerns: ["comparison_evidence_gap"],
      repair_owners: ["design_experiments"]
    });
    const provisional = await loadPromotionBenchmarkSuite(path.join(workspace, "suite", "suite.json"));
    expect(provisional.suite?.cases.find((benchmarkCase) => benchmarkCase.case_id === "case-fault")?.gold.decision).toBe("needs_review");

    const reviewDecision = JSON.parse(await readFile(path.join(workspace, "adjudicated", "review", "decision.json"), "utf8"));
    expect(reviewDecision).toMatchObject({ outcome: "revise", adjudication_passed: true, paper_claim_eligible: false });
    const harness = await runMetaHarness({
      cwd: workspace,
      runs: 0,
      nodes: ["design_experiments", "review"],
      externalRunRoots: [path.join(workspace, "adjudicated")],
      noApply: true
    });
    const promptTargets = JSON.parse(await readFile(path.join(harness.contextDir, "prompt_target_map.json"), "utf8")) as {
      targets: Array<{ target_node: string; recommended_prompt_node: string }>;
    };
    expect(promptTargets.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_node: "design_experiments", recommended_prompt_node: "design_experiments" }),
      expect.objectContaining({ target_node: "review", recommended_prompt_node: "review" })
    ]));
  });

  it("fails closed on disagreement until an independent resolver supplies a label", async () => {
    const workspace = await createWorkspace();
    const exported = await exportPromotionAnnotationPack({ cwd: workspace, suitePath: "suite/suite.json", outDir: "annotation-pack" });
    const privateMap = JSON.parse(await readFile(path.join(workspace, exported.private_map_path), "utf8")) as PrivateMap;
    await writeAnnotations(workspace, "labels-a.jsonl", privateMap, "annotator-alpha");
    await writeAnnotations(workspace, "labels-b.jsonl", privateMap, "annotator-beta", {
      "case-fault": { decision: "downgrade", blocking_concerns: ["comparison_evidence_gap"], repair_owners: ["design_experiments"] }
    });

    const unresolved = await adjudicatePromotionBenchmark({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: exported.private_map_path,
      annotationPaths: ["labels-a.jsonl", "labels-b.jsonl"],
      outDir: "unresolved"
    });
    expect(unresolved.report).toMatchObject({
      passed: false,
      disagreement_count: 1,
      resolved_disagreement_count: 0,
      adjudicated_suite_path: null
    });
    expect(unresolved.report.validation_issues.map((issue) => issue.code)).toContain("unresolved_annotation_disagreement");
    expect(unresolved.suite_path).toBeNull();

    const faultEntry = privateMap.entries.find((entry) => entry.case_id === "case-fault");
    if (!faultEntry) throw new Error("fault entry missing");
    await writeFile(path.join(workspace, "resolution.jsonl"), `${JSON.stringify(annotationRecord(
      faultEntry.annotation_id,
      "resolver-gamma",
      { decision: "block", blocking_concerns: ["comparison_evidence_gap"], repair_owners: ["design_experiments"] }
    ))}\n`, "utf8");
    const resolved = await adjudicatePromotionBenchmark({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: exported.private_map_path,
      annotationPaths: ["labels-a.jsonl", "labels-b.jsonl"],
      resolutionPath: "resolution.jsonl",
      outDir: "resolved"
    });
    expect(resolved.report).toMatchObject({
      passed: true,
      resolver_id: "resolver-gamma",
      disagreement_count: 1,
      resolved_disagreement_count: 1
    });
    expect(resolved.suite_path).not.toBeNull();
  });

  it("routes unverified execution provenance through review to run_experiments and the design prompt", async () => {
    const workspace = await createWorkspace();
    const suitePath = path.join(workspace, "suite", "suite.json");
    const suite = JSON.parse(await readFile(suitePath, "utf8")) as Record<string, unknown>;
    suite.execution_provenance_status = "unverified";
    await writeFile(suitePath, `${JSON.stringify(suite, null, 2)}\n`, "utf8");
    const exported = await exportPromotionAnnotationPack({
      cwd: workspace,
      suitePath: "suite/suite.json",
      outDir: "provenance-annotation-pack"
    });
    const privateMap = JSON.parse(await readFile(path.join(workspace, exported.private_map_path), "utf8")) as PrivateMap;
    await writeAnnotations(workspace, "provenance-labels-a.jsonl", privateMap, "annotator-alpha");
    await writeAnnotations(workspace, "provenance-labels-b.jsonl", privateMap, "annotator-beta");

    const result = await adjudicatePromotionBenchmark({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: exported.private_map_path,
      annotationPaths: ["provenance-labels-a.jsonl", "provenance-labels-b.jsonl"],
      outDir: "provenance-blocked"
    });

    expect(result.report.execution_provenance_status).toBe("unverified");
    expect(result.report.eligibility.blockers.map((blocker) => blocker.code))
      .toContain("execution_provenance_not_artifact_verified");
    const recommendations = JSON.parse(await readFile(
      path.join(workspace, "provenance-blocked", "review", "node_strengthening_recommendations.json"),
      "utf8"
    )) as { recommendations: Array<{ node: string }> };
    expect(recommendations.recommendations).toContainEqual(expect.objectContaining({ node: "run_experiments" }));

    const harness = await runMetaHarness({
      cwd: workspace,
      runs: 0,
      nodes: ["design_experiments"],
      externalRunRoots: [path.join(workspace, "provenance-blocked")],
      noApply: true
    });
    const promptTargets = JSON.parse(await readFile(path.join(harness.contextDir, "prompt_target_map.json"), "utf8")) as {
      targets: Array<{ target_node: string; recommended_prompt_node: string }>;
    };
    expect(promptTargets.targets).toContainEqual(expect.objectContaining({
      target_node: "run_experiments",
      recommended_prompt_node: "design_experiments"
    }));
  });

  it("binds a verified mutation-isolation report into the adjudicated suite", async () => {
    const workspace = await createWorkspace();
    const annotationPack = await exportPromotionAnnotationPack({
      cwd: workspace,
      suitePath: "suite/suite.json",
      outDir: "annotation-pack"
    });
    const annotationMap = JSON.parse(await readFile(
      path.join(workspace, annotationPack.private_map_path),
      "utf8"
    )) as PrivateMap;
    await writeAnnotations(workspace, "labels-a.jsonl", annotationMap, "annotator-alpha");
    await writeAnnotations(workspace, "labels-b.jsonl", annotationMap, "annotator-beta");

    const mutationPack = await exportPromotionMutationAuditPack({
      cwd: workspace,
      suitePath: "suite/suite.json",
      outDir: "mutation-audit-pack"
    });
    const mutationTasks = (await readFile(path.join(workspace, mutationPack.tasks_path), "utf8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as { audit_id: string });
    await writeMutationAudits(workspace, "mutation-a.jsonl", mutationTasks, "mutation-auditor-alpha");
    await writeMutationAudits(workspace, "mutation-b.jsonl", mutationTasks, "mutation-auditor-beta");
    const mutationVerification = await verifyPromotionMutationAudit({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: mutationPack.private_map_path,
      auditPaths: ["mutation-a.jsonl", "mutation-b.jsonl"],
      outDir: "mutation-verification"
    });

    const result = await adjudicatePromotionBenchmark({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: annotationPack.private_map_path,
      annotationPaths: ["labels-a.jsonl", "labels-b.jsonl"],
      mutationAuditReportPath: mutationVerification.report_path,
      outDir: "fully-adjudicated"
    });
    expect(result.report).toMatchObject({
      passed: true,
      mutation_isolation: {
        status: "double_verified",
        report_path: mutationVerification.report_path,
        validation_issues: []
      },
      eligibility: { paper_claim_eligible: false }
    });
    expect(result.report.eligibility.blockers.map((blocker) => blocker.code))
      .not.toContain("mutation_isolation_double_audit_incomplete");
    const loaded = await loadPromotionBenchmarkSuite(path.join(workspace, result.suite_path || "missing"));
    expect(loaded.issues).toEqual([]);
    expect(loaded.suite?.manifest).toMatchObject({
      adjudication_status: "double_adjudicated",
      mutation_isolation_status: "double_verified",
      execution_provenance_status: "artifact_verified",
      paper_claim_eligible: false
    });

    await writeMutationAudits(workspace, "mutation-overlap-a.jsonl", mutationTasks, "annotator-alpha");
    await writeMutationAudits(workspace, "mutation-overlap-b.jsonl", mutationTasks, "mutation-auditor-beta");
    const overlappingVerification = await verifyPromotionMutationAudit({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: mutationPack.private_map_path,
      auditPaths: ["mutation-overlap-a.jsonl", "mutation-overlap-b.jsonl"],
      outDir: "mutation-verification-overlap"
    });
    const overlappingRoles = await adjudicatePromotionBenchmark({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: annotationPack.private_map_path,
      annotationPaths: ["labels-a.jsonl", "labels-b.jsonl"],
      mutationAuditReportPath: overlappingVerification.report_path,
      outDir: "role-overlap-adjudication"
    });
    expect(overlappingRoles.report.passed).toBe(true);
    expect(overlappingRoles.report.mutation_isolation).toMatchObject({
      status: "unreviewed",
      validation_issues: [expect.objectContaining({ code: "mutation_auditors_not_role_separated" })]
    });
    expect(overlappingRoles.report.eligibility.paper_claim_eligible).toBe(false);
  });

  it("requires distinct full-coverage initial adjudicators", async () => {
    const workspace = await createWorkspace();
    const exported = await exportPromotionAnnotationPack({ cwd: workspace, suitePath: "suite/suite.json", outDir: "annotation-pack" });
    const privateMap = JSON.parse(await readFile(path.join(workspace, exported.private_map_path), "utf8")) as PrivateMap;
    await writeAnnotations(workspace, "labels-a.jsonl", privateMap, "annotator-shared");
    const firstOnly = { ...privateMap, entries: privateMap.entries.slice(0, 1) };
    await writeAnnotations(workspace, "labels-b.jsonl", firstOnly, "annotator-shared");

    const result = await adjudicatePromotionBenchmark({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: exported.private_map_path,
      annotationPaths: ["labels-a.jsonl", "labels-b.jsonl"],
      outDir: "invalid"
    });
    expect(result.report.passed).toBe(false);
    expect(result.report.validation_issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "initial_adjudicators_not_independent",
      "annotation_case_coverage_incomplete"
    ]));
    const recommendations = JSON.parse(await readFile(
      path.join(workspace, "invalid", "review", "node_strengthening_recommendations.json"),
      "utf8"
    )) as { recommendations: Array<{ node: string }> };
    expect(recommendations.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ node: "review" })
    ]));
  });

  it("rejects repair owners outside the fixed workflow contract", async () => {
    const workspace = await createWorkspace();
    const exported = await exportPromotionAnnotationPack({ cwd: workspace, suitePath: "suite/suite.json", outDir: "annotation-pack" });
    const privateMap = JSON.parse(await readFile(path.join(workspace, exported.private_map_path), "utf8")) as PrivateMap;
    await writeAnnotations(workspace, "labels-a.jsonl", privateMap, "annotator-alpha", {
      "case-fault": { decision: "block", blocking_concerns: ["comparison_evidence_gap"], repair_owners: ["imaginary_node"] }
    });
    await writeAnnotations(workspace, "labels-b.jsonl", privateMap, "annotator-beta");

    const result = await adjudicatePromotionBenchmark({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: exported.private_map_path,
      annotationPaths: ["labels-a.jsonl", "labels-b.jsonl"],
      outDir: "invalid-owner"
    });
    expect(result.report.passed).toBe(false);
    expect(result.report.validation_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "annotation_record_invalid", message: expect.stringContaining("imaginary_node") })
    ]));
  });

  it("rejects case-manifest or artifact drift after blind export", async () => {
    const manifestWorkspace = await createWorkspace();
    const manifestExport = await exportPromotionAnnotationPack({
      cwd: manifestWorkspace,
      suitePath: "suite/suite.json",
      outDir: "annotation-pack"
    });
    const manifestMap = JSON.parse(await readFile(path.join(manifestWorkspace, manifestExport.private_map_path), "utf8")) as PrivateMap;
    await writeAnnotations(manifestWorkspace, "labels-a.jsonl", manifestMap, "annotator-alpha");
    await writeAnnotations(manifestWorkspace, "labels-b.jsonl", manifestMap, "annotator-beta");
    const faultManifestPath = path.join(manifestWorkspace, "suite", "cases", "case-fault.json");
    const faultManifest = JSON.parse(await readFile(faultManifestPath, "utf8")) as Record<string, unknown>;
    faultManifest.gold = { decision: "downgrade", blocking_concerns: [], repair_owners: [] };
    await writeFile(faultManifestPath, `${JSON.stringify(faultManifest, null, 2)}\n`, "utf8");
    const manifestDrift = await adjudicatePromotionBenchmark({
      cwd: manifestWorkspace,
      suitePath: "suite/suite.json",
      privateMapPath: manifestExport.private_map_path,
      annotationPaths: ["labels-a.jsonl", "labels-b.jsonl"],
      outDir: "manifest-drift"
    });
    expect(manifestDrift.report.passed).toBe(false);
    expect(manifestDrift.report.validation_issues.map((issue) => issue.code)).toContain("annotation_map_case_manifest_hash_mismatch");

    const artifactWorkspace = await createWorkspace();
    const cleanManifestPath = path.join(artifactWorkspace, "suite", "cases", "case-clean.json");
    const cleanManifest = JSON.parse(await readFile(cleanManifestPath, "utf8")) as Record<string, unknown>;
    delete cleanManifest.artifact_sha256;
    await writeFile(cleanManifestPath, `${JSON.stringify(cleanManifest, null, 2)}\n`, "utf8");
    const artifactExport = await exportPromotionAnnotationPack({
      cwd: artifactWorkspace,
      suitePath: "suite/suite.json",
      outDir: "annotation-pack"
    });
    const artifactMap = JSON.parse(await readFile(path.join(artifactWorkspace, artifactExport.private_map_path), "utf8")) as PrivateMap;
    await writeAnnotations(artifactWorkspace, "labels-a.jsonl", artifactMap, "annotator-alpha");
    await writeAnnotations(artifactWorkspace, "labels-b.jsonl", artifactMap, "annotator-beta");
    await writeFile(
      path.join(artifactWorkspace, "suite", "artifacts", "case-clean", "result_table.json"),
      '{"rows":[{"metric":"primary_score","baseline":0.1,"comparator":0.9}]}\n',
      "utf8"
    );
    const artifactDrift = await adjudicatePromotionBenchmark({
      cwd: artifactWorkspace,
      suitePath: "suite/suite.json",
      privateMapPath: artifactExport.private_map_path,
      annotationPaths: ["labels-a.jsonl", "labels-b.jsonl"],
      outDir: "artifact-drift"
    });
    expect(artifactDrift.report.passed).toBe(false);
    expect(artifactDrift.report.validation_issues.map((issue) => issue.code)).toContain("annotation_map_artifact_hash_mismatch");
  });

  it("promotes eligibility only at the frozen external, held-out, paired scale floor", () => {
    const cases: PromotionBenchmarkCaseManifest[] = [];
    for (
      let baseIndex = 0;
      baseIndex < MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES;
      baseIndex += 1
    ) {
      const baseBundleId = `base-${baseIndex + 1}`;
      const sourceHash = baseIndex.toString(16).padStart(64, "0");
      const sourceFamilyHash = hashId(`source-family-${(baseIndex % 4) + 1}`);
      const operatorGroupHash = hashId(`operator-group-${(baseIndex % 4) + 1}`);
      const clean = caseManifest(`${baseBundleId}-clean`, baseBundleId, sourceHash, sourceFamilyHash, operatorGroupHash);
      if (baseIndex === 1) clean.gold.decision = "block";
      cases.push(clean);
      for (const family of REQUIRED_CONFIRMATORY_MUTATION_FAMILIES) {
        cases.push(caseManifest(`${baseBundleId}-${family}`, baseBundleId, sourceHash, sourceFamilyHash, operatorGroupHash, family));
      }
    }

    expect(evaluatePromotionAdjudicationEligibility({
      evidence_class: "external_real_run",
      execution_provenance_status: "artifact_verified",
      source_diversity_status: "declared_stratified",
      cases,
      adjudication_complete: true,
      mutation_isolation_verified: true
    })).toMatchObject({
      paper_claim_eligible: true,
      base_bundle_count: MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
      case_count: MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES,
      source_family_count: 4,
      operator_group_count: 4,
      blockers: []
    });
    expect(evaluatePromotionAdjudicationEligibility({
      evidence_class: "synthetic_development",
      execution_provenance_status: "artifact_verified",
      source_diversity_status: "declared_stratified",
      cases,
      adjudication_complete: true,
      mutation_isolation_verified: true
    }).paper_claim_eligible).toBe(false);
    expect(evaluatePromotionAdjudicationEligibility({
      evidence_class: "external_real_run",
      execution_provenance_status: "artifact_verified",
      source_diversity_status: "declared_stratified",
      cases,
      adjudication_complete: true,
      mutation_isolation_verified: false
    }).blockers.map((blocker) => blocker.code)).toContain("mutation_isolation_double_audit_incomplete");

    const concentratedCases = cases.map((benchmarkCase) => ({
      ...benchmarkCase,
      source_family_id_sha256: hashId("shared-source-family"),
      operator_group_id_sha256: hashId("shared-operator-group")
    }));
    expect(evaluatePromotionAdjudicationEligibility({
      evidence_class: "external_real_run",
      execution_provenance_status: "artifact_verified",
      source_diversity_status: "declared_stratified",
      cases: concentratedCases,
      adjudication_complete: true,
      mutation_isolation_verified: true
    }).blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "source_family_minimum_not_met",
      "operator_group_minimum_not_met",
      "source_family_share_exceeded",
      "operator_group_share_exceeded"
    ]));
  });

  it("returns a failing process status when score validation fails", async () => {
    const workspace = await createWorkspace();
    await writeFile(path.join(workspace, "empty-predictions.jsonl"), "", "utf8");
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      await runPromotionBenchmarkScoreCli({
        cwd: workspace,
        suitePath: "suite/suite.json",
        predictionsPath: "empty-predictions.jsonl",
        outDir: "invalid-score"
      });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

interface PrivateMap {
  entries: Array<{ annotation_id: string; case_id: string }>;
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-adjudication-"));
  tempDirs.push(workspace);
  await mkdir(path.join(workspace, "bundle"), { recursive: true });
  await writeFile(path.join(workspace, "bundle", "result_table.json"), '{"rows":[{"metric":"primary_score","baseline":0.5,"comparator":0.6}]}\n', "utf8");
  await writeExecutionEvidence(path.join(workspace, "bundle"));
  await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
    schema_version: "1.0",
    suite_id: "adjudication-suite",
    evidence_class: "external_real_run",
    paper_claim_eligible: false,
    adjudication_status: "unreviewed",
    mutation_isolation_status: "unreviewed",
    execution_provenance_status: "artifact_verified",
    cases: [
      {
        case_id: "case-clean",
        base_bundle_id: "base-alpha",
        split: "test",
        source_root: "bundle",
        operations: [],
        gold: { decision: "promote", blocking_concerns: [], repair_owners: [] }
      },
      {
        case_id: "case-fault",
        base_bundle_id: "base-alpha",
        split: "test",
        source_root: "bundle",
        mutation_family: "comparison_evidence_gap",
        operations: [{ op: "remove_json_pointer", path: "result_table.json", pointer: "/rows/0/comparator" }],
        gold: { decision: "needs_review", blocking_concerns: [], repair_owners: [] }
      }
    ]
  }, null, 2));
  await buildPromotionBenchmarkSuite({ cwd: workspace, recipePath: "recipe.json", outDir: "suite" });
  return workspace;
}

async function writeExecutionEvidence(root: string): Promise<void> {
  const artifacts = [
    { role: "run_config", path: "run-config.json", content: '{"trials":3}\n' },
    { role: "event_log", path: "events.jsonl", content: '{"event":"completed"}\n' },
    { role: "metrics", path: "metrics.json", content: '{"primary_score":0.6}\n' },
    { role: "review_decision", path: "review/decision.json", content: '{"outcome":"accept"}\n' },
    { role: "command", path: "command.txt", content: "runner --config run-config.json\n" },
    { role: "execution_log", path: "execution.log", content: "completed\n" }
  ];
  for (const artifact of artifacts) {
    await mkdir(path.dirname(path.join(root, artifact.path)), { recursive: true });
    await writeFile(path.join(root, artifact.path), artifact.content, "utf8");
  }
  await writeFile(path.join(root, "execution-evidence.json"), `${JSON.stringify({
    schema_version: "1.0",
    evidence_class: "external_real_run",
    run_id: "run-adjudication-fixture",
    execution_mode: "real_execution",
    execution_status: "completed",
    execution_backend: "local_runtime",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:01:00.000Z",
    exit_code: 0,
    trial_ids: ["trial-a", "trial-b", "trial-c"],
    artifacts: artifacts.map((artifact) => ({
      role: artifact.role,
      path: artifact.path,
      sha256: createHash("sha256").update(artifact.content).digest("hex")
    }))
  }, null, 2)}\n`, "utf8");
}

async function writeAnnotations(
  workspace: string,
  fileName: string,
  privateMap: PrivateMap,
  adjudicatorId: string,
  overrides: Record<string, PromotionAnnotationLabel> = {}
): Promise<void> {
  const rows = privateMap.entries.map((entry) => {
    const label = overrides[entry.case_id] || (entry.case_id === "case-clean"
      ? { decision: "promote" as const, blocking_concerns: [], repair_owners: [] }
      : { decision: "block" as const, blocking_concerns: ["comparison_evidence_gap"], repair_owners: ["design_experiments"] });
    return JSON.stringify(annotationRecord(entry.annotation_id, adjudicatorId, label));
  });
  await writeFile(path.join(workspace, fileName), `${rows.join("\n")}\n`, "utf8");
}

function annotationRecord(annotationId: string, adjudicatorId: string, label: PromotionAnnotationLabel) {
  return {
    schema_version: "1.0",
    annotation_id: annotationId,
    adjudicator_id: adjudicatorId,
    label_source: "human",
    ...label,
    rationale: "Artifact-grounded independent judgment."
  };
}

async function writeMutationAudits(
  workspace: string,
  fileName: string,
  tasks: Array<{ audit_id: string }>,
  auditorId: string
): Promise<void> {
  const rows = tasks.map((task) => JSON.stringify({
    schema_version: "1.0",
    audit_id: task.audit_id,
    auditor_id: auditorId,
    audit_source: "human",
    decision: "isolated",
    additional_faults: [],
    rationale: "The pair differs only according to the declared mutation operation."
  }));
  await writeFile(path.join(workspace, fileName), `${rows.join("\n")}\n`, "utf8");
}

function caseManifest(
  caseId: string,
  baseBundleId: string,
  sourceSha256: string,
  sourceFamilyIdSha256: string,
  operatorGroupIdSha256: string,
  mutationFamily?: string
): PromotionBenchmarkCaseManifest {
  return {
    schema_version: "1.0",
    case_id: caseId,
    base_bundle_id: baseBundleId,
    split: "test",
    artifact_root: `../artifacts/${caseId}`,
    source_sha256: sourceSha256,
    source_family_id_sha256: sourceFamilyIdSha256,
    operator_group_id_sha256: operatorGroupIdSha256,
    artifact_sha256: "f".repeat(64),
    ...(mutationFamily ? { mutation_family: mutationFamily } : {}),
    gold: { decision: mutationFamily ? "block" : "promote", blocking_concerns: [], repair_owners: [] }
  };
}

function hashId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
