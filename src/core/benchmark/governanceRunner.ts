import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "yaml";

import { writeJsonFile } from "../../utils/fs.js";
import { type GovernanceBenchmarkConditionName, resolveGovernanceBenchmarkCondition } from "./governanceCondition.js";
import { runGovernanceBenchmarkDryRun, type GovernanceBenchmarkDryRunReport } from "./governanceDryRun.js";

export interface GovernanceBenchmarkBatchInput {
  cwd: string;
  seedsRoot: string;
  outDir?: string;
  taskIds?: string[];
  conditions?: GovernanceBenchmarkConditionName[];
}

export interface GovernanceBenchmarkTaskBatchReport {
  task_id: string;
  title?: string;
  seed_ref: string;
  status: "replayed" | "queued" | "failed";
  conditions: GovernanceBenchmarkConditionName[];
  intended_failure: string[];
  expected_gate: string[];
  seed_materials: string[];
  replay_supported: boolean;
  replay_summary_path?: string;
  queue_manifest_path?: string;
  error?: string;
}

export interface GovernanceBenchmarkBatchReport {
  generated_at: string;
  seeds_root_ref: string;
  output_dir: string;
  summary_path: string;
  readme_path: string;
  passed: boolean;
  total_tasks: number;
  replayed_tasks: number;
  queued_tasks: number;
  failed_tasks: number;
  coverage: {
    expected_task_ids: string[];
    discovered_task_ids: string[];
    missing_task_ids: string[];
  };
  tasks: GovernanceBenchmarkTaskBatchReport[];
}

interface SeedConditionFile {
  task_id?: string;
  title?: string;
  intended_failure?: string[];
  expected_gate?: string[];
  seed_materials?: string[];
  conditions?: string[];
}

interface ResolvedSeedTask {
  taskId: string;
  sourceDir: string;
  condition: SeedConditionFile;
}

const DEFAULT_BATCH_CONDITIONS: GovernanceBenchmarkConditionName[] = ["gated", "ungated"];
const EXPECTED_GOVERNANCE_TASK_IDS = Array.from({ length: 10 }, (_, index) =>
  `AGB-${String(index + 1).padStart(3, "0")}`
);

export async function runGovernanceBenchmarkBatch(
  input: GovernanceBenchmarkBatchInput
): Promise<GovernanceBenchmarkBatchReport> {
  const cwd = path.resolve(input.cwd);
  const seedsRoot = path.resolve(cwd, input.seedsRoot);
  const outputDir = path.resolve(cwd, input.outDir || path.join("outputs", "governance-benchmark", "batch"));
  const relativeOutDir = path.relative(cwd, outputDir).replace(/\\/g, "/");
  await fs.mkdir(outputDir, { recursive: true });

  const requestedTaskIds = normalizeTaskIds(input.taskIds);
  const seedTasks = await discoverSeedTasks(cwd, seedsRoot, requestedTaskIds);
  const tasks: GovernanceBenchmarkTaskBatchReport[] = [];

  for (const seedTask of seedTasks) {
    const taskOutputDir = path.join(outputDir, seedTask.taskId);
    const conditions = selectConditions(seedTask.condition, input.conditions);
    const seedRef = safeSeedRef(cwd, seedsRoot, seedTask.sourceDir);
    const baseReport = {
      task_id: seedTask.taskId,
      title: seedTask.condition.title,
      seed_ref: seedRef,
      conditions,
      intended_failure: asStringList(seedTask.condition.intended_failure),
      expected_gate: asStringList(seedTask.condition.expected_gate),
      seed_materials: asStringList(seedTask.condition.seed_materials),
      replay_supported: await supportsFixedArtifactReplay(seedTask.sourceDir)
    };

    if (!baseReport.replay_supported) {
      const queueManifestPath = path.join(taskOutputDir, "queue_manifest.json");
      await writeJsonFile(queueManifestPath, {
        task_id: seedTask.taskId,
        title: seedTask.condition.title,
        seed_ref: seedRef,
        queued_at: new Date().toISOString(),
        conditions,
        intended_failure: baseReport.intended_failure,
        expected_gate: baseReport.expected_gate,
        seed_materials: baseReport.seed_materials,
        replay_status: "queued",
        reason: "No fixed result_table.csv replay artifact is present; queue this seed for live/bespoke benchmark execution."
      });
      tasks.push({
        ...baseReport,
        status: "queued",
        queue_manifest_path: path.relative(cwd, queueManifestPath).replace(/\\/g, "/")
      });
      continue;
    }

    try {
      const replay = await runGovernanceBenchmarkDryRun({
        cwd,
        seedPath: seedTask.sourceDir,
        taskId: seedTask.taskId,
        outDir: taskOutputDir,
        conditions
      });
      tasks.push({
        ...baseReport,
        status: "replayed",
        replay_summary_path: replay.summary_path
      });
    } catch (error) {
      const queueManifestPath = path.join(taskOutputDir, "queue_manifest.json");
      await writeJsonFile(queueManifestPath, {
        task_id: seedTask.taskId,
        title: seedTask.condition.title,
        seed_ref: seedRef,
        queued_at: new Date().toISOString(),
        conditions,
        intended_failure: baseReport.intended_failure,
        expected_gate: baseReport.expected_gate,
        seed_materials: baseReport.seed_materials,
        replay_status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
      tasks.push({
        ...baseReport,
        status: "failed",
        queue_manifest_path: path.relative(cwd, queueManifestPath).replace(/\\/g, "/"),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const discoveredTaskIds = tasks.map((task) => task.task_id).sort();
  const expectedTaskIds = requestedTaskIds.length ? requestedTaskIds : EXPECTED_GOVERNANCE_TASK_IDS;
  const missingTaskIds = expectedTaskIds.filter((taskId) => !discoveredTaskIds.includes(taskId));
  const summaryPath = path.join(outputDir, "summary.json");
  const readmePath = path.join(outputDir, "README.md");
  const failedTasks = tasks.filter((task) => task.status === "failed").length;
  const summary: GovernanceBenchmarkBatchReport = {
    generated_at: new Date().toISOString(),
    seeds_root_ref: safeRootRef(cwd, seedsRoot),
    output_dir: relativeOutDir,
    summary_path: path.relative(cwd, summaryPath).replace(/\\/g, "/"),
    readme_path: path.relative(cwd, readmePath).replace(/\\/g, "/"),
    passed: missingTaskIds.length === 0 && failedTasks === 0 && tasks.length > 0,
    total_tasks: tasks.length,
    replayed_tasks: tasks.filter((task) => task.status === "replayed").length,
    queued_tasks: tasks.filter((task) => task.status === "queued").length,
    failed_tasks: failedTasks,
    coverage: {
      expected_task_ids: expectedTaskIds,
      discovered_task_ids: discoveredTaskIds,
      missing_task_ids: missingTaskIds
    },
    tasks
  };
  await writeJsonFile(summaryPath, summary);
  await fs.writeFile(readmePath, renderBatchReadme(summary), "utf8");
  return summary;
}

async function discoverSeedTasks(cwd: string, seedsRoot: string, taskIds: string[]): Promise<ResolvedSeedTask[]> {
  const stat = await fs.stat(seedsRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Governance benchmark seeds root must be a directory: ${safeRootRef(cwd, seedsRoot)}`);
  }

  const single = await resolveSeedTask(cwd, seedsRoot);
  const tasks = single ? [single] : await discoverChildSeedTasks(cwd, seedsRoot);
  const taskIdSet = new Set(taskIds);
  return tasks
    .filter((task) => taskIdSet.size === 0 || taskIdSet.has(task.taskId))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

async function discoverChildSeedTasks(cwd: string, seedsRoot: string): Promise<ResolvedSeedTask[]> {
  const entries = await fs.readdir(seedsRoot, { withFileTypes: true });
  const tasks: ResolvedSeedTask[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const resolved = await resolveSeedTask(cwd, path.join(seedsRoot, entry.name));
    if (resolved) {
      tasks.push(resolved);
    }
  }
  return tasks;
}

async function resolveSeedTask(cwd: string, seedDir: string): Promise<ResolvedSeedTask | undefined> {
  const sourceDir = await resolveSeedSourceDir(seedDir);
  if (!sourceDir) {
    return undefined;
  }
  const condition = await readConditionFile(sourceDir);
  const taskId = sanitizeTaskId(condition.task_id || path.basename(seedDir));
  if (!taskId) {
    throw new Error(`Governance benchmark seed has no task id: ${safeRootRef(cwd, seedDir)}`);
  }
  return { taskId, sourceDir, condition };
}

async function resolveSeedSourceDir(seedDir: string): Promise<string | undefined> {
  const importedSource = path.join(seedDir, "source");
  if (await fileExists(path.join(importedSource, "condition.yaml"))) {
    return importedSource;
  }
  if (await fileExists(path.join(seedDir, "condition.yaml"))) {
    return seedDir;
  }
  return undefined;
}

async function readConditionFile(sourceDir: string): Promise<SeedConditionFile> {
  const raw = await fs.readFile(path.join(sourceDir, "condition.yaml"), "utf8");
  const parsed = YAML.parse(raw);
  return parsed && typeof parsed === "object" ? parsed as SeedConditionFile : {};
}

async function supportsFixedArtifactReplay(sourceDir: string): Promise<boolean> {
  return fileExists(path.join(sourceDir, "seed_materials", "result_table.csv"));
}

function selectConditions(
  condition: SeedConditionFile,
  requested: GovernanceBenchmarkConditionName[] | undefined
): GovernanceBenchmarkConditionName[] {
  const source = requested?.length ? requested : DEFAULT_BATCH_CONDITIONS;
  const declared = new Set(asStringList(condition.conditions));
  const selected = source.filter((name) => {
    try {
      resolveGovernanceBenchmarkCondition(name);
      return declared.size === 0 || declared.has(name);
    } catch {
      return false;
    }
  });
  return selected.length ? selected : DEFAULT_BATCH_CONDITIONS;
}

function normalizeTaskIds(taskIds: string[] | undefined): string[] {
  return [...new Set((taskIds || []).map((taskId) => sanitizeTaskId(taskId)).filter(Boolean))].sort();
}

function sanitizeTaskId(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "");
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function safeRootRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.replace(/\\/g, "/") || ".";
  }
  return "<external-seed-root>";
}

function safeSeedRef(cwd: string, seedsRoot: string, sourceDir: string): string {
  const relativeRoot = safeRootRef(cwd, seedsRoot);
  const relativeToRoot = path.relative(seedsRoot, sourceDir).replace(/\\/g, "/");
  if (relativeRoot === "<external-seed-root>") {
    const parts = relativeToRoot.split("/");
    return ["<external-seed-root>", ...parts].join("/");
  }
  return path.join(relativeRoot, relativeToRoot).replace(/\\/g, "/");
}

function renderBatchReadme(summary: GovernanceBenchmarkBatchReport): string {
  const lines = [
    "# Governance Benchmark Batch",
    "",
    `Generated: ${summary.generated_at}`,
    `Result: ${summary.passed ? "passed" : "failed"}`,
    `Seeds: ${summary.seeds_root_ref}`,
    "",
    "## Coverage",
    "",
    `- expected tasks: ${summary.coverage.expected_task_ids.length}`,
    `- discovered tasks: ${summary.coverage.discovered_task_ids.length}`,
    `- missing tasks: ${summary.coverage.missing_task_ids.length ? summary.coverage.missing_task_ids.join(", ") : "none"}`,
    `- replayed tasks: ${summary.replayed_tasks}`,
    `- queued tasks: ${summary.queued_tasks}`,
    `- failed tasks: ${summary.failed_tasks}`,
    "",
    "## Tasks",
    ""
  ];
  for (const task of summary.tasks) {
    lines.push(
      `- ${task.task_id}: ${task.status}, conditions=${task.conditions.join("/")}, replay_supported=${task.replay_supported}, title=${task.title || "(untitled)"}`
    );
  }
  lines.push(
    "",
    "Queued tasks have a run-ready manifest but no generic fixed result-table replay artifact. Use a live or task-specific replay flow for those seeds.",
    ""
  );
  return `${lines.join("\n")}\n`;
}
