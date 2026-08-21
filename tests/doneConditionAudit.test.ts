import { describe, expect, it } from "vitest";

import { evaluateDoneConditionAudit } from "../src/core/audit/doneConditionAudit.js";

describe("done-condition audit", () => {
  it("keeps an undeclared completion contract unmeasured and failing closed", () => {
    const audit = evaluateDoneConditionAudit({
      paperReady: false,
      writePaperCompleted: true,
      missingBaselineOrComparator: true,
      resultTableReady: false,
      fallbackOnlyEvidence: false,
      failedRunHidden: false,
      unsupportedClaimCount: 1,
      citationSupportIssueCount: 1,
      figureAuditReady: false,
      figureMismatchPresent: false
    });

    expect(audit.status).toBe("unmeasured");
    expect(audit.failures).toContain("A governed done-condition source is required");
    expect(audit.checks.find((check) => check.id === "done_condition_source_declared")?.passed)
      .toBe(false);
  });

  it("allows explicit weak output states without treating write_paper as paper-ready", () => {
    const audit = evaluateDoneConditionAudit({
      governanceCondition: {
        expected_paper_ready: false,
        allowed_weak_output_states: ["paper_ready=false", "research_memo"]
      },
      paperReady: false,
      writePaperCompleted: true,
      missingBaselineOrComparator: true,
      resultTableReady: false,
      fallbackOnlyEvidence: true,
      failedRunHidden: false,
      unsupportedClaimCount: 1,
      citationSupportIssueCount: 1,
      figureAuditReady: true,
      figureMismatchPresent: false
    });

    expect(audit.status).toBe("pass");
    expect(audit.allowed_weak_output_states).toContain("paper_ready=false");
    expect(audit.checks.find((check) => check.id === "write_paper_not_paper_ready")?.passed).toBe(true);
    expect(audit.checks.find(
      (check) => check.id === "baseline_comparator_required_for_paper_ready"
    )?.passed).toBeNull();
    expect(audit.checks.find(
      (check) => check.id === "unsupported_claims_block_paper_ready"
    )?.passed).toBeNull();
    expect(audit.checks.find(
      (check) => check.id === "figure_audit_required_for_manuscript_promotion"
    )?.passed).toBeNull();
  });

  it("fails when paper_ready=true hides known evidence blockers", () => {
    const audit = evaluateDoneConditionAudit({
      governanceCondition: { expected_paper_ready: true },
      paperReady: true,
      writePaperCompleted: true,
      missingBaselineOrComparator: true,
      resultTableReady: false,
      fallbackOnlyEvidence: true,
      failedRunHidden: true,
      runStatusKnown: true,
      unsupportedClaimCount: 1,
      citationSupportIssueCount: 1,
      figureAuditReady: true,
      figureMismatchPresent: true
    });

    expect(audit.status).toBe("fail");
    expect(audit.failures).toContain("Paper-ready comparative claims require baseline/comparator evidence");
    expect(audit.failures).toContain("Paper-ready status requires a complete result table");
    expect(audit.failures).toContain("Fallback-only evidence cannot satisfy quantitative paper-ready completion");
    expect(audit.failures).toContain("Failed run visibility is required");
  });

  it("fails paper-ready completion when figure audit evidence is unavailable", () => {
    const audit = evaluateDoneConditionAudit({
      governanceCondition: { expected_paper_ready: true },
      paperReady: true,
      writePaperCompleted: true,
      missingBaselineOrComparator: false,
      resultTableReady: true,
      fallbackOnlyEvidence: false,
      failedRunHidden: false,
      unsupportedClaimCount: 0,
      citationSupportIssueCount: 0,
      figureAuditReady: false,
      figureMismatchPresent: false
    });

    expect(audit.status).toBe("fail");
    expect(audit.failures).toContain("A measured figure audit is required for manuscript promotion");
    expect(audit.checks.find(
      (check) => check.id === "figure_audit_required_for_manuscript_promotion"
    )?.passed).toBe(false);
  });

  it("does not pass failed-run visibility without a durable run status", () => {
    const audit = evaluateDoneConditionAudit({
      researchBriefText: "## Failure Conditions\n- Preserve failed runs.",
      paperReady: false,
      writePaperCompleted: false,
      missingBaselineOrComparator: true,
      resultTableReady: false,
      fallbackOnlyEvidence: false,
      failedRunHidden: false,
      runStatusKnown: false,
      unsupportedClaimCount: 0,
      citationSupportIssueCount: 0,
      figureAuditReady: false,
      figureMismatchPresent: false
    });

    expect(
      audit.checks.find((check) => check.id === "failed_run_visibility_required")?.passed
    ).toBeNull();
    expect(
      audit.checks.find((check) => check.id === "write_paper_not_paper_ready")?.passed
    ).toBeNull();
  });
});
