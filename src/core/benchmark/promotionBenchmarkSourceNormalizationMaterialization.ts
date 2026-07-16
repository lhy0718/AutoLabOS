import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import { hashPromotionArtifactTree } from "./promotionBenchmark.js";
import {
  PROMOTION_SOURCE_NORMALIZATION_MANIFEST,
  inspectPromotionSourceNormalization,
  normalizePromotionSource
} from "./promotionBenchmarkSourceNormalization.js";
import {
  PROMOTION_SOURCE_NORMALIZATION_BATCH_ADJUDICATION_REPORT,
  type PromotionSourceNormalizationBatchAdjudicationReport
} from "./promotionBenchmarkSourceNormalizationAdjudication.js";

export const PROMOTION_SOURCE_NORMALIZATION_BATCH_MATERIALIZATION_REPORT =
  "source-normalization-batch-materialization.json";

export interface MaterializePromotionSourceNormalizationBatchInput {
  cwd: string;
  adjudicationRoot: string;
  outDir: string;
}

export interface PromotionSourceNormalizationMaterializationItem {
  item_id: string;
  normalization_id: string;
  adjudication_source: "double_adjudication_consensus" | "third_party_resolution";
  status: "materialized" | "failed";
  output_path: string | null;
  artifact_tree_sha256: string | null;
  normalization_manifest_sha256: string | null;
  failure: string | null;
}

export interface PromotionSourceNormalizationBatchMaterializationReport {
  schema_version: "1.0";
  generated_at: string;
  batch_id: string;
  passed: boolean;
  item_count: number;
  materialized_count: number;
  failed_count: number;
  input_sha256: {
    adjudication_report: string;
    accepted_labels: string;
    materialization_jobs: string;
  };
  items: PromotionSourceNormalizationMaterializationItem[];
  evidence_boundary: string;
}

export interface MaterializePromotionSourceNormalizationBatchResult {
  report: PromotionSourceNormalizationBatchMaterializationReport;
  output_dir: string;
  report_path: string;
}

export interface PromotionSourceNormalizationBatchMaterializationIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionSourceNormalizationBatchMaterializationInspection {
  integrity_passed: boolean;
  report: PromotionSourceNormalizationBatchMaterializationReport | null;
  issues: PromotionSourceNormalizationBatchMaterializationIssue[];
}

interface MaterializationJob {
  schema_version: "1.0";
  item_id: string;
  normalization_id: string;
  source_root: string;
  private_map_path: string;
  annotation_paths: [string, string];
  resolution_path: string | null;
  adjudication_source: "double_adjudication_consensus" | "third_party_resolution";
}

export async function materializePromotionSourceNormalizationBatch(
  input: MaterializePromotionSourceNormalizationBatchInput
): Promise<MaterializePromotionSourceNormalizationBatchResult> {
  const cwd = path.resolve(input.cwd);
  const adjudicationRoot = path.resolve(cwd, input.adjudicationRoot);
  const outDir = path.resolve(cwd, input.outDir);
  if (isSameOrContainedPath(adjudicationRoot, outDir)) {
    throw new Error("Source-normalization materialization output must stay outside the adjudication bundle.");
  }
  if (await pathExists(outDir)) {
    throw new Error(`Source-normalization materialization output already exists: ${portableRef(cwd, outDir)}`);
  }

  const adjudicationReportPath = path.join(
    adjudicationRoot,
    PROMOTION_SOURCE_NORMALIZATION_BATCH_ADJUDICATION_REPORT
  );
  const adjudicationReport = parseAdjudicationReport(JSON.parse(
    await fs.readFile(adjudicationReportPath, "utf8")
  ) as unknown);
  if (!adjudicationReport.passed) {
    throw new Error("Source-normalization materialization requires a passing batch adjudication report.");
  }
  const acceptedLabelsPath = path.join(adjudicationRoot, "adjudicated-labels.jsonl");
  const jobsPath = path.join(adjudicationRoot, "materialization-jobs.jsonl");
  await assertAdjudicationOutputHash(
    cwd,
    acceptedLabelsPath,
    adjudicationReport.outputs.accepted_labels_path,
    adjudicationReport.outputs.accepted_labels_sha256,
    "accepted labels"
  );
  await assertAdjudicationOutputHash(
    cwd,
    jobsPath,
    adjudicationReport.outputs.materialization_jobs_path,
    adjudicationReport.outputs.materialization_jobs_sha256,
    "materialization jobs"
  );
  const jobs = parseJobs(await fs.readFile(jobsPath, "utf8"), adjudicationReport.task_count);
  validateJobInputs(cwd, adjudicationRoot, outDir, jobs);

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  const itemResults: PromotionSourceNormalizationMaterializationItem[] = [];
  try {
    for (const job of jobs) {
      const itemOutput = path.join(stagingRoot, "items", job.item_id);
      try {
        await normalizePromotionSource({
          cwd,
          sourceRoot: job.source_root,
          privateMapPath: job.private_map_path,
          annotationPaths: job.annotation_paths,
          ...(job.resolution_path ? { resolutionPath: job.resolution_path } : {}),
          outDir: itemOutput
        });
        const inspection = await inspectPromotionSourceNormalization(itemOutput);
        if (!inspection.passed) {
          throw new Error(`Normalized item inspection failed: ${inspection.issues.map((issue) => issue.code).join(", ")}.`);
        }
        itemResults.push({
          item_id: job.item_id,
          normalization_id: job.normalization_id,
          adjudication_source: job.adjudication_source,
          status: "materialized",
          output_path: `items/${job.item_id}`,
          artifact_tree_sha256: await hashPromotionArtifactTree(itemOutput),
          normalization_manifest_sha256: await hashFile(path.join(itemOutput, PROMOTION_SOURCE_NORMALIZATION_MANIFEST)),
          failure: null
        });
      } catch (error) {
        await fs.rm(itemOutput, { recursive: true, force: true });
        itemResults.push({
          item_id: job.item_id,
          normalization_id: job.normalization_id,
          adjudication_source: job.adjudication_source,
          status: "failed",
          output_path: null,
          artifact_tree_sha256: null,
          normalization_manifest_sha256: null,
          failure: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const materializedCount = itemResults.filter((item) => item.status === "materialized").length;
    if (materializedCount === 0) {
      await fs.rm(path.join(stagingRoot, "items"), { recursive: true, force: true });
    }
    const report: PromotionSourceNormalizationBatchMaterializationReport = {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      batch_id: adjudicationReport.batch_id,
      passed: materializedCount === jobs.length,
      item_count: jobs.length,
      materialized_count: materializedCount,
      failed_count: jobs.length - materializedCount,
      input_sha256: {
        adjudication_report: await hashFile(adjudicationReportPath),
        accepted_labels: await hashFile(acceptedLabelsPath),
        materialization_jobs: await hashFile(jobsPath)
      },
      items: itemResults,
      evidence_boundary: "Materialized items passed source normalization, execution-evidence, license-scope, and mutation-compatibility inspection. Batch failure is preserved when any item fails. Materialization does not independently prove reviewer identity, source representativeness, or external paper eligibility."
    };
    await writeJsonFile(path.join(stagingRoot, PROMOTION_SOURCE_NORMALIZATION_BATCH_MATERIALIZATION_REPORT), report);
    const stagedInspection = await inspectPromotionSourceNormalizationBatchMaterialization(stagingRoot);
    if (!stagedInspection.integrity_passed) {
      throw new Error(`Source-normalization batch materialization failed self-inspection: ${stagedInspection.issues.map((issue) => issue.code).join(", ")}.`);
    }
    await fs.rename(stagingRoot, outDir);
    return {
      report,
      output_dir: portableRef(cwd, outDir),
      report_path: portableRef(cwd, path.join(outDir, PROMOTION_SOURCE_NORMALIZATION_BATCH_MATERIALIZATION_REPORT))
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function inspectPromotionSourceNormalizationBatchMaterialization(
  materializationRoot: string
): Promise<PromotionSourceNormalizationBatchMaterializationInspection> {
  const root = path.resolve(materializationRoot);
  const issues: PromotionSourceNormalizationBatchMaterializationIssue[] = [];
  let report: PromotionSourceNormalizationBatchMaterializationReport;
  try {
    report = parseMaterializationReport(JSON.parse(await fs.readFile(
      path.join(root, PROMOTION_SOURCE_NORMALIZATION_BATCH_MATERIALIZATION_REPORT),
      "utf8"
    )) as unknown);
  } catch {
    return {
      integrity_passed: false,
      report: null,
      issues: [{
        code: "source_normalization_batch_materialization_report_unreadable",
        message: "The source-normalization batch materialization report is missing or invalid."
      }]
    };
  }

  const materialized = report.items.filter((item) => item.status === "materialized");
  if (report.materialized_count !== materialized.length
      || report.failed_count !== report.item_count - materialized.length
      || report.passed !== (materialized.length === report.item_count)) {
    issues.push({
      code: "source_normalization_batch_materialization_count_mismatch",
      message: "Materialization counts or pass state do not match item outcomes."
    });
  }
  for (const item of report.items) {
    if (item.status === "failed") {
      if (item.output_path || item.artifact_tree_sha256 || item.normalization_manifest_sha256 || !item.failure) {
        issues.push({
          code: "source_normalization_batch_failed_item_trace_invalid",
          message: "Failed materialization items may contain only an explicit failure trace.",
          ref: item.item_id
        });
      }
      continue;
    }
    const expectedPath = `items/${item.item_id}`;
    if (item.output_path !== expectedPath || !item.artifact_tree_sha256 || !item.normalization_manifest_sha256
        || item.failure !== null) {
      issues.push({
        code: "source_normalization_batch_materialized_item_trace_invalid",
        message: "Materialized item metadata is incomplete or inconsistent.",
        ref: item.item_id
      });
      continue;
    }
    const itemRoot = path.join(root, expectedPath);
    const inspection = await inspectPromotionSourceNormalization(itemRoot);
    const treeHash = await hashPromotionArtifactTree(itemRoot).catch(() => null);
    const manifestHash = await hashFile(path.join(itemRoot, PROMOTION_SOURCE_NORMALIZATION_MANIFEST)).catch(() => null);
    if (!inspection.passed || treeHash !== item.artifact_tree_sha256
        || manifestHash !== item.normalization_manifest_sha256) {
      issues.push({
        code: "source_normalization_batch_materialized_item_integrity_failed",
        message: "A materialized normalized source is missing, changed, or invalid.",
        ref: item.item_id
      });
    }
  }

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const allowedRootEntries = new Set([
      PROMOTION_SOURCE_NORMALIZATION_BATCH_MATERIALIZATION_REPORT,
      ...(materialized.length > 0 ? ["items"] : [])
    ]);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !allowedRootEntries.has(entry.name)) {
        issues.push({
          code: "source_normalization_batch_materialization_untracked_output",
          message: "Materialization output contains an untracked root entry.",
          ref: entry.name
        });
      }
    }
    if (materialized.length > 0) {
      const itemEntries = await fs.readdir(path.join(root, "items"), { withFileTypes: true });
      const expectedItems = new Set(materialized.map((item) => item.item_id));
      for (const entry of itemEntries) {
        if (entry.isSymbolicLink() || !entry.isDirectory() || !expectedItems.has(entry.name)) {
          issues.push({
            code: "source_normalization_batch_materialization_untracked_item",
            message: "Materialization output contains an untracked item directory.",
            ref: entry.name
          });
        }
      }
      for (const itemId of expectedItems) {
        if (!itemEntries.some((entry) => entry.name === itemId && entry.isDirectory())) {
          issues.push({
            code: "source_normalization_batch_materialization_item_missing",
            message: "A report-bound materialized item directory is missing.",
            ref: itemId
          });
        }
      }
    }
  } catch {
    issues.push({
      code: "source_normalization_batch_materialization_inventory_invalid",
      message: "Materialization output inventory is missing or unreadable."
    });
  }
  return { integrity_passed: issues.length === 0, report, issues };
}

function parseJobs(raw: string, expectedCount: number): MaterializationJob[] {
  const jobs = raw.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.item_id)
        || !validId(value.normalization_id) || !safeRelativePath(value.source_root)
        || !safeRelativePath(value.private_map_path) || !Array.isArray(value.annotation_paths)
        || value.annotation_paths.length !== 2 || !value.annotation_paths.every(nonEmptyString)
        || (value.resolution_path !== null && !nonEmptyString(value.resolution_path))
        || (value.adjudication_source !== "double_adjudication_consensus"
          && value.adjudication_source !== "third_party_resolution")) {
      throw new Error(`Source-normalization materialization job ${index + 1} is invalid.`);
    }
    if ((value.adjudication_source === "double_adjudication_consensus") !== (value.resolution_path === null)) {
      throw new Error(`Source-normalization materialization job ${index + 1} has an inconsistent resolution path.`);
    }
    return {
      schema_version: "1.0",
      item_id: value.item_id,
      normalization_id: value.normalization_id,
      source_root: value.source_root,
      private_map_path: value.private_map_path,
      annotation_paths: [value.annotation_paths[0], value.annotation_paths[1]],
      resolution_path: value.resolution_path,
      adjudication_source: value.adjudication_source
    } as MaterializationJob;
  });
  if (jobs.length !== expectedCount || new Set(jobs.map((job) => job.item_id)).size !== jobs.length
      || new Set(jobs.map((job) => job.normalization_id)).size !== jobs.length) {
    throw new Error("Source-normalization materialization jobs must cover every adjudicated item exactly once.");
  }
  return jobs;
}

function validateJobInputs(
  cwd: string,
  adjudicationRoot: string,
  outDir: string,
  jobs: MaterializationJob[]
): void {
  const inputRoot = path.join(adjudicationRoot, "materialization-inputs");
  for (const job of jobs) {
    if (isSameOrContainedPath(path.resolve(cwd, job.source_root), outDir)) {
      throw new Error(`Materialization output must stay outside every projected source: ${job.item_id}.`);
    }
    const referencedInputs = [...job.annotation_paths, ...(job.resolution_path ? [job.resolution_path] : [])];
    for (const ref of referencedInputs) {
      const resolved = path.resolve(cwd, ref);
      if (!isSameOrContainedPath(inputRoot, resolved)) {
        throw new Error(`Materialization input escapes the adjudication-owned input directory: ${job.item_id}.`);
      }
    }
  }
}

async function assertAdjudicationOutputHash(
  cwd: string,
  expectedPath: string,
  declaredPath: string | null,
  declaredSha256: string | null,
  label: string
): Promise<void> {
  if (!declaredPath || !declaredSha256 || path.resolve(cwd, declaredPath) !== expectedPath
      || await hashFile(expectedPath) !== declaredSha256) {
    throw new Error(`Source-normalization adjudication ${label} path or hash mismatch.`);
  }
}

function parseAdjudicationReport(value: unknown): PromotionSourceNormalizationBatchAdjudicationReport {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.batch_id)
      || value.passed !== true || !positiveInteger(value.task_count)
      || value.accepted_label_count !== value.task_count || !isRecord(value.outputs)
      || !nonEmptyString(value.outputs.accepted_labels_path)
      || !sha256String(value.outputs.accepted_labels_sha256)
      || !nonEmptyString(value.outputs.materialization_jobs_path)
      || !sha256String(value.outputs.materialization_jobs_sha256)) {
    throw new Error("Passing source-normalization batch adjudication report is invalid.");
  }
  return value as unknown as PromotionSourceNormalizationBatchAdjudicationReport;
}

function parseMaterializationReport(value: unknown): PromotionSourceNormalizationBatchMaterializationReport {
  if (!isRecord(value) || value.schema_version !== "1.0" || !timestampString(value.generated_at)
      || !validId(value.batch_id) || typeof value.passed !== "boolean" || !positiveInteger(value.item_count)
      || !nonNegativeInteger(value.materialized_count) || !nonNegativeInteger(value.failed_count)
      || !isRecord(value.input_sha256) || !sha256String(value.input_sha256.adjudication_report)
      || !sha256String(value.input_sha256.accepted_labels) || !sha256String(value.input_sha256.materialization_jobs)
      || !Array.isArray(value.items) || value.items.length !== value.item_count
      || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Source-normalization batch materialization report is invalid.");
  }
  const items = value.items.map((item) => {
    if (!isRecord(item) || !validId(item.item_id) || !validId(item.normalization_id)
        || (item.adjudication_source !== "double_adjudication_consensus"
          && item.adjudication_source !== "third_party_resolution")
        || (item.status !== "materialized" && item.status !== "failed")
        || (item.output_path !== null && !safeRelativePath(item.output_path))
        || (item.artifact_tree_sha256 !== null && !sha256String(item.artifact_tree_sha256))
        || (item.normalization_manifest_sha256 !== null && !sha256String(item.normalization_manifest_sha256))
        || (item.failure !== null && !nonEmptyString(item.failure))) {
      throw new Error("Source-normalization batch materialization item is invalid.");
    }
    return item as unknown as PromotionSourceNormalizationMaterializationItem;
  });
  if (new Set(items.map((item) => item.item_id)).size !== items.length
      || new Set(items.map((item) => item.normalization_id)).size !== items.length) {
    throw new Error("Source-normalization batch materialization identities must be unique.");
  }
  return { ...value, items } as unknown as PromotionSourceNormalizationBatchMaterializationReport;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestampString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.includes("\\")
    && !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
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

function isSameOrContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portableRef(cwd: string, targetPath: string): string {
  const relative = path.relative(cwd, targetPath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : targetPath.replace(/\\/gu, "/");
}
