import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { hydrateProcessEnvFromWorkspace } from "../dist/config.js";
import {
  buildExecutionEnvelope,
  executeInEnvelope
} from "../dist/core/experiments/executionEnvelope.js";
import { LocalAciAdapter } from "../dist/tools/aciLocalAdapter.js";

async function main() {
  const cwd = process.cwd();
  await hydrateProcessEnvFromWorkspace(cwd);
  const options = parseArgs(process.argv.slice(2));
  const image = options.image || process.env.AUTOLABOS_DOCKER_IMAGE?.trim();
  if (!image) {
    throw new Error(
      "Set AUTOLABOS_DOCKER_IMAGE in .env or pass --image <image>."
    );
  }
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-docker-envelope-"));
  const secretRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-docker-secret-"));
  const secretPath = path.join(secretRoot, "validation.env");
  try {
    await fs.writeFile(path.join(workspace, "package-lock.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(workspace, ".env"), "MUST_BE_MASKED=true\n", "utf8");
    await fs.writeFile(secretPath, "VALIDATION_SECRET_FILE=mounted\n", {
      encoding: "utf8",
      mode: 0o600
    });
    const results = [];
    results.push(await runProbe({ workspace, image, secretPath, mode: "cpu" }));
    if (options.gpuIds.length > 0) {
      results.push(await runProbe({
        workspace,
        image,
        secretPath,
        mode: "gpu",
        gpuIds: options.gpuIds
      }));
    }
    const failed = results.filter((result) => !result.receipt.paper_grade_eligible);
    process.stdout.write(`${JSON.stringify({
      version: 1,
      image,
      status: failed.length === 0 ? "pass" : "fail",
      probes: results.map((result) => ({
        mode: result.mode,
        output: result.output,
        receipt: result.receipt
      }))
    }, null, 2)}\n`);
    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(secretRoot, { recursive: true, force: true });
  }
}

async function runProbe(input) {
  const outputDir = path.join(input.workspace, `output-${input.mode}`);
  const outputPath = path.join(outputDir, "result.txt");
  await fs.mkdir(outputDir, { recursive: true });
  const gpuIds = input.gpuIds || [];
  const boundaryChecks = [
    `test ! -s ${shellQuote(path.join(input.workspace, ".env"))}`,
    "grep -qx 'VALIDATION_SECRET_FILE=mounted' /run/secrets/validation.env"
  ];
  const command = input.mode === "cpu"
    ? [
        ...boundaryChecks,
        `printf '%s\\n' "$NVIDIA_VISIBLE_DEVICES" > ${shellQuote(outputPath)}`
      ].join(" && ")
    : [
        ...boundaryChecks,
        `test "$CUDA_VISIBLE_DEVICES" = ${shellQuote(gpuIds.join(","))}`,
        `nvidia-smi -L > ${shellQuote(outputPath)}`
      ].join(" && ");
  const envelope = await buildExecutionEnvelope({
    workspaceRoot: input.workspace,
    runId: `docker-envelope-${input.mode}`,
    phase: "primary",
    attempt: 1,
    executionProfile: "docker",
    containerImage: input.image,
    command,
    cwd: input.workspace,
    writableRoots: [outputDir],
    secretFileMounts: [{
      sourcePath: input.secretPath,
      targetName: "validation.env"
    }],
    expectedOutputs: [{ path: outputPath, required: true }],
    timeoutMs: 30_000,
    networkPolicy: "blocked",
    requestedGpuCount: gpuIds.length,
    visibleGpuDeviceIds: gpuIds
  });
  const result = await executeInEnvelope({
    aci: new LocalAciAdapter({ dockerImage: input.image }),
    envelope,
    scope: "command"
  });
  return {
    mode: input.mode,
    output: await fs.readFile(outputPath, "utf8").catch(() => ""),
    receipt: result.receipt
  };
}

function parseArgs(args) {
  let image;
  let gpuIds = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--image") {
      image = args[index + 1]?.trim();
      index += 1;
      continue;
    }
    if (args[index] === "--gpu-ids") {
      gpuIds = (args[index + 1] || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }
    throw new Error("Usage: npm run validation:docker-envelope -- [--image <image>] [--gpu-ids <ids>]");
  }
  if (gpuIds.some((id) => !/^\d+$/u.test(id)) || new Set(gpuIds).size !== gpuIds.length) {
    throw new Error("GPU IDs must be unique non-negative integer device indices.");
  }
  return { image, gpuIds };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
