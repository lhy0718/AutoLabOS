import { promises as fs } from "node:fs";
import { writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureScaffold, resolveAppPaths } from "../src/config.js";
import {
  buildActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "../src/core/activeTopicProbeContract.js";
import {
  EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH,
  assessEvidenceAdequacy,
  buildEvidenceAdequacyContract,
  buildEvidenceAdequacyExecutionReceipt,
  type EvidenceAdequacyCoverageMode
} from "../src/core/analysis/evidenceAdequacy.js";
import {
  reassessEvidenceAdequacyArtifacts,
  type EvidenceAdequacyArtifactReassessment,
  type EvidenceAdequacyAuthorization
} from "../src/core/analysis/evidenceAdequacyArtifacts.js";
import type {
  HypothesisCandidate,
  HypothesisReview
} from "../src/core/analysis/researchPlanning.js";
import { makeIndependentHypothesisReviewProvenance } from "./support/hypothesisReviewProvenance.js";
import {
  buildCandidateObjectiveProfileBinding
} from "../src/core/effectCriterion.js";
import { buildResearchGapEvidenceChain } from "../src/core/analysis/researchGapEvidenceChain.js";
import {
  RESEARCH_GAP_SYNTHESIS_PROMPT_CONTRACT_VERSION,
  RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION
} from "../src/core/analysis/researchGapSynthesis.js";
import { buildTopicProbeExecutionBinding } from "../src/core/experimentGovernance.js";
import {
  RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS,
  buildResearchFunnelArtifactBinding,
  buildResearchGapMap,
  buildTopicDecision,
  buildTopicPortfolio,
  hashCanonical,
  resolveSupportedGapIds,
  validateResearchFunnelClosedChain,
  type TopicPortfolio
} from "../src/core/researchFunnel.js";
import type { AnalysisReport } from "../src/core/resultAnalysis.js";
import {
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS,
  loadTopicProbeOutcomeArtifacts
} from "../src/core/topicProbeOutcomeArtifacts.js";
import {
  buildTopicProbeOutcomeDecision,
  validateTopicProbeOutcomeDecision,
  type TopicProbeOutcomeDecision,
  type TopicProbeOutcomeDisposition,
  type TopicProbeOutcomeNextAction
} from "../src/core/topicProbeOutcome.js";
import { buildWorkspaceRunRoot } from "../src/core/runs/runPaths.js";
import { RunStore } from "../src/core/runs/runStore.js";
import { buildPromotionParentStateSha256 } from "../src/core/runs/runPromotionStore.js";
import {
  buildTopicProbeFollowupHandoff,
  TOPIC_PROBE_FOLLOWUP_HANDOFF_RELATIVE_PATH,
  type TopicProbeFollowupEvidenceStage,
  type TopicProbeFollowupMode
} from "../src/core/topicProbeFollowup.js";
import {
  buildTopicProbeReviewGate,
  TOPIC_PROBE_REVIEW_GATE_RELATIVE_PATH
} from "../src/core/topicProbeReviewGate.js";
import {
  buildTopicProbeFollowupRunId,
  TOPIC_PROBE_FOLLOWUP_RECEIPT_RELATIVE_PATH,
  TopicProbeFollowupRunManager,
  validateTopicProbeFollowupRunReceipt
} from "../src/core/topicProbeFollowupRun.js";
import {
  TOPIC_PROBE_SUCCESSOR_LINEAGE_MANIFEST_RELATIVE_PATH,
  validateTopicProbeSuccessorLineageManifest
} from "../src/core/runs/topicProbeSuccessorLineage.js";
import { TOPIC_PROBE_OUTCOME_GATE_RELATIVE_PATH } from "../src/core/runs/researchFunnelProjection.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { CheckpointStore } from "../src/core/stateGraph/checkpointStore.js";
import {
  makeTopicProbeComputeBudgetDeclaration,
  makeTopicProbeComputeBudgetLimits
} from "./support/topicProbeComputeBudget.js";
import type { PriorAbsorptionEvidenceSeed } from "../src/core/priorAbsorption.js";
import { buildPassingPriorAbsorptionMatrixFixture } from "./support/priorAbsorptionFixture.js";
import type { RunSuccessorRelation } from "../src/types.js";
import {
  buildVenueViabilityReport,
  VENUE_VIABILITY_REPORT_RELATIVE_PATH
} from "../src/core/venueViability.js";

const GENERATED_AT = "2026-01-01T00:00:00.000Z";
const RESEARCH_CYCLE = 2;
const RUN_ID = randomUUID();
const CANDIDATE_IDS = [
  "candidate_measurement",
  "candidate_efficiency",
  "candidate_robustness",
  "candidate_transfer",
  "candidate_auditability"
] as const;
const AXIS_IDS = [
  "axis_measurement",
  "axis_resource",
  "axis_reliability"
] as const;

interface TopicProbeSuccessorRoute {
  label: string;
  disposition: TopicProbeOutcomeDisposition;
  nextAction: TopicProbeOutcomeNextAction;
  mode: TopicProbeFollowupMode;
  evidenceStage: TopicProbeFollowupEvidenceStage;
  relation: RunSuccessorRelation;
  observedDelta: number;
  executedTrials: number;
  confidenceInterval: readonly [number, number] | null;
  deferredCandidateIds: readonly string[];
}

const TOPIC_PROBE_SUCCESSOR_ROUTES = [
  {
    label: "confirmatory successor",
    disposition: "promote_to_confirmatory",
    nextAction: "start_confirmatory_run",
    mode: "hypothesis_test",
    evidenceStage: "confirmatory",
    relation: "topic_probe_confirmatory",
    observedDelta: 0.06,
    executedTrials: 2,
    confidenceInterval: [0.05, 0.07],
    deferredCandidateIds: []
  },
  {
    label: "bounded repeat successor",
    disposition: "repeat_probe",
    nextAction: "repeat_bounded_probe",
    mode: "topic_discovery",
    evidenceStage: "bounded_probe",
    relation: "topic_probe_repeat",
    observedDelta: 0.06,
    executedTrials: 1,
    confidenceInterval: null,
    deferredCandidateIds: []
  },
  {
    label: "deferred candidate successor",
    disposition: "reject_candidate",
    nextAction: "try_deferred_candidate",
    mode: "topic_discovery",
    evidenceStage: "bounded_probe",
    relation: "topic_probe_deferred_candidate",
    observedDelta: 0.02,
    executedTrials: 2,
    confidenceInterval: [0.01, 0.03],
    deferredCandidateIds: [CANDIDATE_IDS[1]]
  },
  {
    label: "portfolio refresh successor",
    disposition: "reject_candidate",
    nextAction: "refresh_topic_portfolio",
    mode: "topic_discovery",
    evidenceStage: "topic_refresh",
    relation: "topic_probe_portfolio_refresh",
    observedDelta: 0.02,
    executedTrials: 2,
    confidenceInterval: [0.01, 0.03],
    deferredCandidateIds: []
  },
  {
    label: "evidence repair successor",
    disposition: "blocked_invalid_evidence",
    nextAction: "repair_probe_evidence",
    mode: "topic_discovery",
    evidenceStage: "bounded_probe",
    relation: "topic_probe_evidence_repair",
    observedDelta: 0.06,
    executedTrials: 0,
    confidenceInterval: null,
    deferredCandidateIds: []
  }
] as const satisfies readonly TopicProbeSuccessorRoute[];

const workspaceRoots: string[] = [];
const ORIGINAL_CWD = process.cwd();

afterEach(async () => {
  process.chdir(ORIGINAL_CWD);
  await Promise.all(
    workspaceRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

describe("topicProbeOutcomeArtifacts", () => {
  it("loads one valid closed topic-probe context with a report-bound outcome", async () => {
    const fixture = await createWorkspaceFixture();

    const validation = await loadTopicProbeOutcomeArtifacts({
      workspaceRoot: fixture.workspaceRoot,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      requireOutcome: true,
      report: fixture.report
    });

    expect(validation).toMatchObject({
      measured: true,
      valid: true,
      reasons: [],
      portfolio: {
        content_sha256: fixture.portfolio.content_sha256
      },
      topicDecision: {
        content_sha256: fixture.topicDecision.content_sha256
      },
      contract: {
        content_sha256: fixture.contract.content_sha256
      },
      decision: {
        content_sha256: fixture.outcome.content_sha256
      }
    });
  });

  it("blocks deterministic exhaustive promotion until an independent replay verifier exists", async () => {
    const fixture = await createWorkspaceFixture({ includeOutcome: false });
    const governed = buildProbeEvidenceAssessment(fixture.report, {
      mode: "deterministic_exhaustive",
      observedUnitCount: 2,
      includeDeterministicOracle: true
    });
    const report: AnalysisReport = {
      ...fixture.report,
      analysis_version: 1,
      statistical_summary: {
        ...fixture.report.statistical_summary,
        executed_trials: 1,
        confidence_intervals: []
      },
      evidence_adequacy_assessment: governed.assessment
    };
    const reassessment = await persistProbeEvidenceAndReassess(
      fixture.workspaceRoot,
      report,
      governed
    );

    expect(governed.assessment.passed).toBe(true);
    expect(reassessment.authorization).toBeDefined();

    const decision = buildTopicProbeOutcomeDecision({
      contract: fixture.contract,
      report,
      evidenceAdequacyAuthorization: reassessment.authorization
    });

    expect(decision).toMatchObject({
      disposition: "blocked_invalid_evidence",
      evidence_adequacy_status: "pass",
      evidence_adequacy_contract_sha256: governed.contract.content_sha256,
      evidence_adequacy_assessment_sha256: governed.assessment.content_sha256,
      executed_trials: 1,
      primary_metric_ci_present: false,
      reason_codes: ["deterministic_exhaustive_verifier_missing"],
      next_action: "repair_probe_evidence"
    });
    expect(decision.evidence_refs).toContain(
      "result_analysis.json#/evidence_adequacy_assessment"
    );
    expect(validateTopicProbeOutcomeDecision(JSON.stringify(decision), {
      contract: fixture.contract,
      report,
      evidenceAdequacyAuthorization: reassessment.authorization
    })).toMatchObject({ measured: true, valid: true, reasons: [] });
  });

  it("blocks sampled evidence that misses its frozen independent-unit coverage despite two trials and a CI", async () => {
    const fixture = await createWorkspaceFixture({ includeOutcome: false });
    const governed = buildProbeEvidenceAssessment(fixture.report, {
      mode: "sampled",
      observedUnitCount: 1,
      includeDeterministicOracle: false
    });
    const report: AnalysisReport = {
      ...fixture.report,
      analysis_version: 1,
      evidence_adequacy_assessment: governed.assessment
    };
    const reassessment = await persistProbeEvidenceAndReassess(
      fixture.workspaceRoot,
      report,
      governed
    );

    const decision = buildTopicProbeOutcomeDecision({
      contract: fixture.contract,
      report,
      evidenceAdequacyAuthorization: reassessment.authorization
    });

    expect(governed.assessment.passed).toBe(false);
    expect(reassessment.authorization).toBeUndefined();
    expect(decision).toMatchObject({
      disposition: "blocked_invalid_evidence",
      evidence_adequacy_status: "missing",
      reason_codes: ["evidence_adequacy_authorization_missing"],
      next_action: "repair_probe_evidence"
    });
  });

  it("fails closed when a current analysis report omits its frozen evidence assessment", async () => {
    const fixture = await createWorkspaceFixture({ includeOutcome: false });
    const {
      evidence_adequacy_assessment: _assessment,
      ...reportWithoutAssessment
    } = fixture.report;
    const report = reportWithoutAssessment as AnalysisReport;

    const decision = buildTopicProbeOutcomeDecision({
      contract: fixture.contract,
      report,
      evidenceAdequacyAuthorization: fixture.evidenceAdequacyAuthorization
    });

    expect(decision).toMatchObject({
      disposition: "blocked_invalid_evidence",
      evidence_adequacy_status: "missing",
      reason_codes: ["evidence_adequacy_assessment_missing"],
      next_action: "repair_probe_evidence"
    });
  });

  it("blocks deterministic exhaustive evidence when contract-required oracle evidence is absent", async () => {
    const fixture = await createWorkspaceFixture({ includeOutcome: false });
    const governed = buildProbeEvidenceAssessment(fixture.report, {
      mode: "deterministic_exhaustive",
      observedUnitCount: 2,
      includeDeterministicOracle: false
    });
    const report: AnalysisReport = {
      ...fixture.report,
      analysis_version: 1,
      statistical_summary: {
        ...fixture.report.statistical_summary,
        executed_trials: 1,
        confidence_intervals: []
      },
      evidence_adequacy_assessment: governed.assessment
    };
    const reassessment = await persistProbeEvidenceAndReassess(
      fixture.workspaceRoot,
      report,
      governed
    );

    const decision = buildTopicProbeOutcomeDecision({
      contract: fixture.contract,
      report,
      evidenceAdequacyAuthorization: reassessment.authorization
    });

    expect(governed.assessment.passed).toBe(false);
    expect(reassessment.authorization).toBeUndefined();
    expect(decision).toMatchObject({
      disposition: "blocked_invalid_evidence",
      evidence_adequacy_status: "missing",
      reason_codes: ["evidence_adequacy_authorization_missing"]
    });
  });

  it.each([
    { label: "missing", analysisVersion: undefined },
    { label: "unknown", analysisVersion: 2 }
  ])("fails closed for a $label analysis_version", async ({ analysisVersion }) => {
    const fixture = await createWorkspaceFixture({ includeOutcome: false });
    const reportRecord = { ...fixture.report } as Record<string, unknown>;
    if (analysisVersion === undefined) {
      delete reportRecord.analysis_version;
    } else {
      reportRecord.analysis_version = analysisVersion;
    }
    const report = reportRecord as unknown as AnalysisReport;
    const outcome = buildTopicProbeOutcomeDecision({
      contract: fixture.contract,
      report,
      evidenceAdequacyAuthorization: fixture.evidenceAdequacyAuthorization
    });
    await writeArtifact(
      fixture.workspaceRoot,
      TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.outcome,
      JSON.stringify(outcome, null, 2)
    );

    const validation = await loadTopicProbeOutcomeArtifacts({
      workspaceRoot: fixture.workspaceRoot,
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      requireOutcome: true,
      report
    });

    expect(validation.valid, validation.reasons.join(", ")).toBe(true);
    expect(validation.decision).toMatchObject({
      disposition: "blocked_invalid_evidence",
      reason_codes: ["analysis_report_version_invalid"],
      next_action: "repair_probe_evidence"
    });
  });

  it.each([
    { label: "empty evidence artifact", metricsRaw: "" },
    {
      label: "missing primary JSON fragment",
      metricsRaw: JSON.stringify({ unrelated: true }, null, 2)
    }
  ])("fails closed for an $label", async ({ metricsRaw }) => {
    const fixture = await createWorkspaceFixture();
    await writeArtifact(fixture.workspaceRoot, "metrics.json", metricsRaw);

    const validation = await loadFixture(fixture);

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(
      "topic_probe_outcome_evidence_authorization_failed"
    );
  });

  it("fails closed when the required outcome is missing", async () => {
    const fixture = await createWorkspaceFixture({ includeOutcome: false });

    const validation = await loadTopicProbeOutcomeArtifacts({
      workspaceRoot: fixture.workspaceRoot,
      runId: RUN_ID,
      expectedResearchCycle: RESEARCH_CYCLE,
      requireOutcome: true,
      analysisReport: fixture.report
    });

    expect(validation.measured).toBe(true);
    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain("topic_probe_outcome_decision_missing");
    expect(validation.decision).toBeUndefined();
  });

  it("rejects source-artifact byte tampering across the full funnel chain", async () => {
    const fixture = await createWorkspaceFixture();
    const hypothesesPath = artifactPath(
      fixture.workspaceRoot,
      TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.hypotheses
    );
    await fs.appendFile(hypothesesPath, "\n", "utf8");

    const validation = await loadFixture(fixture);

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(
      "topic_portfolio_source_binding_hash_mismatch:hypotheses.jsonl"
    );
  });

  it("rejects evidence-store tampering even when downstream funnel artifacts are unchanged", async () => {
    const fixture = await createWorkspaceFixture();
    const evidencePath = artifactPath(
      fixture.workspaceRoot,
      TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.evidenceStore
    );
    await fs.appendFile(evidencePath, "\n", "utf8");

    const validation = await loadFixture(fixture);

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toEqual(expect.arrayContaining([
      "research_gap_synthesis_missing_or_invalid",
      "research_gap_map_evidence_hash_mismatch"
    ]));
  });

  it("rejects a rehashed active-contract field that diverges from the portfolio", async () => {
    const fixture = await createWorkspaceFixture();
    const { content_sha256: _oldHash, ...payload } = {
      ...fixture.contract,
      statement: "A substituted statement outside the authorized portfolio."
    };
    const tampered = {
      ...payload,
      content_sha256: hashCanonical(payload)
    };
    await writeArtifact(
      fixture.workspaceRoot,
      TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.activeContract,
      JSON.stringify(tampered, null, 2)
    );

    const validation = await loadFixture(fixture);

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(
      "active_topic_probe_contract_candidate_field_mismatch:statement"
    );
  });

  it("detects unhashed and report-bound outcome tampering", async () => {
    const fixture = await createWorkspaceFixture();
    const unhashedTamper = {
      ...fixture.outcome,
      executed_trials: fixture.outcome.executed_trials + 1
    };
    await writeArtifact(
      fixture.workspaceRoot,
      TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.outcome,
      JSON.stringify(unhashedTamper, null, 2)
    );

    const unhashedValidation = await loadFixture(fixture);

    expect(unhashedValidation.valid).toBe(false);
    expect(unhashedValidation.reasons).toEqual(expect.arrayContaining([
      "topic_probe_outcome_decision_content_hash_mismatch",
      "topic_probe_outcome_decision_report_binding_mismatch:executed_trials"
    ]));

    const {
      content_sha256: _outcomeHash,
      ...rehashedPayload
    } = {
      ...fixture.outcome,
      disposition: "repeat_probe" as const,
      reason_codes: ["primary_metric_confidence_interval_missing"] as const,
      next_action: "repeat_bounded_probe" as const
    };
    const rehashedTamper = {
      ...rehashedPayload,
      content_sha256: hashCanonical(rehashedPayload)
    };
    await writeArtifact(
      fixture.workspaceRoot,
      TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.outcome,
      JSON.stringify(rehashedTamper, null, 2)
    );

    const rehashedValidation = await loadFixture(fixture);

    expect(rehashedValidation.valid).toBe(false);
    expect(rehashedValidation.reasons).not.toContain(
      "topic_probe_outcome_decision_content_hash_mismatch"
    );
    expect(rehashedValidation.reasons).toEqual(expect.arrayContaining([
      "topic_probe_outcome_decision_report_binding_mismatch:disposition",
      "topic_probe_outcome_decision_report_binding_mismatch:reason_codes",
      "topic_probe_outcome_decision_report_binding_mismatch:next_action"
    ]));
  });

  it("returns deterministic read-error reasons for non-ENOENT failures", async () => {
    const fixture = await createWorkspaceFixture();
    const gapMapPath = artifactPath(
      fixture.workspaceRoot,
      TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.gapMap
    );
    await fs.rm(gapMapPath);
    await fs.mkdir(gapMapPath);

    const validation = await loadFixture(fixture);

    expect(validation.measured).toBe(true);
    expect(validation.valid).toBe(false);
    expect(validation.reasons).toEqual(expect.arrayContaining([
      "research_gap_map_missing",
      "topic_probe_artifact_read_error:analysis/gap_map.json:eisdir"
    ]));
  });

  it("never throws for malformed artifacts and deduplicates reasons", async () => {
    const fixture = await createWorkspaceFixture();
    await writeArtifact(
      fixture.workspaceRoot,
      TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.activeContract,
      "{ malformed"
    );

    const validation = await loadFixture(fixture);

    expect(validation.valid).toBe(false);
    expect(validation.reasons).toContain(
      "active_topic_probe_contract_invalid_json"
    );
    expect(new Set(validation.reasons).size).toBe(validation.reasons.length);
  });

  it.each(TOPIC_PROBE_SUCCESSOR_ROUTES)(
    "creates a deterministic $label with hash-bound receipt and lineage",
    async (route) => {
      const fixture = await createWorkspaceFixture({ route });
      const { store, parent, handoff, outcomeGate, venueViability, gate } =
        await prepareDelegatingParent(fixture);

      expect(fixture.outcome).toMatchObject({
        disposition: route.disposition,
        next_action: route.nextAction
      });
      expect(parent.graph.pendingTransition).toMatchObject({
        action: "delegate_successor",
        sourceNode: "review",
        autoExecutable: true
      });
      expect(parent.graph.pendingTransition).not.toHaveProperty("targetNode");

      const manager = new TopicProbeFollowupRunManager(
        store,
        fixture.workspaceRoot
      );
      const first = await manager.consumePromotedFollowup(parent);
      expect(first.status, first.reasons.join(", ")).toBe("created");

      const child = first.childRun!;
      const receipt = first.receipt!;
      const expectedChildRunId = buildTopicProbeFollowupRunId(
        parent.id,
        RESEARCH_CYCLE,
        route.relation,
        fixture.outcome.content_sha256
      );
      const childRoot = buildWorkspaceRunRoot(fixture.workspaceRoot, child.id);
      const receiptPath = artifactPath(
        fixture.workspaceRoot,
        TOPIC_PROBE_FOLLOWUP_RECEIPT_RELATIVE_PATH
      );
      const lineagePath = path.join(
        childRoot,
        TOPIC_PROBE_SUCCESSOR_LINEAGE_MANIFEST_RELATIVE_PATH
      );
      const firstReceiptRaw = await fs.readFile(receiptPath, "utf8");
      const firstLineageRaw = await fs.readFile(lineagePath, "utf8");

      const second = await manager.consumePromotedFollowup(parent);
      expect(second.status, second.reasons.join(", ")).toBe("reused");
      expect(second.childRun?.id).toBe(expectedChildRunId);
      expect(second.receipt).toEqual(receipt);
      expect(await fs.readFile(receiptPath, "utf8")).toBe(firstReceiptRaw);
      expect(await fs.readFile(lineagePath, "utf8")).toBe(firstLineageRaw);
      expect(await store.listRuns()).toHaveLength(2);

      expect(receipt).toMatchObject({
        schema_version: 7,
        artifact_kind: "topic_probe_followup_run_receipt",
        relation: route.relation,
        disposition: route.disposition,
        next_action: route.nextAction,
        parent_run_id: parent.id,
        parent_research_cycle: RESEARCH_CYCLE,
        child_run_id: expectedChildRunId,
        contract_content_sha256: fixture.contract.content_sha256,
        source_candidate_content_sha256:
          fixture.contract.candidate_content_sha256,
        outcome_content_sha256: fixture.outcome.content_sha256,
        outcome_gate_content_sha256: outcomeGate.content_sha256,
        venue_viability_content_sha256: venueViability.content_sha256,
        handoff_content_sha256: handoff.content_sha256,
        review_gate_content_sha256: gate.content_sha256,
        source_portfolio_content_sha256: fixture.portfolio.content_sha256,
        route_target_content_sha256: handoff.route_target.content_sha256,
        recommended_followup_mode: route.mode,
        evidence_stage: route.evidenceStage,
        execution_role: "delegated_once",
        bounded_probe_paper_evidence_allowed: false
      });
      expect(JSON.parse(firstReceiptRaw)).toEqual(receipt);

      const alternateRelation: RunSuccessorRelation =
        route.relation === "topic_probe_confirmatory"
          ? "topic_probe_repeat"
          : "topic_probe_confirmatory";
      const { content_sha256: _receiptHash, ...receiptPayload } = receipt;
      const changedReceiptPayload = {
        ...receiptPayload,
        relation: alternateRelation
      };
      const changedReceipt = {
        ...changedReceiptPayload,
        content_sha256: hashCanonical(changedReceiptPayload)
      };
      const receiptTamperValidation = validateTopicProbeFollowupRunReceipt(
        JSON.stringify(changedReceipt),
        receipt
      );
      expect(receiptTamperValidation.valid).toBe(false);
      expect(receiptTamperValidation.reasons).not.toContain(
        "topic_probe_followup_receipt_content_hash_mismatch"
      );
      expect(receiptTamperValidation.reasons).toEqual([
        "topic_probe_followup_receipt_schema_invalid"
      ]);

      expect(child.id).toBe(expectedChildRunId);
      expect(child).toMatchObject({
        executionRole: "delegated_once",
        promotionLineage: {
          relation: route.relation,
          parentRunId: parent.id,
          parentResearchCycle: RESEARCH_CYCLE,
          outcomeContentSha256: fixture.outcome.content_sha256,
          receiptContentSha256: receipt.content_sha256
        }
      });
      expect((await store.getRun(parent.id))?.delegatedSuccessor).toMatchObject({
        state: "delegated",
        relation: route.relation,
        childRunId: child.id,
        outcomeContentSha256: fixture.outcome.content_sha256,
        receiptContentSha256: receipt.content_sha256
      });

      const lineageValidation = validateTopicProbeSuccessorLineageManifest(
        firstLineageRaw
      );
      expect(lineageValidation).toMatchObject({ valid: true, reasons: [] });
      const lineage = lineageValidation.manifest!;
      expect(lineage).toMatchObject({
        schema_version: 5,
        artifact_kind: "topic_probe_successor_lineage_manifest",
        relation: route.relation,
        disposition: route.disposition,
        next_action: route.nextAction,
        recommended_followup_mode: route.mode,
        evidence_stage: route.evidenceStage,
        parent_run_id: parent.id,
        parent_research_cycle: RESEARCH_CYCLE,
        child_run_id: child.id
      });
      const { content_sha256: _lineageHash, ...lineagePayload } = lineage;
      const changedLineagePayload = {
        ...lineagePayload,
        relation: alternateRelation
      };
      const changedLineage = {
        ...changedLineagePayload,
        content_sha256: hashCanonical(changedLineagePayload)
      };
      const lineageTamperValidation =
        validateTopicProbeSuccessorLineageManifest(
          JSON.stringify(changedLineage)
        );
      expect(lineageTamperValidation.valid).toBe(false);
      expect(lineageTamperValidation.reasons).not.toContain(
        "topic_probe_successor_lineage_manifest_content_hash_mismatch"
      );
      expect(lineageTamperValidation.reasons).toContain(
        "topic_probe_successor_lineage_relation_mismatch"
      );
      expect(receipt.lineage_manifest_content_sha256).toBe(
        lineage.content_sha256
      );
      expect(receipt.lineage_manifest_file_sha256).toBe(
        sha256(firstLineageRaw)
      );
      for (const binding of [
        lineage.source_brief,
        lineage.active_contract,
        lineage.source_candidate,
        lineage.source_portfolio,
        lineage.handoff,
        lineage.bounded_outcome,
        lineage.outcome_gate,
        lineage.venue_viability,
        lineage.review_gate
      ]) {
        const raw = await fs.readFile(
          path.join(childRoot, binding.relative_path),
          "utf8"
        );
        expect(sha256(raw)).toBe(binding.file_sha256);
      }

      expect(handoff.research_brief_markdown.toLowerCase()).toContain(
        "bounded probe alone must not be used as evidence for paper claims"
      );
      expect(handoff.research_brief_markdown).toContain(
        "blocked_for_paper_scale"
      );
      expect(gate.paper_drafting_allowed).toBe(false);
      const memory = new RunContextMemory(
        path.join(fixture.workspaceRoot, child.memoryRefs.runContextPath)
      );
      expect(await memory.get("topic_probe_followup.lineage")).toMatchObject({
        relation: route.relation,
        disposition: route.disposition,
        next_action: route.nextAction,
        recommended_followup_mode: route.mode,
        evidence_stage: route.evidenceStage,
        execution_role: "delegated_once",
        bounded_probe_paper_evidence_allowed: false
      });
    }
  );

  it("recovers the reserved child after a crash and creates no orphan while the handoff is invalid", async () => {
    const fixture = await createWorkspaceFixture();
    const { store, parent, handoff } =
      await prepareDelegatingParent(fixture);
    let injected = false;
    const crashingManager = new TopicProbeFollowupRunManager(store, {
      workspaceRoot: fixture.workspaceRoot,
      ownerId: "crashing-worker",
      faultInjector(point) {
        if (!injected && point === "after_reserve") {
          injected = true;
          throw new Error("injected_after_reserve");
        }
      }
    });

    const crashed = await crashingManager.consumePromotedFollowup(parent);

    expect(crashed).toMatchObject({
      status: "blocked",
      reasons: ["injected_after_reserve"]
    });
    expect(await store.listRuns()).toHaveLength(1);
    const reservation = store.getPromotionStore().getByParentCycle(
      parent.id,
      RESEARCH_CYCLE,
      "topic_probe_confirmatory"
    );
    expect(reservation).toBeDefined();

    await writeArtifact(
      fixture.workspaceRoot,
      TOPIC_PROBE_FOLLOWUP_HANDOFF_RELATIVE_PATH,
      JSON.stringify({ ...handoff, research_brief_markdown: "tampered" })
    );
    const blocked = await new TopicProbeFollowupRunManager(store, {
      workspaceRoot: fixture.workspaceRoot,
      ownerId: "blocked-worker"
    }).consumePromotedFollowup(parent);

    expect(blocked.status).toBe("blocked");
    expect(await store.listRuns()).toHaveLength(1);

    await writeArtifact(
      fixture.workspaceRoot,
      TOPIC_PROBE_FOLLOWUP_HANDOFF_RELATIVE_PATH,
      JSON.stringify(handoff)
    );
    const recovered = await new TopicProbeFollowupRunManager(store, {
      workspaceRoot: fixture.workspaceRoot,
      ownerId: "recovery-worker"
    }).consumePromotedFollowup(parent);

    expect(recovered.status, recovered.reasons.join(", ")).toBe("created");
    expect(recovered.childRun?.id).toBe(reservation?.childRunId);
    expect(await store.listRuns()).toHaveLength(2);
  });

  it("blocks before reserving or creating a child when the outcome gate is missing", async () => {
    const fixture = await createWorkspaceFixture();
    const { store, parent } = await prepareDelegatingParent(fixture);
    await fs.rm(
      artifactPath(
        fixture.workspaceRoot,
        TOPIC_PROBE_OUTCOME_GATE_RELATIVE_PATH
      )
    );

    const result = await new TopicProbeFollowupRunManager(store, {
      workspaceRoot: fixture.workspaceRoot
    }).consumePromotedFollowup(parent);

    expect(result.status).toBe("blocked");
    expect(result.reasons).toContain("topic_probe_followup_outcome_gate_missing");
    expect(await store.listRuns()).toHaveLength(1);
    expect(store.getPromotionStore().getByParentRunId(parent.id)).toBeUndefined();
  });

  it("blocks before reserving or creating a child when the venue report is missing", async () => {
    const fixture = await createWorkspaceFixture();
    const { store, parent } = await prepareDelegatingParent(fixture);
    await fs.rm(
      artifactPath(
        fixture.workspaceRoot,
        VENUE_VIABILITY_REPORT_RELATIVE_PATH
      )
    );

    const result = await new TopicProbeFollowupRunManager(store, {
      workspaceRoot: fixture.workspaceRoot
    }).consumePromotedFollowup(parent);

    expect(result.status).toBe("blocked");
    expect(result.reasons).toContain(
      "topic_probe_followup_venue_viability_missing"
    );
    expect(await store.listRuns()).toHaveLength(1);
    expect(store.getPromotionStore().getByParentRunId(parent.id)).toBeUndefined();
  });

  it("blocks before reserving or creating a child when the outcome gate is rehashed with a different disposition", async () => {
    const fixture = await createWorkspaceFixture();
    const { store, parent, outcomeGate } = await prepareDelegatingParent(fixture);
    const changedPayload = {
      ...outcomeGate,
      disposition: outcomeGate.disposition === "repeat_probe"
        ? "reject_candidate"
        : "repeat_probe",
      content_sha256: undefined
    };
    delete changedPayload.content_sha256;
    const changedGate = {
      ...changedPayload,
      content_sha256: hashCanonical(changedPayload)
    };
    await writeArtifact(
      fixture.workspaceRoot,
      TOPIC_PROBE_OUTCOME_GATE_RELATIVE_PATH,
      `${JSON.stringify(changedGate, null, 2)}\n`
    );

    const result = await new TopicProbeFollowupRunManager(store, {
      workspaceRoot: fixture.workspaceRoot
    }).consumePromotedFollowup(parent);

    expect(result.status).toBe("blocked");
    expect(result.reasons).toContain("topic_probe_outcome_gate_disposition_mismatch");
    expect(await store.listRuns()).toHaveLength(1);
    expect(store.getPromotionStore().getByParentRunId(parent.id)).toBeUndefined();
  });

  it("fails the claimed lease when the outcome gate changes after claim but before execution handoff", async () => {
    const fixture = await createWorkspaceFixture();
    const { store, parent, outcomeGate } = await prepareDelegatingParent(fixture);
    let mutated = false;
    const manager = new TopicProbeFollowupRunManager(store, {
      workspaceRoot: fixture.workspaceRoot,
      faultInjector(point) {
        if (mutated || point !== "after_claim_before_revalidation") return;
        mutated = true;
        const changedPayload = {
          ...outcomeGate,
          disposition: outcomeGate.disposition === "repeat_probe"
            ? "reject_candidate"
            : "repeat_probe"
        } as Record<string, unknown>;
        delete changedPayload.content_sha256;
        writeFileSync(
          artifactPath(
            fixture.workspaceRoot,
            TOPIC_PROBE_OUTCOME_GATE_RELATIVE_PATH
          ),
          `${JSON.stringify({
            ...changedPayload,
            content_sha256: hashCanonical(changedPayload)
          }, null, 2)}\n`,
          "utf8"
        );
      }
    });

    const result = await manager.consumePromotedFollowup(parent);

    expect(result.status).toBe("blocked");
    expect(result.reasons[0]).toContain(
      "topic_probe_followup_postclaim_source_invalid"
    );
    expect(result.terminalState?.status).toBe("failed");
    expect(result.executionLease).toBeUndefined();
    expect(result.childRun?.status).toBe("failed");
    const persistedChild = result.childRun
      ? await store.getRun(result.childRun.id)
      : undefined;
    expect(persistedChild?.status).toBe("failed");
    expect(
      store.getPromotionStore().getExecutionState(result.childRun?.id || "")?.status
    ).toBe("failed");
  });

  it("reports an explicit new-cycle boundary for a pre-contract-upgrade reservation", async () => {
    const fixture = await createWorkspaceFixture();
    const { store, parent } = await prepareDelegatingParent(fixture);
    const childRunId = buildTopicProbeFollowupRunId(
      parent.id,
      RESEARCH_CYCLE,
      "topic_probe_confirmatory",
      fixture.outcome.content_sha256
    );
    store.getPromotionStore().reserveOrLoad({
      parentRunId: parent.id,
      parentResearchCycle: RESEARCH_CYCLE,
      relation: "topic_probe_confirmatory",
      outcomeContentSha256: fixture.outcome.content_sha256,
      childRunId,
      receiptContentSha256: "a".repeat(64),
      receiptJson: JSON.stringify({ schema_version: 5 }),
      immutablePayloadJson: JSON.stringify({
        schema_version: 3,
        artifact_kind: "topic_probe_followup_promotion_payload"
      }),
      expectedParentStateSha256: buildPromotionParentStateSha256(parent),
      expectedCheckpointSeq: parent.graph.checkpointSeq
    });
    await fs.unlink(artifactPath(
      fixture.workspaceRoot,
      VENUE_VIABILITY_REPORT_RELATIVE_PATH
    ));

    const result = await new TopicProbeFollowupRunManager(store, {
      workspaceRoot: fixture.workspaceRoot
    }).consumePromotedFollowup(parent);

    expect(result).toEqual({
      status: "blocked",
      reasons: [
        "topic_probe_followup_pre_contract_upgrade_reservation_requires_new_research_cycle"
      ]
    });
    expect(await store.listRuns()).toHaveLength(1);
  });

  it("re-reads the latest checkpoint instead of trusting a stale parent object", async () => {
    const fixture = await createWorkspaceFixture();
    const { store, parent, paths } =
      await prepareDelegatingParent(fixture);
    const newer = structuredClone(parent);
    newer.currentNode = "write_paper";
    newer.graph.currentNode = "write_paper";
    newer.graph.pendingTransition = undefined;
    await new CheckpointStore(paths).save(
      newer,
      "before",
      "newer checkpoint supersedes the stale review object"
    );

    const result = await new TopicProbeFollowupRunManager(store, {
      workspaceRoot: fixture.workspaceRoot
    }).consumePromotedFollowup(parent);

    expect(result).toEqual({
      status: "blocked",
      reasons: ["topic_probe_followup_parent_delegation_not_authorized"]
    });
    expect(await store.listRuns()).toHaveLength(1);
    expect(store.getPromotionStore().getByParentRunId(parent.id)).toBeUndefined();
  });
});

interface WorkspaceFixture {
  workspaceRoot: string;
  portfolio: TopicPortfolio;
  topicDecision: ReturnType<typeof buildTopicDecision>;
  contract: ActiveTopicProbeContract;
  evidenceAdequacyAuthorization: EvidenceAdequacyAuthorization;
  outcome: TopicProbeOutcomeDecision;
  report: AnalysisReport;
}

async function prepareDelegatingParent(fixture: WorkspaceFixture): Promise<{
  store: RunStore;
  parent: Awaited<ReturnType<RunStore["createRun"]>>;
  paths: ReturnType<typeof resolveAppPaths>;
  handoff: ReturnType<typeof buildTopicProbeFollowupHandoff>;
  outcomeGate: {
    schema_version: 1;
    artifact_kind: "topic_probe_outcome_gate";
    run_id: string;
    research_cycle: number;
    status: "decided";
    disposition: TopicProbeOutcomeDisposition;
    outcome_content_sha256: string;
    reason_codes: string[];
    venue_viability_report_contract_version: 1;
    content_sha256: string;
  };
  venueViability: ReturnType<typeof buildVenueViabilityReport>;
  gate: ReturnType<typeof buildTopicProbeReviewGate>;
}> {
  process.chdir(fixture.workspaceRoot);
  const paths = resolveAppPaths(fixture.workspaceRoot);
  await ensureScaffold(paths);
  const store = new RunStore(paths);
  const parent = await store.createRun(
    {
      title: "Governed topic probe",
      topic: "Source-grounded candidate selection",
      constraints: ["bounded local execution"],
      objectiveMetric: fixture.contract.objective_raw
    },
    { deterministicId: RUN_ID }
  );
  parent.graph.researchCycle = RESEARCH_CYCLE;
  parent.currentNode = "review";
  parent.graph.currentNode = "review";
  parent.status = "paused";
  parent.graph.nodeStates.review.status = "needs_approval";
  parent.graph.pendingTransition = {
    action: "delegate_successor",
    sourceNode: "review",
    reason: "The validated bounded outcome requires one governed successor.",
    confidence: 0.99,
    autoExecutable: true,
    evidence: ["The parent remains below the paper-evidence ceiling."],
    suggestedCommands: [],
    generatedAt: GENERATED_AT
  };
  await store.updateRun(parent);

  const candidate = fixture.portfolio.candidates.find(
    (item) => item.source_candidate_id === fixture.contract.candidate_id
  )!;
  const handoff = buildTopicProbeFollowupHandoff({
    portfolio: fixture.portfolio,
    contract: fixture.contract,
    outcome: fixture.outcome,
    candidate
  });
  const outcomeGatePayload = {
    schema_version: 1 as const,
    artifact_kind: "topic_probe_outcome_gate" as const,
    run_id: parent.id,
    research_cycle: RESEARCH_CYCLE,
    status: "decided" as const,
    disposition: fixture.outcome.disposition,
    outcome_content_sha256: fixture.outcome.content_sha256,
    reason_codes: [...fixture.outcome.reason_codes],
    venue_viability_report_contract_version: 1 as const
  };
  const outcomeGate = {
    ...outcomeGatePayload,
    content_sha256: hashCanonical(outcomeGatePayload)
  };
  const venueViability = buildVenueViabilityReport({
    candidate,
    contract: fixture.contract,
    outcome: fixture.outcome
  });
  const gate = buildTopicProbeReviewGate({
    runId: parent.id,
    researchCycle: RESEARCH_CYCLE,
    outcome: fixture.outcome,
    handoff
  });
  await Promise.all([
    writeArtifact(
      fixture.workspaceRoot,
      "result_analysis.json",
      JSON.stringify(fixture.report, null, 2)
    ),
    writeArtifact(
      fixture.workspaceRoot,
      TOPIC_PROBE_OUTCOME_GATE_RELATIVE_PATH,
      `${JSON.stringify(outcomeGate, null, 2)}\n`
    ),
    writeArtifact(
      fixture.workspaceRoot,
      VENUE_VIABILITY_REPORT_RELATIVE_PATH,
      `${JSON.stringify(venueViability, null, 2)}\n`
    ),
    writeArtifact(
      fixture.workspaceRoot,
      TOPIC_PROBE_FOLLOWUP_HANDOFF_RELATIVE_PATH,
      `${JSON.stringify(handoff, null, 2)}\n`
    ),
    writeArtifact(
      fixture.workspaceRoot,
      TOPIC_PROBE_REVIEW_GATE_RELATIVE_PATH,
      `${JSON.stringify(gate, null, 2)}\n`
    )
  ]);
  const persisted = await store.getRun(parent.id);
  if (!persisted) {
    throw new Error("delegating parent was not persisted");
  }
  return {
    store,
    parent: persisted,
    paths,
    handoff,
    outcomeGate,
    venueViability,
    gate
  };
}

async function createWorkspaceFixture(
  options: {
    includeOutcome?: boolean;
    route?: TopicProbeSuccessorRoute;
  } = {}
): Promise<WorkspaceFixture> {
  const route = options.route ?? TOPIC_PROBE_SUCCESSOR_ROUTES[0];
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "autolabos-topic-probe-")
  );
  workspaceRoots.push(workspaceRoot);

  const evidenceRows = evidence();
  const evidenceRaw = serializeJsonl(evidenceRows);
  const corpusRaw = serializeJsonl(
    evidenceRows.map((item) => ({ paper_id: item.paper_id }))
  );
  const collectAttemptId = "collect_attempt_fixture";
  const corpusSha256 = createHash("sha256").update(corpusRaw, "utf8").digest("hex");
  const evidenceSha256 = createHash("sha256").update(evidenceRaw, "utf8").digest("hex");
  const collectGenerationRaw = JSON.stringify({
    version: 1,
    kind: "collect_generation",
    run_id: RUN_ID,
    collect_attempt_id: collectAttemptId
  }, null, 2);
  const gapCluster = {
    cluster_id: "gap_cluster_partition",
    opportunity_type: "explicit_limitation" as const,
    statement: "Prior evaluations cover only one declared partition.",
    evidence_ids: evidenceRows.map((item) => item.evidence_id!),
    paper_ids: evidenceRows.map((item) => item.paper_id!)
  };
  const synthesisPayload = {
    schema_version: 2 as const,
    artifact_kind: "research_gap_semantic_synthesis" as const,
    semantics_version: RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION,
    prompt_contract_version: RESEARCH_GAP_SYNTHESIS_PROMPT_CONTRACT_VERSION,
    status: "completed" as const,
    method: "llm_proposer_reviewer_deterministic_validation" as const,
    run_id: RUN_ID,
    research_cycle: RESEARCH_CYCLE,
    collect_attempt_id: collectAttemptId,
    corpus_sha256: corpusSha256,
    evidence_sha256: evidenceSha256,
    generated_at: GENERATED_AT,
    excluded_evidence: [],
    proposed_clusters: [{
      ...gapCluster,
      rationale: "Two independently grounded full-text sources report the same boundary."
    }],
    reviews: [{
      cluster_id: gapCluster.cluster_id,
      opportunity_type: gapCluster.opportunity_type,
      decision: "accept" as const,
      statement: gapCluster.statement,
      accepted_evidence_ids: gapCluster.evidence_ids,
      validated_conditions: ["same_unresolved_limitation" as const],
      reason: "The evidence is independently grounded and semantically aligned."
    }],
    accepted_clusters: [gapCluster],
    unclustered_evidence_ids: [],
    diagnostics: {
      eligible_evidence_count: evidenceRows.length,
      eligible_evidence_count_by_opportunity_type: {
        explicit_limitation: evidenceRows.length,
        cross_paper_result_disagreement: 0,
        boundary_or_transfer_mismatch: 0,
        missing_comparator_or_control: 0,
        reproducibility_gap: 0
      },
      accepted_cluster_count_by_opportunity_type: {
        explicit_limitation: 1,
        cross_paper_result_disagreement: 0,
        boundary_or_transfer_mismatch: 0,
        missing_comparator_or_control: 0,
        reproducibility_gap: 0
      }
    }
  };
  const gapSynthesis = {
    ...synthesisPayload,
    content_sha256: hashCanonical(synthesisPayload)
  };
  const gapSynthesisRaw = JSON.stringify(gapSynthesis, null, 2);
  const gapMap = buildResearchGapMap({
    evidence: evidenceRows,
    semanticClusters: [{
      statement: gapCluster.statement,
      evidence_ids: gapCluster.evidence_ids,
      opportunity_type: gapCluster.opportunity_type
    }],
    constructionMode: "reviewed_semantic_synthesis",
    synthesisBinding: {
      content_sha256: gapSynthesis.content_sha256,
      semantics_version: gapSynthesis.semantics_version,
      status: gapSynthesis.status
    },
    analysisCoverage: {
      selected_paper_count: evidenceRows.length,
      completed_paper_count: evidenceRows.length,
      failed_paper_ids: [],
      complete: true
    },
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    collectAttemptId,
    corpusSha256,
    corpusByteLength: Buffer.byteLength(corpusRaw, "utf8"),
    evidenceSha256,
    evidenceByteLength: Buffer.byteLength(evidenceRaw, "utf8"),
    generatedAt: GENERATED_AT
  });
  const candidates = CANDIDATE_IDS.map((candidateId, index) =>
    candidate(candidateId, gapCluster.evidence_ids, index)
  );
  const evidenceAxes = AXIS_IDS.map((axisId, index) => ({
    id: axisId,
    label: `Evidence axis ${index + 1}`,
    mechanism: `Mechanism ${index + 1} is grounded in the source evidence.`,
    intervention: `Intervention ${index + 1} isolates a bounded comparison.`,
    evidence_links: [...gapCluster.evidence_ids]
  }));
  const drafts = candidates.map((item) => ({
    ...item,
    run_id: RUN_ID,
    research_cycle: RESEARCH_CYCLE,
    supported_gap_ids: resolveSupportedGapIds(item.evidence_links, gapMap)
  }));
  const reviews = candidates.map((item) => ({
    ...review(item.id),
    run_id: RUN_ID,
    research_cycle: RESEARCH_CYCLE
  }));
  const priorAbsorptionMatrix = buildPassingPriorAbsorptionMatrixFixture({
    candidates: drafts,
    evidence: evidenceRows,
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    generatedAt: GENERATED_AT
  });
  const authorizedProbeCandidateIds = [
    CANDIDATE_IDS[0],
    ...route.deferredCandidateIds
  ];
  const preliminaryPortfolio = buildTopicPortfolio({
    candidates: drafts,
    reviews,
    probeCandidateIds: authorizedProbeCandidateIds,
    evidence: evidenceRows,
    evidenceAxes,
    gapMap,
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    generatedAt: GENERATED_AT,
    computeBudgetCeiling: makeTopicProbeComputeBudgetLimits(),
    priorAbsorptionMatrix
  });
  const hypotheses = preliminaryPortfolio.probe_candidate_ids.map(
    (candidateId, index) => {
      const item = drafts.find((draft) => draft.id === candidateId)!;
      return {
        hypothesis_id: `hypothesis_${index + 1}`,
        candidate_id: candidateId,
        run_id: RUN_ID,
        research_cycle: RESEARCH_CYCLE,
        supported_gap_ids: item.supported_gap_ids,
        text: item.text,
        evidence_links: item.evidence_links,
        axis_ids: item.axis_ids,
        gap_statement: item.gap_statement,
        closest_prior_non_overlap: item.closest_prior_non_overlap,
        reviewer_absorption_objection: item.reviewer_absorption_objection,
        comparator: item.comparator,
        dataset_task_bench: item.dataset_task_bench,
        primary_metric: item.primary_metric,
        metric_unit: item.metric_unit,
        metric_scale: item.metric_scale,
        metric_direction: item.metric_direction,
        effect_criterion: item.effect_criterion,
        objective_raw: preliminaryPortfolio.candidates.find(
          (portfolioCandidate) =>
            portfolioCandidate.source_candidate_id === candidateId
        )?.objective_raw,
        meaningful_effect: item.meaningful_effect,
        measurement_signals: item.measurement_signals,
        measurement_hint: item.measurement_hint,
        falsifier: item.falsifier,
        local_budget: item.local_budget,
        kill_signal: item.kill_signal,
        contribution_claim: item.contribution_claim,
        minimum_publishable_evidence: item.minimum_publishable_evidence
      };
    }
  );
  const shortlist = {
    run_id: RUN_ID,
    research_cycle: RESEARCH_CYCLE,
    probe_candidate_ids: preliminaryPortfolio.probe_candidate_ids,
    probe_topic_ids: preliminaryPortfolio.probe_topic_ids,
    ranked_candidate_ids: candidates.map((item) => item.id),
    scores: candidates.map((item) => ({ candidate_id: item.id }))
  };
  const gapMapRaw = JSON.stringify(gapMap, null, 2);
  const evidenceAxesRaw = `${JSON.stringify(evidenceAxes, null, 2)}\n`;
  const priorAbsorptionMatrixRaw =
    `${JSON.stringify(priorAbsorptionMatrix, null, 2)}\n`;
  const hypothesesRaw = serializeJsonl(hypotheses);
  const draftsRaw = serializeJsonl(drafts);
  const reviewsRaw = serializeJsonl(reviews);
  const probeShortlistRaw = JSON.stringify(shortlist, null, 2);
  const sourceContents = {
    "analysis/gap_map.json": gapMapRaw,
    "hypothesis_generation/evidence_axes.json": evidenceAxesRaw,
    "hypothesis_generation/prior_absorption_matrix.json":
      priorAbsorptionMatrixRaw,
    "hypotheses.jsonl": hypothesesRaw,
    "hypothesis_generation/drafts.jsonl": draftsRaw,
    "hypothesis_generation/reviews.jsonl": reviewsRaw,
    "hypothesis_generation/probe_shortlist.json": probeShortlistRaw
  } as const;
  const sourceArtifactBindings = RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS.map(
    (artifactRelativePath) =>
      buildResearchFunnelArtifactBinding(
        artifactRelativePath,
        sourceContents[artifactRelativePath]
      )
  );
  const portfolio = buildTopicPortfolio({
    candidates: drafts,
    reviews,
    probeCandidateIds: shortlist.probe_candidate_ids,
    evidence: evidenceRows,
    evidenceAxes,
    gapMap,
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    generatedAt: GENERATED_AT,
    computeBudgetCeiling: makeTopicProbeComputeBudgetLimits(),
    sourceArtifactBindings,
    priorAbsorptionMatrix
  });
  const portfolioRaw = JSON.stringify(portfolio, null, 2);
  const funnelInput = {
    expectedRunId: RUN_ID,
    expectedResearchCycle: RESEARCH_CYCLE,
    gapMapRaw,
    evidenceAxesRaw,
    priorAbsorptionMatrixRaw,
    hypothesesRaw,
    draftsRaw,
    reviewsRaw,
    probeShortlistRaw,
    portfolioRaw,
    requireDecision: false
  };
  const gapEvidenceChain = buildResearchGapEvidenceChain({
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    corpusRaw,
    evidenceRaw,
    synthesisRaw: gapSynthesisRaw,
    collectGenerationRaw
  });
  const upstreamValidation = validateResearchFunnelClosedChain({
    ...funnelInput,
    gapValidationContext: gapEvidenceChain.validationContext,
    gapValidationReasonCodes: gapEvidenceChain.reasonCodes
  });
  if (!upstreamValidation.valid) {
    throw new Error(
      `invalid topic-probe fixture: ${upstreamValidation.reasons.join(",")}`
    );
  }
  const topicDecision = buildTopicDecision({
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    validation: upstreamValidation,
    generatedAt: GENERATED_AT
  });
  const activeCandidate = portfolio.candidates.find(
    (item) => item.source_candidate_id === CANDIDATE_IDS[0]
  )!;
  const contract = buildActiveTopicProbeContract({
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    researchMode: "topic_discovery",
    portfolioContentSha256: portfolio.content_sha256,
    candidate: activeCandidate,
    deferredCandidateIds: [...route.deferredCandidateIds],
    generatedAt: GENERATED_AT
  });
  const artifactRows: Array<readonly [string, string]> = [
    [TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.gapMap, gapMapRaw],
    [TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.gapSynthesis, gapSynthesisRaw],
    [TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.evidenceStore, evidenceRaw],
    [TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.corpus, corpusRaw],
    [TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.collectGeneration, collectGenerationRaw],
    [TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.evidenceAxes, evidenceAxesRaw],
    [
      TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.priorAbsorptionMatrix,
      priorAbsorptionMatrixRaw
    ],
    [TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.hypotheses, hypothesesRaw],
    [TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.drafts, draftsRaw],
    [TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.reviews, reviewsRaw],
    [TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.probeShortlist, probeShortlistRaw],
    [TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.portfolio, portfolioRaw],
    [
      TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.topicDecision,
      JSON.stringify(topicDecision, null, 2)
    ],
    [
      TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.activeContract,
      JSON.stringify(contract, null, 2)
    ]
  ];
  await Promise.all(
    artifactRows.map(([relativePath, raw]) =>
      writeArtifact(workspaceRoot, relativePath, raw)
    )
  );

  const baseReport = analysisReport(contract, route);
  const governedEvidence = buildProbeEvidenceAssessment(baseReport, {
    mode: "sampled",
    observedUnitCount: 2,
    includeDeterministicOracle: false
  });
  const report: AnalysisReport = {
    ...baseReport,
    evidence_adequacy_assessment: governedEvidence.assessment
  };
  const evidenceReassessment = await persistProbeEvidenceAndReassess(
    workspaceRoot,
    report,
    governedEvidence
  );
  const evidenceAdequacyAuthorization = evidenceReassessment.authorization;
  if (!evidenceAdequacyAuthorization) {
    throw new Error(
      `topic-probe evidence fixture was not authorized: ${evidenceReassessment.issues.join(",")}`
    );
  }

  const outcome = buildTopicProbeOutcomeDecision({
    contract,
    report,
    evidenceAdequacyAuthorization
  });
  if (
    outcome.disposition !== route.disposition
    || outcome.next_action !== route.nextAction
  ) {
    throw new Error(
      `topic-probe route fixture mismatch: ${outcome.disposition}/${outcome.next_action}`
    );
  }
  if (options.includeOutcome !== false) {
    await writeArtifact(
      workspaceRoot,
      TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.outcome,
      JSON.stringify(outcome, null, 2)
    );
  }

  return {
    workspaceRoot,
    portfolio,
    topicDecision,
    contract,
    evidenceAdequacyAuthorization,
    outcome,
    report
  };
}

async function loadFixture(fixture: WorkspaceFixture) {
  return loadTopicProbeOutcomeArtifacts({
    workspaceRoot: fixture.workspaceRoot,
    runId: RUN_ID,
    researchCycle: RESEARCH_CYCLE,
    requireOutcome: true,
    report: fixture.report
  });
}

async function writeArtifact(
  workspaceRoot: string,
  relativePath: string,
  raw: string
): Promise<void> {
  const filePath = artifactPath(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, raw, "utf8");
}

function artifactPath(workspaceRoot: string, relativePath: string): string {
  return path.join(
    buildWorkspaceRunRoot(workspaceRoot, RUN_ID),
    relativePath
  );
}

function serializeJsonl(items: unknown[]): string {
  return items.length > 0
    ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n`
    : "";
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function evidence(): PriorAbsorptionEvidenceSeed[] {
  return [
    {
      evidence_id: "evidence_method",
      paper_id: "prior_method",
      canonical_work_id: "work_prior_method",
      claim: "The prior study reports a controlled primary comparison.",
      method_slot: "The prior evaluates a declared comparison mechanism.",
      result_slot: "The prior reports a matched comparison result.",
      limitation_slot: "The evaluation covers one declared partition.",
      limitation_kind: "scientific",
      dataset_slot: "evaluation_collection",
      metric_slot: "primary_score",
      source_type: "full_text",
      source_scope: "full_document",
      grounding_status: "grounded_span",
      evidence_span: "The evaluation covers one declared partition.",
      confidence: 0.9
    },
    {
      evidence_id: "evidence_audit",
      paper_id: "prior_audit",
      canonical_work_id: "work_prior_audit",
      claim: "The prior audit reports bounded failure evidence.",
      method_slot: "The prior evaluates a declared audit mechanism.",
      result_slot: "The prior reports a bounded audit result.",
      limitation_slot: "The evaluation covers one declared partition.",
      limitation_kind: "scientific",
      dataset_slot: "evaluation_collection",
      metric_slot: "primary_score",
      source_type: "full_text",
      source_scope: "full_document",
      grounding_status: "grounded_span",
      evidence_span: "The evaluation covers one declared partition.",
      confidence: 0.9
    }
  ];
}

function candidate(
  id: string,
  evidenceLinks: string[],
  index: number
): HypothesisCandidate {
  return {
    id,
    text:
      `The ${id} intervention changes the primary outcome relative to `
      + "the declared reference condition.",
    novelty: 4,
    feasibility: 4,
    testability: 5,
    cost: 2,
    expected_gain: 3,
    evidence_links: [...evidenceLinks],
    axis_ids: [AXIS_IDS[index % AXIS_IDS.length]!],
    gap_statement: "Existing evaluations cover one declared partition.",
    closest_prior_non_overlap:
      "The candidate isolates a boundary absent from the linked prior work.",
    reviewer_absorption_objection:
      "The strongest reference may absorb the proposed intervention.",
    comparator: "reference_condition",
    dataset_task_bench: "evaluation_collection",
    primary_metric: "primary_score",
    metric_unit: "unitless",
    metric_scale: "raw",
    metric_direction: "maximize",
    effect_criterion: {
      basis: "delta_vs_reference",
      magnitude: 0.05,
      scale: "raw",
      inclusive: true
    },
    meaningful_effect:
      "At least 0.05 over the declared reference condition.",
    measurement_signals: ["primary_score", "uncertainty_interval"],
    measurement_hint:
      "Compare repeated matched measurements with uncertainty.",
    falsifier:
      "The paired interval includes effects below the declared floor.",
    local_budget: makeTopicProbeComputeBudgetDeclaration(),
    brief_compute_budget_ceiling: makeTopicProbeComputeBudgetLimits(),
    kill_signal:
      "Stop when the intervention cannot be distinguished from the reference.",
    contribution_claim:
      `The ${id} comparison identifies a prespecified evaluation boundary.`,
    minimum_publishable_evidence:
      "Repeated comparisons with uncertainty and failure analysis."
  };
}

function review(candidateId: string): HypothesisReview {
  return {
    candidate_id: candidateId,
    keep: true,
    groundedness: 4,
    causal_clarity: 4,
    falsifiability: 4,
    experimentability: 4,
    measurement_specificity: 4,
    measurement_signals: ["matched_measurements"],
    measurement_hint:
      "Compare repeated matched measurements with uncertainty.",
    limitation_reflection: 4,
    measurement_readiness: 4,
    strengths: ["The comparison and falsifier are explicit."],
    weaknesses: ["The claim remains bounded to the declared evaluation."],
    provenance: makeIndependentHypothesisReviewProvenance(candidateId)
  };
}

function analysisReport(
  contract: ActiveTopicProbeContract,
  route: TopicProbeSuccessorRoute
): AnalysisReport {
  const delta = route.observedDelta;
  const referenceValue = 0.5;
  const executionBinding = buildTopicProbeExecutionBinding({
    candidateId: contract.candidate_id,
    candidateContentSha256: contract.candidate_content_sha256,
    comparator: contract.comparator,
    datasetTaskScope: contract.dataset_task_bench
  });
  const candidateBinding = buildCandidateObjectiveProfileBinding({
    candidateId: contract.candidate_id,
    primaryMetric: contract.primary_metric,
    metricUnit: contract.metric_unit,
    metricScale: contract.metric_scale,
    metricDirection: contract.metric_direction,
    comparator: contract.comparator,
    effectCriterion: contract.effect_criterion,
    objectiveRaw: contract.objective_raw
  });
  const confidenceIntervals = route.confidenceInterval
    ? [{
        metric_key: contract.primary_metric,
        comparison_id: executionBinding.primary_comparison_id,
        estimand: "effect_delta" as const,
        metric_scale: contract.metric_scale,
        trial_source: "fresh_executed" as const,
        label: "Primary interval",
        lower: route.confidenceInterval[0],
        upper: route.confidenceInterval[1],
        level: 0.95,
        sample_size: route.executedTrials,
        method: "paired_bootstrap",
        source: "metrics",
        summary: "Interval over fresh bounded trials."
      }]
    : [];
  return {
    analysis_version: 1,
    objective_metric: {
      profile: {
        candidate_contract: candidateBinding
      }
    },
    results_plan: {
      schema_version: "2.0",
      required_metrics: [{
        id: contract.primary_metric,
        label: contract.primary_metric,
        direction: "higher_better",
        unit: contract.metric_unit
      }],
      minimum_series_count: 2,
      minimum_comparison_count: 1,
      required_series: [
        { id: executionBinding.subject_series_id, role: "primary" },
        { id: executionBinding.reference_series_id, role: "baseline" }
      ],
      required_comparisons: [{
        id: executionBinding.primary_comparison_id,
        subject_series_id: executionBinding.subject_series_id,
        reference_series_id: executionBinding.reference_series_id,
        metric_id: contract.primary_metric,
        scope: executionBinding.observation_scope
      }],
      primary_comparison_id: executionBinding.primary_comparison_id,
      primary_effect_criterion: {
        comparison_id: executionBinding.primary_comparison_id,
        metric_id: contract.primary_metric,
        metric_scale: contract.metric_scale,
        direction: contract.metric_direction,
        effect_criterion: contract.effect_criterion
      }
    },
    primary_comparison_id: executionBinding.primary_comparison_id,
    results_artifact: {
      schema_version: "2.0",
      metrics: [{
        id: contract.primary_metric,
        label: "Primary score",
        direction: "higher_better",
        unit: contract.metric_unit
      }],
      series: [
        {
          id: executionBinding.subject_series_id,
          label: "Candidate condition",
          role: "primary",
          dimensions: {}
        },
        {
          id: executionBinding.reference_series_id,
          label: "Reference condition",
          role: "baseline",
          dimensions: {}
        }
      ],
      observations: [
        {
          id: "observation_candidate",
          series_id: executionBinding.subject_series_id,
          metric_id: contract.primary_metric,
          scope: executionBinding.observation_scope,
          value: referenceValue + delta,
          evidence_refs: ["metrics.json#/candidate"]
        },
        {
          id: "observation_reference",
          series_id: executionBinding.reference_series_id,
          metric_id: contract.primary_metric,
          scope: executionBinding.observation_scope,
          value: referenceValue,
          evidence_refs: ["metrics.json#/reference"]
        }
      ],
      comparisons: [{
        id: executionBinding.primary_comparison_id,
        subject_observation_id: "observation_candidate",
        reference_observation_id: "observation_reference",
        delta,
        judgement: "supported",
        evidence_refs: ["metrics.json#/comparison"]
      }]
    },
    statistical_summary: {
      executed_trials: route.executedTrials,
      cached_trials: 0,
      confidence_intervals: confidenceIntervals,
      stability_metrics: [],
      effect_estimates: [{
        comparison_id: executionBinding.primary_comparison_id,
        metric_key: contract.primary_metric,
        delta,
        direction: "positive",
        summary: "Effect estimate for the declared primary comparison."
      }],
      notes: []
    },
    failure_taxonomy: []
  } as unknown as AnalysisReport;
}

function buildProbeEvidenceAssessment(
  report: AnalysisReport,
  input: {
    mode: EvidenceAdequacyCoverageMode;
    observedUnitCount: number;
    includeDeterministicOracle: boolean;
  }
) {
  const primaryComparisonId = report.primary_comparison_id;
  if (!primaryComparisonId) {
    throw new Error("primary comparison fixture missing");
  }
  const exhaustive = input.mode === "deterministic_exhaustive";
  const populationManifestSha256 = exhaustive
    ? hashCanonical({
        artifact_kind: "independent_unit_population",
        unit_ids: ["unit_alpha", "unit_beta"]
      })
    : undefined;
  const contract = buildEvidenceAdequacyContract({
    primaryComparisonId,
    designSource: {
      kind: exhaustive
        ? "deterministic_exhaustive_manifest"
        : "estimator_protocol",
      contentSha256: hashCanonical({
        artifact_kind: exhaustive
          ? "deterministic_exhaustive_manifest"
          : "estimator_protocol",
        primary_comparison_id: primaryComparisonId
      })
    },
    independentUnit: {
      key: "evaluation_unit_id",
      analysisUnit: "paired evaluation unit"
    },
    plannedIndependentCoverage: {
      mode: input.mode,
      targetUniqueUnits: 2,
      targetDenominatorPerArm: 2,
      ...(populationManifestSha256
        ? { populationManifestSha256 }
        : {})
    },
    requiredContrast: {
      arms: ["candidate_arm", "reference_arm"],
      paired: true,
      requiredCompletePairs: 2
    },
    uncertaintyRequirement: exhaustive
      ? {
          mode: "none",
          deterministicExhaustiveRationale:
            "The frozen population is exhaustively paired and independently replayed with hash verification."
        }
      : {
          mode: "required",
          allowedMethods: ["paired_bootstrap"],
          confidenceLevel: 0.95,
          decisionRule: "directed_interval_bound_meets_effect_criterion"
        },
    effectResolution: {
      scale: "raw",
      minimumResolvableEffect: 0.01
    },
    executionBudget: {
      applicable: false,
      notApplicableRationale:
        "The bounded probe contract declares no additional numeric execution floor."
    }
  });
  const unitIds = ["unit_alpha", "unit_beta"].slice(
    0,
    input.observedUnitCount
  );
  const oracleRefs = exhaustive && input.includeDeterministicOracle
    ? [
        "metrics.json#/deterministic_oracle",
        "reproducibility.json#/rerun_hash_match"
      ]
    : [];
  const primaryEvidenceRefs = [
    "metrics.json#/primary_comparison",
    ...oracleRefs
  ];
  const receipt = buildEvidenceAdequacyExecutionReceipt({
    contractSha256: contract.content_sha256,
    primaryComparisonId,
    ...(populationManifestSha256
      ? { observedPopulationManifestSha256: populationManifestSha256 }
      : {}),
    uniqueExecutionIds: exhaustive
      ? ["execution_initial", "execution_replay"]
      : ["execution_sampled"],
    observedIndependentUnitIds: unitIds,
    observedDenominatorByArm: {
      candidate_arm: input.observedUnitCount,
      reference_arm: input.observedUnitCount
    },
    observedPairCoverage: {
      completePairIds: unitIds,
      incompletePairIds: []
    },
    observedUncertaintyMethods: exhaustive ? [] : ["paired_bootstrap"],
    primaryEvidenceRefs,
    deterministicOracleEvidenceRefs: oracleRefs
  });
  return {
    contract,
    receipt,
    assessment: assessEvidenceAdequacy({
      contract,
      receipt,
      verifiedEvidenceRefs: primaryEvidenceRefs
    })
  };
}

async function persistProbeEvidenceAndReassess(
  workspaceRoot: string,
  report: AnalysisReport,
  governed: ReturnType<typeof buildProbeEvidenceAssessment>
): Promise<EvidenceAdequacyArtifactReassessment> {
  const metricsEvidence = {
    primary_comparison: {
      comparison_id: report.primary_comparison_id,
      verified: true
    },
    candidate: { value: 0.56 },
    reference: { value: 0.5 },
    comparison: { delta: 0.06 },
    deterministic_oracle: {
      replay_verified: true
    }
  };
  const reproducibilityEvidence = {
    rerun_hash_match: true
  };
  await Promise.all([
    writeArtifact(
      workspaceRoot,
      EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH,
      JSON.stringify(governed.contract, null, 2)
    ),
    writeArtifact(
      workspaceRoot,
      EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH,
      JSON.stringify(governed.receipt, null, 2)
    ),
    writeArtifact(
      workspaceRoot,
      EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH,
      JSON.stringify(governed.assessment, null, 2)
    ),
    writeArtifact(
      workspaceRoot,
      "result_analysis.json",
      JSON.stringify(report, null, 2)
    ),
    writeArtifact(
      workspaceRoot,
      "metrics.json",
      JSON.stringify(metricsEvidence, null, 2)
    ),
    writeArtifact(
      workspaceRoot,
      "reproducibility.json",
      JSON.stringify(reproducibilityEvidence, null, 2)
    )
  ]);

  const runRoot = buildWorkspaceRunRoot(workspaceRoot, RUN_ID);
  return reassessEvidenceAdequacyArtifacts({
    runDir: runRoot,
    evidenceRoots: [runRoot],
    expectedPrimaryComparisonId:
      report.results_plan?.primary_comparison_id,
    requireStoredAssessment: true
  });
}
