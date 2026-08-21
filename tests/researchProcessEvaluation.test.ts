import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildRunResearchProcessProjection } from "../src/core/evaluation/researchProcessEvaluation.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { hashCanonical } from "../src/core/canonicalHash.js";
import type { RunEvidenceAdequacyProjection, RunRecord, RunReviewAssuranceProjection } from "../src/types.js";

describe("research process evaluation", () => {
  it("keeps future-stage checks not applicable instead of reporting false success", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-process-early-"));
    const run = makeRun("collect_papers");

    const projection = await buildRunResearchProcessProjection({ runDir, run });

    expect(projection.status).toBe("unmeasured");
    expect(projection.required_check_count).toBe(0);
    expect(projection.trusted).toBe(false);
    expect(projection.checks.every((check) => check.status === "not_applicable")).toBe(true);
  });

  it("passes only when the hypothesis, execution, evidence, review, and claim chain are explicit", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-process-pass-"));
    const run = makeRun("write_paper");
    await writePassingArtifacts(runDir, run.id);

    const projection = await buildRunResearchProcessProjection({
      runDir,
      run,
      evidenceAdequacy: passingEvidenceAdequacy(),
      reviewAssurance: passingReviewAssurance()
    });

    expect(projection).toMatchObject({
      status: "pass",
      trusted: true,
      paper_ready_eligible: true,
      required_check_count: 8,
      passed_required_check_count: 8,
      blocker_count: 0
    });
  });

  it("blocks plan-execution drift even when downstream artifacts exist", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-process-drift-"));
    const run = makeRun("write_paper");
    await writePassingArtifacts(runDir, run.id);
    await writeJson(path.join(runDir, "run_manifest.json"), {
      run_id: run.id,
      execution_model: "different_model",
      portfolio: { primary_trial_group_id: "primary" }
    });

    const projection = await buildRunResearchProcessProjection({
      runDir,
      run,
      evidenceAdequacy: passingEvidenceAdequacy(),
      reviewAssurance: passingReviewAssurance()
    });

    expect(projection.status).toBe("blocked");
    expect(projection.reason_codes).toContain("plan_execution_binding_mismatch");
    expect(projection.paper_ready_eligible).toBe(false);
  });

  it("blocks compatibility execution receipts from paper eligibility", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-process-envelope-"));
    const run = makeRun("write_paper");
    await writePassingArtifacts(runDir, run.id);
    await writeExecutionArtifacts(runDir, run.id, {
      enforcement: "compatibility",
      paperGradeEligible: false,
      reasonCodes: ["aci_adapter_missing_execution_envelope"]
    });

    const projection = await buildRunResearchProcessProjection({
      runDir,
      run,
      evidenceAdequacy: passingEvidenceAdequacy(),
      reviewAssurance: passingReviewAssurance()
    });

    expect(projection.status).toBe("blocked");
    expect(projection.reason_codes).toContain("execution_envelope_not_paper_grade");
    expect(projection.reason_codes).toContain("aci_adapter_missing_execution_envelope");
    expect(projection.paper_ready_eligible).toBe(false);
  });

  it("rejects a receipt whose bound output was changed without recomputing its hash", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-process-receipt-tamper-"));
    const run = makeRun("write_paper");
    await writePassingArtifacts(runDir, run.id);
    const receiptPath = path.join(runDir, "execution", "execution_receipt.json");
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Record<string, unknown>;
    receipt.required_outputs_present = false;
    await writeJson(receiptPath, receipt);

    const projection = await buildRunResearchProcessProjection({
      runDir,
      run,
      evidenceAdequacy: passingEvidenceAdequacy(),
      reviewAssurance: passingReviewAssurance()
    });

    expect(projection.status).toBe("blocked");
    expect(projection.reason_codes).toContain("execution_receipt_integrity_invalid");
  });

  it("rejects a metrics artifact that changed after the execution receipt was issued", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-process-output-drift-"));
    const run = makeRun("write_paper");
    await writePassingArtifacts(runDir, run.id);
    await writeJson(path.join(runDir, "metrics.json"), {
      status: "completed",
      observations: [{ value: 99 }]
    });

    const projection = await buildRunResearchProcessProjection({
      runDir,
      run,
      evidenceAdequacy: passingEvidenceAdequacy(),
      reviewAssurance: passingReviewAssurance()
    });

    expect(projection.status).toBe("blocked");
    expect(projection.reason_codes).toContain("execution_output_hash_mismatch");
  });

  it("rejects a recomputed receipt that omits device-policy assurance", async () => {
    const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-process-device-assurance-"));
    const run = makeRun("write_paper");
    await writePassingArtifacts(runDir, run.id);
    const receiptPath = path.join(runDir, "execution", "execution_receipt.json");
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Record<string, unknown>;
    const assurance = receipt.assurance as Record<string, unknown>;
    assurance.device_policy_enforced = false;
    delete receipt.receipt_sha256;
    receipt.receipt_sha256 = hashCanonical(receipt);
    await writeJson(receiptPath, receipt);

    const projection = await buildRunResearchProcessProjection({
      runDir,
      run,
      evidenceAdequacy: passingEvidenceAdequacy(),
      reviewAssurance: passingReviewAssurance()
    });

    expect(projection.status).toBe("blocked");
    expect(projection.reason_codes).toContain("execution_assurance_incomplete");
  });
});

function makeRun(currentNode: RunRecord["currentNode"]): RunRecord {
  const graph = createDefaultGraphState();
  graph.currentNode = currentNode;
  return {
    version: 3,
    workflowVersion: 3,
    id: "run-process",
    title: "Process fixture",
    topic: "Neutral coordination study",
    constraints: [],
    objectiveMetric: "primary measure",
    status: currentNode === "write_paper" ? "paused" : "running",
    currentNode,
    nodeThreads: {},
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    graph,
    memoryRefs: { runContextPath: "", longTermPath: "", episodePath: "" }
  };
}

async function writePassingArtifacts(runDir: string, runId: string): Promise<void> {
  await fs.mkdir(path.join(runDir, "paper"), { recursive: true });
  await writeJson(path.join(runDir, "metrics.json"), {
    status: "completed",
    observations: [{ value: 1 }]
  });
  await writeExecutionArtifacts(runDir, runId, {
    enforcement: "enforced",
    paperGradeEligible: true,
    reasonCodes: []
  });
  await Promise.all([
    writeJson(path.join(runDir, "experiment_contract.json"), {
      version: 2,
      run_id: runId,
      created_at: "2026-08-09T00:00:00.000Z",
      hypothesis: "A typed handoff changes the primary measure.",
      causal_mechanism: "The handoff reduces information loss.",
      single_change: "Replace the untyped handoff.",
      confounded: false,
      expected_metric_effect: "Increase the primary measure.",
      abort_condition: "Abort only on invalid input or resource exhaustion.",
      keep_or_discard_rule: "Retain every contract-valid execution regardless of effect direction.",
      baselines: ["reference system"],
      results_plan: {
        schema_version: "2.0",
        required_metrics: [{ id: "metric-primary", label: "Primary measure", direction: "higher_better", unit: "points" }],
        minimum_series_count: 2,
        minimum_comparison_count: 1,
        required_series: [{ id: "reference", role: "baseline" }, { id: "subject", role: "primary" }],
        required_comparisons: [{ id: "comparison-primary", subject_series_id: "subject", reference_series_id: "reference", metric_id: "metric-primary", scope: { partition: "evaluation" } }],
        primary_comparison_id: "comparison-primary"
      }
    }),
    writeJson(path.join(runDir, "experiment_portfolio.json"), { execution_model: "single_run", primary_trial_group_id: "primary" }),
    writeJson(path.join(runDir, "run_manifest.json"), { run_id: runId, execution_model: "single_run", portfolio: { primary_trial_group_id: "primary" } }),
    writeJson(path.join(runDir, "objective_evaluation.json"), { status: "met" }),
    writeJson(path.join(runDir, "run_experiments_verify_report.json"), { status: "pass", stage: "success" }),
    writeJson(path.join(runDir, "result_analysis.json"), { primary_comparison_id: "comparison-primary", condition_comparisons: [{ id: "comparison-primary", hypothesis_supported: false }] }),
    writeJson(path.join(runDir, "paper", "claim_evidence_table.json"), { claims: [{ claim_id: "claim-1", artifact_refs: ["result_analysis.json"], citation_refs: [] }] })
  ]);
}

async function writeExecutionArtifacts(
  runDir: string,
  runId: string,
  input: {
    enforcement: "enforced" | "compatibility";
    paperGradeEligible: boolean;
    reasonCodes: string[];
  }
): Promise<void> {
  const envelopePayload = {
    version: 1,
    run_id: runId,
    phase: "primary",
    attempt: 1,
    execution_profile: "local",
    command: "node run_configured_experiment.js",
    command_sha256: "1".repeat(64),
    cwd: ".",
    writable_roots: ["."],
    environment_allowlist: ["PATH"],
    devices: {
      policy: "cpu_only",
      requested_gpu_count: 0,
      visible_device_ids: []
    },
    network: { policy: "declared" },
    limits: { timeout_ms: 1_000 },
    seeds: [17],
    seed_binding_status: "declared",
    input_artifacts: [{ path: "run_configured_experiment.js", sha256: "2".repeat(64) }],
    dependency_artifacts: [{ path: "package-lock.json", sha256: "3".repeat(64) }],
    expected_outputs: [{ path: "metrics.json", required: true }],
    created_at: "2026-08-09T00:00:00.000Z"
  };
  const envelopeSha256 = hashCanonical(envelopePayload);
  const envelope = {
    ...envelopePayload,
    envelope_id: `exec_${envelopeSha256.slice(0, 24)}`,
    envelope_sha256: envelopeSha256
  };
  const assuranceEnabled = input.enforcement === "enforced";
  const receiptPayload = {
    version: 1,
    envelope_id: envelope.envelope_id,
    envelope_sha256: envelope.envelope_sha256,
    run_id: runId,
    phase: "primary",
    attempt: 1,
    status: "completed",
    adapter: "fixture_adapter",
    enforcement: input.enforcement,
    paper_grade_eligible: input.paperGradeEligible,
    started_at: "2026-08-09T00:00:01.000Z",
    finished_at: "2026-08-09T00:00:02.000Z",
    duration_ms: 1_000,
    exit_code: 0,
    assurance: {
      environment_allowlist_enforced: assuranceEnabled,
      workspace_boundary_enforced: assuranceEnabled,
      input_hashes_verified: assuranceEnabled,
      timeout_enforced: assuranceEnabled,
      network_policy_enforced: assuranceEnabled,
      mount_isolation_enforced: assuranceEnabled,
      device_policy_enforced: assuranceEnabled
    },
    output_artifacts: [{
      path: "metrics.json",
      sha256: await hashFile(path.join(runDir, "metrics.json")),
      required: true
    }],
    required_outputs_present: true,
    reason_codes: input.reasonCodes
  };
  await fs.mkdir(path.join(runDir, "execution"), { recursive: true });
  await Promise.all([
    writeJson(path.join(runDir, "execution", "execution_envelope.json"), envelope),
    writeJson(path.join(runDir, "execution", "execution_receipt.json"), {
      ...receiptPayload,
      receipt_sha256: hashCanonical(receiptPayload)
    })
  ]);
}

function passingEvidenceAdequacy(): RunEvidenceAdequacyProjection {
  return { status: "pass", trusted: true, integrity_valid: true, paper_evidence_allowed: true, contract_present: true, receipt_present: true, assessment_present: true, review_reassessment_present: true, overall_status: "pass", reason_codes: [], artifact_refs: [] };
}

function passingReviewAssurance(): RunReviewAssuranceProjection {
  return { status: "valid", trusted: true, paper_ready_eligible: true, input_manifest_valid: true, gate_report_valid: true, assurance_valid: true, handoff_valid: true, model_review_bundle_valid: true, required_for_paper_ready: true, reason_codes: [], artifact_refs: [] };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}
