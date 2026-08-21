import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { setPriority as setProcessPriority, tmpdir } from "node:os";

import {
  AgentComputerInterface,
  AciAction,
  AciExecutionEnvelopeObservation,
  AciExecutionEnvelopeRequest,
  AciObservation
} from "./aci.js";
import {
  BUBBLEWRAP_PROBE_ARGS,
  BUBBLEWRAP_STARTED_MARKER,
  buildBubblewrapExecutionPlan,
  resolveBubblewrapDeviceMounts
} from "./bubblewrapExecution.js";
import {
  buildDockerCreateExecutionPlan,
  buildDockerExecutionPlan,
  parseDockerContainerInspection,
  validateDockerExecutionBoundary
} from "./dockerExecution.js";
import { evaluateCommandPolicy, formatPolicyBlockMessage } from "./commandPolicy.js";
import { resolveDockerExecTarget } from "../runtime/executionProfile.js";
import { ensureDir } from "../utils/fs.js";

export interface LocalAciAdapterOptions {
  /** @deprecated Compatibility-only. Network access is no longer gated here. */
  allowNetwork?: boolean;
  envelopeIsolation?: "auto" | "disabled";
  dockerExecutable?: string;
  dockerImage?: string;
  dockerTarget?: string;
  processEnvironment?: NodeJS.ProcessEnv;
}

export class LocalAciAdapter implements AgentComputerInterface {
  constructor(private readonly options: LocalAciAdapterOptions = {}) {}

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
      case "search_code":
        return this.searchCode(
          String(action.input.query || ""),
          asString(action.input.cwd),
          asNumber(action.input.limit),
          asStringArray(action.input.globs)
        );
      case "find_symbol":
        return this.findSymbol(
          String(action.input.symbol || ""),
          asString(action.input.cwd),
          asNumber(action.input.limit),
          asStringArray(action.input.globs)
        );
      case "list_files":
        return this.listFiles(
          asString(action.input.cwd),
          asNumber(action.input.limit),
          asStringArray(action.input.globs)
        );
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
    const patchPath = path.join(cwd || process.cwd(), `.autolabos/tmp_patch_${Date.now()}.diff`);
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
    const decision = evaluateCommandPolicy(command, {
      scope: "command"
    });
    if (!decision.allowed) {
      return blockedObservation(decision);
    }
    return runShell(command, cwd, signal);
  }

  async runTests(command: string, cwd?: string, signal?: AbortSignal): Promise<AciObservation> {
    const decision = evaluateCommandPolicy(command, {
      scope: "tests"
    });
    if (!decision.allowed) {
      return blockedObservation(decision);
    }
    return runShell(command, cwd, signal);
  }

  async runInExecutionEnvelope(
    request: AciExecutionEnvelopeRequest,
    scope: "command" | "tests",
    signal?: AbortSignal
  ): Promise<AciObservation> {
    const started = Date.now();
    const boundary = await validateExecutionEnvelopeBoundary(request);
    if (!boundary.valid) {
      return {
        status: "error",
        stderr: `Execution envelope blocked: ${boundary.reasonCodes.join(",")}`,
        duration_ms: Date.now() - started,
        execution_envelope: buildEnvelopeObservation(request, {
          enforcement: "partial",
          inputHashesVerified: boundary.inputHashesVerified,
          reasonCodes: boundary.reasonCodes
        })
      };
    }

    const decision = evaluateCommandPolicy(request.command, { scope });
    if (!decision.allowed) {
      return {
        ...blockedObservation(decision),
        execution_envelope: buildEnvelopeObservation(request, {
          enforcement: "partial",
          inputHashesVerified: true,
          reasonCodes: ["command_policy_blocked"]
        })
      };
    }

    const environment = buildAllowlistedExecutionEnv(
      this.options.processEnvironment || process.env,
      request.environmentAllowlist,
      request.envelopeId
    );
    if (request.executionProfile === "docker") {
      return runDockerExecutionEnvelope(
        request,
        environment,
        boundary.inputHashesVerified,
        signal,
        this.options
      );
    }
    if ((request.secretFileMounts?.length || 0) > 0) {
      return {
        status: "error",
        stderr: "Execution envelope blocked: secret_file_mount_requires_ephemeral_docker",
        exit_code: 1,
        duration_ms: Date.now() - started,
        execution_envelope: buildEnvelopeObservation(request, {
          enforcement: "partial",
          inputHashesVerified: boundary.inputHashesVerified,
          reasonCodes: ["secret_file_mount_requires_ephemeral_docker"]
        })
      };
    }
    if (request.executionProfile !== "local") {
      return {
        status: "error",
        stderr: `Execution envelope blocked: execution_profile_adapter_not_available`,
        exit_code: 1,
        duration_ms: Date.now() - started,
        execution_envelope: buildEnvelopeObservation(request, {
          enforcement: "partial",
          inputHashesVerified: boundary.inputHashesVerified,
          reasonCodes: ["execution_profile_adapter_not_available"]
        })
      };
    }
    const isolationDecision = await resolveBubblewrapIsolation(
      request,
      this.options.envelopeIsolation
    );
    if (isolationDecision.available) {
      const plan = await buildBubblewrapExecutionPlan(request, environment, {
        devicePaths: isolationDecision.devicePaths
      });
      const isolated = await runExecutable(
        plan.executable,
        plan.args,
        signal,
        {
          env: plan.hostEnvironment,
          timeoutMs: request.timeoutMs
        }
      );
      const sandboxStarted = isolated.stderr?.includes(BUBBLEWRAP_STARTED_MARKER) === true;
      const timedOut = isolated.execution_timed_out === true;
      const postBoundary = sandboxStarted
        ? await validateExecutionEnvelopeBoundary(request)
        : boundary;
      const cleaned = {
        ...isolated,
        stderr: stripBubblewrapMarker(isolated.stderr)
      };
      if (sandboxStarted && postBoundary.valid) {
        return {
          ...cleaned,
          execution_envelope: buildEnvelopeObservation(request, {
            adapter: "bubblewrap",
            enforcement: "enforced",
            inputHashesVerified: true,
            environmentEnforced: true,
            workspaceEnforced: true,
            timeoutEnforced: true,
            networkEnforced: true,
            mountEnforced: true,
            deviceEnforced: true,
            timedOut,
            reasonCodes: timedOut ? ["execution_envelope_timeout"] : []
          })
        };
      }
      return {
        ...cleaned,
        execution_envelope: buildEnvelopeObservation(request, {
          adapter: "bubblewrap",
          enforcement: "partial",
          inputHashesVerified: postBoundary.inputHashesVerified,
          environmentEnforced: sandboxStarted,
          workspaceEnforced: sandboxStarted,
          timeoutEnforced: true,
          networkEnforced: sandboxStarted,
          mountEnforced: sandboxStarted,
          deviceEnforced: sandboxStarted,
          timedOut,
          reasonCodes: [
            sandboxStarted
              ? "execution_boundary_changed_during_execution"
              : "bubblewrap_setup_failed",
            ...postBoundary.reasonCodes,
            ...(timedOut ? ["execution_envelope_timeout"] : [])
          ]
        })
      };
    }
    const observation = await runShell(request.command, request.cwd, signal, {
      env: environment,
      timeoutMs: request.timeoutMs,
      shell: "/bin/sh",
      loginShell: false,
      killProcessGroup: true
    });
    const postBoundary = await validateExecutionEnvelopeBoundary(request);
    const timedOut = observation.execution_timed_out === true;
    const networkEnforced = request.networkPolicy !== "blocked";
    const reasonCodes = [
      isolationDecision.reasonCode,
      ...(!networkEnforced ? ["network_block_not_enforced_by_local_process"] : []),
      "mount_isolation_not_enforced_by_local_process",
      ...(timedOut ? ["execution_envelope_timeout"] : [])
    ];
    return {
      ...observation,
      execution_envelope: buildEnvelopeObservation(request, {
        adapter: "local_process",
        enforcement: "partial",
        inputHashesVerified: postBoundary.inputHashesVerified,
        environmentEnforced: true,
        workspaceEnforced: false,
        timeoutEnforced: true,
        mountEnforced: false,
        deviceEnforced: false,
        networkEnforced,
        timedOut,
        reasonCodes: [
          ...reasonCodes,
          ...(!postBoundary.valid ? ["execution_boundary_changed_during_execution"] : []),
          ...postBoundary.reasonCodes
        ]
      })
    };
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

  async searchCode(
    query: string,
    cwd?: string,
    limit = 20,
    globs = defaultCodeGlobs()
  ): Promise<AciObservation> {
    if (!query.trim()) {
      return {
        status: "error",
        stderr: "Empty search query",
        duration_ms: 0
      };
    }

    const obs = await runProcess(
      "rg",
      [
        "--line-number",
        "--no-heading",
        "--hidden",
        "--no-messages",
        "--color",
        "never",
        "--smart-case",
        "--fixed-strings",
        "--max-count",
        "3",
        ...buildGlobArgs(globs),
        query
      ],
      cwd
    );
    if (isMissingCommand(obs, "rg")) {
      return fallbackSearchCode(query, cwd, limit, globs);
    }
    return limitLines(obs, limit);
  }

  async findSymbol(
    symbol: string,
    cwd?: string,
    limit = 20,
    globs = defaultCodeGlobs()
  ): Promise<AciObservation> {
    if (!symbol.trim()) {
      return {
        status: "error",
        stderr: "Empty symbol query",
        duration_ms: 0
      };
    }

    const obs = await runProcess(
      "rg",
      [
        "--line-number",
        "--no-heading",
        "--hidden",
        "--no-messages",
        "--color",
        "never",
        "--smart-case",
        "-e",
        buildSymbolPattern(symbol),
        ...buildGlobArgs(globs)
      ],
      cwd
    );
    if (isMissingCommand(obs, "rg")) {
      return fallbackFindSymbol(symbol, cwd, limit, globs);
    }
    return limitLines(obs, limit);
  }

  async listFiles(
    cwd?: string,
    limit = 200,
    globs = defaultCodeGlobs()
  ): Promise<AciObservation> {
    const obs = await runProcess(
      "rg",
      [
        "--files",
        "--hidden",
        ...buildGlobArgs(globs)
      ],
      cwd
    );
    if (isMissingCommand(obs, "rg")) {
      return fallbackListFiles(cwd, limit, globs);
    }
    return limitLines(obs, limit);
  }
}

async function runDockerExecutionEnvelope(
  request: AciExecutionEnvelopeRequest,
  environment: NodeJS.ProcessEnv,
  inputHashesVerified: boolean,
  signal: AbortSignal | undefined,
  options: LocalAciAdapterOptions
): Promise<AciObservation> {
  const started = Date.now();
  const hostEnvironment = options.processEnvironment || process.env;
  const executable = options.dockerExecutable || "docker";
  const configuredImage = options.dockerImage || hostEnvironment.AUTOLABOS_DOCKER_IMAGE?.trim();
  if (
    request.containerImage
    && configuredImage
    && request.containerImage !== configuredImage
  ) {
    return dockerRunBlockedObservation(
      request,
      inputHashesVerified,
      started,
      ["docker_image_binding_mismatch"]
    );
  }
  const image = request.containerImage || configuredImage;
  if (image) {
    return runEphemeralDockerExecutionEnvelope(
      request,
      environment,
      inputHashesVerified,
      signal,
      {
        executable,
        image,
        hostEnvironment,
        imageBound: request.containerImage === image,
        imageImmutable: isImmutableDockerImageReference(image)
      }
    );
  }
  if ((request.secretFileMounts?.length || 0) > 0) {
    return dockerRunBlockedObservation(
      request,
      inputHashesVerified,
      started,
      ["secret_file_mount_requires_ephemeral_docker"]
    );
  }
  const target = options.dockerTarget || resolveDockerExecTarget(hostEnvironment);
  const inspectTimeoutMs = Math.min(request.timeoutMs, 5_000);
  const initialObservation = await runExecutable(
    executable,
    ["container", "inspect", target],
    signal,
    { env: hostEnvironment, timeoutMs: inspectTimeoutMs }
  );
  let initialInspection;
  try {
    initialInspection = parseDockerContainerInspection(initialObservation);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "docker_container_inspect_failed";
    return {
      status: "error",
      stderr: [initialObservation.stderr, `Execution envelope blocked: ${reason}`]
        .filter(Boolean)
        .join("\n"),
      exit_code: 1,
      duration_ms: Date.now() - started,
      execution_envelope: buildEnvelopeObservation(request, {
        adapter: "docker_exec",
        enforcement: "partial",
        inputHashesVerified,
        reasonCodes: [reason]
      })
    };
  }
  const initialBoundary = validateDockerExecutionBoundary(request, initialInspection);
  if (!initialBoundary.valid) {
    return {
      status: "error",
      stderr: `Execution envelope blocked: ${initialBoundary.reasonCodes.join(",")}`,
      exit_code: 1,
      duration_ms: Date.now() - started,
      execution_envelope: buildEnvelopeObservation(request, {
        adapter: "docker_exec",
        enforcement: "partial",
        inputHashesVerified,
        reasonCodes: initialBoundary.reasonCodes
      })
    };
  }

  const plan = buildDockerExecutionPlan(request, target, environment, {
    dockerExecutable: executable,
    hostEnvironment
  });
  const executed = await runExecutable(plan.executable, plan.args, signal, {
    env: plan.hostEnvironment,
    timeoutMs: request.timeoutMs
  });
  const timedOut = executed.execution_timed_out === true;
  const postBoundary = await validateExecutionEnvelopeBoundary(request);
  const finalObservation = await runExecutable(
    executable,
    ["container", "inspect", target],
    undefined,
    { env: hostEnvironment, timeoutMs: inspectTimeoutMs }
  );
  let finalBoundaryReasonCodes: string[] = [];
  let stableContainerBoundary = false;
  let finalBoundaryFingerprint = "";
  try {
    const finalInspection = parseDockerContainerInspection(finalObservation);
    const finalBoundary = validateDockerExecutionBoundary(request, finalInspection);
    finalBoundaryFingerprint = finalBoundary.fingerprint;
    finalBoundaryReasonCodes = finalBoundary.reasonCodes;
    stableContainerBoundary = finalBoundary.valid
      && finalBoundary.fingerprint === initialBoundary.fingerprint;
    if (finalBoundary.valid && !stableContainerBoundary) {
      finalBoundaryReasonCodes.push("docker_container_boundary_changed_during_execution");
    }
  } catch (error) {
    finalBoundaryReasonCodes = [
      error instanceof Error ? error.message : "docker_container_post_inspect_failed"
    ];
  }
  const fullyEnforced = stableContainerBoundary && postBoundary.valid;
  return {
    ...executed,
    execution_envelope: buildEnvelopeObservation(request, {
      adapter: "docker_exec",
      enforcement: fullyEnforced ? "enforced" : "partial",
      inputHashesVerified: postBoundary.inputHashesVerified,
      environmentEnforced: true,
      workspaceEnforced: fullyEnforced,
      timeoutEnforced: true,
      networkEnforced: fullyEnforced,
      mountEnforced: fullyEnforced,
      deviceEnforced: fullyEnforced,
      timedOut,
      runtimeEvidence: {
        kind: "docker_boundary_inspection",
        initial_fingerprint: initialBoundary.fingerprint,
        final_fingerprint: finalBoundaryFingerprint,
        stable: stableContainerBoundary,
        cleanup: "not_applicable",
        image_immutable: false
      },
      reasonCodes: [
        ...finalBoundaryReasonCodes,
        ...(!postBoundary.valid ? ["execution_boundary_changed_during_execution"] : []),
        ...postBoundary.reasonCodes,
        ...(timedOut ? ["execution_envelope_timeout"] : [])
      ]
    })
  };
}

async function runEphemeralDockerExecutionEnvelope(
  request: AciExecutionEnvelopeRequest,
  environment: NodeJS.ProcessEnv,
  inputHashesVerified: boolean,
  signal: AbortSignal | undefined,
  runtime: {
    executable: string;
    image: string;
    hostEnvironment: NodeJS.ProcessEnv;
    imageBound: boolean;
    imageImmutable: boolean;
  }
): Promise<AciObservation> {
  const started = Date.now();
  let snapshot;
  try {
    snapshot = await materializeSecretSnapshots(request);
  } catch {
    return dockerRunBlockedObservation(
      request,
      inputHashesVerified,
      started,
      ["execution_secret_snapshot_failed"]
    );
  }
  const observation = await runEphemeralDockerExecutionEnvelopeWithSnapshots(
    snapshot.request,
    environment,
    inputHashesVerified,
    signal,
    runtime
  );
  const cleaned = await removeSecretSnapshotDirectory(snapshot.directory);
  if (cleaned || !observation.execution_envelope) {
    return observation;
  }
  return {
    ...observation,
    execution_envelope: {
      ...observation.execution_envelope,
      enforcement: "partial",
      workspace_boundary_enforced: false,
      mount_isolation_enforced: false,
      reason_codes: [
        ...observation.execution_envelope.reason_codes,
        "execution_secret_snapshot_cleanup_failed"
      ]
    }
  };
}

async function runEphemeralDockerExecutionEnvelopeWithSnapshots(
  request: AciExecutionEnvelopeRequest,
  environment: NodeJS.ProcessEnv,
  inputHashesVerified: boolean,
  signal: AbortSignal | undefined,
  runtime: {
    executable: string;
    image: string;
    hostEnvironment: NodeJS.ProcessEnv;
    imageBound: boolean;
    imageImmutable: boolean;
  }
): Promise<AciObservation> {
  const started = Date.now();
  const inspectTimeoutMs = Math.min(request.timeoutMs, 5_000);
  let plan;
  try {
    plan = buildDockerCreateExecutionPlan(request, runtime.image, environment, {
      dockerExecutable: runtime.executable,
      hostEnvironment: runtime.hostEnvironment
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "docker_container_plan_invalid";
    return dockerRunBlockedObservation(request, inputHashesVerified, started, [reason]);
  }
  const cleanup = async () => runExecutable(
    runtime.executable,
    ["container", "rm", "--force", plan.containerName],
    undefined,
    { env: runtime.hostEnvironment, timeoutMs: inspectTimeoutMs }
  );
  const created = await runExecutable(plan.executable, plan.args, signal, {
    env: plan.hostEnvironment,
    timeoutMs: inspectTimeoutMs
  });
  if (created.status !== "ok") {
    const removed = await cleanup();
    return {
      ...dockerRunBlockedObservation(
        request,
        inputHashesVerified,
        started,
        [
          "docker_container_create_failed",
          "docker_container_create_state_ambiguous",
          ...(removed.status === "ok" ? [] : ["docker_container_cleanup_failed"])
        ]
      ),
      stderr: [created.stderr, "Execution envelope blocked: docker_container_create_failed"]
        .filter(Boolean)
        .join("\n")
    };
  }

  const inspect = async () => runExecutable(
    runtime.executable,
    ["container", "inspect", plan.containerName],
    undefined,
    { env: runtime.hostEnvironment, timeoutMs: inspectTimeoutMs }
  );
  const initialObservation = await inspect();
  let initialBoundary;
  try {
    initialBoundary = validateDockerExecutionBoundary(
      request,
      parseDockerContainerInspection(initialObservation),
      { expectedState: "stopped" }
    );
  } catch (error) {
    const removed = await cleanup();
    const reason = error instanceof Error ? error.message : "docker_container_inspect_failed";
    return dockerRunBlockedObservation(request, inputHashesVerified, started, [
      reason,
      ...(removed.status === "ok" ? [] : ["docker_container_cleanup_failed"])
    ]);
  }
  if (!initialBoundary.valid) {
    const removed = await cleanup();
    return dockerRunBlockedObservation(
      request,
      inputHashesVerified,
      started,
      [
        ...initialBoundary.reasonCodes,
        ...(removed.status === "ok" ? [] : ["docker_container_cleanup_failed"])
      ]
    );
  }

  const executed = await runExecutable(
    runtime.executable,
    ["start", "--attach", plan.containerName],
    signal,
    { env: runtime.hostEnvironment, timeoutMs: request.timeoutMs }
  );
  const timedOut = executed.execution_timed_out === true;
  const postBoundary = await validateExecutionEnvelopeBoundary(request);
  const finalObservation = await inspect();
  const reasonCodes: string[] = [];
  let stableContainerBoundary = false;
  let finalBoundaryFingerprint = "";
  try {
    const finalBoundary = validateDockerExecutionBoundary(
      request,
      parseDockerContainerInspection(finalObservation),
      { expectedState: "stopped" }
    );
    finalBoundaryFingerprint = finalBoundary.fingerprint;
    reasonCodes.push(...finalBoundary.reasonCodes);
    stableContainerBoundary = finalBoundary.valid
      && finalBoundary.fingerprint === initialBoundary.fingerprint;
    if (finalBoundary.valid && !stableContainerBoundary) {
      reasonCodes.push("docker_container_boundary_changed_during_execution");
    }
  } catch (error) {
    reasonCodes.push(
      error instanceof Error ? error.message : "docker_container_post_inspect_failed"
    );
  }
  const removed = await cleanup();
  if (removed.status !== "ok") {
    reasonCodes.push("docker_container_cleanup_failed");
  }
  if (!postBoundary.valid) {
    reasonCodes.push("execution_boundary_changed_during_execution", ...postBoundary.reasonCodes);
  }
  if (timedOut) {
    reasonCodes.push("execution_envelope_timeout");
  }
  if (!runtime.imageBound) {
    reasonCodes.push("docker_image_not_bound");
  }
  if (!runtime.imageImmutable) {
    reasonCodes.push("docker_image_not_immutable");
  }
  const fullyEnforced = stableContainerBoundary
    && postBoundary.valid
    && removed.status === "ok"
    && runtime.imageBound
    && runtime.imageImmutable
    && !timedOut;
  return {
    ...executed,
    execution_envelope: buildEnvelopeObservation(request, {
      adapter: "docker_run",
      enforcement: fullyEnforced ? "enforced" : "partial",
      inputHashesVerified: postBoundary.inputHashesVerified,
      environmentEnforced: true,
      workspaceEnforced: fullyEnforced,
      timeoutEnforced: true,
      networkEnforced: fullyEnforced,
      mountEnforced: fullyEnforced,
      deviceEnforced: fullyEnforced,
      timedOut,
      runtimeEvidence: {
        kind: "docker_boundary_inspection",
        initial_fingerprint: initialBoundary.fingerprint,
        final_fingerprint: finalBoundaryFingerprint,
        stable: stableContainerBoundary,
        cleanup: removed.status === "ok" ? "verified" : "failed",
        image_immutable: runtime.imageImmutable
      },
      reasonCodes
    })
  };
}

async function materializeSecretSnapshots(
  request: AciExecutionEnvelopeRequest
): Promise<{ request: AciExecutionEnvelopeRequest; directory?: string }> {
  const secrets = request.secretFileMounts || [];
  if (secrets.length === 0) {
    return { request };
  }
  const directory = await fs.mkdtemp(path.join(tmpdir(), "autolabos-secret-snapshot-"));
  await fs.chmod(directory, 0o700);
  try {
    const snapshots = [];
    for (const secret of secrets) {
      const source = await fs.open(
        secret.sourcePath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
      );
      let content: Buffer;
      try {
        const metadata = await source.stat();
        const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
        if (
          !metadata.isFile()
          || (metadata.mode & 0o077) !== 0
          || (currentUid !== undefined && metadata.uid !== currentUid)
        ) {
          throw new Error("execution_secret_snapshot_source_invalid");
        }
        content = await source.readFile();
      } finally {
        await source.close();
      }
      const digest = createHash("sha256").update(content).digest("hex");
      if (digest !== secret.sourceSha256) {
        throw new Error("execution_secret_snapshot_hash_mismatch");
      }
      const snapshotPath = path.join(directory, path.basename(secret.targetPath));
      const destination = await fs.open(
        snapshotPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o400
      );
      try {
        await destination.writeFile(content);
        await destination.sync();
      } finally {
        await destination.close();
      }
      snapshots.push({
        ...secret,
        sourcePath: snapshotPath
      });
    }
    return {
      request: { ...request, secretFileMounts: snapshots },
      directory
    };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeSecretSnapshotDirectory(directory?: string): Promise<boolean> {
  if (!directory) {
    return true;
  }
  try {
    await fs.rm(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function isImmutableDockerImageReference(image: string): boolean {
  return /^sha256:[a-f0-9]{64}$/iu.test(image)
    || /@sha256:[a-f0-9]{64}$/iu.test(image);
}

function dockerRunBlockedObservation(
  request: AciExecutionEnvelopeRequest,
  inputHashesVerified: boolean,
  started: number,
  reasonCodes: string[]
): AciObservation {
  return {
    status: "error",
    stderr: `Execution envelope blocked: ${reasonCodes.join(",")}`,
    exit_code: 1,
    duration_ms: Date.now() - started,
    execution_envelope: buildEnvelopeObservation(request, {
      adapter: "docker_run",
      enforcement: "partial",
      inputHashesVerified,
      reasonCodes
    })
  };
}

function runShell(
  command: string,
  cwd?: string,
  signal?: AbortSignal,
  options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    shell?: string;
    loginShell?: boolean;
    killProcessGroup?: boolean;
  }
): Promise<AciObservation> {
  const started = Date.now();
  return new Promise((resolve) => {
    const shellFlag = options?.loginShell === false ? "-c" : "-lc";
    const killProcessGroup = options?.killProcessGroup === true && process.platform !== "win32";
    const child = spawn(options?.shell || process.env.SHELL || "/bin/sh", [shellFlag, command], {
      cwd: cwd || process.cwd(),
      env: options?.env || buildManagedExecutionEnv(process.env),
      detached: killProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
      signal
    });
    lowerChildPriority(child.pid);

    let stdout = "";
    let stderr = "";
    let settled = false;
    let exitFallbackTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const settle = (code: number | null, fallbackStderr?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (exitFallbackTimer) {
        clearTimeout(exitFallbackTimer);
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      resolve({
        status: code === 0 ? "ok" : "error",
        stdout,
        stderr: fallbackStderr ? [stderr, fallbackStderr].filter(Boolean).join("\n") : stderr,
        exit_code: code ?? 1,
        duration_ms: Date.now() - started,
        execution_timed_out: timedOut
      });
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (exitFallbackTimer) {
        clearTimeout(exitFallbackTimer);
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      resolve({
        status: "error",
        stderr: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - started
      });
    });
    child.on("exit", (code, signalName) => {
      exitFallbackTimer = setTimeout(() => {
        settle(
          code,
          [
            signalName
              ? `Command process exited after signal ${signalName}, but stdio close did not arrive.`
              : undefined,
            timedOut ? "execution_envelope_timeout" : undefined
          ].filter(Boolean).join("\n") || undefined
        );
      }, 1_000);
      exitFallbackTimer.unref?.();
    });
    child.on("close", (code) => {
      settle(code, timedOut ? "execution_envelope_timeout" : undefined);
    });
    if (options?.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateChild(child, "SIGTERM", killProcessGroup);
        const forceTimer = setTimeout(() => terminateChild(child, "SIGKILL", killProcessGroup), 1_000);
        forceTimer.unref?.();
      }, options.timeoutMs);
      timeoutTimer.unref?.();
    }
  });
}

function runExecutable(
  executable: string,
  args: string[],
  signal?: AbortSignal,
  options?: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }
): Promise<AciObservation> {
  const started = Date.now();
  return new Promise((resolve) => {
    const killProcessGroup = process.platform !== "win32";
    const child = spawn(executable, args, {
      env: options?.env,
      detached: killProcessGroup,
      stdio: ["ignore", "pipe", "pipe"],
      signal
    });
    lowerChildPriority(child.pid);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const settle = (code: number | null, spawnError?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      resolve({
        status: code === 0 ? "ok" : "error",
        stdout,
        stderr: [stderr, spawnError, timedOut ? "execution_envelope_timeout" : undefined]
          .filter(Boolean)
          .join("\n"),
        exit_code: code ?? 1,
        duration_ms: Date.now() - started,
        execution_timed_out: timedOut
      });
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => settle(1, error instanceof Error ? error.message : String(error)));
    child.on("close", (code) => settle(code));
    if (options?.timeoutMs && options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateChild(child, "SIGTERM", killProcessGroup);
        const forceTimer = setTimeout(() => terminateChild(child, "SIGKILL", killProcessGroup), 1_000);
        forceTimer.unref?.();
      }, options.timeoutMs);
      timeoutTimer.unref?.();
    }
  });
}

function terminateChild(
  child: ChildProcess,
  signal: NodeJS.Signals,
  processGroup: boolean
): void {
  if (processGroup && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may have exited between the timer and the signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Best-effort cleanup after an already-settled child.
  }
}

function buildManagedExecutionEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    OMP_NUM_THREADS: baseEnv.OMP_NUM_THREADS || "1",
    MKL_NUM_THREADS: baseEnv.MKL_NUM_THREADS || "1",
    OPENBLAS_NUM_THREADS: baseEnv.OPENBLAS_NUM_THREADS || "1",
    NUMEXPR_NUM_THREADS: baseEnv.NUMEXPR_NUM_THREADS || "1",
    TOKENIZERS_PARALLELISM: baseEnv.TOKENIZERS_PARALLELISM || "false",
    MALLOC_ARENA_MAX: baseEnv.MALLOC_ARENA_MAX || "2"
  };
}

const BLOCKED_ENV_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/iu;

function buildAllowlistedExecutionEnv(
  baseEnv: NodeJS.ProcessEnv,
  allowlist: string[],
  envelopeId: string
): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of [...new Set(allowlist)]) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name) || BLOCKED_ENV_NAME.test(name)) {
      continue;
    }
    const value = baseEnv[name];
    if (typeof value === "string") {
      selected[name] = value;
    }
  }
  return buildManagedExecutionEnv({
    ...selected,
    AUTOLABOS_EXECUTION_ENVELOPE_ID: envelopeId
  });
}

async function validateExecutionEnvelopeBoundary(
  request: AciExecutionEnvelopeRequest
): Promise<{
  valid: boolean;
  inputHashesVerified: boolean;
  reasonCodes: string[];
}> {
  const reasonCodes: string[] = [];
  const workspaceRoot = await fs.realpath(request.workspaceRoot).catch(() => undefined);
  const cwd = await fs.realpath(request.cwd).catch(() => undefined);
  if (!workspaceRoot) {
    reasonCodes.push("workspace_root_missing");
  }
  if (!cwd) {
    reasonCodes.push("execution_cwd_missing");
  }
  if (workspaceRoot && cwd && !isPathInsideOrEqual(cwd, workspaceRoot)) {
    reasonCodes.push("execution_cwd_outside_workspace");
  }
  const canonicalWritableRoots: string[] = [];
  for (const writableRoot of request.writableRoots) {
    const normalized = await fs.realpath(writableRoot).catch(() => undefined);
    if (!normalized) {
      reasonCodes.push("writable_root_missing");
      break;
    }
    if (!workspaceRoot || !isPathInsideOrEqual(normalized, workspaceRoot)) {
      reasonCodes.push("writable_root_outside_workspace");
      break;
    }
    canonicalWritableRoots.push(normalized);
  }
  for (const output of request.expectedOutputs) {
    const normalized = path.resolve(output.path);
    const canonicalBoundary = await realpathNearestExisting(normalized);
    const insideDeclaredRoot = request.writableRoots.some((root) =>
      isPathInsideOrEqual(normalized, path.resolve(root))
    );
    const insideCanonicalRoot = canonicalBoundary !== undefined
      && canonicalWritableRoots.some((root) => isPathInsideOrEqual(canonicalBoundary, root));
    if (!insideDeclaredRoot || !insideCanonicalRoot) {
      reasonCodes.push("expected_output_outside_writable_roots");
      break;
    }
  }
  for (const secret of request.secretFileMounts || []) {
    const [realPath, metadata] = await Promise.all([
      fs.realpath(secret.sourcePath).catch(() => undefined),
      fs.lstat(secret.sourcePath).catch(() => undefined)
    ]);
    const sourceSha256 = realPath && metadata?.isFile()
      ? await hashFile(realPath).catch(() => undefined)
      : undefined;
    if (
      !realPath
      || realPath !== path.resolve(secret.sourcePath)
      || !metadata?.isFile()
      || metadata.isSymbolicLink()
      || isPathInsideOrEqual(path.resolve(secret.sourcePath), path.resolve(request.workspaceRoot))
      || (metadata.mode & 0o077) !== 0
      || (
        typeof process.getuid === "function"
        && metadata.uid !== process.getuid()
      )
      || !/^\/run\/secrets\/[a-z0-9][a-z0-9._-]*$/iu.test(secret.targetPath)
      || !/^[a-f0-9]{64}$/u.test(secret.sourceSha256)
      || sourceSha256 !== secret.sourceSha256
    ) {
      reasonCodes.push("execution_secret_file_invalid");
      break;
    }
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    reasonCodes.push("execution_timeout_invalid");
  }
  if (request.environmentAllowlist.some((name) => BLOCKED_ENV_NAME.test(name))) {
    reasonCodes.push("sensitive_environment_name_not_allowed");
  }
  if (
    request.devicePolicy.kind === "cpu_only"
    && (
      request.devicePolicy.requestedGpuCount !== 0
      || request.devicePolicy.visibleGpuDeviceIds.length > 0
    )
  ) {
    reasonCodes.push("execution_cpu_device_policy_invalid");
  }
  if (
    request.devicePolicy.kind === "nvidia_gpu"
    && (
      !Number.isSafeInteger(request.devicePolicy.requestedGpuCount)
      || request.devicePolicy.requestedGpuCount <= 0
      || request.devicePolicy.visibleGpuDeviceIds.length > request.devicePolicy.requestedGpuCount
      || new Set(request.devicePolicy.visibleGpuDeviceIds).size
        !== request.devicePolicy.visibleGpuDeviceIds.length
    )
  ) {
    reasonCodes.push("execution_nvidia_device_policy_invalid");
  }
  if (hashText(toPortableCommand(request.command, request.workspaceRoot)) !== request.commandSha256) {
    reasonCodes.push("execution_command_hash_mismatch");
  }

  let inputHashesVerified = true;
  for (const artifact of [...request.inputArtifacts, ...request.dependencyArtifacts]) {
    const artifactPath = path.resolve(artifact.path);
    const canonicalArtifactPath = await fs.realpath(artifactPath).catch(() => undefined);
    if (
      !workspaceRoot
      || !canonicalArtifactPath
      || !isPathInsideOrEqual(canonicalArtifactPath, workspaceRoot)
    ) {
      reasonCodes.push("input_artifact_outside_workspace");
      inputHashesVerified = false;
      break;
    }
    const observed = await hashFile(artifactPath).catch(() => undefined);
    if (!observed || observed !== artifact.sha256) {
      reasonCodes.push("input_artifact_hash_mismatch");
      inputHashesVerified = false;
      break;
    }
  }
  return {
    valid: reasonCodes.length === 0,
    inputHashesVerified,
    reasonCodes: [...new Set(reasonCodes)]
  };
}

async function realpathNearestExisting(candidate: string): Promise<string | undefined> {
  let current = path.resolve(candidate);
  while (true) {
    const resolved = await fs.realpath(current).catch(() => undefined);
    if (resolved) {
      return resolved;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function buildEnvelopeObservation(
  request: AciExecutionEnvelopeRequest,
  input: {
    adapter?: AciExecutionEnvelopeObservation["adapter"];
    enforcement: AciExecutionEnvelopeObservation["enforcement"];
    inputHashesVerified: boolean;
    environmentEnforced?: boolean;
    workspaceEnforced?: boolean;
    timeoutEnforced?: boolean;
    networkEnforced?: boolean;
    mountEnforced?: boolean;
    deviceEnforced?: boolean;
    timedOut?: boolean;
    runtimeEvidence?: AciExecutionEnvelopeObservation["runtime_evidence"];
    reasonCodes: string[];
  }
): AciExecutionEnvelopeObservation {
  return {
    envelope_id: request.envelopeId,
    adapter: input.adapter || "local_process",
    enforcement: input.enforcement,
    environment_allowlist_enforced: input.environmentEnforced === true,
    workspace_boundary_enforced: input.workspaceEnforced === true,
    input_hashes_verified: input.inputHashesVerified,
    timeout_enforced: input.timeoutEnforced === true,
    network_policy_enforced: input.networkEnforced === true,
    mount_isolation_enforced: input.mountEnforced === true,
    device_policy_enforced: input.deviceEnforced === true,
    timed_out: input.timedOut === true,
    ...(input.runtimeEvidence ? { runtime_evidence: input.runtimeEvidence } : {}),
    reason_codes: [...new Set(input.reasonCodes)]
  };
}

let bubblewrapProbe: Promise<boolean> | undefined;

async function resolveBubblewrapIsolation(
  request: AciExecutionEnvelopeRequest,
  mode: LocalAciAdapterOptions["envelopeIsolation"] = "auto"
): Promise<{ available: boolean; reasonCode: string; devicePaths: string[] }> {
  if (mode === "disabled") {
    return { available: false, reasonCode: "isolated_execution_disabled", devicePaths: [] };
  }
  if (request.executionProfile !== "local") {
    return {
      available: false,
      reasonCode: "isolated_execution_profile_not_supported",
      devicePaths: []
    };
  }
  const deviceMounts = await resolveBubblewrapDeviceMounts(request.devicePolicy);
  if (!deviceMounts.valid) {
    return {
      available: false,
      reasonCode: deviceMounts.reasonCode || "isolated_execution_gpu_device_policy_invalid",
      devicePaths: []
    };
  }
  bubblewrapProbe ||= runExecutable("bwrap", BUBBLEWRAP_PROBE_ARGS, undefined, {
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    timeoutMs: 2_000
  }).then((observation) => observation.status === "ok");
  return await bubblewrapProbe
    ? { available: true, reasonCode: "bubblewrap_available", devicePaths: deviceMounts.devicePaths }
    : { available: false, reasonCode: "bubblewrap_probe_failed", devicePaths: [] };
}

function stripBubblewrapMarker(stderr: string | undefined): string | undefined {
  if (!stderr) {
    return stderr;
  }
  const cleaned = stderr
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== BUBBLEWRAP_STARTED_MARKER)
    .join("\n")
    .trim();
  return cleaned || undefined;
}

function isPathInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toPortableCommand(command: string, workspaceRoot: string): string {
  return command.split(path.resolve(workspaceRoot)).join("${WORKSPACE_ROOT}");
}

function lowerChildPriority(pid?: number): void {
  if (typeof pid !== "number" || pid <= 0) {
    return;
  }
  try {
    setProcessPriority(pid, 10);
  } catch {
    // Best-effort only: command execution should continue even when niceness cannot be changed.
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string");
}

function defaultCodeGlobs(): string[] {
  return [
    "*.ts",
    "*.tsx",
    "*.js",
    "*.jsx",
    "*.mjs",
    "*.cjs",
    "*.json",
    "*.yaml",
    "*.yml",
    "*.md",
    "*.py",
    "*.sh",
    "!.git",
    "!node_modules",
    "!dist",
    "!.autolabos",
    "!web/dist",
    "!coverage"
  ];
}

function buildGlobArgs(globs: string[]): string[] {
  return globs.flatMap((glob) => ["--glob", glob]);
}

function isMissingCommand(obs: AciObservation, command: string): boolean {
  return obs.status === "error" && typeof obs.stderr === "string" && obs.stderr.includes(`spawn ${command} ENOENT`);
}

function buildSymbolPattern(symbol: string): string {
  const escaped = escapeRegex(symbol.trim());
  return [
    `\\b(?:class|def|function|interface|type|enum)\\s+${escaped}\\b`,
    `\\b(?:const|let|var)\\s+${escaped}\\b`,
    `\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?\\(`,
    `\\b${escaped}\\b`
  ].join("|");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function limitLines(obs: AciObservation, limit: number): AciObservation {
  if (obs.status !== "ok" || !obs.stdout || limit <= 0) {
    return obs;
  }
  const lines = obs.stdout
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, limit);
  return {
    ...obs,
    stdout: lines.join("\n")
  };
}

async function fallbackSearchCode(
  query: string,
  cwd?: string,
  limit = 20,
  globs = defaultCodeGlobs()
): Promise<AciObservation> {
  const started = Date.now();
  try {
    const workspaceRoot = cwd || process.cwd();
    const files = await collectFallbackFiles(workspaceRoot, globs);
    const matches: string[] = [];
    const artifacts = new Set<string>();
    const matcher = buildFixedStringMatcher(query);

    for (const relativePath of files) {
      const filePath = path.join(workspaceRoot, relativePath);
      const text = await safeReadText(filePath);
      if (text === undefined) {
        continue;
      }
      let matchesInFile = 0;
      for (const [index, line] of text.split(/\r?\n/u).entries()) {
        if (!matcher(line)) {
          continue;
        }
        matches.push(`${relativePath}:${index + 1}:${line.slice(0, 220)}`);
        artifacts.add(filePath);
        matchesInFile += 1;
        if (matches.length >= limit || matchesInFile >= 3) {
          break;
        }
      }
      if (matches.length >= limit) {
        break;
      }
    }

    return {
      status: "ok",
      stdout: matches.join("\n"),
      artifacts: [...artifacts],
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

async function fallbackFindSymbol(
  symbol: string,
  cwd?: string,
  limit = 20,
  globs = defaultCodeGlobs()
): Promise<AciObservation> {
  const started = Date.now();
  try {
    const workspaceRoot = cwd || process.cwd();
    const files = await collectFallbackFiles(workspaceRoot, globs);
    const matches: string[] = [];
    const artifacts = new Set<string>();
    const regex = new RegExp(buildSymbolPattern(symbol), hasUppercase(symbol) ? "u" : "iu");

    for (const relativePath of files) {
      const filePath = path.join(workspaceRoot, relativePath);
      const text = await safeReadText(filePath);
      if (text === undefined) {
        continue;
      }
      for (const [index, line] of text.split(/\r?\n/u).entries()) {
        if (!regex.test(line)) {
          continue;
        }
        matches.push(`${relativePath}:${index + 1}:${line.slice(0, 220)}`);
        artifacts.add(filePath);
        if (matches.length >= limit) {
          break;
        }
      }
      if (matches.length >= limit) {
        break;
      }
    }

    return {
      status: "ok",
      stdout: matches.join("\n"),
      artifacts: [...artifacts],
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

async function fallbackListFiles(
  cwd?: string,
  limit = 200,
  globs = defaultCodeGlobs()
): Promise<AciObservation> {
  const started = Date.now();
  try {
    const workspaceRoot = cwd || process.cwd();
    const files = await collectFallbackFiles(workspaceRoot, globs);
    return {
      status: "ok",
      stdout: files.slice(0, Math.max(0, limit)).join("\n"),
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

async function collectFallbackFiles(workspaceRoot: string, globs: string[]): Promise<string[]> {
  const includeGlobs = globs.filter((glob) => !glob.startsWith("!"));
  const excludeGlobs = globs
    .filter((glob) => glob.startsWith("!"))
    .map((glob) => glob.slice(1));
  const files: string[] = [];

  async function walk(relativeDir = ""): Promise<void> {
    const currentDir = relativeDir ? path.join(workspaceRoot, relativeDir) : workspaceRoot;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = normalizeRelativePath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
      if (entry.isDirectory()) {
        if (matchesAnyGlob(relativePath, excludeGlobs)) {
          continue;
        }
        await walk(relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (matchesAnyGlob(relativePath, excludeGlobs)) {
        continue;
      }
      if (includeGlobs.length > 0 && !matchesAnyGlob(relativePath, includeGlobs)) {
        continue;
      }
      files.push(relativePath);
    }
  }

  await walk();
  return files;
}

function matchesAnyGlob(relativePath: string, globs: string[]): boolean {
  return globs.some((glob) => matchesGlob(relativePath, glob));
}

function matchesGlob(relativePath: string, glob: string): boolean {
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedGlob = normalizeRelativePath(glob);

  if (!normalizedGlob.includes("*")) {
    return (
      normalizedPath === normalizedGlob ||
      normalizedPath.startsWith(`${normalizedGlob}/`) ||
      normalizedPath.split("/").includes(normalizedGlob)
    );
  }

  const target = normalizedGlob.includes("/") ? normalizedPath : path.posix.basename(normalizedPath);
  return globToRegExp(normalizedGlob).test(target);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`, "u");
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function buildFixedStringMatcher(query: string): (line: string) => boolean {
  if (hasUppercase(query)) {
    return (line) => line.includes(query);
  }
  const lowerQuery = query.toLowerCase();
  return (line) => line.toLowerCase().includes(lowerQuery);
}

function hasUppercase(value: string): boolean {
  return /[A-Z]/u.test(value);
}

async function safeReadText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function runProcess(
  command: string,
  args: string[],
  cwd?: string,
  signal?: AbortSignal
): Promise<AciObservation> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      signal
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let exitFallbackTimer: NodeJS.Timeout | undefined;
    const settle = (code: number | null, fallbackStderr?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      if (exitFallbackTimer) {
        clearTimeout(exitFallbackTimer);
      }
      resolve({
        status: code === 0 ? "ok" : "error",
        stdout,
        stderr: fallbackStderr ? [stderr, fallbackStderr].filter(Boolean).join("\n") : stderr,
        exit_code: code ?? 1,
        duration_ms: Date.now() - started
      });
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (exitFallbackTimer) {
        clearTimeout(exitFallbackTimer);
      }
      resolve({
        status: "error",
        stderr: error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - started
      });
    });
    child.on("exit", (code, signalName) => {
      exitFallbackTimer = setTimeout(() => {
        settle(
          code,
          signalName
            ? `Command process exited after signal ${signalName}, but stdio close did not arrive.`
            : undefined
        );
      }, 1_000);
      exitFallbackTimer.unref?.();
    });
    child.on("close", (code) => {
      settle(code);
    });
  });
}

function blockedObservation(
  decision: ReturnType<typeof evaluateCommandPolicy>
): AciObservation {
  return {
    status: "error",
    stderr: formatPolicyBlockMessage(decision),
    exit_code: 126,
    policy: decision,
    duration_ms: 0
  };
}
