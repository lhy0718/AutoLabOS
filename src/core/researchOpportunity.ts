export const RESEARCH_OPPORTUNITY_TYPES = [
  "explicit_limitation",
  "cross_paper_result_disagreement",
  "boundary_or_transfer_mismatch",
  "missing_comparator_or_control",
  "reproducibility_gap"
] as const;

export type ResearchOpportunityType = typeof RESEARCH_OPPORTUNITY_TYPES[number];

export function isResearchOpportunityType(value: unknown): value is ResearchOpportunityType {
  return typeof value === "string" && (RESEARCH_OPPORTUNITY_TYPES as readonly string[]).includes(value);
}
