import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonFile } from "../../utils/fs.js";
import {
  PROMOTION_CANONICAL_ARTIFACT_PATHS,
  PROMOTION_CANONICAL_CURATION_RECORD,
  PROMOTION_CANONICAL_CURATION_SCHEMA_VERSION,
  type PromotionCanonicalArtifactRole
} from "./promotionBenchmarkCanonicalCuration.js";
import {
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES
} from "./promotionBenchmarkConfirmatoryContract.js";
import {
  PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST,
  inspectPromotionTrialCandidateHandoff,
  type PromotionTrialCandidateRecord
} from "./promotionBenchmarkTrialCandidateHandoff.js";
import {
  PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS,
  PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT,
  PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE,
  loadPromotionTrialCandidateReviewAdmissionEvidence
} from "./promotionBenchmarkTrialCandidateReview.js";
import { isSha256 } from "./promotionBenchmarkSourceDiversity.js";

export const PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST =
  "canonical-curation-handoff.json";
export const PROMOTION_CANONICAL_CURATION_TASKS =
  "curator/curation-tasks.jsonl";
export const PROMOTION_CANONICAL_CURATION_CONTRACT =
  "contract/canonical-curation-contract.json";
export const PROMOTION_CANONICAL_CURATOR_GUIDE =
  "curator/CURATOR_GUIDE.md";
export const PROMOTION_CANONICAL_VERIFIER_GUIDE =
  "verifier/VERIFIER_GUIDE.md";

const UPSTREAM_HANDOFF_MANIFEST =
  "upstream/handoff/trial-candidate-handoff.json";
const UPSTREAM_REVIEW_REPORT =
  "upstream/review/trial-candidate-review-adjudication.json";
const UPSTREAM_REVIEW_LABELS =
  "upstream/review/adjudicated-candidate-labels.jsonl";
const UPSTREAM_REVIEW_EVIDENCE =
  "upstream/review/trial-candidate-review-evidence.json";

export interface PreparePromotionCanonicalCurationHandoffInput {
  cwd: string;
  handoffRoot: string;
  reviewRoot: string;
  curatorId: string;
  verifierId: string;
  curatorProtocolVersion: string;
  verifierProtocolVersion: string;
  outDir: string;
}

export interface PreparePromotionCanonicalCurationHandoffResult {
  handoff_id: string;
  task_count: number;
  output_dir: string;
  manifest_path: string;
  curator_guide_path: string;
  verifier_guide_path: string;
  canonical_source_count: 0;
  canonical_curation_completed: false;
}

export interface PromotionCanonicalCurationHandoffIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionCanonicalCurationHandoffInspection {
  passed: boolean;
  manifest: PromotionCanonicalCurationHandoffManifest | null;
  issues: PromotionCanonicalCurationHandoffIssue[];
}

export interface PromotionCanonicalCurationTask {
  schema_version: "1.0";
  handoff_id: string;
  source_revision: string;
  candidate_id: string;
  base_candidate_sha256: string;
  source_family_id_sha256: string;
  operator_group_id_sha256: string;
  comparator_operator_group_id_sha256: string;
  source_trials: Array<{
    group_id: "group-a" | "group-b";
    trial_id: string;
    source_ref_sha256: string;
    source_blob_sha256: string;
    reviewer_blob_sha256: string;
    artifact_path: string;
  }>;
  required_artifacts: Array<{
    role: PromotionCanonicalArtifactRole;
    path: string;
  }>;
  curator_id: string;
  verifier_id: string;
  curator_protocol_version: string;
  verifier_protocol_version: string;
  status: "pending_human_curation";
  canonical_source_root: null;
  derivation_mode: null;
  curated_at: null;
  verified_at: null;
  curator_attestation: {
    completed_by_human: false;
  };
  verifier_attestation: {
    completed_by_human: false;
    curator_output_independently_checked: false;
  };
  evidence_boundary: string;
}

export interface PromotionCanonicalCurationHandoffManifest {
  schema_version: "1.0";
  handoff_id: string;
  source_revision: string;
  status: "human_curation_pending";
  curator_id: string;
  verifier_id: string;
  curator_protocol_version: string;
  verifier_protocol_version: string;
  source_license_status: "redistribution_permitted";
  source_eligible_candidate_count: number;
  task_count: number;
  source_trials_per_task: 6;
  required_artifact_count: number;
  canonical_source_count: 0;
  curation_completed_count: 0;
  verification_completed_count: 0;
  canonical_curation_completed: false;
  confirmatory_admitted: false;
  upstream: {
    handoff_manifest_path: typeof UPSTREAM_HANDOFF_MANIFEST;
    handoff_manifest_sha256: string;
    review_report_path: typeof UPSTREAM_REVIEW_REPORT;
    review_report_sha256: string;
    review_labels_path: typeof UPSTREAM_REVIEW_LABELS;
    review_labels_sha256: string;
    review_evidence_path: typeof UPSTREAM_REVIEW_EVIDENCE;
    review_evidence_sha256: string;
  };
  files: Array<{ path: string; sha256: string }>;
  evidence_boundary: string;
}

export async function preparePromotionCanonicalCurationHandoff(
  input: PreparePromotionCanonicalCurationHandoffInput
): Promise<PreparePromotionCanonicalCurationHandoffResult> {
  const cwd = path.resolve(input.cwd);
  const handoffRoot = path.resolve(cwd, input.handoffRoot);
  const reviewRoot = path.resolve(cwd, input.reviewRoot);
  const outDir = path.resolve(cwd, input.outDir);
  validateOperatorInput(input);
  assertStrictlyInside(cwd, outDir, "Canonical curation handoff output");
  if (isSameOrContainedPath(handoffRoot, outDir)
      || isSameOrContainedPath(reviewRoot, outDir)) {
    throw new Error("Canonical curation handoff output must stay outside upstream evidence roots.");
  }
  if (await pathExists(outDir)) {
    throw new Error("Canonical curation handoff output already exists.");
  }

  const handoff = await inspectPromotionTrialCandidateHandoff(handoffRoot);
  if (!handoff.passed || !handoff.manifest) {
    throw new Error(`Canonical curation requires an integrity-valid candidate handoff: ${handoff.issues.map((issue) => issue.code).join(", ") || "unreadable"}.`);
  }
  const review = await loadPromotionTrialCandidateReviewAdmissionEvidence(reviewRoot);
  if (review.handoff_id !== handoff.manifest.handoff_id
      || review.source_revision !== handoff.manifest.source_revision) {
    throw new Error("Canonical curation requires revision-matched handoff and review evidence.");
  }
  if (review.source_license_status !== "redistribution_permitted"
      || !review.candidate_review_progression_floor_met
      || review.source_eligible_candidate_ids.length
        < MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES) {
    throw new Error("Canonical curation requires redistribution permission and the paper-scale source-eligible review floor.");
  }
  const candidateById = new Map(handoff.manifest.candidates.map((candidate) => [
    candidate.candidate_id,
    candidate
  ]));
  const candidates = review.source_eligible_candidate_ids.map((candidateId) => {
    const candidate = candidateById.get(candidateId);
    if (!candidate) {
      throw new Error("Canonical curation review evidence references an unknown candidate.");
    }
    if (!candidate.comparator_operator_group_id_sha256
        || candidate.trials.length !== 3
        || candidate.comparator_trials?.length !== 3) {
      throw new Error("Canonical curation requires three primary and three comparator trials per task.");
    }
    return candidate;
  }).sort((left, right) => left.candidate_id.localeCompare(right.candidate_id));

  const stagingRoot = path.join(
    path.dirname(outDir),
    `.${path.basename(outDir)}.staging-${randomUUID()}`
  );
  await fs.mkdir(stagingRoot, { recursive: true });
  try {
    const contract = promotionCanonicalCurationHandoffContract();
    await writeJsonFile(path.join(stagingRoot, PROMOTION_CANONICAL_CURATION_CONTRACT), contract);
    await fs.mkdir(path.join(stagingRoot, "curator"), { recursive: true });
    await fs.mkdir(path.join(stagingRoot, "verifier"), { recursive: true });
    await fs.writeFile(
      path.join(stagingRoot, PROMOTION_CANONICAL_CURATOR_GUIDE),
      promotionCanonicalCuratorGuide(),
      "utf8"
    );
    await fs.writeFile(
      path.join(stagingRoot, PROMOTION_CANONICAL_VERIFIER_GUIDE),
      promotionCanonicalVerifierGuide(),
      "utf8"
    );

    const tasks: PromotionCanonicalCurationTask[] = [];
    for (const candidate of candidates) {
      await copyCandidateReviewerArtifacts(handoffRoot, stagingRoot, candidate);
      tasks.push(canonicalCurationTask(input, handoff.manifest, candidate));
    }
    await fs.writeFile(
      path.join(stagingRoot, PROMOTION_CANONICAL_CURATION_TASKS),
      tasks.map((task) => JSON.stringify(task)).join("\n") + "\n",
      "utf8"
    );

    const upstream = await copyUpstreamEvidence(handoffRoot, reviewRoot, stagingRoot);
    if (upstream.review_labels_sha256 !== review.labels_sha256
        || upstream.review_evidence_sha256 !== review.evidence_sha256) {
      throw new Error("Canonical curation upstream review hashes changed during preparation.");
    }
    const files = await inventoryRegularFiles(stagingRoot);
    const manifest: PromotionCanonicalCurationHandoffManifest = {
      schema_version: "1.0",
      handoff_id: handoff.manifest.handoff_id,
      source_revision: handoff.manifest.source_revision,
      status: "human_curation_pending",
      curator_id: input.curatorId,
      verifier_id: input.verifierId,
      curator_protocol_version: input.curatorProtocolVersion,
      verifier_protocol_version: input.verifierProtocolVersion,
      source_license_status: "redistribution_permitted",
      source_eligible_candidate_count: candidates.length,
      task_count: tasks.length,
      source_trials_per_task: 6,
      required_artifact_count: Object.keys(PROMOTION_CANONICAL_ARTIFACT_PATHS).length,
      canonical_source_count: 0,
      curation_completed_count: 0,
      verification_completed_count: 0,
      canonical_curation_completed: false,
      confirmatory_admitted: false,
      upstream,
      files,
      evidence_boundary: "This packet prepares source-eligible tasks for later human canonical curation and independent verification. All completion attestations are false, no canonical source or benchmark-curation record is created, and no task is admitted to the confirmatory corpus."
    };
    await writeJsonFile(
      path.join(stagingRoot, PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST),
      manifest
    );
    const inspection = await inspectPromotionCanonicalCurationHandoff(stagingRoot);
    if (!inspection.passed) {
      throw new Error(`Canonical curation handoff failed self-inspection: ${inspection.issues.map((issue) => issue.code).join(", ")}.`);
    }
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    handoff_id: handoff.manifest.handoff_id,
    task_count: candidates.length,
    output_dir: portableRef(cwd, outDir),
    manifest_path: portableRef(cwd, path.join(outDir, PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST)),
    curator_guide_path: portableRef(cwd, path.join(outDir, PROMOTION_CANONICAL_CURATOR_GUIDE)),
    verifier_guide_path: portableRef(cwd, path.join(outDir, PROMOTION_CANONICAL_VERIFIER_GUIDE)),
    canonical_source_count: 0,
    canonical_curation_completed: false
  };
}

export async function inspectPromotionCanonicalCurationHandoff(
  rootPath: string
): Promise<PromotionCanonicalCurationHandoffInspection> {
  const root = path.resolve(rootPath);
  const issues: PromotionCanonicalCurationHandoffIssue[] = [];
  let manifest: PromotionCanonicalCurationHandoffManifest;
  try {
    manifest = parseHandoffManifest(JSON.parse(await fs.readFile(
      path.join(root, PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST),
      "utf8"
    )) as unknown);
  } catch {
    return {
      passed: false,
      manifest: null,
      issues: [{
        code: "canonical_curation_handoff_manifest_unreadable",
        message: "The canonical curation handoff manifest is missing or invalid."
      }]
    };
  }

  const observedFiles = await inventoryRegularFiles(root).catch(() => null);
  if (!observedFiles
      || JSON.stringify(observedFiles) !== JSON.stringify(manifest.files)) {
    issues.push({
      code: "canonical_curation_handoff_file_inventory_invalid",
      message: "The canonical curation handoff file inventory changed."
    });
  }
  try {
    const contract = JSON.parse(await fs.readFile(
      path.join(root, PROMOTION_CANONICAL_CURATION_CONTRACT),
      "utf8"
    )) as unknown;
    if (JSON.stringify(contract) !== JSON.stringify(promotionCanonicalCurationHandoffContract())) {
      throw new Error("contract mismatch");
    }
  } catch {
    issues.push({
      code: "canonical_curation_handoff_contract_invalid",
      message: "The canonical curation runtime contract is missing or changed."
    });
  }
  try {
    if (await fs.readFile(path.join(root, PROMOTION_CANONICAL_CURATOR_GUIDE), "utf8")
          !== promotionCanonicalCuratorGuide()
        || await fs.readFile(path.join(root, PROMOTION_CANONICAL_VERIFIER_GUIDE), "utf8")
          !== promotionCanonicalVerifierGuide()) {
      throw new Error("guide mismatch");
    }
  } catch {
    issues.push({
      code: "canonical_curation_handoff_guide_invalid",
      message: "The curator or verifier guide is missing or changed."
    });
  }

  let tasks: PromotionCanonicalCurationTask[] = [];
  try {
    tasks = parseTasks(await fs.readFile(
      path.join(root, PROMOTION_CANONICAL_CURATION_TASKS),
      "utf8"
    ));
    if (tasks.length !== manifest.task_count
        || tasks.length !== manifest.source_eligible_candidate_count
        || new Set(tasks.map((task) => task.candidate_id)).size !== tasks.length
        || new Set(tasks.map((task) => task.base_candidate_sha256)).size !== tasks.length) {
      throw new Error("task inventory mismatch");
    }
    for (const task of tasks) {
      if (task.handoff_id !== manifest.handoff_id
          || task.source_revision !== manifest.source_revision
          || task.curator_id !== manifest.curator_id
          || task.verifier_id !== manifest.verifier_id
          || task.curator_protocol_version !== manifest.curator_protocol_version
          || task.verifier_protocol_version !== manifest.verifier_protocol_version) {
        throw new Error("task authority mismatch");
      }
      for (const trial of task.source_trials) {
        const artifactPath = path.join(root, "curator", trial.artifact_path);
        const bytes = await readContainedRegularFile(path.join(root, "curator"), artifactPath);
        if (sha256(bytes) !== trial.reviewer_blob_sha256) {
          throw new Error("task artifact hash mismatch");
        }
      }
    }
  } catch {
    issues.push({
      code: "canonical_curation_handoff_tasks_invalid",
      message: "Pending curation tasks or their six-trial artifacts are missing, changed, or semantically inconsistent."
    });
  }
  if (tasks.length > 0) {
    const expectedFiles = new Set([
      PROMOTION_CANONICAL_CURATION_TASKS,
      PROMOTION_CANONICAL_CURATION_CONTRACT,
      PROMOTION_CANONICAL_CURATOR_GUIDE,
      PROMOTION_CANONICAL_VERIFIER_GUIDE,
      UPSTREAM_HANDOFF_MANIFEST,
      UPSTREAM_REVIEW_REPORT,
      UPSTREAM_REVIEW_LABELS,
      UPSTREAM_REVIEW_EVIDENCE,
      ...tasks.flatMap((task) => task.source_trials.map((trial) =>
        `curator/${trial.artifact_path}`))
    ]);
    const manifestFiles = new Set(manifest.files.map((file) => file.path));
    if (expectedFiles.size !== manifestFiles.size
        || [...expectedFiles].some((file) => !manifestFiles.has(file))) {
      issues.push({
        code: "canonical_curation_handoff_file_contract_invalid",
        message: "The handoff may contain only the exact task, trace, guide, contract, and upstream receipt files."
      });
    }
  }
  if (manifest.canonical_source_count !== 0
      || manifest.curation_completed_count !== 0
      || manifest.verification_completed_count !== 0
      || manifest.canonical_curation_completed
      || manifest.confirmatory_admitted
      || manifest.status !== "human_curation_pending") {
    issues.push({
      code: "canonical_curation_handoff_false_completion",
      message: "A preparation handoff must not claim curation, verification, or confirmatory admission."
    });
  }
  if (manifest.files.some((file) =>
    path.posix.basename(file.path) === PROMOTION_CANONICAL_CURATION_RECORD)) {
    issues.push({
      code: "canonical_curation_handoff_final_record_present",
      message: "Preparation must not create a final benchmark-curation record."
    });
  }
  for (const [ref, expectedHash] of upstreamHashEntries(manifest)) {
    try {
      if (sha256(await readContainedRegularFile(root, path.join(root, ref))) !== expectedHash) {
        throw new Error("hash mismatch");
      }
    } catch {
      issues.push({
        code: "canonical_curation_handoff_upstream_evidence_invalid",
        message: "Hash-bound upstream handoff or human-review evidence changed.",
        ref
      });
    }
  }
  try {
    const review = await loadPromotionTrialCandidateReviewAdmissionEvidence(
      path.join(root, "upstream", "review")
    );
    const taskIds = tasks.map((task) => task.candidate_id).sort();
    if (review.handoff_id !== manifest.handoff_id
        || review.source_revision !== manifest.source_revision
        || review.source_license_status !== "redistribution_permitted"
        || !review.candidate_review_progression_floor_met
        || review.labels_sha256 !== manifest.upstream.review_labels_sha256
        || review.evidence_sha256 !== manifest.upstream.review_evidence_sha256
        || JSON.stringify(review.source_eligible_candidate_ids.sort())
          !== JSON.stringify(taskIds)) {
      throw new Error("review mismatch");
    }
  } catch {
    issues.push({
      code: "canonical_curation_handoff_upstream_review_invalid",
      message: "Copied review evidence must independently recover the exact source-eligible task set."
    });
  }
  try {
    const upstreamHandoff = JSON.parse(await fs.readFile(
      path.join(root, UPSTREAM_HANDOFF_MANIFEST),
      "utf8"
    )) as unknown;
    if (!upstreamHandoffMatchesTasks(upstreamHandoff, manifest, tasks)) {
      throw new Error("handoff mismatch");
    }
  } catch {
    issues.push({
      code: "canonical_curation_handoff_upstream_handoff_invalid",
      message: "Copied handoff evidence must bind every pending task to the same six source trials."
    });
  }
  return { passed: issues.length === 0, manifest, issues };
}

export function promotionCanonicalCurationHandoffContract(): Record<string, unknown> {
  return {
    schema_version: "1.0",
    final_record_path: PROMOTION_CANONICAL_CURATION_RECORD,
    final_record_schema_version: PROMOTION_CANONICAL_CURATION_SCHEMA_VERSION,
    required_source_trials: {
      group_count: 2,
      trials_per_group: 3,
      total: 6
    },
    required_artifacts: canonicalArtifactRequirements(),
    final_record_authority: {
      curation_status: "human_verified",
      distinct_curator_and_verifier_required: true,
      curator_and_verifier_timestamps_required: true,
      artifact_hashes_required: true,
      semantic_cross_check_required: true
    },
    preparation_boundary: {
      creates_canonical_sources: false,
      creates_final_record: false,
      human_curation_completed: false,
      human_verification_completed: false,
      confirmatory_admitted: false
    }
  };
}

function canonicalCurationTask(
  input: PreparePromotionCanonicalCurationHandoffInput,
  manifest: { handoff_id: string; source_revision: string },
  candidate: PromotionTrialCandidateRecord
): PromotionCanonicalCurationTask {
  const sourceTrials = [
    ...candidate.trials.map((trial) => ({ group_id: "group-a" as const, ...trial })),
    ...(candidate.comparator_trials || []).map((trial) => ({
      group_id: "group-b" as const,
      ...trial
    }))
  ].map((trial) => ({
    group_id: trial.group_id,
    trial_id: trial.trial_id,
    source_ref_sha256: trial.source_ref_sha256,
    source_blob_sha256: trial.source_blob_sha256,
    reviewer_blob_sha256: trial.reviewer_blob_sha256,
    artifact_path: trial.artifact_path
  }));
  return {
    schema_version: "1.0",
    handoff_id: manifest.handoff_id,
    source_revision: manifest.source_revision,
    candidate_id: candidate.candidate_id,
    base_candidate_sha256: candidate.base_candidate_sha256,
    source_family_id_sha256: candidate.source_family_id_sha256,
    operator_group_id_sha256: candidate.operator_group_id_sha256,
    comparator_operator_group_id_sha256: candidate.comparator_operator_group_id_sha256 as string,
    source_trials: sourceTrials,
    required_artifacts: canonicalArtifactRequirements(),
    curator_id: input.curatorId,
    verifier_id: input.verifierId,
    curator_protocol_version: input.curatorProtocolVersion,
    verifier_protocol_version: input.verifierProtocolVersion,
    status: "pending_human_curation",
    canonical_source_root: null,
    derivation_mode: null,
    curated_at: null,
    verified_at: null,
    curator_attestation: { completed_by_human: false },
    verifier_attestation: {
      completed_by_human: false,
      curator_output_independently_checked: false
    },
    evidence_boundary: "This task binds source-eligible traces and the final artifact contract only. Empty fields and false attestations must be completed by real human curation and independent verification; this task is not canonical evidence."
  };
}

function parseTasks(text: string): PromotionCanonicalCurationTask[] {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim());
  return lines.map((line) => parseTask(JSON.parse(line) as unknown));
}

function parseTask(value: unknown): PromotionCanonicalCurationTask {
  if (!isRecord(value)
      || value.schema_version !== "1.0"
      || !validId(value.handoff_id)
      || !nonEmptyString(value.source_revision)
      || !validId(value.candidate_id)
      || !isSha256(value.base_candidate_sha256)
      || !isSha256(value.source_family_id_sha256)
      || !isSha256(value.operator_group_id_sha256)
      || !isSha256(value.comparator_operator_group_id_sha256)
      || !Array.isArray(value.source_trials)
      || value.source_trials.length !== 6
      || !Array.isArray(value.required_artifacts)
      || JSON.stringify(value.required_artifacts) !== JSON.stringify(canonicalArtifactRequirements())
      || !validId(value.curator_id)
      || !validId(value.verifier_id)
      || value.curator_id === value.verifier_id
      || !validProtocolVersion(value.curator_protocol_version)
      || !validProtocolVersion(value.verifier_protocol_version)
      || value.status !== "pending_human_curation"
      || value.canonical_source_root !== null
      || value.derivation_mode !== null
      || value.curated_at !== null
      || value.verified_at !== null
      || !isRecord(value.curator_attestation)
      || value.curator_attestation.completed_by_human !== false
      || !isRecord(value.verifier_attestation)
      || value.verifier_attestation.completed_by_human !== false
      || value.verifier_attestation.curator_output_independently_checked !== false
      || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Invalid canonical curation task.");
  }
  const trials = value.source_trials.map(parseSourceTrial);
  if (trials.filter((trial) => trial.group_id === "group-a").length !== 3
      || trials.filter((trial) => trial.group_id === "group-b").length !== 3
      || new Set(trials.map((trial) => trial.trial_id)).size !== trials.length
      || new Set(trials.map((trial) => trial.artifact_path)).size !== trials.length) {
    throw new Error("Invalid canonical curation trial groups.");
  }
  return { ...(value as unknown as PromotionCanonicalCurationTask), source_trials: trials };
}

function parseSourceTrial(
  value: unknown
): PromotionCanonicalCurationTask["source_trials"][number] {
  if (!isRecord(value)
      || (value.group_id !== "group-a" && value.group_id !== "group-b")
      || !validId(value.trial_id)
      || !isSha256(value.source_ref_sha256)
      || !isSha256(value.source_blob_sha256)
      || !isSha256(value.reviewer_blob_sha256)
      || !safeRelativePath(value.artifact_path)) {
    throw new Error("Invalid canonical curation source trial.");
  }
  return value as unknown as PromotionCanonicalCurationTask["source_trials"][number];
}

function parseHandoffManifest(value: unknown): PromotionCanonicalCurationHandoffManifest {
  const requiredArtifactCount = Object.keys(PROMOTION_CANONICAL_ARTIFACT_PATHS).length;
  if (!isRecord(value)
      || value.schema_version !== "1.0"
      || !validId(value.handoff_id)
      || !nonEmptyString(value.source_revision)
      || value.status !== "human_curation_pending"
      || !validId(value.curator_id)
      || !validId(value.verifier_id)
      || value.curator_id === value.verifier_id
      || !validProtocolVersion(value.curator_protocol_version)
      || !validProtocolVersion(value.verifier_protocol_version)
      || value.source_license_status !== "redistribution_permitted"
      || !positiveInteger(value.source_eligible_candidate_count)
      || value.source_eligible_candidate_count < MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES
      || value.task_count !== value.source_eligible_candidate_count
      || value.source_trials_per_task !== 6
      || value.required_artifact_count !== requiredArtifactCount
      || value.canonical_source_count !== 0
      || value.curation_completed_count !== 0
      || value.verification_completed_count !== 0
      || value.canonical_curation_completed !== false
      || value.confirmatory_admitted !== false
      || !isRecord(value.upstream)
      || !Array.isArray(value.files)
      || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Invalid canonical curation handoff manifest.");
  }
  const upstream = value.upstream;
  if (upstream.handoff_manifest_path !== UPSTREAM_HANDOFF_MANIFEST
      || !isSha256(upstream.handoff_manifest_sha256)
      || upstream.review_report_path !== UPSTREAM_REVIEW_REPORT
      || !isSha256(upstream.review_report_sha256)
      || upstream.review_labels_path !== UPSTREAM_REVIEW_LABELS
      || !isSha256(upstream.review_labels_sha256)
      || upstream.review_evidence_path !== UPSTREAM_REVIEW_EVIDENCE
      || !isSha256(upstream.review_evidence_sha256)) {
    throw new Error("Invalid canonical curation upstream evidence.");
  }
  const files = value.files.map(parseFileBinding);
  if (files.length === 0
      || new Set(files.map((file) => file.path)).size !== files.length
      || files.some((file) => file.path === PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST)) {
    throw new Error("Invalid canonical curation handoff files.");
  }
  return { ...(value as unknown as PromotionCanonicalCurationHandoffManifest), files };
}

function parseFileBinding(value: unknown): { path: string; sha256: string } {
  if (!isRecord(value) || !safeRelativePath(value.path) || !isSha256(value.sha256)) {
    throw new Error("Invalid canonical curation file binding.");
  }
  return { path: value.path, sha256: value.sha256 };
}

async function copyCandidateReviewerArtifacts(
  handoffRoot: string,
  stagingRoot: string,
  candidate: PromotionTrialCandidateRecord
): Promise<void> {
  for (const trial of [...candidate.trials, ...(candidate.comparator_trials || [])]) {
    const source = path.join(handoffRoot, "reviewer", trial.artifact_path);
    const bytes = await readContainedRegularFile(path.join(handoffRoot, "reviewer"), source);
    if (sha256(bytes) !== trial.reviewer_blob_sha256) {
      throw new Error("A curation source trace changed after handoff inspection.");
    }
    const target = path.join(stagingRoot, "curator", trial.artifact_path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
}

async function copyUpstreamEvidence(
  handoffRoot: string,
  reviewRoot: string,
  stagingRoot: string
): Promise<PromotionCanonicalCurationHandoffManifest["upstream"]> {
  const files = [
    {
      source: path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST),
      sourceRoot: handoffRoot,
      target: UPSTREAM_HANDOFF_MANIFEST
    },
    {
      source: path.join(reviewRoot, PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT),
      sourceRoot: reviewRoot,
      target: UPSTREAM_REVIEW_REPORT
    },
    {
      source: path.join(reviewRoot, PROMOTION_TRIAL_CANDIDATE_ADJUDICATED_LABELS),
      sourceRoot: reviewRoot,
      target: UPSTREAM_REVIEW_LABELS
    },
    {
      source: path.join(reviewRoot, PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE),
      sourceRoot: reviewRoot,
      target: UPSTREAM_REVIEW_EVIDENCE
    }
  ];
  const hashes: string[] = [];
  for (const file of files) {
    const bytes = await readContainedRegularFile(file.sourceRoot, file.source);
    const target = path.join(stagingRoot, file.target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    hashes.push(sha256(bytes));
  }
  return {
    handoff_manifest_path: UPSTREAM_HANDOFF_MANIFEST,
    handoff_manifest_sha256: hashes[0],
    review_report_path: UPSTREAM_REVIEW_REPORT,
    review_report_sha256: hashes[1],
    review_labels_path: UPSTREAM_REVIEW_LABELS,
    review_labels_sha256: hashes[2],
    review_evidence_path: UPSTREAM_REVIEW_EVIDENCE,
    review_evidence_sha256: hashes[3]
  };
}

function upstreamHashEntries(
  manifest: PromotionCanonicalCurationHandoffManifest
): Array<[string, string]> {
  return [
    [manifest.upstream.handoff_manifest_path, manifest.upstream.handoff_manifest_sha256],
    [manifest.upstream.review_report_path, manifest.upstream.review_report_sha256],
    [manifest.upstream.review_labels_path, manifest.upstream.review_labels_sha256],
    [manifest.upstream.review_evidence_path, manifest.upstream.review_evidence_sha256]
  ];
}

function upstreamHandoffMatchesTasks(
  value: unknown,
  manifest: PromotionCanonicalCurationHandoffManifest,
  tasks: PromotionCanonicalCurationTask[]
): boolean {
  if (!isRecord(value)
      || value.handoff_id !== manifest.handoff_id
      || value.source_revision !== manifest.source_revision
      || !Array.isArray(value.candidates)) return false;
  const candidates = new Map(value.candidates.flatMap((candidate) =>
    isRecord(candidate) && validId(candidate.candidate_id)
      ? [[candidate.candidate_id, candidate] as const]
      : []));
  return tasks.length === manifest.task_count && tasks.every((task) => {
    const candidate = candidates.get(task.candidate_id);
    if (!candidate
        || candidate.base_candidate_sha256 !== task.base_candidate_sha256
        || candidate.source_family_id_sha256 !== task.source_family_id_sha256
        || candidate.operator_group_id_sha256 !== task.operator_group_id_sha256
        || candidate.comparator_operator_group_id_sha256
          !== task.comparator_operator_group_id_sha256
        || !Array.isArray(candidate.trials)
        || !Array.isArray(candidate.comparator_trials)) return false;
    const expectedTrials = [
      ...candidate.trials.map((trial) => ({ group_id: "group-a", trial })),
      ...candidate.comparator_trials.map((trial) => ({ group_id: "group-b", trial }))
    ];
    return expectedTrials.length === task.source_trials.length
      && expectedTrials.every(({ group_id, trial }) => {
        if (!isRecord(trial) || !validId(trial.trial_id)) return false;
        const bound = task.source_trials.find((item) =>
          item.group_id === group_id && item.trial_id === trial.trial_id);
        return Boolean(bound)
          && trial.source_ref_sha256 === bound?.source_ref_sha256
          && trial.source_blob_sha256 === bound?.source_blob_sha256
          && trial.reviewer_blob_sha256 === bound?.reviewer_blob_sha256
          && trial.artifact_path === bound?.artifact_path;
      });
  });
}

function canonicalArtifactRequirements(): PromotionCanonicalCurationTask["required_artifacts"] {
  return (Object.entries(PROMOTION_CANONICAL_ARTIFACT_PATHS) as Array<
    [PromotionCanonicalArtifactRole, string]
  >).map(([role, artifactPath]) => ({ role, path: artifactPath }));
}

function promotionCanonicalCuratorGuide(): string {
  return [
    "# Canonical Curation Guide",
    "",
    "This packet starts only after the candidate handoff, independent review, and source-license gates pass.",
    "",
    "For each task:",
    "",
    "1. Inspect all six hash-bound trace artifacts.",
    "2. Author one canonical source outside this packet with every artifact listed in the runtime contract.",
    "3. Derive result values from the bound traces or mark the derivation as human-authored; do not copy missing source fields as if they were source-native.",
    "4. Record the assigned curator identity, protocol version, derivation mode, and completion timestamp.",
    "5. Leave verification and final human_verified status to the assigned verifier.",
    "",
    "This packet is incomplete by construction. It contains no canonical source and no final benchmark-curation.json."
  ].join("\n") + "\n";
}

function promotionCanonicalVerifierGuide(): string {
  return [
    "# Canonical Verification Guide",
    "",
    "Verification is independent of curation preparation.",
    "",
    "For each completed canonical source:",
    "",
    "1. Recheck candidate identity and all six source-trial hashes.",
    "2. Recompute all 15 artifact hashes.",
    "3. Confirm result arithmetic, trial and budget coverage, figure audit, claim/evidence links, and readiness agreement.",
    "4. Record a verifier identity distinct from the curator and a verification timestamp at or after curation.",
    "5. Run the confirmatory intake audit; failed semantics must return to curation and must not be admitted.",
    "",
    "Do not convert this pending handoff, a missing artifact, or an automated check into a human verification claim."
  ].join("\n") + "\n";
}

async function inventoryRegularFiles(root: string): Promise<Array<{ path: string; sha256: string }>> {
  const files: Array<{ path: string; sha256: string }> = [];
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Symlinks are not allowed in curation handoffs.");
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error("Only regular files are allowed in curation handoffs.");
      const relative = path.relative(root, absolute).replace(/\\/gu, "/");
      if (relative === PROMOTION_CANONICAL_CURATION_HANDOFF_MANIFEST) continue;
      files.push({ path: relative, sha256: sha256(await fs.readFile(absolute)) });
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readContainedRegularFile(root: string, target: string): Promise<Buffer> {
  const canonicalRoot = await fs.realpath(root);
  const canonicalTarget = await fs.realpath(target);
  if (!isSameOrContainedPath(canonicalRoot, canonicalTarget)) {
    throw new Error("Artifact path escaped its packet root.");
  }
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error("Artifact is not a non-empty regular file.");
  }
  return fs.readFile(target);
}

function validateOperatorInput(input: PreparePromotionCanonicalCurationHandoffInput): void {
  if (!validId(input.curatorId)
      || !validId(input.verifierId)
      || input.curatorId === input.verifierId) {
    throw new Error("Canonical curation requires distinct valid curator and verifier IDs.");
  }
  if (!validProtocolVersion(input.curatorProtocolVersion)
      || !validProtocolVersion(input.verifierProtocolVersion)) {
    throw new Error("Canonical curation protocol versions must be non-empty portable identifiers.");
  }
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a new directory inside the workspace.`);
  }
}

function isSameOrContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !path.isAbsolute(value)
    && !value.includes("\\")
    && !value.split("/").includes("..");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value);
}

function validProtocolVersion(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function portableRef(root: string, target: string): string {
  return path.relative(root, target).replace(/\\/gu, "/") || ".";
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
