import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  REQUIRED_MODEL_REVIEW_ROLES,
  collectAdjudicatedModelReviewFindings,
  collectModelReviewFindings,
  hashModelReviewAdjudicatorInput,
  hashModelReviewBundle,
  hashModelReviewOutput,
  parseModelReviewBundle,
  validateModelReviewBundle,
  type ModelReviewBundle,
  type ModelReviewerProvenance,
  type ModelReviewRole
} from "../src/core/modelReviewProtocol.js";

const GATE_BINDING = {
  artifact_id: "gate_report_fixture",
  sha256: digest("gate-report-bytes")
};

describe("model review protocol", () => {
  it("parses a versioned five-specialist bundle with an independent meta-reviewer", () => {
    const bundle = makeModelReviewBundle();

    const parsed = parseModelReviewBundle(bundle, GATE_BINDING);

    expect(parsed.schema_version).toBe("1.0");
    expect(parsed.reviewers.map((reviewer) => reviewer.role)).toEqual(REQUIRED_MODEL_REVIEW_ROLES);
    expect(new Set([
      ...parsed.reviewers.map((reviewer) => reviewer.reviewer_id),
      parsed.adjudicator.reviewer_id
    ]).size).toBe(6);
    expect(parsed.reviewers.every((reviewer) => reviewer.provenance.context_isolated)).toBe(true);
    expect(parsed.adjudicator.role).toBe("meta_reviewer");
    expect(collectModelReviewFindings(parsed)).toEqual([
      expect.objectContaining({ code: "claim_scope_warning", severity: "warning" }),
      expect.objectContaining({ code: "adversarial_evidence_gap", severity: "blocker" })
    ]);
    expect(collectAdjudicatedModelReviewFindings(parsed)).toEqual([
      expect.objectContaining({ code: "adversarial_evidence_gap", severity: "blocker" })
    ]);
    expect(hashModelReviewBundle(JSON.stringify(parsed))).toMatch(/^[a-f0-9]{64}$/u);
    expect(validateModelReviewBundle(bundle, GATE_BINDING)).toEqual({ ok: true, issues: [] });
  });

  it("rejects missing roles, reused identities or contexts, and a non-isolated reviewer", () => {
    const bundle = makeModelReviewBundle() as unknown as Record<string, unknown>;
    const reviewers = bundle.reviewers as Array<Record<string, unknown>>;
    reviewers.pop();
    reviewers[1].reviewer_id = reviewers[0].reviewer_id;
    reviewers[1].role = reviewers[0].role;
    const secondProvenance = reviewers[1].provenance as Record<string, unknown>;
    const firstProvenance = reviewers[0].provenance as Record<string, unknown>;
    secondProvenance.execution_id = firstProvenance.execution_id;
    secondProvenance.context_isolated = false;
    const adjudicator = bundle.adjudicator as Record<string, unknown>;
    adjudicator.reviewer_id = reviewers[0].reviewer_id;

    const result = validateModelReviewBundle(bundle, GATE_BINDING);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "missing_role",
      "reviewer_role_conflict",
      "reviewer_identity_conflict",
      "execution_context_conflict"
    ]));
  });

  it("requires complete model provenance and literal non-promoting policy flags", () => {
    const bundle = makeModelReviewBundle() as unknown as Record<string, unknown>;
    const reviewers = bundle.reviewers as Array<Record<string, unknown>>;
    const provenance = reviewers[0].provenance as Record<string, unknown>;
    delete provenance.output_sha256;
    const policy = bundle.policy as Record<string, unknown>;
    policy.consensus_is_evidence = true;
    policy.may_override_deterministic_gate = true;
    policy.may_create_external_evidence = true;

    const result = validateModelReviewBundle(bundle, GATE_BINDING);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("policy_violation");
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "invalid_shape",
      path: "$.reviewers[0].provenance"
    }));
  });

  it("fails closed on GateReport id or byte-hash mismatch and undeclared bundle fields", () => {
    const bundle = makeModelReviewBundle() as unknown as Record<string, unknown>;
    const gateReport = bundle.gate_report as Record<string, unknown>;
    gateReport.sha256 = digest("changed-gate-report-bytes");
    bundle.verdict = "pass";

    const result = validateModelReviewBundle(bundle, GATE_BINDING);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "gate_binding_mismatch", path: "$.gate_report.sha256" }),
      expect.objectContaining({ code: "invalid_shape", path: "$" })
    ]));
    expect(() => parseModelReviewBundle(bundle, GATE_BINDING)).toThrow("Invalid ModelReviewBundle");
  });

  it("fails closed when normalized findings or the adjudicator input binding are altered", () => {
    const bundle = makeModelReviewBundle();
    bundle.reviewers[0].findings[0].message = "Changed after the reviewer output was bound.";
    bundle.adjudicator.provenance.input_sha256 = digest("unbound-meta-input");

    const result = validateModelReviewBundle(bundle, GATE_BINDING);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "output_binding_mismatch" }),
      expect.objectContaining({ code: "adjudicator_input_binding_mismatch" })
    ]));
  });

  it("binds the normalized finding text imported into the review report", () => {
    const bundle = makeModelReviewBundle();
    bundle.reviewers[0].findings[0].message = "  A reported claim should remain scoped to the measured comparison.  ";
    bundle.reviewers[0].findings[0].recheck_condition =
      "  The claim remains within the measured comparison.  ";
    bindReviewHashes(bundle);

    const parsed = parseModelReviewBundle(bundle, GATE_BINDING);

    expect(parsed.reviewers[0].findings[0].message).toBe(
      "A reported claim should remain scoped to the measured comparison."
    );
    expect(parsed.reviewers[0].findings[0].recheck_condition).toBe(
      "The claim remains within the measured comparison."
    );
    expect(validateModelReviewBundle(bundle, GATE_BINDING)).toEqual({ ok: true, issues: [] });
  });
});

function makeModelReviewBundle(): ModelReviewBundle {
  const bundle: ModelReviewBundle = {
    schema_version: "1.0",
    artifact_type: "ModelReviewBundle",
    gate_report: { ...GATE_BINDING },
    policy: {
      consensus_is_evidence: false,
      may_override_deterministic_gate: false,
      may_create_external_evidence: false
    },
    reviewers: REQUIRED_MODEL_REVIEW_ROLES.map((role, index) => ({
      reviewer_id: `reviewer-${role.replace(/_/gu, "-")}`,
      role,
      provenance: makeProvenance(role, index),
      findings: role === "claim_evidence"
        ? [{
            code: "claim_scope_warning",
            severity: "warning" as const,
            message: "A reported claim should remain scoped to the measured comparison.",
            evidence_refs: ["gate-report.json#/checks/unsupported_claims"],
            target_node: "analyze_results" as const,
            target_surface: "policy" as const,
            recheck_condition: "The claim remains within the measured comparison."
          }]
        : []
    })),
    adjudicator: {
      reviewer_id: "reviewer-meta",
      role: "meta_reviewer",
      provenance: makeProvenance("meta_reviewer", REQUIRED_MODEL_REVIEW_ROLES.length),
      findings: [{
        code: "adversarial_evidence_gap",
        severity: "blocker",
        message: "The strongest interpretation lacks a bound robustness check.",
        evidence_refs: ["gate-report.json#/findings"],
        target_node: "run_experiments",
        target_surface: "runtime",
        recheck_condition: "A bound robustness check is present in executed artifacts."
      }]
    }
  };
  bindReviewHashes(bundle);
  return bundle;
}

function makeProvenance(
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
