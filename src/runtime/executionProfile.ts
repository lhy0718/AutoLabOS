import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";

import { ExecutionProfile } from "../types.js";

export interface DetectExecutionProfileOptions {
  env?: NodeJS.ProcessEnv;
  dockerEnvFile?: string;
  commandExists?: (command: string) => Promise<boolean>;
}

export async function detectExecutionProfile(
  opts?: DetectExecutionProfileOptions
): Promise<ExecutionProfile> {
  const env = opts?.env || process.env;
  if (env.AUTOLABOS_REMOTE_HOST?.trim()) {
    return "remote";
  }
  if (env.AUTOLABOS_DOCKER_IMAGE?.trim() || env.DOCKER?.trim()) {
    return "docker";
  }
  if (await fileExists(opts?.dockerEnvFile || "/.dockerenv")) {
    return "docker";
  }

  const commandExists = opts?.commandExists || commandIsAvailable;
  const [hasPdfLatex, hasPython] = await Promise.all([
    commandExists("pdflatex"),
    commandExists("python3")
  ]);
  if (!hasPdfLatex && !hasPython) {
    return "plan_only";
  }
  return "local";
}

export function executionProfileToDependencyMode(
  profile: ExecutionProfile
): "local" | "docker" | "remote_gpu" | "plan_only" {
  switch (profile) {
    case "docker":
      return "docker";
    case "remote":
      return "remote_gpu";
    case "plan_only":
      return "plan_only";
    default:
      return "local";
  }
}

export function resolveDockerExecTarget(env: NodeJS.ProcessEnv): string {
  const configured = env.DOCKER?.trim();
  if (configured && configured !== "1" && configured.toLowerCase() !== "true") {
    return configured;
  }
  const hostname = env.HOSTNAME?.trim();
  if (hostname) {
    return hostname;
  }
  return "autolabos-runtime";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function commandIsAvailable(command: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(command, ["--version"], {
      stdio: "ignore"
    });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}
