import path from "node:path";
import { promises as fs } from "node:fs";

import {
  ExperimentNetworkPolicy,
  ExperimentNetworkPurpose,
  GraphNodeId,
  RunEvidenceAdequacyProjection,
  RunLifecycleStatus,
  RunOperatorStatusArtifact,
  RunRecord,
  RunReviewAssuranceProjection,
  RunRecommendedNextAction,
  RunValidationScope,
  WorkflowApprovalMode
} from "../../types.js";
import { fileExists } from "../../utils/fs.js";
import {
  EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH
} from "../analysis/evidenceAdequacy.js";
import {
  loadEvidenceAdequacyContractFromRunDir,
  reassessEvidenceAdequacyArtifacts,
  type EvidenceAdequacyArtifactReassessment
} from "../analysis/evidenceAdequacyArtifacts.js";
import { loadExperimentContract } from "../experiments/experimentContract.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import { buildPublicExperimentDir } from "../publicArtifacts.js";
import { parseAnalysisReport } from "../resultAnalysis.js";
import { parseReadinessRiskArtifact, type ReadinessRiskArtifact } from "../readinessRisks.js";
import { inspectReferenceAuthorityGate } from "../referenceAuthorityGate.js";
import { inspectReviewAssuranceArtifacts } from "../reviewInputManifest.js";
import { buildWorkspaceRunRoot } from "./runPaths.js";

interface ReviewCritiqueProjection {
  blocking_issues_count?: number;
  paper_readiness_state?: string;
}

interface ReviewPacketProjection {
  readiness?: {
    status?: "ready" | "warning" | "blocking";
  };
  decision?: {
    outcome?: string;
    recommended_transition?: string;
  };
}

interface ReviewScorecardProjection {
  overall_score_1_to_5?: number;
}

interface PaperReadinessProjection {
  paper_ready?: boolean;
  readiness_state?: string;
  reason?: string;
  triggered_by?: string[];
}

interface FailureSeed {
  key: string;
  summary: string;
  remediation: string;
}

interface ExperimentPrimaryBinding {
  present: boolean;
  valid: boolean;
  primaryComparisonId?: string;
}

interface ReviewEvidenceAdequacyArtifact {
  status: string;
  trusted: boolean;
  paperEvidenceAllowed: boolean;
  integrityValid: boolean;
  contractPresent: boolean;
  receiptPresent: boolean;
  assessmentPresent: boolean;
  primaryComparisonId?: string;
  overallStatus?: "pass" | "fail" | "unknown";
  issues: string[];
  warnings: string[];
}

interface ReviewEvidenceAdequacyLoad {
  present: boolean;
  valid: boolean;
  artifact?: ReviewEvidenceAdequacyArtifact;
  reasonCode?: string;
}

export const RUN_STATUS_RELATIVE_PATH = "run_status.json";
const REVIEW_EVIDENCE_ADEQUACY_RELATIVE_PATH =
  "review/evidence_adequacy_reassessment.json";

export async function readRunOperatorStatus(runDir: string): Promise<RunOperatorStatusArtifact | undefined> {
  const raw = await readTextArtifact(path.join(runDir, RUN_STATUS_RELATIVE_PATH));
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as RunOperatorStatusArtifact;
    if (parsed?.version === 1 && typeof parsed.run_id === "string") {
      return parsed;
    }
  } catch {
    // ignore malformed status artifact here; harness handles validation
  }
  return undefined;
}

export async function buildRunOperatorStatus(input: {
  workspaceRoot: string;
  run: RunRecord;
  approvalMode: WorkflowApprovalMode;
  networkPolicy?: ExperimentNetworkPolicy;
  networkPurpose?: ExperimentNetworkPurpose;
  validationScope?: RunValidationScope;
  currentNode?: GraphNodeId;
  lifecycleStatus?: RunLifecycleStatus;
}): Promise<RunOperatorStatusArtifact> {
  const runDir = buildWorkspaceRunRoot(input.workspaceRoot, input.run.id);
  const currentNode = input.currentNode || input.run.currentNode;
  const analysisProjectionActive = nodeArtifactsBelongToCurrentGraph(input.run, "analyze_results");
  const reviewProjectionActive = nodeArtifactsBelongToCurrentGraph(input.run, "review");
  const paperProjectionActive = nodeArtifactsBelongToCurrentGraph(input.run, "write_paper");
  const [evidenceAdequacy, reviewAssurance] = await Promise.all([
    buildRunEvidenceAdequacyProjection({
      workspaceRoot: input.workspaceRoot,
      runDir,
      run: input.run,
      reviewProjectionActive
    }),
    reviewProjectionActive
      ? inspectReviewAssuranceArtifacts({
          runDir,
          runId: input.run.id,
          researchCycle: input.run.graph.researchCycle ?? 0
        })
      : Promise.resolve<RunReviewAssuranceProjection>({
          status: "not_started",
          trusted: false,
          paper_ready_eligible: false,
          input_manifest_valid: false,
          gate_report_valid: false,
          assurance_valid: false,
          handoff_valid: false,
          model_review_bundle_valid: false,
          required_for_paper_ready: false,
          reason_codes: [],
          artifact_refs: []
        })
  ]);
  const analysisReady = analysisProjectionActive
    && await hasArtifacts(runDir, ["result_analysis.json", "transition_recommendation.json"]);
  const reviewReady = reviewProjectionActive
    && await hasArtifacts(runDir, [
      "review/review_packet.json",
      "review/paper_critique.json",
      "review/minimum_gate.json",
      "review/readiness_risks.json"
    ]);
  const paperReadiness = paperProjectionActive
    ? await readJsonArtifact<PaperReadinessProjection>(
      path.join(runDir, "paper", "paper_readiness.json")
    )
    : undefined;
  const referenceAuthorityGate = paperProjectionActive
    ? await inspectReferenceAuthorityGate(path.join(runDir, "paper"))
    : undefined;
  const paperReady = paperReadiness?.paper_ready === true
    && referenceAuthorityGate?.status === "pass"
    && evidenceAdequacy.trusted
    && evidenceAdequacy.paper_evidence_allowed
    && reviewAssurance.paper_ready_eligible;
  const reviewRisks = reviewProjectionActive
    ? await readReadinessRisks(path.join(runDir, "review", "readiness_risks.json"))
    : undefined;
  const paperRisks = paperProjectionActive
    ? await readReadinessRisks(path.join(runDir, "paper", "readiness_risks.json"))
    : undefined;
  const reviewCritique = reviewProjectionActive
    ? await readJsonArtifact<ReviewCritiqueProjection>(
      path.join(runDir, "review", "paper_critique.json")
    )
    : undefined;
  const reviewPacket = reviewProjectionActive
    ? await readJsonArtifact<ReviewPacketProjection>(
      path.join(runDir, "review", "review_packet.json")
    )
    : undefined;
  const reviewScorecard = reviewProjectionActive
    ? await readJsonArtifact<ReviewScorecardProjection>(
      path.join(runDir, "review", "scorecard.json")
    )
    : undefined;
  const lifecycleStatus = deriveLifecycleStatus(input.run, currentNode, input.lifecycleStatus);
  const lastEventAt = await readLastEventTimestamp(runDir, input.run.updatedAt);
  const dominantFailure = deriveDominantFailure({
    run: input.run,
    currentNode,
    reviewRisks,
    paperRisks,
    reviewCritique,
    paperReadiness
  });
  const recommendedNextAction = deriveRecommendedNextAction({
    run: input.run,
    currentNode,
    lifecycleStatus,
    analysisReady,
    reviewReady,
    paperReady,
    dominantFailure: Boolean(dominantFailure)
  });
  const reviewGateStatus = normalizeReviewGateStatus(reviewPacket?.readiness?.status);
  const reviewDecisionOutcome = asNonEmptyString(reviewPacket?.decision?.outcome);
  const reviewRecommendedTransition = asNonEmptyString(reviewPacket?.decision?.recommended_transition);
  const reviewScoreOverall =
    typeof reviewScorecard?.overall_score_1_to_5 === "number"
      ? Number(reviewScorecard.overall_score_1_to_5.toFixed(1))
      : undefined;
  const paperReadinessState =
    asNonEmptyString(paperReadiness?.readiness_state) || asNonEmptyString(reviewCritique?.paper_readiness_state);
  const paperReadinessReason = asNonEmptyString(paperReadiness?.reason);
  const blockingReasons = collectRiskMessages("blocked", reviewRisks, paperRisks);
  const warningReasons = collectRiskMessages("warning", reviewRisks, paperRisks);
  if (dominantFailure?.summary && !blockingReasons.includes(dominantFailure.summary)) {
    blockingReasons.unshift(dominantFailure.summary);
  }

  const networkDependency = normalizeNetworkDependency({
    policy: input.networkPolicy,
    purpose: input.networkPurpose
  });
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    run_id: input.run.id,
    research_cycle: input.run.graph.researchCycle ?? 0,
    checkpoint_seq: input.run.graph.checkpointSeq ?? 0,
    run_updated_at: input.run.updatedAt,
    title: input.run.title,
    current_node: currentNode,
    lifecycle_status: lifecycleStatus,
    approval_mode: input.approvalMode,
    last_event_at: lastEventAt,
    analysis_ready: analysisReady,
    review_ready: reviewReady,
    paper_ready: paperReady,
    recommended_next_action: recommendedNextAction,
    blocker_summary: dominantFailure?.summary,
    blocking_reasons: blockingReasons.slice(0, 6),
    warning_reasons: warningReasons.slice(0, 6),
    dominant_failure: dominantFailure
      ? {
          key: dominantFailure.key,
          summary: dominantFailure.summary,
          remediation: dominantFailure.remediation
        }
      : undefined,
    review_gate: {
      status: reviewGateStatus,
      decision_outcome: reviewDecisionOutcome,
      recommended_transition: reviewRecommendedTransition,
      score_overall: reviewScoreOverall,
      operator_label: buildReviewGateOperatorLabel(reviewGateStatus, reviewDecisionOutcome, reviewRecommendedTransition)
    },
    paper_gate: {
      status: resolvePaperGateStatus(paperReadinessState, paperReady),
      readiness_state: paperReadinessState,
      reason: paperReadinessReason,
      operator_label: buildPaperGateOperatorLabel(paperReadinessState, paperReady, paperReadinessReason)
    },
    evidence_adequacy: evidenceAdequacy,
    review_assurance: reviewAssurance,
    network_dependency: networkDependency,
    validation_scope: input.validationScope || "full_run"
  };
}

function nodeArtifactsBelongToCurrentGraph(run: RunRecord, node: GraphNodeId): boolean {
  return run.graph.nodeStates[node]?.status !== "pending";
}

async function buildRunEvidenceAdequacyProjection(input: {
  workspaceRoot: string;
  runDir: string;
  run: RunRecord;
  reviewProjectionActive: boolean;
}): Promise<RunEvidenceAdequacyProjection> {
  const experimentBinding = await loadExperimentPrimaryBinding(
    input.workspaceRoot,
    input.runDir,
    input.run
  );
  const evidenceRoots = await loadEvidenceAdequacyRoots(input);
  const reviewRequired = isReviewEvidenceReassessmentRequired(input.run);
  const [contractLoad, reassessment, reviewLoad] = await Promise.all([
    loadEvidenceAdequacyContractFromRunDir(input.runDir),
    reassessEvidenceAdequacyArtifacts({
      runDir: input.runDir,
      evidenceRoots,
      expectedPrimaryComparisonId: experimentBinding.primaryComparisonId,
      requireStoredAssessment: true
    }),
    input.reviewProjectionActive
      ? loadReviewEvidenceAdequacyArtifact(input.runDir)
      : Promise.resolve<ReviewEvidenceAdequacyLoad>({
          present: false,
          valid: true
        })
  ]);

  const contract = contractLoad.contract;
  const primaryComparisonId =
    contract?.primary_comparison_id || experimentBinding.primaryComparisonId;
  const bindingValid = Boolean(
    contract
    && experimentBinding.valid
    && experimentBinding.primaryComparisonId === contract.primary_comparison_id
  );
  const evidenceExpected = isEvidenceAdequacyExpected(input.run);
  const reasonCodes = collectEvidenceAdequacyReasonCodes(
    contractLoad.reasons,
    reassessment
  );
  let status: RunEvidenceAdequacyProjection["status"];

  if (
    !reassessment.contractPresent
    && !reassessment.receiptPresent
    && !reassessment.storedAssessmentPresent
  ) {
    status = evidenceExpected ? "missing_contract" : "unmeasured";
    if (status === "missing_contract") {
      reasonCodes.push("evidence_adequacy_contract_missing");
    }
  } else if (!contract) {
    status = "invalid";
    reasonCodes.push(
      reassessment.contractPresent
        ? "evidence_adequacy_contract_invalid"
        : "evidence_adequacy_orphan_artifact"
    );
  } else if (!bindingValid) {
    status = "invalid";
    reasonCodes.push(
      experimentBinding.present
        ? "evidence_adequacy_primary_comparison_mismatch"
        : "evidence_adequacy_experiment_contract_missing"
    );
  } else if (!reassessment.receiptPresent) {
    status = evidenceExpected ? "missing_receipt" : "awaiting_execution";
    reasonCodes.push(
      status === "awaiting_execution"
        ? "evidence_adequacy_execution_pending"
        : "evidence_adequacy_receipt_missing"
    );
  } else if (!reassessment.assessment || !reassessment.integrityValid) {
    status = "invalid";
    reasonCodes.push("evidence_adequacy_integrity_invalid");
  } else {
    status = reassessment.assessment.overall_status;
  }

  let integrityValid =
    reassessment.integrityValid
    && Boolean(reassessment.assessment)
    && (status === "pass" || status === "fail" || status === "unknown");
  let trusted = integrityValid;
  let paperEvidenceAllowed = trusted && status === "pass";

  if (input.reviewProjectionActive) {
    if (!reviewLoad.present && reviewRequired) {
      if (status !== "missing_contract" && status !== "missing_receipt") {
        status = "invalid";
      }
      integrityValid = false;
      trusted = false;
      paperEvidenceAllowed = false;
      reasonCodes.push("evidence_adequacy_review_reassessment_missing");
    } else if (reviewLoad.present) {
      const reviewMatches =
        reviewLoad.valid
        && Boolean(reviewLoad.artifact)
        && reviewEvidenceAdequacyMatches({
          artifact: reviewLoad.artifact!,
          reassessment,
          trusted,
          paperEvidenceAllowed,
          expectedPrimaryComparisonId: experimentBinding.primaryComparisonId
        });
      if (!reviewMatches) {
        status = "invalid";
        integrityValid = false;
        trusted = false;
        paperEvidenceAllowed = false;
        reasonCodes.push(
          reviewLoad.reasonCode
          || "evidence_adequacy_review_reassessment_mismatch"
        );
      }
    }
  }

  return {
    status,
    trusted,
    integrity_valid: integrityValid,
    paper_evidence_allowed: paperEvidenceAllowed,
    contract_present: reassessment.contractPresent,
    receipt_present: reassessment.receiptPresent,
    assessment_present: reassessment.storedAssessmentPresent,
    review_reassessment_present: reviewLoad.present,
    primary_comparison_id: primaryComparisonId,
    overall_status: reassessment.assessment?.overall_status,
    reason_codes: uniqueStrings(reasonCodes).filter(
      (reasonCode) => status !== "awaiting_execution"
        || reasonCode !== "evidence_adequacy_receipt_missing"
    ),
    artifact_refs: buildEvidenceAdequacyArtifactRefs({
      reassessment,
      reviewReassessmentPresent: reviewLoad.present
    })
  };
}

async function loadExperimentPrimaryBinding(
  workspaceRoot: string,
  runDir: string,
  run: RunRecord
): Promise<ExperimentPrimaryBinding> {
  const artifactPath = path.join(runDir, "experiment_contract.json");
  const present = await fileExists(artifactPath);
  if (!present) {
    return { present: false, valid: false };
  }

  if (path.resolve(workspaceRoot) === path.resolve(process.cwd())) {
    const loaded = await loadExperimentContract(run.id);
    const primaryComparisonId = asNonEmptyString(
      loaded?.results_plan.primary_comparison_id
    );
    if (loaded?.run_id === run.id && primaryComparisonId) {
      return { present: true, valid: true, primaryComparisonId };
    }
  }

  const raw = await readJsonArtifact<unknown>(artifactPath);
  if (!isRecord(raw) || raw.run_id !== run.id || !isRecord(raw.results_plan)) {
    return { present: true, valid: false };
  }
  const primaryComparisonId = asNonEmptyString(
    raw.results_plan.primary_comparison_id
  );
  return {
    present: true,
    valid: Boolean(primaryComparisonId),
    primaryComparisonId
  };
}

async function loadEvidenceAdequacyRoots(input: {
  workspaceRoot: string;
  runDir: string;
  run: RunRecord;
}): Promise<string[]> {
  const runContextPath = path.isAbsolute(input.run.memoryRefs.runContextPath)
    ? input.run.memoryRefs.runContextPath
    : path.resolve(input.workspaceRoot, input.run.memoryRefs.runContextPath);
  const runContext = new RunContextMemory(runContextPath);
  const [metricsPath, configuredPublicDir, executionCwd] = await Promise.all([
    runContext.get<string>("implement_experiments.metrics_path"),
    runContext.get<string>("implement_experiments.public_dir"),
    runContext.get<string>("run_experiments.cwd")
  ]);
  return uniqueStrings([
    input.runDir,
    buildPublicExperimentDir(input.workspaceRoot, input.run),
    ...(metricsPath
      ? [path.dirname(resolveWorkspacePath(input.workspaceRoot, metricsPath))]
      : []),
    ...(configuredPublicDir
      ? [resolveWorkspacePath(input.workspaceRoot, configuredPublicDir)]
      : []),
    ...(executionCwd
      ? [resolveWorkspacePath(input.workspaceRoot, executionCwd)]
      : [])
  ]);
}

function resolveWorkspacePath(workspaceRoot: string, value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceRoot, value);
}

function isEvidenceAdequacyExpected(run: RunRecord): boolean {
  if (run.graph.nodeStates.run_experiments.status !== "pending") {
    return true;
  }
  return (["analyze_results", "figure_audit", "review", "write_paper"] as const)
    .some((node) => run.graph.nodeStates[node].status !== "pending");
}

function isReviewEvidenceReassessmentRequired(run: RunRecord): boolean {
  const status = run.graph.nodeStates.review.status;
  return status === "completed"
    || status === "needs_approval"
    || status === "failed"
    || status === "skipped";
}

async function loadReviewEvidenceAdequacyArtifact(
  runDir: string
): Promise<ReviewEvidenceAdequacyLoad> {
  const artifactPath = path.join(
    runDir,
    REVIEW_EVIDENCE_ADEQUACY_RELATIVE_PATH
  );
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(artifactPath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, valid: true };
    }
    return {
      present: true,
      valid: false,
      reasonCode: "evidence_adequacy_review_reassessment_invalid"
    };
  }
  if (!isRecord(raw)) {
    return {
      present: true,
      valid: false,
      reasonCode: "evidence_adequacy_review_reassessment_invalid"
    };
  }
  const issues = readStringArray(raw.issues);
  const warnings = readStringArray(raw.warnings);
  const primaryComparisonId = readNullableString(raw.primary_comparison_id);
  const overallStatus = readEvidenceAdequacyOverallStatus(raw.overall_status);
  if (
    raw.schema_version !== 1
    || raw.artifact_kind !== "review_evidence_adequacy_reassessment"
    || !asNonEmptyString(raw.status)
    || typeof raw.trusted !== "boolean"
    || typeof raw.paper_evidence_allowed !== "boolean"
    || typeof raw.integrity_valid !== "boolean"
    || typeof raw.contract_present !== "boolean"
    || typeof raw.receipt_present !== "boolean"
    || typeof raw.stored_assessment_present !== "boolean"
    || issues === undefined
    || warnings === undefined
    || primaryComparisonId === undefined
    || overallStatus === undefined
  ) {
    return {
      present: true,
      valid: false,
      reasonCode: "evidence_adequacy_review_reassessment_invalid"
    };
  }
  return {
    present: true,
    valid: true,
    artifact: {
      status: asNonEmptyString(raw.status)!,
      trusted: raw.trusted,
      paperEvidenceAllowed: raw.paper_evidence_allowed,
      integrityValid: raw.integrity_valid,
      contractPresent: raw.contract_present,
      receiptPresent: raw.receipt_present,
      assessmentPresent: raw.stored_assessment_present,
      primaryComparisonId: primaryComparisonId || undefined,
      overallStatus: overallStatus || undefined,
      issues,
      warnings
    }
  };
}

function reviewEvidenceAdequacyMatches(input: {
  artifact: ReviewEvidenceAdequacyArtifact;
  reassessment: EvidenceAdequacyArtifactReassessment;
  trusted: boolean;
  paperEvidenceAllowed: boolean;
  expectedPrimaryComparisonId?: string;
}): boolean {
  const expectedStatus = input.paperEvidenceAllowed
    ? "pass"
    : input.trusted
      ? input.reassessment.assessment?.overall_status || "blocked"
      : input.reassessment.contractPresent
        ? "invalid"
        : "missing_contract";
  const expectedPrimaryComparisonId =
    input.reassessment.assessment?.primary_comparison_id
    || input.expectedPrimaryComparisonId;
  return input.artifact.status === expectedStatus
    && input.artifact.trusted === input.trusted
    && input.artifact.paperEvidenceAllowed === input.paperEvidenceAllowed
    && input.artifact.integrityValid === input.reassessment.integrityValid
    && input.artifact.contractPresent === input.reassessment.contractPresent
    && input.artifact.receiptPresent === input.reassessment.receiptPresent
    && input.artifact.assessmentPresent === input.reassessment.storedAssessmentPresent
    && input.artifact.primaryComparisonId === expectedPrimaryComparisonId
    && input.artifact.overallStatus === input.reassessment.assessment?.overall_status
    && sameStringSet(input.artifact.issues, input.reassessment.issues)
    && sameStringSet(input.artifact.warnings, input.reassessment.warnings);
}

function collectEvidenceAdequacyReasonCodes(
  contractReasons: string[],
  reassessment: EvidenceAdequacyArtifactReassessment
): string[] {
  const reasonCodes = contractReasons.flatMap(extractEvidenceAdequacyCodes);
  for (const check of reassessment.assessment?.checks || []) {
    if (check.status === "pass") {
      continue;
    }
    reasonCodes.push(
      `evidence_adequacy_${check.check_id}_${check.status}`,
      ...check.reasons
    );
  }
  for (const message of [...reassessment.issues, ...reassessment.warnings]) {
    reasonCodes.push(...extractEvidenceAdequacyCodes(message));
    if (message.includes("primary comparison does not match")) {
      reasonCodes.push("evidence_adequacy_primary_comparison_mismatch");
    } else if (message.includes("execution receipt is missing")) {
      reasonCodes.push("evidence_adequacy_receipt_missing");
    } else if (message.includes("Persisted evidence adequacy assessment is missing")) {
      reasonCodes.push("evidence_adequacy_assessment_missing");
    } else if (message.includes("receipt is invalid")) {
      reasonCodes.push("evidence_adequacy_receipt_invalid");
    } else if (message.includes("assessment does not match")) {
      reasonCodes.push("evidence_adequacy_assessment_invalid");
    } else if (message.includes("without a valid frozen contract")) {
      reasonCodes.push("evidence_adequacy_orphan_artifact");
    }
  }
  return uniqueStrings(reasonCodes);
}

function extractEvidenceAdequacyCodes(value: string): string[] {
  return value.match(/evidence_adequacy_[a-z0-9_]+(?::[a-z0-9_.-]+)?/giu)
    ?.map((item) => item.toLowerCase()) || [];
}

function buildEvidenceAdequacyArtifactRefs(input: {
  reassessment: EvidenceAdequacyArtifactReassessment;
  reviewReassessmentPresent: boolean;
}): RunEvidenceAdequacyProjection["artifact_refs"] {
  const refs: RunEvidenceAdequacyProjection["artifact_refs"] = [];
  if (input.reassessment.contractPresent) {
    refs.push({
      kind: "contract",
      label: "Evidence adequacy contract",
      path: EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH
    });
  }
  if (input.reassessment.receiptPresent) {
    refs.push({
      kind: "receipt",
      label: "Evidence adequacy receipt",
      path: EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH
    });
  }
  if (input.reassessment.storedAssessmentPresent) {
    refs.push({
      kind: "assessment",
      label: "Evidence adequacy assessment",
      path: EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH
    });
  }
  if (input.reviewReassessmentPresent) {
    refs.push({
      kind: "review_reassessment",
      label: "Review evidence reassessment",
      path: REVIEW_EVIDENCE_ADEQUACY_RELATIVE_PATH
    });
  }
  return refs;
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return asNonEmptyString(value);
}

function readEvidenceAdequacyOverallStatus(
  value: unknown
): "pass" | "fail" | "unknown" | null | undefined {
  if (value === null) {
    return null;
  }
  return value === "pass" || value === "fail" || value === "unknown"
    ? value
    : undefined;
}

function sameStringSet(left: string[], right: string[]): boolean {
  return JSON.stringify([...new Set(left)].sort())
    === JSON.stringify([...new Set(right)].sort());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectRiskMessages(
  severity: "blocked" | "warning",
  ...artifacts: Array<ReadinessRiskArtifact | undefined>
): string[] {
  const messages = new Set<string>();
  for (const artifact of artifacts) {
    for (const risk of artifact?.risks || []) {
      if (risk.severity === severity && risk.message.trim().length > 0) {
        messages.add(compactOneLine(risk.message, 180) || risk.message);
      }
    }
  }
  return [...messages];
}

function normalizeNetworkDependency(input: {
  policy?: ExperimentNetworkPolicy;
  purpose?: ExperimentNetworkPurpose;
}): RunOperatorStatusArtifact["network_dependency"] {
  const policy = input.policy;
  const purpose = input.purpose;
  if (!policy || policy === "blocked") {
    return {
      enabled: false,
      policy: "blocked",
      severity: "info",
      operator_label: "Offline"
    };
  }
  if (!purpose) {
    return {
      enabled: true,
      policy,
      severity: "blocking",
      operator_label: "Network enabled without declaration"
    };
  }
  if (policy === "required") {
    return {
      enabled: true,
      policy,
      purpose,
      severity: "attention",
      operator_label: `Required network: ${purpose}`
    };
  }
  return {
    enabled: true,
    policy,
    purpose,
    severity: "warning",
    operator_label: `Declared network: ${purpose}`
  };
}

function buildReviewGateOperatorLabel(
  status: RunOperatorStatusArtifact["review_gate"]["status"],
  outcome?: string,
  transition?: string
): string | undefined {
  if (outcome) {
    return transition ? `${outcome} -> ${transition}` : outcome;
  }
  return status;
}

function resolvePaperGateStatus(
  readinessState: string | undefined,
  paperReady: boolean
): RunOperatorStatusArtifact["paper_gate"]["status"] {
  if (!readinessState) {
    return undefined;
  }
  if (paperReady) {
    return "passed";
  }
  if (readinessState === "paper_scale_candidate") {
    return "warning";
  }
  return "blocking";
}

function buildPaperGateOperatorLabel(
  readinessState: string | undefined,
  paperReady: boolean,
  reason?: string
): string | undefined {
  if (!readinessState && !reason) {
    return undefined;
  }
  if (paperReady && readinessState) {
    return readinessState;
  }
  if (readinessState === "blocked_for_paper_scale") {
    return "Paper-readiness stop";
  }
  if (readinessState === "research_memo") {
    return "Research memo";
  }
  if (readinessState) {
    return readinessState;
  }
  return reason;
}

function deriveLifecycleStatus(
  run: RunRecord,
  currentNode: GraphNodeId,
  override?: RunLifecycleStatus
): RunLifecycleStatus {
  if (override) {
    return override;
  }
  const currentStatus = run.graph.nodeStates[currentNode]?.status;
  if (currentStatus === "needs_approval") {
    return "needs_approval";
  }
  return run.status;
}

function deriveRecommendedNextAction(input: {
  run: RunRecord;
  currentNode: GraphNodeId;
  lifecycleStatus: RunLifecycleStatus;
  analysisReady: boolean;
  reviewReady: boolean;
  paperReady: boolean;
  dominantFailure: boolean;
}): RunRecommendedNextAction {
  const pendingTransition = input.run.graph.pendingTransition;
  if (
    pendingTransition
    && (
      pendingTransition.action === "retry_same"
      || pendingTransition.action.startsWith("backtrack_to_")
    )
  ) {
    return "inspect_blocker";
  }
  if (
    pendingTransition
    && (
      pendingTransition.action === "pause_for_human"
      || pendingTransition.action === "delegate_successor"
    )
  ) {
    return "waiting_for_input";
  }
  if (input.run.status === "completed" && input.paperReady) {
    return "completed";
  }
  if (
    (input.lifecycleStatus === "needs_approval" && input.currentNode === "review")
    || (input.analysisReady && !input.reviewReady && (input.currentNode === "analyze_results" || input.currentNode === "review"))
    || (input.reviewReady && !input.paperReady && input.currentNode === "review")
  ) {
    return "resume_review";
  }
  if (input.dominantFailure) {
    return input.run.status === "failed" ? "rerun_after_fix" : "inspect_blocker";
  }
  if (input.lifecycleStatus === "needs_approval" || input.run.status === "paused") {
    return "waiting_for_input";
  }
  if (input.run.status === "failed") {
    return "rerun_after_fix";
  }
  if (input.run.status === "completed") {
    return input.paperReady ? "completed" : "inspect_blocker";
  }
  return "waiting_for_input";
}

function deriveDominantFailure(input: {
  run: RunRecord;
  currentNode: GraphNodeId;
  reviewRisks?: ReadinessRiskArtifact;
  paperRisks?: ReadinessRiskArtifact;
  reviewCritique?: ReviewCritiqueProjection;
  paperReadiness?: PaperReadinessProjection;
}): FailureSeed | undefined {
  const runtimeError = compactOneLine(
    input.run.graph.nodeStates[input.currentNode]?.lastError,
    180
  );
  if (runtimeError) {
    return {
      key: `runtime:${input.currentNode}`,
      summary: runtimeError,
      remediation: `Inspect the latest ${input.currentNode} artifact or event log before retrying the run.`
    };
  }

  const blockedPaperRisk = input.paperRisks?.risks.find((risk) => risk.severity === "blocked");
  if (blockedPaperRisk) {
    return {
      key: `paper:${blockedPaperRisk.category}:${blockedPaperRisk.risk_code}`,
      summary: blockedPaperRisk.message,
      remediation: blockedPaperRisk.recommended_action
    };
  }

  const blockedReviewRisk = input.reviewRisks?.risks.find((risk) => risk.severity === "blocked");
  if (blockedReviewRisk) {
    return {
      key: `review:${blockedReviewRisk.category}:${blockedReviewRisk.risk_code}`,
      summary: blockedReviewRisk.message,
      remediation: blockedReviewRisk.recommended_action
    };
  }

  if ((input.reviewCritique?.blocking_issues_count || 0) > 0) {
    return {
      key: "review:paper_critique",
      summary: `${input.reviewCritique?.blocking_issues_count} blocking critique issue(s) remain before paper drafting.`,
      remediation: "Inspect review/paper_critique.json and resolve the blocking issues before advancing to write_paper."
    };
  }

  if (input.paperReadiness && input.paperReadiness.paper_ready === false && asNonEmptyString(input.paperReadiness.reason)) {
    const summarizedReason = compactOneLine(input.paperReadiness.reason, 180);
    return {
      key: "paper:readiness",
      summary: summarizedReason || "Paper readiness remains blocked by unresolved paper-level requirements.",
      remediation: "Inspect paper/paper_readiness.json and paper/readiness_risks.json before treating the run as complete."
    };
  }

  return undefined;
}

async function hasArtifacts(runDir: string, paths: string[]): Promise<boolean> {
  for (const relativePath of paths) {
    if (!(await fileExists(path.join(runDir, relativePath)))) {
      return false;
    }
  }
  return true;
}

async function readReadinessRisks(filePath: string): Promise<ReadinessRiskArtifact | undefined> {
  const raw = await readTextArtifact(filePath);
  return raw ? parseReadinessRiskArtifact(raw) : undefined;
}

async function readJsonArtifact<T>(filePath: string): Promise<T | undefined> {
  const raw = await readTextArtifact(filePath);
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function readTextArtifact(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function readLastEventTimestamp(runDir: string, fallback: string): Promise<string> {
  const eventsPath = path.join(runDir, "events.jsonl");
  try {
    const raw = await fs.readFile(eventsPath, "utf8");
    const lines = raw
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as { timestamp?: string };
        if (typeof parsed.timestamp === "string" && parsed.timestamp.trim().length > 0) {
          return parsed.timestamp;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore and use fallback
  }
  return fallback;
}

function normalizeReviewGateStatus(
  value: "ready" | "warning" | "blocking" | undefined
): RunOperatorStatusArtifact["review_gate"]["status"] {
  if (value === "ready" || value === "warning" || value === "blocking") {
    return value;
  }
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function compactOneLine(value: string | undefined, maxLength: number): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}
