#!/usr/bin/env node

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { auditMetricPolarityCorpus } from "../lib/corpus.mjs";

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
      fail("Expected --snapshot and optional --output arguments.");
    }
    args[key.slice(2)] = value;
  }
  if (!args.snapshot) fail("--snapshot is required.");
  return args;
}

function atomicWrite(path, payload) {
  const target = resolve(path);
  const temporary = join(
    dirname(target),
    `.${target.split("/").at(-1)}.${process.pid}.tmp`,
  );
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = resolve(args.snapshot);
  const metadataPath = join(snapshot, "data", "dev_task1_release.json");
  const metadataRaw = readFileSync(metadataPath, "utf8");
  const report = auditMetricPolarityCorpus({
    metadataRaw,
    tablesDirectory: join(snapshot, "data", "tables_json", "dev"),
    source: {
      dataset: "alabnii/sciclaimeval-shared-task",
      dataset_url:
        "https://huggingface.co/datasets/alabnii/sciclaimeval-shared-task",
      revision: "efb3807399acec43854fdf7741c1bcfe605a72b9",
      split: "dev",
      evidence_type: "table",
      label_filter: "Supported",
    },
  });
  if (args.output) atomicWrite(args.output, report);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
