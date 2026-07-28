import { createHash } from "node:crypto";
import path from "node:path";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { appendJsonl, appendJsonlItems, safeRead, writeRunArtifact } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import { RunRecord } from "../../types.js";
import {
  generateHypothesesFromEvidence,
  HypothesisCandidate,
  type HypothesisGenerationGovernance
} from "../analysis/researchPlanning.js";
import {
  bindResearchGapMapArtifact,
  buildResearchFunnelArtifactBinding,
  buildTopicPortfolio,
  resolveSupportedGapIds,
  validateResearchFunnelClosedChain
} from "../researchFunnel.js";
import {
  buildResearchGapEvidenceChain,
  type ResearchGapEvidenceRow
} from "../analysis/researchGapEvidenceChain.js";
import {
  buildPriorAbsorptionCandidateContract,
  buildPriorAbsorptionAssessmentPrompt,
  buildPriorAbsorptionMatrix,
  parsePriorAbsorptionAssessmentResponse,
  validatePriorAbsorptionMatrixArtifact,
  type PriorAbsorptionAssessment,
  type PriorAbsorptionMatrix
} from "../priorAbsorption.js";
import {
  buildCandidatePriorSearchPlan,
  validateCandidatePriorSearchPlanIntegrity,
  validateCandidatePriorSearchReceipt,
  type CandidatePriorSearchPlan,
  type CandidatePriorSearchReceipt
} from "../candidatePriorSearch.js";
import { parseMarkdownRunBriefSections } from "../runs/runBriefParser.js";
import {
  loadResearchBriefSnapshot,
  resolveResearchRunModeGuard
} from "../runs/researchRunModeGuard.js";
import {
  parseTopicProbeComputeBudgetCeilingFromBrief,
  type TopicProbeComputeBudgetLimits
} from "../topicProbeComputeBudget.js";
import {
  buildTopicMemoryDatabasePath,
  TopicMemoryStore
} from "../runs/topicMemoryStore.js";
import { hashCanonical } from "../canonicalHash.js";
import type { TopicMemoryLedger } from "../topicMemory.js";

export interface GenerateHypothesesRequest {
  topK: number;
  branchCount: number;
}

type EvidenceRow = ResearchGapEvidenceRow;

const DEFAULT_TOP_K = 2;
const DEFAULT_BRANCH_COUNT = 6;
const HYPOTHESIS_PROGRESS_STATUS_ARTIFACT = "hypothesis_generation/status.json";
const HYPOTHESIS_PROGRESS_LOG_ARTIFACT = "hypothesis_generation/progress.jsonl";
const HYPOTHESIS_HARD_GATE_REJECTIONS_ARTIFACT =
  "hypothesis_generation/hard_gate_rejections.json";

const PRIOR_ABSORPTION_MATRIX_ARTIFACT =
  "hypothesis_generation/prior_absorption_matrix.json";
const TOPIC_MEMORY_AUDIT_ARTIFACT =
  "hypothesis_generation/topic_memory_audit.json";
const CANDIDATE_PRIOR_SEARCH_PLAN_ARTIFACT =
  "hypothesis_generation/candidate_prior_search_plan.json";
const CANDIDATE_PRIOR_SEARCH_DECISION_ARTIFACT =
  "hypothesis_generation/candidate_prior_search_decision.json";
const COLLECT_CANDIDATE_PRIOR_SEARCH_PLAN_ARTIFACT =
  "collect_candidate_prior_search_plan.json";
const COLLECT_CANDIDATE_PRIOR_SEARCH_RECEIPT_ARTIFACT =
  "collect_candidate_prior_search_receipt.json";
const MAX_CANDIDATE_PRIOR_SEARCH_ROUNDS = 2;
const CANDIDATE_PRIOR_SEARCH_PER_LANE_LIMIT = 4;
const TOPIC_MEMORY_PROMPT_RECORD_LIMIT = 40;
export function createGenerateHypothesesNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "generate_hypotheses",
    async execute({ run, abortSignal }) {
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
          "generate_hypotheses blocked because the persisted research mode and evidence lineage do not agree: "
          + researchModeGuard.reasons.join(", ");
        return {
          status: "failure",
          error,
          summary: error,
          toolCallsUsed: 0
        };
      }
      const researchMode = researchModeGuard.effectiveMode;
      let topicMemoryLedger: TopicMemoryLedger | undefined;
      if (researchMode === "topic_discovery") {
        try {
          const store = new TopicMemoryStore(
            buildTopicMemoryDatabasePath(process.cwd())
          );
          try {
            topicMemoryLedger = store.loadLedger();
          } finally {
            store.close();
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const message =
            "Hypothesis generation blocked because project topic memory could not be validated: "
            + reason;
          return {
            status: "failure",
            error: message,
            summary: message,
            toolCallsUsed: 0
          };
        }
      }
      const briefSections = parseMarkdownRunBriefSections(rawBrief || "");
      const evidencePath = path.join(".autolabos", "runs", run.id, "evidence_store.jsonl");
      const gapMapRelativePath = "analysis/gap_map.json";
      const gapMapPath = path.join(".autolabos", "runs", run.id, gapMapRelativePath);
      const gapSynthesisRelativePath = "analysis/gap_synthesis.json";
      const gapSynthesisPath = path.join(".autolabos", "runs", run.id, gapSynthesisRelativePath);
      const corpusPath = path.join(".autolabos", "runs", run.id, "corpus.jsonl");
      const generationPath = path.join(".autolabos", "runs", run.id, "collect_generation.json");
      const [evidenceRaw, corpusRaw, gapMapRaw, gapSynthesisRaw, generationRaw] = await Promise.all([
        safeRead(evidencePath),
        safeRead(corpusPath),
        safeRead(gapMapPath),
        safeRead(gapSynthesisPath),
        safeRead(generationPath)
      ]);
      const gapEvidenceChain = buildResearchGapEvidenceChain({
        runId: run.id,
        researchCycle: run.graph.researchCycle,
        corpusRaw,
        evidenceRaw,
        synthesisRaw: gapSynthesisRaw,
        collectGenerationRaw: generationRaw
      });
      const evidenceRows = gapEvidenceChain.evidenceRows;
      const collectAttemptId = gapEvidenceChain.collectAttemptId;
      const gapSynthesis = researchMode === "topic_discovery"
        ? gapEvidenceChain.synthesisArtifact
        : undefined;
      const gapMapBinding = bindResearchGapMapArtifact(gapMapRaw, {
        runId: run.id,
        researchCycle: run.graph.researchCycle,
        collectAttemptId: collectAttemptId ?? "",
        corpusSha256: gapEvidenceChain.corpusSha256,
        corpusByteLength: gapEvidenceChain.corpusByteLength,
        evidenceSha256: gapEvidenceChain.evidenceSha256,
        evidenceByteLength: gapEvidenceChain.evidenceByteLength,
        evidence: evidenceRows,
        reviewedClusters: gapSynthesis?.accepted_clusters.map((cluster) => ({
          statement: cluster.statement,
          evidence_ids: cluster.evidence_ids,
          opportunity_type: cluster.opportunity_type
        })),
        requireExternalEvidence: researchMode === "topic_discovery",
        requireReviewedSynthesis: researchMode === "topic_discovery",
        synthesisArtifactValid: researchMode !== "topic_discovery" || Boolean(gapSynthesis),
        expectedSynthesisContentSha256: gapSynthesis?.content_sha256,
        expectedSynthesisSemanticsVersion: gapSynthesis?.semantics_version,
        expectedAnalysisComplete: researchMode === "topic_discovery" ? true : undefined
      });
      const boundGapMapRaw = gapMapBinding.raw || "";
      const gapMapValidation = gapMapBinding.validation;
      const evidenceById = new Map(evidenceRows.map((item) => [item.evidence_id || "", item] as const));
      const paperTitlesById = parseCorpusTitleMap(corpusRaw);
      const request = normalizeGenerateHypothesesRequest(
        await runContextMemory.get<{ topK?: unknown; branchCount?: unknown }>("generate_hypotheses.request")
      );
      const planningObjectiveMetric = researchMode === "topic_discovery" ? "" : run.objectiveMetric;
      let computeBudgetCeiling: TopicProbeComputeBudgetLimits | undefined;
      try {
        computeBudgetCeiling = resolveBriefComputeBudgetCeiling(
          researchMode,
          rawBrief
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const message =
          "Hypothesis generation blocked because the topic-discovery brief "
          + `does not provide a valid compute ceiling: ${reason}`;
        return {
          status: "failure",
          error: message,
          summary: message,
          toolCallsUsed: 0
        };
      }
      const governance: HypothesisGenerationGovernance = {
        researchMode,
        constraints: run.constraints,
        objectiveRule: briefSections?.objectiveMetric,
        researchQuestionRule: briefSections?.researchQuestion,
        smallExperimentRule: briefSections?.whySmallExperiment,
        comparatorRule: briefSections?.baselineComparator,
        datasetTaskRule: briefSections?.datasetTaskBench,
        targetComparisonRule: briefSections?.targetComparison,
        minimumEvidenceRule: briefSections?.minimumAcceptableEvidence,
        disallowedShortcutsRule: briefSections?.disallowedShortcuts,
        allowedPassesRule: briefSections?.allowedBudgetedPasses,
        paperCeilingRule: briefSections?.paperCeiling,
        failureConditionsRule: briefSections?.failureConditions,
        computeBudgetCeiling,
        topicMemory: topicMemoryLedger
          ? {
              ledger_sha256: topicMemoryLedger.ledger_sha256,
              killed_formulations: topicMemoryLedger.records
                .slice(-TOPIC_MEMORY_PROMPT_RECORD_LIMIT)
                .map((record) => ({
                  record_sha256: record.record_sha256,
                  kill_scope: record.kill_scope,
                  disposition_category: record.disposition_category,
                  public_reason_codes: [...record.public_reason_codes],
                  contribution_object: record.descriptor.contribution_object,
                  method_mechanism: record.descriptor.method_mechanism,
                  data_task_scope: record.descriptor.data_task_scope,
                  evaluation_protocol: record.descriptor.evaluation_protocol,
                  claim_ceiling: record.descriptor.claim_ceiling,
                  source_full_text_evidence_ids: [
                    ...record.source_full_text_evidence_ids
                  ]
                }))
            }
          : undefined,
        reviewedGapContracts: gapMapValidation.valid
          ? gapMapValidation.gapMap?.gaps
              .filter((gap) => gap.epistemic_status === "supported_candidate")
              .map((gap) => ({
                gap_id: gap.gap_id,
                opportunity_type: gap.opportunity_type,
                statement: gap.statement,
                evidence_links: [...gap.evidence_links]
              }))
          : undefined
      };
      await runContextMemory.put("generate_hypotheses.request", request);
      await runContextMemory.put("generate_hypotheses.research_mode", researchMode);
      const weakEvidenceCount = evidenceRows.filter((item) => isWeakEvidenceSeed(item)).length;
      const startedAt = new Date().toISOString();
      let progressCount = 0;
      let progressQueue: Promise<void> = Promise.resolve();

      await writeHypothesisProgressStatus(run, runContextMemory, {
        status: "running",
        stage: "preflight",
        message: `Loaded ${evidenceRows.length} evidence item(s) for hypothesis generation.`,
        startedAt,
        updatedAt: startedAt,
        evidenceCount: evidenceRows.length,
        weakEvidenceCount,
        request,
        progressCount
      });

      const queueProgressUpdate = (text: string) => {
        const updatedAt = new Date().toISOString();
        const stage = classifyHypothesisProgressStage(text);
        const currentCount = progressCount + 1;
        progressCount = currentCount;
        progressQueue = progressQueue.then(async () => {
          await appendJsonlItems(run, HYPOTHESIS_PROGRESS_LOG_ARTIFACT, [
            {
              index: currentCount,
              timestamp: updatedAt,
              stage,
              message: text
            }
          ]);
          await writeHypothesisProgressStatus(run, runContextMemory, {
            status: "running",
            stage,
            message: text,
            startedAt,
            updatedAt,
            evidenceCount: evidenceRows.length,
            weakEvidenceCount,
            request,
            progressCount: currentCount
          });
        });
      };

      const flushProgressUpdates = async () => {
        await progressQueue;
      };

      const emitLog = (text: string) => {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "generate_hypotheses",
          payload: { text }
        });
        queueProgressUpdate(text);
      };

      const independentGapSupportPresent = Boolean(
        gapMapValidation.valid &&
        gapMapValidation.gapMap?.gaps.some(
          (gap) => gap.epistemic_status === "supported_candidate"
        )
      );
      if (
        researchMode === "topic_discovery" &&
        (!gapMapValidation.valid || !independentGapSupportPresent)
      ) {
        const gapReasons = gapMapValidation.valid
          ? ["research_gap_map_independent_support_missing"]
          : gapMapValidation.reasons;
        const message =
          "Hypothesis generation blocked before model planning because the topic-discovery research gap map " +
          `is not ready: ${gapReasons.join(", ")}.`;
        emitLog(message);
        await flushProgressUpdates();
        await runContextMemory.put("generate_hypotheses.top_k", 0);
        await runContextMemory.put("generate_hypotheses.candidate_count", 0);
        await runContextMemory.put("generate_hypotheses.source", "blocked_research_gap_preflight");
        await runContextMemory.put("generate_hypotheses.pipeline", "research_gap_map");
        await runContextMemory.put("generate_hypotheses.summary", message);
        await writeHypothesisProgressStatus(run, runContextMemory, {
          status: "failed",
          stage: "research_gap_map",
          message,
          startedAt,
          updatedAt: new Date().toISOString(),
          evidenceCount: evidenceRows.length,
          weakEvidenceCount,
          request,
          progressCount,
          pipeline: "research_gap_map",
          candidateCount: 0,
          probeCandidateCount: 0,
          artifactPaths: [
            HYPOTHESIS_PROGRESS_STATUS_ARTIFACT,
            HYPOTHESIS_PROGRESS_LOG_ARTIFACT,
            ...(boundGapMapRaw.trim() ? [gapMapRelativePath] : [])
          ]
        });
        return {
          status: "failure",
          summary: message,
          error: message,
          toolCallsUsed: 0
        };
      }

      if (evidenceRows.length === 0) {
        const message =
          "No evidence is available for hypothesis generation. Run analyze_papers first and confirm evidence_store.jsonl contains evidence items.";
        emitLog(message);
        await flushProgressUpdates();
        await runContextMemory.put("generate_hypotheses.top_k", 0);
        await runContextMemory.put("generate_hypotheses.candidate_count", 0);
        await runContextMemory.put("generate_hypotheses.source", "missing_evidence");
        await runContextMemory.put("generate_hypotheses.pipeline", "missing_evidence");
        await runContextMemory.put("generate_hypotheses.summary", message);
        await writeHypothesisProgressStatus(run, runContextMemory, {
          status: "failed",
          stage: "missing_evidence",
          message,
          startedAt,
          updatedAt: new Date().toISOString(),
          evidenceCount: 0,
          weakEvidenceCount: 0,
          request,
          progressCount,
          pipeline: "missing_evidence"
        });
        return {
          status: "failure",
          summary: message,
          error: "generate_hypotheses requires at least one evidence item from analyze_papers.",
          toolCallsUsed: 0
        };
      }

      if (weakEvidenceCount > 0) {
        emitLog(
          `Evidence-quality guardrail: ${weakEvidenceCount}/${evidenceRows.length} evidence item(s) are abstract-only or caveated, so bounded probe shortlist ranking will down-weight them.`
        );
      }

      const evidencePreflightBlock = evaluateEvidencePreflightQualityBlock(run, evidenceRows.length, weakEvidenceCount);
      if (evidencePreflightBlock) {
        emitLog(evidencePreflightBlock);
        await flushProgressUpdates();
        await runContextMemory.put("generate_hypotheses.top_k", 0);
        await runContextMemory.put("generate_hypotheses.candidate_count", 0);
        await runContextMemory.put("generate_hypotheses.source", "blocked_weak_evidence_preflight");
        await runContextMemory.put("generate_hypotheses.pipeline", "evidence_quality");
        await runContextMemory.put("generate_hypotheses.summary", evidencePreflightBlock);
        await writeHypothesisProgressStatus(run, runContextMemory, {
          status: "failed",
          stage: "evidence_quality",
          message: evidencePreflightBlock,
          startedAt,
          updatedAt: new Date().toISOString(),
          evidenceCount: evidenceRows.length,
          weakEvidenceCount,
          request,
          progressCount,
          pipeline: "evidence_quality",
          candidateCount: 0,
          probeCandidateCount: 0,
          artifactPaths: [HYPOTHESIS_PROGRESS_STATUS_ARTIFACT, HYPOTHESIS_PROGRESS_LOG_ARTIFACT]
        });
        return {
          status: "failure",
          summary: evidencePreflightBlock,
          error: evidencePreflightBlock,
          toolCallsUsed: 0
        };
      }

      emitLog(
        `Generating hypotheses from ${evidenceRows.length} evidence item(s) with branchCount=${request.branchCount} and topK=${request.topK}.`
      );
      const planning = await generateHypothesesFromEvidence({
        llm: deps.llm,
        runTitle: run.title,
        runTopic: run.topic,
        objectiveMetric: planningObjectiveMetric,
        evidenceSeeds: evidenceRows,
        branchCount: request.branchCount,
        topK: request.topK,
        governance,
        timeoutMs: Number(process.env.AUTOLABOS_HYPOTHESIS_TIMEOUT_MS) || 1_800_000,
        onProgress: emitLog
      });
      await flushProgressUpdates();
      await writeRunArtifact(
        run,
        HYPOTHESIS_HARD_GATE_REJECTIONS_ARTIFACT,
        `${JSON.stringify({
          schema_version: 1,
          artifact_kind: "hypothesis_hard_gate_rejections",
          run_id: run.id,
          research_cycle: run.graph.researchCycle,
          pipeline: planning.artifacts.pipeline,
          rejections: planning.artifacts.hard_gate_rejections
        }, null, 2)}\n`
      );

      const probeScores = new Map(
        planning.artifacts.probe_shortlist.scores.map((item) => [item.candidate_id, item] as const)
      );
      const probeRanks = new Map(
        planning.probe_candidates.map((candidate, index) => [candidate.id, index + 1] as const)
      );
      const gapMap =
        researchMode === "topic_discovery" && gapMapValidation.valid
          ? gapMapValidation.gapMap
          : undefined;
      const boundDrafts = planning.artifacts.drafts.map((candidate) => ({
        ...candidate,
        run_id: run.id,
        research_cycle: run.graph.researchCycle,
        supported_gap_ids: resolveSupportedGapIds(candidate.evidence_links, gapMap)
      }));
      const boundReviews = planning.artifacts.reviews.map((review) => ({
        ...review,
        run_id: run.id,
        research_cycle: run.graph.researchCycle
      }));
      let priorAbsorptionToolCalls = 0;
      let priorAbsorptionMatrix: PriorAbsorptionMatrix | undefined;
      let priorAbsorptionMatrixRaw: string | undefined;
      if (researchMode === "topic_discovery") {
        emitLog("Building the candidate-by-prior absorption matrix from exact full-text evidence references.");
        const generated = await generatePriorAbsorptionMatrixArtifact({
          llm: deps.llm,
          candidates: boundDrafts,
          evidence: evidenceRows,
          run,
          abortSignal,
          onProgress: emitLog
        });
        priorAbsorptionMatrix = generated.matrix;
        priorAbsorptionMatrixRaw = generated.raw;
        priorAbsorptionToolCalls = generated.toolCallsUsed;
        const blockedCount = generated.matrix.candidates.filter((item) => !item.probe_eligible).length;
        if (blockedCount > 0) {
          emitLog(
            `Prior absorption P0 blocks ${blockedCount}/${generated.matrix.candidates.length} candidate(s) pending complete evidence-grounded comparisons.`
          );
        }
      }
      const portfolioGeneratedAt = new Date().toISOString();
      const preliminaryPortfolio =
        researchMode === "topic_discovery"
          ? buildTopicPortfolio({
              candidates: boundDrafts,
              reviews: boundReviews,
              probeCandidateIds: planning.artifacts.probe_shortlist.probe_candidate_ids,
              evidence: evidenceRows,
              evidenceAxes: planning.artifacts.evidence_axes,
              gapMap,
              runId: run.id,
              researchCycle: run.graph.researchCycle,
              generatedAt: portfolioGeneratedAt,
              sourceGapMapSha256: gapMap?.content_sha256,
              priorAbsorptionMatrix,
              computeBudgetCeiling,
              topicMemoryLedger
            })
          : undefined;
      const portfolioCandidateBySourceId = new Map(
        (preliminaryPortfolio?.candidates || []).map(
          (candidate) => [candidate.source_candidate_id, candidate] as const
        )
      );
      const probeCandidatesById = new Map(
        planning.probe_candidates.map((candidate) => [candidate.id, candidate] as const)
      );
      const probeCandidateIds =
        preliminaryPortfolio
          ? preliminaryPortfolio.candidates
              .filter(
                (candidate) =>
                  candidate.probe_status === "shortlisted"
                  && candidate.probe_eligible
              )
              .map((candidate) => candidate.source_candidate_id)
          : planning.artifacts.probe_shortlist.probe_candidate_ids;
      const shortlistedCandidateIds =
        preliminaryPortfolio?.candidates
          .filter((candidate) => candidate.probe_status === "shortlisted")
          .map((candidate) => candidate.source_candidate_id)
        ?? [];
      const blockedShortlistedCandidateIds =
        preliminaryPortfolio?.candidates
          .filter(
            (candidate) =>
              candidate.probe_status === "shortlisted"
              && !candidate.probe_eligible
          )
          .map((candidate) => candidate.source_candidate_id)
        ?? [];
      if (blockedShortlistedCandidateIds.length > 0) {
        emitLog(
          "Removed blocked candidates from the executable probe shortlist: "
          + blockedShortlistedCandidateIds.join(", ")
          + "."
        );
      }
      if (
        researchMode === "topic_discovery"
        && priorAbsorptionMatrix
        && shortlistedCandidateIds.length > 0
      ) {
        const candidatePriorSearch = await prepareCandidatePriorSearchDecision({
          run,
          candidates: planning.artifacts.drafts,
          matrix: priorAbsorptionMatrix,
          shortlistedCandidateIds,
          collectAttemptId,
          corpusRaw,
          corpusSha256: gapEvidenceChain.corpusSha256,
          corpusByteLength: gapEvidenceChain.corpusByteLength
        });
        await writeRunArtifact(
          run,
          CANDIDATE_PRIOR_SEARCH_DECISION_ARTIFACT,
          `${JSON.stringify(candidatePriorSearch.artifact, null, 2)}\n`
        );
        if (candidatePriorSearch.lineageFailure) {
          const message =
            "Hypothesis generation blocked because candidate-prior search lineage is invalid: "
            + candidatePriorSearch.lineageFailure;
          await writeHypothesisProgressStatus(run, runContextMemory, {
            status: "failed",
            stage: "gating",
            message,
            startedAt,
            updatedAt: new Date().toISOString(),
            evidenceCount: evidenceRows.length,
            weakEvidenceCount,
            request,
            progressCount,
            pipeline: planning.artifacts.pipeline,
            source: "blocked_candidate_prior_lineage",
            candidateCount: planning.candidates.length,
            probeCandidateCount: 0,
            artifactPaths: [
              HYPOTHESIS_PROGRESS_STATUS_ARTIFACT,
              HYPOTHESIS_PROGRESS_LOG_ARTIFACT,
              PRIOR_ABSORPTION_MATRIX_ARTIFACT,
              CANDIDATE_PRIOR_SEARCH_DECISION_ARTIFACT,
              HYPOTHESIS_HARD_GATE_REJECTIONS_ARTIFACT,
              "hypothesis_generation/llm_trace.json"
            ]
          });
          return {
            status: "failure",
            failureKind: "gate_blocked",
            summary: message,
            error: message,
            toolCallsUsed: Math.max(
              1,
              planning.toolCallsUsed + priorAbsorptionToolCalls
            )
          };
        }
        if (candidatePriorSearch.plan) {
          const generatedAt = new Date().toISOString();
          const plan = candidatePriorSearch.plan;
          const summary =
            `Candidate-conditioned direct-prior search is required for ${plan.candidates.length} `
            + "shortlisted candidate contract(s) before probe authorization.";
          await appendJsonl(
            run,
            "hypothesis_generation/drafts.jsonl",
            boundDrafts
          );
          await appendJsonl(
            run,
            "hypothesis_generation/reviews.jsonl",
            boundReviews
          );
          await writeRunArtifact(
            run,
            "hypothesis_generation/llm_trace.json",
            JSON.stringify(planning.artifacts.llm_trace, null, 2)
          );
          await writeRunArtifact(
            run,
            CANDIDATE_PRIOR_SEARCH_PLAN_ARTIFACT,
            `${JSON.stringify(plan, null, 2)}\n`
          );
          await runContextMemory.put("collect_papers.request", {
            additional: CANDIDATE_PRIOR_SEARCH_PER_LANE_LIMIT,
            candidatePriorSearchPlan: plan
          });
          await runContextMemory.put(
            "collect_papers.candidate_prior_search_plan_sha256",
            plan.content_sha256
          );
          await runContextMemory.put(
            "generate_hypotheses.source",
            "candidate_prior_search_backtrack"
          );
          await runContextMemory.put("generate_hypotheses.summary", summary);
          await flushProgressUpdates();
          await writeHypothesisProgressStatus(run, runContextMemory, {
            status: "completed",
            stage: "direct_prior_search",
            message: summary,
            startedAt,
            updatedAt: generatedAt,
            evidenceCount: evidenceRows.length,
            weakEvidenceCount,
            request,
            progressCount,
            pipeline: planning.artifacts.pipeline,
            source: "candidate_prior_search_backtrack",
            candidateCount: planning.candidates.length,
            probeCandidateCount: 0,
            artifactPaths: [
              HYPOTHESIS_PROGRESS_STATUS_ARTIFACT,
              HYPOTHESIS_PROGRESS_LOG_ARTIFACT,
              "hypothesis_generation/drafts.jsonl",
              "hypothesis_generation/reviews.jsonl",
              PRIOR_ABSORPTION_MATRIX_ARTIFACT,
              CANDIDATE_PRIOR_SEARCH_PLAN_ARTIFACT,
              CANDIDATE_PRIOR_SEARCH_DECISION_ARTIFACT,
              HYPOTHESIS_HARD_GATE_REJECTIONS_ARTIFACT,
              "hypothesis_generation/llm_trace.json"
            ]
          });
          return {
            status: "success",
            summary,
            needsApproval: true,
            toolCallsUsed: Math.max(
              1,
              planning.toolCallsUsed + priorAbsorptionToolCalls
            ),
            transitionRecommendation: {
              action: "backtrack_to_collection",
              sourceNode: "generate_hypotheses",
              targetNode: "collect_papers",
              reason:
                `candidate_prior_search:${plan.content_sha256}:`
                + "direct-prior coverage is incomplete for a non-absorbed shortlisted candidate",
              confidence: 0.94,
              autoExecutable: true,
              evidence: [
                CANDIDATE_PRIOR_SEARCH_PLAN_ARTIFACT,
                CANDIDATE_PRIOR_SEARCH_DECISION_ARTIFACT,
                PRIOR_ABSORPTION_MATRIX_ARTIFACT
              ],
              suggestedCommands: [
                "/agent jump collect_papers",
                "/agent run collect_papers"
              ],
              generatedAt
            }
          };
        }
        const uncoveredCandidateIds = candidatePriorSearch.artifact.candidates
          .filter(
            (candidate) =>
              !candidate.absorbed_by_prior
              && !candidate.covered_by_valid_receipt
          )
          .map((candidate) => candidate.candidate_id);
        if (uncoveredCandidateIds.length > 0) {
          const message =
            "Hypothesis generation blocked because candidate-conditioned direct-prior search "
            + `did not produce a valid receipt within ${candidatePriorSearch.artifact.max_rounds} bounded round(s): `
            + uncoveredCandidateIds.join(", ");
          await writeHypothesisProgressStatus(run, runContextMemory, {
            status: "failed",
            stage: "direct_prior_search",
            message,
            startedAt,
            updatedAt: new Date().toISOString(),
            evidenceCount: evidenceRows.length,
            weakEvidenceCount,
            request,
            progressCount,
            pipeline: planning.artifacts.pipeline,
            source: "blocked_candidate_prior_exhausted",
            candidateCount: planning.candidates.length,
            probeCandidateCount: 0,
            artifactPaths: [
              HYPOTHESIS_PROGRESS_STATUS_ARTIFACT,
              HYPOTHESIS_PROGRESS_LOG_ARTIFACT,
              PRIOR_ABSORPTION_MATRIX_ARTIFACT,
              CANDIDATE_PRIOR_SEARCH_DECISION_ARTIFACT,
              HYPOTHESIS_HARD_GATE_REJECTIONS_ARTIFACT,
              "hypothesis_generation/llm_trace.json"
            ]
          });
          return {
            status: "failure",
            failureKind: "gate_blocked",
            summary: message,
            error: message,
            toolCallsUsed: Math.max(
              1,
              planning.toolCallsUsed + priorAbsorptionToolCalls
            )
          };
        }
      }
      const hypotheses = probeCandidateIds.flatMap((candidateId, idx) => {
        const candidate = probeCandidatesById.get(candidateId);
        const portfolioCandidate = portfolioCandidateBySourceId.get(candidateId);
        return candidate ? [{
        hypothesis_id: `h_${idx + 1}`,
        candidate_id: candidate.id,
        run_id: run.id,
        research_cycle: run.graph.researchCycle,
        supported_gap_ids: resolveSupportedGapIds(candidate.evidence_links, gapMap),
        probe_rank: probeRanks.get(candidate.id) || idx + 1,
        base_score: probeScores.get(candidate.id)?.base_score,
        diversity_penalty: probeScores.get(candidate.id)?.diversity_penalty,
        final_score: probeScores.get(candidate.id)?.final_score,
        text: candidate.text,
        score: probeScores.get(candidate.id)?.base_score ?? scoreCandidate(candidate, evidenceById),
        evidence_links: candidate.evidence_links,
        evidence_quality_adjustment: probeScores.get(candidate.id)?.evidence_quality_adjustment,
        evidence_quality_notes: probeScores.get(candidate.id)?.evidence_quality_notes,
        evidence_snippets: uniqueStrings(
          candidate.evidence_links
            .map((evidenceId) => buildEvidenceSnippet(evidenceById.get(evidenceId)))
            .filter((value): value is string => Boolean(value))
        ),
        paper_titles: uniqueStrings(
          candidate.evidence_links
            .map((evidenceId) => evidenceById.get(evidenceId)?.paper_id)
            .map((paperId) => (paperId ? paperTitlesById.get(paperId) : undefined))
            .filter((value): value is string => Boolean(value))
        ),
        rationale: candidate.rationale,
        source: planning.source,
        novelty: candidate.novelty,
        feasibility: candidate.feasibility,
        testability: candidate.testability,
        cost: candidate.cost,
        expected_gain: candidate.expected_gain,
        generator_kind: candidate.generator_kind,
        axis_ids: candidate.axis_ids,
        groundedness: candidate.groundedness,
        causal_clarity: candidate.causal_clarity,
        falsifiability: candidate.falsifiability,
        experimentability: candidate.experimentability,
        measurement_specificity: candidate.measurement_specificity,
        measurement_signals: candidate.measurement_signals,
        measurement_hint: candidate.measurement_hint,
        boundary_condition: candidate.boundary_condition,
        gap_statement: candidate.gap_statement,
        closest_prior_non_overlap: candidate.closest_prior_non_overlap,
        reviewer_absorption_objection: candidate.reviewer_absorption_objection,
        comparator: candidate.comparator,
        dataset_task_bench: candidate.dataset_task_bench,
        primary_metric: candidate.primary_metric,
        metric_unit: candidate.metric_unit,
        metric_scale: candidate.metric_scale,
        metric_direction: candidate.metric_direction,
        meaningful_effect: candidate.meaningful_effect,
        effect_criterion: candidate.effect_criterion,
        objective_raw: portfolioCandidate?.objective_raw,
        falsifier: candidate.falsifier,
        local_budget: candidate.local_budget,
        kill_signal: candidate.kill_signal,
        contribution_claim: candidate.contribution_claim,
        minimum_publishable_evidence: candidate.minimum_publishable_evidence,
        limitation_reflection: candidate.limitation_reflection,
        measurement_readiness: candidate.measurement_readiness,
        critique_summary: candidate.critique_summary
        }] : [];
      });

      const fallbackQualityBlock = evaluateFallbackHypothesisQualityBlock(hypotheses);
      if (fallbackQualityBlock) {
        emitLog(fallbackQualityBlock);
        await flushProgressUpdates();
        await runContextMemory.put("generate_hypotheses.top_k", 0);
        await runContextMemory.put("generate_hypotheses.candidate_count", planning.candidates.length);
        await runContextMemory.put("generate_hypotheses.source", "blocked_low_quality_fallback");
        await runContextMemory.put("generate_hypotheses.pipeline", planning.artifacts.pipeline);
        await runContextMemory.put("generate_hypotheses.summary", fallbackQualityBlock);
        await writeHypothesisProgressStatus(run, runContextMemory, {
          status: "failed",
          stage: "gating",
          message: fallbackQualityBlock,
          startedAt,
          updatedAt: new Date().toISOString(),
          evidenceCount: evidenceRows.length,
          weakEvidenceCount,
          request,
          progressCount,
          pipeline: planning.artifacts.pipeline,
          source: planning.source,
          fallbackReason: planning.fallbackReason,
          candidateCount: planning.candidates.length,
          probeCandidateCount: 0,
          artifactPaths: [
            HYPOTHESIS_PROGRESS_STATUS_ARTIFACT,
            HYPOTHESIS_PROGRESS_LOG_ARTIFACT,
            "hypothesis_generation/probe_shortlist.json",
            ...(researchMode === "topic_discovery"
              ? [PRIOR_ABSORPTION_MATRIX_ARTIFACT]
              : []),
            HYPOTHESIS_HARD_GATE_REJECTIONS_ARTIFACT,
            "hypothesis_generation/llm_trace.json"
          ]
        });
        return {
          status: "failure",
          summary: fallbackQualityBlock,
          error: fallbackQualityBlock,
          toolCallsUsed: Math.max(1, planning.toolCallsUsed + priorAbsorptionToolCalls)
        };
      }

      const hypothesesRaw = serializeJsonl(hypotheses);
      const draftsRaw = serializeJsonl(boundDrafts);
      const reviewsRaw = serializeJsonl(boundReviews);
      const topicByCandidateId = new Map(
        (preliminaryPortfolio?.candidates || []).map(
          (candidate) => [candidate.source_candidate_id, candidate.topic_id] as const
        )
      );
      const shortlist = {
        run_id: run.id,
        research_cycle: run.graph.researchCycle,
        probe_candidate_ids: probeCandidateIds,
        ...(preliminaryPortfolio
          ? {
              probe_topic_ids: probeCandidateIds.flatMap((candidateId) => {
                const topicId = topicByCandidateId.get(candidateId);
                return topicId ? [topicId] : [];
              })
            }
          : {}),
        ranked_candidate_ids: planning.artifacts.probe_shortlist.ranked_candidate_ids,
        scores: planning.artifacts.probe_shortlist.scores
      };
      const probeShortlistRaw = JSON.stringify(shortlist, null, 2);
      const evidenceAxesRaw = `${JSON.stringify(
        planning.artifacts.evidence_axes,
        null,
        2
      )}\n`;

      await appendJsonl(run, "hypotheses.jsonl", hypotheses);
      if (
        researchMode === "topic_discovery"
        || planning.artifacts.evidence_axes.length > 0
      ) {
        await writeRunArtifact(
          run,
          "hypothesis_generation/evidence_axes.json",
          evidenceAxesRaw
        );
      }
      await appendJsonl(run, "hypothesis_generation/drafts.jsonl", boundDrafts);
      await appendJsonl(run, "hypothesis_generation/reviews.jsonl", boundReviews);
      await writeRunArtifact(
        run,
        "hypothesis_generation/probe_shortlist.json",
        probeShortlistRaw
      );
      let topicDiscoveryAuthorizationFailure: string | undefined;
      if (researchMode === "topic_discovery") {
        const sourceArtifactBindings = [
          ...(boundGapMapRaw.trim()
            ? [buildResearchFunnelArtifactBinding("analysis/gap_map.json", boundGapMapRaw)]
            : []),
          buildResearchFunnelArtifactBinding(
            "hypothesis_generation/evidence_axes.json",
            evidenceAxesRaw
          ),
          buildResearchFunnelArtifactBinding(
            "hypothesis_generation/prior_absorption_matrix.json",
            priorAbsorptionMatrixRaw || ""
          ),
          buildResearchFunnelArtifactBinding("hypotheses.jsonl", hypothesesRaw),
          buildResearchFunnelArtifactBinding("hypothesis_generation/drafts.jsonl", draftsRaw),
          buildResearchFunnelArtifactBinding("hypothesis_generation/reviews.jsonl", reviewsRaw),
          buildResearchFunnelArtifactBinding(
            "hypothesis_generation/probe_shortlist.json",
            probeShortlistRaw
          )
        ];
        const topicPortfolio = buildTopicPortfolio({
          candidates: boundDrafts,
          reviews: boundReviews,
          probeCandidateIds: shortlist.probe_candidate_ids,
          evidence: evidenceRows,
          evidenceAxes: planning.artifacts.evidence_axes,
          gapMap,
          runId: run.id,
          researchCycle: run.graph.researchCycle,
          generatedAt: portfolioGeneratedAt,
          sourceArtifactBindings,
          sourceGapMapSha256: gapMap?.content_sha256,
          priorAbsorptionMatrix,
          computeBudgetCeiling,
          topicMemoryLedger
        });
        const topicPortfolioRaw = JSON.stringify(topicPortfolio, null, 2);
        await writeRunArtifact(
          run,
          "hypothesis_generation/topic_portfolio.json",
          topicPortfolioRaw
        );
        const topicMemoryAuditPayload = {
          schema_version: 1 as const,
          artifact_kind: "topic_memory_candidate_audit" as const,
          run_id: run.id,
          research_cycle: run.graph.researchCycle,
          generated_at: portfolioGeneratedAt,
          ledger_sha256: topicPortfolio.topic_memory_ledger?.ledger_sha256 || "",
          record_count: topicPortfolio.topic_memory_ledger?.records.length || 0,
          candidate_decisions: topicPortfolio.candidates.map((candidate) => ({
            source_candidate_id: candidate.source_candidate_id,
            topic_lineage_id: candidate.topic_lineage_id,
            formulation_id: candidate.formulation_id,
            disposition: candidate.topic_memory?.decision.disposition || "blocked",
            blocked: candidate.topic_memory?.decision.blocked ?? true,
            matching_record_sha256s:
              candidate.topic_memory?.decision.matching_record_sha256s || []
          }))
        };
        await writeRunArtifact(
          run,
          TOPIC_MEMORY_AUDIT_ARTIFACT,
          `${JSON.stringify({
            ...topicMemoryAuditPayload,
            content_sha256: hashCanonical(topicMemoryAuditPayload)
          }, null, 2)}\n`
        );
        const closedChainValidation = validateResearchFunnelClosedChain({
          expectedRunId: run.id,
          expectedResearchCycle: run.graph.researchCycle,
          gapMapRaw: boundGapMapRaw.trim() ? boundGapMapRaw : undefined,
          evidenceAxesRaw,
          priorAbsorptionMatrixRaw,
          hypothesesRaw,
          draftsRaw,
          reviewsRaw,
          probeShortlistRaw,
          portfolioRaw: topicPortfolioRaw,
          requireDecision: false,
          gapValidationContext: gapEvidenceChain.validationContext,
          gapValidationReasonCodes: gapEvidenceChain.reasonCodes
        });
        if (!closedChainValidation.valid) {
          emitLog(
            `Closed-chain probe authorization remains blocked: ${closedChainValidation.reasons.join(", ")}.`
          );
        }
        const blockedPortfolioGates = topicPortfolio.gates
          .filter((gate) => gate.status === "block")
          .map((gate) => gate.code);
        if (!closedChainValidation.valid || !topicPortfolio.probe_allowed) {
          topicDiscoveryAuthorizationFailure = [
            "Hypothesis generation produced diagnostic artifacts but did not authorize an executable topic probe.",
            closedChainValidation.valid
              ? undefined
              : `Closed-chain failures: ${closedChainValidation.reasons.join(", ")}.`,
            blockedPortfolioGates.length > 0
              ? `Blocked portfolio gates: ${blockedPortfolioGates.join(", ")}.`
              : undefined,
            blockedShortlistedCandidateIds.length > 0
              ? `Blocked shortlisted candidates: ${blockedShortlistedCandidateIds.join(", ")}.`
              : undefined,
            "Regenerate or strengthen the topic portfolio before design_experiments."
          ].filter(Boolean).join(" ");
          emitLog(topicDiscoveryAuthorizationFailure);
        }
      }
      await writeRunArtifact(
        run,
        "hypothesis_generation/llm_trace.json",
        JSON.stringify(planning.artifacts.llm_trace, null, 2)
      );
      if (topicDiscoveryAuthorizationFailure) {
        await runContextMemory.put("generate_hypotheses.top_k", 0);
        await runContextMemory.put(
          "generate_hypotheses.probe_candidate_count",
          0
        );
        await runContextMemory.put(
          "generate_hypotheses.candidate_count",
          planning.candidates.length
        );
        await runContextMemory.put(
          "generate_hypotheses.source",
          "blocked_topic_probe_authorization"
        );
        await runContextMemory.put(
          "generate_hypotheses.summary",
          topicDiscoveryAuthorizationFailure
        );
        await runContextMemory.put(
          "generate_hypotheses.pipeline",
          planning.artifacts.pipeline
        );
        await flushProgressUpdates();
        await writeHypothesisProgressStatus(run, runContextMemory, {
          status: "failed",
          stage: "gating",
          message: topicDiscoveryAuthorizationFailure,
          startedAt,
          updatedAt: new Date().toISOString(),
          evidenceCount: evidenceRows.length,
          weakEvidenceCount,
          request,
          progressCount,
          pipeline: planning.artifacts.pipeline,
          source: "blocked_topic_probe_authorization",
          fallbackReason: planning.fallbackReason,
          candidateCount: planning.candidates.length,
          probeCandidateCount: 0,
          artifactPaths: [
            "hypotheses.jsonl",
            HYPOTHESIS_PROGRESS_STATUS_ARTIFACT,
            HYPOTHESIS_PROGRESS_LOG_ARTIFACT,
            "hypothesis_generation/probe_shortlist.json",
            PRIOR_ABSORPTION_MATRIX_ARTIFACT,
            "hypothesis_generation/topic_portfolio.json",
            TOPIC_MEMORY_AUDIT_ARTIFACT,
            ...(shortlistedCandidateIds.length > 0
              ? [CANDIDATE_PRIOR_SEARCH_DECISION_ARTIFACT]
              : []),
            HYPOTHESIS_HARD_GATE_REJECTIONS_ARTIFACT,
            "hypothesis_generation/llm_trace.json"
          ]
        });
        return {
          status: "failure",
          failureKind: "gate_blocked",
          summary: topicDiscoveryAuthorizationFailure,
          error: topicDiscoveryAuthorizationFailure,
          toolCallsUsed: Math.max(
            1,
            planning.toolCallsUsed + priorAbsorptionToolCalls
          )
        };
      }
      const finalSummary =
        researchMode === "topic_discovery"
          ? [
              `Shortlisted ${hypotheses.length} of ${planning.candidates.length} hypothesis candidate(s) for bounded execution probes using ${planning.source}.`,
              "No final paper topic was selected.",
              planning.fallbackReason ? `Fallback reason: ${planning.fallbackReason}` : undefined
            ].filter(Boolean).join(" ")
          : planning.fallbackReason
            ? `${planning.summary} Falling back after: ${planning.fallbackReason}`
            : planning.summary;
      await runContextMemory.put("generate_hypotheses.top_k", hypotheses.length);
      await runContextMemory.put("generate_hypotheses.probe_candidate_count", hypotheses.length);
      await runContextMemory.put("generate_hypotheses.candidate_count", planning.candidates.length);
      await runContextMemory.put("generate_hypotheses.source", planning.source);
      await runContextMemory.put("generate_hypotheses.summary", finalSummary);
      await runContextMemory.put("generate_hypotheses.pipeline", planning.artifacts.pipeline);

      deps.eventStream.emit({
        type: "PLAN_CREATED",
        runId: run.id,
        node: "generate_hypotheses",
        payload: {
          branchCount: planning.candidates.length,
          probeCandidateCount: hypotheses.length,
          source: planning.source,
          fallbackReason: planning.fallbackReason
        }
      });

      emitLog(
        researchMode === "topic_discovery"
          ? `Shortlisted ${hypotheses.length} hypothesis/hypotheses for bounded execution probes from ${planning.candidates.length} candidate(s) using ${planning.source}; no final paper topic was selected.`
          : `Selected ${hypotheses.length} hypothesis/hypotheses from ${planning.candidates.length} candidate(s) using ${planning.source}.`
      );
      await flushProgressUpdates();
      await writeHypothesisProgressStatus(run, runContextMemory, {
        status: "completed",
        stage: "completed",
        message: finalSummary,
        startedAt,
        updatedAt: new Date().toISOString(),
        evidenceCount: evidenceRows.length,
        weakEvidenceCount,
        request,
        progressCount,
        pipeline: planning.artifacts.pipeline,
        source: planning.source,
        fallbackReason: planning.fallbackReason,
        candidateCount: planning.candidates.length,
        probeCandidateCount: hypotheses.length,
        artifactPaths: [
          "hypotheses.jsonl",
          HYPOTHESIS_PROGRESS_STATUS_ARTIFACT,
          HYPOTHESIS_PROGRESS_LOG_ARTIFACT,
          "hypothesis_generation/probe_shortlist.json",
          ...(researchMode === "topic_discovery"
            ? [
                PRIOR_ABSORPTION_MATRIX_ARTIFACT,
                "hypothesis_generation/topic_portfolio.json",
                TOPIC_MEMORY_AUDIT_ARTIFACT,
                CANDIDATE_PRIOR_SEARCH_DECISION_ARTIFACT
              ]
            : []),
          HYPOTHESIS_HARD_GATE_REJECTIONS_ARTIFACT,
          "hypothesis_generation/llm_trace.json"
        ]
      });

      return {
        status: "success",
        summary: finalSummary,
        needsApproval: true,
        toolCallsUsed: Math.max(1, planning.toolCallsUsed + priorAbsorptionToolCalls)
      };
    }
  };
}

async function generatePriorAbsorptionMatrixArtifact(input: {
  llm: NodeExecutionDeps["llm"];
  candidates: HypothesisCandidate[];
  evidence: EvidenceRow[];
  run: RunRecord;
  abortSignal?: AbortSignal;
  onProgress: (text: string) => void;
}): Promise<{
  matrix: PriorAbsorptionMatrix;
  raw: string;
  toolCallsUsed: number;
}> {
  let assessments: PriorAbsorptionAssessment[] = [];
  let assessmentSource: PriorAbsorptionMatrix["assessment_source"] = "unavailable";
  let toolCallsUsed = 0;
  try {
    toolCallsUsed = 1;
    const response = await input.llm.complete(
      buildPriorAbsorptionAssessmentPrompt({
        candidates: input.candidates,
        evidence: input.evidence
      }),
      {
        systemPrompt:
          "Ground every prior-absorption judgment in the supplied exact full-text evidence IDs. Return JSON only and use uncertain when support is incomplete.",
        abortSignal: input.abortSignal,
        onProgress: (event) => {
          if (event.type === "status" && event.text.trim()) {
            input.onProgress(event.text);
          }
        }
      }
    );
    assessments = parsePriorAbsorptionAssessmentResponse(response.text);
    if (assessments.length > 0) {
      assessmentSource = "llm_structured_comparison";
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    input.onProgress(
      `Prior absorption assessment was unavailable (${detail}); all unsupported comparisons will remain uncertain.`
    );
  }
  const matrix = buildPriorAbsorptionMatrix({
    candidates: input.candidates,
    evidence: input.evidence,
    assessments,
    runId: input.run.id,
    researchCycle: input.run.graph.researchCycle,
    assessmentSource
  });
  const raw = `${JSON.stringify(matrix, null, 2)}\n`;
  const validation = validatePriorAbsorptionMatrixArtifact(raw, {
    expectedRunId: input.run.id,
    expectedResearchCycle: input.run.graph.researchCycle
  });
  if (!validation.valid) {
    throw new Error(`prior_absorption_matrix_internal_validation_failed:${validation.reasons.join(",")}`);
  }
  await writeRunArtifact(input.run, PRIOR_ABSORPTION_MATRIX_ARTIFACT, raw);
  return { matrix, raw, toolCallsUsed };
}

interface CandidatePriorSearchDecisionArtifact {
  schema_version: 1;
  artifact_kind: "candidate_prior_search_decision";
  run_id: string;
  research_cycle: number;
  generated_at: string;
  collect_attempt_id: string;
  completed_rounds: number;
  max_rounds: number;
  current_receipt_status: "not_applicable" | "valid" | "invalid";
  action: "request_collection" | "already_searched" | "exhausted" | "not_required" | "blocked_invalid_lineage";
  candidates: Array<{
    candidate_id: string;
    prior_absorption_contract_sha256: string;
    reason_codes: string[];
    absorbed_by_prior: boolean;
    covered_by_valid_receipt: boolean;
    selected_for_search: boolean;
  }>;
  plan_content_sha256?: string;
  lineage_failure?: string;
  content_sha256: string;
}

export async function prepareCandidatePriorSearchDecision(input: {
  run: RunRecord;
  candidates: HypothesisCandidate[];
  matrix: PriorAbsorptionMatrix;
  shortlistedCandidateIds: string[];
  collectAttemptId?: string;
  corpusRaw: string;
  corpusSha256: string;
  corpusByteLength: number;
}): Promise<{
  artifact: CandidatePriorSearchDecisionArtifact;
  plan?: CandidatePriorSearchPlan;
  lineageFailure?: string;
}> {
  const generatedAt = new Date().toISOString();
  const shortlistedIds = new Set(input.shortlistedCandidateIds);
  const candidateById = new Map(
    input.candidates.map((candidate) => [candidate.id, candidate] as const)
  );
  const completedRounds = countCandidatePriorSearchRounds(input.run);
  const receiptState = await loadCurrentCandidatePriorSearchReceipt({
    run: input.run,
    collectAttemptId: input.collectAttemptId,
    resultCorpusRaw: input.corpusRaw
  });
  const coveredContractHashes = new Set(
    receiptState.receipt?.candidates.map(
      (candidate) => candidate.prior_absorption_contract_sha256
    ) || []
  );
  const rows = input.matrix.candidates
    .filter((candidate) => shortlistedIds.has(candidate.candidate_id))
    .map((matrixCandidate) => {
      const candidate = candidateById.get(matrixCandidate.candidate_id);
      const expectedContract = candidate
        ? buildPriorAbsorptionCandidateContract(candidate)
        : matrixCandidate.candidate_contract;
      const absorbedByPrior = matrixCandidate.comparisons.some(
        (comparison) => comparison.disposition === "absorbed"
      );
      const coveredByValidReceipt = coveredContractHashes.has(
        expectedContract.content_sha256
      );
      return {
        candidate,
        expectedContract,
        matrixCandidate,
        absorbedByPrior,
        coveredByValidReceipt,
        selectedForSearch:
          Boolean(candidate)
          && !absorbedByPrior
          && !coveredByValidReceipt
      };
    });

  let lineageFailure = receiptState.failure;
  if (!input.collectAttemptId) {
    lineageFailure = lineageFailure || "candidate_prior_search_collect_attempt_missing";
  }
  if (
    input.corpusSha256 !== hashCanonicalJsonlBytes(input.corpusRaw)
    || input.corpusByteLength !== Buffer.byteLength(input.corpusRaw, "utf8")
  ) {
    lineageFailure = lineageFailure || "candidate_prior_search_current_corpus_binding_mismatch";
  }

  const candidatesForSearch = dedupeCandidatePriorSearchInputs(
    rows.flatMap((row) =>
      row.selectedForSearch && row.candidate
        ? [{ candidate: row.candidate, candidateContract: row.expectedContract }]
        : []
    )
  );
  let plan: CandidatePriorSearchPlan | undefined;
  let action: CandidatePriorSearchDecisionArtifact["action"];
  if (lineageFailure) {
    action = "blocked_invalid_lineage";
  } else if (candidatesForSearch.length === 0) {
    action = rows.some((row) => row.coveredByValidReceipt)
      ? "already_searched"
      : "not_required";
  } else if (completedRounds >= MAX_CANDIDATE_PRIOR_SEARCH_ROUNDS) {
    action = "exhausted";
  } else {
    plan = buildCandidatePriorSearchPlan({
      runId: input.run.id,
      researchCycle: input.run.graph.researchCycle,
      generatedAt,
      asOfDate: generatedAt.slice(0, 10),
      sourceCorpus: {
        collect_attempt_id: input.collectAttemptId as string,
        sha256: input.corpusSha256,
        byte_length: input.corpusByteLength
      },
      candidates: candidatesForSearch
    });
    const validation = validateCandidatePriorSearchPlanIntegrity(plan);
    if (!validation.valid) {
      lineageFailure =
        `candidate_prior_search_generated_plan_invalid:${validation.reasons.join(",")}`;
      plan = undefined;
      action = "blocked_invalid_lineage";
    } else {
      action = "request_collection";
    }
  }

  const payload: Omit<CandidatePriorSearchDecisionArtifact, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "candidate_prior_search_decision",
    run_id: input.run.id,
    research_cycle: input.run.graph.researchCycle,
    generated_at: generatedAt,
    collect_attempt_id: input.collectAttemptId || "",
    completed_rounds: completedRounds,
    max_rounds: MAX_CANDIDATE_PRIOR_SEARCH_ROUNDS,
    current_receipt_status: receiptState.status,
    action,
    candidates: rows.map((row) => ({
      candidate_id: row.matrixCandidate.candidate_id,
      prior_absorption_contract_sha256: row.expectedContract.content_sha256,
      reason_codes: [...row.matrixCandidate.reason_codes],
      absorbed_by_prior: row.absorbedByPrior,
      covered_by_valid_receipt: row.coveredByValidReceipt,
      selected_for_search: Boolean(
        plan?.candidates.some(
          (candidate) =>
            candidate.prior_absorption_contract_sha256
            === row.expectedContract.content_sha256
        )
      )
    })),
    ...(plan ? { plan_content_sha256: plan.content_sha256 } : {}),
    ...(lineageFailure ? { lineage_failure: lineageFailure } : {})
  };
  const artifact: CandidatePriorSearchDecisionArtifact = {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
  return {
    artifact,
    ...(plan ? { plan } : {}),
    ...(lineageFailure ? { lineageFailure } : {})
  };
}

async function loadCurrentCandidatePriorSearchReceipt(input: {
  run: RunRecord;
  collectAttemptId?: string;
  resultCorpusRaw: string;
}): Promise<{
  status: CandidatePriorSearchDecisionArtifact["current_receipt_status"];
  receipt?: CandidatePriorSearchReceipt;
  failure?: string;
}> {
  const runRoot = path.join(".autolabos", "runs", input.run.id);
  const queryPlanRaw = await safeRead(path.join(runRoot, "collect_query_plan.json"));
  const queryPlan = parseJsonObject(queryPlanRaw);
  if (queryPlan?.strategy !== "candidate_prior_portfolio") {
    return { status: "not_applicable" };
  }
  const [planRaw, receiptRaw] = await Promise.all([
    safeRead(path.join(runRoot, COLLECT_CANDIDATE_PRIOR_SEARCH_PLAN_ARTIFACT)),
    safeRead(path.join(runRoot, COLLECT_CANDIDATE_PRIOR_SEARCH_RECEIPT_ARTIFACT))
  ]);
  const planValue = parseJsonObject(planRaw);
  const receiptValue = parseJsonObject(receiptRaw);
  const planValidation = validateCandidatePriorSearchPlanIntegrity(planValue);
  if (!planValidation.valid || !planValidation.plan) {
    return {
      status: "invalid",
      failure: `candidate_prior_search_current_plan_invalid:${planValidation.reasons.join(",")}`
    };
  }
  const embeddedPlan = queryPlan.candidate_prior_search_plan;
  const embeddedPlanSha256 =
    embeddedPlan
    && typeof embeddedPlan === "object"
    && !Array.isArray(embeddedPlan)
    && "content_sha256" in embeddedPlan
    && typeof embeddedPlan.content_sha256 === "string"
      ? embeddedPlan.content_sha256
      : undefined;
  if (
    queryPlan.collect_attempt_id !== input.collectAttemptId
    || embeddedPlanSha256 !== planValidation.plan.content_sha256
  ) {
    return {
      status: "invalid",
      failure: "candidate_prior_search_query_plan_binding_mismatch"
    };
  }
  const sourceCorpusRaw = await safeRead(
    path.join(
      runRoot,
      "collect_attempts",
      planValidation.plan.source_corpus.collect_attempt_id,
      "corpus.jsonl"
    )
  );
  if (!sourceCorpusRaw) {
    return {
      status: "invalid",
      failure: "candidate_prior_search_source_corpus_archive_missing"
    };
  }
  const receiptValidation = validateCandidatePriorSearchReceipt(receiptValue, {
    plan: planValidation.plan,
    expectedCollectAttemptId: input.collectAttemptId || "",
    sourceCorpusRaw,
    resultCorpusRaw: input.resultCorpusRaw
  });
  if (!receiptValidation.valid || !receiptValidation.receipt) {
    return {
      status: "invalid",
      failure:
        `candidate_prior_search_current_receipt_invalid:${receiptValidation.reasons.join(",")}`
    };
  }
  return {
    status: "valid",
    receipt: receiptValidation.receipt
  };
}

function countCandidatePriorSearchRounds(run: RunRecord): number {
  return (run.graph.transitionHistory || []).filter(
    (entry) =>
      entry.sourceNode === "generate_hypotheses"
      && entry.toNode === "collect_papers"
      && String(entry.reason || "").startsWith("candidate_prior_search:")
  ).length;
}

function dedupeCandidatePriorSearchInputs(
  candidates: Array<{
    candidate: HypothesisCandidate;
    candidateContract: ReturnType<typeof buildPriorAbsorptionCandidateContract>;
  }>
) {
  const seen = new Set<string>();
  return candidates.filter((item) => {
    if (seen.has(item.candidateContract.content_sha256)) {
      return false;
    }
    seen.add(item.candidateContract.content_sha256);
    return true;
  });
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function hashCanonicalJsonlBytes(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function normalizeGenerateHypothesesRequest(
  raw?: { topK?: unknown; branchCount?: unknown } | null
): GenerateHypothesesRequest {
  const topK = normalizePositiveInt(raw?.topK, DEFAULT_TOP_K);
  const branchCount = Math.max(normalizePositiveInt(raw?.branchCount, DEFAULT_BRANCH_COUNT), topK);
  return {
    topK,
    branchCount
  };
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function serializeJsonl(items: unknown[]): string {
  const lines = items.map((item) => JSON.stringify(item)).join("\n");
  return lines ? `${lines}\n` : "";
}

type HypothesisProgressStage =
  | "preflight"
  | "research_gap_map"
  | "evidence_quality"
  | "axes"
  | "mechanism_drafts"
  | "contradiction_drafts"
  | "intervention_drafts"
  | "review"
  | "gating"
  | "single_pass"
  | "fallback"
  | "selection"
  | "probe_shortlist"
  | "direct_prior_search"
  | "completed"
  | "missing_evidence"
  | "progress";

interface HypothesisProgressStatus {
  status: "running" | "completed" | "failed";
  stage: HypothesisProgressStage;
  message: string;
  startedAt: string;
  updatedAt: string;
  evidenceCount: number;
  weakEvidenceCount: number;
  request: GenerateHypothesesRequest;
  progressCount: number;
  pipeline?:
    | "staged"
    | "single_pass"
    | "fallback"
    | "missing_evidence"
    | "evidence_quality"
    | "research_gap_map";
  source?:
    | "llm"
    | "fallback"
    | "blocked_topic_probe_authorization"
    | "blocked_candidate_prior_lineage"
    | "blocked_candidate_prior_exhausted"
    | "candidate_prior_search_backtrack";
  fallbackReason?: string;
  candidateCount?: number;
  probeCandidateCount?: number;
  artifactPaths?: string[];
}

async function writeHypothesisProgressStatus(
  run: RunRecord,
  runContextMemory: RunContextMemory,
  status: HypothesisProgressStatus
): Promise<void> {
  await runContextMemory.put("generate_hypotheses.status", status.status);
  await runContextMemory.put("generate_hypotheses.progress_stage", status.stage);
  await runContextMemory.put("generate_hypotheses.last_progress", status.message);
  await runContextMemory.put("generate_hypotheses.progress", status);
  await writeRunArtifact(run, HYPOTHESIS_PROGRESS_STATUS_ARTIFACT, JSON.stringify(status, null, 2));
}

function classifyHypothesisProgressStage(message: string): HypothesisProgressStage {
  if (message.includes("Evidence-quality guardrail")) {
    return "evidence_quality";
  }
  if (message.includes("Synthesizing evidence axes") || message.includes("Hypothesis axes")) {
    return "axes";
  }
  if (message.includes("Generating mechanism")) {
    return "mechanism_drafts";
  }
  if (message.includes("Generating contradiction")) {
    return "contradiction_drafts";
  }
  if (message.includes("Generating intervention")) {
    return "intervention_drafts";
  }
  if (message.includes("Reviewing ") || message.includes("Hypothesis review")) {
    return "review";
  }
  if (message.includes("Hard-gated")) {
    return "gating";
  }
  if (message.includes("single-pass")) {
    return "single_pass";
  }
  if (message.includes("fallback")) {
    return "fallback";
  }
  if (message.includes("Shortlisted ") && message.includes("hypothesis/hypotheses")) {
    return "probe_shortlist";
  }
  if (message.includes("Selected ") && message.includes("hypothesis/hypotheses")) {
    return "selection";
  }
  return "progress";
}

function parseCorpusTitleMap(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { paper_id?: unknown; title?: unknown };
      if (typeof parsed.paper_id === "string" && typeof parsed.title === "string" && parsed.title.trim()) {
        out.set(parsed.paper_id, parsed.title.trim());
      }
    } catch {
      // ignore malformed corpus rows
    }
  }
  return out;
}

function buildEvidenceSnippet(evidence: EvidenceRow | undefined): string | undefined {
  if (!evidence) {
    return undefined;
  }
  const raw =
    typeof evidence.evidence_span === "string" && evidence.evidence_span.trim()
      ? evidence.evidence_span.trim()
      : typeof evidence.claim === "string" && evidence.claim.trim()
        ? evidence.claim.trim()
        : "";
  if (!raw) {
    return undefined;
  }
  return raw.length > 200 ? `${raw.slice(0, 197)}...` : raw;
}

function uniqueStrings(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

function scoreCandidate(
  candidate: HypothesisCandidate,
  evidenceById: Map<string, EvidenceRow>
): number {
  const evidenceAdjustment = averageEvidenceAdjustment(candidate, evidenceById);
  return (
    candidate.novelty +
    candidate.feasibility +
    candidate.testability +
    candidate.expected_gain +
    (candidate.groundedness ?? 0) +
    (candidate.causal_clarity ?? 0) +
    (candidate.falsifiability ?? 0) +
    (candidate.experimentability ?? 0) -
    candidate.cost +
    (candidate.measurement_specificity ?? 0) +
    (candidate.limitation_reflection ?? 0) +
    (candidate.measurement_readiness ?? 0) +
    evidenceAdjustment
  );
}

function averageEvidenceAdjustment(
  candidate: HypothesisCandidate,
  evidenceById: Map<string, EvidenceRow>
): number {
  const linkedEvidence = uniqueStrings(candidate.evidence_links)
    .map((evidenceId) => evidenceById.get(evidenceId))
    .filter((item): item is EvidenceRow => Boolean(item));
  if (linkedEvidence.length === 0) {
    return -0.75;
  }
  const average =
    linkedEvidence.reduce((sum, item) => sum + estimateEvidenceAdjustment(item), 0) / linkedEvidence.length;
  return Number(average.toFixed(3));
}

function estimateEvidenceAdjustment(evidence: EvidenceRow): number {
  let adjustment = 0;
  if (evidence.source_type === "full_text") {
    adjustment += 0.4;
  } else if (evidence.source_type === "abstract") {
    adjustment -= 0.85;
  }

  const confidence = typeof evidence.confidence === "number" && Number.isFinite(evidence.confidence)
    ? evidence.confidence
    : 0.5;
  if (confidence < 0.55) {
    adjustment -= 1.1;
  } else if (confidence < 0.7) {
    adjustment -= 0.45;
  } else if (confidence >= 0.9) {
    adjustment += 0.2;
  }

  const reason = typeof evidence.confidence_reason === "string" ? evidence.confidence_reason.toLowerCase() : "";
  if (/(could not be grounded|not be grounded|fallback evidence|no structured evidence|synthesi[sz]ed)/.test(reason)) {
    adjustment -= 1.6;
  } else if (/(only the abstract|abstract-level|abstract only|indirect|supplemental)/.test(reason)) {
    adjustment -= 0.9;
  }
  if (/(single benchmark|external validity|limited|tentative|weak|caveat|partial support)/.test(reason)) {
    adjustment -= 0.3;
  }

  return Number(adjustment.toFixed(3));
}

function evaluateFallbackHypothesisQualityBlock(
  hypotheses: Array<{
    text?: string;
    generator_kind?: string;
    testability?: number;
    evidence_quality_adjustment?: number;
    evidence_quality_notes?: string[];
    measurement_hint?: string;
    measurement_readiness?: number;
    paper_titles?: string[];
  }>
): string | undefined {
  if (hypotheses.length === 0) {
    return undefined;
  }

  if (!hypotheses.every((hypothesis) => hypothesis.generator_kind === "fallback")) {
    return undefined;
  }

  const allLackOperationalContract = hypotheses.every((hypothesis) => {
    const text = (hypothesis.text || "").toLowerCase();
    const declaresMissingDataset =
      /dataset=(not specified|not yet structured)/.test(text) ||
      /abstract-only fallback/.test(text) ||
      /(structured extraction|full-text extraction|extraction review) did not complete/.test(text);
    const declaresMissingMetric =
      /metric=(not specified|not yet structured)/.test(text) ||
      /abstract-only fallback/.test(text) ||
      /(structured extraction|full-text extraction|extraction review) did not complete/.test(text);
    const hasMeasurementHint = Boolean(hypothesis.measurement_hint?.trim());
    const measurementReady = (hypothesis.measurement_readiness ?? 0) >= 3 || hasMeasurementHint;
    return !measurementReady && declaresMissingDataset && declaresMissingMetric;
  });
  if (allLackOperationalContract) {
    return "Hypothesis generation blocked: shortlisted deterministic fallback probe candidates lack an operational dataset/metric/testability contract. Strengthen analyze_papers or rerun hypothesis generation before designing experiments.";
  }

  const supportingPapers = new Set(
    hypotheses.flatMap((hypothesis) => (hypothesis.paper_titles || []).map((title) => title.trim()).filter(Boolean))
  );
  const allSeverelyCaveated = hypotheses.every((hypothesis) => {
    const notes = new Set(hypothesis.evidence_quality_notes || []);
    return (
      (hypothesis.evidence_quality_adjustment ?? 0) <= -1.25 &&
      notes.has("low_confidence") &&
      notes.has("limited_generalizability") &&
      notes.has("all_support_caveated")
    );
  });

  if (supportingPapers.size >= 2 || !allSeverelyCaveated) {
    return undefined;
  }

  return "Hypothesis generation blocked: the shortlisted fallback probe candidates are supported by a single low-confidence, caveated paper. Strengthen analyze_papers before designing experiments.";
}

function evaluateEvidencePreflightQualityBlock(
  run: RunRecord,
  evidenceCount: number,
  weakEvidenceCount: number
): string | undefined {
  if (evidenceCount < 5 || weakEvidenceCount < evidenceCount) {
    return undefined;
  }
  if (!hasRecentHypothesisBacktrackFromQualityGate(run)) {
    return undefined;
  }
  return "Hypothesis generation blocked: all available evidence items are weak after a review or analysis backtrack. Strengthen analyze_papers with full-text, baseline, metric, and limitation evidence before generating another hypothesis set.";
}

function resolveBriefComputeBudgetCeiling(
  researchMode: "hypothesis_test" | "topic_discovery",
  rawBrief: string | undefined
): TopicProbeComputeBudgetLimits | undefined {
  if (researchMode !== "topic_discovery") {
    return undefined;
  }
  return parseTopicProbeComputeBudgetCeilingFromBrief(rawBrief || "");
}

function hasRecentHypothesisBacktrackFromQualityGate(run: RunRecord): boolean {
  const history = Array.isArray(run.graph.transitionHistory) ? run.graph.transitionHistory : [];
  const latest = [...history].reverse().find((item) => item.toNode === "generate_hypotheses");
  if (!latest) {
    return false;
  }
  const source = latest.sourceNode;
  if (source === "review" || source === "analyze_results") {
    return true;
  }
  const reason = String(latest.reason || "").toLowerCase();
  return (
    reason.includes("research_memo") ||
    reason.includes("claims outpace") ||
    reason.includes("outcomes do not support") ||
    reason.includes("evidence")
  );
}

function isWeakEvidenceSeed(evidence: EvidenceRow): boolean {
  return evidence.source_type === "abstract" || estimateEvidenceAdjustment(evidence) <= -0.75;
}
