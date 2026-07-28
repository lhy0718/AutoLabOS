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
    if (!key?.startsWith("--") || value === undefined) fail("Expected paired --key value arguments.");
    values[key.slice(2)] = value;
  }
  for (const required of ["receipts", "output"]) {
    if (!values[required]) fail(`Missing --${required}`);
  }
  return values;
}

function sha256(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function readReceipt(reference) {
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

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function requireShared(receipts, field) {
  const values = new Set(receipts.map((receipt) => receipt.value[field]));
  if (values.size !== 1) throw new Error(`Replay receipts disagree on ${field}`);
  return receipts[0].value[field];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const receipts = args.receipts.split(",").filter(Boolean).map(readReceipt);
  if (receipts.length < 2) throw new Error("At least two replay receipts are required");

  for (const receipt of receipts) {
    if (receipt.value.schema_version !== "1.0") throw new Error("Unsupported receipt schema_version");
    if (receipt.value.paper_scale_claim_authorized !== false) {
      throw new Error("Development replay unexpectedly authorizes paper-scale claims");
    }
  }

  const sharedFields = {};
  for (const field of [
    "registry_sha256",
    "adjudication_sha256",
    "manifest_sha256",
    "runner_sha256",
    "probe_count",
    "source_count",
    "outcome_signature_sha256",
  ]) {
    sharedFields[field] = requireShared(receipts, field);
  }

  const expectedIds = receipts[0].value.results.map((result) => result.lineage_id);
  const lineageSummaries = expectedIds.map((lineageId, index) => {
    const observations = receipts.map((receipt) => {
      const result = receipt.value.results[index];
      if (result?.lineage_id !== lineageId) {
        throw new Error(`Replay result order or membership differs at ${lineageId}`);
      }
      return result;
    });
    const parentRelations = new Set(observations.map((result) => result.parent.receipt.relation_holds));
    const fixedRelations = new Set(observations.map((result) => result.fixed.receipt.relation_holds));
    const detected = new Set(observations.map((result) => result.historical_fault_detected));
    const fixedFalseAlarms = new Set(observations.map((result) => result.fixed_revision_false_alarm));
    return {
      lineage_id: lineageId,
      relation_outcome_stable:
        parentRelations.size === 1
        && fixedRelations.size === 1
        && detected.size === 1
        && fixedFalseAlarms.size === 1,
      parent_relation_holds: observations[0].parent.receipt.relation_holds,
      fixed_relation_holds: observations[0].fixed.receipt.relation_holds,
      historical_fault_detected: observations[0].historical_fault_detected,
      fixed_revision_false_alarm: observations[0].fixed_revision_false_alarm,
      parent_runtime_ms_median: median(observations.map((result) => result.parent.runtime_ms)),
      fixed_runtime_ms_median: median(observations.map((result) => result.fixed.runtime_ms)),
    };
  });

  atomicWrite(args.output, {
    schema_version: "1.0",
    artifact_type: "evaluator_conformance_replay_summary",
    scientific_stage: "bounded_development",
    replay_count: receipts.length,
    ...sharedFields,
    relation_outcomes_stable: lineageSummaries.every((item) => item.relation_outcome_stable),
    all_historical_faults_reproduced: lineageSummaries.every((item) => item.historical_fault_detected),
    fixed_revision_false_alarm_count: lineageSummaries.filter((item) => item.fixed_revision_false_alarm).length,
    runtime_measurements_are_diagnostic_only: true,
    paper_scale_claim_authorized: false,
    provenance: receipts.map((receipt) => ({
      reference: receipt.reference,
      sha256: sha256(receipt.raw),
    })),
    lineages: lineageSummaries,
  });
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
