import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { runPaperReadinessAudit, type PaperReadinessAuditInput } from "./audit/paperReadinessAudit.js";
import { parseModelReviewBundle, type ModelReviewBundle } from "./modelReviewProtocol.js";
import {
  buildBriefCompletenessArtifact,
  buildResearchBriefTemplate,
  validateResearchBriefMarkdown
} from "./runs/researchBriefFiles.js";
import {
  buildEvidenceBundleArtifact,
  buildGateReportArtifact,
  buildMetaHarnessPatchPlanArtifact,
  buildPaperReadinessBundleArtifact,
  buildResearchBriefArtifact,
  buildReviewReportArtifact,
  portableArtifactRef,
  validateResearchGovernanceArtifact,
  type GateReportArtifact,
  type EvidenceBundleArtifact,
  type EvidenceBundleFile,
  type MetaHarnessPatchPlanArtifact,
  type PaperReadinessBundleArtifact,
  type ResearchBriefArtifact,
  type ReviewReportArtifact
} from "./researchGovernanceArtifacts.js";
import { containsNonPortableResearchText } from "./researchGovernancePortability.js";
import { ensureDir, fileExists, writeJsonFile } from "../utils/fs.js";

export {
  inspectPaperReadinessBundle,
  type PaperReadinessBundleInspection,
  type PaperReadinessBundleInspectionIssue
} from "./paperReadinessBundleInspection.js";

export interface ResearchOperationResult<T> {
  artifact: T;
  output_path: string;
  related_paths: string[];
}

const DEFAULT_OUTPUT_ROOT = path.join("outputs", "research-governance");
const EVIDENCE_BUNDLE_SIDECAR = "evidence-bundle.json";
const MODEL_REVIEW_BUNDLE_SIDECAR = "model-review-bundle.json";
const REVIEW_INPUT_RELATIVE_PATHS = [
  "governance_condition.json",
  "result_table.json",
  "evidence_store.jsonl",
  "run_record.json",
  "events.jsonl",
  "figure_audit/figure_audit_summary.json",
  "paper/main.tex",
  "paper/references.bib",
  "paper/claim_evidence_table.json",
  "paper/claim_status_table.json",
  "paper/evidence_links.json",
  "paper/academic_claim_evidence_map.json",
  "paper/reference_evidence_status.json",
  "paper/submission_status.json",
  "paper/refgate_claims.tsv"
] as const;
const PACK_ALLOWLIST = [
  "audit-summary.json",
  "blockers.json",
  "claim-evidence-table.json",
  "audit-timeline.json",
  "claim-promotion-timeline.json",
  "blocked-claim-events.json",
  "done-condition-audit.json",
  "autonomy-metrics.json",
  "external-intake-manifest.json",
  "paper-readiness-audit.md",
  "evidence-bundle.json",
  "gate-report.json",
  "review-report.json",
  "meta-harness-patch-plan.json"
] as const;

const RUN_UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const CONDITION_IDENTIFIER_PATTERN = /\bcondition[_-][a-z0-9][a-z0-9_-]*\b/giu;
const TRACE_IDENTIFIER_PATTERN = /\b(?:event|evt|request|req|resp|span|thread|thr|trace)_(?=[A-Za-z0-9._-]*\d)[A-Za-z0-9][A-Za-z0-9._-]{11,}\b/gu;
const PARAMETER_VALUE_PATTERN = /\b(?:condition\s+)?(?:parameter|factor)(?:[_\s-]+[a-z][a-z0-9_-]*)?\s*(?:=|:)?\s*\d+(?:\.\d+)?\b/giu;
const MODEL_IDENTIFIER_PATTERN = /\b[A-Za-z][A-Za-z0-9._-]*[-_.]\d+(?:\.\d+)?[BbMm]\b/gu;
const UPPER_HYPHEN_ENTITY_PATTERN = /\b[A-Z]{2,}(?:-[A-Za-z][A-Za-z0-9]*)+\b/gu;
const CAMEL_CASE_ENTITY_PATTERN = /\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/gu;
const PUBLIC_CONTRACT_TOKENS = new Set([
  "AutoLabOS",
  "EvidenceBundle",
  "GateReport",
  "ReviewReport",
  "MetaHarnessPatchPlan",
  "PaperReadinessBundle"
]);
const RUN_IDENTIFIER_FIELD_PATTERN = /^(?:run|task|model|benchmark|condition|event|trace|span|request|thread)(?:_id|_name)?$/iu;

export async function runResearchNew(input: {
  cwd: string;
  briefPath: string;
  outDir?: string;
}): Promise<ResearchOperationResult<ResearchBriefArtifact>> {
  const briefPath = resolveWithinCwd(input.cwd, input.briefPath);
  if (!(await fileExists(briefPath))) {
    await ensureDir(path.dirname(briefPath));
    await fs.writeFile(briefPath, buildResearchBriefTemplate(), "utf8");
  }
  const markdown = await fs.readFile(briefPath, "utf8");
  const artifact = buildResearchBriefArtifact({
    markdown,
    sourceLabel: portableInputLabel(input.cwd, briefPath, "<research-brief>"),
    validation: validateResearchBriefMarkdown(markdown),
    completeness: buildBriefCompletenessArtifact(markdown)
  });
  assertValidArtifact(artifact);
  const outDir = resolveOutputDir(input.cwd, input.outDir, "new");
  const outputPath = path.join(outDir, "research-brief.json");
  await writeJsonFile(outputPath, artifact);
  return operationResult(input.cwd, outputPath, artifact, [briefPath]);
}

export async function runResearchAudit(
  input: PaperReadinessAuditInput
): Promise<ResearchOperationResult<GateReportArtifact>> {
  const outDir = resolveOutputDir(input.cwd, input.outDir, "audit");
  const summary = await runPaperReadinessAudit({ ...input, outDir: path.relative(input.cwd, outDir) });
  const externalIntakeBindings = summary.outputs.external_intake_manifest_path
    ? await verifyExternalIntakeManifestBindings({
        cwd: input.cwd,
        manifestPath: summary.outputs.external_intake_manifest_path,
        runRoot: summary.input.run_root
      })
    : [];
  const evidenceSkeleton = buildEvidenceBundleArtifact(summary);
  const boundFiles = await bindEvidenceBundleFiles(
    input.cwd,
    summary.input.run_root,
    [...evidenceSkeleton.files, ...externalIntakeBindings]
  );
  const evidenceBundle = buildEvidenceBundleArtifact(summary, undefined, boundFiles);
  const evidenceBundleSha256 = createHash("sha256")
    .update(`${JSON.stringify(evidenceBundle, null, 2)}\n`)
    .digest("hex");
  const gateReport = buildGateReportArtifact({
    summary,
    evidenceBundle,
    evidenceBundleSha256
  });
  assertValidArtifact(evidenceBundle);
  assertValidArtifact(gateReport);
  const evidencePath = path.join(outDir, "evidence-bundle.json");
  const gatePath = path.join(outDir, "gate-report.json");
  await writeJsonFile(evidencePath, evidenceBundle);
  await writeJsonFile(gatePath, gateReport);
  return operationResult(input.cwd, gatePath, gateReport, [evidencePath, path.join(outDir, "audit-summary.json")]);
}

async function bindEvidenceBundleFiles(
  cwd: string,
  runRootRef: string,
  declaredFiles: readonly EvidenceBundleFile[]
): Promise<EvidenceBundleFile[]> {
  const candidates = new Map<string, EvidenceBundleFile>();
  for (const file of declaredFiles) {
    candidates.set(file.path, { ...file });
  }
  if (isPortableRelativePath(runRootRef)) {
    for (const relativePath of REVIEW_INPUT_RELATIVE_PATHS) {
      const artifactPath = path.posix.join(runRootRef.replace(/\\/gu, "/"), relativePath);
      if (!candidates.has(artifactPath)) {
        candidates.set(artifactPath, { path: artifactPath, required: false });
      }
    }
  }

  const bound: EvidenceBundleFile[] = [];
  for (const file of candidates.values()) {
    if (!isPortableRelativePath(file.path)) {
      bound.push(file);
      continue;
    }
    let boundPath = file.path.replace(/\\/gu, "/");
    let absolutePath = resolveWithinCwd(cwd, file.path);
    if (!(await fileExists(absolutePath))
        && isPortableRelativePath(runRootRef)
        && !file.path.startsWith(`${runRootRef.replace(/\\/gu, "/")}/`)) {
      const runRelativePath = path.posix.join(
        runRootRef.replace(/\\/gu, "/"),
        file.path.replace(/\\/gu, "/")
      );
      absolutePath = resolveWithinCwd(cwd, runRelativePath);
      boundPath = runRelativePath;
    }
    if (!(await fileExists(absolutePath))) {
      if (file.required) bound.push(file);
      continue;
    }
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) continue;
    const bytes = await fs.readFile(absolutePath);
    const observedSha256 = createHash("sha256").update(bytes).digest("hex");
    if ((typeof file.sha256 === "string" || Number.isInteger(file.bytes))
        && (file.sha256 !== observedSha256 || file.bytes !== bytes.byteLength)) {
      throw new Error(
        `Evidence binding drift for ${file.path}: declared SHA-256/bytes do not match actual bytes.`
      );
    }
    bound.push({
      path: boundPath,
      required: true,
      sha256: observedSha256,
      bytes: bytes.byteLength
    });
  }
  return bound;
}

export async function verifyExternalIntakeManifestBindings(input: {
  cwd: string;
  manifestPath: string;
  runRoot: string;
}): Promise<EvidenceBundleFile[]> {
  const manifestPath = resolveWithinCwd(input.cwd, input.manifestPath);
  const manifestStat = await fs.lstat(manifestPath).catch(() => null);
  if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error("External intake manifest must be a regular, non-symbolic-link file.");
  }
  const payload = parseJsonArtifact(await fs.readFile(manifestPath), "external intake manifest");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("External intake manifest must be a JSON object.");
  }
  const manifest = payload as Record<string, unknown>;
  if (manifest.version !== 1
      || typeof manifest.run_root !== "string"
      || !Array.isArray(manifest.copied_files)
      || !Array.isArray(manifest.copied_file_bindings)) {
    throw new Error(
      "External intake manifest requires version, run_root, copied_files, and copied_file_bindings."
    );
  }
  const expectedRunRoot = input.runRoot.replace(/\\/gu, "/");
  if (manifest.run_root !== expectedRunRoot || !isPortableRelativePath(expectedRunRoot)) {
    throw new Error("External intake manifest run_root does not match the audited frozen run root.");
  }

  const copiedFiles = manifest.copied_files.map((value, index) => {
    if (typeof value !== "string") {
      throw new Error(`External intake manifest copied_files[${index}] must be a string.`);
    }
    return normalizeFrozenIntakePath(value, `copied_files[${index}]`);
  });
  const copiedBindings = manifest.copied_file_bindings.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`External intake manifest copied_file_bindings[${index}] must be an object.`);
    }
    const binding = value as Record<string, unknown>;
    if (typeof binding.path !== "string"
        || typeof binding.sha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(binding.sha256)
        || typeof binding.bytes !== "number"
        || !Number.isSafeInteger(binding.bytes)
        || binding.bytes < 0) {
      throw new Error(
        `External intake manifest copied_file_bindings[${index}] has an invalid path, sha256, or bytes field.`
      );
    }
    return {
      path: normalizeFrozenIntakePath(binding.path, `copied_file_bindings[${index}].path`),
      sha256: binding.sha256,
      bytes: binding.bytes
    };
  });
  const copiedFileSet = new Set(copiedFiles);
  const bindingPathSet = new Set(copiedBindings.map((binding) => binding.path));
  if (copiedFileSet.size !== copiedFiles.length
      || bindingPathSet.size !== copiedBindings.length
      || copiedFiles.length !== copiedBindings.length
      || copiedFiles.some((file, index) => copiedBindings[index]?.path !== file)) {
    throw new Error(
      "External intake manifest copied_files and copied_file_bindings must form the same ordered closed inventory."
    );
  }

  const runRoot = resolveWithinCwd(input.cwd, expectedRunRoot);
  const runRootStat = await fs.lstat(runRoot).catch(() => null);
  if (!runRootStat || !runRootStat.isDirectory() || runRootStat.isSymbolicLink()) {
    throw new Error("External intake frozen run root must be a regular, non-symbolic-link directory.");
  }
  const actualFiles = await inventoryFrozenExternalFiles(runRoot, runRoot);
  const expectedFiles = [...copiedFiles].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      "External intake frozen files do not match the manifest copied_files closed inventory."
    );
  }

  const verifiedBindings: EvidenceBundleFile[] = [];
  for (const binding of copiedBindings) {
    const absolutePath = path.join(runRoot, ...binding.path.split("/"));
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`External intake frozen file is not a regular file: ${binding.path}`);
    }
    const bytes = await fs.readFile(absolutePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== binding.bytes || sha256 !== binding.sha256) {
      throw new Error(
        `External intake binding drift for ${binding.path}: manifest SHA-256/bytes do not match frozen bytes.`
      );
    }
    verifiedBindings.push({
      path: portableInputLabel(
        input.cwd,
        absolutePath,
        `<external-artifact-root>/${binding.path}`
      ),
      sha256,
      bytes: bytes.byteLength,
      required: true
    });
  }
  return verifiedBindings;
}

function normalizeFrozenIntakePath(value: string, field: string): string {
  const normalized = value.replace(/\\/gu, "/");
  if (!normalized
      || normalized !== value
      || normalized !== path.posix.normalize(normalized)
      || path.posix.isAbsolute(normalized)
      || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`External intake manifest ${field} must be a portable relative path.`);
  }
  return normalized;
}

async function inventoryFrozenExternalFiles(root: string, current: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath).replace(/\\/gu, "/");
    if (entry.isSymbolicLink()) {
      throw new Error(`External intake frozen inventory contains a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...await inventoryFrozenExternalFiles(root, absolutePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`External intake frozen inventory contains a non-regular entry: ${relativePath}`);
    }
  }
  return files.sort();
}

function isPortableRelativePath(value: string): boolean {
  return Boolean(value)
    && !value.startsWith("<")
    && !path.isAbsolute(value)
    && !value.split(/[\\/]/u).some((segment) => segment === "..");
}

export async function runResearchReview(input: {
  cwd: string;
  gatePath: string;
  outDir?: string;
  modelReviewBundlePath?: string;
}): Promise<ResearchOperationResult<ReviewReportArtifact>> {
  const gateFile = await readTypedArtifactFile<GateReportArtifact>(input.cwd, input.gatePath, "GateReport");
  const gateSha256 = createHash("sha256").update(gateFile.bytes).digest("hex");
  let modelReviewBundlePath: string | undefined;
  let review: ReviewReportArtifact;
  if (input.modelReviewBundlePath) {
    modelReviewBundlePath = resolveWithinCwd(input.cwd, input.modelReviewBundlePath);
    const bundleBytes = await fs.readFile(modelReviewBundlePath);
    const bundleValue = parseJsonArtifact(bundleBytes, "ModelReviewBundle");
    const modelReviewBundle = parseModelReviewBundle(bundleValue, {
      artifact_id: gateFile.artifact.artifact_id,
      sha256: gateSha256
    });
    review = buildReviewReportArtifact(gateFile.artifact, {
      modelReviewBundle,
      modelReviewBundleSha256: createHash("sha256").update(bundleBytes).digest("hex"),
      gateReportSha256: gateSha256
    });
  } else {
    review = buildReviewReportArtifact(gateFile.artifact, {
      gateReportSha256: gateSha256
    });
  }
  assertValidArtifact(review);
  const outDir = resolveOutputDir(input.cwd, input.outDir, "review");
  const outputPath = path.join(outDir, "review-report.json");
  await writeJsonFile(outputPath, review);
  return operationResult(input.cwd, outputPath, review, [
    gateFile.absolutePath,
    ...(modelReviewBundlePath ? [modelReviewBundlePath] : [])
  ]);
}

export async function runResearchImprove(input: {
  cwd: string;
  reviewPath: string;
  outDir?: string;
}): Promise<ResearchOperationResult<MetaHarnessPatchPlanArtifact>> {
  const reviewFile = await readTypedArtifactFile<ReviewReportArtifact>(input.cwd, input.reviewPath, "ReviewReport");
  const patchPlan = buildMetaHarnessPatchPlanArtifact(
    reviewFile.artifact,
    undefined,
    createHash("sha256").update(reviewFile.bytes).digest("hex")
  );
  assertValidArtifact(patchPlan);
  const outDir = resolveOutputDir(input.cwd, input.outDir, "improve");
  const outputPath = path.join(outDir, "meta-harness-patch-plan.json");
  await writeJsonFile(outputPath, patchPlan);
  return operationResult(input.cwd, outputPath, patchPlan, [reviewFile.absolutePath]);
}

export async function runResearchPack(input: {
  cwd: string;
  gatePath: string;
  reviewPath: string;
  sourceDir?: string;
  outDir?: string;
}): Promise<ResearchOperationResult<PaperReadinessBundleArtifact>> {
  const gateFile = await readTypedArtifactFile<GateReportArtifact>(input.cwd, input.gatePath, "GateReport");
  const reviewFile = await readTypedArtifactFile<ReviewReportArtifact>(
    input.cwd,
    input.reviewPath,
    "ReviewReport"
  );
  const gate = gateFile.artifact;
  const review = reviewFile.artifact;
  if (review.gate_report_id !== gate.artifact_id) {
    throw new Error("ReviewReport does not reference the supplied GateReport.");
  }
  if (review.claim_ceiling !== gate.claim_ceiling) {
    throw new Error("ReviewReport claim_ceiling does not match the supplied GateReport.");
  }

  const outDir = resolveOutputDir(input.cwd, input.outDir, "pack");
  const sourceDir = input.sourceDir
    ? resolveWithinCwd(input.cwd, input.sourceDir)
    : path.dirname(gateFile.absolutePath);
  const evidenceBundleSidecar = await loadEvidenceBundleSidecarForPack({
    gate,
    sourceDir
  });
  const modelReviewSidecar = await loadModelReviewSidecarForPack({
    gate,
    gateBytes: gateFile.bytes,
    review,
    sourceDir
  });
  if (input.sourceDir) {
    const supplementalFiles: string[] = PACK_ALLOWLIST.filter((relative) =>
      relative !== "gate-report.json" && relative !== "review-report.json");
    if (modelReviewSidecar) {
      supplementalFiles.push(MODEL_REVIEW_BUNDLE_SIDECAR);
    }
    const supplementalFileExists = await Promise.all(supplementalFiles.map((relative) =>
      fileExists(path.join(sourceDir, relative))));
    if (!supplementalFileExists.some(Boolean)) {
      throw new Error(
        "Research pack --source-dir contains no supported governance sidecar artifacts."
      );
    }
  }
  const artifactDir = path.join(outDir, "artifacts");
  await ensureDir(artifactDir);

  const files: Array<{ path: string; sha256: string; bytes: number }> = [];
  const portabilityIssues: string[] = [];
  const redactedFiles: string[] = [];
  const limitations = review.blocking_issues.map((finding) => finding.message);
  const candidates = uniqueCandidateFiles([
    {
      source: gateFile.absolutePath,
      relative: "gate-report.json",
      redactIdentifiers: false,
      frozenBytes: gateFile.bytes
    },
    {
      source: reviewFile.absolutePath,
      relative: "review-report.json",
      redactIdentifiers: false,
      frozenBytes: reviewFile.bytes
    },
    {
      source: evidenceBundleSidecar.absolutePath,
      relative: EVIDENCE_BUNDLE_SIDECAR,
      redactIdentifiers: false,
      frozenBytes: evidenceBundleSidecar.bytes
    },
    ...(modelReviewSidecar
      ? [{
          source: modelReviewSidecar.absolutePath,
          relative: MODEL_REVIEW_BUNDLE_SIDECAR,
          redactIdentifiers: false,
          frozenBytes: modelReviewSidecar.bytes
        }]
      : []),
    ...PACK_ALLOWLIST.map((relative) => ({
      source: path.join(sourceDir, relative),
      relative,
      redactIdentifiers: true
    })),
    ...gate.input_bindings.map((binding) => ({
      source: resolveWithinCwd(input.cwd, binding.path),
      relative: path.posix.join("evidence", binding.path.replace(/\\/gu, "/")),
      redactIdentifiers: false,
      expectedSha256: binding.sha256,
      expectedBytes: binding.bytes
    }))
  ]);

  for (const candidate of candidates) {
    let raw = candidate.frozenBytes;
    if (!raw) {
      const stat = await fs.lstat(candidate.source).catch(() => null);
      if (!stat) {
        if (candidate.expectedSha256) {
          throw new Error(`EvidenceBundle bound file is missing before pack: ${candidate.relative}`);
        }
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Research pack sidecar must be a regular, non-symbolic-link file: ${candidate.relative}`);
      }
      raw = await fs.readFile(candidate.source);
    }
    if (candidate.expectedSha256 || candidate.expectedBytes !== undefined) {
      const observedSha256 = createHash("sha256").update(raw).digest("hex");
      if (observedSha256 !== candidate.expectedSha256 || raw.byteLength !== candidate.expectedBytes) {
        throw new Error(`EvidenceBundle bound file drifted before pack: ${candidate.relative}`);
      }
    }
    const text = raw.toString("utf8");
    if (containsNonPortableResearchText(text)) {
      if (candidate.expectedSha256) {
        throw new Error(`EvidenceBundle bound file contains non-portable or sensitive text: ${candidate.relative}`);
      }
      portabilityIssues.push(`Excluded ${candidate.relative} because it contains non-portable or sensitive text.`);
      continue;
    }
    const portableCopy = candidate.redactIdentifiers
      ? redactRunSpecificIdentifiers(raw, candidate.relative)
      : { content: raw, redacted: false };
    const destination = path.join(artifactDir, candidate.relative);
    await ensureDir(path.dirname(destination));
    await fs.writeFile(destination, portableCopy.content);
    if (portableCopy.redacted) {
      redactedFiles.push(portableArtifactRef(path.posix.join("artifacts", candidate.relative)));
    }
    files.push({
      path: portableArtifactRef(path.posix.join("artifacts", candidate.relative.replace(/\\/gu, "/"))),
      sha256: createHash("sha256").update(portableCopy.content).digest("hex"),
      bytes: portableCopy.content.byteLength
    });
  }

  if (files.length === 0) {
    throw new Error("No portable governance artifacts were available for packaging.");
  }
  if (!files.some((file) => file.path === `artifacts/${EVIDENCE_BUNDLE_SIDECAR}`)) {
    throw new Error("Research pack could not preserve the required EvidenceBundle sidecar bytes.");
  }
  if (modelReviewSidecar
      && !files.some((file) => file.path === `artifacts/${MODEL_REVIEW_BUNDLE_SIDECAR}`)) {
    throw new Error("A2 pack could not preserve the required ModelReviewBundle sidecar bytes.");
  }
  const bundle = buildPaperReadinessBundleArtifact({
    gate,
    review,
    files,
    limitations,
    portabilityIssues,
    redactedFiles
  });
  assertValidArtifact(bundle);
  const outputPath = path.join(outDir, "paper-readiness-bundle.json");
  await writeJsonFile(outputPath, bundle);
  return operationResult(input.cwd, outputPath, bundle, files.map((file) => path.join(outDir, file.path)));
}

interface FrozenEvidenceBundleSidecar {
  absolutePath: string;
  bytes: Buffer;
  bundle: EvidenceBundleArtifact;
}

async function loadEvidenceBundleSidecarForPack(input: {
  gate: GateReportArtifact;
  sourceDir: string;
}): Promise<FrozenEvidenceBundleSidecar> {
  const absolutePath = path.join(input.sourceDir, EVIDENCE_BUNDLE_SIDECAR);
  const stat = await fs.lstat(absolutePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `Research pack requires --source-dir/${EVIDENCE_BUNDLE_SIDECAR} to be a regular, non-symbolic-link file.`
    );
  }
  const bytes = await fs.readFile(absolutePath);
  if (containsNonPortableResearchText(bytes.toString("utf8"))) {
    throw new Error("EvidenceBundle sidecar contains non-portable or sensitive text.");
  }
  const observedSha256 = createHash("sha256").update(bytes).digest("hex");
  if (observedSha256 !== input.gate.evidence_bundle_sha256) {
    throw new Error("EvidenceBundle sidecar SHA-256 does not match GateReport.evidence_bundle_sha256.");
  }
  const payload = parseJsonArtifact(bytes, "EvidenceBundle");
  const validation = validateResearchGovernanceArtifact(payload);
  if (!validation.ok || (payload as { artifact_type?: unknown }).artifact_type !== "EvidenceBundle") {
    throw new Error("EvidenceBundle sidecar is not a valid EvidenceBundle artifact.");
  }
  const bundle = payload as EvidenceBundleArtifact;
  if (bundle.artifact_id !== input.gate.evidence_bundle_id) {
    throw new Error("EvidenceBundle sidecar artifact_id does not match GateReport.evidence_bundle_id.");
  }
  const bundleBindings = bundle.files.filter(
    (file): file is EvidenceBundleFile & { sha256: string; bytes: number } =>
      typeof file.sha256 === "string" && Number.isSafeInteger(file.bytes)
  );
  if (JSON.stringify(bundleBindings) !== JSON.stringify(input.gate.input_bindings)) {
    throw new Error("EvidenceBundle bound files do not exactly match GateReport.input_bindings.");
  }
  return { absolutePath, bytes, bundle };
}

interface FrozenModelReviewSidecar {
  absolutePath: string;
  bytes: Buffer;
  bundle: ModelReviewBundle;
}

async function loadModelReviewSidecarForPack(input: {
  gate: GateReportArtifact;
  gateBytes: Buffer;
  review: ReviewReportArtifact;
  sourceDir: string;
}): Promise<FrozenModelReviewSidecar | undefined> {
  const assurance = (input.review as {
    reviewer_assurance?: ReviewReportArtifact["reviewer_assurance"];
  }).reviewer_assurance;
  if (!assurance) {
    throw new Error("Research pack requires ReviewReport.reviewer_assurance.");
  }

  const gateSha256 = createHash("sha256").update(input.gateBytes).digest("hex");
  const assuranceGateSha256 = (assurance as { gate_report_sha256?: unknown }).gate_report_sha256;
  if (typeof assuranceGateSha256 === "string") {
    if (assuranceGateSha256 !== gateSha256) {
      throw new Error(
        "ReviewReport reviewer_assurance.gate_report_sha256 does not match the supplied GateReport bytes."
      );
    }
  } else if (assurance.tier === "A2_model_conservative") {
    throw new Error("A2 pack requires ReviewReport reviewer_assurance.gate_report_sha256.");
  } else {
    return undefined;
  }

  if (assurance.tier === "A0_deterministic") {
    const rebuiltReview = buildReviewReportArtifact(
      input.gate,
      { gateReportSha256: gateSha256 },
      new Date(input.review.generated_at)
    );
    if (JSON.stringify(rebuiltReview) !== JSON.stringify(input.review)) {
      throw new Error("A0 ReviewReport does not exactly match its deterministic GateReport reconstruction.");
    }
    return undefined;
  }

  const absolutePath = path.join(input.sourceDir, MODEL_REVIEW_BUNDLE_SIDECAR);
  const stat = await fs.lstat(absolutePath).catch(() => null);
  if (!stat) {
    throw new Error(
      `A2 pack requires ${MODEL_REVIEW_BUNDLE_SIDECAR} directly under --source-dir.`
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `A2 pack requires --source-dir/${MODEL_REVIEW_BUNDLE_SIDECAR} to be a regular, non-symbolic-link file.`
    );
  }

  const bytes = await fs.readFile(absolutePath);
  if (containsNonPortableResearchText(bytes.toString("utf8"))) {
    throw new Error("A2 ModelReviewBundle sidecar contains non-portable or sensitive text.");
  }
  const bundleSha256 = createHash("sha256").update(bytes).digest("hex");
  if (bundleSha256 !== assurance.model_review_bundle_sha256) {
    throw new Error(
      "A2 ModelReviewBundle sidecar SHA-256 does not match ReviewReport reviewer_assurance."
    );
  }
  const bundle = parseModelReviewBundle(
    parseJsonArtifact(bytes, "ModelReviewBundle"),
    { artifact_id: input.gate.artifact_id, sha256: gateSha256 }
  );
  const rebuiltReview = buildReviewReportArtifact(input.gate, {
    modelReviewBundle: bundle,
    modelReviewBundleSha256: bundleSha256,
    gateReportSha256: gateSha256
  }, new Date(input.review.generated_at));
  if (JSON.stringify(rebuiltReview) !== JSON.stringify(input.review)) {
    throw new Error("A2 ReviewReport does not exactly match its bound gate and ModelReviewBundle reconstruction.");
  }
  return { absolutePath, bytes, bundle };
}

function resolveOutputDir(cwd: string, outDir: string | undefined, intent: string): string {
  return resolveWithinCwd(cwd, outDir || path.join(DEFAULT_OUTPUT_ROOT, intent));
}

function resolveWithinCwd(cwd: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

function portableInputLabel(cwd: string, absolutePath: string, fallback: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : fallback;
}

function operationResult<T>(cwd: string, outputPath: string, artifact: T, related: string[]): ResearchOperationResult<T> {
  return {
    artifact,
    output_path: portableInputLabel(cwd, outputPath, `<output>/${path.basename(outputPath)}`),
    related_paths: related.map((entry) => portableInputLabel(cwd, entry, `<external-artifact-root>/${path.basename(entry)}`))
  };
}

async function readTypedArtifact<T>(cwd: string, artifactPath: string, expectedType: string): Promise<T> {
  return (await readTypedArtifactFile<T>(cwd, artifactPath, expectedType)).artifact;
}

async function readTypedArtifactFile<T>(
  cwd: string,
  artifactPath: string,
  expectedType: string
): Promise<{ artifact: T; bytes: Buffer; absolutePath: string }> {
  const absolutePath = resolveWithinCwd(cwd, artifactPath);
  const bytes = await fs.readFile(absolutePath);
  const payload = parseJsonArtifact(bytes, expectedType);
  const validation = validateResearchGovernanceArtifact(payload);
  if (!validation.ok) {
    throw new Error(`Invalid ${expectedType}: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
  if (!payload || typeof payload !== "object" || (payload as { artifact_type?: unknown }).artifact_type !== expectedType) {
    throw new Error(`Expected ${expectedType} artifact.`);
  }
  return { artifact: payload as T, bytes, absolutePath };
}

function parseJsonArtifact(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`Invalid ${label}: artifact must contain valid JSON.`);
  }
}

function assertValidArtifact(artifact: unknown): void {
  const validation = validateResearchGovernanceArtifact(artifact);
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
  }
}

interface PackCandidate {
  source: string;
  relative: string;
  redactIdentifiers: boolean;
  frozenBytes?: Buffer;
  expectedSha256?: string;
  expectedBytes?: number;
}

function uniqueCandidateFiles(candidates: PackCandidate[]): PackCandidate[] {
  const seenSources = new Set<string>();
  const seenDestinations = new Set<string>();
  return candidates.filter((candidate) => {
    const sourceKey = path.resolve(candidate.source);
    const destinationKey = candidate.relative.replace(/\\/gu, "/");
    if (seenSources.has(sourceKey) || seenDestinations.has(destinationKey)) return false;
    seenSources.add(sourceKey);
    seenDestinations.add(destinationKey);
    return true;
  });
}

function redactRunSpecificIdentifiers(
  raw: Buffer,
  relativePath: string
): { content: Buffer; redacted: boolean } {
  const text = raw.toString("utf8");
  let sanitized = text;
  if (relativePath.toLowerCase().endsWith(".json")) {
    try {
      sanitized = `${JSON.stringify(redactJsonValue(JSON.parse(text)), null, 2)}\n`;
    } catch {
      sanitized = redactFreeText(text);
    }
  } else {
    sanitized = redactFreeText(text);
  }
  return {
    content: Buffer.from(sanitized, "utf8"),
    redacted: sanitized !== text
  };
}

function redactJsonValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key && RUN_IDENTIFIER_FIELD_PATTERN.test(key)) {
      return identifierPlaceholder(key);
    }
    return redactFreeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
      entryKey,
      redactJsonValue(entryValue, entryKey)
    ])
  );
}

function identifierPlaceholder(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized.startsWith("run")) return "<run-id>";
  if (normalized.startsWith("model")) return "<model-id>";
  if (normalized.startsWith("condition")) return "<condition-id>";
  if (/^(?:event|trace|span|request|thread)/u.test(normalized)) return "<trace-id>";
  return "<task-id>";
}

function redactFreeText(value: string): string {
  return value
    .replace(RUN_UUID_PATTERN, "<run-id>")
    .replace(TRACE_IDENTIFIER_PATTERN, "<trace-id>")
    .replace(CONDITION_IDENTIFIER_PATTERN, "<condition-id>")
    .replace(PARAMETER_VALUE_PATTERN, "<parameter-value>")
    .replace(MODEL_IDENTIFIER_PATTERN, "<model-id>")
    .replace(UPPER_HYPHEN_ENTITY_PATTERN, "<task-id>")
    .replace(CAMEL_CASE_ENTITY_PATTERN, (token) => (
      PUBLIC_CONTRACT_TOKENS.has(token) ? token : "<task-id>"
    ));
}
