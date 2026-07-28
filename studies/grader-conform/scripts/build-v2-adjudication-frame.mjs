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

const ALLOWED_CANDIDATE_FIELDS = new Set([
  "candidate_id",
  "commit_subject",
  "committed_at",
  "direct_parent_commit",
  "duplicate_cluster_evidence",
  "evaluator_paths",
  "evidence_paths",
  "fault_family_guess",
  "fix_commit",
  "id",
  "inclusion_evidence",
  "inclusion_reason",
  "independence_cluster",
  "independence_risk",
  "license_evidence",
  "parent_commit",
  "parent_revision_public_contract_paths",
  "parent_revision_test_paths",
  "public_contract_anchor",
  "root_cause_cluster",
  "source_id",
]);

const REQUIRED_CANDIDATE_FIELDS = [
  "candidate_id",
  "source_id",
  "parent_commit",
  "fix_commit",
  "root_cause_cluster",
  "evaluator_paths",
  "parent_revision_public_contract_paths",
  "parent_revision_test_paths",
  "inclusion_evidence",
  "license_evidence",
  "duplicate_cluster_evidence",
];

const OUTCOME_ACTORS = new Set(["method", "methods", "baseline", "baselines", "probe", "probes"]);
const OUTCOME_TOKENS = new Set([
  "outcome",
  "outcomes",
  "result",
  "results",
  "detection",
  "detections",
  "detected",
  "score",
  "scores",
]);
const FORBIDDEN_DECISION_KEYS = new Set([
  "adjudication",
  "adjudications",
  "adjudication_details",
  "admit",
  "admitted",
  "decision",
  "decisions",
  "exclude",
  "excluded",
  "probe_status",
  "review_status",
]);

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
    "evidence-manifest",
    "evidence-root",
    "expected-candidate-count",
    "output-root",
  ]) {
    if (!values[required]) fail(`Missing --${required}`);
  }
  const expectedCandidateCount = Number(values["expected-candidate-count"]);
  if (!Number.isSafeInteger(expectedCandidateCount) || expectedCandidateCount <= 0) {
    fail("--expected-candidate-count must be a positive integer");
  }
  return { ...values, expectedCandidateCount };
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

function resolveRegularFile(root, reference, label) {
  const portablePath = normalizeRelativePath(reference, label);
  const candidate = resolve(root, portablePath);
  if (!isContained(root, candidate)) throw new Error(`${label} escapes evidence root`);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const realCandidate = realpathSync(candidate);
  if (!isContained(root, realCandidate)) throw new Error(`${label} resolves outside evidence root`);
  return { portablePath, realPath: realCandidate };
}

function structuredTokens(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function assertNoPriorDecisionOrStudyOutcome(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPriorDecisionOrStudyOutcome(item, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    const fieldPath = `${label}.${key}`;
    const tokens = structuredTokens(key);
    const canonicalKey = tokens.join("_");
    const actorIndex = tokens.findIndex((token) => OUTCOME_ACTORS.has(token));
    const actorThenOutcome = actorIndex >= 0
      && tokens.some((token, index) => index > actorIndex && OUTCOME_TOKENS.has(token));
    const applicabilityDecision = tokens.includes("applicability")
      && (tokens.includes("relation") || tokens.includes("template"));
    if (FORBIDDEN_DECISION_KEYS.has(canonicalKey) || actorThenOutcome || applicabilityDecision) {
      throw new Error(`Forbidden prior decision or study outcome field at ${fieldPath}`);
    }
    assertNoPriorDecisionOrStudyOutcome(item, fieldPath);
  }
}

function validateCandidate(candidate, label) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(candidate);
  const unknown = keys.filter((key) => !ALLOWED_CANDIDATE_FIELDS.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`);
  for (const field of REQUIRED_CANDIDATE_FIELDS) {
    if (!(field in candidate)) throw new Error(`${label} is missing ${field}`);
  }
  requireString(candidate.candidate_id, `${label}.candidate_id`);
  requireString(candidate.source_id, `${label}.source_id`);
  requireString(candidate.parent_commit, `${label}.parent_commit`);
  requireString(candidate.fix_commit, `${label}.fix_commit`);
  requireString(candidate.root_cause_cluster, `${label}.root_cause_cluster`);
  for (const field of [
    "evaluator_paths",
    "parent_revision_public_contract_paths",
    "parent_revision_test_paths",
  ]) {
    if (!Array.isArray(candidate[field])) throw new Error(`${label}.${field} must be an array`);
  }
  assertNoPriorDecisionOrStudyOutcome(candidate, label);
}

function verifyClosedInventory(root, manifestPath, artifactPaths) {
  const expected = new Set([manifestPath, ...artifactPaths]);
  const observed = new Set();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Evidence root contains non-regular entry ${entry.name}`);
    }
    observed.add(entry.name);
  }
  if (expected.size !== observed.size
    || [...expected].some((path) => !observed.has(path))) {
    throw new Error("Evidence root inventory differs from the closed manifest");
  }
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function publishFrameBundle(outputRootArgument, controllerFrame, reviewerFrame) {
  const outputRoot = resolve(outputRootArgument);
  if (existsSync(outputRoot)) throw new Error("Output root already exists");
  mkdirSync(dirname(outputRoot), { recursive: true });
  const stagingRoot = mkdtempSync(`${outputRoot}.staging-`);
  let published = false;
  try {
    const controllerPath = resolve(stagingRoot, "controller-frame.json");
    const reviewerPath = resolve(stagingRoot, "reviewer-frame.json");
    writeJson(controllerPath, controllerFrame);
    writeJson(reviewerPath, reviewerFrame);
    const artifacts = [
      ["controller_frame", "controller-frame.json", controllerPath, controllerFrame],
      ["reviewer_frame", "reviewer-frame.json", reviewerPath, reviewerFrame],
    ].map(([artifactId, path, filePath, value]) => ({
      artifact_id: artifactId,
      path,
      sha256: sha256(readFileSync(filePath)),
      bytes: statSync(filePath).size,
      content_sha256: value.content_sha256,
    }));
    const manifestPayload = {
      schema_version: "2.0",
      artifact_type: "v2_eligibility_adjudication_frame_bundle_manifest",
      closed_inventory: true,
      candidate_count: controllerFrame.candidates.length,
      artifacts,
    };
    writeJson(resolve(stagingRoot, "manifest.json"), {
      ...manifestPayload,
      content_sha256: canonicalHash(manifestPayload),
    });
    renameSync(stagingRoot, outputRoot);
    published = true;
  } finally {
    if (!published && existsSync(stagingRoot)) {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
}

function buildFrame(args) {
  const evidenceRoot = realpathSync(args["evidence-root"]);
  const manifestRealPath = realpathSync(args["evidence-manifest"]);
  const expectedManifestPath = resolve(evidenceRoot, "manifest.json");
  if (manifestRealPath !== expectedManifestPath) {
    throw new Error("Evidence manifest must be evidence-root/manifest.json");
  }
  const manifest = readJson(manifestRealPath);
  if (manifest.value.schema_version !== "1.0"
    || manifest.value.artifact_type !== "sealed_heldout_evidence_manifest"
    || manifest.value.frozen_before_probe_design !== true
    || manifest.value.method_outcomes_observed !== false
    || manifest.value.baseline_outcomes_observed !== false
    || manifest.value.closed_inventory !== true
    || !Array.isArray(manifest.value.artifacts)
    || manifest.value.artifacts.length === 0) {
    throw new Error("Evidence manifest is not a closed pre-outcome manifest");
  }

  const artifactPaths = manifest.value.artifacts.map((artifact, index) => (
    normalizeRelativePath(artifact.path, `manifest.artifacts[${index}].path`)
  ));
  if (artifactPaths.some((path) => path.includes("/"))) {
    throw new Error("Evidence artifacts must be direct children of evidence root");
  }
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    throw new Error("Evidence manifest contains duplicate artifact paths");
  }
  verifyClosedInventory(evidenceRoot, "manifest.json", artifactPaths);

  const sourceGroups = [];
  const records = [];
  const candidateIds = new Set();
  for (const [groupIndex, binding] of manifest.value.artifacts.entries()) {
    const groupId = requireString(binding.group_id, `manifest.artifacts[${groupIndex}].group_id`);
    const file = resolveRegularFile(evidenceRoot, binding.path, `manifest.artifacts[${groupIndex}].path`);
    const raw = readFileSync(file.realPath);
    const artifactHash = sha256(raw);
    if (artifactHash !== requireHash(binding.sha256, `manifest.artifacts[${groupIndex}].sha256`)) {
      throw new Error(`${groupId} bytes drifted from the sealed manifest`);
    }
    if (statSync(file.realPath).size !== binding.bytes) {
      throw new Error(`${groupId} byte length drifted from the sealed manifest`);
    }
    const group = JSON.parse(raw.toString("utf8"));
    if (group.schema_version !== "1.0"
      || group.artifact_type !== "sealed_heldout_census_and_adjudication"
      || group.status !== "complete"
      || group.group_id !== groupId
      || group.outcome_observed !== false
      || group.method_or_baseline_outcomes_included !== false
      || !Array.isArray(group.candidates)) {
      throw new Error(`${groupId} is not a sealed pre-outcome evidence group`);
    }
    if (group.candidates.length !== binding.candidate_accounting?.census_candidate_count
      || group.candidates.length !== group.candidate_accounting?.census_candidate_count) {
      throw new Error(`${groupId} candidate accounting does not match sealed candidates`);
    }
    sourceGroups.push({
      group_id: groupId,
      path: file.portablePath,
      sha256: artifactHash,
      bytes: raw.length,
      candidate_count: group.candidates.length,
    });
    for (const [candidateIndex, candidate] of group.candidates.entries()) {
      const label = `${groupId}.candidates[${candidateIndex}]`;
      validateCandidate(candidate, label);
      const candidateId = candidate.candidate_id;
      if (candidateIds.has(candidateId)) throw new Error(`Duplicate candidate_id ${candidateId}`);
      candidateIds.add(candidateId);
      const recordPayload = {
        frame_index: records.length + 1,
        source_group_id: groupId,
        candidate_id: candidateId,
        source_candidate_sha256: canonicalHash(candidate),
        candidate,
      };
      records.push({ ...recordPayload, record_sha256: canonicalHash(recordPayload) });
    }
  }

  if (records.length !== args.expectedCandidateCount) {
    throw new Error(
      `Expected ${args.expectedCandidateCount} retained candidates but observed ${records.length}`
    );
  }
  const payload = {
    schema_version: "2.0",
    artifact_type: "outcome_blind_v2_retained_candidate_controller_frame",
    source_evidence_manifest: {
      path: "manifest.json",
      sha256: sha256(manifest.raw),
      seal_plan_sha256: requireHash(
        manifest.value.seal_plan_sha256,
        "manifest.seal_plan_sha256"
      ),
    },
    frame_contract: {
      selection_basis: "all_retained_sealed_census_candidates",
      intended_use: "integrity_mapping_and_reviewer_projection_only",
      direct_eligibility_adjudicator_input_allowed: false,
      expected_candidate_count: args.expectedCandidateCount,
      observed_candidate_count: records.length,
      prior_v1_adjudication_dispositions_included: false,
      prior_v1_admission_count_used_as_denominator: false,
      relation_or_template_applicability_used_for_eligibility: false,
      method_outcomes_included: false,
      baseline_outcomes_included: false,
    },
    source_groups: sourceGroups,
    candidates: records,
  };
  return { ...payload, content_sha256: canonicalHash(payload) };
}

function buildReviewerFrame(controllerFrame) {
  const opaqueIds = new Set();
  const candidates = controllerFrame.candidates.map((record, index) => {
    const candidate = record.candidate;
    const opaqueCandidateId = `v2cand_${sha256(
      `${controllerFrame.source_evidence_manifest.sha256}:${record.record_sha256}`
    ).slice(0, 20)}`;
    if (opaqueIds.has(opaqueCandidateId)) {
      throw new Error(`Opaque candidate identifier collision at frame index ${index + 1}`);
    }
    opaqueIds.add(opaqueCandidateId);
    const payload = {
      frame_index: record.frame_index,
      opaque_candidate_id: opaqueCandidateId,
      controller_record_sha256: record.record_sha256,
      source_id: candidate.source_id,
      parent_commit: candidate.parent_commit,
      fix_commit: candidate.fix_commit,
      evaluator_paths: [...candidate.evaluator_paths],
      evidence_paths: Array.isArray(candidate.evidence_paths)
        ? [...candidate.evidence_paths]
        : [],
      parent_revision_public_contract_paths: [
        ...candidate.parent_revision_public_contract_paths,
      ],
      parent_revision_test_paths: [...candidate.parent_revision_test_paths],
    };
    return { ...payload, record_sha256: canonicalHash(payload) };
  });
  const payload = {
    schema_version: "2.0",
    artifact_type: "outcome_blind_v2_independent_eligibility_review_frame",
    source_controller_frame_content_sha256: controllerFrame.content_sha256,
    source_evidence_manifest_sha256: controllerFrame.source_evidence_manifest.sha256,
    review_contract: {
      expected_candidate_count: candidates.length,
      original_candidate_identifiers_included: false,
      prior_v1_adjudication_dispositions_included: false,
      prior_inclusion_reasons_included: false,
      prior_fault_family_or_root_cause_labels_included: false,
      prior_duplicate_or_independence_judgments_included: false,
      relation_or_template_applicability_included: false,
      method_outcomes_included: false,
      baseline_outcomes_included: false,
    },
    candidates,
  };
  return { ...payload, content_sha256: canonicalHash(payload) };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const controllerFrame = buildFrame(args);
  const reviewerFrame = buildReviewerFrame(controllerFrame);
  publishFrameBundle(args["output-root"], controllerFrame, reviewerFrame);
  process.stdout.write(`${JSON.stringify({
    output_root: args["output-root"],
    candidate_count: controllerFrame.candidates.length,
    controller_content_sha256: controllerFrame.content_sha256,
    reviewer_content_sha256: reviewerFrame.content_sha256,
  }, null, 2)}\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
