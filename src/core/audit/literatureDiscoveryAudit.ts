export interface LiteratureDiscoveryAuditFinding {
  code: string;
  severity: "warning" | "blocker";
  message: string;
  evidence_path: string;
}

export interface LiteratureDiscoveryAuditScore {
  measured: boolean;
  target_evidence_chain_present: boolean;
  included_excluded_trace_present: boolean;
  exclusion_reasons_present: boolean;
  abstention_recorded: boolean;
  findings: LiteratureDiscoveryAuditFinding[];
}

export function scoreLiteratureDiscoveryAudit(input: {
  payloads: Array<{ path: string; payload: Record<string, unknown> }>;
}): LiteratureDiscoveryAuditScore {
  if (input.payloads.length === 0) {
    return {
      measured: false,
      target_evidence_chain_present: false,
      included_excluded_trace_present: false,
      exclusion_reasons_present: false,
      abstention_recorded: false,
      findings: []
    };
  }

  const findings: LiteratureDiscoveryAuditFinding[] = [];
  let targetEvidenceChainPresent = false;
  let includedExcludedTracePresent = false;
  let exclusionReasonsPresent = false;
  let abstentionRecorded = false;

  for (const item of input.payloads) {
    const targetEvidence = item.payload.target_evidence_chain_present === true
      || nonEmptyArray(item.payload.target_evidence_chain);
    const includedTrace = nonEmptyArray(item.payload.included_papers) || Number(item.payload.included_count) > 0;
    const excludedTrace = nonEmptyArray(item.payload.excluded_papers) || Number(item.payload.excluded_count) > 0;
    const exclusionReasons = item.payload.exclusion_reasons_present === true || nonEmptyArray(item.payload.exclusion_reasons);
    const abstention = item.payload.abstention_recorded === true || stringValue(item.payload.abstention_decision) !== undefined;

    targetEvidenceChainPresent ||= targetEvidence;
    includedExcludedTracePresent ||= includedTrace && excludedTrace;
    exclusionReasonsPresent ||= exclusionReasons;
    abstentionRecorded ||= abstention;

    if (item.payload.track === "deep_target" && !targetEvidence) {
      findings.push({
        code: "literature_target_evidence_missing",
        severity: "warning",
        message: "Deep target-paper audit lacks a target evidence chain.",
        evidence_path: item.path
      });
    }
    if (item.payload.track === "wide_related_work" && !(includedTrace && excludedTrace)) {
      findings.push({
        code: "literature_include_exclude_trace_missing",
        severity: "warning",
        message: "Wide related-work audit lacks included/excluded paper trace.",
        evidence_path: item.path
      });
    }
    if ((excludedTrace || item.payload.track === "wide_related_work") && !exclusionReasons) {
      findings.push({
        code: "literature_exclusion_reasons_missing",
        severity: "warning",
        message: "Excluded related-work candidates are missing explicit exclusion reasons.",
        evidence_path: item.path
      });
    }
    if (item.payload.no_answer_possible === true && !abstention) {
      findings.push({
        code: "literature_abstention_missing",
        severity: "warning",
        message: "No-answer/abstention possibility is recorded but no abstention decision is preserved.",
        evidence_path: item.path
      });
    }
  }

  return {
    measured: true,
    target_evidence_chain_present: targetEvidenceChainPresent,
    included_excluded_trace_present: includedExcludedTracePresent,
    exclusion_reasons_present: exclusionReasonsPresent,
    abstention_recorded: abstentionRecorded,
    findings: dedupeFindings(findings)
  };
}

function dedupeFindings(findings: LiteratureDiscoveryAuditFinding[]): LiteratureDiscoveryAuditFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}\u0000${finding.message}\u0000${finding.evidence_path}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
