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
  const runDir = path.join(workspaceRoot, ".autolabos", "runs", run.id);
  const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
  const publicDir =
    resolveMaybeRelative(await runContext.get<string>("implement_experiments.public_dir"), workspaceRoot) || undefined;
  const metricsPath =
    resolveMaybeRelative(await runContext.get<string>("implement_experiments.metrics_path"), workspaceRoot) ||
    path.join(runDir, "metrics.json");
  const explicitCommand = await runContext.get<string>("implement_experiments.run_command");
  const explicitCwd =
    resolveMaybeRelative(await runContext.get<string>("implement_experiments.cwd"), workspaceRoot) || workspaceRoot;
  const testCommand = await runContext.get<string>("implement_experiments.test_command");
  const explicitCommandArtifact = explicitCommand
    ? resolveCommandArtifactPath(explicitCommand, explicitCwd, workspaceRoot)
    : undefined;

  if (explicitCommand && (!explicitCommandArtifact || (await fileExists(explicitCommandArtifact)))) {
    const fullStudyAlternative = explicitCommandArtifact
      ? await resolveFullStudyAlternativeForPerConditionCommand({
          command: explicitCommand,
          commandArtifact: explicitCommandArtifact,
          explicitCwd,
          publicDir,
          runDir,
          workspaceRoot,
          metricsPath
        })
      : undefined;
    if (fullStudyAlternative) {
      return fullStudyAlternative;
    }
    return {
      command: explicitCommand,
      cwd: explicitCwd,
      source: "run_context.run_command",
      metricsPath,
      testCommand: testCommand || undefined,
      testCwd: explicitCwd
    };
  }

  const scriptPathCandidates = [
    resolveMaybeRelative(await runContext.get<string>("implement_experiments.script"), workspaceRoot),
    ...resolveMaybeRelativeArray(await runContext.get<string[]>("implement_experiments.public_artifacts"), workspaceRoot)
      .filter((filePath) => /\.(py|js|mjs|cjs|sh)$/iu.test(filePath))
  ].filter((value): value is string => Boolean(value));
  const scriptPath = await firstExistingPath(scriptPathCandidates);
  if (scriptPath) {
    return {
      command: inferCommandForScript(scriptPath),
      cwd: explicitCwd,
      source: "run_context.script",
      metricsPath,
      testCommand: testCommand || undefined,
      testCwd: explicitCwd
    };
  }

  for (const [dir, sourcePrefix, cwd] of [
    [publicDir, "public_dir", publicDir || workspaceRoot],
    [runDir, "run_dir", workspaceRoot]
  ] as const) {
    if (!dir) {
      continue;
    }
    for (const relative of [
      "experiment.py",
      "experiment.js",
      "experiment.sh",
      "run_experiment.py",
      "run_experiment.js",
      "run_experiment.sh"
    ]) {
      const candidate = path.join(dir, relative);
      if (await fileExists(candidate)) {
        return {
          command: inferCommandForScript(candidate),
          cwd,
          source: `${sourcePrefix}.${relative}`,
          metricsPath,
          testCommand: testCommand || undefined,
          testCwd: cwd
        };
      }
    }
  }

  for (const [dir, sourcePrefix] of [
    [publicDir, "public_dir"],
    [runDir, "run_dir"]
  ] as const) {
    if (!dir) {
      continue;
    }
    const packageJsonPath = path.join(dir, "package.json");
    if (await fileExists(packageJsonPath)) {
      const packageJson = await readPackageJson(packageJsonPath);
      if (packageJson?.scripts?.experiment) {
        return {
          command: "npm run experiment",
          cwd: dir,
          source: `${sourcePrefix}.package_json#experiment`,
          metricsPath,
          testCommand: packageJson.scripts.test ? "npm test -- --runInBand" : testCommand || undefined,
          testCwd: dir
        };
      }
    }
  }

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

function resolveMaybeRelativeArray(values: string[] | undefined, workspaceRoot: string): string[] {
  return (values || [])
    .map((value) => resolveMaybeRelative(value, workspaceRoot))
    .filter((value): value is string => Boolean(value));
}

async function firstExistingPath(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveCommandArtifactPath(
  command: string,
  cwd: string,
  workspaceRoot: string
): string | undefined {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const candidates = tokens
    .map((token) => token.replace(/^['"]|['"]$/g, ""))
    .filter(looksLikeScriptPath)
    .map((candidate) => ({
      resolved: path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate),
      score: scoreCommandArtifactCandidate(candidate)
    }))
    .filter(({ resolved }) => isPathInsideOrEqual(resolved, workspaceRoot))
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.resolved;
}

function looksLikeScriptPath(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.includes("/") ||
    /\.(py|js|mjs|cjs|sh)$/iu.test(value)
  );
}

function scoreCommandArtifactCandidate(value: string): number {
  const basename = path.basename(value).toLowerCase();
  let score = 0;
  if (/\.(py|js|mjs|cjs|sh)$/iu.test(value)) {
    score += 100;
  }
  if (value.startsWith("./") || value.startsWith("../")) {
    score += 20;
  }
  if (value.includes("/")) {
    score += 10;
  }
  if (isLikelyInterpreterBinary(basename)) {
    score -= 100;
  }
  return score;
}

function isLikelyInterpreterBinary(basename: string): boolean {
  return (
    /^(python|python\d+(\.\d+)?)$/u.test(basename) ||
    /^(node|bash|sh|zsh|ruby|perl)$/u.test(basename)
  );
}

function isPathInsideOrEqual(filePath: string, parentDir: string): boolean {
  const relative = path.relative(parentDir, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readPackageJson(filePath: string): Promise<{ scripts?: Record<string, string> } | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as { scripts?: Record<string, string> };
  } catch {
    return undefined;
  }
}

interface FullStudyAlternativeInput {
  command: string;
  commandArtifact: string;
  explicitCwd: string;
  publicDir?: string;
  runDir: string;
  workspaceRoot: string;
  metricsPath: string;
}

async function resolveFullStudyAlternativeForPerConditionCommand(
  input: FullStudyAlternativeInput
): Promise<ResolvedRunCommand | undefined> {
  const perConditionPythonArtifact = await resolvePerConditionPythonArtifact(input.commandArtifact);
  if (!perConditionPythonArtifact) {
    return undefined;
  }
  const source = await readTextIfAvailable(perConditionPythonArtifact);
  if (!source || !requiresPerConditionCliInputs(source) || commandSuppliesPerConditionInputs(input.command)) {
    return undefined;
  }

  const searchDirs = uniqueStrings([
    path.dirname(perConditionPythonArtifact),
    path.dirname(input.commandArtifact),
    input.publicDir,
    input.explicitCwd,
    input.runDir
  ]).filter((dir) => isPathInsideOrEqual(dir, input.workspaceRoot));
  const candidates: Array<{ filePath: string; score: number }> = [];
  for (const dir of searchDirs) {
    for (const filePath of await listPythonFiles(dir)) {
      if (path.resolve(filePath) === path.resolve(perConditionPythonArtifact)) {
        continue;
      }
      const candidateSource = await readTextIfAvailable(filePath);
      if (!candidateSource || requiresPerConditionCliInputs(candidateSource)) {
        continue;
      }
      const score = scoreFullStudyRunnerCandidate(filePath, candidateSource);
      if (score > 0) {
        candidates.push({ filePath, score });
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score || left.filePath.localeCompare(right.filePath));
  const selected = candidates[0];
  if (!selected) {
    return undefined;
  }
  return {
    command: appendMetricsPath(inferCommandForScript(selected.filePath), input.metricsPath),
    cwd: path.dirname(selected.filePath),
    source: "run_context.run_command.full_study_alternative",
    metricsPath: input.metricsPath,
    testCommand: undefined,
    testCwd: path.dirname(selected.filePath)
  };
}

async function resolvePerConditionPythonArtifact(commandArtifact: string): Promise<string | undefined> {
  if (/\.py$/iu.test(commandArtifact)) {
    return commandArtifact;
  }
  if (!/\.sh$/iu.test(commandArtifact)) {
    return undefined;
  }
  const shellSource = await readTextIfAvailable(commandArtifact);
  if (!shellSource) {
    return undefined;
  }
  const scriptDir = path.dirname(commandArtifact);
  const candidates = extractPythonRunnerCandidatesFromShell(shellSource, scriptDir);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function extractPythonRunnerCandidatesFromShell(source: string, scriptDir: string): string[] {
  const candidates: string[] = [];
  const assignmentPattern = /(?:^|\n)\s*[A-Za-z_][A-Za-z0-9_]*=(["'])([^"']*\.py)\1/gu;
  for (const match of source.matchAll(assignmentPattern)) {
    candidates.push(resolveShellPathToken(match[2] || "", scriptDir));
  }
  const tokenPattern = /(["']?)([^\s"']*\.py)\1/gu;
  for (const match of source.matchAll(tokenPattern)) {
    candidates.push(resolveShellPathToken(match[2] || "", scriptDir));
  }
  return uniqueStrings(candidates).filter((candidate) => path.isAbsolute(candidate));
}

function resolveShellPathToken(token: string, scriptDir: string): string {
  const normalized = token
    .replace(/\$\{SCRIPT_DIR\}/gu, scriptDir)
    .replace(/\$SCRIPT_DIR/gu, scriptDir)
    .replace(/\$\{PWD\}/gu, process.cwd())
    .replace(/\$PWD/gu, process.cwd());
  return path.isAbsolute(normalized) ? normalized : path.resolve(scriptDir, normalized);
}

function commandSuppliesPerConditionInputs(command: string): boolean {
  const tokens = tokenizeCommand(command);
  return hasFlag(tokens, "--condition-marker", "--condition") && hasFlag(tokens, "--seed");
}

function requiresPerConditionCliInputs(source: string): boolean {
  return requiresAnyFlag(source, ["--condition-marker", "--condition"]) && requiresAnyFlag(source, ["--seed"]);
}

function requiresAnyFlag(source: string, flags: string[]): boolean {
  return flags.some((flag) => {
    const escaped = escapeRegExp(flag);
    return new RegExp(
      "add_argument\\([\\s\\S]{0,500}['\"]" + escaped + "['\"][\\s\\S]{0,500}required\\s*=\\s*True",
      "u"
    ).test(source);
  });
}

function scoreFullStudyRunnerCandidate(filePath: string, source: string): number {
  const basename = path.basename(filePath).toLowerCase();
  let score = 0;
  if (/\b(study|sweep|matrix|suite|orchestrat|portfolio)\b/iu.test(basename)) {
    score += 100;
  }
  if (/run_.*(study|sweep|matrix|suite|orchestrat)/iu.test(basename)) {
    score += 40;
  }
  if (/(--condition-markers|condition_markers|planned_runs|run_study|study_output|study-output)/u.test(source)) {
    score += 40;
  }
  if (/--metrics-path|metrics_path/u.test(source)) {
    score += 20;
  }
  if (/if\s+__name__\s*==\s*['"]__main__['"]|def\s+main\s*\(/u.test(source)) {
    score += 10;
  }
  if (basename === "experiment.py" || basename === "run_experiment.py") {
    score -= 20;
  }
  return score;
}

function appendMetricsPath(command: string, metricsPath: string): string {
  const tokens = tokenizeCommand(command);
  if (hasFlag(tokens, "--metrics-path", "--metrics-out")) {
    return command;
  }
  return `${command} --metrics-path ${JSON.stringify(metricsPath)}`;
}

function tokenizeCommand(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, "")) || [];
}

function hasFlag(tokens: string[], ...flags: string[]): boolean {
  return tokens.some((token) => flags.some((flag) => token === flag || token.startsWith(`${flag}=`)));
}

async function listPythonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.py$/iu.test(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

async function readTextIfAvailable(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
