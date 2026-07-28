#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { analyzeEvaluatorSensitivity } from "../lib/analyze.mjs";

const USAGE = [
  "Usage:",
  "  node studies/reviewer-evaluator-audit/scripts/analyze-evaluator-sensitivity.mjs \\",
  "    --protocol <protocol.v1.json> \\",
  "    --input <combined-evaluator-artifact.json> \\",
  "    --output <analysis-artifact.json>",
].join("\n");

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const protocol = JSON.parse(await readFile(args.protocol, "utf8"));
  const input = JSON.parse(await readFile(args.input, "utf8"));
  const artifact = analyzeEvaluatorSensitivity({ protocol, input });
  await writeJsonAtomically(args.output, artifact);
  process.stdout.write(`${JSON.stringify({
    output: args.output,
    analysis_status: artifact.analysis_status,
    content_sha256: artifact.content_sha256,
    failure_count: artifact.failures.length,
  })}\n`);
  if (artifact.analysis_status === "blocked") process.exitCode = 2;
}

function parseArguments(values) {
  if (values.includes("--help") || values.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const allowed = new Set(["--protocol", "--input", "--output"]);
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!allowed.has(flag) || typeof value !== "string"
      || value.startsWith("--")) {
      throw new Error(`${USAGE}\n\nInvalid argument near: ${flag ?? "<end>"}`);
    }
    const key = flag.slice(2);
    if (parsed[key]) throw new Error(`Duplicate argument: ${flag}`);
    parsed[key] = resolve(value);
  }
  for (const key of ["protocol", "input", "output"]) {
    if (!parsed[key]) throw new Error(`${USAGE}\n\nMissing --${key}`);
  }
  return parsed;
}

async function writeJsonAtomically(outputPath, artifact) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, outputPath);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
