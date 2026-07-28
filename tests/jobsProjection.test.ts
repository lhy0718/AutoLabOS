import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { buildResearchGapMap } from "../src/core/researchFunnel.js";
import {
  buildAnalyzeResultsOperatorSummary,
  buildJobsTemplateLines,
  buildRunJobsSnapshot,
  formatRunJobProjectionLines,
  projectResearchFunnel
} from "../src/core/runs/jobsProjection.js";
import type { ResearchFunnelProjection } from "../src/core/runs/researchFunnelProjection.js";
import type { RunJobProjection, RunRecord } from "../src/types.js";

function makeRun(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  const graph = overrides.graph ?? createDefaultGraphState();
  const currentNode = overrides.currentNode ?? graph.currentNode;
  return {
    version: 3,
    workflowVersion: 3,
    id,
    title: overrides.title ?? `Run ${id}`,
    topic: overrides.topic ?? "topic",
    constraints: overrides.constraints ?? [],
    objectiveMetric: overrides.objectiveMetric ?? "primary_score",
    status: overrides.status ?? "paused",
    currentNode,
    latestSummary: overrides.latestSummary,
    nodeThreads: overrides.nodeThreads ?? {},
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    usage: overrides.usage,
    graph,
    memoryRefs: overrides.memoryRefs ?? {
      runContextPath: `.autolabos/runs/${id}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${id}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${id}/memory/episodes.jsonl`
    }
  };
}

let workspaceRoot: string;

afterEach(async () => {
  if (workspaceRoot) {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

describe("jobsProjection", () => {
  it("shows an unmeasured funnel only for topic discovery runs", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-jobs-mode-"));
    const hypothesisRun = makeRun("run-hypothesis-mode");
    const discoveryRun = makeRun("run-discovery-mode");
    for (const [run, mode] of [
      [hypothesisRun, "hypothesis_test"],
      [discoveryRun, "topic_discovery"]
    ] as const) {
      const briefDir = path.join(workspaceRoot, ".autolabos", "runs", run.id, "brief");
      await fs.mkdir(briefDir, { recursive: true });
      await fs.writeFile(
        path.join(briefDir, "source_brief.md"),
        `# Research Brief\n\n## Research Mode\n${mode}\n`,
        "utf8"
      );
    }

    const snapshot = await buildRunJobsSnapshot({
      workspaceRoot,
      runs: [hypothesisRun, discoveryRun],
      approvalMode: "minimal"
    });
    const byId = new Map(snapshot.runs.map((run) => [run.run_id, run] as const));

    expect(byId.get(hypothesisRun.id)?.research_funnel).toBeUndefined();
    expect(byId.get(discoveryRun.id)?.research_funnel).toMatchObject({
      research_mode: "topic_discovery",
      lifecycle_stage: "discovery",
      integrity_status: "unmeasured",
      authorization_disposition: "unmeasured",
      authorization_probe_allowed: false,
      bounded_probe_paper_evidence_allowed: false
    });
  });

  it("keeps successful node notes out of blocker projections", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-jobs-success-note-"));
    const run = makeRun("run-success-note", {
      currentNode: "design_experiments",
      status: "paused"
    });
    run.graph.currentNode = "design_experiments";
    run.graph.nodeStates.design_experiments.status = "completed";
    run.graph.nodeStates.design_experiments.note =
      "Bounded execution was authorized for two candidates.";

    const snapshot = await buildRunJobsSnapshot({
      workspaceRoot,
      runs: [run],
      approvalMode: "minimal"
    });

    expect(snapshot.runs[0]).toMatchObject({
      run_id: run.id,
      blocker_summary: undefined,
      blocking_reasons: [],
      recommended_next_action: "waiting_for_input"
    });
    expect(snapshot.top_failures).toEqual([]);
  });

  it("rejects cached downstream readiness after a backward research-cycle jump", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-jobs-stale-cycle-"));
    const run = makeRun("run-stale-cycle", {
      currentNode: "design_experiments",
      status: "paused",
      updatedAt: "2026-07-26T01:02:03.000Z"
    });
    run.graph.currentNode = "design_experiments";
    run.graph.researchCycle = 2;
    run.graph.checkpointSeq = 12;
    run.graph.nodeStates.design_experiments.status = "pending";
    run.graph.nodeStates.analyze_results.status = "pending";
    run.graph.nodeStates.review.status = "pending";
    run.graph.nodeStates.write_paper.status = "pending";

    const runDir = path.join(workspaceRoot, ".autolabos", "runs", run.id);
    await fs.mkdir(path.join(runDir, "paper"), { recursive: true });
    await fs.writeFile(
      path.join(runDir, "paper", "paper_readiness.json"),
      JSON.stringify({
        paper_ready: true,
        readiness_state: "paper_scale_candidate",
        reason: "Superseded downstream result."
      })
    );
    await fs.writeFile(
      path.join(runDir, "run_status.json"),
      JSON.stringify({
        version: 1,
        generated_at: "2026-07-26T00:00:00.000Z",
        run_id: run.id,
        research_cycle: 1,
        checkpoint_seq: 9,
        run_updated_at: "2026-07-25T23:59:59.000Z",
        title: run.title,
        current_node: "write_paper",
        lifecycle_status: "completed",
        approval_mode: "minimal",
        last_event_at: "2026-07-26T00:00:00.000Z",
        analysis_ready: true,
        review_ready: true,
        paper_ready: true,
        recommended_next_action: "completed",
        blocking_reasons: [],
        warning_reasons: [],
        review_gate: { status: "ready" },
        paper_gate: { status: "passed", readiness_state: "paper_scale_candidate" },
        network_dependency: {
          enabled: false,
          policy: "blocked",
          severity: "info",
          operator_label: "Offline"
        },
        validation_scope: "full_run"
      })
    );

    const snapshot = await buildRunJobsSnapshot({
      workspaceRoot,
      runs: [run],
      approvalMode: "minimal"
    });

    expect(snapshot.runs[0]).toMatchObject({
      current_node: "design_experiments",
      lifecycle_status: "paused",
      analysis_ready: false,
      review_ready: false,
      paper_ready: false
    });
    expect(snapshot.runs[0]?.paper_readiness_state).toBeUndefined();
  });

  it("surfaces review as an independent readiness stage with a resume_review next action", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-jobs-"));
    const run = makeRun("run-review");
    run.currentNode = "review";
    run.graph.currentNode = "review";
    run.status = "paused";
    run.graph.nodeStates.analyze_results.status = "completed";
    run.graph.nodeStates.review.status = "needs_approval";

    const runDir = path.join(workspaceRoot, ".autolabos", "runs", run.id);
    await fs.mkdir(path.join(runDir, "review"), { recursive: true });
    await fs.writeFile(path.join(runDir, "events.jsonl"), `${JSON.stringify({ timestamp: "2026-03-28T12:00:00.000Z" })}\n`);
    await fs.writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify({ overview: { objective_status: "met", objective_summary: "The target metric was met." } }, null, 2)
    );
    await fs.writeFile(
      path.join(runDir, "transition_recommendation.json"),
      JSON.stringify({ action: "advance", targetNode: "review", reason: "Ready for review." }, null, 2)
    );
    await fs.writeFile(
      path.join(runDir, "review", "review_packet.json"),
      JSON.stringify({ generated_at: "", checks: [], readiness: { status: "ready", ready_checks: 1, warning_checks: 0, blocking_checks: 0, manual_checks: 1 }, objective_status: "met", objective_summary: "The target metric was met.", suggested_actions: [], decision: { outcome: "advance", recommended_transition: "write_paper" } }, null, 2)
    );
    await fs.writeFile(
      path.join(runDir, "review", "scorecard.json"),
      JSON.stringify({ overall_score_1_to_5: 4.2 }, null, 2)
    );
    await fs.writeFile(
      path.join(runDir, "review", "paper_critique.json"),
      JSON.stringify({ blocking_issues_count: 0, paper_readiness_state: "paper_scale_candidate" }, null, 2)
    );
    await fs.writeFile(
      path.join(runDir, "review", "minimum_gate.json"),
      JSON.stringify({ passed: true, ceiling_type: "paper_scale_candidate" }, null, 2)
    );
    await fs.writeFile(
      path.join(runDir, "review", "readiness_risks.json"),
      JSON.stringify({ generated_at: "", paper_ready: false, readiness_state: "blocked_for_paper_scale", risk_count: 1, blocked_count: 1, warning_count: 0, risks: [{ risk_code: "review_blocked", severity: "blocked", category: "paper_scale", status: "blocked", message: "A baseline is still missing before paper drafting.", triggered_by: ["minimum_gate"], affected_claim_ids: [], affected_citation_ids: [], recommended_action: "Collect a baseline.", recheck_condition: "A baseline exists." }], summary_lines: [] }, null, 2)
    );

    const snapshot = await buildRunJobsSnapshot({
      workspaceRoot,
      runs: [run],
      approvalMode: "manual"
    });

    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({
      run_id: run.id,
      current_node: "review",
      lifecycle_status: "needs_approval",
      analysis_ready: true,
      review_ready: true,
      paper_ready: false,
      review_gate_status: "ready",
      review_decision_outcome: "advance",
      review_recommended_transition: "write_paper",
      review_score_overall: 4.2,
      recommended_next_action: "resume_review",
      blocker_summary: "A baseline is still missing before paper drafting."
    });
    expect(snapshot.top_failures[0]?.reason).toContain("baseline");
  });

  it("separates baseline evidence readiness from workflow artifact readiness", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-jobs-evidence-"));
    const run = makeRun("run-evidence-ready", { currentNode: "review", status: "paused" });
    run.graph.currentNode = "review";
    run.graph.nodeStates.analyze_results.status = "completed";
    run.graph.nodeStates.review.status = "pending";
    const runDir = path.join(workspaceRoot, ".autolabos", "runs", run.id);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, "result_analysis.json"), "{}", "utf8");
    await fs.writeFile(path.join(runDir, "transition_recommendation.json"), "{}", "utf8");
    await fs.writeFile(
      path.join(runDir, "baseline_comparison.json"),
      JSON.stringify({
        version: 1,
        generated_at: "2026-01-01T00:00:00.000Z",
        run_id: run.id,
        status: "available",
        source_artifacts: [],
        enforcement: {},
        primary_comparison: { id: "declared-comparison" },
        comparisons: [{ id: "declared-comparison" }],
        warnings: []
      }),
      "utf8"
    );

    const snapshot = await buildRunJobsSnapshot({
      workspaceRoot,
      runs: [run],
      approvalMode: "minimal"
    });

    expect(snapshot.runs[0]).toMatchObject({
      analysis_ready: true,
      evidence_readiness: {
        status: "available",
        evidence_ready: true,
        trusted: true,
        comparison_count: 1,
        primary_comparison_id: "declared-comparison"
      }
    });
    expect(formatRunJobProjectionLines({ projection: snapshot.runs[0]! })).toContain(
      "  evidence readiness: status=available ready=yes trusted=yes comparisons=1 primary=declared-comparison"
    );
  });

  it("reloads research-funnel integrity from artifacts for every jobs snapshot", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-jobs-funnel-"));
    const run = makeRun("run-funnel", { currentNode: "generate_hypotheses", status: "paused" });
    run.graph.currentNode = "generate_hypotheses";

    const runDir = path.join(workspaceRoot, ".autolabos", "runs", run.id);
    await fs.mkdir(path.join(runDir, "analysis"), { recursive: true });
    await fs.mkdir(path.join(runDir, "brief"), { recursive: true });
    await fs.writeFile(
      path.join(runDir, "brief", "source_brief.md"),
      "# Research Brief\n\n## Research Mode\ntopic_discovery\n",
      "utf8"
    );
    const gapMap = buildResearchGapMap({
      generatedAt: "2026-01-01T00:00:00.000Z",
      evidence: [
        {
          evidence_id: "evidence_a",
          paper_id: "paper_a",
          limitation_slot: "Prior evaluations omit an independent comparison family.",
          source_type: "full_text"
        },
        {
          evidence_id: "evidence_b",
          paper_id: "paper_b",
          limitation_slot: "Prior evaluations omit an independent comparison family.",
          source_type: "abstract"
        }
      ]
    });
    await fs.writeFile(
      path.join(runDir, "analysis", "gap_map.json"),
      JSON.stringify(gapMap, null, 2),
      "utf8"
    );

    const firstSnapshot = await buildRunJobsSnapshot({
      workspaceRoot,
      runs: [run],
      approvalMode: "minimal"
    });
    expect(firstSnapshot.runs[0]?.research_funnel).toMatchObject({
      integrity_status: "mismatch",
      authorization_probe_allowed: false,
      probe_candidate_count: 0,
      candidate_count: 0,
      gap_evidence_audit: {
        status: "blocked",
        total_evidence_count: 0,
        accepted_cluster_count: 0
      }
    });
    expect(
      formatRunJobProjectionLines({ projection: firstSnapshot.runs[0]! })
        .some((line) => line.includes("research funnel: mode=topic_discovery lifecycle=invalid_chain integrity=mismatch"))
    ).toBe(true);

    const tamperedGapMap = structuredClone(gapMap);
    tamperedGapMap.gaps[0]!.statement = "Modified without refreshing the content hash.";
    await fs.writeFile(
      path.join(runDir, "analysis", "gap_map.json"),
      JSON.stringify(tamperedGapMap, null, 2),
      "utf8"
    );
    const secondSnapshot = await buildRunJobsSnapshot({
      workspaceRoot,
      runs: [run],
      approvalMode: "minimal"
    });
    expect(secondSnapshot.runs[0]?.research_funnel?.integrity_status).toBe("mismatch");
    expect(secondSnapshot.runs[0]?.research_funnel?.reason_codes).toContain(
      "research_gap_map_content_hash_mismatch"
    );
  });

  it("preserves only a verified active bounded-probe contract in jobs output", () => {
    const contractHash = "a".repeat(64);
    const source: ResearchFunnelProjection = {
      researchMode: "topic_discovery",
      lifecycleStage: "probe_authorized",
      boundedProbePaperEvidenceAllowed: false,
      collectionState: "quality_gate_passed",
      collectionNodeAttempt: 1,
      collectionNodeMaxAttempts: 3,
      queryPlanAttempt: 1,
      collectionQualityFailureReasons: [],
      gapEvidenceAudit: {
        status: "verified",
        constructionMode: "reviewed_semantic_synthesis",
        synthesisStatus: "completed",
        total_evidence_count: 8,
        scientific_evidence_count: 6,
        grounded_scientific_evidence_count: 5,
        synthesis_eligible_evidence_count: 4,
        synthesis_excluded_evidence_count: 4,
        accepted_cluster_count: 2,
        malformed_evidence_row_count: 0,
        source_scope_counts: {
          abstract: 1,
          full_text_excerpt: 7,
          full_document: 0,
          unknown: 0
        },
        grounding_status_counts: {
          grounded_span: 5,
          ungrounded_span: 3,
          fallback: 0,
          unknown: 0
        }
      },
      candidateCount: 5,
      clusterCount: 3,
      topicMemory: {
        status: "verified",
        trusted: true,
        ledgerHash: "9".repeat(64),
        recordCount: 3,
        blockedCandidateCount: 2,
        reentryRequiredCount: 1,
        reentryAllowedCount: 1,
        auditArtifactRef: {
          label: "Topic memory audit",
          path: "hypothesis_generation/topic_memory_audit.json"
        },
        updateArtifactRef: {
          label: "Topic memory update",
          path: "analysis/topic_memory_update.json"
        }
      },
      diagnosticsTrusted: true,
      authorizationTrusted: true,
      portfolioCandidates: [
        {
          rank: 1,
          candidateId: "candidate-contract",
          topicId: "topic-contract",
          statement: "Evaluate a bounded candidate under a declared comparison.",
          trusted: true,
          reviewStatus: "kept",
          probeStatus: "shortlisted",
          probeEligible: true,
          scores: {
            novelty: 4,
            feasibility: 5,
            testability: 5,
            cost: 4,
            expected_gain: 3
          },
          closestPriorPaperIds: ["paper-prior"],
          closestPriorFullTextPaperIds: ["paper-prior"],
          priorAbsorptionComparisons: [
            { priorPaperId: "paper-prior", disposition: "non_overlapping" }
          ],
          priorAbsorptionReasonCodes: [],
          closestPriorNonOverlap: "The declared evaluation protocol is not covered.",
          reviewerAbsorptionObjection: "The nearest prior may already cover the mechanism.",
          comparator: "declared reference",
          datasetTaskBench: "bounded evaluation set",
          primaryMetric: "primary_score",
          localBudget: "one local execution window",
          killSignal: "Reject when the paired effect misses the declared floor.",
          contributionClaim: "A bounded protocol-level contribution.",
          minimumPublishableEvidence: "Repeated paired comparisons with uncertainty.",
          reviewSummary: "Retain only after direct-prior verification.",
          topicMemoryDisposition: "clear",
          topicMemoryMaximumLineageSimilarity: 0.2,
          blockedGateCodes: []
        }
      ],
      probeCandidateCount: 2,
      probeCandidateIds: ["candidate-contract", "candidate-deferred"],
      probeCandidateStatements: ["Evaluate the declared candidate under a bounded protocol."],
      activeCandidateId: "candidate-contract",
      activeTopicId: "topic-contract",
      activeCandidateHash: "e".repeat(64),
      activePrimaryMetric: "primary_score",
      activeMetricUnit: "proportion",
      activeMetricScale: "proportion",
      activeMetricDirection: "maximize",
      activeEffectCriterion: {
        basis: "delta_vs_reference",
        magnitude: 0.05,
        scale: "proportion",
        inclusive: true
      },
      activeObjectiveRaw: "{\"primary_metric\":\"primary_score\"}",
      activeMeaningfulEffect: "At least 0.05 over the declared comparator.",
      activeEvidenceStage: "bounded_probe",
      activeDeferredCandidateIds: ["candidate-deferred"],
      authorizationDisposition: "probe_authorized",
      authorizationProbeAllowed: true,
      outcomeGate: {
        status: "unmeasured",
        trusted: false,
        reasonCodes: []
      },
      followupHandoff: {
        status: "unmeasured",
        trusted: false
      },
      reviewGate: {
        status: "unmeasured",
        trusted: false,
        paperDraftingAllowed: false,
        reasonCodes: []
      },
      invalidChainBlockers: [],
      reasonCodes: [],
      gates: [],
      dissent: [],
      literatureQueries: [],
      queryFallbackUsed: false,
      queryFallbackReasons: [],
      hashes: {
        gapMap: "b".repeat(64),
        topicPortfolio: "c".repeat(64),
        topicDecision: "d".repeat(64),
        activeTopicProbeContract: contractHash
      },
      artifactRefs: [
        {
          label: "Active topic probe contract",
          path: "design_experiments_panel/active_topic_probe_contract.json"
        }
      ],
      integrityStatus: "complete"
    };

    const projected = projectResearchFunnel(source);

    expect(projected).toMatchObject({
      collection_state: "quality_gate_passed",
      collection_node_attempt: 1,
      collection_node_max_attempts: 3,
      query_plan_attempt: 1,
      collection_quality_failure_reasons: [],
      gap_evidence_audit: {
        status: "verified",
        grounded_scientific_evidence_count: 5,
        accepted_cluster_count: 2
      },
      topic_memory: {
        status: "verified",
        trusted: true,
        ledger_sha256: "9".repeat(64),
        record_count: 3,
        blocked_candidate_count: 2,
        reentry_required_count: 1,
        reentry_allowed_count: 1,
        audit_artifact_ref: {
          path: "hypothesis_generation/topic_memory_audit.json"
        },
        update_artifact_ref: {
          path: "analysis/topic_memory_update.json"
        }
      },
      portfolio_candidates: [
        {
          candidate_id: "candidate-contract",
          topic_id: "topic-contract",
          trusted: true,
          prior_absorption_comparisons: [
            { prior_paper_id: "paper-prior", disposition: "non_overlapping" }
          ],
          reviewer_absorption_objection: "The nearest prior may already cover the mechanism.",
          kill_signal: "Reject when the paired effect misses the declared floor.",
          topic_memory_disposition: "clear",
          blocked_gate_codes: []
        }
      ],
      active_candidate_id: "candidate-contract",
      active_topic_id: "topic-contract",
      active_candidate_hash: "e".repeat(64),
      active_primary_metric: "primary_score",
      active_metric_unit: "proportion",
      active_metric_scale: "proportion",
      active_metric_direction: "maximize",
      active_effect_criterion: {
        basis: "delta_vs_reference",
        magnitude: 0.05,
        scale: "proportion",
        inclusive: true
      },
      active_meaningful_effect: "At least 0.05 over the declared comparator.",
      active_evidence_stage: "bounded_probe",
      active_deferred_candidate_ids: ["candidate-deferred"],
      authorization_probe_allowed: true,
      hashes: {
        active_topic_probe_contract: contractHash
      }
    });
    const lines = formatRunJobProjectionLines({ projection: makeJobProjection(projected) });
    expect(lines).toContain(
      "  bounded probe contract: candidate=candidate-contract stage=bounded_probe"
    );
    expect(lines).toContain(
      "  bounded probe evidence: paper_evidence_allowed=false | bounded probe only; not paper evidence"
    );
    expect(lines).toContain(
      "  metric boundary: primary_score [unit=proportion; scale=proportion] (maximize) | effect=>=0.05 proportion delta_vs_reference"
    );
    expect(lines).toContain(
      `  probe contract: design_experiments_panel/active_topic_probe_contract.json | sha256=${contractHash}`
    );

    const withoutOptionalProse = projectResearchFunnel({
      ...source,
      activeMeaningfulEffect: undefined
    });
    expect(withoutOptionalProse.active_candidate_id).toBe("candidate-contract");
    expect(withoutOptionalProse.active_effect_criterion).toEqual(source.activeEffectCriterion);
    expect(withoutOptionalProse.active_meaningful_effect).toBeUndefined();

    const reviewed = projectResearchFunnel({
      ...source,
      lifecycleStage: "reviewed",
      outcomeDisposition: "promote_to_confirmatory",
      outcomeNextAction: "start_confirmatory_run",
      outcomeGate: {
        status: "decided",
        trusted: true,
        reasonCodes: ["confirmatory_gate_satisfied"],
        contentHash: "f".repeat(64),
        artifactRef: {
          label: "Topic probe outcome gate",
          path: "analysis/topic_probe_outcome_gate.json"
        }
      },
      followupHandoff: {
        status: "ready",
        trusted: true,
        recommendedFollowupMode: "hypothesis_test",
        evidenceStage: "confirmatory",
        contentHash: "1".repeat(64),
        artifactRef: {
          label: "Topic probe follow-up handoff",
          path: "review/topic_probe_followup_handoff.json"
        }
      },
      reviewGate: {
        status: "followup_required",
        trusted: true,
        paperDraftingAllowed: false,
        reasonCodes: [],
        contentHash: "2".repeat(64),
        artifactRef: {
          label: "Topic probe review gate",
          path: "review/topic_probe_gate.json"
        }
      },
      hashes: {
        ...source.hashes,
        topicProbeOutcome: "3".repeat(64),
        topicProbeOutcomeGate: "f".repeat(64),
        topicProbeFollowupHandoff: "1".repeat(64),
        topicProbeReviewGate: "2".repeat(64)
      }
    });
    expect(reviewed).toMatchObject({
      lifecycle_stage: "reviewed",
      bounded_probe_paper_evidence_allowed: false,
      authorization_disposition: "probe_authorized",
      outcome_disposition: "promote_to_confirmatory",
      outcome_next_action: "start_confirmatory_run",
      outcome_gate: {
        status: "decided",
        trusted: true,
        content_sha256: "f".repeat(64)
      },
      followup_handoff: {
        status: "ready",
        trusted: true,
        recommended_followup_mode: "hypothesis_test",
        evidence_stage: "confirmatory"
      },
      review_gate: {
        status: "followup_required",
        trusted: true,
        paper_drafting_allowed: false
      },
      invalid_chain_blockers: [],
      hashes: {
        topic_probe_outcome: "3".repeat(64),
        topic_probe_outcome_gate: "f".repeat(64),
        topic_probe_followup_handoff: "1".repeat(64),
        topic_probe_review_gate: "2".repeat(64)
      }
    });
    const reviewedLines = formatRunJobProjectionLines({
      projection: makeJobProjection(reviewed)
    });
    expect(reviewedLines).toContain(
      "  post-probe outcome: disposition=promote_to_confirmatory next_action=start_confirmatory_run"
    );
    expect(reviewedLines).toContain(
      "  topic-probe review gate: status=followup_required trusted=yes paper_drafting_allowed=false"
    );

    const mismatched = projectResearchFunnel({
      ...source,
      integrityStatus: "mismatch",
      authorizationProbeAllowed: true,
      lifecycleStage: "invalid_chain",
      invalidChainBlockers: ["active_topic_probe_contract_content_hash_mismatch"],
      reasonCodes: ["active_topic_probe_contract_content_hash_mismatch"]
    });
    expect(mismatched.authorization_probe_allowed).toBe(false);
    expect(mismatched.active_candidate_id).toBeUndefined();
    expect(mismatched.active_primary_metric).toBeUndefined();
    expect(mismatched.hashes.active_topic_probe_contract).toBeUndefined();
    expect(
      formatRunJobProjectionLines({ projection: makeJobProjection(mismatched) })
    ).toContain(
      "  invalid-chain blockers: active_topic_probe_contract_content_hash_mismatch"
    );
    expect(
      formatRunJobProjectionLines({ projection: makeJobProjection(mismatched) })
        .some((line) => line.includes("active bounded probe:"))
    ).toBe(false);
  });


  it("derives analyze-results operator guidance from existing artifacts without creating a new workflow node", async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-analyze-operator-"));
    const run = makeRun("run-analyze", { currentNode: "analyze_results", status: "paused" });
    run.graph.currentNode = "analyze_results";
    run.graph.nodeStates.analyze_results.status = "completed";

    const runDir = path.join(workspaceRoot, ".autolabos", "runs", run.id);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify(
        {
          mean_score: 8.1,
          overview: {
            objective_status: "met",
            objective_summary: "The primary score surpassed the reference target."
          },
          failure_taxonomy: [],
          synthesis: {
            follow_up_actions: ["Enter review and confirm the claim-evidence mapping."]
          },
          transition_recommendation: {
            action: "advance",
            targetNode: "review",
            reason: "The analysis artifacts are ready for the review gate."
          }
        },
        null,
        2
      )
    );
    await fs.writeFile(
      path.join(runDir, "transition_recommendation.json"),
      JSON.stringify({ action: "advance", targetNode: "review", reason: "The analysis artifacts are ready for the review gate." }, null, 2)
    );

    const summary = await buildAnalyzeResultsOperatorSummary({
      workspaceRoot,
      run,
      approvalMode: "minimal"
    });

    expect(summary.analysis_ready).toBe(true);
    expect(summary.review_ready).toBe(false);
    expect(summary.recommended_next_action).toBe("resume_review");
    expect(summary.lines.some((line) => line.includes("Transition: advance -> review"))).toBe(true);
    expect(summary.lines).toContain("Review gate: not started yet or still missing one of the required review artifacts.");
    expect(summary.artifact_refs.map((item) => item.path)).toContain("result_analysis.json");
    expect(summary.artifact_refs.map((item) => item.path)).toContain("transition_recommendation.json");
  });

  it("renders 3-day and 7-day template helpers from the jobs snapshot", async () => {
    const lines = buildJobsTemplateLines({
      snapshot: {
        generated_at: "2026-03-28T00:00:00.000Z",
        runs: [],
        top_failures: []
      },
      window: "3d"
    });
    expect(lines[0]).toContain("3-day operator check-in template");
    expect(lines[2]).toContain("Review-adjacent runs");
  });
});

function makeJobProjection(
  researchFunnel: NonNullable<RunJobProjection["research_funnel"]>
): RunJobProjection {
  return {
    run_id: "run-projection",
    title: "Projection fixture",
    current_node: "design_experiments",
    lifecycle_status: "paused",
    approval_mode: "minimal",
    last_event_at: "2026-01-01T00:00:00.000Z",
    recommended_next_action: "waiting_for_input",
    analysis_ready: false,
    review_ready: false,
    paper_ready: false,
    research_funnel: researchFunnel
  };
}
