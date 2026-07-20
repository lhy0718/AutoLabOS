import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_MODEL_REVIEW_ROLES,
  hashModelReviewAdjudicatorInput,
  hashModelReviewOutput,
  type ModelReviewBundle,
  type ModelReviewerProvenance,
  type ModelReviewRole
} from "../src/core/modelReviewProtocol.js";

import {
  buildMetaHarnessPatchPlanArtifact,
  buildReviewReportArtifact,
  portableArtifactRef,
  validateResearchGovernanceArtifact,
  type GateReportArtifact
} from "../src/core/researchGovernanceArtifacts.js";

function makeGateReport(): GateReportArtifact {
  return {
    schema_version: "1.0",
    artifact_type: "GateReport",
    artifact_id: "gate_report_fixture",
    generated_at: "2026-07-10T00:00:00.000Z",
    command_intent: "research:audit",
    provenance: {
      source_mode: "governance_artifact",
      source_label: "EvidenceBundle",
      artifact_refs: ["outputs/research-governance/audit/evidence-bundle.json"]
    },
    verdict: "blocked",
    evidence_bundle_id: "evidence_bundle_fixture",
    claim_ceiling: "research_memo_without_quantitative_claims",
    checks: {
      baseline_comparator: "missing",
      result_table_complete_rows: 0,
      result_table_rows: 0,
      severe_figure_mismatches: 0,
      unsupported_claims: 1,
      citation_support_issues: 1,
      done_condition: "fail"
    },
    findings: [
      {
        code: "baseline_or_comparator_missing",
        severity: "blocker",
        message: "A baseline or comparator is missing from the declared design.",
        evidence_refs: ["blockers.json"]
      },
      {
        code: "citation_support_missing",
        severity: "blocker",
        message: "A related-work statement has no citation support.",
        evidence_refs: ["claim-evidence-table.json"]
      },
      {
        code: "figure_result_caption_mismatch",
        severity: "warning",
        message: "A figure caption does not match the result table.",
        evidence_refs: ["figure-audit-summary.json"]
      }
    ],
    next_actions: ["Repair the missing evidence before manuscript promotion."]
  };
}

function makeModelReviewBundle(gateReportId: string, gateSha256: string): ModelReviewBundle {
  const bundle: ModelReviewBundle = {
    schema_version: "1.0",
    artifact_type: "ModelReviewBundle",
    gate_report: {
      artifact_id: gateReportId,
      sha256: gateSha256
    },
    policy: {
      consensus_is_evidence: false,
      may_override_deterministic_gate: false,
      may_create_external_evidence: false
    },
    reviewers: REQUIRED_MODEL_REVIEW_ROLES.map((role, index) => ({
      reviewer_id: `reviewer-${role.replace(/_/gu, "-")}`,
      role,
      provenance: makeModelProvenance(role, index),
      findings: role === "claim_evidence"
        ? [{
            code: "claim_scope_warning",
            severity: "warning" as const,
            message: "The broadest claim should remain scoped to the measured result.",
            evidence_refs: ["gate-report.json#/checks"],
            target_node: "analyze_results" as const,
            target_surface: "validator" as const,
            recheck_condition: "The claim matches the measured result."
          }]
        : []
    })),
    adjudicator: {
      reviewer_id: "reviewer-meta",
      role: "meta_reviewer",
      provenance: makeModelProvenance("meta_reviewer", REQUIRED_MODEL_REVIEW_ROLES.length),
      findings: [{
        code: "robustness_check_missing",
        severity: "blocker",
        message: "The reported comparison lacks an executed robustness check.",
        evidence_refs: ["gate-report.json#/findings"],
        target_node: "run_experiments",
        target_surface: "validator",
        recheck_condition: "An executed robustness check is bound to the gate."
      }]
    }
  };
  bindReviewHashes(bundle);
  return bundle;
}

function makeModelProvenance(
  role: ModelReviewRole | "meta_reviewer",
  index: number
): ModelReviewerProvenance {
  return {
    actor: "model",
    provider: "<model-provider>",
    model: "<frontier-model>",
    reasoning_effort: "high",
    execution_id: `execution-${role.replace(/_/gu, "-")}`,
    context_isolated: true,
    input_sha256: digest(`input-${index}`),
    output_sha256: digest(`output-${index}`)
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bindReviewHashes(bundle: ModelReviewBundle): void {
  for (const reviewer of bundle.reviewers) {
    reviewer.provenance.output_sha256 = hashModelReviewOutput(reviewer);
  }
  bundle.adjudicator.provenance.input_sha256 = hashModelReviewAdjudicatorInput(
    bundle.gate_report,
    bundle.reviewers
  );
  bundle.adjudicator.provenance.output_sha256 = hashModelReviewOutput(bundle.adjudicator);
}

describe("research governance artifacts", () => {
  it("maps review findings to the smallest governed node and keeps improve plan read-only", () => {
    const review = buildReviewReportArtifact(makeGateReport(), new Date("2026-07-10T00:01:00.000Z"));
    const plan = buildMetaHarnessPatchPlanArtifact(review, new Date("2026-07-10T00:02:00.000Z"));

    expect(review.readiness_class).toBe("blocked_for_paper_scale");
    expect(review.paper_ready).toBe(false);
    expect(review.reviewer_assurance).toEqual(expect.objectContaining({
      tier: "A0_deterministic",
      panel_size: 0,
      model_review_bundle_sha256: null,
      independent_contexts: false,
      adjudicator_present: false,
      can_promote: false,
      can_downgrade: true,
      human_authority: false
    }));
    expect(review.repair_targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ finding_code: "baseline_or_comparator_missing", target_node: "design_experiments" }),
      expect.objectContaining({ finding_code: "citation_support_missing", target_node: "analyze_papers" }),
      expect.objectContaining({ finding_code: "figure_result_caption_mismatch", target_node: "figure_audit" })
    ]));
    expect(plan.apply_mode).toBe("plan_only");
    expect(plan.targets.every((target) => target.validation_commands.length > 0)).toBe(true);
    expect(validateResearchGovernanceArtifact(review).ok).toBe(true);
    expect(validateResearchGovernanceArtifact(plan).ok).toBe(true);
  });

  it("merges model findings conservatively without raising deterministic verdict or claim ceiling", () => {
    const gate = makeGateReport();
    gate.verdict = "pass";
    gate.claim_ceiling = "paper_ready";
    gate.findings = [];
    const gateSha256 = digest("exact-gate-report-bytes");
    const bundle = makeModelReviewBundle(gate.artifact_id, gateSha256);
    const bundleSha256 = digest("exact-model-review-bundle-bytes");

    const review = buildReviewReportArtifact(gate, {
      modelReviewBundle: bundle,
      modelReviewBundleSha256: bundleSha256,
      gateReportSha256: gateSha256
    }, new Date("2026-07-10T00:03:00.000Z"));

    expect(review.verdict).toBe("blocked");
    expect(review.readiness_class).toBe("blocked_for_paper_scale");
    expect(review.paper_ready).toBe(false);
    expect(review.claim_ceiling).toBe(gate.claim_ceiling);
    expect(review.blocking_issues).toContainEqual(expect.objectContaining({
      code: "robustness_check_missing",
      severity: "blocker"
    }));
    expect(review.non_blocking_issues).toContainEqual(expect.objectContaining({
      code: "claim_scope_warning",
      severity: "warning"
    }));
    expect(review.repair_targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ finding_code: "robustness_check_missing", target_node: "run_experiments" }),
      expect.objectContaining({ finding_code: "claim_scope_warning", target_node: "analyze_results" })
    ]));
    expect(review.reviewer_assurance).toEqual({
      tier: "A2_model_conservative",
      panel_size: 5,
      model_review_bundle_sha256: bundleSha256,
      independent_contexts: true,
      adjudicator_present: true,
      can_promote: false,
      can_downgrade: true,
      human_authority: false,
      limitations: expect.arrayContaining([
        expect.stringContaining("cannot promote"),
        expect.stringContaining("not evidence"),
        expect.stringContaining("not operationally verified")
      ])
    });
    expect(validateResearchGovernanceArtifact(review).ok).toBe(true);
  });

  it("rejects malformed reviewer assurance in ReviewReport artifacts", () => {
    const review = buildReviewReportArtifact(makeGateReport()) as unknown as Record<string, unknown>;
    const assurance = review.reviewer_assurance as Record<string, unknown>;
    assurance.can_promote = true;

    const result = validateResearchGovernanceArtifact(review);

    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "invalid_shape",
      path: "$.reviewer_assurance"
    }));
  });

  it("accepts previous-version ReviewReport artifacts without model-review assurance", () => {
    const review = buildReviewReportArtifact(makeGateReport()) as unknown as Record<string, unknown>;
    delete review.reviewer_assurance;

    expect(validateResearchGovernanceArtifact(review).ok).toBe(true);
  });

  it("rejects unsupported versions, machine-local paths, and sensitive fields", () => {
    const gate = makeGateReport() as unknown as Record<string, unknown>;
    gate.schema_version = "2.0";
    gate.provenance = {
      source_mode: "external",
      source_label: path.posix.join(path.sep, "home", "example", "private-run"),
      artifact_refs: []
    };
    gate.api_key = "not-a-real-key";

    const result = validateResearchGovernanceArtifact(gate);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["unsupported_version", "private_path", "sensitive_field"])
    );
  });

  it("normalizes external absolute references without preserving their roots", () => {
    expect(portableArtifactRef(path.posix.join(path.sep, "tmp", "private-run", "gate-report.json"))).toBe(
      "<external-artifact-root>/gate-report.json"
    );
    expect(portableArtifactRef("outputs/audit/gate-report.json")).toBe("outputs/audit/gate-report.json");
    expect(portableArtifactRef("../../outside/audit-summary.json")).toBe(
      "<external-artifact-root>/audit-summary.json"
    );
  });
});
