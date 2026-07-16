import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  parsePromotionSourceNormalizationAnnotation,
  promotionSourceNormalizationOutputFields,
  validatePromotionSourceNormalizationAcceptedLabel,
  validatePromotionSourceNormalizationResultTable,
  type PromotionSourceNormalizationAnnotation
} from "./promotionBenchmarkSourceNormalization.js";
import { inspectPromotionSourceProjection } from "./promotionBenchmarkSourceProjection.js";

export const PROMOTION_SOURCE_NORMALIZATION_ANNOTATION_PREFLIGHT_REPORT =
  "source-normalization-annotation-preflight.json";

export interface PreflightPromotionSourceNormalizationAnnotationInput {
  cwd: string;
  reviewerRoot: string;
  annotationPath: string;
  outDir: string;
}

export interface PromotionSourceNormalizationAnnotationPreflightIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionSourceNormalizationAnnotationPreflightReport {
  schema_version: "1.0";
  generated_at: string;
  passed: boolean;
  annotator_id: string | null;
  task_count: number;
  annotation_count: number;
  materialization_ready_count: number;
  input_sha256: {
    tasks: string;
    rubric: string;
    annotations: string;
  };
  validation_issues: PromotionSourceNormalizationAnnotationPreflightIssue[];
  materialization_findings: PromotionSourceNormalizationAnnotationPreflightIssue[];
  evidence_boundary: string;
}

export interface PreflightPromotionSourceNormalizationAnnotationResult {
  report: PromotionSourceNormalizationAnnotationPreflightReport;
  report_path: string;
  summary_path: string;
}

interface ReviewerTask {
  item_id: string;
  normalization_id: string;
  artifact_root: string;
}

export async function preflightPromotionSourceNormalizationAnnotation(
  input: PreflightPromotionSourceNormalizationAnnotationInput
): Promise<PreflightPromotionSourceNormalizationAnnotationResult> {
  const cwd = path.resolve(input.cwd);
  const reviewerRoot = await resolveDirectoryInside(cwd, path.resolve(cwd, input.reviewerRoot), "Reviewer root");
  const annotationPath = await resolveFileInside(cwd, path.resolve(cwd, input.annotationPath), "Annotation file");
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Annotation preflight output");
  if (isSameOrContainedPath(reviewerRoot, outDir)) {
    throw new Error("Annotation preflight output must stay outside the closed reviewer directory.");
  }
  await assertFreshOutput(outDir);

  const tasksPath = await resolveFileInside(
    reviewerRoot,
    path.join(reviewerRoot, "normalization-tasks.jsonl"),
    "Reviewer tasks"
  );
  const rubricPath = await resolveFileInside(reviewerRoot, path.join(reviewerRoot, "RUBRIC.md"), "Reviewer rubric");
  const tasksText = await fs.readFile(tasksPath, "utf8");
  const rubricText = await fs.readFile(rubricPath, "utf8");
  if (!rubricText.trim()) throw new Error("Reviewer rubric must be non-empty.");
  const tasks = parseReviewerTasks(tasksText);
  const issues: PromotionSourceNormalizationAnnotationPreflightIssue[] = [];
  const annotationText = await fs.readFile(annotationPath, "utf8");
  const annotations = parseAnnotations(annotationText, issues, path.basename(annotationPath));
  const materializationFindings: PromotionSourceNormalizationAnnotationPreflightIssue[] = [];
  const taskById = new Map(tasks.map((task) => [task.normalization_id, task]));
  const annotationById = new Map<string, PromotionSourceNormalizationAnnotation>();
  const annotatorIds = new Set<string>();

  for (const annotation of annotations) {
    if (!taskById.has(annotation.normalization_id)) {
      issues.push({
        code: "source_normalization_annotation_unknown_task",
        message: "Annotation references an opaque task outside the reviewer pack.",
        ref: annotation.normalization_id
      });
      continue;
    }
    if (annotationById.has(annotation.normalization_id)) {
      issues.push({
        code: "source_normalization_annotation_duplicate_task",
        message: "Annotation file contains a duplicate opaque task.",
        ref: annotation.normalization_id
      });
      continue;
    }
    annotationById.set(annotation.normalization_id, annotation);
    annotatorIds.add(annotation.annotator_id);
  }
  if (annotatorIds.size !== 1) {
    issues.push({
      code: "source_normalization_annotation_annotator_inconsistent",
      message: "One annotation file must use exactly one non-empty annotator ID."
    });
  }
  for (const task of tasks) {
    if (!annotationById.has(task.normalization_id)) {
      issues.push({
        code: "source_normalization_annotation_coverage_incomplete",
        message: "Annotation file is missing a required opaque task.",
        ref: task.normalization_id
      });
    }
  }

  let materializationReadyCount = 0;
  for (const task of tasks) {
    const annotation = annotationById.get(task.normalization_id);
    if (!annotation) continue;
    const artifactRoot = path.resolve(reviewerRoot, task.artifact_root);
    try {
      const resolvedArtifactRoot = await resolveDirectoryInside(reviewerRoot, artifactRoot, "Reviewer artifact root");
      const projection = await inspectPromotionSourceProjection(resolvedArtifactRoot);
      if (!projection.integrity_passed || !projection.manifest) {
        throw new Error(
          `Reviewer artifact projection is not integrity-valid: ${projection.issues.map((issue) => issue.code).join(", ") || "unreadable"}.`
        );
      }
      const projectedPaths = projection.manifest.outputs.map((output) => output.target_path);
      validatePromotionSourceNormalizationAcceptedLabel(annotation, projectedPaths);
      await validatePromotionSourceNormalizationResultTable(
        path.join(resolvedArtifactRoot, annotation.result_table_path)
      );
      materializationReadyCount += 1;
    } catch (error) {
      materializationFindings.push({
        code: "source_normalization_annotation_not_materialization_ready",
        message: error instanceof Error ? error.message : String(error),
        ref: task.normalization_id
      });
    }
  }

  const report: PromotionSourceNormalizationAnnotationPreflightReport = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    passed: issues.length === 0 && annotationById.size === tasks.length,
    annotator_id: annotatorIds.size === 1 ? [...annotatorIds][0] : null,
    task_count: tasks.length,
    annotation_count: annotationById.size,
    materialization_ready_count: materializationReadyCount,
    input_sha256: {
      tasks: sha256(tasksText),
      rubric: sha256(rubricText),
      annotations: sha256(annotationText)
    },
    validation_issues: issues,
    materialization_findings: materializationFindings,
    evidence_boundary: "This reviewer-side preflight verifies one annotation file's schema, opaque-task coverage, and annotator consistency. Materialization findings are non-blocking for honest negative labels and only forecast clean-base eligibility. The preflight does not expose the controller map, compare reviewers, adjudicate labels, or prove human identity, independence, expertise, or source validity."
  };
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, PROMOTION_SOURCE_NORMALIZATION_ANNOTATION_PREFLIGHT_REPORT);
  const summaryPath = path.join(outDir, "source-normalization-annotation-preflight.md");
  await writeJsonFile(reportPath, report);
  await fs.writeFile(summaryPath, renderSummary(report, input.annotationPath), "utf8");
  return {
    report,
    report_path: portableRef(cwd, reportPath),
    summary_path: portableRef(cwd, summaryPath)
  };
}

function parseReviewerTasks(raw: string): ReviewerTask[] {
  const tasks: ReviewerTask[] = [];
  for (const [index, line] of raw.split(/\r?\n/gu).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Reviewer task line ${index + 1} is not valid JSON.`);
    }
    if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.item_id)
        || !validId(value.normalization_id) || !safeRelativePath(value.artifact_root)
        || value.artifact_root !== `artifacts/${value.normalization_id}`
        || !Array.isArray(value.required_output_fields)
        || value.required_output_fields.join("\0") !== promotionSourceNormalizationOutputFields().join("\0")) {
      throw new Error(`Reviewer task line ${index + 1} has an invalid schema or field contract.`);
    }
    tasks.push({
      item_id: value.item_id,
      normalization_id: value.normalization_id,
      artifact_root: value.artifact_root
    });
  }
  if (tasks.length === 0
      || new Set(tasks.map((task) => task.item_id)).size !== tasks.length
      || new Set(tasks.map((task) => task.normalization_id)).size !== tasks.length) {
    throw new Error("Reviewer tasks must be non-empty with unique item and normalization IDs.");
  }
  return tasks;
}

function parseAnnotations(
  raw: string,
  issues: PromotionSourceNormalizationAnnotationPreflightIssue[],
  fileName: string
): PromotionSourceNormalizationAnnotation[] {
  const annotations: PromotionSourceNormalizationAnnotation[] = [];
  for (const [index, line] of raw.split(/\r?\n/gu).entries()) {
    if (!line.trim()) continue;
    try {
      annotations.push(parsePromotionSourceNormalizationAnnotation(JSON.parse(line) as unknown));
    } catch (error) {
      issues.push({
        code: "source_normalization_annotation_record_invalid",
        message: error instanceof Error ? error.message : String(error),
        ref: `${fileName}:${index + 1}`
      });
    }
  }
  if (annotations.length === 0) {
    issues.push({
      code: "source_normalization_annotation_file_empty",
      message: "Annotation file contains no valid records.",
      ref: fileName
    });
  }
  return annotations;
}

function renderSummary(
  report: PromotionSourceNormalizationAnnotationPreflightReport,
  annotationPath: string
): string {
  return [
    "# Source-Normalization Annotation Preflight",
    "",
    `- Status: ${report.passed ? "passed" : "failed"}`,
    `- Annotation file: ${path.basename(annotationPath)}`,
    `- Annotator ID: ${report.annotator_id || "unresolved"}`,
    `- Task coverage: ${report.annotation_count}/${report.task_count}`,
    `- Materialization-ready: ${report.materialization_ready_count}/${report.task_count}`,
    "",
    "## Validation Issues",
    "",
    ...(report.validation_issues.length > 0
      ? report.validation_issues.map((issue) =>
          `- ${issue.code}${issue.ref ? ` (${issue.ref})` : ""}: ${issue.message}`)
      : ["- None."]),
    "",
    "## Materialization Findings",
    "",
    ...(report.materialization_findings.length > 0
      ? report.materialization_findings.map((issue) =>
          `- ${issue.code}${issue.ref ? ` (${issue.ref})` : ""}: ${issue.message}`)
      : ["- None."]),
    "",
    "## Evidence Boundary",
    "",
    report.evidence_boundary,
    ""
  ].join("\n");
}

async function resolveDirectoryInside(root: string, candidate: string, label: string): Promise<string> {
  const resolved = await resolveExistingInside(root, candidate, label);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error(`${label} must be a directory.`);
  return resolved;
}

async function resolveFileInside(root: string, candidate: string, label: string): Promise<string> {
  const resolved = await resolveExistingInside(root, candidate, label);
  if (!(await fs.stat(resolved)).isFile()) throw new Error(`${label} must be a regular file.`);
  return resolved;
}

async function resolveExistingInside(root: string, candidate: string, label: string): Promise<string> {
  assertStrictlyInside(root, candidate, label);
  const resolved = await fs.realpath(candidate);
  assertStrictlyInside(root, resolved, label);
  return resolved;
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside ${root}.`);
  }
}

async function assertFreshOutput(outDir: string): Promise<void> {
  try {
    await fs.lstat(outDir);
    throw new Error(`Annotation preflight output already exists: ${outDir}`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function isSameOrContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.includes("\\")
    && !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function portableRef(cwd: string, targetPath: string): string {
  return path.relative(cwd, targetPath).replace(/\\/gu, "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
