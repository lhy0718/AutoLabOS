import path from "node:path";
import { promises as fs } from "node:fs";

import type {
  AciExecutionDevicePolicy,
  AciExecutionEnvelopeRequest
} from "./aci.js";

export const BUBBLEWRAP_STARTED_MARKER = "__AUTOLABOS_BWRAP_STARTED__";

export interface BubblewrapExecutionPlan {
  executable: "bwrap";
  args: string[];
  hostEnvironment: NodeJS.ProcessEnv;
  sandboxCommand: string;
  sandboxCwd: string;
}

const SYSTEM_READ_ONLY_PATHS = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/etc/alternatives",
  "/etc/ca-certificates",
  "/etc/ld.so.cache",
  "/etc/ld.so.conf",
  "/etc/ld.so.conf.d",
  "/etc/localtime",
  "/etc/ssl"
];

const NETWORK_CONFIGURATION_PATHS = [
  "/etc/gai.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/resolv.conf"
];

const CACHE_ENVIRONMENT_NAMES = new Set([
  "HF_HOME",
  "HUGGINGFACE_HUB_CACHE",
  "TORCH_HOME",
  "TRANSFORMERS_CACHE",
  "XDG_CACHE_HOME"
]);

export async function buildBubblewrapExecutionPlan(
  request: AciExecutionEnvelopeRequest,
  allowlistedEnvironment: NodeJS.ProcessEnv,
  options?: { devicePaths?: string[] }
): Promise<BubblewrapExecutionPlan> {
  const workspaceRoot = path.resolve(request.workspaceRoot);
  const sandboxRoot = "/workspace";
  const sandboxCwd = mapWorkspacePath(request.cwd, workspaceRoot, sandboxRoot);
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--clearenv"
  ];
  if (request.networkPolicy !== "blocked") {
    args.push("--share-net");
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  for (const devicePath of options?.devicePaths || []) {
    args.push("--dev-bind", devicePath, devicePath);
  }

  for (const source of await existingPaths([
    ...SYSTEM_READ_ONLY_PATHS,
    ...(request.networkPolicy === "blocked" ? [] : NETWORK_CONFIGURATION_PATHS)
  ])) {
    args.push("--ro-bind", source, source);
  }

  args.push(
    "--dir", "/home",
    "--dir", "/home/autolabos",
    "--ro-bind", workspaceRoot, sandboxRoot
  );
  const writableRoots = [...new Set(request.writableRoots.map((item) => path.resolve(item)))]
    .sort((left, right) => pathDepth(left) - pathDepth(right));
  for (const source of writableRoots) {
    args.push("--bind", source, mapWorkspacePath(source, workspaceRoot, sandboxRoot));
  }

  const sandboxEnvironment = buildSandboxEnvironment(
    allowlistedEnvironment,
    workspaceRoot,
    sandboxRoot,
    request.envelopeId
  );
  for (const [name, value] of Object.entries(sandboxEnvironment)) {
    args.push("--setenv", name, value);
  }

  const sandboxCommand = request.command.split(workspaceRoot).join(sandboxRoot);
  args.push(
    "--chdir", sandboxCwd,
    "--",
    "/bin/sh",
    "-c",
    "printf '%s\\n' \"$2\" >&2; exec /bin/sh -c \"$1\"",
    "autolabos-envelope",
    sandboxCommand,
    BUBBLEWRAP_STARTED_MARKER
  );
  return {
    executable: "bwrap",
    args,
    hostEnvironment: {
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8"
    },
    sandboxCommand,
    sandboxCwd
  };
}

export const BUBBLEWRAP_PROBE_ARGS = [
  "--die-with-parent",
  "--unshare-all",
  "--ro-bind", "/usr", "/usr",
  "--proc", "/proc",
  "--dev", "/dev",
  "--",
  "/usr/bin/true"
];

export async function resolveBubblewrapDeviceMounts(
  policy: AciExecutionDevicePolicy
): Promise<{ valid: boolean; devicePaths: string[]; reasonCode?: string }> {
  if (policy.kind === "cpu_only") {
    return { valid: true, devicePaths: [] };
  }
  if (policy.visibleGpuDeviceIds.length !== policy.requestedGpuCount) {
    return {
      valid: false,
      devicePaths: [],
      reasonCode: "isolated_execution_gpu_device_ids_not_declared"
    };
  }
  if (policy.visibleGpuDeviceIds.some((id) => !/^\d+$/u.test(id))) {
    return {
      valid: false,
      devicePaths: [],
      reasonCode: "isolated_execution_gpu_device_id_format_unsupported"
    };
  }
  const required = [
    "/dev/nvidiactl",
    ...policy.visibleGpuDeviceIds.map((id) => `/dev/nvidia${id}`)
  ];
  const missing = await missingPaths(required);
  if (missing.length > 0) {
    return {
      valid: false,
      devicePaths: [],
      reasonCode: "isolated_execution_gpu_device_missing"
    };
  }
  const optional = await existingPaths([
    "/dev/nvidia-modeset",
    "/dev/nvidia-uvm",
    "/dev/nvidia-uvm-tools"
  ]);
  return {
    valid: true,
    devicePaths: [...new Set([...required, ...optional])]
  };
}

function buildSandboxEnvironment(
  environment: NodeJS.ProcessEnv,
  workspaceRoot: string,
  sandboxRoot: string,
  envelopeId: string
): Record<string, string> {
  const result: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/autolabos",
    TMPDIR: "/tmp",
    AUTOLABOS_EXECUTION_ENVELOPE_ID: envelopeId
  };
  for (const [name, rawValue] of Object.entries(environment)) {
    if (typeof rawValue !== "string" || name === "PATH" || name === "HOME" || name === "TMPDIR") {
      continue;
    }
    if (CACHE_ENVIRONMENT_NAMES.has(name)) {
      result[name] = `/tmp/cache/${name.toLowerCase()}`;
      continue;
    }
    result[name] = rewriteWorkspacePaths(rawValue, workspaceRoot, sandboxRoot);
  }
  return result;
}

function rewriteWorkspacePaths(value: string, workspaceRoot: string, sandboxRoot: string): string {
  return value.split(workspaceRoot).join(sandboxRoot);
}

function mapWorkspacePath(candidate: string, workspaceRoot: string, sandboxRoot: string): string {
  const resolved = path.resolve(candidate);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("bubblewrap_path_outside_workspace");
  }
  return relative ? path.posix.join(sandboxRoot, ...relative.split(path.sep)) : sandboxRoot;
}

async function existingPaths(candidates: string[]): Promise<string[]> {
  const unique = [...new Set(candidates)];
  const checks = await Promise.all(unique.map(async (candidate) => {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      return undefined;
    }
  }));
  return checks.filter((candidate): candidate is string => typeof candidate === "string");
}

async function missingPaths(candidates: string[]): Promise<string[]> {
  const existing = new Set(await existingPaths(candidates));
  return candidates.filter((candidate) => !existing.has(candidate));
}

function pathDepth(value: string): number {
  return path.resolve(value).split(path.sep).filter(Boolean).length;
}
