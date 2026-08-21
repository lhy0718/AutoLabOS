import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeValidationCommand,
  runResearchValidation,
  verifyResearchValidationReport,
  type ResearchValidationCommandContext,
  type ResearchValidationCommandResult,
  type ResearchValidationRepositoryState
} from "../src/core/researchValidationRun.js";
import { verifyResearchMilestone } from "../src/core/researchMilestoneAudit.js";

describe("research validation run", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-research-validation-"));
    await fs.mkdir(path.join(workspace, "paper"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("binds passing commands, expected outputs, and a stable clean repository", async () => {
    await writeProfile(workspace, {
      required_step_ids: ["build", "paper_build"],
      steps: [
        step("build"),
        step("paper_build", {
          args: ["--emit=${VALIDATION_DIR}/artifacts/manuscript.pdf"],
          cwd: "paper",
          expected_outputs: ["artifacts/manuscript.pdf"]
        })
      ]
    });
    const contexts: ResearchValidationCommandContext[] = [];
    const result = await runResearchValidation({
      cwd: workspace,
      profilePath: "validation-profile.json",
      outDir: "outputs/validation-v1"
    }, {
      executeCommand: async (input) => {
        contexts.push(input);
        const emit = input.args.find((arg) => arg.startsWith("--emit="))?.slice(7);
        if (emit) {
          await fs.mkdir(path.dirname(emit), { recursive: true });
          await fs.writeFile(emit, Buffer.from("portable-pdf-fixture"));
        }
        return commandResult(0, `passed ${input.command}`);
      },
      inspectRepository: cleanRepositoryInspector(),
      now: () => new Date("2026-01-02T03:04:05.000Z")
    });

    expect(result.report).toMatchObject({
      passed: true,
      status: "pass",
      summary: {
        required_step_count: 2,
        passed_step_count: 2,
        failed_step_count: 0
      },
      repository: {
        stable_head: true,
        clean_before_and_after: true
      }
    });
    expect(result.report.steps[1].expected_outputs[0]).toMatchObject({
      path: "artifacts/manuscript.pdf",
      exists: true,
      regular_file: true,
      bytes: 20,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(contexts[1].args[0]).toContain(path.join("outputs", ".validation-v1.staging-"));
    expect(result.report.steps[1].args[0]).toBe(
      "--emit=${VALIDATION_DIR}/artifacts/manuscript.pdf"
    );
    await expect(fs.stat(path.join(workspace, result.report_path))).resolves.toMatchObject({
      size: expect.any(Number)
    });
  });

  it("records a failed command without promoting partial success", async () => {
    await writeProfile(workspace, {
      required_step_ids: ["build", "full_tests"],
      steps: [step("build"), step("full_tests")]
    });
    const result = await runResearchValidation({
      cwd: workspace,
      profilePath: "validation-profile.json",
      outDir: "outputs/validation-failed"
    }, {
      executeCommand: async (input) => input.args.includes("full_tests")
        ? commandResult(2, "", "tests failed")
        : commandResult(0, "build passed"),
      inspectRepository: cleanRepositoryInspector()
    });

    expect(result.report).toMatchObject({
      passed: false,
      status: "fail",
      summary: { passed_step_count: 1, failed_step_count: 1 }
    });
    expect(result.report.steps.find((item) => item.id === "full_tests")).toMatchObject({
      passed: false,
      exit_code: 2,
      stderr: { bytes: 12 }
    });
  });

  it("fails when a declared output is missing or the worktree changes", async () => {
    await writeProfile(workspace, {
      required_step_ids: ["paper_build"],
      steps: [step("paper_build", { expected_outputs: ["paper/manuscript.pdf"] })]
    });
    const states = [repositoryState(true), repositoryState(false, " M tracked-file.ts\n")];
    const result = await runResearchValidation({
      cwd: workspace,
      profilePath: "validation-profile.json",
      outDir: "outputs/validation-dirty"
    }, {
      executeCommand: async () => commandResult(0, "command passed"),
      inspectRepository: async () => states.shift() || repositoryState(false)
    });

    expect(result.report).toMatchObject({
      passed: false,
      status: "fail",
      repository: {
        stable_head: true,
        clean_before_and_after: false,
        after: { dirty_entry_count: 1 }
      }
    });
    expect(result.report.steps[0]).toMatchObject({
      passed: false,
      expected_outputs: [{ exists: false, regular_file: false, bytes: 0, sha256: null }]
    });
  });

  it("rejects incomplete profiles and unknown placeholders before executing", async () => {
    await writeProfile(workspace, {
      required_step_ids: ["build", "full_tests"],
      steps: [step("build")]
    });
    await expect(runResearchValidation({
      cwd: workspace,
      profilePath: "validation-profile.json",
      outDir: "outputs/incomplete-profile"
    })).rejects.toThrow("every required step exactly once");

    await writeProfile(workspace, {
      required_step_ids: ["build"],
      steps: [step("build", { args: ["${PRIVATE_ROOT}/command"] })]
    });
    await expect(runResearchValidation({
      cwd: workspace,
      profilePath: "validation-profile.json",
      outDir: "outputs/unknown-placeholder"
    })).rejects.toThrow("step is invalid");
  });

  it("executes a real subprocess when execFile reports no error", async () => {
    const result = await executeValidationCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('real-command-ok')"],
      cwd: workspace,
      timeoutMs: 5_000
    });

    expect(result).toMatchObject({
      exit_code: 0,
      signal: null,
      timed_out: false,
      stdout: Buffer.from("real-command-ok"),
      stderr: Buffer.alloc(0)
    });
  });

  it("marks a killed subprocess as timed out", async () => {
    const result = await executeValidationCommand({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 2000)"],
      cwd: workspace,
      timeoutMs: 50
    });

    expect(result).toMatchObject({
      exit_code: 127,
      timed_out: true
    });
  });

  it("re-verifies a self-bound report and rejects log tampering", async () => {
    await writeProfile(workspace, {
      required_step_ids: ["build"],
      steps: [step("build")]
    });
    await fs.writeFile(path.join(workspace, ".gitignore"), "outputs/\n", "utf8");
    await fs.writeFile(path.join(workspace, "milestone.json"), `${JSON.stringify({
      schema_version: "1.0",
      milestone_id: "final-validation",
      target_state: "validated",
      evidence_root: ".",
      requirements: [{
        id: "final_validation",
        label: "Final validation is self-bound",
        target_node: "review",
        required: true,
        evidence: [{
          path: "outputs/final-validation/research-validation-report.json",
          sha256: null,
          verifier: "research_validation_report",
          assertions: [{ pointer: "/passed", operator: "equals", expected: true }]
        }]
      }]
    }, null, 2)}\n`, "utf8");

    await runGit(workspace, ["init"]);
    await runGit(workspace, [
      "add", ".gitignore", "validation-profile.json", "milestone.json"
    ]);
    await runGit(workspace, [
      "-c", "user.name=Validation Fixture",
      "-c", "user.email=validation-fixture@example.invalid",
      "commit", "-m", "fixture"
    ]);

    const run = await runResearchValidation({
      cwd: workspace,
      profilePath: "validation-profile.json",
      outDir: "outputs/final-validation"
    }, {
      executeCommand: async () => commandResult(0, "verified-command"),
      now: () => new Date("2026-01-02T03:04:05.000Z")
    });
    const verified = await verifyResearchValidationReport({
      cwd: workspace,
      reportPath: run.report_path
    });

    expect(verified).toMatchObject({
      passed: true,
      issues: [],
      profile_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      repository_head: expect.stringMatching(/^[a-f0-9]{40}$/u)
    });

    const milestone = await verifyResearchMilestone({
      cwd: workspace,
      contractPath: "milestone.json",
      outDir: "outputs/milestone-audit"
    });
    expect(milestone.report).toMatchObject({
      achieved: true,
      verdict: "achieved",
      summary: { passed_requirement_count: 1, failed_requirement_count: 0 }
    });
    expect(milestone.report.requirements[0]?.evidence[0]?.verifier).toBe(
      "research_validation_report"
    );

    await fs.appendFile(
      path.join(workspace, "outputs", "final-validation", "steps", "build.stdout.log"),
      "-tampered",
      "utf8"
    );
    const tampered = await verifyResearchValidationReport({
      cwd: workspace,
      reportPath: run.report_path
    });
    expect(tampered.passed).toBe(false);
    expect(tampered.issues).toContain("step_stdout:build_hash_mismatch");
  });
});

function step(
  id: string,
  overrides: Partial<{
    command: string;
    args: string[];
    cwd: string;
    timeout_ms: number;
    expected_outputs: string[];
  }> = {}
): Record<string, unknown> {
  return {
    id,
    command: overrides.command || "node",
    args: overrides.args || [id],
    cwd: overrides.cwd || ".",
    timeout_ms: overrides.timeout_ms || 10_000,
    expected_outputs: overrides.expected_outputs || []
  };
}

async function writeProfile(
  root: string,
  input: { required_step_ids: string[]; steps: Array<Record<string, unknown>> }
): Promise<void> {
  await fs.writeFile(path.join(root, "validation-profile.json"), `${JSON.stringify({
    schema_version: "1.0",
    profile_id: "portable-paper-validation",
    required_step_ids: input.required_step_ids,
    steps: input.steps,
    evidence_boundary: "This profile validates declared repository commands and outputs only."
  }, null, 2)}\n`, "utf8");
}

function cleanRepositoryInspector(): () => Promise<ResearchValidationRepositoryState> {
  return async () => repositoryState(true);
}

function repositoryState(clean: boolean, statusText = ""): ResearchValidationRepositoryState {
  const status = Buffer.from(statusText, "utf8");
  return {
    available: true,
    head: "a".repeat(40),
    clean,
    dirty_entry_count: statusText.split(/\r?\n/u).filter(Boolean).length,
    status_sha256: "b".repeat(64),
    status
  };
}

async function runGit(root: string, args: string[]): Promise<void> {
  const result = await executeValidationCommand({
    command: "git",
    args,
    cwd: root,
    timeoutMs: 10_000
  });
  if (result.exit_code !== 0) {
    throw new Error(result.stderr.toString("utf8") || `git ${args.join(" ")} failed`);
  }
}

function commandResult(
  exitCode: number,
  stdout = "",
  stderr = ""
): ResearchValidationCommandResult {
  return {
    exit_code: exitCode,
    signal: null,
    timed_out: false,
    duration_ms: 12,
    stdout: Buffer.from(stdout, "utf8"),
    stderr: Buffer.from(stderr, "utf8")
  };
}
