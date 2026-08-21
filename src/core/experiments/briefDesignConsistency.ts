/**
 * Design-vs-brief consistency check.
 *
 * Compares an experiment design against the structured brief sections to detect:
 * - missing target comparison
 * - insufficient evidence plan
 * - disallowed shortcuts in design
 * - unauthorized budgeted passes
 * - claims exceeding the paper ceiling
 *
 * Output: structured warnings stored as a parseable artifact.
 */

import { BriefCompletenessArtifact } from "../runs/researchBriefFiles.js";
import { MarkdownRunBriefSections } from "../runs/runBriefParser.js";
import { ExperimentContract } from "./experimentContract.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface BriefDesignWarning {
  code: string;
  severity: "error" | "warning";
  message: string;
  evidence?: string;
}

export interface BriefDesignConsistencyResult {
  generated_at: string;
  warnings: BriefDesignWarning[];
  paper_scale_blocked: boolean;
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

export function checkBriefDesignConsistency(input: {
  briefSections?: MarkdownRunBriefSections;
  briefCompleteness?: BriefCompletenessArtifact;
  experimentContract?: ExperimentContract;
  designTitle?: string;
  designBaselines?: string[];
  designMetrics?: string[];
}): BriefDesignConsistencyResult {
  const warnings: BriefDesignWarning[] = [];
  const { briefSections, briefCompleteness, experimentContract, designBaselines, designMetrics, designTitle } = input;
  const hasExplicitBrief = Boolean(briefSections || briefCompleteness);
  const briefMissingBaseline = detectExplicitMissingBaselineContract(briefSections);
  const designBaselineCount = designBaselines?.length ?? experimentContract?.baselines?.length ?? 0;

  // 1. Missing target comparison
  if (!briefSections?.targetComparison) {
    if (hasExplicitBrief) {
      warnings.push({
        code: "MISSING_TARGET_COMPARISON",
        severity: "error",
        message: "The brief does not define a Target Comparison section. Paper-scale runs must name the explicit proposal-versus-baseline comparison in the brief.",
        evidence: `Design baselines: ${(designBaselines ?? []).join(", ")}`
      });
    } else if (designBaselines && designBaselines.length > 0) {
      warnings.push({
        code: "MISSING_TARGET_COMPARISON",
        severity: "warning",
        message: "Design specifies baselines but the brief has no Target Comparison section. Add an explicit comparison target to the brief.",
        evidence: `Design baselines: ${designBaselines.join(", ")}`
      });
    } else {
      warnings.push({
        code: "MISSING_TARGET_COMPARISON",
        severity: "error",
        message: "Neither the brief nor the design specifies an explicit comparison target. Paper-scale claims require at least one baseline comparison."
      });
    }
  }

  // 1b. Explicit missing-baseline artifact-audit contracts
  if (briefMissingBaseline && designBaselineCount > 0) {
    warnings.push({
      code: "MISSING_BASELINE_CONTRACT_VIOLATED",
      severity: "error",
      message:
        "The brief explicitly records the baseline/comparator as missing or intentionally absent, but the design declares baseline execution. Preserve the missing-baseline contract and route to blocked/downgraded evidence handling instead of fabricating a baseline-first experiment.",
      evidence: `Design title: ${designTitle ?? "(not specified)"}; design baselines: ${(designBaselines ?? experimentContract?.baselines ?? []).join(", ") || "none"}`
    });
  }
  if (
    briefMissingBaseline &&
    experimentContract &&
    /\b(?:improv|delta|relative\s+to|versus|vs\.?|baseline-first|comparator)\b/iu.test(
      [
        experimentContract.expected_metric_effect,
        experimentContract.keep_or_discard_rule,
        experimentContract.single_change,
        experimentContract.causal_mechanism
      ].join("\n")
    )
  ) {
    warnings.push({
      code: "MISSING_BASELINE_CLAIM_CEILING_VIOLATED",
      severity: "error",
      message:
        "The design contract still frames the run as a baseline comparison even though the brief says baseline evidence is missing. Comparative improvement claims must be blocked or downgraded until a real baseline exists."
    });
  }

  // 2. Insufficient evidence plan
  if (!briefSections?.minimumAcceptableEvidence) {
    warnings.push({
      code: "MISSING_EVIDENCE_PLAN",
      severity: hasExplicitBrief ? "error" : "warning",
      message: hasExplicitBrief
        ? "The brief does not specify Minimum Acceptable Evidence. Paper-scale workflow gates require an explicit evidence floor."
        : "The brief does not specify minimum acceptable evidence. Review will apply default thresholds which may be too lenient."
    });
  }

  // 3. Disallowed shortcuts check
  if (briefSections?.disallowedShortcuts && experimentContract) {
    const shortcuts = briefSections.disallowedShortcuts.toLowerCase();
    // Check if design single_change mentions anything disallowed
    if (shortcuts.includes("smoke") && experimentContract.single_change.toLowerCase().includes("smoke")) {
      warnings.push({
        code: "DISALLOWED_SHORTCUT_DETECTED",
        severity: "error",
        message: "The experiment design references smoke test artifacts, which is listed in disallowed shortcuts.",
        evidence: `single_change: ${experimentContract.single_change}`
      });
    }
    if (shortcuts.includes("cherry-pick") || shortcuts.includes("cherry pick")) {
      // Check for single-dataset-only designs
      if (designMetrics && designMetrics.length <= 1 && briefSections.disallowedShortcuts.includes("cherry-pick")) {
        warnings.push({
          code: "POTENTIAL_CHERRY_PICK",
          severity: "warning",
          message: "Design uses a single metric/dataset. Brief disallows cherry-picking. Ensure this is the pre-registered primary metric.",
          evidence: `Metrics: ${(designMetrics || []).join(", ") || "none specified"}`
        });
      }
    }
  }

  // 4. Unauthorized budgeted passes
  if (!briefSections?.allowedBudgetedPasses) {
    warnings.push({
      code: "MISSING_BUDGET_PASSES",
      severity: hasExplicitBrief ? "error" : "warning",
      message: hasExplicitBrief
        ? "The brief does not specify Allowed Budgeted Passes. Paper-scale workflow gates require an explicit budget guardrail."
        : "The brief does not specify allowed budgeted passes. Any extra analysis passes must be justified."
    });
  }

  // 4b. Missing paper ceiling / minimum experiment plan when a brief is present
  if (hasExplicitBrief && !briefSections?.paperCeiling) {
    warnings.push({
      code: "MISSING_PAPER_CEILING",
      severity: "error",
      message: "The brief does not specify a Paper Ceiling If Evidence Remains Weak. The workflow cannot govern paper-scale progression without that ceiling."
    });
  }
  if (hasExplicitBrief && !briefSections?.minimumExperimentPlan) {
    warnings.push({
      code: "MISSING_MINIMUM_EXPERIMENT_PLAN",
      severity: "error",
      message: "The brief does not specify a Minimum Experiment Plan. The workflow cannot validate paper-scale execution without an explicit minimum plan."
    });
  }

  // 5. Paper ceiling alignment
  if (briefSections?.paperCeiling && experimentContract) {
    const ceiling = briefSections.paperCeiling.toLowerCase();
    if (ceiling.includes("system_validation_note") || ceiling.includes("research_memo")) {
      // If ceiling is capped below paper_ready, and the contract expects strong claims, warn
      if (experimentContract.expected_metric_effect.toLowerCase().includes("significant")) {
        warnings.push({
          code: "CLAIMS_EXCEED_CEILING",
          severity: "warning",
          message: `Design expects "${experimentContract.expected_metric_effect}" but brief caps paper ceiling at lower level. Adjust expectations or strengthen evidence.`,
          evidence: `Paper ceiling: ${briefSections.paperCeiling.trim().slice(0, 200)}`
        });
      }
    }
  }

  // 6. Confounded design warning
  if (experimentContract?.confounded) {
    warnings.push({
      code: "CONFOUNDED_DESIGN",
      severity: "warning",
      message: `Experiment conflates ${(experimentContract.additional_changes?.length ?? 0) + 1} changes. Causal claims will be limited to correlation.`,
      evidence: `additional_changes: ${(experimentContract.additional_changes ?? []).join("; ")}`
    });
  }

  // 7. Brief completeness below paper scale
  if (briefCompleteness && !briefCompleteness.paper_scale_ready) {
    warnings.push({
      code: "BRIEF_NOT_PAPER_SCALE",
      severity: briefCompleteness.contract_ready ? "warning" : "error",
      message: `Brief completeness grade is "${briefCompleteness.grade}". Missing sections: ${briefCompleteness.missing_sections.join(", ") || "none"}.`
    });
  }

  // 8. Missing contract-critical brief sections
  if (briefCompleteness && !briefCompleteness.contract_ready) {
    warnings.push({
      code: "BRIEF_CONTRACT_INCOMPLETE",
      severity: "error",
      message: `Brief contract is incomplete. Missing governance sections: ${briefCompleteness.contract_missing_sections.join(", ") || "none"}.`
    });
  }

  // 9. Baseline requirement mismatch
  const actualBaselineCount = designBaselines?.length ?? experimentContract?.baselines?.length ?? 0;
  const requiredBaselineCount = experimentContract?.brief_required_baseline_count ?? 0;
  if (requiredBaselineCount > 0 && actualBaselineCount < requiredBaselineCount) {
    warnings.push({
      code: "BASELINE_REQUIREMENT_UNMET",
      severity: "error",
      message: `The design declares ${actualBaselineCount} baseline(s), but the brief requires at least ${requiredBaselineCount}.`,
      evidence: `Design baselines: ${(designBaselines ?? experimentContract?.baselines ?? []).join(", ") || "none"}`
    });
  }

  const paperScaleBlocked = warnings.some((w) => w.severity === "error");

  return {
    generated_at: new Date().toISOString(),
    warnings,
    paper_scale_blocked: paperScaleBlocked
  };
}

function detectExplicitMissingBaselineContract(briefSections?: MarkdownRunBriefSections): boolean {
  if (!briefSections) {
    return false;
  }
  const text = [
    briefSections.baselineComparator,
    briefSections.targetComparison,
    briefSections.minimumAcceptableEvidence,
    briefSections.disallowedShortcuts,
    briefSections.minimumExperimentPlan,
    briefSections.paperWorthinessGate,
    briefSections.failureConditions,
    briefSections.constraints
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n")
    .toLowerCase();

  if (!text.trim()) {
    return false;
  }

  const missingBaselinePatterns = [
    /\bbaseline(?:\s+(?:row|run|result|comparison|evidence))?\s*[:=-]\s*(?:intentionally\s+)?(?:absent|missing|unavailable|not\s+provided)\b/iu,
    /\bbaseline(?:\s+(?:row|run|result|comparison|evidence))?\s+(?:is\s+|was\s+|must\s+be\s+)?(?:intentionally\s+)?(?:absent|missing|unavailable|not\s+provided)\b/iu,
    /\b(?:no|missing|absent)\s+(?:explicit\s+)?baseline(?:\s+(?:row|run|result|comparison|evidence))?\b/iu,
    /\bwithout\s+(?:a\s+|an\s+)?(?:explicit\s+)?baseline(?:\s+(?:row|result|comparison))?\b/iu
  ];
  return missingBaselinePatterns.some((pattern) => pattern.test(text));
}
