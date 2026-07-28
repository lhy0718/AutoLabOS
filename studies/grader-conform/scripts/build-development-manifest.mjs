#!/usr/bin/env node

import { createHash } from "node:crypto";
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
    if (!key?.startsWith("--") || value === undefined) {
      fail("Expected paired --key value arguments.");
    }
    values[key.slice(2)] = value;
  }
  for (const required of ["base", "fragments", "output"]) {
    if (!values[required]) fail(`Missing --${required}`);
  }
  return values;
}

function sha256(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function readJson(reference) {
  const raw = readFileSync(resolve(reference), "utf8");
  return { reference, raw, value: JSON.parse(raw) };
}

function atomicWrite(reference, payload) {
  const target = resolve(reference);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${target.split("/").at(-1)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function validateDocument(document, label) {
  if (document.schema_version !== "1.0" || !Array.isArray(document.probes)) {
    throw new Error(`${label} must use schema_version 1.0 and contain a probes array`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = readJson(args.base);
  const fragments = args.fragments.split(",").filter(Boolean).map(readJson);
  if (fragments.length === 0) throw new Error("At least one fragment is required");

  validateDocument(base.value, "Base manifest");
  if (base.value.behavioral_outcomes_observed_before_freeze !== false) {
    throw new Error("Base manifest must predate behavioral outcome observation");
  }

  const probes = [...base.value.probes];
  const lineageIds = new Set(probes.map((probe) => probe.lineage_id));
  const provenance = [{
    role: "initial_preregistered_manifest",
    reference: base.reference,
    sha256: sha256(base.raw),
    probe_count: base.value.probes.length,
  }];

  for (const fragment of fragments) {
    validateDocument(fragment.value, `Fragment ${fragment.reference}`);
    if (fragment.value.development_after_initial_outcomes !== true) {
      throw new Error(`Fragment must declare development_after_initial_outcomes: ${fragment.reference}`);
    }
    for (const probe of fragment.value.probes) {
      if (lineageIds.has(probe.lineage_id)) {
        throw new Error(`Duplicate probe lineage across inputs: ${probe.lineage_id}`);
      }
      lineageIds.add(probe.lineage_id);
      probes.push(probe);
    }
    provenance.push({
      role: "post_outcome_development_fragment",
      reference: fragment.reference,
      sha256: sha256(fragment.raw),
      probe_count: fragment.value.probes.length,
    });
  }

  atomicWrite(args.output, {
    schema_version: "1.0",
    artifact_type: "evaluator_conformance_bounded_development_manifest",
    behavioral_outcomes_observed_before_freeze: true,
    development_after_initial_outcomes: true,
    confirmatory_use_authorized: false,
    initial_preregistered_probe_count: base.value.probes.length,
    development_probe_count: probes.length - base.value.probes.length,
    probe_count: probes.length,
    provenance,
    probes,
  });
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
