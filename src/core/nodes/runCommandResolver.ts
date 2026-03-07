import path from "node:path";
import { promises as fs } from "node:fs";

import { RunRecord } from "../../types.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import { fileExists } from "../../utils/fs.js";

export interface ResolvedRunCommand {
  command: string;
  cwd: string;
  source: string;
  metricsPath: string;
  testCommand?: string;
  testCwd?: string;
}

export async function resolveRunCommand(
  run: RunRecord,
  workspaceRoot = process.cwd()
): Promise<ResolvedRunCommand> {
  const runDir = path.join(workspaceRoot, ".autoresearch", "runs", run.id);
  const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
  const metricsPath =
    resolveMaybeRelative(await runContext.get<string>("implement_experiments.metrics_path"), workspaceRoot) ||
    path.join(runDir, "metrics.json");
  const explicitCommand = await runContext.get<string>("implement_experiments.run_command");
  const explicitCwd =
    resolveMaybeRelative(await runContext.get<string>("implement_experiments.cwd"), workspaceRoot) || workspaceRoot;
  const testCommand = await runContext.get<string>("implement_experiments.test_command");

  if (explicitCommand) {
    return {
      command: explicitCommand,
      cwd: explicitCwd,
      source: "run_context.run_command",
      metricsPath,
      testCommand: testCommand || undefined,
      testCwd: explicitCwd
    };
  }

  const scriptPath = resolveMaybeRelative(await runContext.get<string>("implement_experiments.script"), workspaceRoot);
  if (scriptPath && (await fileExists(scriptPath))) {
    return {
      command: inferCommandForScript(scriptPath),
      cwd: workspaceRoot,
      source: "run_context.script",
      metricsPath,
      testCommand: testCommand || undefined,
      testCwd: workspaceRoot
    };
  }

  for (const relative of ["experiment.py", "experiment.js", "experiment.sh"]) {
    const candidate = path.join(runDir, relative);
    if (await fileExists(candidate)) {
      return {
        command: inferCommandForScript(candidate),
        cwd: workspaceRoot,
        source: `run_dir.${relative}`,
        metricsPath,
        testCommand: testCommand || undefined,
        testCwd: workspaceRoot
      };
    }
  }

  const packageJsonPath = path.join(runDir, "package.json");
  if (await fileExists(packageJsonPath)) {
    const packageJson = await readPackageJson(packageJsonPath);
    if (packageJson?.scripts?.experiment) {
      return {
        command: "npm run experiment",
        cwd: runDir,
        source: "run_dir.package_json#experiment",
        metricsPath,
        testCommand: packageJson.scripts.test ? "npm test -- --runInBand" : testCommand || undefined,
        testCwd: runDir
      };
    }
  }

  throw new Error(`No runnable experiment artifact found for run ${run.id}. Execute implement_experiments first.`);
}

function inferCommandForScript(scriptPath: string): string {
  const quoted = JSON.stringify(scriptPath);
  if (/\.py$/i.test(scriptPath)) {
    return `python3 ${quoted}`;
  }
  if (/\.(js|mjs|cjs)$/i.test(scriptPath)) {
    return `node ${quoted}`;
  }
  if (/\.sh$/i.test(scriptPath)) {
    return `bash ${quoted}`;
  }
  return quoted;
}

function resolveMaybeRelative(value: string | undefined, workspaceRoot: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.join(workspaceRoot, value);
}

async function readPackageJson(filePath: string): Promise<{ scripts?: Record<string, string> } | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as { scripts?: Record<string, string> };
  } catch {
    return undefined;
  }
}
