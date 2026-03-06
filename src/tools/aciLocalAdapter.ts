import path from "node:path";
import { exec } from "node:child_process";
import { promises as fs } from "node:fs";

import { AgentComputerInterface, AciAction, AciObservation } from "./aci.js";
import { ensureDir } from "../utils/fs.js";

export class LocalAciAdapter implements AgentComputerInterface {
  async perform(action: AciAction): Promise<AciObservation> {
    switch (action.type) {
      case "read_file":
        return this.readFile(String(action.input.path || ""));
      case "write_file":
        return this.writeFile(String(action.input.path || ""), String(action.input.content || ""));
      case "apply_patch":
        return this.applyPatch(String(action.input.diff || ""), asString(action.input.cwd));
      case "run_command":
        return this.runCommand(String(action.input.command || ""), asString(action.input.cwd));
      case "run_tests":
        return this.runTests(String(action.input.command || ""), asString(action.input.cwd));
      case "tail_logs":
        return this.tailLogs(String(action.input.path || ""), Number(action.input.lines || 40));
      default:
        return {
          status: "error",
          stderr: `Unsupported action: ${action.type}`,
          duration_ms: 0
        };
    }
  }

  async readFile(filePath: string): Promise<AciObservation> {
    const started = Date.now();
    try {
      const text = await fs.readFile(filePath, "utf8");
      return {
        status: "ok",
        stdout: text,
        artifacts: [filePath],
        duration_ms: Date.now() - started
      };
    } catch (error) {
      return {
        status: "error",
        stderr: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - started
      };
    }
  }

  async writeFile(filePath: string, content: string): Promise<AciObservation> {
    const started = Date.now();
    try {
      await ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, content, "utf8");
      return {
        status: "ok",
        artifacts: [filePath],
        duration_ms: Date.now() - started
      };
    } catch (error) {
      return {
        status: "error",
        stderr: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - started
      };
    }
  }

  async applyPatch(diff: string, cwd?: string): Promise<AciObservation> {
    const started = Date.now();
    if (!diff.trim()) {
      return {
        status: "error",
        stderr: "Empty diff",
        duration_ms: Date.now() - started
      };
    }

    // Minimal local adapter behavior: persist patch file for auditability.
    const patchPath = path.join(cwd || process.cwd(), `.autoresearch/tmp_patch_${Date.now()}.diff`);
    await ensureDir(path.dirname(patchPath));
    await fs.writeFile(patchPath, diff, "utf8");
    return {
      status: "ok",
      stdout: "Patch recorded for review",
      artifacts: [patchPath],
      duration_ms: Date.now() - started
    };
  }

  async runCommand(command: string, cwd?: string, signal?: AbortSignal): Promise<AciObservation> {
    return runShell(command, cwd, signal);
  }

  async runTests(command: string, cwd?: string, signal?: AbortSignal): Promise<AciObservation> {
    return runShell(command, cwd, signal);
  }

  async tailLogs(filePath: string, lines = 40): Promise<AciObservation> {
    const started = Date.now();
    try {
      const text = await fs.readFile(filePath, "utf8");
      const out = text.split("\n").slice(-Math.max(1, lines)).join("\n");
      return {
        status: "ok",
        stdout: out,
        artifacts: [filePath],
        duration_ms: Date.now() - started
      };
    } catch (error) {
      return {
        status: "error",
        stderr: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - started
      };
    }
  }
}

function runShell(command: string, cwd?: string, signal?: AbortSignal): Promise<AciObservation> {
  const started = Date.now();
  return new Promise((resolve) => {
    exec(command, {
      cwd: cwd || process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024 * 16,
      signal
    }, (error, stdout, stderr) => {
      resolve({
        status: error ? "error" : "ok",
        stdout,
        stderr,
        exit_code: error && typeof (error as { code?: number }).code === "number"
          ? (error as { code: number }).code
          : 0,
        duration_ms: Date.now() - started
      });
    });
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
