import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import type {
  AciExecutionEnvelopeObservation,
  AciExecutionEnvelopePhase,
  AciExecutionEnvelopeRequest,
  AciExecutionDevicePolicy,
  AciObservation,
  AgentComputerInterface
} from "../../tools/aci.js";
import type {
  ExecutionProfile,
  ExperimentNetworkPolicy,
  ExperimentNetworkPurpose
} from "../../types.js";
import { hashCanonical } from "../canonicalHash.js";

const DEPENDENCY_LOCK_NAMES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "requirements.lock.txt",
  "environment.yml",
  "environment.yaml",
  "pyproject.toml"
];

export const DEFAULT_EXECUTION_ENVIRONMENT_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "PYTHONPATH",
  "CUDA_VISIBLE_DEVICES",
  "NVIDIA_VISIBLE_DEVICES",
  "CUDA_HOME",
  "HF_HOME",
  "HUGGINGFACE_HUB_CACHE",
  "TRANSFORMERS_CACHE",
  "TORCH_HOME",
  "XDG_CACHE_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR"
] as const;

export interface ExecutionEnvelopeArtifactBinding {
  path: string;
  sha256: string;
}

export interface ExecutionEnvelopeArtifact {
  version: 1;
  envelope_id: string;
  envelope_sha256: string;
  run_id: string;
  phase: AciExecutionEnvelopePhase;
  attempt: number;
  execution_profile: ExecutionProfile;
  container_image?: string;
  command: string;
  command_sha256: string;
  cwd: string;
  writable_roots: string[];
  secret_files: Array<{
    target_path: string;
    required: boolean;
  }>;
  environment_allowlist: string[];
  devices: {
    policy: "cpu_only" | "nvidia_gpu";
    requested_gpu_count: number;
    visible_device_ids: string[];
  };
  network: {
    policy: ExperimentNetworkPolicy;
    purpose?: ExperimentNetworkPurpose;
  };
  limits: {
    timeout_ms: number;
  };
  seeds: number[];
  seed_binding_status: "declared" | "not_declared";
  input_artifacts: ExecutionEnvelopeArtifactBinding[];
  dependency_artifacts: ExecutionEnvelopeArtifactBinding[];
  expected_outputs: Array<{ path: string; required: boolean }>;
  created_at: string;
}

export interface ExecutionEnvelopeReceipt {
  version: 1;
  receipt_sha256: string;
  envelope_id: string;
  envelope_sha256: string;
  run_id: string;
  phase: AciExecutionEnvelopePhase;
  attempt: number;
  status: "completed" | "failed" | "timed_out" | "policy_blocked";
  adapter: string;
  enforcement: "enforced" | "partial" | "compatibility";
  paper_grade_eligible: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  exit_code?: number;
  assurance: {
    environment_allowlist_enforced: boolean;
    workspace_boundary_enforced: boolean;
    input_hashes_verified: boolean;
    timeout_enforced: boolean;
    network_policy_enforced: boolean;
    mount_isolation_enforced: boolean;
    device_policy_enforced: boolean;
  };
  runtime_evidence?: NonNullable<AciExecutionEnvelopeObservation["runtime_evidence"]>;
  output_artifacts: Array<ExecutionEnvelopeArtifactBinding & { required: boolean }>;
  required_outputs_present: boolean;
  reason_codes: string[];
}

export interface BuiltExecutionEnvelope {
  artifact: ExecutionEnvelopeArtifact;
  request: AciExecutionEnvelopeRequest;
}

export interface ExecutionEnvelopeArtifactAudit {
  valid: boolean;
  paper_grade_eligible: boolean;
  reason_codes: string[];
}

const EXECUTION_ASSURANCE_KEYS = [
  "environment_allowlist_enforced",
  "workspace_boundary_enforced",
  "input_hashes_verified",
  "timeout_enforced",
  "network_policy_enforced",
  "mount_isolation_enforced",
  "device_policy_enforced"
] as const;

export async function buildExecutionEnvelope(input: {
  workspaceRoot: string;
  runId: string;
  phase: AciExecutionEnvelopePhase;
  attempt: number;
  executionProfile: ExecutionProfile;
  containerImage?: string;
  command: string;
  cwd: string;
  writableRoots: string[];
  secretFileMounts?: Array<{
    sourcePath: string;
    targetName: string;
    required?: boolean;
  }>;
  expectedOutputs: Array<{ path: string; required: boolean }>;
  inputArtifactPaths?: string[];
  timeoutMs: number;
  networkPolicy?: ExperimentNetworkPolicy;
  networkPurpose?: ExperimentNetworkPurpose;
  seeds?: number[];
  requestedGpuCount?: number;
  visibleGpuDeviceIds?: string[];
  createdAt?: string;
}): Promise<BuiltExecutionEnvelope> {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const cwd = requireWorkspacePath(input.cwd, workspaceRoot, "execution_cwd_outside_workspace");
  const writableRoots = uniquePaths(input.writableRoots.map((item) =>
    requireWorkspacePath(item, workspaceRoot, "writable_root_outside_workspace")
  ));
  const secretFileMounts = await normalizeSecretFileMounts(
    input.secretFileMounts || [],
    workspaceRoot
  );
  const expectedOutputs = input.expectedOutputs.map((item) => {
    const outputPath = requireWorkspacePath(item.path, workspaceRoot, "expected_output_outside_workspace");
    if (!writableRoots.some((root) => isPathInsideOrEqual(outputPath, root))) {
      throw new Error("expected_output_outside_writable_roots");
    }
    return { path: outputPath, required: item.required };
  });
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new Error("execution_timeout_invalid");
  }

  const inputArtifacts = await collectBindings(
    uniquePaths((input.inputArtifactPaths || []).map((item) =>
      requireWorkspacePath(item, workspaceRoot, "input_artifact_outside_workspace")
    )),
    workspaceRoot
  );
  const dependencyArtifacts = await collectDependencyBindings({
    workspaceRoot,
    cwd
  });
  const createdAt = input.createdAt || new Date().toISOString();
  const devicePolicy = normalizeDevicePolicy(
    input.requestedGpuCount,
    input.visibleGpuDeviceIds
  );
  const portableCommand = toPortableCommand(input.command, workspaceRoot);
  const commandSha256 = createHash("sha256").update(portableCommand, "utf8").digest("hex");
  const portable = {
    version: 1 as const,
    run_id: input.runId,
    phase: input.phase,
    attempt: input.attempt,
    execution_profile: input.executionProfile,
    ...(input.containerImage?.trim()
      ? { container_image: input.containerImage.trim() }
      : {}),
    command: portableCommand,
    command_sha256: commandSha256,
    cwd: toWorkspaceRelative(cwd, workspaceRoot),
    writable_roots: writableRoots.map((item) => toWorkspaceRelative(item, workspaceRoot)),
    secret_files: secretFileMounts.map((item) => ({
      target_path: item.targetPath,
      required: item.required
    })),
    environment_allowlist: [...DEFAULT_EXECUTION_ENVIRONMENT_ALLOWLIST],
    devices: {
      policy: devicePolicy.kind,
      requested_gpu_count: devicePolicy.requestedGpuCount,
      visible_device_ids: [...devicePolicy.visibleGpuDeviceIds]
    },
    network: {
      policy: input.networkPolicy || "blocked",
      ...(input.networkPurpose ? { purpose: input.networkPurpose } : {})
    },
    limits: { timeout_ms: input.timeoutMs },
    seeds: normalizeSeeds(input.seeds || []),
    seed_binding_status: input.seeds && input.seeds.length > 0
      ? "declared" as const
      : "not_declared" as const,
    input_artifacts: inputArtifacts.map((item) => portableBinding(item, workspaceRoot)),
    dependency_artifacts: dependencyArtifacts.map((item) => portableBinding(item, workspaceRoot)),
    expected_outputs: expectedOutputs.map((item) => ({
      path: toWorkspaceRelative(item.path, workspaceRoot),
      required: item.required
    })),
    created_at: createdAt
  };
  const envelopeSha256 = hashCanonical(portable);
  const envelopeId = `exec_${envelopeSha256.slice(0, 24)}`;
  return {
    artifact: {
      ...portable,
      envelope_id: envelopeId,
      envelope_sha256: envelopeSha256
    },
    request: {
      version: 1,
      envelopeId,
      runId: input.runId,
      phase: input.phase,
      attempt: input.attempt,
      executionProfile: input.executionProfile,
      containerImage: input.containerImage?.trim() || undefined,
      command: input.command,
      commandSha256,
      workspaceRoot,
      cwd,
      writableRoots,
      secretFileMounts,
      environmentAllowlist: [...DEFAULT_EXECUTION_ENVIRONMENT_ALLOWLIST],
      devicePolicy,
      networkPolicy: input.networkPolicy || "blocked",
      networkPurpose: input.networkPurpose,
      timeoutMs: input.timeoutMs,
      inputArtifacts,
      dependencyArtifacts,
      expectedOutputs
    }
  };
}

async function normalizeSecretFileMounts(
  mounts: Array<{ sourcePath: string; targetName: string; required?: boolean }>,
  workspaceRoot: string
): Promise<Array<{
  sourcePath: string;
  targetPath: string;
  required: boolean;
  sourceSha256: string;
}>> {
  const normalized = [];
  const targetNames = new Set<string>();
  for (const mount of mounts) {
    const targetName = mount.targetName.trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(targetName)) {
      throw new Error("execution_secret_target_invalid");
    }
    if (targetNames.has(targetName)) {
      throw new Error("execution_secret_target_duplicate");
    }
    targetNames.add(targetName);
    const sourcePath = path.resolve(mount.sourcePath);
    if (
      /[,\r\n]/u.test(sourcePath)
      || isPathInsideOrEqual(sourcePath, workspaceRoot)
    ) {
      throw new Error("execution_secret_source_invalid");
    }
    const [realPath, metadata] = await Promise.all([
      fs.realpath(sourcePath).catch(() => undefined),
      fs.lstat(sourcePath).catch(() => undefined)
    ]);
    if (
      !realPath
      || !metadata?.isFile()
      || metadata.isSymbolicLink()
      || realPath !== sourcePath
      || !hasPrivateSecretFileMode(metadata)
    ) {
      throw new Error("execution_secret_source_invalid");
    }
    const sourceSha256 = await hashFileIfPresent(sourcePath);
    if (!sourceSha256) {
      throw new Error("execution_secret_source_invalid");
    }
    normalized.push({
      sourcePath,
      targetPath: `/run/secrets/${targetName}`,
      required: mount.required !== false,
      sourceSha256
    });
  }
  return normalized;
}

function hasPrivateSecretFileMode(metadata: { mode: number; uid?: number }): boolean {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return (metadata.mode & 0o077) === 0
    && (currentUid === undefined || metadata.uid === undefined || metadata.uid === currentUid);
}

export async function executeInEnvelope(input: {
  aci: AgentComputerInterface;
  envelope: BuiltExecutionEnvelope;
  scope: "command" | "tests";
  signal?: AbortSignal;
  startedAt?: string;
}): Promise<{ observation: AciObservation; receipt: ExecutionEnvelopeReceipt }> {
  const startedAt = input.startedAt || new Date().toISOString();
  const startedAtMs = Date.parse(startedAt);
  let observation: AciObservation;
  if (input.aci.runInExecutionEnvelope) {
    observation = await input.aci.runInExecutionEnvelope(
      input.envelope.request,
      input.scope,
      input.signal
    );
  } else {
    observation = input.scope === "tests"
      ? await input.aci.runTests(
          input.envelope.request.command,
          input.envelope.request.cwd,
          input.signal
        )
      : await input.aci.runCommand(
          input.envelope.request.command,
          input.envelope.request.cwd,
          input.signal
        );
    observation = {
      ...observation,
      execution_envelope: compatibilityObservation(input.envelope.artifact.envelope_id)
    };
  }
  const finishedAt = new Date().toISOString();
  const outputArtifacts = await collectOutputBindings(input.envelope.request.expectedOutputs);
  const requiredOutputsPresent = input.envelope.request.expectedOutputs
    .filter((item) => item.required)
    .every((item) => outputArtifacts.some((artifact) => artifact.path === item.path));
  const assurance = observation.execution_envelope || compatibilityObservation(
    input.envelope.artifact.envelope_id
  );
  const runtimeEvidenceReasonCodes = deriveRuntimeEvidenceReasonCodes(
    assurance.adapter,
    assurance.runtime_evidence
  );
  const reasonCodes = [
    ...assurance.reason_codes,
    ...runtimeEvidenceReasonCodes,
    ...(!requiredOutputsPresent ? ["required_execution_output_missing"] : []),
    ...(input.envelope.artifact.dependency_artifacts.length === 0
      ? ["dependency_lock_missing"]
      : [])
  ];
  const paperGradeEligible =
    observation.status === "ok"
    && !assurance.timed_out
    && assurance.enforcement === "enforced"
    && assurance.environment_allowlist_enforced
    && assurance.workspace_boundary_enforced
    && assurance.input_hashes_verified
    && assurance.timeout_enforced
    && assurance.network_policy_enforced
    && assurance.mount_isolation_enforced
    && assurance.device_policy_enforced
    && runtimeEvidenceReasonCodes.length === 0
    && requiredOutputsPresent
    && input.envelope.artifact.dependency_artifacts.length > 0
    && reasonCodes.length === 0;
  const status = assurance.timed_out
    ? "timed_out" as const
    : observation.policy?.allowed === false
      ? "policy_blocked" as const
      : observation.status === "ok"
        ? "completed" as const
        : "failed" as const;
  const receiptWithoutHash = {
    version: 1 as const,
    envelope_id: input.envelope.artifact.envelope_id,
    envelope_sha256: input.envelope.artifact.envelope_sha256,
    run_id: input.envelope.artifact.run_id,
    phase: input.envelope.artifact.phase,
    attempt: input.envelope.artifact.attempt,
    status,
    adapter: assurance.adapter,
    enforcement: assurance.enforcement,
    paper_grade_eligible: paperGradeEligible,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: observation.duration_ms || Math.max(0, Date.now() - startedAtMs),
    ...(typeof observation.exit_code === "number" ? { exit_code: observation.exit_code } : {}),
    assurance: {
      environment_allowlist_enforced: assurance.environment_allowlist_enforced,
      workspace_boundary_enforced: assurance.workspace_boundary_enforced,
      input_hashes_verified: assurance.input_hashes_verified,
      timeout_enforced: assurance.timeout_enforced,
      network_policy_enforced: assurance.network_policy_enforced,
      mount_isolation_enforced: assurance.mount_isolation_enforced,
      device_policy_enforced: assurance.device_policy_enforced
    },
    ...(assurance.runtime_evidence
      ? { runtime_evidence: assurance.runtime_evidence }
      : {}),
    output_artifacts: outputArtifacts.map((artifact) => ({
      ...portableBinding(artifact, input.envelope.request.workspaceRoot),
      required: input.envelope.request.expectedOutputs.find((item) => item.path === artifact.path)?.required === true
    })),
    required_outputs_present: requiredOutputsPresent,
    reason_codes: [...new Set(reasonCodes)]
  };
  return {
    observation,
    receipt: {
      ...receiptWithoutHash,
      receipt_sha256: hashCanonical(receiptWithoutHash)
    }
  };
}

export async function auditExecutionEnvelopeArtifacts(input: {
  artifact: ExecutionEnvelopeArtifact;
  receipt: ExecutionEnvelopeReceipt;
  workspaceRoot: string;
}): Promise<ExecutionEnvelopeArtifactAudit> {
  const reasonCodes: string[] = [];
  if (!isExecutionEnvelopeArtifactShape(input.artifact)) {
    reasonCodes.push("execution_envelope_schema_invalid");
  }
  if (!isExecutionEnvelopeReceiptShape(input.receipt)) {
    reasonCodes.push("execution_receipt_schema_invalid");
  }
  if (reasonCodes.length > 0) {
    return {
      valid: false,
      paper_grade_eligible: false,
      reason_codes: reasonCodes
    };
  }
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const {
    envelope_id: envelopeId,
    envelope_sha256: envelopeSha256,
    ...envelopePayload
  } = input.artifact;
  const expectedEnvelopeSha256 = hashCanonical(envelopePayload);
  if (envelopeSha256 !== expectedEnvelopeSha256) {
    reasonCodes.push("execution_envelope_hash_invalid");
  }
  if (envelopeId !== `exec_${expectedEnvelopeSha256.slice(0, 24)}`) {
    reasonCodes.push("execution_envelope_id_invalid");
  }

  const { receipt_sha256: receiptSha256, ...receiptPayload } = input.receipt;
  if (receiptSha256 !== hashCanonical(receiptPayload)) {
    reasonCodes.push("execution_receipt_hash_invalid");
  }
  if (
    input.receipt.envelope_id !== envelopeId
    || input.receipt.envelope_sha256 !== envelopeSha256
    || input.receipt.run_id !== input.artifact.run_id
    || input.receipt.phase !== input.artifact.phase
    || input.receipt.attempt !== input.artifact.attempt
  ) {
    reasonCodes.push("execution_receipt_envelope_link_invalid");
  }

  await auditPortableBindings(
    input.artifact.input_artifacts,
    workspaceRoot,
    "execution_input_artifact_current_hash_mismatch",
    reasonCodes
  );
  await auditPortableBindings(
    input.artifact.dependency_artifacts,
    workspaceRoot,
    "execution_dependency_artifact_current_hash_mismatch",
    reasonCodes
  );
  const expectedOutputs = new Map(
    input.artifact.expected_outputs.map((item) => [item.path, item.required])
  );
  const observedOutputPaths = new Set<string>();
  for (const output of input.receipt.output_artifacts) {
    if (observedOutputPaths.has(output.path)) {
      reasonCodes.push("execution_receipt_output_duplicate");
      continue;
    }
    observedOutputPaths.add(output.path);
    const expectedRequired = expectedOutputs.get(output.path);
    if (expectedRequired === undefined || expectedRequired !== output.required) {
      reasonCodes.push("execution_receipt_output_contract_mismatch");
      continue;
    }
    await auditPortableBindings(
      [{ path: output.path, sha256: output.sha256 }],
      workspaceRoot,
      "execution_output_artifact_current_hash_mismatch",
      reasonCodes
    );
  }
  const requiredOutputsPresent = input.artifact.expected_outputs
    .filter((item) => item.required)
    .every((item) => observedOutputPaths.has(item.path));
  if (input.receipt.required_outputs_present !== requiredOutputsPresent) {
    reasonCodes.push("execution_receipt_required_output_state_invalid");
  }

  const assurancesPass = Object.values(input.receipt.assurance).every(Boolean);
  const runtimeEvidenceReasonCodes = deriveRuntimeEvidenceReasonCodes(
    input.receipt.adapter as AciExecutionEnvelopeObservation["adapter"],
    input.receipt.runtime_evidence
  );
  if (
    runtimeEvidenceReasonCodes.some(
      (code) => !input.receipt.reason_codes.includes(code)
    )
  ) {
    reasonCodes.push("execution_receipt_runtime_evidence_state_invalid");
  }
  const derivedPaperGradeEligibility =
    input.receipt.status === "completed"
    && input.receipt.enforcement === "enforced"
    && assurancesPass
    && runtimeEvidenceReasonCodes.length === 0
    && requiredOutputsPresent
    && input.artifact.dependency_artifacts.length > 0
    && input.receipt.reason_codes.length === 0;
  if (input.receipt.paper_grade_eligible !== derivedPaperGradeEligibility) {
    reasonCodes.push("execution_receipt_paper_grade_state_invalid");
  }
  return {
    valid: reasonCodes.length === 0,
    paper_grade_eligible:
      reasonCodes.length === 0 && derivedPaperGradeEligibility,
    reason_codes: [...new Set(reasonCodes)]
  };
}

async function auditPortableBindings(
  bindings: ExecutionEnvelopeArtifactBinding[],
  workspaceRoot: string,
  mismatchCode: string,
  reasonCodes: string[]
): Promise<void> {
  for (const binding of bindings) {
    const absolute = path.resolve(workspaceRoot, binding.path);
    if (!isPathInsideOrEqual(absolute, workspaceRoot)) {
      reasonCodes.push("execution_artifact_path_outside_workspace");
      continue;
    }
    const realPathBefore = await fs.realpath(absolute).catch(() => undefined);
    if (realPathBefore !== absolute) {
      reasonCodes.push("execution_artifact_realpath_invalid");
      continue;
    }
    const sha256 = await hashFileIfPresent(absolute);
    if (sha256 !== binding.sha256) {
      reasonCodes.push(mismatchCode);
      continue;
    }
    const realPathAfter = await fs.realpath(absolute).catch(() => undefined);
    if (realPathAfter !== realPathBefore) {
      reasonCodes.push("execution_artifact_realpath_invalid");
    }
  }
}

function isExecutionEnvelopeArtifactShape(
  value: unknown
): value is ExecutionEnvelopeArtifact {
  if (!isRecord(value)) {
    return false;
  }
  return value.version === 1
    && isNonEmptyString(value.envelope_id)
    && isSha256(value.envelope_sha256)
    && isNonEmptyString(value.run_id)
    && isExecutionPhase(value.phase)
    && Number.isSafeInteger(value.attempt)
    && isNonEmptyString(value.execution_profile)
    && isNonEmptyString(value.command)
    && isSha256(value.command_sha256)
    && typeof value.cwd === "string"
    && isStringArray(value.writable_roots)
    && Array.isArray(value.secret_files)
    && value.secret_files.every((item) =>
      isRecord(item)
      && isNonEmptyString(item.target_path)
      && typeof item.required === "boolean"
    )
    && isStringArray(value.environment_allowlist)
    && isRecord(value.devices)
    && ["cpu_only", "nvidia_gpu"].includes(String(value.devices.policy))
    && Number.isSafeInteger(value.devices.requested_gpu_count)
    && isStringArray(value.devices.visible_device_ids)
    && isRecord(value.network)
    && ["blocked", "declared", "required"].includes(String(value.network.policy))
    && isRecord(value.limits)
    && Number.isSafeInteger(value.limits.timeout_ms)
    && Number(value.limits.timeout_ms) > 0
    && Array.isArray(value.seeds)
    && value.seeds.every((seed) => Number.isSafeInteger(seed) && Number(seed) >= 0)
    && ["declared", "not_declared"].includes(String(value.seed_binding_status))
    && isArtifactBindingArray(value.input_artifacts)
    && isArtifactBindingArray(value.dependency_artifacts)
    && Array.isArray(value.expected_outputs)
    && value.expected_outputs.every((item) =>
      isRecord(item)
      && isNonEmptyString(item.path)
      && typeof item.required === "boolean"
    )
    && isNonEmptyString(value.created_at);
}

function isExecutionEnvelopeReceiptShape(
  value: unknown
): value is ExecutionEnvelopeReceipt {
  if (!isRecord(value)) {
    return false;
  }
  const assurance = value.assurance;
  return value.version === 1
    && isSha256(value.receipt_sha256)
    && isNonEmptyString(value.envelope_id)
    && isSha256(value.envelope_sha256)
    && isNonEmptyString(value.run_id)
    && isExecutionPhase(value.phase)
    && Number.isSafeInteger(value.attempt)
    && ["completed", "failed", "timed_out", "policy_blocked"].includes(String(value.status))
    && isNonEmptyString(value.adapter)
    && ["enforced", "partial", "compatibility"].includes(String(value.enforcement))
    && typeof value.paper_grade_eligible === "boolean"
    && isNonEmptyString(value.started_at)
    && isNonEmptyString(value.finished_at)
    && typeof value.duration_ms === "number"
    && Number.isFinite(value.duration_ms)
    && value.duration_ms >= 0
    && hasExactBooleanKeys(assurance, EXECUTION_ASSURANCE_KEYS)
    && (
      value.runtime_evidence === undefined
      || isRuntimeEvidenceShape(value.runtime_evidence)
    )
    && Array.isArray(value.output_artifacts)
    && value.output_artifacts.every((item) =>
      isRecord(item)
      && isNonEmptyString(item.path)
      && isSha256(item.sha256)
      && typeof item.required === "boolean"
    )
    && typeof value.required_outputs_present === "boolean"
    && isStringArray(value.reason_codes);
}

function isArtifactBindingArray(value: unknown): value is ExecutionEnvelopeArtifactBinding[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) && isNonEmptyString(item.path) && isSha256(item.sha256)
  );
}

function isRuntimeEvidenceShape(
  value: unknown
): value is NonNullable<AciExecutionEnvelopeObservation["runtime_evidence"]> {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  const expected = [
    "cleanup",
    "final_fingerprint",
    "image_immutable",
    "initial_fingerprint",
    "kind",
    "stable"
  ].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && value.kind === "docker_boundary_inspection"
    && isSha256(value.initial_fingerprint)
    && isSha256(value.final_fingerprint)
    && typeof value.stable === "boolean"
    && ["verified", "not_applicable", "failed"].includes(String(value.cleanup))
    && typeof value.image_immutable === "boolean";
}

function deriveRuntimeEvidenceReasonCodes(
  adapter: AciExecutionEnvelopeObservation["adapter"],
  evidence: AciExecutionEnvelopeObservation["runtime_evidence"]
): string[] {
  if (adapter !== "docker_run" && adapter !== "docker_exec") {
    return [];
  }
  if (!isRuntimeEvidenceShape(evidence)) {
    return ["docker_runtime_evidence_missing"];
  }
  const reasons: string[] = [];
  if (
    !evidence.stable
    || evidence.initial_fingerprint !== evidence.final_fingerprint
  ) {
    reasons.push("docker_runtime_boundary_evidence_unstable");
  }
  if (adapter === "docker_run" && evidence.cleanup !== "verified") {
    reasons.push("docker_runtime_cleanup_unverified");
  }
  if (adapter === "docker_run" && !evidence.image_immutable) {
    reasons.push("docker_runtime_image_unverified");
  }
  return reasons;
}

function hasExactBooleanKeys(
  value: unknown,
  keys: readonly string[]
): value is Record<string, boolean> {
  if (!isRecord(value)) {
    return false;
  }
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  return observed.length === expected.length
    && observed.every((key, index) => key === expected[index])
    && expected.every((key) => typeof value[key] === "boolean");
}

function isExecutionPhase(value: unknown): value is AciExecutionEnvelopePhase {
  return ["preflight", "primary", "primary_retry", "supplemental"].includes(String(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function compatibilityObservation(envelopeId: string): AciExecutionEnvelopeObservation {
  return {
    envelope_id: envelopeId,
    adapter: "local_process",
    enforcement: "compatibility",
    environment_allowlist_enforced: false,
    workspace_boundary_enforced: false,
    input_hashes_verified: false,
    timeout_enforced: false,
    network_policy_enforced: false,
    mount_isolation_enforced: false,
    device_policy_enforced: false,
    timed_out: false,
    reason_codes: ["aci_adapter_missing_execution_envelope"]
  };
}

function normalizeDevicePolicy(
  requestedGpuCount: number | undefined,
  visibleGpuDeviceIds: string[] | undefined
): AciExecutionDevicePolicy {
  const count = requestedGpuCount ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("execution_gpu_count_invalid");
  }
  const ids = [...new Set((visibleGpuDeviceIds || []).map((item) => item.trim()).filter(Boolean))];
  if (count === 0) {
    if (ids.length > 0) {
      throw new Error("execution_cpu_policy_has_visible_gpu_devices");
    }
    return { kind: "cpu_only", requestedGpuCount: 0, visibleGpuDeviceIds: [] };
  }
  return {
    kind: "nvidia_gpu",
    requestedGpuCount: count,
    visibleGpuDeviceIds: ids
  };
}

async function collectDependencyBindings(input: {
  workspaceRoot: string;
  cwd: string;
}): Promise<Array<{ path: string; sha256: string }>> {
  const candidates = uniquePaths(
    [input.cwd, input.workspaceRoot].flatMap((root) =>
      DEPENDENCY_LOCK_NAMES.map((name) => path.join(root, name))
    )
  );
  return collectBindings(candidates, input.workspaceRoot);
}

async function collectBindings(
  candidates: string[],
  workspaceRoot: string
): Promise<Array<{ path: string; sha256: string }>> {
  const bindings: Array<{ path: string; sha256: string }> = [];
  for (const candidate of candidates) {
    if (!isPathInsideOrEqual(candidate, workspaceRoot)) {
      throw new Error("execution_artifact_outside_workspace");
    }
    const sha256 = await hashFileIfPresent(candidate);
    if (sha256) {
      bindings.push({ path: candidate, sha256 });
    }
  }
  return bindings;
}

async function collectOutputBindings(
  expectedOutputs: Array<{ path: string; required: boolean }>
): Promise<Array<{ path: string; sha256: string }>> {
  const bindings: Array<{ path: string; sha256: string }> = [];
  for (const output of expectedOutputs) {
    const sha256 = await hashFileIfPresent(output.path);
    if (sha256) {
      bindings.push({ path: output.path, sha256 });
    }
  }
  return bindings;
}

async function hashFileIfPresent(filePath: string): Promise<string | undefined> {
  try {
    const metadata = await fs.lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return undefined;
    }
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

function requireWorkspacePath(candidate: string, workspaceRoot: string, code: string): string {
  const normalized = path.resolve(candidate);
  if (!isPathInsideOrEqual(normalized, workspaceRoot)) {
    throw new Error(code);
  }
  return normalized;
}

function portableBinding(
  binding: { path: string; sha256: string },
  workspaceRoot: string
): ExecutionEnvelopeArtifactBinding {
  return {
    path: toWorkspaceRelative(binding.path, workspaceRoot),
    sha256: binding.sha256
  };
}

function toWorkspaceRelative(candidate: string, workspaceRoot: string): string {
  const relative = path.relative(workspaceRoot, candidate);
  return relative || ".";
}

function toPortableCommand(command: string, workspaceRoot: string): string {
  return command.split(path.resolve(workspaceRoot)).join("${WORKSPACE_ROOT}");
}

function uniquePaths(values: string[]): string[] {
  return [...new Set(values.map((item) => path.resolve(item)))];
}

function normalizeSeeds(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value >= 0))];
}

function isPathInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
