import path from "node:path";

import { promises as fs } from "node:fs";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { safeRead, writeRunArtifact } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import { publishPublicRunOutputs } from "../publicOutputPublisher.js";
import { resolveConstraintProfile } from "../constraintProfile.js";
import { ObjectiveMetricProfile, resolveObjectiveMetricProfile } from "../objectiveMetric.js";
import {
  designExperimentsFromHypotheses,
  DesignInputHypothesis,
  DesignRetryContext,
  ExperimentDesignCandidate
} from "../analysis/researchPlanning.js";
import { buildResearchGapEvidenceChain } from "../analysis/researchGapEvidenceChain.js";
import { buildExperimentPortfolioFromDesign } from "../experiments/experimentPortfolio.js";
import { clearExecutionSummaryArtifactsInvalidatedByDesign } from "../experiments/staleExecutionArtifacts.js";
import { runDesignExperimentsPanel } from "../designExperimentsPanel.js";
import {
  buildEstimatorFeasibilityArtifacts,
  ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH,
  ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH,
  ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH
} from "../estimatorFeasibilityGate.js";
import {
  buildExperimentComparisonContract,
  storeExperimentGovernanceDecision
} from "../experimentGovernance.js";
import {
  buildExperimentContract,
  writeExperimentContract,
  validateExperimentContract
} from "../experiments/experimentContract.js";
import { checkBriefDesignConsistency } from "../experiments/briefDesignConsistency.js";
import {
  RESULTS_ARTIFACT_SCHEMA_VERSION,
  type ResultsPlanV2
} from "../analysis/resultsTableSchema.js";
import {
  buildEvidenceAdequacyContractFromEstimatorProtocol,
  EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH
} from "../analysis/evidenceAdequacy.js";
import { parseMarkdownRunBriefSections } from "../runs/runBriefParser.js";
import type { MarkdownRunBriefSections } from "../runs/runBriefParser.js";
import {
  loadResearchBriefSnapshot,
  resolveResearchRunModeGuard
} from "../runs/researchRunModeGuard.js";
import { BriefCompletenessArtifact, buildBriefCompletenessArtifact } from "../runs/researchBriefFiles.js";
import { buildWorkspaceRunRoot } from "../runs/runPaths.js";
import { resolveExplorationConfig } from "../exploration/explorationConfig.js";
import { ExplorationManager } from "../exploration/explorationManager.js";
import {
  buildTopicDecision,
  hashCanonical,
  isTopicPortfolioCandidateDispositionAuditable,
  validateResearchFunnelClosedChain,
  type TopicPortfolio,
  type TopicPortfolioCandidate,
  type ResearchFunnelGate
} from "../researchFunnel.js";
import {
  evaluateTopicMemory,
  validateTopicMemoryLedger,
  type TopicMemoryDecision,
  type TopicMemoryLedger
} from "../topicMemory.js";
import {
  buildTopicMemoryDatabasePath,
  TopicMemoryStore
} from "../runs/topicMemoryStore.js";
import {
  buildActiveTopicProbeContract,
  validateActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "../activeTopicProbeContract.js";
import {
  buildCandidateObjectiveProfileBinding,
  candidateRawDeltaMetricKey,
  objectiveComparatorForEffectCriterion,
  parseEffectCriterion,
  readCandidateObjectiveProfileBinding,
  signedRawDeltaTargetForEffectCriterion,
  type CandidateObjectiveProfileBinding
} from "../effectCriterion.js";
import {
  isTopicProbeSuccessorDesignCandidate,
  validateTopicProbeSuccessorPortfolioTarget,
  validateTopicProbeSuccessorDesignTarget,
  type TopicProbeSuccessorDesignCandidate
} from "../topicProbeSuccessorDesignTarget.js";

interface FilteredHypothesis {
  hypothesis_id: string;
  text: string;
  reason: string;
}

interface ParsedDesignHypothesis extends DesignInputHypothesis {
  candidate_id?: string;
  run_id?: string;
  research_cycle?: number;
  supported_gap_ids?: string[];
}

interface ClosedChainArtifactRead {
  raw?: string;
  reasonCode?: string;
}

interface CandidateOwnedObjectiveMetricProfile extends ObjectiveMetricProfile {
  candidate_contract: CandidateObjectiveProfileBinding;
  delta_contract: {
    output_metric_key: string;
    source_metric_key: string;
    raw_delta_definition: "subject_minus_reference";
    comparator: ">=" | ">" | "<=" | "<";
    signed_target: number;
  };
}

type CandidateObjectiveContract =
  | ActiveTopicProbeContract
  | TopicProbeSuccessorDesignCandidate;

export interface CurrentTopicMemoryPortfolioResolution {
  valid: boolean;
  reasons: string[];
  snapshot_relation: "current" | "ancestor" | "invalid";
  snapshot_ledger_sha256?: string;
  current_ledger_sha256?: string;
  portfolio?: TopicPortfolio;
  candidate_decisions: Array<{
    candidate_id: string;
    candidate_content_sha256: string;
    decision: TopicMemoryDecision;
  }>;
}

export function rebaseTopicPortfolioToCurrentMemory(input: {
  portfolio: TopicPortfolio;
  currentLedger: TopicMemoryLedger;
}): CurrentTopicMemoryPortfolioResolution {
  const snapshotValidation = validateTopicMemoryLedger(
    input.portfolio.topic_memory_ledger
  );
  const currentValidation = validateTopicMemoryLedger(input.currentLedger);
  const snapshot = snapshotValidation.ledger;
  const current = currentValidation.ledger;
  const validationReasons = uniqueStrings([
    ...snapshotValidation.reasons.map(
      (reason) => `topic_memory_portfolio_snapshot_invalid:${reason}`
    ),
    ...currentValidation.reasons.map(
      (reason) => `topic_memory_current_ledger_invalid:${reason}`
    )
  ]);
  if (!snapshot || !current || validationReasons.length > 0) {
    return {
      valid: false,
      reasons: validationReasons.length > 0
        ? validationReasons
        : ["topic_memory_ledger_unavailable"],
      snapshot_relation: "invalid",
      snapshot_ledger_sha256: snapshot?.ledger_sha256,
      current_ledger_sha256: current?.ledger_sha256,
      candidate_decisions: []
    };
  }

  const snapshotRelation = classifyTopicMemorySnapshot(snapshot, current);
  if (snapshotRelation === "invalid") {
    return {
      valid: false,
      reasons: ["topic_memory_portfolio_snapshot_not_current_ancestor"],
      snapshot_relation: snapshotRelation,
      snapshot_ledger_sha256: snapshot.ledger_sha256,
      current_ledger_sha256: current.ledger_sha256,
      candidate_decisions: []
    };
  }

  const reasons: string[] = [];
  const candidateDecisions: CurrentTopicMemoryPortfolioResolution["candidate_decisions"] = [];
  const candidates = input.portfolio.candidates.map((candidate) => {
    const descriptor = candidate.topic_memory?.descriptor;
    if (!descriptor) {
      reasons.push(
        `topic_memory_candidate_descriptor_missing:${candidate.source_candidate_id}`
      );
      return candidate;
    }
    const decision = evaluateTopicMemory(
      current,
      descriptor,
      candidate.topic_memory?.reentry_ticket,
      candidate.topic_memory?.semantic_audit
    );
    const currentSemanticAudit =
      candidate.topic_memory?.semantic_audit?.ledger_sha256
        === current.ledger_sha256
        ? candidate.topic_memory.semantic_audit
        : undefined;
    const memoryEligible =
      decision.disposition === "clear"
      || decision.disposition === "reentry_allowed";
    const memoryGateCode = "topic_memory_clear_or_reentry_allowed";
    if (!candidate.gates.some((gate) => gate.code === memoryGateCode)) {
      reasons.push(
        `topic_memory_candidate_gate_missing:${candidate.source_candidate_id}`
      );
    }
    const gates = setGateStatus(candidate.gates, memoryGateCode, memoryEligible);
    const { content_sha256: _candidateContentSha256, ...candidatePayload } = candidate;
    const nextCandidatePayload: Omit<TopicPortfolioCandidate, "content_sha256"> = {
      ...candidatePayload,
      formulation_version: current.records.filter(
        (record) =>
          record.descriptor.lineage_sha256 === descriptor.lineage_sha256
      ).length + 1,
      topic_memory: {
        ledger_sha256: current.ledger_sha256,
        descriptor,
        ...(candidate.topic_memory?.reentry_ticket
          ? { reentry_ticket: candidate.topic_memory.reentry_ticket }
          : {}),
        ...(currentSemanticAudit
          ? { semantic_audit: currentSemanticAudit }
          : {}),
        decision
      },
      gates,
      probe_eligible: gates.every((gate) => gate.status === "pass")
    };
    const nextCandidate = {
      ...nextCandidatePayload,
      content_sha256: hashCanonical(nextCandidatePayload)
    };
    candidateDecisions.push({
      candidate_id: nextCandidate.source_candidate_id,
      candidate_content_sha256: nextCandidate.content_sha256,
      decision
    });
    return nextCandidate;
  });

  const requiredPortfolioGateCodes = [
    "topic_memory_snapshot_valid",
    "portfolio_candidates_admissible",
    "probe_candidate_contract_complete"
  ];
  for (const gateCode of requiredPortfolioGateCodes) {
    if (!input.portfolio.gates.some((gate) => gate.code === gateCode)) {
      reasons.push(`topic_memory_portfolio_gate_missing:${gateCode}`);
    }
  }
  if (reasons.length > 0) {
    return {
      valid: false,
      reasons: uniqueStrings(reasons),
      snapshot_relation: snapshotRelation,
      snapshot_ledger_sha256: snapshot.ledger_sha256,
      current_ledger_sha256: current.ledger_sha256,
      candidate_decisions: candidateDecisions
    };
  }

  const probeCandidates = candidates.filter(
    (candidate) => candidate.probe_status === "shortlisted"
  );
  let gates = setGateStatus(
    input.portfolio.gates,
    "topic_memory_snapshot_valid",
    true
  );
  gates = setGateStatus(
    gates,
    "portfolio_candidates_admissible",
    candidates.length > 0
      && candidates.every(isTopicPortfolioCandidateDispositionAuditable)
  );
  gates = setGateStatus(
    gates,
    "probe_candidate_contract_complete",
    probeCandidates.length > 0
      && probeCandidates.every((candidate) => candidate.probe_eligible)
  );
  const { content_sha256: _portfolioContentSha256, ...portfolioPayload } = input.portfolio;
  const nextPortfolioPayload: Omit<TopicPortfolio, "content_sha256"> = {
    ...portfolioPayload,
    topic_memory_ledger: current,
    candidates,
    gates,
    probe_allowed: gates.every((gate) => gate.status === "pass")
  };
  const portfolio = {
    ...nextPortfolioPayload,
    content_sha256: hashCanonical(nextPortfolioPayload)
  };
  return {
    valid: true,
    reasons: [],
    snapshot_relation: snapshotRelation,
    snapshot_ledger_sha256: snapshot.ledger_sha256,
    current_ledger_sha256: current.ledger_sha256,
    portfolio,
    candidate_decisions: candidateDecisions
  };
}

function classifyTopicMemorySnapshot(
  snapshot: TopicMemoryLedger,
  current: TopicMemoryLedger
): CurrentTopicMemoryPortfolioResolution["snapshot_relation"] {
  if (snapshot.ledger_sha256 === current.ledger_sha256) {
    return "current";
  }
  if (snapshot.records.length >= current.records.length) {
    return "invalid";
  }
  const prefixMatches = snapshot.records.every(
    (record, index) =>
      current.records[index]?.record_sha256 === record.record_sha256
  );
  const firstSuccessor = current.records[snapshot.records.length];
  return prefixMatches
    && firstSuccessor?.previous_ledger_sha256 === snapshot.ledger_sha256
    ? "ancestor"
    : "invalid";
}

function setGateStatus(
  gates: ResearchFunnelGate[],
  code: string,
  passed: boolean
): ResearchFunnelGate[] {
  return gates.map((gate) =>
    gate.code === code
      ? { ...gate, status: passed ? "pass" : "block" }
      : gate
  );
}

function loadCurrentTopicMemoryLedger(workspaceRoot: string): TopicMemoryLedger {
  const store = new TopicMemoryStore(
    buildTopicMemoryDatabasePath(workspaceRoot)
  );
  try {
    return store.loadLedger();
  } finally {
    store.close();
  }
}

export function createDesignExperimentsNode(deps: NodeExecutionDeps): GraphNodeHandler {

  return {
    id: "design_experiments",
    async execute({ run }) {
      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      const memoryRawBrief = await runContextMemory.get<string>("run_brief.raw");
      const snapshotBrief = await loadResearchBriefSnapshot(process.cwd(), run.id);
      const researchModeGuard = await resolveResearchRunModeGuard({
        workspaceRoot: process.cwd(),
        runId: run.id,
        rawBrief: memoryRawBrief,
        run
      });
      const rawBrief = memoryRawBrief || snapshotBrief || "";
      await runContextMemory.put("research_governance.mode_guard", researchModeGuard);
      await writeRunArtifact(
        run,
        "governance/research_mode_guard.json",
        `${JSON.stringify(researchModeGuard, null, 2)}\n`
      );
      if (!researchModeGuard.valid) {
        const error =
          "design_experiments blocked because the persisted research mode and evidence lineage do not agree: "
          + researchModeGuard.reasons.join(", ");
        return {
          status: "failure",
          error,
          summary: error,
          toolCallsUsed: 0
        };
      }
      const researchMode = researchModeGuard.effectiveMode;
      const hypothesisBacktrackTarget =
        researchMode === "topic_discovery"
          ? "analyze_papers"
          : "generate_hypotheses";
      const emitLog = (text: string) => {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "design_experiments",
          payload: { text }
        });
      };
      const runDir = path.join(".autolabos", "runs", run.id);
      const gapMapRelativePath = "analysis/gap_map.json";
      const gapSynthesisRelativePath = "analysis/gap_synthesis.json";
      const evidenceRelativePath = "evidence_store.jsonl";
      const corpusRelativePath = "corpus.jsonl";
      const collectGenerationRelativePath = "collect_generation.json";
      const evidenceAxesRelativePath =
        "hypothesis_generation/evidence_axes.json";
      const priorAbsorptionMatrixRelativePath =
        "hypothesis_generation/prior_absorption_matrix.json";
      const hypothesesRelativePath = "hypotheses.jsonl";
      const draftsRelativePath = "hypothesis_generation/drafts.jsonl";
      const reviewsRelativePath = "hypothesis_generation/reviews.jsonl";
      const probeShortlistRelativePath = "hypothesis_generation/probe_shortlist.json";
      const topicPortfolioRelativePath = "hypothesis_generation/topic_portfolio.json";
      const topicDecisionRelativePath = "design_experiments_panel/topic_decision.json";
      const topicMemoryRefreshRelativePath =
        "design_experiments_panel/topic_memory_refresh.json";
      const hypothesesRead = await readClosedChainArtifact(runDir, hypothesesRelativePath);
      let approvedCandidateIds: string[] | undefined;
      let validatedPortfolio: TopicPortfolio | undefined;
      let successorDesignCandidate:
        TopicProbeSuccessorDesignCandidate | undefined;
      const successorRouteTarget = researchModeGuard.successorRouteTarget;

      if (
        run.executionRole === "delegated_once"
        && !successorRouteTarget
      ) {
        const message =
          "Delegated successor design is missing its validated route target.";
        emitLog(message);
        return {
          status: "failure",
          error: message,
          summary: message,
          toolCallsUsed: 0
        };
      }

      if (researchMode === "topic_discovery") {
        const [
          gapMapRead,
          gapSynthesisRead,
          evidenceRead,
          corpusRead,
          collectGenerationRead,
          evidenceAxesRead,
          priorAbsorptionMatrixRead,
          draftsRead,
          reviewsRead,
          probeShortlistRead,
          portfolioRead
        ] =
          await Promise.all([
          readClosedChainArtifact(runDir, gapMapRelativePath),
          readClosedChainArtifact(runDir, gapSynthesisRelativePath),
          readClosedChainArtifact(runDir, evidenceRelativePath),
          readClosedChainArtifact(runDir, corpusRelativePath),
          readClosedChainArtifact(runDir, collectGenerationRelativePath),
          readClosedChainArtifact(runDir, evidenceAxesRelativePath),
          readClosedChainArtifact(runDir, priorAbsorptionMatrixRelativePath),
          readClosedChainArtifact(runDir, draftsRelativePath),
          readClosedChainArtifact(runDir, reviewsRelativePath),
          readClosedChainArtifact(runDir, probeShortlistRelativePath),
          readClosedChainArtifact(runDir, topicPortfolioRelativePath)
          ]);
        const artifactReadReasons = uniqueStrings(
          [
            gapMapRead,
            gapSynthesisRead,
            evidenceRead,
            corpusRead,
            collectGenerationRead,
            evidenceAxesRead,
            priorAbsorptionMatrixRead,
            hypothesesRead,
            draftsRead,
            reviewsRead,
            probeShortlistRead,
            portfolioRead
          ]
            .flatMap((read) => read.reasonCode ? [read.reasonCode] : [])
        );
        const gapEvidenceChain = buildResearchGapEvidenceChain({
          runId: run.id,
          researchCycle: run.graph.researchCycle,
          corpusRaw: corpusRead.raw ?? "",
          evidenceRaw: evidenceRead.raw ?? "",
          synthesisRaw: gapSynthesisRead.raw ?? "",
          collectGenerationRaw: collectGenerationRead.raw ?? ""
        });
        const sourceUpstreamValidation = validateResearchFunnelClosedChain({
          expectedRunId: run.id,
          expectedResearchCycle: run.graph.researchCycle,
          gapMapRaw: gapMapRead.raw,
          evidenceAxesRaw: evidenceAxesRead.raw,
          priorAbsorptionMatrixRaw: priorAbsorptionMatrixRead.raw,
          hypothesesRaw: hypothesesRead.raw,
          draftsRaw: draftsRead.raw,
          reviewsRaw: reviewsRead.raw,
          probeShortlistRaw: probeShortlistRead.raw,
          portfolioRaw: portfolioRead.raw,
          requireDecision: false,
          gapValidationContext: gapEvidenceChain.validationContext,
          gapValidationReasonCodes: gapEvidenceChain.reasonCodes
        });
        const generatedAt = new Date().toISOString();
        let portfolioRawForAuthorization = portfolioRead.raw;
        let topicMemoryRefresh:
          CurrentTopicMemoryPortfolioResolution | undefined;
        const topicMemoryIntegrityReasons: string[] = [];
        if (
          sourceUpstreamValidation.portfolioValidation.valid
          && sourceUpstreamValidation.portfolio
        ) {
          try {
            const currentLedger = loadCurrentTopicMemoryLedger(process.cwd());
            topicMemoryRefresh = rebaseTopicPortfolioToCurrentMemory({
              portfolio: sourceUpstreamValidation.portfolio,
              currentLedger
            });
            if (topicMemoryRefresh.valid && topicMemoryRefresh.portfolio) {
              portfolioRawForAuthorization =
                `${JSON.stringify(topicMemoryRefresh.portfolio, null, 2)}\n`;
              await writeRunArtifact(
                run,
                topicPortfolioRelativePath,
                portfolioRawForAuthorization
              );
            } else {
              topicMemoryIntegrityReasons.push(...topicMemoryRefresh.reasons);
            }
          } catch {
            topicMemoryIntegrityReasons.push(
              "topic_memory_current_head_load_failed"
            );
          }
        }
        const topicMemoryRefreshPayload = {
          schema_version: 1 as const,
          artifact_kind: "topic_memory_design_refresh" as const,
          generated_at: generatedAt,
          run_id: run.id,
          research_cycle: run.graph.researchCycle,
          source_portfolio_content_sha256:
            sourceUpstreamValidation.portfolio?.content_sha256,
          snapshot_relation: topicMemoryRefresh?.snapshot_relation || "invalid",
          snapshot_ledger_sha256:
            topicMemoryRefresh?.snapshot_ledger_sha256,
          current_ledger_sha256:
            topicMemoryRefresh?.current_ledger_sha256,
          refreshed_portfolio_content_sha256:
            topicMemoryRefresh?.portfolio?.content_sha256,
          candidate_decisions:
            topicMemoryRefresh?.candidate_decisions || [],
          valid: topicMemoryRefresh?.valid === true,
          reasons: uniqueStrings([
            ...(topicMemoryRefresh?.reasons || []),
            ...topicMemoryIntegrityReasons
          ])
        };
        await writeRunArtifact(
          run,
          topicMemoryRefreshRelativePath,
          `${JSON.stringify({
            ...topicMemoryRefreshPayload,
            content_sha256: hashCanonical(topicMemoryRefreshPayload)
          }, null, 2)}\n`
        );
        await runContextMemory.put(
          "design_experiments.topic_memory_refresh",
          topicMemoryRefreshPayload
        );
        const rebasedUpstreamValidation =
          topicMemoryRefresh?.valid && topicMemoryRefresh.portfolio
            ? validateResearchFunnelClosedChain({
                expectedRunId: run.id,
                expectedResearchCycle: run.graph.researchCycle,
                gapMapRaw: gapMapRead.raw,
                evidenceAxesRaw: evidenceAxesRead.raw,
                priorAbsorptionMatrixRaw: priorAbsorptionMatrixRead.raw,
                hypothesesRaw: hypothesesRead.raw,
                draftsRaw: draftsRead.raw,
                reviewsRaw: reviewsRead.raw,
                probeShortlistRaw: probeShortlistRead.raw,
                portfolioRaw: portfolioRawForAuthorization,
                requireDecision: false,
                gapValidationContext: gapEvidenceChain.validationContext,
                gapValidationReasonCodes: gapEvidenceChain.reasonCodes
              })
            : sourceUpstreamValidation;
        const upstreamValidation = {
          ...rebasedUpstreamValidation,
          valid:
            rebasedUpstreamValidation.valid
            && artifactReadReasons.length === 0
            && topicMemoryIntegrityReasons.length === 0,
          reasons: uniqueStrings([
            ...rebasedUpstreamValidation.reasons,
            ...artifactReadReasons,
            ...topicMemoryIntegrityReasons
          ])
        };
        const decision = buildTopicDecision({
          runId: run.id,
          researchCycle: run.graph.researchCycle,
          validation: upstreamValidation,
          generatedAt
        });
        const topicDecisionRaw = `${JSON.stringify(decision, null, 2)}\n`;
        await writeRunArtifact(run, topicDecisionRelativePath, topicDecisionRaw);
        const fullBaseValidation = validateResearchFunnelClosedChain({
          expectedRunId: run.id,
          expectedResearchCycle: run.graph.researchCycle,
          gapMapRaw: gapMapRead.raw,
          evidenceAxesRaw: evidenceAxesRead.raw,
          priorAbsorptionMatrixRaw: priorAbsorptionMatrixRead.raw,
          hypothesesRaw: hypothesesRead.raw,
          draftsRaw: draftsRead.raw,
          reviewsRaw: reviewsRead.raw,
          probeShortlistRaw: probeShortlistRead.raw,
          portfolioRaw: portfolioRawForAuthorization,
          decisionRaw: topicDecisionRaw,
          requireDecision: true,
          gapValidationContext: gapEvidenceChain.validationContext,
          gapValidationReasonCodes: gapEvidenceChain.reasonCodes
        });
        const validation = {
          ...fullBaseValidation,
          valid:
            fullBaseValidation.valid
            && artifactReadReasons.length === 0
            && topicMemoryIntegrityReasons.length === 0,
          probeAllowed:
            fullBaseValidation.probeAllowed
            && artifactReadReasons.length === 0
            && topicMemoryIntegrityReasons.length === 0,
          reasons: uniqueStrings([
            ...fullBaseValidation.reasons,
            ...artifactReadReasons,
            ...topicMemoryIntegrityReasons
          ])
        };
        await runContextMemory.put("design_experiments.probe_authorization_status", decision.disposition);
        await runContextMemory.put("design_experiments.probe_authorization", decision);

        if (!validation.probeAllowed) {
          const reasonCodes = uniqueStrings([
            ...decision.reason_codes,
            ...validation.reasons,
            ...(decision.reason_codes.length === 0 && validation.reasons.length === 0
              ? ["topic_probe_not_authorized"]
              : [])
          ]);
          const message =
            `Probe authorization blocked experiment-design entry: ${reasonCodes.join(", ")}. ` +
            "Regenerate and independently review a 5-7 candidate portfolio spanning at least 3 evidence-axis clusters before requesting a bounded execution probe.";
          emitLog(message);
          await runContextMemory.put("design_experiments.probe_authorization_blocked", true);
          await runContextMemory.put("design_experiments.probe_authorization_blocked_reason", message);
          return {
            status: "success",
            summary: message,
            needsApproval: true,
            toolCallsUsed: 0,
            transitionRecommendation: {
              action: "backtrack_to_hypotheses",
              sourceNode: "design_experiments",
              targetNode: hypothesisBacktrackTarget,
              reason: message,
              confidence: 0.98,
              autoExecutable: true,
              evidence: [
                topicPortfolioRelativePath,
                topicMemoryRefreshRelativePath,
                topicDecisionRelativePath,
                ...reasonCodes
              ],
              suggestedCommands: [`/agent run ${hypothesisBacktrackTarget} ${run.id}`],
              generatedAt
            }
          };
        }

        approvedCandidateIds = validation.approvedCandidateIds;
        validatedPortfolio = validation.portfolio;
        if (successorRouteTarget && validatedPortfolio) {
          const portfolioTargetValidation =
            validateTopicProbeSuccessorPortfolioTarget({
              routeTarget: successorRouteTarget,
              candidates: validatedPortfolio.candidates
            });
          if (!portfolioTargetValidation.valid) {
            const message =
              `Successor portfolio violates its governed route target: ${portfolioTargetValidation.reasons.join(", ")}`;
            emitLog(message);
            return {
              status: "failure",
              error: message,
              summary: message,
              toolCallsUsed: 0
            };
          }
        }
        if (successorRouteTarget?.target_candidate) {
          const matchedCandidate = validatedPortfolio?.candidates.find(
            (candidate) =>
              candidate.source_candidate_id
                === successorRouteTarget.target_candidate?.source_candidate_id
              && candidate.topic_id
                === successorRouteTarget.target_candidate?.topic_id
          );
          if (!matchedCandidate) {
            const message =
              "Successor design target is absent from the validated child portfolio.";
            emitLog(message);
            return {
              status: "failure",
              error: message,
              summary: message,
              toolCallsUsed: 0
            };
          }
          const targetValidation = validateTopicProbeSuccessorDesignTarget({
            routeTarget: successorRouteTarget,
            candidate: matchedCandidate
          });
          if (
            !targetValidation.valid
            || !isTopicProbeSuccessorDesignCandidate(matchedCandidate)
          ) {
            const message =
              `Successor design target drifted from its governed candidate: ${targetValidation.reasons.join(", ")}`;
            emitLog(message);
            return {
              status: "failure",
              error: message,
              summary: message,
              toolCallsUsed: 0
            };
          }
          successorDesignCandidate = matchedCandidate;
          approvedCandidateIds = [
            successorDesignCandidate.source_candidate_id
          ];
        }
        await runContextMemory.put("design_experiments.probe_authorization_blocked", false);
        emitLog(
          `Probe authorization passed for ${approvedCandidateIds.length} bounded execution candidate(s) from a complete closed artifact chain; no final paper topic was selected.`
        );
      } else {
        await runContextMemory.put("design_experiments.probe_authorization_status", "not_applicable");
        await runContextMemory.put("design_experiments.probe_authorization_blocked", false);
        emitLog("Declared hypothesis-test mode bypasses topic-portfolio probe authorization.");
        if (successorRouteTarget) {
          const targetCandidate = successorRouteTarget.target_candidate;
          if (!targetCandidate) {
            const message =
              "Hypothesis-test successor is missing its frozen target candidate.";
            emitLog(message);
            return {
              status: "failure",
              error: message,
              summary: message,
              toolCallsUsed: 0
            };
          }
          const targetValidation = validateTopicProbeSuccessorDesignTarget({
            routeTarget: successorRouteTarget,
            candidate: targetCandidate
          });
          if (
            !targetValidation.valid
            || !isTopicProbeSuccessorDesignCandidate(targetCandidate)
          ) {
            const message =
              `Hypothesis-test successor target is invalid: ${targetValidation.reasons.join(", ")}`;
            emitLog(message);
            return {
              status: "failure",
              error: message,
              summary: message,
              toolCallsUsed: 0
            };
          }
          successorDesignCandidate = targetCandidate;
        }
      }

      const explorationConfig = resolveExplorationConfig({
        workspaceRoot: process.cwd(),
        appConfig: deps.config
      });
      if (explorationConfig.enabled) {
        const explorationManager = new ExplorationManager(
          run.id,
          buildWorkspaceRunRoot(process.cwd(), run.id),
          explorationConfig
        );
        await explorationManager.initialize();
      }

      const constraintProfile = await resolveConstraintProfile({
        run,
        runContextMemory,
        llm: deps.llm,
        eventStream: deps.eventStream,
        node: "design_experiments"
      });
      const runObjectiveMetricProfile = await resolveObjectiveMetricProfile({
        run,
        runContextMemory,
        llm: deps.llm,
        eventStream: deps.eventStream,
        node: "design_experiments"
      });

      const parsedHypotheses = parseHypotheses(hypothesesRead.raw || "");
      const hypotheses = successorDesignCandidate
        ? [buildDesignHypothesisFromTopicCandidate(successorDesignCandidate)]
        : approvedCandidateIds
          ? selectApprovedHypotheses(parsedHypotheses, approvedCandidateIds)
          : parsedHypotheses;
      if (hypotheses.length === 0) {
        const message = researchMode === "topic_discovery"
          ? "No closed-chain-approved hypotheses were found for experiment design. Regenerate the hypothesis artifacts and topic decision."
          : "No valid hypotheses were found for experiment design. Generate hypotheses first or repair hypotheses.jsonl.";
        emitLog(message);
        return {
          status: "failure",
          error: message,
          summary: message,
          toolCallsUsed: 0
        };
      }
      const filtered = filterDesignHypotheses(hypotheses);
      if (filtered.dropped.length > 0) {
        emitLog(
          `Filtered ${filtered.dropped.length} weak hypothesis/hypotheses before experiment design; keeping ${filtered.kept.length}.`
        );
      }

      const activeHypothesis = filtered.kept[0];
      if (!activeHypothesis) {
        const message = researchMode === "topic_discovery"
          ? "No hypothesis passed the design-quality gate for an active bounded probe."
          : "No hypothesis passed the experiment design-quality gate.";
        emitLog(message);
        return { status: "failure", error: message, summary: message, toolCallsUsed: 0 };
      }
      const deferredHypotheses: FilteredHypothesis[] = researchMode === "topic_discovery"
        ? filtered.kept.slice(1).map((hypothesis) => ({
            hypothesis_id: hypothesis.hypothesis_id,
            text: hypothesis.text,
            reason: "Deferred until the currently bound topic probe is resolved."
          }))
        : [];
      let activeProbeContract: ActiveTopicProbeContract | undefined;
      let boundActiveHypothesis = activeHypothesis;
      if (researchMode === "topic_discovery") {
        const activeCandidateId = activeHypothesis.candidate_id?.trim();
        if (!activeCandidateId) {
          const message = "The active topic-probe hypothesis does not declare a candidate_id.";
          emitLog(message);
          return { status: "failure", error: message, summary: message, toolCallsUsed: 0 };
        }
        const portfolioCandidate = validatedPortfolio?.candidates.find(
          (candidate) => candidate.source_candidate_id === activeCandidateId
        );
        if (!validatedPortfolio || !portfolioCandidate) {
          const message = "The active hypothesis is not bound to a validated topic-portfolio candidate.";
          emitLog(message);
          return { status: "failure", error: message, summary: message, toolCallsUsed: 0 };
        }
        if (successorRouteTarget) {
          const targetValidation = validateTopicProbeSuccessorDesignTarget({
            routeTarget: successorRouteTarget,
            candidate: portfolioCandidate
          });
          if (!targetValidation.valid) {
            const message =
              `Selected successor design violates its governed route target: ${targetValidation.reasons.join(", ")}`;
            emitLog(message);
            return {
              status: "failure",
              error: message,
              summary: message,
              toolCallsUsed: 0
            };
          }
        }
        try {
          activeProbeContract = buildActiveTopicProbeContract({
            runId: run.id,
            researchCycle: run.graph.researchCycle,
            researchMode,
            portfolioContentSha256: validatedPortfolio.content_sha256,
            candidate: portfolioCandidate,
            deferredCandidateIds: filtered.kept
              .slice(1)
              .map((hypothesis) => hypothesis.candidate_id?.trim())
              .filter((candidateId): candidateId is string => Boolean(candidateId))
          });
        } catch (error) {
          const message = `Active topic-probe contract could not be built: ${String(error)}`;
          emitLog(message);
          return { status: "failure", error: message, summary: message, toolCallsUsed: 0 };
        }
        const activeProbeValidation = validateActiveTopicProbeContract(
          JSON.stringify(activeProbeContract),
          {
            expectedRunId: run.id,
            expectedResearchCycle: run.graph.researchCycle,
            portfolio: validatedPortfolio
          }
        );
        if (!activeProbeValidation.valid) {
          const message =
            `Active topic-probe contract failed validation: ${activeProbeValidation.reasons.join(", ")}`;
          emitLog(message);
          return { status: "failure", error: message, summary: message, toolCallsUsed: 0 };
        }
        await writeRunArtifact(
          run,
          "design_experiments_panel/active_topic_probe_contract.json",
          `${JSON.stringify(activeProbeContract, null, 2)}\n`
        );
        await runContextMemory.put("design_experiments.active_topic_probe_contract", activeProbeContract);
        boundActiveHypothesis = {
          ...activeHypothesis,
          text: activeProbeContract.statement,
          primary_metric: activeProbeContract.primary_metric,
          metric_unit: activeProbeContract.metric_unit,
          metric_scale: activeProbeContract.metric_scale,
          metric_direction: activeProbeContract.metric_direction,
          effect_criterion: { ...activeProbeContract.effect_criterion },
          meaningful_effect: activeProbeContract.meaningful_effect,
          comparator: activeProbeContract.comparator,
          dataset_task_bench: activeProbeContract.dataset_task_bench,
          falsifier: activeProbeContract.falsifier,
          kill_signal: activeProbeContract.kill_signal,
          local_budget: activeProbeContract.local_budget
        };
      }
      if (researchMode === "topic_discovery" && !activeProbeContract) {
        const message =
          "Topic probe contract is incomplete: primary_metric, metric_unit, metric_scale, metric_direction, comparator, and effect_criterion are required before experiment design.";
        emitLog(message);
        return { status: "failure", error: message, summary: message, toolCallsUsed: 0 };
      }
      const activeHypotheses = researchMode === "topic_discovery"
        ? [boundActiveHypothesis]
        : filtered.kept;
      const candidateObjectiveContract =
        activeProbeContract ?? successorDesignCandidate;
      const objectiveMetricProfile = candidateObjectiveContract
        ? buildCandidateObjectiveMetricProfile(
            candidateObjectiveContract,
            runObjectiveMetricProfile
          )
        : runObjectiveMetricProfile;
      if (candidateObjectiveContract) {
        await writeRunArtifact(
          run,
          "design_experiments_panel/candidate_objective_profile.json",
          `${JSON.stringify(objectiveMetricProfile, null, 2)}\n`
        );
        await runContextMemory.put(
          "design_experiments.candidate_objective_profile",
          objectiveMetricProfile
        );
      }

      if (deferredHypotheses.length > 0) {
        emitLog(
          `Bound candidate ${activeHypothesis.candidate_id} for this probe and deferred ${deferredHypotheses.length} other authorized candidate(s).`
        );
      }

      const retryContext = await loadDesignRetryContext(run.id);
      if (retryContext) {
        emitLog(
          `Loaded design retry context from prior results: pilot_size=${retryContext.previous_pilot_size ?? "unknown"}, repeats=${retryContext.previous_repeats ?? "unknown"}, objective_status=${retryContext.previous_objective_status ?? "unknown"}.`
        );
        await writeRunArtifact(
          run,
          "design_experiments_panel/retry_context.json",
          `${JSON.stringify(retryContext, null, 2)}\n`
        );
        await runContextMemory.put("design_experiments.retry_context", retryContext);
      }

      emitLog(
        researchMode === "topic_discovery"
          ? `Designing experiment variants for active probe candidate ${activeHypothesis.candidate_id}.`
          : `Designing experiment variants from ${activeHypotheses.length} declared hypothesis/hypotheses.`
      );
      const design = await designExperimentsFromHypotheses({
        llm: deps.llm,
        runTitle: run.title,
        runTopic: researchMode === "topic_discovery" ? activeHypothesis.text : run.topic,
        objectiveMetric: objectiveMetricProfile.raw,
        hypotheses: activeHypotheses,
        constraintProfile,
        objectiveProfile: objectiveMetricProfile,
        retryContext,
        candidateCount: 3,
        onProgress: emitLog
      });
      const normalizedCandidates = design.candidates.map(normalizeCandidateProtocolGuardrails);
      const budgetTimeoutSec = resolveDesignBudgetTimeoutSec(deps.config.experiments?.timeout_sec);
      const panelResult = runDesignExperimentsPanel({
        candidates: normalizedCandidates,
        objectiveProfile: objectiveMetricProfile,
        evidenceStage: researchMode === "topic_discovery" ? "bounded_probe" : "confirmatory",
        requireExecutableEstimator: researchMode === "topic_discovery"
      });

      await writeRunArtifact(
        run,
        "design_experiments_panel/candidates.json",
        `${JSON.stringify(normalizedCandidates, null, 2)}\n`
      );
      await writeRunArtifact(
        run,
        "design_experiments_panel/reviews.json",
        `${JSON.stringify(panelResult.reviews, null, 2)}\n`
      );
      await writeRunArtifact(
        run,
        "design_experiments_panel/selection.json",
        `${JSON.stringify(panelResult.selection, null, 2)}\n`
      );
      await runContextMemory.put("design_experiments.panel_selection", panelResult.selection);
      if (panelResult.selection.mode === "all_blocked_fallback") {
        const blockedCandidates = panelResult.selection.scores.filter((score) => score.blocked_by.length > 0);
        const blockingReviewers = uniqueStrings(
          blockedCandidates.flatMap((score) => score.blocked_by.map((reviewer) => String(reviewer)))
        );
        const estimatorProtocolBlockedCandidateIds = new Set(
          panelResult.reviews
            .filter(
              (review) =>
                review.reviewer_id === "statistical_reviewer"
                && review.hard_block
                && review.findings.some((finding) =>
                  finding.startsWith("Executable estimator protocol is invalid:")
                )
            )
            .map((review) => review.candidate_id)
        );
        const retryDesignForEstimatorProtocol =
          researchMode === "topic_discovery"
          && normalizedCandidates.every((candidate) =>
            estimatorProtocolBlockedCandidateIds.has(candidate.id)
          );
        const message =
          `Experiment design panel blocked progression: all ${normalizedCandidates.length} candidate(s) were hard-blocked. ` +
          `Least-bad candidate "${panelResult.selected.title}" was preserved for inspection but is not approved for implementation handoff. ` +
          `Blocking reviewer(s): ${blockingReviewers.join(", ") || "unknown"}.` +
          (retryDesignForEstimatorProtocol
            ? " Regenerate the design with a complete executable estimator protocol."
            : "");
        emitLog(message);
        await runContextMemory.put("design_experiments.paper_scale_blocked", true);
        await runContextMemory.put("design_experiments.blocked_reason", message);
        const generatedAt = new Date().toISOString();
        return {
          status: "success",
          summary: message,
          needsApproval: true,
          toolCallsUsed: 1,
          transitionRecommendation: {
            action: retryDesignForEstimatorProtocol
              ? "retry_same"
              : "backtrack_to_hypotheses",
            sourceNode: "design_experiments",
            targetNode: retryDesignForEstimatorProtocol
              ? "design_experiments"
              : hypothesisBacktrackTarget,
            reason: message,
            confidence: retryDesignForEstimatorProtocol ? 0.99 : 0.9,
            autoExecutable: true,
            evidence: [
              "design_experiments_panel/candidates.json",
              "design_experiments_panel/reviews.json",
              "design_experiments_panel/selection.json",
              ...blockingReviewers.map((reviewer) => `blocking_reviewer:${reviewer}`)
            ],
            suggestedCommands: retryDesignForEstimatorProtocol
              ? [`/agent run design_experiments ${run.id}`]
              : [`/agent run ${hypothesisBacktrackTarget} ${run.id}`],
            generatedAt
          }
        };
      }
      const planYaml = buildPlanYaml({
        run: researchMode === "topic_discovery"
          ? { ...run, topic: activeHypothesis.text, objectiveMetric: objectiveMetricProfile.raw }
          : run,
        hypotheses: activeHypotheses,
        droppedHypotheses: [...filtered.dropped, ...deferredHypotheses],
        selected: panelResult.selected,
        candidates: normalizedCandidates,
        constraintProfile,
        objectiveProfile: objectiveMetricProfile,
        source: design.source,
        retryContext,
        budgetTimeoutSec
      });

      const outputPath = await writeRunArtifact(run, "experiment_plan.yaml", planYaml);
      await fs.access(outputPath);
      let comparisonContract: ReturnType<typeof buildExperimentComparisonContract>;
      try {
        comparisonContract = buildExperimentComparisonContract({
          run,
          selectedDesign: panelResult.selected,
          objectiveProfile: objectiveMetricProfile,
          ...(candidateObjectiveContract
            ? {
                topicProbe: {
                  candidateId: resolveCandidateContractId(
                    candidateObjectiveContract
                  ),
                  candidateContentSha256:
                    resolveCandidateContractContentSha256(
                      candidateObjectiveContract
                    ),
                  comparator: candidateObjectiveContract.comparator,
                  datasetTaskScope:
                    candidateObjectiveContract.dataset_task_bench
                }
              }
            : {}),
          managedBundleSupported: false,
          budgetTimeoutSec
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const message =
          `Experiment contract creation failed closed because the selected design diverged from its declared comparison or dataset/task scope: ${reason}`;
        emitLog(message);
        await runContextMemory.put("design_experiments.results_plan_blocked_reason", message);
        return {
          status: "failure",
          error: message,
          summary: message,
          toolCallsUsed: 0
        };
      }
      await storeExperimentGovernanceDecision(run, runContextMemory, {
        contract: comparisonContract,
        entries: []
      });
      const resultsPlanResolution = buildDesignResultsPlan({
        objectiveProfile: objectiveMetricProfile,
        comparisonContract
      });
      if (!resultsPlanResolution.ok) {
        const message = researchMode === "topic_discovery"
          ? `Probe authorization passed, but experiment contract creation was blocked: ${resultsPlanResolution.reason}`
          : `Experiment contract creation was blocked: ${resultsPlanResolution.reason}`;
        emitLog(message);
        await runContextMemory.put("design_experiments.results_plan_blocked_reason", message);
        return {
          status: "failure",
          error: message,
          summary: message,
          toolCallsUsed: 0
        };
      }
      const briefSections = rawBrief ? parseMarkdownRunBriefSections(rawBrief) : undefined;
      const briefCompleteness =
        (await runContextMemory.get<BriefCompletenessArtifact>("run_brief.completeness")) ??
        (rawBrief ? buildBriefCompletenessArtifact(rawBrief) : undefined);

      // --- Experiment contract: causal discipline artifact (Target 1+2) ---
      const selectedHypotheses = activeHypotheses.filter(
        (h) => panelResult.selected.hypothesis_ids.includes(h.hypothesis_id)
      );
      const hypothesisText = selectedHypotheses.map((h) => h.text).join("; ") || activeHypothesis.text;
      const experimentContract = buildExperimentContract({
        run,
        hypothesis: hypothesisText,
        causalMechanism: panelResult.selected.plan_summary,
        singleChange: deriveDesignSingleChange(panelResult.selected),
        additionalChanges: [],
        expectedMetricEffect: deriveDesignExpectedMetricEffect(
          objectiveMetricProfile.primaryMetric || objectiveMetricProfile.raw,
          panelResult.selected
        ),
        abortCondition: panelResult.selected.risks.length > 0
          ? `Abort only if this predeclared safety, validity, or resource risk materializes: ${panelResult.selected.risks[0]}`
          : "Abort only for a predeclared safety, validity, or resource-budget violation; do not stop based on observed effect direction.",
        keepOrDiscardRule:
          "Retain every contract-valid execution regardless of outcome direction; classify the primary comparison as supportive, non-supportive, or inconclusive under the frozen analysis protocol.",
        baselines: panelResult.selected.baselines,
        selectedDesign: {
          id: panelResult.selected.id,
          title: panelResult.selected.title,
          summary: panelResult.selected.plan_summary
        },
        evidenceCeiling: deriveDesignEvidenceCeiling(panelResult.selected),
        paperCeiling: deriveDesignPaperCeiling(panelResult.selected),
        resultsPlan: resultsPlanResolution.resultsPlan,
        briefRequiredBaselineCount: deriveBriefRequiredBaselineCount(briefSections)
      });
      const contractValidation = validateExperimentContract(experimentContract);
      if (researchMode === "topic_discovery") {
        await writeRunArtifact(
          run,
          ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH,
          `${JSON.stringify(experimentContract, null, 2)}\n`
        );
        await runContextMemory.put(
          "design_experiments.candidate_experiment_contract",
          experimentContract
        );
      }
      if (contractValidation.issues.length > 0) {
        emitLog(`Experiment contract notes: ${contractValidation.issues.join("; ")}`);
      }
      const blockingContractIssues = contractValidation.issues.filter((issue) =>
        /missing explicit baseline|invalid results_plan|results plan|potential confounding|confounded attempt/iu.test(issue)
      );
      if (blockingContractIssues.length > 0) {
        const message = `Experiment contract blocked before execution: ${blockingContractIssues.join("; ")}`;
        emitLog(message);
        return {
          status: "failure",
          error: message,
          summary: message,
          toolCallsUsed: 0
        };
      }
      if (researchMode === "topic_discovery") {
        let estimatorArtifacts;
        try {
          estimatorArtifacts = buildEstimatorFeasibilityArtifacts({
            runId: run.id,
            activeProbeSha256: activeProbeContract!.content_sha256,
            experimentContract,
            estimatorProtocol: panelResult.selected.estimator_protocol
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const message =
            `Experiment design estimator preflight could not be materialized: ${reason}. `
            + "The design must be regenerated before implementation.";
          emitLog(message);
          await runContextMemory.put(
            "design_experiments.estimator_feasibility_blocked_reason",
            message
          );
          return {
            status: "success",
            summary: message,
            needsApproval: true,
            toolCallsUsed: 1,
            transitionRecommendation: {
              action: "retry_same",
              sourceNode: "design_experiments",
              targetNode: "design_experiments",
              reason: message,
              confidence: 0.99,
              autoExecutable: true,
              evidence: [
                ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH,
                "design_experiments_panel/candidates.json",
                "design_experiments_panel/reviews.json",
                `estimator_preflight_error:${reason}`
              ],
              suggestedCommands: [`/agent run design_experiments ${run.id}`],
              generatedAt: new Date().toISOString()
            }
          };
        }
        await writeRunArtifact(
          run,
          ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH,
          `${JSON.stringify(estimatorArtifacts.contract, null, 2)}\n`
        );
        await writeRunArtifact(
          run,
          ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH,
          `${JSON.stringify(estimatorArtifacts.report, null, 2)}\n`
        );
        await runContextMemory.put(
          "design_experiments.estimator_feasibility_contract",
          estimatorArtifacts.contract
        );
        await runContextMemory.put(
          "design_experiments.estimator_feasibility_report",
          estimatorArtifacts.report
        );
        if (estimatorArtifacts.report.status !== "pass") {
          const reasonCodes = estimatorArtifacts.report.reason_codes;
          const message =
            "Experiment design estimator preflight blocked implementation: "
            + `${reasonCodes.join(", ") || "unknown_feasibility_failure"}. `
            + "The design must be regenerated with an identifiable, attainable comparison.";
          emitLog(message);
          await runContextMemory.put(
            "design_experiments.estimator_feasibility_blocked_reason",
            message
          );
          return {
            status: "success",
            summary: message,
            needsApproval: true,
            toolCallsUsed: 1,
            transitionRecommendation: {
              action: "retry_same",
              sourceNode: "design_experiments",
              targetNode: "design_experiments",
              reason: message,
              confidence: 0.99,
              autoExecutable: true,
              evidence: [
                ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH,
                ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH,
                ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH,
                ...reasonCodes.map((reason) => `estimator_reason:${reason}`)
              ],
              suggestedCommands: [`/agent run design_experiments ${run.id}`],
              generatedAt: new Date().toISOString()
            }
          };
        }
      }
      const evidenceAdequacyContract = panelResult.selected.estimator_protocol
        ? buildEvidenceAdequacyContractFromEstimatorProtocol({
            protocol: panelResult.selected.estimator_protocol,
            effectResolutionScale:
              experimentContract.results_plan.primary_effect_criterion
                ?.metric_scale
          })
        : undefined;
      if (
        evidenceAdequacyContract
        && experimentContract.results_plan.primary_comparison_id
          !== evidenceAdequacyContract.primary_comparison_id
      ) {
        const message =
          "Experiment design evidence contract is not bound to the results plan primary comparison: "
          + `results_plan=${experimentContract.results_plan.primary_comparison_id || "missing"}, `
          + `evidence_contract=${evidenceAdequacyContract.primary_comparison_id}.`;
        emitLog(message);
        return {
          status: "failure",
          error: message,
          summary: message,
          toolCallsUsed: 1
        };
      }
      await writeExperimentContract(run, experimentContract);
      if (evidenceAdequacyContract) {
        await writeRunArtifact(
          run,
          EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH,
          `${JSON.stringify(evidenceAdequacyContract, null, 2)}\n`
        );
        await runContextMemory.put(
          "design_experiments.evidence_adequacy_contract",
          evidenceAdequacyContract
        );
      } else {
        await fs.rm(
          path.join(
            process.cwd(),
            ".autolabos",
            "runs",
            run.id,
            EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH
          ),
          { force: true }
        );
        await runContextMemory.put(
          "design_experiments.evidence_adequacy_contract",
          null
        );
      }
      const experimentPortfolio = buildExperimentPortfolioFromDesign({
        runId: run.id,
        selectedDesign: panelResult.selected
      });
      await writeRunArtifact(
        run,
        "experiment_portfolio.json",
        `${JSON.stringify(experimentPortfolio, null, 2)}\n`
      );
      const clearedExecutionArtifacts = await clearExecutionSummaryArtifactsInvalidatedByDesign(
        path.join(process.cwd(), ".autolabos", "runs", run.id)
      );
      if (clearedExecutionArtifacts.length > 0) {
        emitLog(
          `Cleared ${clearedExecutionArtifacts.length} stale execution summary artifact(s) invalidated by the new experiment design.`
        );
      }

      // --- Baseline summary artifact (for review gate) ---
      const baselineSummary = buildBaselineSummary({
        selected: panelResult.selected,
        comparisonContract,
        experimentContract,
        objectiveMetric: objectiveMetricProfile.primaryMetric || objectiveMetricProfile.raw
      });
      await writeRunArtifact(
        run,
        "baseline_summary.json",
        `${JSON.stringify(baselineSummary, null, 2)}\n`
      );

      await runContextMemory.put("design_experiments.experiment_contract", experimentContract);
      await runContextMemory.put("design_experiments.portfolio", experimentPortfolio);

      // --- Brief-vs-design consistency check (Target 2) ---
      if (briefCompleteness) {
        await writeRunArtifact(
          run,
          "design_experiments_panel/brief_completeness.json",
          `${JSON.stringify(briefCompleteness, null, 2)}\n`
        );
        await runContextMemory.put("design_experiments.brief_completeness", briefCompleteness);
      }
      const consistencyResult = checkBriefDesignConsistency({
        briefSections: briefSections ?? undefined,
        briefCompleteness: briefCompleteness ?? undefined,
        experimentContract,
        designTitle: panelResult.selected.title,
        designBaselines: panelResult.selected.baselines,
        designMetrics: panelResult.selected.metrics
      });
      await writeRunArtifact(
        run,
        "design_experiments_panel/brief_design_consistency.json",
        `${JSON.stringify(consistencyResult, null, 2)}\n`
      );
      await runContextMemory.put("design_experiments.brief_design_consistency", consistencyResult);
      if (consistencyResult.warnings.length > 0) {
        const errors = consistencyResult.warnings.filter((w) => w.severity === "error");
        const warns = consistencyResult.warnings.filter((w) => w.severity === "warning");
        if (errors.length > 0) {
          emitLog(`Brief-design consistency: ${errors.length} error(s) — ${errors.map((e) => e.code).join(", ")}`);
        }
        if (warns.length > 0) {
          emitLog(`Brief-design consistency: ${warns.length} warning(s) — ${warns.map((w) => w.code).join(", ")}`);
        }
      }
      await runContextMemory.put("design_experiments.paper_scale_blocked", consistencyResult.paper_scale_blocked);
      if (rawBrief && consistencyResult.paper_scale_blocked) {
        const blockingCodes = consistencyResult.warnings
          .filter((warning) => warning.severity === "error")
          .map((warning) => warning.code)
          .join(", ");
        const error = `Brief contract blocked design progression: ${blockingCodes || "brief governance requirements not met"}.`;
        emitLog(error);
        return {
          status: "failure",
          error,
          summary: error,
          toolCallsUsed: 1
        };
      }

      await runContextMemory.put("design_experiments.primary", panelResult.selected.title);
      await runContextMemory.put("design_experiments.source", design.source);
      await runContextMemory.put("design_experiments.summary", design.summary);
      await runContextMemory.put("design_experiments.hypothesis_count", activeHypotheses.length);
      await runContextMemory.put("design_experiments.deferred_hypothesis_count", deferredHypotheses.length);
      await runContextMemory.put("design_experiments.filtered_out_count", filtered.dropped.length);
      const publicOutputs = await publishPublicRunOutputs({
        workspaceRoot: process.cwd(),
        run,
        node: "design_experiments",
        runContext: runContextMemory,
        section: "experiment",
        files: [
          {
            sourcePath: outputPath,
            targetRelativePath: "experiment_plan.yaml"
          },
          {
            sourcePath: path.join(process.cwd(), ".autolabos", "runs", run.id, "experiment_portfolio.json"),
            targetRelativePath: "experiment_portfolio.json",
            optional: true
          },
          {
            sourcePath: path.join(process.cwd(), ".autolabos", "runs", run.id, "baseline_summary.json"),
            targetRelativePath: "baseline_summary.json",
            optional: true
          },
          {
            sourcePath: path.join(
              process.cwd(),
              ".autolabos",
              "runs",
              run.id,
              EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH
            ),
            targetRelativePath: EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH,
            optional: !evidenceAdequacyContract
          },
          {
            sourcePath: path.join(process.cwd(), ".autolabos", "runs", run.id, "design_experiments_panel", "active_topic_probe_contract.json"),
            targetRelativePath: "active_topic_probe_contract.json",
            optional: researchMode !== "topic_discovery"
          },
          {
            sourcePath: path.join(process.cwd(), ".autolabos", "runs", run.id, ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH),
            targetRelativePath: "estimator_feasibility_contract.json",
            optional: researchMode !== "topic_discovery"
          },
          {
            sourcePath: path.join(process.cwd(), ".autolabos", "runs", run.id, ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH),
            targetRelativePath: "estimator_feasibility_report.json",
            optional: researchMode !== "topic_discovery"
          }
        ]
      });

      deps.eventStream.emit({
        type: "PLAN_CREATED",
        runId: run.id,
        node: "design_experiments",
        payload: {
          candidateCount: normalizedCandidates.length,
          selectedId: panelResult.selected.id,
          source: design.source,
          fallbackReason: design.fallbackReason
        }
      });

      emitLog(
        `Selected design "${panelResult.selected.title}" from ${normalizedCandidates.length} candidate(s) using ${design.source} with ${panelResult.selection.mode}.`
      );
      emitLog(`Public experiment outputs are available at ${publicOutputs.sectionDirRelative}.`);

      const selectionSummary = `Generated ${normalizedCandidates.length} executable experiment design candidate(s). Panel selected "${panelResult.selected.title}" via ${panelResult.selection.mode}.`;

      return {
        status: "success",
        summary: design.fallbackReason
          ? `${selectionSummary} Falling back after: ${design.fallbackReason}. Public outputs: ${publicOutputs.outputRootRelative}.`
          : `${selectionSummary} Public outputs: ${publicOutputs.outputRootRelative}.`,
        needsApproval: true,
        toolCallsUsed: 1
      };
    }
  };
}

async function readClosedChainArtifact(
  runDir: string,
  relativePath: string
): Promise<ClosedChainArtifactRead> {
  try {
    return { raw: await fs.readFile(path.join(runDir, relativePath), "utf8") };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? `:${error.code.toLowerCase()}`
        : "";
    return {
      reasonCode: `research_funnel_source_artifact_read_error:${relativePath}${code}`
    };
  }
}

function deriveBriefRequiredBaselineCount(briefSections?: MarkdownRunBriefSections): number | undefined {
  const text = [briefSections?.baselineComparator, briefSections?.targetComparison]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
  if (!text.trim()) {
    return undefined;
  }

  const numericMatches = [...text.matchAll(/\b(\d+)\s+(?:explicit\s+)?(?:baselines?|comparators?)\b/giu)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (numericMatches.length > 0) {
    return Math.max(...numericMatches);
  }

  if (/\b(?:two|pair(?:ed)?|double)\b[\s\S]{0,24}\b(?:baselines?|comparators?)\b/iu.test(text)) {
    return 2;
  }

  return 1;
}

function parseHypotheses(raw: string): ParsedDesignHypothesis[] {
  const items: Array<ParsedDesignHypothesis | undefined> = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        const parsed = JSON.parse(line) as DesignInputHypothesis & ParsedDesignHypothesis;
        const candidateId = typeof parsed.candidate_id === "string" ? parsed.candidate_id.trim() : "";
        if (typeof parsed.text !== "string" || !parsed.text.trim()) {
          return undefined;
        }
        return {
          hypothesis_id: parsed.hypothesis_id || `h_${index + 1}`,
          ...(candidateId ? { candidate_id: candidateId } : {}),
          ...(typeof parsed.run_id === "string" ? { run_id: parsed.run_id } : {}),
          ...(typeof parsed.research_cycle === "number" ? { research_cycle: parsed.research_cycle } : {}),
          ...(Array.isArray(parsed.supported_gap_ids)
            ? {
                supported_gap_ids: parsed.supported_gap_ids.filter(
                  (item): item is string => typeof item === "string"
                )
              }
            : {}),
          text: parsed.text,
          score: parsed.score,
          evidence_links: parsed.evidence_links,
          groundedness: parsed.groundedness,
          causal_clarity: parsed.causal_clarity,
          falsifiability: parsed.falsifiability,
          experimentability: parsed.experimentability,
          measurement_specificity: parsed.measurement_specificity,
          measurement_signals: parsed.measurement_signals,
          measurement_hint: parsed.measurement_hint,
          boundary_condition: parsed.boundary_condition,
          gap_statement: parsed.gap_statement,
          closest_prior_non_overlap: parsed.closest_prior_non_overlap,
          reviewer_absorption_objection: parsed.reviewer_absorption_objection,
          comparator: parsed.comparator,
          dataset_task_bench: parsed.dataset_task_bench,
          primary_metric: parsed.primary_metric,
          metric_unit: parsed.metric_unit,
          metric_scale: parsed.metric_scale,
          metric_direction: parsed.metric_direction,
          effect_criterion: parseEffectCriterion(parsed.effect_criterion),
          meaningful_effect: parsed.meaningful_effect,
          falsifier: parsed.falsifier,
          axis_ids: parsed.axis_ids,
          local_budget: parsed.local_budget,
          kill_signal: parsed.kill_signal,
          contribution_claim: parsed.contribution_claim,
          minimum_publishable_evidence: parsed.minimum_publishable_evidence,
          limitation_reflection: parsed.limitation_reflection,
          measurement_readiness: parsed.measurement_readiness,
          critique_summary: parsed.critique_summary
        };
      } catch {
        return undefined;
      }
    });
  return items.filter(
    (item): item is ParsedDesignHypothesis => item !== undefined && Boolean(item.text)
  );
}

function buildDesignHypothesisFromTopicCandidate(
  candidate: TopicProbeSuccessorDesignCandidate
): ParsedDesignHypothesis {
  return {
    hypothesis_id:
      `successor_target_${candidate.content_sha256.slice(0, 12)}`,
    candidate_id: candidate.source_candidate_id,
    supported_gap_ids: [...candidate.supported_gap_ids],
    text: candidate.statement,
    score: candidate.scores.testability,
    evidence_links: [...candidate.evidence_links],
    axis_ids: [...candidate.cluster_ids],
    groundedness: 4,
    causal_clarity: 4,
    falsifiability: 4,
    experimentability: 4,
    measurement_specificity: 4,
    measurement_signals: [
      candidate.primary_metric,
      "uncertainty_interval"
    ],
    measurement_hint:
      `Compare ${candidate.primary_metric} against ${candidate.comparator} under the frozen scope.`,
    gap_statement: candidate.gap_statement,
    closest_prior_non_overlap: candidate.closest_prior_non_overlap,
    reviewer_absorption_objection: candidate.reviewer_absorption_objection,
    comparator: candidate.comparator,
    dataset_task_bench: candidate.dataset_task_bench,
    primary_metric: candidate.primary_metric,
    metric_unit: candidate.metric_unit,
    metric_scale: candidate.metric_scale,
    metric_direction: candidate.metric_direction,
    effect_criterion: { ...candidate.effect_criterion },
    meaningful_effect: candidate.meaningful_effect,
    falsifier: candidate.falsifier,
    local_budget: candidate.local_budget,
    kill_signal: candidate.kill_signal,
    contribution_claim: candidate.contribution_claim,
    minimum_publishable_evidence: candidate.minimum_publishable_evidence,
    limitation_reflection: 4,
    measurement_readiness: 4,
    critique_summary:
      "This hypothesis is frozen by the validated successor route target."
  };
}

function selectApprovedHypotheses(
  hypotheses: ParsedDesignHypothesis[],
  approvedCandidateIds: string[]
): ParsedDesignHypothesis[] {
  const byCandidateId = new Map(
    hypotheses.flatMap((item) => item.candidate_id ? [[item.candidate_id, item] as const] : [])
  );
  return approvedCandidateIds.flatMap((candidateId) => {
    const hypothesis = byCandidateId.get(candidateId);
    return hypothesis ? [hypothesis] : [];
  });
}

function deriveDesignSingleChange(candidate: ExperimentDesignCandidate): string {
  const explicit = candidate.single_change?.trim();
  if (explicit) {
    return explicit;
  }
  return candidate.title.replace(/^\s*plan\s+\d+\s*:\s*/iu, "").trim() || candidate.title;
}


export type DesignResultsPlanResolution =
  | { ok: true; resultsPlan: ResultsPlanV2 }
  | { ok: false; reason: string };

export function buildDesignResultsPlan(input: {
  objectiveProfile: ObjectiveMetricProfile;
  comparisonContract: ReturnType<typeof buildExperimentComparisonContract>;
}): DesignResultsPlanResolution {
  const candidateBinding = readCandidateObjectiveProfileBinding(input.objectiveProfile);
  const metricId = (
    candidateBinding?.primary_metric
    || input.objectiveProfile.primaryMetric
  )?.trim();
  if (!metricId) {
    return {
      ok: false,
      reason: "the objective profile does not declare a primary metric identifier"
    };
  }
  const direction = candidateBinding?.metric_direction || input.objectiveProfile.direction;
  if (direction !== "maximize" && direction !== "minimize") {
    return {
      ok: false,
      reason: `the objective profile does not declare a direction for metric "${metricId}"`
    };
  }
  const topicProbeBinding = input.comparisonContract.topic_probe_binding;
  if (topicProbeBinding) {
    if (!candidateBinding) {
      return {
        ok: false,
        reason: "the topic-probe comparison contract is missing its candidate objective binding"
      };
    }
    if (
      candidateBinding.candidate_id !== topicProbeBinding.candidate_id
      || candidateBinding.comparator !== topicProbeBinding.declared_comparator
    ) {
      return {
        ok: false,
        reason: "the topic-probe treatment or comparator diverges from the selected candidate contract"
      };
    }
  }
  const subjectSeriesId = topicProbeBinding?.subject_series_id
    || `${input.comparisonContract.plan_id.trim()}:primary`;
  if (!subjectSeriesId) {
    return {
      ok: false,
      reason: "the comparison contract does not declare a primary series identifier"
    };
  }
  const baselineSeriesIds = uniqueStrings(input.comparisonContract.baseline_candidate_ids);
  if (baselineSeriesIds.length === 0) {
    return {
      ok: false,
      reason: "the comparison contract does not declare a baseline series identifier"
    };
  }
  if (
    topicProbeBinding
    && (
      baselineSeriesIds.length !== 1
      || baselineSeriesIds[0] !== topicProbeBinding.reference_series_id
    )
  ) {
    return {
      ok: false,
      reason: "the topic-probe comparison contract does not preserve its exact reference identifier"
    };
  }
  const declaredReferenceId =
    topicProbeBinding?.reference_series_id
    || input.comparisonContract.objective_profile.comparison?.baselineId?.trim()
    || input.objectiveProfile.comparison?.baselineId?.trim();
  const frozenComparison = input.comparisonContract.objective_profile.comparison;
  if (
    topicProbeBinding
    && (
      frozenComparison?.candidateId !== topicProbeBinding.subject_series_id
      || frozenComparison?.baselineId !== topicProbeBinding.reference_series_id
      || frozenComparison?.metricKey !== metricId
    )
  ) {
    return {
      ok: false,
      reason: "the frozen topic-probe comparison does not preserve its treatment, reference, and metric identifiers"
    };
  }
  const primaryReferenceSeriesId = topicProbeBinding
    ? topicProbeBinding.reference_series_id
    : baselineSeriesIds.length === 1
      ? baselineSeriesIds[0]
      : declaredReferenceId
        ? baselineSeriesIds.find((id) => matchesDeclaredSeriesId(id, declaredReferenceId))
        : undefined;
  if (!primaryReferenceSeriesId) {
    return {
      ok: false,
      reason: "multiple baseline series are declared but the objective profile does not bind one primary reference identifier"
    };
  }
  const metricDefinition = {
    id: metricId,
    label: metricId,
    direction: direction === "minimize" ? ("lower_better" as const) : ("higher_better" as const),
    ...((candidateBinding?.metric_unit || input.objectiveProfile.unit)?.trim()
      ? { unit: (candidateBinding?.metric_unit || input.objectiveProfile.unit)!.trim() }
      : {})
  };
  const requiredSeries: NonNullable<ResultsPlanV2["required_series"]> = [
    { id: subjectSeriesId, role: "primary" },
    ...baselineSeriesIds.map((id) => ({ id, role: "baseline" as const }))
  ];
  const requiredComparisons: NonNullable<ResultsPlanV2["required_comparisons"]> =
    topicProbeBinding
      ? [{
          id: topicProbeBinding.primary_comparison_id,
          subject_series_id: topicProbeBinding.subject_series_id,
          reference_series_id: topicProbeBinding.reference_series_id,
          metric_id: metricId,
          scope: { ...topicProbeBinding.observation_scope }
        }]
      : baselineSeriesIds.map((referenceSeriesId) => ({
          id: `${subjectSeriesId}__vs__${referenceSeriesId}`,
          subject_series_id: subjectSeriesId,
          reference_series_id: referenceSeriesId,
          metric_id: metricId
        }));
  const primaryComparison = requiredComparisons.find(
    (comparison) => comparison.reference_series_id === primaryReferenceSeriesId
  )!;
  return {
    ok: true,
    resultsPlan: {
      schema_version: RESULTS_ARTIFACT_SCHEMA_VERSION,
      required_metrics: [metricDefinition],
      minimum_series_count: requiredSeries.length,
      minimum_comparison_count: requiredComparisons.length,
      required_series: requiredSeries,
      required_comparisons: requiredComparisons,
      primary_comparison_id: primaryComparison.id,
      ...(candidateBinding
        ? {
            primary_effect_criterion: {
              comparison_id: primaryComparison.id,
              metric_id: candidateBinding.primary_metric,
              metric_scale: candidateBinding.metric_scale,
              direction: candidateBinding.metric_direction,
              effect_criterion: { ...candidateBinding.effect_criterion }
            }
          }
        : {})
    }
  };
}

function matchesDeclaredSeriesId(seriesId: string, declaredId: string): boolean {
  if (seriesId === declaredId) return true;
  const normalizedDeclared = declaredId
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalizedDeclared.length > 0 && seriesId.endsWith(`:${normalizedDeclared}`);
}
function deriveDesignExpectedMetricEffect(
  objectiveMetric: string,
  candidate: ExperimentDesignCandidate
): string {
  const metric = objectiveMetric || candidate.metrics[0] || "the primary metric";
  const baselines = candidate.baselines.join(", ") || "the declared baseline(s)";
  return "Measure " + metric + " relative to " + baselines + "; keep the interpretation bounded to the observed direction and uncertainty.";
}

function normalizeCandidateProtocolGuardrails(candidate: ExperimentDesignCandidate): ExperimentDesignCandidate {
  const thresholdPercent = detectPracticalThresholdPercent(candidate);
  if (thresholdPercent === undefined) {
    return candidate;
  }

  const normalizedSummary = normalizePracticalThresholdLanguage(candidate.plan_summary, thresholdPercent);
  const normalizedEvaluationSteps = uniqueStrings(
    candidate.evaluation_steps.map((item) => normalizePracticalThresholdLanguage(item, thresholdPercent))
  );
  const normalizedRisks = uniqueStrings(
    candidate.risks.filter((item) => !isMissingPracticalThresholdRisk(item))
  );
  const normalizedResourceNotes = uniqueStrings([
    ...candidate.resource_notes,
    `Pre-registered runtime and memory guardrail: no more than ${thresholdPercent}% above the matched baseline.`
  ]);

  return {
    ...candidate,
    plan_summary: normalizedSummary,
    evaluation_steps: normalizedEvaluationSteps,
    risks: normalizedRisks,
    resource_notes: normalizedResourceNotes
  };
}

function detectPracticalThresholdPercent(candidate: ExperimentDesignCandidate): number | undefined {
  const sources = [candidate.plan_summary, ...candidate.evaluation_steps, ...candidate.risks, ...candidate.resource_notes];
  for (const source of sources) {
    const explicitMatch = source.match(/predefined practical threshold(?: such as)?\s+(\d+(?:\.\d+)?)\s*percent/iu);
    if (explicitMatch) {
      return Number(explicitMatch[1]);
    }
    const numericGuardrail = source.match(/runtime(?: or memory)? by more than\s+(\d+(?:\.\d+)?)\s*percent/iu);
    if (numericGuardrail) {
      return Number(numericGuardrail[1]);
    }
  }
  return undefined;
}

function normalizePracticalThresholdLanguage(text: string, thresholdPercent: number): string {
  return text
    .replace(
      /by more than a predefined practical threshold such as \d+(?:\.\d+)? percent/giu,
      `by more than ${thresholdPercent}% relative to the matched baseline`
    )
    .replace(
      /by more than a predefined practical threshold/giu,
      `by more than ${thresholdPercent}% relative to the matched baseline`
    )
    .replace(
      /predefined practical threshold such as \d+(?:\.\d+)? percent/giu,
      `${thresholdPercent}% relative to the matched baseline`
    )
    .replace(
      /predefined practical threshold/giu,
      `${thresholdPercent}% relative to the matched baseline`
    );
}

function isMissingPracticalThresholdRisk(text: string): boolean {
  return /practical threshold on runtime increase must be specified before analysis to avoid post hoc interpretation/iu.test(
    text
  );
}

function buildPlanYaml(args: {
  run: { id: string; topic: string; objectiveMetric: string; constraints: string[] };
  hypotheses: DesignInputHypothesis[];
  droppedHypotheses: FilteredHypothesis[];
  selected: ExperimentDesignCandidate;
  candidates: ExperimentDesignCandidate[];
  constraintProfile: Awaited<ReturnType<typeof resolveConstraintProfile>>;
  objectiveProfile: Awaited<ReturnType<typeof resolveObjectiveMetricProfile>>;
  source: "llm" | "fallback";
  retryContext?: DesignRetryContext;
  budgetTimeoutSec: number;
}): string {
  const collectDefaults = args.constraintProfile.collect;
  const paperProfile = args.constraintProfile.writing;
  const candidateObjective = readCandidateObjectiveProfileBinding(args.objectiveProfile);
  const objectiveRaw = args.objectiveProfile.raw.trim() || args.run.objectiveMetric;

  return [
    `run_id: ${args.run.id}`,
    `topic: "${escapeQuote(args.run.topic)}"`,
    "objective:",
    `  metric: "${escapeQuote(objectiveRaw)}"`,
    `  discovery_metric: "${escapeQuote(args.run.objectiveMetric)}"`,
    `  primary_metric: "${escapeQuote(args.objectiveProfile.primaryMetric || "unspecified")}"`,
    `  observed_metric: "${escapeQuote(candidateObjective?.primary_metric || args.objectiveProfile.primaryMetric || "unspecified")}"`,
    `  metric_unit: "${escapeQuote(args.objectiveProfile.unit || "unspecified")}"`,
    `  metric_scale: "${escapeQuote(args.objectiveProfile.scale || "unspecified")}"`,
    `  target_unit: "${escapeQuote(args.objectiveProfile.targetUnit || "unspecified")}"`,
    `  target_scale: "${escapeQuote(args.objectiveProfile.targetScale || "unspecified")}"`,
    `  direction: "${escapeQuote(args.objectiveProfile.direction || "unspecified")}"`,
    `  threshold_operator: "${escapeQuote(args.objectiveProfile.comparator || "unspecified")}"`,
    `  reference: "${escapeQuote(candidateObjective?.comparator || args.objectiveProfile.comparison?.baselineId || "unspecified")}"`,
    `  target: "${escapeQuote(args.objectiveProfile.targetDescription || "observe and improve")}"`,
    ...(candidateObjective
      ? [
          "  effect_criterion:",
          `    basis: "${escapeQuote(candidateObjective.effect_criterion.basis)}"`,
          `    magnitude: ${candidateObjective.effect_criterion.magnitude}`,
          `    scale: "${escapeQuote(candidateObjective.effect_criterion.scale)}"`,
          `    inclusive: ${candidateObjective.effect_criterion.inclusive ? "true" : "false"}`
        ]
      : []),
    "constraints:",
    "  raw:",
    ...renderYamlStringList(args.run.constraints, 2),
    "  collect_defaults:",
    ...renderYamlKeyValueObject(
      {
        last_years: collectDefaults.lastYears,
        open_access_pdf: collectDefaults.openAccessPdf,
        min_citation_count: collectDefaults.minCitationCount,
        publication_types: collectDefaults.publicationTypes
      },
      2
    ),
    "  writing_defaults:",
    ...renderYamlKeyValueObject(
      {
        target_venue: paperProfile.targetVenue,
        tone_hint: paperProfile.toneHint,
        length_hint: paperProfile.lengthHint
      },
      2
    ),
    "  experiment_guidance:",
    ...renderYamlKeyValueObject(
      {
        profile_source: args.constraintProfile.source,
        objective_profile_source: args.objectiveProfile.source,
        design_source: args.source
      },
      2
    ),
    "  design_notes:",
    ...renderYamlStringList(args.constraintProfile.experiment.designNotes, 2),
    "  implementation_notes:",
    ...renderYamlStringList(args.constraintProfile.experiment.implementationNotes, 2),
    "  evaluation_notes:",
    ...renderYamlStringList(args.constraintProfile.experiment.evaluationNotes, 2),
    "  assumptions:",
    ...renderYamlStringList(args.constraintProfile.assumptions, 2),
    "hypotheses:",
    ...args.hypotheses.map((item) => `  - "${escapeQuote(item.text)}"`),
    "hypothesis_filter:",
    `  retained_count: ${args.hypotheses.length}`,
    `  dropped_count: ${args.droppedHypotheses.length}`,
    "  candidate_measurement_contract_bound: true",
    "dropped_hypotheses:",
    ...renderDroppedHypotheses(args.droppedHypotheses),
    "retry_context:",
    `  present: ${args.retryContext ? "true" : "false"}`,
    ...(args.retryContext
      ? renderYamlKeyValueObject(
          {
            previous_selected_design_title: args.retryContext.previous_selected_design_title,
            previous_pilot_size: args.retryContext.previous_pilot_size,
            previous_repeats: args.retryContext.previous_repeats,
            registered_pilot_size: args.retryContext.registered_pilot_size,
            registered_repeats: args.retryContext.registered_repeats,
            previous_primary_metric_name: args.retryContext.previous_primary_metric_name,
            previous_primary_metric_value: args.retryContext.previous_primary_metric_value,
            previous_baseline_name: args.retryContext.previous_baseline_name,
            previous_objective_status: args.retryContext.previous_objective_status,
            implementation_failure: args.retryContext.implementation_failure,
            transition_action: args.retryContext.transition_action,
            transition_reason: args.retryContext.transition_reason,
            run_verifier_failure_code: args.retryContext.run_verifier_failure_code,
            run_verifier_repair_target: args.retryContext.run_verifier_repair_target,
            run_verifier_recommended_backtrack_node: args.retryContext.run_verifier_recommended_backtrack_node,
            run_verifier_upstream_repair_hint: args.retryContext.run_verifier_upstream_repair_hint,
            run_verifier_operator_action_required: args.retryContext.run_verifier_operator_action_required
          },
          1
        )
      : []),
    "  retry_directives:",
    ...renderYamlStringList(args.retryContext?.retry_directives || [], 2),
    "selected_hypothesis_ids:",
    ...renderYamlStringList(args.selected.hypothesis_ids, 1),
    "selected_design:",
    `  id: "${escapeQuote(args.selected.id)}"`,
    `  title: "${escapeQuote(args.selected.title)}"`,
    `  summary: "${escapeQuote(args.selected.plan_summary)}"`,
    ...renderCompatibilitySelectedDesignSection(args.selected),
    "shortlisted_designs:",
    ...renderShortlistedDesigns(args.candidates),
    "execution:",
    "  container: local",
    `  timeout_sec: ${args.budgetTimeoutSec}`
  ].join("\n");
}

function resolveDesignBudgetTimeoutSec(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(1, Math.floor(numeric)) : 1800;
}

function renderCompatibilitySelectedDesignSection(selected: ExperimentDesignCandidate): string[] {
  return [
    "  datasets:",
    ...renderYamlStringList(selected.datasets, 2),
    `  primary_metric: "${escapeQuote(selected.primary_metric)}"`,
    "  metrics:",
    ...renderYamlStringList(selected.metrics, 2),
    "  baselines:",
    ...renderYamlStringList(selected.baselines, 2),
    "  implementation_notes:",
    ...renderYamlStringList(selected.implementation_notes, 2),
    "  evaluation_steps:",
    ...renderYamlStringList(selected.evaluation_steps, 2),
    "  risks:",
    ...renderYamlStringList(selected.risks, 2),
    "  resource_notes:",
    ...renderYamlStringList(selected.resource_notes, 2)
  ];
}

function renderShortlistedDesigns(candidates: ExperimentDesignCandidate[]): string[] {
  if (candidates.length === 0) {
    return ['  - "none"'];
  }
  const lines: string[] = [];
  for (const candidate of candidates) {
    lines.push(`  - id: "${escapeQuote(candidate.id)}"`);
    lines.push(`    title: "${escapeQuote(candidate.title)}"`);
    lines.push(`    summary: "${escapeQuote(candidate.plan_summary)}"`);
  }
  return lines;
}

async function loadDesignRetryContext(runId: string): Promise<DesignRetryContext | undefined> {
  const runDir = path.join(".autolabos", "runs", runId);
  const [
    resultRaw,
    transitionRaw,
    runRecordRaw,
    runVerifierRaw,
    panelReviewsRaw,
    estimatorReportRaw
  ] = await Promise.all([
    safeRead(path.join(runDir, "result_analysis.json")),
    safeRead(path.join(runDir, "transition_recommendation.json")),
    safeRead(path.join(runDir, "run_record.json")),
    safeRead(path.join(runDir, "run_experiments_verify_report.json")),
    safeRead(path.join(runDir, "design_experiments_panel", "reviews.json")),
    safeRead(path.join(runDir, ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH))
  ]);
  if (
    !resultRaw
    && !transitionRaw
    && !runRecordRaw
    && !runVerifierRaw
    && !panelReviewsRaw
    && !estimatorReportRaw
  ) {
    return undefined;
  }

  const resultAnalysis = parseJsonRecord(resultRaw);
  const transition = parseJsonRecord(transitionRaw);
  const runRecord = parseJsonRecord(runRecordRaw);
  const runVerifier = parseJsonRecord(runVerifierRaw);
  const panelReviews = parseJsonRecordArray(panelReviewsRaw);
  const estimatorReport = parseJsonRecord(estimatorReportRaw);
  const transitionAction = stringValue(transition?.action);
  const transitionTarget = stringValue(transition?.targetNode);
  if (transitionAction && transitionAction !== "backtrack_to_design" && transitionTarget && transitionTarget !== "design_experiments") {
    return undefined;
  }

  const metrics = recordValue(resultAnalysis?.metrics);
  const scope = recordValue(metrics?.scope);
  const primaryMetric = recordValue(metrics?.primary_metric);
  const objectiveMetric = recordValue(resultAnalysis?.objective_metric);
  const objectiveEvaluation = recordValue(objectiveMetric?.evaluation);
  const planContext = recordValue(resultAnalysis?.plan_context);
  const selectedDesign = recordValue(planContext?.selected_design);
  const nodeStates = recordValue(recordValue(runRecord?.graph)?.nodeStates);
  const implementationNode = recordValue(nodeStates?.implement_experiments);
  const implementationFailure = stringValue(implementationNode?.lastError) || stringValue(implementationNode?.note);
  const runVerifierStatus = stringValue(runVerifier?.status);
  const runVerifierFailed = runVerifierStatus === "fail";
  const runVerifierFailureCode = runVerifierFailed ? stringValue(runVerifier?.failure_code) : undefined;
  const runVerifierRepairTarget = runVerifierFailed ? stringValue(runVerifier?.repair_target) : undefined;
  const runVerifierRecommendedBacktrackNode = runVerifierFailed
    ? stringValue(runVerifier?.recommended_backtrack_node)
    : undefined;
  const runVerifierUpstreamRepairHint = runVerifierFailed ? stringValue(runVerifier?.upstream_repair_hint) : undefined;
  const runVerifierOperatorActionRequired = runVerifierFailed
    ? booleanValue(runVerifier?.operator_action_required)
    : undefined;
  const estimatorFailureReasons =
    stringValue(estimatorReport?.status) === "blocked"
      ? stringArrayValue(estimatorReport?.reason_codes)
      : [];
  const panelBlockFindings = panelReviews
    .filter((review) => booleanValue(review.hard_block) === true)
    .flatMap((review) => stringArrayValue(review.findings) ?? []);

  const context: DesignRetryContext = {
    previous_selected_design_title: stringValue(selectedDesign?.title),
    previous_pilot_size: numberValue(scope?.pilot_size),
    previous_repeats: numberValue(scope?.repeats),
    registered_pilot_size: numberValue(scope?.registered_pilot_size),
    registered_repeats: numberValue(scope?.registered_repeats),
    previous_primary_metric_name: stringValue(primaryMetric?.name),
    previous_primary_metric_value: numberValue(primaryMetric?.value),
    previous_baseline_name: stringValue(primaryMetric?.baseline_name),
    previous_objective_status: stringValue(objectiveEvaluation?.status) || inferObjectiveStatus(primaryMetric?.value),
    implementation_failure: stringValue(implementationNode?.status) === "failed" ? implementationFailure : undefined,
    transition_action: transitionAction,
    transition_reason: stringValue(transition?.reason),
    transition_evidence: stringArrayValue(transition?.evidence),
    run_verifier_failure_code: runVerifierFailureCode,
    run_verifier_repair_target: runVerifierRepairTarget,
    run_verifier_recommended_backtrack_node: runVerifierRecommendedBacktrackNode,
    run_verifier_upstream_repair_hint: runVerifierUpstreamRepairHint,
    run_verifier_operator_action_required: runVerifierOperatorActionRequired,
    retry_directives: buildRetryDirectives({
      previousPilotSize: numberValue(scope?.pilot_size),
      previousRepeats: numberValue(scope?.repeats),
      registeredPilotSize: numberValue(scope?.registered_pilot_size),
      registeredRepeats: numberValue(scope?.registered_repeats),
      previousPrimaryMetricName: stringValue(primaryMetric?.name),
      previousPrimaryMetricValue: numberValue(primaryMetric?.value),
      previousBaselineName: stringValue(primaryMetric?.baseline_name),
      implementationFailure: stringValue(implementationNode?.status) === "failed" ? implementationFailure : undefined,
      runVerifierFailureCode,
      runVerifierRepairTarget,
      runVerifierUpstreamRepairHint,
      runVerifierOperatorActionRequired,
      estimatorFailureReasons,
      panelBlockFindings
    })
  };

  return context.retry_directives.length > 0 || context.transition_reason || context.transition_evidence?.length || context.run_verifier_failure_code || context.run_verifier_repair_target
    ? context
    : undefined;
}

function buildRetryDirectives(args: {
  previousPilotSize?: number;
  previousRepeats?: number;
  registeredPilotSize?: number;
  registeredRepeats?: number;
  previousPrimaryMetricName?: string;
  previousPrimaryMetricValue?: number;
  previousBaselineName?: string;
  implementationFailure?: string;
  runVerifierFailureCode?: string;
  runVerifierRepairTarget?: string;
  runVerifierUpstreamRepairHint?: string;
  runVerifierOperatorActionRequired?: boolean;
  estimatorFailureReasons?: string[];
  panelBlockFindings?: string[];
}): string[] {
  const directives: string[] = [];
  if (
    typeof args.previousPilotSize === "number" &&
    args.previousPilotSize <= 1 &&
    typeof args.previousRepeats === "number" &&
    args.previousRepeats <= 1
  ) {
    directives.push("Do not repeat a bounded-local design with pilot_size=1 and repeats=1.");
    directives.push("Use at least tens of examples and repeated runs in the next bounded local pilot if the workstation budget allows it.");
  }
  if (
    typeof args.registeredPilotSize === "number" &&
    typeof args.previousPilotSize === "number" &&
    args.registeredPilotSize > args.previousPilotSize
  ) {
    directives.push("Move the next bounded local branch materially closer to the registered pilot scope while keeping the run locally executable.");
  }
  if (
    typeof args.previousPrimaryMetricValue === "number" &&
    args.previousPrimaryMetricValue <= 0
  ) {
    directives.push(
      `Revise the treatment or stopping policy because the previous ${args.previousPrimaryMetricName || "primary metric"} did not improve over ${args.previousBaselineName || "the locked baseline"}.`
    );
  }
  if (args.implementationFailure) {
    directives.push("Repair the failed implementation handoff before broadening the experiment: require a tiny executable entrypoint, helper-module decomposition, and metrics-payload validation before repeated-condition expansion.");
  }
  if (
    args.runVerifierFailureCode === "model_dependency_unavailable" ||
    args.runVerifierRepairTarget === "environment_dependency"
  ) {
    directives.push(
      "Do not repeat a design that depends on an unavailable model/tokenizer asset; select an explicitly available local dependency or mark the run dependency-blocked before implementation."
    );
    if (args.runVerifierOperatorActionRequired) {
      directives.push("Treat the dependency repair as operator-gated until the required asset is prewarmed or the design selects a known available substitute.");
    }
    if (args.runVerifierUpstreamRepairHint) {
      directives.push(`Dependency repair hint: ${truncateRetryDirective(args.runVerifierUpstreamRepairHint)}`);
    }
  }
  if (
    args.panelBlockFindings?.some((finding) =>
      finding.startsWith("Executable estimator protocol is invalid:")
    )
  ) {
    directives.push(
      "Declare a complete executable estimator_protocol; do not leave its units, arms, pairing, denominator, estimand, estimator, power, resampling, or multiplicity fields implicit in prose."
    );
  }
  if ((args.estimatorFailureReasons?.length || 0) > 0) {
    directives.push(
      `Regenerate the design so estimator feasibility passes these prior blockers: ${uniqueStrings(args.estimatorFailureReasons || []).join(", ")}.`
    );
  }
  if (directives.length > 0) {
    directives.push("Keep the explicit comparator discipline and preserve the locked baselines unless there is direct evidence to replace them.");
  }
  return uniqueStrings(directives);
}

function parseJsonRecord(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return recordValue(parsed);
  } catch {
    return undefined;
  }
}

function parseJsonRecordArray(raw: string | undefined): Array<Record<string, unknown>> {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item)
        )
      : [];
  } catch {
    return [];
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function truncateRetryDirective(value: string, maxLength = 220): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function inferObjectiveStatus(metricValue: unknown): string | undefined {
  if (typeof metricValue !== "number" || !Number.isFinite(metricValue)) {
    return undefined;
  }
  if (metricValue > 0) {
    return "met";
  }
  if (metricValue < 0) {
    return "not_met";
  }
  return "inconclusive";
}

function renderDroppedHypotheses(items: FilteredHypothesis[]): string[] {
  if (items.length === 0) {
    return ['  - "none"'];
  }
  const lines: string[] = [];
  for (const item of items) {
    lines.push(`  - id: "${escapeQuote(item.hypothesis_id)}"`);
    lines.push(`    reason: "${escapeQuote(item.reason)}"`);
    lines.push(`    text: "${escapeQuote(item.text)}"`);
  }
  return lines;
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function escapeQuote(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"');
}

function renderYamlStringList(items: string[], indentLevel: number): string[] {
  const indent = "  ".repeat(indentLevel);
  if (items.length === 0) {
    return [`${indent}- "none"`];
  }
  return items.map((item) => `${indent}- "${escapeQuote(item)}"`);
}

function renderYamlKeyValueObject(
  obj: Record<string, string | number | boolean | string[] | undefined>,
  indentLevel: number
): string[] {
  const indent = "  ".repeat(indentLevel);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        continue;
      }
      lines.push(`${indent}${key}:`);
      for (const item of value) {
        lines.push(`${indent}  - "${escapeQuote(item)}"`);
      }
      continue;
    }
    if (typeof value === "boolean") {
      lines.push(`${indent}${key}: ${value ? "true" : "false"}`);
      continue;
    }
    if (typeof value === "number") {
      lines.push(`${indent}${key}: ${value}`);
      continue;
    }
    lines.push(`${indent}${key}: "${escapeQuote(value)}"`);
  }
  if (lines.length === 0) {
    return [`${indent}{}`];
  }
  return lines;
}

function filterDesignHypotheses(
  hypotheses: ParsedDesignHypothesis[]
): { kept: ParsedDesignHypothesis[]; dropped: FilteredHypothesis[] } {
  const scored = hypotheses.map((hypothesis) => {
    const qualityScore = computeHypothesisDesignQuality(hypothesis);
    const reason = explainHypothesisDrop(hypothesis, qualityScore);
    return { hypothesis, qualityScore, reason };
  });

  const kept = scored.filter((item) => !item.reason).map((item) => item.hypothesis);
  const dropped = scored
    .filter((item) => item.reason)
    .map((item) => ({
      hypothesis_id: item.hypothesis.hypothesis_id,
      text: item.hypothesis.text,
      reason: item.reason || "Dropped by quality gate."
    }));

  return { kept, dropped };
}

function buildCandidateObjectiveMetricProfile(
  contract: CandidateObjectiveContract,
  inherited: ObjectiveMetricProfile
): CandidateOwnedObjectiveMetricProfile {
  const binding = buildCandidateObjectiveProfileBinding({
    candidateId: resolveCandidateContractId(contract),
    primaryMetric: contract.primary_metric,
    metricUnit: contract.metric_unit,
    metricScale: contract.metric_scale,
    metricDirection: contract.metric_direction,
    comparator: contract.comparator,
    effectCriterion: contract.effect_criterion,
    objectiveRaw: contract.objective_raw
  });
  const thresholdOperator = objectiveComparatorForEffectCriterion(
    binding.metric_direction,
    binding.effect_criterion
  );
  const signedTarget = signedRawDeltaTargetForEffectCriterion(
    binding.metric_direction,
    binding.effect_criterion
  );
  const deltaMetricKey = candidateRawDeltaMetricKey(binding.primary_metric);
  const criterion = binding.effect_criterion;
  const targetDescription =
    `raw_delta(subject-reference) ${thresholdOperator} ${signedTarget} ${criterion.scale}`;
  const meaningfulEffect = contract.meaningful_effect?.trim();

  return {
    source: "heuristic_fallback",
    raw: binding.objective_raw,
    primaryMetric: deltaMetricKey,
    preferredMetricKeys: [deltaMetricKey],
    direction: binding.metric_direction,
    comparator: thresholdOperator,
    targetValue: signedTarget,
    targetDescription,
    unit: binding.metric_unit,
    scale: binding.metric_scale,
    targetUnit: binding.metric_unit,
    targetScale: criterion.scale,
    comparison: {
      baselineId: binding.comparator,
      candidateId: binding.candidate_id,
      metricKey: binding.primary_metric
    },
    resourceLimits: inherited.resourceLimits,
    analysisFocus: [
      `Measure ${binding.primary_metric} in ${binding.metric_unit} on the ${binding.metric_scale} scale.`,
      `Evaluate ${deltaMetricKey} as subject-reference and require ${thresholdOperator} ${signedTarget} after downstream scale conversion to ${criterion.scale}.`,
      ...(meaningfulEffect ? [`Human-readable context only: ${meaningfulEffect}`] : [])
    ],
    paperEmphasis: [
      `Report ${binding.primary_metric}, ${deltaMetricKey}, uncertainty, and the signed structured-effect threshold without substituting another objective.`
    ],
    assumptions: [
      "The active objective profile is derived from the hash-bound topic candidate contract rather than the broad discovery brief."
    ],
    candidate_contract: binding,
    delta_contract: {
      output_metric_key: deltaMetricKey,
      source_metric_key: binding.primary_metric,
      raw_delta_definition: "subject_minus_reference",
      comparator: thresholdOperator,
      signed_target: signedTarget
    }
  };
}

function resolveCandidateContractId(
  contract: CandidateObjectiveContract
): string {
  return "candidate_id" in contract
    ? contract.candidate_id
    : contract.source_candidate_id;
}

function resolveCandidateContractContentSha256(
  contract: CandidateObjectiveContract
): string {
  return "candidate_content_sha256" in contract
    ? contract.candidate_content_sha256
    : contract.content_sha256;
}
function computeHypothesisDesignQuality(hypothesis: DesignInputHypothesis): number {
  let score = (hypothesis.score ?? 0) / 2;
  score += hypothesis.groundedness ?? 0;
  score += hypothesis.causal_clarity ?? 0;
  score += hypothesis.falsifiability ?? 0;
  score += hypothesis.experimentability ?? 0;
  score += (hypothesis.measurement_specificity ?? 0) * 1.5;
  score += (hypothesis.measurement_signals?.length ?? 0) > 0 ? 1 : 0;
  score += hypothesis.measurement_hint ? 1 : 0;
  score += hypothesis.limitation_reflection ?? 0;
  score += hypothesis.measurement_readiness ?? 0;
  return score;
}

function explainHypothesisDrop(
  hypothesis: DesignInputHypothesis,
  qualityScore: number
): string | undefined {
  if (!hasStructuredHypothesisReview(hypothesis)) {
    return undefined;
  }

  const issues: string[] = [];
  if ((hypothesis.groundedness ?? 3) < 3) {
    issues.push("low groundedness");
  }
  if ((hypothesis.falsifiability ?? 3) < 3) {
    issues.push("weak falsifiability");
  }
  if ((hypothesis.experimentability ?? 3) < 3) {
    issues.push("weak experimentability");
  }
  if (typeof hypothesis.limitation_reflection === "number" && hypothesis.limitation_reflection < 3) {
    issues.push("limitations or counterexamples are not reflected");
  }
  if (typeof hypothesis.measurement_readiness === "number" && hypothesis.measurement_readiness < 3) {
    issues.push("measurement plan is not operationalized");
  }

  if ((hypothesis.measurement_specificity ?? 0) < 3) {
    issues.push("candidate outcome is underspecified");
  }
  if ((hypothesis.measurement_signals?.length ?? 0) === 0) {
    issues.push("no measurement signal");
  }
  if (!hypothesis.measurement_hint) {
    issues.push("no executable measurement hint");
  }

  if (qualityScore < 15) {
    issues.push("overall design quality below threshold");
  }

  if (issues.length === 0) {
    return undefined;
  }

  return issues.join("; ");
}

function deriveDesignEvidenceCeiling(design: ExperimentDesignCandidate): string | undefined {
  const candidates = [
    design.plan_summary,
    ...design.implementation_notes,
    ...design.evaluation_steps,
    ...design.resource_notes,
    ...design.risks
  ];
  const matched = candidates
    .map((value) => value.trim())
    .find((value) =>
      /\b(pilot ceiling|evidence ceiling|claim ceiling|paper-ready|not sufficient|not make a paper-ready|interaction claim|no-interaction ceiling|no-signal|fallback design)\b/iu.test(
        value
      )
    );
  return normalizeDesignCeiling(matched);
}

function normalizeDesignCeiling(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (/\bfallback design\b/iu.test(value)) {
    return "Fallback-generated design only; require review-node confirmation before paper-ready claims or downstream execution.";
  }
  if (/\bpaper-ready\b/iu.test(value) && /\bif\b/iu.test(value)) {
    return "Bounded condition-sweep evidence only; do not present as paper-ready without complete executed attempts, uncertainty reporting, and confirmatory reruns.";
  }
  if (/\bdoes not support\b|\bnot sufficient\b|\bnot make a paper-ready\b|\binteraction claim\b/iu.test(value)) {
    return "Bounded condition-sweep evidence only; do not infer interactions or broad tuning rules without confirmatory evidence.";
  }
  return value;
}

function deriveDesignPaperCeiling(design: ExperimentDesignCandidate): string | undefined {
  const evidenceCeiling = deriveDesignEvidenceCeiling(design);
  if (evidenceCeiling) {
    return evidenceCeiling;
  }
  const titleAndSummary = `${design.title}\n${design.plan_summary}`;
  if (/\bpilot\b/iu.test(titleAndSummary)) {
    return "Pilot evidence only; do not present as a paper-ready experimental interaction claim without confirmatory evidence.";
  }
  return undefined;
}

export interface BaselineSummary {
  baseline_conditions: Array<{ name: string; rationale: string }>;
  treatment_conditions: Array<{ name: string; description: string }>;
  comparison_metric: string;
  justification: string;
}

export function buildBaselineSummary(input: {
  selected: ExperimentDesignCandidate;
  comparisonContract: ReturnType<typeof buildExperimentComparisonContract>;
  experimentContract: ReturnType<typeof buildExperimentContract>;
  objectiveMetric: string;
}): BaselineSummary {
  const baselines = input.selected.baselines ?? [];
  const baselineConditions = baselines.length > 0
    ? baselines.map((b) => ({
        name: b,
        rationale: `Baseline condition from selected design: ${input.selected.title}`
      }))
    : [{
        name: "(no explicit baseline)",
        rationale: "Design did not specify an explicit baseline condition."
      }];

  const treatmentConditions = [{
    name: input.selected.title,
    description: input.selected.plan_summary || input.selected.title
  }];

  return {
    baseline_conditions: baselineConditions,
    treatment_conditions: treatmentConditions,
    comparison_metric: input.objectiveMetric,
    justification: input.experimentContract.expected_metric_effect
      || `Evaluate ${input.objectiveMetric} across baseline and treatment conditions.`
  };
}

function hasStructuredHypothesisReview(hypothesis: DesignInputHypothesis): boolean {
  return (
    typeof hypothesis.groundedness === "number" ||
    typeof hypothesis.causal_clarity === "number" ||
    typeof hypothesis.falsifiability === "number" ||
    typeof hypothesis.experimentability === "number" ||
    typeof hypothesis.measurement_specificity === "number" ||
    typeof hypothesis.limitation_reflection === "number" ||
    typeof hypothesis.measurement_readiness === "number" ||
    Boolean(hypothesis.measurement_hint) ||
    Boolean(hypothesis.critique_summary) ||
    (hypothesis.measurement_signals?.length ?? 0) > 0
  );
}
