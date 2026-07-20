import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function check(id, passed, details = {}) {
  return { id, passed: Boolean(passed), ...details };
}

function parseSuccessfulResult(result, workspace, args) {
  if (result.status !== 0) {
    const diagnostic = (result.stderr || result.stdout || "no diagnostic")
      .replaceAll(workspace, "<validation-workspace>")
      .trim()
      .slice(0, 1200);
    throw new Error(`research ${args[0]} failed with exit ${result.status}: ${diagnostic}`);
  }
  return JSON.parse(result.stdout);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeCompleteExternalBundle(root) {
  writeJson(path.join(root, "governance_condition.json"), { name: "controlled_comparison" });
  writeJson(path.join(root, "result_table.json"), [
    {
      metric: "primary_measure",
      baseline: 0.61,
      comparator: 0.67,
      delta: 0.06,
      direction: "higher_better"
    }
  ]);
  fs.writeFileSync(
    path.join(root, "evidence_store.jsonl"),
    `${JSON.stringify({ id: "measure_evidence", metric: "primary_measure", value: 0.67, metric_evidence_present: true })}\n`,
    "utf8"
  );
  writeJson(path.join(root, "figure_audit", "figure_audit_summary.json"), {
    audited_at: "2026-07-20T00:00:00.000Z",
    figure_count: 1,
    issues: [],
    severe_mismatch_count: 0,
    review_block_required: false
  });
  writeJson(path.join(root, "review", "paper_critique.json"), {
    paper_readiness_state: "paper_scale_candidate",
    claim_ceiling_applied: true
  });
  writeJson(path.join(root, "review", "decision.json"), { outcome: "revise" });
  fs.mkdirSync(path.join(root, "paper"), { recursive: true });
  fs.writeFileSync(path.join(root, "paper", "main.tex"), "\\section{Results}\n", "utf8");
  writeJson(path.join(root, "paper", "paper_readiness.json"), {
    paper_ready: false,
    readiness_state: "paper_scale_candidate"
  });
  writeJson(path.join(root, "paper", "claim_evidence_table.json"), { claims: [] });
  writeJson(path.join(root, "paper", "claim_status_table.json"), { claims: [] });
  writeJson(path.join(root, "paper", "evidence_links.json"), { claims: [] });
}

function assertCheck(checks, id, condition, details = {}) {
  const item = check(id, condition, details);
  checks.push(item);
  if (!item.passed) throw new Error(`E2E assertion failed: ${id}`);
}

export function runResearchGovernanceAcceptance({
  repoRoot,
  execute,
  gate,
  executionSurface,
  validationCommand,
  workspacePrefix = "autolabos-research-governance-e2e-",
  preflightChecks = []
}) {
  const validationRoot = process.env.AUTOLABOS_VALIDATION_WORKSPACE_ROOT
    ? path.resolve(process.env.AUTOLABOS_VALIDATION_WORKSPACE_ROOT)
    : os.tmpdir();
  fs.mkdirSync(validationRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(validationRoot, workspacePrefix));
  const checks = [...preflightChecks];
  let processCount = 0;

  try {
    const executeResearch = (args) => {
      processCount += 1;
      return execute(workspace, args);
    };
    const run = (args) => parseSuccessfulResult(executeResearch(args), workspace, args);

    const newResult = run(["new", "--brief", "Brief.md", "--out-dir", "outputs/new"]);
    assertCheck(checks, "new_emits_versioned_incomplete_brief", newResult.artifact.schema_version === "1.0"
      && newResult.artifact.artifact_type === "ResearchBrief"
      && newResult.artifact.completeness.paper_scale_ready === false);

    fs.mkdirSync(path.join(workspace, "weak-input"), { recursive: true });
    const weakGate = run(["audit", "--external", "weak-input", "--out-dir", "outputs/weak/audit"]);
    const weakReview = run(["review", "--gate", weakGate.output_path, "--out-dir", "outputs/weak/review"]);
    const weakImprove = run(["improve", "--review", weakReview.output_path, "--out-dir", "outputs/weak/improve"]);
    const weakPack = run([
      "pack",
      "--gate", weakGate.output_path,
      "--review", weakReview.output_path,
      "--source-dir", "outputs/weak/audit",
      "--out-dir", "outputs/weak/pack"
    ]);
    const weakPackVerification = run(["verify-pack", "--root", "outputs/weak/pack"]);
    writeJson(path.join(workspace, "incompatible-gate.json"), { ...weakGate.artifact, schema_version: "2.0" });
    const versionFailure = executeResearch([
      "review",
      "--gate", "incompatible-gate.json",
      "--out-dir", "outputs/incompatible/review"
    ]);
    const versionStderr = versionFailure.stderr || "";
    assertCheck(checks, "schema_version_mismatch_is_concise_and_blocking", versionFailure.status === 1
      && versionStderr.includes("Invalid GateReport")
      && versionStderr.includes("Expected schema version 1.0")
      && !versionStderr.includes("\n    at ")
      && !versionStderr.includes(repoRoot)
      && !versionStderr.includes(workspace));
    assertCheck(checks, "weak_input_stays_blocked", weakGate.artifact.verdict === "blocked"
      && weakReview.artifact.readiness_class === "blocked_for_paper_scale"
      && weakReview.artifact.paper_ready === false);
    const weakTargets = weakImprove.artifact.targets.map((target) => `${target.finding_code}:${target.target_node}`);
    assertCheck(checks, "weak_input_targets_experiment_and_analysis_nodes", weakImprove.artifact.apply_mode === "plan_only"
      && weakTargets.includes("artifact_contract_incomplete:run_experiments")
      && weakTargets.includes("result_table_missing:analyze_results"));
    assertCheck(checks, "weak_bundle_is_portable_and_hash_verified", weakPack.artifact.paper_ready === false
      && weakPack.artifact.portability.valid === true
      && weakPackVerification.verdict === "pass"
      && weakPackVerification.closed_inventory === true
      && weakPackVerification.checked_files === weakPack.artifact.files.length,
      weakPackVerification);
    writeJson(path.join(workspace, "outputs", "weak", "pack", "unbound.json"), { unbound: true });
    const unboundFailure = executeResearch(["verify-pack", "--root", "outputs/weak/pack"]);
    const unboundReport = JSON.parse(unboundFailure.stdout);
    assertCheck(checks, "bundle_verification_fails_on_unbound_files", unboundFailure.status === 1
      && unboundReport.verdict === "fail"
      && unboundReport.closed_inventory === false
      && unboundReport.issues.some((issue) => issue.code === "unexpected_file"));
    fs.rmSync(path.join(workspace, "outputs", "weak", "pack", "unbound.json"));

    const completeRoot = path.join(workspace, "complete-input");
    fs.mkdirSync(completeRoot, { recursive: true });
    writeCompleteExternalBundle(completeRoot);
    const completeGate = run(["audit", "--external", "complete-input", "--out-dir", "outputs/complete/audit"]);
    const completeReview = run(["review", "--gate", completeGate.output_path, "--out-dir", "outputs/complete/review"]);
    const completePack = run([
      "pack",
      "--gate", completeGate.output_path,
      "--review", completeReview.output_path,
      "--source-dir", "outputs/complete/audit",
      "--out-dir", "outputs/complete/pack"
    ]);
    const completePackVerification = run(["verify-pack", "--root", "outputs/complete/pack"]);
    assertCheck(checks, "complete_input_respects_claim_ceiling", completeGate.artifact.verdict === "pass"
      && completeGate.artifact.claim_ceiling === "conditional_claims_with_artifact_links"
      && completeReview.artifact.readiness_class === "paper_scale_candidate"
      && completeReview.artifact.paper_ready === false);
    assertCheck(checks, "complete_bundle_is_portable_and_hash_verified", completePack.artifact.paper_ready === false
      && completePack.artifact.claim_ceiling === "conditional_claims_with_artifact_links"
      && completePack.artifact.portability.valid === true
      && completePackVerification.verdict === "pass"
      && completePackVerification.closed_inventory === true,
      completePackVerification);

    return {
      commandIntent: "research:audit",
      outputArtifact: "GateReport",
      verdict: "pass",
      gate,
      executionSurface,
      processCount,
      checks,
      validationCommand
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
