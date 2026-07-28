#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
      fail("Expected paired --key value arguments.");
    }
    values[key.slice(2)] = value;
  }
  for (const required of ["registry", "adjudication", "manifest", "repo-root", "worktree-root", "python", "output"]) {
    if (!values[required]) fail(`Missing --${required}`);
  }
  return values;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  const raw = readFileSync(path, "utf8");
  return { raw, value: JSON.parse(raw) };
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isContained(root, candidate) {
  const containedPath = relative(root, candidate);
  return containedPath !== ""
    && containedPath !== ".."
    && !containedPath.startsWith(`..${sep}`)
    && !isAbsolute(containedPath);
}

function resolveAdapter(adapterRoot, adapterReference) {
  const reference = requireString(adapterReference, "probe.adapter");
  if (isAbsolute(reference)) throw new Error(`Adapter path must be relative: ${reference}`);
  const adapter = resolve(adapterRoot, reference);
  if (!isContained(adapterRoot, adapter)) {
    throw new Error(`Adapter path escapes adapter root: ${reference}`);
  }
  if (extname(adapter) !== ".py") throw new Error(`Adapter must be a Python file: ${reference}`);
  const stat = lstatSync(adapter);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Adapter must be a regular, non-symlink file: ${reference}`);
  }
  return adapter;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ensureWorktree(repository, destination, commit) {
  if (existsSync(join(destination, ".git"))) {
    const observed = git(destination, ["rev-parse", "HEAD"]);
    if (observed !== commit) {
      throw new Error(`Existing worktree ${destination} is at ${observed}, expected ${commit}`);
    }
    return "reused";
  }
  mkdirSync(dirname(destination), { recursive: true });
  git(repository, ["worktree", "add", "--detach", destination, commit]);
  return "created";
}

function parseAdapterOutput(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`Adapter must emit exactly one non-empty JSON line; observed ${lines.length}`);
  }
  const parsed = JSON.parse(lines[0]);
  if (parsed.schema_version !== "1.0") {
    throw new Error("Adapter receipt must use schema_version 1.0");
  }
  if (typeof parsed.relation_holds !== "boolean") {
    throw new Error("Adapter receipt must include boolean relation_holds");
  }
  if (!parsed.observations || typeof parsed.observations !== "object" || Array.isArray(parsed.observations)) {
    throw new Error("Adapter receipt must include an observations object");
  }
  return parsed;
}

function executeAdapter(python, adapter, revisionRoot) {
  const started = process.hrtime.bigint();
  const result = spawnSync(
    python,
    [adapter, "--revision-root", revisionRoot],
    { encoding: "utf8", timeout: 120_000 },
  );
  const runtimeMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Adapter failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return {
    receipt: parseAdapterOutput(result.stdout),
    runtime_ms: runtimeMs,
    stderr_tail: result.stderr.slice(-1000),
  };
}

function atomicWrite(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${target.split("/").at(-1)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = readJson(resolve(args.registry));
  const adjudication = readJson(resolve(args.adjudication));
  const manifest = readJson(resolve(args.manifest));
  const repoRoot = resolve(args["repo-root"]);
  const worktreeRoot = resolve(args["worktree-root"]);
  const adapterRoot = resolve(args["adapter-root"] ?? process.cwd());

  if (registry.value.schema_version !== "1.0") throw new Error("Unsupported registry schema_version");
  if (adjudication.value.schema_version !== "1.0") {
    throw new Error("Unsupported adjudication schema_version");
  }
  if (manifest.value.schema_version !== "1.0" || !Array.isArray(manifest.value.probes)) {
    throw new Error("Manifest must use schema_version 1.0 and contain a probes array");
  }
  if (manifest.value.probes.length === 0) throw new Error("Manifest probes must be non-empty");

  const lineages = new Map(registry.value.lineages.map((item) => [item.id, item]));
  const admitted = new Set(
    adjudication.value.decisions
      .filter((item) => item.decision === "admit" || item.decision === "admit_as_one_cluster")
      .map((item) => item.id),
  );

  const probeIds = new Set();
  const validatedProbes = manifest.value.probes.map((probe) => {
    const lineageId = requireString(probe.lineage_id, "probe.lineage_id");
    if (probeIds.has(lineageId)) throw new Error(`Duplicate probe lineage: ${lineageId}`);
    probeIds.add(lineageId);
    requireString(probe.relation_family, `${lineageId}.relation_family`);
    requireString(probe.transformation_target, `${lineageId}.transformation_target`);
    requireString(probe.contract_source, `${lineageId}.contract_source`);
    return { ...probe, adapterPath: resolveAdapter(adapterRoot, probe.adapter) };
  });

  const results = [];
  for (const probe of validatedProbes) {
    const lineage = lineages.get(probe.lineage_id);
    if (!lineage) throw new Error(`Unknown lineage ${probe.lineage_id}`);
    if (!admitted.has(probe.lineage_id)) {
      throw new Error(`Probe ${probe.lineage_id} is not semantically admitted`);
    }
    if (probe.relation_family !== lineage.fault_family) {
      throw new Error(`Relation family mismatch for ${probe.lineage_id}`);
    }

    const source = registry.value.sources[lineage.source_id];
    if (!source) throw new Error(`Unknown source ${lineage.source_id} for ${lineage.id}`);
    if (!/^[a-zA-Z0-9._-]+$/.test(source.cache_key)) {
      throw new Error(`Unsafe source cache_key for ${lineage.source_id}`);
    }
    const repository = join(repoRoot, source.cache_key);
    const parentRoot = join(worktreeRoot, `${lineage.id}-parent`);
    const fixedRoot = join(worktreeRoot, `${lineage.id}-fixed`);
    const parentWorktree = ensureWorktree(repository, parentRoot, lineage.parent_commit);
    const fixedWorktree = ensureWorktree(repository, fixedRoot, lineage.fix_commit);
    const adapter = probe.adapterPath;

    const parent = executeAdapter(resolve(args.python), adapter, parentRoot);
    const fixed = executeAdapter(resolve(args.python), adapter, fixedRoot);
    results.push({
      lineage_id: lineage.id,
      source_id: lineage.source_id,
      relation_family: probe.relation_family,
      transformation_target: probe.transformation_target,
      contract_source: probe.contract_source,
      adapter_path: probe.adapter,
      adapter_sha256: sha256(readFileSync(adapter)),
      parent_commit: lineage.parent_commit,
      fix_commit: lineage.fix_commit,
      parent_worktree: parentWorktree,
      fixed_worktree: fixedWorktree,
      parent,
      fixed,
      historical_fault_detected: !parent.receipt.relation_holds && fixed.receipt.relation_holds,
      fixed_revision_false_alarm: !fixed.receipt.relation_holds,
      native_parent_test_status: "not_run",
    });
  }

  const outcomeSignature = results.map((item) => ({
    lineage_id: item.lineage_id,
    parent_relation_holds: item.parent.receipt.relation_holds,
    fixed_relation_holds: item.fixed.receipt.relation_holds,
    historical_fault_detected: item.historical_fault_detected,
    fixed_revision_false_alarm: item.fixed_revision_false_alarm,
  }));
  const pythonVersion = execFileSync(resolve(args.python), ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  const report = {
    schema_version: "1.0",
    artifact_type: "evaluator_conformance_bounded_probe_receipt",
    registry_sha256: sha256(registry.raw),
    adjudication_sha256: sha256(adjudication.raw),
    manifest_sha256: sha256(manifest.raw),
    runner_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    probe_count: results.length,
    source_count: new Set(results.map((item) => item.source_id)).size,
    detected_count: results.filter((item) => item.historical_fault_detected).length,
    fixed_revision_false_alarm_count: results.filter((item) => item.fixed_revision_false_alarm).length,
    behavioral_outcomes_included: true,
    development_after_initial_outcomes: manifest.value.development_after_initial_outcomes === true,
    outcome_signature_sha256: sha256(JSON.stringify(outcomeSignature)),
    execution_environment: {
      node_version: process.version,
      python_version: pythonVersion,
      platform: process.platform,
      architecture: process.arch,
    },
    paper_scale_claim_authorized: false,
    results,
  };
  atomicWrite(args.output, report);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
