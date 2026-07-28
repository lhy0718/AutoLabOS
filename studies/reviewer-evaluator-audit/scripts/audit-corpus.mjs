#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { auditCorpus } from "../lib/corpus.mjs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail("Expected --config, --corpus-root, and optional --output arguments.");
    }
    args[key.slice(2)] = value;
  }
  if (!args.config) fail("--config is required.");
  if (!args["corpus-root"]) fail("--corpus-root is required.");
  return args;
}

function atomicWrite(filePath, value) {
  const target = resolve(filePath);
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(resolve(args.config), "utf8"));
  const report = auditCorpus({
    config,
    corpusRoot: resolve(args["corpus-root"]),
  });
  if (args.output) atomicWrite(args.output, report);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
