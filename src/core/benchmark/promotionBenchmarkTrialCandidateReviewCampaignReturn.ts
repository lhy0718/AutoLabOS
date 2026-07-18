import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonFile } from "../../utils/fs.js";
import {
  PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST,
  inspectPromotionTrialCandidateHandoff,
  type PromotionTrialCandidateHandoffManifest
} from "./promotionBenchmarkTrialCandidateHandoff.js";
import {
  PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT,
  PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE,
  adjudicatePromotionTrialCandidateReview,
  inspectPromotionTrialCandidateReviewAdjudication,
  type PromotionTrialCandidateReviewAdjudicationReport
} from "./promotionBenchmarkTrialCandidateReview.js";
import {
  PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_MANIFEST,
  inspectPromotionTrialCandidateReviewCampaign,
  type PromotionTrialCandidateReviewCampaignAssignment,
  type PromotionTrialCandidateReviewCampaignManifest
} from "./promotionBenchmarkTrialCandidateReviewCampaign.js";

export const PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT =
  "campaign-return-receipt.json";

const UPSTREAM_CAMPAIGN = "upstream/review-campaign.json";
const UPSTREAM_HANDOFF = "upstream/trial-candidate-handoff.json";
const ADJUDICATION_DIR = "adjudication";

export interface CollectPromotionTrialCandidateReviewCampaignInput {
  cwd: string;
  campaignRoot: string;
  handoffRoot: string;
  annotationPaths: string[];
  licenseReviewPath: string;
  resolutionPath?: string;
  outDir: string;
}

export interface PromotionTrialCandidateCampaignReturnIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionTrialCandidateCampaignReturnBinding {
  slot: "reviewer-a" | "reviewer-b" | "license-reviewer" | "resolution" | null;
  participant_id: string | null;
  expected_participant_id: string | null;
  handoff_id: string | null;
  path: string;
  sha256: string;
  assignment_match: boolean;
}

export interface PromotionTrialCandidateCampaignReturnReceipt {
  schema_version: "1.0";
  kind: "promotion_trial_candidate_campaign_return";
  campaign_id: string;
  handoff_id: string;
  source_revision: string;
  status: "adjudicated" | "review_return_blocked";
  passed: boolean;
  assigned_return_count: number;
  required_return_count: 3;
  returns: PromotionTrialCandidateCampaignReturnBinding[];
  input_sha256: {
    campaign_manifest: string;
    handoff_manifest: string;
  };
  adjudication: {
    attempted: boolean;
    passed: boolean;
    report_path: string | null;
    report_sha256: string | null;
    accepted_label_count: number;
    task_count: number;
    source_eligible_candidate_count: number;
  };
  validation_issues: PromotionTrialCandidateCampaignReturnIssue[];
  confirmatory_admitted: false;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  evidence_boundary: string;
}

export interface CollectPromotionTrialCandidateReviewCampaignResult {
  receipt: PromotionTrialCandidateCampaignReturnReceipt;
  output_dir: string;
  receipt_path: string;
  adjudication_path: string | null;
}

export interface PromotionTrialCandidateCampaignReturnInspection {
  passed: boolean;
  receipt: PromotionTrialCandidateCampaignReturnReceipt | null;
  issues: PromotionTrialCandidateCampaignReturnIssue[];
}

interface ReturnIdentity {
  participantId: string | null;
  handoffId: string | null;
}

export async function collectPromotionTrialCandidateReviewCampaign(
  input: CollectPromotionTrialCandidateReviewCampaignInput
): Promise<CollectPromotionTrialCandidateReviewCampaignResult> {
  if (input.annotationPaths.length !== 2) {
    throw new Error("Campaign return collection requires exactly two candidate annotation files.");
  }

  const cwd = await fs.realpath(path.resolve(input.cwd));
  const campaignRoot = await resolveDirectoryInside(cwd, input.campaignRoot, "Review campaign");
  const handoffRoot = await resolveDirectoryInside(cwd, input.handoffRoot, "Trial-candidate handoff");
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Campaign return output");
  if (isSameOrContainedPath(campaignRoot, outDir) || isSameOrContainedPath(handoffRoot, outDir)) {
    throw new Error("Campaign return output must stay outside the campaign and closed handoff.");
  }
  await assertFreshOutput(outDir);

  const campaignInspection = await inspectPromotionTrialCandidateReviewCampaign(campaignRoot);
  if (!campaignInspection.passed || !campaignInspection.manifest) {
    throw new Error(`Campaign return collection requires an integrity-valid campaign: ${campaignInspection.issues.map((issue) => issue.code).join(", ") || "unreadable"}.`);
  }
  const campaign = campaignInspection.manifest;
  const handoffInspection = await inspectPromotionTrialCandidateHandoff(handoffRoot);
  if (!handoffInspection.passed || !handoffInspection.manifest) {
    throw new Error(`Campaign return collection requires an integrity-valid handoff: ${handoffInspection.issues.map((issue) => issue.code).join(", ") || "unreadable"}.`);
  }
  const campaignManifestPath = path.join(
    campaignRoot,
    PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_MANIFEST
  );
  const handoffManifestPath = path.join(handoffRoot, PROMOTION_TRIAL_CANDIDATE_HANDOFF_MANIFEST);
  const campaignManifestBytes = await readRegularFile(campaignManifestPath, "Review campaign manifest");
  const handoffManifestBytes = await readRegularFile(handoffManifestPath, "Trial-candidate handoff manifest");
  if (!jsonBytesMatchValue(campaignManifestBytes, campaign)
      || !jsonBytesMatchValue(handoffManifestBytes, handoffInspection.manifest)) {
    throw new Error("A campaign or handoff manifest changed during return collection.");
  }
  validateCampaignHandoffBinding(campaign, handoffInspection.manifest, handoffManifestBytes);

  const annotationInputs = await Promise.all(input.annotationPaths.map((item, index) =>
    resolveFileInside(cwd, item, `Candidate annotation ${index + 1}`)));
  const licenseInput = await resolveFileInside(cwd, input.licenseReviewPath, "Source-license review");
  const resolutionInput = input.resolutionPath
    ? await resolveFileInside(cwd, input.resolutionPath, "Candidate review resolution")
    : null;
  const annotationSources = await Promise.all(annotationInputs.map(async (sourcePath, index) => {
    const bytes = await readRegularFile(sourcePath, `Candidate annotation ${index + 1}`);
    return { bytes, identity: parseReturnIdentity(bytes, "annotator_id") };
  }));
  const annotationIdentityCounts = new Map<string, number>();
  for (const source of annotationSources) {
    if (source.identity.participantId) {
      annotationIdentityCounts.set(
        source.identity.participantId,
        (annotationIdentityCounts.get(source.identity.participantId) || 0) + 1
      );
    }
  }

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  await fs.mkdir(outDir, { recursive: false });
  try {
    await fs.mkdir(path.join(outDir, "upstream"), { recursive: true });
    await fs.mkdir(path.join(outDir, "returns"), { recursive: true });
    await fs.writeFile(path.join(outDir, UPSTREAM_CAMPAIGN), campaignManifestBytes);
    await fs.writeFile(path.join(outDir, UPSTREAM_HANDOFF), handoffManifestBytes);

    const issues: PromotionTrialCandidateCampaignReturnIssue[] = [];
    const reviewerAssignments = campaign.assignments
      .filter((item): item is PromotionTrialCandidateReviewCampaignAssignment & {
        slot: "reviewer-a" | "reviewer-b";
      } => item.slot === "reviewer-a" || item.slot === "reviewer-b")
      .sort((left, right) => left.slot.localeCompare(right.slot));
    const licenseAssignment = campaign.assignments.find((item) => item.slot === "license-reviewer");
    if (reviewerAssignments.length !== 2 || !licenseAssignment) {
      throw new Error("Review campaign assignments are incomplete.");
    }

    const annotationReturns = await Promise.all(annotationSources.map(async ({ bytes, identity }, index) => {
      const expected = reviewerAssignments.find((item) => item.participant_id === identity.participantId);
      const duplicate = Boolean(identity.participantId)
        && annotationIdentityCounts.get(identity.participantId as string) !== 1;
      const slot = expected && !duplicate ? expected.slot : null;
      const target = path.join(
        outDir,
        "returns",
        slot ? `${slot}.json` : `unassigned-annotation-${index + 1}.json`
      );
      await fs.writeFile(target, bytes);
      const assignmentMatch = Boolean(expected) && !duplicate
        && identity.handoffId === campaign.handoff_id;
      if (!assignmentMatch) {
        issues.push({
          code: "trial_candidate_campaign_return_reviewer_assignment_mismatch",
          message: "Each candidate return must match one assigned reviewer and the campaign handoff.",
          ref: identity.participantId || `annotation-${index + 1}`
        });
      }
      return {
        binding: returnBinding({
          slot,
          identity,
          expectedParticipantId: expected?.participant_id || null,
          relativePath: portableRelative(outDir, target),
          bytes,
          assignmentMatch
        }),
        target,
        slot
      };
    }));

    const licenseBytes = await readRegularFile(licenseInput, "Source-license review");
    const licenseIdentity = parseReturnIdentity(licenseBytes, "reviewer_id");
    const licenseTarget = path.join(outDir, "returns", "license-reviewer.json");
    await fs.writeFile(licenseTarget, licenseBytes);
    const licenseMatch = licenseIdentity.participantId === licenseAssignment.participant_id
      && licenseIdentity.handoffId === campaign.handoff_id;
    if (!licenseMatch) {
      issues.push({
        code: "trial_candidate_campaign_return_license_assignment_mismatch",
        message: "The source-license return must match the assigned license reviewer and campaign handoff.",
        ref: licenseIdentity.participantId || "license-reviewer"
      });
    }
    const bindings: PromotionTrialCandidateCampaignReturnBinding[] = [
      ...annotationReturns.map((item) => item.binding),
      returnBinding({
        slot: "license-reviewer",
        identity: licenseIdentity,
        expectedParticipantId: licenseAssignment.participant_id,
        relativePath: portableRelative(outDir, licenseTarget),
        bytes: licenseBytes,
        assignmentMatch: licenseMatch
      })
    ];

    let resolutionTarget: string | null = null;
    if (resolutionInput) {
      const resolutionBytes = await readRegularFile(resolutionInput, "Candidate review resolution");
      const resolutionIdentity = parseReturnIdentity(resolutionBytes, "resolver_id");
      resolutionTarget = path.join(outDir, "returns", "resolution.json");
      await fs.writeFile(resolutionTarget, resolutionBytes);
      bindings.push(returnBinding({
        slot: "resolution",
        identity: resolutionIdentity,
        expectedParticipantId: null,
        relativePath: portableRelative(outDir, resolutionTarget),
        bytes: resolutionBytes,
        assignmentMatch: resolutionIdentity.handoffId === campaign.handoff_id
      }));
      if (resolutionIdentity.handoffId !== campaign.handoff_id) {
        issues.push({
          code: "trial_candidate_campaign_return_resolution_handoff_mismatch",
          message: "A resolution return must bind the same campaign handoff.",
          ref: resolutionIdentity.participantId || "resolution"
        });
      }
    }

    let adjudicationReport: PromotionTrialCandidateReviewAdjudicationReport | null = null;
    const orderedAnnotationTargets = reviewerAssignments.map((assignment) =>
      annotationReturns.find((item) => item.slot === assignment.slot)?.target || null);
    const assignmentsComplete = orderedAnnotationTargets.every((item) => Boolean(item))
      && licenseMatch
      && !issues.some((issue) => issue.code.includes("assignment_mismatch")
        || issue.code.includes("handoff_mismatch"));
    if (assignmentsComplete) {
      const orderedAnnotations = orderedAnnotationTargets.map((item) => item as string);
      const adjudication = await adjudicatePromotionTrialCandidateReview({
        cwd,
        handoffRoot,
        annotationPaths: orderedAnnotations,
        licenseReviewPath: licenseTarget,
        resolutionPath: resolutionTarget || undefined,
        outDir: path.join(outDir, ADJUDICATION_DIR)
      });
      adjudicationReport = adjudication.report;
      if (!adjudication.report.passed) {
        issues.push({
          code: "trial_candidate_campaign_return_adjudication_blocked",
          message: "Assigned return files did not pass trial-candidate adjudication."
        });
      }
    }

    const adjudicationReportPath = adjudicationReport
      ? path.join(outDir, ADJUDICATION_DIR, PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT)
      : null;
    const adjudicationEvidence = adjudicationReport?.passed
      ? await readAdjudicationSourceEligibility(path.join(outDir, ADJUDICATION_DIR))
      : { source_eligible_candidate_count: 0 };
    const passed = issues.length === 0 && adjudicationReport?.passed === true;
    const files = await inventoryRegularFiles(outDir, PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT);
    const receipt: PromotionTrialCandidateCampaignReturnReceipt = {
      schema_version: "1.0",
      kind: "promotion_trial_candidate_campaign_return",
      campaign_id: campaign.campaign_id,
      handoff_id: campaign.handoff_id,
      source_revision: campaign.source_revision,
      status: passed ? "adjudicated" : "review_return_blocked",
      passed,
      assigned_return_count: bindings.filter((item) =>
        item.slot !== "resolution" && item.assignment_match).length,
      required_return_count: 3,
      returns: bindings.sort((left, right) => left.path.localeCompare(right.path)),
      input_sha256: {
        campaign_manifest: sha256(campaignManifestBytes),
        handoff_manifest: sha256(handoffManifestBytes)
      },
      adjudication: {
        attempted: Boolean(adjudicationReport),
        passed: adjudicationReport?.passed === true,
        report_path: adjudicationReportPath
          ? portableRelative(outDir, adjudicationReportPath)
          : null,
        report_sha256: adjudicationReportPath
          ? await hashFile(adjudicationReportPath)
          : null,
        accepted_label_count: adjudicationReport?.accepted_label_count || 0,
        task_count: adjudicationReport?.task_count || campaign.candidate_count,
        source_eligible_candidate_count: adjudicationEvidence.source_eligible_candidate_count
      },
      validation_issues: issues,
      confirmatory_admitted: false,
      files,
      evidence_boundary: "This controller-side receipt binds a pristine review campaign, its assigned pseudonymous roles, the original handoff manifest, returned review bytes, and any adjudication outputs. A passing receipt validates structural return and adjudication contracts but does not prove real-world identity, reviewer expertise, legal authority, canonical curation, or confirmatory admission."
    };
    await writeJsonFile(path.join(outDir, PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT), receipt);
    const inspection = await inspectPromotionTrialCandidateCampaignReturn(outDir);
    if (!inspection.passed) {
      throw new Error(`Campaign return receipt failed self-inspection: ${inspection.issues.map((issue) => issue.code).join(", ")}.`);
    }
    return {
      receipt,
      output_dir: portableRef(cwd, outDir),
      receipt_path: portableRef(cwd, path.join(
        outDir,
        PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT
      )),
      adjudication_path: adjudicationReport
        ? portableRef(cwd, path.join(outDir, ADJUDICATION_DIR))
        : null
    };
  } catch (error) {
    await fs.rm(outDir, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectPromotionTrialCandidateCampaignReturn(
  rootPath: string
): Promise<PromotionTrialCandidateCampaignReturnInspection> {
  const root = path.resolve(rootPath);
  const issues: PromotionTrialCandidateCampaignReturnIssue[] = [];
  let receipt: PromotionTrialCandidateCampaignReturnReceipt;
  try {
    receipt = parseReceipt(JSON.parse(await fs.readFile(
      path.join(root, PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT),
      "utf8"
    )) as unknown);
  } catch {
    return {
      passed: false,
      receipt: null,
      issues: [{
        code: "trial_candidate_campaign_return_receipt_unreadable",
        message: "The campaign return receipt is missing or invalid."
      }]
    };
  }

  const observed = await inventoryRegularFiles(
    root,
    PROMOTION_TRIAL_CANDIDATE_CAMPAIGN_RETURN_RECEIPT
  ).catch(() => null);
  if (!observed || JSON.stringify(observed) !== JSON.stringify(receipt.files)) {
    issues.push({
      code: "trial_candidate_campaign_return_inventory_invalid",
      message: "Campaign return files are missing, changed, symlinked, or untracked."
    });
  }
  const campaignHash = await hashFile(path.join(root, UPSTREAM_CAMPAIGN)).catch(() => null);
  const handoffHash = await hashFile(path.join(root, UPSTREAM_HANDOFF)).catch(() => null);
  if (campaignHash !== receipt.input_sha256.campaign_manifest
      || handoffHash !== receipt.input_sha256.handoff_manifest) {
    issues.push({
      code: "trial_candidate_campaign_return_upstream_hash_mismatch",
      message: "A contained upstream campaign or handoff receipt changed."
    });
  }

  const upstream = await readContainedUpstream(root).catch(() => null);
  if (!upstream
      || upstream.campaign.campaign_id !== receipt.campaign_id
      || upstream.campaign.handoff_id !== receipt.handoff_id
      || upstream.campaign.source_revision !== receipt.source_revision
      || upstream.handoff.handoff_id !== receipt.handoff_id
      || upstream.handoff.source_revision !== receipt.source_revision
      || upstream.campaign.upstream_handoff_manifest_sha256
        !== receipt.input_sha256.handoff_manifest) {
    issues.push({
      code: "trial_candidate_campaign_return_upstream_binding_invalid",
      message: "Contained campaign, handoff, and receipt identities or hashes disagree."
    });
  }

  const expectedAssignments = new Map((upstream?.campaign.assignments || []).map((item) => [
    item.slot,
    item.participant_id
  ]));
  const returnPaths = new Set<string>();
  for (const binding of receipt.returns) {
    if (returnPaths.has(binding.path)) {
      issues.push({
        code: "trial_candidate_campaign_return_path_duplicate",
        message: "Each returned file must have one receipt binding.",
        ref: binding.path
      });
      continue;
    }
    returnPaths.add(binding.path);
    const observedHash = await hashContainedRegularFile(root, binding.path).catch(() => null);
    if (observedHash !== binding.sha256) {
      issues.push({
        code: "trial_candidate_campaign_return_file_hash_mismatch",
        message: "A returned file is missing, symlinked, or changed.",
        ref: binding.path
      });
    }
    const assignedSlot = binding.slot === "reviewer-a"
      || binding.slot === "reviewer-b"
      || binding.slot === "license-reviewer";
    const expectedParticipant = assignedSlot
      ? expectedAssignments.get(binding.slot as string) || null
      : null;
    const semanticMatch = binding.slot === "resolution"
      ? binding.handoff_id === receipt.handoff_id
      : assignedSlot
        && expectedParticipant !== null
        && binding.participant_id === expectedParticipant
        && binding.expected_participant_id === expectedParticipant
        && binding.handoff_id === receipt.handoff_id;
    if (binding.expected_participant_id !== expectedParticipant
        || binding.assignment_match !== semanticMatch) {
      issues.push({
        code: "trial_candidate_campaign_return_assignment_binding_invalid",
        message: "A return binding does not match the contained campaign assignment.",
        ref: binding.path
      });
    }
  }
  const assignedBindings = receipt.returns.filter((item) =>
    item.slot !== "resolution" && item.assignment_match);
  const assignedSlots = assignedBindings.map((item) => item.slot).sort();
  const requiredAssignedSlots = ["license-reviewer", "reviewer-a", "reviewer-b"];
  if (receipt.assigned_return_count !== assignedBindings.length
      || (assignedBindings.length === 3
        && JSON.stringify(assignedSlots) !== JSON.stringify(requiredAssignedSlots))) {
    issues.push({
      code: "trial_candidate_campaign_return_assignment_count_invalid",
      message: "Assigned return count and required campaign slots disagree."
    });
  }

  if (receipt.adjudication.attempted) {
    const adjudication = await inspectPromotionTrialCandidateReviewAdjudication(
      path.join(root, ADJUDICATION_DIR)
    );
    const reportHash = await hashFile(path.join(
      root,
      ADJUDICATION_DIR,
      PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT
    )).catch(() => null);
    const report = adjudication.report;
    const reviewerA = receipt.returns.find((item) => item.slot === "reviewer-a");
    const reviewerB = receipt.returns.find((item) => item.slot === "reviewer-b");
    const license = receipt.returns.find((item) => item.slot === "license-reviewer");
    const resolution = receipt.returns.find((item) => item.slot === "resolution");
    const sourceEligibility = report?.passed
      ? await readAdjudicationSourceEligibility(path.join(root, ADJUDICATION_DIR))
      : { source_eligible_candidate_count: 0 };
    if (!adjudication.passed || !report
        || report.handoff_id !== receipt.handoff_id
        || report.passed !== receipt.adjudication.passed
        || report.accepted_label_count !== receipt.adjudication.accepted_label_count
        || report.task_count !== receipt.adjudication.task_count
        || report.input_sha256.handoff_manifest !== receipt.input_sha256.handoff_manifest
        || JSON.stringify(report.input_sha256.annotations)
          !== JSON.stringify([reviewerA?.sha256 || null, reviewerB?.sha256 || null])
        || report.input_sha256.license_review !== (license?.sha256 || null)
        || report.input_sha256.resolution !== (resolution?.sha256 || null)
        || sourceEligibility.source_eligible_candidate_count
          !== receipt.adjudication.source_eligible_candidate_count
        || receipt.adjudication.report_path
          !== `${ADJUDICATION_DIR}/${PROMOTION_TRIAL_CANDIDATE_REVIEW_ADJUDICATION_REPORT}`
        || reportHash !== receipt.adjudication.report_sha256) {
      issues.push({
        code: "trial_candidate_campaign_return_adjudication_invalid",
        message: "The contained adjudication is missing, changed, or inconsistent with the receipt."
      });
    }
  } else if (receipt.adjudication.report_path !== null
      || receipt.adjudication.report_sha256 !== null
      || receipt.adjudication.passed
      || receipt.adjudication.accepted_label_count !== 0
      || receipt.adjudication.source_eligible_candidate_count !== 0) {
    issues.push({
      code: "trial_candidate_campaign_return_adjudication_state_invalid",
      message: "The receipt reports adjudication outputs without an attempted adjudication."
    });
  }
  if (receipt.passed !== (receipt.status === "adjudicated")
      || (receipt.passed && (!receipt.adjudication.passed
        || receipt.assigned_return_count !== receipt.required_return_count
        || receipt.validation_issues.length > 0))
      || (!receipt.passed && receipt.status !== "review_return_blocked")
      || (receipt.assigned_return_count < receipt.required_return_count
        && receipt.adjudication.attempted)) {
    issues.push({
      code: "trial_candidate_campaign_return_verdict_invalid",
      message: "Campaign return status, assignments, issues, and adjudication verdict disagree."
    });
  }
  return { passed: issues.length === 0, receipt, issues };
}

function validateCampaignHandoffBinding(
  campaign: PromotionTrialCandidateReviewCampaignManifest,
  handoff: PromotionTrialCandidateHandoffManifest,
  handoffBytes: Buffer
): void {
  if (handoff.handoff_id !== campaign.handoff_id
      || handoff.source_revision !== campaign.source_revision
      || sha256(handoffBytes) !== campaign.upstream_handoff_manifest_sha256) {
    throw new Error("Review campaign does not bind the supplied trial-candidate handoff.");
  }
}

function parseReturnIdentity(bytes: Buffer, participantField: string): ReturnIdentity {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    return {
      participantId: nonemptyString(value[participantField])
        ? value[participantField] as string
        : null,
      handoffId: nonemptyString(value.handoff_id) ? value.handoff_id : null
    };
  } catch {
    return { participantId: null, handoffId: null };
  }
}

function returnBinding(input: {
  slot: PromotionTrialCandidateCampaignReturnBinding["slot"];
  identity: ReturnIdentity;
  expectedParticipantId: string | null;
  relativePath: string;
  bytes: Buffer;
  assignmentMatch?: boolean;
}): PromotionTrialCandidateCampaignReturnBinding {
  return {
    slot: input.slot,
    participant_id: input.identity.participantId,
    expected_participant_id: input.expectedParticipantId,
    handoff_id: input.identity.handoffId,
    path: input.relativePath,
    sha256: sha256(input.bytes),
    assignment_match: input.assignmentMatch
      ?? Boolean(input.slot && input.identity.participantId === input.expectedParticipantId)
  };
}

async function readAdjudicationSourceEligibility(
  adjudicationRoot: string
): Promise<{ source_eligible_candidate_count: number }> {
  try {
    const value = JSON.parse(await fs.readFile(
      path.join(adjudicationRoot, PROMOTION_TRIAL_CANDIDATE_REVIEW_EVIDENCE),
      "utf8"
    )) as Record<string, unknown>;
    return {
      source_eligible_candidate_count: typeof value.source_eligible_candidate_count === "number"
        ? value.source_eligible_candidate_count
        : 0
    };
  } catch {
    return { source_eligible_candidate_count: 0 };
  }
}

async function inventoryRegularFiles(
  root: string,
  excludedRelativePath: string
): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = portableRelative(root, absolute);
      if (relative === excludedRelativePath) continue;
      const metadata = await fs.lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Campaign return output contains a symlink: ${relative}`);
      }
      if (metadata.isDirectory()) {
        await walk(absolute);
      } else if (metadata.isFile()) {
        files.push({ path: relative, bytes: metadata.size, sha256: await hashFile(absolute) });
      } else {
        throw new Error(`Campaign return output contains an unsupported entry: ${relative}`);
      }
    }
  }
  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function parseReceipt(value: unknown): PromotionTrialCandidateCampaignReturnReceipt {
  if (!isRecord(value)
      || value.schema_version !== "1.0"
      || value.kind !== "promotion_trial_candidate_campaign_return"
      || !nonemptyString(value.campaign_id)
      || !nonemptyString(value.handoff_id)
      || !nonemptyString(value.source_revision)
      || (value.status !== "adjudicated" && value.status !== "review_return_blocked")
      || typeof value.passed !== "boolean"
      || !nonnegativeInteger(value.assigned_return_count)
      || value.assigned_return_count > 3
      || value.required_return_count !== 3
      || !Array.isArray(value.returns)
      || (value.returns.length !== 3 && value.returns.length !== 4)
      || !value.returns.every(validReturnBinding)
      || !isRecord(value.input_sha256)
      || !sha256String(value.input_sha256.campaign_manifest)
      || !sha256String(value.input_sha256.handoff_manifest)
      || !isRecord(value.adjudication)
      || !validAdjudicationReceipt(value.adjudication)
      || !Array.isArray(value.validation_issues)
      || !value.validation_issues.every(validIssue)
      || value.confirmatory_admitted !== false
      || !Array.isArray(value.files)
      || !value.files.every(validInventoryEntry)
      || !nonemptyString(value.evidence_boundary)) {
    throw new Error("Invalid campaign return receipt.");
  }
  return value as unknown as PromotionTrialCandidateCampaignReturnReceipt;
}

async function readContainedUpstream(root: string): Promise<{
  campaign: {
    campaign_id: string;
    handoff_id: string;
    source_revision: string;
    upstream_handoff_manifest_sha256: string;
    assignments: Array<{ slot: string; participant_id: string }>;
  };
  handoff: { handoff_id: string; source_revision: string };
}> {
  const campaign = JSON.parse(await fs.readFile(path.join(root, UPSTREAM_CAMPAIGN), "utf8")) as unknown;
  const handoff = JSON.parse(await fs.readFile(path.join(root, UPSTREAM_HANDOFF), "utf8")) as unknown;
  if (!isRecord(campaign)
      || !nonemptyString(campaign.campaign_id)
      || !nonemptyString(campaign.handoff_id)
      || !nonemptyString(campaign.source_revision)
      || !sha256String(campaign.upstream_handoff_manifest_sha256)
      || !Array.isArray(campaign.assignments)
      || campaign.assignments.length !== 3
      || !campaign.assignments.every((item) => isRecord(item)
        && (item.slot === "reviewer-a"
          || item.slot === "reviewer-b"
          || item.slot === "license-reviewer")
        && nonemptyString(item.participant_id))
      || new Set(campaign.assignments.map((item) => (item as Record<string, unknown>).slot)).size !== 3
      || !isRecord(handoff)
      || !nonemptyString(handoff.handoff_id)
      || !nonemptyString(handoff.source_revision)) {
    throw new Error("Contained campaign or handoff manifest is invalid.");
  }
  return {
    campaign: campaign as unknown as {
      campaign_id: string;
      handoff_id: string;
      source_revision: string;
      upstream_handoff_manifest_sha256: string;
      assignments: Array<{ slot: string; participant_id: string }>;
    },
    handoff: handoff as unknown as { handoff_id: string; source_revision: string }
  };
}

function validReturnBinding(value: unknown): boolean {
  return isRecord(value)
    && (value.slot === null
      || value.slot === "reviewer-a"
      || value.slot === "reviewer-b"
      || value.slot === "license-reviewer"
      || value.slot === "resolution")
    && nullableNonemptyString(value.participant_id)
    && nullableNonemptyString(value.expected_participant_id)
    && nullableNonemptyString(value.handoff_id)
    && nonemptyString(value.path)
    && value.path.startsWith("returns/")
    && validPortableRelativePath(value.path)
    && sha256String(value.sha256)
    && typeof value.assignment_match === "boolean";
}

function validAdjudicationReceipt(value: Record<string, unknown>): boolean {
  return typeof value.attempted === "boolean"
    && typeof value.passed === "boolean"
    && (value.report_path === null
      || (nonemptyString(value.report_path) && validPortableRelativePath(value.report_path)))
    && (value.report_sha256 === null || sha256String(value.report_sha256))
    && nonnegativeInteger(value.accepted_label_count)
    && nonnegativeInteger(value.task_count)
    && nonnegativeInteger(value.source_eligible_candidate_count);
}

function validIssue(value: unknown): boolean {
  return isRecord(value)
    && nonemptyString(value.code)
    && nonemptyString(value.message)
    && (value.ref === undefined || nonemptyString(value.ref));
}

function validInventoryEntry(value: unknown): boolean {
  return isRecord(value)
    && nonemptyString(value.path)
    && validPortableRelativePath(value.path)
    && nonnegativeInteger(value.bytes)
    && sha256String(value.sha256);
}

async function hashContainedRegularFile(root: string, relativePath: string): Promise<string> {
  if (!validPortableRelativePath(relativePath)) {
    throw new Error("Contained file path is invalid.");
  }
  const target = path.resolve(root, relativePath);
  const real = await fs.realpath(target);
  if (path.relative(root, real).startsWith(`..${path.sep}`) || path.relative(root, real) === "..") {
    throw new Error("Contained file escapes the receipt root.");
  }
  const metadata = await fs.lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Contained file must be a regular file.");
  }
  return hashFile(target);
}

function validPortableRelativePath(value: string): boolean {
  return value !== ""
    && !value.includes("\\")
    && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && value !== "."
    && value !== ".."
    && !value.startsWith("../");
}

function nullableNonemptyString(value: unknown): boolean {
  return value === null || nonemptyString(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function jsonBytesMatchValue(bytes: Buffer, expected: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(bytes.toString("utf8")) as unknown)
      === JSON.stringify(expected);
  } catch {
    return false;
  }
}

async function resolveDirectoryInside(cwd: string, inputPath: string, label: string): Promise<string> {
  const resolved = path.resolve(cwd, inputPath);
  assertInside(cwd, resolved, label);
  const real = await fs.realpath(resolved);
  assertInside(cwd, real, label);
  const metadata = await fs.lstat(real);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory.`);
  return real;
}

async function resolveFileInside(cwd: string, inputPath: string, label: string): Promise<string> {
  const resolved = path.resolve(cwd, inputPath);
  assertInside(cwd, resolved, label);
  const lexicalMetadata = await fs.lstat(resolved);
  if (!lexicalMetadata.isFile() || lexicalMetadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a symlink.`);
  }
  const real = await fs.realpath(resolved);
  assertInside(cwd, real, label);
  const metadata = await fs.lstat(real);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file.`);
  return real;
}

async function readRegularFile(filePath: string, label: string): Promise<Buffer> {
  const metadata = await fs.lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file.`);
  }
  return fs.readFile(filePath);
}

async function assertFreshOutput(outDir: string): Promise<void> {
  try {
    await fs.lstat(outDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("Campaign return output already exists.");
}

function assertInside(cwd: string, candidate: string, label: string): void {
  const relative = path.relative(cwd, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
}

function assertStrictlyInside(cwd: string, candidate: string, label: string): void {
  assertInside(cwd, candidate, label);
}

function isSameOrContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function portableRef(cwd: string, target: string): string {
  return portableRelative(cwd, target);
}

function portableRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

async function hashFile(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
