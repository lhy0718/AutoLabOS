import type { CommandPolicyDecision } from "./commandPolicy.js";
import type { ExecutionProfile } from "../types.js";

export type AciActionType =
  | "read_file"
  | "write_file"
  | "apply_patch"
  | "run_command"
  | "run_tests"
  | "tail_logs"
  | "search_code"
  | "find_symbol"
  | "list_files";

export interface AciAction {
  type: AciActionType;
  input: Record<string, unknown>;
}

export interface AciObservation {
  status: "ok" | "error";
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  artifacts?: string[];
  policy?: CommandPolicyDecision;
  duration_ms: number;
  execution_timed_out?: boolean;
  execution_envelope?: AciExecutionEnvelopeObservation;
}

export type AciExecutionEnvelopePhase =
  | "preflight"
  | "primary"
  | "primary_retry"
  | "supplemental";

export interface AciExecutionArtifactBinding {
  path: string;
  sha256: string;
}

export interface AciExecutionExpectedOutput {
  path: string;
  required: boolean;
}

export type AciExecutionDevicePolicy =
  | {
      kind: "cpu_only";
      requestedGpuCount: 0;
      visibleGpuDeviceIds: [];
    }
  | {
      kind: "nvidia_gpu";
      requestedGpuCount: number;
      visibleGpuDeviceIds: string[];
    };

export interface AciExecutionEnvelopeRequest {
  version: 1;
  envelopeId: string;
  runId: string;
  phase: AciExecutionEnvelopePhase;
  attempt: number;
  executionProfile: ExecutionProfile;
  containerImage?: string;
  command: string;
  commandSha256: string;
  workspaceRoot: string;
  cwd: string;
  writableRoots: string[];
  secretFileMounts?: Array<{
    sourcePath: string;
    targetPath: string;
    required: boolean;
    sourceSha256: string;
  }>;
  environmentAllowlist: string[];
  devicePolicy: AciExecutionDevicePolicy;
  networkPolicy: "blocked" | "declared" | "required";
  networkPurpose?: string;
  timeoutMs: number;
  inputArtifacts: AciExecutionArtifactBinding[];
  dependencyArtifacts: AciExecutionArtifactBinding[];
  expectedOutputs: AciExecutionExpectedOutput[];
}

export interface AciExecutionEnvelopeObservation {
  envelope_id: string;
  adapter: "local_process" | "bubblewrap" | "docker_exec" | "docker_run";
  enforcement: "enforced" | "partial" | "compatibility";
  environment_allowlist_enforced: boolean;
  workspace_boundary_enforced: boolean;
  input_hashes_verified: boolean;
  timeout_enforced: boolean;
  network_policy_enforced: boolean;
  mount_isolation_enforced: boolean;
  device_policy_enforced: boolean;
  timed_out: boolean;
  runtime_evidence?: {
    kind: "docker_boundary_inspection";
    initial_fingerprint: string;
    final_fingerprint: string;
    stable: boolean;
    cleanup: "verified" | "not_applicable" | "failed";
    image_immutable: boolean;
  };
  reason_codes: string[];
}

export interface AgentComputerInterface {
  perform(action: AciAction): Promise<AciObservation>;

  readFile(filePath: string): Promise<AciObservation>;
  writeFile(filePath: string, content: string): Promise<AciObservation>;
  applyPatch(diff: string, cwd?: string): Promise<AciObservation>;
  runCommand(command: string, cwd?: string, signal?: AbortSignal): Promise<AciObservation>;
  runTests(command: string, cwd?: string, signal?: AbortSignal): Promise<AciObservation>;
  runInExecutionEnvelope?(
    request: AciExecutionEnvelopeRequest,
    scope: "command" | "tests",
    signal?: AbortSignal
  ): Promise<AciObservation>;
  tailLogs(filePath: string, lines?: number): Promise<AciObservation>;
  searchCode(
    query: string,
    cwd?: string,
    limit?: number,
    globs?: string[]
  ): Promise<AciObservation>;
  findSymbol(
    symbol: string,
    cwd?: string,
    limit?: number,
    globs?: string[]
  ): Promise<AciObservation>;
  listFiles(
    cwd?: string,
    limit?: number,
    globs?: string[]
  ): Promise<AciObservation>;
}
