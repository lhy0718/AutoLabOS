#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
    if (!key?.startsWith("--") || value === undefined) fail("Expected paired --key value arguments.");
    values[key.slice(2)] = value;
  }
  for (const required of [
    "evidence-manifest",
    "evidence-root",
    "protocol",
    "source-freeze",
    "source-plan",
    "repo-root",
    "output",
  ]) {
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

function requireStringArray(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const values = value.map((item, index) => requireString(item, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  return values;
}

function requireHash(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function requireObjectId(value, label) {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new Error(`${label} must be a full lowercase Git object ID`);
  }
  return value;
}

function normalizePublicRemoteIdentity(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new Error(`${label} must be a frozen public HTTPS Git URL`);
  }
  const remoteUrl = value;
  let parsed;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new Error(`${label} must be a frozen public HTTPS Git URL`);
  }
  if (parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || (parsed.port !== "" && parsed.port !== "443")) {
    throw new Error(`${label} must be a frozen public HTTPS Git URL`);
  }
  const hostnameAliases = new Map([
    ["www.github.com", "github.com"],
    ["www.gitlab.com", "gitlab.com"],
    ["www.bitbucket.org", "bitbucket.org"],
  ]);
  const hostname = hostnameAliases.get(parsed.hostname.toLowerCase())
    ?? parsed.hostname.toLowerCase();
  if (!hostname.includes(".")
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".invalid")) {
    throw new Error(`${label} must be a frozen public HTTPS Git URL`);
  }
  let pathname = parsed.pathname.replace(/\/+$/u, "").replace(/\.git$/iu, "");
  if (!pathname.startsWith("/") || pathname.includes("%")) {
    throw new Error(`${label} must be a frozen public HTTPS Git URL`);
  }
  const segments = pathname.slice(1).split("/");
  if (segments.length < 2
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${label} must identify a public Git repository path`);
  }
  pathname = `/${segments.join("/")}`;
  return `https://${hostname}${pathname}`;
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

function resolveRegularFile(root, reference, label) {
  const realRoot = realpathSync(root);
  const portablePath = normalizeRelativePath(reference, label);
  const candidate = resolve(realRoot, portablePath);
  if (!isContained(realRoot, candidate)) throw new Error(`${label} escapes its root`);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const realCandidate = realpathSync(candidate);
  if (!isContained(realRoot, realCandidate)) throw new Error(`${label} resolves outside its root`);
  return { portablePath, realPath: realCandidate };
}

function resolveRepository(repoRoot, cacheKey) {
  const realRoot = realpathSync(repoRoot);
  const normalized = normalizeRelativePath(cacheKey, "source.cache_key");
  const candidate = resolve(realRoot, normalized);
  if (!isContained(realRoot, candidate)) throw new Error(`Source cache escapes repo root: ${normalized}`);
  const stat = lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Source cache must be a regular directory: ${normalized}`);
  }
  const repository = realpathSync(candidate);
  if (!isContained(realRoot, repository)) throw new Error(`Source cache resolves outside root: ${normalized}`);
  git(repository, ["rev-parse", "--git-dir"]);
  return repository;
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function verifyExactCommit(repository, value, label) {
  const objectId = requireObjectId(value, label);
  const resolved = requireObjectId(
    git(repository, ["rev-parse", "--verify", `${objectId}^{commit}`]),
    `${label} resolved commit`
  );
  if (resolved !== objectId) throw new Error(`${label} does not resolve to its frozen object ID`);
  return resolved;
}

function gitCommitExists(repository, objectId) {
  try {
    git(repository, ["cat-file", "-e", `${objectId}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function resolveObjectDirectory(repository) {
  const rawPath = git(repository, ["rev-parse", "--git-path", "objects"]);
  const candidate = isAbsolute(rawPath) ? rawPath : resolve(repository, rawPath);
  const objectDirectory = realpathSync(candidate);
  if (!lstatSync(objectDirectory).isDirectory()) {
    throw new Error("Git object database must be a directory");
  }
  return objectDirectory;
}

function collectObjectDatabaseRoots(repository) {
  const roots = new Set();
  const pending = [resolveObjectDirectory(repository)];
  while (pending.length > 0) {
    const objectDirectory = realpathSync(pending.pop());
    if (roots.has(objectDirectory)) continue;
    if (!lstatSync(objectDirectory).isDirectory()) {
      throw new Error("Git alternate object database must be a directory");
    }
    roots.add(objectDirectory);
    const alternatesFile = resolve(objectDirectory, "info", "alternates");
    if (!existsSync(alternatesFile)) continue;
    const alternateStat = lstatSync(alternatesFile);
    if (!alternateStat.isFile() || alternateStat.isSymbolicLink()) {
      throw new Error("Git alternates declaration must be a regular file");
    }
    const alternatePaths = readFileSync(alternatesFile, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line !== "");
    for (const alternatePath of alternatePaths) {
      if (alternatePath.includes("\0")) {
        throw new Error("Git alternates declaration contains an invalid path");
      }
      const candidate = isAbsolute(alternatePath)
        ? alternatePath
        : resolve(objectDirectory, alternatePath);
      const alternateRoot = realpathSync(candidate);
      if (!lstatSync(alternateRoot).isDirectory()) {
        throw new Error("Git alternate object database must be a directory");
      }
      pending.push(alternateRoot);
    }
  }
  return roots;
}

function inspectRepository(repoRoot, cacheKey, source) {
  const sourceId = requireString(source.source_id, "source_id");
  const publicRemoteIdentity = normalizePublicRemoteIdentity(
    source.remote_url,
    `${sourceId}.remote_url`
  );
  const pinnedHead = requireObjectId(source.pinned_head, `${sourceId}.pinned_head`);
  const independenceCluster = requireString(
    source.independence_cluster,
    `${sourceId}.independence_cluster`
  );
  const repository = resolveRepository(repoRoot, cacheKey);
  let originUrl;
  try {
    originUrl = git(repository, ["config", "--get", "remote.origin.url"]);
  } catch {
    throw new Error(`${sourceId} local repository has no origin remote`);
  }
  const localRemoteIdentity = normalizePublicRemoteIdentity(
    originUrl,
    `${sourceId}.local_origin_url`
  );
  if (localRemoteIdentity !== publicRemoteIdentity) {
    throw new Error(`${sourceId} local origin does not match its frozen public remote identity`);
  }
  const verifiedPinnedHead = verifyExactCommit(
    repository,
    pinnedHead,
    `${sourceId}.pinned_head`
  );
  const pinnedTree = requireObjectId(
    git(repository, ["rev-parse", "--verify", `${verifiedPinnedHead}^{tree}`]),
    `${sourceId}.pinned_tree`
  );
  return {
    sourceId,
    repository,
    publicRemoteIdentity,
    pinnedHead: verifiedPinnedHead,
    pinnedTree,
    independenceCluster,
    objectDatabaseRoots: collectObjectDatabaseRoots(repository),
  };
}

function validateRepositoryIndependence(repositoryEvidence) {
  for (let leftIndex = 0; leftIndex < repositoryEvidence.length; leftIndex += 1) {
    const left = repositoryEvidence[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < repositoryEvidence.length; rightIndex += 1) {
      const right = repositoryEvidence[rightIndex];
      const pair = `${left.sourceId} and ${right.sourceId}`;
      if (left.publicRemoteIdentity === right.publicRemoteIdentity) {
        throw new Error(`Frozen sources ${pair} share frozen public remote identity`);
      }
      if (left.pinnedHead === right.pinnedHead) {
        throw new Error(`Frozen sources ${pair} share a frozen Git commit`);
      }
      if (left.pinnedTree === right.pinnedTree) {
        throw new Error(`Frozen sources ${pair} share a frozen Git tree`);
      }
      const sharedObjectRoot = [...left.objectDatabaseRoots]
        .some((objectRoot) => right.objectDatabaseRoots.has(objectRoot));
      if (sharedObjectRoot) {
        throw new Error(`Frozen sources ${pair} share Git object storage`);
      }
      if (gitCommitExists(left.repository, right.pinnedHead)
        || gitCommitExists(right.repository, left.pinnedHead)) {
        throw new Error(`Frozen sources ${pair} share frozen Git commit evidence`);
      }
    }
  }
}

function gitBlob(repository, revision, filePath) {
  return execFileSync("git", ["cat-file", "blob", `${revision}:${filePath}`], {
    cwd: repository,
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitPathExists(repository, revision, filePath) {
  try {
    git(repository, ["cat-file", "-e", `${revision}:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function atomicWriteJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, filePath);
}

function validateProtocol(protocol) {
  if (protocol.schema_version !== "1.0"
    || protocol.artifact_type !== "blinded_confirmatory_protocol") {
    throw new Error("Protocol must be a blinded confirmatory protocol");
  }
  const thresholds = protocol.promotion_gate?.machine_thresholds;
  for (const key of [
    "minimum_heldout_lineages",
    "minimum_heldout_repositories",
    "minimum_heldout_independence_clusters",
    "registered_fixed_control_count",
  ]) {
    if (!Number.isInteger(thresholds?.[key]) || thresholds[key] < 1) {
      throw new Error(`Protocol threshold ${key} is missing`);
    }
  }
  return thresholds;
}

function validateSourceFreeze(sourceFreeze, hash, protocol, activatedReserveIds) {
  if (sourceFreeze.schema_version !== "1.0"
    || sourceFreeze.artifact_type !== "heldout_source_selection_freeze"
    || sourceFreeze.status !== "frozen_before_heldout_probe_design_or_outcomes"
    || !Array.isArray(sourceFreeze.active_sources)
    || !Array.isArray(sourceFreeze.reserve_sources)) {
    throw new Error("Source freeze is invalid");
  }
  const bound = protocol.bindings?.some((binding) =>
    binding.path === "studies/grader-conform/corpus/heldout-source-freeze.v1.json"
      && binding.sha256 === hash
  );
  if (!bound) throw new Error("Protocol does not bind the supplied source freeze bytes");
  const reserveById = new Map(sourceFreeze.reserve_sources.map((source) => [source.source_id, source]));
  for (const sourceId of activatedReserveIds) {
    if (!reserveById.has(sourceId)) throw new Error(`Unknown activated reserve source: ${sourceId}`);
  }
  const sources = [
    ...sourceFreeze.active_sources,
    ...activatedReserveIds.map((sourceId) => reserveById.get(sourceId)),
  ];
  const sourceIds = sources.map((source) => requireString(source.source_id, "source_id"));
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error("Frozen source IDs are not unique");
  return sources;
}

function loadEvidence(manifest, manifestHash, evidenceRoot) {
  if (manifest.schema_version !== "1.0"
    || manifest.artifact_type !== "sealed_heldout_evidence_manifest"
    || manifest.frozen_before_probe_design !== true
    || manifest.method_outcomes_observed !== false
    || manifest.baseline_outcomes_observed !== false
    || manifest.closed_inventory !== true
    || !Array.isArray(manifest.artifacts)
    || manifest.artifacts.length === 0) {
    throw new Error("Evidence manifest is not a closed pre-outcome evidence set");
  }
  const expectedFiles = new Set(["manifest.json"]);
  const candidates = new Map();
  const decisions = new Map();
  const bindings = [];
  for (const [index, binding] of manifest.artifacts.entries()) {
    const file = resolveRegularFile(evidenceRoot, binding.path, `artifacts[${index}].path`);
    expectedFiles.add(file.portablePath);
    const evidence = readJson(file.realPath);
    const hash = sha256(evidence.raw);
    if (hash !== requireHash(binding.sha256, `artifacts[${index}].sha256`)
      || statSync(file.realPath).size !== binding.bytes) {
      throw new Error(`${file.portablePath} bytes drifted from evidence manifest`);
    }
    if (evidence.value.schema_version !== "1.0"
      || evidence.value.artifact_type !== "sealed_heldout_census_and_adjudication"
      || evidence.value.status !== "complete"
      || evidence.value.exhaustive_within_queries !== true
      || evidence.value.outcome_observed !== false
      || evidence.value.method_or_baseline_outcomes_included !== false
      || !Array.isArray(evidence.value.candidates)
      || !Array.isArray(evidence.value.exclusions)
      || !Array.isArray(evidence.value.decisions)) {
      throw new Error(`${file.portablePath} is not sealed heldout evidence`);
    }
    for (const candidate of evidence.value.candidates) {
      const candidateId = requireString(candidate.candidate_id, `${file.portablePath}.candidate_id`);
      if (candidates.has(candidateId)) throw new Error(`Duplicate candidate across evidence: ${candidateId}`);
      candidates.set(candidateId, candidate);
    }
    for (const decision of evidence.value.decisions) {
      const candidateId = requireString(decision.candidate_id, `${file.portablePath}.decision.candidate_id`);
      if (decisions.has(candidateId)) throw new Error(`Duplicate decision across evidence: ${candidateId}`);
      if (decision.decision !== "admit" && decision.decision !== "exclude") {
        throw new Error(`Invalid decision for ${candidateId}`);
      }
      decisions.set(candidateId, decision.decision);
    }
    bindings.push({ path: file.portablePath, sha256: hash });
  }
  const observedFiles = readdirSync(evidenceRoot, { withFileTypes: true });
  if (observedFiles.some((entry) => !entry.isFile() || !expectedFiles.has(entry.name))
    || observedFiles.length !== expectedFiles.size) {
    throw new Error("Evidence root does not match the closed manifest inventory");
  }
  if (!sameSet(new Set(candidates.keys()), new Set(decisions.keys()))) {
    throw new Error("Evidence candidates and decisions do not match exactly");
  }
  return { manifestHash, candidates, decisions, bindings };
}

function candidatePathList(candidate, key, allowEmpty) {
  const raw = candidate[key] ?? [];
  return requireStringArray(raw, `${candidate.candidate_id}.${key}`, allowEmpty)
    .map((filePath) => normalizeRelativePath(filePath, `${candidate.candidate_id}.${key}`));
}

function chooseLicensePath(repository, parentCommit, candidate) {
  const evidence = candidate.license_evidence ?? {};
  const declared = evidence.license_path ?? evidence.path_at_pinned_head ?? evidence.path;
  const options = [declared, "LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]
    .filter((item, index, values) => typeof item === "string" && values.indexOf(item) === index)
    .map((item) => normalizeRelativePath(item, `${candidate.candidate_id}.license_path`));
  const selected = options.find((filePath) => gitPathExists(repository, parentCommit, filePath));
  if (!selected) throw new Error(`${candidate.candidate_id} has no license file at the parent revision`);
  return selected;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const protocol = readJson(args.protocol);
  const sourceFreeze = readJson(args["source-freeze"]);
  const sourcePlan = readJson(args["source-plan"]);
  const evidenceRoot = realpathSync(args["evidence-root"]);
  const boundManifest = resolveRegularFile(evidenceRoot, "manifest.json", "evidence manifest");
  if (realpathSync(args["evidence-manifest"]) !== boundManifest.realPath) {
    throw new Error("--evidence-manifest must be the manifest.json inside evidence root");
  }
  const evidenceManifest = readJson(boundManifest.realPath);
  const protocolHash = sha256(protocol.raw);
  const sourceFreezeHash = sha256(sourceFreeze.raw);
  const sourcePlanHash = sha256(sourcePlan.raw);
  const thresholds = validateProtocol(protocol.value);
  if (sourcePlan.value.schema_version !== "1.0"
    || sourcePlan.value.artifact_type !== "heldout_registry_source_plan"
    || sourcePlan.value.frozen_before_probe_design !== true
    || sourcePlan.value.method_outcomes_observed !== false
    || sourcePlan.value.baseline_outcomes_observed !== false
    || !Array.isArray(sourcePlan.value.sources)) {
    throw new Error("Source plan must be frozen before probe design and outcomes");
  }
  const sourcePlanBound = protocol.value.bindings?.some((binding) =>
    binding.path === "studies/grader-conform/corpus/heldout-registry-source-plan.v1.json"
      && binding.sha256 === sourcePlanHash
  );
  if (!sourcePlanBound) throw new Error("Protocol does not bind the supplied source-plan bytes");
  const activatedReserveIds = requireStringArray(
    sourcePlan.value.activated_reserve_source_ids ?? [],
    "activated_reserve_source_ids",
    true
  );
  const frozenSources = validateSourceFreeze(
    sourceFreeze.value,
    sourceFreezeHash,
    protocol.value,
    activatedReserveIds
  );
  const sourcePlanById = new Map(sourcePlan.value.sources.map((source, index) => [
    requireString(source.source_id, `sources[${index}].source_id`),
    source,
  ]));
  if (sourcePlanById.size !== sourcePlan.value.sources.length) {
    throw new Error("Source plan contains duplicate source IDs");
  }
  if (!sameSet(
    new Set(sourcePlanById.keys()),
    new Set(frozenSources.map((source) => source.source_id))
  )) {
    throw new Error("Source plan IDs do not exactly match active and activated frozen sources");
  }
  const sourceOrder = new Map(frozenSources.map((source, index) => [source.source_id, index]));
  const frozenById = new Map(frozenSources.map((source) => [source.source_id, source]));
  const repositoryEvidence = frozenSources.map((source) => {
    const planSource = sourcePlanById.get(source.source_id);
    const cacheKey = normalizeRelativePath(planSource.cache_key, `${source.source_id}.cache_key`);
    return {
      ...inspectRepository(args["repo-root"], cacheKey, source),
      cacheKey,
      boundedEnvironmentNotes: requireStringArray(
        planSource.bounded_environment_notes ?? [],
        `${source.source_id}.bounded_environment_notes`,
        true
      ),
    };
  });
  validateRepositoryIndependence(repositoryEvidence);
  const repositoryEvidenceById = new Map(
    repositoryEvidence.map((item) => [item.sourceId, item])
  );
  const repositories = new Map(
    repositoryEvidence.map((item) => [item.sourceId, item.repository])
  );
  const sources = repositoryEvidence.map((item, index) => ({
    source_id: item.sourceId,
    blinded_source_id: `blind_source_${String(index + 1).padStart(2, "0")}`,
    public_remote_identity: item.publicRemoteIdentity,
    pinned_head: item.pinnedHead,
    pinned_tree_hash: item.pinnedTree,
    repository_identity_sha256: sha256(
      `${item.publicRemoteIdentity}\0${item.pinnedHead}\0${item.pinnedTree}`
    ),
    independence_cluster: item.independenceCluster,
    cache_key: item.cacheKey,
    bounded_environment_notes: item.boundedEnvironmentNotes,
  }));
  const evidence = loadEvidence(
    evidenceManifest.value,
    sha256(evidenceManifest.raw),
    evidenceRoot
  );
  const admittedUnordered = [...evidence.decisions]
    .filter(([, decision]) => decision === "admit")
    .map(([candidateId]) => evidence.candidates.get(candidateId));
  for (const candidate of admittedUnordered) {
    if (!sourceOrder.has(candidate.source_id)) {
      throw new Error(`${candidate.candidate_id} references an unfrozen source ${candidate.source_id}`);
    }
  }
  const admitted = admittedUnordered
    .sort((left, right) => {
      const sourceDifference = sourceOrder.get(left.source_id) - sourceOrder.get(right.source_id);
      return sourceDifference || left.candidate_id.localeCompare(right.candidate_id);
    });
  const admittedSourceIds = new Set(admitted.map((candidate) => candidate.source_id));
  const admittedRepositoryIdentities = new Set([...admittedSourceIds].map(
    (sourceId) => repositoryEvidenceById.get(sourceId).publicRemoteIdentity
  ));
  const admittedClusters = new Set([...admittedSourceIds].map(
    (sourceId) => repositoryEvidenceById.get(sourceId).independenceCluster
  ));
  if (admitted.length < thresholds.minimum_heldout_lineages
    || admittedRepositoryIdentities.size < thresholds.minimum_heldout_repositories
    || admittedClusters.size < thresholds.minimum_heldout_independence_clusters) {
    throw new Error(
      `Heldout scale gate failed: ${admitted.length} lineages, ${admittedRepositoryIdentities.size} repositories, ${admittedClusters.size} clusters`
    );
  }
  if (admitted.length < thresholds.registered_fixed_control_count) {
    throw new Error("Heldout corpus is too small for the registered fixed controls");
  }
  const admittedRevisionPairs = new Set();
  const lineages = admitted.map((candidate, registryIndex) => {
    const source = frozenById.get(candidate.source_id);
    const repository = repositories.get(candidate.source_id);
    const sourceRepositoryEvidence = repositoryEvidenceById.get(candidate.source_id);
    if (!source || !repository || !sourceRepositoryEvidence) {
      throw new Error(`${candidate.candidate_id} references an unfrozen source`);
    }
    if (/non-SPDX|separate scope|eligibility must be adjudicated/iu.test(source.license ?? "")) {
      throw new Error(`${candidate.candidate_id} source license is not publication-cleared`);
    }
    const parentCommit = verifyExactCommit(
      repository,
      candidate.parent_commit,
      `${candidate.candidate_id}.parent_commit`
    );
    const fixCommit = verifyExactCommit(
      repository,
      candidate.fix_commit,
      `${candidate.candidate_id}.fix_commit`
    );
    const revisionPair = `${parentCommit}\0${fixCommit}`;
    if (admittedRevisionPairs.has(revisionPair)) {
      throw new Error(`${candidate.candidate_id} duplicates an admitted parent/fix revision pair`);
    }
    admittedRevisionPairs.add(revisionPair);
    const parents = git(repository, ["rev-list", "--parents", "-n", "1", fixCommit])
      .split(/\s+/u)
      .slice(1);
    if (!parents.includes(parentCommit)) {
      throw new Error(`${candidate.candidate_id} parent is not a direct parent of the fix`);
    }
    git(repository, ["merge-base", "--is-ancestor", fixCommit, sourceRepositoryEvidence.pinnedHead]);
    const evaluatorPaths = candidatePathList(candidate, "evaluator_paths", false);
    const testPaths = candidatePathList(candidate, "parent_revision_test_paths", true);
    const contractPaths = candidatePathList(
      candidate,
      "parent_revision_public_contract_paths",
      false
    );
    for (const filePath of [...evaluatorPaths, ...testPaths, ...contractPaths]) {
      if (!gitPathExists(repository, parentCommit, filePath)) {
        throw new Error(`${candidate.candidate_id} parent path does not exist: ${filePath}`);
      }
    }
    const licensePath = chooseLicensePath(repository, parentCommit, candidate);
    const licenseBytes = gitBlob(repository, parentCommit, licensePath);
    return {
      candidate_id: candidate.candidate_id,
      anonymous_lineage_id: `heldout_lineage_${String(registryIndex + 1).padStart(3, "0")}`,
      registry_index: registryIndex,
      source_id: candidate.source_id,
      parent_commit: parentCommit,
      fix_commit: fixCommit,
      parent_tree_hash: requireObjectId(
        git(repository, ["rev-parse", "--verify", `${parentCommit}^{tree}`]),
        `${candidate.candidate_id}.parent_tree`
      ),
      parent_license_path: licensePath,
      parent_license_sha256: sha256(licenseBytes),
      parent_revision_evaluator_paths: evaluatorPaths,
      parent_revision_test_paths: testPaths,
      parent_revision_public_contract_paths: contractPaths,
      bounded_environment_notes: [],
    };
  });
  const excludedCandidateIds = [...evidence.decisions]
    .filter(([, decision]) => decision === "exclude")
    .map(([candidateId]) => candidateId)
    .sort();
  const output = {
    schema_version: "1.0",
    artifact_type: "heldout_lineage_registry",
    protocol_sha256: protocolHash,
    source_freeze_sha256: sourceFreezeHash,
    source_plan_sha256: sourcePlanHash,
    evidence_manifest_sha256: evidence.manifestHash,
    frozen_before_probe_design: true,
    method_outcomes_observed: false,
    baseline_outcomes_observed: false,
    activated_reserve_source_ids: activatedReserveIds,
    census_bindings: evidence.bindings,
    adjudication_bindings: evidence.bindings,
    excluded_candidate_ids: excludedCandidateIds,
    sources,
    lineages,
    fixed_control_lineage_ids: lineages
      .slice(0, thresholds.registered_fixed_control_count)
      .map((lineage) => lineage.anonymous_lineage_id),
  };
  atomicWriteJson(args.output, output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
