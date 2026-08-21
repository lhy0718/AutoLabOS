import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

import type { AciExecutionEnvelopeRequest, AciObservation } from "../src/tools/aci.js";
import {
  buildDockerCreateExecutionPlan,
  buildDockerExecutionPlan,
  parseDockerContainerInspection,
  validateDockerExecutionBoundary
} from "../src/tools/dockerExecution.js";

describe("docker execution envelope", () => {
  it("accepts a non-root, capability-dropped CPU container with bounded mounts", () => {
    const request = makeRequest();
    const inspection = parseDockerContainerInspection(inspectObservation({
      Mounts: [{
        Type: "bind",
        Source: "/workspace/project",
        Destination: "/workspace/project",
        RW: true
      }]
    }));

    const validation = validateDockerExecutionBoundary(request, inspection);

    expect(validation.valid).toBe(true);
    expect(validation.reasonCodes).toEqual([]);
  });

  it("rejects broad host exposure and a networked privileged container", () => {
    const request = makeRequest();
    const inspection = parseDockerContainerInspection(inspectObservation({
      HostConfig: {
        Privileged: true,
        ReadonlyRootfs: false,
        NetworkMode: "bridge",
        CapDrop: [],
        SecurityOpt: []
      },
      Config: { User: "root" },
      Mounts: [{
        Type: "bind",
        Source: "/",
        Destination: "/host",
        RW: true
      }]
    }));

    const validation = validateDockerExecutionBoundary(request, inspection);

    expect(validation.valid).toBe(false);
    expect(validation.reasonCodes).toEqual(expect.arrayContaining([
      "docker_container_privileged",
      "docker_rootfs_not_readonly",
      "docker_capabilities_not_dropped",
      "docker_no_new_privileges_missing",
      "docker_non_root_user_missing",
      "docker_network_not_blocked",
      "docker_unapproved_mount_present",
      "docker_workspace_mount_missing"
    ]));
  });

  it("accepts only the explicitly selected NVIDIA device request", () => {
    const request = makeRequest({
      devicePolicy: {
        kind: "nvidia_gpu",
        requestedGpuCount: 2,
        visibleGpuDeviceIds: ["1", "3"]
      }
    });
    const inspection = parseDockerContainerInspection(inspectObservation({
      HostConfig: {
        DeviceRequests: [{
          Driver: "nvidia",
          Count: 0,
          DeviceIDs: ["3", "1"],
          Capabilities: [["gpu"]]
        }]
      }
    }));

    expect(validateDockerExecutionBoundary(request, inspection).valid).toBe(true);

    const mismatched = {
      ...inspection,
      deviceRequests: [{
        ...inspection.deviceRequests[0],
        deviceIds: ["0", "1"]
      }]
    };
    expect(validateDockerExecutionBoundary(request, mismatched).reasonCodes).toContain(
      "docker_gpu_device_request_mismatch"
    );
    const incompleteDeclaration = makeRequest({
      devicePolicy: {
        kind: "nvidia_gpu",
        requestedGpuCount: 3,
        visibleGpuDeviceIds: ["1", "3"]
      }
    });
    expect(
      validateDockerExecutionBoundary(incompleteDeclaration, inspection).reasonCodes
    ).toContain("docker_gpu_device_request_mismatch");
  });

  it("requires container networking when the envelope declares network access", () => {
    const request = makeRequest({ networkPolicy: "required", networkPurpose: "dataset retrieval" });
    const inspection = parseDockerContainerInspection(inspectObservation({}));

    expect(validateDockerExecutionBoundary(request, inspection).reasonCodes).toContain(
      "docker_network_unavailable"
    );
  });

  it("builds docker exec with a cleared environment and explicit device visibility", () => {
    const request = makeRequest({
      command: "python3 runner.py --output result.json",
      devicePolicy: {
        kind: "nvidia_gpu",
        requestedGpuCount: 1,
        visibleGpuDeviceIds: ["2"]
      }
    });
    const plan = buildDockerExecutionPlan(
      request,
      "runtime-container",
      {
        LANG: "C.UTF-8",
        PRIVATE_TOKEN: "must-not-be-present"
      },
      {
        dockerExecutable: "/usr/bin/docker",
        hostEnvironment: { PATH: "/usr/bin:/bin" }
      }
    );

    expect(plan.executable).toBe("/usr/bin/docker");
    expect(plan.args.slice(0, 4)).toEqual([
      "exec",
      "runtime-container",
      "/usr/bin/env",
      "-i"
    ]);
    expect(plan.args).toContain("CUDA_VISIBLE_DEVICES=2");
    expect(plan.args).toContain("NVIDIA_VISIBLE_DEVICES=2");
    expect(plan.args).not.toContain("PRIVATE_TOKEN=must-not-be-present");
    expect(plan.hostEnvironment).toEqual({ PATH: "/usr/bin:/bin" });
    expect(plan.args.at(-1)).toContain("python3 runner.py --output result.json");
  });

  it("builds an ephemeral container with a read-only workspace and bounded writable overlays", () => {
    const request = makeRequest({
      cwd: "/workspace/project/source",
      writableRoots: [
        "/workspace/project/output",
        "/workspace/project/output/cache"
      ],
      command: "python3 runner.py"
    });
    const plan = buildDockerCreateExecutionPlan(
      request,
      "research-runtime:local",
      {
        LANG: "C.UTF-8",
        PRIVATE_TOKEN: "must-not-be-present"
      },
      {
        dockerExecutable: "/usr/bin/docker",
        hostEnvironment: { PATH: "/usr/bin:/bin" },
        containerName: "execution-fixture",
        user: "1234:5678"
      }
    );

    expect(plan.args).toEqual(expect.arrayContaining([
      "create",
      "--name", "execution-fixture",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--user", "1234:5678",
      "--network", "none",
      "--mount", "type=bind,src=/workspace/project,dst=/workspace/project,readonly",
      "--mount", "type=bind,src=/workspace/project/output,dst=/workspace/project/output",
      "--workdir", "/workspace/project/source",
      "--entrypoint", "/usr/bin/env",
      "research-runtime:local",
      "-i",
      "CUDA_VISIBLE_DEVICES=",
      "NVIDIA_VISIBLE_DEVICES=none"
    ]));
    expect(plan.args).not.toContain(
      "type=bind,src=/workspace/project/output/cache,dst=/workspace/project/output/cache"
    );
    expect(plan.args).not.toContain("PRIVATE_TOKEN=must-not-be-present");
    expect(plan.args).not.toContain("--gpus");
  });

  it("rejects option-like or whitespace-bearing Docker image references", () => {
    const request = makeRequest();

    expect(() => buildDockerCreateExecutionPlan(request, "--privileged", {}))
      .toThrow("docker_execution_image_invalid");
    expect(() => buildDockerCreateExecutionPlan(request, "runtime image:latest", {}))
      .toThrow("docker_execution_image_invalid");
  });

  it("binds exact GPU IDs and validates a stopped ephemeral container boundary", () => {
    const request = makeRequest({
      devicePolicy: {
        kind: "nvidia_gpu",
        requestedGpuCount: 2,
        visibleGpuDeviceIds: ["0", "2"]
      }
    });
    const plan = buildDockerCreateExecutionPlan(request, "research-runtime:local", {});
    const gpuArgIndex = plan.args.indexOf("--gpus");
    expect(plan.args[gpuArgIndex + 1]).toBe("device=0,2");

    const inspection = parseDockerContainerInspection(inspectObservation({
      State: { Running: false, Paused: false, Restarting: false },
      HostConfig: {
        DeviceRequests: [{
          Driver: "nvidia",
          Count: 0,
          DeviceIDs: ["0", "2"],
          Capabilities: [["gpu"]]
        }]
      }
    }));
    expect(validateDockerExecutionBoundary(request, inspection, {
      expectedState: "stopped"
    }).valid).toBe(true);
  });

  it("masks workspace dotenv files and mounts only a scoped secret file read-only", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-docker-secret-"));
    const output = path.join(workspace, "output");
    const scopedSecret = path.join(os.tmpdir(), `autolabos-provider-${path.basename(workspace)}.env`);
    await fs.mkdir(output);
    await fs.mkdir(path.join(workspace, "nested"));
    await fs.mkdir(path.join(workspace, ".git"));
    await fs.mkdir(path.join(workspace, "node_modules"));
    await fs.writeFile(path.join(workspace, ".env"), "UNRELATED_SECRET=hidden\n", "utf8");
    await fs.writeFile(
      path.join(workspace, "nested", ".env.local"),
      "NESTED_SECRET=hidden\n",
      "utf8"
    );
    await fs.writeFile(path.join(workspace, ".env.example"), "EXAMPLE=\n", "utf8");
    await fs.writeFile(path.join(workspace, ".git", ".env"), "GIT_SECRET=hidden\n", "utf8");
    await fs.writeFile(
      path.join(workspace, "node_modules", ".env.local"),
      "DEPENDENCY_SECRET=hidden\n",
      "utf8"
    );
    await fs.writeFile(scopedSecret, "PROVIDER_KEY=test-only\n", "utf8");
    const request = makeRequest({
      workspaceRoot: workspace,
      cwd: workspace,
      writableRoots: [output],
      secretFileMounts: [{
        sourcePath: scopedSecret,
        targetPath: "/run/secrets/provider.env",
        required: true,
        sourceSha256: createHash("sha256")
          .update("PROVIDER_KEY=test-only\n")
          .digest("hex")
      }]
    });

    const plan = buildDockerCreateExecutionPlan(request, "research-runtime:local", {}, {
      containerName: "secret-fixture"
    });

    expect(plan.args).toContain(
      `type=bind,src=/dev/null,dst=${path.join(workspace, ".env")},readonly`
    );
    expect(plan.args).not.toContain(
      `type=bind,src=/dev/null,dst=${path.join(workspace, ".env.example")},readonly`
    );
    expect(plan.args).toContain(
      `type=bind,src=/dev/null,dst=${path.join(workspace, "nested", ".env.local")},readonly`
    );
    expect(plan.args).toContain(
      `type=bind,src=/dev/null,dst=${path.join(workspace, ".git", ".env")},readonly`
    );
    expect(plan.args).toContain(
      `type=bind,src=/dev/null,dst=${path.join(workspace, "node_modules", ".env.local")},readonly`
    );
    expect(plan.args).toContain(
      `type=bind,src=${scopedSecret},dst=/run/secrets/provider.env,readonly`
    );

    const inspection = parseDockerContainerInspection(inspectObservation({
      Mounts: [
        { Type: "bind", Source: workspace, Destination: workspace, RW: false },
        { Type: "bind", Source: output, Destination: output, RW: true },
        {
          Type: "bind",
          Source: "/dev/null",
          Destination: path.join(workspace, ".env"),
          RW: false
        },
        {
          Type: "bind",
          Source: "/dev/null",
          Destination: path.join(workspace, "nested", ".env.local"),
          RW: false
        },
        {
          Type: "bind",
          Source: "/dev/null",
          Destination: path.join(workspace, ".git", ".env"),
          RW: false
        },
        {
          Type: "bind",
          Source: "/dev/null",
          Destination: path.join(workspace, "node_modules", ".env.local"),
          RW: false
        },
        {
          Type: "bind",
          Source: scopedSecret,
          Destination: "/run/secrets/provider.env",
          RW: false
        }
      ]
    }));
    expect(validateDockerExecutionBoundary(request, inspection).valid).toBe(true);

    const missingSecret = {
      ...inspection,
      mounts: inspection.mounts.filter((mount) =>
        mount.destination !== "/run/secrets/provider.env"
      )
    };
    expect(validateDockerExecutionBoundary(request, missingSecret).reasonCodes).toContain(
      "docker_secret_file_mount_missing"
    );
  });

  it("fails closed when a workspace dotenv path is a symbolic link", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-docker-env-link-"));
    const target = path.join(workspace, "credential.txt");
    await fs.writeFile(target, "SECRET=hidden\n", "utf8");
    await fs.symlink(target, path.join(workspace, ".env"));

    expect(() => buildDockerCreateExecutionPlan(
      makeRequest({ workspaceRoot: workspace, cwd: workspace, writableRoots: [workspace] }),
      "research-runtime:local",
      {}
    )).toThrow("docker_workspace_secret_scan_failed");
  });
});

function makeRequest(
  overrides: Partial<AciExecutionEnvelopeRequest> = {}
): AciExecutionEnvelopeRequest {
  return {
    version: 1,
    envelopeId: "envelope-fixture",
    runId: "run-fixture",
    phase: "primary",
    attempt: 1,
    executionProfile: "docker",
    command: "printf result",
    commandSha256: "fixture-hash",
    workspaceRoot: "/workspace/project",
    cwd: "/workspace/project",
    writableRoots: ["/workspace/project"],
    environmentAllowlist: ["LANG"],
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
}

function inspectObservation(overrides: Record<string, unknown>): AciObservation {
  const base = {
    Id: "container-id",
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
      Source: "/workspace/project",
      Destination: "/workspace/project",
      RW: true
    }]
  };
  const merged = {
    ...base,
    ...overrides,
    Config: {
      ...base.Config,
      ...(overrides.Config as Record<string, unknown> | undefined)
    },
    HostConfig: {
      ...base.HostConfig,
      ...(overrides.HostConfig as Record<string, unknown> | undefined)
    }
  };
  return {
    status: "ok",
    stdout: JSON.stringify([merged]),
    duration_ms: 1
  };
}
