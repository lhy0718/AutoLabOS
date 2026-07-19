import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { writeJsonFile } from "../../utils/fs.js";
import {
  PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_MANIFEST,
  inspectPromotionTrialCandidateReviewCampaign,
  type PromotionTrialCandidateReviewCampaignAssignment
} from "./promotionBenchmarkTrialCandidateReviewCampaign.js";

export const PROMOTION_TRIAL_CANDIDATE_REVIEW_DISTRIBUTION_MANIFEST =
  "review-distribution.json";

const CAMPAIGN_SLOTS = ["reviewer-a", "reviewer-b", "license-reviewer"] as const;
const PROCESS_TIMEOUT_MS = 120_000;
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;

type CampaignSlot = typeof CAMPAIGN_SLOTS[number];

export interface ExportPromotionTrialCandidateReviewDistributionInput {
  cwd: string;
  campaignRoot: string;
  outDir: string;
}

export interface PromotionTrialCandidateReviewDistributionPackage {
  slot: CampaignSlot;
  role: "initial_candidate_review" | "source_license_review";
  participant_id: string;
  archive_path: string;
  archive_sha256: string;
  archive_bytes: number;
  archive_entry_count: number;
  file_count: number;
  files: Array<{ path: string; sha256: string }>;
  single_role_root: true;
  regular_file_or_directory_entries_only: true;
  controller_content_present: false;
  peer_package_content_present: false;
  fresh_extraction_exact_tree_match: true;
}

export interface PromotionTrialCandidateReviewDistributionManifest {
  schema_version: "1.0";
  distribution_id: string;
  campaign_id: string;
  handoff_id: string;
  source_revision: string;
  source_campaign_manifest_sha256: string;
  status: "human_review_pending";
  packages: PromotionTrialCandidateReviewDistributionPackage[];
  human_annotation_completed_count: 0;
  human_license_review_completed: false;
  adjudication_completed: false;
  confirmatory_admitted: false;
  self_inspection_passed: true;
  evidence_boundary: string;
}

export interface PromotionTrialCandidateReviewDistributionIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionTrialCandidateReviewDistributionInspection {
  passed: boolean;
  manifest: PromotionTrialCandidateReviewDistributionManifest | null;
  issues: PromotionTrialCandidateReviewDistributionIssue[];
}

export interface ExportPromotionTrialCandidateReviewDistributionResult {
  distribution_id: string;
  campaign_id: string;
  handoff_id: string;
  output_dir: string;
  manifest_path: string;
  archive_paths: [string, string, string];
  package_count: 3;
  human_annotation_completed_count: 0;
  human_license_review_completed: false;
}

export async function exportPromotionTrialCandidateReviewDistribution(
  input: ExportPromotionTrialCandidateReviewDistributionInput
): Promise<ExportPromotionTrialCandidateReviewDistributionResult> {
  const cwd = path.resolve(input.cwd);
  const campaignRoot = path.resolve(cwd, input.campaignRoot);
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Review distribution output");
  if (isSameOrContainedPath(campaignRoot, outDir)) {
    throw new Error("Review distribution output must stay outside the closed campaign.");
  }
  if (await pathExists(outDir)) {
    throw new Error("Review distribution output already exists.");
  }

  const campaign = await inspectPromotionTrialCandidateReviewCampaign(campaignRoot);
  if (!campaign.passed || !campaign.manifest) {
    throw new Error(`Review distribution requires an integrity-valid campaign: ${campaign.issues.map((issue) => issue.code).join(", ") || "unreadable"}.`);
  }
  const campaignManifestPath = path.join(
    campaignRoot,
    PROMOTION_TRIAL_CANDIDATE_REVIEW_CAMPAIGN_MANIFEST
  );
  const campaignManifestSha256 = await hashFile(campaignManifestPath);
  const distributionId = `review-distribution-${sha256(Buffer.from([
    campaign.manifest.campaign_id,
    campaignManifestSha256
  ].join("\n"), "utf8")).slice(0, 24)}`;
  const stagingRoot = path.join(
    path.dirname(outDir),
    `.${path.basename(outDir)}.staging-${randomUUID()}`
  );
  const verificationRoot = path.join(stagingRoot, ".verification");
  await fs.mkdir(path.join(stagingRoot, "archives"), { recursive: true });

  try {
    const assignments = new Map(campaign.manifest.assignments.map((item) => [
      item.slot,
      item
    ]));
    const packages: PromotionTrialCandidateReviewDistributionPackage[] = [];
    for (const slot of CAMPAIGN_SLOTS) {
      const assignment = assignments.get(slot);
      if (!assignment) throw new Error(`Review campaign assignment is missing: ${slot}.`);
      packages.push(await archiveAssignment({
        campaignRoot,
        stagingRoot,
        verificationRoot,
        assignment
      }));
    }
    await fs.rm(verificationRoot, { recursive: true, force: true });

    const manifest: PromotionTrialCandidateReviewDistributionManifest = {
      schema_version: "1.0",
      distribution_id: distributionId,
      campaign_id: campaign.manifest.campaign_id,
      handoff_id: campaign.manifest.handoff_id,
      source_revision: campaign.manifest.source_revision,
      source_campaign_manifest_sha256: campaignManifestSha256,
      status: "human_review_pending",
      packages,
      human_annotation_completed_count: 0,
      human_license_review_completed: false,
      adjudication_completed: false,
      confirmatory_admitted: false,
      self_inspection_passed: true,
      evidence_boundary: "This distribution contains three role-isolated archives copied from one integrity-valid pending review campaign. Archive integrity and fresh extraction are verified, but no human judgment, reviewer independence, license conclusion, adjudication, or confirmatory admission is inferred."
    };
    await writeJsonFile(
      path.join(stagingRoot, PROMOTION_TRIAL_CANDIDATE_REVIEW_DISTRIBUTION_MANIFEST),
      manifest
    );
    const inspection = await inspectPromotionTrialCandidateReviewDistribution(stagingRoot);
    if (!inspection.passed) {
      throw new Error(`Review distribution failed self-inspection: ${inspection.issues.map((issue) => issue.code).join(", ")}.`);
    }
    await fs.rename(stagingRoot, outDir);

    return {
      distribution_id: distributionId,
      campaign_id: campaign.manifest.campaign_id,
      handoff_id: campaign.manifest.handoff_id,
      output_dir: portableRef(cwd, outDir),
      manifest_path: portableRef(
        cwd,
        path.join(outDir, PROMOTION_TRIAL_CANDIDATE_REVIEW_DISTRIBUTION_MANIFEST)
      ),
      archive_paths: packages.map((item) => portableRef(
        cwd,
        path.join(outDir, item.archive_path)
      )) as [string, string, string],
      package_count: 3,
      human_annotation_completed_count: 0,
      human_license_review_completed: false
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectPromotionTrialCandidateReviewDistribution(
  rootPath: string
): Promise<PromotionTrialCandidateReviewDistributionInspection> {
  const root = path.resolve(rootPath);
  const issues: PromotionTrialCandidateReviewDistributionIssue[] = [];
  let manifest: PromotionTrialCandidateReviewDistributionManifest;
  try {
    manifest = parseDistributionManifest(JSON.parse(await fs.readFile(
      path.join(root, PROMOTION_TRIAL_CANDIDATE_REVIEW_DISTRIBUTION_MANIFEST),
      "utf8"
    )) as unknown);
  } catch {
    return {
      passed: false,
      manifest: null,
      issues: [{
        code: "trial_candidate_review_distribution_manifest_unreadable",
        message: "The review distribution manifest is missing or invalid."
      }]
    };
  }

  const expectedOutputFiles = new Set([
    PROMOTION_TRIAL_CANDIDATE_REVIEW_DISTRIBUTION_MANIFEST,
    ...manifest.packages.map((item) => item.archive_path)
  ]);
  const observedOutputFiles = await inventoryRegularFiles(root).catch(() => null);
  if (!observedOutputFiles
      || observedOutputFiles.length !== expectedOutputFiles.size
      || observedOutputFiles.some((item) => !expectedOutputFiles.has(item.path))) {
    issues.push({
      code: "trial_candidate_review_distribution_inventory_invalid",
      message: "The distribution may contain only its manifest and three declared archives."
    });
  }

  const verificationRoot = path.join(
    path.dirname(root),
    `.${path.basename(root)}.inspection-${randomUUID()}`
  );
  try {
    await fs.mkdir(verificationRoot, { recursive: true });
    for (const item of manifest.packages) {
      const archivePath = path.join(root, item.archive_path);
      const stat = await fs.lstat(archivePath).catch(() => null);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size === 0
          || stat.size !== item.archive_bytes
          || await hashFile(archivePath).catch(() => "") !== item.archive_sha256) {
        issues.push({
          code: "trial_candidate_review_distribution_archive_invalid",
          message: "A role archive is missing, changed, or not a regular file.",
          ref: item.slot
        });
        continue;
      }
      const entries = await listArchive(archivePath).catch(() => null);
      const safeEntryTypes = entries
        ? await archiveHasOnlyRegularFilesAndDirectories(archivePath, entries.length)
          .catch(() => false)
        : false;
      const isolation = entries ? inspectArchiveEntries(entries, item.slot) : null;
      if (!entries || !isolation
          || entries.length !== item.archive_entry_count
          || isolation.single_role_root !== item.single_role_root
          || safeEntryTypes !== item.regular_file_or_directory_entries_only
          || isolation.controller_content_present !== item.controller_content_present
          || isolation.peer_package_content_present !== item.peer_package_content_present) {
        issues.push({
          code: "trial_candidate_review_distribution_isolation_invalid",
          message: "A role archive is not confined to its assigned package root.",
          ref: item.slot
        });
        continue;
      }
      const extractRoot = path.join(verificationRoot, item.slot);
      await fs.mkdir(extractRoot, { recursive: true });
      await extractArchive(archivePath, extractRoot);
      const extracted = await inventoryRegularFiles(path.join(extractRoot, item.slot))
        .catch(() => null);
      if (!extracted
          || JSON.stringify(extracted) !== JSON.stringify(item.files)
          || extracted.length !== item.file_count
          || item.fresh_extraction_exact_tree_match !== true) {
        issues.push({
          code: "trial_candidate_review_distribution_extraction_invalid",
          message: "Fresh extraction does not match the hash-bound source package tree.",
          ref: item.slot
        });
      }
    }
  } finally {
    await fs.rm(verificationRoot, { recursive: true, force: true });
  }

  return { passed: issues.length === 0, manifest, issues };
}

async function archiveAssignment(input: {
  campaignRoot: string;
  stagingRoot: string;
  verificationRoot: string;
  assignment: PromotionTrialCandidateReviewCampaignAssignment;
}): Promise<PromotionTrialCandidateReviewDistributionPackage> {
  const slot = input.assignment.slot as CampaignSlot;
  const sourceRoot = path.join(input.campaignRoot, input.assignment.package_root);
  const files = await inventoryRegularFiles(sourceRoot);
  const archiveRelativePath = `archives/${slot}.tar.gz`;
  const archivePath = path.join(input.stagingRoot, archiveRelativePath);
  await runProcess("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--mode=u+rwX,go=rX",
    "--format=ustar",
    "-czf",
    archivePath,
    "-C",
    input.campaignRoot,
    slot
  ]);
  const entries = await listArchive(archivePath);
  if (!await archiveHasOnlyRegularFilesAndDirectories(archivePath, entries.length)) {
    throw new Error(`Review distribution archive contains an unsafe entry type: ${slot}.`);
  }
  const isolation = inspectArchiveEntries(entries, slot);
  if (!isolation.single_role_root
      || isolation.controller_content_present
      || isolation.peer_package_content_present) {
    throw new Error(`Review distribution archive isolation failed: ${slot}.`);
  }
  const extractRoot = path.join(input.verificationRoot, slot);
  await fs.mkdir(extractRoot, { recursive: true });
  await extractArchive(archivePath, extractRoot);
  const extracted = await inventoryRegularFiles(path.join(extractRoot, slot));
  if (JSON.stringify(extracted) !== JSON.stringify(files)) {
    throw new Error(`Review distribution fresh extraction changed package bytes: ${slot}.`);
  }
  const stat = await fs.stat(archivePath);
  return {
    slot,
    role: input.assignment.role,
    participant_id: input.assignment.participant_id,
    archive_path: archiveRelativePath,
    archive_sha256: await hashFile(archivePath),
    archive_bytes: stat.size,
    archive_entry_count: entries.length,
    file_count: files.length,
    files,
    single_role_root: true,
    regular_file_or_directory_entries_only: true,
    controller_content_present: false,
    peer_package_content_present: false,
    fresh_extraction_exact_tree_match: true
  };
}

function inspectArchiveEntries(entries: string[], slot: CampaignSlot): {
  single_role_root: boolean;
  controller_content_present: boolean;
  peer_package_content_present: boolean;
} {
  const normalized = entries.map((entry) => entry.replace(/\/$/u, ""));
  const safe = normalized.length > 0 && normalized.every((entry) =>
    entry === slot
      || (entry.startsWith(`${slot}/`)
        && !path.isAbsolute(entry)
        && !entry.includes("\\")
        && !entry.includes("\n")
        && !entry.includes("\r")
        && !entry.split("/").includes("..")));
  const components = normalized.flatMap((entry) => entry.split("/"));
  return {
    single_role_root: safe,
    controller_content_present: components.includes("controller"),
    peer_package_content_present: CAMPAIGN_SLOTS
      .filter((candidate) => candidate !== slot)
      .some((candidate) => components.includes(candidate))
  };
}

async function listArchive(archivePath: string): Promise<string[]> {
  const output = (await runProcess("tar", ["-tzf", archivePath])).toString("utf8");
  const entries = output.split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) throw new Error("Review distribution archive is empty.");
  return entries;
}

async function archiveHasOnlyRegularFilesAndDirectories(
  archivePath: string,
  expectedEntryCount: number
): Promise<boolean> {
  const output = (await runProcess("tar", ["-tvzf", archivePath])).toString("utf8");
  const lines = output.split(/\r?\n/u).filter(Boolean);
  return lines.length === expectedEntryCount
    && lines.every((line) => line.startsWith("-") || line.startsWith("d"));
}

async function extractArchive(archivePath: string, extractRoot: string): Promise<void> {
  await runProcess("tar", [
    "-xzf",
    archivePath,
    "--no-same-owner",
    "--no-same-permissions",
    "--delay-directory-restore",
    "-C",
    extractRoot
  ]);
}

async function inventoryRegularFiles(
  root: string
): Promise<Array<{ path: string; sha256: string }>> {
  const files: Array<{ path: string; sha256: string }> = [];
  async function visit(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Symlinks are not allowed in review distributions.");
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) throw new Error("Only regular files are allowed in review distributions.");
      const relative = path.relative(root, absolute).replace(/\\/gu, "/");
      if (!safeRelativePath(relative) || relative.includes("\n") || relative.includes("\r")) {
        throw new Error("Review distribution contains an unsafe file path.");
      }
      files.push({ path: relative, sha256: await hashFile(absolute) });
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function parseDistributionManifest(
  value: unknown
): PromotionTrialCandidateReviewDistributionManifest {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "distribution_id", "campaign_id", "handoff_id",
        "source_revision", "source_campaign_manifest_sha256", "status",
        "packages", "human_annotation_completed_count",
        "human_license_review_completed", "adjudication_completed",
        "confirmatory_admitted", "self_inspection_passed", "evidence_boundary"
      ])
      || value.schema_version !== "1.0"
      || !validId(value.distribution_id)
      || !validId(value.campaign_id)
      || !validId(value.handoff_id)
      || !nonEmptyString(value.source_revision)
      || !sha256String(value.source_campaign_manifest_sha256)
      || value.status !== "human_review_pending"
      || !Array.isArray(value.packages)
      || value.packages.length !== 3
      || value.human_annotation_completed_count !== 0
      || value.human_license_review_completed !== false
      || value.adjudication_completed !== false
      || value.confirmatory_admitted !== false
      || value.self_inspection_passed !== true
      || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Invalid review distribution manifest.");
  }
  const packages = value.packages.map(parseDistributionPackage);
  if (JSON.stringify(packages.map((item) => item.slot))
      !== JSON.stringify([...CAMPAIGN_SLOTS])
      || new Set(packages.map((item) => item.participant_id)).size !== 3) {
    throw new Error("Invalid review distribution role separation.");
  }
  return {
    ...(value as unknown as PromotionTrialCandidateReviewDistributionManifest),
    packages
  };
}

function parseDistributionPackage(
  value: unknown
): PromotionTrialCandidateReviewDistributionPackage {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "slot", "role", "participant_id", "archive_path", "archive_sha256",
        "archive_bytes", "archive_entry_count", "file_count", "files",
        "single_role_root", "regular_file_or_directory_entries_only",
        "controller_content_present",
        "peer_package_content_present", "fresh_extraction_exact_tree_match"
      ])) {
    throw new Error("Invalid review distribution package.");
  }
  const slot = value.slot;
  if (!CAMPAIGN_SLOTS.includes(slot as CampaignSlot)
      || value.role !== (slot === "license-reviewer"
        ? "source_license_review"
        : "initial_candidate_review")
      || !validId(value.participant_id)
      || value.archive_path !== `archives/${slot}.tar.gz`
      || !sha256String(value.archive_sha256)
      || !positiveInteger(value.archive_bytes)
      || !positiveInteger(value.archive_entry_count)
      || !positiveInteger(value.file_count)
      || !Array.isArray(value.files)
      || value.files.length !== value.file_count
      || value.single_role_root !== true
      || value.regular_file_or_directory_entries_only !== true
      || value.controller_content_present !== false
      || value.peer_package_content_present !== false
      || value.fresh_extraction_exact_tree_match !== true) {
    throw new Error("Invalid review distribution package fields.");
  }
  const files = value.files.map(parseFileBinding);
  if (new Set(files.map((item) => item.path)).size !== files.length) {
    throw new Error("Review distribution file bindings must be unique.");
  }
  return {
    ...(value as unknown as PromotionTrialCandidateReviewDistributionPackage),
    slot: slot as CampaignSlot,
    files
  };
}

function parseFileBinding(value: unknown): { path: string; sha256: string } {
  if (!isRecord(value)
      || !hasExactKeys(value, ["path", "sha256"])
      || !safeRelativePath(value.path)
      || value.path.includes("\n")
      || value.path.includes("\r")
      || !sha256String(value.sha256)) {
    throw new Error("Invalid review distribution file binding.");
  }
  return { path: value.path, sha256: value.sha256 };
}

async function runProcess(command: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} exceeded the bounded process timeout.`));
    }, PROCESS_TIMEOUT_MS);
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGKILL");
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

function portableRef(cwd: string, target: string): string {
  return path.relative(cwd, target).replace(/\\/gu, "/");
}

async function hashFile(target: string): Promise<string> {
  return sha256(await fs.readFile(target));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true).catch(() => false);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
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
  return Number.isInteger(value) && Number(value) > 0;
}
