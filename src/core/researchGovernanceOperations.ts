import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { runPaperReadinessAudit, type PaperReadinessAuditInput } from "./audit/paperReadinessAudit.js";
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
  type MetaHarnessPatchPlanArtifact,
  type PaperReadinessBundleArtifact,
  type ResearchBriefArtifact,
  type ReviewReportArtifact
} from "./researchGovernanceArtifacts.js";
import { ensureDir, fileExists, writeJsonFile } from "../utils/fs.js";

export interface ResearchOperationResult<T> {
  artifact: T;
  output_path: string;
  related_paths: string[];
}

const DEFAULT_OUTPUT_ROOT = path.join("outputs", "research-governance");
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

const PRIVATE_PATH_PATTERN = new RegExp(
  `(?:^|[\\s\"'=:])(?:${[
    String.fromCharCode(47, 104, 111, 109, 101, 47),
    String.fromCharCode(47, 85, 115, 101, 114, 115, 47),
    String.fromCharCode(47, 109, 110, 116, 47),
    String.fromCharCode(47, 116, 109, 112, 47),
    "[A-Za-z]:\\\\"
  ].join("|")})`,
  "u"
);
const SENSITIVE_TEXT_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key|credential|secret)\s*[=:]/iu;
const RUN_UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const CONDITION_IDENTIFIER_PATTERN = /\b(?:condition|rank|dropout)[_-]\d[a-z0-9._-]*\b/giu;
const PARAMETER_VALUE_PATTERN = /\b(?:rank|dropout)\s+\d+(?:\.\d+)?\b/giu;
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
const RUN_IDENTIFIER_FIELD_PATTERN = /^(?:run|task|model|benchmark|condition)(?:_id|_name)?$/iu;

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
  const evidenceBundle = buildEvidenceBundleArtifact(summary);
  const gateReport = buildGateReportArtifact({ summary, evidenceBundle });
  assertValidArtifact(evidenceBundle);
  assertValidArtifact(gateReport);
  const evidencePath = path.join(outDir, "evidence-bundle.json");
  const gatePath = path.join(outDir, "gate-report.json");
  await writeJsonFile(evidencePath, evidenceBundle);
  await writeJsonFile(gatePath, gateReport);
  return operationResult(input.cwd, gatePath, gateReport, [evidencePath, path.join(outDir, "audit-summary.json")]);
}

export async function runResearchReview(input: {
  cwd: string;
  gatePath: string;
  outDir?: string;
}): Promise<ResearchOperationResult<ReviewReportArtifact>> {
  const gate = await readTypedArtifact<GateReportArtifact>(input.cwd, input.gatePath, "GateReport");
  const review = buildReviewReportArtifact(gate);
  assertValidArtifact(review);
  const outDir = resolveOutputDir(input.cwd, input.outDir, "review");
  const outputPath = path.join(outDir, "review-report.json");
  await writeJsonFile(outputPath, review);
  return operationResult(input.cwd, outputPath, review, [resolveWithinCwd(input.cwd, input.gatePath)]);
}

export async function runResearchImprove(input: {
  cwd: string;
  reviewPath: string;
  outDir?: string;
}): Promise<ResearchOperationResult<MetaHarnessPatchPlanArtifact>> {
  const review = await readTypedArtifact<ReviewReportArtifact>(input.cwd, input.reviewPath, "ReviewReport");
  const patchPlan = buildMetaHarnessPatchPlanArtifact(review);
  assertValidArtifact(patchPlan);
  const outDir = resolveOutputDir(input.cwd, input.outDir, "improve");
  const outputPath = path.join(outDir, "meta-harness-patch-plan.json");
  await writeJsonFile(outputPath, patchPlan);
  return operationResult(input.cwd, outputPath, patchPlan, [resolveWithinCwd(input.cwd, input.reviewPath)]);
}

export async function runResearchPack(input: {
  cwd: string;
  gatePath: string;
  reviewPath: string;
  sourceDir?: string;
  outDir?: string;
}): Promise<ResearchOperationResult<PaperReadinessBundleArtifact>> {
  const gate = await readTypedArtifact<GateReportArtifact>(input.cwd, input.gatePath, "GateReport");
  const review = await readTypedArtifact<ReviewReportArtifact>(input.cwd, input.reviewPath, "ReviewReport");
  if (review.gate_report_id !== gate.artifact_id) {
    throw new Error("ReviewReport does not reference the supplied GateReport.");
  }

  const outDir = resolveOutputDir(input.cwd, input.outDir, "pack");
  const sourceDir = input.sourceDir
    ? resolveWithinCwd(input.cwd, input.sourceDir)
    : path.dirname(resolveWithinCwd(input.cwd, input.gatePath));
  if (input.sourceDir) {
    const supplementalFiles = PACK_ALLOWLIST.filter((relative) =>
      relative !== "gate-report.json" && relative !== "review-report.json");
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
    { source: resolveWithinCwd(input.cwd, input.gatePath), relative: "gate-report.json", redactIdentifiers: false },
    { source: resolveWithinCwd(input.cwd, input.reviewPath), relative: "review-report.json", redactIdentifiers: false },
    ...PACK_ALLOWLIST.map((relative) => ({
      source: path.join(sourceDir, relative),
      relative,
      redactIdentifiers: true
    }))
  ]);

  for (const candidate of candidates) {
    if (!(await fileExists(candidate.source))) continue;
    const raw = await fs.readFile(candidate.source);
    const text = raw.toString("utf8");
    if (PRIVATE_PATH_PATTERN.test(text) || SENSITIVE_TEXT_PATTERN.test(text)) {
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
  const absolutePath = resolveWithinCwd(cwd, artifactPath);
  const payload = JSON.parse(await fs.readFile(absolutePath, "utf8")) as unknown;
  const validation = validateResearchGovernanceArtifact(payload);
  if (!validation.ok) {
    throw new Error(`Invalid ${expectedType}: ${validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
  if (!payload || typeof payload !== "object" || (payload as { artifact_type?: unknown }).artifact_type !== expectedType) {
    throw new Error(`Expected ${expectedType} artifact.`);
  }
  return payload as T;
}

function assertValidArtifact(artifact: unknown): void {
  const validation = validateResearchGovernanceArtifact(artifact);
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
  }
}

function uniqueCandidateFiles(
  candidates: Array<{ source: string; relative: string; redactIdentifiers: boolean }>
): Array<{ source: string; relative: string; redactIdentifiers: boolean }> {
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
  return "<task-id>";
}

function redactFreeText(value: string): string {
  return value
    .replace(RUN_UUID_PATTERN, "<run-id>")
    .replace(CONDITION_IDENTIFIER_PATTERN, "<condition-id>")
    .replace(PARAMETER_VALUE_PATTERN, "<parameter-value>")
    .replace(MODEL_IDENTIFIER_PATTERN, "<model-id>")
    .replace(UPPER_HYPHEN_ENTITY_PATTERN, "<task-id>")
    .replace(CAMEL_CASE_ENTITY_PATTERN, (token) => (
      PUBLIC_CONTRACT_TOKENS.has(token) ? token : "<task-id>"
    ));
}
