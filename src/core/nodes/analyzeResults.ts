import path from "node:path";

import { promises as fs } from "node:fs";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { safeRead, writeRunArtifact } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";
import { LongTermStore } from "../memory/longTermStore.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import { publishPublicRunOutputs } from "../publicOutputPublisher.js";
import {
  buildOperatorHistoryRelativePath,
  renderOperatorHistoryMarkdown,
  renderOperatorSummaryMarkdown
} from "../operatorSummary.js";
import {
  evaluateObjectiveMetric,
  normalizeObjectiveMetricProfile,
  ObjectiveMetricEvaluation,
  resolveObjectiveMetricProfile
} from "../objectiveMetric.js";
import {
  AnalysisFailureCategory,
  AnalysisReport,
  buildAnalysisReport,
  buildPersistedAnalysisMetricsProjection,
  resolvePrimaryResultsArtifactComparison,
  renderPerformanceFigureSvg
} from "../resultAnalysis.js";
import { buildAnalyzeResultsCompletionSummary } from "../resultAnalysisPresentation.js";
import { synthesizeAnalysisReport } from "../resultAnalysisSynthesis.js";
import { RunVerifierReport } from "../experiments/runVerifierFeedback.js";
import { ExperimentPortfolio, ExperimentRunManifest } from "../experiments/experimentPortfolio.js";
import { detectPreflightOnlyMetrics } from "../experiments/executedMetrics.js";
import type { ExperimentContract } from "../experiments/experimentContract.js";
import { GraphNodeId, RunRecord, TransitionRecommendation } from "../../types.js";
import { runAnalyzeResultsPanel } from "../analyzeResultsPanel.js";
import {
  clearPendingHumanInterventionRequest,
  createHumanInterventionRequest,
  HumanInterventionRequest,
  readPendingHumanInterventionRequest,
  writeHumanInterventionRequest
} from "../humanIntervention.js";
import { withHumanInterventionRunLock } from "../humanInterventionLock.js";
import { loadExperimentContract } from "../experiments/experimentContract.js";
import {
  deriveGovernedAnalysisDecision,
  ExperimentComparisonContract,
  getGovernedObjectiveProfile,
  loadExperimentComparisonContract,
  loadExperimentImplementationContext,
  loadExperimentManagedBundleLock,
  storeExperimentGovernanceDecision,
  validateManagedBundleLock
} from "../experimentGovernance.js";
import {
  buildAttemptDecision,
  writeAttemptDecision,
  type AttemptDecisionVerdict
} from "../experiments/attemptDecision.js";
import { evaluateBriefEvidenceAgainstResults } from "../analysis/briefEvidenceValidator.js";
import { parseResearchGapEvidenceRows } from "../analysis/researchGapEvidenceChain.js";
import { parseMarkdownRunBriefSections } from "../runs/runBriefParser.js";
import { resolveResearchRunModeGuard } from "../runs/researchRunModeGuard.js";
import { withTopicProbePromotionSourceLock } from "../topicProbeFollowupRun.js";
import { buildRunOperatorStatus } from "../runs/runStatus.js";
import { buildRunCompletenessChecklist } from "../runs/runCompletenessChecklist.js";
import { buildBaselineComparisonSurface } from "../baselineComparisonSurface.js";
import {
  checkResultsContractCompleteness,
  validateResultsTableSchema,
  type ResultsTableSchema
} from "../analysis/resultsTableSchema.js";
import {
  projectResultsArtifactV2,
  type ResultsArtifactProjectionResult
} from "../analysis/resultsArtifactProjection.js";
import {
  detectNaNInf,
  detectStatisticalAnomaly,
  detectUnverifiedCitations,
  type RiskSignal
} from "../analysis/riskSignals.js";
import {
  checkCaptionConsistency,
  checkFigureEvidenceScale,
  lintFigures,
  type FigureAuditInput
} from "../analysis/figureAuditor.js";
import { resolveExplorationConfig } from "../exploration/explorationConfig.js";
import { loadBaselineLock } from "../exploration/baselineLock.js";
import { loadResearchTree } from "../exploration/researchTree.js";
import { buildWriteupInputManifest } from "../exploration/evidenceSerializer.js";
import { projectPortableArtifactValue } from "../../utils/portableArtifact.js";
import {
  buildTopicProbeOutcomeDecision,
  type TopicProbeOutcomeDecision
} from "../topicProbeOutcome.js";
import {
  loadTopicProbeOutcomeArtifacts,
  TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS,
  TOPIC_PROBE_OUTCOME_RELATIVE_PATH
} from "../topicProbeOutcomeArtifacts.js";
import {
  hashCanonical,
  type TopicPortfolio
} from "../researchFunnel.js";
import type { ActiveTopicProbeContract } from "../activeTopicProbeContract.js";
import {
  buildVenueViabilityReport,
  validateVenueViabilityReport,
  VENUE_VIABILITY_REPORT_RELATIVE_PATH,
  type VenueViabilityReport
} from "../venueViability.js";
import {
  buildTopicMemoryDatabasePath,
  TopicMemoryStore
} from "../runs/topicMemoryStore.js";
import type { TopicKillPublicReasonCode } from "../topicMemory.js";
import {
  reassessEvidenceAdequacyArtifacts,
  type EvidenceAdequacyAuthorization
} from "../analysis/evidenceAdequacyArtifacts.js";

export function createAnalyzeResultsNode(deps: NodeExecutionDeps): GraphNodeHandler {
  return {
    id: "analyze_results",
    async execute({ run }) {
      const longTermStore = new LongTermStore(run.memoryRefs.longTermPath);
      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      const runDir = path.join(process.cwd(), ".autolabos", "runs", run.id);
      const comparisonContract = await loadExperimentComparisonContract(run, runContextMemory);
      const experimentContract = await loadExperimentContract(run.id);
      const implementationContext = await loadExperimentImplementationContext(run, runContextMemory);
      const managedBundleLock = await loadExperimentManagedBundleLock(run, runContextMemory);
      const publicDir =
        resolveMaybeRelative(
          await runContextMemory.get<string>("implement_experiments.public_dir"),
          process.cwd()
        ) || undefined;
      const configuredMetricsPath =
        resolveMaybeRelative(
          await runContextMemory.get<string>("implement_experiments.metrics_path"),
          process.cwd()
        );
      const runLocalMetricsPath = path.join(".autolabos", "runs", run.id, "metrics.json");
      const metricsPath = selectAnalysisMetricsPath({
        workspaceRoot: process.cwd(),
        configuredPath: configuredMetricsPath,
        runLocalPath: runLocalMetricsPath,
        runLocalExists: await fileExists(runLocalMetricsPath)
      });
      let metrics: Record<string, unknown> = {};
      const inputWarnings: string[] = [];
      let metricsLoadError: string | undefined;
      try {
        const raw = await fs.readFile(metricsPath, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("metrics.json must decode to an object");
        }
        metrics = parsed as Record<string, unknown>;
      } catch (error) {
        metrics = {};
        metricsLoadError = `Structured result analysis requires a valid metrics file at ${metricsPath}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        inputWarnings.push(metricsLoadError);
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "analyze_results",
          payload: { text: metricsLoadError }
        });
      }
      const publicMetricsRecovery = await maybePromoteCompletedPublicMetrics({
        metrics,
        metricsPath,
        publicDir,
        warnings: inputWarnings
      });
      if (publicMetricsRecovery.promoted) {
        metrics = publicMetricsRecovery.metrics;
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "analyze_results",
          payload: { text: publicMetricsRecovery.message }
        });
      }
      metrics = await hydrateDetailedExperimentMetrics(metrics, publicDir, inputWarnings);
      const preflightOnlyMetricsMessage = detectPreflightOnlyMetrics(metrics);
      const analysisMetrics = preflightOnlyMetricsMessage ? {} : metrics;
      if (preflightOnlyMetricsMessage) {
        inputWarnings.push(preflightOnlyMetricsMessage);
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "analyze_results",
          payload: { text: preflightOnlyMetricsMessage }
        });
      }
      const managedBundleValidation = await validateManagedBundleLock({
        contract: comparisonContract,
        managedBundleLock,
        implementationContext,
        metrics,
        publicDir,
        workspaceRoot: process.cwd()
      });
      if (managedBundleValidation) {
        await storeExperimentGovernanceDecision(run, runContextMemory, {
          driftReport: managedBundleValidation.report,
          entries: []
        });
      }
      if (managedBundleValidation && !managedBundleValidation.ok) {
        inputWarnings.push(managedBundleValidation.rationale);
      } else if (
        managedBundleValidation?.report.findings.some((finding) => finding.severity === "warn")
      ) {
        inputWarnings.push(managedBundleValidation.report.summary);
      }

      const manualObjectiveClarification =
        (await runContextMemory.get<string>("analyze_results.objective_clarification"))?.trim() || undefined;
      const lockedObjectiveProfile = getGovernedObjectiveProfile(comparisonContract, run.objectiveMetric);
      if (lockedObjectiveProfile && manualObjectiveClarification) {
        inputWarnings.push(
          "Ignored analyze_results.objective_clarification because a locked experiment evaluator contract is active."
        );
      }
      const effectiveObjectiveMetric =
        lockedObjectiveProfile
          ? lockedObjectiveProfile.raw
          : manualObjectiveClarification || run.objectiveMetric;
      const objectiveProfileBase =
        lockedObjectiveProfile ||
        (await resolveObjectiveMetricProfile({
          run: {
            ...run,
            objectiveMetric: effectiveObjectiveMetric
          },
          runContextMemory,
          llm: deps.llm,
          eventStream: deps.eventStream,
          node: "analyze_results"
        }));
      const objectiveProfile =
        !lockedObjectiveProfile && manualObjectiveClarification
          ? normalizeObjectiveMetricProfile(
              {
                ...objectiveProfileBase,
                assumptions: [
                  `Human clarification: ${manualObjectiveClarification}`,
                  ...objectiveProfileBase.assumptions
                ]
              },
              effectiveObjectiveMetric
            )
          : objectiveProfileBase;
      const resultsArtifactProjection = projectResultsArtifactV2({
        metrics: analysisMetrics,
        primaryMetricId: objectiveProfile.primaryMetric,
        preferredMetricIds: objectiveProfile.preferredMetricKeys,
        fallbackDirection:
          objectiveProfile.direction === "minimize"
            ? "lower_better"
            : "higher_better",
        evidenceRef: publicDir ? "../experiment/metrics.json" : "metrics.json"
      });
      const resultsArtifactProjectionMessages = uniqueStrings([
        ...resultsArtifactProjection.issues,
        ...resultsArtifactProjection.warnings
      ]);
      if (resultsArtifactProjectionMessages.length > 0) {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "analyze_results",
          payload: {
            text: `Results artifact projection (${resultsArtifactProjection.source}): ${resultsArtifactProjectionMessages.join(" ")}`
          }
        });
      }
      const cachedEvaluation =
        await runContextMemory.get<ObjectiveMetricEvaluation>("objective_metric.last_evaluation");
      // Always re-evaluate in analyze_results because detailed result hydration
      // can expose evidence that run_experiments did not have.
      const objectiveEvaluation = preflightOnlyMetricsMessage
        ? {
            rawObjectiveMetric: effectiveObjectiveMetric,
            profileSource: objectiveProfile.source,
            primaryMetric: objectiveProfile.primaryMetric,
            preferredMetricKeys: objectiveProfile.preferredMetricKeys,
            direction: objectiveProfile.direction,
            comparator: objectiveProfile.comparator,
            targetValue: objectiveProfile.targetValue,
            status: "missing" as const,
            summary: preflightOnlyMetricsMessage
          }
        : evaluateObjectiveMetric(analysisMetrics, objectiveProfile, effectiveObjectiveMetric);
      await writeRunArtifact(
        run,
        "objective_evaluation.json",
        JSON.stringify(objectiveEvaluation, null, 2)
      );
      if (
        !cachedEvaluation ||
        cachedEvaluation.status !== objectiveEvaluation.status ||
        cachedEvaluation.matchedMetricKey !== objectiveEvaluation.matchedMetricKey
      ) {
        await runContextMemory.put("objective_metric.last_evaluation", objectiveEvaluation);
        if (cachedEvaluation?.status === "unknown" || cachedEvaluation?.status === "missing") {
          deps.eventStream.emit({
            type: "OBS_RECEIVED",
            runId: run.id,
            node: "analyze_results",
            payload: {
              text: `Objective metric re-evaluated automatically: ${objectiveEvaluation.summary}`
            }
          });
        }
      }

      const experimentPlanRaw = await safeRead(path.join(".autolabos", "runs", run.id, "experiment_plan.yaml"));
      const observationsRaw = await safeRead(
        path.join(".autolabos", "runs", run.id, "exec_logs", "observations.jsonl")
      );
      const runVerifierReport = await readJsonObject<RunVerifierReport>(
        path.join(".autolabos", "runs", run.id, "run_experiments_verify_report.json"),
        inputWarnings,
        "run_experiments_verify_report.json"
      );
      const experimentPortfolio =
        (await readJsonObject<ExperimentPortfolio>(
          path.join(".autolabos", "runs", run.id, "experiment_portfolio.json"),
          inputWarnings,
          "experiment_portfolio.json"
        )) || undefined;
      const runManifest =
        (await readJsonObject<ExperimentRunManifest>(
          path.join(".autolabos", "runs", run.id, "run_manifest.json"),
          inputWarnings,
          "run_manifest.json"
        )) || undefined;
      const evidenceAdequacyReassessment =
        await reassessEvidenceAdequacyArtifacts({
          runDir,
          evidenceRoots: [
            path.dirname(metricsPath),
            runDir,
            resolveMaybeRelative(
              await runContextMemory.get<string>("run_experiments.cwd"),
              process.cwd()
            ),
            publicDir
          ],
          expectedPrimaryComparisonId:
            experimentContract?.results_plan.primary_comparison_id,
          requireStoredAssessment: true
        });
      inputWarnings.push(...evidenceAdequacyReassessment.warnings);
      const supplementalMetrics = await loadSupplementalMetrics(publicDir, inputWarnings);
      const supplementalExpectation = await loadSupplementalExpectation(run.id, inputWarnings);
      const recentPaperComparisonPath =
        resolveMaybeRelative(asString(metrics.recent_paper_reproducibility_path), publicDir || process.cwd()) ||
        (publicDir ? path.join(publicDir, "recent_paper_reproducibility.json") : undefined);
      const recentPaperComparison =
        (recentPaperComparisonPath &&
          (await readJsonObject<Record<string, unknown>>(
            recentPaperComparisonPath,
            inputWarnings,
            "recent_paper_reproducibility.json"
          ))) ||
        undefined;
      const analysisRunVerifierReport =
        preflightOnlyMetricsMessage && runVerifierReport?.status !== "fail"
          ? undefined
          : runVerifierReport;
      let summary = buildAnalysisReport({
        run,
        metrics: analysisMetrics,
        objectiveProfile,
        objectiveEvaluation,
        experimentPlanRaw,
        observationsRaw,
        inputWarnings,
        runVerifierReport: analysisRunVerifierReport,
        experimentPortfolio,
        runManifest,
        supplementalMetrics,
        supplementalExpectation,
        recentPaperComparison,
        recentPaperComparisonPath,
        resultsArtifactProjection,
        resultsPlan: experimentContract?.results_plan,
        primaryComparisonId: experimentContract?.results_plan.primary_comparison_id
      });
      if (evidenceAdequacyReassessment.assessment) {
        summary.evidence_adequacy_assessment =
          evidenceAdequacyReassessment.assessment;
      }
      if (evidenceAdequacyReassessment.issues.length > 0) {
        summary.warnings = uniqueStrings([
          ...summary.warnings,
          ...evidenceAdequacyReassessment.issues
        ]);
        summary.failure_taxonomy = [
          ...summary.failure_taxonomy,
          {
            id: "evidence_adequacy_reassessment_failed",
            category: "evidence_gap",
            severity: "high",
            status: "observed",
            summary:
              "The frozen evidence adequacy contract could not be revalidated against current execution artifacts.",
            evidence: evidenceAdequacyReassessment.issues,
            recommended_action:
              "Restore or rerun the contract-bound primary evidence and regenerate the canonical execution receipt before paper-scale review."
          }
        ];
      }
      const resultsArtifactValidation = buildResultsArtifactValidation({
        report: summary,
        experimentContract,
        comparisonContract,
        projection: resultsArtifactProjection
      });
      if (!resultsArtifactValidation.valid) {
        const newValidationIssues = resultsArtifactValidation.issues.filter(
          (issue) => !summary.warnings.includes(issue)
        );
        inputWarnings.push(...newValidationIssues);
        summary.warnings = [...summary.warnings, ...newValidationIssues];
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "analyze_results",
          payload: {
            text: `Results artifact validation: ${resultsArtifactValidation.issues.join(" ")}`
          }
        });
      }
      const resourceEvidenceGate = evaluateRequiredResourceEvidence({
        summary,
        experimentContract
      });
      if (resourceEvidenceGate.status === "fail") {
        inputWarnings.push(resourceEvidenceGate.summary);
        summary.warnings = [...summary.warnings, resourceEvidenceGate.summary];
        summary.failure_taxonomy = [
          ...summary.failure_taxonomy,
          {
            id: "missing_required_resource_metrics",
            category: "evidence_gap",
            severity: "high",
            status: "observed",
            summary: resourceEvidenceGate.summary,
            evidence: [
              `Required resource categories: ${resourceEvidenceGate.requiredCategories.join(", ")}.`,
              `Observed numeric resource metric keys: ${
                resourceEvidenceGate.observedMetricKeys.length > 0
                  ? resourceEvidenceGate.observedMetricKeys.slice(0, 6).join(", ")
                  : "none"
              }.`,
              `Missing resource categories: ${resourceEvidenceGate.missingCategories.join(", ")}.`
            ],
            recommended_action:
              "Regenerate or repair the experiment runner so numeric runtime and memory metrics are persisted with the completed results."
          }
        ];
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "analyze_results",
          payload: {
            text: `Resource evidence gate: ${resourceEvidenceGate.summary}`
          }
        });
      }
      const evidenceStore = await readJsonlRecords(path.join(".autolabos", "runs", run.id, "evidence_store.jsonl"));
      const riskSignals = [
        detectNaNInf(metrics),
        detectStatisticalAnomaly(metrics),
        detectUnverifiedCitations(evidenceStore)
      ].filter((signal): signal is RiskSignal => Boolean(signal));
      if (riskSignals.length > 0) {
        const riskWarnings = riskSignals.map((signal) => signal.detail);
        inputWarnings.push(...riskWarnings);
        summary.warnings = [...summary.warnings, ...riskWarnings];
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "analyze_results",
          payload: {
            text: `Risk signals detected: ${riskWarnings.join(" ")}`
          }
        });
      }
      const hasNumericMetrics = summary.metric_table.length > 0;
      const noNumericMetrics = !hasNumericMetrics && resultsArtifactValidation.valid;
      if (!metricsLoadError && hasNumericMetrics) {
        summary.synthesis = await synthesizeAnalysisReport({
          run,
          report: summary,
          llm: deps.llm,
          eventStream: deps.eventStream,
          node: "analyze_results"
        });
      }
      const rawBrief = await runContextMemory.get<string>("run_brief.raw");
      const researchModeGuard = await resolveResearchRunModeGuard({
        workspaceRoot: process.cwd(),
        runId: run.id,
        rawBrief,
        run
      });
      await runContextMemory.put("research_governance.mode_guard", researchModeGuard);
      await writeRunArtifact(
        run,
        "governance/research_mode_guard.json",
        `${JSON.stringify(researchModeGuard, null, 2)}\n`
      );
      if (!researchModeGuard.valid) {
        const error =
          "analyze_results blocked because the persisted research mode and evidence lineage do not agree: "
          + researchModeGuard.reasons.join(", ");
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "analyze_results",
          payload: { text: error }
        });
        return {
          status: "failure",
          error,
          summary: error,
          toolCallsUsed: 0
        };
      }
      const researchMode = researchModeGuard.effectiveMode;
      const briefSections = rawBrief ? parseMarkdownRunBriefSections(rawBrief) : undefined;
      const briefEvidenceAssessment = evaluateBriefEvidenceAgainstResults({
        briefSections: briefSections ?? undefined,
        report: summary
      });
      if (briefEvidenceAssessment.enabled && briefEvidenceAssessment.status === "fail") {
        inputWarnings.push(briefEvidenceAssessment.summary);
        summary.warnings = [...summary.warnings, briefEvidenceAssessment.summary];
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "analyze_results",
          payload: {
            text: `Brief evidence gate: ${briefEvidenceAssessment.summary}`
          }
        });
      }
      const evidenceAssessmentPath = await writeRunArtifact(
        run,
        "analysis/evidence_scale_assessment.json",
        `${JSON.stringify(briefEvidenceAssessment, null, 2)}\n`
      );
      await runContextMemory.put("analyze_results.brief_evidence_assessment", briefEvidenceAssessment);
      const topicProbeOutcomeState =
        researchMode === "topic_discovery"
          ? await evaluateAndPersistTopicProbeOutcome(
              run,
              summary,
              evidenceAdequacyReassessment.authorization
            )
          : undefined;
      if (topicProbeOutcomeState) {
        await runContextMemory.put(
          "analyze_results.topic_probe_outcome",
          topicProbeOutcomeState.decision || null
        );
        await runContextMemory.put(
          "analyze_results.topic_probe_outcome_gate",
          topicProbeOutcomeState.gate
        );
        await runContextMemory.put(
          "analyze_results.venue_viability",
          topicProbeOutcomeState.venueViability || null
        );
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "analyze_results",
          payload: {
            text: topicProbeOutcomeState.valid
              ? `Bounded topic-probe outcome: ${topicProbeOutcomeState.decision?.disposition}. Review remains mandatory before any follow-up run.`
              : `Bounded topic-probe outcome validation blocked: ${topicProbeOutcomeState.reasons.join(", ")}. Review must route repair; paper drafting is forbidden.`
          }
        });
        if (topicProbeOutcomeState.completionFailure) {
          const completionFailure = topicProbeOutcomeState.completionFailure;
          const blockedTransitionRecommendation =
            buildTopicProbeReviewGateRecommendation(topicProbeOutcomeState);
          summary.transition_recommendation = blockedTransitionRecommendation;
          summary.metrics = buildPersistedAnalysisMetricsProjection(
            summary.metrics,
            publicDir ? "../experiment/metrics.json" : "metrics.json"
          );
          summary = projectPortableArtifactValue(summary);
          await writeRunArtifact(
            run,
            "result_analysis.json",
            `${JSON.stringify(summary, null, 2)}\n`
          );
          await writeRunArtifact(
            run,
            "transition_recommendation.json",
            `${JSON.stringify(blockedTransitionRecommendation, null, 2)}\n`
          );
          await runContextMemory.put("analyze_results.last_summary", summary);
          await runContextMemory.put("analyze_results.last_error", completionFailure.error);
          await runContextMemory.put(
            "analyze_results.last_transition",
            blockedTransitionRecommendation
          );
          deps.eventStream.emit({
            type: "OBS_RECEIVED",
            runId: run.id,
            node: "analyze_results",
            payload: { text: completionFailure.error }
          });
          return {
            status: "failure",
            failureKind: completionFailure.failureKind,
            error: completionFailure.error,
            summary: completionFailure.error,
            toolCallsUsed: 1,
            transitionRecommendation: blockedTransitionRecommendation
          };
        }
      }
      const governanceDecision =
        comparisonContract &&
        deriveGovernedAnalysisDecision({
          report: summary,
          contract: comparisonContract,
          implementationContext,
          managedBundleValidation
        });
      if (governanceDecision) {
        await storeExperimentGovernanceDecision(run, runContextMemory, {
          baselineSnapshot: governanceDecision.baselineSnapshot,
          entries: governanceDecision.baselineEntry
            ? [governanceDecision.baselineEntry, governanceDecision.candidateEntry]
            : [governanceDecision.candidateEntry]
        });
      }
      const baselineTransitionRecommendation = buildTransitionRecommendation(summary);
      const governedTransitionRecommendation = applyGovernanceTransitionOverride(
        baselineTransitionRecommendation,
        governanceDecision,
        summary,
        comparisonContract
      );
      const gatedTransitionRecommendation = applyBriefEvidenceTransitionOverride(
        governedTransitionRecommendation,
        briefEvidenceAssessment,
        summary
      );
      const panelResult = runAnalyzeResultsPanel({
        report: summary,
        baselineRecommendation: gatedTransitionRecommendation
      });
      const baselinePanelTransitionRecommendation = applyRiskSignalTransitionOverride(
        applyRequiredResourceEvidenceTransitionOverride(
          applyResultsArtifactTransitionOverride(
            panelResult.recommendation,
            resultsArtifactValidation,
            summary
          ),
          resourceEvidenceGate,
          summary
        ),
        riskSignals,
        summary
      );
      const transitionRecommendation = topicProbeOutcomeState
        ? buildTopicProbeReviewGateRecommendation(topicProbeOutcomeState)
        : baselinePanelTransitionRecommendation;
      const humanInterventionRequest = buildAnalyzeResultsHumanInterventionRequest({
        run,
        report: summary,
        transitionRecommendation
      });
      summary.transition_recommendation = transitionRecommendation;
      summary.metrics = buildPersistedAnalysisMetricsProjection(
        summary.metrics,
        publicDir ? "../experiment/metrics.json" : "metrics.json"
      );
      summary = projectPortableArtifactValue(summary);

      await writeRunArtifact(
        run,
        "analyze_results_panel/inputs.json",
        JSON.stringify(panelResult.inputs, null, 2)
      );
      await writeRunArtifact(
        run,
        "analyze_results_panel/reviews.json",
        JSON.stringify(panelResult.reviews, null, 2)
      );
      await writeRunArtifact(
        run,
        "analyze_results_panel/scorecard.json",
        JSON.stringify(panelResult.scorecard, null, 2)
      );
      await writeRunArtifact(
        run,
        "analyze_results_panel/decision.json",
        JSON.stringify(panelResult.decision, null, 2)
      );
      const riskSignalsPath = await writeRunArtifact(
        run,
        "analysis/risk_signals.json",
        `${JSON.stringify(riskSignals, null, 2)}\n`
      );
      const resultAnalysisPath = await writeRunArtifact(run, "result_analysis.json", JSON.stringify(summary, null, 2));
      const explorationFigureConfig = resolveExplorationConfig({
        workspaceRoot: process.cwd(),
        appConfig: deps.config
      }).figure_auditor;
      if (explorationFigureConfig.enabled) {
        const figureAuditInput = await buildFigureAuditInput({
          runDir: path.join(process.cwd(), ".autolabos", "runs", run.id),
          resultAnalysisPath: path.join(process.cwd(), resultAnalysisPath)
        });
        const gateOneTwoIssues = [
          ...(await lintFigures(figureAuditInput)),
          ...(await checkCaptionConsistency(figureAuditInput)),
          ...(await checkFigureEvidenceScale(figureAuditInput))
        ];
        await writeRunArtifact(
          run,
          "figure_audit/gate1_gate2_issues.json",
          `${JSON.stringify(gateOneTwoIssues, null, 2)}\n`
        );
      }

      const resultTablePath = await writeRunArtifact(
        run,
        "result_table.json",
        `${JSON.stringify(summary.results_artifact, null, 2)}\n`
      );
      const baselineComparisonSurface = buildBaselineComparisonSurface({
        runId: run.id,
        report: summary,
        baselineLock: loadBaselineLock(runDir),
        comparisonId: experimentContract?.results_plan.primary_comparison_id
      });
      const baselineComparisonPath = await writeRunArtifact(
        run,
        "baseline_comparison.json",
        `${JSON.stringify(baselineComparisonSurface, null, 2)}\n`
      );

      // --- Attempt decision artifact (Target 4) ---
      const attemptNumber = (run.graph.retryCounters.analyze_results ?? 0) + 1;
      const objectiveStatus = summary.overview?.objective_status;
      const metricImproved = objectiveStatus === "met";
      const blockingDesignFailures = (summary.failure_taxonomy ?? []).filter(
        (failure) =>
          (failure.category === "evidence_gap" || failure.category === "scope_limit") && failure.severity !== "low"
      );
      const hasBlockingDesignFailure = blockingDesignFailures.length > 0;
      const topicProbeVerdict = topicProbeOutcomeState
        ? topicProbeOutcomeState.decision
          ? mapTopicProbeOutcomeToAttemptVerdict(topicProbeOutcomeState.decision)
          : "needs_design_revision"
        : undefined;
      const verdict: AttemptDecisionVerdict = topicProbeVerdict
        ?? (hasBlockingDesignFailure
          ? "needs_design_revision"
          : objectiveStatus === "met"
            ? "keep"
            : objectiveStatus === "not_met"
              ? "discard"
              : "needs_replication");
      const attemptDecision = buildAttemptDecision({
        runId: run.id,
        attempt: attemptNumber,
        verdict,
        rationale: topicProbeOutcomeState?.decision
          ? `Bounded probe disposition ${topicProbeOutcomeState.decision.disposition}: ${topicProbeOutcomeState.decision.reason_codes.join(", ")}.`
          : summary.overview?.objective_summary || "No objective summary available.",
        evidenceRefs: [
          resultAnalysisPath,
          ...(topicProbeOutcomeState?.outcomePath ? [topicProbeOutcomeState.outcomePath] : [])
        ],
        metricName: run.objectiveMetric,
        metricImproved,
        discardReason: verdict === "discard"
          ? `Objective metric ${run.objectiveMetric} not met: ${summary.overview?.objective_summary || "unknown"}.`
          : undefined,
        designRevisionNote: verdict === "needs_design_revision"
          ? `Evidence or scope gaps detected: ${blockingDesignFailures.map((failure) => failure.category).join(", ")}.`
          : undefined,
        replicationNote: verdict === "needs_replication"
          ? "Objective status unknown; replication needed to confirm."
          : undefined
      });
      await writeAttemptDecision(run, attemptDecision);

      let synthesisPath: string | undefined;
      if (summary.synthesis) {
        synthesisPath = await writeRunArtifact(
          run,
          "result_analysis_synthesis.json",
          JSON.stringify(summary.synthesis, null, 2)
        );
      }
      const transitionPath = await writeRunArtifact(
        run,
        "transition_recommendation.json",
        JSON.stringify(transitionRecommendation, null, 2)
      );
      const operatorSummaryInput = {
        runId: run.id,
        title: run.title,
        stage: "analysis" as const,
        summary: [
          buildAnalyzeResultsCompletionSummary(summary),
          `Next governed gate: ${transitionRecommendation.targetNode || "figure_audit"} via ${transitionRecommendation.action}.`
        ],
        decision: `Transition recommendation: ${transitionRecommendation.action}${transitionRecommendation.targetNode ? ` -> ${transitionRecommendation.targetNode}` : ""}. ${transitionRecommendation.reason}`,
        blockers: (summary.failure_taxonomy || []).slice(0, 3).map((item) => item.summary),
        openQuestions: (summary.synthesis?.discussion_points || []).slice(0, 3),
        nextActions:
          (summary.synthesis?.follow_up_actions || []).slice(0, 3).length > 0
            ? (summary.synthesis?.follow_up_actions || []).slice(0, 3)
            : [transitionRecommendation.reason, "Run figure_audit and inspect the figure audit summary before treating the run as paper-ready."],
        references: [
          { label: "Analysis report", path: "result_analysis.json" },
          { label: "Baseline comparison", path: "baseline_comparison.json" },
          { label: "Transition recommendation", path: "transition_recommendation.json" },
          { label: "Latest results", path: "latest_results.json" },
          { label: "Risk signals", path: "analysis/risk_signals.json" }
          ,...(topicProbeOutcomeState
            ? [
                { label: "Topic probe outcome gate", path: "analysis/topic_probe_outcome_gate.json" },
                ...(topicProbeOutcomeState.outcomePath
                  ? [{ label: "Topic probe outcome", path: TOPIC_PROBE_OUTCOME_RELATIVE_PATH }]
                  : []),
                ...(topicProbeOutcomeState.venueViabilityPath
                  ? [{ label: "Venue viability", path: VENUE_VIABILITY_REPORT_RELATIVE_PATH }]
                  : []),
                ...(topicProbeOutcomeState.topicMemoryUpdatePath
                  ? [{ label: "Topic memory update", path: "analysis/topic_memory_update.json" }]
                  : [])
              ]
            : [])
        ]
      };
      const operatorSummaryPath = await writeRunArtifact(
        run,
        "operator_summary.md",
        renderOperatorSummaryMarkdown(operatorSummaryInput)
      );
      const operatorHistoryPath = await writeRunArtifact(
        run,
        buildOperatorHistoryRelativePath("analysis"),
        renderOperatorHistoryMarkdown(operatorSummaryInput)
      );
      const runStatus = await buildRunOperatorStatus({
        workspaceRoot: process.cwd(),
        run,
        currentNode: "analyze_results",
        approvalMode: deps.config?.workflow?.approval_mode || "minimal",
        networkPolicy: deps.config?.experiments?.network_policy,
        networkPurpose: deps.config?.experiments?.network_purpose
      });
      const runStatusPath = await writeRunArtifact(
        run,
        "run_status.json",
        `${JSON.stringify(runStatus, null, 2)}\n`
      );
      const figureSvg = renderPerformanceFigureSvg(summary);
      let performanceFigurePath: string | undefined;
      if (figureSvg) {
        performanceFigurePath = await writeRunArtifact(run, "figures/performance.svg", figureSvg);
      }
      const publicOutputs = await publishPublicRunOutputs({
        workspaceRoot: process.cwd(),
        run,
        node: "analyze_results",
        runContext: runContextMemory,
        section: "analysis",
        files: [
          {
            sourcePath: resultAnalysisPath,
            targetRelativePath: "result_analysis.json"
          },
          {
            sourcePath: synthesisPath || path.join(process.cwd(), ".autolabos", "runs", run.id, "result_analysis_synthesis.json"),
            targetRelativePath: "result_analysis_synthesis.json",
            optional: true
          },
          {
            sourcePath: transitionPath,
            targetRelativePath: "transition_recommendation.json"
          },
          {
            sourcePath: performanceFigurePath || path.join(process.cwd(), ".autolabos", "runs", run.id, "figures", "performance.svg"),
            targetRelativePath: "figures/performance.svg",
            optional: true
          },
          {
            sourcePath: resultTablePath,
            targetRelativePath: "result_table.json",
            optional: true
          },
          {
            sourcePath: baselineComparisonPath,
            targetRelativePath: "baseline_comparison.json"
          },
          {
            sourcePath: path.join(process.cwd(), ".autolabos", "runs", run.id, "baseline_summary.json"),
            targetRelativePath: "baseline_summary.json",
            optional: true
          },
          {
            sourcePath: evidenceAssessmentPath,
            targetRelativePath: "evidence_scale_assessment.json",
            optional: true
          },
          {
            sourcePath: riskSignalsPath,
            targetRelativePath: "risk_signals.json",
            optional: true
          },
          {
            sourcePath:
              topicProbeOutcomeState?.gatePath
              || path.join(process.cwd(), ".autolabos", "runs", run.id, "analysis", "topic_probe_outcome_gate.json"),
            targetRelativePath: "topic_probe_outcome_gate.json",
            optional: true
          },
          {
            sourcePath:
              topicProbeOutcomeState?.outcomePath
              || path.join(process.cwd(), ".autolabos", "runs", run.id, TOPIC_PROBE_OUTCOME_RELATIVE_PATH),
            targetRelativePath: "topic_probe_outcome.json",
            optional: true
          },
          {
            sourcePath:
              topicProbeOutcomeState?.venueViabilityPath
              || path.join(process.cwd(), ".autolabos", "runs", run.id, VENUE_VIABILITY_REPORT_RELATIVE_PATH),
            targetRelativePath: "venue_viability.json",
            optional: true
          },
          {
            sourcePath:
              topicProbeOutcomeState?.topicMemoryUpdatePath
              || path.join(process.cwd(), ".autolabos", "runs", run.id, "analysis", "topic_memory_update.json"),
            targetRelativePath: "topic_memory_update.json",
            optional: true
          }
        ]
      });
      await publishPublicRunOutputs({
        workspaceRoot: process.cwd(),
        run,
        node: "analyze_results",
        section: "results",
        files: [
          {
            sourcePath: operatorSummaryPath,
            targetRelativePath: "operator_summary.md"
          },
          {
            sourcePath: operatorHistoryPath,
            targetRelativePath: buildOperatorHistoryRelativePath("analysis")
          },
          {
            sourcePath: runStatusPath,
            targetRelativePath: "run_status.json"
          }
        ]
      });
      const completenessChecklist = await buildRunCompletenessChecklist({
        workspaceRoot: process.cwd(),
        run,
        currentNode: "analyze_results"
      });
      const completenessChecklistPath = await writeRunArtifact(
        run,
        "run_completeness_checklist.json",
        `${JSON.stringify(completenessChecklist, null, 2)}\n`
      );
      const explorationConfig = resolveExplorationConfig({
        workspaceRoot: process.cwd(),
        appConfig: deps.config
      });
      if (explorationConfig.enabled) {
        const runDir = path.join(process.cwd(), ".autolabos", "runs", run.id);
        const tree = loadResearchTree(runDir);
        if (tree) {
          const promotedNode = Object.values(tree.nodes).find(
            (node) =>
              (node.status === "promoted" || node.promotion_decision?.promoted === true) &&
              node.evidence_manifest?.is_executed === true
          );
          if (promotedNode) {
            buildWriteupInputManifest({
              promotedBranchId: promotedNode.node_id,
              runDir,
              tree
            });
          }
        }
      }
      await publishPublicRunOutputs({
        workspaceRoot: process.cwd(),
        run,
        node: "analyze_results",
        section: "results",
        files: [
          {
            sourcePath: completenessChecklistPath,
            targetRelativePath: "run_completeness_checklist.json"
          }
        ]
      });
      deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: "analyze_results",
        payload: {
          text: `Public analysis outputs are available at ${publicOutputs.sectionDirRelative}.`
        }
      });
      await runContextMemory.put("analyze_results.last_summary", summary);
      await runContextMemory.put("analyze_results.last_error", metricsLoadError || null);
      await runContextMemory.put("analyze_results.last_synthesis", summary.synthesis || null);
      await runContextMemory.put("analyze_results.last_transition", transitionRecommendation);
      await runContextMemory.put("analyze_results.baseline_comparison", baselineComparisonSurface);
      await runContextMemory.put("analyze_results.risk_signals", riskSignals);
      await runContextMemory.put("analyze_results.experiment_portfolio", summary.experiment_portfolio || null);
      await runContextMemory.put("analyze_results.panel_decision", panelResult.decision);
      await withHumanInterventionRunLock(
        {
          workspaceRoot: process.cwd(),
          runId: run.id
        },
        async () => {
          if (humanInterventionRequest) {
            await writeHumanInterventionRequest({
              workspaceRoot: process.cwd(),
              run,
              runContext: runContextMemory,
              request: humanInterventionRequest
            });
          } else {
            const pendingRequest = await readPendingHumanInterventionRequest(runContextMemory);
            if (pendingRequest?.sourceNode === "analyze_results") {
              await clearPendingHumanInterventionRequest(runContextMemory);
            }
          }
        }
      );
      await longTermStore.append({
        runId: run.id,
        category: "results",
        text: `Result summary: ${buildAnalyzeResultsCompletionSummary(summary)} Evidence: ${resultAnalysisPath}.`,
        tags: ["analyze_results"]
      });

      if (metricsLoadError || preflightOnlyMetricsMessage || noNumericMetrics) {
        const error =
          metricsLoadError ||
          preflightOnlyMetricsMessage ||
          `Structured result analysis requires at least one numeric metric in ${metricsPath}.`;
        if (!metricsLoadError) {
          deps.eventStream.emit({
            type: "OBS_RECEIVED",
            runId: run.id,
            node: "analyze_results",
            payload: { text: error }
          });
          await runContextMemory.put("analyze_results.last_error", error);
        }
        return {
          status: "failure",
          error,
          summary: error,
          toolCallsUsed: 1
        };
      }

      return {
        status: "success",
        summary: `${buildAnalyzeResultsCompletionSummary(summary)} Panel-calibrated transition confidence: ${transitionRecommendation.confidence}. Public outputs: ${publicOutputs.outputRootRelative}.`,
        needsApproval: true,
        toolCallsUsed: 1,
        transitionRecommendation
      };
    }
  };
}

interface TopicProbeOutcomeGateArtifact {
  schema_version: 1;
  artifact_kind: "topic_probe_outcome_gate";
  run_id: string;
  research_cycle: number;
  status: "decided" | "blocked_invalid_artifact_chain";
  disposition: TopicProbeOutcomeDecision["disposition"] | null;
  outcome_content_sha256: string | null;
  reason_codes: string[];
  venue_viability_report_contract_version?: 1;
  content_sha256: string;
}

interface TopicProbeOutcomeAnalysisState {
  valid: boolean;
  reasons: string[];
  decision?: TopicProbeOutcomeDecision;
  gate: TopicProbeOutcomeGateArtifact;
  gatePath: string;
  outcomePath?: string;
  venueViability?: VenueViabilityReport;
  venueViabilityPath?: string;
  topicMemoryUpdatePath?: string;
  completionFailure?: TopicProbeOutcomeCompletionFailure;
}

interface TopicProbeOutcomeCompletionFailure {
  failureKind: "retryable" | "gate_blocked" | "environment";
  error: string;
}

async function evaluateAndPersistTopicProbeOutcome(
  run: RunRecord,
  report: AnalysisReport,
  evidenceAdequacyAuthorization: EvidenceAdequacyAuthorization | undefined
): Promise<TopicProbeOutcomeAnalysisState> {
  return withTopicProbePromotionSourceLock({
    workspaceRoot: process.cwd(),
    runId: run.id,
    operation: () => evaluateAndPersistTopicProbeOutcomeUnlocked(
      run,
      report,
      evidenceAdequacyAuthorization
    )
  });
}

async function evaluateAndPersistTopicProbeOutcomeUnlocked(
  run: RunRecord,
  report: AnalysisReport,
  evidenceAdequacyAuthorization: EvidenceAdequacyAuthorization | undefined
): Promise<TopicProbeOutcomeAnalysisState> {
  const sourceValidation = await loadTopicProbeOutcomeArtifacts({
    workspaceRoot: process.cwd(),
    runId: run.id,
    expectedResearchCycle: run.graph.researchCycle,
    requireOutcome: false,
    report
  });
  const reasons = [...sourceValidation.reasons];
  let decision: TopicProbeOutcomeDecision | undefined;
  let outcomePath: string | undefined;
  let venueViability: VenueViabilityReport | undefined;
  let venueViabilityPath: string | undefined;
  let topicMemoryUpdatePath: string | undefined;
  let completionFailure: TopicProbeOutcomeCompletionFailure | undefined;

  if (sourceValidation.valid && sourceValidation.contract) {
    try {
      const candidateDecision = buildTopicProbeOutcomeDecision({
        contract: sourceValidation.contract,
        report,
        evidenceAdequacyAuthorization
      });
      outcomePath = await writeRunArtifact(
        run,
        TOPIC_PROBE_OUTCOME_RELATIVE_PATH,
        `${JSON.stringify(candidateDecision, null, 2)}\n`
      );
      const verified = await loadTopicProbeOutcomeArtifacts({
        workspaceRoot: process.cwd(),
        runId: run.id,
        expectedResearchCycle: run.graph.researchCycle,
        requireOutcome: true,
        report,
        evidenceAdequacyAuthorization
      });
      if (verified.valid && verified.decision) {
        decision = verified.decision;
        if (!verified.portfolio || !verified.contract) {
          throw new Error("verified_topic_candidate_context_missing");
        }
        const matchingCandidates = verified.portfolio.candidates.filter(
          (candidate) =>
            candidate.source_candidate_id === verified.contract?.candidate_id
            && candidate.topic_id === verified.contract?.topic_id
        );
        if (matchingCandidates.length !== 1) {
          throw new Error(
            matchingCandidates.length === 0
              ? "verified_topic_candidate_missing"
              : "verified_topic_candidate_ambiguous"
          );
        }
        const builtVenueViability = buildVenueViabilityReport({
          candidate: matchingCandidates[0],
          contract: verified.contract,
          outcome: decision
        });
        const venueValidation = validateVenueViabilityReport(
          JSON.stringify(builtVenueViability),
          {
            candidate: matchingCandidates[0],
            contract: verified.contract,
            outcome: decision
          }
        );
        if (!venueValidation.valid) {
          throw new Error(
            "venue_viability_self_validation_failed:"
            + venueValidation.reasons.join(",")
          );
        }
        venueViability = builtVenueViability;
        venueViabilityPath = await writeRunArtifact(
          run,
          VENUE_VIABILITY_REPORT_RELATIVE_PATH,
          JSON.stringify(venueViability, null, 2) + "\n"
        );
        if (decision.disposition === "reject_candidate") {
          try {
            if (!verified.portfolio || !verified.contract) {
              throw new Error("verified_topic_candidate_context_missing");
            }
            topicMemoryUpdatePath = await persistRejectedTopicMemory({
              run,
              portfolio: verified.portfolio,
              contract: verified.contract,
              decision
            });
          } catch (error) {
            completionFailure = classifyTopicMemoryPersistenceFailure(error);
            reasons.push(completionFailure.error);
          }
        }
      } else {
        reasons.push(...verified.reasons);
      }
    } catch (error) {
      reasons.push(
        `topic_probe_outcome_build_failed:${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const uniqueReasons = uniqueStrings(reasons);
  const valid = Boolean(decision) && uniqueReasons.length === 0;
  const gatePayload: Omit<TopicProbeOutcomeGateArtifact, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "topic_probe_outcome_gate",
    run_id: run.id,
    research_cycle: run.graph.researchCycle,
    status: valid ? "decided" : "blocked_invalid_artifact_chain",
    disposition: valid ? decision?.disposition || null : null,
    outcome_content_sha256: valid ? decision?.content_sha256 || null : null,
    reason_codes: valid
      ? [...(decision?.reason_codes || [])]
      : uniqueReasons.length > 0
        ? uniqueReasons
        : ["topic_probe_outcome_unavailable"],
    ...(venueViabilityPath
      ? { venue_viability_report_contract_version: 1 as const }
      : {})
  };
  const gate: TopicProbeOutcomeGateArtifact = {
    ...gatePayload,
    content_sha256: hashCanonical(gatePayload)
  };
  const gatePath = await writeRunArtifact(
    run,
    "analysis/topic_probe_outcome_gate.json",
    `${JSON.stringify(gate, null, 2)}\n`
  );

  return {
    valid,
    reasons: valid ? [] : gate.reason_codes,
    decision,
    gate,
    gatePath,
    outcomePath,
    venueViability,
    venueViabilityPath,
    topicMemoryUpdatePath,
    completionFailure
  };
}

async function persistRejectedTopicMemory(input: {
  run: RunRecord;
  portfolio: TopicPortfolio;
  contract: ActiveTopicProbeContract;
  decision: TopicProbeOutcomeDecision;
}): Promise<string> {
  const candidate = input.portfolio.candidates.find(
    (item) =>
      item.source_candidate_id === input.contract.candidate_id
      && item.topic_id === input.contract.topic_id
      && item.content_sha256 === input.contract.candidate_content_sha256
  );
  if (!candidate?.topic_memory?.descriptor) {
    throw new Error("topic_memory_candidate_descriptor_missing");
  }
  const snapshot = input.portfolio.topic_memory_ledger;
  if (!snapshot) {
    throw new Error("topic_memory_portfolio_snapshot_missing");
  }
  const publicReasonCodes = mapRejectedOutcomeToTopicMemoryReasons(
    input.decision
  );
  const sourceFullTextEvidenceIds = await resolveRejectedTopicEvidenceIds({
    run: input.run,
    candidate
  });
  const store = new TopicMemoryStore(
    buildTopicMemoryDatabasePath(process.cwd())
  );
  let update: {
    status: "appended" | "already_present";
    previousLedgerSha256: string;
    currentLedgerSha256: string;
    recordSha256: string;
  };
  try {
    const current = store.loadLedger();
    if (!ledgerHasSnapshotPrefix(current, snapshot)) {
      throw new Error("topic_memory_portfolio_snapshot_not_ancestor");
    }
    const appended = store.appendIdempotent({
      descriptor: candidate.topic_memory.descriptor,
      kill_scope: "exact_formulation",
      disposition_category: "bounded_probe_rejected",
      public_reason_codes: publicReasonCodes,
      source_run_id: input.run.id,
      source_research_cycle: input.run.graph.researchCycle,
      source_full_text_evidence_ids: sourceFullTextEvidenceIds,
      source_topic_content_sha256: candidate.content_sha256,
      source_decision_content_sha256: input.decision.content_sha256
    }, current.ledger_sha256);
    const persistedRecord = appended.ledger.records.find(
      (record) => record.record_sha256 === appended.record_sha256
    );
    if (!persistedRecord) {
      throw new Error("topic_memory_store_persisted_record_missing");
    }
    if (
      JSON.stringify(persistedRecord.source_full_text_evidence_ids)
        !== JSON.stringify(sourceFullTextEvidenceIds)
    ) {
      throw new Error("topic_memory_store_persisted_evidence_mismatch");
    }
    update = {
      status: appended.appended ? "appended" : "already_present",
      previousLedgerSha256: appended.previous_ledger_sha256,
      currentLedgerSha256: appended.ledger.ledger_sha256,
      recordSha256: appended.record_sha256
    };
  } finally {
    store.close();
  }
  const payload = {
    schema_version: 1 as const,
    artifact_kind: "topic_memory_update" as const,
    run_id: input.run.id,
    research_cycle: input.run.graph.researchCycle,
    status: update.status,
    source_portfolio_content_sha256: input.portfolio.content_sha256,
    source_decision_content_sha256: input.decision.content_sha256,
    source_candidate_content_sha256: candidate.content_sha256,
    topic_lineage_id: candidate.topic_lineage_id || candidate.topic_id,
    formulation_id: candidate.formulation_id || "",
    public_reason_codes: publicReasonCodes,
    source_full_text_evidence_ids: sourceFullTextEvidenceIds,
    previous_ledger_sha256: update.previousLedgerSha256,
    current_ledger_sha256: update.currentLedgerSha256,
    record_sha256: update.recordSha256
  };
  return await writeRunArtifact(
    input.run,
    "analysis/topic_memory_update.json",
    `${JSON.stringify({
      ...payload,
      content_sha256: hashCanonical(payload)
    }, null, 2)}\n`
  );
}

async function resolveRejectedTopicEvidenceIds(input: {
  run: RunRecord;
  candidate: TopicPortfolio["candidates"][number];
}): Promise<string[]> {
  const evidencePath = path.join(
    process.cwd(),
    ".autolabos",
    "runs",
    input.run.id,
    TOPIC_PROBE_ARTIFACT_RELATIVE_PATHS.evidenceStore
  );
  const evidenceRaw = await safeRead(evidencePath);
  if (!evidenceRaw.trim()) {
    throw new Error("topic_memory_reject_evidence_store_missing");
  }
  const parsed = parseResearchGapEvidenceRows(evidenceRaw);
  if (parsed.malformedRowCount > 0) {
    throw new Error("topic_memory_reject_evidence_store_invalid_jsonl");
  }
  const linkedEvidenceIds = uniqueStrings(input.candidate.evidence_links);
  if (linkedEvidenceIds.length === 0) {
    throw new Error("topic_memory_reject_evidence_ids_missing");
  }
  const rowsByEvidenceId = new Map<string, typeof parsed.rows>();
  for (const row of parsed.rows) {
    const evidenceId = asString(row.evidence_id);
    if (!evidenceId) {
      continue;
    }
    const rows = rowsByEvidenceId.get(evidenceId) || [];
    rows.push(row);
    rowsByEvidenceId.set(evidenceId, rows);
  }
  const linkedRows = linkedEvidenceIds.map((evidenceId) => {
    const rows = rowsByEvidenceId.get(evidenceId) || [];
    if (rows.length === 0) {
      throw new Error("topic_memory_reject_evidence_id_unresolved");
    }
    if (rows.length > 1) {
      throw new Error("topic_memory_reject_evidence_id_ambiguous");
    }
    return rows[0];
  });
  const closestPriorPaperIds = new Set(
    input.candidate.closest_prior_full_text_paper_ids
  );
  const verifiedRows = linkedRows.filter((row) => {
    const paperId = asString(row.paper_id);
    return Boolean(
      paperId
      && closestPriorPaperIds.has(paperId)
      && row.source_type === "full_text"
      && (row.source_scope === "full_text_excerpt" || row.source_scope === "full_document")
      && row.grounding_status === "grounded_span"
      && asString(row.evidence_span)
    );
  });
  const independentWorkIds = new Set(
    verifiedRows
      .map((row) => asString(row.canonical_work_id) || asString(row.paper_id))
      .filter((value): value is string => Boolean(value))
  );
  if (independentWorkIds.size < 2) {
    throw new Error(
      "topic_memory_reject_independent_full_text_evidence_insufficient"
    );
  }
  const evidenceIds = uniqueStrings(
    verifiedRows
      .map((row) => asString(row.evidence_id))
      .filter((value): value is string => Boolean(value))
  );
  if (evidenceIds.length < 2) {
    throw new Error("topic_memory_reject_evidence_ids_insufficient");
  }
  return evidenceIds;
}

function classifyTopicMemoryPersistenceFailure(
  error: unknown
): TopicProbeOutcomeCompletionFailure {
  const message = error instanceof Error ? error.message : String(error);
  const failureKind: TopicProbeOutcomeCompletionFailure["failureKind"] =
    message.startsWith("topic_memory_reject_evidence_")
    || message.startsWith("topic_memory_reject_independent_")
    || message.startsWith("topic_memory_candidate_")
    || message.startsWith("topic_memory_portfolio_")
    || message.startsWith("verified_topic_")
    || message === "topic_memory_reject_reason_unmapped"
    || message.includes("idempotent_conflict")
      ? "gate_blocked"
      : message.includes("compare_and_swap")
        || message.includes("SQLITE_BUSY")
        || message.toLowerCase().includes("database is locked")
        ? "retryable"
        : "environment";
  return {
    failureKind,
    error: `topic_memory_reject_persist_failed:${message}`
  };
}

function mapRejectedOutcomeToTopicMemoryReasons(
  decision: TopicProbeOutcomeDecision
): TopicKillPublicReasonCode[] {
  const reasons: TopicKillPublicReasonCode[] = [];
  if (decision.reason_codes.includes("effect_floor_not_met")) {
    reasons.push("bounded_probe_effect_floor_not_met");
  }
  if (decision.reason_codes.includes("hypothesis_not_supported")) {
    reasons.push("bounded_probe_hypothesis_not_supported");
  }
  if (reasons.length === 0) {
    throw new Error("topic_memory_reject_reason_unmapped");
  }
  return reasons;
}

function ledgerHasSnapshotPrefix(
  current: NonNullable<TopicPortfolio["topic_memory_ledger"]>,
  snapshot: NonNullable<TopicPortfolio["topic_memory_ledger"]>
): boolean {
  return current.records.length >= snapshot.records.length
    && snapshot.records.every(
      (record, index) =>
        current.records[index]?.record_sha256 === record.record_sha256
    );
}

function buildTopicProbeReviewGateRecommendation(
  state: TopicProbeOutcomeAnalysisState
): TransitionRecommendation {
  if (state.completionFailure) {
    const retryable = state.completionFailure.failureKind !== "gate_blocked";
    return createRecommendation({
      action: retryable ? "retry_same" : "pause_for_human",
      targetNode: retryable ? "analyze_results" : undefined,
      reason: retryable
        ? "The bounded-probe rejection is not complete because its topic-memory record was not durably persisted. Repair the storage failure and retry analyze_results; do not advance to figure_audit."
        : "The bounded-probe rejection lacks independently verifiable full-text evidence IDs or a valid topic-memory binding. Repair the upstream evidence chain before retrying; do not advance to figure_audit.",
      confidence: 1,
      autoExecutable: state.completionFailure.failureKind === "retryable",
      evidence: uniqueStrings([
        "analysis/topic_probe_outcome_gate.json",
        ...(state.outcomePath ? [TOPIC_PROBE_OUTCOME_RELATIVE_PATH] : []),
        state.completionFailure.error
      ])
    });
  }
  const disposition = state.decision?.disposition;
  return createRecommendation({
    action: "advance",
    targetNode: "figure_audit",
    reason: state.valid
      ? `The bounded topic probe was classified as ${disposition}; advance only to figure_audit and structural review. This probe cannot authorize write_paper or paper-scale claims.`
      : "The topic-probe artifact chain or outcome is invalid; advance only to structural review so the failure is recorded and routed upstream. Paper drafting is forbidden.",
    confidence: 0.99,
    autoExecutable: true,
    evidence: uniqueStrings([
      "analysis/topic_probe_outcome_gate.json",
      ...(state.outcomePath ? [TOPIC_PROBE_OUTCOME_RELATIVE_PATH] : []),
      ...state.reasons.slice(0, 4)
    ])
  });
}

function mapTopicProbeOutcomeToAttemptVerdict(
  decision: TopicProbeOutcomeDecision
): AttemptDecisionVerdict {
  if (decision.disposition === "reject_candidate") {
    return "discard";
  }
  if (decision.disposition === "blocked_invalid_evidence") {
    return "needs_design_revision";
  }
  return "needs_replication";
}

async function buildFigureAuditInput(input: {
  runDir: string;
  resultAnalysisPath: string;
}): Promise<FigureAuditInput> {
  const paperTexPath = path.join(input.runDir, "paper", "main.tex");
  const paperTexContent = await safeRead(paperTexPath);
  return {
    run_dir: input.runDir,
    figure_dir: null,
    paper_tex_content: paperTexContent || null,
    result_analysis_path: input.resultAnalysisPath
  };
}

function buildAnalyzeResultsHumanInterventionRequest(input: {
  run: { id: string; currentNode: GraphNodeId };
  report: AnalysisReport;
  transitionRecommendation: TransitionRecommendation;
}): HumanInterventionRequest | undefined {
  if (input.report.overview.objective_status === "unknown") {
    const metricKeys = input.report.metric_table.map((item) => item.key);
    return createHumanInterventionRequest({
      sourceNode: "analyze_results",
      kind: "objective_metric_clarification",
      title: "Clarify the objective metric",
      question:
        'Which metric or recovery path should govern the next step? Reply with a metric criterion (for example, "primary_outcome >= target") or choose a declared recovery route.',
      context: [
        input.report.overview.objective_summary,
        metricKeys.length > 0
          ? `Available numeric metrics: ${metricKeys.join(", ")}.`
          : "No numeric metrics were available for automatic grounding."
      ],
      inputMode: "free_text",
      resumeAction: "retry_current",
      choices: [
        {
          id: "revise_design",
          label: "Return to experiment design",
          description: "Revise the metric contract, comparator, or evaluation design before analyzing again.",
          answerAliases: ["design", "design_experiments", "revise design", "설계"],
          resumeAction: "jump",
          targetNode: "design_experiments"
        },
        {
          id: "inspect_implementation",
          label: "Return to implementation",
          description: "Inspect metric emission or execution wiring before analyzing again.",
          answerAliases: ["implementation", "implement_experiments", "inspect implementation", "구현"],
          resumeAction: "jump",
          targetNode: "implement_experiments"
        }
      ]
    });
  }

  if (
    input.transitionRecommendation.action === "backtrack_to_hypotheses" &&
    !input.transitionRecommendation.autoExecutable
  ) {
    return createHumanInterventionRequest({
      sourceNode: "analyze_results",
      kind: "transition_choice",
      title: "Choose the next recovery step",
      question: "Choose how the run should continue.",
      context: [
        input.transitionRecommendation.reason,
        ...input.transitionRecommendation.evidence.slice(0, 3)
      ],
      inputMode: "single_choice",
      resumeAction: "apply_transition",
      choices: [
        {
          id: "revisit_hypotheses",
          label: "Backtrack to generate_hypotheses",
          description: "Follow the current recommendation and revisit the hypothesis set.",
          answerAliases: ["hypotheses", "generate_hypotheses"]
        },
        {
          id: "revise_design",
          label: "Jump to design_experiments",
          description: "Keep the current hypothesis set and revise only the experiment design.",
          answerAliases: ["design", "design_experiments"],
          resumeAction: "jump",
          targetNode: "design_experiments"
        },
        {
          id: "inspect_implementation",
          label: "Jump to implement_experiments",
          description: "Inspect implementation and execution details before changing the hypothesis.",
          answerAliases: ["implement", "implement_experiments"],
          resumeAction: "jump",
          targetNode: "implement_experiments"
        }
      ]
    });
  }

  return undefined;
}

async function loadSupplementalMetrics(publicDir: string | undefined, warnings: string[]): Promise<
  Array<{
    profile: string;
    path?: string;
    metrics: Record<string, unknown>;
  }>
> {
  if (!publicDir) {
    return [];
  }

  const results: Array<{
    profile: string;
    path?: string;
    metrics: Record<string, unknown>;
  }> = [];

  for (const [profile, fileName] of [
    ["confirmatory", "confirmatory_metrics.json"],
    ["quick_check", "quick_check_metrics.json"]
  ] as const) {
    const filePath = path.join(publicDir, fileName);
    const parsed = await readJsonObject<Record<string, unknown>>(filePath, warnings, fileName);
    if (parsed) {
      results.push({
        profile,
        path: filePath,
        metrics: parsed
      });
    }
  }

  return results;
}

async function loadSupplementalExpectation(
  runId: string,
  warnings: string[]
): Promise<
  | {
      applicable: boolean;
      profiles: string[];
      reason?: string;
    }
  | undefined
> {
  const explicitExpectation = await readJsonObject<{
    applicable?: boolean;
    profiles?: string[];
    reason?: string;
  }>(
    path.join(".autolabos", "runs", runId, "run_experiments_supplemental_expectation.json"),
    warnings,
    "run_experiments_supplemental_expectation.json",
    { ignoreNull: true }
  );
  if (explicitExpectation) {
    return {
      applicable: explicitExpectation.applicable !== false,
      profiles: asArray(explicitExpectation.profiles)
        .map((item) => asString(item))
        .filter((item): item is string => Boolean(item)),
      reason: asString(explicitExpectation.reason)
    };
  }

  const executionPlan = await readJsonObject<Record<string, unknown>>(
    path.join(".autolabos", "runs", runId, "run_experiments_panel", "execution_plan.json"),
    warnings,
    "execution_plan.json"
  );
  if (!executionPlan) {
    return undefined;
  }

  const managedProfiles = asArray(executionPlan.managed_supplemental_profiles)
    .map((item) => asRecord(item))
    .map((item) => asString(item.profile))
    .filter((item): item is string => Boolean(item));

  if (managedProfiles.length > 0) {
    return {
      applicable: true,
      profiles: managedProfiles,
      reason: `Managed supplemental profiles were configured for this runner: ${managedProfiles.join(", ")}.`
    };
  }

  return {
    applicable: false,
    profiles: [],
    reason:
      "Managed quick_check and confirmatory profiles were not configured for this experiment runner, so the repeated standard trials are the complete executed design."
  };
}

async function readJsonObject<T extends object>(
  filePath: string,
  warnings: string[],
  label: string,
  options: { ignoreNull?: boolean } = {}
): Promise<T | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null && options.ignoreNull) {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must decode to an object`);
    }
    return parsed as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ENOENT/u.test(message)) {
      warnings.push(`Failed to parse ${label}: ${message}`);
    }
    return undefined;
  }
}

async function maybePromoteCompletedPublicMetrics(input: {
  metrics: Record<string, unknown>;
  metricsPath: string;
  publicDir: string | undefined;
  warnings: string[];
}): Promise<{ metrics: Record<string, unknown>; promoted: false } | {
  metrics: Record<string, unknown>;
  promoted: true;
  message: string;
}> {
  if (!input.publicDir || !shouldRecoverAnalysisMetrics(input.metrics)) {
    return { metrics: input.metrics, promoted: false };
  }

  const candidates = await loadPublicMetricsCandidates(input.publicDir, input.warnings);
  const best = candidates
    .filter((candidate) => isCompletedAnalysisMetrics(candidate.metrics))
    .sort((left, right) => scoreAnalysisMetrics(right.metrics) - scoreAnalysisMetrics(left.metrics))[0];
  if (!best || scoreAnalysisMetrics(best.metrics) <= scoreAnalysisMetrics(input.metrics)) {
    return { metrics: input.metrics, promoted: false };
  }

  const message = [
    `Primary metrics at ${input.metricsPath} looked failed or empty for analysis.`,
    `Using completed public experiment metrics from ${best.path} instead.`
  ].join(" ");
  input.warnings.push(message);
  return {
    metrics: best.metrics,
    promoted: true,
    message
  };
}

async function loadPublicMetricsCandidates(
  publicDir: string,
  warnings: string[]
): Promise<Array<{ path: string; metrics: Record<string, unknown> }>> {
  const candidatePaths = [
    path.join(publicDir, "metrics.json"),
    path.join(publicDir, "latest_metrics.json"),
    path.join(publicDir, "metrics_snapshot.json"),
    path.join(publicDir, "latest_metrics_snapshot.json"),
    path.join(publicDir, "study_metrics.json")
  ];
  const candidates: Array<{ path: string; metrics: Record<string, unknown> }> = [];
  for (const candidatePath of candidatePaths) {
    const metrics = await readJsonObject<Record<string, unknown>>(
      candidatePath,
      warnings,
      path.basename(candidatePath)
    );
    if (metrics) {
      candidates.push({ path: candidatePath, metrics });
    }
  }
  return candidates;
}

function shouldRecoverAnalysisMetrics(metrics: Record<string, unknown>): boolean {
  if (Object.keys(metrics).length === 0) {
    return true;
  }
  return isFailedAnalysisMetrics(metrics) || scoreAnalysisMetrics(metrics) === 0;
}

function isCompletedAnalysisMetrics(metrics: Record<string, unknown>): boolean {
  return !isFailedAnalysisMetrics(metrics) && scoreAnalysisMetrics(metrics) > 0;
}

function isFailedAnalysisMetrics(metrics: Record<string, unknown>): boolean {
  const status = asString(metrics.status)?.toLowerCase();
  return Boolean(
    status && ["failed", "failure", "error", "errored"].includes(status)
  );
}

function scoreAnalysisMetrics(metrics: Record<string, unknown>): number {
  const directCompleted = asNumber(metrics.completed_condition_count);
  const plannedCompleted = asNumber(metrics.fully_completed_condition_count);
  const completedConditionCount = Math.max(directCompleted ?? 0, plannedCompleted ?? 0);
  if (completedConditionCount > 0) {
    return completedConditionCount;
  }
  const conditions = Array.isArray(metrics.conditions) ? metrics.conditions.length : 0;
  const conditionResults = Array.isArray(metrics.condition_results)
    ? metrics.condition_results.length
    : Object.keys(asRecord(metrics.condition_results)).length;
  const perCondition = Array.isArray(metrics.per_condition)
    ? metrics.per_condition.length
    : Object.keys(asRecord(metrics.per_condition)).length;
  return Math.max(conditions, conditionResults, perCondition);
}

export async function hydrateDetailedExperimentMetrics(
  metrics: Record<string, unknown>,
  publicDir: string | undefined,
  warnings: string[] = []
): Promise<Record<string, unknown>> {
  if (Object.keys(metrics).length === 0) {
    return metrics;
  }

  const aliased = aliasCompactMetrics(metrics);
  const resultsPath = resolveDetailedResultsPath(metrics, publicDir);
  if (!resultsPath) {
    return enrichMetricsWithDetailedResults(aliased, {});
  }

  const detailedResults = await readJsonObject<Record<string, unknown>>(
    resultsPath,
    warnings,
    path.basename(resultsPath) || "latest_results.json"
  );
  if (!detailedResults) {
    return enrichMetricsWithDetailedResults(aliased, {});
  }

  return enrichMetricsWithDetailedResults(aliased, detailedResults);
}

function resolveDetailedResultsPath(
  metrics: Record<string, unknown>,
  publicDir: string | undefined
): string | undefined {
  const explicit = resolveMaybeRelative(asString(metrics.results_path), publicDir || process.cwd());
  if (explicit) {
    return explicit;
  }
  if (!publicDir) {
    return undefined;
  }
  return path.join(publicDir, "latest_results.json");
}

function aliasCompactMetrics(metrics: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...metrics };
  const metricAlias = asString(metrics.metric);
  const metricValue = asNumber(metrics.value);
  if (metricAlias && typeof metricValue === "number" && next[metricAlias] === undefined) {
    next[metricAlias] = metricValue;
  }
  return next;
}

const DETAILED_CONDITION_ROW_KEYS = [
  "conditions",
  "condition_results",
  "condition_summaries",
  "per_condition"
] as const;
const CONDITION_IDENTIFIER_KEYS = new Set(["condition_id", "condition", "name", "id"]);

interface ConditionHydration {
  conditionMetrics: Record<string, Record<string, unknown>>;
  primaryCondition?: string;
  baselineCondition?: string;
}

function enrichMetricsWithDetailedResults(
  metrics: Record<string, unknown>,
  detailedResults: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...detailedResults, ...metrics };
  const globalMetrics = {
    ...asRecord(detailedResults.global_metrics),
    ...asRecord(metrics.global_metrics)
  };
  if (Object.keys(globalMetrics).length > 0) {
    next.global_metrics = globalMetrics;
  }
  for (const [key, value] of Object.entries(globalMetrics)) {
    if (isScalarJsonValue(value) && next[key] === undefined) {
      next[key] = value;
    }
  }

  const protocol = {
    ...asRecord(detailedResults.protocol),
    ...asRecord(metrics.protocol)
  };
  if (Object.keys(protocol).length > 0) {
    next.protocol = protocol;
  }
  const samplingProfile = {
    ...asRecord(detailedResults.sampling_profile),
    ...asRecord(metrics.sampling_profile)
  };
  if (Object.keys(samplingProfile).length > 0) {
    next.sampling_profile = samplingProfile;
  }

  const detailedHydration = collectConditionHydration(detailedResults);
  const metricsHydration = collectConditionHydration(metrics);
  const conditionMetrics = mergeConditionMetricMaps(
    detailedHydration.conditionMetrics,
    metricsHydration.conditionMetrics
  );
  if (Object.keys(conditionMetrics).length > 0) {
    next.condition_metrics = conditionMetrics;
  }

  if (!asConditionIdentifier(next.primary_condition)) {
    const primaryCondition = metricsHydration.primaryCondition || detailedHydration.primaryCondition;
    if (primaryCondition) {
      next.primary_condition = primaryCondition;
    }
  }
  if (!asConditionIdentifier(next.baseline_condition)) {
    const baselineCondition = metricsHydration.baselineCondition || detailedHydration.baselineCondition;
    if (baselineCondition) {
      next.baseline_condition = baselineCondition;
    }
  }

  return next;
}

function collectConditionHydration(artifact: Record<string, unknown>): ConditionHydration {
  const conditionMetrics: Record<string, Record<string, unknown>> = {};
  let rowPrimaryCondition: string | undefined;
  let rowBaselineCondition: string | undefined;

  for (const key of DETAILED_CONDITION_ROW_KEYS) {
    for (const rawRow of asArray(artifact[key])) {
      const row = asRecord(rawRow);
      const conditionId = resolveConditionIdentifier(row);
      if (!conditionId) {
        continue;
      }
      conditionMetrics[conditionId] = {
        ...conditionMetrics[conditionId],
        ...normalizeConditionRowMetrics(row)
      };
      const role = asString(row.role)?.toLowerCase();
      if (role === "primary" && !rowPrimaryCondition) {
        rowPrimaryCondition = conditionId;
      }
      if (role === "baseline" && !rowBaselineCondition) {
        rowBaselineCondition = conditionId;
      }
    }
  }

  let mapPrimaryCondition: string | undefined;
  let mapBaselineCondition: string | undefined;
  for (const [rawConditionId, rawMetrics] of Object.entries(asRecord(artifact.condition_metrics))) {
    const conditionId = asConditionIdentifier(rawConditionId);
    if (!conditionId || !isRecordObject(rawMetrics)) {
      continue;
    }
    conditionMetrics[conditionId] = {
      ...conditionMetrics[conditionId],
      ...rawMetrics
    };
    const role = asString(rawMetrics.role)?.toLowerCase();
    if (role === "primary" && !mapPrimaryCondition) {
      mapPrimaryCondition = conditionId;
    }
    if (role === "baseline" && !mapBaselineCondition) {
      mapBaselineCondition = conditionId;
    }
  }

  return {
    conditionMetrics,
    primaryCondition: mapPrimaryCondition || rowPrimaryCondition,
    baselineCondition: mapBaselineCondition || rowBaselineCondition
  };
}

function mergeConditionMetricMaps(
  ...maps: Array<Record<string, Record<string, unknown>>>
): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const conditionMetrics of maps) {
    for (const [conditionId, values] of Object.entries(conditionMetrics)) {
      merged[conditionId] = { ...merged[conditionId], ...values };
    }
  }
  return merged;
}

function resolveConditionIdentifier(row: Record<string, unknown>): string | undefined {
  for (const key of CONDITION_IDENTIFIER_KEYS) {
    const conditionId = asConditionIdentifier(row[key]);
    if (conditionId) {
      return conditionId;
    }
  }
  return undefined;
}

function asConditionIdentifier(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function normalizeConditionRowMetrics(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...asRecord(row.metrics) };
  for (const [key, value] of Object.entries(row)) {
    if (key === "metrics" || CONDITION_IDENTIFIER_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): string[] {
  return asArray(value)
    .map((item) => asString(item))
    .filter((item): item is string => Boolean(item));
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isScalarJsonValue(value: unknown): value is string | number | boolean | null {
  return value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function resolveMaybeRelative(value: string | undefined, workspaceRoot: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.join(workspaceRoot, value);
}

export function selectAnalysisMetricsPath(input: {
  workspaceRoot: string;
  configuredPath?: string;
  runLocalPath: string;
  runLocalExists: boolean;
}): string {
  if (input.configuredPath && isPathWithin(input.workspaceRoot, input.configuredPath)) {
    return input.configuredPath;
  }
  if (input.runLocalExists) {
    return input.runLocalPath;
  }
  return input.configuredPath || input.runLocalPath;
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonlRecords(filePath: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return [];
          }
          return [parsed as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildTransitionRecommendation(summary: AnalysisReport): TransitionRecommendation {
  const runtimeFailure = findFailure(summary.failure_taxonomy, "runtime_failure");
  if (runtimeFailure || summary.verifier_feedback?.status === "fail") {
    return createRecommendation({
      action: "backtrack_to_implement",
      targetNode: "implement_experiments",
      reason:
        runtimeFailure?.summary ||
        `Verifier requested another implementation pass: ${summary.verifier_feedback?.summary || "runtime failure"}.`,
      confidence: 0.93,
      autoExecutable: true,
      evidence: collectEvidence(
        summary,
        runtimeFailure?.summary,
        summary.verifier_feedback?.suggested_next_action,
        summary.synthesis?.follow_up_actions?.[0]
      )
    });
  }

  if (summary.overview.objective_status === "missing") {
    return createRecommendation({
      action: "backtrack_to_implement",
      targetNode: "implement_experiments",
      reason:
        "The run did not record the objective metric needed for evaluation, so implementation should export the expected metric before another analysis pass.",
      confidence: 0.9,
      autoExecutable: true,
      evidence: collectEvidence(
        summary,
        summary.overview.objective_summary,
        summary.failure_taxonomy.find((item) => item.id === "missing_numeric_metrics")?.summary,
        summary.synthesis?.follow_up_actions?.[0]
      )
    });
  }

  if (summary.overview.objective_status === "unknown") {
    return createRecommendation({
      action: "pause_for_human",
      reason:
        "The objective metric could not be matched to a concrete numeric metric key, so the run needs manual clarification before proceeding.",
      confidence: 0.86,
      autoExecutable: false,
      evidence: collectEvidence(
        summary,
        summary.overview.objective_summary,
        summary.synthesis?.confidence_statement,
        summary.synthesis?.follow_up_actions?.[0]
      )
    });
  }

  const executedTrials = summary.statistical_summary.executed_trials;
  const cachedTrials = summary.statistical_summary.cached_trials ?? 0;
  if (
    (summary.overview.objective_status === "met" || summary.overview.objective_status === "observed") &&
    executedTrials === 0 &&
    cachedTrials > 0
  ) {
    return createRecommendation({
      action: "backtrack_to_implement",
      targetNode: "implement_experiments",
      reason:
        "The metric snapshot was rebuilt entirely from cached trials, so the run should rerun implementation/execution and persist fresh trial records before review.",
      confidence: 0.94,
      autoExecutable: true,
      evidence: collectEvidence(
        summary,
        summary.overview.objective_summary,
        `Sampling profile recorded executed_trials=0 and cached_trials=${cachedTrials}.`,
        summary.synthesis?.follow_up_actions?.[0]
      )
    });
  }

  if (summary.overview.objective_status === "not_met") {
    if (isDeferredFullCycleObjective(summary)) {
      const objectiveMetrics = asRecord(summary.metrics.metrics);
      const objectiveNotes = asRecord(objectiveMetrics.notes);
      return createRecommendation({
        action: "advance",
        targetNode: "figure_audit",
        reason:
          "The objective metric is lifecycle-terminal and still provisional at analyze_results, so the run should continue into review/write_paper before deciding another implementation loop.",
        confidence: 0.74,
        autoExecutable: true,
        evidence: collectEvidence(
          summary,
          summary.overview.objective_summary,
          asString(objectiveNotes.full_cycle_completed),
          summary.synthesis?.follow_up_actions?.[0]
        )
      });
    }
    const primaryComparison = resolvePrimaryResultsArtifactComparison(
      summary.results_artifact,
      summary.primary_comparison_id
    );
    const supportedComparison = primaryComparison?.hypothesis_supported === true;
    const unsupportedComparison = primaryComparison?.hypothesis_supported === false;
    const evidenceGap = findFailure(summary.failure_taxonomy, "evidence_gap", ["observed", "risk"]);
    const scopeLimit = findFailure(summary.failure_taxonomy, "scope_limit", ["observed", "risk"]);
    const unsupportedSummary = unsupportedComparison ? primaryComparison?.summary : undefined;
    const strongHypothesisReset = Boolean(unsupportedSummary) && !evidenceGap;

    if (!supportedComparison && unsupportedComparison) {
      return createRecommendation({
        action: "backtrack_to_hypotheses",
        targetNode: "generate_hypotheses",
        reason:
          "Current experiment outcomes do not support the shortlisted hypothesis, so the loop should revisit the idea set.",
        confidence: strongHypothesisReset ? 0.9 : 0.72,
        autoExecutable: strongHypothesisReset,
        evidence: collectEvidence(
          summary,
          summary.overview.objective_summary,
          unsupportedSummary,
          summary.synthesis?.follow_up_actions?.[0]
        )
      });
    }

    return createRecommendation({
      action: "backtrack_to_design",
      targetNode: "design_experiments",
      reason:
        "The objective was not met under the current setup, so the next step is to revise the experiment design before another run.",
      confidence: evidenceGap || scopeLimit ? 0.8 : 0.76,
      autoExecutable: true,
      evidence: collectEvidence(
        summary,
        summary.overview.objective_summary,
        evidenceGap?.summary,
        scopeLimit?.summary,
        summary.synthesis?.follow_up_actions?.[0]
      )
    });
  }

  return createRecommendation({
    action: "advance",
        targetNode: "figure_audit",
    reason:
      summary.overview.objective_status === "observed"
        ? "The primary metric was observed and no blocking runtime issue remains, so the run can proceed to review before paper writing with explicit caveats."
        : "The objective is met and no blocking runtime issue remains, so the run can proceed to review before paper writing.",
    confidence: summary.synthesis?.confidence_statement
      ? summary.overview.objective_status === "observed"
        ? 0.84
        : 0.88
      : summary.overview.objective_status === "observed"
        ? 0.78
        : 0.82,
    autoExecutable: true,
    evidence: collectEvidence(
      summary,
      summary.overview.objective_summary,
      summary.synthesis?.confidence_statement,
      summary.synthesis?.discussion_points?.[0]
    )
  });
}

function applyBriefEvidenceTransitionOverride(
  recommendation: TransitionRecommendation,
  assessment: ReturnType<typeof evaluateBriefEvidenceAgainstResults>,
  summary: AnalysisReport
): TransitionRecommendation {
  if (!assessment.enabled || assessment.status !== "fail") {
    return recommendation;
  }
  return createRecommendation({
    action: "backtrack_to_design",
    targetNode: "design_experiments",
    reason: `Brief minimum evidence gate failed: ${assessment.summary}`,
    confidence: 0.92,
    autoExecutable: true,
    evidence: collectEvidence(
      summary,
      assessment.summary,
      `executed_trials=${assessment.actual.executed_trials ?? "unknown"}`,
      `confidence_intervals=${assessment.actual.confidence_interval_count}`
    )
  });
}

export interface ResultsArtifactValidationResult {
  valid: boolean;
  blocked: boolean;
  requiresObservationEvidence: boolean;
  requiresComparisonEvidence: boolean;
  issues: string[];
}

export function buildResultsArtifactValidation(input: {
  report: AnalysisReport;
  projection: ResultsArtifactProjectionResult;
  experimentContract?: ExperimentContract;
  comparisonContract?: ExperimentComparisonContract;
}): ResultsArtifactValidationResult {
  const declaredMetrics = uniqueStrings([
    input.report.objective_metric.profile.primary_metric ?? "",
    input.report.overview.matched_metric_key ?? "",
    ...input.report.objective_metric.profile.preferred_metric_keys,
    ...(input.experimentContract?.results_plan.required_metrics ?? []).map((metric) => metric.id),
    ...(input.report.plan_context.selected_design?.metrics ?? [])
  ].map((value) => value.trim()).filter(Boolean));
  const declaredBaselines = uniqueStrings([
    ...(input.experimentContract?.baselines ?? []),
    ...(input.report.plan_context.selected_design?.baselines ?? []),
    ...(input.comparisonContract?.baseline_candidate_ids ?? [])
  ].map((value) => value.trim()).filter(Boolean));
  const requiresComparisonEvidence =
    declaredBaselines.length > 0 ||
    (input.experimentContract?.results_plan.minimum_comparison_count ?? 0) > 0 ||
    (input.experimentContract?.results_plan.required_comparisons?.length ?? 0) > 0 ||
    (input.experimentContract?.brief_required_baseline_count ?? 0) > 0 ||
    input.comparisonContract?.baseline_first_required === true ||
    input.comparisonContract?.comparison_mode === "baseline_first_locked";
  const requiresObservationEvidence =
    requiresComparisonEvidence || declaredMetrics.length > 0;
  const issues = [...input.projection.issues];
  if (
    input.experimentContract?.version === 2 &&
    input.projection.source !== "explicit_results_artifact"
  ) {
    issues.push(
      "ExperimentContract V2 requires metrics.results_artifact; generic metric projection is read-only compatibility and cannot satisfy a new governed run."
    );
  }
  const contractCompleteness = input.experimentContract
    ? checkResultsContractCompleteness(
        input.projection.artifact,
        input.experimentContract.results_plan
      )
    : undefined;
  if (contractCompleteness && !contractCompleteness.complete) {
    issues.push(...contractCompleteness.issues);
  }

  if (input.projection.blocked) {
    issues.push(
      "Results artifact projection is blocked; explicit invalid V2 input cannot fall back to generic metrics."
    );
  } else if (!input.projection.valid && input.projection.issues.length === 0) {
    issues.push("Results artifact projection is invalid.");
  }
  if (requiresObservationEvidence && input.projection.artifact.observations.length === 0) {
    issues.push(
      "Results artifact is incomplete: the declared experiment requires numeric observations."
    );
  }
  if (requiresComparisonEvidence && input.projection.artifact.comparisons.length === 0) {
    issues.push(
      "Results artifact is incomplete or ambiguous: the declared comparison requires at least one explicit comparison."
    );
  }

  return {
    valid:
      input.projection.valid &&
      !input.projection.blocked &&
      issues.length === 0,
    blocked: input.projection.blocked,
    requiresObservationEvidence,
    requiresComparisonEvidence,
    issues: uniqueStrings(issues)
  };
}

export interface ResultsTableValidationResult {
  valid: boolean;
  rows: ResultsTableSchema;
  issues: string[];
  incompleteRows: ResultsTableSchema;
}

/**
 * @deprecated Historical API adapter only. Runtime analysis writes and gates on
 * ResultsArtifactV2 and never calls this function.
 */
export function buildResultsTableValidation(input: {
  report: AnalysisReport;
  experimentContract?: ExperimentContract;
}): ResultsTableValidationResult {
  const observations = new Map(
    input.report.results_artifact.observations.map((observation) => [
      observation.id,
      observation
    ])
  );
  const metrics = new Map(
    input.report.results_artifact.metrics.map((metric) => [metric.id, metric])
  );
  const rows = input.report.results_artifact.comparisons.flatMap((comparison) => {
    const subject = observations.get(comparison.subject_observation_id);
    const reference = observations.get(comparison.reference_observation_id);
    if (!subject || !reference || subject.metric_id !== reference.metric_id) {
      return [];
    }
    const metric = metrics.get(subject.metric_id);
    return [{
      metric: metric?.id ?? subject.metric_id,
      baseline: reference.value,
      comparator: subject.value,
      delta: comparison.delta,
      direction: metric?.direction ?? "higher_better" as const
    }];
  });
  const validation = validateResultsTableSchema(rows);
  const incompleteRows = validation.rows.filter(
    (row) => row.baseline === null || row.comparator === null
  );
  return {
    valid: validation.valid && incompleteRows.length === 0,
    rows: validation.rows,
    issues: validation.issues,
    incompleteRows
  };
}

function applyResultsArtifactTransitionOverride(
  recommendation: TransitionRecommendation,
  validation: ResultsArtifactValidationResult,
  summary: AnalysisReport
): TransitionRecommendation {
  if (validation.valid) {
    return recommendation;
  }
  return createRecommendation({
    action: "pause_for_human",
    reason: "incomplete_results_table",
    confidence: 0.94,
    autoExecutable: false,
    evidence: collectEvidence(
      summary,
      ...validation.issues
    )
  });
}

type RequiredResourceCategory = "runtime" | "memory";

interface RequiredResourceEvidenceGate {
  status: "pass" | "fail";
  requiredCategories: RequiredResourceCategory[];
  observedMetricKeys: string[];
  missingCategories: RequiredResourceCategory[];
  summary: string;
}

function evaluateRequiredResourceEvidence(input: {
  summary: AnalysisReport;
  experimentContract?: ExperimentContract;
}): RequiredResourceEvidenceGate {
  const requiredCategories = detectRequiredResourceCategories(input.summary, input.experimentContract);
  const observedMetricKeys = collectObservedNumericMetricKeys(input.summary).filter(
    (key) => isRuntimeMetricKey(key) || isMemoryMetricKey(key)
  );
  const missingCategories = requiredCategories.filter((category) => {
    if (category === "runtime") {
      return !observedMetricKeys.some(isRuntimeMetricKey);
    }
    return !observedMetricKeys.some(isMemoryMetricKey);
  });
  return {
    status: missingCategories.length > 0 ? "fail" : "pass",
    requiredCategories,
    observedMetricKeys,
    missingCategories,
    summary:
      missingCategories.length > 0
        ? `Required resource metrics are missing numeric evidence for: ${missingCategories.join(", ")}.`
        : requiredCategories.length > 0
          ? "Required resource metrics are present as numeric evidence."
          : "No required resource metric category was declared."
  };
}

function applyRequiredResourceEvidenceTransitionOverride(
  recommendation: TransitionRecommendation,
  gate: RequiredResourceEvidenceGate,
  summary: AnalysisReport
): TransitionRecommendation {
  if (gate.status !== "fail" || recommendation.action !== "advance") {
    return recommendation;
  }
  return createRecommendation({
    action: "backtrack_to_implement",
    targetNode: "implement_experiments",
    reason: gate.summary,
    confidence: 0.92,
    autoExecutable: true,
    evidence: collectEvidence(
      summary,
      gate.summary,
      `Required resource categories: ${gate.requiredCategories.join(", ")}.`,
      `Observed numeric resource metric keys: ${gate.observedMetricKeys.length > 0 ? gate.observedMetricKeys.slice(0, 6).join(", ") : "none"}.`
    )
  });
}

function detectRequiredResourceCategories(
  summary: AnalysisReport,
  experimentContract: ExperimentContract | undefined
): RequiredResourceCategory[] {
  const requestedText = [
    summary.objective_metric.raw,
    summary.objective_metric.profile.primary_metric,
    summary.overview.matched_metric_key,
    ...summary.objective_metric.profile.preferred_metric_keys,
    ...(experimentContract?.results_plan.required_metrics ?? []).flatMap((metric) => [
      metric.id,
      metric.label,
      metric.unit ?? ""
    ]),
    experimentContract?.expected_metric_effect,
    experimentContract?.abort_condition,
    experimentContract?.keep_or_discard_rule,
    experimentContract?.evidence_ceiling,
    experimentContract?.paper_ceiling
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join("\n");
  const requiredCategories: RequiredResourceCategory[] = [];
  if (requiresRuntimeEvidence(requestedText)) {
    requiredCategories.push("runtime");
  }
  if (requiresMemoryEvidence(requestedText)) {
    requiredCategories.push("memory");
  }
  return requiredCategories;
}

function collectObservedNumericMetricKeys(summary: AnalysisReport): string[] {
  const keys = new Set<string>();
  const addKey = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      keys.add(value.trim());
    }
  };
  for (const metric of summary.metric_table ?? []) {
    if (asNumber(metric.value) !== undefined) {
      addKey(metric.key);
    }
  }
  for (const observation of summary.results_artifact.observations) {
    if (asNumber(observation.value) !== undefined) {
      addKey(observation.metric_id);
    }
  }
  for (const metric of summary.statistical_summary?.stability_metrics ?? []) {
    if (asNumber(metric.value) !== undefined) {
      addKey(metric.key);
    }
  }
  for (const comparison of summary.condition_comparisons ?? []) {
    for (const metric of comparison.metrics ?? []) {
      if (
        asNumber(metric.value) !== undefined ||
        asNumber(metric.primary_value) !== undefined ||
        asNumber(metric.baseline_value) !== undefined
      ) {
        addKey(metric.key);
      }
    }
  }
  collectHistoricalResultsTableMetricKeys(summary.results_table, keys);
  for (const supplemental of summary.supplemental_runs ?? []) {
    for (const metric of supplemental.metric_table ?? []) {
      if (asNumber(metric.value) !== undefined) {
        addKey(metric.key);
      }
    }
  }
  collectNumericMetricKeyPaths(summary.metrics, [], keys);
  return Array.from(keys).sort((left, right) => left.localeCompare(right));
}

function collectHistoricalResultsTableMetricKeys(
  rows: AnalysisReport["results_table"],
  keys: Set<string>
): void {
  for (const row of rows ?? []) {
    if (asNumber(row.baseline) !== undefined || asNumber(row.comparator) !== undefined) {
      keys.add(row.metric);
    }
  }
}

function collectNumericMetricKeyPaths(value: unknown, pathParts: string[], keys: Set<string>): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    const leaf = pathParts[pathParts.length - 1];
    if (leaf) {
      keys.add(leaf);
    }
    if (pathParts.length > 1) {
      keys.add(pathParts.join("."));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectNumericMetricKeyPaths(item, [...pathParts, String(index)], keys));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectNumericMetricKeyPaths(child, [...pathParts, key], keys);
    }
  }
}

function requiresRuntimeEvidence(value: string): boolean {
  return /\b(?:runtime|run[ _-]?time|wall[ _-]?(?:clock|time)|elapsed(?:[ _-]?time)?|duration|latency|time[ _-]?(?:sec|secs|seconds|ms)|seconds?)\b/iu.test(
    normalizeMetricKeyForResourceMatching(value)
  );
}

function requiresMemoryEvidence(value: string): boolean {
  return /\b(?:memory|mem(?:ory)?[ _-]?(?:mb|gb|usage)?|peak[ _-]?(?:memory|mem|vram)|vram|gpu[ _-]?memory|cuda[ _-]?(?:memory|alloc|allocated|max))\b/iu.test(
    normalizeMetricKeyForResourceMatching(value)
  );
}

function isRuntimeMetricKey(value: string): boolean {
  return requiresRuntimeEvidence(normalizeMetricKeyForResourceMatching(value));
}

function isMemoryMetricKey(value: string): boolean {
  return requiresMemoryEvidence(normalizeMetricKeyForResourceMatching(value));
}

function normalizeMetricKeyForResourceMatching(value: string): string {
  return value.replace(/[._/\\-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function applyRiskSignalTransitionOverride(
  recommendation: TransitionRecommendation,
  riskSignals: RiskSignal[],
  summary: AnalysisReport
): TransitionRecommendation {
  const criticalSignal = riskSignals.find((signal) => signal.severity === "critical");
  if (!criticalSignal) {
    return recommendation;
  }
  return createRecommendation({
    action: "pause_for_human",
    reason: criticalSignal.detail,
    confidence: 0.97,
    autoExecutable: false,
    evidence: collectEvidence(
      summary,
      criticalSignal.detail,
      ...riskSignals.slice(0, 3).map((signal) => signal.detail)
    )
  });
}

function applyGovernanceTransitionOverride(
  recommendation: TransitionRecommendation,
  decision: ReturnType<typeof deriveGovernedAnalysisDecision> | undefined,
  summary: AnalysisReport,
  comparisonContract: ExperimentComparisonContract | undefined
): TransitionRecommendation {
  if (!decision?.transitionOverride) {
    return recommendation;
  }

  if (
    isDeferredFullCycleObjective(summary) &&
    decision.transitionOverride.targetNode === "implement_experiments" &&
    comparisonContract?.comparison_mode === "baseline_first_locked"
  ) {
    return recommendation;
  }

  const targetNode = decision.transitionOverride.targetNode;
  // When governance overrides an "advance" recommendation to a backtrack,
  // require human approval instead of auto-executing to prevent loops.
  const overridingAdvance = recommendation.action === "advance";
  return createRecommendation({
    action: targetNode === "design_experiments" ? "backtrack_to_design" : "backtrack_to_implement",
    targetNode,
    reason: decision.transitionOverride.rationale,
    confidence: targetNode === "design_experiments" ? 0.86 : 0.9,
    autoExecutable: overridingAdvance ? false : true,
    evidence: collectEvidence(
      summary,
      decision.transitionOverride.rationale,
      decision.candidateEntry.rationale,
      comparisonContract?.comparison_mode
        ? `Comparison mode: ${comparisonContract.comparison_mode}.`
        : undefined
    )
  });
}

function createRecommendation(input: {
  action: TransitionRecommendation["action"];
  reason: string;
  confidence: number;
  autoExecutable: boolean;
  evidence: string[];
  targetNode?: TransitionRecommendation["targetNode"];
}): TransitionRecommendation {
  const suggestedCommands =
    input.action === "advance"
      ? ["/approve"]
      : input.targetNode
        ? [`/agent jump ${input.targetNode}`, `/agent run ${input.targetNode}`]
        : ["/agent status"];
  return {
    action: input.action,
    sourceNode: "analyze_results",
    targetNode: input.targetNode,
    reason: input.reason,
    confidence: Number(input.confidence.toFixed(2)),
    autoExecutable: input.autoExecutable,
    evidence: input.evidence,
    suggestedCommands,
    generatedAt: new Date().toISOString()
  };
}

function isDeferredFullCycleObjective(summary: AnalysisReport): boolean {
  if (summary.overview.objective_status !== "not_met") {
    return false;
  }
  const matchedMetricKey = (summary.overview.matched_metric_key || "").toLowerCase();
  const profilePrimaryMetric = (summary.objective_metric.profile.primary_metric || "").toLowerCase();
  const rawObjectiveMetric = summary.objective_metric.raw.toLowerCase();
  const fullCycleMetricMatched =
    matchedMetricKey.endsWith("tui_full_cycle_consistent_success_count") ||
    profilePrimaryMetric === "tui_full_cycle_consistent_success_count" ||
    (rawObjectiveMetric.includes("full tui cycle") && rawObjectiveMetric.includes("artifact/state consistency"));
  if (!fullCycleMetricMatched) {
    return false;
  }
  const objectiveMetrics = asRecord(summary.metrics.metrics);
  if (objectiveMetrics.full_cycle_completed !== false) {
    return false;
  }
  const pendingNodes = asStringArray(objectiveMetrics.pending_nodes);
  const objectiveNotes = asRecord(objectiveMetrics.notes);
  const fullCycleNote = asString(objectiveNotes.full_cycle_completed) || "";
  const pendingLifecycleNodes = pendingNodes.some((node) =>
    node === "run_experiments" || node === "analyze_results" || node === "figure_audit" || node === "review" || node === "write_paper"
  );
  const selfReferentialNote =
    /run remains at implement_experiments/i.test(fullCycleNote) ||
    /never entered run_experiments\/analyze_results\/(?:figure_audit\/)?review\/write_paper/i.test(fullCycleNote);
  return pendingLifecycleNodes || selfReferentialNote;
}

function collectEvidence(summary: AnalysisReport, ...items: Array<string | undefined>): string[] {
  const evidence = new Set<string>();
  for (const item of items) {
    const value = item?.trim();
    if (value) {
      evidence.add(value);
    }
  }
  if (evidence.size === 0) {
    evidence.add(summary.overview.objective_summary);
  }
  return Array.from(evidence).slice(0, 4);
}

function findFailure(
  failures: AnalysisFailureCategory[],
  category: AnalysisFailureCategory["category"],
  statuses: AnalysisFailureCategory["status"][] = ["observed"]
): AnalysisFailureCategory | undefined {
  return failures.find((item) => item.category === category && statuses.includes(item.status));
}
