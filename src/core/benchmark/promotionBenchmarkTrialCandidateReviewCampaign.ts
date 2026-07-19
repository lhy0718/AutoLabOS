import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonFile } from "../../utils/fs.js";
import {
  PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST,
  PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST,
  PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST,
  PROMOTION_TRIAL_CANDIDATE_TASKS,
  inspectPromotionTrialCandidateHandoff,
  inspectPromotionTrialCandidateLicensePacket,
  inspectPromotionTrialCandidateReviewerPacket,
  type PromotionTrialCandidateLicensePacketManifest,
  type PromotionTrialCandidateReviewerPacketManifest
} from "./promotionBenchmarkTrialCandidateHandoff.js";
import {
  preparePromotionTrialCandidateAnnotationWorksheet,
  preparePromotionTrialCandidateLicenseReviewWorksheet
} from "./promotionBenchmarkTrialCandidateReview.js";
import {
  PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK,
  PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS,
  parsePromotionTrialCandidateLicenseTask,
  type PromotionTrialCandidateLicenseTask
} from "./promotionBenchmarkTrialCandidateReviewContract.js";
import {
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES
} from "./promotionBenchmarkConfirmatoryContract.js";

export const PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_MANIFEST =
  "controller/review-campaign.json";
export const PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_UPSTREAM_HANDOFF =
  "controller/upstream-trial-candidate-handoff.json";

const REVIEWER_SLOTS = ["reviewer-a", "reviewer-b"] as const;
const LICENSE_SLOT = "license-reviewer" as const;
const ANNOTATION_TEMPLATE = "annotation-template.json";
const LICENSE_TEMPLATE = "license-review-template.json";
const RETURN_GUIDE = "RETURN_GUIDE.md";

type ReviewerSlot = typeof REVIEWER_SLOTS[number];
type CampaignSlot = ReviewerSlot | typeof LICENSE_SLOT;
type CampaignRole = "initial_candidate_review" | "source_license_review";

export interface PreparePromotionTrialCandidateReviewCampaignInput {
  cwd: string;
  handoffRoot: string;
  annotatorIds: string[];
  licenseReviewerId: string;
  outDir: string;
}

export interface PreparePromotionTrialCandidateReviewCampaignResult {
  campaign_id: string;
  handoff_id: string;
  candidate_count: number;
  output_dir: string;
  manifest_path: string;
  reviewer_package_paths: [string, string];
  license_package_path: string;
  human_annotation_completed_count: 0;
  human_license_review_completed: false;
}

export interface PromotionTrialCandidateReviewCampaignIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionTrialCandidateReviewCampaignInspection {
  passed: boolean;
  manifest: PromotionTrialCandidateReviewCampaignManifest | null;
  issues: PromotionTrialCandidateReviewCampaignIssue[];
}

export interface PromotionTrialCandidateReviewCampaignAssignment {
  slot: CampaignSlot;
  role: CampaignRole;
  participant_id: string;
  package_root: string;
  packet_root: string;
  template_path: string;
  return_guide_path: string;
  packet_manifest_sha256: string;
  template_sha256: string;
}

export interface PromotionTrialCandidateReviewCampaignManifest {
  schema_version: "1.0";
  campaign_id: string;
  handoff_id: string;
  source_revision: string;
  status: "human_review_pending";
  candidate_count: number;
  paper_scale_candidate_floor_met: true;
  assignments: PromotionTrialCandidateReviewCampaignAssignment[];
  human_annotation_completed_count: 0;
  human_license_review_completed: false;
  adjudication_completed: false;
  confirmatory_admitted: false;
  upstream_handoff_manifest_path:
    typeof PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_UPSTREAM_HANDOFF;
  upstream_handoff_manifest_sha256: string;
  files: Array<{ path: string; sha256: string }>;
  evidence_boundary: string;
}

export async function preparePromotionTrialCandidateReviewCampaign(
  input: PreparePromotionTrialCandidateReviewCampaignInput
): Promise<PreparePromotionTrialCandidateReviewCampaignResult> {
  validateParticipantIds(input.annotatorIds, input.licenseReviewerId);
  const cwd = path.resolve(input.cwd);
  const handoffRoot = path.resolve(cwd, input.handoffRoot);
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Trial-candidate review campaign output");
  if (isSameOrContainedPath(handoffRoot, outDir)) {
    throw new Error("Trial-candidate review campaign output must stay outside the closed handoff.");
  }
  if (await pathExists(outDir)) {
    throw new Error("Trial-candidate review campaign output already exists.");
  }

  const handoff = await inspectPromotionTrialCandidateHandoff(handoffRoot);
  if (!handoff.passed || !handoff.manifest) {
    throw new Error(`Review campaign requires an integrity-valid handoff: ${handoff.issues.map((issue) => issue.code).join(", ") || "unreadable"}.`);
  }
  if (!handoff.manifest.paper_scale_trace_floor_met
      || handoff.manifest.comparison_mode !== "paired_operator"
      || handoff.manifest.operator_groups_per_base !== 2
      || handoff.manifest.trials_per_operator_group !== 3
      || handoff.manifest.paired_comparison_floor_met !== true) {
    throw new Error("Review campaign requires a paper-scale paired six-trial candidate handoff.");
  }
  const reviewerPacket = await inspectPromotionTrialCandidateReviewerPacket(
    path.join(handoffRoot, "reviewer")
  );
  const licensePacket = await inspectPromotionTrialCandidateLicensePacket(
    path.join(handoffRoot, "license")
  );
  if (!reviewerPacket.passed || !reviewerPacket.manifest
      || !licensePacket.passed || !licensePacket.manifest) {
    throw new Error("Review campaign requires valid reviewer and source-license packets.");
  }

  const stagingRoot = path.join(
    path.dirname(outDir),
    `.${path.basename(outDir)}.staging-${randomUUID()}`
  );
  await fs.mkdir(stagingRoot, { recursive: true });
  try {
    const reviewerAssignments = await Promise.all(REVIEWER_SLOTS.map(
      async (slot, index) => {
        const packageRoot = path.join(stagingRoot, slot);
        const packetRoot = path.join(packageRoot, "packet");
        await copyBoundPacket(
          path.join(handoffRoot, "reviewer"),
          packetRoot,
          PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST,
          reviewerPacket.manifest?.files || []
        );
        const templatePath = path.join(packageRoot, ANNOTATION_TEMPLATE);
        await preparePromotionTrialCandidateAnnotationWorksheet({
          cwd,
          handoffRoot,
          annotatorId: input.annotatorIds[index],
          outputPath: templatePath
        });
        const guidePath = path.join(packageRoot, RETURN_GUIDE);
        await fs.writeFile(guidePath, reviewerReturnGuide(), "utf8");
        return campaignAssignment({
          root: stagingRoot,
          slot,
          role: "initial_candidate_review",
          participantId: input.annotatorIds[index],
          packetRoot,
          templatePath,
          guidePath,
          packetManifestName: PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST
        });
      }
    ));

    const licensePackageRoot = path.join(stagingRoot, LICENSE_SLOT);
    const licensePacketRoot = path.join(licensePackageRoot, "packet");
    await copyBoundPacket(
      path.join(handoffRoot, "license"),
      licensePacketRoot,
      PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST,
      licensePacket.manifest.files
    );
    const licenseTemplatePath = path.join(licensePackageRoot, LICENSE_TEMPLATE);
    await preparePromotionTrialCandidateLicenseReviewWorksheet({
      cwd,
      handoffRoot,
      reviewerId: input.licenseReviewerId,
      outputPath: licenseTemplatePath
    });
    const licenseGuidePath = path.join(licensePackageRoot, RETURN_GUIDE);
    await fs.writeFile(licenseGuidePath, licenseReturnGuide(), "utf8");
    const licenseAssignment = await campaignAssignment({
      root: stagingRoot,
      slot: LICENSE_SLOT,
      role: "source_license_review",
      participantId: input.licenseReviewerId,
      packetRoot: licensePacketRoot,
      templatePath: licenseTemplatePath,
      guidePath: licenseGuidePath,
      packetManifestName: PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST
    });

    const upstreamBytes = await readContainedRegularFile(
      handoffRoot,
      path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST)
    );
    const upstreamPath = path.join(
      stagingRoot,
      PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_UPSTREAM_HANDOFF
    );
    await fs.mkdir(path.dirname(upstreamPath), { recursive: true });
    await fs.writeFile(upstreamPath, upstreamBytes);

    const assignments = [...reviewerAssignments, licenseAssignment];
    const campaignId = `review-campaign-${sha256(Buffer.from([
      handoff.manifest.handoff_id,
      handoff.manifest.source_revision,
      ...input.annotatorIds,
      input.licenseReviewerId
    ].join("\n"), "utf8")).slice(0, 24)}`;
    const manifest: PromotionTrialCandidateReviewCampaignManifest = {
      schema_version: "1.0",
      campaign_id: campaignId,
      handoff_id: handoff.manifest.handoff_id,
      source_revision: handoff.manifest.source_revision,
      status: "human_review_pending",
      candidate_count: handoff.manifest.base_candidate_count,
      paper_scale_candidate_floor_met: true,
      assignments,
      human_annotation_completed_count: 0,
      human_license_review_completed: false,
      adjudication_completed: false,
      confirmatory_admitted: false,
      upstream_handoff_manifest_path:
        PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_UPSTREAM_HANDOFF,
      upstream_handoff_manifest_sha256: sha256(upstreamBytes),
      files: await inventoryRegularFiles(stagingRoot),
      evidence_boundary: "This campaign contains two isolated opaque candidate-review packages and one isolated source-license package. Templates remain incomplete, no human judgment or independence claim is inferred, and no adjudication or confirmatory admission is created."
    };
    await writeJsonFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_MANIFEST),
      manifest
    );
    const inspection = await inspectPromotionTrialCandidateReviewCampaign(stagingRoot);
    if (!inspection.passed) {
      throw new Error(`Review campaign failed self-inspection: ${inspection.issues.map((issue) => issue.code).join(", ")}.`);
    }
    await fs.rename(stagingRoot, outDir);

    return {
      campaign_id: campaignId,
      handoff_id: handoff.manifest.handoff_id,
      candidate_count: handoff.manifest.base_candidate_count,
      output_dir: portableRef(cwd, outDir),
      manifest_path: portableRef(
        cwd,
        path.join(outDir, PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_MANIFEST)
      ),
      reviewer_package_paths: REVIEWER_SLOTS.map((slot) =>
        portableRef(cwd, path.join(outDir, slot))) as [string, string],
      license_package_path: portableRef(cwd, path.join(outDir, LICENSE_SLOT)),
      human_annotation_completed_count: 0,
      human_license_review_completed: false
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectPromotionTrialCandidateReviewCampaign(
  rootPath: string
): Promise<PromotionTrialCandidateReviewCampaignInspection> {
  const root = path.resolve(rootPath);
  const issues: PromotionTrialCandidateReviewCampaignIssue[] = [];
  let manifest: PromotionTrialCandidateReviewCampaignManifest;
  try {
    manifest = parseCampaignManifest(JSON.parse(await fs.readFile(
      path.join(root, PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_MANIFEST),
      "utf8"
    )) as unknown);
  } catch {
    return {
      passed: false,
      manifest: null,
      issues: [{
        code: "trial_candidate_review_campaign_manifest_unreadable",
        message: "The review campaign manifest is missing or invalid."
      }]
    };
  }

  const observedFiles = await inventoryRegularFiles(root).catch(() => null);
  if (!observedFiles
      || JSON.stringify(observedFiles) !== JSON.stringify(manifest.files)) {
    issues.push({
      code: "trial_candidate_review_campaign_inventory_invalid",
      message: "The review campaign file inventory changed."
    });
  }

  const assignmentBySlot = new Map(manifest.assignments.map((item) => [item.slot, item]));
  const reviewerInspections = await Promise.all(REVIEWER_SLOTS.map(async (slot) => ({
    slot,
    inspection: await inspectPromotionTrialCandidateReviewerPacket(
      path.join(root, assignmentBySlot.get(slot)?.packet_root || "")
    )
  })));
  const licenseAssignment = assignmentBySlot.get(LICENSE_SLOT);
  const licenseInspection = await inspectPromotionTrialCandidateLicensePacket(
    path.join(root, licenseAssignment?.packet_root || "")
  );

  for (const item of reviewerInspections) {
    const assignment = assignmentBySlot.get(item.slot);
    if (!assignment || !item.inspection.passed || !item.inspection.manifest
        || item.inspection.manifest.handoff_id !== manifest.handoff_id
        || !await packetManifestHashMatches(root, assignment)) {
      issues.push({
        code: "trial_candidate_review_campaign_reviewer_packet_invalid",
        message: "Each reviewer must receive an intact self-contained packet for the same handoff.",
        ref: item.slot
      });
      continue;
    }
    try {
      const taskIds = await reviewerTaskIds(path.join(root, assignment.packet_root));
      const template = JSON.parse(await fs.readFile(
        path.join(root, assignment.template_path),
        "utf8"
      )) as unknown;
      validateBlankAnnotationTemplate(
        template,
        manifest.handoff_id,
        assignment.participant_id,
        taskIds
      );
      if (await hashFile(path.join(root, assignment.template_path))
          !== assignment.template_sha256) {
        throw new Error("template hash mismatch");
      }
      if (await fs.readFile(path.join(root, assignment.return_guide_path), "utf8")
          !== reviewerReturnGuide()) {
        throw new Error("guide mismatch");
      }
    } catch {
      issues.push({
        code: "trial_candidate_review_campaign_reviewer_template_invalid",
        message: "Reviewer templates must preserve complete opaque task coverage with null labels and false attestations.",
        ref: item.slot
      });
    }
  }

  if (!licenseAssignment || !licenseInspection.passed || !licenseInspection.manifest
      || licenseInspection.manifest.handoff_id !== manifest.handoff_id
      || !await packetManifestHashMatches(root, licenseAssignment)) {
    issues.push({
      code: "trial_candidate_review_campaign_license_packet_invalid",
      message: "The source-license reviewer must receive an intact isolated license packet."
    });
  } else {
    try {
      validateBlankLicenseTemplate(
        JSON.parse(await fs.readFile(
          path.join(root, licenseAssignment.template_path),
          "utf8"
        )) as unknown,
        manifest.handoff_id,
        licenseAssignment.participant_id,
        parsePromotionTrialCandidateLicenseTask(JSON.parse(await fs.readFile(
          path.join(
            root,
            licenseAssignment.packet_root,
            path.basename(PROMOTION_TRIAL_CANDIDATE_LICENSE_TASK)
          ),
          "utf8"
        )) as unknown)
      );
      if (await hashFile(path.join(root, licenseAssignment.template_path))
          !== licenseAssignment.template_sha256) {
        throw new Error("template hash mismatch");
      }
      if (await fs.readFile(
        path.join(root, licenseAssignment.return_guide_path),
        "utf8"
      ) !== licenseReturnGuide()) {
        throw new Error("guide mismatch");
      }
    } catch {
      issues.push({
        code: "trial_candidate_review_campaign_license_template_invalid",
        message: "The license template must remain unreviewed with a false human attestation."
      });
    }
  }

  const packetManifests = manifest.assignments.map((assignment) =>
    assignment.packet_manifest_sha256);
  if (packetManifests[0] !== packetManifests[1]) {
    issues.push({
      code: "trial_candidate_review_campaign_reviewer_packets_diverged",
      message: "The two initial reviewers must receive identical opaque packet snapshots."
    });
  }

  try {
    const upstreamPath = path.join(root, manifest.upstream_handoff_manifest_path);
    const upstreamBytes = await readContainedRegularFile(root, upstreamPath);
    const upstream = JSON.parse(upstreamBytes.toString("utf8")) as unknown;
    if (sha256(upstreamBytes) !== manifest.upstream_handoff_manifest_sha256
        || !upstreamHandoffMatchesCampaign(upstream, manifest)) {
      throw new Error("upstream mismatch");
    }
  } catch {
    issues.push({
      code: "trial_candidate_review_campaign_upstream_invalid",
      message: "The campaign must remain bound to the exact upstream handoff and packet manifests."
    });
  }

  const expectedFiles = expectedCampaignFiles(
    manifest,
    reviewerInspections.map((item) => item.inspection.manifest),
    licenseInspection.manifest
  );
  const declaredFiles = new Set(manifest.files.map((item) => item.path));
  if (!expectedFiles
      || expectedFiles.size !== declaredFiles.size
      || [...expectedFiles].some((item) => !declaredFiles.has(item))) {
    issues.push({
      code: "trial_candidate_review_campaign_file_contract_invalid",
      message: "The campaign may contain only its three isolated packets, blank templates, return guides, and upstream receipt."
    });
  }

  return { passed: issues.length === 0, manifest, issues };
}

async function campaignAssignment(input: {
  root: string;
  slot: CampaignSlot;
  role: CampaignRole;
  participantId: string;
  packetRoot: string;
  templatePath: string;
  guidePath: string;
  packetManifestName: string;
}): Promise<PromotionTrialCandidateReviewCampaignAssignment> {
  return {
    slot: input.slot,
    role: input.role,
    participant_id: input.participantId,
    package_root: input.slot,
    packet_root: portableRef(input.root, input.packetRoot),
    template_path: portableRef(input.root, input.templatePath),
    return_guide_path: portableRef(input.root, input.guidePath),
    packet_manifest_sha256: await hashFile(path.join(
      input.packetRoot,
      input.packetManifestName
    )),
    template_sha256: await hashFile(input.templatePath)
  };
}

async function copyBoundPacket(
  sourceRoot: string,
  targetRoot: string,
  manifestName: string,
  files: Array<{ path: string; sha256: string }>
): Promise<void> {
  for (const item of [{ path: manifestName }, ...files]) {
    const bytes = await readContainedRegularFile(
      sourceRoot,
      path.join(sourceRoot, item.path)
    );
    if ("sha256" in item && sha256(bytes) !== item.sha256) {
      throw new Error("Review campaign source packet changed during copy.");
    }
    const target = path.join(targetRoot, item.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
}

async function packetManifestHashMatches(
  root: string,
  assignment: PromotionTrialCandidateReviewCampaignAssignment
): Promise<boolean> {
  const manifestName = assignment.role === "initial_candidate_review"
    ? PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST
    : PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST;
  return hashFile(path.join(root, assignment.packet_root, manifestName))
    .then((value) => value === assignment.packet_manifest_sha256)
    .catch(() => false);
}

async function reviewerTaskIds(packetRoot: string): Promise<string[]> {
  const taskPath = path.join(
    packetRoot,
    PROMOTION_TRIAL_CANDIDATE_TASKS.replace(/^reviewer\//u, "")
  );
  const rows = (await fs.readFile(taskPath, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as unknown);
  const ids = rows.map((row) => {
    if (!isRecord(row) || !validId(row.candidate_id)) {
      throw new Error("Invalid reviewer task.");
    }
    return row.candidate_id;
  });
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate reviewer task.");
  return ids;
}

function validateBlankAnnotationTemplate(
  value: unknown,
  handoffId: string,
  participantId: string,
  taskIds: string[]
): void {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "handoff_id", "annotator_id", "label_source",
        "review_role", "independence_attestation", "annotations"
      ])
      || value.schema_version !== "1.0"
      || value.handoff_id !== handoffId
      || value.annotator_id !== participantId
      || value.label_source !== "human"
      || value.review_role !== "initial"
      || !isRecord(value.independence_attestation)
      || !hasExactKeys(value.independence_attestation, [
        "completed_by_human", "peer_annotations_unseen", "controller_map_unseen"
      ])
      || value.independence_attestation.completed_by_human !== false
      || value.independence_attestation.peer_annotations_unseen !== false
      || value.independence_attestation.controller_map_unseen !== false
      || !Array.isArray(value.annotations)
      || value.annotations.length !== taskIds.length) {
    throw new Error("Invalid blank annotation template.");
  }
  const expectedIds = [...taskIds].sort();
  const observedIds: string[] = [];
  for (const row of value.annotations) {
    const observations = isRecord(row) && isRecord(row.observations)
      ? row.observations
      : null;
    if (!isRecord(row)
        || !hasExactKeys(row, ["candidate_id", "observations", "evidence_refs", "rationale"])
        || !validId(row.candidate_id)
        || !observations
        || !hasExactKeys(observations, [...PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS])
        || PROMOTION_TRIAL_CANDIDATE_OBSERVATIONS.some((field) =>
          observations[field] !== null)
        || !Array.isArray(row.evidence_refs)
        || row.evidence_refs.length !== 0
        || row.rationale !== "") {
      throw new Error("Invalid blank annotation row.");
    }
    observedIds.push(row.candidate_id);
  }
  if (JSON.stringify(observedIds.sort()) !== JSON.stringify(expectedIds)) {
    throw new Error("Annotation task coverage changed.");
  }
}

function validateBlankLicenseTemplate(
  value: unknown,
  handoffId: string,
  participantId: string,
  task: PromotionTrialCandidateLicenseTask
): void {
  const candidateScoped = task.schema_version === "1.1";
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "handoff_id", "reviewer_id", "label_source",
        "review_role", "independence_attestation", "review",
        ...(candidateScoped ? ["subject_reviews"] : [])
      ])
      || value.schema_version !== task.schema_version
      || value.handoff_id !== handoffId
      || value.reviewer_id !== participantId
      || value.label_source !== "human"
      || value.review_role !== "source_license"
      || !isRecord(value.independence_attestation)
      || !hasExactKeys(value.independence_attestation, [
        "completed_by_human", "candidate_annotations_unseen", "controller_map_unseen"
      ])
      || value.independence_attestation.completed_by_human !== false
      || value.independence_attestation.candidate_annotations_unseen !== false
      || value.independence_attestation.controller_map_unseen !== false
      || !isRecord(value.review)
      || !hasExactKeys(value.review, ["status", "evidence_refs", "rationale"])
      || value.review.status !== null
      || !Array.isArray(value.review.evidence_refs)
      || value.review.evidence_refs.length !== 0
      || value.review.rationale !== "") {
    throw new Error("Invalid blank license template.");
  }
  if (!candidateScoped) return;
  if (!Array.isArray(value.subject_reviews)
      || value.subject_reviews.length !== task.subjects.length) {
    throw new Error("Invalid blank candidate-scoped license template.");
  }
  const observedSubjectIds: string[] = [];
  for (const row of value.subject_reviews) {
    if (!isRecord(row)
        || !hasExactKeys(row, ["subject_id", "status", "evidence_refs", "rationale"])
        || !validId(row.subject_id)
        || row.status !== null
        || !Array.isArray(row.evidence_refs)
        || row.evidence_refs.length !== 0
        || row.rationale !== "") {
      throw new Error("Invalid blank candidate-scoped license row.");
    }
    observedSubjectIds.push(row.subject_id);
  }
  const expectedSubjectIds = task.subjects.map((item) => item.subject_id).sort();
  if (JSON.stringify(observedSubjectIds.sort()) !== JSON.stringify(expectedSubjectIds)) {
    throw new Error("Blank candidate-scoped license coverage changed.");
  }
}

function upstreamHandoffMatchesCampaign(
  value: unknown,
  manifest: PromotionTrialCandidateReviewCampaignManifest
): boolean {
  if (!isRecord(value)
      || value.handoff_id !== manifest.handoff_id
      || value.source_revision !== manifest.source_revision
      || value.base_candidate_count !== manifest.candidate_count
      || value.paper_scale_trace_floor_met !== true
      || value.comparison_mode !== "paired_operator"
      || value.operator_groups_per_base !== 2
      || value.trials_per_operator_group !== 3
      || value.paired_comparison_floor_met !== true
      || value.source_license_status !== "unreviewed"
      || value.confirmatory_admitted !== false
      || !Array.isArray(value.outputs)) return false;
  const outputs = new Map(value.outputs.flatMap((item) =>
    isRecord(item) && safeRelativePath(item.path) && sha256String(item.sha256)
      ? [[item.path, item.sha256] as const]
      : []));
  const reviewerHash = manifest.assignments.find((item) =>
    item.slot === "reviewer-a")?.packet_manifest_sha256;
  const licenseHash = manifest.assignments.find((item) =>
    item.slot === LICENSE_SLOT)?.packet_manifest_sha256;
  return outputs.get(`reviewer/${PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST}`)
      === reviewerHash
    && outputs.get(`license/${PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST}`)
      === licenseHash;
}

function expectedCampaignFiles(
  manifest: PromotionTrialCandidateReviewCampaignManifest,
  reviewerManifests: Array<PromotionTrialCandidateReviewerPacketManifest | null>,
  licenseManifest: PromotionTrialCandidateLicensePacketManifest | null
): Set<string> | null {
  if (reviewerManifests.some((item) => !item) || !licenseManifest) return null;
  const files = new Set([PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_UPSTREAM_HANDOFF]);
  for (let index = 0; index < REVIEWER_SLOTS.length; index += 1) {
    const assignment = manifest.assignments.find((item) =>
      item.slot === REVIEWER_SLOTS[index]);
    const packet = reviewerManifests[index];
    if (!assignment || !packet) return null;
    files.add(`${assignment.packet_root}/${PROMOTION_TRIAL_CANDIDATE_REVIEWER_PACKET_MANIFEST}`);
    for (const item of packet.files) files.add(`${assignment.packet_root}/${item.path}`);
    files.add(assignment.template_path);
    files.add(assignment.return_guide_path);
  }
  const license = manifest.assignments.find((item) => item.slot === LICENSE_SLOT);
  if (!license) return null;
  files.add(`${license.packet_root}/${PROMOTION_TRIAL_CANDIDATE_LICENSE_PACKET_MANIFEST}`);
  for (const item of licenseManifest.files) files.add(`${license.packet_root}/${item.path}`);
  files.add(license.template_path);
  files.add(license.return_guide_path);
  return files;
}

function parseCampaignManifest(value: unknown): PromotionTrialCandidateReviewCampaignManifest {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "campaign_id", "handoff_id", "source_revision",
        "status", "candidate_count", "paper_scale_candidate_floor_met",
        "assignments", "human_annotation_completed_count",
        "human_license_review_completed", "adjudication_completed",
        "confirmatory_admitted", "upstream_handoff_manifest_path",
        "upstream_handoff_manifest_sha256", "files", "evidence_boundary"
      ])
      || value.schema_version !== "1.0"
      || !validId(value.campaign_id)
      || !validId(value.handoff_id)
      || !nonEmptyString(value.source_revision)
      || value.status !== "human_review_pending"
      || !positiveInteger(value.candidate_count)
      || value.candidate_count < MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES
      || value.paper_scale_candidate_floor_met !== true
      || !Array.isArray(value.assignments)
      || value.assignments.length !== 3
      || value.human_annotation_completed_count !== 0
      || value.human_license_review_completed !== false
      || value.adjudication_completed !== false
      || value.confirmatory_admitted !== false
      || value.upstream_handoff_manifest_path
        !== PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_UPSTREAM_HANDOFF
      || !sha256String(value.upstream_handoff_manifest_sha256)
      || !Array.isArray(value.files)
      || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Invalid review campaign manifest.");
  }
  const assignments = value.assignments.map(parseAssignment);
  const participantIds = assignments.map((item) => item.participant_id);
  const slots = assignments.map((item) => item.slot);
  if (new Set(participantIds).size !== 3
      || JSON.stringify(slots) !== JSON.stringify([...REVIEWER_SLOTS, LICENSE_SLOT])) {
    throw new Error("Invalid review campaign role separation.");
  }
  const files = value.files.map(parseFileBinding);
  if (new Set(files.map((item) => item.path)).size !== files.length
      || files.some((item) =>
        item.path === PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_MANIFEST)) {
    throw new Error("Invalid review campaign file bindings.");
  }
  return {
    ...(value as unknown as PromotionTrialCandidateReviewCampaignManifest),
    assignments,
    files
  };
}

function parseAssignment(value: unknown): PromotionTrialCandidateReviewCampaignAssignment {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "slot", "role", "participant_id", "package_root", "packet_root",
        "template_path", "return_guide_path", "packet_manifest_sha256",
        "template_sha256"
      ])
      || !validId(value.participant_id)
      || !sha256String(value.packet_manifest_sha256)
      || !sha256String(value.template_sha256)) {
    throw new Error("Invalid review campaign assignment.");
  }
  const slot = value.slot;
  const reviewer = slot === "reviewer-a" || slot === "reviewer-b";
  const license = slot === LICENSE_SLOT;
  if ((!reviewer && !license)
      || value.role !== (reviewer ? "initial_candidate_review" : "source_license_review")
      || value.package_root !== slot
      || value.packet_root !== `${slot}/packet`
      || value.template_path !== `${slot}/${reviewer ? ANNOTATION_TEMPLATE : LICENSE_TEMPLATE}`
      || value.return_guide_path !== `${slot}/${RETURN_GUIDE}`) {
    throw new Error("Invalid review campaign assignment paths.");
  }
  return value as unknown as PromotionTrialCandidateReviewCampaignAssignment;
}

function parseFileBinding(value: unknown): { path: string; sha256: string } {
  if (!isRecord(value) || !safeRelativePath(value.path) || !sha256String(value.sha256)) {
    throw new Error("Invalid review campaign file binding.");
  }
  return { path: value.path, sha256: value.sha256 };
}

function reviewerReturnGuide(): string {
  return [
    "# Candidate Review Return Guide",
    "",
    "Use only the files under packet. Do not inspect controller metadata or another reviewer's work.",
    "",
    "1. Make a working copy of annotation-template.json.",
    "2. Inspect all six opaque traces for every candidate and follow packet/RUBRIC.md.",
    "3. Replace every null observation, add trace and JSON Pointer evidence, and write a non-empty rationale.",
    "4. Set all three independence attestations to true only after personally completing the review under those conditions.",
    "5. Return only the completed annotation JSON for reviewer-side preflight.",
    "",
    "From this package root, run:",
    "",
    "```sh",
    "autolabos governance-benchmark preflight-promotion-trial-candidate-annotation --reviewer-root packet --annotation <completed-annotation.json> --out-dir <new-preflight-dir>",
    "```",
    "",
    "The distributed template is incomplete by construction and is not human evidence."
  ].join("\n") + "\n";
}

function licenseReturnGuide(): string {
  return [
    "# Source-License Review Return Guide",
    "",
    "Use only the files under packet. Do not inspect candidate artifacts, candidate annotations, or controller metadata.",
    "",
    "1. Make a working copy of license-review-template.json.",
    "2. Inspect the declared source and the hash-bound permission evidence in packet.",
    "3. Record one allowed status, public evidence references, and a non-empty rationale.",
    "4. Set all three independence attestations to true only after personally completing the review under those conditions.",
    "5. Return only the completed license-review JSON for preflight.",
    "",
    "For a resumable per-subject workspace, move to the directory containing this license-reviewer package and run:",
    "",
    "```sh",
    "autolabos governance-benchmark prepare-promotion-trial-candidate-license-review-workspace --package-root license-reviewer --out-dir license-review-workspace",
    "autolabos governance-benchmark audit-promotion-trial-candidate-license-review-workspace --workspace-root license-review-workspace --out-dir <new-audit-dir>",
    "autolabos governance-benchmark finalize-promotion-trial-candidate-license-review-workspace --workspace-root license-review-workspace --output <completed-license-review.json>",
    "```",
    "The workspace remains blank by construction and finalization does not replace preflight.",
    "",
    "From this package root, run:",
    "",
    "```sh",
    "autolabos governance-benchmark preflight-promotion-trial-candidate-license-review --license-root packet --review <completed-license-review.json> --out-dir <new-preflight-dir>",
    "```",
    "",
    "The distributed template is incomplete by construction and does not grant redistribution permission."
  ].join("\n") + "\n";
}

async function inventoryRegularFiles(
  root: string
): Promise<Array<{ path: string; sha256: string }>> {
  const files: Array<{ path: string; sha256: string }> = [];
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Symlinks are not allowed in review campaigns.");
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error("Only regular files are allowed in review campaigns.");
      const relative = path.relative(root, absolute).replace(/\\/gu, "/");
      if (relative === PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_MANIFEST) continue;
      files.push({ path: relative, sha256: await hashFile(absolute) });
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readContainedRegularFile(root: string, target: string): Promise<Buffer> {
  const canonicalRoot = await fs.realpath(root);
  const canonicalTarget = await fs.realpath(target);
  if (!isSameOrContainedPath(canonicalRoot, canonicalTarget)) {
    throw new Error("Review campaign artifact escaped its packet root.");
  }
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error("Review campaign artifact is not a non-empty regular file.");
  }
  return fs.readFile(target);
}

function validateParticipantIds(annotatorIds: string[], licenseReviewerId: string): void {
  if (annotatorIds.length !== 2
      || !annotatorIds.every(validId)
      || !validId(licenseReviewerId)
      || new Set([...annotatorIds, licenseReviewerId]).size !== 3) {
    throw new Error("Review campaign requires two distinct annotators and a distinct source-license reviewer.");
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

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value);
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
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

async function hashFile(target: string): Promise<string> {
  return sha256(await fs.readFile(target));
}

function portableRef(root: string, target: string): string {
  return path.relative(root, target).replace(/\\/gu, "/") || ".";
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
