import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeJsonFile } from "../utils/fs.js";

export const REFERENCE_CLAIM_REVIEW_MANIFEST = "reference-claim-review-manifest.json";
export const REFERENCE_CLAIM_REVIEW_TASKS = "reviewer/claim-review-tasks.jsonl";
export const REFERENCE_CLAIM_REVIEW_TEMPLATE = "reviewer/review-template.json";
export const REFERENCE_CLAIM_REVIEW_GUIDE = "reviewer/REVIEWER_GUIDE.md";
export const REFERENCE_CLAIM_REVIEW_PREFLIGHT = "reference-claim-review-preflight.json";

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

interface ClaimRow {
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
  const claims = parseClaimsTsv(claimsBytes.toString("utf8"));
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

export async function preflightReferenceClaimReview(
  input: PreflightReferenceClaimReviewInput
): Promise<PreflightReferenceClaimReviewResult> {
  const cwd = path.resolve(input.cwd);
  const packetRoot = path.resolve(cwd, input.packetRoot);
  const reviewPath = path.resolve(cwd, input.reviewPath);
  const outDir = path.resolve(cwd, input.outDir);
  await assertFreshOutput(outDir, "Reference claim review preflight");
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
  const report: ReferenceClaimReviewPreflightReport = {
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
  };
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, REFERENCE_CLAIM_REVIEW_PREFLIGHT);
  const summaryPath = path.join(outDir, "reference-claim-review-preflight.md");
  await writeJsonFile(reportPath, report);
  await fs.writeFile(summaryPath, renderPreflightSummary(report), "utf8");
  return {
    report,
    report_path: portableRef(cwd, reportPath),
    summary_path: portableRef(cwd, summaryPath)
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
  return manifest;
}

function parseClaimsTsv(text: string): ClaimRow[] {
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
    ])) as unknown as ClaimRow;
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
    "",
    "A passing preflight does not change Refgate claim status. Final status requires explicit approval and a separate Refgate import."
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
    "",
    report.evidence_boundary
  ].join("\n") + "\n";
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
