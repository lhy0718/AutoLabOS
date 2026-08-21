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
  buildPaperReadinessBundleArtifact,
  buildReviewReportArtifact,
  portableArtifactRef,
  validateResearchGovernanceArtifact,
  type GateReportArtifact
} from "../src/core/researchGovernanceArtifacts.js";

function makeGateReport(): GateReportArtifact {
  return {
    schema_version: "2.0",
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
    evidence_bundle_sha256: digest("exact-evidence-bundle-bytes"),
    input_bindings: [{
      path: "frozen-inputs/result-table.json",
      sha256: digest("exact-result-table-bytes"),
      bytes: 128,
      required: true
    }],
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
      }, {
        code: "claim_scope_warning",
        severity: "warning",
        message: "The broadest claim should remain scoped to the measured result.",
        evidence_refs: ["gate-report.json#/checks"],
        target_node: "analyze_results",
        target_surface: "validator",
        recheck_condition: "The claim matches the measured result."
      }, {
        code: "replay_contract_unbound",
        severity: "blocker",
        message: "The runner and dependency environment are not bound for replay.",
        evidence_refs: ["gate-report.json#/input_bindings"],
        target_surface: "runtime",
        recheck_condition: "A clean replay reproduces the governed output."
      }]
    }
  };
  bindReviewHashes(bundle);
  return bundle;
}

function bindGateEvidence(gate: GateReportArtifact): void {
  gate.evidence_bundle_sha256 = digest("exact-evidence-bundle-bytes");
  gate.input_bindings = [{
    path: "frozen-inputs/result-table.json",
    sha256: digest("exact-result-table-bytes"),
    bytes: 128,
    required: true
  }];
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
      adjudication_policy: "deterministic_only",
      panel_size: 0,
      specialist_finding_count: 0,
      adjudicated_finding_count: 0,
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
    expect(plan.review_report_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(plan.targets.every((target) => target.validation_commands.length > 0)).toBe(true);
    expect(validateResearchGovernanceArtifact(review).ok).toBe(true);
    expect(validateResearchGovernanceArtifact(plan).ok).toBe(true);
  });

  it("caps deterministic-only paper readiness at candidate in review and pack artifacts", () => {
    const gate = makeGateReport();
    gate.verdict = "pass";
    gate.claim_ceiling = "paper_ready";
    gate.findings = [];

    const review = buildReviewReportArtifact(gate, { gateReportSha256: digest("gate-report-bytes") });
    const pack = buildPaperReadinessBundleArtifact({
      gate,
      review,
      files: [{ path: "artifacts/review-report.json", sha256: digest("review-report-bytes"), bytes: 128 }],
      limitations: []
    });

    expect(review.reviewer_assurance).toEqual(expect.objectContaining({
      tier: "A0_deterministic",
      can_promote: false
    }));
    expect(review.readiness_class).toBe("paper_scale_candidate");
    expect(review.paper_ready).toBe(false);
    expect(pack.readiness_class).toBe("paper_scale_candidate");
    expect(pack.paper_ready).toBe(false);

    const inconsistentReview = {
      ...review,
      readiness_class: "paper_ready" as const,
      paper_ready: true
    };
    const defensivePack = buildPaperReadinessBundleArtifact({
      gate,
      review: inconsistentReview,
      files: [],
      limitations: []
    });

    expect(validateResearchGovernanceArtifact(inconsistentReview)).toEqual(expect.objectContaining({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "$.paper_ready" })
      ])
    }));
    expect(defensivePack.readiness_class).toBe("paper_scale_candidate");
    expect(defensivePack.paper_ready).toBe(false);
  });

  it("lets hash-bound A2 preserve but not raise the deterministic readiness ceiling", () => {
    const gate = makeGateReport();
    gate.verdict = "pass";
    gate.claim_ceiling = "paper_ready";
    gate.findings = [];
    const gateSha256 = digest("paper-ready-gate-report-bytes");
    const bundle = makeModelReviewBundle(gate.artifact_id, gateSha256);
    bundle.adjudicator.findings = [];
    bindReviewHashes(bundle);

    const review = buildReviewReportArtifact(gate, {
      modelReviewBundle: bundle,
      modelReviewBundleSha256: digest("paper-ready-model-review-bundle-bytes"),
      gateReportSha256: gateSha256
    });

    expect(review.reviewer_assurance).toEqual(expect.objectContaining({
      tier: "A2_model_conservative",
      can_promote: false,
      gate_report_sha256: gateSha256,
      model_review_bundle_sha256: digest("paper-ready-model-review-bundle-bytes")
    }));
    expect(review.readiness_class).toBe("paper_ready");
    expect(review.paper_ready).toBe(true);
    expect(buildPaperReadinessBundleArtifact({
      gate,
      review,
      files: [],
      limitations: []
    })).toEqual(expect.objectContaining({
      readiness_class: "paper_ready",
      paper_ready: true
    }));

    gate.claim_ceiling = "paper_scale_candidate";
    const lowerGateSha256 = digest("candidate-gate-report-bytes");
    bundle.gate_report.sha256 = lowerGateSha256;
    bindReviewHashes(bundle);
    const lowerReview = buildReviewReportArtifact(gate, {
      modelReviewBundle: bundle,
      modelReviewBundleSha256: digest("candidate-model-review-bundle-bytes"),
      gateReportSha256: lowerGateSha256
    });

    expect(lowerReview.readiness_class).toBe("paper_scale_candidate");
    expect(lowerReview.paper_ready).toBe(false);
  });

  it("rejects malformed nested review targets and unbound patch plans", () => {
    const invalidReview = buildReviewReportArtifact(makeGateReport(), new Date("2026-07-10T00:01:00.000Z"));
    invalidReview.repair_targets[0].target_node = "publish_paper" as never;
    invalidReview.blocking_issues[0].evidence_refs = [];

    const reviewValidation = validateResearchGovernanceArtifact(invalidReview);
    expect(reviewValidation.ok).toBe(false);
    expect(reviewValidation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "$.repair_targets[0].target_node" }),
      expect.objectContaining({ path: "$.blocking_issues[0].evidence_refs" })
    ]));

    const validReview = buildReviewReportArtifact(makeGateReport(), new Date("2026-07-10T00:01:00.000Z"));
    const invalidPlan = buildMetaHarnessPatchPlanArtifact(validReview, new Date("2026-07-10T00:02:00.000Z"));
    invalidPlan.review_report_sha256 = "unbound";

    const planValidation = validateResearchGovernanceArtifact(invalidPlan);
    expect(planValidation.ok).toBe(false);
    expect(planValidation.issues).toContainEqual(expect.objectContaining({
      path: "$.review_report_sha256"
    }));
  });

  it("merges model findings conservatively without raising deterministic verdict or claim ceiling", () => {
    const gate = makeGateReport();
    gate.verdict = "pass";
    gate.claim_ceiling = "paper_ready";
    gate.findings = [];
    bindGateEvidence(gate);
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
      expect.objectContaining({ finding_code: "claim_scope_warning", target_node: "analyze_results" }),
      expect.objectContaining({
        finding_code: "replay_contract_unbound",
        target_node: "implement_experiments",
        target_surface: "runtime"
      })
    ]));
    expect(review.reviewer_assurance).toEqual({
      tier: "A2_model_conservative",
      adjudication_policy: "meta_findings_only",
      panel_size: 5,
      specialist_finding_count: 1,
      adjudicated_finding_count: 3,
      gate_report_sha256: gateSha256,
      model_review_bundle_sha256: bundleSha256,
      independent_contexts: true,
      adjudicator_present: true,
      can_promote: false,
      can_downgrade: true,
      human_authority: false,
      limitations: expect.arrayContaining([
        expect.stringContaining("cannot promote"),
        expect.stringContaining("not evidence"),
        expect.stringContaining("only meta-reviewer findings"),
        expect.stringContaining("not operationally verified")
      ])
    });
    expect(validateResearchGovernanceArtifact(review).ok).toBe(true);
  });

  it("rejects review over unbound, empty, non-portable, or partially bound GateReport evidence", () => {
    const gate = makeGateReport();
    delete (gate as Partial<GateReportArtifact>).evidence_bundle_sha256;
    gate.input_bindings = [];
    const gateSha256 = digest("previous-unbound-gate-report-bytes");
    const bundle = makeModelReviewBundle(gate.artifact_id, gateSha256);
    const options = {
      modelReviewBundle: bundle,
      modelReviewBundleSha256: digest("model-review-bundle-bytes"),
      gateReportSha256: gateSha256
    };

    expect(() => buildReviewReportArtifact(gate, options)).toThrow("evidence_bundle_sha256");

    gate.evidence_bundle_sha256 = digest("evidence-bundle-bytes");
    expect(() => buildReviewReportArtifact(gate, options)).toThrow("non-empty GateReport.input_bindings");

    gate.input_bindings = [{
      path: "frozen-inputs/result-table.json",
      required: true
    }];
    expect(() => buildReviewReportArtifact(gate, options)).toThrow("fully SHA-256/byte bound");

    gate.input_bindings = [{
      path: "../outside/result-table.json",
      sha256: digest("exact-result-table-bytes"),
      bytes: 128,
      required: true
    }];
    expect(() => buildReviewReportArtifact(gate, options)).toThrow("portable");
  });

  it("binds A0 ReviewReport identity to gate id, exact bytes, and claim ceiling", () => {
    const gate = makeGateReport();
    const gateSha256 = digest("gate-report-bytes-a");
    const review = buildReviewReportArtifact(gate, { gateReportSha256: gateSha256 });
    const differentGateId = buildReviewReportArtifact(
      { ...gate, artifact_id: "gate_report_other" },
      { gateReportSha256: gateSha256 }
    );
    const differentGateBytes = buildReviewReportArtifact(
      gate,
      { gateReportSha256: digest("gate-report-bytes-b") }
    );
    const differentClaimCeiling = buildReviewReportArtifact(
      { ...gate, claim_ceiling: "system_validation_note" },
      { gateReportSha256: gateSha256 }
    );

    expect(review.reviewer_assurance.gate_report_sha256).toBe(gateSha256);
    expect(new Set([
      review.artifact_id,
      differentGateId.artifact_id,
      differentGateBytes.artifact_id,
      differentClaimCeiling.artifact_id
    ])).toHaveLength(4);
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

  it("rejects previous-version ReviewReport artifacts without model-review assurance", () => {
    const review = buildReviewReportArtifact(makeGateReport()) as unknown as Record<string, unknown>;
    delete review.reviewer_assurance;

    expect(validateResearchGovernanceArtifact(review).ok).toBe(false);
  });

  it("rejects the prior reviewer assurance shape before adjudication counters were added", () => {
    const review = buildReviewReportArtifact(makeGateReport()) as unknown as Record<string, unknown>;
    const assurance = review.reviewer_assurance as Record<string, unknown>;
    delete assurance.adjudication_policy;
    delete assurance.specialist_finding_count;
    delete assurance.adjudicated_finding_count;
    delete assurance.gate_report_sha256;

    expect(validateResearchGovernanceArtifact(review).ok).toBe(false);
  });

  it("rejects GateReport artifacts without exact portable evidence bindings", () => {
    const missingDigest = makeGateReport() as unknown as Record<string, unknown>;
    delete missingDigest.evidence_bundle_sha256;
    expect(validateResearchGovernanceArtifact(missingDigest).ok).toBe(false);

    const emptyBindings = makeGateReport() as unknown as Record<string, unknown>;
    emptyBindings.input_bindings = [];
    expect(validateResearchGovernanceArtifact(emptyBindings).ok).toBe(false);

    const nonPortableBinding = makeGateReport() as unknown as Record<string, unknown>;
    nonPortableBinding.input_bindings = [{
      path: "../outside/result-table.json",
      sha256: digest("exact-result-table-bytes"),
      bytes: 128,
      required: true
    }];
    expect(validateResearchGovernanceArtifact(nonPortableBinding).ok).toBe(false);
  });

  it("rejects unsupported versions, machine-local paths, and sensitive fields", () => {
    const gate = makeGateReport() as unknown as Record<string, unknown>;
    gate.schema_version = "1.0";
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
