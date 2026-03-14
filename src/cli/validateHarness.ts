import path from "node:path";
import { Dirent, promises as fs } from "node:fs";

import { RunRecord } from "../types.js";
import {
  HarnessValidationIssue,
  validateLiveValidationIssueFile,
  validateRunArtifactStructure
} from "../core/validation/harnessValidators.js";

interface RunsFileLike {
  runs?: RunRecord[];
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const issuesPath = path.join(cwd, "ISSUES.md");
  const runStoreRoot = path.join(cwd, "test");
  const findings: HarnessValidationIssue[] = [];

  const issueLogResult = await validateLiveValidationIssueFile(issuesPath);
  findings.push(...issueLogResult.issues);

  const runStoreFiles = await findRunStoreFiles(runStoreRoot);
  let runCount = 0;
  for (const runStoreFile of runStoreFiles) {
    const parsed = await readRunsFile(runStoreFile, findings);
    for (const run of parsed.runs || []) {
      if (!run.id) {
        findings.push({
          code: "run_record_missing_id",
          message: `A run entry in ${runStoreFile} is missing id.`,
          filePath: runStoreFile
        });
        continue;
      }
      runCount += 1;
      const runDir = path.join(path.dirname(runStoreFile), run.id);
      const exists = await fileExists(runDir);
      if (!exists) {
        findings.push({
          code: "run_directory_missing",
          message: `Run directory is missing for ${run.id}.`,
          filePath: runDir,
          runId: run.id
        });
        continue;
      }
      const result = await validateRunArtifactStructure({
        runId: run.id,
        runDir,
        nodeStates: run.graph?.nodeStates
      });
      findings.push(...result.issues);
    }
  }

  process.stdout.write(`[validate:harness] issue entries checked: ${issueLogResult.issueCount}\n`);
  process.stdout.write(`[validate:harness] run stores checked: ${runStoreFiles.length}\n`);
  process.stdout.write(`[validate:harness] runs checked: ${runCount}\n`);

  if (findings.length === 0) {
    process.stdout.write("[validate:harness] OK: no structural violations found.\n");
    return;
  }

  process.stderr.write(`[validate:harness] FAIL: ${findings.length} structural issue(s) found.\n`);
  for (const finding of findings) {
    const location = finding.filePath ? ` (${path.relative(cwd, finding.filePath)})` : "";
    const run = finding.runId ? ` [run:${finding.runId}]` : "";
    process.stderr.write(`- ${finding.code}${run}: ${finding.message}${location}\n`);
  }
  process.exitCode = 1;
}

async function readRunsFile(
  filePath: string,
  findings: HarnessValidationIssue[]
): Promise<RunsFileLike> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      findings.push({
        code: "runs_json_malformed",
        message: "runs.json must decode to an object.",
        filePath
      });
      return {};
    }
    const record = parsed as RunsFileLike;
    if (record.runs && !Array.isArray(record.runs)) {
      findings.push({
        code: "runs_json_runs_malformed",
        message: "runs.json field `runs` must be an array when present.",
        filePath
      });
      return {};
    }
    return record;
  } catch (error) {
    findings.push({
      code: "runs_json_parse_error",
      message: `Unable to parse runs.json: ${errorMessage(error)}`,
      filePath
    });
    return {};
  }
}

async function findRunStoreFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files);
  return files.sort();
}

async function walk(currentPath: string, files: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const nextPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await walk(nextPath, files);
      continue;
    }
    if (entry.isFile() && entry.name === "runs.json" && path.basename(path.dirname(nextPath)) === "runs") {
      files.push(nextPath);
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  process.stderr.write(`[validate:harness] fatal error: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
