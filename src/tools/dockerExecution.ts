import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";

import type {
  AciExecutionEnvelopeRequest,
  AciObservation
} from "./aci.js";

const BLOCKED_ENV_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/iu;

export interface DockerExecutionPlan {
  executable: string;
  args: string[];
  hostEnvironment: NodeJS.ProcessEnv;
}

export interface DockerCreateExecutionPlan extends DockerExecutionPlan {
  containerName: string;
}

export interface DockerContainerInspection {
  id: string;
  running: boolean;
  paused: boolean;
  restarting: boolean;
  user: string;
  privileged: boolean;
  readonlyRootfs: boolean;
  networkMode: string;
  capDrop: string[];
  securityOpt: string[];
  mounts: Array<{
    type: string;
    source: string;
    destination: string;
    readWrite: boolean;
  }>;
  devices: Array<{
    hostPath: string;
    containerPath: string;
  }>;
  deviceRequests: Array<{
    driver: string;
    count: number;
    deviceIds: string[];
    capabilities: string[][];
  }>;
}

export interface DockerBoundaryValidation {
  valid: boolean;
  reasonCodes: string[];
  fingerprint: string;
}

interface RawDockerInspection {
  Id?: unknown;
  Config?: {
    User?: unknown;
  };
  State?: {
    Running?: unknown;
    Paused?: unknown;
    Restarting?: unknown;
  };
  HostConfig?: {
    Privileged?: unknown;
    ReadonlyRootfs?: unknown;
    NetworkMode?: unknown;
    CapDrop?: unknown;
    SecurityOpt?: unknown;
    Devices?: unknown;
    DeviceRequests?: unknown;
  };
  Mounts?: unknown;
}

export function parseDockerContainerInspection(
  observation: AciObservation
): DockerContainerInspection {
  if (observation.status !== "ok") {
    throw new Error("docker_container_inspect_failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(observation.stdout || "");
  } catch {
    throw new Error("docker_container_inspect_invalid_json");
  }
  const records = Array.isArray(parsed) ? parsed : [];
  const raw = records[0] as RawDockerInspection | undefined;
  if (!raw || typeof raw !== "object") {
    throw new Error("docker_container_inspect_missing_record");
  }
  return {
    id: asString(raw.Id),
    running: raw.State?.Running === true,
    paused: raw.State?.Paused === true,
    restarting: raw.State?.Restarting === true,
    user: asString(raw.Config?.User),
    privileged: raw.HostConfig?.Privileged === true,
    readonlyRootfs: raw.HostConfig?.ReadonlyRootfs === true,
    networkMode: asString(raw.HostConfig?.NetworkMode),
    capDrop: asStringArray(raw.HostConfig?.CapDrop),
    securityOpt: asStringArray(raw.HostConfig?.SecurityOpt),
    mounts: parseMounts(raw.Mounts),
    devices: parseDevices(raw.HostConfig?.Devices),
    deviceRequests: parseDeviceRequests(raw.HostConfig?.DeviceRequests)
  };
}

export function validateDockerExecutionBoundary(
  request: AciExecutionEnvelopeRequest,
  inspection: DockerContainerInspection,
  options?: {
    enforceDevicePolicy?: boolean;
    expectedState?: "running" | "stopped";
  }
): DockerBoundaryValidation {
  const reasonCodes: string[] = [];
  if (!inspection.id) reasonCodes.push("docker_container_identity_missing");
  const expectedState = options?.expectedState || "running";
  if (
    inspection.paused
    || inspection.restarting
    || (expectedState === "running" && !inspection.running)
    || (expectedState === "stopped" && inspection.running)
  ) {
    reasonCodes.push("docker_container_not_stably_running");
  }
  if (inspection.privileged) reasonCodes.push("docker_container_privileged");
  if (!inspection.readonlyRootfs) reasonCodes.push("docker_rootfs_not_readonly");
  if (!inspection.capDrop.some((item) => item.toUpperCase() === "ALL")) {
    reasonCodes.push("docker_capabilities_not_dropped");
  }
  if (!inspection.securityOpt.some((item) => item.toLowerCase().startsWith("no-new-privileges"))) {
    reasonCodes.push("docker_no_new_privileges_missing");
  }
  if (!inspection.user || /^(?:0|root)(?::|$)/iu.test(inspection.user)) {
    reasonCodes.push("docker_non_root_user_missing");
  }
  if (request.networkPolicy === "blocked" && inspection.networkMode !== "none") {
    reasonCodes.push("docker_network_not_blocked");
  }
  if (request.networkPolicy !== "blocked" && inspection.networkMode === "none") {
    reasonCodes.push("docker_network_unavailable");
  }
  validateMounts(request, inspection, reasonCodes);
  if (options?.enforceDevicePolicy !== false) {
    validateDevices(request, inspection, reasonCodes);
  }
  return {
    valid: reasonCodes.length === 0,
    reasonCodes: [...new Set(reasonCodes)],
    fingerprint: dockerBoundaryFingerprint(inspection)
  };
}

export function buildDockerExecutionPlan(
  request: AciExecutionEnvelopeRequest,
  target: string,
  environment: NodeJS.ProcessEnv,
  options?: {
    dockerExecutable?: string;
    hostEnvironment?: NodeJS.ProcessEnv;
  }
): DockerExecutionPlan {
  if (!target.trim()) {
    throw new Error("docker_execution_target_missing");
  }
  const explicitEnvironment: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/home/autolabos",
    TMPDIR: "/tmp",
    AUTOLABOS_EXECUTION_ENVELOPE_ID: request.envelopeId
  };
  for (const [name, value] of Object.entries(environment)) {
    if (
      typeof value === "string"
      && /^[A-Z_][A-Z0-9_]*$/u.test(name)
      && !BLOCKED_ENV_NAME.test(name)
    ) {
      explicitEnvironment[name] = value;
    }
  }
  const visibleDevices = request.devicePolicy.kind === "cpu_only"
    ? { CUDA_VISIBLE_DEVICES: "", NVIDIA_VISIBLE_DEVICES: "none" }
    : {
        CUDA_VISIBLE_DEVICES: request.devicePolicy.visibleGpuDeviceIds.join(","),
        NVIDIA_VISIBLE_DEVICES: request.devicePolicy.visibleGpuDeviceIds.join(",")
      };
  Object.assign(explicitEnvironment, visibleDevices);
  const assignments = Object.entries(explicitEnvironment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`);
  return {
    executable: options?.dockerExecutable || "docker",
    args: [
      "exec",
      target,
      "/usr/bin/env",
      "-i",
      ...assignments,
      "/bin/sh",
      "-c",
      `cd ${shellQuote(request.cwd)} && exec /bin/sh -c ${shellQuote(request.command)}`
    ],
    hostEnvironment: options?.hostEnvironment || process.env
  };
}

export function buildDockerCreateExecutionPlan(
  request: AciExecutionEnvelopeRequest,
  image: string,
  environment: NodeJS.ProcessEnv,
  options?: {
    dockerExecutable?: string;
    hostEnvironment?: NodeJS.ProcessEnv;
    containerName?: string;
    user?: string;
  }
): DockerCreateExecutionPlan {
  const normalizedImage = image.trim();
  if (!normalizedImage) {
    throw new Error("docker_execution_image_missing");
  }
  if (!/^[a-z0-9][a-z0-9._/:@-]*$/iu.test(normalizedImage)) {
    throw new Error("docker_execution_image_invalid");
  }
  const workspaceRoot = path.resolve(request.workspaceRoot);
  const writableRoots = minimizeWritableRoots(request.writableRoots);
  const containerName = options?.containerName || buildContainerName(request.envelopeId);
  const args = [
    "create",
    "--name", containerName,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--user", options?.user || resolveHostUser(),
    "--network", request.networkPolicy === "blocked" ? "none" : "bridge",
    "--tmpfs", "/tmp:rw,nosuid,nodev"
  ];
  const workspaceWritable = writableRoots.includes(workspaceRoot);
  args.push(
    "--mount",
    `type=bind,src=${workspaceRoot},dst=${workspaceRoot}${workspaceWritable ? "" : ",readonly"}`,
    "--workdir",
    request.cwd
  );
  for (const writableRoot of writableRoots) {
    if (writableRoot === workspaceRoot) continue;
    args.push("--mount", `type=bind,src=${writableRoot},dst=${writableRoot}`);
  }
  for (const maskedPath of discoverWorkspaceSecretFiles(workspaceRoot)) {
    args.push("--mount", `type=bind,src=/dev/null,dst=${maskedPath},readonly`);
  }
  for (const secret of request.secretFileMounts || []) {
    args.push(
      "--mount",
      `type=bind,src=${secret.sourcePath},dst=${secret.targetPath},readonly`
    );
  }
  if (request.devicePolicy.kind === "nvidia_gpu") {
    if (
      request.devicePolicy.visibleGpuDeviceIds.length
        !== request.devicePolicy.requestedGpuCount
      || request.devicePolicy.visibleGpuDeviceIds.some((id) => !/^\d+$/u.test(id))
    ) {
      throw new Error("docker_gpu_device_request_invalid");
    }
    args.push("--gpus", `device=${request.devicePolicy.visibleGpuDeviceIds.join(",")}`);
  }
  const explicitEnvironment = buildExplicitEnvironment(request, environment);
  args.push(
    "--entrypoint", "/usr/bin/env",
    normalizedImage,
    "-i",
    ...Object.entries(explicitEnvironment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`),
    "/bin/sh",
    "-c",
    `cd ${shellQuote(request.cwd)} && exec /bin/sh -c ${shellQuote(request.command)}`
  );
  return {
    executable: options?.dockerExecutable || "docker",
    args,
    hostEnvironment: options?.hostEnvironment || process.env,
    containerName
  };
}

export function dockerBoundaryFingerprint(inspection: DockerContainerInspection): string {
  const serialized = JSON.stringify({
    id: inspection.id,
    running: inspection.running,
    paused: inspection.paused,
    restarting: inspection.restarting,
    user: inspection.user,
    privileged: inspection.privileged,
    readonlyRootfs: inspection.readonlyRootfs,
    networkMode: inspection.networkMode,
    capDrop: [...inspection.capDrop].sort(),
    securityOpt: [...inspection.securityOpt].sort(),
    mounts: [...inspection.mounts].sort(compareJson),
    devices: [...inspection.devices].sort(compareJson),
    deviceRequests: [...inspection.deviceRequests].sort(compareJson)
  });
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function validateMounts(
  request: AciExecutionEnvelopeRequest,
  inspection: DockerContainerInspection,
  reasonCodes: string[]
): void {
  const workspaceRoot = path.resolve(request.workspaceRoot);
  const writableRoots = [...new Set(request.writableRoots.map((item) => path.resolve(item)))];
  const secretMounts = request.secretFileMounts || [];
  const maskedWorkspaceSecrets = new Set(discoverWorkspaceSecretFiles(workspaceRoot));
  for (const mount of inspection.mounts) {
    if (!mount.source || !mount.destination) {
      reasonCodes.push("docker_unapproved_mount_present");
      continue;
    }
    const source = path.resolve(mount.source);
    const destination = path.resolve(mount.destination);
    const workspaceMount = source === destination && isInside(destination, workspaceRoot);
    const secretMount = secretMounts.some((secret) =>
      source === path.resolve(secret.sourcePath)
      && destination === path.resolve(secret.targetPath)
      && !mount.readWrite
    );
    const maskedWorkspaceSecret = source === "/dev/null"
      && maskedWorkspaceSecrets.has(destination)
      && !mount.readWrite;
    if (
      mount.type !== "bind"
      || (!workspaceMount && !secretMount && !maskedWorkspaceSecret)
    ) {
      reasonCodes.push("docker_unapproved_mount_present");
      continue;
    }
    if (
      workspaceMount
      && mount.readWrite
      && !writableRoots.some((root) => isInside(destination, root))
    ) {
      reasonCodes.push("docker_mount_write_scope_too_broad");
    }
  }
  if (!inspection.mounts.some((mount) => {
    const destination = path.resolve(mount.destination);
    return mount.type === "bind"
      && path.resolve(mount.source) === destination
      && isInside(workspaceRoot, destination);
  })) {
    reasonCodes.push("docker_workspace_mount_missing");
  }
  for (const writableRoot of writableRoots) {
    const covered = inspection.mounts.some((mount) => mount.readWrite
      && mount.type === "bind"
      && path.resolve(mount.source) === path.resolve(mount.destination)
      && isInside(writableRoot, path.resolve(mount.destination)));
    if (!covered) {
      reasonCodes.push("docker_writable_root_not_mounted");
      break;
    }
  }
  for (const maskedPath of maskedWorkspaceSecrets) {
    const covered = inspection.mounts.some((mount) =>
      mount.type === "bind"
      && path.resolve(mount.source) === "/dev/null"
      && path.resolve(mount.destination) === maskedPath
      && !mount.readWrite
    );
    if (!covered) {
      reasonCodes.push("docker_workspace_secret_not_masked");
      break;
    }
  }
  for (const secret of secretMounts) {
    const covered = inspection.mounts.some((mount) =>
      mount.type === "bind"
      && path.resolve(mount.source) === path.resolve(secret.sourcePath)
      && path.resolve(mount.destination) === path.resolve(secret.targetPath)
      && !mount.readWrite
    );
    if (!covered) {
      reasonCodes.push("docker_secret_file_mount_missing");
      break;
    }
  }
}

function validateDevices(
  request: AciExecutionEnvelopeRequest,
  inspection: DockerContainerInspection,
  reasonCodes: string[]
): void {
  if (inspection.devices.length > 0) {
    reasonCodes.push("docker_unmanaged_device_mapping_present");
  }
  if (request.devicePolicy.kind === "cpu_only") {
    if (inspection.deviceRequests.length > 0) {
      reasonCodes.push("docker_gpu_device_exposure_present");
    }
    return;
  }
  if (inspection.deviceRequests.length !== 1) {
    reasonCodes.push("docker_gpu_device_request_mismatch");
    return;
  }
  const declared = inspection.deviceRequests[0];
  const expected = [...request.devicePolicy.visibleGpuDeviceIds].sort();
  const actual = [...declared.deviceIds].sort();
  const gpuCapability = declared.capabilities.some((group) =>
    group.some((capability) => capability.toLowerCase() === "gpu")
  );
  if (
    expected.length !== request.devicePolicy.requestedGpuCount
    || expected.some((id) => !/^\d+$/u.test(id))
    || !gpuCapability
    || (declared.driver && declared.driver !== "nvidia")
    || JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    reasonCodes.push("docker_gpu_device_request_mismatch");
  }
}

function parseMounts(value: unknown): DockerContainerInspection["mounts"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return [{
      type: asString(record.Type),
      source: asString(record.Source),
      destination: asString(record.Destination),
      readWrite: record.RW === true
    }];
  });
}

function parseDevices(value: unknown): DockerContainerInspection["devices"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return [{
      hostPath: asString(record.PathOnHost),
      containerPath: asString(record.PathInContainer)
    }];
  });
}

function parseDeviceRequests(value: unknown): DockerContainerInspection["deviceRequests"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return [{
      driver: asString(record.Driver),
      count: typeof record.Count === "number" ? record.Count : 0,
      deviceIds: asStringArray(record.DeviceIDs),
      capabilities: Array.isArray(record.Capabilities)
        ? record.Capabilities.map((group) => asStringArray(group))
        : []
    }];
  });
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildExplicitEnvironment(
  request: AciExecutionEnvelopeRequest,
  environment: NodeJS.ProcessEnv
): Record<string, string> {
  const explicitEnvironment: Record<string, string> = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/home",
    TMPDIR: "/tmp",
    AUTOLABOS_EXECUTION_ENVELOPE_ID: request.envelopeId
  };
  for (const [name, value] of Object.entries(environment)) {
    if (
      typeof value === "string"
      && /^[A-Z_][A-Z0-9_]*$/u.test(name)
      && !BLOCKED_ENV_NAME.test(name)
    ) {
      explicitEnvironment[name] = value;
    }
  }
  Object.assign(
    explicitEnvironment,
    request.devicePolicy.kind === "cpu_only"
      ? { CUDA_VISIBLE_DEVICES: "", NVIDIA_VISIBLE_DEVICES: "none" }
      : {
          CUDA_VISIBLE_DEVICES: request.devicePolicy.visibleGpuDeviceIds.join(","),
          NVIDIA_VISIBLE_DEVICES: request.devicePolicy.visibleGpuDeviceIds.join(",")
        }
  );
  return explicitEnvironment;
}

function buildContainerName(envelopeId: string): string {
  const normalized = envelopeId.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").slice(0, 32);
  return `autolabos-${normalized || "execution"}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function resolveHostUser(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 65534;
  const gid = typeof process.getgid === "function" ? process.getgid() : 65534;
  return `${uid}:${gid}`;
}

function pathDepth(value: string): number {
  return path.resolve(value).split(path.sep).filter(Boolean).length;
}

function minimizeWritableRoots(values: string[]): string[] {
  const ordered = [...new Set(values.map((item) => path.resolve(item)))]
    .sort((left, right) => pathDepth(left) - pathDepth(right));
  return ordered.filter((candidate, index) =>
    !ordered.slice(0, index).some((parent) => isInside(candidate, parent))
  );
}

function discoverWorkspaceSecretFiles(workspaceRoot: string): string[] {
  try {
    const matches: string[] = [];
    const pending = [workspaceRoot];
    let visited = 0;
    while (pending.length > 0) {
      const current = pending.pop() as string;
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        visited += 1;
        if (visited > 100_000) {
          throw new Error("docker_workspace_secret_scan_limit");
        }
        const candidate = path.join(current, entry.name);
        const dotenvName = entry.name === ".env" || entry.name.startsWith(".env.");
        if (entry.isSymbolicLink()) {
          if (dotenvName && entry.name !== ".env.example") {
            throw new Error("docker_workspace_secret_symlink_unsupported");
          }
          continue;
        }
        if (entry.isDirectory()) {
          pending.push(candidate);
          continue;
        }
        if (
          entry.isFile()
          && dotenvName
          && entry.name !== ".env.example"
        ) {
          matches.push(candidate);
        }
      }
    }
    return matches.sort();
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) {
      return [];
    }
    throw new Error("docker_workspace_secret_scan_failed");
  }
}

function compareJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
