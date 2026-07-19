import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../utils/fs.js";

export const RESEARCH_VALIDATION_REPORT = "research-validation-report.json";
export const RESEARCH_VALIDATION_SUMMARY = "research-validation-report.md";

const PLACEHOLDER_PATTERN = /\$\{(?:CODEX_HOME|REPO_ROOT|VALIDATION_DIR)\}/gu;
const UNKNOWN_PLACEHOLDER_PATTERN = /\$\{[^}]+\}/gu;
const PLACEHOLDER_TOKEN_PATTERN = /^\$\{(?:CODEX_HOME|REPO_ROOT|VALIDATION_DIR)\}$/u;
const MAX_TIMEOUT_MS = 7_200_000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export interface ResearchValidationStepProfile {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  timeout_ms: number;
  expected_outputs: string[];
}

export interface ResearchValidationProfile {
  schema_version: "1.0";
  profile_id: string;
  required_step_ids: string[];
  steps: ResearchValidationStepProfile[];
  evidence_boundary: string;
}

export interface ResearchValidationCommandResult {
  exit_code: number;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface ResearchValidationCommandContext {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export type ResearchValidationCommandExecutor = (
  input: ResearchValidationCommandContext
) => Promise<ResearchValidationCommandResult>;

export interface ResearchValidationRepositoryState {
  available: boolean;
  head: string | null;
  clean: boolean;
  dirty_entry_count: number;
  status_sha256: string;
  status: Buffer;
}

export type ResearchValidationRepositoryInspector = (
  cwd: string
) => Promise<ResearchValidationRepositoryState>;

export interface ResearchValidationExpectedOutputResult {
  path: string;
  exists: boolean;
  regular_file: boolean;
  bytes: number;
  sha256: string | null;
}

export interface ResearchValidationStepResult {
  id: string;
  passed: boolean;
  command: string;
  args: string[];
  cwd: string;
  timeout_ms: number;
  exit_code: number;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: {
    path: string;
    bytes: number;
    sha256: string;
  };
  stderr: {
    path: string;
    bytes: number;
    sha256: string;
  };
  expected_outputs: ResearchValidationExpectedOutputResult[];
}

export interface ResearchValidationReport {
  schema_version: "1.0";
  validation_id: string;
  generated_at: string;
  profile: {
    id: string;
    ref: string;
    sha256: string;
    required_step_ids: string[];
  };
  passed: boolean;
  status: "pass" | "fail";
  summary: {
    required_step_count: number;
    passed_step_count: number;
    failed_step_count: number;
  };
  repository: {
    before: Omit<ResearchValidationRepositoryState, "status"> & { status_path: string };
    after: Omit<ResearchValidationRepositoryState, "status"> & { status_path: string };
    stable_head: boolean;
    clean_before_and_after: boolean;
  };
  steps: ResearchValidationStepResult[];
  evidence_boundary: string;
}

export interface RunResearchValidationInput {
  cwd: string;
  profilePath: string;
  outDir: string;
}

export interface RunResearchValidationDeps {
  executeCommand?: ResearchValidationCommandExecutor;
  inspectRepository?: ResearchValidationRepositoryInspector;
  now?: () => Date;
  onStep?: (step: ResearchValidationStepResult) => void;
}

export interface RunResearchValidationResult {
  report: ResearchValidationReport;
  report_path: string;
  summary_path: string;
}

export async function runResearchValidation(
  input: RunResearchValidationInput,
  deps: RunResearchValidationDeps = {}
): Promise<RunResearchValidationResult> {
  const cwd = path.resolve(input.cwd);
  const profilePath = await resolveContainedRegularFile(
    cwd,
    path.resolve(cwd, input.profilePath),
    "Research validation profile"
  );
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Research validation output");
  await assertNoSymlinkedExistingAncestor(cwd, outDir);
  await assertFreshOutput(outDir);

  const profileBytes = await fs.readFile(profilePath);
  const profile = parseProfile(parseJson(profileBytes));
  const profileSha256 = sha256(profileBytes);
  const now = deps.now || (() => new Date());
  const executeCommand = deps.executeCommand || executeValidationCommand;
  const inspectRepository = deps.inspectRepository || inspectGitRepository;
  const generatedAt = now().toISOString();
  const stagingRoot = path.join(
    path.dirname(outDir),
    `.${path.basename(outDir)}.staging-${randomUUID()}`
  );
  await fs.mkdir(path.join(stagingRoot, "steps"), { recursive: true });

  try {
    const before = await inspectRepository(cwd);
    await fs.writeFile(path.join(stagingRoot, "repository-status.before.txt"), before.status);
    const stepResults: ResearchValidationStepResult[] = [];
    for (const step of profile.steps) {
      const result = await executeStep({
        cwd,
        stagingRoot,
        step,
        executeCommand
      });
      stepResults.push(result);
      deps.onStep?.(result);
    }
    const after = await inspectRepository(cwd);
    await fs.writeFile(path.join(stagingRoot, "repository-status.after.txt"), after.status);

    const stableHead = before.available
      && after.available
      && before.head !== null
      && before.head === after.head;
    const cleanBeforeAndAfter = before.available
      && after.available
      && before.clean
      && after.clean;
    const passedStepCount = stepResults.filter((step) => step.passed).length;
    const passed = stableHead
      && cleanBeforeAndAfter
      && passedStepCount === profile.required_step_ids.length;
    const validationId = `research-validation-${sha256(Buffer.from([
      profileSha256,
      before.head || "missing-head",
      generatedAt
    ].join("\n"))).slice(0, 16)}`;
    const report: ResearchValidationReport = {
      schema_version: "1.0",
      validation_id: validationId,
      generated_at: generatedAt,
      profile: {
        id: profile.profile_id,
        ref: portableRef(cwd, profilePath),
        sha256: profileSha256,
        required_step_ids: profile.required_step_ids
      },
      passed,
      status: passed ? "pass" : "fail",
      summary: {
        required_step_count: profile.required_step_ids.length,
        passed_step_count: passedStepCount,
        failed_step_count: profile.required_step_ids.length - passedStepCount
      },
      repository: {
        before: repositorySummary(stagingRoot, "repository-status.before.txt", before),
        after: repositorySummary(stagingRoot, "repository-status.after.txt", after),
        stable_head: stableHead,
        clean_before_and_after: cleanBeforeAndAfter
      },
      steps: stepResults,
      evidence_boundary: `${profile.evidence_boundary} This report records command execution, expected-output bytes, and repository state. It does not establish scientific validity, human identity, reviewer independence, provider identity, or paper readiness beyond the declared validation steps.`
    };
    await writeJsonFile(path.join(stagingRoot, RESEARCH_VALIDATION_REPORT), report);
    await fs.writeFile(
      path.join(stagingRoot, RESEARCH_VALIDATION_SUMMARY),
      renderSummary(report),
      "utf8"
    );
    await fs.rename(stagingRoot, outDir);
    return {
      report,
      report_path: portableRef(cwd, path.join(outDir, RESEARCH_VALIDATION_REPORT)),
      summary_path: portableRef(cwd, path.join(outDir, RESEARCH_VALIDATION_SUMMARY))
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function executeStep(input: {
  cwd: string;
  stagingRoot: string;
  step: ResearchValidationStepProfile;
  executeCommand: ResearchValidationCommandExecutor;
}): Promise<ResearchValidationStepResult> {
  const stepCwd = await resolveContainedDirectory(
    input.cwd,
    path.resolve(input.cwd, input.step.cwd),
    `Research validation step cwd (${input.step.id})`
  );
  const values = {
    CODEX_HOME: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    REPO_ROOT: input.cwd,
    VALIDATION_DIR: input.stagingRoot
  };
  const command = expandPlaceholders(input.step.command, values);
  const args = input.step.args.map((arg) => expandPlaceholders(arg, values));
  for (const relative of input.step.expected_outputs) {
    const target = path.resolve(input.stagingRoot, relative);
    if (!isInside(input.stagingRoot, target)) {
      throw new Error(`Research validation expected output escaped validation root: ${relative}.`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
  }
  const execution = await input.executeCommand({
    command,
    args,
    cwd: stepCwd,
    timeoutMs: input.step.timeout_ms
  });
  const stdoutPath = path.join(input.stagingRoot, "steps", `${input.step.id}.stdout.log`);
  const stderrPath = path.join(input.stagingRoot, "steps", `${input.step.id}.stderr.log`);
  await fs.writeFile(stdoutPath, execution.stdout);
  await fs.writeFile(stderrPath, execution.stderr);
  const expectedOutputs = await Promise.all(input.step.expected_outputs.map((relative) =>
    inspectExpectedOutput(input.stagingRoot, relative)
  ));
  const passed = execution.exit_code === 0
    && !execution.timed_out
    && expectedOutputs.every((item) => item.exists && item.regular_file && item.bytes > 0);
  return {
    id: input.step.id,
    passed,
    command: input.step.command,
    args: input.step.args,
    cwd: input.step.cwd,
    timeout_ms: input.step.timeout_ms,
    exit_code: execution.exit_code,
    signal: execution.signal,
    timed_out: execution.timed_out,
    duration_ms: execution.duration_ms,
    stdout: {
      path: portableRef(input.stagingRoot, stdoutPath),
      bytes: execution.stdout.byteLength,
      sha256: sha256(execution.stdout)
    },
    stderr: {
      path: portableRef(input.stagingRoot, stderrPath),
      bytes: execution.stderr.byteLength,
      sha256: sha256(execution.stderr)
    },
    expected_outputs: expectedOutputs
  };
}

async function inspectExpectedOutput(
  stagingRoot: string,
  relative: string
): Promise<ResearchValidationExpectedOutputResult> {
  const candidate = path.resolve(stagingRoot, relative);
  if (!isInside(stagingRoot, candidate)) {
    return { path: relative, exists: false, regular_file: false, bytes: 0, sha256: null };
  }
  try {
    await assertNoSymlinkTraversal(stagingRoot, candidate);
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { path: relative, exists: true, regular_file: false, bytes: stat.size, sha256: null };
    }
    const bytes = await fs.readFile(candidate);
    return {
      path: relative,
      exists: true,
      regular_file: true,
      bytes: bytes.byteLength,
      sha256: sha256(bytes)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: relative, exists: false, regular_file: false, bytes: 0, sha256: null };
    }
    throw error;
  }
}

export async function executeValidationCommand(
  input: ResearchValidationCommandContext
): Promise<ResearchValidationCommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      encoding: "buffer",
      timeout: input.timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const commandError = error as (NodeJS.ErrnoException & {
        killed?: boolean;
        signal?: NodeJS.Signals | null;
      }) | null;
      resolve({
        exit_code: commandError
          ? typeof commandError.code === "number" ? commandError.code : 127
          : 0,
        signal: commandError?.signal || null,
        timed_out: Boolean(commandError?.killed || commandError?.code === "ETIMEDOUT"),
        duration_ms: Date.now() - started,
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ""),
        stderr: Buffer.isBuffer(stderr)
          ? stderr
          : Buffer.from(stderr || commandError?.message || "")
      });
    });
  });
}

export async function inspectGitRepository(
  cwd: string
): Promise<ResearchValidationRepositoryState> {
  try {
    const head = (await execFileText("git", ["rev-parse", "HEAD"], cwd)).trim();
    const status = Buffer.from(await execFileText(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd
    ), "utf8");
    const dirtyEntryCount = status.toString("utf8").split(/\r?\n/u).filter(Boolean).length;
    return {
      available: validGitObjectId(head),
      head: validGitObjectId(head) ? head : null,
      clean: dirtyEntryCount === 0,
      dirty_entry_count: dirtyEntryCount,
      status_sha256: sha256(status),
      status
    };
  } catch (error) {
    const status = Buffer.from(error instanceof Error ? error.message : String(error), "utf8");
    return {
      available: false,
      head: null,
      clean: false,
      dirty_entry_count: 0,
      status_sha256: sha256(status),
      status
    };
  }
}

function parseProfile(value: unknown): ResearchValidationProfile {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "schema_version", "profile_id", "required_step_ids", "steps", "evidence_boundary"
      ])
      || value.schema_version !== "1.0"
      || !validId(value.profile_id)
      || !Array.isArray(value.required_step_ids)
      || !Array.isArray(value.steps)
      || value.steps.length === 0
      || typeof value.evidence_boundary !== "string"
      || value.evidence_boundary.trim().length < 20) {
    throw new Error("Research validation profile is invalid.");
  }
  const requiredStepIds = value.required_step_ids.map((item) => {
    if (!validId(item)) throw new Error("Research validation required step id is invalid.");
    return item;
  });
  const steps = value.steps.map(parseProfileStep);
  const stepIds = steps.map((step) => step.id);
  if (new Set(requiredStepIds).size !== requiredStepIds.length
      || new Set(stepIds).size !== stepIds.length
      || !sameValues(requiredStepIds, stepIds)) {
    throw new Error("Research validation profile must execute every required step exactly once.");
  }
  return {
    schema_version: "1.0",
    profile_id: value.profile_id,
    required_step_ids: requiredStepIds,
    steps,
    evidence_boundary: value.evidence_boundary
  };
}

function parseProfileStep(value: unknown): ResearchValidationStepProfile {
  if (!isRecord(value)
      || !hasExactKeys(value, [
        "id", "command", "args", "cwd", "timeout_ms", "expected_outputs"
      ])
      || !validId(value.id)
      || typeof value.command !== "string"
      || !validCommand(value.command)
      || !Array.isArray(value.args)
      || !value.args.every((arg) => typeof arg === "string" && validTemplateText(arg))
      || typeof value.cwd !== "string"
      || !validPortableRelativePath(value.cwd, true)
      || typeof value.timeout_ms !== "number"
      || !Number.isInteger(value.timeout_ms)
      || value.timeout_ms < 1_000
      || value.timeout_ms > MAX_TIMEOUT_MS
      || !Array.isArray(value.expected_outputs)
      || !value.expected_outputs.every((item) =>
        typeof item === "string" && validPortableRelativePath(item, false)
      )
      || new Set(value.expected_outputs).size !== value.expected_outputs.length) {
    throw new Error("Research validation step is invalid.");
  }
  return {
    id: value.id,
    command: value.command,
    args: value.args,
    cwd: value.cwd,
    timeout_ms: value.timeout_ms,
    expected_outputs: value.expected_outputs
  };
}

function validCommand(value: string): boolean {
  if (!validTemplateText(value) || /\s/u.test(value)) return false;
  if (/^[A-Za-z0-9._+-]+$/u.test(value)) return true;
  return /^\$\{(?:CODEX_HOME|REPO_ROOT)\}\/[A-Za-z0-9._+/-]+$/u.test(value)
    && !value.includes("../");
}

function validTemplateText(value: string): boolean {
  if (value.includes("\0") || /(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(value)) return false;
  const unknown = value.match(UNKNOWN_PLACEHOLDER_PATTERN) || [];
  return unknown.every((item) => PLACEHOLDER_TOKEN_PATTERN.test(item));
}

function validPortableRelativePath(value: string, allowDot: boolean): boolean {
  if (!value || path.isAbsolute(value) || value.includes("\0") || value.match(UNKNOWN_PLACEHOLDER_PATTERN)) {
    return false;
  }
  const normalized = path.posix.normalize(value.replace(/\\/gu, "/"));
  if (normalized === ".") return allowDot;
  return normalized !== ".." && !normalized.startsWith("../") && normalized === value.replace(/\\/gu, "/");
}

function expandPlaceholders(
  value: string,
  replacements: Record<"CODEX_HOME" | "REPO_ROOT" | "VALIDATION_DIR", string>
): string {
  return value.replace(PLACEHOLDER_PATTERN, (match) => {
    const key = match.slice(2, -1) as keyof typeof replacements;
    return replacements[key];
  });
}

function repositorySummary(
  stagingRoot: string,
  statusName: string,
  state: ResearchValidationRepositoryState
): Omit<ResearchValidationRepositoryState, "status"> & { status_path: string } {
  return {
    available: state.available,
    head: state.head,
    clean: state.clean,
    dirty_entry_count: state.dirty_entry_count,
    status_sha256: state.status_sha256,
    status_path: portableRef(stagingRoot, path.join(stagingRoot, statusName))
  };
}

function renderSummary(report: ResearchValidationReport): string {
  const lines = [
    "# Research Validation Report",
    "",
    `- Validation: \`${report.validation_id}\``,
    `- Profile: \`${report.profile.id}\``,
    `- Status: \`${report.status}\``,
    `- Steps passed: ${report.summary.passed_step_count}/${report.summary.required_step_count}`,
    `- Worktree clean before and after: ${report.repository.clean_before_and_after}`,
    `- Stable Git HEAD: ${report.repository.stable_head}`,
    "",
    "## Steps",
    ""
  ];
  for (const step of report.steps) {
    lines.push(
      `- \`${step.id}\`: ${step.passed ? "pass" : "fail"} `
      + `(exit=${step.exit_code}, timeout=${step.timed_out}, ${step.duration_ms} ms)`
    );
  }
  lines.push("", "## Evidence Boundary", "", report.evidence_boundary, "");
  return lines.join("\n");
}

async function execFileText(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, encoding: "utf8", timeout: 30_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function resolveContainedRegularFile(root: string, candidate: string, label: string): Promise<string> {
  if (!isInside(root, candidate)) throw new Error(`${label} must stay inside the repository root.`);
  await assertNoSymlinkTraversal(root, candidate);
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
  return candidate;
}

async function resolveContainedDirectory(root: string, candidate: string, label: string): Promise<string> {
  if (candidate !== root && !isInside(root, candidate)) {
    throw new Error(`${label} must stay inside the repository root.`);
  }
  await assertNoSymlinkTraversal(root, candidate);
  const stat = await fs.lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a directory.`);
  return candidate;
}

async function assertFreshOutput(target: string): Promise<void> {
  try {
    await fs.lstat(target);
    throw new Error("Research validation output already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertNoSymlinkedExistingAncestor(root: string, target: string): Promise<void> {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error("Research validation output may not traverse symbolic links.");
  }
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error("Research validation output may not traverse symbolic links.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertNoSymlinkTraversal(root: string, target: string): Promise<void> {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error("symbolic link");
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("symbolic link");
  }
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  if (!isInside(root, candidate)) throw new Error(`${label} must be strictly inside the repository root.`);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function portableRef(root: string, target: string): string {
  return path.relative(root, target).replace(/\\/gu, "/");
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("Research validation profile is not valid JSON.");
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameValues(left: string[], right: string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function validGitObjectId(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
