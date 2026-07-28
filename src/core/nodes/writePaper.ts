import path from "node:path";
import { promises as fs } from "node:fs";

import { GraphNodeHandler } from "../stateGraph/types.js";
import { runArtifactsDir, safeRead, writeRunArtifact } from "./helpers.js";
import { NodeExecutionDeps } from "./types.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import { resolveResearchRunModeGuard } from "../runs/researchRunModeGuard.js";
import { publishPublicRunOutputs, generatePublicRunReadme } from "../publicOutputPublisher.js";
import {
  buildOperatorHistoryRelativePath,
  renderOperatorHistoryMarkdown,
  renderOperatorSummaryMarkdown
} from "../operatorSummary.js";
import { PaperProfileConfig, TransitionRecommendation } from "../../types.js";
import { resolveConstraintProfile } from "../constraintProfile.js";
import { ensureDir, fileExists } from "../../utils/fs.js";
import { buildPublicPaperDir } from "../publicArtifacts.js";
import type { ConstraintProfile } from "../runConstraints.js";
import {
  ACL_BIBLIOGRAPHY_STYLE,
  detectAclTemplatePackage
} from "../latex/aclTemplate.js";
import {
  ObjectiveMetricEvaluation,
  resolveObjectiveMetricProfile
} from "../objectiveMetric.js";
import {
  buildRelatedWorkBrief,
  buildRelatedWorkNotes,
  buildPaperBibtex,
  buildPaperEvidenceMap,
  collectPaperCitationIds,
  type PaperDraftClaim,
  PaperWritingBundle,
  parseCorpusRows,
  parseEvidenceRows,
  parseExperimentPlan,
  parseHypotheses,
  parsePaperSummaries,
  parseResultAnalysis,
  sanitizePaperNarrativeText,
  validatePaperDraft
} from "../analysis/paperWriting.js";
import {
  buildVerifiedRegistryWithExternalLookup,
  VerifiedRegistryArtifact
} from "../analysis/verifiedRegistry.js";
import {
  checkCitationConsistency,
  type CitationReport
} from "../analysis/citationConsistencyChecker.js";
import {
  buildNetworkDependencyReadinessRisks,
  buildReadinessRiskArtifact,
  type ReadinessRisk,
  type ReadinessRiskArtifact
} from "../readinessRisks.js";
import {
  type PaperManuscript,
  type PaperAuthorMetadata,
  type PaperManuscriptFigure,
  type PaperManuscriptSection,
  type PaperManuscriptStabilizationOptions,
  type PaperManuscriptVisualRow,
  type PaperSubmissionValidationReport,
  type PaperTraceabilityReport,
  DERIVED_MAIN_FIGURE_SOURCE_REF_ID,
  DERIVED_MAIN_TABLE_SOURCE_REF_ID,
  buildFallbackPaperManuscript,
  buildPaperSubmissionValidation,
  buildPaperTraceability,
  renderSubmissionPaperTex,
  stabilizePaperManuscriptForSubmission
} from "../analysis/paperManuscript.js";
import {
  applyGateWarningsToLimitations,
  appendixConsistencyLinter,
  applyScientificWritingPolicy,
  buildScientificValidationArtifact,
  buildWritePaperGateDecision,
  enforceManuscriptPageBudgetFloor,
  ConsistencyLintReport,
  experimentArtifactLoader,
  manuscriptConsistencyLinter,
  materializeScientificManuscript,
  refreshScientificValidationForManuscript,
  resolvePaperProfile
} from "../analysis/scientificWriting.js";
import { PaperWriterSessionManager } from "../agents/paperWriterSessionManager.js";
import {
  buildManuscriptRepairPlan,
  buildManuscriptRepairVerificationArtifact,
  buildManuscriptStyleLint,
  collectManuscriptQualityIssues,
  reconcileManuscriptStyleLintWithReview,
  ManuscriptQualityIssueSnapshot,
  ManuscriptRepairPlanArtifact,
  ManuscriptRepairVerificationArtifact,
  ManuscriptReviewAuditArtifact,
  ManuscriptRepairDecision,
  ManuscriptRepairReport,
  ManuscriptReviewArtifact,
  ManuscriptReviewValidationArtifact,
  validateManuscriptReviewArtifact,
  ManuscriptStyleLintArtifact
} from "../analysis/manuscriptQuality.js";
import { maybeEnrichRelatedWorkScout } from "../writePaperRelatedWorkEnrichment.js";
import { maybeRunRelatedWorkScout } from "../writePaperRelatedWorkScout.js";
import {
  buildPostDraftCritique,
  critiqueDecisionToTransitionAction,
  critiqueDecisionToTargetNode,
  type PaperCritique
} from "../paperCritique.js";
import type { BriefEvidenceAssessment } from "../analysis/briefEvidenceValidator.js";
import type { ManuscriptType } from "../paperCritique.js";
import { buildRunOperatorStatus } from "../runs/runStatus.js";
import { buildRunCompletenessChecklist } from "../runs/runCompletenessChecklist.js";
import {
  deriveLatexTemplatePolicy,
  loadLatexTemplate,
  resolveLatexTemplatePath,
  type ParsedLatexTemplate
} from "../latex/latexTemplateLoader.js";
import {
  parseAppendixPreferencesFromBrief,
  parseManuscriptAuthorsFromBrief,
  parseManuscriptTemplateFromBrief
} from "../runs/researchBriefFiles.js";
import {
  inspectReferenceAuthorityGate,
  type ReferenceAuthorityGateArtifact
} from "../referenceAuthorityGate.js";
import type { AnalysisReport } from "../resultAnalysis.js";
import {
  type ResultsArtifactV2,
  type ResultsComparisonV2,
  type ResultsMetricDefinitionV2,
  type ResultsObservationV2,
  type ResultsPlanV2,
  type ResultsSeriesRole,
  type ResultsSeriesV2,
  validateResultsPrimaryComparisonSelectionV2,
  validateResultsArtifactV2
} from "../analysis/resultsTableSchema.js";

interface PaperCompileCommandResult {
  step: string;
  command: string;
  status: "ok" | "error";
  exit_code?: number;
  duration_ms: number;
  optional?: boolean;
  stdout?: string;
  stderr?: string;
}

interface PaperCompileAttempt {
  attempt: number;
  repaired: boolean;
  status: "success" | "failed";
  commands: PaperCompileCommandResult[];
  warnings: string[];
  error?: string;
  build_log_path: string;
  pdf_exists: boolean;
}

interface PaperCompileResult {
  enabled: boolean;
  status: "skipped" | "success" | "repaired_success" | "failed";
  repaired: boolean;
  toolCallsUsed: number;
  attempts: PaperCompileAttempt[];
  warnings: string[];
  pdf_path?: string;
  build_log_path?: string;
  repair_error?: string;
}

interface CompiledPdfPageValidationReport {
  checked: boolean;
  validation_mode: "default" | "strict_paper";
  status: "pass" | "warn" | "fail";
  outcome: "ok" | "under_limit" | "measurement_unavailable" | "skipped";
  minimum_main_pages: number;
  target_main_pages: number;
  main_page_limit: number;
  compiled_pdf_page_count: number | null;
  main_body_pdf_page_count?: number | null;
  references_page_count?: number | null;
  appendix_page_count?: number | null;
  references_counted?: boolean;
  appendices_counted?: boolean;
  pdf_path: string | null;
  message: string;
}

interface PaperFigureManifestEntry {
  id: string;
  kind: "result_chart" | "conceptual_diagram" | "algorithm_diagram";
  caption: string;
  source_refs: string[];
  included_in_main_body: boolean;
  status: "rendered" | "needs_generation" | "omitted";
  audit_status: "pending" | "pass" | "fail" | "not_applicable";
  path?: string;
  prompt_path?: string;
  render_source?: "python_vector_pdf";
  render_status?: "pass" | "fail" | "skipped";
  render_error?: string;
}

interface PaperFigureManifest {
  generated_at: string;
  figures: PaperFigureManifestEntry[];
  conceptual_diagram_prompt?: {
    use_case: "scientific-educational";
    asset_type: string;
    prompt: string;
    intended_path: string;
  };
}

interface PaperRenderValidationIssue {
  code: string;
  severity: "warning" | "fail";
  message: string;
}

interface PaperRenderValidationReport {
  checked: boolean;
  validation_mode: "default" | "strict_paper";
  status: "pass" | "warn" | "fail";
  issues: PaperRenderValidationIssue[];
  metrics: {
    author_count: number;
    template_applied: boolean;
    rendered_citation_count: number;
    bibliography_entry_count: number;
    main_body_table_count: number;
    main_body_figure_count: number;
    result_chart_count: number;
    conceptual_diagram_count: number;
    overfull_hbox_count: number;
    max_overfull_hbox_pt: number;
    main_body_pdf_page_count: number | null;
    target_main_pages: number;
    rendered_figure_asset_count: number;
    final_tex_preserves_template: boolean;
    final_tex_bibliography_style: string | null;
    expected_bibliography_style: string | null;
    repeated_citation_bundle_count: number;
    max_repeated_citation_bundle_count: number;
    repeated_long_sentence_count: number;
    max_repeated_long_sentence_count: number;
  };
  summary: string[];
}

interface PaperInputValidationIssue {
  artifact: string;
  path: string;
  reason: string;
}

interface PaperInputValidationReport {
  ok: boolean;
  issues: PaperInputValidationIssue[];
}

export interface WritePaperPrimaryComparison {
  comparison: ResultsComparisonV2;
  metric: ResultsMetricDefinitionV2 & { unit: string };
  subjectObservation: ResultsObservationV2;
  referenceObservation: ResultsObservationV2;
  subjectSeries: ResultsSeriesV2 & { role: ResultsSeriesRole };
  referenceSeries: ResultsSeriesV2 & { role: ResultsSeriesRole };
}

export interface WritePaperResultsContract {
  artifact: ResultsArtifactV2;
  primaryComparisonId: string;
  primary: WritePaperPrimaryComparison;
}

export type WritePaperResultsContractResolution =
  | {
      ok: true;
      contract: WritePaperResultsContract;
      issues: [];
    }
  | {
      ok: false;
      issues: string[];
    };

type ClaimEvidenceStatus = "verified" | "unverified" | "blocked" | "inferred";

interface ClaimEvidenceTableRow {
  claim_id: string;
  statement: string;
  section_heading: string;
  evidence_source_type: "literature" | "experiment" | "qualitative_observation" | "limitation";
  artifact_refs: string[];
  citation_refs: string[];
  strength: "high" | "medium" | "low";
  downgrade_note?: string;
}

interface ClaimStatusRow {
  claim_id: string;
  statement: string;
  section_heading: string;
  status: ClaimEvidenceStatus;
  primary_source_present: boolean;
  run_artifact_present: boolean;
  reproduction_trace_present: boolean;
  artifact_refs: string[];
  citation_refs: string[];
  claim_ids_in_trace: string[];
  citation_statuses: Array<{
    citation_paper_id: string;
    resolved_paper_id?: string;
    status: ClaimEvidenceStatus;
    repaired: boolean;
  }>;
  notes: string[];
}

interface ClaimStatusTableArtifact {
  generated_at: string;
  counts: Record<ClaimEvidenceStatus, number>;
  claims: ClaimStatusRow[];
}

interface EvidenceGateIssue {
  severity: "warning" | "fail";
  code: string;
  claim_id: string;
  section_heading: string;
  message: string;
  fix_recommendation: string;
}

interface EvidenceGateDecisionArtifact {
  generated_at: string;
  status: "pass" | "warn" | "fail";
  blocking_issue_count: number;
  warning_count: number;
  issues: EvidenceGateIssue[];
  summary_lines: string[];
}

interface PaperReadinessArtifact {
  generated_at: string;
  paper_ready: boolean;
  readiness_state: ManuscriptType;
  pre_draft_manuscript_type?: ManuscriptType;
  claim_ceiling_applied: boolean;
  overall_score?: number;
  reason: string;
  citation_check: CitationReport["status"];
  reference_authority_gate: ReferenceAuthorityGateArtifact;
  triggered_by: string[];
  evidence_gate_status: EvidenceGateDecisionArtifact["status"];
  scientific_validation_status: "pass" | "warn" | "fail";
  submission_validation_ok: boolean;
  manuscript_quality_action: ManuscriptRepairDecision["action"];
  compile_status?: PaperCompileResult["status"];
  compiled_page_validation_status?: CompiledPdfPageValidationReport["status"];
  render_validation_status?: PaperRenderValidationReport["status"];
  claim_status_counts: Record<ClaimEvidenceStatus, number>;
}

interface ManuscriptQualityFailureArtifact {
  generated_at: string;
  reason: string;
  decision_digest: ManuscriptRepairDecision["decision_digest"];
  summary_lines: string[];
  triggered_by: string[];
  review_reliability: "grounded" | "partially_grounded" | "degraded";
  final_issues: ManuscriptQualityIssueSnapshot[];
  lint_findings: Array<{
    code: string;
    section: string;
    severity: "warning" | "fail";
    gate_role?: "primary_signal" | "backstop_only" | "hard_stop";
    coverage_status?: "primary" | "backstop_only";
    covered_by_review_issue_code?: string;
    location_keys?: string[];
  }>;
  reviewer_missed_policy_findings: Array<{
    code: string;
    section: string;
    severity: "warning" | "fail";
    gate_role?: "hard_stop";
    location_keys?: string[];
  }>;
  reviewer_covered_backstop_findings: Array<{
    code: string;
    section: string;
    severity: "warning" | "fail";
    gate_role?: "backstop_only";
    covered_by_review_issue_code?: string;
    location_keys?: string[];
  }>;
}

type ManuscriptRepairDecisionCore = Omit<ManuscriptRepairDecision, "summary_lines" | "decision_digest">;

interface PaperDraftValidationRepairReport {
  threshold: number;
  attempted: boolean;
  applied: boolean;
  source?: string;
  error?: string;
  reason?: string;
  initial_warning_count: number;
  candidate_warning_count?: number;
  final_warning_count: number;
}

interface ManuscriptCandidateEvaluation {
  manuscript: PaperManuscript;
  traceability: PaperTraceabilityReport;
  tex: string;
  submissionValidation: PaperSubmissionValidationReport;
  styleLint: ManuscriptStyleLintArtifact;
  consistencyLint: ConsistencyLintReport;
  appendixLint: ConsistencyLintReport;
  scientificValidation: ReturnType<typeof buildScientificValidationArtifact>;
  gateDecision: ReturnType<typeof buildWritePaperGateDecision>;
}

interface GroundedManuscriptReviewCycleResult {
  review: ManuscriptReviewArtifact;
  reviewValidation: ManuscriptReviewValidationArtifact;
  reviewAudit: ManuscriptReviewAuditArtifact;
  reviewRaw?: string;
  auditRaw?: string;
  toolCallsUsed: number;
  retryUsed: boolean;
}

const VALIDATION_REPAIR_WARNING_THRESHOLD = 1;

export function createWritePaperNode(deps: NodeExecutionDeps): GraphNodeHandler {
  const sessions = new PaperWriterSessionManager({
    config: deps.config,
    codex: deps.codex,
    llm: deps.llm,
    eventStream: deps.eventStream,
    runStore: deps.runStore,
    workspaceRoot: process.cwd()
  });

  return {
    id: "write_paper",
    async execute({ run, abortSignal }) {
      const runContextMemory = new RunContextMemory(run.memoryRefs.runContextPath);
      const emitLog = (text: string) => {
        deps.eventStream.emit({
          type: "OBS_RECEIVED",
          runId: run.id,
          node: "write_paper",
          payload: { text }
        });
      };
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
      if (!researchModeGuard.paperDraftingAllowed) {
        const reasonCodes = researchModeGuard.valid
          ? ["bounded_probe_parent_cannot_draft_paper"]
          : researchModeGuard.reasons;
        const error =
          "write_paper blocked by research evidence lineage: "
          + reasonCodes.join(", ");
        emitLog(error);
        await runContextMemory.put("write_paper.last_error", error);
        return {
          status: "failure",
          error,
          summary: error,
          toolCallsUsed: 0
        };
      }
      const bundleResult = await loadValidatedPaperBundle(run);
      await writeRunArtifact(
        run,
        "paper/input_validation.json",
        `${JSON.stringify(bundleResult.report, null, 2)}\n`
      );
      await runContextMemory.put("write_paper.input_validation", bundleResult.report);
      if (!bundleResult.bundle) {
        emitLog(bundleResult.error);
        await runContextMemory.put("write_paper.last_error", bundleResult.error);
        await runContextMemory.put("write_paper.compile_status", null);
        await runContextMemory.put("write_paper.compile_report", null);
        await runContextMemory.put("write_paper.pdf_path", null);
        return {
          status: "failure",
          error: bundleResult.error,
          summary: bundleResult.error,
          toolCallsUsed: 0
        };
      }
      const bundle = bundleResult.bundle;
      const resultsContract = bundleResult.resultsContract;
      await runContextMemory.put("write_paper.last_error", null);
      const preDraftCritique = await loadPreDraftCritique(run.id);
      const briefEvidenceAssessment =
        (await runContextMemory.get<BriefEvidenceAssessment>("analyze_results.brief_evidence_assessment")) ?? undefined;
      const writeEligibility = evaluateWritePaperEligibility({
        preDraftCritique,
        briefEvidenceAssessment,
        reviewRequired: Boolean(deps.config.workflow)
      });
      await writeRunArtifact(
        run,
        "paper/write_paper_eligibility.json",
        `${JSON.stringify(writeEligibility, null, 2)}\n`
      );
      await runContextMemory.put("write_paper.eligibility", writeEligibility);
      if (!writeEligibility.allowed) {
        await persistBlockedWritePaperReadiness({
          run,
          reason: writeEligibility.reason,
          manuscriptType: writeEligibility.manuscript_type ?? "blocked_for_paper_scale",
          config: deps.config,
          runContextMemory
        });
        emitLog(writeEligibility.reason);
        await runContextMemory.put("write_paper.last_error", writeEligibility.reason);
        await runContextMemory.put("write_paper.compile_status", null);
        await runContextMemory.put("write_paper.compile_report", null);
        await runContextMemory.put("write_paper.pdf_path", null);
        return {
          status: "failure",
          error: writeEligibility.reason,
          summary: writeEligibility.reason,
          toolCallsUsed: 0
        };
      }
      if (!resultsContract) {
        const error =
          "write_paper requires AnalysisReport.results_artifact V2 with an explicit, unambiguous primary comparison before drafting. "
          + "Historical result analysis remains readable for inspection but cannot be used to create or revise paper claims.";
        emitLog(error);
        await runContextMemory.put("write_paper.last_error", error);
        await runContextMemory.put("write_paper.compile_status", null);
        await runContextMemory.put("write_paper.compile_report", null);
        await runContextMemory.put("write_paper.pdf_path", null);
        return {
          status: "failure",
          error,
          summary: error,
          toolCallsUsed: 0
        };
      }

      const constraintProfile = await resolveConstraintProfile({
        run,
        runContextMemory,
        llm: deps.llm,
        eventStream: deps.eventStream,
        node: "write_paper",
        abortSignal
      });
      const objectiveMetricProfile = await resolveObjectiveMetricProfile({
        run,
        runContextMemory,
        llm: deps.llm,
        eventStream: deps.eventStream,
        node: "write_paper"
      });
      const objectiveEvaluation = await loadObjectiveEvaluation(runContextMemory, run.id);
      const manuscriptFormatTarget = await runContextMemory.get("run_brief.manuscript_format") as
        { columns?: number; main_body_pages?: number; references_excluded_from_page_limit?: boolean; appendices_excluded_from_page_limit?: boolean } | undefined;
      const briefTemplatePath = rawBrief
        ? (parseManuscriptTemplateFromBrief(rawBrief) ?? null)
        : null;
      const briefAppendixPreferences = rawBrief
        ? (parseAppendixPreferencesFromBrief(rawBrief) ?? undefined)
        : undefined;
      const authorMetadata = rawBrief
        ? (parseManuscriptAuthorsFromBrief(rawBrief) ?? null)
        : null;
      const resolvedTemplatePath = await resolveLatexTemplatePath(
        process.cwd(),
        briefTemplatePath
      );
      let parsedTemplate: ParsedLatexTemplate | null = null;
      if (briefTemplatePath && !resolvedTemplatePath) {
        emitLog(
          `[write_paper] LaTeX template not found (${briefTemplatePath}). Using built-in preamble.`
        );
      } else if (resolvedTemplatePath) {
        try {
          parsedTemplate = await loadLatexTemplate(resolvedTemplatePath);
          emitLog(
            `[write_paper] LaTeX template loaded: ${parsedTemplate.sourcePath}` +
              (parsedTemplate.sectionOrder.length > 0
                ? ` (sections: ${parsedTemplate.sectionOrder.join(", ")})`
                : "")
          );
        } catch (err) {
          emitLog(
            `[write_paper] LaTeX template load failed (${resolvedTemplatePath}): ${err}. Using built-in preamble.`
          );
        }
      }
      const templatePolicy = deriveLatexTemplatePolicy(parsedTemplate);
      const briefMainBodyPages =
        typeof manuscriptFormatTarget?.main_body_pages === "number" ? manuscriptFormatTarget.main_body_pages : undefined;
      const paperProfile = resolvePaperProfile(
        {
          column_count:
            parsedTemplate?.columnLayout
            ?? (manuscriptFormatTarget?.columns === 1 ? 1 : undefined),
          target_main_pages: briefMainBodyPages,
          minimum_main_pages: briefMainBodyPages,
          main_page_limit: briefMainBodyPages,
          references_counted:
            manuscriptFormatTarget
              ? manuscriptFormatTarget.references_excluded_from_page_limit === false
              : undefined,
          appendix_allowed:
            manuscriptFormatTarget
              ? manuscriptFormatTarget.appendices_excluded_from_page_limit !== false
              : undefined,
          appendix_format: templatePolicy.appendixFormat ?? undefined,
          prefer_appendix_for: briefAppendixPreferences?.preferAppendixFor,
          estimated_words_per_page: templatePolicy.estimatedWordsPerPage ?? undefined
        },
        constraintProfile
      );
      const validationMode = resolvePaperValidationMode(deps.config.paper?.validation_mode);
      bundle.latestResults = buildWritePaperResultsInput(resultsContract);
      const relatedWorkScout = await maybeRunRelatedWorkScout({
        run,
        bundle,
        constraintProfile,
        semanticScholar: deps.semanticScholar,
        abortSignal,
        emitLog
      });
      await runContextMemory.put("write_paper.related_work_scout", {
        status: relatedWorkScout.status,
        reason: relatedWorkScout.reason,
        query: relatedWorkScout.query,
        rationale: relatedWorkScout.rationale,
        requested_limit: relatedWorkScout.requested_limit,
        paper_count: relatedWorkScout.papers.length,
        papers: relatedWorkScout.papers,
        planned_query_count: relatedWorkScout.queryPlan?.planned_queries.length || 0,
        executed_query_count: relatedWorkScout.coverageAudit?.after.executed_query_count || 0,
        coverage_status: relatedWorkScout.coverageAudit?.status,
        coverage_stop_reason: relatedWorkScout.coverageAudit?.stop_reason
      });
      if (relatedWorkScout.scout && relatedWorkScout.corpusRows.length > 0) {
        bundle.relatedWorkScout = relatedWorkScout.scout;
        bundle.corpus = mergeBundleCorpus(bundle.corpus, relatedWorkScout.corpusRows);
      }
      const relatedWorkEnrichment = await maybeEnrichRelatedWorkScout({
        run,
        config: deps.config,
        scoutRows: relatedWorkScout.corpusRows,
        existingPaperIds: new Set(bundle.paperSummaries.map((item) => item.paper_id)),
        llm: deps.llm,
        pdfTextLlm: deps.pdfTextLlm,
        responsesPdfAnalysis: deps.responsesPdfAnalysis,
        abortSignal,
        emitLog
      });
      await runContextMemory.put("write_paper.related_work_enrichment", {
        status: relatedWorkEnrichment.status,
        reason: relatedWorkEnrichment.reason,
        attempted_paper_count: relatedWorkEnrichment.attemptedPaperIds.length,
        analyzed_paper_count: relatedWorkEnrichment.summaryRows.length,
        full_text_count: relatedWorkEnrichment.fullTextCount,
        abstract_fallback_count: relatedWorkEnrichment.abstractFallbackCount,
        failures: relatedWorkEnrichment.failures
      });
      if (relatedWorkEnrichment.summaryRows.length > 0) {
        bundle.paperSummaries = mergeBundlePaperSummaries(
          bundle.paperSummaries,
          relatedWorkEnrichment.summaryRows
        );
        bundle.evidenceRows = mergeBundleEvidenceRows(
          bundle.evidenceRows,
          relatedWorkEnrichment.evidenceRows
        );
      }
      const relatedWorkNotes = buildRelatedWorkNotes(bundle);
      if (relatedWorkNotes.length > 0) {
        bundle.relatedWorkNotes = relatedWorkNotes;
        const relatedWorkBrief = buildRelatedWorkBrief(bundle);
        await writeRunArtifact(
          run,
          "paper/related_work_notes.json",
          `${JSON.stringify(
            {
              note_count: relatedWorkNotes.length,
              comparison_axes: relatedWorkBrief.comparison_axes,
              paragraph_plan: relatedWorkBrief.paragraph_plan,
              notes: relatedWorkNotes
            },
            null,
            2
          )}\n`
        );
        await runContextMemory.put("write_paper.related_work_notes", {
          note_count: relatedWorkNotes.length,
          comparison_axes: relatedWorkBrief.comparison_axes,
          paragraph_plan: relatedWorkBrief.paragraph_plan,
          top_titles: relatedWorkNotes.slice(0, 4).map((item) => item.title)
        });
      }

      emitLog(
        `Preparing paper draft from ${bundle.paperSummaries.length} summaries, ${bundle.evidenceRows.length} evidence items, and ${bundle.hypotheses.length} hypotheses.`
      );

      const sessionResult = await sessions.run({
        run,
        bundle,
        constraintProfile,
        paperProfile,
        objectiveMetricProfile,
        objectiveEvaluation,
        latexTemplateSectionOrder:
          parsedTemplate?.sectionOrder?.length ? parsedTemplate.sectionOrder : null,
        appendixKeepInMainBody:
          briefAppendixPreferences?.keepInMainBody?.length ? briefAppendixPreferences.keepInMainBody : null,
        abortSignal
      });
      let paperDraft = sessionResult.draft;
      emitLog(`Structured paper draft prepared with ${paperDraft.sections.length} sections via ${sessionResult.source}.`);

      let validation = validatePaperDraft({
        draft: paperDraft,
        bundle
      });
      paperDraft = validation.draft;
      if (validation.issues.length > 0) {
        emitLog(`Validated paper draft and recorded ${validation.issues.length} evidence-alignment warning(s).`);
      }
      const validationRepair: PaperDraftValidationRepairReport = {
        threshold: VALIDATION_REPAIR_WARNING_THRESHOLD,
        attempted: false,
        applied: false,
        initial_warning_count: validation.issues.length,
        final_warning_count: validation.issues.length
      };
      if (shouldAttemptValidationRepair(validation)) {
        emitLog(
          `Validation accumulated ${validation.issues.length} warning(s); attempting one automatic repair pass before rendering.`
        );
        const repairResult = await sessions.reviseAfterValidation({
          run,
          bundle,
          constraintProfile,
          paperProfile,
          objectiveMetricProfile,
          objectiveEvaluation,
          outline: sessionResult.outline,
          draft: paperDraft,
          review: sessionResult.review,
          validationIssues: validation.issues,
          abortSignal
        });
        validationRepair.attempted = repairResult.attempted;
        validationRepair.source = repairResult.source;
        validationRepair.error = repairResult.error;
        if (repairResult.applied) {
          const repairedValidation = validatePaperDraft({
            draft: repairResult.draft,
            bundle
          });
          validationRepair.candidate_warning_count = repairedValidation.issues.length;
          if (repairedValidation.issues.length <= validation.issues.length) {
            paperDraft = repairedValidation.draft;
            validation = repairedValidation;
            validationRepair.applied = true;
            validationRepair.final_warning_count = repairedValidation.issues.length;
            emitLog(
              `Automatic validation repair ${repairedValidation.issues.length < validationRepair.initial_warning_count ? "reduced" : "stabilized"} warnings at ${repairedValidation.issues.length}.`
            );
          } else {
            validationRepair.reason = "repair did not improve warning count";
            emitLog(
              `Automatic validation repair was discarded because warnings increased from ${validation.issues.length} to ${repairedValidation.issues.length}.`
            );
          }
        } else if (repairResult.error) {
          validationRepair.reason = "repair pass failed";
          emitLog(`Automatic validation repair failed: ${repairResult.error}`);
        }
      }

      const scientificDraft = applyScientificWritingPolicy({
        draft: paperDraft,
        bundle,
        profile: paperProfile,
        objectiveEvaluation,
        objectiveMetricProfile
      });
      const scientificValidationArtifact = buildScientificValidationArtifact(scientificDraft);
      paperDraft = scientificDraft.draft;
      validation = validatePaperDraft({
        draft: paperDraft,
        bundle
      });
      await writeRunArtifact(
        run,
        "paper/scientific_validation.json",
        `${JSON.stringify(scientificValidationArtifact, null, 2)}\n`
      );
        await runContextMemory.put("write_paper.scientific_validation", {
          mode: validationMode,
          page_budget_status: scientificDraft.page_budget.status,
          page_budget_column_count: scientificDraft.page_budget.column_count,
          page_budget_target_main_pages: scientificDraft.page_budget.target_main_pages,
          page_budget_minimum_main_pages: scientificDraft.page_budget.minimum_main_pages,
          page_budget_main_page_limit: scientificDraft.page_budget.main_page_limit,
          page_budget_references_counted: scientificDraft.page_budget.references_counted,
          page_budget_target_words: scientificDraft.page_budget.target_main_words,
        page_budget_estimated_words: scientificDraft.page_budget.estimated_main_words,
        method_status: scientificDraft.method_completeness.status,
        results_status: scientificDraft.results_richness.status,
        related_work_status: scientificDraft.related_work_richness.status,
        discussion_status: scientificDraft.discussion_richness.status,
        evidence_blocked: scientificDraft.evidence_diagnostics.blocked_by_evidence_insufficiency,
        missing_evidence_categories: scientificDraft.evidence_diagnostics.missing_evidence_categories,
        thin_sections: scientificDraft.evidence_diagnostics.thin_sections,
        appendix_reference_count: scientificDraft.appendix_plan.cross_references.length,
        claim_rewrite_count: scientificDraft.claim_rewrite_report.rewrites.length,
        expansion_recheck: scientificDraft.auto_repairs.expansion_recheck,
        issue_count: scientificValidationArtifact.issues.length
      });
      if (scientificDraft.page_budget.warnings.length > 0) {
        emitLog(`Scientific page-budget warnings: ${scientificDraft.page_budget.warnings.join(" ")}`);
      }
      if (scientificDraft.claim_rewrite_report.rewrites.length > 0) {
        emitLog(
          `Claim-strength rewriting softened ${scientificDraft.claim_rewrite_report.rewrites.length} over-strong phrase(s).`
        );
      }

      const citedPaperIds = collectPaperCitationIds(paperDraft, bundle);
      const verifiedRegistryResult = await buildVerifiedRegistryWithExternalLookup({
        citedPaperIds,
        corpus: bundle.corpus,
        externalProviders: {
          semanticScholar: deps.semanticScholar,
          openAlex: deps.openAlex,
          crossref: deps.crossref,
          arxiv: deps.arxiv
        },
        abortSignal
      });
      const verifiedRegistry = verifiedRegistryResult.artifact;
      const bibtex = buildPaperBibtex(
        dedupeCorpusRowsById([
          ...bundle.corpus,
          ...verifiedRegistryResult.supplemental_corpus_rows
        ]),
        uniqueStrings(
          verifiedRegistry.entries
            .filter((entry) => entry.status !== "blocked")
            .map((entry) => entry.resolved_paper_id || entry.citation_paper_id)
            .filter(Boolean) as string[]
        )
      );
      for (const entry of verifiedRegistry.entries) {
        const resolvedPaperId = entry.resolved_paper_id || entry.citation_paper_id;
        const citationKey = bibtex.citationKeysByPaperId.get(resolvedPaperId);
        if (citationKey) {
          bibtex.citationKeysByPaperId.set(entry.citation_paper_id, citationKey);
        }
      }
      const unresolvedCitationPaperIds = uniqueStrings([
        ...bibtex.unresolvedPaperIds,
        ...verifiedRegistry.blocked_citation_paper_ids
      ]);
      const manuscriptCandidate = validationRepair.applied
        ? buildFallbackPaperManuscript({
            draft: paperDraft,
            resultAnalysis: bundle.resultAnalysis,
            objectiveEvaluation,
            objectiveMetricProfile,
            experimentPlan: bundle.experimentPlan
          })
        : sessionResult.manuscript;
      const scientificManuscript = materializeScientificManuscript({
        candidate: manuscriptCandidate,
        draft: paperDraft,
        bundle,
        profile: paperProfile,
        objectiveEvaluation,
        objectiveMetricProfile,
        appendixPlan: scientificDraft.appendix_plan,
        pageBudget: scientificDraft.page_budget
      });
      const manuscriptQuality = await runManuscriptQualityLoop({
        run,
        sessions,
        bundle,
        draft: paperDraft,
        initialManuscript: scientificManuscript.manuscript,
        constraintProfile,
        paperProfile,
        objectiveMetricProfile,
        objectiveEvaluation,
        scientificValidationArtifact,
        appendixPlan: scientificDraft.appendix_plan,
        pageBudget: scientificDraft.page_budget,
        validationMode,
        citationKeysByPaperId: bibtex.citationKeysByPaperId,
        unresolvedCitationPaperIds,
        template: deps.config?.paper?.template,
        parsedTemplate,
        authorMetadata,
        emitLog,
        abortSignal,
        runContextMemory
      });
      let gateDecision = manuscriptQuality.evaluation.gateDecision;
      let finalScientificValidationArtifact = manuscriptQuality.evaluation.scientificValidation;
      const nonBlockingWarnings = gateDecision.issues.filter((i) => !i.blocking);
      if (nonBlockingWarnings.length > 0) {
        bundle.gateWarnings = nonBlockingWarnings.map((i) => ({
          severity: i.severity,
          category: i.category,
          message: i.message,
          outcome: i.outcome
        }));
        paperDraft = applyGateWarningsToLimitations(paperDraft, bundle.gateWarnings);
      }

      let manuscript = compactReaderFacingRepairedManuscript(manuscriptQuality.evaluation.manuscript);
      const shouldEnforceFinalPageFloor =
        validationMode === "strict_paper"
        || gateDecision.issues.some((issue) => issue.blocking && /^page_budget_/u.test(issue.code));
      const finalFloor = shouldEnforceFinalPageFloor
        ? enforceManuscriptPageBudgetFloor({
            manuscript,
            draft: paperDraft,
            pageBudget: scientificDraft.page_budget
          })
        : {
            manuscript,
            applied: false,
            minimum_main_words: 0,
            estimated_main_words_before: 0,
            estimated_main_words_after: 0,
            added_paragraph_count: 0,
            added_sections: []
          };
      if (finalFloor.applied) {
        manuscript = finalFloor.manuscript;
        manuscript = compactReaderFacingRepairedManuscript(manuscript);
        const postCleanupFloor = enforceManuscriptPageBudgetFloor({
          manuscript,
          draft: paperDraft,
          pageBudget: scientificDraft.page_budget
        });
        if (postCleanupFloor.applied) {
          manuscript = postCleanupFloor.manuscript;
        }
        emitLog(
          `Restored ${finalFloor.added_paragraph_count} final manuscript paragraph(s) after render cleanup compressed the main body ` +
          `from ${finalFloor.estimated_main_words_before} to ${
            postCleanupFloor.applied ? postCleanupFloor.estimated_main_words_after : finalFloor.estimated_main_words_after
          } words ` +
          `(minimum ${finalFloor.minimum_main_words}).`
        );
        finalScientificValidationArtifact = refreshScientificValidationForManuscript({
          validation: finalScientificValidationArtifact,
          manuscript,
          profile: paperProfile
        });
        gateDecision = buildWritePaperGateDecision({
          mode: validationMode,
          scientificValidation: finalScientificValidationArtifact,
          consistencyLint: manuscriptQuality.evaluation.consistencyLint,
          appendixLint: manuscriptQuality.evaluation.appendixLint
        });
      }
      const finalArtifactContext = experimentArtifactLoader({
        bundle,
        objectiveEvaluation,
        objectiveMetricProfile
      });
      manuscript = stabilizePaperManuscriptForSubmission(compactReaderFacingRepairedManuscript(manuscript), {
        resultAnalysis: bundle.resultAnalysis,
        methodModelNames: finalArtifactContext.method.model_names
      });
      if (shouldEnforceFinalPageFloor) {
        for (let pass = 0; pass < 3; pass += 1) {
          const stabilizedFloor = enforceManuscriptPageBudgetFloor({
            manuscript,
            draft: paperDraft,
            pageBudget: scientificDraft.page_budget
          });
          if (!stabilizedFloor.applied) {
            break;
          }
          manuscript = stabilizePaperManuscriptForSubmission(
            compactReaderFacingRepairedManuscript(stabilizedFloor.manuscript),
            {
              resultAnalysis: bundle.resultAnalysis,
              methodModelNames: finalArtifactContext.method.model_names
            }
          );
        }
        const finalStabilizedFloor = enforceManuscriptPageBudgetFloor({
          manuscript,
          draft: paperDraft,
          pageBudget: scientificDraft.page_budget
        });
        if (finalStabilizedFloor.applied) {
          manuscript = stabilizePaperManuscriptForSubmission(
            compactReaderFacingRepairedManuscript(finalStabilizedFloor.manuscript),
            {
              resultAnalysis: bundle.resultAnalysis,
              methodModelNames: finalArtifactContext.method.model_names
            }
          );
          emitLog(
            `Restored ${finalStabilizedFloor.added_paragraph_count} final manuscript paragraph(s) after final stabilization compressed the main body ` +
            `from ${finalStabilizedFloor.estimated_main_words_before} to ${finalStabilizedFloor.estimated_main_words_after} words ` +
            `(minimum ${finalStabilizedFloor.minimum_main_words}).`
          );
        }
        const postFinalStabilizedFloor = enforceManuscriptPageBudgetFloor({
          manuscript,
          draft: paperDraft,
          pageBudget: scientificDraft.page_budget
        });
        if (postFinalStabilizedFloor.applied) {
          manuscript = stabilizePaperManuscriptForSubmission(
            compactReaderFacingRepairedManuscript(postFinalStabilizedFloor.manuscript),
            {
              resultAnalysis: bundle.resultAnalysis,
              methodModelNames: finalArtifactContext.method.model_names
            }
          );
          emitLog(
            `Restored ${postFinalStabilizedFloor.added_paragraph_count} final manuscript paragraph(s) after the last stabilization pass compressed the main body ` +
            `from ${postFinalStabilizedFloor.estimated_main_words_before} to ${postFinalStabilizedFloor.estimated_main_words_after} words ` +
            `(minimum ${postFinalStabilizedFloor.minimum_main_words}).`
          );
        }
        const terminalFloor = enforceManuscriptPageBudgetFloor({
          manuscript,
          draft: paperDraft,
          pageBudget: scientificDraft.page_budget
        });
        if (terminalFloor.applied) {
          manuscript = terminalFloor.manuscript;
          emitLog(
            `Restored ${terminalFloor.added_paragraph_count} final manuscript paragraph(s) after terminal stabilization compressed the main body ` +
            `from ${terminalFloor.estimated_main_words_before} to ${terminalFloor.estimated_main_words_after} words ` +
            `(minimum ${terminalFloor.minimum_main_words}).`
          );
        }
      }
      finalScientificValidationArtifact = refreshScientificValidationForManuscript({
        validation: finalScientificValidationArtifact,
        manuscript,
        profile: paperProfile
      });
      const finalConsistencyLint = manuscriptConsistencyLinter({
        manuscript,
        context: finalArtifactContext
      });
      const finalAppendixLint = appendixConsistencyLinter({
        manuscript,
        appendixPlan: scientificDraft.appendix_plan,
        pageBudget: scientificDraft.page_budget
      });
      gateDecision = buildWritePaperGateDecision({
        mode: validationMode,
        scientificValidation: finalScientificValidationArtifact,
        consistencyLint: finalConsistencyLint,
        appendixLint: finalAppendixLint
      });
      try {
        buildWritePaperFigurePayload(manuscript, resultsContract);
      } catch (error) {
        const message =
          `write_paper stopped because manuscript result visuals do not satisfy the validated V2 contract: `
          + `${error instanceof Error ? error.message : String(error)}`;
        emitLog(message);
        await runContextMemory.put("write_paper.last_error", message);
        return {
          status: "failure",
          error: message,
          summary: message,
          toolCallsUsed: manuscriptQuality.toolCallsUsed
        };
      }
      const traceability = buildPaperTraceability({
        draft: paperDraft,
        manuscript
      });
      let tex = renderSubmissionPaperTex({
        manuscript,
        traceability,
        citationKeysByPaperId: bibtex.citationKeysByPaperId,
        template: deps.config?.paper?.template,
        paperProfile,
        parsedTemplate,
        authorMetadata,
        includeKeywords: !parsedTemplate
      });
      let figureManifest = buildPaperFigureManifest({
        manuscript,
        runTitle: run.title,
        topic: bundle.experimentPlan?.selectedTitle || run.title
      });
      const publicPaperDir = buildPublicPaperDir(process.cwd(), run);
      await ensureDir(publicPaperDir);
      const publicFiguresDir = path.join(publicPaperDir, "figures");
      await ensureDir(publicFiguresDir);
      const runPaperDirForFigures = path.join(process.cwd(), ".autolabos", "runs", run.id, "paper");
      if (
        resultsContract
        && deps.config?.paper?.build_pdf === true
        && typeof deps.aci?.runCommand === "function"
      ) {
        figureManifest = await maybeRenderPaperFigureAssets({
          deps,
          run,
          manuscript,
          resultsContract,
          figureManifest,
          runPaperDir: runPaperDirForFigures,
          publicPaperDir,
          abortSignal,
          emitLog
        });
      }
      const renderedFigureAssetCount = figureManifest.figures.filter(
        (entry) => entry.kind === "result_chart" && entry.render_status === "pass" && entry.path
      ).length;
      const manuscriptFigureCount = (manuscript.figures || []).length;
      const shouldUseExternalFigureAssets =
        manuscriptFigureCount > 0 && deps.config?.paper?.build_pdf === true;
      if (manuscriptFigureCount > 0 && (renderedFigureAssetCount > 0 || shouldUseExternalFigureAssets)) {
        tex = renderSubmissionPaperTex({
          manuscript,
          traceability,
          citationKeysByPaperId: bibtex.citationKeysByPaperId,
          template: deps.config?.paper?.template,
          paperProfile,
          parsedTemplate,
          authorMetadata,
          includeKeywords: !parsedTemplate,
          figureRenderMode: "external_pdf"
        });
      } else if (parsedTemplate) {
        tex = renderSubmissionPaperTex({
          manuscript,
          traceability,
          citationKeysByPaperId: bibtex.citationKeysByPaperId,
          template: deps.config?.paper?.template,
          paperProfile,
          parsedTemplate,
          authorMetadata,
          includeKeywords: false
        });
      }
      const figureManifestJson = `${JSON.stringify(figureManifest, null, 2)}\n`;
      const conceptualDiagramPromptJson = figureManifest.conceptual_diagram_prompt
        ? `${JSON.stringify(figureManifest.conceptual_diagram_prompt, null, 2)}\n`
        : undefined;
      const evidenceMapObject = attachRunArtifactRefsToEvidenceMap(buildPaperEvidenceMap(paperDraft), bundle);
      const evidenceMap = JSON.stringify(evidenceMapObject, null, 2);
      const traceabilityJson = `${JSON.stringify(traceability, null, 2)}\n`;
      const manuscriptJson = `${JSON.stringify(manuscript, null, 2)}\n`;
      const provenanceMapJson = `${JSON.stringify(scientificManuscript.provenance_map, null, 2)}\n`;
      const submissionValidation = buildPaperSubmissionValidation({
        manuscript,
        tex,
        traceability,
        citationKeysByPaperId: bibtex.citationKeysByPaperId,
        unresolvedCitationPaperIds
      });
      const claimEvidenceTable = buildClaimEvidenceTableArtifact(evidenceMapObject, bundle);
      const claimStatusTable = buildClaimStatusTableArtifact({
        evidenceMap: evidenceMapObject,
        traceability,
        verifiedRegistry,
        bundle
      });
      const evidenceGateDecision = buildEvidenceGateDecisionArtifact(claimStatusTable);

      await writeRunArtifact(run, "paper/main.tex", tex);
      await writeRunArtifact(run, "paper/references.bib", bibtex.references);
      await writeRunArtifact(run, "paper/evidence_links.json", evidenceMap);
      await writeRunArtifact(
        run,
        "paper/claim_evidence_table.json",
        `${JSON.stringify(claimEvidenceTable, null, 2)}\n`
      );
      await writeRunArtifact(
        run,
        "paper/verified_registry.json",
        `${JSON.stringify(verifiedRegistry, null, 2)}\n`
      );
      await writeRunArtifact(
        run,
        "paper/claim_status_table.json",
        `${JSON.stringify(claimStatusTable, null, 2)}\n`
      );
      await writeRunArtifact(
        run,
        "paper/evidence_gate_decision.json",
        `${JSON.stringify(evidenceGateDecision, null, 2)}\n`
      );
      await writeRunArtifact(run, "paper/figures/figure_manifest.json", figureManifestJson);
      if (conceptualDiagramPromptJson) {
        await writeRunArtifact(run, "paper/figures/concept_diagram_prompt.json", conceptualDiagramPromptJson);
      }
      let citationConsistency = checkCitationConsistency(path.join(process.cwd(), ".autolabos", "runs", run.id));
      let referenceAuthorityGate = await inspectReferenceAuthorityGate(
        path.join(process.cwd(), ".autolabos", "runs", run.id, "paper")
      );
      await writeRunArtifact(
        run,
        "paper/citation_consistency.json",
        `${JSON.stringify(citationConsistency, null, 2)}\n`
      );
      await writeRunArtifact(
        run,
        "paper/reference_authority_gate.json",
        `${JSON.stringify(referenceAuthorityGate, null, 2)}\n`
      );
      await writeRunArtifact(run, "paper/draft.json", `${JSON.stringify(paperDraft, null, 2)}\n`);
      await writeRunArtifact(run, "paper/manuscript.json", manuscriptJson);
      await writeRunArtifact(run, "paper/traceability.json", traceabilityJson);
      await writeRunArtifact(run, "paper/provenance_map.json", provenanceMapJson);
      await writeRunArtifact(
        run,
        "paper/scientific_validation.json",
        `${JSON.stringify(finalScientificValidationArtifact, null, 2)}\n`
      );
      await writeRunArtifact(run, "paper/validation.json", `${JSON.stringify(validation, null, 2)}\n`);
      await writeRunArtifact(
        run,
        "paper/consistency_lint.json",
        `${JSON.stringify(
          {
            manuscript: finalConsistencyLint,
            appendix: finalAppendixLint
          },
          null,
          2
        )}\n`
      );
      await writeRunArtifact(
        run,
        "paper/gate_decision.json",
        `${JSON.stringify(gateDecision, null, 2)}\n`
      );
      await writeRunArtifact(
        run,
        "paper/submission_validation.json",
        `${JSON.stringify(submissionValidation, null, 2)}\n`
      );
      await writeRunArtifact(
        run,
        "paper/validation_repair_report.json",
        `${JSON.stringify(validationRepair, null, 2)}\n`
      );

      await fs.writeFile(path.join(publicPaperDir, "main.tex"), tex, "utf8");
      await fs.writeFile(path.join(publicPaperDir, "references.bib"), bibtex.references, "utf8");
      await fs.writeFile(path.join(publicPaperDir, "manuscript.json"), manuscriptJson, "utf8");
      await fs.writeFile(path.join(publicPaperDir, "traceability.json"), traceabilityJson, "utf8");
      await fs.writeFile(path.join(publicPaperDir, "provenance_map.json"), provenanceMapJson, "utf8");
      await fs.writeFile(path.join(publicPaperDir, "evidence_links.json"), evidenceMap, "utf8");
      await fs.writeFile(
        path.join(publicPaperDir, "claim_evidence_table.json"),
        `${JSON.stringify(claimEvidenceTable, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(publicPaperDir, "verified_registry.json"),
        `${JSON.stringify(verifiedRegistry, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(publicPaperDir, "claim_status_table.json"),
        `${JSON.stringify(claimStatusTable, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(publicPaperDir, "evidence_gate_decision.json"),
        `${JSON.stringify(evidenceGateDecision, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(path.join(publicFiguresDir, "figure_manifest.json"), figureManifestJson, "utf8");
      if (conceptualDiagramPromptJson) {
        await fs.writeFile(
          path.join(publicFiguresDir, "concept_diagram_prompt.json"),
          conceptualDiagramPromptJson,
          "utf8"
        );
      }
      await fs.writeFile(
        path.join(publicPaperDir, "citation_consistency.json"),
        `${JSON.stringify(citationConsistency, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(publicPaperDir, "reference_authority_gate.json"),
        `${JSON.stringify(referenceAuthorityGate, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(publicPaperDir, "scientific_validation.json"),
        `${JSON.stringify(finalScientificValidationArtifact, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(path.join(publicPaperDir, "gate_decision.json"), `${JSON.stringify(gateDecision, null, 2)}\n`, "utf8");
      await fs.writeFile(
        path.join(publicPaperDir, "manuscript_review.json"),
        `${JSON.stringify(manuscriptQuality.review, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(publicPaperDir, "manuscript_review_validation.json"),
        `${JSON.stringify(manuscriptQuality.reviewValidation, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(publicPaperDir, "manuscript_review_audit.json"),
        `${JSON.stringify(manuscriptQuality.reviewAudit, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(publicPaperDir, "manuscript_style_lint.json"),
        `${JSON.stringify(manuscriptQuality.evaluation.styleLint, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(publicPaperDir, "manuscript_quality_gate.json"),
        `${JSON.stringify(manuscriptQuality.repairDecision, null, 2)}\n`,
        "utf8"
      );

      const fallbackReadinessRisks = buildFallbackPaperReadinessRiskArtifact({
        preDraftCritique,
        verifiedRegistry,
        claimStatusTable,
        evidenceGateDecision,
        citationReport: citationConsistency,
        referenceAuthorityGate,
        scientificGateStatus: gateDecision.status,
        submissionValidationOk: submissionValidation.ok,
        manuscriptQualityAction: manuscriptQuality.repairDecision.action,
        config: deps.config
      });
      await writeRunArtifact(
        run,
        "paper/readiness_risks.json",
        `${JSON.stringify(fallbackReadinessRisks, null, 2)}\n`
      );
      await fs.writeFile(
        path.join(publicPaperDir, "readiness_risks.json"),
        `${JSON.stringify(fallbackReadinessRisks, null, 2)}\n`,
        "utf8"
      );
      const preliminaryManuscriptType = preDraftCritique?.manuscript_type || "paper_scale_candidate";
      const preliminaryPaperReadiness = buildPaperReadinessArtifact({
        manuscriptType: preliminaryManuscriptType,
        preDraftManuscriptType: preDraftCritique?.pre_draft_manuscript_type,
        claimCeilingApplied: preDraftCritique?.claim_ceiling_applied,
        overallScore: preDraftCritique?.overall_score,
        evidenceGateDecision,
        claimStatusTable,
        citationReport: citationConsistency,
        referenceAuthorityGate,
        scientificGateStatus: gateDecision.status,
        submissionValidationOk: submissionValidation.ok,
        manuscriptQualityAction: manuscriptQuality.repairDecision.action
      });
      await writeRunArtifact(
        run,
        "paper/paper_readiness.json",
        `${JSON.stringify(preliminaryPaperReadiness, null, 2)}\n`
      );
      await fs.writeFile(
        path.join(publicPaperDir, "paper_readiness.json"),
        `${JSON.stringify(preliminaryPaperReadiness, null, 2)}\n`,
        "utf8"
      );

      const preCompileToolCallsUsed =
        Math.max(1, 4 - sessionResult.stageFallbacks)
        + (validationRepair.attempted ? 1 : 0)
        + manuscriptQuality.toolCallsUsed;
      await runContextMemory.put("write_paper.public_dir", publicPaperDir);
      await runContextMemory.put("write_paper.source", sessionResult.source);
      await runContextMemory.put("write_paper.section_count", paperDraft.sections.length);
      await runContextMemory.put("write_paper.cited_paper_ids", bibtex.usedPaperIds);
      await runContextMemory.put("write_paper.last_draft", paperDraft);
      await runContextMemory.put("write_paper.last_manuscript", manuscript);
      await runContextMemory.put("write_paper.traceability", traceability);
      await runContextMemory.put("write_paper.provenance_map", scientificManuscript.provenance_map);
      await runContextMemory.put("write_paper.claim_evidence_table", claimEvidenceTable);
      await runContextMemory.put("write_paper.verified_registry", verifiedRegistry);
      await runContextMemory.put("write_paper.claim_status_table", claimStatusTable);
      await runContextMemory.put("write_paper.evidence_gate_decision", evidenceGateDecision);
      await runContextMemory.put("write_paper.figure_manifest", figureManifest);
      await runContextMemory.put("write_paper.citation_consistency", citationConsistency);
      await runContextMemory.put("write_paper.scientific_validation", finalScientificValidationArtifact);
      await runContextMemory.put("write_paper.validation", validation);
      await runContextMemory.put("write_paper.consistency_lint", {
        manuscript: manuscriptQuality.evaluation.consistencyLint,
        appendix: manuscriptQuality.evaluation.appendixLint
      });
      await runContextMemory.put("write_paper.gate_decision", gateDecision);
      await runContextMemory.put("write_paper.submission_validation", submissionValidation);
      await runContextMemory.put("write_paper.validation_repair", validationRepair);
      await runContextMemory.put("write_paper.manuscript_review", manuscriptQuality.review);
      await runContextMemory.put("write_paper.manuscript_review_validation", manuscriptQuality.reviewValidation);
      await runContextMemory.put("write_paper.manuscript_review_audit", manuscriptQuality.reviewAudit);
      await runContextMemory.put("write_paper.manuscript_style_lint", manuscriptQuality.evaluation.styleLint);
      await runContextMemory.put("write_paper.manuscript_quality_gate", manuscriptQuality.repairDecision);
      await runContextMemory.put("write_paper.manuscript_repair_reports", manuscriptQuality.repairReports);
      await runContextMemory.put("write_paper.readiness_risks", fallbackReadinessRisks);
      await runContextMemory.put("write_paper.paper_readiness", preliminaryPaperReadiness);
      if (
        manuscriptQuality.repairDecision.action === "stop"
        && evidenceGateDecision.status !== "fail"
        && gateDecision.status !== "fail"
        && submissionValidation.ok
      ) {
        const manuscriptError = buildManuscriptQualityFailureError(manuscriptQuality.repairDecision);
        emitLog(manuscriptError);
        await runContextMemory.put("write_paper.last_error", manuscriptError);
        await runContextMemory.put("write_paper.compile_status", null);
        await runContextMemory.put("write_paper.compile_report", null);
        await runContextMemory.put("write_paper.pdf_path", null);
        return {
          status: "failure",
          error: manuscriptError,
          summary: manuscriptError,
          toolCallsUsed: preCompileToolCallsUsed
        };
      }
      if (gateDecision.status === "warn") {
        emitLog(`Scientific quality gate warnings (${validationMode} mode): ${gateDecision.summary.slice(1).join(" ")}`);
      }
      if (evidenceGateDecision.status === "warn") {
        emitLog(`Evidence gate warnings: ${evidenceGateDecision.summary_lines.join(" ")}`);
      }
      if (evidenceGateDecision.status === "fail") {
        const evidenceGateError = buildEvidenceGateFailureError(evidenceGateDecision);
        emitLog(evidenceGateError);
        await runContextMemory.put("write_paper.last_error", evidenceGateError);
        await runContextMemory.put("write_paper.compile_status", null);
        await runContextMemory.put("write_paper.compile_report", null);
        await runContextMemory.put("write_paper.pdf_path", null);
        return {
          status: "failure",
          error: evidenceGateError,
          summary: evidenceGateError,
          toolCallsUsed: preCompileToolCallsUsed
        };
      }
      if (gateDecision.status === "fail") {
        const gateError = buildScientificGateFailureError(gateDecision);
        emitLog(gateError);
        await runContextMemory.put("write_paper.last_error", gateError);
        await runContextMemory.put("write_paper.compile_status", null);
        await runContextMemory.put("write_paper.compile_report", null);
        await runContextMemory.put("write_paper.pdf_path", null);
        return {
          status: "failure",
          error: gateError,
          summary: gateError,
          toolCallsUsed: preCompileToolCallsUsed
        };
      }
      if (!submissionValidation.ok) {
        const submissionError = buildSubmissionValidationError(submissionValidation);
        emitLog(submissionError);
        await runContextMemory.put("write_paper.last_error", submissionError);
        await runContextMemory.put("write_paper.compile_status", null);
        await runContextMemory.put("write_paper.compile_report", null);
        await runContextMemory.put("write_paper.pdf_path", null);
        return {
          status: "failure",
          error: submissionError,
          summary: submissionError,
          toolCallsUsed: preCompileToolCallsUsed
        };
      }

      // Build post-draft critique artifact
      const postDraftCritique = buildPostDraftCritique({
        preDraftCritique,
        gateDecision,
        scientificValidation: finalScientificValidationArtifact,
        submissionValidation,
        manuscriptSections: manuscript.sections.map((s: { heading: string }) => s.heading),
        validationWarningCount: validation.issues.length,
        claimRewriteCount: scientificDraft.claim_rewrite_report.rewrites.length,
        evidenceDiagnostics: scientificDraft.evidence_diagnostics,
        pageBudgetStatus: scientificDraft.page_budget.status,
        methodStatus: scientificDraft.method_completeness.status,
        resultsStatus: scientificDraft.results_richness.status,
        relatedWorkStatus: scientificDraft.related_work_richness.status,
        discussionStatus: scientificDraft.discussion_richness.status
      });
      await writeRunArtifact(
        run,
        "paper/paper_critique.json",
        `${JSON.stringify(postDraftCritique, null, 2)}\n`
      );
      const paperReadiness = buildPaperReadinessArtifact({
        manuscriptType: postDraftCritique.manuscript_type,
        preDraftManuscriptType: postDraftCritique.pre_draft_manuscript_type,
        claimCeilingApplied: postDraftCritique.claim_ceiling_applied,
        overallScore: postDraftCritique.overall_score,
        evidenceGateDecision,
        claimStatusTable,
        citationReport: citationConsistency,
        referenceAuthorityGate,
        scientificGateStatus: gateDecision.status,
        submissionValidationOk: submissionValidation.ok,
        manuscriptQualityAction: manuscriptQuality.repairDecision.action
      });
      const readinessRisks = buildPaperReadinessRiskArtifact({
        manuscriptType: postDraftCritique.manuscript_type,
        paperReadiness,
        verifiedRegistry,
        claimStatusTable,
        evidenceGateDecision,
        scientificGateStatus: gateDecision.status,
        submissionValidationOk: submissionValidation.ok,
        manuscriptQualityAction: manuscriptQuality.repairDecision.action,
        config: deps.config
      });
      await writeRunArtifact(
        run,
        "paper/paper_readiness.json",
        `${JSON.stringify(paperReadiness, null, 2)}\n`
      );
      await writeRunArtifact(
        run,
        "paper/readiness_risks.json",
        `${JSON.stringify(readinessRisks, null, 2)}\n`
      );
      await runContextMemory.put("write_paper.paper_critique", postDraftCritique);
      await runContextMemory.put("write_paper.paper_readiness", paperReadiness);
      await runContextMemory.put("write_paper.readiness_risks", readinessRisks);
      await runContextMemory.put("write_paper.manuscript_type", postDraftCritique.manuscript_type);
      const operatorSummaryInput = {
        runId: run.id,
        title: run.title,
        stage: "paper" as const,
        summary: [
          `Paper readiness: ${paperReadiness.readiness_state}.`,
          paperReadiness.reason,
          `Manuscript decision: ${postDraftCritique.overall_decision}.`
        ],
        decision: `paper_ready=${paperReadiness.paper_ready}; evidence_gate=${paperReadiness.evidence_gate_status}; scientific_validation=${paperReadiness.scientific_validation_status}.`,
        blockers: readinessRisks.risks.filter((risk) => risk.severity === "blocked").slice(0, 4).map((risk) => risk.message),
        openQuestions: readinessRisks.risks.filter((risk) => risk.severity === "warning").slice(0, 3).map((risk) => risk.message),
        nextActions: readinessRisks.risks.slice(0, 3).map((risk) => risk.recommended_action),
        references: [
          { label: "Paper readiness", path: "paper/paper_readiness.json" },
          { label: "Paper critique", path: "paper/paper_critique.json" },
          { label: "Readiness risks", path: "paper/readiness_risks.json" },
          { label: "Citation consistency", path: "paper/citation_consistency.json" },
          { label: "Claim evidence table", path: "paper/claim_evidence_table.json" },
          { label: "Evidence gate decision", path: "paper/evidence_gate_decision.json" },
          { label: "Main TeX", path: "paper/main.tex" }
        ]
      };
      const operatorSummaryPath = await writeRunArtifact(
        run,
        "operator_summary.md",
        renderOperatorSummaryMarkdown(operatorSummaryInput)
      );
      const operatorHistoryPath = await writeRunArtifact(
        run,
        buildOperatorHistoryRelativePath("paper"),
        renderOperatorHistoryMarkdown(operatorSummaryInput)
      );
      const runStatus = await buildRunOperatorStatus({
        workspaceRoot: process.cwd(),
        run,
        currentNode: "write_paper",
        approvalMode: deps.config?.workflow?.approval_mode || "minimal",
        networkPolicy: deps.config?.experiments?.network_policy,
        networkPurpose: deps.config?.experiments?.network_purpose
      });
      const runStatusPath = await writeRunArtifact(
        run,
        "run_status.json",
        `${JSON.stringify(runStatus, null, 2)}\n`
      );
      emitLog(
        `Post-draft critique: manuscript_type=${postDraftCritique.manuscript_type}, ` +
        `decision=${postDraftCritique.overall_decision}, ` +
        `blocking=${postDraftCritique.blocking_issues_count}.`
      );

      // If post-draft critique recommends upstream backtrack, emit transition
      const postDraftTransition = buildPostDraftTransitionRecommendation(postDraftCritique);

      const compileResult = await maybeBuildPaperPdf({
        deps,
        sessions,
        run,
        abortSignal,
        emitLog,
        publicPaperDir,
        parsedTemplate
      });
      const runPaperDir = path.join(process.cwd(), ".autolabos", "runs", run.id, "paper");
      const publicOutputs = await publishPublicRunOutputs({
        workspaceRoot: process.cwd(),
        run,
        node: "write_paper",
        runContext: runContextMemory,
        section: "paper",
        files: [
          {
            sourcePath: path.join(runPaperDir, "main.tex"),
            targetRelativePath: "main.tex"
          },
          {
            sourcePath: path.join(runPaperDir, "references.bib"),
            targetRelativePath: "references.bib"
          },
          {
            sourcePath: path.join(runPaperDir, "manuscript.json"),
            targetRelativePath: "manuscript.json"
          },
          {
            sourcePath: path.join(runPaperDir, "traceability.json"),
            targetRelativePath: "traceability.json"
          },
          {
            sourcePath: path.join(runPaperDir, "provenance_map.json"),
            targetRelativePath: "provenance_map.json"
          },
          {
            sourcePath: path.join(runPaperDir, "gate_decision.json"),
            targetRelativePath: "gate_decision.json"
          },
          {
            sourcePath: path.join(runPaperDir, "evidence_links.json"),
            targetRelativePath: "evidence_links.json"
          },
          {
            sourcePath: path.join(runPaperDir, "claim_evidence_table.json"),
            targetRelativePath: "claim_evidence_table.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "verified_registry.json"),
            targetRelativePath: "verified_registry.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "claim_status_table.json"),
            targetRelativePath: "claim_status_table.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "evidence_gate_decision.json"),
            targetRelativePath: "evidence_gate_decision.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "figures", "figure_manifest.json"),
            targetRelativePath: "figures/figure_manifest.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "figures", "concept_diagram_prompt.json"),
            targetRelativePath: "figures/concept_diagram_prompt.json",
            optional: true
          },
          ...figureManifest.figures
            .filter((entry) => entry.kind === "result_chart" && entry.path)
            .map((entry) => ({
              sourcePath: path.join(runPaperDir, entry.path!),
              targetRelativePath: entry.path!,
              optional: true
            })),
          {
            sourcePath: path.join(runPaperDir, "paper_readiness.json"),
            targetRelativePath: "paper_readiness.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "submission_validation.json"),
            targetRelativePath: "submission_validation.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "citation_consistency.json"),
            targetRelativePath: "citation_consistency.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "paper_critique.json"),
            targetRelativePath: "paper_critique.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "readiness_risks.json"),
            targetRelativePath: "readiness_risks.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "manuscript_review.json"),
            targetRelativePath: "manuscript_review.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "manuscript_review_validation.json"),
            targetRelativePath: "manuscript_review_validation.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "manuscript_review_audit.json"),
            targetRelativePath: "manuscript_review_audit.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "manuscript_style_lint.json"),
            targetRelativePath: "manuscript_style_lint.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "manuscript_quality_gate.json"),
            targetRelativePath: "manuscript_quality_gate.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "main.pdf"),
            targetRelativePath: "main.pdf",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "build.log"),
            targetRelativePath: "build.log",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "scientific_validation.json"),
            targetRelativePath: "scientific_validation.json",
            optional: true
          },
          {
            sourcePath: path.join(runPaperDir, "compiled_page_validation.json"),
            targetRelativePath: "compiled_page_validation.json",
            optional: true
          }
        ]
      });
      await publishPublicRunOutputs({
        workspaceRoot: process.cwd(),
        run,
        node: "write_paper",
        section: "results",
        files: [
          {
            sourcePath: operatorSummaryPath,
            targetRelativePath: "operator_summary.md"
          },
          {
            sourcePath: operatorHistoryPath,
            targetRelativePath: buildOperatorHistoryRelativePath("paper")
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
        currentNode: "write_paper"
      });
      const completenessChecklistPath = await writeRunArtifact(
        run,
        "run_completeness_checklist.json",
        `${JSON.stringify(completenessChecklist, null, 2)}\n`
      );
      await publishPublicRunOutputs({
        workspaceRoot: process.cwd(),
        run,
        node: "write_paper",
        section: "results",
        files: [
          {
            sourcePath: completenessChecklistPath,
            targetRelativePath: "run_completeness_checklist.json"
          }
        ]
      });
      emitLog(`Public paper outputs are available at ${publicOutputs.sectionDirRelative}.`);

      // Generate output bundle README after all sections are published
      try {
        await generatePublicRunReadme(process.cwd(), run);
      } catch {
        // non-fatal — README generation is best-effort
      }
      const toolCallsUsed = preCompileToolCallsUsed + compileResult.toolCallsUsed;
      await runContextMemory.put("write_paper.compile_status", compileResult.status);
      await runContextMemory.put("write_paper.compile_report", compileResult);
      await runContextMemory.put("write_paper.pdf_path", compileResult.pdf_path || null);
      let pendingCompileError: string | undefined;
      if (compileResult.status === "failed") {
        const compileError = buildCompileFailureError(compileResult);
        emitLog(compileError);
        // Treat missing-tool compile failures as non-fatal — the LaTeX source was generated
        // successfully and the scientific quality gate already passed.
        const isMissingTool = compileResult.attempts.some(
          (a) => a.error && /not found|command not found|ENOENT/iu.test(a.error)
        );
        if (!isMissingTool && !compileResult.pdf_path) {
          await runContextMemory.put("write_paper.last_error", compileError);
          return {
            status: "failure",
            error: compileError,
            summary: compileError,
            toolCallsUsed
          };
        }
        if (isMissingTool) {
          emitLog("PDF compilation tool is unavailable; continuing with LaTeX source only.");
        } else {
          pendingCompileError = compileError;
        }
      }
      const compiledPageValidation = await validateCompiledPdfPageBudget({
        deps,
        run,
        compileResult,
        validationMode,
        minimumMainPages: scientificDraft.page_budget.minimum_main_pages,
        targetMainPages: scientificDraft.page_budget.target_main_pages,
        referencesCounted: scientificDraft.page_budget.references_counted,
        appendicesCounted: !scientificDraft.page_budget.appendix_allowed
      });
      await writeRunArtifact(
        run,
        "paper/compiled_page_validation.json",
        `${JSON.stringify(compiledPageValidation, null, 2)}\n`
      );
      await fs.writeFile(
        path.join(publicPaperDir, "compiled_page_validation.json"),
        `${JSON.stringify(compiledPageValidation, null, 2)}\n`,
        "utf8"
      );
      await runContextMemory.put("write_paper.compiled_page_validation", compiledPageValidation);
      if (compiledPageValidation.status === "warn") {
        emitLog(`Compiled PDF page-budget warning: ${compiledPageValidation.message}`);
      }
      const finalTexForValidation = (await safeRead(path.join(runPaperDir, "main.tex"))) || tex;
      citationConsistency = checkCitationConsistency(path.join(process.cwd(), ".autolabos", "runs", run.id));
      referenceAuthorityGate = await inspectReferenceAuthorityGate(runPaperDir);
      await writeRunArtifact(
        run,
        "paper/citation_consistency.json",
        `${JSON.stringify(citationConsistency, null, 2)}\n`
      );
      await writeRunArtifact(
        run,
        "paper/reference_authority_gate.json",
        `${JSON.stringify(referenceAuthorityGate, null, 2)}\n`
      );
      await fs.writeFile(
        path.join(publicPaperDir, "citation_consistency.json"),
        `${JSON.stringify(citationConsistency, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(publicPaperDir, "reference_authority_gate.json"),
        `${JSON.stringify(referenceAuthorityGate, null, 2)}\n`,
        "utf8"
      );
      const renderValidation = buildPaperRenderValidation({
        validationMode,
        manuscript,
        tex: finalTexForValidation,
        authorMetadata,
        parsedTemplate,
        citationReport: citationConsistency,
        compileResult,
        compiledPageValidation,
        figureManifest
      });
      await writeRunArtifact(
        run,
        "paper/render_validation.json",
        `${JSON.stringify(renderValidation, null, 2)}\n`
      );
      await fs.writeFile(
        path.join(publicPaperDir, "render_validation.json"),
        `${JSON.stringify(renderValidation, null, 2)}\n`,
        "utf8"
      );
      await runContextMemory.put("write_paper.render_validation", renderValidation);
      if (renderValidation.status === "warn") {
        emitLog(`Rendered manuscript validation warning: ${renderValidation.summary.join(" ")}`);
      }
      const finalPaperReadiness = buildPaperReadinessArtifact({
        manuscriptType: postDraftCritique.manuscript_type,
        preDraftManuscriptType: postDraftCritique.pre_draft_manuscript_type,
        claimCeilingApplied: postDraftCritique.claim_ceiling_applied,
        overallScore: postDraftCritique.overall_score,
        evidenceGateDecision,
        claimStatusTable,
        citationReport: citationConsistency,
        referenceAuthorityGate,
        scientificGateStatus: gateDecision.status,
        submissionValidationOk: submissionValidation.ok,
        manuscriptQualityAction: manuscriptQuality.repairDecision.action,
        compileStatus: compileResult.status,
        compiledPageValidationStatus: compiledPageValidation.status,
        renderValidationStatus: renderValidation.status
      });
      const finalReadinessRisks = buildPaperReadinessRiskArtifact({
        manuscriptType: postDraftCritique.manuscript_type,
        paperReadiness: finalPaperReadiness,
        verifiedRegistry,
        claimStatusTable,
        evidenceGateDecision,
        scientificGateStatus: gateDecision.status,
        submissionValidationOk: submissionValidation.ok,
        manuscriptQualityAction: manuscriptQuality.repairDecision.action,
        compileStatus: compileResult.status,
        compiledPageValidation,
        renderValidation,
        config: deps.config
      });
      await writeRunArtifact(
        run,
        "paper/paper_readiness.json",
        `${JSON.stringify(finalPaperReadiness, null, 2)}\n`
      );
      await writeRunArtifact(
        run,
        "paper/readiness_risks.json",
        `${JSON.stringify(finalReadinessRisks, null, 2)}\n`
      );
      await fs.writeFile(
        path.join(publicPaperDir, "paper_readiness.json"),
        `${JSON.stringify(finalPaperReadiness, null, 2)}\n`,
        "utf8"
      );
      await fs.writeFile(
        path.join(publicPaperDir, "readiness_risks.json"),
        `${JSON.stringify(finalReadinessRisks, null, 2)}\n`,
        "utf8"
      );
      await runContextMemory.put("write_paper.paper_readiness", finalPaperReadiness);
      await runContextMemory.put("write_paper.readiness_risks", finalReadinessRisks);
      if (pendingCompileError) {
        await runContextMemory.put("write_paper.last_error", pendingCompileError);
        return {
          status: "failure",
          error: pendingCompileError,
          summary: pendingCompileError,
          toolCallsUsed
        };
      }
      if (renderValidation.status === "fail") {
        const renderValidationError = buildPaperRenderValidationError(renderValidation);
        emitLog(renderValidationError);
        await runContextMemory.put("write_paper.last_error", renderValidationError);
        return {
          status: "failure",
          error: renderValidationError,
          summary: renderValidationError,
          toolCallsUsed
        };
      }
      if (compiledPageValidation.status === "fail") {
        const pageValidationError = buildCompiledPdfPageValidationError(compiledPageValidation);
        emitLog(pageValidationError);
        await runContextMemory.put("write_paper.last_error", pageValidationError);
        return {
          status: "failure",
          error: pageValidationError,
          summary: pageValidationError,
          toolCallsUsed
        };
      }
      await runContextMemory.put("write_paper.last_error", sessionResult.errors[0] || null);

      return {
        status: "success",
        summary:
          sessionResult.source === "fallback"
            ? `Paper draft generated in LaTeX using staged fallbacks. Validation warnings: ${validation.issues.length}${describeValidationRepair(validationRepair)}. Scientific gate: ${describeScientificGateStatus(gateDecision)}. Manuscript: ${postDraftCritique.manuscript_type}. PDF: ${describeCompileStatus(compileResult)}. Public outputs: ${publicOutputs.outputRootRelative}.`
            : `Paper draft generated in LaTeX from ${paperDraft.sections.length} structured section(s) via ${sessionResult.source} with ${validation.issues.length} validation warning(s)${describeValidationRepair(validationRepair)}. Scientific gate: ${describeScientificGateStatus(gateDecision)}. Manuscript: ${postDraftCritique.manuscript_type}. PDF: ${describeCompileStatus(compileResult)}. Public outputs: ${publicOutputs.outputRootRelative}.`,
        needsApproval: true,
        toolCallsUsed,
        transitionRecommendation: postDraftTransition
      };
  }
};
}

async function persistBlockedWritePaperReadiness(input: {
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"];
  reason: string;
  manuscriptType: ManuscriptType;
  config: NodeExecutionDeps["config"];
  runContextMemory: RunContextMemory;
}): Promise<void> {
  const generatedAt = new Date().toISOString();
  const paperReadiness: PaperReadinessArtifact = {
    generated_at: generatedAt,
    paper_ready: false,
    readiness_state: input.manuscriptType,
    pre_draft_manuscript_type: input.manuscriptType,
    claim_ceiling_applied: input.manuscriptType !== "paper_ready",
    reason: input.reason,
    citation_check: "pass",
    reference_authority_gate: missingReferenceAuthorityGate(),
    triggered_by: ["write_paper_eligibility"],
    evidence_gate_status: "fail",
    scientific_validation_status: "fail",
    submission_validation_ok: false,
    manuscript_quality_action: "stop",
    claim_status_counts: {
      verified: 0,
      inferred: 0,
      unverified: 0,
      blocked: 1
    }
  };
  const risks = buildReadinessRiskArtifact({
    paperReady: false,
    readinessState: input.manuscriptType,
    risks: [
      ...buildNetworkDependencyReadinessRisks({
        source: "paper",
        networkPolicy: input.config.experiments?.network_policy,
        networkPurpose: input.config.experiments?.network_purpose,
        executionApprovalMode: input.config.workflow?.execution_approval_mode
      }),
      {
        risk_code: "write_paper_eligibility_blocked",
        severity: "blocked",
        category: "paper_scale",
        status: "blocked",
        message: input.reason,
        triggered_by: ["write_paper_eligibility"],
        affected_claim_ids: [],
        affected_citation_ids: [],
        recommended_action: "Follow the review/backtrack recommendation instead of preserving stale paper-ready artifacts.",
        recheck_condition: "write_paper_eligibility.json reports allowed=true after upstream evidence is strengthened."
      }
    ]
  });
  await writeRunArtifact(
    input.run,
    "paper/paper_readiness.json",
    `${JSON.stringify(paperReadiness, null, 2)}\n`
  );
  await writeRunArtifact(
    input.run,
    "paper/readiness_risks.json",
    `${JSON.stringify(risks, null, 2)}\n`
  );
  const publicPaperDir = buildPublicPaperDir(process.cwd(), input.run);
  await ensureDir(publicPaperDir);
  await fs.writeFile(
    path.join(publicPaperDir, "paper_readiness.json"),
    `${JSON.stringify(paperReadiness, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    path.join(publicPaperDir, "readiness_risks.json"),
    `${JSON.stringify(risks, null, 2)}\n`,
    "utf8"
  );
  await input.runContextMemory.put("write_paper.paper_readiness", paperReadiness);
  await input.runContextMemory.put("write_paper.readiness_risks", risks);
}

function mergeBundleCorpus(existing: PaperWritingBundle["corpus"], additions: PaperWritingBundle["corpus"]): PaperWritingBundle["corpus"] {
  const seen = new Set(existing.map((item) => item.paper_id));
  const merged = [...existing];
  for (const row of additions) {
    if (!row.paper_id || seen.has(row.paper_id)) {
      continue;
    }
    seen.add(row.paper_id);
    merged.push(row);
  }
  return merged;
}

function mergeBundlePaperSummaries(
  existing: PaperWritingBundle["paperSummaries"],
  additions: PaperWritingBundle["paperSummaries"]
): PaperWritingBundle["paperSummaries"] {
  const merged = new Map(existing.map((item) => [item.paper_id, item] as const));
  for (const row of additions) {
    if (!row.paper_id) {
      continue;
    }
    merged.set(row.paper_id, row);
  }
  return [...merged.values()];
}

function mergeBundleEvidenceRows(
  existing: PaperWritingBundle["evidenceRows"],
  additions: PaperWritingBundle["evidenceRows"]
): PaperWritingBundle["evidenceRows"] {
  const merged = new Map(
    existing.map((item) => [`${item.paper_id}:${item.evidence_id}`, item] as const)
  );
  for (const row of additions) {
    if (!row.paper_id || !row.evidence_id) {
      continue;
    }
    merged.set(`${row.paper_id}:${row.evidence_id}`, row);
  }
  return [...merged.values()];
}

export function resolveWritePaperResultsContract(
  reportValue: unknown
): WritePaperResultsContractResolution {
  if (!isWritePaperRecord(reportValue)) {
    return {
      ok: false,
      issues: ["AnalysisReport must be an object."]
    };
  }
  if (!Object.prototype.hasOwnProperty.call(reportValue, "results_artifact")) {
    return {
      ok: false,
      issues: [
        "AnalysisReport.results_artifact must be supplied explicitly for quantitative paper claims."
      ]
    };
  }

  const validation = validateResultsArtifactV2(reportValue.results_artifact);
  if (!validation.valid) {
    return {
      ok: false,
      issues: validation.issues
    };
  }

  const artifact = reportValue.results_artifact as ResultsArtifactV2;
  const issues: string[] = [];
  if (artifact.comparisons.length === 0) {
    issues.push("AnalysisReport.results_artifact must include at least one explicit comparison.");
  }
  const comparisonById = new Map(
    artifact.comparisons.map((comparison) => [comparison.id, comparison] as const)
  );
  const primarySelection = validateResultsPrimaryComparisonSelectionV2({
    comparisonIds: [...comparisonById.keys()],
    comparisonCount: artifact.comparisons.length,
    primaryComparisonId: reportValue.primary_comparison_id,
    primaryPath: "AnalysisReport.primary_comparison_id",
    comparisonsPath: "results_artifact.comparisons"
  });
  issues.push(...primarySelection.issues);
  const primaryComparisonId = primarySelection.valid
    && typeof reportValue.primary_comparison_id === "string"
    ? reportValue.primary_comparison_id
    : "";

  const metricById = new Map(artifact.metrics.map((metric) => [metric.id, metric] as const));
  const seriesById = new Map(artifact.series.map((series) => [series.id, series] as const));
  const observationById = new Map(
    artifact.observations.map((observation) => [observation.id, observation] as const)
  );
  let primary: WritePaperPrimaryComparison | undefined;

  for (const [index, comparison] of artifact.comparisons.entries()) {
    const pathPrefix = `AnalysisReport.results_artifact.comparisons[${index}]`;
    const comparisonIssues: string[] = [];
    const subjectObservation = observationById.get(comparison.subject_observation_id);
    const referenceObservation = observationById.get(comparison.reference_observation_id);
    if (!subjectObservation || !referenceObservation) {
      comparisonIssues.push(`${pathPrefix} does not resolve to both linked observations.`);
    }
    if (
      subjectObservation
      && referenceObservation
      && subjectObservation.id === referenceObservation.id
    ) {
      comparisonIssues.push(`${pathPrefix} must link distinct subject and reference observations.`);
    }

    const metric = subjectObservation ? metricById.get(subjectObservation.metric_id) : undefined;
    const unit = metric?.unit?.trim();
    if (!metric) {
      comparisonIssues.push(`${pathPrefix} does not resolve to an explicit metric definition.`);
    } else if (!unit) {
      comparisonIssues.push(
        `${pathPrefix} metric "${metric.id}" must declare a non-empty unit for paper use.`
      );
    }

    const subjectSeries = subjectObservation
      ? seriesById.get(subjectObservation.series_id)
      : undefined;
    const referenceSeries = referenceObservation
      ? seriesById.get(referenceObservation.series_id)
      : undefined;
    if (!subjectSeries?.role) {
      comparisonIssues.push(`${pathPrefix} subject series must declare an explicit role.`);
    }
    if (!referenceSeries?.role) {
      comparisonIssues.push(`${pathPrefix} reference series must declare an explicit role.`);
    }
    if (subjectSeries && referenceSeries && subjectSeries.id === referenceSeries.id) {
      comparisonIssues.push(`${pathPrefix} must link observations from distinct series.`);
    }
    if (
      subjectObservation
      && referenceObservation
      && stableWritePaperScopeSignature(subjectObservation.scope)
        !== stableWritePaperScopeSignature(referenceObservation.scope)
    ) {
      comparisonIssues.push(
        `${pathPrefix} subject and reference observations must declare the same scope.`
      );
    }

    issues.push(...comparisonIssues);
    if (
      comparison.id === primaryComparisonId
      && comparisonIssues.length === 0
      && metric
      && unit
      && subjectObservation
      && referenceObservation
      && subjectSeries?.role
      && referenceSeries?.role
    ) {
      primary = {
        comparison: { ...comparison },
        metric: { ...metric, unit },
        subjectObservation: cloneWritePaperObservation(subjectObservation),
        referenceObservation: cloneWritePaperObservation(referenceObservation),
        subjectSeries: cloneWritePaperSeriesWithRole(subjectSeries, subjectSeries.role),
        referenceSeries: cloneWritePaperSeriesWithRole(referenceSeries, referenceSeries.role)
      };
    }
  }

  if (primaryComparisonId && !primary) {
    issues.push(
      `AnalysisReport primary comparison "${primaryComparisonId}" does not have complete, unambiguous paper semantics.`
    );
  }
  if (issues.length > 0 || !primary) {
    return {
      ok: false,
      issues: uniqueStrings(issues)
    };
  }

  return {
    ok: true,
    contract: {
      artifact,
      primaryComparisonId,
      primary
    },
    issues: []
  };
}

export function buildWritePaperResultsInput(
  contract: WritePaperResultsContract
): Record<string, unknown> {
  const artifact = buildPrimaryWritePaperResultsArtifact(contract);
  const primary = contract.primary;
  return {
    results_artifact: artifact,
    primary_comparison_id: contract.primaryComparisonId,
    metric_definition: { ...primary.metric },
    subject_series: cloneWritePaperSeriesWithRole(
      primary.subjectSeries,
      primary.subjectSeries.role
    ),
    reference_series: cloneWritePaperSeriesWithRole(
      primary.referenceSeries,
      primary.referenceSeries.role
    ),
    subject_observation: cloneWritePaperObservation(primary.subjectObservation),
    reference_observation: cloneWritePaperObservation(primary.referenceObservation),
    comparison: { ...primary.comparison }
  };
}

function parseWritePaperResultAnalysisInput(raw: string): {
  report?: AnalysisReport;
  contract?: WritePaperResultsContract;
  mode?: "validated_v2" | "historical_read_only";
  error?: string;
} {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(raw) as unknown;
  } catch {
    return { error: "the result analysis is not valid JSON" };
  }
  if (!isWritePaperRecord(parsedValue)) {
    return { error: "the result analysis must be a JSON object" };
  }

  if (!Object.prototype.hasOwnProperty.call(parsedValue, "results_artifact")) {
    const report = adaptHistoricalWritePaperResultForReadOnlyContext(raw);
    return report
      ? { report, mode: "historical_read_only" }
      : { error: "the historical result analysis could not be read safely" };
  }

  const resolution = resolveWritePaperResultsContract(parsedValue);
  if (!resolution.ok) {
    return {
      error: `the V2 result contract is invalid: ${resolution.issues.join(" ")}`
    };
  }
  const report = parseResultAnalysis(raw);
  if (!report) {
    return { error: "the V2 result analysis could not be parsed" };
  }
  return {
    report: buildValidatedWritePaperAnalysisProjection(
      parsedValue as unknown as AnalysisReport,
      resolution.contract
    ),
    contract: resolution.contract,
    mode: "validated_v2"
  };
}

export function buildValidatedWritePaperAnalysisProjection(
  report: AnalysisReport,
  contract: WritePaperResultsContract
): AnalysisReport {
  const primaryComparisonId = contract.primaryComparisonId;
  const primaryResultsPlan = buildPrimaryWritePaperResultsPlan(
    report.results_plan,
    primaryComparisonId
  );
  return {
    ...report,
    results_artifact: {
      ...contract.artifact,
      comparisons: contract.artifact.comparisons.filter(
        (comparison) => comparison.id === primaryComparisonId
      )
    },
    ...(primaryResultsPlan ? { results_plan: primaryResultsPlan } : {}),
    primary_comparison_id: primaryComparisonId,
    condition_comparisons: (report.condition_comparisons ?? []).filter(
      (comparison) => comparison.id === primaryComparisonId
    ),
    statistical_summary: {
      ...report.statistical_summary,
      effect_estimates: (report.statistical_summary?.effect_estimates ?? []).filter(
        (effect) => effect.comparison_id === primaryComparisonId
      )
    }
  };
}

function buildPrimaryWritePaperResultsPlan(
  plan: ResultsPlanV2 | undefined,
  primaryComparisonId: string
): ResultsPlanV2 | undefined {
  if (!plan) {
    return undefined;
  }
  return {
    ...plan,
    required_metrics: plan.required_metrics.map((metric) => ({ ...metric })),
    required_series: plan.required_series?.map((series) => ({ ...series })),
    required_comparisons: plan.required_comparisons
      ?.filter((comparison) => comparison.id === primaryComparisonId)
      .map((comparison) => ({
        ...comparison,
        scope: comparison.scope ? { ...comparison.scope } : undefined
      })),
    minimum_comparison_count: 1,
    primary_comparison_id: primaryComparisonId,
    primary_effect_criterion: plan.primary_effect_criterion
      ? {
          ...plan.primary_effect_criterion,
          effect_criterion: { ...plan.primary_effect_criterion.effect_criterion }
        }
      : undefined
  };
}

export function adaptHistoricalWritePaperResultForReadOnlyContext(
  raw: string
): AnalysisReport | undefined {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isWritePaperRecord(parsedValue)) {
    return undefined;
  }
  const source = parsedValue;
  const emptyArtifact: ResultsArtifactV2 = {
    schema_version: "2.0",
    metrics: [],
    series: [],
    observations: [],
    comparisons: []
  };
  const notice =
    "Quantitative comparisons are omitted because the available evidence does not identify an explicit subject-reference comparison with metric direction and units.";
  const objectiveMetric = asWritePaperRecord(source.objective_metric);
  const objectiveEvaluation = asWritePaperRecord(objectiveMetric.evaluation);
  const objectiveProfile = asWritePaperRecord(objectiveMetric.profile);
  const overview = asWritePaperRecord(source.overview);
  const planContext = asWritePaperRecord(source.plan_context);
  const executionSummary = asWritePaperRecord(source.execution_summary);
  const projection: Record<string, unknown> = {
    analysis_version: 1,
    generated_at: typeof source.generated_at === "string" ? source.generated_at : "",
    metrics: {},
    objective_metric: {
      raw: typeof objectiveMetric.raw === "string" ? objectiveMetric.raw : "",
      evaluation: {
        rawObjectiveMetric: typeof objectiveEvaluation.rawObjectiveMetric === "string"
          ? objectiveEvaluation.rawObjectiveMetric
          : "",
        profileSource: objectiveEvaluation.profileSource === "llm"
          ? "llm"
          : "heuristic_fallback",
        preferredMetricKeys: [],
        status: "unknown",
        summary: notice
      },
      profile: {
        source: objectiveProfile.source === "llm" ? "llm" : "heuristic_fallback",
        preferred_metric_keys: [],
        analysis_focus: [],
        paper_emphasis: [],
        assumptions: []
      }
    },
    overview: {
      objective_status: "unknown",
      objective_summary: notice,
      ...(typeof overview.selected_design_title === "string"
        ? { selected_design_title: overview.selected_design_title }
        : {}),
      execution_runs: 0
    },
    plan_context: {
      ...(isWritePaperRecord(planContext.selected_design)
        ? { selected_design: planContext.selected_design }
        : {}),
      shortlisted_designs: Array.isArray(planContext.shortlisted_designs)
        ? planContext.shortlisted_designs
        : [],
      design_notes: Array.isArray(planContext.design_notes) ? planContext.design_notes : [],
      implementation_notes: Array.isArray(planContext.implementation_notes)
        ? planContext.implementation_notes
        : [],
      evaluation_notes: Array.isArray(planContext.evaluation_notes)
        ? planContext.evaluation_notes
        : [],
      assumptions: Array.isArray(planContext.assumptions) ? planContext.assumptions : []
    },
    results_artifact: emptyArtifact,
    metric_table: [],
    condition_comparisons: [],
    execution_summary: {
      observation_count: typeof executionSummary.observation_count === "number"
        ? executionSummary.observation_count
        : 0,
      commands: Array.isArray(executionSummary.commands) ? executionSummary.commands : [],
      sources: Array.isArray(executionSummary.sources) ? executionSummary.sources : [],
      ...(typeof executionSummary.latest_log_file === "string"
        ? { latest_log_file: executionSummary.latest_log_file }
        : {}),
      stderr_excerpts: Array.isArray(executionSummary.stderr_excerpts)
        ? executionSummary.stderr_excerpts
        : []
    },
    primary_findings: [],
    limitations: [notice],
    warnings: [notice],
    paper_claims: [],
    figure_specs: [],
    supplemental_runs: [],
    external_comparisons: [],
    statistical_summary: {
      confidence_intervals: [],
      stability_metrics: [],
      effect_estimates: [],
      notes: []
    },
    failure_taxonomy: []
  };
  return projection as unknown as AnalysisReport;
}

function buildPrimaryWritePaperResultsArtifact(
  contract: WritePaperResultsContract
): ResultsArtifactV2 {
  const primary = contract.primary;
  return {
    schema_version: "2.0",
    metrics: [{ ...primary.metric }],
    series: [
      cloneWritePaperSeriesWithRole(primary.subjectSeries, primary.subjectSeries.role),
      cloneWritePaperSeriesWithRole(primary.referenceSeries, primary.referenceSeries.role)
    ],
    observations: [
      cloneWritePaperObservation(primary.subjectObservation),
      cloneWritePaperObservation(primary.referenceObservation)
    ],
    comparisons: [{ ...primary.comparison }]
  };
}

function cloneWritePaperObservation(observation: ResultsObservationV2): ResultsObservationV2 {
  return {
    ...observation,
    scope: { ...observation.scope },
    ...(observation.evidence_refs
      ? { evidence_refs: [...observation.evidence_refs] }
      : {})
  };
}

function cloneWritePaperSeriesWithRole(
  series: ResultsSeriesV2,
  role: ResultsSeriesRole
): ResultsSeriesV2 & { role: ResultsSeriesRole } {
  return {
    ...series,
    role,
    dimensions: { ...series.dimensions }
  };
}

function stableWritePaperScopeSignature(scope: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(scope).sort(([left], [right]) => left.localeCompare(right)))
  );
}

function isWritePaperRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asWritePaperRecord(value: unknown): Record<string, unknown> {
  return isWritePaperRecord(value) ? value : {};
}

async function loadValidatedPaperBundle(
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"]
): Promise<{
  bundle?: PaperWritingBundle;
  resultsContract?: WritePaperResultsContract;
  resultsInputMode?: "validated_v2" | "historical_read_only";
  report: PaperInputValidationReport;
  error: string;
}> {
  const runRoot = path.join(".autolabos", "runs", run.id);
  const issues: PaperInputValidationIssue[] = [];
  const paperSummariesPath = path.join(runRoot, "paper_summaries.jsonl");
  const evidenceStorePath = path.join(runRoot, "evidence_store.jsonl");
  const hypothesesPath = path.join(runRoot, "hypotheses.jsonl");
  const corpusPath = path.join(runRoot, "corpus.jsonl");
  const experimentPlanPath = path.join(runRoot, "experiment_plan.yaml");
  const resultAnalysisPath = path.join(runRoot, "result_analysis.json");
  const reviewDecisionPath = path.join(runRoot, "review", "decision.json");
  const reviewFindingsPath = path.join(runRoot, "review", "findings.jsonl");

  const [
    paperSummariesRaw,
    evidenceRowsRaw,
    hypothesesRaw,
    corpusRaw,
    experimentPlanRaw,
    resultAnalysisRaw,
    reviewDecisionRaw,
    reviewFindingsRaw
  ] = await Promise.all([
    readRequiredRunArtifact(paperSummariesPath, "paper_summaries.jsonl", issues),
    readRequiredRunArtifact(evidenceStorePath, "evidence_store.jsonl", issues),
    readRequiredRunArtifact(hypothesesPath, "hypotheses.jsonl", issues),
    readRequiredRunArtifact(corpusPath, "corpus.jsonl", issues),
    readRequiredRunArtifact(experimentPlanPath, "experiment_plan.yaml", issues),
    readRequiredRunArtifact(resultAnalysisPath, "result_analysis.json", issues),
    safeRead(reviewDecisionPath),
    safeRead(reviewFindingsPath)
  ]);

  const paperSummaries = paperSummariesRaw ? parsePaperSummaries(paperSummariesRaw) : [];
  if (paperSummariesRaw && paperSummaries.length === 0) {
    issues.push({
      artifact: "paper_summaries.jsonl",
      path: paperSummariesPath,
      reason: "no valid paper summaries were found"
    });
  }

  const evidenceRows = evidenceRowsRaw ? parseEvidenceRows(evidenceRowsRaw) : [];
  if (evidenceRowsRaw && evidenceRows.length === 0) {
    issues.push({
      artifact: "evidence_store.jsonl",
      path: evidenceStorePath,
      reason: "no valid evidence rows were found"
    });
  }

  const hypotheses = hypothesesRaw ? parseHypotheses(hypothesesRaw) : [];
  if (hypothesesRaw && hypotheses.length === 0) {
    issues.push({
      artifact: "hypotheses.jsonl",
      path: hypothesesPath,
      reason: "no valid hypotheses were found"
    });
  }

  const corpus = corpusRaw ? parseCorpusRows(corpusRaw) : [];
  if (corpusRaw && corpus.length === 0) {
    issues.push({
      artifact: "corpus.jsonl",
      path: corpusPath,
      reason: "no valid corpus rows were found"
    });
  }

  const experimentPlan = experimentPlanRaw ? parseExperimentPlan(experimentPlanRaw) : undefined;
  if (experimentPlanRaw && !experimentPlan) {
    issues.push({
      artifact: "experiment_plan.yaml",
      path: experimentPlanPath,
      reason: "the experiment plan could not be parsed"
    });
  }

  const resultInput = resultAnalysisRaw
    ? parseWritePaperResultAnalysisInput(resultAnalysisRaw)
    : undefined;
  const resultAnalysis = resultInput?.report;
  if (resultAnalysisRaw && !resultAnalysis) {
    issues.push({
      artifact: "result_analysis.json",
      path: resultAnalysisPath,
      reason: resultInput?.error || "the result analysis could not be parsed"
    });
  }
  const reviewContext = parseReviewContext(reviewDecisionRaw, reviewFindingsRaw);

  const report: PaperInputValidationReport = {
    ok: issues.length === 0,
    issues
  };

  if (issues.length > 0) {
    const artifactList = [...new Set(issues.map((item) => item.artifact))].join(", ");
    return {
      report,
      error: `write_paper requires valid upstream artifacts before drafting. Missing or invalid inputs: ${artifactList}.`
    };
  }

  return {
    bundle: {
      runTitle: run.title,
      topic: run.topic,
      objectiveMetric: run.objectiveMetric,
      constraints: run.constraints,
      paperSummaries,
      evidenceRows,
      hypotheses,
      corpus,
      experimentPlan,
      resultAnalysis,
      reviewContext
    },
    ...(resultInput?.contract ? { resultsContract: resultInput.contract } : {}),
    ...(resultInput?.mode ? { resultsInputMode: resultInput.mode } : {}),
    report,
    error: ""
  };
}

function parseReviewContext(
  reviewDecisionRaw: string,
  reviewFindingsRaw: string
): PaperWritingBundle["reviewContext"] | undefined {
  if (!reviewDecisionRaw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(reviewDecisionRaw) as {
      outcome?: unknown;
      summary?: unknown;
      required_actions?: unknown;
    };
    if (typeof parsed.outcome !== "string" || typeof parsed.summary !== "string") {
      return undefined;
    }

    const topFindings = reviewFindingsRaw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const finding = JSON.parse(line) as { title?: unknown; detail?: unknown };
          const title = typeof finding.title === "string" ? finding.title.trim() : "";
          const detail = typeof finding.detail === "string" ? finding.detail.trim() : "";
          return title && detail ? `${title}: ${detail}` : title || detail;
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .slice(0, 4);

    return {
      outcome: parsed.outcome,
      summary: parsed.summary,
      requiredActions: Array.isArray(parsed.required_actions)
        ? parsed.required_actions.filter((item): item is string => typeof item === "string").slice(0, 4)
        : [],
      topFindings
    };
  } catch {
    return undefined;
  }
}

function describeValidationRepair(report: PaperDraftValidationRepairReport): string {
  if (!report.attempted) {
    return "";
  }
  if (report.applied) {
    return ` after one automatic validation repair (${report.initial_warning_count} -> ${report.final_warning_count})`;
  }
  if (report.error) {
    return ` after one failed validation repair attempt`;
  }
  return ` after one discarded validation repair attempt`;
}

function shouldAttemptValidationRepair(validation: {
  issues: Array<{ message: string }>;
}): boolean {
  return (
    validation.issues.length >= VALIDATION_REPAIR_WARNING_THRESHOLD &&
    validation.issues.some((issue) => isValidationRepairableIssue(issue.message))
  );
}

function isValidationRepairableIssue(message: string): boolean {
  return /\bborrowed\b/iu.test(message);
}

async function loadObjectiveEvaluation(
  runContextMemory: RunContextMemory,
  runId: string
): Promise<ObjectiveMetricEvaluation | undefined> {
  const cached = await runContextMemory.get<ObjectiveMetricEvaluation>("objective_metric.last_evaluation");
  if (cached) {
    return cached;
  }
  try {
    const raw = await safeRead(`.autolabos/runs/${runId}/objective_evaluation.json`);
    return raw ? (JSON.parse(raw) as ObjectiveMetricEvaluation) : undefined;
  } catch {
    return undefined;
  }
}

async function readRequiredRunArtifact(
  filePath: string,
  artifact: string,
  issues: PaperInputValidationIssue[]
): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) {
      issues.push({
        artifact,
        path: filePath,
        reason: "file is empty"
      });
      return undefined;
    }
    return raw;
  } catch (error) {
    issues.push({
      artifact,
      path: filePath,
      reason: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

async function maybeBuildPaperPdf(input: {
  deps: NodeExecutionDeps;
  sessions: PaperWriterSessionManager;
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"];
  abortSignal?: AbortSignal;
  emitLog: (text: string) => void;
  publicPaperDir: string;
  parsedTemplate?: ParsedLatexTemplate | null;
}): Promise<PaperCompileResult> {
  const buildPdf = input.deps.config?.paper?.build_pdf === true;
  if (!buildPdf) {
    return {
      enabled: false,
      status: "skipped",
      repaired: false,
      toolCallsUsed: 0,
      attempts: [],
      warnings: []
    };
  }

  const runPaperDir = path.join(".autolabos", "runs", input.run.id, "paper");
  const compileWarnings: string[] = [];
  const attempts: PaperCompileAttempt[] = [];
  let toolCallsUsed = 0;
  let repaired = false;
  let repairError: string | undefined;

  input.emitLog("PDF build is enabled; starting LaTeX compilation.");
  await copyLatexTemplateDependencies({
    parsedTemplate: input.parsedTemplate,
    runPaperDir,
    publicPaperDir: input.publicPaperDir,
    emitLog: input.emitLog
  });

  const firstAttempt = await runLatexCompileAttempt({
    deps: input.deps,
    runId: input.run.id,
    paperDir: runPaperDir,
    attempt: 1,
    repaired: false,
    abortSignal: input.abortSignal,
    emitLog: input.emitLog
  });
  attempts.push(firstAttempt.attempt);
  compileWarnings.push(...firstAttempt.attempt.warnings);
  toolCallsUsed += firstAttempt.toolCallsUsed;

  let finalAttempt = firstAttempt.attempt;
  if (firstAttempt.ok) {
    await finalizeCompiledArtifacts(runPaperDir, input.publicPaperDir, finalAttempt);
    const pdfPath = path.join(runPaperDir, "main.pdf");
    const buildLogPath = path.join(runPaperDir, "build.log");
    const report: PaperCompileResult = {
      enabled: true,
      status: "success",
      repaired: false,
      toolCallsUsed,
      attempts,
      warnings: compileWarnings,
      pdf_path: pdfPath,
      build_log_path: buildLogPath
    };
    await writeRunArtifact(input.run, "paper/compile_report.json", `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  if (!firstAttempt.repairable) {
    input.emitLog(`LaTeX compilation failed without repair attempt: ${firstAttempt.attempt.error || "unknown error"}`);
    const pdfPath = path.join(runPaperDir, "main.pdf");
    const pdfExists = await fileExists(pdfPath);
    const report: PaperCompileResult = {
      enabled: true,
      status: "failed",
      repaired: false,
      toolCallsUsed,
      attempts,
      warnings: compileWarnings,
      build_log_path: path.join(runPaperDir, "build.log"),
      ...(pdfExists ? { pdf_path: pdfPath } : {})
    };
    await writeRunArtifact(input.run, "paper/compile_report.json", `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const texPath = path.join(runPaperDir, "main.tex");
  const currentTex = await safeRead(texPath);
  const buildLog = await safeRead(firstAttempt.attempt.build_log_path);
  const repair = await input.sessions.repairLatex({
    run: input.run,
    tex: currentTex,
    buildLog,
    abortSignal: input.abortSignal
  });
  if (repair.tex) {
    const templatePreservation = checkFinalTexPreservesTemplate(repair.tex, input.parsedTemplate || null);
    if (!templatePreservation.ok) {
      repairError =
        `latex repair would remove requested template surface: ${templatePreservation.missing.join(", ")}`;
      compileWarnings.push(repairError);
      input.emitLog(`Automatic LaTeX repair rejected: ${repairError}`);
    } else {
      repaired = true;
      await fs.writeFile(texPath, repair.tex, "utf8");
      await fs.writeFile(path.join(input.publicPaperDir, "main.tex"), repair.tex, "utf8");
      input.emitLog("Applied one automatic LaTeX repair pass and retrying PDF compilation.");
      const secondAttempt = await runLatexCompileAttempt({
        deps: input.deps,
        runId: input.run.id,
        paperDir: runPaperDir,
        attempt: 2,
        repaired: true,
        abortSignal: input.abortSignal,
        emitLog: input.emitLog
      });
      attempts.push(secondAttempt.attempt);
      compileWarnings.push(...secondAttempt.attempt.warnings);
      toolCallsUsed += secondAttempt.toolCallsUsed;
      finalAttempt = secondAttempt.attempt;
      if (secondAttempt.ok) {
        await finalizeCompiledArtifacts(runPaperDir, input.publicPaperDir, finalAttempt);
        const pdfPath = path.join(runPaperDir, "main.pdf");
        const buildLogPath = path.join(runPaperDir, "build.log");
        const report: PaperCompileResult = {
          enabled: true,
          status: "repaired_success",
          repaired: true,
          toolCallsUsed,
          attempts,
          warnings: compileWarnings,
          pdf_path: pdfPath,
          build_log_path: buildLogPath
        };
        await writeRunArtifact(input.run, "paper/compile_report.json", `${JSON.stringify(report, null, 2)}\n`);
        return report;
      }
      repairError = secondAttempt.attempt.error;
    }
  } else {
    repairError = repair.error || "latex repair produced no replacement source";
    input.emitLog(`Automatic LaTeX repair failed: ${repairError}`);
  }

  const failedPdfPath = path.join(runPaperDir, "main.pdf");
  const failedPdfExists = await fileExists(failedPdfPath);
  const report: PaperCompileResult = {
    enabled: true,
    status: "failed",
    repaired,
    toolCallsUsed,
    attempts,
    warnings: compileWarnings,
    build_log_path: path.join(runPaperDir, "build.log"),
    ...(failedPdfExists ? { pdf_path: failedPdfPath } : {}),
    repair_error: repairError
  };
  await writeRunArtifact(input.run, "paper/compile_report.json", `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function runLatexCompileAttempt(input: {
  deps: NodeExecutionDeps;
  runId: string;
  paperDir: string;
  attempt: number;
  repaired: boolean;
  abortSignal?: AbortSignal;
  emitLog: (text: string) => void;
}): Promise<{ ok: boolean; repairable: boolean; toolCallsUsed: number; attempt: PaperCompileAttempt }> {
  const commands = [
    { step: "pdflatex-pass-1", command: "pdflatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex" },
    { step: "bibtex", command: "bibtex main", optional: true },
    { step: "pdflatex-pass-2", command: "pdflatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex" },
    { step: "pdflatex-pass-3", command: "pdflatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex" }
  ];

  const results: PaperCompileCommandResult[] = [];
  const warnings: string[] = [];
  const logChunks: string[] = [];
  let repairable = true;

  for (const item of commands) {
    input.deps.eventStream.emit({
      type: "TOOL_CALLED",
      runId: input.runId,
      node: "write_paper",
      payload: {
        command: item.command,
        cwd: input.paperDir,
        source: "paper_pdf_build"
      }
    });
    const obs = await input.deps.aci.runCommand(item.command, input.paperDir, input.abortSignal);
    const result: PaperCompileCommandResult = {
      step: item.step,
      command: item.command,
      status: obs.status,
      exit_code: obs.exit_code,
      duration_ms: obs.duration_ms,
      optional: item.optional,
      stdout: obs.stdout,
      stderr: obs.stderr
    };
    results.push(result);
    logChunks.push(`$ ${item.command}`, obs.stdout || "", obs.stderr || "", "");

    if (obs.status !== "ok") {
      if (item.optional) {
        warnings.push(
          `${item.step} failed but is optional: ${(obs.stderr || obs.stdout || "").trim() || "optional command failed"}`
        );
        input.emitLog(`Optional LaTeX step "${item.step}" failed; continuing with warnings.`);
        continue;
      }
      input.deps.eventStream.emit({
        type: "TEST_FAILED",
        runId: input.runId,
        node: "write_paper",
        payload: {
          command: item.command,
          stderr: obs.stderr || `${item.step} failed`
        }
      });
      if (isMissingBinaryObservation(obs) || isPolicyBlockedObservation(obs)) {
        repairable = false;
      }
      const buildLogPath = path.join(input.paperDir, `build.attempt_${input.attempt}.log`);
      await fs.writeFile(buildLogPath, logChunks.join("\n"), "utf8");
      await fs.writeFile(path.join(input.paperDir, "build.log"), logChunks.join("\n"), "utf8");
      return {
        ok: false,
        repairable,
        toolCallsUsed: results.length,
        attempt: {
          attempt: input.attempt,
          repaired: input.repaired,
          status: "failed",
          commands: results,
          warnings,
          error: obs.stderr || `${item.step} failed`,
          build_log_path: buildLogPath,
          pdf_exists: await fileExists(path.join(input.paperDir, "main.pdf"))
        }
      };
    }
  }

  const buildLogPath = path.join(input.paperDir, `build.attempt_${input.attempt}.log`);
  await fs.writeFile(buildLogPath, logChunks.join("\n"), "utf8");
  await fs.writeFile(path.join(input.paperDir, "build.log"), logChunks.join("\n"), "utf8");
  const pdfExists = await fileExists(path.join(input.paperDir, "main.pdf"));
  if (!pdfExists) {
    return {
      ok: false,
      repairable: true,
      toolCallsUsed: results.length,
      attempt: {
        attempt: input.attempt,
        repaired: input.repaired,
        status: "failed",
        commands: results,
        warnings,
        error: "pdflatex sequence completed without producing main.pdf",
        build_log_path: buildLogPath,
        pdf_exists: false
      }
    };
  }

  return {
    ok: true,
    repairable: true,
    toolCallsUsed: results.length,
    attempt: {
      attempt: input.attempt,
      repaired: input.repaired,
      status: "success",
      commands: results,
      warnings,
      build_log_path: buildLogPath,
      pdf_exists: true
    }
  };
}

async function copyLatexTemplateDependencies(input: {
  parsedTemplate?: ParsedLatexTemplate | null;
  runPaperDir: string;
  publicPaperDir: string;
  emitLog: (text: string) => void;
}): Promise<void> {
  const sourcePath = input.parsedTemplate?.sourcePath;
  if (!sourcePath) {
    return;
  }
  const templateDir = path.dirname(sourcePath);
  const packageNames = new Set<string>();
  for (const packageLine of input.parsedTemplate?.packages || []) {
    for (const match of packageLine.matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
      for (const name of match[1].split(",")) {
        const trimmed = name.trim();
        if (trimmed) {
          packageNames.add(trimmed);
        }
      }
    }
  }

  const copied = new Set<string>();
  const copyCandidate = async (candidate: string): Promise<void> => {
    if (!(await fileExists(candidate))) {
      return;
    }
    const basename = path.basename(candidate);
    if (copied.has(basename)) {
      return;
    }
    await fs.copyFile(candidate, path.join(input.runPaperDir, basename));
    await fs.copyFile(candidate, path.join(input.publicPaperDir, basename));
    copied.add(basename);
  };

  for (const name of packageNames) {
    await copyCandidate(path.join(templateDir, `${name}.sty`));
  }

  let siblings: string[] = [];
  try {
    siblings = await fs.readdir(templateDir);
  } catch {
    siblings = [];
  }
  for (const sibling of siblings) {
    if (!/\.(?:sty|bst|cls|bbx|cbx|def|cfg)$/iu.test(sibling)) {
      continue;
    }
    const lower = sibling.toLowerCase();
    const matchesPackage =
      packageNames.size === 0 ||
      Array.from(packageNames).some((name) => lower === `${name.toLowerCase()}.sty`);
    if (matchesPackage || /\.(?:bst|cls)$/iu.test(sibling)) {
      await copyCandidate(path.join(templateDir, sibling));
    }
  }

  if (copied.size > 0) {
    input.emitLog(`Copied ${copied.size} LaTeX template dependency file(s) into the paper build directory.`);
  }
}

async function finalizeCompiledArtifacts(
  runPaperDir: string,
  publicPaperDir: string,
  attempt: PaperCompileAttempt
): Promise<void> {
  const pdfPath = path.join(runPaperDir, "main.pdf");
  const publicPdfPath = path.join(publicPaperDir, "main.pdf");
  const buildLogSource = attempt.build_log_path;
  const publicBuildLogPath = path.join(publicPaperDir, "build.log");
  if (await fileExists(pdfPath)) {
    await fs.copyFile(pdfPath, publicPdfPath);
  }
  if (await fileExists(buildLogSource)) {
    await fs.copyFile(buildLogSource, path.join(runPaperDir, "build.log"));
    await fs.copyFile(buildLogSource, publicBuildLogPath);
  }
}

function describeCompileStatus(result: PaperCompileResult): string {
  switch (result.status) {
    case "success":
      return "built successfully";
    case "repaired_success":
      return "built successfully after one automatic repair";
    case "failed":
      return "build failed";
    default:
      return "build skipped";
  }
}

function describeScientificGateStatus(result: {
  status: "pass" | "warn" | "fail";
  blocking_issue_count: number;
  warning_count: number;
}): string {
  if (result.status === "pass") {
    return "pass";
  }
  if (result.status === "fail") {
    return `fail (${result.blocking_issue_count} blocking issue${result.blocking_issue_count === 1 ? "" : "s"})`;
  }
  return `warn (${result.warning_count} issue${result.warning_count === 1 ? "" : "s"})`;
}

function sanitizeReaderFacingRepairTargets(
  manuscriptBeforeRepair: PaperManuscript,
  repairedManuscript: PaperManuscript,
  repairPlan: ManuscriptRepairPlanArtifact
): PaperManuscript {
  const allowedLocationKeys = buildAllowedRepairLocationKeySet(repairPlan);
  const selectIfAllowed = (locationKey: string, beforeText: string, repairedText: string | undefined): string =>
    allowedLocationKeys.has(locationKey)
      ? sanitizePaperNarrativeText(repairedText ?? beforeText)
      : beforeText;
  const sanitizeVisualRows = (
    beforeRows: PaperManuscriptVisualRow[],
    repairedRows: PaperManuscriptVisualRow[] | undefined
  ): PaperManuscriptVisualRow[] => {
    if (!Array.isArray(repairedRows) || repairedRows.length === 0) {
      return beforeRows;
    }
    return repairedRows
      .filter((row) => Number.isFinite(row.value))
      .map((row) => ({
        label: sanitizePaperNarrativeText(row.label),
        value: row.value
      }));
  };
  const merged: PaperManuscript = {
    ...manuscriptBeforeRepair,
    title: selectIfAllowed("title", manuscriptBeforeRepair.title, repairedManuscript.title),
    abstract: selectIfAllowed("abstract", manuscriptBeforeRepair.abstract, repairedManuscript.abstract),
    sections: manuscriptBeforeRepair.sections.map((section, sectionIndex) => ({
      ...section,
      paragraphs: section.paragraphs.map((paragraph, paragraphIndex) =>
        selectIfAllowed(
          buildMainParagraphLocationKey(section.heading, paragraphIndex),
          paragraph,
          repairedManuscript.sections[sectionIndex]?.paragraphs[paragraphIndex]
        )
      )
    })),
    ...(manuscriptBeforeRepair.appendix_sections
      ? {
          appendix_sections: manuscriptBeforeRepair.appendix_sections.map((section, sectionIndex) => ({
            ...section,
            paragraphs: section.paragraphs.map((paragraph, paragraphIndex) =>
              selectIfAllowed(
                buildAppendixParagraphLocationKey(section.heading, paragraphIndex),
                paragraph,
                repairedManuscript.appendix_sections?.[sectionIndex]?.paragraphs[paragraphIndex]
              )
            )
          }))
        }
      : {}),
    ...(manuscriptBeforeRepair.tables
      ? {
          tables: manuscriptBeforeRepair.tables.map((table, index) => ({
            ...table,
            caption: isDerivedMainTable(table)
              ? table.caption
              : selectIfAllowed(`table:${index}`, table.caption, repairedManuscript.tables?.[index]?.caption),
            rows: allowedLocationKeys.has(`table:${index}`) && !isDerivedMainTable(table)
              ? sanitizeVisualRows(table.rows, repairedManuscript.tables?.[index]?.rows)
              : table.rows
          }))
        }
      : {}),
    ...(manuscriptBeforeRepair.figures
      ? {
          figures: manuscriptBeforeRepair.figures.map((figure, index) => ({
            ...figure,
            caption: isDerivedMainFigure(figure)
              ? figure.caption
              : selectIfAllowed(`figure:${index}`, figure.caption, repairedManuscript.figures?.[index]?.caption),
            bars: allowedLocationKeys.has(`figure:${index}`) && !isDerivedMainFigure(figure)
              ? sanitizeVisualRows(figure.bars, repairedManuscript.figures?.[index]?.bars)
              : figure.bars
          }))
        }
      : {}),
    ...(manuscriptBeforeRepair.appendix_tables
      ? {
          appendix_tables: manuscriptBeforeRepair.appendix_tables.map((table, index) => ({
            ...table,
            caption: selectIfAllowed(
              `appendix_table:${index}`,
              table.caption,
              repairedManuscript.appendix_tables?.[index]?.caption
            ),
            rows: allowedLocationKeys.has(`appendix_table:${index}`)
              ? sanitizeVisualRows(table.rows, repairedManuscript.appendix_tables?.[index]?.rows)
              : table.rows
          }))
        }
      : {}),
    ...(manuscriptBeforeRepair.appendix_figures
      ? {
          appendix_figures: manuscriptBeforeRepair.appendix_figures.map((figure, index) => ({
            ...figure,
            caption: selectIfAllowed(
              `appendix_figure:${index}`,
              figure.caption,
              repairedManuscript.appendix_figures?.[index]?.caption
            ),
            bars: allowedLocationKeys.has(`appendix_figure:${index}`)
              ? sanitizeVisualRows(figure.bars, repairedManuscript.appendix_figures?.[index]?.bars)
              : figure.bars
          }))
        }
      : {})
  };
  return compactReaderFacingRepairedManuscript(merged);
}

function hasArtifactSourceRef(
  item: { source_refs?: Array<{ kind: string; id: string }> },
  sourceRefId: string
): boolean {
  return Boolean(item.source_refs?.some((ref) => ref.kind === "artifact" && ref.id === sourceRefId));
}

function isDerivedMainTable(table: { source_refs?: Array<{ kind: string; id: string }> }): boolean {
  return hasArtifactSourceRef(table, DERIVED_MAIN_TABLE_SOURCE_REF_ID);
}

function isDerivedMainFigure(figure: { source_refs?: Array<{ kind: string; id: string }> }): boolean {
  return hasArtifactSourceRef(figure, DERIVED_MAIN_FIGURE_SOURCE_REF_ID);
}

function normalizeManuscriptForRepairLocalityComparison(
  manuscript: PaperManuscript,
  options: PaperManuscriptStabilizationOptions = {}
): PaperManuscript {
  return stabilizePaperManuscriptForSubmission(compactReaderFacingRepairedManuscript(manuscript), options);
}

function buildAllowedRepairLocationKeySet(repairPlan: ManuscriptRepairPlanArtifact): Set<string> {
  return new Set(
    repairPlan.targets.flatMap((target) =>
      target.allowed_location_keys.length > 0 ? target.allowed_location_keys : [target.location_key]
    )
  );
}

function findPaperManuscriptSectionByHeading(
  sections: PaperManuscriptSection[] | undefined,
  heading: string,
  fallbackIndex: number
): PaperManuscriptSection | undefined {
  if (!sections || sections.length === 0) {
    return undefined;
  }
  const headingKey = normalizeLocationKeyFragment(heading);
  return sections.find((section) => normalizeLocationKeyFragment(section.heading) === headingKey) || sections[fallbackIndex];
}

function enforceRepairPlanLocalityAfterStabilization(
  reference: PaperManuscript,
  candidate: PaperManuscript,
  repairPlan: ManuscriptRepairPlanArtifact
): PaperManuscript {
  const allowedLocationKeys = buildAllowedRepairLocationKeySet(repairPlan);
  const selectText = (locationKey: string, beforeText: string, candidateText: string | undefined): string =>
    allowedLocationKeys.has(locationKey) ? candidateText || beforeText : beforeText;
  const mergeRows = (
    locationKey: string,
    beforeRows: PaperManuscriptVisualRow[] | undefined,
    candidateRows: PaperManuscriptVisualRow[] | undefined
  ): PaperManuscriptVisualRow[] | undefined => (allowedLocationKeys.has(locationKey) ? candidateRows || beforeRows : beforeRows);

  return {
    ...candidate,
    title: selectText("title", reference.title, candidate.title),
    abstract: selectText("abstract", reference.abstract, candidate.abstract),
    sections: reference.sections.map((section, sectionIndex) => {
      const candidateSection = findPaperManuscriptSectionByHeading(candidate.sections, section.heading, sectionIndex);
      return {
        ...section,
        ...candidateSection,
        heading: section.heading,
        paragraphs: section.paragraphs.map((paragraph, paragraphIndex) =>
          selectText(
            buildMainParagraphLocationKey(section.heading, paragraphIndex),
            paragraph,
            candidateSection?.paragraphs[paragraphIndex]
          )
        )
      };
    }),
    ...(reference.appendix_sections
      ? {
          appendix_sections: reference.appendix_sections.map((section, sectionIndex) => {
            const candidateSection = findPaperManuscriptSectionByHeading(
              candidate.appendix_sections,
              section.heading,
              sectionIndex
            );
            return {
              ...section,
              ...candidateSection,
              heading: section.heading,
              paragraphs: section.paragraphs.map((paragraph, paragraphIndex) =>
                selectText(
                  buildAppendixParagraphLocationKey(section.heading, paragraphIndex),
                  paragraph,
                  candidateSection?.paragraphs[paragraphIndex]
                )
              )
            };
          })
        }
      : { appendix_sections: candidate.appendix_sections }),
    ...(reference.tables
      ? {
          tables: reference.tables.map((table, index) => ({
            ...table,
            ...(isDerivedMainTable(table) ? {} : candidate.tables?.[index]),
            caption: isDerivedMainTable(table)
              ? table.caption
              : selectText(`table:${index}`, table.caption, candidate.tables?.[index]?.caption),
            rows: isDerivedMainTable(table)
              ? table.rows
              : mergeRows(`table:${index}`, table.rows, candidate.tables?.[index]?.rows) || table.rows
          }))
        }
      : { tables: candidate.tables }),
    ...(reference.figures
      ? {
          figures: reference.figures.map((figure, index) => ({
            ...figure,
            ...(isDerivedMainFigure(figure) ? {} : candidate.figures?.[index]),
            caption: isDerivedMainFigure(figure)
              ? figure.caption
              : selectText(`figure:${index}`, figure.caption, candidate.figures?.[index]?.caption),
            bars: isDerivedMainFigure(figure)
              ? figure.bars
              : mergeRows(`figure:${index}`, figure.bars, candidate.figures?.[index]?.bars) || figure.bars
          }))
        }
      : { figures: candidate.figures }),
    ...(reference.appendix_tables
      ? {
          appendix_tables: reference.appendix_tables.map((table, index) => ({
            ...table,
            ...candidate.appendix_tables?.[index],
            caption: selectText(
              `appendix_table:${index}`,
              table.caption,
              candidate.appendix_tables?.[index]?.caption
            ),
            rows: mergeRows(`appendix_table:${index}`, table.rows, candidate.appendix_tables?.[index]?.rows) || table.rows
          }))
        }
      : { appendix_tables: candidate.appendix_tables }),
    ...(reference.appendix_figures
      ? {
          appendix_figures: reference.appendix_figures.map((figure, index) => ({
            ...figure,
            ...candidate.appendix_figures?.[index],
            caption: selectText(
              `appendix_figure:${index}`,
              figure.caption,
              candidate.appendix_figures?.[index]?.caption
            ),
            bars:
              mergeRows(`appendix_figure:${index}`, figure.bars, candidate.appendix_figures?.[index]?.bars) ||
              figure.bars
          }))
        }
      : { appendix_figures: candidate.appendix_figures })
  };
}

function restoreDerivedMainVisualsFromReference(
  candidate: PaperManuscript,
  reference: PaperManuscript
): PaperManuscript {
  const referenceTables = reference.tables || [];
  const referenceFigures = reference.figures || [];
  return {
    ...candidate,
    ...(candidate.tables
      ? {
          tables: candidate.tables.map((table, index) => {
            const referenceTable = referenceTables[index];
            return shouldRestoreDerivedMainTable(table, referenceTable) ? referenceTable || table : table;
          })
        }
      : {}),
    ...(candidate.figures
      ? {
          figures: candidate.figures.map((figure, index) => {
            const referenceFigure = referenceFigures[index];
            return shouldRestoreDerivedMainFigure(figure, referenceFigure) ? referenceFigure || figure : figure;
          })
        }
      : {})
  };
}

function shouldRestoreDerivedMainTable(
  candidate: { rows?: PaperManuscriptVisualRow[]; source_refs?: Array<{ kind: string; id: string }> } | undefined,
  reference: { rows?: PaperManuscriptVisualRow[]; source_refs?: Array<{ kind: string; id: string }> } | undefined
): boolean {
  if (!reference || !isDerivedMainTable(reference)) {
    return false;
  }
  if (
    candidate
    && isDerivedMainTable(candidate)
    && hasCompleteWritePaperComparisonMetadata(candidate.rows)
    && !hasCompleteWritePaperComparisonMetadata(reference.rows)
  ) {
    return false;
  }
  return true;
}

function shouldRestoreDerivedMainFigure(
  candidate: { bars?: PaperManuscriptVisualRow[]; source_refs?: Array<{ kind: string; id: string }> } | undefined,
  reference: { bars?: PaperManuscriptVisualRow[]; source_refs?: Array<{ kind: string; id: string }> } | undefined
): boolean {
  if (!reference || !isDerivedMainFigure(reference)) {
    return false;
  }
  if (
    candidate
    && isDerivedMainFigure(candidate)
    && hasCompleteWritePaperComparisonMetadata(candidate.bars)
    && !hasCompleteWritePaperComparisonMetadata(reference.bars)
  ) {
    return false;
  }
  return true;
}

function hasCompleteWritePaperComparisonMetadata(
  rows: PaperManuscriptVisualRow[] | undefined
): boolean {
  return Boolean(
    rows?.length
    && rows.every((row) => {
      if (!row.comparison_id || !row.metric_id || !row.comparison_side) {
        return false;
      }
      if (row.comparison_side === "difference") {
        return true;
      }
      return Boolean(row.observation_id && row.series_id && row.series_role);
    })
  );
}

function compactReaderFacingRepairedManuscript(manuscript: PaperManuscript): PaperManuscript {
  const compactTables = compactReaderFacingTables(manuscript.tables);
  return {
    ...manuscript,
    title: sanitizeFinalPaperTitle(manuscript.title),
    abstract: sanitizeFinalPaperAbstract(manuscript.abstract),
    keywords: sanitizeFinalPaperKeywords(manuscript.keywords),
    sections: compactReaderFacingSections(manuscript.sections),
    ...(compactTables ? { tables: compactTables } : {}),
    ...(manuscript.appendix_sections ? { appendix_sections: manuscript.appendix_sections } : {}),
    ...(manuscript.figures
      ? {
          figures: manuscript.figures.map((figure) => ({
            ...figure,
            bars: figure.bars.map(compactWritePaperVisualRow)
          }))
        }
      : {}),
    ...(manuscript.appendix_tables
      ? { appendix_tables: dedupeRepairTables(manuscript.appendix_tables.map(compactAppendixTableLabels)) }
      : {})
  };
}

function compactReaderFacingSections(sections: PaperManuscriptSection[]): PaperManuscriptSection[] {
  return sections.map((section) => {
    const maxParagraphs = maxFinalReaderFacingParagraphs(section.heading);
    const paragraphs = section.paragraphs
      .map((paragraph, index) => sanitizeFinalPaperParagraph(section.heading, sanitizePaperNarrativeText(paragraph), index))
      .filter((paragraph) => !isNonReaderFacingFinalParagraph(section.heading, paragraph));
    return {
      ...section,
      paragraphs: dedupeNarrativeParagraphs(paragraphs).slice(0, maxParagraphs ?? undefined)
    };
  });
}

function maxFinalReaderFacingParagraphs(heading: string): number | null {
  if (/^related work$/iu.test(heading)) return 4;
  if (/^method$/iu.test(heading)) return 7;
  if (/^conclusion$/iu.test(heading)) return 4;
  return null;
}

function compactReaderFacingTables(tables: PaperManuscript["tables"] | undefined): PaperManuscript["tables"] | undefined {
  if (!tables) {
    return undefined;
  }
  return tables.map((table) => ({
    ...table,
    rows: table.rows.map(compactWritePaperVisualRow)
  }));
}

function compactWritePaperVisualRow(row: PaperManuscriptVisualRow): PaperManuscriptVisualRow {
  return {
    label: sanitizeAppendixTableLabel(row.label),
    value: row.value,
    ...(row.comparison_id ? { comparison_id: row.comparison_id } : {}),
    ...(row.observation_id ? { observation_id: row.observation_id } : {}),
    ...(row.metric_id ? { metric_id: row.metric_id } : {}),
    ...(row.series_id ? { series_id: row.series_id } : {}),
    ...(row.series_role ? { series_role: row.series_role } : {}),
    ...(row.comparison_side ? { comparison_side: row.comparison_side } : {})
  };
}

function compactAppendixTableLabels<T extends { rows: PaperManuscriptVisualRow[] }>(table: T): T {
  return {
    ...table,
    rows: table.rows.map(compactWritePaperVisualRow)
  };
}

function sanitizeAppendixTableLabel(label: string): string {
  return sanitizePaperNarrativeText(label).replace(/\s+/gu, " ").trim();
}

function isNonReaderFacingFinalParagraph(heading: string, paragraph: string): boolean {
  if (!paragraph) {
    return true;
  }
  if (/^method$/iu.test(heading)) {
    return (
      /^The protocol records\b/iu.test(paragraph)
      || /^The fixed search space includes\b/iu.test(paragraph)
      || /\bpreserved protocol notes\b/iu.test(paragraph)
      || /\bRepeat each condition across multiple seeded runs\b/iu.test(paragraph)
      || /\brun contract\b/iu.test(paragraph)
      || /\bartifact metadata\b/iu.test(paragraph)
    );
  }
  if (/^conclusion$/iu.test(heading)) {
    return /\bsubmission-ready continuation\b/iu.test(paragraph);
  }
  if (!/^related work$/iu.test(heading)) {
    return false;
  }
  return (
    /^(?:The\s+)?(?:supplied|provided)\s+related\s+work\b/iu.test(paragraph)
    || /\b(?:collection|extraction)\s+(?:timeout|fallback)\s+(?:caveat|artifact)s?\b/iu.test(paragraph)
    || /\bpaper\s+analys(?:is|es)\s+(?:artifact|include)\b/iu.test(paragraph)
  );
}

function sanitizeFinalPaperKeywords(keywords: string[] | undefined): string[] {
  const compact: string[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords || []) {
    const cleaned = sanitizePaperNarrativeText(keyword)
      .replace(/\s+/gu, " ")
      .trim();
    if (!cleaned || cleaned.length > 80 || /[.!?]/u.test(cleaned)) {
      continue;
    }
    const key = cleaned.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    compact.push(cleaned);
    if (compact.length >= 6) {
      break;
    }
  }
  return compact;
}

function sanitizeFinalPaperAbstract(abstract: string): string {
  const cleaned = sanitizePaperNarrativeText(abstract);
  return isReaderHostileFinalPaperParagraph(cleaned)
    ? "This study reports an evidence-bounded experiment with an explicit comparison, evaluation scope, and limitations."
    : cleaned;
}

function sanitizeFinalPaperTitle(title: string): string {
  const cleaned = sanitizePaperNarrativeText(title);
  if (!cleaned || cleaned.length > 110 || /\b(?:workflow|audit|paper[- ]?readiness|result[- ]?gating)\b/iu.test(cleaned)) {
    return "A Governed Experimental Study Under a Fixed Resource Budget";
  }
  return cleaned;
}

function sanitizeFinalPaperParagraph(_heading: string, paragraph: string, _index: number): string {
  const cleaned = sanitizePaperNarrativeText(paragraph)
    .replace(/\b(?:final|full|public)\s+paper\s+should\s+(?:include|cite|expose|report|add|provide)\b[^.]*\.?/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return isReaderHostileFinalPaperParagraph(cleaned) ? "" : cleaned;
}

function isReaderHostileFinalPaperParagraph(paragraph: string): boolean {
  return (
    /\b(?:reader-facing prose|submission quality|local cleanup pass|final checklist before submission|workflow intervention|paper-readiness audit|review gating)\b/iu.test(paragraph)
    || /\b(?:citation\s+to[- ]?do|needs\s+final\s+citation|bibliography\s+is\s+not\s+final)\b/iu.test(paragraph)
    || /\b(?:the current workflow|the draft integrates|according to the prompt|this document)\b/iu.test(paragraph)
  );
}

function dedupeNarrativeParagraphs(paragraphs: string[]): string[] {
  const compact: string[] = [];
  const seen = new Set<string>();
  for (const paragraph of paragraphs) {
    const cleaned = sanitizePaperNarrativeText(paragraph);
    if (!cleaned) {
      continue;
    }
    const key = normalizeRepairTextKey(cleaned);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    compact.push(cleaned);
  }
  return compact;
}

function dedupeRepairTables<T extends { caption: string; rows: PaperManuscriptVisualRow[] }>(tables: T[]): T[] {
  const compact: T[] = [];
  const seen = new Set<string>();
  for (const table of tables) {
    const key = [
      normalizeRepairTextKey(table.caption),
      ...table.rows.map((row) => `${normalizeRepairTextKey(row.label)}=${row.value}`)
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    compact.push(table);
  }
  return compact;
}

function hasAmbiguousFigureMetricSemantics(
  figure: { bars: PaperManuscriptVisualRow[] }
): boolean {
  if (figure.bars.length === 0) {
    return true;
  }
  const metricIds = new Set(
    figure.bars.map((row) => row.metric_id).filter((id): id is string => Boolean(id))
  );
  return metricIds.size !== 1 || !hasCompleteWritePaperComparisonMetadata(figure.bars);
}

function normalizeRepairTextKey(value: string): string {
  return sanitizePaperNarrativeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function buildMainParagraphLocationKey(heading: string, paragraphIndex: number): string {
  return `paragraph:${normalizeLocationKeyFragment(heading)}:${paragraphIndex}`;
}

function buildAppendixParagraphLocationKey(heading: string, paragraphIndex: number): string {
  return `appendix_paragraph:${normalizeLocationKeyFragment(heading)}:${paragraphIndex}`;
}

function normalizeLocationKeyFragment(value: string): string {
  return value.replace(/\s+/gu, "_").toLowerCase();
}

async function runManuscriptQualityLoop(input: {
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"];
  sessions: PaperWriterSessionManager;
  bundle: PaperWritingBundle;
  draft: Parameters<typeof buildPaperTraceability>[0]["draft"];
  initialManuscript: PaperManuscript;
  constraintProfile: ConstraintProfile;
  paperProfile: PaperProfileConfig;
  objectiveMetricProfile: Awaited<ReturnType<typeof resolveObjectiveMetricProfile>>;
  objectiveEvaluation?: ObjectiveMetricEvaluation;
  scientificValidationArtifact: ReturnType<typeof buildScientificValidationArtifact>;
  appendixPlan: Parameters<typeof materializeScientificManuscript>[0]["appendixPlan"];
  pageBudget: Parameters<typeof materializeScientificManuscript>[0]["pageBudget"];
  validationMode: "default" | "strict_paper";
  citationKeysByPaperId: Map<string, string>;
  unresolvedCitationPaperIds: string[];
  template?: string;
  parsedTemplate?: ParsedLatexTemplate | null;
  authorMetadata?: PaperAuthorMetadata | null;
  emitLog: (text: string) => void;
  abortSignal?: AbortSignal;
  runContextMemory: RunContextMemory;
}): Promise<{
  evaluation: ManuscriptCandidateEvaluation;
  review: ManuscriptReviewArtifact;
  reviewValidation: ManuscriptReviewValidationArtifact;
  reviewAudit: ManuscriptReviewAuditArtifact;
  repairDecision: ManuscriptRepairDecision;
  repairReports: ManuscriptRepairReport[];
  toolCallsUsed: number;
}> {
  const context = experimentArtifactLoader({
    bundle: input.bundle,
    objectiveEvaluation: input.objectiveEvaluation,
    objectiveMetricProfile: input.objectiveMetricProfile
  });
  const repairReports: ManuscriptRepairReport[] = [];
let toolCallsUsed = 0;
let currentManuscript = compactReaderFacingRepairedManuscript(input.initialManuscript);
  let previousIssues: ManuscriptQualityIssueSnapshot[] | undefined;

  const evaluateCandidate = (manuscript: PaperManuscript): ManuscriptCandidateEvaluation => {
    manuscript = compactReaderFacingRepairedManuscript(
      stabilizePaperManuscriptForSubmission(manuscript, {
        resultAnalysis: input.bundle.resultAnalysis,
        methodModelNames: context.method.model_names
      })
    );
    const consistencyLint = manuscriptConsistencyLinter({
      manuscript,
      context
    });
    const appendixLint = appendixConsistencyLinter({
      manuscript,
      appendixPlan: input.appendixPlan,
      pageBudget: input.pageBudget
    });
    const scientificValidation = refreshScientificValidationForManuscript({
      validation: input.scientificValidationArtifact,
      manuscript,
      profile: input.paperProfile
    });
    const gateDecision = buildWritePaperGateDecision({
      mode: input.validationMode,
      scientificValidation,
      consistencyLint,
      appendixLint
    });
    const traceability = buildPaperTraceability({
      draft: input.draft,
      manuscript
    });
    const tex = renderSubmissionPaperTex({
      manuscript,
      traceability,
      citationKeysByPaperId: input.citationKeysByPaperId,
      template: input.template,
      paperProfile: input.paperProfile,
      parsedTemplate: input.parsedTemplate,
      authorMetadata: input.authorMetadata
    });
    const submissionValidation = buildPaperSubmissionValidation({
      manuscript,
      tex,
      traceability,
      citationKeysByPaperId: input.citationKeysByPaperId,
      unresolvedCitationPaperIds: input.unresolvedCitationPaperIds
    });
    const styleLint = buildManuscriptStyleLint({
      manuscript,
      traceability
    });
    return {
      manuscript,
      traceability,
      tex,
      submissionValidation,
      styleLint,
      consistencyLint,
      appendixLint,
      scientificValidation,
      gateDecision
    };
  };

  const enforcePageBudgetFloor = (candidateEvaluation: ManuscriptCandidateEvaluation): ManuscriptCandidateEvaluation => {
    const floor = enforceManuscriptPageBudgetFloor({
      manuscript: candidateEvaluation.manuscript,
      draft: input.draft,
      pageBudget: input.pageBudget
    });
    if (!floor.applied) {
      return candidateEvaluation;
    }
    input.emitLog(
      `Restored ${floor.added_paragraph_count} scientific draft paragraph(s) after manuscript repair compressed the main body ` +
      `from ${floor.estimated_main_words_before} to ${floor.estimated_main_words_after} words ` +
      `(minimum ${floor.minimum_main_words}).`
    );
    return evaluateCandidate(floor.manuscript);
  };

  const persistRoundArtifacts = async (roundIndex: number, payload: {
    review: ManuscriptReviewArtifact;
    reviewRaw?: string;
    reviewValidation: ManuscriptReviewValidationArtifact;
    reviewAudit: ManuscriptReviewAuditArtifact;
    auditRaw?: string;
    lint: ManuscriptStyleLintArtifact;
    decision: ManuscriptRepairDecision;
  }) => {
    await writeRoundArtifact(input.run, "paper/manuscript_review", roundIndex, payload.review);
    await writeRunArtifact(input.run, "paper/manuscript_review.json", `${JSON.stringify(payload.review, null, 2)}\n`);
    await writeRoundTextArtifact(input.run, "paper/manuscript_review", roundIndex, payload.reviewRaw || "");
    await writeRunArtifact(input.run, "paper/manuscript_review.raw.txt", `${payload.reviewRaw || ""}\n`);
    await writeRoundArtifact(
      input.run,
      "paper/manuscript_review_validation",
      roundIndex,
      payload.reviewValidation
    );
    await writeRunArtifact(
      input.run,
      "paper/manuscript_review_validation.json",
      `${JSON.stringify(payload.reviewValidation, null, 2)}\n`
    );
    await writeRoundArtifact(input.run, "paper/manuscript_review_audit", roundIndex, payload.reviewAudit);
    await writeRunArtifact(
      input.run,
      "paper/manuscript_review_audit.json",
      `${JSON.stringify(payload.reviewAudit, null, 2)}\n`
    );
    await writeRoundTextArtifact(input.run, "paper/manuscript_review_audit", roundIndex, payload.auditRaw || "");
    await writeRunArtifact(input.run, "paper/manuscript_review_audit.raw.txt", `${payload.auditRaw || ""}\n`);
    await writeRoundArtifact(input.run, "paper/manuscript_style_lint", roundIndex, payload.lint);
    await writeRunArtifact(input.run, "paper/manuscript_style_lint.json", `${JSON.stringify(payload.lint, null, 2)}\n`);
    await writeRoundArtifact(input.run, "paper/manuscript_quality_gate", roundIndex, payload.decision);
    await writeRunArtifact(input.run, "paper/manuscript_quality_gate.json", `${JSON.stringify(payload.decision, null, 2)}\n`);
    await input.runContextMemory.put("write_paper.manuscript_review", payload.review);
    await input.runContextMemory.put("write_paper.manuscript_review_validation", payload.reviewValidation);
    await input.runContextMemory.put("write_paper.manuscript_review_audit", payload.reviewAudit);
    await input.runContextMemory.put("write_paper.manuscript_style_lint", payload.lint);
    await input.runContextMemory.put("write_paper.manuscript_quality_gate", payload.decision);
  };

  const persistRepairPlanArtifact = async (
    passIndex: 1 | 2,
    repairPlan: ManuscriptRepairPlanArtifact
  ) => {
    await writeRunArtifact(
      input.run,
      `paper/manuscript_repair_plan_${passIndex}.json`,
      `${JSON.stringify(repairPlan, null, 2)}\n`
    );
    await input.runContextMemory.put(`write_paper.manuscript_repair_plan_${passIndex}`, repairPlan);
  };

  const persistRepairVerificationArtifact = async (
    passIndex: 1 | 2,
    verification: ManuscriptRepairVerificationArtifact
  ) => {
    await writeRunArtifact(
      input.run,
      `paper/manuscript_repair_verification_${passIndex}.json`,
      `${JSON.stringify(verification, null, 2)}\n`
    );
    await input.runContextMemory.put(`write_paper.manuscript_repair_verification_${passIndex}`, verification);
  };

  const runGroundedReviewCycle = async (cycleInput: {
    evaluation: ManuscriptCandidateEvaluation;
    passLabel: string;
    repairPlan?: ManuscriptRepairPlanArtifact;
    focusLocationKeys?: string[];
  }): Promise<GroundedManuscriptReviewCycleResult> => {
    let cycleToolCallsUsed = 0;
    let retryUsed = false;
    let reviewResult = await input.sessions.reviewManuscript({
      run: input.run,
      manuscript: cycleInput.evaluation.manuscript,
      bundle: input.bundle,
      constraintProfile: input.constraintProfile,
      paperProfile: input.paperProfile,
      objectiveMetricProfile: input.objectiveMetricProfile,
      objectiveEvaluation: input.objectiveEvaluation,
      traceability: cycleInput.evaluation.traceability,
      citationKeysByPaperId: input.citationKeysByPaperId,
      stage: "manuscript_review",
      passLabel: cycleInput.passLabel,
      repairPlan: cycleInput.repairPlan,
      focusLocationKeys: cycleInput.focusLocationKeys,
      abortSignal: input.abortSignal
    });
    if (reviewResult.source !== "fallback") {
      cycleToolCallsUsed += 1;
    }

    let review = reviewResult.review;
    let reviewRaw = reviewResult.rawText;
    let validated = validateManuscriptReviewArtifact({
      review,
      manuscript: cycleInput.evaluation.manuscript,
      traceability: cycleInput.evaluation.traceability
    });
    review = validated.review;
    let reviewValidation = validated.validation;

    if (reviewValidation.retry_requested && !retryUsed) {
      retryUsed = true;
      reviewResult = await input.sessions.reviewManuscript({
        run: input.run,
        manuscript: cycleInput.evaluation.manuscript,
        bundle: input.bundle,
        constraintProfile: input.constraintProfile,
        paperProfile: input.paperProfile,
        objectiveMetricProfile: input.objectiveMetricProfile,
        objectiveEvaluation: input.objectiveEvaluation,
        traceability: cycleInput.evaluation.traceability,
        citationKeysByPaperId: input.citationKeysByPaperId,
        stage: "manuscript_review_retry",
        passLabel: `${cycleInput.passLabel} retry`,
        previousReview: review,
        reviewValidation,
        repairPlan: cycleInput.repairPlan,
        focusLocationKeys: cycleInput.focusLocationKeys,
        abortSignal: input.abortSignal
      });
      if (reviewResult.source !== "fallback") {
        cycleToolCallsUsed += 1;
      }
      review = reviewResult.review;
      reviewRaw = reviewResult.rawText;
      validated = validateManuscriptReviewArtifact({
        review,
        manuscript: cycleInput.evaluation.manuscript,
        traceability: cycleInput.evaluation.traceability
      });
      review = validated.review;
      reviewValidation = validated.validation;
    }

    let auditResult = await input.sessions.auditManuscriptReview({
      run: input.run,
      manuscript: cycleInput.evaluation.manuscript,
      review,
      validation: reviewValidation,
      lint: cycleInput.evaluation.styleLint,
      traceability: cycleInput.evaluation.traceability,
      citationKeysByPaperId: input.citationKeysByPaperId,
      passLabel: cycleInput.passLabel,
      abortSignal: input.abortSignal
    });
    if (auditResult.source !== "fallback") {
      cycleToolCallsUsed += 1;
    }
    let reviewAudit = auditResult.audit;
    let auditRaw = auditResult.rawText;

    if (reviewAudit.retry_recommended && !retryUsed) {
      retryUsed = true;
      reviewResult = await input.sessions.reviewManuscript({
        run: input.run,
        manuscript: cycleInput.evaluation.manuscript,
        bundle: input.bundle,
        constraintProfile: input.constraintProfile,
        paperProfile: input.paperProfile,
        objectiveMetricProfile: input.objectiveMetricProfile,
        objectiveEvaluation: input.objectiveEvaluation,
        traceability: cycleInput.evaluation.traceability,
        citationKeysByPaperId: input.citationKeysByPaperId,
        stage: "manuscript_review_retry",
        passLabel: `${cycleInput.passLabel} retry`,
        previousReview: review,
        reviewValidation,
        reviewAudit,
        repairPlan: cycleInput.repairPlan,
        focusLocationKeys: cycleInput.focusLocationKeys,
        abortSignal: input.abortSignal
      });
      if (reviewResult.source !== "fallback") {
        cycleToolCallsUsed += 1;
      }
      review = reviewResult.review;
      reviewRaw = reviewResult.rawText;
      validated = validateManuscriptReviewArtifact({
        review,
        manuscript: cycleInput.evaluation.manuscript,
        traceability: cycleInput.evaluation.traceability
      });
      review = validated.review;
      reviewValidation = validated.validation;
      auditResult = await input.sessions.auditManuscriptReview({
        run: input.run,
        manuscript: cycleInput.evaluation.manuscript,
        review,
        validation: reviewValidation,
        lint: cycleInput.evaluation.styleLint,
        traceability: cycleInput.evaluation.traceability,
        citationKeysByPaperId: input.citationKeysByPaperId,
        passLabel: `${cycleInput.passLabel} audit recheck`,
        abortSignal: input.abortSignal
      });
      if (auditResult.source !== "fallback") {
        cycleToolCallsUsed += 1;
      }
      reviewAudit = auditResult.audit;
      auditRaw = auditResult.rawText;
    }

    reviewValidation = {
      ...reviewValidation,
      metrics: {
        ...reviewValidation.metrics,
        retry_used: retryUsed
      }
    };
    reviewAudit = {
      ...reviewAudit,
      metrics: {
        ...reviewAudit.metrics,
        retry_used: retryUsed
      }
    };

    return {
      review,
      reviewValidation,
      reviewAudit,
      reviewRaw,
      auditRaw,
      toolCallsUsed: cycleToolCallsUsed,
      retryUsed
    };
  };

  const resolvePendingRepairPlan = async (inputPlan: {
    passIndex: 1 | 2;
    manuscript: PaperManuscript;
    review: ManuscriptReviewArtifact;
    lint: ManuscriptStyleLintArtifact;
    issues: ManuscriptQualityIssueSnapshot[];
    decision: ManuscriptRepairDecision;
  }): Promise<{
    plan: ManuscriptRepairPlanArtifact | undefined;
    decision: ManuscriptRepairDecision;
  }> => {
    if (inputPlan.decision.action !== "repair") {
      return {
        plan: undefined,
        decision: inputPlan.decision
      };
    }
    const repairPlan = buildManuscriptRepairPlan({
      passIndex: inputPlan.passIndex,
      manuscript: inputPlan.manuscript,
      review: inputPlan.review,
      lint: inputPlan.lint,
      mustImproveIssues: inputPlan.issues
    });
    await persistRepairPlanArtifact(inputPlan.passIndex, repairPlan);
    const blockedFailTargets = repairPlan.blocked_targets.filter((target) => target.severity === "fail");
    if (repairPlan.targets.length > 0 && blockedFailTargets.length === 0) {
      return {
        plan: repairPlan,
        decision: inputPlan.decision
      };
    }
    return {
      plan: repairPlan,
      decision: {
        ...inputPlan.decision,
        action: "stop",
        remaining_allowed_repairs: 0,
        stop_or_continue_reason:
          repairPlan.targets.length === 0
            ? "Repairable manuscript issues remained, but no bounded local repair target could be derived safely."
            : blockedFailTargets.length > 0
              ? "Repairable manuscript issues remained, but some blocking issues could not be converted into safe bounded local repair targets."
              : "Repairable manuscript issues remained, but some issues could not be converted into safe bounded local repair targets."
      }
    };
  };

  let evaluation = evaluateCandidate(currentManuscript);
  let reviewCycle = await runGroundedReviewCycle({
    evaluation,
    passLabel: "initial manuscript review"
  });
  toolCallsUsed += reviewCycle.toolCallsUsed;
  let review = reviewCycle.review;
  let reviewValidation = reviewCycle.reviewValidation;
  let reviewAudit = reviewCycle.reviewAudit;
  let effectiveStyleLint = reconcileManuscriptStyleLintWithReview({
    lint: evaluation.styleLint,
    review
  });
  evaluation = {
    ...evaluation,
    styleLint: effectiveStyleLint
  };
  let decision = buildInitialManuscriptRepairDecision({
    review,
    reviewValidation,
    reviewAudit,
    lint: effectiveStyleLint
  });
  let pendingRepairPlanResult = await resolvePendingRepairPlan({
    passIndex: 1,
    manuscript: evaluation.manuscript,
    review,
    lint: effectiveStyleLint,
    issues: decision.issues_before,
    decision
  });
  let pendingRepairPlan = pendingRepairPlanResult.plan;
  decision = pendingRepairPlanResult.decision;
  await persistRoundArtifacts(0, {
    review,
    reviewRaw: reviewCycle.reviewRaw,
    reviewValidation,
    reviewAudit,
    auditRaw: reviewCycle.auditRaw,
    lint: effectiveStyleLint,
    decision
  });
  input.emitLog(
    `Manuscript quality round 0: decision=${decision.action}, issues=${decision.issues_before.length}, lint=${effectiveStyleLint.issues.length}, review_reliability=${resolveReviewArtifactReliability(reviewValidation, reviewAudit)}.`
  );
  if (decision.action === "pass") {
    await clearStaleManuscriptQualityFailureArtifact(input.run);
    evaluation = enforcePageBudgetFloor(evaluation);
    return {
      evaluation,
      review,
      reviewValidation,
      reviewAudit,
      repairDecision: decision,
      repairReports,
      toolCallsUsed
    };
  }

  previousIssues = decision.issues_before;

  for (const passIndex of [1, 2] as const) {
    if (decision.action !== "repair") {
      break;
    }
    const remainingAllowedRepairs = Math.max(0, decision.allowed_max_passes - passIndex);
    const repairPlan = pendingRepairPlan;
    if (!repairPlan) {
      decision = {
        ...decision,
        action: "stop",
        remaining_allowed_repairs: 0,
        stop_or_continue_reason: "A manuscript repair was requested, but no safe bounded local repair plan was available."
      };
      break;
    }
    input.emitLog(`Running manuscript repair pass ${passIndex}.`);
    const manuscriptBeforeRepair = evaluation.manuscript;
    const repairResult = await input.sessions.repairManuscript({
      run: input.run,
      passIndex,
      manuscript: manuscriptBeforeRepair,
      draft: input.draft,
      bundle: input.bundle,
      review,
      lint: evaluation.styleLint,
      repairPlan,
      objectiveEvaluation: input.objectiveEvaluation,
      objectiveMetricProfile: input.objectiveMetricProfile,
      remainingAllowedRepairs,
      mustImproveIssues: decision.issues_before,
      abortSignal: input.abortSignal
    });
    if (repairResult.source !== "fallback") {
      toolCallsUsed += 1;
    }
    const normalizedVerificationReferenceManuscript = normalizeManuscriptForRepairLocalityComparison(manuscriptBeforeRepair, {
      resultAnalysis: input.bundle.resultAnalysis,
      methodModelNames: context.method.model_names
    });
    const verificationReferenceManuscript = restoreDerivedMainVisualsFromReference(
      normalizedVerificationReferenceManuscript,
      manuscriptBeforeRepair
    );
    currentManuscript = enforceRepairPlanLocalityAfterStabilization(
      verificationReferenceManuscript,
      stabilizePaperManuscriptForSubmission(
        sanitizeReaderFacingRepairTargets(manuscriptBeforeRepair, repairResult.manuscript, repairPlan),
        {
          resultAnalysis: input.bundle.resultAnalysis,
          methodModelNames: context.method.model_names
        }
      ),
      repairPlan
    );
    currentManuscript = stabilizePaperManuscriptForSubmission(currentManuscript, {
      resultAnalysis: input.bundle.resultAnalysis,
      methodModelNames: context.method.model_names
    });
    currentManuscript = restoreDerivedMainVisualsFromReference(currentManuscript, verificationReferenceManuscript);
    currentManuscript = restoreDerivedMainVisualsFromReference(currentManuscript, manuscriptBeforeRepair);
    currentManuscript = enforceRepairPlanLocalityAfterStabilization(
      verificationReferenceManuscript,
      currentManuscript,
      repairPlan
    );
    currentManuscript = restoreDerivedMainVisualsFromReference(currentManuscript, verificationReferenceManuscript);
    currentManuscript = restoreDerivedMainVisualsFromReference(currentManuscript, manuscriptBeforeRepair);
    evaluation = evaluateCandidate(currentManuscript);
    reviewCycle = await runGroundedReviewCycle({
      evaluation,
      passLabel: `recheck after manuscript repair ${passIndex}`,
      repairPlan,
      focusLocationKeys: uniqueStrings(
        repairPlan.targets.flatMap((target) =>
          target.allowed_location_keys.length > 0 ? target.allowed_location_keys : [target.location_key]
        )
      )
    });
    toolCallsUsed += reviewCycle.toolCallsUsed;
    review = reviewCycle.review;
    reviewValidation = reviewCycle.reviewValidation;
    reviewAudit = reviewCycle.reviewAudit;
    effectiveStyleLint = reconcileManuscriptStyleLintWithReview({
      lint: evaluation.styleLint,
      review
    });
    evaluation = {
      ...evaluation,
      styleLint: effectiveStyleLint
    };
    const repairVerification = buildManuscriptRepairVerificationArtifact({
      passIndex,
      before: verificationReferenceManuscript,
      after: currentManuscript,
      repairPlan,
      reviewAfter: review
    });
    await persistRepairVerificationArtifact(passIndex, repairVerification);
    const issuesAfter = collectManuscriptQualityIssues({
      review,
      lint: effectiveStyleLint
    });
    decision = buildFollowupManuscriptRepairDecision({
      passIndex,
      review,
      reviewValidation,
      reviewAudit,
      repairVerification,
      previousIssues: previousIssues || [],
      issuesAfter,
      gateDecision: evaluation.gateDecision,
      submissionValidation: evaluation.submissionValidation
    });
    pendingRepairPlanResult = await resolvePendingRepairPlan({
      passIndex: passIndex === 1 ? 2 : 2,
      manuscript: evaluation.manuscript,
      review,
      lint: effectiveStyleLint,
      issues: issuesAfter,
      decision
    });
    pendingRepairPlan = pendingRepairPlanResult.plan;
    decision = pendingRepairPlanResult.decision;
    const report: ManuscriptRepairReport = {
      pass_index: passIndex,
      triggered_by: uniqueStrings((previousIssues || []).map((issue) => issue.code)),
      allowed_max_passes: decision.allowed_max_passes,
      issues_before: previousIssues || [],
      issues_after: issuesAfter,
      improvement_detected: Boolean(decision.improvement_detected),
      verification_summary: repairVerification.summary,
      verification_findings: buildRepairVerificationFindings(repairVerification),
      stop_or_continue_reason: decision.stop_or_continue_reason
    };
    repairReports.push(report);
    await writeRunArtifact(
      input.run,
      `paper/manuscript_repair_${passIndex}.json`,
      `${JSON.stringify(currentManuscript, null, 2)}\n`
    );
    await writeRunArtifact(
      input.run,
      `paper/manuscript_repair_${passIndex}.raw.txt`,
      `${repairResult.rawText || repairResult.error || ""}\n`
    );
    await writeRunArtifact(
      input.run,
      `paper/manuscript_repair_${passIndex}_report.json`,
      `${JSON.stringify(report, null, 2)}\n`
    );
    await persistRoundArtifacts(passIndex, {
      review,
      reviewRaw: reviewCycle.reviewRaw,
      reviewValidation,
      reviewAudit,
      auditRaw: reviewCycle.auditRaw,
      lint: effectiveStyleLint,
      decision
    });
    await input.runContextMemory.put(`write_paper.manuscript_repair_${passIndex}`, report);
    input.emitLog(
      `Manuscript quality round ${passIndex}: decision=${decision.action}, remaining_issues=${issuesAfter.length}, improvement=${decision.improvement_detected ? "yes" : "no"}, review_reliability=${resolveReviewArtifactReliability(reviewValidation, reviewAudit)}.`
    );
    if (decision.action === "pass" || decision.action === "stop") {
      break;
    }
    previousIssues = issuesAfter;
  }

  if (decision.action === "stop") {
    await writeRunArtifact(
      input.run,
      "paper/manuscript_quality_failure.json",
      `${JSON.stringify(
        buildManuscriptQualityFailureArtifact({
          decision,
          lint: evaluation.styleLint,
          reviewValidation,
          reviewAudit
        }),
        null,
        2
      )}\n`
    );
  } else {
    await clearStaleManuscriptQualityFailureArtifact(input.run);
  }

  if (decision.action !== "stop") {
    evaluation = enforcePageBudgetFloor(evaluation);
  }

  return {
    evaluation,
    review,
    reviewValidation,
    reviewAudit,
    repairDecision: decision,
    repairReports,
    toolCallsUsed
  };
}

function buildInitialManuscriptRepairDecision(input: {
  review: ManuscriptReviewArtifact;
  reviewValidation: ManuscriptReviewValidationArtifact;
  reviewAudit: ManuscriptReviewAuditArtifact;
  lint: ManuscriptStyleLintArtifact;
}): ManuscriptRepairDecision {
  const issuesBefore = collectManuscriptQualityIssues({
    review: input.review,
    lint: input.lint
  });
  const reviewReliability = resolveReviewArtifactReliability(input.reviewValidation, input.reviewAudit);
  const failCount = issuesBefore.filter((issue) => issue.severity === "fail").length;
  const nonRepairableFailCount = issuesBefore.filter((issue) => issue.severity === "fail" && !issue.repairable).length;
  if (issuesBefore.length === 0 && reviewReliability === "degraded") {
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: 0,
      triggered_by: [],
      allowed_max_passes: 1,
      remaining_allowed_repairs: 0,
      issues_before: [],
      stop_or_continue_reason:
        "The manuscript review artifact remained degraded after bounded validation and audit, so the manuscript cannot be accepted silently."
    }, reviewReliability);
  }
  if (nonRepairableFailCount > 0) {
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: 0,
      triggered_by: uniqueStrings(issuesBefore.filter((issue) => issue.severity === "fail" && !issue.repairable).map((issue) => issue.code)),
      allowed_max_passes: 1,
      remaining_allowed_repairs: 0,
      issues_before: issuesBefore,
      stop_or_continue_reason:
        "Deterministic hard-stop manuscript policy findings remain outside the repairable local-writing surface."
    }, reviewReliability);
  }
  if (issuesBefore.length === 0) {
    return finalizeManuscriptRepairDecision({
      action: "pass",
      pass_index: 0,
      triggered_by: [],
      allowed_max_passes: 1,
      remaining_allowed_repairs: 1,
      issues_before: [],
      stop_or_continue_reason: "Initial manuscript review and style lint passed."
    }, reviewReliability);
  }
  if (
    issuesBefore.every((issue) => issue.repairable) &&
    (failCount > 0 || input.review.overall_decision === "repair")
  ) {
    return finalizeManuscriptRepairDecision({
      action: "repair",
      pass_index: 0,
      triggered_by: buildInitialManuscriptRepairTriggers(issuesBefore, failCount),
      allowed_max_passes: 1,
      remaining_allowed_repairs: 1,
      issues_before: issuesBefore,
      stop_or_continue_reason: "Repairable manuscript-quality issues remain after the initial review."
    }, reviewReliability);
  }
  return finalizeManuscriptRepairDecision({
    action: "pass",
    pass_index: 0,
    triggered_by: uniqueStrings(issuesBefore.map((issue) => issue.code)),
    allowed_max_passes: 1,
    remaining_allowed_repairs: 1,
    issues_before: issuesBefore,
    stop_or_continue_reason: "Initial manuscript review found only non-blocking manuscript warnings."
  }, reviewReliability);
}

function buildInitialManuscriptRepairTriggers(
  issues: ManuscriptQualityIssueSnapshot[],
  failCount: number
): string[] {
  if (failCount > 0) {
    return uniqueStrings(issues.filter((issue) => issue.severity === "fail").map((issue) => issue.code));
  }
  const reviewIssueCodes = issues
    .filter((issue) => issue.source === "review")
    .map((issue) => issue.code);
  return uniqueStrings(reviewIssueCodes.length > 0 ? reviewIssueCodes : issues.map((issue) => issue.code));
}

function buildFollowupManuscriptRepairDecision(input: {
  passIndex: 1 | 2;
  review: ManuscriptReviewArtifact;
  reviewValidation: ManuscriptReviewValidationArtifact;
  reviewAudit: ManuscriptReviewAuditArtifact;
  repairVerification: ManuscriptRepairVerificationArtifact;
  previousIssues: ManuscriptQualityIssueSnapshot[];
  issuesAfter: ManuscriptQualityIssueSnapshot[];
  gateDecision: ReturnType<typeof buildWritePaperGateDecision>;
  submissionValidation: PaperSubmissionValidationReport;
}): ManuscriptRepairDecision {
  const reviewReliability = resolveReviewArtifactReliability(input.reviewValidation, input.reviewAudit);
  const improvement = detectIssueImprovement(input.previousIssues, input.issuesAfter);
  const repeatedIssueSignatures = findRepeatedIssueSignatures(input.previousIssues, input.issuesAfter);
  const repeatedCriticalIssues = repeatedIssueSignatures.filter((signature) =>
    CRITICAL_REPEAT_MANUSCRIPT_CODES.has(signature.code)
  );
  const changedVisualReviewIssues = collectChangedVisualReviewIssues(
    input.review,
    input.repairVerification.changed_location_keys
  );
  const remainingFailCount = input.issuesAfter.filter((issue) => issue.severity === "fail").length;
  const remainingNonRepairableFails = input.issuesAfter.filter((issue) => issue.severity === "fail" && !issue.repairable);
  const warningOnlyManuscriptIssues =
    remainingFailCount === 0
    && input.issuesAfter.length > 0
    && input.issuesAfter.every((issue) => issue.severity === "warning");
  const gateHasOnlyNonBlockingOrUnverifiableIssues = hasOnlyNonBlockingOrUnverifiableGateIssues(input.gateDecision);
  const gateAllowsBoundedManuscriptContinuation =
    input.gateDecision.status !== "fail"
    || isRepairableBoundedManuscriptContinuationGateFailure(input.gateDecision)
    || gateHasOnlyNonBlockingOrUnverifiableIssues;
  if (!input.repairVerification.locality_ok) {
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(input.previousIssues.map((issue) => issue.code)),
      allowed_max_passes: 1,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason: "The manuscript repair changed out-of-scope locations, so the bounded local repair loop stops."
    }, reviewReliability);
  }
  if (
    changedVisualReviewIssues.some((issue) => issue.severity === "fail")
    || (input.review.overall_decision === "stop" && changedVisualReviewIssues.length > 0)
  ) {
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(changedVisualReviewIssues.map((issue) => issue.code)),
      allowed_max_passes: input.passIndex === 1 ? 1 : 2,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason:
        "The follow-up manuscript review still finds a changed visual or caption issue after repair, so the bounded local repair loop stops."
    }, reviewReliability);
  }
  if (!input.repairVerification.visual_conservatism_ok && changedVisualReviewIssues.length === 0) {
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings([
        ...input.previousIssues.map((issue) => issue.code),
        ...(!input.repairVerification.visual_caption_conservatism_ok ? ["visual_caption_overclaim"] : []),
        ...(!input.repairVerification.visual_label_conservatism_ok ? ["visual_label_overclaim"] : [])
      ]),
      allowed_max_passes: input.passIndex === 1 ? 1 : 2,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason:
        "The repaired manuscript still contains non-conservative changed visual wording, so the bounded local repair loop stops instead of retrying silently."
    }, reviewReliability);
  }
  if (input.issuesAfter.length === 0) {
    if (reviewReliability === "degraded") {
      return finalizeManuscriptRepairDecision({
        action: "stop",
        pass_index: input.passIndex,
        triggered_by: uniqueStrings(input.previousIssues.map((issue) => issue.code)),
        allowed_max_passes: input.passIndex === 1 ? 1 : 2,
        remaining_allowed_repairs: 0,
        issues_before: input.previousIssues,
        issues_after: input.issuesAfter,
        improvement_detected: improvement,
        stop_or_continue_reason:
          "The repaired manuscript is locally clean, but the follow-up manuscript review artifact remained degraded after bounded retry."
      }, reviewReliability);
    }
    return finalizeManuscriptRepairDecision({
      action: "pass",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(input.previousIssues.map((issue) => issue.code)),
      allowed_max_passes: input.passIndex === 1 ? 1 : 2,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason: `Manuscript repair ${input.passIndex} resolved the remaining manuscript-quality issues.`
    }, reviewReliability);
  }
  if (remainingNonRepairableFails.length > 0) {
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(remainingNonRepairableFails.map((issue) => issue.code)),
      allowed_max_passes: input.passIndex === 1 ? 1 : 2,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason:
        "Deterministic hard-stop manuscript policy findings remain after repair, so another local manuscript repair is not allowed."
    }, reviewReliability);
  }
  if (
    input.passIndex >= 2
    && remainingFailCount === 0
    && gateAllowsBoundedManuscriptContinuation
    && input.submissionValidation.ok
    && input.reviewValidation.ok
    && input.review.overall_decision !== "stop"
  ) {
    return finalizeManuscriptRepairDecision({
      action: "pass",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(input.issuesAfter.map((issue) => issue.code)),
      allowed_max_passes: 2,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason:
        "Only non-blocking manuscript warnings remain after the second bounded repair; record them as readiness risks instead of attempting a forbidden third repair."
    }, reviewReliability);
  }

  if (reviewReliability === "partially_grounded") {
    const hasBlockingAuditIssue = input.reviewAudit.issues.some((issue) =>
      issue.severity === "fail"
    );
    const traceabilityOnlyMismatch = isRepairableReviewTraceabilityOnlyMismatch(
      input.reviewValidation,
      input.reviewAudit
    );
    const narrowRepairableRemainingScope =
      input.passIndex < 2 &&
      !hasBlockingAuditIssue &&
      improvement &&
      input.issuesAfter.every((issue) => issue.repairable) &&
      (
        remainingFailCount > 0 ||
        input.issuesAfter.every((issue) => issue.severity === "warning")
      ) &&
      remainingFailCount <= 2 &&
      input.issuesAfter.length <= 6 &&
      uniqueStrings(input.issuesAfter.map((issue) => `${issue.source}:${issue.code}`)).length <= 6 &&
      gateAllowsBoundedManuscriptContinuation &&
      input.submissionValidation.ok &&
      (input.reviewValidation.ok || traceabilityOnlyMismatch) &&
      input.review.overall_decision !== "stop";
    if (narrowRepairableRemainingScope) {
      return finalizeManuscriptRepairDecision({
        action: "repair",
        pass_index: input.passIndex,
        triggered_by: uniqueStrings(input.issuesAfter.map((issue) => issue.code)),
        allowed_max_passes: 2,
        remaining_allowed_repairs: 1,
        issues_before: input.previousIssues,
        issues_after: input.issuesAfter,
        improvement_detected: improvement,
        stop_or_continue_reason:
          "A second and final manuscript repair is allowed because the partially grounded follow-up audit has no blocking grounding failure and the remaining issues are narrow, repairable, and improved after pass 1."
      }, reviewReliability);
    }
    if (
      !hasBlockingAuditIssue
      && remainingFailCount === 0
      && gateAllowsBoundedManuscriptContinuation
      && input.submissionValidation.ok
      && (input.reviewValidation.ok || traceabilityOnlyMismatch)
    ) {
      return finalizeManuscriptRepairDecision({
        action: "pass",
        pass_index: input.passIndex,
        triggered_by: uniqueStrings(input.previousIssues.map((issue) => issue.code)),
        allowed_max_passes: input.passIndex === 1 ? 1 : 2,
        remaining_allowed_repairs: 0,
        issues_before: input.previousIssues,
        issues_after: input.issuesAfter,
        improvement_detected: improvement,
        stop_or_continue_reason:
          "Only non-blocking manuscript warnings remain after repair; the follow-up review audit is partially grounded but has no blocking grounding failure."
      }, reviewReliability);
    }
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(input.issuesAfter.map((issue) => issue.code)),
      allowed_max_passes: input.passIndex >= 2 ? 2 : 1,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason:
        input.passIndex >= 2
          ? "The second and final manuscript repair did not resolve the partially grounded follow-up review findings."
          : "The follow-up manuscript review remained only partially grounded, so a second manuscript repair is not allowed."
    }, reviewReliability);
  }
  const warningOnlyRepairableScope =
    input.passIndex < 2 &&
    remainingFailCount === 0 &&
    improvement &&
    input.issuesAfter.length > 0 &&
    input.issuesAfter.every((issue) => issue.severity === "warning" && issue.repairable) &&
    input.issuesAfter.length <= 6 &&
    uniqueStrings(input.issuesAfter.map((issue) => `${issue.source}:${issue.code}`)).length <= 6 &&
    input.submissionValidation.ok &&
    input.review.overall_decision === "repair";
  if (warningOnlyRepairableScope) {
    return finalizeManuscriptRepairDecision({
      action: "repair",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(input.issuesAfter.map((issue) => issue.code)),
      allowed_max_passes: 2,
      remaining_allowed_repairs: 1,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason:
        "A second and final manuscript repair is allowed because warning-only follow-up issues remain repairable and improved after pass 1."
    }, reviewReliability);
  }
  if (remainingFailCount === 0 && gateAllowsBoundedManuscriptContinuation && input.submissionValidation.ok) {
    return finalizeManuscriptRepairDecision({
      action: "pass",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(input.previousIssues.map((issue) => issue.code)),
      allowed_max_passes: input.passIndex === 1 ? 1 : 2,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason: "Only non-blocking manuscript warnings remain after repair."
    }, reviewReliability);
  }
  if (input.passIndex >= 2) {
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(input.previousIssues.map((issue) => issue.code)),
      allowed_max_passes: 2,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason: "A third manuscript repair pass is forbidden."
    }, reviewReliability);
  }
  const blockingIssuesAfter = input.issuesAfter.filter((issue) => issue.severity === "fail");
  const narrowBlockingScope =
    improvement &&
    remainingFailCount > 0 &&
    blockingIssuesAfter.every((issue) => issue.repairable) &&
    blockingIssuesAfter.length <= 3 &&
    uniqueStrings(blockingIssuesAfter.map((issue) => `${issue.source}:${issue.code}`)).length <= 3 &&
    input.review.overall_decision !== "stop";
  const deferCoreGateFailureToNarrowRepair =
    narrowBlockingScope &&
    input.submissionValidation.ok &&
    reviewReliability !== "degraded" &&
    repeatedCriticalIssues.length === 0;
  if (
    warningOnlyManuscriptIssues
    && !gateAllowsBoundedManuscriptContinuation
    && input.submissionValidation.ok
    && gateHasOnlyNonBlockingOrUnverifiableIssues
  ) {
    return finalizeManuscriptRepairDecision({
      action: "pass",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(input.issuesAfter.map((issue) => issue.code)),
      allowed_max_passes: input.passIndex === 1 ? 1 : 2,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason:
        "Only non-blocking manuscript warnings remain after repair; upstream validation issues are warning-only or unverifiable and are recorded as readiness risks."
    }, reviewReliability);
  }
  if ((!gateAllowsBoundedManuscriptContinuation || !input.submissionValidation.ok) && !deferCoreGateFailureToNarrowRepair) {
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(input.issuesAfter.map((issue) => issue.code)),
      allowed_max_passes: 1,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason: "Scientific or submission validation now exposes core failures, so a second manuscript repair is not allowed."
    }, reviewReliability);
  }
  if (reviewReliability === "degraded") {
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(input.issuesAfter.map((issue) => issue.code)),
      allowed_max_passes: 1,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason:
        "The follow-up manuscript review artifact remained degraded after bounded validation and audit, so a second manuscript repair is not allowed."
    }, reviewReliability);
  }
  if (repeatedCriticalIssues.length > 0) {
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: input.passIndex,
      triggered_by: repeatedCriticalIssues.map((item) => item.code),
      allowed_max_passes: 1,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason: "Critical manuscript-quality issue codes repeated after the first repair pass."
    }, reviewReliability);
  }
  if (repeatedIssueSignatures.length > 0 && !improvement) {
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(repeatedIssueSignatures.map((item) => item.code)),
      allowed_max_passes: 1,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason: "The same manuscript-quality issue code repeated after repair, so the loop stops instead of retrying silently."
    }, reviewReliability);
  }
  if (narrowBlockingScope) {
    return finalizeManuscriptRepairDecision({
      action: "repair",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(blockingIssuesAfter.map((issue) => issue.code)),
      allowed_max_passes: 2,
      remaining_allowed_repairs: 1,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason:
        "A second and final manuscript repair is allowed because the remaining blocking issues are narrow, repairable, and improved after pass 1."
    }, reviewReliability);
  }
  if (!improvement || worsenedIssues(input.previousIssues, input.issuesAfter)) {
    return finalizeManuscriptRepairDecision({
      action: "stop",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(input.issuesAfter.map((issue) => issue.code)),
      allowed_max_passes: 1,
      remaining_allowed_repairs: 0,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason: "The first manuscript repair did not show a reliable quality improvement."
    }, reviewReliability);
  }
  const narrowScope =
    improvement &&
    input.issuesAfter.every((issue) => issue.repairable) &&
    input.issuesAfter.length <= 3 &&
    uniqueStrings(input.issuesAfter.map((issue) => `${issue.source}:${issue.code}`)).length <= 3 &&
    input.review.overall_decision !== "stop";
  if (narrowScope) {
    return finalizeManuscriptRepairDecision({
      action: "repair",
      pass_index: input.passIndex,
      triggered_by: uniqueStrings(input.issuesAfter.map((issue) => issue.code)),
      allowed_max_passes: 2,
      remaining_allowed_repairs: 1,
      issues_before: input.previousIssues,
      issues_after: input.issuesAfter,
      improvement_detected: improvement,
      stop_or_continue_reason: "A second and final manuscript repair is allowed because the remaining issues are narrow, repairable, and improved after pass 1."
    }, reviewReliability);
  }
  return finalizeManuscriptRepairDecision({
    action: "stop",
    pass_index: input.passIndex,
    triggered_by: uniqueStrings(input.issuesAfter.map((issue) => issue.code)),
    allowed_max_passes: 1,
    remaining_allowed_repairs: 0,
    issues_before: input.previousIssues,
    issues_after: input.issuesAfter,
    improvement_detected: improvement,
    stop_or_continue_reason: "Remaining manuscript issues are too broad for a second local repair pass."
  }, reviewReliability);
}

function isRepairableBoundedManuscriptContinuationGateFailure(
  gateDecision: ReturnType<typeof buildWritePaperGateDecision>
): boolean {
  if (gateDecision.status !== "fail" || gateDecision.issues.length === 0) {
    return false;
  }
  const blockingIssues = gateDecision.issues.filter((issue) => issue.blocking);
  if (blockingIssues.length === 0) {
    return false;
  }
  return blockingIssues.every((issue) =>
    (
      issue.source === "scientific_validation"
      && issue.category === "page_budget"
      && issue.finding === "repairable"
    )
    || (
      (issue.source === "consistency_lint" || issue.source === "appendix_lint")
      && (issue.category === "consistency" || issue.category === "appendix")
    )
  );
}

function hasOnlyNonBlockingOrUnverifiableGateIssues(
  gateDecision: ReturnType<typeof buildWritePaperGateDecision>
): boolean {
  if (gateDecision.issues.length === 0) {
    return true;
  }
  return gateDecision.issues.every((issue) =>
    !issue.blocking
    || issue.finding === "unverifiable"
    || issue.policy === "warn_only"
    || (
      issue.source === "scientific_validation"
      && issue.category === "page_budget"
      && issue.finding === "repairable"
    )
  );
}

function detectIssueImprovement(
  before: ManuscriptQualityIssueSnapshot[],
  after: ManuscriptQualityIssueSnapshot[]
): boolean {
  const beforeFail = before.filter((issue) => issue.severity === "fail").length;
  const afterFail = after.filter((issue) => issue.severity === "fail").length;
  if (afterFail < beforeFail) {
    return true;
  }
  const beforeScore = issueSeverityScore(before);
  const afterScore = issueSeverityScore(after);
  if (afterScore < beforeScore) {
    return true;
  }
  const beforeCodes = uniqueStrings(before.map((issue) => issue.code));
  const afterCodes = new Set(after.map((issue) => issue.code));
  const unresolvedBeforeCodes = beforeCodes.filter((code) => afterCodes.has(code));
  if (unresolvedBeforeCodes.length < beforeCodes.length) {
    return true;
  }
  return uniqueStrings(after.map(issueSignature)).length < uniqueStrings(before.map(issueSignature)).length;
}

function worsenedIssues(
  before: ManuscriptQualityIssueSnapshot[],
  after: ManuscriptQualityIssueSnapshot[]
): boolean {
  return issueSeverityScore(after) > issueSeverityScore(before)
    || after.filter((issue) => issue.severity === "fail").length > before.filter((issue) => issue.severity === "fail").length;
}

function issueSeverityScore(issues: ManuscriptQualityIssueSnapshot[]): number {
  return issues.reduce((sum, issue) => sum + (issue.severity === "fail" ? 2 : 1), 0);
}

function findRepeatedIssueSignatures(
  previous: ManuscriptQualityIssueSnapshot[],
  current: ManuscriptQualityIssueSnapshot[]
): Array<{ code: string; section: string; severity: "warning" | "fail" }> {
  const previousSet = new Set(previous.map(issueSignature));
  return current
    .filter((issue) => previousSet.has(issueSignature(issue)))
    .map((issue) => ({
      code: issue.code,
      section: issue.section,
      severity: issue.severity
    }));
}

function issueSignature(issue: ManuscriptQualityIssueSnapshot): string {
  const anchorSignature =
    issue.anchor_ids && issue.anchor_ids.length > 0
      ? uniqueStrings(issue.anchor_ids).sort().join("|")
      : issue.section;
  return `${issue.source}:${issue.code}:${anchorSignature}:${issue.severity}`;
}

function collectChangedVisualReviewIssues(
  review: ManuscriptReviewArtifact,
  changedLocationKeys: string[]
): ManuscriptReviewArtifact["issues"] {
  const changedSet = new Set(changedLocationKeys);
  return review.issues.filter((issue) =>
    isVisualSurfaceReviewIssue(issue) &&
    (issue.visual_targets || []).some((target) => {
      const locationKey = target.kind === "table"
        ? `table:${target.index}`
        : target.kind === "figure"
          ? `figure:${target.index}`
          : target.kind === "appendix_table"
            ? `appendix_table:${target.index}`
            : `appendix_figure:${target.index}`;
      return changedSet.has(locationKey);
    })
  );
}

function isVisualSurfaceReviewIssue(issue: ManuscriptReviewArtifact["issues"][number]): boolean {
  const code = String(issue.code || "").trim().toLowerCase();
  if (
    code.includes("visual")
    || code.includes("figure")
    || code.includes("caption")
    || code.includes("table_caption")
    || code === "rhetorical_overreach"
  ) {
    return true;
  }
  const text = `${issue.message || ""} ${issue.fix_recommendation || ""}`.toLowerCase();
  return /\b(figure|caption|visual|table)\b/u.test(text)
    && /\b(overclaim|overstate|mislead|mismatch|inconsistent|unsupported)\b/u.test(text);
}

function resolveReviewArtifactReliability(
  reviewValidation: ManuscriptReviewValidationArtifact,
  reviewAudit: ManuscriptReviewAuditArtifact
): "grounded" | "partially_grounded" | "degraded" {
  if (
    reviewValidation.artifact_reliability === "degraded"
    || reviewAudit.artifact_reliability === "degraded"
  ) {
    if (isRepairableReviewTraceabilityOnlyMismatch(reviewValidation, reviewAudit)) {
      return "partially_grounded";
    }
    return "degraded";
  }
  if (
    reviewValidation.artifact_reliability === "partially_grounded"
    || reviewAudit.artifact_reliability === "partially_grounded"
  ) {
    if (isNonBlockingReviewValidationMismatch(reviewValidation, reviewAudit)) {
      return "grounded";
    }
    return "partially_grounded";
  }
  return "grounded";
}

function isRepairableReviewTraceabilityOnlyMismatch(
  reviewValidation: ManuscriptReviewValidationArtifact,
  reviewAudit: ManuscriptReviewAuditArtifact
): boolean {
  return !reviewValidation.ok
    && reviewAudit.ok
    && !reviewAudit.retry_recommended
    && reviewValidation.issues.length > 0
    && reviewValidation.issues.every((issue) =>
      issue.code === "issue_missing_supporting_span" && issue.severity === "fail"
    )
    && reviewAudit.issues.every((issue) => issue.severity === "warning");
}

function isNonBlockingReviewValidationMismatch(
  reviewValidation: ManuscriptReviewValidationArtifact,
  reviewAudit: ManuscriptReviewAuditArtifact
): boolean {
  return reviewValidation.ok
    && reviewAudit.ok
    && !reviewValidation.retry_requested
    && !reviewAudit.retry_recommended
    && (
      reviewValidation.artifact_reliability === "partially_grounded"
      || reviewAudit.artifact_reliability === "partially_grounded"
    )
    && reviewValidation.issues.every((issue) => issue.severity === "warning")
    && reviewAudit.issues.every((issue) => issue.severity === "warning");
}

function finalizeManuscriptRepairDecision(
  decision: ManuscriptRepairDecisionCore,
  reviewReliability: "grounded" | "partially_grounded" | "degraded"
): ManuscriptRepairDecision {
  return {
    ...decision,
    decision_digest: buildManuscriptQualityGateDecisionDigest({
      decision,
      reviewReliability
    }),
    summary_lines: buildManuscriptQualityGateSummaryLines({
      decision,
      reviewReliability
    })
  };
}

function buildManuscriptQualityGateDecisionDigest(input: {
  decision: ManuscriptRepairDecisionCore;
  reviewReliability: "grounded" | "partially_grounded" | "degraded";
}): ManuscriptRepairDecision["decision_digest"] {
  const before = summarizeIssueCounts(input.decision.issues_before);
  const after = input.decision.issues_after ? summarizeIssueCounts(input.decision.issues_after) : undefined;
  return {
    stage:
      input.decision.pass_index === 0
        ? "initial_gate"
        : input.decision.pass_index === 1
          ? "post_repair_1"
          : "post_repair_2",
    action: input.decision.action,
    review_reliability: input.reviewReliability,
    issue_counts_before: before,
    ...(after ? { issue_counts_after: after } : {}),
    ...(typeof input.decision.improvement_detected === "boolean"
      ? { improvement_detected: input.decision.improvement_detected }
      : {}),
    allowed_max_passes: input.decision.allowed_max_passes,
    remaining_allowed_repairs: input.decision.remaining_allowed_repairs,
    triggered_by: input.decision.triggered_by,
    stop_reason_category: inferManuscriptQualityStopReasonCategory(input.decision, input.reviewReliability)
  };
}

function summarizeIssueCounts(
  issues: ManuscriptQualityIssueSnapshot[]
): ManuscriptRepairDecision["decision_digest"]["issue_counts_before"] {
  return {
    total: issues.length,
    fail: issues.filter((issue) => issue.severity === "fail").length,
    warning: issues.filter((issue) => issue.severity === "warning").length
  };
}

function inferManuscriptQualityStopReasonCategory(
  decision: ManuscriptRepairDecisionCore,
  reviewReliability: "grounded" | "partially_grounded" | "degraded"
): ManuscriptRepairDecision["decision_digest"]["stop_reason_category"] {
  if (decision.action === "repair") {
    return "repairable_manuscript_issue";
  }
  if (decision.action === "pass") {
    return "clean_pass";
  }
  if (reviewReliability === "degraded" || reviewReliability === "partially_grounded") {
    if (
      /review artifact remained degraded|review artifact remained partially grounded|cannot be accepted silently/iu.test(
        decision.stop_or_continue_reason
      )
    ) {
      return "review_reliability";
    }
  }
  if (/out-of-scope locations|bounded local repair loop stops/iu.test(decision.stop_or_continue_reason)) {
    return "locality_violation";
  }
  if (
    decision.triggered_by.some((code) => code.startsWith("appendix_"))
    || /appendix/i.test(decision.stop_or_continue_reason)
  ) {
    return "policy_hard_stop";
  }
  if (
    decision.triggered_by.includes("visual_caption_overclaim")
    || /visual caption|changed visual|visual surfaces/iu.test(decision.stop_or_continue_reason)
  ) {
    return "visual_overclaim";
  }
  if (/Scientific or submission validation/iu.test(decision.stop_or_continue_reason)) {
    return "upstream_scientific_or_submission_failure";
  }
  if (/repeated/iu.test(decision.stop_or_continue_reason)) {
    return "repeated_issue";
  }
  if (/did not show a reliable quality improvement/iu.test(decision.stop_or_continue_reason)) {
    return "no_improvement";
  }
  if (/too broad|third manuscript repair pass is forbidden/iu.test(decision.stop_or_continue_reason)) {
    return "scope_too_broad";
  }
  if (reviewReliability === "partially_grounded" || reviewReliability === "degraded") {
    return "review_reliability";
  }
  return "repairable_manuscript_issue";
}

function buildManuscriptQualityGateSummaryLines(input: {
  decision: ManuscriptRepairDecisionCore;
  reviewReliability: "grounded" | "partially_grounded" | "degraded";
}): string[] {
  const digest = buildManuscriptQualityGateDecisionDigest(input);
  const beforeTotal = input.decision.issues_before.length;
  const beforeFail = input.decision.issues_before.filter((issue) => issue.severity === "fail").length;
  const afterIssues = input.decision.issues_after;
  const lines = [
    `Action: ${input.decision.action}.`,
    input.decision.pass_index === 0
      ? "Decision stage: initial manuscript-quality gate."
      : `Decision stage: post-repair gate after pass ${input.decision.pass_index}.`,
    `Decision reason: ${input.decision.stop_or_continue_reason}`,
    `Review reliability: ${input.reviewReliability}.`,
    `Reason category: ${digest.stop_reason_category}.`,
    `Issues before: ${beforeTotal} total (${beforeFail} fail).`
  ];
  if (afterIssues) {
    const afterFail = afterIssues.filter((issue) => issue.severity === "fail").length;
    lines.push(`Issues after: ${afterIssues.length} total (${afterFail} fail).`);
  }
  if (typeof input.decision.improvement_detected === "boolean") {
    lines.push(`Improvement detected: ${input.decision.improvement_detected ? "yes" : "no"}.`);
  }
  lines.push(
    `Allowed max repairs: ${input.decision.allowed_max_passes}; remaining allowed repairs: ${input.decision.remaining_allowed_repairs}.`
  );
  if (input.decision.triggered_by.length > 0) {
    lines.push(`Triggered by: ${input.decision.triggered_by.join(", ")}.`);
  }
  return lines;
}

function buildRepairVerificationFindings(
  verification: ManuscriptRepairVerificationArtifact
): ManuscriptRepairReport["verification_findings"] {
  const findings: ManuscriptRepairReport["verification_findings"] = [];
  if (verification.out_of_scope_changes.length > 0) {
    findings.push({
      code: "out_of_scope_change",
      severity: "fail",
      location_keys: verification.out_of_scope_changes,
      message: "The repair modified locations outside the bounded local repair plan."
    });
  }
  const nonConservativeCaptionChecks = verification.visual_caption_checks.filter((check) => !check.conservative);
  if (nonConservativeCaptionChecks.length > 0) {
    findings.push({
      code: "visual_caption_overclaim",
      severity: "fail",
      location_keys: nonConservativeCaptionChecks.map((check) => check.location_key),
      message: "The repaired manuscript still contains changed visual captions that overstate the takeaway.",
      concerns: uniqueStrings(nonConservativeCaptionChecks.flatMap((check) => check.concerns))
    });
  }
  const nonConservativeLabelChecks = verification.visual_label_checks.filter((check) => !check.conservative);
  if (nonConservativeLabelChecks.length > 0) {
    findings.push({
      code: "visual_label_overclaim",
      severity: "fail",
      location_keys: nonConservativeLabelChecks.map((check) => check.location_key),
      message: "The repaired manuscript still contains changed visual labels that overstate the takeaway.",
      concerns: uniqueStrings(nonConservativeLabelChecks.flatMap((check) => check.concerns))
    });
  }
  return findings;
}

async function clearStaleManuscriptQualityFailureArtifact(run: Parameters<typeof writeRunArtifact>[0]): Promise<void> {
  await fs.rm(path.join(runArtifactsDir(run), "paper", "manuscript_quality_failure.json"), { force: true });
}

function buildManuscriptQualityFailureArtifact(input: {
  decision: ManuscriptRepairDecision;
  lint: ManuscriptStyleLintArtifact;
  reviewValidation: ManuscriptReviewValidationArtifact;
  reviewAudit: ManuscriptReviewAuditArtifact;
}): ManuscriptQualityFailureArtifact {
  const reviewReliability = resolveReviewArtifactReliability(input.reviewValidation, input.reviewAudit);
  const lintFindings = input.lint.issues.map((issue) => ({
    code: issue.code,
    section: issue.section,
    severity: issue.severity,
    gate_role: issue.gate_role,
    coverage_status: issue.coverage_status,
    covered_by_review_issue_code: issue.covered_by_review_issue_code,
    location_keys: issue.location_keys
  }));
  const reviewerMissedPolicyFindings = lintFindings
    .filter((issue) => issue.gate_role === "hard_stop")
    .map((issue) => ({
      code: issue.code,
      section: issue.section,
      severity: issue.severity,
      gate_role: "hard_stop" as const,
      location_keys: issue.location_keys
    }));
  const reviewerCoveredBackstopFindings = lintFindings
    .filter((issue) => issue.gate_role === "backstop_only")
    .map((issue) => ({
      code: issue.code,
      section: issue.section,
      severity: issue.severity,
      gate_role: "backstop_only" as const,
      covered_by_review_issue_code: issue.covered_by_review_issue_code,
      location_keys: issue.location_keys
    }));
  return {
    generated_at: new Date().toISOString(),
    reason: input.decision.stop_or_continue_reason,
    decision_digest: input.decision.decision_digest,
    summary_lines: buildManuscriptQualityFailureSummaryLines({
      decision: input.decision,
      reviewReliability,
      reviewerMissedPolicyFindings,
      reviewerCoveredBackstopFindings
    }),
    triggered_by: input.decision.triggered_by,
    review_reliability: reviewReliability,
    final_issues: input.decision.issues_after || input.decision.issues_before,
    lint_findings: lintFindings,
    reviewer_missed_policy_findings: reviewerMissedPolicyFindings,
    reviewer_covered_backstop_findings: reviewerCoveredBackstopFindings
  };
}

function buildManuscriptQualityFailureSummaryLines(input: {
  decision: ManuscriptRepairDecision;
  reviewReliability: "grounded" | "partially_grounded" | "degraded";
  reviewerMissedPolicyFindings: ManuscriptQualityFailureArtifact["reviewer_missed_policy_findings"];
  reviewerCoveredBackstopFindings: ManuscriptQualityFailureArtifact["reviewer_covered_backstop_findings"];
}): string[] {
  const lines = [
    `Stop reason: ${input.decision.stop_or_continue_reason}`,
    `Review reliability: ${input.reviewReliability}.`
  ];
  if (input.reviewerMissedPolicyFindings.length > 0) {
    lines.push(
      `${input.reviewerMissedPolicyFindings.length} deterministic hard-stop finding(s) remained outside reviewer coverage.`
    );
  }
  if (input.reviewerCoveredBackstopFindings.length > 0) {
    lines.push(
      `${input.reviewerCoveredBackstopFindings.length} deterministic finding(s) remained as reviewer-covered backstops.`
    );
  }
  if (input.decision.triggered_by.length > 0) {
    lines.push(`Triggered by: ${input.decision.triggered_by.join(", ")}.`);
  }
  return lines;
}

async function writeRoundArtifact(
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"],
  basePath: string,
  roundIndex: number,
  payload: unknown
): Promise<void> {
  await writeRunArtifact(run, `${basePath}_round_${roundIndex}.json`, `${JSON.stringify(payload, null, 2)}\n`);
}

async function writeRoundTextArtifact(
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"],
  basePath: string,
  roundIndex: number,
  text: string
): Promise<void> {
  await writeRunArtifact(run, `${basePath}_round_${roundIndex}.raw.txt`, `${text}\n`);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value && value.trim().length > 0))];
}

function dedupeCorpusRowsById<T extends { paper_id: string }>(rows: T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) {
    if (!byId.has(row.paper_id)) {
      byId.set(row.paper_id, row);
    }
  }
  return [...byId.values()];
}

function sanitizeRiskCodeFragment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "item";
}

const CRITICAL_REPEAT_MANUSCRIPT_CODES = new Set([
  "rhetorical_overreach",
  "citation_hygiene",
  "appendix_hygiene",
  "appendix_internal_text",
  "appendix_meta_text",
  "appendix_raw_artifact_reference"
]);

function buildClaimEvidenceTableArtifact(
  evidenceMap: ReturnType<typeof buildPaperEvidenceMap>,
  bundle: PaperWritingBundle
): { generated_at: string; claims: ClaimEvidenceTableRow[] } {
  return {
    generated_at: new Date().toISOString(),
    claims: evidenceMap.claims.map((claim) => {
      const artifactRefs = inferRunArtifactRefsForClaim(claim, bundle);
      const claimArtifactRefs = uniqueStrings([...claim.evidence_ids, ...artifactRefs]);
      const sourceType = classifyClaimEvidenceSourceType(claim.section_heading, claimArtifactRefs, claim.citation_paper_ids);
      const strength = classifyClaimStrength(claimArtifactRefs.length, claim.citation_paper_ids.length);
      return {
        claim_id: claim.claim_id,
        statement: claim.statement,
        section_heading: claim.section_heading,
        evidence_source_type: sourceType,
        artifact_refs: claimArtifactRefs,
        citation_refs: claim.citation_paper_ids,
        strength,
        ...(strength === "low"
          ? { downgrade_note: "Claim support is weak and should remain conservative." }
          : {})
      };
    })
  };
}

function attachRunArtifactRefsToEvidenceMap(
  evidenceMap: ReturnType<typeof buildPaperEvidenceMap>,
  bundle: PaperWritingBundle
): ReturnType<typeof buildPaperEvidenceMap> {
  return {
    sections: evidenceMap.sections,
    claims: evidenceMap.claims.map((claim) => {
      const artifactRefs = inferRunArtifactRefsForClaim(claim, bundle);
      return artifactRefs.length > 0
        ? {
            ...claim,
            evidence_ids: uniqueStrings([...claim.evidence_ids, ...artifactRefs])
          }
        : claim;
    })
  };
}

function buildClaimStatusTableArtifact(input: {
  evidenceMap: ReturnType<typeof buildPaperEvidenceMap>;
  traceability: PaperTraceabilityReport;
  verifiedRegistry: VerifiedRegistryArtifact;
  bundle: PaperWritingBundle;
}): ClaimStatusTableArtifact {
  const traceabilityByClaimId = new Map<string, PaperTraceabilityReport["paragraphs"]>();
  const registryByCitationPaperId = new Map(
    input.verifiedRegistry.entries.map((entry) => [entry.citation_paper_id, entry] as const)
  );
  for (const paragraph of input.traceability.paragraphs) {
    for (const claimId of paragraph.claim_ids || []) {
      const existing = traceabilityByClaimId.get(claimId) || [];
      existing.push(paragraph);
      traceabilityByClaimId.set(claimId, existing);
    }
  }

  const claims = input.evidenceMap.claims.map((claim) => {
    const traceEntries = traceabilityByClaimId.get(claim.claim_id) || [];
    const artifactRefs = uniqueStrings([
      ...claim.evidence_ids,
      ...inferRunArtifactRefsForClaim(claim, input.bundle)
    ]);
    const citationStatuses = claim.citation_paper_ids
      .map((citationPaperId) => registryByCitationPaperId.get(citationPaperId))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => ({
        citation_paper_id: entry.citation_paper_id,
        resolved_paper_id: entry.resolved_paper_id,
        status: entry.status,
        repaired: entry.repaired
      }));
    const usableCitationSupport = citationStatuses.some((entry) => entry.status !== "blocked");
    const blockedCitationSupport = citationStatuses.filter((entry) => entry.status === "blocked");
    const weakCitationSupport = citationStatuses.filter(
      (entry) => entry.status === "unverified" || entry.status === "inferred"
    );
    const primarySourcePresent = usableCitationSupport || artifactRefs.length > 0;
    const runArtifactPresent = artifactRefs.length > 0;
    const reproductionTracePresent = traceEntries.length > 0;
    const notes: string[] = [];
    let status: ClaimEvidenceStatus;

    if (blockedCitationSupport.length > 0) {
      notes.push(
        `Blocked citation source(s): ${blockedCitationSupport.map((entry) => entry.citation_paper_id).join(", ")}.`
      );
    }
    if (weakCitationSupport.length > 0) {
      notes.push(
        `Weak citation source(s): ${weakCitationSupport
          .map((entry) => `${entry.citation_paper_id}:${entry.status}`)
          .join(", ")}.`
      );
    }

    if (primarySourcePresent && runArtifactPresent && reproductionTracePresent && blockedCitationSupport.length === 0) {
      status = "verified";
    } else if (primarySourcePresent && reproductionTracePresent && blockedCitationSupport.length === 0) {
      status = "inferred";
      notes.push("Primary source and traceability exist, but no run artifact is directly attached to this claim.");
    } else if (runArtifactPresent && reproductionTracePresent) {
      status = blockedCitationSupport.length > 0 ? "unverified" : "inferred";
      if (blockedCitationSupport.length > 0) {
        notes.push("Run artifacts support the claim, but one or more literature citations remain blocked.");
      }
    } else if (primarySourcePresent || runArtifactPresent || reproductionTracePresent) {
      status = "unverified";
      if (!primarySourcePresent) {
        notes.push("Primary source coverage is incomplete.");
      }
      if (!reproductionTracePresent) {
        notes.push("No traceability paragraph could be linked back to this claim.");
      }
    } else {
      status = "blocked";
      notes.push("The claim has neither traceability nor concrete source support.");
    }

    return {
      claim_id: claim.claim_id,
      statement: claim.statement,
      section_heading: claim.section_heading,
      status,
      primary_source_present: primarySourcePresent,
      run_artifact_present: runArtifactPresent,
      reproduction_trace_present: reproductionTracePresent,
      artifact_refs: artifactRefs,
      citation_refs: claim.citation_paper_ids,
      claim_ids_in_trace: traceEntries.flatMap((entry) => entry.claim_ids || []).filter(Boolean),
      citation_statuses: citationStatuses,
      notes
    };
  });

  return {
    generated_at: new Date().toISOString(),
    counts: {
      verified: claims.filter((claim) => claim.status === "verified").length,
      unverified: claims.filter((claim) => claim.status === "unverified").length,
      blocked: claims.filter((claim) => claim.status === "blocked").length,
      inferred: claims.filter((claim) => claim.status === "inferred").length
    },
    claims
  };
}

function inferRunArtifactRefsForClaim(
  claim: PaperDraftClaim,
  bundle: PaperWritingBundle
): string[] {
  const sectionHeading = claim.section_heading.toLowerCase();
  const text = `${claim.section_heading} ${claim.statement}`.toLowerCase();
  const experimentSection = /method|result|discussion|limitation|conclusion|appendix/iu.test(sectionHeading);
  const unlinkedExperimentClaim =
    claim.evidence_ids.length === 0
    && claim.citation_paper_ids.length === 0
    && /this study|present study|experiment|run|metric|result|objective|condition|seed|parameter|factor|model|dataset/iu.test(text);
  if (!experimentSection && !unlinkedExperimentClaim) {
    return [];
  }

  const refs: string[] = [];
  const hasResultAnalysis = Boolean(bundle.resultAnalysis);
  const hasExperimentPlan = Boolean(bundle.experimentPlan?.rawText || bundle.experimentPlan?.selectedTitle);
  const resultLike =
    /result|metric|difference|confidence|interval|ci\b|uncertainty|seed|task|condition|parameter|factor|runtime|memory|completed|failed|objective|improvement|inconclusive|promising|feasibility|preflight|continuation|generalization|study scope|supplemental artifact|compute-side|compute budget/iu.test(text);
  const methodLike =
    /method|protocol|design|dataset|model|backbone|seed|condition|parameter|factor|harness|preprocess|token|budget|reproducib|run identifier|command line/iu.test(text);
  const runStateLike =
    /completed|failed|run visibility|failed attempts|execution status|run identifier|command line|environment|reproducib/iu.test(text);

  if (hasExperimentPlan && methodLike) {
    refs.push("experiment_plan.yaml");
  }
  if (hasResultAnalysis && resultLike) {
    refs.push("result_analysis.json");
  }
  if (runStateLike || (hasResultAnalysis && /completed|failed|training runs?|cells?|seeds?/i.test(text))) {
    refs.push("run_record.json");
  }

  return uniqueStrings(refs);
}

function buildEvidenceGateDecisionArtifact(
  claimStatusTable: ClaimStatusTableArtifact
): EvidenceGateDecisionArtifact {
  const issues: EvidenceGateIssue[] = [];
  for (const claim of claimStatusTable.claims) {
    if (claim.status === "blocked") {
      issues.push({
        severity: "fail",
        code: "claim_evidence_blocked",
        claim_id: claim.claim_id,
        section_heading: claim.section_heading,
        message: `Claim ${claim.claim_id} in ${claim.section_heading} has no usable evidence/traceability support.`,
        fix_recommendation: "Link the claim to concrete evidence or remove/rewrite it before paper acceptance."
      });
      continue;
    }
    if (claim.status === "unverified") {
      issues.push({
        severity: "warning",
        code: "claim_evidence_unverified",
        claim_id: claim.claim_id,
        section_heading: claim.section_heading,
        message: `Claim ${claim.claim_id} in ${claim.section_heading} is only partially grounded.`,
        fix_recommendation: "Add the missing source or traceability link, or weaken the claim wording."
      });
      continue;
    }
    if (claim.status === "inferred") {
      issues.push({
        severity: "warning",
        code: "claim_evidence_inferred",
        claim_id: claim.claim_id,
        section_heading: claim.section_heading,
        message: `Claim ${claim.claim_id} in ${claim.section_heading} is inferential and should stay conservative.`,
        fix_recommendation: "Keep the rhetoric explicitly inferential or add direct run-artifact support."
      });
    }
  }

  const blockingIssueCount = issues.filter((issue) => issue.severity === "fail").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return {
    generated_at: new Date().toISOString(),
    status: blockingIssueCount > 0 ? "fail" : warningCount > 0 ? "warn" : "pass",
    blocking_issue_count: blockingIssueCount,
    warning_count: warningCount,
    issues,
    summary_lines:
      issues.length === 0
        ? ["All major claims remain grounded within the available evidence ceiling."]
        : [
            `Claim evidence statuses: verified=${claimStatusTable.counts.verified}, inferred=${claimStatusTable.counts.inferred}, unverified=${claimStatusTable.counts.unverified}, blocked=${claimStatusTable.counts.blocked}.`,
            ...issues.slice(0, 3).map((issue) => issue.message)
          ]
  };
}

function buildPaperReadinessArtifact(input: {
  manuscriptType: ManuscriptType;
  preDraftManuscriptType?: ManuscriptType;
  claimCeilingApplied?: boolean;
  overallScore?: number;
  evidenceGateDecision: EvidenceGateDecisionArtifact;
  claimStatusTable: ClaimStatusTableArtifact;
  citationReport: CitationReport;
  referenceAuthorityGate: ReferenceAuthorityGateArtifact;
  scientificGateStatus: "pass" | "warn" | "fail";
  submissionValidationOk: boolean;
  manuscriptQualityAction: ManuscriptRepairDecision["action"];
  compileStatus?: PaperCompileResult["status"];
  compiledPageValidationStatus?: CompiledPdfPageValidationReport["status"];
  renderValidationStatus?: PaperRenderValidationReport["status"];
}): PaperReadinessArtifact {
  const claimCeilingApplied = input.claimCeilingApplied === true;
  const compileFailed = input.compileStatus === "failed";
  const compiledPageValidationFailed = input.compiledPageValidationStatus === "fail";
  const renderValidationFailed = input.renderValidationStatus === "fail";
  const paperReady =
    input.manuscriptType === "paper_ready"
    && !claimCeilingApplied
    && input.evidenceGateDecision.status !== "fail"
    && input.citationReport.status !== "fail"
    && input.referenceAuthorityGate.status === "pass"
    && input.scientificGateStatus !== "fail"
    && input.submissionValidationOk
    && input.manuscriptQualityAction !== "stop"
    && !compileFailed
    && !compiledPageValidationFailed
    && !renderValidationFailed;
  const triggeredBy = [
    ...(input.evidenceGateDecision.status === "fail" ? ["evidence_gate"] : []),
    ...(input.citationReport.status === "fail" ? ["citation_check"] : []),
    ...(input.referenceAuthorityGate.status !== "pass" ? ["reference_authority_gate"] : []),
    ...(input.scientificGateStatus === "fail" ? ["scientific_validation"] : []),
    ...(!input.submissionValidationOk ? ["submission_validation"] : []),
    ...(input.manuscriptQualityAction === "stop" ? ["manuscript_quality"] : []),
    ...(compileFailed ? ["compile"] : []),
    ...(compiledPageValidationFailed ? ["compiled_page_validation"] : []),
    ...(renderValidationFailed ? ["render_validation"] : []),
    ...(claimCeilingApplied ? ["claim_ceiling"] : [])
  ];
  return {
    generated_at: new Date().toISOString(),
    paper_ready: paperReady,
    readiness_state: paperReady ? "paper_ready" : input.manuscriptType,
    pre_draft_manuscript_type: input.preDraftManuscriptType,
    claim_ceiling_applied: claimCeilingApplied,
    overall_score: typeof input.overallScore === "number" ? input.overallScore : undefined,
    citation_check: input.citationReport.status,
    reference_authority_gate: input.referenceAuthorityGate,
    reason: paperReady
      ? "The manuscript passed manuscript-quality, evidence, scientific, and submission gates."
      : input.manuscriptQualityAction === "stop"
        ? "paper_ready is blocked because the manuscript-quality gate stopped bounded repair."
      : claimCeilingApplied
        ? "paper_ready is blocked because the pre-draft review claim ceiling classified the evidence below paper-ready."
      : input.citationReport.status === "fail"
        ? "citation_gap"
      : input.referenceAuthorityGate.status !== "pass"
        ? `paper_ready is blocked because ${input.referenceAuthorityGate.reason}.`
      : input.evidenceGateDecision.status === "fail"
        ? "paper_ready is blocked because at least one major claim remained blocked at the evidence gate."
      : !input.submissionValidationOk
        ? "paper_ready is blocked because submission validation failed."
      : input.scientificGateStatus === "fail"
        ? "paper_ready is blocked because the scientific validation gate failed."
      : compileFailed
        ? "paper_ready is blocked because PDF compilation failed."
      : compiledPageValidationFailed
        ? "paper_ready is blocked because the compiled PDF failed page-budget validation."
      : renderValidationFailed
        ? "paper_ready is blocked because rendered manuscript validation failed."
        : `paper_ready remains ${input.manuscriptType} after post-draft critique.`,
    triggered_by: triggeredBy,
    evidence_gate_status: input.evidenceGateDecision.status,
    scientific_validation_status: input.scientificGateStatus,
    submission_validation_ok: input.submissionValidationOk,
    manuscript_quality_action: input.manuscriptQualityAction,
    compile_status: input.compileStatus,
    compiled_page_validation_status: input.compiledPageValidationStatus,
    render_validation_status: input.renderValidationStatus,
    claim_status_counts: input.claimStatusTable.counts
  };
}

function buildPaperReadinessRiskArtifact(input: {
  manuscriptType: ManuscriptType;
  paperReadiness: PaperReadinessArtifact;
  verifiedRegistry: VerifiedRegistryArtifact;
  claimStatusTable: ClaimStatusTableArtifact;
  evidenceGateDecision: EvidenceGateDecisionArtifact;
  scientificGateStatus: "pass" | "warn" | "fail";
  submissionValidationOk: boolean;
  manuscriptQualityAction: ManuscriptRepairDecision["action"];
  compileStatus?: PaperCompileResult["status"];
  compiledPageValidation?: CompiledPdfPageValidationReport;
  renderValidation?: PaperRenderValidationReport;
  config: NodeExecutionDeps["config"];
}): ReadinessRiskArtifact {
  const risks: ReadinessRisk[] = buildNetworkDependencyReadinessRisks({
    source: "paper",
    networkPolicy: input.config.experiments?.network_policy,
    networkPurpose: input.config.experiments?.network_purpose,
    executionApprovalMode: input.config.workflow?.execution_approval_mode
  });

  if (input.paperReadiness.reference_authority_gate.status !== "pass") {
    risks.push({
      risk_code: "reference_authority_gate_not_passed",
      severity: "blocked",
      category: "citation_source",
      status: "blocked",
      message: `The authoritative reference gate is not closed: ${input.paperReadiness.reference_authority_gate.reason}.`,
      triggered_by: ["reference_authority_gate"],
      affected_claim_ids: [],
      affected_citation_ids: [],
      recommended_action: "Complete independent claim-level full-text review and rerun the authoritative reference submission gate.",
      recheck_condition: "reference_authority_gate.json reports status=pass with submission_gate_passed=true and no unchecked Refgate claims."
    });
  }

  for (const entry of input.verifiedRegistry.entries) {
    if (entry.status !== "blocked" && entry.status !== "unverified") {
      continue;
    }
    risks.push({
      risk_code: `citation_source_${entry.status}_${sanitizeRiskCodeFragment(entry.citation_paper_id)}`,
      severity: entry.status === "blocked" ? "blocked" : "warning",
      category: "citation_source",
      status: entry.status,
      message:
        entry.status === "blocked"
          ? `Citation source ${entry.citation_paper_id} remained unresolved after bounded verification.`
          : `Citation source ${entry.citation_paper_id} was repaired but remains below fully verified status.`,
      triggered_by: ["verified_registry", "evidence_gate"],
      affected_claim_ids: [],
      affected_citation_ids: [entry.citation_paper_id],
      recommended_action:
        entry.status === "blocked"
          ? "Provide a stable source row or remove the unsupported citation before claiming paper readiness."
          : "Keep the citation wording conservative or promote it to a fully verified source.",
      recheck_condition:
        entry.status === "blocked"
          ? "A direct corpus source or externally verified locator becomes available for this citation."
          : "The repaired citation is replaced with a direct corpus-backed or fully verified source."
    });
  }

  for (const claim of input.claimStatusTable.claims) {
    if (claim.status !== "blocked" && claim.status !== "unverified") {
      continue;
    }
    risks.push({
      risk_code: `claim_evidence_${claim.status}_${sanitizeRiskCodeFragment(claim.claim_id)}`,
      severity: claim.status === "blocked" ? "blocked" : "warning",
      category: "claim_evidence",
      status: claim.status,
      message:
        claim.status === "blocked"
          ? `Claim ${claim.claim_id} in ${claim.section_heading} lacks enough usable evidence or traceability for paper readiness.`
          : `Claim ${claim.claim_id} in ${claim.section_heading} remains only partially grounded.`,
      triggered_by: ["claim_status_table", "evidence_gate"],
      affected_claim_ids: [claim.claim_id],
      affected_citation_ids: claim.citation_refs,
      recommended_action:
        claim.status === "blocked"
          ? "Add concrete evidence and traceability, or remove/rewrite the claim."
          : "Add the missing source support or weaken the claim wording further.",
      recheck_condition:
        claim.status === "blocked"
          ? "The claim gains concrete evidence and traceability links."
          : "The claim is re-linked to verified evidence or downgraded enough to remove the grounding gap."
    });
  }

  if (input.scientificGateStatus === "fail") {
    risks.push({
      risk_code: "scientific_validation_fail",
      severity: "blocked",
      category: "scientific_validation",
      status: "blocked",
      message: "Scientific validation failed, so the manuscript cannot be treated as paper-ready.",
      triggered_by: ["scientific_validation"],
      affected_claim_ids: [],
      affected_citation_ids: [],
      recommended_action: "Address the scientific validation failures before treating the manuscript as paper-scale.",
      recheck_condition: "Scientific validation returns pass or warn without blocking issues."
    });
  }

  if (!input.submissionValidationOk) {
    risks.push({
      risk_code: "submission_validation_fail",
      severity: "blocked",
      category: "submission_validation",
      status: "blocked",
      message: "Submission validation failed, so the paper bundle is not yet safe to hand off as paper-ready.",
      triggered_by: ["submission_validation"],
      affected_claim_ids: [],
      affected_citation_ids: [],
      recommended_action: "Resolve the submission validation errors before final paper handoff.",
      recheck_condition: "Submission validation passes cleanly."
    });
  }

  if (input.manuscriptQualityAction === "stop") {
    risks.push({
      risk_code: "manuscript_quality_stop",
      severity: "blocked",
      category: "manuscript_quality",
      status: "blocked",
      message: "The manuscript-quality loop stopped before acceptance, so readiness remains blocked.",
      triggered_by: ["manuscript_quality"],
      affected_claim_ids: [],
      affected_citation_ids: [],
      recommended_action: "Resolve the remaining manuscript-quality blockers or accept an honest downgrade.",
      recheck_condition: "The manuscript-quality gate passes without a stop decision."
    });
  }

  if (input.compileStatus === "failed") {
    risks.push({
      risk_code: "paper_compile_failed",
      severity: "blocked",
      category: "submission_validation",
      status: "blocked",
      message: "PDF compilation failed, so the paper bundle cannot be treated as final paper-ready output.",
      triggered_by: ["compile_report"],
      affected_claim_ids: [],
      affected_citation_ids: [],
      recommended_action: "Fix the LaTeX/PDF build and rerun compiled page validation before final paper handoff.",
      recheck_condition: "PDF compilation succeeds or is explicitly unavailable under a non-PDF handoff policy."
    });
  }

  if (input.compiledPageValidation?.status === "fail") {
    risks.push({
      risk_code: "compiled_page_validation_fail",
      severity: "blocked",
      category: "submission_validation",
      status: "blocked",
      message: input.compiledPageValidation.message,
      triggered_by: ["compiled_page_validation"],
      affected_claim_ids: [],
      affected_citation_ids: [],
      recommended_action: "Expand or re-layout the paper through the normal writing pipeline until the compiled PDF meets the configured page floor.",
      recheck_condition: "compiled_page_validation.json reports status=pass."
    });
  }

  if (input.renderValidation?.status === "fail") {
    risks.push({
      risk_code: "paper_render_validation_fail",
      severity: "blocked",
      category: "submission_validation",
      status: "blocked",
      message: input.renderValidation.summary[0] || "Rendered manuscript validation failed.",
      triggered_by: ["render_validation"],
      affected_claim_ids: [],
      affected_citation_ids: [],
      recommended_action: "Repair the rendered paper surface, including author/template/citation/figure/table/page-budget blockers, before final paper handoff.",
      recheck_condition: "paper/render_validation.json reports status=pass."
    });
  }

  if (input.manuscriptType !== "paper_ready") {
    const blocked = input.manuscriptType === "blocked_for_paper_scale";
    risks.push({
      risk_code: `paper_scale_${sanitizeRiskCodeFragment(input.manuscriptType)}`,
      severity: blocked ? "blocked" : "warning",
      category: "paper_scale",
      status: blocked ? "blocked" : "unverified",
      message: blocked
        ? "The post-draft critique still classifies the run as blocked for paper scale."
        : `The post-draft critique still classifies the run as ${input.manuscriptType}, not paper_ready.`,
      triggered_by: ["paper_critique", ...input.paperReadiness.triggered_by],
      affected_claim_ids: [],
      affected_citation_ids: [],
      recommended_action: blocked
        ? "Backtrack or downgrade rather than presenting the current manuscript as paper-ready."
        : "Keep the manuscript explicitly downgraded until stronger evidence or critique outcomes are available.",
      recheck_condition: "The post-draft critique classifies the manuscript as paper_ready."
    });
  }

  return buildReadinessRiskArtifact({
    paperReady: input.paperReadiness.paper_ready,
    readinessState: input.paperReadiness.readiness_state,
    risks
  });
}

function buildFallbackPaperReadinessRiskArtifact(input: {
  preDraftCritique: PaperCritique | null;
  verifiedRegistry: VerifiedRegistryArtifact;
  claimStatusTable: ClaimStatusTableArtifact;
  evidenceGateDecision: EvidenceGateDecisionArtifact;
  citationReport?: CitationReport;
  referenceAuthorityGate?: ReferenceAuthorityGateArtifact;
  scientificGateStatus: "pass" | "warn" | "fail";
  submissionValidationOk: boolean;
  manuscriptQualityAction: ManuscriptRepairDecision["action"];
  config: NodeExecutionDeps["config"];
}): ReadinessRiskArtifact {
  const manuscriptType = resolveFallbackReadinessState(input);
  const paperReadiness = buildPaperReadinessArtifact({
    manuscriptType,
    overallScore: input.preDraftCritique?.overall_score,
    evidenceGateDecision: input.evidenceGateDecision,
    claimStatusTable: input.claimStatusTable,
    citationReport: input.citationReport ?? {
      orphan_citations: [],
      unchecked_sources: [],
      rendered_citations: [],
      bibliography_entries: [],
      missing_rendered_citations: [],
      status: "pass"
    },
    referenceAuthorityGate: input.referenceAuthorityGate ?? missingReferenceAuthorityGate(),
    scientificGateStatus: input.scientificGateStatus,
    submissionValidationOk: input.submissionValidationOk,
    manuscriptQualityAction: input.manuscriptQualityAction
  });
  return buildPaperReadinessRiskArtifact({
    manuscriptType,
    paperReadiness,
    verifiedRegistry: input.verifiedRegistry,
    claimStatusTable: input.claimStatusTable,
    evidenceGateDecision: input.evidenceGateDecision,
    scientificGateStatus: input.scientificGateStatus,
    submissionValidationOk: input.submissionValidationOk,
    manuscriptQualityAction: input.manuscriptQualityAction,
    config: input.config
  });
}

function missingReferenceAuthorityGate(): ReferenceAuthorityGateArtifact {
  return {
    status: "fail",
    status_ref: "paper/reference_evidence_status.json",
    claims_ref: "paper/refgate_claims.tsv",
    manuscript_ref: "paper/main.tex",
    human_authority_ref: "paper/reference-claim-review-import.json",
    status_present: false,
    claims_present: false,
    manuscript_present: false,
    manuscript_projection_present: false,
    manuscript_projection_valid: false,
    manuscript_bound: false,
    human_authority_required: false,
    human_authority_present: false,
    human_authority_valid: false,
    human_authority_artifacts_bound: false,
    human_identity_verification_valid: false,
    status_sha256: null,
    claims_sha256: null,
    manuscript_sha256: null,
    authoritative_manuscript_sha256: null,
    human_authority_sha256: null,
    submission_gate_passed: false,
    citation_bearing_claim_count: null,
    independently_checked_claim_count: null,
    inventory_claim_count: null,
    unchecked_claim_count: null,
    missing_full_text_claim_count: null,
    blocking_requirement_count: null,
    reason: "authoritative reference evidence status and Refgate claim inventory are missing"
  };
}

function resolveFallbackReadinessState(input: {
  preDraftCritique: PaperCritique | null;
  evidenceGateDecision: EvidenceGateDecisionArtifact;
  scientificGateStatus: "pass" | "warn" | "fail";
  submissionValidationOk: boolean;
  manuscriptQualityAction: ManuscriptRepairDecision["action"];
}): ManuscriptType {
  const critiqueType = input.preDraftCritique?.manuscript_type;
  if (
    input.manuscriptQualityAction === "stop"
    || input.evidenceGateDecision.status === "fail"
    || input.scientificGateStatus === "fail"
    || !input.submissionValidationOk
  ) {
    if (critiqueType === "system_validation_note" || critiqueType === "research_memo") {
      return critiqueType;
    }
    return "blocked_for_paper_scale";
  }
  return critiqueType ?? "paper_scale_candidate";
}

function classifyClaimEvidenceSourceType(
  sectionHeading: string,
  evidenceIds: string[],
  citationPaperIds: string[]
): ClaimEvidenceTableRow["evidence_source_type"] {
  if (/limit/i.test(sectionHeading)) {
    return "limitation";
  }
  if (evidenceIds.length > 0) {
    return "experiment";
  }
  if (citationPaperIds.length > 0) {
    return "literature";
  }
  return "qualitative_observation";
}

function classifyClaimStrength(
  evidenceCount: number,
  citationCount: number
): ClaimEvidenceTableRow["strength"] {
  if (evidenceCount > 0 && citationCount > 0) {
    return "high";
  }
  if (evidenceCount > 0 || citationCount > 0) {
    return "medium";
  }
  return "low";
}

function buildManuscriptQualityFailureError(report: ManuscriptRepairDecision): string {
  return `write_paper generated manuscript artifacts but stopped before scientific/submission acceptance because the manuscript-quality gate failed: ${report.stop_or_continue_reason}`;
}

function buildEvidenceGateFailureError(report: EvidenceGateDecisionArtifact): string {
  const lead = report.issues[0]?.message || "claim evidence gate failed";
  return `write_paper generated manuscript artifacts but stopped before scientific/submission acceptance because the evidence gate failed: ${lead}`;
}

function buildPaperFigureManifest(input: {
  manuscript: PaperManuscript;
  runTitle: string;
  topic: string;
}): PaperFigureManifest {
  const resultFigures: PaperFigureManifestEntry[] = (input.manuscript.figures || []).map((figure, index) => ({
    id: `main-result-figure-${index + 1}`,
    kind: "result_chart",
    caption: figure.caption,
    source_refs: (figure.source_refs || []).map((ref) => `${ref.kind}:${ref.id}`),
    included_in_main_body: true,
    status: "rendered",
    audit_status: "pending"
  }));
  const conceptualPrompt = buildConceptualDiagramPrompt(input);
  const conceptualEntry: PaperFigureManifestEntry = {
    id: "conceptual-diagram-1",
    kind: "conceptual_diagram",
    caption: "Conceptual overview of the governed experiment protocol.",
    source_refs: ["brief:topic", "experiment:design", "workflow:figure_audit"],
    included_in_main_body: false,
    status: "needs_generation",
    audit_status: "pending",
    prompt_path: "paper/figures/concept_diagram_prompt.json"
  };
  return {
    generated_at: new Date().toISOString(),
    figures: [...resultFigures, conceptualEntry],
    conceptual_diagram_prompt: conceptualPrompt
  };
}

export function buildWritePaperFigurePayload(
  manuscript: PaperManuscript,
  contract: WritePaperResultsContract
): {
  figures: Array<{
    id: string;
    output_pdf: string;
    caption: string;
    metric: ResultsMetricDefinitionV2 & { unit: string };
    comparison: ResultsComparisonV2;
    bars: Array<{
      label: string;
      value: number;
      comparison_id: string;
      observation_id: string;
      metric_id: string;
      series_id: string;
      series_role: ResultsSeriesRole;
      comparison_side: "subject" | "reference";
    }>;
  }>;
} {
  const primary = contract.primary;
  return {
    figures: (manuscript.figures || []).map((figure, index) => {
      if (hasAmbiguousFigureMetricSemantics(figure)) {
        throw new Error(
          `figure ${index + 1} must declare one metric id and complete comparison metadata on every bar`
        );
      }
      if (figure.bars.length !== 2) {
        throw new Error(
          `figure ${index + 1} must contain exactly the linked subject and reference observations`
        );
      }
      const subjectRow = figure.bars.find((row) => row.comparison_side === "subject");
      const referenceRow = figure.bars.find((row) => row.comparison_side === "reference");
      if (!subjectRow || !referenceRow) {
        throw new Error(
          `figure ${index + 1} must identify one subject bar and one reference bar explicitly`
        );
      }
      assertWritePaperFigureRow({
        row: subjectRow,
        expectedSide: "subject",
        expectedObservation: primary.subjectObservation,
        expectedSeries: primary.subjectSeries,
        contract,
        figureIndex: index
      });
      assertWritePaperFigureRow({
        row: referenceRow,
        expectedSide: "reference",
        expectedObservation: primary.referenceObservation,
        expectedSeries: primary.referenceSeries,
        contract,
        figureIndex: index
      });
      const directionLabel = primary.metric.direction === "higher_better"
        ? "higher values preferred"
        : "lower values preferred";
      return {
        id: `main-result-figure-${index + 1}`,
        output_pdf: `main-result-figure-${index + 1}.pdf`,
        caption:
          `${primary.metric.label} for declared comparison ${contract.primaryComparisonId} `
          + `(${directionLabel}; unit: ${primary.metric.unit}).`,
        metric: { ...primary.metric },
        comparison: { ...primary.comparison },
        bars: [
          buildWritePaperFigureBar(
            primary.subjectSeries,
            primary.subjectObservation,
            primary.comparison.id,
            primary.metric.id,
            "subject"
          ),
          buildWritePaperFigureBar(
            primary.referenceSeries,
            primary.referenceObservation,
            primary.comparison.id,
            primary.metric.id,
            "reference"
          )
        ]
      };
    })
  };
}

function assertWritePaperFigureRow(input: {
  row: PaperManuscriptVisualRow;
  expectedSide: "subject" | "reference";
  expectedObservation: ResultsObservationV2;
  expectedSeries: ResultsSeriesV2 & { role: ResultsSeriesRole };
  contract: WritePaperResultsContract;
  figureIndex: number;
}): void {
  const pathPrefix = `figure ${input.figureIndex + 1} ${input.expectedSide} bar`;
  if (input.row.comparison_id !== input.contract.primaryComparisonId) {
    throw new Error(`${pathPrefix} must reference the declared primary comparison id`);
  }
  if (input.row.metric_id !== input.contract.primary.metric.id) {
    throw new Error(`${pathPrefix} must reference the declared metric id`);
  }
  if (input.row.observation_id !== input.expectedObservation.id) {
    throw new Error(`${pathPrefix} must reference the linked observation id`);
  }
  if (input.row.series_id !== input.expectedSeries.id) {
    throw new Error(`${pathPrefix} must reference the linked series id`);
  }
  if (input.row.series_role !== input.expectedSeries.role) {
    throw new Error(`${pathPrefix} must preserve the series role declared by results_artifact`);
  }
  if (input.row.comparison_side !== input.expectedSide) {
    throw new Error(`${pathPrefix} must preserve the explicit comparison side`);
  }
  if (!matchesWritePaperNumericValue(input.row.value, input.expectedObservation.value)) {
    throw new Error(`${pathPrefix} value must match the linked observation value`);
  }
}

function buildWritePaperFigureBar(
  series: ResultsSeriesV2 & { role: ResultsSeriesRole },
  observation: ResultsObservationV2,
  comparisonId: string,
  metricId: string,
  comparisonSide: "subject" | "reference"
): {
  label: string;
  value: number;
  comparison_id: string;
  observation_id: string;
  metric_id: string;
  series_id: string;
  series_role: ResultsSeriesRole;
  comparison_side: "subject" | "reference";
} {
  return {
    label: `${series.label} (${series.role} role, ${comparisonSide})`,
    value: observation.value,
    comparison_id: comparisonId,
    observation_id: observation.id,
    metric_id: metricId,
    series_id: series.id,
    series_role: series.role,
    comparison_side: comparisonSide
  };
}

function matchesWritePaperNumericValue(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * 32 * scale;
}

async function maybeRenderPaperFigureAssets(input: {
  deps: NodeExecutionDeps;
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"];
  manuscript: PaperManuscript;
  resultsContract: WritePaperResultsContract;
  figureManifest: PaperFigureManifest;
  runPaperDir: string;
  publicPaperDir: string;
  abortSignal?: AbortSignal;
  emitLog: (text: string) => void;
}): Promise<PaperFigureManifest> {
  const figures = input.manuscript.figures || [];
  const figuresDir = path.join(input.runPaperDir, "figures");
  const publicFiguresDir = path.join(input.publicPaperDir, "figures");
  await ensureDir(figuresDir);
  await ensureDir(publicFiguresDir);

  const payload = buildWritePaperFigurePayload(input.manuscript, input.resultsContract);
  const expectedRenderedPdfs = new Set(payload.figures.map((figure) => figure.output_pdf));
  await pruneGeneratedPaperFigureAssets(figuresDir, expectedRenderedPdfs);
  await pruneGeneratedPaperFigureAssets(publicFiguresDir, expectedRenderedPdfs);
  if (figures.length === 0) {
    return input.figureManifest;
  }

  await fs.writeFile(path.join(figuresDir, "figure_payload.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(figuresDir, "render_paper_figures.py"), buildPythonVectorFigureRendererScript(), "utf8");

  const command = "python3 render_paper_figures.py";
  input.deps.eventStream.emit({
    type: "TOOL_CALLED",
    runId: input.run.id,
    node: "write_paper",
    payload: {
      command,
      cwd: figuresDir,
      source: "paper_figure_render"
    }
  });
  const obs = await input.deps.aci.runCommand(command, figuresDir, input.abortSignal);
  if (obs.status !== "ok") {
    const error = (obs.stderr || obs.stdout || "Python figure rendering failed").trim();
    input.emitLog(`Python figure rendering failed: ${error}`);
    return {
      ...input.figureManifest,
      figures: input.figureManifest.figures.map((entry) =>
        entry.kind === "result_chart"
          ? {
              ...entry,
              status: "needs_generation",
              render_source: "python_vector_pdf",
              render_status: "fail",
              render_error: error
            }
          : entry
      )
    };
  }

  const copiedIds: string[] = [];
  for (const figure of payload.figures) {
    const sourcePath = path.join(figuresDir, figure.output_pdf);
    if (!(await fileExists(sourcePath))) {
      continue;
    }
    await fs.copyFile(sourcePath, path.join(publicFiguresDir, figure.output_pdf));
    copiedIds.push(figure.id);
  }
  input.emitLog(`Rendered ${copiedIds.length}/${figures.length} paper figure asset(s) with Python.`);

  return {
    ...input.figureManifest,
    figures: input.figureManifest.figures.map((entry) => {
      if (entry.kind !== "result_chart") {
        return entry;
      }
      const outputPath = `figures/${entry.id}.pdf`;
      return {
        ...entry,
        path: outputPath,
        status: copiedIds.includes(entry.id) ? "rendered" : "needs_generation",
        render_source: "python_vector_pdf",
        render_status: copiedIds.includes(entry.id) ? "pass" : "fail",
        ...(!copiedIds.includes(entry.id) ? { render_error: "expected Python-rendered PDF asset was not created" } : {})
      };
    })
  };
}

async function pruneGeneratedPaperFigureAssets(dir: string, expectedFilenames: Set<string>): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => /^main-result-figure-\d+\.pdf$/u.test(name) && !expectedFilenames.has(name))
      .map((name) => fs.unlink(path.join(dir, name)))
  );
}

export function buildPythonVectorFigureRendererScript(): string {
  return String.raw`#!/usr/bin/env python3
import json
import math
import textwrap
from pathlib import Path

SIDE_COLORS = {
    "subject": "#3268B2",
    "reference": "#C86414",
}
PDF_SIDE_COLORS = {
    "subject": (0.196, 0.408, 0.698),
    "reference": (0.784, 0.392, 0.078),
}

def required_string(record, key, path):
    value = record.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{path}.{key} must be a non-empty string")
    return value.strip()

def validate_figure(figure):
    if not isinstance(figure, dict):
        raise ValueError("figure must be an object")
    metric = figure.get("metric")
    comparison = figure.get("comparison")
    bars = figure.get("bars")
    if not isinstance(metric, dict):
        raise ValueError("figure.metric must be an object")
    if not isinstance(comparison, dict):
        raise ValueError("figure.comparison must be an object")
    metric_id = required_string(metric, "id", "figure.metric")
    metric_label = required_string(metric, "label", "figure.metric")
    metric_unit = required_string(metric, "unit", "figure.metric")
    direction = required_string(metric, "direction", "figure.metric")
    if direction not in {"higher_better", "lower_better"}:
        raise ValueError("figure.metric.direction must be higher_better or lower_better")
    comparison_id = required_string(comparison, "id", "figure.comparison")
    if not isinstance(bars, list) or len(bars) != 2:
        raise ValueError("figure.bars must contain exactly two linked observations")

    normalized = []
    observed_sides = set()
    for index, row in enumerate(bars):
        path = f"figure.bars[{index}]"
        if not isinstance(row, dict):
            raise ValueError(f"{path} must be an object")
        side = required_string(row, "comparison_side", path)
        if side not in SIDE_COLORS or side in observed_sides:
            raise ValueError(f"{path}.comparison_side must uniquely identify subject or reference")
        observed_sides.add(side)
        if required_string(row, "comparison_id", path) != comparison_id:
            raise ValueError(f"{path}.comparison_id must match figure.comparison.id")
        if required_string(row, "metric_id", path) != metric_id:
            raise ValueError(f"{path}.metric_id must match figure.metric.id")
        required_string(row, "observation_id", path)
        required_string(row, "series_id", path)
        required_string(row, "series_role", path)
        label = required_string(row, "label", path)
        value = row.get("value")
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise ValueError(f"{path}.value must be a finite number")
        normalized.append({**row, "label": label, "value": float(value), "comparison_side": side})
    if observed_sides != {"subject", "reference"}:
        raise ValueError("figure.bars must include explicit subject and reference sides")
    return {
        "metric_id": metric_id,
        "metric_label": metric_label,
        "metric_unit": metric_unit,
        "direction": direction,
        "comparison_id": comparison_id,
        "bars": normalized,
    }

def axis_label(validated):
    return f"{validated['metric_label']} ({validated['metric_unit']})"

def value_bounds(values):
    lower = min(values + [0.0])
    upper = max(values + [0.0])
    span = upper - lower
    if span <= 0:
        span = max(abs(lower), abs(upper), 1.0)
    padding = span * 0.12
    return lower - padding, upper + padding

def render_with_matplotlib(figure):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return None

    validated = validate_figure(figure)
    bars = validated["bars"]
    values = [row["value"] for row in bars]
    labels = ["\n".join(textwrap.wrap(row["label"], width=25)) for row in bars]
    colors = [SIDE_COLORS[row["comparison_side"]] for row in bars]
    lower, upper = value_bounds(values)
    figure_height = max(2.0, 0.55 * len(bars) + 1.25)
    canvas, axis = plt.subplots(figsize=(3.45, figure_height))
    positions = list(range(len(bars)))
    axis.barh(positions, values, color=colors, height=0.46)
    axis.set_yticks(positions, labels=labels)
    axis.invert_yaxis()
    axis.set_xlim(lower, upper)
    axis.axvline(0.0, color="#333333", linewidth=0.7)
    axis.set_xlabel(axis_label(validated), fontsize=8)
    preference = "higher values preferred" if validated["direction"] == "higher_better" else "lower values preferred"
    axis.set_title(
        f"Declared comparison: {validated['comparison_id']}\n{preference}",
        fontsize=8.5,
        pad=6,
    )
    axis.grid(axis="x", color="#d9d9d9", linewidth=0.6)
    axis.set_axisbelow(True)
    for spine in ["top", "right"]:
        axis.spines[spine].set_visible(False)
    axis.spines["left"].set_linewidth(0.6)
    axis.spines["bottom"].set_linewidth(0.6)
    axis.tick_params(axis="both", labelsize=7, length=2.5, width=0.6)
    offset = (upper - lower) * 0.02
    for position, value in zip(positions, values):
        text_x = value + offset if value >= 0 else value - offset
        alignment = "left" if value >= 0 else "right"
        axis.text(text_x, position, f"{value:.4g}", va="center", ha=alignment, fontsize=7)
    canvas.tight_layout(pad=0.4)
    output = required_string(figure, "output_pdf", "figure")
    canvas.savefig(output, format="pdf", bbox_inches="tight")
    plt.close(canvas)
    return output

def pdf_escape(value):
    return str(value).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

def text_cmd(x, y, text, size=7, color=(0, 0, 0)):
    red, green, blue = color
    return f"{red:.3f} {green:.3f} {blue:.3f} rg BT /F1 {size} Tf {x:.2f} {y:.2f} Td ({pdf_escape(text)}) Tj ET\n"

def rect_cmd(x, y, width, height, color):
    red, green, blue = color
    return f"{red:.3f} {green:.3f} {blue:.3f} rg {x:.2f} {y:.2f} {width:.2f} {height:.2f} re f\n"

def line_cmd(x1, y1, x2, y2, color=(0, 0, 0), width=0.4):
    red, green, blue = color
    return f"{width:.2f} w {red:.3f} {green:.3f} {blue:.3f} RG {x1:.2f} {y1:.2f} m {x2:.2f} {y2:.2f} l S\n"

def render_native_pdf(figure):
    validated = validate_figure(figure)
    bars = validated["bars"]
    values = [row["value"] for row in bars]
    lower, upper = value_bounds(values)
    span = upper - lower
    width, height = 306, 190
    margin_left, margin_right, margin_bottom = 108, 20, 36
    plot_width = width - margin_left - margin_right
    plot_height = 104
    row_height = plot_height / len(bars)

    def x_for(value):
        return margin_left + ((value - lower) / span) * plot_width

    zero_x = x_for(0.0)
    content = ["1 1 1 rg 0 0 306 190 re f\n"]
    content.append(text_cmd(10, 174, f"Declared comparison: {validated['comparison_id']}", 8.2))
    content.append(text_cmd(10, 162, axis_label(validated), 6.2, (0.12, 0.12, 0.12)))
    content.append(line_cmd(zero_x, margin_bottom, zero_x, margin_bottom + plot_height, (0.18, 0.18, 0.18), 0.7))
    for index, row in enumerate(bars):
        value = row["value"]
        value_x = x_for(value)
        bar_x = min(zero_x, value_x)
        bar_width = max(abs(value_x - zero_x), 1.0)
        y = margin_bottom + plot_height - (index + 0.7) * row_height
        label = row["label"][:42]
        content.append(text_cmd(8, y + 1, label, 6.1, (0.05, 0.05, 0.05)))
        content.append(rect_cmd(bar_x, y, bar_width, 14, PDF_SIDE_COLORS[row["comparison_side"]]))
        value_label_x = value_x + 3 if value >= 0 else value_x - 27
        content.append(text_cmd(value_label_x, y + 2, f"{value:.4g}", 6.1, (0.05, 0.05, 0.05)))
    stream = "".join(content).encode("latin-1", "replace")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 306 190] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"endstream",
    ]
    output = [b"%PDF-1.4\n"]
    offsets = [0]
    for index, obj in enumerate(objects, 1):
        offsets.append(sum(len(part) for part in output))
        output.append(f"{index} 0 obj\n".encode("ascii") + obj + b"\nendobj\n")
    xref = sum(len(part) for part in output)
    output.append(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii"))
    for offset in offsets[1:]:
        output.append(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.append(f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))
    return b"".join(output)

payload = json.loads(Path("figure_payload.json").read_text(encoding="utf-8"))
figures = payload.get("figures")
if not isinstance(figures, list):
    raise ValueError("figure_payload.figures must be an array")
for figure in figures:
    rendered = render_with_matplotlib(figure)
    if rendered is None:
        output_path = required_string(figure, "output_pdf", "figure")
        Path(output_path).write_bytes(render_native_pdf(figure))
`;
}

function buildConceptualDiagramPrompt(input: {
  runTitle: string;
  topic: string;
}): PaperFigureManifest["conceptual_diagram_prompt"] {
  return {
    use_case: "scientific-educational",
    asset_type: "paper conceptual diagram",
    intended_path: "paper/figures/conceptual_diagram.png",
    prompt: [
      "Use case: scientific-educational",
      "Asset type: two-column research paper conceptual diagram",
      `Primary request: Create a clean algorithm/protocol explanation figure for '${input.runTitle}'.`,
      `Scientific context: ${input.topic}`,
      "Diagram content: show a governed research flow from fixed brief, declared subject/reference comparison, configured experiment, executed evaluation, validated result artifact, figure audit, review gate, and paper-readiness decision.",
      "Style: publication-ready, minimal, high contrast, white background, no decorative scene, no fake numeric results.",
      "Text constraints: use short labels only; do not include claims, citations, author names, watermarks, or fabricated data.",
      "Output intent: candidate raster figure that must pass figure_audit before inclusion in the final paper."
    ].join("\n")
  };
}

function buildPaperRenderValidation(input: {
  validationMode: "default" | "strict_paper";
  manuscript: PaperManuscript;
  tex: string;
  authorMetadata: PaperAuthorMetadata | null;
  parsedTemplate: ParsedLatexTemplate | null;
  citationReport: CitationReport;
  compileResult: PaperCompileResult;
  compiledPageValidation: CompiledPdfPageValidationReport;
  figureManifest: PaperFigureManifest;
}): PaperRenderValidationReport {
  const issues: PaperRenderValidationIssue[] = [];
  const strict = input.validationMode === "strict_paper";
  const failOrWarn = (code: string, message: string, strictOnly = true) => {
    issues.push({
      code,
      severity: strictOnly && !strict ? "warning" : "fail",
      message
    });
  };

  const authorCount = input.authorMetadata?.authors?.length || 0;
  if (authorCount === 0) {
    failOrWarn("missing_author", "Strict paper output requires manuscript author metadata.");
  }
  if (!input.parsedTemplate) {
    failOrWarn("missing_template", "Strict paper output requires an explicit manuscript template file.");
  }
  const templatePreservation = checkFinalTexPreservesTemplate(input.tex, input.parsedTemplate);
  if (input.parsedTemplate && !templatePreservation.ok) {
    failOrWarn(
      "template_not_preserved",
      `Final rendered TeX no longer preserves the requested template surface: ${templatePreservation.missing.join(", ")}.`,
      false
    );
  }
  const bibliographyStylePolicy = checkFinalTexBibliographyStyle(input.tex, input.parsedTemplate);
  if (!bibliographyStylePolicy.ok) {
    failOrWarn(
      "bibliography_style_mismatch",
      bibliographyStylePolicy.message,
      false
    );
  }
  if (input.citationReport.status === "fail") {
    failOrWarn(
      "citation_rendering_failed",
      "Rendered manuscript citations do not match the bibliography or no citations were rendered for available bibliography/evidence support."
    );
  }
  const repeatedCitationBundles = detectRepeatedCitationBundles(input.tex);
  const maxRepeatedCitationBundleCount = repeatedCitationBundles[0]?.count ?? 0;
  const repeatedCitationBundleCount = repeatedCitationBundles.filter((item) => item.count > 1).length;
  if (maxRepeatedCitationBundleCount >= 3) {
    failOrWarn(
      "repeated_citation_bundle",
      `The same citation-bearing paragraph is rendered ${maxRepeatedCitationBundleCount} times in ${repeatedCitationBundles[0].section} (${repeatedCitationBundles[0].bundle}), which makes the manuscript look mechanically repeated.`,
      false
    );
  } else if (maxRepeatedCitationBundleCount > 1) {
    failOrWarn(
      "repeated_citation_bundle",
      `The same citation-bearing paragraph is rendered more than once in ${repeatedCitationBundles[0].section} (${repeatedCitationBundles[0].bundle}); remove duplicate prose while preserving claim-level citations.`
    );
  }
  const repeatedLongSentences = detectRepeatedLongSentences(input.tex);
  const maxRepeatedLongSentenceCount = repeatedLongSentences[0]?.count ?? 0;
  const repeatedLongSentenceCount = repeatedLongSentences.length;
  if (maxRepeatedLongSentenceCount >= 3) {
    failOrWarn(
      "repeated_long_sentence",
      `A long reader-facing sentence is repeated ${maxRepeatedLongSentenceCount} times in ${repeatedLongSentences[0].section}: ${repeatedLongSentences[0].sample}`,
      false
    );
  } else if (maxRepeatedLongSentenceCount > 1) {
    failOrWarn(
      "repeated_long_sentence",
      `A long reader-facing sentence is repeated in ${repeatedLongSentences[0].section}: ${repeatedLongSentences[0].sample}`
    );
  }

  const logText = collectCompileLogText(input.compileResult);
  const overfull = extractOverfullHBoxPoints(logText);
  const maxOverfull = overfull.length > 0 ? Math.max(...overfull) : 0;
  if (/No \\author given/u.test(logText)) {
    failOrWarn("latex_missing_author", "LaTeX reported that no author was given.", false);
  }
  if (/Empty `thebibliography' environment|I found no \\citation commands/iu.test(logText)) {
    failOrWarn("empty_bibliography", "LaTeX/BibTeX reported no rendered citations or an empty bibliography.", false);
  }
  const missingBibtexStyle = logText.match(/I couldn\x27t open style file\s+([^\s]+\.bst)/iu)?.[1];
  if (missingBibtexStyle) {
    failOrWarn(
      "missing_bibliography_style_file",
      "BibTeX could not open bibliography style file " + missingBibtexStyle + "; references may not render even though the PDF compile continued.",
      false
    );
  }
  if (maxOverfull > 5) {
    failOrWarn("overfull_hbox", `LaTeX reported overfull content up to ${maxOverfull.toFixed(2)}pt, which can overlap columns.`, false);
  }

  const mainBodyFigureCount = (input.manuscript.figures || []).length;
  const mainBodyTableCount = (input.manuscript.tables || []).length;
  const resultChartCount = input.figureManifest.figures.filter((figure) => figure.kind === "result_chart" && figure.included_in_main_body).length;
  const conceptualDiagramCount = input.figureManifest.figures.filter((figure) => figure.kind !== "result_chart" && figure.included_in_main_body).length;
  const renderedFigureAssetCount = input.figureManifest.figures.filter(
    (figure) => figure.kind === "result_chart" && figure.included_in_main_body && figure.render_status === "pass" && figure.path
  ).length;
  if (mainBodyTableCount > 0 && mainBodyFigureCount === 0) {
    failOrWarn("missing_main_body_figure", "A quantitative paper with main result tables must include at least one audited main-body figure or chart.");
  }
  const requiresRenderedFigureAssets = input.compileResult.enabled && mainBodyFigureCount > 0;
  if (requiresRenderedFigureAssets && renderedFigureAssetCount < mainBodyFigureCount) {
    failOrWarn(
      "missing_python_rendered_figure",
      "Main-body result figures must be rendered as Python-generated vector PDF assets and included with \\includegraphics.",
      false
    );
  }
  if (requiresRenderedFigureAssets && renderedFigureAssetCount > 0 && !/\\includegraphics(?:\[[^\]]*\])?\{figures\/main-result-figure-\d+\.pdf\}/u.test(input.tex)) {
    failOrWarn(
      "python_rendered_figure_not_included",
      "Python-rendered result figure assets exist but the final TeX does not include them with \\includegraphics.",
      false
    );
  }

  const rawLeak = extractRawPaperTextLeak(input.tex);
  if (rawLeak) {
    failOrWarn("raw_artifact_text", `Rendered manuscript still contains raw artifact or log-style text: ${rawLeak}`, false);
  }
  if (input.compiledPageValidation.status === "fail") {
    failOrWarn("main_body_page_budget", input.compiledPageValidation.message, false);
  }

  const failCount = issues.filter((issue) => issue.severity === "fail").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return {
    checked: true,
    validation_mode: input.validationMode,
    status: failCount > 0 ? "fail" : warningCount > 0 ? "warn" : "pass",
    issues,
    metrics: {
      author_count: authorCount,
      template_applied: Boolean(input.parsedTemplate),
      rendered_citation_count: input.citationReport.rendered_citations.length,
      bibliography_entry_count: input.citationReport.bibliography_entries.length,
      main_body_table_count: mainBodyTableCount,
      main_body_figure_count: mainBodyFigureCount,
      result_chart_count: resultChartCount,
      conceptual_diagram_count: conceptualDiagramCount,
      overfull_hbox_count: overfull.length,
      max_overfull_hbox_pt: Number(maxOverfull.toFixed(2)),
      main_body_pdf_page_count: input.compiledPageValidation.main_body_pdf_page_count ?? input.compiledPageValidation.compiled_pdf_page_count,
      target_main_pages: input.compiledPageValidation.target_main_pages,
      rendered_figure_asset_count: renderedFigureAssetCount,
      final_tex_preserves_template: templatePreservation.ok,
      final_tex_bibliography_style: bibliographyStylePolicy.actualStyle,
      expected_bibliography_style: bibliographyStylePolicy.expectedStyle,
      repeated_citation_bundle_count: repeatedCitationBundleCount,
      max_repeated_citation_bundle_count: maxRepeatedCitationBundleCount,
      repeated_long_sentence_count: repeatedLongSentenceCount,
      max_repeated_long_sentence_count: maxRepeatedLongSentenceCount
    },
    summary:
      issues.length === 0
        ? ["Rendered manuscript validation passed."]
        : [
            `Rendered manuscript validation found ${failCount} blocking issue(s) and ${warningCount} warning(s).`,
            ...issues.map((issue) => `${issue.severity}: ${issue.code}: ${issue.message}`)
          ]
  };
}

function collectCompileLogText(compileResult: PaperCompileResult): string {
  return [
    ...compileResult.warnings,
    ...compileResult.attempts.flatMap((attempt) => [
      attempt.error || "",
      ...attempt.warnings,
      ...attempt.commands.flatMap((command) => [command.stdout || "", command.stderr || ""])
    ])
  ].join("\n");
}

function checkFinalTexPreservesTemplate(
  tex: string,
  parsedTemplate: ParsedLatexTemplate | null
): { ok: boolean; missing: string[] } {
  if (!parsedTemplate) {
    return { ok: true, missing: [] };
  }
  const missing: string[] = [];
  if (parsedTemplate.preDocumentPreamble && !tex.includes(parsedTemplate.preDocumentPreamble)) {
    missing.push(parsedTemplate.preDocumentPreamble);
  }
  if (parsedTemplate.documentClass && !tex.includes(parsedTemplate.documentClass)) {
    missing.push(parsedTemplate.documentClass);
  }
  for (const packageLine of parsedTemplate.packages) {
    if (packageLine && !tex.includes(packageLine)) {
      missing.push(packageLine);
    }
  }
  return { ok: missing.length === 0, missing };
}

function checkFinalTexBibliographyStyle(
  tex: string,
  parsedTemplate: ParsedLatexTemplate | null
): { ok: boolean; actualStyle: string | null; expectedStyle: string | null; message: string } {
  const actualStyle = tex.match(/\\bibliographystyle\{([^}]+)\}/u)?.[1]?.trim() || null;
  if (currentAclTemplateOwnsBibliographyStyle(parsedTemplate)) {
    if (!actualStyle) {
      return {
        ok: true,
        actualStyle: null,
        expectedStyle: "acl_natbib (provided by acl.sty)",
        message: ""
      };
    }
    return {
      ok: false,
      actualStyle,
      expectedStyle: "acl_natbib (provided by acl.sty)",
      message: "Final rendered TeX must not add a bibliography style because the current acl.sty provides acl_natbib."
    };
  }
  const expectedStyle = expectedBibliographyStyleForTemplate(parsedTemplate);
  if (!expectedStyle) {
    if (actualStyle === "plain") {
      return {
        ok: false,
        actualStyle,
        expectedStyle: "unsrt",
        message: "Final rendered TeX uses plain bibliography style, so numeric references may be ordered alphabetically instead of by first citation."
      };
    }
    return { ok: true, actualStyle, expectedStyle: null, message: "" };
  }
  if (actualStyle === expectedStyle) {
    return { ok: true, actualStyle, expectedStyle, message: "" };
  }
  return {
    ok: false,
    actualStyle,
    expectedStyle,
    message: `Final rendered TeX uses bibliography style ${actualStyle || "none"} but the template expects ${expectedStyle}.`
  };
}

function expectedBibliographyStyleForTemplate(parsedTemplate: ParsedLatexTemplate | null): string | null {
  const templateSurface = [
    parsedTemplate?.preDocumentPreamble || "",
    parsedTemplate?.documentClass || "",
    parsedTemplate?.preamble || "",
    ...(parsedTemplate?.packages || [])
  ].join("\n");
  const aclTemplate = detectAclTemplatePackage(templateSurface);
  if (aclTemplate) {
    return null;
  }
  const explicitStyle = parsedTemplate?.bibliographyStyle?.trim();
  if (explicitStyle) {
    return explicitStyle;
  }
  return null;
}

function currentAclTemplateOwnsBibliographyStyle(
  parsedTemplate: ParsedLatexTemplate | null
): boolean {
  const templateSurface = [
    parsedTemplate?.preDocumentPreamble || "",
    parsedTemplate?.documentClass || "",
    parsedTemplate?.preamble || "",
    ...(parsedTemplate?.packages || [])
  ].join("\n");
  return detectAclTemplatePackage(templateSurface) !== null;
}

function detectRepeatedCitationBundles(tex: string): Array<{ bundle: string; count: number; section: string }> {
  const chunks = tex.split(/(?=\\section(?:\[[^\]]*\])?\{[^}]+\})/u);
  const effectiveChunks = chunks.length > 1 ? chunks : [tex];
  const repeated: Array<{ bundle: string; count: number; section: string }> = [];
  for (const chunk of effectiveChunks) {
    const section = chunk.match(/\\section(?:\[[^\]]*\])?\{([^}]+)\}/u)?.[1]?.trim() || "the rendered manuscript";
    const counts = new Map<string, { bundle: string; count: number }>();
    for (const paragraph of chunk.split(/\n\s*\n/gu)) {
      const bundles = [...paragraph.matchAll(/\\cite[a-zA-Z*]*(?:\[[^\]]*\]){0,2}\{([^}]+)\}/gu)]
        .map((match) => normalizeCitationBundle(match[1]))
        .filter(Boolean);
      if (bundles.length === 0) continue;
      const normalizedParagraph = paragraph.replace(/\s+/gu, " ").trim();
      if (!normalizedParagraph) continue;
      const current = counts.get(normalizedParagraph) || { bundle: bundles.join(";"), count: 0 };
      current.count += 1;
      counts.set(normalizedParagraph, current);
    }
    repeated.push(...Array.from(counts.values())
      .filter((item) => item.count > 1)
      .map((item) => ({ ...item, section })));
  }
  return repeated.sort((a, b) => b.count - a.count || a.section.localeCompare(b.section) || a.bundle.localeCompare(b.bundle));
}

function normalizeCitationBundle(raw: string): string {
  const keys = Array.from(
    new Set(
      raw
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean)
    )
  ).sort();
  return keys.join(",");
}

function detectRepeatedLongSentences(tex: string): Array<{ key: string; count: number; section: string; sample: string }> {
  const chunks = tex.split(/(?=\\section(?:\[[^\]]*\])?\{[^}]+\})/u);
  const effectiveChunks = chunks.length > 1 ? chunks : [tex];
  const repeated: Array<{ key: string; count: number; section: string; sample: string }> = [];
  for (const chunk of effectiveChunks) {
    const section = chunk.match(/\\section(?:\[[^\]]*\])?\{([^}]+)\}/u)?.[1]?.trim() || "the rendered manuscript";
    const counts = new Map<string, { count: number; sample: string }>();
    const plain = stripLatexForSentenceInspection(chunk);
    for (const sentence of splitRenderedSentences(plain)) {
      const key = normalizeRenderedSentenceKey(sentence);
      if (key.length < 80) {
        continue;
      }
      const current = counts.get(key) || { count: 0, sample: sentence };
      counts.set(key, { count: current.count + 1, sample: current.sample });
    }
    repeated.push(
      ...Array.from(counts.entries())
        .map(([key, value]) => ({
          key,
          count: value.count,
          section,
          sample: truncateRenderValidationText(value.sample, 180)
        }))
        .filter((item) => item.count > 1)
    );
  }
  const globalCounts = new Map<string, { count: number; sample: string }>();
  for (const sentence of splitRenderedSentences(stripLatexForSentenceInspection(tex))) {
    const key = normalizeRenderedSentenceKey(sentence);
    if (key.length < 80) {
      continue;
    }
    const current = globalCounts.get(key) || { count: 0, sample: sentence };
    globalCounts.set(key, { count: current.count + 1, sample: current.sample });
  }
  repeated.push(
    ...Array.from(globalCounts.entries())
      .map(([key, value]) => ({
        key,
        count: value.count,
        section: "multiple sections",
        sample: truncateRenderValidationText(value.sample, 180)
      }))
      .filter((item) => item.count > 2)
  );
  return repeated.sort((a, b) => b.count - a.count || a.section.localeCompare(b.section) || a.key.localeCompare(b.key));
}

function truncateRenderValidationText(text: string, maxLength: number): string {
  const cleaned = text.replace(/\s+/gu, " ").trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function stripLatexForSentenceInspection(tex: string): string {
  return tex
    .replace(/\\cite[a-zA-Z*]*(?:\[[^\]]*\]){0,2}\{[^}]+\}/gu, " ")
    .replace(/\\(?:section|subsection|caption|title|author)(?:\[[^\]]*\])?\{([^}]*)\}/gu, "$1. ")
    .replace(/\\(?:begin|end)\{[^}]+\}/gu, " ")
    .replace(/\\[a-zA-Z]+(?:\[[^\]]*\])?(?:\{[^}]*\})?/gu, " ")
    .replace(/[{}_$^&%#~]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function splitRenderedSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "." && char !== "!" && char !== "?") {
      continue;
    }
    const previous = index > 0 ? text[index - 1] : "";
    const next = index + 1 < text.length ? text[index + 1] : "";
    if (char === "." && /\d/u.test(previous) && /\d/u.test(next)) {
      continue;
    }
    const atEnd = index + 1 >= text.length;
    const followedByWhitespace = /\s/u.test(next);
    if (!atEnd && !followedByWhitespace) {
      continue;
    }
    const sentence = text.slice(start, index + 1).trim();
    if (sentence) {
      sentences.push(sentence);
    }
    start = index + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) {
    sentences.push(tail);
  }
  return sentences.length > 0 ? sentences : [text.trim()].filter(Boolean);
}

function normalizeRenderedSentenceKey(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractOverfullHBoxPoints(text: string): number[] {
  return Array.from(text.matchAll(/Overfull \\hbox \(([-+]?\d+(?:\.\d+)?)pt too wide\)/giu), (match) =>
    Number.parseFloat(match[1])
  ).filter((value) => Number.isFinite(value));
}

function extractRawPaperTextLeak(tex: string): string | undefined {
  const patterns = [
    /raw result [^\\\n.]{0,80}/iu,
    /Objective metric:\s*-/iu,
    /\b[a-z][a-z0-9]*(?:\\?_[a-z][a-z0-9]*){2,}\b/iu,
    /study summary run/iu,
    /\bP6\b/u,
    /We study Study how/iu
  ];
  for (const pattern of patterns) {
    const match = tex.match(pattern);
    if (match?.[0]) {
      return match[0].trim();
    }
  }
  return undefined;
}

function buildSubmissionValidationError(
  report: {
    issues: Array<{ message: string; value?: string }>;
    unresolvedCitationPaperIds: string[];
  }
): string {
  const leadIssue = report.issues[0];
  const leadDetail = leadIssue
    ? `${leadIssue.message}${leadIssue.value ? ` (${leadIssue.value})` : ""}`
    : "submission validation failed";
  const unresolved =
    report.unresolvedCitationPaperIds.length > 0
      ? ` Unresolved citations: ${report.unresolvedCitationPaperIds.join(", ")}.`
      : "";
  return `write_paper generated manuscript artifacts but stopped before PDF build because submission-quality validation failed: ${leadDetail}.${unresolved}`;
}

function buildCompiledPdfPageValidationError(report: CompiledPdfPageValidationReport): string {
  const qualifier = report.validation_mode === "strict_paper" ? "strict-paper mode" : "default mode";
  return `write_paper generated PDF artifacts but stopped because compiled PDF page-budget validation failed in ${qualifier}: ${report.message}`;
}

function buildPaperRenderValidationError(report: PaperRenderValidationReport): string {
  const lead = report.issues.find((issue) => issue.severity === "fail")?.message
    || report.summary[0]
    || "rendered manuscript validation failed";
  return `write_paper generated manuscript/PDF artifacts but stopped because rendered-paper validation failed: ${lead}`;
}

function buildCompileFailureError(result: PaperCompileResult): string {
  const latestAttempt = [...result.attempts].reverse().find((item) => item.status === "failed");
  const detail = (result.repair_error || latestAttempt?.error || "unknown LaTeX compilation error").trim();
  const normalizedDetail = /[.!?]$/.test(detail) ? detail : `${detail}.`;
  const buildLogHint = result.build_log_path ? ` See ${result.build_log_path}.` : "";
  return `write_paper generated LaTeX artifacts but the configured PDF build failed: ${normalizedDetail}${buildLogHint}`;
}

function buildScientificGateFailureError(report: {
  mode: "default" | "strict_paper";
  failure_reasons: string[];
  evidence_summary?: {
    thin_sections: string[];
    missing_evidence_categories: string[];
    blocked_by_evidence_insufficiency: boolean;
  };
}): string {
  const leadDetail = report.failure_reasons[0] || "scientific quality gate failed";
  const qualifier = report.mode === "strict_paper" ? "strict-paper mode" : "default mode";
  const evidenceDetail =
    report.evidence_summary?.blocked_by_evidence_insufficiency
      ? ` Evidence insufficiency remains in ${report.evidence_summary.thin_sections.join(", ") || "core sections"}; missing categories: ${report.evidence_summary.missing_evidence_categories.join(", ")}.`
      : "";
  return `write_paper generated manuscript artifacts but stopped before PDF build because the scientific quality gate failed in ${qualifier}: ${leadDetail}${evidenceDetail}`;
}

function resolvePaperValidationMode(value: unknown): "default" | "strict_paper" {
  return value === "strict_paper" ? "strict_paper" : "default";
}

export async function validateCompiledPdfPageBudget(input: {
  deps: NodeExecutionDeps;
  run: Parameters<GraphNodeHandler["execute"]>[0]["run"];
  compileResult: PaperCompileResult;
  validationMode: "default" | "strict_paper";
  minimumMainPages: number;
  targetMainPages: number;
  referencesCounted?: boolean;
  appendicesCounted?: boolean;
}): Promise<CompiledPdfPageValidationReport> {
  const referencesCounted = input.referencesCounted === true;
  const appendicesCounted = input.appendicesCounted === true;
  if (!input.compileResult.pdf_path) {
    return {
      checked: false,
      validation_mode: input.validationMode,
      status: "pass",
      outcome: "skipped",
      minimum_main_pages: input.minimumMainPages,
      target_main_pages: input.targetMainPages,
      main_page_limit: input.minimumMainPages,
      compiled_pdf_page_count: null,
      main_body_pdf_page_count: null,
      references_page_count: null,
      appendix_page_count: null,
      references_counted: referencesCounted,
      appendices_counted: appendicesCounted,
      pdf_path: null,
      message: "Compiled PDF page-budget validation was skipped because no PDF artifact was produced."
    };
  }

  const runPaperDir = path.join(process.cwd(), ".autolabos", "runs", input.run.id, "paper");
  const observation = await input.deps.aci.runCommand("pdfinfo main.pdf", runPaperDir);
  const stdoutText = observation.stdout || "";
  const match = stdoutText.match(/^Pages:\s+(\d+)/mu);
  const parsedPageCount = match ? Number.parseInt(match[1], 10) : Number.NaN;
  if (observation.status !== "ok" || !Number.isFinite(parsedPageCount)) {
    return {
      checked: false,
      validation_mode: input.validationMode,
      status: input.validationMode === "strict_paper" ? "fail" : "warn",
      outcome: "measurement_unavailable",
      minimum_main_pages: input.minimumMainPages,
      target_main_pages: input.targetMainPages,
      main_page_limit: input.minimumMainPages,
      compiled_pdf_page_count: null,
      main_body_pdf_page_count: null,
      references_page_count: null,
      appendix_page_count: null,
      references_counted: referencesCounted,
      appendices_counted: appendicesCounted,
      pdf_path: input.compileResult.pdf_path,
      message:
        "Compiled PDF page count could not be verified with pdfinfo, so minimum_main_pages compliance remains unverified."
    };
  }
  const textObservation = await input.deps.aci.runCommand("pdftotext -layout main.pdf -", runPaperDir);
  const pageBreakdown = textObservation.status === "ok"
    ? computeCompiledPdfPageBreakdown(textObservation.stdout || "", {
        totalPages: parsedPageCount,
        referencesCounted,
        appendicesCounted
      })
    : undefined;
  const mainBodyPageCount = pageBreakdown?.mainBodyPages ?? parsedPageCount;
  const referencesPageCount = pageBreakdown?.referencesPages ?? null;
  const appendixPageCount = pageBreakdown?.appendixPages ?? null;
  if (mainBodyPageCount < input.minimumMainPages) {
    return {
      checked: true,
      validation_mode: input.validationMode,
      status: input.validationMode === "strict_paper" ? "fail" : "warn",
      outcome: "under_limit",
      minimum_main_pages: input.minimumMainPages,
      target_main_pages: input.targetMainPages,
      main_page_limit: input.minimumMainPages,
      compiled_pdf_page_count: parsedPageCount,
      main_body_pdf_page_count: mainBodyPageCount,
      references_page_count: referencesPageCount,
      appendix_page_count: appendixPageCount,
      references_counted: referencesCounted,
      appendices_counted: appendicesCounted,
      pdf_path: input.compileResult.pdf_path,
      message:
        `Compiled main body is only ${mainBodyPageCount} page${mainBodyPageCount === 1 ? "" : "s"} ` +
        `(total PDF pages=${parsedPageCount}, references pages=${referencesPageCount ?? "unknown"}, ` +
        `appendix pages=${appendixPageCount ?? "unknown"}), below the configured minimum_main_pages of ` +
        `${input.minimumMainPages}.`
    };
  }
  return {
    checked: true,
    validation_mode: input.validationMode,
    status: "pass",
    outcome: "ok",
    minimum_main_pages: input.minimumMainPages,
    target_main_pages: input.targetMainPages,
    main_page_limit: input.minimumMainPages,
    compiled_pdf_page_count: parsedPageCount,
    main_body_pdf_page_count: mainBodyPageCount,
    references_page_count: referencesPageCount,
    appendix_page_count: appendixPageCount,
    references_counted: referencesCounted,
    appendices_counted: appendicesCounted,
    pdf_path: input.compileResult.pdf_path,
    message:
      `Compiled main body reached ${mainBodyPageCount} page${mainBodyPageCount === 1 ? "" : "s"} ` +
      `(total PDF pages=${parsedPageCount}, references pages=${referencesPageCount ?? "unknown"}, ` +
      `appendix pages=${appendixPageCount ?? "unknown"}), meeting the configured minimum_main_pages of ` +
      `${input.minimumMainPages}.`
  };
}

function computeCompiledPdfPageBreakdown(
  pdfText: string,
  options: {
    totalPages: number;
    referencesCounted: boolean;
    appendicesCounted: boolean;
  }
): {
  mainBodyPages: number;
  referencesPages: number;
  appendixPages: number;
} {
  const pages = pdfText.split("\f").map((page) => page.trim()).filter((page, index, all) =>
    page.length > 0 || index < all.length - 1
  );
  const pageCount = pages.length > 0 ? Math.max(pages.length, options.totalPages) : options.totalPages;
  const referenceStart = findFirstPageIndex(pages, [
    /^\s*references\s*$/imu,
    /^\s*bibliography\s*$/imu
  ]);
  const appendixStart = findFirstPageIndex(pages, [
    /^\s*appendix\b/imu,
    /^\s*appendices\b/imu,
    /^\s*supplementary\b/imu
  ]);
  const excludedStarts = [
    options.referencesCounted ? undefined : referenceStart,
    options.appendicesCounted ? undefined : appendixStart
  ].filter((value): value is number => typeof value === "number" && value >= 0);
  const firstExcludedStart = excludedStarts.length > 0 ? Math.min(...excludedStarts) : pageCount;
  const referencesPages =
    referenceStart === undefined
      ? 0
      : Math.max(0, (appendixStart !== undefined && appendixStart > referenceStart ? appendixStart : pageCount) - referenceStart);
  const appendixPages = appendixStart === undefined ? 0 : Math.max(0, pageCount - appendixStart);
  return {
    mainBodyPages: Math.max(0, Math.min(firstExcludedStart, pageCount)),
    referencesPages,
    appendixPages
  };
}

function findFirstPageIndex(pages: string[], patterns: RegExp[]): number | undefined {
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index] || "";
    if (patterns.some((pattern) => pattern.test(page))) {
      return index;
    }
  }
  return undefined;
}

function isMissingBinaryObservation(obs: { stderr?: string; exit_code?: number }): boolean {
  const text = `${obs.stderr || ""}`.toLowerCase();
  return obs.exit_code === 127 || text.includes("not found") || text.includes("enoent");
}

function isPolicyBlockedObservation(obs: { exit_code?: number; stderr?: string }): boolean {
  return obs.exit_code === 126 && `${obs.stderr || ""}`.includes("Policy blocked");
}

function buildPostDraftTransitionRecommendation(
  critique: PaperCritique
): TransitionRecommendation | undefined {
  // If the critique says advance or repair_then_retry, no transition needed
  if (critique.overall_decision === "advance" || critique.overall_decision === "repair_then_retry") {
    return undefined;
  }

  const action = critiqueDecisionToTransitionAction(critique.overall_decision);
  const targetNode = critiqueDecisionToTargetNode(critique.overall_decision);
  const evidence = [
    `Manuscript type: ${critique.manuscript_type}`,
    `Blocking issues: ${critique.blocking_issues_count}`,
    critique.manuscript_claim_risk_summary
  ].filter(Boolean).slice(0, 4);

  return {
    action,
    sourceNode: "write_paper",
    targetNode,
    reason: `Post-draft critique: ${critique.manuscript_claim_risk_summary}`,
    confidence: critique.confidence,
    autoExecutable: true,
    evidence,
    suggestedCommands: [],
    generatedAt: new Date().toISOString()
  };
}

function evaluateWritePaperEligibility(input: {
  preDraftCritique: PaperCritique | null;
  briefEvidenceAssessment?: BriefEvidenceAssessment;
  reviewRequired?: boolean;
}): {
  generated_at: string;
  allowed: boolean;
  reason: string;
  manuscript_type?: ManuscriptType;
  brief_evidence_status?: BriefEvidenceAssessment["status"];
} {
  if (input.reviewRequired && !input.preDraftCritique) {
    return {
      generated_at: new Date().toISOString(),
      allowed: false,
      reason: "write_paper blocked because review/paper_critique.json is required before drafting.",
      brief_evidence_status: input.briefEvidenceAssessment?.status
    };
  }

  if (input.briefEvidenceAssessment?.enabled && input.briefEvidenceAssessment.status === "fail") {
    return {
      generated_at: new Date().toISOString(),
      allowed: false,
      reason: `write_paper blocked by brief evidence gate: ${input.briefEvidenceAssessment.summary}`,
      manuscript_type: input.preDraftCritique?.manuscript_type,
      brief_evidence_status: input.briefEvidenceAssessment.status
    };
  }

  const manuscriptType = input.preDraftCritique?.manuscript_type;
  const enforcePaperScaleFloor = input.briefEvidenceAssessment?.enabled === true;
  if (manuscriptType === "blocked_for_paper_scale") {
    return {
      generated_at: new Date().toISOString(),
      allowed: false,
      reason: "write_paper blocked because review classified this run as blocked_for_paper_scale.",
      manuscript_type: manuscriptType,
      brief_evidence_status: input.briefEvidenceAssessment?.status
    };
  }
  if (
    enforcePaperScaleFloor &&
    manuscriptType &&
    manuscriptType !== "paper_scale_candidate" &&
    manuscriptType !== "paper_ready"
  ) {
    return {
      generated_at: new Date().toISOString(),
      allowed: false,
      reason: `write_paper requires a pre-draft critique of at least paper_scale_candidate, but review classified this run as ${manuscriptType}.`,
      manuscript_type: manuscriptType,
      brief_evidence_status: input.briefEvidenceAssessment?.status
    };
  }

  return {
    generated_at: new Date().toISOString(),
    allowed: true,
    reason: manuscriptType
      ? `write_paper allowed: pre-draft critique classified the run as ${manuscriptType}.`
      : "write_paper allowed: no pre-draft critique was available, so no critique-based gate was applied.",
    manuscript_type: manuscriptType ?? undefined,
    brief_evidence_status: input.briefEvidenceAssessment?.status
  };
}

async function loadPreDraftCritique(runId: string): Promise<PaperCritique | null> {
  try {
    const raw = await safeRead(path.join(".autolabos", "runs", runId, "review", "paper_critique.json"));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PaperCritique;
    return parsed && parsed.stage === "pre_draft_review" ? parsed : null;
  } catch {
    return null;
  }
}
