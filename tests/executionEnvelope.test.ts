import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  auditExecutionEnvelopeArtifacts,
  buildExecutionEnvelope,
  executeInEnvelope
} from "../src/core/experiments/executionEnvelope.js";
import { buildBubblewrapExecutionPlan } from "../src/tools/bubblewrapExecution.js";
import { hashCanonical } from "../src/core/canonicalHash.js";
import { LocalAciAdapter } from "../src/tools/aciLocalAdapter.js";
import type {
  AciExecutionEnvelopeObservation,
  AciExecutionEnvelopeRequest
} from "../src/tools/aci.js";

const originalVisibleValue = process.env.AUTOLABOS_TEST_VISIBLE;
const originalPrivateValue = process.env.AUTOLABOS_TEST_PRIVATE_TOKEN;

function stableDockerRuntimeEvidence(): NonNullable<
  AciExecutionEnvelopeObservation["runtime_evidence"]
> {
  return {
    kind: "docker_boundary_inspection",
    initial_fingerprint: "a".repeat(64),
    final_fingerprint: "a".repeat(64),
    stable: true,
    cleanup: "verified",
    image_immutable: true
  };
}

afterEach(() => {
  restoreEnv("AUTOLABOS_TEST_VISIBLE", originalVisibleValue);
  restoreEnv("AUTOLABOS_TEST_PRIVATE_TOKEN", originalPrivateValue);
});

describe("execution envelope", () => {
  it("binds portable inputs, dependency locks, limits, and expected outputs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-build-"));
    const runDir = path.join(workspace, ".autolabos", "runs", "fixture-run");
    const experimentDir = path.join(workspace, "experiment");
    const scriptPath = path.join(experimentDir, "run_configured_experiment.py");
    const metricsPath = path.join(runDir, "metrics.json");
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(experimentDir, { recursive: true });
    await fs.writeFile(scriptPath, "print('fixture')\n", "utf8");
    await fs.writeFile(path.join(experimentDir, "requirements.txt"), "example-package==1.0\n", "utf8");

    const built = await buildExecutionEnvelope({
      workspaceRoot: workspace,
      runId: "fixture-run",
      phase: "primary",
      attempt: 1,
      executionProfile: "local",
      command: "python3 run_configured_experiment.py",
      cwd: experimentDir,
      writableRoots: [experimentDir, runDir],
      expectedOutputs: [{ path: metricsPath, required: true }],
      inputArtifactPaths: [scriptPath],
      timeoutMs: 30_000,
      networkPolicy: "blocked",
      seeds: [17, 17, -1]
    });

    expect(built.artifact).toMatchObject({
      version: 1,
      run_id: "fixture-run",
      phase: "primary",
      attempt: 1,
      cwd: "experiment",
      writable_roots: ["experiment", ".autolabos/runs/fixture-run"],
      limits: { timeout_ms: 30_000 },
      network: { policy: "blocked" },
      devices: {
        policy: "cpu_only",
        requested_gpu_count: 0,
        visible_device_ids: []
      },
      seeds: [17],
      seed_binding_status: "declared",
      expected_outputs: [{ path: ".autolabos/runs/fixture-run/metrics.json", required: true }]
    });
    expect(built.artifact.input_artifacts).toEqual([{
      path: "experiment/run_configured_experiment.py",
      sha256: createHash("sha256").update("print('fixture')\n").digest("hex")
    }]);
    expect(built.artifact.dependency_artifacts).toEqual([{
      path: "experiment/requirements.txt",
      sha256: createHash("sha256").update("example-package==1.0\n").digest("hex")
    }]);
    expect(JSON.stringify(built.artifact)).not.toContain(workspace);
    expect(built.artifact.envelope_id).toMatch(/^exec_[a-f0-9]{24}$/u);
    expect(built.artifact.envelope_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("binds secret targets without persisting host paths or secret values", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-secret-"));
    const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-scoped-secret-"));
    const secretPath = path.join(secretDir, "provider.env");
    await fs.writeFile(path.join(workspace, "requirements.txt"), "runtime==1.0\n", "utf8");
    await fs.writeFile(secretPath, "PROVIDER_KEY=test-only-secret\n", "utf8");
    await fs.chmod(secretPath, 0o600);

    const built = await buildExecutionEnvelope({
      workspaceRoot: workspace,
      runId: "fixture-run",
      phase: "primary",
      attempt: 1,
      executionProfile: "docker",
      command: "true",
      cwd: workspace,
      writableRoots: [workspace],
      secretFileMounts: [{
        sourcePath: secretPath,
        targetName: "provider.env"
      }],
      expectedOutputs: [],
      timeoutMs: 1_000
    });

    expect(built.artifact.secret_files).toEqual([{
      target_path: "/run/secrets/provider.env",
      required: true
    }]);
    expect(built.request.secretFileMounts).toEqual([{
      sourcePath: secretPath,
      targetPath: "/run/secrets/provider.env",
      required: true,
      sourceSha256: createHash("sha256")
        .update("PROVIDER_KEY=test-only-secret\n")
        .digest("hex")
    }]);
    expect(JSON.stringify(built.artifact)).not.toContain(secretDir);
    expect(JSON.stringify(built.artifact)).not.toContain("test-only-secret");
  });

  it("rejects workspace-local or broadly readable secret files", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-secret-policy-"));
    const localSecret = path.join(workspace, "provider.env");
    await fs.writeFile(localSecret, "PROVIDER_KEY=test-only\n", { mode: 0o600 });
    const base = {
      workspaceRoot: workspace,
      runId: "fixture-run",
      phase: "primary" as const,
      attempt: 1,
      executionProfile: "docker" as const,
      command: "true",
      cwd: workspace,
      writableRoots: [workspace],
      expectedOutputs: [],
      timeoutMs: 1_000
    };

    await expect(buildExecutionEnvelope({
      ...base,
      secretFileMounts: [{ sourcePath: localSecret, targetName: "provider.env" }]
    })).rejects.toThrow("execution_secret_source_invalid");

    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-secret-mode-"));
    const broadSecret = path.join(externalDir, "provider.env");
    await fs.writeFile(broadSecret, "PROVIDER_KEY=test-only\n", { mode: 0o644 });
    await expect(buildExecutionEnvelope({
      ...base,
      secretFileMounts: [{ sourcePath: broadSecret, targetName: "provider.env" }]
    })).rejects.toThrow("execution_secret_source_invalid");
  });

  it("requires an ephemeral Docker image for scoped secret files", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-secret-local-"));
    const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-secret-source-"));
    const secretPath = path.join(secretDir, "scoped.env");
    await fs.writeFile(secretPath, "PROVIDER_KEY=test-only\n", "utf8");
    await fs.chmod(secretPath, 0o600);
    const request = makeRequest(workspace, {
      executionProfile: "local",
      secretFileMounts: [{
        sourcePath: secretPath,
        targetPath: "/run/secrets/provider.env",
        required: true,
        sourceSha256: createHash("sha256")
          .update("PROVIDER_KEY=test-only\n")
          .digest("hex")
      }]
    });

    const observation = await new LocalAciAdapter({ envelopeIsolation: "disabled" })
      .runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("error");
    expect(observation.stderr).toContain("secret_file_mount_requires_ephemeral_docker");
  });

  it("blocks a scoped secret whose content changes after envelope construction", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-secret-binding-"));
    const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-secret-bound-"));
    const secretPath = path.join(secretDir, "provider.env");
    await fs.writeFile(path.join(workspace, "requirements.lock.txt"), "fixture==1.0\n", "utf8");
    await fs.writeFile(secretPath, "PROVIDER_KEY=before\n", "utf8");
    await fs.chmod(secretPath, 0o600);
    const built = await buildExecutionEnvelope({
      workspaceRoot: workspace,
      runId: "fixture-run",
      phase: "primary",
      attempt: 1,
      executionProfile: "docker",
      containerImage: `sha256:${"d".repeat(64)}`,
      command: "printf ok",
      cwd: workspace,
      writableRoots: [workspace],
      secretFileMounts: [{ sourcePath: secretPath, targetName: "provider.env" }],
      expectedOutputs: [],
      timeoutMs: 1_000
    });
    await fs.writeFile(secretPath, "PROVIDER_KEY=after\n", "utf8");

    const observation = await new LocalAciAdapter({
      dockerImage: `sha256:${"d".repeat(64)}`
    }).runInExecutionEnvelope(built.request, "command");

    expect(observation.status).toBe("error");
    expect(observation.execution_envelope?.reason_codes).toContain(
      "execution_secret_file_invalid"
    );
  });

  it("rejects command working directories outside the workspace", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-outside-"));

    await expect(buildExecutionEnvelope({
      workspaceRoot: workspace,
      runId: "fixture-run",
      phase: "primary",
      attempt: 1,
      executionProfile: "local",
      command: "printf blocked",
      cwd: outside,
      writableRoots: [workspace],
      expectedOutputs: [],
      timeoutMs: 1_000
    })).rejects.toThrow("execution_cwd_outside_workspace");
  });

  it("runs with an allowlisted environment and records partial local isolation honestly", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-env-"));
    const outputPath = path.join(workspace, "environment.txt");
    process.env.AUTOLABOS_TEST_VISIBLE = "visible-value";
    process.env.AUTOLABOS_TEST_PRIVATE_TOKEN = "private-value";
    const request = makeRequest(workspace, {
      command:
        "printf '%s' \"${AUTOLABOS_TEST_VISIBLE-unset},${AUTOLABOS_TEST_PRIVATE_TOKEN-unset}\" > environment.txt",
      environmentAllowlist: ["PATH", "AUTOLABOS_TEST_VISIBLE"],
      expectedOutputs: [{ path: outputPath, required: true }]
    });
    const adapter = new LocalAciAdapter({ envelopeIsolation: "disabled" });

    const observation = await adapter.runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("ok");
    expect(await fs.readFile(outputPath, "utf8")).toBe("visible-value,unset");
    expect(observation.execution_envelope).toMatchObject({
      enforcement: "partial",
      environment_allowlist_enforced: true,
      workspace_boundary_enforced: false,
      input_hashes_verified: true,
      timeout_enforced: true,
      network_policy_enforced: false,
      mount_isolation_enforced: false,
      device_policy_enforced: false
    });
    expect(observation.execution_envelope?.reason_codes).toContain(
      "network_block_not_enforced_by_local_process"
    );
  });

  it("blocks execution when a bound input changes", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-hash-"));
    const inputPath = path.join(workspace, "input.txt");
    await fs.writeFile(inputPath, "before\n", "utf8");
    const request = makeRequest(workspace, {
      command: "printf should-not-run",
      inputArtifacts: [{
        path: inputPath,
        sha256: createHash("sha256").update("before\n").digest("hex")
      }]
    });
    await fs.writeFile(inputPath, "after\n", "utf8");

    const observation = await new LocalAciAdapter({ envelopeIsolation: "disabled" })
      .runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("error");
    expect(observation.stderr).toContain("input_artifact_hash_mismatch");
    expect(observation.execution_envelope?.input_hashes_verified).toBe(false);
  });

  it("blocks execution when the runtime command no longer matches the envelope", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-command-"));
    const request = makeRequest(workspace, { command: "printf original" });
    request.command = "printf changed";

    const observation = await new LocalAciAdapter({ envelopeIsolation: "disabled" })
      .runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("error");
    expect(observation.stderr).toContain("execution_command_hash_mismatch");
  });

  it("terminates commands at the envelope timeout", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-timeout-"));
    const request = makeRequest(workspace, {
      command: "node -e \"setTimeout(() => {}, 2000)\"",
      timeoutMs: 30,
      networkPolicy: "declared"
    });

    const observation = await new LocalAciAdapter({ envelopeIsolation: "disabled" })
      .runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("error");
    expect(observation.stderr).toContain("execution_envelope_timeout");
    expect(observation.execution_envelope?.timed_out).toBe(true);
  });

  it("builds a bubblewrap plan with explicit mounts, network isolation, and sandbox paths", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-bwrap-"));
    const runDir = path.join(workspace, ".autolabos", "runs", "fixture-run");
    const experimentDir = path.join(workspace, "experiment");
    await fs.mkdir(runDir, { recursive: true });
    await fs.mkdir(experimentDir, { recursive: true });
    const request = makeRequest(workspace, {
      command: `node ${path.join(workspace, "experiment", "run.js")}`,
      cwd: experimentDir,
      writableRoots: [runDir],
      networkPolicy: "blocked"
    });

    const plan = await buildBubblewrapExecutionPlan(request, {
      PATH: "/private/bin:/usr/bin",
      HOME: "/private/home",
      PYTHONPATH: path.join(workspace, "experiment")
    });

    expect(plan.executable).toBe("bwrap");
    expect(plan.sandboxCwd).toBe("/workspace/experiment");
    expect(plan.sandboxCommand).toBe("node /workspace/experiment/run.js");
    expect(plan.args).toContain("--unshare-all");
    expect(plan.args).toContain("--clearenv");
    expect(plan.args).not.toContain("--share-net");
    expect(plan.args).toEqual(expect.arrayContaining([
      "--ro-bind", workspace, "/workspace",
      "--bind", runDir, "/workspace/.autolabos/runs/fixture-run",
      "--setenv", "HOME", "/home/autolabos",
      "--setenv", "PYTHONPATH", "/workspace/experiment"
    ]));
    expect(plan.args).not.toContain("/private/home");
    expect(plan.hostEnvironment).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
  });

  it("uses enforced bubblewrap only when the host can start the sandbox", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-auto-"));
    const request = makeRequest(workspace, {
      command: "printf auto-isolation",
      networkPolicy: "blocked"
    });

    const observation = await new LocalAciAdapter().runInExecutionEnvelope(request, "command");
    const assurance = observation.execution_envelope;

    expect(assurance).toBeDefined();
    if (assurance?.enforcement === "enforced") {
      expect(observation.status).toBe("ok");
      expect(assurance.adapter).toBe("bubblewrap");
      expect(assurance).toMatchObject({
        environment_allowlist_enforced: true,
        workspace_boundary_enforced: true,
        input_hashes_verified: true,
        timeout_enforced: true,
        network_policy_enforced: true,
        mount_isolation_enforced: true,
        device_policy_enforced: true
      });
    } else {
      expect(assurance?.enforcement).toBe("partial");
      expect(assurance?.reason_codes).toEqual(expect.arrayContaining([
        expect.stringMatching(
          /^(bubblewrap_probe_failed|bubblewrap_setup_failed|isolated_execution_gpu_device_policy_missing)$/u
        )
      ]));
    }
  });

  it("rejects writable roots that resolve outside the workspace", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-link-target-"));
    const linkedRoot = path.join(workspace, "linked-output");
    await fs.symlink(outside, linkedRoot, "dir");
    const request = makeRequest(workspace, {
      writableRoots: [linkedRoot],
      expectedOutputs: [{ path: path.join(linkedRoot, "result.json"), required: true }]
    });

    const observation = await new LocalAciAdapter({ envelopeIsolation: "disabled" })
      .runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("error");
    expect(observation.stderr).toContain("writable_root_outside_workspace");
  });

  it("binds an explicit GPU request into the portable envelope", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-gpu-"));
    const built = await buildExecutionEnvelope({
      workspaceRoot: workspace,
      runId: "fixture-run",
      phase: "primary",
      attempt: 1,
      executionProfile: "local",
      command: "CUDA_VISIBLE_DEVICES=0,2 python3 run.py --num-gpus 2",
      cwd: workspace,
      writableRoots: [workspace],
      expectedOutputs: [],
      timeoutMs: 1_000,
      requestedGpuCount: 2,
      visibleGpuDeviceIds: ["0", "2"]
    });

    expect(built.artifact.devices).toEqual({
      policy: "nvidia_gpu",
      requested_gpu_count: 2,
      visible_device_ids: ["0", "2"]
    });
    expect(built.request.devicePolicy).toEqual({
      kind: "nvidia_gpu",
      requestedGpuCount: 2,
      visibleGpuDeviceIds: ["0", "2"]
    });
  });

  it("adds only explicitly selected NVIDIA devices to a bubblewrap plan", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-gpu-plan-"));
    const request = makeRequest(workspace, {
      devicePolicy: {
        kind: "nvidia_gpu",
        requestedGpuCount: 1,
        visibleGpuDeviceIds: ["3"]
      }
    });

    const plan = await buildBubblewrapExecutionPlan(request, { PATH: "/usr/bin:/bin" }, {
      devicePaths: ["/dev/nvidiactl", "/dev/nvidia3"]
    });

    expect(plan.args).toEqual(expect.arrayContaining([
      "--dev-bind", "/dev/nvidiactl", "/dev/nvidiactl",
      "--dev-bind", "/dev/nvidia3", "/dev/nvidia3"
    ]));
    expect(plan.args).not.toContain("/dev/nvidia0");
  });

  it("keeps GPU execution partial when exact visible device IDs are not declared", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-gpu-ids-"));
    const request = makeRequest(workspace, {
      devicePolicy: {
        kind: "nvidia_gpu",
        requestedGpuCount: 1,
        visibleGpuDeviceIds: []
      }
    });

    const observation = await new LocalAciAdapter().runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("ok");
    expect(observation.execution_envelope?.enforcement).toBe("partial");
    expect(observation.execution_envelope?.device_policy_enforced).toBe(false);
    expect(observation.execution_envelope?.reason_codes).toContain(
      "isolated_execution_gpu_device_ids_not_declared"
    );
  });

  it("fails closed when the Docker execution boundary cannot be inspected", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-profile-"));
    const request = makeRequest(workspace, { executionProfile: "docker" });

    const observation = await new LocalAciAdapter({
      dockerExecutable: "autolabos-missing-docker-command",
      dockerTarget: "runtime-container"
    }).runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("error");
    expect(observation.execution_envelope?.enforcement).toBe("partial");
    expect(observation.execution_envelope?.adapter).toBe("docker_exec");
    expect(observation.execution_envelope?.reason_codes).toContain(
      "docker_container_inspect_failed"
    );
  });

  it("records enforced Docker execution only after matching pre and post inspection", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-docker-"));
    const outputPath = path.join(workspace, "result.txt");
    const fakeDockerPath = path.join(workspace, "docker-fixture.cjs");
    const inspection = [{
      Id: "container-fixture-id",
      Config: { User: "1000:1000" },
      State: { Running: true, Paused: false, Restarting: false },
      HostConfig: {
        Privileged: false,
        ReadonlyRootfs: true,
        NetworkMode: "none",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Devices: [],
        DeviceRequests: []
      },
      Mounts: [{
        Type: "bind",
        Source: workspace,
        Destination: workspace,
        RW: true
      }]
    }];
    await fs.writeFile(
      fakeDockerPath,
      [
        `#!${process.execPath}`,
        `const { spawnSync } = require("node:child_process");`,
        `const args = process.argv.slice(2);`,
        `if (args[0] === "container" && args[1] === "inspect") {`,
        `  process.stdout.write(${JSON.stringify(JSON.stringify(inspection))});`,
        `  process.exit(0);`,
        `}`,
        `if (args[0] === "exec") {`,
        `  const child = spawnSync(args[2], args.slice(3), { stdio: "inherit" });`,
        `  process.exit(child.status ?? 1);`,
        `}`,
        `process.exit(2);`,
        ``
      ].join("\n"),
      "utf8"
    );
    await fs.chmod(fakeDockerPath, 0o755);
    const command = `printf docker-ok > ${JSON.stringify(outputPath)}`;
    const request = makeRequest(workspace, {
      executionProfile: "docker",
      command,
      commandSha256: createHash("sha256")
        .update(command.split(workspace).join("${WORKSPACE_ROOT}"), "utf8")
        .digest("hex"),
      expectedOutputs: [{ path: outputPath, required: true }],
      timeoutMs: 5_000
    });

    const observation = await new LocalAciAdapter({
      dockerExecutable: fakeDockerPath,
      dockerTarget: "runtime-container",
      processEnvironment: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8"
      }
    }).runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("ok");
    expect(await fs.readFile(outputPath, "utf8")).toBe("docker-ok");
    expect(observation.execution_envelope).toMatchObject({
      adapter: "docker_exec",
      enforcement: "enforced",
      environment_allowlist_enforced: true,
      workspace_boundary_enforced: true,
      input_hashes_verified: true,
      timeout_enforced: true,
      network_policy_enforced: true,
      mount_isolation_enforced: true,
      device_policy_enforced: true
    });
  });

  it("creates and removes an envelope-scoped Docker container when an image is configured", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-docker-run-"));
    const outputPath = path.join(workspace, "result.txt");
    const callLogPath = path.join(workspace, "docker-calls.log");
    const fakeDockerPath = path.join(workspace, "docker-run-fixture.cjs");
    const inspection = [{
      Id: "ephemeral-container-fixture-id",
      Config: { User: "1000:1000" },
      State: { Running: false, Paused: false, Restarting: false },
      HostConfig: {
        Privileged: false,
        ReadonlyRootfs: true,
        NetworkMode: "none",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Devices: [],
        DeviceRequests: []
      },
      Mounts: [{
        Type: "bind",
        Source: workspace,
        Destination: workspace,
        RW: true
      }]
    }];
    await fs.writeFile(fakeDockerPath, [
      `#!${process.execPath}`,
      `const fs = require("node:fs");`,
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(callLogPath)}, args.join(" ") + "\\n");`,
      `if (args[0] === "create") { process.stdout.write("fixture-id\\n"); process.exit(0); }`,
      `if (args[0] === "container" && args[1] === "inspect") {`,
      `  process.stdout.write(${JSON.stringify(JSON.stringify(inspection))});`,
      `  process.exit(0);`,
      `}`,
      `if (args[0] === "start") {`,
      `  fs.writeFileSync(${JSON.stringify(outputPath)}, "docker-run-ok");`,
      `  process.stdout.write("docker-run-ok");`,
      `  process.exit(0);`,
      `}`,
      `if (args[0] === "container" && args[1] === "rm") { process.exit(0); }`,
      `process.exit(2);`,
      ``
    ].join("\n"), "utf8");
    await fs.chmod(fakeDockerPath, 0o755);
    const command = `printf docker-run-ok > ${JSON.stringify(outputPath)}`;
    const request = makeRequest(workspace, {
      executionProfile: "docker",
      containerImage: `sha256:${"a".repeat(64)}`,
      command,
      commandSha256: createHash("sha256")
        .update(command.split(workspace).join("${WORKSPACE_ROOT}"), "utf8")
        .digest("hex"),
      expectedOutputs: [{ path: outputPath, required: true }],
      timeoutMs: 5_000
    });

    const observation = await new LocalAciAdapter({
      dockerExecutable: fakeDockerPath,
      dockerImage: `sha256:${"a".repeat(64)}`,
      processEnvironment: { PATH: process.env.PATH, LANG: "C.UTF-8" }
    }).runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("ok");
    expect(observation.stdout).toBe("docker-run-ok");
    expect(await fs.readFile(outputPath, "utf8")).toBe("docker-run-ok");
    expect(observation.execution_envelope).toMatchObject({
      adapter: "docker_run",
      enforcement: "enforced",
      workspace_boundary_enforced: true,
      network_policy_enforced: true,
      mount_isolation_enforced: true,
      device_policy_enforced: true
    });
    const calls = await fs.readFile(callLogPath, "utf8");
    const containerName = calls
      .split("\n")
      .find((line) => line.startsWith("create --name "))
      ?.split(" ")[2];
    expect(containerName).toMatch(/^autolabos-exec_fixture_envelope-\d+-[a-f0-9]{8}$/u);
    expect(calls.match(/container inspect/gu)).toHaveLength(2);
    expect(calls).toContain(`start --attach ${containerName}`);
    expect(calls).toContain(`container rm --force ${containerName}`);

    const mutableRequest = {
      ...request,
      containerImage: "research-runtime:local"
    };
    const mutableObservation = await new LocalAciAdapter({
      dockerExecutable: fakeDockerPath,
      dockerImage: "research-runtime:local",
      processEnvironment: { PATH: process.env.PATH, LANG: "C.UTF-8" }
    }).runInExecutionEnvelope(mutableRequest, "command");
    expect(mutableObservation.execution_envelope?.enforcement).toBe("partial");
    expect(mutableObservation.execution_envelope?.reason_codes).toContain(
      "docker_image_not_immutable"
    );
  });

  it("records cleanup failure when an ephemeral Docker boundary is rejected", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-docker-cleanup-"));
    const fakeDockerPath = path.join(workspace, "docker-cleanup-fixture.cjs");
    const inspection = [{
      Id: "cleanup-container-fixture-id",
      Config: { User: "1000:1000" },
      State: { Running: false, Paused: false, Restarting: false },
      HostConfig: {
        Privileged: false,
        ReadonlyRootfs: false,
        NetworkMode: "none",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Devices: [],
        DeviceRequests: []
      },
      Mounts: [{
        Type: "bind",
        Source: workspace,
        Destination: workspace,
        RW: true
      }]
    }];
    await fs.writeFile(fakeDockerPath, [
      `#!${process.execPath}`,
      `const args = process.argv.slice(2);`,
      `if (args[0] === "create") { process.exit(0); }`,
      `if (args[0] === "container" && args[1] === "inspect") {`,
      `  process.stdout.write(${JSON.stringify(JSON.stringify(inspection))});`,
      `  process.exit(0);`,
      `}`,
      `if (args[0] === "container" && args[1] === "rm") { process.exit(2); }`,
      `process.exit(2);`,
      ``
    ].join("\n"), "utf8");
    await fs.chmod(fakeDockerPath, 0o755);
    const request = makeRequest(workspace, {
      executionProfile: "docker",
      timeoutMs: 5_000
    });

    const observation = await new LocalAciAdapter({
      dockerExecutable: fakeDockerPath,
      dockerImage: "research-runtime:local",
      processEnvironment: { PATH: process.env.PATH }
    }).runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("error");
    expect(observation.execution_envelope?.reason_codes).toEqual(expect.arrayContaining([
      "docker_rootfs_not_readonly",
      "docker_container_cleanup_failed"
    ]));
  });

  it("attempts cleanup when Docker create returns an ambiguous failure", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-create-failure-"));
    const fakeDockerPath = path.join(workspace, "docker-create-failure-fixture.cjs");
    const callLogPath = path.join(workspace, "docker-calls.log");
    await fs.writeFile(fakeDockerPath, [
      `#!${process.execPath}`,
      `const fs = require("node:fs");`,
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(callLogPath)}, args.join(" ") + "\\n");`,
      `if (args[0] === "create") { process.stderr.write("client interrupted"); process.exit(2); }`,
      `if (args[0] === "container" && args[1] === "rm") { process.exit(0); }`,
      `process.exit(2);`,
      ``
    ].join("\n"), "utf8");
    await fs.chmod(fakeDockerPath, 0o755);
    const request = makeRequest(workspace, {
      executionProfile: "docker",
      containerImage: `sha256:${"b".repeat(64)}`,
      timeoutMs: 5_000
    });

    const observation = await new LocalAciAdapter({
      dockerExecutable: fakeDockerPath,
      dockerImage: `sha256:${"b".repeat(64)}`,
      processEnvironment: { PATH: process.env.PATH }
    }).runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("error");
    expect(observation.execution_envelope?.reason_codes).toEqual(expect.arrayContaining([
      "docker_container_create_failed",
      "docker_container_create_state_ambiguous"
    ]));
    const calls = await fs.readFile(callLogPath, "utf8");
    const containerName = calls
      .split("\n")
      .find((line) => line.startsWith("create --name "))
      ?.split(" ")[2];
    expect(calls).toContain(`container rm --force ${containerName}`);
  });

  it("fails closed for execution profiles without a dedicated adapter", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-remote-"));
    const request = makeRequest(workspace, { executionProfile: "remote" });

    const observation = await new LocalAciAdapter().runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("error");
    expect(observation.execution_envelope?.reason_codes).toContain(
      "execution_profile_adapter_not_available"
    );
  });

  it("detects bound input mutation during execution", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-mutation-"));
    const inputPath = path.join(workspace, "input.txt");
    await fs.writeFile(inputPath, "before\n", "utf8");
    const request = makeRequest(workspace, {
      command: "printf 'after\\n' > input.txt",
      inputArtifacts: [{
        path: inputPath,
        sha256: createHash("sha256").update("before\n").digest("hex")
      }]
    });

    const observation = await new LocalAciAdapter({ envelopeIsolation: "disabled" })
      .runInExecutionEnvelope(request, "command");

    expect(observation.status).toBe("ok");
    expect(observation.execution_envelope?.input_hashes_verified).toBe(false);
    expect(observation.execution_envelope?.reason_codes).toContain(
      "execution_boundary_changed_during_execution"
    );
  });

  it("creates a hash-bound receipt without overstating compatibility execution", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-receipt-"));
    const outputPath = path.join(workspace, "result.json");
    await fs.writeFile(path.join(workspace, "package-lock.json"), "{}\n", "utf8");
    const built = await buildExecutionEnvelope({
      workspaceRoot: workspace,
      runId: "fixture-run",
      phase: "primary",
      attempt: 1,
      executionProfile: "local",
      command: "printf '{}' > result.json",
      cwd: workspace,
      writableRoots: [workspace],
      expectedOutputs: [{ path: outputPath, required: true }],
      timeoutMs: 1_000,
      networkPolicy: "declared",
      createdAt: "2026-08-09T00:00:00.000Z"
    });
    const compatibilityAci = {
      async runCommand() {
        await fs.writeFile(outputPath, "{}", "utf8");
        return { status: "ok" as const, exit_code: 0, duration_ms: 3 };
      },
      async runTests() {
        return { status: "ok" as const, exit_code: 0, duration_ms: 1 };
      }
    } as never;

    const result = await executeInEnvelope({
      aci: compatibilityAci,
      envelope: built,
      scope: "command",
      startedAt: "2026-08-09T00:00:01.000Z"
    });

    expect(result.receipt).toMatchObject({
      status: "completed",
      enforcement: "compatibility",
      paper_grade_eligible: false,
      required_outputs_present: true,
      reason_codes: ["aci_adapter_missing_execution_envelope"]
    });
    expect(result.receipt.output_artifacts[0]?.path).toBe("result.json");
    expect(result.receipt.receipt_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result.receipt)).not.toContain(workspace);
  });

  it("uses trusted timeout state rather than container-controlled stderr for paper eligibility", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-timeout-receipt-"));
    const outputPath = path.join(workspace, "result.json");
    await fs.writeFile(path.join(workspace, "package-lock.json"), "{}\n", "utf8");
    const built = await buildExecutionEnvelope({
      workspaceRoot: workspace,
      runId: "fixture-run",
      phase: "primary",
      attempt: 1,
      executionProfile: "docker",
      containerImage: `sha256:${"c".repeat(64)}`,
      command: "printf '{}' > result.json",
      cwd: workspace,
      writableRoots: [workspace],
      expectedOutputs: [{ path: outputPath, required: true }],
      timeoutMs: 1_000,
      networkPolicy: "blocked"
    });
    const observationFor = (timedOut: boolean) => ({
      status: "ok" as const,
      stderr: "execution_envelope_timeout",
      exit_code: 0,
      duration_ms: 3,
      execution_timed_out: timedOut,
      execution_envelope: {
        envelope_id: built.artifact.envelope_id,
        adapter: "docker_run" as const,
        enforcement: "enforced" as const,
        environment_allowlist_enforced: true,
        workspace_boundary_enforced: true,
        input_hashes_verified: true,
        timeout_enforced: true,
        network_policy_enforced: true,
        mount_isolation_enforced: true,
        device_policy_enforced: true,
        timed_out: timedOut,
        runtime_evidence: stableDockerRuntimeEvidence(),
        reason_codes: timedOut ? ["execution_envelope_timeout"] : []
      }
    });
    const execute = async (timedOut: boolean) => executeInEnvelope({
      aci: {
        async runInExecutionEnvelope() {
          await fs.writeFile(outputPath, "{}", "utf8");
          return observationFor(timedOut);
        }
      } as never,
      envelope: built,
      scope: "command"
    });

    const spoofOnly = await execute(false);
    expect(spoofOnly.receipt.status).toBe("completed");
    expect(spoofOnly.receipt.paper_grade_eligible).toBe(true);

    const missingEvidenceObservation = observationFor(false);
    delete missingEvidenceObservation.execution_envelope.runtime_evidence;
    const missingEvidence = await executeInEnvelope({
      aci: {
        async runInExecutionEnvelope() {
          await fs.writeFile(outputPath, "{}", "utf8");
          return missingEvidenceObservation;
        }
      } as never,
      envelope: built,
      scope: "command"
    });
    expect(missingEvidence.receipt.paper_grade_eligible).toBe(false);
    expect(missingEvidence.receipt.reason_codes).toContain(
      "docker_runtime_evidence_missing"
    );

    const actualTimeout = await execute(true);
    expect(actualTimeout.receipt.status).toBe("timed_out");
    expect(actualTimeout.receipt.paper_grade_eligible).toBe(false);
  });

  it("re-audits envelope linkage and current artifact hashes before evidence reuse", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-artifact-audit-"));
    const outputPath = path.join(workspace, "result.json");
    await fs.writeFile(path.join(workspace, "requirements.lock.txt"), "fixture==1.0\n", "utf8");
    const built = await buildExecutionEnvelope({
      workspaceRoot: workspace,
      runId: "fixture-run",
      phase: "primary",
      attempt: 1,
      executionProfile: "docker",
      containerImage: `sha256:${"e".repeat(64)}`,
      command: "printf '{}' > result.json",
      cwd: workspace,
      writableRoots: [workspace],
      expectedOutputs: [{ path: outputPath, required: true }],
      timeoutMs: 1_000,
      networkPolicy: "blocked"
    });
    const result = await executeInEnvelope({
      aci: {
        async runInExecutionEnvelope() {
          await fs.writeFile(outputPath, "{}", "utf8");
          return {
            status: "ok" as const,
            exit_code: 0,
            duration_ms: 3,
            execution_envelope: {
              envelope_id: built.artifact.envelope_id,
              adapter: "docker_run" as const,
              enforcement: "enforced" as const,
              environment_allowlist_enforced: true,
              workspace_boundary_enforced: true,
              input_hashes_verified: true,
              timeout_enforced: true,
              network_policy_enforced: true,
              mount_isolation_enforced: true,
              device_policy_enforced: true,
              timed_out: false,
              runtime_evidence: stableDockerRuntimeEvidence(),
              reason_codes: []
            }
          };
        }
      } as never,
      envelope: built,
      scope: "command"
    });

    const valid = await auditExecutionEnvelopeArtifacts({
      artifact: built.artifact,
      receipt: result.receipt,
      workspaceRoot: workspace
    });
    expect(valid).toEqual({
      valid: true,
      paper_grade_eligible: true,
      reason_codes: []
    });

    const malformedReceipt = {
      ...result.receipt,
      assurance: {}
    };
    malformedReceipt.receipt_sha256 = hashCanonical((({ receipt_sha256: _, ...rest }) => rest)(
      malformedReceipt
    ));
    const malformed = await auditExecutionEnvelopeArtifacts({
      artifact: built.artifact,
      receipt: malformedReceipt as never,
      workspaceRoot: workspace
    });
    expect(malformed).toEqual({
      valid: false,
      paper_grade_eligible: false,
      reason_codes: ["execution_receipt_schema_invalid"]
    });

    await fs.writeFile(outputPath, "{\"changed\":true}", "utf8");
    const changed = await auditExecutionEnvelopeArtifacts({
      artifact: built.artifact,
      receipt: result.receipt,
      workspaceRoot: workspace
    });
    expect(changed.valid).toBe(false);
    expect(changed.paper_grade_eligible).toBe(false);
    expect(changed.reason_codes).toContain(
      "execution_output_artifact_current_hash_mismatch"
    );

    const external = path.join(await fs.mkdtemp(
      path.join(os.tmpdir(), "autolabos-envelope-artifact-target-")
    ), "result.json");
    await fs.writeFile(external, "{}", "utf8");
    await fs.unlink(outputPath);
    await fs.symlink(external, outputPath);
    const linked = await auditExecutionEnvelopeArtifacts({
      artifact: built.artifact,
      receipt: result.receipt,
      workspaceRoot: workspace
    });
    expect(linked.valid).toBe(false);
    expect(linked.reason_codes).toContain(
      "execution_artifact_realpath_invalid"
    );
  });

  it("rejects an artifact reached through a parent-directory symlink", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-parent-link-"));
    const originalDir = path.join(workspace, "nested");
    const outputPath = path.join(originalDir, "result.json");
    await fs.mkdir(originalDir);
    await fs.writeFile(path.join(workspace, "requirements.lock.txt"), "fixture==1.0\n", "utf8");
    const built = await buildExecutionEnvelope({
      workspaceRoot: workspace,
      runId: "fixture-run",
      phase: "primary",
      attempt: 1,
      executionProfile: "docker",
      containerImage: `sha256:${"f".repeat(64)}`,
      command: "printf '{}' > nested/result.json",
      cwd: workspace,
      writableRoots: [originalDir],
      expectedOutputs: [{ path: outputPath, required: true }],
      timeoutMs: 1_000,
      networkPolicy: "blocked"
    });
    const result = await executeInEnvelope({
      aci: {
        async runInExecutionEnvelope() {
          await fs.writeFile(outputPath, "{}", "utf8");
          return {
            status: "ok" as const,
            exit_code: 0,
            duration_ms: 1,
            execution_envelope: {
              envelope_id: built.artifact.envelope_id,
              adapter: "docker_run" as const,
              enforcement: "enforced" as const,
              environment_allowlist_enforced: true,
              workspace_boundary_enforced: true,
              input_hashes_verified: true,
              timeout_enforced: true,
              network_policy_enforced: true,
              mount_isolation_enforced: true,
              device_policy_enforced: true,
              timed_out: false,
              runtime_evidence: stableDockerRuntimeEvidence(),
              reason_codes: []
            }
          };
        }
      } as never,
      envelope: built,
      scope: "command"
    });
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-envelope-parent-target-"));
    const moved = path.join(external, "nested");
    await fs.rename(originalDir, moved);
    await fs.symlink(moved, originalDir);

    const audit = await auditExecutionEnvelopeArtifacts({
      artifact: built.artifact,
      receipt: result.receipt,
      workspaceRoot: workspace
    });
    expect(audit.valid).toBe(false);
    expect(audit.reason_codes).toContain("execution_artifact_realpath_invalid");
  });
});

function makeRequest(
  workspace: string,
  overrides: Partial<AciExecutionEnvelopeRequest>
): AciExecutionEnvelopeRequest {
  const request: AciExecutionEnvelopeRequest = {
    version: 1,
    envelopeId: "exec_fixture_envelope",
    runId: "fixture-run",
    phase: "primary",
    attempt: 1,
    executionProfile: "local",
    command: "printf ok",
    commandSha256: createHash("sha256").update("printf ok", "utf8").digest("hex"),
    workspaceRoot: workspace,
    cwd: workspace,
    writableRoots: [workspace],
    environmentAllowlist: ["PATH"],
    devicePolicy: {
      kind: "cpu_only",
      requestedGpuCount: 0,
      visibleGpuDeviceIds: []
    },
    networkPolicy: "blocked",
    timeoutMs: 1_000,
    inputArtifacts: [],
    dependencyArtifacts: [],
    expectedOutputs: [],
    ...overrides
  };
  return {
    ...request,
    commandSha256: overrides.commandSha256
      || createHash("sha256").update(request.command, "utf8").digest("hex")
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
