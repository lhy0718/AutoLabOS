import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import { hashPromotionArtifactTree } from "./promotionBenchmark.js";
import { validatePromotionMutationCompatibility } from "./promotionBenchmarkBuilder.js";
import {
  inspectPromotionExecutionEvidence,
  preparePromotionExecutionEvidence,
  PROMOTION_EXECUTION_EVIDENCE_ROLES,
  type PromotionExecutionBackend,
  type PromotionExecutionEvidenceRole
} from "./promotionBenchmarkExecutionEvidence.js";
import {
  inspectPromotionSourceProjection,
  PROMOTION_SOURCE_LICENSE_FILE,
  PROMOTION_SOURCE_PROJECTION_MANIFEST,
  type PromotionSourceDistributionScope,
  type PromotionSourceLicenseReviewStatus
} from "./promotionBenchmarkSourceProjection.js";
import { promotionVariantDefinitions } from "./promotionBenchmarkVariants.js";

export const PROMOTION_SOURCE_NORMALIZATION_MANIFEST = "source-normalization.json";

export interface ExportPromotionSourceNormalizationPackInput {
  cwd: string;
  sourceRoot: string;
  outDir: string;
}

export interface ExportPromotionSourceNormalizationPackResult {
  normalization_id: string;
  output_dir: string;
  annotator_dir: string;
  tasks_path: string;
  private_map_path: string;
  rubric_path: string;
}

export interface PromotionSourceNormalizationArtifactSelection {
  role: PromotionExecutionEvidenceRole;
  path: string;
}

export interface PromotionSourceNormalizationLabel {
  run_id: string;
  run_status: "completed" | "failed" | "partial";
  execution_backend: PromotionExecutionBackend;
  started_at: string;
  completed_at: string;
  exit_code: number;
  planned_trial_count: number;
  executed_trial_count: number;
  trial_ids: string[];
  execution_artifacts: PromotionSourceNormalizationArtifactSelection[];
  result_table_path: string;
  figure_count: number;
  figure_paths: string[];
  severe_mismatch_count: number;
  review_block_required: boolean;
  claim_text: string;
  claim_section_heading: string;
  claim_status: "verified" | "blocked";
  claim_source_paths: string[];
  citation_refs: string[];
  citation_source_paths: string[];
  evidence_ids: string[];
  citation_paper_ids: string[];
  paper_ready: boolean;
  readiness_source_path: string;
  sota_ranking_claimed: boolean;
  sota_evidence_present: boolean;
  evidence_refs: string[];
}

export const PROMOTION_SOURCE_NORMALIZATION_LABEL_FIELDS = [
  "run_id",
  "run_status",
  "execution_backend",
  "started_at",
  "completed_at",
  "exit_code",
  "planned_trial_count",
  "executed_trial_count",
  "trial_ids",
  "execution_artifacts",
  "result_table_path",
  "figure_count",
  "figure_paths",
  "severe_mismatch_count",
  "review_block_required",
  "claim_text",
  "claim_section_heading",
  "claim_status",
  "claim_source_paths",
  "citation_refs",
  "citation_source_paths",
  "evidence_ids",
  "citation_paper_ids",
  "paper_ready",
  "readiness_source_path",
  "sota_ranking_claimed",
  "sota_evidence_present",
  "evidence_refs"
] as const satisfies readonly (keyof PromotionSourceNormalizationLabel)[];

export interface PromotionSourceNormalizationAnnotation extends PromotionSourceNormalizationLabel {
  schema_version: "1.0";
  normalization_id: string;
  annotator_id: string;
  label_source: "human";
  rationale: string;
}

interface PromotionSourceNormalizationPrivateMap {
  schema_version: "1.0";
  normalization_id: string;
  source_artifact_sha256: string;
  source_projection_manifest_sha256: string;
  source_family_id_sha256: string;
  operator_group_id_sha256: string;
  source_revision: string;
}

export interface NormalizePromotionSourceInput {
  cwd: string;
  sourceRoot: string;
  privateMapPath: string;
  annotationPaths: string[];
  resolutionPath?: string;
  outDir: string;
}

export interface NormalizePromotionSourceResult {
  normalization_id: string;
  adjudication_source: "double_adjudication_consensus" | "third_party_resolution";
  output_dir: string;
  manifest_path: string;
}

export interface PromotionSourceNormalizationOutputRecord {
  path: string;
  sha256: string;
  provenance: "projected_source" | "human_annotation" | "canonical_normalization" | "derived_hash_manifest";
}

export interface PromotionSourceNormalizationManifest {
  schema_version: "1.0";
  normalization_id: string;
  normalization_status: "double_adjudicated" | "third_party_resolved";
  source_artifact_sha256: string;
  source_projection_manifest_sha256: string;
  source_family_id_sha256: string;
  operator_group_id_sha256: string;
  source_revision: string;
  distribution_scope: PromotionSourceDistributionScope;
  license_review_status: PromotionSourceLicenseReviewStatus;
  license_sha256: string;
  initial_annotator_ids: string[];
  resolver_id: string | null;
  initial_annotation_paths: [string, string];
  resolution_path: string | null;
  accepted_label_path: string;
  execution_evidence_verified: boolean;
  promotion_compatible: boolean;
  ready_for_confirmatory_intake: boolean;
  outputs: PromotionSourceNormalizationOutputRecord[];
  evidence_boundary: string;
}

export interface PromotionSourceNormalizationIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionSourceNormalizationInspection {
  passed: boolean;
  manifest: PromotionSourceNormalizationManifest | null;
  issues: PromotionSourceNormalizationIssue[];
}

type ParsedAnnotation = {
  annotation: PromotionSourceNormalizationAnnotation;
  bytes: Buffer;
};

type AcceptedLabelRecord = {
  schema_version: "1.0";
  normalization_id: string;
  adjudication_source: "double_adjudication_consensus" | "third_party_resolution";
  adjudicator_ids: string[];
  label: PromotionSourceNormalizationLabel;
};

export async function exportPromotionSourceNormalizationPack(
  input: ExportPromotionSourceNormalizationPackInput
): Promise<ExportPromotionSourceNormalizationPackResult> {
  const cwd = path.resolve(input.cwd);
  const sourceRoot = path.resolve(cwd, input.sourceRoot);
  const outDir = path.resolve(cwd, input.outDir);
  const projection = await inspectPromotionSourceProjection(sourceRoot);
  if (!projection.integrity_passed || !projection.manifest) {
    throw new Error(`Source normalization requires an integrity-valid projection: ${projection.issues.map((issue) => issue.code).join(", ") || "unreadable"}.`);
  }
  if (isSameOrContainedPath(sourceRoot, outDir)) {
    throw new Error("Source-normalization annotation output must stay outside the projected source bundle.");
  }
  if (await pathExists(outDir)) throw new Error(`Source-normalization annotation output already exists: ${portableRef(cwd, outDir)}`);

  const sourceArtifactSha256 = await hashPromotionArtifactTree(sourceRoot);
  const projectionManifestSha256 = await hashFile(path.join(sourceRoot, PROMOTION_SOURCE_PROJECTION_MANIFEST));
  const normalizationId = `normalization-${sha256Text(`${sourceArtifactSha256}:${projectionManifestSha256}`).slice(0, 24)}`;
  const privateMap: PromotionSourceNormalizationPrivateMap = {
    schema_version: "1.0",
    normalization_id: normalizationId,
    source_artifact_sha256: sourceArtifactSha256,
    source_projection_manifest_sha256: projectionManifestSha256,
    source_family_id_sha256: projection.manifest.source_family_id_sha256,
    operator_group_id_sha256: projection.manifest.operator_group_id_sha256,
    source_revision: projection.manifest.source_revision
  };

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    const artifactRoot = path.join(stagingRoot, "annotator", "artifacts", normalizationId);
    await fs.cp(sourceRoot, artifactRoot, { recursive: true, errorOnExist: true, force: false });
    await fs.writeFile(path.join(stagingRoot, "annotator", "normalization-tasks.jsonl"), `${JSON.stringify({
      schema_version: "1.0",
      normalization_id: normalizationId,
      artifact_root: `artifacts/${normalizationId}`,
      required_output_fields: normalizationOutputFields()
    })}\n`, "utf8");
    await writeJsonFile(path.join(stagingRoot, "private-normalization-map.json"), privateMap);
    await fs.writeFile(path.join(stagingRoot, "annotator", "RUBRIC.md"), normalizationRubric(), "utf8");
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    normalization_id: normalizationId,
    output_dir: portableRef(cwd, outDir),
    annotator_dir: portableRef(cwd, path.join(outDir, "annotator")),
    tasks_path: portableRef(cwd, path.join(outDir, "annotator", "normalization-tasks.jsonl")),
    private_map_path: portableRef(cwd, path.join(outDir, "private-normalization-map.json")),
    rubric_path: portableRef(cwd, path.join(outDir, "annotator", "RUBRIC.md"))
  };
}

export async function normalizePromotionSource(
  input: NormalizePromotionSourceInput
): Promise<NormalizePromotionSourceResult> {
  const cwd = path.resolve(input.cwd);
  const sourceRoot = path.resolve(cwd, input.sourceRoot);
  const privateMapPath = path.resolve(cwd, input.privateMapPath);
  const outDir = path.resolve(cwd, input.outDir);
  if (input.annotationPaths.length !== 2) {
    throw new Error("Source normalization requires exactly two independent annotation files.");
  }
  if (isSameOrContainedPath(sourceRoot, outDir)) {
    throw new Error("Normalized output must stay outside the projected source bundle.");
  }
  if (await pathExists(outDir)) throw new Error(`Normalized source output already exists: ${portableRef(cwd, outDir)}`);

  const projection = await inspectPromotionSourceProjection(sourceRoot);
  if (!projection.integrity_passed || !projection.manifest) {
    throw new Error(`Source normalization requires an integrity-valid projection: ${projection.issues.map((issue) => issue.code).join(", ") || "unreadable"}.`);
  }
  const privateMap = parsePrivateMap(JSON.parse(await fs.readFile(privateMapPath, "utf8")) as unknown);
  await assertPrivateMapMatchesSource(privateMap, sourceRoot, projection.manifest);

  const initial = await Promise.all(input.annotationPaths.map((annotationPath) =>
    readAnnotation(path.resolve(cwd, annotationPath), privateMap.normalization_id)));
  if (initial[0].annotation.annotator_id === initial[1].annotation.annotator_id) {
    throw new Error("Initial source-normalization annotations must use distinct annotator IDs.");
  }
  const initialConsensus = labelsEqual(initial[0].annotation, initial[1].annotation);
  let acceptedAnnotation: PromotionSourceNormalizationAnnotation;
  let resolution: ParsedAnnotation | undefined;
  let adjudicationSource: AcceptedLabelRecord["adjudication_source"];
  if (initialConsensus) {
    acceptedAnnotation = initial[0].annotation;
    adjudicationSource = "double_adjudication_consensus";
    if (input.resolutionPath) throw new Error("A resolution file is not allowed when initial normalization annotations agree.");
  } else {
    if (!input.resolutionPath) throw new Error("A third-party resolution is required when source-normalization annotations disagree.");
    resolution = await readAnnotation(path.resolve(cwd, input.resolutionPath), privateMap.normalization_id);
    if (initial.some((item) => item.annotation.annotator_id === resolution!.annotation.annotator_id)) {
      throw new Error("Source-normalization resolver ID must differ from both initial annotator IDs.");
    }
    acceptedAnnotation = resolution.annotation;
    adjudicationSource = "third_party_resolution";
  }

  validateAcceptedLabel(acceptedAnnotation, projection.manifest.outputs.map((output) => output.target_path));
  await validateSelectedResultTable(path.join(sourceRoot, acceptedAnnotation.result_table_path));

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    await fs.cp(sourceRoot, path.join(stagingRoot, "source"), { recursive: true, errorOnExist: true, force: false });
    await fs.copyFile(path.join(sourceRoot, PROMOTION_SOURCE_LICENSE_FILE), path.join(stagingRoot, PROMOTION_SOURCE_LICENSE_FILE));
    await fs.copyFile(path.join(sourceRoot, acceptedAnnotation.result_table_path), path.join(stagingRoot, "result_table.json"));
    await writeCanonicalEnvelope(stagingRoot, privateMap.normalization_id, acceptedAnnotation);

    const annotationDir = path.join(stagingRoot, "normalization");
    await fs.mkdir(annotationDir, { recursive: true });
    const initialPaths: [string, string] = [
      "normalization/annotation-a.json",
      "normalization/annotation-b.json"
    ];
    await writeJsonFile(path.join(stagingRoot, initialPaths[0]), initial[0].annotation);
    await writeJsonFile(path.join(stagingRoot, initialPaths[1]), initial[1].annotation);
    const resolutionPath = resolution ? "normalization/resolution.json" : null;
    if (resolutionPath && resolution) await writeJsonFile(path.join(stagingRoot, resolutionPath), resolution.annotation);
    const acceptedLabelPath = "normalization/accepted-label.json";
    const acceptedLabel: AcceptedLabelRecord = {
      schema_version: "1.0",
      normalization_id: privateMap.normalization_id,
      adjudication_source: adjudicationSource,
      adjudicator_ids: [
        initial[0].annotation.annotator_id,
        initial[1].annotation.annotator_id,
        ...(resolution ? [resolution.annotation.annotator_id] : [])
      ],
      label: labelFrom(acceptedAnnotation)
    };
    await writeJsonFile(path.join(stagingRoot, acceptedLabelPath), acceptedLabel);

    await preparePromotionExecutionEvidence({
      cwd: stagingRoot,
      sourceRoot: ".",
      runId: acceptedAnnotation.run_id,
      executionBackend: acceptedAnnotation.execution_backend,
      startedAt: acceptedAnnotation.started_at,
      completedAt: acceptedAnnotation.completed_at,
      trialIds: acceptedAnnotation.trial_ids,
      artifacts: acceptedAnnotation.execution_artifacts.map((artifact) => ({
        role: artifact.role,
        path: `source/${artifact.path}`
      }))
    });
    await validatePromotionMutationCompatibility(
      stagingRoot,
      promotionVariantDefinitions().filter((variant) => variant.mutation_family).map((variant) => variant.operations)
    );

    const sourceArtifactSha256 = await hashPromotionArtifactTree(path.join(stagingRoot, "source"));
    const sourceProjectionManifestSha256 = await hashFile(path.join(stagingRoot, "source", PROMOTION_SOURCE_PROJECTION_MANIFEST));
    const licenseSha256 = await hashFile(path.join(stagingRoot, PROMOTION_SOURCE_LICENSE_FILE));
    const outputs = await inventoryNormalizationOutputs(stagingRoot);
    const manifest: PromotionSourceNormalizationManifest = {
      schema_version: "1.0",
      normalization_id: privateMap.normalization_id,
      normalization_status: resolution ? "third_party_resolved" : "double_adjudicated",
      source_artifact_sha256: sourceArtifactSha256,
      source_projection_manifest_sha256: sourceProjectionManifestSha256,
      source_family_id_sha256: projection.manifest.source_family_id_sha256,
      operator_group_id_sha256: projection.manifest.operator_group_id_sha256,
      source_revision: projection.manifest.source_revision,
      distribution_scope: projection.manifest.distribution_scope,
      license_review_status: projection.manifest.license_review_status,
      license_sha256: licenseSha256,
      initial_annotator_ids: initial.map((item) => item.annotation.annotator_id).sort(),
      resolver_id: resolution?.annotation.annotator_id || null,
      initial_annotation_paths: initialPaths,
      resolution_path: resolutionPath,
      accepted_label_path: acceptedLabelPath,
      execution_evidence_verified: true,
      promotion_compatible: true,
      ready_for_confirmatory_intake: true,
      outputs,
      evidence_boundary: "Normalization records blind human mapping and hash-bound source artifacts. Annotator IDs do not prove real-world identity, and human labels do not independently prove that execution occurred."
    };
    await writeJsonFile(path.join(stagingRoot, PROMOTION_SOURCE_NORMALIZATION_MANIFEST), manifest);
    const inspection = await inspectPromotionSourceNormalization(stagingRoot);
    if (!inspection.passed) {
      throw new Error(`Normalized source failed self-inspection: ${inspection.issues.map((issue) => issue.code).join(", ")}.`);
    }
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    normalization_id: privateMap.normalization_id,
    adjudication_source: adjudicationSource,
    output_dir: portableRef(cwd, outDir),
    manifest_path: portableRef(cwd, path.join(outDir, PROMOTION_SOURCE_NORMALIZATION_MANIFEST))
  };
}

export async function inspectPromotionSourceNormalization(
  bundleRoot: string
): Promise<PromotionSourceNormalizationInspection> {
  const root = path.resolve(bundleRoot);
  const issues: PromotionSourceNormalizationIssue[] = [];
  let manifest: PromotionSourceNormalizationManifest;
  try {
    manifest = parseNormalizationManifest(JSON.parse(await fs.readFile(path.join(root, PROMOTION_SOURCE_NORMALIZATION_MANIFEST), "utf8")) as unknown);
  } catch {
    return {
      passed: false,
      manifest: null,
      issues: [{ code: "source_normalization_manifest_unreadable", message: "The source-normalization manifest is missing or invalid." }]
    };
  }

  const expectedFiles = new Set([PROMOTION_SOURCE_NORMALIZATION_MANIFEST, ...manifest.outputs.map((output) => output.path)]);
  try {
    const observedFiles = await listRegularFiles(root);
    for (const observed of observedFiles) {
      if (!expectedFiles.has(observed)) {
        issues.push({ code: "source_normalization_untracked_artifact", message: "Normalized bundles may contain only manifest-bound files.", ref: observed });
      }
    }
    for (const expected of expectedFiles) {
      if (!observedFiles.includes(expected)) {
        issues.push({ code: "source_normalization_artifact_missing", message: "A manifest-bound normalized artifact is missing.", ref: expected });
      }
    }
  } catch {
    issues.push({ code: "source_normalization_file_inventory_invalid", message: "The normalized bundle contains an unreadable or non-regular filesystem entry." });
  }
  for (const output of manifest.outputs) {
    const actual = await hashContainedRegularFile(root, output.path).catch(() => null);
    if (!actual || actual !== output.sha256) {
      issues.push({ code: "source_normalization_output_hash_mismatch", message: "A normalized output is missing or no longer matches its recorded hash.", ref: output.path });
    }
  }

  const nestedSource = path.join(root, "source");
  const projection = await inspectPromotionSourceProjection(nestedSource);
  if (!projection.integrity_passed || !projection.manifest) {
    issues.push({ code: "source_normalization_projection_integrity_failed", message: "The nested source projection is missing, changed, or invalid." });
  } else {
    if (projection.manifest.source_family_id_sha256 !== manifest.source_family_id_sha256
        || projection.manifest.operator_group_id_sha256 !== manifest.operator_group_id_sha256
        || projection.manifest.source_revision !== manifest.source_revision) {
      issues.push({ code: "source_normalization_projection_identity_mismatch", message: "Nested source identity does not match the normalization manifest." });
    }
    if (projection.manifest.distribution_scope !== manifest.distribution_scope
        || projection.manifest.license_review_status !== manifest.license_review_status) {
      issues.push({ code: "source_normalization_projection_license_scope_mismatch", message: "Nested source distribution or license-review status does not match the normalization manifest." });
    }
  }
  const nestedSourceHash = await hashPromotionArtifactTree(nestedSource).catch(() => null);
  if (!nestedSourceHash || nestedSourceHash !== manifest.source_artifact_sha256) {
    issues.push({ code: "source_normalization_source_hash_mismatch", message: "The nested projected source no longer matches its recorded tree hash." });
  }
  const nestedProjectionManifestHash = await hashContainedRegularFile(root, `source/${PROMOTION_SOURCE_PROJECTION_MANIFEST}`).catch(() => null);
  if (!nestedProjectionManifestHash || nestedProjectionManifestHash !== manifest.source_projection_manifest_sha256) {
    issues.push({ code: "source_normalization_projection_manifest_hash_mismatch", message: "The nested source-projection manifest no longer matches its recorded hash." });
  }
  const licenseHash = await hashContainedRegularFile(root, PROMOTION_SOURCE_LICENSE_FILE).catch(() => null);
  if (!licenseHash || licenseHash !== manifest.license_sha256) {
    issues.push({ code: "source_normalization_license_hash_mismatch", message: "The normalized source license is missing or changed." });
  }
  if (licenseHash && projection.manifest && licenseHash !== projection.manifest.license_sha256) {
    issues.push({ code: "source_normalization_license_source_mismatch", message: "The normalized source license does not match the license bound by the nested projection." });
  }

  const outputByPath = new Map(manifest.outputs.map((output) => [output.path, output]));
  const tracePaths = [
    ...manifest.initial_annotation_paths,
    ...(manifest.resolution_path ? [manifest.resolution_path] : []),
    manifest.accepted_label_path
  ];
  if (tracePaths.some((tracePath) => outputByPath.get(tracePath)?.provenance !== "human_annotation")
      || outputByPath.get("execution-evidence.json")?.provenance !== "derived_hash_manifest"
      || manifest.outputs.some((output) => output.path.startsWith("source/") && output.provenance !== "projected_source")) {
    issues.push({ code: "source_normalization_output_provenance_invalid", message: "Normalization trace, source, or derived manifest files have invalid provenance classes." });
  }

  await validateAdjudicationTrace(root, manifest, issues);
  const executionEvidence = await inspectPromotionExecutionEvidence(root);
  if (!executionEvidence.passed || !manifest.execution_evidence_verified) {
    issues.push({ code: "source_normalization_execution_evidence_failed", message: "The normalized bundle lacks passing hash-bound execution evidence." });
  }
  try {
    await validatePromotionMutationCompatibility(
      root,
      promotionVariantDefinitions().filter((variant) => variant.mutation_family).map((variant) => variant.operations)
    );
  } catch {
    issues.push({ code: "source_normalization_mutation_compatibility_failed", message: "The normalized bundle does not satisfy every canonical promotion mutation target." });
  }
  if (!manifest.ready_for_confirmatory_intake || !manifest.promotion_compatible
      || manifest.distribution_scope !== "redistributable" || manifest.license_review_status !== "human_verified") {
    issues.push({ code: "source_normalization_not_confirmatory_ready", message: "The normalization manifest does not declare every confirmatory intake prerequisite." });
  }
  return { passed: issues.length === 0, manifest, issues };
}

async function writeCanonicalEnvelope(
  root: string,
  normalizationId: string,
  annotation: PromotionSourceNormalizationAnnotation
): Promise<void> {
  const claimId = `claim-${sha256Text(normalizationId).slice(0, 16)}`;
  const claim = {
    claim_id: claimId,
    statement: annotation.claim_text,
    section_heading: annotation.claim_section_heading,
    status: annotation.claim_status,
    artifact_refs: ["result_table.json"],
    citation_refs: annotation.citation_refs,
    reproduction_trace_present: true
  };
  await writeJsonFile(path.join(root, "experiment_evidence.json"), {
    trials: annotation.trial_ids.map((trialId) => ({ trial_id: trialId }))
  });
  await writeJsonFile(path.join(root, "run_config.json"), { planned_budget: { trials: annotation.planned_trial_count } });
  await writeJsonFile(path.join(root, "run_record.json"), {
    id: annotation.run_id,
    status: annotation.run_status,
    executed_budget: { trials: annotation.executed_trial_count }
  });
  await writeJsonFile(path.join(root, "checkpoint", "state.json"), {
    paper_ready: annotation.paper_ready,
    run_status: annotation.run_status
  });
  await writeJsonFile(path.join(root, "design_contracts.json"), {
    sota_ranking_claimed: annotation.sota_ranking_claimed,
    sota_evidence_present: annotation.sota_evidence_present
  });
  await writeJsonFile(path.join(root, "figure_audit", "figure_audit_summary.json"), {
    figure_count: annotation.figure_count,
    figure_artifact_refs: annotation.figure_paths.map(sourceArtifactRef),
    issues: [],
    severe_mismatch_count: annotation.severe_mismatch_count,
    review_block_required: annotation.review_block_required
  });
  await writeJsonFile(path.join(root, "review", "paper_critique.json"), {
    paper_readiness_state: annotation.paper_ready ? "paper_ready" : "blocked",
    claim_ceiling_applied: true,
    source_artifact_ref: sourceArtifactRef(annotation.readiness_source_path)
  });
  await writeJsonFile(path.join(root, "review", "decision.json"), {
    outcome: annotation.paper_ready ? "accept" : "block",
    decision_source: "double_human_source_normalization",
    source_artifact_ref: sourceArtifactRef(annotation.readiness_source_path)
  });
  await writeJsonFile(path.join(root, "paper", "paper_readiness.json"), {
    paper_ready: annotation.paper_ready,
    readiness_state: annotation.paper_ready ? "paper_ready" : "blocked"
  });
  await writeJsonFile(path.join(root, "paper", "claim_status_table.json"), { claims: [claim] });
  await writeJsonFile(path.join(root, "paper", "claim_evidence_table.json"), {
    claims: [{
      claim_id: claimId,
      statement: annotation.claim_text,
      section_heading: annotation.claim_section_heading,
      artifact_refs: ["result_table.json"],
      citation_refs: annotation.citation_refs,
      source_artifact_refs: annotation.claim_source_paths.map(sourceArtifactRef),
      citation_source_artifact_refs: annotation.citation_source_paths.map(sourceArtifactRef),
      strength: "source_reported"
    }]
  });
  await writeJsonFile(path.join(root, "paper", "evidence_links.json"), {
    claims: [{
      claim_id: claimId,
      evidence_ids: annotation.evidence_ids,
      citation_paper_ids: annotation.citation_paper_ids,
      source_artifact_refs: annotation.evidence_refs.map(sourceArtifactRef)
    }]
  });
  await fs.writeFile(path.join(root, "evidence_store.jsonl"), `${JSON.stringify({
    id: annotation.evidence_ids[0],
    source_normalization_id: normalizationId,
    metric_evidence_present: true,
    source_artifact_refs: annotation.evidence_refs.map(sourceArtifactRef)
  })}\n`, "utf8");
  await fs.writeFile(
    path.join(root, "paper", "main.tex"),
    "\\section{Results}\nThe source-reported comparison is represented by the linked result table and provenance record.\n",
    "utf8"
  );
}

async function validateAdjudicationTrace(
  root: string,
  manifest: PromotionSourceNormalizationManifest,
  issues: PromotionSourceNormalizationIssue[]
): Promise<void> {
  try {
    const initial = await Promise.all(manifest.initial_annotation_paths.map((relativePath) =>
      readAnnotation(path.join(root, relativePath), manifest.normalization_id)));
    if (new Set(initial.map((item) => item.annotation.annotator_id)).size !== 2
        || initial.map((item) => item.annotation.annotator_id).sort().join("\u0000") !== manifest.initial_annotator_ids.join("\u0000")) {
      throw new Error("initial annotator identity mismatch");
    }
    const accepted = parseAcceptedLabel(JSON.parse(await fs.readFile(path.join(root, manifest.accepted_label_path), "utf8")) as unknown);
    if (accepted.normalization_id !== manifest.normalization_id) throw new Error("accepted label id mismatch");
    const expectedAcceptedIds = [
      ...initial.map((item) => item.annotation.annotator_id),
      ...(manifest.resolver_id ? [manifest.resolver_id] : [])
    ].sort();
    if (new Set(accepted.adjudicator_ids).size !== accepted.adjudicator_ids.length
        || [...accepted.adjudicator_ids].sort().join("\u0000") !== expectedAcceptedIds.join("\u0000")) {
      throw new Error("accepted label adjudicator trace mismatch");
    }
    if (manifest.normalization_status === "double_adjudicated") {
      if (!labelsEqual(initial[0].annotation, initial[1].annotation) || manifest.resolution_path || manifest.resolver_id
          || accepted.adjudication_source !== "double_adjudication_consensus"
          || !labelsEqual(accepted.label, initial[0].annotation)) {
        throw new Error("double-adjudication trace mismatch");
      }
    } else {
      if (!manifest.resolution_path || !manifest.resolver_id || labelsEqual(initial[0].annotation, initial[1].annotation)) {
        throw new Error("resolution trace missing");
      }
      const resolution = await readAnnotation(path.join(root, manifest.resolution_path), manifest.normalization_id);
      if (resolution.annotation.annotator_id !== manifest.resolver_id
          || initial.some((item) => item.annotation.annotator_id === manifest.resolver_id)
          || accepted.adjudication_source !== "third_party_resolution"
          || !labelsEqual(accepted.label, resolution.annotation)) {
        throw new Error("resolution trace mismatch");
      }
    }
  } catch {
    issues.push({ code: "source_normalization_adjudication_trace_invalid", message: "The blind double-annotation or third-party resolution trace is missing, changed, or inconsistent." });
  }
}

function validateAcceptedLabel(
  annotation: PromotionSourceNormalizationAnnotation,
  projectedPaths: string[]
): void {
  const selectedPaths = new Set(projectedPaths);
  if (annotation.run_status !== "completed" || annotation.exit_code !== 0) {
    throw new Error("Only source-grounded completed runs with exit_code=0 can become clean promotion bases.");
  }
  if (annotation.planned_trial_count < 3 || annotation.executed_trial_count !== annotation.planned_trial_count
      || annotation.trial_ids.length !== annotation.executed_trial_count
      || new Set(annotation.trial_ids).size !== annotation.trial_ids.length) {
    throw new Error("Clean promotion bases require at least three distinct, count-matched trial IDs.");
  }
  const startedAt = parseTimestamp(annotation.started_at);
  const completedAt = parseTimestamp(annotation.completed_at);
  if (startedAt == null || completedAt == null || completedAt <= startedAt) {
    throw new Error("Source-normalization timestamps must be valid and ordered.");
  }
  if (annotation.figure_count < 1 || annotation.figure_paths.length !== annotation.figure_count
      || annotation.severe_mismatch_count !== 0 || annotation.review_block_required) {
    throw new Error("Clean promotion bases require a source-grounded, conflict-free figure audit.");
  }
  if (!annotation.paper_ready || annotation.claim_status !== "verified"
      || annotation.citation_refs.length === 0 || annotation.evidence_ids.length === 0
      || annotation.citation_paper_ids.length === 0
      || (annotation.sota_ranking_claimed && !annotation.sota_evidence_present)) {
    throw new Error("Clean promotion bases require verified claim links and an evidence-bounded paper-ready decision.");
  }
  if (!selectedPaths.has(annotation.result_table_path)) {
    throw new Error("Selected result table must be a manifest-bound projected output.");
  }
  const artifactRoles = new Set(annotation.execution_artifacts.map((artifact) => artifact.role));
  const artifactPaths = annotation.execution_artifacts.map((artifact) => artifact.path);
  if (PROMOTION_EXECUTION_EVIDENCE_ROLES.some((role) => !artifactRoles.has(role))
      || artifactRoles.size !== PROMOTION_EXECUTION_EVIDENCE_ROLES.length
      || new Set(artifactPaths).size !== artifactPaths.length
      || artifactPaths.some((artifactPath) => !selectedPaths.has(artifactPath))) {
    throw new Error("Every execution-evidence role must select one distinct manifest-bound projected output.");
  }
  const supportingPaths = [
    ...annotation.figure_paths,
    ...annotation.claim_source_paths,
    ...annotation.citation_source_paths,
    annotation.readiness_source_path
  ];
  if (supportingPaths.some((artifactPath) => !selectedPaths.has(artifactPath))) {
    throw new Error("Figure, claim, citation, and readiness evidence must use manifest-bound projected outputs.");
  }
  const reviewDecisionPath = annotation.execution_artifacts.find((artifact) => artifact.role === "review_decision")?.path;
  if (!reviewDecisionPath || annotation.readiness_source_path !== reviewDecisionPath) {
    throw new Error("Readiness evidence must be the selected review-decision execution artifact.");
  }
  const evidenceRefs = new Set(annotation.evidence_refs);
  if (!evidenceRefs.has(annotation.result_table_path)
      || artifactPaths.some((artifactPath) => !evidenceRefs.has(artifactPath))
      || supportingPaths.some((artifactPath) => !evidenceRefs.has(artifactPath))
      || annotation.evidence_refs.some((ref) => !selectedPaths.has(ref))) {
    throw new Error("Normalization evidence_refs must cover every selected result, execution, figure, claim, citation, and readiness artifact.");
  }
}

async function validateSelectedResultTable(filePath: string): Promise<void> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!Array.isArray(value) || value.length === 0 || !isRecord(value[0])
      || value[0].baseline == null || value[0].comparator == null) {
    throw new Error("Selected result table must contain a non-empty array with baseline and comparator fields.");
  }
}

async function assertPrivateMapMatchesSource(
  privateMap: PromotionSourceNormalizationPrivateMap,
  sourceRoot: string,
  manifest: NonNullable<Awaited<ReturnType<typeof inspectPromotionSourceProjection>>["manifest"]>
): Promise<void> {
  const sourceHash = await hashPromotionArtifactTree(sourceRoot);
  const projectionManifestHash = await hashFile(path.join(sourceRoot, PROMOTION_SOURCE_PROJECTION_MANIFEST));
  if (sourceHash !== privateMap.source_artifact_sha256 || projectionManifestHash !== privateMap.source_projection_manifest_sha256
      || manifest.source_family_id_sha256 !== privateMap.source_family_id_sha256
      || manifest.operator_group_id_sha256 !== privateMap.operator_group_id_sha256
      || manifest.source_revision !== privateMap.source_revision) {
    throw new Error("Projected source changed or no longer matches the private normalization map.");
  }
}

async function readAnnotation(filePath: string, normalizationId: string): Promise<ParsedAnnotation> {
  const bytes = await fs.readFile(filePath);
  const text = bytes.toString("utf8").trim();
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    const rows = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (rows.length !== 1) throw new Error("Each source-normalization annotation file must contain exactly one JSON record.");
    raw = JSON.parse(rows[0]) as unknown;
  }
  const annotation = parseAnnotation(raw);
  if (annotation.normalization_id !== normalizationId) throw new Error("Source-normalization annotation belongs to a different task.");
  return { annotation, bytes };
}

function parseAnnotation(value: unknown): PromotionSourceNormalizationAnnotation {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.normalization_id)
      || !validId(value.annotator_id) || value.label_source !== "human" || !nonEmptyString(value.rationale)) {
    throw new Error("Source-normalization annotation metadata is invalid.");
  }
  return {
    schema_version: "1.0",
    normalization_id: value.normalization_id,
    annotator_id: value.annotator_id,
    label_source: "human",
    rationale: value.rationale,
    ...parseLabel(value)
  };
}

export function parsePromotionSourceNormalizationAnnotation(
  value: unknown
): PromotionSourceNormalizationAnnotation {
  return parseAnnotation(value);
}

function parseLabel(value: unknown): PromotionSourceNormalizationLabel {
  if (!isRecord(value) || !validId(value.run_id)
      || (value.run_status !== "completed" && value.run_status !== "failed" && value.run_status !== "partial")
      || !isExecutionBackend(value.execution_backend) || !timestampString(value.started_at) || !timestampString(value.completed_at)
      || !nonNegativeInteger(value.exit_code) || !nonNegativeInteger(value.planned_trial_count)
      || !nonNegativeInteger(value.executed_trial_count) || !validIdArray(value.trial_ids)
      || !Array.isArray(value.execution_artifacts) || !safeRelativePath(value.result_table_path)
      || !nonNegativeInteger(value.figure_count) || !safePathArray(value.figure_paths)
      || !nonNegativeInteger(value.severe_mismatch_count)
      || typeof value.review_block_required !== "boolean" || !nonEmptyString(value.claim_text)
      || !nonEmptyString(value.claim_section_heading) || (value.claim_status !== "verified" && value.claim_status !== "blocked")
      || !safePathArray(value.claim_source_paths) || !nonEmptyStringArray(value.citation_refs)
      || !safePathArray(value.citation_source_paths) || !validIdArray(value.evidence_ids)
      || !validIdArray(value.citation_paper_ids) || typeof value.paper_ready !== "boolean"
      || !safeRelativePath(value.readiness_source_path)
      || typeof value.sota_ranking_claimed !== "boolean" || typeof value.sota_evidence_present !== "boolean"
      || !safePathArray(value.evidence_refs)) {
    throw new Error("Source-normalization label is invalid or incomplete.");
  }
  const executionArtifacts = value.execution_artifacts.map((artifact, index) => {
    if (!isRecord(artifact) || !isExecutionEvidenceRole(artifact.role) || !safeRelativePath(artifact.path)) {
      throw new Error(`Invalid source-normalization execution artifact at index ${index + 1}.`);
    }
    return { role: artifact.role, path: artifact.path };
  }).sort((left, right) => left.role.localeCompare(right.role));
  return {
    run_id: value.run_id,
    run_status: value.run_status,
    execution_backend: value.execution_backend,
    started_at: value.started_at,
    completed_at: value.completed_at,
    exit_code: value.exit_code,
    planned_trial_count: value.planned_trial_count,
    executed_trial_count: value.executed_trial_count,
    trial_ids: [...value.trial_ids].sort(),
    execution_artifacts: executionArtifacts,
    result_table_path: value.result_table_path,
    figure_count: value.figure_count,
    figure_paths: [...value.figure_paths].sort(),
    severe_mismatch_count: value.severe_mismatch_count,
    review_block_required: value.review_block_required,
    claim_text: value.claim_text,
    claim_section_heading: value.claim_section_heading,
    claim_status: value.claim_status,
    claim_source_paths: [...value.claim_source_paths].sort(),
    citation_refs: [...value.citation_refs].sort(),
    citation_source_paths: [...value.citation_source_paths].sort(),
    evidence_ids: [...value.evidence_ids].sort(),
    citation_paper_ids: [...value.citation_paper_ids].sort(),
    paper_ready: value.paper_ready,
    readiness_source_path: value.readiness_source_path,
    sota_ranking_claimed: value.sota_ranking_claimed,
    sota_evidence_present: value.sota_evidence_present,
    evidence_refs: [...value.evidence_refs].sort()
  };
}

function parsePrivateMap(value: unknown): PromotionSourceNormalizationPrivateMap {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.normalization_id)
      || !sha256String(value.source_artifact_sha256) || !sha256String(value.source_projection_manifest_sha256)
      || !sha256String(value.source_family_id_sha256) || !sha256String(value.operator_group_id_sha256)
      || !nonEmptyString(value.source_revision)) {
    throw new Error("Private source-normalization map is invalid.");
  }
  return {
    schema_version: "1.0",
    normalization_id: value.normalization_id,
    source_artifact_sha256: value.source_artifact_sha256,
    source_projection_manifest_sha256: value.source_projection_manifest_sha256,
    source_family_id_sha256: value.source_family_id_sha256,
    operator_group_id_sha256: value.operator_group_id_sha256,
    source_revision: value.source_revision
  };
}

function parseNormalizationManifest(value: unknown): PromotionSourceNormalizationManifest {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.normalization_id)
      || (value.normalization_status !== "double_adjudicated" && value.normalization_status !== "third_party_resolved")
      || !sha256String(value.source_artifact_sha256) || !sha256String(value.source_projection_manifest_sha256)
      || !sha256String(value.source_family_id_sha256) || !sha256String(value.operator_group_id_sha256)
      || !nonEmptyString(value.source_revision)
      || (value.distribution_scope !== "local_evaluation_only" && value.distribution_scope !== "redistributable")
      || (value.license_review_status !== "unreviewed" && value.license_review_status !== "human_verified")
      || !sha256String(value.license_sha256) || !validIdArray(value.initial_annotator_ids)
      || value.initial_annotator_ids.length !== 2 || (value.resolver_id !== null && !validId(value.resolver_id))
      || !Array.isArray(value.initial_annotation_paths) || value.initial_annotation_paths.length !== 2
      || !value.initial_annotation_paths.every(safeRelativePath)
      || (value.resolution_path !== null && !safeRelativePath(value.resolution_path))
      || !safeRelativePath(value.accepted_label_path) || typeof value.execution_evidence_verified !== "boolean"
      || typeof value.promotion_compatible !== "boolean" || typeof value.ready_for_confirmatory_intake !== "boolean"
      || !Array.isArray(value.outputs) || !nonEmptyString(value.evidence_boundary)) {
    throw new Error("Source-normalization manifest is invalid.");
  }
  const outputs = value.outputs.map((output, index) => {
    if (!isRecord(output) || !safeRelativePath(output.path) || !sha256String(output.sha256)
        || (output.provenance !== "projected_source" && output.provenance !== "human_annotation"
          && output.provenance !== "canonical_normalization" && output.provenance !== "derived_hash_manifest")) {
      throw new Error(`Invalid source-normalization output at index ${index + 1}.`);
    }
    return {
      path: output.path,
      sha256: output.sha256,
      provenance: output.provenance
    } as PromotionSourceNormalizationOutputRecord;
  });
  if (new Set(outputs.map((output) => output.path)).size !== outputs.length
      || outputs.some((output) => output.path === PROMOTION_SOURCE_NORMALIZATION_MANIFEST)) {
    throw new Error("Source-normalization output paths must be unique and may not contain the manifest itself.");
  }
  return {
    schema_version: "1.0",
    normalization_id: value.normalization_id,
    normalization_status: value.normalization_status,
    source_artifact_sha256: value.source_artifact_sha256,
    source_projection_manifest_sha256: value.source_projection_manifest_sha256,
    source_family_id_sha256: value.source_family_id_sha256,
    operator_group_id_sha256: value.operator_group_id_sha256,
    source_revision: value.source_revision,
    distribution_scope: value.distribution_scope,
    license_review_status: value.license_review_status,
    license_sha256: value.license_sha256,
    initial_annotator_ids: [...value.initial_annotator_ids].sort(),
    resolver_id: value.resolver_id,
    initial_annotation_paths: [value.initial_annotation_paths[0], value.initial_annotation_paths[1]],
    resolution_path: value.resolution_path,
    accepted_label_path: value.accepted_label_path,
    execution_evidence_verified: value.execution_evidence_verified,
    promotion_compatible: value.promotion_compatible,
    ready_for_confirmatory_intake: value.ready_for_confirmatory_intake,
    outputs,
    evidence_boundary: value.evidence_boundary
  };
}

function parseAcceptedLabel(value: unknown): AcceptedLabelRecord {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.normalization_id)
      || (value.adjudication_source !== "double_adjudication_consensus" && value.adjudication_source !== "third_party_resolution")
      || !validIdArray(value.adjudicator_ids) || !isRecord(value.label)) {
    throw new Error("Accepted source-normalization label is invalid.");
  }
  return {
    schema_version: "1.0",
    normalization_id: value.normalization_id,
    adjudication_source: value.adjudication_source,
    adjudicator_ids: value.adjudicator_ids,
    label: parseLabel(value.label)
  };
}

function labelFrom(value: PromotionSourceNormalizationLabel): PromotionSourceNormalizationLabel {
  return parseLabel(value);
}

function labelsEqual(left: PromotionSourceNormalizationLabel, right: PromotionSourceNormalizationLabel): boolean {
  return JSON.stringify(labelFrom(left)) === JSON.stringify(labelFrom(right));
}

export function promotionSourceNormalizationLabelFrom(
  value: PromotionSourceNormalizationLabel
): PromotionSourceNormalizationLabel {
  return labelFrom(value);
}

export function promotionSourceNormalizationLabelsEqual(
  left: PromotionSourceNormalizationLabel,
  right: PromotionSourceNormalizationLabel
): boolean {
  return labelsEqual(left, right);
}

async function inventoryNormalizationOutputs(root: string): Promise<PromotionSourceNormalizationOutputRecord[]> {
  const files = (await listRegularFiles(root)).filter((relativePath) => relativePath !== PROMOTION_SOURCE_NORMALIZATION_MANIFEST);
  return Promise.all(files.map(async (relativePath) => ({
    path: relativePath,
    sha256: await hashFile(path.join(root, relativePath)),
    provenance: outputProvenance(relativePath)
  }))).then((records) => records.sort((left, right) => left.path.localeCompare(right.path)));
}

function outputProvenance(relativePath: string): PromotionSourceNormalizationOutputRecord["provenance"] {
  if (relativePath.startsWith("source/")) return "projected_source";
  if (relativePath.startsWith("normalization/")) return "human_annotation";
  if (relativePath === "execution-evidence.json") return "derived_hash_manifest";
  return "canonical_normalization";
}

async function listRegularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("symbolic link");
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) files.push(path.relative(root, absolutePath).replace(/\\/gu, "/"));
      else throw new Error("non-regular entry");
    }
  };
  await visit(root);
  return files;
}

async function hashContainedRegularFile(root: string, relativePath: string): Promise<string> {
  if (!safeRelativePath(relativePath)) throw new Error("invalid path");
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("symbolic link");
  }
  const stat = await fs.stat(current);
  if (!stat.isFile()) throw new Error("not a regular file");
  return hashFile(current);
}

function normalizationOutputFields(): string[] {
  return [
    "schema_version", "normalization_id", "annotator_id", "label_source", "run_id", "run_status",
    "execution_backend", "started_at", "completed_at", "exit_code", "planned_trial_count",
    "executed_trial_count", "trial_ids", "execution_artifacts", "result_table_path", "figure_count", "figure_paths",
    "severe_mismatch_count", "review_block_required", "claim_text", "claim_section_heading", "claim_status", "claim_source_paths",
    "citation_refs", "citation_source_paths", "evidence_ids", "citation_paper_ids", "paper_ready", "readiness_source_path", "sota_ranking_claimed",
    "sota_evidence_present", "evidence_refs", "rationale"
  ];
}

function normalizationRubric(): string {
  return `# Source Normalization Rubric

Annotate only facts that can be located in the supplied projected artifact tree. Do not infer successful execution from prose, filenames, or a paper PDF alone.

- Use one portable trial ID per independently recorded run. A random seed may be used as part of an ID, but a seed is not mandatory for deterministic systems.
- Select one distinct projected file for every execution-evidence role. Human annotations map source evidence; they do not create execution evidence.
- Bind every counted figure, mapped claim, citation record, and readiness decision to projected source paths. The readiness path must be the selected review-decision artifact.
- Set paper_ready=true only when the source itself contains a completed-run record, baseline/comparator result table, consistent figure evidence, linked claim evidence, and an explicit readiness decision.
- Put every selected result, execution, figure, claim, citation, and readiness file in evidence_refs. All paths must be relative to the supplied artifact root.
- Two annotators work independently. Do not inspect another annotator's record before submission.
- Use null-free, complete JSON. If a required fact is unavailable, record a non-passing value; the materializer will fail closed.
`;
}

function sourceArtifactRef(relativePath: string): string {
  return `source/${relativePath}`;
}

function isExecutionBackend(value: unknown): value is PromotionExecutionBackend {
  return value === "api_provider" || value === "local_model" || value === "local_runtime" || value === "remote_runtime";
}

function isExecutionEvidenceRole(value: unknown): value is PromotionExecutionEvidenceRole {
  return typeof value === "string" && (PROMOTION_EXECUTION_EVIDENCE_ROLES as readonly string[]).includes(value);
}

function timestampString(value: unknown): value is string {
  return typeof value === "string" && parseTimestamp(value) != null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value) && !value.includes("\\")
    && !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function safePathArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(safeRelativePath) && new Set(value).size === value.length;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}

function validIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(validId) && new Set(value).size === value.length;
}

function nonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString) && new Set(value).size === value.length;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function hashFile(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
}

function isSameOrContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : path.basename(absolutePath);
}
