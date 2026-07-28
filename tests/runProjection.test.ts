import { describe, expect, it } from "vitest";

import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { AutoLabOSEvent } from "../src/core/events.js";
import type { RunRecord, RunResearchFunnelProjection } from "../src/types.js";
import {
  applyEventToRunProjection,
  mergeProjectedRunState,
  normalizeRunForDisplay,
  projectRunForDisplay,
  resolveFailedNode
} from "../src/tui/runProjection.js";

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  const graph = overrides.graph ?? createDefaultGraphState();
  const currentNode = overrides.currentNode ?? graph.currentNode;
  return {
    version: 3,
    workflowVersion: 3,
    id: overrides.id ?? "run-1",
    title: overrides.title ?? "Test run",
    topic: overrides.topic ?? "topic",
    constraints: overrides.constraints ?? [],
    objectiveMetric: overrides.objectiveMetric ?? "metric",
    status: overrides.status ?? "pending",
    currentNode,
    latestSummary: overrides.latestSummary,
    nodeThreads: overrides.nodeThreads ?? {},
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    usage: overrides.usage,
    graph,
    memoryRefs: overrides.memoryRefs ?? {
      runContextPath: ".autolabos/runs/run-1/memory/run_context.json",
      longTermPath: ".autolabos/runs/run-1/memory/long_term.jsonl",
      episodePath: ".autolabos/runs/run-1/memory/episodes.jsonl"
    }
  };
}

function makeEvent(overrides: Partial<AutoLabOSEvent>): AutoLabOSEvent {
  return {
    id: overrides.id ?? "evt-1",
    type: overrides.type ?? "NODE_STARTED",
    timestamp: overrides.timestamp ?? "2026-03-12T07:00:00.000Z",
    runId: overrides.runId ?? "run-1",
    node: overrides.node,
    agentRole: overrides.agentRole,
    payload: overrides.payload ?? {}
  };
}

describe("runProjection", () => {
  it("projects a verified active candidate as bounded-probe-only TUI state", () => {
    const contractHash = "a".repeat(64);
    const projection = projectRunForDisplay(makeRun(), {
      researchFunnel: makeResearchFunnelProjection({
        gap_evidence_audit: {
          status: "verified",
          construction_mode: "reviewed_semantic_synthesis",
          synthesis_status: "completed",
          analysis_coverage: {
            selected_paper_count: 12,
            completed_paper_count: 12,
            failed_paper_ids: [],
            complete: true
          },
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
        active_candidate_id: "candidate-contract",
        active_topic_id: "topic-contract",
        active_candidate_hash: "b".repeat(64),
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
        active_objective_raw: "{\"primary_metric\":\"primary_score\"}",
        active_meaningful_effect: "At least 0.05 over the declared comparator.",
        active_evidence_stage: "bounded_probe",
        active_deferred_candidate_ids: ["candidate-deferred"],
        topic_memory: {
          status: "verified",
          trusted: true,
          ledger_sha256: "9".repeat(64),
          record_count: 3,
          blocked_candidate_count: 2,
          reentry_required_count: 1,
          reentry_allowed_count: 1,
          audit_artifact_ref: {
            label: "Topic memory audit",
            path: "hypothesis_generation/topic_memory_audit.json"
          },
          update_artifact_ref: {
            label: "Topic memory update",
            path: "analysis/topic_memory_update.json"
          }
        },
        hashes: {
          active_topic_probe_contract: contractHash
        }
      })
    });

    expect(projection.researchFunnel).toMatchObject({
      integrityStatus: "complete",
      lifecycleStage: "probe_authorized",
      authorizationDisposition: "probe_authorized",
      authorizationProbeAllowed: true,
      activeProbe: {
        candidateId: "candidate-contract",
        candidateHash: "b".repeat(64),
        primaryMetric: "primary_score",
        metricUnit: "proportion",
        metricScale: "proportion",
        metricDirection: "maximize",
        meaningfulEffect: "At least 0.05 over the declared comparator.",
        evidenceStage: "bounded_probe",
        contractArtifactPath: "design_experiments_panel/active_topic_probe_contract.json",
        contractHash
      },
      topicMemory: {
        status: "verified",
        trusted: true,
        ledgerHash: "9".repeat(64),
        recordCount: 3,
        blockedCandidateCount: 2,
        reentryRequiredCount: 1,
        reentryAllowedCount: 1
      }
    });
    expect(projection.detail).toContain("paper_evidence_allowed=false");
    expect(projection.detail).toContain("bounded probe results are not paper evidence");
    expect(projection.detail).toContain("stage=probe_authorized");
    expect(projection.detail).toContain("candidate=candidate-contract");
    expect(projection.detail).toContain("Topic candidate #1 candidate-contract: trusted=true");
    expect(projection.detail).toContain("prior=paper-prior:non_overlapping");
    expect(projection.detail).toContain("objection=The nearest prior may absorb the mechanism");
    expect(projection.detail).toContain("kill=Reject when the paired effect misses the declared floor");
    expect(projection.detail).toContain("metric=primary_score; unit=proportion; scale=proportion; direction=maximize");
    expect(projection.detail).toContain("effect=>=0.05 proportion delta_vs_reference");
    expect(projection.detail).toContain(
      `Topic memory: status=verified; trusted=true; records=3; blocked_candidates=2; reentry_required=1; reentry_allowed=1; ledger_sha256=${"9".repeat(64)}`
    );
    expect(projection.detail).toContain("meaningful_effect=At least 0.05 over the declared comparator.");
    expect(projection.detail).toContain("stage=bounded_probe");
    expect(projection.detail).toContain("contract=design_experiments_panel/active_topic_probe_contract.json");
    expect(projection.detail).toContain(`sha256=${contractHash}`);
    expect(projection.detail).toContain(
      "Gap evidence audit: status=verified; total=8; scientific=6; grounded_scientific=5; eligible=4; accepted_clusters=2."
    );
    expect(projection.detail?.toLowerCase()).not.toContain("final topic");
  });

  it("normalizes an older research-funnel snapshot without evidence-audit fields", () => {
    const projection = projectRunForDisplay(makeRun(), {
      researchFunnel: makeResearchFunnelProjection({
        gap_evidence_audit: undefined,
        lifecycle_stage: "discovery",
        integrity_status: "unmeasured",
        authorization_trusted: false,
        authorization_probe_allowed: false
      })
    });

    expect(projection.researchFunnel?.gapEvidenceAudit).toMatchObject({
      status: "unmeasured",
      total_evidence_count: 0,
      accepted_cluster_count: 0
    });
    expect(projection.detail).toContain(
      "Gap evidence audit: status=unmeasured; total=0; scientific=0; grounded_scientific=0; eligible=0; accepted_clusters=0."
    );
  });

  it("keeps a decided post-probe outcome distinct from pre-probe authorization", () => {
    const projection = projectRunForDisplay(makeRun(), {
      researchFunnel: makeResearchFunnelProjection({
        lifecycle_stage: "outcome_decided",
        outcome_disposition: "promote_to_confirmatory",
        outcome_next_action: "start_confirmatory_run",
        outcome_gate: {
          status: "decided",
          trusted: true,
          reason_codes: [],
          content_sha256: "1".repeat(64),
          artifact_ref: {
            label: "Topic probe outcome gate",
            path: "analysis/topic_probe_outcome_gate.json"
          }
        }
      })
    });

    expect(projection.researchFunnel).toMatchObject({
      lifecycleStage: "outcome_decided",
      authorizationDisposition: "probe_authorized",
      authorizationProbeAllowed: true,
      outcomeDisposition: "promote_to_confirmatory",
      outcomeNextAction: "start_confirmatory_run"
    });
    expect(projection.detail).toContain("stage=outcome_decided");
    expect(projection.detail).toContain("pre_probe_authorization=probe_authorized");
    expect(projection.detail).toContain("outcome=promote_to_confirmatory");
    expect(projection.detail).toContain("next_action=start_confirmatory_run");
    expect(projection.detail).toContain("paper_evidence_allowed=false");
    expect(projection.detail).not.toContain("stage=probe_authorized");
  });

  it("renders a minimize effect boundary with a signed negative target", () => {
    const projection = projectRunForDisplay(makeRun(), {
      researchFunnel: makeResearchFunnelProjection({
        active_candidate_id: "candidate-minimize",
        active_topic_id: "topic-minimize",
        active_candidate_hash: "c".repeat(64),
        active_primary_metric: "primary_score",
        active_metric_unit: "unitless",
        active_metric_scale: "raw",
        active_metric_direction: "minimize",
        active_effect_criterion: {
          basis: "delta_vs_reference",
          magnitude: 2,
          scale: "raw",
          inclusive: false
        },
        active_objective_raw: "declared-objective-binding",
        active_evidence_stage: "bounded_probe",
        active_deferred_candidate_ids: [],
        hashes: { active_topic_probe_contract: "d".repeat(64) }
      })
    });

    expect(projection.detail).toContain("direction=minimize; effect=<-2 raw delta_vs_reference");
  });

  it("hides active-probe details and blocks the TUI projection on integrity mismatch", () => {
    const contractHash = "f".repeat(64);
    const projection = projectRunForDisplay(makeRun(), {
      researchFunnel: makeResearchFunnelProjection({
        lifecycle_stage: "invalid_chain",
        integrity_status: "mismatch",
        authorization_probe_allowed: true,
        reason_codes: ["active_topic_probe_contract_content_hash_mismatch"],
        invalid_chain_blockers: ["active_topic_probe_contract_content_hash_mismatch"],
        active_candidate_id: "candidate-untrusted",
        active_topic_id: "topic-untrusted",
        active_candidate_hash: "e".repeat(64),
        active_primary_metric: "primary_score",
        active_metric_unit: "proportion",
        active_metric_scale: "proportion",
        active_metric_direction: "maximize",
        active_effect_criterion: {
          basis: "delta_vs_reference",
          magnitude: 0.01,
          scale: "proportion",
          inclusive: false
        },
        active_objective_raw: "{\"primary_metric\":\"primary_score\"}",
        active_meaningful_effect: "Any observed change.",
        active_evidence_stage: "bounded_probe",
        active_deferred_candidate_ids: [],
        hashes: {
          active_topic_probe_contract: contractHash
        }
      })
    });

    expect(projection.researchFunnel).toMatchObject({
      integrityStatus: "mismatch",
      authorizationProbeAllowed: false,
      reasonCodes: ["active_topic_probe_contract_content_hash_mismatch"]
    });
    expect(projection.researchFunnel?.activeProbe).toBeUndefined();
    expect(projection.detail).toContain("Topic discovery invalid chain");
    expect(projection.detail).toContain("active_topic_probe_contract_content_hash_mismatch");
    expect(projection.detail).not.toContain("candidate-untrusted");
    expect(projection.detail).not.toContain(contractHash);
  });

  it("does not authorize an active probe from an untrusted projection", () => {
    const contractHash = "c".repeat(64);
    const projection = projectRunForDisplay(makeRun(), {
      researchFunnel: makeResearchFunnelProjection({
        lifecycle_stage: "discovery",
        authorization_trusted: false,
        authorization_probe_allowed: true,
        active_candidate_id: "candidate-diagnostic",
        active_topic_id: "topic-diagnostic",
        active_candidate_hash: "d".repeat(64),
        active_primary_metric: "primary_score",
        active_metric_unit: "proportion",
        active_metric_scale: "proportion",
        active_metric_direction: "maximize",
        active_effect_criterion: {
          basis: "delta_vs_reference",
          magnitude: 0.02,
          scale: "proportion",
          inclusive: true
        },
        active_objective_raw: "{\"primary_metric\":\"primary_score\"}",
        active_evidence_stage: "bounded_probe",
        active_deferred_candidate_ids: [],
        hashes: { active_topic_probe_contract: contractHash }
      })
    });

    expect(projection.researchFunnel).toMatchObject({
      integrityStatus: "complete",
      authorizationTrusted: false,
      authorizationProbeAllowed: false
    });
    expect(projection.researchFunnel?.activeProbe).toBeUndefined();
    expect(projection.detail).toContain("Research funnel pre-probe authorization blocked: integrity=complete");
    expect(projection.detail).not.toContain("candidate-diagnostic");
    expect(projection.detail).not.toContain(contractHash);
  });

  it("surfaces exhausted collection recovery hints without treating them as paper evidence", () => {
    const projection = projectRunForDisplay(makeRun(), {
      researchFunnel: makeResearchFunnelProjection({
        lifecycle_stage: "discovery",
        collection_state: "quality_gate_exhausted",
        collection_node_attempt: 3,
        collection_node_max_attempts: 3,
        query_plan_attempt: 2,
        collection_quality_failure_reasons: [
          "Too few relevant records satisfied the declared retrieval axis.",
          "Too few independent query families met the coverage floor."
        ],
        collection_reformulation_hint: {
          evidence_status: "query_hint_only",
          paper_evidence_allowed: false,
          active: true,
          failure_class: "query_quality_failure",
          feedback_applied: true,
          semantic_review_status: "complete",
          shared_anchor_terms: ["document", "retrieval", "evaluation"],
          candidate_titles: [
            "Confidence intervals for document retrieval evaluation",
            "Sampling-frame diagnostics for document retrieval evaluation"
          ],
          axes: [
            {
              query_family: "uncertainty_family",
              axis_terms: ["confidence", "interval"]
            },
            {
              query_family: "sampling_family",
              axis_terms: ["sampling", "frame"]
            }
          ],
          artifact_ref: {
            label: "Literature query reformulation hints",
            path: "collect_query_reformulation_hints.json"
          }
        },
        authorization_disposition: "unmeasured",
        authorization_trusted: false,
        authorization_probe_allowed: false,
        integrity_status: "unmeasured",
        reason_codes: ["collect_papers_quality_gate_exhausted"]
      })
    });

    expect(projection.researchFunnel).toMatchObject({
      collectionState: "quality_gate_exhausted",
      collectionNodeAttempt: 3,
      collectionNodeMaxAttempts: 3,
      queryPlanAttempt: 2,
      collectionReformulationHint: {
        evidence_status: "query_hint_only",
        paper_evidence_allowed: false,
        active: true,
        failure_class: "query_quality_failure",
        feedback_applied: true,
        semantic_review_status: "complete",
        candidate_titles: expect.arrayContaining([
          "Confidence intervals for document retrieval evaluation"
        ]),
        axes: expect.arrayContaining([
          expect.objectContaining({ axis_terms: ["confidence", "interval"] })
        ])
      }
    });
    expect(projection.detail).toContain("state=quality_gate_exhausted");
    expect(projection.detail).toContain("node_attempt=3/3");
    expect(projection.detail).toContain("query_plan_attempt=2");
    expect(projection.detail).toContain("evidence_status=query_hint_only");
    expect(projection.detail).toContain("paper_evidence_allowed=false");
    expect(projection.detail).toContain("failure_class=query_quality_failure");
    expect(projection.detail).toContain("Confidence intervals for document retrieval evaluation");
    expect(projection.detail).toContain("confidence interval");
  });

  it.each([
    {
      failureClass: "semantic_review_operational_failure" as const,
      semanticReviewStatus: "operational_failure" as const,
      reason: "Semantic review failed operationally: reviewer unavailable."
    },
    {
      failureClass: "semantic_review_incomplete" as const,
      semanticReviewStatus: "partial" as const,
      reason: "Semantic review was incomplete: pair coverage mismatch."
    }
  ])("distinguishes $failureClass without displaying query feedback", ({
    failureClass,
    semanticReviewStatus,
    reason
  }) => {
    const projection = projectRunForDisplay(makeRun(), {
      researchFunnel: makeResearchFunnelProjection({
        lifecycle_stage: "discovery",
        collection_state: "quality_gate_failed",
        collection_quality_failure_reasons: [reason],
        collection_reformulation_hint: {
          evidence_status: "query_hint_only",
          paper_evidence_allowed: false,
          active: false,
          failure_class: failureClass,
          feedback_applied: false,
          semantic_review_status: semanticReviewStatus,
          shared_anchor_terms: ["generic", "evaluation"],
          candidate_titles: ["Reviewer-only diagnostic title"],
          axes: [{ axis_terms: ["held", "out"] }]
        },
        authorization_disposition: "unmeasured",
        authorization_trusted: false,
        authorization_probe_allowed: false,
        integrity_status: "unmeasured",
        reason_codes: [failureClass]
      })
    });

    expect(projection.detail).toContain(`failure_class=${failureClass}`);
    expect(projection.detail).toContain(
      `semantic_review_status=${semanticReviewStatus}`
    );
    expect(projection.detail).not.toContain("Query reformulation hint");
    expect(projection.detail).not.toContain("Reviewer-only diagnostic title");
    expect(projection.detail).not.toContain("held out");
  });

  it("revokes stale probe authorization when collection has not passed", () => {
    const projection = projectRunForDisplay(makeRun(), {
      researchFunnel: makeResearchFunnelProjection({
        lifecycle_stage: "probe_authorized",
        collection_state: "quality_gate_failed",
        collection_quality_failure_reasons: ["The collection gate failed."],
        authorization_disposition: "probe_authorized",
        authorization_trusted: true,
        authorization_probe_allowed: true
      })
    });

    expect(projection.researchFunnel).toMatchObject({
      lifecycleStage: "discovery",
      collectionState: "quality_gate_failed",
      authorizationTrusted: false,
      authorizationProbeAllowed: false
    });
    expect(projection.detail).toContain("authorization_allowed=false");
    expect(projection.detail).not.toContain("stage=probe_authorized");
  });

  it("caps a stale collection attempt projection at the retry maximum", () => {
    const projection = projectRunForDisplay(makeRun(), {
      researchFunnel: makeResearchFunnelProjection({
        lifecycle_stage: "discovery",
        collection_state: "collecting",
        collection_node_attempt: 8,
        collection_node_max_attempts: 3,
        authorization_disposition: "unmeasured",
        authorization_trusted: false,
        authorization_probe_allowed: false,
        integrity_status: "unmeasured"
      })
    });

    expect(projection.researchFunnel?.collectionNodeAttempt).toBe(3);
    expect(projection.detail).toContain("node_attempt=3/3");
    expect(projection.detail).not.toContain("node_attempt=8/3");
  });

  it("preserves the latest applied backtrack reason after reload", () => {
    const run = makeRun({ currentNode: "generate_hypotheses", status: "paused" });
    run.graph.currentNode = "generate_hypotheses";
    run.graph.transitionHistory.push({
      action: "backtrack_to_hypotheses",
      sourceNode: "design_experiments",
      fromNode: "design_experiments",
      toNode: "generate_hypotheses",
      reason: "The reviewer gate found an unresolved comparison mismatch.",
      confidence: 0.92,
      autoExecutable: true,
      appliedAt: "2026-01-01T00:00:00.000Z"
    });

    const projection = projectRunForDisplay(run);

    expect(projection.detail).toContain(
      "Last applied backtrack design_experiments->generate_hypotheses: The reviewer gate found an unresolved comparison mismatch."
    );
  });

  it("preserves the latest applied backtrack from the compact index summary", () => {
    const run = makeRun({ currentNode: "generate_hypotheses", status: "paused" });
    run.graph.currentNode = "generate_hypotheses";
    run.graph.transitionHistory = [];
    run.graph.lastAppliedTransition = {
      action: "backtrack_to_hypotheses",
      sourceNode: "design_experiments",
      fromNode: "design_experiments",
      toNode: "generate_hypotheses",
      reason: "The estimator contract must be regenerated.",
      confidence: 0.99,
      autoExecutable: true,
      appliedAt: "2026-01-01T00:00:00.000Z"
    };

    const projection = projectRunForDisplay(run);

    expect(projection.detail).toContain(
      "Last applied backtrack design_experiments->generate_hypotheses: The estimator contract must be regenerated."
    );
  });

  it("prioritizes a trusted estimator block over a pre-probe authorization headline", () => {
    const projection = projectRunForDisplay(makeRun(), {
      researchFunnel: makeResearchFunnelProjection({
        estimator_feasibility: {
          status: "blocked",
          trusted: true,
          execution_authorized: false,
          estimand_type: "paired_mean_difference",
          estimator_family: "paired_mean_difference",
          independent_cluster_count: 12,
          primary_denominator: 12,
          reason_codes: ["too_few_clusters"],
          artifact_refs: []
        }
      })
    });

    expect(projection.headline).toBe(
      "Experiment execution is blocked by the estimator feasibility gate (blocked)."
    );
    expect(projection.detail).toContain(
      "Estimator feasibility: status=blocked; trusted=true; execution_authorized=false"
    );
  });

  it("keeps the final node paused when its result is awaiting approval", () => {
    const run = makeRun({
      status: "running",
      currentNode: "write_paper"
    });
    run.graph.currentNode = "write_paper";
    run.graph.nodeStates.write_paper.status = "running";

    const projected = applyEventToRunProjection(
      run,
      makeEvent({
        type: "NODE_AWAITING_APPROVAL",
        node: "write_paper",
        payload: { summary: "Draft artifacts are ready for approval." }
      })
    );

    expect(projected.status).toBe("paused");
    expect(projected.currentNode).toBe("write_paper");
    expect(projected.graph.nodeStates.write_paper.status).toBe("needs_approval");
    expect(projected.graph.nodeStates.write_paper.note).toBe(
      "Draft artifacts are ready for approval."
    );
  });

  it("projects jump and start events onto the current run immediately", () => {
    const run = makeRun({
      status: "failed",
      currentNode: "generate_hypotheses"
    });
    run.graph.currentNode = "generate_hypotheses";
    run.graph.nodeStates.generate_hypotheses.status = "failed";
    run.graph.nodeStates.generate_hypotheses.updatedAt = "2026-03-12T06:59:13.286Z";

    const jumped = applyEventToRunProjection(
      run,
      makeEvent({
        type: "NODE_JUMP",
        node: "collect_papers",
        payload: { mode: "safe", reason: "collect command" }
      })
    );
    expect(jumped.currentNode).toBe("collect_papers");
    expect(jumped.graph.currentNode).toBe("collect_papers");
    expect(jumped.status).toBe("paused");
    expect(jumped.graph.nodeStates.collect_papers.status).toBe("pending");
    jumped.graph.nodeStates.collect_papers.lastError = "stale collection failure";

    const started = applyEventToRunProjection(
      jumped,
      makeEvent({
        type: "NODE_STARTED",
        node: "collect_papers",
        timestamp: "2026-03-12T07:00:01.000Z"
      })
    );
    expect(started.currentNode).toBe("collect_papers");
    expect(started.status).toBe("running");
    expect(started.graph.nodeStates.collect_papers.status).toBe("running");
    expect(started.graph.nodeStates.collect_papers.note).toBeUndefined();
    expect(started.graph.nodeStates.collect_papers.lastError).toBeUndefined();
  });

  it("preserves a newer projected recovery state when the refreshed run index is stale", () => {
    const stale = makeRun({
      status: "failed",
      currentNode: "generate_hypotheses",
      updatedAt: "2026-03-12T06:59:13.286Z"
    });
    stale.graph.currentNode = "generate_hypotheses";
    stale.graph.checkpointSeq = 31;
    stale.graph.nodeStates.generate_hypotheses.status = "failed";
    stale.graph.nodeStates.generate_hypotheses.updatedAt = "2026-03-12T06:59:13.286Z";

    const projected = applyEventToRunProjection(
      stale,
      makeEvent({
        type: "NODE_RETRY",
        node: "collect_papers",
        timestamp: "2026-03-12T07:00:01.000Z",
        payload: { attempt: 2 }
      })
    );

    const merged = mergeProjectedRunState(stale, projected);
    expect(merged.currentNode).toBe("collect_papers");
    expect(merged.status).toBe("running");
    expect(merged.graph.nodeStates.collect_papers.status).toBe("running");
    expect(merged.graph.retryCounters.collect_papers).toBe(2);
  });

  it("normalizes stale failed snapshots to the latest running recovery node", () => {
    const run = makeRun({
      status: "failed",
      currentNode: "generate_hypotheses"
    });
    run.graph.currentNode = "generate_hypotheses";
    run.graph.nodeStates.generate_hypotheses.status = "failed";
    run.graph.nodeStates.generate_hypotheses.updatedAt = "2026-03-12T06:59:13.286Z";
    run.graph.nodeStates.analyze_papers.status = "running";
    run.graph.nodeStates.analyze_papers.updatedAt = "2026-03-12T06:59:20.000Z";

    const normalized = normalizeRunForDisplay(run);
    expect(normalized.currentNode).toBe("analyze_papers");
    expect(normalized.graph.currentNode).toBe("analyze_papers");
    expect(normalized.status).toBe("running");
  });

  it("prefers a newer checkpoint snapshot when runs.json lags behind a node transition", () => {
    const stale = makeRun({
      status: "running",
      currentNode: "design_experiments",
      updatedAt: "2026-03-12T10:11:12.151Z"
    });
    stale.graph.currentNode = "design_experiments";
    stale.graph.checkpointSeq = 15;
    stale.graph.nodeStates.design_experiments.status = "running";
    stale.graph.nodeStates.design_experiments.updatedAt = "2026-03-12T10:11:12.151Z";

    const checkpointSnapshot = makeRun({
      status: "running",
      currentNode: "implement_experiments",
      updatedAt: "2026-03-12T10:12:37.354Z"
    });
    checkpointSnapshot.graph.currentNode = "implement_experiments";
    checkpointSnapshot.graph.checkpointSeq = 17;
    checkpointSnapshot.graph.nodeStates.design_experiments.status = "completed";
    checkpointSnapshot.graph.nodeStates.design_experiments.updatedAt = "2026-03-12T10:12:30.000Z";
    checkpointSnapshot.graph.nodeStates.implement_experiments.status = "running";
    checkpointSnapshot.graph.nodeStates.implement_experiments.updatedAt = "2026-03-12T10:12:37.354Z";

    const normalized = normalizeRunForDisplay(stale, {
      checkpoint: {
        seq: 17,
        phase: "before",
        createdAt: "2026-03-12T10:12:37.354Z",
        snapshot: checkpointSnapshot
      }
    });

    expect(normalized.currentNode).toBe("implement_experiments");
    expect(normalized.graph.currentNode).toBe("implement_experiments");
    expect(normalized.status).toBe("running");
  });

  it("does not treat rollback recovery notes as upstream blockers", () => {
    const run = makeRun({
      status: "running",
      currentNode: "design_experiments"
    });
    run.graph.currentNode = "design_experiments";
    run.graph.nodeStates.design_experiments.status = "running";
    run.graph.nodeStates.design_experiments.note =
      "Auto rollback from implement_experiments after 4/3 retries (rollback 2/2).";
    run.graph.nodeStates.implement_experiments.status = "failed";
    run.graph.nodeStates.implement_experiments.updatedAt = "2026-03-12T10:22:48.582Z";
    run.graph.nodeStates.implement_experiments.lastError =
      "Local verification failed via python -m py_compile outputs/experiment/run.py (environment): [Errno 2] No such file or directory.";
    run.graph.nodeStates.analyze_papers.status = "completed";
    run.graph.nodeStates.analyze_papers.note =
      "Analyzed top 30/200 ranked papers into 119 evidence item(s); 5 full-text and 25 abstract fallback.";

    const projection = projectRunForDisplay(run, {
      analyze: {
        selectedCount: 30,
        totalCandidates: 200,
        summaryCount: 30,
        evidenceCount: 119
      }
    });

    expect(projection.actionableNode).toBe("design_experiments");
    expect(projection.blockedByUpstream).toBe(false);
    expect(projection.headline).toBe("Auto rollback from implement_experiments after 4/3 retries (rollback 2/2).");
    expect(projection.detail).toBeUndefined();
  });

  it("prefers a newer checkpoint snapshot when implement_experiments rolls back to design_experiments", () => {
    const stale = makeRun({
      status: "failed",
      currentNode: "implement_experiments",
      updatedAt: "2026-03-12T10:22:48.582Z"
    });
    stale.graph.currentNode = "implement_experiments";
    stale.graph.checkpointSeq = 17;
    stale.graph.nodeStates.design_experiments.status = "completed";
    stale.graph.nodeStates.implement_experiments.status = "failed";
    stale.graph.nodeStates.implement_experiments.updatedAt = "2026-03-12T10:22:48.582Z";
    stale.graph.nodeStates.implement_experiments.lastError =
      "Local verification failed via python -m py_compile outputs/experiment/run.py (environment): [Errno 2] No such file or directory.";

    const checkpointSnapshot = makeRun({
      status: "paused",
      currentNode: "design_experiments",
      updatedAt: "2026-03-12T10:24:11.005Z"
    });
    checkpointSnapshot.graph.currentNode = "design_experiments";
    checkpointSnapshot.graph.checkpointSeq = 19;
    checkpointSnapshot.graph.nodeStates.design_experiments.status = "needs_approval";
    checkpointSnapshot.graph.nodeStates.design_experiments.updatedAt = "2026-03-12T10:24:11.005Z";
    checkpointSnapshot.graph.nodeStates.design_experiments.note =
      "Three executable CPU-only experiment designs compare the declared candidate conditions against the reference condition.";
    checkpointSnapshot.graph.nodeStates.implement_experiments.status = "failed";
    checkpointSnapshot.graph.nodeStates.implement_experiments.updatedAt = "2026-03-12T10:22:48.582Z";
    checkpointSnapshot.graph.nodeStates.implement_experiments.lastError =
      "Local verification failed via python -m py_compile outputs/experiment/run.py (environment): [Errno 2] No such file or directory.";

    const projection = projectRunForDisplay(stale, {
      checkpoint: {
        seq: 19,
        phase: "after",
        createdAt: "2026-03-12T10:24:11.005Z",
        snapshot: checkpointSnapshot
      }
    });

    expect(projection.run.currentNode).toBe("design_experiments");
    expect(projection.run.graph.currentNode).toBe("design_experiments");
    expect(projection.run.status).toBe("paused");
    expect(projection.actionableNode).toBe("design_experiments");
    expect(projection.blockedByUpstream).toBe(false);
  });

  it("surfaces implement_experiments progress hints over a stale design summary", () => {
    const run = makeRun({
      status: "running",
      currentNode: "implement_experiments",
      latestSummary:
        'Three executable CPU-only experiment designs operationalize reproducibility. Selected "Declared candidate comparison" via best_non_blocked.'
    });
    run.graph.currentNode = "implement_experiments";
    run.graph.nodeStates.design_experiments.status = "completed";
    run.graph.nodeStates.design_experiments.updatedAt = "2026-03-13T11:39:02.991Z";
    run.graph.nodeStates.implement_experiments.status = "running";
    run.graph.nodeStates.implement_experiments.updatedAt = "2026-03-13T11:44:04.000Z";

    const projection = projectRunForDisplay(run, {
      implement: {
        stage: "verify",
        updatedAt: "2026-03-13T11:44:05.000Z",
        message:
          "Starting local verification via python outputs/experiment/run_experiment.py --metrics-path .autolabos/runs/run-1/metrics.json.",
        attempt: 1,
        maxAttempts: 3,
        progressCount: 6,
        verificationCommand:
          "python outputs/experiment/run_experiment.py --metrics-path .autolabos/runs/run-1/metrics.json"
      }
    });

    expect(projection.headline).toBe(
      "Starting local verification via python outputs/experiment/run_experiment.py --metrics-path .autolabos/runs/run-1/metrics.json."
    );
    expect(projection.detail).toBe(
      "Attempt 1/3. 6 persisted progress update(s). Verification: python outputs/experiment/run_experiment.py --metrics-path .autolabos/runs/run-1/metrics.json."
    );
  });

  it("ignores stale implement progress hints from a previous implement cycle", () => {
    const run = makeRun({
      status: "running",
      currentNode: "implement_experiments",
      latestSummary:
        'Three executable CPU-only experiment designs operationalize reproducibility. Selected "Declared candidate comparison" via best_non_blocked.'
    });
    run.graph.currentNode = "implement_experiments";
    run.graph.nodeStates.design_experiments.status = "completed";
    run.graph.nodeStates.design_experiments.updatedAt = "2026-03-19T05:35:53.000Z";
    run.graph.nodeStates.implement_experiments.status = "running";
    run.graph.nodeStates.implement_experiments.updatedAt = "2026-03-19T05:36:53.000Z";
    run.graph.nodeStates.implement_experiments.note = "Implementation task spec prepared.";

    const projection = projectRunForDisplay(run, {
      implement: {
        status: "completed",
        stage: "completed",
        updatedAt: "2026-03-19T04:43:33.742Z",
        message:
          "Reimplemented the configured evaluation bundle from the superseded protocol to the current bounded comparison plan.",
        attempt: 1,
        maxAttempts: 3,
        progressCount: 10,
        verificationCommand:
          "python -m py_compile outputs/experiment/run_experiment.py"
      }
    });

    expect(projection.headline).toBe("Implementation task spec prepared.");
    expect(projection.detail).toBeUndefined();
  });

  it("resolves the actual failed node from the latest failed state", () => {
    const run = makeRun({
      status: "failed",
      currentNode: "analyze_papers"
    });
    run.graph.nodeStates.analyze_papers.status = "running";
    run.graph.nodeStates.analyze_papers.updatedAt = "2026-03-12T07:00:30.000Z";
    run.graph.nodeStates.generate_hypotheses.status = "failed";
    run.graph.nodeStates.generate_hypotheses.updatedAt = "2026-03-12T07:00:10.000Z";

    expect(resolveFailedNode(run)).toBe("generate_hypotheses");
  });

  it("prefers the current failed downstream node over an older upstream failure", () => {
    const run = makeRun({
      status: "failed",
      currentNode: "generate_hypotheses"
    });
    run.graph.currentNode = "generate_hypotheses";
    run.graph.nodeStates.analyze_papers.status = "failed";
    run.graph.nodeStates.analyze_papers.updatedAt = "2026-03-12T07:00:30.000Z";
    run.graph.nodeStates.generate_hypotheses.status = "failed";
    run.graph.nodeStates.generate_hypotheses.updatedAt = "2026-03-12T07:00:10.000Z";
    run.graph.nodeStates.generate_hypotheses.lastError =
      "generate_hypotheses requires at least one evidence item from analyze_papers.";

    expect(resolveFailedNode(run)).toBe("generate_hypotheses");
  });

  it("normalizes a stale failed run to the latest failed node when the current node is no longer failed", () => {
    const run = makeRun({
      status: "failed",
      currentNode: "analyze_papers"
    });
    run.graph.currentNode = "analyze_papers";
    run.graph.nodeStates.analyze_papers.status = "pending";
    run.graph.nodeStates.analyze_papers.updatedAt = "2026-03-12T07:00:30.000Z";
    run.graph.nodeStates.generate_hypotheses.status = "failed";
    run.graph.nodeStates.generate_hypotheses.updatedAt = "2026-03-12T07:00:40.000Z";
    run.graph.nodeStates.generate_hypotheses.lastError =
      "generate_hypotheses requires at least one evidence item from analyze_papers.";

    expect(resolveFailedNode(run)).toBe("generate_hypotheses");

    const normalized = normalizeRunForDisplay(run);
    expect(normalized.currentNode).toBe("generate_hypotheses");
    expect(normalized.graph.currentNode).toBe("generate_hypotheses");
    expect(normalized.status).toBe("failed");
  });

  it("prefers paused analyze failure details over a stale collect summary", () => {
    const run = makeRun({
      status: "paused",
      currentNode: "analyze_papers",
      latestSummary: 'Semantic Scholar stored 200 papers for "topic". Deferred enrichment continues for 173 paper(s).'
    });
    run.graph.currentNode = "analyze_papers";
    run.graph.retryCounters.analyze_papers = 1;
    run.graph.nodeStates.collect_papers.status = "completed";
    run.graph.nodeStates.analyze_papers.status = "pending";
    run.graph.nodeStates.analyze_papers.note = "Canceled by user";
    run.graph.nodeStates.analyze_papers.lastError = "Analysis incomplete: 1 paper(s) failed validation or LLM extraction.";

    const projection = projectRunForDisplay(run, {
      collect: {
        enrichmentStatus: "completed"
      },
      analyze: {
        selectedCount: 1,
        totalCandidates: 200,
        summaryCount: 0,
        evidenceCount: 0,
        rerankApplied: false,
        rerankFallbackReason: "You've hit your usage limit for the configured research model.",
        selectedPaperLastError: "You've hit your usage limit for the configured research model."
      }
    });

    expect(projection.staleLatestSummary).toBe(true);
    expect(projection.usageLimitBlocked).toBe(true);
    expect(projection.noArtifactProgress).toBe(true);
    expect(projection.headline).toContain("paused after retry 1/3");
    expect(projection.detail).toContain("LLM rerank failed before a top-N shortlist was accepted");
  });

  it("does not carry stale analyze rerank fallback details into later completed nodes", () => {
    const run = makeRun({
      status: "paused",
      currentNode: "generate_hypotheses",
      latestSummary: "Generated a tightened hypothesis shortlist."
    });
    run.graph.currentNode = "generate_hypotheses";
    run.graph.nodeStates.analyze_papers.status = "completed";
    run.graph.nodeStates.analyze_papers.note = "Selected papers for downstream hypothesis generation.";
    run.graph.nodeStates.generate_hypotheses.status = "completed";
    run.graph.nodeStates.generate_hypotheses.note = run.latestSummary;

    const projection = projectRunForDisplay(run, {
      analyze: {
        selectedCount: 2,
        totalCandidates: 20,
        summaryCount: 2,
        evidenceCount: 8,
        rerankApplied: false,
        rerankFallbackReason: "Model rerank was unavailable during an earlier paper-selection pass."
      }
    });

    expect(projection.actionableNode).toBe("generate_hypotheses");
    expect(projection.rerankFallback).toBe(false);
    expect(projection.detail ?? "").not.toContain("LLM rerank failed before a top-N shortlist was accepted");
  });

  it("suppresses stale collect-summary detail during a same-session handoff into running analyze_papers", () => {
    const run = makeRun({
      status: "running",
      currentNode: "analyze_papers",
      latestSummary: 'Semantic Scholar stored 200 papers for "topic". Deferred enrichment scheduled in background for 171 paper(s).'
    });
    run.graph.currentNode = "analyze_papers";
    run.graph.nodeStates.collect_papers.status = "completed";
    run.graph.nodeStates.collect_papers.updatedAt = "2026-03-12T12:37:36.434Z";
    run.graph.nodeStates.collect_papers.note = run.latestSummary;
    run.graph.nodeStates.analyze_papers.status = "running";
    run.graph.nodeStates.analyze_papers.updatedAt = "2026-03-12T12:37:37.000Z";

    const projection = projectRunForDisplay(run);

    expect(projection.staleLatestSummary).toBe(true);
    expect(projection.headline).toBeUndefined();
    expect(projection.detail).toBeUndefined();
  });

  it("suppresses stale collect-summary detail when analyze-start hints are already fresher than collect", () => {
    const run = makeRun({
      status: "running",
      currentNode: "analyze_papers",
      latestSummary: 'Semantic Scholar stored 200 papers for "topic". Deferred enrichment scheduled in background for 171 paper(s).'
    });
    run.graph.currentNode = "analyze_papers";
    run.graph.nodeStates.collect_papers.status = "completed";
    run.graph.nodeStates.collect_papers.updatedAt = "2026-03-12T12:39:54.428Z";
    run.graph.nodeStates.collect_papers.note = run.latestSummary;
    run.graph.nodeStates.analyze_papers.status = "running";
    run.graph.nodeStates.analyze_papers.updatedAt = "2026-03-12T12:40:30.000Z";
    run.graph.nodeStates.analyze_papers.note =
      "analyze_papers has started. Ranking 200 candidate paper(s) to select top 30; persisted 0 summary row(s) and 0 evidence row(s).";

    const projection = projectRunForDisplay(run, {
      analyze: {
        selectedCount: 30,
        totalCandidates: 200,
        summaryCount: 0,
        evidenceCount: 0
      }
    });

    expect(projection.staleLatestSummary).toBe(true);
    expect(projection.headline).toContain("analyze_papers has started");
    expect(projection.detail).not.toContain("Ignoring stale top-level summary");
  });

  it("redirects actionable recovery to the upstream node when a downstream step lacks evidence", () => {
    const run = makeRun({
      status: "failed",
      currentNode: "generate_hypotheses"
    });
    run.graph.currentNode = "generate_hypotheses";
    run.graph.nodeStates.analyze_papers.status = "completed";
    run.graph.nodeStates.analyze_papers.lastError = "Analysis incomplete: 19 paper(s) failed validation or LLM extraction.";
    run.graph.nodeStates.generate_hypotheses.status = "failed";
    run.graph.nodeStates.generate_hypotheses.lastError =
      "generate_hypotheses requires at least one evidence item from analyze_papers.";

    const projection = projectRunForDisplay(run, {
      analyze: {
        selectedCount: 0,
        totalCandidates: 0,
        summaryCount: 0,
        evidenceCount: 0
      }
    });

    expect(projection.actionableNode).toBe("analyze_papers");
    expect(projection.blockedByUpstream).toBe(true);
    expect(projection.headline).toContain("generate_hypotheses is blocked because analyze_papers has 0 evidence item(s)");
  });

  it("surfaces aggregate run usage in projection details when available", () => {
    const run = makeRun({
      status: "paused",
      currentNode: "analyze_papers",
      usage: {
        totals: {
          toolCalls: 4,
          wallTimeMs: 12_500,
          costUsd: 1.25,
          inputTokens: 120,
          outputTokens: 35
        },
        byNode: {},
        lastUpdatedAt: "2026-03-20T05:35:53.000Z"
      }
    });
    run.graph.currentNode = "analyze_papers";

    const projection = projectRunForDisplay(run);

    expect(projection.detail).toBe("Usage: 4 tool call(s), wall 13s, $1.25, 120 in / 35 out tok.");
  });
});

function makeResearchFunnelProjection(
  overrides: Partial<RunResearchFunnelProjection> = {}
): RunResearchFunnelProjection {
  return {
    research_mode: "topic_discovery",
    lifecycle_stage: "probe_authorized",
    bounded_probe_paper_evidence_allowed: false,
    collection_state: "quality_gate_passed",
    collection_quality_failure_reasons: [],
    gap_evidence_audit: {
      status: "unmeasured",
      total_evidence_count: 0,
      scientific_evidence_count: 0,
      grounded_scientific_evidence_count: 0,
      synthesis_eligible_evidence_count: 0,
      synthesis_excluded_evidence_count: 0,
      accepted_cluster_count: 0,
      malformed_evidence_row_count: 0,
      source_scope_counts: {
        abstract: 0,
        full_text_excerpt: 0,
        full_document: 0,
        unknown: 0
      },
      grounding_status_counts: {
        grounded_span: 0,
        ungrounded_span: 0,
        fallback: 0,
        unknown: 0
      }
    },
    candidate_count: 5,
    cluster_count: 3,
    candidate_prior_search: {
      status: "unmeasured",
      trusted: false,
      completed_rounds: 0,
      max_rounds: 0,
      current_receipt_status: "unmeasured",
      candidate_count: 0,
      selected_candidate_count: 0,
      broad_lane_attempt_count: 0,
      recent_lane_attempt_count: 0,
      fetched_count: 0,
      selected_paper_count: 0,
      reason_codes: [],
      artifact_refs: []
    },
    estimator_feasibility: {
      status: "unmeasured",
      trusted: false,
      execution_authorized: false,
      reason_codes: [],
      artifact_refs: []
    },
    topic_memory: {
      status: "unmeasured",
      trusted: false,
      record_count: 0,
      blocked_candidate_count: 0,
      reentry_required_count: 0,
      reentry_allowed_count: 0
    },
    diagnostics_trusted: true,
    authorization_trusted: true,
    portfolio_candidates: [
      {
        rank: 1,
        candidate_id: "candidate-contract",
        topic_id: "topic-contract",
        statement: "Evaluate a bounded candidate under a declared comparison.",
        trusted: true,
        review_status: "kept",
        probe_status: "shortlisted",
        probe_eligible: true,
        scores: {
          novelty: 4,
          feasibility: 5,
          testability: 5,
          cost: 4,
          expected_gain: 3
        },
        closest_prior_paper_ids: ["paper-prior"],
        closest_prior_full_text_paper_ids: ["paper-prior"],
        prior_absorption_comparisons: [
          { prior_paper_id: "paper-prior", disposition: "non_overlapping" }
        ],
        prior_absorption_reason_codes: [],
        closest_prior_non_overlap: "The declared protocol remains distinct.",
        reviewer_absorption_objection: "The nearest prior may absorb the mechanism.",
        comparator: "declared reference",
        dataset_task_bench: "bounded evaluation set",
        primary_metric: "primary_score",
        local_budget: "one local execution window",
        kill_signal: "Reject when the paired effect misses the declared floor.",
        contribution_claim: "A bounded protocol-level contribution.",
        minimum_publishable_evidence: "Repeated paired comparisons with uncertainty.",
        review_summary: "Retain only after direct-prior verification.",
        topic_memory_disposition: "clear",
        topic_memory_maximum_lineage_similarity: 0.2,
        blocked_gate_codes: []
      }
    ],
    probe_candidate_count: 1,
    probe_candidate_ids: ["candidate-contract"],
    probe_candidate_statements: ["Evaluate the declared candidate under a bounded protocol."],
    authorization_disposition: "probe_authorized",
    authorization_probe_allowed: true,
    outcome_gate: {
      status: "unmeasured",
      trusted: false,
      reason_codes: []
    },
    followup_handoff: {
      status: "unmeasured",
      trusted: false
    },
    review_gate: {
      status: "unmeasured",
      trusted: false,
      paper_drafting_allowed: false,
      reason_codes: []
    },
    invalid_chain_blockers: [],
    reason_codes: [],
    gates: [],
    dissent: [],
    literature_queries: [],
    query_fallback_used: false,
    query_fallback_reasons: [],
    hashes: {},
    artifact_refs: [
      {
        label: "Active topic probe contract",
        path: "design_experiments_panel/active_topic_probe_contract.json"
      }
    ],
    integrity_status: "complete",
    ...overrides
  };
}
