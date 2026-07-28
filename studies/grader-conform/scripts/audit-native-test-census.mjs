#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("Expected paired --key value arguments.");
    values[key.slice(2)] = value;
  }
  for (const required of ["registry", "spec", "repo-root", "output"]) {
    if (!values[required]) fail(`Missing --${required}`);
  }
  return values;
}

function sha256(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function readJson(reference) {
  const raw = readFileSync(resolve(reference), "utf8");
  return { raw, value: JSON.parse(raw) };
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function atomicWrite(reference, payload) {
  const target = resolve(reference);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${target.split("/").at(-1)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function isTestPath(path) {
  const lower = path.toLowerCase();
  const name = lower.split("/").at(-1);
  if (!/\.(?:py|js|mjs|cjs|ts|tsx|go|rs|java)$/u.test(name)) return false;
  return lower.includes("/tests/")
    || lower.startsWith("tests/")
    || lower.includes("/test/")
    || lower.startsWith("test/")
    || /^test[_-].*\.(?:py|js|mjs|cjs|ts|tsx)$/u.test(name)
    || /(?:^|[_-])test\.(?:py|js|mjs|cjs|ts|tsx)$/u.test(name)
    || /(?:^|[_-])test[_-].*\.(?:py|js|mjs|cjs|ts|tsx)$/u.test(name);
}

function compilePatterns(patterns, label) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  return patterns.map((pattern) => new RegExp(pattern, "iu"));
}

function findMatches(files, patterns) {
  const matches = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (patterns.some((pattern) => pattern.test(lines[index]))) {
        matches.push({ path: file.path, line: index + 1, text: lines[index].trim().slice(0, 300) });
      }
    }
  }
  return matches.slice(0, 100);
}

function findDirectPairs(implementationMatches, contractMatches, maximumLineDistance) {
  const pairs = [];
  for (const implementation of implementationMatches) {
    for (const contract of contractMatches) {
      const lineDistance = Math.abs(implementation.line - contract.line);
      if (implementation.path === contract.path && lineDistance <= maximumLineDistance) {
        pairs.push({
          path: implementation.path,
          implementation_line: implementation.line,
          contract_line: contract.line,
          line_distance: lineDistance,
        });
      }
    }
  }
  return pairs.slice(0, 100);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = readJson(args.registry);
  const spec = readJson(args.spec);
  if (registry.value.schema_version !== "1.0" || spec.value.schema_version !== "1.0") {
    throw new Error("Registry and spec must use schema_version 1.0");
  }
  const lineages = new Map(registry.value.lineages.map((lineage) => [lineage.id, lineage]));
  const repoRoot = resolve(args["repo-root"]);
  const assertionPatterns = compilePatterns(spec.value.runnable_test_signals, "runnable_test_signals");

  const receipts = spec.value.lineages.map((entry) => {
    const lineage = lineages.get(entry.lineage_id);
    if (!lineage) throw new Error(`Unknown lineage ${entry.lineage_id}`);
    const source = registry.value.sources[lineage.source_id];
    const cwd = join(repoRoot, source.cache_key);
    const tree = git(cwd, ["ls-tree", "-r", "--name-only", lineage.parent_commit])
      .split("\n")
      .filter(Boolean)
      .filter(isTestPath);
    const testFiles = tree.map((path) => ({
      path,
      content: git(cwd, ["show", `${lineage.parent_commit}:${path}`]),
    }));
    const runnableFiles = testFiles.filter((file) =>
      assertionPatterns.some((pattern) => pattern.test(file.content)));
    const implementationMatches = findMatches(
      runnableFiles,
      compilePatterns(entry.implementation_terms, `${entry.lineage_id}.implementation_terms`),
    );
    const contractMatches = findMatches(
      runnableFiles,
      compilePatterns(entry.contract_terms, `${entry.lineage_id}.contract_terms`),
    );
    const directPairs = findDirectPairs(
      implementationMatches,
      contractMatches,
      spec.value.maximum_direct_line_distance,
    );

    let censusStatus = "targeted_native_test_requires_execution";
    if (runnableFiles.length === 0) censusStatus = "no_runnable_parent_native_tests_discovered";
    else if (implementationMatches.length === 0 && contractMatches.length === 0) {
      censusStatus = "no_targeted_parent_native_test_discovered";
    } else if (directPairs.length === 0) {
      censusStatus = "no_co_located_contract_test_discovered";
    }

    return {
      lineage_id: lineage.id,
      source_id: lineage.source_id,
      parent_commit: lineage.parent_commit,
      test_file_count: testFiles.length,
      runnable_test_file_count: runnableFiles.length,
      implementation_match_count: implementationMatches.length,
      contract_match_count: contractMatches.length,
      direct_contract_pair_count: directPairs.length,
      implementation_matches: implementationMatches,
      contract_matches: contractMatches,
      direct_contract_pairs: directPairs,
      census_status: censusStatus,
      native_fault_detected: null,
      inference_boundary: "Static census cannot prove that an indirect or dynamically generated native test passes or fails.",
    };
  });

  atomicWrite(args.output, {
    schema_version: "1.0",
    artifact_type: "parent_native_test_static_census",
    registry_sha256: sha256(registry.raw),
    spec_sha256: sha256(spec.raw),
    lineage_count: receipts.length,
    no_direct_contract_test_count: receipts.filter((item) => item.direct_contract_pair_count === 0).length,
    execution_outcomes_included: false,
    paper_scale_baseline_complete: false,
    receipts,
  });
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
