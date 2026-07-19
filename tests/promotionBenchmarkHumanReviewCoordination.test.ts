import { describe, expect, it } from "vitest";

import {
  buildPromotionHumanReviewCoordinationReport,
  type BuildPromotionHumanReviewCoordinationReportInput,
  type PromotionHumanReviewWorkspaceSnapshot
} from "../src/core/benchmark/promotionBenchmarkHumanReviewCoordination.js";
import type {
  PromotionTrialCandidateLicenseReviewWorkspaceAuditReport,
  PromotionTrialCandidateReviewWorkspaceAuditReport
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateReviewWorkspace.js";
import type {
  ReferenceClaimReviewWorkspaceAuditReport
} from "../src/core/referenceClaimReviewWorkspace.js";

describe("promotion human-review coordination", () => {
  it("reports four valid but incomplete human roles without inventing judgments", () => {
    const report = buildPromotionHumanReviewCoordinationReport(baseInput());

    expect(report).toMatchObject({
      status: "awaiting_human_review",
      coordination_valid: true,
      ready_for_collection: false,
      required_role_count: 4,
      structurally_valid_role_count: 4,
      ready_role_count: 0,
      candidate_handoff_id: "candidate-handoff",
      role_separation: {
        candidate_reviewers_distinct: true,
        license_reviewer_distinct_from_candidates: true,
        citation_reviewer_identity_available: false,
        citation_reviewer_distinct_from_other_roles: null
      },
      human_decisions_supplied_by_system: 0,
      human_attestations_set_by_system: 0,
      final_approvals_supplied_by_system: 0,
      claim_statuses_modified: false,
      confirmatory_admitted: false,
      public_distribution_allowed: false,
      validation_issues: []
    });
    expect(report.roles.candidate_reviewers.map((role) => role.completed_count))
      .toEqual([0, 0]);
    expect(report.roles.license_reviewer.completed_count).toBe(0);
    expect(report.roles.citation_reviewer.completed_count).toBe(0);
  });

  it("becomes collection-ready only when all distinct human roles are complete", () => {
    const input = baseInput();
    input.candidateReviewers = [
      {
        snapshot: input.candidateReviewers[0].snapshot,
        report: candidateReport("reviewer-alpha", {
          ready_to_finalize: true,
          completed_annotation_count: 8,
          incomplete_annotation_count: 0,
          attestation_complete: true,
          attestation: {
            completed_by_human: true,
            peer_annotations_unseen: true,
            controller_map_unseen: true
          }
        })
      },
      {
        snapshot: input.candidateReviewers[1].snapshot,
        report: candidateReport("reviewer-beta", {
          ready_to_finalize: true,
          completed_annotation_count: 8,
          incomplete_annotation_count: 0,
          attestation_complete: true,
          attestation: {
            completed_by_human: true,
            peer_annotations_unseen: true,
            controller_map_unseen: true
          }
        })
      }
    ];
    input.licenseReviewer.report = licenseReport({
      ready_to_finalize: true,
      completed_subject_review_count: 8,
      incomplete_subject_review_count: 0,
      aggregate_review_complete: true,
      attestation_complete: true,
      attestation: {
        completed_by_human: true,
        candidate_annotations_unseen: true,
        controller_map_unseen: true
      }
    });
    input.citationReviewer.report = citationReport({
      ready_to_finalize: true,
      completed_review_count: 3,
      incomplete_review_count: 0,
      attestation_complete: true,
      attestation: {
        schema_version: "1.0",
        reviewer_id: "reviewer-delta",
        completed_by_human: true,
        reviewer_did_not_generate_evidence_candidates: true,
        full_source_text_inspected: true
      }
    });

    const report = buildPromotionHumanReviewCoordinationReport(input);

    expect(report).toMatchObject({
      status: "ready_for_collection",
      coordination_valid: true,
      ready_for_collection: true,
      structurally_valid_role_count: 4,
      ready_role_count: 4,
      validation_issues: []
    });
    expect(report.evidence_boundary).toContain("does not");
    expect(report.final_approvals_supplied_by_system).toBe(0);
  });

  it("fails closed when reviewer roles are reused", () => {
    const input = baseInput();
    input.candidateReviewers[1].report = candidateReport("reviewer-alpha");
    input.licenseReviewer.report = licenseReport({ reviewer_id: "reviewer-alpha" });
    input.citationReviewer.report = citationReport({
      attestation: {
        schema_version: "1.0",
        reviewer_id: "reviewer-alpha",
        completed_by_human: false,
        reviewer_did_not_generate_evidence_candidates: false,
        full_source_text_inspected: false
      }
    });

    const report = buildPromotionHumanReviewCoordinationReport(input);

    expect(report.status).toBe("invalid");
    expect(report.coordination_valid).toBe(false);
    expect(report.validation_issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "candidate_reviewer_roles_not_distinct",
        "license_reviewer_role_not_distinct",
        "citation_reviewer_role_not_distinct"
      ])
    );
  });

  it("propagates a live child-workspace integrity failure", () => {
    const input = baseInput();
    input.citationReviewer.report = citationReport({
      workspace_valid: false,
      packet_integrity_valid: false,
      source_package_binding_valid: false,
      malformed_review_count: 1,
      validation_issues: [{
        code: "reference_claim_review_workspace_source_binding_invalid",
        message: "Fixture binding mismatch."
      }]
    });

    const report = buildPromotionHumanReviewCoordinationReport(input);

    expect(report).toMatchObject({
      status: "invalid",
      coordination_valid: false,
      structurally_valid_role_count: 3,
      ready_for_collection: false
    });
    expect(report.roles.citation_reviewer.validation_issue_codes).toEqual([
      "reference_claim_review_workspace_source_binding_invalid"
    ]);
    expect(report.validation_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "human_review_role_workspace_invalid",
        role: "citation_reviewer"
      }),
      expect.objectContaining({
        code: "human_review_role_packet_integrity_invalid",
        role: "citation_reviewer"
      })
    ]));
  });

  it("rejects candidate and license workspaces from different handoffs", () => {
    const input = baseInput();
    input.licenseReviewer.report = licenseReport({
      handoff_id: "different-candidate-handoff"
    });

    const report = buildPromotionHumanReviewCoordinationReport(input);

    expect(report.status).toBe("invalid");
    expect(report.coordination_valid).toBe(false);
    expect(report.validation_issues.map((issue) => issue.code)).toContain(
      "candidate_license_handoff_mismatch"
    );
  });

  it("binds the coordination ID to current workspace bytes", () => {
    const before = baseInput();
    const after = baseInput();
    after.citationReviewer.snapshot = snapshot("citation-workspace", "f");

    const beforeReport = buildPromotionHumanReviewCoordinationReport(before);
    const afterReport = buildPromotionHumanReviewCoordinationReport(after);

    expect(beforeReport.coordination_id).not.toBe(afterReport.coordination_id);
    expect(beforeReport.roles.citation_reviewer.snapshot.tree_sha256)
      .not.toBe(afterReport.roles.citation_reviewer.snapshot.tree_sha256);
  });
});

function baseInput(): BuildPromotionHumanReviewCoordinationReportInput {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    candidateReviewers: [
      {
        snapshot: snapshot("candidate-workspace-a", "a"),
        report: candidateReport("reviewer-alpha")
      },
      {
        snapshot: snapshot("candidate-workspace-b", "b"),
        report: candidateReport("reviewer-beta")
      }
    ],
    licenseReviewer: {
      snapshot: snapshot("license-workspace", "c"),
      report: licenseReport()
    },
    citationReviewer: {
      snapshot: snapshot("citation-workspace", "d"),
      report: citationReport()
    }
  };
}

function candidateReport(
  reviewerId: string,
  overrides: Partial<PromotionTrialCandidateReviewWorkspaceAuditReport> = {}
): PromotionTrialCandidateReviewWorkspaceAuditReport {
  return {
    schema_version: "1.0",
    generated_at: "2026-01-01T00:00:00.000Z",
    handoff_id: "candidate-handoff",
    annotator_id: reviewerId,
    workspace_valid: true,
    ready_to_finalize: false,
    task_count: 8,
    completed_annotation_count: 0,
    incomplete_annotation_count: 8,
    malformed_annotation_count: 0,
    attestation: {
      completed_by_human: false,
      peer_annotations_unseen: false,
      controller_map_unseen: false
    },
    attestation_complete: false,
    packet_integrity_valid: true,
    validation_issues: [],
    evidence_boundary: "Fixture structural audit.",
    ...overrides
  };
}

function licenseReport(
  overrides: Partial<PromotionTrialCandidateLicenseReviewWorkspaceAuditReport> = {}
): PromotionTrialCandidateLicenseReviewWorkspaceAuditReport {
  return {
    schema_version: "1.0",
    generated_at: "2026-01-01T00:00:00.000Z",
    handoff_id: "candidate-handoff",
    reviewer_id: "reviewer-gamma",
    review_scope: "candidate_scoped",
    workspace_valid: true,
    ready_to_finalize: false,
    subject_count: 8,
    completed_subject_review_count: 0,
    incomplete_subject_review_count: 8,
    malformed_subject_review_count: 0,
    aggregate_review_complete: false,
    attestation: {
      completed_by_human: false,
      candidate_annotations_unseen: false,
      controller_map_unseen: false
    },
    attestation_complete: false,
    packet_integrity_valid: true,
    validation_issues: [],
    evidence_boundary: "Fixture structural audit.",
    ...overrides
  };
}

function citationReport(
  overrides: Partial<ReferenceClaimReviewWorkspaceAuditReport> = {}
): ReferenceClaimReviewWorkspaceAuditReport {
  return {
    schema_version: "1.0",
    generated_at: "2026-01-01T00:00:00.000Z",
    workspace_id: "reference-workspace",
    package_id: "reference-package",
    handoff_id: "reference-handoff",
    workspace_valid: true,
    ready_to_finalize: false,
    task_count: 3,
    completed_review_count: 0,
    incomplete_review_count: 3,
    malformed_review_count: 0,
    decision_counts: {
      supported: 0,
      rewrite: 0,
      wrong_source: 0,
      missing_source: 0
    },
    all_supported_review_set: false,
    attestation: {
      schema_version: "1.0",
      reviewer_id: null,
      completed_by_human: false,
      reviewer_did_not_generate_evidence_candidates: false,
      full_source_text_inspected: false
    },
    attestation_complete: false,
    source_package_binding_valid: true,
    packet_integrity_valid: true,
    public_distribution_allowed: false,
    final_approval_completed: false,
    claim_statuses_modified: false,
    validation_issues: [],
    evidence_boundary: "Fixture structural audit.",
    ...overrides
  };
}

function snapshot(
  workspaceRef: string,
  digestCharacter: string
): PromotionHumanReviewWorkspaceSnapshot {
  return {
    workspace_ref: workspaceRef,
    tree_sha256: digestCharacter.repeat(64),
    file_count: 4,
    byte_count: 256
  };
}
