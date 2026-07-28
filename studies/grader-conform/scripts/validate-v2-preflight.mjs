#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const REQUIRED_BINDING_IDS = new Set([
  "sealed_evidence_manifest",
  "v2_frame_bundle_manifest",
  "v2_controller_frame",
  "v2_reviewer_frame",
  "local_resource_envelope",
  "v2_retained_source_freeze",
  "v2_residual_claim_matrix",
]);

const EXPECTED_SOURCE_CLUSTERS = new Map([
  ["android_world", "android_world"],
  ["appworld", "appworld"],
  ["browsergym", "browser_evaluation"],
  ["helm", "helm"],
  ["inspect_ai", "inspect"],
  ["inspect_evals", "inspect"],
  ["swe-bench", "swe_bench"],
  ["terminal-bench-2", "terminal_bench"],
  ["webarena", "browser_evaluation"],
]);

const REQUIRED_GATE_IDS = new Set([
  "outcome_blind_178_candidate_frame",
  "local_resource_envelope_fits",
  "closest_prior_and_residual_claim_matrix",
  "portable_v2_source_identity_freeze",
  "all_178_independently_adjudicated",
  "fault_sample_contract_satisfied",
  "three_control_classes_satisfied",
  "equal_information_and_budget_arms_frozen",
  "two_independent_runners_validated",
  "external_pre_outcome_timestamp",
]);

const REQUIRED_BASELINE_ARMS = new Set([
  "direct_example_contract_regression",
  "freeform_contract_property",
  "prior_work_anchored_auditor_to_executable_reproducer",
]);

const REQUIRED_LITERATURE_SOURCE_IDS = new Set([
  "kang2023libro",
  "park2026tvb",
  "ravi2025pbt",
  "tu2026benchguard",
  "wang2026aba",
  "xu2026mrcoupler",
  "yu2025utboost",
  "zhu2025abc",
]);

const REQUIRED_CONTROL_CLASSES = new Set([
  "normal_behavior",
  "unrelated_change",
  "intentional_contract_change",
]);

const REVIEWER_RECORD_FIELDS = new Set([
  "frame_index",
  "opaque_candidate_id",
  "controller_record_sha256",
  "source_id",
  "parent_commit",
  "fix_commit",
  "evaluator_paths",
  "evidence_paths",
  "parent_revision_public_contract_paths",
  "parent_revision_test_paths",
  "record_sha256",
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
  for (const required of ["protocol", "repo-root"]) {
    if (!values[required]) fail(`Missing --${required}`);
  }
  return values;
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

function requireInteger(value, expected, label) {
  if (!Number.isSafeInteger(value) || value !== expected) {
    throw new Error(`${label} must equal ${expected}`);
  }
}

function requireMaximum(value, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value > maximum) {
    throw new Error(`${label} must not exceed ${maximum}`);
  }
}

function requireMinimum(value, minimum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${label} must be at least ${minimum}`);
  }
}

function requireExactSet(values, expected, label) {
  if (!Array.isArray(values)
    || values.length !== expected.size
    || new Set(values).size !== values.length
    || values.some((value) => !expected.has(value))) {
    throw new Error(`${label} must match the frozen set`);
  }
}

function isContained(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function resolveBoundFile(repoRoot, reference, label) {
  const portablePath = requireString(reference, label).replaceAll("\\", "/");
  if (isAbsolute(portablePath)
    || portablePath === ".."
    || portablePath.startsWith("../")
    || portablePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} must be a portable repository-relative path`);
  }
  const candidate = resolve(repoRoot, portablePath);
  if (!isContained(repoRoot, candidate)) throw new Error(`${label} escapes repo root`);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const realCandidate = realpathSync(candidate);
  if (!isContained(repoRoot, realCandidate)) throw new Error(`${label} resolves outside repo root`);
  return realCandidate;
}

function validateContentHash(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const { content_sha256: contentSha256, ...payload } = value;
  if (canonicalHash(payload) !== requireHash(contentSha256, `${label}.content_sha256`)) {
    throw new Error(`${label} content hash mismatch`);
  }
}

function validateBindings(protocol, repoRoot) {
  if (!Array.isArray(protocol.verified_bindings)) {
    throw new Error("verified_bindings must be an array");
  }
  const bindingIds = protocol.verified_bindings.map((binding) => binding.artifact_id);
  requireExactSet(bindingIds, REQUIRED_BINDING_IDS, "verified binding ids");
  const resolved = new Map();
  for (const binding of protocol.verified_bindings) {
    const artifactId = requireString(binding.artifact_id, "binding.artifact_id");
    const filePath = resolveBoundFile(repoRoot, binding.path, `${artifactId}.path`);
    const raw = readFileSync(filePath);
    if (sha256(raw) !== requireHash(binding.sha256, `${artifactId}.sha256`)) {
      throw new Error(`${artifactId} binding hash mismatch`);
    }
    if (binding.content_sha256 !== undefined) {
      const artifact = JSON.parse(raw.toString("utf8"));
      validateContentHash(artifact, artifactId);
      if (artifact.content_sha256 !== binding.content_sha256) {
        throw new Error(`${artifactId} bound content hash mismatch`);
      }
    }
    resolved.set(artifactId, { filePath, raw, value: JSON.parse(raw.toString("utf8")) });
  }
  return resolved;
}

function validateFrames(protocol, bindings) {
  const controller = bindings.get("v2_controller_frame").value;
  const reviewer = bindings.get("v2_reviewer_frame").value;
  const bundle = bindings.get("v2_frame_bundle_manifest").value;
  validateContentHash(controller, "v2_controller_frame");
  validateContentHash(reviewer, "v2_reviewer_frame");
  validateContentHash(bundle, "v2_frame_bundle_manifest");
  if (controller.artifact_type !== "outcome_blind_v2_retained_candidate_controller_frame"
    || controller.frame_contract?.direct_eligibility_adjudicator_input_allowed !== false
    || !Array.isArray(controller.candidates)
    || controller.candidates.length !== 178) {
    throw new Error("controller frame contract mismatch");
  }
  if (reviewer.artifact_type !== "outcome_blind_v2_independent_eligibility_review_frame"
    || reviewer.source_controller_frame_content_sha256 !== controller.content_sha256
    || !Array.isArray(reviewer.candidates)
    || reviewer.candidates.length !== 178) {
    throw new Error("reviewer frame contract mismatch");
  }
  const reviewContract = reviewer.review_contract;
  for (const field of [
    "original_candidate_identifiers_included",
    "prior_v1_adjudication_dispositions_included",
    "prior_inclusion_reasons_included",
    "prior_fault_family_or_root_cause_labels_included",
    "prior_duplicate_or_independence_judgments_included",
    "relation_or_template_applicability_included",
    "method_outcomes_included",
    "baseline_outcomes_included",
  ]) {
    if (reviewContract?.[field] !== false) throw new Error(`reviewer frame leaks ${field}`);
  }
  const opaqueIds = new Set();
  for (const [index, record] of reviewer.candidates.entries()) {
    const keys = Object.keys(record);
    if (keys.length !== REVIEWER_RECORD_FIELDS.size
      || keys.some((key) => !REVIEWER_RECORD_FIELDS.has(key))) {
      throw new Error(`reviewer frame record schema mismatch:${index}`);
    }
    if (!/^v2cand_[a-f0-9]{20}$/u.test(record.opaque_candidate_id)) {
      throw new Error(`reviewer frame opaque id invalid:${index}`);
    }
    if (opaqueIds.has(record.opaque_candidate_id)) {
      throw new Error(`reviewer frame opaque id duplicate:${index}`);
    }
    opaqueIds.add(record.opaque_candidate_id);
    const { record_sha256: recordSha256, ...payload } = record;
    if (canonicalHash(payload) !== recordSha256) {
      throw new Error(`reviewer frame record hash mismatch:${index}`);
    }
  }
  if (bundle.closed_inventory !== true
    || bundle.candidate_count !== 178
    || !Array.isArray(bundle.artifacts)
    || bundle.artifacts.length !== 2) {
    throw new Error("v2 frame bundle manifest contract mismatch");
  }
  requireInteger(protocol.frame_contract?.retained_candidate_count, 178, "retained candidate count");
  requireInteger(protocol.frame_contract?.retained_repository_count, 9, "retained repository count");
  requireInteger(
    protocol.frame_contract?.retained_independence_cluster_count,
    7,
    "retained independence cluster count"
  );
}

function normalizeRemoteIdentity(value, label) {
  const remote = requireString(value, label);
  let parsed;
  try {
    parsed = new URL(remote);
  } catch {
    throw new Error(`${label} must be a public HTTPS Git URL`);
  }
  if (parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new Error(`${label} must be a public HTTPS Git URL`);
  }
  const pathname = parsed.pathname.replace(/\/+$/u, "").replace(/\.git$/iu, "");
  if (pathname.split("/").filter(Boolean).length < 2) {
    throw new Error(`${label} must identify a public repository`);
  }
  return `https://${parsed.hostname.toLowerCase()}${pathname}`;
}

function validateSourceFreeze(bindings) {
  const controller = bindings.get("v2_controller_frame").value;
  const reviewer = bindings.get("v2_reviewer_frame").value;
  const freeze = bindings.get("v2_retained_source_freeze").value;
  if (freeze.schema_version !== "2.0"
    || freeze.artifact_type !== "v2_retained_source_identity_freeze"
    || freeze.status !== "frozen_before_v2_eligibility_decisions"
    || freeze.method_outcomes_observed !== false
    || freeze.baseline_outcomes_observed !== false
    || freeze.v2_eligibility_decisions_observed !== false
    || freeze.old_v1_decisions_used_for_source_selection !== false
    || !Array.isArray(freeze.sources)) {
    throw new Error("v2 retained source freeze contract mismatch");
  }
  if (freeze.bindings?.controller_frame_content_sha256 !== controller.content_sha256
    || freeze.bindings?.reviewer_frame_content_sha256 !== reviewer.content_sha256
    || freeze.bindings?.source_plan_sha256
      !== "85e08aa8fea1d717185e2e5add16b488eca66182afcb78d6b9c213f8cb980869") {
    throw new Error("v2 retained source freeze frame binding mismatch");
  }
  const candidateCounts = new Map();
  for (const record of controller.candidates) {
    const sourceId = record.candidate.source_id;
    candidateCounts.set(sourceId, (candidateCounts.get(sourceId) ?? 0) + 1);
  }
  requireExactSet(
    freeze.sources.map((source) => source.source_id),
    new Set(EXPECTED_SOURCE_CLUSTERS.keys()),
    "v2 retained source ids"
  );
  const remotes = new Set();
  const cacheKeys = new Set();
  const clusters = new Set();
  let candidateTotal = 0;
  for (const [index, source] of freeze.sources.entries()) {
    const sourceId = source.source_id;
    const expectedCluster = EXPECTED_SOURCE_CLUSTERS.get(sourceId);
    if (source.independence_cluster !== expectedCluster) {
      throw new Error(`v2 retained source cluster mismatch:${sourceId}`);
    }
    if (!/^[a-f0-9]{40}$/u.test(source.pinned_head)
      || !/^[a-f0-9]{40}$/u.test(source.pinned_tree)) {
      throw new Error(`v2 retained source pin invalid:${sourceId}`);
    }
    const remote = normalizeRemoteIdentity(source.remote_url, `sources[${index}].remote_url`);
    if (remotes.has(remote)) throw new Error(`v2 retained source remote duplicate:${sourceId}`);
    remotes.add(remote);
    const cacheKey = requireString(source.cache_key, `sources[${index}].cache_key`);
    if (cacheKeys.has(cacheKey)) throw new Error(`v2 retained source cache key duplicate:${sourceId}`);
    cacheKeys.add(cacheKey);
    const expectedCount = candidateCounts.get(sourceId);
    if (source.retained_candidate_count !== expectedCount) {
      throw new Error(`v2 retained source candidate count mismatch:${sourceId}`);
    }
    candidateTotal += source.retained_candidate_count;
    clusters.add(source.independence_cluster);
  }
  if (candidateTotal !== 178
    || freeze.selection_contract?.retained_candidate_count !== 178
    || freeze.selection_contract?.source_count !== 9
    || freeze.selection_contract?.independence_cluster_count !== 7
    || clusters.size !== 7
    || freeze.selection_contract?.repository_count_cannot_substitute_for_cluster_count !== true
    || freeze.verification?.local_paths_published !== false) {
    throw new Error("v2 retained source freeze accounting mismatch");
  }
  const serialized = JSON.stringify(freeze);
  if (/(?:\/home\/|\/Users\/|\/private\/tmp\/|[A-Za-z]:\\\\)/u.test(serialized)) {
    throw new Error("v2 retained source freeze contains a machine-local path");
  }
}

function validateResidualClaimMatrix(bindings) {
  const matrix = bindings.get("v2_residual_claim_matrix").value;
  if (matrix.schema_version !== "2.0"
    || matrix.artifact_type !== "grader_conform_v2_primary_source_residual_claim_matrix"
    || matrix.verification_policy?.primary_sources_only !== true
    || matrix.verification_policy?.search_results_count_as_verification !== false
    || matrix.verification_policy?.abstract_only_sources_can_close_subsumption_gate !== false
    || matrix.verification_policy?.method_or_result_outcomes_observed !== false
    || matrix.verification_policy?.old_v1_decisions_used !== false) {
    throw new Error("v2 residual claim matrix verification contract mismatch");
  }
  requireExactSet(
    matrix.source_ledger?.map((source) => source.source_id),
    REQUIRED_LITERATURE_SOURCE_IDS,
    "v2 residual claim source ids"
  );
  requireExactSet(
    matrix.five_axis_comparison?.map((item) => item.source_id),
    REQUIRED_LITERATURE_SOURCE_IDS,
    "v2 residual claim comparison ids"
  );
  for (const [index, source] of matrix.source_ledger.entries()) {
    const primaryUrl = requireString(source.primary_url, `source_ledger[${index}].primary_url`);
    let parsed;
    try {
      parsed = new URL(primaryUrl);
    } catch {
      throw new Error(`source_ledger[${index}].primary_url must be an HTTPS URL`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`source_ledger[${index}].primary_url must be an HTTPS URL`);
    }
    requireString(source.verification_depth, `source_ledger[${index}].verification_depth`);
    if (!Array.isArray(source.evidence_locations) || source.evidence_locations.length === 0
      || !Array.isArray(source.verified_facts) || source.verified_facts.length === 0) {
      throw new Error(`source_ledger[${index}] lacks full-text evidence locations`);
    }
  }
  for (const [index, comparison] of matrix.five_axis_comparison.entries()) {
    for (const axis of [
      "research_object",
      "core_question",
      "intervention_or_method",
      "evaluation_unit_and_evidence",
      "claim_scope",
      "overlap_verdict",
      "residual_difference",
    ]) {
      requireString(comparison[axis], `five_axis_comparison[${index}].${axis}`);
    }
  }
  const decision = matrix.subsumption_decision;
  if (decision?.verdict !== "not_subsumed_but_high_collision"
    || decision?.paper_stage !== "PAPER_REPAIR_ONCE"
    || decision?.literature_gate_status !== "pass_for_single_bounded_preflight_only"
    || decision?.required_primary_comparator
      !== "prior_work_anchored_auditor_to_executable_reproducer"
    || !Array.isArray(decision.forbidden_claims)
    || decision.forbidden_claims.length < 6
    || !Array.isArray(decision.automatic_kill_conditions)
    || decision.automatic_kill_conditions.length < 5) {
    throw new Error("v2 residual claim decision is weaker than the literature boundary");
  }
}

function validateThresholds(protocol) {
  requireInteger(protocol.claim_boundary?.search_exclusion_count, 6792, "search exclusion count");
  if (protocol.claim_boundary?.search_exclusions_reaudited !== false
    || protocol.claim_boundary?.broader_repository_or_field_prevalence_claim_allowed !== false
    || protocol.claim_boundary?.new_metamorphic_testing_principle_claim_allowed !== false) {
    throw new Error("claim boundary is weaker than the v2 retained-frame contract");
  }
  const adjudication = protocol.eligibility_adjudication;
  requireInteger(adjudication?.decisions_required, 178, "eligibility decisions required");
  requireInteger(adjudication?.isolated_reviewers_per_candidate, 2, "isolated reviewer count");
  if (adjudication?.disagreement_resolver !== "third_isolated_reviewer"
    || adjudication?.unresolved_action !== "exclude"
    || adjudication?.ambiguous_model_only_label_allowed !== false) {
    throw new Error("eligibility adjudication contract mismatch");
  }
  const sampling = protocol.fault_sampling;
  requireInteger(sampling?.selected_faults, 24, "selected fault count");
  requireMinimum(sampling?.minimum_repositories, 6, "minimum fault repositories");
  requireMinimum(sampling?.minimum_independence_clusters, 6, "minimum fault clusters");
  requireMinimum(
    sampling?.minimum_eligible_faults_per_selected_cluster,
    2,
    "minimum eligible faults per selected cluster"
  );
  requireMaximum(sampling?.maximum_faults_per_cluster, 6, "maximum faults per cluster");
  if (sampling?.duplicate_root_causes_allowed !== false
    || sampling?.replacement_after_freeze !== false
    || sampling?.selection_before_all_178_decisions !== "forbidden") {
    throw new Error("fault sampling contract mismatch");
  }
  const controls = protocol.control_sampling;
  requireInteger(controls?.total, 36, "control total");
  requireExactSet(
    controls?.classes?.map((item) => item.id),
    REQUIRED_CONTROL_CLASSES,
    "control classes"
  );
  for (const item of controls.classes) {
    requireInteger(item.count, 12, `${item.id} control count`);
    requireMinimum(item.minimum_repositories, 6, `${item.id} minimum repositories`);
    requireMinimum(item.minimum_independence_clusters, 6, `${item.id} minimum clusters`);
  }
  if (controls.selected_fault_fixed_revisions_count_as_controls !== false
    || controls.overlap_with_fault_pairs !== "forbidden"
    || controls.dual_oracle_agreement_required !== true) {
    throw new Error("control independence contract mismatch");
  }
  const arms = protocol.arm_contract;
  if (arms?.primary_arm !== "structured_contract_metamorphic") {
    throw new Error("primary arm mismatch");
  }
  requireExactSet(arms.baseline_arms, REQUIRED_BASELINE_ARMS, "baseline arms");
  if (arms.primary_comparator_arm !== "prior_work_anchored_auditor_to_executable_reproducer"
    || arms.semantic_arm_distinction_required !== true) {
    throw new Error("prior-work comparator or semantic arm distinction mismatch");
  }
  requireExactSet(
    arms.prior_work_anchored_auditor_sources,
    new Set(["park2026tvb", "tu2026benchguard", "wang2026aba"]),
    "prior-work auditor sources"
  );
  requireString(
    arms.structured_arm_required_intermediate,
    "structured arm required intermediate"
  );
  requireString(
    arms.auditor_arm_required_intermediate,
    "auditor arm required intermediate"
  );
  requireInteger(arms.authoring_replicates_per_item_arm, 3, "authoring replicates");
  requireInteger(arms.calls_per_item_arm_replicate, 3, "calls per item arm replicate");
  requireInteger(arms.maximum_output_tokens_per_call, 1536, "maximum output tokens");
  requireInteger(arms.maximum_sut_test_executions, 6, "maximum SUT test executions");
  requireInteger(arms.maximum_wall_seconds, 1200, "maximum wall seconds");
  requireInteger(arms.repair_rounds, 1, "repair rounds");
  for (const field of [
    "candidate_specific_inputs_identical",
    "parent_only_snapshot_required",
    "model_snapshot_identical",
    "runtime_and_tool_inventory_identical",
    "prompt_role_information_symmetric",
  ]) {
    if (arms[field] !== true) throw new Error(`arm symmetry contract mismatch:${field}`);
  }
  if (arms.fix_history_access_during_authoring !== "forbidden"
    || arms.network_access_during_authoring !== "forbidden"
    || arms.infrastructure_failure_treatment !== "retained_as_not_detected") {
    throw new Error("arm information boundary mismatch");
  }
  const budget = protocol.resource_budget;
  requireMaximum(budget?.structural_preflight_wall_hours, 12, "preflight wall hours");
  requireMaximum(budget?.full_study_wall_hours, 72, "full study wall hours");
  requireMaximum(budget?.maximum_gpu_hours, 48, "GPU hours");
  requireMaximum(budget?.maximum_cpu_core_hours, 192, "CPU core hours");
  requireMaximum(budget?.maximum_ram_gib, 96, "RAM GiB");
  requireMaximum(budget?.maximum_additional_storage_gib, 120, "storage GiB");
  requireMinimum(budget?.minimum_remaining_storage_gib, 80, "remaining storage GiB");
  requireMaximum(budget?.maximum_model_calls, 2160, "model calls");
  if (budget?.live_storage_recheck_required_before_execution !== true) {
    throw new Error("live storage recheck must remain required");
  }
  const analysis = protocol.analysis_plan;
  if (analysis?.primary_comparator
      !== "prior_work_anchored_auditor_to_executable_reproducer"
    || analysis?.primary_unit !== "source_selection_independence_cluster"
    || analysis?.primary_test !== "two_sided_exact_cluster_sign_flip"
    || analysis?.alpha !== 0.05
    || analysis?.other_baseline_tests !== "holm_corrected"
    || analysis?.leave_one_cluster_out_required !== true) {
    throw new Error("analysis contract mismatch");
  }
  if (protocol.independent_replay?.implementation_count !== 2
    || protocol.independent_replay?.required_verdict_agreement !== 1
    || protocol.independent_replay?.unresolved_nondeterminism_allowed !== false) {
    throw new Error("independent replay contract mismatch");
  }
}

function validateGateState(protocol) {
  const gates = protocol.preflight_gates;
  requireExactSet(gates?.map((gate) => gate.id), REQUIRED_GATE_IDS, "preflight gates");
  if (gates.some((gate) => gate.status !== "pass" && gate.status !== "blocked")) {
    throw new Error("preflight gate status invalid");
  }
  const bindingIds = new Set(protocol.verified_bindings.map((binding) => binding.artifact_id));
  for (const gate of gates.filter((item) => item.status === "pass")) {
    if (!bindingIds.has(gate.evidence_artifact_id)) {
      throw new Error(`passing gate lacks verified evidence binding:${gate.id}`);
    }
  }
  const allPass = gates.every((gate) => gate.status === "pass");
  if (protocol.all_preflight_gates_pass !== allPass) {
    throw new Error("all_preflight_gates_pass does not match gate states");
  }
  if (!allPass && protocol.execution_authorized !== false) {
    throw new Error("execution cannot be authorized while a preflight gate is blocked");
  }
  if (protocol.status === "preflight_open_not_frozen" && protocol.execution_authorized !== false) {
    throw new Error("open preflight cannot authorize execution");
  }
  if (protocol.execution_authorized === true) {
    if (protocol.status !== "frozen_before_arm_execution" || !allPass) {
      throw new Error("execution authorization requires a fully frozen passing preflight");
    }
    const timestampGate = gates.find((gate) => gate.id === "external_pre_outcome_timestamp");
    if (timestampGate?.status !== "pass") {
      throw new Error("execution authorization requires external timestamp evidence");
    }
  }
  return allPass;
}

function validateProtocol(protocol, repoRoot, protocolPath) {
  if (protocol.schema_version !== "2.0"
    || protocol.artifact_type !== "grader_conform_v2_structural_preflight_contract"
    || !["preflight_open_not_frozen", "frozen_before_arm_execution"].includes(protocol.status)
    || protocol.paper_scale_claim_authorized !== false
    || protocol.v1_status !== "killed_preserved_as_audit_trail") {
    throw new Error("v2 preflight protocol schema or status mismatch");
  }
  const bindings = validateBindings(protocol, repoRoot);
  validateFrames(protocol, bindings);
  validateSourceFreeze(bindings);
  validateResidualClaimMatrix(bindings);
  validateThresholds(protocol);
  const allPass = validateGateState(protocol);
  return {
    valid: true,
    status: protocol.status,
    execution_authorized: protocol.execution_authorized,
    all_preflight_gates_pass: allPass,
    passing_gate_count: protocol.preflight_gates.filter((gate) => gate.status === "pass").length,
    blocked_gate_count: protocol.preflight_gates.filter((gate) => gate.status === "blocked").length,
    bound_artifact_count: bindings.size,
    protocol_bytes: statSync(realpathSync(protocolPath)).size,
  };
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
  const repoRoot = realpathSync(args["repo-root"]);
  const protocol = readJson(args.protocol).value;
  process.stdout.write(
    `${JSON.stringify(validateProtocol(protocol, repoRoot, args.protocol), null, 2)}\n`
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
