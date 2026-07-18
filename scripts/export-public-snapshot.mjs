#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { exportPublicSourceSnapshot } from "./lib/public-source-snapshot.mjs";

const HELP = `Usage: node scripts/export-public-snapshot.mjs --out-dir <new-directory> [--ref <git-ref>]

Exports one clean Git revision without repository history. The output directory
must be new and outside the source checkout.`;

export function parsePublicSnapshotArgs(args) {
  const parsed = { outDir: undefined, ref: "HEAD", help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--out-dir" || arg === "--ref") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--out-dir") {
        parsed.outDir = value;
      } else {
        parsed.ref = value;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

async function main() {
  const args = parsePublicSnapshotArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const result = await exportPublicSourceSnapshot({
    cwd: process.cwd(),
    outDir: args.outDir,
    ref: args.ref
  });
  process.stdout.write(`${JSON.stringify({
    output_dir: result.output_dir,
    revision: result.source.revision,
    file_count: result.file_count,
    tree_sha256: result.tree_sha256,
    history_included: result.history_included,
    portable: result.scan.portable
  }, null, 2)}\n`);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`[public-snapshot] ${error.message}\n`);
    process.exitCode = 1;
  });
}
