import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  assessEvidenceAdequacy,
  buildEvidenceAdequacyContract,
  buildEvidenceAdequacyExecutionReceipt,
  EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH
} from "../src/core/analysis/evidenceAdequacy.js";
import { hashCanonical } from "../src/core/canonicalHash.js";
import { buildRunOperatorStatus } from "../src/core/runs/runStatus.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import type { RunRecord } from "../src/types.js";
import { seedValidNonIndependentReviewAssurance } from "./helpers/reviewAssuranceFixture.js";

let workspaceRoot = "";

afterEach(async () => {
  if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true });
  workspaceRoot = "";
});

describe("run status reference authority defense", () => {
  it("does not project paper_ready from an unbound reference gate or non-independent review", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-status-reference-"));
    const run = makeRun("run-reference-authority");
    run.graph.nodeStates.review.status = "completed";
    const paperDir = path.join(workspaceRoot, ".autolabos", "runs", run.id, "paper");
    await fs.mkdir(paperDir, { recursive: true });
    await fs.writeFile(
      path.join(paperDir, "paper_readiness.json"),
      JSON.stringify({ paper_ready: true, readiness_state: "paper_ready" }),
      "utf8"
    );

    const unbound = await buildRunOperatorStatus({ workspaceRoot, run, approvalMode: "minimal" });
    expect(unbound.paper_ready).toBe(false);

    await fs.writeFile(
      path.join(paperDir, "paper_readiness.json"),
      JSON.stringify({
        paper_ready: true,
        readiness_state: "paper_ready",
        reference_authority_gate: { status: "pass", submission_gate_passed: true }
      }),
      "utf8"
    );
    const selfAsserted = await buildRunOperatorStatus({ workspaceRoot, run, approvalMode: "minimal" });
    expect(selfAsserted.paper_ready).toBe(false);

    await writePassingReferenceAuthority(paperDir);
    const referenceBoundWithoutEvidence = await buildRunOperatorStatus({
      workspaceRoot,
      run,
      approvalMode: "minimal"
    });
    expect(referenceBoundWithoutEvidence.paper_ready).toBe(false);
    expect(referenceBoundWithoutEvidence.evidence_adequacy.paper_evidence_allowed)
      .toBe(false);

    await seedEvidenceAdequacy(workspaceRoot, run, "pass");
    await seedPassingResearchProcessArtifacts(workspaceRoot, run);
    await seedValidNonIndependentReviewAssurance({ workspaceRoot, run });
    const bound = await buildRunOperatorStatus({ workspaceRoot, run, approvalMode: "minimal" });
    expect(bound.evidence_adequacy.reason_codes).toEqual([]);
    expect(bound.evidence_adequacy).toMatchObject({
      trusted: true,
      paper_evidence_allowed: true
    });
    expect(bound.review_assurance).toMatchObject({
      trusted: true,
      paper_ready_eligible: true
    });
    expect(bound.research_process).toMatchObject({
      status: "blocked",
      paper_ready_eligible: false
    });
    expect(bound.research_process.reason_codes).toContain("independent_validation_not_trusted");
    expect(bound.paper_ready).toBe(false);
  });

  it("prioritizes a pending backtrack over the generic resume-review label", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-status-backtrack-"));
    const run = makeRun("run-backtrack-priority", {
      currentNode: "review",
      status: "paused",
      currentNodeStatus: "needs_approval"
    });
    run.graph.pendingTransition = {
      action: "backtrack_to_design",
      sourceNode: "review",
      targetNode: "design_experiments",
      reason: "The evidence contract must be repaired before review can continue.",
      confidence: 0.99,
      autoExecutable: true,
      evidence: ["review/minimum_gate.json"],
      suggestedCommands: ["/agent run design_experiments"],
      generatedAt: "2026-01-01T00:00:00.000Z"
    };

    const status = await buildRunOperatorStatus({
      workspaceRoot,
      run,
      approvalMode: "minimal"
    });

    expect(status.recommended_next_action).toBe("inspect_blocker");
  });

  it("reports a valid frozen contract as awaiting execution before the run node starts", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-status-evidence-awaiting-"));
    const run = makeRun("run-evidence-awaiting", {
      currentNode: "implement_experiments",
      status: "running",
      currentNodeStatus: "running"
    });
    run.graph.nodeStates.design_experiments.status = "completed";
    await seedEvidenceAdequacy(workspaceRoot, run, "contract_only");

    const status = await buildRunOperatorStatus({
      workspaceRoot,
      run,
      approvalMode: "minimal"
    });

    expect(status.evidence_adequacy).toMatchObject({
      status: "awaiting_execution",
      trusted: false,
      integrity_valid: false,
      paper_evidence_allowed: false,
      contract_present: true,
      receipt_present: false,
      assessment_present: false,
      primary_comparison_id: "primary_comparison"
    });
    expect(status.evidence_adequacy.reason_codes).toContain(
      "evidence_adequacy_execution_pending"
    );
  });

  it("accepts a deterministic exhaustive pass without seed or optimizer fields", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-status-evidence-pass-"));
    const run = makePostAnalysisRun("run-evidence-pass");
    await seedEvidenceAdequacy(workspaceRoot, run, "pass");

    const status = await buildRunOperatorStatus({
      workspaceRoot,
      run,
      approvalMode: "minimal"
    });

    expect(status.evidence_adequacy).toMatchObject({
      status: "pass",
      overall_status: "pass",
      trusted: true,
      integrity_valid: true,
      paper_evidence_allowed: true,
      contract_present: true,
      receipt_present: true,
      assessment_present: true,
      primary_comparison_id: "primary_comparison"
    });
    expect(status.evidence_adequacy.artifact_refs.map((ref) => ref.kind)).toEqual([
      "contract",
      "receipt",
      "assessment"
    ]);
  });

  it.each(["fail", "unknown"] as const)(
    "keeps a valid %s assessment trusted while blocking paper evidence",
    async (outcome) => {
      workspaceRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), `run-status-evidence-${outcome}-`)
      );
      const run = makePostAnalysisRun(`run-evidence-${outcome}`);
      await seedEvidenceAdequacy(workspaceRoot, run, outcome);

      const status = await buildRunOperatorStatus({
        workspaceRoot,
        run,
        approvalMode: "minimal"
      });

      expect(status.evidence_adequacy).toMatchObject({
        status: outcome,
        overall_status: outcome,
        trusted: true,
        integrity_valid: true,
        paper_evidence_allowed: false
      });
      expect(status.evidence_adequacy.reason_codes.length).toBeGreaterThan(0);
    }
  );

  it("distinguishes post-execution missing contract, missing receipt, and invalid states", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-status-evidence-missing-"));
    const missingContractRun = makePostAnalysisRun("run-missing-contract");
    const missingReceiptRun = makePostAnalysisRun("run-missing-receipt");
    const invalidRun = makePostAnalysisRun("run-invalid-contract");
    missingContractRun.currentNode = "review";
    missingContractRun.graph.currentNode = "review";
    missingContractRun.graph.nodeStates.review.status = "needs_approval";
    await seedEvidenceAdequacy(workspaceRoot, missingReceiptRun, "contract_only");
    await seedEvidenceAdequacy(workspaceRoot, invalidRun, "contract_only");
    await fs.writeFile(
      path.join(
        workspaceRoot,
        ".autolabos",
        "runs",
        invalidRun.id,
        EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH
      ),
      "{}\n",
      "utf8"
    );

    const [missingContract, missingReceipt, invalid] = await Promise.all([
      buildRunOperatorStatus({
        workspaceRoot,
        run: missingContractRun,
        approvalMode: "minimal"
      }),
      buildRunOperatorStatus({
        workspaceRoot,
        run: missingReceiptRun,
        approvalMode: "minimal"
      }),
      buildRunOperatorStatus({
        workspaceRoot,
        run: invalidRun,
        approvalMode: "minimal"
      })
    ]);

    expect(missingContract.evidence_adequacy).toMatchObject({
      status: "missing_contract",
      trusted: false,
      paper_evidence_allowed: false,
      contract_present: false,
      review_reassessment_present: false
    });
    expect(missingContract.evidence_adequacy.reason_codes).toContain(
      "evidence_adequacy_review_reassessment_missing"
    );
    expect(missingReceipt.evidence_adequacy).toMatchObject({
      status: "missing_receipt",
      trusted: false,
      paper_evidence_allowed: false,
      contract_present: true,
      receipt_present: false
    });
    expect(invalid.evidence_adequacy).toMatchObject({
      status: "invalid",
      trusted: false,
      integrity_valid: false,
      paper_evidence_allowed: false,
      contract_present: true
    });
    expect(invalid.evidence_adequacy.reason_codes).toContain(
      "evidence_adequacy_contract_invalid"
    );
  });

  it("fails closed when an active review reassessment disagrees with current artifacts", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "run-status-review-evidence-"));
    const run = makePostAnalysisRun("run-review-evidence-mismatch");
    run.currentNode = "review";
    run.graph.currentNode = "review";
    run.graph.nodeStates.review.status = "needs_approval";
    await seedEvidenceAdequacy(workspaceRoot, run, "pass");
    const reviewDir = path.join(
      workspaceRoot,
      ".autolabos",
      "runs",
      run.id,
      "review"
    );
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.writeFile(
      path.join(reviewDir, "evidence_adequacy_reassessment.json"),
      JSON.stringify({
        schema_version: 1,
        artifact_kind: "review_evidence_adequacy_reassessment",
        status: "pass",
        trusted: true,
        paper_evidence_allowed: false,
        integrity_valid: true,
        contract_present: true,
        receipt_present: true,
        stored_assessment_present: true,
        primary_comparison_id: "primary_comparison",
        overall_status: "pass",
        issues: [],
        warnings: []
      }),
      "utf8"
    );

    const status = await buildRunOperatorStatus({
      workspaceRoot,
      run,
      approvalMode: "minimal"
    });

    expect(status.evidence_adequacy).toMatchObject({
      status: "invalid",
      trusted: false,
      integrity_valid: false,
      paper_evidence_allowed: false,
      review_reassessment_present: true
    });
    expect(status.evidence_adequacy.reason_codes).toContain(
      "evidence_adequacy_review_reassessment_mismatch"
    );
    expect(status.evidence_adequacy.artifact_refs.at(-1)).toMatchObject({
      kind: "review_reassessment",
      path: "review/evidence_adequacy_reassessment.json"
    });

    await fs.writeFile(
      path.join(reviewDir, "evidence_adequacy_reassessment.json"),
      JSON.stringify({
        schema_version: 1,
        artifact_kind: "review_evidence_adequacy_reassessment",
        status: "pass",
        trusted: true,
        paper_evidence_allowed: true,
        integrity_valid: true,
        contract_present: true,
        receipt_present: true,
        stored_assessment_present: true,
        primary_comparison_id: "primary_comparison",
        overall_status: "pass",
        issues: [],
        warnings: []
      }),
      "utf8"
    );
    const matched = await buildRunOperatorStatus({
      workspaceRoot,
      run,
      approvalMode: "minimal"
    });
    expect(matched.evidence_adequacy).toMatchObject({
      status: "pass",
      trusted: true,
      integrity_valid: true,
      paper_evidence_allowed: true,
      review_reassessment_present: true
    });
  });
});

function makeRun(
  id: string,
  overrides: {
    currentNode?: RunRecord["currentNode"];
    status?: RunRecord["status"];
    currentNodeStatus?: RunRecord["graph"]["nodeStates"][RunRecord["currentNode"]]["status"];
  } = {}
): RunRecord {
  const now = new Date().toISOString();
  const graph = createDefaultGraphState();
  const currentNode = overrides.currentNode ?? "write_paper";
  graph.currentNode = currentNode;
  graph.nodeStates[currentNode].status = overrides.currentNodeStatus ?? "completed";
  return {
    version: 3,
    workflowVersion: 3,
    id,
    title: "Reference authority fixture",
    topic: "Domain-neutral governance",
    constraints: [],
    objectiveMetric: "decision quality",
    status: overrides.status ?? "completed",
    currentNode,
    nodeThreads: {},
    createdAt: now,
    updatedAt: now,
    graph,
    memoryRefs: {
      runContextPath: `.autolabos/runs/${id}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${id}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${id}/memory/episodes.jsonl`
    }
  };
}

function makePostAnalysisRun(id: string): RunRecord {
  const run = makeRun(id, {
    currentNode: "analyze_results",
    status: "paused",
    currentNodeStatus: "completed"
  });
  run.graph.nodeStates.run_experiments.status = "completed";
  return run;
}

async function seedPassingResearchProcessArtifacts(root: string, run: RunRecord): Promise<void> {
  const runDir = path.join(root, ".autolabos", "runs", run.id);
  await fs.mkdir(path.join(runDir, "paper"), { recursive: true });
  const write = (relativePath: string, value: unknown) =>
    fs.writeFile(path.join(runDir, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await Promise.all([
    write("experiment_contract.json", {
      version: 2,
      run_id: run.id,
      created_at: new Date().toISOString(),
      hypothesis: "A typed handoff changes the primary outcome.",
      causal_mechanism: "The handoff reduces information loss.",
      single_change: "Replace one handoff representation.",
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
        required_comparisons: [{ id: "primary_comparison", subject_series_id: "subject", reference_series_id: "reference", metric_id: "metric-primary", scope: { partition: "evaluation" } }],
        primary_comparison_id: "primary_comparison"
      }
    }),
    write("experiment_portfolio.json", { execution_model: "single_run", primary_trial_group_id: "primary" }),
    write("run_manifest.json", { run_id: run.id, execution_model: "single_run", portfolio: { primary_trial_group_id: "primary" } }),
    write("metrics.json", { status: "completed", observations: [{ value: 1 }] }),
    write("objective_evaluation.json", { status: "met" }),
    write("run_experiments_verify_report.json", { status: "pass", stage: "success" }),
    write("result_analysis.json", { primary_comparison_id: "primary_comparison", condition_comparisons: [{ id: "primary_comparison", hypothesis_supported: true }] }),
    write("paper/claim_evidence_table.json", { claims: [{ claim_id: "claim-1", artifact_refs: ["result_analysis.json"], citation_refs: [] }] })
  ]);
}

async function seedEvidenceAdequacy(
  root: string,
  run: RunRecord,
  outcome: "contract_only" | "pass" | "fail" | "unknown"
): Promise<void> {
  const runDir = path.join(root, ".autolabos", "runs", run.id);
  await fs.mkdir(runDir, { recursive: true });
  const plannedUnits = ["unit_a", "unit_b"];
  const observedUnits = outcome === "fail" ? ["unit_a"] : plannedUnits;
  const populationManifestSha256 = hashCanonical({
    independent_unit_ids: plannedUnits
  });
  const contract = buildEvidenceAdequacyContract({
    primaryComparisonId: "primary_comparison",
    designSource: {
      kind: "deterministic_exhaustive_manifest",
      contentSha256: populationManifestSha256
    },
    independentUnit: {
      key: "unit identity",
      analysisUnit: "deterministic outcome"
    },
    plannedIndependentCoverage: {
      mode: "deterministic_exhaustive",
      targetUniqueUnits: plannedUnits.length,
      targetDenominatorPerArm: plannedUnits.length,
      populationManifestSha256
    },
    requiredContrast: {
      arms: ["subject", "reference"],
      paired: false,
      requiredCompletePairs: null
    },
    uncertaintyRequirement: {
      mode: "none",
      deterministicExhaustiveRationale:
        "Every declared unit is evaluated by a deterministic oracle."
    },
    effectResolution: {
      scale: "proportion",
      minimumResolvableEffect: 1 / plannedUnits.length
    },
    executionBudget: {
      applicable: false,
      notApplicableRationale:
        "The deterministic exhaustive evaluation has no iterative budget floor."
    }
  });
  await fs.writeFile(
    path.join(runDir, "experiment_contract.json"),
    JSON.stringify({
      version: 2,
      run_id: run.id,
      created_at: "2026-01-01T00:00:00.000Z",
      hypothesis: "The declared intervention changes the primary outcome.",
      causal_mechanism: "The intervention changes the measured process.",
      single_change: "Apply the declared intervention.",
      confounded: false,
      expected_metric_effect: "A measurable change in the primary outcome.",
      abort_condition: "Abort only on a validity failure.",
      keep_or_discard_rule: "Retain every contract-valid execution.",
      results_plan: {
        schema_version: "2.0",
        required_metrics: [],
        minimum_series_count: 2,
        minimum_comparison_count: 1,
        primary_comparison_id: contract.primary_comparison_id
      }
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(runDir, EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH),
    JSON.stringify(contract),
    "utf8"
  );
  if (outcome === "contract_only") {
    return;
  }

  await fs.writeFile(path.join(runDir, "metrics.json"), "{}\n", "utf8");
  const receipt = buildEvidenceAdequacyExecutionReceipt({
    contractSha256: contract.content_sha256,
    primaryComparisonId: contract.primary_comparison_id,
    observedPopulationManifestSha256: populationManifestSha256,
    uniqueExecutionIds: observedUnits.map((unit) => `execution_${unit}`),
    observedIndependentUnitIds: observedUnits,
    observedDenominatorByArm: {
      subject: observedUnits.length,
      reference: observedUnits.length
    },
    primaryEvidenceRefs: ["metrics.json"],
    deterministicOracleEvidenceRefs:
      outcome === "unknown" ? [] : ["metrics.json"]
  });
  const assessment = assessEvidenceAdequacy({
    contract,
    receipt,
    verifiedEvidenceRefs: ["metrics.json"]
  });
  await Promise.all([
    fs.writeFile(
      path.join(runDir, EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH),
      JSON.stringify(receipt),
      "utf8"
    ),
    fs.writeFile(
      path.join(runDir, EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH),
      JSON.stringify(assessment),
      "utf8"
    )
  ]);
}

async function writePassingReferenceAuthority(paperDir: string): Promise<void> {
  const manuscript = "\\section{Results}\n";
  const manuscriptSha256 = createHash("sha256").update(manuscript, "utf8").digest("hex");
  await fs.writeFile(path.join(paperDir, "main.tex"), manuscript, "utf8");
  await fs.writeFile(
    path.join(paperDir, "reference_evidence_status.json"),
    JSON.stringify({
      schema_version: "1.0",
      manuscript: "paper/main.tex",
      manuscript_projection: {
        source_ref: "paper/main.tex",
        package_ref: "paper/main.tex",
        source_sha256: manuscriptSha256,
        package_content_sha256: manuscriptSha256
      },
      submission_gate_passed: true,
      summary: {
        citation_bearing_claim_count: 0,
        independently_checked_claim_count: 0,
        missing_full_text_claim_count: 0
      },
      blocking_requirements: []
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(paperDir, "refgate_claims.tsv"),
    "claim_id\tmanuscript_location\tclaim_text\tcitation_key\tsource_location\tquote_or_evidence\tevidence_kind\tstatus\tnotes\tclaim_type\timportance\n",
    "utf8"
  );
}
