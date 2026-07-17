import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  inspectPromotionSourceNormalizationBatch,
  PROMOTION_SOURCE_NORMALIZATION_BATCH_MAP,
  PROMOTION_SOURCE_NORMALIZATION_BATCH_MANIFEST,
  type PromotionSourceNormalizationBatchManifest
} from "./promotionBenchmarkSourceNormalizationBatch.js";
import {
  parsePromotionSourceNormalizationAnnotation,
  PROMOTION_SOURCE_NORMALIZATION_LABEL_FIELDS,
  promotionSourceNormalizationLabelFrom,
  promotionSourceNormalizationLabelsEqual,
  type PromotionSourceNormalizationAdjudicatedLabel,
  type PromotionSourceNormalizationAnnotation,
} from "./promotionBenchmarkSourceNormalization.js";

export const PROMOTION_SOURCE_NORMALIZATION_BATCH_ADJUDICATION_REPORT =
  "source-normalization-batch-adjudication.json";

export interface AdjudicatePromotionSourceNormalizationBatchInput {
  cwd: string;
  batchRoot: string;
  annotationPaths: string[];
  resolutionPath?: string;
  outDir: string;
}

export interface PromotionSourceNormalizationBatchAdjudicationIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionSourceNormalizationBatchAgreement {
  full_label_exact_rate: number | null;
  field_exact_rates: Record<string, number | null>;
}

export interface PromotionSourceNormalizationBatchAdjudicationReport {
  schema_version: "1.0";
  generated_at: string;
  batch_id: string;
  passed: boolean;
  task_count: number;
  accepted_label_count: number;
  initial_annotator_ids: string[];
  resolver_id: string | null;
  disagreement_count: number;
  resolved_disagreement_count: number;
  agreement: PromotionSourceNormalizationBatchAgreement;
  input_sha256: {
    batch_manifest: string;
    annotations: Array<string | null>;
    resolution: string | null;
  };
  outputs: {
    accepted_labels_path: string | null;
    accepted_labels_sha256: string | null;
    materialization_jobs_path: string | null;
    materialization_jobs_sha256: string | null;
  };
  validation_issues: PromotionSourceNormalizationBatchAdjudicationIssue[];
  evidence_boundary: string;
}

export interface AdjudicatePromotionSourceNormalizationBatchResult {
  report: PromotionSourceNormalizationBatchAdjudicationReport;
  output_dir: string;
  report_path: string;
  accepted_labels_path: string | null;
  materialization_jobs_path: string | null;
}

interface ControllerMapItem {
  item_id: string;
  normalization_id: string;
  source_root: string;
  private_map_path: string;
}

interface ControllerMap {
  schema_version: "1.0";
  batch_id: string;
  items: ControllerMapItem[];
}

interface AnnotationSet {
  annotator_id: string;
  records: Map<string, PromotionSourceNormalizationAnnotation>;
}

interface AcceptedAnnotation {
  source: "double_adjudication_consensus" | "third_party_resolution";
  initial: [PromotionSourceNormalizationAnnotation, PromotionSourceNormalizationAnnotation];
  resolution: PromotionSourceNormalizationAnnotation | null;
  label: PromotionSourceNormalizationAdjudicatedLabel;
  annotator_ids: string[];
}

export async function adjudicatePromotionSourceNormalizationBatch(
  input: AdjudicatePromotionSourceNormalizationBatchInput
): Promise<AdjudicatePromotionSourceNormalizationBatchResult> {
  const cwd = path.resolve(input.cwd);
  const batchRoot = path.resolve(cwd, input.batchRoot);
  const outDir = path.resolve(cwd, input.outDir);
  if (input.annotationPaths.length !== 2) {
    throw new Error("Source-normalization batch adjudication requires exactly two initial annotation files.");
  }
  if (isSameOrContainedPath(batchRoot, outDir)) {
    throw new Error("Source-normalization batch adjudication output must stay outside the closed review batch.");
  }
  if (await pathExists(outDir)) {
    throw new Error(`Source-normalization batch adjudication output already exists: ${portableRef(cwd, outDir)}`);
  }

  const inspection = await inspectPromotionSourceNormalizationBatch(batchRoot);
  if (!inspection.passed || !inspection.manifest) {
    throw new Error(
      `Source-normalization batch adjudication requires an integrity-valid batch: ${inspection.issues.map((issue) => issue.code).join(", ") || "unreadable"}.`
    );
  }
  const manifest = inspection.manifest;
  const controllerMap = parseControllerMap(JSON.parse(
    await fs.readFile(path.join(batchRoot, PROMOTION_SOURCE_NORMALIZATION_BATCH_MAP), "utf8")
  ) as unknown);
  assertControllerMapMatchesManifest(controllerMap, manifest);

  const issues: PromotionSourceNormalizationBatchAdjudicationIssue[] = [];
  const initialPaths = input.annotationPaths.map((annotationPath) => path.resolve(cwd, annotationPath));
  const initial = await Promise.all(initialPaths.map((annotationPath) =>
    readAnnotationFile(annotationPath, manifest, issues)));
  const initialAnnotatorIds = initial.map((set) => set.annotator_id).filter(nonEmptyString);
  if (initialAnnotatorIds.length !== 2 || new Set(initialAnnotatorIds).size !== 2) {
    issues.push({
      code: "source_normalization_batch_initial_annotators_not_independent",
      message: "Initial batch annotation files must each use one distinct annotator ID."
    });
  }

  const disagreements = manifest.items.filter((item) => {
    const left = initial[0].records.get(item.normalization_id);
    const right = initial[1].records.get(item.normalization_id);
    return Boolean(left && right && !promotionSourceNormalizationLabelsEqual(left, right));
  });
  const disagreementIds = new Set(disagreements.map((item) => item.normalization_id));
  let resolution: AnnotationSet = { annotator_id: "", records: new Map() };
  let resolutionPath: string | undefined;
  if (input.resolutionPath) {
    resolutionPath = path.resolve(cwd, input.resolutionPath);
    if (disagreements.length === 0) {
      issues.push({
        code: "source_normalization_batch_resolution_not_required",
        message: "A resolution file is not allowed when the initial batch labels agree."
      });
    }
    resolution = await readAnnotationFile(resolutionPath, manifest, issues, disagreementIds, true);
    if (resolution.annotator_id && new Set(initialAnnotatorIds).has(resolution.annotator_id)) {
      issues.push({
        code: "source_normalization_batch_resolver_not_independent",
        message: "Resolver ID must differ from both initial annotator IDs."
      });
    }
  } else {
    for (const item of disagreements) {
      issues.push({
        code: "source_normalization_batch_disagreement_unresolved",
        message: "Every initial label disagreement requires a third-party resolution.",
        ref: item.normalization_id
      });
    }
  }

  const accepted = new Map<string, AcceptedAnnotation>();
  for (const item of manifest.items) {
    const left = initial[0].records.get(item.normalization_id);
    const right = initial[1].records.get(item.normalization_id);
    if (!left || !right) continue;
    if (promotionSourceNormalizationLabelsEqual(left, right)) {
      accepted.set(item.normalization_id, {
        source: "double_adjudication_consensus",
        initial: [left, right],
        resolution: null,
        label: promotionSourceNormalizationLabelFrom(left),
        annotator_ids: [left.annotator_id, right.annotator_id]
      });
      continue;
    }
    const resolved = resolution.records.get(item.normalization_id);
    if (resolved) {
      accepted.set(item.normalization_id, {
        source: "third_party_resolution",
        initial: [left, right],
        resolution: resolved,
        label: promotionSourceNormalizationLabelFrom(resolved),
        annotator_ids: [left.annotator_id, right.annotator_id, resolved.annotator_id]
      });
    }
  }

  const pairs = manifest.items.flatMap((item) => {
    const left = initial[0].records.get(item.normalization_id);
    const right = initial[1].records.get(item.normalization_id);
    return left && right ? [[left, right] as const] : [];
  });
  const passed = issues.length === 0 && accepted.size === manifest.item_count;
  const inputHashes = {
    batch_manifest: await hashFile(path.join(batchRoot, PROMOTION_SOURCE_NORMALIZATION_BATCH_MANIFEST)),
    annotations: await Promise.all(initialPaths.map((annotationPath) => hashFile(annotationPath).catch(() => null))),
    resolution: resolutionPath ? await hashFile(resolutionPath).catch(() => null) : null
  };

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  let acceptedLabelsPath: string | null = null;
  let acceptedLabelsSha256: string | null = null;
  let materializationJobsPath: string | null = null;
  let materializationJobsSha256: string | null = null;
  try {
    if (passed) {
      const acceptedRows: string[] = [];
      const jobRows: string[] = [];
      const controllerById = new Map(controllerMap.items.map((item) => [item.normalization_id, item]));
      for (const item of manifest.items) {
        const adjudicated = accepted.get(item.normalization_id);
        const controller = controllerById.get(item.normalization_id);
        if (!adjudicated || !controller) throw new Error(`Accepted normalization label missing for ${item.item_id}.`);
        acceptedRows.push(JSON.stringify({
          schema_version: "1.0",
          item_id: item.item_id,
          normalization_id: item.normalization_id,
          adjudication_source: adjudicated.source,
          annotator_ids: adjudicated.annotator_ids,
          label: adjudicated.label,
          initial_annotations: adjudicated.initial,
          resolution: adjudicated.resolution
        }));

        const inputRoot = path.join(stagingRoot, "materialization-inputs", item.normalization_id);
        const finalInputRoot = path.join(outDir, "materialization-inputs", item.normalization_id);
        await fs.mkdir(inputRoot, { recursive: true });
        await writeJsonFile(path.join(inputRoot, "annotation-a.json"), adjudicated.initial[0]);
        await writeJsonFile(path.join(inputRoot, "annotation-b.json"), adjudicated.initial[1]);
        const finalResolutionPath = adjudicated.resolution
          ? portableRef(cwd, path.join(finalInputRoot, "resolution.json"))
          : null;
        if (adjudicated.resolution) {
          await writeJsonFile(path.join(inputRoot, "resolution.json"), adjudicated.resolution);
        }
        jobRows.push(JSON.stringify({
          schema_version: "1.0",
          item_id: item.item_id,
          normalization_id: item.normalization_id,
          source_root: controller.source_root,
          private_map_path: controller.private_map_path,
          annotation_paths: [
            portableRef(cwd, path.join(finalInputRoot, "annotation-a.json")),
            portableRef(cwd, path.join(finalInputRoot, "annotation-b.json"))
          ],
          resolution_path: finalResolutionPath,
          adjudication_source: adjudicated.source
        }));
      }
      const acceptedPath = path.join(stagingRoot, "adjudicated-labels.jsonl");
      const jobsPath = path.join(stagingRoot, "materialization-jobs.jsonl");
      await fs.writeFile(acceptedPath, `${acceptedRows.join("\n")}\n`, "utf8");
      await fs.writeFile(jobsPath, `${jobRows.join("\n")}\n`, "utf8");
      acceptedLabelsPath = portableRef(cwd, path.join(outDir, "adjudicated-labels.jsonl"));
      acceptedLabelsSha256 = await hashFile(acceptedPath);
      materializationJobsPath = portableRef(cwd, path.join(outDir, "materialization-jobs.jsonl"));
      materializationJobsSha256 = await hashFile(jobsPath);
    }

    const report: PromotionSourceNormalizationBatchAdjudicationReport = {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      batch_id: manifest.batch_id,
      passed,
      task_count: manifest.item_count,
      accepted_label_count: accepted.size,
      initial_annotator_ids: [...new Set(initialAnnotatorIds)].sort(),
      resolver_id: resolution.annotator_id || null,
      disagreement_count: disagreements.length,
      resolved_disagreement_count: disagreements.filter((item) =>
        resolution.records.has(item.normalization_id)).length,
      agreement: agreementMetrics(pairs),
      input_sha256: inputHashes,
      outputs: {
        accepted_labels_path: acceptedLabelsPath,
        accepted_labels_sha256: acceptedLabelsSha256,
        materialization_jobs_path: materializationJobsPath,
        materialization_jobs_sha256: materializationJobsSha256
      },
      validation_issues: issues,
      evidence_boundary: "This report verifies annotation-file structure, opaque-task coverage, pseudonymous role separation, exact label agreement, and resolution coverage. Pseudonymous IDs and label_source=human do not independently prove reviewer identity, independence, expertise, or source validity."
    };
    await writeJsonFile(path.join(stagingRoot, PROMOTION_SOURCE_NORMALIZATION_BATCH_ADJUDICATION_REPORT), report);
    await fs.rename(stagingRoot, outDir);
    return {
      report,
      output_dir: portableRef(cwd, outDir),
      report_path: portableRef(cwd, path.join(outDir, PROMOTION_SOURCE_NORMALIZATION_BATCH_ADJUDICATION_REPORT)),
      accepted_labels_path: acceptedLabelsPath,
      materialization_jobs_path: materializationJobsPath
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function readAnnotationFile(
  filePath: string,
  manifest: PromotionSourceNormalizationBatchManifest,
  issues: PromotionSourceNormalizationBatchAdjudicationIssue[],
  expectedIds = new Set(manifest.items.map((item) => item.normalization_id)),
  resolution = false
): Promise<AnnotationSet> {
  const records = new Map<string, PromotionSourceNormalizationAnnotation>();
  const annotatorIds = new Set<string>();
  const allowedIds = new Set(manifest.items.map((item) => item.normalization_id));
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    issues.push({
      code: "source_normalization_batch_annotation_file_unreadable",
      message: error instanceof Error ? error.message : String(error),
      ref: path.basename(filePath)
    });
    return { annotator_id: "", records };
  }
  for (const [index, line] of raw.split(/\r?\n/gu).entries()) {
    if (!line.trim()) continue;
    let annotation: PromotionSourceNormalizationAnnotation;
    try {
      annotation = parsePromotionSourceNormalizationAnnotation(JSON.parse(line) as unknown);
    } catch (error) {
      issues.push({
        code: "source_normalization_batch_annotation_record_invalid",
        message: error instanceof Error ? error.message : String(error),
        ref: `${path.basename(filePath)}:${index + 1}`
      });
      continue;
    }
    if (!allowedIds.has(annotation.normalization_id)) {
      issues.push({
        code: "source_normalization_batch_annotation_unknown_id",
        message: "Annotation record references an opaque task outside the batch.",
        ref: annotation.normalization_id
      });
      continue;
    }
    if (!expectedIds.has(annotation.normalization_id)) {
      issues.push({
        code: "source_normalization_batch_unexpected_resolution",
        message: "Resolution records may cover only initial label disagreements.",
        ref: annotation.normalization_id
      });
      continue;
    }
    if (records.has(annotation.normalization_id)) {
      issues.push({
        code: "source_normalization_batch_annotation_duplicate_id",
        message: "Annotation file contains a duplicate opaque task ID.",
        ref: annotation.normalization_id
      });
      continue;
    }
    records.set(annotation.normalization_id, annotation);
    annotatorIds.add(annotation.annotator_id);
  }
  if (annotatorIds.size !== 1) {
    issues.push({
      code: resolution
        ? "source_normalization_batch_resolution_annotator_inconsistent"
        : "source_normalization_batch_annotation_annotator_inconsistent",
      message: "Each annotation file must contain exactly one annotator ID.",
      ref: path.basename(filePath)
    });
  }
  for (const expectedId of expectedIds) {
    if (!records.has(expectedId)) {
      issues.push({
        code: resolution
          ? "source_normalization_batch_resolution_coverage_incomplete"
          : "source_normalization_batch_annotation_coverage_incomplete",
        message: resolution
          ? "Resolution file is missing an initial disagreement."
          : "Annotation file is missing a required opaque task.",
        ref: expectedId
      });
    }
  }
  return { annotator_id: [...annotatorIds][0] || "", records };
}

function agreementMetrics(
  pairs: ReadonlyArray<readonly [PromotionSourceNormalizationAnnotation, PromotionSourceNormalizationAnnotation]>
): PromotionSourceNormalizationBatchAgreement {
  const agreementFields = ["observation_status", ...PROMOTION_SOURCE_NORMALIZATION_LABEL_FIELDS] as const;
  const fieldExactRates = Object.fromEntries(agreementFields.map((field) => [
    field,
    pairs.length === 0 ? null : pairs.filter(([left, right]) =>
      JSON.stringify(left[field]) === JSON.stringify(right[field])).length / pairs.length
  ]));
  return {
    full_label_exact_rate: pairs.length === 0
      ? null
      : pairs.filter(([left, right]) => promotionSourceNormalizationLabelsEqual(left, right)).length / pairs.length,
    field_exact_rates: fieldExactRates
  };
}

function parseControllerMap(value: unknown): ControllerMap {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.batch_id)
      || !Array.isArray(value.items) || value.items.length === 0) {
    throw new Error("Source-normalization batch controller map is invalid.");
  }
  const items = value.items.map((item) => {
    if (!isRecord(item) || !validId(item.item_id) || !validId(item.normalization_id)
        || !safeRelativePath(item.source_root) || !safeRelativePath(item.private_map_path)) {
      throw new Error("Source-normalization batch controller item is invalid.");
    }
    return {
      item_id: item.item_id,
      normalization_id: item.normalization_id,
      source_root: item.source_root,
      private_map_path: item.private_map_path
    };
  });
  if (new Set(items.map((item) => item.item_id)).size !== items.length
      || new Set(items.map((item) => item.normalization_id)).size !== items.length) {
    throw new Error("Source-normalization batch controller identities must be unique.");
  }
  return { schema_version: "1.0", batch_id: value.batch_id, items };
}

function assertControllerMapMatchesManifest(
  controllerMap: ControllerMap,
  manifest: PromotionSourceNormalizationBatchManifest
): void {
  const controllerIds = controllerMap.items
    .map((item) => `${item.item_id}:${item.normalization_id}`).sort();
  const manifestIds = manifest.items
    .map((item) => `${item.item_id}:${item.normalization_id}`).sort();
  if (controllerMap.batch_id !== manifest.batch_id
      || controllerIds.join("\u0000") !== manifestIds.join("\u0000")) {
    throw new Error("Source-normalization batch controller map does not match the batch manifest.");
  }
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

function portableRef(cwd: string, targetPath: string): string {
  const relative = path.relative(cwd, targetPath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : targetPath.replace(/\\/gu, "/");
}

function isSameOrContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
