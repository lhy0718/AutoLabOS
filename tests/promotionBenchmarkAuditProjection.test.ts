import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { exportPromotionAuditPackage } from "../src/core/benchmark/promotionBenchmarkAuditProjection.js";

const execFileAsync = promisify(execFile);

describe("promotion benchmark audit projection", () => {
  it("exports a hash-bound canonical audit package without promoting paper_ready", async () => {
    const fixture = await createFixture();
    const result = await exportPromotionAuditPackage(fixture.input);
    const packageRoot = path.join(fixture.root, "package");
    const verifierRef = "scripts/verify-audit-package-v1.mjs";
    const verifierPath = path.join(packageRoot, verifierRef);

    const readiness = await readJson(path.join(packageRoot, "paper", "paper_readiness.json"));
    const governanceCondition = await readJson(path.join(packageRoot, "governance_condition.json"));
    const reviewDecision = await readJson(path.join(packageRoot, "review", "decision.json"));
    const paperCritique = await readJson(path.join(packageRoot, "review", "paper_critique.json"));
    const submissionStatus = await readJson(path.join(packageRoot, "paper", "submission_status.json"));
    const handoffProjection = await readJson(
      path.join(packageRoot, "paper", "reference-review-handoff", "package-manifest.json")
    );
    const resultTable = await readJson(path.join(packageRoot, "result_table.json")) as unknown[];
    const runConfig = await readJson(path.join(packageRoot, "run_config.json")) as {
      planned_budget: {
        benchmark_decision_trials_per_rule_system: number;
        provider_receipt_trials: number;
      };
      executed_budget: {
        benchmark_decision_trials_per_rule_system: number;
        provider_receipt_trials: number;
      };
      provider_receipts_are_statistical_replicates: boolean;
    };
    const runRecord = await readJson(path.join(packageRoot, "run_record.json")) as {
      executed_budget: {
        trials: number;
        trials_semantics: string;
        benchmark_decision_trials_per_rule_system: number;
        provider_receipt_trials: number;
      };
    };
    const experimentEvidence = await readJson(path.join(packageRoot, "experiment_evidence.json")) as {
      trials: unknown[];
      trial_semantics: string;
    };
    const figureAudit = await readJson(path.join(packageRoot, "figure_audit", "figure_audit_summary.json")) as {
      review_block_required: boolean;
      checked_result_row_count: number;
    };
    const support = await readJson(path.join(packageRoot, "projection-support-manifest.json")) as {
      files: Array<{ path: string }>;
    };
    const projection = await readJson(path.join(packageRoot, "projection-manifest.json")) as {
      verification: {
        script_path: string;
        script_version: string;
        script_sha256: string;
        reproducibility_guide_path: string;
        reproducibility_guide_sha256: string;
        node_runtime: { exact_version: string; source: string };
      };
      semantic_expectations: {
        benchmark_case_count: number;
        base_bundle_count: number;
        system_count: number;
        scored_prediction_count: number;
        provider_trial_count: number;
        supported_claim_count: number;
        projected_result_row_count: number;
      };
      files: Array<{ path: string; sha256: string; bytes: number }>;
    };
    const gate = await readJson(path.join(packageRoot, "evidence", "gate.json")) as {
      case_count: number;
      base_bundle_count: number;
      system_roles: {
        ungated: string;
        checklist: string;
        manuscript: string;
        full: string;
        ablations: string[];
      };
    };
    const score = await readJson(path.join(packageRoot, "evidence", "score.json")) as {
      prediction_count: number;
    };
    const providerAggregate = await readJson(
      path.join(packageRoot, "evidence", "provider-aggregate.json")
    ) as { source_runs: unknown[] };
    const projectedClaims = await readJson(
      path.join(packageRoot, "paper", "claim_evidence_table.json")
    ) as { claims: unknown[] };
    const [guide, verifier, verifierStat] = await Promise.all([
      fs.readFile(path.join(packageRoot, "REPRODUCIBILITY.md"), "utf8"),
      fs.readFile(verifierPath, "utf8"),
      fs.stat(verifierPath)
    ]);
    const roleCount = new Set([
      gate.system_roles.ungated,
      gate.system_roles.checklist,
      gate.system_roles.manuscript,
      gate.system_roles.full,
      ...gate.system_roles.ablations
    ]).size;

    expect(readiness).toMatchObject({ paper_ready: false, readiness_state: "paper_scale_candidate" });
    expect(readiness.remaining_gates).toEqual([
      "human_reference_authority",
      "submission_reference_audit"
    ]);
    expect(governanceCondition.remaining_gates).toEqual(readiness.remaining_gates);
    expect(reviewDecision.remaining_gates).toEqual(readiness.remaining_gates);
    expect(paperCritique.remaining_gates).toEqual(readiness.remaining_gates);
    expect(submissionStatus).toMatchObject({
      reference_evidence: {
        status_artifact_package_ref: "paper/reference_evidence_status.json",
        review_handoff: {
          manifest_package_ref: "paper/reference-review-handoff/package-manifest.json"
        }
      },
      model_review: {
        claim_evidence_review_package_ref: "paper/model_claim_evidence_review.json",
        citation_review_package_ref: "papers/promotion-governance/model-citation-review-receipt.json"
      }
    });
    expect(handoffProjection).toMatchObject({
      schema_version: "1.0",
      manuscript: { source_ref: "manuscript.tex", package_ref: "paper/main.tex" },
      source_inputs: expect.arrayContaining([
        expect.objectContaining({ role: "claims", package_ref: "paper/refgate_claims.tsv" }),
        expect.objectContaining({ role: "status", package_ref: "paper/reference_evidence_status.json" }),
        expect.objectContaining({ role: "lock", package_ref: "paper/refgate.lock.json" })
      ])
    });
    expect(resultTable).toHaveLength(projection.semantic_expectations.projected_result_row_count);
    expect(resultTable).toEqual(expect.arrayContaining([
      expect.objectContaining({
        baseline_system_id: gate.system_roles.checklist,
        comparator_system_id: gate.system_roles.full,
        contrast: "comparator_minus_baseline",
        source_trial_count: 1,
        provider_receipt_trial_count: providerAggregate.source_runs.length,
        provider_receipts_are_statistical_replicates: false
      })
    ]));
    expect(runConfig).toMatchObject({
      planned_budget: {
        benchmark_decision_trials_per_rule_system: 1,
        provider_receipt_trials: providerAggregate.source_runs.length
      },
      executed_budget: {
        benchmark_decision_trials_per_rule_system: 1,
        provider_receipt_trials: providerAggregate.source_runs.length
      },
      provider_receipts_are_statistical_replicates: false
    });
    expect(runRecord.executed_budget).toMatchObject({
      trials: providerAggregate.source_runs.length,
      trials_semantics: "provider_receipts",
      benchmark_decision_trials_per_rule_system: 1,
      provider_receipt_trials: providerAggregate.source_runs.length
    });
    expect(experimentEvidence.trials).toHaveLength(providerAggregate.source_runs.length);
    expect(experimentEvidence.trial_semantics).toBe("provider_receipts_not_statistical_replicates");
    expect(figureAudit).toMatchObject({
      review_block_required: false,
      checked_result_row_count: roleCount
    });
    await expect(fs.stat(path.join(packageRoot, "paper", "layout_validation.json"))).resolves.toBeDefined();
    await expect(fs.stat(path.join(packageRoot, "paper", "model_claim_evidence_review.json"))).resolves.toBeDefined();
    await expect(readJson(path.join(packageRoot, "paper", "final_model_review_receipt.json")))
      .resolves.toMatchObject({ artifact_type: "FinalModelReviewPublicReceipt" });
    await expect(readJson(path.join(packageRoot, "paper", "final_ci_receipt.json")))
      .resolves.toMatchObject({ artifact_type: "FinalCIReceipt", status: "passed" });
    expect(projection.semantic_expectations).toMatchObject({
      benchmark_case_count: gate.case_count,
      base_bundle_count: gate.base_bundle_count,
      system_count: roleCount,
      scored_prediction_count: score.prediction_count,
      provider_trial_count: providerAggregate.source_runs.length,
      supported_claim_count: projectedClaims.claims.length,
      projected_result_row_count: resultTable.length
    });
    expect(projection.verification.script_path).toBe(verifierRef);
    expect(projection.verification.script_version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(projection.verification.script_sha256).toBe(await sha256File(verifierPath));
    expect(projection.verification.reproducibility_guide_sha256)
      .toBe(await sha256File(path.join(packageRoot, "REPRODUCIBILITY.md")));
    expect(projection.verification.node_runtime).toEqual({
      exact_version: process.versions.node,
      source: "system_run_manifest.runtime_binding.node_version"
    });
    expect(projection.files.some((file) => file.path === verifierRef)).toBe(true);
    expect(support.files.some((file) => file.path === "projection-manifest.json")).toBe(true);
    expect(support.files.some((file) => file.path === verifierRef)).toBe(true);
    expect(verifierStat.mode & 0o111).not.toBe(0);

    expect(guide).toContain("## Clean-Room Procedure");
    expect(guide).toContain("Node.js `" + process.versions.node + "` exactly for semantic replay");
    expect(guide).toContain("application compatibility");
    expect(guide).toContain("package-local TypeScript compiler");
    expect(guide).not.toContain("web build toolchain");
    expect(guide).toContain("node ./scripts/verify-audit-package-v1.mjs --integrity-only");
    expect(guide).toContain("node ./scripts/verify-audit-package-v1.mjs --semantic-only");
    expect(guide).toContain("node ./scripts/verify-audit-package-v1.mjs --pdf-only");
    expect(guide).toContain("| Benchmark cases | " + String(gate.case_count) + " |");
    expect(guide).toContain("Artifact verification is not corpus regeneration.");
    expect(guide).toContain("seed_sha256");
    expect(guide).not.toMatch(/\/home\/|\/Users\/|\/tmp\//u);
    expect(verifier).toContain("loadPromotionBenchmarkSuite");
    expect(verifier).toContain("buildVerificationRuntime");
    expect(verifier).toContain("verifyNodeRuntime");
    expect(verifier).toContain("await verifyIntegrity(manifest, {");
    expect(verifier).toContain("await verifyPackageClosure(files, supportBindings)");
    expect(verifier).toContain("runtime.benchmarkModulePath");
    expect(verifier).toContain("verifyReferenceReviewProjection");
    expect(verifier).toContain("verifyProjectedResultRows");
    expect(verifier).not.toContain('path.join(ROOT, "dist", "core", "benchmark", "promotionBenchmark.js")');
    expect(verifier).not.toContain('path.join(ROOT, "dist", "cli", "main.js")');
    expect(verifier).toContain("gate-promotion-confirmatory");
    expect(verifier).toContain("run-promotion");
    expect(verifier).toContain("run-promotion-controlled-recovery");
    expect(verifier).toContain("deterministic_system_execution");
    expect(verifier).toContain("artifact_verification_only_seed_preimage_unavailable");
    expect(verifier).toContain("--report <path>");
    expect(verifier).toContain("hashSystemRuntimeSourceTree(ROOT)");
    expect(verifier).not.toContain('source_tree_sha256 = "<replay-source-tree>"');
    expect(verifier).toContain(String.raw`.match(/^Pages:\s+(\d+)$/mu)`);
    expect(verifier).toContain(String.raw`.split(/\r?\n/u)`);
    expect(verifier).not.toContain(String.raw`.split(/\\r?\\n/u)`);
    expect(verifier).toContain('ROOT, "confirmatory verification CLI", [0, 1]');
    expect(verifier).toContain("normalizeRepairExecution(rerunRepairExecutionManifest)");
    expect(verifier).toContain("latexmk");
    expect(verifier).toContain("pdflatex");
    expect(verifier).not.toContain("suite-fixture");
    expect(verifier).not.toContain("fixture-model");
    expect(projection.files.some((file) => /(?:\.orig|\.bak)$/u.test(file.path))).toBe(false);
    expect(support.files.some((file) => /(?:\.orig|\.bak)$/u.test(file.path))).toBe(false);
    await expect(fs.stat(path.join(packageRoot, "src", "index.ts.orig"))).rejects.toThrow();
    await expect(fs.stat(path.join(packageRoot, "scripts", "lib", "fixture.mjs.bak"))).rejects.toThrow();

    const versionRun = await execFileAsync(
      process.execPath,
      [verifierPath, "--version"],
      { cwd: packageRoot, encoding: "utf8" }
    );
    expect(versionRun.stdout.trim()).toBe(projection.verification.script_version);
    const integrityRun = await execFileAsync(
      process.execPath,
      [verifierPath, "--integrity-only"],
      { cwd: packageRoot, encoding: "utf8" }
    );
    const integrityReport = JSON.parse(integrityRun.stdout) as {
      status: string;
      phases: {
        integrity: {
          status: string;
          projection_file_count: number;
          package_closure: { status: string; unexpected_file_count: number };
        };
      };
    };
    expect(integrityReport).toMatchObject({
      status: "passed",
      phases: { integrity: { status: "passed" } }
    });
    expect(integrityReport.phases.integrity.projection_file_count).toBe(projection.files.length);
    expect(integrityReport.phases.integrity.package_closure).toEqual(expect.objectContaining({
      status: "passed",
      unexpected_file_count: 0
    }));
    const retainedReportPath = path.join(fixture.root, "retained-integrity-report.json");
    const retainedRun = await execFileAsync(
      process.execPath,
      [verifierPath, "--integrity-only", "--report", retainedReportPath],
      { cwd: packageRoot, encoding: "utf8" }
    );
    expect(await readJson(retainedReportPath)).toEqual(JSON.parse(retainedRun.stdout));

    await expect(fs.stat(path.join(packageRoot, "unrelated-generated-output"))).rejects.toThrow();
    expect(result.claim_count).toBe(projectedClaims.claims.length);
    expect(result.trial_count).toBe(providerAggregate.source_runs.length);
  });

  it("detects a post-export byte change with the package-local verifier", async () => {
    const fixture = await createFixture();
    await exportPromotionAuditPackage(fixture.input);
    const packageRoot = path.join(fixture.root, "package");
    const verifierPath = path.join(packageRoot, "scripts", "verify-audit-package-v1.mjs");
    await fs.appendFile(path.join(packageRoot, "result_table.json"), "\n", "utf8");

    await expect(execFileAsync(
      process.execPath,
      [verifierPath, "--integrity-only"],
      { cwd: packageRoot, encoding: "utf8" }
    )).rejects.toMatchObject({
      stderr: expect.stringContaining("Byte count mismatch: result_table.json")
    });
  });

  it("projects gate and score to canonical package paths from noncanonical source paths", async () => {
    const fixture = await createFixture();
    const sourceDir = path.join(fixture.root, "frozen-run");
    await fs.mkdir(sourceDir, { recursive: true });
    const scoreSource = path.join(sourceDir, "result.json");
    await fs.rename(path.join(fixture.root, "evidence", "score.json"), scoreSource);
    const gate = await readJson(path.join(fixture.root, "evidence", "gate.json")) as {
      artifacts: { score_report_ref: string; score_report_sha256: string };
    };
    gate.artifacts.score_report_ref = "frozen-run/result.json";
    gate.artifacts.score_report_sha256 = await sha256File(scoreSource);
    const gateSource = path.join(sourceDir, "decision.json");
    await writeJson(gateSource, gate);
    await fs.rm(path.join(fixture.root, "evidence", "gate.json"));
    fixture.input.gatePath = "frozen-run/decision.json";

    await exportPromotionAuditPackage(fixture.input);

    expect(await readJson(path.join(fixture.root, "package", "evidence", "gate.json")))
      .toEqual(gate);
    expect(await readJson(path.join(fixture.root, "package", "evidence", "score.json")))
      .toEqual(await readJson(scoreSource));
  });

  it("rejects an unmanifested file in the strict pre-install closure check", async () => {
    const fixture = await createFixture();
    await exportPromotionAuditPackage(fixture.input);
    const packageRoot = path.join(fixture.root, "package");
    const verifierPath = path.join(packageRoot, "scripts", "verify-audit-package-v1.mjs");
    await fs.writeFile(path.join(packageRoot, "unmanifested.txt"), "unexpected\n", "utf8");

    await expect(execFileAsync(
      process.execPath,
      [verifierPath, "--integrity-only"],
      { cwd: packageRoot, encoding: "utf8" }
    )).rejects.toMatchObject({
      stderr: expect.stringContaining("Package closure contains unmanifested files: unmanifested.txt")
    });
  });

  it("rejects rehashed projection lineage and readiness metadata drift", async () => {
    const cases: Array<{
      mutate: (projection: Record<string, unknown>) => void;
      expected: string;
    }> = [
      {
        mutate: (projection) => { projection.source_support_manifest_sha256 = "0".repeat(64); },
        expected: "source support manifest hash disagrees"
      },
      {
        mutate: (projection) => { projection.claim_ceiling = "naturalistic_generalization_supported"; },
        expected: "claim ceilings disagree"
      },
      {
        mutate: (projection) => { projection.readiness_state = "blocked_for_paper_scale"; },
        expected: "readiness states disagree"
      },
      {
        mutate: (projection) => { projection.paper_ready = true; },
        expected: "paper_ready values must all remain false"
      }
    ];

    for (const testCase of cases) {
      const fixture = await createFixture();
      await exportPromotionAuditPackage(fixture.input);
      const packageRoot = path.join(fixture.root, "package");
      await mutatePackageJsonAndRebind(
        packageRoot,
        "projection-manifest.json",
        testCase.mutate
      );
      const verifierPath = path.join(packageRoot, "scripts", "verify-audit-package-v1.mjs");
      await expect(execFileAsync(
        process.execPath,
        [verifierPath, "--integrity-only"],
        { cwd: packageRoot, encoding: "utf8" }
      )).rejects.toMatchObject({ stderr: expect.stringContaining(testCase.expected) });
    }
  });

  it("rejects rehashed reference-review source mapping drift", async () => {
    const fixture = await createFixture();
    await exportPromotionAuditPackage(fixture.input);
    const packageRoot = path.join(fixture.root, "package");
    await mutatePackageJsonAndRebind(
      packageRoot,
      "paper/reference-review-handoff/package-manifest.json",
      (projection) => {
        const sourceInputs = projection.source_inputs as Array<Record<string, unknown>>;
        sourceInputs[0]!.source_ref = "different-claims.tsv";
      }
    );
    const verifierPath = path.join(packageRoot, "scripts", "verify-audit-package-v1.mjs");
    await expect(execFileAsync(
      process.execPath,
      [verifierPath, "--integrity-only"],
      { cwd: packageRoot, encoding: "utf8" }
    )).rejects.toMatchObject({
      stderr: expect.stringContaining("projected input mapping disagrees")
    });
  });

  it("fails semantic verification before compilation when the exact Node runtime differs", async () => {
    const fixture = await createFixture({ nodeVersion: "0.0.0" });
    await exportPromotionAuditPackage(fixture.input);
    const packageRoot = path.join(fixture.root, "package");
    const verifierPath = path.join(packageRoot, "scripts", "verify-audit-package-v1.mjs");

    await expect(execFileAsync(
      process.execPath,
      [verifierPath, "--semantic-only"],
      { cwd: packageRoot, encoding: "utf8" }
    )).rejects.toMatchObject({
      stderr: expect.stringContaining("Semantic verification requires Node.js 0.0.0 exactly")
    });
  });

  it("rejects a support file that changed after its manifest was frozen", async () => {
    const fixture = await createFixture();
    await fs.writeFile(path.join(fixture.root, "evidence", "claim.txt"), "changed\n", "utf8");

    await expect(exportPromotionAuditPackage(fixture.input)).rejects.toThrow("Support binding mismatch");
  });

  it("rejects a system run manifest bound to a stale execution source tree", async () => {
    const fixture = await createFixture();
    await fs.appendFile(path.join(fixture.root, "src", "index.ts"), "// changed after execution\n", "utf8");

    await expect(exportPromotionAuditPackage(fixture.input)).rejects.toThrow(
      "System run manifest source tree SHA-256 does not match the export source tree"
    );
  });

  it("rejects a manuscript result row that disagrees with the score report", async () => {
    const fixture = await createFixture();
    const manuscriptPath = path.join(fixture.root, "paper-source", "manuscript.tex");
    const manuscript = await fs.readFile(manuscriptPath, "utf8");
    await fs.writeFile(manuscriptPath, manuscript.replace("Governed & 1 & 1.000", "Governed & 1 & .500"), "utf8");
    const manuscriptSha256 = await sha256File(manuscriptPath);
    const layoutPath = path.join(fixture.root, "paper-source", "layout-validation.json");
    const layout = await readJson(layoutPath) as { artifacts: { manuscript_tex_sha256: string } };
    layout.artifacts.manuscript_tex_sha256 = manuscriptSha256;
    await writeJson(layoutPath, layout);
    const claimReviewPath = path.join(fixture.root, "paper-source", "model-claim-evidence-review.json");
    const claimReview = await readJson(claimReviewPath) as { manuscript_sha256: string };
    claimReview.manuscript_sha256 = manuscriptSha256;
    await writeJson(claimReviewPath, claimReview);

    await expect(exportPromotionAuditPackage(fixture.input)).rejects.toThrow("Manuscript table audit failed");
  });

  it("rejects a claim statement changed after independent semantic review", async () => {
    const fixture = await createFixture();
    const claimMapPath = path.join(fixture.root, "paper-source", "claim-evidence-map.json");
    const claimMap = await readJson(claimMapPath) as { claims: Array<{ statement: string }> };
    claimMap.claims[0]!.statement = "An unrelated claim linked to the same artifact.";
    await writeJson(claimMapPath, claimMap);

    await expect(exportPromotionAuditPackage(fixture.input)).rejects.toThrow(
      "Model claim evidence review receipt is malformed or exceeds its authority"
    );
  });
});

async function createFixture(options: { nodeVersion?: string } = {}): Promise<{
  root: string;
  input: {
    cwd: string;
    gatePath: string;
    paperRoot: string;
    supportRoot: string;
    supportManifestPath: string;
    outDir: string;
  };
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "audit-projection-"));
  await fs.mkdir(path.join(root, "evidence"), { recursive: true });
  await fs.mkdir(path.join(root, "paper-source"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts", "lib"), { recursive: true });
  await fs.mkdir(path.join(root, "plugins", "fixture-plugin"), { recursive: true });
  await fs.mkdir(path.join(root, ".agents", "plugins"), { recursive: true });
  await fs.mkdir(path.join(root, ".github", "workflows"), { recursive: true });
  await fs.mkdir(path.join(root, "docs", "research"), { recursive: true });
  await fs.mkdir(path.join(root, "benchmarks", "promotion-governance"), { recursive: true });
  await fs.mkdir(path.join(root, "papers", "promotion-governance"), { recursive: true });
  await fs.mkdir(path.join(root, "web", "src"), { recursive: true });
  await writeJson(path.join(root, "package.json"), {
    scripts: { build: "echo build", test: "echo test" },
    engines: { node: "20.x || 22.x || 23.x || 24.x || 25.x" }
  });
  await writeJson(path.join(root, "package-lock.json"), { lockfileVersion: 3 });
  await writeJson(path.join(root, "tsconfig.json"), { compilerOptions: {} });
  await fs.writeFile(path.join(root, "vitest.config.ts"), "export default {};\n", "utf8");
  await fs.writeFile(path.join(root, "run-tests.mjs"), "// test runner fixture\n", "utf8");
  await fs.writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  await fs.writeFile(path.join(root, ".env.example"), "EXAMPLE_VALUE=\n", "utf8");
  await fs.writeFile(path.join(root, "src", "index.ts"), "export {};\n", "utf8");
  await fs.writeFile(path.join(root, "src", "index.ts.orig"), "stale source backup\n", "utf8");
  await fs.writeFile(path.join(root, "tests", "smoke.test.ts"), "export {};\n", "utf8");
  await fs.writeFile(path.join(root, "scripts", "lib", "fixture.mjs"), "export {};\n", "utf8");
  await fs.writeFile(path.join(root, "scripts", "lib", "fixture.mjs.bak"), "stale script backup\n", "utf8");
  await fs.writeFile(path.join(root, "plugins", "fixture-plugin", "README.md"), "# Plugin\n", "utf8");
  await writeJson(path.join(root, ".agents", "plugins", "marketplace.json"), { plugins: [] });
  await fs.writeFile(path.join(root, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
  await writeJson(path.join(root, "docs", "research", "final-validation-profile.json"), { commands: [] });
  await writeJson(path.join(root, "docs", "research", "historical-output.json"), {
    output_ref: "unrelated-generated-output"
  });
  await fs.mkdir(path.join(root, "unrelated-generated-output"), { recursive: true });
  await fs.writeFile(path.join(root, "unrelated-generated-output", "must-not-copy.txt"), "historical\n", "utf8");
  await fs.writeFile(path.join(root, "docs", "research-brief-template.md"), "# Brief\n", "utf8");
  await fs.writeFile(path.join(root, "benchmarks", "promotion-governance", "README.md"), "# Benchmark\n", "utf8");
  await writeJson(path.join(root, "papers", "promotion-governance", "audit-support-manifest.json"), {
    schema_version: "1.1",
    files: []
  });
  await fs.writeFile(path.join(root, "web", "src", "main.ts"), "export {};\n", "utf8");
  await fs.writeFile(path.join(root, "web", "index.html"), "<main></main>\n", "utf8");
  await writeJson(path.join(root, "web", "package.json"), { scripts: { build: "echo build" } });
  await writeJson(path.join(root, "web", "package-lock.json"), { lockfileVersion: 3 });
  await writeJson(path.join(root, "web", "tsconfig.json"), { compilerOptions: {} });
  await fs.writeFile(path.join(root, "web", "vite.config.ts"), "export default {};\n", "utf8");
  await fs.writeFile(path.join(root, "evidence", "suite.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(root, "evidence", "base-predictions.jsonl"), "{}\n", "utf8");
  await fs.writeFile(path.join(root, "evidence", "scored-predictions.jsonl"), "{}\n", "utf8");
  await fs.writeFile(path.join(root, "evidence", "claim.txt"), "evidence\n", "utf8");
  await writeJson(path.join(root, "evidence", "noisy-paths.json"), {
    note: `This prose is not a path even though it ends with ${"x".repeat(300)}.txt\nand continues.`
  });
  const sourceRuns = [];
  for (let index = 1; index <= 3; index += 1) {
    const manifestPath = `evidence/trial-${index}.json`;
    await writeJson(path.join(root, manifestPath), { trial_id: `trial-${index}`, status: "completed" });
    sourceRuns.push({
      run_id: `run-${index}`,
      trial_id: `trial-${index}`,
      manifest_path: manifestPath,
      manifest_sha256: await sha256File(path.join(root, manifestPath)),
      provider_outputs_sha256: hashText(`output-${index}`),
      provider_responses_sha256: hashText(`response-${index}`),
      predictions_sha256: hashText(`prediction-${index}`)
    });
  }
  const systems = [
    metric("baseline-system", 1, 1, 1, 0.16666666666666666, 0.07142857142857142, null, 0, null),
    metric("checklist-system", 1, 1, 1, 0.16666666666666666, 0.07142857142857142, null, 0, null),
    metric("advisory-system", 1, 1, 1, 0.16666666666666666, 0.07142857142857142, 1, 1, 1),
    metric("model-system", 3, 0, 0, 0.5, 0.16666666666666666, 0, 0, 1),
    metric("governed-system", 1, 0, 1, 1, 1, 1, 1, 1)
  ];
  const score = {
    schema_version: "1.0",
    generated_at: "2026-01-01T00:00:00.000Z",
    suite_id: "suite-fixture",
    evidence_class: "deterministic_fault_injection_test",
    paper_claim_eligible: true,
    adjudication_status: "unreviewed",
    mutation_isolation_status: "oracle_verified",
    execution_provenance_status: "artifact_verified",
    source_diversity_status: "unavailable",
    evaluation_regime: "controlled_deterministic_fault_injection",
    claim_ceiling: "registered_fault_families_only",
    external_validation_status: "not_run",
    suite_ref: "evidence/suite.json",
    prediction_ref: "evidence/scored-predictions.jsonl",
    passed: true,
    validation_issues: [],
    case_count: 60,
    prediction_count: 420,
    systems,
    source_family_analysis: {
      availability: "unavailable",
      unavailable_reason: "source_family_assignment_incomplete",
      family_count: 0,
      families: [],
      leave_one_family_out: []
    },
    paired_analysis: { inference_unit: "base_bundle_id", bootstrap_replicates: 10, exploratory_only: false, comparisons: [] }
  };
  await writeJson(path.join(root, "evidence", "score.json"), score);
  const systemManifest = {
    status: "completed",
    runtime_binding: {
      node_version: `v${options.nodeVersion || process.versions.node}`,
      source_tree_sha256: await hashRuntimeSourceTree(root),
      package_lock_sha256: await sha256File(path.join(root, "package-lock.json"))
    },
    artifacts: {
      predictions_path: "evidence/base-predictions.jsonl",
      predictions_sha256: await sha256File(path.join(root, "evidence", "base-predictions.jsonl"))
    }
  };
  await writeJson(path.join(root, "evidence", "system-run.json"), systemManifest);
  const providerAggregate = {
    schema_version: "1.3",
    aggregate_id: "aggregate-fixture",
    status: "completed",
    protocol: "manuscript-only-v1",
    provider: "ollama",
    evidence_class: "local_model_runtime",
    execution_environment: "local_runtime",
    execution_receipt_status: "local_runtime_hash_bound",
    provider_identity_independently_verified: false,
    external_empirical_evidence_eligible: false,
    real_model_empirical_evidence_eligible: true,
    paper_claim_evidence_eligible: true,
    receipt_distinct_trial_requirement_met: true,
    evidence_boundary: "Hash-bound local executions; no external provider identity claim.",
    receipt_distinctness: {
      required_trial_count: 3,
      distinct_run_ids: true,
      distinct_trial_ids: true,
      distinct_execution_receipts: true,
      identical_prompt_pack: true,
      statistical_independence_established: false,
      statistical_replicates: false,
      caveat: "Runtime receipts do not prove statistical independence."
    },
    suite_id: "suite-fixture",
    suite_path: "evidence/suite.json",
    suite_sha256: await sha256File(path.join(root, "evidence", "suite.json")),
    source_suite: {},
    system_id: "model-system",
    requested_model: "fixture-model",
    resolved_model: "fixture-model",
    model_artifact_digest: null,
    reasoning_effort: "off",
    generated_at: "2026-01-01T00:00:00.000Z",
    case_count: 60,
    request_count_per_trial: 60,
    trial_count: 3,
    trial_ids: sourceRuns.map((run) => run.trial_id),
    run_ids: sourceRuns.map((run) => run.run_id),
    prediction_count: 180,
    usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
    prompt_pack: { requests_sha256: hashText("requests"), private_map_sha256: hashText("map") },
    source_runs: sourceRuns,
    artifacts: { predictions_path: "evidence/scored-predictions.jsonl", predictions_sha256: hashText("aggregate") }
  };
  await writeJson(path.join(root, "evidence", "provider-aggregate.json"), providerAggregate);
  await writeJson(path.join(root, "evidence", "recovery.json"), { passed: true });
  const gate = {
    schema_version: "1.3",
    generated_at: "2026-01-01T00:00:00.000Z",
    suite_id: "suite-fixture",
    evaluation_regime: "controlled_deterministic_fault_injection",
    claim_ceiling: "registered_fault_families_only",
    external_validation_status: "not_run",
    readiness: "paper_scale_candidate",
    paper_ready: false,
    study_design: "post_hoc_fixed_suite_conformance",
    claim_class: "fixed_suite_conformance_signal",
    score_validation_passed: true,
    evidence_gate_passed: false,
    evidence_gate_reason: "post_hoc_design_not_prospective_evidence",
    conformance_gate_passed: true,
    system_roles: {
      ungated: "baseline-system",
      checklist: "checklist-system",
      manuscript: "model-system",
      full: "governed-system",
      ablations: ["advisory-system"]
    },
    case_count: 60,
    base_bundle_count: 10,
    source_family_count: 0,
    provider_repetition: {
      status: "verified_receipt_distinct",
      trial_count: 3,
      provider_identity_independently_verified: false,
      statistical_independence_established: false,
      statistical_replicates: false,
      caveat: "Bound local receipts."
    },
    recovery: {
      status: "verified",
      original_fault_case_count: 50,
      covered_fault_case_count: 50,
      missing_fault_case_count: 0,
      successful_recovery_rate: 1,
      clean_control_regression_rate: 0
    },
    hypotheses: [],
    blockers: [],
    artifacts: {
      suite_sha256: await sha256File(path.join(root, "evidence", "suite.json")),
      suite_snapshot_sha256: hashText("snapshot"),
      input_predictions_sha256: await sha256File(path.join(root, "evidence", "base-predictions.jsonl")),
      scored_predictions_sha256: await sha256File(path.join(root, "evidence", "scored-predictions.jsonl")),
      score_report_ref: "evidence/score.json",
      score_report_sha256: await sha256File(path.join(root, "evidence", "score.json")),
      system_run_manifest_ref: "evidence/system-run.json",
      system_run_manifest_sha256: await sha256File(path.join(root, "evidence", "system-run.json")),
      provider_aggregate_ref: "evidence/provider-aggregate.json",
      provider_aggregate_sha256: await sha256File(path.join(root, "evidence", "provider-aggregate.json")),
      recovery_report_ref: "evidence/recovery.json",
      recovery_report_sha256: await sha256File(path.join(root, "evidence", "recovery.json"))
    }
  };
  await writeJson(path.join(root, "evidence", "gate.json"), gate);

  const manuscript = String.raw`\documentclass{article}
\begin{document}
\begin{table*}
\begin{tabular}{lrrrrrrrr}
\toprule
System & Trials & Dec. acc. & Macro-F1 & False prom. & Clean prom. & Blocker F1 & Owner & Trace \\
\midrule
Baseline & 1 & .167 & .071 & 1.000 & 1.000 & -- & .000 & -- \\
Checklist & 1 & .167 & .071 & 1.000 & 1.000 & -- & .000 & -- \\
Advisory & 1 & .167 & .071 & 1.000 & 1.000 & 1.000 & 1.000 & 1.000 \\
Model & 3 & .500 & .167 & .000 & .000 & .000 & .000 & 1.000 \\
Governed & 1 & 1.000 & 1.000 & .000 & 1.000 & 1.000 & 1.000 & 1.000 \\
\bottomrule
\end{tabular}
\label{tab:primary-results}
\end{table*}
\end{document}
`;
  await fs.writeFile(path.join(root, "paper-source", "manuscript.tex"), manuscript, "utf8");
  await fs.writeFile(path.join(root, "paper-source", "manuscript.pdf"), "%PDF-fixture\n", "utf8");
  await fs.writeFile(path.join(root, "paper-source", "manuscript.log"), "Build fixture\n", "utf8");
  await fs.writeFile(path.join(root, "paper-source", "acl.sty"), "% style fixture\n", "utf8");
  await fs.writeFile(path.join(root, "paper-source", "acl_natbib.bst"), "% bibliography fixture\n", "utf8");
  await fs.writeFile(path.join(root, "paper-source", "references.bib"), "@misc{fixture,title={Fixture}}\n", "utf8");
  await writeJson(path.join(root, "paper-source", "layout-validation.json"), {
    schema_version: "1.0",
    status: "passed",
    page_count: 1,
    undefined_citations: false,
    undefined_references: false,
    overfull_boxes: false,
    visual_pages_inspected: [1],
    visual_findings: {
      clipping: false,
      overlap: false,
      table_overflow: false,
      unreadable_content: false
    },
    artifacts: {
      manuscript_tex_sha256: await sha256File(path.join(root, "paper-source", "manuscript.tex")),
      manuscript_pdf_sha256: await sha256File(path.join(root, "paper-source", "manuscript.pdf")),
      manuscript_log_sha256: await sha256File(path.join(root, "paper-source", "manuscript.log")),
      acl_sty_sha256: await sha256File(path.join(root, "paper-source", "acl.sty")),
      acl_natbib_bst_sha256: await sha256File(path.join(root, "paper-source", "acl_natbib.bst")),
      references_bib_sha256: await sha256File(path.join(root, "paper-source", "references.bib"))
    }
  });
  const claimArtifactRefs = ["evidence/claim.txt"];
  const claimMapPath = path.join(root, "paper-source", "claim-evidence-map.json");
  await writeJson(claimMapPath, {
    schema_version: "1.0",
    claim_ceiling: "registered_fault_families_only",
    claims: [{
      claim_id: "claim-fixture",
      claim: "The governed comparison is measured.",
      status: "supported",
      artifact_refs: claimArtifactRefs
    }]
  });
  const modelReviewPaths: string[] = [];
  const reviewerRecords: Array<Record<string, unknown>> = [];
  for (const id of ["reviewer-a", "reviewer-b", "meta"]) {
    const inputRef = `model-review/${id}-input.json`;
    const outputRef = `model-review/${id}-output.json`;
    const receiptRef = `model-review/${id}-provider-receipt.json`;
    await writeJson(path.join(root, inputRef), { reviewer_id: id, prompt: `input-${id}` });
    await writeJson(path.join(root, outputRef), { reviewer_id: id, result: `output-${id}` });
    await writeJson(path.join(root, receiptRef), {
      reviewer_id: id,
      execution_id: `execution-${id}`,
      provider: "model-provider",
      model: "review-model"
    });
    modelReviewPaths.push(inputRef, outputRef, receiptRef);
    reviewerRecords.push({
      reviewer_id: id,
      role: id === "meta" ? "meta_reviewer" : "claim_evidence",
      provider: "model-provider",
      model: "review-model",
      execution_id: `execution-${id}`,
      context_isolated: true,
      input_ref: inputRef,
      input_sha256: await sha256File(path.join(root, inputRef)),
      output_ref: outputRef,
      output_sha256: await sha256File(path.join(root, outputRef)),
      provider_receipt_ref: receiptRef,
      provider_receipt_sha256: await sha256File(path.join(root, receiptRef))
    });
  }
  const reviewers = reviewerRecords.slice(0, 2);
  const adjudicator = reviewerRecords[2]!;
  await writeJson(path.join(root, "paper-source", "model-claim-evidence-review.json"), {
    schema_version: "1.0",
    review_mode: "independent_model_semantic_validation",
    claim_ceiling: "registered_fault_families_only",
    claim_map_sha256: await sha256File(claimMapPath),
    manuscript_sha256: await sha256File(path.join(root, "paper-source", "manuscript.tex")),
    policy: {
      creates_empirical_evidence: false,
      may_override_deterministic_gate: false,
      human_authority: false
    },
    reviewers,
    adjudicator: {
      ...adjudicator,
      sees_all_reviewer_outputs: true,
      observed_reviewer_output_sha256s: reviewers.map((reviewer) => reviewer.output_sha256)
    },
    claim_reviews: [{
      claim_id: "claim-fixture",
      status: "supported",
      statement_sha256: hashText("The governed comparison is measured."),
      artifact_refs_sha256: hashText(JSON.stringify(claimArtifactRefs)),
      decision: "supported_within_claim_ceiling"
    }]
  });
  await writeJson(path.join(root, "paper-source", "reference-evidence-status.json"), { claims: [] });
  await writeJson(path.join(root, "paper-source", "final-model-review-receipt.json"), {
    artifact_type: "FinalModelReviewPublicReceipt",
    result: { paper_ready: false, human_authority: false }
  });
  await writeJson(path.join(root, "paper-source", "final-ci-receipt.json"), {
    artifact_type: "FinalCIReceipt",
    status: "passed"
  });
  await fs.writeFile(path.join(root, "paper-source", "refgate_claims.tsv"), "claim_id\tstatus\n", "utf8");
  await writeJson(path.join(root, "paper-source", "refgate.lock.json"), { sources: [] });
  await fs.writeFile(path.join(root, "paper-source", "refgate-audit.md"), "# Audit\n", "utf8");
  const handoffRoot = path.join(root, "papers", "promotion-governance", "reference-review-handoff-v1");
  await fs.mkdir(path.join(handoffRoot, "reviewer"), { recursive: true });
  await fs.writeFile(path.join(handoffRoot, "reviewer", "claim-review-tasks.jsonl"), "{}\n", "utf8");
  await writeJson(path.join(handoffRoot, "reviewer", "review-template.json"), { reviews: [] });
  await fs.writeFile(path.join(handoffRoot, "reviewer", "REVIEWER_GUIDE.md"), "# Review\n", "utf8");
  const handoffManifestRef = "papers/promotion-governance/reference-review-handoff-v1/reference-claim-review-manifest.json";
  await writeJson(path.join(root, handoffManifestRef), {
    schema_version: "1.0",
    handoff_id: "reference-review-fixture",
    manuscript_ref: "manuscript.tex",
    source_inputs: [
      { role: "claims", ref: "refgate_claims.tsv", sha256: await sha256File(path.join(root, "paper-source", "refgate_claims.tsv")) },
      { role: "status", ref: "reference-evidence-status.json", sha256: await sha256File(path.join(root, "paper-source", "reference-evidence-status.json")) },
      { role: "lock", ref: "refgate.lock.json", sha256: await sha256File(path.join(root, "paper-source", "refgate.lock.json")) }
    ],
    files: [
      { path: "reviewer/claim-review-tasks.jsonl", sha256: await sha256File(path.join(handoffRoot, "reviewer", "claim-review-tasks.jsonl")) },
      { path: "reviewer/review-template.json", sha256: await sha256File(path.join(handoffRoot, "reviewer", "review-template.json")) },
      { path: "reviewer/REVIEWER_GUIDE.md", sha256: await sha256File(path.join(handoffRoot, "reviewer", "REVIEWER_GUIDE.md")) }
    ]
  });
  await writeJson(path.join(root, "paper-source", "submission-status.json"), {
    paper_ready: false,
    blocking_requirements: [
      "human_reference_authority",
      "submission_reference_audit"
    ],
    controlled_evaluation_contract: { real_model_trial_count: 3, execution_provenance_status: "verified" },
    reference_evidence: {
      status_artifact: "reference-evidence-status.json",
      review_handoff: { manifest: handoffManifestRef }
    },
    model_review: {
      claim_evidence_review_receipt: "model-claim-evidence-review.json",
      citation_review_receipt: "model-citation-review-receipt.json"
    }
  });
  const supportPaths = [
    "evidence/claim.txt",
    "evidence/noisy-paths.json",
    ...modelReviewPaths,
    ...sourceRuns.map((run) => run.manifest_path)
  ];
  const supportFiles = await Promise.all(supportPaths.map(async (relativePath) => {
    const absolute = path.join(root, relativePath);
    const stat = await fs.stat(absolute);
    return { path: relativePath, sha256: await sha256File(absolute), bytes: stat.size };
  }));
  await writeJson(path.join(root, "support.json"), { schema_version: "1.0", files: supportFiles });
  return {
    root,
    input: {
      cwd: root,
      gatePath: "evidence/gate.json",
      paperRoot: "paper-source",
      supportRoot: ".",
      supportManifestPath: "support.json",
      outDir: "package"
    }
  };
}

async function mutatePackageJsonAndRebind(
  packageRoot: string,
  targetRef: string,
  mutate: (value: Record<string, unknown>) => void
): Promise<void> {
  const targetPath = path.join(packageRoot, ...targetRef.split("/"));
  const target = await readJson(targetPath) as Record<string, unknown>;
  mutate(target);
  await writeJson(targetPath, target);

  const projectionPath = path.join(packageRoot, "projection-manifest.json");
  if (targetRef !== "projection-manifest.json") {
    const projection = await readJson(projectionPath) as {
      files: Array<{ path: string; sha256: string; bytes: number }>;
    };
    replaceBinding(projection.files, targetRef, await fileBinding(targetPath, targetRef));
    await writeJson(projectionPath, projection);
  }

  const supportPath = path.join(packageRoot, "projection-support-manifest.json");
  const support = await readJson(supportPath) as {
    files: Array<{ path: string; sha256: string; bytes: number }>;
  };
  const targetBinding = await fileBinding(targetPath, targetRef);
  if (support.files.some((binding) => binding.path === targetRef)) {
    replaceBinding(support.files, targetRef, targetBinding);
  }
  replaceBinding(
    support.files,
    "projection-manifest.json",
    await fileBinding(projectionPath, "projection-manifest.json")
  );
  await writeJson(supportPath, support);
}

function replaceBinding(
  bindings: Array<{ path: string; sha256: string; bytes: number }>,
  targetRef: string,
  replacement: { path: string; sha256: string; bytes: number }
): void {
  const index = bindings.findIndex((binding) => binding.path === targetRef);
  if (index < 0) throw new Error("Missing package binding: " + targetRef);
  bindings[index] = replacement;
}

async function fileBinding(
  filePath: string,
  relativePath: string
): Promise<{ path: string; sha256: string; bytes: number }> {
  const stat = await fs.stat(filePath);
  return { path: relativePath, sha256: await sha256File(filePath), bytes: stat.size };
}

function metric(
  systemId: string,
  trials: number,
  falsePromotion: number,
  cleanPromotion: number,
  decisionAccuracy: number,
  macroF1: number,
  blockerF1: number | null,
  ownerAccuracy: number,
  traceCoverage: number | null
): Record<string, unknown> {
  return {
    system_id: systemId,
    trial_count: trials,
    exact_decision_accuracy: decisionAccuracy,
    prediction_count: 60 * trials,
    macro_decision_f1: macroF1,
    false_paper_ready_rate: falsePromotion,
    concern_acceptance_conflict_eligible_count: 48 * trials,
    clean_case_count: 12 * trials,
    clean_case_promotion_accuracy: cleanPromotion,
    blocker_f1: blockerF1,
    repair_owner_exact_match_accuracy: ownerAccuracy,
    repair_owner_eligible_count: 48 * trials,
    trace_coverage: traceCoverage
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function hashRuntimeSourceTree(root: string): Promise<string> {
  const transientSuffixes = [".orig", ".bak", ".backup", ".rej", ".swp", ".swo"];
  const transientFileNames = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
  const rows: Array<{ ref: string; sha256: string }> = [];
  const visit = async (absolutePath: string, relativePath: string): Promise<void> => {
    const stat = await fs.lstat(absolutePath);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const normalized = entry.name.toLowerCase();
        if (transientFileNames.has(normalized)
            || entry.name.startsWith(".#")
            || entry.name.endsWith("~")
            || transientSuffixes.some((suffix) => normalized.endsWith(suffix))) {
          continue;
        }
        await visit(path.join(absolutePath, entry.name), path.posix.join(relativePath, entry.name));
      }
    } else if (stat.isFile()) {
      rows.push({ ref: relativePath, sha256: await sha256File(absolutePath) });
    }
  };
  for (const ref of ["src", "package.json", "package-lock.json", "tsconfig.json"]) {
    await visit(path.join(root, ref), ref);
  }
  return hashText(`${JSON.stringify(rows)}\n`);
}
