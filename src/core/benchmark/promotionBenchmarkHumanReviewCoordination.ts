import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonFile } from "../../utils/fs.js";
import {
  inspectPromotionTrialCandidateLicenseReviewWorkspace,
  inspectPromotionTrialCandidateReviewWorkspace,
  type PromotionTrialCandidateLicenseReviewWorkspaceAuditReport,
  type PromotionTrialCandidateReviewWorkspaceAuditReport
} from "./promotionBenchmarkTrialCandidateReviewWorkspace.js";
import {
  inspectReferenceClaimReviewWorkspaceState,
  type ReferenceClaimReviewWorkspaceAuditReport
} from "../referenceClaimReviewWorkspace.js";

export const PROMOTION_HUMAN_REVIEW_COORDINATION_AUDIT =
  "human-review-coordination-audit.json";

export type PromotionHumanReviewCoordinationStatus =
  | "invalid"
  | "awaiting_human_review"
  | "ready_for_collection";

export interface PromotionHumanReviewWorkspaceSnapshot {
  workspace_ref: string;
  tree_sha256: string;
  file_count: number;
  byte_count: number;
}

export interface PromotionHumanReviewCoordinationIssue {
  code: string;
  message: string;
  role?: string;
}

export interface PromotionHumanReviewCandidateRole {
  role: "candidate_reviewer_a" | "candidate_reviewer_b";
  snapshot: PromotionHumanReviewWorkspaceSnapshot;
  handoff_id: string | null;
  reviewer_id: string | null;
  workspace_valid: boolean;
  ready_to_finalize: boolean;
  task_count: number;
  completed_count: number;
  incomplete_count: number;
  malformed_count: number;
  attestation_complete: boolean;
  packet_integrity_valid: boolean;
  validation_issue_codes: string[];
}

export interface PromotionHumanReviewLicenseRole {
  role: "license_reviewer";
  snapshot: PromotionHumanReviewWorkspaceSnapshot;
  handoff_id: string | null;
  reviewer_id: string | null;
  review_scope: "source_only" | "candidate_scoped" | null;
  workspace_valid: boolean;
  ready_to_finalize: boolean;
  task_count: number;
  completed_count: number;
  incomplete_count: number;
  malformed_count: number;
  aggregate_review_complete: boolean;
  attestation_complete: boolean;
  packet_integrity_valid: boolean;
  validation_issue_codes: string[];
}

export interface PromotionHumanReviewCitationRole {
  role: "citation_reviewer";
  snapshot: PromotionHumanReviewWorkspaceSnapshot;
  workspace_id: string | null;
  handoff_id: string | null;
  reviewer_id: string | null;
  workspace_valid: boolean;
  ready_to_finalize: boolean;
  task_count: number;
  completed_count: number;
  incomplete_count: number;
  malformed_count: number;
  attestation_complete: boolean;
  source_package_binding_valid: boolean;
  packet_integrity_valid: boolean;
  validation_issue_codes: string[];
}

export interface PromotionHumanReviewCoordinationAuditReport {
  schema_version: "1.0";
  generated_at: string;
  coordination_id: string;
  status: PromotionHumanReviewCoordinationStatus;
  coordination_valid: boolean;
  ready_for_collection: boolean;
  required_role_count: 4;
  structurally_valid_role_count: number;
  ready_role_count: number;
  candidate_handoff_id: string | null;
  reference_handoff_id: string | null;
  roles: {
    candidate_reviewers: [
      PromotionHumanReviewCandidateRole,
      PromotionHumanReviewCandidateRole
    ];
    license_reviewer: PromotionHumanReviewLicenseRole;
    citation_reviewer: PromotionHumanReviewCitationRole;
  };
  role_separation: {
    candidate_reviewers_distinct: boolean;
    license_reviewer_distinct_from_candidates: boolean;
    citation_reviewer_identity_available: boolean;
    citation_reviewer_distinct_from_other_roles: boolean | null;
  };
  human_decisions_supplied_by_system: 0;
  human_attestations_set_by_system: 0;
  final_approvals_supplied_by_system: 0;
  claim_statuses_modified: false;
  confirmatory_admitted: false;
  public_distribution_allowed: false;
  validation_issues: PromotionHumanReviewCoordinationIssue[];
  evidence_boundary: string;
}

export interface PromotionHumanReviewCoordinationRoleState {
  snapshot: PromotionHumanReviewWorkspaceSnapshot;
}

export interface BuildPromotionHumanReviewCoordinationReportInput {
  generatedAt?: string;
  candidateReviewers: [
    PromotionHumanReviewCoordinationRoleState & {
      report: PromotionTrialCandidateReviewWorkspaceAuditReport;
    },
    PromotionHumanReviewCoordinationRoleState & {
      report: PromotionTrialCandidateReviewWorkspaceAuditReport;
    }
  ];
  licenseReviewer: PromotionHumanReviewCoordinationRoleState & {
    report: PromotionTrialCandidateLicenseReviewWorkspaceAuditReport;
  };
  citationReviewer: PromotionHumanReviewCoordinationRoleState & {
    report: ReferenceClaimReviewWorkspaceAuditReport;
  };
}

export interface AuditPromotionHumanReviewCoordinationInput {
  cwd: string;
  candidateWorkspaceRoots: string[];
  licenseWorkspaceRoot: string;
  referenceWorkspaceRoot: string;
  outDir: string;
}

export interface AuditPromotionHumanReviewCoordinationResult {
  report: PromotionHumanReviewCoordinationAuditReport;
  report_path: string;
  summary_path: string;
}

interface ResolvedWorkspace {
  root: string;
  snapshot: PromotionHumanReviewWorkspaceSnapshot;
}

export function buildPromotionHumanReviewCoordinationReport(
  input: BuildPromotionHumanReviewCoordinationReportInput
): PromotionHumanReviewCoordinationAuditReport {
  const candidateRoles = input.candidateReviewers.map((state, index) => {
    const report = state.report;
    return {
      role: index === 0 ? "candidate_reviewer_a" : "candidate_reviewer_b",
      snapshot: state.snapshot,
      handoff_id: report.handoff_id,
      reviewer_id: report.annotator_id,
      workspace_valid: report.workspace_valid,
      ready_to_finalize: report.ready_to_finalize,
      task_count: report.task_count,
      completed_count: report.completed_annotation_count,
      incomplete_count: report.incomplete_annotation_count,
      malformed_count: report.malformed_annotation_count,
      attestation_complete: report.attestation_complete,
      packet_integrity_valid: report.packet_integrity_valid,
      validation_issue_codes: report.validation_issues.map((issue) => issue.code)
    } satisfies PromotionHumanReviewCandidateRole;
  }) as [
    PromotionHumanReviewCandidateRole,
    PromotionHumanReviewCandidateRole
  ];
  const licenseReport = input.licenseReviewer.report;
  const licenseRole: PromotionHumanReviewLicenseRole = {
    role: "license_reviewer",
    snapshot: input.licenseReviewer.snapshot,
    handoff_id: licenseReport.handoff_id,
    reviewer_id: licenseReport.reviewer_id,
    review_scope: licenseReport.review_scope,
    workspace_valid: licenseReport.workspace_valid,
    ready_to_finalize: licenseReport.ready_to_finalize,
    task_count: licenseReport.subject_count,
    completed_count: licenseReport.completed_subject_review_count,
    incomplete_count: licenseReport.incomplete_subject_review_count,
    malformed_count: licenseReport.malformed_subject_review_count,
    aggregate_review_complete: licenseReport.aggregate_review_complete,
    attestation_complete: licenseReport.attestation_complete,
    packet_integrity_valid: licenseReport.packet_integrity_valid,
    validation_issue_codes: licenseReport.validation_issues.map((issue) => issue.code)
  };
  const citationReport = input.citationReviewer.report;
  const citationReviewerId = citationReport.attestation?.reviewer_id ?? null;
  const citationRole: PromotionHumanReviewCitationRole = {
    role: "citation_reviewer",
    snapshot: input.citationReviewer.snapshot,
    workspace_id: citationReport.workspace_id,
    handoff_id: citationReport.handoff_id,
    reviewer_id: citationReviewerId,
    workspace_valid: citationReport.workspace_valid,
    ready_to_finalize: citationReport.ready_to_finalize,
    task_count: citationReport.task_count,
    completed_count: citationReport.completed_review_count,
    incomplete_count: citationReport.incomplete_review_count,
    malformed_count: citationReport.malformed_review_count,
    attestation_complete: citationReport.attestation_complete,
    source_package_binding_valid: citationReport.source_package_binding_valid,
    packet_integrity_valid: citationReport.packet_integrity_valid,
    validation_issue_codes: citationReport.validation_issues.map((issue) => issue.code)
  };

  const candidateIds = candidateRoles.map((role) => role.reviewer_id);
  const candidateReviewersDistinct = candidateIds.every(nonEmpty)
    && candidateIds[0] !== candidateIds[1];
  const licenseReviewerDistinct = nonEmpty(licenseRole.reviewer_id)
    && candidateIds.every((reviewerId) => reviewerId !== licenseRole.reviewer_id);
  const citationIdentityAvailable = nonEmpty(citationReviewerId);
  const citationReviewerDistinct = citationIdentityAvailable
    ? [...candidateIds, licenseRole.reviewer_id].every(
      (reviewerId) => reviewerId !== citationReviewerId
    )
    : null;
  const candidateHandoffId = sameNonEmpty(
    candidateRoles[0].handoff_id,
    candidateRoles[1].handoff_id
  )
    ? candidateRoles[0].handoff_id
    : null;

  const issues: PromotionHumanReviewCoordinationIssue[] = [];
  for (const role of [...candidateRoles, licenseRole, citationRole]) {
    if (!role.workspace_valid) {
      issues.push({
        code: "human_review_role_workspace_invalid",
        message: "An assigned review workspace failed its live structural audit.",
        role: role.role
      });
    }
    if (!role.packet_integrity_valid) {
      issues.push({
        code: "human_review_role_packet_integrity_invalid",
        message: "An assigned review workspace failed packet-integrity verification.",
        role: role.role
      });
    }
  }
  if (!candidateReviewersDistinct) {
    issues.push({
      code: "candidate_reviewer_roles_not_distinct",
      message: "The two candidate-review workspaces must name distinct reviewers."
    });
  }
  if (!licenseReviewerDistinct) {
    issues.push({
      code: "license_reviewer_role_not_distinct",
      message: "The license reviewer must differ from both candidate reviewers."
    });
  }
  if (citationReviewerDistinct === false) {
    issues.push({
      code: "citation_reviewer_role_not_distinct",
      message: "A named citation reviewer must differ from candidate and license reviewers."
    });
  }
  if (!candidateHandoffId) {
    issues.push({
      code: "candidate_reviewer_handoff_mismatch",
      message: "Candidate-review workspaces do not share one non-empty handoff ID."
    });
  }
  if (!sameNonEmpty(candidateRoles[0].task_count, candidateRoles[1].task_count)) {
    issues.push({
      code: "candidate_reviewer_task_count_mismatch",
      message: "Candidate-review workspaces do not expose the same task count."
    });
  }
  if (!candidateHandoffId
      || licenseRole.handoff_id !== candidateHandoffId) {
    issues.push({
      code: "candidate_license_handoff_mismatch",
      message: "The license-review workspace is not bound to the candidate-review handoff."
    });
  }
  const snapshots = [
    ...candidateRoles.map((role) => role.snapshot),
    licenseRole.snapshot,
    citationRole.snapshot
  ];
  if (new Set(snapshots.map((snapshot) => snapshot.workspace_ref)).size !== 4) {
    issues.push({
      code: "human_review_workspace_assignment_reused",
      message: "Each required human-review role must use a separate workspace."
    });
  }

  const allRoles = [...candidateRoles, licenseRole, citationRole];
  const coordinationValid = issues.length === 0
    && allRoles.every((role) => role.workspace_valid && role.packet_integrity_valid);
  const readyForCollection = coordinationValid
    && citationIdentityAvailable
    && citationReviewerDistinct === true
    && allRoles.every((role) => role.ready_to_finalize && role.attestation_complete);
  const coordinationId = "human-review-coordination-"
    + sha256(Buffer.from(JSON.stringify({
      candidate_handoff_id: candidateHandoffId,
      reference_handoff_id: citationRole.handoff_id,
      roles: snapshots.map((snapshot) => ({
        workspace_ref: snapshot.workspace_ref,
        tree_sha256: snapshot.tree_sha256
      }))
    }), "utf8")).slice(0, 16);

  return {
    schema_version: "1.0",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    coordination_id: coordinationId,
    status: !coordinationValid
      ? "invalid"
      : readyForCollection
        ? "ready_for_collection"
        : "awaiting_human_review",
    coordination_valid: coordinationValid,
    ready_for_collection: readyForCollection,
    required_role_count: 4,
    structurally_valid_role_count: allRoles.filter((role) => role.workspace_valid).length,
    ready_role_count: allRoles.filter((role) => role.ready_to_finalize).length,
    candidate_handoff_id: candidateHandoffId,
    reference_handoff_id: citationRole.handoff_id,
    roles: {
      candidate_reviewers: candidateRoles,
      license_reviewer: licenseRole,
      citation_reviewer: citationRole
    },
    role_separation: {
      candidate_reviewers_distinct: candidateReviewersDistinct,
      license_reviewer_distinct_from_candidates: licenseReviewerDistinct,
      citation_reviewer_identity_available: citationIdentityAvailable,
      citation_reviewer_distinct_from_other_roles: citationReviewerDistinct
    },
    human_decisions_supplied_by_system: 0,
    human_attestations_set_by_system: 0,
    final_approvals_supplied_by_system: 0,
    claim_statuses_modified: false,
    confirmatory_admitted: false,
    public_distribution_allowed: false,
    validation_issues: issues,
    evidence_boundary: "This private coordination audit re-inspects four editable workspaces, binds their current byte trees, checks role assignment, and reports structural progress only. It does not supply or validate human judgments, set attestations, verify real-world identity or expertise, adjudicate reviews, finalize returns, approve citations, run reference verification, admit confirmatory evidence, change claim status, authorize redistribution, or establish paper readiness."
  };
}

export async function auditPromotionHumanReviewCoordination(
  input: AuditPromotionHumanReviewCoordinationInput
): Promise<AuditPromotionHumanReviewCoordinationResult> {
  if (input.candidateWorkspaceRoots.length !== 2) {
    throw new Error("Human-review coordination requires exactly two candidate workspaces.");
  }
  const cwd = await fs.realpath(path.resolve(input.cwd));
  const candidates = await Promise.all(input.candidateWorkspaceRoots.map(
    (workspaceRoot, index) => resolveAndSnapshotWorkspace(
      cwd,
      workspaceRoot,
      `Candidate reviewer ${index + 1} workspace`
    )
  )) as [ResolvedWorkspace, ResolvedWorkspace];
  const license = await resolveAndSnapshotWorkspace(
    cwd,
    input.licenseWorkspaceRoot,
    "License reviewer workspace"
  );
  const citation = await resolveAndSnapshotWorkspace(
    cwd,
    input.referenceWorkspaceRoot,
    "Citation reviewer workspace"
  );
  const roots = [...candidates.map((item) => item.root), license.root, citation.root];
  if (new Set(roots).size !== roots.length) {
    throw new Error("Each human-review role must use a separate workspace directory.");
  }

  const outDir = path.resolve(cwd, input.outDir);
  await assertFreshOutputPath(cwd, outDir);
  const canonicalOutDir = await resolveProspectiveCanonicalPath(outDir);
  if (roots.some((root) =>
    isSameOrContainedPath(root, canonicalOutDir)
    || isSameOrContainedPath(canonicalOutDir, root))) {
    throw new Error("Human-review coordination output must stay separate from all workspaces.");
  }

  const workspaceLabels = [
    "Candidate reviewer 1 workspace", "Candidate reviewer 2 workspace",
    "License reviewer workspace", "Citation reviewer workspace"
  ] as const;
  const [candidateReports, licenseReport, citationReport] = await Promise.all([
    Promise.all(candidates.map((workspace) =>
      inspectPromotionTrialCandidateReviewWorkspace({
        cwd,
        workspaceRoot: workspace.root
      }))),
    inspectPromotionTrialCandidateLicenseReviewWorkspace({
      cwd,
      workspaceRoot: license.root
    }),
    inspectReferenceClaimReviewWorkspaceState({
      cwd,
      workspaceRoot: citation.root
    })
  ]);
  const stableWorkspaces = await Promise.all(roots.map((root, index) =>
    resolveAndSnapshotWorkspace(cwd, root, workspaceLabels[index])
  )) as [ResolvedWorkspace, ResolvedWorkspace, ResolvedWorkspace, ResolvedWorkspace];
  const initialSnapshots = [
    ...candidates.map((workspace) => workspace.snapshot),
    license.snapshot,
    citation.snapshot
  ];
  if (initialSnapshots.some((snapshot, index) =>
    !sameSnapshot(snapshot, stableWorkspaces[index].snapshot))) {
    throw new Error(
      "A human-review workspace changed during coordination audit; rerun after edits settle."
    );
  }
  const report = buildPromotionHumanReviewCoordinationReport({
    candidateReviewers: [
      { snapshot: stableWorkspaces[0].snapshot, report: candidateReports[0] },
      { snapshot: stableWorkspaces[1].snapshot, report: candidateReports[1] }
    ],
    licenseReviewer: { snapshot: stableWorkspaces[2].snapshot, report: licenseReport },
    citationReviewer: { snapshot: stableWorkspaces[3].snapshot, report: citationReport }
  });

  const stagingRoot = path.join(
    path.dirname(outDir),
    `.${path.basename(outDir)}.staging-${randomUUID()}`
  );
  await fs.mkdir(stagingRoot, { recursive: true });
  try {
    const reportPath = path.join(stagingRoot, PROMOTION_HUMAN_REVIEW_COORDINATION_AUDIT);
    const summaryPath = path.join(stagingRoot, "human-review-coordination-audit.md");
    await writeJsonFile(reportPath, report);
    await fs.writeFile(summaryPath, renderSummary(report), "utf8");
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    report,
    report_path: portableRef(
      cwd,
      path.join(outDir, PROMOTION_HUMAN_REVIEW_COORDINATION_AUDIT)
    ),
    summary_path: portableRef(
      cwd,
      path.join(outDir, "human-review-coordination-audit.md")
    )
  };
}

async function resolveAndSnapshotWorkspace(
  cwd: string,
  workspacePath: string,
  label: string
): Promise<ResolvedWorkspace> {
  const requested = path.resolve(cwd, workspacePath);
  const requestedStat = await fs.lstat(requested);
  if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory.`);
  }
  const root = await fs.realpath(requested);
  assertInside(cwd, root, label);
  const entries: Array<{ path: string; sha256: string; byte_count: number }> = [];
  const pending = [""];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop() as string;
    const absoluteDirectory = path.join(root, relativeDirectory);
    const children = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relative = path.join(relativeDirectory, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link.`);
      }
      if (child.isDirectory()) {
        pending.push(relative);
        continue;
      }
      if (!child.isFile()) {
        throw new Error(`${label} contains a non-regular entry.`);
      }
      const bytes = await fs.readFile(path.join(root, relative));
      entries.push({
        path: relative.split(path.sep).join("/"),
        sha256: sha256(bytes),
        byte_count: bytes.byteLength
      });
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    root,
    snapshot: {
      workspace_ref: portableRef(cwd, root),
      tree_sha256: sha256(Buffer.from(JSON.stringify(entries), "utf8")),
      file_count: entries.length,
      byte_count: entries.reduce((total, entry) => total + entry.byte_count, 0)
    }
  };
}

async function assertFreshOutputPath(cwd: string, target: string): Promise<void> {
  if (target === cwd || !isSameOrContainedPath(cwd, target)) {
    throw new Error("Human-review coordination output must be strictly inside the workspace.");
  }
  try {
    await fs.lstat(target);
    throw new Error("Human-review coordination output must not already exist.");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const canonical = await resolveProspectiveCanonicalPath(target);
  if (canonical === cwd || !isSameOrContainedPath(cwd, canonical)) {
    throw new Error("Human-review coordination output escapes the workspace.");
  }
}

async function resolveProspectiveCanonicalPath(target: string): Promise<string> {
  const suffix: string[] = [];
  let current = path.resolve(target);
  while (true) {
    try {
      const existing = await fs.realpath(current);
      return path.resolve(existing, ...suffix.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function renderSummary(report: PromotionHumanReviewCoordinationAuditReport): string {
  const roles = [
    ...report.roles.candidate_reviewers,
    report.roles.license_reviewer,
    report.roles.citation_reviewer
  ];
  return [
    "# Human Review Coordination Audit",
    "",
    `- Coordination ID: ${report.coordination_id}`,
    `- Status: ${report.status}`,
    `- Coordination valid: ${report.coordination_valid}`,
    `- Ready for collection: ${report.ready_for_collection}`,
    `- Structurally valid roles: ${report.structurally_valid_role_count}/4`,
    `- Ready roles: ${report.ready_role_count}/4`,
    "",
    "## Role Progress",
    "",
    ...roles.map((role) =>
      `- ${role.role}: ${role.completed_count}/${role.task_count} complete; `
      + `valid=${role.workspace_valid}; ready=${role.ready_to_finalize}; `
      + `snapshot=${role.snapshot.tree_sha256}`
    ),
    "",
    "## Boundary",
    "",
    report.evidence_boundary,
    "",
    ...(report.validation_issues.length === 0
      ? ["## Validation Issues", "", "- None.", ""]
      : [
          "## Validation Issues",
          "",
          ...report.validation_issues.map((issue) =>
            `- ${issue.code}${issue.role ? ` (${issue.role})` : ""}: ${issue.message}`
          ),
          ""
        ])
  ].join("\n");
}

function assertInside(root: string, target: string, label: string): void {
  if (target === root || !isSameOrContainedPath(root, target)) {
    throw new Error(`${label} must be strictly inside the current workspace.`);
  }
}

function isSameOrContainedPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portableRef(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/") || ".";
}

function sameNonEmpty<T extends string | number | null>(
  left: T,
  right: T
): boolean {
  return left !== null && left !== "" && left === right;
}

function nonEmpty(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameSnapshot(
  left: PromotionHumanReviewWorkspaceSnapshot,
  right: PromotionHumanReviewWorkspaceSnapshot
): boolean {
  return left.workspace_ref === right.workspace_ref
    && left.tree_sha256 === right.tree_sha256
    && left.file_count === right.file_count
    && left.byte_count === right.byte_count;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
