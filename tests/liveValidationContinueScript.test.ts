import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { shouldPreserveValidationRootEntry } from "./globalTeardown.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperScripts = [
  "live-validation-preflight.mjs",
  "live-validation-doctor-pty-smoke.py",
  "live-validation-start-run.py",
  "live-validation-resume-check.py",
  "live-validation-approve-and-run-next.py",
] as const;

const validationCommands = {
  "validation:preflight": "node scripts/live-validation-preflight.mjs",
  "validation:doctor": "python3 scripts/live-validation-doctor-pty-smoke.py",
  "validation:start-live": "python3 scripts/live-validation-start-run.py",
  "validation:resume-check": "python3 scripts/live-validation-resume-check.py",
  "validation:continue": "python3 scripts/live-validation-approve-and-run-next.py",
} as const;

describe("live-validation continue helper", () => {
  it("exposes the domain-neutral package and helper contract", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };

    for (const [name, command] of Object.entries(validationCommands)) {
      expect(packageJson.scripts[name]).toBe(command);
    }

    expect(Object.keys(packageJson.scripts).filter((name) => /^p\d+:/iu.test(name))).toEqual([]);

    for (const scriptName of helperScripts) {
      await expect(access(path.join(repoRoot, "scripts", scriptName))).resolves.toBeUndefined();
    }
    const scriptNames = await readdir(path.join(repoRoot, "scripts"));
    expect(scriptNames.filter((name) => /^p\d+-/iu.test(name))).toEqual([]);

    const helperSource = (await Promise.all(
      helperScripts.map((scriptName) => readFile(path.join(repoRoot, "scripts", scriptName), "utf8"))
    )).join("\n");
    expect(helperSource).not.toMatch(/AUTOLABOS_P\d+_/iu);
    expect(helperSource).toContain('"stage": "validation_helper_timeout"');
    expect(helperSource).toContain('"reason": "validation_model_usage_limit"');
  });

  it("includes every published validation helper in npm pack output", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8")
    ) as { scripts: Record<string, string> };
    const result = await execFileAsync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 }
    );
    const packed = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
    const packedPaths = new Set(packed[0]?.files.map((file) => file.path) || []);

    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (!name.startsWith("validation:")) {
        continue;
      }
      const scriptPath = command.match(/\b(scripts\/[^\s]+)/)?.[1];
      expect(scriptPath, name).toBeDefined();
      expect(packedPaths.has(scriptPath as string), name).toBe(true);
    }
  });

  it("requires an explicit brief source and refuses to replace an existing target", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autolabos-preflight-contract-"));
    const workspace = path.join(tempRoot, "workspace");
    const outDir = path.join(tempRoot, "out");
    const script = path.join(repoRoot, "scripts", "live-validation-preflight.mjs");
    const briefRelativePath = path.join("briefs", "governed.md");
    const target = path.join(workspace, briefRelativePath);
    const source = path.join(tempRoot, "source.md");

    try {
      let missingSourceError = "";
      try {
        await execFileAsync("node", [script], {
          env: {
            ...process.env,
            AUTOLABOS_VALIDATION_WORKSPACE: workspace,
            AUTOLABOS_VALIDATION_PREFLIGHT_OUT: outDir,
            AUTOLABOS_VALIDATION_BRIEF: briefRelativePath,
            AUTOLABOS_VALIDATION_BRIEF_SOURCE: "",
            AUTOLABOS_VALIDATION_PREFLIGHT_PROFILE: "generic",
          },
        });
      } catch (error) {
        missingSourceError = String((error as { stderr?: string }).stderr || error);
      }
      expect(missingSourceError).toContain("AUTOLABOS_VALIDATION_BRIEF_SOURCE");

      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "existing governed brief\n", "utf8");
      await writeFile(source, "different governed brief\n", "utf8");

      let overwriteError = "";
      try {
        await execFileAsync("node", [script], {
          env: {
            ...process.env,
            AUTOLABOS_VALIDATION_WORKSPACE: workspace,
            AUTOLABOS_VALIDATION_PREFLIGHT_OUT: outDir,
            AUTOLABOS_VALIDATION_BRIEF: briefRelativePath,
            AUTOLABOS_VALIDATION_BRIEF_SOURCE: source,
            AUTOLABOS_VALIDATION_PREFLIGHT_PROFILE: "generic",
          },
        });
      } catch (error) {
        overwriteError = String((error as { stderr?: string }).stderr || error);
      }
      expect(overwriteError).toContain("Refusing to overwrite existing governed brief target");
      expect(await readFile(target, "utf8")).toBe("existing governed brief\n");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps ML, CUDA, and ACL checks behind the explicit extended profile", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autolabos-preflight-profile-"));
    const workspace = path.join(tempRoot, "workspace");
    const outDir = path.join(tempRoot, "out");
    const briefRelativePath = path.join("briefs", "governed.md");
    const target = path.join(workspace, briefRelativePath);
    const script = path.join(repoRoot, "scripts", "live-validation-preflight.mjs");

    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(
        target,
        await readFile(path.join(repoRoot, "docs", "research-brief-template.md"), "utf8"),
        "utf8"
      );
      try {
        await execFileAsync("node", [script], {
          env: {
            ...process.env,
            AUTOLABOS_VALIDATION_WORKSPACE: workspace,
            AUTOLABOS_VALIDATION_PREFLIGHT_OUT: outDir,
            AUTOLABOS_VALIDATION_BRIEF: briefRelativePath,
            AUTOLABOS_VALIDATION_BRIEF_SOURCE: "",
            AUTOLABOS_VALIDATION_PREFLIGHT_PROFILE: "generic",
          },
        });
      } catch {
        // The template is intentionally not a runnable brief; the profile summary is still emitted.
      }

      const summary = JSON.parse(
        await readFile(path.join(outDir, "preflight-summary.json"), "utf8")
      ) as {
        preflightProfile: string;
        briefPreparationMode: string;
        pythonReport: { skipped?: boolean };
        checks: Array<{ id: string }>;
      };
      const checkIds = summary.checks.map((check) => check.id);
      expect(summary.preflightProfile).toBe("generic");
      expect(summary.briefPreparationMode).toBe("existing_target_validated");
      expect(summary.pythonReport.skipped).toBe(true);
      expect(checkIds).not.toContain("required_python_modules");
      expect(checkIds).not.toContain("cuda_visible");
      expect(checkIds).not.toContain("acl_template_available");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats active target-node progress as a resumeable TUI command path", async () => {
    const script = path.join(repoRoot, "scripts", "live-validation-approve-and-run-next.py");
    const result = await execFileAsync("python3", [script], {
      env: {
        ...process.env,
        AUTOLABOS_VALIDATION_CONTINUE_SELFTEST: "1",
      },
    });

    expect(result.stdout).toContain("PASS: live-validation continue command selection self-test");
  });


  it("writes a staged_llm resume manifest for helper timeouts", async () => {
    const script = path.join(repoRoot, "scripts", "live-validation-approve-and-run-next.py");
    const result = await execFileAsync("python3", [script], {
      env: {
        ...process.env,
        AUTOLABOS_VALIDATION_RESUME_MANIFEST_SELFTEST: "1",
      },
    });

    expect(result.stdout).toContain("PASS: live-validation staged_llm resume manifest self-test");
  });


  it("matches current doctor check rows across live-validation helper scripts", async () => {
    for (const scriptName of ["live-validation-resume-check.py", "live-validation-doctor-pty-smoke.py", "live-validation-start-run.py"]) {
      const script = path.join(repoRoot, "scripts", scriptName);
      const result = await execFileAsync("python3", [script], {
        env: {
          ...process.env,
          AUTOLABOS_VALIDATION_DOCTOR_PATTERN_SELFTEST: "1",
        },
      });

      expect(result.stdout).toContain("PASS: live-validation doctor output pattern self-test");
    }
  });

  it("fails doctor validation immediately when the workspace has not been prepared", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autolabos-doctor-unprepared-"));
    const workspace = path.join(tempRoot, "workspace");
    const script = path.join(repoRoot, "scripts", "live-validation-doctor-pty-smoke.py");

    try {
      await mkdir(workspace, { recursive: true });
      let failure = "";
      try {
        await execFileAsync("python3", [script], {
          env: {
            ...process.env,
            AUTOLABOS_VALIDATION_WORKSPACE: workspace,
          },
        });
      } catch (error) {
        failure = String((error as { stdout?: string }).stdout || error);
      }

      expect(failure).toContain("validation workspace is not prepared");
      expect(failure).toContain("AUTOLABOS_VALIDATION_BRIEF_SOURCE");
      expect(failure).not.toContain("pattern not found");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves the live-validation workspace during test cleanup", () => {
    expect(shouldPreserveValidationRootEntry("live-validation")).toBe(true);
  });
});
