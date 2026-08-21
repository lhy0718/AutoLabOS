import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  REQUIRED_MODEL_REVIEW_ROLES,
  hashModelReviewAdjudicatorInput,
  hashModelReviewOutput,
  type ModelReviewBundle,
  type ModelReviewerProvenance,
  type ModelReviewRole
} from "../src/core/modelReviewProtocol.js";

import { resolveCliAction } from "../src/cli/args.js";
import {
  inspectPaperReadinessBundle,
  runResearchAudit,
  runResearchImprove,
  runResearchNew,
  runResearchPack,
  runResearchReview,
  verifyExternalIntakeManifestBindings
} from "../src/core/researchGovernanceOperations.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("research governance operations", () => {
  it("parses all five artifact-first research intents", () => {
    expect(resolveCliAction(["research", "new", "--brief", "Brief.md"])).toMatchObject({ kind: "research-new" });
    expect(resolveCliAction(["research", "audit", "--external", "artifacts"])).toMatchObject({ kind: "research-audit" });
    expect(resolveCliAction(["research", "review", "--gate", "gate-report.json"])).toMatchObject({ kind: "research-review" });
    expect(resolveCliAction(["research", "improve", "--review", "review-report.json"])).toMatchObject({ kind: "research-improve" });
    expect(resolveCliAction(["research", "audit", "--help"])).toMatchObject({ kind: "research-help" });
    expect(resolveCliAction([
      "research",
      "audit",
      "--external",
      "first-root",
      "--external",
      "second-root"
    ])).toEqual({ kind: "error", message: "Duplicate research argument: --external." });
    expect(resolveCliAction(["research", "review", "gate.json"])).toEqual({
      kind: "error",
      message: "Unexpected positional research argument: gate.json."
    });
    expect(resolveCliAction([
      "research",
      "pack",
      "--gate",
      "gate-report.json",
      "--review",
      "review-report.json"
    ])).toMatchObject({ kind: "research-pack" });
    expect(resolveCliAction([
      "research",
      "verify-pack",
      "--root",
      "paper-readiness-bundle"
    ])).toEqual({ kind: "research-pack-verify", bundleRoot: "paper-readiness-bundle" });
    expect(resolveCliAction([
      "research",
      "verify-milestone",
      "--contract",
      "milestone.json",
      "--out-dir",
      "audit"
    ])).toEqual({ kind: "research-milestone-verify", contractPath: "milestone.json", outDir: "audit" });
  });

  it("creates a versioned ResearchBrief artifact without pretending an empty template is complete", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-new-"));
    tempDirs.push(workspace);

    const result = await runResearchNew({
      cwd: workspace,
      briefPath: "Brief.md",
      outDir: "outputs/governance/new"
    });

    expect(result.artifact.artifact_type).toBe("ResearchBrief");
    expect(result.artifact.schema_version).toBe("2.0");
    expect(result.artifact.completeness.paper_scale_ready).toBe(false);
    expect(result.artifact.validation.errors.length).toBeGreaterThan(0);
    expect(result.output_path).toBe("outputs/governance/new/research-brief.json");
  });

  it("preserves an honest downgrade through audit, review, improve, and pack", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-chain-"));
    const external = path.join(workspace, "external-artifacts");
    tempDirs.push(workspace);
    await mkdir(external, { recursive: true });

    const gateResult = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit"
    });
    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      outDir: "outputs/governance/review"
    });
    const improveResult = await runResearchImprove({
      cwd: workspace,
      reviewPath: reviewResult.output_path,
      outDir: "outputs/governance/improve"
    });
    const packResult = await runResearchPack({
      cwd: workspace,
      gatePath: gateResult.output_path,
      reviewPath: reviewResult.output_path,
      sourceDir: "outputs/governance/audit",
      outDir: "outputs/governance/pack"
    });

    expect(gateResult.artifact.verdict).toBe("blocked");
    expect(reviewResult.artifact.readiness_class).toBe("blocked_for_paper_scale");
    expect(reviewResult.artifact.paper_ready).toBe(false);
    expect(reviewResult.artifact.reviewer_assurance.gate_report_sha256).toBe(
      createHash("sha256").update(await readFile(path.join(workspace, gateResult.output_path))).digest("hex")
    );
    expect(improveResult.artifact.apply_mode).toBe("plan_only");
    expect(improveResult.artifact.targets.length).toBeGreaterThan(0);
    expect(improveResult.artifact.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        finding_code: "artifact_contract_incomplete",
        target_node: "run_experiments",
        proposed_change: expect.stringContaining("missing governed artifacts")
      }),
      expect.objectContaining({
        finding_code: "result_table_missing",
        target_node: "analyze_results",
        proposed_change: expect.stringContaining("comparator result table")
      }),
      expect.objectContaining({
        finding_code: "unsupported_claim",
        proposed_change: expect.stringContaining("claim-evidence rows")
      })
    ]));
    expect(packResult.artifact.paper_ready).toBe(false);
    expect(packResult.artifact.limitations.length).toBeGreaterThan(0);
    expect(packResult.artifact.files.every((file) => !path.isAbsolute(file.path))).toBe(true);
    expect(JSON.stringify(packResult)).not.toContain(workspace);
  });

  it("routes academic package evidence gaps to the owning research nodes", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-academic-routing-"));
    const external = path.join(workspace, "academic-package");
    tempDirs.push(workspace);
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, "manuscript.tex"), "\\section{Related Work}\n", "utf8");
    await writeFile(path.join(external, "references.bib"), "@article{source_a,title={Source A}}\n", "utf8");
    await writeJson(path.join(external, "claim-evidence-map.json"), {
      schema_version: "1.0",
      claims: [{
        claim_id: "held-out-effect",
        claim: "The policy improves held-out outcomes.",
        status: "blocked",
        missing_evidence: ["real_provider_trials"]
      }]
    });
    await writeJson(path.join(external, "reference-evidence-status.json"), {
      schema_version: "1.0",
      submission_gate_passed: false,
      summary: {
        citation_bearing_claim_count: 2,
        full_text_evidence_candidate_count: 1,
        independently_checked_claim_count: 0,
        missing_full_text_claim_count: 1
      },
      sources: []
    });
    await writeJson(path.join(external, "submission-status.json"), {
      schema_version: "1.0",
      paper_ready: false,
      manuscript_type: "research_memo",
      blocking_requirements: ["full_text_source_missing", "real_provider_trials", "official_template_revalidation"]
    });
    const header = [
      "claim_id", "manuscript_location", "claim_text", "citation_key", "source_location",
      "quote_or_evidence", "evidence_kind", "status", "notes", "claim_type", "importance"
    ];
    const rows = [
      ["claim-a", "line 5", "Prior work A uses a gate.", "source_a", "page 1", "support", "source_text", "needs_review", "review required", "related_work", "normal"],
      ["claim-b", "line 6", "Prior work B preserves evidence.", "source_b", "", "", "", "claim_unchecked", "full text missing", "related_work", "normal"]
    ];
    await writeFile(
      path.join(external, "refgate_claims.tsv"),
      [header, ...rows].map((row) => row.join("\t")).join("\n") + "\n",
      "utf8"
    );

    const gateResult = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit"
    });
    const manuscriptBinding = gateResult.artifact.input_bindings.find(
      (binding) => binding.path.endsWith("/paper/main.tex")
    );
    expect(manuscriptBinding).toMatchObject({
      sha256: createHash("sha256").update("\\section{Related Work}\n").digest("hex"),
      bytes: Buffer.byteLength("\\section{Related Work}\n")
    });
    expect(new Set(gateResult.artifact.input_bindings.map((binding) => binding.path)).size)
      .toBe(gateResult.artifact.input_bindings.length);
    expect(gateResult.artifact.input_bindings.every((binding) => binding.required)).toBe(true);
    expect(gateResult.artifact.input_bindings.some((binding) =>
      binding.path.startsWith("paper/")
    )).toBe(false);
    const evidenceBundleBytes = await readFile(
      path.join(workspace, "outputs", "governance", "audit", "evidence-bundle.json")
    );
    expect(gateResult.artifact.evidence_bundle_sha256).toBe(
      createHash("sha256").update(evidenceBundleBytes).digest("hex")
    );
    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      outDir: "outputs/governance/review"
    });
    const improveResult = await runResearchImprove({
      cwd: workspace,
      reviewPath: reviewResult.output_path,
      outDir: "outputs/governance/improve"
    });
    const reviewReportBytes = await readFile(path.resolve(workspace, reviewResult.output_path));

    expect(gateResult.artifact.checks.citation_support_issues).toBe(2);
    expect(improveResult.artifact.review_report_sha256).toBe(
      createHash("sha256").update(reviewReportBytes).digest("hex")
    );
    expect(gateResult.artifact.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "citation_support_gap", target_node: "analyze_papers" }),
      expect.objectContaining({ code: "citation_support_gap", target_node: "collect_papers" }),
      expect.objectContaining({ code: "reference_full_text_missing", target_node: "collect_papers" }),
      expect.objectContaining({ code: "academic_claim_evidence_blocked:held-out-effect:run_experiments", target_node: "run_experiments" }),
      expect.objectContaining({ code: "submission_requirements_open:write_paper", target_node: "write_paper" })
    ]));
    expect(reviewResult.artifact.repair_targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ finding_code: "citation_support_gap", target_node: "analyze_papers" }),
      expect.objectContaining({ finding_code: "citation_support_gap", target_node: "collect_papers" }),
      expect.objectContaining({ finding_code: "reference_full_text_missing", target_node: "collect_papers" }),
      expect.objectContaining({
        finding_code: "academic_claim_evidence_blocked:held-out-effect:run_experiments",
        target_node: "run_experiments"
      })
    ]));
    expect(improveResult.artifact.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        finding_code: "citation_support_gap",
        target_node: "collect_papers",
        proposed_change: expect.stringContaining("exact full-text source")
      }),
      expect.objectContaining({
        finding_code: "reference_full_text_missing",
        target_node: "collect_papers",
        proposed_change: expect.stringContaining("exact full-text source")
      }),
      expect.objectContaining({
        finding_code: "academic_claim_evidence_blocked:held-out-effect:run_experiments",
        target_node: "run_experiments",
        proposed_change: expect.stringContaining("missing evidence item")
      })
    ]));
  });

  it("changes evidence and gate identities when audited manuscript bytes change", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-stale-binding-"));
    const external = path.join(workspace, "academic-package");
    tempDirs.push(workspace);
    await mkdir(external, { recursive: true });
    const manuscriptPath = path.join(external, "manuscript.tex");
    await writeFile(manuscriptPath, "\\section{Method}\nVersion A.\n", "utf8");

    const first = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit-a"
    });
    await writeFile(manuscriptPath, "\\section{Method}\nVersion B.\n", "utf8");
    const second = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit-b"
    });
    const firstBinding = first.artifact.input_bindings.find(
      (binding) => binding.path.endsWith("/paper/main.tex")
    );
    const secondBinding = second.artifact.input_bindings.find(
      (binding) => binding.path.endsWith("/paper/main.tex")
    );

    expect(firstBinding?.sha256).not.toBe(secondBinding?.sha256);
    expect(first.artifact.evidence_bundle_id).not.toBe(second.artifact.evidence_bundle_id);
    expect(first.artifact.artifact_id).not.toBe(second.artifact.artifact_id);
  });

  it("requires every frozen external intake binding in EvidenceBundle and GateReport", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-external-bindings-"));
    const external = path.join(workspace, "external-package");
    const supportRoot = path.join(workspace, "support-root");
    tempDirs.push(workspace);
    await mkdir(external, { recursive: true });
    await mkdir(path.join(supportRoot, "src"), { recursive: true });
    await writeFile(path.join(external, "manuscript.tex"), "\\section{Method}\n", "utf8");
    const supportContent = "export const evidenceContract = true;\n";
    await writeFile(path.join(supportRoot, "src", "evidence-contract.ts"), supportContent, "utf8");
    const supportManifestPath = path.join(workspace, "support-manifest.json");
    await writeJson(supportManifestPath, {
      schema_version: "1.0",
      files: [{
        path: "src/evidence-contract.ts",
        sha256: createHash("sha256").update(supportContent).digest("hex"),
        bytes: Buffer.byteLength(supportContent)
      }]
    });

    const gateResult = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      supportRoot,
      supportManifestPath,
      outDir: "outputs/governance/audit"
    });
    const manifest = JSON.parse(await readFile(
      path.join(workspace, "outputs", "governance", "audit", "external-intake-manifest.json"),
      "utf8"
    )) as {
      run_root: string;
      copied_files: string[];
      copied_file_bindings: Array<{ path: string; sha256: string; bytes: number }>;
    };
    const evidenceBundle = JSON.parse(await readFile(
      path.join(workspace, "outputs", "governance", "audit", "evidence-bundle.json"),
      "utf8"
    )) as { files: Array<{ path: string; sha256?: string; bytes?: number; required: boolean }> };

    expect(manifest.copied_file_bindings.map((binding) => binding.path)).toEqual(manifest.copied_files);
    for (const binding of manifest.copied_file_bindings) {
      const expectedPath = path.posix.join(manifest.run_root, binding.path);
      const expectedBinding = {
        path: expectedPath,
        sha256: binding.sha256,
        bytes: binding.bytes,
        required: true
      };
      expect(gateResult.artifact.input_bindings).toContainEqual(expectedBinding);
      expect(evidenceBundle.files).toContainEqual(expectedBinding);
    }
  });

  it("rejects external intake inventory gaps, unbound files, and frozen byte drift", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-external-drift-"));
    const external = path.join(workspace, "external-package");
    tempDirs.push(workspace);
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, "manuscript.tex"), "\\section{Results}\n", "utf8");
    await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit"
    });

    const manifestPath = path.join(
      workspace,
      "outputs",
      "governance",
      "audit",
      "external-intake-manifest.json"
    );
    const originalManifest = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(originalManifest) as {
      run_root: string;
      copied_files: string[];
      copied_file_bindings: Array<{ path: string; sha256: string; bytes: number }>;
    };
    const verifyInput = {
      cwd: workspace,
      manifestPath,
      runRoot: manifest.run_root
    };

    await expect(verifyExternalIntakeManifestBindings(verifyInput)).resolves.toHaveLength(
      manifest.copied_files.length
    );
    await writeJson(manifestPath, {
      ...manifest,
      copied_file_bindings: manifest.copied_file_bindings.slice(1)
    });
    await expect(verifyExternalIntakeManifestBindings(verifyInput)).rejects.toThrow("closed inventory");

    await writeFile(manifestPath, originalManifest, "utf8");
    const runRoot = path.join(workspace, ...manifest.run_root.split("/"));
    const unboundPath = path.join(runRoot, "unbound-support.txt");
    await writeFile(unboundPath, "unbound\n", "utf8");
    await expect(verifyExternalIntakeManifestBindings(verifyInput)).rejects.toThrow("closed inventory");
    await rm(unboundPath);

    const boundPath = path.join(runRoot, ...manifest.copied_file_bindings[0].path.split("/"));
    await writeFile(boundPath, `${await readFile(boundPath, "utf8")}drift\n`, "utf8");
    await expect(verifyExternalIntakeManifestBindings(verifyInput)).rejects.toThrow("binding drift");
  });

  it("blocks active runs even when stale paper-scale artifacts look complete", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-active-run-"));
    const runRoot = path.join(workspace, "runs", "active-research-run");
    tempDirs.push(workspace);
    await writeCompleteExternalBundle(runRoot);
    await writeJson(path.join(runRoot, "run_record.json"), {
      id: "active-research-run",
      status: "running",
      currentNode: "run_experiments"
    });

    const gateResult = await runResearchAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/governance/audit"
    });
    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      outDir: "outputs/governance/review"
    });
    const improveResult = await runResearchImprove({
      cwd: workspace,
      reviewPath: reviewResult.output_path,
      outDir: "outputs/governance/improve"
    });

    expect(gateResult.artifact.verdict).toBe("blocked");
    expect(gateResult.artifact.findings).toContainEqual(
      expect.objectContaining({ code: "run_execution_incomplete", severity: "blocker" })
    );
    expect(reviewResult.artifact.readiness_class).toBe("blocked_for_paper_scale");
    expect(reviewResult.artifact.paper_ready).toBe(false);
    expect(improveResult.artifact.targets).toContainEqual(
      expect.objectContaining({
        finding_code: "run_execution_incomplete",
        target_node: "run_experiments"
      })
    );
  });

  it("preserves terminal verifier detail through review and node-local improvement", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-failed-run-"));
    const runRoot = path.join(workspace, "runs", "failed-research-run");
    tempDirs.push(workspace);
    await writeCompleteExternalBundle(runRoot);
    await writeJson(path.join(runRoot, "run_record.json"), {
      id: "failed-research-run",
      status: "failed",
      currentNode: "run_experiments"
    });
    await writeJson(path.join(runRoot, "run_experiments_verify_report.json"), {
      status: "fail",
      stage: "preflight_test",
      summary: "The runner declares a timeout but no evaluation loop consumes a deadline.",
      suggested_next_action: "Repair the experiment implementation so baseline/comparator execution reaches completed metrics."
    });

    const gateResult = await runResearchAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/governance/audit"
    });
    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      outDir: "outputs/governance/review"
    });
    const improveResult = await runResearchImprove({
      cwd: workspace,
      reviewPath: reviewResult.output_path,
      outDir: "outputs/governance/improve"
    });

    expect(gateResult.artifact.findings).toContainEqual(expect.objectContaining({
      code: "run_execution_failed",
      message: expect.stringContaining("no evaluation loop consumes a deadline")
    }));
    expect(reviewResult.artifact.repair_targets).toContainEqual(expect.objectContaining({
      finding_code: "run_execution_failed",
      target_node: "implement_experiments"
    }));
    expect(improveResult.artifact.targets).toContainEqual(expect.objectContaining({
      finding_code: "run_execution_failed",
      target_node: "implement_experiments",
      proposed_change: expect.stringContaining("implement_experiments")
    }));
  });

  it("carries scientific review diagnostics and upstream node recommendations through the plugin chain", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-review-handoff-"));
    const runRoot = path.join(workspace, "runs", "governed-research-run");
    tempDirs.push(workspace);
    await writeCompleteExternalBundle(runRoot);
    await writeJson(path.join(runRoot, "review", "paper_scale_diagnostics.json"), {
      diagnostics: [
        {
          id: "evidence_adequacy_not_passed",
          severity: "blocking",
          source_node: "run_experiments",
          target_node: "run_experiments",
          recheck_condition: "Observed repeated-run evidence reaches the governed minimum."
        },
        {
          id: "evidence_adequacy_invalid",
          severity: "blocking",
          source_node: "implement_experiments",
          target_node: "implement_experiments",
          recheck_condition: "Executed training coverage matches the approved design."
        }
      ]
    });
    await writeJson(path.join(runRoot, "review", "node_strengthening_recommendations.json"), {
      recommendations: [
        {
          node: "run_experiments",
          priority: "high",
          recheck_condition: "Execution evidence passes review."
        },
        {
          node: "implement_experiments",
          priority: "high",
          recheck_condition: "Implementation budget passes review."
        },
        {
          node: "generate_hypotheses",
          priority: "high",
          recheck_condition: "Claims remain within measured outcomes."
        },
        {
          node: "design_experiments",
          priority: "medium",
          recheck_condition: "The design declares its evidence floor."
        }
      ]
    });

    const gateResult = await runResearchAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/governance/audit"
    });
    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      outDir: "outputs/governance/review"
    });
    const improveResult = await runResearchImprove({
      cwd: workspace,
      reviewPath: reviewResult.output_path,
      outDir: "outputs/governance/improve"
    });
    const evidenceBundle = JSON.parse(await readFile(
      path.join(workspace, "outputs", "governance", "audit", "evidence-bundle.json"),
      "utf8"
    ));

    expect(gateResult.artifact.verdict).toBe("blocked");
    expect(gateResult.artifact.findings).toContainEqual(expect.objectContaining({
      code: "evidence_adequacy_not_passed",
      target_node: "run_experiments",
      target_surface: "validator",
      recheck_condition: "Observed repeated-run evidence reaches the governed minimum."
    }));
    expect(evidenceBundle.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "runs/governed-research-run/review/paper_scale_diagnostics.json"
      }),
      expect.objectContaining({
        path: "runs/governed-research-run/review/node_strengthening_recommendations.json"
      })
    ]));
    expect(reviewResult.artifact.repair_targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_node: "run_experiments" }),
      expect.objectContaining({ target_node: "implement_experiments" }),
      expect.objectContaining({ target_node: "generate_hypotheses", target_surface: "prompt" }),
      expect.objectContaining({ target_node: "design_experiments", target_surface: "prompt" })
    ]));
    expect(improveResult.artifact.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_node: "run_experiments" }),
      expect.objectContaining({ target_node: "implement_experiments" }),
      expect.objectContaining({ target_node: "generate_hypotheses" }),
      expect.objectContaining({ target_node: "design_experiments" })
    ]));
  });

  it("excludes JSON-quoted private paths from paper-readiness bundles", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-portability-"));
    const external = path.join(workspace, "external-artifacts");
    tempDirs.push(workspace);
    await mkdir(external, { recursive: true });

    const gateResult = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit"
    });
    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      outDir: "outputs/governance/review"
    });
    await writeJson(path.join(workspace, "outputs", "governance", "audit", "audit-summary.json"), {
      source: path.posix.join(path.sep, "home", "example", "private-artifact.json")
    });

    const packResult = await runResearchPack({
      cwd: workspace,
      gatePath: gateResult.output_path,
      reviewPath: reviewResult.output_path,
      sourceDir: "outputs/governance/audit",
      outDir: "outputs/governance/pack"
    });

    expect(packResult.artifact.portability.valid).toBe(false);
    expect(packResult.artifact.portability.issues).toContainEqual(
      expect.stringContaining("audit-summary.json")
    );
    expect(packResult.artifact.files.map((item) => item.path)).not.toContain(
      "artifacts/audit-summary.json"
    );
  });

  it("redacts run-specific identifiers from copied public bundle artifacts", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-redaction-"));
    const external = path.join(workspace, "external-artifacts");
    tempDirs.push(workspace);
    await mkdir(external, { recursive: true });

    const gateResult = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit"
    });
    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      outDir: "outputs/governance/review"
    });
    const runId = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");
    const taskName = ["Task", "Alpha"].join("");
    const modelName = ["Model", "1B"].join("-");
    const conditionName = ["condition", "4", "parameter", "0"].join("_");
    const traceId = ["trace", "fixture", "alpha"].join("_");
    await writeJson(path.join(workspace, "outputs", "governance", "audit", "audit-summary.json"), {
      task_id: runId,
      statement: `A comparison on ${taskName} used ${modelName} and ${conditionName}.`,
      trace_id: traceId,
      contract_path: "done-condition-audit.json"
    });

    const packResult = await runResearchPack({
      cwd: workspace,
      gatePath: gateResult.output_path,
      reviewPath: reviewResult.output_path,
      sourceDir: "outputs/governance/audit",
      outDir: "outputs/governance/pack"
    });
    const packedText = await readFile(
      path.join(workspace, "outputs", "governance", "pack", "artifacts", "audit-summary.json"),
      "utf8"
    );

    expect(packResult.artifact.portability.valid).toBe(true);
    expect(packResult.artifact.portability.redacted_files).toContain("artifacts/audit-summary.json");
    expect(packedText).not.toContain(runId);
    expect(packedText).not.toContain(taskName);
    expect(packedText).not.toContain(modelName);
    expect(packedText).not.toContain(conditionName);
    expect(packedText).toContain("<task-id>");
    expect(packedText).toContain("<model-id>");
    expect(packedText).toContain("<condition-id>");
    expect(packedText).not.toContain(traceId);
    expect(packedText).toContain("<trace-id>");
    expect(packedText).toContain("done-<condition-id>.json");
  });

  it("keeps explicit gate and review artifacts when source files target the same bundle paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-pack-collision-"));
    const external = path.join(workspace, "external-artifacts");
    tempDirs.push(workspace);
    await mkdir(external, { recursive: true });

    const gateResult = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit"
    });
    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      outDir: "outputs/governance/review"
    });
    await writeJson(path.join(workspace, "outputs", "governance", "audit", "review-report.json"), {
      stale: true
    });

    const packResult = await runResearchPack({
      cwd: workspace,
      gatePath: gateResult.output_path,
      reviewPath: reviewResult.output_path,
      sourceDir: "outputs/governance/audit",
      outDir: "outputs/governance/pack"
    });
    const reviewFiles = packResult.artifact.files.filter((item) => item.path === "artifacts/review-report.json");
    const packedReview = JSON.parse(await readFile(
      path.join(workspace, "outputs", "governance", "pack", "artifacts", "review-report.json"),
      "utf8"
    ));

    expect(reviewFiles).toHaveLength(1);
    expect(packedReview).toEqual(reviewResult.artifact);
    expect(packResult.artifact.portability).toEqual(expect.objectContaining({
      valid: true,
      issues: []
    }));
  });

  it("fails closed when an explicit pack source directory has no governance sidecars", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-pack-source-"));
    const external = path.join(workspace, "external-artifacts");
    const manuscriptSource = path.join(workspace, "manuscript-source");
    tempDirs.push(workspace);
    await mkdir(external, { recursive: true });
    await mkdir(manuscriptSource, { recursive: true });
    await writeFile(path.join(manuscriptSource, "manuscript.tex"), "\\section{Results}\n", "utf8");

    const gateResult = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit"
    });
    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      outDir: "outputs/governance/review"
    });

    await expect(runResearchPack({
      cwd: workspace,
      gatePath: gateResult.output_path,
      reviewPath: reviewResult.output_path,
      sourceDir: "manuscript-source",
      outDir: "outputs/governance/pack"
    })).rejects.toThrow("requires --source-dir/evidence-bundle.json");
    await expect(readFile(
      path.join(workspace, "outputs", "governance", "pack", "paper-readiness-bundle.json"),
      "utf8"
    )).rejects.toThrow();
  });

  it("independently verifies a closed paper-readiness bundle", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-pack-verify-"));
    tempDirs.push(workspace);
    const packRoot = await writeGovernancePack(workspace);

    const inspection = await inspectPaperReadinessBundle({
      cwd: workspace,
      bundleRoot: packRoot
    });

    expect(inspection).toEqual(expect.objectContaining({
      verdict: "pass",
      bundle_ref: "outputs/governance/pack",
      closed_inventory: true,
      portability_valid: true,
      issues: []
    }));
    expect(inspection.checked_files).toBe(inspection.expected_files);
    expect(inspection.checked_files).toBeGreaterThan(0);
    const packedResultTable = path.join(
      packRoot,
      "artifacts",
      "evidence",
      "outputs",
      "governance",
      "audit",
      "_external-intake",
      "run-artifacts",
      "result_table.json"
    );
    expect(JSON.parse(await readFile(packedResultTable, "utf8"))).toEqual([
      { metric: "primary_score", baseline: 0.8, comparator: 0.2, delta: -0.6, direction: "higher_better" }
    ]);
  });

  it("fails bundle verification on changed bytes and unbound files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-pack-tamper-"));
    tempDirs.push(workspace);
    const packRoot = await writeGovernancePack(workspace);
    const gatePath = path.join(packRoot, "artifacts", "gate-report.json");
    await writeFile(gatePath, `${await readFile(gatePath, "utf8")}\n`, "utf8");
    await writeFile(path.join(packRoot, "unbound.json"), "{}\n", "utf8");

    const inspection = await inspectPaperReadinessBundle({ cwd: workspace, bundleRoot: packRoot });

    expect(inspection.verdict).toBe("fail");
    expect(inspection.closed_inventory).toBe(false);
    expect(inspection.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "file_size_mismatch", path: "artifacts/gate-report.json" }),
      expect.objectContaining({ code: "file_hash_mismatch", path: "artifacts/gate-report.json" }),
      expect.objectContaining({ code: "unexpected_file", path: "unbound.json" })
    ]));
  });

  it("fails bundle verification when the manifest contains non-portable text", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-pack-portability-"));
    tempDirs.push(workspace);
    const packRoot = await writeGovernancePack(workspace);
    const manifestPath = path.join(packRoot, "paper-readiness-bundle.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const privatePath = path.posix.join(path.posix.sep, "home", "example", "workspace-item");
    manifest.limitations.push(`Inspect ${privatePath} before release.`);
    await writeJson(manifestPath, manifest);

    const inspection = await inspectPaperReadinessBundle({ cwd: workspace, bundleRoot: packRoot });

    expect(inspection.verdict).toBe("fail");
    expect(inspection.portability_valid).toBe(false);
    expect(inspection.issues).toContainEqual(expect.objectContaining({
      code: "non_portable_content",
      path: "paper-readiness-bundle.json"
    }));
  });

  it("fails bundle verification on duplicate artifact bindings", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-pack-duplicate-"));
    tempDirs.push(workspace);
    const packRoot = await writeGovernancePack(workspace);
    const manifestPath = path.join(packRoot, "paper-readiness-bundle.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const duplicateIndex = manifest.files.length;
    manifest.files.push({ ...manifest.files[0] });
    await writeJson(manifestPath, manifest);

    const inspection = await inspectPaperReadinessBundle({ cwd: workspace, bundleRoot: packRoot });

    expect(inspection.verdict).toBe("fail");
    expect(inspection.closed_inventory).toBe(false);
    expect(inspection.issues).toContainEqual(expect.objectContaining({
      code: "manifest_invalid",
      path: expect.stringContaining(`files[${duplicateIndex}].path`),
      message: expect.stringContaining("unique")
    }));
  });

  it("fails bundle verification on symbolic links and artifact binding drift", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-pack-binding-"));
    tempDirs.push(workspace);
    const packRoot = await writeGovernancePack(workspace);
    const manifestPath = path.join(packRoot, "paper-readiness-bundle.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.review_report_id = "review_report_unbound";
    await writeJson(manifestPath, manifest);
    const bindingInspection = await inspectPaperReadinessBundle({ cwd: workspace, bundleRoot: packRoot });
    expect(bindingInspection.issues).toContainEqual(expect.objectContaining({
      code: "artifact_binding_mismatch",
      message: expect.stringContaining("review_report_id")
    }));
    const reviewPath = path.join(packRoot, "artifacts", "review-report.json");
    const symlinkTarget = path.join(workspace, "review-report-target.json");
    await writeFile(symlinkTarget, await readFile(reviewPath));
    await rm(reviewPath);
    await symlink(symlinkTarget, reviewPath);

    const inspection = await inspectPaperReadinessBundle({ cwd: workspace, bundleRoot: packRoot });

    expect(inspection.verdict).toBe("fail");
    expect(inspection.closed_inventory).toBe(false);
    expect(inspection.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "file_type_invalid", path: "artifacts/review-report.json" }),
      expect.objectContaining({
        code: "artifact_binding_mismatch",
        message: expect.stringContaining("bound ReviewReport")
      })
    ]));
  });

  it("creates an A2 review only from a byte-bound conservative model review bundle", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-model-review-bound-"));
    const external = path.join(workspace, "external-artifacts");
    tempDirs.push(workspace);
    await writeCompleteExternalBundle(external);

    const gateResult = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit"
    });
    const gatePath = path.join(workspace, gateResult.output_path);
    const gateBytes = await readFile(gatePath);
    const gateSha256 = createHash("sha256").update(gateBytes).digest("hex");
    const modelReviewBundle = makeModelReviewBundle(gateResult.artifact.artifact_id, gateSha256);
    const modelReviewBundlePath = path.join(workspace, "model-review-bundle.json");
    await writeJson(modelReviewBundlePath, modelReviewBundle);
    const modelReviewBundleBytes = await readFile(modelReviewBundlePath);

    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      modelReviewBundlePath: "model-review-bundle.json",
      outDir: "outputs/governance/review"
    });

    expect(gateResult.artifact.verdict).toBe("pass");
    expect(reviewResult.artifact.verdict).toBe("blocked");
    expect(reviewResult.artifact.claim_ceiling).toBe(gateResult.artifact.claim_ceiling);
    expect(reviewResult.artifact.paper_ready).toBe(false);
    expect(reviewResult.artifact.blocking_issues).toContainEqual(expect.objectContaining({
      code: "model_robustness_gap",
      severity: "blocker"
    }));
    expect(reviewResult.artifact.non_blocking_issues).toContainEqual(expect.objectContaining({
      code: "model_claim_scope_warning",
      severity: "warning"
    }));
    expect(reviewResult.artifact.repair_targets).toContainEqual(expect.objectContaining({
      finding_code: "model_robustness_gap",
      target_node: "run_experiments"
    }));
    expect(reviewResult.artifact.reviewer_assurance).toEqual(expect.objectContaining({
      tier: "A2_model_conservative",
      panel_size: 5,
      gate_report_sha256: gateSha256,
      model_review_bundle_sha256: createHash("sha256").update(modelReviewBundleBytes).digest("hex"),
      independent_contexts: true,
      adjudicator_present: true,
      can_promote: false,
      can_downgrade: true,
      human_authority: false
    }));
    expect(reviewResult.related_paths).toContain("model-review-bundle.json");

    modelReviewBundle.gate_report.sha256 = digest("different-gate-report-bytes");
    await writeJson(modelReviewBundlePath, modelReviewBundle);
    await expect(runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      modelReviewBundlePath: "model-review-bundle.json",
      outDir: "outputs/governance/review-tampered"
    })).rejects.toThrow("does not match the supplied GateReport bytes");
  });

  it("requires the exact fixed-path ModelReviewBundle sidecar for A2 packs", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-model-review-pack-source-"));
    tempDirs.push(workspace);
    const fixture = await writeA2ReviewFixture(workspace);
    const packInput = {
      cwd: workspace,
      gatePath: fixture.gateResult.output_path,
      reviewPath: fixture.reviewResult.output_path,
      sourceDir: fixture.sourceDir,
      outDir: "outputs/governance/pack"
    };

    await expect(runResearchPack(packInput)).rejects.toThrow(
      "model-review-bundle.json directly under --source-dir"
    );

    const sourceSidecarPath = path.join(workspace, fixture.sourceDir, "model-review-bundle.json");
    await writeFile(sourceSidecarPath, Buffer.concat([
      fixture.modelReviewBundleBytes,
      Buffer.from("\n", "utf8")
    ]));
    await expect(runResearchPack(packInput)).rejects.toThrow(
      "sidecar SHA-256 does not match ReviewReport reviewer_assurance"
    );

    await writeFile(sourceSidecarPath, fixture.modelReviewBundleBytes);
    const packResult = await runResearchPack(packInput);
    const packedSidecarPath = path.join(
      workspace,
      "outputs",
      "governance",
      "pack",
      "artifacts",
      "model-review-bundle.json"
    );
    expect(await readFile(packedSidecarPath)).toEqual(fixture.modelReviewBundleBytes);
    expect(packResult.artifact.files).toContainEqual(expect.objectContaining({
      path: "artifacts/model-review-bundle.json",
      sha256: fixture.reviewResult.artifact.reviewer_assurance.model_review_bundle_sha256
    }));
    await expect(inspectPaperReadinessBundle({
      cwd: workspace,
      bundleRoot: "outputs/governance/pack"
    })).resolves.toEqual(expect.objectContaining({ verdict: "pass", issues: [] }));
  });

  it("rejects missing or byte-tampered EvidenceBundle sidecars during packing", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-evidence-pack-tamper-"));
    tempDirs.push(workspace);
    const fixture = await writeA2ReviewFixture(workspace);
    const evidencePath = path.join(workspace, fixture.sourceDir, "evidence-bundle.json");
    const evidenceBytes = await readFile(evidencePath);
    const packInput = {
      cwd: workspace,
      gatePath: fixture.gateResult.output_path,
      reviewPath: fixture.reviewResult.output_path,
      sourceDir: fixture.sourceDir,
      outDir: "outputs/governance/pack"
    };

    await rm(evidencePath);
    await expect(runResearchPack(packInput)).rejects.toThrow(
      "evidence-bundle.json to be a regular, non-symbolic-link file"
    );

    await writeFile(evidencePath, Buffer.concat([evidenceBytes, Buffer.from("\n", "utf8")]));
    await expect(runResearchPack(packInput)).rejects.toThrow(
      "EvidenceBundle sidecar SHA-256 does not match"
    );
  });

  it("rejects a semantically tampered A2 ReviewReport even when its artifact id is preserved", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-review-pack-tamper-"));
    tempDirs.push(workspace);
    const fixture = await writeA2ReviewFixture(workspace);
    await writeFile(
      path.join(workspace, fixture.sourceDir, "model-review-bundle.json"),
      fixture.modelReviewBundleBytes
    );
    const reviewPath = path.join(workspace, fixture.reviewResult.output_path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    const preservedArtifactId = review.artifact_id;
    review.paper_ready = true;
    await writeJson(reviewPath, review);

    await expect(runResearchPack({
      cwd: workspace,
      gatePath: fixture.gateResult.output_path,
      reviewPath: fixture.reviewResult.output_path,
      sourceDir: fixture.sourceDir,
      outDir: "outputs/governance/pack"
    })).rejects.toThrow("does not exactly match its bound gate and ModelReviewBundle reconstruction");
    expect(review.artifact_id).toBe(preservedArtifactId);
  });

  it("detects A2 packed sidecar tampering even when the manifest file hash is updated", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-model-review-pack-tamper-"));
    tempDirs.push(workspace);
    const packRoot = await writeA2GovernancePack(workspace);
    const sidecarPath = path.join(packRoot, "artifacts", "model-review-bundle.json");
    const tamperedBytes = Buffer.concat([
      await readFile(sidecarPath),
      Buffer.from("\n", "utf8")
    ]);
    await writeFile(sidecarPath, tamperedBytes);
    const manifestPath = path.join(packRoot, "paper-readiness-bundle.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      files: Array<{ path: string; sha256: string; bytes: number }>;
    };
    const sidecarBinding = manifest.files.find(
      (binding) => binding.path === "artifacts/model-review-bundle.json"
    );
    if (!sidecarBinding) throw new Error("A2 fixture did not bind its ModelReviewBundle sidecar.");
    sidecarBinding.sha256 = createHash("sha256").update(tamperedBytes).digest("hex");
    sidecarBinding.bytes = tamperedBytes.byteLength;
    await writeJson(manifestPath, manifest);

    const inspection = await inspectPaperReadinessBundle({ cwd: workspace, bundleRoot: packRoot });

    expect(inspection.verdict).toBe("fail");
    expect(inspection.issues).toContainEqual(expect.objectContaining({
      code: "artifact_binding_mismatch",
      path: "artifacts/model-review-bundle.json",
      message: expect.stringContaining("reviewer_assurance.model_review_bundle_sha256")
    }));
  });

  it("advances a structurally complete external bundle only to its supported claim ceiling", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-research-complete-"));
    const external = path.join(workspace, "external-artifacts");
    tempDirs.push(workspace);
    await writeCompleteExternalBundle(external);

    const gateResult = await runResearchAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/governance/audit"
    });
    const reviewResult = await runResearchReview({
      cwd: workspace,
      gatePath: gateResult.output_path,
      outDir: "outputs/governance/review"
    });

    expect(gateResult.artifact.verdict).toBe("pass");
    expect(gateResult.artifact.claim_ceiling).toBe("conditional_claims_with_artifact_links");
    expect(reviewResult.artifact.readiness_class).toBe("paper_scale_candidate");
    expect(reviewResult.artifact.paper_ready).toBe(false);
  });
});

async function writeCompleteExternalBundle(root: string): Promise<void> {
  await mkdir(path.join(root, "figure_audit"), { recursive: true });
  await mkdir(path.join(root, "review"), { recursive: true });
  await mkdir(path.join(root, "paper"), { recursive: true });
  await writeJson(path.join(root, "governance_condition.json"), { name: "gated" });
  await writeJson(path.join(root, "result_table.json"), [
    {
      metric: "primary_score",
      baseline: 0.61,
      comparator: 0.67,
      delta: 0.06,
      direction: "higher_better"
    }
  ]);
  await writeFile(
    path.join(root, "evidence_store.jsonl"),
    `${JSON.stringify({ id: "metric_evidence", metric: "primary_score", value: 0.67, metric_evidence_present: true })}\n`,
    "utf8"
  );
  await writeJson(path.join(root, "figure_audit", "figure_audit_summary.json"), {
    audited_at: "2026-07-20T00:00:00.000Z",
    figure_count: 1,
    issues: [],
    severe_mismatch_count: 0,
    review_block_required: false
  });
  await writeJson(path.join(root, "review", "paper_critique.json"), {
    paper_readiness_state: "paper_scale_candidate",
    claim_ceiling_applied: true
  });
  await writeJson(path.join(root, "review", "decision.json"), { outcome: "revise" });
  await writeFile(path.join(root, "paper", "main.tex"), "\\section{Results}\n", "utf8");
  await writeJson(path.join(root, "paper", "paper_readiness.json"), {
    paper_ready: false,
    readiness_state: "paper_scale_candidate"
  });
  await writeJson(path.join(root, "paper", "claim_evidence_table.json"), { claims: [] });
  await writeJson(path.join(root, "paper", "claim_status_table.json"), { claims: [] });
  await writeJson(path.join(root, "paper", "evidence_links.json"), { claims: [] });
}

function makeModelReviewBundle(gateReportId: string, gateSha256: string): ModelReviewBundle {
  const bundle: ModelReviewBundle = {
    schema_version: "1.0",
    artifact_type: "ModelReviewBundle",
    gate_report: {
      artifact_id: gateReportId,
      sha256: gateSha256
    },
    policy: {
      consensus_is_evidence: false,
      may_override_deterministic_gate: false,
      may_create_external_evidence: false
    },
    reviewers: REQUIRED_MODEL_REVIEW_ROLES.map((role, index) => ({
      reviewer_id: `reviewer-${role.replace(/_/gu, "-")}`,
      role,
      provenance: makeModelProvenance(role, index),
      findings: role === "claim_evidence"
        ? [{
            code: "model_claim_scope_warning",
            severity: "warning" as const,
            message: "The broadest claim should remain scoped to the measured comparison.",
            evidence_refs: ["gate-report.json#/checks"],
            target_node: "analyze_results" as const,
            target_surface: "validator" as const,
            recheck_condition: "The claim matches the measured comparison."
          }]
        : []
    })),
    adjudicator: {
      reviewer_id: "reviewer-meta",
      role: "meta_reviewer",
      provenance: makeModelProvenance("meta_reviewer", REQUIRED_MODEL_REVIEW_ROLES.length),
      findings: [{
        code: "model_robustness_gap",
        severity: "blocker",
        message: "The reported comparison lacks an executed robustness check.",
        evidence_refs: ["gate-report.json#/findings"],
        target_node: "run_experiments",
        target_surface: "validator",
        recheck_condition: "An executed robustness check is bound to the gate."
      }, {
        code: "model_claim_scope_warning",
        severity: "warning",
        message: "The broadest claim should remain scoped to the measured comparison.",
        evidence_refs: ["gate-report.json#/checks"],
        target_node: "analyze_results",
        target_surface: "validator",
        recheck_condition: "The claim matches the measured comparison."
      }]
    }
  };
  bindReviewHashes(bundle);
  return bundle;
}

function makeModelProvenance(
  role: ModelReviewRole | "meta_reviewer",
  index: number
): ModelReviewerProvenance {
  return {
    actor: "model",
    provider: "<model-provider>",
    model: "<frontier-model>",
    reasoning_effort: "high",
    execution_id: `execution-${role.replace(/_/gu, "-")}`,
    context_isolated: true,
    input_sha256: digest(`input-${index}`),
    output_sha256: digest(`output-${index}`)
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bindReviewHashes(bundle: ModelReviewBundle): void {
  for (const reviewer of bundle.reviewers) {
    reviewer.provenance.output_sha256 = hashModelReviewOutput(reviewer);
  }
  bundle.adjudicator.provenance.input_sha256 = hashModelReviewAdjudicatorInput(
    bundle.gate_report,
    bundle.reviewers
  );
  bundle.adjudicator.provenance.output_sha256 = hashModelReviewOutput(bundle.adjudicator);
}

async function writeA2ReviewFixture(workspace: string) {
  const external = path.join(workspace, "external-artifacts");
  await writeCompleteExternalBundle(external);
  const gateResult = await runResearchAudit({
    cwd: workspace,
    externalRoot: external,
    outDir: "outputs/governance/audit"
  });
  const gateBytes = await readFile(path.join(workspace, gateResult.output_path));
  const gateSha256 = createHash("sha256").update(gateBytes).digest("hex");
  const modelReviewBundle = makeModelReviewBundle(gateResult.artifact.artifact_id, gateSha256);
  const modelReviewBundlePath = path.join(workspace, "model-review-input.json");
  await writeJson(modelReviewBundlePath, modelReviewBundle);
  const modelReviewBundleBytes = await readFile(modelReviewBundlePath);
  const reviewResult = await runResearchReview({
    cwd: workspace,
    gatePath: gateResult.output_path,
    modelReviewBundlePath: "model-review-input.json",
    outDir: "outputs/governance/review"
  });
  return {
    gateResult,
    reviewResult,
    modelReviewBundleBytes,
    sourceDir: "outputs/governance/audit"
  };
}

async function writeA2GovernancePack(workspace: string): Promise<string> {
  const fixture = await writeA2ReviewFixture(workspace);
  await writeFile(
    path.join(workspace, fixture.sourceDir, "model-review-bundle.json"),
    fixture.modelReviewBundleBytes
  );
  await runResearchPack({
    cwd: workspace,
    gatePath: fixture.gateResult.output_path,
    reviewPath: fixture.reviewResult.output_path,
    sourceDir: fixture.sourceDir,
    outDir: "outputs/governance/pack"
  });
  return path.join(workspace, "outputs", "governance", "pack");
}

async function writeGovernancePack(workspace: string): Promise<string> {
  const external = path.join(workspace, "external-artifacts");
  await mkdir(external, { recursive: true });
  await writeJson(path.join(external, "result_table.json"), [
    { metric: "primary_score", baseline: 0.8, comparator: 0.2, delta: -0.6, direction: "higher_better" }
  ]);
  const gateResult = await runResearchAudit({
    cwd: workspace,
    externalRoot: external,
    outDir: "outputs/governance/audit"
  });
  const reviewResult = await runResearchReview({
    cwd: workspace,
    gatePath: gateResult.output_path,
    outDir: "outputs/governance/review"
  });
  await runResearchPack({
    cwd: workspace,
    gatePath: gateResult.output_path,
    reviewPath: reviewResult.output_path,
    sourceDir: "outputs/governance/audit",
    outDir: "outputs/governance/pack"
  });
  return path.join(workspace, "outputs", "governance", "pack");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}
