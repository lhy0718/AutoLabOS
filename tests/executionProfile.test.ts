import { describe, expect, it } from "vitest";

import {
  detectExecutionProfile,
  executionProfileToDependencyMode
} from "../src/runtime/executionProfile.js";

describe("detectExecutionProfile", () => {
  it("detects remote when AUTOLABOS_REMOTE_HOST is configured", async () => {
    const profile = await detectExecutionProfile({
      env: {
        AUTOLABOS_REMOTE_HOST: "gpu.example.internal"
      } as NodeJS.ProcessEnv,
      commandExists: async () => true
    });

    expect(profile).toBe("remote");
  });

  it("detects docker when DOCKER is configured", async () => {
    const profile = await detectExecutionProfile({
      env: {
        DOCKER: "autolabos-runtime"
      } as NodeJS.ProcessEnv,
      commandExists: async () => true
    });

    expect(profile).toBe("docker");
  });

  it("detects docker when an ephemeral execution image is configured", async () => {
    const profile = await detectExecutionProfile({
      env: {
        AUTOLABOS_DOCKER_IMAGE: "research-runtime:local"
      } as NodeJS.ProcessEnv,
      dockerEnvFile: "/tmp/nonexistent-dockerenv-for-test",
      commandExists: async () => true
    });

    expect(profile).toBe("docker");
  });

  it("detects plan_only when both pdflatex and python are unavailable", async () => {
    const profile = await detectExecutionProfile({
      env: {} as NodeJS.ProcessEnv,
      dockerEnvFile: "/tmp/nonexistent-dockerenv-for-test",
      commandExists: async () => false
    });

    expect(profile).toBe("plan_only");
  });

  it("defaults to local when no stronger profile matches", async () => {
    const profile = await detectExecutionProfile({
      env: {} as NodeJS.ProcessEnv,
      dockerEnvFile: "/tmp/nonexistent-dockerenv-for-test",
      commandExists: async (command) => command === "python3"
    });

    expect(profile).toBe("local");
  });
});

describe("executionProfile helpers", () => {
  it("maps execution profiles to existing doctor dependency modes", () => {
    expect(executionProfileToDependencyMode("local")).toBe("local");
    expect(executionProfileToDependencyMode("docker")).toBe("docker");
    expect(executionProfileToDependencyMode("remote")).toBe("remote_gpu");
    expect(executionProfileToDependencyMode("plan_only")).toBe("plan_only");
  });
});
