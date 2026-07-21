import { createHash } from "node:crypto";
import path from "node:path";

import type { PaperReadinessAuditSummary } from "./audit/paperReadinessAudit.js";
import type {
  BriefCompletenessArtifact,
  BriefValidationResult
} from "./runs/researchBriefFiles.js";
import {
  RESEARCH_GOVERNANCE_SCHEMA_VERSION,
  type ResearchGovernanceArtifact,
  type ResearchGovernanceCommandId
} from "./researchGovernanceContract.js";
import {
  collectAdjudicatedModelReviewFindings,
  parseModelReviewBundle,
  type ModelReviewBundle
} from "./modelReviewProtocol.js";
import { createPrivateMachinePathPattern } from "./privateMachinePath.js";

export type ResearchGovernanceVerdict = "pass" | "needs-review" | "blocked";
export type ResearchReadinessClass =
  | "system_validation_note"
  | "research_memo"
  | "paper_scale_candidate"
  | "paper_ready"
  | "blocked_for_paper_scale";

export interface ResearchGovernanceArtifactBase {
  schema_version: typeof RESEARCH_GOVERNANCE_SCHEMA_VERSION;
  artifact_type: ResearchGovernanceArtifact;
  artifact_id: string;
  generated_at: string;
  command_intent: ResearchGovernanceCommandId;
  provenance: {
    source_mode: "brief" | "run" | "external" | "governance_artifact";
    source_label: string;
    artifact_refs: string[];
  };
}

export interface ResearchBriefArtifact extends ResearchGovernanceArtifactBase {
  artifact_type: "ResearchBrief";
  command_intent: "research:new";
  content_sha256: string;
  validation: BriefValidationResult;
  completeness: BriefCompletenessArtifact;
}

export interface EvidenceBundleFile {
  path: string;
  sha256?: string;
  bytes?: number;
  required: boolean;
}

export interface EvidenceBundleArtifact extends ResearchGovernanceArtifactBase {
  artifact_type: "EvidenceBundle";
  command_intent: "research:audit";
  intake_status: "complete" | "partial";
  files: EvidenceBundleFile[];
  missing_artifacts: string[];
}

export interface GateFinding {
  code: string;
  severity: "blocker" | "warning";
  message: string;
  evidence_refs: string[];
  target_node?: GovernedResearchNode;
  target_surface?: "prompt" | "validator" | "skill" | "policy" | "runtime";
  recheck_condition?: string;
}

export interface GateReportArtifact extends ResearchGovernanceArtifactBase {
  artifact_type: "GateReport";
  command_intent: "research:audit";
  verdict: ResearchGovernanceVerdict;
  evidence_bundle_id: string;
  evidence_bundle_sha256: string;
  input_bindings: EvidenceBundleFile[];
  claim_ceiling: string;
  checks: {
    baseline_comparator: string;
    result_table_complete_rows: number;
    result_table_rows: number;
    severe_figure_mismatches: number | null;
    unsupported_claims: number;
    citation_support_issues: number;
    done_condition: string;
  };
  findings: GateFinding[];
  next_actions: string[];
}

export interface ReviewRepairTarget {
  finding_code: string;
  target_node: GovernedResearchNode;
  target_surface: "prompt" | "validator" | "skill" | "policy" | "runtime";
  reason: string;
  evidence_refs: string[];
  recheck_condition?: string;
}

export interface ReviewerAssurance {
  tier: "A0_deterministic" | "A2_model_conservative";
  adjudication_policy: "deterministic_only" | "meta_findings_only";
  panel_size: number;
  specialist_finding_count: number;
  adjudicated_finding_count: number;
  gate_report_sha256: string;
  model_review_bundle_sha256: string | null;
  independent_contexts: boolean;
  adjudicator_present: boolean;
  can_promote: false;
  can_downgrade: true;
  human_authority: false;
  limitations: string[];
}

export interface ReviewReportArtifact extends ResearchGovernanceArtifactBase {
  artifact_type: "ReviewReport";
  command_intent: "research:review";
  verdict: ResearchGovernanceVerdict;
  gate_report_id: string;
  readiness_class: ResearchReadinessClass;
  paper_ready: boolean;
  claim_ceiling: string;
  blocking_issues: GateFinding[];
  non_blocking_issues: GateFinding[];
  repair_targets: ReviewRepairTarget[];
  reviewer_assurance: ReviewerAssurance;
}

export interface BuildReviewReportArtifactOptions {
  modelReviewBundle?: ModelReviewBundle;
  modelReviewBundleSha256?: string;
  gateReportSha256?: string;
}

export interface MetaHarnessPatchTarget extends ReviewRepairTarget {
  proposed_change: string;
  validation_commands: string[];
  rollback_condition: string;
}

export interface MetaHarnessPatchPlanArtifact extends ResearchGovernanceArtifactBase {
  artifact_type: "MetaHarnessPatchPlan";
  command_intent: "research:improve";
  apply_mode: "plan_only";
  review_report_id: string;
  review_report_sha256: string;
  targets: MetaHarnessPatchTarget[];
}

export interface PaperReadinessBundleArtifact extends ResearchGovernanceArtifactBase {
  artifact_type: "PaperReadinessBundle";
  command_intent: "research:pack";
  gate_report_id: string;
  review_report_id: string;
  readiness_class: ResearchReadinessClass;
  paper_ready: boolean;
  claim_ceiling: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  limitations: string[];
  portability: {
    valid: boolean;
    issues: string[];
    redacted_files?: string[];
  };
}

export type ResearchGovernanceArtifactPayload =
  | ResearchBriefArtifact
  | EvidenceBundleArtifact
  | GateReportArtifact
  | ReviewReportArtifact
  | MetaHarnessPatchPlanArtifact
  | PaperReadinessBundleArtifact;

export type GovernedResearchNode =
  | "collect_papers"
  | "analyze_papers"
  | "generate_hypotheses"
  | "design_experiments"
  | "implement_experiments"
  | "run_experiments"
  | "analyze_results"
  | "figure_audit"
  | "review"
  | "write_paper";

export interface ArtifactValidationIssue {
  code: "invalid_shape" | "unsupported_version" | "private_path" | "sensitive_field";
  path: string;
  message: string;
}

export interface ArtifactValidationResult {
  ok: boolean;
  issues: ArtifactValidationIssue[];
}

const ARTIFACT_TYPES = new Set<ResearchGovernanceArtifact>([
  "ResearchBrief",
  "EvidenceBundle",
  "GateReport",
  "ReviewReport",
  "MetaHarnessPatchPlan",
  "PaperReadinessBundle"
]);

const SENSITIVE_FIELD_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key|credential|secret)/iu;
const PRIVATE_PATH_PATTERN = createPrivateMachinePathPattern();

export function buildResearchBriefArtifact(input: {
  markdown: string;
  sourceLabel: string;
  validation: BriefValidationResult;
  completeness: BriefCompletenessArtifact;
  now?: Date;
}): ResearchBriefArtifact {
  const sourceLabel = portableSourceLabel(input.sourceLabel, "<research-brief>");
  return {
    ...baseArtifact("ResearchBrief", "research:new", {
      sourceMode: "brief",
      sourceLabel,
      artifactRefs: [sourceLabel],
      seed: input.markdown,
      now: input.now
    }),
    artifact_type: "ResearchBrief",
    command_intent: "research:new",
    content_sha256: sha256(input.markdown),
    validation: input.validation,
    completeness: input.completeness
  };
}

export function buildEvidenceBundleArtifact(
  summary: PaperReadinessAuditSummary,
  now?: Date,
  boundFiles?: EvidenceBundleFile[]
): EvidenceBundleArtifact {
  const refs = uniqueStrings([
    summary.outputs.summary_path,
    summary.outputs.blockers_path,
    summary.outputs.claim_evidence_path,
    summary.outputs.audit_timeline_path,
    summary.outputs.done_condition_path,
    summary.outputs.external_intake_manifest_path,
    ...summary.research_scale_findings.map((finding) => finding.evidence_path)
  ].filter((value): value is string => Boolean(value)).map(portableArtifactRef));
  const requiredRefs = new Set([
    portableArtifactRef(summary.outputs.summary_path),
    portableArtifactRef(summary.outputs.blockers_path),
    portableArtifactRef(summary.outputs.claim_evidence_path)
  ]);
  const sourceMode = summary.input.mode === "external" ? "external" : "run";
  const files = normalizeEvidenceBundleFiles(
    boundFiles || refs.map((artifactPath) => ({
      path: artifactPath,
      required: requiredRefs.has(artifactPath)
    }))
  );
  return {
    ...baseArtifact("EvidenceBundle", "research:audit", {
      sourceMode,
      sourceLabel: summary.input.mode === "external" ? "<external-artifact-root>" : "<run-artifact-root>",
      artifactRefs: uniqueStrings([...refs, ...files.map((file) => file.path)]),
      seed: JSON.stringify({ input: summary.input, outputs: summary.outputs, files }),
      now
    }),
    artifact_type: "EvidenceBundle",
    command_intent: "research:audit",
    intake_status: summary.top_blockers.some((finding) => finding.code === "artifact_contract_incomplete")
      ? "partial"
      : "complete",
    files,
    missing_artifacts: summary.artifact_contract
      ? summary.artifact_contract.required_artifacts
          .filter((artifact) => artifact.status === "missing_or_empty")
          .map((artifact) => artifact.path)
      : summary.top_blockers
          .filter((finding) => finding.code === "artifact_contract_incomplete")
          .map((finding) => finding.message)
  };
}

export function buildGateReportArtifact(input: {
  summary: PaperReadinessAuditSummary;
  evidenceBundle: EvidenceBundleArtifact;
  evidenceBundleSha256: string;
  now?: Date;
}): GateReportArtifact {
  if (!/^[a-f0-9]{64}$/u.test(input.evidenceBundleSha256)) {
    throw new Error("evidenceBundleSha256 must be a lowercase SHA-256 digest.");
  }
  const summary = input.summary;
  const researchScaleByKey = new Map(summary.research_scale_findings.map((finding) => [
    `${finding.code}\u0000${finding.message}`,
    finding
  ]));
  const findings = uniqueFindings([
    ...summary.top_blockers.map((finding) => {
      const researchScale = researchScaleByKey.get(`${finding.code}\u0000${finding.message}`);
      return {
        code: finding.code,
        severity: finding.severity,
        message: finding.message,
        evidence_refs: [
          portableArtifactRef(researchScale?.evidence_path || summary.outputs.blockers_path)
        ],
        ...(normalizeGovernedNode(researchScale?.target_node)
          ? { target_node: normalizeGovernedNode(researchScale?.target_node) }
          : {}),
        ...(researchScale?.target_surface ? { target_surface: researchScale.target_surface } : {}),
        ...(researchScale?.recheck_condition ? { recheck_condition: researchScale.recheck_condition } : {})
      };
    }),
    ...summary.unsupported_claims.map((finding) => ({
      code: "unsupported_claim",
      severity: "blocker" as const,
      message: finding.message,
      evidence_refs: [portableArtifactRef(finding.evidence_path || summary.outputs.claim_evidence_path)],
      ...(normalizeGovernedNode(finding.target_node)
        ? { target_node: normalizeGovernedNode(finding.target_node) }
        : {}),
      ...(finding.recheck_condition ? { recheck_condition: finding.recheck_condition } : {})
    })),
    ...summary.citation_support_issues.map((finding) => ({
      code: "citation_support_gap",
      severity: "blocker" as const,
      message: finding.message,
      evidence_refs: [portableArtifactRef(finding.evidence_path || summary.outputs.claim_evidence_path)],
      ...(normalizeGovernedNode(finding.target_node)
        ? { target_node: normalizeGovernedNode(finding.target_node) }
        : {}),
      ...(finding.recheck_condition ? { recheck_condition: finding.recheck_condition } : {})
    })),
    ...summary.design_contract_findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      evidence_refs: [portableArtifactRef(finding.evidence_path)]
    }))
  ]);
  const inputBindings = input.evidenceBundle.files.filter(
    (file): file is EvidenceBundleFile & { sha256: string; bytes: number } =>
      typeof file.sha256 === "string" && Number.isInteger(file.bytes)
  );
  return {
    ...baseArtifact("GateReport", "research:audit", {
      sourceMode: "governance_artifact",
      sourceLabel: "EvidenceBundle",
      artifactRefs: [input.evidenceBundle.artifact_id, portableArtifactRef(summary.outputs.summary_path)],
      seed: JSON.stringify({
        evidence_bundle_id: input.evidenceBundle.artifact_id,
        evidence_bundle_sha256: input.evidenceBundleSha256,
        verdict: summary.verdict,
        findings,
        input_bindings: inputBindings
      }),
      now: input.now
    }),
    artifact_type: "GateReport",
    command_intent: "research:audit",
    verdict: normalizeVerdict(summary.verdict),
    evidence_bundle_id: input.evidenceBundle.artifact_id,
    evidence_bundle_sha256: input.evidenceBundleSha256,
    input_bindings: inputBindings,
    claim_ceiling: summary.claim_ceiling.allowed_level,
    checks: {
      baseline_comparator: summary.baseline_comparator_status.status,
      result_table_complete_rows: summary.result_table_completeness.complete_row_count,
      result_table_rows: summary.result_table_completeness.row_count,
      severe_figure_mismatches: summary.figure_result_caption_mismatch.severe_mismatch_count,
      unsupported_claims: summary.unsupported_claims.length,
      citation_support_issues: summary.citation_support_issues.length,
      done_condition: summary.done_condition.status
    },
    findings,
    next_actions: uniqueStrings(summary.next_action_checklist)
  };
}

export function buildReviewReportArtifact(gate: GateReportArtifact, now?: Date): ReviewReportArtifact;
export function buildReviewReportArtifact(
  gate: GateReportArtifact,
  options?: BuildReviewReportArtifactOptions,
  now?: Date
): ReviewReportArtifact;
export function buildReviewReportArtifact(
  gate: GateReportArtifact,
  optionsOrNow?: BuildReviewReportArtifactOptions | Date,
  now?: Date
): ReviewReportArtifact {
  const options = optionsOrNow instanceof Date ? undefined : optionsOrNow;
  const generatedAt = optionsOrNow instanceof Date ? optionsOrNow : now;
  if (!options?.modelReviewBundle && options?.modelReviewBundleSha256) {
    throw new Error("A ModelReviewBundle SHA-256 digest requires a ModelReviewBundle.");
  }
  if (options?.modelReviewBundle
      && (!options.modelReviewBundleSha256 || !options.gateReportSha256)) {
    throw new Error("A2 model review requires exact GateReport and ModelReviewBundle SHA-256 digests.");
  }
  const gateReportSha256 = options?.gateReportSha256
    ?? sha256(`${JSON.stringify(gate, null, 2)}\n`);
  if (!/^[a-f0-9]{64}$/u.test(gateReportSha256)) {
    throw new Error("gateReportSha256 must be a lowercase SHA-256 digest.");
  }
  assertGateEvidenceBinding(gate);
  const modelReviewBundle = options?.modelReviewBundle
    ? parseModelReviewBundle(options.modelReviewBundle, {
        artifact_id: gate.artifact_id,
        sha256: gateReportSha256
      })
    : undefined;
  const modelReviewBundleSha256 = modelReviewBundle
    ? options?.modelReviewBundleSha256 as string
    : null;
  if (modelReviewBundleSha256 !== null && !/^[a-f0-9]{64}$/u.test(modelReviewBundleSha256)) {
    throw new Error("modelReviewBundleSha256 must be a lowercase SHA-256 digest.");
  }

  const modelFindings = modelReviewBundle
    ? collectAdjudicatedModelReviewFindings(modelReviewBundle)
    : [];
  const findings = mergeGateFindingsConservatively([...gate.findings, ...modelFindings]);
  const verdict = conservativeReviewVerdict(gate.verdict, modelFindings);
  const deterministicReadiness = inferReadinessClass(gate);
  const readinessClass = conservativeReviewReadiness(deterministicReadiness, verdict, modelFindings);
  const blockingIssues = findings.filter((finding) => finding.severity === "blocker");
  const nonBlockingIssues = findings.filter((finding) => finding.severity === "warning");
  const repairTargets = findings.map(mapFindingToRepairTarget);
  const reviewerAssurance = buildReviewerAssurance(
    modelReviewBundle,
    modelReviewBundleSha256,
    gateReportSha256
  );
  return {
    ...baseArtifact("ReviewReport", "research:review", {
      sourceMode: "governance_artifact",
      sourceLabel: "GateReport",
      artifactRefs: [gate.artifact_id, ...gate.provenance.artifact_refs],
      seed: JSON.stringify({
        gate_report_id: gate.artifact_id,
        gate_report_sha256: gateReportSha256,
        claim_ceiling: gate.claim_ceiling,
        verdict,
        readinessClass,
        repairTargets,
        reviewerAssurance
      }),
      now: generatedAt
    }),
    artifact_type: "ReviewReport",
    command_intent: "research:review",
    verdict,
    gate_report_id: gate.artifact_id,
    readiness_class: readinessClass,
    paper_ready: readinessClass === "paper_ready" && verdict === "pass",
    claim_ceiling: gate.claim_ceiling,
    blocking_issues: blockingIssues,
    non_blocking_issues: nonBlockingIssues,
    repair_targets: repairTargets,
    reviewer_assurance: reviewerAssurance
  };
}

export function buildMetaHarnessPatchPlanArtifact(
  review: ReviewReportArtifact,
  now?: Date,
  reviewReportSha256?: string
): MetaHarnessPatchPlanArtifact {
  const boundReviewSha256 = reviewReportSha256 || createHash("sha256")
    .update(`${JSON.stringify(review, null, 2)}\n`)
    .digest("hex");
  const targets = review.repair_targets.map((target) => ({
    ...target,
    proposed_change: proposedChangeForTarget(target),
    validation_commands: validationCommandsForTarget(target),
    rollback_condition: "Revert the node-local change if focused validation regresses or the triggering finding remains unchanged."
  }));
  return {
    ...baseArtifact("MetaHarnessPatchPlan", "research:improve", {
      sourceMode: "governance_artifact",
      sourceLabel: "ReviewReport",
      artifactRefs: [review.artifact_id, review.gate_report_id],
      seed: JSON.stringify({ review_report_sha256: boundReviewSha256, targets }),
      now
    }),
    artifact_type: "MetaHarnessPatchPlan",
    command_intent: "research:improve",
    apply_mode: "plan_only",
    review_report_id: review.artifact_id,
    review_report_sha256: boundReviewSha256,
    targets
  };
}

export function buildPaperReadinessBundleArtifact(input: {
  gate: GateReportArtifact;
  review: ReviewReportArtifact;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  limitations: string[];
  portabilityIssues?: string[];
  redactedFiles?: string[];
  now?: Date;
}): PaperReadinessBundleArtifact {
  const portabilityIssues = uniqueStrings(input.portabilityIssues ?? []);
  const redactedFiles = uniqueStrings(input.redactedFiles ?? []);
  return {
    ...baseArtifact("PaperReadinessBundle", "research:pack", {
      sourceMode: "governance_artifact",
      sourceLabel: "ReviewReport",
      artifactRefs: [input.gate.artifact_id, input.review.artifact_id, ...input.files.map((file) => file.path)],
      seed: JSON.stringify({
        gate: input.gate.artifact_id,
        review: input.review.artifact_id,
        files: input.files,
        limitations: input.limitations
      }),
      now: input.now
    }),
    artifact_type: "PaperReadinessBundle",
    command_intent: "research:pack",
    gate_report_id: input.gate.artifact_id,
    review_report_id: input.review.artifact_id,
    readiness_class: input.review.readiness_class,
    paper_ready: input.review.paper_ready,
    claim_ceiling: input.review.claim_ceiling,
    files: input.files,
    limitations: uniqueStrings(input.limitations),
    portability: {
      valid: portabilityIssues.length === 0,
      issues: portabilityIssues,
      ...(redactedFiles.length > 0 ? { redacted_files: redactedFiles } : {})
    }
  };
}

export function validateResearchGovernanceArtifact(value: unknown): ArtifactValidationResult {
  const issues: ArtifactValidationIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ code: "invalid_shape", path: "$", message: "Artifact must be a JSON object." }] };
  }
  if (value.schema_version !== RESEARCH_GOVERNANCE_SCHEMA_VERSION) {
    issues.push({
      code: "unsupported_version",
      path: "$.schema_version",
      message: `Expected schema version ${RESEARCH_GOVERNANCE_SCHEMA_VERSION}.`
    });
  }
  if (typeof value.artifact_type !== "string" || !ARTIFACT_TYPES.has(value.artifact_type as ResearchGovernanceArtifact)) {
    issues.push({ code: "invalid_shape", path: "$.artifact_type", message: "Unknown research governance artifact type." });
  }
  for (const field of ["artifact_id", "generated_at", "command_intent"] as const) {
    if (typeof value[field] !== "string" || value[field].trim().length === 0) {
      issues.push({ code: "invalid_shape", path: `$.${field}`, message: `${field} must be a non-empty string.` });
    }
  }
  if (!isRecord(value.provenance) || !Array.isArray(value.provenance.artifact_refs)) {
    issues.push({ code: "invalid_shape", path: "$.provenance", message: "Artifact provenance and artifact_refs are required." });
  }
  validateArtifactSpecificShape(value, issues);
  inspectPortableValue(value, "$", issues);
  return { ok: issues.length === 0, issues };
}

export function portableArtifactRef(value: string): string {
  const normalized = value.replace(/\\/gu, "/").trim();
  if (!normalized) return "<unspecified-artifact>";
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized) || normalized === ".." || normalized.startsWith("../")) {
    return `<external-artifact-root>/${path.posix.basename(normalized)}`;
  }
  return normalized.replace(/^\.\//u, "");
}

function baseArtifact<T extends ResearchGovernanceArtifact, C extends ResearchGovernanceCommandId>(
  artifactType: T,
  commandIntent: C,
  input: {
    sourceMode: ResearchGovernanceArtifactBase["provenance"]["source_mode"];
    sourceLabel: string;
    artifactRefs: string[];
    seed: string;
    now?: Date;
  }
): ResearchGovernanceArtifactBase & { artifact_type: T; command_intent: C } {
  const generatedAt = (input.now ?? new Date()).toISOString();
  return {
    schema_version: RESEARCH_GOVERNANCE_SCHEMA_VERSION,
    artifact_type: artifactType,
    artifact_id: `${artifactType.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase()}_${sha256(`${artifactType}:${input.seed}`).slice(0, 16)}`,
    generated_at: generatedAt,
    command_intent: commandIntent,
    provenance: {
      source_mode: input.sourceMode,
      source_label: portableSourceLabel(input.sourceLabel, `<${input.sourceMode}-source>`),
      artifact_refs: uniqueStrings(input.artifactRefs.map(portableArtifactRef))
    }
  };
}

function inferReadinessClass(gate: GateReportArtifact): ResearchReadinessClass {
  if (gate.verdict === "blocked") return "blocked_for_paper_scale";
  if (gate.claim_ceiling === "paper_ready" && gate.verdict === "pass") return "paper_ready";
  if (gate.claim_ceiling === "paper_scale_candidate" || gate.verdict === "pass") return "paper_scale_candidate";
  if (gate.claim_ceiling === "system_validation_note") return "system_validation_note";
  return "research_memo";
}

function conservativeReviewVerdict(
  deterministicVerdict: ResearchGovernanceVerdict,
  modelFindings: readonly GateFinding[]
): ResearchGovernanceVerdict {
  if (modelFindings.some((finding) => finding.severity === "blocker")) return "blocked";
  if (deterministicVerdict === "pass"
      && modelFindings.some((finding) => finding.severity === "warning")) {
    return "needs-review";
  }
  return deterministicVerdict;
}

function conservativeReviewReadiness(
  deterministicReadiness: ResearchReadinessClass,
  verdict: ResearchGovernanceVerdict,
  modelFindings: readonly GateFinding[]
): ResearchReadinessClass {
  if (verdict === "blocked") return "blocked_for_paper_scale";
  if (deterministicReadiness === "paper_ready"
      && modelFindings.some((finding) => finding.severity === "warning")) {
    return "paper_scale_candidate";
  }
  return deterministicReadiness;
}

function buildReviewerAssurance(
  bundle: ModelReviewBundle | undefined,
  bundleSha256: string | null,
  gateReportSha256: string
): ReviewerAssurance {
  if (!bundle) {
    return {
      tier: "A0_deterministic",
      adjudication_policy: "deterministic_only",
      panel_size: 0,
      specialist_finding_count: 0,
      adjudicated_finding_count: 0,
      gate_report_sha256: gateReportSha256,
      model_review_bundle_sha256: null,
      independent_contexts: false,
      adjudicator_present: false,
      can_promote: false,
      can_downgrade: true,
      human_authority: false,
      limitations: [
        "Reviewer assurance is limited to deterministic GateReport checks.",
        "No independent model contexts, model adjudicator, or human authority are asserted."
      ]
    };
  }
  if (!bundleSha256) {
    throw new Error("A2 model review requires a ModelReviewBundle SHA-256 digest.");
  }
  return {
    tier: "A2_model_conservative",
    adjudication_policy: "meta_findings_only",
    panel_size: bundle.reviewers.length,
    specialist_finding_count: bundle.reviewers.reduce(
      (count, reviewer) => count + reviewer.findings.length,
      0
    ),
    adjudicated_finding_count: bundle.adjudicator.findings.length,
    gate_report_sha256: gateReportSha256,
    model_review_bundle_sha256: bundleSha256,
    independent_contexts: true,
    adjudicator_present: true,
    can_promote: false,
    can_downgrade: true,
    human_authority: false,
    limitations: [
      "Model review is advisory and cannot promote beyond the deterministic GateReport.",
      "Model consensus is not evidence and cannot create external evidence or human authority.",
      "Specialist findings remain preserved in ModelReviewBundle; only meta-reviewer findings affect ReviewReport readiness and repair targets.",
      "Context isolation and execution provenance are schema-validated attestations; provider receipts and prompt separation are not operationally verified by this report."
    ]
  };
}

function assertGateEvidenceBinding(gate: GateReportArtifact): void {
  if (typeof gate.evidence_bundle_sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(gate.evidence_bundle_sha256)) {
    throw new Error(
      "Research review requires GateReport.evidence_bundle_sha256 to bind the exact EvidenceBundle bytes."
    );
  }
  if (!Array.isArray(gate.input_bindings) || gate.input_bindings.length === 0) {
    throw new Error("Research review requires non-empty GateReport.input_bindings.");
  }
  const invalidBindingIndex = gate.input_bindings.findIndex((binding) => (
    !binding
    || typeof binding.path !== "string"
    || !isPortableEvidenceBindingPath(binding.path)
    || binding.required !== true
    || typeof binding.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(binding.sha256)
    || !Number.isSafeInteger(binding.bytes)
    || Number(binding.bytes) < 0
  ));
  if (invalidBindingIndex >= 0) {
    throw new Error(
      `Research review requires every GateReport.input_bindings entry to be portable, required, and fully SHA-256/byte bound; invalid entry at index ${invalidBindingIndex}.`
    );
  }
}

function mergeGateFindingsConservatively(findings: readonly GateFinding[]): GateFinding[] {
  const byKey = new Map<string, GateFinding>();
  for (const finding of findings) {
    const key = `${finding.code}\u0000${finding.message}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...finding, evidence_refs: [...finding.evidence_refs] });
      continue;
    }
    byKey.set(key, {
      code: existing.code,
      severity: existing.severity === "blocker" || finding.severity === "blocker" ? "blocker" : "warning",
      message: existing.message,
      evidence_refs: uniqueStrings([...existing.evidence_refs, ...finding.evidence_refs]),
      ...(existing.target_node || finding.target_node
        ? { target_node: existing.target_node || finding.target_node }
        : {}),
      ...(existing.target_surface || finding.target_surface
        ? { target_surface: existing.target_surface || finding.target_surface }
        : {}),
      ...(existing.recheck_condition || finding.recheck_condition
        ? { recheck_condition: existing.recheck_condition || finding.recheck_condition }
        : {})
    });
  }
  return [...byKey.values()];
}

function mapFindingToRepairTarget(finding: GateFinding): ReviewRepairTarget {
  const normalized = `${finding.code} ${finding.message}`.toLowerCase().replace(/[_-]+/gu, " ");
  let targetNode: GovernedResearchNode = finding.target_node || "review";
  let targetSurface: ReviewRepairTarget["target_surface"] = finding.target_surface || "validator";

  if (finding.target_node) {
    // Preserve the node selected by the governed review artifact.
  } else if (/(artifact contract|governance artifact)/u.test(normalized)) {
    targetNode = "run_experiments";
    targetSurface = "validator";
  } else if (/(literature|canonical paper|related work|source coverage)/u.test(normalized)) {
    targetNode = normalized.includes("collect") ? "collect_papers" : "analyze_papers";
    targetSurface = "prompt";
  } else if (/(hypothesis|research question|novelty)/u.test(normalized)) {
    targetNode = "generate_hypotheses";
    targetSurface = "prompt";
  } else if (/(dependency|implementation|syntax|entrypoint|runner)/u.test(normalized)) {
    targetNode = "implement_experiments";
    targetSurface = "validator";
  } else if (/(baseline|comparator|sample|seed|repeat|uncertainty|design contract|single.change)/u.test(normalized)) {
    targetNode = "design_experiments";
    targetSurface = "validator";
  } else if (/(execution|failed run|missing metric|run manifest)/u.test(normalized)) {
    targetNode = "run_experiments";
    targetSurface = "validator";
  } else if (/(figure|caption|visual)/u.test(normalized)) {
    targetNode = "figure_audit";
    targetSurface = "validator";
  } else if (/(result table|unsupported claim|claim evidence|effect|statistic)/u.test(normalized)) {
    targetNode = "analyze_results";
    targetSurface = "validator";
  } else if (/(template|latex|bibtex|reference number|duplicate citation|citation format)/u.test(normalized)) {
    targetNode = "write_paper";
    targetSurface = "validator";
  } else if (/(citation|reference)/u.test(normalized)) {
    targetNode = "analyze_papers";
    targetSurface = "validator";
  }
  if (finding.target_surface) {
    targetSurface = finding.target_surface;
  }

  return {
    finding_code: finding.code,
    target_node: targetNode,
    target_surface: targetSurface,
    reason: finding.message,
    evidence_refs: finding.evidence_refs,
    ...(finding.recheck_condition ? { recheck_condition: finding.recheck_condition } : {})
  };
}

function normalizeGovernedNode(value: unknown): GovernedResearchNode | undefined {
  return typeof value === "string" && GOVERNED_RESEARCH_NODES.has(value as GovernedResearchNode)
    ? value as GovernedResearchNode
    : undefined;
}

const GOVERNED_RESEARCH_NODES = new Set<GovernedResearchNode>([
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

function proposedChangeForTarget(target: ReviewRepairTarget): string {
  if (target.finding_code === "artifact_contract_incomplete") {
    return `Require the ${target.target_node} handoff to contain the missing governed artifacts, then rerun the node before downstream promotion.`;
  }
  if (target.finding_code === "result_table_missing" || target.finding_code === "result_table_incomplete") {
    return "Require analyze_results to emit a complete, measurable comparator result table from executed evidence; backtrack to run_experiments when source metrics are absent.";
  }
  if (target.finding_code === "unsupported_claim" || target.finding_code === "unsupported_claims_present") {
    return target.target_node === "analyze_results"
      ? "Require analyze_results to emit parseable claim-evidence rows with artifact links, or lower the claim ceiling before downstream promotion."
      : `Require ${target.target_node} to close the claim's declared evidence requirements before downstream promotion.`;
  }
  if (target.finding_code === "citation_support_gap"
      || target.finding_code === "reference_claim_review_incomplete") {
    return target.target_node === "collect_papers"
      ? "Require collect_papers to acquire and title-check the exact full-text source before citation-claim review can resume."
      : "Require analyze_papers to bind every citation-bearing claim to independently reviewed full-text evidence before manuscript promotion.";
  }
  if (target.finding_code === "reference_full_text_missing") {
    return "Require collect_papers to acquire and title-check the exact full-text source before claim review can resume.";
  }
  if (target.finding_code.startsWith("academic_claim_evidence_blocked:")) {
    return `Require ${target.target_node} to produce every missing evidence item declared by the blocked academic claim, then rerun the submission gate.`;
  }
  return `Strengthen the ${target.target_node} ${target.target_surface} so finding ${target.finding_code} is blocked or downgraded before downstream promotion.`;
}

function validationCommandsForTarget(target: ReviewRepairTarget): string[] {
  const commands = ["npm run build", "npm run validate:harness"];
  if (target.target_node === "write_paper") {
    commands.unshift("npm test -- tests/paperSubmissionSanitization.test.ts tests/harnessValidators.test.ts");
  } else if (target.target_node === "review" || target.target_node === "analyze_results") {
    commands.unshift("npm test -- tests/paperReadinessAudit.test.ts tests/objectiveMetricPropagation.test.ts");
  } else {
    commands.unshift("npm test -- tests/researchGovernanceOperations.test.ts");
  }
  return commands;
}

function inspectPortableValue(value: unknown, currentPath: string, issues: ArtifactValidationIssue[]): void {
  if (typeof value === "string") {
    if (PRIVATE_PATH_PATTERN.test(value)) {
      issues.push({ code: "private_path", path: currentPath, message: "Artifact contains a machine-local absolute path." });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectPortableValue(entry, `${currentPath}[${index}]`, issues));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_FIELD_PATTERN.test(key)) {
      issues.push({ code: "sensitive_field", path: `${currentPath}.${key}`, message: "Sensitive fields are not allowed in public governance artifacts." });
    }
    inspectPortableValue(entry, `${currentPath}.${key}`, issues);
  }
}

function validateArtifactSpecificShape(value: Record<string, unknown>, issues: ArtifactValidationIssue[]): void {
  const artifactType = value.artifact_type;
  const requireString = (field: string): void => {
    if (typeof value[field] !== "string" || String(value[field]).trim().length === 0) {
      issues.push({ code: "invalid_shape", path: `$.${field}`, message: `${field} must be a non-empty string.` });
    }
  };
  const requireArray = (field: string): void => {
    if (!Array.isArray(value[field])) {
      issues.push({ code: "invalid_shape", path: `$.${field}`, message: `${field} must be an array.` });
    }
  };

  if (artifactType === "ResearchBrief") {
    requireString("content_sha256");
    if (!isRecord(value.validation) || !isRecord(value.completeness)) {
      issues.push({ code: "invalid_shape", path: "$", message: "ResearchBrief requires validation and completeness objects." });
    }
  } else if (artifactType === "EvidenceBundle") {
    requireArray("files");
    requireArray("missing_artifacts");
    if (Array.isArray(value.files)) {
      validateEvidenceBundleFiles(value.files, "$.files", false, issues);
    }
  } else if (artifactType === "GateReport") {
    requireString("evidence_bundle_id");
    requireString("claim_ceiling");
    requireString("evidence_bundle_sha256");
    requireArray("input_bindings");
    requireArray("findings");
    requireArray("next_actions");
    if (typeof value.evidence_bundle_sha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(value.evidence_bundle_sha256)) {
      issues.push({
        code: "invalid_shape",
        path: "$.evidence_bundle_sha256",
        message: "evidence_bundle_sha256 must be a lowercase SHA-256 digest."
      });
    }
    if (Array.isArray(value.input_bindings)) {
      if (value.input_bindings.length === 0) {
        issues.push({
          code: "invalid_shape",
          path: "$.input_bindings",
          message: "GateReport requires at least one fully bound evidence input."
        });
      }
      validateEvidenceBundleFiles(value.input_bindings, "$.input_bindings", true, issues);
    }
  } else if (artifactType === "ReviewReport") {
    requireString("gate_report_id");
    requireString("readiness_class");
    requireArray("blocking_issues");
    requireArray("non_blocking_issues");
    requireArray("repair_targets");
    validateGateFindingArray(value.blocking_issues, "$.blocking_issues", "blocker", issues);
    validateGateFindingArray(value.non_blocking_issues, "$.non_blocking_issues", "warning", issues);
    validateRepairTargetArray(value.repair_targets, "$.repair_targets", false, issues);
    validateReviewerAssuranceShape(value.reviewer_assurance, issues);
  } else if (artifactType === "MetaHarnessPatchPlan") {
    requireString("review_report_id");
    requireString("review_report_sha256");
    requireArray("targets");
    if (typeof value.review_report_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.review_report_sha256)) {
      issues.push({
        code: "invalid_shape",
        path: "$.review_report_sha256",
        message: "review_report_sha256 must be a lowercase SHA-256 digest."
      });
    }
    validateRepairTargetArray(value.targets, "$.targets", true, issues);
    if (value.apply_mode !== "plan_only") {
      issues.push({ code: "invalid_shape", path: "$.apply_mode", message: "MetaHarnessPatchPlan must default to plan_only." });
    }
  } else if (artifactType === "PaperReadinessBundle") {
    requireString("gate_report_id");
    requireString("review_report_id");
    requireArray("files");
    requireArray("limitations");
    if (Array.isArray(value.files)) {
      const seenPaths = new Set<string>();
      value.files.forEach((file, index) => {
        if (!isRecord(file) || typeof file.path !== "string") return;
        if (seenPaths.has(file.path)) {
          issues.push({
            code: "invalid_shape",
            path: `$.files[${index}].path`,
            message: `PaperReadinessBundle file path must be unique: ${file.path}`
          });
        }
        seenPaths.add(file.path);
      });
    }
    if (!isRecord(value.portability)) {
      issues.push({ code: "invalid_shape", path: "$.portability", message: "PaperReadinessBundle requires portability status." });
    }
  }
}

const REPAIR_TARGET_SURFACES = new Set(["prompt", "validator", "skill", "policy", "runtime"]);

function validateGateFindingArray(
  value: unknown,
  basePath: string,
  expectedSeverity: "blocker" | "warning",
  issues: ArtifactValidationIssue[]
): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    const entryPath = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ code: "invalid_shape", path: entryPath, message: "Finding must be an object." });
      return;
    }
    for (const field of ["code", "message"] as const) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        issues.push({ code: "invalid_shape", path: `${entryPath}.${field}`, message: `${field} must be a non-empty string.` });
      }
    }
    if (entry.severity !== expectedSeverity) {
      issues.push({ code: "invalid_shape", path: `${entryPath}.severity`, message: `Finding severity must be ${expectedSeverity}.` });
    }
    validateEvidenceRefs(entry.evidence_refs, `${entryPath}.evidence_refs`, issues);
    if (entry.target_node !== undefined && !normalizeGovernedNode(entry.target_node)) {
      issues.push({ code: "invalid_shape", path: `${entryPath}.target_node`, message: "target_node must name a governed research node." });
    }
    if (entry.target_surface !== undefined && !REPAIR_TARGET_SURFACES.has(String(entry.target_surface))) {
      issues.push({ code: "invalid_shape", path: `${entryPath}.target_surface`, message: "target_surface is not supported." });
    }
  });
}

function validateRepairTargetArray(
  value: unknown,
  basePath: string,
  patchTarget: boolean,
  issues: ArtifactValidationIssue[]
): void {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    const entryPath = `${basePath}[${index}]`;
    if (!isRecord(entry)) {
      issues.push({ code: "invalid_shape", path: entryPath, message: "Repair target must be an object." });
      return;
    }
    for (const field of ["finding_code", "reason"] as const) {
      if (typeof entry[field] !== "string" || !entry[field].trim()) {
        issues.push({ code: "invalid_shape", path: `${entryPath}.${field}`, message: `${field} must be a non-empty string.` });
      }
    }
    if (!normalizeGovernedNode(entry.target_node)) {
      issues.push({ code: "invalid_shape", path: `${entryPath}.target_node`, message: "target_node must name a governed research node." });
    }
    if (!REPAIR_TARGET_SURFACES.has(String(entry.target_surface))) {
      issues.push({ code: "invalid_shape", path: `${entryPath}.target_surface`, message: "target_surface is not supported." });
    }
    validateEvidenceRefs(entry.evidence_refs, `${entryPath}.evidence_refs`, issues);
    if (patchTarget) {
      for (const field of ["proposed_change", "rollback_condition"] as const) {
        if (typeof entry[field] !== "string" || !entry[field].trim()) {
          issues.push({ code: "invalid_shape", path: `${entryPath}.${field}`, message: `${field} must be a non-empty string.` });
        }
      }
      if (!Array.isArray(entry.validation_commands) || entry.validation_commands.length === 0
          || entry.validation_commands.some((command) => typeof command !== "string" || !command.trim())) {
        issues.push({ code: "invalid_shape", path: `${entryPath}.validation_commands`, message: "validation_commands must contain non-empty commands." });
      }
    }
  });
}

function validateEvidenceRefs(value: unknown, valuePath: string, issues: ArtifactValidationIssue[]): void {
  if (!Array.isArray(value) || value.length === 0
      || value.some((ref) => typeof ref !== "string" || !ref.trim())) {
    issues.push({ code: "invalid_shape", path: valuePath, message: "evidence_refs must contain at least one non-empty reference." });
  }
}

function isPortableEvidenceBindingPath(value: string): boolean {
  const normalized = path.posix.normalize(value);
  return value.length > 0
    && value === normalized
    && !value.includes("\\")
    && !value.startsWith("<")
    && !path.posix.isAbsolute(value)
    && !/^[A-Za-z]:\//u.test(value)
    && !value.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

function validateEvidenceBundleFiles(
  files: unknown[],
  currentPath: string,
  requireBinding: boolean,
  issues: ArtifactValidationIssue[]
): void {
  const seenPaths = new Set<string>();
  files.forEach((value, index) => {
    const itemPath = `${currentPath}[${index}]`;
    if (!isRecord(value)
        || typeof value.path !== "string"
        || typeof value.required !== "boolean") {
      issues.push({
        code: "invalid_shape",
        path: itemPath,
        message: "Evidence file entries require path and required fields."
      });
      return;
    }
    if (requireBinding && !isPortableEvidenceBindingPath(value.path)) {
      issues.push({
        code: "invalid_shape",
        path: `${itemPath}.path`,
        message: "GateReport input binding paths must be normalized portable relative paths."
      });
    }
    if (seenPaths.has(value.path)) {
      issues.push({
        code: "invalid_shape",
        path: `${itemPath}.path`,
        message: `Evidence file path must be unique: ${value.path}`
      });
    }
    seenPaths.add(value.path);
    const hasSha = typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256);
    const hasBytes = Number.isInteger(value.bytes) && Number(value.bytes) >= 0;
    if (requireBinding && (!hasSha || !hasBytes)) {
      issues.push({
        code: "invalid_shape",
        path: itemPath,
        message: "GateReport input bindings require lowercase SHA-256 and non-negative byte length."
      });
    } else if (("sha256" in value || "bytes" in value) && (!hasSha || !hasBytes)) {
      issues.push({
        code: "invalid_shape",
        path: itemPath,
        message: "Evidence file hash and byte length must be supplied together."
      });
    }
  });
}

function normalizeEvidenceBundleFiles(files: readonly EvidenceBundleFile[]): EvidenceBundleFile[] {
  const byPath = new Map<string, EvidenceBundleFile>();
  for (const file of files) {
    const artifactPath = portableArtifactRef(file.path);
    const existing = byPath.get(artifactPath);
    const candidate: EvidenceBundleFile = {
      path: artifactPath,
      required: file.required || existing?.required === true,
      ...(typeof file.sha256 === "string" ? { sha256: file.sha256 } : {}),
      ...(Number.isInteger(file.bytes) ? { bytes: file.bytes } : {})
    };
    if (!existing || candidate.sha256 || !existing.sha256) {
      byPath.set(artifactPath, candidate);
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function validateReviewerAssuranceShape(
  value: unknown,
  issues: ArtifactValidationIssue[]
): void {
  const currentPath = "$.reviewer_assurance";
  if (!isRecord(value)) {
    issues.push({
      code: "invalid_shape",
      path: currentPath,
      message: "ReviewReport requires reviewer_assurance."
    });
    return;
  }
  const expectedFields = [
    "tier",
    "adjudication_policy",
    "panel_size",
    "specialist_finding_count",
    "adjudicated_finding_count",
    "gate_report_sha256",
    "model_review_bundle_sha256",
    "independent_contexts",
    "adjudicator_present",
    "can_promote",
    "can_downgrade",
    "human_authority",
    "limitations"
  ];
  const actualFieldKey = Object.keys(value).sort().join("\0");
  const currentFieldKey = [...expectedFields].sort().join("\0");
  const currentAssurance = actualFieldKey === currentFieldKey;
  if (!currentAssurance) {
    issues.push({
      code: "invalid_shape",
      path: currentPath,
      message: "reviewer_assurance fields must match the current schema exactly."
    });
  }
  if (value.tier !== "A0_deterministic" && value.tier !== "A2_model_conservative") {
    issues.push({ code: "invalid_shape", path: `${currentPath}.tier`, message: "Unknown reviewer assurance tier." });
  }
  if (currentAssurance
      && value.adjudication_policy !== "deterministic_only"
      && value.adjudication_policy !== "meta_findings_only") {
    issues.push({
      code: "invalid_shape",
      path: `${currentPath}.adjudication_policy`,
      message: "Unknown model-review adjudication policy."
    });
  }
  if (!Number.isInteger(value.panel_size) || Number(value.panel_size) < 0) {
    issues.push({
      code: "invalid_shape",
      path: `${currentPath}.panel_size`,
      message: "panel_size must be a non-negative integer."
    });
  }
  if (currentAssurance) {
    for (const field of ["specialist_finding_count", "adjudicated_finding_count"] as const) {
      if (Number.isInteger(value[field]) && Number(value[field]) >= 0) continue;
      issues.push({
        code: "invalid_shape",
        path: `${currentPath}.${field}`,
        message: `${field} must be a non-negative integer.`
      });
    }
  }
  if (currentAssurance
      && (typeof value.gate_report_sha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(value.gate_report_sha256))) {
    issues.push({
      code: "invalid_shape",
      path: `${currentPath}.gate_report_sha256`,
      message: "gate_report_sha256 must bind the exact GateReport bytes."
    });
  }
  if (typeof value.independent_contexts !== "boolean") {
    issues.push({
      code: "invalid_shape",
      path: `${currentPath}.independent_contexts`,
      message: "independent_contexts must be boolean."
    });
  }
  if (typeof value.adjudicator_present !== "boolean") {
    issues.push({
      code: "invalid_shape",
      path: `${currentPath}.adjudicator_present`,
      message: "adjudicator_present must be boolean."
    });
  }
  if (value.can_promote !== false || value.can_downgrade !== true || value.human_authority !== false) {
    issues.push({
      code: "invalid_shape",
      path: currentPath,
      message: "reviewer_assurance must forbid promotion, allow downgrade, and disclaim human authority."
    });
  }
  if (!Array.isArray(value.limitations)
      || value.limitations.length === 0
      || !value.limitations.every((item) => typeof item === "string" && item.trim().length > 0)) {
    issues.push({
      code: "invalid_shape",
      path: `${currentPath}.limitations`,
      message: "reviewer_assurance limitations must contain non-empty text."
    });
  }

  if (value.tier === "A0_deterministic"
      && (value.panel_size !== 0
        || (currentAssurance && value.adjudication_policy !== "deterministic_only")
        || (currentAssurance && value.specialist_finding_count !== 0)
        || (currentAssurance && value.adjudicated_finding_count !== 0)
        || value.model_review_bundle_sha256 !== null
        || value.independent_contexts !== false
        || value.adjudicator_present !== false)) {
    issues.push({
      code: "invalid_shape",
      path: currentPath,
      message: "A0_deterministic cannot assert a model panel, bundle hash, independent contexts, or adjudicator."
    });
  }
  if (value.tier === "A2_model_conservative"
      && ((currentAssurance && value.adjudication_policy !== "meta_findings_only")
        || !Number.isInteger(value.panel_size)
        || Number(value.panel_size) < 5
        || typeof value.model_review_bundle_sha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(value.model_review_bundle_sha256)
        || value.independent_contexts !== true
        || value.adjudicator_present !== true)) {
    issues.push({
      code: "invalid_shape",
      path: currentPath,
      message: "A2_model_conservative requires at least five independent model reviewers and an adjudicator-bound bundle hash."
    });
  }
}

function portableSourceLabel(value: string, fallback: string): string {
  const portable = portableArtifactRef(value);
  return portable === "<unspecified-artifact>" ? fallback : portable;
}

function normalizeVerdict(verdict: PaperReadinessAuditSummary["verdict"]): ResearchGovernanceVerdict {
  if (verdict === "conditionally-ready") return "pass";
  return verdict;
}

function uniqueFindings(findings: GateFinding[]): GateFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}:${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
