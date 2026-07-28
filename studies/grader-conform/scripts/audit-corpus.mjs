#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
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
    if (!key?.startsWith("--") || value === undefined) {
      fail("Expected --registry, --repo-root, and optional --output arguments.");
    }
    values[key.slice(2)] = value;
  }
  if (!values.registry || !values["repo-root"]) {
    fail("Both --registry and --repo-root are required.");
  }
  return values;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function validateRegistry(registry) {
  if (registry?.schema_version !== "1.0") {
    throw new Error("Unsupported registry schema_version");
  }
  if (!registry.sources || typeof registry.sources !== "object") {
    throw new Error("Registry sources must be an object");
  }
  if (!Array.isArray(registry.lineages) || registry.lineages.length === 0) {
    throw new Error("Registry lineages must be a non-empty array");
  }

  const ids = new Set();
  for (const lineage of registry.lineages) {
    const id = requireString(lineage.id, "lineage.id");
    if (ids.has(id)) throw new Error(`Duplicate lineage id: ${id}`);
    ids.add(id);
    if (!registry.sources[lineage.source_id]) {
      throw new Error(`${id} references unknown source ${lineage.source_id}`);
    }
    requireString(lineage.parent_commit, `${id}.parent_commit`);
    requireString(lineage.fix_commit, `${id}.fix_commit`);
    requireString(lineage.fault_family, `${id}.fault_family`);
    if (!Array.isArray(lineage.evidence_paths) || lineage.evidence_paths.length === 0) {
      throw new Error(`${id}.evidence_paths must be non-empty`);
    }
  }
}

function atomicWrite(path, payload) {
  const target = resolve(path);
  const temporary = join(dirname(target), `.${target.split("/").at(-1)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const registryPath = resolve(args.registry);
  const repoRoot = resolve(args["repo-root"]);
  const raw = readFileSync(registryPath, "utf8");
  const registry = JSON.parse(raw);
  validateRegistry(registry);

  const sourceReceipts = {};
  for (const [sourceId, source] of Object.entries(registry.sources)) {
    const cacheKey = requireString(source.cache_key, `${sourceId}.cache_key`);
    if (!/^[a-zA-Z0-9._-]+$/.test(cacheKey)) {
      throw new Error(`${sourceId}.cache_key contains unsafe characters`);
    }
    const cwd = join(repoRoot, cacheKey);
    const remoteUrl = git(cwd, ["remote", "get-url", "origin"]);
    const license = git(cwd, ["show", `HEAD:${source.license_path}`]);
    sourceReceipts[sourceId] = {
      repository_url: source.repository_url,
      observed_remote_url: remoteUrl,
      remote_matches_registry: remoteUrl === source.repository_url,
      license: source.license,
      license_sha256: sha256(license),
    };
  }

  const lineageReceipts = registry.lineages.map((lineage) => {
    const source = registry.sources[lineage.source_id];
    const cwd = join(repoRoot, source.cache_key);
    const observedFix = git(cwd, ["rev-parse", `${lineage.fix_commit}^{commit}`]);
    const observedParent = git(cwd, ["rev-parse", `${lineage.fix_commit}^1`]);
    const metadata = git(cwd, [
      "show",
      "-s",
      "--format=%H%x00%P%x00%ct%x00%s",
      lineage.fix_commit,
    ]).split("\u0000");
    const changedPaths = git(cwd, [
      "diff",
      "--name-only",
      lineage.parent_commit,
      lineage.fix_commit,
    ]).split("\n").filter(Boolean);
    const evidencePathHit = lineage.evidence_paths.every((prefix) =>
      changedPaths.some((path) => path === prefix || path.startsWith(`${prefix}/`)),
    );
    const patch = git(cwd, [
      "diff",
      "--binary",
      lineage.parent_commit,
      lineage.fix_commit,
      "--",
      ...lineage.evidence_paths,
    ]);

    const structuralPass =
      observedFix === lineage.fix_commit &&
      observedParent === lineage.parent_commit &&
      evidencePathHit &&
      sourceReceipts[lineage.source_id].remote_matches_registry;

    return {
      id: lineage.id,
      source_id: lineage.source_id,
      fault_family: lineage.fault_family,
      observed_fix_commit: observedFix,
      observed_parent_commit: observedParent,
      commit_parents: metadata[1]?.split(" ").filter(Boolean) ?? [],
      commit_timestamp_unix: Number(metadata[2]),
      commit_subject: metadata[3],
      changed_paths: changedPaths,
      evidence_path_hit: evidencePathHit,
      evidence_patch_sha256: sha256(patch),
      structural_pass: structuralPass,
      behavioral_reproduction_status: "not_run",
      scientific_eligibility_status: "pending_manual_adjudication",
    };
  });

  const report = {
    schema_version: "1.0",
    artifact_type: "historical_evaluator_fault_structural_census",
    registry_path: args.registry,
    registry_sha256: sha256(raw),
    source_count: Object.keys(registry.sources).length,
    lineage_count: registry.lineages.length,
    structural_pass_count: lineageReceipts.filter((item) => item.structural_pass).length,
    behavioral_outcomes_included: false,
    source_receipts: sourceReceipts,
    lineage_receipts: lineageReceipts,
  };

  if (args.output) atomicWrite(args.output, report);
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
