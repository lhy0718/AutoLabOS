import path from "node:path";

import { describe, expect, it } from "vitest";

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

describe("research governance artifacts", () => {
  it("maps review findings to the smallest governed node and keeps improve plan read-only", () => {
    const review = buildReviewReportArtifact(makeGateReport(), new Date("2026-07-10T00:01:00.000Z"));
    const plan = buildMetaHarnessPatchPlanArtifact(review, new Date("2026-07-10T00:02:00.000Z"));

    expect(review.readiness_class).toBe("blocked_for_paper_scale");
    expect(review.paper_ready).toBe(false);
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
