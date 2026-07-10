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
}

export interface GateReportArtifact extends ResearchGovernanceArtifactBase {
  artifact_type: "GateReport";
  command_intent: "research:audit";
  verdict: ResearchGovernanceVerdict;
  evidence_bundle_id: string;
  claim_ceiling: string;
  checks: {
    baseline_comparator: string;
    result_table_complete_rows: number;
    result_table_rows: number;
    severe_figure_mismatches: number;
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
  target_surface: "prompt" | "validator" | "skill";
  reason: string;
  evidence_refs: string[];
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
const PRIVATE_PATH_PATTERN = new RegExp(
  `(?:^|\\s)(?:${[
    String.fromCharCode(47, 104, 111, 109, 101, 47),
    String.fromCharCode(47, 85, 115, 101, 114, 115, 47),
    String.fromCharCode(47, 109, 110, 116, 47),
    String.fromCharCode(47, 116, 109, 112, 47),
    "[A-Za-z]:\\\\"
  ].join("|")})`,
  "u"
);

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
  now?: Date
): EvidenceBundleArtifact {
  const refs = uniqueStrings([
    summary.outputs.summary_path,
    summary.outputs.blockers_path,
    summary.outputs.claim_evidence_path,
    summary.outputs.audit_timeline_path,
    summary.outputs.done_condition_path,
    summary.outputs.external_intake_manifest_path
  ].filter((value): value is string => Boolean(value)).map(portableArtifactRef));
  const requiredRefs = new Set([
    portableArtifactRef(summary.outputs.summary_path),
    portableArtifactRef(summary.outputs.blockers_path),
    portableArtifactRef(summary.outputs.claim_evidence_path)
  ]);
  const sourceMode = summary.input.mode === "external" ? "external" : "run";
  return {
    ...baseArtifact("EvidenceBundle", "research:audit", {
      sourceMode,
      sourceLabel: summary.input.mode === "external" ? "<external-artifact-root>" : "<run-artifact-root>",
      artifactRefs: refs,
      seed: JSON.stringify({ input: summary.input, outputs: summary.outputs }),
      now
    }),
    artifact_type: "EvidenceBundle",
    command_intent: "research:audit",
    intake_status: summary.top_blockers.some((finding) => finding.code === "artifact_contract_incomplete")
      ? "partial"
      : "complete",
    files: refs.map((artifactPath) => ({
      path: artifactPath,
      required: requiredRefs.has(artifactPath)
    })),
    missing_artifacts: summary.top_blockers
      .filter((finding) => finding.code === "artifact_contract_incomplete")
      .map((finding) => finding.message)
  };
}

export function buildGateReportArtifact(input: {
  summary: PaperReadinessAuditSummary;
  evidenceBundle: EvidenceBundleArtifact;
  now?: Date;
}): GateReportArtifact {
  const summary = input.summary;
  const findings = uniqueFindings([
    ...summary.top_blockers.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      evidence_refs: [portableArtifactRef(summary.outputs.blockers_path)]
    })),
    ...summary.unsupported_claims.map((finding) => ({
      code: "unsupported_claim",
      severity: "blocker" as const,
      message: finding.message,
      evidence_refs: [portableArtifactRef(summary.outputs.claim_evidence_path)]
    })),
    ...summary.citation_support_issues.map((finding) => ({
      code: "citation_support_gap",
      severity: "blocker" as const,
      message: finding.message,
      evidence_refs: [portableArtifactRef(summary.outputs.claim_evidence_path)]
    })),
    ...summary.design_contract_findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      evidence_refs: [portableArtifactRef(finding.evidence_path)]
    }))
  ]);
  return {
    ...baseArtifact("GateReport", "research:audit", {
      sourceMode: "governance_artifact",
      sourceLabel: "EvidenceBundle",
      artifactRefs: [input.evidenceBundle.artifact_id, portableArtifactRef(summary.outputs.summary_path)],
      seed: JSON.stringify({ verdict: summary.verdict, findings }),
      now: input.now
    }),
    artifact_type: "GateReport",
    command_intent: "research:audit",
    verdict: normalizeVerdict(summary.verdict),
    evidence_bundle_id: input.evidenceBundle.artifact_id,
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

export function buildReviewReportArtifact(gate: GateReportArtifact, now?: Date): ReviewReportArtifact {
  const blockingIssues = gate.findings.filter((finding) => finding.severity === "blocker");
  const nonBlockingIssues = gate.findings.filter((finding) => finding.severity === "warning");
  const readinessClass = inferReadinessClass(gate);
  const repairTargets = gate.findings.map(mapFindingToRepairTarget);
  return {
    ...baseArtifact("ReviewReport", "research:review", {
      sourceMode: "governance_artifact",
      sourceLabel: "GateReport",
      artifactRefs: [gate.artifact_id, ...gate.provenance.artifact_refs],
      seed: JSON.stringify({ verdict: gate.verdict, readinessClass, repairTargets }),
      now
    }),
    artifact_type: "ReviewReport",
    command_intent: "research:review",
    verdict: gate.verdict,
    gate_report_id: gate.artifact_id,
    readiness_class: readinessClass,
    paper_ready: readinessClass === "paper_ready" && gate.verdict === "pass",
    claim_ceiling: gate.claim_ceiling,
    blocking_issues: blockingIssues,
    non_blocking_issues: nonBlockingIssues,
    repair_targets: repairTargets
  };
}

export function buildMetaHarnessPatchPlanArtifact(
  review: ReviewReportArtifact,
  now?: Date
): MetaHarnessPatchPlanArtifact {
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
      seed: JSON.stringify(targets),
      now
    }),
    artifact_type: "MetaHarnessPatchPlan",
    command_intent: "research:improve",
    apply_mode: "plan_only",
    review_report_id: review.artifact_id,
    targets
  };
}

export function buildPaperReadinessBundleArtifact(input: {
  gate: GateReportArtifact;
  review: ReviewReportArtifact;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  limitations: string[];
  portabilityIssues?: string[];
  now?: Date;
}): PaperReadinessBundleArtifact {
  const portabilityIssues = uniqueStrings(input.portabilityIssues ?? []);
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
      issues: portabilityIssues
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

function mapFindingToRepairTarget(finding: GateFinding): ReviewRepairTarget {
  const normalized = `${finding.code} ${finding.message}`.toLowerCase().replace(/[_-]+/gu, " ");
  let targetNode: GovernedResearchNode = "review";
  let targetSurface: ReviewRepairTarget["target_surface"] = "validator";

  if (/(artifact contract|governance artifact)/u.test(normalized)) {
    targetNode = "run_experiments";
    targetSurface = "validator";
  } else if (/(literature|canonical paper|related work|source coverage)/u.test(normalized)) {
    targetNode = normalized.includes("collect") ? "collect_papers" : "analyze_papers";
    targetSurface = "prompt";
  } else if (/(hypothesis|research question|novelty)/u.test(normalized)) {
    targetNode = "generate_hypotheses";
    targetSurface = "prompt";
  } else if (/(baseline|comparator|sample|seed|repeat|uncertainty|design contract|single.change)/u.test(normalized)) {
    targetNode = "design_experiments";
    targetSurface = "validator";
  } else if (/(dependency|implementation|syntax|entrypoint|runner)/u.test(normalized)) {
    targetNode = "implement_experiments";
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

  return {
    finding_code: finding.code,
    target_node: targetNode,
    target_surface: targetSurface,
    reason: finding.message,
    evidence_refs: finding.evidence_refs
  };
}

function proposedChangeForTarget(target: ReviewRepairTarget): string {
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
  } else if (artifactType === "GateReport") {
    requireString("evidence_bundle_id");
    requireString("claim_ceiling");
    requireArray("findings");
    requireArray("next_actions");
  } else if (artifactType === "ReviewReport") {
    requireString("gate_report_id");
    requireString("readiness_class");
    requireArray("blocking_issues");
    requireArray("repair_targets");
  } else if (artifactType === "MetaHarnessPatchPlan") {
    requireString("review_report_id");
    requireArray("targets");
    if (value.apply_mode !== "plan_only") {
      issues.push({ code: "invalid_shape", path: "$.apply_mode", message: "MetaHarnessPatchPlan must default to plan_only." });
    }
  } else if (artifactType === "PaperReadinessBundle") {
    requireString("gate_report_id");
    requireString("review_report_id");
    requireArray("files");
    requireArray("limitations");
    if (!isRecord(value.portability)) {
      issues.push({ code: "invalid_shape", path: "$.portability", message: "PaperReadinessBundle requires portability status." });
    }
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
