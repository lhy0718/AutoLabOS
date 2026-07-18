import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES,
  PROMOTION_CONFIRMATORY_VARIANTS_PER_BASE,
  REQUIRED_CONFIRMATORY_MUTATION_FAMILIES
} from "./promotionBenchmarkConfirmatoryContract.js";
import { isSha256 } from "./promotionBenchmarkSourceDiversity.js";
import { PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST } from "./promotionBenchmarkTrialCandidateHandoff.js";
import {
  PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS,
  PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT,
  PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE
} from "./promotionBenchmarkTrialCandidateReview.js";
import {
  PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT
} from "./promotionBenchmarkTrialCandidateReviewCampaignReturn.js";

export const PROMOTION_CONFIRMATORY_FREEZE_EVIDENCE_ROOT = "confirmatory-freeze";
export const PROMOTION_CONFIRMATORY_FREEZE_MANIFEST_REF =
  `${PROMOTION_CONFIRMATORY_FREEZE_EVIDENCE_ROOT}/frozen-intake-manifest.json`;
export const PROMOTION_CONFIRMATORY_FREEZE_RECIPE_REF =
  `${PROMOTION_CONFIRMATORY_FREEZE_EVIDENCE_ROOT}/recipe.json`;
export const PROMOTION_CONFIRMATORY_UPSTREAM_EVIDENCE_ROOT = "upstream-evidence";
export const PROMOTION_CONFIRMATORY_UPSTREAM_INTAKE_REF =
  `${PROMOTION_CONFIRMATORY_UPSTREAM_EVIDENCE_ROOT}/intake-manifest.json`;
export const PROMOTION_CONFIRMATORY_UPSTREAM_HANDOFF_ROOT =
  `${PROMOTION_CONFIRMATORY_UPSTREAM_EVIDENCE_ROOT}/candidate-handoff`;
export const PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT =
  `${PROMOTION_CONFIRMATORY_UPSTREAM_EVIDENCE_ROOT}/candidate-campaign-return`;
export const MINIMUM_PROVISIONAL_CONFIRMATORY_BASE_BUNDLES = 20;

export type PromotionConfirmatoryFreezeTier = "provisional" | "paper_scale";

export interface PromotionConfirmatoryFreezeCandidateReviewReceipt {
  handoff_id: string;
  source_revision: string;
  handoff_manifest_sha256: string;
  campaign_return_receipt_sha256: string;
  review_report_sha256: string;
  adjudicated_labels_sha256: string;
  review_evidence_sha256: string;
  source_eligible_candidate_count: number;
}

export interface PromotionConfirmatoryFreezeProvenance {
  schema_version: "1.1";
  method: "verified_confirmatory_freeze";
  study_id: string;
  intake_tier: PromotionConfirmatoryFreezeTier;
  freeze_manifest_ref: string;
  freeze_manifest_sha256: string;
  recipe_ref: string;
  recipe_sha256: string;
  intake_manifest_sha256: string;
  upstream_evidence_inventory_sha256?: string;
  upstream_evidence_file_count?: number;
  base_bundle_count: number;
  case_count: number;
  candidate_review: PromotionConfirmatoryFreezeCandidateReviewReceipt | null;
}

export interface PromotionConfirmatoryFreezeCaseBinding {
  case_id: string;
  base_bundle_id: string;
  split: "test";
  source_sha256: string;
  source_family_id_sha256: string;
  operator_group_id_sha256: string;
  mutation_family?: string;
  operations: unknown[];
}

export interface PromotionConfirmatoryFreezeIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionConfirmatoryFreezeInspection {
  passed: boolean;
  provenance: PromotionConfirmatoryFreezeProvenance | null;
  case_bindings: PromotionConfirmatoryFreezeCaseBinding[];
  issues: PromotionConfirmatoryFreezeIssue[];
}

export function parsePromotionConfirmatoryFreezeProvenance(
  value: unknown
): PromotionConfirmatoryFreezeProvenance | null {
  if (!isRecord(value)
      || value.schema_version !== "1.1"
      || value.method !== "verified_confirmatory_freeze"
      || !validId(value.study_id)
      || (value.intake_tier !== "provisional" && value.intake_tier !== "paper_scale")
      || value.freeze_manifest_ref !== PROMOTION_CONFIRMATORY_FREEZE_MANIFEST_REF
      || !isSha256(value.freeze_manifest_sha256)
      || value.recipe_ref !== PROMOTION_CONFIRMATORY_FREEZE_RECIPE_REF
      || !isSha256(value.recipe_sha256)
      || !isSha256(value.intake_manifest_sha256)
      || ((value.upstream_evidence_inventory_sha256 === undefined)
        !== (value.upstream_evidence_file_count === undefined))
      || (value.upstream_evidence_inventory_sha256 !== undefined
        && (!isSha256(value.upstream_evidence_inventory_sha256)
          || !Number.isInteger(value.upstream_evidence_file_count)
          || (value.upstream_evidence_file_count as number) <= 0))
      || !Number.isInteger(value.base_bundle_count)
      || (value.base_bundle_count as number) <= 0
      || !Number.isInteger(value.case_count)
      || (value.case_count as number) <= 0) {
    return null;
  }
  const candidateReview = value.candidate_review === null
    ? null
    : parseCandidateReviewReceipt(value.candidate_review);
  if ((value.intake_tier === "paper_scale" && !candidateReview)
      || (value.intake_tier === "provisional" && value.candidate_review !== null)
      || (value.intake_tier === "paper_scale"
        && value.upstream_evidence_inventory_sha256 === undefined)) {
    return null;
  }
  return {
    schema_version: "1.1",
    method: "verified_confirmatory_freeze",
    study_id: value.study_id,
    intake_tier: value.intake_tier,
    freeze_manifest_ref: value.freeze_manifest_ref,
    freeze_manifest_sha256: value.freeze_manifest_sha256,
    recipe_ref: value.recipe_ref,
    recipe_sha256: value.recipe_sha256,
    intake_manifest_sha256: value.intake_manifest_sha256,
    ...(typeof value.upstream_evidence_inventory_sha256 === "string"
      ? {
          upstream_evidence_inventory_sha256: value.upstream_evidence_inventory_sha256,
          upstream_evidence_file_count: value.upstream_evidence_file_count as number
        }
      : {}),
    base_bundle_count: value.base_bundle_count as number,
    case_count: value.case_count as number,
    candidate_review: candidateReview
  };
}

export async function inspectPromotionConfirmatoryFreezeEvidence(input: {
  freezeManifestPath: string;
  recipePath: string;
}): Promise<PromotionConfirmatoryFreezeInspection> {
  const freezeManifestPath = path.resolve(input.freezeManifestPath);
  const recipePath = path.resolve(input.recipePath);
  const issues: PromotionConfirmatoryFreezeIssue[] = [];
  if (path.dirname(freezeManifestPath) !== path.dirname(recipePath)) {
    issues.push({
      code: "confirmatory_freeze_files_not_co_located",
      message: "The freeze manifest and recipe must come from the same frozen intake directory."
    });
  }
  const freezeBytes = await readRegularFile(freezeManifestPath, "confirmatory_freeze_manifest_invalid", issues);
  const recipeBytes = await readRegularFile(recipePath, "confirmatory_freeze_recipe_invalid", issues);
  if (!freezeBytes || !recipeBytes) return { passed: false, provenance: null, case_bindings: [], issues };

  let freeze: Record<string, unknown>;
  let recipe: Record<string, unknown>;
  try {
    freeze = parseJsonRecord(freezeBytes);
  } catch {
    issues.push({
      code: "confirmatory_freeze_manifest_invalid",
      message: "The confirmatory freeze manifest must contain a JSON object."
    });
    return { passed: false, provenance: null, case_bindings: [], issues };
  }
  try {
    recipe = parseJsonRecord(recipeBytes);
  } catch {
    issues.push({
      code: "confirmatory_freeze_recipe_invalid",
      message: "The confirmatory freeze recipe must contain a JSON object."
    });
    return { passed: false, provenance: null, case_bindings: [], issues };
  }

  const recipeSha256 = sha256(recipeBytes);
  const tier = freeze.intake_tier;
  const baseBundleCount = freeze.base_bundle_count;
  const caseCount = freeze.case_count;
  const candidateReview = parseCandidateReviewReceipt(freeze.candidate_review);
  const upstreamEvidence = await inspectUpstreamEvidence(
    path.dirname(freezeManifestPath),
    freeze,
    tier,
    candidateReview,
    issues
  );
  if (freeze.schema_version !== "1.2"
      || (tier !== "provisional" && tier !== "paper_scale")
      || !validId(freeze.study_id)
      || freeze.evidence_class !== "external_real_run"
      || freeze.paper_claim_eligible !== false
      || freeze.adjudication_status !== "unreviewed"
      || freeze.mutation_isolation_status !== "unreviewed"
      || freeze.execution_provenance_status !== "artifact_verified"
      || freeze.source_diversity_status !== "declared_stratified"
      || !isSha256(freeze.intake_manifest_sha256)
      || freeze.recipe_sha256 !== recipeSha256
      || !Number.isInteger(baseBundleCount)
      || (baseBundleCount as number) <= 0
      || !Number.isInteger(caseCount)
      || (caseCount as number) <= 0
      || !sameStringSet(freeze.required_fault_families, REQUIRED_CONFIRMATORY_MUTATION_FAMILIES)
      || !Array.isArray(freeze.source_bundles)) {
    issues.push({
      code: "confirmatory_freeze_manifest_contract_invalid",
      message: "The freeze manifest does not satisfy the versioned confirmatory intake contract."
    });
  }

  const expectedMinimum = tier === "paper_scale"
    ? MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES
    : MINIMUM_PROVISIONAL_CONFIRMATORY_BASE_BUNDLES;
  if (typeof baseBundleCount === "number"
      && typeof caseCount === "number"
      && (baseBundleCount < expectedMinimum
        || caseCount !== baseBundleCount * PROMOTION_CONFIRMATORY_VARIANTS_PER_BASE
        || (tier === "paper_scale" && caseCount < MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES))) {
    issues.push({
      code: "confirmatory_freeze_scale_invalid",
      message: "The freeze manifest does not satisfy its declared intake tier's base and case floors."
    });
  }
  if ((tier === "paper_scale" && !candidateReview)
      || (tier === "provisional" && freeze.candidate_review !== undefined)) {
    issues.push({
      code: "confirmatory_freeze_candidate_review_invalid",
      message: "Paper-scale freezes require a complete candidate-review receipt; provisional freezes must not claim one."
    });
  }
  if (tier === "paper_scale" && !upstreamEvidence) {
    issues.push({
      code: "confirmatory_freeze_upstream_evidence_missing",
      message: "Paper-scale freezes require a closed copy of the intake, candidate handoff, and candidate review evidence."
    });
  }
  if (tier === "paper_scale" && candidateReview
      && candidateReview.source_eligible_candidate_count !== baseBundleCount) {
    issues.push({
      code: "confirmatory_freeze_candidate_review_count_mismatch",
      message: "The candidate-review receipt must cover every frozen paper-scale base."
    });
  }

  const sourceByBase = parseSourceBundles(
    freeze.source_bundles,
    tier,
    candidateReview,
    issues
  );
  if (typeof baseBundleCount === "number" && sourceByBase.size !== baseBundleCount) {
    issues.push({
      code: "confirmatory_freeze_source_inventory_mismatch",
      message: "The freeze source inventory must contain exactly one distinct record per base bundle."
    });
  }
  const caseBindings = parseRecipeBindings(recipe, sourceByBase, issues);
  if (recipe.schema_version !== "1.0"
      || recipe.suite_id !== freeze.study_id
      || recipe.evidence_class !== freeze.evidence_class
      || recipe.paper_claim_eligible !== false
      || recipe.adjudication_status !== "unreviewed"
      || recipe.mutation_isolation_status !== "unreviewed"
      || recipe.execution_provenance_status !== "artifact_verified"
      || recipe.source_diversity_status !== "declared_stratified") {
    issues.push({
      code: "confirmatory_freeze_recipe_contract_invalid",
      message: "The frozen recipe identity and fixed provisional statuses must match the freeze manifest."
    });
  }
  if (typeof caseCount === "number" && caseBindings.length !== caseCount) {
    issues.push({
      code: "confirmatory_freeze_recipe_case_count_mismatch",
      message: "The frozen recipe case count does not match the freeze manifest."
    });
  }
  validatePerBaseVariantCoverage(caseBindings, sourceByBase, issues);

  const structurallyValid = (tier === "provisional" || tier === "paper_scale")
    && typeof baseBundleCount === "number"
    && Number.isInteger(baseBundleCount)
    && typeof caseCount === "number"
    && Number.isInteger(caseCount)
    && isSha256(freeze.intake_manifest_sha256);
  const provenance: PromotionConfirmatoryFreezeProvenance | null = issues.length === 0 && structurallyValid
      ? {
        schema_version: "1.1",
        method: "verified_confirmatory_freeze",
        study_id: freeze.study_id as string,
        intake_tier: tier,
        freeze_manifest_ref: PROMOTION_CONFIRMATORY_FREEZE_MANIFEST_REF,
        freeze_manifest_sha256: sha256(freezeBytes),
        recipe_ref: PROMOTION_CONFIRMATORY_FREEZE_RECIPE_REF,
        recipe_sha256: recipeSha256,
        intake_manifest_sha256: freeze.intake_manifest_sha256 as string,
        ...(upstreamEvidence
          ? {
              upstream_evidence_inventory_sha256: upstreamEvidence.inventory_sha256,
              upstream_evidence_file_count: upstreamEvidence.file_count
            }
          : {}),
        base_bundle_count: baseBundleCount,
        case_count: caseCount,
        candidate_review: candidateReview
      }
    : null;
  return { passed: issues.length === 0, provenance, case_bindings: caseBindings, issues };
}

async function inspectUpstreamEvidence(
  freezeRoot: string,
  freeze: Record<string, unknown>,
  tier: unknown,
  candidateReview: PromotionConfirmatoryFreezeCandidateReviewReceipt | null,
  issues: PromotionConfirmatoryFreezeIssue[]
): Promise<{ inventory_sha256: string; file_count: number } | null> {
  const value = freeze.upstream_evidence;
  if (value === undefined) return null;
  if (!isRecord(value)
      || value.schema_version !== "1.1"
      || value.method !== "contained_intake_campaign_return_evidence"
      || value.intake_manifest_ref !== PROMOTION_CONFIRMATORY_UPSTREAM_INTAKE_REF
      || (tier === "paper_scale"
        ? value.candidate_handoff_root_ref !== PROMOTION_CONFIRMATORY_UPSTREAM_HANDOFF_ROOT
          || value.candidate_campaign_return_root_ref
            !== PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT
        : value.candidate_handoff_root_ref !== null
          || value.candidate_campaign_return_root_ref !== null)
      || !Array.isArray(value.files)
      || value.files.length === 0) {
    issues.push({
      code: "confirmatory_freeze_upstream_evidence_invalid",
      message: "The freeze must declare a versioned upstream intake/review evidence inventory."
    });
    return null;
  }
  const files: Array<{ ref: string; sha256: string }> = [];
  const seen = new Set<string>();
  for (const item of value.files) {
    if (!isRecord(item)
        || !upstreamEvidenceRef(item.ref)
        || !isSha256(item.sha256)
        || seen.has(item.ref)) {
      issues.push({
        code: "confirmatory_freeze_upstream_inventory_invalid",
        message: "Every upstream evidence file requires one unique safe relative path and SHA-256."
      });
      return null;
    }
    seen.add(item.ref);
    files.push({ ref: item.ref, sha256: item.sha256 });
  }
  const sortedFiles = [...files].sort((left, right) => left.ref.localeCompare(right.ref));
  if (JSON.stringify(files) !== JSON.stringify(sortedFiles)) {
    issues.push({
      code: "confirmatory_freeze_upstream_inventory_not_canonical",
      message: "The upstream evidence inventory must be sorted by relative path."
    });
  }
  const actualRefs = await listRegularFileRefs(
    path.join(freezeRoot, PROMOTION_CONFIRMATORY_UPSTREAM_EVIDENCE_ROOT),
    freezeRoot
  );
  if (!actualRefs || !sameStringSet(actualRefs, sortedFiles.map((item) => item.ref))) {
    issues.push({
      code: "confirmatory_freeze_upstream_evidence_set_not_closed",
      message: "The upstream evidence directory must contain exactly the inventory-bound regular files."
    });
  }
  for (const item of sortedFiles) {
    const bytes = await readRegularFile(
      path.join(freezeRoot, item.ref),
      "confirmatory_freeze_upstream_file_invalid",
      issues
    );
    if (bytes && sha256(bytes) !== item.sha256) {
      issues.push({
        code: "confirmatory_freeze_upstream_hash_mismatch",
        message: "An upstream evidence file no longer matches its inventory SHA-256.",
        ref: item.ref
      });
    }
  }
  const byRef = new Map(sortedFiles.map((item) => [item.ref, item.sha256]));
  if (byRef.get(PROMOTION_CONFIRMATORY_UPSTREAM_INTAKE_REF) !== freeze.intake_manifest_sha256) {
    issues.push({
      code: "confirmatory_freeze_intake_manifest_receipt_mismatch",
      message: "The contained intake manifest must reproduce intake_manifest_sha256."
    });
  }
  if (tier === "paper_scale" && candidateReview) {
    const handoffRef = `${PROMOTION_CONFIRMATORY_UPSTREAM_HANDOFF_ROOT}/${PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST}`;
    const campaignReceiptRef = `${PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT}/${PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT}`;
    const labelsRef = `${PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT}/adjudication/${PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS}`;
    const reviewEvidenceRef = `${PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT}/adjudication/${PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE}`;
    const reviewReportRef = `${PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT}/adjudication/${PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT}`;
    if (byRef.get(handoffRef) !== candidateReview.handoff_manifest_sha256
        || byRef.get(campaignReceiptRef) !== candidateReview.campaign_return_receipt_sha256
        || byRef.get(reviewReportRef) !== candidateReview.review_report_sha256
        || byRef.get(labelsRef) !== candidateReview.adjudicated_labels_sha256
        || byRef.get(reviewEvidenceRef) !== candidateReview.review_evidence_sha256) {
      issues.push({
        code: "confirmatory_freeze_candidate_review_receipt_mismatch",
        message: "Contained handoff and campaign-return evidence must reproduce every candidate-review receipt."
      });
    }
    await inspectContainedCampaignReturnReceipt({
      freezeRoot,
      campaignReceiptRef,
      handoffRef,
      candidateReview,
      inventory: byRef,
      issues
    });
  }
  const intakeBytes = await readRegularFile(
    path.join(freezeRoot, PROMOTION_CONFIRMATORY_UPSTREAM_INTAKE_REF),
    "confirmatory_freeze_upstream_intake_invalid",
    issues
  );
  if (intakeBytes) {
    try {
      const intake = parseJsonRecord(intakeBytes);
      const intakeTier = intake.schema_version === "1.0"
        ? (intake.intake_tier ?? "provisional")
        : intake.intake_tier;
      if (intake.study_id !== freeze.study_id
          || intakeTier !== tier
          || (tier === "paper_scale" ? intake.schema_version !== "1.2" : intake.schema_version !== "1.0")) {
        throw new Error("mismatch");
      }
    } catch {
      issues.push({
        code: "confirmatory_freeze_upstream_intake_mismatch",
        message: "The contained intake manifest identity and tier must match the freeze."
      });
    }
  }
  return {
    inventory_sha256: sha256(Buffer.from(JSON.stringify(sortedFiles))),
    file_count: sortedFiles.length
  };
}

function parseSourceBundles(
  value: unknown,
  tier: unknown,
  candidateReview: PromotionConfirmatoryFreezeCandidateReviewReceipt | null,
  issues: PromotionConfirmatoryFreezeIssue[]
): Map<string, {
  source_sha256: string;
  source_family_id_sha256: string;
  operator_group_id_sha256: string;
  copied_root: string;
}> {
  const sourceByBase = new Map<string, {
    source_sha256: string;
    source_family_id_sha256: string;
    operator_group_id_sha256: string;
    copied_root: string;
  }>();
  if (!Array.isArray(value)) return sourceByBase;
  const sourceHashes = new Set<string>();
  const candidateIds = new Set<string>();
  for (const [index, item] of value.entries()) {
    const paperScale = tier === "paper_scale";
    const candidateIdValid = paperScale
      ? validId(isRecord(item) ? item.candidate_id : undefined)
        && !candidateIds.has((item as Record<string, unknown>).candidate_id as string)
      : isRecord(item) && item.candidate_id === null;
    if (!isRecord(item)
        || !validId(item.base_bundle_id)
        || !isSha256(item.source_sha256)
        || !isSha256(item.source_family_id_sha256)
        || !isSha256(item.operator_group_id_sha256)
        || !nonEmptyString(item.source_revision)
        || (item.origin_kind !== "native" && item.origin_kind !== "projected" && item.origin_kind !== "normalized")
        || !candidateIdValid
        || (paperScale
          ? !isSha256(item.canonical_curation_record_sha256)
            || item.source_revision !== candidateReview?.source_revision
          : item.canonical_curation_record_sha256 !== null)
        || !isSha256(item.run_id_sha256)
        || !isSha256(item.execution_fingerprint)
        || !isSha256(item.evidence_manifest_sha256)
        || !isSha256(item.license_sha256)
        || !Number.isInteger(item.evidence_artifact_count)
        || (item.evidence_artifact_count as number) <= 0
        || !nonEmptyStringArray(item.evidence_roles)
        || item.copied_root !== `base-bundles/${item.base_bundle_id}`
        || sourceByBase.has(item.base_bundle_id)
        || sourceHashes.has(item.source_sha256)) {
      issues.push({
        code: "confirmatory_freeze_source_record_invalid",
        message: "Each frozen source must have a unique base identity, source hash, diversity hashes, and canonical copied root.",
        ref: String(index + 1)
      });
      continue;
    }
    if (paperScale) candidateIds.add(item.candidate_id as string);
    sourceHashes.add(item.source_sha256);
    sourceByBase.set(item.base_bundle_id, {
      source_sha256: item.source_sha256,
      source_family_id_sha256: item.source_family_id_sha256,
      operator_group_id_sha256: item.operator_group_id_sha256,
      copied_root: item.copied_root
    });
  }
  return sourceByBase;
}

function parseRecipeBindings(
  recipe: Record<string, unknown>,
  sourceByBase: Map<string, {
    source_sha256: string;
    source_family_id_sha256: string;
    operator_group_id_sha256: string;
    copied_root: string;
  }>,
  issues: PromotionConfirmatoryFreezeIssue[]
): PromotionConfirmatoryFreezeCaseBinding[] {
  if (!Array.isArray(recipe.cases)) {
    issues.push({
      code: "confirmatory_freeze_recipe_cases_invalid",
      message: "The frozen recipe must contain a case array."
    });
    return [];
  }
  const bindings: PromotionConfirmatoryFreezeCaseBinding[] = [];
  const caseIds = new Set<string>();
  for (const [index, item] of recipe.cases.entries()) {
    const source = isRecord(item) && validId(item.base_bundle_id)
      ? sourceByBase.get(item.base_bundle_id)
      : undefined;
    const gold = isRecord(item) && isRecord(item.gold) ? item.gold : undefined;
    if (!isRecord(item)
        || !validId(item.case_id)
        || caseIds.has(item.case_id)
        || !validId(item.base_bundle_id)
        || item.split !== "test"
        || !source
        || item.source_root !== source.copied_root
        || item.source_family_id_sha256 !== source.source_family_id_sha256
        || item.operator_group_id_sha256 !== source.operator_group_id_sha256
        || !validMutationOperations(item.operations)
        || !gold
        || gold.decision !== "needs_review"
        || !emptyStringArray(gold.blocking_concerns)
        || !emptyStringArray(gold.repair_owners)
        || (item.mutation_family !== undefined
          && !(REQUIRED_CONFIRMATORY_MUTATION_FAMILIES as readonly unknown[]).includes(item.mutation_family))
        || (item.mutation_family === undefined && item.operations.length !== 0)
        || (item.mutation_family !== undefined && item.operations.length === 0)) {
      issues.push({
        code: "confirmatory_freeze_recipe_case_invalid",
        message: "A frozen recipe case does not match its source binding or provisional label contract.",
        ref: String(index + 1)
      });
      continue;
    }
    caseIds.add(item.case_id);
    bindings.push({
      case_id: item.case_id,
      base_bundle_id: item.base_bundle_id,
      split: "test",
      source_sha256: source.source_sha256,
      source_family_id_sha256: source.source_family_id_sha256,
      operator_group_id_sha256: source.operator_group_id_sha256,
      ...(typeof item.mutation_family === "string" ? { mutation_family: item.mutation_family } : {}),
      operations: item.operations
    });
  }
  return bindings;
}

function validatePerBaseVariantCoverage(
  bindings: PromotionConfirmatoryFreezeCaseBinding[],
  sourceByBase: Map<string, unknown>,
  issues: PromotionConfirmatoryFreezeIssue[]
): void {
  const bindingsByBase = new Map<string, PromotionConfirmatoryFreezeCaseBinding[]>();
  for (const binding of bindings) {
    bindingsByBase.set(binding.base_bundle_id, [...(bindingsByBase.get(binding.base_bundle_id) || []), binding]);
  }
  for (const baseBundleId of sourceByBase.keys()) {
    const baseBindings = bindingsByBase.get(baseBundleId) || [];
    const cleanCount = baseBindings.filter((binding) => !binding.mutation_family).length;
    const mutationFamilies = baseBindings.flatMap((binding) =>
      binding.mutation_family ? [binding.mutation_family] : []).sort();
    if (cleanCount !== 1
        || mutationFamilies.join("\0") !== [...REQUIRED_CONFIRMATORY_MUTATION_FAMILIES].sort().join("\0")) {
      issues.push({
        code: "confirmatory_freeze_variant_coverage_invalid",
        message: "Every frozen base must contain one clean case and exactly one case per required fault family.",
        ref: baseBundleId
      });
    }
  }
}

function parseCandidateReviewReceipt(value: unknown): PromotionConfirmatoryFreezeCandidateReviewReceipt | null {
  if (!isRecord(value)
      || !validId(value.handoff_id)
      || !nonEmptyString(value.source_revision)
      || !isSha256(value.handoff_manifest_sha256)
      || !isSha256(value.campaign_return_receipt_sha256)
      || !isSha256(value.review_report_sha256)
      || !isSha256(value.adjudicated_labels_sha256)
      || !isSha256(value.review_evidence_sha256)
      || !Number.isInteger(value.source_eligible_candidate_count)
      || (value.source_eligible_candidate_count as number) <= 0) {
    return null;
  }
  return value as unknown as PromotionConfirmatoryFreezeCandidateReviewReceipt;
}

async function inspectContainedCampaignReturnReceipt(input: {
  freezeRoot: string;
  campaignReceiptRef: string;
  handoffRef: string;
  candidateReview: PromotionConfirmatoryFreezeCandidateReviewReceipt;
  inventory: Map<string, string>;
  issues: PromotionConfirmatoryFreezeIssue[];
}): Promise<void> {
  try {
    const receipt = parseJsonRecord(await fs.readFile(path.join(
      input.freezeRoot,
      input.campaignReceiptRef
    )));
    const receiptInput = isRecord(receipt.input_sha256) ? receipt.input_sha256 : null;
    const adjudication = isRecord(receipt.adjudication) ? receipt.adjudication : null;
    const containedHandoffRef =
      `${PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT}/upstream/trial-candidate-handoff.json`;
    const containedCampaignRef =
      `${PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT}/upstream/review-campaign.json`;
    if (receipt.kind !== "promotion_trial_candidate_campaign_return"
        || receipt.status !== "adjudicated"
        || receipt.passed !== true
        || receipt.handoff_id !== input.candidateReview.handoff_id
        || receipt.source_revision !== input.candidateReview.source_revision
        || receipt.assigned_return_count !== 3
        || receipt.required_return_count !== 3
        || !Array.isArray(receipt.validation_issues)
        || receipt.validation_issues.length !== 0
        || receipt.confirmatory_admitted !== false
        || !receiptInput
        || !isSha256(receiptInput.campaign_manifest)
        || receiptInput.handoff_manifest !== input.candidateReview.handoff_manifest_sha256
        || input.inventory.get(input.handoffRef) !== receiptInput.handoff_manifest
        || input.inventory.get(containedHandoffRef) !== receiptInput.handoff_manifest
        || input.inventory.get(containedCampaignRef) !== receiptInput.campaign_manifest
        || !adjudication
        || adjudication.attempted !== true
        || adjudication.passed !== true
        || adjudication.report_path
          !== `adjudication/${PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT}`
        || adjudication.report_sha256 !== input.candidateReview.review_report_sha256
        || adjudication.source_eligible_candidate_count
          !== input.candidateReview.source_eligible_candidate_count
        || !Array.isArray(receipt.files)) {
      throw new Error("campaign receipt mismatch");
    }
    const expectedRefs = [input.campaignReceiptRef];
    const seen = new Set<string>();
    for (const file of receipt.files) {
      if (!isRecord(file) || !safeRelativePath(file.path) || !isSha256(file.sha256)
          || seen.has(file.path)) {
        throw new Error("campaign inventory invalid");
      }
      seen.add(file.path);
      const ref = `${PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT}/${file.path}`;
      if (input.inventory.get(ref) !== file.sha256) {
        throw new Error("campaign file hash mismatch");
      }
      expectedRefs.push(ref);
    }
    const observedRefs = [...input.inventory.keys()].filter((ref) =>
      ref === input.campaignReceiptRef
        || ref.startsWith(`${PROMOTION_CONFIRMATORY_UPSTREAM_CAMPAIGN_RETURN_ROOT}/`));
    if (!sameStringSet(observedRefs, expectedRefs)) {
      throw new Error("campaign inventory not closed");
    }
  } catch {
    input.issues.push({
      code: "confirmatory_freeze_campaign_return_invalid",
      message: "The contained campaign-return receipt and its exact file inventory must remain self-consistent."
    });
  }
}

async function readRegularFile(
  filePath: string,
  code: string,
  issues: PromotionConfirmatoryFreezeIssue[]
): Promise<Buffer | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error("unsafe file");
    return await fs.readFile(filePath);
  } catch {
    issues.push({ code, message: "Confirmatory freeze evidence must be a non-empty, non-symlink regular file." });
    return null;
  }
}

function parseJsonRecord(bytes: Buffer): Record<string, unknown> {
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("not an object");
  return parsed;
}

function sameStringSet(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.every(nonEmptyString)
    && value.length === expected.length
    && [...value].sort().join("\0") === [...expected].sort().join("\0");
}

function emptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length === 0;
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(nonEmptyString)
    && new Set(value).size === value.length;
}

function validMutationOperations(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.every((operation) => {
    if (!isRecord(operation) || !safeRelativePath(operation.path)) return false;
    if (operation.op === "delete_path") return true;
    return (operation.op === "set_json_pointer" || operation.op === "remove_json_pointer")
      && typeof operation.pointer === "string"
      && operation.pointer.startsWith("/")
      && operation.pointer.length > 1;
  });
}

function safeRelativePath(value: unknown): value is string {
  return nonEmptyString(value)
    && !path.isAbsolute(value)
    && !value.includes("\\")
    && !value.split(/[\\/]/u).some((part) => part === ".." || part === "");
}

function upstreamEvidenceRef(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith(`${PROMOTION_CONFIRMATORY_UPSTREAM_EVIDENCE_ROOT}/`)
    && safeRelativePath(value);
}

async function listRegularFileRefs(root: string, relativeTo: string): Promise<string[] | null> {
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
  const refs: string[] = [];
  const visit = async (current: string): Promise<boolean> => {
    for (const entry of (await fs.readdir(current)).sort()) {
      const child = path.join(current, entry);
      const stat = await fs.lstat(child).catch(() => null);
      if (!stat || stat.isSymbolicLink()) return false;
      if (stat.isDirectory()) {
        if (!await visit(child)) return false;
      } else if (stat.isFile() && stat.size > 0) {
        refs.push(path.relative(relativeTo, child).replace(/\\/gu, "/"));
      } else {
        return false;
      }
    }
    return true;
  };
  return await visit(root) ? refs.sort() : null;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
