export const MINIMUM_PROMOTION_SOURCE_FAMILIES = 3;
export const MINIMUM_PROMOTION_OPERATOR_GROUPS = 3;
export const MAXIMUM_PROMOTION_GROUP_SHARE = 0.5;

export type PromotionBenchmarkSourceDiversityStatus = "unverified" | "declared_stratified";

export interface PromotionBenchmarkSourceDiversityCase {
  case_id: string;
  base_bundle_id: string;
  source_family_id_sha256?: string;
  operator_group_id_sha256?: string;
}

export interface PromotionBenchmarkSourceDiversityIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionBenchmarkSourceDiversityInspection {
  passed: boolean;
  base_bundle_count: number;
  source_family_count: number;
  operator_group_count: number;
  largest_source_family_count: number;
  largest_operator_group_count: number;
  issues: PromotionBenchmarkSourceDiversityIssue[];
}

export function inspectPromotionSourceDiversity(
  cases: readonly PromotionBenchmarkSourceDiversityCase[]
): PromotionBenchmarkSourceDiversityInspection {
  const issues: PromotionBenchmarkSourceDiversityIssue[] = [];
  const baseIds = [...new Set(cases.map((benchmarkCase) => benchmarkCase.base_bundle_id))];
  const familyByBase = collectSingleHashByBase(cases, "source_family_id_sha256");
  const operatorByBase = collectSingleHashByBase(cases, "operator_group_id_sha256");

  for (const baseId of baseIds) {
    const families = familyByBase.get(baseId) || new Set<string>();
    if (families.size !== 1) {
      issues.push({
        code: "source_family_provenance_incomplete",
        message: "Each base bundle must have exactly one valid source-family hash across its cases.",
        ref: baseId
      });
    }
    const operators = operatorByBase.get(baseId) || new Set<string>();
    if (operators.size !== 1) {
      issues.push({
        code: "operator_group_provenance_incomplete",
        message: "Each base bundle must have exactly one valid operator-group hash across its cases.",
        ref: baseId
      });
    }
  }

  const familyCounts = countCompleteBaseAssignments(familyByBase);
  const operatorCounts = countCompleteBaseAssignments(operatorByBase);
  const largestSourceFamilyCount = largestCount(familyCounts);
  const largestOperatorGroupCount = largestCount(operatorCounts);

  if (familyCounts.size < MINIMUM_PROMOTION_SOURCE_FAMILIES) {
    issues.push({
      code: "source_family_minimum_not_met",
      message: `Expected at least ${MINIMUM_PROMOTION_SOURCE_FAMILIES} source families; observed ${familyCounts.size}.`
    });
  }
  if (operatorCounts.size < MINIMUM_PROMOTION_OPERATOR_GROUPS) {
    issues.push({
      code: "operator_group_minimum_not_met",
      message: `Expected at least ${MINIMUM_PROMOTION_OPERATOR_GROUPS} operator groups; observed ${operatorCounts.size}.`
    });
  }
  if (baseIds.length > 0 && largestSourceFamilyCount / baseIds.length > MAXIMUM_PROMOTION_GROUP_SHARE) {
    issues.push({
      code: "source_family_share_exceeded",
      message: `A source family covers ${largestSourceFamilyCount}/${baseIds.length} base bundles; the maximum allowed share is ${MAXIMUM_PROMOTION_GROUP_SHARE}.`
    });
  }
  if (baseIds.length > 0 && largestOperatorGroupCount / baseIds.length > MAXIMUM_PROMOTION_GROUP_SHARE) {
    issues.push({
      code: "operator_group_share_exceeded",
      message: `An operator group covers ${largestOperatorGroupCount}/${baseIds.length} base bundles; the maximum allowed share is ${MAXIMUM_PROMOTION_GROUP_SHARE}.`
    });
  }

  return {
    passed: issues.length === 0,
    base_bundle_count: baseIds.length,
    source_family_count: familyCounts.size,
    operator_group_count: operatorCounts.size,
    largest_source_family_count: largestSourceFamilyCount,
    largest_operator_group_count: largestOperatorGroupCount,
    issues
  };
}

export function isPromotionSourceDiversityStatus(
  value: unknown
): value is PromotionBenchmarkSourceDiversityStatus {
  return value === "unverified" || value === "declared_stratified";
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function collectSingleHashByBase(
  cases: readonly PromotionBenchmarkSourceDiversityCase[],
  field: "source_family_id_sha256" | "operator_group_id_sha256"
): Map<string, Set<string>> {
  const byBase = new Map<string, Set<string>>();
  for (const benchmarkCase of cases) {
    const values = byBase.get(benchmarkCase.base_bundle_id) || new Set<string>();
    const value = benchmarkCase[field];
    if (isSha256(value)) values.add(value);
    byBase.set(benchmarkCase.base_bundle_id, values);
  }
  return byBase;
}

function countCompleteBaseAssignments(assignments: Map<string, Set<string>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const values of assignments.values()) {
    if (values.size !== 1) continue;
    const value = [...values][0];
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function largestCount(counts: Map<string, number>): number {
  return Math.max(0, ...counts.values());
}
