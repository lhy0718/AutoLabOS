#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
  for (const required of ["plan", "input-root", "output-root"]) {
    if (!values[required]) fail(`Missing --${required}`);
  }
  return values;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(filePath) {
  const raw = readFileSync(filePath, "utf8");
  return { raw, value: JSON.parse(raw) };
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireHash(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function isContained(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function normalizeRelativePath(value, label) {
  const normalized = requireString(value, label).replaceAll("\\", "/");
  if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must be a contained relative path`);
  }
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} contains an invalid segment`);
  }
  return normalized;
}

function resolveInput(root, reference, label) {
  const realRoot = realpathSync(root);
  const portablePath = normalizeRelativePath(reference, label);
  const candidate = resolve(realRoot, portablePath);
  if (!isContained(realRoot, candidate)) throw new Error(`${label} escapes input root`);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const realCandidate = realpathSync(candidate);
  if (!isContained(realRoot, realCandidate)) throw new Error(`${label} resolves outside input root`);
  return { portablePath, realPath: realCandidate };
}

function validateOutputTarget(root) {
  const outputRoot = resolve(root);
  if (existsSync(outputRoot)) {
    const stat = lstatSync(outputRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Output root must be a directory");
    if (readdirSync(outputRoot).length > 0) throw new Error("Output root must be empty before sealing");
  }
  mkdirSync(dirname(outputRoot), { recursive: true });
  return outputRoot;
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, filePath);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

const OUTCOME_ACTORS = new Set(["method", "methods", "baseline", "baselines", "probe", "probes"]);
const STRONG_OUTCOME_TOKENS = new Set([
  "outcome",
  "outcomes",
  "result",
  "results",
  "detection",
  "detections",
  "detected",
  "detects",
  "hit",
  "hits",
  "miss",
  "misses",
  "verdict",
  "verdicts",
  "score",
  "scores",
  "accuracy",
  "precision",
  "recall",
]);
const AMBIGUOUS_OUTCOME_TOKENS = new Set(["status", "state", "passed", "failed", "success"]);
const DETECTION_DISPOSITION_TOKENS = new Set([
  "detected",
  "undetected",
  "missed",
  "hit",
  "hits",
  "miss",
  "misses",
  "found",
  "passed",
  "failed",
  "success",
  "failure",
  "positive",
  "negative",
  "matched",
  "unmatched",
  "triggered",
  "reproduced",
]);
const DETECTION_STATUS_VALUES = new Set([
  "not_detected",
  "not_found",
  "not_run",
  "not_executed",
  "not_applicable",
  "not_reproduced",
  "not_triggered",
]);
const NEGATIVE_BOUNDARY_TOKENS = new Set([
  "accessed",
  "included",
  "inspected",
  "observed",
  "seen",
]);

function structuredTokens(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function valueSignalsDetectionOutcome(value) {
  if (typeof value !== "string") return false;
  const tokens = structuredTokens(value);
  const canonicalValue = tokens.join("_");
  const hasDisposition = tokens.some((token) => DETECTION_DISPOSITION_TOKENS.has(token));
  const hasActor = tokens.some((token) => OUTCOME_ACTORS.has(token));
  const hasOutcome = tokens.some((token) => STRONG_OUTCOME_TOKENS.has(token));
  return DETECTION_STATUS_VALUES.has(canonicalValue) || hasDisposition || (hasActor && hasOutcome);
}

function assertNoEmbeddedOutcomeSignals(value, label, actorContext = false) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoEmbeddedOutcomeSignals(item, `${label}[${index}]`, actorContext);
    });
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    const fieldPath = `${label}.${key}`;
    const canonicalKey = structuredTokens(key).join("_");
    if (canonicalKey === "outcome_observed") {
      if (item !== false) {
        throw new Error(
          `${label} contains forbidden method/baseline/probe outcome field at ${fieldPath}; outcome_observed must be false`
        );
      }
      continue;
    }

    const tokens = structuredTokens(key);
    const firstActorIndex = tokens.findIndex((token) => OUTCOME_ACTORS.has(token));
    const firstStrongOutcomeIndex = tokens.findIndex((token) => STRONG_OUTCOME_TOKENS.has(token));
    const startsActorContext = firstActorIndex === 0;
    const nextActorContext = actorContext || startsActorContext;
    const actorThenOutcome = firstActorIndex >= 0
      && tokens.some((token, index) => index > firstActorIndex && STRONG_OUTCOME_TOKENS.has(token));
    const actorThenStatus = firstActorIndex >= 0
      && tokens.some((token, index) => index > firstActorIndex && AMBIGUOUS_OUTCOME_TOKENS.has(token));
    const negativeOutcomeBoundary = item === false
      && firstActorIndex >= 0
      && tokens.some((token, index) => (
        index > firstActorIndex && STRONG_OUTCOME_TOKENS.has(token)
      ))
      && tokens.some((token) => NEGATIVE_BOUNDARY_TOKENS.has(token));
    const detectionCompound = tokens.includes("detection")
      && tokens.some((token) => ["outcome", "result", "status", "verdict", "score"].includes(token));
    const definitiveDispositionKey = nextActorContext
      && tokens.some((token) => ["detected", "hit", "hits", "miss", "misses"].includes(token));
    const strongOutcomeInActorContext = nextActorContext && firstStrongOutcomeIndex >= 0;
    const ambiguousOutcomeKey = tokens.some((token) => AMBIGUOUS_OUTCOME_TOKENS.has(token));
    const ambiguousOutcomeInActorContext = nextActorContext && ambiguousOutcomeKey;
    const detectionMethodDescriptor = tokens[0] === "detection"
      && ["method", "methods"].includes(tokens[1])
      && !tokens.slice(2).some((token) => (
        STRONG_OUTCOME_TOKENS.has(token) || AMBIGUOUS_OUTCOME_TOKENS.has(token)
      ));
    const stringOutcomeUnderStructuredKey = nextActorContext
      && valueSignalsDetectionOutcome(item);
    const scalarOutcomeUnderActorKey = (typeof item === "boolean" || typeof item === "number")
      && nextActorContext
      && (firstStrongOutcomeIndex >= 0 || ambiguousOutcomeKey);
    const outcomeValueUnderStructuredKey = !detectionMethodDescriptor
      && (stringOutcomeUnderStructuredKey || scalarOutcomeUnderActorKey);

    if (negativeOutcomeBoundary) continue;

    if (actorThenOutcome
      || actorThenStatus
      || detectionCompound
      || definitiveDispositionKey
      || strongOutcomeInActorContext
      || ambiguousOutcomeInActorContext
      || outcomeValueUnderStructuredKey) {
      throw new Error(`${label} contains forbidden method/baseline/probe outcome field at ${fieldPath}`);
    }
    assertNoEmbeddedOutcomeSignals(item, fieldPath, nextActorContext);
  }
}

function validateOutputLayout(groups) {
  const seen = new Map([["manifest.json", "manifest.json"]]);
  return groups.map((group, index) => {
    const groupId = normalizeRelativePath(group.group_id, `groups[${index}].group_id`);
    if (groupId.includes("/")) throw new Error("group_id must be one portable path segment");
    const filename = `${groupId}.json`;
    const collisionKey = filename.normalize("NFC").toLowerCase();
    const existing = seen.get(collisionKey);
    if (existing === "manifest.json") {
      throw new Error(`group_id ${groupId} collides with reserved output manifest.json`);
    }
    if (existing !== undefined) {
      throw new Error(`Seal plan output filename collision: ${existing} and ${filename}`);
    }
    seen.set(collisionKey, filename);
    return groupId;
  });
}

function sanitizeCensus(census) {
  const localMetadataKeys = new Set([
    "path",
    "mirror_path",
    "cache_path",
    "clone_path",
    "local_path",
    "repository_path",
  ]);
  function sanitize(value) {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      if (localMetadataKeys.has(key)
        && typeof item === "string"
        && (item.startsWith("/") || /^[A-Za-z]:\\/u.test(item))) {
        return [];
      }
      return [[key, sanitize(item)]];
    }));
  }
  return sanitize(structuredClone(census));
}

function assertPortable(value, label = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPortable(item, `${label}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertPortable(item, `${label}.${key}`);
    return;
  }
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  const isStandaloneTemporaryPath = /^\/tmp\/\S+$/u.test(trimmed);
  if (/(?:^|[\s"'])\/(?:home|Users|private\/tmp)\//u.test(value)
    || /(?:^|[\s"'])[A-Za-z]:\\/u.test(value)
    || isStandaloneTemporaryPath) {
    throw new Error(`Machine-local absolute path remains at ${label}`);
  }
}

function normalizeDecision(decision, candidate, label) {
  const verdict = decision.decision;
  if (verdict !== "admit" && verdict !== "exclude") {
    throw new Error(`${label}.decision must be admit or exclude`);
  }
  return {
    candidate_id: candidate.candidate_id,
    source_id: candidate.source_id,
    decision: verdict,
    reason: requireString(decision.reason, `${label}.reason`),
    root_cause_family: requireString(
      decision.root_cause_family
        ?? decision.fault_class
        ?? decision.exclusion_class
        ?? candidate.root_cause_cluster,
      `${label}.root_cause_family`
    ),
    duplicate_of: decision.duplicate_of ?? null,
    adjudication_details: decision,
  };
}

function sealGroup(group, inputRoot, groupId) {
  const censusFile = resolveInput(inputRoot, group.census.path, `${groupId}.census.path`);
  const census = readJson(censusFile.realPath);
  const censusHash = sha256(census.raw);
  if (censusHash !== requireHash(group.census.sha256, `${groupId}.census.sha256`)) {
    throw new Error(`${groupId} census bytes drifted from the seal plan`);
  }
  if (census.value.schema_version !== "1.0"
    || census.value.status !== "complete"
    || census.value.exhaustive_within_queries !== true
    || census.value.outcome_observed !== false
    || !Array.isArray(census.value.candidates)
    || !Array.isArray(census.value.exclusions)) {
    throw new Error(`${groupId} census is not a complete pre-outcome census`);
  }
  assertNoEmbeddedOutcomeSignals(census.value, `${groupId}.census`);
  const candidates = new Map();
  for (const [index, candidate] of census.value.candidates.entries()) {
    const candidateId = requireString(candidate.candidate_id, `${groupId}.candidates[${index}].candidate_id`);
    requireString(candidate.source_id, `${groupId}.${candidateId}.source_id`);
    if (candidates.has(candidateId)) throw new Error(`${groupId} duplicate census candidate ${candidateId}`);
    candidates.set(candidateId, candidate);
  }
  if (!Array.isArray(group.adjudications) || group.adjudications.length === 0) {
    throw new Error(`${groupId} must bind at least one adjudication`);
  }
  const decisions = new Map();
  const adjudicationBindings = [];
  for (const [fileIndex, binding] of group.adjudications.entries()) {
    const file = resolveInput(inputRoot, binding.path, `${groupId}.adjudications[${fileIndex}].path`);
    const adjudication = readJson(file.realPath);
    const hash = sha256(adjudication.raw);
    if (hash !== requireHash(binding.sha256, `${groupId}.adjudications[${fileIndex}].sha256`)) {
      throw new Error(`${groupId} adjudication bytes drifted from the seal plan`);
    }
    if (adjudication.value.schema_version !== "1.0"
      || adjudication.value.status !== "complete"
      || adjudication.value.outcome_observed !== false
      || !Array.isArray(adjudication.value.decisions)) {
      throw new Error(`${groupId} adjudication ${file.portablePath} lacks a complete pre-outcome contract`);
    }
    assertNoEmbeddedOutcomeSignals(
      adjudication.value,
      `${groupId}.adjudications[${fileIndex}]`
    );
    if (adjudication.value.input_census_sha256 !== undefined
      && adjudication.value.input_census_sha256 !== censusHash) {
      throw new Error(`${groupId} adjudication declares the wrong census hash`);
    }
    for (const [decisionIndex, decision] of adjudication.value.decisions.entries()) {
      const candidateId = requireString(
        decision.candidate_id,
        `${groupId}.adjudications[${fileIndex}].decisions[${decisionIndex}].candidate_id`
      );
      const candidate = candidates.get(candidateId);
      if (!candidate) throw new Error(`${groupId} adjudicates unknown candidate ${candidateId}`);
      if (decisions.has(candidateId)) throw new Error(`${groupId} adjudicates ${candidateId} more than once`);
      decisions.set(
        candidateId,
        normalizeDecision(decision, candidate, `${groupId}.${candidateId}`)
      );
    }
    adjudicationBindings.push({
      source_path: file.portablePath,
      source_sha256: hash,
      source_bytes: statSync(file.realPath).size,
      declared_census_binding_present: adjudication.value.input_census_sha256 !== undefined,
    });
  }
  if (!sameSet(new Set(decisions.keys()), new Set(candidates.keys()))) {
    const missing = [...candidates.keys()].filter((candidateId) => !decisions.has(candidateId));
    throw new Error(`${groupId} candidates missing exactly-one adjudication: ${missing.join(", ")}`);
  }
  for (const [candidateId, decision] of decisions) {
    if (decision.duplicate_of === null) continue;
    const duplicateOf = requireString(decision.duplicate_of, `${groupId}.${candidateId}.duplicate_of`);
    if (duplicateOf === candidateId) throw new Error(`${groupId}.${candidateId} duplicates itself`);
    const canonical = decisions.get(duplicateOf);
    if (!canonical) throw new Error(`${groupId}.${candidateId} duplicates an unknown candidate`);
    if (decision.decision !== "exclude" || canonical.duplicate_of !== null) {
      throw new Error(`${groupId}.${candidateId} duplicate_of must point from exclude to a canonical item`);
    }
  }
  const sanitizedCensus = sanitizeCensus(census.value);
  const {
    candidates: sanitizedCandidates,
    exclusions: sanitizedExclusions,
    ...censusMetadata
  } = sanitizedCensus;
  const normalizedDecisions = [...candidates.keys()].map((candidateId) => decisions.get(candidateId));
  const sealed = {
    schema_version: "1.0",
    artifact_type: "sealed_heldout_census_and_adjudication",
    status: "complete",
    exhaustive_within_queries: true,
    group_id: groupId,
    source_census: {
      source_path: censusFile.portablePath,
      source_sha256: censusHash,
      source_bytes: statSync(censusFile.realPath).size,
    },
    source_adjudications: adjudicationBindings,
    outcome_observed: false,
    method_or_baseline_outcomes_included: false,
    candidate_accounting: {
      census_candidate_count: candidates.size,
      admitted_candidate_count: normalizedDecisions.filter((decision) => decision.decision === "admit").length,
      excluded_candidate_count: normalizedDecisions.filter((decision) => decision.decision === "exclude").length,
      search_exclusion_count: sanitizedExclusions.length,
      every_candidate_adjudicated_exactly_once: true,
    },
    census_metadata: censusMetadata,
    candidates: sanitizedCandidates,
    exclusions: sanitizedExclusions,
    decisions: normalizedDecisions,
  };
  assertPortable(sealed);
  return sealed;
}

function publishSealedEvidence(outputRootArgument, sealedGroups, sealPlanRaw) {
  const outputRoot = validateOutputTarget(outputRootArgument);
  const stagingRoot = mkdtempSync(`${outputRoot}.staging-`);
  let published = false;
  try {
    const artifacts = [];
    for (const sealed of sealedGroups) {
      const filename = `${sealed.group_id}.json`;
      const stagingPath = resolve(stagingRoot, filename);
      atomicWriteJson(stagingPath, sealed);
      artifacts.push({
        group_id: sealed.group_id,
        path: filename,
        sha256: sha256(readFileSync(stagingPath)),
        bytes: statSync(stagingPath).size,
        candidate_accounting: sealed.candidate_accounting,
      });
    }
    const manifest = {
      schema_version: "1.0",
      artifact_type: "sealed_heldout_evidence_manifest",
      seal_plan_sha256: sha256(sealPlanRaw),
      frozen_before_probe_design: true,
      method_outcomes_observed: false,
      baseline_outcomes_observed: false,
      closed_inventory: true,
      artifacts,
    };
    atomicWriteJson(resolve(stagingRoot, "manifest.json"), manifest);
    renameSync(stagingRoot, outputRoot);
    published = true;
    return manifest;
  } finally {
    if (!published && existsSync(stagingRoot)) {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  const plan = readJson(args.plan);
  if (plan.value.schema_version !== "1.0"
    || plan.value.artifact_type !== "heldout_evidence_seal_plan"
    || plan.value.frozen_before_probe_design !== true
    || plan.value.method_outcomes_observed !== false
    || plan.value.baseline_outcomes_observed !== false
    || !Array.isArray(plan.value.groups)
    || plan.value.groups.length === 0) {
    throw new Error("Seal plan must be frozen before probe design and outcomes");
  }
  const groupIds = validateOutputLayout(plan.value.groups);
  const inputRoot = realpathSync(args["input-root"]);
  const sealedGroups = plan.value.groups.map((group, index) => (
    sealGroup(group, inputRoot, groupIds[index])
  ));
  const manifest = publishSealedEvidence(args["output-root"], sealedGroups, plan.raw);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
