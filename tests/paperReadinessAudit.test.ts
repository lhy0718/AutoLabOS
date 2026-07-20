import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { formatPaperReadinessAuditCliSummary } from "../src/cli/audit.js";
import { runPaperReadinessAudit } from "../src/core/audit/paperReadinessAudit.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("paper-readiness audit", () => {
  it.each([
    {
      name: "missing baseline",
      resultTable: [{ metric: "primary_score", baseline: null, comparator: 0.7, delta: null }],
      expectedBlocker: "baseline_or_comparator_missing",
      expectedCeiling: "descriptive_only_no_comparative_claims"
    },
    {
      name: "missing comparator",
      resultTable: [{ metric: "primary_score", baseline: 0.6, comparator: null, delta: null }],
      expectedBlocker: "baseline_or_comparator_missing",
      expectedCeiling: "descriptive_only_no_comparative_claims"
    },
    {
      name: "fallback-only evidence",
      resultTable: [{ metric: "primary_score", baseline: 0.6, comparator: 0.7, delta: 0.1 }],
      evidenceStore: [{ deterministic_fallback_used: true, fallback_label: "bounded_fallback" }],
      expectedBlocker: "fallback_only_evidence",
      expectedCeiling: "system_validation_note_only"
    }
  ])("blocks false paper-ready promotion for $name", async ({ resultTable, evidenceStore, expectedBlocker, expectedCeiling }) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-seed-"));
    tempDirs.push(workspace);
    const runRoot = await writeMinimalAuditRun(workspace, { resultTable, evidenceStore });

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/audit"
    });

    expect(summary.verdict).toBe("blocked");
    expect(summary.paper_readiness.paper_ready).toBe(false);
    expect(summary.top_blockers.map((blocker) => blocker.code)).toContain(expectedBlocker);
    expect(summary.claim_ceiling.allowed_level).toBe(expectedCeiling);
    expect(summary.outputs.report_path).toBe("outputs/audit/paper-readiness-audit.md");
    expect(summary.outputs.claim_evidence_path).toBe("outputs/audit/claim-evidence-table.json");
    expect(summary.outputs.audit_timeline_path).toBe("outputs/audit/audit-timeline.json");
    expect(summary.outputs.claim_promotion_timeline_path).toBe("outputs/audit/claim-promotion-timeline.json");
    expect(summary.outputs.blocked_claim_events_path).toBe("outputs/audit/blocked-claim-events.json");
    expect(summary.outputs.done_condition_path).toBe("outputs/audit/done-condition-audit.json");
    expect(summary.outputs.autonomy_metrics_path).toBe("outputs/audit/autonomy-metrics.json");
    expect(summary.audit_timeline.status).toBe("timeline_incomplete");
    expect(summary.done_condition.status).toBe("pass");
    expect(summary.judge_lane.judge_nodes).toContain("paper_readiness_audit");

    const report = await readFile(path.join(workspace, "outputs", "audit", "paper-readiness-audit.md"), "utf8");
    expect(report).toContain("Verdict: blocked");
    expect(report).toContain('<a id="verdict"></a>');
    expect(report).toContain('<a id="top-blockers"></a>');
    expect(report).toContain('<a id="unsupported-claims"></a>');
    expect(report).toContain('<a id="baseline-comparator-status"></a>');
    expect(report).toContain('<a id="result-table-completeness"></a>');
    expect(report).toContain('<a id="figure-result-caption-mismatch"></a>');
    expect(report).toContain('<a id="citation-support"></a>');
    expect(report).toContain('<a id="design-contract-findings"></a>');
    expect(report).toContain('<a id="literature-discovery-findings"></a>');
    expect(report).toContain('<a id="judge-lane"></a>');
    expect(report).toContain('<a id="audit-timeline"></a>');
    expect(report).toContain('<a id="done-condition"></a>');
    expect(report).toContain('<a id="autonomy-metrics"></a>');
    expect(report).toContain("## Claim Ceiling");
    expect(report).toContain('<a id="claim-ceiling"></a>');
    expect(report).toContain('<a id="next-actions"></a>');

    const cliOutput = formatPaperReadinessAuditCliSummary(summary);
    expect(cliOutput).toContain("Paper-readiness audit: blocked");
    expect(cliOutput).toContain("Severity:");
    expect(cliOutput).toContain("Top blockers:");
    expect(cliOutput).toContain("  blocker:");
    expect(cliOutput).toContain(`report: ${summary.outputs.report_path}`);
    expect(cliOutput).toContain(`claim evidence: ${summary.outputs.claim_evidence_path}`);

    const blockers = JSON.parse(
      await readFile(path.join(workspace, "outputs", "audit", "blockers.json"), "utf8")
    ) as { blockers: Array<{ code: string }> };
    expect(blockers.blockers.map((blocker) => blocker.code)).toContain(expectedBlocker);

    const claimEvidence = await readFile(path.join(workspace, "outputs", "audit", "claim-evidence-table.json"), "utf8");
    expect(claimEvidence).toContain("does not create evidence");

    const timeline = await readFile(path.join(workspace, "outputs", "audit", "audit-timeline.json"), "utf8");
    expect(timeline).toContain("paper_readiness_verdict");
    const claimPromotion = await readFile(path.join(workspace, "outputs", "audit", "claim-promotion-timeline.json"), "utf8");
    expect(claimPromotion).toContain("Claim promotion events are derived");
    const blockedClaimEvents = await readFile(path.join(workspace, "outputs", "audit", "blocked-claim-events.json"), "utf8");
    expect(blockedClaimEvents).toContain(expectedBlocker);
    const doneCondition = await readFile(path.join(workspace, "outputs", "audit", "done-condition-audit.json"), "utf8");
    expect(doneCondition).toContain("write_paper completion");
    const autonomyMetrics = await readFile(path.join(workspace, "outputs", "audit", "autonomy-metrics.json"), "utf8");
    expect(autonomyMetrics).toContain("evidence_integrity_score");
  });

  it("audits an existing run artifact root", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-run-"));
    tempDirs.push(workspace);
    const runRoot = await writeMinimalAuditRun(workspace, {
      resultTable: [{ metric: "primary_score", baseline: null, comparator: 0.7, delta: null }]
    });

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/run-audit"
    });

    expect(summary.input.mode).toBe("run");
    expect(summary.verdict).toBe("blocked");
    expect(summary.baseline_comparator_status.status).toBe("missing");
    expect(summary.result_table_completeness.paper_ready_allowed).toBe(false);
  });

  it("blocks an external package without a governed done-condition source", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-no-done-condition-"));
    const external = path.join(workspace, "external-package");
    tempDirs.push(workspace);
    await mkdir(external, { recursive: true });
    await writeFile(path.join(external, "manuscript.tex"), "\\section{Method}\n", "utf8");

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/no-done-condition-audit"
    });

    expect(summary.done_condition.status).toBe("unmeasured");
    expect(summary.done_condition.failure_count).toBeGreaterThan(0);
    expect(summary.top_blockers).toContainEqual(expect.objectContaining({
      code: "done_condition_unmeasured"
    }));
    expect(summary.autonomy_metrics.reproducibility_score.value).toBeLessThan(1);
  });

  it("blocks quantitative result assertions below a quantitative claim ceiling", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-quantitative-ceiling-"));
    const external = path.join(workspace, "external-package");
    tempDirs.push(workspace);
    await mkdir(external, { recursive: true });
    await writeFile(
      path.join(external, "manuscript.tex"),
      "\\section{Results}\nAccuracy was 0.70 and F1 was 1.00.\n",
      "utf8"
    );

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/quantitative-ceiling-audit"
    });

    expect(summary.claim_ceiling.allowed_level).toBe("research_memo_without_quantitative_claims");
    expect(summary.top_blockers).toContainEqual(expect.objectContaining({
      code: "manuscript_quantitative_claim_ceiling_conflict"
    }));
    expect(summary.next_action_checklist).toContain(
      "Remove unsupported quantitative result assertions or bind recomputable result evidence before rerunning write_paper."
    );
  });

  it.each([
    {
      name: "missing",
      prepare: async (summaryPath: string) => {
        await rm(summaryPath, { force: true });
      },
      expectedBlocker: "figure_audit_missing_or_malformed"
    },
    {
      name: "malformed",
      prepare: async (summaryPath: string) => {
        await writeFile(summaryPath, JSON.stringify({ severe_mismatch_count: 0 }), "utf8");
      },
      expectedBlocker: "figure_audit_missing_or_malformed"
    }
  ])("fails closed when figure audit evidence is $name", async ({ prepare, expectedBlocker }) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-figure-missing-"));
    tempDirs.push(workspace);
    const runRoot = await writeMinimalAuditRun(workspace, {
      resultTable: [
        { metric: "primary_score", baseline: 0.6, comparator: 0.7, delta: 0.1, direction: "higher_better" }
      ]
    });
    await prepare(path.join(runRoot, "figure_audit", "figure_audit_summary.json"));
    await writeJson(path.join(runRoot, "paper", "paper_readiness.json"), {
      paper_ready: true,
      readiness_state: "paper_ready"
    });

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/figure-missing-audit"
    });

    expect(summary.verdict).toBe("blocked");
    expect(summary.top_blockers.map((blocker) => blocker.code)).toContain(expectedBlocker);
    expect(summary.figure_result_caption_mismatch.manuscript_promotion_allowed).toBe(false);
    expect(summary.done_condition.status).toBe("fail");
    expect(summary.done_condition.failure_count).toBeGreaterThan(0);
    const doneCondition = JSON.parse(
      await readFile(
        path.join(workspace, "outputs", "figure-missing-audit", "done-condition-audit.json"),
        "utf8"
      )
    ) as { failures: string[] };
    expect(doneCondition.failures).toContain(
      "A measured figure audit is required for manuscript promotion"
    );
  });

  it("keeps the no-figure-audit condition evaluable but bars manuscript promotion", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-figure-ablation-"));
    tempDirs.push(workspace);
    const runRoot = await writeMinimalAuditRun(workspace, {
      resultTable: [
        { metric: "primary_score", baseline: 0.6, comparator: 0.7, delta: 0.1, direction: "higher_better" }
      ]
    });
    await rm(path.join(runRoot, "figure_audit", "figure_audit_summary.json"), { force: true });
    await writeJson(path.join(runRoot, "governance_condition.json"), {
      name: "no_figure_audit",
      expected_paper_ready: false,
      allowed_weak_output_states: ["paper_ready=false", "system_validation_note"]
    });

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/figure-ablation-audit"
    });

    expect(summary.scorer_outputs.figure_audit.audit_status).toBe("ablated");
    expect(summary.top_blockers.map((blocker) => blocker.code)).toContain("figure_audit_ablated");
    expect(summary.figure_result_caption_mismatch.manuscript_promotion_allowed).toBe(false);
  });

  it("audits runtime comparison-summary result tables without treating them as missing", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-live-result-table-"));
    tempDirs.push(workspace);
    const runRoot = await writeMinimalAuditRun(workspace, {
      resultTable: {
        conditions: [
          {
            name: "candidate_condition_f5_vs_baseline_condition",
            metrics: {
              accuracy_delta_vs_baseline_mean: 0.066667
            }
          }
        ],
        comparisons: [
          {
            primary: "candidate_condition_f5_vs_baseline_condition",
            baseline: "metrics.condition_summaries",
            metric: "accuracy_delta_vs_baseline_mean",
            delta: 0.066667,
            hypothesis_supported: true
          }
        ],
        primary_metric: "accuracy_delta_vs_baseline"
      }
    });

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/live-result-table-audit"
    });

    expect(summary.result_table_completeness.measured).toBe(true);
    expect(summary.result_table_completeness.row_count).toBe(1);
    expect(summary.top_blockers.map((blocker) => blocker.code)).not.toContain("result_table_missing");
    expect(summary.top_blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(["result_table_incomplete", "baseline_or_comparator_missing"])
    );
    expect(summary.claim_ceiling.allowed_level).toBe("descriptive_only_no_comparative_claims");
  });

  it("does not treat failed write_paper artifacts as completed manuscript acceptance", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-failed-write-paper-"));
    tempDirs.push(workspace);
    const runRoot = await writeMinimalAuditRun(workspace, {
      resultTable: [
        {
          metric: "accuracy",
          baseline: 0.7,
          comparator: 0.75,
          delta: 0.05,
          direction: "higher_better"
        }
      ],
      runRecord: {
        id: "failed-write-paper-run",
        status: "paused",
        graph: {
          nodeStates: {
            write_paper: {
              status: "failed",
              lastError: "manuscript-quality gate failed"
            }
          }
        }
      }
    });

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/failed-write-paper-audit"
    });

    expect(summary.paper_readiness.write_paper_completed).toBe(false);
    expect(summary.top_blockers.map((blocker) => blocker.code)).toContain("write_paper_failed");
    expect(summary.next_action_checklist.join("\n")).toContain("manuscript as unaccepted");
  });

  it("does not infer write_paper completion or failed-run visibility from manuscript presence", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-unmeasured-completion-"));
    tempDirs.push(workspace);
    const runRoot = await writeMinimalAuditRun(workspace, {
      resultTable: [
        {
          metric: "primary_score",
          baseline: 0.4,
          comparator: 0.5,
          delta: 0.1,
          direction: "higher_better"
        }
      ]
    });

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/unmeasured-completion-audit"
    });
    const doneCondition = JSON.parse(
      await readFile(
        path.join(workspace, "outputs", "unmeasured-completion-audit", "done-condition-audit.json"),
        "utf8"
      )
    ) as { checks: Array<{ id: string; passed: boolean | null }> };

    expect(summary.paper_readiness.write_paper_completed).toBe(false);
    expect(
      doneCondition.checks.find((check) => check.id === "failed_run_visibility_required")?.passed
    ).toBeNull();
    expect(
      doneCondition.checks.find((check) => check.id === "write_paper_not_paper_ready")?.passed
    ).toBeNull();
  });

  it("uses portable placeholders when run and output roots are outside cwd", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-portable-roots-"));
    const repoRoot = path.join(workspace, "repo");
    const outDir = path.join(workspace, "audit-output");
    tempDirs.push(workspace);
    await mkdir(repoRoot, { recursive: true });
    const runRoot = await writeMinimalAuditRun(workspace, {
      resultTable: [
        {
          metric: "primary_score",
          baseline: 0.4,
          comparator: 0.5,
          delta: 0.1,
          direction: "higher_better"
        }
      ]
    });

    const summary = await runPaperReadinessAudit({
      cwd: repoRoot,
      runRoot,
      outDir
    });

    expect(summary.input.run_root).toBe("<run-artifact-root>");
    expect(summary.outputs.report_path).toBe("<output>/paper-readiness-audit.md");
    expect(JSON.stringify(summary)).not.toContain(workspace);
    const report = await readFile(path.join(outDir, "paper-readiness-audit.md"), "utf8");
    expect(report).not.toContain(workspace);
  });

  it("does not require seed-only governance_condition artifacts for ordinary run audits", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-ordinary-run-contract-"));
    tempDirs.push(workspace);
    const runRoot = await writeMinimalAuditRun(workspace, {
      includeGovernanceCondition: false,
      resultTable: [
        {
          metric: "accuracy",
          baseline: 0.7,
          comparator: 0.75,
          delta: 0.05,
          direction: "higher_better"
        }
      ]
    });

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/ordinary-run-audit"
    });

    expect(summary.top_blockers.map((blocker) => blocker.code)).not.toContain("artifact_contract_incomplete");
    expect(summary.scorer_outputs.governance_score.dimension_scores.artifact_completeness).toBe(2);
    expect(summary.artifact_contract?.passed).toBe(true);
    expect(summary.artifact_contract?.required_artifacts.every(
      (artifact) => artifact.status === "present"
    )).toBe(true);
  });

  it("fails the done-condition audit when paper_ready hides known blockers", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-done-condition-"));
    tempDirs.push(workspace);
    const runRoot = await writeMinimalAuditRun(workspace, {
      resultTable: [{ metric: "primary_score", baseline: null, comparator: 0.7, delta: null }]
    });
    await writeFile(
      path.join(runRoot, "paper", "paper_readiness.json"),
      JSON.stringify({ paper_ready: true, readiness_state: "paper_ready" }),
      "utf8"
    );
    await writeFile(
      path.join(runRoot, "run_record.json"),
      JSON.stringify({ id: "failed-run", status: "failed" }),
      "utf8"
    );

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/done-condition-audit"
    });

    expect(summary.done_condition.status).toBe("fail");
    expect(summary.done_condition.failure_count).toBeGreaterThan(0);
    expect(summary.top_blockers.map((blocker) => blocker.code)).toContain("hidden_failed_run");
    const doneCondition = await readFile(
      path.join(workspace, "outputs", "done-condition-audit", "done-condition-audit.json"),
      "utf8"
    );
    expect(doneCondition).toContain("Paper-ready comparative claims require baseline/comparator evidence");
  });

  it("uses only run-artifact evidence for selected P2 design contract audit findings", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-design-contract-"));
    tempDirs.push(workspace);
    const runRoot = await writeMinimalAuditRun(workspace, {
      resultTable: [{ metric: "primary_score", baseline: null, comparator: 0.7, delta: null }]
    });
    await mkdir(path.join(runRoot, "audit"), { recursive: true });
    await writeFile(
      path.join(runRoot, "audit", "design_contracts.json"),
      JSON.stringify({
        findings: [
          {
            code: "advisory_design_note",
            severity: "blocker",
            message: "This design note is advisory only.",
            advisory_only: true
          }
        ],
        hidden_failed_worker_count: 2,
        failed_worker_visibility: "hidden",
        reverse_from_data_origin: true,
        exploratory_origin_visible: false,
        sota_ranking_claimed: true,
        sota_evidence_present: false
      }),
      "utf8"
    );

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/design-contract-audit"
    });

    expect(summary.design_contract_findings.map((finding) => finding.code)).toEqual([
      "distributed_worker_failure_hidden",
      "reverse_from_data_origin_hidden",
      "unsupported_sota_ranking"
    ]);
    expect(summary.top_blockers.map((blocker) => blocker.code)).toContain("distributed_worker_failure_hidden");
    expect(summary.top_blockers.map((blocker) => blocker.code)).not.toContain("advisory_design_note");

    const report = await readFile(
      path.join(workspace, "outputs", "design-contract-audit", "paper-readiness-audit.md"),
      "utf8"
    );
    expect(report).toContain('<a id="design-contract-findings"></a>');
    expect(report).toContain("distributed_worker_failure_hidden");
  });

  it("blocks repeated-run provenance, budget, and persisted-state inconsistencies", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-execution-integrity-"));
    tempDirs.push(workspace);
    const runRoot = await writeMinimalAuditRun(workspace, {
      resultTable: [
        { metric: "primary_score", baseline: 0.6, comparator: 0.7, delta: 0.1, direction: "higher_better" }
      ],
      runRecord: { id: "integrity-case", status: "completed", executed_budget: { trials: 1 } }
    });
    await writeJson(path.join(runRoot, "run_config.json"), { planned_budget: { trials: 3 } });
    await writeJson(path.join(runRoot, "experiment_evidence.json"), {
      trials: [{ score: 0.69 }, { score: 0.7 }, { score: 0.71 }]
    });
    await mkdir(path.join(runRoot, "checkpoint"), { recursive: true });
    await writeJson(path.join(runRoot, "checkpoint", "state.json"), { paper_ready: false });
    await writeJson(path.join(runRoot, "paper", "paper_readiness.json"), {
      paper_ready: true,
      readiness_state: "paper_ready"
    });

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/execution-integrity-audit"
    });

    expect(summary.verdict).toBe("blocked");
    expect(summary.execution_integrity_findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "repeated_run_provenance_missing", target_node: "run_experiments" }),
      expect.objectContaining({ code: "budget_contract_mismatch", target_node: "run_experiments" }),
      expect.objectContaining({ code: "stale_persisted_state", target_node: "review" })
    ]));
    expect(summary.top_blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "repeated_run_provenance_missing",
      "budget_contract_mismatch",
      "stale_persisted_state"
    ]));
    const report = await readFile(
      path.join(workspace, "outputs", "execution-integrity-audit", "paper-readiness-audit.md"),
      "utf8"
    );
    expect(report).toContain("## Execution Integrity Findings");
  });

  it("requires distinct trial provenance while accepting source-neutral trial IDs", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-audit-trial-provenance-"));
    tempDirs.push(workspace);
    const runRoot = await writeMinimalAuditRun(workspace, {
      resultTable: [
        { metric: "primary_score", baseline: 0.6, comparator: 0.7, delta: 0.1, direction: "higher_better" }
      ],
      runRecord: { id: "trial-provenance-case", status: "completed", executed_budget: { trials: 3 } }
    });
    await writeJson(path.join(runRoot, "run_config.json"), { planned_budget: { trials: 3 } });
    await writeJson(path.join(runRoot, "experiment_evidence.json"), {
      trials: [{ trial_id: "trial-a" }, { trial_id: "trial-a" }, { trial_id: "trial-a" }]
    });
    const duplicateSummary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/duplicate-trial-audit"
    });
    expect(duplicateSummary.execution_integrity_findings.map((finding) => finding.code))
      .toContain("repeated_run_provenance_missing");

    await writeJson(path.join(runRoot, "experiment_evidence.json"), {
      trials: [{ trial_id: "trial-a" }, { trial_id: "trial-b" }, { trial_id: "trial-c" }]
    });
    const distinctSummary = await runPaperReadinessAudit({
      cwd: workspace,
      runRoot,
      outDir: "outputs/distinct-trial-audit"
    });
    expect(distinctSummary.execution_integrity_findings.map((finding) => finding.code))
      .not.toContain("repeated_run_provenance_missing");
  });
});

async function writeMinimalAuditRun(
  workspace: string,
  input: {
    resultTable: unknown;
    evidenceStore?: Record<string, unknown>[];
    runRecord?: Record<string, unknown>;
    includeGovernanceCondition?: boolean;
  }
): Promise<string> {
  const runRoot = path.join(workspace, "runs", "live-audit-run");
  await mkdir(path.join(runRoot, "figure_audit"), { recursive: true });
  await mkdir(path.join(runRoot, "review"), { recursive: true });
  await mkdir(path.join(runRoot, "paper"), { recursive: true });
  if (input.includeGovernanceCondition !== false) {
    await writeJson(path.join(runRoot, "governance_condition.json"), {
      name: "gated",
      allowed_weak_output_states: ["paper_ready=false", "paper_scale_candidate"]
    });
  }
  await writeJson(path.join(runRoot, "result_table.json"), input.resultTable);
  await writeFile(
    path.join(runRoot, "evidence_store.jsonl"),
    `${(input.evidenceStore || [{ id: "ev_metric", metric: "primary_score", metric_evidence_present: true }])
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
    "utf8"
  );
  await writeJson(path.join(runRoot, "figure_audit", "figure_audit_summary.json"), {
    audited_at: "2026-05-06T00:00:00.000Z",
    figure_count: 1,
    issues: [],
    severe_mismatch_count: 0,
    review_block_required: false
  });
  await writeJson(path.join(runRoot, "review", "paper_critique.json"), {
    paper_readiness_state: "paper_scale_candidate",
    claim_ceiling_applied: true
  });
  await writeJson(path.join(runRoot, "review", "decision.json"), {
    outcome: "revise"
  });
  await writeFile(path.join(runRoot, "paper", "main.tex"), "\\section{Results}\n", "utf8");
  await writeJson(path.join(runRoot, "paper", "paper_readiness.json"), {
    paper_ready: false,
    readiness_state: "paper_scale_candidate"
  });
  await writeJson(path.join(runRoot, "paper", "claim_evidence_table.json"), {
    claims: []
  });
  await writeJson(path.join(runRoot, "paper", "claim_status_table.json"), {
    claims: []
  });
  await writeJson(path.join(runRoot, "paper", "evidence_links.json"), {
    claims: []
  });
  if (input.runRecord) {
    await writeJson(path.join(runRoot, "run_record.json"), input.runRecord);
  }
  return runRoot;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}
