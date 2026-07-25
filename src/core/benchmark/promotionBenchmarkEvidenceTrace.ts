const CONCERN_EVIDENCE_REFS: Readonly<Record<string, readonly string[]>> = {
  baseline_or_comparator_missing: ["result_table.json"],
  result_table_missing: ["result_table.json"],
  result_table_incomplete: ["result_table.json"],
  fallback_only_evidence: ["evidence_store.jsonl"],
  unsupported_claims_present: ["paper/claim_evidence_table.json"],
  unsupported_sota_ranking: ["design_contracts.json"],
  citation_support_missing: ["paper/evidence_links.json"],
  figure_result_caption_mismatch: ["figure_audit/figure_audit_summary.json"],
  run_execution_incomplete: ["run_record.json"],
  run_execution_failed: ["run_record.json"],
  hidden_failed_run: ["run_record.json"],
  write_paper_failed: ["run_record.json"],
  repeated_run_provenance_missing: ["run_config.json", "experiment_evidence.json"],
  budget_contract_mismatch: ["run_config.json", "run_record.json"],
  stale_persisted_state: ["checkpoint/state.json", "paper/paper_readiness.json"]
};

export function expectedPromotionConcernEvidenceRefs(code: string): string[] | undefined {
  const refs = CONCERN_EVIDENCE_REFS[code];
  return refs ? [...refs] : undefined;
}

export function promotionConcernEvidenceRefsAreRelevant(code: string, refs: readonly string[]): boolean {
  const expected = CONCERN_EVIDENCE_REFS[code];
  if (!expected) return true;
  const referencedFiles = new Set(refs.map((ref) => ref.split("#", 1)[0]));
  return expected.every((ref) => referencedFiles.has(ref));
}
