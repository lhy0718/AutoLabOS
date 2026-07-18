import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonFile } from "../utils/fs.js";

export const REFERENCE_CLAIM_REVIEW_MANIFEST = "reference-claim-review-manifest.json";
export const REFERENCE_CLAIM_REVIEW_TASKS = "reviewer/claim-review-tasks.jsonl";
export const REFERENCE_CLAIM_REVIEW_TEMPLATE = "reviewer/review-template.json";
export const REFERENCE_CLAIM_REVIEW_GUIDE = "reviewer/REVIEWER_GUIDE.md";
export const REFERENCE_CLAIM_REVIEW_PREFLIGHT = "reference-claim-review-preflight.json";
export const REFERENCE_CLAIM_REVIEW_APPROVAL_TEMPLATE = "final-approval-template.json";
export const REFERENCE_CLAIM_REVIEW_IMPORT = "reference-claim-review-import.json";
export const REFERENCE_CLAIM_REVIEW_IMPORTED_CLAIMS = "refgate_claims.reviewed.tsv";
export const REFERENCE_CLAIM_REVIEW_PRIVATE_DISTRIBUTION =
  "reference-claim-review-private-distribution.json";
export const REFERENCE_CLAIM_REVIEW_SOURCE_README = "reviewer/SOURCE_README.md";

const REVIEW_SOURCE_EXTENSIONS = [".pdf", ".txt"] as const;

const CLAIM_COLUMNS = [
  "claim_id",
  "manuscript_location",
  "claim_text",
  "citation_key",
  "source_location",
  "quote_or_evidence",
  "evidence_kind",
  "status",
  "notes",
  "claim_type",
  "importance"
] as const;

export const REFERENCE_CLAIM_REVIEW_DECISIONS = [
  "supported",
  "rewrite",
  "wrong_source",
  "missing_source"
] as const;

export type ReferenceClaimReviewDecision =
  typeof REFERENCE_CLAIM_REVIEW_DECISIONS[number];

export interface ReferenceClaimRow {
  claim_id: string;
  manuscript_location: string;
  claim_text: string;
  citation_key: string;
  source_location: string;
  quote_or_evidence: string;
  evidence_kind: string;
  status: string;
  notes: string;
  claim_type: string;
  importance: string;
}

export interface ReferenceClaimReviewTask {
  task_id: string;
  manuscript_location: string;
  claim_text: string;
  citation_key: string;
  source_title: string;
  record_url: string;
  full_text_sha256: string;
  candidate_source_location: string;
  candidate_evidence: string;
  evidence_kind: string;
}

interface ReferenceClaimReviewManifest {
  schema_version: "1.0";
  handoff_id: string;
  manuscript_ref: string;
  source_inputs: Array<{ role: "claims" | "status" | "lock"; ref: string; sha256: string }>;
  task_count: number;
  missing_full_text_claim_count: number;
  missing_full_text_claims: Array<{
    claim_id: string;
    citation_key: string;
    source_title?: string;
    record_url: string;
  }>;
  reviewer_root: "reviewer";
  files: Array<{ path: string; sha256: string }>;
  evidence_boundary: string;
}

export interface PrepareReferenceClaimReviewInput {
  cwd: string;
  claimsPath: string;
  statusPath: string;
  lockPath: string;
  outDir: string;
}

export interface PrepareReferenceClaimReviewResult {
  handoff_id: string;
  task_count: number;
  missing_full_text_claim_count: number;
  output_dir: string;
  manifest_path: string;
  template_path: string;
}

export interface PreflightReferenceClaimReviewInput {
  cwd: string;
  packetRoot: string;
  reviewPath: string;
  outDir: string;
}

export interface PrepareReferenceClaimReviewPrivateDistributionInput {
  cwd: string;
  packetRoot: string;
  sourceDir: string;
  outDir: string;
}

interface ReferenceClaimReviewPrivateDistributionManifest {
  schema_version: "1.0";
  distribution_id: string;
  handoff_id: string;
  upstream_manifest_sha256: string;
  distribution_scope: "private_review_only";
  public_distribution_allowed: false;
  license_review_status: "not_assessed";
  reviewer_root: "reviewer";
  source_count: number;
  sources: Array<{
    citation_key: string;
    path: string;
    format: "pdf" | "txt";
    sha256: string;
  }>;
  files: Array<{ path: string; sha256: string }>;
  evidence_boundary: string;
}

export interface PrepareReferenceClaimReviewPrivateDistributionResult {
  distribution_id: string;
  handoff_id: string;
  source_count: number;
  output_dir: string;
  manifest_path: string;
  review_template_path: string;
}

export interface ReferenceClaimReviewPreflightReport {
  schema_version: "1.0";
  handoff_id: string;
  preflight_passed: boolean;
  claim_gate_passed: boolean;
  reviewer_id: string | null;
  task_count: number;
  reviewed_task_count: number;
  decision_counts: Record<ReferenceClaimReviewDecision, number>;
  issues: Array<{ code: string; detail: string }>;
  review_sha256: string;
  human_identity_verified: false;
  claim_statuses_modified: false;
  evidence_boundary: string;
}

export interface PreflightReferenceClaimReviewResult {
  report: ReferenceClaimReviewPreflightReport;
  report_path: string;
  summary_path: string;
  approval_template_path: string;
}

export interface ImportReferenceClaimReviewInput {
  cwd: string;
  packetRoot: string;
  reviewPath: string;
  preflightReportPath: string;
  approvalPath: string;
  claimsPath: string;
  outDir: string;
}

export interface ReferenceClaimReviewImportReceipt {
  schema_version: "1.0";
  import_id: string;
  handoff_id: string;
  reviewer_id: string;
  approver_id: string;
  packet_manifest_sha256: string;
  source_claims_sha256: string;
  review_sha256: string;
  preflight_report_sha256: string;
  approval_sha256: string;
  imported_claims_sha256: string;
  reviewed_claim_count: number;
  checked_claim_count: number;
  remaining_unchecked_claim_count: number;
  remaining_unchecked_claim_ids: string[];
  review_decision_counts: Record<ReferenceClaimReviewDecision, number>;
  reviewed_claim_gate_passed: true;
  submission_claim_gate_passed: boolean;
  human_identity_verified: false;
  source_claim_statuses_modified: false;
  output_claim_statuses_updated: true;
  evidence_boundary: string;
}

export interface ImportReferenceClaimReviewResult {
  receipt: ReferenceClaimReviewImportReceipt;
  receipt_path: string;
  claims_path: string;
  summary_path: string;
}

export async function prepareReferenceClaimReview(
  input: PrepareReferenceClaimReviewInput
): Promise<PrepareReferenceClaimReviewResult> {
  const cwd = path.resolve(input.cwd);
  const claimsPath = path.resolve(cwd, input.claimsPath);
  const statusPath = path.resolve(cwd, input.statusPath);
  const lockPath = path.resolve(cwd, input.lockPath);
  const outDir = path.resolve(cwd, input.outDir);
  await assertFreshOutput(outDir, "Reference claim review handoff");

  const [claimsBytes, statusBytes, lockBytes] = await Promise.all([
    readRegularFile(claimsPath),
    readRegularFile(statusPath),
    readRegularFile(lockPath)
  ]);
  const claims = parseReferenceClaimsTsv(claimsBytes.toString("utf8"));
  const status = parseEvidenceStatus(JSON.parse(statusBytes.toString("utf8")) as unknown);
  const lock = parseLockEntries(JSON.parse(lockBytes.toString("utf8")) as unknown);
  const statusByKey = new Map(status.sources.map((source) => [source.citation_key, source]));
  const lockByKey = new Map(lock.map((entry) => [entry.citation_key, entry]));
  const claimIds = new Set<string>();
  const tasks: ReferenceClaimReviewTask[] = [];
  const missing: ReferenceClaimReviewManifest["missing_full_text_claims"] = [];

  for (const claim of claims) {
    if (claimIds.has(claim.claim_id)) {
      throw new Error(`Duplicate reference claim id: ${claim.claim_id}`);
    }
    claimIds.add(claim.claim_id);
    const source = statusByKey.get(claim.citation_key);
    const lockEntry = lockByKey.get(claim.citation_key);
    if (!source || !lockEntry) {
      throw new Error(`Reference claim has no bound source metadata: ${claim.claim_id}`);
    }
    if (!source.claim_ids.includes(claim.claim_id)) {
      throw new Error(`Reference evidence status does not bind claim ${claim.claim_id}.`);
    }
    if (source.full_text_status === "missing") {
      missing.push({
        claim_id: claim.claim_id,
        citation_key: claim.citation_key,
        source_title: lockEntry.title,
        record_url: source.record_url
      });
      continue;
    }
    if (claim.status !== "needs_review"
        || !nonEmpty(claim.source_location)
        || !nonEmpty(claim.quote_or_evidence)
        || !nonEmpty(source.pdf_sha256)) {
      throw new Error(`Mapped reference claim is not ready for independent review: ${claim.claim_id}`);
    }
    tasks.push({
      task_id: claim.claim_id,
      manuscript_location: claim.manuscript_location,
      claim_text: claim.claim_text,
      citation_key: claim.citation_key,
      source_title: lockEntry.title,
      record_url: source.record_url,
      full_text_sha256: source.pdf_sha256 as string,
      candidate_source_location: claim.source_location,
      candidate_evidence: claim.quote_or_evidence,
      evidence_kind: claim.evidence_kind
    });
  }

  if (tasks.length === 0) throw new Error("Reference claim review handoff requires at least one mapped evidence candidate.");
  if (status.summary.citation_bearing_claim_count !== claims.length
      || status.summary.full_text_evidence_candidate_count !== tasks.length
      || status.summary.missing_full_text_claim_count !== missing.length) {
    throw new Error("Reference evidence status summary does not match the claim inventory.");
  }

  const inputHashes = [
    { role: "claims" as const, ref: path.basename(claimsPath), sha256: sha256(claimsBytes) },
    { role: "status" as const, ref: path.basename(statusPath), sha256: sha256(statusBytes) },
    { role: "lock" as const, ref: path.basename(lockPath), sha256: sha256(lockBytes) }
  ];
  const handoffId = `reference-claim-review-${sha256(Buffer.from(
    inputHashes.map((item) => item.sha256).join(":"),
    "utf8"
  )).slice(0, 16)}`;
  const reviewerDir = path.join(outDir, "reviewer");
  await fs.mkdir(reviewerDir, { recursive: true });

  const tasksPath = path.join(outDir, REFERENCE_CLAIM_REVIEW_TASKS);
  const templatePath = path.join(outDir, REFERENCE_CLAIM_REVIEW_TEMPLATE);
  const guidePath = path.join(outDir, REFERENCE_CLAIM_REVIEW_GUIDE);
  await fs.writeFile(
    tasksPath,
    tasks.map((task) => JSON.stringify(task)).join("\n") + "\n",
    "utf8"
  );
  await writeJsonFile(templatePath, {
    schema_version: "1.0",
    handoff_id: handoffId,
    reviewer_id: null,
    label_source: "human",
    review_role: "independent_claim_review",
    independence_attestation: {
      completed_by_human: false,
      reviewer_did_not_generate_evidence_candidates: false,
      full_source_text_inspected: false
    },
    reviews: tasks.map((task) => ({
      task_id: task.task_id,
      decision: null,
      source_location: null,
      supporting_passage: null,
      proposed_claim_text: null,
      rationale: null
    }))
  });
  await fs.writeFile(guidePath, reviewerGuide(), "utf8");

  const files = await Promise.all([
    REFERENCE_CLAIM_REVIEW_TASKS,
    REFERENCE_CLAIM_REVIEW_TEMPLATE,
    REFERENCE_CLAIM_REVIEW_GUIDE
  ].map(async (relativePath) => ({
    path: relativePath,
    sha256: sha256(await readContainedRegularFile(outDir, path.join(outDir, relativePath)))
  })));
  const manifest: ReferenceClaimReviewManifest = {
    schema_version: "1.0",
    handoff_id: handoffId,
    manuscript_ref: status.manuscript,
    source_inputs: inputHashes,
    task_count: tasks.length,
    missing_full_text_claim_count: missing.length,
    missing_full_text_claims: missing,
    reviewer_root: "reviewer",
    files,
    evidence_boundary: "This packet binds full-text evidence candidates to manuscript claims for independent human review. It contains no third-party PDF, no completed human judgment, no verified reviewer identity, no checked claim, and no paper-readiness decision. Missing full texts remain blocking and are not converted into review tasks."
  };
  const manifestPath = path.join(outDir, REFERENCE_CLAIM_REVIEW_MANIFEST);
  await writeJsonFile(manifestPath, manifest);
  return {
    handoff_id: handoffId,
    task_count: tasks.length,
    missing_full_text_claim_count: missing.length,
    output_dir: portableRef(cwd, outDir),
    manifest_path: portableRef(cwd, manifestPath),
    template_path: portableRef(cwd, templatePath)
  };
}

export async function prepareReferenceClaimReviewPrivateDistribution(
  input: PrepareReferenceClaimReviewPrivateDistributionInput
): Promise<PrepareReferenceClaimReviewPrivateDistributionResult> {
  const cwd = path.resolve(input.cwd);
  const packetRoot = path.resolve(cwd, input.packetRoot);
  const sourceDir = path.resolve(cwd, input.sourceDir);
  const outDir = path.resolve(cwd, input.outDir);
  await assertFreshOutput(outDir, "Private reference claim review distribution");

  const handoff = await inspectPacket(packetRoot);
  const tasks = parseTaskJsonl((await readContainedRegularFile(
    packetRoot,
    path.join(packetRoot, REFERENCE_CLAIM_REVIEW_TASKS)
  )).toString("utf8"));
  const sources = await collectBoundReviewSources(sourceDir, tasks);
  const copiedFiles = new Map<string, Buffer>();
  const handoffPaths = [
    REFERENCE_CLAIM_REVIEW_MANIFEST,
    ...handoff.files.map((file) => file.path)
  ];
  for (const relativePath of handoffPaths) {
    copiedFiles.set(relativePath, await readContainedRegularFile(
      packetRoot,
      path.join(packetRoot, relativePath)
    ));
  }

  const sourceRecords = sources.map((source) => ({
    citation_key: source.citationKey,
    path: `reviewer/sources/${source.citationKey}${source.extension}`,
    format: source.extension.slice(1) as "pdf" | "txt",
    sha256: source.sha256
  }));
  copiedFiles.set(
    REFERENCE_CLAIM_REVIEW_SOURCE_README,
    Buffer.from(renderPrivateSourceReadme(
      sourceRecords,
      handoff.missing_full_text_claims
    ), "utf8")
  );
  for (const [index, source] of sources.entries()) {
    copiedFiles.set(sourceRecords[index].path, source.bytes);
  }

  const upstreamManifestBytes = copiedFiles.get(REFERENCE_CLAIM_REVIEW_MANIFEST);
  if (!upstreamManifestBytes) throw new Error("Reference claim review manifest was not copied.");
  const files = [...copiedFiles.entries()]
    .map(([relativePath, bytes]) => ({ path: relativePath, sha256: sha256(bytes) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const distributionId = `reference-claim-review-distribution-${sha256(Buffer.from([
    sha256(upstreamManifestBytes),
    ...sourceRecords.map((source) => `${source.path}:${source.sha256}`)
  ].join(":"), "utf8")).slice(0, 16)}`;
  const distribution: ReferenceClaimReviewPrivateDistributionManifest = {
    schema_version: "1.0",
    distribution_id: distributionId,
    handoff_id: handoff.handoff_id,
    upstream_manifest_sha256: sha256(upstreamManifestBytes),
    distribution_scope: "private_review_only",
    public_distribution_allowed: false,
    license_review_status: "not_assessed",
    reviewer_root: "reviewer",
    source_count: sourceRecords.length,
    sources: sourceRecords,
    files,
    evidence_boundary: "This closed packet includes hash-bound third-party full text solely for private independent review. It does not establish redistribution rights, verify reviewer identity, complete missing-source claims, modify claim status, or make the manuscript paper-ready. Do not publish this distribution without a separate license review."
  };

  await fs.mkdir(outDir, { recursive: true });
  for (const [relativePath, bytes] of copiedFiles) {
    const target = path.join(outDir, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  const manifestPath = path.join(outDir, REFERENCE_CLAIM_REVIEW_PRIVATE_DISTRIBUTION);
  await writeJsonFile(manifestPath, distribution);
  await inspectPacket(outDir);

  return {
    distribution_id: distributionId,
    handoff_id: handoff.handoff_id,
    source_count: sourceRecords.length,
    output_dir: portableRef(cwd, outDir),
    manifest_path: portableRef(cwd, manifestPath),
    review_template_path: portableRef(cwd, path.join(outDir, REFERENCE_CLAIM_REVIEW_TEMPLATE))
  };
}

export async function preflightReferenceClaimReview(
  input: PreflightReferenceClaimReviewInput
): Promise<PreflightReferenceClaimReviewResult> {
  const cwd = path.resolve(input.cwd);
  const packetRoot = path.resolve(cwd, input.packetRoot);
  const reviewPath = path.resolve(cwd, input.reviewPath);
  const outDir = path.resolve(cwd, input.outDir);
  await assertFreshOutput(outDir, "Reference claim review preflight");
  const evaluation = await inspectReferenceClaimReviewReturn(packetRoot, reviewPath);
  const { report, tasks } = evaluation;
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, REFERENCE_CLAIM_REVIEW_PREFLIGHT);
  const summaryPath = path.join(outDir, "reference-claim-review-preflight.md");
  const approvalTemplatePath = path.join(outDir, REFERENCE_CLAIM_REVIEW_APPROVAL_TEMPLATE);
  await writeJsonFile(reportPath, report);
  const reportSha256 = sha256(await readRegularFile(reportPath));
  await writeJsonFile(approvalTemplatePath, {
    schema_version: "1.0",
    handoff_id: report.handoff_id,
    review_sha256: report.review_sha256,
    preflight_report_sha256: reportSha256,
    approver_id: null,
    approval_role: "final_reference_claim_approver",
    approval_attestation: {
      completed_by_human: false,
      reviewed_complete_return: false,
      authorizes_checked_status: false,
      accepts_evidence_boundary: false
    },
    approved_task_ids: tasks.map((task) => task.task_id),
    rationale: null
  });
  await fs.writeFile(summaryPath, renderPreflightSummary(report), "utf8");
  return {
    report,
    report_path: portableRef(cwd, reportPath),
    summary_path: portableRef(cwd, summaryPath),
    approval_template_path: portableRef(cwd, approvalTemplatePath)
  };
}

export async function importReferenceClaimReview(
  input: ImportReferenceClaimReviewInput
): Promise<ImportReferenceClaimReviewResult> {
  const cwd = path.resolve(input.cwd);
  const packetRoot = path.resolve(cwd, input.packetRoot);
  const reviewPath = path.resolve(cwd, input.reviewPath);
  const preflightReportPath = path.resolve(cwd, input.preflightReportPath);
  const approvalPath = path.resolve(cwd, input.approvalPath);
  const claimsPath = path.resolve(cwd, input.claimsPath);
  const outDir = path.resolve(cwd, input.outDir);
  await assertFreshOutput(outDir, "Reference claim review import");

  const evaluation = await inspectReferenceClaimReviewReturn(packetRoot, reviewPath);
  if (!evaluation.report.preflight_passed || !evaluation.report.claim_gate_passed
      || !evaluation.report.reviewer_id) {
    throw new Error("Reference claim review import requires a passing all-supported preflight.");
  }

  const preflightBytes = await readRegularFile(preflightReportPath);
  let suppliedPreflight: unknown;
  try {
    suppliedPreflight = JSON.parse(preflightBytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Reference claim review preflight report is not valid JSON.");
  }
  if (JSON.stringify(suppliedPreflight) !== JSON.stringify(evaluation.report)) {
    throw new Error("Reference claim review preflight report does not match the current packet and review.");
  }

  const approvalBytes = await readRegularFile(approvalPath);
  const approval = parseReferenceClaimReviewApproval(approvalBytes.toString("utf8"));
  const preflightSha256 = sha256(preflightBytes);
  const taskIds = evaluation.tasks.map((task) => task.task_id);
  if (approval.handoff_id !== evaluation.manifest.handoff_id
      || approval.review_sha256 !== evaluation.report.review_sha256
      || approval.preflight_report_sha256 !== preflightSha256
      || approval.approved_task_ids.length !== taskIds.length
      || approval.approved_task_ids.some((taskId, index) => taskId !== taskIds[index])) {
    throw new Error("Reference claim review approval does not bind the exact preflight task set.");
  }

  const claimsBytes = await readRegularFile(claimsPath);
  const claimsInput = evaluation.manifest.source_inputs.find((item) => item.role === "claims");
  if (!claimsInput || sha256(claimsBytes) !== claimsInput.sha256) {
    throw new Error("Reference claim review source claims have changed since handoff preparation.");
  }
  const claims = parseReferenceClaimsTsv(claimsBytes.toString("utf8"));
  const claimsById = new Map(claims.map((claim) => [claim.claim_id, claim]));
  const reviewsById = new Map(evaluation.parsed.reviews.map((review) => [review.task_id, review]));
  for (const task of evaluation.tasks) {
    const claim = claimsById.get(task.task_id);
    const review = reviewsById.get(task.task_id);
    if (!claim || !review || review.decision !== "supported"
        || claim.manuscript_location !== task.manuscript_location
        || claim.claim_text !== task.claim_text
        || claim.citation_key !== task.citation_key
        || !review.source_location || !review.supporting_passage) {
      throw new Error(`Reference claim import binding failed: ${task.task_id}`);
    }
    assertTsvField(review.source_location, `${task.task_id} source location`);
    assertTsvField(review.supporting_passage, `${task.task_id} supporting passage`);
  }

  const packetManifestBytes = await readContainedRegularFile(
    packetRoot,
    path.join(packetRoot, REFERENCE_CLAIM_REVIEW_MANIFEST)
  );
  const importId = `reference-claim-review-import-${sha256(Buffer.from([
    evaluation.manifest.handoff_id,
    sha256(claimsBytes),
    evaluation.report.review_sha256,
    preflightSha256,
    sha256(approvalBytes)
  ].join(":"), "utf8")).slice(0, 16)}`;
  const updatedClaims = claims.map((claim) => {
    const review = reviewsById.get(claim.claim_id);
    if (!review) return claim;
    return {
      ...claim,
      source_location: review.source_location as string,
      quote_or_evidence: review.supporting_passage as string,
      status: "checked",
      notes: [
        claim.notes.trim(),
        `Independent full-text review and explicit final approval recorded in ${importId}.`
      ].filter(nonEmpty).join(" ")
    };
  });
  const importedClaimsBytes = Buffer.from(renderReferenceClaimsTsv(updatedClaims), "utf8");
  const uncheckedClaims = updatedClaims.filter((claim) => claim.status !== "checked");
  const receipt: ReferenceClaimReviewImportReceipt = {
    schema_version: "1.0",
    import_id: importId,
    handoff_id: evaluation.manifest.handoff_id,
    reviewer_id: evaluation.report.reviewer_id,
    approver_id: approval.approver_id,
    packet_manifest_sha256: sha256(packetManifestBytes),
    source_claims_sha256: sha256(claimsBytes),
    review_sha256: evaluation.report.review_sha256,
    preflight_report_sha256: preflightSha256,
    approval_sha256: sha256(approvalBytes),
    imported_claims_sha256: sha256(importedClaimsBytes),
    reviewed_claim_count: evaluation.tasks.length,
    checked_claim_count: updatedClaims.length - uncheckedClaims.length,
    remaining_unchecked_claim_count: uncheckedClaims.length,
    remaining_unchecked_claim_ids: uncheckedClaims.map((claim) => claim.claim_id),
    review_decision_counts: evaluation.report.decision_counts,
    reviewed_claim_gate_passed: true,
    submission_claim_gate_passed: uncheckedClaims.length === 0,
    human_identity_verified: false,
    source_claim_statuses_modified: false,
    output_claim_statuses_updated: true,
    evidence_boundary: "This import candidate is derived only from a hash-bound all-supported human review and a separately attested final approval. It does not alter the source claims file, verify real-world identities, resolve claims omitted for missing full text, or establish submission readiness. The generated TSV must still pass Refgate submission audit before adoption."
  };

  await fs.mkdir(outDir, { recursive: true });
  const claimsOutputPath = path.join(outDir, REFERENCE_CLAIM_REVIEW_IMPORTED_CLAIMS);
  const receiptPath = path.join(outDir, REFERENCE_CLAIM_REVIEW_IMPORT);
  const summaryPath = path.join(outDir, "reference-claim-review-import.md");
  await fs.writeFile(claimsOutputPath, importedClaimsBytes);
  await writeJsonFile(receiptPath, receipt);
  await fs.writeFile(summaryPath, renderReferenceClaimReviewImportSummary(receipt), "utf8");
  return {
    receipt,
    receipt_path: portableRef(cwd, receiptPath),
    claims_path: portableRef(cwd, claimsOutputPath),
    summary_path: portableRef(cwd, summaryPath)
  };
}

async function inspectReferenceClaimReviewReturn(
  packetRoot: string,
  reviewPath: string
): Promise<{
  manifest: ReferenceClaimReviewManifest;
  tasks: ReferenceClaimReviewTask[];
  parsed: ParsedReview;
  report: ReferenceClaimReviewPreflightReport;
}> {
  const manifest = await inspectPacket(packetRoot);
  const tasks = parseTaskJsonl((await readContainedRegularFile(
    packetRoot,
    path.join(packetRoot, REFERENCE_CLAIM_REVIEW_TASKS)
  )).toString("utf8"));
  const reviewBytes = await readRegularFile(reviewPath);
  const parsed = parseReviewReturn(reviewBytes.toString("utf8"));
  const issues: ReferenceClaimReviewPreflightReport["issues"] = [...parsed.issues];
  const taskIds = new Set(tasks.map((task) => task.task_id));
  const reviewIds = new Set<string>();
  const coveredTaskIds = new Set<string>();
  const counts = emptyDecisionCounts();

  for (const review of parsed.reviews) {
    if (reviewIds.has(review.task_id)) {
      issues.push({ code: "duplicate_review_task", detail: review.task_id });
      continue;
    }
    reviewIds.add(review.task_id);
    if (!taskIds.has(review.task_id)) {
      issues.push({ code: "unknown_review_task", detail: review.task_id });
    } else {
      coveredTaskIds.add(review.task_id);
      if (review.decision) counts[review.decision] += 1;
    }
    validateReviewDecision(review, issues);
  }
  for (const taskId of taskIds) {
    if (!reviewIds.has(taskId)) issues.push({ code: "missing_review_task", detail: taskId });
  }
  if (parsed.handoff_id !== manifest.handoff_id) {
    issues.push({ code: "review_handoff_mismatch", detail: "The review does not target this packet." });
  }
  if (parsed.reviews.length !== manifest.task_count || tasks.length !== manifest.task_count) {
    issues.push({ code: "review_coverage_mismatch", detail: "Review coverage does not match the packet manifest." });
  }

  const preflightPassed = issues.length === 0;
  const claimGatePassed = preflightPassed && counts.supported === manifest.task_count;
  return {
    manifest,
    tasks,
    parsed,
    report: {
      schema_version: "1.0",
      handoff_id: manifest.handoff_id,
      preflight_passed: preflightPassed,
      claim_gate_passed: claimGatePassed,
      reviewer_id: parsed.reviewer_id,
      task_count: manifest.task_count,
      reviewed_task_count: coveredTaskIds.size,
      decision_counts: counts,
      issues,
      review_sha256: sha256(reviewBytes),
      human_identity_verified: false,
      claim_statuses_modified: false,
      evidence_boundary: "A passing preflight establishes a complete, hash-bound review return with the reviewer's human and independence attestations. Pseudonymous fields do not verify real-world identity or expertise. This command never changes Refgate claim statuses; explicit final approval and a separate Refgate import remain required."
    }
  };
}

async function inspectPacket(packetRoot: string): Promise<ReferenceClaimReviewManifest> {
  const manifestPath = path.join(packetRoot, REFERENCE_CLAIM_REVIEW_MANIFEST);
  const raw = JSON.parse((await readContainedRegularFile(packetRoot, manifestPath)).toString("utf8")) as unknown;
  if (!isRecord(raw)
      || raw.schema_version !== "1.0"
      || !validId(raw.handoff_id)
      || !nonEmpty(raw.manuscript_ref)
      || !Number.isInteger(raw.task_count)
      || (raw.task_count as number) <= 0
      || !Number.isInteger(raw.missing_full_text_claim_count)
      || (raw.missing_full_text_claim_count as number) < 0
      || raw.reviewer_root !== "reviewer"
      || !Array.isArray(raw.source_inputs)
      || !Array.isArray(raw.missing_full_text_claims)
      || !Array.isArray(raw.files)
      || !nonEmpty(raw.evidence_boundary)) {
    throw new Error("Invalid reference claim review manifest.");
  }
  const manifest = raw as unknown as ReferenceClaimReviewManifest;
  const expectedInputRoles = ["claims", "status", "lock"] as const;
  if (manifest.source_inputs.length !== expectedInputRoles.length
      || new Set(manifest.source_inputs.map((item) => item.role)).size !== expectedInputRoles.length
      || manifest.source_inputs.some((item) =>
        !expectedInputRoles.includes(item.role)
        || !nonEmpty(item.ref)
        || path.basename(item.ref) !== item.ref
        || !sha256String(item.sha256))) {
    throw new Error("Reference claim review source input inventory is invalid.");
  }
  const inputHashes = expectedInputRoles.map((role) => {
    const sourceInput = manifest.source_inputs.find((item) => item.role === role);
    if (!sourceInput) throw new Error(`Reference claim review source input is missing: ${role}`);
    return sourceInput.sha256;
  });
  const expectedHandoffId = `reference-claim-review-${sha256(Buffer.from(
    inputHashes.join(":"),
    "utf8"
  )).slice(0, 16)}`;
  if (manifest.handoff_id !== expectedHandoffId) {
    throw new Error("Reference claim review handoff id does not match its source inputs.");
  }
  if (manifest.missing_full_text_claim_count !== manifest.missing_full_text_claims.length
      || manifest.missing_full_text_claims.some((claim) =>
        !isRecord(claim)
        || !validId(claim.claim_id)
        || !validId(claim.citation_key)
        || (claim.source_title !== undefined && !nonEmpty(claim.source_title))
        || !nonEmpty(claim.record_url))) {
    throw new Error("Reference claim review missing-source inventory is invalid.");
  }
  const expectedFiles = new Set([
    REFERENCE_CLAIM_REVIEW_TASKS,
    REFERENCE_CLAIM_REVIEW_TEMPLATE,
    REFERENCE_CLAIM_REVIEW_GUIDE
  ]);
  if (manifest.files.length !== expectedFiles.size
      || new Set(manifest.files.map((file) => file.path)).size !== expectedFiles.size
      || manifest.files.some((file) => !expectedFiles.has(file.path) || !sha256String(file.sha256))) {
    throw new Error("Reference claim review packet file inventory is invalid.");
  }
  for (const file of manifest.files) {
    const bytes = await readContainedRegularFile(packetRoot, path.join(packetRoot, file.path));
    if (sha256(bytes) !== file.sha256) {
      throw new Error(`Reference claim review packet hash mismatch: ${file.path}`);
    }
  }
  await inspectPrivateDistributionIfPresent(packetRoot, manifest);
  return manifest;
}

async function collectBoundReviewSources(
  sourceDir: string,
  tasks: ReferenceClaimReviewTask[]
): Promise<Array<{
  citationKey: string;
  extension: typeof REVIEW_SOURCE_EXTENSIONS[number];
  sha256: string;
  bytes: Buffer;
}>> {
  await assertRegularDirectory(sourceDir, "Reference review source directory");
  const expectedByKey = new Map<string, string>();
  for (const task of tasks) {
    const previous = expectedByKey.get(task.citation_key);
    if (previous && previous !== task.full_text_sha256) {
      throw new Error(`Reference review tasks disagree on source hash: ${task.citation_key}`);
    }
    expectedByKey.set(task.citation_key, task.full_text_sha256);
  }

  const sources: Array<{
    citationKey: string;
    extension: typeof REVIEW_SOURCE_EXTENSIONS[number];
    sha256: string;
    bytes: Buffer;
  }> = [];
  for (const [citationKey, expectedSha256] of [...expectedByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    const candidates: Array<{
      extension: typeof REVIEW_SOURCE_EXTENSIONS[number];
      bytes: Buffer;
    }> = [];
    for (const extension of REVIEW_SOURCE_EXTENSIONS) {
      const candidatePath = path.join(sourceDir, `${citationKey}${extension}`);
      const bytes = await readOptionalContainedRegularFile(sourceDir, candidatePath);
      if (bytes) candidates.push({ extension, bytes });
    }
    if (candidates.length === 0) {
      throw new Error(`Missing hash-bound reference review source: ${citationKey}.pdf or ${citationKey}.txt`);
    }
    if (candidates.length > 1) {
      throw new Error(`Ambiguous reference review source: ${citationKey} has both PDF and text files.`);
    }
    const candidate = candidates[0];
    const actualSha256 = sha256(candidate.bytes);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Reference review source hash mismatch: ${citationKey}`);
    }
    sources.push({
      citationKey,
      extension: candidate.extension,
      sha256: actualSha256,
      bytes: candidate.bytes
    });
  }
  return sources;
}

async function inspectPrivateDistributionIfPresent(
  packetRoot: string,
  handoff: ReferenceClaimReviewManifest
): Promise<void> {
  const distributionPath = path.join(packetRoot, REFERENCE_CLAIM_REVIEW_PRIVATE_DISTRIBUTION);
  let distributionBytes: Buffer;
  try {
    distributionBytes = await readContainedRegularFile(packetRoot, distributionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const raw = JSON.parse(distributionBytes.toString("utf8")) as unknown;
  if (!isRecord(raw)
      || raw.schema_version !== "1.0"
      || !validId(raw.distribution_id)
      || raw.handoff_id !== handoff.handoff_id
      || !sha256String(raw.upstream_manifest_sha256)
      || raw.distribution_scope !== "private_review_only"
      || raw.public_distribution_allowed !== false
      || raw.license_review_status !== "not_assessed"
      || raw.reviewer_root !== "reviewer"
      || !Number.isInteger(raw.source_count)
      || (raw.source_count as number) <= 0
      || !Array.isArray(raw.sources)
      || !Array.isArray(raw.files)
      || !raw.sources.every((source) => isRecord(source)
        && validId(source.citation_key)
        && nonEmpty(source.path)
        && (source.format === "pdf" || source.format === "txt")
        && sha256String(source.sha256))
      || !raw.files.every((file) => isRecord(file)
        && nonEmpty(file.path)
        && sha256String(file.sha256))
      || !nonEmpty(raw.evidence_boundary)) {
    throw new Error("Invalid private reference claim review distribution manifest.");
  }
  const distribution = raw as unknown as ReferenceClaimReviewPrivateDistributionManifest;
  const upstreamManifestBytes = await readContainedRegularFile(
    packetRoot,
    path.join(packetRoot, REFERENCE_CLAIM_REVIEW_MANIFEST)
  );
  if (sha256(upstreamManifestBytes) !== distribution.upstream_manifest_sha256) {
    throw new Error("Private reference review distribution upstream manifest hash mismatch.");
  }
  const expectedDistributionId = "reference-claim-review-distribution-" + sha256(Buffer.from([
    distribution.upstream_manifest_sha256,
    ...distribution.sources
      .map((source) => source.path + ":" + source.sha256)
      .sort((left, right) => left.localeCompare(right))
  ].join(":"), "utf8")).slice(0, 16);
  if (distribution.distribution_id !== expectedDistributionId) {
    throw new Error("Private reference review distribution id mismatch.");
  }

  const tasks = parseTaskJsonl((await readContainedRegularFile(
    packetRoot,
    path.join(packetRoot, REFERENCE_CLAIM_REVIEW_TASKS)
  )).toString("utf8"));
  const expectedSources = new Map<string, string>();
  for (const task of tasks) expectedSources.set(task.citation_key, task.full_text_sha256);
  if (distribution.source_count !== expectedSources.size
      || distribution.sources.length !== expectedSources.size
      || new Set(distribution.sources.map((source) => source.citation_key)).size !== expectedSources.size) {
    throw new Error("Private reference review distribution source inventory is incomplete.");
  }
  for (const source of distribution.sources) {
    const expectedHash = expectedSources.get(source.citation_key);
    const expectedPath = `reviewer/sources/${source.citation_key}.${source.format}`;
    if (!validId(source.citation_key)
        || (source.format !== "pdf" && source.format !== "txt")
        || source.path !== expectedPath
        || !expectedHash
        || source.sha256 !== expectedHash) {
      throw new Error("Private reference review distribution source binding is invalid.");
    }
  }

  const expectedFilePaths = new Set([
    REFERENCE_CLAIM_REVIEW_MANIFEST,
    ...handoff.files.map((file) => file.path),
    REFERENCE_CLAIM_REVIEW_SOURCE_README,
    ...distribution.sources.map((source) => source.path)
  ]);
  if (distribution.files.length !== expectedFilePaths.size
      || new Set(distribution.files.map((file) => file.path)).size !== expectedFilePaths.size
      || distribution.files.some((file) => !expectedFilePaths.has(file.path) || !sha256String(file.sha256))) {
    throw new Error("Private reference review distribution file inventory is invalid.");
  }
  for (const file of distribution.files) {
    const bytes = await readContainedRegularFile(packetRoot, path.join(packetRoot, file.path));
    if (sha256(bytes) !== file.sha256) {
      throw new Error(`Private reference review distribution hash mismatch: ${file.path}`);
    }
  }
  const actualFiles = await listContainedRegularFiles(packetRoot);
  const closedInventory = new Set([
    REFERENCE_CLAIM_REVIEW_PRIVATE_DISTRIBUTION,
    ...expectedFilePaths
  ]);
  if (actualFiles.length !== closedInventory.size
      || actualFiles.some((file) => !closedInventory.has(file))) {
    throw new Error("Private reference review distribution contains unbound files.");
  }
}

export function parseReferenceClaimsTsv(text: string): ReferenceClaimRow[] {
  const lines = text.replace(/\r/gu, "").split("\n").filter((line) => line.length > 0);
  if (lines.length < 2 || lines[0].split("\t").join("\t") !== CLAIM_COLUMNS.join("\t")) {
    throw new Error("Reference claims TSV header is invalid.");
  }
  return lines.slice(1).map((line, index) => {
    const values = line.split("\t");
    if (values.length !== CLAIM_COLUMNS.length) {
      throw new Error(`Reference claims TSV row ${index + 2} has invalid column count.`);
    }
    return Object.fromEntries(CLAIM_COLUMNS.map((column, columnIndex) => [
      column,
      values[columnIndex]
    ])) as unknown as ReferenceClaimRow;
  });
}

function parseEvidenceStatus(value: unknown): {
  manuscript: string;
  summary: {
    citation_bearing_claim_count: number;
    full_text_evidence_candidate_count: number;
    missing_full_text_claim_count: number;
  };
  sources: Array<{
    citation_key: string;
    record_url: string;
    full_text_status: "mapped" | "missing";
    pdf_sha256: string | null;
    claim_ids: string[];
  }>;
} {
  if (!isRecord(value) || !nonEmpty(value.manuscript) || !isRecord(value.summary)
      || !Array.isArray(value.sources)) {
    throw new Error("Reference evidence status is invalid.");
  }
  const summaryKeys = [
    "citation_bearing_claim_count",
    "full_text_evidence_candidate_count",
    "missing_full_text_claim_count"
  ] as const;
  for (const key of summaryKeys) {
    if (!Number.isInteger(value.summary[key]) || (value.summary[key] as number) < 0) {
      throw new Error(`Reference evidence status summary is invalid: ${key}`);
    }
  }
  return {
    manuscript: value.manuscript as string,
    summary: value.summary as {
      citation_bearing_claim_count: number;
      full_text_evidence_candidate_count: number;
      missing_full_text_claim_count: number;
    },
    sources: value.sources.map((source, index) => {
      if (!isRecord(source) || !validId(source.citation_key) || !nonEmpty(source.record_url)
          || (source.full_text_status !== "mapped" && source.full_text_status !== "missing")
          || (source.pdf_sha256 !== null && !sha256String(source.pdf_sha256))
          || !Array.isArray(source.claim_ids)
          || !source.claim_ids.every(validId)) {
        throw new Error(`Reference evidence source ${index + 1} is invalid.`);
      }
      return source as unknown as {
        citation_key: string;
        record_url: string;
        full_text_status: "mapped" | "missing";
        pdf_sha256: string | null;
        claim_ids: string[];
      };
    })
  };
}

function parseLockEntries(value: unknown): Array<{
  citation_key: string;
  title: string;
}> {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("Reference lock is invalid.");
  }
  return value.entries.map((entry, index) => {
    if (!isRecord(entry) || !validId(entry.citation_key) || !isRecord(entry.record)
        || !nonEmpty(entry.record.title)) {
      throw new Error(`Reference lock entry ${index + 1} is invalid.`);
    }
    return {
      citation_key: entry.citation_key as string,
      title: entry.record.title as string
    };
  });
}

function parseTaskJsonl(text: string): ReferenceClaimReviewTask[] {
  return text.replace(/\r/gu, "").split("\n").filter(nonEmpty).map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Reference review task ${index + 1} is not valid JSON.`);
    }
    if (!isRecord(value) || !validId(value.task_id) || !nonEmpty(value.manuscript_location)
        || !nonEmpty(value.claim_text) || !validId(value.citation_key)
        || !nonEmpty(value.source_title) || !nonEmpty(value.record_url)
        || !sha256String(value.full_text_sha256) || !nonEmpty(value.candidate_source_location)
        || !nonEmpty(value.candidate_evidence) || !nonEmpty(value.evidence_kind)) {
      throw new Error(`Reference review task ${index + 1} is invalid.`);
    }
    return value as unknown as ReferenceClaimReviewTask;
  });
}

interface ParsedReview {
  handoff_id: string;
  reviewer_id: string | null;
  reviews: Array<{
    task_id: string;
    decision: ReferenceClaimReviewDecision | null;
    source_location: string | null;
    supporting_passage: string | null;
    proposed_claim_text: string | null;
    rationale: string | null;
  }>;
  issues: ReferenceClaimReviewPreflightReport["issues"];
}

interface ParsedReferenceClaimReviewApproval {
  handoff_id: string;
  review_sha256: string;
  preflight_report_sha256: string;
  approver_id: string;
  approved_task_ids: string[];
}

function parseReviewReturn(text: string): ParsedReview {
  const issues: ReferenceClaimReviewPreflightReport["issues"] = [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { handoff_id: "", reviewer_id: null, reviews: [], issues: [{ code: "review_json_invalid", detail: "The review return is not valid JSON." }] };
  }
  if (!isRecord(value)) {
    return { handoff_id: "", reviewer_id: null, reviews: [], issues: [{ code: "review_contract_invalid", detail: "The review return must be an object." }] };
  }
  if (value.schema_version !== "1.0" || value.label_source !== "human"
      || value.review_role !== "independent_claim_review") {
    issues.push({ code: "review_contract_invalid", detail: "Schema, label source, or review role is invalid." });
  }
  const reviewerId = validId(value.reviewer_id) ? value.reviewer_id as string : null;
  if (!reviewerId) issues.push({ code: "reviewer_id_invalid", detail: "A stable pseudonymous reviewer ID is required." });
  if (!isRecord(value.independence_attestation)
      || value.independence_attestation.completed_by_human !== true
      || value.independence_attestation.reviewer_did_not_generate_evidence_candidates !== true
      || value.independence_attestation.full_source_text_inspected !== true) {
    issues.push({ code: "review_independence_unattested", detail: "All human, independence, and full-text attestations must be true." });
  }
  const rawReviews = Array.isArray(value.reviews) ? value.reviews : [];
  if (!Array.isArray(value.reviews)) {
    issues.push({ code: "review_list_invalid", detail: "Reviews must be an array." });
  }
  const reviews = rawReviews.flatMap((review, index) => {
    if (!isRecord(review) || !validId(review.task_id)) {
      issues.push({ code: "review_item_invalid", detail: `Review item ${index + 1} is invalid.` });
      return [];
    }
    const decision = REFERENCE_CLAIM_REVIEW_DECISIONS.includes(
      review.decision as ReferenceClaimReviewDecision
    ) ? review.decision as ReferenceClaimReviewDecision : null;
    if (!decision) issues.push({ code: "review_decision_invalid", detail: review.task_id as string });
    return [{
      task_id: review.task_id as string,
      decision,
      source_location: nullableString(review.source_location),
      supporting_passage: nullableString(review.supporting_passage),
      proposed_claim_text: nullableString(review.proposed_claim_text),
      rationale: nullableString(review.rationale)
    }];
  });
  return {
    handoff_id: typeof value.handoff_id === "string" ? value.handoff_id : "",
    reviewer_id: reviewerId,
    reviews,
    issues
  };
}

function parseReferenceClaimReviewApproval(text: string): ParsedReferenceClaimReviewApproval {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Reference claim review approval is not valid JSON.");
  }
  if (!isRecord(value)
      || value.schema_version !== "1.0"
      || !validId(value.handoff_id)
      || !sha256String(value.review_sha256)
      || !sha256String(value.preflight_report_sha256)
      || !validId(value.approver_id)
      || value.approval_role !== "final_reference_claim_approver"
      || !isRecord(value.approval_attestation)
      || value.approval_attestation.completed_by_human !== true
      || value.approval_attestation.reviewed_complete_return !== true
      || value.approval_attestation.authorizes_checked_status !== true
      || value.approval_attestation.accepts_evidence_boundary !== true
      || !Array.isArray(value.approved_task_ids)
      || !value.approved_task_ids.every(validId)
      || new Set(value.approved_task_ids).size !== value.approved_task_ids.length
      || !nonEmpty(value.rationale)) {
    throw new Error("Reference claim review approval is incomplete or invalid.");
  }
  return {
    handoff_id: value.handoff_id,
    review_sha256: value.review_sha256,
    preflight_report_sha256: value.preflight_report_sha256,
    approver_id: value.approver_id,
    approved_task_ids: value.approved_task_ids
  };
}

function validateReviewDecision(
  review: ParsedReview["reviews"][number],
  issues: ReferenceClaimReviewPreflightReport["issues"]
): void {
  if (!review.decision || !nonEmpty(review.rationale)) {
    issues.push({ code: "review_rationale_missing", detail: review.task_id });
    return;
  }
  if ((review.decision === "supported" || review.decision === "rewrite")
      && (!nonEmpty(review.source_location) || !nonEmpty(review.supporting_passage))) {
    issues.push({ code: "review_support_missing", detail: review.task_id });
  }
  if (review.decision === "rewrite" && !nonEmpty(review.proposed_claim_text)) {
    issues.push({ code: "review_rewrite_missing", detail: review.task_id });
  }
  if (review.decision === "supported" && nonEmpty(review.proposed_claim_text)) {
    issues.push({ code: "supported_review_contains_rewrite", detail: review.task_id });
  }
  if (review.decision === "missing_source"
      && (nonEmpty(review.source_location) || nonEmpty(review.supporting_passage))) {
    issues.push({ code: "missing_source_review_contains_support", detail: review.task_id });
  }
}

function emptyDecisionCounts(): Record<ReferenceClaimReviewDecision, number> {
  return { supported: 0, rewrite: 0, wrong_source: 0, missing_source: 0 };
}

function reviewerGuide(): string {
  return [
    "# Independent Claim Review Guide",
    "",
    "Use only the task file, the cited public record, and the exact full source whose SHA-256 is listed in the task.",
    "",
    "1. Make a working copy of `review-template.json`.",
    "2. Inspect the full source text, not only metadata or the abstract.",
    "3. Choose `supported`, `rewrite`, `wrong_source`, or `missing_source` for every task.",
    "4. For `supported` and `rewrite`, record a source locator and a short supporting passage. For `rewrite`, also provide the replacement claim.",
    "5. Write a non-empty rationale for every decision and set all attestations to true only after personally completing the review.",
    "6. Return only the completed JSON for preflight.",
    "7. If every decision is supported, give the generated final approval template and preflight report to a human final approver. The approver must review the complete return, fill the attestation and rationale, and return the approval JSON separately.",
    "",
    "A passing preflight does not change Refgate claim status. After explicit approval, `autolabos reference-review import` generates a new import-candidate TSV without overwriting the source claims file."
  ].join("\n") + "\n";
}

function renderPreflightSummary(report: ReferenceClaimReviewPreflightReport): string {
  return [
    "# Reference Claim Review Preflight",
    "",
    `- Preflight passed: ${report.preflight_passed}`,
    `- Claim gate passed: ${report.claim_gate_passed}`,
    `- Reviewer: ${report.reviewer_id || "unresolved"}`,
    `- Coverage: ${report.reviewed_task_count}/${report.task_count}`,
    `- Supported: ${report.decision_counts.supported}`,
    `- Rewrite: ${report.decision_counts.rewrite}`,
    `- Wrong source: ${report.decision_counts.wrong_source}`,
    `- Missing source: ${report.decision_counts.missing_source}`,
    `- Issues: ${report.issues.length}`,
    "- Claim statuses modified: false",
    "- Final human approval required before import: true",
    "",
    report.evidence_boundary
  ].join("\n") + "\n";
}

function renderReferenceClaimsTsv(claims: ReferenceClaimRow[]): string {
  const lines = claims.map((claim) => CLAIM_COLUMNS.map((column) => {
    const value = claim[column];
    assertTsvField(value, `${claim.claim_id} ${column}`);
    return value;
  }).join("\t"));
  return [CLAIM_COLUMNS.join("\t"), ...lines].join("\n") + "\n";
}

function assertTsvField(value: string, label: string): void {
  if (/[\t\r\n]/u.test(value)) {
    throw new Error(`Reference claim TSV field contains a tab or newline: ${label}`);
  }
}

function renderReferenceClaimReviewImportSummary(
  receipt: ReferenceClaimReviewImportReceipt
): string {
  return [
    "# Reference Claim Review Import",
    "",
    `- Import: ${receipt.import_id}`,
    `- Reviewed claims: ${receipt.reviewed_claim_count}`,
    `- Checked claims in output: ${receipt.checked_claim_count}`,
    `- Remaining unchecked claims: ${receipt.remaining_unchecked_claim_count}`,
    `- Reviewed claim gate passed: ${receipt.reviewed_claim_gate_passed}`,
    `- Submission claim gate passed: ${receipt.submission_claim_gate_passed}`,
    "- Source claims modified: false",
    "- Refgate submission audit still required: true",
    "",
    receipt.evidence_boundary
  ].join("\n") + "\n";
}

function renderPrivateSourceReadme(
  sources: ReferenceClaimReviewPrivateDistributionManifest["sources"],
  missingClaims: ReferenceClaimReviewManifest["missing_full_text_claims"]
): string {
  const missingSources = new Map<string, {
    sourceTitle: string;
    recordUrl: string;
    claimIds: string[];
  }>();
  for (const claim of missingClaims) {
    const existing = missingSources.get(claim.citation_key);
    if (existing) {
      existing.claimIds.push(claim.claim_id);
      continue;
    }
    missingSources.set(claim.citation_key, {
      sourceTitle: claim.source_title || claim.citation_key,
      recordUrl: claim.record_url,
      claimIds: [claim.claim_id]
    });
  }

  return [
    "# Private Full-Text Sources",
    "",
    "Use these files only for the independent claim review in this packet.",
    "Verify the listed SHA-256 before review and inspect the full source, not only the candidate passage.",
    "These files have not passed a redistribution-license review and must not be published with the public source snapshot.",
    "",
    ...sources.map((source) =>
      "- " + source.citation_key + ": " + source.path + " (SHA-256 " + source.sha256 + ")"),
    "",
    ...(missingSources.size > 0 ? [
      "## Missing Full Text",
      "",
      "The following sources are not included. Their claims remain blocked and must not be reviewed until the exact full text is acquired, title-checked, and hash-bound in a new packet.",
      "",
      ...[...missingSources.entries()].map(([citationKey, source]) =>
        "- " + readmeInline(citationKey) + ": " + readmeInline(source.sourceTitle)
        + " (record: " + readmeInline(source.recordUrl)
        + "; blocked claims: " + source.claimIds.map(readmeInline).join(", ") + ")"),
      ""
    ] : []),
    "Return only the completed review JSON outside this packet."
  ].join("\n") + "\n";
}

function readmeInline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

async function assertRegularDirectory(target: string, label: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(label + " must be a regular directory.");
  }
}

async function readOptionalContainedRegularFile(
  root: string,
  target: string
): Promise<Buffer | null> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error("Expected a non-empty regular reference source: " + target);
  }
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    fs.realpath(root),
    fs.realpath(target)
  ]);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Reference review source escaped the source directory.");
  }
  return fs.readFile(canonicalTarget);
}

async function listContainedRegularFiles(root: string): Promise<string[]> {
  const canonicalRoot = await fs.realpath(root);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory);
    for (const name of entries.sort((left, right) => left.localeCompare(right))) {
      const target = path.join(directory, name);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        throw new Error("Private reference review distribution contains a symbolic link.");
      }
      const canonicalTarget = await fs.realpath(target);
      const relative = path.relative(canonicalRoot, canonicalTarget);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Private reference review distribution file escaped the packet root.");
      }
      if (stat.isDirectory()) {
        await visit(canonicalTarget);
      } else if (stat.isFile() && stat.size > 0) {
        files.push(relative.replace(/\\/gu, "/"));
      } else {
        throw new Error("Private reference review distribution contains an invalid file.");
      }
    }
  };
  await visit(canonicalRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

async function assertFreshOutput(target: string, label: string): Promise<void> {
  try {
    await fs.lstat(target);
    throw new Error(`${label} output already exists: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readRegularFile(target: string): Promise<Buffer> {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`Expected a non-empty regular file: ${target}`);
  }
  return fs.readFile(target);
}

async function readContainedRegularFile(root: string, target: string): Promise<Buffer> {
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    fs.realpath(root),
    fs.realpath(target)
  ]);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Reference claim review file escaped the packet root.");
  }
  return readRegularFile(canonicalTarget);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function nullableString(value: unknown): string | null {
  return nonEmpty(value) ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portableRef(cwd: string, target: string): string {
  return path.relative(cwd, target).replace(/\\/gu, "/") || ".";
}
