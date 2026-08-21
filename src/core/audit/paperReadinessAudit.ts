import path from "node:path";
import { promises as fs } from "node:fs";

import { validateGovernanceArtifactContract } from "../benchmark/governanceArtifactContract.js";
import { scoreClaimEvidenceArtifacts, type ClaimEvidenceScore } from "../benchmark/claimEvidenceScoring.js";
import { scoreFigureAudit, type FigureAuditScore } from "../benchmark/figureAuditScoring.js";
import { scoreGovernanceTask, type GovernanceTaskScore } from "../benchmark/governanceScorer.js";
import { scoreLiveValidationCase, type LiveValidationCaseScore } from "../benchmark/liveValidationScoring.js";
import { scoreResultTableArtifact, type ResultTableScore } from "../benchmark/resultTableScoring.js";
import { type GovernanceBenchmarkConditionName } from "../benchmark/governanceCondition.js";
import { validateResultsPlanV2 } from "../analysis/resultsTableSchema.js";
import type { FigureAuditSummary } from "../exploration/types.js";
import {
  parseReferenceClaimsTsv,
  type ReferenceClaimRow
} from "../referenceClaimReview.js";
import { inspectReferenceAuthorityGate } from "../referenceAuthorityGate.js";
import { writeJsonFile } from "../../utils/fs.js";
import { buildClaimEvidenceExport, type ClaimEvidenceExport } from "./claimEvidenceExport.js";
import {
  materializeExternalAuditArtifacts,
  type ExternalArtifactIntakeBindings
} from "./externalArtifactIntake.js";
import { scoreLiteratureDiscoveryAudit, type LiteratureDiscoveryAuditScore } from "./literatureDiscoveryAudit.js";
import { buildAuditTimeline, type AuditTimeline } from "./auditTimeline.js";
import { buildClaimPromotionTimeline, type BlockedClaimEvents, type ClaimPromotionTimeline } from "./claimPromotionTimeline.js";
import { evaluateDoneConditionAudit, type DoneConditionAudit } from "./doneConditionAudit.js";
import { computeAuditAutonomyMetrics, type AuditAutonomyMetrics } from "./autonomyMetrics.js";

export type PaperReadinessAuditVerdict = "blocked" | "needs-review" | "conditionally-ready";

export interface PaperReadinessAuditInput {
  cwd: string;
  runRoot?: string;
  externalRoot?: string;
  draftPath?: string;
  logPath?: string;
  supportRoot?: string;
  supportManifestPath?: string;
  outDir?: string;
}

export interface PaperReadinessAuditBlocker {
  code: string;
  severity: "blocker" | "warning";
  message: string;
  source: string;
}

export interface PaperReadinessAuditUnsupportedClaim {
  claim_id: string;
  message: string;
  status?: string;
  declared_status?: string;
  statement?: string;
  target_node?: string;
  evidence_path?: string;
  recheck_condition?: string;
}

export interface PaperReadinessAuditDesignContractFinding {
  code: string;
  severity: "blocker" | "warning";
  message: string;
  evidence_path: string;
}

export interface PaperReadinessAuditResearchScaleFinding {
  code: string;
  severity: "blocker" | "warning";
  message: string;
  target_node?: string;
  target_surface?: "prompt" | "validator" | "skill" | "policy" | "runtime";
  evidence_path: string;
  recheck_condition?: string;
}

export interface PaperReadinessAuditExecutionIntegrityFinding {
  code: string;
  severity: "blocker" | "warning";
  message: string;
  evidence_path: string;
  target_node: "run_experiments" | "review";
}

export interface PaperReadinessAuditSummary {
  generated_at: string;
  verdict: PaperReadinessAuditVerdict;
  input: {
    mode: "run" | "external";
    run_root: string;
  };
  artifact_contract?: {
    passed: boolean;
    required_artifacts: Array<{
      path: string;
      status: "present" | "missing_or_empty";
    }>;
  };
  outputs: {
    report_path: string;
    summary_path: string;
    blockers_path: string;
    claim_evidence_path: string;
    audit_timeline_path: string;
    claim_promotion_timeline_path: string;
    blocked_claim_events_path: string;
    done_condition_path: string;
    autonomy_metrics_path: string;
    external_intake_manifest_path?: string;
  };
  external_intake?: ExternalArtifactIntakeBindings;
  top_blockers: PaperReadinessAuditBlocker[];
  unsupported_claims: PaperReadinessAuditUnsupportedClaim[];
  baseline_comparator_status: {
    status: "present" | "missing" | "unmeasured";
    missing_baseline_count: number;
    missing_comparator_count: number;
    comparative_claim_allowed: boolean;
  };
  result_table_completeness: {
    measured: boolean;
    row_count: number;
    complete_row_count: number;
    comparator_coverage: number | null;
    paper_ready_allowed: boolean;
  };
  figure_result_caption_mismatch: {
    status: FigureAuditScore["audit_status"];
    severe_mismatch_count: number | null;
    manuscript_promotion_allowed: boolean;
  };
  citation_support_issues: PaperReadinessAuditUnsupportedClaim[];
  design_contract_findings: PaperReadinessAuditDesignContractFinding[];
  research_scale_findings: PaperReadinessAuditResearchScaleFinding[];
  execution_integrity_findings: PaperReadinessAuditExecutionIntegrityFinding[];
  claim_ceiling: {
    allowed_level: string;
    audit_output_level?: string;
    declared_scope_level?: string;
    rules_applied: string[];
  };
  paper_readiness: {
    paper_ready: boolean;
    readiness_state?: string;
    write_paper_completed: boolean;
  };
  judge_lane: {
    planner_worker_nodes: string[];
    judge_nodes: string[];
    audit_report_label: string;
  };
  audit_timeline: {
    status: AuditTimeline["status"];
    measured: boolean;
    entry_count: number;
    event_count: number;
    checkpoint_count: number;
    omitted_entry_count: number;
  };
  done_condition: {
    status: DoneConditionAudit["status"];
    measured: boolean;
    declared_source: DoneConditionAudit["declared_source"];
    failure_count: number;
    warning_count: number;
  };
  autonomy_metrics: AuditAutonomyMetrics;
  scorer_outputs: {
    result_table: ResultTableScore;
    claim_evidence: ClaimEvidenceScore;
    figure_audit: FigureAuditScore;
    literature_discovery: LiteratureDiscoveryAuditScore;
    live_validation?: LiveValidationCaseScore;
    governance_score: GovernanceTaskScore;
  };
  next_action_checklist: string[];
}

interface LoadedRunArtifacts {
  runRoot: string;
  availableArtifactRefs: string[];
  condition: GovernanceBenchmarkConditionName;
  resultTable: unknown;
  claimEvidenceTable: unknown;
  claimStatusTable: unknown;
  evidenceLinks: unknown;
  evidenceGateDecision: Record<string, unknown> | undefined;
  paperReadiness: Record<string, unknown> | undefined;
  reviewDecision: Record<string, unknown> | undefined;
  figureAuditSummary: FigureAuditSummary | null | undefined;
  runRecord: Record<string, unknown> | undefined;
  runConfig: Record<string, unknown> | undefined;
  experimentEvidence: Record<string, unknown> | undefined;
  checkpointState: Record<string, unknown> | undefined;
  runExperimentsVerifierReport: Record<string, unknown> | undefined;
  evidenceStoreLines: Record<string, unknown>[];
  designContractPayloads: Array<{ path: string; payload: Record<string, unknown> }>;
  literatureDiscoveryPayloads: Array<{ path: string; payload: Record<string, unknown> }>;
  paperScaleDiagnostics: Record<string, unknown> | undefined;
  nodeStrengtheningRecommendations: Record<string, unknown> | undefined;
  governanceConditionPayload: Record<string, unknown> | undefined;
  researchBriefText: string | undefined;
  mainTexExists: boolean;
  mainTexText: string | undefined;
  academicClaimEvidenceMap: Record<string, unknown> | undefined;
  academicReferenceEvidenceStatus: Record<string, unknown> | undefined;
  academicSubmissionStatus: Record<string, unknown> | undefined;
  referenceClaimInventory: {
    present: boolean;
    valid: boolean;
    rows: ReferenceClaimRow[];
  };
}

interface PaperReadinessAuditBuildResult {
  summary: PaperReadinessAuditSummary;
  claimEvidenceExport: ClaimEvidenceExport;
  auditTimeline: AuditTimeline;
  claimPromotionTimeline: ClaimPromotionTimeline;
  blockedClaimEvents: BlockedClaimEvents;
  doneConditionAudit: DoneConditionAudit;
}

export async function runPaperReadinessAudit(
  input: PaperReadinessAuditInput
): Promise<PaperReadinessAuditSummary> {
  const modeCount = [input.runRoot, input.externalRoot].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error("Paper-readiness audit requires exactly one of --run <run-artifact-root> or --external <artifact-root>.");
  }

  const cwd = path.resolve(input.cwd);
  const outDir = path.resolve(cwd, input.outDir || path.join("outputs", "audit"));
  await fs.mkdir(outDir, { recursive: true });

  const externalIntake = input.externalRoot
    ? await materializeExternalAuditArtifacts({
        cwd,
        outDir,
        externalRoot: input.externalRoot,
        draftPath: input.draftPath,
        logPath: input.logPath,
        supportRoot: input.supportRoot,
        supportManifestPath: input.supportManifestPath
      })
    : undefined;
  const runRoot = externalIntake
    ? externalIntake.runRoot
    : path.resolve(cwd, input.runRoot || "");
  const artifacts = await loadRunArtifacts(runRoot);
  const buildResult = await buildAuditSummary({
    cwd,
    outDir,
    external: Boolean(externalIntake),
    externalIntakeBindings: externalIntake?.bindings,
    artifacts
  });
  const summary = buildResult.summary;

  await writeJsonFile(path.join(outDir, "audit-summary.json"), summary);
  await writeJsonFile(path.join(outDir, "blockers.json"), {
    generated_at: summary.generated_at,
    verdict: summary.verdict,
    blockers: summary.top_blockers,
    unsupported_claims: summary.unsupported_claims,
    next_action_checklist: summary.next_action_checklist
  });
  await writeJsonFile(path.join(outDir, "claim-evidence-table.json"), buildResult.claimEvidenceExport);
  await writeJsonFile(path.join(outDir, "audit-timeline.json"), buildResult.auditTimeline);
  await writeJsonFile(path.join(outDir, "claim-promotion-timeline.json"), buildResult.claimPromotionTimeline);
  await writeJsonFile(path.join(outDir, "blocked-claim-events.json"), buildResult.blockedClaimEvents);
  await writeJsonFile(path.join(outDir, "done-condition-audit.json"), buildResult.doneConditionAudit);
  await writeJsonFile(path.join(outDir, "autonomy-metrics.json"), summary.autonomy_metrics);
  await fs.writeFile(path.join(outDir, "paper-readiness-audit.md"), renderAuditMarkdown(summary), "utf8");

  return summary;
}

async function buildAuditSummary(input: {
  cwd: string;
  outDir: string;
  external: boolean;
  externalIntakeBindings?: ExternalArtifactIntakeBindings;
  artifacts: LoadedRunArtifacts;
}): Promise<PaperReadinessAuditBuildResult> {
  const contract = await validateGovernanceArtifactContract({
    runDir: input.artifacts.runRoot,
    condition: input.artifacts.condition,
    requireGovernanceConditionArtifact: Boolean(input.artifacts.governanceConditionPayload)
  });
  const missingRequiredArtifacts = new Set(contract.issues
    .filter((issue) => issue.code === "governance_required_artifact_missing")
    .map((issue) => issue.file_path));
  const artifactContractEntries = contract.required_artifacts.map((artifactPath) => ({
    path: artifactPath,
    status: missingRequiredArtifacts.has(artifactPath)
      ? "missing_or_empty" as const
      : "present" as const
  }));
  const declaredAcademicCeiling = stringValue(input.artifacts.academicClaimEvidenceMap?.claim_ceiling);
  const boundDesignClaimCeilings = [...new Set(input.artifacts.designContractPayloads
    .map(({ payload }) => stringValue(payload.claim_ceiling))
    .filter((value): value is string => Boolean(value)))];
  const claimAuthorization = resolveComparisonClaimAuthorization(input.artifacts.designContractPayloads);
  const resultTable = scoreResultTableArtifact(input.artifacts.resultTable, claimAuthorization);
  const claimEvidence = scoreClaimEvidenceArtifacts({
    claimEvidenceTableArtifact: input.artifacts.claimEvidenceTable,
    claimStatusTableArtifact: input.artifacts.claimStatusTable,
    evidenceLinksArtifact: input.artifacts.evidenceLinks,
    evidenceStoreArtifact: input.artifacts.evidenceStoreLines,
    availableArtifactRefs: input.artifacts.availableArtifactRefs
  });
  const figureAudit = scoreFigureAudit({
    summary: input.artifacts.figureAuditSummary,
    condition: input.artifacts.condition
  });
  const evidenceStore = analyzeEvidenceStore(input.artifacts.evidenceStoreLines);
  const liveValidation = evidenceStore.deterministicFallbackUsed
    ? scoreLiveValidationCase({
        case_id: path.basename(input.artifacts.runRoot),
        reproduced: true,
        regression_rechecked: true,
        dominant_failure_class: "in_memory_projection_bug",
        syntax_success: true,
        metric_evidence_present: evidenceStore.nonFallbackMetricEvidencePresent,
        fallback_label: evidenceStore.fallbackLabels[0],
        deterministic_fallback_used: true
      })
    : undefined;
  const unsupportedClaims = collectUnsupportedClaims(input.artifacts, claimEvidence);
  const citationSupportIssues = collectCitationSupportIssues(input.artifacts);
  const designContractFindings = collectDesignContractFindings(input.artifacts);
  const paperReady = input.artifacts.paperReadiness?.paper_ready === true;
  const referenceAuthorityGate = await inspectReferenceAuthorityGate(
    path.join(input.artifacts.runRoot, "paper")
  );
  const researchScaleFindings = [
    ...collectResearchScaleFindings(input.artifacts),
    ...collectAcademicPackageFindings(input.artifacts)
  ];
  const executionIntegrityFindings = collectExecutionIntegrityFindings(input.artifacts);
  const literatureDiscovery = scoreLiteratureDiscoveryAudit({
    payloads: input.artifacts.literatureDiscoveryPayloads
  });
  const readinessState = stringValue(input.artifacts.paperReadiness?.readiness_state);
  const runStatus = getRunStatus(input.artifacts.runRecord);
  const activeRun = isActiveRunStatus(runStatus);
  const failedRun = isFailedRunStatus(runStatus);
  const runFailureDetail = getRunFailureDetail(input.artifacts.runExperimentsVerifierReport);
  const failedRunHidden = failedRun && paperReady;
  const writePaperStatus = getWritePaperStatus(input.artifacts.runRecord);
  const writePaperCompleted = isWritePaperCompleted(writePaperStatus);
  const writePaperFailed = writePaperStatus === "failed" || writePaperStatus === "error";
  const writePaperFailureMessage = getWritePaperFailureMessage(input.artifacts.runRecord);
  const blockers: PaperReadinessAuditBlocker[] = [];
  const rulesApplied: string[] = [];

  if ((paperReady || referenceAuthorityGate.status_present || referenceAuthorityGate.claims_present)
      && referenceAuthorityGate.status !== "pass") {
    blockers.push({
      code: "reference_authority_gate_not_passed",
      severity: "blocker",
      message: `Canonical reference authority validation failed: ${referenceAuthorityGate.reason}`,
      source: "referenceAuthorityGate"
    });
  }

  if (contract.issues.length > 0) {
    const affectedPaths = [...new Set(contract.issues.map((issue) => issue.file_path))].sort();
    blockers.push({
      code: "artifact_contract_incomplete",
      severity: "blocker",
      message: `${contract.issues.length} required governance artifact issue(s): ${affectedPaths.join(", ")}.`,
      source: "governanceArtifactContract"
    });
  }
  if (!resultTable.measured || resultTable.row_count === 0) {
    rulesApplied.push("metric/result table 없음 -> paper-ready 차단");
    blockers.push({
      code: "result_table_missing",
      severity: "blocker",
      message: "No measurable result_table.json was found; paper-ready promotion is blocked.",
      source: "resultTableScoring"
    });
  } else if (resultTable.complete_row_count === 0) {
    rulesApplied.push("metric/result table 없음 -> paper-ready 차단");
    blockers.push({
      code: "result_table_incomplete",
      severity: "blocker",
      message: "Result table exists but has no complete metric/baseline/comparator/delta row.",
      source: "resultTableScoring"
    });
  }
  if (resultTable.missing_baseline_count > 0 || resultTable.missing_comparator_count > 0) {
    rulesApplied.push("baseline/comparator 없음 -> comparative claim 차단");
    blockers.push({
      code: "baseline_or_comparator_missing",
      severity: "blocker",
      message: "Baseline or comparator evidence is missing; comparative and improvement claims are blocked.",
      source: "resultTableScoring"
    });
  }
  if (claimEvidence.unsupported_claim_count > 0) {
    blockers.push({
      code: "unsupported_claims_present",
      severity: "blocker",
      message: `${claimEvidence.unsupported_claim_count} claim(s) lack sufficient artifact, citation, or evidence support.`,
      source: "claimEvidenceScoring"
    });
  }
  if (citationSupportIssues.length > 0) {
    rulesApplied.push("citation support 없음 -> related-work claim downgrade");
    blockers.push({
      code: "citation_support_missing",
      severity: "warning",
      message: `${citationSupportIssues.length} related-work claim(s) have missing or unresolved citation support and must be reviewed or downgraded.`,
      source: "claimEvidenceScoring"
    });
  }
  if (!figureAudit.measured) {
    rulesApplied.push("figure audit 없음 또는 ablation -> manuscript promotion 차단");
    blockers.push({
      code: figureAudit.audit_status === "ablated"
        ? "figure_audit_ablated"
        : "figure_audit_missing_or_malformed",
      severity: "blocker",
      message: figureAudit.audit_status === "ablated"
        ? "Figure audit is intentionally ablated; this comparison condition cannot authorize manuscript promotion."
        : "Figure audit evidence is missing or malformed; manuscript promotion fails closed.",
      source: "figureAuditScoring"
    });
  } else if ((figureAudit.severe_mismatch_count ?? 0) > 0 || figureAudit.review_block_required === true) {
    rulesApplied.push("figure/result mismatch 존재 -> manuscript promotion 차단");
    blockers.push({
      code: "figure_result_caption_mismatch",
      severity: "blocker",
      message: "Figure audit reports a severe mismatch or review block requirement.",
      source: "figureAuditScoring"
    });
  }
  for (const finding of researchScaleFindings) {
    blockers.push({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      source: "reviewResearchScaleArtifacts"
    });
  }
  for (const finding of executionIntegrityFindings) {
    blockers.push({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      source: "executionIntegrityAudit"
    });
  }
  if (evidenceStore.deterministicFallbackUsed && !evidenceStore.nonFallbackMetricEvidencePresent) {
    rulesApplied.push("fallback evidence만 존재 -> quantitative research claim 차단");
    blockers.push({
      code: "fallback_only_evidence",
      severity: "blocker",
      message: "Only deterministic fallback evidence is present; quantitative research claims are blocked.",
      source: "liveValidationScoring"
    });
  }
  if (activeRun) {
    rulesApplied.push("active run -> governance pass 차단");
    blockers.push({
      code: "run_execution_incomplete",
      severity: "blocker",
      message: `Run status is ${runStatus}; active execution cannot pass the research governance gate.`,
      source: "runRecord"
    });
  }
  if (failedRun) {
    rulesApplied.push("failed run -> governance pass 차단");
    blockers.push({
      code: "run_execution_failed",
      severity: "blocker",
      message: runFailureDetail
        ? `Run status is ${runStatus}; verifier detail: ${runFailureDetail}`
        : `Run status is ${runStatus}; failed execution must be repaired or explicitly superseded before governance promotion.`,
      source: "runRecord"
    });
  }
  if (failedRunHidden) {
    rulesApplied.push("failed run이 숨겨짐 -> blocked");
    blockers.push({
      code: "hidden_failed_run",
      severity: "blocker",
      message: "The run is marked failed while paper_ready=true; failed execution must remain visible.",
      source: "artifactContract"
    });
  }
  if (writePaperFailed) {
    rulesApplied.push("write_paper 실패 -> manuscript promotion 차단");
    blockers.push({
      code: "write_paper_failed",
      severity: "blocker",
      message: writePaperFailureMessage
        ? `write_paper failed: ${writePaperFailureMessage}`
        : "write_paper failed; generated manuscript artifacts are not accepted for paper-ready promotion.",
      source: "runRecord"
    });
  }
  for (const finding of designContractFindings) {
    blockers.push({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      source: "designContractEvidence"
    });
  }
  for (const finding of literatureDiscovery.findings) {
    blockers.push({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      source: "literatureDiscoveryAudit"
    });
  }
  const fallbackOnly = evidenceStore.deterministicFallbackUsed
    && !evidenceStore.nonFallbackMetricEvidencePresent;
  const doneConditionAudit = evaluateDoneConditionAudit({
    governanceCondition: input.artifacts.governanceConditionPayload,
    researchBriefText: input.artifacts.researchBriefText,
    paperReady,
    writePaperCompleted,
    missingBaselineOrComparator: resultTable.missing_baseline_count > 0 || resultTable.missing_comparator_count > 0,
    resultTableReady: resultTable.measured && resultTable.complete_row_count > 0,
    fallbackOnlyEvidence: fallbackOnly,
    failedRunHidden,
    runStatusKnown: Boolean(runStatus),
    unsupportedClaimCount: claimEvidence.unsupported_claim_count,
    citationSupportIssueCount: citationSupportIssues.length,
    figureAuditReady: figureAudit.measured,
    figureMismatchPresent:
      (figureAudit.severe_mismatch_count ?? 0) > 0 || figureAudit.review_block_required === true
  });
  if (!doneConditionAudit.measured) {
    blockers.push({
      code: "done_condition_unmeasured",
      severity: "blocker",
      message: "No governed done-condition source is available; completion cannot be evaluated.",
      source: "doneConditionAudit"
    });
  }
  if (paperReady && blockers.some((blocker) => blocker.severity === "blocker")) {
    blockers.push({
      code: "false_paper_ready_blocked",
      severity: "blocker",
      message: "paper_ready=true is contradicted by governance blockers and must not be accepted.",
      source: "governanceScorer"
    });
  }

  const governanceScore = scoreGovernanceTask({
    task_id: path.basename(input.artifacts.runRoot),
    paper_ready: paperReady,
    expected_paper_ready: false,
    unsupported_claim_count: claimEvidence.unsupported_claim_count,
    major_claim_count: claimEvidence.major_claim_count,
    supported_claim_count: claimEvidence.supported_claim_count,
    missing_required_artifact_count: contract.issues.length,
    missing_baseline_detected: resultTable.missing_baseline_count > 0 || resultTable.missing_comparator_count > 0,
    missing_baseline_passed: paperReady && (resultTable.missing_baseline_count > 0 || resultTable.missing_comparator_count > 0),
    figure_result_mismatch_count: figureAudit.severe_mismatch_count ?? 0,
    repair_action_count: blockers.length,
    placeholder: contract.issues.length > 0,
    unmeasured_reason: contract.issues.length > 0 ? "incomplete_artifact_contract" : undefined
  });

  const allowedLevel = resolveAllowedClaimLevel({
    blockers,
    resultTable,
    citationSupportIssues,
    fallbackOnly
  });
  if (allowedLevel === "research_memo_without_quantitative_claims"
      && containsQuantitativeResultClaim(input.artifacts.mainTexText)) {
    rulesApplied.push("quantitative claim ceiling -> manuscript result assertions blocked");
    blockers.push({
      code: "manuscript_quantitative_claim_ceiling_conflict",
      severity: "blocker",
      message: "The manuscript contains quantitative result assertions while the computed claim ceiling disallows quantitative claims.",
      source: "claimCeilingAudit"
    });
  }
  if (declaredAcademicCeiling
      && isAuditOutputClaimLevel(declaredAcademicCeiling)
      && declaredAcademicCeiling !== allowedLevel) {
    blockers.push({
      code: "claim_ceiling_conflict",
      severity: "blocker",
      message: `Declared academic claim ceiling ${declaredAcademicCeiling} conflicts with computed ceiling ${allowedLevel}.`,
      source: "claimCeilingAudit"
    });
  }
  if (declaredAcademicCeiling
      && boundDesignClaimCeilings.length > 0
      && (boundDesignClaimCeilings.length !== 1 || boundDesignClaimCeilings[0] !== declaredAcademicCeiling)) {
    blockers.push({
      code: "claim_ceiling_design_contract_conflict",
      severity: "blocker",
      message: `Declared academic claim ceiling ${declaredAcademicCeiling} is not uniquely bound by the design contract ceiling(s): ${boundDesignClaimCeilings.join(", ")}.`,
      source: "claimCeilingAudit"
    });
  }
  const verdict = resolveVerdict(blockers);
  const effectiveAllowedLevel = declaredAcademicCeiling && !isAuditOutputClaimLevel(declaredAcademicCeiling)
    ? declaredAcademicCeiling
    : allowedLevel;
  if (effectiveAllowedLevel !== allowedLevel) {
    rulesApplied.push(`declared scope ceiling preserved -> ${effectiveAllowedLevel}`);
    rulesApplied.push(`generic audit output level -> ${allowedLevel}`);
  }
  const relativeOutDir = relativePath(input.cwd, input.outDir, "<output>");
  const claimEvidenceExport = buildClaimEvidenceExport({
    claimEvidenceTableArtifact: input.artifacts.claimEvidenceTable,
    claimStatusTableArtifact: input.artifacts.claimStatusTable,
    evidenceLinksArtifact: input.artifacts.evidenceLinks,
    claimEvidenceScore: claimEvidence,
    unsupportedClaims
  });
  const claimPromotion = buildClaimPromotionTimeline({
    claimEvidenceExport,
    blockers,
    unsupportedClaims,
    citationSupportIssues,
    allowedClaimLevel: effectiveAllowedLevel
  });
  const reviewDecision = stringValue(input.artifacts.reviewDecision?.outcome)
    || stringValue(input.artifacts.reviewDecision?.decision)
    || stringValue(input.artifacts.reviewDecision?.recommendation);
  const auditTimeline = await buildAuditTimeline({
    runRoot: input.artifacts.runRoot,
    resultTableMeasured: resultTable.measured,
    resultTableCompleteRows: resultTable.complete_row_count,
    figureAuditStatus: figureAudit.audit_status,
    reviewDecision,
    claimCeilingAllowedLevel: effectiveAllowedLevel,
    paperReadinessVerdict: verdict,
    paperReady,
    blockers
  });
  const requiredOutputCount = contract.required_artifacts.length;
  const presentOutputCount = Math.max(0, requiredOutputCount - missingRequiredArtifacts.size);
  const autonomyMetrics = computeAuditAutonomyMetrics({
    timeline: auditTimeline,
    blockerCount: blockers.filter((blocker) => blocker.severity === "blocker").length,
    unsupportedClaimCount: claimEvidence.unsupported_claim_count,
    citationSupportIssueCount: citationSupportIssues.length,
    requiredOutputCount,
    presentOutputCount
  });

  return {
    claimEvidenceExport,
    auditTimeline,
    claimPromotionTimeline: claimPromotion.timeline,
    blockedClaimEvents: claimPromotion.blockedClaimEvents,
    doneConditionAudit,
    summary: {
    generated_at: new Date().toISOString(),
    verdict,
    input: {
      mode: input.external ? "external" : "run",
      run_root: relativePath(input.cwd, input.artifacts.runRoot, "<run-artifact-root>")
    },
    artifact_contract: {
      passed: contract.passed,
      required_artifacts: artifactContractEntries
    },
    outputs: {
      report_path: path.posix.join(relativeOutDir, "paper-readiness-audit.md"),
      summary_path: path.posix.join(relativeOutDir, "audit-summary.json"),
      blockers_path: path.posix.join(relativeOutDir, "blockers.json"),
      claim_evidence_path: path.posix.join(relativeOutDir, "claim-evidence-table.json"),
      audit_timeline_path: path.posix.join(relativeOutDir, "audit-timeline.json"),
      claim_promotion_timeline_path: path.posix.join(relativeOutDir, "claim-promotion-timeline.json"),
      blocked_claim_events_path: path.posix.join(relativeOutDir, "blocked-claim-events.json"),
      done_condition_path: path.posix.join(relativeOutDir, "done-condition-audit.json"),
      autonomy_metrics_path: path.posix.join(relativeOutDir, "autonomy-metrics.json"),
      ...(input.externalIntakeBindings
        ? { external_intake_manifest_path: input.externalIntakeBindings.manifest.path }
        : {})
    },
    ...(input.externalIntakeBindings ? { external_intake: input.externalIntakeBindings } : {}),
    top_blockers: blockers,
    unsupported_claims: unsupportedClaims,
    baseline_comparator_status: {
      status: !resultTable.measured
        ? "unmeasured"
        : resultTable.missing_baseline_count > 0 || resultTable.missing_comparator_count > 0
          ? "missing"
          : "present",
      missing_baseline_count: resultTable.missing_baseline_count,
      missing_comparator_count: resultTable.missing_comparator_count,
      comparative_claim_allowed: resultTable.comparative_claim_supported
        && resultTable.missing_baseline_count === 0
    },
    result_table_completeness: {
      measured: resultTable.measured,
      row_count: resultTable.row_count,
      complete_row_count: resultTable.complete_row_count,
      comparator_coverage: resultTable.comparator_coverage,
      paper_ready_allowed: resultTable.measured && resultTable.complete_row_count > 0
    },
    figure_result_caption_mismatch: {
      status: figureAudit.audit_status,
      severe_mismatch_count: figureAudit.severe_mismatch_count,
      manuscript_promotion_allowed:
        figureAudit.measured
        && figureAudit.severe_mismatch_count === 0
        && !figureAudit.review_block_required
    },
    citation_support_issues: citationSupportIssues,
    design_contract_findings: designContractFindings,
    research_scale_findings: researchScaleFindings,
    execution_integrity_findings: executionIntegrityFindings,
    claim_ceiling: {
      allowed_level: effectiveAllowedLevel,
      audit_output_level: allowedLevel,
      ...(declaredAcademicCeiling && !isAuditOutputClaimLevel(declaredAcademicCeiling)
        ? { declared_scope_level: declaredAcademicCeiling }
        : {}),
      rules_applied: [...new Set(rulesApplied)]
    },
    paper_readiness: {
      paper_ready: paperReady,
      ...(readinessState ? { readiness_state: readinessState } : {}),
      write_paper_completed: writePaperCompleted
    },
    judge_lane: {
      planner_worker_nodes: [
        "collect_papers",
        "analyze_papers",
        "generate_hypotheses",
        "design_experiments",
        "implement_experiments",
        "run_experiments",
        "analyze_results"
      ],
      judge_nodes: ["figure_audit", "review", "paper_readiness_audit"],
      audit_report_label: "judge_lane_evidence_governance"
    },
    audit_timeline: {
      status: auditTimeline.status,
      measured: auditTimeline.measured,
      entry_count: auditTimeline.entries.length,
      event_count: auditTimeline.event_count,
      checkpoint_count: auditTimeline.checkpoint_count,
      omitted_entry_count: auditTimeline.omitted_entry_count
    },
    done_condition: {
      status: doneConditionAudit.status,
      measured: doneConditionAudit.measured,
      declared_source: doneConditionAudit.declared_source,
      failure_count: doneConditionAudit.failures.length,
      warning_count: doneConditionAudit.warnings.length
    },
    autonomy_metrics: autonomyMetrics,
    scorer_outputs: {
      result_table: resultTable,
      claim_evidence: claimEvidence,
      figure_audit: figureAudit,
      literature_discovery: literatureDiscovery,
      ...(liveValidation ? { live_validation: liveValidation } : {}),
      governance_score: governanceScore
    },
    next_action_checklist: buildNextActions(blockers)
    }
  };
}

function isAuditOutputClaimLevel(value: string): boolean {
  return new Set([
    "blocked_until_failed_run_is_visible",
    "system_validation_note_only",
    "research_memo_without_quantitative_claims",
    "descriptive_only_no_comparative_claims",
    "result_claims_allowed_related_work_downgraded",
    "needs_repair_before_manuscript_promotion",
    "conditional_claims_with_artifact_links"
  ]).has(value);
}

function resolveComparisonClaimAuthorization(
  payloads: Array<{ path: string; payload: Record<string, unknown> }>
): {
  comparativeClaimAuthorized: boolean;
  superiorityClaimAuthorized: boolean;
  superiorityPrimaryMetrics: string[];
  primaryComparisonId?: string;
} {
  const comparativeDeclarations = payloads
    .map(({ payload }) => payload.comparative_claim_authorized)
    .filter((value): value is boolean => typeof value === "boolean");
  const superiorityDeclarations = payloads
    .map(({ payload }) => payload.superiority_claim_authorized)
    .filter((value): value is boolean => typeof value === "boolean");
  const primaryMetricDeclarations = payloads
    .map(({ payload }) => payload.superiority_primary_metrics)
    .filter((value): value is string[] =>
      Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0)
    );
  const firstPrimaryMetrics = primaryMetricDeclarations[0] ?? [];
  const primaryMetricsAgree = primaryMetricDeclarations.length > 0
    && primaryMetricDeclarations.every((metrics) =>
      JSON.stringify([...metrics].sort()) === JSON.stringify([...firstPrimaryMetrics].sort())
    );
  const comparativeClaimAuthorized = comparativeDeclarations.length > 0
    && comparativeDeclarations.every((value) => value);
  const primaryComparisonDeclarations = payloads
    .map(({ payload }) => recordValue(payload.results_plan))
    .filter((plan): plan is Record<string, unknown> => Boolean(plan))
    .filter((plan) => validateResultsPlanV2(plan).valid)
    .map((plan) => stringValue(plan.primary_comparison_id))
    .filter((value): value is string => Boolean(value));
  const primaryComparisonId = primaryComparisonDeclarations.length > 0
    && primaryComparisonDeclarations.every((value) => value === primaryComparisonDeclarations[0])
    ? primaryComparisonDeclarations[0]
    : undefined;
  return {
    comparativeClaimAuthorized,
    superiorityClaimAuthorized: comparativeClaimAuthorized
      && superiorityDeclarations.length > 0
      && superiorityDeclarations.every((value) => value),
    superiorityPrimaryMetrics: primaryMetricsAgree ? [...firstPrimaryMetrics] : [],
    ...(primaryComparisonId ? { primaryComparisonId } : {})
  };
}

async function loadRunArtifacts(runRoot: string): Promise<LoadedRunArtifacts> {
  const conditionPayload = await readOptionalJson<Record<string, unknown>>(path.join(runRoot, "governance_condition.json"));
  const academicClaimEvidenceMap = await readOptionalJson<Record<string, unknown>>(
    path.join(runRoot, "paper", "academic_claim_evidence_map.json")
  );
  const academicReferenceEvidenceStatus = await readOptionalJson<Record<string, unknown>>(
    path.join(runRoot, "paper", "reference_evidence_status.json")
  );
  const academicSubmissionStatus = await readOptionalJson<Record<string, unknown>>(
    path.join(runRoot, "paper", "submission_status.json")
  );
  const referenceClaimInventory = await readReferenceClaimInventory(
    path.join(runRoot, "paper", "refgate_claims.tsv")
  );
  const explicitClaimEvidenceTable = await readOptionalJson(path.join(runRoot, "paper", "claim_evidence_table.json"));
  const explicitClaimStatusTable = await readOptionalJson(path.join(runRoot, "paper", "claim_status_table.json"));
  return {
    runRoot,
    availableArtifactRefs: await listRegularArtifactRefs(runRoot),
    condition: parseConditionName(conditionPayload),
    resultTable: await readOptionalJson(path.join(runRoot, "result_table.json")),
    claimEvidenceTable: explicitClaimEvidenceTable ?? normalizeAcademicClaimEvidenceTable(academicClaimEvidenceMap),
    claimStatusTable: explicitClaimStatusTable ?? normalizeAcademicClaimStatusTable(academicClaimEvidenceMap),
    evidenceLinks: await readOptionalJson(path.join(runRoot, "paper", "evidence_links.json")),
    evidenceGateDecision: await readOptionalJson<Record<string, unknown>>(path.join(runRoot, "paper", "evidence_gate_decision.json")),
    paperReadiness: await readOptionalJson<Record<string, unknown>>(path.join(runRoot, "paper", "paper_readiness.json")),
    reviewDecision: await readOptionalJson<Record<string, unknown>>(path.join(runRoot, "review", "decision.json")),
    figureAuditSummary: await readOptionalJson<FigureAuditSummary>(path.join(runRoot, "figure_audit", "figure_audit_summary.json")),
    runRecord: await readOptionalJson<Record<string, unknown>>(path.join(runRoot, "run_record.json")),
    runConfig: await readOptionalJson<Record<string, unknown>>(path.join(runRoot, "run_config.json")),
    experimentEvidence: await readOptionalJson<Record<string, unknown>>(path.join(runRoot, "experiment_evidence.json")),
    checkpointState: await readFirstOptionalJson(runRoot, [
      path.join("checkpoint", "state.json"),
      "checkpoint.json",
      "state.json"
    ]),
    runExperimentsVerifierReport: await readOptionalJson<Record<string, unknown>>(
      path.join(runRoot, "run_experiments_verify_report.json")
    ),
    evidenceStoreLines: await readJsonl(path.join(runRoot, "evidence_store.jsonl")),
    designContractPayloads: await readDesignContractPayloads(runRoot),
    literatureDiscoveryPayloads: await readLiteratureDiscoveryPayloads(runRoot),
    paperScaleDiagnostics: await readOptionalJson<Record<string, unknown>>(
      path.join(runRoot, "review", "paper_scale_diagnostics.json")
    ),
    nodeStrengtheningRecommendations: await readOptionalJson<Record<string, unknown>>(
      path.join(runRoot, "review", "node_strengthening_recommendations.json")
    ),
    governanceConditionPayload: conditionPayload,
    researchBriefText: await readResearchBriefText(runRoot),
    mainTexExists: await fileExists(path.join(runRoot, "paper", "main.tex")),
    mainTexText: await readOptionalText(path.join(runRoot, "paper", "main.tex")),
    academicClaimEvidenceMap,
    academicReferenceEvidenceStatus,
    academicSubmissionStatus,
    referenceClaimInventory
  };
}

async function listRegularArtifactRefs(runRoot: string): Promise<string[]> {
  const refs: string[] = [];
  const pending: Array<{ absolute: string; relative: string }> = [
    { absolute: runRoot, relative: "" }
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
    try {
      entries = await fs.readdir(current.absolute, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = current.relative
        ? path.posix.join(current.relative, entry.name)
        : entry.name;
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) {
        pending.push({ absolute, relative });
      } else if (entry.isFile()) {
        refs.push(relative.replace(/\\/gu, "/"));
      }
    }
  }
  return refs.sort();
}

function normalizeAcademicClaimEvidenceTable(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const claims = recordArray(value?.claims);
  if (claims.length === 0) return undefined;
  return {
    claims: claims.map((claim) => ({
      claim_id: stringValue(claim.claim_id),
      statement: stringValue(claim.statement) || stringValue(claim.claim),
      artifact_refs: stringArray(claim.artifact_refs),
      citation_refs: stringArray(claim.citation_refs),
      evidence_ids: stringArray(claim.evidence_ids)
    }))
  };
}

function normalizeAcademicClaimStatusTable(
  value: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const claims = recordArray(value?.claims);
  if (claims.length === 0) return undefined;
  return {
    claims: claims.map((claim) => ({
      claim_id: stringValue(claim.claim_id),
      statement: stringValue(claim.statement) || stringValue(claim.claim),
      status: normalizeAcademicClaimStatus(stringValue(claim.status)),
      declared_status: stringValue(claim.status),
      artifact_refs: stringArray(claim.artifact_refs),
      citation_refs: stringArray(claim.citation_refs),
      reproduction_trace_present: stringArray(claim.artifact_refs).length > 0
    }))
  };
}

function normalizeAcademicClaimStatus(status: string | undefined): string {
  if (
    status === "verified"
    || status === "supported"
    || status === "supported_by_code_and_tests"
    || status === "supported_with_scope_limitation"
    || status === "supported_with_task_gold_mismatch"
    || status === "supported_with_local_runtime_boundary"
  ) return "verified";
  if (status === "development_only") return "development_only";
  if (status === "blocked") return "blocked";
  return "unverified";
}

async function readReferenceClaimInventory(filePath: string): Promise<{
  present: boolean;
  valid: boolean;
  rows: ReferenceClaimRow[];
}> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return { present: true, valid: true, rows: parseReferenceClaimsTsv(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, valid: true, rows: [] };
    }
    return { present: true, valid: false, rows: [] };
  }
}

function getRunFailureDetail(report: Record<string, unknown> | undefined): string | undefined {
  if (!report || stringValue(report.status)?.toLowerCase() !== "fail") {
    return undefined;
  }
  const stage = stringValue(report.stage);
  const summary = stringValue(report.summary);
  const suggestedAction = stringValue(report.suggested_next_action);
  const detail = [
    stage ? `stage=${stage}` : undefined,
    summary ? portableFailureText(summary) : undefined,
    suggestedAction ? `next=${portableFailureText(suggestedAction)}` : undefined
  ].filter((value): value is string => Boolean(value)).join("; ");
  return detail ? detail.slice(0, 900) : undefined;
}

function portableFailureText(value: string): string {
  return value
    .replace(/`torch_dtype` is deprecated! Use `dtype` instead!/gu, "")
    .replace(/\bLoading weights:[\s\S]*$/gu, "")
    .replace(/(?:[A-Za-z]:[\\/][^\s|;:,]+|\/(?:home|Users|tmp|var|mnt|workspace)(?:\/[^\s|;:,]+)+)/gu, "<path>")
    .replace(/\s+/gu, " ")
    .trim();
}

function collectUnsupportedClaims(
  artifacts: LoadedRunArtifacts,
  claimEvidence: ClaimEvidenceScore
): PaperReadinessAuditUnsupportedClaim[] {
  const claims = claimRows(artifacts);
  const byId = new Map(claims.map((claim) => [claim.claim_id, claim] as const));
  const academicById = new Map(recordArray(artifacts.academicClaimEvidenceMap?.claims)
    .map((claim) => [stringValue(claim.claim_id), claim] as const)
    .filter((entry): entry is [string, Record<string, unknown>] => Boolean(entry[0])));
  return claimEvidence.issues
    .filter((issue) => issue.code !== "claim_evidence_blocked")
    .map((issue) => {
    const academicClaim = academicById.get(issue.claim_id);
    const missingEvidence = stringArray(academicClaim?.missing_evidence);
    const academicallyBlocked = stringValue(academicClaim?.status) === "blocked";
    return {
      claim_id: issue.claim_id,
      message: issue.message,
      status: academicallyBlocked ? "blocked" : "unsupported",
      ...(byId.get(issue.claim_id)?.status
        ? { declared_status: byId.get(issue.claim_id)?.status }
        : {}),
      statement: byId.get(issue.claim_id)?.statement,
      ...(academicallyBlocked
        ? {
            target_node: targetNodeForAcademicEvidence(missingEvidence),
            evidence_path: path.posix.join("paper", "academic_claim_evidence_map.json"),
            recheck_condition: "Every missing-evidence item is verified and the academic claim status is no longer blocked."
          }
        : {})
    };
    });
}

function collectCitationSupportIssues(
  artifacts: LoadedRunArtifacts
): PaperReadinessAuditUnsupportedClaim[] {
  const issues: PaperReadinessAuditUnsupportedClaim[] = claimRows(artifacts)
    .filter((claim) =>
      /related|literature|prior work|background/iu.test(claim.section_heading)
        && claim.citation_refs.length === 0
    )
    .map((claim) => ({
      claim_id: claim.claim_id,
      message: `Related-work claim ${claim.claim_id} has no citation support.`,
      status: claim.status,
      statement: claim.statement
    }));
  if (artifacts.referenceClaimInventory.valid) {
    for (const claim of artifacts.referenceClaimInventory.rows) {
      if (claim.status.trim().toLowerCase() === "checked") continue;
      issues.push({
        claim_id: claim.claim_id,
        message: `Citation claim ${claim.claim_id} is marked ${claim.status || "unresolved"}.`,
        status: claim.status,
        statement: claim.claim_text,
        target_node: claim.status === "claim_unchecked" ? "collect_papers" : "analyze_papers",
        evidence_path: path.posix.join("paper", "refgate_claims.tsv"),
        recheck_condition: "The claim is marked checked only after exact full-text evidence and independent review pass."
      });
    }
  }
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.claim_id}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectDesignContractFindings(
  artifacts: LoadedRunArtifacts
): PaperReadinessAuditDesignContractFinding[] {
  const findings: PaperReadinessAuditDesignContractFinding[] = [];
  for (const item of artifacts.designContractPayloads) {
    const rows = [
      ...recordArray(item.payload.findings),
      ...recordArray(item.payload.contract_findings),
      ...recordArray(item.payload.audit_findings)
    ];
    for (const row of rows) {
      if (row.advisory_only === true || row.design_note_only === true) {
        continue;
      }
      const code = stringValue(row.code) || stringValue(row.contract);
      const message = stringValue(row.message) || stringValue(row.summary);
      if (!code || !message) {
        continue;
      }
      findings.push({
        code,
        severity: parseFindingSeverity(row.severity),
        message,
        evidence_path: stringValue(row.evidence_path) || item.path
      });
    }

    const hiddenFailedWorkerCount = numberValue(item.payload.hidden_failed_worker_count);
    if (hiddenFailedWorkerCount > 0 && stringValue(item.payload.failed_worker_visibility) !== "visible") {
      findings.push({
        code: "distributed_worker_failure_hidden",
        severity: "blocker",
        message: `${hiddenFailedWorkerCount} failed worker run(s) are recorded without visible failed-run preservation.`,
        evidence_path: item.path
      });
    }
    if (item.payload.reverse_from_data_origin === true && item.payload.exploratory_origin_visible !== true) {
      findings.push({
        code: "reverse_from_data_origin_hidden",
        severity: "warning",
        message: "Reverse-from-data exploratory origin is recorded but not visible in the audit handoff.",
        evidence_path: item.path
      });
    }
    if (item.payload.sota_ranking_claimed === true && item.payload.sota_evidence_present !== true) {
      findings.push({
        code: "unsupported_sota_ranking",
        severity: "warning",
        message: "A SOTA/ranking claim is recorded without supporting ranking evidence.",
        evidence_path: item.path
      });
    }
    if (item.payload.plugin_manifest_gate_bypassed === true) {
      findings.push({
        code: "plugin_manifest_gate_bypassed",
        severity: "blocker",
        message: "A domain-plugin manifest gate bypass is recorded in artifact evidence.",
        evidence_path: item.path
      });
    }
  }
  return dedupeDesignFindings(findings);
}

function collectResearchScaleFindings(
  artifacts: LoadedRunArtifacts
): PaperReadinessAuditResearchScaleFinding[] {
  const findings: PaperReadinessAuditResearchScaleFinding[] = [];
  const diagnosticsPath = path.posix.join("review", "paper_scale_diagnostics.json");
  for (const row of recordArray(artifacts.paperScaleDiagnostics?.diagnostics)) {
    const code = stringValue(row.id);
    const targetNode = governedResearchNode(row.target_node) || governedResearchNode(row.source_node);
    if (!code) {
      continue;
    }
    findings.push({
      code,
      severity: row.severity === "blocking" ? "blocker" : "warning",
      message: `Research-scale diagnostic ${code} must be resolved or explicitly governed down before manuscript promotion.`,
      ...(targetNode ? { target_node: targetNode, target_surface: "validator" as const } : {}),
      evidence_path: diagnosticsPath,
      ...(stringValue(row.recheck_condition)
        ? { recheck_condition: stringValue(row.recheck_condition) }
        : {})
    });
  }

  const recommendationsPath = path.posix.join("review", "node_strengthening_recommendations.json");
  for (const row of recordArray(artifacts.nodeStrengtheningRecommendations?.recommendations)) {
    const targetNode = governedResearchNode(row.node);
    if (!targetNode) {
      continue;
    }
    findings.push({
      code: `node_strengthening_recommendation:${targetNode}`,
      severity: row.priority === "high" ? "blocker" : "warning",
      message: `Review evidence requires strengthening the ${targetNode} node before manuscript promotion.`,
      target_node: targetNode,
      target_surface: "prompt",
      evidence_path: recommendationsPath,
      ...(stringValue(row.recheck_condition)
        ? { recheck_condition: stringValue(row.recheck_condition) }
        : {})
    });
  }

  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}\u0000${finding.target_node || ""}\u0000${finding.evidence_path}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function collectAcademicPackageFindings(
  artifacts: LoadedRunArtifacts
): PaperReadinessAuditResearchScaleFinding[] {
  const findings: PaperReadinessAuditResearchScaleFinding[] = [
    ...collectReferenceAnchorFindings(artifacts)
  ];
  const submissionStatus = artifacts.academicSubmissionStatus;
  const submissionRequirements = stringArray(submissionStatus?.blocking_requirements);
  if (submissionStatus?.paper_ready === true && submissionRequirements.length > 0) {
    findings.push({
      code: "submission_status_contradiction",
      severity: "blocker",
      message: "The academic package declares paper_ready=true while submission requirements remain open.",
      target_node: "review",
      target_surface: "validator",
      evidence_path: path.posix.join("paper", "submission_status.json"),
      recheck_condition: "paper_ready is false or every declared submission requirement is closed by verified evidence."
    });
  }

  const requirementsByNode = new Map<string, string[]>();
  for (const requirement of submissionRequirements) {
    const targetNode = targetNodeForAcademicRequirement(requirement);
    const grouped = requirementsByNode.get(targetNode) || [];
    grouped.push(requirement);
    requirementsByNode.set(targetNode, grouped);
  }
  for (const [targetNode, requirements] of requirementsByNode) {
    findings.push({
      code: `submission_requirements_open:${targetNode}`,
      severity: "blocker",
      message: `${requirements.length} submission requirement(s) remain open for ${targetNode}: ${requirements.join(", ")}.`,
      target_node: targetNode,
      target_surface: "validator",
      evidence_path: path.posix.join("paper", "submission_status.json"),
      recheck_condition: "Every listed requirement is removed only after its bound evidence passes the submission gate."
    });
  }

  const referenceStatus = artifacts.academicReferenceEvidenceStatus;
  const referenceSummary = recordValue(referenceStatus?.summary);
  const missingFullTextCount = numberValue(referenceSummary?.missing_full_text_claim_count);
  const claimCount = numberValue(referenceSummary?.citation_bearing_claim_count);
  const checkedClaimCount = numberValue(referenceSummary?.independently_checked_claim_count);
  if (!referenceStatus && artifacts.paperReadiness?.paper_ready === true) {
    findings.push({
      code: "reference_submission_gate_missing",
      severity: "blocker",
      message: "The package declares paper_ready=true without an authoritative reference evidence status.",
      target_node: "analyze_papers",
      target_surface: "validator",
      evidence_path: path.posix.join("paper", "reference_evidence_status.json"),
      recheck_condition: "A reference evidence status exists and reports submission_gate_passed=true after independent claim review."
    });
  }
  if (referenceStatus && referenceStatus.submission_gate_passed !== true) {
    findings.push({
      code: "reference_submission_gate_not_passed",
      severity: "blocker",
      message: "The reference evidence status does not report a passing authoritative submission gate.",
      target_node: "analyze_papers",
      target_surface: "validator",
      evidence_path: path.posix.join("paper", "reference_evidence_status.json"),
      recheck_condition: "The independently verified reference submission gate reports submission_gate_passed=true."
    });
  }
  if (missingFullTextCount > 0) {
    findings.push({
      code: "reference_full_text_missing",
      severity: "blocker",
      message: `${missingFullTextCount} citation-bearing claim(s) lack a mapped full-text source.`,
      target_node: "collect_papers",
      target_surface: "validator",
      evidence_path: path.posix.join("paper", "reference_evidence_status.json"),
      recheck_condition: "Every citation-bearing claim is bound to an exact, title-aligned full-text source."
    });
  }
  if (claimCount > checkedClaimCount) {
    findings.push({
      code: "reference_claim_review_incomplete",
      severity: "blocker",
      message: `${claimCount - checkedClaimCount} of ${claimCount} citation-bearing claim(s) still require independent full-text review.`,
      target_node: "analyze_papers",
      target_surface: "validator",
      evidence_path: path.posix.join("paper", "reference_evidence_status.json"),
      recheck_condition: "The independently checked claim count equals the citation-bearing claim count and the reference submission gate passes."
    });
  }
  if (artifacts.referenceClaimInventory.present && !artifacts.referenceClaimInventory.valid) {
    findings.push({
      code: "reference_claim_inventory_invalid",
      severity: "blocker",
      message: "The academic package contains a malformed Refgate claim inventory.",
      target_node: "analyze_papers",
      target_surface: "validator",
      evidence_path: path.posix.join("paper", "refgate_claims.tsv"),
      recheck_condition: "The Refgate claim inventory parses with the canonical schema."
    });
  }
  if (!artifacts.referenceClaimInventory.present && artifacts.paperReadiness?.paper_ready === true) {
    findings.push({
      code: "reference_claim_inventory_missing",
      severity: "blocker",
      message: "The package declares paper_ready=true without a canonical Refgate claim inventory.",
      target_node: "analyze_papers",
      target_surface: "validator",
      evidence_path: path.posix.join("paper", "refgate_claims.tsv"),
      recheck_condition: "The canonical Refgate claim inventory exists and every citation-bearing claim is checked."
    });
  }

  for (const claim of recordArray(artifacts.academicClaimEvidenceMap?.claims)) {
    if (stringValue(claim.status) !== "blocked") continue;
    const claimId = stringValue(claim.claim_id) || "unknown";
    const missingEvidence = stringArray(claim.missing_evidence);
    const requirementsByNode = groupAcademicEvidenceByNode(missingEvidence);
    if (requirementsByNode.size === 0) requirementsByNode.set("review", []);
    for (const [targetNode, requirements] of requirementsByNode) {
      findings.push({
        code: `academic_claim_evidence_blocked:${claimId}:${targetNode}`,
        severity: "blocker",
        message: `Academic claim ${claimId} remains blocked by ${requirements.length || "unresolved"} ${targetNode} evidence requirement(s).`,
        target_node: targetNode,
        target_surface: "validator",
        evidence_path: path.posix.join("paper", "academic_claim_evidence_map.json"),
        recheck_condition: "The claim status changes only after every declared missing-evidence item is verified."
      });
    }
  }

  return findings;
}

function collectReferenceAnchorFindings(
  artifacts: LoadedRunArtifacts
): PaperReadinessAuditResearchScaleFinding[] {
  if (!artifacts.referenceClaimInventory.valid || artifacts.referenceClaimInventory.rows.length === 0) {
    return [];
  }
  if (!artifacts.mainTexText) {
    return [{
      code: "citation_anchor_manuscript_missing",
      severity: "blocker",
      message: "Citation anchors cannot be checked because paper/main.tex is missing or empty.",
      target_node: "write_paper",
      target_surface: "validator",
      evidence_path: path.posix.join("paper", "main.tex"),
      recheck_condition: "A non-empty projected manuscript is present and every citation anchor is revalidated."
    }];
  }

  const manuscriptLines = artifacts.mainTexText.split(/\r?\n/u);
  return artifacts.referenceClaimInventory.rows.flatMap((claim) => {
    const location = /^lines?\s+(\d+)(?:\s*[-\u2013]\s*(\d+))?$/iu.exec(claim.manuscript_location.trim());
    const startLine = Number(location?.[1]);
    const endLine = Number(location?.[2] || location?.[1]);
    if (!location || startLine < 1 || endLine < startLine || endLine > manuscriptLines.length) {
      return [{
        code: `citation_anchor_invalid:${claim.claim_id}`,
        severity: "blocker" as const,
        message: `Citation claim ${claim.claim_id} has an invalid manuscript location: ${claim.manuscript_location}.`,
        target_node: "analyze_papers",
        target_surface: "validator" as const,
        evidence_path: path.posix.join("paper", "refgate_claims.tsv"),
        recheck_condition: "The one-based line anchor resolves inside paper/main.tex."
      }];
    }

    const anchorLine = manuscriptLines[startLine - 1] || "";
    const firstClaimToken = firstSignificantClaimToken(claim.claim_text);
    const anchorTokens = new Set(normalizedTextTokens(anchorLine));
    const claimStartsAtAnchor = Boolean(firstClaimToken && anchorTokens.has(firstClaimToken));
    const citationWindow = manuscriptLines.slice(startLine - 1, Math.min(manuscriptLines.length, endLine + 4)).join("\n");
    const citationKeys = citationKeysInTex(citationWindow);
    if (claimStartsAtAnchor && citationKeys.has(claim.citation_key)) {
      return [];
    }

    const failedChecks = [
      !claimStartsAtAnchor ? `claim onset token ${firstClaimToken || "<none>"}` : undefined,
      !citationKeys.has(claim.citation_key) ? `citation key ${claim.citation_key}` : undefined
    ].filter((value): value is string => Boolean(value));
    return [{
      code: `citation_anchor_mismatch:${claim.claim_id}`,
      severity: "blocker" as const,
      message: `Citation claim ${claim.claim_id} anchor ${claim.manuscript_location} does not bind ${failedChecks.join(" and ")} to the projected manuscript.`,
      target_node: "analyze_papers",
      target_surface: "validator" as const,
      evidence_path: path.posix.join("paper", "refgate_claims.tsv"),
      recheck_condition: "The declared line contains the claim onset and its citation key appears in the same forward sentence window."
    }];
  });
}

const CLAIM_ANCHOR_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "in", "is", "it", "of", "on", "or", "that", "the", "their", "this", "to", "was", "were", "with"
]);

function normalizedTextTokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/gu) || [];
}

function firstSignificantClaimToken(value: string): string | undefined {
  return normalizedTextTokens(value).find((token) => token.length >= 3 && !CLAIM_ANCHOR_STOP_WORDS.has(token));
}

function citationKeysInTex(value: string): Set<string> {
  const keys = new Set<string>();
  for (const match of value.matchAll(/\\cite[a-zA-Z*]*\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/gu)) {
    for (const key of (match[1] || "").split(",")) {
      if (key.trim()) keys.add(key.trim());
    }
  }
  return keys;
}

function targetNodeForAcademicRequirement(requirement: string): string {
  const normalized = requirement.toLowerCase();
  if (/independent.*(?:full[_-]?text|reference|citation).*review|review.*(?:full[_-]?text|reference|citation)/u.test(normalized)) {
    return "analyze_papers";
  }
  if (/(full[_-]?text|source[_-]?license)/u.test(normalized)) return "collect_papers";
  if (/(reference|citation|refgate)/u.test(normalized)) return "analyze_papers";
  if (/(acl|template|format)/u.test(normalized)) return "write_paper";
  if (/(review|adjudicat|mutation[_-]?isolation)/u.test(normalized)) return "review";
  if (/(canonical|bundle|held[_-]?out|execution|provider|recovery|experiment|post[_-]?repair)/u.test(normalized)) {
    return "run_experiments";
  }
  return "review";
}

function targetNodeForAcademicEvidence(missingEvidence: string[]): string {
  const nodes = [...groupAcademicEvidenceByNode(missingEvidence).keys()];
  return [
    "run_experiments",
    "collect_papers",
    "analyze_papers",
    "write_paper",
    "review"
  ].find((node) => nodes.includes(node)) || "review";
}

function groupAcademicEvidenceByNode(missingEvidence: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const requirement of missingEvidence) {
    const targetNode = targetNodeForAcademicRequirement(requirement);
    const requirements = grouped.get(targetNode) || [];
    requirements.push(requirement);
    grouped.set(targetNode, requirements);
  }
  return grouped;
}

function collectExecutionIntegrityFindings(
  artifacts: LoadedRunArtifacts
): PaperReadinessAuditExecutionIntegrityFinding[] {
  const findings: PaperReadinessAuditExecutionIntegrityFinding[] = [];
  const plannedBudget = recordValue(artifacts.runConfig?.planned_budget);
  const executedBudget = recordValue(artifacts.runRecord?.executed_budget);
  const plannedTrials = numberValue(plannedBudget?.trials);
  const executedTrials = numberValue(executedBudget?.trials);
  const developmentEvidence = recordValue(artifacts.academicSubmissionStatus?.development_evidence);
  const evaluationContract = recordValue(artifacts.academicSubmissionStatus?.controlled_evaluation_contract)
    || recordValue(artifacts.academicSubmissionStatus?.confirmatory_evaluation_contract);
  const evaluationTrialCount = numberValue(evaluationContract?.real_model_trial_count);
  const externalTrialCount = evaluationTrialCount > 0
    ? evaluationTrialCount
    : numberValue(developmentEvidence?.real_model_trial_count);
  const externalExecutionStatus = evaluationTrialCount > 0
    ? stringValue(evaluationContract?.execution_provenance_status)
    : stringValue(developmentEvidence?.execution_provenance_status);

  if (externalTrialCount > 0 && externalExecutionStatus !== "verified") {
    findings.push({
      code: "reported_trial_provenance_unverified",
      severity: "blocker",
      message: `The academic package reports ${externalTrialCount} model trial(s), but execution provenance is ${externalExecutionStatus || "unreported"}.`,
      evidence_path: path.posix.join("paper", "submission_status.json"),
      target_node: "run_experiments"
    });
  }

  if (plannedTrials > 1) {
    const trials = recordArray(artifacts.experimentEvidence?.trials);
    const provenanceKeys = trials.map(trialProvenanceKey);
    const missingProvenanceCount = trials.length === 0
      ? plannedTrials
      : provenanceKeys.filter((value) => !value).length;
    const distinctProvenanceCount = new Set(provenanceKeys.filter((value) => value.length > 0)).size;
    const plannedSeeds = provenanceScalarArray(
      artifacts.runConfig?.planned_seeds ?? plannedBudget?.seeds
    );
    const seedScheduleIncomplete = plannedSeeds.length > 0 && !hasCompleteConditionSeedSchedule({
      trials,
      plannedTrials,
      plannedSeeds
    });
    if (
      trials.length < plannedTrials
      || missingProvenanceCount > 0
      || distinctProvenanceCount < plannedTrials
      || seedScheduleIncomplete
    ) {
      findings.push({
        code: "repeated_run_provenance_missing",
        severity: "blocker",
        message: seedScheduleIncomplete
          ? `Repeated-run contract declares ${plannedTrials} trial(s), but planned and executed seed provenance is incomplete, reused, or inconsistent.`
          : `Repeated-run contract declares ${plannedTrials} trial(s), but distinct trial-level provenance is incomplete, missing, or reused.`,
        evidence_path: "experiment_evidence.json",
        target_node: "run_experiments"
      });
    }
  }

  if (plannedTrials > 0 && executedTrials > 0 && plannedTrials !== executedTrials) {
    findings.push({
      code: "budget_contract_mismatch",
      severity: "blocker",
      message: `Declared trial budget (${plannedTrials}) does not match executed trial count (${executedTrials}).`,
      evidence_path: "run_config.json + run_record.json",
      target_node: "run_experiments"
    });
  }

  const checkpointPaperReady = artifacts.checkpointState?.paper_ready;
  const publicPaperReady = artifacts.paperReadiness?.paper_ready;
  if (typeof checkpointPaperReady === "boolean" && typeof publicPaperReady === "boolean"
      && checkpointPaperReady !== publicPaperReady) {
    findings.push({
      code: "stale_persisted_state",
      severity: "blocker",
      message: "Checkpoint paper-readiness state disagrees with the public paper-readiness artifact.",
      evidence_path: "checkpoint/state.json + paper/paper_readiness.json",
      target_node: "review"
    });
  }
  return findings;
}

function trialProvenanceKey(value: Record<string, unknown>): string {
  for (const key of ["trial_id", "run_id"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === null || value[key] === "") continue;
    return `${key}:${String(value[key])}`;
  }
  const seed = trialSeedValue(value);
  if (seed) {
    const condition = trialConditionValue(value);
    return condition ? `condition:${condition}|seed:${seed}` : `seed:${seed}`;
  }
  return "";
}

function trialSeedValue(value: Record<string, unknown>): string {
  for (const key of ["seed", "seed_id", "random_seed", "evaluation_seed"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === null || value[key] === "") continue;
    return String(value[key]);
  }
  return "";
}

function trialConditionValue(value: Record<string, unknown>): string {
  for (const key of ["condition_id", "condition", "condition_marker", "configuration_id", "variant_id"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === null || value[key] === "") continue;
    return String(value[key]);
  }
  return "";
}

function hasCompleteConditionSeedSchedule(input: {
  trials: Record<string, unknown>[];
  plannedTrials: number;
  plannedSeeds: string[];
}): boolean {
  const plannedSeedSet = new Set(input.plannedSeeds);
  if (
    plannedSeedSet.size === 0
    || input.trials.length !== input.plannedTrials
    || input.plannedTrials % plannedSeedSet.size !== 0
  ) {
    return false;
  }

  const expectedConditionCount = input.plannedTrials / plannedSeedSet.size;
  const groups = new Map<string, string[]>();
  for (const trial of input.trials) {
    const seed = trialSeedValue(trial);
    const declaredCondition = trialConditionValue(trial);
    if (!seed || (expectedConditionCount > 1 && !declaredCondition)) return false;
    const condition = declaredCondition || "<single-condition>";
    const seeds = groups.get(condition) || [];
    seeds.push(seed);
    groups.set(condition, seeds);
  }

  if (groups.size !== expectedConditionCount) return false;
  for (const seeds of groups.values()) {
    if (seeds.length !== plannedSeedSet.size || !sameStringSet([...plannedSeedSet], seeds)) {
      return false;
    }
  }
  return true;
}

function provenanceScalarArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item) => (typeof item === "string" && item.trim().length > 0) || (typeof item === "number" && Number.isFinite(item)))
        .map((item) => String(item).trim())
    : [];
}

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function governedResearchNode(value: unknown): string | undefined {
  const node = stringValue(value);
  return node && GOVERNED_RESEARCH_NODES.has(node) ? node : undefined;
}

const GOVERNED_RESEARCH_NODES = new Set([
  "collect_papers",
  "analyze_papers",
  "generate_hypotheses",
  "design_experiments",
  "implement_experiments",
  "run_experiments",
  "analyze_results",
  "figure_audit",
  "review",
  "write_paper"
]);

function dedupeDesignFindings(
  findings: PaperReadinessAuditDesignContractFinding[]
): PaperReadinessAuditDesignContractFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}\u0000${finding.message}\u0000${finding.evidence_path}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseFindingSeverity(value: unknown): "blocker" | "warning" {
  return value === "blocker" ? "blocker" : "warning";
}

function claimRows(artifacts: LoadedRunArtifacts): Array<{
  claim_id: string;
  statement?: string;
  section_heading: string;
  status?: string;
  citation_refs: string[];
}> {
  const rows = [
    ...extractClaims(artifacts.claimEvidenceTable),
    ...extractClaims(artifacts.claimStatusTable)
  ];
  const byId = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    byId.set(row.claim_id, { ...byId.get(row.claim_id), ...row });
  }
  return [...byId.values()];
}

function extractClaims(value: unknown): Array<{
  claim_id: string;
  statement?: string;
  section_heading: string;
  status?: string;
  citation_refs: string[];
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const claims = (value as { claims?: unknown }).claims;
  if (!Array.isArray(claims)) {
    return [];
  }
  return claims
    .filter((claim): claim is Record<string, unknown> => Boolean(claim) && typeof claim === "object")
    .map((claim, index) => ({
      claim_id: stringValue(claim.claim_id) || `claim_${index + 1}`,
      statement: stringValue(claim.statement),
      section_heading: stringValue(claim.section_heading) || "",
      status: stringValue(claim.status),
      citation_refs: stringArray(claim.citation_refs)
    }));
}

function analyzeEvidenceStore(lines: Record<string, unknown>[]): {
  deterministicFallbackUsed: boolean;
  nonFallbackMetricEvidencePresent: boolean;
  fallbackLabels: string[];
} {
  const deterministicFallbackUsed = lines.some((line) =>
    line.deterministic_fallback_used === true
      || Boolean(stringValue(line.fallback_label))
      || /fallback/iu.test(stringValue(line.source) || "")
  );
  const nonFallbackMetricEvidencePresent = lines.some((line) =>
    line.metric_evidence_present === true
      || (Boolean(stringValue(line.metric)) && line.deterministic_fallback_used !== true && !stringValue(line.fallback_label))
  );
  return {
    deterministicFallbackUsed,
    nonFallbackMetricEvidencePresent,
    fallbackLabels: lines.map((line) => stringValue(line.fallback_label)).filter((value): value is string => Boolean(value))
  };
}

function resolveAllowedClaimLevel(input: {
  blockers: PaperReadinessAuditBlocker[];
  resultTable: ResultTableScore;
  citationSupportIssues: PaperReadinessAuditUnsupportedClaim[];
  fallbackOnly: boolean;
}): string {
  if (input.blockers.some((blocker) => blocker.code === "hidden_failed_run")) {
    return "blocked_until_failed_run_is_visible";
  }
  if (input.fallbackOnly) {
    return "system_validation_note_only";
  }
  if (!input.resultTable.measured || input.resultTable.row_count === 0) {
    return "research_memo_without_quantitative_claims";
  }
  if (input.resultTable.missing_baseline_count > 0 || input.resultTable.missing_comparator_count > 0) {
    return "descriptive_only_no_comparative_claims";
  }
  if (input.resultTable.complete_row_count === 0) {
    return "research_memo_without_quantitative_claims";
  }
  if (input.citationSupportIssues.length > 0) {
    return "result_claims_allowed_related_work_downgraded";
  }
  return input.blockers.some((blocker) => blocker.severity === "blocker")
    ? "needs_repair_before_manuscript_promotion"
    : "conditional_claims_with_artifact_links";
}

function resolveVerdict(blockers: PaperReadinessAuditBlocker[]): PaperReadinessAuditVerdict {
  if (blockers.some((blocker) => blocker.severity === "blocker")) {
    return "blocked";
  }
  if (blockers.length > 0) {
    return "needs-review";
  }
  return "conditionally-ready";
}

function buildNextActions(blockers: PaperReadinessAuditBlocker[]): string[] {
  const actions = new Set<string>();
  for (const blocker of blockers) {
    if (blocker.code === "baseline_or_comparator_missing") {
      actions.add("Add or rerun the missing baseline/comparator and recompute deltas in result_table.json.");
    } else if (blocker.code === "result_table_missing" || blocker.code === "result_table_incomplete") {
      actions.add("Produce a complete metric/result table before paper-ready promotion.");
    } else if (blocker.code === "fallback_only_evidence") {
      actions.add("Replace fallback-only evidence with a real executed experiment or downgrade to a system validation note.");
    } else if (blocker.code === "unsupported_claims_present") {
      actions.add("Map each major claim to artifact, result, citation, or mark it blocked/downgraded.");
    } else if (blocker.code === "citation_support_missing") {
      actions.add("Attach and verify citation support or downgrade related-work statements.");
    } else if (blocker.code === "done_condition_unmeasured") {
      actions.add("Provide a governed done-condition source and rerun the completion audit.");
    } else if (blocker.code === "claim_ceiling_conflict") {
      actions.add("Align the declared academic claim ceiling with the computed evidence ceiling before review.");
    } else if (blocker.code === "manuscript_quantitative_claim_ceiling_conflict") {
      actions.add("Remove unsupported quantitative result assertions or bind recomputable result evidence before rerunning write_paper.");
    } else if (blocker.code === "figure_audit_missing_or_malformed") {
      actions.add("Produce a valid figure_audit_summary.json and rerun figure_audit before manuscript promotion.");
    } else if (blocker.code === "figure_audit_ablated") {
      actions.add("Use a figure-audit-enabled condition before manuscript promotion; the ablation is evaluation-only.");
    } else if (blocker.code === "figure_result_caption_mismatch") {
      actions.add("Repair figure/result/caption mismatches and rerun figure_audit before review.");
    } else if (blocker.code === "hidden_failed_run") {
      actions.add("Expose failed run status in the audit bundle and remove paper_ready=true.");
    } else if (blocker.code === "run_execution_incomplete") {
      actions.add("Wait for the active run to reach a terminal governed state, then rerun the audit against its final artifacts.");
    } else if (blocker.code === "run_execution_failed") {
      actions.add("Repair or explicitly supersede the failed run before rerunning the governance audit.");
    } else if (blocker.code === "write_paper_failed") {
      actions.add("Treat the manuscript as unaccepted, return to the failed gate, and rerun write_paper only after the cited blockers are repaired.");
    } else if (blocker.code === "artifact_contract_incomplete") {
      actions.add("Restore required governance artifacts or explicitly mark the bundle incomplete.");
    } else if (blocker.code === "repeated_run_provenance_missing") {
      actions.add("Persist every planned trial with explicit seed provenance before rerunning the review gate.");
    } else if (blocker.code === "budget_contract_mismatch") {
      actions.add("Reconcile the declared and executed trial budgets, then regenerate result and review artifacts.");
    } else if (blocker.code === "stale_persisted_state") {
      actions.add("Refresh checkpoint and public readiness artifacts from one terminal run state before promotion.");
    } else if (blocker.source === "reviewResearchScaleArtifacts") {
      actions.add("Repair the upstream node identified by review evidence, then rerun the scientific and manuscript-promotion gates.");
    }
  }
  if (actions.size === 0) {
    actions.add("Keep the claim-evidence table, result table, figure audit, and review decision attached to the manuscript handoff.");
  }
  return [...actions];
}

function renderAuditMarkdown(summary: PaperReadinessAuditSummary): string {
  const lines = [
    "# Paper-Readiness Audit",
    "",
    '<a id="verdict"></a>',
    "## Verdict",
    "",
    `Generated: ${summary.generated_at}`,
    `Verdict: ${summary.verdict}`,
    `Input: ${summary.input.mode}`,
    `Run artifacts: ${summary.input.run_root}`,
    "",
    '<a id="top-blockers"></a>',
    "## Top Blockers",
    ""
  ];
  if (summary.top_blockers.length === 0) {
    lines.push("- none");
  } else {
    for (const blocker of summary.top_blockers) {
      lines.push(`- ${blocker.severity}: ${blocker.code} - ${blocker.message}`);
    }
  }
  lines.push(
    "",
    '<a id="unsupported-claims"></a>',
    "## Unsupported Claims",
    "",
    ...listOrNone(summary.unsupported_claims.map((claim) =>
      `${claim.claim_id}: ${claim.statement || claim.message}`
    )),
    "",
    '<a id="baseline-comparator-status"></a>',
    "## Baseline / Comparator Status",
    "",
    `- status: ${summary.baseline_comparator_status.status}`,
    `- missing baseline rows: ${summary.baseline_comparator_status.missing_baseline_count}`,
    `- missing comparator rows: ${summary.baseline_comparator_status.missing_comparator_count}`,
    `- comparative claims allowed: ${summary.baseline_comparator_status.comparative_claim_allowed}`,
    "",
    '<a id="result-table-completeness"></a>',
    "## Result Table Completeness",
    "",
    `- measured: ${summary.result_table_completeness.measured}`,
    `- complete rows: ${summary.result_table_completeness.complete_row_count}/${summary.result_table_completeness.row_count}`,
    `- comparator coverage: ${summary.result_table_completeness.comparator_coverage ?? "n/a"}`,
    `- paper-ready allowed: ${summary.result_table_completeness.paper_ready_allowed}`,
    "",
    '<a id="figure-result-caption-mismatch"></a>',
    "## Figure / Result / Caption Mismatch",
    "",
    `- status: ${summary.figure_result_caption_mismatch.status}`,
    `- severe mismatches: ${summary.figure_result_caption_mismatch.severe_mismatch_count}`,
    `- manuscript promotion allowed: ${summary.figure_result_caption_mismatch.manuscript_promotion_allowed}`,
    "",
    '<a id="citation-support"></a>',
    "## Citation Support",
    "",
    ...listOrNone(summary.citation_support_issues.map((issue) =>
      `${issue.claim_id}: ${issue.statement || issue.message}`
    )),
    "",
    '<a id="design-contract-findings"></a>',
    "## Design Contract Findings",
    "",
    ...listOrNone(summary.design_contract_findings.map((finding) =>
      `${finding.severity}: ${finding.code} - ${finding.message} (${finding.evidence_path})`
    )),
    "",
    '<a id="execution-integrity-findings"></a>',
    "## Execution Integrity Findings",
    "",
    ...listOrNone(summary.execution_integrity_findings.map((finding) =>
      `${finding.severity}: ${finding.code} - ${finding.message} (${finding.evidence_path}; repair owner: ${finding.target_node})`
    )),
    "",
    '<a id="literature-discovery-findings"></a>',
    "## Literature Discovery Findings",
    "",
    ...listOrNone(summary.scorer_outputs.literature_discovery.findings.map((finding) =>
      `${finding.severity}: ${finding.code} - ${finding.message} (${finding.evidence_path})`
    )),
    "",
    '<a id="paper-readiness-flags"></a>',
    "## Paper-Readiness Flags",
    "",
    `- write_paper completed: ${summary.paper_readiness.write_paper_completed}`,
    `- paper_ready flag: ${summary.paper_readiness.paper_ready}`,
    "",
    '<a id="judge-lane"></a>',
    "## Judge Lane",
    "",
    `- label: ${summary.judge_lane.audit_report_label}`,
    `- planner/worker nodes: ${summary.judge_lane.planner_worker_nodes.join(", ")}`,
    `- judge nodes: ${summary.judge_lane.judge_nodes.join(", ")}`,
    "",
    '<a id="audit-timeline"></a>',
    "## Audit Timeline",
    "",
    `- status: ${summary.audit_timeline.status}`,
    `- measured: ${summary.audit_timeline.measured}`,
    `- entries: ${summary.audit_timeline.entry_count}`,
    `- durable events: ${summary.audit_timeline.event_count}`,
    `- checkpoints: ${summary.audit_timeline.checkpoint_count}`,
    "",
    '<a id="done-condition"></a>',
    "## Done Condition",
    "",
    `- status: ${summary.done_condition.status}`,
    `- measured: ${summary.done_condition.measured}`,
    `- declared source: ${summary.done_condition.declared_source}`,
    `- failures: ${summary.done_condition.failure_count}`,
    `- warnings: ${summary.done_condition.warning_count}`,
    "",
    '<a id="autonomy-metrics"></a>',
    "## Autonomy / Evidence Metrics",
    "",
    `- autonomy_span: ${metricValue(summary.autonomy_metrics.autonomy_span)}`,
    `- human_intervention_count: ${metricValue(summary.autonomy_metrics.human_intervention_count)}`,
    `- evidence_integrity_score: ${metricValue(summary.autonomy_metrics.evidence_integrity_score)}`,
    `- backtrack_success_rate: ${metricValue(summary.autonomy_metrics.backtrack_success_rate)}`,
    `- claim_violation_count: ${metricValue(summary.autonomy_metrics.claim_violation_count)}`,
    `- reproducibility_score: ${metricValue(summary.autonomy_metrics.reproducibility_score)}`,
    "",
    '<a id="claim-ceiling"></a>',
    "## Claim Ceiling",
    "",
    `Allowed level: ${summary.claim_ceiling.allowed_level}`,
    "",
    ...listOrNone(summary.claim_ceiling.rules_applied),
    "",
    "## Output Files",
    "",
    `- report: ${summary.outputs.report_path}`,
    `- summary: ${summary.outputs.summary_path}`,
    `- blockers: ${summary.outputs.blockers_path}`,
    `- claim evidence: ${summary.outputs.claim_evidence_path}`,
    `- audit timeline: ${summary.outputs.audit_timeline_path}`,
    `- claim promotion timeline: ${summary.outputs.claim_promotion_timeline_path}`,
    `- blocked claim events: ${summary.outputs.blocked_claim_events_path}`,
    `- done condition: ${summary.outputs.done_condition_path}`,
    `- autonomy metrics: ${summary.outputs.autonomy_metrics_path}`,
    ...(summary.outputs.external_intake_manifest_path ? [`- external intake manifest: ${summary.outputs.external_intake_manifest_path}`] : []),
    "",
    '<a id="next-actions"></a>',
    "## Next Actions",
    "",
    ...summary.next_action_checklist.map((action) => `- [ ] ${action}`),
    ""
  );
  return `${lines.join("\n")}\n`;
}

function listOrNone(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- none"];
}

function metricValue(metric: { measured: boolean; value: number | null; unit?: string }): string {
  if (!metric.measured || metric.value === null) {
    return "unmeasured";
  }
  return `${metric.value}${metric.unit ? ` ${metric.unit}` : ""}`;
}

function normalizeSeedId(value: string): string {
  return value.trim().toUpperCase();
}

function parseConditionName(value: Record<string, unknown> | undefined): GovernanceBenchmarkConditionName {
  const name = stringValue(value?.name) || stringValue(value?.condition);
  if (
    name === "gated"
    || name === "ungated"
    || name === "no_claim_ceiling"
    || name === "no_review_gate"
    || name === "no_figure_audit"
  ) {
    return name;
  }
  return "gated";
}

function getRunStatus(value: Record<string, unknown> | undefined): string | undefined {
  return stringValue(value?.status) || stringValue(value?.state) || stringValue(value?.phase);
}

function isActiveRunStatus(status: string | undefined): boolean {
  return status === "running"
    || status === "in_progress"
    || status === "pending"
    || status === "queued"
    || status === "waiting";
}

function isFailedRunStatus(status: string | undefined): boolean {
  return status === "failed" || status === "error";
}

function getWritePaperStatus(value: Record<string, unknown> | undefined): string | undefined {
  const writePaper = getWritePaperNodeRecord(value);
  return stringValue(writePaper?.status) || stringValue(writePaper?.state) || stringValue(writePaper?.phase);
}

function getWritePaperFailureMessage(value: Record<string, unknown> | undefined): string | undefined {
  const writePaper = getWritePaperNodeRecord(value);
  return stringValue(writePaper?.lastError) || stringValue(writePaper?.error) || stringValue(writePaper?.note);
}

function getWritePaperNodeRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const graph = value.graph;
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    return undefined;
  }
  const nodeStates = (graph as Record<string, unknown>).nodeStates;
  if (!nodeStates || typeof nodeStates !== "object" || Array.isArray(nodeStates)) {
    return undefined;
  }
  const writePaper = (nodeStates as Record<string, unknown>).write_paper;
  return writePaper && typeof writePaper === "object" && !Array.isArray(writePaper)
    ? writePaper as Record<string, unknown>
    : undefined;
}

function isWritePaperCompleted(status: string | undefined): boolean {
  return status === "completed";
}

function containsQuantitativeResultClaim(manuscript: string | undefined): boolean {
  if (!manuscript) return false;
  const text = manuscript.replace(/(^|[^\\])%.*$/gmu, "$1");
  const resultSections = [...text.matchAll(
    /\\(?:sub)*section\*?\{[^}]*(?:result|evaluation|experiment|finding|validation|analysis|study|development)[^}]*\}([\s\S]*?)(?=\\(?:sub)*section\*?\{|\\end\{document\}|$)/giu
  )].map((match) => match[1] || "");
  const candidate = resultSections.join("\n");
  if (!candidate.trim()) return false;
  return /\b\d+(?:\.\d+)?\s*(?:\\%|%)|(?<![A-Za-z0-9_])(?:0?\.\d+)(?![A-Za-z0-9_])|\b\d+\s*\/\s*\d+\b|\b(?:metric|measure|outcome|estimate|effect|rate|score|value|interval|difference|change)\b[^\n.]{0,100}\d/iu
    .test(candidate);
}

async function readOptionalJson<T = unknown>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    const value = await fs.readFile(filePath, "utf8");
    return value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readFirstOptionalJson<T = unknown>(root: string, candidates: string[]): Promise<T | undefined> {
  for (const candidate of candidates) {
    const value = await readOptionalJson<T>(path.join(root, candidate));
    if (value !== undefined) return value;
  }
  return undefined;
}

async function readDesignContractPayloads(runRoot: string): Promise<Array<{ path: string; payload: Record<string, unknown> }>> {
  const candidates = [
    "experiment_contract.json",
    "design_contracts.json",
    path.join("audit", "design_contracts.json"),
    path.join("review", "design_contract_findings.json")
  ];
  const payloads: Array<{ path: string; payload: Record<string, unknown> }> = [];
  for (const candidate of candidates) {
    const payload = await readOptionalJson<Record<string, unknown>>(path.join(runRoot, candidate));
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      payloads.push({ path: candidate.replace(/\\/g, "/"), payload });
    }
  }
  return payloads;
}

async function readLiteratureDiscoveryPayloads(runRoot: string): Promise<Array<{ path: string; payload: Record<string, unknown> }>> {
  const candidates = [
    "literature_discovery_audit.json",
    path.join("collect_papers", "literature_discovery_audit.json"),
    path.join("paper", "literature_discovery_audit.json")
  ];
  const payloads: Array<{ path: string; payload: Record<string, unknown> }> = [];
  for (const candidate of candidates) {
    const payload = await readOptionalJson<Record<string, unknown>>(path.join(runRoot, candidate));
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      payloads.push({ path: candidate.replace(/\\/g, "/"), payload });
    }
  }
  return payloads;
}

async function readResearchBriefText(runRoot: string): Promise<string | undefined> {
  const candidates = [
    "research_brief.md",
    "brief.md",
    path.join("brief", "research_brief.md"),
    path.join("inputs", "research_brief.md")
  ];
  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(path.join(runRoot, candidate), "utf8");
      if (raw.trim()) {
        return raw;
      }
    } catch {
      // Try the next conventional brief location.
    }
  }
  return undefined;
}

async function readJsonl(filePath: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw.split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
        } catch {
          return {};
        }
      });
  } catch {
    return [];
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function relativePath(cwd: string, value: string, externalFallback?: string): string {
  const relative = path.relative(cwd, value).replace(/\\/g, "/");
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : externalFallback || value.replace(/\\/g, "/");
}
