import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonFile } from "../../utils/fs.js";
import {
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES
} from "./promotionBenchmarkConfirmatoryContract.js";
import {
  MAXIMUM_PROMOTION_GROUP_SHARE,
  MINIMUM_PROMOTION_OPERATOR_GROUPS,
  MINIMUM_PROMOTION_SOURCE_FAMILIES
} from "./promotionBenchmarkSourceDiversity.js";

export const PROMOTION_SOURCE_EXPANSION_AUDIT_REPORT = "promotion-source-expansion-audit.json";
export const PROMOTION_SOURCE_EXPANSION_AUDIT_SUMMARY = "promotion-source-expansion-audit.md";

export const PROMOTION_SOURCE_EXPANSION_STAGES = [
  "discovered_candidates",
  "source_hash_bound",
  "real_execution_trace_observed",
  "explicit_readiness_observed",
  "repeated_trial_evidence_observed",
  "comparison_result_table_observed",
  "figure_audit_observed",
  "claim_evidence_links_observed",
  "license_preserved",
  "human_license_verified",
  "double_human_normalized",
  "confirmatory_admitted"
] as const;

export type PromotionSourceExpansionStage = typeof PROMOTION_SOURCE_EXPANSION_STAGES[number];
export type PromotionSourceExpansionEvidenceBasis =
  | "exact_artifact_count"
  | "bounded_lower_bound"
  | "reported_claim"
  | "not_established";

export interface PromotionSourceExpansionObservation {
  count: number | null;
  basis: PromotionSourceExpansionEvidenceBasis;
  evidence_refs: string[];
  note: string;
}

export interface PromotionSourceExpansionAdmittedBundle {
  base_bundle_sha256: string;
  source_family_id: string;
  operator_group_id: string;
  admission_evidence_ref: string;
}

export interface PromotionSourceExpansionRoute {
  route_id: string;
  source_revision: string;
  source_url: string;
  selection_policy: string;
  stages: Record<PromotionSourceExpansionStage, PromotionSourceExpansionObservation>;
  admitted_bundles: PromotionSourceExpansionAdmittedBundle[];
  blockers: string[];
}

export interface PromotionSourceExpansionInventory {
  schema_version: "1.0";
  study_id: string;
  inventory_revision: string;
  routes: PromotionSourceExpansionRoute[];
  evidence_boundary: string;
}

export interface PromotionSourceExpansionStageSummary {
  stage: PromotionSourceExpansionStage;
  exact_artifact_count: number;
  bounded_lower_bound_count: number;
  established_floor: number;
  reported_claim_count: number;
  not_established_route_count: number;
}

export interface PromotionSourceExpansionIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionSourceExpansionNodeRecommendation {
  node: "collect_papers" | "design_experiments" | "run_experiments" | "analyze_results" | "review";
  reason_codes: string[];
  message: string;
}

export interface PromotionSourceExpansionAuditReport {
  schema_version: "1.0";
  study_id: string;
  inventory_revision: string;
  inventory_sha256: string;
  status: "paper_scale_source_ready" | "blocked_for_paper_scale";
  paper_scale_source_ready: boolean;
  required_base_bundle_count: number;
  exact_confirmatory_admitted_count: number;
  remaining_base_bundle_gap: number;
  route_count: number;
  admitted_source_family_count: number;
  admitted_operator_group_count: number;
  largest_admitted_source_family_share: number | null;
  largest_admitted_operator_group_share: number | null;
  stage_summaries: PromotionSourceExpansionStageSummary[];
  issues: PromotionSourceExpansionIssue[];
  node_recommendations: PromotionSourceExpansionNodeRecommendation[];
  routes: Array<{
    route_id: string;
    source_revision: string;
    source_url: string;
    stages: Record<PromotionSourceExpansionStage, PromotionSourceExpansionObservation>;
    blockers: string[];
  }>;
  evidence_boundary: string;
}

export interface AuditPromotionSourceExpansionInput {
  cwd: string;
  inventoryPath: string;
  outDir: string;
}

export interface AuditPromotionSourceExpansionResult {
  report_path: string;
  summary_path: string;
  report: PromotionSourceExpansionAuditReport;
}

export async function auditPromotionSourceExpansion(
  input: AuditPromotionSourceExpansionInput
): Promise<AuditPromotionSourceExpansionResult> {
  const cwd = path.resolve(input.cwd);
  const inventoryPath = path.resolve(cwd, input.inventoryPath);
  const outDir = path.resolve(cwd, input.outDir);
  if (await pathExists(outDir)) throw new Error(`Promotion source expansion audit output already exists: ${portableRef(cwd, outDir)}`);

  const inventoryBytes = await fs.readFile(inventoryPath);
  const inventory = parseInventory(JSON.parse(inventoryBytes.toString("utf8")) as unknown);
  const report = evaluatePromotionSourceExpansion(inventory, sha256(inventoryBytes));

  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, PROMOTION_SOURCE_EXPANSION_AUDIT_REPORT);
  const summaryPath = path.join(outDir, PROMOTION_SOURCE_EXPANSION_AUDIT_SUMMARY);
  await writeJsonFile(reportPath, report);
  await fs.writeFile(summaryPath, renderSummary(report), "utf8");
  return {
    report_path: portableRef(cwd, reportPath),
    summary_path: portableRef(cwd, summaryPath),
    report
  };
}

export function evaluatePromotionSourceExpansion(
  inventory: PromotionSourceExpansionInventory,
  inventorySha256 = sha256(Buffer.from(JSON.stringify(inventory), "utf8"))
): PromotionSourceExpansionAuditReport {
  const stageSummaries = PROMOTION_SOURCE_EXPANSION_STAGES.map((stage) => summarizeStage(inventory.routes, stage));
  const admitted = stageSummaries.find((summary) => summary.stage === "confirmatory_admitted")!;
  const exactAdmitted = admitted.exact_artifact_count;
  const admittedBundles = inventory.routes.flatMap((route) => route.admitted_bundles);
  const familyCounts = aggregateIds(admittedBundles.map((bundle) => bundle.source_family_id));
  const operatorCounts = aggregateIds(admittedBundles.map((bundle) => bundle.operator_group_id));
  const largestFamilyCount = Math.max(0, ...familyCounts.values());
  const largestOperatorCount = Math.max(0, ...operatorCounts.values());
  const largestFamilyShare = exactAdmitted > 0 ? largestFamilyCount / exactAdmitted : null;
  const largestOperatorShare = exactAdmitted > 0 ? largestOperatorCount / exactAdmitted : null;
  const issues: PromotionSourceExpansionIssue[] = [];

  if (exactAdmitted < MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES) {
    issues.push({
      code: "confirmatory_admitted_base_minimum_not_met",
      message: `Expected at least ${MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES} exactly admitted base bundles; observed ${exactAdmitted}.`
    });
  }
  if (familyCounts.size < MINIMUM_PROMOTION_SOURCE_FAMILIES) {
    issues.push({
      code: "admitted_source_family_minimum_not_met",
      message: `Expected at least ${MINIMUM_PROMOTION_SOURCE_FAMILIES} admitted source families; observed ${familyCounts.size}.`
    });
  }
  if (operatorCounts.size < MINIMUM_PROMOTION_OPERATOR_GROUPS) {
    issues.push({
      code: "admitted_operator_group_minimum_not_met",
      message: `Expected at least ${MINIMUM_PROMOTION_OPERATOR_GROUPS} admitted operator groups; observed ${operatorCounts.size}.`
    });
  }
  if (largestFamilyShare !== null && largestFamilyShare > MAXIMUM_PROMOTION_GROUP_SHARE) {
    issues.push({
      code: "admitted_source_family_share_exceeded",
      message: `The largest admitted source family covers ${largestFamilyCount}/${exactAdmitted} base bundles; the maximum share is ${MAXIMUM_PROMOTION_GROUP_SHARE}.`
    });
  }
  if (largestOperatorShare !== null && largestOperatorShare > MAXIMUM_PROMOTION_GROUP_SHARE) {
    issues.push({
      code: "admitted_operator_group_share_exceeded",
      message: `The largest admitted operator group covers ${largestOperatorCount}/${exactAdmitted} base bundles; the maximum share is ${MAXIMUM_PROMOTION_GROUP_SHARE}.`
    });
  }

  const admittedHashes = admittedBundles.map((bundle) => bundle.base_bundle_sha256);
  if (new Set(admittedHashes).size !== admittedHashes.length) {
    issues.push({
      code: "confirmatory_admitted_bundle_hash_duplicate",
      message: "Each confirmatory admission must bind a globally unique base-bundle SHA-256."
    });
  }

  for (const route of inventory.routes) {
    const routeAdmitted = route.stages.confirmatory_admitted;
    if (routeAdmitted.basis !== "exact_artifact_count" && routeAdmitted.count !== null && routeAdmitted.count > 0) {
      issues.push({
        code: "confirmatory_admission_not_exact",
        message: "Reported or lower-bound observations cannot count as confirmatory admission.",
        ref: route.route_id
      });
    }
    const admittedCount = routeAdmitted.basis === "exact_artifact_count" ? routeAdmitted.count || 0 : 0;
    if (route.admitted_bundles.length !== admittedCount) {
      issues.push({
        code: "confirmatory_admitted_bundle_records_mismatch",
        message: `Expected ${admittedCount} admitted bundle records; observed ${route.admitted_bundles.length}.`,
        ref: route.route_id
      });
    }
    if (admittedCount > 0) {
      for (const stage of PROMOTION_SOURCE_EXPANSION_STAGES) {
        const observation = route.stages[stage];
        if (observation.basis !== "exact_artifact_count" || observation.count === null
            || observation.count < admittedCount) {
          issues.push({
            code: "confirmatory_admitted_upstream_stage_not_exact",
            message: "Every admitted bundle requires exact, admission-sized evidence at every upstream stage.",
            ref: `${route.route_id}:${stage}`
          });
        }
      }
      if (route.blockers.length > 0) {
        issues.push({
          code: "confirmatory_admitted_route_has_blockers",
          message: "A route with confirmatory admissions cannot retain unresolved blockers.",
          ref: route.route_id
        });
      }
    }
  }

  const paperScaleSourceReady = issues.length === 0;
  return {
    schema_version: "1.0",
    study_id: inventory.study_id,
    inventory_revision: inventory.inventory_revision,
    inventory_sha256: inventorySha256,
    status: paperScaleSourceReady ? "paper_scale_source_ready" : "blocked_for_paper_scale",
    paper_scale_source_ready: paperScaleSourceReady,
    required_base_bundle_count: MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
    exact_confirmatory_admitted_count: exactAdmitted,
    remaining_base_bundle_gap: Math.max(0, MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES - exactAdmitted),
    route_count: inventory.routes.length,
    admitted_source_family_count: familyCounts.size,
    admitted_operator_group_count: operatorCounts.size,
    largest_admitted_source_family_share: largestFamilyShare,
    largest_admitted_operator_group_share: largestOperatorShare,
    stage_summaries: stageSummaries,
    issues,
    node_recommendations: buildRecommendations(stageSummaries, exactAdmitted),
    routes: inventory.routes.map((route) => ({
      route_id: route.route_id,
      source_revision: route.source_revision,
      source_url: route.source_url,
      stages: route.stages,
      blockers: route.blockers
    })),
    evidence_boundary: "This audit separates route observations from exact confirmatory admission. Counts based on reports, lower bounds, papers alone, generated tasks, or traces alone never become paper-scale evidence without local hash binding, source-grounded readiness evidence, independent normalization, and confirmatory intake."
  };
}

function summarizeStage(
  routes: readonly PromotionSourceExpansionRoute[],
  stage: PromotionSourceExpansionStage
): PromotionSourceExpansionStageSummary {
  let exact = 0;
  let lower = 0;
  let reported = 0;
  let unknown = 0;
  for (const route of routes) {
    const observation = route.stages[stage];
    if (observation.basis === "exact_artifact_count") exact += observation.count || 0;
    else if (observation.basis === "bounded_lower_bound") lower += observation.count || 0;
    else if (observation.basis === "reported_claim") reported += observation.count || 0;
    else unknown += 1;
  }
  return {
    stage,
    exact_artifact_count: exact,
    bounded_lower_bound_count: lower,
    established_floor: exact + lower,
    reported_claim_count: reported,
    not_established_route_count: unknown
  };
}

function buildRecommendations(
  summaries: readonly PromotionSourceExpansionStageSummary[],
  exactAdmitted: number
): PromotionSourceExpansionNodeRecommendation[] {
  const required = MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES;
  const byStage = new Map(summaries.map((summary) => [summary.stage, summary]));
  const recommendations: PromotionSourceExpansionNodeRecommendation[] = [];
  const deficient = (stage: PromotionSourceExpansionStage): boolean =>
    (byStage.get(stage)?.established_floor || 0) < required;
  if (deficient("discovered_candidates") || deficient("source_hash_bound")) {
    recommendations.push({
      node: "collect_papers",
      reason_codes: ["source_candidate_floor_incomplete"],
      message: "Acquire additional portable source candidates and bind their bytes and revisions before projection."
    });
  }
  if (deficient("real_execution_trace_observed") || deficient("repeated_trial_evidence_observed")) {
    recommendations.push({
      node: "run_experiments",
      reason_codes: ["real_execution_evidence_floor_incomplete"],
      message: "Acquire or execute repeated real runs with inspectable traces; generated tasks and manuscript-only files do not satisfy this gate."
    });
  }
  if (deficient("comparison_result_table_observed") || deficient("claim_evidence_links_observed")) {
    recommendations.push({
      node: "analyze_results",
      reason_codes: ["claim_result_linkage_floor_incomplete"],
      message: "Establish source-grounded comparator results and claim-to-evidence links without inferred constants."
    });
  }
  if (deficient("explicit_readiness_observed") || deficient("figure_audit_observed")
      || deficient("human_license_verified") || deficient("double_human_normalized")) {
    recommendations.push({
      node: "review",
      reason_codes: ["independent_readiness_review_floor_incomplete"],
      message: "Complete license review, source normalization, figure consistency review, and an explicit evidence-bounded readiness decision."
    });
  }
  if (exactAdmitted < required) {
    recommendations.push({
      node: "design_experiments",
      reason_codes: ["confirmatory_intake_floor_incomplete"],
      message: "Do not freeze the confirmatory suite until the exact admitted base count and diversity contract pass."
    });
  }
  return recommendations;
}

function parseInventory(value: unknown): PromotionSourceExpansionInventory {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.study_id)
      || !nonEmptyString(value.inventory_revision) || !Array.isArray(value.routes) || value.routes.length === 0
      || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Promotion source expansion inventory is invalid or incomplete.");
  }
  const routes = value.routes.map(parseRoute);
  if (new Set(routes.map((route) => route.route_id)).size !== routes.length) {
    throw new Error("Promotion source expansion route IDs must be unique.");
  }
  return {
    schema_version: "1.0",
    study_id: value.study_id,
    inventory_revision: value.inventory_revision,
    routes,
    evidence_boundary: value.evidence_boundary
  };
}

function parseRoute(value: unknown, index: number): PromotionSourceExpansionRoute {
  if (!isRecord(value) || !validId(value.route_id) || !nonEmptyString(value.source_revision)
      || !validHttpsUrl(value.source_url) || !nonEmptyString(value.selection_policy)
      || !isRecord(value.stages) || !Array.isArray(value.admitted_bundles) || !stringArray(value.blockers)) {
    throw new Error(`Invalid promotion source expansion route at index ${index + 1}.`);
  }
  const stages = Object.fromEntries(PROMOTION_SOURCE_EXPANSION_STAGES.map((stage) => [
    stage,
    parseObservation(value.stages[stage], `${value.route_id}:${stage}`)
  ])) as Record<PromotionSourceExpansionStage, PromotionSourceExpansionObservation>;
  const admitted = stages.confirmatory_admitted.count || 0;
  const admittedBundles = value.admitted_bundles.map(parseAdmittedBundle);
  if (admittedBundles.length !== admitted) {
    throw new Error(`Admitted bundle records must equal exact admission count: ${value.route_id}.`);
  }
  if (new Set(admittedBundles.map((item) => item.base_bundle_sha256)).size !== admittedBundles.length) {
    throw new Error(`Admitted bundle hashes must be unique within a route: ${value.route_id}.`);
  }
  if (admitted > 0) {
    if (stages.confirmatory_admitted.basis !== "exact_artifact_count") {
      throw new Error(`Confirmatory admission must use exact artifact counts: ${value.route_id}.`);
    }
    for (const stage of PROMOTION_SOURCE_EXPANSION_STAGES) {
      const observation = stages[stage];
      if (observation.basis !== "exact_artifact_count" || observation.count === null
          || observation.count < admitted) {
        throw new Error(`Upstream source stage must exactly establish every confirmatory admission: ${value.route_id}:${stage}.`);
      }
    }
    if (value.blockers.length > 0) throw new Error(`Admitted routes cannot retain blockers: ${value.route_id}.`);
  }
  return {
    route_id: value.route_id,
    source_revision: value.source_revision,
    source_url: value.source_url,
    selection_policy: value.selection_policy,
    stages,
    admitted_bundles: admittedBundles,
    blockers: value.blockers
  };
}

function parseObservation(value: unknown, ref: string): PromotionSourceExpansionObservation {
  if (!isRecord(value) || !isEvidenceBasis(value.basis) || !Array.isArray(value.evidence_refs)
      || !value.evidence_refs.every(validEvidenceRef) || !nonEmptyString(value.note)) {
    throw new Error(`Invalid promotion source stage observation: ${ref}.`);
  }
  if (value.basis === "not_established") {
    if (value.count !== null) throw new Error(`Unestablished source observations require count=null: ${ref}.`);
  } else if (!Number.isSafeInteger(value.count) || (value.count as number) < 0 || value.evidence_refs.length === 0) {
    throw new Error(`Established source observations require a non-negative count and evidence refs: ${ref}.`);
  }
  return {
    count: value.count as number | null,
    basis: value.basis,
    evidence_refs: [...value.evidence_refs],
    note: value.note
  };
}

function parseAdmittedBundle(value: unknown, index: number): PromotionSourceExpansionAdmittedBundle {
  if (!isRecord(value) || !sha256String(value.base_bundle_sha256)
      || !validId(value.source_family_id) || !validId(value.operator_group_id)
      || !validEvidenceRef(value.admission_evidence_ref)) {
    throw new Error(`Invalid promotion source admitted bundle at index ${index + 1}.`);
  }
  return {
    base_bundle_sha256: value.base_bundle_sha256,
    source_family_id: value.source_family_id,
    operator_group_id: value.operator_group_id,
    admission_evidence_ref: value.admission_evidence_ref
  };
}

function renderSummary(report: PromotionSourceExpansionAuditReport): string {
  const lines = [
    "# Promotion Source Expansion Audit",
    "",
    `- Status: ${report.status}`,
    `- Exact confirmatory admissions: ${report.exact_confirmatory_admitted_count}/${report.required_base_bundle_count}`,
    `- Remaining base-bundle gap: ${report.remaining_base_bundle_gap}`,
    `- Admitted source families: ${report.admitted_source_family_count}`,
    `- Admitted operator groups: ${report.admitted_operator_group_count}`,
    "",
    "## Evidence Ladder",
    "",
    "| Stage | Exact | Lower bound | Established floor | Reported only | Unknown routes |",
    "|---|---:|---:|---:|---:|---:|",
    ...report.stage_summaries.map((summary) =>
      `| ${summary.stage} | ${summary.exact_artifact_count} | ${summary.bounded_lower_bound_count} | ${summary.established_floor} | ${summary.reported_claim_count} | ${summary.not_established_route_count} |`),
    "",
    "## Blocking Issues",
    "",
    ...(report.issues.length > 0
      ? report.issues.map((issue) => `- ${issue.code}: ${issue.message}${issue.ref ? ` (${issue.ref})` : ""}`)
      : ["- None."]),
    "",
    "## Upstream Rechecks",
    "",
    ...(report.node_recommendations.length > 0
      ? report.node_recommendations.map((item) => `- ${item.node}: ${item.message}`)
      : ["- None."]),
    "",
    `Evidence boundary: ${report.evidence_boundary}`,
    ""
  ];
  return lines.join("\n");
}

function aggregateIds(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  return counts;
}

function isEvidenceBasis(value: unknown): value is PromotionSourceExpansionEvidenceBasis {
  return value === "exact_artifact_count" || value === "bounded_lower_bound"
    || value === "reported_claim" || value === "not_established";
}

function validEvidenceRef(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) return false;
  if (value.startsWith("https://")) return validHttpsUrl(value);
  return !path.isAbsolute(value) && !value.split("/").some((part) => part === ".." || part === "");
}

function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function portableRef(cwd: string, target: string): string {
  return path.relative(cwd, target).replace(/\\/gu, "/") || ".";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
