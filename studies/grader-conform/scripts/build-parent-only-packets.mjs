#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
    "registry",
    "protocol",
    "source-freeze",
    "repo-root",
    "evidence-root",
    "snapshot-root",
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

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value, label, options = {}) {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${options.allowEmpty ? "an" : "a non-empty"} array`);
  }
  return value.map((item, index) => requireString(item, `${label}[${index}]`));
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isContained(root, candidate) {
  const containedPath = relative(root, candidate);
  return containedPath !== ""
    && containedPath !== ".."
    && !containedPath.startsWith(`..${sep}`)
    && !isAbsolute(containedPath);
}

function resolveRepository(repoRoot, cacheKey) {
  const realRoot = realpathSync(repoRoot);
  const key = requireString(cacheKey, "source.cache_key");
  if (isAbsolute(key)) throw new Error(`Source cache_key must be relative: ${key}`);
  const repository = resolve(realRoot, key);
  if (!isContained(realRoot, repository)) {
    throw new Error(`Source cache_key escapes repo root: ${key}`);
  }
  const stat = lstatSync(repository);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Source cache must be a regular directory: ${key}`);
  }
  const realRepository = realpathSync(repository);
  if (!isContained(realRoot, realRepository)) {
    throw new Error(`Source cache resolves outside repo root: ${key}`);
  }
  git(realRepository, ["rev-parse", "--git-dir"]);
  return realRepository;
}

function normalizeRelativePath(value, label) {
  const normalized = requireString(value, label).replaceAll("\\", "/");
  if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must be a contained relative path`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an invalid path segment`);
  }
  return normalized;
}

function resolveEvidenceFile(evidenceRoot, reference, label) {
  const realRoot = realpathSync(evidenceRoot);
  const relativePath = normalizeRelativePath(reference, label);
  const candidate = resolve(realRoot, relativePath);
  if (!isContained(realRoot, candidate)) throw new Error(`${label} escapes evidence root`);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must reference a regular non-symlink file`);
  }
  const realCandidate = realpathSync(candidate);
  if (!isContained(realRoot, realCandidate)) throw new Error(`${label} resolves outside evidence root`);
  return realCandidate;
}

function readBoundEvidence(binding, evidenceRoot, label) {
  const filePath = resolveEvidenceFile(evidenceRoot, binding.path, `${label}.path`);
  const evidence = readJson(filePath);
  if (sha256(evidence.raw) !== binding.sha256) {
    throw new Error(`${label}.sha256 does not match the bound evidence file`);
  }
  return evidence.value;
}

function verifyCandidateAccounting(registry, evidenceRoot) {
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
    throw new Error("Registry must bind at least one adjudication artifact");
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
  const lineageCandidateIds = new Set(registry.lineages.map((lineage, index) => requireString(
    lineage.candidate_id,
    `lineages[${index}].candidate_id`
  )));
  const registryExcludedIds = new Set(requireStringArray(
    registry.excluded_candidate_ids,
    "excluded_candidate_ids",
    { allowEmpty: true }
  ));
  const sameSet = (left, right) => left.size === right.size && [...left].every((item) => right.has(item));
  if (!sameSet(admittedIds, lineageCandidateIds)) {
    throw new Error("Registry lineages do not exactly match admitted census candidates");
  }
  if (!sameSet(excludedIds, registryExcludedIds)) {
    throw new Error("Registry excluded_candidate_ids do not exactly match excluded census candidates");
  }
  return {
    census_candidate_count: candidateIds.size,
    admitted_candidate_count: admittedIds.size,
    excluded_candidate_count: excludedIds.size,
    all_candidates_accounted: true,
  };
}

function gitBlob(repository, revision, filePath) {
  const normalized = normalizeRelativePath(filePath, "parent_license_path");
  return execFileSync("git", ["cat-file", "blob", `${revision}:${normalized}`], {
    cwd: repository,
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitObject(repository, objectId) {
  return execFileSync("git", ["cat-file", "blob", objectId], {
    cwd: repository,
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function stablePacketHash(packet) {
  return sha256(JSON.stringify(canonicalize(packet)));
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function validateSourceFreeze(sourceFreeze, sourceFreezeHash, protocol, registry) {
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
  if (registry.source_freeze_sha256 !== sourceFreezeHash) {
    throw new Error("Registry source_freeze_sha256 does not match the supplied source freeze");
  }
  const activatedReserveIds = Array.isArray(registry.activated_reserve_source_ids)
    ? registry.activated_reserve_source_ids
    : [];
  if (new Set(activatedReserveIds).size !== activatedReserveIds.length) {
    throw new Error("activated_reserve_source_ids contains duplicates");
  }
  const reserveById = new Map(sourceFreeze.reserve_sources.map((source) => [source.source_id, source]));
  for (const sourceId of activatedReserveIds) {
    if (!reserveById.has(sourceId)) throw new Error(`Unknown activated reserve source: ${sourceId}`);
  }
  const frozenSources = [
    ...sourceFreeze.active_sources,
    ...activatedReserveIds.map((sourceId) => reserveById.get(sourceId)),
  ];
  const frozenIds = frozenSources.map((source) => source.source_id);
  const registryIds = registry.sources.map((source) => source.source_id);
  if (new Set(frozenIds).size !== frozenIds.length
    || new Set(registryIds).size !== registryIds.length
    || !sameSet(new Set(frozenIds), new Set(registryIds))) {
    throw new Error("Registry source IDs do not exactly match the frozen source selection");
  }
  return new Map(frozenSources.map((source) => [source.source_id, source]));
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

function fileContainsAscii(filePath, values) {
  const needles = values.map((value) => Buffer.from(value, "ascii"));
  const overlapBytes = Math.max(...needles.map((needle) => needle.length)) - 1;
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let overlap = Buffer.alloc(0);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return false;
      const chunk = Buffer.concat([overlap, buffer.subarray(0, bytesRead)]);
      if (needles.some((needle) => chunk.indexOf(needle) >= 0)) return true;
      overlap = chunk.subarray(Math.max(0, chunk.length - overlapBytes));
    }
  } finally {
    closeSync(descriptor);
  }
}

function prepareEmptySnapshotRoot(snapshotRoot) {
  if (existsSync(snapshotRoot)) {
    const stat = lstatSync(snapshotRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Snapshot root must be a regular directory");
    }
    if (readdirSync(snapshotRoot).length > 0) {
      throw new Error("Snapshot root must be empty before packet construction");
    }
  } else {
    mkdirSync(snapshotRoot, { recursive: true });
  }
  return realpathSync(snapshotRoot);
}

function parseGitTree(repository, parentCommit) {
  const raw = execFileSync(
    "git",
    ["ls-tree", "-rz", "--full-tree", "-r", parentCommit],
    { cwd: repository, encoding: null, stdio: ["ignore", "pipe", "pipe"] }
  );
  return raw.subarray(0, raw.length - 1).toString("utf8").split("\0").map((record, index) => {
    const tab = record.indexOf("\t");
    if (tab < 0) throw new Error(`Invalid git ls-tree record at index ${index}`);
    const [mode, type, objectId] = record.slice(0, tab).split(" ");
    const filePath = normalizeRelativePath(record.slice(tab + 1), `git_tree[${index}].path`);
    if (filePath.split("/").includes(".git")) {
      throw new Error(`Git tree contains prohibited VCS metadata path: ${filePath}`);
    }
    if (!/^[0-9a-f]+$/u.test(objectId ?? "")) {
      throw new Error(`Invalid Git object id for ${filePath}`);
    }
    return { mode, type, objectId, path: filePath };
  });
}

function materializeGitTree(repository, parentCommit, stagingRoot, snapshotId) {
  const entries = parseGitTree(repository, parentCommit).map((entry) => {
    const target = resolve(stagingRoot, entry.path);
    if (!isContained(stagingRoot, target)) throw new Error(`Git path escapes staging root: ${entry.path}`);
    if (entry.type === "commit" && entry.mode === "160000") {
      mkdirSync(target, { recursive: true });
      return {
        path: entry.path,
        mode: entry.mode,
        type: "gitlink",
        git_object_id: entry.objectId,
        materialized_as: "empty_directory_without_submodule_history",
      };
    }
    if (entry.type !== "blob" || !["100644", "100755", "120000"].includes(entry.mode)) {
      throw new Error(`Unsupported Git tree entry ${entry.mode} ${entry.type} at ${entry.path}`);
    }
    const content = gitObject(repository, entry.objectId);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.mode === "120000") {
      const linkTarget = content.toString("utf8");
      if (isAbsolute(linkTarget)) throw new Error(`Absolute symlink target at ${entry.path}`);
      const resolvedTarget = resolve(dirname(target), linkTarget);
      if (!isContained(stagingRoot, resolvedTarget)) {
        throw new Error(`Symlink escapes snapshot root at ${entry.path}`);
      }
      symlinkSync(linkTarget, target);
    } else {
      writeFileSync(target, content, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
    }
    return {
      path: entry.path,
      mode: entry.mode,
      type: entry.mode === "120000" ? "symlink" : "file",
      git_object_id: entry.objectId,
      content_sha256: sha256(content),
      bytes: content.length,
    };
  });
  return {
    schema_version: "1.0",
    artifact_type: "history_free_git_tree_snapshot_manifest",
    snapshot_id: snapshotId,
    entry_count: entries.length,
    entries,
  };
}

function materializeHistoryFreeSnapshot(repository, parentCommit, snapshotRoot, snapshotId) {
  const archiveName = `${snapshotId}.tar`;
  const archivePath = join(snapshotRoot, archiveName);
  const manifestName = `${snapshotId}.manifest.json`;
  const manifestPath = join(snapshotRoot, manifestName);
  const temporaryRoot = mkdtempSync(join(snapshotRoot, ".snapshot-build-"));
  const stagingRoot = join(temporaryRoot, "tree");
  const temporaryArchive = join(temporaryRoot, "snapshot.tar");
  mkdirSync(stagingRoot);
  try {
    const manifest = materializeGitTree(repository, parentCommit, stagingRoot, snapshotId);
    execFileSync("tar", [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--exclude=.git",
      "-cf", temporaryArchive,
      "-C", stagingRoot,
      ".",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    renameSync(temporaryArchive, archivePath);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return {
    archiveName,
    archivePath,
    sha256: sha256File(archivePath),
    bytes: statSync(archivePath).size,
    manifestName,
    manifestPath,
    manifestSha256: sha256File(manifestPath),
    manifestBytes: statSync(manifestPath).size,
  };
}

function verifySnapshotInventory(snapshotRoot, snapshots) {
  const expected = new Set([...snapshots.values()].flatMap((snapshot) => [
    snapshot.archiveName,
    snapshot.manifestName,
  ]));
  const observed = readdirSync(snapshotRoot, { withFileTypes: true });
  const invalid = observed.filter((entry) => !entry.isFile() || !expected.has(entry.name));
  if (invalid.length > 0 || observed.length !== expected.size) {
    throw new Error("Snapshot root does not match the closed archive and manifest inventory");
  }
  return [...snapshots.values()].map((snapshot) => ({
    archive: snapshot.archiveName,
    archive_sha256: snapshot.sha256,
    archive_bytes: snapshot.bytes,
    manifest: snapshot.manifestName,
    manifest_sha256: snapshot.manifestSha256,
    manifest_bytes: snapshot.manifestBytes,
  }));
}

function assertNoProhibitedKeys(value, prohibitedKeys, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoProhibitedKeys(item, prohibitedKeys, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (prohibitedKeys.has(key)) throw new Error(`Prohibited key in packet at ${path}.${key}`);
    assertNoProhibitedKeys(item, prohibitedKeys, `${path}.${key}`);
  }
}

function assertOnlyAllowedPacketKeys(packets, allowedKeys) {
  for (const packet of packets) {
    const unexpected = Object.keys(packet).filter((key) => !allowedKeys.has(key));
    if (unexpected.length > 0) {
      throw new Error(
        `${packet.anonymous_lineage_id} contains non-contract packet fields: ${unexpected.join(", ")}`
      );
    }
  }
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, filePath);
}

let pendingSnapshotBuildRoot = null;
let publishedSnapshotFiles = [];

try {
  const args = parseArgs(process.argv.slice(2));
  const registry = readJson(args.registry);
  const protocol = readJson(args.protocol);
  const sourceFreeze = readJson(args["source-freeze"]);
  if (registry.value.schema_version !== "1.0"
    || registry.value.artifact_type !== "heldout_lineage_registry") {
    throw new Error("Registry must be a schema 1.0 heldout_lineage_registry");
  }
  if (registry.value.frozen_before_probe_design !== true
    || registry.value.method_outcomes_observed !== false
    || registry.value.baseline_outcomes_observed !== false) {
    throw new Error("Registry must be frozen before probe design and before outcomes");
  }
  if (!Array.isArray(registry.value.census_bindings) || registry.value.census_bindings.length === 0) {
    throw new Error("Registry must bind at least one completed census");
  }
  for (const [index, binding] of registry.value.census_bindings.entries()) {
    requireString(binding.path, `census_bindings[${index}].path`);
    if (!/^[a-f0-9]{64}$/u.test(binding.sha256 ?? "")) {
      throw new Error(`census_bindings[${index}].sha256 must be lowercase SHA-256`);
    }
  }
  const candidateAccounting = verifyCandidateAccounting(registry.value, args["evidence-root"]);
  if (protocol.value.schema_version !== "1.0"
    || protocol.value.artifact_type !== "blinded_confirmatory_protocol") {
    throw new Error("Protocol must be a schema 1.0 blinded_confirmatory_protocol");
  }
  const protocolHash = sha256(protocol.raw);
  if (registry.value.protocol_sha256 !== protocolHash) {
    throw new Error("Registry protocol_sha256 does not match the supplied protocol");
  }
  const sourceFreezeHash = sha256(sourceFreeze.raw);
  const frozenSources = validateSourceFreeze(
    sourceFreeze.value,
    sourceFreezeHash,
    protocol.value,
    registry.value
  );
  if (!Array.isArray(registry.value.sources) || registry.value.sources.length === 0) {
    throw new Error("Registry must include sources");
  }
  const sources = new Map();
  const blindedSourceIds = new Set();
  for (const [index, source] of registry.value.sources.entries()) {
    const sourceId = requireString(source.source_id, `sources[${index}].source_id`);
    if (sources.has(sourceId)) throw new Error(`Duplicate source_id: ${sourceId}`);
    const blindedSourceId = requireString(
      source.blinded_source_id,
      `sources[${index}].blinded_source_id`
    );
    if (blindedSourceIds.has(blindedSourceId)) {
      throw new Error(`Duplicate blinded_source_id: ${blindedSourceId}`);
    }
    blindedSourceIds.add(blindedSourceId);
    const repository = resolveRepository(resolve(args["repo-root"]), source.cache_key);
    const frozenSource = frozenSources.get(sourceId);
    if (source.pinned_head !== frozenSource.pinned_head
      || source.independence_cluster !== frozenSource.independence_cluster) {
      throw new Error(`${sourceId} source pin or independence cluster drifted from source freeze`);
    }
    git(repository, ["cat-file", "-e", `${source.pinned_head}^{commit}`]);
    sources.set(sourceId, {
      blindedSourceId,
      repository,
      pinnedHead: source.pinned_head,
      boundedEnvironmentNotes: requireStringArray(
        source.bounded_environment_notes,
        `${sourceId}.bounded_environment_notes`,
        { allowEmpty: true }
      ),
    });
  }
  if (!Array.isArray(registry.value.lineages) || registry.value.lineages.length === 0) {
    throw new Error("Registry must include lineages");
  }
  const lineageIds = new Set();
  const registryIndices = new Set();
  const parentCommits = [];
  const fixCommits = [];
  const snapshots = new Map();
  const snapshotRoot = prepareEmptySnapshotRoot(resolve(args["snapshot-root"]));
  pendingSnapshotBuildRoot = mkdtempSync(join(snapshotRoot, ".packet-set-build-"));
  const orderedLineages = [...registry.value.lineages].sort(
    (left, right) => left.registry_index - right.registry_index
  );
  const packets = orderedLineages.map((lineage, index) => {
    const lineageId = requireString(lineage.anonymous_lineage_id, `lineages[${index}].anonymous_lineage_id`);
    if (lineageIds.has(lineageId)) throw new Error(`Duplicate anonymous_lineage_id: ${lineageId}`);
    lineageIds.add(lineageId);
    if (!Number.isInteger(lineage.registry_index) || lineage.registry_index < 0) {
      throw new Error(`${lineageId}.registry_index must be a nonnegative integer`);
    }
    if (registryIndices.has(lineage.registry_index)) {
      throw new Error(`Duplicate registry_index: ${lineage.registry_index}`);
    }
    registryIndices.add(lineage.registry_index);
    const sourceId = requireString(lineage.source_id, `${lineageId}.source_id`);
    const source = sources.get(sourceId);
    if (!source) throw new Error(`${lineageId} references unknown source_id ${sourceId}`);
    const parentCommit = requireString(lineage.parent_commit, `${lineageId}.parent_commit`);
    const fixCommit = requireString(lineage.fix_commit, `${lineageId}.fix_commit`);
    git(source.repository, ["cat-file", "-e", `${parentCommit}^{commit}`]);
    git(source.repository, ["cat-file", "-e", `${fixCommit}^{commit}`]);
    const fixParents = git(source.repository, ["rev-list", "--parents", "-n", "1", fixCommit])
      .split(/\s+/u)
      .slice(1);
    if (!fixParents.includes(parentCommit)) {
      throw new Error(`${lineageId} parent_commit is not a direct parent of fix_commit`);
    }
    git(source.repository, ["merge-base", "--is-ancestor", fixCommit, source.pinnedHead]);
    const observedParentTree = git(source.repository, ["rev-parse", `${parentCommit}^{tree}`]);
    if (lineage.parent_tree_hash !== observedParentTree) {
      throw new Error(`${lineageId}.parent_tree_hash does not match Git`);
    }
    const parentLicense = gitBlob(
      source.repository,
      parentCommit,
      lineage.parent_license_path
    );
    if (sha256(parentLicense) !== lineage.parent_license_sha256) {
      throw new Error(`${lineageId}.parent_license_sha256 does not match the parent Git tree`);
    }
    const snapshotKey = `${sourceId}:${observedParentTree}`;
    let snapshot = snapshots.get(snapshotKey);
    if (!snapshot) {
      const snapshotId = `snapshot_${String(snapshots.size + 1).padStart(3, "0")}`;
      snapshot = materializeHistoryFreeSnapshot(
        source.repository,
        parentCommit,
        pendingSnapshotBuildRoot,
        snapshotId
      );
      snapshots.set(snapshotKey, snapshot);
    }
    if (fileContainsAscii(snapshot.archivePath, [parentCommit, fixCommit])) {
      rmSync(snapshot.archivePath, { force: true });
      throw new Error(`${lineageId} snapshot leaks a parent or fix commit identifier`);
    }
    const corePacket = {
      anonymous_lineage_id: lineageId,
      registry_index: lineage.registry_index,
      blinded_source_id: source.blindedSourceId,
      license_status: "verified_for_local_execution_and_derived_measurements",
      source_snapshot_archive: snapshot.archiveName,
      source_snapshot_sha256: snapshot.sha256,
      source_snapshot_bytes: snapshot.bytes,
      source_snapshot_manifest: snapshot.manifestName,
      source_snapshot_manifest_sha256: snapshot.manifestSha256,
      source_snapshot_manifest_bytes: snapshot.manifestBytes,
      bounded_environment_notes: source.boundedEnvironmentNotes,
    };
    parentCommits.push(parentCommit);
    fixCommits.push(fixCommit);
    return {
      ...corePacket,
      packet_sha256: stablePacketHash(corePacket),
    };
  });

  const prohibitedKeys = new Set(
    protocol.value.blind_packet_contract?.forbidden_fields ?? []
  );
  const allowedPacketKeys = new Set(
    protocol.value.blind_packet_contract?.allowed_fields ?? []
  );
  if (allowedPacketKeys.size === 0) {
    throw new Error("Protocol blind_packet_contract.allowed_fields must be non-empty");
  }
  const snapshotInventory = verifySnapshotInventory(pendingSnapshotBuildRoot, snapshots);
  const output = {
    schema_version: "1.0",
    artifact_type: "heldout_parent_only_packet_set",
    registry_sha256: sha256(registry.raw),
    protocol_sha256: protocolHash,
    source_freeze_sha256: sourceFreezeHash,
    packet_count: packets.length,
    source_count: new Set(packets.map((packet) => packet.blinded_source_id)).size,
    snapshot_count: snapshots.size,
    snapshot_inventory: snapshotInventory,
    candidate_accounting: candidateAccounting,
    closed_inventory: true,
    fix_information_included: false,
    vcs_history_included: false,
    network_required_for_design: false,
    packets,
  };
  assertNoProhibitedKeys(output, prohibitedKeys);
  assertOnlyAllowedPacketKeys(packets, allowedPacketKeys);
  const serialized = JSON.stringify(output);
  for (const commit of [...parentCommits, ...fixCommits]) {
    if (serialized.includes(commit)) {
      throw new Error("A parent or fix commit leaked into the parent-only packet set");
    }
  }
  for (const entry of readdirSync(pendingSnapshotBuildRoot, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`Unexpected snapshot staging entry: ${entry.name}`);
    const destination = join(snapshotRoot, entry.name);
    renameSync(join(pendingSnapshotBuildRoot, entry.name), destination);
    publishedSnapshotFiles.push(destination);
  }
  rmSync(pendingSnapshotBuildRoot, { recursive: true, force: true });
  pendingSnapshotBuildRoot = null;
  atomicWriteJson(args.output, output);
  publishedSnapshotFiles = [];
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  if (pendingSnapshotBuildRoot && existsSync(pendingSnapshotBuildRoot)) {
    rmSync(pendingSnapshotBuildRoot, { recursive: true, force: true });
  }
  for (const filePath of publishedSnapshotFiles) rmSync(filePath, { force: true });
  fail(error instanceof Error ? error.message : String(error));
}
