import path from "node:path";
import { promises as fs } from "node:fs";

import { ensureDir, fileExists, writeJsonFile } from "../../utils/fs.js";

export interface GovernanceDemoBundleExportInput {
  cwd: string;
  publicOutputRoots: string[];
  outDir?: string;
  maxBundles?: number;
}

export interface GovernanceDemoBundleEntry {
  source_ref: string;
  bundle_dir: string;
  run_id: string;
  title: string;
  copied_files: string[];
  required_artifacts: {
    brief: boolean;
    condition: boolean;
    run_config: boolean;
    events: boolean;
    scoring_output: boolean;
    unsupported_claim_notes: boolean;
    readme: boolean;
  };
  readiness: {
    workflow_completed: boolean;
    write_paper_completed: boolean;
    pdf_built: boolean;
    paper_ready: boolean;
    readiness_state?: string;
  };
  unsupported_claim_notes: string[];
}

export interface GovernanceDemoBundleManifest {
  version: 1;
  generated_at: string;
  output_dir: string;
  selected_count: number;
  entries: GovernanceDemoBundleEntry[];
  readiness_summary: {
    workflow_completed_count: number;
    write_paper_completed_count: number;
    pdf_built_count: number;
    paper_ready_count: number;
  };
}

interface PublicManifest {
  run_id?: string;
  title?: string;
  updated_at?: string;
  generated_files?: string[];
}

export async function exportGovernanceDemoBundles(
  input: GovernanceDemoBundleExportInput
): Promise<GovernanceDemoBundleManifest> {
  const cwd = path.resolve(input.cwd);
  const outputDir = path.resolve(cwd, input.outDir || path.join("outputs", "governance-benchmark", "demo-bundles"));
  const selectedRoots = input.publicOutputRoots.slice(0, input.maxBundles ?? input.publicOutputRoots.length);
  if (selectedRoots.length === 0) {
    throw new Error("At least one public output root is required for demo bundle export.");
  }

  await ensureDir(outputDir);
  const entries: GovernanceDemoBundleEntry[] = [];
  for (const publicOutputRoot of selectedRoots) {
    const sourceRoot = path.resolve(cwd, publicOutputRoot);
    const stat = await fs.stat(sourceRoot);
    if (!stat.isDirectory()) {
      throw new Error(`Public output root must be a directory: ${safePathRef(cwd, sourceRoot, "<external-public-output>")}`);
    }
    const publicManifest = await readPublicManifest(sourceRoot);
    const runId = publicManifest.run_id || path.basename(sourceRoot);
    const title = publicManifest.title || runId;
    const bundleSlug = sanitizeBundleSlug(`${title}-${runId.slice(0, 8)}`);
    const bundleDir = path.join(outputDir, "runs", bundleSlug);
    await fs.rm(bundleDir, { recursive: true, force: true });
    await copyDirectory(sourceRoot, bundleDir);

    const copiedFiles = await listFiles(bundleDir, bundleDir);
    const readiness = await inspectReadiness(bundleDir, publicManifest);
    const unsupportedClaimNotes = await collectUnsupportedClaimNotes(bundleDir);
    const requiredArtifacts = {
      brief: await anyFileExists(bundleDir, ["experiment/brief.md", "experiment/research_brief.md", "reproduce/brief.md", "brief.md"]),
      condition: await anyFileExists(bundleDir, ["governance_condition.json", "experiment/governance_condition.json", "reproduce/governance_condition.json"]),
      run_config: await anyFileExists(bundleDir, ["run_config.json", "reproduce/run_config.json", "config.yaml", "reproduce/config.yaml"]),
      events: await anyFileExists(bundleDir, ["events.jsonl", "reproduce/events.jsonl"]),
      scoring_output: await anyFileExists(bundleDir, ["governance_score.json", "results/governance_score.json", "review/minimum_gate.json"]),
      unsupported_claim_notes: unsupportedClaimNotes.length > 0 || await anyFileExists(bundleDir, ["paper/evidence_gate_decision.json", "paper/claim_status_table.json"]),
      readme: await anyFileExists(bundleDir, ["README.md"])
    };

    const entry: GovernanceDemoBundleEntry = {
      source_ref: safePathRef(cwd, sourceRoot, "<external-public-output>"),
      bundle_dir: normalizePath(path.relative(cwd, bundleDir)),
      run_id: runId,
      title,
      copied_files: copiedFiles,
      required_artifacts: requiredArtifacts,
      readiness,
      unsupported_claim_notes: unsupportedClaimNotes
    };
    await writeJsonFile(path.join(bundleDir, "demo_bundle_entry.json"), entry);
    entries.push(entry);
  }

  const manifest: GovernanceDemoBundleManifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    output_dir: normalizePath(path.relative(cwd, outputDir)),
    selected_count: entries.length,
    entries,
    readiness_summary: {
      workflow_completed_count: entries.filter((entry) => entry.readiness.workflow_completed).length,
      write_paper_completed_count: entries.filter((entry) => entry.readiness.write_paper_completed).length,
      pdf_built_count: entries.filter((entry) => entry.readiness.pdf_built).length,
      paper_ready_count: entries.filter((entry) => entry.readiness.paper_ready).length
    }
  };
  await writeJsonFile(path.join(outputDir, "bundle_manifest.json"), manifest);
  await fs.writeFile(path.join(outputDir, "README.md"), renderBundleReadme(manifest), "utf8");
  return manifest;
}

async function readPublicManifest(publicOutputRoot: string): Promise<PublicManifest> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(publicOutputRoot, "manifest.json"), "utf8")) as PublicManifest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function inspectReadiness(bundleDir: string, publicManifest: PublicManifest): Promise<GovernanceDemoBundleEntry["readiness"]> {
  const runRecord = await readOptionalJson<Record<string, unknown>>(path.join(bundleDir, "run_record.json"));
  const paperReadiness = await readOptionalJson<Record<string, unknown>>(path.join(bundleDir, "paper", "paper_readiness.json"));
  const workflowCompleted =
    runRecord?.status === "completed" ||
    publicManifest.generated_files?.some((filePath) => filePath.startsWith("paper/") || filePath.startsWith("review/")) === true ||
    await anyFileExists(bundleDir, ["review/decision.json", "paper/main.tex"]);
  const writePaperCompleted = await anyFileExists(bundleDir, ["paper/main.tex"]);
  const pdfBuilt = await anyFileExists(bundleDir, ["paper/main.pdf"]);
  const paperReady = paperReadiness?.paper_ready === true;
  const readinessState =
    typeof paperReadiness?.readiness_state === "string"
      ? paperReadiness.readiness_state
      : typeof paperReadiness?.manuscript_type === "string"
        ? paperReadiness.manuscript_type
        : undefined;
  return {
    workflow_completed: workflowCompleted,
    write_paper_completed: writePaperCompleted,
    pdf_built: pdfBuilt,
    paper_ready: paperReady,
    ...(readinessState ? { readiness_state: readinessState } : {})
  };
}

async function collectUnsupportedClaimNotes(bundleDir: string): Promise<string[]> {
  const notes = new Set<string>();
  const gateDecision = await readOptionalJson<Record<string, unknown>>(path.join(bundleDir, "paper", "evidence_gate_decision.json"));
  collectClaimNotesFromValue(gateDecision?.blocked_comparative_claims, notes);
  collectClaimNotesFromValue(gateDecision?.detected_unsupported_comparative_claims, notes);

  const claimStatus = await readOptionalJson<Record<string, unknown>>(path.join(bundleDir, "paper", "claim_status_table.json"));
  collectClaimNotesFromValue(claimStatus?.claims, notes, { onlyUnsupportedStatus: true });

  return [...notes].sort();
}

function collectClaimNotesFromValue(
  value: unknown,
  notes: Set<string>,
  options: { onlyUnsupportedStatus?: boolean } = {}
): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
    if (options.onlyUnsupportedStatus && !["blocked", "unverified", "unsupported"].includes(status)) {
      continue;
    }
    const text = firstString(record.reason, record.statement, record.claim, record.claim_id);
    if (text) {
      notes.add(text);
    }
  }
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await ensureDir(targetDir);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    await ensureDir(path.dirname(targetPath));
    await fs.copyFile(sourcePath, targetPath);
  }
}

async function listFiles(rootDir: string, baseDir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath, baseDir));
      continue;
    }
    if (entry.isFile()) {
      files.push(normalizePath(path.relative(baseDir, absolutePath)));
    }
  }
  return files.sort();
}

async function anyFileExists(rootDir: string, relativePaths: string[]): Promise<boolean> {
  for (const relativePath of relativePaths) {
    if (await fileExists(path.join(rootDir, relativePath))) {
      return true;
    }
  }
  return false;
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function renderBundleReadme(manifest: GovernanceDemoBundleManifest): string {
  const lines = [
    "# Governance Demo Bundles",
    "",
    `Generated: ${manifest.generated_at}`,
    `Selected bundles: ${manifest.selected_count}`,
    "",
    "## Readiness Summary",
    "",
    `- workflow completed: ${manifest.readiness_summary.workflow_completed_count}`,
    `- write_paper completed: ${manifest.readiness_summary.write_paper_completed_count}`,
    `- PDF built: ${manifest.readiness_summary.pdf_built_count}`,
    `- paper_ready=true: ${manifest.readiness_summary.paper_ready_count}`,
    "",
    "These states are intentionally separate. A completed workflow, a completed `write_paper` node, or a built PDF is not equivalent to `paper_ready=true`.",
    "",
    "## Bundles",
    ""
  ];
  for (const entry of manifest.entries) {
    lines.push(`### ${entry.title}`);
    lines.push(`- run id: \`${entry.run_id}\``);
    lines.push(`- bundle: \`${entry.bundle_dir}\``);
    lines.push(`- workflow completed: ${entry.readiness.workflow_completed}`);
    lines.push(`- write_paper completed: ${entry.readiness.write_paper_completed}`);
    lines.push(`- PDF built: ${entry.readiness.pdf_built}`);
    lines.push(`- paper_ready: ${entry.readiness.paper_ready}`);
    if (entry.readiness.readiness_state) {
      lines.push(`- readiness state: ${entry.readiness.readiness_state}`);
    }
    lines.push(`- unsupported claim notes: ${entry.unsupported_claim_notes.length}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function safePathRef(cwd: string, absolutePath: string, externalPlaceholder: string): string {
  const relative = path.relative(cwd, absolutePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return normalizePath(relative) || ".";
  }
  return `${externalPlaceholder}/${path.basename(absolutePath)}`;
}

function sanitizeBundleSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72) || "run";
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}
