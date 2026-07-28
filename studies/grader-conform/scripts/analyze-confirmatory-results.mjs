#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
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
    if (!key?.startsWith("--") || value === undefined) {
      fail("Expected paired --key value arguments.");
    }
    values[key.slice(2)] = value;
  }
  for (const required of [
    "input",
    "protocol",
    "source-freeze",
    "source-plan",
    "registry",
    "packets",
    "probe-manifest",
    "baseline-manifest",
    "evidence-root",
    "snapshot-root",
    "receipt-root",
    "output",
  ]) {
    if (!values[required]) fail(`Missing --${required}`);
  }
  return values;
}

function readJson(filePath) {
  const raw = readFileSync(filePath, "utf8");
  return { raw, value: JSON.parse(raw) };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
  );
}

function canonicalHash(value) {
  return sha256(JSON.stringify(canonicalize(value)));
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

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function requireNonnegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value;
}

function requireNonnegativeNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite nonnegative number`);
  }
  return value;
}

function round(value) {
  return Number(value.toFixed(12));
}

function mean(values) {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isContained(root, candidate) {
  const containedPath = relative(root, candidate);
  return containedPath !== ""
    && containedPath !== ".."
    && !containedPath.startsWith(`..${sep}`)
    && !isAbsolute(containedPath);
}

function normalizeRelativePath(value, label) {
  const normalized = requireString(value, label).replaceAll("\\", "/");
  if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must be a contained relative path`);
  }
  if (normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an invalid path segment`);
  }
  return normalized;
}

function readBoundJson(binding, root, label) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error(`${label} must be a receipt binding`);
  }
  const realRoot = realpathSync(root);
  const reference = normalizeRelativePath(binding.path, `${label}.path`);
  const candidate = resolve(realRoot, reference);
  if (!isContained(realRoot, candidate)) throw new Error(`${label}.path escapes receipt root`);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label}.path must reference a regular non-symlink file`);
  }
  const realCandidate = realpathSync(candidate);
  if (!isContained(realRoot, realCandidate)) {
    throw new Error(`${label}.path resolves outside receipt root`);
  }
  const receipt = readJson(realCandidate);
  if (sha256(receipt.raw) !== requireHash(binding.sha256, `${label}.sha256`)) {
    throw new Error(`${label}.sha256 does not match receipt bytes`);
  }
  return receipt.value;
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function readExact(descriptor, position, length, label) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = readSync(descriptor, buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error(`Unexpected end of tar while reading ${label}`);
    offset += bytesRead;
  }
  return buffer;
}

function hashFileRange(descriptor, position, length) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, length)));
  let consumed = 0;
  while (consumed < length) {
    const requested = Math.min(buffer.length, length - consumed);
    const bytesRead = readSync(descriptor, buffer, 0, requested, position + consumed);
    if (bytesRead === 0) throw new Error("Unexpected end of tar payload");
    hash.update(buffer.subarray(0, bytesRead));
    consumed += bytesRead;
  }
  return hash.digest("hex");
}

function tarString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul < 0 ? field.length : nul).toString("utf8");
}

function tarNumber(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) throw new Error(`Binary tar numbers are unsupported for ${label}`);
  const text = field.toString("ascii").replaceAll("\0", "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text)) throw new Error(`Invalid tar number for ${label}`);
  return Number.parseInt(text, 8);
}

function verifyTarChecksum(header, label) {
  const expected = tarNumber(header, 148, 8, `${label}.checksum`);
  let observed = 0;
  for (let index = 0; index < header.length; index += 1) {
    observed += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (observed !== expected) throw new Error(`Tar checksum mismatch for ${label}`);
}

function parsePax(buffer, label) {
  const values = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error(`Invalid PAX record length in ${label}`);
    const lengthText = buffer.subarray(offset, space).toString("ascii");
    if (!/^[0-9]+$/u.test(lengthText)) throw new Error(`Invalid PAX record length in ${label}`);
    const recordLength = Number.parseInt(lengthText, 10);
    if (recordLength <= 0 || offset + recordLength > buffer.length) {
      throw new Error(`PAX record exceeds payload in ${label}`);
    }
    const record = buffer.subarray(space + 1, offset + recordLength - 1);
    const equals = record.indexOf(0x3d);
    if (equals < 1) throw new Error(`Invalid PAX key/value in ${label}`);
    values[record.subarray(0, equals).toString("utf8")] = record.subarray(equals + 1).toString("utf8");
    offset += recordLength;
  }
  return values;
}

function normalizeTarPath(value, label) {
  let normalized = requireString(value, label).replaceAll("\\", "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  if (normalized === "") return "";
  return normalizeRelativePath(normalized, label);
}

function parseTarArchive(filePath) {
  const descriptor = openSync(filePath, "r");
  const archiveBytes = statSync(filePath).size;
  const entries = [];
  let position = 0;
  let longPath = null;
  let longLink = null;
  let globalPax = {};
  let localPax = {};
  let sawTerminator = false;
  try {
    while (position + 512 <= archiveBytes) {
      const header = readExact(descriptor, position, 512, `header at ${position}`);
      if (header.every((byte) => byte === 0)) {
        const second = position + 1024 <= archiveBytes
          ? readExact(descriptor, position + 512, 512, "second zero terminator")
          : null;
        if (!second || !second.every((byte) => byte === 0)) {
          throw new Error("Tar archive lacks the required two-block terminator");
        }
        const remainder = archiveBytes - position - 1024;
        if (remainder > 0
          && !readExact(descriptor, position + 1024, remainder, "tar padding").every((byte) => byte === 0)) {
          throw new Error("Tar archive contains non-zero bytes after its terminator");
        }
        sawTerminator = true;
        break;
      }
      verifyTarChecksum(header, `entry at ${position}`);
      const headerSize = tarNumber(header, 124, 12, `entry at ${position}.size`);
      const typeFlag = String.fromCharCode(header[156] || 0x30);
      const payloadPosition = position + 512;
      if (payloadPosition + headerSize > archiveBytes) throw new Error("Tar payload exceeds archive bytes");
      const prefix = tarString(header, 345, 155);
      const shortName = tarString(header, 0, 100);
      const headerPath = prefix ? `${prefix}/${shortName}` : shortName;
      if (["L", "K", "x", "g"].includes(typeFlag)) {
        if (headerSize > 1024 * 1024) throw new Error("Tar metadata payload exceeds one MiB");
        const metadata = readExact(descriptor, payloadPosition, headerSize, "tar metadata payload");
        if (typeFlag === "L") longPath = metadata.toString("utf8").replace(/\0+$/u, "");
        if (typeFlag === "K") longLink = metadata.toString("utf8").replace(/\0+$/u, "");
        if (typeFlag === "x") localPax = parsePax(metadata, "local PAX header");
        if (typeFlag === "g") globalPax = { ...globalPax, ...parsePax(metadata, "global PAX header") };
      } else {
        const pax = { ...globalPax, ...localPax };
        const entryPath = normalizeTarPath(pax.path ?? longPath ?? headerPath, "tar entry path");
        const linkTarget = pax.linkpath ?? longLink ?? tarString(header, 157, 100);
        if (typeFlag === "2") {
          const normalizedLinkTarget = requireString(linkTarget, `${entryPath}.symlink_target`);
          if (isAbsolute(normalizedLinkTarget)) {
            throw new Error(`Tar symlink target is absolute at ${entryPath}`);
          }
          const virtualRoot = "/__sealed_snapshot_root__";
          const resolvedLinkTarget = resolve(virtualRoot, dirname(entryPath), normalizedLinkTarget);
          if (resolvedLinkTarget !== virtualRoot && !isContained(virtualRoot, resolvedLinkTarget)) {
            throw new Error(`Tar symlink escapes snapshot root at ${entryPath}`);
          }
        }
        const mode = tarNumber(header, 100, 8, `${entryPath || "."}.mode`) & 0o777;
        if (!["0", "2", "5"].includes(typeFlag)) {
          throw new Error(`Unsupported tar entry type ${JSON.stringify(typeFlag)} at ${entryPath}`);
        }
        entries.push({
          path: entryPath,
          type: typeFlag === "2" ? "symlink" : typeFlag === "5" ? "directory" : "file",
          mode,
          bytes: typeFlag === "2" ? Buffer.byteLength(linkTarget, "utf8") : headerSize,
          contentSha256: typeFlag === "0"
            ? hashFileRange(descriptor, payloadPosition, headerSize)
            : typeFlag === "2"
              ? sha256(Buffer.from(linkTarget, "utf8"))
              : null,
          linkTarget: typeFlag === "2" ? linkTarget : null,
        });
        longPath = null;
        longLink = null;
        localPax = {};
      }
      position = payloadPosition + Math.ceil(headerSize / 512) * 512;
    }
  } finally {
    closeSync(descriptor);
  }
  if (!sawTerminator) throw new Error("Tar archive has no complete terminator");
  const paths = entries.map((entry) => `${entry.type}\0${entry.path}`);
  if (new Set(paths).size !== paths.length) throw new Error("Tar archive contains duplicate entries");
  return entries;
}

function verifySnapshotSemantics(archivePath, manifestPath, label) {
  const manifest = readJson(manifestPath).value;
  if (manifest.schema_version !== "1.0"
    || manifest.artifact_type !== "history_free_git_tree_snapshot_manifest"
    || !Array.isArray(manifest.entries)
    || manifest.entry_count !== manifest.entries.length) {
    throw new Error(`${label} snapshot manifest contract is invalid`);
  }
  const manifestByPath = new Map();
  for (const [index, entry] of manifest.entries.entries()) {
    const entryPath = normalizeRelativePath(entry.path, `${label}.manifest.entries[${index}].path`);
    if (manifestByPath.has(entryPath)) throw new Error(`${label} manifest contains duplicate path ${entryPath}`);
    if (!/^[a-f0-9]{40,64}$/u.test(entry.git_object_id ?? "")) {
      throw new Error(`${label} manifest has invalid Git object ID for ${entryPath}`);
    }
    manifestByPath.set(entryPath, entry);
  }
  const archiveEntries = parseTarArchive(archivePath);
  const archiveByPath = new Map();
  for (const entry of archiveEntries) {
    if (entry.path === "") continue;
    if (archiveByPath.has(entry.path)) throw new Error(`${label} archive repeats path ${entry.path}`);
    archiveByPath.set(entry.path, entry);
  }
  for (const [entryPath, expected] of manifestByPath) {
    const observed = archiveByPath.get(entryPath);
    const expectedType = expected.type === "gitlink" ? "directory" : expected.type;
    if (!observed || observed.type !== expectedType) {
      throw new Error(`${label} archive type does not match manifest for ${entryPath}`);
    }
    if (expected.type === "gitlink") {
      const descendants = [...archiveByPath.keys()].filter((path) => path.startsWith(`${entryPath}/`));
      if (descendants.length > 0) throw new Error(`${label} gitlink is not empty in archive: ${entryPath}`);
      continue;
    }
    const expectedMode = expected.mode === "100755" ? 0o755 : expected.mode === "100644" ? 0o644 : null;
    if (expected.type === "file" && expectedMode === null) {
      throw new Error(`${label} manifest has invalid file mode for ${entryPath}`);
    }
    if (expected.type === "file" && observed.mode !== expectedMode) {
      throw new Error(`${label} archive mode does not match manifest for ${entryPath}`);
    }
    if (expected.type === "symlink" && expected.mode !== "120000") {
      throw new Error(`${label} manifest has invalid symlink mode for ${entryPath}`);
    }
    if (observed.bytes !== requireNonnegativeInteger(expected.bytes, `${label}.${entryPath}.bytes`)
      || observed.contentSha256 !== requireHash(
        expected.content_sha256,
        `${label}.${entryPath}.content_sha256`
      )) {
      throw new Error(`${label} archive content does not match manifest for ${entryPath}`);
    }
  }
  for (const [entryPath, observed] of archiveByPath) {
    if (manifestByPath.has(entryPath)) continue;
    if (observed.type !== "directory") {
      throw new Error(`${label} archive contains unmanifested payload ${entryPath}`);
    }
    const isStructuralDirectory = [...manifestByPath.keys()].some((path) => path.startsWith(`${entryPath}/`));
    if (!isStructuralDirectory) throw new Error(`${label} archive contains unmanifested directory ${entryPath}`);
  }
}

function resolveBoundFile(root, reference, label) {
  const realRoot = realpathSync(root);
  const portablePath = normalizeRelativePath(reference, label);
  const candidate = resolve(realRoot, portablePath);
  if (!isContained(realRoot, candidate)) throw new Error(`${label} escapes its root`);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must reference a regular non-symlink file`);
  }
  const realCandidate = realpathSync(candidate);
  if (!isContained(realRoot, realCandidate)) throw new Error(`${label} resolves outside its root`);
  return { portablePath, realPath: realCandidate };
}

function walkRegularFiles(root, current = realpathSync(root)) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Closed inventory contains symlink: ${absolute}`);
    if (entry.isDirectory()) return walkRegularFiles(root, absolute);
    if (!entry.isFile()) throw new Error(`Closed inventory contains non-file: ${absolute}`);
    return [relative(realpathSync(root), absolute).split(sep).join("/")];
  });
}

function assertClosedReceiptInventory(receiptRoot, inputLineages) {
  const references = [];
  for (const lineage of inputLineages) {
    references.push(lineage.method?.parent?.path, lineage.method?.fixed?.path);
    for (const binding of Object.values(lineage.baselines ?? {})) {
      if (binding !== null && typeof binding === "object") {
        references.push(binding.parent?.path, binding.fixed?.path);
      }
    }
  }
  const expected = references.map((reference, index) =>
    normalizeRelativePath(reference, `receipt inventory binding[${index}]`)
  );
  if (new Set(expected).size !== expected.length) {
    throw new Error("Receipt inventory reuses a path across execution roles");
  }
  const observed = walkRegularFiles(receiptRoot).sort();
  expected.sort();
  if (observed.length !== expected.length
    || observed.some((reference, index) => reference !== expected[index])) {
    throw new Error("Receipt root does not match the closed receipt index inventory");
  }
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function assertExactIds(observedValues, expectedValues, label) {
  const observed = new Set(observedValues);
  const expected = new Set(expectedValues);
  if (observed.size !== observedValues.length) throw new Error(`${label} contains duplicates`);
  if (!sameSet(observed, expected)) throw new Error(`${label} does not match sealed registry IDs`);
}

function assertNoProhibitedKeys(value, prohibitedKeys, label = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoProhibitedKeys(item, prohibitedKeys, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (prohibitedKeys.has(key)) throw new Error(`Blind artifact contains prohibited field ${label}.${key}`);
    assertNoProhibitedKeys(item, prohibitedKeys, `${label}.${key}`);
  }
}

function validateProtocol(protocol) {
  if (protocol.schema_version !== "1.0"
    || protocol.artifact_type !== "blinded_confirmatory_protocol") {
    throw new Error("Protocol must be a schema 1.0 blinded_confirmatory_protocol");
  }
  const bootstrap = protocol.analysis_plan?.cluster_bootstrap;
  const randomization = protocol.analysis_plan?.cluster_randomization;
  const paired = protocol.analysis_plan?.paired_test;
  const thresholds = protocol.promotion_gate?.machine_thresholds;
  if (bootstrap?.cluster_unit !== "source_selection_independence_cluster"
    || bootstrap?.interval !== "percentile"
    || bootstrap?.inferential_status !== "descriptive_only"
    || !Number.isInteger(bootstrap?.replicates)
    || bootstrap.replicates < 1000
    || !Number.isInteger(bootstrap.seed)) {
    throw new Error("Unsupported or incomplete cluster bootstrap contract");
  }
  if (randomization?.method !== "two_sided_exact_sign_flip_randomization"
    || randomization?.unit !== "source_selection_independence_cluster"
    || randomization?.cluster_statistic !== "mean_paired_detection_difference"
    || randomization?.aggregate_statistic !== "unweighted_mean_across_clusters"
    || typeof randomization?.alpha !== "number") {
    throw new Error("Unsupported cluster randomization contract");
  }
  if (paired?.method !== "two_sided_exact_mcnemar_complete_pairs_only"
    || paired?.inferential_status !== "exploratory_due_to_within_cluster_dependence") {
    throw new Error("Unsupported paired-test contract");
  }
  const numericThresholds = [
    "minimum_heldout_lineages",
    "minimum_heldout_repositories",
    "minimum_heldout_independence_clusters",
    "minimum_unique_detections",
    "minimum_unique_detection_clusters",
    "registered_fixed_control_count",
    "maximum_fixed_control_false_alarms",
  ];
  if (!thresholds || numericThresholds.some(
    (key) => !Number.isInteger(thresholds[key]) || thresholds[key] < 0
  )) {
    throw new Error("Promotion gate numeric thresholds are incomplete");
  }
  if (typeof thresholds.maximum_cluster_randomization_p_value !== "number"
    || typeof thresholds.minimum_leave_one_cluster_out_difference !== "number"
    || thresholds.require_all_registered_fixed_controls_executed !== true
    || thresholds.require_closed_artifact_bindings !== true
    || thresholds.require_complete_candidate_accounting !== true
    || thresholds.require_independent_execution_provenance !== true) {
    throw new Error("Promotion gate machine contract is incomplete");
  }
  const sampling = protocol.sampling_contract;
  if (!sampling
    || thresholds.minimum_heldout_lineages !== sampling.minimum_heldout_lineages
    || thresholds.minimum_heldout_repositories !== sampling.minimum_heldout_repositories
    || thresholds.minimum_heldout_independence_clusters
      !== sampling.minimum_heldout_independence_clusters
    || thresholds.minimum_heldout_lineages <= 0
    || thresholds.minimum_heldout_repositories <= 0
    || thresholds.minimum_heldout_independence_clusters <= 0
    || thresholds.minimum_unique_detections <= 0
    || thresholds.minimum_unique_detection_clusters <= 0
    || thresholds.registered_fixed_control_count <= 0
    || thresholds.registered_fixed_control_count > thresholds.minimum_heldout_lineages
    || thresholds.maximum_fixed_control_false_alarms
      >= thresholds.registered_fixed_control_count
    || thresholds.minimum_unique_detection_clusters
      > thresholds.minimum_heldout_independence_clusters
    || thresholds.maximum_cluster_randomization_p_value <= 0
    || thresholds.maximum_cluster_randomization_p_value > 0.05
    || thresholds.maximum_cluster_randomization_p_value
      !== protocol.analysis_plan?.cluster_randomization?.alpha) {
    throw new Error("Promotion thresholds drift from the frozen sampling and analysis contracts");
  }
  if (!Array.isArray(protocol.baseline_contracts) || protocol.baseline_contracts.length === 0) {
    throw new Error("Protocol baseline contracts are missing");
  }
  return {
    bootstrap,
    randomization,
    thresholds,
    baselineContracts: protocol.baseline_contracts,
  };
}

function validateSourceFreeze(sourceFreeze, sourceFreezeHash, protocol) {
  if (sourceFreeze.schema_version !== "1.0"
    || sourceFreeze.artifact_type !== "heldout_source_selection_freeze"
    || sourceFreeze.status !== "frozen_before_heldout_probe_design_or_outcomes"
    || !Array.isArray(sourceFreeze.active_sources)
    || !Array.isArray(sourceFreeze.reserve_sources)) {
    throw new Error("Source freeze is not a valid pre-outcome source selection artifact");
  }
  const bound = protocol.bindings?.some((binding) =>
    binding.path === "studies/grader-conform/corpus/heldout-source-freeze.v1.json"
      && binding.sha256 === sourceFreezeHash
  );
  if (!bound) throw new Error("Protocol does not bind the supplied source freeze bytes");
  return sourceFreeze;
}

function validateSourcePlan(sourcePlan, sourcePlanHash, protocol, sourceFreeze) {
  if (sourcePlan.schema_version !== "1.0"
    || sourcePlan.artifact_type !== "heldout_registry_source_plan"
    || sourcePlan.frozen_before_probe_design !== true
    || sourcePlan.method_outcomes_observed !== false
    || sourcePlan.baseline_outcomes_observed !== false
    || !Array.isArray(sourcePlan.activated_reserve_source_ids)
    || !Array.isArray(sourcePlan.sources)) {
    throw new Error("Source plan must be frozen before probe design and outcomes");
  }
  const bound = protocol.bindings?.some((binding) =>
    binding.path === "studies/grader-conform/corpus/heldout-registry-source-plan.v1.json"
      && binding.sha256 === sourcePlanHash
  );
  if (!bound) throw new Error("Protocol does not bind the supplied source-plan bytes");
  const activatedReserveIds = sourcePlan.activated_reserve_source_ids.map((sourceId, index) =>
    requireString(sourceId, `activated_reserve_source_ids[${index}]`)
  );
  if (new Set(activatedReserveIds).size !== activatedReserveIds.length) {
    throw new Error("Source plan contains duplicate activated reserve source IDs");
  }
  const reserveById = new Map(sourceFreeze.reserve_sources.map((source) => [source.source_id, source]));
  for (const sourceId of activatedReserveIds) {
    if (!reserveById.has(sourceId)) throw new Error(`Unknown activated reserve source: ${sourceId}`);
  }
  const expectedSourceIds = [
    ...sourceFreeze.active_sources.map((source) => source.source_id),
    ...activatedReserveIds,
  ];
  const sourceIds = [];
  const cacheKeys = new Set();
  const sources = new Map();
  for (const [index, source] of sourcePlan.sources.entries()) {
    const sourceId = requireString(source.source_id, `source_plan.sources[${index}].source_id`);
    const cacheKey = normalizeRelativePath(
      source.cache_key,
      `source_plan.sources[${index}].cache_key`
    );
    if (cacheKeys.has(cacheKey)) throw new Error(`Duplicate source-plan cache key: ${cacheKey}`);
    cacheKeys.add(cacheKey);
    if (!Array.isArray(source.bounded_environment_notes)
      || source.bounded_environment_notes.some(
        (note) => typeof note !== "string" || note.trim() === ""
      )) {
      throw new Error(`${sourceId}.bounded_environment_notes must contain non-empty strings`);
    }
    sourceIds.push(sourceId);
    sources.set(sourceId, {
      cacheKey,
      boundedEnvironmentNotes: source.bounded_environment_notes,
    });
  }
  assertExactIds(sourceIds, expectedSourceIds, "source-plan source IDs");
  return { activatedReserveIds, sourceIds, sources };
}

function validateRegistry(
  registry,
  protocolHash,
  sourceFreeze,
  sourceFreezeHash,
  sourcePlan,
  sourcePlanHash,
  fixedControlCount
) {
  if (registry.schema_version !== "1.0"
    || registry.artifact_type !== "heldout_lineage_registry"
    || registry.protocol_sha256 !== protocolHash
    || registry.source_freeze_sha256 !== sourceFreezeHash
    || registry.source_plan_sha256 !== sourcePlanHash
    || registry.frozen_before_probe_design !== true
    || registry.method_outcomes_observed !== false
    || registry.baseline_outcomes_observed !== false) {
    throw new Error("Registry is not a frozen pre-outcome heldout_lineage_registry");
  }
  if (!Array.isArray(registry.sources) || !Array.isArray(registry.lineages)) {
    throw new Error("Registry sources and lineages are required");
  }
  const activatedReserveIds = Array.isArray(registry.activated_reserve_source_ids)
    ? registry.activated_reserve_source_ids
    : [];
  assertExactIds(
    activatedReserveIds,
    sourcePlan.activatedReserveIds,
    "registry activated reserve source IDs"
  );
  const reserveById = new Map(sourceFreeze.reserve_sources.map((source) => [source.source_id, source]));
  for (const sourceId of activatedReserveIds) {
    if (!reserveById.has(sourceId)) throw new Error(`Unknown activated reserve source: ${sourceId}`);
  }
  const frozenSources = [
    ...sourceFreeze.active_sources,
    ...activatedReserveIds.map((sourceId) => reserveById.get(sourceId)),
  ];
  assertExactIds(
    registry.sources.map((source) => source.source_id),
    frozenSources.map((source) => source.source_id),
    "registry source IDs"
  );
  const frozenSourceById = new Map(frozenSources.map((source) => [source.source_id, source]));
  const sources = new Map();
  for (const [index, source] of registry.sources.entries()) {
    const sourceId = requireString(source.source_id, `sources[${index}].source_id`);
    if (sources.has(sourceId)) throw new Error(`Duplicate source_id: ${sourceId}`);
    const frozenSource = frozenSourceById.get(sourceId);
    if (source.pinned_head !== frozenSource.pinned_head
      || source.independence_cluster !== frozenSource.independence_cluster) {
      throw new Error(`${sourceId} source pin or independence cluster drifted from source freeze`);
    }
    const plannedSource = sourcePlan.sources.get(sourceId);
    if (!Array.isArray(source.bounded_environment_notes)
      || source.bounded_environment_notes.some(
        (note) => typeof note !== "string" || note.trim() === ""
      )) {
      throw new Error(`${sourceId} registry bounded_environment_notes are invalid`);
    }
    if (!plannedSource
      || source.cache_key !== plannedSource.cacheKey
      || canonicalHash(source.bounded_environment_notes)
        !== canonicalHash(plannedSource.boundedEnvironmentNotes)) {
      throw new Error(`${sourceId} registry metadata drifted from the source plan`);
    }
    sources.set(sourceId, {
      blindedSourceId: requireString(
        source.blinded_source_id,
        `sources[${index}].blinded_source_id`
      ),
      independenceCluster: requireString(
        source.independence_cluster,
        `sources[${index}].independence_cluster`
      ),
    });
  }
  const lineageIds = new Set();
  const candidateIds = new Set();
  const registryIndices = new Set();
  const lineages = registry.lineages.map((lineage, index) => {
    const lineageId = requireString(lineage.anonymous_lineage_id, `lineages[${index}].anonymous_lineage_id`);
    if (lineageIds.has(lineageId)) throw new Error(`Duplicate lineage_id: ${lineageId}`);
    lineageIds.add(lineageId);
    const candidateId = requireString(lineage.candidate_id, `${lineageId}.candidate_id`);
    if (candidateIds.has(candidateId)) throw new Error(`Duplicate candidate_id: ${candidateId}`);
    candidateIds.add(candidateId);
    const registryIndex = requireNonnegativeInteger(
      lineage.registry_index,
      `${lineageId}.registry_index`
    );
    if (registryIndices.has(registryIndex)) throw new Error(`Duplicate registry_index: ${registryIndex}`);
    registryIndices.add(registryIndex);
    const sourceId = requireString(lineage.source_id, `${lineageId}.source_id`);
    const source = sources.get(sourceId);
    if (!source) throw new Error(`${lineageId} references unknown source ${sourceId}`);
    return {
      lineageId,
      registryIndex,
      candidateId,
      sourceId,
      blindedSourceId: source.blindedSourceId,
      clusterId: source.independenceCluster,
    };
  }).sort((left, right) => left.registryIndex - right.registryIndex);
  if (lineages.some((lineage, index) => lineage.registryIndex !== index)) {
    throw new Error("Registry indices must be contiguous from zero in sealed order");
  }
  if (!Array.isArray(registry.fixed_control_lineage_ids)) {
    throw new Error("Registry fixed_control_lineage_ids are required");
  }
  const expectedFixedControls = lineages
    .slice(0, fixedControlCount)
    .map((lineage) => lineage.lineageId);
  if (registry.fixed_control_lineage_ids.length !== expectedFixedControls.length
    || registry.fixed_control_lineage_ids.some(
      (lineageId, index) => lineageId !== expectedFixedControls[index]
    )) {
    throw new Error("Fixed controls must be the first registered lineages in sealed registry order");
  }
  return { lineages, fixedControlIds: registry.fixed_control_lineage_ids };
}

function readBoundEvidence(binding, evidenceRoot, label) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error(`${label} must be an evidence binding`);
  }
  const bound = resolveBoundFile(evidenceRoot, binding.path, `${label}.path`);
  const evidence = readJson(bound.realPath);
  if (sha256(evidence.raw) !== requireHash(binding.sha256, `${label}.sha256`)) {
    throw new Error(`${label}.sha256 does not match bound evidence bytes`);
  }
  return evidence.value;
}

function validateEvidenceManifest(registry, evidenceRoot) {
  const manifestFile = resolveBoundFile(evidenceRoot, "manifest.json", "evidence manifest");
  const manifest = readJson(manifestFile.realPath);
  const manifestHash = sha256(manifest.raw);
  if (manifest.value.schema_version !== "1.0"
    || manifest.value.artifact_type !== "sealed_heldout_evidence_manifest"
    || manifest.value.frozen_before_probe_design !== true
    || manifest.value.method_outcomes_observed !== false
    || manifest.value.baseline_outcomes_observed !== false
    || manifest.value.closed_inventory !== true
    || !Array.isArray(manifest.value.artifacts)
    || manifest.value.artifacts.length === 0
    || registry.evidence_manifest_sha256 !== manifestHash) {
    throw new Error("Registry is not bound to a closed pre-outcome evidence manifest");
  }
  const expectedFiles = new Set(["manifest.json"]);
  const artifactBindings = new Map();
  const groupIds = new Set();
  for (const [index, artifact] of manifest.value.artifacts.entries()) {
    const groupId = requireString(artifact.group_id, `evidence.artifacts[${index}].group_id`);
    if (groupIds.has(groupId)) throw new Error(`Duplicate evidence group_id: ${groupId}`);
    groupIds.add(groupId);
    const file = resolveBoundFile(
      evidenceRoot,
      artifact.path,
      `evidence.artifacts[${index}].path`
    );
    if (file.portablePath === "manifest.json" || expectedFiles.has(file.portablePath)) {
      throw new Error(`Duplicate or reserved evidence artifact path: ${file.portablePath}`);
    }
    const evidence = readJson(file.realPath);
    const evidenceHash = sha256(evidence.raw);
    if (evidenceHash !== requireHash(artifact.sha256, `evidence.artifacts[${index}].sha256`)
      || statSync(file.realPath).size !== requireNonnegativeInteger(
        artifact.bytes,
        `evidence.artifacts[${index}].bytes`
      )
      || evidence.value.schema_version !== "1.0"
      || evidence.value.artifact_type !== "sealed_heldout_census_and_adjudication"
      || evidence.value.status !== "complete"
      || evidence.value.exhaustive_within_queries !== true
      || evidence.value.outcome_observed !== false
      || evidence.value.method_or_baseline_outcomes_included !== false) {
      throw new Error(`${file.portablePath} is not hash-bound sealed heldout evidence`);
    }
    expectedFiles.add(file.portablePath);
    artifactBindings.set(file.portablePath, evidenceHash);
  }
  const observedFiles = new Set(walkRegularFiles(evidenceRoot));
  if (!sameSet(observedFiles, expectedFiles)) {
    throw new Error("Evidence root does not match the sealed manifest closed inventory");
  }
  const registryBindings = [
    ...(registry.census_bindings ?? []),
    ...(registry.adjudication_bindings ?? []),
  ];
  const referencedPaths = new Set();
  for (const [index, binding] of registryBindings.entries()) {
    const portablePath = normalizeRelativePath(
      binding.path,
      `registry evidence binding[${index}].path`
    );
    if (artifactBindings.get(portablePath)
      !== requireHash(binding.sha256, `registry evidence binding[${index}].sha256`)) {
      throw new Error(`Registry evidence binding is absent from manifest: ${portablePath}`);
    }
    referencedPaths.add(portablePath);
  }
  if (!sameSet(referencedPaths, new Set(artifactBindings.keys()))) {
    throw new Error("Registry evidence bindings do not cover the complete sealed manifest");
  }
  return manifestHash;
}

function verifyCandidateAccounting(registry, evidenceRoot, lineages) {
  if (!Array.isArray(registry.census_bindings) || registry.census_bindings.length === 0) {
    throw new Error("Registry must bind at least one completed census");
  }
  const candidateIds = new Set();
  for (const [index, binding] of registry.census_bindings.entries()) {
    const census = readBoundEvidence(binding, evidenceRoot, `census_bindings[${index}]`);
    if (census.schema_version !== "1.0"
      || census.status !== "complete"
      || census.exhaustive_within_queries !== true
      || census.outcome_observed !== false
      || !Array.isArray(census.candidates)
      || !Array.isArray(census.exclusions)) {
      throw new Error(`census_bindings[${index}] is not a complete pre-outcome census`);
    }
    for (const [candidateIndex, candidate] of census.candidates.entries()) {
      const candidateId = requireString(
        candidate.candidate_id,
        `census_bindings[${index}].candidates[${candidateIndex}].candidate_id`
      );
      if (candidateIds.has(candidateId)) throw new Error(`Duplicate census candidate_id: ${candidateId}`);
      candidateIds.add(candidateId);
    }
  }
  if (!Array.isArray(registry.adjudication_bindings) || registry.adjudication_bindings.length === 0) {
    throw new Error("Registry must bind at least one independent adjudication");
  }
  const decisions = new Map();
  for (const [index, binding] of registry.adjudication_bindings.entries()) {
    const adjudication = readBoundEvidence(
      binding,
      evidenceRoot,
      `adjudication_bindings[${index}]`
    );
    if (adjudication.schema_version !== "1.0"
      || adjudication.status !== "complete"
      || adjudication.outcome_observed !== false
      || !Array.isArray(adjudication.decisions)) {
      throw new Error(`adjudication_bindings[${index}] is not a complete pre-outcome adjudication`);
    }
    for (const [decisionIndex, decision] of adjudication.decisions.entries()) {
      const candidateId = requireString(
        decision.candidate_id,
        `adjudication_bindings[${index}].decisions[${decisionIndex}].candidate_id`
      );
      if (!candidateIds.has(candidateId)) {
        throw new Error(`Adjudication references unknown candidate_id: ${candidateId}`);
      }
      if (decisions.has(candidateId)) throw new Error(`Duplicate adjudication: ${candidateId}`);
      if (decision.decision !== "admit" && decision.decision !== "exclude") {
        throw new Error(`Invalid adjudication decision for ${candidateId}`);
      }
      decisions.set(candidateId, decision.decision);
    }
  }
  if (decisions.size !== candidateIds.size) {
    const missing = [...candidateIds].filter((candidateId) => !decisions.has(candidateId));
    throw new Error(`Candidates missing adjudication: ${missing.join(", ")}`);
  }
  const admittedIds = new Set(
    [...decisions].filter(([, decision]) => decision === "admit").map(([candidateId]) => candidateId)
  );
  const excludedIds = new Set(
    [...decisions].filter(([, decision]) => decision === "exclude").map(([candidateId]) => candidateId)
  );
  const lineageCandidateIds = new Set(lineages.map((lineage) => lineage.candidateId));
  const registryExcludedIds = new Set(Array.isArray(registry.excluded_candidate_ids)
    ? registry.excluded_candidate_ids.map((candidateId, index) =>
      requireString(candidateId, `excluded_candidate_ids[${index}]`)
    )
    : []);
  if (!sameSet(admittedIds, lineageCandidateIds)) {
    throw new Error("Registry lineages do not exactly match admitted census candidates");
  }
  if (!sameSet(excludedIds, registryExcludedIds)) {
    throw new Error("Registry exclusions do not exactly match excluded census candidates");
  }
  return {
    census_candidate_count: candidateIds.size,
    admitted_candidate_count: admittedIds.size,
    excluded_candidate_count: excludedIds.size,
    all_candidates_accounted: true,
  };
}

function validatePackets(
  packets,
  registryHash,
  protocolHash,
  sourceFreezeHash,
  lineages,
  candidateAccounting,
  snapshotRoot,
  blindPacketContract
) {
  if (packets.schema_version !== "1.0"
    || packets.artifact_type !== "heldout_parent_only_packet_set"
    || packets.registry_sha256 !== registryHash
    || packets.protocol_sha256 !== protocolHash
    || packets.source_freeze_sha256 !== sourceFreezeHash
    || packets.closed_inventory !== true
    || packets.fix_information_included !== false
    || packets.vcs_history_included !== false
    || canonicalHash(packets.candidate_accounting) !== canonicalHash(candidateAccounting)
    || !Array.isArray(packets.packets)) {
    throw new Error("Packet set is not closed or is not bound to the registry");
  }
  const prohibitedKeys = new Set(blindPacketContract?.forbidden_fields ?? []);
  const allowedPacketKeys = new Set(blindPacketContract?.allowed_fields ?? []);
  if (prohibitedKeys.size === 0 || allowedPacketKeys.size === 0) {
    throw new Error("Protocol blind packet field contracts are missing");
  }
  assertNoProhibitedKeys(packets, prohibitedKeys);
  assertExactIds(
    packets.packets.map((packet) => packet.anonymous_lineage_id),
    lineages.map((lineage) => lineage.lineageId),
    "packet lineage IDs"
  );
  const packetMap = new Map(packets.packets.map((packet) => [
    packet.anonymous_lineage_id,
    packet,
  ]));
  for (const lineage of lineages) {
    const packet = packetMap.get(lineage.lineageId);
    const packetKeys = Object.keys(packet);
    const unexpectedKeys = packetKeys.filter((key) => !allowedPacketKeys.has(key));
    const missingKeys = [...allowedPacketKeys].filter((key) => !packetKeys.includes(key));
    if (unexpectedKeys.length > 0 || missingKeys.length > 0) {
      throw new Error(
        `${lineage.lineageId} does not exactly match the blind packet field contract`
      );
    }
    if (packet.registry_index !== lineage.registryIndex
      || packet.blinded_source_id !== lineage.blindedSourceId) {
      throw new Error(`${lineage.lineageId} packet identity does not match registry`);
    }
    const { packet_sha256: declaredPacketHash, ...corePacket } = packet;
    if (requireHash(declaredPacketHash, `${lineage.lineageId}.packet_sha256`)
      !== canonicalHash(corePacket)) {
      throw new Error(`${lineage.lineageId}.packet_sha256 does not match packet content`);
    }
  }
  const expectedSnapshotFiles = new Set();
  const verifiedSnapshotFiles = new Set();
  for (const packet of packets.packets) {
    for (const [kind, referenceKey, hashKey, bytesKey] of [
      ["archive", "source_snapshot_archive", "source_snapshot_sha256", "source_snapshot_bytes"],
      [
        "manifest",
        "source_snapshot_manifest",
        "source_snapshot_manifest_sha256",
        "source_snapshot_manifest_bytes",
      ],
    ]) {
      const bound = resolveBoundFile(
        snapshotRoot,
        packet[referenceKey],
        `${packet.anonymous_lineage_id}.${kind}`
      );
      expectedSnapshotFiles.add(bound.portablePath);
      if (verifiedSnapshotFiles.has(bound.portablePath)) continue;
      if (sha256File(bound.realPath) !== requireHash(
        packet[hashKey],
        `${packet.anonymous_lineage_id}.${hashKey}`
      ) || statSync(bound.realPath).size !== requireNonnegativeInteger(
        packet[bytesKey],
        `${packet.anonymous_lineage_id}.${bytesKey}`
      )) {
        throw new Error(`${packet.anonymous_lineage_id}.${kind} bytes do not match packet binding`);
      }
      verifiedSnapshotFiles.add(bound.portablePath);
    }
  }
  const observedSnapshotFiles = walkRegularFiles(snapshotRoot);
  if (!sameSet(new Set(observedSnapshotFiles), expectedSnapshotFiles)) {
    throw new Error("Snapshot root does not match packet-set closed inventory");
  }
  const verifiedPairs = new Set();
  for (const packet of packets.packets) {
    const archive = resolveBoundFile(
      snapshotRoot,
      packet.source_snapshot_archive,
      `${packet.anonymous_lineage_id}.archive`
    );
    const manifest = resolveBoundFile(
      snapshotRoot,
      packet.source_snapshot_manifest,
      `${packet.anonymous_lineage_id}.manifest`
    );
    const pairKey = `${archive.portablePath}\0${manifest.portablePath}`;
    if (verifiedPairs.has(pairKey)) continue;
    verifySnapshotSemantics(
      archive.realPath,
      manifest.realPath,
      packet.anonymous_lineage_id
    );
    verifiedPairs.add(pairKey);
  }
  return packetMap;
}

function validateProbeManifest(manifest, protocolHash, packetSetHash, lineages, packetMap) {
  if (manifest.schema_version !== "1.0"
    || manifest.artifact_type !== "blinded_probe_manifest"
    || manifest.protocol_sha256 !== protocolHash
    || manifest.packet_set_sha256 !== packetSetHash
    || manifest.frozen_before_unblinding !== true
    || !Array.isArray(manifest.probes)) {
    throw new Error("Probe manifest is not frozen or bound to the packet set");
  }
  assertExactIds(
    manifest.probes.map((probe) => probe.lineage_id),
    lineages.map((lineage) => lineage.lineageId),
    "probe manifest lineage IDs"
  );
  return new Map(manifest.probes.map((probe, index) => {
    const lineageId = requireString(probe.lineage_id, `probes[${index}].lineage_id`);
    if (probe.packet_sha256 !== packetMap.get(lineageId).packet_sha256) {
      throw new Error(`${lineageId} probe does not bind the sealed packet`);
    }
    requireHash(probe.command_sha256, `${lineageId}.probe.command_sha256`);
    requireNonnegativeInteger(
      probe.generated_case_budget,
      `${lineageId}.probe.generated_case_budget`
    );
    requireNonnegativeNumber(
      probe.wall_clock_budget_seconds,
      `${lineageId}.probe.wall_clock_budget_seconds`
    );
    return [lineageId, { ...probe, itemSha256: canonicalHash(probe) }];
  }));
}

function validateBaselineManifest(
  manifest,
  protocolHash,
  packetSetHash,
  lineages,
  baselineContracts
) {
  if (manifest.schema_version !== "1.0"
    || manifest.artifact_type !== "blinded_baseline_manifest"
    || manifest.protocol_sha256 !== protocolHash
    || manifest.packet_set_sha256 !== packetSetHash
    || manifest.frozen_before_unblinding !== true
    || !Array.isArray(manifest.items)) {
    throw new Error("Baseline manifest is not frozen or bound to the packet set");
  }
  const baselineIds = baselineContracts.map((contract) => contract.id);
  const expectedKeys = new Set(lineages.flatMap((lineage) =>
    baselineIds.map((baselineId) => `${lineage.lineageId}\0${baselineId}`)
  ));
  const items = new Map();
  for (const [index, item] of manifest.items.entries()) {
    const lineageId = requireString(item.lineage_id, `baseline items[${index}].lineage_id`);
    const baselineId = requireString(item.baseline_id, `baseline items[${index}].baseline_id`);
    const key = `${lineageId}\0${baselineId}`;
    if (!expectedKeys.has(key)) throw new Error(`Unexpected baseline manifest item: ${key}`);
    if (items.has(key)) throw new Error(`Duplicate baseline manifest item: ${key}`);
    if (item.applicability !== "applicable" && item.applicability !== "not_applicable") {
      throw new Error(`${key} has invalid applicability`);
    }
    if (item.applicability === "applicable") {
      requireHash(item.command_sha256, `${key}.command_sha256`);
      requireNonnegativeInteger(item.generated_case_budget, `${key}.generated_case_budget`);
      requireNonnegativeNumber(item.wall_clock_budget_seconds, `${key}.wall_clock_budget_seconds`);
    } else {
      if (item.command_sha256 !== null
        || item.generated_case_budget !== 0
        || item.wall_clock_budget_seconds !== 0) {
        throw new Error(`${key} not-applicable item must have null command and zero budget`);
      }
      requireString(item.not_applicable_reason, `${key}.not_applicable_reason`);
    }
    items.set(key, { ...item, itemSha256: canonicalHash(item) });
  }
  if (!sameSet(new Set(items.keys()), expectedKeys)) {
    throw new Error("Baseline manifest does not cover every lineage and baseline");
  }
  return items;
}

function validateExecutionReceipt(receipt, expected) {
  if (receipt.schema_version !== "1.0"
    || receipt.artifact_type !== expected.artifactType
    || receipt.lineage_id !== expected.lineageId
    || receipt.revision_role !== expected.revisionRole
    || receipt.manifest_item_sha256 !== expected.itemSha256
    || receipt.command_sha256 !== expected.commandSha256
    || (expected.baselineId !== undefined && receipt.baseline_id !== expected.baselineId)) {
    throw new Error(`${expected.label} receipt identity or manifest binding is invalid`);
  }
  const executed = requireBoolean(receipt.executed, `${expected.label}.executed`);
  const exitCode = receipt.exit_code;
  if (executed) {
    if (!Number.isInteger(exitCode)) throw new Error(`${expected.label}.exit_code must be integer`);
  } else if (exitCode !== null) {
    throw new Error(`${expected.label}.exit_code must be null when not executed`);
  }
  const generatedCaseCount = requireNonnegativeInteger(
    receipt.generated_case_count,
    `${expected.label}.generated_case_count`
  );
  if (generatedCaseCount > expected.caseBudget) {
    throw new Error(`${expected.label} exceeds its frozen generated-case budget`);
  }
  const runtimeSeconds = requireNonnegativeNumber(
    receipt.runtime_seconds,
    `${expected.label}.runtime_seconds`
  );
  if (runtimeSeconds > expected.wallClockBudgetSeconds) {
    throw new Error(`${expected.label} exceeds its frozen wall-clock budget`);
  }
  const successful = executed && exitCode === 0;
  const signal = receipt[expected.signalField];
  if (successful) {
    requireBoolean(signal, `${expected.label}.${expected.signalField}`);
  } else if (signal !== null) {
    throw new Error(`${expected.label}.${expected.signalField} must be null on failed execution`);
  }
  return { successful, signal, generatedCaseCount, runtimeSeconds };
}

function validateDeviationLedger(deviations) {
  return deviations.map((deviation, index) => {
    if (!deviation || typeof deviation !== "object" || Array.isArray(deviation)) {
      throw new Error(`deviations[${index}] must be an object`);
    }
    const timestamp = requireString(deviation.timestamp, `deviations[${index}].timestamp`);
    if (!Number.isFinite(Date.parse(timestamp))) {
      throw new Error(`deviations[${index}].timestamp must be ISO-8601 compatible`);
    }
    return {
      timestamp,
      reason: requireString(deviation.reason, `deviations[${index}].reason`),
      affected_procedure: requireString(
        deviation.affected_procedure,
        `deviations[${index}].affected_procedure`
      ),
      candidate_details_observed: requireBoolean(
        deviation.candidate_details_observed,
        `deviations[${index}].candidate_details_observed`
      ),
      method_outcomes_observed: requireBoolean(
        deviation.method_outcomes_observed,
        `deviations[${index}].method_outcomes_observed`
      ),
      baseline_outcomes_observed: requireBoolean(
        deviation.baseline_outcomes_observed,
        `deviations[${index}].baseline_outcomes_observed`
      ),
    };
  });
}

function exactMcNemarPValue(methodOnly, baselineOnly) {
  const discordant = methodOnly + baselineOnly;
  if (discordant === 0) return 1;
  const tail = Math.min(methodOnly, baselineOnly);
  let term = 2 ** (-discordant);
  let cumulative = term;
  for (let successes = 1; successes <= tail; successes += 1) {
    term *= (discordant - successes + 1) / successes;
    cumulative += term;
  }
  return Math.min(1, 2 * cumulative);
}

function summarizeRows(rows) {
  const methodOnly = rows.filter((row) => row.methodDetected && !row.baselineDetected).length;
  const baselineOnly = rows.filter((row) => !row.methodDetected && row.baselineDetected).length;
  const both = rows.filter((row) => row.methodDetected && row.baselineDetected).length;
  return {
    lineage_count: rows.length,
    method_detected_count: rows.filter((row) => row.methodDetected).length,
    baseline_union_observed_detected_count: rows.filter(
      (row) => row.baselineObservedDetected
    ).length,
    eligible_baseline_execution_failure_lineage_count: rows.filter(
      (row) => row.baselineExecutionFailed
    ).length,
    eligible_baseline_inapplicable_lineage_count: rows.filter(
      (row) => row.baselineInapplicable
    ).length,
    conservative_baseline_union_count: rows.filter((row) => row.baselineDetected).length,
    method_only_count: methodOnly,
    baseline_only_count: baselineOnly,
    both_detected_count: both,
    neither_detected_count: rows.length - methodOnly - baselineOnly - both,
    method_recall: round(mean(rows.map((row) => Number(row.methodDetected)))),
    conservative_baseline_union_rate: round(mean(
      rows.map((row) => Number(row.baselineDetected))
    )),
    paired_detection_difference: round(mean(
      rows.map((row) => Number(row.methodDetected) - Number(row.baselineDetected))
    )),
    unique_detection_rate: round(mean(
      rows.map((row) => Number(row.methodDetected && !row.baselineDetected))
    )),
  };
}

function groupRows(rows) {
  const clusters = new Map();
  for (const row of rows) {
    const clusterRows = clusters.get(row.clusterId) ?? [];
    clusterRows.push(row);
    clusters.set(row.clusterId, clusterRows);
  }
  return clusters;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sortedValues, probability) {
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] * (upper - position) + sortedValues[upper] * (position - lower);
}

function clusterBootstrap(rows, replicates, seed) {
  const clusters = groupRows(rows);
  const ids = [...clusters.keys()].sort();
  const random = mulberry32(seed);
  const distributions = {
    method_recall: [],
    paired_detection_difference: [],
    unique_detection_rate: [],
  };
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const sample = [];
    for (let index = 0; index < ids.length; index += 1) {
      sample.push(...clusters.get(ids[Math.floor(random() * ids.length)]));
    }
    const summary = summarizeRows(sample);
    for (const key of Object.keys(distributions)) distributions[key].push(summary[key]);
  }
  return Object.fromEntries(Object.entries(distributions).map(([key, values]) => {
    values.sort((left, right) => left - right);
    return [key, {
      lower: round(quantile(values, 0.025)),
      upper: round(quantile(values, 0.975)),
    }];
  }));
}

function exactClusterRandomization(rows) {
  const clusters = groupRows(rows);
  const clusterDifferences = [...clusters.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  ).map(([clusterId, clusterRows]) => ({
    cluster_id: clusterId,
    lineage_count: clusterRows.length,
    paired_detection_difference: mean(clusterRows.map(
      (row) => Number(row.methodDetected) - Number(row.baselineDetected)
    )),
  }));
  if (clusterDifferences.length > 20) {
    throw new Error("Exact sign-flip randomization supports at most 20 clusters");
  }
  const observed = Math.abs(mean(
    clusterDifferences.map((cluster) => cluster.paired_detection_difference)
  ));
  const total = 2 ** clusterDifferences.length;
  let asOrMoreExtreme = 0;
  for (let mask = 0; mask < total; mask += 1) {
    const permuted = mean(clusterDifferences.map((cluster, index) =>
      (mask & (1 << index) ? 1 : -1) * cluster.paired_detection_difference
    ));
    if (Math.abs(permuted) >= observed - 1e-12) asOrMoreExtreme += 1;
  }
  return {
    cluster_count: clusterDifferences.length,
    observed_unweighted_cluster_mean_difference: round(observed),
    two_sided_exact_p_value: round(asOrMoreExtreme / total),
    cluster_differences: clusterDifferences.map((cluster) => ({
      ...cluster,
      paired_detection_difference: round(cluster.paired_detection_difference),
    })),
  };
}

function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (total === 0) return null;
  const proportion = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * total)) / total
  ) / denominator;
  return {
    lower: round(Math.max(0, center - margin)),
    upper: round(Math.min(1, center + margin)),
  };
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const input = readJson(args.input);
  const protocol = readJson(args.protocol);
  const registry = readJson(args.registry);
  const sourceFreeze = readJson(args["source-freeze"]);
  const sourcePlan = readJson(args["source-plan"]);
  const packets = readJson(args.packets);
  const probeManifest = readJson(args["probe-manifest"]);
  const baselineManifest = readJson(args["baseline-manifest"]);
  const protocolContract = validateProtocol(protocol.value);
  const hashes = {
    protocol: sha256(protocol.raw),
    registry: sha256(registry.raw),
    sourceFreeze: sha256(sourceFreeze.raw),
    sourcePlan: sha256(sourcePlan.raw),
    packets: sha256(packets.raw),
    probeManifest: sha256(probeManifest.raw),
    baselineManifest: sha256(baselineManifest.raw),
  };
  if (input.value.schema_version !== "1.0"
    || input.value.artifact_type !== "confirmatory_receipt_index"
    || input.value.protocol_sha256 !== hashes.protocol
    || input.value.registry_sha256 !== hashes.registry
    || input.value.source_freeze_sha256 !== hashes.sourceFreeze
    || input.value.source_plan_sha256 !== hashes.sourcePlan
    || input.value.packet_set_sha256 !== hashes.packets
    || input.value.probe_manifest_sha256 !== hashes.probeManifest
    || input.value.baseline_manifest_sha256 !== hashes.baselineManifest
    || !Array.isArray(input.value.lineages)
    || !Array.isArray(input.value.deviations)) {
    throw new Error("Confirmatory receipt index is not hash-bound to every sealed input");
  }
  const deviations = validateDeviationLedger(input.value.deviations);
  const sourceFreezeContract = validateSourceFreeze(
    sourceFreeze.value,
    hashes.sourceFreeze,
    protocol.value
  );
  const sourcePlanContract = validateSourcePlan(
    sourcePlan.value,
    hashes.sourcePlan,
    protocol.value,
    sourceFreezeContract
  );
  const registryContract = validateRegistry(
    registry.value,
    hashes.protocol,
    sourceFreezeContract,
    hashes.sourceFreeze,
    sourcePlanContract,
    hashes.sourcePlan,
    protocolContract.thresholds.registered_fixed_control_count
  );
  const evidenceManifestHash = validateEvidenceManifest(
    registry.value,
    args["evidence-root"]
  );
  if (input.value.evidence_manifest_sha256 !== evidenceManifestHash) {
    throw new Error("Confirmatory receipt index does not bind the sealed evidence manifest");
  }
  const candidateAccounting = verifyCandidateAccounting(
    registry.value,
    args["evidence-root"],
    registryContract.lineages
  );
  const packetMap = validatePackets(
    packets.value,
    hashes.registry,
    hashes.protocol,
    hashes.sourceFreeze,
    registryContract.lineages,
    candidateAccounting,
    args["snapshot-root"],
    protocol.value.blind_packet_contract
  );
  const probeItems = validateProbeManifest(
    probeManifest.value,
    hashes.protocol,
    hashes.packets,
    registryContract.lineages,
    packetMap
  );
  const baselineItems = validateBaselineManifest(
    baselineManifest.value,
    hashes.protocol,
    hashes.packets,
    registryContract.lineages,
    protocolContract.baselineContracts
  );
  assertExactIds(
    input.value.lineages.map((lineage) => lineage.lineage_id),
    registryContract.lineages.map((lineage) => lineage.lineageId),
    "receipt-index lineage IDs"
  );
  assertClosedReceiptInventory(args["receipt-root"], input.value.lineages);
  const receiptIndex = new Map(input.value.lineages.map((lineage) => [
    lineage.lineage_id,
    lineage,
  ]));
  const baselineContracts = new Map(
    protocolContract.baselineContracts.map((contract) => [contract.id, contract])
  );
  const eligibleBaselineIds = protocolContract.baselineContracts
    .filter((contract) => contract.eligible_for_strongest_detector_union === true)
    .map((contract) => contract.id);
  const rows = registryContract.lineages.map((lineage) => {
    const indexed = receiptIndex.get(lineage.lineageId);
    const probe = probeItems.get(lineage.lineageId);
    const methodParentReceipt = readBoundJson(
      indexed.method?.parent,
      args["receipt-root"],
      `${lineage.lineageId}.method.parent`
    );
    const methodFixedReceipt = readBoundJson(
      indexed.method?.fixed,
      args["receipt-root"],
      `${lineage.lineageId}.method.fixed`
    );
    const methodParent = validateExecutionReceipt(methodParentReceipt, {
      artifactType: "method_execution_receipt",
      lineageId: lineage.lineageId,
      revisionRole: "parent",
      itemSha256: probe.itemSha256,
      commandSha256: probe.command_sha256,
      caseBudget: probe.generated_case_budget,
      wallClockBudgetSeconds: probe.wall_clock_budget_seconds,
      signalField: "relation_holds",
      label: `${lineage.lineageId}.method.parent`,
    });
    const methodFixed = validateExecutionReceipt(methodFixedReceipt, {
      artifactType: "method_execution_receipt",
      lineageId: lineage.lineageId,
      revisionRole: "fixed",
      itemSha256: probe.itemSha256,
      commandSha256: probe.command_sha256,
      caseBudget: probe.generated_case_budget,
      wallClockBudgetSeconds: probe.wall_clock_budget_seconds,
      signalField: "relation_holds",
      label: `${lineage.lineageId}.method.fixed`,
    });
    if (methodParent.generatedCaseCount !== methodFixed.generatedCaseCount) {
      throw new Error(`${lineage.lineageId} method parent/fixed case counts differ`);
    }
    if (!indexed.baselines || typeof indexed.baselines !== "object") {
      throw new Error(`${lineage.lineageId}.baselines receipt index is missing`);
    }
    assertExactIds(
      Object.keys(indexed.baselines),
      [...baselineContracts.keys()],
      `${lineage.lineageId}.baseline receipt IDs`
    );
    const baselineOutcomes = new Map();
    for (const [baselineId, contract] of baselineContracts) {
      const item = baselineItems.get(`${lineage.lineageId}\0${baselineId}`);
      const binding = indexed.baselines[baselineId];
      if (item.applicability === "not_applicable") {
        if (binding !== null) {
          throw new Error(`${lineage.lineageId}.${baselineId} must have null receipt binding`);
        }
        baselineOutcomes.set(baselineId, {
          applicable: false,
          detected: false,
          executionFailed: false,
          complete: contract.eligible_for_strongest_detector_union !== true,
        });
        continue;
      }
      if (!binding || typeof binding !== "object") {
        throw new Error(`${lineage.lineageId}.${baselineId} receipt binding is missing`);
      }
      const parentReceipt = readBoundJson(
        binding.parent,
        args["receipt-root"],
        `${lineage.lineageId}.${baselineId}.parent`
      );
      const fixedReceipt = readBoundJson(
        binding.fixed,
        args["receipt-root"],
        `${lineage.lineageId}.${baselineId}.fixed`
      );
      const expectedBase = {
        artifactType: "baseline_execution_receipt",
        lineageId: lineage.lineageId,
        itemSha256: item.itemSha256,
        commandSha256: item.command_sha256,
        caseBudget: item.generated_case_budget,
        wallClockBudgetSeconds: item.wall_clock_budget_seconds,
        signalField: "fault_signal",
        baselineId,
      };
      const parent = validateExecutionReceipt(parentReceipt, {
        ...expectedBase,
        revisionRole: "parent",
        label: `${lineage.lineageId}.${baselineId}.parent`,
      });
      const fixed = validateExecutionReceipt(fixedReceipt, {
        ...expectedBase,
        revisionRole: "fixed",
        label: `${lineage.lineageId}.${baselineId}.fixed`,
      });
      if (parent.generatedCaseCount !== fixed.generatedCaseCount) {
        throw new Error(`${lineage.lineageId}.${baselineId} parent/fixed case counts differ`);
      }
      if (contract.case_budget_rule === "not_greater_than_primary_generated_cases"
        && item.generated_case_budget > probe.generated_case_budget) {
        throw new Error(`${lineage.lineageId}.${baselineId} exceeds primary case budget`);
      }
      const complete = parent.successful && fixed.successful;
      baselineOutcomes.set(baselineId, {
        applicable: true,
        complete,
        executionFailed: !complete,
        detected: complete && parent.signal === true && fixed.signal === false,
      });
    }
    const eligible = eligibleBaselineIds.map((baselineId) => baselineOutcomes.get(baselineId));
    const baselineObservedDetected = eligible.some((outcome) => outcome.detected);
    const baselineExecutionFailed = eligible.some((outcome) => outcome.executionFailed);
    const baselineInapplicable = eligible.some((outcome) => !outcome.applicable);
    const methodExecutionComplete = methodParent.successful && methodFixed.successful;
    return {
      lineageId: lineage.lineageId,
      registryIndex: lineage.registryIndex,
      sourceId: lineage.sourceId,
      clusterId: lineage.clusterId,
      methodExecutionComplete,
      methodFixedControlExecuted: methodFixed.successful,
      methodFixedFalseAlarm: methodFixed.successful && methodFixed.signal === false,
      methodDetected: methodExecutionComplete
        && methodParent.signal === false
        && methodFixed.signal === true,
      baselineObservedDetected,
      baselineExecutionFailed,
      baselineInapplicable,
      baselineComplete: eligible.every((outcome) => outcome.complete),
      baselineDetected: baselineObservedDetected || baselineExecutionFailed || baselineInapplicable,
    };
  });
  const summary = summarizeRows(rows);
  const randomization = exactClusterRandomization(rows);
  const bootstrap = clusterBootstrap(
    rows,
    protocolContract.bootstrap.replicates,
    protocolContract.bootstrap.seed
  );
  const completePairs = rows.filter(
    (row) => row.methodExecutionComplete && row.baselineComplete
  );
  const completeSummary = summarizeRows(completePairs);
  const leaveOneClusterOut = [...new Set(rows.map((row) => row.clusterId))].sort().map(
    (clusterId) => ({
      omitted_cluster_id: clusterId,
      ...summarizeRows(rows.filter((row) => row.clusterId !== clusterId)),
    })
  );
  const thresholds = protocolContract.thresholds;
  if (registryContract.fixedControlIds.length !== thresholds.registered_fixed_control_count) {
    throw new Error("Registry fixed-control set does not match the protocol count");
  }
  const rowsById = new Map(rows.map((row) => [row.lineageId, row]));
  const fixedControls = registryContract.fixedControlIds.map((lineageId) => rowsById.get(lineageId));
  const fixedFalseAlarms = fixedControls.filter((row) => row.methodFixedFalseAlarm).length;
  const uniqueDetectionClusters = new Set(
    rows.filter((row) => row.methodDetected && !row.baselineDetected).map((row) => row.clusterId)
  ).size;
  const sourceCount = new Set(rows.map((row) => row.sourceId)).size;
  const clusterCount = new Set(rows.map((row) => row.clusterId)).size;
  const checks = [
    {
      id: "heldout_scale",
      passed: rows.length >= thresholds.minimum_heldout_lineages
        && sourceCount >= thresholds.minimum_heldout_repositories
        && clusterCount >= thresholds.minimum_heldout_independence_clusters,
      observed: { lineage_count: rows.length, source_count: sourceCount, cluster_count: clusterCount },
    },
    {
      id: "unique_detection_count",
      passed: summary.method_only_count >= thresholds.minimum_unique_detections,
      observed: summary.method_only_count,
    },
    {
      id: "unique_detection_cluster_coverage",
      passed: uniqueDetectionClusters >= thresholds.minimum_unique_detection_clusters,
      observed: uniqueDetectionClusters,
    },
    {
      id: "exact_cluster_randomization",
      passed: randomization.two_sided_exact_p_value
        <= thresholds.maximum_cluster_randomization_p_value,
      observed: randomization.two_sided_exact_p_value,
    },
    {
      id: "registered_fixed_controls",
      passed: fixedControls.every((row) => row.methodFixedControlExecuted)
        && fixedFalseAlarms <= thresholds.maximum_fixed_control_false_alarms,
      observed: {
        registered_count: fixedControls.length,
        executed_count: fixedControls.filter((row) => row.methodFixedControlExecuted).length,
        false_alarm_count: fixedFalseAlarms,
      },
    },
    {
      id: "leave_one_cluster_out_sign",
      passed: leaveOneClusterOut.every((row) =>
        row.paired_detection_difference
          >= thresholds.minimum_leave_one_cluster_out_difference
      ),
      observed: leaveOneClusterOut.map((row) => ({
        omitted_cluster_id: row.omitted_cluster_id,
        paired_detection_difference: row.paired_detection_difference,
      })),
    },
    {
      id: "closed_artifact_bindings",
      passed: true,
      observed: {
        registry_lineages_matched: rows.length,
        packets_closed: true,
        manifests_frozen: true,
        receipts_hash_verified: true,
        candidate_accounting_verified: true,
        packet_content_hashes_recomputed: true,
        snapshot_archive_manifest_semantics_verified: true,
      },
    },
    {
      id: "deviation_ledger",
      passed: deviations.length === 0,
      observed: {
        deviation_count: deviations.length,
        policy: "Any deviation requires a separately frozen amended analysis before promotion.",
      },
    },
  ];
  const receiptAnalysisGatePassed = checks.every((check) => check.passed);
  const independentExecutionProvenanceVerified = false;
  const output = {
    schema_version: "2.0",
    artifact_type: "bound_confirmatory_statistical_analysis",
    input_sha256: sha256(input.raw),
    protocol_sha256: hashes.protocol,
    registry_sha256: hashes.registry,
    source_freeze_sha256: hashes.sourceFreeze,
    source_plan_sha256: hashes.sourcePlan,
    evidence_manifest_sha256: evidenceManifestHash,
    packet_set_sha256: hashes.packets,
    probe_manifest_sha256: hashes.probeManifest,
    baseline_manifest_sha256: hashes.baselineManifest,
    candidate_accounting: candidateAccounting,
    deviation_ledger: deviations,
    deviation_ledger_sha256: canonicalHash(deviations),
    lineage_count: rows.length,
    source_count: sourceCount,
    independence_cluster_count: clusterCount,
    eligible_strongest_union_baselines: eligibleBaselineIds,
    summary,
    primary_exact_cluster_randomization: randomization,
    descriptive_cluster_bootstrap: {
      inferential_status: "descriptive_only",
      replicates: protocolContract.bootstrap.replicates,
      seed: protocolContract.bootstrap.seed,
      intervals: bootstrap,
    },
    exploratory_exact_mcnemar_complete_pairs: {
      inferential_status: "exploratory_due_to_within_cluster_dependence",
      complete_pair_count: completePairs.length,
      method_only_count: completeSummary.method_only_count,
      baseline_only_count: completeSummary.baseline_only_count,
      two_sided_p_value: round(exactMcNemarPValue(
        completeSummary.method_only_count,
        completeSummary.baseline_only_count
      )),
    },
    fixed_control_false_alarm: {
      registered_control_count: fixedControls.length,
      executed_control_count: fixedControls.filter((row) => row.methodFixedControlExecuted).length,
      false_alarm_count: fixedFalseAlarms,
      wilson_interval: wilsonInterval(fixedFalseAlarms, fixedControls.length),
    },
    leave_one_independence_cluster_out: leaveOneClusterOut,
    promotion_checks: checks,
    confirmatory_receipt_analysis_gate_passed: receiptAnalysisGatePassed,
    independent_execution_provenance_verified: independentExecutionProvenanceVerified,
    confirmatory_empirical_gate_passed: receiptAnalysisGatePassed
      && independentExecutionProvenanceVerified,
    paper_candidate_promotion_authorized: false,
    paper_scale_claim_authorized: false,
    next_action: receiptAnalysisGatePassed
      ? "run_independent_replay_and_bind_raw_execution_transcripts"
      : "return_to_topic_portfolio_generation",
    outcome_signature_sha256: canonicalHash(rows),
  };
  atomicWriteJson(args.output, output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
