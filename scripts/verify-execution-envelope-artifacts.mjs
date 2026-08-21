#!/usr/bin/env node

import path from "node:path";
import { promises as fs } from "node:fs";

import { auditExecutionEnvelopeArtifacts } from "../dist/core/experiments/executionEnvelope.js";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [artifact, receipt] = await Promise.all([
    readJson(options.envelope),
    readJson(options.receipt)
  ]);
  const audit = await auditExecutionEnvelopeArtifacts({
    artifact,
    receipt,
    workspaceRoot: options.workspace
  });
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  if (!audit.valid) {
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(
        "Usage: verify-execution-envelope-artifacts --envelope FILE --receipt FILE --workspace DIR"
      );
    }
    values.set(name.slice(2), value);
  }
  const envelope = values.get("envelope");
  const receipt = values.get("receipt");
  const workspace = values.get("workspace");
  if (
    values.size !== 3
    || !envelope
    || !receipt
    || !workspace
  ) {
    throw new Error(
      "Usage: verify-execution-envelope-artifacts --envelope FILE --receipt FILE --workspace DIR"
    );
  }
  return {
    envelope: path.resolve(envelope),
    receipt: path.resolve(receipt),
    workspace: path.resolve(workspace)
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
