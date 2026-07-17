import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet";

import { writeJsonFile } from "../../utils/fs.js";
import { hashPromotionArtifactTree } from "./promotionBenchmark.js";
import {
  assertPromotionArtifactPrivacySafe,
  projectPromotionReviewerArtifact
} from "./promotionArtifactPrivacy.js";
import { MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES } from "./promotionBenchmarkConfirmatoryContract.js";
import {
  MAXIMUM_PROMOTION_GROUP_SHARE,
  MINIMUM_PROMOTION_OPERATOR_GROUPS,
  MINIMUM_PROMOTION_SOURCE_FAMILIES
} from "./promotionBenchmarkSourceDiversity.js";
import {
  PROMOTION_TRIAL_CANDIDATE_ANNOTATION_SCHEMA,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_GUIDE,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_SCHEMA,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK,
  PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS,
  PROMOTION_TRIAL_CANDIDATE_RESOLUTION_SCHEMA,
  PROMOTION_TRIAL_CANDIDATE_RUBRIC,
  promotionTrialCandidateAnnotationSchema,
  promotionTrialCandidateLicenseReviewerGuide,
  promotionTrialCandidateLicenseReviewSchema,
  promotionTrialCandidateResolutionSchema,
  promotionTrialCandidateReviewerGuide,
  promotionTrialCandidateReviewRubric
} from "./promotionBenchmarkTrialCandidateReviewContract.js";

export const PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST = "trial-candidate-handoff.json";
export const PROMOTION_TRIAL_CANDIDATE_CONTROLLER_MAP = "controller/trial-candidate-map.json";
export const PROMOTION_TRIAL_CANDIDATE_TASKS = "reviewer/candidate-tasks.jsonl";
export const PROMOTION_TRIAL_CANDIDATE_GUIDE = "reviewer/REVIEWER_GUIDE.md";
export const PROMOTION_TRIAL_CANDIDATE_EVIDENCE_SUMMARY = "trial-candidate-evidence.json";
export const PROMOTION_TRIAL_CANDIDATE_SOURCE_RECIPE = "trial-candidate-source-recipe.json";
export const PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST = "reviewer-packet-manifest.json";
export const PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST = "license-packet-manifest.json";

const TRIALS_PER_BASE = 3;
const MAX_SELECTED_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 300_000;
const FETCH_TIMEOUT_MS = 60_000;
const FETCH_CONCURRENCY = 8;
const EMPTY_GIT_BLOB_SHA1 = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const MAX_PARQUET_SOURCE_BYTES = 512 * 1024 * 1024;

type PromotionTrialCandidateMaterialization =
  | "git_archive"
  | "verified_https_blobs"
  | "huggingface_parquet";

export interface ExportPromotionTrialCandidateHandoffInput {
  cwd: string;
  recipePath: string;
  sourceRoot: string;
  outDir: string;
  fetchImpl?: typeof fetch;
}

export interface ExportPromotionTrialCandidateHandoffResult {
  handoff_id: string;
  base_candidate_count: number;
  trial_artifact_count: number;
  output_dir: string;
  reviewer_dir: string;
  license_reviewer_dir: string;
  controller_map_path: string;
  source_recipe_path: string;
  manifest_path: string;
  evidence_summary_path: string;
}

export interface PromotionTrialCandidateRecord {
  candidate_id: string;
  base_candidate_sha256: string;
  source_family_id_sha256: string;
  operator_group_id_sha256: string;
  trials: Array<{
    trial_id: string;
    source_ref_sha256: string;
    source_blob_sha256: string;
    reviewer_blob_sha256: string;
    privacy_redaction_count: number;
    artifact_path: string;
  }>;
}

export interface PromotionTrialCandidateHandoffManifest {
  schema_version: "1.0";
  handoff_id: string;
  status: "candidate_handoff_ready";
  source_url: string;
  source_revision: string;
  selection_policy: string;
  selection_pre_content: true;
  source_materialization: PromotionTrialCandidateMaterialization;
  recipe_sha256: string;
  source_recipe_path: string;
  matched_trial_artifact_count: number;
  empty_blob_exclusion_count: number;
  duplicate_blob_exclusion_count: number;
  unique_eligible_trial_artifact_count: number;
  required_base_candidate_count: number;
  base_candidate_count: number;
  trials_per_base: number;
  trial_artifact_count: number;
  source_family_count: number;
  operator_group_count: number;
  largest_source_family_share: number;
  largest_operator_group_share: number;
  paper_scale_trace_floor_met: boolean;
  privacy_projection_applied: boolean;
  privacy_redaction_count: number;
  reviewer_artifact_tree_sha256: string;
  controller_map_path: string;
  candidates: PromotionTrialCandidateRecord[];
  outputs: Array<{ path: string; sha256: string }>;
  distribution_scope: "local_evaluation_only";
  source_license_status: "unreviewed";
  confirmatory_admitted: false;
  evidence_boundary: string;
}

export interface PromotionTrialCandidateHandoffIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionTrialCandidateHandoffInspection {
  passed: boolean;
  manifest: PromotionTrialCandidateHandoffManifest | null;
  issues: PromotionTrialCandidateHandoffIssue[];
}

export interface PromotionTrialCandidateReviewerPacketManifest {
  schema_version: "1.0";
  packet_role: "initial_candidate_review";
  handoff_id: string;
  candidate_count: number;
  trials_per_candidate: 3;
  trial_artifact_count: number;
  files: Array<{ path: string; sha256: string }>;
  evidence_boundary: string;
}

export interface PromotionTrialCandidateLicensePacketManifest {
  schema_version: "1.0";
  packet_role: "source_license_review";
  handoff_id: string;
  task_count: 1;
  files: Array<{ path: string; sha256: string }>;
  evidence_boundary: string;
}

export interface PromotionTrialCandidateReviewerPacketInspection {
  passed: boolean;
  manifest: PromotionTrialCandidateReviewerPacketManifest | null;
  issues: PromotionTrialCandidateHandoffIssue[];
}

export interface PromotionTrialCandidateLicensePacketInspection {
  passed: boolean;
  manifest: PromotionTrialCandidateLicensePacketManifest | null;
  issues: PromotionTrialCandidateHandoffIssue[];
}

export interface PromotionTrialCandidateEvidenceSummary {
  schema_version: "1.0";
  handoff_id: string;
  source_url: string;
  source_revision: string;
  source_materialization: PromotionTrialCandidateMaterialization;
  selection_pre_content: true;
  matched_trial_artifact_count: number;
  empty_blob_exclusion_count: number;
  duplicate_blob_exclusion_count: number;
  unique_eligible_trial_artifact_count: number;
  required_base_candidate_count: number;
  base_candidate_count: number;
  trials_per_base: number;
  trial_artifact_count: number;
  source_family_count: number;
  operator_group_count: number;
  largest_source_family_share: number;
  largest_operator_group_share: number;
  privacy_projection_applied: boolean;
  privacy_redaction_count: number;
  reviewer_artifact_tree_sha256: string;
  paper_scale_trace_floor_met: boolean;
  distribution_scope: "local_evaluation_only";
  source_license_status: "unreviewed";
  independent_candidate_review_completed: false;
  confirmatory_admitted: false;
  remaining_blockers: string[];
  evidence_boundary: string;
}

interface PromotionTrialCandidateRecipeCommon {
  schema_version: "1.1";
  handoff_id: string;
  source_url: string;
  source_revision: string;
  required_base_count: number;
  trials_per_base: 3;
  artifact_format: "json";
  selection_policy: string;
  materialization_mode: PromotionTrialCandidateMaterialization;
  license_evidence: Array<{ path: string; sha256: string }>;
}

interface PromotionTrialCandidateGitRecipe extends PromotionTrialCandidateRecipeCommon {
  materialization_mode: "git_archive" | "verified_https_blobs";
  path_scope: string;
  path_pattern: string;
  artifact_url_template?: string;
}

interface PromotionTrialCandidateParquetRecipe extends PromotionTrialCandidateRecipeCommon {
  materialization_mode: "huggingface_parquet";
  credential_projection?: "redact_values";
  reviewer_identity_redactions?: string[];
  parquet_sources: Array<{ path: string; sha256: string }>;
  columns: string[];
  json_columns: string[];
  reviewer_columns: string[];
  operator_pointer: string;
  family_pointer: string;
  base_pointer: string;
  trial_pointer?: string;
}

type PromotionTrialCandidateRecipe =
  | PromotionTrialCandidateGitRecipe
  | PromotionTrialCandidateParquetRecipe;

interface SourceTrialCandidate {
  source_path: string;
  source_ref_id: string;
  source_ref_algorithm: "git_blob_sha1" | "parquet_row_sha256";
  operator_group: string;
  source_family: string;
  base_group: string;
  trial: string;
  parquet_path?: string;
  parquet_sha256?: string;
  row_index?: number;
  reviewer_privacy_redaction_count?: number;
}

interface PlannedBase {
  operator_group: string;
  source_family: string;
  base_group: string;
  identity_sha256: string;
  trials: SourceTrialCandidate[];
}

interface CandidateDiscovery {
  candidates: SourceTrialCandidate[];
  matchedTrialArtifactCount: number;
  emptyBlobExclusionCount: number;
}

interface CandidateSelection {
  bases: PlannedBase[];
  duplicateBlobExclusionCount: number;
  uniqueEligibleTrialArtifactCount: number;
}

interface ControllerMap {
  schema_version: "1.0";
  handoff_id: string;
  source_url: string;
  source_revision: string;
  candidates: Array<{
    candidate_id: string;
    source_family: string;
    operator_group: string;
    base_group: string;
    trials: Array<{
      trial_id: string;
      source_trial: string;
      source_path: string;
      source_ref_id: string;
      source_ref_algorithm: "git_blob_sha1" | "parquet_row_sha256";
    }>;
  }>;
  evidence_boundary: string;
}

export async function exportPromotionTrialCandidateHandoff(
  input: ExportPromotionTrialCandidateHandoffInput
): Promise<ExportPromotionTrialCandidateHandoffResult> {
  const cwd = path.resolve(input.cwd);
  const recipePath = path.resolve(cwd, input.recipePath);
  const outDir = path.resolve(cwd, input.outDir);
  if (!nonEmptyString(input.sourceRoot)) {
    throw new Error("Promotion trial-candidate export requires a separate local source root.");
  }
  if (await pathExists(outDir)) {
    throw new Error(`Promotion trial-candidate handoff already exists: ${portableRef(cwd, outDir)}`);
  }

  const recipeBytes = await fs.readFile(recipePath);
  const recipe = parseRecipe(JSON.parse(recipeBytes.toString("utf8")) as unknown);
  const sourceRoot = path.resolve(cwd, input.sourceRoot);
  await assertSourceRoot(sourceRoot, recipe);
  const discovery = await discoverCandidates(sourceRoot, recipe);
  const selection = selectBalancedBases(discovery.candidates, recipe.required_base_count);
  const selected = selection.bases;
  const diversity = summarizeDiversity(selected);
  if (diversity.sourceFamilyCount < MINIMUM_PROMOTION_SOURCE_FAMILIES
      || diversity.operatorGroupCount < MINIMUM_PROMOTION_OPERATOR_GROUPS
      || diversity.largestSourceFamilyShare > MAXIMUM_PROMOTION_GROUP_SHARE
      || diversity.largestOperatorGroupShare > MAXIMUM_PROMOTION_GROUP_SHARE) {
    throw new Error("Selected trial candidates do not satisfy the source/operator diversity contract.");
  }

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    await writeJsonFile(path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_SOURCE_RECIPE), recipe);
    const recipeSha256 = await hashContainedRegularFile(
      stagingRoot,
      PROMOTION_TRIAL_CANDIDATE_SOURCE_RECIPE
    );
    const sourceArchiveRoot = path.join(stagingRoot, ".source-archive");
    await materializeSelectedArtifacts(
      sourceRoot,
      recipe,
      selected.flatMap((base) => base.trials),
      sourceArchiveRoot,
      input.fetchImpl || fetch
    );

    const reviewerRoot = path.join(stagingRoot, "reviewer");
    await fs.mkdir(path.join(reviewerRoot, "artifacts"), { recursive: true });
    await fs.writeFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_GUIDE),
      promotionTrialCandidateReviewerGuide(),
      "utf8"
    );
    await writeJsonFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_ANNOTATION_SCHEMA),
      promotionTrialCandidateAnnotationSchema()
    );
    await writeJsonFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_RESOLUTION_SCHEMA),
      promotionTrialCandidateResolutionSchema()
    );
    await fs.writeFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_RUBRIC),
      promotionTrialCandidateReviewRubric(),
      "utf8"
    );
    await writeJsonFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK),
      {
        schema_version: "1.0",
        handoff_id: recipe.handoff_id,
        source_url: recipe.source_url,
        source_revision: recipe.source_revision,
        evidence_files: licenseEvidencePacketEntries(recipe),
        required_decision: "distribution_scope"
      }
    );
    for (const [index, evidence] of recipe.license_evidence.entries()) {
      const source = resolveContainedFile(sourceRoot, evidence.path);
      if (!source) throw new Error("Source-license evidence escaped the source root: " + evidence.path);
      const target = path.join(
        stagingRoot,
        "license",
        licenseEvidencePacketEntries(recipe)[index].path
      );
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
    await writeJsonFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_LICENSE_SCHEMA),
      promotionTrialCandidateLicenseReviewSchema()
    );
    await fs.writeFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_LICENSE_GUIDE),
      promotionTrialCandidateLicenseReviewerGuide(),
      "utf8"
    );
    const publicCandidates: PromotionTrialCandidateRecord[] = [];
    const controllerCandidates: ControllerMap["candidates"] = [];
    const taskLines: string[] = [];
    let privacyRedactionCount = 0;

    for (const base of selected) {
      const candidateId = `candidate-${base.identity_sha256.slice(0, 24)}`;
      const publicTrials: PromotionTrialCandidateRecord["trials"] = [];
      const controllerTrials: ControllerMap["candidates"][number]["trials"] = [];
      for (const trial of base.trials) {
        const materialized = await readMaterializedTrial(sourceArchiveRoot, trial);
        const bytes = materialized.sourceBytes;
        try {
          JSON.parse(bytes.toString("utf8"));
        } catch {
          throw new Error(`Selected trial artifact is not valid JSON: ${trial.source_path}`);
        }
        const reviewerArtifact = projectPromotionReviewerArtifact(
          trial.source_path,
          materialized.reviewerInputBytes
        );
        const trialPrivacyRedactionCount = (trial.reviewer_privacy_redaction_count || 0)
          + reviewerArtifact.privacy_redaction_count;
        privacyRedactionCount += trialPrivacyRedactionCount;
        const trialId = `trial-${sha256Text(trial.source_path).slice(0, 16)}`;
        const artifactPath = `reviewer/artifacts/${candidateId}/${trialId}/trace.json`;
        const target = path.join(stagingRoot, artifactPath);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, reviewerArtifact.bytes);
        publicTrials.push({
          trial_id: trialId,
          source_ref_sha256: sha256Text(trial.source_path),
          source_blob_sha256: sha256(bytes),
          reviewer_blob_sha256: sha256(reviewerArtifact.bytes),
          privacy_redaction_count: trialPrivacyRedactionCount,
          artifact_path: artifactPath.replace(/^reviewer\//u, "")
        });
        controllerTrials.push({
          trial_id: trialId,
          source_trial: trial.trial,
          source_path: trial.source_path,
          source_ref_id: trial.source_ref_id,
          source_ref_algorithm: trial.source_ref_algorithm
        });
      }
      const baseCandidateSha256 = sha256Text(publicTrials
        .map((trial) => `${trial.source_ref_sha256}:${trial.source_blob_sha256}`)
        .sort()
        .join("\n"));
      publicCandidates.push({
        candidate_id: candidateId,
        base_candidate_sha256: baseCandidateSha256,
        source_family_id_sha256: sha256Text(base.source_family),
        operator_group_id_sha256: sha256Text(base.operator_group),
        trials: publicTrials
      });
      controllerCandidates.push({
        candidate_id: candidateId,
        source_family: base.source_family,
        operator_group: base.operator_group,
        base_group: base.base_group,
        trials: controllerTrials
      });
      taskLines.push(JSON.stringify({
        schema_version: "1.0",
        candidate_id: candidateId,
        artifact_root: `artifacts/${candidateId}`,
        trial_ids: publicTrials.map((trial) => trial.trial_id),
        required_observations: [...PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS]
      }));
    }
    await fs.rm(sourceArchiveRoot, { recursive: true, force: true });
    await fs.writeFile(path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_TASKS), `${taskLines.join("\n")}\n`, "utf8");

    const reviewerPacketManifest: PromotionTrialCandidateReviewerPacketManifest = {
      schema_version: "1.0",
      packet_role: "initial_candidate_review",
      handoff_id: recipe.handoff_id,
      candidate_count: publicCandidates.length,
      trials_per_candidate: TRIALS_PER_BASE,
      trial_artifact_count: publicCandidates.length * TRIALS_PER_BASE,
      files: await inventoryOutputs(reviewerRoot),
      evidence_boundary: "This self-contained packet binds only opaque candidate-review tasks, runtime review contracts, and privacy-projected artifacts. It contains no source URL, source revision, source/operator grouping, controller map, peer annotation, license decision, confirmatory admission, or paper-readiness evidence."
    };
    await writeJsonFile(
      path.join(reviewerRoot, PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST),
      reviewerPacketManifest
    );

    const licenseRoot = path.join(stagingRoot, "license");
    const licensePacketManifest: PromotionTrialCandidateLicensePacketManifest = {
      schema_version: "1.0",
      packet_role: "source_license_review",
      handoff_id: recipe.handoff_id,
      task_count: 1,
      files: await inventoryOutputs(licenseRoot),
      evidence_boundary: "This self-contained packet binds only one public source-license task and its runtime review contract. It contains no candidate artifact, candidate annotation, controller map, license decision, confirmatory admission, or paper-readiness evidence."
    };
    await writeJsonFile(
      path.join(licenseRoot, PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST),
      licensePacketManifest
    );

    const controllerMap: ControllerMap = {
      schema_version: "1.0",
      handoff_id: recipe.handoff_id,
      source_url: recipe.source_url,
      source_revision: recipe.source_revision,
      candidates: controllerCandidates,
      evidence_boundary: "This controller-only map reconnects opaque candidates to source locations and explicit operator, family, and base groups. It must not be distributed with the reviewer directory."
    };
    await writeJsonFile(path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_CONTROLLER_MAP), controllerMap);

    const reviewerArtifactTreeSha256 = await hashPromotionArtifactTree(reviewerRoot);
    const evidenceSummary: PromotionTrialCandidateEvidenceSummary = {
      schema_version: "1.0",
      handoff_id: recipe.handoff_id,
      source_url: recipe.source_url,
      source_revision: recipe.source_revision,
      source_materialization: recipe.materialization_mode,
      selection_pre_content: true,
      matched_trial_artifact_count: discovery.matchedTrialArtifactCount,
      empty_blob_exclusion_count: discovery.emptyBlobExclusionCount,
      duplicate_blob_exclusion_count: selection.duplicateBlobExclusionCount,
      unique_eligible_trial_artifact_count: selection.uniqueEligibleTrialArtifactCount,
      required_base_candidate_count: recipe.required_base_count,
      base_candidate_count: publicCandidates.length,
      trials_per_base: recipe.trials_per_base,
      trial_artifact_count: publicCandidates.length * recipe.trials_per_base,
      source_family_count: diversity.sourceFamilyCount,
      operator_group_count: diversity.operatorGroupCount,
      largest_source_family_share: diversity.largestSourceFamilyShare,
      largest_operator_group_share: diversity.largestOperatorGroupShare,
      privacy_projection_applied: privacyRedactionCount > 0,
      privacy_redaction_count: privacyRedactionCount,
      reviewer_artifact_tree_sha256: reviewerArtifactTreeSha256,
      paper_scale_trace_floor_met: publicCandidates.length >= MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
      distribution_scope: "local_evaluation_only",
      source_license_status: "unreviewed",
      independent_candidate_review_completed: false,
      confirmatory_admitted: false,
      remaining_blockers: [
        "human_license_review",
        "independent_double_candidate_review",
        "comparison_result_verification",
        "readiness_figure_and_claim_link_review",
        "confirmatory_intake_freeze"
      ],
      evidence_boundary: "This generated summary establishes only a revision-bound, privacy-projected, three-trial candidate handoff. It is not a redistributable corpus, a human annotation result, a confirmatory admission, or paper-readiness evidence."
    };
    await writeJsonFile(path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_EVIDENCE_SUMMARY), evidenceSummary);
    const outputs = await inventoryOutputs(stagingRoot);
    const manifest: PromotionTrialCandidateHandoffManifest = {
      schema_version: "1.0",
      handoff_id: recipe.handoff_id,
      status: "candidate_handoff_ready",
      source_url: recipe.source_url,
      source_revision: recipe.source_revision,
      selection_policy: recipe.selection_policy,
      selection_pre_content: true,
      source_materialization: recipe.materialization_mode,
      recipe_sha256: recipeSha256,
      source_recipe_path: PROMOTION_TRIAL_CANDIDATE_SOURCE_RECIPE,
      matched_trial_artifact_count: discovery.matchedTrialArtifactCount,
      empty_blob_exclusion_count: discovery.emptyBlobExclusionCount,
      duplicate_blob_exclusion_count: selection.duplicateBlobExclusionCount,
      unique_eligible_trial_artifact_count: selection.uniqueEligibleTrialArtifactCount,
      required_base_candidate_count: recipe.required_base_count,
      base_candidate_count: publicCandidates.length,
      trials_per_base: recipe.trials_per_base,
      trial_artifact_count: publicCandidates.length * recipe.trials_per_base,
      source_family_count: diversity.sourceFamilyCount,
      operator_group_count: diversity.operatorGroupCount,
      largest_source_family_share: diversity.largestSourceFamilyShare,
      largest_operator_group_share: diversity.largestOperatorGroupShare,
      paper_scale_trace_floor_met: publicCandidates.length >= MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
      privacy_projection_applied: privacyRedactionCount > 0,
      privacy_redaction_count: privacyRedactionCount,
      reviewer_artifact_tree_sha256: reviewerArtifactTreeSha256,
      controller_map_path: PROMOTION_TRIAL_CANDIDATE_CONTROLLER_MAP,
      candidates: publicCandidates,
      outputs,
      distribution_scope: "local_evaluation_only",
      source_license_status: "unreviewed",
      confirmatory_admitted: false,
      evidence_boundary: "This handoff binds three source-revision trial artifacts per candidate after outcome-blind selection. Git bytes are verified against object IDs; Parquet row locators are anchored to verified file hashes and materialized through the declared deterministic privacy projection. Credential-like content fails closed unless the recipe explicitly selects value redaction, private machine paths are always replaced, and source/reviewer hashes remain separate. This establishes a trace-candidate floor only, not comparable results, paper readiness, licensing, human annotation, operator independence, or confirmatory admission."
    };
    await writeJsonFile(path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST), manifest);
    const inspection = await inspectPromotionTrialCandidateHandoff(stagingRoot);
    if (!inspection.passed) {
      throw new Error(`Promotion trial-candidate handoff failed self-inspection: ${inspection.issues.map((issue) =>
        `${issue.code}${issue.ref ? `(${issue.ref})` : ""}`).join(", ")}.`);
    }
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    handoff_id: recipe.handoff_id,
    base_candidate_count: selected.length,
    trial_artifact_count: selected.length * recipe.trials_per_base,
    output_dir: portableRef(cwd, outDir),
    reviewer_dir: portableRef(cwd, path.join(outDir, "reviewer")),
    license_reviewer_dir: portableRef(cwd, path.join(outDir, "license")),
    controller_map_path: portableRef(cwd, path.join(outDir, PROMOTION_TRIAL_CANDIDATE_CONTROLLER_MAP)),
    source_recipe_path: portableRef(cwd, path.join(outDir, PROMOTION_TRIAL_CANDIDATE_SOURCE_RECIPE)),
    manifest_path: portableRef(cwd, path.join(outDir, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST)),
    evidence_summary_path: portableRef(cwd, path.join(outDir, PROMOTION_TRIAL_CANDIDATE_EVIDENCE_SUMMARY))
  };
}

export async function inspectPromotionTrialCandidateHandoff(
  handoffRoot: string
): Promise<PromotionTrialCandidateHandoffInspection> {
  const root = path.resolve(handoffRoot);
  const issues: PromotionTrialCandidateHandoffIssue[] = [];
  let manifest: PromotionTrialCandidateHandoffManifest;
  try {
    manifest = parseHandoffManifest(JSON.parse(
      await fs.readFile(path.join(root, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST), "utf8")
    ) as unknown);
  } catch {
    return {
      passed: false,
      manifest: null,
      issues: [{ code: "trial_candidate_handoff_manifest_unreadable", message: "The handoff manifest is missing or invalid." }]
    };
  }

  const expected = new Set([
    PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST,
    ...manifest.outputs.map((output) => output.path)
  ]);
  const observed: string[] = await listRegularFiles(root).catch((): string[] => []);
  for (const relativePath of observed) {
    if (!expected.has(relativePath)) {
      issues.push({ code: "trial_candidate_handoff_untracked_file", message: "The handoff contains an untracked file.", ref: relativePath });
    }
  }
  for (const relativePath of expected) {
    if (!observed.includes(relativePath)) {
      issues.push({ code: "trial_candidate_handoff_file_missing", message: "A manifest-bound handoff file is missing.", ref: relativePath });
    }
  }
  for (const output of manifest.outputs) {
    const observedHash = await hashContainedRegularFile(root, output.path).catch(() => null);
    if (observedHash !== output.sha256) {
      issues.push({ code: "trial_candidate_handoff_output_hash_mismatch", message: "A handoff output hash changed.", ref: output.path });
    }
  }
  try {
    const recipe = parseRecipe(JSON.parse(await fs.readFile(
      path.join(root, manifest.source_recipe_path),
      "utf8"
    )) as unknown);
    const recipeHash = await hashContainedRegularFile(root, manifest.source_recipe_path);
    if (recipeHash !== manifest.recipe_sha256
        || recipe.handoff_id !== manifest.handoff_id
        || recipe.source_url !== manifest.source_url
        || recipe.source_revision !== manifest.source_revision
        || recipe.selection_policy !== manifest.selection_policy
        || recipe.materialization_mode !== manifest.source_materialization
        || recipe.required_base_count !== manifest.required_base_candidate_count
        || recipe.trials_per_base !== manifest.trials_per_base) throw new Error("mismatch");
  } catch {
    issues.push({
      code: "trial_candidate_handoff_source_recipe_invalid",
      message: "The portable source recipe is missing, changed, machine-bound, or inconsistent with the handoff manifest.",
      ref: manifest.source_recipe_path
    });
  }
  if (manifest.base_candidate_count !== manifest.candidates.length
      || manifest.trial_artifact_count !== manifest.candidates.reduce((sum, candidate) => sum + candidate.trials.length, 0)) {
    issues.push({ code: "trial_candidate_handoff_count_mismatch", message: "Manifest candidate or trial counts are inconsistent." });
  }
  if (manifest.matched_trial_artifact_count !== manifest.empty_blob_exclusion_count
        + manifest.duplicate_blob_exclusion_count + manifest.unique_eligible_trial_artifact_count
      || manifest.unique_eligible_trial_artifact_count < manifest.trial_artifact_count) {
    issues.push({ code: "trial_candidate_handoff_selection_accounting_invalid", message: "Structural exclusion and eligibility counts are inconsistent." });
  }
  const observedPrivacyRedactions = manifest.candidates.reduce((sum, candidate) =>
    sum + candidate.trials.reduce((trialSum, trial) => trialSum + trial.privacy_redaction_count, 0), 0);
  if (manifest.privacy_redaction_count !== observedPrivacyRedactions
      || manifest.privacy_projection_applied !== (observedPrivacyRedactions > 0)) {
    issues.push({ code: "trial_candidate_handoff_privacy_count_mismatch", message: "Manifest privacy projection accounting is inconsistent." });
  }
  const candidateIds = manifest.candidates.map((candidate) => candidate.candidate_id);
  const candidateHashes = manifest.candidates.map((candidate) => candidate.base_candidate_sha256);
  if (new Set(candidateIds).size !== candidateIds.length || new Set(candidateHashes).size !== candidateHashes.length) {
    issues.push({ code: "trial_candidate_handoff_candidate_duplicate", message: "Candidate IDs and hashes must be unique." });
  }
  try {
    const tasks = parseReviewerTasks(await fs.readFile(path.join(root, PROMOTION_TRIAL_CANDIDATE_TASKS), "utf8"));
    if (tasks.length !== manifest.candidates.length) throw new Error("count mismatch");
    const taskById = new Map(tasks.map((task) => [task.candidate_id, task]));
    for (const candidate of manifest.candidates) {
      const task = taskById.get(candidate.candidate_id);
      if (!task
          || task.artifact_root !== `artifacts/${candidate.candidate_id}`
          || task.trial_ids.join("\0") !== candidate.trials.map((trial) => trial.trial_id).join("\0")) {
        throw new Error("identity mismatch");
      }
    }
  } catch {
    issues.push({
      code: "trial_candidate_handoff_reviewer_tasks_invalid",
      message: "The reviewer task file is missing, duplicated, or inconsistent with the runtime review contract."
    });
  }
  for (const candidate of manifest.candidates) {
    if (candidate.trials.length !== TRIALS_PER_BASE) {
      issues.push({ code: "trial_candidate_handoff_trial_count_invalid", message: "Every candidate requires exactly three trials.", ref: candidate.candidate_id });
    }
    for (const trial of candidate.trials) {
      const artifactPath = `reviewer/${trial.artifact_path}`;
      const artifactHash = await hashContainedRegularFile(root, artifactPath).catch(() => null);
      if (artifactHash !== trial.reviewer_blob_sha256) {
        issues.push({ code: "trial_candidate_handoff_trial_hash_mismatch", message: "A reviewer trial no longer matches its recorded reviewer hash.", ref: artifactPath });
      }
      const artifactBytes = await readContainedRegularFile(root, artifactPath).catch(() => null);
      if (artifactBytes) {
        try {
          assertPromotionArtifactPrivacySafe(artifactPath, artifactBytes);
        } catch {
          issues.push({ code: "trial_candidate_handoff_privacy_leak", message: "A reviewer trial contains non-portable or credential-like content.", ref: artifactPath });
        }
      }
    }
  }
  const reviewerRoot = path.join(root, "reviewer");
  const reviewerHash = await hashPromotionArtifactTree(reviewerRoot).catch(() => null);
  if (reviewerHash !== manifest.reviewer_artifact_tree_sha256) {
    issues.push({ code: "trial_candidate_handoff_reviewer_tree_mismatch", message: "The reviewer artifact tree hash changed." });
  }
  const reviewerFiles: string[] = await listRegularFiles(reviewerRoot).catch((): string[] => []);
  if (reviewerFiles.some((relativePath) => relativePath.startsWith("controller/"))) {
    issues.push({ code: "trial_candidate_handoff_controller_leak", message: "Controller data must not appear in the reviewer directory." });
  }
  const reviewerPacketInspection = await inspectPromotionTrialCandidateReviewerPacket(reviewerRoot);
  if (!reviewerPacketInspection.passed) {
    issues.push(...reviewerPacketInspection.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      ...(issue.ref ? { ref: `reviewer/${issue.ref}` } : {})
    })));
  } else if (reviewerPacketInspection.manifest
      && (reviewerPacketInspection.manifest.handoff_id !== manifest.handoff_id
        || reviewerPacketInspection.manifest.candidate_count !== manifest.base_candidate_count
        || reviewerPacketInspection.manifest.trial_artifact_count !== manifest.trial_artifact_count)) {
    issues.push({
      code: "trial_candidate_handoff_reviewer_packet_identity_mismatch",
      message: "The self-contained reviewer packet does not describe the same handoff candidate set."
    });
  }
  try {
    const schema = JSON.parse(await fs.readFile(
      path.join(root, PROMOTION_TRIAL_CANDIDATE_ANNOTATION_SCHEMA),
      "utf8"
    )) as unknown;
    const resolutionSchema = JSON.parse(await fs.readFile(
      path.join(root, PROMOTION_TRIAL_CANDIDATE_RESOLUTION_SCHEMA),
      "utf8"
    )) as unknown;
    const guide = await fs.readFile(path.join(root, PROMOTION_TRIAL_CANDIDATE_GUIDE), "utf8");
    const rubric = await fs.readFile(path.join(root, PROMOTION_TRIAL_CANDIDATE_RUBRIC), "utf8");
    if (JSON.stringify(schema) !== JSON.stringify(promotionTrialCandidateAnnotationSchema())
        || JSON.stringify(resolutionSchema) !== JSON.stringify(promotionTrialCandidateResolutionSchema())
        || guide !== promotionTrialCandidateReviewerGuide()
        || rubric !== promotionTrialCandidateReviewRubric()) {
      throw new Error("mismatch");
    }
  } catch {
    issues.push({
      code: "trial_candidate_handoff_reviewer_contract_invalid",
      message: "The reviewer schema, guide, or rubric is missing or does not match the runtime contract."
    });
  }
  try {
    const task = parseLicenseTask(JSON.parse(await fs.readFile(
      path.join(root, PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK),
      "utf8"
    )) as unknown);
    const schema = JSON.parse(await fs.readFile(
      path.join(root, PROMOTION_TRIAL_CANDIDATE_LICENSE_SCHEMA),
      "utf8"
    )) as unknown;
    const guide = await fs.readFile(path.join(root, PROMOTION_TRIAL_CANDIDATE_LICENSE_GUIDE), "utf8");
    if (task.handoff_id !== manifest.handoff_id
        || task.source_url !== manifest.source_url
        || task.source_revision !== manifest.source_revision
        || JSON.stringify(schema) !== JSON.stringify(promotionTrialCandidateLicenseReviewSchema())
        || guide !== promotionTrialCandidateLicenseReviewerGuide()) {
      throw new Error("mismatch");
    }
  } catch {
    issues.push({
      code: "trial_candidate_handoff_license_contract_invalid",
      message: "The source-license task, schema, or guide is missing or does not match the runtime contract."
    });
  }
  const licensePacketInspection = await inspectPromotionTrialCandidateLicensePacket(path.join(root, "license"));
  if (!licensePacketInspection.passed) {
    issues.push(...licensePacketInspection.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      ...(issue.ref ? { ref: `license/${issue.ref}` } : {})
    })));
  } else if (licensePacketInspection.manifest
      && licensePacketInspection.manifest.handoff_id !== manifest.handoff_id) {
    issues.push({
      code: "trial_candidate_handoff_license_packet_identity_mismatch",
      message: "The self-contained source-license packet does not describe the same handoff."
    });
  }
  return { passed: issues.length === 0, manifest, issues };
}

export async function inspectPromotionTrialCandidateReviewerPacket(
  reviewerRootPath: string
): Promise<PromotionTrialCandidateReviewerPacketInspection> {
  const reviewerRoot = path.resolve(reviewerRootPath);
  const issues: PromotionTrialCandidateHandoffIssue[] = [];
  let manifest: PromotionTrialCandidateReviewerPacketManifest;
  try {
    manifest = parseReviewerPacketManifest(JSON.parse(await fs.readFile(
      path.join(reviewerRoot, PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST),
      "utf8"
    )) as unknown);
  } catch {
    return {
      passed: false,
      manifest: null,
      issues: [{
        code: "trial_candidate_reviewer_packet_manifest_unreadable",
        message: "The self-contained reviewer packet manifest is missing or invalid."
      }]
    };
  }

  await inspectPacketInventory(
    reviewerRoot,
    PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST,
    manifest.files,
    "trial_candidate_reviewer_packet",
    issues
  );
  const tasksFile = reviewerPacketPath(PROMOTION_TRIAL_CANDIDATE_TASKS);
  const contractFiles = new Set([
    tasksFile,
    reviewerPacketPath(PROMOTION_TRIAL_CANDIDATE_ANNOTATION_SCHEMA),
    reviewerPacketPath(PROMOTION_TRIAL_CANDIDATE_RESOLUTION_SCHEMA),
    reviewerPacketPath(PROMOTION_TRIAL_CANDIDATE_GUIDE),
    reviewerPacketPath(PROMOTION_TRIAL_CANDIDATE_RUBRIC)
  ]);
  try {
    const tasks = parseReviewerTasks(await fs.readFile(path.join(reviewerRoot, tasksFile), "utf8"));
    const artifactFiles = tasks.flatMap((task) => task.trial_ids.map((trialId) =>
      `${task.artifact_root}/${trialId}/trace.json`));
    const expectedFiles = new Set([...contractFiles, ...artifactFiles]);
    const manifestFiles = new Set(manifest.files.map((item) => item.path));
    if (tasks.length !== manifest.candidate_count
        || artifactFiles.length !== manifest.trial_artifact_count
        || expectedFiles.size !== manifestFiles.size
        || [...expectedFiles].some((item) => !manifestFiles.has(item))) {
      throw new Error("reviewer packet task inventory mismatch");
    }
    for (const artifactPath of artifactFiles) {
      const bytes = await readContainedRegularFile(reviewerRoot, artifactPath);
      JSON.parse(bytes.toString("utf8"));
      assertPromotionArtifactPrivacySafe(artifactPath, bytes);
    }
  } catch {
    issues.push({
      code: "trial_candidate_reviewer_packet_payload_invalid",
      message: "Reviewer tasks and privacy-projected artifacts must be complete, unique, readable, and exactly hash-bound."
    });
  }
  try {
    const schema = JSON.parse(await fs.readFile(path.join(
      reviewerRoot,
      reviewerPacketPath(PROMOTION_TRIAL_CANDIDATE_ANNOTATION_SCHEMA)
    ), "utf8")) as unknown;
    const resolutionSchema = JSON.parse(await fs.readFile(path.join(
      reviewerRoot,
      reviewerPacketPath(PROMOTION_TRIAL_CANDIDATE_RESOLUTION_SCHEMA)
    ), "utf8")) as unknown;
    const guide = await fs.readFile(path.join(
      reviewerRoot,
      reviewerPacketPath(PROMOTION_TRIAL_CANDIDATE_GUIDE)
    ), "utf8");
    const rubric = await fs.readFile(path.join(
      reviewerRoot,
      reviewerPacketPath(PROMOTION_TRIAL_CANDIDATE_RUBRIC)
    ), "utf8");
    if (JSON.stringify(schema) !== JSON.stringify(promotionTrialCandidateAnnotationSchema())
        || JSON.stringify(resolutionSchema) !== JSON.stringify(promotionTrialCandidateResolutionSchema())
        || guide !== promotionTrialCandidateReviewerGuide()
        || rubric !== promotionTrialCandidateReviewRubric()) throw new Error("mismatch");
  } catch {
    issues.push({
      code: "trial_candidate_reviewer_packet_contract_invalid",
      message: "The reviewer schemas, guide, or rubric are missing or do not match the runtime contract."
    });
  }
  return { passed: issues.length === 0, manifest, issues };
}

export async function inspectPromotionTrialCandidateLicensePacket(
  licenseRootPath: string
): Promise<PromotionTrialCandidateLicensePacketInspection> {
  const licenseRoot = path.resolve(licenseRootPath);
  const issues: PromotionTrialCandidateHandoffIssue[] = [];
  let manifest: PromotionTrialCandidateLicensePacketManifest;
  try {
    manifest = parseLicensePacketManifest(JSON.parse(await fs.readFile(
      path.join(licenseRoot, PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST),
      "utf8"
    )) as unknown);
  } catch {
    return {
      passed: false,
      manifest: null,
      issues: [{
        code: "trial_candidate_license_packet_manifest_unreadable",
        message: "The self-contained source-license packet manifest is missing or invalid."
      }]
    };
  }

  await inspectPacketInventory(
    licenseRoot,
    PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST,
    manifest.files,
    "trial_candidate_license_packet",
    issues
  );
  let task: ReturnType<typeof parseLicenseTask> | null = null;
  try {
    task = parseLicenseTask(JSON.parse(await fs.readFile(path.join(
      licenseRoot,
      licensePacketPath(PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK)
    ), "utf8")) as unknown);
    const schema = JSON.parse(await fs.readFile(path.join(
      licenseRoot,
      licensePacketPath(PROMOTION_TRIAL_CANDIDATE_LICENSE_SCHEMA)
    ), "utf8")) as unknown;
    const guide = await fs.readFile(path.join(
      licenseRoot,
      licensePacketPath(PROMOTION_TRIAL_CANDIDATE_LICENSE_GUIDE)
    ), "utf8");
    if (task.handoff_id !== manifest.handoff_id
        || JSON.stringify(schema) !== JSON.stringify(promotionTrialCandidateLicenseReviewSchema())
        || guide !== promotionTrialCandidateLicenseReviewerGuide()) throw new Error("mismatch");
  } catch {
    issues.push({
      code: "trial_candidate_license_packet_contract_invalid",
      message: "The source-license task, schema, or guide is missing or does not match the runtime contract."
    });
  }
  const expectedFiles = new Set([
    licensePacketPath(PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK),
    licensePacketPath(PROMOTION_TRIAL_CANDIDATE_LICENSE_SCHEMA),
    licensePacketPath(PROMOTION_TRIAL_CANDIDATE_LICENSE_GUIDE),
    ...(task?.evidence_files.map((item) => item.path) || [])
  ]);
  const manifestFiles = new Map(manifest.files.map((item) => [item.path, item.sha256]));
  if (expectedFiles.size !== manifestFiles.size
      || [...expectedFiles].some((item) => !manifestFiles.has(item))
      || task?.evidence_files.some((item) => manifestFiles.get(item.path) !== item.sha256)) {
    issues.push({
      code: "trial_candidate_license_packet_scope_invalid",
      message: "The source-license packet may contain only its task-declared evidence, schema, guide, and packet manifest."
    });
  }
  return { passed: issues.length === 0, manifest, issues };
}

function parseRecipe(value: unknown): PromotionTrialCandidateRecipe {
  if (isRecord(value) && Object.keys(value).some((key) => /(?:^|_)root$/u.test(key))) {
    throw new Error("Portable trial-candidate source metadata must not contain machine-local source paths.");
  }
  if (!isRecord(value) || value.schema_version !== "1.1" || !validId(value.handoff_id)
      || !validHttpsUrl(value.source_url) || !sha1String(value.source_revision)
      || value.required_base_count !== MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES
      || value.trials_per_base !== TRIALS_PER_BASE || value.artifact_format !== "json"
      || !nonEmptyString(value.selection_policy)
      || !validSourceEvidenceList(value.license_evidence)
      || (value.materialization_mode !== "git_archive"
        && value.materialization_mode !== "verified_https_blobs"
        && value.materialization_mode !== "huggingface_parquet")) {
    throw new Error("Trial-candidate handoff recipe requires the paper-scale base count, three JSON trials per base, and complete portable source metadata.");
  }
  const common = {
    schema_version: "1.1" as const,
    handoff_id: value.handoff_id,
    source_url: value.source_url,
    source_revision: value.source_revision,
    required_base_count: value.required_base_count,
    trials_per_base: TRIALS_PER_BASE as 3,
    artifact_format: "json" as const,
    selection_policy: value.selection_policy,
    license_evidence: value.license_evidence.map((item: Record<string, any>) => ({
      path: item.path as string,
      sha256: item.sha256 as string
    }))
  };
  if (value.materialization_mode === "huggingface_parquet") {
    const allowedKeys = new Set([
      "schema_version", "handoff_id", "source_url", "source_revision",
      "required_base_count", "trials_per_base", "artifact_format",
      "selection_policy", "materialization_mode", "license_evidence",
      "parquet_sources", "columns", "json_columns", "reviewer_columns",
      "operator_pointer", "family_pointer", "base_pointer", "trial_pointer",
      "credential_projection", "reviewer_identity_redactions"
    ]);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))
        || !validHuggingFaceDatasetUrl(value.source_url)
        || !validParquetSourceList(value.parquet_sources)
        || !validUniqueStringList(value.columns)
        || !validUniqueStringList(value.json_columns)
        || !validUniqueStringList(value.reviewer_columns)
        || !(value.json_columns as string[]).every((column) => (value.columns as string[]).includes(column))
        || !(value.reviewer_columns as string[]).every((column) => (value.columns as string[]).includes(column))
        || !validGroupingPointer(value.operator_pointer, value.columns)
        || !validGroupingPointer(value.family_pointer, value.columns)
        || !validGroupingPointer(value.base_pointer, value.columns)
        || (value.credential_projection !== undefined
          && value.credential_projection !== "redact_values")
        || (value.reviewer_identity_redactions !== undefined
          && !validReviewerIdentityRedactions(value.reviewer_identity_redactions))
        || (value.trial_pointer !== undefined && !validGroupingPointer(value.trial_pointer, value.columns))) {
      throw new Error("Hugging Face Parquet recipes require hash-bound files, explicit columns, reviewer projection, and valid grouping pointers.");
    }
    return {
      ...common,
      materialization_mode: "huggingface_parquet",
      parquet_sources: value.parquet_sources.map((item: Record<string, any>) => ({
        path: item.path as string,
        sha256: item.sha256 as string
      })),
      columns: [...value.columns],
      json_columns: [...value.json_columns],
      reviewer_columns: [...value.reviewer_columns],
      operator_pointer: value.operator_pointer,
      family_pointer: value.family_pointer,
      base_pointer: value.base_pointer,
      ...(value.credential_projection === undefined
        ? {}
        : { credential_projection: value.credential_projection }),
      ...(value.reviewer_identity_redactions === undefined
        ? {}
        : {
            reviewer_identity_redactions: [...value.reviewer_identity_redactions]
              .sort((left, right) => right.length - left.length || left.localeCompare(right))
          }),
      ...(value.trial_pointer === undefined ? {} : { trial_pointer: value.trial_pointer })
    };
  }
  const allowedKeys = new Set([
    "schema_version", "handoff_id", "source_url", "source_revision",
    "path_scope", "path_pattern", "required_base_count", "trials_per_base",
    "artifact_format", "selection_policy", "materialization_mode",
    "artifact_url_template", "license_evidence"
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))
      || !safeRelativePath(value.path_scope)
      || !nonEmptyString(value.path_pattern)) {
    throw new Error("Git trial-candidate recipes require a path scope and an anchored path pattern.");
  }
  try {
    new RegExp(value.path_pattern, "u");
    if (!value.path_pattern.startsWith("^") || !value.path_pattern.endsWith("$")
        || !/\(\?<operator>/.test(value.path_pattern)
        || !/\(\?<family>/.test(value.path_pattern)
        || !/\(\?<base>/.test(value.path_pattern)
        || !/\(\?<trial>/.test(value.path_pattern)) throw new Error("missing named captures");
  } catch {
    throw new Error("Trial-candidate path_pattern must be anchored and include operator, family, base, and trial named captures.");
  }
  const materializationMode = value.materialization_mode;
  if (materializationMode === "verified_https_blobs" && !validArtifactUrlTemplate(value.artifact_url_template)) {
    throw new Error("Verified HTTPS materialization requires an HTTPS artifact_url_template with one {revision} and one {path} placeholder.");
  }
  if (materializationMode === "git_archive" && value.artifact_url_template !== undefined) {
    throw new Error("Git-archive materialization must not declare an artifact_url_template.");
  }
  return {
    ...common,
    path_scope: value.path_scope,
    path_pattern: value.path_pattern,
    materialization_mode: materializationMode,
    ...(materializationMode === "verified_https_blobs"
      ? { artifact_url_template: value.artifact_url_template as string }
      : {})
  };
}

function parseHandoffManifest(value: unknown): PromotionTrialCandidateHandoffManifest {
  if (!isRecord(value) || value.schema_version !== "1.0" || value.status !== "candidate_handoff_ready"
      || !validId(value.handoff_id) || !validHttpsUrl(value.source_url) || !sha1String(value.source_revision)
      || !nonEmptyString(value.selection_policy) || value.selection_pre_content !== true
      || (value.source_materialization !== "git_archive"
        && value.source_materialization !== "verified_https_blobs"
        && value.source_materialization !== "huggingface_parquet")
      || !sha256String(value.recipe_sha256) || !nonNegativeInteger(value.matched_trial_artifact_count)
      || value.source_recipe_path !== PROMOTION_TRIAL_CANDIDATE_SOURCE_RECIPE
      || !nonNegativeInteger(value.empty_blob_exclusion_count) || !nonNegativeInteger(value.duplicate_blob_exclusion_count)
      || !nonNegativeInteger(value.unique_eligible_trial_artifact_count)
      || !Number.isSafeInteger(value.required_base_candidate_count)
      || !Number.isSafeInteger(value.base_candidate_count) || value.trials_per_base !== TRIALS_PER_BASE
      || !Number.isSafeInteger(value.trial_artifact_count) || !Number.isSafeInteger(value.source_family_count)
      || !Number.isSafeInteger(value.operator_group_count) || !unitInterval(value.largest_source_family_share)
      || !unitInterval(value.largest_operator_group_share) || typeof value.paper_scale_trace_floor_met !== "boolean"
      || typeof value.privacy_projection_applied !== "boolean"
      || !nonNegativeInteger(value.privacy_redaction_count)
      || !sha256String(value.reviewer_artifact_tree_sha256)
      || value.controller_map_path !== PROMOTION_TRIAL_CANDIDATE_CONTROLLER_MAP
      || !Array.isArray(value.candidates) || !Array.isArray(value.outputs)
      || value.distribution_scope !== "local_evaluation_only" || value.source_license_status !== "unreviewed"
      || value.confirmatory_admitted !== false || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Invalid trial-candidate handoff manifest.");
  }
  const candidates = value.candidates.map(parsePublicCandidate);
  const outputs = value.outputs.map(parseOutput);
  return {
    schema_version: "1.0",
    handoff_id: value.handoff_id,
    status: "candidate_handoff_ready",
    source_url: value.source_url,
    source_revision: value.source_revision,
    selection_policy: value.selection_policy,
    selection_pre_content: true,
    source_materialization: value.source_materialization,
    recipe_sha256: value.recipe_sha256,
    source_recipe_path: PROMOTION_TRIAL_CANDIDATE_SOURCE_RECIPE,
    matched_trial_artifact_count: value.matched_trial_artifact_count,
    empty_blob_exclusion_count: value.empty_blob_exclusion_count,
    duplicate_blob_exclusion_count: value.duplicate_blob_exclusion_count,
    unique_eligible_trial_artifact_count: value.unique_eligible_trial_artifact_count,
    required_base_candidate_count: value.required_base_candidate_count,
    base_candidate_count: value.base_candidate_count,
    trials_per_base: TRIALS_PER_BASE,
    trial_artifact_count: value.trial_artifact_count,
    source_family_count: value.source_family_count,
    operator_group_count: value.operator_group_count,
    largest_source_family_share: value.largest_source_family_share,
    largest_operator_group_share: value.largest_operator_group_share,
    paper_scale_trace_floor_met: value.paper_scale_trace_floor_met,
    privacy_projection_applied: value.privacy_projection_applied,
    privacy_redaction_count: value.privacy_redaction_count,
    reviewer_artifact_tree_sha256: value.reviewer_artifact_tree_sha256,
    controller_map_path: PROMOTION_TRIAL_CANDIDATE_CONTROLLER_MAP,
    candidates,
    outputs,
    distribution_scope: "local_evaluation_only",
    source_license_status: "unreviewed",
    confirmatory_admitted: false,
    evidence_boundary: value.evidence_boundary
  };
}

function parseReviewerPacketManifest(value: unknown): PromotionTrialCandidateReviewerPacketManifest {
  if (!isRecord(value)
      || Object.keys(value).sort().join("\0") !== [
        "candidate_count",
        "evidence_boundary",
        "files",
        "handoff_id",
        "packet_role",
        "schema_version",
        "trial_artifact_count",
        "trials_per_candidate"
      ].sort().join("\0")
      || value.schema_version !== "1.0"
      || value.packet_role !== "initial_candidate_review"
      || !validId(value.handoff_id)
      || !positiveInteger(value.candidate_count)
      || value.trials_per_candidate !== TRIALS_PER_BASE
      || value.trial_artifact_count !== value.candidate_count * TRIALS_PER_BASE
      || !Array.isArray(value.files)
      || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Invalid trial-candidate reviewer packet manifest.");
  }
  return {
    schema_version: "1.0",
    packet_role: "initial_candidate_review",
    handoff_id: value.handoff_id,
    candidate_count: value.candidate_count,
    trials_per_candidate: TRIALS_PER_BASE,
    trial_artifact_count: value.trial_artifact_count,
    files: parsePacketFiles(value.files, PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST),
    evidence_boundary: value.evidence_boundary
  };
}

function parseLicensePacketManifest(value: unknown): PromotionTrialCandidateLicensePacketManifest {
  if (!isRecord(value)
      || Object.keys(value).sort().join("\0") !== [
        "evidence_boundary",
        "files",
        "handoff_id",
        "packet_role",
        "schema_version",
        "task_count"
      ].sort().join("\0")
      || value.schema_version !== "1.0"
      || value.packet_role !== "source_license_review"
      || !validId(value.handoff_id)
      || value.task_count !== 1
      || !Array.isArray(value.files)
      || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Invalid trial-candidate source-license packet manifest.");
  }
  return {
    schema_version: "1.0",
    packet_role: "source_license_review",
    handoff_id: value.handoff_id,
    task_count: 1,
    files: parsePacketFiles(value.files, PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST),
    evidence_boundary: value.evidence_boundary
  };
}

function parsePacketFiles(
  value: unknown[],
  packetManifestName: string
): Array<{ path: string; sha256: string }> {
  const files = value.map((item, index) => {
    const output = parseOutput(item, index);
    if (output.path === packetManifestName) throw new Error("Packet manifests cannot hash themselves.");
    return output;
  });
  if (files.length === 0 || new Set(files.map((item) => item.path)).size !== files.length) {
    throw new Error("Packet manifest files must be non-empty and unique.");
  }
  return files;
}

function parsePublicCandidate(value: unknown, index: number): PromotionTrialCandidateRecord {
  if (!isRecord(value) || !validId(value.candidate_id) || !sha256String(value.base_candidate_sha256)
      || !sha256String(value.source_family_id_sha256) || !sha256String(value.operator_group_id_sha256)
      || !Array.isArray(value.trials)) {
    throw new Error(`Invalid trial-candidate record at index ${index + 1}.`);
  }
  const trials = value.trials.map((trial, trialIndex) => {
    if (!isRecord(trial) || !validId(trial.trial_id) || !sha256String(trial.source_ref_sha256)
        || !sha256String(trial.source_blob_sha256) || !sha256String(trial.reviewer_blob_sha256)
        || !nonNegativeInteger(trial.privacy_redaction_count) || !safeRelativePath(trial.artifact_path)) {
      throw new Error(`Invalid trial-candidate trial at index ${index + 1}:${trialIndex + 1}.`);
    }
    return {
      trial_id: trial.trial_id,
      source_ref_sha256: trial.source_ref_sha256,
      source_blob_sha256: trial.source_blob_sha256,
      reviewer_blob_sha256: trial.reviewer_blob_sha256,
      privacy_redaction_count: trial.privacy_redaction_count,
      artifact_path: trial.artifact_path
    };
  });
  return {
    candidate_id: value.candidate_id,
    base_candidate_sha256: value.base_candidate_sha256,
    source_family_id_sha256: value.source_family_id_sha256,
    operator_group_id_sha256: value.operator_group_id_sha256,
    trials
  };
}

function parseOutput(value: unknown, index: number): { path: string; sha256: string } {
  if (!isRecord(value) || !safeRelativePath(value.path) || !sha256String(value.sha256)) {
    throw new Error(`Invalid trial-candidate output at index ${index + 1}.`);
  }
  return { path: value.path, sha256: value.sha256 };
}

function parseReviewerTasks(raw: string): Array<{
  candidate_id: string;
  artifact_root: string;
  trial_ids: string[];
}> {
  const tasks = raw.split(/\r?\n/gu).filter(Boolean).map((line, index) => {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.candidate_id)
        || value.artifact_root !== `artifacts/${value.candidate_id}`
        || !Array.isArray(value.trial_ids) || value.trial_ids.length !== TRIALS_PER_BASE
        || new Set(value.trial_ids).size !== TRIALS_PER_BASE || !value.trial_ids.every(validId)
        || !Array.isArray(value.required_observations)
        || value.required_observations.join("\0") !== PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.join("\0")) {
      throw new Error(`Invalid reviewer task at line ${index + 1}.`);
    }
    return {
      candidate_id: value.candidate_id,
      artifact_root: value.artifact_root,
      trial_ids: value.trial_ids as string[]
    };
  });
  if (tasks.length === 0 || new Set(tasks.map((task) => task.candidate_id)).size !== tasks.length) {
    throw new Error("Reviewer tasks must be non-empty and unique.");
  }
  return tasks;
}

function parseLicenseTask(value: unknown): {
  handoff_id: string;
  source_url: string;
  source_revision: string;
  evidence_files: Array<{ path: string; sha256: string }>;
} {
  if (!isRecord(value)
      || Object.keys(value).sort().join("\0") !== [
        "evidence_files",
        "handoff_id",
        "required_decision",
        "schema_version",
        "source_revision",
        "source_url"
      ].join("\0")
      || value.schema_version !== "1.0"
      || !validId(value.handoff_id)
      || !validHttpsUrl(value.source_url)
      || !sha1String(value.source_revision)
      || !validSourceEvidenceList(value.evidence_files)
      || value.required_decision !== "distribution_scope") {
    throw new Error("Invalid trial-candidate source-license task.");
  }
  return {
    handoff_id: value.handoff_id,
    source_url: value.source_url,
    source_revision: value.source_revision,
    evidence_files: value.evidence_files
  };
}

async function assertPinnedGitSource(gitSourceRoot: string, sourceUrl: string, revision: string): Promise<void> {
  const stat = await fs.lstat(gitSourceRoot).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Trial-candidate Git source root must be a regular directory.");
  const origin = (await runProcess("git", ["-C", gitSourceRoot, "remote", "get-url", "origin"]))
    .toString("utf8").trim();
  if (canonicalGitUrl(origin) !== canonicalGitUrl(sourceUrl)) {
    throw new Error("Trial-candidate source_url does not match the repository origin.");
  }
  const resolved = (await runProcess("git", ["-C", gitSourceRoot, "rev-parse", "--verify", `${revision}^{commit}`]))
    .toString("utf8").trim();
  if (resolved !== revision) throw new Error("Trial-candidate source revision did not resolve to the exact declared commit.");
}

async function assertSourceRoot(
  sourceRoot: string,
  recipe: PromotionTrialCandidateRecipe
): Promise<void> {
  const stat = await fs.lstat(sourceRoot).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Trial-candidate source root must be a regular directory.");
  }
  for (const evidence of recipe.license_evidence) {
    await assertHashBoundSourceFile(sourceRoot, evidence.path, evidence.sha256, MAX_SELECTED_ARTIFACT_BYTES);
  }
  if (recipe.materialization_mode !== "huggingface_parquet") {
    await assertPinnedGitSource(sourceRoot, recipe.source_url, recipe.source_revision);
    return;
  }
  for (const source of recipe.parquet_sources) {
    await assertHashBoundSourceFile(sourceRoot, source.path, source.sha256, MAX_PARQUET_SOURCE_BYTES);
  }
}

async function assertHashBoundSourceFile(
  sourceRoot: string,
  relativePath: string,
  expectedSha256: string,
  maximumBytes: number
): Promise<void> {
  const target = resolveContainedFile(sourceRoot, relativePath);
  if (!target || await hasSymbolicLinkComponent(sourceRoot, relativePath)) {
    throw new Error("Hash-bound source file escaped the source root or traversed a symbolic link.");
  }
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error("Hash-bound source file must be a bounded non-empty regular file.");
  }
  if (sha256(await fs.readFile(target)) !== expectedSha256) {
    throw new Error("Hash-bound source file does not match the recipe SHA-256.");
  }
}

function canonicalGitUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return null;
    const pathname = parsed.pathname.replace(/\/+$/u, "").replace(/\.git$/iu, "");
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

async function discoverCandidates(
  sourceRoot: string,
  recipe: PromotionTrialCandidateRecipe
): Promise<CandidateDiscovery> {
  if (recipe.materialization_mode === "huggingface_parquet") {
    return discoverParquetCandidates(sourceRoot, recipe);
  }
  const output = await runProcess("git", [
    "-C", sourceRoot, "ls-tree", "-r", "-z", "--full-tree", recipe.source_revision, "--", recipe.path_scope
  ]);
  const pattern = new RegExp(recipe.path_pattern, "u");
  const candidates: SourceTrialCandidate[] = [];
  let matchedTrialArtifactCount = 0;
  let emptyBlobExclusionCount = 0;
  for (const rawRecord of output.toString("utf8").split("\0")) {
    if (!rawRecord) continue;
    const tabIndex = rawRecord.indexOf("\t");
    if (tabIndex < 0) continue;
    const metadata = rawRecord.slice(0, tabIndex).split(" ");
    const sourcePath = rawRecord.slice(tabIndex + 1);
    if (metadata.length !== 3 || (metadata[0] !== "100644" && metadata[0] !== "100755")
        || metadata[1] !== "blob" || !sha1String(metadata[2])) continue;
    const match = pattern.exec(sourcePath);
    const groups = match?.groups;
    if (!groups || !boundedLabel(groups.operator) || !boundedLabel(groups.family)
        || !boundedLabel(groups.base) || !boundedLabel(groups.trial)) continue;
    matchedTrialArtifactCount += 1;
    if (metadata[2] === EMPTY_GIT_BLOB_SHA1) {
      emptyBlobExclusionCount += 1;
      continue;
    }
    candidates.push({
      source_path: sourcePath,
      source_ref_id: metadata[2],
      source_ref_algorithm: "git_blob_sha1",
      operator_group: groups.operator,
      source_family: groups.family,
      base_group: groups.base,
      trial: groups.trial
    });
  }
  if (candidates.length === 0) throw new Error("Trial-candidate recipe matched no regular Git blobs.");
  return {
    candidates: candidates.sort((left, right) => left.source_path.localeCompare(right.source_path)),
    matchedTrialArtifactCount,
    emptyBlobExclusionCount
  };
}

async function discoverParquetCandidates(
  sourceRoot: string,
  recipe: PromotionTrialCandidateParquetRecipe
): Promise<CandidateDiscovery> {
  const candidates: SourceTrialCandidate[] = [];
  let matchedTrialArtifactCount = 0;
  for (const source of [...recipe.parquet_sources].sort((left, right) => left.path.localeCompare(right.path))) {
    const sourceFile = resolveContainedFile(sourceRoot, source.path);
    if (!sourceFile) throw new Error("Parquet source path escaped the source root.");
    const file = await asyncBufferFromFile(sourceFile);
    const groupingColumns = [...new Set([
      topLevelPointerToken(recipe.operator_pointer),
      topLevelPointerToken(recipe.family_pointer),
      topLevelPointerToken(recipe.base_pointer),
      ...(recipe.trial_pointer ? [topLevelPointerToken(recipe.trial_pointer)] : [])
    ])];
    const rows = await parquetReadObjects({ file, columns: groupingColumns });
    matchedTrialArtifactCount += rows.length;
    for (const [rowIndex, row] of rows.entries()) {
      const decoded = decodeParquetRow(row, recipe.json_columns);
      const operator = groupingLabel(resolveJsonPointer(decoded, recipe.operator_pointer));
      const family = groupingLabel(resolveJsonPointer(decoded, recipe.family_pointer));
      const base = groupingLabel(resolveJsonPointer(decoded, recipe.base_pointer));
      const trial = recipe.trial_pointer
        ? groupingLabel(resolveJsonPointer(decoded, recipe.trial_pointer))
        : String(rowIndex).padStart(10, "0");
      if (!operator || !family || !base || !trial) {
        throw new Error("Parquet grouping pointer did not resolve to a bounded scalar value.");
      }
      const sourcePath = source.path + "#row=" + rowIndex;
      candidates.push({
        source_path: sourcePath,
        source_ref_id: sha256Text(source.sha256 + ":" + rowIndex),
        source_ref_algorithm: "parquet_row_sha256",
        operator_group: operator,
        source_family: family,
        base_group: base,
        trial,
        parquet_path: source.path,
        parquet_sha256: source.sha256,
        row_index: rowIndex
      });
    }
  }
  if (candidates.length === 0) throw new Error("Trial-candidate recipe matched no Parquet rows.");
  return {
    candidates: candidates.sort((left, right) => left.source_path.localeCompare(right.source_path)),
    matchedTrialArtifactCount,
    emptyBlobExclusionCount: 0
  };
}

function selectBalancedBases(candidates: readonly SourceTrialCandidate[], requiredCount: number): CandidateSelection {
  const uniqueCandidates: SourceTrialCandidate[] = [];
  const seenObjects = new Set<string>();
  for (const candidate of candidates) {
    const deduplicationKey = candidate.source_ref_algorithm + ":" + candidate.source_ref_id;
    if (seenObjects.has(deduplicationKey)) continue;
    seenObjects.add(deduplicationKey);
    uniqueCandidates.push(candidate);
  }
  const grouped = new Map<string, SourceTrialCandidate[]>();
  for (const candidate of uniqueCandidates) {
    const key = candidate.operator_group + "\0" + candidate.source_family + "\0" + candidate.base_group;
    const bucket = grouped.get(key) || [];
    bucket.push(candidate);
    grouped.set(key, bucket);
  }
  const pools = [...grouped.entries()].map(([key, trials]) => {
    const [operatorGroup, sourceFamily, baseGroup] = key.split("\0");
    const bases: PlannedBase[] = [];
    const ordered = [...trials].sort((left, right) => left.source_path.localeCompare(right.source_path));
    if (ordered.length >= TRIALS_PER_BASE) {
      const selectedTrials = ordered.slice(0, TRIALS_PER_BASE);
      bases.push({
        operator_group: operatorGroup,
        source_family: sourceFamily,
        base_group: baseGroup,
        identity_sha256: sha256Text([
          operatorGroup,
          sourceFamily,
          baseGroup,
          ...selectedTrials.map((trial) =>
            trial.source_ref_algorithm + ":" + trial.source_ref_id + ":" + trial.source_path)
        ].join("\n")),
        trials: selectedTrials
      });
    }
    return { operatorGroup, sourceFamily, bases };
  }).filter((pool) => pool.bases.length > 0);

  if (new Set(pools.map((pool) => pool.operatorGroup)).size < MINIMUM_PROMOTION_OPERATOR_GROUPS
      || new Set(pools.map((pool) => pool.sourceFamily)).size < MINIMUM_PROMOTION_SOURCE_FAMILIES) {
    throw new Error("Trial candidates require at least three source families and three operator groups before selection.");
  }
  const operatorCounts = new Map<string, number>();
  const familyCounts = new Map<string, number>();
  const selected: PlannedBase[] = [];
  const seenBaseHashes = new Set<string>();
  const maximumGroupCount = Math.floor(requiredCount * MAXIMUM_PROMOTION_GROUP_SHARE);
  while (selected.length < requiredCount) {
    const eligible = pools.filter((pool) => pool.bases.length > 0
      && (operatorCounts.get(pool.operatorGroup) || 0) < maximumGroupCount
      && (familyCounts.get(pool.sourceFamily) || 0) < maximumGroupCount)
      .sort((left, right) =>
        ((operatorCounts.get(left.operatorGroup) || 0) - (operatorCounts.get(right.operatorGroup) || 0))
        || ((familyCounts.get(left.sourceFamily) || 0) - (familyCounts.get(right.sourceFamily) || 0))
        || left.operatorGroup.localeCompare(right.operatorGroup)
        || left.sourceFamily.localeCompare(right.sourceFamily));
    if (eligible.length === 0) break;
    const pool = eligible[0];
    const candidate = pool.bases.shift()!;
    if (seenBaseHashes.has(candidate.identity_sha256)) continue;
    seenBaseHashes.add(candidate.identity_sha256);
    selected.push(candidate);
    operatorCounts.set(candidate.operator_group, (operatorCounts.get(candidate.operator_group) || 0) + 1);
    familyCounts.set(candidate.source_family, (familyCounts.get(candidate.source_family) || 0) + 1);
  }
  if (selected.length !== requiredCount) {
    throw new Error(`Unable to select ${requiredCount} distinct balanced three-trial bases; selected ${selected.length}.`);
  }
  return {
    bases: selected,
    duplicateBlobExclusionCount: candidates.length - uniqueCandidates.length,
    uniqueEligibleTrialArtifactCount: uniqueCandidates.length
  };
}

function summarizeDiversity(bases: readonly PlannedBase[]): {
  sourceFamilyCount: number;
  operatorGroupCount: number;
  largestSourceFamilyShare: number;
  largestOperatorGroupShare: number;
} {
  const families = countLabels(bases.map((base) => base.source_family));
  const operators = countLabels(bases.map((base) => base.operator_group));
  return {
    sourceFamilyCount: families.size,
    operatorGroupCount: operators.size,
    largestSourceFamilyShare: Math.max(...families.values()) / bases.length,
    largestOperatorGroupShare: Math.max(...operators.values()) / bases.length
  };
}

async function materializeSelectedArtifacts(
  sourceRoot: string,
  recipe: PromotionTrialCandidateRecipe,
  trials: readonly SourceTrialCandidate[],
  outputRoot: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const uniquePaths = [...new Set(trials.map((trial) => trial.source_path))].sort();
  if (uniquePaths.length !== trials.length) throw new Error("Selected trial paths must be globally unique.");
  await fs.mkdir(outputRoot, { recursive: true });
  if (recipe.materialization_mode === "verified_https_blobs") {
    await materializeVerifiedHttpsBlobs(recipe, trials, outputRoot, fetchImpl);
    return;
  }
  if (recipe.materialization_mode === "huggingface_parquet") {
    await materializeParquetRows(sourceRoot, recipe, trials, outputRoot);
    return;
  }
  const archivePath = path.join(path.dirname(outputRoot), ".selected-source.tar");
  await runProcess("git", [
    "-C", sourceRoot, "archive", "--format=tar", `--output=${archivePath}`, recipe.source_revision, "--", ...uniquePaths
  ]);
  await runProcess("tar", ["-xf", archivePath, "-C", outputRoot]);
  await fs.rm(archivePath, { force: true });
}

async function materializeVerifiedHttpsBlobs(
  recipe: PromotionTrialCandidateGitRecipe,
  trials: readonly SourceTrialCandidate[],
  outputRoot: string,
  fetchImpl: typeof fetch
): Promise<void> {
  const template = recipe.artifact_url_template!;
  for (let offset = 0; offset < trials.length; offset += FETCH_CONCURRENCY) {
    const batch = trials.slice(offset, offset + FETCH_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (trial) => {
      const url = renderArtifactUrl(template, recipe.source_revision, trial.source_path);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchImpl(url, { signal: controller.signal });
      } catch (error) {
        clearTimeout(timeout);
        throw new Error(`Failed to fetch selected trial artifact: ${trial.source_path} (${error instanceof Error ? error.message : String(error)})`);
      }
      if (!response.ok) {
        clearTimeout(timeout);
        throw new Error(`Selected trial artifact fetch returned HTTP ${response.status}: ${trial.source_path}`);
      }
      let bytes: Buffer;
      try {
        bytes = await readBoundedResponse(response, trial.source_path);
      } catch (error) {
        throw new Error(`Failed to read selected trial artifact: ${trial.source_path} (${error instanceof Error ? error.message : String(error)})`);
      } finally {
        clearTimeout(timeout);
      }
      if (gitBlobSha1(bytes) !== trial.source_ref_id) {
        throw new Error(`Fetched trial artifact does not match its Git object ID: ${trial.source_path}`);
      }
      const target = resolveContainedFile(outputRoot, trial.source_path);
      if (!target) throw new Error(`Selected trial path escaped the materialization root: ${trial.source_path}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes, { flag: "wx" });
    }));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}

async function materializeParquetRows(
  sourceRoot: string,
  recipe: PromotionTrialCandidateParquetRecipe,
  trials: readonly SourceTrialCandidate[],
  outputRoot: string
): Promise<void> {
  const byFile = new Map<string, SourceTrialCandidate[]>();
  for (const trial of trials) {
    if (!trial.parquet_path || trial.parquet_sha256 === undefined || trial.row_index === undefined) {
      throw new Error("Selected Parquet trial is missing its source locator.");
    }
    const bucket = byFile.get(trial.parquet_path) || [];
    bucket.push(trial);
    byFile.set(trial.parquet_path, bucket);
  }
  for (const [parquetPath, fileTrials] of [...byFile.entries()].sort()) {
    const sourceFile = resolveContainedFile(sourceRoot, parquetPath);
    if (!sourceFile) throw new Error("Selected Parquet file escaped the source root.");
    const file = await asyncBufferFromFile(sourceFile);
    const metadata = await parquetMetadataAsync(file);
    for (const trial of [...fileTrials].sort((left, right) => left.row_index! - right.row_index!)) {
      const rows = await parquetReadObjects({
        file,
        metadata,
        columns: recipe.columns,
        rowStart: trial.row_index,
        rowEnd: trial.row_index! + 1
      });
      if (rows.length !== 1) throw new Error("Selected Parquet row could not be materialized exactly once.");
      const decoded = decodeParquetRow(rows[0], recipe.json_columns);
      const unprojectedSourceBytes = canonicalJsonBytes({
        schema_version: "1.0",
        source: {
          parquet_path: trial.parquet_path,
          parquet_sha256: trial.parquet_sha256,
          row_index: trial.row_index
        },
        record: selectColumns(decoded, recipe.columns)
      });
      const unprojectedReviewerBytes = canonicalJsonBytes({
        schema_version: "1.0",
        record: selectColumns(decoded, recipe.reviewer_columns)
      });
      const sourceProjectionOptions = recipe.credential_projection === "redact_values"
        ? { redactCredentialLikeValues: true }
        : {};
      const reviewerProjectionOptions = {
        ...sourceProjectionOptions,
        redactLiterals: recipe.reviewer_identity_redactions || []
      };
      const sourceArtifact = projectPromotionReviewerArtifact(
        trial.source_path,
        unprojectedSourceBytes,
        sourceProjectionOptions
      );
      const reviewerArtifact = projectPromotionReviewerArtifact(
        trial.source_path,
        unprojectedReviewerBytes,
        reviewerProjectionOptions
      );
      const sourceBytes = sourceArtifact.bytes;
      const reviewerBytes = reviewerArtifact.bytes;
      if (sourceBytes.length > MAX_SELECTED_ARTIFACT_BYTES || reviewerBytes.length > MAX_SELECTED_ARTIFACT_BYTES) {
        throw new Error("Selected Parquet row exceeds the bounded artifact size.");
      }
      trial.source_ref_id = sha256(sourceBytes);
      trial.reviewer_privacy_redaction_count = reviewerArtifact.privacy_redaction_count;
      const paths = parquetMaterializedPaths(trial);
      const sourceTarget = resolveContainedFile(outputRoot, paths.source);
      const reviewerTarget = resolveContainedFile(outputRoot, paths.reviewer);
      if (!sourceTarget || !reviewerTarget) throw new Error("Parquet row materialization path escaped its root.");
      await fs.mkdir(path.dirname(sourceTarget), { recursive: true });
      await fs.writeFile(sourceTarget, sourceBytes, { flag: "wx" });
      await fs.writeFile(reviewerTarget, reviewerBytes, { flag: "wx" });
    }
  }
}

async function readMaterializedTrial(
  sourceArchiveRoot: string,
  trial: SourceTrialCandidate
): Promise<{ sourceBytes: Buffer; reviewerInputBytes: Buffer }> {
  const paths = trial.source_ref_algorithm === "parquet_row_sha256"
    ? parquetMaterializedPaths(trial)
    : { source: trial.source_path, reviewer: trial.source_path };
  const sourceFile = resolveContainedFile(sourceArchiveRoot, paths.source);
  const reviewerFile = resolveContainedFile(sourceArchiveRoot, paths.reviewer);
  if (!sourceFile || !reviewerFile) throw new Error("Selected trial escaped the source archive.");
  const sourceStat = await fs.lstat(sourceFile);
  const reviewerStat = await fs.lstat(reviewerFile);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size <= 0
      || sourceStat.size > MAX_SELECTED_ARTIFACT_BYTES
      || !reviewerStat.isFile() || reviewerStat.isSymbolicLink() || reviewerStat.size <= 0
      || reviewerStat.size > MAX_SELECTED_ARTIFACT_BYTES) {
    throw new Error("Selected trial artifact must be a bounded non-empty regular file.");
  }
  const sourceBytes = await fs.readFile(sourceFile);
  const reviewerInputBytes = paths.source === paths.reviewer
    ? sourceBytes
    : await fs.readFile(reviewerFile);
  const observedRef = trial.source_ref_algorithm === "git_blob_sha1"
    ? gitBlobSha1(sourceBytes)
    : sha256(sourceBytes);
  if (observedRef !== trial.source_ref_id) {
    throw new Error("Selected trial artifact does not match its source reference.");
  }
  return { sourceBytes, reviewerInputBytes };
}

function parquetMaterializedPaths(
  trial: SourceTrialCandidate
): { source: string; reviewer: string } {
  const identity = sha256Text(trial.source_path);
  return {
    source: "parquet-rows/" + identity + "/source.json",
    reviewer: "parquet-rows/" + identity + "/reviewer.json"
  };
}

function licenseEvidencePacketEntries(
  recipe: PromotionTrialCandidateRecipe
): Array<{ path: string; sha256: string }> {
  return recipe.license_evidence.map((evidence, index) => ({
    path: "source-evidence/" + String(index + 1).padStart(2, "0") + "-" + path.basename(evidence.path),
    sha256: evidence.sha256
  }));
}

function decodeParquetRow(
  row: Record<string, any>,
  jsonColumns: readonly string[]
): Record<string, any> {
  const decoded: Record<string, any> = { ...row };
  for (const column of jsonColumns) {
    if (!(column in decoded)) continue;
    if (typeof decoded[column] !== "string") {
      throw new Error("Configured Parquet JSON column is not a string.");
    }
    let value: unknown = decoded[column];
    for (let depth = 0; depth < 2 && typeof value === "string"; depth += 1) {
      try {
        value = JSON.parse(value);
      } catch {
        throw new Error("Configured Parquet JSON column contains invalid JSON.");
      }
    }
    decoded[column] = value;
  }
  return decoded;
}

function resolveJsonPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, any>)[token];
  }
  return current;
}

function topLevelPointerToken(pointer: string): string {
  return pointer.slice(1).split("/")[0].replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function groupingLabel(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (!boundedLabel(value)) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function selectColumns(
  row: Record<string, any>,
  columns: readonly string[]
): Record<string, any> {
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function readBoundedResponse(response: Response, sourcePath: string): Promise<Buffer> {
  if (!response.body) throw new Error(`Selected trial artifact response has no body: ${sourcePath}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SELECTED_ARTIFACT_BYTES) {
    throw new Error(`Selected trial artifact exceeds the byte limit: ${sourcePath}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_SELECTED_ARTIFACT_BYTES) {
      await reader.cancel();
      throw new Error(`Selected trial artifact exceeds the byte limit: ${sourcePath}`);
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function renderArtifactUrl(template: string, revision: string, sourcePath: string): string {
  const encodedPath = sourcePath.split("/").map((part) => encodeURIComponent(part)).join("/");
  const rendered = template.replace("{revision}", encodeURIComponent(revision)).replace("{path}", encodedPath);
  const parsed = new URL(rendered);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error("Rendered artifact URL must be credential-free HTTPS without a fragment.");
  }
  return parsed.toString();
}

async function inventoryOutputs(root: string): Promise<Array<{ path: string; sha256: string }>> {
  const paths = await listRegularFiles(root);
  return Promise.all(paths.sort().map(async (relativePath) => ({
    path: relativePath,
    sha256: sha256(await fs.readFile(path.join(root, relativePath)))
  })));
}

async function inspectPacketInventory(
  packetRoot: string,
  packetManifestName: string,
  files: Array<{ path: string; sha256: string }>,
  codePrefix: string,
  issues: PromotionTrialCandidateHandoffIssue[]
): Promise<void> {
  const expected = new Set([packetManifestName, ...files.map((item) => item.path)]);
  let observed: string[];
  try {
    observed = await listRegularFiles(packetRoot);
  } catch {
    issues.push({
      code: `${codePrefix}_inventory_invalid`,
      message: "The packet contains an unreadable, symbolic-link, or non-regular filesystem entry."
    });
    return;
  }
  for (const relativePath of observed) {
    if (!expected.has(relativePath)) {
      issues.push({
        code: `${codePrefix}_untracked_file`,
        message: "The packet contains a file that is not bound by its own manifest.",
        ref: relativePath
      });
    }
  }
  for (const relativePath of expected) {
    if (!observed.includes(relativePath)) {
      issues.push({
        code: `${codePrefix}_file_missing`,
        message: "A packet-manifest-bound file is missing.",
        ref: relativePath
      });
    }
  }
  for (const file of files) {
    const observedHash = await hashContainedRegularFile(packetRoot, file.path).catch(() => null);
    if (observedHash !== file.sha256) {
      issues.push({
        code: `${codePrefix}_hash_mismatch`,
        message: "A packet file no longer matches its recorded hash.",
        ref: file.path
      });
    }
  }
}

function reviewerPacketPath(fullPath: string): string {
  if (!fullPath.startsWith("reviewer/")) throw new Error("Reviewer contract path must use the reviewer prefix.");
  return fullPath.slice("reviewer/".length);
}

function licensePacketPath(fullPath: string): string {
  if (!fullPath.startsWith("license/")) throw new Error("License contract path must use the license prefix.");
  return fullPath.slice("license/".length);
}

async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const relativePath = path.relative(root, target).replace(/\\/gu, "/");
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in trial-candidate handoffs: ${relativePath}`);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`Unsupported filesystem entry in trial-candidate handoff: ${relativePath}`);
    }
  }
  await visit(root);
  return files;
}

async function hashContainedRegularFile(root: string, relativePath: string): Promise<string> {
  return sha256(await readContainedRegularFile(root, relativePath));
}

async function readContainedRegularFile(root: string, relativePath: string): Promise<Buffer> {
  const target = resolveContainedFile(root, relativePath);
  if (!target || await hasSymbolicLinkComponent(root, relativePath)) throw new Error("Invalid contained handoff file path.");
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Handoff output must be a regular file.");
  return fs.readFile(target);
}

async function hasSymbolicLinkComponent(root: string, relativePath: string): Promise<boolean> {
  let current = root;
  for (const part of relativePath.split("/")) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}

async function runProcess(command: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(command, [...args], { detached, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      killProcessTree(child.pid, detached);
      settled = true;
      reject(new Error(`${command} exceeded the bounded process timeout.`));
    }, PROCESS_TIMEOUT_MS);
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES && !settled) {
        killProcessTree(child.pid, detached);
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`${command} exceeded the bounded output limit.`));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`${command} failed (${code}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

function killProcessTree(pid: number | undefined, detached: boolean): void {
  if (!pid) return;
  try {
    if (detached) process.kill(-pid, "SIGKILL");
    else process.kill(pid, "SIGKILL");
  } catch {
    // The process may have exited between the guard and the signal.
  }
}

function countLabels(labels: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
  return counts;
}

function resolveContainedFile(root: string, relativePath: string): string | null {
  if (!safeRelativePath(relativePath)) return null;
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  return target.startsWith(`${resolvedRoot}${path.sep}`) ? target : null;
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function boundedLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
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

function validHuggingFaceDatasetUrl(value: unknown): value is string {
  if (!validHttpsUrl(value)) return false;
  const parsed = new URL(value);
  return parsed.hostname.toLowerCase() === "huggingface.co"
    && /^\/datasets\/[^/]+\/[^/]+\/?$/u.test(parsed.pathname)
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && !parsed.hash;
}

function validSourceEvidenceList(
  value: unknown
): value is Array<{ path: string; sha256: string }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return false;
  const paths = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)
        || Object.keys(item).sort().join("\0") !== "path\0sha256"
        || !safeRelativePath(item.path)
        || !sha256String(item.sha256)
        || paths.has(item.path)) return false;
    paths.add(item.path);
  }
  return true;
}

function validParquetSourceList(
  value: unknown
): value is Array<{ path: string; sha256: string }> {
  return validSourceEvidenceList(value)
    && value.every((item) => item.path.toLowerCase().endsWith(".parquet"));
}

function validUniqueStringList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 64
    && value.every((item) =>
      typeof item === "string" && item.length > 0 && item.length <= 128 && !item.includes("\0"))
    && new Set(value).size === value.length;
}

function validReviewerIdentityRedactions(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 32
    && value.every((item) =>
      typeof item === "string"
      && item.trim() === item
      && item.length >= 8
      && item.length <= 512
      && !item.includes("\0")
      && item !== "<reviewer-identity>")
    && new Set(value).size === value.length;
}

function validGroupingPointer(pointer: unknown, columns: unknown): pointer is string {
  if (typeof pointer !== "string"
      || !/^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/u.test(pointer)
      || !validUniqueStringList(columns)) return false;
  return columns.includes(topLevelPointerToken(pointer));
}

function validArtifactUrlTemplate(value: unknown): value is string {
  if (typeof value !== "string"
      || value.split("{revision}").length !== 2
      || value.split("{path}").length !== 2) return false;
  try {
    const rendered = value.replace("{revision}", "a".repeat(40)).replace("{path}", "records/trace.json");
    const parsed = new URL(rendered);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
}

function sha1String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function unitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

function sha256Text(value: string): string {
  return sha256(Buffer.from(value, "utf8"));
}

function gitBlobSha1(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}
